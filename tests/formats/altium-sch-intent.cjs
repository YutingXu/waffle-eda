"use strict";
// Altium schematic intent and curves: parameter sets (directives) become signal directive fields,
// and KiCad net class directive labels do too; arcs and ellipses keep their exact curves beside their
// points. Synthetic ASCII SchDoc records only.
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "parts", "sch-objects", "hierarchy", "net-intent", "signals", "board-shape", "board-shape-sources", "stackup", "sexpr", "import-kicad", "import-link", "sch-import", "io",
  "spatial", "pcb-appearance", "sch-appearance", "sch-curves", "altium-export"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const {nativeRoundTrip} = require("../support/native-cad.cjs");
const A = Atrium, S = AtriumSignals, C = AtriumSchCurves;

function ascii(build) {
  const lines = [];
  const r = o => { lines.push("|" + Object.entries(o).map(([k, v]) => k + "=" + v).join("|")); return lines.length - 1; };
  r({RECORD:31, FONTIDCOUNT:1, SIZE1:10, FONTNAME1:"Arial", SHEETSTYLE:0});
  build(r);
  return lines.join("\r\n");
}
// A fidelity sink that keeps every decision by source record.
function sink() {
  const rows = [];
  const add = (kind, status, source, reason) => rows.push({kind, status, object: source.object, reason});
  return {rows, add, track: (kind, status, source, object, reason) => add(kind, status, source, reason), produced() {}, note() {}};
}
const row = (f, index) => f.rows.find(x => x.object === "ASCII record#" + index);
function sheetProject(res) {
  const p = A.project("Intent");
  p.documents = [...res.documents, A.sheet("pcb", "Board")];
  p.library = res.library;
  A.validate(p);
  return p;
}

