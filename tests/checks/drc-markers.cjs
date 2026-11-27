"use strict";
// DRC violation markers (app/checks/drc-markers.js): glyphs, severity shapes, highlighted shapes, layer
// visibility and the selection filter, the status-bar line, tooltips, zoom-to and fly-to, drawing, and the spatial pick used by
// online DRC (drc-view.js) to re-check only the edited region.
// Node: node tests/checks/drc-markers.cjs   JSC: scripts/test-jsc.sh drc-markers
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/editor/nav-common.js");
require("../../app/core/spatial.js");
require("../../app/checks/connectivity.js");
require("../../app/checks/rules.js");
require("../../app/checks/drc.js");
require("../../app/checks/drc-view.js");
require("../../app/checks/problem-marks.js");
require("../../app/checks/drc-markers.js");
require("../support/drc-geometry.cjs");
const M = globalThis.AtriumDRCMarkers, R = globalThis.AtriumRules, V = globalThis.AtriumDRCView, A = globalThis.Atrium;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

const r2 = {id: "r2", name: "R", footprint: {shapes: [{kind: "line", points: [[-1, -.6], [1, -.6]], width: .1, layer: "Silk"}],
  pads: [{number: "1", x: -.5, y: 0, w: .5, h: .6, shape: "rect"}, {number: "2", x: .5, y: 0, w: .5, h: .6, shape: "rect"}]}};
const defs = new Map([[r2.id, r2]]);
const track = (id, net, points, width = .2, layer = "Top") => ({kind: "track", id, net, points, width, layer});
const via = (id, net, x, y) => ({kind: "via", id, net, x, y, diameter: .6, drill: .3, layer: "Multi"});
const part = (id, ref, x, y, nets) => ({kind: "part", id, def: "r2", ref, value: "", x, y, angle: 0, layer: "Top", pinNets: nets});
const board = items => ({kind: "pcb", id: "b1", name: "Test", items, notes: []});

test("glyphs: X where two objects conflict, a circle for single-object rules", () => {
  assert.equal(M.glyph({type: "clearance", id: "a", otherId: "b"}), "x");
  assert.equal(M.glyph({type: "short", id: "a"}), "x");
  assert.equal(M.glyph({type: "width", id: "a"}), "o");
  assert.equal(M.glyph({type: "delay", id: "a"}), "o");
  assert.equal(M.glyph({type: "holeSize", id: "a", otherId: "a"}), "o");
});

test("highlighted shapes: tracks, vias, the nearest pad of a part, else its box", () => {
  const b = board([track("t", "A", [[0, 0], [5, 0]], .25), via("v", "B", 3, 2), part("p", "R1", 10, 0, {"1": "C", "2": "D"})]);
  const out = R.drc(b, defs, R.create());
  assert.ok(out.violations.length >= 0);
  let sh = M.shapes(b, defs, {type: "clearance", id: "t", otherId: "v", at: [3, 0], otherAt: [3, 2]});
  assert.deepEqual(sh.map(s => s.kind), ["line", "circle"]);
  assert.equal(sh[0].width, .25); assert.equal(sh[1].r, .3);
  sh = M.shapes(b, defs, {type: "clearance", id: "p", at: [10.5, 0]});
  assert.equal(sh[0].kind, "pad"); assert.deepEqual(sh[0].at, [10.5, 0]); assert.equal(sh[0].w, .5);
  sh = M.shapes(b, defs, {type: "dfaSpacing", id: "p", at: [20, 20]});
  assert.equal(sh[0].kind, "box");
  const box = M.box(b, defs, {type: "clearance", id: "t", otherId: "v", at: [3, 0], otherAt: [3, 2]});
  assert.ok(box[0] <= 0 && box[2] >= 5 && box[3] >= 2.3, JSON.stringify(box));
  assert.deepEqual(M.shapes(b, defs, {type: "length", id: "gone"}), []);
});

test("layer visibility and the selection filter", () => {
  const b = board([track("t1", "A", [[0, 0], [5, 0]]), track("t2", "B", [[0, 1], [5, 1]], .2, "Bottom"), via("v", "C", 9, 9)]);
  const list = [{type: "width", id: "t1", at: [1, 0]}, {type: "width", id: "t2", at: [1, 1]}, {type: "clearance", id: "v", otherId: "t2", at: [9, 9]}, {type: "unrouted", id: "t1", at: [0, 0]},
    {type: "length", title: "Net X", at: [3, 3]}];
  let rows = M.visibleList(b, defs, list, {});
  assert.equal(rows.length, 4, "unrouted connections are ratsnest, not markers");
  rows = M.visibleList(b, defs, list, {hidden: new Set(["Bottom"])});
  assert.deepEqual(rows.map(r => r.v.id), ["t1", "v", undefined], "violations on hidden layers only are not drawn; vias span all layers");
  assert.equal(rows[1].shapes.length, 1, "the hidden half of a pair is not highlighted");
  rows = M.visibleList(b, defs, list, {selectable: i => i.kind !== "track"});
  assert.deepEqual(rows.map(r => [r.v.id, r.live]), [["t1", false], ["t2", false], ["v", true], [undefined, true]]);
});

test("marker rows follow journal edits, library changes, object identity and mutable violation lists", () => {
  require("../../app/history/undo-store.js");
  const U = globalThis.AtriumUndoStore, def = A.clone(r2), lib = new Map([[def.id, def]]);
  const b = board([part("p", "R1", 10, 0, {}), via("v", "A", 2, 2)]);
  const project = {library: [def], documents: [b]};
  const pad = {type: "clearance", id: "p", at: [10.5, 0]}, hole = {type: "holeSize", id: "v", at: [2, 2]};
  const list = [pad, hole], waived = [{...pad, waived: {id: "w"}}];
  let rev = 0;
  const commit = () => { U.record(project); rev++; };
  const check = (label, source = list, options = {}) => {
    const rows = M.visibleList(b, lib, source, {...options, rev});
    assert.deepEqual(rows, M.visibleList(b, lib, source, options), label);
    return rows;
  };
  U.reset(); commit();
  const first = check("initial full build"); check("initial waived", waived);
  b.items[1].x = 3; commit();
  const moved = check("one via moved");
  assert.equal(first[0].shapes[0], moved[0].shapes[0]);
  assert.notEqual(first[1].shapes[0], moved[1].shapes[0]);
  def.footprint.pads[1].x = .85; commit();
  const library = check("footprint edit rebuilds every dependent row");
  assert.deepEqual(library[0].shapes[0].at, [10.85, 0]);
  b.items[1].diameter = 1.4; commit();
  assert.equal(check("subsequent local edit keeps the new pad")[0].shapes[0], library[0].shapes[0]);
  check("waived list missed the footprint edit and two via edits", waived);

  b.items[1] = {...b.items[1], x: 12}; commit();
  assert.equal(check("same length, same ID, new object")[1].shapes[0].item, b.items[1]);
  assert.equal(M.shapes(b, lib, hole)[0].item, b.items[1]);
  b.items[1].id = "renamed"; commit();
  assert.deepEqual(check("old ID is absent")[1].shapes, []);
  hole.id = "renamed"; hole.at[0] = 12;
  list.reverse(); list.push({type: "unrouted", id: "missing"});
  const reordered = check("in-place ID, point and order edits at the same revision");
  assert.deepEqual(reordered.map(r => r.v), [hole, pad]);
  list[0] = {...hole, otherId: "p", otherAt: [10.85, 0]};
  assert.equal(check("same-length violation replacement")[0].shapes.length, 2);
  list[0].otherAt[0] = 9.5; pad.type = "unrouted"; list.pop();
  assert.deepEqual(check("secondary point and unrouted mutation")[0].shapes[1].at, [9.5, 0]);
  b.items[0].x += 6; U.touch(project); rev++;
  check("unrecorded edit uses current objects");
  b.items.push({...b.items[1], x: 99}); commit();
  assert.deepEqual(check("duplicate ID uses the last object", [hole])[0].shapes[0].at, [99, 2]);
  b.items.reverse(); commit();
  assert.deepEqual(check("duplicate ID after reordering", [hole])[0].shapes[0].at, [12, 2]);
  U.reset();
});

