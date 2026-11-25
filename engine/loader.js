// Included in app/engine-core.js. Each payload is a local classic script so file:// webviews
// and headless engines use the same bytes without fetch, eval, or an external service.
(function loadAtriumEngine(kernel) {
  const G = globalThis, setting = name => G[name] ?? G.process?.env?.[name];
  const mode = ["js", "wasm"].includes(setting("ATRIUM_ENGINE")) ? setting("ATRIUM_ENGINE") : "auto";
  const files = {mvp: "engine-mvp.js", simd128: "engine-simd128.js"};
  const candidates = [];
  if (mode !== "js" && typeof WebAssembly === "object" && typeof WebAssembly.Module === "function") {
    // i8x16.splat and i8x16.popcnt in a minimal v128 function.
    try {
      if (!["0", "off"].includes(setting("ATRIUM_ENGINE_SIMD")) &&
          WebAssembly.validate(Uint8Array.of(0,97,115,109,1,0,0,0,1,5,1,96,0,1,123,3,2,1,0,10,10,1,8,0,65,0,253,15,253,98,11))) candidates.push("simd128");
    } catch { /* an older runtime can still use MVP */ }
    candidates.push("mvp");
  }
  const payloads = new Map(), commonJS = typeof module === "object" && !!module.exports;
  const document = G.document, source = document?.currentScript?.src;
  const visible = () => commonJS || !document || (document.visibilityState !== "hidden" && G.AtriumPower?.visible?.() !== false);
  let current = kernel(null, null, mode), error = null, loading = null, settled = !candidates.length, permitted = false;
  let readLocal = commonJS ? file => require("./" + file) : null;
  if (!document && !readLocal && typeof G.load === "function" && typeof G.callerSourceOrigin === "function") {
    const origin = G.callerSourceOrigin();
    if (origin?.startsWith("file:///")) {
      const folder = decodeURIComponent(origin.slice(7, origin.lastIndexOf("/") + 1));
      readLocal = file => { G.load(folder + file); };
    }
  }
  function install(kind, text) {
    if (!candidates.includes(kind) || typeof text !== "string") return;
    payloads.set(kind, text);
  }
  function activate(kind) {
    if (visible() && payloads.has(kind)) current = kernel(kind, payloads.get(kind), mode, !!document && !commonJS);
  }
  function finish() {
    settled = true;
    if (mode === "wasm" && !current.available)
      throw Error(current.failure || error || "No Waffle WebAssembly module could load.");
  }
  // Synchronous hosts finish installing the chosen module before their next script executes.
  function loadLocal(read) {
    for (const kind of candidates) {
      try { install(kind, read(files[kind])); activate(kind); }
      catch (e) { error = e.message; }
      if (current.available || current.ready) break;
    }
    finish();
  }
  function loadBrowser() {
    if (settled) return mode === "wasm" && !current.available ? Promise.reject(Error(current.failure || error || "WebAssembly is unavailable.")) : Promise.resolve();
    if (!visible() || !document?.createElement) return Promise.resolve();
    if (loading) return loading;
    loading = (async () => {
      // validate() also succeeds when CSP forbids compiling Wasm. Check using an empty
      // valid module before loading either payload. A file:// shell needs no special policy.
      if (!permitted && typeof WebAssembly.compile === "function") {
        try { await WebAssembly.compile(Uint8Array.of(0,97,115,109,1,0,0,0)); permitted = true; }
        catch (e) { error = e.message; finish(); return; }
      }
      for (const kind of candidates) {
        if (!visible()) return;
        if (!payloads.has(kind)) {
          const script = document.createElement("script");
          script.src = source ? new URL(files[kind], source).href : files[kind];
          try { await new Promise((resolve, reject) => {
            script.onload = resolve; script.onerror = () => reject(Error("Could not load " + files[kind]));
            document.head.append(script);
          }); } catch (e) { error = e.message; }
        }
        if (!visible()) return;
        activate(kind);
        await current.ready;
        if (current.available) break;
        payloads.delete(kind);
      }
      finish();
    })().finally(() => { loading = null; });
    return loading;
  }
  // Comparing variants is explicit. Only a caller asking for another build reads its payload.
  function create(kind) {
    if (!payloads.has(kind) && readLocal && candidates.includes(kind)) install(kind, readLocal(files[kind]));
    return kernel(kind, payloads.get(kind), mode);
  }
  const engine = G.AtriumEngine = Object.freeze({
    get available() { return current.available; }, get variant() { return current.variant; },
    get failure() { return current.available ? null : current.failure || error; }, get stats() { return current.stats; },
    get settled() { return settled; }, mode, create, install, activate, loadBrowser, finish,
    candidates: Object.freeze(candidates),
    airwires: (nets, names) => current.airwires(nets, names), pourSolve: task => current.pourSolve(task),
    gridPairs: (boxes, size, reach) => current.gridPairs(boxes, size, reach),
    workerSource: () => current.workerSource()
  });
  if (readLocal) loadLocal(readLocal);
  return engine;
})
