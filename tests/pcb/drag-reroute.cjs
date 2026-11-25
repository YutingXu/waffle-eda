"use strict";
// Dynamic re-route on component drag (app/pcb/drag-reroute.js, AtriumDragReroute). Clearances are verified
// with an independent geometry checker; DRC runs AtriumRules.drc on the result.
const assert = require("node:assert/strict");
const {audit} = require("../support/placed-route-clearance.cjs");
const {pointSeg} = require("../support/segment-distance.cjs");
const {publicPiDP} = require("../support/public-pidp.cjs");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/checks/connectivity.js");
require("../../app/checks/rules.js");
require("../../app/checks/drc.js");
require("../../app/pcb/router.js");
require("../../app/pcb/diffpair.js");
require("../../app/pcb/drag-reroute.js");
require("./dense-board.js");
const {now: timer, retrySamples} = require("../analysis/timing-check.js");
const R = globalThis.AtriumRouter, D = globalThis.AtriumDragReroute;
const cases = [];
const test = (name, run) => cases.push({name, run});
const clone = o => JSON.parse(JSON.stringify(o));
const sortedTimes = samples => samples.slice().sort((a, b) => a - b);

// ---------------------------------------------------------------- independent checker
const octilinear = pts => pts.every((p, i) => !i || (() => { const dx = Math.abs(p[0] - pts[i - 1][0]), dy = Math.abs(p[1] - pts[i - 1][1]); return dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6; })());
// Every net's copper is still one connected piece that touches each of its pads (an open shows up here).
function connected(board, defs, net) {
  const items = board.items.filter(i => i.kind === "track" && i.net === net), pads = [];
  for (const p of board.items.filter(i => i.kind === "part")) for (const pd of defs.get(p.def).footprint.pads) if (p.pinNets?.[pd.number] === net) pads.push([p.x + pd.x, p.y + pd.y, pd.w / 2, pd.h / 2]);
  for (const v of board.items.filter(i => i.kind === "via" && i.net === net)) pads.push([v.x, v.y, v.diameter / 2, v.diameter / 2]);
  const ends = items.map(t => [t.points[0], t.points.at(-1)]);
  const onPad = (p, q) => Math.abs(p[0] - q[0]) <= q[2] + 1e-6 && Math.abs(p[1] - q[1]) <= q[3] + 1e-6;
  const touches = (p, t) => t.points.some((q, k) => k && pointSeg(p, t.points[k - 1], q) < 1e-6);
  const nodes = [...items.map((t, k) => ({t, k})), ...pads.map(p => ({p}))], seen = new Set([0]), stack = [0];
  while (stack.length) {
    const a = nodes[stack.pop()];
    nodes.forEach((b, j) => {
      if (seen.has(j)) return;
      let link = false;
      if (a.t && b.t) link = ends[a.k].some(e => touches(e, b.t)) || ends[b.k].some(e => touches(e, a.t));
      else if (a.t && b.p) link = ends[a.k].some(e => onPad(e, b.p));
      else if (a.p && b.t) link = ends[b.k].some(e => onPad(e, a.p));
      if (link) { seen.add(j); stack.push(j); }
    });
  }
  return seen.size === nodes.length;
}

