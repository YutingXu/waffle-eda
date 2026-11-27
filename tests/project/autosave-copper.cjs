"use strict";
// Recovery drafts of a board whose poured copper the pour engine holds as runs (AtriumPCBPours):
// autosave writes an island's runs once and refers to them afterwards (save-cache.js records), and every
// draft reads back as exactly the text of the project (AtriumECO.serialize). Also: a draft written as
// text chunks (every build before runs, and this one for regions held as text) still reads back.
//   node tests/project/autosave-copper.cjs                 the checks
//   node tests/project/autosave-copper.cjs --dump f.json   write a draft store (text chunks) to a file
//   node tests/project/autosave-copper.cjs --read f.json   read a stored draft store back (another build's)
const assert = require("node:assert/strict");
const fs = require("node:fs");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const P = require("../support/app-source-paths.cjs");
for (const m of ["model", "net-ties", "parts", "nav-common", "spatial", "board-shape", "stackup", "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "net-intent", "signals",
  "rules", "viastack", "polygon-pour", "eco", "save-cache", "autosave"]) require(P.appFile(m + ".js"));
require("../pcb/dense-board.js");
const A = Atrium, ECO = AtriumECO, SC = AtriumSaveCache, PP = AtriumPolygonPour, C = AtriumPCBPours;
const arg = n => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : null; };

// An IndexedDB with structured clone (typed arrays survive), counting what each write puts.
function fakeIDB(seed) {
  const data = seed || new Map(), f = {data, bytes: 0};
  const later = fn => setTimeout(fn, 0);
  const size = v => v.text?.length ?? v.run?.bytes?.byteLength ?? JSON.stringify(v).length;
  const db = {objectStoreNames: {contains: n => data.has(n)},
    createObjectStore(n, {keyPath}) { const m = new Map(); m.keyPath = keyPath; data.set(n, m); },
    transaction() {
      const t = {error: null}, ops = [];
      t.abort = () => {};
      t.objectStore = n => {
        const st = data.get(n), req = fn => { const r = {}; ops.push(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
        return {put(v) { if (n === "data") f.bytes += size(v); return req(() => { st.set(v[st.keyPath], structuredClone(v)); }); },
          get: k => req(() => structuredClone(st.get(k))), getAll: () => req(() => [...st.values()].map(x => structuredClone(x))), getAllKeys: () => req(() => [...st.keys()]), delete: k => req(() => { st.delete(k); })};
      };
      later(() => later(() => { for (const op of ops) op(); t.oncomplete?.(); }));
      return t;
    }};
  f.open = () => { const r = {}; later(() => { r.result = db; if (!data.size) r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; };
  return f;
}
function lsFake() { const m = new Map(); return {getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)}; }
function board() {
  const {d, defs} = makeAtriumBenchmarkBoard(40);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++; }
  const w = d.outline[1][0], h = d.outline[2][1], rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
  [["Top", "GND", rect(1, 1, w / 2, h - 1)], ["Bottom", "VCC", rect(1, 1, w - 1, h - 1)]].forEach(([layer, net, o], j) => d.items.push({...PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: false}), id: "poly" + j}));
  const p = A.project("Drafts"); p.documents = [d]; p.library = [...defs.values()];
  PP.apply(d, defs, {project: p});
  return {p, d, defs};
}
async function drafts(idb, p) {
  let clock = 1e12, rev = 1;
  const S = SC.create(), records = S.records;
  if (process.env.DEBUG_RECORDS) S.records = (...a) => { const r = records(...a); console.log("records", r.fresh.map(x => (x.text ? "text " + x.text.length + " " + x.text.slice(0, 1500).replace(/\s+/g, " ") : x.run ? "run " + x.run.bytes.byteLength : "copper " + x.runs.length)).join("\n  ")); return r; };
  const Au = AtriumAutosave.create({indexedDB: idb, localStorage: lsFake(), now: () => clock, schedule: cb => cb(), serializer: S, locks: null});
  const host = {p, project: () => host.p, isDirty: () => true, revision: () => rev, info() {}, registerAction() {}, async replaceProject(q) { host.p = q; return true; }};
  Au.attach(host); await Au.boot();
  return {Au, host, save: async () => { rev++; clock += 2 * 60000; const b = idb.bytes, m = await Au.save("auto", true); return {m, bytes: idb.bytes - b}; }};
}

