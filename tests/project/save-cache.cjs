"use strict";
// Private editor snapshots share unchanged chunks. Saved project folders commit only the
// requested owner through a lease and its exact expected digest. Run with Node or JavaScriptCore.
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "eco", "save-cache", "autosave"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
require("../pcb/dense-board.js");
const ECO = AtriumECO, SC = AtriumSaveCache;
const enc = new TextEncoder(), dec = new TextDecoder();
function apply(oldText, patch) {
  const old = enc.encode(oldText), parts = [];
  let at = 0, size = 0;
  for (const [start, del, text] of patch.hunks) {
    assert.ok(start >= at && start + del <= old.length, "hunks in order and in range");
    parts.push(old.subarray(at, start), enc.encode(text)); at = start + del;
  }
  parts.push(old.subarray(at));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  for (const p of parts) { out.set(p, size); size += p.length; }
  assert.equal(old.length, patch.size); assert.equal(out.length, patch.length);
  return dec.decode(out);
}
let seed = 7;
const rand = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

// ---- byte identity and patches -------------------------------------------------------------
{
  const S = SC.create();
  const sample = AtriumParts.example();
  let prev = S.state(sample);
  assert.equal(S.text(prev), ECO.serialize(sample), "sample: identical to AtriumECO.serialize");
  assert.equal(prev.total, enc.encode(S.text(prev)).length, "byte total is the UTF-8 length");
  const {d} = makeAtriumBenchmarkBoard(), big = AtriumParts.example();
  big.documents.push(d);
  const b0 = S.state(big), ref = ECO.serialize(big);
  assert.equal(S.text(b0), ref, "25.6k board: identical to AtriumECO.serialize");
  d.items[12800].points[0][0] += 0.1;
  const b1 = S.state(big), p1 = S.diff(b0, b1);
  assert.equal(S.text(b1), ECO.serialize(big), "after one edit");
  assert.ok(p1.hunks.length === 1 && p1.bytes < 1024, "one-object edit is a small patch: " + p1.bytes);
  assert.equal(apply(ref, p1), S.text(b1));
  // An undo replaces every object: the content index still finds the unchanged nodes.
  const S2 = SC.create(); S2.state(big);
  const clone = JSON.parse(JSON.stringify(big));
  const b2 = S2.state(clone);
  assert.equal(S2.stats().made, 0, "undo-style copy re-serialises nothing");
  assert.equal(S2.text(b2), ECO.serialize(clone));
  // Sliced job equals a one-go pass.
  const j = S.job(big); let steps = 0; while (!j.step(0.2)) steps++;
  assert.ok(steps > 1, "the job yields"); assert.equal(S.text(j.result()), S.text(b1));
  // Chunks: an edit invalidates one chunk; an insertion at most two.
  const c0 = S.chunks(b1, null); c0.list.forEach((c, i) => { c.key = "k" + i; });
  assert.equal(c0.list.map(c => S.chunkText(b1, c)).join(""), S.text(b1));
  d.items[100].x = (d.items[100].x ?? 0) + 1;
  const b3 = S.state(big), c1 = S.chunks(b3, c0);
  assert.ok(c1.list.filter(c => !c.key).length <= 2, "one chunk rewritten: " + c1.list.filter(c => !c.key).length);
  d.items.splice(5000, 0, {id: "new-1", kind: "via", x: 1, y: 2, diameter: .6, drill: .3, layer: "Multi"});
  const b4 = S.state(big), c2 = S.chunks(b4, S.chunks(b3, c0));
  assert.ok(c2.list.filter(c => !c.key).length <= 3, "insertion rewrites a chunk or two");
  const p4 = S.diff(b3, b4);
  assert.ok(p4.bytes < 1024 && p4.hunks.length === 1, "insertion is a small patch");
  assert.equal(apply(S.text(b3), p4), ECO.serialize(big));
}
// Large stored copper stays in independent segments. Native patches and browser recovery chunks
// can reuse untouched regions even though the canonical format expands the whole pours array.
{
  const S = SC.create(), wide = "A".repeat(310000), odd = 'x"\\\n𝄞\ud800'.repeat(300);
  const regions = [{data: wide, bounds: [0, 0, 1, 1], polygon: "a"}, {data: "B".repeat(310000), polygon: "b"},
    {data: odd, "10": "ten", "2": "two", polygon: "odd"}, {data: "small", other: {b: .1234567891234567, a: 4}}, null];
  const p = {documents: [{pcbDrawing: {pours: regions}}]};
  const before = S.state(p), original = ECO.serialize(p), oldChunks = S.chunks(before);
  assert.equal(S.text(before), original);
  assert.ok(before.segs.includes(wide), "encoded copper occupies its own unchanged segment");
  assert.ok(S.stats().cacheChars < 16000, "the content cache excludes the encoded payloads");
  oldChunks.list.forEach((c, i) => { c.key = "k" + i; });
  regions[1].data = "C".repeat(310000);
  regions[2].polygon = "mutated";
  const job = S.job(p); while (!job.step(0)) { /* sliced autosave */ }
  const after = job.result(), patch = S.diff(before, after), want = ECO.serialize(p);
  assert.equal(S.text(after), want);
  assert.equal(apply(original, patch), want);
  assert.ok(patch.bytes < 320000, "native patch excludes the untouched large region");
  const freshBytes = S.chunks(after, oldChunks).list.filter(c => !c.key).reduce((n, c) => n + c.bytes, 0);
  assert.ok(freshBytes < 320000, "browser storage reuses the untouched copper chunk");
  assert.equal(S.text(before), original, "the previous recovery snapshot still has its original bytes");
  const prior = S.chunks(after); prior.list.forEach((c, i) => { c.key = "m" + i; });
  regions[0].bounds[0] = 1;
  const edited = S.state(p), changed = S.chunks(edited, prior).list.filter(c => !c.key);
  assert.ok(changed.reduce((n, c) => n + c.bytes, 0) < 16000, "metadata-only edits keep every large encoded chunk");
}
{
  const S = SC.create(), entry = {id: "old-drawing", values: Array.from({length: 4000}, (_, i) => i)};
  const p = {documents: [{items: [entry]}]}, before = S.state(p), original = S.text(before);
  entry.values[2000] = -1;
  const after = S.state(p);
  assert.equal(S.stats().byText, 1, "a completed save discards superseded large text from the reuse index");
  assert.equal(apply(original, S.diff(before, after)), ECO.serialize(p), "the previous state's bytes still produce the exact native patch");
}
// Randomised edits on a small project with awkward values.
{
  const S = SC.create();
  const p = {name: "Rand ✓", version: 2, documents: [{id: "d", kind: "pcb", name: "B", items: [], rules: {clearance: .2, nested: {deep: [1, {b: 2, a: 1}]}}},
    {id: "s", kind: "schematic", name: "S", items: [], empty: {}, list: []}], library: [{id: "lib", pads: [{n: 1}, {n: 2}]}]};
  for (let i = 0; i < 60; i++) p.documents[i % 2].items.push({id: "i" + i, kind: "label", x: i, text: i % 7 ? "t" + i : "Ωmega 𝄞 \"q\" \\ \n", extra: i % 5 ? undefined : null});
  let st = S.state(p), text = S.text(st);
  assert.equal(text, ECO.serialize(p));
  for (let round = 0; round < 300; round++) {
    const docItems = p.documents[rand(2)].items, k = rand(8);
    if (k === 0 && docItems.length) docItems.splice(rand(docItems.length), 1);
    else if (k === 1) docItems.splice(rand(docItems.length + 1), 0, {id: "n" + round, kind: "wire", points: [[rand(9), 1], [2, rand(9)]], z: "é" + round});
    else if (k === 2 && docItems.length > 2) { const a = rand(docItems.length), b = rand(docItems.length); [docItems[a], docItems[b]] = [docItems[b], docItems[a]]; }
    else if (k === 3) p.documents[0].rules.nested.deep.push(rand(100));
    else if (k === 4) p.name = "Rand " + round;
    else if (k === 5 && docItems.length) { const it = docItems[rand(docItems.length)]; it.fn = () => 1; it.u = undefined; it.later = round; }
    else if (k === 6) { const copy = JSON.parse(JSON.stringify(p)); Object.assign(p, copy); }
    else if (docItems.length) docItems[rand(docItems.length)].x = rand(1000) / 7;
    const next = S.state(p), patch = S.diff(st, next), want = ECO.serialize(p);
    assert.equal(S.text(next), want, "round " + round);
    assert.equal(apply(text, patch), want, "patch round " + round);
    st = next; text = want;
  }
}