// ---------------------------------------------------------------- fixtures
const pad = (number, x, y, w = .8, h = .8) => ({number, x, y, w, h, shape:"rect", layer:"Top"});
const defs = new Map([["d2", {id:"d2", footprint:{pads:[pad("1", -1, 0), pad("2", 1, 0)]}}]]);
// A QFN with `n` pads a side at 0.5 mm pitch; each pad has a 0.6 mm escape, a 45° bend and a via.
function qfn(n = 6, opt = {}) {
  const pads = [], pitch = .5, half = (n - 1) * pitch / 2, edge = half + 1;
  let k = 1;
  for (let i = 0; i < n; i++) pads.push({...pad(String(k++), -edge, -half + i * pitch, .8, .25), side:"W"});
  for (let i = 0; i < n; i++) pads.push({...pad(String(k++), -half + i * pitch, edge, .25, .8), side:"S"});
  for (let i = 0; i < n; i++) pads.push({...pad(String(k++), edge, half - i * pitch, .8, .25), side:"E"});
  for (let i = 0; i < n; i++) pads.push({...pad(String(k++), half - i * pitch, -edge, .25, .8), side:"N"});
  const def = {id:"qfn", footprint:{pads:pads.map(({side, ...p}) => p)}};
  const items = [], pinNets = {}, x0 = opt.x || 0, y0 = opt.y || 0;
  for (const p of pads) {
    const net = (opt.netOf ? opt.netOf(p) : null) || "S" + p.number; pinNets[p.number] = net;
    const out = {W:[-1, 0], S:[0, 1], E:[1, 0], N:[0, -1]}[p.side], along = {W:[0, 1], S:[1, 0], E:[0, -1], N:[-1, 0]}[p.side];
    const c = [x0 + p.x, y0 + p.y], e = [c[0] + out[0] * .6, c[1] + out[1] * .6];
    const idx = (+p.number - 1) % n - (n - 1) / 2, fan = idx * .5;
    const b = [e[0] + out[0] * Math.abs(fan) + along[0] * fan, e[1] + out[1] * Math.abs(fan) + along[1] * fan];
    const v = [b[0] + out[0] * 1.6, b[1] + out[1] * 1.6];
    items.push({id:"t" + p.number, kind:"track", net, layer:"Top", width:.15, points:[c, e, b, v].filter((q, i, a) => !i || Math.hypot(q[0] - a[i - 1][0], q[1] - a[i - 1][1]) > 1e-9)});
    items.push({id:"v" + p.number, kind:"via", net, x:v[0], y:v[1], diameter:.45, drill:.2, layer:"Multi"});
  }
  items.unshift({id:"U1", kind:"part", def:"qfn", x:x0, y:y0, angle:0, pinNets, ref:"U1"});
  return {def, items};
}
function qfnBoard(n = 6, opt = {}) {
  const {def, items} = qfn(n, opt);
  const s = 12;
  return {board:{kind:"pcb", items:[...items, ...(opt.extra || [])], outline:[[-s, -s], [s, -s], [s, s], [-s, s]], ...(opt.board || {})}, defs:new Map([["qfn", def]])};
}
const applied = (board, plan) => { const b = clone(board); R.apply(b, plan); return b; };
const moveParts = (b, ids, d) => { for (const it of b.items) if (ids.includes(it.id)) { it.x += d[0]; it.y += d[1]; } return b; };

// ---------------------------------------------------------------- tests
test("re-route keeps the layer, width and corner style, and clears other copper", () => {
  const board = {kind:"pcb", items:[
    {id:"U1", kind:"part", def:"d2", x:0, y:0, angle:0, pinNets:{1:"A", 2:"B"}},
    {id:"t", kind:"track", points:[[-1, 0], [-4, 0], [-8, 0]], width:.3, layer:"Top", net:"A"},
    {id:"v", kind:"via", x:-8, y:0, diameter:.6, drill:.3, layer:"Multi", net:"A"},
    {id:"b", kind:"track", points:[[1, 0], [6, 0]], width:.4, layer:"Top", net:"B"},
    {id:"wall", kind:"track", points:[[-3.5, 1.2], [-3.5, 6]], width:.25, layer:"Top", net:"C"}
  ], outline:[[-15, -10], [10, -10], [10, 10], [-15, 10]]};
  const before = JSON.stringify(board);
  const s = D.dragSession(board, defs, ["U1"], {revision:1, depth:3});
  assert.equal(s.state.connections, 2);
  s.move([0, 3]); const r = s.flush();
  assert.equal(r.routed, 2, r.statusText);
  for (const id of ["t", "b"]) {
    const p = r.pushed.find(q => q.id === id), orig = board.items.find(i => i.id === id);
    assert.equal(p.layer, orig.layer); assert.equal(p.width, orig.width);
    assert.ok(octilinear(p.points), id + " keeps 45° corners: " + JSON.stringify(p.points));
  }
  assert.deepEqual(r.pushed.find(q => q.id === "t").points.at(-1), [-8, 0], "ends on the via");
  const plan = s.commit();
  assert.equal(JSON.stringify(board), before, "the session never writes to the board");
  const after = applied(board, plan);
  for (const id of ["t", "b"]) { const t = after.items.find(i => i.id === id), o = board.items.find(i => i.id === id); assert.equal(t.layer, o.layer); assert.equal(t.width, o.width); assert.ok(octilinear(t.points)); }
  assert.deepEqual(after.items.find(i => i.id === "U1").y, 3);
  assert.deepEqual(after.items.find(i => i.id === "wall"), board.items.find(i => i.id === "wall"), "unaffected copper never moves");
  const a = audit(after.items, defs); assert.ok(a.worst >= -1e-6, JSON.stringify(a));
  assert.ok(connected(after, defs, "A") && connected(after, defs, "B"));
});

