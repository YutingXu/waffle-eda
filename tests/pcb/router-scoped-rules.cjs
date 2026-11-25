"use strict";
// The editor's routing session previews and applies real copper. Check the
// resulting tracks and vias with the independently extracted DRC subjects.
const assert = require("node:assert/strict");
for (const name of ["model", "stackup", "viastack", "rules", "router", "route-suggest-engine"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const R = AtriumRules, Router = AtriumRouter, E = AtriumRouteSuggestEngine, Q = AtriumDesignQueryRecord;
const defs = new Map(), start = [5, 10], transition = [20, 10], target = [35, 10];
const rule = (type, id, priority, source, limits) => ({
  id, name: id, type, enabled: true, priority, comment: "", scope: Q.create(source), ...limits
});
const width = (min, preferred, max) => ({min, preferred, max});
const viaStyle = (diameterMin, diameterPreferred, diameterMax, holeMin, holePreferred, holeMax) => ({
  diameterMin, diameterPreferred, diameterMax, holeMin, holePreferred, holeMax
});
const blind = {diameter: .30, drill: .15}, through = {diameter: .80, drill: .40};

function board({forbidInner = false} = {}) {
  const stackup = AtriumStackup.build(["Signal", "Signal", "Signal", "Signal"]);
  stackup.drillPairs = [{from: "Top", to: "Inner 1"}];
  return {
    kind: "pcb", id: "board", stackup, outline: [[0, 0], [40, 0], [40, 20], [0, 20]],
    items: [start, target].map(([x, y], i) => ({
      id: "pad-" + i, kind: "pad", net: "SIG", x, y, w: 1, h: 1, shape: "round", layer: i ? "Inner 1" : "Top"
    })),
    rules: {format: "atrium-rules", version: 2, units: "mm", netClasses: {Controlled: ["SIG"]}, list: [
      rule("width", "inner-track", 1, 'track on layer "Inner 1" and in class "Controlled"', width(.44, .46, .48)),
      rule("width", "top-track", 2, 'track on layer "Top" and in class "Controlled"', width(.30, .34, .36)),
      rule("width", "class", 3, 'object in class "Controlled"', width(.19, .22, .60)),
      rule("width", "default", 4, "object", width(.14, .18, .60)),
      rule("viaStyle", "blind-via", 1, 'via on layer "Inner 1" and not on layer "Bottom"', viaStyle(.25, .30, .40, .10, .15, .20)),
      rule("viaStyle", "through-via", 2, "via", viaStyle(.55, .80, 1.20, .25, .40, .60)),
      rule("routingLayers", "typed-layer", 1, 'track on layer "Inner 1" and in class "Controlled"', {excluded: forbidInner ? ["Inner 1"] : []}),
      rule("routingLayers", "some-layers", 2, "object", {excluded: []})
    ]}
  };
}

const begin = (doc, opts) => Router.begin(doc, defs, {start, layer: "Top", net: "SIG", mode: "walkaround", moveBudgetMs: 200, ...opts});
function check(doc) {
  const result = R.drc(doc, defs, doc.rules, {types: ["width", "viaStyle", "routingLayers"], scopes: false});
  assert.equal(result.complete, true, JSON.stringify(result.diagnostics));
  return result.violations;
}
function finish(doc, session) {
  assert.equal(session.move(target).status, "ok");
  assert.ok(session.click().done);
  const plan = session.commit();
  Router.apply(doc, plan);
  return plan.add;
}

{
  const doc = board(), route = begin(doc);
  assert.equal(R.resolver(doc)("width", {net: "SIG"}).ruleId, "class", "a direct net-only query stays net-only");
  assert.equal(begin(doc, {net: "OTHER"}).state.width, .18, "a track outside Controlled uses the default");
  const preview = route.move(transition);
  assert.equal(preview.width, .34, "the proposed Top track selects the higher-priority track rule");
  assert.equal(route.move(transition), preview, "a repeated point reuses the preview");
  assert.equal(route.presets().preferredWidth, .34);
  assert.ok(route.click().anchored);
  let switched = route.switchLayer("Inner 1");
  assert.equal(switched.ok, true, switched.message);
  assert.deepEqual(switched.via, {x: 20, y: 10, ...blind}, "automatic sizing uses the blind drill pair");
  assert.equal(route.state.width, .46, "the new leg uses the Inner 1 preference");
  assert.ok(route.back());
  assert.equal(route.state.layer, "Top");
  assert.equal(route.state.width, .34, "backtracking restores the former preference");
  switched = route.switchLayer("Inner 1");
  assert.equal(switched.ok, true, switched.message);
  const placed = finish(doc, route);
  assert.deepEqual(placed.filter(i => i.kind === "track").map(i => [i.layer, i.width]), [["Top", .34], ["Inner 1", .46]]);
  const v = placed.find(i => i.kind === "via");
  assert.deepEqual([v.fromLayer, v.toLayer, v.diameter, v.drill], ["Top", "Inner 1", .30, .15]);
  assert.deepEqual(check(doc), []);
}

{
  const doc = board(), route = begin(doc, {width: .16, viaStyle: through});
  route.setWidth(.17);
  const initial = route.move(transition);
  const state = route.state;
  for (const [layer, style] of [["Inner 1", through], ["Bottom", blind]]) {
    const blocked = route.switchLayer(layer, style);
    assert.equal(blocked.ok, false);
    assert.match(blocked.message, /design rules/);
    assert.deepEqual(route.state, state, "a rejected transition leaves the unanchored route unchanged");
  }
  assert.deepEqual(route.move(transition).preview, initial.preview);
  route.setVia(blind);
  const switched = route.switchLayer("Inner 1");
  assert.equal(switched.ok, true, switched.message);
  assert.equal(route.state.width, .17, "manual width remains in use across the layer change");
  const placed = finish(doc, route);
  assert.deepEqual(placed.filter(i => i.kind === "track").map(i => i.width), [.17, .17]);
  assert.deepEqual(check(doc).map(v => [v.ruleId, v.actual, v.required]).sort(), [["inner-track", .17, .44], ["top-track", .17, .30]]);
}

{
  const doc = board({forbidInner: true}), route = begin(doc);
  route.move(transition);
  const state = route.state;
  const refused = route.switchLayer("Inner 1");
  assert.equal(refused.ok, false);
  assert.match(refused.message, /Inner 1 is not allowed/);
  assert.deepEqual(route.state, state);
  assert.throws(() => begin(doc, {layer: "Inner 1", start: target}), /Inner 1 is not allowed/);
  assert.ok(!E.routingLayers(doc, defs, Router.core.rulesFor(doc), "SIG", start).includes("Inner 1"));
  const suggested = E.suggest(doc, defs, {net: "SIG", from: start, to: target, fromLayer: "Top", toLayer: "Inner 1", layers: ["Top", "Inner 1"], budgetMs: 300});
  assert.equal(suggested.ok, false, "layer hints cannot route to a disallowed target on unrelated layers");
  assert.deepEqual(check(doc), []);
}
console.log("PASS scoped track priorities, interactive layer widths and overrides, blind via legality and suggested layers");
