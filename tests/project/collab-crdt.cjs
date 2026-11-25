"use strict";
// Real-time co-editing CRDT (app/project/collab-crdt.js): randomised concurrent edits on three replicas
// converge, and applying the same operations in any order gives the same project; per-user
// undo; sequences (track and polygon vertices); untrusted remote operations; snapshots and the
// bounded log. Runs under Node and JavaScriptCore (scripts/test-jsc.sh collab-crdt).
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/formats/format-2-codec.js");
require("../../app/project/collab-crdt.js");
const A = globalThis.Atrium, C = globalThis.AtriumCollabCRDT;

// ---- a deterministic random source -----------------------------------------------------------
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
let rand = rng(12345);
const pick = list => list[Math.floor(rand() * list.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const shuffle = list => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const clone = v => JSON.parse(JSON.stringify(v));
let uid = 0; const nid = p => p + "-" + (++uid);

// ---- fixture -----------------------------------------------------------------------------------
function fixture() {
  const def = {id: "def-r", name: "Resistor", prefix: "R",
    symbol: {shapes: [{kind: "path", points: [[-2, 0], [2, 0]]}], pins: [{x: -3, y: 0, number: "1"}, {x: 3, y: 0, number: "2"}]},
    footprint: {shapes: [], pads: [{x: -1, y: 0, w: .8, h: .9, number: "1"}, {x: 1, y: 0, w: .8, h: .9, number: "2"}]}};
  const p = A.project("Collab test", [def]);
  const [sch, pcb] = p.documents;
  sch.id = "doc-sch"; pcb.id = "doc-pcb";
  for (let i = 0; i < 6; i++) {
    sch.items.push({id: "w" + i, kind: "wire", points: [[i * 5, 0], [i * 5 + 4, 0], [i * 5 + 4, 3]]});
    pcb.items.push({id: "t" + i, kind: "track", points: [[i, 0], [i + 3, 0], [i + 3, 2]], width: .25, layer: "Top", net: "N" + i});
  }
  sch.items.push({id: "p1", kind: "part", def: "def-r", ref: "R1", value: "10k", x: 10, y: 10, angle: 0});
  pcb.items.push({id: "p1b", kind: "part", def: "def-r", ref: "R1", value: "10k", x: 5, y: 5, angle: 0});
  pcb.items.push({id: "poly", kind: "polygon", points: [[0, 0], [10, 0], [10, 10], [0, 10]], layer: "Top", net: "GND"});
  pcb.items.push({id: "v1", kind: "via", x: 3, y: 3, diameter: .6});
  A.validate(p);
  return p;
}

// ---- random local edits ------------------------------------------------------------------------
function edit(p) {
  const docs = p.documents.filter(d => d.kind === "pcb" || d.kind === "schematic");
  const d = pick(docs), items = d.items;
  const pathItems = items.filter(i => Array.isArray(i.points));
  const r = rand();
  if (r < .14 && items.length) { const i = pick(items); if (i.points) i.points = i.points.map(([x, y]) => [x + 1, y]); else { i.x += int(-2, 2); i.y += 1; } return "move"; }
  if (r < .26) {
    const kind = d.kind === "pcb" ? "track" : "wire", n = int(2, 4), pts = [];
    for (let k = 0; k < n; k++) pts.push([int(0, 40), int(0, 40) + k]);
    items.splice(int(0, items.length), 0, {id: nid("n"), kind, points: pts, ...(kind === "track" ? {width: .2, layer: "Top"} : {})});
    return "add";
  }
  if (r < .36 && items.length > 2) { items.splice(int(0, items.length - 1), 1); return "delete"; }
  if (r < .5 && pathItems.length) { const i = pick(pathItems); i.points.splice(int(1, i.points.length - 1), 0, [int(0, 50), int(0, 50)]); return "insert-vertex"; }
  if (r < .6 && pathItems.length) { const i = pick(pathItems), min = i.kind === "polygon" ? 3 : 2; if (i.points.length > min) i.points.splice(int(0, i.points.length - 1), 1); return "delete-vertex"; }
  if (r < .72 && pathItems.length) { const i = pick(pathItems), k = int(0, i.points.length - 1); i.points[k] = [i.points[k][0] + .5, i.points[k][1] - .5]; return "move-vertex"; }
  if (r < .78 && items.length > 1) { const k = int(0, items.length - 1), [it] = items.splice(k, 1); items.splice(rand() < .5 ? 0 : items.length, 0, it); return "reorder"; }
  if (r < .82) { d.name = pick(["Board", "Main", "Rev B", "Power"]) + " " + int(1, 9); return "rename"; }
  if (r < .86) { p.name = "Project " + int(1, 99); return "meta"; }
  if (r < .9) { const t = items.find(i => i.kind === "track"); if (t) { if (t.net) delete t.net; else t.net = "GND"; } return "field-delete"; }
  if (r < .93) { const nd = {id: nid("doc"), kind: "schematic", name: "Sheet " + int(1, 9), grid: 1.27, items: [{id: nid("w"), kind: "wire", points: [[0, 0], [1, 1]]}], outline: [], notes: []}; p.documents.splice(int(0, p.documents.length), 0, nd); return "add-doc"; }
  if (r < .95 && p.documents.length > 3) { const extra = p.documents.filter(x => x.id !== "doc-sch" && x.id !== "doc-pcb"); if (extra.length) p.documents.splice(p.documents.indexOf(pick(extra)), 1); return "delete-doc"; }
  if (r < .98) { const same = docs.filter(x => x !== d && x.kind === d.kind && x.items.length); if (same.length && items.length) { const k = int(0, items.length - 1), [it] = items.splice(k, 1); if (it.kind !== "part") pick(same).items.push(it); else items.push(it); } return "move-between-docs"; }
  const part = items.find(i => i.kind === "part"); if (part) part.value = pick(["1k", "4k7", "10k", "100k"]);
  return "part-value";
}

// ---- convergence: three replicas, random concurrent edits and random delivery ------------------
function converge(seed, rounds, withUndo = false) {
  rand = rng(seed);
  const base = fixture();
  const names = ["alice", "bob", "carol"];
  const R = names.map(n => C.create({replica: n, project: base}));
  const inbox = names.map(() => []), all = [];
  const counts = {};
  for (let step = 0; step < rounds; step++) {
    const who = int(0, 2), r = R[who];
    const p = clone(r.project());
    const draw = withUndo ? rand() : 1;
    const kind = draw < .5 && r.canRedo() ? "redo" : draw < .2 && r.canUndo() ? "undo" : edit(p);
    counts[kind] = (counts[kind] || 0) + 1;
    A.validate(clone(p));
    const b = kind === "undo" ? r.undo() : kind === "redo" ? r.redo() : r.commit(p);
    if (b) {
      if (kind !== "undo" && kind !== "redo") assert.equal(C.canon(r.project()), C.canon(p), "a local commit reproduces the edited project (" + kind + ")");
      all.push(b);
      for (let k = 0; k < 3; k++) if (k !== who) { inbox[k].push(b); if (rand() < .05) inbox[k].push(clone(b)); }
    }
    // Deliver a random subset, in random order (with duplicates above).
    for (let k = 0; k < 3; k++) if (inbox[k].length && rand() < .4) {
      const take = shuffle(inbox[k]).slice(0, int(1, inbox[k].length));
      for (const m of take) { inbox[k].splice(inbox[k].indexOf(m), 1); R[k].receive(clone(m)); }
    }
  }
  for (let k = 0; k < 3; k++) for (const m of shuffle(inbox[k])) R[k].receive(clone(m));
  const results = R.map(r => C.canon(r.project()));
  assert.equal(results[0], results[1], "alice and bob converge (seed " + seed + ")");
  assert.equal(results[1], results[2], "bob and carol converge (seed " + seed + ")");
  A.validate(JSON.parse(results[0]));
  // The same operations in any order, one at a time, on fresh replicas.
  const ops = all.flatMap(b => b.ops.map(op => ({from: b.from, ops: [op]})));
  for (let t = 0; t < 3; t++) {
    const f = C.create({replica: "fresh" + t, project: base});
    for (const m of shuffle(ops)) f.receive(clone(m));
    assert.equal(C.canon(f.project()), results[0], "any delivery order gives the same project (seed " + seed + ", order " + t + ")");
  }
  // Batches in reverse order too (inserts wait for their predecessors).
  const rev = C.create({replica: "reverse", project: base});
  for (const m of [...all].reverse()) rev.receive(clone(m));
  assert.equal(C.canon(rev.project()), results[0], "reverse delivery converges");
  return {counts, ops: ops.length, project: JSON.parse(results[0])};
}
{
  let total = 0;
  for (const seed of [1, 7, 42, 99, 2024, 31337]) { const r = converge(seed, 160); total += r.ops; }
  for (const seed of [81, 104, 941]) { const r = converge(seed, 180, true); assert.ok(r.counts.undo && r.counts.redo); }
  assert.ok(total > 1000, "the suite exercised many operations: " + total);
}

// ---- sequences: concurrent vertex edits keep both -----------------------------------------------
{
  const base = fixture();
  const a = C.create({replica: "a", project: base}), b = C.create({replica: "b", project: base});
  const pa = clone(a.project()), pb = clone(b.project());
  const ta = pa.documents[1].items.find(i => i.id === "poly"), tb = pb.documents[1].items.find(i => i.id === "poly");
  ta.points.splice(1, 0, [5, -1]);           // a inserts a vertex on the first edge
  tb.points.splice(3, 0, [-1, 5]);           // b inserts one on the last edge
  tb.points[2] = [11, 11];                   // and moves a corner
  const ba = a.commit(pa), bb = b.commit(pb);
  a.receive(bb); b.receive(ba);
  const poly = a.project().documents[1].items.find(i => i.id === "poly").points;
  assert.deepEqual(poly, [[0, 0], [5, -1], [10, 0], [11, 11], [-1, 5], [0, 10]], "both inserts and the move survive");
  assert.equal(C.canon(a.project()), C.canon(b.project()));
  // A moved vertex is a value update, not a delete and an insert.
  assert.ok(bb.ops.some(op => op.t === "pset") && !bb.ops.some(op => op.t === "del"), "moving a vertex keeps its id");
}

// ---- concurrent property edits: last writer wins, per property -----------------------------------
{
  const base = fixture();
  const a = C.create({replica: "a", project: base}), b = C.create({replica: "b", project: base});
  const pa = clone(a.project()), pb = clone(b.project());
  pa.documents[1].items.find(i => i.id === "v1").x = 7;      // a moves the via in x
  pb.documents[1].items.find(i => i.id === "v1").diameter = .8; // b changes its size
  const ba = a.commit(pa), bb = b.commit(pb);
  a.receive(bb); b.receive(ba);
  const v = a.project().documents[1].items.find(i => i.id === "v1");
  assert.equal(v.x, 7); assert.equal(v.diameter, .8);
  assert.equal(C.canon(a.project()), C.canon(b.project()));
}

// ---- undo restores only deletions owned by its author ----------------------------------------------
{
  const base = fixture();
  const a = C.create({replica: "a", project: base}), b = C.create({replica: "b", project: base});
  const pa = clone(a.project()); pa.documents[1].items = pa.documents[1].items.filter(i => i.id !== "t0");
  const ba = a.commit(pa);                 // a deletes t0
  b.receive(ba); b.undo();                 // nothing of b's to undo
  const pb = clone(b.project());
  assert.ok(!pb.documents[1].items.some(i => i.id === "t0"));
  // a undoes its delete while c, concurrently, deletes it again having seen only the original.
  const c = C.create({replica: "c", project: base});
  const pc = clone(c.project()); pc.documents[1].items = pc.documents[1].items.filter(i => i.id !== "t0");
  const bc = c.commit(pc);
  const ua = a.undo();
  for (const r of [a, b, c]) { r.receive(ba); r.receive(bc); r.receive(ua); }
  for (const r of [a, b, c]) assert.ok(!r.project().documents[1].items.some(i => i.id === "t0"), "Carol's independent deletion stays in effect");
  const uc = c.undo();
  for (const r of [a, b, c]) { r.receive(uc); assert.ok(r.project().documents[1].items.some(i => i.id === "t0"), "both authors withdrew their deletion"); }
}

// ---- per-user undo touches only the user's own operations ------------------------------------------
{
  const base = fixture();
  const a = C.create({replica: "a", project: base}), b = C.create({replica: "b", project: base});
  const pa = clone(a.project()); pa.documents[1].items.find(i => i.id === "v1").x = 20; const ba = a.commit(pa);
  const pb = clone(b.project()); pb.documents[1].items.find(i => i.id === "t1").width = .5; const bb = b.commit(pb);
  a.receive(bb); b.receive(ba);
  const ua = a.undo();
  assert.ok(ua && ua.ops.length, "alice can undo");
  b.receive(ua);
  for (const r of [a, b]) {
    const items = r.project().documents[1].items;
    assert.equal(items.find(i => i.id === "v1").x, 3, "alice's move is undone");
    assert.equal(items.find(i => i.id === "t1").width, .5, "bob's edit stays");
  }
  const ra = a.redo(); b.receive(ra);
  assert.equal(b.project().documents[1].items.find(i => i.id === "v1").x, 20, "redo");
  // A hidden contribution can be withdrawn without changing the current winner.
  const pb2 = clone(b.project()); pb2.documents[1].items.find(i => i.id === "v1").x = 30; a.receive(b.commit(pb2));
  const u2 = a.undo();
  b.receive(u2);
  assert.equal(a.project().documents[1].items.find(i => i.id === "v1").x, 30);
  // Undo of an added track with vertices, after another user inserted a vertex into it.
  const pa3 = clone(a.project()); pa3.documents[1].items.push({id: "new-t", kind: "track", points: [[0, 0], [5, 0]], width: .2, layer: "Top"}); const ba3 = a.commit(pa3);
  b.receive(ba3);
  const pb3 = clone(b.project()); pb3.documents[1].items.find(i => i.id === "new-t").points.splice(1, 0, [2, 2]); a.receive(b.commit(pb3));
  const ua3 = a.undo(); b.receive(ua3);
  for (const r of [a, b]) assert.deepEqual(r.project().documents[1].items.find(i => i.id === "new-t").points, [[0, 0], [2, 2], [5, 0]], "a collaborator's vertex keeps its parent track");
}

// Replay across an arbitrary divide between a saved snapshot and delayed operations.
function replay(base, batches, check) {
  const ops = batches.flatMap(b => b.ops);
  for (const order of [ops, [...ops].reverse(), shuffle(ops)]) {
    let r = C.create({replica: "observer", project: base});
    for (let i = 0; i < order.length; i++) {
      if (i === Math.floor(order.length / 2)) r = C.create({replica: "observer", snapshot: clone(r.snapshot())});
      r.receive({ops: [order[i]]});
    }
    A.validate(clone(r.project())); check(r);
  }
}
function change(r, fn, options) { const p = clone(r.project()); fn(p); return r.commit(p, options); }
function item(p, id) { return p.documents.flatMap(d => d.items).find(i => i.id === id); }
{
  const base = fixture(), a = C.create({project: base, replica: "zoe"}), b = C.create({project: base, replica: "amy"});
  const edit = (r, name, x) => change(r, p => { p.name = name; item(p, "v1").x = x; item(p, "poly").points[0] = [x, x]; });
  const mine = edit(a, "Zoe", 20), theirs = edit(b, "Amy", 40);
  // A different wall-clock delivery order must not promote an inverse to a new winning write.
  const undone = a.undo(); a.receive(theirs); b.receive(mine); b.receive(undone);
  const expect = (r, name, x) => { assert.equal(r.project().name, name); assert.equal(item(r.project(), "v1").x, x); assert.deepEqual(item(r.project(), "poly").points[0], [x, x]); };
  replay(base, [mine, theirs, undone], r => expect(r, "Amy", 40));
  const later = edit(b, "Amy updated", 60), redone = a.redo();
  replay(base, [mine, theirs, undone, later, redone], r => expect(r, "Amy updated", 60));
  // Someone else's earlier losing value is still available when the visible winner is undone.
  a.receive(later); b.receive(redone);
  const undoLater = b.undo(); a.receive(undoLater);
  expect(a, "Zoe", 20);
  const undoAgain = a.undo();
  replay(base, [mine, theirs, undone, later, redone, undoLater, undoAgain], r => expect(r, "Amy", 40));
}
{
  const base = fixture(), a = C.create({project: base, replica: "a"}), b = C.create({project: base, replica: "b"});
  const created = change(a, p => {
    p.library.push({...clone(p.library[0]), id: "adopted-lib"});
    p.documents.push({...clone(p.documents[0]), id: "shared-sheet", items: [
      {id: "created-wire", kind: "wire", points: [[0, 0], [4, 0]]},
      {id: "spare-wire", kind: "wire", points: [[0, 0], [0, 4]]}
    ]});
  });
  b.receive(created);
  const adopted = change(b, p => {
    p.documents.at(-1).items.push({...clone(item(p, "p1")), id: "bob-part", def: "adopted-lib"});
    item(p, "created-wire").points[1] = [8, 0];
  });
  const withdrawn = a.undo();
  const check = r => {
    const p = r.project();
    assert.ok(p.documents.some(d => d.id === "shared-sheet"), "a collaborator's child keeps the document");
    assert.equal(item(p, "bob-part").def, "adopted-lib");
    assert.ok(p.library.some(d => d.id === "adopted-lib"), "a referenced definition stays available");
    assert.deepEqual(item(p, "created-wire").points, [[0, 0], [8, 0]]);
    assert.equal(item(p, "spare-wire"), undefined, "other original creations are withdrawn");
  };
  replay(base, [created, adopted, withdrawn], check);
  const again = a.redo();
  replay(base, [created, adopted, withdrawn, again], r => {
    assert.ok(item(r.project(), "spare-wire")); assert.deepEqual(item(r.project(), "created-wire").points, [[0, 0], [8, 0]]);
  });
}
{
  const base = fixture(), a = C.create({project: base, replica: "a"}), b = C.create({project: base, replica: "b"});
  const added = change(a, p => item(p, "poly").points.splice(1, 0, [5, 1]));
  b.receive(added);
  const moved = change(b, p => { item(p, "poly").points[1] = [5, 3]; item(p, "poly").points.splice(2, 0, [7, 2]); });
  const undone = a.undo(), redone = a.redo();
  for (const controls of [[undone], [undone, redone]]) replay(base, [added, moved, ...controls], r => {
    assert.deepEqual(item(r.project(), "poly").points.slice(0, 4), [[0, 0], [5, 3], [7, 2], [10, 0]], "a moved vertex and its descendants keep their identities");
  });
  const bothCut = r => change(r, p => item(p, "poly").points.splice(-1));
  const cutA = bothCut(a), cutB = bothCut(b), uncutA = a.undo();
  replay(base, [added, moved, undone, redone, cutA, cutB, uncutA], r => {
    assert.ok(!item(r.project(), "poly").points.some(p => p[0] === 0 && p[1] === 10), "the independent vertex deletion stays in effect");
  });
  replay(base, [added, moved, undone, redone, cutA, cutB, uncutA, b.undo()], r => {
    assert.deepEqual(item(r.project(), "poly").points.at(-1), [0, 10], "undo restores the original vertex after both deletes are withdrawn");
  });
}
{
  const base = fixture(), a = C.create({project: base, replica: "a"}), b = C.create({project: base, replica: "b"});
  const editA = change(a, p => { p.name = "mine"; }), editB = change(b, p => { p.name = "other"; });
  const startA = a.vv(), startB = b.vv();
  const snapA = clone(a.snapshot()), snapB = clone(b.snapshot());
  assert.ok(a.merge(snapB).applied && b.merge(snapA).applied);
  assert.equal(a.project().name, "other"); assert.equal(a.project().name, b.project().name);
  assert.ok(!a.merge(snapB).applied, "duplicate join is harmless");
  assert.equal(a.since(startA), null, "send a snapshot if the joined state contains history missing from the log");
  assert.equal(b.since(startB), null);
  b.receive(a.undo()); assert.equal(b.project().name, "other");
  a.receive(b.undo()); assert.equal(a.project().name, base.name, "offline personal undo survives a full snapshot join");
  assert.ok(editA && editB);
  assert.throws(() => C.create({replica: "a", snapshot: clone(a.snapshot())}), /edits by this replica/, "an untrusted snapshot never sets our own counter");
  const restored = C.create({replica: "a", snapshot: clone(a.snapshot()), resume: true});
  const after = change(restored, p => { p.name = "restored"; }, {recordUndo: false});
  assert.equal(after.ops[0].n, (a.vv().a || 0) + 1, "a replica resumes its own sequence from a snapshot");
  assert.equal(restored.undo(), null); assert.equal(restored.redo(), null);
}
{
  const base = fixture();
  base.library.push({id: "board-only", name: "Board only", footprint: clone(base.library[0].footprint)});
  const a = C.create({project: base, replica: "a"}), b = C.create({project: base, replica: "b"});
  const symbol = change(a, p => { p.library.at(-1).symbol = clone(p.library[0].symbol); }); b.receive(symbol);
  const part = change(b, p => { p.documents[0].items.push({...clone(item(p, "p1")), id: "relying-on-symbol", def: "board-only"}); });
  const undone = a.undo();
  replay(base, [symbol, part, undone], r => {
    assert.ok(item(r.project(), "relying-on-symbol"), "undo must keep a symbol that a collaborator's placed part requires");
  });
  const editor = clone(a.project()), related = a.receive(part);
  assert.ok(related.touched.has("board-only")); a.patch(editor, related.touched);
  assert.ok(editor.library.at(-1).symbol, "patch refreshes an existing definition after a dependent part arrives");
  b.receive(undone);
  const remove = change(b, p => { p.documents[0].items = p.documents[0].items.filter(it => it.id !== "relying-on-symbol"); });
  assert.ok(remove.related.includes("board-only"), "the local editor also refreshes the withdrawn geometry when the last part is removed");
  replay(base, [symbol, part, undone, remove], r => assert.equal(r.project().library.at(-1).symbol, undefined, "an unused withdrawn symbol no longer needs retaining"));
}
{
  const base = fixture(), a = C.create({project: base, replica: "a"}), b = C.create({project: base, replica: "b"});
  const added = change(a, p => item(p, "t0").points.push([5, 5])); b.receive(added);
  const cut = change(b, p => item(p, "t0").points.splice(0, 2));
  const undone = a.undo();
  replay(base, [added, cut, undone], r => assert.deepEqual(item(r.project(), "t0").points, [[3, 2], [5, 5]], "a collaborator's remaining valid path survives"));
  b.receive(undone);
  const more = change(b, p => item(p, "t0").points.push([8, 8]));
  assert.ok(more.related.includes("t0")); assert.deepEqual(item(b.project(), "t0").points, [[3, 2], [8, 8]]);
}
{
  const base = fixture(); base.documents.push({...clone(base.documents[1]), id: "other-board", items: []});
  const a = C.create({project: base, replica: "a"}), b = C.create({project: base, replica: "b"});
  const moved = change(a, p => {
    const items = p.documents[1].items, via = items.splice(items.findIndex(i => i.id === "v1"), 1)[0];
    p.documents[2].items.push(via);
  });
  b.receive(moved);
  const updated = change(b, p => { item(p, "v1").diameter = 1; });
  const undone = a.undo(), redone = a.redo();
  for (const [index, history] of [[1, [undone]], [2, [undone, redone]]]) replay(base, [moved, updated, ...history], r => {
    assert.equal(r.project().documents[index].items.find(i => i.id === "v1").diameter, 1, "personal relocation preserves the collaborator's edit");
  });
}
{
  // A v1 snapshot predating author-controlled undo has only its current register
  // winners and permanent tombstones. Reads and subsequent personal edits still work.
  const base = fixture(), seeded = C.create({project: base, replica: "a"}), legacy = clone(seeded.snapshot());
  const row = legacy.objs.find(([id]) => id === "v1"); row[2] = []; row[3] = ["0@~"];
  const cut = legacy.objs.find(([id]) => id === "poly")[5][0][1]; cut.e[0][4] = 1;
  const a = C.create({snapshot: legacy, replica: "a"}), old = C.canon(a.project());
  assert.ok(!item(a.project(), "v1")); assert.deepEqual(item(a.project(), "poly").points[0], [10, 0]);
  change(a, p => { p.name = "edit after join"; }); a.undo();
  assert.equal(C.canon(a.project()), old);
  const b = C.create({snapshot: clone(a.snapshot()), replica: "b"});
  assert.equal(C.canon(b.project()), old);
}
{
  const a = C.create({project: fixture(), replica: "a"});
  const kept = change(a, p => { p.documents[1].items.push({...clone(item(p, "v1")), id: "kept-by-host"}); });
  const after = change(a, p => { p.name = "offline after checkpoint"; });
  a.undo();
  a.forgetHistoryThrough(kept.ops.at(-1).n);
  assert.equal(a.undo(), null, "pre-restore creation is retired");
  assert.ok(a.redo()); assert.equal(a.project().name, "offline after checkpoint");
  assert.ok(a.undo()); assert.ok(item(a.project(), "kept-by-host"), "a later offline action keeps its own undo");
  a.forgetHistoryThrough(after.ops.at(-1).n);
  assert.equal(a.redo(), null, "pre-restore redo is retired too");
}
{
  const base = fixture(), a = C.create({project: base, replica: "a"}), b = C.create({project: base, replica: "b"});
  // Both sides have dropped the operations needed for replay; their snapshots must join in either order.
  for (const [r, actor, key] of [[a, "local-a", "localA"], [b, "local-b", "localB"]]) {
    const ops = Array.from({length: C.LIMITS.log + 1}, (_, i) => ({t: "meta", k: key, v: i, ts: {r: actor, c: i + 1}, n: i + 1}));
    r.receive({ops}); assert.ok(r.trim()); assert.equal(r.since({}), null);
  }
  change(a, p => { item(p, "v1").x = 18; }); change(b, p => { item(p, "v1").diameter = .9; });
  const aBefore = clone(a.snapshot()), bBefore = clone(b.snapshot());
  a.merge(bBefore); b.merge(aBefore);
  assert.equal(C.canon(a.project()), C.canon(b.project()));
  assert.equal(a.project().localA, C.LIMITS.log); assert.equal(a.project().localB, C.LIMITS.log);
  b.receive(a.undo()); assert.equal(item(b.project(), "v1").x, 3); assert.equal(item(b.project(), "v1").diameter, .9);
}
{
  const r = C.create({project: fixture(), replica: "author"});
  for (let i = 1; i <= C.LIMITS.undo + 2; i++) change(r, p => { p.name = "name " + i; });
  for (let i = 0; i < C.LIMITS.undo; i++) assert.ok(r.undo());
  assert.equal(r.undo(), null); assert.equal(r.project().name, "name 2");
  const name = r.snapshot().meta.find(([k]) => k === "name")[1];
  assert.equal(name.writers.length, 2, "one baseline and one author contribution suffice after hundreds of edits");
}

// ---- untrusted operations ---------------------------------------------------------------------------
{
  const base = fixture();
  const r = C.create({replica: "victim", project: base});
  const before = C.canon(r.project());
  const bad = [
    {from: "m", ops: [{t: "set", o: "v1", k: "__proto__", v: {polluted: 1}, ts: {c: 5, r: "m"}, n: 1}]},
    JSON.parse('{"from":"m","ops":[{"t":"set","o":"v1","k":"x","v":{"a":{"__proto__":{"polluted":1}}},"ts":{"c":5,"r":"m"},"n":1}]}'),
    {from: "m", ops: [{t: "eval", o: "v1", ts: {c: 5, r: "m"}, n: 1}]},
    {from: "m", ops: [{t: "set", o: "v1", k: "x", v: 1, ts: {c: "5", r: "m"}, n: 1}]},
    {from: "m", ops: [{t: "set", o: "v1", k: "x", v: "x".repeat(C.LIMITS.value + 10), ts: {c: 5, r: "m"}, n: 1}]},
    {from: "m", ops: new Array(C.LIMITS.ops + 1).fill(0).map((_, i) => ({t: "pos", o: "v1", v: "V", ts: {c: i + 1, r: "m"}, n: i + 1}))},
    {from: "m", ops: [{t: "ins", o: "t0", k: "points", e: "../x", v: [1, 1], ts: {c: 5, r: "m"}, n: 1}]},
    {from: "m", ops: [{t: "meta", k: "documents", v: [], ts: {c: 5, r: "m"}, n: 1}]},
    {ops: [{t: "undo", a: "ins", at: 1, on: false, o: "poly", k: "points", e: "1.someone-else.0", ts: {c: 5, r: "m"}, n: 1}]},
    {ops: [{t: "undo", a: "meta", at: 1, rank: 9, on: true, k: "name", v: "future", ts: {c: 5, r: "m"}, n: 1}]},
    {from: "m", ops: [{t: "set", o: "v1", k: "x", v: 1, ts: {c: 5, r: "m"}, n: 1}, {t: "set", o: "v1", k: "constructor", v: 1, ts: {c: 6, r: "m"}, n: 2}]},
    "not a batch", {ops: "x"}
  ];
  for (const m of bad) assert.throws(() => r.receive(m), /collaboration message/, "rejected: " + JSON.stringify(m).slice(0, 80));
  assert.equal(C.canon(r.project()), before, "a rejected batch changes nothing (all or nothing)");
  assert.equal(({}).polluted, undefined, "no prototype pollution");
  // A well-formed op that makes an object invalid is filtered out of the project, the same way
  // on every replica (model validation, as for a file load).
  const ok = C.create({replica: "peer", project: base});
  const evil = {from: "m", ops: [{t: "set", o: "v1", k: "x", v: 1e12, ts: {c: 9, r: "m"}, n: 1}, {t: "set", o: "p1b", k: "def", v: "missing", ts: {c: 10, r: "m"}, n: 2}]};
  r.receive(clone(evil)); ok.receive(clone(evil));
  const pr = r.project();
  A.validate(clone(pr));
  assert.ok(!pr.documents[1].items.some(i => i.id === "v1" || i.id === "p1b"), "invalid objects are not materialised");
  assert.equal(C.canon(pr), C.canon(ok.project()), "filtering is deterministic");
  assert.ok(r.stats().filtered >= 2);
  // A later valid fix brings the object back.
  const fix = {from: "m", ops: [{t: "set", o: "v1", k: "x", v: 4, ts: {c: 11, r: "m"}, n: 3}]};
  r.receive(fix);
  assert.equal(r.project().documents[1].items.find(i => i.id === "v1").x, 4);
}

// ---- snapshots, version vectors and the bounded log ---------------------------------------------------
{
  rand = rng(5);
  const base = fixture();
  const a = C.create({replica: "a", project: base});
  for (let i = 0; i < 40; i++) { const p = clone(a.project()); edit(p); a.commit(p); }
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const b = C.create({replica: "b", snapshot: snap});
  assert.equal(C.canon(b.project()), C.canon(a.project()), "a snapshot restores the project");
  assert.deepEqual(b.vv(), a.vv());
  // b catches up with ops from the log since its version vector.
  for (let i = 0; i < 10; i++) { const p = clone(a.project()); edit(p); a.commit(p); }
  const missing = a.since(b.vv());
  assert.ok(missing.length > 0);
  b.receive({from: "a", ops: missing});
  assert.equal(C.canon(b.project()), C.canon(a.project()), "catch-up from the log");
  // Offline edits on both sides sync on reconnect.
  const pa = clone(a.project()); pa.name = "Offline A"; a.commit(pa);
  const pb = clone(b.project()); pb.documents[0].name = "Offline B"; b.commit(pb);
  a.receive({from: "b", ops: b.since(a.vv())}); b.receive({from: "a", ops: a.since(b.vv())});
  assert.equal(C.canon(a.project()), C.canon(b.project()), "offline edits merge on reconnect");
  assert.equal(a.project().name, "Offline A"); assert.equal(a.project().documents[0].name, "Offline B");
  // A long session trims the log; a replica that far behind needs a snapshot.
  const stale = {a: 1};
  let trimmed = false;
  for (let i = 0; i < 400 && !trimmed; i++) { const p = clone(a.project()); const v = p.documents[1].items.find(x => x.kind === "via"); if (v) v.x = (v.x + 1) % 50; else edit(p); a.commit(p); trimmed = a.trim() || trimmed; if (a.stats().log > C.LIMITS.log) trimmed = a.trim(); }
  for (let i = 0; i < C.LIMITS.log && !trimmed; i++) { const p = clone(a.project()); p.name = "n" + i; a.commit(p); trimmed = a.trim(); }
  assert.ok(trimmed, "the log is bounded");
  assert.ok(a.stats().log <= C.LIMITS.log);
  assert.equal(a.since(stale), null, "too far behind: snapshot");
  const c = C.create({replica: "c", snapshot: JSON.parse(JSON.stringify(a.snapshot()))});
  assert.equal(C.canon(c.project()), C.canon(a.project()));
}

// ---- patching an editor project in place keeps untouched objects --------------------------------------
{
  const base = fixture();
  const a = C.create({replica: "a", project: base}), b = C.create({replica: "b", project: base});
  const editorProject = clone(base), keepT2 = editorProject.documents[1].items.find(i => i.id === "t2"), keepDoc = editorProject.documents[0];
  const pa = clone(a.project()); const t1 = pa.documents[1].items.find(i => i.id === "t1"); t1.points.push([9, 9]); pa.documents[1].items.push({id: "z", kind: "via", x: 1, y: 1, diameter: .5});
  pa.documents[1].items = pa.documents[1].items.filter(i => i.id !== "v1");
  const res = b.receive(a.commit(pa));
  const observed = new Map();
  const observe = (before, after) => observed.set((before || after).id, [clone(before), clone(after)]);
  b.patch(editorProject, res.touched, new Map([[pa.documents[1].id, observe]]));
  assert.deepEqual([...observed.keys()].sort(), ["t1", "v1", "z"]);
  assert.equal(observed.get("z")[0], null); assert.equal(observed.get("v1")[1], null);
  assert.equal(observed.get("t1")[0].points.length + 1, observed.get("t1")[1].points.length);
  assert.equal(C.canon(editorProject), C.canon(b.project()), "patched to the replica state");
  assert.equal(editorProject.documents[1].items.find(i => i.id === "t2"), keepT2, "untouched item keeps its identity");
  assert.equal(editorProject.documents[0], keepDoc, "untouched document keeps its identity");
}

// An independent, full replica must stamp the exact same operations for a settled
// burst, even when records arrive in a different order from the project lists.
{
  require("../../app/history/undo-store.js");
  const U = globalThis.AtriumUndoStore, p = fixture(), board = p.documents[1], sheet = p.documents[0];
  const scoped = C.create({replica: "mine", project: p}), full = C.create({replica: "mine", project: p});
  const peer = C.create({replica: "peer", project: p}), target = clone(p);
  const keepBoard = target.documents[1].items, keepSheet = target.documents[0].items, keepLibrary = target.library;
  U.reset(); U.mark(p);
  let cursor = U.itemEdits(p).cursor;
  const compare = () => {
    const range = U.itemEdits(p, cursor, true); cursor = range.cursor;
    const a = scoped.commit(p, {updates: range.updates}), b = full.commit(p);
    assert.deepEqual(a, b);
    if (a) {
      const result = peer.receive(a, {author: "mine"});
      peer.patch(target, result.touched);
      assert.equal(peer.receive(a, {author: "mine"}).applied, 0);
    }
    assert.deepEqual(scoped.vv(), peer.vv());
    assert.deepEqual(scoped.raw(), full.raw()); assert.deepEqual(target, scoped.project());
    return range.updates;
  };
  const track = board.items[2], wire = sheet.items[0], via = board.items.at(-1);
  via.x += 1; U.record(p, {doc: board, items: [via]});
  track.points.splice(1, 0, [2, 3], [3, 4]); U.record(p, {doc: board, items: [track]});
  wire.points.splice(1, 1); U.record(p, {doc: sheet, items: [wire]});
  via.x += 1; U.record(p, {doc: board, items: [via]});
  assert.equal(compare().length, 3);
  assert.equal(target.library, keepLibrary); assert.equal(target.documents[1].items, keepBoard); assert.equal(target.documents[0].items, keepSheet);
  assert.deepEqual(compare(), [], "a settled no-op stamps nothing");
  // A remote contribution on another sheet survives each author's personal history.
  const other = clone(peer.project()); other.documents[0].items[2].points[0][1] += 2;
  const incoming = peer.commit(other), received = scoped.receive(incoming, {author: "peer"});
  full.receive(incoming, {author: "peer"});
  const effect = scoped.preparePatch(p, received.touched);
  assert.deepEqual(effect.scopes.map(s => [s.doc.id, s.items.map(it => it.id)]), [[sheet.id, [sheet.items[2].id]]]);
  effect.apply(); U.record(p, effect.scopes); cursor = U.itemEdits(p).cursor;
  peer.patch(target, peer.touches(incoming));
  for (const action of ["undo", "redo"]) {
    const a = scoped[action](), b = full[action](); assert.deepEqual(a, b);
    scoped.patch(p, scoped.touches(a)); U.record(p); cursor = U.itemEdits(p).cursor;
    peer.patch(target, peer.receive(a).touched);
    assert.deepEqual(scoped.raw(), full.raw()); assert.deepEqual(target, p);
    assert.deepEqual(target.documents[0].items[2], other.documents[0].items[2]);
  }
  // A drag already previewing its next position must publish the saved value.
  via.y += 3; U.record(p, {doc: board, items: [via]});
  const saved = clone(p), range = U.itemEdits(p, cursor); via.y += 99;
  assert.deepEqual(scoped.commit(p, {updates: range.updates}), full.commit(saved));
  via.y -= 99; cursor = range.cursor;
  for (const mutate of [
    () => board.items.reverse(), () => { p.componentFamilies = [{id: "family"}]; },
    () => { p.parameters = {test: "changed"}; }, () => { sheet.name += " renamed"; }
  ]) {
    mutate(); U.record(p); const range = U.itemEdits(p, cursor); cursor = range.cursor;
    assert.equal(range.updates, null, "list or non-item records require a complete diff");
    assert.deepEqual(scoped.commit(p, {updates: range.updates}), full.commit(p));
  }
  const m = U.mark(p);
  via.x += 1; U.record(p, {doc: board, items: [via]}); const abandoned = U.itemEdits(p).cursor;
  U.rollback(m); via.y += 1; U.record(p, {doc: board, items: [via]});
  assert.equal(U.itemEdits(p, abandoned).updates, null, "forking at the same absolute position expires the cursor");
  U.reset();
}

// ---- fractional keys ----------------------------------------------------------------------------------
{
  const base = fixture(), a = C.create({replica: "alice", project: base}), b = C.create({replica: "bob", project: base});
  const via = id => ({id, kind: "via", x: 4, y: 5, diameter: .8});
  const append = (r, id) => { const p = r.project(); p.documents[1].items.push(via(id)); return r.commit(p); };
  const first = append(a, "alice-via"), second = append(b, "bob-via");
  assert.equal(first.ops[0].pos, second.ops[0].pos);
  b.receive(first); a.receive(second);
  assert.equal(b.commit(b.project()), null, "two ordered concurrent placements create no extra Undo step");
  const p = b.project(), items = p.documents[1].items;
  items.find(v => v.id === "bob-via").x++;
  assert.deepEqual(b.diff(p).map(o => o.t), ["set"], "a field edit does not move a collaborator's item");
  const at = items.findIndex(v => v.id === "bob-via");
  items.splice(at, 0, ...Array.from({length: 1500}, (_, i) => via("pasted-" + i)));
  a.receive(b.commit(p));
  assert.equal(C.canon(a.project()), C.canon(p), "an entire paste fits between concurrent positions and survives transmission");
}
{
  let lo = "", hi = null;
  for (let i = 0; i < 200; i++) { const k = C.between(lo, hi); assert.ok(k > lo && (hi == null || k < hi), "between"); if (i % 2) lo = k; else hi = k; }
  const keys = C.spread(1000);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i] > keys[i - 1], "spread is increasing");
}