test("90° corner style and arcs come from the router's current style", () => {
  const board = {kind:"pcb", items:[
    {id:"U1", kind:"part", def:"d2", x:0, y:0, angle:0, pinNets:{1:"A", 2:"B"}},
    {id:"t", kind:"track", points:[[-1, 0], [-6, 0]], width:.25, layer:"Top", net:"A"},
    {id:"v", kind:"via", x:-6, y:0, diameter:.6, drill:.3, layer:"Multi", net:"A"}], outline:[[-15, -10], [10, -10], [10, 10], [-15, 10]]};
  let s = D.dragSession(board, defs, ["U1"], {corner:"90", depth:10}); s.move([1, 2.5]);
  let t = s.flush().pushed.find(p => p.id === "t");
  assert.ok(t.points.every((p, i) => !i || Math.abs(p[0] - t.points[i - 1][0]) < 1e-6 || Math.abs(p[1] - t.points[i - 1][1]) < 1e-6), "90°: " + JSON.stringify(t.points));
  s.cancel();
  s = D.dragSession(board, defs, ["U1"], {corner:"45arc", depth:10}); s.move([1, 2.5]);
  t = s.flush().pushed.find(p => p.id === "t");
  assert.ok(t.points.length > 4 && !octilinear(t.points), "arc corners are polylines: " + t.points.length);
  s.cancel();
});

test("Esc restores everything exactly: the board is untouched and the routing world is as before", () => {
  const {board, defs:qd} = qfnBoard(6, {extra:[{id:"x1", kind:"track", net:"Z", layer:"Top", width:.2, points:[[-6, 6], [6, 6]]}]});
  const json = JSON.stringify(board);
  const W = R.world(board, qd, {revision:"esc"}), dead0 = W.dead.slice(0, W.nPersist), n0 = W.n, pn0 = W.pn;
  const fresh = () => { const s = D.dragSession(board, qd, ["U1"], {revision:"esc", mode:"push"}); s.move([.7, 1.9]); const r = s.flush(); s.cancel(); return JSON.stringify(r.pushed); };
  const first = fresh();
  const s = D.dragSession(board, qd, ["U1"], {revision:"esc", mode:"push"});
  for (let i = 1; i <= 25; i++) s.move([i * .1, i * .08]);
  s.flush(); s.setShift(true); s.cancel();
  assert.equal(JSON.stringify(board), json, "board unchanged");
  assert.deepEqual(Array.from(W.dead.slice(0, W.nPersist)), Array.from(dead0), "world flags restored");
  assert.equal(W.n, n0); assert.equal(W.pn, pn0);
  assert.equal(fresh(), first, "a new session after cancel sees the same world");
  assert.throws(() => s.move([0, 0]), /ended/);
});

test("the drop is one plan: applying it once gives the whole result, restoring the snapshot undoes all of it", () => {
  const {board, defs:qd} = qfnBoard(6);
  const snapshot = JSON.stringify(board);
  const s = D.dragSession(board, qd, ["U1"], {revision:"undo"});
  for (let i = 1; i <= 10; i++) s.move([i * .06, i * .045]);
  const plan = s.commit();
  assert.ok(plan.modify.some(m => m.id === "U1" && Math.abs(m.x - .6) < 1e-9 && Math.abs(m.y - .45) < 1e-9));
  assert.equal(plan.routed, 24); assert.ok(plan.glossed);
  // The editor applies the plan inside one edit() after its checkpoint: one undo entry.
  const history = [snapshot]; let doc = JSON.parse(snapshot);
  R.apply(doc, plan); history.push(JSON.stringify(doc));
  assert.equal(history.length, 2);
  doc = JSON.parse(history[0]);
  assert.equal(JSON.stringify(doc), snapshot, "undo restores the exact board");
  const after = JSON.parse(history[1]);
  for (const n of Object.values(after.items[0].pinNets)) assert.ok(connected(after, qd, n), n + " stays connected");
});

