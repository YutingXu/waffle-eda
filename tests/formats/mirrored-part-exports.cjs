"use strict";
// A PCB part's own `mirror` flag reflects its footprint about local Y (pcb-appearance.js padTurn,
// Atrium.drillCore). Every writer that places footprint-local geometry must put each pad, slot,
// curved region, text anchor and body where the board draws it: KiCad, IPC-2581, STEP, EasyEDA
// Standard and Pro, Altium and IDF. The mirror keeps lettering readable: the board moves only the
// text anchor (pcb-appearance.js placeText). Each check runs with the part at 0°, 30° and 90°.
// At 0° the part has a pad at local x = +4 placed at x = 20 and mirrored, so its copper is at x = 16.
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const n of ["obsolete-project", "model", "parts", "sch-objects", "hierarchy", "spatial", "board-shape", "board-shape-editing", "board-shape-sources",
  "net-intent", "signals", "altium-rules", "pcb-draw", "component-classes", "query", "rules", "project-rules", "pcb-pours", "pcb-appearance", "stackup",
  "impedance", "viastack", "rooms", "rigid-flex", "polygon-pour", "vectorize", "pcb-text-rich", "pcb-text", "bom", "altium-ids", "source-file", "sch-import",
  "pcb-import", "sexpr", "import-easyeda", "import-link", "io", "import-rules", "translator-table", "translator-registry", "translator-provenance",
  "translator-adapters", "translators", "zip", "fab-outputs", "ipc2581", "step-export", "kicad-export", "export-easyeda", "export-easyeda-standard",
  "export-easyeda-pro", "altium-export", "pcb-edit", "mcad-xml", "mcad", "mcad-idx", "mcad-idf"]) require(require("../support/app-source-paths.cjs").appFile(n + ".js"));
const A = Atrium, L = AtriumResolvedLand, S = AtriumBoardShape, PCB = AtriumPCBAppearance;
const near = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, a + " differs from " + b);
const nearPoint = (p, q, tol) => { near(p[0], q[0], tol); near(p[1], q[1], tol); };
const turn = a => ((a % 360) + 360) % 360;
const sameAngle = (a, b, tol = 1e-3) => { const d = turn(a - b); assert.ok(Math.min(d, 360 - d) <= tol, a + "° differs from " + b + "°"); };
// Slot axes are lines: compare directions up to sign.
const sameAxis = (u, v) => { const k = Math.hypot(...u) * Math.hypot(...v); near(Math.abs(u[0] * v[0] + u[1] * v[1]) / k, 1, 1e-6); };
// A curved copper region: a box with a half-disc end on its right, clear of the pads.
const contour = [{kind: "line", a: [1, 2], b: [3, 2]}, {kind: "arc", c: [3, 3], r: 1, start: 90, end: -90, ccw: false},
  {kind: "line", a: [3, 4], b: [1, 4]}, {kind: "line", a: [1, 4], b: [1, 2]}];
const regionPoints = S.flattenContour(contour);
const MARK = {kind: "text", text: "MARK", x: 2, y: -3, angle: 30, size: 1, layer: "Silk", justify: "bottom-left", mirrored: false};

function design(mirror = true, slotAngle = 30, angle = 0) {
  const project = A.project("Mirror", []), doc = project.documents.find(d => d.kind === "pcb");
  doc.outline = [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]];
  project.library.push({id: "d1", name: "D1", prefix: "U", symbol: {pins: [], shapes: []}, footprint: {name: "FP", pads: [
    {number: "1", x: 4, y: 0, w: 2, h: 2, drill: 1, shape: "round", layer: "Multi"},
    {number: "2", x: -4, y: 0, w: 4, h: 2, drill: .6, slotLength: 3, slotAngle, shape: "oval", layer: "Multi"},
    {number: "3", x: 0, y: 3, w: 1, h: 2, angle: 20, shape: "rect", layer: "Top"}],
    shapes: [{kind: "path", style: "package", closed: true, points: [[3, -1], [6, -1], [6, 1], [3, 1]], width: .1},
      {kind: "path", layer: "Top", closed: true, fill: true, width: 0, points: regionPoints, regionShape: {version: 1, contour, cutouts: [], sig: S.signature(regionPoints)}},
      {...MARK}]}});
  doc.items.push({id: "p1", kind: "part", def: "d1", ref: "U1", value: "", x: 20, y: 10, angle, mirror, layer: "Top", pinNets: {}});
  return {project, doc, item: doc.items[0], fp: project.library[0].footprint, pads: project.library[0].footprint.pads};
}
const records = (content, kind) => content.split(/\r?\n/).filter(l => new RegExp("\\|RECORD=" + kind + "\\|").test(l))
  .map(l => Object.fromEntries(l.split("|").filter(Boolean).map(f => f.split("="))));

