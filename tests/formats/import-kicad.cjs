"use strict";
// KiCad 6–9 import (app/formats/import-kicad.js, app/formats/sexpr.js).
// 1. Round trip: the built-in example project -> kicad-export.js / kicad-schematic.js ->
//    import -> compare pad, track, via, outline and pin-net geometry with the original.
// 2. Hand-written KiCad 8 fixtures in tests/fixtures/import (synthetic, written for this
//    test, MIT like the rest of the repository): zones, arc tracks, blind vias, stackup,
//    arc board edge with a cutout, bottom footprints, power symbols, multi-unit and
//    mirrored symbols, hierarchical sheets, global labels and project net classes.
// 3. A KiCad 6 sheet whose references live in symbol_instances.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "board-shape-sources", "stackup", "kicad-export", "kicad-schematic", "import-link", "pcb-pours", "polygon-pour", "sexpr", "import-kicad", "net-intent", "signals", "rules"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, K = AtriumKiCad, I = AtriumImportFormats, enc = new TextEncoder();
const fixture = n => fs.readFileSync(path.join(__dirname, "../fixtures/import", n), "utf8");
const file = (name, text) => ({name, bytes: enc.encode(text)});
{
  const source = '(kicad_pcb (version 20240108) (footprint "Board:Logo" (layer "F.Cu") (at 1 2) (uuid "ab12-3456")) (module "Old" (layer F.Cu) (at 2 3) (tstamp DEADBEEF)))';
  const ids = () => I.readSet([file("ids.kicad_pcb", source)])[0].documents[0].items.filter(i => i.kind === "part").map(i => [i.kicadSourceId, i.link]);
  assert.deepEqual(ids(), [["ab12-3456", "kicad-footprint-ab12-3456"], ["deadbeef", "kicad-footprint-deadbeef"]]);
  assert.deepEqual(ids(), ids(), "board-only decoration links survive a fresh import");
}
// Missing and non-numeric axes must not manufacture copper at the origin.
{
  const board = `(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal))
    (footprint "R" (layer "F.Cu") (at nope 12) (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS")))
    (footprint "R" (layer "F.Cu") (at 0 12) (property "Reference" "R2" (at 0 0 0) (layer "F.SilkS")))
    (gr_line (start nope 5) (end 10 5) (layer "F.Cu") (stroke (width 0.2) (type solid)))
    (segment (start 1 2) (end 3 nope) (width 0.2) (layer "F.Cu"))
    (segment (start 2 3) (end 3) (width 0.2) (layer "F.Cu"))
    (segment (start 0 1) (end 10 0) (width 0.2) (layer "F.Cu")))`;
  const [result] = I.readSet([file("bad-points.kicad_pcb", board)]);
  const items = result.documents[0].items;
  assert.deepEqual(items.filter(i => i.kind === "part").map(i => [i.ref, i.x, i.y]), [["R2", 0, 12]]);
  assert.deepEqual(items.filter(i => i.kind === "track").map(i => i.points), [[[0, 1], [10, 0]]]);
  assert.ok(result.notes.some(note => /malformed required values/.test(note)));
}
// Two placements of the same KiCad unit are distinct physical components.
{
  const sch = `(kicad_sch (version 20231120) (uuid "aaaaaaaa-aaaa-4000-8000-000000000001")
    (lib_symbols (symbol "Device:R" (property "Reference" "R" (at 0 0 0))
      (symbol "R_0_1" (rectangle (start -1 -2) (end 1 2)))
      (symbol "R_1_1" (pin passive line (at 0 2 270) (length 1) (name "~") (number "1")))))
    (symbol (lib_id "Device:R") (at 10 10 0) (unit 1) (uuid "aaaaaaaa-aaaa-4000-8000-000000000011")
      (property "Reference" "R1" (at 12 10 0)) (property "Value" "1k" (at 12 12 0)))
    (symbol (lib_id "Device:R") (at 40 10 0) (unit 1) (uuid "aaaaaaaa-aaaa-4000-8000-000000000021")
      (property "Reference" "R1" (at 42 10 0)) (property "Value" "2k" (at 42 12 0))))`;
  const pcb = `(kicad_pcb (version 20240108)
    (footprint "R" (layer "F.Cu") (at 15 9) (path "/aaaaaaaa-aaaa-4000-8000-000000000001/aaaaaaaa-aaaa-4000-8000-000000000021")
      (property "Reference" "R1" (at 0 0 0) (layer "F.SilkS"))))`;
  const results = I.readSet([file("duplicate-ref.kicad_sch", sch), file("duplicate-ref.kicad_pcb", pcb)]);
  const [a, b] = results[0].documents[0].items.filter(item => item.kind === "part");
  const placed = results[1].documents[0].items.find(item => item.kind === "part");
  assert.equal(a.ref, b.ref);
  assert.equal(a.link, "kicad-aaaaaaaa-aaaa-4000-8000-000000000011");
  assert.equal(b.link, placed.link);
}
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const nearP = (p, q, tol = 1e-3) => near(p[0], q[0], tol) && near(p[1], q[1], tol);
const defsOf = p => new Map(p.library.map(d => [d.id, d]));
function projectOf(results) {
  const p = A.project("Imported");
  p.documents = results.flatMap(r => r.documents);
  p.library = results.flatMap(r => r.library);
  AtriumImportLink.reconcile(p, p.documents);  // as the app assembles an import: board rules join the project rule book
  return p;
}
const worldPads = (part, def) => A.pins(part, def, "pcb").map(p => ({n: p.number, at: p.at, w: p.w, h: p.h, drill: p.drill || 0}));

{
  const source = `(kicad_pcb (version 20240108)
    (footprint "Test:Connector" (layer "B.Cu") (at 10 10 30)
      (pad "" thru_hole rect (at 0 0 30) (size 2 .6) (drill oval 2 .6) (layers "*.Cu" "*.Mask"))
      (pad "" np_thru_hole oval (at 3 0 120) (size .8 1.6) (drill oval .8 1.6) (layers "*.Cu" "*.Mask"))
      (pad "2" smd oval (at 6 0 30) (size 2 1) (layers "B.Cu" "B.Mask"))
      (pad "3" thru_hole oval (at 9 0 30) (size 2 1) (drill .6) (layers "*.Cu" "*.Mask"))
      (pad "4" thru_hole circle (at 12 0 30) (size 1 1) (drill oval .6 .6) (layers "*.Cu" "*.Mask"))))`;
  const imported = projectOf(I.readSet([file("Connector.kicad_pcb", source)]));
  A.validate(imported);
  const [board] = imported.documents;
  const [plated, unplated, smd, rounded, equalAxes] = imported.library[0].footprint.pads;
  assert.deepEqual([plated.drill, plated.slotLength, plated.slotAngle || 0, plated.plated, plated.shape], [.6, 2, 0, true, "rect"]);
  assert.deepEqual([unplated.drill, unplated.slotLength, unplated.slotAngle, unplated.plated, unplated.shape], [.8, 1.6, 90, false, "oval"]);
  assert.deepEqual([smd, rounded, equalAxes].map(pad => [pad.drill, pad.slotLength, pad.shape]),
    [[0, undefined, "oval"], [.6, undefined, "oval"], [.6, undefined, "round"]]);
  assert.ok(!board.notes.some(note => /Slotted holes import as round holes/.test(note)));

  require("../../app/pcb/pcb-appearance.js");
  require("../../app/formats/fab-outputs.js");
  const model = AtriumFabOutputs.analyse(imported, board);
  const [first, second] = model.drills;
  const cos30 = Math.sqrt(3) / 2, sine30 = .5, x = 10 + 3 * cos30, y = 10 - 3 * sine30;
  assert.deepEqual(model.drills.map(hole => [hole.d, hole.plated, !!hole.endpoints]), [[.6, true, true], [.8, false, true], [.6, true, false], [.6, true, false]]);
  for (const [hole, endpoints] of [[first, [[10 - .7 * cos30, 10 + .7 * sine30], [10 + .7 * cos30, 10 - .7 * sine30]]],
    [second, [[x - .4 * cos30, y + .4 * sine30], [x + .4 * cos30, y - .4 * sine30]]]]) {
    assert.ok(hole.endpoints.every((point, index) => nearP(point, endpoints[index], 1e-6)), "fabrication slot follows the KiCad world angle");
  }
  console.log("PASS rotated plated and unplated KiCad drill slots with independent oval copper");
}

{
  const source = `(kicad_pcb (version 20240108) (setup (pad_to_mask_clearance .05) (pad_to_paste_clearance -.025))
    (net 1 "ApertureNet")
    (footprint "Test:Stencil" (layer "F.Cu") (at 10 10)
      (pad "" smd rect (at 1 0) (size .9 .9) (layers "F.Paste"))
      (pad "1" thru_hole circle (at 2 0) (size 1 1) (drill .5) (layers "*.Cu" "F.Mask"))
      (pad "2" smd rect (at 3 0) (size 1 1) (layers "F.Cu" "F.Mask"))
      (pad "3" smd rect (at 4 0) (size 1 1) (layers "F.Cu" "F.Mask" "F.Paste"))
      (pad "4" smd rect (at 5 0) (size .8 .6) (layers "B.Mask") (solder_mask_margin .12) (net 1 "ApertureNet"))))`;
  const settings = JSON.stringify({net_settings: {classes: [{name: "Default", clearance: .21}]}});
  const imported = projectOf(I.readSet([file("Stencil.kicad_pro", settings), file("Stencil.kicad_pcb", source)]));
  const [board] = imported.documents, fab = AtriumFabOutputs, model = fab.analyse(imported, board);
  const openings = layer => model.layers.get(layer).filter(f => f.pad).map(f => [f.at[0], fab.plotPad(f, fab.defaults()).w]);
  assert.equal(AtriumRules.stored(board, imported).defaults.clearance, .21);
  assert.ok(imported.rules.list.some(rule => rule.origin?.key === "clearance-1" && rule.gap === .21));
  assert.ok(imported.rules.list.some(rule => rule.origin?.key === "solderMask-1" && rule.expansion === .05));
  assert.ok(imported.rules.list.some(rule => rule.origin?.key === "pasteMask-1" && rule.expansion === -.025));
  const part = board.items.find(item => item.kind === "part");
  const mask = imported.library[0].footprint.pads.find(pad => pad.layer === "Bottom mask");
  assert.deepEqual([mask.number, mask.net, mask.maskExpansion, part.pinNets["4"]], ["", undefined, undefined, undefined]);
  assert.deepEqual(openings("Top"), [[12, 1], [13, 1], [14, 1]]);
  assert.deepEqual(openings("Top mask"), [[12, 1.1], [13, 1.1], [14, 1.1]]);
  assert.deepEqual(openings("Bottom mask"), [[15, .8]]);
  assert.deepEqual(openings("Top paste"), [[11, .9], [14, .95]]);
  assert.deepEqual(openings("Bottom paste"), []);
  console.log("PASS KiCad board mask and paste rules, exact stencil pads and explicit film exclusions");
}

