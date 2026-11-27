"use strict";
// Differential test of the live session's scoped paths (app/project/collab-crdt.js) against the
// complete ones they replace, seeded and reproducible:
//   * receive side: a replica that brings its view up to date for the touched objects only
//     (refresh, Atrium.validate's scoped mode) and patches its editor with the scoped plan,
//     against a replica that materialises and validates the whole project on every change
//     ({incremental: false}) and patches with the complete list synchronisation ({full: true}).
//     Both receive the same batches, in a random order with duplicates: the valid edits of an
//     editor, the model-invalid but well-shaped edits of a forger (dangling part definitions,
//     ids that re-parent a document or definition, a removed hatched track, a document whose
//     kind changes, an atriumCompat stamp, items a document kind does not allow, a library
//     definition without the geometry its parts need, ...) and hostile copies (prototype keys,
//     bad ids, clocks, shapes). After every delivery they accept or reject alike (same error),
//     hold the same project and set the same objects aside, and their editors are equal.
//   * commit side: an editor whose edits are published from the Undo journal (in place and
//     structural: AtriumUndoStore.itemEdits {updates, structure}) against a copy of its replica
//     that publishes the same edit with the complete diff: the same project, and the same
//     operations (stamps included) apart from moves, whose keys may differ.
//     The editor is patched with each commit's `related`, as collab-presence.js does; a commit
//     that makes the whole valid again names the set-aside objects it brings back there, so the
//     author's replica and editor agree before every edit (seed 276 once found them apart).
//   node tests/project/collab-scoped-equivalence.cjs [--seeds 1-200] [--steps 160] [--verbose]
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/formats/format-2-codec.js");
require("../../app/history/undo-store.js");
require("../../app/project/collab-crdt.js");
const A = globalThis.Atrium, C = globalThis.AtriumCollabCRDT, U = globalThis.AtriumUndoStore;

const argv = process.argv.slice(2), arg = (name, d) => { const i = argv.indexOf("--" + name); return i >= 0 ? argv[i + 1] : d; };
const seeds = arg("seeds", "1-60").split(",").flatMap(s => { const [a, b] = s.split("-").map(Number); return b ? Array.from({length: b - a + 1}, (_, i) => a + i) : [a]; });
const STEPS = +arg("steps", 160), verbose = argv.includes("--verbose");
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
let rand = Math.random;
const pick = list => list[Math.floor(rand() * list.length)], int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
const clone = v => JSON.parse(JSON.stringify(v));
let uid = 0; const nid = p => p + "-" + (++uid);

function fixture() {
  const def = {id: "def-r", name: "Resistor", prefix: "R",
    symbol: {shapes: [{kind: "path", points: [[-2, 0], [2, 0]]}], pins: [{x: -3, y: 0, number: "1"}, {x: 3, y: 0, number: "2"}]},
    footprint: {shapes: [], pads: [{x: -1, y: 0, w: .8, h: .9, number: "1"}, {x: 1, y: 0, w: .8, h: .9, number: "2"}]}};
  const sym = {id: "def-s", name: "Symbol only", prefix: "U", symbol: {shapes: [], pins: [{x: 0, y: 0, number: "1"}]}};
  const p = A.project("Equivalence", [def, sym]);
  const [sch, pcb] = p.documents;
  sch.id = "doc-sch"; pcb.id = "doc-pcb";
  for (let i = 0; i < 8; i++) {
    sch.items.push({id: "w" + i, kind: "wire", points: [[i * 5, 0], [i * 5 + 4, 0]]});
    pcb.items.push({id: "t" + i, kind: "track", points: [[i, 0], [i + 3, 0]], width: .25, layer: "Top", net: "N" + i});
    pcb.items.push({id: "v" + i, kind: "via", x: i, y: 5, diameter: .6});
  }
  sch.items.push({id: "p0", kind: "part", def: "def-r", ref: "R1", value: "10k", x: 10, y: 10, angle: 0});
  sch.items.push({id: "u0", kind: "part", def: "def-s", ref: "U1", value: "x", x: 20, y: 10, angle: 0});
  pcb.items.push({id: "pb0", kind: "part", def: "def-r", ref: "R1", value: "10k", x: 5, y: 8, angle: 0});
  // A board whose imported hatch needs a hatched track (a document-level rule over its items).
  p.documents.push({id: "doc-hatch", kind: "pcb", name: "Hatched", grid: .5, outline: [], notes: [],
    pcbDrawing: {annotations: {}, sourceFill: true, sourceHatchSignature: "0123456789abcdef"},
    items: [{id: "hp", kind: "polygon", points: [[0, 0], [4, 0], [4, 4]], layer: "Top", net: "GND"},
      {id: "ht", kind: "track", points: [[0, 0], [1, 1]], width: .2, layer: "Top", sourcePour: "hp"},
      {id: "hv", kind: "via", x: 1, y: 1, diameter: .5}]});
  A.validate(clone(p));
  return p;
}
const boards = p => p.documents.filter(d => d.kind === "pcb" || d.kind === "schematic");
const itemsOf = p => boards(p).flatMap(d => d.items.map(it => ({d, it})));

