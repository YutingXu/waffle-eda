"use strict";

// The production journal, staged live queue, native project storage and copper-film
// generator. The host deliberately has no canvas: exact completion must survive an absent frame.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model", "parts", "spatial", "sch-objects", "hierarchy", "board-shape", "stackup", "impedance",
  "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "altium-rules", "pcb-draw", "component-classes",
  "query", "net-intent", "signals", "rules", "viastack", "polygon-pour", "import-link", "source-file", "sch-import", "pcb-import", "io",
  "save-cache", "bom", "import-rules", "fab-outputs", "undo-store", "edit-pipeline"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const A = Atrium, P = AtriumPolygonPour, F = AtriumFabOutputs, U = AtriumUndoStore, R = AtriumPCBPours;
const compare = require("../formats/gerber-compare.cjs");
const date = new Date(Date.UTC(2026, 10, 20, 12)), wait = ms => new Promise(r => setTimeout(r, ms));
const rect = (x, y, X, Y) => [[x, y], [X, y], [X, Y], [x, Y]];
const via = (id, x, y, net) => ({kind: "via", id, x, y, net, diameter: .8, drill: .3, layer: "Multi"});
const zone = (id, points, net, layer = "Top", fields = {}) => P.make(points, {id, net, layer, ...fields});
const pcb = p => p.documents.find(d => d.kind === "pcb");
const defs = p => new Map(p.library.map(d => [d.id, d]));
const {nativeRoundTrip:reopen,nativeImported}=require("../support/native-cad.cjs");
function project(items) {
  const p = A.project("Review"), d = pcb(p);
  d.outline = rect(0, 0, 50, 40); d.items = items;
  return p;
}
function films(p,provenance) {
  const m = F.analyse(p, pcb(p),{provenance}), plan = F.plan(m, {date}), copper = {};
  for (const f of plan.files) if (f.kind === "gerber" && /\.(GTL|GBL|G\d+)$/.test(f.name)) {
    copper[f.name] = F.generate(m, plan, f).content;
  }
  assert.ok(Object.keys(copper).length >= 2);
  return copper;
}
function checkExact(p, label, compact = false) {
  const reference = A.clone(p), d = pcb(reference);
  P.apply(d, defs(reference), {project: reference, reuse: false});
  const regions = board => (board.pcbDrawing.pours || []).map(r => compact ? {
    ...r, bounds: r.bounds.map(A.projectNumber), ...(r.arcs ? {arcs: r.arcs.map(A.projectNumber)} : {})
  } : r);
  assert.deepEqual(regions(pcb(p)), regions(d), label + " exact islands, holes, arcs and connectivity");
  assert.deepEqual(films(p), films(reference), label + " fabrication films");
  assert.deepEqual(P.stale(pcb(p), defs(p), {project: p}), [], label + " settled signatures");
}
async function settle() {
  for (let i = 0; i < 3000 && P.live.busy; i++) await wait(2);
  assert.equal(P.live.busy, false, "staged exact work completed");
}
function editor(p) {
  P.live.reset(); P.tiles.enable(false); P.live.setMode("live"); U.reset();
  const history = [], future = [], listeners = [], library = defs(p);
  const idle = {afterFrame: fn => setTimeout(fn, 1), idle: fn => setTimeout(fn, 0), cancel: clearTimeout};
  const queue = AtriumEditPipeline.create(idle, () => true);
  let revision = 0;
  function changed(source) {
    revision++;
    if (source === "pours") queue.suspend(); else queue.supersede();
    if (source) U.touch(p); else U.record(p);
    queue.resume();
    for (const f of listeners) f({source});
  }
  const h = {
    project: () => p, doc: () => pcb(p), defs: () => library, revision: () => revision, stageEdit: queue.stage,
    on(t, fn) { if (t === "change") listeners.push(fn); }, redraw() {}, invalidate() {},
    edit(fn) { U.checkpoint(history, future, U.mark(p, {current: pcb(p).id}), "Edit"); fn(pcb(p)); changed(); },
    derive(fn, detail) { fn(); changed(detail?.source); },
    jump(n) { U.jump(history, future, U.mark(p, {current: pcb(p).id}), n); p = U.root(); changed("undo"); }
  };
  P.live.attach(h);
  return h;
}

