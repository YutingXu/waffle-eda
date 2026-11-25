"use strict";
// Generic parts (app/library/generic-parts.js) and parametric connectors (app/library/connector-gen.js):
// 1. engineering-notation values and E-series hints;
// 2. footprint and IPC goldens for representative packages (tests/goldens/generic-parts.json);
// 3. deterministic definitions, shared per package, and identical Gerber / BOM / pick-and-place
//    output after regenerating;
// 4. BOM grouping of identical generics;
// 5. connector regeneration keeps connections by pin number and refuses to drop connected pins;
// 6. dynamic connectors: pins from wire ends, parts across sheets, finalise;
// 7. binding to a manufacturer part only from library data;
// 8. round trip through save/load (and a 1.2 reader keeping the fields), KiCad and Altium export + import;
// 9. the MCP entry point (headless).
// Fixtures: synthetic, built here. Golden refresh: GENERIC_GOLDEN=emit prints the file to stdout.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "board-shape-sources", "stackup", "query", "viastack", "rooms", "component-classes", "pcb-pours", "polygon-pour",
  "rules", "pcb-text-rich", "pcb-text", "pcb-draw", "pcb-appearance", "zip", "import-link", "source-file", "sch-import", "altium-rules", "pcb-import", "io",
  "library-panel", "footprint-wizard", "footprint-packages", "dynamic-symbol", "bom", "fab-outputs", "kicad-export", "kicad-schematic", "sexpr", "import-kicad", "altium-export",
  "generic-parts", "connector-gen"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, GP = AtriumGenericParts, CG = AtriumConnectorGen, DS = AtriumDynamicSymbol, B = AtriumBOM, F = AtriumFabOutputs;
{
  const d = GP.make({family: "connector", type: "jst", rows: 2, cols: 3, pitch: 2, orientation: "right-angle", mount: "smd"});
  const pads = d.footprint.pads.filter(p => p.number);
  const centres = pads.map(p => p.x + "," + p.y + "," + (p.layer || "Top"));
  assert.equal(pads.length, 6);
  assert.equal(new Set(centres).size, pads.length);
  assert.equal(AtriumLibrary.checkFootprint(d.footprint).filter(i => i.level === "error").length, 0);
  for (const pad of pads) assert.ok(pad.y-pad.h/2>=d.footprint.courtyard[1],"courtyard covers both rows");
}

const defsOf = p => new Map(p.library.map(d => [d.id, d]));

