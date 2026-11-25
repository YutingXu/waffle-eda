"use strict";
// Autorouter engine v2 and fanout v2. Run: scripts/test-jsc.sh autorouter-v2 (or node tests/pcb/autorouter-v2.cjs)
const assert = require("node:assert/strict");
for (const f of ["stackup", "viastack", "length-tuning", "router", "diffpair"]) { try { require(require("../support/app-source-paths.cjs").appFile(f + ".js")); } catch { /* optional */ } }
const H = require("./autorouter.cjs");
require("../../app/pcb/fanout.js");
require("../../app/checks/query.js");
require("../../app/pcb/hdi.js");
require("../../app/pcb/autorouter-v2.js");
require("./autorouter-bench-boards.js");
const A = globalThis.Atrium, AR = globalThis.AtriumAutorouter, V2 = globalThis.AtriumAutorouterV2, F = globalThis.AtriumFanout, C = globalThis.AtriumConnectivity, B = globalThis.AtriumBenchBoards;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const tests = [];
const test = (name, fn) => tests.push({name, fn});
const sample = () => { const p = AtriumParts.example(), b = p.documents[1], defs = new Map(p.library.map(d => [d.id, d])); return {p, b, defs}; };
function applyCheck(d, defs, plan, project) {
  const before = new Set(d.items.map(i => i.id)), shorts0 = C.inspect(d, defs).shorts.length;
  V2.applyPlan(d, plan);
  const fresh = new Set(d.items.filter(i => !before.has(i.id)).map(i => i.id));
  const conn = C.inspect(d, defs);
  return {fresh, violations: H.clearanceViolations(d, defs, fresh, project), outside: H.outsideOutline(d, fresh, 0), shorts: conn.shorts.length - shorts0, airwires: conn.airwires.length};
}
// Drilled holes closer than the hole-to-hole gap (vias of the plan against every hole).
function holeViolations(d, defs, fresh, gap) {
  const holes = [];
  for (const i of d.items) {
    if (i.kind === "via" && i.drill > 0) holes.push({x: i.x, y: i.y, r: i.drill / 2, id: i.id, fresh: fresh.has(i.id), from: i.fromLayer, to: i.toLayer});
    if (i.kind === "part") for (const p of defs.get(i.def)?.footprint?.pads || []) if (p.drill > 0) { const c = A.world([p.x, p.y], i); holes.push({x: c[0], y: c[1], r: p.drill / 2}); }
  }
  const out = [];
  for (let i = 0; i < holes.length; i++) for (let j = i + 1; j < holes.length; j++) {
    const a = holes[i], b = holes[j];
    if (!a.fresh && !b.fresh) continue;
    if (a.from && b.from && a.from !== b.from && a.to !== b.to) continue; // stacked microvias in different dielectrics
    if (Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r + gap - 1e-6) out.push([a.id, b.id]);
  }
  return out;
}

