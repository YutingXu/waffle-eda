// Schematic Find Similar Objects (app/schematic/sch-similar.js): parts, pins, wires, net labels, ports and
// power ports, matched on library reference, comment, value, footprint, net and sheet; plus the
// headless find_similar command on a schematic. Uses the shipped sample and the real Altium
// fixture (tests/fixtures/altium/pidp11-io-expander, BSD-2-Clause; see its NOTICE).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "sch-import", "pcb-pours", "pcb-import", "altium-rules", "source-file", "io",
  "pcb-appearance", "rules", "pcb-edit", "automation/legacy-command-contract", "commands-headless", "sch-similar"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, S = AtriumSchSimilar;
const defsOf = p => new Map(p.library.map(d => [d.id, d]));
const crit = (o = {}) => ({sheet: "same", ...o});

// ---------------------------------------------------------------- sample project
{
  const p = AtriumParts.example(), defs = defsOf(p), sch = p.documents.find(d => d.kind === "schematic");
  const parts = sch.items.filter(i => i.kind === "part");
  const r = parts.find(i => /^R\d/.test(i.ref)) || parts[0];
  const props = S.props(p, sch, defs, r);
  assert.deepEqual(props.map(x => x.key).filter(k => ["kind", "libRef", "value", "footprint", "prefix", "sheet"].includes(k)), ["kind", "libRef", "value", "footprint", "prefix", "sheet"]);
  // Same library reference: every part placed from the same definition.
  const same = S.find(p, sch, defs, r, crit({libRef: "same"})).map(h => h.id).sort();
  assert.deepEqual(same, parts.filter(i => i.def === r.def).map(i => i.id).sort());
  // Different comment narrows it; "any" everything ignores the property.
  const diff = S.find(p, sch, defs, r, crit({libRef: "same", value: "different"}));
  assert.ok(diff.every(h => sch.items.find(i => i.id === h.id).value !== r.value));
  assert.equal(S.find(p, sch, defs, r, crit()).length, parts.length);
  // Kind always matches: a part never matches a wire.
  const wire = sch.items.find(i => i.kind === "wire");
  if (wire) {
    const net = S.props(p, sch, defs, wire).find(x => x.key === "net").value;
    const hits = S.find(p, sch, defs, wire, crit({net: "same"}));
    assert.ok(hits.length >= 1 && hits.every(h => sch.items.find(i => i.id === h.id).kind === "wire"));
    const cn = A.connectivity(sch, defs);
    assert.deepEqual(hits.map(h => h.id).sort(), sch.items.filter(i => i.kind === "wire" && cn.byWire.get(i.id) === net).map(i => i.id).sort());
  }
  // Sheet "different" on a one-sheet project finds nothing; "any" equals "same" there.
  assert.equal(S.find(p, sch, defs, r, {sheet: "different"}).length, 0);
  assert.equal(S.find(p, sch, defs, r, {sheet: "any"}).length, parts.length);
  // Selection scope.
  assert.deepEqual(S.find(p, sch, defs, r, crit(), {within: [r.id]}).map(h => h.id), [r.id]);
  // Headless command on a schematic.
  const out = AtriumCommandsHeadless.run(p, "find_similar", {document_id: sch.id, id: r.id, criteria: {libRef: "same"}});
  assert.deepEqual(out.ids.slice().sort(), same); assert.equal(out.total, same.length);
  assert.throws(() => AtriumCommandsHeadless.run(p, "find_similar", {document_id: sch.id, id: r.id, criteria: {width: "same"}}), /no property width/);
}

