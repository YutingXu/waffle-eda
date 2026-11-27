"use strict";
// A PCB part's own `mirror` flag reflects its footprint about local Y (pcb-appearance.js padTurn,
// Atrium.drillCore). Every writer that places footprint-local geometry must put each pad, slot and
// body where the board draws it: KiCad, IPC-2581, STEP, EasyEDA Standard and Pro, and Altium.
// The part has a pad at local x = +4 placed at x = 20 and mirrored, so its copper is at x = 16.
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const n of ["obsolete-project", "model", "parts", "sch-objects", "hierarchy", "spatial", "board-shape", "board-shape-editing", "board-shape-sources",
  "net-intent", "signals", "altium-rules", "pcb-draw", "component-classes", "query", "rules", "project-rules", "pcb-pours", "pcb-appearance", "stackup",
  "impedance", "viastack", "rooms", "rigid-flex", "polygon-pour", "vectorize", "pcb-text-rich", "pcb-text", "bom", "altium-ids", "source-file", "sch-import",
  "pcb-import", "sexpr", "import-easyeda", "import-link", "io", "import-rules", "translator-table", "translator-registry", "translator-provenance",
  "translator-adapters", "translators", "zip", "fab-outputs", "ipc2581", "step-export", "kicad-export", "export-easyeda", "export-easyeda-standard",
  "export-easyeda-pro", "altium-export"]) require(require("../support/app-source-paths.cjs").appFile(n + ".js"));
const A = Atrium, L = AtriumResolvedLand;
const near = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, a + " differs from " + b);
const nearPoint = (p, q, tol) => { near(p[0], q[0], tol); near(p[1], q[1], tol); };
// Slot axes are lines: compare directions up to sign.
const sameAxis = (u, v) => { const k = Math.hypot(...u) * Math.hypot(...v); near(Math.abs(u[0] * v[0] + u[1] * v[1]) / k, 1, 1e-6); };

function design(mirror = true, slotAngle = 30) {
  const project = A.project("Mirror", []), doc = project.documents.find(d => d.kind === "pcb");
  doc.outline = [[0, 0], [40, 0], [40, 30], [0, 30], [0, 0]];
  project.library.push({id: "d1", name: "D1", prefix: "U", symbol: {pins: [], shapes: []}, footprint: {name: "FP", pads: [
    {number: "1", x: 4, y: 0, w: 2, h: 2, drill: 1, shape: "round", layer: "Multi"},
    {number: "2", x: -4, y: 0, w: 4, h: 2, drill: .6, slotLength: 3, slotAngle, shape: "oval", layer: "Multi"},
    {number: "3", x: 0, y: 3, w: 1, h: 2, angle: 20, shape: "rect", layer: "Top"}],
    shapes: [{kind: "path", style: "package", closed: true, points: [[3, -1], [6, -1], [6, 1], [3, 1]], width: .1}]}});
  doc.items.push({id: "p1", kind: "part", def: "d1", ref: "U1", value: "", x: 20, y: 10, angle: 0, mirror, layer: "Top", pinNets: {}});
  return {project, doc, item: doc.items[0], pads: project.library[0].footprint.pads};
}
const {project, doc, item, pads} = design();
// What the board draws: pad centres, pad turns and the slot core.
const placed = pads.map(p => L.place(p, item));
nearPoint(placed[0].at, [16, 10]);
const core = A.drillCore(pads[1], placed[1].at, placed[1].angle, true), slotAxis = [core[1][0] - core[0][0], core[1][1] - core[0][1]];

// ---- KiCad: footprint-local pads (no mirror flag) and oval drills -------------------------------
{
  const text = AtriumKiCad.exportBoard(project, doc).content;
  const fp = /\(footprint[^\n]*\n\s*\(at ([-\d.]+) ([-\d.]+)\)/.exec(text), origin = {x: +fp[1], y: +fp[2], angle: 0};
  const padOf = number => {
    const line = new RegExp('\\(pad "' + number + '" [^\\n]*').exec(text)[0];
    return [line, ...(/\(at ([-\d.]+) ([-\d.]+)(?: ([-\d.]+))?\)/.exec(line).slice(1)), /\(drill [^)]*\)/.exec(line)?.[0]];
  };
  for (const [i, p] of pads.entries()) {
    const m = padOf(p.number);
    nearPoint(A.world([+m[1], +m[2]], origin), placed[i].at);
  }
  const slot = padOf("2");
  assert.equal(slot[4], "(drill oval 3 0.6)", "a slot is an oval drill along the pad's X axis");
  // KiCad angles are counter-clockwise on screen; the oval runs along the turned pad X axis.
  sameAxis(A.rotate([1, 0], -(+slot[3] || 0)), slotAxis);
  near(((-(+padOf("3")[3] || 0) % 360) + 360) % 360, ((placed[2].angle % 360) + 360) % 360);
  // Axis-aligned slots keep the pad rotation and size the oval along the matching pad axis.
  for (const [angle, drill] of [[0, "(drill oval 3 0.6)"], [90, "(drill oval 0.6 3)"], [-90, "(drill oval 0.6 3)"], [180, "(drill oval 3 0.6)"]]) {
    const d = design(false, angle), out = AtriumKiCad.exportBoard(d.project, d.doc).content;
    assert.match(out, new RegExp('\\(pad "2" thru_hole custom \\(at -4 0\\) \\(size [\\d.]+ [\\d.]+\\) ' + drill.replace(/[()]/g, "\\$&")));
  }
}