test("routes the sample completely as a proposal: DRC clean, existing copper untouched", () => {
  const {p, b, defs} = sample();
  const keep = b.items.filter(i => i.kind === "track" && i.net === "VIN");
  b.items = b.items.filter(i => !(i.kind === "track" || i.kind === "via") || i.net === "VIN");
  const snapshot = JSON.stringify(keep);
  const total = C.inspect(b, defs).airwires.length;
  const plan = V2.routeBoard(b, defs, {project: p});
  assert.equal(plan.report.engine, "v2");
  assert.equal(plan.report.proposal, true);
  assert.equal(plan.remove.length, 0);
  for (const item of plan.add) assert.ok(["track", "via"].includes(item.kind) && item.id && item.net);
  assert.ok(!plan.add.some(i => i.net === "VIN"));
  const r = applyCheck(b, defs, plan, p);
  assert.equal(plan.report.routed, total);
  assert.deepEqual(r.violations, []); assert.deepEqual(r.outside, []); assert.equal(r.shorts, 0); assert.equal(r.airwires, 0);
  assert.equal(JSON.stringify(b.items.filter(i => keep.some(k => k.id === i.id))), snapshot);
  // Quality: every segment at 0/45/90 degrees, no acute corners; the change list names each net.
  assert.equal(plan.report.quality.oct45, 1);
  assert.equal(plan.report.quality.acute, 0);
  assert.ok(plan.report.changes.length > 0 && plan.report.changes.every(c => c.net));
  A.validate(p);
});
test("rank complete two-terminal alternatives around fixed copper before presenting the proposal", () => {
  const d = A.sheet("pcb", "Two-layer obstacle board");
  d.outline = [[0, 0], [22, 0], [22, 18], [0, 18]];
  d.rules = AtriumRules.create();
  const defs = new Map([["pin", {id: "pin", footprint: {shapes: [], pads: [{number: "1", x: 0, y: 0, w: .5, h: .5, drill: .2, shape: "round", angle: 0}]}}]]);
  const pins = [[3,14],[17.5,13],[3.5,11],[19,7.5],[2,4],[18.5,13],[4,11.5],[18.5,15],[2.5,6],[16,6.5]];
  for (const [i, [x, y]] of pins.entries()) d.items.push({id: "p" + i, kind: "part", ref: "J" + i, def: "pin", x, y, angle: 0, layer: "Top", pinNets: {1: "N" + Math.floor(i / 2)}});
  const walls = [[[10,3.5],[9,13]],[[9,5.5],[11,15.5]],[[11.5,8],[7.5,13]],[[8.5,3],[8,12.5]],[[8,6],[10.5,10]],[[9,6.5],[8.5,13]]];
  for (const [i, points] of walls.entries()) d.items.push({id: "wall" + i, kind: "track", net: "BLOCK", width: .4, layer: i % 3 ? "Top" : "Bottom", locked: true, points});
  const before = JSON.stringify(d.items);
  const plan = V2.routeBoard(d, defs, {layers: ["Top", "Bottom"], router: {viaCost: 4}, fanout: false, tune: false});
  assert.equal(before, JSON.stringify(d.items), "preview preserves original copper");
  assert.equal(plan.report.routed, 7);
  assert.equal(plan.report.vias, 2);
  assert.ok(plan.report.length < 91, "previous single path used 95.599 mm");
  assert.ok(plan.report.directConnections.shorterMm > 5.5);
  const result = applyCheck(d, defs, plan);
  assert.equal(result.airwires, 0);
  assert.equal(result.shorts, 0);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(AtriumRules.drc(d, defs, d.rules, {types: ["clearance"]}).violations, []);
});

