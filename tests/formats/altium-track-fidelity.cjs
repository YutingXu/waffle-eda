"use strict";
// Translator fidelity for Altium Tracks6/Arcs6: every source record becomes exactly one Waffle
// object with the record's endpoints, width, layer and net, and the per-layer counts agree. Pour
// outlines and regions in the same board never turn into tracks. The board is synthetic: free
// tracks on signal, mid, plane-adjacent, plane, mechanical, keep-out and overlay layers, arcs on
// several of them, component- and polygon-owned primitives, one solid pour and two regions.
//
// The second half checks what the board looks like: a pour's outline is a boundary, not copper,
// so the canvas draws it as a screen hairline. At track width it read as stray tracks across pads
// and nets on imported boards whose pours are narrow power strips.
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "board-shape", "altium-ids", "pcb-pours", "pcb-import", "io", "stackup", "polygon-pour",
  "pcb-appearance", "spatial", "connectivity", "canvas"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const A = Atrium, U = .00000254, none = 65535, tick = x => Math.round(x / U), mm = n => n * U;

function props(text) {
  const v = Buffer.from("|" + text + "\0", "latin1"), n = Buffer.alloc(4);
  n.writeUInt32LE(v.length); return Buffer.concat([n, v]);
}
function frame(type, data) { const h = Buffer.alloc(5); h[0] = type; h.writeUInt32LE(data.length, 1); return Buffer.concat([h, data]); }
// Tracks6: layer, flags, net, polygon, component, x1, y1, x2, y2, width (internal units of 1e-4 mil).
function track(t) {
  const g = Buffer.alloc(49); g[0] = t.layer; g[2] = t.flags || 0;
  g.writeUInt16LE(t.net ?? none, 3); g.writeUInt16LE(t.polygon ?? none, 5); g.writeUInt16LE(t.owner ?? none, 7); g.writeInt32LE(-1, 9);
  [t.a[0], t.a[1], t.b[0], t.b[1], t.w].forEach((v, k) => g.writeInt32LE(v, 13 + 4 * k));
  return frame(4, g);
}
// Arcs6: layer, flags, net, polygon, component, centre, radius, start and end angle (degrees, CCW, Y up), width.
function arc(t) {
  const g = Buffer.alloc(60); g[0] = t.layer;
  g.writeUInt16LE(t.net ?? none, 3); g.writeUInt16LE(t.polygon ?? none, 5); g.writeUInt16LE(t.owner ?? none, 7);
  g.writeInt32LE(t.c[0], 13); g.writeInt32LE(t.c[1], 17); g.writeInt32LE(t.r, 21);
  g.writeDoubleLE(t.sa, 25); g.writeDoubleLE(t.ea, 33); g.writeInt32LE(t.w, 41);
  return frame(1, g);
}
// Regions6 (as tests/formats/altium-regions.cjs): an 18-byte header, properties, then the vertices in internal units.
function region(points, {layer = 1, kind = 0, net = none} = {}) {
  const h = Buffer.alloc(18); h[0] = layer; h.writeUInt16LE(net, 3); h.writeUInt16LE(none, 5); h.writeUInt16LE(none, 7);
  const v = Buffer.alloc(4 + 16 * points.length); v.writeUInt32LE(points.length);
  points.forEach(([x, y], i) => { v.writeDoubleLE(tick(x), 4 + 16 * i); v.writeDoubleLE(tick(y), 12 + 16 * i); });
  return frame(11, Buffer.concat([h, props("V7_LAYER=" + layer + "|KIND=" + kind + "|ISSHAPEBASED=FALSE|SUBPOLYINDEX=-1"), v]));
}

// Odd, non-round coordinates and widths so a unit, offset or sign slip cannot cancel out.
const NAMES = {1: "Top", 2: "Inner 1", 3: "Inner 2", 15: "Inner 14", 30: "Inner 29", 32: "Bottom", 33: "Silk", 34: "Bottom silk",
  39: "Layer 39", 54: "Layer 54", 56: "Keepout", 57: "Mechanical 1", 64: "Mechanical 8", 72: "Mechanical 16"};