test("one footprint transformation serves all related violation projections in a pass", () => {
  const U = AtriumUndoStore, p = part("p", "U1", 10, 3, {}), b = board([p]);
  const def = {...r2, footprint:{...r2.footprint, pads:Array.from({length:96}, (_, i) =>
    ({number:String(i + 1), x:(i % 12) * .3, y:Math.floor(i / 12) * .3, w:.18, h:.18, shape:"round"}))}};
  const lib = new Map([[def.id, def]]), project = {library:[def], documents:[b]};
  const list = Array.from({length:960}, (_, i) => ({id:p.id, type:"clearance", at:[10 + (i % 12) * .3, 3 + (i % 8) * .3]}));
  const pins = A.pins;
  let transformed = 0;
  function check(options) {
    const expected = list.map(v => M.shapes(b, lib, v));
    transformed = 0;
    const actual = M.visibleList(b, lib, list, options).map(row => row.shapes);
    assert.deepEqual(actual, expected);
    assert.equal(transformed, 1);
    assert.notEqual(actual[0][0].at, actual[24][0].at, "rows keep their own point arrays");
  }
  U.reset();
  A.pins = (...args) => { transformed++; return pins(...args); };
  try {
    U.record(project);
    check({rev:1});
    p.x += .127; p.angle = 90;
    U.record(project,{doc:b,items:[p]});
    check({rev:2});
    p.x -= .254;
    check({rev:2,preview:new Set([p.id])});
  } finally { A.pins = pins; U.reset(); }
});

test("dense cached marker paths draw the same ordered strokes as a fresh immediate overlay", () => {
  for (const mod of ["path-record", "pdf", "print"]) require(require("../support/app-source-paths.cjs").appFile(mod + ".js"));
  const U = globalThis.AtriumUndoStore, items = [], list = [], waived = [];
  for (let k = 0; k < 360; k++) {
    const x = k % 24, y = Math.floor(k / 24), id = "t" + k;
    items.push(track(id, "A", [[x, y], [x + .8, y + .3]], .2, k % 7 ? "Top" : "Bottom"));
    const v = {type: k % 4 ? "width" : "clearance", id, at: [x, y], warning: k % 3 === 0, actual: .1};
    if (k % 4 === 0) { v.otherId = "t1"; v.otherAt = [x + .5, y + .2]; }
    if (k % 11) list.push(v); else waived.push({...v, waived: {id: "w"}});
  }
  const b = board(items), project = {library: [...defs.values()], documents: [b]}, hidden = new Set();
  let rev = 1, filtered = false, focused = null, hover = null, scale = 18, offset = 30, area = null, drag = null;
  const selectable = i => !filtered || !i.id.endsWith("3");
  const host = {defs: () => defs, doc: () => b, revision: () => rev, hiddenLayers: () => hidden, selectable, drag: () => drag};
  const rec = AtriumPDF.recorder(520, 310), paths = [], stroke = rec.ctx.stroke;
  rec.ctx.stroke = p => { if (p) paths.push(p); stroke(p); };
  const check = label => {
    paths.length = 0; rec.list.length = 0;
    const fresh = AtriumPDF.recorder(520, 310);
    // A fresh document and a context without Path2D use full geometry and issue each path command.
    const immediate = new Proxy(fresh.ctx, {get: (obj, key) => key === "canvas" ? null : obj[key]});
    const a = {scale, width: 520, height: 310, area, worldToScreen: p => [offset + scale*p[0], 12 + scale*p[1]]};
    for (const c of [rec.ctx, immediate]) c.setTransform(scale, 0, 0, scale, offset, 12);
    M.renderFor(host, b, list, {focused, hover, waived}).overlay(rec.ctx, a);
    M.overlay({...b}, defs, list, {rev, hidden, selectable, focused, hover, waived})(immediate, a);
    assert.deepEqual(rec.list, fresh.list, label);
    return paths.slice();
  };
  U.reset(); U.record(project);
  const before = check("ordinary dense overlay"); assert.ok(before.length > 0);
  b.items[9].points = [[9.4, .3], [10, .7]]; U.record(project); rev++;
  const after = check("local outline edit");
  assert.equal(before.length, after.length);
  before.forEach((p, i) => assert.equal(after[i], p, "marker glyph paths retained"));
  hidden.add("Bottom"); filtered = true; focused = list[20]; hover = waived[1];
  check("waived, focused, hovered, hidden and non-selectable rows");
  list.reverse(); list[4].at[0] += 1; list[0].warning = !list[0].warning;
  check("changed marker positions, priorities and ordering");
  scale = 24; offset = -80; check("zoom and pan");
  area = [10, 0, 35, 310]; check("exposed pan strip through detailed rows"); area = null;
  const savedPoints = b.items[9].points;
  b.items[9].points = savedPoints.map(([x, y]) => [x + 12, y]);
  drag = {before: {}, translation: {affected: [b.items[9]]}}; check("live drag before a journal commit");
  b.items[9].points = savedPoints; drag = null; check("cancelled drag");
  drag = {before: {}}; b.items[9].points = [[15, 5], [18, 9]];
  check("untracked live geometry"); b.items[9].points = savedPoints; drag = null; check("end untracked preview");
  const at = [2, 3], a = {type: "width", at, id: "t1"}, w = {...a, waived: {id: "w"}};
  const pane = {docId: b.id, canvas: rec.canvas, view: {worldToScreen: p => p}};
  const coincident = M.groupAt(host, pane, [a], 2, 3, [w]);
  assert.equal(coincident.v, a, "one live glyph represents coincident active and waived findings");
  assert.deepEqual(coincident.members, [a, w]);
  assert.deepEqual(coincident.boxes, [M.box(b, defs, a), M.box(b, defs, w)], "active and waived rows keep their own ordered bounds");
  assert.equal(M.markerAt(host, pane, [], 2, 3, [w]), w, "a standalone waived glyph remains selectable");
  // Overlapping markers answer as one (the worst, first); far apart once zoomed in, each answers for itself.
  const warn = {type: "width", at: [10, 10], id: "t1", warning: true}, err = {type: "width", at: [10.2, 10], id: "t1"};
  const zoomed = s => ({docId: b.id, canvas: rec.canvas, view: {scale: () => s, worldToScreen: p => [p[0] * s, p[1] * s]}});
  assert.equal(M.markerAt(host, zoomed(10), [warn, err], 100, 100), err, "merged: the error stands for the group");
  assert.equal(M.markerAt(host, zoomed(400), [warn, err], 4000, 4000), warn, "apart: the warning under the pointer");
  U.reset();
});

test("dense overview keeps first encounter ties, exact clip and stable published geometry", () => {
  const U = AtriumUndoStore, item = track("shared","A",[[0,1],[2,1]]), b = board([item]);
  const project = {library:[],documents:[b]}, lib = new Map();
  const first = {type:"width",id:item.id,at:[1,1],warning:true}, tied = {...first,at:[1.1,1]};
  const filler = Array.from({length:260},(_,i)=>({type:"width",at:[5+i*2,0],warning:true}));
  const list = [first,tied,...filler], publication = () => true;
  const draw = (rows, opts = {}, scale=14, view=[-3,-3,590,10]) => {
    const rec = AtriumPDF.recorder(800,400);
    M.overlay(b,lib,rows,{rev:1,...opts})(rec.ctx,{scale,worldToScreen:([x,y])=>[x*scale,y*scale],worldViewport:()=>view});
    return rec.list;
  };
  U.reset(); U.record(project);
  const weaker = {...tied, waived:{id:"waiver"}};
  assert.deepEqual(draw(list,{publication}),draw([first,weaker,...filler]),"equal severity leaves the first marker in its exact cell");
  const clip = [-3,-3,79.5,10], clipped = list.filter(v => v.at[0] < 80);
  assert.deepEqual(draw(list,{publication},24,clip),draw(clipped,{},24,clip),"clip still selects the complete visible cells");
  const pane = {docId:b.id,canvas:{getBoundingClientRect:()=>({left:0,top:0})},
    view:{scale:()=>14,worldToScreen:([x,y])=>[x*14,y*14]}};
  const host = {doc:()=>b,defs:()=>lib,revision:()=>1};
  assert.equal(M.markerAt(host,pane,list,14,14,null,publication),first);
  assert.deepEqual(M.groupAt(host,pane,list,14,14,null,publication).members,[first,tied],"the tie keeps both published findings");
  const version = () => true;
  tied.at = [8,0]; list.reverse();
  assert.deepEqual(draw(list,{publication:version}),draw(list),"republication can replace and reorder rows without changing the array");
  U.reset();
});

