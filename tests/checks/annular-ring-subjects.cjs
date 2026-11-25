"use strict";
// Real ring findings through the unified Problems store, with the original measurement policies.
const assert = require("node:assert/strict");
for (const m of ["model", "design-query-record", "project-rules", "rules", "viastack", "dfm", "insights", "insights-pcb", "checks", "waivers", "undo-store"])
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const R = AtriumRules, Q = AtriumDesignQueryRecord, K = AtriumChecks, U = AtriumUndoStore, W = AtriumWaivers;
const check = "layout.annularRing";
const ringRule = (min, scope = Q.selector("all")) => ({id: "ring", type: "annularRing", name: "Design ring", enabled: true, priority: 1, scope, min});
const limits = {viaRing: .05, pthRing: .1, preset: "test-fab"};
const pad = (number, x, size = 1.24) => ({kind: "pad", number, layer: "Multi", x, y: 0, w: size, h: size, shape: "round", drill: 1, plated: true});
const via = {kind: "via", id: "v", layer: "Multi", x: 12, y: 10, net: "A", diameter: .38, drill: .3};
function project(items, rule, pads = []) {
  const def = {id: "f", footprint: {pads, shapes: []}};
  const d = {kind: "pcb", id: "b", name: "Board", items, outline: [[0, 0], [40, 0], [40, 40], [0, 40]],
    rules: {format: "atrium-rules", version: 3, units: "mm", list: [rule]}};
  return {format: "atrium", name: "Ring checks", library: [def], documents: [d], rules: d.rules};
}
const part = () => ({kind: "part", id: "u", ref: "U1", def: "f", layer: "Top", x: 10, y: 10, angle: 0, pinNets: {"1": "A", "2": "B"}});
function findings(p, fab = limits) {
  const d = p.documents[0], defs = new Map(p.library.map(f => [f.id, f]));
  const drc = R.drc(d, defs, R.stored(d, p), {project: p, types: ["annularRing"]}).violations;
  const dfm = AtriumDFM.run(d, defs, fab, {project: p, checks: ["ring"]}).issues;
  const hints = AtriumInsights.analyze(p, d, defs, {prefs: false, checks: ["ringMin"]}).insights;
  K.clear();
  K.publish(d.id, "drc", drc, x => K.fromDRC(x, d));
  K.publish(d.id, "dfm", dfm, x => K.fromDFM(x, d, fab.preset));
  K.publish(d.id, "insights", hints, K.fromInsight);
  return {drc, dfm, hints, problems: K.problemReport(p).active.filter(x => x.check === check)};
}
const mm = n => Math.round(n * 1000) / 1000;
const measurement = x => [mm(x.measure.actual), x.measure.required];

let failures = 0;
function test(name, fn) {
  try { fn(); console.log("ok - " + name); }
  catch (error) { failures++; console.error("failed - " + name, error); }
  finally { K.clear(); U.reset(); }
}

test("a net-scoped design failure and a tighter fab failure on another hole both survive", () => {
  const p = project([part()], ringRule(.15, Q.selector("net", "A")), [pad("1", 0), pad("2", 4, 1.16)]);
  const {drc, dfm, problems} = findings(p);
  assert.deepEqual(drc.map(x => [x.id, mm(x.actual), x.required]), [["u", .12, .15]]);
  assert.deepEqual(dfm.map(x => [x.id, mm(x.actual), x.required]), [["u", .08, .1]]);
  assert.equal(problems.length, 2, "both physical holes must remain visible");
  const rule = problems.find(x => x.source === "drc"), fab = problems.find(x => x.source === "dfm");
  assert.deepEqual(measurement(rule), [.12, .15]);
  assert.deepEqual(measurement(fab), [.08, .1]);
  assert.equal(fab.bound, "fab");
  assert.match(rule.text, /U1-1/);
  assert.match(fab.text, /U1-2/);
  assert.deepEqual([rule.subject.padIndex, fab.subject.padIndex], [0, 1]);
  assert.deepEqual([rule.at[0].point, fab.at[0].point], [[10, 10], [14, 10]]);
  assert.ok(problems.every(x => x.severity === "error" && x.objects[0].id === "u"));
});

