"use strict";
// Altium schematic intent and curves: parameter sets (directives) become signal directive fields,
// and KiCad net class directive labels do too. Synthetic ASCII SchDoc records only.
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "parts", "sch-objects", "hierarchy", "net-intent", "signals", "board-shape", "board-shape-sources", "stackup", "sexpr", "import-kicad", "import-link", "sch-import", "io"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const {nativeRoundTrip} = require("../support/native-cad.cjs");
const A = Atrium, S = AtriumSignals;

function ascii(build) {
  const lines = [];
  const r = o => { lines.push("|" + Object.entries(o).map(([k, v]) => k + "=" + v).join("|")); return lines.length - 1; };
  r({RECORD:31, FONTIDCOUNT:1, SIZE1:10, FONTNAME1:"Arial", SHEETSTYLE:0});
  build(r);
  return lines.join("\r\n");
}
// A fidelity sink that keeps every decision by source record.
function sink() {
  const rows = [];
  const add = (kind, status, source, reason) => rows.push({kind, status, object: source.object, reason});
  return {rows, add, track: (kind, status, source, object, reason) => add(kind, status, source, reason), produced() {}, note() {}};
}
const row = (f, index) => f.rows.find(x => x.object === "ASCII record#" + index);
function sheetProject(res) {
  const p = A.project("Intent");
  p.documents = [...res.documents, A.sheet("pcb", "Board")];
  p.library = res.library;
  A.validate(p);
  return p;
}

// A. Parameter sets: the wire (or net label) under a directive's location carries its intent.
{
  const at = {};
  const text = ascii(r => {
    const wire = (y, name) => { r({RECORD:27, LOCATIONCOUNT:2, X1:100, Y1:y, X2:200, Y2:y}); r({RECORD:25, TEXT:name, "LOCATION.X":100, "LOCATION.Y":y}); };
    wire(500, "CAN_P"); wire(480, "CAN_N"); wire(460, "VDD_3V3"); wire(440, "RS485_A"); wire(420, "RS485_B"); wire(400, "DATA");
    const set = (key, x, y, params) => { const owner = at[key] = r({RECORD:43, OWNERPARTID:-1, "LOCATION.X":x, "LOCATION.Y":y, NAME:key});
      at[key + ".params"] = Object.entries(params).map(([name, value]) => r({RECORD:41, OWNERINDEX:owner, OWNERPARTID:-1, "LOCATION.X":x, "LOCATION.Y":y - 10, ISHIDDEN:"T", NAME:name, TEXT:value})); };
    set("pos", 150, 500, {DifferentialPair:"True", DifferentialPairClassName:"CAN_PAIRS", ClassName:"HS"});
    set("neg", 120, 480, {DifferentialPair:"True"});
    set("rail", 200, 460, {ClassName:"PowerNets", Rule:"Rule Kind=Width|Min=10mil"});
    set("a", 150, 440, {DifferentialPair:"True"});
    set("b", 150, 420, {DifferentialPair:"True"});
    set("plain", 150, 400, {DifferentialPair:"True", DifferentialPairClassName:"X"});
    set("label", 100, 400, {ClassName:"Labelled"});
    set("float", 150, 600, {ClassName:"Nowhere"});
    r({RECORD:26, LOCATIONCOUNT:2, X1:100, Y1:300, X2:200, Y2:300});
    set("bus", 150, 300, {ClassName:"Bus"});
  });
  const f = sink(), res = AtriumSCH.read("Intent.SchDoc", null, text, {fidelity:f});
  const doc = res.documents[0], wires = doc.items.filter(i => i.kind === "wire");
  const on = name => wires.find(w => A.connectivity(doc, new Map(res.library.map(d => [d.id, d]))).byWire.get(w.id) === name);
  assert.ok(!res.notes.some(n => /parameter set/i.test(n)), res.notes.join(" | "));
  assert.deepEqual([on("CAN_P").signal, on("CAN_P").polarity, on("CAN_P").tags, on("CAN_P").netClass], ["CAN", 1, ["CAN_PAIRS"], "HS"]);
  assert.deepEqual([on("CAN_N").signal, on("CAN_N").polarity, on("CAN_N").tags, on("CAN_N").netClass], ["CAN", -1, undefined, undefined]);
  assert.equal(on("VDD_3V3").netClass, "PowerNets", "a net class stays a net tag (netClass), never a signal tag");
  assert.equal(on("VDD_3V3").tags, undefined);
  // A/B legs name no polarity: the pair is declared and Waffle reports the assumption.
  assert.deepEqual([on("RS485_A").diffPair, on("RS485_A").polarity, on("RS485_B").diffPair], ["RS485", undefined, "RS485"]);
  assert.equal(on("DATA").signal, undefined, "a pair leg needs a P/N suffix to name its pair");
  assert.equal(doc.items.find(i => i.kind === "netlabel" && i.text === "DATA").netClass, undefined, "the wire takes precedence over a label at its end");
  assert.equal(on("DATA").netClass, "Labelled");
  // Fidelity: each set and parameter is reported as translated, approximated or dropped, with a reason.
  assert.equal(row(f, at.pos).status, "kept");
  assert.ok(at["pos.params"].every(i => row(f, i).status === "kept"));
  assert.equal(row(f, at.rail).status, "approximated");
  assert.match(row(f, at["rail.params"][1]).reason, /Rule is not translated/);
  assert.equal(row(f, at.a).status, "approximated");
  assert.equal(row(f, at["a.params"][0]).status, "approximated");
  assert.match(row(f, at["a.params"][0]).reason, /Polarity of RS485_A/);
  assert.equal(row(f, at.plain).status, "dropped");
  assert.match(row(f, at["plain.params"][0]).reason, /no _P\/_N or \+\/- suffix/);
  assert.equal(row(f, at.float).status, "dropped");
  assert.match(row(f, at.float).reason, /No wire, net label or pin/);
  assert.match(row(f, at.bus).reason, /buses/);
  assert.ok(!f.rows.some(x => x.kind === "Parameter" && /Sheet parameter/.test(x.reason || "")), "directive parameters are not sheet parameters");

  // The signals model reads the directives: a CAN pair tagged CAN_PAIRS, and net tags.
  const p = sheetProject(res), board = p.documents.find(d => d.kind === "pcb");
  const recs = S.directives(p).records;
  assert.equal(recs.length, 6, "one record per directive-carrying wire");
  const M = S.model(p, board);
  const can = M.signals.find(s => s.name === "CAN");
  assert.equal(can.kind, "diff");
  assert.deepEqual(can.legs.map(l => [l.polarity, l.seeds]), [[1, ["CAN_P"]], [-1, ["CAN_N"]]]);
  assert.deepEqual(can.tags, ["CAN_PAIRS"]);
  assert.equal(M.signals.find(s => s.name === "RS485").kind, "diff");
  assert.ok(M.issues.some(i => i.kind === "polarity" && i.signal === "RS485"), "an A/B pair reports its assumed polarity");
  const classes = M.netClasses();
  assert.deepEqual([classes.HS, classes.Labelled, classes.PowerNets], [["CAN_P"], ["DATA"], ["VDD_3V3"]], "net classes are exact net tags");
  assert.deepEqual([...M.netsOfTag("CAN_PAIRS")].sort(), ["CAN_N", "CAN_P"], "the pair class tags the pair signal");
  assert.deepEqual(M.diffPairClasses(), {CAN_PAIRS:["CAN"]});
  // The fields are ordinary directive fields: they save, reopen and validate.
  const back = A.validate(nativeRoundTrip(p));
  assert.equal(back.documents[0].items.find(i => i.kind === "wire" && i.signal === "CAN" && i.polarity === 1).netClass, "HS");
}