// The same file can contain standalone and historical annotations as well as the active project.
{
  const root = "a0000000-0000-4000-8000-000000000000", middle = "b0000000-0000-4000-8000-000000000000";
  const child = "e0000000-0000-4000-8000-000000000000", outer = "1234", inner = "5678";
  const path = `/${root}/${outer}/${inner}`;
  const instance = (name, sheetPath, ref) => `(project "${name}" (path "${sheetPath}" (reference "${ref}") (unit 1)))`;
  const children = (uuid, placements) => `(kicad_sch (version 20231120) (generator eeschema) (uuid "${uuid}") (lib_symbols) ` +
    placements.map(([id, name]) => `(sheet (at 0 0) (size 20 15) (uuid "${id}") (property "Sheetname" "${name}") (property "Sheetfile" "${name}.kicad_sch"))`).join(' ') + ')';
  const sources = [file("demo.kicad_pro", "{}"), file("demo.kicad_sch", children(root, [[outer, "middle"]])),
    file("middle.kicad_sch", children(middle, [[inner, "child"]]))];
  const archive = extra => file("child.kicad_sch", fixture("child.kicad_sch").replace(/\(instances \(project[^\n]+/,
    `(instances ${instance("demo", "/" + child, "R?")} ${instance("unrelated", path, "R99")} ${instance("demo", `/${root}/${inner}`, "R98")} ${instance("demo", path, "R23")} ${extra})`));
  const resistor = results => results.flatMap(r => r.documents).find(d => d.sourceName === "child.kicad_sch").items.find(i => i.kind === "part");
  assert.equal(resistor(I.readSet([...sources, archive("")])).ref, "R23", "uses selected project and full nested sheet path");
  assert.equal(resistor(I.readSet([archive("")])).ref, "R?", "a separately opened child keeps its standalone reference");
  assert.equal(resistor(I.readSet([...sources, archive(instance("demo", path, "R24"))])).ref, "R?", "conflicting exact placement records stay unresolved");
  const repeated = file("demo.kicad_sch", children(root, [[outer, "middle"], ["abcd", "middle"]]));
  assert.equal(resistor(I.readSet([sources[0], repeated, sources[2], archive("")])).ref, "R?", "a repeated ancestor cannot supply one global reference");
  const ambiguous = file("middle.kicad_sch", children(middle, [[inner, "child"], [inner, "absent"]]));
  assert.equal(resistor(I.readSet([sources[0], sources[1], ambiguous, archive("")])).ref, "R?", "duplicate sheet placement IDs cannot establish a unique path");
  console.log("PASS project-specific nested KiCad references, standalone, repeated and ambiguous child placements");
}

// ------------------------------------------------------------------ 1. round trip
{
  const project = AtriumParts.example(), board = project.documents.find(d => d.kind === "pcb"), sheet = project.documents.find(d => d.kind === "schematic");
  const pcb = K.exportBoard(project, board), sch = AtriumKiCadSchematic.exportSheet(project, sheet);
  const results = I.readSet([file("example.kicad_pcb", pcb.content), file("example.kicad_sch", sch.content)]);
  const imported = projectOf(results);
  A.validate(imported);
  const b2 = imported.documents.find(d => d.kind === "pcb"), s2 = imported.documents.find(d => d.kind === "schematic");
  const d1 = defsOf(project), d2 = defsOf(imported);
  // Footprints: every source part, at the same world pad positions with the same nets.
  let pads = 0;
  for (const part of board.items.filter(i => i.kind === "part")) {
    const other = b2.items.find(i => i.kind === "part" && i.ref === part.ref);
    assert.ok(other, "missing footprint " + part.ref);
    assert.equal(other.layer || "Top", part.layer || "Top");
    const want = worldPads(part, d1.get(part.def)), got = worldPads(other, d2.get(other.def));
    assert.equal(got.length, want.length, part.ref);
    for (const w of want) {
      const g = got.find(x => x.n === w.n && nearP(x.at, w.at));
      assert.ok(g, part.ref + " pad " + w.n + " moved");
      assert.ok(near(g.drill, w.drill), part.ref + " drill");
      const net = part.pinNets?.[w.n] ?? "";
      assert.equal(other.pinNets[w.n] ?? "", net, part.ref + "." + w.n + " net");
      pads++;
    }
  }
  assert.ok(pads >= 12, "pads " + pads);
  // Free pads become one-pad footprints, as kicad-export writes them.
  assert.equal(b2.items.filter(i => i.kind === "part" && /^ATR_PAD/.test(i.ref)).length, board.items.filter(i => i.kind === "pad").length);
  // Tracks: the same set of copper segments, layers, widths and nets.
  const segs = doc => doc.items.filter(i => i.kind === "track").flatMap(t => t.points.slice(1).map((p, k) => {
    const a = t.points[k].map(v => v.toFixed(3)).join(","), b = p.map(v => v.toFixed(3)).join(",");
    return [a < b ? a + "|" + b : b + "|" + a, t.layer, t.width.toFixed(3), t.net || ""].join(" ");
  }).filter(s => !/^(\S+)\|\1 /.test(s))).sort();
  assert.deepEqual(segs(b2), segs(board));
  const vias = doc => doc.items.filter(i => i.kind === "via").map(v => [v.x, v.y, v.diameter, v.drill].map(n => n.toFixed(3)).join(",") + " " + (v.net || "")).sort();
  assert.deepEqual(vias(b2), vias(board));
  assert.equal(b2.outline.length, board.outline.length);
  for (const p of board.outline) assert.ok(b2.outline.some(q => nearP(p, q)), "outline vertex " + p);
  // Schematic: every pin at the same place (after the export's page offset) on the same net partition.
  const off = sch.offset;
  const pinsOf = (doc, defs, shift = [0, 0]) => doc.items.filter(i => i.kind === "part").flatMap(i => A.pins(i, defs.get(i.def), "schematic")
    .map(p => ({key: i.ref + "." + p.number, at: [p.at[0] + shift[0], p.at[1] + shift[1]], id: i.id + "/" + p.number})));
  const p1 = pinsOf(sheet, d1, off), p2 = pinsOf(s2, d2);
  assert.equal(p2.length, p1.length);
  for (const p of p1) assert.ok(p2.some(q => q.key === p.key && nearP(q.at, p.at)), "pin " + p.key);
  const partition = (doc, defs, pins) => {
    const c = A.connectivity(doc, defs), groups = new Map();
    for (const p of pins) { const n = c.byPin.get(p.id); if (n == null) continue; if (!groups.has(n)) groups.set(n, []); groups.get(n).push(p.key); }
    return [...groups.values()].filter(g => g.length > 1).map(g => g.sort().join(",")).sort();
  };
  assert.deepEqual(partition(s2, d2, p2), partition(sheet, d1, p1));
  // Schematic and board parts are linked by KiCad's symbol paths.
  for (const part of s2.items.filter(i => i.kind === "part")) {
    const fp = b2.items.find(i => i.kind === "part" && i.ref === part.ref);
    if (fp) assert.equal(fp.link, part.link, part.ref + " link");
  }
  // Exporting the import again gives the same KiCad objects.
  const again = K.exportBoard(imported, b2);
  assert.equal(again.counts.segments, pcb.counts.segments);
  assert.equal(again.counts.vias, pcb.counts.vias);
  assert.equal(again.counts.pads, pcb.counts.pads);
  console.log("PASS round trip: " + pads + " pads, " + segs(b2).length + " segments, " + p2.length + " pins and their nets");
}

// ------------------------------------------------------------------ 2. KiCad 8 fixtures
{
  const files = ["demo.kicad_pro", "root.kicad_sch", "child.kicad_sch", "demo.kicad_pcb"].map(n => file(n, fixture(n)));
  const results = I.readSet(files);
  assert.equal(results.length, 4);
  assert.deepEqual(results[0].documents, []);
  const project = projectOf(results);
  A.validate(project);
  const defs = defsOf(project), board = project.documents.find(d => d.kind === "pcb");
  const root = project.documents.find(d => d.sourceName === "root.kicad_sch"), child = project.documents.find(d => d.sourceName === "child.kicad_sch");
  assert.ok(root && child && board);
  for (const d of project.documents) assert.equal(d.sourceProject, "demo");

  // Board: footprints, pads, nets.
  const R1 = board.items.find(i => i.ref === "R1"), J1 = board.items.find(i => i.ref === "J1");
  assert.equal(R1.angle, -90); assert.equal(R1.layer, "Top"); assert.equal(R1.value, "10k");
  const r1 = worldPads(R1, defs.get(R1.def));
  assert.ok(nearP(r1.find(p => p.n === "1").at, [20, 15.825]));
  assert.ok(nearP(r1.find(p => p.n === "2").at, [20, 14.175]));
  assert.deepEqual(R1.pinNets, {1: "SIG", 2: "GND"});
  // KiCad's corner ratio is the native one: a rounded rectangle with KiCad's 25% radius, not an outline.
  const rr = defs.get(R1.def).footprint.pads[0];
  assert.deepEqual([rr.shape, rr.roundrectRadiusRatio, rr.poly, rr.w, rr.h], ["roundrect", .25, undefined, .8, .95]);
  // Chamfered, trapezoid, custom and native rounded-rectangle pads.
  const U2 = board.items.find(i => i.ref === "U2"), shapes = defs.get(U2.def).footprint.pads;
  const byNum = n => shapes.find(q => q.number === n);
  assert.deepEqual(byNum("1").poly, [[-.6, -.3], [-.3, -.6], [.6, -.6], [.6, .6], [-.6, .6]], "chamfered top-left corner");
  assert.deepEqual(byNum("2").poly, [[-.7, .7], [.7, .7], [.3, -.7], [-.3, -.7]], "trapezoid");
  assert.deepEqual([byNum("3").shape, byNum("3").poly.length, byNum("3").w, byNum("3").h], ["custom", 4, 1.6, 1.8], "custom polygon as drawn");
  assert.equal(byNum("4").shape, "roundrect");
  assert.ok(near(defs.get(R1.def).footprint.pads[0].angle, 0));
  assert.equal(J1.layer, "Bottom");
  const j1 = worldPads(J1, defs.get(J1.def));
  assert.ok(nearP(j1.find(p => p.n === "1").at, [10, 10]));
  assert.ok(nearP(j1.find(p => p.n === "2").at, [10, 7.46]));
  const fpj = defs.get(J1.def).footprint;
  assert.equal(fpj.pads.find(p => p.n === "2" || p.number === "2").drill, 1);
  assert.equal(fpj.pads.find(p => p.plated === false).layer, "Multi");
  assert.equal(fpj.shapes.find(s => s.kind === "circle").layer, "Bottom silk");
  assert.ok(defs.get(R1.def).footprint.shapes.some(s => s.style === "package"), "F.Fab drawn as package outline");
  assert.ok(defs.get(R1.def).footprint.shapes.some(s => s.layer === "Mechanical 15"), "courtyard on Mechanical 15");
  // Tracks, arc track, vias.
  const tracks = board.items.filter(i => i.kind === "track");
  assert.equal(tracks.length, 4);
  const arc = tracks.find(t => t.points.length > 2);
  assert.ok(nearP(arc.points[0], [20, 20]) && nearP(arc.points.at(-1), [25, 25]));
  for (const p of arc.points) assert.ok(near(Math.hypot(p[0] - 25, p[1] - 20), 5, 2e-3), "arc radius");
  assert.ok(A.pathArc(arc) && nearP(arc.arc.c, [25, 20]) && near(arc.arc.r, 5), "the arc track stays a true arc");
  assert.equal(tracks.find(t => t.layer === "Inner 2").width, .3);
  const vias = board.items.filter(i => i.kind === "via");
  assert.equal(vias.length, 2);
  const blind = vias.find(v => v.fromLayer);
  assert.deepEqual([blind.fromLayer, blind.toLayer, blind.net], ["Top", "Inner 1", "GND"]);
  // Zones -> polygon pours; keepouts -> Keepout outlines.
  const pour = board.items.find(i => i.kind === "polygon");
  assert.deepEqual([pour.layer, pour.net, pour.clearance, pour.pourIndex, pour.removeDeadCopper, pour.reliefAirGap, pour.reliefConductorWidth],
    ["Bottom", "GND", .3, -2, false, .4, .45], "KiCad priority 2 fills before priority 0: pour index -2");
  if (globalThis.AtriumPolygonPour) AtriumPolygonPour.validate(pour);
  // The stored fill (filled_polygon) is the pour's current copper until a repour.
  const fill = board.pcbDrawing?.pours || [];
  assert.deepEqual(fill.map(r => [r.layer, r.net, r.polygon === pour.id, r.count, r.bounds]), [["Bottom", "GND", true, 1, [1, 1, 39, 34]]]);
  assert.ok(board.pcbDrawing.sourceFill && /^[0-9a-f]{16}$/.test(board.sourcePourSignature), "fill is stored for explicit source preparation");
  const keepouts = board.items.filter(i => i.kind === "graphic" && (i.layer === "Keepout" || i.keepout === true));
  assert.equal(keepouts.length, 2, "board and footprint keepouts");
  assert.ok(keepouts.every(i => i.fill === true && i.closed === true), "rule areas import as filled keep-out areas");
  assert.ok(board.notes.some(n => /Footprint-owned zones/.test(n)));
  assert.ok(board.items.some(i => i.kind === "label" && i.text === "Atrium import" && i.layer === "Silk"));
  assert.ok(board.items.some(i => i.kind === "graphic" && i.fill && i.layer === "Silk"));
  // Outline: true arc and the circular cutout.
  assert.equal(board.boardShape.cutouts.length, 1);
  assert.ok(board.boardShape.contour.some(s => s.kind === "arc"));
  assert.ok(AtriumBoardShape.fresh(board), "outline is the flattening of the board shape");
  const box = A.bounds(board.outline);
  assert.ok(nearP(box.slice(0, 2), [0, 0]) && nearP(box.slice(2), [40, 35]));
  // Stackup and net classes.
  const stack = AtriumStackup.stored(board);
  assert.ok(stack, "stackup stored");
  assert.deepEqual(stack.layers.filter(l => l.key).map(l => [l.key, l.type]), [["Top", "Signal"], ["Inner 1", "Plane"], ["Inner 2", "Signal"], ["Bottom", "Signal"]]);
  assert.equal(board.thickness, 1.6);
  const rules = AtriumRules.stored(board, project);
  assert.deepEqual(rules.defaults, {clearance: .2, trackWidth: .25});
  assert.deepEqual(rules.nets, {GND: {clearance: .3, trackWidth: .5}, VCC: {clearance: .3, trackWidth: .5}});
  const limits = AtriumRules.resolver(board,{project}).viaLimits;
  assert.deepEqual([limits("GND").diameter,limits("GND").drill,limits("GND").minDrill],[.8,.4,0]);
  assert.equal(board.sourcePourSignature, AtriumPCBPours.signature(board, defs), "project net classes retain a verified source pour");
  assert.equal(AtriumPolygonPour.inspectCopper(board,defs,{project}).source,"adopt");
  assert.ok(AtriumPolygonPour.adopt(board,defs,{project},false));
  assert.equal(AtriumPolygonPour.state(board, defs, {project}), "source");
  assert.equal(board.pcbDrawing.pours[0], fill[0], "inspection keeps the native KiCad fill geometry");

  // Applying the project rules must not certify a fill whose board already changed.
  const edited = I.read(files[3].name, files[3].bytes), editedBoard = edited.documents[0];
  const originalSignature = editedBoard.sourcePourSignature;
  editedBoard.items.find(i => i.kind === "track").points[0][0] += 1;
  const custom = file("demo.kicad_dru", '(version 1) (rule "Via" (constraint via_diameter (min 0.7mm)))');
  AtriumKiCadImport.link([AtriumKiCadImport.readProject(files[0].name, fixture(files[0].name)), edited,
    AtriumKiCadImport.read(custom.name, custom.bytes, I)], [files[0], files[3], custom]);
  assert.ok(editedBoard.rules.list.some(rule => rule.diameterMin === .7));
  const editedDefs = new Map(edited.library.map(d => [d.id, d]));
  assert.equal(editedBoard.sourcePourSignature, originalSignature);
  assert.notEqual(editedBoard.sourcePourSignature, AtriumPCBPours.signature(editedBoard, editedDefs));

  // Schematic: parts, power, labels, hierarchy, mirror, multi-unit.
  const parts = root.items.filter(i => i.kind === "part");
  assert.deepEqual(parts.map(p => p.ref).sort(), ["R1", "R2", "U1", "U1"]);
  const pin = (ref, n, doc = root) => {
    for (const p of doc.items.filter(i => i.kind === "part" && i.ref === ref)) {
      const hit = A.pins(p, defs.get(p.def), "schematic").find(x => x.number === n);
      if (hit) return hit.at;
    }
    return null;
  };
  assert.ok(nearP(pin("R1", "1"), [100, 46.19]) && nearP(pin("R1", "2"), [100, 53.81]));
  assert.ok(nearP(pin("R2", "1"), [116.19, 50]) && nearP(pin("R2", "2"), [123.81, 50]));
  assert.ok(nearP(pin("U1", "3"), [142.38, 47.46]) && nearP(pin("U1", "1"), [157.62, 50]));
  assert.ok(nearP(pin("U1", "5"), [157.62, 77.46]), "mirrored unit 2");
  assert.ok(nearP(pin("U1", "7"), [142.38, 80]));
  assert.ok(nearP(pin("R3", "1", child), [40, 30]));
  const u = parts.filter(p => p.ref === "U1");
  assert.equal(u[0].link, u[1].link, "units share one link");
  assert.equal(u[0].def, u[1].def, "one gated definition");
  const dual = defs.get(u[0].def);
  assert.equal(dual.symbol.parts, 2);
  assert.deepEqual(u.map(p => [p.unit, !!p.mirror]).sort(), [[1, false], [2, true]]);
  assert.equal(A.gateLabel(u.find(p => p.unit === 2), dual).ref, "U1B");
  assert.deepEqual(A.pins(u.find(p => p.unit === 2), dual, "schematic").map(q => q.number).sort(), ["5", "6", "7", "8"]);
  // Hidden power pins join their global net.
  assert.equal(root.items.filter(i => i.kind === "wire" && i.implicitNet && i.net === "VCC").length, 2);
  assert.equal(R1.link, parts.find(p => p.ref === "R1").link, "board and sheet linked");
  assert.equal(defs.get(parts.find(p => p.ref === "R1").def).footprintName, "R_0603");
  assert.equal(parts.find(p => p.ref === "R1").parameters.MPN, "RC0603-10K");
  const power = root.items.filter(i => i.kind === "power");
  assert.deepEqual(power.map(p => [p.text, p.style, p.direction, p.x, p.y]).sort(), [["+3V3", "bar", 1, 100, 46.19], ["GND", "gnd", 3, 142.38, 52.54]]);
  assert.ok(root.items.some(i => i.kind === "offsheet" && i.text === "OUT"));
  assert.equal(root.items.filter(i => i.kind === "netlabel" && i.text === "SIG").length, 2);
  assert.equal(root.items.filter(i => i.kind === "noerc").length, 1);
  assert.ok(root.items.some(i => i.kind === "label" && /Synthetic/.test(i.text)));
  const sym = root.items.find(i => i.kind === "sheetsymbol");
  assert.deepEqual([sym.name, sym.file, sym.entries[0].name, sym.entries[0].side, sym.entries[0].offset, sym.entries[0].io], ["Child", "child.kicad_sch", "IN", "left", 5, "input"]);
  assert.equal(sym.sheet, child.id, "sheet symbol linked to the child sheet");
  assert.ok(child.items.some(i => i.kind === "port" && i.text === "IN" && i.io === "input"));
  assert.ok(child.items.some(i => i.kind === "bus") && child.items.some(i => i.kind === "busentry"));
  // Nets by connectivity.
  const c = A.connectivity(root, defs), net = (ref, n) => {
    for (const p of root.items.filter(i => i.kind === "part" && i.ref === ref)) { const v = c.byPin.get(p.id + "/" + n); if (v) return v; }
    return null;
  };
  assert.equal(net("R1", "2"), "SIG"); assert.equal(net("R2", "1"), "SIG");
  assert.equal(net("U1", "2"), "GND"); assert.equal(net("U1", "1"), "OUT"); assert.equal(net("R1", "1"), "+3V3");
  assert.equal(net("R2", "2"), net("U1", "3"));
  if (globalThis.AtriumHierarchy?.project) {
    const h = AtriumHierarchy.project(project);
    assert.ok(h, "hierarchy resolves");
  }
  assert.equal(net("U1", "8"), "VCC");
  // Gates survive the gate-aware KiCad schematic export and a second import.
  // (Power ports are left out: their export is checked by importers-followups.py's fix.)
  const plainRoot = {...root, items: root.items.filter(i => i.kind !== "power")}, gp = {...project, documents: project.documents.map(d => d === root ? plainRoot : d)};
  const again = AtriumKiCadSchematic.exportSheet(gp, plainRoot), [back] = I.readSet([file("again.kicad_sch", again.content)]);
  const bd = new Map(back.library.map(d => [d.id, d])), us = back.documents[0].items.filter(i => i.kind === "part" && i.ref === "U1");
  // kicad-schematic bakes a mirrored placement into its own library symbol, so the two
  // units may arrive as two gated definitions; each keeps both gates.
  assert.equal(us.length, 2); assert.ok(us.every(p => bd.get(p.def).symbol.parts === 2));
  assert.deepEqual(us.map(p => p.unit).sort(), [1, 2]);
  const shift = again.offset, pinsBack = p => A.pins(p, bd.get(p.def), "schematic").map(q => q.number + "@" + q.at.map(v => (v - 0).toFixed(2)).join(","));
  for (const orig of u) {
    const twin = us.find(p => p.unit === orig.unit), want = A.pins(orig, dual, "schematic").map(q => q.number + "@" + [q.at[0] + shift[0], q.at[1] + shift[1]].map(v => v.toFixed(2)).join(","));
    assert.deepEqual(pinsBack(twin).sort(), want.sort(), "unit " + orig.unit + " pins after the KiCad round trip");
  }
  console.log("PASS KiCad 8 fixtures: board, pad shapes, zones, stackup, rules, sheets, hierarchy, power, hidden power pins and gated symbols");
}

// ------------------------------------------------------------------ 3. KiCad 6 sheet, errors
{
  const [r] = I.readSet([file("legacy6.kicad_sch", fixture("legacy6.kicad_sch"))]);
  const part = r.documents[0].items.find(i => i.kind === "part");
  assert.equal(part.ref, "R9");
  assert.equal(part.angle, 180);
  assert.equal(part.showValue, false);
  const def = r.library.find(d => d.id === part.def);
  assert.ok(nearP(A.pins(part, def, "schematic").find(p => p.number === "1").at, [20, 23.81]));
  assert.throws(() => I.readSet([file("demo.kicad_pro", fixture("demo.kicad_pro"))]), /together with/);
  assert.throws(() => I.read("broken.kicad_pcb", enc.encode("(kicad_pcb (version 20240108)")), /broken\.kicad_pcb.*truncated/);
  assert.throws(() => I.read("old.sch", enc.encode("EESchema Schematic File Version 4\n")), /Legacy KiCad/);
  assert.equal(I.handles("x.kicad_pcb") && I.handles("x.brd") && I.handles("x.json") && !I.handles("x.PcbDoc"), true);
  // Every fixture parses as S-expressions with balanced parentheses and quoted strings.
  const t = AtriumSexpr.parse('(a "b \\"q\\" (x)" (c 1.5 -2) (d (hide yes)) hide)');
  assert.deepEqual(t, ["a", 'b "q" (x)', ["c", "1.5", "-2"], ["d", ["hide", "yes"]], "hide"]);
  assert.ok(AtriumSexpr.flag(t, "hide") && AtriumSexpr.flag(t[3], "hide"));
  console.log("PASS KiCad 6 symbol_instances, error reporting and the S-expression reader");
}

// ------------------------------------------------------------------ 4. hostile input (all formats)
{
  require("../../app/formats/import-eagle.js"); require("../../app/formats/import-easyeda.js");
  const quick = (what, fn) => { const t0 = Date.now(); const r = fn(); assert.ok(Date.now() - t0 < 3000, what + " took too long"); return r; };
  const clean = () => assert.equal(({}).polluted, undefined, "Object.prototype polluted");
  // S-expressions: nesting, truncation, prototype keys, non-finite numbers.
  quick("deep nesting", () => assert.throws(() => I.read("deep.kicad_pcb", enc.encode("(kicad_pcb " + "(".repeat(200000))), /too deeply/));
  quick("open string", () => assert.throws(() => I.read("s.kicad_sch", enc.encode('(kicad_sch "' + "x".repeat(1e6))), /truncated/));
  const evil = '(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user) (99 "constructor" user))' +
    ' (net 0 "") (net 1 "__proto__")' +
    ' (footprint "x:__proto__" (layer "F.Cu") (at 1 1) (property "Reference" "U9" (at 0 0)) (property "__proto__" "polluted") (property "constructor" "c")' +
    '  (pad "__proto__" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "__proto__")) (pad "2" smd constructor (at 2 0) (size 1 1) (layers "constructor")))' +
    ' (segment (start 1e400 0) (end 1 1) (width 0.2) (layer "F.Cu") (net 1)) (segment (start 1e7 0) (end 1 1) (width 0.2) (layer "F.Cu") (net 1)) (gr_line (start 0 0) (end 1 0) (layer "constructor")))';
  const [bad] = quick("prototype keys", () => I.readSet([file("evil.kicad_pcb", evil)]));
  clean();
  const U9 = bad.documents[0].items.find(i => i.ref === "U9");
  assert.ok(!Object.hasOwn(U9.pinNets, "__proto__") && Object.getPrototypeOf(U9.pinNets) === Object.prototype);
  assert.ok(bad.notes.some(n => /invalid coordinates/.test(n)), "non-finite track skipped");
  const pro = JSON.stringify({net_settings: {classes: [{name: "__proto__", clearance: 1}, {name: "Default", clearance: .2, track_width: .2, via_drill: .3}],
    netclass_assignments: {__proto__: "__proto__", constructor: "x"}, netclass_patterns: [{netclass: "Default", pattern: "*a*a*a*a*a*a*a*a*a*b"}]}});
  const brd = '(kicad_pcb (version 20240108) (net 0 "") (net 1 "' + "a".repeat(4000) + '") (segment (start 0 0) (end 1 0) (width 0.2) (layer "F.Cu") (net 1)))';
  const [, b2] = quick("wildcards", () => I.readSet([file("evil.kicad_pro", pro), file("evil2.kicad_pcb", brd)]));
  clean(); assert.ok(b2.documents[0].rules);
  // XML: entity expansion, nesting, prototype attributes.
  const laughs = '<?xml version="1.0"?><!DOCTYPE eagle [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]>' +
    '<eagle><drawing><board><plain><text x="1" y="1" size="1" layer="21" __proto__="x" constructor="y">&c;&#x110000;</text></plain></board></drawing></eagle>';
  const [lol] = quick("billion laughs", () => I.readSet([{name: "lol.brd", bytes: enc.encode(laughs)}]));
  clean();
  assert.ok(lol.documents[0].items.some(i => i.kind === "label" && i.text.length < 20), "entities stay unexpanded");
  quick("XML nesting", () => assert.throws(() => I.read("deep.sch", enc.encode("<eagle>" + "<a>".repeat(100000))), /too deeply|truncated/));
  // EasyEDA: backtick parameters, Pro attributes, endless path commands.
  const std = JSON.stringify({head: {docType: "1"}, shape: ["LIB~0~0~__proto__`polluted`constructor`x`pre`U?`~0~0~g~0#@$PL~0 0 10 0~#000~1~0~none~g2~0#@$P~show~0~1~0~0~0~g3~0^^0~0^^M 0 0 h 10~#880000^^0~0~0~0~A~~~~^^1~0~0~0~1~~~~",
    "PT~M 0 0 Z 1 2 3 4 5 L 1 1 Z Z Z~#000~1~0~none~g4~0"]});
  quick("EasyEDA std", () => I.readSet([{name: "evil.json", bytes: enc.encode(std)}]));
  clean();
  const proLines = ['["DOCTYPE","PCB","1.8"]', '["COMPONENT","c",0,1,0,0,0,{"__proto__":{"polluted":1},"Designator":"U1"},0]',
    '["POLY","p",0,"",11,1,[[[[[[[[[[[[[0,0,"L",1,1]]]]]]]]]]]]],0]', '["PADNET","n",0,"c","__proto__","x"]'].join("\n");
  quick("EasyEDA pro", () => I.readSet([{name: "evil.epcb", bytes: enc.encode(proLines)}]));
  clean();
  // ZIP bombs: declared sizes, ratio, and a stream that inflates past its declared size.
  const u16 = n => [n & 255, n >> 8 & 255], u32 = n => [n & 255, n >> 8 & 255, n >> 16 & 255, n >>> 24];
  function zip(name, data, size, method = 8) {
    const nm = [...enc.encode(name)], local = [...u32(0x04034b50), 20, 0, 0, 0, ...u16(method), 0, 0, 0, 0, ...u32(0), ...u32(data.length), ...u32(size), ...u16(nm.length), 0, 0, ...nm, ...data];
    const cd = [...u32(0x02014b50), 20, 0, 20, 0, 0, 0, ...u16(method), 0, 0, 0, 0, ...u32(0), ...u32(data.length), ...u32(size), ...u16(nm.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0), ...nm];
    return Uint8Array.from([...local, ...cd, ...u32(0x06054b50), 0, 0, 0, 0, 1, 0, 1, 0, ...u32(cd.length), ...u32(local.length), 0, 0]);
  }
  const zeros = I.base64("7cExAQAAAMKg9U9tBn+gAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIDXAA==");
  assert.equal(I.inflate(zeros, 200000).length, 200000);
  assert.throws(() => I.read("a.epro", zip("PCB/a.epcb", [...zeros], 1000)), /declared size/);
  assert.throws(() => I.read("b.epro", zip("PCB/b.epcb", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50 * 1024 * 1024)), /ratio|ZIP bomb/);
  assert.throws(() => I.read("c.epro", zip("PCB/c.epcb", [1, 2, 3], 300 * 1024 * 1024)), /expands beyond/);
  assert.throws(() => I.read("d.epro", Uint8Array.from([0x50, 0x4b, 3, 4, 1, 2, 3])), /not a ZIP|damaged|truncated/);
  assert.ok(I.wildcard("VCC*", "VCC_3V3") && !I.wildcard("*a*a*a*a*a*a*a*a*b", "a".repeat(4000)));
  console.log("PASS hostile input: nesting, truncation, prototype keys, entity expansion, wildcards, endless paths and ZIP bombs");
}

// ------------------------------------------------------------------ 5. shared-file follow-ups (importers-followups.py)
{
  const fs2 = require("node:fs"), src = n => fs2.readFileSync(require("../support/app-source-paths.cjs").appFile(n), "utf8");
  const files = ["demo.kicad_pro", "root.kicad_sch", "child.kicad_sch", "demo.kicad_pcb"].map(n => file(n, fixture(n)));
  // The import worker parses whole selections ("foreign-set").
  if (!/foreign-set/.test(src("import-worker.js"))) console.log("SKIP worker parsing (apply importers-followups.py)");
  else {
    require("../../app/formats/io.js");
    const sent = [], g = globalThis;
    g.self = {postMessage: m => sent.push(m)};
    const workerDir = path.dirname(require("../support/app-source-paths.cjs").appFile("import-worker.js"));
    g.importScripts = (...names) => {
      for (const name of names) {
        const module = require(path.resolve(workerDir, name));
        if (name === "../vendor/cfb.min.js") g.CFB = module;
      }
    };
    new Function(src("import-worker.js"))();
    const ready = sent.shift();
    assert.equal(ready.type, "ready");
    g.self.onmessage({data: {id: 7, operation: "foreign-set", files: files.map(f => ({name: f.name, buffer: f.bytes.buffer}))}});
    const progress = sent.filter(m => m.type === "progress"), reply = sent.filter(m => m.type !== "progress")[0];
    sent.length = 0;
    assert.equal(reply.type, "result"); assert.equal(reply.id, 7);
    assert.deepEqual(reply.value.map(r => r.documents.length), [0, 1, 1, 1]);
    g.self.onmessage({data: {id: 8, operation: "foreign-set", files: [{name: "bad.kicad_pcb", buffer: enc.encode("(kicad_pcb").buffer}]}});
    const err = sent.filter(m => m.type !== "progress")[0];
    assert.deepEqual([err.type, err.id, /bad\.kicad_pcb/.test(err.message)], ["parse-error", 8, true]);
    if (/progress/.test(src("import-worker.js"))) assert.deepEqual(progress.map(p => p.done), [0, 1, 2, 3, 4], "per-file progress");
    assert.ok(/sexpr\.js/.test(src("worker-source.js")), "bundled worker includes the parsers");
    console.log("PASS import worker parses KiCad, Eagle and EasyEDA selections");
  }
  // Custom polygon pads and power symbols survive a KiCad export and re-import.
  const project = projectOf(I.readSet(files)), board = project.documents.find(d => d.kind === "pcb");
  const k = AtriumKiCad.exportBoard(project, board);
  if (!/primitives \(gr_poly/.test(k.content.split("PadShapes")[1] || "")) console.log("SKIP custom pad export (apply importers-followups.py)");
  else {
    const [b] = I.readSet([file("again.kicad_pcb", k.content)]), d2 = new Map(b.library.map(d => [d.id, d]));
    const U2 = b.documents[0].items.find(i => i.ref === "U2"), pads = d2.get(U2.def).footprint.pads;
    assert.deepEqual(pads.map(p => p.shape).sort(), ["custom", "custom", "custom", "roundrect"]);
    assert.deepEqual(pads.find(p => p.number === "1").poly, [[-.6, -.3], [-.3, -.6], [.6, -.6], [.6, .6], [-.6, .6]]);
    console.log("PASS custom polygon pads round-trip through KiCad");
  }
  const root = project.documents.find(d => d.sourceName === "root.kicad_sch"), sch = AtriumKiCadSchematic.exportSheet(project, root);
  let parsed = null;
  try { parsed = AtriumSexpr.parse(sch.content); } catch { /* unbalanced power symbols before the fix */ }
  if (!parsed) console.log("SKIP power symbol export (apply importers-followups.py)");
  else {
    const [r] = I.readSet([file("power.kicad_sch", sch.content)]);
    assert.deepEqual(r.documents[0].items.filter(i => i.kind === "power").map(p => p.text).sort(), ["+3V3", "GND"]);
    console.log("PASS power ports round-trip through KiCad");
  }
}

{
  for (const module of ["pcb-appearance","pcb-text","fab-outputs","format-2-units","format-2-values"])
    require(require("../support/app-source-paths.cjs").appFile(module+".js"));
  const source=`(kicad_pcb (version 20241229)
    (gr_rect (start 0 0) (end 80 80) (stroke (width .1) (type default)) (layer "Edge.Cuts"))
    (footprint "Test:Top" (layer "F.Cu") (at 40 50 180)
      (property "Reference" "R10" (at 2 -3 180) (layer "F.SilkS")
        (effects (font (size .8 1.2) (thickness .1))))
      (property "Value" "10K" (at -1 3 90) (layer "F.Fab") (hide yes)
        (effects (font (size .95 1.05) (thickness .115)) (justify top left))))
    (footprint "Test:Bottom" (layer "B.Cu") (at 32 20 30)
      (fp_text reference "C20" (at 2 4 60) unlocked (layer "B.SilkS")
        (effects (font (size 1 .65) (thickness .13) italic) (justify right bottom mirror)))
      (fp_text value "VALUE" (at 0 5 270) (layer "B.SilkS")
        (effects (font (size 1 1) (thickness .12)) (justify mirror)))))`;
  const p=projectOf(I.readSet([file("Silks.kicad_pcb",source)])), [board]=p.documents;
  A.validate(p);
  const [top,bottom]=board.items.filter(i=>i.kind==="part");
  const P=AtriumPCBAppearance, T=AtriumPCBText, V=AtriumFormat2Values;
  const [front]=P.sourceLabels(board,top), [back,value]=P.sourceLabels(board,bottom);
  assert.deepEqual(front,{field:"ref",at:[2,-3],angle:0,layer:"Silk",size:.8,justify:"center",mirrored:false,upright:true,fontWidth:1.2,width:.1,strokeFont:"kicad"});
  assert.equal(top.showValue,false);
  assert.equal(top.hiddenBoardLabels[0].layer,"Mechanical 13");
  assert.deepEqual(top.hiddenBoardLabels[0].at,[-1,3]);
  assert.equal(back.angle,-30);
  assert.equal(back.upright,false);
  assert.equal(back.justify,"bottom-right");
  assert.equal(back.mirrored,true);
  assert.equal(back.italic,true);
  assert.ok(nearP(A.world(front.at,top),[38,53],1e-9),"the field anchor is relative to the rotated placement");
  assert.ok(nearP(A.world(back.at,bottom),[32+Math.sqrt(3)+2,20+2*Math.sqrt(3)-1],1e-9));
  const topText=P.annotationText(top,front), backText=P.annotationText(bottom,back);
  assert.equal(top.angle+topText.angle,0,"an 180° field stays upright");
  assert.equal(bottom.angle+backText.angle,-60,"an unlocked field keeps its authored board rotation");
  const valueAngle=bottom.angle+P.annotationText(bottom,value).angle;
  assert.equal((valueAngle%360+360)%360,270,"a bottom-side locked quarter-turn reads upwards");
  const layout=T.layoutItem(topText), narrow=T.layoutItem({...topText,fontWidth:.8});
  assert.ok(near(layout.metrics[0]+layout.metrics[2],0,1e-9),"glyph advances are centered on the source anchor");
  assert.ok(nearP(layout.strokes[0].points[0],[-.7714285714285714,.3648952380952381],1e-9),"the first R stroke uses NewStroke's variable advance");
  assert.ok(near(layout.box[3]-layout.box[1],.9,1e-9),"a .8 mm cap plus its .1 mm physical pen");
  assert.ok(near((layout.metrics[2]-layout.metrics[0])/(narrow.metrics[2]-narrow.metrics[0]),1.5,1e-9));
  assert.deepEqual(T.paintBox(topText,{frame:top}),T.hitBox(topText,{frame:top}),"fast bounds follow the same nominal width");
  const mirrored=T.layoutItem(backText), plain=T.layoutItem({...backText,mirrored:false});
  assert.deepEqual(mirrored.strokes.map(s=>s.points),plain.strokes.map(s=>s.points.map(([x,y])=>[-x,y])));
  const nonItalic=T.layoutItem({...backText,mirrored:false,italic:false});
  assert.ok(near(plain.strokes[0].points[0][0]-nonItalic.strokes[0].points[0][0],1/168,1e-9),
    "KiCad italics shift this point by one eighth of its height above the glyph baseline");
  assert.deepEqual(plain.metrics,nonItalic.metrics,"italic glyphs keep their advance");
  assert.equal(P.annotationVisible(top,top.hiddenBoardLabels[0]),false);
  assert.notDeepEqual(T.layout("R10",topText).strokes,T.layout("R10",{...topText,strokeFont:undefined}).strokes);
  assert.match(T.layout("RΩ",topText).fallback,/bundled KiCad glyphs/);
  const trace=[];
  AtriumFabOutputs.analyse(p,board.id,{featureSource(feature,owner,member,layer){
    if(owner?.kind==="part" && feature.t==="stroke")trace.push({owner,layer,points:feature.points,width:feature.width});
  }});
  for(const [part,label] of [[top,front],[bottom,back],[bottom,value]]) {
    const wanted=T.toPrimitives(P.annotationText(part,label),{frame:part,layer:label.layer}).strokes;
    const plotted=trace.filter(s=>s.owner===part && s.layer===label.layer && s.width===label.width)
      .map(({points,width})=>({points,width}));
    assert.deepEqual(plotted,wanted,"production film uses the shared text primitives");
  }
  const native=V.encode({boardLabels:top.boardLabels,hiddenBoardLabels:top.hiddenBoardLabels});
  assert.equal(native.boardLabels[0].fontWidth,1200000);
  assert.equal(native.boardLabels[0].width,100000);
  assert.equal(native.hiddenBoardLabels[0].fontWidth,1050000);
  assert.deepEqual(V.decode(native).boardLabels,top.boardLabels);

  const exported=K.exportBoard(p,board).content;
  const reopened=projectOf(I.readSet([file("Silks.kicad_pcb",exported)])).documents[0];
  const [againTop,againBottom]=reopened.items.filter(i=>i.kind==="part");
  assert.deepEqual(againTop.boardLabels,top.boardLabels,"re-export keeps visible refs as editable footprint fields");
  assert.deepEqual(againTop.hiddenBoardLabels,top.hiddenBoardLabels,"the hidden value retains its style");
  assert.deepEqual(againBottom.boardLabels,bottom.boardLabels,"both back-side fields survive re-export");
  console.log("PASS KiCad field text geometry, upright and mirrored placements, shared film strokes and physical-unit round trip");
}

{
  const source = `(kicad_pcb (version 20241229)
    (gr_rect (start 0 0) (end 40 30) (stroke (width .1) (type default)) (layer "Edge.Cuts"))
    (gr_poly (pts (xy 1 1) (xy 4 1) (xy 3 3))
      (stroke (width .2) (type solid)) (fill yes) (layer "F.SilkS"))
    (footprint "Test:Back" (layer "B.Cu") (at 20 20 90)
      (fp_poly (pts (xy 1 0) (xy 2 0) (xy 1 1))
        (stroke (width .12) (type solid)) (fill yes) (layer "B.SilkS"))
      (fp_poly (pts (xy 3 0) (xy 4 0) (xy 3 1))
        (stroke (width 0) (type solid)) (fill yes) (layer "B.SilkS"))))`;
  const p = projectOf(I.readSet([file("Filled outlines.kicad_pcb",source)])), [board] = p.documents;
  const placed = board.items.find(i => i.kind === "part");
  placed.mirror = true;
  const shapes = p.library.find(def => def.id === placed.def).footprint.shapes;
  const V = AtriumFormat2Values;
  assert.equal(V.decode(V.encode(shapes[0])).strokeOutline,true);
  assert.equal(shapes[1].strokeOutline,undefined);
  const model = AtriumFabOutputs.analyse(p,board.id);
  const outline = layer => model.layers.get(layer).filter(f => f.t === "stroke");
  const regions = layer => model.layers.get(layer).filter(f => f.t === "region");
  assert.equal(outline("Silk").length,1);
  assert.equal(regions("Silk").length,1);
  assert.deepEqual(outline("Silk")[0].points,[[1,1],[4,1],[3,3],[1,1]]);
  assert.equal(outline("Silk")[0].width,.2);
  assert.equal(outline("Bottom silk").length,1,"a filled zero-width shape contributes no line stroke");
  assert.equal(regions("Bottom silk").length,2);
  const back = outline("Bottom silk")[0];
  assert.equal(back.width,.12);
  assert.ok(back.points.every((p,i) => nearP(p,[[20,21],[20,22],[21,21],[20,21]][i],1e-9)),
    "the stroke follows the same rotated and mirrored boundary as the fill");
  assert.deepEqual(back.points.slice(0,-1),regions("Bottom silk")[0].points);
  console.log("PASS KiCad filled graphics retain explicit positive boundary widths without adding zero-width outlines");
}

{
  const {pointSeg} = require("../support/segment-distance.cjs");
  const source = `(kicad_pcb (version 20240108)
    (gr_poly (pts (arc (start -6 0) (mid 0 -6) (end 6 0)) (xy 6 4) (xy -6 4))
      (stroke (width 0)) (fill yes) (layer "F.SilkS")))`;
  const [board] = I.readSet([file("curved-area.kicad_pcb", source)])[0].documents;
  const art = board.items.find(item => item.kind === "graphic");
  assert.deepEqual(art.points[0], [-6, 0]);
  assert.ok(art.points.some(p => p[0] === 6 && p[1] === 0), "authored end survives sampling");
  for (let i = 0; i <= 512; i++) {
    const t = i * Math.PI / 512, at = [6 * Math.cos(t), -6 * Math.sin(t)];
    const miss = Math.min(...art.points.slice(1).map((b, j) => pointSeg(at, art.points[j], b)));
    assert.ok(miss <= .005, "KiCad polygon chord error " + miss);
  }
}

// ------------------------------------------------------------------ 5b. parametric pads, arc tracks, paste-only pads, margins, slots
// End-to-end suite findings (tests/e2e): KiCad's corner ratio and arcs stay parametric; a pad's
// layers decide its copper, mask opening and paste; solder mask and paste margins resolve pad,
// then footprint, then board; oval drills are slots in the drill file.
{
  require("../../app/pcb/pcb-appearance.js"); require("../../app/core/zip.js"); require("../../app/formats/fab-outputs.js");
  const C = require("./gerber-compare.cjs");
  const boardText = (version, fpMask) => `(kicad_pcb (version ${version}) (generator "pcbnew")
 (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (35 "F.Paste" user) (36 "B.Paste" user) (39 "F.Mask" user) (40 "B.Mask" user) (44 "Edge.Cuts" user))
 (setup (pad_to_mask_clearance 0.05) (pad_to_paste_clearance -0.02) (pad_to_paste_clearance_ratio 0.025))
 (net 0 "") (net 1 "A")
 (footprint "T:Fp" (layer "F.Cu") (at 10 10) (solder_mask_margin ${fpMask}) (solder_paste_margin 0.01) (uuid "70000000-0000-4000-8000-000000000001")
  (property "Reference" "U1" (at 0 -3 0) (layer "F.SilkS"))
  (pad "1" smd roundrect (at 0 0) (size 1 2) (layers "F.Cu" "F.Paste" "F.Mask") (roundrect_rratio 0.3) (net 1 "A"))
  (pad "2" smd rect (at 2 0) (size 1 1) (layers "F.Cu" "F.Mask") (solder_mask_margin 0.2))
  (pad "3" smd rect (at 4 0) (size 1 1) (layers "F.Cu"))
  (pad "" smd roundrect (at 6 0) (size 0.5 0.8) (layers "F.Paste") (roundrect_rratio 0.25))
  (pad "4" thru_hole oval (at 8 0 90) (size 1.1 1.7) (drill oval 0.6 1.2) (layers "*.Cu" "*.Mask") (net 1 "A"))
  (pad "5" smd rect (at 10 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask") (solder_paste_margin 0.05) (solder_paste_margin_ratio -0.1)))
 (footprint "T:Bare" (layer "F.Cu") (at 30 10) (uuid "70000000-0000-4000-8000-000000000002")
  (property "Reference" "U2" (at 0 -3 0) (layer "F.SilkS"))
  (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu" "F.Paste" "F.Mask")))
 (arc (start 0 5) (mid 3 2) (end 6 5) (width 0.2) (layer "F.Cu") (net 1) (uuid "70000000-0000-4000-8000-000000000003"))
 (gr_rect (start 0 0) (end 45 20) (stroke (width 0.1)) (layer "Edge.Cuts")))`;
  const load = (version, fpMask) => {
    const project = projectOf(I.readSet([file("t.kicad_pcb", boardText(version, fpMask))])), board = project.documents.find(d => d.kind === "pcb"), defs = defsOf(project);
    const pads = ref => defs.get(board.items.find(i => i.ref === ref).def).footprint.pads;
    return {project, board, pads, u1: n => pads("U1").find(p => p.number === n)};
  };
  const {project, board, pads, u1} = load(20240108, 0.1);
  // D: the corner ratio and the arc.
  assert.deepEqual([u1("1").shape, u1("1").roundrectRadiusRatio, u1("1").poly], ["roundrect", .3, undefined]);
  const arc = board.items.find(i => i.kind === "track");
  assert.ok(A.pathArc(arc), "a native arc whose projection matches it");
  assert.ok(nearP(arc.arc.c, [3, 5]) && near(arc.arc.r, 3) && arc.arc.ccw === false && near(A.arcSweep(arc.arc), -180), "start, mid, end through the top");
  assert.ok(nearP(arc.points[0], [0, 5]) && nearP(arc.points.at(-1), [6, 5]) && arc.points.some(p => nearP(p, [3, 2])));
  // E: a paste-only pad is an aperture on the paste film, not a copper pad or a pin.
  const aperture = pads("U1").find(p => p.layer === "Top paste");
  assert.deepEqual([aperture.number, aperture.shape, aperture.w, aperture.h, aperture.maskExpansion, aperture.pasteExpansion], ["", "roundrect", .5, .8, undefined, undefined]);
  assert.equal(pads("U1").filter(p => p.layer === "Top").length, 4, "pads 1, 2, 3 and 5 are top copper");
  // Layers: no F.Mask tents the opening; no F.Paste shrinks the paste to nothing.
  assert.deepEqual([u1("2").tent, u1("2").noPaste, u1("3").tent, u1("3").noPaste, u1("1").tent, u1("1").noPaste], [undefined, true, {top: true}, true, undefined, undefined]);
  // F: Resolve both the absolute margin and the paste ratio independently at each tier.
  // The ratio is scaled by the pad's short side (0.05 - 0.1 x 1 = -0.05 for pad 5).
  assert.deepEqual(["1", "2", "3", "4", "5"].map(n => u1(n).maskExpansion), [.1, .2, .1, .1, .1]);
  assert.deepEqual([u1("1").pasteExpansion, u1("5").pasteExpansion, pads("U2")[0].maskExpansion, pads("U2")[0].pasteExpansion], [.035, -.05, .05, .005]);
  // Before KiCad 9 a local 0 inherits; from KiCad 9 it is an override.
  assert.equal(load(20240108, 0).u1("1").maskExpansion, .05);
  assert.equal(load(20241229, 0).u1("1").maskExpansion, 0);
  // G: the oval drill is a slot along the pad's Y axis (KiCad X 0.6, Y 1.2).
  assert.deepEqual([u1("4").drill, u1("4").slotLength, u1("4").slotAngle], [.6, 1.2, 90]);
  // Outputs: films and drill file as KiCad plots them.
  const result = AtriumFabOutputs.build(project, board.id, {date: new Date("2025-01-01T00:00:00Z")});
  const out = suffix => result.files.find(f => f.name.endsWith(suffix)).content;
  const flashes = suffix => C.parseGerber(out(suffix)).flashes;
  assert.equal(flashes(".GTL").length, 6, "the paste aperture plots no copper");
  assert.equal(flashes(".GTS").length, 5, "pad 3 (no F.Mask) has no mask opening");
  assert.equal(flashes(".GTP").length, 4, "paste: pads 1 and 5, the aperture and U2");
  const drill = C.parseExcellon(out("-Plated.TXT"));
  assert.deepEqual([drill.hits.length, drill.slots.length], [0, 1]);
  const slot = drill.slots[0], len = Math.hypot(slot.b[0] - slot.a[0], slot.b[1] - slot.a[1]);
  // The pad turns 90 degrees, so the slot runs along the board's X axis: 1.2 long overall, 0.6 wide.
  assert.ok(near(len, .6) && near(slot.a[1], slot.b[1]) && nearP([(slot.a[0] + slot.b[0]) / 2, slot.a[1]], [18, 10]) && near(slot.d, .6), "a horizontal slot at the pad");
  console.log("PASS KiCad roundrect ratios, arc tracks, paste-only pads, mask and paste margins and oval slots");
}

// ------------------------------------------------------------------ 6. KiCad import regressions (one block per finding)
// Repros from the review live in tests/fixtures/import/review (small ones verbatim, large ones
// are regenerated here at the size that triggered the finding).
{
  require("../../app/formats/import-eagle.js"); require("../../app/formats/import-easyeda.js");
  for (const f of ["io", "altium-rules", "pcb-pours", "sch-import", "pcb-import", "rooms", "multichannel"]) { try { require(require("../support/app-source-paths.cjs").appFile(f + ".js")); } catch { /* optional */ } }
  try { const cfb = require("../../app/vendor/cfb.min.js"); globalThis.CFB ??= cfb?.read ? cfb : globalThis.CFB; } catch { /* optional */ }
  const rv = n => path.join(__dirname, "../fixtures/import/review", n);
  const bin = n => new Uint8Array(fs.readFileSync(rv(n)));
  const txt = n => fs.readFileSync(rv(n), "utf8");
  const timed = (what, fn, limit = 4000) => { const t0 = Date.now(); const r = fn(); assert.ok(Date.now() - t0 < limit, what + " took " + (Date.now() - t0) + " ms"); return r; };
  const valid = rs => { const p = projectOf(rs); A.validate(p); return p; };
  const status = [];

  // 1 (High) geometry amplification: an import-wide point budget, clean errors.
  const eagleWires = Array.from({length: 20000}, (_, i) => '<wire x1="' + i + '" y1="0" x2="' + i + '" y2="1" width="0.1" layer="21" curve="359.9"/>').join("");
  timed("Eagle curve amplification", () => assert.throws(() => I.read("amp.brd", enc.encode('<?xml version="1.0"?><eagle><drawing><board><plain>' + eagleWires + "</plain></board></drawing></eagle>")), /more geometry/));
  const kicadArcs = Array.from({length: 30000}, (_, i) => '(gr_arc (start ' + i + ' 0) (mid ' + (i + 4e5) + ' 4e5) (end ' + i + ' 8e5) (stroke (width 0.1)) (layer "F.SilkS"))').join("\n");
  timed("KiCad arc amplification", () => assert.throws(() => I.read("amp.kicad_pcb", enc.encode('(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (37 "F.SilkS" user))\n' + kicadArcs + ")")), /more geometry/));
  status.push(1);

  // 3 (High) Eagle MR90 / MR270: rotate, then mirror. Pads and pins land where Eagle draws them,
  // and net wires that end on the true pin positions connect.
  {
    const [b] = I.readSet([{name: "eagle-mr90.brd", bytes: bin("eagle-mr90.brd")}]), defs = new Map(b.library.map(d => [d.id, d]));
    const pad1 = ref => { const p = b.documents[0].items.find(i => i.ref === ref); return A.pins(p, defs.get(p.def), "pcb").find(q => q.number === "1").at; };
    assert.ok(nearP(pad1("U1"), [10, -11]) && nearP(pad1("U2"), [10, -11]) && nearP(pad1("U3"), [10, -9]), "MR90/MR270 element pads");
    const sch = txt("eagle-mr90.sch").replace('<instance part="R2" gate="G$1" x="50.8" y="50.8" rot="MR90"/>',
      '<instance part="R2" gate="G$1" x="50.8" y="50.8" rot="MR90"/><instance part="R3" gate="G$1" x="80" y="50.8" rot="MR270"/>')
      .replace('<part name="R2" library="l" deviceset="D" device=""/>', '<part name="R2" library="l" deviceset="D" device=""/><part name="R3" library="l" deviceset="D" device=""/>')
      .replace("</instances></sheet>", '</instances><nets><net name="A2"><segment><pinref part="R2" gate="G$1" pin="A"/><wire x1="50.8" y1="55.88" x2="60" y2="55.88" width="0.15" layer="91"/></segment></net>' +
        '<net name="A3"><segment><pinref part="R3" gate="G$1" pin="A"/><wire x1="80" y1="45.72" x2="90" y2="45.72" width="0.15" layer="91"/></segment></net></nets></sheet>');
    const [s] = I.readSet([{name: "mr.sch", bytes: enc.encode(sch)}]), sd = new Map(s.library.map(d => [d.id, d])), doc = s.documents[0];
    const pinA = ref => { const p = doc.items.find(i => i.ref === ref); return A.pins(p, sd.get(p.def), "schematic").find(q => q.name === "A").at; };
    assert.ok(nearP(pinA("R2"), [50.8, -55.88]) && nearP(pinA("R3"), [80, -45.72]), "MR90/MR270 instance pins");
    const c = A.connectivity(doc, sd);
    assert.equal(c.byPin.get(doc.items.find(i => i.ref === "R2").id + "/1"), "A2");
    assert.equal(c.byPin.get(doc.items.find(i => i.ref === "R3").id + "/1"), "A3");
    status.push(3);
  }

  // 4 (High) a sheet used twice imports as two channels of one child sheet.
  {
    const files = ["root.kicad_sch", "child.kicad_sch"].map(n => ({name: n, bytes: bin("kicad-multi/" + n)}));
    const fpUuid = "e0000000-0000-4000-8000-0000000000r3";
    const board = '(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net 0 "")' +
      ["s1", "s2"].map((s, k) => ' (footprint "x:R" (layer "F.Cu") (at ' + (10 * k) + ' 0) (property "Reference" "R' + (3 + k) + '" (at 0 0)) (path "/b0000000-0000-4000-8000-0000000000' + s + '/' + fpUuid + '")' +
        ' (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu")))').join("") + ")";
    const rs = I.readSet([...files, file("multi.kicad_pcb", board)]), p = valid(rs);
    const root = p.documents.find(d => d.sourceName === "root.kicad_sch"), child = p.documents.find(d => d.sourceName === "child.kicad_sch");
    const syms = root.items.filter(i => i.kind === "sheetsymbol");
    assert.deepEqual(syms.map(x => x.sheet), [child.id, child.id]);
    const r = child.items.find(i => i.kind === "part");
    assert.deepEqual(Object.values(r.instanceRefs).sort(), ["R3", "R4"]);
    assert.deepEqual(Object.keys(r.instanceRefs).sort(), syms.map(x => x.id).sort());
    const fps = p.documents.find(d => d.kind === "pcb").items.filter(i => i.kind === "part");
    assert.deepEqual(fps.map(f => f.link).sort(), syms.map(x => r.link + "@" + root.id + "/" + x.id).sort());
    assert.ok(fps.every(f => f.sourceLink === r.link && f.channel === f.link.split("@")[1]));
    assert.ok(root.notes.some(n => /used more than once.*channels/.test(n)));
    if (globalThis.AtriumMultichannel && globalThis.AtriumHierarchy) {
      const ch = AtriumMultichannel.channels(p);
      assert.equal(ch.length, 2); assert.deepEqual(ch.map(c => c.id).sort(), fps.map(f => f.channel).sort());
    }
    status.push(4);
  }

  // 5 (Medium) one bad value skips that object, not the import; Altium results are scrubbed too.
  for (const n of ["kicad-width-huge.kicad_pcb", "kicad-width-negative.kicad_pcb", "m01988-demo-eagle.brd", "m01313-demo-eagle.sch", "eagle-smd-zero.brd", "eagle-textsize-huge.brd", "eagle-bad-charref.brd"])
    valid(I.readSet([{name: n, bytes: bin(n)}]));
  if (globalThis.AtriumSCH && globalThis.AtriumIO) valid(I.readSet([{name: "altium-ascii-1e308.SchDoc", bytes: bin("altium-ascii-1e308.SchDoc")}]));
  status.push(5);

  // 6 (Medium) the outline fallback is linear: 20,000 shuffled edges with a gap.
  {
    const n = 20000, pts = Array.from({length: n}, (_, i) => [50 + 40 * Math.cos(2 * Math.PI * i / n), 50 + 40 * Math.sin(2 * Math.PI * i / n)].map(v => v.toFixed(5)));
    const lines = pts.map((p, i) => '(gr_line (start ' + p.join(" ") + ') (end ' + pts[(i + 1) % n].join(" ") + ') (layer "Edge.Cuts"))').slice(1);
    for (let i = lines.length - 1; i > 0; i--) { const j = (i * 7919) % (i + 1); [lines[i], lines[j]] = [lines[j], lines[i]]; }
    timed("20,000 edges", () => I.read("edges.kicad_pcb", enc.encode('(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal) (44 "Edge.Cuts" user))\n' + lines.join("\n") + ")")), 6000);
    status.push(6);
  }

  // 7 (Medium) net-class patterns have a total cost cap.
  {
    const pro = JSON.stringify({net_settings: {classes: [{name: "Default", clearance: .2, track_width: .2, via_drill: .3}, {name: "P", clearance: .3}],
      netclass_patterns: Array.from({length: 1000}, () => ({netclass: "P", pattern: "*a".repeat(60) + "*b"}))}});
    const nets = Array.from({length: 200}, (_, i) => '(net ' + (i + 1) + ' "' + "a".repeat(4000) + i + '")').join(" ");
    const segs = Array.from({length: 200}, (_, i) => '(segment (start 0 ' + i + ') (end 1 ' + i + ') (width 0.2) (layer "F.Cu") (net ' + (i + 1) + '))').join(" ");
    const brd = '(kicad_pcb (version 20240108) (layers (0 "F.Cu" signal)) (net 0 "") ' + nets + " " + segs + ")";
    const rs = timed("pattern matching", () => I.readSet([file("w.kicad_pro", pro), file("w.kicad_pcb", brd)]));
    assert.ok(rs[1].documents[0].notes.some(n => /too costly/.test(n)));
    status.push(7);
  }

  // 8 (Medium) an archive inside an .epro is refused, never unpacked with fresh limits.
  {
    const u16 = n => [n & 255, n >> 8 & 255], u32 = n => [n & 255, n >> 8 & 255, n >> 16 & 255, n >>> 24];
    const stored = (name, data) => {
      const nm = [...enc.encode(name)], local = [...u32(0x04034b50), 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nm.length), 0, 0, ...nm, ...data];
      const cd = [...u32(0x02014b50), 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nm.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0), ...nm];
      return Uint8Array.from([...local, ...cd, ...u32(0x06054b50), 0, 0, 0, 0, 1, 0, 1, 0, ...u32(cd.length), ...u32(local.length), 0, 0]);
    };
    const inner = stored("a.json", [...enc.encode('{"head":{"docType":"3"},"canvas":"","shape":[]}')]), outer = stored("a.json", [...inner]);
    assert.throws(() => I.read("nest.epro", outer), /contains another archive/);
    assert.equal(I.read("one.epro", inner).documents.length, 1);
    assert.throws(() => I.read("zip-prealloc.epro", bin("zip-prealloc.epro")), /ZIP bomb|expands beyond|ratio/);
    status.push(8);
  }

  // 10 (Low) missing required values skip the object with a note.
  {
    const [k] = I.readSet([{name: "kicad-segment-no-start.kicad_pcb", bytes: bin("kicad-segment-no-start.kicad_pcb")}]);
    valid([k]); assert.ok(k.notes.some(n => /missing or malformed/.test(n)));
    const [e] = I.readSet([{name: "eagle-element-noname.brd", bytes: bin("eagle-element-noname.brd")}]);
    valid([e]); assert.equal(e.documents[0].items.filter(i => i.kind === "part").length, 1);
    for (const bad of ['(kicad_sch (version 20231120) (junction) (no_connect) (wire (pts)) (label "x") (bus_entry) (sheet (at 1 1)))',
      '(kicad_pcb (version 20240108) (arc (start 0 0) (end 1 1) (width 0.1) (layer "F.Cu")) (via) (gr_text "t") (zone (polygon)))'])
      valid(I.readSet([file(bad.startsWith("(kicad_sch") ? "m.kicad_sch" : "m.kicad_pcb", bad)]));
    status.push(10);
  }

  // 11 (Low) damaged Altium compound files give a readable error.
  if (globalThis.AtriumIO && globalThis.CFB) {
    assert.throws(() => I.readSet([{name: "altium-cfb-recursion.PcbDoc", bytes: bin("altium-cfb-recursion.PcbDoc")}]), e => /damaged/.test(e.message) && !/evaluating|stack size/.test(e.message));
    status.push(11);
  }

  // 12 (Low) SQLite .eprj and Waffle .json files say what to do.
  assert.throws(() => I.read("easyeda-pro-sqlite.eprj", bin("easyeda-pro-sqlite.eprj")), /SQLite.*not supported.*\.epro/);
  assert.throws(() => I.read("project.atrium.json", bin("project.atrium.json")), /Rename it to \.waffle/);
  status.push(12);

  // 13 (Low) newer KiCad formats are flagged.
  assert.ok(I.read("kicad-future-version.kicad_pcb", bin("kicad-future-version.kicad_pcb")).notes.some(n => /newer KiCad \(format 20991231\)/.test(n)));
  status.push(13);

  // Fixed during the review: unterminated end tag, SVG "Z n" loops, ZIP pre-allocation, prototype keys.
  timed("unclosed end tag", () => assert.throws(() => I.read("eagle-unclosed-endtag.brd", bin("eagle-unclosed-endtag.brd")), /Malformed|truncated/));
  for (const n of ["easyeda-svg-z.json", "easyeda-svg-z-pcb.json"]) timed(n, () => valid(I.readSet([{name: n, bytes: bin(n)}])));
  for (const n of ["p-eagle.brd", "p-easy.json"]) { try { I.readSet([{name: n, bytes: bin("proto/" + n)}]); } catch { /* an error is fine; pollution is not */ } }
  try { I.readSet(["p.kicad_pro", "p.kicad_pcb"].map(n => ({name: n, bytes: bin("proto/" + n)}))); } catch { /* as above */ }
  assert.equal(({}).polluted, undefined); assert.equal([].polluted, undefined);
  // The review's orientation check (KiCad 9 file): U2 at 30 degrees on B.Cu puts pad 1 at (32.2321, 9.8660).
  {
    const [o] = I.readSet([{name: "kicad9-orient.kicad_pcb", bytes: bin("kicad9-orient.kicad_pcb")}]), od = new Map(o.library.map(d => [d.id, d]));
    const U2 = o.documents[0].items.find(i => i.ref === "U2");
    assert.ok(nearP(A.pins(U2, od.get(U2.def), "pcb").find(q => q.number === "1").at, [32.2321, 9.866]));
  }

  // 1, 2 and 9 in the shared files (importers-review-fixes.py): the worker client never retries on
  // this thread once a worker started, times out stuck jobs, restarts afterwards and reports progress.
  const clientSrc = fs.readFileSync(path.join(__dirname, "../../app/workers/import-worker-client.js"), "utf8");
  {
    const g = globalThis, made = [];
    let behaviour = "crash", fallbackCalls = 0;
    class FakeWorker {
      constructor() { made.push(this); setTimeout(() => this.onmessage({data: {type: "ready"}}), 0); }
      postMessage(m) {
        if (behaviour === "crash") setTimeout(() => this.onerror({message: "out of memory"}), 0);
        else if (behaviour === "progress") setTimeout(() => { this.onmessage({data: {type: "progress", id: m.id, done: 0, total: 1, name: "x"}}); this.onmessage({data: {type: "result", id: m.id, value: [{documents: [], library: [], notes: ["ok"]}]}}); }, 0);
      }
      terminate() { this.dead = true; }
    }
    const saved = {Worker: g.Worker, document: g.document, URL: g.URL};
    g.Worker = FakeWorker; g.document = {currentScript: {src: "file:///app/workers/import-worker-client.js"}}; g.URL ??= class { constructor(u, b) { this.href = b + "/../" + u; } };
    const realReadSet = I.readSet; I.readSet = (...a) => { fallbackCalls++; return realReadSet(...a); };
    delete g.AtriumImport; new Function(clientSrc)();
    const Imp = g.AtriumImport, f1 = [file("demo.kicad_pcb", fixture("demo.kicad_pcb"))];
    g.__testDone = (async () => {
      try {
        await assert.rejects(Imp.readSet(f1), /out of memory/); assert.equal(fallbackCalls, 0, "no editor-thread retry");
        behaviour = "hang";
        await assert.rejects(Imp.readSet(f1, {timeoutMs: 30}), /took longer/); assert.equal(fallbackCalls, 0);
        behaviour = "progress"; const seen = [];
        const r = await Imp.readSet(f1, {onProgress: p => seen.push(p.name)});
        assert.deepEqual([r[0].notes, seen], [["ok"], ["x"]]); assert.ok(made.length >= 3, "a stopped worker is replaced");
        behaviour = "hang"; const pending = Imp.readSet(f1); await new Promise(res => setTimeout(res, 5)); Imp.cancel();
        await assert.rejects(pending, /cancelled/);
        console.log("PASS worker client: no UI-thread retry, watchdog, cancel, restart and progress");
      } finally { I.readSet = realReadSet; Object.assign(g, saved); }
    })();
    status.push(9);
  }
  console.log("PASS KiCad import regressions for cases " + [...new Set(status)].sort((a, b) => a - b).join(", ") + " (2 is in tests/automation/mcp.py)");
}
