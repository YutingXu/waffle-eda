"use strict";
// Three-link gloss, interactive pattern controls and length/delay agreement after commit.
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/analysis/impedance.js");
require("../../app/pcb/stackup.js");
require("../../app/checks/rules.js");
require("../../app/pcb/router.js");
require("../../app/pcb/diffpair.js");
require("../../app/pcb/timing-vision.js");
require("../../app/pcb/length-tuning.js");

const R = AtriumRouter, L = AtriumLength, defs = new Map();
const close = (a, b, tol = 1e-5) => assert.ok(Math.abs(a - b) <= tol, a + " vs " + b);
const length = pts => pts.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
const track = (net, y, len = 30) => ({kind: "track", id: net, layer: "Top", width: .15, net, points: [[0, y], [len, y]]});
const pad = (id, net, x, y, delay = 0) => ({kind: "pad", id, number: id, net, x, y, w: .15, h: .15, shape: "round", layer: "Top", packageLength: 0, pinDelay: delay});
const row = (net, y, len, delay = 0) => [track(net, y, len), pad(net + "a", net, 0, y, delay), pad(net + "b", net, len, y)];
const axisGap = (p, a, b) => {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
};

function glossCorridor(blocked, flip) {
  const at = ([x, y]) => flip ? [12 - y, 30 - x] : [x, y];
  const path = [[0, 0], [2, 0], [5, 3], [5.4, 3], [8.4, 6], [10, 6]].map(at);
  const pins = [[3.5, blocked ? 1.2 : .98], [7.2, blocked ? 5.1 : 5.3], [2, 2], [6, 2], [8.5, 4.5]].map(at);
  const copper = {...track("SIGNAL", 0), width: .1, points: path};
  const board = {kind: "pcb", items: [copper, ...pins.map(([x, y], i) => ({kind: "via", id: "v" + i, net: "OBSTACLE", x, y, diameter: .14, drill: .08}))]};
  const plan = R.gloss(board, defs, {rules: {clearance: .05}, corner: "45"});
  const result = plan.modify[0]?.points || path;
  assert.equal(result.length, blocked ? 6 : 4);
  assert.deepEqual(result[0], path[0]); assert.deepEqual(result.at(-1), path.at(-1));
  assert.ok(length(result) <= length(path) + 1e-7);
  for (let i = 1; i < result.length; i++) {
    const [a, b] = [result[i - 1], result[i]], dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]);
    assert.ok(dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6);
    for (const p of pins) assert.ok(axisGap(p, a, b) >= .05 + .07 + .05 - 1e-7);
  }
}
for (const flip of [false, true]) for (const blocked of [false, true]) glossCorridor(blocked, flip);
console.log("PASS diagonal jog removed in a clear corridor, retained between opposing obstacles");

{
  const seg = {a: [0, 0], b: [20, 0], width: .2};
  const controls = {extra: 9, amplitude: 1, gap: .4, miter: 0};
  const trombone = L.tune(seg, {...controls, style: "trombone"}), accordion = L.tune(seg, {...controls, style: "accordion", sides: 2});
  assert.equal(trombone.excursions, 1); close(trombone.added, 2); close(trombone.amplitude, 1);
  close(trombone.points[3][0] - trombone.points[2][0] - seg.width, controls.gap);
  assert.ok(!trombone.reached); assert.ok(accordion.reached); assert.ok(accordion.excursions > 3);
  close(accordion.amplitude, 1); close(length(accordion.points), 29);
  assert.ok(accordion.points.some(p => p[1] < 0) && accordion.points.some(p => p[1] > 0));
  const mitered = L.tune(seg, {...controls, style: "trombone", miter: 1, gap: .8});
  assert.ok(mitered.points.length > trombone.points.length);
  close(mitered.points[2][0] - mitered.points[1][0], .5);
  const board = {kind: "pcb", items: [track("S", 0, 24)]};
  const s = L.begin(board, defs, {trackId: "S", at: [1, 0], target: 32, ...controls, style: "trombone"});
  close(s.move([20, 2]).result.amplitude, 1);
  const taller = s.set({amplitude: 3});
  close(taller.result.amplitude, 3); close(taller.result.added, 6);
  close(s.key("4").result.pitch, .6, 1e-6); // width .15, leg gap .45
  const bevel = s.key(".");
  assert.ok(bevel.result.points.length > taller.result.points.length);
  assert.equal(s.set({style: "accordion", sides: 2}).gauge.status, "within");
  L.applyPlan(board, s.commit()); close(L.netLength(board, defs, "S").length, 32);
}
console.log("PASS one adjustable trombone and alternating accordion honour amplitude, gap and miter");

