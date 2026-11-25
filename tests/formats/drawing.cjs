"use strict";
// Drawing documents (app/formats/drawing.js, app/formats/drawing-views.js): the stored form and model validation,
// the starting layout, live views and dimensions (they follow board edits), operations, title
// block parameters, and vector PDF output with an embedded Unicode font (structure, page size,
// path counts), tiling at 1:1, Smart PDF and output jobs. Section and detail views, break lines,
// staggered ordinates, vias matched by ID/position/net, sheet text and lines, the Print dialog's
// 1:1 tiling, and a PDF golden (tests/goldens/drawing/sample.json; --emit prints a new one).
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "connectivity", "pcb-appearance", "pcb-pours", "stackup", "sch-appearance", "vectorize", "pcb-text-rich", "pcb-text", "canvas", "zip",
  "board-shape", "variants", "fab-outputs", "bom", "rigid-flex", "step-export", "path-record", "pdf", "vendor/dejavu-sans", "pdf-fonts", "print",
  "drawing-views", "drawing", "output-jobs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, DR = AtriumDrawing, DV = AtriumDrawingViews, P = AtriumPDF;
const date = new Date(Date.UTC(2026, 10, 19));
const clone = v => JSON.parse(JSON.stringify(v));
const latin = b => { let s = ""; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192)); return s; };

const base = AtriumParts.example();
base.parameters = {CompanyName: "Waffle Labs", DocumentNumber: "PRJ-7"};
const board = base.documents.find(d => d.kind === "pcb");

// Native projections can omit empty collections. Views remain usable and a
// blank document's displayed sheet ID survives the first edit.
{
  const p = clone(base), d = A.sheet("drawing", "Sparse drawing");
  p.documents.push(d);
  d.drawing = {board:board.id,sheets:[{id:"paper",name:"Fabrication",size:"A4",orientation:"landscape"}],
    views:[{id:"view",sheet:"paper",type:"board",x:12,y:8,scale:1}]};
  const original = clone(d.drawing), summary = DR.summary(p,d);
  assert.equal(summary.sheets[0].views[0].id,"view");
  assert.deepEqual(summary.sheets[0].dimensions,[]);
  assert.equal(summary.notes,0);
  assert.deepEqual(d.drawing,original,"inspection does not write defaults to the document");
  delete d.drawing;
  const sheet = DR.summary(p,d).sheets[0].id;
  assert.equal(DR.summary(p,d).sheets[0].id,sheet);
  DR.apply(p,d,[{op:"set_sheet",sheet,name:"Assembly"}]);
  assert.equal(d.drawing.sheets[0].name,"Assembly");
  assert.equal(d.drawing.sheets[0].id,sheet);
}

// ---- stored form: normalize repairs, validate refuses unreadable structure ----
{
  const n = DR.normalize({sheets: [{size: "B9"}], views: [{type: "nope"}, {type: "board", scale: -2, x: "a"}], dimensions: [{type: "linear", view: "x"}]});
  assert.equal(n.sheets.length, 1); assert.equal(n.sheets[0].size, "A3");
  // A view type from a newer Waffle is kept as it is (forward compatibility), not dropped.
  assert.equal(n.views.length, 2); assert.equal(n.views[0].type, "nope"); assert.equal(n.views[1].scale, 1); assert.equal(n.views[1].x, 20);
  assert.equal(n.dimensions.length, 0, "a dimension on a missing view is dropped");
  assert.throws(() => DR.validate({sheets: {}}), /not a supported/);
  assert.throws(() => DR.validate({version: 9}), /newer version/);
  assert.equal(DR.validate(n), true);
  assert.deepEqual(DR.normalize(n), n, "normalize is stable");
}

// ---- create: a full drawing on the sample board ----
const project = clone(base);
const doc = DR.create(project, {name: "Sensor drawing", date});
project.documents.push(doc);
const D = doc.drawing;
assert.equal(doc.kind, "drawing"); assert.deepEqual(doc.items, []);
assert.deepEqual(D.sheets.map(s => s.name), ["Fabrication", "Assembly"]);
assert.deepEqual(doc.sheet, {size: "A3", orientation: "landscape", titleBlock: "none"}, "the editor's sheet under sheet 1 matches it");
const types = D.views.map(v => v.type);
for (const t of ["board", "drill-table", "layer-stack", "notes", "revisions", "assembly", "bom", "isometric"]) assert(types.includes(t), t);
assert.equal(D.notes.length, 4); assert.equal(D.revisions[0].rev, "A"); assert.equal(D.revisions[0].date, "2026-11-19");
assert.equal(D.callouts.length, 1);

// Saving and loading: model validation accepts drawings and still accepts old projects.
assert.doesNotThrow(() => A.validate(JSON.parse(JSON.stringify(project))));
assert.doesNotThrow(() => A.validate(clone(base)), "projects without drawings are unchanged");
{
  const bad = clone(project); bad.documents.at(-1).items.push({id: "x", kind: "wire", points: [[0, 0], [1, 1]]});
  assert.throws(() => A.validate(bad), "a drawing holds no design items");
  const bad2 = clone(project); bad2.documents.at(-1).drawing = 5;
  assert.throws(() => A.validate(bad2));
}

