"use strict";
// The exact local pour solve (polygon-pour.js areaPatch and areaKeep, the area sessions of the live
// pour worker) against a fresh full repour, byte for byte, after seeded random edit sequences made
// through the undo store as the editor makes them: moves inside pours and beside their outlines,
// rotations, bends, widths, net changes, adds, deletes, a paste of four, pour outline, clearance,
// connect style and neck width edits, Undo and Redo. The boards hold Remove Necks and Outlines Only
// pours, pours with dead copper removal, a variable (auto) connect style, and two dependent pours on
// each layer (small pours inside the large ones, poured after them). Sometimes several edits land
// before a refill, as when the worker is busy. After each refill the stored regions (rings, holes,
// true arcs, links, bounds) and the polygon signatures equal a full repour of the same board.
// Refills are repourAll with the sessions (every pour), or, in the worker test, the live worker's own
// jobs (liveWorkerSteps on a mirror with replaced rows: its choice of stale pours, committed as the
// editor commits, then the follow-up jobs for the dependent pours it names in `next`); after those no
// pour may be stale and the stored copper must equal a full repour.
// Reports how each kind of edit reached the solver. SEEDS=n adds seeds; --quick runs fewer steps;
// --large adds the 25,600-object benchmark board of scripts/perf-sch.sh --board pours; ONLY_SEED and
// STEPS rerun one worker seed.
// Run: node tests/pcb/pour-area-random.cjs [--quick] [--large]
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const P = require("../support/app-source-paths.cjs");
for (const m of ["model", "net-ties", "parts", "nav-common", "spatial", "board-shape", "stackup", "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "net-intent", "signals",
  "rules", "viastack", "polygon-pour", "undo-store"]) require(P.appFile(m + ".js"));
require("../pcb/dense-board.js");
const A = Atrium, U = AtriumUndoStore, PP = AtriumPolygonPour, I = PP._internal;
const quick = process.argv.includes("--quick"), large = process.argv.includes("--large");
function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];
let uid = 0;
const fresh = p => p + "-r" + (++uid);

// A small editor over the undo store (tests/checks/drc-copper-incremental.cjs).
function editor(project) {
  U.reset(); U.touch(project); U.sync(project);
  const history = [], future = [];
  return {
    get project() { return project; },
    edit(fn) { const before = U.mark(project); fn(project); U.checkpoint(history, future, before); U.touch(project); },
    derive(fn) { fn(project); U.touch(project); },
    go(n) { const t = U.jump(history, future, U.mark(project), n); if (!t) return false; project = U.root(); U.touch(project, undefined, true); return true; }
  };
}
const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
// dense-board.js with 64 nets and ten pours: four large ones (dead copper removal, a variable connect
// style, Remove Necks, Outlines Only) and six small ones inside them, poured later (dependent).
function bench(n) {
  const {d, defs} = makeAtriumBenchmarkBoard(n);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); else if (k % 3 === 0) i.net = "N" + (k % 64); k++; }
  const w = d.outline[1][0], h = d.outline[2][1];
  const big = [["Top", "GND", rect(1, 1, w / 2, h - 1), {removeDeadCopper: true}], ["Top", "VCC", rect(w / 2, 1, w - 1, h - 1), {connectStyle: "auto", clearance: .1}],
    ["Bottom", "GND", rect(1, 1, w - 1, h / 2), {neckWidth: .3}], ["Bottom", "VCC", rect(1, h / 2, w - 1, h - 1), {fillMode: "outline", hatchWidth: .4}]];
  const small = [];
  for (let j = 0; j < 6; j++) small.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(3 + j * w / 7, 3 + (j % 3) * h / 4, w / 7 * (j + 1) - 1, (j % 3) * h / 4 + h / 5), {removeDeadCopper: j === 1}]);
  [...big, ...small].forEach(([layer, net, o, extra], j) => d.items.push({...PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: false, ...extra}), id: "poly" + j}));
  const p = A.project("Copper"); p.documents = [d]; p.library = [...defs.values()];
  return p;
}
// The board of tests/pcb/pour-area.cjs: two overlapping pours over a grid of vias, a relief via.
function viaGrid() {
  const project = A.project("Local polygon refill"), doc = project.documents.find(d => d.kind === "pcb");
  const via = (id, x, y, net = "SIG") => ({kind: "via", id, layer: "Multi", x, y, net, diameter: 1.1, drill: .45});
  const pour = (id, points, settings) => Object.assign(PP.make(points, {layer: "Top", removeDeadCopper: false, arcApproximation: .008, ...settings}), {id});
  doc.outline = rect(0, 0, 90, 64);
  doc.items = [pour("upper", rect(1, 1, 89, 63), {net: "GND", clearance: 1.18, pourIndex: 0, viaConnectStyle: "relief", removeDeadCopper: true}),
    pour("lower", rect(7, 5, 83, 59), {net: "VCC", clearance: .16, pourIndex: 1}), pour("inner", rect(20, 15, 40, 30), {net: "SIG2", clearance: .3, pourIndex: 2, neckWidth: .5}),
    via("relief", 29.85, 32.8, "GND"), via("right-anchor", 61.3, 26.3, "GND")];
  for (let y = 5; y <= 59; y += 5) for (let x = 5; x <= 85; x += 5) doc.items.push(via("via-" + x + "-" + y, x + (y % 3) * .11, y + (x % 3) * .13, (x + y) % 20 ? "SIG" : "GND"));
  for (let k = 0; k < 12; k++) doc.items.push({id: "t" + k, kind: "track", layer: "Top", net: k % 4 ? "SIG" : "GND", width: .25, points: [[6 + k * 6.5, 8], [9 + k * 6.5, 30], [6 + k * 6.5, 55]]});
  return project;
}
// The perf-sch.sh --board pours board (tests/editor/perf-interact.js polygons).
function perfBoard() {
  const {d, defs} = makeAtriumBenchmarkBoard();
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++; }
  const polys = [["Top", "GND", rect(1, 1, 180, 270)], ["Top", "VCC", rect(180, 1, 367, 270)], ["Bottom", "GND", rect(1, 1, 367, 140)], ["Bottom", "VCC", rect(1, 140, 367, 270)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(10 + j * 55, 10, 50 + j * 55, 40)]);
  polys.forEach(([layer, net, o], j) => d.items.push({...PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: false}), id: "poly" + j}));
  const p = A.project("Pours"); p.documents = [d]; p.library = [...defs.values()];
  return p;
}
const defsCache = new WeakMap();
const defsOf = p => { let d = defsCache.get(p.library); if (!d) defsCache.set(p.library, d = new Map(p.library.map(x => [x.id, x]))); return d; };

