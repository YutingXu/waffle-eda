"use strict";
// Via fencing and stitching: fences along tracks (corners, caps, rows, pairs),
// board-edge and area stitching (pour-aware, verified with connectivity),
// return-path vias, regeneration, staleness, removal and performance.
// Legality is verified with an independent geometry check, not the engine's.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "pcb-appearance", "pcb-pours", "polygon-pour", "connectivity", "stackup", "rules", "viastack", "router", "board-shape", "board-shape-editing", "via-fence"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("./dense-board.js");
const F = globalThis.AtriumViaFence, PP = globalThis.AtriumPolygonPour;
const timer = typeof performance !== "undefined" ? () => performance.now() : typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
const cases = [];
const test = (name, run) => cases.push({name, run});

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
let nid = 0; const id = () => "t" + (++nid);
const rules = (extra = []) => ({format:"atrium-rules", version:2, units:"mm", list:[
  {id:"c", type:"clearance", name:"Clearance", enabled:true, priority:1, scope:AtriumDesignQueryRecord.selector("all"), scope2:AtriumDesignQueryRecord.selector("all"), gap:.2},
  {id:"h", type:"holeToHole", name:"HoleToHole", enabled:true, priority:1, scope:AtriumDesignQueryRecord.selector("all"), gap:.254},
  {id:"v", type:"viaStyle", name:"RoutingVias", enabled:true, priority:1, scope:AtriumDesignQueryRecord.selector("all"), diameterPreferred:.5, holePreferred:.25, holeMin:.2}, ...extra], defaults:{}, nets:{}});
function board(items, outline = rect(0, 0, 60, 40), extra = {}) { return {id:id(), kind:"pcb", name:"B", grid:.25, items, outline, notes:[], rules:rules(), ...extra}; }
const track = (pts, net, width = .3, layer = "Top") => ({id:id(), kind:"track", points:pts, width, layer, net});
const via = (x, y, net, d = .6, drill = .3) => ({id:id(), kind:"via", x, y, diameter:d, drill, layer:"Multi", net});
const pad = (x, y, w, h, net) => ({id:id(), kind:"pad", x, y, w, h, shape:"rect", layer:"Top", net});
const defs = new Map();

// ---------------------------------------------------------------- independent check
function segDist(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy; const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); }
function copperGap(v, o) {
  const c = [v.x, v.y], r = v.diameter / 2;
  if (o.kind === "track") { let m = Infinity; for (let i = 1; i < o.points.length; i++) m = Math.min(m, segDist(c, o.points[i - 1], o.points[i])); return m - o.width / 2 - r; }
  if (o.kind === "via") return Math.hypot(o.x - v.x, o.y - v.y) - o.diameter / 2 - r;
  if (o.kind === "pad") { const dx = Math.max(0, Math.abs(v.x - o.x) - o.w / 2), dy = Math.max(0, Math.abs(v.y - o.y) - o.h / 2); return Math.hypot(dx, dy) - r; }
  return Infinity;
}
// Worst slack of the added vias: copper clearance (other nets), hole to hole (all), board edge.
function audit(b, added, clr = .2, hh = .254, edge = .2) {
  let worst = Infinity;
  const all = [...b.items.filter(i => !added.includes(i)), ...added];
  for (const v of added) {
    for (const o of all) {
      if (o === v) continue;
      if (o.net !== v.net && (o.kind === "track" || o.kind === "via" || o.kind === "pad")) worst = Math.min(worst, copperGap(v, o) - clr);
      if (o.kind === "via" && o.drill > 0) worst = Math.min(worst, Math.hypot(o.x - v.x, o.y - v.y) - o.drill / 2 - v.drill / 2 - hh);
    }
    let e = Infinity; const ol = b.outline; for (let i = 0; i < ol.length; i++) e = Math.min(e, segDist([v.x, v.y], ol[i], ol[(i + 1) % ol.length]));
    worst = Math.min(worst, e - v.diameter / 2 - edge);
  }
  return worst;
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, (msg || "") + " got " + a + " want " + b + " ±" + eps);

