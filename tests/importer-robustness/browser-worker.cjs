"use strict";

// The same worker script used by the static browser app. STEP supplies its own
// generated first-party worker source. Input files are passed as messages.
const {parentPort, workerData} = require("node:worker_threads");
const {runInThisContext} = require("node:vm");
const path = require("node:path");
const assert = require("node:assert/strict");
const {snapshot, unchanged} = require("./prototypes.cjs");
const app = path.resolve(__dirname, "../../app");
const worker = path.join(app, "workers/import-worker.js");
globalThis.self = globalThis;
globalThis.onmessage = null;
globalThis.importScripts = (...names) => {
  for (const name of names) {
    const file = path.resolve(path.dirname(worker), name);
    const mod = require(file);
    if (file === path.join(app, "vendor/cfb.min.js")) globalThis.CFB = mod;
  }
};
globalThis.postMessage = msg => parentPort.postMessage(msg);
if (workerData !== null) runInThisContext(workerData, {filename: "step-worker.js"});
else require(worker);
assert.equal(typeof onmessage, "function", "the real worker installed its message handler");

parentPort.on("message", data => {
  const before = snapshot(), replies = [];
  globalThis.postMessage = (msg, transfers) => replies.push([msg, transfers]);
  onmessage({data}); // An escaping exception fails this worker and the case.
  unchanged(before);
  const terminal = replies.filter(([m]) => m.type !== "progress");
  assert.equal(terminal.length, 1, "one terminal worker response");
  const [reply] = terminal[0];
  assert.equal(reply.id, data.id);
  if (reply.type === "parse-error") {
    assert.deepEqual(Object.keys(reply).sort(), ["id", "message", "type"]);
    assert.equal(typeof reply.message, "string");
    assert.ok(reply.message.trim());
  } else if (workerData === null) {
    assert.equal(reply.type, "result");
    assert.ok(!reply.value?.fallback, "compiled-in readers were available");
  }
  for (const [msg, transfers] of replies) parentPort.postMessage(msg, transfers);
});