// ---- live dimensions ----
let s = DR.summary(project, doc, {date});
assert.deepEqual(s.problems, []);
const e0 = A.bounds(board.outline);
const [wDim, hDim, rDim] = s.sheets[0].dimensions;
assert.equal(wDim.value, +(e0[2] - e0[0]).toFixed(4)); assert.equal(hDim.value, +(e0[3] - e0[1]).toFixed(4));
assert.equal(rDim.type, "radial"); assert(rDim.value > 0 && rDim.resolved);
// The board grows by 4 mm: the overall width follows; the drawing is untouched.
const b2 = project.documents.find(d => d.kind === "pcb");
const maxX = Math.max(...b2.outline.map(p => p[0]));
b2.outline = b2.outline.map(p => p[0] === maxX ? [p[0] + 4, p[1]] : p);
delete b2.boardShape;
s = DR.summary(project, doc, {date});
assert.equal(s.sheets[0].dimensions[0].value, +(e0[2] - e0[0] + 4).toFixed(4), "dimensions update when the board changes");
// The dimensioned hole is deleted: the dimension keeps its last position and reports it.
const hole = D.dimensions.find(m => m.type === "radial").a;
const owner = b2.items.find(i => i.kind === "part" && i.ref === hole.ref) || null;
if (owner) {
  b2.items = b2.items.filter(i => i !== owner);
  s = DR.summary(project, doc, {date});
  const r = s.sheets[0].dimensions.find(m => m.type === "radial");
  assert.equal(r.resolved, false);
  assert(s.problems.some(m => /board feature is gone/.test(m)));
  b2.items.push(owner);
}

// ---- operations ----
{
  const p = clone(project), d = DR.drawingOf(p, "Sensor drawing");
  const view = d.drawing.views.find(v => v.type === "board");
  const res = DR.apply(p, d, [
    {op: "add_sheet", name: "Details", size: "A4", orientation: "portrait"},
    {op: "add_view", type: "assembly", side: "Bottom", sheet: "Details", scale: 2},
    {op: "set_view", id: view.id, x: 40, y: 30, scale: 4, options: {drillSymbols: false}},
    {op: "add_dimension", view: view.id, type: "linear", a: "corner:tl", b: "corner:br", axis: "aligned", offset: 5, precision: 1, text: "<> REF"},
    {op: "add_dimension", view: view.id, type: "ordinate", a: "corner:bl", points: ["corner:br", "corner:tr"], axis: "y"},
    {op: "add_dimension", view: view.id, type: "linear", a: [e0[0], e0[1]], b: "vertex:1"},
    {op: "add_note", text: "Countersink ⌀6.0 × 90°."},
    {op: "add_callout", note: 5, view: view.id, at: "corner:br", x: 300, y: 150},
    {op: "add_revision", rev: "B", date: "2026-12-01", description: "Second release", by: "YX"},
    {op: "set_parameters", parameters: {Title: "Sensor PCB", DrawnBy: "YX", CompanyName: ""}},
    {op: "rename", name: "Fab"}]);
  assert.equal(res.length, 11);
  assert.equal(d.name, "Fab");
  assert.equal(d.drawing.sheets.length, 3);
  assert.equal(d.drawing.views.at(-1).sheet, d.drawing.sheets[2].id);
  const moved = d.drawing.views.find(v => v.id === view.id);
  assert.equal(moved.scale, 4); assert.equal(moved.options.drillSymbols, false); assert.equal(moved.x, 40);
  const aligned = res[3]; assert(aligned.resolved && aligned.value > Math.max(e0[2] - e0[0], e0[3] - e0[1]), "aligned diagonal");
  assert.deepEqual(res[4].value.length, 3); assert.equal(res[4].value[0], 0);
  assert.equal(d.drawing.dimensions.at(-1).a.k, "corner", "a board point snaps to the feature there");
  assert.equal(res[7].number, 5);
  // Title block: drawing parameters win, project parameters fill the rest, the last revision shows.
  const ctx = DR.contextFor(p, d, {date}), f = DV.titleFields(ctx, 0);
  assert.equal(f.title, "Sensor PCB"); assert.equal(f.drawn, "YX"); assert.equal(f.number, "PRJ-7"); assert.equal(f.company, "Waffle Labs");
  assert.equal(f.revision, "B"); assert.equal(f.scale, "4:1"); assert.equal(f.sheet, "1 of 3"); assert.equal(f.size, "A3");
  // Removing a view removes its dimensions and callouts on the next normalize.
  DR.apply(p, d, [{op: "remove", id: view.id}]);
  assert(!d.drawing.dimensions.some(m => m.view === view.id));
  assert(!d.drawing.callouts.some(c => c.view === view.id));
  assert.throws(() => DR.apply(p, d, [{op: "remove", id: d.drawing.sheets[0].id}, {op: "remove", id: d.drawing.sheets[1].id}, {op: "remove", id: d.drawing.sheets[2].id}]), /at least one sheet/);
  assert.equal(d.drawing.sheets.length, 3, "a failed call changes nothing");
  assert.throws(() => DR.apply(p, d, [{op: "add_view", type: "nope"}]), /Unknown view type/);
  assert.throws(() => DR.apply(p, d, [{op: "frobnicate"}]), /Unknown drawing operation/);
  const tableView = d.drawing.views.find(v => v.type === "drill-table");
  assert.throws(() => DR.apply(p, d, [{op: "add_dimension", view: tableView.id, type: "linear", a: "corner:tl", b: "corner:tr"}]), /board, assembly or detail view/);
  assert.equal(DR.summary(p, d).untrusted_design_text.notes.at(-1), "Countersink ⌀6.0 × 90°.");
}

