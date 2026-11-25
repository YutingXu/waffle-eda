"use strict";
// Web Worker for Route Suggestions (route-suggest.js starts it). It loads the DOM-free model,
// rules, stack-up, via stacks and router, and runs AtriumRouteSuggestEngine on the board window
// the page posts, so no suggestion search ever runs on the main thread.
//
// Latest wins: messages are queued and only the newest query runs; an older one still waiting is
// dropped and answered {stale:true}. A query's best route is posted as soon as it is found
// ({partial:true}), then the full result with the alternatives. A search is bounded by its budget;
// the page terminates and restarts the worker when a newer query waits too long.
// In:  {type:"suggest", id, board, defs:[...], query, options}   Out: {type:"result", id, result, partial?} | {type:"error", id, message}
globalThis.AtriumRouteSuggestWorker = (() => {
  let loaded = false;
  function load() {
    if (loaded) return;
    // Routing rules use the native query compiler and the classic-scope translator.
    importScripts("../core/uuid-v7.js", "../core/model.js", "../pcb/resolved-geometry-curves.js", "../pcb/pcb-appearance.js", "../pcb/land-contours.js", "../pcb/stackup.js", "../pcb/viastack.js", "../checks/altium-rules.js", "../core/geometry.js", "../pcb/pcb-draw.js", "../pcb/component-classes.js", "../checks/net-intent.js",
      "../checks/design-query-record.js", "../notebook/calculation-intent.js", "../notebook/calculation-core.js", "../notebook/note-fields.js", "../checks/query-fields.js",
      "../checks/design-query-parser.js", "../checks/design-query-geometry.js", "../checks/design-query-context.js", "../checks/design-query-index.js", "../checks/design-query.js", "../checks/query-exchange.js",
      "../checks/rules.js", "../pcb/router.js", "../pcb/route-suggest-engine.js");
    loaded = true;
  }
  if (typeof self === "undefined" || typeof importScripts !== "function" || typeof document !== "undefined") return {};
  let queued = null, busy = false;
  const defsCache = new Map();
  function run() {
    if (busy || !queued) return;
    const msg = queued; queued = null; busy = true;
    try {
      load();
      for (const d of msg.defs || []) defsCache.set(d.id, d);
      const defs = new Map(); for (const id of msg.defIds || []) if (defsCache.has(id)) defs.set(id, defsCache.get(id));
      const E = globalThis.AtriumRouteSuggestEngine, q = msg.query;
      const result = E.suggest(msg.board, defs, q, {...(msg.options || {}), onFirst: r => self.postMessage({type: "result", id: msg.id, result: r, partial: true})});
      self.postMessage({type: "result", id: msg.id, result});
      busy = false; run();
    } catch (e) {
      self.postMessage({type: "error", id: msg.id, message: String(e?.message || e)});
      busy = false; run();
    }
  }
  self.onmessage = e => {
    const m = e.data || {};
    if (m.type === "ping") { try { load(); self.postMessage({type: "ready"}); } catch (err) { self.postMessage({type: "error", id: 0, message: String(err?.message || err)}); } return; }
    if (m.type === "suggest") {
      if (queued) self.postMessage({type: "result", id: queued.id, stale: true});
      queued = m; setTimeout(run, 0); // drain waiting messages first: only the newest runs
    }
  };
  return {};
})();
