"use strict";
// IPC-2152 current capacity (app/analysis/ipc2152.js): the chart fits against NinjaCalc's published worked
// example, the Brooks & Adam and IPC-2221 closed forms at well-known points, round trips of the
// width ↔ current ↔ rise solver, via barrels, the direction of every modifier, and the
// Current Capacity design rule (positive and negative cases, PDN-driven currents).
const assert = require("node:assert/strict");
for (const m of ["model", "stackup", "pcb-pours", "pdn", "rules", "ipc2152"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const C = AtriumIPC2152, R = AtriumRules, S = AtriumStackup, P = AtriumPDN, MIL = .0254, UM2 = 1e6 * MIL * MIL;
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);
const near = (a, b, tol, m) => assert.ok(rel(a, b) <= tol, (m || "") + ": " + a + " vs " + b + " (" + (rel(a, b) * 100).toFixed(3) + " %)");
const log = s => globalThis.print ? print(s) : console.log(s);

// ---- 1. the chart fits at NinjaCalc's published example (blog.mbedded.ninja, "How To Calculate
// Maximum Track Current"): 1 A, 40 °C rise, 1 oz, 1.6 mm board, plane 1.6 mm away, k 0.2 W/m·K →
// unadjusted 3361 µm², modifiers 0.903 · 1.092 · 0.602 · 1.032, adjusted 2058 µm², width 0.05880 mm.
{
  near(C.chartArea(1, 40) * UM2, 3361, .003, "universal chart area (1 A, 40 °C)");
  const m = C.modifiers({oz: 1, current: 1, board: 1.6, plane: 1.6, k: .2});
  near(m.copper, .903, .001, "copper-weight modifier"); near(m.board, 1.092, .001, "board-thickness modifier");
  near(m.plane, .602, .001, "plane modifier"); near(m.conductivity, 1.032, .001, "conductivity modifier");
  const r = C.conductor({current: 1, rise: 40, thickness: .035, board: 1.6, plane: 1.6, k: .2, method: "ipc2152"});
  near(r.area * 1e6, 2058, .003, "adjusted area"); near(r.width, .0588, .003, "width");
  assert.equal(r.warnings.length, 0);
  log("IPC-2152 chart (NinjaCalc example): area " + (C.chartArea(1, 40) * UM2).toFixed(0) + " µm² (3361), modifiers " + [m.copper, m.board, m.plane, m.conductivity].map(x => x.toFixed(3)).join(" · ") +
    " (0.903 · 1.092 · 0.602 · 1.032), width " + r.width.toFixed(5) + " mm (0.05880)");
  // 3 oz in a 1.78 mm (70 mil) board without a plane at k ≈ 0.2 is the chart's own baseline: modifiers ≈ 1.
  const b = C.modifiers({oz: 3, current: 1, board: 70 * MIL, plane: 0, k: .2});
  near(b.copper, 1, .002, "baseline copper"); near(b.board, 1, .02, "baseline board"); assert.equal(b.plane, 1);
}
// ---- 2. closed forms at well-known points
{
  // IPC-2221 external, 1 A, 10 °C, 1 oz: 11.8 mil (the long-quoted chart value), internal twice the area.
  const ext = C.conductor({current: 1, rise: 10, thickness: .035, method: "ipc2221"}), int = C.conductor({current: 1, rise: 10, thickness: .035, internal: true, method: "ipc2221"});
  near(ext.width / MIL, 11.8, .01, "IPC-2221 external 1 A 10 °C");
  near(int.area / ext.area, Math.pow(2, 1 / .725), 1e-9, "IPC-2221 internal factor");
  // Brooks & Adam external: ΔT = 215.3·I²·W^-1.15·Th^-1 at 1 A, 1 oz, 10 °C → 10.92 mil (as KiCad).
  const ba = C.conductor({current: 1, rise: 10, thickness: .035, method: "brooksAdam"});
  near(ba.width / MIL, Math.pow(10 / (215.3 / (.035 / MIL)), 1 / -1.15), 1e-9, "Brooks & Adam closed form");
  near(ba.width / MIL, 10.92, .005, "Brooks & Adam 1 A 10 °C 1 oz");
  // The three methods agree within about a factor of two at modest currents (10–30 °C, ≤ 3 A, 1 oz external; at 10 A IPC-2221 asks for less than half the IPC-2152 width).
  for (const I of [.5, 1, 3]) for (const dT of [10, 20, 30]) {
    const w = Object.values(C.compare({current: I, rise: dT, thickness: .035, board: 1.6})).map(x => x.width);
    assert.ok(Math.max(...w) / Math.min(...w) < 2.2, "methods agree at " + I + " A " + dT + " °C: " + w.map(x => x.toFixed(3)).join(", "));
  }
  // IPC-2152 lets inner layers carry far more than IPC-2221's halved inner chart.
  const i52 = C.conductor({width: 1, rise: 10, thickness: .035, internal: true, board: 1.6, method: "ipc2152"}).current, i21 = C.conductor({width: 1, rise: 10, thickness: .035, internal: true, method: "ipc2221"}).current;
  assert.ok(i52 > 1.4 * i21, "inner layer: IPC-2152 " + i52.toFixed(2) + " A vs IPC-2221 " + i21.toFixed(2) + " A");
  log("closed forms: IPC-2221 " + (ext.width / MIL).toFixed(2) + " mil (11.8), Brooks & Adam " + (ba.width / MIL).toFixed(2) + " mil (10.92); 1 mm inner track at 10 °C: IPC-2152 " + i52.toFixed(2) + " A, IPC-2221 " + i21.toFixed(2) + " A");
}
// ---- 3. round trips and modifier directions
for (const method of Object.keys(C.METHODS)) for (const internal of [false, true]) {
  const base = {thickness: .035, internal, board: 1.6, plane: .4, k: .25, method};
  const w = C.conductor({...base, current: 2.5, rise: 20}).width;
  near(C.conductor({...base, width: w, rise: 20}).current, 2.5, 1e-6, method + " current from width");
  near(C.conductor({...base, width: w, current: 2.5}).rise, 20, 1e-6, method + " rise from width");
}
{
  const at = o => C.conductor({current: 3, rise: 20, thickness: .035, board: 1.6, plane: 0, k: .2, method: "ipc2152", ...o}).width;
  assert.ok(at({plane: .5}) < at({}), "a plane nearby lets the track be narrower");
  assert.ok(at({plane: .3}) < at({plane: 1.5}), "a closer plane helps more");
  assert.ok(at({board: 2.3}) < at({board: .8}), "a thicker board spreads more heat");
  assert.ok(at({k: .33}) < at({k: .19}), "a more conductive board helps");
  assert.ok(at({thickness: .070}) < at({thickness: .035}), "2 oz is narrower than 1 oz");
  assert.ok(C.conductor({current: 3, rise: 20, thickness: .035, board: 5}).warnings.some(w => /board-thickness/.test(w)), "out-of-range board is clamped with a warning");
}
// ---- 4. vias: plated barrel π(d + t)t
{
  const v = C.via({drill: .3, plating: .025, rise: 10, method: "ipc2221"});
  near(v.area, Math.PI * .325 * .025, 1e-12, "barrel area");
  near(v.current, .048 * Math.pow(10, .44) * Math.pow(v.area / (MIL * MIL), .725), 1e-12, "IPC-2221 via");
  const c = C.via({drill: .3, plating: .025, rise: 10});
  near(C.chartArea(c.current, 10), v.area / (MIL * MIL), 1e-6, "IPC-2152 via inverts the chart");
  near(C.via({drill: .3, plating: .025, current: c.current}).rise, 10, 1e-6, "via rise at its capacity");
  assert.ok(C.via({drill: .5, rise: 10}).current > c.current, "a bigger hole carries more");
  log("via 0.3 mm / 25 µm at 10 °C: IPC-2152 " + c.current.toFixed(2) + " A, IPC-2221 " + v.current.toFixed(2) + " A");
  // Non-default hole. Pitch is not an input: 0.35×1.27 mm and 1.27×0.35 mm are the same barrel.
  const drill = .8, tp = .035, rise = 20;
  const annulus = Math.PI * ((drill / 2 + tp) ** 2 - (drill / 2) ** 2);
  const hole = C.via({drill, plating: tp, rise, method: "ipc2221"});
  near(hole.area, annulus, 1e-12, "non-default barrel area");
  near(C.barrelArea(drill, tp), P.core.platedBarrelArea(drill, tp), 1e-15, "IPC barrel area is the PDN barrel");
  near(hole.current, .048 * Math.pow(rise, .44) * Math.pow(annulus / (MIL * MIL), .725), 1e-12, "non-default IPC-2221 current");
  near(hole.current, 6.52816662691, 1e-9, "witness current");
  log("non-default via 0.8 mm / 35 µm at 20 °C: IPC-2221 " + hole.current.toFixed(4) + " A");
}
// ---- 5. the Current Capacity rule: negative (fails) and positive (passes) cases
const pad = (n, x, y, w, h) => ({number: String(n), x, y, w, h, shape: "rect"});
const defs = new Map([["p2", {id: "p2", name: "p2", footprint: {pads: [pad(1, 0, 0, 3, 3)], shapes: []}}]]);
const part = (id, ref, x, y, net) => ({id, kind: "part", ref, def: "p2", value: "", x, y, angle: 0, layer: "Top", pinNets: {1: net}});
const board = (width, extra = []) => ({kind: "pcb", id: "b", name: "B", outline: [[0, 0], [60, 0], [60, 30], [0, 30]], notes: [], stackup: {version: 1, layers: S.build(["Signal", "Signal"]).layers},
  items: [{id: "t1", kind: "track", net: "VBUS", layer: "Top", width, points: [[10, 15], [50, 15]]}, part("j1", "J1", 10, 15, "VBUS"), part("u1", "U1", 50, 15, "VBUS"), ...extra]});
const rules = (props, extra = {}) => {
  const set = R.create();
  set.list.push({id: "cc1", type: "currentCapacity", name: "VBUS_3A", comment: "", enabled: true, priority: 1, scope: AtriumDesignQueryRecord.selector("net", "VBUS"),
    current: 3, maxRise: 10, method: "ipc2152", source: "rule", checkVias: true, checkPads: true, plating: 25, ...props});
  return Object.assign(set, extra);
};
{
  R.validate(rules({}));
  const thin = R.drc(board(.25), defs, rules({}), {types: ["currentCapacity"]}).violations;
  assert.equal(thin.length, 1, "a 0.25 mm track fails 3 A at 10 °C");
  assert.equal(thin[0].id, "t1"); assert.equal(thin[0].type, "currentCapacity");
  assert.ok(thin[0].current.rise > 10 && thin[0].current.allowed < 3 && /raises this 0.25 mm track/.test(thin[0].detail), thin[0].detail);
  const narrowScope = AtriumDesignQueryRecord.create("track where width < 0.3mm");
  assert.deepEqual(R.drc(board(.25), defs, rules({scope:narrowScope}), {types:["currentCapacity"]}).violations.map(v => v.id), ["t1"]);
  assert.deepEqual(R.drc(board(.6), defs, rules({scope:narrowScope}), {types:["currentCapacity"]}).violations, []);
  const wide = R.drc(board(2.5), defs, rules({}), {types: ["currentCapacity"]}).violations;
  assert.equal(wide.length, 0, "a 2.5 mm track passes (pads are 3 mm wide)");
  // A neck: a 2.5 mm track into a 0.6 mm pad.
  defs.set("p2", {id: "p2", name: "p2", footprint: {pads: [pad(1, 0, 0, .6, 3)], shapes: []}});
  const neck = R.drc(board(2.5), defs, rules({}), {types: ["currentCapacity"]}).violations;
  const placedPad = AtriumDesignQueryRecord.create('pad where pin.number = "1" and x > 40mm');
  assert.deepEqual(R.drc(board(2.5),defs,rules({scope:placedPad}),{types:["currentCapacity"]}).violations.map(v=>v.id),["u1"]);
  assert.equal(neck.length, 2, "both 0.6 mm pads are necks"); assert.ok(neck.every(v => /pad \(0.6 mm wide\)/.test(v.detail)));
  assert.equal(R.drc(board(2.5), defs, rules({checkPads: false}), {types: ["currentCapacity"]}).violations.length, 0, "pads off");
  defs.set("p2", {id: "p2", name: "p2", footprint: {pads: [pad(1, 0, 0, 3, 3)], shapes: []}});
  // A via in the path: 0.3 mm barrel cannot take 3 A at 10 °C; a 1 mm hole can.
  const via = d => ({id: "v1", kind: "via", net: "VBUS", x: 30, y: 15, diameter: d + .4, drill: d});
  const smallHoles = AtriumDesignQueryRecord.create("via where hole < 0.4 mm");
  assert.deepEqual(R.drc(board(2.5, [via(.3)]), defs, rules({scope:smallHoles}), {types:["currentCapacity"]}).violations.map(v=>v.id), ["v1"]);
  assert.equal(R.drc(board(2.5, [via(.3)]), defs, rules({}), {types: ["currentCapacity"]}).violations.map(v => v.id).join(), "v1", "small via fails");
  assert.equal(R.drc(board(2.5, [via(1.0)]), defs, rules({}), {types: ["currentCapacity"]}).violations.length, 0, "large via passes");
  // Current from Net currents when the rule's current is 0; a relaxed rise passes the thin track.
  assert.equal(R.drc(board(.25), defs, rules({current: 0}, {netCurrents: {VBUS: 3}}), {types: ["currentCapacity"]}).violations.length, 1, "Net currents");
  assert.equal(R.drc(board(.25), defs, rules({current: 0}), {types: ["currentCapacity"]}).violations.length, 0, "no current, nothing to check");
  const relaxed = C.conductor({width: .25, current: 3, thickness: .035, board: S.thickness(board(.25)), method: "ipc2152"}).rise;
  assert.equal(R.drc(board(.25), defs, rules({maxRise: Math.min(100, Math.ceil(relaxed) + 1)}), {types: ["currentCapacity"]}).violations.length, relaxed < 99 ? 0 : 1, "relaxed rise");
  // Other scopes are untouched.
  assert.equal(R.drc(board(.25), defs, rules({scope: AtriumDesignQueryRecord.selector("net", "OTHER")}), {types: ["currentCapacity"]}).violations.length, 0, "scope");
  // The text summary and the editor field kind.
  assert.match(R.constraintText(rules({}).list.at(-1)), /Current=3A/);
  assert.throws(() => R.validate(rules({current: -1})), /current from 0 to 1000 A/);
  log("Current Capacity rule: 0.25 mm track at 3 A fails (rise " + thin[0].current.rise + " °C, allows " + thin[0].current.allowed + " A); 2.5 mm passes; 0.6 mm pad necks and a 0.3 mm via fail");
}
// ---- 6. PDN-driven: the analysed current per object (only the branch that carries it fails)
{
  const doc = board(.25, [{id: "t2", kind: "track", net: "VBUS", layer: "Top", width: .25, points: [[10, 15], [10, 25], [20, 25]]}, part("u2", "U2", 20, 25, "VBUS")]);
  doc.pdn = P.normalize({nets: [{net: "VBUS", voltage: 5, source: {ref: "J1"}, loads: [{ref: "U1", current: 3}, {ref: "U2", current: .2}]}]});
  const v = R.drc(doc, defs, rules({source: "pdn", current: 0}), {types: ["currentCapacity"]}).violations;
  assert.deepEqual(v.map(x => x.id), ["t1"], "the 3 A branch fails, the 0.2 A branch passes");
  near(v[0].current.actual, 3, 1e-3, "PDN current through t1");
  const chk = C.check(doc, defs, {source: "pdn", max_rise: 10});
  assert.ok(chk.summary.pdn && chk.rows.some(r => r.id === "t2" && r.ok && Math.abs(r.current - .2) < .01), "check rows carry the PDN currents");
  // Without rules, check() uses its options for every net with a current.
  const noRules = {...doc, rules: undefined};
  const ck = C.check(noRules, defs, {currents: {VBUS: 3}, source: "rule", max_rise: 10});
  assert.ok(ck.violations.some(x => x.id === "t1") && ck.summary.checked >= 3);
  const host = {project: () => ({documents: [doc], library: [], rules: null}), board: p => p.documents[0], defsOf: () => defs};
  const mcp = C.headless({source: "pdn", only_failing: true}, host);
  assert.equal(mcp.rows.length, 1); assert.equal(mcp.rows[0].id, "t1"); assert.equal(mcp.rows[0].current_basis, "pdn");
  log("PDN-driven: t1 carries " + v[0].current.actual + " A (fails), t2 0.2 A (passes); check() " + chk.summary.ms + " ms");
}
// Equal physical cross-sections, one in mil² and one in mm², plus the internal/external ratio.
{
  const ext = (aMil2, dT) => .048 * Math.pow(dT, .44) * Math.pow(aMil2, .725);
  for (const [aMil2, dT] of [[120, 10], [480, 25]]) {
    near(C.ipc2221.current(aMil2, dT, false), ext(aMil2, dT), 1e-12, "mil² " + aMil2);
    near(P.ipc2221(aMil2 * MIL * MIL, dT), ext(aMil2, dT), 1e-12, "equal independently calculated physical cross-sections must yield equal current");
    near(C.ipc2221.current(aMil2, dT, true) / C.ipc2221.current(aMil2, dT, false), .5, 1e-12, "internal/external " + aMil2);
  }
  log("IPC-2221 current: 120 and 480 mil² match their mm² sections; internal/external is 1/2");
}
log("ipc2152: ok");