// ---- an editor's valid edits, in place on its project (what the Undo journal records) ----
function editorEdit(p) {
  const docs = boards(p), d = pick(docs), r = rand();
  if (!d) return null;
  const fresh = () => d.kind === "pcb" ? {id: nid("ev"), kind: "via", x: int(0, 30), y: int(0, 30), diameter: .5}
    : {id: nid("ew"), kind: "wire", points: [[int(0, 9), 0], [int(10, 20), 1]]};
  if (r < .3 && d.items.length) {
    const it = pick(d.items);
    if (Array.isArray(it.points)) it.points = it.points.map(([x, y]) => [x + 1, y]);
    else if ("x" in it) it.x += 1; else return null;
    return "in-place";
  }
  if (r < .45) { d.items.splice(int(0, d.items.length), 0, fresh()); return "add"; }
  if (r < .55 && d.items.length > 4 && d.id !== "doc-hatch") { d.items.splice(int(0, d.items.length - 1), 1); return "delete"; }
  if (r < .65) { d.items.splice(int(0, d.items.length), 0, ...Array.from({length: int(2, 30)}, fresh)); return "paste"; }
  if (r < .72 && d.items.length > 8 && d.id !== "doc-hatch") { const n = int(2, 6); d.items.splice(int(0, d.items.length - n), n); return "delete-block"; }
  if (r < .8 && d.items.length > 2) { const [it] = d.items.splice(int(0, d.items.length - 1), 1); d.items.splice(int(0, d.items.length), 0, it); return "reorder"; }
  if (r < .86 && d.items.length > 2) {   // two edits in one publication: an add and an in-place move
    d.items.push(fresh()); const it = pick(d.items); if ("x" in it) it.x -= 1; return "mixed";
  }
  if (r < .91) {   // moved to the other document of the same kind, or not moved
    const other = docs.find(o => o !== d && o.kind === d.kind && o.id !== "doc-hatch" && d.id !== "doc-hatch");
    const it = d.items.find(i => i.kind !== "part");
    if (!other || !it) return null;
    d.items.splice(d.items.indexOf(it), 1); other.items.splice(int(0, other.items.length), 0, it); return "move-doc";
  }
  if (r < .95) { p.name = "Project " + int(1, 99); return "meta"; }
  d.name = "Doc " + int(1, 99); return "rename";
}

