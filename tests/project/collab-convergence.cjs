"use strict";
// Randomised convergence of the live-session CRDT (app/project/collab-crdt.js) along the paths the
// session uses, which tests/project/collab-crdt.cjs (three replicas, full diff(next) commits on
// replica projections) leaves out:
//   * each replica edits an editor project in place, which incoming edits patch (preparePatch), as
//     collab-presence.js does;
//   * in-place item edits commit with scoped `updates` ({doc, before, after}, the shape
//     AtriumUndoStore.itemEdits returns), structural edits with the full diff, mixed at random; the
//     first replica publishes everything from the real Undo journal (itemEdits {updates, structure}),
//     so scoped structural commits, the incremental view and its verification are exercised;
//   * block pastes and deletes, personal undo and redo, random delivery order and duplicates;
//   * replicas drop off (their messages are lost) and catch up on return from a peer with since(vv),
//     or snapshot + merge when the log was trimmed (trim() runs at random, as the heartbeat does).
// Afterwards every replica holds the same project, each editor project equals its replica's, and
// Atrium.validate accepts it. Seeded and reproducible:
//   node tests/project/collab-convergence.cjs                       # the fixed seeds below
//   node tests/project/collab-convergence.cjs --seeds 1-200 --steps 400 --replicas 4
//   node tests/project/collab-convergence.cjs --seeds 17 --verbose  # one seed, with a trace
// The catch-up here is the CRDT's own (any replica may send a snapshot). The session restricts who
// may send others' edits and snapshots (collab-presence.js); scripts/perf-collab.cjs measures that.
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/formats/format-2-codec.js");
require("../../app/history/undo-store.js");
require("../../app/project/collab-crdt.js");
const A = globalThis.Atrium, C = globalThis.AtriumCollabCRDT, U = globalThis.AtriumUndoStore;

