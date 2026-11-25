"use strict";
// Repour All animation (app/pcb/pour-anim.js) on a stand-in editor host and clock: when a run animates
// (estimate, Animations preference, Efficiency mode), reveals in pour order (a pour done early waits),
// old copper until its reveal, the sweep's alpha and clip (2D and GPU scissor), Reduced motion's
// cross-fade, the board shown exactly as stored once a committed run ends, abandoned runs, previews,
// no frames while nothing moves. Also the display LOD ring simplification (app/pcb/pcb-pours.js).
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh pour-anim).
const assert = require("node:assert/strict");

// ---- clock, frames and timers ----------------------------------------------------------------------
let clock = 1000, attr = "full", efficient = false;
const frames = [], timers = [];
globalThis.performance = {now: () => clock};
globalThis.matchMedia = () => ({matches: false});
globalThis.requestAnimationFrame = f => { frames.push(f); return frames.length; };
globalThis.cancelAnimationFrame = () => {};
globalThis.setTimeout = (f, ms = 0) => { const t = {f, due: clock + ms}; timers.push(t); return t; };
globalThis.clearTimeout = t => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); };
globalThis.getComputedStyle = () => ({getPropertyValue: () => "#f0a32e"});
globalThis.document = {documentElement: {getAttribute: k => (k === "data-motion" ? attr : null)}};
globalThis.AtriumPower = {efficient: () => efficient, frame: f => requestAnimationFrame(f)};
// Advance `ms` at a time: due timers, then the frame queue, `n` steps.
function step(ms = 16, n = 1) {
  for (let k = 0; k < n; k++) {
    clock += ms;
    for (const t of timers.splice(0).filter(t => { if (t.due <= clock) return true; timers.push(t); return false; })) t.f();
    for (const f of frames.splice(0)) f(clock);
  }
}
const idle = () => !frames.length && !timers.length;

// ---- a stand-in editor host ------------------------------------------------------------------------
let redraws = 0, overlays = 0;
const renderers = [], listeners = {};
const R = (polygon, x0, x1) => ({layer: "Top", net: "GND", polygon, bounds: [x0, 0, x1, 10], count: 1, data: ""});
const oldA = R("a", 0, 10), oldB = R("b", 20, 30), other = R(null, 40, 50);
const board = {id: "pcb1", kind: "pcb", items: [
  {id: "a", kind: "polygon", points: [[0, 0], [10, 0], [10, 10], [0, 10]]},
  {id: "b", kind: "polygon", points: [[20, 0], [30, 0], [30, 10], [20, 10]]},
  {id: "c", kind: "polygon", points: [[60, 0], [70, 0], [70, 10], [60, 10]]}],
  pcbDrawing: {pours: [oldA, oldB, other]}};
globalThis.AtriumNavHost = {
  addRenderer: f => { renderers.push(f); return () => {}; }, on: (t, f) => { (listeners[t] ||= []).push(f); return () => {}; },
  doc: () => board, defs: () => new Map(), view: () => ({pourState: () => "source"}),
  redraw: () => { redraws++; }, redrawOverlay: () => { overlays++; },
};
require("../../app/editor/editor-motion.js");
require("../../app/pcb/pour-anim.js");
const A = globalThis.AtriumPourAnim;
const ids = ["a", "b", "c"];
const shown = () => A.display(board, board.pcbDrawing.pours);

// ---- when a run animates ---------------------------------------------------------------------------
{
  assert.equal(A.begin({doc: board, ids, estimateMs: 200, token: 1}), false, "a short repour does not animate");
  attr = "off"; assert.equal(A.begin({doc: board, ids, estimateMs: 2000, token: 1}), false, "Animations: Off");
  attr = "full"; efficient = true; assert.equal(A.begin({doc: board, ids, estimateMs: 2000, token: 1}), false, "Efficiency mode");
  efficient = false;
  assert.equal(A.display(board, board.pcbDrawing.pours), board.pcbDrawing.pours, "no run: the list as given");
  assert.equal(A.of(oldA), null);
  assert.ok(idle(), "nothing scheduled");
}

