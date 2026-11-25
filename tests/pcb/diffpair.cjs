"use strict";
// Differential-pair routing: coupled gap through bends, inner/outer bend lengths,
// skew and uncoupled length, walkaround and push as a unit, layer changes.
const assert = require("node:assert/strict");
const {pointSeg, segSeg} = require("../support/segment-distance.cjs");
require("../../app/core/model.js");
require("../../app/pcb/router.js");
require("../../app/pcb/diffpair.js");
const DP = globalThis.AtriumDiffPair, R = globalThis.AtriumRouter;
const cases = [];
const test = (name, run) => cases.push({name, run});

const len = pts => pts.reduce((s, p, i) => i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0, 0);
function polyGap(P, N) { let m = Infinity; for (let i = 1; i < P.length; i++) for (let j = 1; j < N.length; j++) m = Math.min(m, segSeg(P[i - 1], P[i], N[j - 1], N[j])); return m; }
// Min centre-line distance from each vertex of A to polyline B.
function vertexGaps(A, B) { return A.map(p => { let m = Infinity; for (let j = 1; j < B.length; j++) m = Math.min(m, pointSeg(p, B[j - 1], B[j])); return m; }); }
function shapes(i) {
  if (i.kind === "track") return i.points.slice(1).map((p, k) => [i.points[k], p, i.width / 2]);
  return [[[i.x, i.y], [i.x, i.y], (i.diameter || i.w) / 2]];
}
function audit(items, clr) {
  let worst = Infinity;
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    if (items[a].net === items[b].net || (items[a].layer && items[b].layer && items[a].layer !== items[b].layer && items[a].kind === "track" && items[b].kind === "track")) continue;
    for (const x of shapes(items[a])) for (const y of shapes(items[b])) worst = Math.min(worst, segSeg(x[0], x[1], y[0], y[1]) - x[2] - y[2] - clr);
  }
  return worst;
}
const pads = (extra = []) => ({kind:"pcb", items:[
  {id:"pp", kind:"pad", x:0, y:-.5, w:.6, h:.6, shape:"round", layer:"Top", net:"USB_P"},
  {id:"pn", kind:"pad", x:0, y:.5, w:.6, h:.6, shape:"round", layer:"Top", net:"USB_N"},
  {id:"ep", kind:"pad", x:22, y:7.5, w:.6, h:.6, shape:"round", layer:"Top", net:"USB_P"},
  {id:"en", kind:"pad", x:22, y:8.5, w:.6, h:.6, shape:"round", layer:"Top", net:"USB_N"},
  ...extra], outline:[[-3, -8], [26, -8], [26, 11], [-3, 11]]});
const GAP = .2, W = .2, PITCH = GAP + W, D = PITCH / 2;
const open = (board, o = {}) => DP.begin(board, new Map(), {net:"USB_P", layer:"Top", start:[0, -.5], gap:GAP, width:W, rules:{clearance:.2}, ...o});

test("pairs are found from rules, the board, or net names", () => {
  assert.deepEqual(DP.pairs(pads()).map(p => [p.name, p.positive, p.negative]), [["USB", "USB_P", "USB_N"]]);
  const saved = globalThis.AtriumRules;
  globalThis.AtriumRules = {diffPairs:() => [{name:"LVDS0", positive:"A+", negative:"A-"}]};
  try { assert.equal(DP.find({kind:"pcb", items:[]}, "A-").name, "LVDS0"); } finally { globalThis.AtriumRules = saved; }
  assert.equal(DP.find({kind:"pcb", items:[{net:"CLK+"}, {net:"CLK-"}]}, "CLK+").negative, "CLK-");
});