function ops(docOf) {
  const kinds = (ed, k) => docOf(ed).items.filter(i => i.kind === k);
  const polys = ed => kinds(ed, "polygon");
  // inside a pour, away from its outline, or within 1 mm of one
  const near = (ed, r, kind, inside) => {
    const list = kinds(ed, kind), outlines = polys(ed).map(p => p.points);
    const at = i => i.points ? i.points[0] : [i.x, i.y];
    const edge = q => outlines.some(o => o.some((a, j) => { const b = o[(j + 1) % o.length]; return (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(q[0] - a[0]) < 1 && q[1] >= Math.min(a[1], b[1]) - 1 && q[1] <= Math.max(a[1], b[1]) + 1) ||
      (Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(q[1] - a[1]) < 1 && q[0] >= Math.min(a[0], b[0]) - 1 && q[0] <= Math.max(a[0], b[0]) + 1); }));
    const sel = list.filter(i => inside ? !edge(at(i)) : edge(at(i)));
    return pick(r, sel.length ? sel : list);
  };
  const nudge = (r, s = 2) => (r() - .5) * s;
  return [
    ["move part (inside a pour)", (ed, r) => { const p = near(ed, r, "part", true); if (!p) return false; ed.edit(() => { p.x += nudge(r); p.y += nudge(r); }); return true; }],
    ["move part (near an outline)", (ed, r) => { const p = near(ed, r, "part", false); if (!p) return false; ed.edit(() => { p.x += nudge(r); p.y += nudge(r); }); return true; }],
    ["rotate part", (ed, r) => { const p = pick(r, kinds(ed, "part")); if (!p) return false; ed.edit(() => { p.angle = ((p.angle || 0) + 90) % 360; }); return true; }],
    ["move via", (ed, r) => { const v = near(ed, r, "via", r() < .7); if (!v) return false; ed.edit(() => { v.x += nudge(r); v.y += nudge(r); }); return true; }],
    ["bend track", (ed, r) => { const t = near(ed, r, "track", r() < .7); if (!t) return false; ed.edit(() => { const k = 1 + Math.floor(r() * (t.points.length - 1)); t.points[k] = [t.points[k][0] + nudge(r), t.points[k][1] + nudge(r)]; }); return true; }],
    ["track width", (ed, r) => { const t = pick(r, kinds(ed, "track")); if (!t) return false; ed.edit(() => { t.width = pick(r, [.1, .15, .22, .3, .6]); }); return true; }],
    ["net change", (ed, r) => { const t = pick(r, docOf(ed).items.filter(i => i.kind === "track" || i.kind === "via")); if (!t) return false; ed.edit(() => { t.net = pick(r, ["GND", "VCC", "N1", "N2", "SIG", ""]); }); return true; }],
    ["add track", (ed, r) => { const o = near(ed, r, "via", r() < .7); if (!o) return false; const t = {id: fresh("t"), kind: "track", net: pick(r, [o.net, "GND", "N3"]), layer: pick(r, ["Top", "Bottom"]), width: pick(r, [.15, .22]), points: [[o.x, o.y], [o.x + 1 + r() * 2, o.y + nudge(r)]]};
      ed.edit(() => { docOf(ed).items.push(t); }); return true; }],
    ["add via", (ed, r) => { const o = near(ed, r, "track", true); if (!o) return false; const q = o.points.at(-1), v = {id: fresh("v"), kind: "via", net: pick(r, [o.net || "N3", "GND", "VCC"]), x: q[0] + nudge(r, 1), y: q[1] + nudge(r, 1), diameter: .6, drill: .3, layer: "Multi"};
      ed.edit(() => { docOf(ed).items.push(v); }); return true; }],
    ["delete", (ed, r) => { const doc = docOf(ed), o = pick(r, doc.items.filter(i => ["track", "via", "part"].includes(i.kind))); if (!o) return false; ed.edit(() => { doc.items.splice(doc.items.indexOf(o), 1); }); return true; }],
    ["paste 4", (ed, r) => { const doc = docOf(ed), start = Math.floor(r() * doc.items.length), src = doc.items.slice(start, start + 8).filter(i => ["track", "via", "part"].includes(i.kind)).slice(0, 4); if (!src.length) return false;
      ed.edit(() => { for (const s of src) { const c = JSON.parse(JSON.stringify(s)); c.id = fresh(s.kind); if (c.points) c.points = c.points.map(q => [q[0] + .7, q[1] + 1.3]); else { c.x += .7; c.y += 1.3; } if (c.ref) c.ref += "_" + uid; doc.items.push(c); } }); return true; }],
    ["pour outline", (ed, r) => { const p = pick(r, polys(ed)); if (!p) return false; ed.edit(() => { const k = Math.floor(r() * p.points.length); p.points = p.points.map((q, j) => j === k ? [q[0] + nudge(r, 3), q[1] + nudge(r, 3)] : q); }); return true; }],
    ["pour clearance", (ed, r) => { const p = pick(r, polys(ed)); if (!p) return false; ed.edit(() => { if (p.clearance) delete p.clearance; else p.clearance = .12; }); return true; }],
    ["connect style", (ed, r) => { const p = pick(r, polys(ed)); if (!p) return false; ed.edit(() => { if (r() < .5) p.connectStyle = pick(r, ["relief", "direct", "none", "auto"]); else { p.viaConnectStyle = pick(r, ["relief", "direct"]); p.reliefConductorWidth = pick(r, [.2, .254, .3]); } }); return true; }],
    ["neck width", (ed, r) => { const p = pick(r, polys(ed)); if (!p) return false; ed.edit(() => { if (p.neckWidth) delete p.neckWidth; else p.neckWidth = pick(r, [.2, .4]); }); return true; }],
    ["undo", ed => ed.go(-1)], ["redo", ed => ed.go(1)], ["undo", ed => ed.go(-1)]
  ];
}

