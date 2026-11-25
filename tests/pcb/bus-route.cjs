"use strict";
// Interactive Bus Routing (app/pcb/bus-route.js) on a DDR4-style board (tests/pcb/ddr-board.js): bus discovery and ordering,
// parallel spacing, diff pairs kept coupled, walkaround and group push, via arrays, arcs, neck-down, live length
// readout, finishing into the destination pads with pin swaps, tune-to-tolerance, and DRC 0. Geometry is checked
// independently of the router (segment distances computed here).
const assert = require("node:assert/strict");
const {pointSeg, segSeg} = require("../support/segment-distance.cjs");
for (const m of ["model", "altium-rules", "pcb-draw", "component-classes", "net-intent", "signals", "rules", "connectivity", "stackup", "query", "length-tuning", "topology", "router", "pin-swap", "multi-route", "bus-route"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("./ddr-board.js");
const B = AtriumBusRoute, R = AtriumRouter;
const cases = [];
const test = (name, run) => cases.push({name, run});

const gap = (t, u) => { let m = Infinity; for (let i = 1; i < t.points.length; i++) for (let j = 1; j < u.points.length; j++) m = Math.min(m, segSeg(t.points[i - 1], t.points[i], u.points[j - 1], u.points[j])); return m - t.width / 2 - u.width / 2; };
const padGap = (t, x, y, r) => { let m = Infinity; for (let i = 1; i < t.points.length; i++) m = Math.min(m, pointSeg([x, y], t.points[i - 1], t.points[i])); return m - t.width / 2 - r; };
const plen = p => { let s = 0; for (let i = 1; i < p.length; i++) s += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return s; };
const clone = b => JSON.parse(JSON.stringify(b));
function applyAll(board, plan) {
  for (const sw of plan.swaps || []) { const p = board.items.find(i => i.id === sw.partId); for (const [a, b] of sw.pairs) { const x = p.pinNets[a]; p.pinNets[a] = p.pinNets[b]; p.pinNets[b] = x; } }
  R.apply(board, plan); AtriumLength.invalidate?.(board); R.invalidate(board);
  return board;
}
function drc(board, defs, nets) {
  const out = AtriumRules.drc(board, defs, board.rules, {});
  return out.violations.filter(v => v.type !== "unrouted" || nets.includes(v.net));
}
// Every pair of bus tracks on the same layer and different nets keeps the clearance (0.1).
function assertClear(tracks, min = 0.1) {
  for (let i = 0; i < tracks.length; i++) for (let j = i + 1; j < tracks.length; j++) {
    const a = tracks[i], b = tracks[j];
    if (a.layer !== b.layer || a.net === b.net) continue;
    const g = gap(a, b);
    assert.ok(g >= min - 1e-6, a.net + " / " + b.net + " gap " + g.toFixed(5));
  }
}
const headOf = (r, net) => r.preview.filter(p => p.net === net && p.head).at(-1);

test("bus discovery: query, net class, groups, pairs and copper ends", () => {
  const {board, defs, BYTE, ADDR} = makeAtriumDDRBoard();
  assert.deepEqual(B.busNets(board, defs, {query: "InNetClass('DDR_BYTE0')"}), BYTE);
  for (const query of ["InNet('DQ0') Or InNet('DQS0_P')", 'object where net.name = "DQ0" or net.name = "DQS0_P"']) {
    assert.deepEqual(B.busNets(board, defs, {query}).sort(), ["DQ0", "DQS0_P"], query);
  }
  assert.deepEqual(B.busNets(board, defs, {netClass: "DDR_ADDR"}), ADDR);
  const names = B.groups(board, defs).map(g => g.name);
  assert.ok(names.includes("DDR_BYTE0") && names.includes("DDR_ADDR"), names.join(","));
  const pairs = B.pairsOf(board, BYTE);
  assert.equal(pairs.get("DQS0_P")?.negative, "DQS0_N");
  const near = B.membersNear(board, defs, BYTE, [18, 25]);
  assert.equal(near.length, 11);
  for (const m of near) assert.ok(Math.abs(m.at[0] - 17.8) < 1e-9, m.net + " starts on U1's east column");
  assert.throws(() => B.busNets(board, defs, {netClass: "NOPE"}), /No net class/);
});

test("bus discovery preserves a dangling end outside its actual layer land", () => {
  const {F4,F5,mirroredLandPoint,mirroredTopRow,landContacts}=require("../support/a1-geometry.cjs");
  const part={...F4.part,mirror:true,id:"U1",kind:"part",def:"g17",pinNets:{"1":"DATA"}};
  const def={id:part.def,footprint:{pads:[]}}, defs=new Map([[def.id,def]]);
  function probe(pad,local,row,inside,label){
    def.footprint.pads=[{...F4.pad,number:"1",drill:0,layer:"Top",...pad}];
    const at=mirroredLandPoint(local,row), far=mirroredLandPoint([local[0]+8,local[1]+.4],row);
    const trace={kind:"track",net:"DATA",id:"trace",layer:"Top",points:[at,far],width:.01};
    const board={kind:"pcb",items:[part,trace]};
    const ends=B.endpoints(board,defs,"DATA");
    assert.equal(ends.some(e=>e.kind==="track"&&e.at[0]===at[0]&&e.at[1]===at[1]),!inside,label+" copper end");
    assert.equal(B.membersNear(board,defs,["DATA"],at)[0].kind,inside?"pad":"track",label+" nearest routable end");
  }
  for(const {shape,poly,point,inside} of landContacts)
    probe({shape,poly,w:F5.w,h:F5.h,roundrectRadiusRatio:F5.radiusRatio},point,{},inside,shape);
  const pad={stackMode:"full",padStack:{Top:mirroredTopRow}};
  probe(pad,[.53,.64],mirroredTopRow,true,"shifted width-only row");
  probe(pad,[.75,.22],{},false,"nominal pad omitted");
});
test("all conflict modes place a clear ribbon and discard an undone anchor", () => {
  for (const mode of R.modes) {
    const board={kind:"pcb",items:[]}, defs=new Map(), members=[{net:"D0",at:[0,0]},{net:"D1",at:[0,.6]}];
    const s=B.begin(board,defs,{members,mode});
    const first=s.move([12,.3]);
    assert.equal(first.status,"ok",mode); assert.equal(first.preview.filter(p=>p.head).length,2);
    const lines=first.preview;
    assert.equal(s.move([12,.3]).preview,lines,"same snapped point reuses both lanes");
    assert.ok(s.click().anchored); assert.ok(s.back()); assert.deepEqual(s.commit().add,[]);
    const plan=B.begin(board,defs,{members,mode});
    plan.move([12,.3]);plan.click();
    const placed=plan.commit();
    assert.equal(placed.add.length,2);assertClear(placed.add,.2);
    assert.equal(board.items.length,0,"planning leaves the board alone");
  }
});

test("ribbon: parallel at the rule pitch, ordered by pin geometry, diff pair coupled, one cursor drives all", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard({obstacles: false});
  const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top"});
  const r = s.move([30, 24.6]);
  assert.equal(r.status, "ok");
  assert.deepEqual(r.bus.order, BYTE, "the order follows the pins across the direction of travel");
  assert.equal(r.bus.crossing, false);
  const heads = BYTE.map(n => ({...headOf(r, n), net: n}));
  // Neighbours run parallel: the head segments of adjacent members are at exactly width + gap (pair: width + pair gap).
  for (let i = 1; i < heads.length; i++) {
    const a = heads[i - 1], b = heads[i], want = a.net === "DQS0_P" && b.net === "DQS0_N" ? 0.12 : 0.1;
    const g = gap(a, b);
    assert.ok(Math.abs(g - want) < 2e-4, a.net + "-" + b.net + " gap " + g + " want " + want);
  }
  // Every member ends at the same distance along the ribbon (the cursor drives the whole group).
  const ends = heads.map(h => h.points.at(-1)[0]);
  assert.ok(Math.max(...ends) - Math.min(...ends) < 1e-6, "ends line up: " + ends);
  assert.equal(r.end[0], 30);
  // No two members of the bus touch anywhere, including the gather from the BGA column.
  assertClear(r.preview.map(p => ({...p, width: p.width})));
  // Reorder: reversing before the first anchor mirrors the lanes; it is refused afterwards.
  assert.equal(s.reverse(), true);
  assert.deepEqual(s.move([30, 24.6]).bus.order, BYTE.slice().reverse());
  assert.equal(s.setOrder(BYTE), true);
  s.move([30, 24.6]); s.click();
  assert.equal(s.reverse(), false);
});

test("walkaround: the ribbon goes round the mounting pad as a group, every member clears it", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard();
  const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top", mode: "walkaround"});
  s.move([22, 24.6]); s.click();
  const r = s.move([39, 24.6]);
  assert.equal(r.status, "ok");
  const tracks = r.preview.filter(p => p.head);
  for (const t of tracks) assert.ok(padGap(t, 33, 24.6, 1.2) >= 0.1 - 1e-6, t.net + " clears H1: " + padGap(t, 33, 24.6, 1.2));
  // All members pass H1 on the same side.
  const side = t => { for (let i = 1; i < t.points.length; i++) { const a = t.points[i - 1], b = t.points[i]; if ((a[0] - 33) * (b[0] - 33) <= 0 && a[0] !== b[0]) return Math.sign(a[1] + (b[1] - a[1]) * (33 - a[0]) / (b[0] - a[0]) - 24.6); } return 0; };
  const sides = new Set(tracks.map(side));
  assert.equal(sides.size, 1, "one side: " + [...sides]);
  assertClear(r.preview);
});