test("coupled section keeps the gap through 45 degree bends; skew follows the bend geometry", () => {
  const board = pads();
  const s = open(board);
  const r = s.move([12, 6]);          // leaves right, then a 45 degree bend
  assert.equal(r.status, "ok");
  const [P, N] = r.preview.map(p => p.points);
  const centre = r.centre[0];
  assert.ok(centre.length >= 3, "the centreline bends");
  // Coupled offsets: each straight segment runs exactly one pitch from its partner
  // (centre to centre), mitred bend corners are never closer, and the edge gap is the rule gap.
  const cP = DP.offset(centre, D), cN = DP.offset(centre, -D);
  for (const g of [...vertexGaps(cP, cN), ...vertexGaps(cN, cP)]) assert.ok(g >= PITCH - 1e-9, "pitch " + g);
  for (let i = 1; i < cP.length; i++) {
    const mid = [(cP[i - 1][0] + cP[i][0]) / 2, (cP[i - 1][1] + cP[i][1]) / 2];
    assert.ok(Math.abs(pointSeg(mid, cN[i - 1], cN[i]) - PITCH) < 1e-9, "parallel segment " + i);
  }
  assert.ok(Math.abs(polyGap(cP, cN) - PITCH) < 1e-9, "minimum centre distance = pitch, so the edge gap = rule gap");
  // The traces contain the coupled offsets.
  const contains = (T, q) => T.some((p, i) => i && pointSeg(q, T[i - 1], p) < 1e-6);
  for (const q of cP) assert.ok(contains(P, q) || contains(N, q));
  // Inner/outer trace lengths: each bend of angle t changes the offset lengths by -/+ 2 d tan(t/2).
  let expected = 0;
  for (let i = 1; i < centre.length - 1; i++) {
    const a = centre[i - 1], b = centre[i], c = centre[i + 1];
    const t = Math.atan2((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]));
    expected += 2 * D * Math.tan(t / 2);
  }
  assert.ok(Math.abs((len(cN) - len(cP)) - 2 * expected) < 1e-9, "outer longer than inner by 4 d tan(t/2) per bend");
  assert.ok(Math.abs(DP.bendSkew(centre, D) + expected) < 1e-9);
  // Reported skew = P length - N length, including breakouts.
  assert.ok(Math.abs(r.skew - (len(P) - len(N))) < 1e-9);
  assert.ok(Math.abs(r.lengthP - len(P)) < 1e-9 && Math.abs(r.lengthN - len(N)) < 1e-9);
  // Symmetric breakout from pads 1 mm apart to a 0.4 mm pitch.
  assert.ok(Math.abs(r.uncoupledP - r.uncoupledN) < 1e-9);
  assert.ok(Math.abs(r.uncoupledP - .3 * Math.SQRT2) < 1e-6, "45 degree fan of 0.3 mm lateral " + r.uncoupledP);
  assert.ok(Math.abs(r.skew - (len(cP) - len(cN))) < 1e-9, "skew comes from the coupled bends only");
});

test("routing to the partner pads finishes with an end breakout and zero skew for mirrored bends", () => {
  const board = pads();
  const s = open(board);
  const r = s.move([22, 7.5]);
  assert.ok(r.reached);
  const [P, N] = r.preview.map(p => p.points);
  assert.deepEqual(P[0], [0, -.5]); assert.deepEqual(N[0], [0, .5]);
  assert.ok(Math.hypot(P.at(-1)[0] - 22, P.at(-1)[1] - 7.5) < 1e-9 && Math.hypot(N.at(-1)[0] - 22, N.at(-1)[1] - 8.5) < 1e-9);
  assert.ok(Math.abs(r.skew) < 1e-9, "opposite bends cancel: " + r.skew);
  assert.ok(Math.abs(r.uncoupled - 2 * .3 * Math.SQRT2) < 1e-6);
  assert.ok(audit([...board.items, {kind:"track", points:P, width:W, net:"USB_P"}, {kind:"track", points:N, width:W, net:"USB_N"}], .2) >= -1e-6);
  assert.ok(s.click().done);
  const plan = s.commit();
  assert.equal(plan.add.length, 2);
  assert.deepEqual(plan.add.map(t => t.net).sort(), ["USB_N", "USB_P"]);
});