// ---------------------------------------------------------------- fences
test("straight line: both sides at rule clearance, pitch, groups, legal", () => {
  const t = track([[10, 20], [50, 20]], "RF", .3);
  const b = board([t]);
  const p = F.plan(b, defs, {kind:"path", source:{trackIds:[t.id]}, params:{net:"GND", pitch:1, ends:"terminate"}});
  // 41 vias per side at 1 mm over 40 mm
  assert.equal(p.add.length, 82, "count " + p.add.length);
  assert.equal(p.stats.skipped, 0);
  const d = .15 + .2 + .25;   // half width + clearance + via radius
  for (const v of p.add) { near(Math.abs(v.y - 20), d, 1e-6, "row offset"); assert.equal(v.net, "GND"); assert.equal(v.diameter, .5); assert.equal(v.drill, .25); assert.ok(/^fence:/.test(v.groupId)); }
  assert.ok(audit(b, p.add) >= -1e-6);
  near(p.stats.largestGap, 1, 1e-6, "gap");
  F.applyPlan(b, p);
  assert.equal(b.viaFences.length, 1);
  const st = F.status(b, defs);
  assert.equal(st[0].vias, 82); assert.equal(st[0].stale, false);
  assert.equal(F.fenceOfSelection(b, new Set(b.items.filter(i => F.fenceOfItem(i)).slice(0, 3).map(i => i.id))), st[0].id);
});
test("caps wrap the free ends; L corner gets a corner via; spacing ≤ pitch along the curve", () => {
  const t = track([[10, 10], [30, 10], [30, 30]], "RF", .3);
  const b = board([t]);
  const p = F.plan(b, defs, {kind:"path", source:{trackIds:[t.id]}, params:{net:"GND", pitch:1, ends:"cap"}});
  const d = .6;
  assert.ok(p.add.some(v => Math.abs(v.x - (10 - d)) < 1e-6 && Math.abs(v.y - 10) < 1e-6), "cap tip at start");
  assert.ok(p.add.some(v => Math.abs(v.x - 30) < 1e-6 && Math.abs(v.y - (30 + d)) < 1e-6), "cap tip at end");
  const c = d / Math.SQRT2;
  assert.ok(p.add.some(v => Math.abs(v.x - (30 + c)) < 1e-6 && Math.abs(v.y - (10 - c)) < 1e-6), "outer corner via on the bisector");
  assert.ok(audit(b, p.add) >= -1e-6);
  // neighbours never further apart than the pitch (closed loop around the stroke)
  for (const v of p.add) { let m = Infinity; for (const w of p.add) if (w !== v) m = Math.min(m, Math.hypot(w.x - v.x, w.y - v.y)); assert.ok(m <= 1 + 1e-6, "neighbour " + m); }
  assert.equal(p.stats.largestGap <= 1 + 1e-6, true);
});
test("ends on a pad of the line's own net stop abreast instead of capping", () => {
  const t = track([[10, 20], [40, 20]], "RF", .3);
  const b = board([t, {...pad(10, 20, 1.2, 1, "RF")}]);
  const p = F.plan(b, defs, {kind:"path", source:{trackIds:[t.id]}, params:{net:"GND", pitch:1, ends:"cap"}});
  assert.ok(!p.add.some(v => v.x < 10 - 1e-6), "no cap at the pad end");
  assert.ok(p.add.some(v => v.x > 40 + .5), "free end is capped");
  assert.ok(audit(b, p.add) >= -1e-6);
});
test("obstacles: other-net pad and via are skipped or nudged, never violated; reasons counted", () => {
  const t = track([[10, 20], [50, 20]], "RF", .3);
  const b = board([t, pad(25, 21.2, 1.5, 1, "SIG"), via(35, 19.3, "SIG2"), via(40, 20.6, "GND")]);
  const p = F.plan(b, defs, {kind:"path", source:{trackIds:[t.id]}, params:{net:"GND", pitch:1, ends:"terminate"}});
  assert.ok(audit(b, p.add) >= -1e-6, "audit " + audit(b, p.add));
  assert.ok(p.stats.skipped + p.stats.nudged > 0);
  assert.ok(Object.keys(p.stats.reasons).length > 0);
  assert.ok(p.preview.skipped.every(s => Number.isFinite(s.x) && s.reason));
  const off = F.plan(b, defs, {kind:"path", source:{trackIds:[t.id]}, params:{net:"GND", pitch:1, ends:"terminate", nudge:false}});
  assert.ok(off.stats.skipped >= p.stats.skipped);
});
test("rows, stagger and row spacing", () => {
  const t = track([[10, 20], [30, 20]], "RF", .3);
  const b = board([t]);
  const p = F.plan(b, defs, {kind:"path", source:{trackIds:[t.id]}, params:{net:"GND", pitch:1, rows:2, rowSpacing:.9, stagger:true, sides:"left", ends:"terminate"}});
  const ys = [...new Set(p.add.map(v => Math.round(Math.abs(v.y - 20) * 1e4) / 1e4))].sort();
  assert.deepEqual(ys, [.6, 1.5]);
  const second = p.add.filter(v => Math.abs(Math.abs(v.y - 20) - 1.5) < 1e-6).map(v => v.x).sort((a, b) => a - b);
  near(second[0], 10.5, 1e-6, "staggered by half a pitch");
  assert.ok(audit(b, p.add) >= -1e-6);
});
test("whole net and T-junction: branches fenced, junction candidates resolved legally", () => {
  const b = board([track([[10, 20], [30, 20]], "RF"), track([[30, 20], [50, 20]], "RF"), track([[30, 20], [30, 35]], "RF"), track([[5, 5], [55, 5]], "OTHER")]);
  const p = F.plan(b, defs, {kind:"path", source:{net:"RF"}, params:{net:"GND", pitch:1}});
  assert.ok(p.add.length > 100);
  assert.ok(audit(b, p.add) >= -1e-6);
  assert.ok(!p.add.some(v => v.y < 6), "only RF is fenced");
});
test("differential pair: outer sides only", () => {
  const b = board([track([[10, 20], [50, 20]], "D_P", .2), track([[10, 20.4], [50, 20.4]], "D_N", .2)]);
  b.rules.diffPairs = [{name:"D", positive:"D_P", negative:"D_N"}];
  const p = F.plan(b, defs, {kind:"path", source:{pair:"D"}, params:{net:"GND", pitch:1, ends:"terminate"}});
  assert.ok(p.add.length >= 80);
  assert.ok(p.add.every(v => v.y < 20 - .3 || v.y > 20.4 + .3), "no via between P and N");
  assert.ok(audit(b, p.add) >= -1e-6);
});
test("λ/20 pitch from the stackup Dk", () => {
  const b = board([track([[10, 20], [50, 20]], "RF", .3)]);
  const s = F.suggestPitch(b, defs, {layer:"Top", width:.3, frequency:10});
  assert.ok(s.pitch > .5 && s.pitch < 1.5, "pitch " + s.pitch);
  near(s.lambda / 20, s.pitch, 1e-5);
  const p = F.plan(b, defs, {kind:"path", source:{net:"RF"}, params:{net:"GND", pitchMode:"lambda", frequency:10}});
  near(p.stats.pitch, s.pitch, 1e-6); assert.ok(p.stats.lambda);
});