test("published overview paints and picks the same cell, including when zoom or the publication changes", () => {
  const U = AtriumUndoStore, b = board([]), P = AtriumProblemMarks, defs = new Map();
  U.reset(); U.record({library: [], documents: [b]});
  try {
    const first = {type: "width", at: [.1, .1]}, warning = {type: "width", at: [1.1, 1.1], warning: true};
    const filler = Array.from({length: 249}, (_, i) => ({type: "width", at: [5 + 2 * i, 0]}));
    const rows = [first, warning, ...filler], sparse = rows.slice(0, -1);
    let scale = 10, projections = 0, publication = () => true;
    const size = {width: 5100, height: 50}, canvas = {getBoundingClientRect: () => ({left: 100, top: 150, ...size})};
    const project = ([x, y]) => { projections++; return [scale * x, scale * y]; };
    const viewport = () => [-1, -1, 505, 5];
    const pane = {docId: b.id, canvas, view: {scale: () => scale, worldToScreen: project, worldViewport: viewport}};
    const host = {doc: () => b, defs: () => defs, revision: () => 1};
    const ctx = AtriumPDF.recorder(size.width, size.height).ctx, colors = [];
    const stroke = ctx.stroke;
    ctx.stroke = p => { colors.push(ctx.strokeStyle); stroke(p); };
    const draw = (list, viewCanvas = canvas) => {
      colors.length = 0;
      M.renderFor(host, b, list, {publication}).overlay(ctx, {
        canvas: viewCanvas, scale, ...size, worldToScreen: project, worldViewport: viewport
      });
      return colors.includes(M.COLORS.warning);
    };
    const pick = (list, at) => M.groupAt(host, pane, list, 100 + at[0] * scale, 150 + at[1] * scale, null, publication);

    assert.ok(Math.hypot(10, 10) > 2 * P.size(scale, "pcb").screen, "the detail symbols would be separate");
    assert.equal(draw(rows), false);
    assert.equal(pick(rows, warning.at), null, "a hidden overview warning is not a target");
    const group = pick(rows, first.at);
    assert.equal(group.v, first);
    assert.deepEqual(group.members, [first, warning], "the visible symbol retains the hidden cell members");

    projections = 0;
    draw(rows);
    pick(rows, first.at);
    assert.ok(projections <= 6, `unchanged paint and pick made ${projections} projections`);

    assert.equal(draw(sparse), false);
    assert.equal(pick(sparse, warning.at), null, "crossing the old dense cutoff preserves cell membership");
    assert.equal(draw([first, warning]), false);
    assert.deepEqual(pick([first, warning], first.at).members, [first, warning], "two findings also group when the board is empty elsewhere");
    assert.equal(draw([warning]), true);
    assert.equal(pick([warning], warning.at).v, warning, "an isolated finding is painted and pickable");
    scale = 100;
    assert.equal(draw(rows), true);
    assert.equal(pick(rows, warning.at).v, warning, "zoom changes the cell winners for paint and pick");

    const old = warning.at;
    warning.at = [2.4, 1.1];
    publication = () => true;
    assert.equal(draw(rows), true);
    assert.equal(pick(rows, old), null, "a replacement publication invalidates the previous screen location");
    assert.equal(pick(rows, warning.at).v, warning);
  } finally { U.reset(); }
});

test("camera moves reuse world eligibility and leave the exact projected glyphs unchanged", () => {
  const U = AtriumUndoStore, tracks = [1, 5, 95].map((x, i) => track("t" + i, "A", [[x, 0], [x + 1, 0]]));
  const b = board(tracks), list = tracks.map(i => ({type: "width", id: i.id, at: i.points[0]}));
  U.reset(); U.record({library: [], documents: [b]});
  try {
    const canvas = {getBoundingClientRect: () => ({left: 0, top: 0, width: 500, height: 200})};
    const options = {hidden: new Set(), layer: "Top", layerMode: "all"};
    let viewport = [-1, -1, 60, 12], scale = 10, offset = 0, tested = [];
    const selectable = i => options.layerMode !== "single" || i !== tracks[1];
    const counted = i => { tested.push(i.id); return selectable(i); };
    const view = {scale: () => scale, worldToScreen: ([x, y]) => [x * scale - offset, y * scale + 30],
      worldViewport: () => viewport, selectable: counted};
    const pane = {docId: b.id, canvas, view, options};
    const host = {doc: () => b, defs: () => defs, revision: () => 1};
    let publication = () => true;
    function paint() {
      const a = {canvas, width: 500, height: 200, scale, options, worldToScreen: view.worldToScreen,
        worldViewport: view.worldViewport, selectable: counted};
      const actual = AtriumPDF.recorder(a.width, a.height), expected = AtriumPDF.recorder(a.width, a.height);
      M.renderFor(host, b, list, {publication}).overlay(actual.ctx, a);
      M.overlay(b, defs, list, {hidden: options.hidden, selectable})(expected.ctx, a);
      assert.deepEqual(actual.list, expected.list, "retention is pixel-command equivalent to a fresh paint");
    }
    const pick = v => {
      const [x, y] = view.worldToScreen(v.at);
      return M.groupAt(host, pane, list, x, y, null, publication)?.v || null;
    };
    paint();
    assert.deepEqual(tested, ["t0", "t1"], "out-of-view rows are not resolved early");
    tested = []; scale = 20;
    paint();
    assert.equal(pick(list[1]), list[1]);
    assert.deepEqual(tested, [], "changing only scale requires no new selection checks");
    offset = 1200; viewport = [60, -1, 125, 12];
    paint();
    assert.equal(pick(list[2]), list[2]);
    assert.deepEqual(tested, ["t2"], "only the newly exposed row is resolved");
    tested = []; options.layerMode = "single";
    offset = 0; viewport = [-1, -1, 60, 12];
    paint();
    assert.equal(pick(list[1]), null);
    assert.deepEqual(tested, ["t0", "t1"], "changing the filter replaces eligibility");
    tested = []; publication = () => true;
    paint();
    assert.deepEqual(tested, ["t0", "t1"], "a replacement publication revalidates rows");
  } finally { U.reset(); }
});

test("dense published cameras reuse world cell keys but recalculate the visible winners", () => {
  const U = AtriumUndoStore, line = track("long", "A", [[-20, 1], [42, 1]]), b = board([line]);
  const err = {type:"clearance", id:line.id, at:[-3,1]}, warn = {type:"width", at:[-1,2], warning:true};
  const list = [err, warn, ...Array.from({length:360}, (_, i) =>
    ({type:"width", at:[3+(i%36)*.12, (i%19)*.2], warning:i%2===0}))];
  const waived = [{...warn, waived:{id:"W"}}], host = {doc:()=>b, defs:()=>defs, revision:()=>1};
  const canvas = {}, options = {hidden:new Set(), layer:"Top", layerMode:"all"}, width=96, height=48;
  let publication = {}, scales = [7,6], start=0, hover=null, focused=null;
  const redraw = (scale, retain, area=null) => {
    const rec = AtriumPDF.recorder(width,height), left=-start*scale, top=12;
    const worldToScreen = ([x,y]) => [left+x*scale,top+y*scale];
    const worldViewport = (area,pad=0) => {
      const [x,y,r,h] = area || [0,0,width,height];
      return [(x-left-pad)/scale,(y-top-pad)/scale,(r-left+pad)/scale,(h-top+pad)/scale];
    };
    const frame = {width,height,scale,area,canvas,options,worldToScreen,worldViewport,selectable:()=>true};
    const o = {focused,hover,waived,publication:retain?publication:null};
    rec.ctx.setTransform(scale,0,0,scale,left,top);
    M.renderFor(host,b,list,o).overlay(rec.ctx,frame);
    return rec.list;
  };
  const floor = Math.floor;
  U.reset(); U.record({library:[],documents:[b]});
  try {
    redraw(scales[0],true);
    let floors = 0;
    Math.floor = n => {floors++;return floor(n);};
    const retained = redraw(scales[1],true);
    Math.floor = floor;
    assert.ok(floors < list.length, "same world band does not re-bin every published marker at the next zoom");
    assert.deepEqual(retained,redraw(scales[1],false));
    assert.ok(retained.length,"a long outline admits its distant marker cell");
    start=-1.5; hover=warn; focused=err;
    assert.deepEqual(redraw(5,true),redraw(5,false),"pan and under-pointer promotion repaint the same ordered ink");
    assert.deepEqual(redraw(5,true,[0,0,30,height]),redraw(5,false,[0,0,30,height]),"damage strip uses the same complete cells");
    assert.deepEqual(redraw(3.9,true),redraw(3.9,false),"changing the scale band rebuilds keys");
    assert.deepEqual(redraw(37,true),redraw(37,false),"close detail keeps its independent path");
    warn.at = [1,1]; list.reverse(); publication = {};
    assert.deepEqual(redraw(6,true),redraw(6,false),"republishing mutable source coordinates and order invalidates keys");
    line.points = [[80,1],[81,1]];
    U.record({library:[],documents:[b]},{doc:b,items:[line]});
    assert.deepEqual(redraw(6,true),redraw(6,false),"a journal geometry change invalidates the old bounds");
  } finally { Math.floor=floor; U.reset(); }
});

