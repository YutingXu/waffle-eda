"use strict";
// node scripts/bench-collab-edits.cjs [imported.waffle]
// WAFFLE_BENCH_ROOT may select a second checkout for an identical before/after run.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const root = process.env.WAFFLE_BENCH_ROOT || path.resolve(__dirname, "..");
for (const name of ["core/model", "library/parts", "history/undo-store", "project/collab-crdt"]) require(path.join(root, "app", name + ".js"));
const A = Atrium, C = AtriumCollabCRDT, U = AtriumUndoStore;
function load() {
  if (process.argv[2]) return A.validate(JSON.parse(fs.readFileSync(process.argv[2], "utf8")));
  require(path.join(root, "tests/pcb/dense-board.js"));
  const p = A.project("Dense", AtriumParts.catalogue);
  p.documents[1] = makeAtriumBenchmarkBoard().d;
  return A.validate(p);
}
const template = load();
function session() {
  U.reset();
  const local = A.clone(template), remote = A.clone(template);
  U.mark(local);
  return {local, remote, a: C.create({replica: "a", project: local}), b: C.create({replica: "b", project: remote}),
    cursor: U.itemEdits?.(local)?.cursor, doc: local.documents.find(d => d.kind === "pcb" && d.items.some(i => i.kind === "via"))};
}
const times = {}, counts = {};
function sample(name, count, f) {
  if (count) {
    const stringify = JSON.stringify;
    let calls = 0, bytes = 0;
    JSON.stringify = function (...args) { const s = stringify.apply(this, args); calls++; if (s) bytes += Buffer.byteLength(s); return s; };
    try { return f(); }
    finally { JSON.stringify = stringify; counts[name] = {calls, utf8Bytes: bytes}; }
  }
  const t = performance.now(), r = f();
  (times[name] ||= []).push(performance.now() - t);
  return r;
}
function edit(s, phase, count = false) {
  const via = s.doc.items.find(i => i.kind === "via"), unrelated = s.doc.items.find(i => i.id !== via.id).id;
  via.x += .05;
  sample(phase + "Journal", count, () => U.record(s.local, {doc: s.doc, items: [via]}));
  const locks = new Set([unrelated]);
  const check = ops => { assert.ok(ops.every(op => !locks.has(op.o))); return false; };
  const batch = sample(phase + "LocalWithLock", count, () => {
    const changes = U.itemEdits?.(s.local, s.cursor, true);
    if (!U.itemEdits) check(s.a.diff(s.local)); // original live soft-lock path
    const result = s.a.commit(s.local, {updates: changes?.updates, reconcile: check});
    s.cursor = changes?.cursor;
    return result;
  });
  assert.equal(batch.ops.length, 1); assert.equal(batch.ops[0].o, via.id); assert.equal(batch.ops[0].v, via.x);
  const sheet = s.remote.documents.find(d => d.kind === "schematic"), keep = sheet.items;
  sample(phase + "ReceiveAndPatch", count, () => {
    const res = s.b.receive(batch, {author: "a"});
    s.b.patch(s.remote, res.touched);
  });
  assert.equal(s.remote.documents.find(d => d.id === s.doc.id).items.find(i => i.id === via.id).x, via.x);
  assert.deepEqual(s.a.vv(), s.b.vv());
  return keep === sheet.items;
}
function quantiles(xs) {
  xs.sort((a, b) => a - b);
  const at = p => +xs[Math.ceil(xs.length * p) - 1].toFixed(3);
  return {n: xs.length, p50: at(.5), p95: at(.95)};
}
for (let i = 0; i < 8; i++) edit(session(), "cold");
const s = session();
edit(s, "first");
for (let i = 0; i < 32; i++) edit(s, "warm");
const sameArray = edit(s, "work", true);
assert.deepEqual(s.a.raw(), s.b.raw());
assert.deepEqual(s.a.raw(), s.remote);
const undo = s.a.undo();
s.b.patch(s.remote, s.b.receive(undo, {author: "a"}).touched);
const redo = s.a.redo();
s.b.patch(s.remote, s.b.receive(redo, {author: "a"}).touched);
assert.deepEqual(s.a.raw(), s.remote);
console.log(JSON.stringify({node: process.version, objects: template.documents.reduce((n, d) => n + d.items.length, 0),
  ms: Object.fromEntries(Object.entries(times).filter(([k]) => !k.startsWith("first")).map(([k, t]) => [k, quantiles(t)])),
  stringify: counts, untouchedSheetArrayRetained: sameArray}, null, 2));