// ---------------------------------------------------------------- regeneration
test("staleness, regenerate as one plan, remove", () => {
  const t = track([[10, 20], [40, 20]], "RF");
  const b = board([t]);
  F.applyPlan(b, F.plan(b, defs, {kind:"path", source:{trackIds:[t.id]}, params:{net:"GND"}}));
  const fid = b.viaFences[0].id, before = b.items.filter(i => F.fenceOfItem(i) === fid).length;
  assert.equal(F.status(b, defs)[0].stale, false);
  t.points = [[10, 20], [40, 25]];
  assert.equal(F.status(b, defs)[0].stale, true);
  const r = F.regenerate(b, defs, null, {staleOnly:true});
  assert.equal(r.remove.length, before);
  F.applyPlan(b, r);
  assert.equal(b.viaFences.length, 1);
  assert.equal(F.status(b, defs)[0].stale, false);
  assert.ok(b.items.filter(i => F.fenceOfItem(i) === fid).some(v => v.y > 22));
  assert.ok(audit(b, b.items.filter(i => F.fenceOfItem(i) === fid)) >= -1e-6);
  F.applyPlan(b, F.removePlan(b, [fid]));
  assert.equal(b.items.filter(i => i.kind === "via").length, 0);
  assert.equal(b.viaFences, undefined);
});