test("stacked pads and vias retain separate design and authored measurements", () => {
  const stackedPad = {...pad("1", 14, 1.2), id: "sp", y: 14, drill: .4, stackMode: "tmb",
    padStack: {Top: {w: 1.2, h: 1.2}, Mid: {w: .6, h: .6}, Bottom: {w: 1.2, h: 1.2}}};
  const stackedVia = {...via, diameter: 1.2, drill: .4, stackMode: "tmb",
    padStack: {Top: {diameter: 1.2}, Mid: {diameter: .5}, Bottom: {diameter: 1.2}}};
  const inner = {kind: "track", id: "inner", layer: "Inner 1", points: [[1, 1], [2, 1]], width: .2, net: "A"};
  const p = project([stackedPad, stackedVia, inner], ringRule(.36));
  const {drc, dfm, problems} = findings(p, {...limits, viaRing: .5, pthRing: .5});
  assert.deepEqual(drc.map(x => mm(x.actual)), [.1, .05]);
  assert.deepEqual(dfm.map(x => mm(x.actual)), [.4, .4]);
  assert.equal(problems.length, 4, "a different ring actual is a separate finding even for the same hole");
  assert.deepEqual(problems.filter(x => x.source === "drc").map(measurement), [[.1, .36], [.05, .36]]);
  assert.deepEqual(problems.filter(x => x.source === "dfm").map(measurement), [[.4, .5], [.4, .5]]);
  assert.equal(new Set(problems.map(x => x.key)).size, 4);
});

