"use strict";
// Component-owned Altium vias, unnumbered pads in the netlist, and zero-width regions on the canvas.
//
// 1. A Vias6 record whose component index is set (thermal vias in an exposed pad, say) stays a
//    via: a footprint pad of kind "via" with the record's net, drill, diameter and layer span, at
//    the record's board position, and it is not a pin. The end-to-end suite once counted these
//    as a top and a bottom pad and added "U1." to the netlist.
// 2. A pad whose number is empty (an exposed pad on GND) is a netlist node, as Altium writes it
//    ("U1-"); footprint vias and thermal vias are not.
// 3. A closed region without a width is a boundary or an area, not a track: the canvas draws its
//    edge as a screen hairline, and a filled one with no edge (keep-outs, footprint polygon
//    cutouts, regions), the rule 2d00bf08 set for pour outlines.
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "board-shape", "altium-ids", "pcb-pours", "pcb-import", "io", "stackup", "polygon-pour",
  "pcb-appearance", "spatial", "connectivity", "pcb-draw", "netlist", "canvas"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const A = Atrium, U = .00000254, none = 65535, tick = x => Math.round(x / U), mm = n => n * U;

function props(text) {
  const v = Buffer.from("|" + text + "\0", "latin1"), n = Buffer.alloc(4);
  n.writeUInt32LE(v.length); return Buffer.concat([n, v]);
}
function frame(type, data) { const h = Buffer.alloc(5); h[0] = type; h.writeUInt32LE(data.length, 1); return Buffer.concat([h, data]); }
// Vias6: layer (74 multi), flags, net, polygon, component, x, y, diameter, drill, start and end layer.
function via(v) {
  const g = Buffer.alloc(67); g[0] = 74;
  g.writeUInt16LE(v.net ?? none, 3); g.writeUInt16LE(none, 5); g.writeUInt16LE(v.owner ?? none, 7); g.writeInt32LE(-1, 9);
  [v.at[0], v.at[1], v.d, v.drill].forEach((n, k) => g.writeInt32LE(n, 13 + 4 * k));
  g[29] = 1; g[30] = 32;
  return frame(3, g);
}

// ------------------------------------------------------------------ 1. owned vias stay vias
const vias = [
  {at: [tick(20.3), tick(10.7)], d: tick(.6), drill: tick(.3), net: 1},                       // free
  {at: [tick(5.4), tick(6.3)], d: tick(.61), drill: tick(.305), net: 0, owner: 0},            // owned by U1
  {at: [tick(6.6), tick(5.7)], d: tick(.61), drill: tick(.305), net: 0, owner: 0},
];
const streams = new Map([
  ["board6/data", props("VX0=0mm|VY0=0mm|VX1=30mm|VY1=0mm|VX2=30mm|VY2=20mm|VX3=0mm|VY3=20mm")],
  ["nets6/data", Buffer.concat(["GND", "SIG"].map(n => props("NAME=" + n)))],
  ["components6/data", props("SOURCEDESIGNATOR=U1|PATTERN=QFN|X=6mm|Y=6mm|LAYER=TOP|ROTATION=30")],
  ["vias6/data", Buffer.concat(vias.map(via))],
]);
const input = AtriumPCB.read("Vias.PcbDoc", streams, null), doc = input.documents[0], defs = new Map(input.library.map(d => [d.id, d]));
const near = (a, b, what, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, what + ": " + a + " differs from " + b);
const free = doc.items.filter(i => i.kind === "via");
assert.equal(free.length, 1, "only the free via is a board item");
near(free[0].x, mm(vias[0].at[0]), "free via x"); assert.equal(free[0].net, "SIG");
const part = doc.items.find(i => i.kind === "part"), fp = defs.get(part.def).footprint;
const owned = (fp.pads || []).filter(p => p.kind === "via");
assert.equal(owned.length, 2, "both component-owned vias belong to the footprint as vias");
assert.ok(!(fp.pads || []).some(p => p.kind !== "via"), "no owned via became a pad");
for (const [k, v] of vias.slice(1).entries()) {
  const at = [mm(v.at[0]), -mm(v.at[1])];
  const p = owned.find(q => Math.hypot(...A.world([q.x, q.y], part).map((c, n) => c - at[n])) < 1e-6);
  assert.ok(p, "owned via " + k + " sits at its board position");
  assert.equal(p.net, "GND", "owned via " + k + " net");
  near(p.drill, mm(v.drill), "owned via " + k + " drill"); near(p.diameter, mm(v.d), "owned via " + k + " diameter");
  assert.equal(p.fromLayer, "Top"); assert.equal(p.toLayer, "Bottom");
}
assert.ok(!Object.keys(part.pinNets || {}).length, "an owned via is not a pin");