test("dense cells require an exact member bound even when their joint box reaches the view", () => {
  const U = AtriumUndoStore, x = track("x","A",[[0,0],[110,1]]), y = track("y","A",[[0,0],[1,110]]);
  const doc = board([x,y]), project = {library:[],documents:[doc]}, canvas = {}, publication = {};
  const list = [{id:x.id,type:"width",at:[0,0]}, {id:y.id,type:"width",at:[1,1]},
    ...Array.from({length:280}, () => ({type:"width",at:[7,1],warning:true}))];
  const host = {doc:()=>doc,defs:()=>defs,revision:()=>1};
  const paint = (left, top, cached, source=list, waived=null) => {
    const scale=6, width=24, height=24, rec=AtriumPDF.recorder(width,height);
    const worldToScreen = ([x,y]) => [scale*(x-left),scale*(y-top)];
    const worldViewport = (_a, p=0) => [left-p/scale,top-p/scale,left+(width+p)/scale,top+(height+p)/scale];
    rec.ctx.setTransform(scale,0,0,scale,-left*scale,-top*scale);
    M.renderFor(host,doc,source,{publication:cached?publication:null,waived}).overlay(rec.ctx,
      {canvas,width,height,scale,worldToScreen,worldViewport});
    return rec.list;
  };
  U.reset(); U.record(project);
  try {
    assert.equal(paint(80,80,true).length,0,"union alone cannot admit the cell");
    const crossing = paint(70,0,true);
    assert.ok(crossing.length,"a member's distant track admits the whole cell");
    assert.deepEqual(crossing,paint(70,0,false),"the offscreen center and long outline preserve their order");
    assert.equal(paint(80,80,true).length,0,"the anchored witness does not leak into the reverse camera");
    assert.deepEqual(paint(70,0,true),crossing);
    const waived = Array.from({length:280}, (_,i)=>({type:"width",id:x.id,waived:{id:"W"+i}}));
    assert.equal(paint(70,0,true,[],waived).length,0,"anchorless waived-only rows produce no marker ink");
    assert.equal(paint(80,80,true,[],waived).length,0,"anchorless waivers outside the view produce no marker ink");
  } finally { U.reset(); }
});

test("each pane paints and picks using its own hidden layers", () => {
  const top = track("t", "A", [[0, 0], [2, 0]]);
  const b = board([top]), v = {type: "width", id: top.id, at: [1, 0]}, list = [v];
  const host = {doc: () => b, defs: () => defs, hiddenLayers: () => new Set(["Top"]), selectable: () => false};
  const show = {hidden: new Set(), layer: "Top", layerMode: "all"};
  const hide = {...show, hidden: new Set(["Top"])};
  const rect = {left: 0, top: 0, width: 500, height: 200};
  const projection = ([x, y]) => [50 + x * 10, 50 + y * 10];
  const view = {scale: () => 10, selectable: () => true, worldToScreen: projection};
  const frame = options => ({...rect, scale: 10, selectable: view.selectable, worldToScreen: projection, options});
  const pane = options => ({docId: b.id, canvas: {getBoundingClientRect: () => rect}, view, options});
  const draw = options => {
    const rec = AtriumPDF.recorder(rect.width, rect.height);
    M.renderFor(host, b, list).overlay(rec.ctx, frame(options));
    return rec.list.length;
  };
  assert.ok(draw(show) > 0);
  assert.equal(draw(hide), 0);
  assert.equal(M.markerAt(host, pane(show), list, 60, 50), v);
  assert.equal(M.markerAt(host, pane(hide), list, 60, 50), null);
});

test("a damage strip keeps the full viewport's dense marker style", () => {
  const b = board([]), scale = 60;
  const violations = Array.from({length:251}, (_, i) => ({type:"width", at:[i ? i + 20 : 0, 0]}));
  violations.push({type:"clearance", at:[.1, 0]});
  const render = (area, list) => {
    const rec = AtriumPDF.recorder(800, 400);
    M.overlay(b, defs, list, {rev:1})(rec.ctx, {
      area, scale, worldToScreen:p => p.map(x => x * scale),
      worldViewport:strip => strip ? [-2, -2, 2, 2] : [-2, -2, 300, 2]
    });
    return rec.list;
  };
  const strip = [0, 0, 12, 10];
  const overview = render(strip, violations);
  const sparse = render(strip, violations.filter(v => v.at[0] < 1));
  assert.ok(overview.length > 0 && sparse.length > overview.length, "dense strip takes the batched style, sparse strip draws the cluster count");
});

test("diagonal pan submits only exposed paths in unchanged overview order", () => {
  const left = [0, 0, 2, 100], bottom = [2, 98, 100, 100], union = [0, 0, 100, 100];
  const b = board([
    track("center", "A", [[45, 50], [55, 50]]),
    track("warning", "B", [[.5, 15], [1.5, 15]]),
    track("error", "C", [[.5, 15.3], [1.5, 15.3]]),
    track("bottom", "D", [[70, 99], [80, 99]])
  ]);
  const rows = [
    {id: "center", type: "width", at: [50, 50]},
    {id: "warning", type: "netAntennae", at: [1, 15], warning: true},
    {id: "error", type: "width", at: [1, 15.3]},
    {id: "bottom", type: "width", at: [75, 99]},
    ...Array.from({length: 251}, (_, i) => ({type: "width", at: [30 + i % 20, 30 + Math.floor(i / 20)]}))
  ];
  const render = damageRects => {
    let points;
    const strokes = [];
    const ctx = {
      save() {}, restore() {}, setLineDash() {}, closePath() {}, fill() {},
      beginPath() { points = []; },
      moveTo(x, y) { points.push([x, y]); },
      lineTo(x, y) { points.push([x, y]); },
      arc(x, y) { points.push([x, y]); },
      stroke() { strokes.push({color: this.strokeStyle, points}); }
    };
    M.overlay(b, defs, rows, {rev: 1})(ctx, {
      area: union, damageRects, scale: 40, worldViewport: rect => rect || union,
      worldToScreen: ([x, y]) => [x * 40, y * 40]
    });
    return strokes;
  };
  const all = render(), visible = render([left, bottom]);
  assert.deepEqual(all.slice(0, 2).map(s => s.color), [M.COLORS.error, M.COLORS.warning]);
  assert.deepEqual(visible.slice(0, 2).map(s => s.color), [M.COLORS.error, M.COLORS.warning],
    "the clipped center still determines the first outline style");
  assert.deepEqual(visible[0].points, [[.5, 15.3], [1.5, 15.3], [70, 99], [80, 99]]);
  assert.deepEqual(visible[1].points, [[.5, 15], [1.5, 15]]);
  assert.ok(visible.flatMap(s => s.points).length < all.flatMap(s => s.points).length / 4,
    "interior paths are not sent to the canvas rasterizer");
});