// ------------------------------------------------------------ 1. values and E-series
{
  const v = (t, f = "resistor") => GP.parseValue(t, f)?.value;
  for (const [t, want] of [["4k7", 4700], ["4.7k", 4700], ["4.7 kΩ", 4700], ["4,7k", 4700], ["10K", 1e4], ["1M", 1e6], ["1meg", 1e6], ["4R7", 4.7], ["R10", .1], ["0R", 0],
    ["100R", 100], ["2m", .002], ["470", 470], ["1.5e3", 1500], ["10 ohm", 10]]) assert.equal(v(t), want, t);
  for (const [t, want] of [["100n", 1e-7], ["100nF", 1e-7], ["2u2", 2.2e-6], ["2.2µF", 2.2e-6], ["4p7", 4.7e-12], ["10uF", 1e-5], ["1F", 1]]) assert.equal(v(t, "capacitor"), want, t);
  assert.equal(v("2u2", "inductor"), 2.2e-6); assert.equal(v("10µH", "inductor"), 1e-5);
  assert.equal(v("16MHz", "crystal"), 16e6); assert.equal(v("32.768 kHz", "crystal"), 32768);
  assert.equal(v("500mA", "fuse"), .5); assert.equal(v("600 Ω @ 100 MHz", "ferrite"), 600);
  for (const bad of ["", "abc", "4k7k", "--1", "1x", "4R7", "1..2"]) assert.equal(v(bad, "capacitor"), undefined, bad);
  assert.equal(GP.parseValue("4.7 kΩ", "resistor").text, "4.7 kΩ"); assert.equal(GP.parseValue("4k7").rkm, "4k7");
  assert.equal(GP.parseValue("100n", "capacitor").text, "100 nF"); assert.equal(GP.parseValue("2u2", "capacitor").rkm, "2u2");
  assert.equal(GP.parseValue("R047").rkm, "R047"); assert.equal(GP.parseValue("0R").text, "0 Ω");
  assert.equal(GP.series("E6").length, 6); assert.equal(GP.series("E12").length, 12); assert.equal(GP.series("E24").length, 24);
  assert.equal(GP.series("E48").length, 48); assert.equal(GP.series("E96").length, 96);
  assert.equal(GP.seriesFor("1%"), "E96"); assert.equal(GP.seriesFor("5%"), "E24"); assert.equal(GP.seriesFor("10%"), "E12"); assert.equal(GP.seriesFor("20%"), "E6"); assert.equal(GP.seriesFor("2%"), "E48");
  let n = GP.nearest(4800, "E24");
  assert.deepEqual([n.lower, n.upper, n.nearest, n.exact], [4700, 5100, 4700, false]);
  assert.ok(GP.nearest(4700, "E12").exact && GP.nearest(4990, "E96").exact && !GP.nearest(4700, "E96").exact);
  n = GP.nearest(4700, "E96"); assert.deepEqual([n.lower, n.upper], [4640, 4750]);
  assert.deepEqual([GP.nearest(9.5, "E6").lower, GP.nearest(9.5, "E6").upper], [6.8, 10], "the next decade is a neighbour");
  const h = GP.hint("4.8k", "resistor", {tolerance: "5%"});
  assert.ok(h.ok && h.offSeries && h.series === "E24" && /nearest 4\.7 kΩ/.test(h.message));
  assert.deepEqual(h.snap.map(s => s.text), ["4.7 kΩ", "5.1 kΩ"]);
  assert.ok(!GP.hint("4k7", "resistor", {tolerance: "5%"}).offSeries);
  assert.ok(GP.hint("4k75", "resistor", {tolerance: "1%"}).message.includes("in E96"));
  assert.equal(GP.hint("nope", "capacitor").ok, false);
  assert.equal(GP.hint("33n", "capacitor", {series: "none"}).offSeries, undefined);
}

// ------------------------------------------------------------ 2. every package builds; goldens
const REPRESENTATIVE = [["resistor", "0402"], ["resistor", "0603"], ["resistor", "2512"], ["resistor", "Axial DIN0207"], ["resistor", "MiniMELF"],
  ["capacitor", "0805"], ["capacitor", "Disc D5.0 P5.00"], ["polarised", "Tantalum 3528-21 (B)"], ["electrolytic", "Radial D6.3 P2.5"], ["electrolytic", "SMD can 6.3×5.4"],
  ["inductor", "1210"], ["ferrite", "0603"], ["diode", "SOD-123"], ["diode", "SMA"], ["diode", "DO-41"], ["led", "0603"], ["led", "LED 5 mm"],
  ["crystal", "Crystal 3225"], ["crystal", "HC-49/U"], ["fuse", "1206"], ["testpoint", "Pad D1.5"], ["testpoint", "THT loop"], ["jumper", "Solder jumper 2-bridged"], ["jumper", "Solder jumper 3-open"]];
const CONNECTORS = [{type: "header", rows: 1, cols: 6}, {type: "header", rows: 2, cols: 5}, {type: "socket", rows: 2, cols: 8, numbering: "row-by-row"}, {type: "header", rows: 2, cols: 10, pitch: 1.27, mount: "smd"},
  {type: "box", cols: 5}, {type: "jst", cols: 4, pitch: 2}, {type: "jst", cols: 4, pitch: 1, mount: "smd", orientation: "right-angle", pegs: true}, {type: "terminal", cols: 3, pitch: 5.08},
  {type: "header", rows: 1, cols: 8, orientation: "right-angle"}, {type: "cardedge", rows: 2, cols: 10}, {type: "header", rows: 2, cols: 4, numbering: "ccw"}, {type: "header", rows: 2, cols: 4, numbering: "zigzag"}];
