"use strict";

// The JSC and Node inventories both exercise the portable regression cases.
// Node also runs every corpus case in its own supervised process.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
require("../../app/formats/ipc2581.js");
const sample = name => fs.readFileSync(path.join(__dirname, "../fixtures", name), "utf8");
const stepSource = fs.readFileSync(path.join(__dirname, "../../app/formats/step-import.js"), "utf8");
function stepHost() {
  const workers = [], timers = new Map();
  let next = 0, deny = false;
  class Worker {
    constructor() {
      if (deny) throw Error("Workers unavailable");
      this.jobs = []; workers.push(this);
    }
    postMessage(msg) { this.jobs.push(msg); }
    terminate() { this.stopped = true; }
  }
  const host = vm.createContext({Worker, Blob: class {}, URL: {createObjectURL: () => "blob:model", revokeObjectURL() {}},
    setTimeout(fn) { timers.set(++next, fn); return next; }, clearTimeout(id) { timers.delete(id); }});
  vm.runInContext(stepSource, host);
  return {S: host.AtriumSTEPImport, workers, timers, deny() { deny = true; }};
}
async function regressions() {
  const ipc = AtriumIPC2581.check(sample("import/robustness/missing-layer-ref.ipc2581.xml"));
  assert.equal(ipc.ok, false);
  assert.match(ipc.errors.join("\n"), /<LayerRef> needs the name attribute/);
  const drill = require("./gerber-compare.cjs").parseExcellon(sample("import/robustness/missing-tool.drl"));
  assert.deepEqual(drill.warnings, ["T1 has no defined diameter"]);
  assert.equal(drill.slots.length, 0);
  assert.deepEqual(drill.hits.map(h => [h.x, h.y, h.d]), [[3, 4, 0.8]]);
  const text = sample("mcad/tray.step");
  const {S, workers, timers, deny} = stepHost();
  const a = S.load(text), b = S.load(text + "\n");
  assert.strictEqual(S.load(text), a);
  workers[0].onerror({});
  for (const r of await Promise.all([a, b])) {
    assert.match(r.error, /worker stopped/);
    assert.equal(r.parts.length, 0);
  }
  assert.strictEqual(S.ensure(text), await a, "the failed input stays a reported error in synchronous DRC");
  assert.equal(workers[0].stopped, true);
  assert.equal(timers.size, 0);
  const recovered = S.load(text + "\n\n");
  workers[0].onerror({}); // A late error from the old worker cannot affect the replacement.
  workers[1].onmessage({data: {id: workers[1].jobs[0].id, result: {parts: [], stats: {}, notes: []}}});
  assert.ok(!(await recovered).error);
  const timeout = S.load(text + "\n\n\n"), pending = S.load(text + "\n\n\n\n");
  timers.values().next().value();
  for (const r of await Promise.all([timeout, pending])) assert.match(r.error, /stopped/);
  assert.equal(timers.size, 0);
  deny();
  assert.match((await S.load(text + " ")).error, /could not restart/);

  const send = stepHost();
  const first = send.S.load(text);
  send.workers[0].postMessage = () => { throw Error("Transport unavailable"); };
  const second = send.S.load(text + "\n");
  for (const r of await Promise.all([first, second])) assert.match(r.error, /send the model/);
  const receive = send.S.load(text + " ");
  send.workers[1].onmessageerror();
  assert.match((await receive).error, /receive the decoded/);

  const local = stepHost();
  local.deny();
  assert.ok((await local.S.load(text)).parts.length, "a host without worker capability can read a model");
  const empty = "ISO-10303-21;\nDATA;\nENDSEC;\nEND-ISO-10303-21;";
  const old = await local.S.load(empty);
  for (let i = 1; i <= 64; i++) await local.S.load(empty + " ".repeat(i));
  assert.equal(local.S.cached(empty), null);
  assert.notEqual(await local.S.load(empty), old, "evicted foreground reads leave the in-flight map");
  assert.match((await local.S.load(null)).error, /not text/);
  assert.equal(local.S.cached(null), null);
  console.log("IPC references, Excellon tools and STEP worker and cache regressions passed.");
}
globalThis.__testDone = regressions().then(() => {
  if (process.versions.node) require("../importer-robustness/run.cjs").run(process.argv.slice(2));
});