test("the live cap is honoured: the rest show as connection lines and are routed on the drop", () => {
  const {board, defs:qd} = qfnBoard(6);
  const s = D.dragSession(board, qd, ["U1"], {revision:"cap", cap:5});
  assert.equal(s.state.connections, 24); assert.equal(s.state.live, 5);
  s.move([.5, .8]); const r = s.flush();
  assert.equal(r.routed, 5, r.statusText); assert.equal(r.airwires.length, 19);
  assert.ok(r.airwires.every(a => a.live === false));
  assert.match(r.statusText, /live limit 5; routed on drop/);
  assert.equal(r.pushed.filter(p => p.status === "routed" || p.status === "pushed").length, 5);
  const plan = s.commit();
  assert.equal(plan.routed, 24); assert.equal(plan.rubber, 0);
  const after = applied(board, plan); moveParts(after, [], [0, 0]);
  const a = audit(after.items, qd, .2); assert.ok(a.worst >= -1e-6, JSON.stringify(a));
  // Raising the cap mid-drag makes more connections live.
  const s2 = D.dragSession(board, qd, ["U1"], {cap:2}); s2.setMaxConnections(30); s2.move([.2, .2]);
  assert.equal(s2.flush().routed, 24); s2.cancel();
  // The preference wins over the editor's default.
  globalThis.AtriumPref = {get:k => ({"routing.dragRerouteCap":7, "routing.dragRerouteDepth":1.5})[k]};
  try { const s3 = D.dragSession(board, qd, ["U1"], {maxConnections:32}); assert.equal(s3.state.cap, 7); assert.equal(s3.state.depth, 1.5); s3.cancel(); }
  finally { delete globalThis.AtriumPref; }
});

test("each move stays inside its time slice; latest wins and nothing starves", () => {
  retrySamples(() => {
    const {board, defs:qd} = qfnBoard(10);
    const s = D.dragSession(board, qd, ["U1"], {revision:"slice", frameMs:1.5, cap:40});
    const times = [], seen = new Set();
    try {
      for (let i = 1; i <= 40; i++) {
        const t = timer(); const r = s.move([i * .02, .5 * Math.sin(i / 5)]); times.push(timer() - t);
        for (const p of r.pushed) if (p.status === "routed" || p.status === "pushed") seen.add(p.id);
      }
      assert.equal(seen.size, 40, "every connection is re-routed at some point (" + seen.size + ")");
      const r = s.flush(); assert.equal(r.pending, false); assert.equal(r.routed, 40);
    } finally { s.cancel(); }
    return times;
  }, times => {
    const p90 = sortedTimes(times)[Math.floor(times.length * .9)];
    return p90 < 6 ? "" : "p90 drag move " + p90.toFixed(2) + " ms (budget < 6 ms)";
  });
});

test("chains of one-segment tracks are followed through plain joints to the via; branch points anchor", () => {
  const board = {kind:"pcb", items:[
    {id:"U1", kind:"part", def:"d2", x:0, y:0, angle:0, pinNets:{1:"A", 2:"B"}},
    {id:"s1", kind:"track", points:[[-1, 0], [-1.6, 0]], width:.2, layer:"Top", net:"A"},
    {id:"s2", kind:"track", points:[[-2.4, 0], [-1.6, 0]], width:.2, layer:"Top", net:"A"},
    {id:"s3", kind:"track", points:[[-2.4, 0], [-3.4, -1]], width:.2, layer:"Top", net:"A"},
    {id:"s4", kind:"track", points:[[-3.4, -1], [-9, -1]], width:.2, layer:"Top", net:"A"},
    {id:"v", kind:"via", x:-9, y:-1, diameter:.6, drill:.3, layer:"Multi", net:"A"},
    // B: a branch at (3, 0) (a T to a second pad elsewhere).
    {id:"b1", kind:"track", points:[[1, 0], [3, 0]], width:.2, layer:"Top", net:"B"},
    {id:"b2", kind:"track", points:[[3, 0], [8, 0]], width:.2, layer:"Top", net:"B"},
    {id:"b3", kind:"track", points:[[3, 0], [3, 5]], width:.2, layer:"Top", net:"B"}], outline:[[-15, -10], [10, -10], [10, 10], [-15, 10]]};
  const s = D.dragSession(board, defs, ["U1"], {depth:20});
  assert.equal(s.state.connections, 2);
  s.move([0, 2]); const r = s.flush();
  const a = r.pushed.find(p => p.id === "s1");
  assert.deepEqual(a.points.at(-1), [-9, -1], "followed to the via: " + JSON.stringify(a.points));
  assert.deepEqual(r.pushed.find(p => p.id === "b1").points.at(-1), [3, 0], "the branch point anchors");
  for (const id of ["s1", "s2", "s3", "s4", "b1"]) assert.ok(r.hidden.includes(id));
  assert.ok(!r.hidden.includes("b2") && !r.hidden.includes("b3"), "copper past a branch is not touched");
  const plan = s.commit();
  assert.deepEqual(plan.remove.sort(), ["s2", "s3", "s4"]);
  const after = applied(board, plan);
  assert.ok(connected(after, defs, "A") && connected(after, defs, "B"));
  assert.deepEqual(after.items.find(i => i.id === "b2"), board.items.find(i => i.id === "b2"));
  // A short depth stops the re-route part-way along a long straight piece; the rest is kept.
  const s2 = D.dragSession(board, defs, ["U1"], {depth:5}); s2.move([0, 1]);
  const p2 = s2.commit(), a2 = applied(board, p2);
  assert.ok(a2.items.some(i => i.id === "s4"), "the far piece stays");
  assert.ok(connected(a2, defs, "A"));
});

