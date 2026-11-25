"use strict";
// Interactive router engine: walkaround, push and shove, corner styles, gloss,
// sessions, headless routing and performance. Clearances are verified with an
// independent geometry checker, not the engine's own.
const assert = require("node:assert/strict");
const {segSeg} = require("../support/segment-distance.cjs");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/pcb/router.js");
require("../../app/pcb/diffpair.js");
require("./dense-board.js");
const {now: timer, cpuNow, retrySamples} = require("../analysis/timing-check.js");
const R = globalThis.AtriumRouter;
const cases = [];
const test = (name, run) => cases.push({name, run});

// ---------------------------------------------------------------- independent geometry
test("independent segment distance handles crosses, touches and degeneracy", () => {
  const start = [0, 0], end = [4, 0];
  for (const [a, b, want] of [
    [[2, -1], [2, 1], 0], [[2, 0], [2, 1], 0], [[1, 0], [5, 0], 0],
    [[6, 0], [8, 0], 2], [[2, 3], [2, 3], 3]
  ]) assert.equal(segSeg(start, end, a, b), want);
});
const inPoly = (p, poly) => { let s = 0; for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]); if (c > 1e-12) s |= 1; else if (c < -1e-12) s |= 2; } return s !== 3; };
// Copper of an item as primitives: {segs:[[a,b]], r} or {poly, r:0}.
function shapes(item) {
  if (item.kind === "track") return item.points.slice(1).map((p, i) => ({a:item.points[i], b:p, r:item.width / 2}));
  if (item.kind === "via") return [{a:[item.x, item.y], b:[item.x, item.y], r:item.diameter / 2}];
  if (item.kind === "pad") {
    if (item.shape === "round" && item.w === item.h) return [{a:[item.x, item.y], b:[item.x, item.y], r:item.w / 2}];
    const c = Math.cos((item.angle || 0) * Math.PI / 180), s = Math.sin((item.angle || 0) * Math.PI / 180);
    const at = (x, y) => [item.x + x * c - y * s, item.y + x * s + y * c];
    return [{poly:[at(-item.w / 2, -item.h / 2), at(item.w / 2, -item.h / 2), at(item.w / 2, item.h / 2), at(-item.w / 2, item.h / 2)], r:0}];
  }
  return [];
}
function gap(x, y) {
  if (x.poly && y.poly) throw Error("unused");
  if (y.poly) [x, y] = [y, x];
  if (x.poly) {
    if (inPoly(y.a, x.poly) || inPoly(y.b, x.poly)) return -y.r;
    let m = Infinity; for (let i = 0; i < x.poly.length; i++) m = Math.min(m, segSeg(y.a, y.b, x.poly[i], x.poly[(i + 1) % x.poly.length]));
    return m - y.r;
  }
  return segSeg(x.a, x.b, y.a, y.b) - x.r - y.r;
}
const layersOf = i => i.kind === "via" || (i.kind === "pad" && i.drill > 0) ? ["Top", "Bottom", "Inner 1", "Inner 2"] : [i.layer || "Top"];
// Smallest (edge gap - required clearance) between copper of different nets.
function audit(items, clearance = 0.2) {
  let worst = Infinity, where = null;
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const a = items[i], b = items[j];
    if (a.net && a.net === b.net) continue;
    if (!layersOf(a).some(l => layersOf(b).includes(l))) continue;
    for (const x of shapes(a)) for (const y of shapes(b)) {
      const g = gap(x, y) - clearance;
      if (g < worst) { worst = g; where = [a.id, b.id]; }
    }
  }
  return {worst, where};
}
function routeItems(result, net, extra = {}) {
  return result.preview.map((p, i) => ({id:"route" + i, kind:"track", points:p.points, width:p.width, layer:p.layer, net, ...extra}));
}
function withPushed(board, r) {
  const moved = new Map(r.pushed.map(p => [p.id, p]));
  return board.items.map(i => moved.has(i.id) ? {...i, ...moved.get(i.id)} : i);
}
const octilinear = pts => pts.every((p, i) => !i || (() => { const dx = Math.abs(p[0] - pts[i - 1][0]), dy = Math.abs(p[1] - pts[i - 1][1]); return dx < 1e-6 || dy < 1e-6 || Math.abs(dx - dy) < 1e-6; })());
const orthogonal = pts => pts.every((p, i) => !i || Math.abs(p[0] - pts[i - 1][0]) < 1e-6 || Math.abs(p[1] - pts[i - 1][1]) < 1e-6);
const near = (a, b, tol = 1e-6) => Math.hypot(a[0] - b[0], a[1] - b[1]) < tol;

function obstacleBoard() {
  const items = [];
  for (let i = 0; i < 6; i++) items.push({id:"v" + i, kind:"via", x:4 + i * 2.2, y:(i % 2) * 1.2 - 0.6, diameter:.7, drill:.35, layer:"Multi", net:"N" + i});
  items.push({id:"vcc", kind:"track", points:[[17, -4], [17, 0.5], [19, 2.5]], width:.3, layer:"Top", net:"VCC"});
  items.push({id:"end", kind:"pad", x:24, y:0, w:1.2, h:.8, angle:30, shape:"rect", layer:"Top", net:"SIG"});
  items.push({id:"start", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"});
  return {kind:"pcb", items, outline:[[-3, -6], [28, -6], [28, 7], [-3, 7]]};
}

// ---------------------------------------------------------------- tests
test("the obstacle index respects track-only and via-only keepouts", () => {
  const board = {kind:"pcb", items:[2, 1].map((restrictions, index) => ({
    id:"restriction-" + index, kind:"graphic", layer:"Keepout", width:.25,
    points:[[index * 10, -1], [index * 10, 1]], keepoutRestrictions:restrictions
  }))};
  const world = R.world(board, new Map(), {revision:1});
  function hits(x, kind) {
    const count = R.core.candidates(world, x, 0, x, 0, .2, 0, 0, kind);
    return world.qb.subarray(0, count).some(f => R.core.fdist(world, f, x, 0, x, 0) <= .2);
  }
  assert.equal(hits(0, "track"), true);
  assert.equal(hits(0, "via"), false);
  assert.equal(hits(10, "track"), false);
  assert.equal(hits(10, "via"), true);
});

test("walkaround routes around vias and tracks, keeps clearance and reaches the pad", () => {
  const board = obstacleBoard();
  for (const corner of ["45", "90", "45arc", "90arc", "any"]) {
    const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], width:.25, mode:"walkaround", corner});
    const r = s.move([24, 0]);
    assert.equal(r.status, "ok", corner);
    assert.ok(r.reached, corner + " auto-terminates on the same-net pad");
    const pts = r.preview[0].points;
    assert.ok(near(pts[0], [0, 0]) && near(pts.at(-1), [24, 0]), corner);
    const a = audit([...board.items, ...routeItems(r, "SIG")]);
    assert.ok(a.worst >= -1e-6, corner + " clearance shortfall " + a.worst + " at " + a.where);
    if (corner === "45") assert.ok(octilinear(pts), "45 degree corners");
    if (corner === "90") assert.ok(orthogonal(pts), "90 degree corners");
    if (corner === "45arc") assert.ok(pts.length > 8 && !octilinear(pts), "arcs are polylines");
    // The route really detours: the straight line would hit the vias.
    assert.ok(r.length > 24.2, corner);
  }
});

