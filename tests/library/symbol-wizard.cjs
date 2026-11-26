"use strict";
// Symbol Wizard (app/library/symbol-wizard.js): column detection for tab, CSV and PDF-text pin tables,
// smart typing, active-low names, layouts (function, gates, package), validation, KiCad and
// existing-symbol import and the headless MCP entry point. The three sample tables are
// made-up parts written for Waffle in the style of an MCU, an op amp and an LDO datasheet.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "library-panel", "footprint-wizard", "footprint-editor", "symbol-editor", "sexpr", "symbol-wizard"]) require(require("../support/app-source-paths.cjs").appFile(m));
const W = AtriumSymbolWizard, L = AtriumLibrary, A = Atrium, G = 2.54;
const run = (text, o = {}) => { const t = W.detect(text, o); const r = W.pinsOf(t, o); return {t, pins: r.pins, notes: r.notes, issues: W.check(r.pins, o)}; };
const by = (pins, n) => pins.find(p => p.number === n);
const onGrid = v => Math.abs(v / G - Math.round(v / G)) < 1e-6;

{
  // MCU, PDF text: "name / alternates  number  type", header line, power, NC, NRST active low.
  const {t, pins, issues} = run(W.SAMPLES.mcu.text);
  assert.equal(t.mode, "space"); assert.equal(t.header, true);
  assert.equal(pins.length, 32);
  const pa2 = by(pins, "8");
  assert.equal(pa2.name, "PA2"); assert.deepEqual(pa2.alternates, ["USART2_TX", "ADC_IN2"]); assert.equal(pa2.electrical, 1);
  assert.equal(by(pins, "1").electrical, 7); assert.equal(by(pins, "16").electrical, 7);
  assert.equal(by(pins, "32").nc, true); assert.equal(by(pins, "29").electrical, 0);
  const nrst = by(pins, "4"); assert.equal(nrst.low, true); assert.equal(nrst.base, "RST"); assert.equal(nrst.name, "R̅S̅T̅");
  assert.deepEqual(issues.filter(x => x.level !== "info"), [], JSON.stringify(issues));
  // Function layout: power top, ground bottom, ports PA/PB/PC in blocks, every tip on the grid.
  const {def, model} = W.build(pins, {name: "MCU"});
  assert.equal(def.symbol.pins.length, 32);
  assert.ok(L.validateDef(def).ok, L.validateDef(def).errors.join("; "));
  const side = n => def.symbol.pins.find(p => p.number === n).orientation;
  assert.equal(side("17"), "up"); assert.equal(side("16"), "down"); assert.equal(side("5"), "up");
  for (const p of def.symbol.pins) assert.ok(onGrid(p.x) && onGrid(p.y), "pin " + p.number + " on grid");
  const pa = def.symbol.pins.filter(p => /^PA\d/.test(p.name));
  assert.equal(new Set(pa.map(p => p.orientation)).size, 1, "PA port on one side");
  const ys = pa.map(p => p.y); assert.deepEqual(ys, [...ys].sort((a, b) => a - b), "PA0..PA15 in order");
  assert.equal(def.symbol.pins.find(p => p.number === "32").noConnect, true);
  assert.deepEqual(def.symbol.pins.find(p => p.number === "6").alternates, ["ADC_IN0", "WKUP"]);
  assert.ok(model.pins.every(p => p.length === 2 * G));
  // Gates by group: PA, PB ports, control, power.
  const gates = W.build(pins, {layout: "gates"}).def;
  assert.ok(gates.symbol.parts >= 3, "gates " + gates.symbol.parts);
  assert.ok(L.validateDef(gates).ok, L.validateDef(gates).errors.join("; "));
  const gateOf = n => gates.symbol.pins.find(p => p.number === n).part;
  assert.equal(gateOf("6"), gateOf("13")); assert.notEqual(gateOf("6"), gateOf("14")); assert.equal(gateOf("16"), gateOf("17"));
  assert.equal(gateOf("16"), gates.symbol.parts, "power gate last");
  // Spacing 5.08 mm and 7.62 mm pins keep tips on the grid.
  const wide = W.build(pins, {pitch: 5.08, length: 7.62}).def;
  for (const p of wide.symbol.pins) assert.ok(onGrid(p.x) && onGrid(p.y) && p.length === 7.62);
  console.log("PASS MCU PDF text: alternates, smart power/NC, NRST overbar, port blocks, gates, 2.54 grid");
}
{
  // Op amp, tab-separated with a header: channels become gates, supplies a power gate or shared.
  const {t, pins, issues} = run(W.SAMPLES.opamp.text);
  assert.equal(t.mode, "tab"); assert.deepEqual(t.roles, ["number", "name", "type", "description"]);
  assert.deepEqual(pins.map(p => p.electrical), [2, 0, 0, 7, 0, 0, 2, 7]);
  assert.deepEqual(issues, []);
  const ch = W.channels(pins);
  assert.equal(ch.get(by(pins, "1").key), "A"); assert.equal(ch.get(by(pins, "5").key), "B");
  const sep = W.build(pins, {layout: "gates"}).def;
  assert.equal(sep.symbol.parts, 3);
  const g = n => sep.symbol.pins.find(p => p.number === n).part;
  assert.deepEqual(["1", "2", "3", "5", "7", "4", "8"].map(g), [1, 1, 1, 2, 2, 3, 3]);
  const shared = W.build(pins, {layout: "gates", power: "shared"}).def;
  assert.equal(shared.symbol.parts, 2);
  assert.ok(!(shared.symbol.pins.find(p => p.number === "8").part > 0), "V+ on every gate");
  assert.ok(L.validateDef(shared).ok);
  // Both gates get the same body so the shared pins sit on each.
  const bodies = shared.symbol.shapes.filter(s => s.style === "body" && s.closed && !s.pinArt).map(s => JSON.stringify(s.points));
  assert.equal(new Set(bodies).size, 1);
  const pkg = W.build(pins, {layout: "package", preset: "dual"}).def;
  assert.deepEqual(["1", "2", "3", "4"].map(n => pkg.symbol.pins.find(p => p.number === n).orientation), ["left", "left", "left", "left"]);
  const right = ["8", "7", "6", "5"].map(n => pkg.symbol.pins.find(p => p.number === n));
  assert.ok(right.every(p => p.orientation === "right")); assert.ok(right[0].y < right[3].y, "pin 8 at the top right");
  console.log("PASS op amp TSV: header roles, channels → gates, separate or shared power, dual package order");
}
{
  // LDO, CSV with the name first, quoted descriptions, "-" for ground/NC, PG# open drain.
  const {t, pins, issues} = run(W.SAMPLES.ldo.text);
  assert.equal(t.mode, "csv"); assert.deepEqual(t.roles, ["name", "number", "type", "description"]);
  assert.deepEqual(pins.map(p => [p.base, p.electrical, p.nc]), [["VIN", 7, false], ["GND", 7, false], ["EN", 0, false], ["NC", 4, true], ["PG", 3, false], ["VOUT", 7, false], ["EP", 7, false]]);
  assert.equal(by(pins, "5").low, true);
  assert.deepEqual(issues, []);
  const {def} = W.build(pins, {name: "LDO"});
  const o = n => def.symbol.pins.find(p => p.number === n).orientation;
  assert.deepEqual(["1", "2", "3", "5", "6", "7"].map(o), ["up", "down", "left", "right", "up", "down"]);
  const quad = W.build(pins, {layout: "package", preset: "quad"}).def;
  assert.ok(L.validateDef(quad).ok);
  console.log("PASS LDO CSV: name-first columns, quoted cells, smart ground and NC, PG# overbar, quad preset");
}
{
  // Number-first PDF text, multi-number cells, ranges, active-low spellings and styles.
  const {pins} = run("1 VDD power\n2 nRESET I\n3 RESET# I\n4 /CS I\n5, 6 GND S\n7 ~{WR} I\n8 CS_N I\n9-10 VCC power\n11 R\\D\\ I\n12 2 B");
  assert.deepEqual(pins.map(p => p.number), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11", "12"]);
  assert.deepEqual(pins.filter(p => p.low).map(p => p.base), ["RESET", "RESET", "CS", "WR", "CS", "RD"]);
  assert.equal(by(pins, "12").base, "2"); assert.equal(by(pins, "12").electrical, 1);
  assert.equal(W.styleName("CS", "altium"), "C\\S\\"); assert.equal(W.styleName("CS", "keep", "/CS"), "/CS");
  assert.equal(W.pinsOf(W.detect("1 nCS I"), {activeLow: "altium"}).pins[0].name, "C\\S\\");
  for (const [w, c] of [["I/O", 1], ["open drain", 3], ["Open-Drain", 3], ["power_in", 7], ["tri-state", 5], ["NC", "nc"], ["bidirectional", 1], ["", null], ["zzz", undefined]]) assert.equal(W.typeCode(w), c, w);
  // Column-aligned PDF text (two or more spaces between columns), alternates in their own column.
  const cols = run("Pin   Name     Type   Alternate functions\n1     PB3      I/O    SPI1_SCK / TIM2_CH2\n2     nRESET   I\n3     VSSA     S");
  assert.equal(cols.t.mode, "columns"); assert.deepEqual(cols.t.roles, ["number", "name", "type", "alternates"]);
  assert.deepEqual(cols.pins[0].alternates, ["SPI1_SCK", "TIM2_CH2"]); assert.equal(cols.pins[2].electrical, 7);
  // A name that is also a type word is still the name ("S" input, "B" type).
  const s = run("3 S I\n4 OE").pins; assert.deepEqual(s.map(p => [p.base, p.electrical]), [["S", 0], ["OE", L.inferElectrical("OE")]]);
  console.log("PASS PDF number-first rows, multi-number cells, ranges, active-low spellings and styles, type words");
}
{
  // Validation: duplicates, missing numbers, mixed types, unknown type words, footprint mismatch.
  const r = run("Pin\tName\tType\n1\tVDD\tpower\n2\tPA0\tio\n2\tPA1\tio\n5\tVDD\tinput\n6\tFOO\tweird");
  const codes = r.issues.map(x => x.code);
  assert.ok(codes.includes("duplicate")); assert.ok(codes.includes("missing")); assert.match(r.issues.find(x => x.code === "missing").message, /3–4/);
  assert.ok(r.notes.some(x => x.code === "type"));
  assert.ok(r.notes.some(x => x.code === "smart" && /VDD/.test(x.message)), "smart typing reports the override");
  assert.deepEqual(run("10 XYZ weird thing").pins[0].alternates, []);
  assert.equal(run("10 XYZ weird thing").pins[0].description, "weird thing");
  const smartOff = run("Pin\tName\tType\n1\tVDD\tpower\n5\tVDD\tinput", {smart: false});
  assert.ok(smartOff.issues.some(x => x.code === "mixed-type"));
  const fp = AtriumFootprintWizard.generate({family: "gullwing", preset: "SOIC-8"}).footprint;
  const mis = W.check(W.pinsOf(W.detect("1 A I\n2 B I\n9 C I")).pins, {footprint: fp}).map(x => x.code);
  assert.ok(mis.includes("no-pad") && mis.includes("no-pin"));
  // Edits from the preview grid override detection; excluded rows leave the symbol.
  const t = W.detect("1 VDD power\n2 PA0 io\n3 PA1 io");
  const e = W.pinsOf(t, {edits: {"1:0": {type: "0", name: "nIRQ"}, "2:0": {include: false}}}).pins;
  assert.equal(e[1].electrical, 0); assert.equal(e[1].low, true);
  assert.equal(W.build(e, {}).def.symbol.pins.length, 2);
  // Column roles chosen by hand.
  const swapped = W.pinsOf(W.detect("A,1\nB,2"), {roles: ["name", "number"]}).pins;
  assert.deepEqual(swapped.map(p => p.number + p.base), ["1A", "2B"]);
  assert.throws(() => W.detect("x".repeat(200001)), /too long/);
  console.log("PASS validation: duplicates, missing ranges, mixed types, unknown types, footprint mismatch, grid edits");
}
{
  // Existing symbols: a stored def and a KiCad .kicad_sym library become pin tables.
  const lm = W.build(W.pinsOf(W.detect(W.SAMPLES.opamp.text)).pins, {layout: "gates"}).def;
  const back = run(W.tableFromDef(lm)).pins;
  assert.deepEqual(back.map(p => [p.number, p.part]), lm.symbol.pins.map(p => [p.number, p.part]));
  const kicad = `(kicad_symbol_lib (version 20231120) (generator test)
    (symbol "TestAmp" (property "Reference" "U" (at 0 0 0))
      (symbol "TestAmp_0_1" (polyline (pts (xy 0 0) (xy 1 1))))
      (symbol "TestAmp_1_1" (pin output line (at 7.62 0 180) (length 2.54) (name "~" (effects)) (number "1" (effects)))
        (pin input line (at -7.62 2.54 0) (length 2.54) (name "-" (effects)) (number "2" (effects)))
        (pin input line (at -7.62 -2.54 0) (length 2.54) (name "+" (effects)) (number "3" (effects))))
      (symbol "TestAmp_2_1" (pin output line (at 7.62 0 180) (length 2.54) (name "~" (effects)) (number "7" (effects))))
      (symbol "TestAmp_3_1" (pin power_in line (at 0 7.62 270) (length 2.54) (name "V+" (effects)) (number "8" (effects)))
        (pin no_connect line (at 0 -7.62 90) (length 2.54) hide (name "~{RST}" (effects)) (number "5" (effects))))))`;
  const syms = W.kicadSymbols(kicad);
  assert.equal(syms.length, 1); assert.equal(syms[0].name, "TestAmp");
  const kp = run(syms[0].text).pins;
  assert.deepEqual(kp.map(p => [p.number, p.part, p.electrical]), [["1", 1, 2], ["2", 1, 0], ["3", 1, 0], ["7", 2, 2], ["8", 3, 7], ["5", 3, 4]]);
  assert.equal(by(kp, "5").nc, true); assert.equal(by(kp, "5").hidden, true); assert.equal(by(kp, "5").low, true);
  const kdef = W.build(kp, {layout: "gates"}).def;
  assert.equal(kdef.symbol.parts, 3);
  // Derived symbols (KiCad's standard libraries use them widely) list their parent's pins instead of being dropped.
  const derived = kicad.replace(/\)$/, `
    (symbol "TestAmp2" (extends "TestAmp") (property "Reference" "U" (at 0 0 0)))
    (symbol "TestAmp3" (extends "TestAmp2") (property "Reference" "U" (at 0 0 0)))
    (symbol "Orphan" (extends "Missing") (property "Reference" "U" (at 0 0 0))))`);
  const ds = W.kicadSymbols(derived), named = n => ds.find(s => s.name === n);
  assert.equal(named("TestAmp2").text, syms[0].text); assert.equal(named("TestAmp2").pins, 6);
  assert.equal(named("TestAmp3").text, syms[0].text, "a chain of derived symbols resolves");
  assert.equal(named("Orphan").text, "", "a missing parent leaves the symbol empty");
  assert.throws(() => W.kicadSymbols("(kicad_sch)"), /symbol library/);
  console.log("PASS existing symbols: def → table round trip, KiCad .kicad_sym units, hidden, no-connect, ~{} overbar");
}
{
  // An Altium file's components as pin tables (the import path of Import file…): the BSD-2
  // PiDP-11 I/O Expander SchDoc fixture (tests/fixtures/altium/pidp11-io-expander, see its NOTICE).
  const fs = require("node:fs"), path = require("node:path");
  globalThis.CFB = require("../../app/vendor/cfb.min.js");
  for (const f of ["sch-objects", "hierarchy", "import-link", "source-file", "sch-import", "io"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
  const file = path.join(__dirname, "../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.SchDoc");
  const lib = AtriumIO.read("PiDP11IOExpander.SchDoc", new Uint8Array(fs.readFileSync(file))).library.filter(d => d.symbol?.pins?.length >= 8);
  assert.ok(lib.length > 0, "a component with 8 or more pins");
  for (const d of lib) {
    const pins = run(W.tableFromDef(d)).pins, numbers = p => p.map(x => String(x.number)).sort();
    assert.deepEqual(numbers(pins), numbers(d.symbol.pins), d.name);
    assert.ok(L.validateDef(W.build(pins, {name: d.name, layout: (d.symbol.parts || 1) > 1 ? "gates" : "function"}).def).ok, d.name);
  }
  console.log("PASS Altium SchDoc components → pin tables → symbols (" + lib.length + " parts)");
}
{
  // Headless (MCP): a library edit on the working copy, pin names marked untrusted.
  let project = A.project("Bench", AtriumParts.catalogue), touched = 0;
  const fpDef = {id: "fp-sot23-6", name: "SOT-23-6 part", footprint: AtriumFootprintWizard.generate({family: "sot23", preset: "SOT-23-6"}).footprint};
  project.library.push(fpDef);
  const ctx = {mutable: () => project, touched: () => touched++};
  const r = W.headless({table: W.SAMPLES.ldo.text, name: "LDO 1150", footprint_def_id: "fp-sot23-6"}, ctx);
  assert.equal(r.pins, 7); assert.equal(r.added, true); assert.equal(touched, 1);
  assert.equal(r.detected.mode, "csv"); assert.equal(r.counts.no_connect, 1); assert.equal(r.counts.active_low, 1);
  assert.equal(r.untrusted_design_text.name, "LDO 1150");
  assert.ok(r.untrusted_design_text.issues.some(x => x.code === "no-pad"), "7 pins vs a 6-pad footprint");
  const made = project.library.find(d => d.id === r.def_id);
  assert.equal(made.footprint.name, fpDef.footprint.name); assert.equal(made.symbol.pins.find(p => p.number === "4").noConnect, true);
  const again = W.headless({table: W.SAMPLES.opamp.text, def_id: r.def_id, layout: "gates", columns: {description: 3}}, ctx);
  assert.equal(again.added, false); assert.equal(again.gates, 3);
  assert.equal(project.library.find(d => d.id === r.def_id).name, "LDO 1150");
  assert.throws(() => W.headless({table: "1 A\n1 B"}, ctx), /appears 2 times/);
  assert.throws(() => W.headless({table: ""}, ctx), /pin table/);
  assert.throws(() => W.headless({table: "1 A", columns: {name: 9}}, ctx), /Column name/);
  assert.throws(() => W.headless({table: "1 A", columns: {evil: 0}}, ctx), /Unknown column role/);
  assert.throws(() => W.headless({table: "1 A", footprint_def_id: "nope"}, ctx), /no footprint/);
  // Text that looks like code is only ever a pin name.
  const odd = W.headless({table: "1\tconstructor\n2\t__proto__\n3\t${alert(1)}"}, ctx);
  assert.equal(odd.pins, 3); assert.equal(({}).polluted, undefined);
  assert.ok(A.validate(JSON.parse(JSON.stringify(project))));
  console.log("PASS headless: proposal-ready library edit, footprint link, rebuild by def_id, refusals, untrusted text");
}