test("push: the ribbon shoves another net's track as a group; Backspace and cancel restore it", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard();
  const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top", mode: "push"});
  s.move([21.5, 24.6]); s.click();
  const r = s.move([29, 24.6]);
  assert.equal(r.status, "pushed", r.status);
  const g7 = r.pushed.find(p => p.id === "GPIO7");
  assert.ok(g7, "GPIO7 is shoved");
  assert.ok(r.hidden.includes("GPIO7"));
  const pushed = {...g7, width: 0.1};
  for (const t of r.preview) assert.ok(gap(t, pushed) >= 0.1 - 1e-6, t.net + " to shoved GPIO7: " + gap(t, pushed));
  // GPIO7 keeps its ends.
  const orig = board.items.find(i => i.id === "GPIO7");
  assert.deepEqual(g7.points[0], orig.points[0]); assert.deepEqual(g7.points.at(-1), orig.points.at(-1));
  s.click();
  const plan = s.commit();
  const mod = plan.modify.find(m => m.id === "GPIO7");
  assert.ok(mod, "the shove is part of the commit (one undo step)");
  const after = applyAll(clone(board), plan);
  const gp = after.items.find(i => i.id === "GPIO7");
  for (const t of after.items.filter(i => i.kind === "track" && BYTE.includes(i.net))) assert.ok(gap(t, gp) >= 0.1 - 1e-6);
  // Backspace removes the anchored segment and the shove with it.
  const s2 = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top", mode: "push"});
  s2.move([21.5, 24.6]); s2.click(); s2.move([29, 24.6]); s2.click();
  assert.equal(s2.back(), true);
  assert.equal(s2.commit().modify.length, 0);
});