// ---------------------------------------------------------------- real Altium schematic
{
  const DIR = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
  const r1 = AtriumIO.read("PiDP11IOExpander.SchDoc", new Uint8Array(fs.readFileSync(path.join(DIR, "PiDP11IOExpander.SchDoc"))));
  const p = A.project("PiDP"); p.documents = r1.documents; p.library = r1.library; A.validate(p);
  const defs = defsOf(p), sch = p.documents[0], cn = A.connectivity(sch, defs);
  const parts = sch.items.filter(i => i.kind === "part");
  // Footprint: every part with the reference part's footprint.
  const ref = parts.find(i => /^R/.test(i.ref)) || parts[0], fp = defs.get(ref.def)?.footprint?.name || "";
  const byFp = S.find(p, sch, defs, ref, crit({footprint: "same"})).map(h => h.id).sort();
  assert.deepEqual(byFp, parts.filter(i => (defs.get(i.def)?.footprint?.name || "") === fp).map(i => i.id).sort());
  assert.ok(byFp.length >= 2, "more than one part shares the resistor footprint (" + fp + ")");
  // Net labels with the same net: same text.
  const label = sch.items.find(i => i.kind === "netlabel");
  const labels = S.find(p, sch, defs, label, crit({net: "same"})).map(h => h.id).sort();
  assert.deepEqual(labels, sch.items.filter(i => i.kind === "netlabel" && i.text === label.text).map(i => i.id).sort());
  // Pins: every pin on the same net as a pin of the reference part; the hits own those pins.
  const pin = A.pins(ref, defs.get(ref.def), "schematic")[0], net = cn.byPin.get(ref.id + "/" + pin.number);
  const pinProps = S.props(p, sch, defs, ref, {pin: pin.number});
  assert.deepEqual(pinProps.map(x => x.key), ["kind", "pinName", "pinNumber", "pinType", "net", "libRef", "sheet"]);
  const pins = S.find(p, sch, defs, ref, crit({net: "same"}), {pin: pin.number});
  const expect = [];
  for (const i of parts) for (const q of A.pins(i, defs.get(i.def), "schematic")) if ((cn.byPin.get(i.id + "/" + q.number) || "") === (net || "")) expect.push(i.id + "/" + q.number);
  assert.deepEqual(pins.map(h => h.id + "/" + h.pin).sort(), expect.sort());
  assert.ok(pins.length >= 2);
  assert.throws(() => S.props(p, sch, defs, ref, {pin: "999"}), /no pin 999/);
}

// ---------------------------------------------------------------- multi-sheet scope
{
  const p = A.project("Two sheets"), defs = new Map();
  const s1 = A.sheet("schematic", "Sheet1"), s2 = A.sheet("schematic", "Sheet2");
  s1.items.push({id: "a", kind: "netlabel", x: 0, y: 0, text: "VIN"}, {id: "b", kind: "power", x: 5, y: 0, text: "GND", style: "gnd", direction: 3});
  s2.items.push({id: "c", kind: "netlabel", x: 0, y: 0, text: "VIN"}, {id: "d", kind: "netlabel", x: 0, y: 5, text: "OUT"}, {id: "e", kind: "power", x: 5, y: 0, text: "GND", style: "bar", direction: 1});
  p.documents = [s1, s2];
  const a = s1.items[0], b = s1.items[1];
  assert.deepEqual(S.find(p, s1, defs, a, {sheet: "same", net: "same"}).map(h => h.id), ["a"]);
  assert.deepEqual(S.find(p, s1, defs, a, {sheet: "any", net: "same"}).map(h => h.doc + ":" + h.id), [s1.id + ":a", s2.id + ":c"]);
  assert.deepEqual(S.find(p, s1, defs, a, {sheet: "different"}).map(h => h.id), ["c", "d"]);
  // Power ports: net (name) and style.
  assert.deepEqual(S.find(p, s1, defs, b, {sheet: "any", net: "same", style: "same"}).map(h => h.id), ["b"]);
  assert.deepEqual(S.find(p, s1, defs, b, {sheet: "any", net: "same", style: "different"}).map(h => h.id), ["e"]);
}
console.log("PASS schematic Find Similar: parts, pins, wires, net labels, power ports; library reference, footprint, net and sheet scope");