async function checkEdits() {
  const p = project([zone("plane", rect(1, 1, 19, 19), "GND"), via("anchor", 10, 10, "GND")]);
  P.apply(pcb(p), defs(p), {project: p}); let h = editor(p);
  h.edit(d => { d.items[1].x = 30; }); await settle();
  assert.equal(pcb(p).pcbDrawing.pours, undefined);
  assert.ok(pcb(p).pcbDrawing.pourSignatures.plane, "an evaluated empty pour survives without an island");
  checkExact(reopen(p), "reopen with zero islands");
  const saved = reopen(p); h = editor(saved);
  h.edit(d => { d.items[1].x = 10; });
  assert.equal(F.pourStatus(pcb(saved), defs(saved), saved), "stale", "an edited empty pour is flagged before export");
  await settle(); checkExact(saved, "anchor restored"); assert.equal(pcb(saved).pcbDrawing.pours.length, 1);
  h.jump(-1); await settle(); checkExact(h.project(), "empty after undo");
  h.jump(1); await settle(); checkExact(reopen(h.project()), "nonempty after redo and reopen");

  const layers = project([
    zone("earlier", rect(1, 1, 35, 35), "A", "Top", {pourIndex: 0, removeDeadCopper: false}),
    zone("later", rect(30, 5, 48, 30), "B", "Top", {pourIndex: 1, removeDeadCopper: false}),
    zone("other", rect(1, 1, 48, 39), "C", "Bottom", {removeDeadCopper: false})
  ]);
  P.apply(pcb(layers), defs(layers), {project: layers}); h = editor(layers);
  const bottom = pcb(layers).pcbDrawing.pours.find(r => r.layer === "Bottom");
  h.edit(d => { d.items[0].points = rect(1, 1, 40, 35); });
  assert.deepEqual(P.stale(pcb(layers), defs(layers), {project: layers}), ["earlier"], "later depends on the first job's new copper");
  await settle(); checkExact(layers, "overlap"); assert.ok(pcb(layers).pcbDrawing.pours.includes(bottom));
  h.jump(-1); await settle(); checkExact(h.project(), "overlap undo");
  h.jump(1); await settle(); checkExact(reopen(h.project()), "overlap redo and reopen");

  const inherited = project([zone("plane", rect(1, 1, 30, 30), "A", "Top", {removeDeadCopper: false}), via("via", 7, 7, "B")]);
  P.apply(pcb(inherited), defs(inherited), {project: inherited}); h = editor(inherited);
  const before = films(inherited);
  // The project rule book's board-wide clearance (project-rules.js).
  h.edit(() => { AtriumProjectRules.edit(inherited, b => { b.list.find(r => r.type === "clearance" && AtriumDesignQueryRecord.isAll(r.scope)).gap = 1.4; }); });
  assert.equal(F.pourStatus(pcb(inherited), defs(inherited), inherited), "stale");
  await settle(); checkExact(inherited, "project-level clearance"); assert.notDeepEqual(films(inherited), before);
  h.jump(-1); await settle(); checkExact(h.project(), "project rules undo"); assert.deepEqual(films(h.project()), before);
  h.jump(1); await settle(); checkExact(reopen(h.project()), "project rules redo and reopen");

  const smart = project([
    zone("plane", rect(1, 1, 20, 20), "SENSE", "Top", {connectStyle: "auto", removeDeadCopper: false}),
    {kind: "pad", id: "local-pad", number: "1", x: 8, y: 8, w: 1.5, h: 1.5, drill: 0, shape: "round", layer: "Top", net: "SENSE"},
    {kind: "part", id: "far", ref: "U1", value: "", def: "std-r", x: 38, y: 38, angle: 0, layer: "Top", pinNets: {"1": "SENSE"}}
  ]);
  smart.library = [A.clone(AtriumParts.catalogue.find(part => part.id === "std-r"))];
  const initial = P.apply(pcb(smart), defs(smart), {project: smart}), relief = pcb(smart).pcbDrawing.pours[0].data;
  assert.equal(initial.stats.polygons.plane.connections[0].style, "relief");
  const older = A.clone(smart), oldBoard = pcb(older);
  oldBoard.pcbDrawing.pourSignatureVersion = 2;
  oldBoard.pcbDrawing.pourSignatures = {plane: "2:4ae8e9d487e036ea"}; // The version 2 writer produced this for both U1 and Q1.
  oldBoard.items[2].ref = "Q1";
  assert.deepEqual(P.stale(oldBoard, defs(older)), ["plane"], "the version 2 stamp cannot certify the old thermal");
  const tiles = P.tiles.build(pcb(smart), defs(smart), {project: smart}); h = editor(smart);
  h.edit(d => { d.items[2].ref = "Q1"; });
  assert.equal(P.tiles.diff(pcb(smart), defs(smart), tiles, {project: smart}, ["far"]), null,
    "changed power classification invalidates tile sessions that contain other pads on the net");
  assert.deepEqual(P.stale(pcb(smart), defs(smart), {project: smart}), ["plane"]);
  assert.equal(F.pourStatus(pcb(smart), defs(smart), smart), "stale");
  await settle(); checkExact(smart, "distant component changes a local connection");
  assert.notEqual(pcb(smart).pcbDrawing.pours[0].data, relief, "the relief gap was replaced with solid copper");
  const classified = A.clone(smart);
  assert.equal(P.repourAll(pcb(classified), defs(classified), {reuse: false, project: classified}).stats.polygons.plane.connections[0].style, "direct");
  pcb(classified).items[2].ref = "Q2";
  assert.deepEqual(P.stale(pcb(classified), defs(classified), {project: classified}), [], "a renumbering with the same copper decision stays current");
  h.jump(-1); await settle(); checkExact(h.project(), "smart connection undo");
  assert.equal(pcb(h.project()).pcbDrawing.pours[0].data, relief);
  h.jump(1); await settle(); checkExact(reopen(h.project()), "smart connection redo and reopen");
  P.live.reset(); U.reset();
}