function timedBoard() {
  const b = {kind: "pcb", items: [...row("CLK_P", 0, 30, 6), ...row("CLK_N", .4, 30), ...row("REF", 8, 34)], rules: AtriumRules.create()};
  b.rules.diffPairs = [{name: "CLK", positive: "CLK_P", negative: "CLK_N"}];
  const rule = b.rules.list.find(r => r.type === "diffPairsRouting");
  Object.assign(rule, {widthMin: .15, widthPreferred: .15, gapMin: .25, gapPreferred: .25, maxUncoupled: 20});
  b.lengthTuning = {version: 1, groups: [{name: "Clock", members: ["CLK_P", "CLK_N", "REF"], basis: "delay", delayTolerance: .1, pairDelayTolerance: .1}], targets: {}};
  return b;
}
{
  const b = timedBoard(), before = JSON.stringify(b.items), read = () => L.evaluate(b, defs).find(g => g.key === "group:Clock");
  const g = read(), ps = g.longestDelay, odd = AtriumStackup.delay(b, "Top", .15, defs, {gap: .25});
  const single = AtriumStackup.delay(b, "Top", .15, defs);
  assert.ok(odd < single - .02);
  close(L.netLength(b, defs, "CLK_N").delay, 30 * odd);
  const start = L.netLength(b, defs, "CLK_P");
  const session = L.begin(b, defs, {trackId: "CLK_P", at: [1, 0], targetDelay: start.delay + 4 * odd, toleranceDelay: .01, style: "accordion", amplitude: 1});
  close(session.target, start.length + 4); close(session.tolerance, .01 / odd);
  const mv = session.move([29, -2]); close(mv.gauge.delay, start.delay + odd * mv.result.added);
  const group = L.autoTune(b, defs, {keys: [g.key], requireAll: true, style: "accordion", amplitude: 1, gap: .3});
  assert.equal(JSON.stringify(b.items), before, "planning leaves all original copper intact");
  assert.ok(group.plan.modify.some(m => m.id === "CLK_N") && group.plan.modify.some(m => m.id === "CLK_P"));
  assert.deepEqual(group.failed, []);
  const shifted = session.set({target: start.length + 2}); close(session.target, start.length + 2);
  assert.ok(shifted.gauge.text.includes((start.delay + 2 * odd).toFixed(1) + " ps"));
  L.applyPlan(b, group.plan);
  for (const m of read().members) { close(m.delay, ps, .1); assert.equal(m.status, "pass"); }
  assert.ok(L.netLength(b, defs, "CLK_N").length > L.netLength(b, defs, "CLK_P").length + .5);
  L.setTargetFromLongest(b, defs, [g.key]); close(b.lengthTuning.targets[g.key + "#ps"], read().longestDelay);
  assert.equal(b.lengthTuning.targets[g.key], undefined);
}
console.log("PASS one group action matches odd-mode delays across unequal pin delays");

{
  const b = timedBoard();
  const skew = L.begin(b, defs, {trackId: "CLK_P", at: [1, 0], pair: true, skew: true});
  const r = skew.move([26, -1]);
  assert.equal(r.preview[0].net, "CLK_N", "the faster member is tuned even for equal copper lengths");
  close(r.gauge.delay, L.netLength(b, defs, "CLK_P").delay, .1);
  L.applyPlan(b, skew.commit());
  close(L.netLength(b, defs, "CLK_N").delay, L.netLength(b, defs, "CLK_P").delay, .1);
}
console.log("PASS live skew chooses the faster differential-pair member");

