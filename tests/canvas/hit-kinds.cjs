"use strict";
// view.hit(..., {kinds}) picks only those item kinds: a track running inside a footprint's
// courtyard is found by the track tools (round 3, bug 2), and view.resized() maps with the new
// canvas size at once, keeping the world point at the centre (Messages dock, round-2 bug 9).
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/checks/connectivity.js");
require("../../app/core/spatial.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/canvas/canvas.js");
const ctx = new Proxy({}, {get(o, k) { return o[k] ?? (() => ({width: 0})); }, set(o, k, v) { o[k] = v; return true; }});
let size = {width: 800, height: 600};
const canvas = {getContext: () => ctx, getBoundingClientRect: () => size};
const view = AtriumCanvas.create(canvas);
// A 4-pad footprint with a courtyard; a track crosses it between the pads.
const fp = {pads: [[-2, -2], [2, -2], [-2, 2], [2, 2]].map(([x, y], n) => ({number: String(n + 1), x, y, w: 1, h: 1, shape: "rect", layer: "Top"})),
  shapes: [{kind: "line", layer: "Top Courtyard", width: .05, points: [[-3, -3], [3, -3], [3, 3], [-3, 3], [-3, -3]]}], courtyard: [[-3, -3], [3, -3], [3, 3], [-3, 3]]};
const defs = new Map([["d", {id: "d", name: "QFN", footprint: fp}]]);
const doc = Atrium.sheet("pcb", "Hit");
doc.items.push({id: "u1", kind: "part", def: "d", ref: "U1", x: 0, y: 0, angle: 0},
  {id: "t1", kind: "track", net: "A", layer: "Top", width: .2, points: [[-2, -2], [-2, 0], [6, 0]]});
view.fit(doc, defs);
view.render(doc, defs, {grid: false});
const opts = {layer: "Top", layerMode: "all", hidden: new Set()};
const atPad = [-2, -1.6];
assert.equal(view.hit(doc, defs, atPad, opts)?.id, "u1", "the generic pick prefers the footprint (unchanged)");
for (const flipped of [false,true]) {
  view.setFlipped(flipped);
  for (const layerMode of ["single","dim"]) {
    const mode={...opts,layerMode};
    assert.equal(view.hit(doc,defs,atPad,mode)?.id,"t1",layerMode+": active-layer copper wins over a footprint pad");
    assert.deepEqual(view.hits(doc,defs,atPad,mode).slice(0,2).map(i=>i.id),["t1","u1"]);
  }
}
view.setFlipped(false);
assert.equal(view.hit(doc, defs, atPad, {...opts, kinds: ["track"]})?.id, "t1", "kinds: tracks only");
assert.equal(view.hit(doc, defs, atPad, {...opts, kinds: new Set(["track", "via"])})?.id, "t1", "a Set works too");
assert.equal(view.hit(doc, defs, [0, 5], {...opts, kinds: ["track"]}), null, "nothing there");
assert.equal(view.hit(doc, defs, [-2, -2], {...opts, kinds: ["part"]})?.id, "u1");
// Every segment of the track is found, inside and outside the courtyard.
for (const p of [[-2, -1], [-1, 0], [1, 0], [5, 0]]) assert.equal(view.hit(doc, defs, p, {...opts, kinds: ["track"]})?.id, "t1", "segment at " + p);