// A. Parameter sets: the wire (or net label) under a directive's location carries its intent.
{
  const at = {};
  const text = ascii(r => {
    const wire = (y, name) => { r({RECORD:27, LOCATIONCOUNT:2, X1:100, Y1:y, X2:200, Y2:y}); r({RECORD:25, TEXT:name, "LOCATION.X":100, "LOCATION.Y":y}); };
    wire(500, "CAN_P"); wire(480, "CAN_N"); wire(460, "VDD_3V3"); wire(440, "RS485_A"); wire(420, "RS485_B"); wire(400, "DATA");
    const set = (key, x, y, params) => { const owner = at[key] = r({RECORD:43, OWNERPARTID:-1, "LOCATION.X":x, "LOCATION.Y":y, NAME:key});
      at[key + ".params"] = Object.entries(params).map(([name, value]) => r({RECORD:41, OWNERINDEX:owner, OWNERPARTID:-1, "LOCATION.X":x, "LOCATION.Y":y - 10, ISHIDDEN:"T", NAME:name, TEXT:value})); };
    set("pos", 150, 500, {DifferentialPair:"True", DifferentialPairClassName:"CAN_PAIRS", ClassName:"HS"});
    set("neg", 120, 480, {DifferentialPair:"True"});
    set("rail", 200, 460, {ClassName:"PowerNets", Rule:"Rule Kind=Width|Min=10mil"});
    set("a", 150, 440, {DifferentialPair:"True"});
    set("b", 150, 420, {DifferentialPair:"True"});
    set("plain", 150, 400, {DifferentialPair:"True", DifferentialPairClassName:"X"});
    set("label", 100, 400, {ClassName:"Labelled"});
    set("float", 150, 600, {ClassName:"Nowhere"});
    // Two resistors joined pin to pin at (310, 700); a directive there is on pin R1-1's net.
    for (const [ref, x] of [["R1", 300], ["R2", 270]]) {
      const c = r({RECORD:1, LIBREFERENCE:"Res", "LOCATION.X":x, "LOCATION.Y":700, CURRENTPARTID:1, DISPLAYMODE:0});
      [0, 30].forEach((dx, k) => r({RECORD:2, OWNERINDEX:c, OWNERPARTID:1, DESIGNATOR:String(k + 1), NAME:"", "LOCATION.X":x + dx, "LOCATION.Y":700, PINLENGTH:10, ELECTRICAL:4, PINCONGLOMERATE:0}));
      r({RECORD:34, OWNERINDEX:c, NAME:"Designator", TEXT:ref, "LOCATION.X":x, "LOCATION.Y":720});
    }
    set("pin", 310, 700, {ClassName:"PinOnly"});
    r({RECORD:26, LOCATIONCOUNT:2, X1:100, Y1:300, X2:200, Y2:300});
    set("bus", 150, 300, {ClassName:"Bus"});
  });
  const f = sink(), res = AtriumSCH.read("Intent.SchDoc", null, text, {fidelity:f});
  const doc = res.documents[0], wires = doc.items.filter(i => i.kind === "wire");
  const on = name => wires.find(w => A.connectivity(doc, new Map(res.library.map(d => [d.id, d]))).byWire.get(w.id) === name);
  assert.ok(!res.notes.some(n => /parameter set/i.test(n)), res.notes.join(" | "));
  assert.deepEqual([on("CAN_P").signal, on("CAN_P").polarity, on("CAN_P").tags, on("CAN_P").netClass], ["CAN", 1, ["CAN_PAIRS"], "HS"]);
  assert.deepEqual([on("CAN_N").signal, on("CAN_N").polarity, on("CAN_N").tags, on("CAN_N").netClass], ["CAN", -1, undefined, undefined]);
  assert.equal(on("VDD_3V3").netClass, "PowerNets", "a net class stays a net tag (netClass), never a signal tag");
  assert.equal(on("VDD_3V3").tags, undefined);
  // A/B legs name no polarity: the pair is declared and Waffle reports the assumption.
  assert.deepEqual([on("RS485_A").diffPair, on("RS485_A").polarity, on("RS485_B").diffPair], ["RS485", undefined, "RS485"]);
  assert.equal(on("DATA").signal, undefined, "a pair leg needs a P/N suffix to name its pair");
  assert.equal(doc.items.find(i => i.kind === "netlabel" && i.text === "DATA").netClass, undefined, "the wire takes precedence over a label at its end");
  assert.equal(on("DATA").netClass, "Labelled");
  // Fidelity: each set and parameter is reported as translated, approximated or dropped, with a reason.
  assert.equal(row(f, at.pos).status, "kept");
  assert.ok(at["pos.params"].every(i => row(f, i).status === "kept"));
  assert.equal(row(f, at.rail).status, "approximated");
  assert.match(row(f, at["rail.params"][1]).reason, /Rule is not translated/);
  assert.equal(row(f, at.a).status, "approximated");
  assert.equal(row(f, at["a.params"][0]).status, "approximated");
  assert.match(row(f, at["a.params"][0]).reason, /Polarity of RS485_A/);
  assert.equal(row(f, at.plain).status, "dropped");
  assert.match(row(f, at["plain.params"][0]).reason, /no _P\/_N or \+\/- suffix/);
  assert.equal(row(f, at.float).status, "dropped");
  assert.match(row(f, at.float).reason, /not attached to a wire, net label or pin in the source/);
  assert.equal(row(f, at.pin).status, "dropped");
  assert.match(row(f, at.pin).reason, /on pin R\d-\d, and its net Net\w+ has no wire or net label on this sheet/);
  assert.match(row(f, at.bus).reason, /buses/);
  assert.ok(!f.rows.some(x => x.kind === "Parameter" && /Sheet parameter/.test(x.reason || "")), "directive parameters are not sheet parameters");

  // The signals model reads the directives: a CAN pair tagged CAN_PAIRS, and net tags.
  const p = sheetProject(res), board = p.documents.find(d => d.kind === "pcb");
  const recs = S.directives(p).records;
  assert.equal(recs.length, 6, "one record per directive-carrying wire");
  const M = S.model(p, board);
  const can = M.signals.find(s => s.name === "CAN");
  assert.equal(can.kind, "diff");
  assert.deepEqual(can.legs.map(l => [l.polarity, l.seeds]), [[1, ["CAN_P"]], [-1, ["CAN_N"]]]);
  assert.deepEqual(can.tags, ["CAN_PAIRS"]);
  assert.equal(M.signals.find(s => s.name === "RS485").kind, "diff");
  assert.ok(M.issues.some(i => i.kind === "polarity" && i.signal === "RS485"), "an A/B pair reports its assumed polarity");
  const classes = M.netClasses();
  assert.deepEqual([classes.HS, classes.Labelled, classes.PowerNets], [["CAN_P"], ["DATA"], ["VDD_3V3"]], "net classes are exact net tags");
  assert.deepEqual([...M.netsOfTag("CAN_PAIRS")].sort(), ["CAN_N", "CAN_P"], "the pair class tags the pair signal");
  assert.deepEqual(M.diffPairClasses(), {CAN_PAIRS:["CAN"]});
  // The fields are ordinary directive fields: they save, reopen and validate.
  const back = A.validate(nativeRoundTrip(p));
  assert.equal(back.documents[0].items.find(i => i.kind === "wire" && i.signal === "CAN" && i.polarity === 1).netClass, "HS");

  // Altium export writes them back as parameter sets: an import, export and import keeps the same intent.
  const out = AtriumAltiumExport.exportSchematic(p, doc.id), lines = out.content.split(/\r?\n/);
  const sets = lines.flatMap((l, k) => /^\|RECORD=43\|/.test(l) ? [k - 1] : []);
  assert.ok(sets.length >= 7, "one parameter set per net class and per pair leg");
  for (const k of sets) assert.ok(lines.some(l => /^\|RECORD=41\|/.test(l) && l.includes("|OWNERINDEX=" + k + "|")), "every set has its parameters as children");
  const again = AtriumSCH.read("Intent.SchDoc", null, out.content, {fidelity:sink()}), q = sheetProject(again), M2 = S.model(q, q.documents.find(d => d.kind === "pcb"));
  const summary = m => ({classes: m.netClasses(), pairs: m.diffPairClasses(), tags: [...m.netsOfTag("CAN_PAIRS")].sort(),
    signals: m.signals.filter(x => x.kind === "diff").map(x => [x.name, x.legs.map(l => [l.polarity, l.seeds])]).sort()});
  assert.deepEqual(summary(M2), summary(M), "the directives survive an Altium round trip");
  assert.deepEqual(S.directives(q).records.map(r => [r.net, r.signal ?? null, r.polarity ?? null, r.diffPair ?? null, r.tags, r.netTags]).sort(),
    S.directives(p).records.map(r => [r.net, r.signal ?? null, r.polarity ?? null, r.diffPair ?? null, r.tags, r.netTags]).sort(), "and the fields on each net");
}