test("the pair walks around obstacles as a unit and every trace keeps clearance", () => {
  const obstacles = [
    {id:"v", kind:"via", x:8, y:.2, diameter:.8, drill:.4, layer:"Multi", net:"GND"},
    {id:"t", kind:"track", points:[[13, -6], [13, 3]], width:.3, layer:"Top", net:"VCC"}];
  const board = pads(obstacles);
  for (const corner of ["45", "90", "45arc"]) {
    const s = open(board, {corner, mode:"walkaround"});
    const r = s.move([22, 7.5]);
    assert.equal(r.status, "ok", corner);
    assert.ok(r.reached, corner);
    const traces = r.preview.map(p => ({kind:"track", points:p.points, width:W, net:p.net}));
    assert.ok(audit([...board.items, ...traces], .2) >= -1e-6, corner + " clearance");
    // Coupling holds along the whole coupled section (edge gap = rule gap).
    const c = r.centre[0];
    assert.ok(Math.abs(polyGap(DP.offset(c, D), DP.offset(c, -D)) - PITCH) < 1e-6, corner);
    assert.ok(r.breakoutOk);
  }
});

test("push shoves other-net copper away from both traces", () => {
  const board = pads([{id:"t", kind:"track", points:[[10, -6], [10, 6]], width:.25, layer:"Top", net:"VCC"},
    {id:"v", kind:"via", x:6, y:.3, diameter:.6, drill:.3, layer:"Multi", net:"GND"}]);
  const s = open(board, {mode:"push"});
  const r = s.move([14, 0]);
  assert.equal(r.status, "pushed");
  const moved = new Map(r.pushed.map(p => [p.id, p]));
  assert.ok(moved.has("t") && moved.has("v"));
  const items = board.items.map(i => moved.has(i.id) ? {...i, ...moved.get(i.id)} : i);
  const traces = r.preview.map(p => ({kind:"track", points:p.points, width:W, net:p.net}));
  assert.ok(audit([...items, ...traces], .2) >= -1e-6);
  assert.ok(s.click().anchored);
  const plan = s.commit();
  assert.deepEqual(plan.modify.map(m => m.id).sort(), ["t", "v"]);
});

// Advance one logical tick per routing clock read so the geometry tests control the deadline.
function withShoveClock(run) {
  const clock = globalThis.performance?.now ? "performance" : "preciseTime";
  const previous = Object.getOwnPropertyDescriptor(globalThis, clock);
  let ms = 0;
  const tick = () => {
    ms += .005;
    return ms;
  };
  const value = clock === "performance" ? {now: tick} : () => tick() / 1000;
  Object.defineProperty(globalThis, clock, {configurable: true, value});
  try {
    return run(elapsed => { ms += elapsed; });
  } finally {
    if (previous) Object.defineProperty(globalThis, clock, previous);
    else delete globalThis[clock];
  }
}

function crossedBusSession() {
  const bus = Array.from({length:4}, (_, k) => ({id:"b" + k, kind:"track", layer:"Top", width:.2, net:"B" + k, points:[[0, 2 + k * .45], [12, 2 + k * .45]]}));
  const board = {kind:"pcb", items:[...bus, {id:"pp", kind:"pad", x:5.7, y:-2, w:.4, h:.4, shape:"round", layer:"Top", net:"D_P"},
    {id:"pn", kind:"pad", x:6.3, y:-2, w:.4, h:.4, shape:"round", layer:"Top", net:"D_N"}]};
  const s = DP.begin(board, new Map(), {pair:{name:"D", positive:"D_P", negative:"D_N"}, layer:"Top", start:[5.7, -2], gap:GAP, width:W, mode:"push", rules:{clearance:.2}});
  return {board, s};
}

