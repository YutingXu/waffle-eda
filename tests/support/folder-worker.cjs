"use strict";
const {Worker} = require("node:worker_threads");

// LinkeDOM has no browser Workers. Run the same packaged entry with real messages and transfers.
module.exports = function installFolderWorker() {
  const pool = globalThis.AtriumWorkerPool, live = new Set();
  globalThis.AtriumWorkerPool = {...pool, script(name) {
    if (name !== "workers/folder-project-worker.js") return pool.script(name);
    const thread = new Worker(require.resolve("../workers/import-worker.cjs"),{workerData:{source:'importScripts("folder-project-worker.js");'}});
    live.add(thread);
    const jobs = new Set();
    const worker = {postMessage:(message,transfers)=>{
      if (message.op) { jobs.add(message.requestId); thread.ref(); }
      thread.postMessage(message,transfers);
    },terminate:()=>{live.delete(thread);return thread.terminate();}};
    thread.on("message",data=>{
      if (typeof data.ok === "boolean") jobs.delete(data.requestId);
      worker.onmessage?.({data});
      if (!jobs.size) thread.unref();
    });
    thread.unref();
    thread.on("error",error=>worker.onerror?.(error));
    return worker;
  }};
  return async () => {
    globalThis.AtriumWorkerPool = pool;
    await Promise.all([...live].map(thread=>thread.terminate()));
  };
};