// ---- pcbMirror: a reflected curved region keeps its exact outline --------------------------------
{
  const {fp} = design(), region = fp.shapes[1];
  for (const side of ["placed", "flip"]) {
    const out = side === "placed" ? A.pcbMirror.placed({mirror: true}, fp).footprint.shapes[1] : A.pcbMirror.shape(region);
    const exact = S.regionOf(out);
    assert.ok(exact, side + ": the reflected outline is current for the reflected polygon");
    const arc = exact.contour.find(g => g.kind === "arc");
    nearPoint(arc.c, [-3, 3]);
    // The reflected half disc bulges to the left.
    nearPoint(A.arcPoint(arc, arc.start + (arc.ccw ? 1 : -1) * 90), [-4, 3]);
    assert.ok(S.flattenContour(exact.contour).every(p => out.points.some(q => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-6)));
  }
  // A stale outline stays stale, and one without a signature is checked by extents.
  assert.equal(S.regionOf(A.pcbMirror.shape({...region, regionShape: {...region.regionShape, sig: "0:0"}})), null);
  const unsigned = A.pcbMirror.shape({...region, regionShape: {version: 1, contour, cutouts: []}});
  assert.equal(unsigned.regionShape.sig, undefined);
  assert.ok(S.regionOf(unsigned));
  // The flip to the other side mirrors lettering; the part's own mirror keeps it readable.
  assert.deepEqual(A.pcbMirror.shape(MARK, 0), {...MARK, layer: "Bottom silk", x: -2, angle: 330, mirrored: true});
  assert.deepEqual(A.pcbMirror.placedShape(MARK), {...MARK, x: -2});
}