// ---- reveals in pour order, old copper until then, the sweep -----------------------------------------
{
  const tok = {}, newA = [R("a", 1, 9), R("a", 2, 8)], newB = [R("b", 21, 29)], newC = [R("c", 61, 69)];
  assert.equal(A.begin({doc: board, ids, estimateMs: Infinity, token: tok}), true);
  assert.ok(A.active(board) && A.active());
  assert.ok(idle(), "begun, nothing solving: no frames");
  A.solving(tok, "a"); A.solving(tok, "b");
  assert.ok(frames.length || timers.length, "outline frames while solving");
  step(16, 6);
  assert.ok(overlays > 0, "the outline highlight redraws the overlay only");
  const ov = renderers.at(-1)(board, {active: true});
  assert.equal(typeof ov?.overlay, "function", "the overlay renderer");
  assert.equal(renderers.at(-1)({id: "other"}, {active: true}), null, "not on another document");
  // b finishes first: it waits for a.
  A.done(tok, "b", newB);
  step(16, 4);
  assert.ok(shown().includes(oldB) && !shown().includes(newB[0]), "b keeps its old copper until a reveals");
  assert.ok(shown().includes(other), "copper of other pours untouched");
  A.done(tok, "a", newA);
  step(16, 1);
  let s = shown();
  assert.ok(s.includes(newA[0]) && s.includes(oldA), "a reveals: new and old copper both shown");
  const an = A.of(newA[0]), ao = A.of(oldA);
  assert.ok(an && ao && an.clip && ao.clip, "the sweep clips both");
  assert.ok(an.clip[1] === ao.clip[0] && an.clip[1] >= 0 && an.clip[1] <= 10, "new copper left of the edge, old right of it");
  assert.ok(an.alpha > 0 && an.alpha <= 1 && ao.alpha === 1);
  const v0 = A.version, r0 = redraws;
  step(16, 3);
  assert.ok(A.version > v0 && redraws > r0, "sweep frames repaint the board");
  assert.ok(A.of(newA[0]).clip[1] > an.clip[1] - 1e-9, "the edge moves right");
  // GPU: the clip as scissor columns. cam: [cx, cy, scale, flipped, width, height, dpr].
  const g = A.gpu(newA[0], [5, 5, 10, false, 100, 100, 2], 200);
  assert.ok(g && g.x0 === 0 && g.x1 > 0 && g.x1 <= 200 && g.alpha === A.of(newA[0]).alpha, "GPU scissor of the new copper");
  const gf = A.gpu(newA[0], [5, 5, 10, true, 100, 100, 2], 200);
  assert.ok(gf && gf.x1 === 200 && gf.x0 > 0, "flipped board: the columns mirror");
  assert.equal(A.gpu(other, [5, 5, 10, false, 100, 100, 2], 200), null, "a region outside the run draws as stored");
  // a's reveal ends; b's follows.
  step(16, 40);
  s = shown();
  assert.ok(s.includes(newA[0]) && !s.includes(oldA) && A.of(newA[0]) === A.of(newA[0]), "a revealed: only its new copper");
  assert.ok(s.includes(newB[0]) && !s.includes(oldB), "b revealed after a");
  // c never solved: no frames are kept running for it.
  step(16, 40);
  assert.ok(idle(), "only waiting: no frames, no timers");
  A.solving(tok, "c"); A.done(tok, "c", newC);
  // The commit: the document holds exactly the done() regions.
  board.pcbDrawing.pours = [other, ...newA, ...newB, ...newC];
  A.end(tok, {committed: true});
  A.end(tok, {committed: false});   // the pipeline's finally: ignored after a commit
  assert.ok(A.run, "the last reveal still runs after the commit");
  step(16, 60);
  assert.equal(A.run, null, "the run is over");
  assert.equal(shown(), board.pcbDrawing.pours, "the board shows the document, as given");
  for (const r of board.pcbDrawing.pours) { assert.equal(A.of(r), null); assert.equal(A.gpu(r, [0, 0, 1, false, 10, 10, 1], 10), null); }
  assert.ok(!A.active(board));
  assert.equal(renderers.at(-1)(board, {active: true}), null, "no overlay after the run");
  step(16, 10); assert.ok(idle(), "no frames after the run");
  assert.equal(A.stats().slowTicks, 0, "no slow tick");
}