// A click inside a part's body (courtyard, else its footprint box) away from pads and outline
// strokes picks the part, as Altium does (preview-uiux P1-14); a track, via or smaller part drawn
// over the body still wins.
{
  const small = {pads: [[-.5, 0], [.5, 0]].map(([x, y], n) => ({number: String(n + 1), x, y, w: .4, h: .4, shape: "rect", layer: "Top"})), shapes: []};
  const bodyDefs = new Map([...defs, ["s", {id: "s", name: "0402", footprint: small}]]);
  const b = Atrium.sheet("pcb", "Body");
  b.items.push({id: "u1", kind: "part", def: "d", ref: "U1", x: 0, y: 0, angle: 0},
    {id: "t1", kind: "track", net: "A", layer: "Top", width: .2, points: [[-2, -2], [-2, 0], [6, 0]]},
    {id: "v1", kind: "via", net: "A", x: 1, y: 1.5, diameter: .6, drill: .3},
    {id: "c1", kind: "part", def: "s", ref: "C1", x: 1, y: -1.5, angle: 0},
    {id: "c2", kind: "part", def: "s", ref: "C2", x: 20, y: 0, angle: 0});
  view.fit(b, bodyDefs);
  view.render(b, bodyDefs, {grid: false});
  const at = q => view.hit(b, bodyDefs, q, opts)?.id ?? null;
  assert.equal(at([-1, -1]), "u1", "inside the courtyard, away from pads and outline");
  assert.equal(at([0, 2]), "u1");
  assert.equal(at([1, 0]), "t1", "a track over the body wins");
  assert.equal(at([1, 1.5]), "v1", "a via over the body wins");
  assert.equal(at([1, -1.5]), "c1", "a smaller part inside the body wins");
  assert.equal(at([1.2, -1.5]), "c1");
  assert.equal(at([-2, -2]), "u1", "pads still pick the part");
  assert.equal(at([20, .1]), "c2", "no courtyard: the footprint box");
  assert.equal(at([20, 1]), null, "outside the box");
  assert.equal(at([4.5, 4.5]), null, "outside the courtyard");
  assert.equal(view.hit(b, bodyDefs, [-1, -1], {...opts, kinds: ["track"]}), null, "kinds still filter");
  assert.equal(view.hit(b, bodyDefs, [-1, -1], {...opts, kinds: ["part"]})?.id, "u1");
  view.fit(doc, defs);
  view.render(doc, defs, {grid: false});
}

// The screen and hit geometry both respect the pad's saved corner radius.
{
  const b=Atrium.sheet("pcb","Rounded pads");
  const pad=(id,x,fields)=>({kind:"pad",id,x,y:0,w:2,h:2,shape:"roundrect",layer:"Top",...fields});
  const square=pad("square",0,{roundrectRadiusRatio:0});
  const legacy=pad("legacy",4);
  const round=pad("round",8,{roundrectRadiusRatio:.5});
  const turned=pad("turned",12,{roundrectRadiusRatio:.5,w:2.4,angle:35,drill:.4});
  b.items=[square,legacy,round,turned];
  function pick(land,local,scale=100){
    const p=Atrium.world(local,land);
    view.restoreCamera({cx:p[0],cy:p[1],scale,referenceScale:scale});
    view.render(b,defs,{...opts,grid:false});
    return view.hit(b,defs,p,{...opts,kinds:["pad"]})?.id??null;
  }
  assert.equal(pick(square,[.98,.98]),"square","square corner stays selectable");
  assert.equal(pick(square,[1.1,1.1]),null,"outside the square's hit tolerance");
  assert.equal(pick(legacy,[.9,.9]),"legacy","the default corner is within five screen pixels");
  assert.equal(pick(legacy,[.9,.9],1000),null,"zoom tightens the default corner tolerance");
  assert.equal(pick(round,[.66,.68]),"round","inside the maximum-radius land");
  assert.equal(pick(round,[.9,.9]),null,"outside the maximum-radius corner");
  assert.equal(pick(turned,[.85,.62]),"turned","inside the rotated non-square land");
  assert.equal(pick(turned,[1.1,.9]),null,"outside the rotated round corner");
  assert.equal(pick(turned,[0,0]),"turned","drill centre still picks its pad");
  view.fit(doc,defs);
  view.render(doc,defs,{grid:false});
}