test("rounded corners keep the authored waypoint count at an exact tolerance boundary", () => {
  const radius=.002/(1-Math.SQRT1_2);
  const points=R.core.fillet([[0,0],[4,0],[4,6]],radius,null);
  assert.equal(points.length,4);
  assert.deepEqual(points.slice(0,2),[[0,0],[4-radius,0]]);
  assert.ok(near(points.at(-2),[4,radius],1e-12));
});

test("walkaround stops short when the cursor sits in another net's clearance", () => {
  const board = obstacleBoard();
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], mode:"walkaround"});
  const r = s.move([10.6, 0.2]);   // inside via v3's clearance
  assert.equal(r.status, "blocked");
  assert.ok(audit([...board.items, ...routeItems(r, "SIG")]).worst >= -1e-6);
  // Board outline: the cursor outside the board blocks.
  assert.equal(s.move([40, 0]).status, "blocked");
});

test("stop at first obstacle truncates; ignore obstacles reports the violation", () => {
  const board = obstacleBoard();
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], mode:"stop"});
  let r = s.move([24, 0]);
  assert.equal(r.status, "blocked");
  const end = r.end;
  assert.ok(end[0] > 2 && end[0] < 4, "stops before the first via");
  assert.ok(audit([...board.items, ...routeItems(r, "SIG")]).worst >= -1e-6);
  s.setMode("ignore");
  r = s.move([24, 0]);
  assert.equal(r.status, "violation");
  assert.ok(near(r.end, [24, 0]));
});

test("push shoves a crossing track and a via while keeping every clearance", () => {
  const board = {kind:"pcb", items:[
    {id:"start", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"t", kind:"track", points:[[2, 3], [2, .6], [12, .6], [12, 3]], width:.25, layer:"Top", net:"A"},
    {id:"via", kind:"via", x:6, y:-0.3, diameter:.6, drill:.3, layer:"Multi", net:"B"},
    {id:"t2", kind:"track", points:[[-2, -2], [12, -2]], width:.25, layer:"Top", net:"C"}
  ], outline:[[-5, -6], [15, -6], [15, 6], [-5, 6]]};
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], mode:"push", width:.25});
  // Head along y = 0.3 runs into track t (y = 0.6) clearance and the via.
  let r = s.move([10, 0.3]);
  assert.equal(r.status, "pushed");
  assert.ok(near(r.end, [10, 0.3]), "push keeps the cursor path");
  const ids = r.pushed.map(p => p.id).sort();
  assert.ok(ids.includes("t") && ids.includes("via"), "track and via moved: " + ids);
  const moved = withPushed(board, r);
  const a = audit([...moved, ...routeItems(r, "SIG")]);
  assert.ok(a.worst >= -1e-6, "clearance after push " + a.worst + " " + a.where);
  // The pushed track keeps its endpoints.
  const t = r.pushed.find(p => p.id === "t");
  assert.deepEqual(t.points[0], [2, 3]); assert.deepEqual(t.points.at(-1), [12, 3]);
  // Anchor, commit: the plan modifies the shoved items and adds the route.
  assert.ok(s.click().anchored);
  const plan = s.commit();
  assert.equal(plan.add.filter(i => i.kind === "track").length, 1);
  assert.deepEqual(plan.modify.map(m => m.id).sort(), ids);
  const after = R.apply(JSON.parse(JSON.stringify(board)), plan);
  assert.ok(audit(after.items).worst >= -1e-6, "applied plan is clean");
});

test("an unresolved via span still guards the interactive route", () => {
  require("../../app/pcb/stackup.js");
  require("../../app/pcb/viastack.js");
  const copper = ["Top", "Inner 1", "Inner 2", "Bottom"];
  const board = {kind:"pcb", items:[], stackup:AtriumStackup.build(Array(4).fill("Signal"))};
  const defs = new Map(), rules = {clearance:.05, trackWidth:.08};
  for (const [fromLayer, toLayer, occupied, strict] of [
    ["Top", "Inner 1", copper.slice(0,2), true],
    ["Inner 2", "Inner 1", copper.slice(1,3), true],
    ["Inner 1", "Inner 1", ["Inner 1"], false],
    ["Inner 1", undefined, copper, false],
    ["Top", "Unknown", copper, false],
    [undefined, undefined, copper, true]
  ]) {
    for (const stackMode of ["simple", "full"]) {
      const via = {id:"legacy-via", kind:"via", x:0, y:0, net:"OTHER", diameter:1.2, drill:.28, layer:"Multi", fromLayer, toLayer, stackMode};
      board.items = [via];
      assert.equal(!!AtriumPCBAppearance.copperSpan(via), strict);
      for (const layer of copper) {
        const route = R.begin(board, defs, {net:"SIGNAL", layer, start:[-3,0], width:.08, mode:"stop", corner:"any", rules});
        const result = route.move([3,0]), blocked = occupied.includes(layer);
        assert.equal(result.status, blocked ? "blocked" : "ok", [stackMode,fromLayer,toLayer,layer].join(" "));
        assert.equal(near(result.end,[3,0]), !blocked);
      }
    }
  }
});

