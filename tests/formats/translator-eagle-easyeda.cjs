"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const mod of ["model", "board-shape","board-shape-sources", "sexpr", "import-eagle", "import-easyeda"]) require(require("../support/app-source-paths.cjs").appFile(mod + ".js"));
const source = name => new Uint8Array(fs.readFileSync(path.join(__dirname, "../fixtures/import", name)));
const encode = text => new TextEncoder().encode(text), decode = bytes => new TextDecoder().decode(bytes);
const io = AtriumImportFormats;
function run(name, bytes, reader) {
  const records = [], outputs = [];
  const sink = {
    add(kind, status, ref, reason) { records.push({kind, status, ref, reason}); },
    track(kind, status, ref, target, reason) { records.push({kind, status, ref, target, reason}); },
    produced(kind, ref, target) { outputs.push({kind, ref, target}); }
  };
  function read(fidelity) {
    io.resetBudget();
    return Atrium.withRevisionIds("a".repeat(64), () => reader.read(name, bytes, {utf8: io.utf8, unzip: io.unzip, fidelity}));
  }
  const plain = read(), actual = read(sink);
  assert.deepEqual(actual, plain, name + " produced the same editable model with and without the report");
  const emitted = new Set(outputs.map(o => o.target));
  assert.equal(emitted.size, outputs.length, name + " produced each object once");
  for (const doc of actual.documents) for (const item of doc.items) assert.ok(emitted.delete(item), name + " must map " + item.kind);
  assert.equal(emitted.size, 0);
  assert.equal(new Set(records.map(r => r.ref.object)).size, records.length, name + " counted a source location twice");
  for (const r of [...records, ...outputs]) { assert.equal(r.ref.file, name); assert.ok(r.ref.object); }
  for (const r of records) { assert.ok(["kept", "approximated", "dropped"].includes(r.status)); if (r.status !== "kept") assert.ok(r.reason); }
  return {records, outputs, actual};
}
const E = AtriumEagleImport, Q = AtriumEasyEDAImport;
for (const name of ["demo-eagle.brd", "demo-eagle.sch", "demo-easyeda-pcb.json", "demo-easyeda-sch.json", "demo-easyeda.epro"]) {
  const {records, outputs} = run(name, source(name), name.startsWith("demo-eagle") ? E : Q);
  assert.ok(records.length && outputs.length);
  const total = status => records.filter(r => r.status === status).length;
  console.log(name, total("kept") + " kept, " + total("approximated") + " approximated, " + total("dropped") + " dropped; " + outputs.length + " editable objects");
}
{
  // Curved copper, an unrouted airwire, an unreferenced library pad and an
  // unfamiliar drawing element all have independent locations in the original XML.
  const xml = '<eagle><drawing><board><plain><futureGraphic/></plain><libraries><library name="parts"><packages><package name="unused"><pad name="1" drill="0.4"/></package></packages></library></libraries><signals><signal name="N"><wire x1="0" y1="0" x2="5" y2="0" width="0.2" layer="1"/><wire x1="5" y1="0" x2="8" y2="2" width="0.2" layer="1" curve="90"/><wire layer="19"/></signal></signals></board></drawing></eagle>';
  const {records, outputs} = run("Arc.brd", encode(xml), E);
  const wires = records.filter(r => r.kind === "wire");
  assert.deepEqual(wires.map(r => r.status), ["kept", "approximated", "dropped"]);
  assert.ok(records.some(r => r.kind === "Other Eagle element" && r.status === "dropped" && r.reason.includes("futureGraphic")));
  assert.ok(records.some(r => r.kind === "pad" && r.status === "dropped"));
  for (const r of records) assert.ok(xml.slice(Number(r.ref.object.split(" ").at(-1))).startsWith(r.ref.object.split("> ")[0]));
  assert.deepEqual(outputs.map(r => r.ref.object), wires.slice(0, 2).map(r => r.ref.object));
}
{
  const sheet = JSON.parse(decode(source("demo-easyeda-sch.json")));
  sheet.shape[0] += "#@$UNUSED_SYMBOL_FIELD~value";
  sheet.shape.push("FUTURE_SHAPE~1~2");
  const {records} = run("Design.json", encode(JSON.stringify({schematics: [{title: "Sheet", dataStr: JSON.stringify(sheet)}]})), Q);
  const row = kind => records.find(r => r.kind === kind || r.reason?.includes(kind));
  assert.equal(row("FUTURE_SHAPE").status, "dropped"); assert.match(row("FUTURE_SHAPE").ref.object, /^\$\.schematics\[0\]\.dataStr\.shape\[/);
  assert.equal(row("UNUSED_SYMBOL_FIELD").status, "dropped"); assert.match(row("UNUSED_SYMBOL_FIELD").ref.object, /#@\$\d+$/);
  assert.ok(records.some(r => r.kind === "P" && r.status === "kept"));
}
{
  const pro = '\n["DOCTYPE","PCB"]\n["ARC","a",null,"N",1,0,0,10,10,45,3]\n["FUTURE","f"]\n["COMPONENT","c",0,1,10,10,0,{}]\n';
  const {records} = run("line.epcb", encode(pro), Q);
  assert.deepEqual(records.map(r => [r.ref.object, r.status]).sort(), [["line 3", "approximated"], ["line 4", "dropped"], ["line 5", "approximated"]]);
  const zipped = run("Demo.epro", source("demo-easyeda.epro"), Q);
  assert.ok(zipped.records.some(r => r.ref.object === "README.txt" && r.status === "dropped"));
  assert.ok(zipped.records.some(r => r.ref.object.startsWith("SYMBOL/sym1.esym#line ") && r.kind === "PIN" && r.status === "approximated"));
  assert.ok(zipped.records.some(r => r.ref.object.startsWith("FOOTPRINT/fp1.efoo#line ") && r.kind === "PAD" && r.status === "kept"));
  for (const o of zipped.outputs) assert.match(o.ref.object, /^(?:PCB|SHEET)\/.+#line \d+$/);
}

{
  const xml = '<eagle><drawing><board><libraries><library name="lib"><packages><package name="P"><smd name="bad" x="0" y="0" dx="0" dy="1" layer="1"/></package></packages></library></libraries><elements><element name="R1" library="lib" package="P" x="0" y="0"/></elements></board></drawing></eagle>';
  const {records, actual} = run("Incomplete.brd", encode(xml), E);
  const pad = records.find(r => r.kind === "smd").target;
  assert.strictEqual(actual.library[0].footprint.pads[0], pad);
  io.scrub(actual);
  assert.equal(actual.library[0].footprint.pads.length, 0);
}
