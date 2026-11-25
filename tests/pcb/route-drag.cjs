"use strict";
// Dynamic re-route on component drag (AtriumRouter.dragSession) and tabbed routing
// (AtriumRouter.tabs). Clearances are verified with an independent geometry checker.
const assert = require("node:assert/strict");
const {audit} = require("../support/placed-route-clearance.cjs");
const {segSeg} = require("../support/segment-distance.cjs");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/pcb/router.js");
require("../../app/pcb/diffpair.js");
require("./dense-board.js");
const R = globalThis.AtriumRouter;
const timer = typeof performance !== "undefined" ? () => performance.now() : typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
const cases = [];
const test = (name, run) => cases.push({name, run});

// Copper primitives of board items, with part pads in world coordinates (square pads as 4 edges + radius 0).
const pad = (number, x, y) => ({number, x, y, w:.8, h:.8, shape:"rect", layer:"Top"});
const defs = new Map([["d2", {id:"d2", footprint:{pads:[pad("1", -1, 0), pad("2", 1, 0)]}}]]);
const clone = o => JSON.parse(JSON.stringify(o));

test("dragging a part re-routes its connection around obstacles to the first fixed anchor", () => {
  const board = {kind:"pcb", items:[
    {id:"U1", kind:"part", def:"d2", x:0, y:0, angle:0, pinNets:{1:"A", 2:"B"}},
    {id:"t", kind:"track", points:[[-1, 0], [-4, 0], [-8, 0]], width:.25, layer:"Top", net:"A"},
    {id:"v", kind:"via", x:-8, y:0, diameter:.6, drill:.3, layer:"Multi", net:"A"},
    {id:"wall", kind:"track", points:[[-3.5, 1.2], [-3.5, 6]], width:.25, layer:"Top", net:"C"}
  ], outline:[[-15, -10], [10, -10], [10, 10], [-15, 10]]};
  const s = R.dragSession(board, defs, ["U1"], {revision:1});
  assert.equal(s.state.connections, 1);
  const r = s.move([0, 3]);
  assert.equal(r.routed, 1, r.statusText);
  const t = r.pushed.find(p => p.id === "t");
  assert.deepEqual(t.points[0], [-1, 3]);
  assert.deepEqual(t.points.at(-1), [-8, 0], "ends on the via (the fixed anchor)");
  assert.ok(r.hidden.includes("t"));
  const moved = clone(board); moved.items[0].y = 3; moved.items[1].points = t.points;
  assert.ok(audit(moved.items, defs).worst >= -1e-6, "clear: " + JSON.stringify(audit(moved.items, defs)));
  assert.match(r.statusText, /1 re-routed/);
  const plan = s.commit();
  assert.deepEqual(plan.remove, []); assert.deepEqual(plan.add, []);
  assert.ok(plan.modify.some(m => m.id === "U1" && m.x === 0 && m.y === 3));
  assert.ok(plan.modify.some(m => m.id === "t" && m.points.length >= 2));
  // Session end restores the shared world: the old track blocks a route again.
  const W = R.world(board, defs, {revision:1});
  for (let f = 0; f < W.n; f++) assert.equal(W.dead[f] & 4, 0);
  R.apply(board, plan);
  assert.equal(board.items[0].y, 3);
});

test("far vertices anchor long tracks; nearby vertices are re-routed, the rest is kept", () => {
  const board = {kind:"pcb", items:[
    {id:"U1", kind:"part", def:"d2", x:0, y:0, angle:0, pinNets:{1:"A", 2:"B"}},
    {id:"t", kind:"track", points:[[-1, 0], [-2, 0], [-3, -1], [-9, -1], [-12, 2]], width:.2, layer:"Top", net:"A"}
  ]};
  const s = R.dragSession(board, defs, new Set(["U1"]), {reach:2});
  const r = s.move([0, 1]);
  const t = r.pushed[0].points;
  assert.deepEqual(t.at(-1), [-12, 2]);
  assert.ok(t.some(p => p[0] === -9 && p[1] === -1), "vertices beyond the anchor are unchanged");
  assert.deepEqual(t[0], [-1, 1]);
  s.cancel();
});

test("tracks between two moving pads translate rigidly; the limit falls back to rubber-banding", () => {
  const board = {kind:"pcb", items:[
    {id:"U1", kind:"part", def:"d2", x:0, y:0, angle:0, pinNets:{1:"A", 2:"A"}},
    {id:"short", kind:"track", points:[[-1, 0], [-1, -1], [1, -1], [1, 0]], width:.2, layer:"Top", net:"A"},
    {id:"t", kind:"track", points:[[1, 0], [4, 0], [7, 0]], width:.2, layer:"Top", net:"A"}
  ]};
  const s = R.dragSession(board, defs, ["U1"], {maxConnections:0});
  const r = s.move([0.5, 2]);
  assert.equal(r.rigid, 1);
  assert.deepEqual(r.pushed.find(p => p.id === "short").points, [[-.5, 2], [-.5, 1], [1.5, 1], [1.5, 2]]);
  const t = r.pushed.find(p => p.id === "t");
  assert.equal(t.status, "rubber");
  assert.deepEqual(t.points, [[1.5, 2], [4, 0], [7, 0]], "the pad segment rubber-bands");
  assert.match(r.statusText, /rubber-banded \(limit 0\)/);
  assert.equal(s.setMaxConnections(4), 4);
  assert.equal(s.move([0.5, 2]).routed, 1);
  s.setEnabled(false);
  assert.equal(s.move([0.5, 2]).routed, 0);
  s.cancel();
});