test("the live router preserves variable via lands when it shoves the owner", () => {
  require("../../app/pcb/stackup.js");
  require("../../app/pcb/viastack.js");
  require("../../app/history/undo-store.js");
  const via={id:"layered-via",kind:"via",x:0,y:0,layer:"Multi",net:"OTHER",diameter:1.2,drill:.28,
    fromLayer:"Top",toLayer:"Inner 2",stackMode:"full",padStack:{Top:{diameter:1.2,shape:"rect"},"Inner 1":{diameter:.4},"Inner 2":{diameter:0}}};
  const board={kind:"pcb",id:"via-board",name:"Via board",items:[via],stackup:AtriumStackup.build(Array(4).fill("Signal"))};
  const defs=new Map(), rules={clearance:.05,trackWidth:.08};
  const session=(layer,y,mode="stop",world)=>R.begin(board,defs,{net:"SIGNAL",layer,start:[-3,y],width:.08,
    mode,corner:"any",rules,world,pushBudgetMs:35,moveBudgetMs:35});
  for (const [layer,y,expected] of [["Top",.4,"blocked"],["Inner 1",.4,"ok"],["Inner 1",0,"blocked"],["Inner 2",0,"ok"],["Bottom",0,"ok"]]) {
    const r=session(layer,y).move([3,y]);
    assert.equal(r.status,expected,layer+" via obstacle at y="+y);
    assert.equal(near(r.end,[3,y]),expected==="ok");
  }
  const world=R.core.buildWorld(board,defs,false), route=session("Inner 1",0,"push",world);
  const checker=R.core.rulesFor(board,rules), corner=[[.55,.55],[.65,.55]];
  assert.equal(R.check(world,checker,{net:"SIGNAL",layer:"Top",width:.08,points:corner}).ok,false,"square Top corner");
  const moved=route.move([3,0]), next=moved.pushed.find(p=>p.id===via.id);
  assert.ok(next&&moved.status==="pushed","the real preview moves the via");
  assert.equal(next.diameter,via.diameter,"preview retains the nominal diameter");
  function clears(w,layer,d) {
    const y=next.y+(next.y<0?-d:d), points=[[next.x-.8,y],[next.x+.8,y]];
    return R.check(w,checker,{net:"SIGNAL",layer,width:.08,points}).ok;
  }
  assert.equal(clears(world,"Inner 1",.4),true,"transient inner obstacle keeps the narrow land");
  assert.equal(clears(world,"Top",.4),false,"transient Top obstacle keeps the large land");
  assert.ok(route.click().anchored);
  const original = Atrium.clone(via), plan=route.commit(), U=AtriumUndoStore, history=[], future=[];
  const project={format:"atrium",version:1,name:"Via stack",documents:[board],library:[]};
  try {
    U.mark(project); U.prime();
    const before=U.mark(project);
    assert.deepEqual(Object.keys(plan.modify[0]).sort(),["id","x","y"],"the plan moves the via without rewriting its dimensions");
    R.apply(board,plan); U.checkpoint(history,future,before,"Route");
    U.record(project,{doc:board,items:[via.id,...plan.add]});
    const native=board.items.find(p=>p.id===via.id);
    assert.deepEqual(native.padStack,original.padStack);
    assert.equal(native.diameter,original.diameter);
    const rebuilt=R.core.buildWorld(board,defs,false);
    assert.equal(clears(rebuilt,"Inner 1",.4),true,"committed inner row");
    assert.equal(clears(rebuilt,"Top",.4),false,"committed Top row");
    assert.ok(U.jump(history,future,U.mark(project),-1)); U.record(project);
    assert.deepEqual(board.items,[original],"Undo restores the original layered via and removes the trace");
  } finally { U.reset(); }
});

// A step: a short segment between two turns of opposite sense (the hull-corner sawtooth).
function steps(pts, short) {
  let n = 0;
  const turn = (a, b, c) => Math.sign((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]));
  for (let i = 1; i + 2 < pts.length; i++) {
    const t1 = turn(pts[i - 1], pts[i], pts[i + 1]), t2 = turn(pts[i], pts[i + 1], pts[i + 2]);
    if (t1 && t2 && t1 !== t2 && Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]) < short) n++;
  }
  return n;
}
const busBoard = (n, extra = []) => ({kind:"pcb", items:[...Array.from({length:n}, (_, k) => ({id:"b" + k, kind:"track", layer:"Top", width:.2, net:"B" + k, points:[[0, k * .45], [12, k * .45]]})), ...extra]});
// The y at which a shoved bus track crosses the vertical line at x.
const yAt = (pts, x) => { for (let i = 1; i < pts.length; i++) { const a = pts[i - 1], b = pts[i]; if ((a[0] - x) * (b[0] - x) <= 0 && a[0] !== b[0]) return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); } return null; };

test("push: a crossed bus nests around the route's tip in order, tidy and clean", () => {
  for (const [start, cursor] of [[[6, -3], [6, 1.1]], [[3, -3], [6.2, .9]]]) {
    const board = busBoard(5);
    const s = R.begin(board, new Map(), {net:"S", layer:"Top", start, mode:"push", rules:{clearance:.2}, width:.2});
    const r = s.move(cursor);
    assert.equal(r.status, "pushed", "pushed from " + start);
    assert.equal(r.pushed.length, 5, "every bus track moves");
    for (const p of r.pushed) {
      const k = +p.id.slice(1);
      assert.deepEqual([p.points[0], p.points.at(-1)], [[0, k * .45], [12, k * .45]], "ends fixed");
      assert.ok(octilinear(p.points), p.id + " octilinear");
      assert.equal(steps(p.points, .3), 0, p.id + " has no sawtooth steps: " + JSON.stringify(p.points));
      // Never wrapped around the route's start (below it): the bump goes over the tip.
      assert.ok(Math.min(...p.points.map(q => q[1])) >= -1e-6, p.id + " stays above its row");
      assert.ok(p.points.length <= 10, p.id + " " + p.points.length + " vertices");
    }
    // The bus keeps its order over the tip.
    const over = r.pushed.sort((a, b) => a.id.localeCompare(b.id)).map(p => yAt(p.points, cursor[0]));
    for (let i = 1; i < over.length; i++) assert.ok(over[i] > over[i - 1] + .399, "order kept " + over);
    const a = audit([...withPushed(board, r), ...routeItems(r, "S")]);
    assert.ok(a.worst >= -1e-6, "clearance " + a.worst + " " + a.where);
  }
});