function importedFilms() {
  const dir = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
  const originals=[];
  const p = A.project("PiDP-11"); p.documents = []; p.library = [];
  for (const name of ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"]) {
    const bytes=new Uint8Array(fs.readFileSync(path.join(dir,name))); originals.push({name,bytes});
    const read = AtriumIO.read(name,bytes);
    p.documents.push(...(read.documents || [])); p.library.push(...(read.library || []));
    if (read.manifest?.parameters) p.parameters = read.manifest.parameters;
  }
  AtriumImportLink.reconcile(p, p.documents); A.validate(p);
  const d = pcb(p), regions = d.pcbDrawing.pours.map(r => r.data);
  const editedFirst = A.clone(p);
  pcb(editedFirst).items.find(i => i.kind === "via").x += 1;
  assert.equal(F.pourStatus(pcb(editedFirst), defs(editedFirst), editedFirst), "stale",
    "first inspection after an edit cannot adopt obsolete native copper");
  const changedSettings = A.clone(p);
  pcb(changedSettings).items.find(i => i.kind === "polygon").clearance = 1.1;
  assert.equal(F.pourStatus(pcb(changedSettings), defs(changedSettings), changedSettings), "stale",
    "source artwork cannot authenticate a changed zone clearance before first inspection");
  P.adopt(pcb(changedSettings), defs(changedSettings), {project: changedSettings});
  checkExact(changedSettings, "new zone clearance before first inspection");
  const applied = AtriumImportRules.apply(d, p, defs(p));
  assert.equal(applied.kept, 2); assert.equal(applied.repoured, 0);
  require("../../app/formats/translator-precision.js");
  const before=films(p), {project:saved,provenance}=nativeImported(p,originals);
  const groups=AtriumImportSidecars.manufacturingProvenance([provenance],pcb(saved).id);
  const after=films(saved,groups);
  assert.deepEqual(pcb(saved).pcbDrawing.pours.map(r => r.data), regions, "preserved all imported Altium fill payloads");
  assert.deepEqual(after, before, "both copper films identical across native save and reopen");
  for (const [name, content] of Object.entries(after)) {
    const ref = compare.parseGerber(fs.readFileSync(path.join(dir, "altium-outputs-reva", name), "utf8"));
    const out = compare.parseGerber(content);
    assert.equal(out.regionCount, ref.regionCount, name + " plotted islands and holes");
    const a = compare.regionSegments(ref), b = compare.regionSegments(out);
    for (const [from, to] of [[a, b], [b, a]]) {
      const deviation = compare.pathDeviation(from, to, {step: .05, cap: .004, cell: .08});
      assert.ok(deviation.max <= .000254, name + " stored copper within the reference's 0.254 µm resolution");
    }
  }
  pcb(saved).items.find(i => i.kind === "via").x += 1;
  assert.equal(F.pourStatus(pcb(saved), defs(saved), saved), "stale", "a genuine post-import geometry edit is detected");
}