test("a reversed track (pad at its end) is re-routed and keeps its direction", () => {
  const board = {kind:"pcb", items:[
    {id:"U1", kind:"part", def:"d2", x:0, y:0, angle:0, pinNets:{1:"A", 2:"B"}},
    {id:"t", kind:"track", points:[[-6, 0], [-1, 0]], width:.2, layer:"Top", net:"A"}
  ]};
  const s = R.dragSession(board, defs, ["U1"]);
  const r = s.move([0, -2]);
  const t = r.pushed[0].points;
  assert.deepEqual(t[0], [-6, 0]); assert.deepEqual(t.at(-1), [-1, -2]);
  s.cancel();
});

// Extent of copper of `items` from the line y = y0 (max |y - y0| + half width).
const reachOf = (items, y0) => Math.max(...items.flatMap(t => t.points.map(p => Math.abs(p[1] - y0) + t.width / 2)));
function trackAudit(items, clearance) {
  let worst = Infinity;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j]; if (a.net === b.net || a.layer !== b.layer) continue;
    for (let k = 1; k < a.points.length; k++) for (let m = 1; m < b.points.length; m++)
      worst = Math.min(worst, segSeg(a.points[k - 1], a.points[k], b.points[m - 1], b.points[m]) - a.width / 2 - b.width / 2 - clearance);
  }
  return worst;
}

test("tabs: T-shaped capacitive tabs along a track, same-net tracks, pitch and extent", () => {
  const board = {kind:"pcb", items:[{id:"t", kind:"track", points:[[0, 0], [10, 0]], width:.2, layer:"Top", net:"S"}]};
  const plan = R.tabs(board, new Map(), {ids:["t"], pitch:1, tabWidth:.5, tabLength:.3, side:"left", shape:"T", rules:{clearance:.2}});
  assert.deepEqual(plan.remove, []); assert.deepEqual(plan.modify, []);
  assert.ok(plan.tabs >= 8 && plan.tabs <= 10, "tabs " + plan.tabs);
  assert.ok(plan.add.every(t => t.kind === "track" && t.net === "S" && t.layer === "Top" && t.groupId === plan.groupId));
  // Left of travel is +y here (the router's convention: normal (-uy, ux)); the tab reaches w/2 + tabLength.
  assert.ok(Math.abs(reachOf(plan.add, 0) - (.1 + .3)) < 1e-6, "extent " + reachOf(plan.add, 0));
  assert.ok(plan.add.every(t => t.points.every(p => p[1] >= -1e-9)), "one side only");
  const xs = [...new Set(plan.add.map(t => t.points[0][0]))].sort((a, b) => a - b);
  for (let i = 1; i < xs.length; i++) assert.ok(Math.abs(xs[i] - xs[i - 1] - 1) < 1e-6, "pitch");
  const both = R.tabs(board, new Map(), {ids:["t"], pitch:1, side:"both", shape:"T", tabLength:.3, rules:{clearance:.2}});
  assert.equal(both.tabs, 2 * plan.tabs);
});

test("tabs: a pair's inner tabs are staggered and keep the minimum gap; trapezoids are one serpentine track", () => {
  const board = {kind:"pcb", items:[
    {id:"p", kind:"track", points:[[0, 0], [12, 0]], width:.2, layer:"Top", net:"D_P"},
    {id:"n", kind:"track", points:[[0, .8], [12, .8]], width:.2, layer:"Top", net:"D_N"}]};
  const plan = R.tabs(board, new Map(), {ids:["p", "n"], pitch:1.4, tabWidth:.4, tabLength:.5, side:"inner", minGap:.2, rules:{clearance:.2}});
  assert.ok(plan.tabs >= 14, "tabs " + plan.tabs + " " + JSON.stringify(plan.skipped));
  const P = plan.add.filter(t => t.net === "D_P"), N = plan.add.filter(t => t.net === "D_N");
  assert.ok(P.every(t => t.points.every(p => p[1] >= -1e-9)) && N.every(t => t.points.every(p => p[1] <= .8 + 1e-9)), "inner side");
  const px = P.map(t => t.points[0][0]), nx = N.map(t => t.points[0][0]);
  assert.ok(px.every(x => nx.every(y => Math.abs(x - y) > .4)), "staggered");
  assert.ok(trackAudit([...board.items, ...plan.add], .2) >= -1e-6, "the pair keeps its 0.2 mm minimum gap: " + trackAudit([...board.items, ...plan.add], .2));
  const trap = R.tabs(board, new Map(), {ids:["p"], pitch:1.5, tabWidth:.6, baseWidth:.3, tabLength:.4, shape:"trapezoid", side:"outer", rules:{clearance:.15}});
  assert.equal(trap.items, trap.tabs, "one track per trapezoid tab");
  assert.ok(trap.add.every(t => t.points.length >= 4 && t.points.every(p => p[1] <= 1e-9)));
  assert.ok(Math.abs(reachOf(trap.add, 0) - (.1 + .4)) < 1e-6);
  assert.ok(trap.uncoupledAdded > 0, "outer tabs are uncoupled length");
});