// ---- IPC-2581: the placed package pins land on the pad features -------------------------------
{
  const X = AtriumIPC2581, r = X.build(project, doc, {date: new Date(2026, 0, 1)});
  assert.ok(X.check(r.content).ok, JSON.stringify(X.check(r.content).errors));
  const tree = X.parse(r.content), all = (node, name, out = []) => { if (node.name === name) out.push(node); for (const c of node.children) all(c, name, out); return out; };
  const child = (node, name) => node.children.find(c => c.name === name), loc = node => [+child(node, "Location").attrs.x, +child(node, "Location").attrs.y];
  const comp = all(tree, "Component").find(c => c.attrs.refDes === "U1"), pkg = all(tree, "Package").find(p => p.attrs.name === comp.attrs.packageRef);
  const turn = +(child(comp, "Xform")?.attrs.rotation || 0), mirrored = child(comp, "Xform")?.attrs.mirror === "true";
  for (const pin of all(pkg, "Pin")) {
    const local = loc(pin), q = A.rotate([mirrored ? -local[0] : local[0], -local[1]], -turn), at = [loc(comp)[0] + q[0], loc(comp)[1] - q[1]];
    const pad = all(tree, "Pad").find(f => child(f, "PinRef")?.attrs.componentRef === "U1" && child(f, "PinRef").attrs.pin === pin.attrs.number);
    nearPoint(at, loc(pad));
  }
}

// ---- STEP: the generated body is the reflected package outline --------------------------------
{
  const part = AtriumSTEP.model(project, doc.id, {}).parts.find(p => p.id === "p1"), m = part.matrix;
  const xs = part.body.loops[0].flatMap(e => [e.a[0], e.b[0]]).map(x => m[0] * x + m[12]);
  near(Math.min(...xs), 14); near(Math.max(...xs), 17);
}

// ---- EasyEDA Standard and Pro ------------------------------------------------------------------
{
  const files = edition => AtriumEasyEDAExport.export(project, {edition, scope: "document", documentId: doc.id}, {add() {}}).files;
  const std = JSON.parse(files("standard").find(f => f.name.endsWith(".json")).text), U = .254;
  const origin = std.canvas.split("~").slice(16, 18).map(Number), mm = (x, y) => [(+x - origin[0]) * U, (+y - origin[1]) * U];
  const stdPads = std.shape.join("#@$").split("#@$").filter(s => s.startsWith("PAD~")).map(s => s.split("~"));
  for (const [i, p] of pads.entries()) nearPoint(mm(...stdPads.find(f => f[8] === p.number).slice(2, 4)), placed[i].at);
  const ends = stdPads.find(f => f[8] === "2")[14].split(" ").map(Number), a = mm(ends[0], ends[1]), b = mm(ends[2], ends[3]);
  nearPoint(a, core[0]); nearPoint(b, core[1]);
  near(((-(+stdPads.find(f => f[8] === "3")[11]) % 360) + 360) % 360, ((placed[2].angle % 360) + 360) % 360);
}
{
  const files = edition => AtriumEasyEDAExport.export(project, {edition, scope: "document", documentId: doc.id}, {add() {}}).files;
  const zip = AtriumImportFormats.unzip(files("pro")[0].bytes), rows = name => AtriumImportFormats.utf8(zip.get(name)).trim().split("\n").map(l => JSON.parse(l));
  const board = rows([...zip.keys()].find(k => k.endsWith(".epcb"))).find(r => r[0] === "COMPONENT"), footprint = [...zip.keys()].find(k => k.endsWith(".efoo"));
  assert.equal(board[6], 0);
  const mil = .0254, origin2 = [board[4] * mil, -board[5] * mil];
  for (const r of rows(footprint).filter(r => r[0] === "PAD")) {
    const i = pads.findIndex(p => p.number === r[5]);
    nearPoint([origin2[0] + r[6] * mil, origin2[1] - r[7] * mil], placed[i].at);
    // Pro angles are counter-clockwise with Y up; the slot turns from the pad axis.
    if (r[5] === "2") sameAxis(A.rotate([1, 0], -(r[8] + r[14])), slotAxis);
    if (r[5] === "3") near(((-r[8] % 360) + 360) % 360, ((placed[2].angle % 360) + 360) % 360);
  }
}

// ---- Altium PcbDoc: pad positions, pad rotation and hole rotation ------------------------------
{
  const out = AtriumAltiumExport.exportBoard(project, doc), MIL = .0254;
  const records = out.content.split(/\r?\n/).filter(l => /\|RECORD=Pad\|/.test(l)).map(l => Object.fromEntries(l.split("|").filter(Boolean).map(f => f.split("="))));
  const val = s => parseFloat(s), at = r => [val(r.X) * MIL - out.offset[0], -(val(r.Y) * MIL + out.offset[1])];
  for (const [i, p] of pads.entries()) {
    const r = records.find(r => r.NAME === p.number);
    nearPoint(at(r), placed[i].at, 2e-4);
    // Altium rotations are counter-clockwise with Y up; HOLEROTATION is relative to the pad.
    near(((-val(r.ROTATION) - placed[i].angle) % 360 + 360) % 360 % 360, 0, 1e-3);
    if (p.number === "2") sameAxis(A.rotate([1, 0], -(val(r.ROTATION) + val(r.HOLEROTATION))), slotAxis);
  }
}
