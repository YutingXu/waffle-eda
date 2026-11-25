"use strict";
// Differential-pair pad entry: routing into fine-pitch pads finishes with a short uncoupled
// breakout from the coupled gap to each pad (neck-down to the rule minimum when needed),
// within the max uncoupled length, instead of stopping "Blocked".
const assert = require("node:assert/strict");
const {segSeg} = require("../support/segment-distance.cjs");
require("../../app/core/model.js");
require("../../app/pcb/router.js");
require("../../app/pcb/diffpair.js");
const DP = globalThis.AtriumDiffPair;
const cases = [];
const test = (name, run) => cases.push({name, run});

// Edge gap from a track piece to a rectangular pad (axis aligned), sampled along the piece.
function trackToPad(pts, w, pad) {
  let m = Infinity;
  for (let i = 1; i < pts.length; i++) for (let k = 0; k <= 40; k++) {
    const t = k / 40, p = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    const dx = Math.max(0, Math.abs(p[0] - pad.x) - pad.w / 2), dy = Math.max(0, Math.abs(p[1] - pad.y) - pad.h / 2);
    m = Math.min(m, Math.hypot(dx, dy) - w / 2);
  }
  return m;
}
const len = pts => pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0);

// A 0.5 mm-pitch QFN edge (0.8 x 0.28 mm pads at x = 20) with USB_P/USB_N on adjacent pins and
// other nets on both sides; the pair starts at two round pads 20 mm to the left.
const PITCH = .5;
function qfn() {
  const items = [
    {id:"sp", kind:"pad", x:0, y:-.5, w:.6, h:.6, shape:"round", layer:"Top", net:"USB_P"},
    {id:"sn", kind:"pad", x:0, y:.5, w:.6, h:.6, shape:"round", layer:"Top", net:"USB_N"}];
  ["G1", "G2", "G3", "USB_P", "USB_N", "G4", "G5", "G6"].forEach((net, k) =>
    items.push({id:"q" + k, kind:"pad", x:20, y:-1.5 + k * PITCH, w:.8, h:.28, shape:"rect", layer:"Top", net}));
  return {kind:"pcb", items, outline:[[-3, -8], [26, -8], [26, 11], [-3, 11]]};
}
// 0.35 mm traces with a 0.15 mm gap cannot run coupled between the QFN's neighbouring pads.
const RULE = {net:"USB_P", layer:"Top", start:[0, -.5], width:.35, gap:.15, minWidth:.2, minGap:.15, rules:{clearance:.2}, autoShrink:false};

test("fine-pitch QFN pair: finishes with an uncoupled pad entry instead of Blocked", () => {
  const board = qfn(), s = DP.begin(board, new Map(), {...RULE, maxUncoupled:2});
  const r = s.move([20, 0]);
  assert.notEqual(r.status, "blocked");
  assert.equal(r.status, "ok");
  assert.ok(r.reached, "the pair reaches the pads");
  assert.ok(r.entry, "a pad entry section is reported");
  assert.ok(r.entry.length > 0 && r.entry.length <= 2 + 1e-9, "within the max uncoupled length: " + r.entry.length);
  assert.ok(r.uncoupledOk, "total uncoupled within the rule");
  assert.ok(r.notes.some(n => /^Pad entry \d+\.\d{3} mm uncoupled/.test(n)), r.notes.join(" | "));
  assert.ok(r.entry.width < .35 - 1e-9 && r.entry.width >= .2 - 1e-9, "necks down to fit between the pads: " + r.entry.width);
  // Both traces end on their pad centres.
  const P = r.preview.filter(p => p.net === "USB_P"), N = r.preview.filter(p => p.net === "USB_N");
  const end = list => list.at(-1).points.at(-1);
  assert.ok(Math.hypot(end(P)[0] - 20, end(P)[1]) < 1e-9 && Math.hypot(end(N)[0] - 20, end(N)[1] - .5) < 1e-9);
  // Clearance: every trace piece keeps 0.2 mm from the other nets' pads, P keeps the gap rule from N's copper.
  for (const piece of r.preview) for (const pad of board.items.filter(i => i.kind === "pad" && i.shape === "rect" && i.net !== piece.net))
    assert.ok(trackToPad(piece.points, piece.width, pad) >= .2 - 1e-6, piece.net + " to " + pad.net + ": " + trackToPad(piece.points, piece.width, pad));
  let pn = Infinity;
  for (const a of P) for (const b of N) for (let i = 1; i < a.points.length; i++) for (let j = 1; j < b.points.length; j++)
    pn = Math.min(pn, segSeg(a.points[i - 1], a.points[i], b.points[j - 1], b.points[j]) - a.width / 2 - b.width / 2);
  assert.ok(pn >= .15 - 1e-6, "pair gap " + pn);
  // The coupled section stops outside the pad row (its end is the pad entry start).
  const c = r.centre[0].at(-1);
  assert.ok(c[0] < 20 - .4 - 1e-9, "coupled end outside the pads: " + c[0]);
  // Reported entry length is the length of each end fan.
  assert.ok(Math.abs(r.entry.P - r.entry.N) < 1e-6);
  // Clicking finishes the route; the commit has neck-down pieces for both nets.
  assert.ok(s.click().done);
  const plan = s.commit();
  assert.ok(plan.add.length >= 4, "full-width and neck-down pieces per net");
  assert.deepEqual([...new Set(plan.add.map(t => t.width))].sort(), [.2, .35]);
  assert.ok(plan.pairOk);
  assert.ok(Math.abs(len(P.flatMap((p, i) => i ? p.points.slice(1) : p.points)) - r.lengthP) < 1e-6);
});

test("pad entry respects the max uncoupled length", () => {
  const s = DP.begin(qfn(), new Map(), {...RULE, maxUncoupled:.2});
  const r = s.move([20, 0]);
  assert.ok(!r.entry || r.entry.length <= .2 + 1e-9);
  assert.ok(!r.reached, "no pad entry fits within 0.2 mm, so the route does not finish there");
});

test("pads the coupled pair fits between need no pad entry", () => {
  const s = DP.begin(qfn(), new Map(), {...RULE, width:.2, gap:.2, minWidth:.2, minGap:.2});
  const r = s.move([20, 0]);
  assert.equal(r.status, "ok"); assert.ok(r.reached); assert.equal(r.entry, null);
});

test("a pair that arrives crossed says so", () => {
  const board = qfn();
  for (const i of board.items) if (i.id === "q3") i.net = "USB_N"; else if (i.id === "q4") i.net = "USB_P";
  const s = DP.begin(board, new Map(), {...RULE, width:.2, gap:.2, minWidth:.2, minGap:.2});
  const r = s.move([20, .5]);
  assert.ok(r.notes.some(n => /arrive crossed/.test(n)), r.notes.join(" | "));
});

let failed = 0;
for (const c of cases) {
  try { c.run(); console.log("PASS " + c.name); }
  catch (e) { failed++; console.log("FAIL " + c.name + "\n  " + (e && e.message)); }
}
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " dp-entry test(s) failed"); }
console.log("dp-entry: " + cases.length + " tests passed");