// A flipped board selects copper and silk painted underneath
{
  const doc = Atrium.sheet("pcb", "Flipped overlap");
  doc.items = [
    {id: "silk", kind: "graphic", layer: "Silk", fill: true, closed: true, width: 0, points: [[0, 0], [4, 0], [4, 4], [0, 4]]},
    {id: "bsilk", kind: "graphic", layer: "Bottom silk", fill: true, closed: true, width: 0, points: [[1, 1], [3, 1], [3, 3], [1, 3]]},
    {id: "in1", kind: "track", net: "A", layer: "Inner 1", width: 1, points: [[-2, 10], [6, 10]]},
    {id: "in126", kind: "track", net: "B", layer: "Inner 126", width: 1, points: [[-2, 10], [6, 10]]}
  ];
  const opts = {layer: "Top", layerMode: "all", hidden: new Set(), grid: false};
  view.restoreCamera({cx: 2, cy: 6, scale: 30, referenceScale: 30});
  view.setFlipped(true);
  view.render(doc, defs, opts);
  const order = view.internals().paintOrder(doc, defs, opts);
  const silk = order.filter(l => l === "Silk" || l === "Bottom silk");
  assert.deepEqual(silk, ["Silk", "Bottom silk"], "Bottom silk is painted above Silk");
  assert.ok(order.indexOf("Inner 126") > order.indexOf("Inner 1"), "Inner 126 is painted above Inner 1");
  assert.equal(view.hit(doc, defs, [2, 2], opts)?.id, "bsilk", "the silk click selects the layer on top");
  assert.equal(view.hit(doc, defs, [2, 10], opts)?.id, "in126", "the inner click selects the layer on top");
  assert.deepEqual(view.hits(doc, defs, [2, 10], opts).map(i => i.id), ["in126", "in1"]);
  view.setFlipped(false);
  assert.equal(view.hit(doc, defs, [2, 10], opts)?.id, "in1");
}

// Arc hits follow the chord samples
{
  const arc = {kind: "arc", c: [0, 0], r: 10, start: 0, end: 90, ccw: true};
  const stroke = {id: "q", kind: "graphic", layer: "Top", width: .2, points: [Atrium.arcPoint(arc, 0), Atrium.arcPoint(arc, 90)], arc};
  const opts = {layer: "Top", layerMode: "all", hidden: new Set()};
  assert.equal(Atrium.pathArc(stroke), arc);
  const mid = Atrium.arcPoint(arc, 45);
  const chord = [(stroke.points[0][0] + stroke.points[1][0]) / 2, (stroke.points[0][1] + stroke.points[1][1]) / 2];
  const doc = Atrium.sheet("pcb", "Arc stroke");
  doc.items = [stroke];
  view.restoreCamera({cx: 5, cy: -5, scale: 30, referenceScale: 30});
  view.render(doc, defs, {...opts, grid: false});
  assert.equal(view.hit(doc, defs, mid, opts)?.id, "q", "drawn arc centerline");
  assert.equal(view.hit(doc, defs, chord, opts)?.id ?? null, null, "the chord is 2.9 mm off the stroke");
  const filled = {...stroke, id: "f", fill: true, width: 0};
  const seg = Atrium.sheet("pcb", "Arc fill");
  seg.items = [filled];
  const inside = [(mid[0] * 2 + chord[0]) / 3, (mid[1] * 2 + chord[1]) / 3];
  view.render(seg, defs, {...opts, grid: false});
  assert.equal(view.hit(seg, defs, inside, opts)?.id, "f", "inside the filled circular segment");
  const wide = {kind: "arc", c: [0, 0], r: 80, start: 0, end: 30, ccw: true};
  const points = Atrium.arcProjection(wide, 5);
  const track = {id: "arc", kind: "track", net: "A", layer: "Top", width: .2, points, arc: wide};
  const step = Atrium.arcSweep(wide) / (points.length - 1);
  const on = Atrium.arcPoint(wide, wide.start + step / 2);
  const rim = [on[0] * (1 + .09 / 80), on[1] * (1 + .09 / 80)];
  const board = Atrium.sheet("pcb", "Arc rim");
  board.items = [track];
  view.restoreCamera({cx: on[0], cy: on[1], scale: 80, referenceScale: 80});
  view.render(board, defs, {...opts, grid: false});
  assert.equal(view.hit(board, defs, rim, opts)?.id, "arc", "outer copper of a 5° projection");
  const shallow = {...arc, start:-12, end:12};
  const extrema = Atrium.sheet("pcb", "Arc extrema");
  extrema.items = [{...stroke,id:"extrema",arc:shallow,points:[Atrium.arcPoint(shallow,-12),Atrium.arcPoint(shallow,12)]}];
  assert.equal(view.hit(extrema, defs, [10,0], opts)?.id, "extrema", "unsampled arc extremum");
  const stale = Atrium.sheet("pcb", "Stale arc");
  stale.items = [{...stroke,id:"stale",points:[[0,0],[5,0]]}];
  assert.equal(view.hit(stale, defs, [2,0], opts)?.id, "stale", "edited chords are still selectable");
  assert.equal(view.hit(stale, defs, mid, opts), null);
}