const argv = process.argv.slice(2), arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : d; };
const seedSpec = arg("seeds", process.env.CONVERGENCE_SEEDS || "3,11,29,58,404,1009");
const seeds = seedSpec.split(",").flatMap(s => { const [a, b] = s.split("-").map(Number); return b ? Array.from({length: b - a + 1}, (_, i) => a + i) : [a]; });
const STEPS = +arg("steps", 420), REPLICAS = Math.min(8, Math.max(2, +arg("replicas", 4))), verbose = argv.includes("--verbose");

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
let rand = Math.random;
const pick = list => list[Math.floor(rand() * list.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const shuffle = list => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clone = v => JSON.parse(JSON.stringify(v));
let uid = 0; const nid = p => p + "-" + (++uid);

// The fixture of tests/project/collab-crdt.cjs, with more objects to edit.
function fixture() {
  const def = {id: "def-r", name: "Resistor", prefix: "R",
    symbol: {shapes: [{kind: "path", points: [[-2, 0], [2, 0]]}], pins: [{x: -3, y: 0, number: "1"}, {x: 3, y: 0, number: "2"}]},
    footprint: {shapes: [], pads: [{x: -1, y: 0, w: .8, h: .9, number: "1"}, {x: 1, y: 0, w: .8, h: .9, number: "2"}]}};
  const p = A.project("Convergence", [def]);
  const [sch, pcb] = p.documents;
  sch.id = "doc-sch"; pcb.id = "doc-pcb";
  for (let i = 0; i < 10; i++) {
    sch.items.push({id: "w" + i, kind: "wire", points: [[i * 5, 0], [i * 5 + 4, 0], [i * 5 + 4, 3]]});
    pcb.items.push({id: "t" + i, kind: "track", points: [[i, 0], [i + 3, 0], [i + 3, 2]], width: .25, layer: "Top", net: "N" + i});
    pcb.items.push({id: "v" + i, kind: "via", x: i, y: 5, diameter: .6});
  }
  for (let i = 0; i < 3; i++) {
    sch.items.push({id: "p" + i, kind: "part", def: "def-r", ref: "R" + (i + 1), value: "10k", x: 10 + 8 * i, y: 10, angle: 0});
    pcb.items.push({id: "pb" + i, kind: "part", def: "def-r", ref: "R" + (i + 1), value: "10k", x: 5 + 4 * i, y: 8, angle: 0});
  }
  pcb.items.push({id: "poly", kind: "polygon", points: [[0, 0], [10, 0], [10, 10], [0, 10]], layer: "Top", net: "GND"});
  A.validate(p);
  return p;
}

// ---- edits on an editor project ------------------------------------------------------------------
// In place on one item: returns {doc, item} so the caller can build scoped updates (before/after).
function itemEdit(p) {
  const docs = p.documents.filter(d => (d.kind === "pcb" || d.kind === "schematic") && d.items.length);
  if (!docs.length) return null;
  const d = pick(docs), it = pick(d.items), r = rand();
  if (Array.isArray(it.points)) {
    const min = it.kind === "polygon" ? 3 : 2;
    if (r < .3) { const k = int(0, it.points.length - 1); it.points[k] = [it.points[k][0] + .5, it.points[k][1] - .5]; return {d, it, kind: "move-vertex"}; }
    if (r < .5) { it.points.splice(int(1, it.points.length - 1), 0, [int(0, 50), int(0, 50)]); return {d, it, kind: "insert-vertex"}; }
    if (r < .65 && it.points.length > min) { it.points.splice(int(0, it.points.length - 1), 1); return {d, it, kind: "delete-vertex"}; }
    if (r < .8) { it.points = it.points.map(([x, y]) => [x + 1, y]); return {d, it, kind: "move-path"}; }
    if (it.kind === "track") { if (it.net && rand() < .5) delete it.net; else it.net = pick(["GND", "VCC", "N1"]); return {d, it, kind: "field"}; }
    return null;
  }
  if (it.kind === "part" && r < .4) { it.value = pick(["1k", "4k7", "10k", "100k"]); return {d, it, kind: "property"}; }
  if (it.kind === "via" && r < .3) { it.diameter = pick([.5, .6, .7]); return {d, it, kind: "property"}; }
  it.x += int(-2, 2); it.y += 1; return {d, it, kind: "move"};
}
function structuralEdit(p) {
  const docs = p.documents.filter(d => d.kind === "pcb" || d.kind === "schematic");
  const d = pick(docs), items = d.items, r = rand();
  if (r < .25) {
    const kind = d.kind === "pcb" ? "track" : "wire", pts = [];
    for (let k = 0, n = int(2, 4); k < n; k++) pts.push([int(0, 40), int(0, 40) + k]);
    items.splice(int(0, items.length), 0, {id: nid("n"), kind, points: pts, ...(kind === "track" ? {width: .2, layer: "Top"} : {})});
    return "add";
  }
  if (r < .4 && items.length > 2) { items.splice(int(0, items.length - 1), 1); return "delete"; }
  if (r < .52) {   // a pasted block
    const n = rand() < .4 ? int(200, 500) : int(5, 60), at = int(0, items.length);   // large ones push the log past LIMITS.log
    const block = Array.from({length: n}, (_, k) => d.kind === "pcb" ? {id: nid("pv"), kind: "via", x: k, y: int(0, 30), diameter: .5}
      : {id: nid("pw"), kind: "wire", points: [[k, 0], [k, 2]]});
    items.splice(at, 0, ...block);
    return "paste";
  }
  if (r < .62 && items.length > 12) { const n = int(3, Math.min(rand() < .3 ? 400 : 40, items.length - 4)); items.splice(int(0, items.length - n), n); return "delete-block"; }
  if (r < .72 && items.length > 1) { const [it] = items.splice(int(0, items.length - 1), 1); items.splice(rand() < .5 ? 0 : items.length, 0, it); return "reorder"; }
  if (r < .8) { d.name = pick(["Board", "Main", "Rev B", "Power"]) + " " + int(1, 9); return "rename"; }
  if (r < .86) { p.name = "Project " + int(1, 99); return "meta"; }
  if (r < .92) { p.documents.splice(int(0, p.documents.length), 0, {id: nid("doc"), kind: "schematic", name: "Sheet " + int(1, 9), grid: 1.27, items: [{id: nid("w"), kind: "wire", points: [[0, 0], [1, 1]]}], outline: [], notes: []}); return "add-doc"; }
  const extra = p.documents.filter(x => x.id !== "doc-sch" && x.id !== "doc-pcb");
  if (extra.length) { p.documents.splice(p.documents.indexOf(pick(extra)), 1); return "delete-doc"; }
  return "none";
}

// The first place two projects differ (lists of objects with ids are compared by id): for messages.
function firstDifference(a, b, at = "") {
  if (C.canon(a) === C.canon(b)) return null;
  if (Array.isArray(a) && Array.isArray(b) && [...a, ...b].every(o => o && typeof o === "object" && "id" in o)) {
    const ids = x => x.map(o => o.id).join(",");
    if (ids(a) !== ids(b)) {
      const only = (x, y) => x.filter(o => !y.some(p => p.id === o.id)).map(o => o.id);
      return at + ": ids differ (editor only " + JSON.stringify(only(a, b)) + ", replica only " + JSON.stringify(only(b, a)) + (only(a, b).length || only(b, a).length ? "" : ", order") + ")";
    }
    for (let i = 0; i < a.length; i++) { const d = firstDifference(a[i], b[i], at + "[" + a[i].id + "]"); if (d) return d; }
  }
  if (a && b && typeof a === "object" && typeof b === "object" && !Array.isArray(a)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDifference(a[k], b[k], at + "." + k); if (d) return d; }
  }
  return at + ": editor " + JSON.stringify(a)?.slice(0, 120) + " / replica " + JSON.stringify(b)?.slice(0, 120);
}
function run(seed) {
  rand = rng(seed); uid = 0;
  const base = fixture(), names = Array.from({length: REPLICAS}, (_, i) => "r" + i);
  const R = names.map(name => ({name, r: C.create({replica: name, project: base}), work: clone(base), online: true, inbox: [], away: 0}));
  const counts = {}, trace = [], all = [];
  const note = (k) => { counts[k] = (counts[k] || 0) + 1; };
  // The first replica publishes as the session does: from the Undo journal (AtriumUndoStore.itemEdits),
  // in-place and structural edits scoped ({updates, structure}), the rest with the full diff, and
  // every patch it receives recorded in the journal before the next range (rememberCursor).
  const J = R[0];
  U.reset(); U.mark(J.work); J.cursor = U.itemEdits(J.work).cursor;
  const remember = x => { if (x === J) { U.record(J.work); J.cursor = U.itemEdits(J.work, null, true).cursor; } };
  const journalCommit = x => {
    U.record(x.work);
    const range = U.itemEdits(x.work, x.cursor, true);
    const b = x.r.commit(x.work, {updates: range.updates, structure: range.structure});
    note(range.structure?.length ? "journal-structural" : range.updates ? "journal-in-place" : "journal-full");
    if (b?.related?.length) x.r.patch(x.work, b.related);
    remember(x);
    return b;
  };
  const patch = (x, touched) => { if (touched && (touched.size ?? touched.length)) { x.r.patch(x.work, touched); remember(x); } };
  const expectSame = (x, what) => {
    const a = C.canon(x.work), b = C.canon(x.r.project());
    if (a !== b) assert.fail(what + " leaves " + x.name + "'s editor project equal to its replica (seed " + seed + "): " + firstDifference(JSON.parse(a), JSON.parse(b)));
  };
  const send = (from, b) => {
    all.push(b);
    for (const y of R) if (y !== from) {
      if (!y.online || !from.online) { note("lost"); continue; }   // the transport drops it; catch-up repairs it later
      y.inbox.push(b); if (rand() < .05) { y.inbox.push(clone(b)); note("duplicate"); }
    }
  };
  // Catch-up between two replicas, both ways: ops from since(vv), else a snapshot merge.
  function sync(x, y) {
    for (const [a, b] of [[x, y], [y, x]]) {
      const ops = b.r.since(a.r.vv());
      if (ops === null) { const res = a.r.merge(clone(b.r.snapshot())); patch(a, res.touched); note("snapshot-merge"); }
      else if (ops.length) { const res = a.r.receive({ops: clone(ops)}); patch(a, res.touched); note("since"); }
    }
  }
  for (let step = 0; step < STEPS; step++) {
    const x = pick(R), roll = rand();
    // Connectivity: drop off for a while, return and catch up from a peer.
    if (roll < .04 && x.online && R.filter(y => y.online).length > 1) { x.online = false; x.away = int(5, 40); x.inbox.length = 0; note("drop"); trace.push(step + " " + x.name + " drops"); continue; }
    if (!x.online && --x.away <= 0) {
      x.online = true;
      const peer = pick(R.filter(y => y !== x && y.online));
      if (peer) sync(x, peer);
      note("return"); trace.push(step + " " + x.name + " returns, syncs with " + (peer?.name || "nobody"));
      expectSame(x, "catch-up");
      continue;
    }
    if (roll < .07) { if (x.r.trim()) note("trim"); continue; }
    let b = null, kind;
    const u = rand();
    if (u < .1 && x.r.canUndo()) { kind = "undo"; b = x.r.undo(); if (b) { x.r.patch(x.work, x.r.touches(b)); remember(x); } }   // as Live.undo: patchHost(S, S.r.touches(b)), even when empty
    else if (u < .15 && x.r.canRedo()) { kind = "redo"; b = x.r.redo(); if (b) { x.r.patch(x.work, x.r.touches(b)); remember(x); } }   // as Live.undo: patchHost(S, S.r.touches(b)), even when empty
    else if (u < .6) {
      const before = clone(x.work), e = itemEdit(x.work);
      if (!e) continue;
      kind = e.kind;
      A.validate(clone(x.work));
      const was = before.documents.find(d => d.id === e.d.id).items.find(i => i.id === e.it.id);
      if (x === J) b = journalCommit(x);
      else {
        b = x.r.commit(x.work, {updates: [{doc: e.d.id, before: was, after: clone(e.it)}]});
        if (b?.related?.length) patch(x, b.related);
      }
    } else {
      kind = structuralEdit(x.work);
      A.validate(clone(x.work));
      if (x === J) b = journalCommit(x);
      else {
        b = x.r.commit(x.work);
        if (b?.related?.length) patch(x, b.related);
      }
    }
    note(kind);
    if (b) { expectSame(x, kind); send(x, b); trace.push(step + " " + x.name + " " + kind + " " + b.ops.length + " ops"); }
    // Deliver a random part of every online inbox, in random order.
    for (const y of R) if (y.online && y.inbox.length && rand() < .45) {
      for (const m of shuffle(y.inbox).slice(0, int(1, y.inbox.length))) {
        y.inbox.splice(y.inbox.indexOf(m), 1);
        const res = y.r.receive(clone(m), {author: m.from});
        patch(y, res.touched);
      }
    }
  }
  // Everyone returns; deliver what is queued, then catch up pairwise until the vectors agree.
  for (const x of R) x.online = true;
  for (const y of R) { for (const m of shuffle(y.inbox)) patch(y, y.r.receive(clone(m), {author: m.from}).touched); y.inbox.length = 0; }
  for (let round = 0; round < 3; round++) for (const x of R) for (const y of R) if (x !== y) sync(x, y);
  const results = R.map(x => C.canon(x.r.project()));
  try {
    for (let i = 1; i < R.length; i++) assert.equal(results[i], results[0], R[i].name + " and " + R[0].name + " converge (seed " + seed + ")");
    for (const x of R) expectSame(x, "the end");
    A.validate(JSON.parse(results[0]));
    // Every operation delivered once more, in a new order, to a fresh replica: the same project.
    const fresh = C.create({replica: "fresh", project: base});
    for (const b of shuffle(all)) fresh.receive(clone(b));
    assert.equal(C.canon(fresh.project()), results[0], "a fresh replica given every batch in another order converges (seed " + seed + ")");
  } catch (e) {
    if (verbose) console.error(trace.slice(-60).join("\n"));
    e.message += "\n  reproduce: node tests/project/collab-convergence.cjs --seeds " + seed + " --steps " + STEPS + " --replicas " + REPLICAS + " --verbose";
    throw e;
  }
  return {counts, ops: all.reduce((n, b) => n + b.ops.length, 0), items: JSON.parse(results[0]).documents.reduce((n, d) => n + d.items.length, 0)};
}

const totals = {}, failures = [];
let ops = 0;
for (const seed of seeds) {
  try {
    const r = run(seed);
    ops += r.ops;
    for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] || 0) + v;
    if (verbose) console.log("seed", seed, JSON.stringify(r));
  } catch (e) { failures.push({seed, message: e.message.split("\n").slice(0, 2).join(" ").slice(0, 400)}); if (seeds.length === 1) throw e; }
}
if (failures.length) {
  console.error("collab-convergence: " + failures.length + " of " + seeds.length + " seeds diverged:\n" + failures.map(f => "  seed " + f.seed + ": " + f.message).join("\n"));
  process.exit(1);
}
assert.ok(totals.paste && totals["snapshot-merge"] !== undefined || seeds.length < 3, "the run covered pastes and catch-ups");
console.log("collab-convergence: ok (" + seeds.length + " seeds, " + REPLICAS + " replicas, " + STEPS + " steps, " + ops + " operations; " +
  Object.entries(totals).sort().map(([k, v]) => k + " " + v).join(", ") + ")");