// ---------------------------------------------------------------- edge
test("board edge: inset rows follow arcs and cutouts", () => {
  const BS = AtriumBoardShape;
  const b = board([]);
  const R5 = {style:"radius", size:5}, shape = BS.rect({x:0, y:40, width:60, height:40, corners:{bl:R5, br:R5, tr:R5, tl:R5}});
  BS.apply(b, BS.addCutout(shape, BS.circle(8, [30, 20]).contour));
  assert.ok(BS.fresh(b) && BS.holes(b).length === 1);
  const p = F.plan(b, defs, {kind:"edge", params:{net:"GND", pitch:2}});
  assert.ok(p.add.length > 80, "count " + p.add.length);
  const geo = F._internal.boardGeometry(b);
  const inset = .2 + .25;
  for (const v of p.add) {
    let e = Infinity; for (const ring of [geo.outline, ...geo.cutouts]) for (let i = 0; i < ring.length; i++) e = Math.min(e, segDist([v.x, v.y], ring[i], ring[(i + 1) % ring.length]));
    assert.ok(e >= inset - 1e-4, "edge distance " + e);
  }
  if (geo.cutouts.length) assert.ok(p.add.some(v => Math.hypot(v.x - 30, v.y - 20) < 6), "vias around the cutout");
  assert.ok(audit(b, p.add) >= -1e-6);
});

// ---------------------------------------------------------------- area and pours
test("area stitching is pour-aware and joins the ground copper (connectivity)", () => {
  const sig = track([[5, 20], [55, 20]], "SIG", .3);
  const top = PP.make(rect(2, 2, 58, 38), {net:"GND", layer:"Top"}), bot = PP.make(rect(2, 2, 40, 38), {net:"GND", layer:"Bottom"});
  const b = board([sig, top, bot, via(10, 10, "GND"), track([[10, 10], [10, 4]], "GND", .3, "Bottom")]);
  PP.apply(b, defs, {});
  const p = F.plan(b, defs, {kind:"area", source:{polygonId:top.id}, params:{pitch:3, pattern:"hex"}});
  assert.equal(p.stats.net, "GND");
  assert.ok(p.add.length > 40, "placed " + p.add.length);
  assert.ok(p.add.every(v => v.x < 40), "only where both layers are poured");
  assert.ok(p.add.every(v => Math.abs(v.y - 20) > .15 + .2 + .25 - 1e-6));
  assert.ok(audit(b, p.add) >= -1e-6);
  F.applyPlan(b, p, {defs, repour:true});
  assert.equal(PP.state(b, defs), "source");
  const net = AtriumConnectivity.inspect(b, defs).nets.find(n => n.name === "GND");
  assert.equal(net.islands, 1, "GND connected");
  assert.equal(AtriumConnectivity.inspect(b, defs).shorts.length, 0);
  // Stitch vias avoid other nets' pours
  const vcc = PP.make(rect(45, 25, 58, 38), {net:"VCC", layer:"Top", removeDeadCopper:false});
  const b2 = board([vcc]); PP.apply(b2, defs, {});
  const q = F.plan(b2, defs, {kind:"area", params:{net:"GND", pitch:3, pourLayers:"none"}});
  assert.ok(q.add.length > 50 && q.add.every(v => !(v.x > 45 - .25 && v.x < 58 + .25 && v.y > 25 - .25 && v.y < 38 + .25)) && q.stats.reasons.otherPour > 0);
});