// ---- views: tables read the board ----
{
  const ctx = DR.contextFor(project, doc, {date}), G = ctx.geometry({});
  assert(G.holes.length > 0 && G.drill.length > 0);
  assert.equal(G.drill.reduce((n, g) => n + g.count, 0), G.holes.length, "the drill table counts every hole");
  const drill = DV.tableOf(D.views.find(v => v.type === "drill-table"), ctx);
  assert.equal(drill.rows.length, G.drill.length); assert.equal(drill.rows[0][0], 0, "symbol 0 for the smallest size");
  const stack = DV.tableOf(D.views.find(v => v.type === "layer-stack"), ctx);
  assert(stack.rows.some(r => r[3] === "Copper")); assert.equal(stack.foot[4], G.thickness.toFixed(3));
  const bom = DV.tableOf(D.views.find(v => v.type === "bom"), ctx);
  assert(bom.rows.length >= 5 && bom.head.includes("Designator"));
  const iso = ctx.iso({});
  assert(iso && iso.triangles > 50, "isometric from the 3D model");
  // Bottom assembly views are mirrored.
  const F = DV.frame({type: "assembly", side: "Bottom", x: 0, y: 0, scale: 1}, G), e = G.extents;
  assert.deepEqual(F.map([e[0], e[1]]), [e[2] - e[0], 0]);
}

// ---- PDF: one page per sheet at the sheet size, embedded font, vector content ----
{
  const r = DR.build(project, {date, compress: false});
  assert.equal(r.pages.length, 2);
  assert(r.pages.every(p => Math.abs(p.w - 420 * 72 / 25.4) < .01 && Math.abs(p.h - 297 * 72 / 25.4) < .01), "A3 landscape pages");
  const c0 = P.counts(r.pages[0].list), c1 = P.counts(r.pages[1].list);
  assert(c0.paths > 50, "fabrication sheet line work: " + c0.paths); assert(c0.text > 80, "text: " + c0.text);
  assert(c1.paths > 200, "assembly sheet and isometric: " + c1.paths);
  const bytes = r.bytes({compress: false}), t = latin(bytes);
  assert.match(t, /^%PDF-1\.4/); assert.match(t, /%%EOF\n$/);
  assert.equal((t.match(/\/Type \/Page /g) || []).length, 2);
  assert.match(t, /\/MediaBox \[0 0 1190\.55 841\.89\]/);
  assert.match(t, /\/Subtype \/Type0 \/BaseFont \/[A-Z]{6}\+DejaVuSans \/Encoding \/Identity-H/, "embedded Unicode font");
  assert.match(t, /\/FontFile2 \d+ 0 R/); assert.match(t, /\/ToUnicode \d+ 0 R/);
  assert.doesNotMatch(t, /\/Subtype \/Type1/, "no standard-14 fonts");
  const font = AtriumPDFFonts.font(), dia = font.gid(0x2300).toString(16).toUpperCase().padStart(4, "0");
  assert(t.includes("<" + dia + "> <2300>"), "⌀ in the radial dimension maps back to Unicode");
  const content = t.slice(t.indexOf("stream\n1 0 0 -1 0"), t.indexOf("endstream", t.indexOf("stream\n1 0 0 -1 0")));
  assert((content.match(/ l\n/g) || []).length > 100, "vector lines in the page content");
  assert((content.match(/> Tj ET/g) || []).length > 50, "text as glyph strings");
  assert.match(t, /\/Outlines \d+ 0 R/, "bookmarks per sheet");
  assert.deepEqual(DR.build(project, {date}).bytes(), DR.build(project, {date}).bytes(), "deterministic");
  // Tiling at 1:1 onto smaller paper.
  const tiled = DR.build(project, {date, paper: "A4"});
  assert(tiled.pages.length >= 4 && tiled.pages.every(p => p.tile), "A3 sheets tiled over A4");
  assert(tiled.notes.some(n => /tiled at 1:1/.test(n)));
  assert.equal(DR.build(project, {date, paper: "A3"}).pages.length, 2, "paper as large as the sheet: no tiling");
}