// Native folder saves use active-owner splices, refuse a stale base and isolate grants.
async function folderSaves() {
  const fixture = require("../support/native-save-session.cjs");
  let rejectNext = false;
  const a = await fixture.open({name:"First",beforeCommit() {
    if (rejectNext) { rejectNext = false; throw Error("The expected file changed."); }
  }});
  const b = await fixture.open({name:"Second"});
  try {
    await a.session.activate("Control");
    a.edit("Power","UNSAVED"); a.edit("Control","ACCEPTED");
    rejectNext = true;
    await assert.rejects(a.session.save({documentId:"Control"}), /expected file changed/);
    assert.deepEqual(await a.read("Control.wsch"),a.originals.get("Control.wsch"));
    assert.ok(a.session.modified("Power") && a.session.modified("Control"));
    await a.session.save({documentId:"Control"});
    assert.ok(a.session.modified("Power") && !a.session.modified("Control"));
    assert.deepEqual(a.commits.map(r=>r.plan.map(row=>row.path)),[["Control.wsch"],["Control.wsch"]]);
    const row=a.commits[1].plan[0];
    assert.equal(row.expected,AtriumFormat2.sha256(a.originals.get("Control.wsch")));
    assert.equal(row.splice.base,row.expected);
    assert.equal(row.splice.edits.length,1);
    const committed=await a.read("Control.wsch");
    assert.equal(AtriumFormat2.parse(committed).get("n").text,"ACCEPTED");
    assert.throws(()=>a.folder.host.folderCommit(a.commits[1]),/changed before Save/);
    assert.deepEqual(await a.read("Control.wsch"),committed,"a stale receipt cannot overwrite the new revision");
    assert.deepEqual(await a.read("Power.wsch"),a.originals.get("Power.wsch"));
    assert.deepEqual(await a.read("First.waffle"),a.originals.get("First.waffle"));
    assert.throws(()=>b.host.folderReadLease({grant:a.folder.grant}),/closed/);
    assert.deepEqual(await b.read("Control.wsch"),b.originals.get("Control.wsch"));
    a.edit("Control","A SECOND REVISION");
    await a.session.save({documentId:"Control"});
    assert.equal(a.commits[2].plan[0].expected,AtriumFormat2.sha256(committed));
  } finally { await a.session.close(); await b.session.close(); }

  let release, enter;
  const held = new Promise(resolve=>{release=resolve;}), entered = new Promise(resolve=>{enter=resolve;});
  const previous = await fixture.open({name:"Previous",beforeCommit:async()=>{enter(); await held;}});
  const next = await fixture.open({name:"Next"});
  try {
    previous.edit("Power","PRIOR WINDOW");
    const saving = previous.session.save({documentId:"Power"});
    await entered;
    const closing = previous.session.close();
    next.edit("Power","CURRENT WINDOW");
    await next.session.save({documentId:"Power"});
    release();
    assert.ok((await saving).saved);
    await closing;
    assert.equal(AtriumFormat2.parse(await next.read("Power.wsch")).get("n").text,"CURRENT WINDOW");
    assert.ok(previous.commits[0].grant !== next.commits[0].grant,"an accepted save stays bound to its original folder");
  } finally { release(); await previous.session.close(); await next.session.close(); }
}