for (const angle of [0, 30, 90]) {
  const {project, doc, item, pads, fp} = design(true, 30, angle);
  const at = angle + "°: ";
  // What the board draws: pad centres, pad turns, the slot core, the region outline and the text pose.
  const placed = pads.map(p => L.place(p, item));
  if (!angle) nearPoint(placed[0].at, [16, 10]);
  const core = A.drillCore(pads[1], placed[1].at, placed[1].angle, true), slotAxis = [core[1][0] - core[0][0], core[1][1] - core[0][1]];
  const outline = S.placeContour(contour, p => A.world(p, item), angle, true);
  const mark = PCB.placeText(MARK, item, "Silk");
  const pkg = A.bounds(fp.shapes[0].points.map(p => A.world(p, item)));

  // ---- KiCad: footprint-local pads (no mirror flag), oval drills and readable text ----------------
  {
    const text = AtriumKiCad.exportBoard(project, doc).content;
    const fpAt = /\(footprint[^\n]*\n\s*\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/.exec(text), origin = {x: +fpAt[1], y: +fpAt[2], angle: -(+fpAt[3] || 0)};
    const padOf = number => {
      const line = new RegExp('\\(pad "' + number + '" [^\\n]*').exec(text)[0];
      return [line, ...(/\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/.exec(line).slice(1)), /\(drill [^)]*\)/.exec(line)?.[0]];
    };
    for (const [i, p] of pads.entries()) {
      const m = padOf(p.number);
      nearPoint(A.world([+m[1], +m[2]], origin), placed[i].at);
    }
    const slot = padOf("2");
    assert.equal(slot[4], "(drill oval 3 0.6)", at + "a slot is an oval drill along the pad's X axis");
    // KiCad angles are counter-clockwise on screen; the oval runs along the turned pad X axis.
    sameAxis(A.rotate([1, 0], -(+slot[3] || 0)), slotAxis);
    sameAngle(-(+padOf("3")[3] || 0), placed[2].angle);
    const label = /\(fp_text user "MARK" \(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)[^\n]*/.exec(text);
    nearPoint(A.world([+label[1], +label[2]], origin), [mark.x, mark.y]);
    sameAngle(-(+label[3] || 0), mark.angle);
    assert.doesNotMatch(label[0], /\bmirror\b/, at + "the mirrored part's text stays readable");
    // Axis-aligned slots keep the pad rotation and size the oval along the matching pad axis.
    if (!angle) for (const [slotAngle, drill] of [[0, "(drill oval 3 0.6)"], [90, "(drill oval 0.6 3)"], [-90, "(drill oval 0.6 3)"], [180, "(drill oval 3 0.6)"]]) {
      const d = design(false, slotAngle), out = AtriumKiCad.exportBoard(d.project, d.doc).content;
      assert.match(out, new RegExp('\\(pad "2" thru_hole custom \\(at -4 0\\) \\(size [\\d.]+ [\\d.]+\\) ' + drill.replace(/[()]/g, "\\$&")));
    }
  }

  // ---- IPC-2581: the placed package pins land on the pad features -------------------------------
  {
    const X = AtriumIPC2581, r = X.build(project, doc, {date: new Date(2026, 0, 1)});
    assert.ok(X.check(r.content).ok, JSON.stringify(X.check(r.content).errors));
    const tree = X.parse(r.content), all = (node, name, out = []) => { if (node.name === name) out.push(node); for (const c of node.children) all(c, name, out); return out; };
    const child = (node, name) => node.children.find(c => c.name === name), loc = node => [+child(node, "Location").attrs.x, +child(node, "Location").attrs.y];
    const comp = all(tree, "Component").find(c => c.attrs.refDes === "U1"), pkgNode = all(tree, "Package").find(p => p.attrs.name === comp.attrs.packageRef);
    const rotation = +(child(comp, "Xform")?.attrs.rotation || 0), mirrored = child(comp, "Xform")?.attrs.mirror === "true";
    let pins = 0;
    for (const pin of all(pkgNode, "Pin")) {
      const local = loc(pin), q = A.rotate([mirrored ? -local[0] : local[0], -local[1]], -rotation), p = [loc(comp)[0] + q[0], loc(comp)[1] - q[1]];
      const pad = all(tree, "Pad").find(f => child(f, "PinRef")?.attrs.componentRef === "U1" && child(f, "PinRef").attrs.pin === pin.attrs.number);
      nearPoint(p, loc(pad)); pins++;
    }
    assert.equal(pins, 3);
  }

  // ---- STEP: the generated body is the reflected package outline --------------------------------
  {
    const part = AtriumSTEP.model(project, doc.id, {}).parts.find(p => p.id === "p1"), m = part.matrix;
    const corners = part.body.loops[0].flatMap(e => [e.a, e.b]).map(([x, y]) => [m[0] * x + m[4] * y + m[12], -(m[1] * x + m[5] * y + m[13])]);
    A.bounds(corners).forEach((v, k) => near(v, pkg[k]));
  }

  // ---- EasyEDA Standard and Pro ------------------------------------------------------------------
  const files = edition => AtriumEasyEDAExport.export(project, {edition, scope: "document", documentId: doc.id}, {add() {}}).files;
  {
    const std = JSON.parse(files("standard").find(f => f.name.endsWith(".json")).text), U = .254;
    const origin = std.canvas.split("~").slice(16, 18).map(Number), mm = (x, y) => [(+x - origin[0]) * U, (+y - origin[1]) * U];
    const stdPads = std.shape.join("#@$").split("#@$").filter(s => s.startsWith("PAD~")).map(s => s.split("~"));
    for (const [i, p] of pads.entries()) nearPoint(mm(...stdPads.find(f => f[8] === p.number).slice(2, 4)), placed[i].at);
    const ends = stdPads.find(f => f[8] === "2")[14].split(" ").map(Number), a = mm(ends[0], ends[1]), b = mm(ends[2], ends[3]);
    nearPoint(a, core[0]); nearPoint(b, core[1]);
    sameAngle(-(+stdPads.find(f => f[8] === "3")[11]), placed[2].angle);
  }
  {
    const zip = AtriumImportFormats.unzip(files("pro")[0].bytes), rows = name => AtriumImportFormats.utf8(zip.get(name)).trim().split("\n").map(l => JSON.parse(l));
    const board = rows([...zip.keys()].find(k => k.endsWith(".epcb"))).find(r => r[0] === "COMPONENT"), footprint = [...zip.keys()].find(k => k.endsWith(".efoo"));
    // Pro angles are counter-clockwise with Y up.
    sameAngle(-board[6], angle);
    const mil = .0254, origin2 = [board[4] * mil, -board[5] * mil];
    for (const r of rows(footprint).filter(r => r[0] === "PAD")) {
      const i = pads.findIndex(p => p.number === r[5]), q = A.rotate([r[6] * mil, -r[7] * mil], -board[6]);
      nearPoint([origin2[0] + q[0], origin2[1] + q[1]], placed[i].at);
      // The slot turns from the pad axis.
      if (r[5] === "2") sameAxis(A.rotate([1, 0], -(r[8] + r[14] + board[6])), slotAxis);
      if (r[5] === "3") sameAngle(-(r[8] + board[6]), placed[2].angle);
    }
  }

  // ---- Altium PcbDoc: pads, holes, the exact curved region and readable text ----------------------
  {
    const out = AtriumAltiumExport.exportBoard(project, doc), MIL = .0254, val = s => parseFloat(s);
    const xy = (x, y) => [val(x) * MIL - out.offset[0], -(val(y) * MIL + out.offset[1])];
    const pins = records(out.content, "Pad");
    for (const [i, p] of pads.entries()) {
      const r = pins.find(r => r.NAME === p.number);
      nearPoint(xy(r.X, r.Y), placed[i].at, 2e-4);
      // Altium rotations are counter-clockwise with Y up; HOLEROTATION is relative to the pad.
      sameAngle(-val(r.ROTATION), placed[i].angle);
      if (p.number === "2") sameAxis(A.rotate([1, 0], -(val(r.ROTATION) + val(r.HOLEROTATION))), slotAxis);
    }
    const regions = records(out.content, "Region");
    assert.equal(regions.length, 1);
    const region = regions[0];
    assert.equal(region.ISSHAPEBASED, "TRUE", at + "the curved region keeps its arcs");
    assert.equal(+region.MAINCONTOURVERTEXCOUNT, outline.length);
    for (const [k, g] of outline.entries()) {
      assert.equal(region["KIND" + k], g.kind === "arc" ? "1" : "0");
      if (g.kind === "line") { nearPoint(xy(region["VX" + k], region["VY" + k]), g.a, 2e-4); continue; }
      const c = xy(region["CX" + k], region["CY" + k]), r = val(region["R" + k]) * MIL, sa = val(region["SA" + k]), ea = val(region["EA" + k]);
      nearPoint(c, g.c, 2e-4); near(r, g.r, 2e-4);
      // Altium sweeps counter-clockwise from SA to EA; the middle of the sweep is the middle of the board's arc.
      const middle = sa + turn(ea - sa) / 2, sweep = g.ccw ? turn(g.end - g.start) : -turn(g.start - g.end);
      nearPoint(A.arcPoint({c, r}, middle), A.arcPoint(g, g.start + sweep / 2), 2e-4);
    }
    const label = records(out.content, "Text").find(r => r.TEXT === "MARK");
    nearPoint(xy(label.X, label.Y), [mark.x, mark.y], 2e-4);
    sameAngle(-val(label.ROTATION), mark.angle);
    assert.equal(label.MIRROR, "FALSE", at + "the mirrored part's text stays readable");
  }

  // ---- IDF: the package outline of a mirrored part is reflected ----------------------------------
  {
    const w = AtriumIDF.write(project, doc, {date: "2026-11-19T12:00:00Z"});
    const place = /"FP" "(d1[^"]*)" "U1"\n([-\d.]+) ([-\d.]+) 0 ([-\d.]+) TOP/.exec(w.emn.text);
    assert.match(place[1], /_mirrored$/, at + "the reflected outline is its own package");
    const body = new RegExp('\\.ELECTRICAL\\n"FP" "' + place[1] + '" MM [\\d.]+\\n([\\s\\S]*?)\\.END_ELECTRICAL').exec(w.emp.text)[1];
    const frame = {x: +place[2], y: -place[3], angle: -place[4]};
    const corners = body.trim().split("\n").map(l => l.trim().split(/\s+/).map(Number)).map(r => A.world([r[1], -r[2]], frame));
    A.bounds(corners).forEach((v, k) => near(v, pkg[k], 1e-3));
    assert.deepEqual(AtriumMCAD.compare(project, doc, AtriumIDF.read(w.emn.text, w.emp.text)).map(x => x.label), [], at + "reading it back proposes nothing");
    // IDX uses the same reflected outline (mcad-idx.js footprintOutline).
    const idx = AtriumIDX.footprintOutline({defs: new Map([["d1", project.library[0]]])}, {def: "d1", ref: "U1", mirror: true});
    A.bounds(idx.map(([x, y]) => A.world([x, -y], {x: item.x, y: item.y, angle}))).forEach((v, k) => near(v, pkg[k], 1e-3));
    assert.deepEqual(AtriumMCAD.compare(project, doc, AtriumIDX.read(AtriumIDX.baseline(project, doc, {date: "2026-11-19T12:00:00"}).text)).map(x => x.label), []);
  }
}