// ---------------------------------------------------------------- return paths
test("return-path check and fixer", () => {
  const sv = via(30, 20, "SIG");
  const b = board([track([[10, 20], [30, 20]], "SIG", .2, "Top"), track([[30, 20], [50, 20]], "SIG", .2, "Bottom"), sv, via(40, 30, "GND"), track([[40, 30], [45, 30]], "GND")]);
  let c = F.returnPaths(b, defs, {net:"GND", distance:1});
  assert.equal(c.length, 1); assert.equal(c[0].ok, false);
  assert.equal(F.returnPathCheck(b, defs, {referenceNets:["GND"], distance:1}).length, 1);
  const p = F.plan(b, defs, {kind:"return", params:{net:"GND", distance:1, count:2}});
  assert.equal(p.add.length, 2);
  for (const v of p.add) assert.ok(Math.hypot(v.x - 30, v.y - 20) <= 1 + 1e-9);
  assert.ok(audit(b, p.add) >= -1e-6);
  F.applyPlan(b, p);
  c = F.returnPaths(b, defs, {net:"GND", distance:1});
  assert.ok(c.every(x => x.ok));
  // Same reference plane on both layers: no return via needed.
  const b2 = board([track([[10, 20], [30, 20]], "SIG", .2, "Top"), track([[30, 20], [50, 20]], "SIG", .2, "Inner 2"), via(30, 20, "SIG")]);
  b2.stackup = AtriumStackup.build(["Signal", "Plane", "Signal", "Signal"]);
  assert.equal(F.returnPaths(b2, defs, {net:"GND"}).length, 0);
});

test("DRC: Return Path Vias rule (when rules.js carries the patch)", () => {
  if (!AtriumRules.types.returnPathVia) { console.log("  (skipped: rules.js without the returnPathVia patch)"); return; }
  const b = board([track([[10, 20], [30, 20]], "SIG", .2, "Top"), track([[30, 20], [50, 20]], "SIG", .2, "Bottom"), via(30, 20, "SIG"), via(40, 30, "GND"), track([[40, 30], [45, 30]], "GND")]);
  const list = rules([{id:"rp", type:"returnPathVia", name:"ReturnPathVias", enabled:true, priority:1, scope:AtriumDesignQueryRecord.selector("all"), scope2:AtriumDesignQueryRecord.selector("net", "GND"), distance:1}]).list;
  b.rules = {format:"atrium-rules", version:2, units:"mm", list, defaults:{}, nets:{}};
  let out = AtriumRules.drc(b, defs, b.rules, {types:["returnPathVia"]});
  assert.equal(out.total, 1); assert.equal(out.violations[0].type, "returnPathVia");
  F.applyPlan(b, F.plan(b, defs, {kind:"return", params:{net:"GND", distance:1}}));
  out = AtriumRules.drc(b, defs, b.rules, {types:["returnPathVia"]});
  assert.equal(out.total, 0);
  // Not active by default: standard rule sets carry no Return Path Vias rule.
  assert.equal(AtriumRules.migrate(AtriumRules.defaults()).list.filter(r => r.type === "returnPathVia").length, 0);
});