// ---- authorship and counters (security review) ----------------------------------------------------
{
  // Forged authors: a live batch is accepted only when every operation is the verified sender's own.
  const base = fixture(), a = C.create({replica: "alice", project: base}), b = C.create({replica: "bob", project: base});
  const m = clone(a.project()); m.name = "by alice"; item(m, "v1").x = 7;
  const batch = a.commit(m);
  assert.throws(() => b.receive(clone(batch), {author: "mallory"}), /someone else|sender/, "a peer cannot relay edits in another's name");
  const forged = clone(batch); forged.from = "mallory"; for (const op of forged.ops) op.ts.r = "mallory";
  assert.throws(() => b.receive(clone(forged), {author: "eve"}), /someone else|sender/);
  b.receive(clone(batch), {author: "alice"});
  assert.equal(b.project().name, "by alice");
  // A personal undo in someone else's name would withdraw their edit.
  const undo = a.undo(); const stolen = clone(undo); stolen.from = "bob"; for (const op of stolen.ops) op.ts.r = "bob";
  assert.throws(() => b.receive(clone(stolen), {author: "mallory"}), /someone else|sender/);
  // Tags and element ids follow the stamp: an "add" cannot claim another author's tag.
  const p2 = clone(a.project()); p2.documents[1].items.push({id: "v-new", kind: "via", x: 1, y: 1, diameter: .6});
  const added = clone(a.commit(p2)), add = added.ops.find(op => op.t === "add");
  add.tag = "1@bob";
  assert.throws(() => b.receive(added), /op tag/);
  const t2 = clone(a.project()); item(t2, "t1").points.splice(1, 0, [9, 9]);
  const ins = clone(a.commit(t2)); ins.ops.find(op => op.t === "ins").e = "99.bob.0";
  assert.throws(() => b.receive(ins), /op element/);
}
{
  // Counter inflation: clocks, sequence numbers and this replica's own counter stay bounded.
  const base = fixture(), a = C.create({replica: "alice", project: base}), b = C.create({replica: "bob", project: base});
  const ahead = {from: "alice", ops: [{t: "meta", k: "name", v: "x", ts: {r: "alice", c: C.LIMITS.skew + 50}, n: 1}]};
  assert.throws(() => b.receive(clone(ahead), {author: "alice"}), /clock too far ahead/);
  assert.throws(() => b.receive({from: "alice", ops: [{t: "meta", k: "name", v: "x", ts: {r: "alice", c: 2 ** 53 - 1}, n: 1}]}, {author: "alice"}), /clock/);
  assert.throws(() => b.receive({ops: [{t: "meta", k: "name", v: "x", ts: {r: "alice", c: 5}, n: C.LIMITS.gap + 10}]}), /sequence out of range/);
  assert.throws(() => b.receive({ops: [{t: "meta", k: "name", v: "x", ts: {r: "bob", c: 5}, n: 3}]}), /sequence out of range/, "nobody else can number edits by us");
  assert.equal(b.stats().clock, 0, "rejected batches leave the clock alone");
  // A snapshot with an inflated clock, our own counter or an army of authors is refused whole.
  const snap = clone(a.snapshot());
  assert.throws(() => b.merge({...clone(snap), clock: C.LIMITS.skew * 3}), /clock too far ahead/);
  const mine = clone(snap); mine.vv.push(["bob", 40]);
  assert.throws(() => b.merge(mine), /sequence/);
  const crowd = clone(snap); crowd.vv = Array.from({length: C.LIMITS.authors + 1}, (_, i) => ["r" + i, 1]);
  assert.throws(() => b.merge(crowd), /too many authors|snapshot size/);
  assert.throws(() => C.create({replica: "bob", snapshot: mine}), /edits by this replica|snapshot sequence/, "a joiner never adopts a counter for itself");
  assert.equal(b.stats().clock, 0); assert.deepEqual(b.vv(), {});
  // Too many authors over a session.
  const many = Array.from({length: C.LIMITS.authors + 1}, (_, i) => ({t: "meta", k: "k" + (i % 5), v: i, ts: {r: "w" + i, c: i + 1}, n: 1}));
  assert.throws(() => b.receive({ops: many}), /too many authors/);
}
{
  // Writers per register: at most LIMITS.writers contributions survive, the same ones on every replica.
  const base = fixture(), W = C.LIMITS.writers + 8;
  const ops = Array.from({length: W}, (_, i) => ({from: "w" + i, ops: [{t: "set", o: "v1", k: "x", v: i, ts: {r: "w" + i, c: 1 + (i * 7) % W}, n: 1}]}));
  const replicas = [0, 1, 2].map(k => C.create({replica: "obs" + k, project: base}));
  replicas[0].receive({ops: ops.flatMap(b => b.ops)});
  for (const b of shuffle(ops)) replicas[1].receive(clone(b), {author: b.from});
  for (const b of [...ops].reverse()) replicas[2].receive(clone(b), {author: b.from});
  const states = replicas.map(r => C.canon(r.snapshot().objs.find(o => o[0] === "v1")[4].find(([k]) => k === "x")[1]));
  assert.equal(states[0], states[1]); assert.equal(states[0], states[2]);
  assert.ok(JSON.parse(states[0]).writers.length <= C.LIMITS.writers, "the register keeps a bounded set of authors");
  assert.equal(new Set(replicas.map(r => item(r.project(), "v1").x)).size, 1);
}

