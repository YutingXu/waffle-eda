"use strict";
// Routing and power-plane proposals (app/pcb/route-planner.js, app/pcb/plane-planner.js), and the
// placement → routing chain with app/pcb/autoplace.js. Run with Node 18+ (node tests/pcb/route-planner.cjs)
// or JavaScriptCore (scripts/test-jsc.sh route-planner).
const assert = require("node:assert/strict");
const H = require("./autorouter.cjs");
require("../../app/pcb/fanout.js");
require("../../app/pcb/stackup.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/pcb/pcb-pours.js");
require("../../app/pcb/polygon-pour.js");
require("../../app/checks/dfa.js");
require("../../app/pcb/rooms.js");
require("../../app/pcb/autoplace.js");
require("../../app/pcb/route-planner.js");
require("../../app/pcb/plane-planner.js");
const A = globalThis.Atrium, AR = globalThis.AtriumAutorouter, C = globalThis.AtriumConnectivity;
const RP = globalThis.AtriumRoutePlanner, PL = globalThis.AtriumPlanePlanner, AP = globalThis.AtriumAutoplace;

const tests = [];
const test = (name, fn) => tests.push({name, fn});
const clone = v => JSON.parse(JSON.stringify(v));

test("classifies nets: power, differential pairs, critical (names and classes), the rest", () => {
  const doc = {kind: "pcb", items: [], rules: {format: "atrium-rules", version: 2, list: [], netClasses: {Fast: ["SPI_MOSI"], Power: ["VMOTOR"]},
    diffPairs: [{name: "USB", positive: "USB_P", negative: "USB_N"}]}};
  const g = RP.classify(new Set(["GND", "+3V3", "VMOTOR", "USB_P", "USB_N", "SYS_CLK", "SPI_MOSI", "LED1", "NET_A"]), doc, null, {critical: ["NET_A"]});
  assert.deepEqual(g.power, ["+3V3", "GND", "VMOTOR"]);
  assert.deepEqual(g.diffpair, ["USB_N", "USB_P"]);
  assert.deepEqual(g.critical, ["NET_A", "SPI_MOSI", "SYS_CLK"]);
  assert.deepEqual(g.other, ["LED1"]);
});

test("routes in priority order and reports every connection", () => {
  const {d, defs} = H.routingBoard({seed: 11, ics: 4, passives: 30, headers: 2});
  const before = C.inspect(d, defs).airwires.length;
  const r = RP.run(d, defs, {timeLimitMs: 20000});
  assert.equal(r.connections, before);
  assert.deepEqual(r.groups.slice(0, 1).map(g => g.group), ["power"], "power nets go first");
  const order = r.groups.map(g => g.group).filter(g => g !== "completion" && g !== "joint");
  assert.deepEqual(order, ["power", "diffpair", "critical", "other"].filter(x => order.includes(x)), "groups stay in priority order");
  assert.equal(r.routed + r.unrouted.length, before);
  assert.ok(r.routed / before > 0.9, r.routed + " of " + before + " routed");
  for (const u of r.unrouted) assert.ok(u.reason && u.net, "unrouted connections carry a reason");
  const fresh = new Set(d.items.filter(i => (i.kind === "track" || i.kind === "via") && !i.locked).map(i => i.id));
  assert.deepEqual(H.clearanceViolations(d, defs, fresh), []);
  assert.deepEqual(C.inspect(d, defs).shorts, []);
  const s = RP.summary(r);
  assert.ok(s.untrusted_design_text.unrouted.length === s.unrouted.length);
  assert.ok(s.unrouted.every(u => !("net" in u)), "net names only under untrusted_design_text");
});

test("nets and classes scope the plan; an unknown class is refused", () => {
  const {d, defs} = H.routingBoard({seed: 12, ics: 3, passives: 20, headers: 1});
  const one = C.inspect(d, defs).airwires.find(a => !/GND|VCC|V\d/.test(a.net)).net;
  const r = RP.run(d, defs, {nets: [one], timeLimitMs: 5000});
  assert.ok(r.connections >= 1);
  assert.ok(C.inspect(d, defs).airwires.every(a => a.net !== one));
  d.rules = d.rules || AtriumRules.create();
  d.rules.netClasses = {Sig: [one]};
  assert.throws(() => RP.run(d, defs, {classes: ["Nope"]}), /no net class Nope/);
  assert.match(RP.run(d, defs, {classes: ["Sig"]}).notes.join(" "), /Nothing to route/);
});

test("BGA fanout runs first on multi-layer boards", () => {
  const {d, defs} = H.routingBoard({seed: 9, bga: true, ics: 4, passives: 20, headers: 1});
  const cands = RP.fanoutCandidates(d, defs, C.inspect(d, defs).airwires, 4);
  assert.ok(cands.some(c => c.kind === "bga"));
  const r = RP.run(d, defs, {layers: ["Top", "Inner 1", "Inner 2", "Bottom"], timeLimitMs: 15000});
  assert.ok(r.fanout && r.fanout.vias > 0, "fanout added vias");
});

test("plane plan: two-layer board gets ground on Bottom, flood and supply pours on Top", () => {
  const {d, defs} = H.routingBoard({seed: 7, ics: 4, passives: 30, headers: 2});
  const p = PL.plan(d, defs, {});
  const gnd = p.assignments.filter(a => a.net === "GND");
  assert.ok(gnd.some(a => a.layer === "Bottom" && a.region === "board"), JSON.stringify(p.assignments.map(a => [a.layer, a.net])));
  assert.ok(p.nets.every(n => n.width > 0 && n.current > 0));
  const made = PL.apply(d, defs, p);
  assert.equal(made.polygons.length, p.assignments.filter(a => !a.exists).length);
  assert.ok(made.regions > 0, "the new pours were poured");
  const again = PL.plan(d, defs, {});
  assert.ok(again.assignments.every(a => a.exists), "a second plan finds the pours in place");
});