// ---- Bodies: extruded outlines with arcs, and STEP bodies drawn as envelopes ---------------------
{
  const body = {type: "extruded", layer: "Mechanical 13", side: "Top", ownerSide: "Top", minZ: 0, maxZ: 1, at: [0, 0], angle: 0, rotation: [0, 0, 0], dz: 0,
    contour, rings: [regionPoints], modelId: "m1"};
  for (const angle of [0, 30, 90]) {
    const {project, doc, item, fp} = design(true, 30, angle), outline = S.placeContour(contour, p => A.world(p, item), angle, true);
    fp.bodies3d = [body];
    const out = AtriumAltiumExport.exportBoard(project, doc), MIL = .0254, val = s => parseFloat(s);
    const xy = (x, y) => [val(x) * MIL - out.offset[0], -(val(y) * MIL + out.offset[1])];
    const rec = records(out.content, "ComponentBody")[0], k = outline.findIndex(g => g.kind === "arc"), g = outline[k];
    const c = xy(rec["CX" + k], rec["CY" + k]), sa = val(rec["SA" + k]), ea = val(rec["EA" + k]), r = val(rec["R" + k]) * MIL;
    nearPoint(c, g.c, 2e-4);
    const middle = sa + turn(ea - sa) / 2, sweep = g.ccw ? turn(g.end - g.start) : -turn(g.start - g.end);
    nearPoint(A.arcPoint({c, r}, middle), A.arcPoint(g, g.start + sweep / 2), 2e-4);
    // A STEP body drawn as its envelope (3D collision checks) is the reflected outline.
    fp.bodies3d = [{...body, type: "step", contour: undefined}];
    fp.bodyModels = [{id: "m1", file: "m1.step"}];
    const part = AtriumSTEP.model(project, doc.id, {bodyEnvelopes: true, models: false}).parts.find(p => p.id === "p1" && p.source === "envelope"), m = part.matrix;
    const corners = part.body.loops[0].flatMap(e => [e.a, e.b]).map(([x, y]) => [m[0] * x + m[4] * y + m[12], -(m[1] * x + m[5] * y + m[13])]);
    A.bounds(corners).forEach((v, n) => near(v, A.bounds(regionPoints.map(p => A.world(p, item)))[n], 1e-3));
  }
}
console.log("mirrored-part-exports: ok");