{
  const b = {kind: "pcb", items: [...row("FAST", 0, 28, 70), ...row("SLOW", 8, 33)], rules: AtriumRules.create()};
  // Package delay contributes to the starting time but does not slow the extra copper.
  const g = {name: "Mixed", members: ["FAST", "SLOW"], basis: "delay", delayTolerance: .02, targetDelay: 280};
  b.lengthTuning = {version: 1, targets: {}, groups: [g]};
  const result = L.autoTune(b, defs, {keys: ["group:Mixed"], style: "accordion", amplitude: 1.2});
  L.applyPlan(b, result.plan);
  assert.deepEqual(result.failed, []);
  for (const n of g.members) close(L.netLength(b, defs, n).delay, 280, .02);
}
console.log("PASS group tuning uses incremental copper delay instead of package-averaged speed");

{
  const b = {kind: "pcb", items: [...row("OPEN", 0, 26), ...row("LIMITED", 8, 28), ...row("REF", 15, 34)], rules: AtriumRules.create()};
  b.rules.list.unshift({id: "max-run", type: "length", name: "Maximum run", enabled: true, priority: 1, scope: {kind: "net", value: "LIMITED"}, min: 0, max: 30});
  b.lengthTuning = {version: 1, targets: {}, groups: [{name: "Limited bus", members: ["OPEN", "LIMITED", "REF"], tolerance: .03}]};
  const opts = {keys: ["group:Limited bus"], style: "accordion", amplitude: 1}, before = JSON.stringify(b.items);
  assert.ok(L.autoTune(b, defs, opts).plan.modify.some(m => m.id === "OPEN"), "the open member can be tuned on its own");
  const group = L.autoTune(b, defs, {...opts, requireAll: true});
  assert.ok(group.failed.some(m => m.name === "LIMITED"));
  assert.deepEqual(group.plan.modify, []);
  assert.deepEqual(group.fixed, []);
  assert.equal(JSON.stringify(b.items), before);
}
console.log("PASS an incompatible physical Length rule rejects the entire group edit");

function sideChanges(pair, sideSlack) {
  const b = {kind: "pcb", items: [{id: "v", kind: "via", x: 5, y: 0, diameter: .6, drill: .3, net: "BLOCK"}]};
  const options = {sideSlack, moveBudgetMs: 30, width: .2, layer: "Top", rules: {clearance: .2}};
  if (pair) b.items.push(pad("p", "D_P", 0, -.3), pad("n", "D_N", 0, .3));
  const s = pair ? AtriumDiffPair.begin(b, defs, {...options, start: [0, -.3], gap: .15, pair: {name: "D", positive: "D_P", negative: "D_N"}})
    : R.begin(b, defs, {...options, start: [0, 0], net: "D"});
  let last = 0, changes = 0;
  for (let i = 0; i < 50; i++) {
    const r = s.move([8 + i / 30, i % 2 ? .045 : -.045]);
    const pts = pair ? r.centre.at(-1) : r.preview.find(p => p.head).points;
    const [ox, oy] = pts[0];
    let area = 0;
    for (let j = 1; j < pts.length; j++) area += (pts[j - 1][0] - ox) * (pts[j][1] - oy) - (pts[j][0] - ox) * (pts[j - 1][1] - oy);
    const side = Math.sign(area);
    if (side && last && side !== last) changes++;
    if (side) last = side;
  }
  s.cancel();
  return changes;
}
for (const pair of [false, true]) {
  assert.equal(sideChanges(pair, 1), 0);
  assert.ok(sideChanges(pair, 0) > 35);
}
console.log("PASS jitter tolerance controls walkaround hysteresis for singles and pairs");

{
  const p = {a: [0, 0], b: [30, 0], width: .15}, n = {a: [0, .4], b: [30, .4], width: .15};
  for (const style of ["trombone", "accordion", "rounded", "arcs"]) for (const extra of [.01, .6, 1]) {
    const result = L.tunePair(p, n, {style, extra, amplitude: 1, gap: .2, miter: 1, sides: 2});
    assert.ok(result.ok, result.reason);
    close(result.addedP, extra, .0001); close(result.addedN, extra, .0001);
    for (const [line, other] of [[result.p, result.n], [result.n, result.p]]) {
      for (const point of line) for (let j = 1; j < other.length; j++) assert.ok(axisGap(point, other[j - 1], other[j]) >= .4 - .00001);
    }
  }
}
console.log("PASS shallow and fully mitered pair turns keep the edge gap and both target lengths");