test("via arrays: staggered and in-line, via-to-via clearance, continue on the new layer", () => {
  for (const pattern of ["staggered", "inline"]) {
    const {board, defs, BYTE} = makeAtriumDDRBoard({obstacles: pattern === "staggered"});
    const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top", viaPattern: pattern});
    s.move([22, 24.6]); s.click();
    const v = s.switchLayer("Bottom");
    assert.equal(v.ok, true, v.message);
    assert.equal(v.vias, 11); assert.equal(v.pattern, pattern);
    const r = s.move([34, 24.6]);
    assert.equal(r.layer, "Bottom"); assert.equal(r.status, "ok");
    s.click();
    const plan = s.commit(), vias = plan.add.filter(i => i.kind === "via");
    assert.equal(vias.length, 11);
    assert.deepEqual(new Set(vias.map(x => x.net)), new Set(BYTE));
    for (let i = 0; i < vias.length; i++) for (let j = i + 1; j < vias.length; j++) {
      const d = Math.hypot(vias[i].x - vias[j].x, vias[i].y - vias[j].y);
      assert.ok(d >= 0.45 + 0.1 - 1e-6, pattern + " via-to-via " + d);
    }
    if (pattern === "staggered") assert.equal(new Set(vias.map(x => x.x.toFixed(3))).size, 2, "two rows");
    else assert.equal(new Set(vias.map(x => x.x.toFixed(3))).size, 1, "one row");
    const tracks = plan.add.filter(i => i.kind === "track");
    assert.ok(tracks.some(t => t.layer === "Bottom") && tracks.some(t => t.layer === "Top"));
    assertClear(tracks);
    const after = applyAll(clone(board), plan);
    const bad = drc(after, defs, []).filter(x => !["matchedLengths", "unrouted"].includes(x.type));
    assert.deepEqual(bad.map(x => x.type + " " + x.message), [], pattern + " DRC");
  }
});