test("push: a crossed bus nests around the pair's tip and the pair stays coupled", () => {
  const {board, s} = crossedBusSession();
  const r = withShoveClock(() => s.move([6, 2.8]));
  assert.equal(r.status, "pushed");
  assert.equal(r.pushed.length, 4, "the whole bus moves");
  const [P, N] = ["D_P", "D_N"].map(n => r.preview.find(p => p.net === n).points);
  // Coupled run: the two traces stay exactly one pitch apart along the shove.
  const g = vertexGaps(P.slice(1), N);
  assert.ok(g.every(x => Math.abs(x - PITCH) < 1e-6), "pair pitch " + g);
  for (const p of r.pushed) {
    assert.deepEqual([p.points[0][0], p.points.at(-1)[0]], [0, 12], "ends fixed");
    assert.ok(Math.min(...p.points.map(q => q[1])) >= 2 - 1e-6, p.id + " never wraps around the pads");
  }
  const items = board.items.map(i => r.pushed.find(p => p.id === i.id) ? {...i, ...r.pushed.find(p => p.id === i.id)} : i);
  assert.ok(audit([...items.filter(i => i.kind === "track"), ...r.preview.map(p => ({kind:"track", points:p.points, width:W, net:p.net}))], .2) >= -1e-6);
});

test("push: a crossed bus rolls back when the deadline expires mid-shove", () => {
  const {board, s} = crossedBusSession();
  const before = JSON.stringify(board.items);
  const scene = s.world.scene, set = scene.set;
  let writes = 0;
  const r = withShoveClock(advance => {
    scene.set = (owner, geometry) => {
      set(owner, geometry);
      writes++;
      if (writes === 1) advance(5);
    };
    try {
      return s.move([6, 2.8]);
    } finally {
      scene.set = set;
    }
  });

  assert.equal(writes, 1, "one tentative shove precedes deadline expiry");
  assert.equal(r.status, "blocked");
  assert.equal(r.pushed.length, 0);
  assert.equal(scene.mods.size, 0);
  assert.equal(s.world.n, s.world.nPersist);
  assert.ok(s.world.dead.subarray(0, s.world.nPersist).every(flags => flags === 0), "original copper is active again");
  assert.equal(JSON.stringify(board.items), before);
  assert.equal(r.preview.length, 2);
  assert.ok(Math.abs(r.pairGap - GAP) < 1e-6);
  const traces = r.preview.map(p => ({kind:"track", points:p.points, width:W, net:p.net}));
  assert.ok(audit([...board.items.filter(i => i.kind === "track"), ...traces], .2) >= -1e-6);
});

test("a layer change drops a via for each net and the pair continues coupled", () => {
  const board = pads([{id:"ep2", kind:"pad", x:20, y:-.5, w:.6, h:.6, drill:.3, shape:"round", layer:"Multi", net:"USB_P"},
    {id:"en2", kind:"pad", x:20, y:.5, w:.6, h:.6, drill:.3, shape:"round", layer:"Multi", net:"USB_N"}]);
  const s = open(board);
  s.move([6, 0]); assert.ok(s.click().anchored);
  const sw = s.switchLayer("Bottom", {diameter:.5, drill:.25});
  assert.ok(sw.ok, sw.message);
  const r = s.move([20, -.5]);
  assert.ok(r.reached);
  assert.equal(r.vias.length, 2);
  assert.deepEqual(r.vias.map(v => v.net).sort(), ["USB_N", "USB_P"]);
  assert.ok(Math.hypot(r.vias[0].x - r.vias[1].x, r.vias[0].y - r.vias[1].y) >= .5 + .2 - 1e-9, "via pitch clears");
  assert.deepEqual(r.preview.map(p => p.layer), ["Top", "Top", "Bottom", "Bottom"]);
  for (const p of r.preview) {
    const v = r.vias.find(x => x.net === p.net);
    const ends = [p.points[0], p.points.at(-1)];
    assert.ok(ends.some(e => Math.hypot(e[0] - v.x, e[1] - v.y) < 1e-9), "each trace lands on its own via");
  }
  s.click();
  const plan = s.commit();
  assert.equal(plan.add.filter(i => i.kind === "via").length, 2);
  assert.equal(plan.add.filter(i => i.kind === "track").length, 4);
});

