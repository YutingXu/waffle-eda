"use strict";
// Review PoCs for app/pcb/route-feel.js. Each test states the behaviour an
// Altium user expects; the ones that fail today are the bugs the review ranks. Run:
//   scripts/test-jsc.sh route-feel-review      (or: node tests/pcb/route-feel-review.cjs)
const assert = require("node:assert/strict");
let T = 0;
globalThis.performance = {now: () => T};
let motion = null;
globalThis.document = {documentElement: {getAttribute: k => k === "data-motion" ? motion : null}, getElementById: () => null};
// Count how route-feel asks for its next animation frame.
const rafQueue = [], micro = [];
globalThis.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
globalThis.queueMicrotask = cb => { micro.push(cb); };
globalThis.setTimeout = (cb, ms) => { micro.push(cb); return 1; };
require("../../app/core/model.js");
require("../../app/pcb/route-feel.js");
const F = globalThis.AtriumRouteFeel;
let failed = 0;
const test = (name, run) => { try { run(); console.log("PASS " + name); } catch (e) { failed++; console.log("FAIL " + name + "\n  " + (e && e.message || e)); } };
const onGrid = (v, g) => Math.abs(v / g - Math.round(v / g)) < 1e-9;

// A board: grid 0.25 mm, view 10 px/mm (snap radius 8 px = 0.8 mm).
// Pads: p1 net A (Top), p2 net B (Top), p3 net A on Bottom (SMD). Vias: vA net A, vB net B.
const board = {kind: "pcb", grid: .25, items: [
  {id: "p1", kind: "pad", x: 5, y: 5, w: 1, h: 1, layer: "Top", net: "A"},
  {id: "p2", kind: "pad", x: 7, y: 5, w: 1, h: 1, layer: "Top", net: "B"},
  {id: "p3", kind: "pad", x: 9, y: 5, w: 1, h: 1, layer: "Bottom", net: "A"},
  {id: "vB", kind: "via", x: 20, y: 20, diameter: .6, drill: .3, net: "B"},
  {id: "v1", kind: "via", x: 30, y: 30, diameter: .6, drill: .3, net: "A"},
  {id: "v2", kind: "via", x: 32.05, y: 30, diameter: .6, drill: .3, net: "A"}]};
let scale = 10, routeNet = "A", routeLayer = "Top", redraws = 0;
globalThis.AtriumPrefs = {get: () => undefined};
globalThis.AtriumNavHost = {doc: () => board, defs: () => new Map(), revision: () => 1, units: () => "mm",
  view: () => ({scale: () => scale, query: d => d.items}),
  liveRoute: () => routeNet ? {net: routeNet, preview: {layer: routeLayer}} : null,
  activeLayer: () => routeLayer, layer: () => routeLayer,
  redrawOverlay: () => { redraws++; }, redraw: () => { redraws++; }};
// pcb-edit.js objectSnap semantics: nearest via / pad centre / track vertex within the radius, any net, any layer.
globalThis.AtriumPCBEdit = {snapPrefs: {grid: true, objects: true, radius: 8, pads: true, vias: true, tracks: true},
  objectSnap(d, defs, p, o) {
    let best = null, d2 = o.radius * o.radius;
    const consider = (q, kind, id) => { const e = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2; if (e < d2) { d2 = e; best = {point: q, kind, id}; } };
    for (const i of d.items) if (i.kind === "via") consider([i.x, i.y], "via", i.id); else if (i.kind === "pad") consider([i.x, i.y], "pad", i.id);
    else if (i.kind === "track") for (const q of i.points) consider(q, "track", i.id);
    return best;
  }};
const head = (from, to, layer = "Top") => ({preview: [{points: [from, to], width: .25, layer, head: true}], vias: [], pushed: [], hidden: [], corner: "45", layer});
// Run whatever route-feel queued, so its single-flight rAF guard is clear before each test.
const drain = () => { for (let k = 0; k < 50 && (rafQueue.length || micro.length); k++) { const q = rafQueue.splice(0), m = micro.splice(0); for (const f of m) f(); for (const f of q) f(T); } };
const reset = () => { F.frame(null, false); drain(); };

// ---------------------------------------------------------------- snapping
test("45° ray: a diagonal snap from an on-grid anchor lands on a grid point", () => {
  reset(); T += 1000;
  F.frame(head([12, 12], [13, 13]), true);   // anchor (12, 12), on the 0.25 grid
  const q = F.snap([15.03, 14.98]);          // pointer 0.05 mm off the diagonal
  assert.equal(F.debug().snap.kind, "ray");
  assert.ok(onGrid(q[0], .25) && onGrid(q[1], .25), "diagonal ray point is off the grid: " + q + " (s rounded along the ray, not per axis)");
  reset();
});