test("push: a shoved differential pair keeps its gap around the bump", () => {
  // USB_P / USB_N coupled at 0.3 mm gap (more than the 0.15 mm clearance); a route's tip pushes both.
  const pair = [["USB_P", 0], ["USB_N", .45]].map(([net, y]) => ({id:net, kind:"track", layer:"Top", width:.15, net, points:[[0, y], [12, y]]}));
  const board = {kind:"pcb", items:pair};
  const s = R.begin(board, new Map(), {net:"S", layer:"Top", start:[6, -3], mode:"push", rules:{clearance:.15, gap:.3}, width:.2});
  const r = s.move([6, .2]);
  assert.equal(r.status, "pushed");
  const [P, N] = ["USB_P", "USB_N"].map(id => r.pushed.find(p => p.id === id).points);
  let m = Infinity;
  for (let i = 1; i < P.length; i++) for (let j = 1; j < N.length; j++) m = Math.min(m, segSeg(P[i - 1], P[i], N[j - 1], N[j]) - .15);
  assert.ok(m >= .3 - 1e-6, "pair gap kept: " + m);
  assert.ok(Math.min(...P.map(q => q[1]), ...N.map(q => q[1])) >= -1e-6, "both go over the tip, not round the route's start");
  assert.ok(audit([...withPushed(board, r), ...routeItems(r, "S")], .15).worst >= -1e-6);
});

test("push: shoving a 16-track bus stays linear and within the default budget", () => {
  retrySamples(() => {
    const board = busBoard(16);
    for (const t of board.items) t.points = [[0, t.points[0][1]], [40, t.points[0][1]]];
    // Give the geometry check time to finish even if the host preempts it.
    // The measured moves still need to meet the default 5 ms push budget.
    const s = R.begin(board, new Map(), {net:"S", layer:"Top", start:[18, -4], mode:"push",
      rules:{clearance:.2}, width:.2, pushBudgetMs:50, moveBudgetMs:50});
    const times = [];
    let last;
    try {
      for (let i = 0; i <= 60; i++) {
        const y = -2 + 9 * i / 60, start = cpuNow();
        last = s.move([20, y]);
        const elapsed = cpuNow() - start;
        if (i <= 12) continue;
        assert.equal(last.status, "pushed", "tip at y " + y.toFixed(2));
        times.push(elapsed);
      }
      assert.equal(last.pushed.length, 16);
      assert.ok(audit([...withPushed(board, last), ...routeItems(last, "S")]).worst >= -1e-6);
      for (const p of last.pushed) assert.equal(steps(p.points, .3), 0, p.id);
    } finally { s.cancel(); }
    console.log("  16-track bus push: worst move " + Math.max(...times).toFixed(2) + " ms");
    return times;
  }, times => {
    const worst = Math.max(...times);
    return worst < 5 ? "" : "worst bus push " + worst.toFixed(2) + " ms (budget < 5 ms)";
  });
});

test("push falls back to walkaround when immovable copper blocks it", () => {
  const board = {kind:"pcb", items:[
    {id:"start", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"pad", kind:"pad", x:5, y:0, w:1.5, h:1.5, shape:"rect", layer:"Top", net:"GND"}
  ]};
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], mode:"push"});
  const r = s.move([10, 0]);
  assert.equal(r.status, "ok");
  assert.equal(r.pushed.length, 0);
  assert.ok(r.length > 10.05, "walked around the pad");
  assert.ok(audit([...board.items, ...routeItems(r, "SIG")]).worst >= -1e-6);
});

test("hug and push: hugs when the detour is small, pushes when it is large", () => {
  const board = {kind:"pcb", items:[
    {id:"start", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"wall", kind:"track", points:[[5, -20], [5, 20]], width:.25, layer:"Top", net:"A"},
    {id:"via", kind:"via", x:2.5, y:0, diameter:.5, drill:.25, layer:"Multi", net:"B"}
  ]};
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], mode:"hug"});
  let r = s.move([4, 0]);
  assert.equal(r.status, "ok", "small detour around the via is hugged");
  assert.equal(r.pushed.length, 0);
  r = s.move([7, 0]);
  assert.equal(r.status, "pushed", "the long wall is pushed rather than walked around");
  assert.ok(audit([...withPushed(board, r), ...routeItems(r, "SIG")]).worst >= -1e-6);
});

test("keep-outs and the board edge are obstacles", () => {
  const board = {kind:"pcb", items:[
    {id:"start", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"k", kind:"graphic", points:[[3, -3], [5, -3], [5, 3], [3, 3]], closed:true, fill:true, width:0, layer:"Keepout"}
  ], outline:[[-2, -4], [10, -4], [10, 4], [-2, 4]]};
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], mode:"walkaround", width:.2, rules:{clearance:.2, edgeClearance:.3}});
  const r = s.move([8, 0]);
  assert.equal(r.status, "ok");
  for (const p of r.preview[0].points) {
    assert.ok(!(p[0] > 3 - .1 + 1e-6 && p[0] < 5 + .1 - 1e-6 && Math.abs(p[1]) < 3 + .1 - 1e-6), "outside the keep-out: " + p);
    assert.ok(Math.abs(p[1]) <= 4 - .3 - .1 + 1e-6, "edge clearance kept: " + p);
  }
  const pts = r.preview[0].points;
  for (let i = 1; i < pts.length; i++) {
    const g = segSeg(pts[i - 1], pts[i], [3, -3], [5, -3]), h = segSeg(pts[i - 1], pts[i], [3, 3], [5, 3]);
    assert.ok(Math.min(g, h) >= .1 - 1e-6 || pts[i - 1][0] > 5.1 || pts[i][0] < 2.9);
  }
});