test("coarse groups retain their world band, then split into children at the next zoom level", () => {
  const b = board([]), host = {doc: () => b, defs: () => defs};
  const error = {type: "width", at: [-3.5, .4]}, warning = {type: "width", at: [-1.1, .4], warning: true};
  const north = {type: "width", at: [-1.1, -1.4]}, rows = [error, warning, north];
  const pick = (scale, ox, at) => {
    const project = ([x, y]) => [ox + scale * x, 45 + scale * y];
    const pane = {docId: b.id, canvas: {getBoundingClientRect: () => ({left: 23, top: 35, width: 300, height: 200})},
      view: {scale: () => scale, worldToScreen: project}};
    const [x,y] = project(at);
    return M.groupAt(host, pane, rows, 23 + x, 35 + y);
  };
  for (const [scale, x] of [[10, 90], [12, 112], [15.5, 86]]) {
    assert.deepEqual(pick(scale, x, error.at).members, [error, warning]);
    assert.deepEqual(pick(scale, x, north.at).members, [north], "world zero remains a cell boundary");
    assert.equal(pick(scale, x, warning.at), null, "a collapsed position is not a phantom hit target");
  }
  assert.deepEqual(pick(18, 95, error.at).members, [error]);
  assert.deepEqual(pick(18, 95, warning.at).members, [warning], "the finer children are independently actionable");
  assert.equal(pick(50, 210, warning.at).v, warning, "close inspection keeps the original physical finding");
});

test("coarse glyphs omit member outlines and dimensions, while isolated or inspected findings draw exactly", () => {
  const primary = track("primary", "A", [[1, 1], [20, 1]]), secondary = track("secondary", "B", [[3, 3], [22, 3]]);
  const b = board([primary, secondary]);
  const error = {type:"clearance", id:primary.id, at:[1,1], otherId:secondary.id, otherAt:[1,2], actual:.15};
  const warning = {type:"width", id:secondary.id, at:[3,3], warning:true};
  const draw = (list, options = {}, project = true) => {
    const {ctx, list: commands} = AtriumPDF.recorder(500, 450), scale = 12;
    M.overlay(b, defs, list, options)(ctx, {scale, width:500, height:450,
      worldToScreen: project ? ([x,y]) => [x*scale,y*scale] : undefined});
    return commands;
  };
  const longOutline = (commands, y) => commands.some(c => c.k === "p" && c.d.length === 6 && c.d[2] === y && c.d[5] === y);
  const isolated = draw([error]), grouped = draw([error, warning]);
  assert.deepEqual(isolated, draw([error], {}, false), "single low-zoom artwork is the existing exact detail");
  assert.ok(longOutline(isolated, 1) && longOutline(isolated, 3), "the singleton shows both violating shapes");
  assert.ok(!longOutline(grouped, 1) && !longOutline(grouped, 3), "a coarse cluster retires the member outlines");
  assert.equal(grouped.length, 3, "only the halo, marker border and interior are submitted");
  const pinned = draw([error, warning], {focused:warning, hover:error});
  assert.ok(longOutline(pinned, 1) && longOutline(pinned, 3), "both pinned and hovered objects retain their detail");
  const host = {doc: () => b, defs: () => defs}, pane = {docId:b.id,
    canvas:{getBoundingClientRect:() => ({left:0,top:0,width:500,height:450})},
    view:{scale:() => 12,worldToScreen:([x,y]) => [12*x,12*y]}};
  assert.equal(M.groupAt(host,pane,[error,warning],36,36,null,null,warning,error).v, warning);
  assert.equal(M.groupAt(host,pane,[error,warning],12,12,null,null,warning,error).v, error);
});

test("a cut coarse cell uses its visible member and repairs both anchors only as it changes", () => {
  const b = board([]), host = {doc: () => b, defs: () => defs};
  const error = {type:"width", at:[.1,6]}, warning = {type:"width", at:[1.65,6.4],warning:true};
  const rows = [error,warning], paint = M.overlay(b,defs,rows), scale = 16;
  const frame = (offset, flip = false) => ({scale,width:200,height:200,
    worldToScreen: ([x,y]) => [offset + (flip ? -x : x)*scale,y*scale]});
  const pick = (f, at) => {
    const [x,y] = f.worldToScreen(at);
    const pane = {docId:b.id,canvas:{getBoundingClientRect:() => ({left:0,top:0,width:f.width,height:f.height})},view:f};
    return M.groupAt(host,pane,rows,x,y);
  };
  const before = frame(10), after = frame(-12);
  assert.equal(pick(before,error.at).v,error);
  const target = pick(after,warning.at);
  assert.equal(target.v,warning);
  assert.deepEqual(target.members,rows,"the visible proxy opens the whole world cell");
  assert.equal(paint.panDamage(after,-22,0).length,2,"old and new anchors are damaged");
  assert.equal(paint.panDamage(frame(14),4,0).length,0,"stable groups use only the exposed strips");
  const flipped = frame(210,true);
  assert.equal(pick(flipped,warning.at).v,warning,"the reflected viewport uses its opposite edge");
  assert.equal(paint.panDamage(flipped,24,0).length,2);
});

test("coarse overlap ties follow paint order and an isolated marker needs no retained layer", () => {
  const b = board([]), host = {doc: () => b, defs: () => defs}, scale = 16;
  const error = {type:"width",at:[3.75,2]}, member = {type:"width",at:[1.25,2],warning:true};
  const single = {type:"width",at:[4.25,2],warning:true}, rows = [error,member,single];
  const frame = {scale,width:300,height:150,worldToScreen:([x,y]) => [x*scale,y*scale]};
  const pane = {docId:b.id,canvas:{getBoundingClientRect:() => ({left:0,top:0,width:300,height:150})},view:frame};
  assert.equal(M.groupAt(host,pane,rows,64,32).v,error,"the group painted above the singleton wins an equidistant hit");
  const {ctx} = AtriumPDF.recorder(300,150);
  ctx.getTransform = () => ({a:1,b:0,c:0,d:1,e:0,f:0});
  const offscreen = globalThis.OffscreenCanvas;
  let allocations = 0;
  globalThis.OffscreenCanvas = class { constructor() {allocations++; throw Error("use the direct drawing for this control");} };
  try {
    M.overlay(b,defs,[single])(ctx,frame);
    assert.equal(allocations,0,"no full-size backing for sparse singletons");
    M.overlay(b,defs,rows)(ctx,frame);
    assert.equal(allocations,1,"the test reaches the retained layer for a real group");
  } finally { globalThis.OffscreenCanvas = offscreen; }
});

test("tooltip: rule, measured against required, objects and location", () => {
  const d = M.describe({type: "clearance", ruleName: "Clearance", id: "a", otherId: "b", title: "Track (Top) GND ↔ Pad U1-3 (Top) VCC", actual: .15, required: .2, limit: "min", at: [1, 2]}, "mm");
  assert.equal(d.title, "Clearance · Clearance");
  assert.match(d.measured, /Measured 0\.15 ?mm · required ≥ 0\.2 ?mm/);
  assert.deepEqual(d.objects, ["Track (Top) GND", "Pad U1-3 (Top) VCC"]);
  assert.match(d.where, /at 1 ?mm, 2 ?mm/);
  const w = M.describe({type: "width", ruleName: "Width", what: "Impedance width", actual: .3, required: .25, limit: "max", title: "Track", at: [0, 0]}, "mil");
  assert.match(w.measured, /impedance width .*mil · required ≤ .*mil/);
  const t = M.describe({type: "delay", ruleName: "Delay", detail: "Delay 120.0 ps < 150.0 ps", delay: {actual: 120, required: 150, limit: "min"}, title: "Net A", at: [0, 0]});
  assert.match(t.measured, /Measured 120\.00 ps · required ≥ 150\.00 ps/);
  const s = M.describe({type: "short", ruleName: "Short", detail: "Short circuit between nets A, B", title: "Track A ↔ Track B", at: [0, 0]});
  assert.equal(s.measured, "Short circuit between nets A, B");
});