test("push mode shoves other copper; walkaround leaves it alone", () => {
  const board = {kind:"pcb", items:[
    {id:"U1", kind:"part", def:"d2", x:0, y:0, angle:0, pinNets:{1:"A", 2:"B"}},
    {id:"t", kind:"track", points:[[-1, 0], [-6, 0]], width:.2, layer:"Top", net:"A"},
    {id:"v", kind:"via", x:-6, y:0, diameter:.5, drill:.25, layer:"Multi", net:"A"},
    {id:"n", kind:"via", x:-3.4, y:1.1, diameter:.5, drill:.25, layer:"Multi", net:"N"}, {id:"n2", kind:"via", x:-4.6, y:1.4, diameter:.5, drill:.25, layer:"Multi", net:"N"},
    {id:"far", kind:"track", points:[[5, 5], [8, 5]], width:.2, layer:"Top", net:"F"}], outline:[[-15, -10], [10, -10], [10, 10], [-15, 10]]};
  const s = D.dragSession(board, defs, ["U1"], {mode:"push", depth:8}); s.move([-1, 2.5]);
  const r = s.flush();
  assert.ok(r.shoved >= 1, r.statusText);
  const plan = s.commit(), after = applied(board, plan);
  const nv = after.items.find(i => i.id === "n"); assert.ok(Math.hypot(nv.x + 3.4, nv.y - 1.1) > .05, "the via was shoved");
  assert.deepEqual(after.items.find(i => i.id === "far"), board.items.find(i => i.id === "far"));
  const a = audit(after.items, defs); assert.ok(a.worst >= -1e-6, JSON.stringify(a));
  const s2 = D.dragSession(board, defs, ["U1"], {mode:"walkaround", depth:8}); s2.move([-1, 2.5]);
  assert.equal(s2.flush().shoved, 0);
  const a2 = applied(board, s2.commit());
  assert.deepEqual(a2.items.find(i => i.id === "n"), board.items.find(i => i.id === "n"));
});