// ---- a forger's edits: well-shaped operations whose result need not be a valid model ----
function forgedEdit(p) {
  if (!p.documents.length) { p.documents.push({id: nid("doc"), kind: "schematic", name: "Sheet", grid: 1.27, items: [], outline: [], notes: []}); return; }
  const docs = boards(p), all = itemsOf(p), r = rand();
  const d = pick(docs) || p.documents[0], some = all.length ? pick(all) : null;
  const add = it => d.items.splice(int(0, d.items.length), 0, it);
  const cases = [
    () => { if (some?.it.kind === "via") some.it.diameter = pick([-1, 0, "x", .7]); else if (some) some.it.x = pick([1, "q", null]); },
    () => add({id: nid("bogus"), kind: "bogus", x: 1, y: 1}),
    () => add({id: nid("short"), kind: "track", points: [[0, 0]], width: .2, layer: "Top"}),
    () => add({id: nid("dangle"), kind: "part", def: pick(["missing", "def-r", "def-s"]), ref: "X1", value: "v", x: 1, y: 1, angle: 0}),
    () => { const i = p.library.findIndex(x => x.id === pick(["def-r", "def-s"])); if (i >= 0) p.library.splice(i, 1); },
    () => { const def = p.library.find(x => x.id === "def-r"); if (def) delete def[pick(["symbol", "footprint"])]; },
    () => { const def = p.library.find(x => x.id === "def-s"); if (def) def.footprint = {shapes: [], pads: []}; },
    () => { const h = p.documents.find(x => x.id === "doc-hatch"); if (h) { const t = h.items.findIndex(i => i.id === "ht"); if (t >= 0 && rand() < .5) h.items.splice(t, 1); else h.items.find(i => i.id === "ht" && (i.sourcePour = pick(["hp", "nope"]))); } },
    () => { const h = p.documents.find(x => x.id === "doc-hatch"); if (h) h.items.push({id: nid("hx"), kind: "via", x: 2, y: 2, diameter: .4}); },
    () => { const doc = pick(p.documents); doc.kind = pick(["drawing", "pcb", "schematic", "panel"]); },
    () => { p.name = pick(["Renamed", 5, ""]); },
    () => { p.atriumCompat = {newer: true}; },
    () => { delete p.atriumCompat; },
    () => { const target = pick([...p.documents.map(x => x.id), ...p.library.map(x => x.id)]); add({id: target, kind: "via", x: 1, y: 1, diameter: .5}); },
    () => { if (some && d !== some.d) { some.d.items.splice(some.d.items.indexOf(some.it), 1); add(some.it); } },
    () => add({id: nid("frame"), kind: "textframe", role: "frame", x: 0, y: 0, w: 10, h: 10, text: "t"}),
    () => { if (some) { some.d.items.splice(some.d.items.indexOf(some.it), 1); } },
    () => {   // repairs, so that the shared project is often valid as a whole again
      p.name = "Repaired"; delete p.atriumCompat;
      const original = fixture();
      for (const def of original.library) if (!p.library.some(x => x.id === def.id)) p.library.push(def);
      for (const doc of p.documents) { const o = original.documents.find(x => x.id === doc.id); if (o) doc.kind = o.kind; }
      for (const doc of p.documents) doc.items = doc.items.filter(i => { try { A.validate({...clone(original), documents: [{...clone(doc), items: [clone(i)]}]}); return true; } catch { return false; } });
      const h = p.documents.find(x => x.id === "doc-hatch");
      if (h && !h.items.some(i => i.id === "ht")) h.items.push({id: "ht", kind: "track", points: [[0, 0], [1, 1]], width: .2, layer: "Top", sourcePour: "hp"});
    }
  ];
  if (rand() < .6) editorEdit(p); else pick(cases)();
}
// Hostile copies of a valid batch: each must be rejected whole by both replicas alike.
function hostile(b) {
  const h = clone(b), op = pick(h.ops), r = rand();
  if (r < .15) op.v = JSON.parse('{"__proto__": {"polluted": 1}}');
  else if (r < .3) op.o = "bad id with spaces";
  else if (r < .4) op.ts.c = 2 ** 60;
  else if (r < .5) op.t = "teleport";
  else if (r < .6) op.f = JSON.parse('{"constructor": 1}');
  else if (r < .7) { op.ts.r = "mallory"; }
  else if (r < .8) op.n = -1;
  else if (r < .9) h.ops = "nope";
  else op.k = "__proto__";
  return h;
}

