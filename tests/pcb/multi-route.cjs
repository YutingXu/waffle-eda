"use strict";
// Interactive Multi-Routing (app/pcb/multi-route.js): a bus of four nets is routed together, parallel at the
// clearance gap, around an obstacle, and verified with independent geometry (not the router's own checks).
const assert = require("node:assert/strict");
const {pointSeg, segSeg} = require("../support/segment-distance.cjs");
require("../../app/core/model.js");
require("../../app/pcb/router.js");
require("../../app/pcb/multi-route.js");
const R = AtriumRouter, M = AtriumMultiRoute;

// Edge-to-edge gap between two tracks.
function trackGap(t, u) {
  let m = Infinity;
  for (let i = 1; i < t.points.length; i++) for (let j = 1; j < u.points.length; j++) m = Math.min(m, segSeg(t.points[i - 1], t.points[i], u.points[j - 1], u.points[j]));
  return m - t.width / 2 - u.width / 2;
}
function padGap(t, p) {
  let m = Infinity;
  for (let i = 1; i < t.points.length; i++) m = Math.min(m, pointSeg([p.x, p.y], t.points[i - 1], t.points[i]));
  return m - t.width / 2 - p.w / 2;
}

const pad = (id, x, y, net, w = 0.6) => ({id, kind: "pad", x, y, w, h: w, shape: "round", drill: 0, layer: "Top", net});
function board(obstacle) {
  const items = [];
  const nets = ["D0", "D1", "D2", "D3"];
  nets.forEach((n, i) => items.push(pad("s" + i, 2, 10 + i * 1.0, n)));
  if (obstacle) items.push(pad("block", 15, 11.5, "GND", 3));
  return {id: "b", kind: "pcb", name: "Board", grid: 0.25, items, outline: [[0, 0], [40, 0], [40, 30], [0, 30]],
    rules: {version: 1, clearance: 0.2, trackWidth: 0.2}};
}
const defs = new Map();
const startsOf = b => b.items.filter(i => /^s\d$/.test(i.id)).map(p => ({at: [p.x, p.y], net: p.net, layer: "Top"}));

// 1. Straight bus: four parallel tracks at the pitch, ends fanned out across the target.
{
  const b = board(false);
  const r = M.plan(b, defs, {starts: startsOf(b), to: [30, 11.5], layer: "Top", width: 0.2});
  assert.equal(r.ok, true, JSON.stringify(r.members));
  assert.equal(r.routed, 4);
  assert.ok(Math.abs(r.gap - 0.2) < 1e-9, "the gap is the clearance rule");
  assert.ok(Math.abs(r.pitch - 0.4) < 1e-9);
  assert.deepEqual(r.order, ["D0", "D1", "D2", "D3"]);
  assert.equal(r.strategy, "trunk");
  const tracks = r.plan.add.filter(i => i.kind === "track");
  assert.equal(tracks.length, 4);
  for (const t of tracks) assert.equal(t.width, 0.2);
  // Ends sit at the pitch across the target.
  const ends = r.members.map(m => m.to[1]).sort((a, b) => a - b);
  for (let i = 1; i < ends.length; i++) assert.ok(Math.abs(ends[i] - ends[i - 1] - 0.4) < 2e-3, "ends at the pitch: " + ends);
  for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) assert.ok(trackGap(tracks[i], tracks[j]) >= 0.2 - 1e-6, "clearance between members");
  // Nothing in the input board changed.
  assert.equal(b.items.length, 4);
}

// 2. Around an obstacle: the bus walks round it as a group, every member keeps clearance to it and to the others.
{
  const b = board(true);
  const r = M.plan(b, defs, {starts: startsOf(b), to: [30, 11.5], layer: "Top", width: 0.2});
  assert.equal(r.routed, 4, JSON.stringify(r.members));
  const tracks = r.plan.add.filter(i => i.kind === "track"), block = b.items.find(i => i.id === "block");
  for (const t of tracks) assert.ok(padGap(t, block) >= 0.2 - 1e-6, t.net + " clears the obstacle: " + padGap(t, block));
  for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) assert.ok(trackGap(tracks[i], tracks[j]) >= 0.2 - 1e-6, "members keep the gap");
  // Applying the plan gives a board the router's own checker accepts.
  const after = R.apply(JSON.parse(JSON.stringify(b)), r.plan), W = R.world(after, defs), rules = R.core.rulesFor(after);
  for (const t of after.items.filter(i => i.kind === "track")) assert.ok(R.check(W, rules, t).ok, t.net + " passes the router check");
  // The bus stays together: every member goes round the same side of the obstacle.
  // Where each track crosses x = 15 (the obstacle's centre line): all above it or all below it.
  const yAt = t => { for (let i = 1; i < t.points.length; i++) { const [a, b] = [t.points[i - 1], t.points[i]]; if ((a[0] - 15) * (b[0] - 15) <= 0 && a[0] !== b[0]) return a[1] + (b[1] - a[1]) * (15 - a[0]) / (b[0] - a[0]); } return null; };
  const sides = tracks.map(t => Math.sign(yAt(t) - 11.5));
  assert.ok(sides.every(v => v !== 0) && new Set(sides).size === 1, "one side of the obstacle: " + sides);
  assert.equal(r.strategy, "trunk", "routed as one group");
  // Neighbours stay at the pitch across the obstacle.
  const ys = tracks.map(yAt).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i++) assert.ok(Math.abs(ys[i] - ys[i - 1] - 0.401) < 0.01, "parallel at the pitch: " + ys);
}

// 3. Explicit ends, a wider gap, and the editor's selection helper.
{
  const b = board(false);
  const ends = [[30, 5], [30, 6], [30, 7], [30, 8]];
  const r = M.plan(b, defs, {starts: startsOf(b), ends, layer: "Top", width: 0.25, gap: 0.5});
  assert.equal(r.routed, 4);
  assert.ok(Math.abs(r.pitch - 0.75) < 1e-9);
  const tracks = r.plan.add.filter(i => i.kind === "track");
  for (const m of r.members) { const t = tracks.find(x => x.net === m.net); assert.deepEqual(t.points[t.points.length - 1], ends[m.index]); }
  const routed = R.apply(JSON.parse(JSON.stringify(b)), r.plan);
  const s = M.startsFrom(routed, routed.items.filter(i => i.kind === "track").map(i => i.id), [40, 6]);
  assert.equal(s.length, 4);
  for (const x of s) assert.equal(x.at[0], 30, "the track end nearest the target");
}

// 4. Refusals: too few starts, repeated nets, a gap below the rule, missing nets, no end.
{
  const b = board(false), st = startsOf(b);
  assert.throws(() => M.plan(b, defs, {starts: st.slice(0, 1), to: [30, 10]}), /at least two/);
  assert.throws(() => M.plan(b, defs, {starts: [st[0], {...st[1], net: "D0"}], to: [30, 10]}), /its own net/);
  assert.throws(() => M.plan(b, defs, {starts: st, to: [30, 10], gap: 0.05}), /below the clearance rule/);
  assert.throws(() => M.plan(b, defs, {starts: [st[0], {...st[1], net: ""}], to: [30, 10]}), /on a net/);
  assert.throws(() => M.plan(b, defs, {starts: st}), /end point/);
  assert.throws(() => M.plan(b, defs, {starts: st, ends: [[1, 1]]}), /one end per start/);
  assert.throws(() => M.plan(b, defs, {starts: st, to: [30, 10], layer: "Silk"}), /copper layer/);
}

console.log("SHIM-OK multi-route");