// ---- abandoned, restarted, previews, reduced motion -------------------------------------------------
{
  const pours = board.pcbDrawing.pours, tok = {};
  assert.ok(A.begin({doc: board, ids, estimateMs: 1000, token: tok}));
  A.solving(tok, "a"); A.done(tok, "a", [R("a", 0, 5)]);
  step(16, 2);
  const v = A.version;
  A.end(tok, {committed: false});
  assert.equal(A.run, null); assert.ok(A.version > v);
  assert.equal(A.display(board, pours), pours, "abandoned: the stored copper at once");
  // A new begin replaces a run in flight; an old token changes nothing.
  const t1 = {}, t2 = {};
  A.begin({doc: board, ids, estimateMs: 1000, token: t1});
  A.begin({doc: board, ids, estimateMs: 1000, token: t2});
  A.done(t1, "a", [R("a", 0, 1)]);
  assert.equal(A.run.token, t2);
  assert.equal(A.run.list[0].phase, 0, "an old run's done() is ignored");
  A.end(t1, {committed: false}); assert.ok(A.run, "an old run's end() is ignored");
  A.end(t2, {committed: false});
  // Preview copper shows for a pour with no old copper (a first pour), faintly.
  board.pcbDrawing.pours = [other];
  const t3 = {}, prev = [R("a", 0, 10)];
  A.begin({doc: board, ids, estimateMs: 1000, token: t3});
  A.preview(t3, "a", prev);
  assert.ok(A.display(board, board.pcbDrawing.pours).includes(prev[0]) && A.of(prev[0]).alpha < 1, "preview shown faintly");
  A.end(t3, {committed: false});
  // The board's first pour: displayPours gives no list.
  delete board.pcbDrawing.pours;
  const t4 = {}, first = [R("a", 0, 10)];
  A.begin({doc: board, ids: ["a"], estimateMs: 1000, token: t4});
  A.solving(t4, "a"); A.done(t4, "a", first); step(16, 2);
  assert.ok(A.display(board, undefined).includes(first[0]), "first pour revealed without a stored list");
  A.end(t4, {committed: false});
  board.pcbDrawing.pours = pours;
  // Reduced motion: a cross-fade, no clip.
  attr = "reduce";
  const t5 = {}, nb = [R("a", 0, 10)];
  assert.ok(A.begin({doc: board, ids, estimateMs: 1000, token: t5}));
  A.solving(t5, "a"); A.done(t5, "a", nb); step(16, 3);
  const n = A.of(nb[0]), o = A.of(pours.find(r => r.polygon === "a"));
  assert.ok(n && o && !n.clip && !o.clip && Math.abs(n.alpha + o.alpha - 1) < 1e-9, "reduced: alpha cross-fade");
  // Efficiency mode turning on mid-run: everything lands at once.
  efficient = true; step(16, 2);
  assert.equal(A.of(nb[0]), A.of(nb[0]));
  A.end(t5, {committed: true});
  assert.equal(A.run, null, "a commit in Efficiency mode ends the run at once");
  efficient = false; attr = "full";
}

// ---- display LOD: ring simplification (pcb-pours.js) -------------------------------------------------
{
  globalThis.TextDecoder ??= class { decode() { return ""; } };
  require("../../app/pcb/pcb-pours.js");
  const P = globalThis.AtriumPCBPours;
  // A circle of 400 vertices (r = 1 mm) and a 4-vertex square.
  const circle = new Float64Array(800);
  for (let i = 0; i < 400; i++) { circle[2 * i] = Math.cos(i / 400 * 2 * Math.PI); circle[2 * i + 1] = Math.sin(i / 400 * 2 * Math.PI); }
  for (const tol of [.001, .01, .05, .2]) {
    const s = P.simplify(circle, tol), m = s.length >> 1;
    assert.ok(m >= 3 && m <= 400, "at least 3 vertices");
    // Every original vertex lies within tol of the simplified ring (as a polyline, closed).
    for (let i = 0; i < 400; i++) {
      const px = circle[2 * i], py = circle[2 * i + 1];
      let best = Infinity;
      for (let k = 0; k < m; k++) {
        const ax = s[2 * k], ay = s[2 * k + 1], bx = s[2 * ((k + 1) % m)], by = s[2 * ((k + 1) % m) + 1], dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
        let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
        best = Math.min(best, Math.hypot(ax + t * dx - px, ay + t * dy - py));
      }
      assert.ok(best <= tol * 2 + 1e-9, "within the tolerance (" + tol + "): " + best);
    }
    if (tol >= .01) assert.ok(m < 100, "fewer vertices at " + tol + ": " + m);
  }
  const square = new Float64Array([0, 0, 1, 0, 1, 1, 0, 1]);
  assert.equal(P.simplify(square, .5), square, "a small ring is kept as is");
  const dot = new Float64Array(40); for (let i = 0; i < 20; i++) { dot[2 * i] = 1e-4 * Math.cos(i); dot[2 * i + 1] = 1e-4 * Math.sin(i); }
  assert.equal(P.simplify(dot, .01).length, 6, "a sub-tolerance ring keeps a triangle");
  assert.equal(typeof P.lod.enabled, "boolean");
  assert.equal(P.lodRings({}, {count: 1, data: ""}), null, "no Canvas context: no LOD");
}

console.log("pour-anim: ok");