test("per-net clearance comes from AtriumRules.query when present", () => {
  const saved = globalThis.AtriumRules;
  globalThis.AtriumRules = {query(board, type, ctx) {
    if (type === "clearance") return (ctx.net === "HV" || ctx.net2 === "HV") ? {min:1.0} : 0.2;
    if (type === "width") return {min:.1, preferred:.3, max:2};
    return null;
  }};
  try {
    const board = {kind:"pcb", items:[
      {id:"start", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
      {id:"hv", kind:"via", x:5, y:0, diameter:.6, drill:.3, layer:"Multi", net:"HV"}
    ]};
    const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], mode:"walkaround"});
    assert.equal(s.state.width, .3, "preferred width from the rule");
    const r = s.move([10, 0]);
    assert.ok(audit([...board.items, ...routeItems(r, "SIG")], 1.0).worst >= -1e-6, "HV clearance of 1 mm kept");
    const p = R.presets(board, "SIG");
    assert.ok(p.widths.includes(.3) && p.widths[0] >= .1 && p.widths.at(-1) <= 2);
  } finally { globalThis.AtriumRules = saved; }
});

test("version 2 rules from rules.js: net clearance, preferred width, via style and pair rules", () => {
  const saved = globalThis.AtriumRules;
  delete globalThis.AtriumRules;
  require("../../app/checks/rules.js");
  const Rules = globalThis.AtriumRules;
  try {
    const set = Rules.create();
    const base = set.list.find(r => r.type === "clearance");
    set.list.unshift({...JSON.parse(JSON.stringify(base)), id:"hv", name:"HV", priority:1, scope:{kind:"net", value:"HV"}, scope2:{kind:"all"}, gap:1});
    set.list.forEach((r, i) => { if (r !== set.list[0] && r.type === "clearance") r.priority = 2; });
    for (const r of set.list) {
      if (r.type === "width") Object.assign(r, {min:.1, preferred:.3, max:2});
      if (r.type === "viaStyle") Object.assign(r, {diameterPreferred:.55, holePreferred:.3});
      if (r.type === "diffPairsRouting") Object.assign(r, {widthPreferred:.12, gapPreferred:.18});
    }
    set.diffPairs = [{name:"USB", positive:"D+", negative:"D-"}];
    const board = {kind:"pcb", rules:set, items:[
      {id:"start", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
      {id:"hv", kind:"via", x:5, y:0, diameter:.6, drill:.3, layer:"Multi", net:"HV"},
      {id:"lv", kind:"via", x:9, y:.9, diameter:.6, drill:.3, layer:"Multi", net:"LV"}
    ]};
    const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0]});
    assert.equal(s.state.width, .3);
    assert.deepEqual(s.state.via, {diameter:.55, drill:.3});
    const r = s.move([12, 0]);
    assert.equal(r.status, "ok");
    const items = [...board.items, ...routeItems(r, "SIG")];
    assert.ok(audit(items.filter(i => i.id !== "lv"), 1).worst >= -1e-6, "1 mm to HV");
    assert.ok(audit(items.filter(i => i.id !== "hv"), .2).worst >= -1e-6, "0.2 mm to LV");
    const dp = R.core.rulesFor(board).diffPair("D+", "D-", "USB", "Top");
    assert.equal(dp.width, .12); assert.equal(dp.gap, .18);
  } finally { globalThis.AtriumRules = saved; }
});

test("legacy board.rules net overrides are honoured", () => {
  const board = {kind:"pcb", rules:{format:"atrium-rules", version:1, units:"mm", defaults:{clearance:.2, trackWidth:.15, viaDrill:.3}, nets:{GND:{clearance:.6}}}, items:[
    {id:"start", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"g", kind:"via", x:5, y:0, diameter:.6, drill:.3, layer:"Multi", net:"GND"}
  ]};
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0]});
  const r = s.move([10, 0]);
  assert.ok(audit([...board.items, ...routeItems(r, "SIG")], .6).worst >= -1e-6);
});

test("neck-down: a wide track into a fine-pitch pad finishes at the Width rule minimum", () => {
  // QFN-like row: 0.2 mm pads at 0.4 mm pitch; the middle one is ours. 0.35 mm does not fit between
  // its neighbours with 0.15 mm clearance; the rule's 0.2 mm minimum does.
  const pads = Array.from({length:5}, (_, k) => ({id:"p" + k, kind:"pad", x:(k - 2) * .4, y:0, w:.2, h:.8, shape:"rect", layer:"Top", net:k === 2 ? "SIG" : "N" + k}));
  const board = {kind:"pcb", items:[...pads, {id:"s", kind:"pad", x:0, y:-6, w:1, h:1, shape:"round", layer:"Top", net:"SIG"}]};
  // Clearance and Width rules through AtriumRules.resolver.
  const saved = globalThis.AtriumRules;
  globalThis.AtriumRules = {resolver:() => (type, ctx) => type === "clearance" ? {value:.15} : type === "width" ? {min:.2, preferred:.35, max:1} : undefined};
  try {
    for (const mode of ["walkaround", "push", "hug"]) {
      const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, -6], mode});
      assert.equal(s.state.width, .35);
      const r = s.move([0, 0]);
      assert.equal(r.status, "ok", mode);
      assert.ok(r.reached, mode + " reaches the pad");
      const neck = r.preview.find(p => p.neck);
      assert.ok(neck, mode + " necks down"); assert.equal(neck.width, .2);
      assert.ok(R.core.pathLength(neck.points) <= 1.5 + 1e-9, "a short neck " + R.core.pathLength(neck.points));
      assert.equal(r.preview.find(p => p.head && !p.neck).width, .35, "full width up to the neck");
      const clean = tracks => board.items.every(pad => audit([pad, ...tracks], .15).worst >= -1e-6);
      assert.ok(clean(r.preview.map((p, i) => ({id:"r" + i, kind:"track", points:p.points, width:p.width, layer:"Top", net:"SIG"}))), mode + " clean");
      const c = s.click(); assert.ok(c.done, "the click finishes on the pad");
      const plan = s.commit();
      assert.deepEqual(plan.add.map(t => t.width).sort(), [.2, .35]);
      assert.ok(clean(plan.add), mode + " committed clean");
    }
    // Off: the head stops short instead.
    const off = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, -6], neckDown:false});
    assert.ok(!off.move([0, 0]).reached);
    // A rule's neck length (the impedance neck-down budget) replaces the default: too short a budget, no neck.
    // (A new board object each time: rules are cached per board.)
    globalThis.AtriumRules = {resolver:() => (type, ctx) => type === "clearance" ? {value:.15} : type === "width" ? {min:.2, preferred:.35, max:1, neckLength:.05} : undefined};
    assert.ok(!R.begin({...board}, new Map(), {net:"SIG", layer:"Top", start:[0, -6]}).move([0, 0]).reached, "a neck longer than the rule's neck length is not made");
    globalThis.AtriumRules = {resolver:() => (type, ctx) => type === "clearance" ? {value:.15} : type === "width" ? {min:.2, preferred:.35, max:1, neckLength:1} : undefined};
    assert.ok(R.begin({...board}, new Map(), {net:"SIG", layer:"Top", start:[0, -6]}).move([0, 0]).reached, "within the rule's neck length");
  } finally { globalThis.AtriumRules = saved; }
});