// Ids of the library definitions, documents and items a project shows.
const shownIds = p => new Set([...(p.library || []), ...(p.documents || []).flatMap(d => [d, ...(d.items || [])])].map(o => o.id));
const totals = {refreshed: 0, rebuilt: 0, batches: 0, rejected: 0, scopedCommits: 0, structural: 0, sameOps: 0, differentOps: 0, hiddenStates: 0, fallbackCommits: 0};
function run(seed) {
  rand = rng(seed); uid = 0;
  const base = fixture();
  const author = C.create({replica: "a", project: base}), forger = C.create({replica: "m", project: base});
  const S = C.create({replica: "s", project: base}), F = C.create({replica: "f", project: base, incremental: false});
  const editor = clone(base), tS = clone(base), tF = clone(base);
  U.reset(); U.mark(editor);
  let cursor = U.itemEdits(editor).cursor;
  const sent = [], trace = [];
  const fail = msg => assert.fail(msg + " (seed " + seed + ")\n  reproduce: node tests/project/collab-scoped-equivalence.cjs --seeds " + seed + " --verbose" +
    (verbose ? "\n" + trace.slice(-25).join("\n") : ""));
  function deliver(b, author) {
    let a, e1, e2, b1, b2;
    try { a = S.receive(clone(b), {author}); } catch (e) { e1 = e.message; }
    try { b1 = F.receive(clone(b), {author}); } catch (e) { e2 = e.message; }
    if (e1 !== e2) fail("scoped and full replicas disagree on accepting a batch: " + e1 + " / " + e2);
    totals.batches++;
    if (e1) { totals.rejected++; return; }
    b2 = a;
    S.preparePatch(tS, b2.touched).apply();
    F.patch(tF, b1.touched, undefined, {full: true});
    const ps = C.canon(S.project()), pf = C.canon(F.project());
    if (ps !== pf) fail("the scoped view differs from the complete materialisation");
    if (S.hiddenCount() !== F.hiddenCount()) fail("different objects set aside: " + S.hiddenCount() + " / " + F.hiddenCount());
    if (S.hiddenCount()) totals.hiddenStates++;
    if (C.canon(tS) !== C.canon(tF)) fail("the scoped patch plan leaves a different editor project than the complete synchronisation");
    if (C.canon(tS) !== ps) fail("the patched editor differs from its replica");
  }
  for (let step = 0; step < STEPS; step++) {
    const r = rand();
    if (r < .45) {
      // The author edits its editor project; the journal publishes it.
      // The author's replica and editor agree before every edit (a full diff of the editor, as the
      // audit at save makes, would otherwise publish their differences).
      if (C.canon(author.project()) !== C.canon(editor)) {
        const view = author.project(), held = shownIds(editor), shown = shownIds(view);
        fail("the author's replica and editor disagree before an edit (only in the replica " + JSON.stringify([...shown].filter(id => !held.has(id)).slice(0, 8)) +
          ", only in the editor " + JSON.stringify([...held].filter(id => !shown.has(id)).slice(0, 8)) + ")");
      }
      const kind = editorEdit(editor);
      if (!kind) continue;
      // (The forger can leave the shared project invalid as a whole; the author edits it anyway.)
      U.record(editor);
      const range = U.itemEdits(editor, cursor, true);
      const reference = C.create({replica: "a", snapshot: author.snapshot(), resume: true});
      reference.hiddenCount();   // its view, as the author has one: set-aside objects are not diffed
      if (C.canon(reference.project()) !== C.canon(author.project())) fail("a replica's snapshot materialises differently from the replica");
      const full = reference.commit(clone(editor));
      const b = author.commit(editor, {updates: range.updates, structure: range.structure});
      // As collab-presence.js commitNow: the editor takes the commit's related objects (dependencies,
      // and set-aside objects the commit brought back).
      if (b?.related?.length) { author.preparePatch(editor, b.related).apply(); U.record(editor); }
      cursor = U.itemEdits(editor, null, true).cursor;
      if (range.updates) totals.scopedCommits++; else totals.fallbackCommits++;
      if (range.structure?.length) totals.structural++;
      if (C.canon(author.project()) !== C.canon(reference.project())) fail("a scoped commit (" + kind + ") materialises differently from the complete diff");
      if (!author.hiddenCount() && C.canon(author.project()) !== C.canon(editor)) {
        const x = author.project(), keys = new Set([...Object.keys(x), ...Object.keys(editor)]);
        fail("the author's replica differs from its editor after " + kind + ": " + [...keys].filter(k => C.canon(x[k]) !== C.canon(editor[k])).join(", "));
      }
      if (C.canon(b) === C.canon(full)) totals.sameOps++; else {
        totals.differentOps++;
        if (!["reorder", "move-doc", "mixed"].includes(kind)) fail("a scoped " + kind + " stamps other operations than the complete diff");
      }
      trace.push(step + " author " + kind + " " + (b?.ops.length || 0) + " ops");
      if (b) sent.push([b, "a"]);
    } else if (r < .7) {
      const p = forger.project();
      forgedEdit(p);
      // Discard Set-Aside Objects (the host's repair) now and then.
      const b = rand() < .15 && forger.hiddenCount() ? forger.discardHidden() :
        rand() < .1 && forger.canUndo() ? forger.undo() : rand() < .05 && forger.canRedo() ? forger.redo() : forger.commit(p);
      trace.push(step + " forger " + (b?.ops.length || 0) + " ops");
      if (b) { if (rand() < .3) sent.push([hostile(b), "m"]); sent.push([b, "m"]); }
    } else if (r < .78 && author.canUndo()) {
      const b = rand() < .8 ? author.undo() : author.redo();
      if (b) {
        author.preparePatch(editor, author.touches(b)).apply(); U.record(editor); cursor = U.itemEdits(editor, null, true).cursor; sent.push([b, "a"]); trace.push(step + " author undo/redo");
        if (C.canon(author.project()) !== C.canon(editor)) fail("the author's editor differs from its replica after undo or redo");
      }
    }
    // Deliver some of what is queued, in random order, sometimes twice; the author and forger see each other.
    while (sent.length && rand() < .7) {
      const [b, who] = sent.splice(int(0, sent.length - 1), 1)[0];
      deliver(b, who);
      if (rand() < .05) deliver(b, who);
      try {
        const other = who === "a" ? forger : author, res = other.receive(clone(b), {author: who});
        if (other === author) {
          author.preparePatch(editor, res.touched).apply(); U.record(editor); cursor = U.itemEdits(editor, null, true).cursor;
          if (C.canon(author.project()) !== C.canon(editor)) fail("the author's editor differs from its replica after a patch");
        }
      } catch { /* hostile copies */ }
    }
  }
  for (const [b, who] of sent) deliver(b, who);
  totals.refreshed += S.stats().refreshed; totals.rebuilt += S.stats().rebuilt;
}

const failures = [];
for (const seed of seeds) {
  try { run(seed); } catch (e) { failures.push(seed + ": " + e.message.split("\n").slice(0, verbose ? 40 : 2).join("\n    ")); if (seeds.length === 1) { console.error(verbose ? e.stack : e.message); process.exit(1); } }
}
U.reset();
if (failures.length) { console.error("collab-scoped-equivalence: " + failures.length + " of " + seeds.length + " seeds failed:\n  " + failures.join("\n  ")); process.exit(1); }
assert.ok(totals.rejected && totals.hiddenStates && totals.structural && totals.refreshed > totals.batches / 4, "the run covered rejected batches, set-aside objects, structural commits and scoped refreshes");
console.log("collab-scoped-equivalence: ok (" + seeds.length + " seeds, " + STEPS + " steps; " + Object.entries(totals).map(([k, v]) => k + " " + v).join(", ") + ")");