test("back retracts and the pair session is fast", () => {
  const board = pads();
  const s = open(board);
  s.move([5, 0]); s.click(); s.move([9, 4]); s.click();
  assert.ok(s.back());
  const r = s.move([9, 4]);
  assert.equal(r.status, "ok");
  const t = typeof performance !== "undefined" ? performance.now() : preciseTime() * 1000;
  for (let i = 0; i < 200; i++) s.move([9 + i * .05, 4 + (i % 7) * .1]);
  const per = ((typeof performance !== "undefined" ? performance.now() : preciseTime() * 1000) - t) / 200;
  console.log("  diff pair move: " + per.toFixed(3) + " ms average");
  assert.ok(per < 4);
});

// Exact P/N edge gap over every committed track of the pair.
function pairGapOf(plan, P, N) {
  const A = plan.add.filter(i => i.kind === "track" && i.net === P), B = plan.add.filter(i => i.kind === "track" && i.net === N);
  let m = Infinity;
  for (const a of A) for (const b of B) if (a.layer === b.layer) for (let i = 1; i < a.points.length; i++) for (let j = 1; j < b.points.length; j++)
    m = Math.min(m, segSeg(a.points[i - 1], a.points[i], b.points[j - 1], b.points[j]) - (a.width + b.width) / 2);
  return m;
}

test("regression: a short last segment never folds P onto N (review #1)", () => {
  const board = {kind:"pcb", items:[{id:"sp", kind:"pad", x:1, y:1, w:.5, h:.5, shape:"round", layer:"Top", net:"D_P"}, {id:"sn", kind:"pad", x:1, y:2, w:.5, h:.5, shape:"round", layer:"Top", net:"D_N"}], outline:[[0, 0], [20, 0], [20, 20], [0, 20]]};
  for (const [corner, p] of [["90", [11.286, 1.49]], ["90", [8, 1.45]], ["45", [11.286, 1.49]], ["45", [8, 1.6]]]) {
    const s = DP.begin(board, new Map(), {net:"D_P", layer:"Top", start:[1, 1], corner, gap:.2, width:.2, rules:{clearance:.2}});
    const r = s.move(p);
    const P = r.preview.filter(t => t.net === "D_P"), N = r.preview.filter(t => t.net === "D_N");
    let m = Infinity; for (const a of P) for (const b of N) m = Math.min(m, polyGap(a.points, b.points) - .2);
    assert.ok(m >= .2 - 1e-6 || r.status === "violation", corner + " " + p + ": gap " + m + " status " + r.status);
    s.click();
    assert.ok(pairGapOf(s.commit(), "D_P", "D_N") >= .2 - 1e-5);
  }
});

test("regression: a pair cannot cross or crowd its own anchored section (review #2)", () => {
  const s = open(pads());
  for (const p of [[10, 0], [10, 6], [5, 6], [5, -4]]) { s.move(p); s.click(); }
  assert.ok(pairGapOf(s.commit(), "USB_P", "USB_N") >= GAP - 1e-5);
});