test("diff pairs stay coupled at their gap", () => {
  const P = "USB_P", N = "USB_N";
  const {board, defs:qd} = qfnBoard(6, {netOf:p => p.number === "3" ? P : p.number === "4" ? N : null});
  // Re-wire pads 3 and 4 (west side, 0.5 mm pitch) as a coupled pair to two vias 6 mm out.
  const [p3, p4] = ["3", "4"].map(n => qd.get("qfn").footprint.pads.find(p => p.number === n));
  board.items = board.items.filter(i => !["t3", "t4", "v3", "v4"].includes(i.id));
  const w = .15, gap = .2, y0 = (p3.y + p4.y) / 2;
  for (const [id, net, side] of [["t3", P, -1], ["t4", N, 1]]) {
    const pd = side < 0 ? p3 : p4, y = y0 + side * (gap + w) / 2;
    board.items.push({id, kind:"track", net, layer:"Top", width:w, points:[[pd.x, pd.y], [pd.x - .5, pd.y], [pd.x - .5 - Math.abs(pd.y - y), y], [-9, y], [-9.6, y + side * .6]]});
    board.items.push({id:"v" + id, kind:"via", net, x:-9.6, y:y + side * .6, diameter:.45, drill:.2, layer:"Multi"});
  }
  board.diffPairs = [{name:"USB", positive:P, negative:N}];
  const s = D.dragSession(board, qd, ["U1"], {depth:4});
  assert.equal(s.state.pairs, 1);
  s.move([-.4, .9]); const r = s.flush();
  const a = r.pushed.find(p => p.net === P).points, b = r.pushed.find(p => p.net === N).points;
  const plan = s.commit(); assert.equal(plan.coupled, 1, plan.statusText);
  const after = applied(board, plan), tp = after.items.find(i => i.id === "t3"), tn = after.items.find(i => i.id === "t4");
  // Sample the coupled run (away from the pad gathers): the centre-to-centre distance is gap + width.
  const samples = [];
  const L = tp.points.reduce((s, q, i, arr) => i ? s + Math.hypot(q[0] - arr[i - 1][0], q[1] - arr[i - 1][1]) : 0, 0);
  for (let f = .25; f <= .75; f += .05) {
    let s0 = f * L, q = null;
    for (let i = 1; i < tp.points.length; i++) { const A = tp.points[i - 1], B = tp.points[i], l = Math.hypot(B[0] - A[0], B[1] - A[1]); if (s0 <= l) { q = [A[0] + (B[0] - A[0]) * s0 / l, A[1] + (B[1] - A[1]) * s0 / l]; break; } s0 -= l; }
    if (q) samples.push(Math.min(...tn.points.slice(1).map((B, i) => pointSeg(q, tn.points[i], B))));
  }
  assert.ok(samples.length >= 5);
  for (const d of samples) assert.ok(Math.abs(d - (gap + w)) < .02, "coupled pitch " + d.toFixed(3) + " (want " + (gap + w) + ") " + JSON.stringify(a) + " / " + JSON.stringify(b));
  assert.ok(connected(after, qd, P) && connected(after, qd, N));
  const au = audit(after.items, qd, .15); assert.ok(au.worst >= -1e-6, JSON.stringify(au));
});

test("On with Shift: tracks stretch until Shift is held, then re-route", () => {
  const {board, defs:qd} = qfnBoard(4);
  const s = D.dragSession(board, qd, ["U1"], {dragMode:"shift"});
  let r = s.move([.4, .4]); r = s.flush();
  assert.equal(r.enabled, false); assert.equal(r.routed, 0); assert.match(r.statusText, /hold Shift/);
  assert.ok(r.pushed.every(p => p.status === "rubber"));
  s.setShift(true); r = s.flush();
  assert.equal(r.enabled, true); assert.equal(r.routed, 16);
  s.setShift(false);
  const plan = s.commit();
  assert.equal(plan.routed, 0, "released before the drop: stretched");
  const t = applied(board, plan).items.find(i => i.id === "t1"), o = board.items.find(i => i.id === "t1");
  assert.deepEqual(t.points.slice(1), o.points.slice(1), "only the pad end moved");
  // Off: the same stretch, and the toggle from the editor maps to Off.
  const s2 = D.dragSession(board, qd, ["U1"], {enabled:false}); assert.equal(s2.state.mode, "off"); s2.cancel();
});

test("DRC is clean after the drop on fixtures (synthetic QFN, and the real Altium PiDP-11 import)", () => {
  // Synthetic: 40 escapes off a QFN-40 between neighbours' vias.
  const {board, defs:qd} = qfnBoard(10);
  const drc = b => AtriumRules.drc(b, qd).violations.filter(v => ["clearance", "short", "width"].includes(v.type));
  assert.equal(drc(board).length, 0, "fixture starts clean");
  for (const d of [[.5, 0], [0, -.8], [1.1, .7], [-1.4, 1.2]]) {
    const s = D.dragSession(board, qd, ["U1"], {mode:"walkaround"}); s.move(d);
    const after = applied(board, s.commit());
    const v = drc(after); assert.equal(v.length, 0, "after " + d + ": " + JSON.stringify(v.slice(0, 3)));
  }
  // Real design: drag parts a little. The moved part itself may now sit on other copper (that is the
  // user's move); the re-routed tracks must add no clearance or short violations of their own.
  const project = publicPiDP();
  const pcb = project.documents.find(d => d.kind === "pcb"), lib = new Map((project.library || []).map(c => [c.id, c]));
  const copper = b => AtriumRules.drc(b, lib, b.rules || undefined).violations.filter(v => ["clearance", "short"].includes(v.type));
  const before = copper(pcb);
  let dragged = 0, routed = 0;
  for (const part of pcb.items.filter(i => i.kind === "part").slice(0, 12)) {
    const s = D.dragSession(pcb, lib, [part.id], {revision:"pidp-" + part.id});
    if (!s.state.connections) { s.cancel(); continue; }
    s.move([0.254, 0.254]);
    const plan = s.commit(), after = applied(pcb, plan);
    dragged++; routed += plan.routed;
    const ids = new Set(plan.modify.filter(m => m.points).map(m => m.id)), mine = v => (ids.has(v.id) || ids.has(v.otherId)) && v.id !== part.id && v.otherId !== part.id;
    const n = copper(after).filter(mine), was = before.filter(mine);
    assert.ok(n.length <= was.length, part.ref + ": " + n.length + " violations on re-routed tracks after the drop, " + was.length + " before: " + JSON.stringify(n.slice(0, 2).map(v => v.title)));
  }
  assert.ok(dragged >= 5 && routed >= 10, dragged + " parts, " + routed + " connections");
});