// ---- Smart PDF (print.js) includes drawing sheets; output jobs have a drawing kind ----
{
  const r = AtriumPrint.build(project, {date, layerSets: ["top"], paper: "A3"});   // A3 sheets on A3 paper: one page each
  const kinds = r.pages.map(p => p.kind);
  assert.deepEqual(kinds.filter(k => k === "drawing").length, 2);
  assert(r.pages.filter(p => p.kind === "drawing").every(p => /Sensor drawing — /.test(p.title)));
  assert.equal(AtriumPrint.build(project, {date, layerSets: ["top"], drawings: false}).pages.filter(p => p.kind === "drawing").length, 0);
  const OJ = AtriumOutputJobs;
  assert(OJ.KINDS.drawing && OJ.ORDER.includes("drawing"));
  const run = OJ.run(project, {name: "Docs", folder: "", outputs: [{kind: "drawing", options: {}}]}, {date, revision: "A"});
  const row = run.report.outputs[0];
  assert.equal(row.status, "ok", row.message);
  assert.equal(run.files.length, 1); assert.match(run.files[0].name, /Drawings\.pdf$/);
  assert.match(latin(run.files[0].data.subarray(0, 8)), /^%PDF/);
  const none = OJ.run(clone(base), {name: "Docs", folder: "", outputs: [{kind: "drawing", options: {}}]}, {date});
  assert.equal(none.report.outputs[0].status, "skipped");
}
// ---- linked views: section and detail views of a board view, with letters ----
{
  const p = clone(project), d = DR.drawingOf(p, "Sensor drawing"), view = d.drawing.views.find(v => v.type === "board");
  const ctx0 = DR.contextFor(p, d, {date}), G = ctx0.geometry(view), e = G.extents, h = G.holes.find(x => x.plated && x.d > .5) || G.holes[0];
  const res = DR.apply(p, d, [
    {op: "add_view", type: "section", parent: view.id, a: [e[0] - 2, h.at[1]], b: [e[2] + 2, h.at[1]], x: 30, y: 200},
    {op: "add_view", type: "detail", parent: view.id, center: h.at, radius: 3, x: 300, y: 150}]);
  assert.equal(res[0].label, "A"); assert.equal(res[1].label, "B", "each linked view gets its own letter");
  const D2 = d.drawing, sec = D2.views.find(v => v.id === res[0].id), det = D2.views.find(v => v.id === res[1].id);
  assert.equal(sec.scale, view.scale, "a section keeps its parent's scale"); assert(sec.options.zscale >= 1);
  assert(det.scale >= view.scale * 2.5 - 1e-9 && DV.SCALES.includes(det.scale), "a detail magnifies on a standard scale");
  const ctx = DR.contextFor(p, d, {date}), S = DV.sectionOf(sec, ctx);
  assert(S.solid.length >= 2, "the cut through a hole splits the board: " + JSON.stringify(S.solid));
  const cut = S.cuts.find(c => Math.abs((c.t0 + c.t1) / 2 - (h.at[0] - (e[0] - 2))) < 1e-6);
  assert(cut && Math.abs(cut.t1 - cut.t0 - h.d) < 1e-6 && cut.plated === h.plated, "the hole on the cutting line is cut at its full diameter");
  assert(Math.abs(S.T - G.thickness) < 1e-9 && S.layers.length > 2, "the section shows the layer stack");
  const sb = DV.box(sec, ctx); assert(Math.abs(sb[2] - sb[0] - S.L * sec.scale) < 1e-6);
  const db = DV.box(det, ctx); assert(Math.abs(db[2] - db[0] - 6 * det.scale) < 1e-6);
  const F = DV.frame(det, G, ctx), q = F.map(h.at);
  assert(Math.abs(q[0] - (det.x + 3 * det.scale)) < 1e-6 && Math.abs(q[1] - (det.y + 3 * det.scale)) < 1e-6, "the detail centres its circle");
  // Dimensions attach to a detail view; sections are profiles (no board anchors).
  const r2 = DR.apply(p, d, [{op: "add_dimension", view: det.id, type: "radial", a: h.ref != null ? "hole:" + h.ref + "." + h.pin : h.at}]);
  assert(r2[0].resolved && Math.abs(r2[0].value - h.d) < 1e-9, "a radial dimension in the detail view");
  assert.throws(() => DR.apply(p, d, [{op: "add_dimension", view: sec.id, type: "linear", a: "corner:tl", b: "corner:tr"}]), /board, assembly or detail view/);
  const sum = DR.summary(p, d, {date});
  assert.deepEqual(sum.problems, []);
  const views = sum.sheets[0].views;
  assert.equal(views.find(v => v.id === sec.id).label, "A"); assert.equal(views.find(v => v.id === det.id).parent, view.id);
  // Letters stay put; a third linked view takes the next free letter, a duplicate is renamed.
  const r3 = DR.apply(p, d, [{op: "add_view", type: "detail", parent: view.id, center: [e[0] + 2, e[1] + 2], radius: 2, label: "A"}]);
  assert.equal(r3[0].label, "C");
  assert.equal(d.drawing.views.find(v => v.id === sec.id).label, "A");
  // The PDF: both views paint (cut hatching, barrels, magnified content) without problems.
  const pdf = DR.build(p, {date});
  assert.deepEqual(pdf.notes, []);
  assert(P.counts(pdf.pages[0].list).paths > P.counts(DR.build(project, {date}).pages[0].list).paths + 20, "section and detail line work on the sheet");
  // Removing the parent view removes the views taken from it.
  DR.apply(p, d, [{op: "remove", id: view.id}]);
  assert(!d.drawing.views.some(v => v.type === "section" || v.type === "detail"));
  assert.throws(() => DR.apply(p, d, [{op: "add_view", type: "section", parent: d.drawing.views.find(v => v.type === "bom").id, a: [0, 0], b: [1, 0]}]), /board or assembly view/);
}