const fpSummary = fp => JSON.parse(JSON.stringify({name: fp.name, height: fp.height ?? null, courtyard: fp.courtyard, pads: fp.pads.map(p => [p.number, p.x, p.y, p.w, p.h, p.drill || 0, p.shape, p.layer || ""]),
  ipc: fp.ipc ? {name: fp.ipc.name, family: fp.ipc.family, Z: fp.ipc.Z, G: fp.ipc.G, X: fp.ipc.X} : null, body: !!fp.shapes.find(s => s.layer === "Mechanical 13" && (s.closed || s.kind === "circle"))}));
{
  const L = AtriumLibrary;
  for (const fam of GP.ORDER) for (const pkg of GP.FAMILIES[fam].packages) {
    const d = GP.make({family: fam, package: pkg});
    assert.ok(L.validateDef(d, {footprintWarnings: false}).ok, fam + " " + pkg);
    assert.ok(d.footprint.courtyard && d.footprint.shapes.some(s => s.style === "courtyard"), "courtyard " + fam + " " + pkg);
    if (GP.PACKAGES[pkg].group !== "SMD chip") assert.ok(d.footprint.shapes.some(s => s.style === "silk"), "silk " + pkg);
    for (const s of d.footprint.shapes) if (s.style === "silk" && !s.fill) assert.ok(s.width >= GP.SILK_W, "silk width " + fam + " " + pkg);
    const issues = L.checkFootprint(d.footprint).filter(i => i.level === "error");
    assert.deepEqual(issues, [], fam + " " + pkg + " has no footprint errors");
    assert.ok(new Set(d.symbol.pins.map(p => p.number)).size === new Set(d.footprint.pads.filter(p => p.number).map(p => p.number)).size, "pins match pads " + pkg);
  }
  for (const c of CONNECTORS) {
    const d = GP.make({family: "connector", ...c}), fp = d.footprint;
    assert.equal(L.checkFootprint(fp).filter(i => i.level === "error").length, 0, "connector " + JSON.stringify(c));
    if (c.type !== "cardedge") assert.ok(fp.shapes.some(s => s.style === "silk" && s.closed && s.points.length === 3), "pin-1 marker " + fp.name);
    for (const s of fp.shapes) if (s.style === "silk" && !s.fill) assert.ok(s.width >= GP.SILK_W, "silk width " + fp.name);
    assert.equal(d.symbol.pins.length, c.rows === undefined ? (c.type === "box" ? 2 : 1) * c.cols : c.rows * c.cols);
  }
  // Generated silk clears every built-in fab preset's minimum line (DFM "Small silkscreen").
  require("../../app/formats/fab-presets.js"); require("../../app/fab-presets/jlcpcb.js"); require("../../app/formats/fab-profiles.js");
  for (const f of AtriumFabProfiles.list().filter(f => f.builtin)) assert.ok(GP.SILK_W >= (f.silkWidth || 0), "silk width vs " + f.id);
  // silkWidth: raised from 0.12 to 0.18 mm on 2026-11-19 so new boards pass DFM on JLCPCB (0.153) and
  // Eurocircuits class 6 (0.17); the pad, courtyard and IPC goldens did not change.
  const golden = {silkWidth: GP.SILK_W, packages: REPRESENTATIVE.map(([f, p]) => ({family: f, package: p, id: GP.make({family: f, package: p}).id, ...fpSummary(GP.make({family: f, package: p}).footprint)})),
    connectors: CONNECTORS.map(c => { const d = GP.make({family: "connector", ...c}); return {spec: c, id: d.id, pins: d.symbol.pins.map(p => [p.number, p.x, p.y, p.orientation]), ...fpSummary(d.footprint)}; })};
  const file = path.join(__dirname, "../goldens/generic-parts.json");
  if (globalThis.process?.env?.GENERIC_GOLDEN === "emit" || !fs.existsSync(file)) console.log("@@GOLDEN\n" + JSON.stringify(golden, null, 1) + "\n@@END");
  const want = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(golden.silkWidth, want.silkWidth, "golden silk width");
  for (const [i, g] of golden.packages.entries()) assert.deepEqual(g, want.packages[i], "golden " + g.family + " " + g.package);
  for (const [i, g] of golden.connectors.entries()) assert.deepEqual(g, want.connectors[i], "golden connector " + JSON.stringify(g.spec));
  // IPC-7351B spot checks: an 0603 resistor (RESC1608X55N) and the 2.54 mm header land.
  const r = GP.make({family: "resistor", package: "0603"}).footprint;
  assert.equal(r.name, "RESC1608X55N"); assert.equal(r.height, .55);
  const hdr = GP.make({family: "connector", type: "header", rows: 1, cols: 2}).footprint;
  assert.equal(hdr.pads[0].shape, "rect"); assert.equal(hdr.pads[1].shape, "round");
  assert.ok(hdr.pads[0].drill >= 1 && hdr.pads[0].drill <= 1.15, "a 0.64 mm square post gets a 1.0-1.1 mm hole");
}

