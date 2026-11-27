"use strict";
// Poured copper that costs what an edit touched (docs/design/pour-copper-proportional.md): what is
// kept between versions of an island must be exactly what a cold start computes. Seeded random edit
// sequences on a netted board with ten pours (the edits of tests/checks/drc-copper-incremental.cjs:
// moves inside pours and beside their outlines, adds, deletes, a paste, net and width changes, pour
// outline and clearance edits, a collaboration peer's edit, Undo and Redo) go through the undo store
// as the editor makes them, and every stale pour is refilled as a live refill does. After each step:
//   (a) the stored regions equal a from-scratch pour of the same board (no earlier copper, nothing
//       reused): the same regions in the same order, every field, the data byte for byte;
//   (b) a region kept from before the step (AtriumPCBPours.regionLike) is content-identical to the
//       freshly encoded island it stands for (part of (a), counted separately);
//   (c) every cache answers what a cold one does: contours, ring boxes, run tables (computed, and as
//       the live worker sends them: tableOut / adoptTable), display LOD at two scales, and
//       copperChange against the original ring-by-ring implementation (kept below as the oracle);
//   (d) --digest file writes a digest of the stored copper and signatures after every step, so the same
//       sequence run with the base branch's app gives a file to compare byte for byte.
// SEEDS=n adds seeds; --quick runs fewer steps.
// Run: node tests/pcb/pour-copper-proportional.cjs [--quick] [--digest out.json]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const P = require("../support/app-source-paths.cjs");
for (const m of ["model", "net-ties", "parts", "nav-common", "spatial", "board-shape", "stackup", "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "net-intent", "signals",
  "rules", "viastack", "polygon-pour", "connectivity", "undo-store"]) require(P.appFile(m + ".js"));