// ---- autosave with the serialiser: chunked snapshots -----------------------------------------
function fakeIDB() {
  const data = new Map(), f = {data, puts: 0, chars: 0};
  const later = fn => setTimeout(fn, 0);
  const db = {objectStoreNames: {contains: n => data.has(n)},
    createObjectStore(n, {keyPath}) { data.set(n, new Map()); data.get(n).keyPath = keyPath; },
    transaction() {
      const t = {error: null}, ops = [];
      t.abort = () => {};
      t.objectStore = n => {
        const st = data.get(n), req = fn => { const r = {}; ops.push(() => { r.result = fn(); r.onsuccess?.(); }); return r; };
        return {put(v) { if (n === "data") { f.puts++; f.chars += v.text.length; } return req(() => { st.set(v[st.keyPath], JSON.parse(JSON.stringify(v))); }); },
          get: k => req(() => st.get(k)), getAll: () => req(() => [...st.values()]), getAllKeys: () => req(() => [...st.keys()]), delete: k => req(() => { st.delete(k); })};
      };
      later(() => later(() => { for (const op of ops) op(); t.oncomplete?.(); }));
      return t;
    }};
  f.open = () => { const r = {}; later(() => { r.result = db; if (!data.size) r.onupgradeneeded?.(); r.onsuccess?.(); }); return r; };
  return f;
}
function lsFake() { const m = new Map(); return {getItem: k => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k)}; }
async function autosave() {
  const {d} = makeAtriumBenchmarkBoard(80), p = AtriumParts.example();
  p.name = "Chunky"; p.documents.push(d);
  const x0 = d.items[3000].x;
  let clock = 1e12, rev = 1;
  const idb = fakeIDB(), S = SC.create();
  const A = AtriumAutosave.create({indexedDB: idb, localStorage: lsFake(), now: () => clock, schedule: cb => cb(), serializer: S, locks: null});
  const host = {p, project: () => host.p, isDirty: () => true, revision: () => rev, info() {}, registerAction() {}, async replaceProject(q) { host.p = q; return true; }};
  A.attach(host);
  await A.boot();
  const m1 = await A.save("auto", true), full = idb.chars;
  assert.ok(m1.keys?.length > 10 && full >= ECO.serialize(p).length, "first snapshot writes every chunk");
  d.items[3000].x = 99; rev++; clock += 2 * 60000;
  const before = idb.chars, m2 = await A.save("auto", true);
  assert.notEqual(m2.id, m1.id);
  assert.ok(idb.chars - before < full / 20, "an autosave after one edit writes one chunk: " + (idb.chars - before) + " of " + full);
  assert.equal(A.stats().fresh, 1);
  // Both snapshots restore exactly.
  const want = ECO.serialize(p);
  const r2 = await A.read(m2.id);
  assert.equal(r2.meta.id, m2.id); assert.equal(r2.text, want, "read(id) returns the snapshot text");
  assert.equal(await A.restore(m1.id, {force: true}), true);
  assert.equal(host.p.documents.at(-1).items[3000].x, x0);
  assert.equal(await A.restore(m2.id, {force: true}), true);
  assert.equal(ECO.serialize(host.p), want, "the restored snapshot is the project");
  // Shared chunks survive pruning of the snapshot that wrote them; unreferenced ones are swept.
  await A.remove([m1.id]);
  const live = new Set((await A.list()).flatMap(m => m.keys || []));
  for (const k of idb.data.get("data").keys()) assert.ok(live.has(k), "no orphan chunk " + k);
  assert.equal(await A.restore(m2.id, {force: true}), true);
}

globalThis.__testDone = (async () => {
  await folderSaves();
  await autosave();
  console.log("save-cache: byte-identical serialisation, patches, chunks, scoped native save and chunked private drafts OK");
})();
globalThis.__testDone.catch(e => { console.error(e); if (typeof process !== "undefined") process.exitCode = 1; });
