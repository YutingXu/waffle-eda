"use strict";
// Routing feel (app/pcb/route-feel.js): snapping with hysteresis, pad entry, the 45° ray, the Space key
// policy, shove interpolation and release, glossing after commit, reduced motion.
const assert = require("node:assert/strict");
let T = 0;
globalThis.performance = {now: () => T};
let motion = null;   // data-motion on <html>
globalThis.document = {documentElement: {getAttribute: k => k === "data-motion" ? motion : null}, getElementById: () => null};
require("../../app/core/model.js");
require("../../app/pcb/route-feel.js");
const F = globalThis.AtriumRouteFeel, A = globalThis.Atrium;
let failed = 0;
const test = (name, run) => { try { run(); console.log("PASS " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n  " + (e && e.message || e)); } };
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
const nearPt = (p, q, tol = 1e-9) => near(p[0], q[0], tol) && near(p[1], q[1], tol);

test("routing options read a saved envelope before Preferences loads", () => {
  globalThis.localStorage = {getItem: () => '{"values":{"routing.padEntry":"edge"}}'};
  try { assert.equal(F.pref("routing.padEntry"), "edge"); }
  finally { delete globalThis.localStorage; }
});

// A board with a pad, a via and a track, a 0.25 mm grid and a view at 10 px/mm.
const board = {kind: "pcb", grid: .25, items: [
  {id: "p1", kind: "pad", x: 5, y: 5, w: 2, h: 1, layer: "Top"},
  {id: "v1", kind: "via", x: 10, y: 10, diameter: .6, drill: .3},
  {id: "t1", kind: "track", layer: "Top", width: .25, points: [[0, 0], [4, 0]]}]};
let scale = 10, prefs = {};
globalThis.AtriumPrefs = {get: k => prefs[k]};
globalThis.AtriumNavHost = {doc: () => board, defs: () => new Map(), revision: () => 1, units: () => "mm",
  view: () => ({scale: () => scale, query: (d) => d.items})};
// The object snap of pcb-edit.js: the nearest via, pad centre or track vertex within the radius.
globalThis.AtriumPCBEdit = {snapPrefs: {grid: true, objects: true, radius: 8, pads: true, vias: true, tracks: true},
  objectSnap(d, defs, p, o) {
    let best = null, d2 = o.radius * o.radius;
    const consider = (q, kind, id) => { const e = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (e < d2) { d2 = e; best = {point: q, kind, id}; } };
    for (const i of d.items) if (i.kind === "via") consider([i.x, i.y], "via", i.id); else if (i.kind === "track") for (const q of i.points) consider(q, "track", i.id);
    return best;
  }};

test("interpolation keeps the target's vertices and starts on the old shape", () => {
  const from = [[0, 0], [4, 0]], to = [[0, 0], [1, 0], [1.5, .5], [2.5, .5], [3, 0], [4, 0]];
  const a = F.interpolate(from, to, 0), b = F.interpolate(from, to, 1), m = F.interpolate(from, to, .5);
  assert.equal(a.length, to.length);
  for (const p of a) assert.ok(near(p[1], 0), "k=0 lies on the old track");
  b.forEach((p, i) => assert.ok(nearPt(p, to[i]), "k=1 is the new shape"));
  assert.ok(m[2][1] > 0 && m[2][1] < .5, "half way is in between");
});

test("grid snap holds the current point until half a cell plus 3 px", () => {
  F.frame(null, false);
  let q = F.snap([20.13, 20.02]); assert.deepEqual(q, [20.25, 20]);
  q = F.snap([20.11, 20.02]); assert.deepEqual(q, [20.25, 20], "inside the hysteresis band");
  q = F.snap([20.05, 20.02]); assert.deepEqual(q, [20, 20], "past the band");
  assert.equal(F.debug().snap.kind, "grid");
  // Zoomed out the band shrinks to a quarter cell, so the grid still tracks the pointer.
  scale = .5; F.snap([20.2, 23]); q = F.snap([20.04, 23]); assert.deepEqual(q, [20, 23]); scale = 10;
});

test("pad entry: centre by default, the nearest edge when asked, none for any", () => {
  assert.deepEqual(F.snap([5.8, 5.1]), [5, 5]);
  assert.equal(F.debug().snap.kind, "pad");
  prefs["routing.padEntry"] = "edge";
  const e = F.snap([5.8, 5.1]); assert.ok(nearPt(e, [6, 5]), "edge " + e);
  const e2 = F.snap([5.1, 5.45]); assert.ok(nearPt(e2, [5, 5.5]), "top edge " + e2);
  prefs["routing.padEntry"] = "any";
  assert.notDeepEqual(F.snap([5.8, 5.1]), [5, 5]);
  delete prefs["routing.padEntry"];
});

test("object snap is sticky up to 1.6x the radius and labels track ends", () => {
  assert.deepEqual(F.snap([10.7, 10]), [10, 10]); assert.equal(F.debug().snap.label, "Via");
  assert.deepEqual(F.snap([11.1, 10]), [10, 10], "still held at 1.1 mm (radius 0.8 mm)");
  const rel = F.snap([11.4, 10]); assert.ok(!nearPt(rel, [10, 10]), "released past 1.28 mm: " + rel + " " + JSON.stringify(F.debug().snap));
  F.snap([4.5, .3]); assert.equal(F.debug().snap.kind, "track-end");
  // Object snap off (Shift+E): grid only, but a pad still takes the head.
  AtriumPCBEdit.snapPrefs.objects = false;
  assert.deepEqual(F.snap([10.7, 10]), [10.75, 10]);
  assert.deepEqual(F.snap([5.8, 5.1]), [5, 5]);
  AtriumPCBEdit.snapPrefs.objects = true;
});

test("45° ray from the last anchor", () => {
  // A routing frame whose head starts at the pad: the anchor is the pad centre.
  F.frame({preview: [{points: [[5, 5], [6, 6]], width: .25, layer: "Top", head: true}], vias: [], pushed: [], hidden: [], corner: "45"}, true);
  const q = F.snap([8.05, 7.95]);
  assert.ok(near(q[0] - 5, q[1] - 5), "on the diagonal " + q);
  assert.equal(F.debug().snap.label, "45° from pad");
  F.frame(null, false);
});

test("Space policy: Altium by default, swapped by the preference", () => {
  assert.equal(F.spaceAction("route-bend"), "route-bend");
  assert.equal(F.spaceAction("route-mode"), "route-mode");
  prefs["routing.spaceCyclesCorner"] = true;
  assert.equal(F.spaceAction("route-bend"), "route-mode");
  assert.equal(F.spaceAction("route-mode"), "route-bend");
  delete prefs["routing.spaceCyclesCorner"];
});

const preview = (pushed, extra = {}) => ({preview: [{points: [[0, -2], [2, -2]], width: .25, layer: "Top", head: true}], vias: [], pushed, hidden: pushed.map(p => p.id), corner: "45", status: "pushed", ...extra});

test("shoved copper eases to its new shape, then back when released", () => {
  T = 1000; F.frame(null, false);
  const shoved = {id: "t1", kind: "track", layer: "Top", width: .25, points: [[0, 1], [4, 1]]};
  let out = F.frame(preview([shoved]), true);
  assert.ok(nearPt(out.pushed[0].points[0], [0, 0]), "starts where it was");
  T += 45; out = F.frame(preview([shoved]), true);
  const y = out.pushed[0].points[0][1]; assert.ok(y > .5 && y < 1, "eased past half way at 45 ms: " + y);
  T += 60; out = F.frame(preview([shoved]), true);
  assert.deepEqual(out.pushed[0].points, shoved.points, "there by 90 ms");
  assert.equal(out.halo, null); assert.deepEqual(out.boundaries, []);
  // The head moves away: the track eases back and stays hidden until it lands.
  T += 10; out = F.frame(preview([]), true);
  assert.ok(out.hidden.includes("t1")); assert.equal(out.pushed.length, 1);
  T += 200; out = F.frame(preview([]), true);
  assert.ok(!out.hidden.includes("t1") && !out.pushed.length, "released");
  assert.equal(F.debug().anims, 0);
  F.frame(null, false);
});

test("anchoring flashes the head; a new via drops in with a ring", () => {
  T += 1000;
  F.frame(preview([]), true);
  const anchored = {preview: [{points: [[0, -2], [2, -2]], width: .25, layer: "Top"}, {points: [[2, -2], [3, -1]], width: .25, layer: "Top", head: true}],
    vias: [{x: 2, y: -2, diameter: .6, drill: .3}], pushed: [], hidden: [], corner: "45"};
  T += 16; F.frame(anchored, true);
  assert.equal(F.debug().flashes, 1); assert.equal(F.debug().rings, 1);
  T += 5000; F.frame(null, false);
});

test("a conflict fades in instead of blinking", () => {
  T += 1000;
  let out = F.frame(preview([], {status: "violation"}), true);
  assert.notEqual(out.status, "violation", "the canvas does not switch the head to red at once");
  const a0 = F.debug().conflict;
  T += 30; F.frame(preview([], {status: "violation"}), true);
  const a1 = F.debug().conflict;
  assert.ok(a1 > a0 && a1 < 1, "rising: " + a0 + " -> " + a1);
  for (let i = 0; i < 10; i++) { T += 50; F.frame(preview([], {status: "violation"}), true); }
  assert.equal(F.debug().conflict, 1);
  for (let i = 0; i < 20; i++) { T += 50; F.frame(null, false); }
  assert.equal(F.debug().conflict, 0);
});

test("commit: the glossed result eases from the drawn path", () => {
  T += 1000;
  const pre = {preview: [{points: [[0, 0], [2, 0], [2, 2]], width: .25, layer: "Top"}]};
  const plan = {add: [{id: "n1", kind: "track", layer: "Top", width: .25, points: [[0, 0], [1, 0], [2, 1], [2, 2]]}], modify: [], remove: []};
  F.committed(plan, pre);
  let out = F.frame(null, false);
  assert.ok(F.debug().gloss); assert.ok(out.hidden.includes("n1"));
  T += 500; out = F.frame(null, false);
  assert.ok(!F.debug().gloss);
});

test("reduced motion: geometry jumps, no flashes", () => {
  motion = "reduce"; T += 1000;
  assert.equal(F.motionOK(), false);
  const shoved = {id: "t1", kind: "track", layer: "Top", width: .25, points: [[0, 1], [4, 1]]};
  const out = F.frame(preview([shoved]), true);
  assert.deepEqual(out.pushed[0].points, shoved.points);
  F.committed({add: [{id: "n2", kind: "track", layer: "Top", width: .25, points: [[0, 0], [1, 0]]}]}, {preview: [{points: [[0, 0], [1, 1]]}]});
  assert.ok(!F.debug().gloss);
  F.frame(null, false); motion = null;
});

test("motion levels: reduced keeps fades, off keeps nothing", () => {
  motion = "reduce"; assert.equal(F.level(), "reduced"); assert.equal(F.fadesOK(), true); assert.equal(F.motionOK(), false);
  motion = "off"; assert.equal(F.level(), "off"); assert.equal(F.fadesOK(), false);
  T += 1000; F.frame(preview([]), true);
  const anchored = {preview: [{points: [[0, -2], [2, -2]], width: .25, layer: "Top"}, {points: [[2, -2], [3, -1]], width: .25, layer: "Top", head: true}], vias: [{x: 2, y: -2, diameter: .6}], pushed: [], hidden: [], corner: "45"};
  T += 16; F.frame(anchored, true);
  assert.equal(F.debug().flashes, 0); assert.equal(F.debug().rings, 0);
  F.frame(null, false); motion = null; assert.equal(F.level(), "full");
});

// ---------------------------------------------------------------- router layer changes
require("../../app/pcb/router.js");
const RT = globalThis.AtriumRouter;
const layerBoard = (extra = []) => ({kind: "pcb", items: [...extra], outline: [[-5, -5], [30, -5], [30, 10], [-5, 10]],
  layers: ["Top", "Bottom"], stackup: {layers: [{name: "Top", type: "signal"}, {name: "Bottom", type: "signal"}]}});

test("+ then − without moving takes the via back instead of stacking a second one", () => {
  const b = layerBoard(), s = RT.begin(b, new Map(), {net: "SIG", layer: "Top", start: [0, 0], mode: "walkaround"});
  s.move([5, 0]); s.click(); s.move([8, 0]);
  const a = s.switchLayer("Bottom"); assert.ok(a.ok, a.message);
  const n = s.state.anchors;
  const r = s.switchLayer("Top"); assert.ok(r.ok && r.removed, JSON.stringify(r));
  assert.equal(s.state.layer, "Top"); assert.ok(s.state.anchors < n);
  const plan = s.commit();
  assert.equal(plan.add.filter(i => i.kind === "via").length, 0, "no via left");
});

test("a layer change that does not fit leaves the route as it was", () => {
  // A foreign via under the head end and along the leg: no room for our via anywhere near.
  const block = [];
  for (let x = 0; x <= 9; x += .5) block.push({id: "fv" + x, kind: "via", x, y: .75, diameter: .6, drill: .3, net: "OTHER"}, {id: "gv" + x, kind: "via", x, y: -.75, diameter: .6, drill: .3, net: "OTHER"});
  const b = layerBoard(block), s = RT.begin(b, new Map(), {net: "SIG", layer: "Top", start: [0, 0], mode: "walkaround"});
  const m = s.move([8, 0]); assert.equal(m.status, "ok", "precondition: the track fits between the vias");
  const before = s.state.anchors;
  const r = s.switchLayer("Bottom");
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(s.state.anchors, before, "the head was not anchored");
  assert.equal(s.state.layer, "Top");
  const v = s.addVia(); assert.equal(v.ok, false); assert.equal(s.state.anchors, before);
});

test("never two vias of a route within a via diameter", () => {
  const b = layerBoard(), s = RT.begin(b, new Map(), {net: "SIG", layer: "Top", start: [0, 0], mode: "walkaround"});
  s.move([5, 0]); assert.ok(s.addVia().ok);
  const r = s.addVia(); assert.equal(r.ok, false, "a second via on the first");
});

if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " route-feel test(s) failed"); }
