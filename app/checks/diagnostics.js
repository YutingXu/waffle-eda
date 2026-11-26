"use strict";
// Persist only bounded counters on failures. Old detailed records are never read by the report.
// Node and JavaScriptCore unit tests load the source directly. The browser loads the recorder on demand.
if (typeof require === "function" && typeof module === "object") require("./performance-diagnostics.js");
globalThis.AtriumDiagnostics = (() => {
  const G = globalThis, MAX = 32, KEY = "atrium-diagnostics-counts-v1";
  const counts = {javascriptErrors: 0, unhandledRejections: 0, scriptLoadFailures: 0, autosaveFailures: 0,
    workerFailures: 0, workerTimeouts: 0};
  const workerKinds = new Map([["worker", "workerFailures"], ["hang", "workerTimeouts"]]);
  const autosaveKinds = new Set(["serialize", "large", "error", "quota"]);
  const observed = new WeakSet();
  const now = () => G.performance?.now?.() ?? Date.now();
  let lastNotice = -Infinity, lastHandledError = -Infinity;

  function readCounts() {
    try {
      const raw = G.localStorage?.getItem(KEY);
      if (typeof raw !== "string" || raw.length > 1024) return;
      const stored = JSON.parse(raw);
      for (const key of Object.keys(counts)) {
        const value = stored?.[key];
        if (Number.isInteger(value) && value >= 0 && value <= MAX) counts[key] = Math.max(counts[key], value);
      }
    } catch { /* storage unavailable or invalid */ }
  }
  function increment(key) {
    if (counts[key] >= MAX) return;
    readCounts();
    if (counts[key] >= MAX) return;
    counts[key]++;
    try { G.localStorage?.setItem(KEY, JSON.stringify(counts)); } catch { /* bounded in-memory fallback */ }
  }
  function notify(at = now()) {
    if (at - lastNotice < 30000) return;
    lastNotice = at;
    try { G.AtriumNavHost?.info?.("Internal error. See Help › Troubleshooting › Crash Diagnostics."); }
    catch { /* the editor may be starting */ }
  }
  function noteError(error, handled = false) {
    if (error && (typeof error === "object" || typeof error === "function")) {
      if (observed.has(error)) return;
      observed.add(error);
    }
    const at = now();
    if (handled) lastHandledError = at;
    increment("javascriptErrors");
    notify(at);
  }
  const failed = error => noteError(error, true);
  G.addEventListener?.("error", event => {
    if (event.target?.localName === "script") increment("scriptLoadFailures");
    else if (event.error != null) noteError(event.error);
    // On file:// the browser can mute an uncaught exception before dispatching its ErrorEvent.
    else if (typeof G.ErrorEvent === "function" && event instanceof G.ErrorEvent &&
             !event.message.startsWith("ResizeObserver loop") && now() - lastHandledError >= 1000) noteError();
  }, true);
  G.addEventListener?.("unhandledrejection", event => {
    try { if (event.reason?.cancelled === true || event.reason?.name === "AbortError") return; }
    catch { /* a thrown object can have a getter */ }
    increment("unhandledRejections");
    notify();
  });

  return Object.freeze({
    get performance() { return G.AtriumPerformanceDiagnostics?.performance ?? null; },
    get startPerformance() { return G.AtriumPerformanceDiagnostics?.startPerformance; },
    performanceSnapshot(options) {
      return G.AtriumPerformanceDiagnostics?.performanceSnapshot(options) ?? {version: 1, recording: false, rows: []};
    },
    get durationBucket() { return G.AtriumPerformanceDiagnostics?.durationBucket; },
    get countBucket() { return G.AtriumPerformanceDiagnostics?.countBucket; },
    failures() { readCounts(); return {...counts}; },
    failed,
    autosaveFailure(kind) { if (autosaveKinds.has(kind)) increment("autosaveFailures"); },
    record(kind) {
      const key = workerKinds.get(kind);
      if (!key) return false;
      increment(key);
      return true;
    }
  });
})();