// KiCad: a net class directive label puts its Netclass on the wire it touches.
{
  const sch = `(kicad_sch (version 20231120) (generator eeschema) (uuid "11111111-1111-1111-1111-111111111111") (paper "A4")
  (lib_symbols)
  (wire (pts (xy 10 10) (xy 30 10)) (uuid "22222222-2222-2222-2222-222222222222"))
  (label "CLK" (at 10 10 0) (uuid "33333333-3333-3333-3333-333333333333"))
  (netclass_flag "" (length 2.54) (shape round) (at 20 10 0) (uuid "44444444-4444-4444-4444-444444444444")
    (property "Netclass" "Fast" (at 20 7 0)) (property "Owner" "x" (at 20 6 0)))
  (directive_label "" (length 2.54) (shape round) (at 50 50 0) (uuid "55555555-5555-5555-5555-555555555555")
    (property "Netclass" "Lost" (at 50 47 0))))`;
  const f = sink(), [res] = AtriumImportFormats.readSet([{name:"Clock.kicad_sch", bytes:new TextEncoder().encode(sch)}], {fidelity:f});
  const doc = res.documents[0], wire = doc.items.find(i => i.kind === "wire");
  assert.equal(wire.netClass, "Fast");
  assert.ok(!doc.notes.some(n => n === "Net class directives omitted"), doc.notes.join(" | "));
  assert.ok(doc.notes.some(n => /Net class directive labels omitted: No wire or label/.test(n)));
  const dirs = f.rows.filter(x => x.kind === "directive");
  assert.deepEqual(dirs.map(x => x.status), ["approximated", "dropped"]);
  assert.match(dirs[0].reason, /Owner are not translated/);
  const p = sheetProject(res);
  assert.deepEqual(S.model(p, p.documents.find(d => d.kind === "pcb")).netClasses(), {Fast:["CLK"]});
}
console.log("altium-sch-intent: ok");