test("overlay draws highlights, glyphs, detail lines and labels", () => {
  const calls = [];
  const ctx = new Proxy({}, {get: (o, k) => k in o ? o[k] : typeof k === "string" && /^(save|restore|beginPath|moveTo|lineTo|arc|stroke|fill|rect|closePath|translate|rotate|scale|setLineDash|strokeRect|strokeText|fillText)$/.test(k) ? (...a) => calls.push([k, ...a]) : undefined,
    set: (o, k, v) => { o[k] = v; return true; }});
  const b = board([track("t", "A", [[0, 0], [5, 0]]), via("v", "B", 3, 2), part("p", "R1", 10, 0, {"1": "C", "2": "D"})]);
  const list = [{type: "clearance", id: "t", otherId: "v", at: [3, 0], otherAt: [3, 1.7], actual: .1, required: .2, limit: "min"},
    {type: "width", id: "t", at: [1, 0], actual: .1, required: .15, limit: "min"}, {type: "clearance", id: "p", at: [10.5, 0]}];
  M.overlay(b, defs, list, {focused: list[0], unit: "mm"})(ctx, {scale: 60});
  assert.ok(calls.filter(c => c[0] === "arc").length >= 4, "glyph rings and the via");
  assert.ok(calls.some(c => c[0] === "setLineDash" && c[1].length), "dashed detail line");
  assert.ok(calls.some(c => c[0] === "fillText" && /0\.1/.test(c[1])), "value label when zoomed in");
  assert.ok(calls.some(c => c[0] === "rect"), "pad highlight");
  calls.length = 0;
  M.overlay(b, defs, list, {hidden: new Set(["Top"])})(ctx, {scale: 5});
  assert.ok(!calls.some(c => c[0] === "fillText"), "no labels when zoomed out");
  const mutable = list.slice(), draw = M.overlay(b, defs, mutable);
  mutable.length = 0; calls.length = 0; draw(ctx, {scale: 5});
  assert.equal(calls.length, 0, "an unversioned callback follows the current published list");
  // Markers off: no renderer.
  const host = {defs: () => defs, units: () => "mm", invalidate() {}, info() {}};
  assert.ok(M.renderFor(host, b, list));
  M.setVisible(false, host); assert.equal(M.renderFor(host, b, list), null); M.setVisible(true, host);
});

test("zoom to a violation frames its objects", () => {
  const b = board([track("t", "A", [[0, 0], [5, 0]]), via("v", "B", 3, 2)]);
  let box = null;
  const host = {doc: () => b, defs: () => defs, zoomTo: x => { box = x; }};
  assert.ok(M.zoom(host, {type: "clearance", id: "t", otherId: "v", at: [3, 0], otherAt: [3, 2]}));
  assert.ok(box[0] < 0 && box[2] > 5 && box[1] < -.1 && box[3] > 2.3, JSON.stringify(box));
  assert.equal(M.zoom(host, null), false);
});

test("spatial pick matches a full scan, before and after edits", () => {
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const items = [];
  for (let k = 0; k < 2000; k++) { const x = rnd() * 100, y = rnd() * 100; items.push(k % 5 ? track("t" + k, "N" + (k % 40), [[x, y], [x + rnd() * 4, y]], .2) : via("v" + k, "N" + (k % 40), x, y)); }
  const b = board(items), C = globalThis.AtriumNavCommon;
  const boxesOf = () => new Map(b.items.map(i => [i.id, C.itemBox(b, defs, i)]));
  const brute = (boxes, q) => b.items.filter(i => { const x = boxes.get(i.id); return x && q.some(r => C.overlaps(x, r)); }).map(i => i.id);
  let boxes = boxesOf();
  for (let n = 0; n < 20; n++) {
    const x = rnd() * 90, y = rnd() * 90, q = [[x, y, x + 6, y + 6]];
    assert.deepEqual(M.pick(b, boxes, q, null).map(i => i.id), brute(boxes, q));
  }
  // Move some, delete some, add some: only those ids are re-indexed.
  const dirty = new Set();
  for (let k = 0; k < 30; k++) { const t = b.items[k * 7]; if (t.kind === "track") { t.points = t.points.map(p => [p[0] + 20, p[1]]); dirty.add(t.id); } }
  const gone = b.items.splice(100, 5); for (const g of gone) dirty.add(g.id);
  boxes = boxesOf();
  for (let n = 0; n < 20; n++) {
    const x = rnd() * 110, y = rnd() * 90, q = [[x, y, x + 8, y + 8]];
    assert.deepEqual(M.pick(b, boxes, q, dirty).map(i => i.id), brute(boxes, q));
  }
  b.items.push(track("new1", "N1", [[50, 50], [55, 50]])); dirty.clear(); dirty.add("new1");
  boxes = boxesOf();
  assert.ok(M.pick(b, boxes, [[49, 49, 56, 51]], dirty).some(i => i.id === "new1"));
});

test("online DRC with the spatial pick agrees with a full check after edits", () => {
  const items = [];
  for (let k = 0; k < 60; k++) items.push(track("t" + k, "N" + k, [[0, k * .6], [20, k * .6]], .2));
  const b = board(items), rules = R.create();
  const eng = V.online({budget: 1000, maxDirty: 50});
  let r = eng.update(b, defs, rules);
  assert.equal(r.mode, "full");
  // Push one track onto its neighbour: an incremental check finds the new clearance error.
  b.items[10].points = [[0, 6.25], [20, 6.25]];
  r = eng.update(b, defs, rules);
  assert.equal(r.mode, "incremental");
  assert.ok(r.checked < b.items.length / 3, "only the edited region is collected (" + r.checked + ")");
  const full = R.drc(b, defs, rules, {types: eng.types(), limit: 5000});
  const key = v => v.type + ":" + [v.id, v.otherId].sort().join("|");
  assert.deepEqual(r.violations.map(key).sort(), full.violations.map(key).sort());
  assert.ok(r.violations.some(v => v.type === "clearance"));
  assert.ok(!eng.types().includes("delay") && !eng.types().includes("matchedDelays") && !eng.types().includes("length"), "net-wide checks stay in batch DRC");
});

test("severity colour and shape cues: ring for errors, triangle for warnings, dashed ring when waived", () => {
  assert.equal(M.severity({type: "clearance"}), "error");
  assert.equal(M.severity({type: "netAntennae", warning: true}), "warning");
  assert.equal(M.severity({type: "clearance", waived: {id: "w1"}}), "waived");
  assert.notEqual(M.COLORS.error, M.COLORS.warning); assert.notEqual(M.COLORS.warning, M.COLORS.waived);
  const calls = [];
  const ctx = new Proxy({}, {get: (o, k) => k in o ? o[k] : typeof k === "string" && /^(save|restore|beginPath|moveTo|lineTo|arc|stroke|fill|rect|closePath|translate|rotate|scale|setLineDash|strokeRect|strokeText|fillText)$/.test(k) ? (...a) => calls.push([k, ...a]) : undefined,
    set: (o, k, v) => { o[k] = v; if (k === "strokeStyle") calls.push(["strokeStyle", v]); return true; }});
  const b = board([track("t", "A", [[0, 0], [5, 0]]), track("u", "B", [[0, 3], [5, 3]])]);
  M.overlay(b, defs, [{type: "netAntennae", warning: true, id: "t", at: [5, 0]}], {})(ctx, {scale: 60});
  assert.ok(calls.some(c => c[0] === "closePath"), "warnings draw a triangle");
  assert.ok(calls.some(c => c[0] === "strokeStyle" && c[1] === M.COLORS.warning), "in the warning colour");
  assert.ok(!calls.some(c => c[0] === "fillText"), "no value label unless the violation is pinned");
  calls.length = 0;
  M.overlay(b, defs, [], {waived: [{type: "clearance", id: "u", otherId: "t", at: [2, 3], waived: {id: "w"}}]})(ctx, {scale: 60});
  assert.ok(calls.some(c => c[0] === "setLineDash" && c[1].length), "waived markers are dashed");
  assert.ok(calls.some(c => c[0] === "strokeStyle" && c[1] === M.COLORS.waived));
  calls.length = 0;
  const list = [{type: "clearance", id: "t", otherId: "u", at: [2, 0], otherAt: [2, 3], actual: .1, required: .2, limit: "min"}];
  M.overlay(b, defs, list, {hover: list[0]})(ctx, {scale: 60});
  assert.ok(!calls.some(c => c[0] === "fillText"), "hovering only emphasises: no text on the board");
});