test("ray never takes the head off the grid point the pointer is exactly on", () => {
  reset(); T += 1000;
  F.frame(head([12.13, 12.07], [12.6, 12.6]), true);   // anchor off grid (a pad centre)
  const q = F.snap([14, 14]);                         // pointer exactly on a grid crossing, within 0.6 R of the 45° ray
  assert.deepEqual(q, [14, 14], "ray snap moved an exact grid click to " + q + " (" + F.debug().snap.label + ")");
  reset();
});

test("pad entry ignores pads of other nets while routing", () => {
  reset(); T += 1000; routeNet = "A";
  F.frame(head([5, 5], [6, 5]), true);
  const q = F.snap([7.3, 5.2]);   // inside net B's pad p2
  assert.notDeepEqual(q, [7, 5], "head snapped to the centre of a net B pad while routing net A (" + F.debug().snap.label + ")");
  reset();
});

test("object snap ignores vias of other nets while routing", () => {
  reset(); T += 1000; routeNet = "A";
  F.frame(head([18, 18], [19, 19]), true);
  const q = F.snap([20.4, 20.3]);  // 0.5 mm from net B's via
  assert.notDeepEqual(q, [20, 20], "head snapped onto a net B via while routing net A");
  reset();
});

test("pad entry ignores an SMD pad on the other side", () => {
  reset(); T += 1000; routeNet = "A"; routeLayer = "Top";
  F.frame(head([5, 5], [6, 5]), true);
  const q = F.snap([9.35, 5.3]);   // inside p3, a Bottom SMD pad, while routing on Top
  assert.notDeepEqual(q, [9, 5], "head snapped to a Bottom-side SMD pad while routing on Top");
  reset();
});

test("a held object target survives a nearer candidate that is still outside the radius", () => {
  reset(); T += 1000;
  F.frame(head([27, 27], [28, 28]), true);
  assert.deepEqual(F.snap([30.7, 30.05]), [30, 30]);           // v1 at 0.7 mm (< R = 0.8)
  const q = F.snap([31.1, 30.05]);                               // v1 at 1.1 mm (< 1.6 R), v2 at 0.95 mm (> R)
  assert.deepEqual(q, [30, 30], "dropped the held via for the grid (" + F.debug().snap.kind + " " + q + ")");
  reset();
});

// ---------------------------------------------------------------- animation cadence
test("an animating frame asks for the next frame directly, not through an extra rAF hop", () => {
  reset(); T += 5000; F.frame(null, false); drain(); motion = null; redraws = 0;
  const shoved = {id: "t9", kind: "track", layer: "Top", width: .25, points: [[0, 1], [4, 1]]};
  board.items.push({id: "t9", kind: "track", layer: "Top", width: .25, points: [[0, 0], [4, 0]], net: "C"});
  F.frame({...head([0, -2], [2, -2]), pushed: [shoved], hidden: ["t9"], status: "pushed"}, true);
  assert.ok(F.debug().anims > 0, "precondition: the shove is animating");
  // kick() today: requestAnimationFrame(() => redrawOverlay()) and redrawOverlay -> drawPointer ->
  // schedule() -> requestAnimationFrame again: every animation frame costs two vsyncs (30 fps at 60 Hz).
  assert.equal(rafQueue.length, 0, "route-feel requested its own rAF; the editor then requests another, so animation runs at half rate");
  assert.ok(micro.length + redraws > 0, "no redraw was requested at all");
  board.items.pop(); reset();
});

test("motion Off: the corner glyph and snap label still disappear without moving the pointer", () => {
  reset(); motion = "off"; T += 5000; F.frame(null, false); drain(); redraws = 0;
  F.frame(head([12, 12], [13, 13]), true);
  T += 16; F.frame({...head([12, 12], [13, 13]), corner: "90"}, true);   // Shift+Space: glyph shown
  F.snap([40.4, 40.1]);                                                    // a snap label appears
  // Nothing is scheduled, so the glyph and label painted now stay on screen until the next pointer move.
  assert.ok(rafQueue.length + micro.length + redraws > 0, "no redraw scheduled to remove the glyph/label after their hold time (they stay painted indefinitely)");
  motion = null; reset();
});

if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " route-feel-review test(s) failed"); }