(async () => {
  if (arg("--dump")) {
    const {p} = board(), idb = fakeIDB(), {save} = await drafts(idb, p);
    const {m} = await save();
    const store = {};
    for (const [n, st] of idb.data) store[n] = {keyPath: st.keyPath, rows: [...st.values()]};
    fs.writeFileSync(arg("--dump"), JSON.stringify({id: m.id, text: ECO.serialize(p), store}));
    console.log("wrote a draft store: " + m.keys.length + " chunks");
    return;
  }
  if (arg("--read")) {
    const saved = JSON.parse(fs.readFileSync(arg("--read"), "utf8")), data = new Map();
    for (const [n, {keyPath, rows}] of Object.entries(saved.store)) { const m = new Map(rows.map(r => [r[keyPath], r])); m.keyPath = keyPath; data.set(n, m); }
    const {Au} = await drafts(fakeIDB(data), A.project("Other"));
    const r = await Au.read(saved.id);
    assert.equal(r.text, saved.text, "a draft another build wrote reads back as its text");
    console.log("PASS read a draft written by another build (" + saved.store.data.rows.length + " records)");
    return;
  }
  const {p, d, defs} = board(), copper = d.pcbDrawing.pours.filter(r => C.copperOf(r));
  assert.ok(copper.length > 0 && copper.some(r => C.dataLength(r) > 100000), "the board holds a large island as runs: " + JSON.stringify(d.pcbDrawing.pours.map(r => [!!C.copperOf(r), C.dataLength(r)])));
  const idb = fakeIDB(), {Au, save} = await drafts(idb, p);
  const first = await save();
  assert.ok(first.m.runs?.length > 0, "the draft refers to run records");
  // One small edit inside the large island and its refill: the next draft writes the changed runs only.
  const part = d.items.filter(i => i.kind === "part").find(i => i.x > 10 && i.x < 30 && i.y > 10);
  part.x += .7;
  const stale = PP.inspectCopper(d, defs, {project: p}).stale;
  PP.apply(d, defs, {project: p, only: stale, derived: true});
  const second = await save();
  const island = Math.max(...d.pcbDrawing.pours.map(r => C.dataLength(r)));
  assert.ok(second.bytes < island / 4, "an edit writes far less than the island: " + second.bytes + " of " + island);
  assert.equal((await Au.read(second.m.id)).text, ECO.serialize(p), "the draft reads back as the project's text");
  // The first draft still reads (its runs are kept while it refers to them) and restores.
  const text1 = (await Au.read(first.m.id)).text;
  assert.ok(text1.length > 0 && text1 !== ECO.serialize(p));
  // Removing the first draft sweeps only the runs no draft refers to.
  await Au.remove([first.m.id]);
  const live = new Set((await Au.list()).flatMap(m => [...(m.keys || []), ...(m.runs || [])]));
  for (const k of idb.data.get("data").keys()) assert.ok(live.has(k), "no orphan record " + k);
  assert.equal((await Au.read(second.m.id)).text, ECO.serialize(p), "the kept draft still reads after the sweep");
  // A draft of the same board with its copper as text (as every earlier build writes it) reads back too.
  const plain = {...p, documents: [{...d, pcbDrawing: {...d.pcbDrawing, pours: d.pcbDrawing.pours.map(r => ({...r}))}}]};
  assert.ok(plain.documents[0].pcbDrawing.pours.every(r => !C.copperOf(r)));
  const idb2 = fakeIDB(), t = await drafts(idb2, plain), plainDraft = await t.save();
  assert.ok(!plainDraft.m.runs, "text copper writes text chunks");
  assert.equal((await t.Au.read(plainDraft.m.id)).text, ECO.serialize(plain));
  { const a = ECO.serialize(plain), b = ECO.serialize(p); let i = 0; while (i < a.length && a[i] === b[i]) i++; assert.equal(a, b, "the same copper as text or as runs is the same project text (first difference at " + i + ": " + JSON.stringify(a.slice(i - 80, i + 80)) + " / " + JSON.stringify(b.slice(i - 80, i + 80)) + ")"); }
  console.log(`PASS autosave-copper: first draft ${first.bytes} bytes, after one edit ${second.bytes} bytes (island ${island} characters); drafts read back exactly, runs swept with their drafts, text drafts unchanged`);
})().catch(e => { console.error(e); process.exitCode = 1; });