require("../pcb/dense-board.js");
const A = Atrium, U = AtriumUndoStore, PP = AtriumPolygonPour, C = AtriumPCBPours;
const quick = process.argv.includes("--quick"), digestAt = process.argv.indexOf("--digest"), digestFile = digestAt > 0 ? process.argv[digestAt + 1] : null;
const engine = typeof C.table === "function";   // the base branch has no runs: (c) is skipped there
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
function rng(seed) { return () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const pick = (r, list) => list[Math.floor(r() * list.length)];
let uid = 0;
const fresh = p => p + "-x" + (++uid);

function editor(project) {
  U.reset(); U.touch(project); U.sync(project);
  const history = [], future = [];
  return {
    get project() { return project; },
    edit(fn, touched) { const before = U.mark(project); fn(project); U.checkpoint(history, future, before); U.touch(project, touched); },
    derive(fn, touched) { fn(project); U.touch(project, touched); },
    peer(fn, touched) { U.peerPatch(project, () => { fn(project); U.touch(project, touched); }); },
    go(n) { const t = U.jump(history, future, U.mark(project), n); if (!t) return false; project = U.root(); U.touch(project, undefined, true); return true; }
  };
}
function board(n) {
  const {d, defs} = makeAtriumBenchmarkBoard(n);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); else if (k % 3 === 0) i.net = "N" + (k % 64); k++; }
  const w = d.outline[1][0], h = d.outline[2][1], rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
  const polys = [["Top", "GND", rect(1, 1, w / 2, h - 1)], ["Top", "VCC", rect(w / 2, 1, w - 1, h - 1)], ["Bottom", "GND", rect(1, 1, w - 1, h / 2)], ["Bottom", "VCC", rect(1, h / 2, w - 1, h - 1)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(3 + j * w / 6, 3, w / 6 * (j + 1) - 2, h / 4)]);
  polys.forEach(([layer, net, o], j) => d.items.push({...PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: j % 3 === 0}), id: "poly" + j}));
  const p = A.project("Copper"); p.documents = [d]; p.library = [...defs.values()];
  return p;
}
const defsCache = new WeakMap();
const defsOf = p => { let d = defsCache.get(p.library); if (!d) defsCache.set(p.library, d = new Map(p.library.map(x => [x.id, x]))); return d; };
function refill(ed, doc) {
  const defs = defsOf(ed.project), stale = PP.inspectCopper(doc, defs, {project: ed.project}).stale.slice();
  if (!stale.length) return 0;
  ed.derive(() => PP.apply(doc, defs, {project: ed.project, only: stale, derived: true}));
  return stale.length;
}
function ops(docOf) {
  const kinds = (ed, k) => docOf(ed).items.filter(i => i.kind === k);
  const near = (ed, r, kind, inPour) => {
    const doc = docOf(ed), w = doc.outline[1][0], h = doc.outline[2][1], list = doc.items.filter(i => i.kind === kind);
    const at = i => i.points ? i.points[0] : [i.x, i.y];
    const edge = q => [q[0] - 1, w / 2 - q[0], w - 1 - q[0], q[1] - 1, h / 2 - q[1], h - 1 - q[1]].some(d => Math.abs(d) < 1);
    const sel = list.filter(i => inPour ? !edge(at(i)) : edge(at(i)));
    return pick(r, sel.length ? sel : list);
  };
  const touched = (ed, items) => ({doc: docOf(ed), items});
  return [
    ["move part (inside a pour)", (ed, r) => { const p = near(ed, r, "part", true); if (!p) return false; ed.edit(() => { p.x += (r() - .5) * 2; p.y += (r() - .5) * 2; }, touched(ed, [p])); return true; }],
    ["move part (near an outline)", (ed, r) => { const p = near(ed, r, "part", false); if (!p) return false; ed.edit(() => { p.x += (r() - .5) * 2; p.y += (r() - .5) * 2; }, touched(ed, [p])); return true; }],
    ["bend track", (ed, r) => { const t = near(ed, r, "track", r() < .7); if (!t) return false; ed.edit(() => { const k = 1 + Math.floor(r() * (t.points.length - 1)); t.points[k] = [t.points[k][0] + (r() - .5) * 2, t.points[k][1] + (r() - .5) * 2]; }, touched(ed, [t])); return true; }],
    ["track width", (ed, r) => { const t = pick(r, kinds(ed, "track")); if (!t) return false; ed.edit(() => { t.width = pick(r, [.1, .15, .22, .3, .6]); }, touched(ed, [t])); return true; }],
    ["net change", (ed, r) => { const t = pick(r, docOf(ed).items.filter(i => i.kind === "track" || i.kind === "via" || i.kind === "pad")); if (!t) return false; ed.edit(() => { t.net = pick(r, ["GND", "VCC", "N1", "N7", "N40", ""]); }, touched(ed, [t])); return true; }],
    ["add track", (ed, r) => { const o = near(ed, r, "via", r() < .7); if (!o) return false; const t = {id: fresh("t"), kind: "track", net: o.net, layer: pick(r, ["Top", "Bottom"]), width: pick(r, [.15, .22]), points: [[o.x, o.y], [o.x + 1 + r() * 2, o.y + (r() - .5) * 2]]};
      ed.edit(() => { docOf(ed).items.push(t); }, touched(ed, [t])); return true; }],
    ["delete", (ed, r) => { const doc = docOf(ed), o = pick(r, doc.items.filter(i => ["track", "via", "part", "pad"].includes(i.kind))); if (!o) return false; ed.edit(() => { doc.items.splice(doc.items.indexOf(o), 1); }); return true; }],
    ["paste 4", (ed, r) => { const doc = docOf(ed), start = Math.floor(r() * doc.items.length), src = doc.items.slice(start, start + 6).filter(i => ["track", "via", "part"].includes(i.kind)).slice(0, 4); if (!src.length) return false;
      ed.edit(() => { for (const s of src) { const c = JSON.parse(JSON.stringify(s)); c.id = fresh(s.kind); if (c.points) c.points = c.points.map(q => [q[0] + .7, q[1] + 1.3]); else { c.x += .7; c.y += 1.3; } if (c.ref) c.ref += "_" + uid; doc.items.push(c); } }); return true; }],
    ["pour outline", (ed, r) => { const p = pick(r, kinds(ed, "polygon")); if (!p) return false; ed.edit(() => { const k = Math.floor(r() * p.points.length); p.points = p.points.map((q, j) => j === k ? [q[0] + (r() - .5) * 3, q[1] + (r() - .5) * 3] : q); }, touched(ed, [p])); return true; }],
    ["pour clearance", (ed, r) => { const p = pick(r, kinds(ed, "polygon")); if (!p) return false; ed.edit(() => { if (p.clearance) delete p.clearance; else p.clearance = .12; }, touched(ed, [p])); return true; }],
    ["peer edit (touched)", (ed, r) => { const t = near(ed, r, "track", true); if (!t) return false; ed.peer(() => { t.points[0] = [t.points[0][0] + .4, t.points[0][1]]; }, touched(ed, [t])); return true; }],
    ["undo", ed => ed.go(-1)], ["redo", ed => ed.go(1)], ["undo", ed => ed.go(-1)]
  ];
}

