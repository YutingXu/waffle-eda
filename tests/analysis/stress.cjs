"use strict";
// Component stress and derating (app/analysis/stress.js): net-name voltages, capacitor voltage derating,
// resistor V²/R with tolerance and temperature derating, LED current through a series resistor,
// diode reverse voltage, missing ratings, variants, SPICE node voltages and the MCP op.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "variants", "calculators", "stress"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const T = AtriumStress, A = Atrium;
const close = (a, b, tol, m) => assert.ok(Math.abs(a - b) <= tol, (m || "") + " " + a + " differs from " + b);

// ---- net names -------------------------------------------------------------------------------
const V = n => T.netVoltage(n)?.v ?? null;
for (const [n, v] of [["+3V3", 3.3], ["3V3", 3.3], ["3.3V", 3.3], ["+3.3V", 3.3], ["P5V0", 5], ["VCC_1V8", 1.8], ["VDD_3V3", 3.3], ["12V_IN", 12], ["VIN_24V", 24],
  ["-12V", -12], ["N5V", -5], ["1800mV", 1.8], ["+5", 5], ["5V_USB", 5], ["3V3_A", 3.3], ["GND", 0], ["AGND", 0], ["PGND", 0], ["VSS", 0], ["0V", 0], ["VBUS", 5], ["USB_VBUS", 5], ["VBAT", 4.2]])
  assert.equal(V(n), v, n);
for (const n of ["Net-R1-2", "SDA", "VDD", "VCC", "LED_A", "CLK100", "V5"]) assert.equal(V(n), null, n);
// ---- values ----------------------------------------------------------------------------------
for (const [t, k, v] of [["10 kΩ", "R", 1e4], ["4k7", "R", 4700], ["2R2", "R", 2.2], ["1M", "R", 1e6], ["100", "R", 100], ["100nF", "C", 1e-7], ["4u7", "C", 4.7e-6],
  ["0.25W", "W", .25], ["1/4W", "W", .25], ["250mW", "W", .25], ["16V", "V", 16], ["20mA", "A", .02]]) close(T.parseValue(t, k), v, v * 1e-9, t);
close(T.derate(.25, 25), .25, 0); close(T.derate(.25, 112.5), .125, 1e-12, "half way 70..155 °C"); assert.equal(T.derate(.25, 160), 0);
// Both public callers, below, at and above the knee. 32*(128-80)/64 = 24; 8*(96-64)/64 = 4.
{
  const calc = (rated, ambient, knee, tmax) => AtriumCalc.calculate("derating", {rated, knee, tmax, ambient, power: 0, margin: 100}).values.allowed;
  for (const [rated, ambient, knee, tmax, want] of [
    [32, 63, 64, 128, 32], [32, 64, 64, 128, 32], [32, 80, 64, 128, 24], [32, 96, 64, 128, 16], [32, 112, 64, 128, 8], [32, 128, 64, 128, 0], [32, 129, 64, 128, 0],
    [8, 31, 32, 96, 8], [8, 32, 32, 96, 8], [8, 64, 32, 96, 4], [8, 96, 32, 96, 0], [8, 97, 32, 96, 0],
    [0, 63, 64, 128, 0], [0, 64, 64, 128, 0], [0, 96, 64, 128, 0], [0, 128, 64, 128, 0], [0, 129, 64, 128, 0]]) {
    assert.equal(T.derate(rated, ambient, knee, tmax), want, "stress " + ambient + " knee " + knee);
    assert.equal(calc(rated, ambient, knee, tmax), want, "calculator " + ambient + " knee " + knee);
  }
  assert.equal(T.derate(32, 65, 64, 64), 32, "stress keeps rated power when tmax is not above the knee");
  assert.equal(T.derate(8, 97, 96, 32), 8, "stress keeps rated power on an inverted range");
  assert.throws(() => calc(32, 65, 64, 64), /zero-power temperature must be above the knee/);
  console.log("power derating: knee 64/128 and sibling 32/96, zero power, unordered ranges");
}