// ------------------------------------------------------------------ 2. the netlist keeps unnumbered pads
const lib = {id: "qfn", name: "QFN", footprint: {pads: [
  {number: "1", x: -1, y: 0, w: .3, h: .8, shape: "rect", net: "SIG"},
  {number: "", x: 0, y: 0, w: 2, h: 2, shape: "rect", layer: "Top", net: "GND"},              // exposed pad
  {kind: "via", number: "", x: .5, y: .5, diameter: .6, drill: .3, w: .6, h: .6, shape: "round", layer: "Multi", net: "GND"},
  {number: "9", x: -.5, y: .5, w: .6, h: .6, drill: .3, shape: "round", layer: "Multi", net: "GND", thermalVia: true},
], shapes: []}};
const r1 = {id: "r", name: "R", footprint: {pads: [{number: "1", x: 0, y: 0, w: .5, h: .5, net: "GND"}, {number: "2", x: 1, y: 0, w: .5, h: .5, net: "SIG"}], shapes: []}};
const board = {id: "b", kind: "pcb", items: [
  {id: "u", kind: "part", def: "qfn", ref: "U1", x: 10, y: 10, angle: 0, pinNets: {"1": "SIG"}},
  {id: "r1", kind: "part", def: "r", ref: "R1", x: 20, y: 10, angle: 0, pinNets: {"1": "GND", "2": "SIG"}},
]};
const n = AtriumNetlist.extract({name: "t", documents: [board], library: [lib, r1]}, {source: "pcb", board: "b"});
const gnd = n.nets.find(x => x.name === "GND");
assert.deepEqual(gnd.nodes.map(x => x.ref + "-" + x.pin).sort(), ["R1-1", "U1-"], "GND holds the exposed pad, not the vias");
assert.match(AtriumNetlist.protel(n), /\r\nU1-\r\n/, "the Protel netlist names the unnumbered pad U1-");

// ------------------------------------------------------------------ 3. zero-width regions draw as hairlines
function recorder() {
  const strokes = [], ctx = {strokes, lineWidth: 1, globalAlpha: 1, stroke() { strokes.push(this.lineWidth); }};
  return new Proxy(ctx, {get: (o, k) => k in o ? o[k] : () => {}, set: (o, k, v) => (o[k] = v, true)});
}
const square = [[0, 0], [2, 0], [2, 2], [0, 2]];
const region = {id: "g1", kind: "graphic", layer: "Top", points: square, closed: true, width: 0};
const filled = {id: "g2", kind: "graphic", layer: "Top", points: square, closed: true, fill: true};
const keepout = {id: "k", kind: "graphic", layer: "Top", points: square, closed: true, fill: true, keepout: true, width: 0};
const track = {id: "t", kind: "track", layer: "Top", points: [[0, 0], [3, 0]], width: .25};
const shapes = [
  {kind: "path", layer: "Top", points: square, closed: true, cutout: true, style: "body"},
  {kind: "path", layer: "Top", points: square, closed: true, width: 0, style: "body"},
  {kind: "path", layer: "Top", points: square, closed: true, fill: true, width: 0, style: "body"},
  {kind: "path", layer: "Top", points: square, closed: true, fill: true, keepout: true, style: "body"},
];
const fpDef = {id: "f", name: "F", footprint: {pads: [], shapes}};
const host = {id: "p", kind: "part", def: "f", ref: "C9", x: 5, y: 5, angle: 0};
const pcb = {id: "d", kind: "pcb", items: [region, filled, keepout, track, host]}, fdefs = new Map([["f", fpDef]]);
const view = AtriumCanvas.create({getContext: () => ({})}), I = view.internals();
for (const scale of [4, 40, 400]) {
  const px = ctx => ctx.strokes.map(w => w * scale);
  for (const item of [region, keepout]) {
    const ctx = recorder(); I.drawItem(ctx, item, pcb, fdefs, scale, {}, true);
    assert.ok(ctx.strokes.length, item.id + " edge is drawn");
    for (const w of px(ctx)) assert.ok(w <= 1.01, item.id + " edge at " + scale + " px/mm is " + w.toFixed(2) + " px");
  }
  const f = recorder(); I.drawItem(f, filled, pcb, fdefs, scale, {}, true);
  assert.equal(f.strokes.length, 0, "a filled zero-width region has no edge");
  const t = recorder(); I.drawItem(t, track, pcb, fdefs, scale, {}, true);
  near(Math.max(...t.strokes), Math.max(track.width, 1 / scale), "a track still draws at its width");
  shapes.forEach((s, k) => {
    // The footprint alone, one shape at a time, drawn as the editor draws a placed part.
    const ctx = recorder(); I.drawItem(ctx, host, pcb, new Map([["f", {...fpDef, footprint: {pads: [], shapes: [s]}}]]), scale, {}, true);
    if (s.fill && !s.keepout) assert.equal(ctx.strokes.length, 0, "footprint region " + k + " has no edge");
    else for (const w of px(ctx)) assert.ok(w <= 1.01, "footprint shape " + k + " edge at " + scale + " px/mm is " + w.toFixed(2) + " px");
  });
}
console.log("altium-footprint-vias: ok");