// ---- break lines: a long board view shortened; dimensions keep their true value ----
{
  const p = clone(project), d = DR.drawingOf(p, "Sensor drawing"), view = d.drawing.views.find(v => v.type === "board");
  const ctx0 = DR.contextFor(p, d, {date}), G = ctx0.geometry(view), e = G.extents, w0 = DV.box(view, ctx0)[2] - view.x;
  const width = d.drawing.dimensions.find(m => m.view === view.id && m.type === "linear" && m.axis === "x");
  const before = DV.measure(width, ctx0);
  DR.apply(p, d, [{op: "add_break", view: view.id, axis: "x", from: e[0] + 10, to: e[2] - 10}]);
  const v2 = d.drawing.views.find(v => v.id === view.id);
  assert.deepEqual(v2.options.breaks, [{axis: "x", from: e[0] + 10, to: e[2] - 10}]);
  const ctx = DR.contextFor(p, d, {date}), w1 = DV.box(v2, ctx)[2] - v2.x;
  assert(Math.abs(w1 - (20 * v2.scale + DV.BREAK_GAP)) < 1e-6, "the view loses the broken range but keeps a gap: " + w1 + " vs " + w0);
  const after = DV.measure(d.drawing.dimensions.find(m => m.id === width.id), ctx);
  assert.equal(after.value, before.value, "a dimension across the break keeps the true length");
  assert(Math.hypot(after.lines.at(-1)[1][0] - after.lines.at(-1)[0][0], 0) < Math.hypot(before.lines.at(-1)[1][0] - before.lines.at(-1)[0][0], 0), "but is drawn shorter");
  const F = DV.frame(v2, G, ctx);
  for (const x of [e[0], e[0] + 5, e[0] + 12, (e[0] + e[2]) / 2, e[2] - 3, e[2]]) { const q = F.map([x, e[1] + 1]), back = F.unmap(q); assert(Math.abs(back[0] - x) < 1e-6 && Math.abs(back[1] - e[1] - 1) < 1e-6, "map and unmap invert across breaks"); }
  assert.equal(F.pieces.length, 2);
  // Bottom (mirrored) assembly views break the same board range.
  const asm = d.drawing.views.find(v => v.type === "assembly" && v.side === "Bottom") || d.drawing.views.find(v => v.type === "assembly");
  DR.apply(p, d, [{op: "set_view", id: asm.id, side: "Bottom"}, {op: "add_break", view: asm.id, axis: "x", from: e[0] + 10, to: e[0] + 20}]);
  const Fa = DV.frame(d.drawing.views.find(v => v.id === asm.id), G, ctx);
  assert(Fa.mirror && Math.abs(Fa.map([e[0] + 25, 0])[0] - Fa.map([e[0] + 5, 0])[0] + (10 * Fa.s + DV.BREAK_GAP)) < 1e-6, "mirrored break");
  assert.throws(() => DR.apply(p, d, [{op: "add_break", view: view.id, axis: "z", from: 0, to: 1}]), /axis/);
  assert.deepEqual(DR.summary(p, d, {date}).problems, []);
  assert.deepEqual(DR.build(p, {date}).bytes(), DR.build(p, {date}).bytes(), "broken views export deterministically");
  DR.apply(p, d, [{op: "set_view", id: view.id, options: {breaks: []}}]);
  assert.equal(d.drawing.views.find(v => v.id === view.id).options.breaks, undefined);
}