// A mask opening selects nothing, or the track underneath
{
  const track = {id: "t", kind: "track", net: "A", layer: "Top", width: .2, maskExpansion: .4, points: [[0, 0], [10, 0]]};
  const under = {id: "b", kind: "track", net: "B", layer: "Bottom", width: .4, points: [[0, .3], [10, .3]]};
  const alone = Atrium.sheet("pcb", "Mask");
  alone.items = [track];
  const single = {layer: "Top mask", layerMode: "single", hidden: new Set()};
  view.restoreCamera({cx: 5, cy: 0, scale: 80, referenceScale: 80});
  view.render(alone, defs, {...single, grid: false});
  assert.equal(view.hit(alone, defs, [5, .3], single)?.id, "t", "single-layer mask opening");
  const both = Atrium.sheet("pcb", "Mask over copper");
  both.items = [track, under];
  const opts = {layer: "Top", layerMode: "all", hidden: new Set()};
  view.render(both, defs, {...opts, grid: false});
  assert.equal(view.hit(both, defs, [5, .3], opts)?.id, "t", "the opening is painted above the bottom track");
  assert.deepEqual(view.hits(both, defs, [5, .3], opts).map(i => i.id), ["t", "b"], "one result per copper owner");
  assert.equal(view.hit(both, defs, [5, .3], {...opts, hidden:new Set(["Top mask"])})?.id, "b");
  assert.equal(view.hit(both, defs, [5, .3], {...opts, contactOnly:true, layer:"Bottom"})?.id, "b", "routing contacts ignore film strokes");
}

// A region cutout is filled for picking
{
  const S = AtriumBoardShape;
  const disk = {version: 1, contour: [S.arc([0, 0], 5, 0, 180, true), S.line([-5, 0], [5, 0])],
    cutouts: [[S.arc([0, -2], .8, 0, 0, true)]]};
  const points = S.flattenContour(disk.contour);
  const doc = Atrium.sheet("pcb", "Region hole");
  doc.items = [{id: "disk", kind: "graphic", layer: "Top", fill: true, closed: true, width: 0, points,
    regionShape: {...disk, sig: S.signature(points)}}];
  const opts = {layer: "Top", layerMode: "all", hidden: new Set()};
  view.restoreCamera({cx: 0, cy: -2, scale: 40, referenceScale: 40});
  view.render(doc, defs, {...opts, grid: false});
  assert.equal(view.hit(doc, defs, [0, -4], opts)?.id, "disk", "copper in the semicircle");
  assert.equal(view.hit(doc, defs, [0, -2], opts)?.id ?? null, null, "the drawn cutout is empty");
}

// A mil dimension is picked with the millimetre leader
require("../../app/pcb/pcb-draw.js");
{
  let displayUnits = "mil";
  AtriumPCBDraw.install({
    registerAction() {}, addRenderer() {}, on() {}, units: () => displayUnits,
    doc: () => null, view: () => null, canvas: () => null, info() {}, redraw() {}
  });
  const item = AtriumPCBDraw.dimensionItem("radial", [[0, 0], [25.4, 0]], {id: "dim", units: "auto", textHeight: 2, layer: "Mechanical 2"});
  const doc = Atrium.sheet("pcb", "Dimension units");
  doc.items = [item];
  const end = AtriumPCBDraw.dimensionGeometry(item, {units: "mil"}).lines.at(-1).at(-1);
  const opts = {layer: "Mechanical 2", layerMode: "all", hidden: new Set()};
  view.restoreCamera({cx: end[0], cy: end[1], scale: 8, referenceScale: 8});
  view.render(doc, defs, {...opts, grid: false});
  assert.equal(view.hit(doc, defs, end, opts)?.id, "dim", "mil leader end");
  displayUnits = "mm";
  const mmEnd = AtriumPCBDraw.dimensionGeometry(item, {units: "mm"}).lines.at(-1).at(-1);
  view.render(doc, defs, {...opts, grid: false});
  assert.equal(view.hit(doc, defs, end, opts), null);
  assert.equal(view.hit(doc, defs, mmEnd, opts)?.id, "dim", "millimetre leader end");
}