const how = new Map();
const note = (kind, mode) => { let h = how.get(kind); if (!h) how.set(kind, h = {}); h[mode] = (h[mode] || 0) + 1; };
// A wide region names the widest input it took: its class (0 polygon, 1 board, 2 obstacle, 3-5
// relief, 6.. earlier pour; * a changed one) and the share of the pour's box its box covers.
const modeOf = s => s ? (s.mode === "full" ? "full:" + s.reason + (s.reason === "wide-neighbourhood" && s.widest && process.env.WIDEST ? " cls" + s.widest.cls + (s.widest.changed ? "*" : "") + " " + (s.widest.a / s.frameArea >= .2 ? "big" : "small") : "") : s.mode + (s.arcsMoved ? " (arcs moved)" : "")) : null;
const regionKey = r => JSON.stringify(r);
// The live pour worker's job (live-pour-worker.js refill: liveWorkerSteps, its own choice of stale
// pours) committed as the editor commits it (polygon-pour.js run()), then the jobs the editor runs
// for the pours the worker names in `next` (dependent pours whose earlier copper changed), until none.
// The worker solves its own mirror of the board (`mirror`), whose rows are replaced for every item the
// journal names, as live-pour-worker.js patch() replaces them; the editor's items are edited in place
// here and Undo restores them in place, so the worker must not see the editor's objects.
function workerRefill(ed, doc, mirror, area, mirrorSignatures) {
  const defs = defsOf(ed.project), polygons = {}, project = {...ed.project, documents: ed.project.documents.map(d => d === doc ? mirror : d)};let jobs = 0, v;
  for (let useArea = area; ; useArea = {sessions: area.sessions, dirtyBoxes: [], changedItems: new Set()}) {
    mirror.pcbDrawing = doc.pcbDrawing; if (doc.sourcePourSignature) mirror.sourcePourSignature = doc.sourcePourSignature; else delete mirror.sourcePourSignature;
    const g = I.liveWorkerSteps(mirror, defs, {project, known: new Set(), failed: {}, area: useArea, mirrorSignatures});
    let x = g.next();
    while (!x.done) x = x.value?.task ? g.next(I.core.solve(x.value.task)) : g.next();
    v = x.value; jobs++;
    assert.ok(!v.unsupported, "the worker path supports the board");
    if (v.drawing) ed.derive(() => {
      const drawing = doc.pcbDrawing ||= {annotations: {}};
      for (const key of ["importedPourSignature", "sourceHatchSignature", "pourSignatures", "pourSignatureVersion"]) if (Object.hasOwn(v.drawing, key)) drawing[key] = v.drawing[key]; else delete drawing[key];
      AtriumPourMarker.write(drawing, v.unverified);
      if (v.drawing.pours) drawing.pours = v.drawing.pours; else delete drawing.pours;
      if (v.stamp) doc.sourcePourSignature = v.stamp; else delete doc.sourcePourSignature;
    });
    Object.assign(polygons, v.stats?.polygons || {});
    if (!v.next?.length) break;
    assert.ok(jobs < 12, "the dependency chain ends");
  }
  return {jobs, polygons, failed: v.failed || []};
}
function run(label, project, {seed, steps, worker = false}) {
  const ed = editor(project), docOf = e => e.project.documents.find(d => d.kind === "pcb"), list = ops(docOf), r = rng(seed);
  // The worker's area state (live-pour-worker.js): sessions, the changed items and their old and new boxes.
  const area = {sessions: new Map(), dirtyBoxes: null, changedItems: null}, rows = new Map(), mirrorSignatures = new WeakMap();
  let chained = 0;
  // The worker's mirror: a fresh row for every item the journal names (all of them without a journal).
  const mirrorOf = (doc, ids) => ({...doc, items: doc.items.map(i => {
    let m = rows.get(i.id);
    if (!m || !ids || ids.has(i.id)) { m = JSON.parse(JSON.stringify(i)); rows.set(i.id, m); }
    return m;
  })});
  let at = U.changed(docOf(ed)).seq, boxes = new Map(), pendingKinds = [];
  const snapshot = () => { const defs = defsOf(ed.project); boxes = new Map(docOf(ed).items.map(i => [i.id, I.itemBox(i, defs)])); };
  const refill = step => {
    const doc = docOf(ed), defs = defsOf(ed.project), ch = U.changed(doc, at);
    if (!area.sessions.size || !ch.ids) { area.dirtyBoxes = null; area.changedItems = null; }
    else {
      const byId = new Map(doc.items.map(i => [i.id, i]));
      area.changedItems = new Set(ch.ids); area.dirtyBoxes = [];
      for (const id of ch.ids) for (const b of [boxes.get(id), byId.has(id) ? I.itemBox(byId.get(id), defs) : null]) if (b) { if (b.every(Number.isFinite)) area.dirtyBoxes.push(b); else area.dirtyBoxes = null; if (!area.dirtyBoxes) break; }
    }
    at = ch.seq;
    // repourAll with the sessions (every pour), or the worker's own choice of pours and follow-up jobs.
    let inc, regions, signatures;
    if (worker) {
      const w = workerRefill(ed, doc, mirrorOf(doc, area.changedItems), area, mirrorSignatures);
      inc = {failed: w.failed, stats: {polygons: w.polygons}};
      regions = doc.pcbDrawing?.pours || []; signatures = doc.pcbDrawing?.pourSignatures;
      chained += w.jobs - 1;
      // The worker left no pour stale.
      assert.deepEqual(PP.inspectCopper(doc, defs, {project: ed.project}).stale, [], label + " seed " + seed + " step " + step + ": stale after the worker's jobs");
      at = U.changed(doc, at).seq;
    } else {
      inc = PP.repourAll(doc, defs, {project: ed.project, reuse: false, area});
      regions = inc.regions; signatures = inc.signatures;
    }
    const full = PP.repourAll(doc, defs, {project: ed.project, reuse: false});
    assert.equal(inc.failed.length, 0, label + " seed " + seed + " step " + step + ": failed " + JSON.stringify(inc.failed));
    const a = regions.map(regionKey), b = full.regions.map(regionKey);
    if (a.length !== b.length || a.some((x, k) => x !== b[k])) {
      const k = a.findIndex((x, j) => x !== b[j]), id = (regions[k] || full.regions[k])?.polygon, st = inc.stats.polygons[id]?.area;
      assert.fail(label + " seed " + seed + " step " + step + " (" + pendingKinds.join(", ") + "): pour " + id + " differs from a full repour (region " + k + " of " + a.length + "/" + b.length +
        "; stage 1 " + modeOf(st?.stage1) + ", stage 2 " + modeOf(st?.stage2) + ")");
    }
    assert.deepEqual(signatures, full.signatures, label + " seed " + seed + " step " + step + " signatures");
    for (const [id, s] of Object.entries(inc.stats.polygons)) if (s?.area) for (const stage of ["stage1", "stage2"]) {
      const m = modeOf(s.area[stage]); if (!m || m === "unchanged") continue;
      for (const kind of pendingKinds) note(kind + " " + stage, m);
    }
    pendingKinds = [];
    area.dirtyBoxes = []; area.changedItems = new Set();
    snapshot();
  };
  snapshot(); refill(0);
  for (let s = 1; s <= steps; s++) {
    let kind, guard = 0;
    do kind = pick(r, list); while (!kind[1](ed, r) && ++guard < 20);
    pendingKinds.push(kind[0]);
    // Sometimes the worker is still busy: the next edits land before its refill.
    if (s === steps || r() < .8) refill(s);
  }
  console.log("  " + label + " seed " + seed + ": " + steps + " steps byte-identical" + (worker ? " through the worker's jobs (" + chained + " follow-up jobs for dependent pours)" : ""));
}

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const more = (from, n = +(process.env.SEEDS || 0)) => Array.from({length: n}, (_, i) => from + i);
test("netted board with ten pours (1,600 objects): every refill equals a full repour", () => {
  for (const seed of [1, 2, 3, 4, ...(quick ? [] : [5, 6, 7, 8]), ...more(100)]) run("board 40", bench(40), {seed, steps: quick ? 10 : 25});
});
test("board of tests/pcb/pour-area.cjs (vias, relief, Remove Necks): every refill equals a full repour", () => {
  for (const seed of [11, 12, 13, ...(quick ? [] : [14, 15, 16]), ...more(300)]) run("via grid", viaGrid(), {seed, steps: quick ? 12 : 30});
});
test("the worker's own jobs (its choice of stale pours, then the dependent pours it names): stored copper equals a full repour", () => {
  for (const seed of process.env.ONLY_SEED ? [+process.env.ONLY_SEED] : [41, 42, ...(quick ? [] : [43, 44]), ...more(500)]) run("board 40, worker", bench(40), {seed, steps: +process.env.STEPS || (quick ? 10 : 20), worker: true});
  for (const seed of [51, ...(quick ? [] : [52]), ...more(600)]) run("via grid, worker", viaGrid(), {seed, steps: quick ? 10 : 20, worker: true});
});
test("larger board (6,400 objects)", () => {
  for (const seed of [21, ...(quick ? [] : [22]), ...more(200)]) run("board 80", bench(80), {seed, steps: quick ? 5 : 10});
});
if (large) test("benchmark board with pours (25,600 objects)", () => {
  for (const seed of [31, 32, ...more(400)]) run("perf board", perfBoard(), {seed, steps: 8});
});
console.log("how each kind of edit reached the solver (stage: modes):");
for (const [kind, h] of [...how].sort()) console.log("  " + kind.padEnd(40) + JSON.stringify(h));
console.log(passed + " pour-area-random tests passed");
