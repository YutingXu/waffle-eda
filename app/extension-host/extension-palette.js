"use strict";
// Data-only contributions shared by the extension host and the single command palette.
// Executable callbacks are built here and always carry the supplying extension's identity.
globalThis.AtriumExtensionPalette = (() => {
  if (!globalThis.AtriumExtensionPaletteDeclarations && typeof require === "function") require("./extension-palette-declarations.js");
  const {id,plain,bounded,keys,declared,validate} = globalThis.AtriumExtensionPaletteDeclarations;
  const enabled = () => globalThis.AtriumLabs?.notebookEnabled() === true;
  const records = new Map(), mathListeners = new Set(), shortcuts = new Map(), surfacePrefixes = new WeakMap();
  let host, palette, views, loading, mathStamp = "";

  function makeViews(module) {
    return module.create({records,host:()=>host,palette,evaluateMath,id,plain,bounded});
  }
  function demandViews() {
    if (!enabled()) return null;
    if (views) return views;
    if (!globalThis.AtriumExtensionPaletteView && !globalThis.document && typeof require === "function")
      require("./extension-palette-view.js");
    const module = globalThis.AtriumExtensionPaletteView;
    if (module) return views=makeViews(module);
    const lazy = globalThis.AtriumLazy;
    if (!palette?.isOpen?.() || !lazy) return null;
    const eligible = [...records.values()].some(e => host.available(e,true) &&
      keys.some(k => k !== "mathFunctions" && e.manifest.contributes[k]?.length));
    if (!eligible) return null;
    return loading ??= lazy.need("AtriumExtensionPaletteView").then(module => {
      views=makeViews(module);
      loading=null;
      palette?.invalidateProvider?.("extensions");
      return views;
    }, () => {loading=null;return null;});
  }
  function connect() {
    const p = globalThis.AtriumPalette;
    if (!enabled() || !host || !p?.registerProvider) return;
    if (p !== palette) {
      palette=p;
      p.registerProvider("extensions", {
        label:"Extensions",
        entries(ctx) {
          demandViews();
          return views?.entries(ctx) || [];
        },
        async stream(request, emit) {
          if (request.signal?.aborted) return;
          const renderer=await demandViews();
          if (!request.signal?.aborted) return renderer?.stream(request,emit);
        }
      });
    }
    demandViews();
  }
  function signature() {
    const hashes = [];
    for (const e of records.values()) if (e.manifest.contributes?.mathFunctions?.length && host.available(e, false) && e.hash) hashes.push(e.id + "@" + e.hash);
    return hashes.sort().join("|");
  }
  // These IDs are the palette row keys as well as the Keymap IDs. A handler registered by
  // another provider can never be replaced or removed by installing an extension.
  function shortcutId(key) {
    const known = shortcuts.get(key);
    return known && globalThis.AtriumKeymap?.command(key) === known.command ? key : null;
  }
  function openShortcut(key, target) {
    const source = shortcuts.get(key)?.e;
    if (enabled() && shortcutId(key) && host.available(source, true)) globalThis.AtriumNavCommon?.openPalette?.("command", null,
      {source: "shortcut", entryKey: key, ...(target ? {target} : {})});
  }
  // Library editors own modal canvases. Use the same compiled Keymap table and its
  // normal conflict winner, leaving unclaimed keys to the active surface.
  function surfaceShortcut(event, surface) {
    if (!enabled() || !shortcuts.size || !surface?.canvas || event.defaultPrevented || event.isComposing || event.key === "Process" ||
        event.target?.closest?.("input,textarea,select,[contenteditable=true],[role=textbox]")) return false;
    const km = globalThis.AtriumKeymap, key = km.eventKey(event), table = km.table(), prefix = surfacePrefixes.get(surface);
    if (key < 0 || key === km.MODIFIER) return false;
    surfacePrefixes.delete(surface);
    const chord = key * 16 + km.eventMask(event, key), ctx = {kind: surface.kind, canvas: true, tool: "select"};
    const node = (prefix?.table === table && prefix.node.children?.get(chord)) || table.root.get(chord);
    if (!node) return false;
    if (km.isPrefix(node, ctx, true)) {
      if (!node.desc.some(r => shortcutId(r.id) && r.test(ctx, true))) return false;
      surfacePrefixes.set(surface, {table, node});
    } else {
      const rec = km.firstPass(node.bindings, ctx, true);
      if (!rec || !shortcutId(rec.id)) return false;
      if (!event.repeat) openShortcut(rec.id, event.target);
    }
    event.preventDefault(); event.stopPropagation(); return true;
  }
  function syncShortcuts() {
    const km = globalThis.AtriumKeymap;
    if (!km?.registerCommand) return;
    const desired = new Map();
    for (const e of records.values()) if (enabled() && host.available(e, true)) for (const def of e.manifest.contributes.paletteCommands || []) {
      const key = "command:ext:" + e.id + ":" + def.id;
      desired.set(key, {e, def});
    }
    for (const [key, previous] of shortcuts) if (desired.get(key)?.e !== previous.e) {
      if (shortcutId(key)) previous.registration.dispose();
      shortcuts.delete(key);
    }
    for (const [key, {e, def}] of desired) {
      if (shortcuts.has(key) || km.command(key)) continue;
      const registration = km.registerCommand({id: key, notebook:true, title: def.name, category: "Extensions",
        when: (def.contexts || []).map(k => "kind == " + JSON.stringify(k)).join(" || "),
        run: () => openShortcut(key)});
      shortcuts.set(key, {e, registration, command: km.command(key)});
    }
  }
  function invalidate(owner) {
    views?.invalidate(owner);
    refresh();
  }
  function refresh() {
    syncShortcuts();
    if (palette) palette.invalidateProvider?.("extensions"); else connect();
    if (!mathListeners.size) return;
    const next = signature();
    if (next !== mathStamp) { mathStamp = next; for (const listener of [...mathListeners]) listener(); }
  }
  function onMathFunctionsChanged(listener) {
    if (typeof listener !== "function") throw Error("A function registry listener must be a function.");
    if (!mathListeners.size) mathStamp = signature();
    mathListeners.add(listener); return () => mathListeners.delete(listener);
  }
  function add(e) { if (declared(e.manifest.contributes) && records.get(e.id) !== e) { records.set(e.id, e); refresh(); } }
  function remove(e) {
    if (records.get(e.id) !== e) return;
    records.delete(e.id);
    views?.remove(e);
    refresh();
  }
  const copy = v => JSON.parse(JSON.stringify(v));
  function declarations(e) {
    return (e.manifest.contributes?.mathFunctions || []).map(f => copy({id: f.id, version: f.version,
      arguments: f.arguments.map(a => ({name: a.name, dimension: a.dimension})), returns: f.returns, domain: f.domain,
      expression: f.expression, dependencies: (f.dependencies || []).map(d => ({id: d.id, version: d.version})),
      packageId: e.id, packageVersion: e.manifest.version, packageDigest: e.hash}));
  }
  function mathFunctions() {
    if (!enabled()) return [];
    const out = [];
    for (const e of records.values()) if (host.available(e, false) && e.hash) out.push(...declarations(e));
    return out;
  }
  async function calculations() {
    if (globalThis.AtriumCalculations) return globalThis.AtriumCalculations;
    const lazy = globalThis.AtriumLazy;
    return lazy?.modules?.().includes("AtriumCalculations") ? lazy.need("AtriumCalculations") : null;
  }
  async function validateMathPackage(e) {
    if (!e.manifest.contributes?.mathFunctions?.length) return;
    const evaluator = await calculations();
    if (!evaluator?.validateExtensionFunctions) return;
    const defs = declarations(e), available = mathFunctions().filter(f => f.packageId !== e.id).concat(defs);
    const functions = Object.fromEntries(available.map(f => [f.id, f]));
    const result = await evaluator.validateExtensionFunctions(defs, {functions});
    if (result?.ok !== true) throw Error(result?.diagnostic?.message || "Invalid extension calculation declaration.");
  }
  async function evaluateMath(fnId, version, args, {signal} = {}) {
    const installed = mathFunctions(), def = installed.find(f => f.id === fnId && f.version === version);
    if (!def) throw Error("This version of the extension function is unavailable.");
    if (signal?.aborted) throw Error("Calculation cancelled.");
    if (!Array.isArray(args) || args.length !== def.arguments.length || args.some((a, i) => !plain(a) || !Number.isFinite(a.value) || a.dimension !== def.arguments[i].dimension)) throw Error("The calculation arguments do not match the declared dimensions.");
    const quantities = args.map(a => ({value: a.value, dimension: a.dimension}));
    const evaluator = await calculations();
    if (!evaluator?.evaluateExtensionFunction) throw Error("The calculation evaluator is unavailable.");
    const functions = {}, visiting = new Set();
    function resolve(declaration) {
      if (visiting.has(declaration.id)) throw Error("The extension functions contain a dependency cycle.");
      if (visiting.size >= 16 || Object.keys(functions).length >= 64) throw Error("The function dependency limit was reached.");
      visiting.add(declaration.id);
      for (const pin of declaration.dependencies) {
        const child = installed.find(f => f.id === pin.id && f.version === pin.version);
        if (!child) throw Error("A required version of " + pin.id + " is unavailable.");
        if (!functions[child.id]) { resolve(child); functions[child.id] = child; }
      }
      visiting.delete(declaration.id);
    }
    resolve(def);
    const result = await evaluator.evaluateExtensionFunction(def, quantities, {signal, functions});
    const current = mathFunctions();
    if (signal?.aborted || [def, ...Object.values(functions)].some(d => !current.some(f => f.id === d.id && f.version === d.version && f.packageDigest === d.packageDigest))) throw Error("Calculation cancelled.");
    if (result?.ok === false) throw Error(result.diagnostic?.message || "The extension calculation could not be evaluated.");
    if (!Number.isFinite(result?.value) || result.dimension !== def.returns) throw Error("The calculation returned an invalid quantity.");
    return {value: result.value, dimension: result.dimension, ...(bounded(result.display, 160) ? {display: result.display} : {})};
  }
  globalThis.AtriumLazy?.register("AtriumExtensionPaletteView", {scripts:["extension-host/extension-palette-view.js"]});
  globalThis.addEventListener?.("waffle-palette-ready", connect);
  return Object.freeze({connect, ready:demandViews, validate, declared, validateMathPackage, add, remove, invalidate, shortcutId, surfaceShortcut, mathFunctions, onMathFunctionsChanged, evaluateMath, attach(h) { host = h; connect(); }});
})();