{
  // A forged starting snapshot that claims a huge count for the host would silence the host's edits
  // (security review #4): a sequence number is never above the snapshot's Lamport clock.
  const base = fixture(), m = C.create({replica: "pMAL", project: base}), snap = clone(m.snapshot());
  snap.vv.push(["pHOST", 2 ** 40]);
  assert.throws(() => C.create({replica: "pGUEST", snapshot: snap}), /snapshot sequence/);
}
const nextMinor = version => {
  const [major, minor] = version.split(".").map(Number);
  return major + "." + (minor + 1);
};
{
  // The network replica owns peer-only objects, including data outside the current editor's projection.
  const base=fixture();
  base.formatVersion=nextMinor(AtriumFormat2.FORMAT);
  base.documents[1].items.push({id: "holo-1", kind: "hologram", x: 1, y: 2, glow: 3});
  base.documents.push({id: "doc-harness", kind: "harness", name: "Harness", items: [{id: "wire-h1", kind: "harnesswire", gauge: 22}]});
  const newer = C.create({replica: "pNEW", project: clone(base), validate: null});   // the newer build understands these kinds
  const older = C.create({replica: "pCUR", snapshot: clone(newer.snapshot())});      // this build
  const view = clone(older.project());
  assert.ok(!view.documents.some(d => d.id === "doc-harness") && !item(view, "holo-1"), "unknown objects are not shown");
  assert.equal(view.formatVersion, base.formatVersion);
  assert.ok(older.hiddenCount() >= 2,"the session retains the unseen object and document");
  // The older editor edits something it knows; nothing it cannot see is touched.
  item(view, "v1").x = 42; view.name = "Edited in the current format";
  const ops = older.commit(view);
  assert.deepEqual([...new Set(ops.ops.map(op => op.t))].sort(), ["meta", "set"]);
  assert.ok(!ops.ops.some(op => op.k === "atriumCompat"), "bookkeeping is never shared");
  newer.receive(clone(ops), {author: "pCUR"});
  const full = newer.project();
  assert.equal(item(full, "holo-1").glow, 3); assert.equal(full.documents.find(d => d.id === "doc-harness").items[0].gauge, 22);
  assert.equal(item(full, "v1").x, 42); assert.equal(full.name, "Edited in the current format");
  // A later peer edit survives another actual session snapshot and advances the replica clock.
  const n2 = clone(newer.project()); item(n2, "holo-1").glow = 9;
  older.receive(clone(newer.commit(n2)), {author: "pNEW"});
  const seen=older.project(), saved=C.create({replica:"pREJOIN",snapshot:clone(older.snapshot()),validate:null}).project();
  assert.equal(item(saved,"holo-1").glow,9,"the shared snapshot keeps the unseen peer change");
  assert.ok(saved.documents.some(d => d.id === "doc-harness"));
  assert.equal(older.commit(clone(seen)), null, "an unchanged view produces no operations");
}