// Default wires are drawn 0.254 mm wide and picked as hairlines
{
  const doc = Atrium.sheet("schematic", "Wire width");
  doc.items = [{id: "w", kind: "wire", points: [[0, 0], [30, 0]]}];
  const opts = {hidden: new Set()};
  view.restoreCamera({cx: 15, cy: 0, scale: 60, referenceScale: 60});
  view.render(doc, defs, {grid: false, hidden: opts.hidden});
  assert.equal(view.hit(doc, defs, [15, 0], opts)?.id, "w", "centerline");
  assert.equal(view.hit(doc, defs, [15, .1], opts)?.id, "w", "inside the 0.127 mm half-stroke");
  assert.equal(view.hit(doc, defs, [15, .25], opts), null);
  for (const style of [{width:.6}, {schPaint:{width:.6}}]) {
    const wide=Atrium.sheet("schematic", "Wide wire");
    wide.items=[{...doc.items[0],...style}];
    assert.equal(view.hit(wide, defs, [15, .29], opts)?.id, "w");
    assert.equal(view.hit(wide, defs, [15, .42], opts), null);
  }
}

// Hop-over arcs fall out of the pick once zoomed
require("../../app/schematic/sch-appearance.js");
require("../../app/schematic/sch-objects.js");
{
  const doc = Atrium.sheet("schematic", "Hop");
  doc.hopOvers = true;
  doc.items = [
    {id: "h", kind: "wire", points: [[0, 0], [20, 0]]},
    {id: "v", kind: "wire", points: [[10, -10], [10, 10]]}
  ];
  const ang = Math.PI * 1.25, hop = .7, at = [10 + Math.cos(ang) * hop, Math.sin(ang) * hop];
  const opts = {hidden: new Set()};
  view.restoreCamera({cx: 10, cy: 0, scale: 20, referenceScale: 20});
  view.render(doc, defs, {grid: false, hidden: opts.hidden});
  assert.equal(view.hit(doc, defs, at, opts)?.id, "h", "shoulder of the drawn hop");
  view.restoreCamera({cx: 10, cy: 0, scale: 80, referenceScale: 80});
  assert.equal(view.hit(doc, defs, [9.6, 0], opts), null, "the hop replaces the straight centreline");
  doc.hopOvers=false;
  assert.equal(view.hit(doc, defs, [9.6, 0], opts)?.id, "h", "turning the option off restores the straight stroke");
  assert.equal(view.hit(doc, defs, at, opts), null);
}

// Resize keeps the centre.
const centre = () => view.screenToWorld([size.width / 2, size.height / 2]);
const c0 = centre();
size = {width: 800, height: 380};
view.resized();
const c1 = centre();
assert.ok(Math.hypot(c1[0] - c0[0], c1[1] - c0[1]) < 1e-9, "centre kept: " + c0 + " -> " + c1);
// ResizeObserver already measured the pane. Use its dimensions even if a layout read
// would still return the old ones, and update both coordinate conversions immediately.
const observed = {width: 640, height: 420};
canvas.getBoundingClientRect = () => { throw Error("Unexpected layout read during the observer update"); };
view.resized(observed);
const observedCentre = [observed.width / 2, observed.height / 2];
assert.deepEqual(view.screenToWorld(observedCentre), c1);
assert.deepEqual(view.worldToScreen(c1), observedCentre);
const ed = require("fs").readFileSync(__dirname + "/../../app/editor/editor.js", "utf8");
assert.ok(ed.includes('function trackHit(p){return view.hit(doc(),defs,p,{...lineOpts(),kinds:["track"]});}'), "track tools pick tracks only");
for (const tool of ["lengthClick", "diffpair-retrace", "diffpair-gloss", "route-tabs"]) assert.ok(ed.includes(tool), tool);
assert.ok(/const at=pointer\|\|p,item=trackHit\(at\)/.test(ed), "length tuning uses trackHit");
console.log("hit-kinds: ok");