// ---- the oracles
const unit = .00000254;
function coldRings(r) {
  const b = Buffer.from(r.data, "base64"), v = new DataView(b.buffer, b.byteOffset, b.byteLength), out = [];
  let at = 0;
  for (let k = 0; k < r.count; k++) {
    const n = v.getUint32(at, true); at += 4;
    const xy = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) { xy[2 * i] = v.getFloat64(at, true) * unit; xy[2 * i + 1] = -v.getFloat64(at + 8, true) * unit; at += 16; }
    out.push(xy);
  }
  assert.equal(at, b.length);
  return out;
}
// copperChange as first written (pcb-pours.js before runs): rings from the stored words, compared word by word.
function changeOracle(before, after) {
  const key = r => (r.polygon ?? "") + "\u0000" + r.layer + "\u0000" + (r.net || ""), groups = new Map();
  const kept = new Set(before || []), group = k => { let g = groups.get(k); if (!g) groups.set(k, g = {old: [], now: []}); return g; };
  const fresh = [];
  for (const r of after || []) if (kept.has(r)) kept.delete(r); else fresh.push(r);
  for (const r of kept) group(key(r)).old.push(r);
  for (const r of fresh) { const g = group(key(r)), i = g.old.findIndex(o => o.count === r.count && o.data === r.data); if (i >= 0) g.old.splice(i, 1); else g.now.push(r); }
  const words = r => { const b = Buffer.from(r.data, "base64"), w = new Uint32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)), out = []; let at = 0;
    for (let k = 0; k < r.count; k++) { const n = w[at]; out.push({w: w.subarray(at + 1, at + 1 + 4 * n), role: k ? 1 : 0, ring: coldRings({data: r.data, count: r.count})[k]}); at += 1 + 4 * n; } return out; };
  const changes = [];
  for (const g of groups.values()) {
    if (!g.old.length && !g.now.length) continue;
    const rings = [];
    for (const [list, side] of [[g.old, 0], [g.now, 1]]) for (const r of list) for (const e of words(r)) {
      const twin = rings.findIndex(x => x.side !== side && x.role === e.role && x.w.length === e.w.length && x.w.every((v, i) => v === e.w[i]));
      if (twin >= 0) rings.splice(twin, 1); else rings.push({...e, side});
    }
    const edges = new Map();
    for (const x of rings) { const n = x.ring.length >> 1; for (let i = 0; i < n; i++) { const j = (i + 1) % n, e = [x.ring[2 * i], x.ring[2 * i + 1], x.ring[2 * j], x.ring[2 * j + 1]], id = x.role + ":" + e.join(","), y = edges.get(id);
      if (y && y.side !== x.side && y.n) { y.n--; if (!y.n) edges.delete(id); } else if (y && y.side === x.side) y.n++; else edges.set(id, {e, side: x.side, n: 1}); } }
    if (!edges.size) continue;
    const s = g.now[0] || g.old[0], out = {polygon: s.polygon ?? null, layer: s.layer, net: s.net || "", boxes: []};
    changes.push(out);
    if (edges.size > 20000) { const b = [Infinity, Infinity, -Infinity, -Infinity]; for (const {e} of edges.values()) { b[0] = Math.min(b[0], e[0], e[2]); b[1] = Math.min(b[1], e[1], e[3]); b[2] = Math.max(b[2], e[0], e[2]); b[3] = Math.max(b[3], e[1], e[3]); } out.boxes.push(b); continue; }
    const parent = new Map(), find = v => { let r = v; while (parent.get(r) !== r) r = parent.get(r); return r; };
    const vertex = (x, y) => { const id = x + "," + y; if (!parent.has(id)) parent.set(id, id); return id; };
    const list = [...edges.values()].map(({e}) => { const a = vertex(e[0], e[1]), b = vertex(e[2], e[3]), ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); return {e, a}; });
    const boxes = new Map();
    for (const {e, a} of list) { const r = find(a), b = boxes.get(r) || [Infinity, Infinity, -Infinity, -Infinity]; b[0] = Math.min(b[0], e[0], e[2]); b[1] = Math.min(b[1], e[1], e[3]); b[2] = Math.max(b[2], e[0], e[2]); b[3] = Math.max(b[3], e[1], e[3]); boxes.set(r, b); }
    out.boxes.push(...boxes.values());
  }
  return {changes, same: !changes.length};
}
const canonBoxes = c => c && JSON.stringify(c.changes.map(x => ({...x, boxes: x.boxes.map(b => b.join(",")).sort()})).sort((a, b) => (a.polygon + a.layer + a.net).localeCompare(b.polygon + b.layer + b.net)));
const sameRings = (a, b) => a.length === b.length && a.every((x, i) => x.length === b[i].length && x.every((v, j) => v === b[i][j]));
const regionJSON = r => JSON.stringify(Object.keys(r).sort().map(k => [k, r[k]]));