test("regression fuzz: 150 random sessions, 3 clicks each, commit 0 P/N gap violations", () => {
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  let bad = 0, worst = Infinity;
  for (let trial = 0; trial < 150; trial++) {
    const items = [{id:"sp", kind:"pad", x:1, y:1, w:.5, h:.5, shape:"round", layer:"Top", net:"D_P"}, {id:"sn", kind:"pad", x:1, y:2, w:.5, h:.5, shape:"round", layer:"Top", net:"D_N"}];
    for (let k = 0; k < 25; k++) {
      const x = 4 + rnd() * 14, y = 2 + rnd() * 16;
      if (rnd() < .5) { const w = .4 + rnd(); items.push({id:"o" + k, kind:"pad", x, y, w, h:w, shape:"round", layer:"Top", net:"N" + k}); }
      else items.push({id:"t" + k, kind:"track", points:[[x, y], [x + (rnd() - .5) * 6, y + (rnd() - .5) * 6]], width:.2 + rnd() * .3, layer:"Top", net:"N" + k});
    }
    const board = {kind:"pcb", items, outline:[[0, 0], [20, 0], [20, 20], [0, 20]]};
    const mode = ["walkaround", "push", "hug", "stop"][trial % 4], corner = ["45", "90", "any", "45arc"][(trial >> 2) % 4];
    const s = DP.begin(board, new Map(), {net:"D_P", layer:"Top", start:[1, 1], mode, corner, gap:.2, width:.2, rules:{clearance:.2}});
    for (let c = 0; c < 3; c++) { s.move([1 + rnd() * 18, 1 + rnd() * 18]); s.click(); }
    const g = pairGapOf(s.commit(), "D_P", "D_N");
    worst = Math.min(worst, g);
    if (g < .2 - 1e-4) bad++;
  }
  assert.equal(bad, 0, "worst P/N edge gap " + worst);
});

test("diff-pair sessions cycle width and via presets and drop via pairs (keys 2/3/4)", () => {
  const board = pads();
  const s = open(board);
  assert.equal(typeof s.addVia, "function"); assert.equal(typeof s.nextWidth, "function"); assert.equal(typeof s.nextVia, "function");
  const w0 = s.state.width, w1 = s.nextWidth(1);
  assert.ok(w1 !== w0 && w1 > 0); s.nextWidth(-1);
  assert.equal(s.state.width, w0);
  assert.ok(s.nextVia(1).diameter > 0);
  s.move([6, 0]); s.click();
  const v = s.addVia({diameter:.5, drill:.25});
  assert.ok(v.ok, v.message); assert.equal(s.state.layer, "Bottom");
});

const slot = s => pads([
  {id:"w1", kind:"track", points:[[8, -8], [8, -s]], width:.25, layer:"Top", net:"GND"},
  {id:"w2", kind:"track", points:[[8, s], [8, 11]], width:.25, layer:"Top", net:"GND"}]);
const traceItems = r => r.preview.map(p => ({kind:"track", points:p.points, width:p.width, net:p.net, layer:p.layer}));

test("auto-shrink necks the pair down through a constriction only as far as needed, then restores it", () => {
  const board = slot(.55);
  const s = open(board, {minWidth:.1, minGap:.1});
  const r = s.move([14, 0]);
  assert.equal(r.status, "ok", JSON.stringify(r.notes));
  assert.ok(Math.hypot(r.centre[0].at(-1)[0] - 14, r.centre[0].at(-1)[1]) < 1e-6, "goes straight through the slot");
  assert.ok(r.shrink.active && r.shrink.zones === 1, JSON.stringify(r.shrink));
  assert.ok(r.shrink.width >= .1 - 1e-9 && r.shrink.width < .2 && r.shrink.gap < .2, "shrinks toward the minimums");
  assert.ok(r.shrink.width > .1 + 1e-3, "but no further than needed: " + r.shrink.width);
  assert.match(r.shrink.text, /Auto-shrink/);
  assert.ok(r.necks.length === 1 && r.necks[0].points.length >= 2);
  const widths = new Set(r.preview.map(p => p.width));
  assert.ok(widths.has(.2) && [...widths].some(w => w < .2), "full width either side, narrow in the slot");
  for (const net of ["USB_P", "USB_N"]) assert.ok(audit([...board.items, ...traceItems(r).filter(t => t.net === net)], .2) >= -1e-6, "clearance to the board holds");
  assert.ok(r.pairGap >= r.shrink.gap - 1e-6);
  // The end of the route is back at full size and gap.
  const lastP = r.preview.filter(p => p.net === "USB_P").at(-1);
  assert.equal(lastP.width, .2);
  s.click();
  const plan = s.commit();
  assert.ok(plan.add.filter(t => t.net === "USB_P").length >= 3, "full / taper / neck / taper / full pieces");
  // Toggle off: the full-size pair cannot pass.
  const off = open(board, {minWidth:.1, minGap:.1, autoShrink:false});
  const r2 = off.move([14, 0]);
  assert.ok(!r2.shrink.active);
  assert.ok(r2.status !== "ok" || Math.hypot(r2.centre[0].at(-1)[0] - 14, r2.centre[0].at(-1)[1]) > 1e-6 || r2.centre[0].length > 3);
  assert.equal(off.toggleAutoShrink(), true);
});