test("plane plan: four-layer stack puts ground next to Top and the main supply below it", () => {
  const {d, defs} = H.routingBoard({seed: 7, ics: 4, passives: 30, headers: 2});
  d.stackup = AtriumStackup.preset(4);
  const p = PL.plan(d, defs, {});
  const at = Object.fromEntries(p.assignments.filter(a => a.region === "board").map(a => [a.layer, a.net]));
  assert.equal(at["Inner 1"], "GND");
  assert.ok(at["Inner 2"] && at["Inner 2"] !== "GND", "main supply on Inner 2: " + JSON.stringify(at));
  assert.ok(!at.Top && !at.Bottom, "outer layers stay for signals");
  const forced = PL.plan(d, defs, {stackup: {Bottom: "GND"}, currents: {VCC: 5}});
  assert.ok(forced.assignments.some(a => a.layer === "Bottom" && a.net === "GND"));
  assert.throws(() => PL.plan(d, defs, {stackup: {"Inner 7": "GND"}}), /not a copper layer/);
});

test("IPC track width: wider for more current, IPC-2221 fallback without AtriumCalc", () => {
  const a = PL.trackWidth(1, 10, 0.035, false), b = PL.trackWidth(3, 10, 0.035, false);
  assert.ok(b.width > a.width);
  assert.match(a.method, /IPC-2221/);
  assert.ok(Math.abs(a.width - 0.304) < 0.02, "1 A, 10 °C, 1 oz external ≈ 0.30 mm (IPC-2221): " + a.width);
});

test("place then route: a 30-part design is placed inside the board and fully routed", () => {
  const lib = H.footprints(), defs = new Map(lib.map(x => [x.id, x]));
  const d = A.sheet("pcb", "Chain");
  d.outline = [[0, 0], [70, 0], [70, 50], [0, 50]];
  let n = 0;
  const part = (def, ref, nets) => d.items.push({id: "q" + (++n), kind: "part", def, ref, value: "", x: 90, y: n * 6, angle: 0, pinNets: nets, layer: "Top"});
  for (let i = 1; i <= 3; i++) {
    const nets = {4: "GND", 8: "VCC"};
    for (const k of [1, 2, 3, 5, 6, 7]) nets[k] = "S" + i + "_" + k;
    part("soic8", "U" + i, nets);
    for (let k = 0; k < 6; k++) part("r0603", "R" + (i * 10 + k), {1: "S" + i + "_" + [1, 2, 3, 5, 6, 7][k], 2: k < 3 ? "S" + (i % 3 + 1) + "_" + [5, 6, 7][k] : "GND"});
    part("r0603", "C" + i, {1: "VCC", 2: "GND"});
  }
  for (let j = 1; j <= 2; j++) part("hdr10", "J" + j, {1: "VCC", 2: "GND", 3: "S" + j + "_1", 4: "S" + (j + 1) + "_2"});
  while (d.items.length < 30) part("r0603", "R" + (90 + d.items.length), {1: "VCC", 2: "GND"});
  const project = {name: "Chain", library: lib, documents: [d]};
  const placed = AP.propose(project, d, defs, {seed: 1});
  const best = placed.alternatives[0];
  assert.equal(best.moves.length, 30);
  assert.equal(best.score.overlaps + best.score.outside + best.score.unplaced, 0);
  AP.applyMoves(d, defs, best.moves);
  const r = RP.run(d, defs, {project, timeLimitMs: 30000});
  assert.equal(r.unrouted.length, 0, JSON.stringify(r.unrouted.slice(0, 5)));
  const fresh = new Set(d.items.filter(i => i.kind === "track" || i.kind === "via").map(i => i.id));
  assert.deepEqual(H.clearanceViolations(d, defs, fresh), []);
  assert.deepEqual(C.inspect(d, defs).shorts, []);
  console.log("  chain: " + best.strategy + " airwires " + best.score.wirelength_mm + " mm; routed " + r.routed + "/" + r.connections + " with " + r.tracks + " tracks, " + r.vias + " vias in " + r.ms + " ms");
});

test("headless ops: plan leaves the project; proposal changes the working copy", () => {
  const {d, defs} = H.routingBoard({seed: 13, ics: 3, passives: 16, headers: 1});
  const lib = [...defs.values()], project = {name: "H", library: lib, documents: [d]};
  let work = null, touched = 0;
  const h = {project: () => work || project, mutable: () => (work ||= clone(project)), board: (p, id) => p.documents.find(x => x.kind === "pcb" && (!id || x.id === id)),
    defsOf: p => new Map(p.library.map(x => [x.id, x])), touched: () => touched++};
  const plan = RP.headless({mode: "plan", time_limit_ms: 3000}, h);
  assert.equal(work, null);
  assert.ok(plan.routed > 0);
  const planes = PL.headless({mode: "plan"}, h);
  assert.equal(work, null);
  assert.ok(planes.assignments.length > 0 && planes.untrusted_design_text.assignment_nets.length === planes.assignments.length);
  const made = PL.headless({}, h);
  assert.ok(made.created > 0 && touched === 1);
  assert.ok(work.documents[0].items.some(i => i.kind === "polygon"));
});

let failed = 0;
for (const t of tests) {
  try { t.fn(); console.log("ok   " + t.name); }
  catch (e) { failed++; console.log("FAIL " + t.name + ": " + e.message + "\n" + (e.stack || e)); }
}
if (failed) throw Error(failed + " route-planner test(s) failed");
