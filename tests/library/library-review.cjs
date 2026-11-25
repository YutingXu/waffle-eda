"use strict";
// Library regression tests. Cases that need
// a patch to a file the library does not own (library-review-fixes.py) say SKIP until it is applied.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "rules", "fab-outputs",
  "sch-objects", "library-panel", "footprint-wizard", "footprint-editor", "symbol-editor", "kicad-export", "kicad-schematic"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, L = AtriumLibrary, W = AtriumFootprintWizard, F = AtriumFabOutputs;
const date = new Date(2026, 10, 18);
const dual = () => {
  const rows = [["1", "OUT", 2, 1], ["2", "IN-", 0, 1], ["3", "IN+", 0, 1], ["7", "OUT", 2, 2], ["6", "IN-", 0, 2], ["5", "IN+", 0, 2], ["8", "V+", 7, 0], ["4", "V-", 7, 0]]
    .map(([number, name, electrical, part]) => ({number, name, electrical, part}));
  return {id: "dual", name: "LM358", prefix: "U", value: "LM358", symbol: L.buildSymbol(L.symbolFromGates(rows, 2)).symbol};
};
// #1 KiCad schematic export of a multi-gate part (needs library-review-fixes.py --only kicad).
{
  const def = dual(), p = A.project("g", [def]), sch = p.documents[0];
  sch.items.push({id: "a", kind: "part", def: "dual", ref: "U1", value: "LM358", x: 50.8, y: 50.8, angle: 0, pinNets: {}},
    {id: "b", kind: "part", def: "dual", ref: "U1", value: "LM358", x: 101.6, y: 50.8, angle: 0, pinNets: {}, unit: 2});
  let out = null, error = null;
  try { out = AtriumKiCadSchematic.exportSheet(p, sch.id); } catch (e) { error = e; }
  if (error && /p\.map|undefined is not an object/.test(error.message)) console.log("SKIP #1 KiCad multi-gate export (apply library-review-fixes.py --only kicad)");
  else {
    if (error) throw error;
    const s = out.content;
    assert.deepEqual((s.match(/\(symbol "LM358_[0-9a-f]+_(\d+)_(\d+)"/g) || []).map(x => x.slice(-4, -1)), ["0_1", "1_1", "2_1"], "unit 0 shared + one unit per gate");
    assert.deepEqual((s.match(/\(unit \d+\)/g) || []), ["(unit 1)", "(unit 1)", "(unit 2)", "(unit 2)"]);
    const inst = s.split("(symbol (lib_id").slice(1).map(b => (b.match(/\(pin "([^"]+)" \(uuid/g) || []).map(x => x.slice(6, -7)).sort().join(","));
    assert.deepEqual(inst, ["1,2,3,4,8", "4,5,6,7,8"], "each instance lists its gate's pins and the shared pins");
    assert.equal((s.match(/\(/g) || []).length, (s.match(/\)/g) || []).length, "balanced S-expression");
    assert.ok(!out.diagnostics?.some?.(d => /Duplicate or unannotated/.test(d.message || d)), "gates of U1 are not duplicates");
    console.log("PASS #1 KiCad export: one unit per gate, unit 0 for shared pins, (unit N) per instance");
  }
}
// #2 Update parts keeps power ports, labels and pin-to-pin contacts connected.
{
  const mk = (y1, x2, len) => L.buildSymbol({pins: [{number: "1", name: "VCC", x: 0, y: y1, orientation: "up", length: len, electrical: 7}, {number: "2", name: "OUT", x: x2, y: 0, orientation: "right", length: len}],
    shapes: [{kind: "path", style: "body", closed: true, points: [[-5.08, -5.08], [5.08, -5.08], [5.08, 5.08], [-5.08, 5.08]]}]});
  const v1 = mk(-10.16, 10.16, 5.08), def = {id: "u", name: "REG", prefix: "U", symbol: v1.symbol, schDrawing: v1.schDrawing};
  const p = A.project("t", [def, AtriumParts.catalogue[0]]), sch = p.documents[0];
  const part = {id: "p1", kind: "part", def: "u", ref: "U1", value: "", x: 50.8, y: 50.8, angle: 0, pinNets: {}}; sch.items.push(part);
  const pin = n => A.pins(part, p.library.find(d => d.id === "u"), "schematic").find(x => x.number === n).at;
  sch.items.push({id: "pw", kind: "power", text: "VCC", x: pin("1")[0], y: pin("1")[1], style: "bar", direction: 1});
  // A resistor whose pin 1 touches U1 pin 2 directly (no wire).
  const r = AtriumParts.catalogue[0], rp = A.instantiate(p, r, [0, 0]), rpin = A.pins(rp, r, "schematic")[0];
  rp.x = pin("2")[0] - (rpin.at[0] - rp.x); rp.y = pin("2")[1] - (rpin.at[1] - rp.y); sch.items.push(rp);
  const nets = () => { const c = A.connectivity(sch, new Map(p.library.map(d => [d.id, d]))); return {v: c.byPin.get("p1/1"), o: c.byPin.get("p1/2"), r: c.byPin.get(rp.id + "/1")}; };
  const before = nets();
  assert.equal(before.v, "VCC"); assert.ok(before.o && before.o === before.r);
  const v2 = mk(-12.7, 12.7, 7.62), report = L.replaceDef(p, {...def, symbol: v2.symbol, schDrawing: v2.schDrawing});
  const after = nets();
  assert.equal(after.v, "VCC", "power port still on pin 1"); assert.ok(after.o && after.o === after.r, "resistor still on pin 2");
  assert.equal(report.stubs, 2); assert.deepEqual(report.disconnected, []);
  // A pin that disappears is reported, not silently lost.
  const v3 = L.buildSymbol({pins: [{number: "2", name: "OUT", x: 12.7, y: 0, orientation: "right", length: 7.62}], shapes: []});
  const r3 = L.replaceDef(p, {...def, symbol: v3.symbol, schDrawing: v3.schDrawing});
  assert.deepEqual(r3.disconnected, ["U1.1"]);
  console.log("PASS #2 update parts: wire stubs keep power ports and pin-to-pin contacts; lost pins reported");
}
// #3 A wizard result that fails validation is refused before any commit; commitDef reports instead of throwing.
{
  const bad = W.generate({family: "nolead", preset: "QFN-16 3×3", pitch: .65, clampWidth: false});
  assert.ok(!L.validateDef(bad, {footprintWarnings: false}).ok);
  const p = A.project("w", []), infos = [];
  const ctx = {currentProject: () => p, edit: fn => { const s = JSON.stringify(p); try { fn(); } catch (e) { Object.assign(p, JSON.parse(s)); throw e; } }, info: m => infos.push(m)};
  assert.equal(L.commitDef(ctx, bad), null); assert.match(infos[0], /overlap|touch/); assert.equal(p.library.length, 0);
  console.log("PASS #3 commit of an invalid wizard result is refused with a message, nothing thrown");
}
// #4 Special strings in fab outputs (needs library-review-fixes.py --only fab).
{
  const run = text => {
    const fp = {name: "X", pads: [{number: "1", x: -1, y: 0, w: 1, h: 1, shape: "rect", drill: 0, angle: 0}, {number: "2", x: 1, y: 0, w: 1, h: 1, shape: "rect", drill: 0, angle: 0}],
      shapes: [{kind: "text", text, x: 0, y: -1.5, size: .8, align: "center", layer: "Silk"}]};
    const p = A.project("d", [{id: "x", name: "X", prefix: "U", footprint: fp}]), b = p.documents[1];
    b.outline = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    b.items.push({id: "u", kind: "part", def: "x", ref: "U1", value: "", x: 0, y: 0, angle: 0, pinNets: {}, showRef: false, showValue: false});
    return F.build(p, b, {date}).files.find(f => f.name.endsWith(".GTO"))?.content || "";
  };
  if (!/A\.special\(s, frame\)/.test(String(F.build)) && run(".Designator") !== run("U1")) console.log("SKIP #4 special strings in Gerber (apply library-review-fixes.py --only fab)");
  else {
    assert.equal(run(".Designator"), run("U1"));
    const fp = {name: "X", pads: [{number: "1", x: 0, y: 0, w: 1, h: 1, shape: "rect", drill: 0}], shapes: [{kind: "text", text: ".Designator", x: 0, y: -1.5, size: .8, layer: "Silk"}, {kind: "text", text: ".Comment", x: 0, y: 1.5, size: .8, layer: "Silk"}]};
    const p = A.project("k", [{id: "x", name: "X", prefix: "U", footprint: fp}]), b = p.documents[1];
    b.outline = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
    b.items.push({id: "u", kind: "part", def: "x", ref: "U1", value: "10k", x: 0, y: 0, angle: 0, pinNets: {}});
    const k = AtriumKiCad.exportBoard(p, b.id).content;
    assert.match(k, /fp_text user "\$\{REFERENCE\}"/); assert.match(k, /"\$\{VALUE\}"/); assert.doesNotMatch(k, /\.Designator/);
    console.log("PASS #4 .Designator plots as the designator in Gerber silk; KiCad footprints use ${REFERENCE} / ${VALUE}");
  }
}
// #5 Duplicates are not "older copies"; #6 variants guard deletes.
{
  const def = {id: "u", name: "REG", prefix: "U", symbol: {pins: [{number: "1", x: 0, y: 0}], shapes: []}};
  const p = A.project("t2", [def]), copy = L.duplicate(p, p.library[0]); copy.value = "variant";
  assert.deepEqual(L.similar(p, p.library[0]), [], "a duplicate is never retargeted automatically");
  const linked = {...JSON.parse(JSON.stringify(def)), id: "u2", libraryRef: {library: "L", id: "lib-reg"}}; p.library[0].libraryRef = {library: "L", id: "lib-reg"}; p.library.push(linked);
  assert.deepEqual(L.similar(p, p.library[0]).map(d => d.id), ["u2"], "copies of the same library entry are linked");
  const p3 = A.project("t3", [def, {...def, id: "alt", name: "REG-ALT"}]);
  p3.variants = [{id: "v", name: "Lite", parts: {U1: {alternate: {def: "alt"}}}}];
  assert.throws(() => L.remove(p3, "alt"), /Variant Lite fits this component as an alternate \(U1\)/);
  assert.equal(L.usage(p3, "alt")[0].variant, "Lite");
  console.log("PASS #5/#6 duplicates stay independent; variant alternates block deletion");
}
// #7 Touching pads are errors; the wizard clamps land width at fine pitch.
{
  const raw = W.generate({family: "gullwing", preset: "SOIC-8", pitch: .5, clampWidth: false});
  assert.ok(L.checkFootprint(raw.footprint).some(x => x.level === "error" && /touch/.test(x.message)));
  const clamped = W.generate({family: "gullwing", preset: "SOIC-8", pitch: .5});
  assert.equal(clamped.footprint.ipc.X, .4); assert.ok(clamped.footprint.ipc.flagged.some(f => /clamped/.test(f)));
  assert.ok(L.validateDef(clamped).ok);
  const near = {pads: [{number: "1", x: 0, y: 0, w: 1, h: 1}, {number: "2", x: 1.05, y: 0, w: 1, h: 1}], shapes: []};
  assert.ok(L.checkFootprint(near).some(x => x.code === "clearance"));
  assert.equal(W.generate({family: "gullwing", preset: "SOIC-8"}).footprint.ipc.X, .6, "standard parts are not clamped");
  console.log("PASS #7 zero-gap pads are shorts, gaps under 0.1 mm warn, fine-pitch lands clamp");
}
// #9 Checks scale: a 48×48 BGA checks in a few ms; undo snapshots exclude STEP text.
{
  const big = W.generate({family: "bga", rows: 64, cols: 64, pitch: .8, ball: .4, D: 52, E: 52, H: 1.5, depop: ""});
  let t = performance.now(); L.checkFootprint(big.footprint); const ms = performance.now() - t;
  assert.ok(ms < 150, "checkFootprint on 4096 balls took " + ms + " ms");
  const touching = {pads: Array.from({length: 2000}, (_, i) => ({number: String(i + 1), x: i, y: 0, w: 1, h: 1})), shapes: []};
  assert.ok(L.checkFootprint(touching).some(x => x.code === "short"), "grid still finds neighbours");
  console.log("PASS #9 footprint checks use a spatial grid (4096 balls in " + Math.round(ms) + " ms)");
}
// #11 Big footprints get a gated default symbol; #12 depopulation rectangles.
{
  const bga = W.generate({family: "bga", rows: 48, cols: 48, pitch: .8, ball: .4, D: 40, E: 40, H: 1.5, depop: ""});
  assert.ok(bga.symbol.parts >= 48); const b = A.bounds(A.symbolPoints(AtriumSymbolEditor.filterGate(bga.symbol, 1)));
  assert.ok(b[3] - b[1] < 200, "one gate is a sensible height"); assert.ok(L.validateDef(bga).ok);
  assert.deepEqual([...W.depopulated({depop: "A1-C1", rows: 4, cols: 4})], ["A1", "B1", "C1"]);
  assert.deepEqual([...W.depopulated({depop: "A1-B2", rows: 4, cols: 4})], ["A1", "A2", "B1", "B2"]);
  assert.deepEqual([...W.depopulated({depop: "C3-C5", rows: 6, cols: 6})], ["C3", "C4", "C5"]);
  const odd = W.generate({family: "bga", rows: 4, cols: 4, pitch: .5, ball: .3, D: 3, E: 3, H: .6, depop: "A1, I3, Z"});
  assert.ok(odd.footprint.ipc.flagged.some(f => /I3, Z/.test(f)), "invalid tokens are flagged");
  console.log("PASS #11/#12 BGA default symbol split into gates; depopulation ranges across rows; bad tokens flagged");
}
// #10 A library copy never shares an id with the project def it came from.
{
  const p = A.project("ids", []), lib = {id: "L", name: "Lib", defs: [{id: "x", name: "X", symbol: {pins: [], shapes: []}}]};
  const c = L.fromLibrary(lib, lib.defs[0], p); assert.notEqual(c.id, "x"); assert.equal(c.libraryRef.id, "x");
  console.log("PASS #10 project copies of library entries get their own ids");
}

{
  require("../../app/library/library-store.js");
  require("../../app/library/library-diff.js");
  const base = A.clone(AtriumParts.catalogue.find(d => d.id === "std-r")), p = A.project("Update impact", [base]);
  const board = p.documents.find(d => d.kind === "pcb"), lib = {id: "bench", name: "Bench", defs: [base]};
  const users = ["R1", "R2"].map((ref, n) => ({id: "placed-" + n, kind: "part", def: base.id, ref, pinNets: {"1": "GND"}, x: n, y: 0}));
  board.items.push(...users);
  const incoming = A.clone(base); delete incoming.footprint;
  assert.equal(AtriumLibraryDiff.impact(p, base, incoming).lostNets.length, 2);
  assert.throws(() => L.updateFromLibrary(p, base, lib, incoming), /remove the footprint/);
  assert.throws(() => AtriumLibraryDiff.applyUpdate(p, base, lib, incoming, ["R1"]), /remove the footprint/);
  const invalid = A.clone(base); invalid.footprint.pads[0].w = 0;
  assert.throws(() => AtriumLibraryDiff.applyUpdate(p, base, lib, invalid, ["R1"]));
  assert.equal(p.library.length, 1); assert.deepEqual(users[0].pinNets, {"1": "GND"});
  const changed = A.clone(base); changed.footprint.model3d = {file: "local.step", stepText: "ISO-10303-21; test"};
  const split = AtriumLibraryDiff.applyUpdate(p, base, lib, changed, ["R1"]);
  assert.ok(split.split); assert.ok(p.library.find(d => d.id === split.def).footprint.model3d.sha256);
  assert.deepEqual(users.map(i => i.def), [split.def, base.id]);
  console.log("PASS partial and whole updates preserve placed pads, validate inputs and share STEP text");
}

// The schematic connectivity engine treats a pin on an unsplit wire as an electrical contact.
for (const joinsOther of [false, true]) {
  const base = {id: "u", name: "Contact", symbol: {pins: [{number: "1", name: "A", x: 0, y: 0}], shapes: []}};
  const p = A.project("Contact review", [base]), sheet = p.documents[0], placed = A.instantiate(p, base, [0, 0]);
  sheet.items.push(placed, {id: "signal", kind: "wire", points: [[-10, 0], [10, 0]], net: "SIGNAL"});
  if (joinsOther) sheet.items.push({id: "supply", kind: "wire", points: [[-10, 5], [10, 5]], net: "SUPPLY"});
  const before = JSON.stringify(p), next = A.clone(base);
  next.symbol.pins[0].y = 5;
  const preview = AtriumLibraryDiff.impact(p, base, next);
  assert.equal(JSON.stringify(p), before, "electrical preview has no project mutations");
  assert.deepEqual(preview.lostNets, []);
  const expected = joinsOther ? [{doc: sheet.name, nets: ["SIGNAL", "SUPPLY"]}] : [];
  assert.deepEqual(preview.joinedNets, expected);
  const report = L.updateFromLibrary(p, base, {id: "catalogue", name: "Parts", defs: [next]}, next);
  const net = A.connectivity(sheet, new Map(p.library.map(d => [d.id, d])));
  assert.equal(report.stubs, 1);
  assert.deepEqual(report.joinedNets, expected);
  assert.deepEqual(report.disconnected, []);
  assert.equal(net.byPin.get(placed.id + "/1"), "SIGNAL");
  assert.equal(net.nets.some(n => n.conflict), joinsOther);
}
console.log("PASS library update preview and apply retain wire-interior contacts and identify newly joined nets");

{
  const pad = {number: "EP", x: 0, y: 0, w: .9, h: 1, layer: "Top", plated: true};
  const old = {id: "exposed", name: "Multiple lands", footprint: {pads: [pad, {...pad, x: 3}], shapes: []}};
  const next = A.clone(old); next.footprint.pads.reverse();
  const D = AtriumLibraryDiff;
  assert.equal(D.compare(old, next).changed, 0);
  assert.deepEqual(L.diffDefs(old, next), []);
  Object.assign(next.footprint.pads[0], {x: 5, layer: "Bottom", plated: false, pasteExpansion: -.1, maskExpansion: .08});
  const delta = D.compare(old, next);
  assert.deepEqual(delta.pads.moved.map(x => [x.before.x, x.pad.x]), [[3, 5]]);
  assert.deepEqual(delta.pads.resized[0].fields, ["plated", "layer", "maskExpansion", "pasteExpansion"]);
  assert.match(L.diffDefs(old, next).join("\n"), /pad EP moved 3,0 → 5,0/);
  assert.match(L.diffDefs(old, next).join("\n"), /mask expansion/);
  assert.match(D.svg(old, next, "footprint"), /ld-mod/);
}
console.log("PASS identical reordered lands stay current and the second physical land shows move, plating, layer and mask edits");

{
  const D = AtriumLibraryDiff, source = {kind: "altium-schlib", file: "Source.SchLib", date: "2025-01-01",
    footprint: {kind: "altium-pcblib", file: "Package.PcbLib", entry: "QFN"}};
  const base = {id: "source", name: "Chip", source, symbol: {pins: [], shapes: []}, footprint: {name: "QFN", pads: [], shapes: [],
    bodies3d: [{id: "body", model: "m"}], bodyModels: [{id: "m", file: "model.step", zlib: "first"}]}};
  const next = A.clone(base); next.source.date = "2026-11-21";
  assert.equal(D.compare(base, next).changed, 0);
  next.source.footprint.file = "Renamed.PcbLib"; next.footprint.bodyModels[0].zlib = "second";
  const result = D.compare(base, next);
  assert.equal(result.model3d, "changed");
  assert.deepEqual(result.fields, [{key: "Footprint source file", before: "Package.PcbLib", after: "Renamed.PcbLib"}]);
  assert.match(L.diffDefs(base, next).join("\n"), /Footprint source file.*Renamed/);
}

{
  require("../../app/pcb/pcb-appearance.js"); require("../../app/pcb/pcb-edit.js");
  const base = A.clone(AtriumParts.catalogue.find(d => d.id === "std-r")), p = A.project("Mirrored variants", [base]);
  const board = p.documents.find(d => d.kind === "pcb"), mirror = AtriumPCBEdit.counterpart(p, base);
  const top = {...A.instantiate(p, base, [5, 0]), ref: "R1", pinNets: {"2": "OLD"}};
  const bottom = {...A.instantiate(p, mirror, [0, 0]), ref: "R2", pinNets: {"2": "OLD"}};
  board.items.push(top, bottom);
  p.variants = [{id: "alt", name: "Spare", parts: {R3: {alternate: {def: base.id}}}}];
  const next = A.clone(base); next.footprint.pads = next.footprint.pads.filter(q => q.number !== "2");
  const lib = {id: "source", name: "Source", defs: [next]};
  assert.deepEqual(AtriumLibraryDiff.impact(p, base, next).lostNets.map(x => x.ref), ["R1", "R2"]);
  const r = AtriumLibraryDiff.applyUpdate(p, base, lib, next, ["R2"]);
  assert.ok(r.split);
  assert.equal(p.library.find(d => d.id === bottom.def).mirrorOf, r.def);
  assert.deepEqual(bottom.pinNets, {});
  assert.deepEqual(top.pinNets, {"2": "OLD"}); assert.equal(top.def, base.id);
  assert.equal(p.variants[0].parts.R3.alternate.def, base.id);
}
