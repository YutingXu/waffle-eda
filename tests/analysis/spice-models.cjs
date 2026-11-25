"use strict";
// SPICE model ladder and generic templates (extensions/spice/models.js):
// engineering-notation input, provenance and rungs, every template's bench check in
// the Quick engine against the values it was fitted from, template goldens, pin mapping by pin.fn
// (placeholders, multi-unit) and by name, assignments ("Use generic", exclude), coverage and its budget.
// node tests/analysis/spice-models.cjs, or scripts/test-jsc.sh spice-models
const assert = require("node:assert/strict");
const S = require("../../extensions/spice/spice.js");
const M = require("../../extensions/spice/models.js");
const X = require("../../extensions/spice/export.js");
const T = M.TEMPLATES;
const close = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol * Math.abs(want), what + ": got " + got + ", want " + want);

// ------------------------------------------------------------------ numbers as typed from datasheets
for (const [t, v] of [["1 MHz", 1e6], ["350 kHz", 350e3], ["10 mA", 0.01], ["50 mΩ", 0.05], ["4k7", 4700], ["2.2µ", 2.2e-6], ["1meg", 1e6], ["100 dB", 100], ["±15 V", 15], ["0.5 V/µs", 0.5], ["3.3", 3.3], ["1M", 1e6], ["1m", 1e-3], ["250 µA", 250e-6]])
  close(M.hnum(t), v, 1e-12, t);
assert.ok(Number.isNaN(M.hnum("abc")));
assert.deepEqual(M.supply("±15 V"), {lo: -15, hi: 15}); assert.deepEqual(M.supply("2.7–5.5 V"), {lo: 0, hi: 5.5}); assert.deepEqual(M.supply("5 V"), {lo: 0, hi: 5});

// ------------------------------------------------------------------ provenance and rungs
{
  const v = M.values(T.opamp, {GBW: {v: "350 kHz", src: "datasheet", page: 5, quote: "Gain-bandwidth product 350 kHz"}, Vos: "2u"});
  assert.equal(v.vals.GBW, 350e3); assert.equal(v.recs.GBW.src, "datasheet"); assert.equal(v.recs.GBW.page, "5");
  assert.equal(v.recs.Vos.src, "user", "a bare value is the user's");
  assert.equal(v.recs.SR.src, "derived"); close(v.vals.SR, 0.175, 1e-9, "SR derived from GBW (0.5 V/µs per MHz)");
  assert.ok(v.defaults.includes("Rails") && v.defaults.includes("Rout") && !v.defaults.includes("GBW"));
  assert.equal(M.rungOf(T.opamp, v.recs, {check: {passed: true}}), "Generic", "a required field at its default keeps the rung Generic");
  const all = {GBW: {v: "350k", src: "datasheet"}, Rails: {v: "RRIO", src: "user"}, Supply: {v: "1.8 to 5.5 V", src: "datasheet"}};
  const r = M.values(T.opamp, all).recs;
  assert.equal(M.rungOf(T.opamp, r, {check: {passed: true}}), "Fitted");
  assert.equal(M.rungOf(T.opamp, r, {}), "Generic", "Fitted needs a passed bench check");
  assert.equal(M.rungOf(T.opamp, M.values(T.opamp, {...all, GBW: {v: "350k", src: "ai", quote: "350 kHz"}}).recs, {check: {passed: true}}), "Generic", "unconfirmed AI values never reach Fitted");
  assert.equal(M.rungOf(T.opamp, M.values(T.opamp, {...all, GBW: {v: "350k", src: "placeholder"}}).recs, {check: {passed: true}}), "Generic", "carried from a placeholder: not checked");
  assert.equal(M.rungOf(T.opamp, M.values(T.opamp, {GBW: "1 MHz", Rails: "RRO", Supply: "5 V"}).recs, {placeholder: true}), "Fitted", "a sketch's user values");
  assert.equal(M.rec({v: "1", src: "made-up"}).src, "ai", "an unknown source counts as unverified");
  assert.equal(M.rungOf(T.load, {}), "Load-only"); assert.equal(M.rungOf(T["opamp-ideal"], {}), "Ideal");
  assert.match(M.instantiate(T.opamp, {}).error || "", /^$/);
  assert.match(M.instantiate(T.opamp, {GBW: "fast"}).error, /bad value for GBW/);
  assert.match(M.instantiate(T.opamp, {Rails: "sometimes"}).error, /bad value for Rails/);
  assert.match(M.template("opamp@7").error, /not in this Waffle/); assert.match(M.template("vacuum-tube").error, /unknown template/);
}