test("two coincident holes numbered the same each merge with their own stricter finding", () => {
  const p = project([part()], ringRule(.11), [pad("1", 0, 1.16), pad("1", 0, 1.16)]);
  const fab = {...limits, pthRing: .13};
  const {drc, dfm, problems} = findings(p, fab);
  assert.equal(drc.length, 2);
  assert.equal(dfm.length, 2, "a part, number, actual and coordinates can all coincide");
  assert.equal(problems.length, 2);
  assert.equal(new Set(problems.map(x => x.key)).size, 2);
  assert.deepEqual(problems.map(x => x.subject.padIndex), [0, 1]);
  for (const row of problems) {
    assert.equal(row.bound, "fab");
    assert.equal(row.fab, true);
    assert.match(row.text, /fab's limit \(test-fab\) applied/);
    assert.deepEqual(measurement(row), [.08, .13]);
    assert.deepEqual(row.members.map(x => x.source), ["drc", "dfm"]);
  }
  U.mark(p);
  const history = [], future = [], item = p.documents[0].items[0];
  const before = U.mark(p);
  item.x += 5;
  item.angle = 90;
  U.checkpoint(history, future, before, "Move part");
  U.touch(p);
  const signature = rows => rows.map(x => [x.key, x.keys, x.subject]);
  const moved = findings(p, fab).problems;
  assert.deepEqual(signature(moved), signature(problems), "moving the parent preserves both source keys");
  assert.notDeepEqual(moved[0].at, problems[0].at);
  assert.ok(U.jump(history, future, U.mark(p), -1));
  const undone = findings(U.root(), fab).problems;
  assert.deepEqual(signature(undone), signature(problems));
  assert.deepEqual(undone.map(x => x.at), problems.map(x => x.at));
  assert.ok(U.jump(history, future, U.mark(U.root()), 1));
  assert.deepEqual(findings(U.root(), fab).problems.map(x => x.at), moved.map(x => x.at));
});

test("a simple via merges at the design limit, and a fab breakout shadows only the same hole's hint", () => {
  const p = project([via], ringRule(.1));
  const simple = findings(p).problems;
  assert.equal(simple.length, 1);
  assert.equal(simple[0].bound, "rule");
  assert.equal(simple[0].fab, true);
  assert.match(simple[0].text, /rule Design ring applied/);
  assert.deepEqual(measurement(simple[0]), [.04, .1]);

  const q = project([part()], ringRule(.1), [pad("1", 0, 1.22), pad("1", 4, 1.28)]);
  const {hints, problems} = findings(q, {...limits, drillTolPlus: .1, holePosition: .08});
  assert.equal(hints.length, 2);
  assert.equal(problems.length, 2, "the other physical hole's hint remains");
  assert.deepEqual(problems.map(x => [x.severity, x.subject.padIndex]), [["warning", 0], ["hint", 1]]);
  assert.match(problems[0].text, /breaks out at drill tolerance/);
  assert.equal(problems[0].bound, "fab");
  assert.deepEqual(hints.map(x => K.shadowed(K.fromInsight(x))), [true, false]);
});

test("new waivers target one drill, and saved component-wide waivers still apply", () => {
  const p = project([part()], ringRule(.11), [pad("1", 0, 1.16), pad("1", 4, 1.16)]);
  const {drc} = findings(p);
  const doc = p.documents[0];
  const single = W.waive(p, drc[0], {doc, holds: "always"});
  assert.equal(single.key, K.fromDRC(drc[0], doc).key);
  assert.deepEqual(W.match(p, drc, {doc}).active, [drc[1]]);
  assert.equal(W.remove(p, single.id), 1);

  const legacy = {...drc[0]};
  delete legacy.subject;
  const broad = W.waive(p, legacy, {doc, holds: "always"});
  assert.equal(W.match(p, drc, {doc}).active.length, 0);
  assert.equal(W.remove(p, broad.id), 1);

  // The raw DRC waiver adapter also runs in processes where checks.js is absent.
  try {
    delete globalThis.AtriumChecks;
    const saved = W.waive(p, drc[0], {doc, holds: "always"});
    assert.equal(saved.key, single.key);
    assert.deepEqual(W.match(p, drc, {doc}).active, [drc[1]]);
    assert.equal(W.remove(p, saved.id), 1);
    assert.equal(W.waive(p, legacy, {doc, holds: "always"}).key, broad.key);
    assert.equal(W.match(p, drc, {doc}).active.length, 0);
  } finally { globalThis.AtriumChecks = K; }
});

test("a fallback pad waiver goes stale on reorder and survives first native identity assignment", () => {
  const pads = [pad("1", 0, 1.16), pad("2", 4, 1.16)];
  const p = project([part()], ringRule(.11), pads), doc = p.documents[0];
  const first = findings(p).drc[0];
  const saved = W.waive(p, first, {doc});
  pads.reverse();
  const reordered = findings(p).drc;
  assert.equal(W.match(p, reordered, {doc, complete: () => true}).states.get(saved.id), "stale");
  assert.deepEqual(W.match(p, reordered, {doc}).active, reordered);

  pads.reverse();
  pads.forEach((pad, index) => Object.assign(pad, {nativeId: "pad-" + index, nativeIdOwner: "f"}));
  const identified = findings(p).drc, converted = W.match(p, identified, {doc});
  assert.deepEqual(converted.active, [identified[1]], "a waiver saved before IDs were assigned still finds its original slot");
  assert.equal(W.remove(p, saved.id), 1);
  const nativeWaiver = W.waive(p, identified[0], {doc});
  pads.reverse();
  const nativeReordered = findings(p).drc;
  assert.deepEqual(W.match(p, nativeReordered, {doc}).active, [nativeReordered[0]]);
  assert.equal(K.fromDRC(nativeReordered[1], doc).key, nativeWaiver.key, "the durable pad's key travels with it");
});

test("a worsening drill keeps a legacy broad waiver stale regardless of finding order", () => {
  const pads = [pad("1", 0, 1.16), pad("2", 4, 1.16)];
  const p = project([part()], ringRule(.11), pads), doc = p.documents[0];
  const broad = {...findings(p).drc[0]};
  delete broad.subject;
  const saved = W.waive(p, broad, {doc});
  pads[0].w = .1 + 1;
  const {drc} = findings(p);
  for (const order of [drc, [...drc].reverse()]) {
    const result = W.match(p, order, {doc});
    assert.equal(result.states.get(saved.id), "stale");
    assert.deepEqual(result.active, [drc[0]]);
  }
});

if (failures) throw Error(failures + " annular-ring regression case(s) failed");