function changedRegion() {
  const circle = x => Array.from({length: 1600}, (_, i) => {
    const a = 2 * Math.PI * i / 1600; return [x + 2 * Math.cos(a), 10 + 2 * Math.sin(a)];
  });
  const replacement = x => R.region([circle(x), rect(x - .4, 9.6, x + .4, 10.4)], "Top", "A");
  const region = replacement(5), p = project([]), d = pcb(p);
  d.pcbDrawing = {annotations: {}, pours: [region]}; d.sourcePourSignature = R.signature(d, defs(p));
  const firstFilm = films(p), originalPath = globalThis.Path2D, idle = globalThis.AtriumIdle, jobs = [];
  globalThis.AtriumIdle = {idle(fn) { jobs.push(fn); }};
  globalThis.Path2D = class { moveTo(x) { this.first ??= x; } lineTo() {} };
  let path;
  const ctx = {fill(value) { path = value; }};
  const flush = () => { while (jobs.length) jobs.shift()({timeRemaining: () => 6}); };
  try {
    const original = R.contours(region);
    R.paint(ctx, region); const firstPath = path;
    assert.equal(R.lodRingsAt(region, 1), null); flush();
    const firstLOD = R.lodRingsAt(region, 1); assert.ok(firstLOD?.rings.length === 2);
    region.links = [["anchor", 0]];
    assert.equal(R.contours(region), original, "connectivity alone leaves geometric contours valid");
    Object.assign(region, replacement(24));
    const moved = R.contours(region); assert.notEqual(moved, original); assert.equal(moved.length, 2);
    assert.ok(Math.abs(moved[0][0] - 26) < 1e-9);
    R.paint(ctx, region); assert.notEqual(path, firstPath); assert.ok(Math.abs(path.first - 26) < 1e-9);
    assert.equal(R.lodRingsAt(region, 1), null, "old simplified rings are not displayed");
    Object.assign(region, replacement(38)); flush(); // An idle job queued for x=24 is now obsolete.
    assert.equal(R.lodRingsAt(region, 1), null); flush();
    const latest = R.lodRingsAt(region, 1); assert.ok(Math.abs(latest.rings[0][0] - 40) < 1e-9);
    const revisedFilm = films(p); assert.notDeepEqual(revisedFilm, firstFilm);
    assert.deepEqual(revisedFilm, films(reopen(p)), "live and fresh decoders plot the moved outline and hole identically");
    region.count++;
    assert.throws(() => R.contours(region), /pour/i, "a changed contour count cannot reuse the old decoded rings");
  } finally {
    globalThis.Path2D = originalPath; globalThis.AtriumIdle = idle; R.release([region], []);
  }
}

function olderStamps() {
  const p = project([zone("plane", rect(1, 1, 30, 29), "A", "Top", {removeDeadCopper: false}), via("via", 8.765432123456789, 17, "B")]), d = pcb(p);
  P.apply(d, defs(p));
  assert.deepEqual(P.stale(d, defs(p)), [], "freshly poured");
  // Pre-release pour history is not kept: a stamp of another signature version is stale.
  d.pcbDrawing.pourSignatureVersion = 2;
  assert.deepEqual(P.stale(d, defs(p)), ["plane"], "a stamp of another version");
  d.sourcePourSignature = "65d5026e2711a370";
  assert.equal(R.matchesSignature(d, defs(p)), false, "a board stamp that no longer holds");
}

globalThis.__testDone = (async () => {
  await checkEdits(); importedFilms(); olderStamps(); changedRegion();
  console.log("pour-fabrication: staged edits, smart thermals, undo/redo, save/reopen, older stamps, mutable rings and PiDP-11 reference copper passed");
})().catch(e => { console.error(e); process.exitCode = 1; throw e; });