// ------------------------------------------------------------------ every template's bench, with defaults and with entered values
{
  for (const [id, t] of Object.entries(T)) {
    const r = M.benchCheck(t, {});
    assert.ok(r.passed, id + " defaults: " + JSON.stringify(r.measures.filter(m => m.ok === false || m.error)));
  }
  const fit = (id, params, keys) => {
    const r = M.benchCheck(T[id], params);
    assert.ok(r.passed, id + ": " + JSON.stringify(r.measures.map(m => [m.key, m.got, m.want, m.error])));
    for (const k of keys) assert.ok(r.measures.find(m => m.key === k && m.ok), id + " checks " + k);
    return r;
  };
  // Op-amp GBW and SR within 5 % (§18); a low-power CMOS RRIO part on ±2.5 V.
  fit("opamp", {GBW: "350 kHz", SR: "0.16 V/µs", Supply: "±2.5 V", Rails: "RRIO", Aol: "130 dB", Iq: "17 µA"}, ["GBW", "SR", "Aol"]);
  fit("opamp", {GBW: "10 MHz", SR: "20 V/µs", Supply: "±15 V", Rails: "none", PM: "45"}, ["GBW", "SR"]);
  // Diode: both entered points within 1 %, and a third point that sets RS.
  fit("diode", {Vf: "0.62 V", If: "1 mA", Vf2: "0.72 V", If2: "10 mA"}, ["Vf", "Vf2"]);
  fit("diode", {Vf: "0.62 V", If: "1 mA", Vf2: "0.72 V", If2: "10 mA", Vf3: "1.0 V", If3: "200 mA"}, ["Vf", "Vf2", "Vf3"]);
  fit("diode", {Type: "Schottky", Vf: "0.3 V", If: "10 mA"}, ["Vf"]);
  fit("zener", {Vz: "3.3 V", Izt: "5 mA", Zzt: "95 Ω"}, ["Vz"]);
  fit("led", {Colour: "blue", Vf: "2.9 V", If: "5 mA", Vf2: "3.2 V", If2: "20 mA"}, ["Vf", "Vf2"]);
  // MOSFET Rds(on) at the given Vgs within 3 %, and the threshold at its 250 µA definition.
  fit("mosfet", {Polarity: "N", Vth: "1.3 V", Rds: "3.5 Ω", VgsR: "4.5 V"}, ["Rds", "Vth"]);
  fit("mosfet", {Polarity: "P", Vth: "-1.6 V", Rds: "50 mΩ", VgsR: "-4.5 V", Ith: "1 mA"}, ["Rds", "Vth"]);
  fit("bjt", {Polarity: "PNP", hFE: "180", Ic: "10 mA", Vbe: "0.72"}, ["hFE"]);
  // LDO: dropout at the given load within 2 %, output and PSRR.
  fit("ldo", {Vout: "1.8 V", Vdo: "250 mV", Ido: "300 mA", PSRR: "70 dB", BW: "200 kHz"}, ["Vout", "Vdo", "PSRR"]);
  fit("comparator", {Output: "open-drain", tpd: "200 ns", Hyst: "20 mV", Supply: "3.3 V"}, ["tpd", "Hyst"]);
  fit("logic", {Function: "nand", Family: "ttl", Supply: "5 V", tpd: "8 ns"}, ["tpd"]);
  fit("logic", {Function: "not", Schmitt: "yes", Supply: "3.3 V"}, ["tpd"]);
  fit("crystal", {f: "32.768 kHz", CL: "12.5 pF", ESR: "70 kΩ", C0: "1.5 pF", C1: "3 fF"}, ["f", "ESR"]);
  fit("ferrite", {Z100: "698.5 Ω", Points: "10:75.42, 1000:159.33"}, ["Z100"]); // points of R 800 Ω ∥ L 1.2 µH ∥ C 1 pF
  fit("capacitor", {C: "10 µF", Case: "0805", ESR: "5 mΩ", Dielectric: "X5R", Vrated: "10 V"}, ["C"]);
  fit("inductor", {L: "4.7 µH", DCR: "50 mΩ", SRF: "60 MHz"}, ["L"]);
}
// MLCC DC bias: the class-generic estimate is labelled, the curve is a smooth charge model, and
// entered points are reproduced.
{
  const est = M.instantiate(T.capacitor, {C: "10u", Dielectric: "X5R", Vrated: "10 V", Case: "0603"});
  assert.match(est.model, /class-generic X5R curve, an estimate, not vendor data/);
  assert.match(est.model, /^Bc 1 n1 Q=\{/m); assert.match(est.model, /^Lesl n1 2 5e-10$/m, "0603 ESL default");
  const b = T.capacitor.bias({Bias: "2.5:70, 5:45, 10:25"}), ratio = x => b.r + (1 - b.r) / (1 + (x / b.vk) ** 2);
  for (const [x, y] of [[2.5, 0.7], [5, 0.45], [10, 0.25]]) assert.ok(Math.abs(ratio(x) - y) < 0.06, "bias point " + x + " V: " + ratio(x));
  const r = M.benchCheck(T.capacitor, {C: "10u", Bias: "2.5:70, 5:45, 10:25", Vrated: "10 V", Dielectric: "X5R"});
  const cb = r.measures.find(m => m.key === "Cbias");
  close(cb.got, 10e-6 * 0.45, 0.08, "effective C at half the rated voltage, measured in AC around the bias point");
  assert.equal(T.capacitor.bias({Dielectric: "C0G", Vrated: "50"}), null, "C0G has no DC-bias loss");
}
// Fitters reproduce their inputs exactly where the maths allows.
{
  const VT = S.VT, j = M.fitJunction([{v: 0.6, i: 1e-3}, {v: 0.7, i: 1e-2}], 1.8);
  close(j.n, 0.1 / (VT * Math.log(10)), 1e-12, "N from two points"); close(j.n * VT * Math.log(1e-3 / j.is), 0.6, 1e-12, "IS reproduces the first point");
  const {kp, vt} = T.mosfet.fit({Vth: 2, Ith: 250e-6, Rds: 0.1, VgsR: 10});
  close(1 / (kp * (10 - vt)), 0.1, 1e-9, "Rds(on) = 1/(KP·(Vgs − Vth'))"); close(kp / 2 * (2 - vt) ** 2, 250e-6, 1e-6, "Id at Vth = 250 µA");
}
// Template goldens: a changed netlist needs a version bump.
{
  const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); };
  const now = Object.fromEntries(Object.entries(T).map(([id, t]) => [id + "@" + t.v, hash(M.instantiate(t, {}).model)]));
  const GOLDEN = require("./spice-models-golden.json");
  if (process.env.ATRIUM_UPDATE_GOLDEN) require("node:fs").writeFileSync(__dirname + "/spice-models-golden.json", JSON.stringify(now, null, 1) + "\n");
  else assert.deepEqual(now, GOLDEN, "template netlists changed: bump the template version (and regenerate with ATRIUM_UPDATE_GOLDEN=1)");
  for (const t of Object.values(T)) assert.ok(t.notModelled.length, t.id + " lists what it does not model");
  for (const t of Object.values(T)) assert.match(M.instantiate(t, {}).model, /not a vendor model/);
}

