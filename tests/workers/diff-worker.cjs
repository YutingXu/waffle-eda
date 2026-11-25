"use strict";
// The diff worker's watchdog (app/history/diff.js inWorker, app/workers/diff-worker.js) is a silence timer, not a total
// time limit: the worker posts a {progress} heartbeat at least once a second while it compares, and each
// heartbeat re-arms the 2-minute timer. A slow worker that keeps beating runs to its result (large
// drc: true comparisons were killed at 2 minutes and redone in main-thread slices); a silent one is
// stopped and the comparison falls back to slices.
// Run: node tests/workers/diff-worker.cjs   (Node only: scripts/test-jsc.sh skips it)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {nativeCAD} = require("../support/native-cad.cjs");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "altium-rules", "pcb-draw", "component-classes", "rules", "project-rules", "revision-review"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
// diff.js finds diff-worker.js beside its own script; the fake Worker stands in for it.
globalThis.document = {currentScript: {src: "file:///atrium/app/history/diff.js"}};
require("../../app/history/diff.js");
delete globalThis.document;
const D = AtriumDiff;
const workers = [];
class FakeWorker {
  constructor(url) { this.url = url; this.sent = []; this.terminated = false; workers.push(this); }
  postMessage(m) { this.sent.push(m); }
  terminate() { this.terminated = true; }
  emit(data) { this.onmessage?.({data}); }
}
globalThis.Worker = FakeWorker;

// A virtual clock for the watchdog's timers.
const real = {setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval, clearInterval: globalThis.clearInterval};
let clock = 0, seq = 0;
const timers = new Map();
function fake() {
  Object.assign(globalThis, {
    setTimeout: (fn, ms = 0) => { const id = ++seq; timers.set(id, {at: clock + ms, fn}); return id; },
    clearTimeout: id => { timers.delete(id); },
    setInterval: (fn, ms) => { const id = ++seq; timers.set(id, {at: clock + ms, fn, every: ms}); return id; },
    clearInterval: id => { timers.delete(id); }
  });
}
function advance(ms) {
  const end = clock + ms;
  for (;;) {
    let next = null;
    for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
    if (!next) break;
    const [id, t] = next;
    clock = t.at;
    if (t.every) t.at += t.every; else timers.delete(id);
    t.fn();
  }
  clock = end;
}
const restore = () => { Object.assign(globalThis, real); timers.clear(); };
const settled = p => { let state = "pending"; p.then(() => { state = "resolved"; }, () => { state = "rejected"; }); return () => state; };
const flush = () => new Promise(r => real.setTimeout(r, 0));

const base = nativeCAD("design-diff");
const after = JSON.parse(JSON.stringify(base));
const pcb = after.documents.find(d => d.kind === "pcb"), moved = pcb.items.find(i => i.kind === "part");
moved.x += 2;