// ---- ordinate dimensions: crowded labels are staggered and never overlap ----
{
  const p = clone(project), d = DR.drawingOf(p, "Sensor drawing"), view = d.drawing.views.find(v => v.type === "board");
  const ctx0 = DR.contextFor(p, d, {date}), e = ctx0.geometry(view).extents, y = (e[1] + e[3]) / 2;
  const pts = [0.3, 0.6, 0.9, 1.2, 8, 8.2, 20].map(dx => ({k: "point", at: [e[0] + dx, y]}));
  const r = DR.apply(p, d, [{op: "add_dimension", view: view.id, type: "ordinate", a: "corner:bl", points: pts, axis: "x"}, {op: "add_dimension", view: view.id, type: "ordinate", a: "corner:bl", points: pts.map(q => ({k: "point", at: [e[0] + 2, e[3] - (q.at[0] - e[0])]})), axis: "y"}]);
  const ctx = DR.contextFor(p, d, {date});
  for (const res of r) {
    const m = DV.measure(d.drawing.dimensions.find(x => x.id === res.id), ctx);
    assert.equal(m.value.length, 8);
    const at = m.stagger;
    for (let i = 1; i < at.length; i++) assert(at[i] - at[i - 1] >= DV.TEXT * 1.25 - 1e-6, "labels at least a text height apart: " + at);
    // Text boxes along the ordinate line do not overlap.
    const span = m.texts.map(t => res.op && m.texts[0].angle ? t.at[0] : t.at[1]).sort((a, b) => a - b);
    for (let i = 1; i < span.length; i++) assert(span[i] - span[i - 1] >= DV.TEXT * 1.2, "no overlapping labels");
  }
  // One feature alone keeps its straight leader.
  const one = DR.apply(p, d, [{op: "add_dimension", view: view.id, type: "ordinate", a: "corner:bl", points: [{k: "point", at: [e[0] + 20, y]}], axis: "x"}]);
  const m1 = DV.measure(d.drawing.dimensions.find(x => x.id === one[0].id), ctx);
  assert.equal(m1.lines.length, 2, "no jogs without crowding");
}

// ---- vias are matched by ID, then by position, then by net: re-imports and nudges keep anchors ----
{
  const p = clone(project), d = DR.drawingOf(p, "Sensor drawing"), view = d.drawing.views.find(v => v.type === "board");
  const brd = p.documents.find(x => x.kind === "pcb"), via = brd.items.find(i => i.kind === "via" && i.net);
  assert(via, "the sample board has vias");
  const res = DR.apply(p, d, [{op: "add_callout", note: 1, view: view.id, at: [via.x, via.y], x: 20, y: 20},
    {op: "add_dimension", view: view.id, type: "linear", a: [via.x, via.y], b: "corner:tl"}]);
  const cl = d.drawing.callouts.find(c => c.id === res[0].id);
  assert.equal(cl.at.k, "hole"); assert.equal(cl.at.id, String(via.id)); assert.equal(cl.at.net, via.net); assert.equal(cl.at.d, via.drill);
  const tipOf = () => DV.calloutGeometry(d.drawing.callouts.find(c => c.id === res[0].id), DR.contextFor(p, d, {date}));
  const dimOk = () => DR.summary(p, d, {date}).sheets[0].dimensions.find(m => m.id === res[1].id).resolved;
  const t0 = tipOf(); assert(t0.ok && dimOk());
  // Re-import: the same via with a new ID.
  via.id = "reimported-" + via.id; assert(tipOf().ok && dimOk(), "a re-imported via is found by position");
  // Then nudged 1 mm: found by net and size.
  via.x += 1; const t1 = tipOf(); assert(t1.ok && dimOk(), "a nudged via of the same net is found");
  assert(Math.abs(t1.tip[0] - t0.tip[0] - view.scale) < 1e-6, "the callout follows it");
  // Another net's via is not taken for it; a deleted via is reported.
  via.net = "OTHER-NET"; assert(!tipOf().ok);
  brd.items = brd.items.filter(i => i !== via);
  assert(!tipOf().ok && !dimOk());
  // A moved via that kept its ID is found by ID wherever it went.
  const p2 = clone(project), d2 = DR.drawingOf(p2, "Sensor drawing"), v2 = p2.documents.find(x => x.kind === "pcb").items.find(i => i.kind === "via" && i.net);
  const rr = DR.apply(p2, d2, [{op: "add_callout", note: 1, view: d2.drawing.views.find(v => v.type === "board").id, at: [v2.x, v2.y], x: 20, y: 20}]);
  v2.x += 6; v2.y += 3;
  assert(DV.calloutGeometry(d2.drawing.callouts.find(c => c.id === rr[0].id), DR.contextFor(p2, d2, {date})).ok, "moved via found by ID");
  // Stacked duplicate vias (a re-import that kept the old ones) are counted and reported.
  const p3 = clone(project), d3 = DR.drawingOf(p3, "Sensor drawing"), b3 = p3.documents.find(x => x.kind === "pcb"), v3 = b3.items.find(i => i.kind === "via");
  b3.items.push({...v3, id: "dup"});
  const s3 = DR.summary(p3, d3, {date});
  assert(s3.problems.some(m => /stacked/.test(m)), "stacked vias are reported");
}