const COPPER = new Set([1, 2, 3, 15, 30, 32]);
const nets = ["GND", "SIG", "VCC"];
const tracks = [], arcs = [];
Object.keys(NAMES).map(Number).forEach((layer, k) => {
  // Two tracks per layer, one joined to the next at a shared end (a joined route must stay two records).
  const x = 2000000 + 731117 * k, y = 1500000 + 97013 * k, w = 25400 + 3917 * k;
  tracks.push({layer, a: [x, y], b: [x + 1234567, y + 765431], w, net: k % 3});
  tracks.push({layer, a: [x + 1234567, y + 765431], b: [x + 1234567, y + 2765431], w: w + 1111, net: (k + 1) % 3});
});
for (const [layer, k] of [[1, 0], [3, 1], [32, 2], [57, 3], [33, 4]])
  arcs.push({layer, c: [5000000 + 777777 * k, 9000000 - 333333 * k], r: 400000 + 90001 * k, sa: 12.5 + 40 * k, ea: 200.25 + 17 * k, w: 30000 + 1001 * k, net: k % 3});
// The component sits at (6 mm, 6 mm) turned 90 degrees; its primitives keep absolute coordinates.
const owned = {layer: 33, a: [tick(5), tick(5)], b: [tick(7), tick(5.5)], w: tick(.2), owner: 0};
const ownedArc = {layer: 1, c: [tick(6), tick(6.5)], r: tick(.75), sa: 0, ea: 90, w: tick(.15), owner: 0, net: 1};
const pourTrack = {layer: 1, a: [tick(31), tick(21)], b: [tick(39), tick(21)], w: tick(.254), polygon: 0, net: 0};
const streams = new Map([
  ["board6/data", props("VX0=0mm|VY0=0mm|VX1=60mm|VY1=0mm|VX2=60mm|VY2=40mm|VX3=0mm|VY3=40mm")],
  ["nets6/data", Buffer.concat(nets.map(n => props("NAME=" + n)))],
  ["components6/data", props("SOURCEDESIGNATOR=U1|PATTERN=Test|X=6mm|Y=6mm|LAYER=TOP|ROTATION=90")],
  ["polygons6/data", props("NET=0|LAYER=TOP|POLYGONTYPE=Polygon|HATCHSTYLE=Solid|TRACKWIDTH=8mil|GRIDSIZE=20mil|POURINDEX=1|" +
    "VX0=30mm|VY0=20mm|VX1=40mm|VY1=20mm|VX2=40mm|VY2=22mm|VX3=30mm|VY3=22mm")],
  ["regions6/data", Buffer.concat([region([[42, 4], [46, 4], [46, 8], [42, 8]], {net: 2}), region([[32, 20.5], [33, 20.5], [33, 21.5]], {kind: 1})])],
  ["tracks6/data", Buffer.concat([...tracks, owned, pourTrack].map(track))],
  ["arcs6/data", Buffer.concat([...arcs, ownedArc].map(arc))],
]);
const input = AtriumPCB.read("Fidelity.PcbDoc", streams, null), doc = input.documents[0], defs = new Map(input.library.map(d => [d.id, d]));
const near = (a, b, what, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, what + ": " + a + " differs from " + b);
const point = (p, q, what) => { near(p[0], q[0], what + " x"); near(p[1], q[1], what + " y"); };
const at = q => [mm(q[0]), -mm(q[1])];
const bySource = new Map(doc.items.filter(i => i.sourceRecord).map(i => [i.sourceRecord, i]));