// ---- a board-only design (nets from pad nets) ---------------------------------------------------
const fp = name => ({name, pads: [{number: "1", x: -.8, y: 0, w: .8, h: .9}, {number: "2", x: .8, y: 0, w: .8, h: .9}]});
const lib = [
  {id: "c16", name: "Cap", value: "100nF", parameters: {Voltage: "16V", Dielectric: "X7R"}, footprint: fp("C_0603")},
  {id: "c25", name: "Cap", value: "10uF 25V X5R", footprint: fp("C_0805")},
  {id: "cx", name: "Cap", value: "1uF", footprint: fp("C_0603")},
  {id: "r0603", name: "Res", value: "100", parameters: {Tolerance: "5%"}, footprint: fp("R_0603")},
  {id: "r1k", name: "Res", value: "1k", parameters: {Power: "0.25W", Tolerance: "1%"}, footprint: fp("R_1206")},
  {id: "r330", name: "Res", value: "330", footprint: fp("R_0603")},
  {id: "led", name: "LED red", value: "LED red", parameters: {If: "20mA"}, footprint: fp("LED_0603")},
  {id: "led5", name: "LED", value: "LED blue", parameters: {If: "5mA", Vf: "3.0V"}, footprint: fp("LED_0603")},
  {id: "d", name: "1N4148", value: "1N4148", parameters: {VR: "75V", Current: "150mA"}, footprint: fp("SOD-123")}];
const part = (id, ref, def, n1, n2, extra = {}) => ({id, kind: "part", ref, def, value: lib.find(d => d.id === def).value, x: 10, y: 10, angle: 0, layer: "Top", link: "L-" + ref, pinNets: {1: n1, 2: n2}, ...extra});
const board = {id: "b", kind: "pcb", name: "Board", outline: [[0, 0], [50, 0], [50, 50], [0, 50]], items: [
  part("p1", "C1", "c16", "+12V", "GND"), part("p2", "C2", "c25", "+3V3", "GND"), part("p3", "C3", "cx", "+3V3", "GND"),
  part("p4", "R1", "r0603", "+3V3", "GND"), part("p5", "R2", "r1k", "+12V", "GND"),
  part("p6", "R3", "r330", "+5V", "LEDA"), part("p7", "D1", "led", "GND", "LEDA"),
  part("p8", "R4", "r330", "+5V", "LEDB"), part("p9", "D2", "led5", "GND", "LEDB"),
  part("p10", "D3", "d", "+12V", "GND"), part("p11", "R5", "r1k", "SIG", "GND")]};