test("corners: 45° mitres and concentric arcs keep the pitch; inner members are shorter than outer ones", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard({obstacles: false});
  for (const corner of ["45", "45arc", "90arc"]) {
    const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top", corner});
    s.move([24, 24.6]); s.click();
    const r = s.move([34, 14]);
    assert.equal(r.status, "ok", corner);
    const heads = BYTE.map(n => ({...headOf(r, n), net: n}));
    for (let i = 1; i < heads.length; i++) {
      const want = heads[i - 1].net === "DQS0_P" ? 0.12 : 0.1, g = gap(heads[i - 1], heads[i]);
      assert.ok(g >= want - 1e-4 && g <= want + 2e-3, corner + " " + heads[i - 1].net + " gap " + g);
    }
    // Turning left (toward -y): the member with the smallest offset (DQ0, north) is on the inside.
    const ls = heads.map(h => plen(h.points));
    assert.ok(ls[0] < ls[ls.length - 1], corner + " inner shorter: " + ls[0] + " < " + ls.at(-1));
    if (corner !== "45") assert.ok(heads.every(h => h.points.length > 6), "arcs are polylines");
  }
});

test("neck down and spread out: minimum width and gap from the rules, then back", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard({obstacles: false});
  const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top"});
  s.move([24, 24.6]); s.click();
  assert.equal(s.toggleNeck(), true);
  let r = s.move([30, 24.6]);
  assert.equal(r.bus.neck, true);
  const heads = BYTE.map(n => ({...headOf(r, n), net: n}));
  assert.ok(heads.every(h => Math.abs(h.width - 0.09) < 1e-9), "necked width");
  assert.ok(Math.abs(gap(heads[0], heads[1]) - 0.1) < 2e-4);
  assert.ok(r.bus.pitch < 0.2);
  s.click();
  assert.equal(s.toggleNeck(), false);
  r = s.move([36, 24.6]);
  assert.equal(r.bus.neck, false);
  s.click();
  assertClear(s.commit().add.filter(i => i.kind === "track"));
});

test("live readout: per-member length and delay with a tolerance band against the group", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard();
  const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top"});
  const r = s.move([30, 24.6]);
  assert.equal(r.bus.group, "MatchedLengths_Byte0");
  assert.equal(r.bus.tolerance, 0.254);
  assert.equal(r.bus.members.length, 11);
  for (const m of r.bus.members) {
    assert.ok(m.length > 10 && m.delay > m.length * 5, m.net + " length " + m.length + " delay " + m.delay);
    assert.ok(["ok", "close", "out"].includes(m.band));
  }
  // The longest member is the reference, so it reads 0 and green.
  assert.ok(r.bus.members.some(m => m.delta === 0 && m.band === "ok"));
  // Deltas are consistent with the lengths.
  const longest = Math.max(...r.bus.members.map(m => m.projected));
  for (const m of r.bus.members) assert.ok(Math.abs(m.delta - (m.projected - longest)) < 1e-5);
});

test("finish: fan into the destination pads, swapping DQ bits to remove crossings; refused without swaps", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard();
  const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top"});
  s.move([26, 24.6]); s.click(); s.move([40, 24.6]); s.click();
  const no = s.complete([43, 25], {swap: false});
  assert.equal(no.ok, false); assert.equal(no.crossing, true);
  const c = s.complete([43, 25]);
  assert.equal(c.ok, true, c.message);
  assert.equal(c.swaps.length, 4);
  const plan = s.commit();
  assert.equal(plan.done, true);
  const after = applyAll(clone(board), plan);
  // After the swaps every bus net connects U1 to U2 (no unrouted bus net) and nothing violates clearance.
  const bad = drc(after, defs, BYTE).filter(x => x.type !== "matchedLengths");
  assert.deepEqual(bad.map(x => x.type + " " + (x.net || "") + " " + (x.message || "")), []);
  assertClear(after.items.filter(i => i.kind === "track" && BYTE.includes(i.net)));
});