// ------------------------------------------------------------ 3. determinism, sharing, identical outputs
function board() {
  const p = A.project("Generic board", []), sch = p.documents[0], pcb = p.documents[1];
  pcb.outline = [[0, 0], [60, 0], [60, 40], [0, 40]];
  const add = (o, at) => GP.place(p, sch, at, o).part;
  const parts = [add({family: "resistor", value: "4k7"}, [10, 10]), add({family: "resistor", value: "4.7 kΩ"}, [20, 10]), add({family: "resistor", value: "4k7", parameters: {Tolerance: "5%"}}, [30, 10]),
    add({family: "resistor", value: "10k"}, [40, 10]), add({family: "capacitor", value: "100n"}, [10, 30]), add({family: "capacitor", value: "100nF"}, [20, 30]),
    add({family: "led", value: "Green"}, [30, 30]), add({family: "connector", type: "header", rows: 2, cols: 3}, [50, 30])];
  parts.forEach((s, i) => pcb.items.push({id: "b-" + s.ref, kind: "part", def: s.def, ref: s.ref, value: s.value, link: s.link, x: 5 + 7 * (i % 7), y: 8 + 12 * Math.floor(i / 7), angle: 0, pinNets: {}}));
  return p;
}
{
  const a = GP.make({family: "resistor", package: "0603"}), b = GP.make({family: "resistor", package: "0603"});
  assert.equal(JSON.stringify(a), JSON.stringify(b), "the same parameters give the same definition, byte for byte");
  assert.notEqual(a.id, GP.make({family: "resistor", package: "0603", style: "ansi"}).id);
  assert.equal(a.generic.digest, GP.digestOf(a)); assert.ok(!GP.customised(a));
  const p = board();
  A.validate(p);
  assert.equal(p.library.filter(d => d.generic?.family === "resistor").length, 1, "four resistors share one 0603 definition");
  const r = p.documents[0].items.find(i => i.ref === "R1");
  assert.equal(r.value, "4.7 kΩ"); assert.equal(r.parameters.Tolerance, "1%"); assert.equal(r.parameters.Power, "100 mW");
  assert.match(r.parameters.Description, /^Resistor, 4\.7 kΩ, 1%, 100 mW/);
  assert.ok(GP.check(p).every(c => c.state === "current"));
  // Regenerate every definition from its parameters: outputs are identical.
  const pcb = p.documents[1], outputs = q => { const r = F.build(q, q.documents[1], {date: new Date(2026, 10, 19)}); return r.files.map(f => f.name + "\n" + (typeof f.content === "string" ? f.content : "")).join("\n"); };
  const before = outputs(p), bomBefore = JSON.stringify(B.build(B.collect(p)).map(r => r.values));
  for (const d of p.library.filter(GP.isGeneric)) GP.regenerate(p, d.id);
  assert.equal(outputs(p), before, "Gerber, drill and pick-and-place are identical after regenerating");
  assert.equal(JSON.stringify(B.build(B.collect(p)).map(r => r.values)), bomBefore, "the BOM is identical after regenerating");
  void pcb;
}

// ------------------------------------------------------------ 4. BOM grouping
{
  const p = board(), rows = B.build(B.collect(p));
  const line = ref => rows.find(r => String(r.values.designator).split(/, ?/).some(x => x === ref || (x.includes("-") && ref.startsWith(x[0]))));
  assert.equal(line("R1").values.designator, "R1, R2", "4k7 and 4.7 kΩ at 1% are one line");
  assert.equal(line("R1").values.quantity, 2);
  assert.notEqual(line("R3"), line("R1"), "the 5% resistor is its own line");
  assert.equal(line("C1").values.designator, "C1, C2");
  assert.equal(rows.length, 6);
}

