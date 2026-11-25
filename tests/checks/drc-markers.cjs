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
  assert.deepEqual(draw(list,{publication}),draw([first,...filler]),"equal severity leaves the first marker in its exact cell");
  const clip = [-3,-3,80,10], clipped = list.filter(v => v.at[0] <= clip[2]);
  assert.deepEqual(draw(list,{publication},24,clip),draw(clipped,{},24,clip),"clip and zoom still select the exact visible rows");
  const pane = {docId:b.id,canvas:{getBoundingClientRect:()=>({left:0,top:0})},
    view:{scale:()=>14,worldToScreen:([x,y])=>[x*14,y*14]}};
  const host = {doc:()=>b,defs:()=>lib,revision:()=>1};
  assert.equal(M.markerAt(host,pane,list,14,14,null,publication),first);
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

    assert.equal(draw(sparse), true);
    assert.equal(pick(sparse, warning.at).v, warning, "the detail control is painted and pickable");
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
      area: union, damageRects, scale: 10, worldViewport: rect => rect || union,
      worldToScreen: ([x, y]) => [x * 10, y * 10]
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

console.log(passed + " drc-markers tests passed");