test("tune group: the ribbon spreads in a tuning zone and every member ends within tolerance, DRC 0", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard();
  const r = B.route(board, defs, {nets: BYTE, from: [18, 25], layer: "Top", waypoints: [[26, 24.6], [40, 24.6]], finish: {to: [43, 25]}});
  assert.equal(r.done, true);
  const after = applyAll(clone(board), {...r.plan, swaps: r.swaps});
  const before = drc(after, defs, BYTE);
  assert.ok(before.some(x => x.type === "matchedLengths"), "untuned: lengths differ");
  const t = B.tuneGroup(after, defs, BYTE);
  assert.equal(t.ok, true, JSON.stringify(t.after));
  assert.ok(t.zone && t.zone.bumps.some(n => n > 0), "tuned in a zone");
  for (const m of t.after) assert.ok(Math.abs(m.length - t.target) <= 0.254 + 1e-6, m.net + " " + m.length + " vs " + t.target);
  applyAll(after, t.plan);
  assert.deepEqual(drc(after, defs, BYTE).map(x => x.type + " " + (x.net || "") + " " + (x.actual ?? "")), []);
});

test("full byte lane: push, two via arrays, finish with swaps, tune; then the ADDR group as one fly-by ribbon U1 -> U2 -> U3; DRC 0", () => {
  const {board, defs, BYTE, ADDR} = makeAtriumDDRBoard();
  const r = B.route(board, defs, {nets: BYTE, from: [18, 25], layer: "Top", mode: "push", waypoints: [[22.5, 24.6], [34.5, 24.6]],
    layers: [{after: 0, layer: "Bottom", pattern: "staggered"}, {after: 1, layer: "Top", pattern: "staggered"}], finish: {to: [43, 25]}, tune: true});
  assert.equal(r.ok, true, JSON.stringify(r.tune));
  assert.equal(r.vias, 22);
  assert.equal(r.swaps.length, 4);
  const b = applyAll(clone(board), {...r.plan, swaps: r.swaps});
  // The address group as one continuous fly-by ribbon in the topology's load order (U1 -> U2 -> U3), on Bottom after a
  // via array: it passes through U2's via-in-pad balls and carries on to U3, the last load.
  const fb = B.route(b, defs, {nets: ADDR, from: [15, 19], layer: "Top", waypoints: [[15, 16], [15, 12], [40, 12], [45, 31], [58, 31]],
    layers: [{after: 0, layer: "Bottom"}], visits: [{after: 2, to: [45, 20]}], finish: {to: [60, 20]}});
  assert.equal(fb.done, true);
  assert.deepEqual(fb.steps.filter(x => x.visited).map(x => [x.visited, x.next]), [["U2", "U3"]]);
  applyAll(b, fb.plan);
  for (const n of ADDR) {
    const t = AtriumTopology.analyze(b, defs, n);
    assert.equal(t.shape, "chain", n);
    assert.deepEqual(t.loads.map(l => l.ref), ["U2", "U3"], n + " load order");
    for (const l of t.loads) assert.ok(l.stub <= 0.5, n + " stub at " + l.ref + ": " + l.stub);
  }
  assert.deepEqual(drc(b, defs, BYTE.concat(ADDR)).map(x => x.type + " " + (x.net || "") + " " + (x.message || "")), []);
});

test("fly-by: one ribbon visits U2 then U3 in the topology's order, tuned hop by hop so each load sees matched arrivals", () => {
  const {board, defs, ADDR} = makeAtriumDDRBoard();
  const r = B.route(board, defs, {nets: ADDR, from: [15, 19], layer: "Top", waypoints: [[15, 16], [15, 12], [40, 12], [45, 31], [58, 31]],
    layers: [{after: 0, layer: "Bottom"}], visits: [{after: 2, to: [70, 0]}], finish: {to: [70, 0]}, tune: true});
  // The click points are far from both DRAMs: the load order (specFor) picks U2, then U3.
  assert.deepEqual(r.loads, ["U2", "U3"]);
  assert.equal(r.hops.length, 2);
  assert.equal(r.tune.ok, true, r.tune.report);
  for (const h of r.tune.hops) assert.ok(h.spread <= 0.254, "hop " + h.hop + " spread " + h.spread);
  const b = applyAll(clone(board), r.plan);
  assert.deepEqual(drc(b, defs, ADDR).map(x => x.type + " " + (x.net || "")), []);
});