{
  // N4: only the session's owner (the host) changes the format stamp; a guest's change is seen and
  // ignored the same way on every replica, so it can neither lock the host out nor mark the file newer.
  const base = fixture(), current = AtriumFormat2.FORMAT, future = nextMinor(current);
  base.formatVersion = current;
  const host = C.create({replica: "pH", project: clone(base), owner: "pH"});
  const guest = C.create({replica: "pG", snapshot: clone(host.snapshot()), owner: "pH"});
  const other = C.create({replica: "pO", snapshot: clone(host.snapshot()), owner: "pH"});
  const p = clone(guest.project()); p.formatVersion = "3.0"; p.name = "renamed by guest";
  const b = guest.commit(p);
  host.receive(clone(b), {author: "pG"}); other.receive(clone(b), {author: "pG"});
  for (const r of [host, guest, other]) {
    assert.equal(r.project().formatVersion, current, "the format stamp stays the host's");
    assert.equal(r.project().name, "renamed by guest", "the rest of the edit applies");
  }
  const hp = clone(host.project()); hp.formatVersion = future;
  guest.receive(clone(host.commit(hp)), {author: "pH"});
  assert.equal(guest.project().formatVersion, future, "the host may change it");
  // Set-aside objects can be counted and discarded (an edit like any other).
  const n = C.create({replica: "pN", project: (() => { const q = clone(base); q.formatVersion = future; q.documents[1].items.push({id: "odd", kind: "hologram"}); return q; })(), validate: null});
  const viewer = C.create({replica: "pV", snapshot: clone(n.snapshot())});
  assert.equal(viewer.hiddenCount(), 1);
  const gone = viewer.discardHidden();
  n.receive(clone(gone), {author: "pV"});
  assert.ok(!n.project().documents[1].items.some(i => i.id === "odd"), "discarding removes them for everyone");
  assert.equal(viewer.hiddenCount(), 0);
}
{
  // N3: a rejoin in the same window keeps its replica id; a snapshot may show the edits it made before.
  const base = fixture(), host = C.create({replica: "pH", project: clone(base)}), me = C.create({replica: "pR", snapshot: clone(host.snapshot())});
  const p = clone(me.project()); p.name = "mine"; host.receive(clone(me.commit(p)), {author: "pR"});
  const made = me.vv().pR;
  assert.throws(() => C.create({replica: "pR", snapshot: clone(host.snapshot())}), /edits by this replica/);
  const again = C.create({replica: "pR", snapshot: clone(host.snapshot()), ownSeq: made});
  const q = clone(again.project()); q.name = "mine again";
  const next = again.commit(q);
  assert.equal(next.ops[0].n, made + 1, "the sequence continues");
  host.receive(clone(next), {author: "pR"});
  assert.equal(host.project().name, "mine again");
}

console.log("collab-crdt: ok");