test("tabs skip positions that would violate clearance and corners", () => {
  const board = {kind:"pcb", items:[
    {id:"t", kind:"track", points:[[0, 0], [6, 0], [6, 6]], width:.2, layer:"Top", net:"S"},
    {id:"v", kind:"via", x:3, y:.6, diameter:.4, drill:.2, layer:"Multi", net:"X"}]};
  const plan = R.tabs(board, new Map(), {ids:["t"], pitch:.8, tabLength:.3, tabWidth:.6, side:"left", rules:{clearance:.2}});
  assert.ok(plan.skipped.some(s => s.reason === "clearance"));
  assert.ok(plan.skipped.some(s => s.reason === "corner"));
  const all = [...board.items.filter(i => i.kind === "track"), ...plan.add, {id:"vv", kind:"track", points:[[3, .6], [3, .6]], width:.4, layer:"Top", net:"X"}];
  assert.ok(trackAudit(all, .2) >= -1e-6);
});

test("dense 25k-object board: drag re-route of 16 connections stays within the frame budget", () => {
  const {d, defs:bd} = makeAtriumBenchmarkBoard();
  let k = 0; for (const i of d.items) if (i.kind === "via" || i.kind === "track") i.net = "N" + (k++ % 400);
  const parts = d.items.filter(i => i.kind === "part");
  // Eight parts near the middle, each pad wired to a fresh via 2.4 mm away (16 connections).
  const chosen = parts.slice(parts.length / 2, parts.length / 2 + 8);
  const fp = bd.get("std-r").footprint, rules = R.core.rulesFor(d);
  // Each connection goes where a straight track and its via are clear on the dense board.
  for (const p of chosen) p.pinNets = Object.fromEntries(fp.pads.map(pd => [pd.number, "D" + p.id + "_" + pd.number]));
  const W0 = R.world(d, bd, {revision:"pre"});
  const extra = [];
  for (const p of chosen) {
    for (const pd of fp.pads) {
      const net = p.pinNets[pd.number];
      const c = Atrium.world([pd.x, pd.y], p);
      let best = null;
      for (let a = 0; a < 16 && !best; a++) for (const L of [2.4, 1.6, 1.0]) {
        const v = [c[0] + Math.cos(a * Math.PI / 8) * L, c[1] + Math.sin(a * Math.PI / 8) * L];
        const okT = R.check(W0, rules, {points:[c, v], width:.15, layer:"Top", net}).ok, okV = R.check(W0, rules, {points:[v, v], width:.5, layer:"Top", net}).ok;
        if (okT && okV && extra.every(e => Math.hypot(e.x - v[0], e.y - v[1]) > 1.2)) { best = v; break; }
      }
      if (!best) best = [c[0], c[1] - 1];
      d.items.push({id:"dt" + p.id + pd.number, kind:"track", points:[c, [(c[0] + best[0]) / 2, (c[1] + best[1]) / 2], best], width:.15, layer:"Top", net});
      const via = {id:"dv" + p.id + pd.number, kind:"via", x:best[0], y:best[1], diameter:.5, drill:.25, layer:"Multi", net};
      d.items.push(via); extra.push(via);
    }
  }
  const t0 = timer(); R.world(d, bd, {revision:"drag"}); const build = timer() - t0;
  const ids = chosen.map(p => p.id), times = [];
  const t1 = timer(); const s = R.dragSession(d, bd, ids, {revision:"drag", maxConnections:16}); const start = timer() - t1;
  let routed = 0;
  for (let i = 1; i <= 60; i++) {
    const t = timer(); const r = s.move([0.05 * i, 0.03 * i]); times.push(timer() - t); routed += r.routed;
  }
  assert.equal(s.state.connections, 16);
  s.cancel();
  times.sort((a, b) => a - b);
  const median = times[times.length >> 1], p95 = times[Math.floor(times.length * .95)], max = times.at(-1);
  console.log("  drag bench: world build " + build.toFixed(1) + " ms, session start " + start.toFixed(2) + " ms; move median " + median.toFixed(2) + " ms, p95 " + p95.toFixed(2) + " ms, max " + max.toFixed(2) + " ms; " + (routed / 60).toFixed(1) + " of 16 connections routed per move");
  assert.ok(median < 4.5, "median move " + median);
  assert.ok(max < 12, "worst move " + max);
});

let failed = 0;
for (const c of cases) {
  try { c.run(); console.log("PASS " + c.name); }
  catch (e) { failed++; console.log("FAIL " + c.name + "\n  " + (e && e.message || e)); }
}
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " route-drag test(s) failed"); }