// ---- sheet text and lines ----
{
  const p = clone(project), d = DR.drawingOf(p, "Sensor drawing");
  const r = DR.apply(p, d, [{op: "add_text", sheet: 1, x: 40, y: 260, text: "PANEL TO BE V-SCORED\nSEE NOTE 4", height: 3.5, bold: true},
    {op: "add_line", sheet: 1, points: [[40, 262], [120, 262], [120, 270]], weight: "thick", style: "chain"}]);
  const t = d.drawing.texts.find(x => x.id === r[0].id), l = d.drawing.lines.find(x => x.id === r[1].id);
  assert.equal(t.height, 3.5); assert.equal(t.bold, true); assert.equal(l.points.length, 3); assert.equal(l.weight, "thick");
  const b = DV.textBox(t); assert(b[0] <= 40 && b[2] > 60 && b[1] < 260 && b[3] > 260 + 3.5, "text box covers both lines: " + b);
  DR.apply(p, d, [{op: "set_text", id: t.id, text: "PANEL", angle: 90}, {op: "set_line", id: l.id, style: "dashed"}]);
  assert.equal(d.drawing.texts[0].angle, 90); assert.equal(d.drawing.lines[0].style, "dashed");
  assert.deepEqual(DR.normalize(d.drawing), d.drawing, "normalize is stable with text and lines");
  const before = P.counts(DR.build(project, {date}).pages[0].list), after = P.counts(DR.build(p, {date}).pages[0].list);
  assert.equal(after.text, before.text + 1); assert.equal(after.paths, before.paths + 1);
  assert.equal(DR.summary(p, d).untrusted_design_text.texts[0], "PANEL");
  assert.throws(() => DR.apply(p, d, [{op: "add_line", points: [[0, 0]]}]), /at least two/);
  assert.throws(() => DR.apply(p, d, [{op: "add_text", x: 1, y: 1, text: " "}]), /needs text/);
  DR.apply(p, d, [{op: "remove", id: t.id}, {op: "remove", id: l.id}]);
  assert.equal(d.drawing.texts.length + d.drawing.lines.length, 0);
}

// ---- title block: board revision and assembly variant ----
{
  const p = clone(project), d = DR.drawingOf(p, "Sensor drawing");
  p.variants = [{id: "v-lite", name: "Lite", parts: {}}]; p.activeVariant = "v-lite";
  let f = DV.titleFields(DR.contextFor(p, d, {date}), 0);
  assert.equal(f.variant, "Lite");
  f = DV.titleFields(DR.contextFor(p, d, {date, variant: null}), 0);
  assert.equal(f.variant, "Base design");
  if (globalThis.AtriumRevisions?.fields) {
    const p2 = clone(project), d2 = DR.drawingOf(p2, "Sensor drawing");
    d2.drawing.revisions = []; p2.revision = {letter: "C", status: "draft"};
    const f2 = DV.titleFields(DR.contextFor(p2, d2, {date}), 0);
    assert.equal(f2.revision, "C"); assert.equal(f2.revisionStatus, "Draft");
  }
}

// ---- printing: drawing sheets tile at 1:1 over the chosen paper, as export does ----
{
  const tiles = DR.tile(DR.pages(project, doc, {date}).list[0], "A4", [], {});
  assert(tiles.length >= 4 && tiles.every(t => t.tile && Math.abs(t.w - 297 * 72 / 25.4) < .01));
  assert.equal(DR.tile(DR.pages(project, doc, {date}).list[0], [600, 400], []).length, 1, "a custom paper as large as the sheet: no tiling");
  const r = AtriumPrint.build(project, {date, layerSets: ["top"], paper: "A4"});
  const pages = r.pages.filter(p => p.kind === "drawing");
  assert(pages.length >= 8 && pages.every(p => p.tile), "the Print dialog tiles drawing sheets at 1:1: " + pages.length);
  assert(r.notes.some(n => /tiled at 1:1/.test(n)));
  assert(pages.every(p => /tile \d+ of \d+/.test(p.title)));
  const whole = AtriumPrint.build(project, {date, layerSets: ["top"], paper: "A3"}).pages.filter(p => p.kind === "drawing");
  assert.equal(whole.length, 2, "A3 sheets on A3 paper print whole");
  const fit = AtriumPrint.build(project, {date, layerSets: ["top"], paper: "A4", tile: false}).pages.filter(p => p.kind === "drawing");
  assert.equal(fit.length, 2, "tile off: one page per sheet");
}

// The isometric drawing shows the laminate. External foil and mask contribute
// to finished stack thickness but do not thicken the green PCB body.
{
  const p = A.project("Laminate"), pcb = p.documents.find(doc => doc.kind === "pcb");
  pcb.outline = [[0, 0], [22, 0], [22, 13], [0, 13]];
  const thickness = 1.8;
  pcb.stackup = {version: 1, layers: AtriumStackup.preset("2").layers.map(layer =>
    layer.type === "Dielectric" ? {...layer, thickness} : layer)};
  const d = DR.create(p, {name: "Laminate", date}), view = d.drawing.views.find(v => v.type === "isometric");
  Object.assign(view, {x: 30, y: 30, scale: 1});
  d.drawing.views = [view];
  p.documents.push(d);
  const pdf = latin(DR.build(p, {date}).bytes({compress: false})), edges = [];
  for (const match of pdf.matchAll(/^([\d.-]+ [\d.-]+) m\n([\d.-]+ [\d.-]+) l\n([\d.-]+ [\d.-]+) l\nh\nf$/gm)) {
    const triangle = match.slice(1).map(pair => pair.split(" ").map(Number));
    for (let i = 0; i < 3; i++) {
      const [x, y] = triangle[i], [u, v] = triangle[(i + 1) % 3];
      if (x === u && Math.abs(y - v) > .01) edges.push(Math.abs(y - v));
    }
  }
  const projected = thickness * 2 / Math.sqrt(6) * 72 / 25.4;
  assert(edges.length >= 2, "the PDF contains the vertical laminate edges");
  assert(edges.every(edge => Math.abs(edge - projected) <= .02), "isometric ink shows the authored laminate thickness");
}