test("length-matched nets report their live Δ (label data), approximate until routed", () => {
  const {board, defs:qd} = qfnBoard(4);
  const targets = {S1:{target:6, tolerance:.1}, S2:{target:3, tolerance:.5}};
  const L0 = globalThis.AtriumLength;
  globalThis.AtriumLength = {targetFor:(b, d, net) => targets[net] || {target:null}, matchLength:(b, d, net) => ({length:b.items.filter(i => i.kind === "track" && i.net === net).reduce((s, t) => s + t.points.reduce((u, q, i, a) => i ? u + Math.hypot(q[0] - a[i - 1][0], q[1] - a[i - 1][1]) : 0, 0), 0)})};
  try {
    const s = D.dragSession(board, qd, ["U1"], {lengths:true, depth:1});
    s.move([0, 1.5]); const r = s.flush();
    assert.equal(r.labels.length, 2);
    const l1 = r.labels.find(l => l.net === "S1"), track = r.pushed.find(p => p.id === "t1").points;
    const len = track.reduce((u, q, i, a) => i ? u + Math.hypot(q[0] - a[i - 1][0], q[1] - a[i - 1][1]) : 0, 0);
    assert.ok(Math.abs(l1.length - len) < 1e-6, l1.length + " vs " + len);
    assert.ok(Math.abs(l1.delta - (len - 6)) < 1e-6); assert.equal(l1.band, Math.abs(l1.delta) <= .1 ? "ok" : Math.abs(l1.delta) <= .2 ? "close" : "out");
    assert.equal(l1.approx, false);
    const plan = s.commit(); assert.equal(plan.labels.length, 2);
  } finally { globalThis.AtriumLength = L0; }
});

test("a bus ribbon re-routes as a group through bus-route.js's API; without it, members re-route one by one", () => {
  const {board, defs:qd} = qfnBoard(4);
  const B0 = globalThis.AtriumBusRoute, members = ["t1", "t2", "t3"];
  let calls = 0;
  const rec = {ids:members.slice()};
  globalThis.AtriumBusRoute = {owns:id => members.includes(id), recordOf:(b, id) => members.includes(id) ? rec : null,
    reroutePlan:(b, d, r) => { calls++; const u = b.items.find(i => i.id === "U1"); return {r:{plan:{add:r.ids.map((id, k) => ({id:"bus" + k, kind:"track", net:"S" + (k + 1), layer:"Top", width:.15, points:[[u.x, u.y], [u.x + 1, u.y]]})), modify:[]}}, remove:r.ids}; }};
  try {
    const s = D.dragSession(board, qd, ["U1"], {});
    assert.equal(s.state.buses, 1); assert.equal(s.state.busTracks, 3);
    s.move([1, 1]); s.flush();
    const plan = s.commit();
    assert.equal(calls, 1);
    assert.deepEqual(plan.remove.filter(id => members.includes(id)).sort(), members);
    assert.ok(plan.add.some(i => i.id === "bus0" && i.points[0][0] === 1 && i.points[0][1] === 1), "routed from the moved part");
    assert.ok(!plan.modify.some(m => members.includes(m.id)), "members are not also re-routed one by one");
    // An older bus-route.js (owns only): members re-route as ordinary tracks.
    globalThis.AtriumBusRoute = {owns:id => members.includes(id)};
    const s2 = D.dragSession(board, qd, ["U1"], {}); s2.move([1, 1]);
    const p2 = s2.commit(); assert.equal(p2.buses, 0); assert.ok(members.every(id => p2.modify.some(m => m.id === id)));
  } finally { globalThis.AtriumBusRoute = B0; }
});