test("transitions: mitered and rounded tapers between sizes", () => {
  const centre = [[0, 0], [10, 0]], base = {width:.2, gap:.2}, zones = [{s0:4, s1:6, width:.1, gap:.1}];
  const m = DP.sizeProfile(centre, base, zones, "mitered", 3), rd = DP.sizeProfile(centre, base, zones, "rounded", 3);
  // 45° ramp: the half-pitch changes by 0.1 over 0.1 mm, outside the zone.
  const at = (p, x) => { const i = p.pts.findIndex(q => Math.abs(q[0] - x) < 1e-9); return i < 0 ? null : {d:p.d[i], w:p.w[i]}; };
  assert.ok(Math.abs(at(m, 4).w - .1) < 1e-9 && Math.abs(at(m, 6).w - .1) < 1e-9 && Math.abs(at(m, 3.9).w - .2) < 1e-9);
  assert.ok(m.w.some(w => w > .1 && w < .2), "intermediate widths in the taper");
  assert.ok(rd.pts.length > m.pts.length, "rounded transitions are sampled more finely");
  const mono = p => { for (let i = 1; i < p.pts.length; i++) if (p.pts[i][0] <= 4 && p.d[i] > p.d[i - 1] + 1e-12) return false; return true; };
  assert.ok(mono(m) && mono(rd), "the taper narrows monotonically into the neck");
  const step = DP.sizeProfile(centre, base, zones, "step", 3);
  assert.ok(step.pts.length <= m.pts.length);
});

test("retrace re-gaps a routed pair with ramps from the unchanged breakouts", () => {
  const board = pads();
  const s = open(board);
  s.move([22, 7.5]); s.click();
  R.apply(board, s.commit());
  R.invalidate(board);
  const ids = board.items.filter(i => i.kind === "track").map(i => i.id);
  for (const [mode, gap, pitch] of [["custom", .3, .5], ["preferred", null, .4]]) {
    const plan = DP.retrace(board, new Map(), {pair:"USB", ids, gapMode:mode, gap, rules:{clearance:.2}});
    assert.ok(plan.ok, mode + JSON.stringify(plan.failed)); assert.ok(plan.runs >= 1, "runs " + plan.runs);
    const b2 = JSON.parse(JSON.stringify(board)); R.apply(b2, plan);
    const T = b2.items.filter(i => i.kind === "track"), P = T.find(t => t.net === "USB_P"), N = T.find(t => t.net === "USB_N");
    // Ends stay on the pads; the middle of the longest coupled segment sits at the new pitch.
    assert.deepEqual(P.points[0], [0, -.5]); assert.deepEqual(N.points[0], [0, .5]);
    let best = null; for (let i = 1; i < P.points.length; i++) { const l = Math.hypot(P.points[i][0] - P.points[i - 1][0], P.points[i][1] - P.points[i - 1][1]); if (!best || l > best.l) best = {l, m:[(P.points[i][0] + P.points[i - 1][0]) / 2, (P.points[i][1] + P.points[i - 1][1]) / 2]}; }
    assert.ok(Math.abs(vertexGaps([best.m], N.points)[0] - pitch) < 1e-4, mode + " pitch " + vertexGaps([best.m], N.points)[0]);
    assert.ok(polyGap(P.points, N.points) - W >= .2 - 1e-5, mode + " never below the old gap");
    assert.ok(audit([...b2.items.filter(i => i.kind === "pad"), ...T], .2) >= -1e-5);
  }
  // A gap that collides with an obstacle is refused unless forced.
  const blocked = pads([{id:"v", kind:"via", x:15, y:9.6, diameter:.6, drill:.3, layer:"Multi", net:"GND"}]);
  blocked.items.push(...board.items.filter(i => i.kind === "track"));
  const bad = DP.retrace(blocked, new Map(), {pair:"USB", gapMode:"custom", gap:3, rules:{clearance:.2}});
  assert.ok(!bad.ok && bad.failed.length && !bad.modify.length);
});

