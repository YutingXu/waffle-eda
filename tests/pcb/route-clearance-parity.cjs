"use strict";
// The editor and automatic planners share these production session and DRC entry points.
const assert = require("node:assert/strict");
for (const name of ["model", "parts", "connectivity", "stackup", "viastack", "altium-rules", "rooms", "component-classes", "query", "net-intent", "signals", "rules", "board-shape", "pcb-draw", "router", "diffpair", "length-tuning"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const R = AtriumRouter, Q = AtriumRules, L = AtriumLength, defs = new Map();
const pad = (id, x, y, w, extra) => ({id, kind: "pad", number: id, x, y, w, h: w, shape: "rect", layer: "Top", ...extra});
const track = (id, points, net = "SIG") => ({id, kind: "track", points, net, width: .2, layer: "Top"});
const violations = (board, library) => Q.drc(board, library, board.rules, {types: ["clearance"], scopes: false}).violations;
function scoped(scope, gap) {
  const set = Q.create();
  set.list.find(r => r.type === "clearance").priority = 2;
  set.list.push({id: "scoped", type: "clearance", name: "Focused clearance", enabled: true, priority: 1, scope, scope2: AtriumDesignQueryRecord.selector("all"), gap});
  return set;
}
function matrix(key, gap) {
  const set = Q.create();
  set.list.find(r => r.type === "clearance").objects = {[key]: gap};
  return set;
}
function route(obstacle, rules, y, direct, library = defs) {
  const b = {kind: "pcb", items: [obstacle], rules};
  const before = JSON.stringify(b);
  const s = R.begin(b, library, {net: "SIG", start: [-2, y], width: .2, mode: "walkaround"});
  const preview = s.move([2, y]);
  assert.equal(preview.status, "ok");
  assert.deepEqual(preview.end, [2, y]);
  assert.equal(preview.preview[0].points.length === 2, direct);
  assert.ok(s.click().anchored);
  const plan = s.commit();
  assert.equal(JSON.stringify(b), before);
  R.apply(b, plan);
  assert.equal(plan.add.length, 1);
  assert.deepEqual(violations(b, library), []);
}
const fp = new Map([["fp", {footprint: {name: "Route test footprint", pads: [pad("1", 0, 0, .6)]}}]]);
const ic = {id: "ic", kind: "part", def: "fp", ref: "U1", x: 0, y: 0, pinNets: {"1": "OTHER"}};
route(ic, scoped(AtriumDesignQueryRecord.selector("component", "U1"), .55), .7, false, fp);
const footprintRule = scoped(AtriumDesignQueryRecord.create('pad where footprint = "Route test footprint"'), .55);
const expected = violations({kind:"pcb", items:[ic,track("sig",[[-2,.7],[2,.7]])], rules:footprintRule}, fp);
assert.deepEqual(expected.map(v => v.ruleId), ["scoped"], "batch reads the footprint definition from the same subject");
route(ic, footprintRule, .7, false, fp);
route(pad("1", 0, 0, .6, {net: "OTHER"}), scoped(AtriumDesignQueryRecord.create('pad where smd = true'), .55), .7, false);
route(pad("1", 0, 0, .6, {net: "OTHER"}), matrix("track-via", .6), .7, true);
route(pad("npth", 0, 0, .5, {drill: .5, layer: "Multi", plated: false}), matrix("track-hole", .6), .65, false);
const neg = scoped(AtriumDesignQueryRecord.create('object where kind != "pad"'), .55);
neg.list.find(r => r.id === "scoped").scope2 = AtriumDesignQueryRecord.create('object where kind != "pad"');
route(ic, neg, .7, true, fp);
route(track("other", [[-.3, 0], [.3, 0]], "OTHER"), neg, .7, false);
const far = {kind: "pcb", items: [{id: "far", kind: "via", layer: "Multi", net: "OTHER", x: 3, y: 0, diameter: .3, drill: .15}], rules: matrix("via-via", 3)};
const wrld = R.world(far, defs), ruled = R.core.rulesFor(far);
assert.equal(R.core.viaClear(wrld, ruled, 99, "SIG", [0, 0], .2, 0, 127, false), false, "large pair rule extends the spatial lookup");
function tune(obstacle, rules) {
  const b = {kind: "pcb", items: [track("sig", [[0, 0], [30, 0]]), obstacle], rules};
  const before = JSON.stringify(b);
  assert.deepEqual(violations(b, defs), []);
  const s = L.begin(b, defs, {trackId: "sig", at: [2, .5], target: 36, tolerance: .05, style: "mitered", amplitude: 1});
  const head = s.move([28, 1]);
  assert.equal(s.move([28, 1]), head);
  assert.equal(head.gauge.status, "within");
  assert.ok(Math.abs(head.result.added - 6) < .05);
  const plan = s.commit();
  assert.equal(JSON.stringify(b), before);
  L.applyPlan(b, plan);
  assert.equal(plan.modify.length, 1);
  assert.deepEqual(violations(b, defs), []);
}
tune({id: "keep", kind: "graphic", layer: "Keepout", points: [[3,.45],[27,.45],[27,2],[3,2]], width: 0, closed: true, fill: true}, Q.create());
tune(track("parallel", [[3, 1.5], [27, 1.5]], "OTHER"), matrix("track-track", .7));
const layerTest = {kind: "pcb", items: [track("T", [[0,0],[30,0]])], rules: Q.create()};
const ob = L.obstacles(layerTest, defs);
for (let i = 0; i < 60; i++) ob.replace("T", layerTest.items[0], [[0,0],[1,1],[3,i % 2],[30,0]]);
assert.equal(ob.count(), 3, "replacement reuses the previous phase preview's segment records");
console.log("PASS committed routes and length-tuning agree with scoped, typed, hole and keepout DRC");