test("locked copper and fixed nets are never touched", () => {
  const {p, b, defs} = sample();
  const locked = b.items.find(i => i.kind === "track" && i.net === "VIN");
  locked.locked = true;
  const fixedNet = b.items.find(i => i.kind === "track" && i.net && i.net !== "VIN")?.net;
  const plan = V2.routeBoard(b, defs, {project: p, lockPreroutes: false, fixedNets: [fixedNet]});
  assert.ok(!plan.remove.includes(locked.id));
  assert.ok(!plan.remove.some(id => b.items.find(i => i.id === id)?.net === fixedNet), "fixed net copper is not ripped up");
  assert.ok(!plan.add.some(i => i.net === fixedNet), "fixed net is not routed");
  const r = applyCheck(b, defs, plan, p);
  assert.ok(b.items.includes(locked));
  assert.deepEqual(r.violations, []); assert.equal(r.shorts, 0);
});
test("vias keep the hole-to-hole clearance (v1 and v2)", () => {
  for (const engine of ["v1", "v2"]) {
    const {d, defs} = H.routingBoard({seed: 2, ics: 6, passives: 50});
    const before = new Set(d.items.map(i => i.id));
    const opts = {layers: ["Top", "Inner 1", "Inner 2", "Bottom"]};
    const plan = engine === "v1" ? AR.routeBoard(d, defs, opts) : V2.routeBoard(d, defs, opts);
    V2.applyPlan(d, plan);
    const fresh = new Set(d.items.filter(i => !before.has(i.id)).map(i => i.id));
    const gap = AtriumRules.query(d, "holeToHole", {})?.gap ?? 0.254;
    assert.deepEqual(holeViolations(d, defs, fresh, gap), [], engine);
    assert.deepEqual(H.clearanceViolations(d, defs, fresh), [], engine);
  }
});
test("v2 uses fewer vias than v1 on a dense QFN board, with the same completion", () => {
  const r1 = (() => { const b = B.synthetic.qfn48(); const plan = AR.routeBoard(b.d, b.defs, {layers: b.layers}); return {plan, ...applyCheck(b.d, b.defs, plan)}; })();
  const r2 = (() => { const b = B.synthetic.qfn48(); const plan = V2.routeBoard(b.d, b.defs, {layers: b.layers}); return {plan, ...applyCheck(b.d, b.defs, plan)}; })();
  console.log("    QFN-48: v1 " + r1.plan.report.routed + "/" + r1.plan.report.total + " vias " + r1.plan.report.vias + " · v2 " + r2.plan.report.routed + "/" + r2.plan.report.total + " vias " + r2.plan.report.vias);
  assert.ok(r2.plan.report.routed >= r1.plan.report.routed);
  assert.ok(r2.plan.report.vias < r1.plan.report.vias);
  assert.deepEqual(r2.violations, []); assert.ok(r2.shorts <= 0);
});
test("differential pairs stay coupled and clean under v2", () => {
  const {d, defs} = H.pairBoard();
  const plan = V2.routeBoard(d, defs, {});
  assert.equal(plan.report.routed, plan.report.total);
  for (const pr of plan.report.pairs) assert.ok(pr.coupled > 0.7, pr.positive + " " + pr.coupled);
  const r = applyCheck(d, defs, plan);
  assert.deepEqual(r.violations, []);
  const drc = AtriumRules.drc(d, defs, d.rules, {}).violations.filter(v => v.type === "diffPairsRouting" || v.type === "clearance");
  assert.deepEqual(drc.map(v => v.type + " " + v.title), []);
});
test("matched-length groups are tuned after routing", () => {
  if (!globalThis.AtriumLength) return;
  const b = B.synthetic.membus();
  const plan = V2.routeBoard(b.d, b.defs, {layers: b.layers, lengthGroups: b.groups});
  assert.ok(plan.report.tuning && plan.report.tuning.nets > 0, JSON.stringify(plan.report.tuning));
  const r = applyCheck(b.d, b.defs, plan);
  assert.deepEqual(r.violations, []); assert.equal(r.shorts, 0);
  const dq = AtriumLength.evaluate(b.d, b.defs).find(g => g.key === "group:DQ");
  assert.ok(dq.spread <= 1, "DQ spread " + dq.spread);
});
test("routing core reports landed routes for live drawing", () => {
  const {p, b, defs} = sample();
  b.items = b.items.filter(i => i.kind !== "track" && i.kind !== "via");
  const prep = AR.prepare(b, defs, {project: p, router: {live: true}});
  const it = AR.core.route(prep.job);
  let landed = 0;
  for (let s = it.next(); !s.done; s = it.next()) for (const d of s.value.landed || []) { assert.ok(Array.isArray(d.segs) && Array.isArray(d.vias)); landed++; }
  assert.ok(landed > 0);
  // The worker merges deltas of progress events it does not post.
  const posted = [], scope = {postMessage: m => posted.push(m)};
  AR.AtriumRouteServe(scope, AR.core);
  scope.onmessage({data: {type: "route", id: 1, job: AR.prepare(b, defs, {project: p, router: {live: true}}).job}});
  assert.equal(posted.at(-1).type, "result");
});