test("gloss tapers width steps and smooths lateral jogs", () => {
  const board = {kind:"pcb", items:[
    {id:"a", kind:"track", points:[[0, 0], [5, 0]], width:.3, layer:"Top", net:"USB_P"},
    {id:"b", kind:"track", points:[[5, 0], [10, 0]], width:.15, layer:"Top", net:"USB_P"},
    {id:"j", kind:"track", points:[[0, 3], [4, 3], [4, 3.4], [10, 3.4]], width:.15, layer:"Top", net:"USB_N"}]};
  const plan = DP.gloss(board, new Map(), {pair:"USB", rules:{clearance:.2}});
  const a = plan.modify.find(m => m.id === "a"), tapers = plan.add.filter(t => t.net === "USB_P");
  assert.ok(a && a.points.at(-1)[0] < 5, "the wide track stops short of the junction");
  assert.equal(tapers.length, 3);
  assert.ok(tapers.every(t => t.width < .3 && t.width > .15));
  assert.ok(Math.abs(tapers.at(-1).points[1][0] - 5) < 1e-6, "the taper ends at the junction");
  const j = plan.modify.find(m => m.id === "j").points;
  for (let i = 1; i < j.length; i++) { const dx = Math.abs(j[i][0] - j[i - 1][0]), dy = Math.abs(j[i][1] - j[i - 1][1]); assert.ok(dy < 1e-9 || Math.abs(dx - dy) < 1e-6, "45° jog"); }
  const round = DP.gloss(board, new Map(), {pair:"USB", transition:"rounded", rules:{clearance:.2}});
  assert.ok(round.modify.find(m => m.id === "j").points.length > j.length);
});

test("impedance-profile rule values (min/preferred/max per layer) bound auto-shrink and width presets", () => {
  const saved = globalThis.AtriumRules;
  globalThis.AtriumRules = {types:{diffPairsRouting:{}, clearance:{}}, resolver:() => (t, ctx) => t === "diffPairsRouting" ? {widthMin:.12, widthPreferred:.2, widthMax:.24, gapMin:.11, gapPreferred:.2, gapMax:.3, impedance:{profile:"z90"}} : t === "clearance" ? {gap:.2} : null};
  try {
    const board = slot(.55);
    const s = DP.begin(board, new Map(), {net:"USB_P", layer:"Top", start:[0, -.5]});
    assert.equal(s.state.width, .2); assert.equal(s.state.gap, .2);
    assert.equal(s.state.minWidth, .12); assert.equal(s.state.minGap, .11);
    const r = s.move([14, 0]);
    assert.ok(r.shrink.active && r.shrink.width >= .12 - 1e-9 && r.shrink.gap >= .11 - 1e-9, JSON.stringify(r.shrink));
    assert.ok(s.presets().widths.every(w => w >= .12 - 1e-9 && w <= .24 + 1e-9), JSON.stringify(s.presets().widths));
  } finally { globalThis.AtriumRules = saved; }
});

let failed = 0;
for (const c of cases) {
  try { c.run(); console.log("PASS " + c.name); }
  catch (e) { failed++; console.log("FAIL " + c.name + "\n  " + (e && e.message || e)); }
}
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " diff-pair test(s) failed"); }