test("status-bar line: rule, actual < required, short object names, no pop-up", () => {
  const v = {type: "clearance", ruleName: "Clearance", id: "a", otherId: "b", title: "Pad U1-3 (Top Layer) VCC ↔ Track (Top Layer) GND", actual: .12, required: .2, limit: "min", at: [1, 2]};
  assert.equal(M.statusText(v, "mm"), "Clearance 0.12 < 0.2 mm · U1.3 ↔ Track GND · click for details");
  assert.equal(M.statusText(v, "mm", {hint: false}), "Clearance 0.12 < 0.2 mm · U1.3 ↔ Track GND");
  assert.match(M.statusText({...v, limit: "max", actual: .5, required: .3}, "mil"), /19\.685 > 11\.811 mil/);
  assert.match(M.statusText({type: "short", detail: "Short circuit between nets A, B", title: "Track (Top) A ↔ Track (Top) B"}), /^Short.*Short circuit between nets A, B · Track A ↔ Track B/);
  assert.match(M.statusText({...v, waived: {id: "w"}}), /^Waived · Clearance/);
  assert.equal(M.shortObject("Via (Top–Bottom) GND"), "Via GND");
  assert.equal(M.statusText(null), "");
  // Headless: hovering and the default click mode never build DOM.
  // A marker exposes its measurements through the status line even with an old hover preference.
  const host = {tool: () => "select", units: () => "mm", info() {}, liveRoute: () => null, drag: () => null};
  M.hovered(host, v, {clientX: 0, clientY: 0}); M.hovered(host, null);
  assert.equal(M.clicked(host, v, {clientX: 0, clientY: 0}), true, "a click on a marker opens the inspector and is taken");
});

test("fly to a violation: AtriumCamera when present, else a jump with at least 4 mm in view", () => {
  const b = board([track("t", "A", [[0, 0], [1, 0]]), via("v", "B", .5, .5)]);
  let box = null;
  const host = {doc: () => b, defs: () => defs, zoomTo: x => { box = x; }};
  const v = {type: "clearance", id: "t", otherId: "v", at: [.5, 0], otherAt: [.5, .2]};
  assert.ok(M.fly(host, v));
  assert.ok(box[2] - box[0] >= 4 - 1e-9 && box[3] - box[1] >= 4 - 1e-9, JSON.stringify(box));
  let flown = null; globalThis.AtriumCamera = {flyTo: (x, o) => { flown = [x, o]; }};
  const view = {camera: () => ({cx: 0, cy: 0, scale: 10})};
  box = null; assert.ok(M.fly({...host, view: () => view, canvas: () => ({clientWidth: 800, clientHeight: 600})}, v));
  assert.equal(box, null, "the camera flies; no jump");
  assert.ok(flown && Number.isFinite(flown[0].cx) && Number.isFinite(flown[0].scale) && flown[1].view === view, JSON.stringify(flown));
  delete globalThis.AtriumCamera;
  assert.equal(M.fly(host, null), false);
});

test("online DRC from the undo store's change journal equals re-signing and a full check, over random edits", () => {
  require("../../app/history/undo-store.js");
  const U = globalThis.AtriumUndoStore;
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647, pickOf = a => a[Math.floor(rnd() * a.length)];
  const items = [];
  for (let k = 0; k < 240; k++) {
    const x = (k % 20) * 2.2, y = Math.floor(k / 20) * 2.2;
    items.push(k % 6 === 0 ? part("p" + k, "R" + k, x, y, {"1": "N" + (k % 9), "2": "N" + ((k + 1) % 9)}) : k % 3 ? track("t" + k, "N" + (k % 9), [[x, y], [x + 1.6, y + .4]], .2) : via("v" + k, "N" + (k % 9), x, y));
  }
  items.push({id: "kg", kind: "graphic", layer: "Top", net: "N1", width: .2, keepout: true, points: [[0, .25], [40, .25]]});
  let project = {format: "atrium", name: "P", library: [], documents: [board(items)]};
  U.reset();
  const history = [], future = [], doc = () => project.documents[0], rules = R.create();
  const edit = fn => { const before = U.mark(project, {current: "b1"}); const r = fn(doc()); if (r) project = r; U.checkpoint(history, future, before, ""); U.touch(project); };
  const go = n => { const here = U.mark(project, {current: "b1"}), t = U.jump(history, future, here, n); if (t) { project = U.root(); U.touch(project); } };
  const tracked = V.online({budget: 1000, maxDirty: 60}), signed = V.online({budget: 1000, maxDirty: 60});
  const key = v => JSON.stringify([v.type, v.id, v.otherId, v.at, v.otherAt, v.actual]);
  // Shorts come from connectivity over whole islands, which a neighbourhood sub-board can cut (online DRC
  // already differs from batch DRC there, with or without the journal); every other local rule must match.
  const local = v => v.type !== "short";
  const check = label => {
    const from = tracked.at(), ch = U.changed(doc(), from);
    const a = tracked.update(doc(), defs, rules, {from, to: ch.seq, ids: ch.ids, items: ch.items}), b = signed.update(doc(), defs, rules);
    assert.deepEqual(a.violations.map(key), b.violations.map(key), label + ": same result as re-signing every object");
    assert.equal(a.mode, b.mode, label);
    const full = R.drc(doc(), defs, rules, {types: tracked.types(), limit: 5000});
    assert.deepEqual(a.violations.filter(local).map(key).sort(), full.violations.filter(local).map(key).sort(), label + ": same violations as a full check");
    return a;
  };
  check("first");
  let n = 0, used = 0;
  const ops = {
    move: d => { const i = pickOf(d.items); if (i.points) i.points = i.points.map(q => [q[0] + (rnd() - .5) * 3, q[1] + (rnd() - .5) * 3]); else { i.x += (rnd() - .5) * 3; i.y += (rnd() - .5) * 3; } },
    remove: d => { d.items.splice(Math.floor(rnd() * d.items.length), 1 + Math.floor(rnd() * 3)); },
    add: d => { const x = rnd() * 44, y = rnd() * 26; d.items.push(rnd() < .5 ? via("nv" + (++n), "N" + (n % 9), x, y) : track("nt" + (++n), "N" + (n % 9), [[x, y], [x + 2, y]], .2)); },
    width: d => { const i = pickOf(d.items.filter(x => x.kind === "track")); if (i) i.width = pickOf([.05, .1, .2, .4]); },
    net: d => { const i = pickOf(d.items.filter(x => x.kind !== "part")); i.net = "N" + Math.floor(rnd() * 9); },
    label: d => { const i = pickOf(d.items); i.note = "n" + rnd(); },                       // a field DRC does not read
    keepout: d => { const g = d.items.find(x => x.id === "kg"); if (g) g.keepout = !g.keepout; }, // a field outside any field list
    replaceList: d => { d.items = d.items.slice(); d.items[0] = {...d.items[0], width: .3}; },
    open: () => JSON.parse(JSON.stringify(project)),                                     // project replaced: falls back to re-signing
  };
  const names = Object.keys(ops), weights = {move: 6, remove: 2, add: 2, width: 2, net: 2, label: 1, replaceList: 1, open: .3};
  const total = names.reduce((s, k) => s + weights[k], 0);
  for (let step = 0; step < 160; step++) {
    const roll = rnd();
    if (roll < .15 && history.length) go(-1 - Math.floor(rnd() * 3));
    else if (roll < .25 && future.length) go(1 + Math.floor(rnd() * 2));
    else { let w = rnd() * total, op = names[0]; for (const k of names) { w -= weights[k]; if (w <= 0) { op = k; break; } } edit(ops[op]); }
    if (rnd() < .2) continue;                                                            // sometimes two edits before a check
    if (check("step " + step).tracked) used++;
  }
  assert.ok(used > 60, "most checks use the journal (" + used + ")");
  // A small edit on the tracked path re-signs only what changed.
  check("before the last edit");
  const d = doc(), i = d.items.find(x => x.kind === "via");
  edit(() => { i.x += .5; });
  const from = tracked.at(), ch = U.changed(d, from);
  assert.deepEqual([...ch.ids], [i.id]);
  assert.equal(tracked.update(d, defs, rules, {from, to: ch.seq, ids: ch.ids, items: ch.items}).tracked, true);
  // A hint from another position (the engine missed a change) is ignored: every object is re-signed.
  assert.equal(tracked.update(d, defs, rules, {from: from - 1, to: ch.seq, ids: new Set(), items: new Map()}).tracked, false);
  U.reset();
});

