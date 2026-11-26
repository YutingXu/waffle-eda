"use strict";
// Persist only bounded editor failure counts for the current and previous six UTC days.
// Node and JavaScriptCore unit tests load the source directly. The browser loads the recorder on demand.
if (typeof require === "function" && typeof module === "object") require("./performance-diagnostics.js");
globalThis.AtriumDiagnostics = (() => {
  const G = globalThis, MAX = 32, DAY = 86400000, KEY = "atrium-diagnostics-counts-v2";
  const RESET_KEY = "atrium-diagnostics-clear-v2", LEGACY_KEY = "atrium-diagnostics-v1", UNDATED_KEY = "atrium-diagnostics-counts-v1";
  const emptyCounts = {javascriptErrors: 0, unhandledRejections: 0, scriptLoadFailures: 0, autosaveFailures: 0,
    workerFailures: 0, workerTimeouts: 0};
  const workerKinds = new Map([["worker", "workerFailures"], ["hang", "workerTimeouts"]]);
  const legacyKinds = new Map([...workerKinds, ["error", "javascriptErrors"], ["rejection", "unhandledRejections"],
    ["script-load", "scriptLoadFailures"], ["autosave", "autosaveFailures"]]);
  const autosaveKinds = new Set(["serialize", "large", "error", "quota"]);
  let observed = new WeakSet();
  const now = () => G.performance?.now?.() ?? Date.now();
  const utcDay = () => Math.floor(Date.now() / DAY);
  const within = (day, today) => Number.isInteger(day) && day >= today - 6 && day <= today;
  let lastNotice = -Infinity, lastHandledError = -Infinity;
  let days = new Map(), generation = 0, lastRaw = null, legacyScanned = false, legacyRemoved = false, clearPending = false;

  function parse(raw, limit) {
    try {
      if (typeof raw === "string" && raw.length <= limit) return JSON.parse(raw);
    } catch { /* invalid saved diagnostics */ }
  }
  function resetVersion(store) {
    const value = Number(store.getItem(RESET_KEY));
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  function save(store, previous = lastRaw) {
    if (!store) return;
    const raw = JSON.stringify({generation, days: [...days]});
    if (raw === previous) { lastRaw = raw; return; }
    try {
      // Even if a sibling clears after this check, it can reject the stale generation.
      if (resetVersion(store) !== generation) return;
      store.setItem(KEY, raw);
      lastRaw = raw;
    } catch { /* bounded in-memory fallback */ }
  }
  function add(day, field) {
    const row = days.get(day) ?? {};
    const value = row[field] ?? 0;
    if (value >= MAX) return false;
    row[field] = value + 1;
    days.set(day, row);
    return true;
  }
  function sync(today) {
    for (const day of days.keys()) if (!within(day, today)) days.delete(day);
    try {
      const store = G.localStorage;
      if (!store) return null;
      let current = resetVersion(store);
      const raw = store.getItem(KEY);
      if (clearPending) {
        current = current === Number.MAX_SAFE_INTEGER ? 1 : current + 1;
        store.setItem(RESET_KEY, String(current));
        clearPending = false;
        legacyScanned = true;
        generation = current;
        lastRaw = null;
      } else if (generation !== current || lastRaw !== raw) {
        generation = current;
        lastRaw = null;
        days = new Map();
        const saved = parse(raw, 4096);
        if (saved?.generation === current && Array.isArray(saved.days)) for (const entry of saved.days.slice(-7)) {
          if (!Array.isArray(entry) || !within(entry[0], today)) continue;
          const row = {};
          for (const field of Object.keys(emptyCounts)) {
            const value = entry[1]?.[field];
            if (Number.isInteger(value) && value > 0 && value <= MAX) row[field] = value;
          }
          if (Object.keys(row).length) days.set(entry[0], row);
        }
      }
      if (!legacyScanned) {
        if (raw == null && generation === 0) {
          const old = parse(store.getItem(LEGACY_KEY), 16384);
          if (Array.isArray(old)) for (const row of old.slice(-MAX)) {
            const field = legacyKinds.get(row?.kind);
            if (!field || !Number.isSafeInteger(row.at) || row.at < 0) continue;
            const day = Math.floor(row.at / DAY);
            if (within(day, today)) add(day, field);
          }
        }
        legacyScanned = true;
      }
      if (!legacyRemoved) {
        try {
          store.removeItem(LEGACY_KEY);
          store.removeItem(UNDATED_KEY);
          legacyRemoved = true;
        } catch { /* retry removal on the next access */ }
      }
      if (raw != null || days.size) save(store, raw);
      return store;
    } catch { return null; }
  }
  function increment(field) {
    const day = utcDay(), store = sync(day);
    if (add(day, field)) save(store);
  }
  function clearFailures() {
    days.clear();
    observed = new WeakSet();
    lastNotice = lastHandledError = -Infinity;
    legacyRemoved = false;
    clearPending = true;
    sync(utcDay());
  }
  function failures() {
    sync(utcDay());
    const totals = {...emptyCounts};
    for (const row of days.values()) for (const field of Object.keys(emptyCounts)) {
      totals[field] = Math.min(MAX, totals[field] + (row[field] ?? 0));
    }
    return totals;
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
    failures,
    clearFailures,
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
