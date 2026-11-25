"use strict";
// Impedance checks (app/analysis/impedance-checks.js): the pure checks on plain inputs (design window,
// neck-down budget per end at its edge, missing reference copper, reference change at a via with
// and without a stitching via or capacitor, untargeted layer), then the DRC adapter on a board.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh impedance-checks).
const assert = require("node:assert/strict");
for (const m of ["model", "rules", "impedance", "stackup", "rigid-flex", "si", "impedance-checks"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const C = AtriumImpedanceChecks, S = AtriumStackup, R = AtriumRules, A = Atrium;
const close = (a, b, eps, m) => assert.ok(Math.abs(a - b) <= eps, (m ? m + ": " : "") + a + " vs " + b);
const V = {width: .3, minWidth: .25, maxWidth: .35, warnMinWidth: .28, warnMaxWidth: .32, window: 5, tolerance: 10,
  geometry: {structure: "microstrip", refTop: null, refBottom: "Inner 1", h: .2}};
const track = (id, width, points, o = {}) => ({id, net: "SIG", layer: "Top", width, points, ...o});

// Window: inside the spec tolerance but outside the window warns; outside the tolerance is the DRC's.
{
  const tracks = [track("ok", .3, [[0, 0], [1, 0]]), track("low", .27, [[0, 1], [1, 1]]), track("high", .33, [[0, 2], [1, 2]]), track("flagged", .24, [[0, 3], [1, 3]])];
  const v = C.windowCheck({tracks, values: () => V});
  assert.deepEqual(v.map(x => [x.id, x.limit, x.required, x.severity]), [["low", "min", .28, "warning"], ["high", "max", .32, "warning"]]);
  assert.match(v[0].message, /inside ±10 % but outside the ±5 % design window/);
  assert.deepEqual(C.windowCheck({tracks, values: () => V}, {skip: new Set(["low"])}).map(x => x.id), ["high"]);
  assert.deepEqual(C.windowCheck({tracks, values: () => null}), [], "unprofiled");
}
// Neck-down budget per end, measured from the pad, at the edge of the budget.
{
  const pad = {id: "U1-1", net: "SIG", at: [0, 0], r: .3, layer: "Top", label: "U1-1"};
  const mk = len => [track("n1", .1, [[0, 0], [1, 0]]), track("n2", .12, [[1, 0], [len, 0]]), track("w", .3, [[len, 0], [10, 0]]), track("far", .1, [[10, 0], [11, 0]])];
  const at = (len, budget) => C.neckCheck({tracks: mk(len), ends: [pad], values: () => V, budget: () => budget});
  assert.deepEqual(at(2.5, 2.5), [], "exactly at the budget");
  const over = at(2.6, 2.5);
  assert.equal(over.length, 1); close(over[0].actual, 2.6, 1e-9); assert.equal(over[0].required, 2.5); assert.equal(over[0].end, "U1-1");
  assert.deepEqual(over[0].ids.sort(), ["n1", "n2"], "the narrow run from the pad, not the narrow piece farther out");
  assert.deepEqual(at(3, 4), [], "a per-rule budget");
  assert.equal(C.neckCheck({tracks: mk(3), ends: [pad], values: () => V}).length, 1, "default 2.5 mm");
  assert.deepEqual([...C.neckCheck.necks({tracks: mk(2), ends: [pad], values: () => V, budget: () => 2.5})].sort(), ["n1", "n2"]);
  assert.deepEqual(C.neckCheck({tracks: mk(3), ends: [{...pad, layer: "Bottom"}], values: () => V}), [], "a pad on another layer");
}
// Missing reference: the plane covers x < 5 only; w + 2*3h around the centre line must be copper.
{
  const copperAt = (layer, x, y) => layer === "Inner 1" && x < 5 && Math.abs(y) < 50;
  const t = track("t", .3, [[0, 0], [10, 0]]);
  const v = C.referenceCheck({tracks: [t], values: () => V, copperAt});
  assert.equal(v.length, 1); assert.equal(v[0].reference, "Inner 1"); close(v[0].actual, 5, .26); close(v[0].width, .3 + 6 * .2, 1e-9);
  assert.ok(v[0].at[0] >= 5 && v[0].at[0] < 5.3, "the start of the unreferenced run");
  assert.deepEqual(C.referenceCheck({tracks: [t], values: () => V, copperAt: () => true}), []);
  // A stripe narrower than w + 2*3h under the track is not enough.
  const stripe = (layer, x, y) => Math.abs(y) < .5;
  assert.equal(C.referenceCheck({tracks: [t], values: () => V, copperAt: stripe}).length, 1);
  assert.deepEqual(C.referenceCheck({tracks: [t], values: () => V, copperAt: (l, x, y) => Math.abs(y) < .8}), []);
  // The signal's own via antipad is an expected void.
  const hole = (l, x, y) => Math.hypot(x - 5, y) > .5;
  assert.equal(C.referenceCheck({tracks: [t], values: () => V, copperAt: hole}).length, 1);
  assert.deepEqual(C.referenceCheck({tracks: [t], values: () => V, copperAt: hole, holes: [{net: "SIG", at: [5, 0], r: .3}]}), []);
  // A 2 mm void with a 1.8 mm expected antipad leaves two sub-threshold runs.
  const copperAtSlot = (l, x) => x < 4 || x > 6;
  const copperCuts = (l, ax, ay, bx, by, out) => out.push((4 - ax) / (bx - ax), (6 - ax) / (bx - ax));
  const inputs = {tracks: [t], values: () => V, copperAt: copperAtSlot, copperCuts};
  assert.equal(C.referenceCheck(inputs)[0].actual, 2);
  assert.deepEqual(C.referenceCheck({...inputs, holes: [{net: "SIG", at: [5, 0], r: .3}]}), []);
  assert.equal(C.referenceCheck({...inputs, holes: [{net: "OTHER", at: [5, 0], r: .3}]})[0].actual, 2);
}
// Reference change at a via: Top over Inner 1, Bottom under Inner 2.
{
  const top = track("a", .3, [[0, 0], [5, 0]]), bottom = track("b", .3, [[5, 0], [9, 0]], {layer: "Bottom"});
  const values = t => t.layer === "Top" ? V : {...V, geometry: {structure: "microstrip", refTop: "Inner 2", refBottom: null, h: .2}};
  const via = {id: "v1", net: "SIG", at: [5, 0], r: .3};
  const gnd = (k) => k === "Inner 1" || k === "Inner 2" ? "GND" : null, split = k => k === "Inner 1" ? "GND" : "VCC";
  const stitch = d => ({id: "s", net: "GND", at: [5 + d, 0], covers: () => true});
  const run = (refNet, o = {}, opts) => C.referenceChangeCheck({vias: [via], tracks: [top, bottom], values, refNet, ...o}, opts);
  const none = run(gnd);
  assert.equal(none.length, 1); assert.equal(none[0].need, "via"); assert.equal(none[0].referenceNet, "GND"); close(none[0].required, .6, 1e-9, "d = 3h");
  assert.deepEqual(none[0].references, ["Inner 1", "Inner 2"]); assert.equal(none[0].layer, "Top"); assert.equal(none[0].toLayer, "Bottom");
  assert.deepEqual(run(gnd, {stitches: [stitch(.5)]}), [], "a GND stitching via within 3h");
  assert.equal(run(gnd, {stitches: [stitch(1)]}).length, 1, "too far");
  assert.deepEqual(run(gnd, {stitches: [stitch(1)]}, {distance: 1.5}), [], "a set distance");
  assert.equal(run(gnd, {stitches: [{...stitch(.5), covers: k => k === "Inner 1"}]}).length, 1, "the stitching via must reach both planes");
  const cap = run(split);
  assert.equal(cap.length, 1); assert.equal(cap[0].need, "cap"); assert.deepEqual(cap[0].referenceNets, ["GND", "VCC"]);
  assert.deepEqual(run(split, {caps: [{id: "C1", at: [7, 0], nets: new Set(["GND", "VCC"])}]}), [], "a stitching capacitor within 5 mm");
  assert.deepEqual(run(() => null), [], "no copper at the via: the missing-reference check reports it");
  assert.deepEqual(C.referenceChangeCheck({vias: [via], tracks: [top, {...bottom, layer: "Top"}], values, refNet: gnd}), [], "no layer change");
}
// Untargeted layer: once per net and layer.
{
  const tracks = [track("a", .3, [[0, 0], [1, 0]], {profile: "Z90D"}), track("b", .3, [[0, 1], [1, 1]], {layer: "Inner 2", profile: "Z90D"}), track("c", .3, [[1, 1], [2, 1]], {layer: "Inner 2", profile: "Z90D"})];
  const v = C.untargetedLayerCheck({tracks, values: t => t.layer === "Top" ? V : null});
  assert.deepEqual(v.map(x => [x.id, x.layer]), [["b", "Inner 2"]]); assert.match(v[0].message, /Z90D has no row for Inner 2/);
  assert.deepEqual(C.untargetedLayerCheck({tracks: [{...tracks[1], known: false}], values: () => null}), [], "a profile missing from the stack-up is reported elsewhere");
}
// DRC adapter: a 4-layer board, a 50 Ω profile on Top only, a GND plane under half the board.
{
  const b = A.sheet("pcb", "Board"), st = S.preset(4); delete st.derived;
  b.outline = [[0, 0], [40, 0], [40, 20], [0, 20]];
  b.stackup = {...st, impedanceProfiles: [{id: "se50", name: "SE 50", type: "single", target: 50, tolerance: 10, policy: "fab", neck: {maxLength: 1}, layers: {Top: {enabled: true}}}]};
  const v = S.profileValues(b, "se50", "Top");
  b.items.push({id: "gnd", kind: "polygon", layer: "Inner 1", net: "GND", points: [[0, 0], [20, 0], [20, 20], [0, 20]]},
    {id: "ok", kind: "track", layer: "Top", net: "SIG", width: v.width, points: [[2, 10], [18, 10]]},
    {id: "warn", kind: "track", layer: "Top", net: "SIG", width: +(v.warnMinWidth - .002).toFixed(4), points: [[2, 12], [10, 12]]},
    {id: "void", kind: "track", layer: "Top", net: "SIG", width: v.width, points: [[22, 10], [38, 10]]},
    {id: "inner", kind: "track", layer: "Bottom", net: "SIG", width: v.width, points: [[2, 5], [10, 5]]},
    {id: "neck", kind: "track", layer: "Top", net: "SIG", width: .1, points: [[2, 15], [4, 15]]},
    {id: "pad", kind: "pad", layer: "Top", net: "SIG", x: 2, y: 15, w: .4, h: .4, shape: "rect"});
  const rules = R.create(); rules.list.find(r => r.type === "width").impedanceProfile = "se50";
  const res = R.drc(b, new Map(), rules), mine = res.violations.filter(x => x.check);
  const by = k => mine.filter(x => x.check === k).map(x => x.id).sort();
  assert.deepEqual(by("impedanceWindow"), ["warn"]); assert.equal(mine.find(x => x.check === "impedanceWindow").severity, "warning");
  assert.deepEqual(by("untargetedLayer"), ["inner"]);
  assert.ok(by("missingReference").includes("void"), "no GND under the right half"); assert.ok(!by("missingReference").includes("ok"));
  assert.deepEqual(by("neckBudget"), ["neck"], "2 mm of 0.1 mm track from the pad, budget 1 mm (profile neck)");
  for (const x of mine) { assert.equal(x.type, "width"); assert.equal(x.profile, "se50"); assert.ok(x.what && x.detail); }
  // Without a profile on any rule the adapter does nothing.
  assert.ok(!R.drc(b, new Map(), R.create()).violations.some(x => x.check));
}
// The board adapter measures copper edges before applying the 0.2 mm run threshold.
{
  const b = A.sheet("pcb", "Board"), st = S.preset(4), rules = R.create();
  b.outline = [[0, 0], [30, 0], [30, 20], [0, 20]];
  b.stackup = {...st, impedanceProfiles: [{id: "z50", name: "50 Ω", type: "single", target: 50, tolerance: 10,
    policy: "fab", layers: {Top: {enabled: true}}}]};
  rules.list.find(r => r.type === "width").impedanceProfile = "z50";
  const defs = new Map(), sig = {kind: "track", ...track("sig", .3, [[6, 10], [26, 10]])};
  const fill = (id, left, right) => ({id, kind: "graphic", layer: "Inner 1", net: "GND", closed: true, fill: true,
    points: [[left, 0], [right, 0], [right, 20], [left, 20]]});
  const missing = (...fills) => {
    b.items = [sig, ...fills];
    return R.drc(b, defs, rules).violations.filter(r => r.check === "missingReference").map(r => r.actual);
  };
  const slot = (left, right) => missing(fill("near", 0, left), fill("far", right, 30));
  assert.deepEqual(slot(10.08, 10.18), [], "sub-threshold void straddles a sample point");
  assert.deepEqual(slot(10.20, 10.30), [], "sub-threshold void lies between sample points");
  assert.deepEqual(slot(10.15, 10.36), [.21], "over-threshold void lies between sample points");
  assert.deepEqual(missing(fill("reference", 0, 16.2)), [9.8], "off-grid copper edge");
  assert.deepEqual(missing(fill("reference", 0, 30)), [], "fully backed track");
}

console.log("PASS impedance checks: window, neck-down budget, missing reference, reference change, untargeted layer, DRC adapter.");