test("walkaround keeps its side under hand jitter and switches when the cursor really crosses", () => {
  const sideOf = pts => { const o = pts[0]; let a = 0; for (let i = 1; i < pts.length; i++) a += (pts[i - 1][0] - o[0]) * (pts[i][1] - o[1]) - (pts[i][0] - o[0]) * (pts[i - 1][1] - o[1]); return Math.abs(a) < 1e-6 ? 0 : Math.sign(a); };
  let seed = 5; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const board = {kind:"pcb", items:[{id:"v", kind:"via", x:5, y:0, diameter:.6, drill:.3, layer:"Multi", net:"V"},
    {id:"p", kind:"pad", x:0, y:-.3, w:.3, h:.3, shape:"round", layer:"Top", net:"D_P"}, {id:"n", kind:"pad", x:0, y:.3, w:.3, h:.3, shape:"round", layer:"Top", net:"D_N"}]};
  const single = {kind:"pcb", items:[board.items[0]]};
  const s = R.begin(single, new Map(), {net:"S", layer:"Top", start:[0, 0], mode:"walkaround", rules:{clearance:.2}, width:.2});
  let flips = 0, last = 0;
  for (let i = 0; i < 150; i++) {
    const r = s.move([6.5 + i * .04, (rnd() - .5) * .1]);
    assert.equal(r.status, "ok");
    const sd = sideOf(r.preview.find(p => p.head).points);
    if (last && sd && sd !== last) flips++;
    if (sd) last = sd;
  }
  assert.equal(flips, 0, "no flips under ±0.05 mm jitter");
  // A deliberate sweep across the via's axis switches once, just past it.
  const t = R.begin(single, new Map(), {net:"S", layer:"Top", start:[0, 0], mode:"walkaround", rules:{clearance:.2}, width:.2});
  const switches = [];
  last = 0;
  for (let i = 0; i <= 60; i++) { const y = -1.5 + i * .05, sd = sideOf(t.move([8, y]).preview.find(p => p.head).points); if (last && sd && sd !== last) switches.push(y); if (sd) last = sd; }
  assert.equal(switches.length, 1, "one switch " + switches);
  assert.ok(switches[0] > 0 && switches[0] < .5, "past the axis " + switches[0]);
  // The diff pair's centreline is just as steady.
  const DPc = globalThis.AtriumDiffPair;
  const ps = DPc.begin(board, new Map(), {pair:{name:"D", positive:"D_P", negative:"D_N"}, layer:"Top", start:[0, -.3], gap:.15, width:.15, rules:{clearance:.2}});
  flips = 0; last = 0;
  for (let i = 0; i < 150; i++) {
    const r = ps.move([8 + i * .03, (rnd() - .5) * .1]), cl = r.centre?.at(-1);
    if (r.status !== "ok" || !cl || cl.length < 2) continue;
    const sd = sideOf(cl); if (last && sd && sd !== last) flips++; if (sd) last = sd;
  }
  assert.equal(flips, 0, "pair: no flips");
});

test("energy: a repeated cursor point reuses the result; any change recomputes", () => {
  const board = obstacleBoard();
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], mode:"push"});
  const a = s.move([10, .3]), b = s.move([10, .3]);
  assert.equal(a, b, "same point: the cached preview");
  s.setCorner("90");
  const c = s.move([10, .3]);
  assert.notEqual(c, b); assert.equal(c.corner, "90");
  assert.notEqual(s.move([10.1, .3]), c, "a new point recomputes");
  s.setVia({diameter:.5, drill:.25});
  assert.equal(s.move([10.1, .3]).via.diameter, .5, "a via style change shows");
  // Something else resetting the shared routing world invalidates the cache too.
  const d = s.move([10.1, .3]); s.world.scene.reset();
  assert.notEqual(s.move([10.1, .3]), d);
  const DPc = globalThis.AtriumDiffPair;
  if (DPc) {
    const pb = {kind:"pcb", items:[{id:"p", kind:"pad", x:0, y:-.5, w:.6, h:.6, shape:"round", layer:"Top", net:"U_P"}, {id:"n", kind:"pad", x:0, y:.5, w:.6, h:.6, shape:"round", layer:"Top", net:"U_N"}]};
    const ps = DPc.begin(pb, new Map(), {net:"U_P", layer:"Top", start:[0, -.5], gap:.2, width:.2, rules:{clearance:.2}});
    const x = ps.move([8, 2]); assert.equal(ps.move([8, 2]), x); ps.setGap(.25); assert.notEqual(ps.move([8, 2]), x);
  }
});