(async () => {
  // 1. A slow worker that keeps beating: 5 minutes in all, never 2 minutes of silence.
  fake();
  let p = D.compareAsync(base, after, {workerThreshold: 0, validate: false, drc: true});
  const w = workers.at(-1);
  assert.ok(w && w.sent.at(-1)?.before, "the comparison went to the worker");
  const state = settled(p);
  for (let k = 0; k < 5; k++) { advance(60000); w.emit({progress: true}); }
  advance(60000);
  await flush();
  assert.equal(state(), "pending", "five minutes of heartbeats: still running");
  assert.ok(!w.terminated, "the worker was not stopped");
  const result = {summary: {total: 7}, changes: []};
  w.emit({result});
  restore();
  assert.equal(await p, result, "the worker's result arrives");
  assert.ok(w.terminated, "and the finished worker is released");

  // 2. A silent worker: stopped after two minutes, and the comparison runs in main-thread slices.
  fake();
  p = D.compareAsync(base, after, {workerThreshold: 0, validate: false});
  const silent = workers.at(-1);
  advance(119000);
  assert.ok(!silent.terminated, "not before two minutes");
  silent.emit({progress: true});
  advance(119000);
  assert.ok(!silent.terminated, "a heartbeat re-arms the two minutes");
  advance(1500);
  assert.ok(silent.terminated, "two minutes of silence stop it");
  restore();
  const fallback = await p;
  assert.ok(fallback?.changes?.some(c => c.kind === "part.moved"), "the comparison finished in slices instead");

  // 3. diff-worker.js itself beats while it compares: once a second, then the result (equal to compare()).
  const posts = [];
  globalThis.self = {postMessage: m => posts.push(m)};
  const workerDir = path.dirname(require.resolve("../../app/workers/diff-worker.js"));
  globalThis.importScripts = (...names) => { for (const n of names) require(path.resolve(workerDir, n)); };
  require("../../app/workers/diff-worker.js");
  const now = Date.now;
  let t = now();
  Date.now = () => (t += 250);   // every step takes a quarter of a second
  try { globalThis.self.onmessage({data: {before: base, after, opts: {}}}); } finally { Date.now = now; }
  const beats = posts.filter(m => m.progress).length, last = posts.at(-1);
  assert.ok(beats >= 2, "heartbeats while comparing: " + beats);
  assert.ok(posts.slice(0, -1).every(m => m.progress === true && Object.keys(m).length === 1), "heartbeats carry nothing else");
  assert.ok(last.result, JSON.stringify(last).slice(0, 200));
  const expected = D.compare(base, after);
  assert.deepEqual(last.result.summary, expected.summary);
  assert.deepEqual(last.result.changes, expected.changes, "the worker retains the full changes and their geometry");

  // The native Git worker reads one verified folder per revision. A file from a pre-release build
  // must fail on either side, including when an earlier request populated its revision cache.
  const fixtures = path.join(__dirname, "../fixtures"), manifest = "Sensor Board.waffle";
  const files = {}, objects = {};
  for (const name of [manifest, "Power.wsch"]) {
    const bytes = fs.readFileSync(path.join(fixtures, "format-2", "golden", name));
    files[name] = AtriumFormat2.sha256(bytes);
    objects[files[name]] = bytes.toString("base64");
  }
  const native = {revision:"working", blob:"native-golden", manifest, files};
  const history = async (sides, request, data = {}) => {
    posts.length = 0;
    await self.onmessage({data:{folder:{bundle:{revisions:sides, objects:{...objects, ...data}}, ...request}}});
    assert.equal(posts.length, 1);
    return posts[0];
  };
  const loaded = await history([native], {project:native.revision});
  assert.equal(loaded.result.value.project.documents[0].items[0].text, "SENSE");
  const missing = {revision:"absent", blob:null};
  assert.equal((await history([missing], {project:missing.revision})).result.value.project, null);

  const retired = fs.readFileSync(path.join(fixtures, "compat", "projects", "v1.4-sample.atrium"));
  const refused = {error:"This file is from a pre-release Waffle build; re-import the design from its source EDA"};
  const digest = AtriumFormat2.sha256(retired);
  const old = {revision:"historical", blob:native.blob, path:"Board.atrium", text:retired.toString("utf8")};
  const wrongManifest = {revision:"historical", blob:native.blob, manifest, files:{[manifest]:digest}};
  for (const side of [old, wrongManifest]) {
    for (const request of [{project:side.revision}, {before:side.revision,after:native.revision}, {before:native.revision,after:side.revision}]) {
      assert.deepEqual(await history([native, side], request, {[digest]:retired.toString("base64")}), refused);
    }
  }
  assert.equal((await history([native], {project:native.revision})).result.value.version, loaded.result.value.version);
  delete globalThis.self; delete globalThis.importScripts;
  console.log("diff-worker: ok (watchdog, sliced fallback, full change parity, verified native and refused historical revisions)");
})().catch(e => { console.error(e); process.exitCode = 1; });