// ------------------------------------------------------------------ fanout v2
test("fanout v2: BGA ring-by-ring escape layers, plane vias, preferred layers", () => {
  const b = B.synthetic["bga256-6L"]();
  const u = b.d.items.find(i => i.ref === "U1");
  const f = F.planV2(b.d, b.defs, {components: [u.id], layers: b.layers});
  const comp = f.report.components[0];
  assert.equal(comp.kind, "bga");
  assert.deepEqual(comp.escape.rings.slice(0, 3).map(r => r.layer), ["Top", "Top", "Inner 1"]);
  assert.ok(f.report.powerVias > 0, "power balls get plane vias");
  assert.ok(Object.values(f.report.prefLayers).includes("Inner 1"));
  assert.equal(f.report.microvias, 0, "no microvias without an HDI build-up");
  const r = applyCheck(b.d, b.defs, f);
  assert.deepEqual(r.violations, []); assert.equal(r.shorts, 0);
});
test("fanout v2 on an HDI board: via-in-pad microvias, stacked within the limit, else staggered", () => {
  for (const stacking of [undefined, "staggered"]) {
    const b = B.synthetic["bga256-6L"]();
    b.d.items.push({id: "in4", kind: "track", layer: "Inner 4", width: 0.1, points: [[1, 1], [1.5, 1]], net: ""});
    b.d.hdi = {version: 1, top: 2, bottom: 2, ...(stacking ? {stacking} : {}), microvia: {diameter: 0.25, drill: 0.1}};
    const u = b.d.items.find(i => i.ref === "U1");
    const project = {documents:[b.d],library:[...b.defs.values()]};
    const options = {components:[u.id],layers:["Top","Inner 2","Inner 3","Bottom"],project};
    assert.equal(F.planV2(b.d,b.defs,options).report.microvias,0, "the original broad rules exclude the specified laser drill");
    AtriumHDI.addRules(b.d,project,b.defs);
    const f = F.planV2(b.d, b.defs, options);
    const sized = AtriumRules.drc({...b.d,items:[...b.d.items,...f.add]},b.defs,AtriumRules.stored(b.d,project),{project,types:["viaStyle","annularRing","holeSize"]});
    const added = new Set(f.add.map(i=>i.id));
    assert.deepEqual(sized.violations.filter(v=>added.has(v.id)),[]);
    const rep = f.report;
    assert.ok(rep.microvias > 0 && rep.viaInPad > 0, JSON.stringify({m: rep.microvias, v: rep.viaInPad}));
    if (stacking) assert.ok(rep.staggered > 0 && !rep.stacks); else assert.ok(rep.stacks > 0 && !rep.staggered);
    const micro = f.add.filter(i => i.microvia);
    assert.ok(micro.every(v => v.fromLayer && v.toLayer && v.diameter === 0.25 && v.drill === 0.1));
    const r = applyCheck(b.d, b.defs, f);
    assert.deepEqual(r.violations, []); assert.equal(r.shorts, 0);
  }
});
test("fanout v2: differential pair balls get mirrored dog-bones", () => {
  const b = B.synthetic["bga256-4L"]();
  const u = b.d.items.find(i => i.ref === "U1"), def = b.defs.get(u.def);
  // Two adjacent ring-3 balls in one row become a pair.
  const pads = F.partPads(u, def), ring3 = pads.filter(p => /^S/.test(p.net) && Math.abs(p.ly + 0.8 * 3.5) < 0.01).sort((a, c) => a.lx - c.lx);
  const k = ring3.findIndex((q, i) => i + 1 < ring3.length && q.lx > -4.5 && q.lx < -1 && Math.abs(ring3[i + 1].lx - q.lx - 0.8) < 0.01);
  assert.ok(k >= 0, "two adjacent signal balls");
  const [a, c] = [ring3[k], ring3[k + 1]];
  b.d.rules.diffPairs = [{name: "DP", positive: a.net, negative: c.net}];
  const f = F.planV2(b.d, b.defs, {components: [u.id], layers: b.layers});
  const via = n => f.add.find(i => i.kind === "via" && i.net === n);
  const va = via(a.net), vc = via(c.net);
  assert.ok(va && vc);
  // Mirror image about the vertical axis between the two balls.
  const mid = (a.at[0] + c.at[0]) / 2;
  assert.ok(Math.abs((va.x - mid) + (vc.x - mid)) < 1e-6 && Math.abs(va.y - vc.y) < 1e-6, JSON.stringify([va.x, va.y, vc.x, vc.y, mid]));
});
test("fanout v2 thermal vias in a QFN exposed pad", () => {
  const b = B.synthetic.qfn48();
  b.d.items.push({id: "in1", kind: "track", layer: "Inner 1", width: 0.1, points: [[1, 1], [1.5, 1]], net: ""});
  const u = b.d.items.find(i => i.ref === "U1");
  const f = F.planV2(b.d, b.defs, {components: [u.id]});
  assert.ok(f.report.thermal > 0, "exposed GND pad gets a thermal via array");
  const r = applyCheck(b.d, b.defs, f);
  assert.deepEqual(r.violations, []); assert.equal(r.shorts, 0);
});

let failed = 0;
for (const t of tests) {
  try { const s = now(); t.fn(); console.log("ok   " + t.name + " (" + (now() - s).toFixed(0) + " ms)"); }
  catch (error) { failed++; console.log("FAIL " + t.name + "\n" + (error && error.stack || error)); }
}
console.log(tests.length - failed + "/" + tests.length + " autorouter v2 tests passed");
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " autorouter v2 test" + (failed === 1 ? "" : "s") + " failed"); }