// ------------------------------------------------------------------ tracks: one object per record, exactly
tracks.forEach((t, k) => {
  const i = bySource.get("tracks6/data#" + k), what = "tracks6#" + k + " on " + NAMES[t.layer];
  assert.ok(i, what + " was imported");
  assert.equal(i.layer, NAMES[t.layer], what + " layer");
  assert.equal(i.kind, COPPER.has(t.layer) ? "track" : "graphic", what + " kind");
  assert.equal(i.points.length, 2, what + " stays one segment");
  point(i.points[0], at(t.a), what + " start"); point(i.points[1], at(t.b), what + " end");
  near(i.width, mm(t.w), what + " width");
  assert.equal(i.net, nets[t.net], what + " net");
  assert.ok(!i.arc && !i.fill && !i.closed, what + " is a plain open stroke");
});
// ------------------------------------------------------------------ arcs: centre, radius, both ends, width
arcs.forEach((t, k) => {
  const i = bySource.get("arcs6/data#" + k), what = "arcs6#" + k + " on " + NAMES[t.layer];
  assert.ok(i, what + " was imported");
  assert.equal(i.layer, NAMES[t.layer], what + " layer");
  assert.equal(i.net, nets[t.net], what + " net");
  near(i.width, mm(t.w), what + " width");
  const g = A.pathArc(i), r = mm(t.r), end = a => [mm(t.c[0]) + r * Math.cos(a * Math.PI / 180), -mm(t.c[1]) - r * Math.sin(a * Math.PI / 180)];
  point(g.c, at(t.c), what + " centre"); near(g.r, r, what + " radius");
  const ends = [i.points[0], i.points.at(-1)], want = [end(t.sa), end(t.ea)];
  const forward = Math.hypot(ends[0][0] - want[0][0], ends[0][1] - want[0][1]) < 1e-6;
  point(ends[0], want[forward ? 0 : 1], what + " first end"); point(ends[1], want[forward ? 1 : 0], what + " last end");
  near(Math.abs(A.arcSweep(g)), (((t.ea - t.sa) % 360) + 360) % 360, what + " sweep", 1e-9);
});
// ------------------------------------------------------------------ per-layer counts, and nothing extra
const tally = list => list.reduce((m, x) => (m[x] = (m[x] || 0) + 1, m), {});
const free = doc.items.filter(i => /^(tracks|arcs)6\/data#/.test(i.sourceRecord || ""));
assert.deepEqual(tally(free.map(i => i.layer)), tally([...tracks, ...arcs, pourTrack].map(t => NAMES[t.layer])), "per-layer counts match the source");
assert.equal(doc.items.filter(i => i.kind === "track").length,
  [...tracks, ...arcs, pourTrack].filter(t => COPPER.has(t.layer)).length, "only copper Tracks6/Arcs6 records become tracks");
// Pour and region outlines are not tracks.
const pour = doc.items.find(i => i.kind === "polygon" && !i.cutout), cutout = doc.items.find(i => i.kind === "polygon" && i.cutout);
assert.ok(pour && cutout, "the pour and the cutout region were imported");
assert.equal(pour.net, "GND"); assert.equal(pour.layer, "Top");
assert.ok(!doc.items.some(i => i.kind === "track" && i.sourceRecord && !/^(tracks|arcs)6\//.test(i.sourceRecord)), "no track comes from a pour or region");
// A track drawn by an old pour is that pour's copper (a repour replaces it); a component's primitive moves with it.
const poured = bySource.get("tracks6/data#" + (tracks.length + 1));
point(poured.points[0], at(pourTrack.a), "pour track start"); assert.equal(poured.sourcePour, pour.id);
const part = doc.items.find(i => i.kind === "part"), fp = defs.get(part.def).footprint;
const silk = fp.shapes.find(s => s.layer === "Silk" && !s.arc), copperArc = fp.shapes.find(s => s.arc);
assert.ok(silk && copperArc, "component primitives belong to the footprint");
point(A.world(silk.points[0], part), at(owned.a), "component track start"); point(A.world(silk.points.at(-1), part), at(owned.b), "component track end");
near(silk.width, mm(owned.w), "component track width");
const ownedEnds = [A.world(copperArc.points[0], part), A.world(copperArc.points.at(-1), part)];
for (const a of [ownedArc.sa, ownedArc.ea]) {
  const want = [mm(ownedArc.c[0]) + mm(ownedArc.r) * Math.cos(a * Math.PI / 180), -mm(ownedArc.c[1]) - mm(ownedArc.r) * Math.sin(a * Math.PI / 180)];
  assert.ok(ownedEnds.some(p => Math.hypot(p[0] - want[0], p[1] - want[1]) < 1e-6), "component arc end at " + a + " degrees");
}
assert.equal(copperArc.net, "SIG");

// ------------------------------------------------------------------ the pour's outline renders as a hairline, not copper
function recorder() {
  const strokes = [], ctx = {strokes, lineWidth: 1, globalAlpha: 1, stroke() { strokes.push(this.lineWidth); }};
  return new Proxy(ctx, {get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => (o[k] = v, true)});
}
const view = AtriumCanvas.create({getContext: () => ({})}), I = view.internals();
for (const scale of [4, 40, 400]) {
  const ctx = recorder();
  I.drawItem(ctx, pour, doc, defs, scale, {}, true);
  assert.ok(ctx.strokes.length, "the outline is drawn");
  for (const w of ctx.strokes) assert.ok(w * scale <= 2.01, "pour outline at " + scale + " px/mm is " + (w * scale).toFixed(2) + " px wide");
  const trackCtx = recorder(), t = bySource.get("tracks6/data#0");
  I.drawItem(trackCtx, t, doc, defs, scale, {}, true);
  near(Math.max(...trackCtx.strokes), Math.max(t.width, 1 / scale), "a track still draws at its width");
}
console.log("altium-track-fidelity: ok");