test("online DRC sees a change to any field: a keepout turned off over a track (journal and fallback)", () => {
  for (const tracked of [true, false]) {
    const t = track("t1", "A", [[5, 10], [45, 10]]), g = {id: "g1", kind: "graphic", layer: "Top", net: "B", width: .2, keepout: true, points: [[5, 10.25], [45, 10.25]]};
    const b = board([t, g]), rules = R.defaults(), eng = V.online({budget: 1000});
    const clear = list => list.filter(v => v.type === "clearance").length, batch = () => clear(R.drc(b, defs, rules, {}).violations);
    eng.update(b, defs, rules, tracked ? {from: 0, to: 0, ids: new Set(), items: new Map()} : undefined);
    g.keepout = false;
    const r = eng.update(b, defs, rules, tracked ? {from: 0, to: 1, ids: new Set(["g1"]), items: new Map([["g1", g]])} : undefined);
    assert.equal(batch(), 1);
    assert.equal(clear(r.violations), 1, (tracked ? "journal" : "fallback") + " path finds the clearance violation");
    assert.equal(r.tracked, tracked);
  }
});

test("ERC and DRC share one status slot; empty space clears only the owning source", () => {
  const ERC = "synthetic ERC unconnected pin", DRC = "synthetic DRC clearance", made = [];
  const node = () => ({hidden: false, textContent: "", className: "", parent: null, get isConnected() { return this.parent != null; }});
  const status = node(); status.id = "status"; status.textContent = "Ready"; status.parent = {children: [status]};
  status.before = child => { child.parent = status.parent; };
  const bar = {on: false, classList: {toggle(name, force) { bar.on = force; }}};
  const saved = globalThis.document;
  globalThis.document = {
    getElementById: id => id === "status" ? status : null,
    querySelector: sel => sel === ".statusbar" ? bar : sel === ".status-drc-hover" ? made.find(n => n.className === "status-drc-hover") || null : null,
    createElement() { const n = node(); made.push(n); return n; },
    addEventListener() {},
  };
  try {
    require("../../app/schematic/sch-markers.js");
    const slot = () => globalThis.document.querySelector(".status-drc-hover");
    let leaveSheet; globalThis.AtriumSchMarkers.attach({addRenderer() {}, invalidate() {}, on(ev, fn) { if (ev === "document") leaveSheet = fn; }});
    globalThis.AtriumProblemMarks.hoverStatus("erc", ERC);
    M.setLine(null);
    assert.equal(slot().textContent, ERC, "DRC exit while ERC owns leaves the ERC message");
    M.setLine(DRC);
    leaveSheet();
    assert.equal(slot().textContent, DRC, "ERC exit while DRC owns leaves the DRC message");
    assert.equal(slot().hidden, false);
    assert.equal(bar.on, true);
    M.setLine(null);
    assert.equal(slot().textContent, "");
    assert.equal(slot().hidden, true);
    assert.equal(bar.on, false);
    assert.equal(made.length, 1, "one hover status node");
    assert.equal(status.textContent, "Ready");
  } finally { globalThis.document = saved; }
});

test("dense problem hover reuses the current marker boxes without walking the board", () => {
  const nearby = Array.from({length: 96}, (_, i) => track("near-" + i, "N", [[-.5, i / 200], [.5, i / 200]], .02));
  const distant = Array.from({length: 260}, (_, i) => track("distant-" + i, "N", [[1 + i, 100], [1.5 + i, 100]], .02));
  const items = nearby.concat(distant, Array.from({length: 11000 - nearby.length - distant.length}, (_, i) =>
    ({kind:"graphic", id:"body-" + i, layer:"Mechanical", points:[[100 + i, 100], [101 + i, 100]], width:.1})));
  const d = board(items), project = {library: [], documents: [d]}, U = AtriumUndoStore;
  d.ruleCheckSelection = {batch: Object.keys(R.types).filter(type => type !== "width")};
  const canvas = {getBoundingClientRect: () => ({left: 0, top: 0, width: 900, height: 700})};
  const pane = {docId:d.id, canvas, view:{scale: () => 1, worldToScreen: ([x,y]) => [x+400,y+300]}};
  let drag = null, hidden = null;
  const host = {doc: () => d, project: () => project, panes: () => [pane], defs: () => defs, revision: () => 1,
    connections: () => null, units: () => "mm", hiddenLayers: () => hidden, drag: () => drag,
    info() {}, registerAction() {}, addRenderer() {}, invalidate() {}};
  U.reset(); U.record(project); V.attach(host);
  assert.equal(V.run().violations.length, nearby.length + distant.length);
  const saved = {document:globalThis.document, hover:globalThis.AtriumCanvasHover, host:globalThis.AtriumNavHost};
  const groupAt = V.groupAt, iterate = items[Symbol.iterator];
  globalThis.document = {body:{}, addEventListener() {}};
  globalThis.AtriumCanvasHover = {register() {}};
  globalThis.AtriumNavHost = host;
  try {
    require("../../app/checks/problem-hover.js");
    const hover = AtriumProblemHover, hit = () => hover._find(pane, 400, 300);
    const group = V.groupAt(pane, 400, 300);
    assert.equal(group.members.length, nearby.length, "the published violations must share the picked marker");
    const expected = group.members.map(v => M.box(d, defs, v));
    let walks = 0;
    items[Symbol.iterator] = function () { walks++; return iterate.call(this); };
    const found = hit();
    assert.ok(hover.over(canvas, 400, 300));
    assert.equal(hover.over(canvas, 740, 640), false);
    assert.deepEqual(found.entries.map(e => e.raw), group.members);
    assert.ok(found.entries.every(e => e.severity === "error"));
    assert.deepEqual(found.boxes, expected, "card placement uses the same full object bounds");
    assert.equal(walks, 0, "a warmed hit and its card never re-index the PCB");

    let reads = 0;
    V.groupAt = (...args) => {
      const g = groupAt(...args);
      return g && {v:g.v, at:g.at, members:g.members, get boxes() { reads++; return g.boxes; }};
    };
    const lazy = hit();
    assert.ok(hover.over(canvas, 400, 300));
    assert.equal(reads, 0, "priority-only hits defer card geometry");
    assert.deepEqual(lazy.boxes, expected);
    assert.equal(reads, 1);

    V.groupAt = (...args) => {
      const g = groupAt(...args);
      return g && {v:g.v, at:g.at, members:g.members};
    };
    assert.deepEqual(hit().boxes, expected, "a producer without resolved boxes still supplies card placement");
    V.groupAt = groupAt;
    const points = nearby[0].points;
    nearby[0].points = [[-4, 0], [4, 0]];
    drag = {before:{}, item:nearby[0]};
    assert.deepEqual(hit().boxes, group.members.map(v => M.box(d, defs, v)), "use the current preview geometry");
    nearby[0].points = points; drag = null;
    assert.deepEqual(hit().boxes, expected, "a cancelled preview retires its bounds");
    const before = U.mark(project), history = [], future = [];
    U.checkpoint(history, future, before, "Change track");
    nearby[0].points = [[-6, 0], [6, 0]];
    U.record(project);
    assert.equal(hit(), null, "a board edit invalidates the old published hit");
    V.run();
    assert.ok(hit().boxes.some(b => b[0] < -5), "the republished hit uses the edited track box");
    assert.ok(U.jump(history, future, U.mark(project), -1));
    V.run();
    assert.deepEqual(hit().boxes, expected, "Undo restores the full placement geometry");
    host.selectable = item => item !== nearby[0];
    const filtered = hit();
    assert.equal(filtered.entries.length, nearby.length - 1);
    assert.deepEqual(filtered.boxes, filtered.entries.map(e => M.box(d, defs, e.raw)), "dimmed rows do not affect the card's placement");
    hidden = new Set(["Top"]);
    assert.equal(hit(), null, "hidden copper cannot claim hover");
  } finally {
    V.groupAt = groupAt;
    delete items[Symbol.iterator];
    globalThis.document = saved.document;
    globalThis.AtriumCanvasHover = saved.hover;
    globalThis.AtriumNavHost = saved.host;
    U.reset();
  }
});

console.log(passed + " drc-markers tests passed");
