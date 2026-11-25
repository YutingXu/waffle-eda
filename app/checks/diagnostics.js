// Keep only diagnostic codes and locations of bundled scripts. Error messages and stacks can contain user data.
globalThis.AtriumDiagnostics = (() => {
  "use strict";
  const G = globalThis, KEY = "atrium-diagnostics-v1", LIMIT = 32;
  const errorNames = new Set(["Error", "TypeError", "ReferenceError", "SyntaxError", "RangeError", "EvalError", "URIError",
    "AggregateError", "AbortError", "OperationError", "SecurityError", "QuotaExceededError", "CompileError", "LinkError", "RuntimeError"]);
  const autosaveCodes = new Set(["serialize", "large", "error", "quota"]);
  const rendererCodes = new Set(["macOS", "Windows", "Linux"]);
  const rendererReasons = new Set(["exited", "unresponsive", "browser-exited", "memory-limit", "terminated"]);
  const scriptName = /^(?:[a-z][a-z0-9-]{0,64}\.js|index\.html)$/, task = /^[a-z][a-z0-9-]{0,40}$/;
  const pos = n => Number.isSafeInteger(n) && n > 0 && n <= 1e8 ? n : undefined;
  let memory = [], memoryOnly = false, lastKey = "", lastAt = 0;

  function safe(entry) {
    if (!Number.isSafeInteger(entry?.at) || entry.at < 0 || entry.at > 8e15) return null;
    const {at, kind, type, module, line, column} = entry;
    if (kind === "renderer") return rendererCodes.has(type) && rendererReasons.has(entry.reason) ? {at, kind, type, reason: entry.reason} : null;
    if (kind === "autosave") return autosaveCodes.has(type) ? {at, kind, type} : null;
    // A worker that failed or hung (worker-pool.js): its task name only.
    if (kind === "worker" || kind === "hang") return task.test(type) ? {at, kind, type} : null;
    if (!["error", "rejection", "script-load"].includes(kind) || !errorNames.has(type)) return null;
    return {at, kind, type, module: typeof module === "string" && scriptName.test(module) ? module : undefined,
      line: pos(line), column: pos(column)};
  }
  function stored() {
    if (memoryOnly) return memory;
    try {
      const raw = G.localStorage?.getItem(KEY);
      if (raw?.length > 16384) return memory;
      const rows = JSON.parse(raw || "null");
      return Array.isArray(rows) ? rows.slice(-LIMIT).map(safe).filter(Boolean) : memory;
    } catch { return memory; }
  }
  function add(details) {
    const at = Date.now(), entry = safe({at, ...details});
    if (!entry) return null;
    const key = JSON.stringify({...entry, at: 0});
    if (key === lastKey && at - lastAt < 1000) return null;
    lastKey = key; lastAt = at;
    memory = [...stored(), entry].slice(-LIMIT);
    try { G.localStorage?.setItem(KEY, JSON.stringify(memory)); memoryOnly = false; }
    catch { memoryOnly = true; }
    return entry;
  }
  // A failure shows once in the status bar, never as a dialog. Pages loaded from file:// see
  // "Script error." for every uncaught error, so edit() and act() report what they rethrow
  // (failed(), with its stack location) and the muted copy that follows is skipped.
  let told = 0, last = null, mutedUntil = 0;
  function tell(e) {
    if (!e || e.at - told < 3e4) return;
    told = e.at;
    try { G.AtriumNavHost?.info?.("Internal error (" + e.type + (e.module ? ", " + e.module : "") + "): details in Help › Crash Diagnostics"); } catch { /* no editor yet */ }
  }
  function failed(error) {
    if (error === last) return;
    last = error; mutedUntil = Date.now() + 1000;
    tell(add({kind: "error", type: errorType(error), ...stackLocation(error)}));
  }
  function bundledModule(source) {
    try {
      const page = new URL(G.location.href), url = new URL(source, page), dir = new URL(".", page);
      if (url.protocol !== dir.protocol || url.host !== dir.host || !url.pathname.startsWith(dir.pathname)) return;
      const name = url.pathname.slice(url.pathname.lastIndexOf("/") + 1);
      if (!scriptName.test(name)) return;
      if (url.pathname === page.pathname || Array.from(G.document.scripts).some(script => script.src === url.href)) return name;
    } catch { /* the source is unavailable */ }
  }
  function errorType(error) {
    try { if (errorNames.has(error?.name)) return error.name; } catch { /* a thrown object can have a getter */ }
    return "Error";
  }
  function stackLocation(error) {
    try {
      if (typeof error?.stack !== "string") return {};
      for (const frame of error.stack.slice(0, 4096).split("\n")) {
        const match = frame.match(/((?:file|https?):\/\/[^\n]*?):(\d{1,9})(?::(\d{1,9}))?\)?$/);
        const module = match && bundledModule(match[1]);
        if (module) return {module, line: +match[2], column: +match[3]};
      }
    } catch { /* the source is unavailable */ }
    return {};
  }
  G.addEventListener?.("error", event => {
    if (typeof event.filename === "string") {
      if (!event.error && (/^ResizeObserver loop/.test(event.message) || Date.now() < mutedUntil)) return; // benign, or reported by failed()
      if (event.error && event.error === last) return;
      const module = event.filename && bundledModule(event.filename);
      tell(add({kind: "error", type: errorType(event.error), module, line: module ? event.lineno : undefined, column: module ? event.colno : undefined}));
    } else if (event.target?.localName === "script") {
      const module = bundledModule(event.target.src);
      if (module) add({kind: "script-load", type: "Error", module});
    }
  }, true);
  G.addEventListener?.("unhandledrejection", event => {
    try { if (event.reason?.cancelled || event.reason?.name === "AbortError") return; } catch { /* a getter */ }
    tell(add({kind: "rejection", type: errorType(event.reason), ...stackLocation(event.reason)}));
  });

  async function entries() {
    const local = stored();
    let native = [];
    try { native = await G.AtriumHost?.crashHistory?.(); } catch { /* older host */ }
    return [...local, ...(Array.isArray(native) ? native.slice(-LIMIT).map(safe).filter(row => row?.kind === "renderer") : [])]
      .sort((a, b) => b.at - a.at).slice(0, LIMIT);
  }
  // record("worker" | "hang", task). The dialog and report: recover.js.
  return Object.freeze({entries, failed, autosaveFailure: type => add({kind: "autosave", type}), record: (kind, type) => !!add({kind, type})});
})();
