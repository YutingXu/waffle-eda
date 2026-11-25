"use strict";

// Browser transport for portable JS tests. The worker entry gets its own JS realm and
// receives only messages, even under the JSC test shim. tests/workers/import-worker.cjs separately
// exercises real OS workers and structured-clone/transfer semantics.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
let workerCount = 0n;
module.exports = function installImportWorker({client = false, configureWorker} = {}) {
  const keys = ["Worker", "URL", "location"];
  if (client) keys.push("AtriumLazy");
  const originals = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const app = path.resolve(__dirname, "../../app");
  const worker = path.join(app, "workers/import-worker.js");
  globalThis.URL ||= class URL { constructor(name, base) { this.href = String(base).replace(/[^/]*$/, "") + name; } };
  globalThis.location ||= {href: "file:///application/index.html"};
  globalThis.Worker = class Worker {
    constructor() {
      // Browser workers have Web Crypto. The JSC fixture gives each simulated
      // worker a disjoint counter range in the absence of that API.
      const __waffleUUIDSeed = (++workerCount << 48n).toString(16).padStart(20, "0");
      const scope = vm.createContext({ArrayBuffer, Uint8Array, DataView, TextEncoder, TextDecoder, atob, btoa, crypto:globalThis.crypto, __waffleUUIDSeed});
      this.scope = scope;
      scope.self = scope;
      scope.postMessage = data => { if (!this.stopped) this.onmessage?.({data}); };
      scope.importScripts = (...names) => {
        for (const name of names) load(path.resolve(path.dirname(worker), name));
      };
      const load = file => vm.runInContext(fs.readFileSync(file, "utf8"), scope, {filename: file});
      configureWorker?.(scope);
      Promise.resolve().then(() => load(worker)).catch(error => this.onerror?.(error));
    }
    postMessage(data) { Promise.resolve().then(() => { if (!this.stopped) this.scope.onmessage({data}); }); }
    terminate() { this.stopped = true; }
  };
  if (client) {
    for (const name of ["translator-table", "translator-registry", "import-worker-client"]) require(require("./app-source-paths.cjs").appFile(name + ".js"));
    const lazy = globalThis.AtriumLazy;
    globalThis.AtriumLazy = {...lazy, async need(name) {
      if (name === "AtriumTranslatorClient") return globalThis.AtriumTranslatorClient;
      if (lazy?.need) return lazy.need(name);
      throw Error("No loader for " + name);
    }};
  }
  return () => {
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  };
};