// ------------------------------------------------------------------ the netlister: placeholders, assignments, coverage
const pin = (number, name, net) => ({number: String(number), name, net});
const comp = (id, ref, value, pins) => ({id, ref, value, pins});
// Synthetic placeholders in the shape of app/library/placeholder-parts.js: def.generic {role: "placeholder",
// family, params}; the symbol's pins carry pin.fn (and part = unit). The extension passes them on as def.pins.
const phDef = (id, family, params, pins) => ({id, name: family + " (placeholder)", generic: {role: "placeholder", family, params}, pins});
const defs = [
  phDef("ph-opamp2", "opamp", {units: 2}, [["1", "OUT", 1], ["2", "IN-", 1], ["3", "IN+", 1], ["4", "V-", 0], ["5", "IN+", 2], ["6", "IN-", 2], ["7", "OUT", 2], ["8", "V+", 0]].map(([number, fn, unit]) => ({number, fn, unit}))),
  phDef("ph-ldo", "ldo", {en: true}, [["1", "VIN"], ["2", "GND"], ["3", "EN"], ["5", "VOUT"]].map(([number, fn]) => ({number, fn}))),
  phDef("ph-nmos", "mosfet", {polarity: "n"}, [["1", "G"], ["2", "S"], ["3", "D"]].map(([number, fn]) => ({number, fn}))),
  phDef("ph-not", "logic", {function: "not", inputs: 1, units: 1}, [["2", "IN1", 1], ["3", "GND", 0], ["4", "OUT", 1], ["5", "V+", 0]].map(([number, fn, unit]) => ({number, fn, unit}))),
  phDef("ph-ram", "memory", {bus: "spi"}, [["1", "CS#"], ["4", "GND"], ["8", "V+"]].map(([number, fn]) => ({number, fn}))),
  phDef("ph-sw", "switch", {type: "spst"}, [["1", "A"], ["2", "B"]].map(([number, fn]) => ({number, fn}))),
  {id: "lm", name: "LM321", parameters: {}}
];
const netlist = {components: [
  comp("v1", "V1", "5V", [pin(1, "+", "VIN"), pin(2, "-", "GND")]),
  comp("vs", "V2", "", [pin(1, "+", "SIG"), pin(2, "-", "GND")]), comp("v5", "V5", "5V", [pin(1, "+", "V5"), pin(2, "-", "GND")]),
  // U1: a dual op-amp placeholder placed as two units; each unit's component lists every pin.
  comp("u1a", "U1", "Op-amp", [pin(1, "1", "MID"), pin(2, "2", "FB1"), pin(3, "3", "SIG"), pin(4, "4", "GND"), pin(5, "5", "NC_U1_5"), pin(6, "6", "NC_U1_6"), pin(7, "7", "NC_U1_7"), pin(8, "8", "V5")]),
  comp("u1b", "U1", "Op-amp", [pin(1, "1", "NC_U1_1"), pin(2, "2", "NC_U1_2"), pin(3, "3", "NC_U1_3"), pin(4, "4", "GND"), pin(5, "5", "MID"), pin(6, "6", "OUT"), pin(7, "7", "OUT"), pin(8, "8", "V5")]),
  comp("rf", "R1", "10k", [pin(1, "1", "MID"), pin(2, "2", "FB1")]), comp("rg", "R2", "10k", [pin(1, "1", "FB1"), pin(2, "2", "GND")]),
  comp("u2", "U2", "LDO", [pin(1, "1", "VIN"), pin(2, "2", "GND"), pin(3, "3", "NC_U2_3"), pin(5, "5", "V3")]),
  comp("rl", "R3", "33", [pin(1, "1", "V3"), pin(2, "2", "GND")]),
  comp("c3", "C3", "1u", [pin(1, "1", "V3"), pin(2, "2", "GND")]),
  comp("q1", "Q1", "N-channel", [pin(1, "1", "V3"), pin(2, "2", "GND"), pin(3, "3", "DRN")]),
  comp("rd", "R4", "1k", [pin(1, "1", "V5"), pin(2, "2", "DRN")]),
  comp("u3", "U3", "NOT", [pin(2, "2", "DRN"), pin(3, "3", "GND"), pin(4, "4", "INV"), pin(5, "5", "V3")]),
  comp("u4", "U4", "NOR", [pin(1, "1", "V3"), pin(4, "4", "GND"), pin(8, "8", "V3")]),
  comp("s1", "SW1", "SPST", [pin(1, "1", "V5"), pin(2, "2", "SWN")]), comp("rs", "R5", "1k", [pin(1, "1", "SWN"), pin(2, "2", "GND")]),
  comp("u5", "U5", "LM321", [pin(1, "+IN", "SIG"), pin(3, "-IN", "B5"), pin(4, "OUT", "B5"), pin(5, "V+", "V5"), pin(2, "V-", "GND")]),
  comp("j1", "J1", "Header", [pin(1, "1", "V5"), pin(2, "2", "GND")]),
  comp("y1", "Y1", "16 MHz", [pin(1, "1", "XI"), pin(2, "2", "XO")])
]};
const parts = [
  {id: "v1", ref: "V1"}, {id: "vs", ref: "V2", parameters: {DC: "1"}},
  {id: "u1a", ref: "U1", def: "ph-opamp2", parameters: {GBW: "1 MHz", "Rail-to-rail": "Input and output", Supply: "5 V"}}, {id: "u1b", ref: "U1", def: "ph-opamp2"},
  {id: "u2", ref: "U2", def: "ph-ldo", parameters: {Vout: "3.3 V", Iout: "300 mA"}}, {id: "q1", ref: "Q1", def: "ph-nmos", parameters: {"Rds(on)": "50 mΩ"}},
  {id: "u3", ref: "U3", def: "ph-not"}, {id: "u4", ref: "U4", def: "ph-ram"}, {id: "s1", ref: "SW1", def: "ph-sw"}, {id: "u5", ref: "U5", def: "lm"}
];
{
  const out = X.exportNetlist({title: "Placeholders", netlist, parts, defs});
  const row = ref => out.coverage.rows.find(r => r.ref === ref), line = ref => out.elements.filter(e => e.ref === ref).map(e => e.line);
  // The dual op-amp: one instance per unit, power shared, node order from pin.fn.
  const u1 = line("U1");
  assert.equal(u1.length, 2);
  assert.match(u1[0], /^XU1_A SIG FB1 MID V5 0 ATR_OPAMP_\w+$/); assert.match(u1[1], /^XU1_B MID OUT OUT V5 0 ATR_OPAMP_\w+$/);
  assert.equal(row("U1").rung, "Fitted", "every required field typed on the placeholder (user sketch values)");
  assert.equal(row("U1").units, 2); assert.equal(row("U1").placeholder, "opamp");
  assert.match(line("U2")[0], /^XU2 VIN V3 0 ATR_LDO_\w+$/, "EN unconnected: tied to VIN");
  assert.equal(row("U2").rung, "Generic", "Vdo is a Waffle default"); assert.ok(row("U2").defaultFields.includes("Vdo"));
  assert.ok(row("U2").notes.some(n => /EN not connected: tied to VIN/.test(n)));
  assert.match(line("Q1")[0], /^XQ1 DRN V3 0 ATR_MOSFET_\w+$/, "drain, gate, source by function");
  assert.match(line("U3")[0], /^XU3 DRN INV V3 0 ATR_LOGIC_\w+$/);
  assert.equal(row("U4").rung, "Load-only"); assert.match(line("U4")[0], /^XU4 V3 0 ATR_LOAD_\w+$/);
  assert.match(line("SW1")[0], /^XSW1 V5 SWN ATR_SWITCH_\w+$/);
  // A real part without a model: Missing, with the category inferred from its pin names.
  assert.equal(row("U5").rung, "Missing"); assert.equal(row("U5").suggest, "opamp");
  assert.equal(row("Y1").rung, "Missing"); assert.equal(row("Y1").suggest, "crystal");
  assert.equal(row("J1").rung, "Excluded");
  assert.match(out.text, /^\* U1: Fitted opamp@1 .*from placeholder$/m);
  assert.match(out.text, /^\*   Rout = 50 Ω \(Waffle default\)$/m, "defaults are named in the netlist");
  assert.match(out.text, /^\* U5 omitted \(Missing\): /m);
  // The netlist simulates: unity-gain follower then a ×2 stage; the LDO regulates into 33 Ω;
  // the MOSFET pulls DRN low, so the inverter's output is high; the switch is open.
  const r = S.simulate(out.text, {type: "op"});
  close(r.nodes.MID, 2, 1e-3, "U1A follower"); close(r.nodes.OUT, 2, 2e-3, "U1B follower of MID");
  close(r.nodes.V3, 3.3, 0.01, "LDO output into 100 mA");
  assert.ok(r.nodes.DRN < 0.1, "N-MOSFET on: " + r.nodes.DRN); close(r.nodes.INV, 3.3, 0.01, "NOT of low is high");
  assert.ok(Math.abs(r.nodes.SWN) < 1e-4, "open switch");
  // A 5 V supply current: the LDO's 100 mA load plus Iq terms come from VIN.
  assert.ok(-r.currents.V1 > 0.1 && -r.currents.V1 < 0.11, "LDO draws its load from VIN: " + r.currents.V1);
  // Without the pin functions (an older placeholder build), the placeholder is still mapped by name or is reported.
  const plain = X.exportNetlist({netlist, parts, defs: defs.map(d => ({...d, pins: undefined}))});
  assert.ok(["Missing", "Fitted", "Generic"].includes(plain.coverage.rows.find(x => x.ref === "U1").rung));

  // "Use generic" for the Missing parts (stored by the extension as assignments), and exclude with a reason.
  const assign = {
    "part:u5": {template: "opamp@1", params: M.fromPart("opamp", netlist.components.at(-3), defs.at(-1), {})},
    "part:y1": {template: "crystal@1", params: M.fromPart("crystal", netlist.components.at(-1), {}, {})},
    "part:j1": {exclude: "board connector: a port in a bench later"},
    "part:s1": {template: "switch@1", params: {State: "closed"}}
  };
  const out2 = X.exportNetlist({netlist, parts, defs, assign});
  const row2 = ref => out2.coverage.rows.find(x => x.ref === ref);
  assert.equal(row2("U5").rung, "Generic"); assert.match(out2.elements.find(e => e.ref === "U5").line, /^XU5 SIG B5 B5 V5 0 ATR_OPAMP_/);
  assert.equal(row2("Y1").rung, "Generic"); assert.equal(M.values(T.crystal, assign["part:y1"].params).vals.f, 16e6, "the part value gives f");
  assert.equal(row2("J1").rung, "Excluded"); assert.match(out2.text, /^\* J1 omitted \(Excluded\): board connector/m);
  const r2 = S.simulate(out2.text, {type: "op"});
  close(r2.nodes.B5, 1, 1e-3, "U5 follower"); close(r2.nodes.SWN, 5 * 1000 / 1000.05, 1e-4, "closed switch");
  assert.equal(out2.coverage.counts.Missing || 0, 0);
  // Assignments in the doc's data shape (part.sim / def.sim) work the same way.
  const viaSim = X.exportNetlist({netlist, parts: parts.map(p => (p.id === "u5" ? {...p, sim: {model: {kind: "template", id: "opamp-ideal@1"}}} : p)), defs});
  assert.equal(viaSim.coverage.rows.find(x => x.ref === "U5").rung, "Ideal");
  // A template version this build lacks is reported, not guessed.
  const bad = X.exportNetlist({netlist, parts, defs, assign: {"part:u5": {template: "opamp@9"}}});
  assert.match(bad.coverage.rows.find(x => x.ref === "U5").reason, /opamp@9 is not in this Waffle/);
  // Legacy Spice parameters on the part win over the placeholder template.
  const legacy = X.exportNetlist({netlist, parts: parts.map(p => (p.id === "u2" ? {...p, parameters: {"Spice.Exclude": "1"}} : p)), defs});
  assert.equal(legacy.coverage.rows.find(x => x.ref === "U2").rung, "Excluded");
  console.log("PASS netlister: placeholders by pin.fn (2 units), Use generic, exclude, sim records, versions");
}
// Coverage budget: 500 parts.
{
  const comps = [], ps = [];
  for (let i = 0; i < 500; i++) {
    const k = i % 4;
    comps.push(k === 0 ? comp("r" + i, "R" + i, "1k", [pin(1, "1", "N" + i), pin(2, "2", "N" + (i + 1))]) : k === 1 ? comp("c" + i, "C" + i, "1n", [pin(1, "1", "N" + i), pin(2, "2", "GND")])
      : k === 2 ? comp("u" + i, "U" + i, "Op-amp", [pin(1, "1", "N" + i), pin(2, "2", "N" + i), pin(3, "3", "N" + (i - 1)), pin(4, "4", "GND"), pin(8, "8", "V5")]) : comp("j" + i, "J" + i, "Header", [pin(1, "1", "N" + i)]));
    if (k === 2) ps.push({id: "u" + i, ref: "U" + i, def: "ph-opamp2"});
  }
  X.exportNetlist({netlist: {components: comps}, parts: ps, defs});
  const t0 = Date.now();
  const out = X.exportNetlist({netlist: {components: comps}, parts: ps, defs});
  const ms = Date.now() - t0;
  assert.equal(out.coverage.total, 500);
  assert.ok(ms < 250, "coverage of 500 parts took " + ms + " ms");
  console.log("PASS coverage of 500 parts in " + ms + " ms");
}
console.log("spice-models tests passed");