// KiCad: a net class directive label puts its Netclass on the wire it touches.
{
  const sch = `(kicad_sch (version 20231120) (generator eeschema) (uuid "11111111-1111-1111-1111-111111111111") (paper "A4")
  (lib_symbols)
  (wire (pts (xy 10 10) (xy 30 10)) (uuid "22222222-2222-2222-2222-222222222222"))
  (label "CLK" (at 10 10 0) (uuid "33333333-3333-3333-3333-333333333333"))
  (netclass_flag "" (length 2.54) (shape round) (at 20 10 0) (uuid "44444444-4444-4444-4444-444444444444")
    (property "Netclass" "Fast" (at 20 7 0)) (property "Owner" "x" (at 20 6 0)))
  (directive_label "" (length 2.54) (shape round) (at 50 50 0) (uuid "55555555-5555-5555-5555-555555555555")
    (property "Netclass" "Lost" (at 50 47 0))))`;
  const f = sink(), [res] = AtriumImportFormats.readSet([{name:"Clock.kicad_sch", bytes:new TextEncoder().encode(sch)}], {fidelity:f});
  const doc = res.documents[0], wire = doc.items.find(i => i.kind === "wire");
  assert.equal(wire.netClass, "Fast");
  assert.ok(!doc.notes.some(n => n === "Net class directives omitted"), doc.notes.join(" | "));
  assert.ok(doc.notes.some(n => /Net class directive labels omitted: No wire or label/.test(n)));
  const dirs = f.rows.filter(x => x.kind === "directive");
  assert.deepEqual(dirs.map(x => x.status), ["approximated", "dropped"]);
  assert.match(dirs[0].reason, /Owner are not translated/);
  const p = sheetProject(res);
  assert.deepEqual(S.model(p, p.documents.find(d => d.kind === "pcb")).netClasses(), {Fast:["CLK"]});
}
// B. Arcs, ellipses and elliptical arcs keep an exact curve beside their points, on symbols (also
// rotated) and on the sheet; they draw as curves, survive a native save and export as Altium curves.
const MM = .254, alt = (x, y, rx, ry, deg) => [x * MM + rx * MM * Math.cos(deg * Math.PI / 180), -y * MM - ry * MM * Math.sin(deg * Math.PI / 180)];
const near = (p, q, tol = 2e-6) => assert.ok(Math.abs(p[0] - q[0]) <= tol && Math.abs(p[1] - q[1]) <= tol, JSON.stringify(p) + " is not " + JSON.stringify(q));
function curvesSheet() {
  return ascii(r => {
    const comp = r({RECORD:1, LIBREFERENCE:"Curves", "LOCATION.X":500, "LOCATION.Y":500, ORIENTATION:1, CURRENTPARTID:1, DISPLAYMODE:0});
    const own = o => r({OWNERINDEX:comp, OWNERPARTID:1, ...o});
    own({RECORD:2, DESIGNATOR:"1", NAME:"A", "LOCATION.X":540, "LOCATION.Y":500, PINLENGTH:10, ELECTRICAL:4, PINCONGLOMERATE:0});
    own({RECORD:34, NAME:"Designator", TEXT:"U1", "LOCATION.X":500, "LOCATION.Y":540});
    own({RECORD:12, "LOCATION.X":520, "LOCATION.Y":500, RADIUS:10, STARTANGLE:"30.000", ENDANGLE:"120.000"});
    own({RECORD:8, "LOCATION.X":480, "LOCATION.Y":500, RADIUS:5, SECONDARYRADIUS:5, ISSOLID:"T"});
    own({RECORD:8, "LOCATION.X":500, "LOCATION.Y":520, RADIUS:8, SECONDARYRADIUS:4, ISSOLID:"T"});
    own({RECORD:11, "LOCATION.X":500, "LOCATION.Y":480, RADIUS:6, SECONDARYRADIUS:3, STARTANGLE:"200.000", ENDANGLE:"20.000"});
    r({RECORD:12, "LOCATION.X":100, "LOCATION.Y":100, RADIUS:20, ENDANGLE:"270.000"});
    r({RECORD:11, "LOCATION.X":200, "LOCATION.Y":100, RADIUS:20, SECONDARYRADIUS:10, STARTANGLE:"45.000", ENDANGLE:"300.000"});
    r({RECORD:8, "LOCATION.X":300, "LOCATION.Y":100, RADIUS:10, SECONDARYRADIUS:10, ISSOLID:"T"});
  });
}
function recorder() {
  const calls = [];
  return new Proxy({calls}, {get: (t, k) => k in t ? t[k] : typeof k === "string" && /^[a-z]/.test(k) ? (...a) => calls.push(k) : undefined, set: () => true});
}
{
  const f = sink(), res = AtriumSCH.read("Curves.SchDoc", null, curvesSheet(), {fidelity:f});
  assert.ok(!res.notes.some(n => /Curves use line segments/.test(n)), res.notes.join(" | "));
  assert.ok(!f.rows.some(x => /^(Arc|Ellipse|Elliptical arc)$/.test(x.kind) && x.status !== "kept"), JSON.stringify(f.rows.filter(x => x.status !== "kept")));
  const doc = res.documents[0], part = doc.items.find(i => i.kind === "part"), def = res.library.find(d => d.id === part.def);
  assert.equal(part.angle, 270);
  const shapes = def.symbol.shapes.filter(s => s.kind === "circle" || s.arc || s.ellipse), world = p => A.world(p, part);
  assert.deepEqual(shapes.map(s => s.kind === "circle" ? "circle" : s.arc ? "arc" : "ellipse"), ["arc", "circle", "ellipse", "ellipse"]);
  // The arc: the symbol editor's form, centred and turned with the part.
  const arc = C.arc(shapes[0]);
  assert.ok(arc, "the arc still matches its points");
  near(world([arc.x, arc.y]), alt(520, 500, 0, 0, 0));
  near(world([arc.x + arc.r * Math.cos(arc.start * Math.PI / 180), arc.y + arc.r * Math.sin(arc.start * Math.PI / 180)]), alt(520, 500, 10, 10, 120));
  near(world([arc.x + arc.r * Math.cos(arc.end * Math.PI / 180), arc.y + arc.r * Math.sin(arc.end * Math.PI / 180)]), alt(520, 500, 10, 10, 30));
  assert.equal(arc.end - arc.start, 90);
  const circle = shapes[1];
  near(world([circle.x, circle.y]), alt(480, 500, 0, 0, 0));
  assert.deepEqual([circle.r, circle.fill], [5 * MM, true]);
  const full = C.ellipse(shapes[2]), part11 = C.ellipse(shapes[3]);
  assert.ok(full && part11, "the ellipses still match their points");
  assert.equal(full.sweep, 360);
  assert.equal(shapes[2].fill, true);
  for (const t of [0, 90, 180]) near(world(C.ellipsePoint(full, t)), alt(500, 520, 8, 4, t));
  assert.equal(part11.sweep, 180);
  for (const t of [0, 45, 180]) near(world(C.ellipsePoint(part11, t)), alt(500, 480, 6, 3, 200 + t));
  // Sheet graphics: a centre/radius arc (the board convention) and an ellipse.
  const graphics = doc.items.filter(i => i.kind === "graphic");
  const sheetArc = A.pathArc(graphics[0]), sheetEllipse = C.ellipse(graphics[1]), disc = A.pathArc(graphics[2]);
  assert.ok(sheetArc && sheetEllipse && disc);
  near(A.arcPoint(sheetArc, sheetArc.start + A.arcSweep(sheetArc)), alt(100, 100, 20, 20, 270));
  near(C.ellipsePoint(sheetEllipse, sheetEllipse.sweep), alt(200, 100, 20, 10, 300));
  assert.deepEqual([A.arcSweep(disc), graphics[2].closed, graphics[2].fill], [360, true, true]);
  // Drawing: the curves, not their chords.
  for (const s of [shapes[0], shapes[2], shapes[3]]) {
    const ctx = recorder(); AtriumSchAppearance.shape(ctx, s, 10, false);
    assert.ok(ctx.calls.includes("arc") && !ctx.calls.includes("lineTo"), ctx.calls.join(","));
  }
  // A moved sheet ellipse keeps its curve; an edited point falls back to the points.
  const moved = JSON.parse(JSON.stringify(graphics[1])); A.moveItem(moved, 5, -3);
  assert.ok(C.ellipse(moved));
  moved.points[2] = [0, 0];
  assert.equal(C.ellipse(moved), null);
  // Drawing reuses its check while the points are the same, and notices a point changed in place.
  {
    const s = JSON.parse(JSON.stringify(graphics[1])), traced = () => C.trace(recorder(), s);
    assert.ok(traced() && traced(), "the cached curve draws");
    const keep = s.points[3].slice(); s.points[3][0] += 1;
    assert.equal(traced(), false, "a point edited in place draws the points");
    s.points[3][0] = keep[0];
    assert.ok(traced(), "and the curve again once the point is back");
  }
  // A native save keeps every curve, rounded to nanometres.
  const p = sheetProject(res), back = A.validate(nativeRoundTrip(p));
  const backDef = back.library.find(d => d.id === def.id), backShapes = backDef.symbol.shapes.filter(s => s.kind === "circle" || s.arc || s.ellipse);
  assert.ok(C.arc(backShapes[0]) && C.ellipse(backShapes[2]) && C.ellipse(backShapes[3]));
  const backGraphics = back.documents[0].items.filter(i => i.kind === "graphic");
  assert.ok(A.pathArc(backGraphics[0]) && C.ellipse(backGraphics[1]) && A.pathArc(backGraphics[2]));
  // Altium export writes true arcs, ellipses and elliptical arcs, and they read back the same.
  const out = AtriumAltiumExport.exportSchematic(p, doc.id), records = out.content.split(/\r?\n/).map(l => Object.fromEntries(l.split("|").filter(Boolean).map(kv => kv.split("="))));
  const curves = records.filter(x => ["8", "11", "12"].includes(x.RECORD));
  assert.deepEqual(curves.map(x => x.RECORD), ["12", "11", "8", "12", "8", "8", "11"]);
  assert.ok(!out.diagnostics.some(d => /curve|segment/i.test(d)), out.diagnostics.join(" | "));
  const again = AtriumSCH.read("Again.SchDoc", null, out.content), againDoc = again.documents[0];
  const againPart = againDoc.items.find(i => i.kind === "part"), againDef = again.library.find(d => d.id === againPart.def);
  const againShapes = againDef.symbol.shapes.filter(s => s.kind === "circle" || s.arc || s.ellipse);
  assert.equal(againPart.angle, part.angle);
  againShapes.forEach((s, i) => { assert.equal(s.kind, shapes[i].kind); assert.equal(s.points?.length, shapes[i].points?.length); (s.points || []).forEach((q, k) => near(q, shapes[i].points[k], 2e-5)); });
  const againGraphics = againDoc.items.filter(i => i.kind === "graphic"), shift = [out.offset[0], -out.offset[1]];
  againGraphics.forEach((g, i) => g.points.forEach((q, k) => near(q, [graphics[i].points[k][0] + shift[0], graphics[i].points[k][1] + shift[1]], 2e-5)));
}
// C. Bézier curves (record 5) keep their control points beside an even flattening, on a rotated
// symbol and on the sheet; they draw as cubic curves, survive a native save and export as record 5.
{
  const text = ascii(r => {
    const comp = r({RECORD:1, LIBREFERENCE:"Fuse", "LOCATION.X":300, "LOCATION.Y":300, ORIENTATION:1, CURRENTPARTID:1, DISPLAYMODE:0});
    r({OWNERINDEX:comp, OWNERPARTID:1, RECORD:2, DESIGNATOR:"1", NAME:"A", "LOCATION.X":280, "LOCATION.Y":300, PINLENGTH:10, ELECTRICAL:4, PINCONGLOMERATE:2});
    r({OWNERINDEX:comp, OWNERPARTID:1, RECORD:34, NAME:"Designator", TEXT:"F1", "LOCATION.X":300, "LOCATION.Y":320});
    r({OWNERINDEX:comp, OWNERPARTID:1, RECORD:5, LINEWIDTH:1, LOCATIONCOUNT:4, X1:301, Y1:300, X2:308, Y2:315, X3:312, Y3:285, X4:319, Y4:300});
    r({RECORD:5, LOCATIONCOUNT:7, X1:100, Y1:200, X2:120, Y2:240, X3:140, Y3:160, X4:160, Y4:200, X5:180, Y5:240, X6:200, Y6:160, X7:220, Y7:200});
    r({RECORD:5, LOCATIONCOUNT:2, X1:100, Y1:100, X2:200, Y2:100});
  });
  const f = sink(), res = AtriumSCH.read("Fuse.SchDoc", null, text, {fidelity:f});
  assert.ok(!res.notes.some(n => /Bézier/.test(n)), res.notes.join(" | "));
  const rows = f.rows.filter(x => x.kind === "Bézier curve");
  assert.deepEqual(rows.map(x => x.status), ["kept", "kept", "approximated"]);
  const doc = res.documents[0], part = doc.items.find(i => i.kind === "part"), def = res.library.find(d => d.id === part.def);
  const shape = def.symbol.shapes.find(x => x.bezier), cp = C.bezier(shape);
  assert.ok(cp, "the symbol curve still matches its points");
  [[301, 300], [308, 315], [312, 285], [319, 300]].forEach((q, k) => near(A.world(cp[k], part), alt(q[0], q[1], 0, 0, 0)));
  const sheet = doc.items.find(i => i.kind === "graphic" && i.bezier), sheetCp = C.bezier(sheet);
  assert.equal(sheetCp.length, 7);
  near(sheet.points.at(-1), alt(220, 200, 0, 0, 0));
  near(sheet.points[(sheet.points.length - 1) / 2], alt(160, 200, 0, 0, 0));
  const ctx = recorder(); AtriumSchAppearance.shape(ctx, shape, 10, false);
  assert.ok(ctx.calls.includes("bezierCurveTo") && !ctx.calls.includes("lineTo"), ctx.calls.join(","));
  const moved = JSON.parse(JSON.stringify(sheet)); A.moveItem(moved, -2, 7);
  assert.ok(C.bezier(moved), "a move keeps the curve");
  moved.points[3] = [0, 0];
  assert.equal(C.bezier(moved), null, "an edited point draws the points");
  const p = sheetProject(res), back = A.validate(nativeRoundTrip(p));
  assert.ok(C.bezier(back.library.find(d => d.id === def.id).symbol.shapes.find(x => x.bezier)));
  assert.ok(C.bezier(back.documents[0].items.find(i => i.kind === "graphic" && i.bezier)));
  const out = AtriumAltiumExport.exportSchematic(p, doc.id);
  const records = out.content.split(/\r?\n/).map(l => Object.fromEntries(l.split("|").filter(Boolean).map(kv => kv.split("=")))).filter(x => x.RECORD === "5");
  assert.deepEqual(records.map(x => x.LOCATIONCOUNT), ["7", "4"]);
  const again = AtriumSCH.read("Again.SchDoc", null, out.content), againDef = again.library[0];
  const againShape = againDef.symbol.shapes.find(x => x.bezier);
  againShape.points.forEach((q, k) => near(q, shape.points[k], 2e-5));
}
// The immutable native fixture with these optional fields opens with every curve and directive intact.
{
  const fs = require("node:fs"), path = require("node:path"), M = AtriumFormat2Model;
  const dir = path.join(__dirname, "../fixtures/format-2/schematic-curves"), read = f => new Uint8Array(fs.readFileSync(path.join(dir, f)));
  const {project, members} = M.manifest(M.parse(read("Schematic Curves.waffle")));
  for (const m of members) { const r = M.parse(read(m.path)); if (m.kind === "library") project.library.push(M.library(r, {})); else project.documents.push(M.document(r, {name:m.name})); }
  A.validate(project);
  const shapes = project.library[0].symbol.shapes, items = project.documents[0].items;
  assert.deepEqual(shapes.map(s => s.kind === "circle" ? "circle" : C.arc(s) ? "arc" : C.ellipse(s) ? "ellipse" : C.bezier(s) ? "bezier" : "points"), ["circle", "arc", "ellipse", "ellipse", "bezier"]);
  assert.ok(A.pathArc(items.find(i => i.arc)) && C.ellipse(items.find(i => i.ellipse)) && C.bezier(items.find(i => i.bezier)));
  project.documents.push(A.sheet("pcb", "Board"));
  const M2 = S.model(project, project.documents[1]);
  assert.equal(M2.signals.find(x => x.name === "CAN").kind, "diff");
  assert.deepEqual([...M2.netsOfTag("PowerNets")], ["RS485_A"]);
}
console.log("altium-sch-intent: ok");