test("session: click anchors, back retracts, corner/mode cycling, layer switch drops a via", () => {
  const board = obstacleBoard();
  board.items.push({id:"bend", kind:"pad", x:10, y:5, w:1, h:1, shape:"round", drill:.5, layer:"Multi", net:"SIG"});
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0], mode:"walkaround"});
  assert.equal(s.cycleMode(), "push"); assert.equal(s.cycleMode(), "hug"); assert.equal(s.cycleMode(), "stop");
  assert.equal(s.cycleMode(), "ignore"); assert.equal(s.cycleMode(), "walkaround");
  assert.equal(s.cycleCorner(), "45arc"); assert.equal(s.cycleCorner(), "90"); assert.equal(s.cycleCorner(-1), "45arc"); s.setCorner("45");
  s.move([2, 3]); assert.ok(s.click().anchored);
  let r = s.move([6, 3]);
  assert.equal(r.preview.length, 2, "anchored track plus head");
  assert.ok(s.click().anchored);
  assert.ok(s.back(), "Backspace retracts");
  r = s.move([6, 3]);
  assert.equal(r.preview.length, 2);
  const sw = s.switchLayer("Bottom");
  assert.ok(sw.ok, sw.message);
  assert.equal(s.state.layer, "Bottom");
  r = s.move([10, 5]);
  assert.ok(r.reached, "reaches the through-hole pad on Bottom");
  assert.equal(r.vias.length, 1);
  assert.equal(r.preview.at(-1).layer, "Bottom");
  const done = s.click();
  assert.ok(done.done);
  const plan = s.commit();
  assert.deepEqual(plan.add.map(i => i.kind + ":" + (i.layer || "")).sort(), ["track:Bottom", "track:Top", "via:Multi"]);
  const via = plan.add.find(i => i.kind === "via");
  const top = plan.add.find(i => i.layer === "Top"), bottom = plan.add.find(i => i.layer === "Bottom");
  assert.ok(near(top.points.at(-1), [via.x, via.y]) && near(bottom.points[0], [via.x, via.y]), "tracks meet at the via");
  assert.ok(audit([...board.items, ...plan.add]).worst >= -1e-6);
  // Width and via presets.
  const w0 = s.state.width;
  assert.ok(s.nextWidth() > w0);
  assert.notDeepEqual(s.nextVia(), {diameter:.6, drill:.3});
});

test("Ctrl+Click auto-complete routes to a distant pad; addVia keeps the layer", () => {
  const board = {kind:"pcb", items:[
    {id:"u", kind:"track", points:[[2, -4], [10, -4], [10, 4], [2, 4]], width:.4, layer:"Top", net:"GND"},
    {id:"a", kind:"pad", x:6, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"b", kind:"pad", x:20, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"}], outline:[[-3, -10], [25, -10], [25, 10], [-3, 10]]};
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[6, 0]});
  const c = s.complete([20, 0]);
  assert.ok(c.ok && c.done, "completed onto the pad");
  const plan = s.commit();
  assert.ok(audit([...board.items, ...plan.add]).worst >= -1e-6);
  const s2 = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[6, 0]});
  s2.move([7, 0]);
  const v = s2.addVia();
  assert.ok(v.ok); assert.equal(s2.state.layer, "Top");
  assert.equal(s2.move([8, 1]).vias.length, 1);
});

test("a via that does not fit backs off along the route", () => {
  const board = {kind:"pcb", items:[
    {id:"start", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"b", kind:"track", points:[[6, -3], [6, 3]], width:.25, layer:"Bottom", net:"X"}
  ]};
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0]});
  s.move([6, 0]);
  const sw = s.switchLayer("Bottom");
  assert.ok(sw.ok);
  assert.ok(sw.via.x <= 6 - .125 - .3 - .2 + 1e-6, "via clears the bottom track: " + sw.via.x);
});

test("commit removes a redundant same-net loop", () => {
  const board = {kind:"pcb", items:[
    {id:"a", kind:"pad", x:0, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"b", kind:"pad", x:10, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"old", kind:"track", points:[[0, 0], [0, 4], [10, 4], [10, 0]], width:.25, layer:"Top", net:"SIG"}
  ]};
  const s = R.begin(board, new Map(), {net:"SIG", layer:"Top", start:[0, 0]});
  const r = s.move([10, 0]);
  assert.ok(r.reached);
  s.click();
  const plan = s.commit();
  assert.deepEqual(plan.remove, ["old"]);
});

test("gloss merges end-to-end tracks, removes redundant vertices and straightens wiggles", () => {
  const board = {kind:"pcb", items:[
    {id:"g1", kind:"track", points:[[0, 0], [1, 0], [2, 0], [2, 0], [3, 1], [4, 1], [4, 1.0000001]], width:.25, layer:"Top", net:"X"},
    {id:"g2", kind:"track", points:[[4, 1.0000001], [5, 1], [8, 1]], width:.25, layer:"Top", net:"X"},
    // A wiggle with a free straight path.
    {id:"w", kind:"track", points:[[0, 5], [2, 5], [2, 6], [4, 6], [4, 5], [8, 5]], width:.25, layer:"Top", net:"Y"},
    // A wiggle that must stay because a via blocks the straight line.
    {id:"k", kind:"track", points:[[0, 10], [2, 10], [3, 11], [5, 11], [6, 10], [8, 10]], width:.25, layer:"Top", net:"Z"},
    {id:"obstacle", kind:"via", x:4, y:10, diameter:.6, drill:.3, layer:"Multi", net:"Q"}
  ]};
  const plan = R.gloss(board, new Map(), {});
  assert.deepEqual(plan.remove, ["g2"], "merged into g1");
  const g1 = plan.modify.find(m => m.id === "g1");
  assert.ok(g1.points.length <= 4, "redundant and collinear vertices removed: " + JSON.stringify(g1.points));
  assert.deepEqual(g1.points[0], [0, 0]); assert.deepEqual(g1.points.at(-1), [8, 1]);
  assert.ok(octilinear(g1.points));
  const w = plan.modify.find(m => m.id === "w");
  assert.deepEqual(w.points, [[0, 5], [8, 5]], "wiggle straightened");
  const k = plan.modify.find(m => m.id === "k");
  if (k) assert.ok(audit([{...board.items[3], points:k.points}, board.items[4]]).worst >= -1e-6, "kept clear of the via");
  const after = R.apply(JSON.parse(JSON.stringify(board)), plan);
  assert.equal(after.items.length, 4);
  assert.ok(audit(after.items).worst >= -1e-6);
});

test("retrace re-applies width and clearance", () => {
  const board = {kind:"pcb", items:[
    {id:"t", kind:"track", points:[[0, 0], [10, 0]], width:.15, layer:"Top", net:"S"},
    {id:"v", kind:"via", x:5, y:.7, diameter:.6, drill:.3, layer:"Multi", net:"Q"}
  ]};
  const plan = R.retrace(board, new Map(), {ids:["t"], width:.4});
  assert.equal(plan.modify.length, 1);
  assert.equal(plan.modify[0].width, .4);
  assert.ok(audit([{...board.items[0], ...plan.modify[0]}, board.items[1]]).worst >= -1e-6);
});