test("tracks between two moving parts translate rigidly; locked tracks are left in place", () => {
  const board = {kind:"pcb", items:[
    {id:"U1", kind:"part", def:"d2", x:0, y:0, angle:0, pinNets:{1:"A", 2:"B"}},
    {id:"U2", kind:"part", def:"d2", x:6, y:0, angle:0, pinNets:{1:"B", 2:"C"}},
    {id:"ab", kind:"track", points:[[1, 0], [3, 0]], width:.2, layer:"Top", net:"B"},
    {id:"ab2", kind:"track", points:[[3, 0], [5, 0]], width:.2, layer:"Top", net:"B"},
    {id:"L", kind:"track", points:[[-1, 0], [-5, 0]], width:.2, layer:"Top", net:"A", locked:true}], outline:[[-15, -10], [15, -10], [15, 10], [-15, 10]]};
  const s = D.dragSession(board, defs, ["U1", "U2"], {});
  assert.equal(s.state.rigid, 2); assert.equal(s.state.locked, 1);
  const plan = s.commit([1, 2]);
  assert.deepEqual(plan.modify.find(m => m.id === "ab").points, [[2, 2], [4, 2]]);
  assert.deepEqual(plan.modify.find(m => m.id === "ab2").points, [[4, 2], [6, 2]]);
  assert.ok(!plan.modify.some(m => m.id === "L"));
});

function measureDenseDrag() {
  const {d, defs:bd} = makeAtriumBenchmarkBoard();
  let k = 0; for (const i of d.items) if (i.kind === "via" || i.kind === "track") i.net = "N" + (k++ % 400);
  // A cleared pocket mid-board for the QFN and its escapes.
  const cx = 184, cy = 137, inPocket = p => Math.abs(p[0] - cx) < 10.5 && Math.abs(p[1] - cy) < 10.5;
  d.items = d.items.filter(i => !(i.points || [[i.x, i.y]]).some(inPocket) && !(i.kind === "part" && inPocket([i.x, i.y])));
  const {def, items} = qfn(12, {x:cx, y:cy});
  bd.set("qfn", def); d.items.push(...items);
  const t0 = timer(); R.world(d, bd, {revision:"dense"}); const build = timer() - t0;
  const t1 = timer(), s = D.dragSession(d, bd, ["U1"], {revision:"dense", frameMs:3}); const start = timer() - t1;
  assert.equal(s.state.connections, 48); assert.equal(s.state.live, 32);
  const times = [];
  for (let i = 1; i <= 80; i++) { const t = timer(); s.move([0.015 * i, 0.01 * i * Math.cos(i / 9)]); times.push(timer() - t); }
  const r = s.flush();
  const sorted = sortedTimes(times);
  const med = sorted[times.length >> 1], p95 = sorted[Math.floor(times.length * .95)], max = sorted.at(-1);
  console.log("  dense drag: world " + build.toFixed(1) + " ms, session " + start.toFixed(2) + " ms; move median " + med.toFixed(2) + " ms, p95 " + p95.toFixed(2) + " ms, max " + max.toFixed(2) + " ms; " + r.routed + " routed, " + r.rubber + " as lines");
  assert.equal(r.routed, 32); assert.equal(r.airwires.length, 16);
  const t2 = timer(), plan = s.commit(), drop = timer() - t2;
  console.log("  drop: " + drop.toFixed(1) + " ms, " + plan.routed + " routed, " + plan.rubber + " rubber");
  assert.equal(plan.routed + plan.unrouted, 48);
  assert.ok(plan.routed >= 44, plan.message);
  return times;
}

test("dense 25.6k-object board: a QFN-48 with 48 tracks, cap 32, move budget", () => {
  retrySamples(measureDenseDrag, times => {
    const p95 = sortedTimes(times)[Math.floor(times.length * .95)];
    return p95 < 5.5 ? "" : "p95 drag move " + p95.toFixed(2) + " ms (budget < 5.5 ms)";
  });
});

let failed = 0;
for (const c of cases) {
  try { c.run(); console.log("PASS " + c.name); }
  catch (e) { failed++; console.log("FAIL " + c.name + "\n  " + (e && e.message || e)); }
}
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " drag-reroute test(s) failed"); }