test("Return Path Vias selects physical signal vias and reference nets independently", () => {
  const large = via(30, 20, "SIG", .8), small = via(30, 10, "SIG", .6);
  const items = [large, small, via(33, 20, "RETURN"), via(30.5, 20, "GND")];
  for (const v of [large, small]) items.push(track([[10, v.y], [30, v.y]], "SIG", .2, "Top"), track([[30, v.y], [50, v.y]], "SIG", .2, "Bottom"));
  const b = board(items);
  const r = {id:"rp", type:"returnPathVia", name:"Reference", enabled:true, priority:1, distance:1,
    scope:AtriumDesignQueryRecord.create("via where diameter >= 0.8 mm"), scope2:AtriumDesignQueryRecord.create('net where name = "RETURN"')};
  const check = scope2 => AtriumRules.drc(b, defs, rules([{...r, scope2}]), {types:["returnPathVia"]}).violations;
  const failed = check(r.scope2);
  assert.deepEqual(failed.map(v => v.id), [large.id]);
  assert.equal(failed[0].actual, 3); assert.equal(failed[0].required, 1);
  assert.deepEqual(check(AtriumDesignQueryRecord.selector("all")), [], "the nearby ground via meets the default reference");
});

// ---------------------------------------------------------------- rigid-flex
test("flex regions (AtriumStackup.regionsResolved) are avoided", () => {
  const S = AtriumStackup;
  const b = board([track([[10, 20], [50, 20]], "RF")]);
  const flex = rect(25, 0, 35, 40);
  globalThis.AtriumStackup = {...S, regionsResolved:() => ({regions:[{id:"r", flex:false, points:rect(0, 0, 25, 40)}, {id:"f", flex:true, points:flex}], bends:[{zone:rect(44, 0, 46, 40)}]})};
  try {
    const p = F.plan(b, defs, {kind:"path", source:{net:"RF"}, params:{net:"GND", nudge:false}});
    assert.ok(p.add.length > 20 && p.add.every(v => (v.x < 25 - .2 || v.x > 35 + .2) && (v.x < 44 - 1.2 || v.x > 46 + 1.2)));
    assert.ok(p.stats.reasons.flex > 0);
  } finally { globalThis.AtriumStackup = S; }
});

// ---------------------------------------------------------------- performance
test("dense board: fencing a 200 mm net at 1 mm pitch, both sides, < 50 ms", () => {
  const {d, defs: dd} = makeAtriumBenchmarkBoard();
  let k = 0; for (const i of d.items) if (i.kind === "via" || i.kind === "track") i.net = "N" + (k++ % 400);
  // A 200 mm meandering net through the dense area.
  const pts = [[5, 30.1]]; for (let i = 1; i <= 8; i++) pts.push([5 + i * 20, i % 2 ? 30.1 : 60.3]);
  const rf = track(pts, "RF", .25); d.items.push(rf); d.rules = rules();
  const t0 = timer(); AtriumRouter.world(d, dd, {revision:"bench"}); const build = timer() - t0;
  const runs = [];
  let p;
  for (let i = 0; i < 5; i++) { const t = timer(); p = F.plan(d, dd, {kind:"path", source:{net:"RF"}, params:{net:"GND", pitch:1}}, {revision:"bench"}); runs.push(timer() - t); }
  runs.sort((a, b) => a - b);
  const len = pts.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0);
  console.log("  dense " + d.items.length + " items, net " + len.toFixed(0) + " mm: world build " + build.toFixed(1) + " ms (cached afterwards), fence median " + runs[2].toFixed(1) + " ms, best " + runs[0].toFixed(1) + " ms; " + p.stats.candidates + " candidates, " + p.stats.placed + " placed, " + p.stats.skipped + " skipped, " + p.stats.nudged + " nudged");
  assert.ok(len >= 200);
  assert.ok(runs[2] < 50, "fence " + runs[2]);
});

let failed = 0;
for (const c of cases) {
  try { c.run(); console.log("PASS " + c.name); }
  catch (e) { failed++; console.log("FAIL " + c.name + "\n  " + (e && e.message) + "\n" + (e && e.stack || "")); }
}
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " via-fence test(s) failed"); }
