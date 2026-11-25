"use strict";
// Undo store touched sets and content hashes (app/history/undo-store.js). Random edit sequences on a board
// and on a multi-sheet hierarchical project, each edit recorded from the items it reports (hinted),
// with a few unhinted edits and derived changes mixed in; then undo all the way back must give the
// original bytes, redo all the way forward the final bytes, and random jumps each step's bytes.
// Verification runs in "throw" mode: every hinted sync is followed by a full comparison that must
// find nothing more, and every undo/redo checks the restored root hash (Merkle, chunked by order)
// against the state's. Also: an incomplete hint is caught and still recorded; the hinted record
// costs O(changed) on the 25.6k-object board.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh undo-touched).
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "connectivity", "sch-objects", "hierarchy", "multichannel", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../schematic/sch-bench-project.js"); require("../pcb/dense-board.js");
const U = AtriumUndoStore;
globalThis.ATRIUM_UNDO_VERIFY = "throw";
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const json = x => JSON.stringify(x);
const clock = () => globalThis.performance.now();
let seed = 1;
const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return Math.floor(seed / 2147483648 * n); };

// The editor's use of the store: mark before, checkpoint, record with the touched set.
function editor(project) {
  U.reset();
  const history = [], future = [];
  const mark = () => U.mark(project, {current: "x"});
  U.mark(project, {}); U.prime();
  return {history, future, get project() { return project; },
    edit(fn, hint) { const before = mark(); fn(); U.checkpoint(history, future, before, "e"); U.record(project, hint); },
    derive(fn) { fn(); U.touch(project); U.sync(); },
    go(n) { const here = mark(), t = U.jump(history, future, here, n); if (!t) return null; project = U.root(); U.touch(project); return t; }};
}

// One random edit: what it does and the hint it reports (undefined: unhinted, a full comparison).
function randomEdit(E, docs) {
  const p = E.project, d = docs()[rnd(docs().length)], items = d.items, it = items[rnd(items.length)], k = rnd(14);
  if (!it || k === 0) return E.edit(() => items.push({id: "n" + seed, kind: "via", x: rnd(100), y: rnd(100), net: "N" + rnd(9)}), {doc: d, items: []});
  if (k === 1) return E.edit(() => { d.items = items.filter(i => i !== it); }, {doc: d, items: []});
  if (k === 2) return E.edit(() => items.splice(rnd(items.length), 1), {doc: d, items: []});
  if (k === 3) { const others = [0, 1, 2].map(() => items[rnd(items.length)]); return E.edit(() => { for (const o of others) o.x = (o.x || 0) + 1; it.flag = !it.flag; }, {doc: d, items: [it, ...others]}); }
  if (k === 4) return E.edit(() => { if (it.points) it.points[0][0] += 0.5; else it.y = (it.y || 0) - 0.25; }, {doc: d, items: [it]});
  if (k === 5) return E.edit(() => { delete it.net; it.note = "n" + rnd(5); }, {doc: d, items: [it]});
  if (k === 6) { const d2 = docs()[rnd(docs().length)], o = d2.items[rnd(d2.items.length)]; return E.edit(() => { it.x = (it.x || 0) + 2; if (o) o.x = (o.x || 0) - 2; }, [{doc: d, items: [it]}, {doc: d2, items: o ? [o] : []}]); }
  if (k === 7) return E.edit(() => { const def = p.library[rnd(p.library.length)]; def.note = "lib" + rnd(9); }, {library: true, doc: d, items: []});
  if (k === 8) return E.edit(() => { d.grid = [0.25, 0.5, 1.27][rnd(3)]; }, {doc: d, items: []});   // a document key: compared regardless
  if (k === 9) return E.edit(() => { it.x = (it.x || 0) + 3; d.items = [...d.items.slice(1), d.items[0]]; }, {doc: d, items: [it]});   // reorder
  if (k === 10) return E.edit(() => { p.parameters = {...(p.parameters || {}), Rev: "r" + rnd(9)}; });   // unhinted
  if (k === 11) return E.derive(() => { it.derived = rnd(9); });   // a derived change in place (unhinted, no step)
  if (k === 12) return E.edit(() => { const j = rnd(items.length); items[j] = {...items[j], id: "r" + seed}; }, {doc: d, items: []});   // replaced element
  return E.edit(() => { it.x = (it.x || 0) + 1; it.extra = {deep: [rnd(5), {k: rnd(3)}]}; }, {doc: d, items: [it]});
}