const stats = {steps: 0, regions: 0, kept: 0, keptChecked: 0, lod: 0, changes: 0, tables: 0, digests: []};
function checkStep(label, ed, before, step, kind) {
  const doc = ed.project.documents[0], defs = defsOf(ed.project), pours = doc.pcbDrawing?.pours || [];
  stats.steps++;
  if (digestFile) stats.digests.push([label, step, kind, crypto.createHash("sha256").update(JSON.stringify({pours, sigs: doc.pcbDrawing?.pourSignatures ?? null, v: doc.pcbDrawing?.pourSignatureVersion ?? null, stamp: doc.sourcePourSignature ?? null})).digest("hex")]);
  // (a) and (b): a from-scratch pour of the same board.
  const current = PP.inspectCopper(doc, defs, {project: ed.project});
  if (current.state === "current") {
    const view = {...doc, pcbDrawing: {...doc.pcbDrawing, pours: []}};
    const cold = PP.repourAll(view, defs, {project: ed.project}).regions;
    assert.equal(cold.length, pours.length, label + " step " + step + " (" + kind + "): region count");
    const was = new Set(before);
    pours.forEach((r, i) => {
      assert.equal(regionJSON(r), regionJSON(cold[i]), label + " step " + step + " (" + kind + "): region " + i + " differs from a from-scratch pour");
      if (was.has(r)) stats.keptChecked++;
    });
    stats.regions += pours.length; stats.kept += pours.filter(r => was.has(r)).length;
  }
  if (!engine) return;
  // (c) caches against cold answers.
  for (const r of pours) {
    const cold = coldRings(r);
    assert.ok(sameRings(C.contours(r), cold), "contours");
    const boxes = C.ringBoxes(r);
    cold.forEach((xy, k) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < xy.length; i += 2) { x0 = Math.min(x0, xy[i]); x1 = Math.max(x1, xy[i]); y0 = Math.min(y0, xy[i + 1]); y1 = Math.max(y1, xy[i + 1]); }
      assert.deepEqual([boxes[4 * k], boxes[4 * k + 1], boxes[4 * k + 2], boxes[4 * k + 3]], [x0, y0, x1, y1], "ring box"); });
    const clone = {...r}, t = C.table(r), t2 = C.table(clone);
    assert.deepEqual([...t.h1], [...t2.h1]); assert.deepEqual([...t.h2], [...t2.h2]); assert.deepEqual([...t.at], [...t2.at]);
    assert.deepEqual(t.runs.map(x => x.key), t2.runs.map(x => x.key), "run keys");
    const sent = {...r};
    assert.ok(C.adoptTable(sent, structuredClone(C.tableOut(r))), "adopt the worker's table");
    assert.ok(sameRings(C.contours(sent), cold), "contours from an adopted table");
    for (const k of [3, 12]) {
      const lod = C.lodRingsAt(r, k);
      if (!lod) continue;
      const tol = .002 * 2 ** lod.level;
      assert.ok(sameRings(lod.rings, cold.map(xy => C.simplify(xy, tol))), "LOD level " + lod.level);
      stats.lod++;
    }
    stats.tables++;
  }
  const c = C.copperChange(before, pours), o = changeOracle(before, pours);
  assert.equal(canonBoxes(c), canonBoxes(o), label + " step " + step + " (" + kind + "): copperChange differs from the ring-by-ring oracle");
  assert.equal(C.copperChange(before, pours), c, "copperChange is kept for the same lists");
  const copies = before.map(r => ({...r})), now = pours.map(r => ({...r}));
  assert.equal(canonBoxes(C.copperChange(copies, now)), canonBoxes(o), "copperChange of cold copies");
  if (!c.same) stats.changes++;
}
function run(label, project, {seed, steps}) {
  const ed = editor(project), docOf = e => e.project.documents[0], list = ops(docOf), r = rng(seed);
  refill(ed, docOf(ed));
  checkStep(label + " seed " + seed, ed, [], 0, "open");
  for (let s = 1; s <= steps; s++) {
    const before = (docOf(ed).pcbDrawing?.pours || []).slice();
    let kind, guard = 0;
    do kind = pick(r, list); while (!kind[1](ed, r) && ++guard < 20);
    refill(ed, docOf(ed));
    checkStep(label + " seed " + seed, ed, before, s, kind[0]);
  }
}
const steps = quick ? 8 : 24;
const more = (from, n = +(process.env.SEEDS || 0)) => Array.from({length: n}, (_, i) => from + i);
test("kept copper and every cache equal a cold start after random edits and refills", () => {
  for (const seed of [1, 2, 3, 4, ...more(100)]) run("board 40", board(40), {seed, steps});
  assert.ok(stats.kept > 0, "some islands were kept by a refill");
  if (engine) assert.ok(stats.changes > 0 && stats.lod > 0, "changed copper and LOD were compared");
});
console.log("  " + JSON.stringify({...stats, digests: stats.digests.length}));
if (digestFile) fs.writeFileSync(digestFile, JSON.stringify(stats.digests, null, 0));
console.log(passed + " pour copper tests passed" + (engine ? "" : " (no runs on this build: (c) skipped)"));