const project = {name: "Stress", library: lib, documents: [board], variants: [{id: "v1", name: "Lite", parts: {"L-C1": {fitted: false}, "L-C2": {params: {Voltage: "6.3V"}}}}]};
const rep = T.check(project, {});
const row = (ref, check) => rep.rows.find(r => r.ref === ref && r.check === check);
// Capacitors: 12 V on a 16 V X7R (50 % → 8 V) is over the derated limit; 3.3 V on 25 V is fine.
assert.equal(row("C1", "voltage").applied, 12); assert.equal(row("C1", "voltage").limit, 8); assert.equal(row("C1", "voltage").status, "warn");
assert.equal(row("C2", "voltage").rating, 25); assert.equal(row("C2", "voltage").status, "ok"); assert.equal(row("C2", "voltage").class, "class2");
assert.equal(row("C3", "voltage").status, "missing", "no voltage rating");
// Resistors: R1 100 Ω −5 % across 3.3 V in an 0603 (0.1 W assumed): P = 3.3²/95 = 0.1146 W > 0.1 W.
close(row("R1", "power").applied, 3.3 ** 2 / 95, 1e-4, "V²/R at the low tolerance limit");
assert.equal(row("R1", "power").ratingBasis, "assumed from 0603 package"); assert.equal(row("R1", "power").status, "fail");
// R2 1 kΩ −1 % at 12 V: 0.1455 W against 0.25 W (50 % margin → 0.125 W): warn.
close(row("R2", "power").applied, 144 / 990, 1e-4); assert.equal(row("R2", "power").limit, .125); assert.equal(row("R2", "power").status, "warn");
// Unknown net SIG: worst case between 0 V and the highest rail (12 V), marked so.
assert.equal(row("R5", "power").basis, "worst case"); close(row("R5", "power").applied, 144 / 990, 1e-4);
assert.equal(T.check(project, {worstCase: false}).rows.find(r => r.ref === "R5").status, "unknown");
// LEDs: (5 − 0 − 2.0)/330 = 9.09 mA vs 20 mA; the blue one (5 − 3)/330 = 6.06 mA vs 5 mA fails.
close(row("D1", "current").applied, 3 / 330, 1e-6); assert.equal(row("D1", "current").status, "ok");
close(row("D2", "current").applied, 2 / 330, 1e-6); assert.equal(row("D2", "current").status, "fail");
// Diode D3: pin 1 (K) on +12 V, pin 2 (A) on GND: 12 V reverse against 75 V (80 % → 60 V).
assert.equal(row("D3", "reverse").applied, 12); assert.equal(row("D3", "reverse").status, "ok");
assert.equal(row("D3", "current").status, "unknown", "directly across rails: not computable");
// Temperature derating: at 130 °C R2's allowed power is 0.25·25/85 = 0.0735 W: over the rating.
const hot = T.check(project, {ambient: 130}).rows.find(r => r.ref === "R2");
close(hot.rating, .25 * 25 / 85, 1e-4); assert.equal(hot.status, "fail");
// Overrides and supply margin.
assert.equal(T.check(project, {voltages: {"+12V": 15}}).rows.find(r => r.ref === "C1").applied, 15);
close(T.check(project, {supplyMargin: 10}).rows.find(r => r.ref === "C1").applied, 13.2, 1e-9);
// SPICE operating point (as the SPICE extension's spice.simulate returns it): node voltages and device current.
const sp = T.check(project, {spice: {nodes: {"+12V": 11.5, SIG: 2}, devices: {D1: {type: "D", id: .0123}}}});
assert.equal(sp.rows.find(r => r.ref === "C1").applied, 11.5); assert.match(sp.rows.find(r => r.ref === "C1").basis, /^SPICE \.op/);
close(sp.rows.find(r => r.ref === "R5").applied, 4 / 990, 1e-6); assert.equal(sp.rows.find(r => r.ref === "D1").applied, .0123);
// Variant: C1 not fitted, C2's rating overridden to 6.3 V (3.3 V > 3.15 V).
const lite = T.check(project, {variant: "Lite"});
assert.ok(!lite.rows.some(r => r.ref === "C1")); assert.equal(lite.rows.find(r => r.ref === "C2").status, "warn"); assert.equal(lite.variant.name, "Lite");
assert.ok(lite.notes.some(n => /not fitted/.test(n)));

// ---- schematic design (project-wide nets, power ports) -------------------------------------------
{
  const ex = AtriumParts.example(), sch = ex.documents.find(d => d.kind === "schematic");
  const r = T.check(ex, {voltages: {VDD: 5}});
  const c2 = r.rows.find(x => x.ref === "C2");
  assert.ok(c2 && c2.nets.includes("VDD") && c2.nets.includes("GND"), "nets from the schematic");
  assert.equal(c2.applied, 5); assert.equal(c2.status, "missing");
  assert.equal(c2.docId, sch.id, "rows cross-probe to the schematic part");
  assert.equal(r.nets.GND.v, 0);
}

// ---- MCP op ----------------------------------------------------------------------------------------
{
  const out = T.headless({failing_only: true}, {project: () => project, page: items => ({total: items.length, items})});
  assert.ok(out.items.every(i => ["fail", "warn", "missing"].includes(i.status)));
  assert.ok(out.items.some(i => i.ref === "R1" && i.status === "fail"));
  assert.equal(out.net_voltages["+12V"].v, 12);
  const one = T.headless({refs: ["c1"], voltages: {"+12V": 5}}, {project: () => project});
  assert.equal(one.items.length, 1); assert.equal(one.items[0].status, "ok");
  JSON.stringify(out);
}
console.log("stress ok");
