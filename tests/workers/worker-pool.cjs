"use strict";
// A lower power cap must also constrain workers that were already warm. Cancelling one job
// does not affect its neighbours, and a worker failure uses the undetached fallback task.
const assert = require("node:assert/strict");
const inbox = [], sources = [], revoked = [];
Object.defineProperty(globalThis, "navigator", {configurable:true, value:{hardwareConcurrency:8}});
globalThis.URL = {createObjectURL:blob => { sources.push(blob.text); return "blob:test-" + sources.length; }, revokeObjectURL(url) { revoked.push(url); }};
globalThis.Blob = class Blob { constructor(parts) { this.text = parts.join(""); } };
globalThis.Worker = class Worker {
  constructor(url) { this.url = url; }
  postMessage(packet) { inbox.push({worker:this, packet}); }
  terminate() { this.ended = true; }
};
require("../../app/workers/worker-pool.js");
require("../../app/checks/diagnostics.js");
const W = AtriumWorkerPool;
const diagnostics = AtriumDiagnostics;
const performanceRow = (component, operation) =>
  diagnostics.performanceSnapshot().rows.find(r => r.component === component && r.operation === operation);
function answer({worker, packet} = inbox.shift()) {
  worker.onmessage({data:{id:packet.id, result:packet.task}});
}
globalThis.__testDone = (async () => {
  const recording = diagnostics.startPerformance();
  const pool = W.create("test-private-pool", () => "", {size:4, local: task => task});
  const warm = pool.map([1, 2, 3, 4]);
  assert.equal(inbox.length, 4);
  while (inbox.length) answer();
  assert.deepEqual(await warm, [1, 2, 3, 4]);

  W.setCap(2);
  const a = pool.run("cancel"), b = pool.run("keep"), c = pool.run("queued");
  assert.equal(inbox.length, 2, "idle workers above the cap must not be used");
  assert.deepEqual(
    [performanceRow("workers", "request").counts.queued, performanceRow("workers", "request").counts.started],
    [7, 6], "queued work is not yet dispatched");
  const stopped = a.then(() => false, error => error.cancelled);
  const {worker} = inbox.shift();
  a.cancel();
  assert.equal(worker.ended, true);
  assert.equal(await stopped, true);
  assert.equal(inbox.length, 2, "the one freed slot was replaced");
  while (inbox.length) answer();
  assert.equal(await b, "keep");
  assert.equal(await c, "queued");
  assert.deepEqual(performanceRow("workers", "request").counts,
    {queued:7,started:7,ready:6,visible:0,durable:0,completed:6,cancelled:1,failed:0});
  pool.close();

  const fallback = W.create("fallback", () => "", {local: task => task});
  const recovering = fallback.run("transferred", [], undefined, "original");
  inbox.shift().worker.onerror({preventDefault() {}});
  assert.equal(await recovering, "original");
  const scheduled = fallback.run("cancel local");
  scheduled.cancel();
  assert.equal(await scheduled.then(() => false, error => error.cancelled), true);
  assert.deepEqual(performanceRow("workers", "fallback").counts,
    {queued:2,started:1,ready:1,visible:0,durable:0,completed:1,cancelled:1,failed:0});
  fallback.close();

  let version = "js";
  const dynamic = W.create("kernels", () => version, {size:2, local:x => x, sourceVersion:() => version});
  const earlier = dynamic.run("old work"), idle = dynamic.run("old idle"), [oldWorker, oldIdle] = inbox.splice(0);
  answer(oldIdle); await idle;
  const oldURL = oldWorker.worker.url;
  version = "simd128";
  const current = dynamic.run("new kernel"), [selected] = inbox.splice(0);
  assert.ok(oldIdle.worker.ended && !oldWorker.worker.ended, "idle JS retires; a running JS job keeps its worker");
  assert.ok(!revoked.includes(oldURL) && selected.worker.url !== oldURL && sources.at(-1) === version);
  assert.equal(dynamic.started, 2, "new and old kernels share the cap");
  const beforeWaiting = performanceRow("workers", "request").counts;
  const waiting = dynamic.run("cancel queued"); waiting.cancel();
  assert.equal(await waiting.then(() => false, e => e.cancelled), true);
  const afterWaiting = performanceRow("workers", "request").counts;
  assert.equal(afterWaiting.queued, beforeWaiting.queued + 1);
  assert.equal(afterWaiting.cancelled, beforeWaiting.cancelled + 1);
  assert.equal(afterWaiting.started, beforeWaiting.started, "cancelling in the queue never starts work");
  answer(oldWorker); assert.equal(await earlier, "old work");
  assert.ok(oldWorker.worker.ended && revoked.includes(oldURL), "the old source is reclaimed when its last worker finishes");
  selected.worker.onerror({preventDefault() {}});
  assert.equal(await current, "new kernel", "a failed upgraded worker still uses the local solver");
  version = "mvp";
  assert.equal(dynamic.available, true, "a changed source can retry a previously failed worker");
  const retry = dynamic.run("baseline"); answer(); assert.equal(await retry, "baseline");
  assert.equal(sources.at(-1), "mvp");
  dynamic.close();

  // Watchdog: a worker silent past watchdogMs is terminated, its job rejects as hung (never rerun on
  // this thread), the next job gets a fresh worker, and the hang is logged and told once.
  W.setCap(0);
  const logged = [], told = [];
  globalThis.AtriumDiagnostics = {get performance() { return diagnostics.performance; },
    record: (kind, type) => logged.push(kind + ":" + type)};
  globalThis.AtriumNavHost = {info: m => told.push(m)};
  let localRuns = 0;
  const dog = W.create("hang-test", () => "", {size: 1, watchdogMs: 40, local: x => { localRuns++; return x; }});
  assert.equal(W.WATCHDOG_MS > 0, true, "pools have a watchdog by default");
  const stuck = dog.run("loop forever"), [hung] = inbox.splice(0);
  const prior = performanceRow("workers", "request").counts;
  const queuedBehind = dog.run("after the hang");
  const failure = await stuck.then(() => null, e => e);
  assert.equal(failure?.hung, true, "a silent worker's job rejects as hung");
  const expired = performanceRow("workers", "request").counts;
  assert.equal(expired.failed, prior.failed + 1);
  assert.equal(expired.ready, prior.ready, "the watchdog never received an answer");
  assert.equal(hung.worker.ended, true, "the hung worker is terminated");
  assert.equal(localRuns, 0, "a hung task is not rerun on the main thread");
  const [fresh] = inbox.splice(0);
  assert.ok(fresh && fresh.worker !== hung.worker, "the queued job starts on a fresh worker");
  answer(fresh); assert.equal(await queuedBehind, "after the hang");
  // Progress messages keep a long job alive.
  const slow = dog.run("slow but alive"), [busy] = inbox.splice(0);
  for (let i = 0; i < 4; i++) { await new Promise(r => setTimeout(r, 25)); busy.worker.onmessage({data: {id: busy.packet.id, progress: i}}); }
  answer(busy); assert.equal(await slow, "slow but alive", "progress re-arms the watchdog");
  const second = dog.run("hang again"); inbox.splice(0);
  assert.equal((await second.then(() => null, e => e))?.hung, true);
  assert.deepEqual(logged, ["hang:hang-test", "hang:hang-test"], "each hang is logged with the pool name only");
  assert.equal(told.length, 1, "the status bar tells a repeated hang once");
  // A crash (error or unreadable message) is logged and the job finishes locally.
  const crash = dog.run("crash"), [crashed] = inbox.splice(0);
  crashed.worker.onmessageerror({preventDefault() {}});
  assert.equal(await crash, "crash");
  assert.ok(logged.includes("worker:hang-test"));
  dog.close();
  // crash "fail" (pour solves): a crashed job is sent again, from its original, to a fresh worker;
  // a second crash rejects it (error.crashed). The local solver never runs it.
  let pourLocal = 0;
  const pours = W.create("pour-solve-2", () => "", {size: 1, crash: "fail", local: x => { pourLocal++; return x; }});
  const okFirst = pours.run("first"); answer(); assert.equal(await okFirst, "first");
  const once = pours.run("packed", [], undefined, "unpacked"), [c1] = inbox.splice(0);
  c1.worker.onerror({preventDefault() {}});
  const [r1] = inbox.splice(0);
  assert.ok(r1 && r1.worker !== c1.worker && r1.packet.task === "unpacked", "retried in a fresh worker from the original task");
  answer(r1); assert.equal(await once, "unpacked");
  const twice = pours.run("crash twice"), [c2] = inbox.splice(0);
  c2.worker.onerror({preventDefault() {}});
  const [c3] = inbox.splice(0); c3.worker.onerror({preventDefault() {}});
  assert.equal((await twice.then(() => null, e => e))?.crashed, true, "a second crash rejects the job");
  assert.deepEqual(performanceRow("pours", "retry").counts,
    {queued:0,started:2,ready:1,visible:0,durable:0,completed:1,cancelled:0,failed:1});
  assert.equal(pourLocal, 0, "a crashed pour solve never runs on this thread");
  assert.equal(pours.available, true, "the pool keeps running other jobs");
  const after = pours.run("after"); answer(); assert.equal(await after, "after");
  const beforeError = ["request","compute"].map(op => performanceRow("pours",op).counts);
  const refused = pours.run("invalid task"), [reply] = inbox.splice(0);
  reply.worker.onmessage({data:{id:reply.packet.id,error:"invalid task"}});
  await assert.rejects(refused,/invalid task/);
  ["request","compute"].forEach((op,i) => {
    const counts = performanceRow("pours",op).counts;
    assert.equal(counts.failed,beforeError[i].failed+1);
    assert.equal(counts.ready,beforeError[i].ready,"an error reply never made a result ready");
  });
  pours.close();
  // Two crashes before any job ever finished: workers do not run here; later jobs go to local.
  const never = W.create("pour-never", () => "", {size: 1, crash: "fail", local: x => { pourLocal++; return "local " + x; }});
  const n1 = never.run("x"); inbox.splice(0)[0].worker.onerror({preventDefault() {}}); inbox.splice(0)[0].worker.onerror({preventDefault() {}});
  assert.equal((await n1.then(() => null, e => e))?.crashed, true);
  assert.equal(await never.run("y"), "local y", "with no working worker, local runs (polygon-pour: in idle time with a budget)");
  never.close();
  const excerpt = JSON.stringify(diagnostics.performanceSnapshot({shareable:true}));
  assert.ok(!excerpt.includes("test-private-pool") && !excerpt.includes("pour-solve-2") && !excerpt.includes("packed"));
  recording.stop();
  delete globalThis.AtriumDiagnostics; delete globalThis.AtriumNavHost;

  // Real solver entry: blob construction rejects, the file worker is the fallback, cancel
  // rejects, and the object URL stays until 30000 ms. A successful sibling releases too.
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const saved = {Worker: globalThis.Worker, Blob: globalThis.Blob, URL: globalThis.URL, setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, document: globalThis.document, land: globalThis.AtriumLandContours};
  const pending = [], created = [], live = new Set(), launched = [];
  let timerId = 1;
  function resetLifetime() { pending.length = 0; created.length = 0; live.clear(); launched.length = 0; }
  function flush(ms) {
    for (const timer of pending.filter(item => item.ms === ms)) { pending.splice(pending.indexOf(timer), 1); timer.fn(); }
  }
  try {
    function URL(input, base) {
      if (!base || input.includes("://")) { this.href = input; return; }
      let folder = base.slice(0, base.lastIndexOf("/") + 1);
      if (input.startsWith("../")) {
        folder = folder.slice(0, folder.lastIndexOf("/", folder.length - 2) + 1);
        input = input.slice(3);
      }
      this.href = folder + (input === "." ? "" : input);
    }
    URL.createObjectURL = blob => { const url = "blob:solver/" + (created.length + 1); created.push({url, type: blob.type, text: blob.text}); live.add(url); return url; };
    URL.revokeObjectURL = url => { live.delete(url); };
    globalThis.URL = URL;
    globalThis.Blob = class Blob { constructor(parts, options) { this.text = parts.map(String).join(""); this.type = options && options.type; } };
    globalThis.setTimeout = (fn, ms) => { const id = timerId++; pending.push({id, fn, ms: Number(ms)}); return id; };
    globalThis.clearTimeout = id => { const index = pending.findIndex(item => item.id === id); if (index >= 0) pending.splice(index, 1); };
    globalThis.document = {baseURI: "https://synthetic.invalid/app/index.html", currentScript: {src: ""}};
    if (!globalThis.AtriumLandContours) globalThis.AtriumLandContours = {outline() { return []; }};
    const installWorker = failBlob => { globalThis.Worker = class Worker {
      constructor(url) { this.url = String(url); this.terminated = false; if (failBlob && this.url.startsWith("blob:")) throw new Error("worker construction rejected"); launched.push(this); }
      postMessage() {}
      terminate() { this.terminated = true; }
    }; };
    function bootSolver(url, source, error) {
      const messages = [], scope = vm.createContext({postMessage: message => messages.push(message)});
      scope.self = scope;
      if (source) vm.runInContext(source, scope);
      else {
        const entry = path.join(__dirname, "../../app/workers", path.basename(url));
        const read = filename => vm.runInContext(fs.readFileSync(filename, "utf8"), scope);
        scope.importScripts = (...names) => names.forEach(name => read(path.resolve(path.dirname(entry), name)));
        read(entry);
      }
      assert.equal(messages.shift()?.type, "ready", url + " boots without CommonJS");
      scope.onmessage({data: {type: "solve", id: 7, job: {layers: []}}});
      assert.deepEqual(messages.map(message => [message.type, message.id, message.message]), [["error", 7, error]]);
    }
    async function rejected(page, load, start, fileHref, error) {
      resetLifetime(); installWorker(true); globalThis.document.currentScript.src = page; load();
      const handle = start();
      const file = launched.at(-1);
      assert.equal(file.url, fileHref);
      assert.equal(created.length, 1); assert.equal(created[0].type, "text/javascript"); assert.equal(live.size, 1);
      if (error) bootSolver(file.url, null, error);
      if (handle.cancel) {
        const message = handle.promise.then(() => "", error => error.message);
        handle.cancel();
        assert.equal(await message, "Cancelled.");
        assert.equal(file.terminated, true);
      }
      assert.equal(live.size, 1, "rejection keeps the blob URL until its lifetime");
      flush(30000);
      assert.equal(live.size, 0, "the lifetime receipt releases the rejected blob URL");
    }
    // Classic-script evaluation with the editor's lazy prerequisites already loaded.
    const loaded = new Set();
    const load = file => {
      const filename = require.resolve(file);
      if (loaded.has(filename)) return;
      loaded.add(filename);
      vm.runInThisContext(fs.readFileSync(filename, "utf8"), {filename});
    };
    load("../../app/analysis/electrical-material.js");
    await rejected("https://synthetic.invalid/app/analysis/pdn.js", () => load("../../app/analysis/pdn.js"), () => AtriumPDN.run({meta: {}}), "https://synthetic.invalid/app/workers/pdn-worker.js", "No copper layers.");
    await rejected("https://synthetic.invalid/app/analysis/thermal.js", () => load("../../app/analysis/thermal.js"), () => AtriumThermal.run({meta: {}}), "https://synthetic.invalid/app/workers/thermal-worker.js", "Nothing to solve.");
    await rejected("https://synthetic.invalid/app/analysis/field-solver.js", () => load("../../app/analysis/field-solver.js"), () => AtriumFieldSolver.async({structure: "microstrip", w: .3, h: .2, er: 4.3}), "https://synthetic.invalid/app/workers/field-solver-worker.js");
    resetLifetime(); installWorker(false);
    const ok = AtriumPDN.run({meta: {}});
    assert.ok(launched.at(-1).url.startsWith("blob:solver/"), "successful construction returns the blob worker");
    assert.match(created.at(-1).text, /AtriumPDNServe\(self, AtriumPDNCore\(\)\)/);
    bootSolver(launched.at(-1).url, created.at(-1).text, "No copper layers.");
    assert.equal(live.size, 1); flush(30000); assert.equal(live.size, 0, "success releases the same blob URL");
    const stopped = ok.promise.then(() => false, () => true); ok.cancel(); assert.equal(await stopped, true);
    const thermal = AtriumThermal.run({meta: {}});
    bootSolver(launched.at(-1).url, created.at(-1).text, "Nothing to solve.");
    const cancelled = assert.rejects(thermal.promise, /Cancelled\./); thermal.cancel(); await cancelled;
    resetLifetime(); installWorker(true);
    const blocked = W.script("workers/diff-worker.js");
    assert.equal(blocked.url, "https://synthetic.invalid/app/workers/diff-worker.js");
    assert.equal(live.size, 1); flush(30000); assert.equal(live.size, 0, "script() releases a rejected blob URL and uses the file");
  } finally {
    globalThis.Worker = saved.Worker; globalThis.Blob = saved.Blob; globalThis.URL = saved.URL;
    globalThis.setTimeout = saved.setTimeout; globalThis.clearTimeout = saved.clearTimeout;
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    if (saved.land === undefined) delete globalThis.AtriumLandContours; else globalThis.AtriumLandContours = saved.land;
  }
  console.log("worker-pool: warm cap, kernel upgrade, cancellation, local fallback and hang watchdog OK");
})().catch(e => { console.error(e); process.exitCode = 1; });
