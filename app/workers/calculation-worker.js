"use strict";
// The pool starts this file from a Blob on desktop hosts. Imports are anchored
// to the app folder and never come from an expression or extension package.
(() => {
  const base = () => globalThis.AtriumCalculationWorkerBase || new URL("../", self.location.href);
  const load = files => importScripts(...files.map(f => new URL(f, base()).href));
  if (!globalThis.AtriumCalculationGraph) load(["notebook/calculation-intent.js", "notebook/calculation-core.js", "notebook/calculation-graph.js"]);
  self.onmessage = ({data}) => {
    try {
      if (data.task.operation !== "parse" && !globalThis.AtriumCalculationHelpers) {
        load(["notebook/preferred-values.js", "notebook/calculation-helpers.js"]);
      }
      self.postMessage({id: data.id, result: AtriumCalculationGraph.task(data.task)});
    } catch (error) {
      self.postMessage({id: data.id, error: String(error?.message || error)});
    }
  };
})();