// ---- golden: the sample drawing's vector PDF (deterministic; update only for intended changes) ----
{
  const fs = require("node:fs"), path = require("node:path"), file = path.join(__dirname, "../goldens/drawing/sample.json");
  const prevId = A.id;
  let n = 0; A.id = () => "g" + (++n);
  try {
    const p = AtriumParts.example(); p.parameters = {CompanyName: "Waffle Labs", DocumentNumber: "PRJ-7"};
    const d = DR.create(p, {name: "Sensor drawing", date}); p.documents.push(d);
    const fnv = b => { let h = 0x811c9dc5; for (const x of b) h = Math.imul(h ^ x, 0x01000193); return (h >>> 0).toString(16).padStart(8, "0"); };
    const sample = DR.build(p, {date}).bytes({compress: false});
    // The same drawing with the new objects: section, detail, break lines, staggered ordinates, text and a line.
    const view = d.drawing.views.find(v => v.type === "board"), G = DR.contextFor(p, d, {date}).geometry(view), e = G.extents, h = G.holes[0];
    DR.apply(p, d, [{op: "add_view", type: "section", parent: view.id, a: [e[0] - 1, h.at[1]], b: [e[2] + 1, h.at[1]], x: 30, y: 215},
      {op: "add_view", type: "detail", parent: view.id, center: h.at, radius: 1.2, x: 330, y: 60},
      {op: "add_break", view: view.id, axis: "x", from: e[0] + 15, to: e[0] + 25},
      {op: "add_dimension", view: view.id, type: "ordinate", a: "corner:bl", points: [[e[0] + 1, e[1] + 5], [e[0] + 1.5, e[1] + 5], [e[0] + 2, e[1] + 5]], axis: "x"},
      {op: "add_text", x: 30, y: 205, text: "SECTION THROUGH THE FIRST HOLE"}, {op: "add_line", points: [[30, 207], [110, 207]], weight: "thin", style: "dashed"}]);
    const extended = DR.build(p, {date}).bytes({compress: false});
    // Measure the detail's clip and ink in the exported PDF against the authored circle, in sheet mm.
    const detail = d.drawing.views.find(v => v.type === "detail"), ptPerMm = 72 / 25.4;
    const radius = detail.radius * detail.scale, cx = detail.x + radius, cy = detail.y + radius;
    const circles = new Map();
    for (const match of latin(extended).matchAll(/^([\d.-]+) ([\d.-]+) m\n((?:[\d. -]+ c\n)+)(W n|S)$/gm)) {
      const start = [+match[1] / ptPerMm, +match[2] / ptPerMm];
      if (Math.hypot(start[0] - (cx + radius), start[1] - cy) > .005) continue;
      circles.set(match[4], match[3]);
      let from = start;
      for (const line of match[3].trimEnd().split("\n")) {
        const [ax, ay, bx, by, x, y] = line.split(" ").slice(0, 6).map(v => +v / ptPerMm);
        for (let j = 1; j <= 100; j++) {
          const t = j / 100, u = 1 - t;
          const px = u ** 3 * from[0] + 3*u*u*t*ax + 3*u*t*t*bx + t ** 3 * x;
          const py = u ** 3 * from[1] + 3*u*u*t*ay + 3*u*t*t*by + t ** 3 * y;
          assert(Math.abs(Math.hypot(px - cx, py - cy) - radius) <= .005, "detail circle stays within 0.005 mm on paper");
        }
        from = [x, y];
      }
      assert(Math.hypot(from[0] - start[0], from[1] - start[1]) < .00001, "detail circle closes");
    }
    assert(circles.has("W n") && circles.has("S"), "the PDF clips and outlines the authored detail");
    assert.equal(circles.get("W n"), circles.get("S"), "detail clipping and ink use the same curve");
    const got = {sample: {bytes: sample.length, fnv1a: fnv(sample)}, extended: {bytes: extended.length, fnv1a: fnv(extended)}};
    if (process.argv.includes("--emit")) console.log(JSON.stringify(got, null, 2));
    else {
      const want = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.deepEqual(got, want, "drawing PDF golden changed: if the change is intended, run node tests/formats/drawing.cjs --emit (or scripts/test-jsc.sh) and update " + file);
    }
  } finally { A.id = prevId; }
}

console.log("drawing ok");