test("headless route(): walkaround, grid fallback for long detours, multi-layer with vias", () => {
  const items = [
    {id:"u", kind:"track", points:[[2, -4], [10, -4], [10, 4], [2, 4]], width:.4, layer:"Top", net:"GND"},
    {id:"w1", kind:"track", points:[[14, -8], [14, 6]], width:.4, layer:"Top", net:"VCC"},
    {id:"w2", kind:"track", points:[[18, -6], [18, 8]], width:.4, layer:"Top", net:"VCC"},
    {id:"a", kind:"pad", x:6, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"},
    {id:"b", kind:"pad", x:24, y:0, w:1, h:1, shape:"round", layer:"Top", net:"SIG"}
  ];
  const board = {kind:"pcb", items, outline:[[-3, -10], [28, -10], [28, 10], [-3, 10]]};
  const r = R.route(board, new Map(), {net:"SIG", from:[6, 0], to:[24, 0], layer:"Top", width:.25});
  assert.ok(r.ok);
  assert.ok(r.length < 40, "global search beats the long local detour: " + r.length);
  assert.ok(audit([...items, ...r.plan.add]).worst >= -1e-6);
  const two = R.route(board, new Map(), {net:"SIG", from:[6, 0], to:[24, 0], layers:["Top", "Bottom"], width:.25, method:"grid"});
  assert.ok(two.ok);
  const vias = two.plan.add.filter(i => i.kind === "via");
  assert.ok(vias.length >= 2, "down and back up to the Top-only pad");
  const lastTrack = two.plan.add.filter(i => i.kind === "track").find(t => near(t.points.at(-1), [24, 0]) || near(t.points[0], [24, 0]));
  assert.equal(lastTrack.layer, "Top");
  assert.ok(audit([...items, ...two.plan.add]).worst >= -1e-6);
  // Simple open board: walkaround alone.
  const easy = R.route({kind:"pcb", items:[items[3], items[4]]}, new Map(), {net:"SIG", from:[6, 0], to:[24, 0]});
  assert.equal(easy.method, "walkaround"); assert.ok(Math.abs(easy.length - 18) < 1e-6);
});

test("dense board: heads that stop short are glossed too (few steps, few vertices)", () => {
  const {d, defs} = makeAtriumBenchmarkBoard(60);
  let k = 0; for (const i of d.items) if (i.kind === "via" || i.kind === "track") i.net = "N" + (k++ % 400);
  const vias = d.items.filter(i => i.kind === "via");
  let seed = 99; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let blocked = 0, stepped = 0, verts = 0;
  for (let n = 0; n < 30; n++) {
    const v = vias[Math.floor(rnd() * vias.length)], ang = rnd() * Math.PI * 2;
    const s = R.begin(d, defs, {net:v.net, layer:"Top", start:[v.x, v.y], mode:"walkaround", revision:"gloss", moveBudgetMs:50});
    for (let i = 0; i < 30; i++) {
      const r = s.move([v.x + Math.cos(ang) * (0.5 + i * .25), v.y + Math.sin(ang) * (0.5 + i * .25)]);
      if (r.status !== "blocked") continue;
      const h = r.preview.find(p => p.head)?.points || [];
      blocked++; verts += h.length; if (steps(h, .25)) stepped++;
    }
    s.cancel();
  }
  assert.ok(blocked > 100, "enough blocked heads " + blocked);
  // Before: about half stepped with ~11.6 vertices on average.
  assert.ok(stepped / blocked < .35, "stepped " + stepped + " of " + blocked);
  assert.ok(verts / blocked < 9.5, "mean vertices " + (verts / blocked).toFixed(2));
});

function measureDenseMoves() {
  const {d, defs} = makeAtriumBenchmarkBoard();
  let k = 0; for (const i of d.items) if (i.kind === "via" || i.kind === "track") i.net = "N" + (k++ % 400);
  const t0 = timer(); R.world(d, defs, {revision:"bench"}); const build = timer() - t0;
  const vias = d.items.filter(i => i.kind === "via");
  let seed = 99; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const times = [];
  for (const mode of ["walkaround", "push", "hug"]) for (let n = 0; n < 25; n++) {
    const v = vias[Math.floor(rnd() * vias.length)], ang = rnd() * Math.PI * 2;
    const s = R.begin(d, defs, {net:v.net, layer:"Top", start:[v.x, v.y], mode, revision:"bench"});
    for (let i = 0; i < 40; i++) {
      const p = [v.x + Math.cos(ang) * (0.5 + i * .3), v.y + Math.sin(ang) * (0.5 + i * .3)];
      const t = timer(); const r = s.move(p); times.push(timer() - t);
      if (i % 13 === 0 && r.status !== "violation") assert.ok(audit([...d.items.filter(o => o.kind !== "part" && Math.hypot((o.x ?? o.points[0][0]) - v.x, (o.y ?? o.points[0][1]) - v.y) < 20), ...routeItems(r, v.net)].filter(o => o.kind !== "pad")).worst >= -1e-6 || r.pushed.length);
    }
    s.cancel();
  }
  const sorted = times.slice().sort((a, b) => a - b);
  const median = sorted[times.length >> 1], p99 = sorted[Math.floor(times.length * .99)], max = sorted.at(-1);
  console.log("  dense board: world build " + build.toFixed(1) + " ms; move median " + median.toFixed(3) + " ms, p99 " + p99.toFixed(3) + " ms, max " + max.toFixed(3) + " ms over " + times.length + " moves");
  return times;
}

test("dense 25k-object board: move() stays within the interactive budget", () => {
  retrySamples(measureDenseMoves, times => {
    const sorted = times.slice().sort((a, b) => a - b);
    const median = sorted[times.length >> 1], max = sorted.at(-1);
    if (!(median < 2)) return "median move " + median.toFixed(3) + " ms (budget < 2 ms)";
    return max < 25 ? "" : "worst move " + max.toFixed(3) + " ms (budget < 25 ms)";
  });
});

let failed = 0;
for (const c of cases) {
  try { c.run(); console.log("PASS " + c.name); }
  catch (e) { failed++; console.log("FAIL " + c.name + "\n  " + (e && e.message || e)); }
}
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " router test(s) failed"); }