function exact(name, project, docs, steps) {
  const E = editor(project), states = [json(project)];
  for (let s = 0; s < steps; s++) {
    randomEdit(E, docs);
    states.length = E.history.length + 1; states[E.history.length] = json(E.project);
    // An occasional undo or redo mid-sequence (the next edit then forks a branch).
    if (s % 17 === 16) { E.go(-1); assert.equal(json(E.project), states[E.history.length], name + ": undo mid-sequence"); }
  }
  const last = json(E.project), n = E.history.length;
  while (E.go(-1)) assert.equal(json(E.project), states[E.history.length], name + ": undo to step " + E.history.length);
  assert.equal(json(E.project), states[0], name + ": undo all the way back gives the original bytes");
  while (E.go(1)) assert.equal(json(E.project), states[E.history.length], name + ": redo to step " + E.history.length);
  assert.equal(E.history.length, n); assert.equal(json(E.project), last, name + ": redo all the way gives the final bytes");
  for (let j = 0; j < 30; j++) {
    const to = rnd(n + 1), d = to - E.history.length;
    if (d) E.go(d);
    assert.equal(json(E.project), states[to], name + ": jump to step " + to);
  }
  const st = U.stats();
  assert.equal(st.missed, 0, name + ": every hint was complete"); assert.equal(st.mismatch, 0);
  assert.ok(st.scoped > steps / 2 && st.verified > n, name + ": hinted syncs " + st.scoped + ", hash checks " + st.verified);
  return st;
}

test("board: random hinted edits, undo/redo all the way and jumps reproduce every state's bytes", () => {
  const p = Atrium.project("Board", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
  const {d} = makeAtriumBenchmarkBoard(40); p.documents = p.documents.map(x => x === old ? d : x);
  d.pcbDrawing = {pours: [{polygon: "g", net: "GND", layer: "Top", bounds: [0, 0, 5, 5], count: 1, data: "A".repeat(9000)}]};
  seed = 11;
  exact("board", p, () => p.documents.filter(x => x.kind === "pcb"), 400);
});

test("multi-sheet project: random hinted edits across sheets reproduce every state's bytes", () => {
  const {project} = makeAtriumSchBenchProject({sheets: 6, cells: 4, channels: 2});
  seed = 23;
  const st = exact("sheets", project, () => project.documents.filter(x => x.kind === "schematic"), 400);
  assert.ok(st.records > 0);
});

test("an incomplete hint is caught by verification and still recorded", () => {
  const p = Atrium.project("Board", AtriumParts.catalogue), d = p.documents.find(x => x.kind === "pcb");
  d.items.push({id: "a", kind: "via", x: 1, y: 1}, {id: "b", kind: "via", x: 2, y: 2});
  const E = editor(p), before = json(p);
  assert.throws(() => E.edit(() => { d.items[0].x = 5; d.items[1].x = 6; }, {doc: d, items: [d.items[0]]}), /did not report/);
  assert.equal(U.stats().missed, 1);
  E.go(-1);
  assert.equal(json(E.project), before, "the unreported change is still undone");
  globalThis.ATRIUM_UNDO_VERIFY = false;
  E.edit(() => { d.items[1].y = 9; }, {doc: d, items: []});   // without verification it is not seen until a full sync
  assert.equal(U.stats().missed, 1, "nothing more counted");
  U.touch(p); U.sync();   // the fallback: a full comparison records it
  assert.equal(U.stats().missed, 1); assert.equal(d.items[1].y, 9);
  globalThis.ATRIUM_UNDO_VERIFY = "throw";
});

test("the hash check detects a restored state that differs", () => {
  const p = Atrium.project("Board", AtriumParts.catalogue), d = p.documents.find(x => x.kind === "pcb");
  d.items.push({id: "a", kind: "via", x: 1, y: 1});
  const E = editor(p);
  E.edit(() => { d.items[0].x = 2; }, {doc: d, items: [d.items[0]]});
  E.history[0].hash += 1;   // as if the log had lost a record
  assert.throws(() => E.go(-1), /differs from the saved state/);
  assert.equal(U.stats().mismatch, 1);
});

test("25.6k board: a hinted record is O(changed), the full comparison is not", () => {
  const p = Atrium.project("Dense", AtriumParts.catalogue), old = p.documents.find(x => x.kind === "pcb");
  const {d} = makeAtriumBenchmarkBoard(); p.documents = p.documents.map(x => x === old ? d : x);
  globalThis.ATRIUM_UNDO_VERIFY = false;
  const E = editor(p), parts = d.items.filter(i => i.kind === "part"), full = [], hint = [], undo = [];
  const med = a => a.slice().sort((x, y) => x - y)[a.length >> 1];
  for (let k = 0; k < 20; k++) {
    const it = parts[k * 13];
    for (const mode of ["full", "hint"]) {
      const before = U.mark(p, {}); it.x += 0.5;
      U.checkpoint(E.history, E.future, before, "move");
      const t = clock(); U.record(p, mode === "hint" ? {doc: d, items: [it]} : undefined); (mode === "hint" ? hint : full).push(clock() - t);
    }
    const t = clock(); E.go(-1); undo.push(clock() - t);
  }
  assert.equal(U.stats().mismatch, 0); assert.ok(U.stats().verified >= 20);
  console.log("25.6k board: record full " + med(full).toFixed(3) + " ms, hinted " + med(hint).toFixed(3) + " ms, undo with hash check " + med(undo).toFixed(3) + " ms");
  assert.ok(med(hint) < 1, "hinted record " + med(hint));
  assert.ok(med(hint) * 10 < med(full), "hinted " + med(hint) + " vs full " + med(full));
  globalThis.ATRIUM_UNDO_VERIFY = "throw";
});

console.log(passed + " undo touched-set tests passed");