test("re-route bus: after U2 moves, the bus is routed again from its pads' new positions with the same clicks", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard();
  const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top"});
  s.move([26, 24.6]); s.click(); s.move([40, 24.6]); s.click();
  assert.equal(s.complete([43, 25]).done, true);
  const rec = s.record(), plan = s.commit();
  assert.deepEqual(rec.clicks.map(c => c.kind), ["click", "click", "visit"]);
  const b = applyAll(clone(board), plan);
  rec.ids = plan.add.map(i => i.id);
  b.items.find(i => i.id === "U2").x += 0.6; R.invalidate(b);
  const out = B.reroutePlan(b, defs, rec);
  assert.equal(out.r.done, true);
  assert.equal(out.remove.length, plan.add.length);
  R.apply(b, {add: out.r.plan.add, remove: out.remove, modify: out.r.plan.modify}); R.invalidate(b); AtriumLength.invalidate?.(b);
  assert.deepEqual(drc(b, defs, BYTE).filter(x => x.type !== "matchedLengths").map(x => x.type + " " + (x.net || "")), []);
});

test("Backspace removes the last ribbon segment, cancel clears everything; the board is never touched", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard();
  const items = JSON.stringify(board.items);
  const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top"});
  s.move([24, 24.6]); s.click(); s.move([28, 22]); s.click();
  assert.equal(s.state.anchors, 2);
  assert.equal(s.back(), true);
  assert.equal(s.state.anchors, 1);
  const one = s.commit().add.filter(i => i.kind === "track");
  assert.ok(one.every(t => t.points.every(p => p[0] <= 24 + 1e-6)), "only the first segment is left");
  s.cancel();
  assert.equal(s.commit().add.length, 0);
  assert.equal(JSON.stringify(board.items), items);
});

test("move cost: p95 of a ribbon move with push active stays inside a frame budget", () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard();
  const s = B.begin(board, defs, {nets: BYTE, near: [18, 25], layer: "Top", mode: "push"});
  s.move([21.5, 24.6]); s.click();
  const ms = [];
  for (let i = 0; i < 120; i++) {
    const x = 22 + 12 * (i / 119), y = 24.6 + Math.sin(i / 7) * 1.5;
    const t0 = Date.now(); s.move([x, y]); ms.push(Date.now() - t0);
  }
  ms.sort((a, b) => a - b);
  const p95 = ms[Math.floor(ms.length * 0.95)];
  assert.ok(p95 <= 16, "p95 " + p95 + " ms");
});

let failed = 0;
for (const c of cases) {
  try { c.run(); console.log("ok - " + c.name); }
  catch (e) { failed++; console.log("not ok - " + c.name + "\n  " + (e && e.message) + "\n  " + (e && e.stack || e)); }
}
if (failed) throw Error(failed + " bus routing test(s) failed");

// The editor wrapper: pin swaps back-annotate the schematic through derive(), inside the route's undo step (it used to
// be a second host.edit, so the first undo left the board swapped and the schematic not).
globalThis.__testDone = (async () => {
  const {board, defs, BYTE} = makeAtriumDDRBoard();
  const sheet = {id: "sch", kind: "schematic", name: "Sheet", items: []}, project = {documents: [board, sheet], library: [...defs.values()]};
  // In a project the board's rules are the project rule book's (its classes and pairs the signal model's).
  { const set = board.rules; delete board.rules; AtriumRules.store(board, project, set); }
  const calls = [];
  let session = null;
  // Select the bus by its copper: a zero-length stub on each source pad (as fanout would leave).
  const near = B.membersNear(board, defs, BYTE, [18, 25]).map((m, k) => ({id: "stub" + k, kind: "track", net: m.net, layer: m.layer || "Top", width: 0.1, points: [m.at.slice(), m.at.slice()]}));
  board.items.push(...near);
  const host = {doc: () => board, defs: () => defs, project: () => project, selection: () => near.map(i => i.id), info() {}, redraw() {}, registerAction() {}, on() {},
    activeLayer: () => "Top", startRoute: s => { session = s; }, edit: fn => { calls.push("edit"); fn(); }, derive: fn => { calls.push("derive"); fn(); }};
  {
    B.attach(host);
    await B.interactive();
    assert.ok(session, "a bus session started from the selected fanout");
    session.cancel(); session = null; B.restart([18, 25]);  // the same bus again, from its pads
    assert.ok(session);
    session.move([26, 24.6]); session.click(); session.move([40, 24.6]); session.click();
    const done = session.complete([43, 25]); assert.equal(done.ok, true, done.message);
    const plan = session.commit();
    assert.ok(plan.swaps.length);
    for (const m of plan.modify) { const p = board.items.find(i => i.id === m.id); if (m.pinNets) p.pinNets = m.pinNets; }  // the editor's edit
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(calls, ["derive"], "no second undo step");
  }
  console.log("ok - pin swaps back-annotate in the route's undo step");
})();