// ------------------------------------------------------------ 5. connector regeneration keeps connections
{
  const p = A.project("Header", []), sch = p.documents[0];
  const {part} = GP.place(p, sch, [50.8, 50.8], {family: "connector", type: "header", rows: 1, cols: 4});
  const defs = () => defsOf(p);
  const pin = n => A.pins(part, p.library.find(d => d.id === part.def), "schematic").find(x => x.number === String(n)).at;
  const net = (n, name) => { const a = pin(n); sch.items.push({id: A.id(), kind: "wire", points: [[a[0] - 7.62, a[1]], a]}, {id: A.id(), kind: "netlabel", text: name, x: a[0] - 7.62, y: a[1]}); };
  net(1, "VCC"); net(2, "SDA"); net(4, "GND");
  let c = A.connectivity(sch, defs()).byPin;
  assert.deepEqual([1, 2, 4].map(n => c.get(part.id + "/" + n)), ["VCC", "SDA", "GND"]);
  // Growing to 6 pins: every connection stays.
  const oldDef = part.def;
  let r = GP.edit(p, part, {cols: 6});
  assert.ok(r.regenerated && !r.refused && part.def !== oldDef);
  assert.ok(!p.library.some(d => d.id === oldDef), "the unused definition is pruned");
  c = A.connectivity(sch, defs()).byPin;
  assert.deepEqual([1, 2, 4].map(n => c.get(part.id + "/" + n)), ["VCC", "SDA", "GND"], "connections kept by pin number");
  assert.equal(p.library.find(d => d.id === part.def).symbol.pins.length, 6);
  // Shrinking to 3 would drop connected pin 4: refused, then forced.
  r = GP.edit(p, part, {cols: 3});
  assert.ok(r.refused); assert.deepEqual(r.disconnected_pins, ["4"]); assert.deepEqual(r.removed_pins, ["4", "5", "6"]);
  assert.equal(p.library.find(d => d.id === part.def).symbol.pins.length, 6, "nothing changed");
  r = GP.edit(p, part, {cols: 3, force: true});
  assert.ok(!r.refused);
  c = A.connectivity(sch, defs()).byPin;
  assert.deepEqual([1, 2].map(n => c.get(part.id + "/" + n)), ["VCC", "SDA"]);
  // Two rows with odd/even numbering: pins 1 and 2 move sides, wires follow.
  r = GP.edit(p, part, {rows: 2, cols: 2});
  c = A.connectivity(sch, defs()).byPin;
  assert.deepEqual([1, 2].map(n => c.get(part.id + "/" + n)), ["VCC", "SDA"], "wires follow pins that moved");
  // Split into parts.
  const big = GP.make({family: "connector", type: "header", rows: 2, cols: 25, split: 20});
  assert.equal(big.symbol.parts, 3); assert.ok(big.symbol.pins.every(x => x.part >= 1 && x.part <= 3));
  assert.equal(big.symbol.pins.filter(x => x.part === 1).length, 20);
  // Package change on a passive keeps ratings the user set, and defaults follow otherwise.
  const q = A.project("R", []), {part: rr} = GP.place(q, q.documents[0], [0, 0], {family: "resistor", value: "1k", parameters: {Tolerance: "0.1%"}});
  GP.edit(q, rr, {package: "1206"});
  assert.equal(rr.parameters.Tolerance, "0.1%"); assert.equal(rr.parameters.Power, "250 mW");
  assert.equal(q.library.length, 1, "0603 definition pruned");
  assert.throws(() => GP.edit(q, rr, {value: "banana"}), /Can't read the value/);
  GP.edit(q, rr, {value: "2k2"}); assert.equal(rr.value, "2.2 kΩ");
}

// ------------------------------------------------------------ 6. dynamic connector pins, parts across sheets, finalise
{
  const p = A.project("Dynamic", []), sch = p.documents[0];
  p.documents.splice(1, 0, A.sheet("schematic", "Sheet 2"));
  const sch2 = p.documents[1];
  const {def, part} = DS.place(p, sch, [20.32, 20.32]);
  const [x0, y0] = def.dynamic.body;
  sch.items.push({id: A.id(), kind: "wire", points: [[5.08, 17.78], [part.x + x0, 17.78]]}, {id: A.id(), kind: "netlabel", text: "TX", x: 7.62, y: 17.78});
  DS.settle(p, sch);
  assert.equal(def.dynamic.pins.length, 1); assert.equal(def.dynamic.pins[0].name, "TX");
  const b = DS.addPart(p, def.id, sch2, [30.48, 30.48]);
  assert.equal(b.ref, part.ref); assert.equal(b.unit, 2); assert.equal(part.unit, 1); assert.equal(def.symbol.parts, 2);
  assert.equal(def.dynamic.pins[0].part, 1);
  sch2.items.push({id: A.id(), kind: "wire", points: [[10.16, 30.48 + y0 + 2.54], [b.x + x0, 30.48 + y0 + 2.54]]}, {id: A.id(), kind: "netlabel", text: "RX", x: 10.16, y: 30.48 + y0 + 2.54});
  DS.settle(p, sch2);
  assert.deepEqual(def.dynamic.pins.map(x => [x.number, x.name, x.part]), [["1", "TX", 1], ["2", "RX", 2]], "numbered on across the parts");
  assert.equal(A.pins(part, def, "schematic").length, 1); assert.equal(A.pins(b, def, "schematic").length, 1);
  assert.equal(A.connectivity(sch2, defsOf(p)).byPin.get(b.id + "/2"), "RX");
  const frozen = DS.headless(p, {op: "finalise", designator: part.ref, name: "UART connector"});
  assert.equal(frozen.dynamic, false); assert.equal(frozen.name, "UART connector");
  const fd = p.library.find(d => d.id === frozen.def_id);
  assert.equal(fd.symbol.parts, 2); assert.equal(fd.footprint.pads.length, 2);
  assert.equal(A.connectivity(sch, defsOf(p)).byPin.get(part.id + "/1"), "TX", "wires stay connected after finalising");
  A.validate(p);
}

// ------------------------------------------------------------ 7. bind only to library data
{
  const p = board(), r1 = p.documents[0].items.find(i => i.ref === "R1");
  assert.deepEqual(GP.candidates(p, r1), [], "no library part with an MPN: nothing to bind");
  p.library.push({id: "lib-r", name: "RC0603 4K7", prefix: "R", value: "4.7k", package: "0603", parameters: {Value: "4k7", Manufacturer: "Example Corp", "Manufacturer Part Number": "EX-0603-4K7", "LCSC #": "C0000"},
    symbol: {pins: [], shapes: []}});
  p.library.push({id: "lib-r2", name: "RC0603 10K", prefix: "R", value: "10k", package: "0603", parameters: {Value: "10k", MPN: "EX-0603-10K"}, symbol: {pins: [], shapes: []}});
  p.library.push({id: "lib-r3", name: "RC0805 4K7", prefix: "R", package: "0805", parameters: {Value: "4k7", MPN: "EX-0805-4K7"}, symbol: {pins: [], shapes: []}});
  const c = GP.candidates(p, r1);
  assert.deepEqual(c.map(x => x.mpn), ["EX-0603-4K7"], "same value and package only");
  assert.throws(() => GP.bind(p, r1, "lib-r2"), /not a match/);
  assert.throws(() => GP.bind(p, r1, "made-up"), /not a match/);
  const res = GP.bind(p, r1, "lib-r");
  assert.equal(res.mpn, "EX-0603-4K7");
  const b1 = p.documents[1].items.find(i => i.ref === "R1");
  assert.equal(r1.parameters["Manufacturer Part Number"], "EX-0603-4K7"); assert.equal(r1.parameters["LCSC #"], "C0000"); assert.equal(r1.parameters.Tolerance, "1%");
  assert.equal(b1.parameters["Manufacturer Part Number"], "EX-0603-4K7", "the board copy is bound too");
  assert.ok(GP.isGeneric(p.library.find(d => d.id === r1.def)), "the part stays generic");
  const rows = B.build(B.collect(p));
  assert.ok(rows.some(r => r.values.designator === "R1" && r.values.mpn === "EX-0603-4K7"), "bound R1 is its own BOM line with its MPN");
  GP.unbind(p, r1); assert.equal(r1.parameters["Manufacturer Part Number"], undefined); assert.equal(r1.boundTo, undefined);
}

// ------------------------------------------------------------ 8. round trips
{
  const p = board();
  A.validate(p);
  const {nativeRoundTrip}=require("../support/native-cad.cjs");
  const back=nativeRoundTrip(p);
  A.validate(back);
  assert.deepEqual(back.library.map(def=>def.generic),p.library.map(def=>def.generic),"native definitions retain authored generator parameters");
  assert.ok(GP.check(back).every(c => c.state === "current"));
  // Hand edit: the definition is customised and never regenerated over.
  const d = back.library.find(x => x.generic?.family === "capacitor");
  d.footprint.pads[0].w += .1;
  assert.equal(GP.check(back).find(c => c.def_id === d.id).state, "customised");
  // Export as ordinary components.
  const K = AtriumKiCad, KS = AtriumKiCadSchematic, I = AtriumImportFormats;
  const brd = K.exportBoard(p, p.documents[1]).content, sheet = KS.exportSheet(p, p.documents[0]).content;
  assert.ok(brd.includes("RESC1608X55N") && sheet.includes("4.7 kΩ"));
  assert.ok(!/generic/.test(brd.replace(/Generic/g, "")), "nothing generator-specific in the KiCad board");
  const enc = new TextEncoder();
  const rb = I.read("g.kicad_pcb", enc.encode(brd)), rs = I.read("g.kicad_sch", enc.encode(sheet));
  assert.equal(rb.documents[0].items.filter(i => i.kind === "part").length, 8);
  assert.equal(rs.documents[0].items.filter(i => i.kind === "part").length, 8);
  assert.ok(rs.documents[0].items.some(i => i.kind === "part" && i.value === "4.7 kΩ"));
  const X = AtriumAltiumExport.exportProject(p);
  assert.ok(X.files.length >= 2);
  const again = AtriumAltiumExport.exportProject(p);
  assert.deepEqual(again.files.map(f => f.content), X.files.map(f => f.content), "Altium export is deterministic");
}

// ------------------------------------------------------------ 9. headless (MCP)
{
  let S = {base: board()};
  const ctx = {project: () => S.work || S.base, mutable: () => (S.work ||= JSON.parse(JSON.stringify(S.base))), touched() { S.touched = (S.touched || 0) + 1; }};
  const placed = GP.headless("place", {family: "capacitor", value: "4u7", package: "0805", x: 60, y: 60, parameters: {Dielectric: "X5R"}}, ctx);
  assert.equal(placed.family, "capacitor"); assert.equal(placed.untrusted_design_text.value, "4.7 µF"); assert.equal(placed.untrusted_design_text.parameters.Dielectric, "X5R");
  const ed = GP.headless("edit", {designator: placed.untrusted_design_text.designator, value: "10u", package: "1206"}, ctx);
  assert.equal(ed.untrusted_design_text.value, "10 µF"); assert.ok(ed.regenerated);
  const ref = GP.headless("edit", {designator: "J1", cols: 1, rows: 1}, ctx);
  assert.equal(ref.refused, false, "nothing is connected to J1 on this sheet");
  const list = GP.headless("list", {designator: "R1", candidates: true, family: "diode"}, ctx);
  assert.ok(list.generic_parts.length >= 4 && list.part.family === "resistor" && list.packages.includes("SOD-123"));
  assert.throws(() => GP.headless("place", {family: "unicorn"}, ctx), /Unknown generic part family/);
  assert.throws(() => GP.headless("place", {family: "resistor", package: "9999"}, ctx), /has no package/);
  assert.throws(() => GP.headless("place", {family: "connector", type: "header", rows: 9}, ctx), /rows/);
  A.validate(ctx.project());
}
// ------------------------------------------------------------ placement: the definition only stays when a part uses it
{
  require("../../app/library/generic-parts-ui.js");
  const sheet = A.sheet("schematic", "Sheet 1"), p = {format: "atrium", version: 1, name: "Place", units: "mm", library: [], documents: [sheet]};
  let tool = "select";
  const host = {project: () => p, doc: () => sheet, derive(fn) { fn(); }, info() {}, tool: () => tool, selectDocument() {}, placeDef() { tool = "place"; return true; }};
  for (const placed of [false, true]) {
    let check;
    const schedule = globalThis.setTimeout;
    globalThis.setTimeout = callback => { check = callback; return 1; };
    try { AtriumGenericPartsUI.startPlace(host, {family: "resistor", value: "4k7", package: "0603"}); }
    finally { globalThis.setTimeout = schedule; }
    assert.equal(p.library.length, 1, "the ghost needs the definition while placing");
    if (placed) sheet.items.push({...A.instantiate(p, p.library[0], [10, 10]), kind: "part"});
    tool = "select";
    check();
    assert.equal(p.library.length, Number(placed), placed ? "a placed part keeps its definition" : "Escape before the first click leaves no unused definition");
  }
  console.log("PASS generic parts");
}
