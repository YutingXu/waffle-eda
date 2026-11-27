"use strict";
// Extension host for Waffle (main thread): registry, lazy activation, the worker
// pools that run extension code, declarative UI contributions and the Extensions
// manager. Startup reads the built-in and installed manifests for their contributions.
// Extension source files and workers are loaded on demand.
//
// Workers: every extension runs in its OWN worker (its own realm, so the trust
// principal is the realm), and every console script run gets a fresh one. Workers
// start lazily on activation and are terminated when the extension deactivates, goes
// idle or overruns its CPU budget. In the editor they live inside one sandboxed,
// opaque-origin iframe whose CSP (`default-src 'none'`) Blob workers inherit, so
// extension code has no network at all; network:<host> requests are made by the host.
// Messages from a worker are bound to the worker's own channel: ids inside messages
// are never trusted.
globalThis.AtriumExtensions = (() => {
  const doc = globalThis.document?.createElement ? globalThis.document : null;
  const notebookEnabled = () => globalThis.AtriumLabs?.notebookEnabled() === true;
  const paletteKeys = ["insertItems","paletteCommands","searchProviders","mathFunctions"];
  const paletteDeclared = c => paletteKeys.some(k => c?.[k] !== undefined);
  const notebookDeclared = c => paletteDeclared(c) || c?.widgets !== undefined;
  const widgetCommand = (c,id) => Array.isArray(c?.widgets) && c.widgets.some(w => w?.render === id || w?.event === id);
  function notebookCommand(c,id) {
    if (widgetCommand(c,id)) return true;
    return !c?.commands?.some(cmd=>cmd.command===id) &&
      paletteKeys.some(key=>Array.isArray(c?.[key]) && c[key].some(entry=>entry?.command===id));
  }
  function notebookOnly(manifest) {
    const c=manifest.contributes;
    return notebookDeclared(c) && Object.keys(c).every(k => k === "widgets" || paletteKeys.includes(k) ||
      k === "commands" && Array.isArray(c.commands) && c.commands.every(cmd => widgetCommand(c,cmd?.command)));
  }
  async function notebookModule(name,file) {
    if (globalThis[name]) return globalThis[name];
    if (!doc && typeof require === "function") {require("./" + file + ".js"); return globalThis[name];}
    return globalThis.AtriumLazy.need(name);
  }
  if (!doc && notebookEnabled() && typeof require === "function") {
    require("./extension-palette-declarations.js");
    require("./extension-widget-declarations.js");
  }
  const scriptBase = doc?.currentScript?.src ? new URL("../", doc.currentScript.src).href : globalThis.location?.href || "";
  const INDEX_KEY = "atrium.extensions.v1", STORE = "atrium.ext.storage.", SETTINGS = "atrium.ext.settings.", TRUST = "atrium.ext.trust.v1";
  const GRANTS = "atrium.ext.grants.v1", SAFE_MODE = "atrium.ext.safe-mode";
  // How a permission reaches the design or the computer, shown as a chip next to it.
  const permissionKind = p => p === "read:project" || p === "read:motion" ? ["Reads", "info"] : p === "propose:edits" ? ["You review", "success"]
    : p === "write:edits" ? ["Changes", "warning"] : p === "run:external" ? ["Runs programs", "danger"] : AtriumAPI.isNetworkPermission(p) ? ["Network", "warning"]
    : p === "outputs:write" ? ["Saves files", "info"] : ["Interface", "muted"];
  const describePermission = p => AtriumAPI.describePermission(p);
  const LIMITS = {callsPerSecond: 2000, logsPerSecond: 50, messageChars: 16e6, batchMessages: 5000, viewChars: 1e6, slowMs: 1000};
  const MENUS = ["file", "edit", "view", "project", "place", "tools", "reports", "help", "panels", "activeBar"];
  const LONG_TIMEOUT = 600000, MAX_PACKAGE = 32e6, BUILTIN_STATE = "atrium.ext.builtin-state";
  const DEFAULT_TIMEOUT = 5000, ACTIVATE_TIMEOUT = 5000, MAX_TIMEOUT = 120000;
  // Background CPU: a worker beats every second with its busy time. Outside a running
  // command (or while it waits for the user) it may use half a core over 10 s, and it
  // must keep beating; otherwise it is terminated. Idle extensions stop after 10 min.
  const CPU = {beatMs: 1000, window: 10, budgetMs: 5000, silenceMs: 20000}, IDLE_STOP = 600000;
  const cpu = () => ({...CPU, ...(options.cpu || {})}); // options.cpu: tests
  // Dialogs: at most this many queued consent prompts per extension, and an extension
  // whose dialogs are dismissed this many times in DISMISS_WINDOW ms is disabled.
  const MAX_QUEUED_PROMPTS = 3, MAX_DISMISSALS = 5, DISMISS_WINDOW = 30000;
  const MAX_ZIP_ENTRIES = 2000, MAX_NET_BYTES = 64e6;

  // localStorage with an in-memory fallback (private windows, JSC tests).
  const memory = new Map();
  const ls = {
    get(key, fallback) {
      try { const v = globalThis.localStorage?.getItem(key); if (v != null) return JSON.parse(v); } catch {}
      return memory.has(key) ? clone(memory.get(key)) : fallback;
    },
    set(key, value) {
      memory.set(key, clone(value));
      try { if (!globalThis.localStorage) return true; globalThis.localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
    },
    del(key) { memory.delete(key); try { globalThis.localStorage?.removeItem(key); } catch {} }
  };
  const clone = v => (v === undefined ? undefined : typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
  // SHA-256 over a canonical JSON encoding (sorted keys), for project-extension trust.
  // Pure JS and synchronous: it needs no secure context and gives the same digest in
  // the editor, workers and tests.
  const canonical = v => Array.isArray(v) ? "[" + v.map(canonical).join(",") + "]"
    : v && typeof v === "object" ? "{" + Object.keys(v).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}"
    : JSON.stringify(v) ?? "null";
  const K256 = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,
    0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
    0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  function sha256(text) {
    const data = new TextEncoder().encode(String(text)), n = data.length, blocks = Math.ceil((n + 9) / 64) * 64;
    const buf = new Uint8Array(blocks); buf.set(data); buf[n] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(blocks - 4, n * 8 >>> 0); dv.setUint32(blocks - 8, Math.floor(n / 0x20000000));
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    const rot = (x, k) => (x >>> k) | (x << (32 - k));
    for (let off = 0; off < blocks; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) w[i] = (rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 16] + (rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10)) + w[i - 7];
      let [a, b, c, d, e, f, g, k] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = k + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i] | 0;
        const t2 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c)) | 0;
        k = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
    }
    return Array.from(h, x => x.toString(16).padStart(8, "0")).join("");
  }
  // The digest a project bundle is trusted under: manifest (permissions, activation) and every file.
  const bundleDigest = (manifest, files) => "sha256:" + sha256(canonical([manifest, files || {}]));
  const later = fn => (globalThis.requestIdleCallback ? requestIdleCallback(fn, {timeout: 1000}) : setTimeout(fn, 50));

  // ------------------------------------------------------------------ manifest
  function validateAIProviders(providers, permissions, files, fail) {
    if (providers === undefined) return;
    if (!permissions.includes("ai:provider") || !Array.isArray(providers) || !providers.length || providers.length > 4)
      fail("contributes.aiProviders requires ai:provider and one to four providers.");
    const ids = new Set();
    for (const provider of providers) {
      if (!provider || typeof provider !== "object" || Array.isArray(provider) ||
          Object.keys(provider).some(key => !["id", "label", "entry", "hosts", "auth"].includes(key)) ||
          typeof provider.id !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(provider.id) || ids.has(provider.id) ||
          typeof provider.label !== "string" || !provider.label.trim() || provider.label.length > 80 ||
          typeof provider.entry !== "string" || !/^[a-zA-Z0-9_/-]+\.js$/.test(provider.entry) ||
          provider.entry.startsWith("/") || files && typeof files[norm(provider.entry)] !== "string" ||
          !Array.isArray(provider.hosts) || provider.hosts.length > 3 || new Set(provider.hosts).size !== provider.hosts.length ||
          provider.hosts.some(host => typeof host !== "string" || !AtriumAPI.isNetworkPermission("network:" + host) || !permissions.includes("network:" + host)))
        fail("each AI provider needs a unique id, label, source file and its declared network hosts.");
      if (provider.auth !== undefined && (!["bearer", "x-api-key"].includes(provider.auth) ||
          provider.hosts.length !== 1 || provider.hosts[0] === "localhost"))
        fail("a keychain credential requires one exact HTTPS provider host and a recognised header.");
      ids.add(provider.id);
    }
  }

  const MAX_THEMES = 20, MAX_THEME_CHARS = 512 * 1024;
  const MAX_THEME_BYTES = MAX_THEME_CHARS * 3 + 3; // UTF-8 text, including a possible BOM.
  const isJSONC = name => /\.jsonc$/i.test(name);
  const themePath = path => typeof path === "string" && /\.jsonc?$/i.test(path) ? norm(path) : null;
  function declaredThemePaths(manifest) {
    const themes = manifest?.contributes?.themes;
    return new Set(Array.isArray(themes) && themes.length <= MAX_THEMES
      ? themes.map(theme => themePath(theme?.path)).filter(Boolean) : []);
  }
  const keepPackageFile = (name, themes) => /\.(js|json|wasm)$/.test(name) || themes.has(name);

  // opts.builtin: the manifest came from the app bundle (app/extensions/<id>/manifest.json).
  function validateManifest(m, files, opts = {}) {
    const fail = msg => { throw Error("Invalid waffle-extension.json: " + msg); };
    if (!m || typeof m !== "object" || Array.isArray(m)) fail("expected an object.");
    if (typeof m.id !== "string" || !/^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/i.test(m.id) || m.id.length > 80) fail("id must look like publisher.name.");
    if (typeof m.name !== "string" || !m.name.trim()) fail("name is required.");
    if (typeof m.version !== "string" || !/^\d+\.\d+\.\d+([-+][\w.-]+)?$/.test(m.version)) fail("version must be semantic, e.g. 1.0.0.");
    if (Number(String(m.apiVersion).replace(/^\^/, "")) !== AtriumAPI.VERSION) fail("apiVersion " + m.apiVersion + " is not supported (this editor provides " + AtriumAPI.VERSION + ").");
    if (typeof m.main !== "string" || !/\.js$/.test(m.main)) fail("main must name a .js file.");
    if (files && typeof files[norm(m.main)] !== "string") fail("main file " + m.main + " is missing from the package.");
    const events = m.activationEvents ?? [];
    if (!Array.isArray(events) || events.some(e => typeof e !== "string" || !/^(\*|onStartup|onCommand:[\w.-]+|onDocumentKind:(pcb|schematic)|onView:[\w.-]+)$/.test(e))) fail("activationEvents must use onStartup, onCommand:id, onDocumentKind:pcb|schematic or onView:id.");
    const perms = m.permissions ?? [];
    if (!Array.isArray(perms) || !perms.every(AtriumAPI.isManifestPermission))
      fail("permissions may list " + AtriumAPI.PERMISSIONS.join(", ") + " and network:<exact host>.");
    const c = m.contributes ?? {};
    if (typeof c !== "object" || Array.isArray(c)) fail("contributes must be an object.");
    validateAIProviders(c.aiProviders, perms, files, fail);
    if (!opts.parked && notebookEnabled() && paletteDeclared(c) && globalThis.AtriumExtensionPaletteDeclarations) AtriumExtensionPaletteDeclarations.validate(m, files, fail);
    if (!opts.parked && notebookEnabled() && c.widgets !== undefined && globalThis.AtriumExtensionWidgetDeclarations) {
      AtriumExtensionWidgetDeclarations.validate(m);
    }
    for (const cmd of c.commands || []) if (typeof cmd?.command !== "string" || !/^[\w.-]+$/.test(cmd.command) || typeof cmd.title !== "string") fail("each contributed command needs command and title.");
    for (const [menu, list] of Object.entries(c.menus || {})) {
      if (!MENUS.includes(menu)) fail("unknown menu " + menu + ".");
      if (!Array.isArray(list) || list.some(x => typeof x?.command !== "string")) fail("menu entries need a command.");
    }
    for (const k of c.keybindings || []) if (typeof k?.command !== "string" || typeof k.key !== "string" || !parseKey(k.key)) fail("keybinding " + k?.key + " needs Ctrl, Alt or Cmd, or a function key.");
    for (const p of c.panels || []) if (typeof p?.id !== "string" || !/^[\w.-]+$/.test(p.id) || typeof p.title !== "string") fail("each panel needs id and title.");
    if (c.themes != null && (!Array.isArray(c.themes) || c.themes.length > MAX_THEMES)) fail("contributes.themes must be a list of at most 20 themes.");
    for (const th of c.themes || []) {
      if (typeof th?.id !== "string" || !/^[a-z0-9][\w.-]{0,62}$/i.test(th.id) || typeof th.label !== "string" || !th.label.trim() || th.label.length > 80) fail("each contributed theme needs an id and a label.");
      if (th.uiTheme != null && !["vs", "vs-dark", "hc-black", "hc-light"].includes(th.uiTheme)) fail("theme uiTheme must be vs, vs-dark, hc-black or hc-light.");
      const path = themePath(th.path);
      if (!path) fail("theme " + th.id + " needs a path to a .json file.");
      if (files && (typeof files[path] !== "string" || files[path].length > MAX_THEME_CHARS)) fail("theme file " + th.path + " is missing from the package or larger than 512 KB.");
    }
    for (const s of c.settings || []) if (typeof s?.key !== "string" || !["string", "number", "boolean", "enum"].includes(s.type)) fail("each setting needs key and a type of string, number, boolean or enum.");
    if (c.externalTools != null && (!Array.isArray(c.externalTools) || c.externalTools.length > 8)) fail("contributes.externalTools must be a list of at most 8 tools.");
    for (const t of c.externalTools || []) {
      if (typeof t?.id !== "string" || !/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(t.id) || typeof t.name !== "string" || !t.name.trim() || t.name.length > 80) fail("each external tool needs an id (lower case) and a name.");
      if (t.description != null && (typeof t.description !== "string" || t.description.length > 400)) fail("external tool " + t.id + ": description must be text under 400 characters.");
      if (t.homepage != null && (typeof t.homepage !== "string" || !/^https:\/\/[^\s]{1,300}$/.test(t.homepage))) fail("external tool " + t.id + ": homepage must be an https:// link.");
      // The argument template (docs/extensions.md, External programs): the arguments its runs pass besides
      // their own input and output file names; "{input}" or "{output}" (at most one) stands for one of those.
      if (t.args != null && (!Array.isArray(t.args) || t.args.length > 64 || t.args.some(a => typeof a !== "string" || !a || a.length > 200 || a.includes("\0") ||
        (a.split("{input}").length - 1) + (a.split("{output}").length - 1) > 1))) fail("external tool " + t.id + ": args must list at most 64 arguments, each with at most one {input} or {output}.");
    }
    const has = p => perms.includes(p);
    if ((c.externalTools || []).length && !has("run:external")) fail("contributes.externalTools needs the run:external permission.");
    if (has("run:external") && !(c.externalTools || []).length) fail("run:external needs contributes.externalTools naming the programs it runs.");
    if (((c.commands || []).length || Object.keys(c.menus || {}).length || (c.keybindings || []).length) && !has("ui:command")) fail("commands, menus and keybindings need the ui:command permission.");
    if ((c.panels || []).length && !has("ui:panel")) fail("panels need the ui:panel permission.");
    if (m.builtin != null && (m.builtin !== true || !opts.builtin)) fail("only extensions bundled with Waffle may declare builtin.");
    if (m.enabledByDefault != null && typeof m.enabledByDefault !== "boolean") fail("enabledByDefault must be true or false.");
    if (m.worker != null && !["shared", "dedicated"].includes(m.worker)) fail("worker must be shared or dedicated.");
    const most = m.worker === "dedicated" ? LONG_TIMEOUT : MAX_TIMEOUT;
    if (m.timeoutMs != null && !(m.timeoutMs >= 100 && m.timeoutMs <= most)) fail("timeoutMs must be between 100 and " + most + (m.worker === "dedicated" ? "." : " (" + LONG_TIMEOUT + " with a dedicated worker)."));
    return m;
  }
  const norm = p => String(p).replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

  // ------------------------------------------------------------- code storage
  // Manifests live in localStorage (read synchronously at startup); code lives in
  // IndexedDB and is read only when an extension activates.
  const memoryCode = new Map();
  let dbPromise = null;
  function db() {
    if (!globalThis.indexedDB) return Promise.resolve(null);
    return dbPromise ??= new Promise(resolve => {
      try {
        const r = indexedDB.open("atrium-extensions", 1);
        r.onupgradeneeded = () => r.result.createObjectStore("packages");
        r.onsuccess = () => resolve(r.result);
        r.onerror = r.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  async function idb(mode, fn) {
    const d = await db();
    if (!d) return undefined;
    return new Promise(resolve => {
      try {
        const t = d.transaction("packages", mode), req = fn(t.objectStore("packages"));
        t.oncomplete = () => resolve(req?.result);
        t.onerror = t.onabort = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
  }
  const code = {
    async put(id, files) {
      memoryCode.set(id, files);
      if (await idb("readwrite", s => s.put(files, id)) === undefined) ls.set("atrium.ext.code." + id, files);
    },
    async get(id) {
      if (memoryCode.has(id)) return memoryCode.get(id);
      const files = await idb("readonly", s => s.get(id)) || ls.get("atrium.ext.code." + id, null);
      return files;
    },
    async delete(id) { memoryCode.delete(id); await idb("readwrite", s => s.delete(id)); ls.del("atrium.ext.code." + id); }
  };

  // --------------------------------------------------------------------- state
  let host = null, registry = null, options = {}, managerView = null, managerTimer = 0, whenNodes = 0;
  let activationEpoch = 0;
  const exts = new Map();     // id -> record
  const pools = new Map();    // key -> pool
  let lastProject = null, lastBundles = null, lastBundleCount = 0, lastKind = null, keyListener = null, scriptCount = 0;
  const kindWatchers = new Set();
  const stats = {batchesOut: 0, messagesOut: 0, batchesIn: 0, messagesIn: 0};
  const changed = new Set();  // repaint scheduling for the manager
  function record(manifest, origin, enabled) {
    return {id: manifest.id, manifest, origin, enabled, status: enabled ? "inactive" : "disabled", errors: [], logs: [], strikes: 0,
      activation: null, core: null, statusItems: new Map(), panels: new Map(), menuItems: [], keymap: [], subs: new Set(), storage: null,
      perms: {}, modal: false, dialogs: new Set(), dismissals: [], rate: {at: 0, calls: 0, logs: 0}};
  }
  function recordOf(manifest, origin, enabled) { const e = record(manifest, origin, enabled); syncPerms(e); return e; }
  // Installed extensions this build can't load (a newer apiVersion, permission or menu a newer Waffle
  // installed) stay in the index unchanged, so going back to the newer build still finds them.
  const foreignRows = [];
  function saveIndex() {
    const rows = [...exts.values()].filter(e => e.origin === "user").map(e => ({manifest: e.manifest, enabled: e.enabled, ...(e.manifest.contributes?.mathFunctions?.length && e.hash ? {packageDigest: e.hash} : {})}));
    for (const row of foreignRows) if (!exts.has(row?.manifest?.id)) rows.push(row);
    ls.set(INDEX_KEY, rows);
  }
  // First-party contributions come from the manifest index. A package is kept as inert strings
  // until the extension needs it.
  const builtinFiles = new Map();
  const builtinLoads = new Map();
  // Extensions that fail validation at startup are listed in the Messages panel (attach()).
  const skippedExts = [];
  const skipped = (what, err) => skippedExts.push({class: "Warning", source: "Extensions", text: what + ": " + (err?.message || err) + " It was not loaded."});
  function reportSkipped() {
    const rows = skippedExts.splice(0), n = rows.length;
    if (!n) return;
    host?.info?.(n === 1 ? "An extension was skipped: see Window › Messages." : n + " extensions were skipped: see Window › Messages.");
    const put = M => M.update("Extensions", rows);
    if (globalThis.AtriumMessages) put(globalThis.AtriumMessages); else globalThis.AtriumLazy?.need?.("AtriumMessages").then(put, () => {});
  }
  function loadBuiltins() {
    const state = ls.get(BUILTIN_STATE, {});
    const entries = globalThis.AtriumBuiltinExtensionManifests ?? [];
    for (const b of entries) {
      try {
        const manifest = clone(b.manifest);
        validateManifest(manifest, undefined, {builtin: true});
        if (manifest.builtin !== true || exts.has(manifest.id)) continue;
        exts.set(manifest.id, recordOf(manifest, "builtin", state[manifest.id] ?? manifest.enabledByDefault !== false));
      } catch (err) { skipped("Built-in extension " + (b?.path || ""), err); }
    }
  }
  function readBuiltinFiles(id) {
    const path = "extensions/packages/" + id + ".js";
    if (!doc && typeof require === "function") return require("../" + path);
    const failed = () => Error("Couldn't load the built-in extension " + id + ".");
    if (!doc) throw failed();
    return new Promise((resolve, reject) => {
      const script = doc.createElement("script");
      script.src = scriptBase ? new URL(path, scriptBase).href : path;
      script.onload = () => {
        script.remove();
        const packages = globalThis.AtriumBuiltinExtensionPackages, files = packages?.[id];
        if (files) { delete packages[id]; resolve(files); }
        else reject(failed());
      };
      script.onerror = () => { script.remove(); reject(failed()); };
      doc.head.append(script);
    });
  }
  function builtinPackage(e) {
    const cached = builtinFiles.get(e.id);
    if (cached) return cached;
    if (builtinLoads.has(e.id)) return builtinLoads.get(e.id);
    const load = Promise.resolve().then(() => readBuiltinFiles(e.id)).then(files => {
      const manifest = JSON.parse(files["manifest.json"]);
      if (canonical(manifest) !== canonical(e.manifest)) throw Error("The package for " + e.manifest.name + " does not match its manifest.");
      validateManifest(manifest, files, {builtin: true});
      builtinFiles.set(e.id, files);
      return files;
    }).finally(() => builtinLoads.delete(e.id));
    builtinLoads.set(e.id, load);
    return load;
  }
  function loadIndex() {
    for (const row of ls.get(INDEX_KEY, [])) {
      try {
        validateManifest(row.manifest,null,{parked:true});
        if (exts.has(row.manifest.id)) continue;
        const e = recordOf(row.manifest, "user", row.enabled !== false);
        if (/^sha256:[a-f0-9]{64}$/.test(row.packageDigest || "")) e.hash = row.packageDigest;
        exts.set(e.id, e);
      }
      catch (e) { skipped("Extension " + (row?.manifest?.id || "(no id)"), e); foreignRows.push(row); }
    }
  }
  const log = (e, level, text) => {
    e.logs.push({time: Date.now(), level, text});
    if (e.logs.length > 200) e.logs.splice(0, e.logs.length - 200);
    if (level === "error") { e.errors.push(text); if (e.errors.length > 20) e.errors.shift(); }
    touch(e);
  };
  function touch(e) { changed.add(e?.id); if (managerView) scheduleManager(); }
  // Storage and settings follow the trust pin, as grants do (security review F6): installed and
  // built-in extensions by id, a project bundle by id@sha256 of that exact bundle, an unpacked load
  // in memory only. Data stored under a bare id is never handed to a project bundle or an unpacked load.
  const dataKey = e => e.origin === "project" ? "project:" + e.id + "@" + e.hash : e.origin === "dev" ? "dev:" + e.id : e.id;
  // Unpacked loads are forgotten when Waffle quits (F9): drop grants, settings and storage they left.
  function purgeDevData() {
    const live = new Set([...exts.values()].filter(e => e.origin === "dev").map(e => e.id));
    const grants = ls.get(GRANTS, {});
    let dirty = false;
    for (const k of Object.keys(grants)) if (k.startsWith("dev:") && !live.has(k.slice(4).split("@")[0])) { delete grants[k]; dirty = true; }
    if (dirty) ls.set(GRANTS, grants);
    const keys = new Set(memory.keys());
    try { for (let i = 0; i < (globalThis.localStorage?.length || 0); i++) keys.add(globalThis.localStorage.key(i)); } catch {}
    for (const k of keys) for (const p of [SETTINGS + "dev:", STORE + "dev:"]) if (k?.startsWith(p) && !live.has(k.slice(p.length))) ls.del(k);
  }
  const settingsOf = e => {
    const stored = ls.get(SETTINGS + dataKey(e), {}), out = {};
    for (const s of e.manifest.contributes?.settings || []) out[s.key] = s.key in stored ? stored[s.key] : s.default ?? null;
    return out;
  };
  function storageOf(e) {
    if (e.storage) return e.storage;
    // An unpacked load's storage lives in memory for the session only (F6, F9).
    const key = STORE + dataKey(e), persist = e.origin !== "dev";
    const map = new Map(persist ? Object.entries(ls.get(key, {})) : []);
    let timer = null;
    map.flush = () => { if (!persist) return; clearTimeout(timer); timer = setTimeout(() => { if (!ls.set(key, Object.fromEntries(map))) log(e, "error", "Extension storage is full."); }, 100); };
    return e.storage = map;
  }

  // ------------------------------------------------------------------- pools
  // A pool is one worker and the single principal it runs: an extension ("ext:<id>")
  // or one console script run ("script:<n>").
  function workerSource(config, viaPort) {
    const main = globalThis.AtriumExtensionHostWorker;
    if (typeof main !== "function") throw Error("The extension host runtime is unavailable.");
    const call = "(" + main.toString() + ")(self, " + AtriumAPI.facade.toString() + ", " + JSON.stringify(config);
    if (!viaPort) return '"use strict";\n' + call + ");\n";
    // In the sandbox the first message carries the worker's private MessagePort.
    return '"use strict";\nself.addEventListener("message", function boot(ev) {\n  if (!ev.data || !ev.data.port) return;\n' +
      '  self.removeEventListener("message", boot);\n  ' + call + ", ev.data.port);\n});\n";
  }
  function loadRuntime() {
    if (globalThis.AtriumExtensionHostWorker || !doc) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = doc.createElement("script");
      s.src = new URL("workers/extension-host-worker.js", scriptBase).href;
      s.onload = () => resolve(); s.onerror = () => reject(Error("Could not load the extension host runtime."));
      doc.head.append(s);
    });
  }
  // The sandbox: a hidden iframe with an opaque origin (sandbox="allow-scripts", no
  // allow-same-origin) and a CSP that allows no network, no plugins and no navigation.
  // Workers it creates from Blob URLs inherit that CSP, which blocks fetch, XHR,
  // WebSocket, EventSource, importScripts, FontFace and dynamic import() of anything but
  // blob: modules — below JavaScript, so no global the runtime forgets can leak.
  const SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; worker-src blob:; base-uri 'none'; form-action 'none'";
  const SANDBOX_DOC = '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + SANDBOX_CSP + '"><script>"use strict";\n' +
    '(() => { let control = null; const workers = new Map();\n' +
    '  addEventListener("message", ev => {\n' +
    '    if (control || ev.source !== parent || !ev.ports || !ev.ports[0]) return;\n' +
    '    control = ev.ports[0];\n' +
    '    control.onmessage = e => { const m = e.data || {};\n' +
    '      if (m.t === "spawn") {\n' +
    '        const url = URL.createObjectURL(new Blob([m.source], {type: "text/javascript"}));\n' +
    '        try { const w = new Worker(url); workers.set(m.id, w);\n' +
    '          w.onerror = x => { x.preventDefault(); control.postMessage({t: "error", id: m.id, message: String(x.message || "The extension worker failed.")}); };\n' +
    '          w.postMessage({port: m.port}, [m.port]); }\n' +
    '        catch (err) { control.postMessage({t: "error", id: m.id, message: String(err && err.message || err)}); }\n' +
    '        finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }\n' +
    '      } else if (m.t === "kill") { const w = workers.get(m.id); workers.delete(m.id); if (w) w.terminate(); }\n' +
    '    };\n' +
    '    control.postMessage({t: "ready"});\n' +
    '  });\n' +
    '})();\n<\/script>';
  let sandbox = null;
  function sandboxFrame() {
    if (sandbox) return sandbox;
    if (!doc || typeof MessageChannel !== "function" || typeof Worker !== "function") throw Error("This webview cannot run extensions in a sandbox.");
    const iframe = doc.createElement("iframe"), ch = new MessageChannel();
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("aria-hidden", "true"); iframe.tabIndex = -1; iframe.title = "Extension sandbox";
    iframe.style.cssText = "display:none";
    iframe.srcdoc = SANDBOX_DOC;
    const f = sandbox = {iframe, control: ch.port1, workers: new Map(), seq: 0, idle: 0};
    f.ready = new Promise((resolve, reject) => {
      iframe.addEventListener("load", () => { try { iframe.contentWindow.postMessage({t: "atrium-sandbox"}, "*", [ch.port2]); } catch (e) { reject(e); } }, {once: true});
      ch.port1.onmessage = ev => { const m = ev.data || {}; if (m.t === "ready") resolve(); else if (m.t === "error") f.workers.get(m.id)?.fail(m.message); };
    });
    f.ready.catch(() => {});
    (doc.body || doc.documentElement).append(iframe);
    return f;
  }
  // Remove the sandbox document a while after its last worker ends.
  function sandboxIdle() {
    const f = sandbox;
    if (!f) return;
    clearTimeout(f.idle);
    if (!f.workers.size) f.idle = setTimeout(() => { if (sandbox === f && !f.workers.size) { f.iframe.remove(); f.control.close(); sandbox = null; } }, 30000);
  }
  function sandboxWorker(source) {
    const f = sandboxFrame(), id = ++f.seq, ch = new MessageChannel();
    clearTimeout(f.idle);
    const w = {inline: false, onmessage: null, onerror: null, dead: false,
      postMessage: (m, transfer) => { if (!w.dead) ch.port1.postMessage(m, transfer || []); },
      terminate() {
        if (w.dead) return;
        w.dead = true; f.workers.delete(id);
        try { f.control.postMessage({t: "kill", id}); } catch {}
        ch.port1.close(); sandboxIdle();
      },
      fail(message) { if (!w.dead) w.onerror?.({message, preventDefault() {}}); }};
    ch.port1.onmessage = ev => { if (!w.dead) w.onmessage?.(ev); };
    f.workers.set(id, w);
    f.ready.then(() => { if (!w.dead) f.control.postMessage({t: "spawn", id, source, port: ch.port2}, [ch.port2]); },
      err => w.fail("The extension sandbox could not start: " + (err?.message || err)));
    return w;
  }
  // Extension code only ever runs in a Worker (its own realm, no DOM and no editor
  // globals). Without Worker support extensions do not run at all: the editor realm
  // never evaluates extension or script text.
  function createWorker(config) {
    if (options.createWorker) return options.createWorker(workerSource(config, false), config);
    return sandboxWorker(workerSource(config, true));
  }
  function pool(key, config, owner) {
    let p = pools.get(key);
    if (p) { if (!p.worker) p.config = config; return p; }
    p = {key, config, owner, worker: null, ready: null, queue: [], moving: [], scheduled: false, requests: new Map(), nextCid: 0,
      members: new Set(), subs: new Map(), nets: new Map(), idle: null, inline: false, paused: 0, cpu: [], watch: 0, lastUse: Date.now()};
    p.post = (m, transfer) => { p.queue.push(m); if (transfer) p.moving.push(...transfer); if (!p.scheduled) { p.scheduled = true; Promise.resolve().then(() => flush(p)); } };
    pools.set(key, p);
    return p;
  }
  function flush(p) {
    p.scheduled = false;
    if (!p.queue.length || !p.worker) { p.queue.length = 0; p.moving = []; return; }
    const batch = p.queue, transfer = p.moving; p.queue = []; p.moving = [];
    stats.batchesOut++; stats.messagesOut += batch.length;
    if (globalThis.AtriumDiagnostics?.performance) for (const message of batch) p.requests.get(message.cid)?.timing?.start();
    try { p.worker.postMessage({batch}, transfer); }
    catch {
      // One uncloneable reply must not drop the rest of the batch: send each message on
      // its own, and turn a reply that cannot be cloned into an error for its caller.
      for (const m of batch) {
        try { p.worker.postMessage({batch: [m]}, transfer.filter(b => m.value === b)); }
        catch { try { p.worker.postMessage({batch: [m.t === "reply" ? {t: "reply", rid: m.rid, ok: false, error: {message: "The result could not be sent to the extension (it is not plain data)."}} : {t: "noop"}]}); } catch {} }
      }
    }
  }
  async function start(p) {
    if (p.worker) return p.ready;
    const timing = globalThis.AtriumDiagnostics?.performance?.begin("extensions", "load");
    let w;
    try {
      await loadRuntime();
      if (p.cancelled) throw p.ai ? aiError("cancelled", "The AI request was cancelled.") : Error("Search cancelled.");
      w = p.worker = createWorker({...p.config, heartbeat: heartbeatMs()});
    } catch (error) {
      timing?.end(p.cancelled ? "cancelled" : "failed");
      throw error;
    }
    let resolveReady, rejectReady;
    p.ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
    p.inline = !!w.inline; p.cpu = []; p.lastUse = Date.now();
    const timer = setTimeout(() => stop(p, "The extension host did not start."), 5000);
    w.onmessage = ev => {
      if (p.worker !== w) return;
      const n = ev.data?.batch?.length || 0;
      stats.batchesIn++; stats.messagesIn += n;
      if (n > LIMITS.batchMessages) { stop(p, "An extension flooded the host with messages and was stopped."); return; }
      for (const m of ev.data?.batch || []) {
        if (p.worker !== w) return;
        if (m?.t === "ready") {
          clearTimeout(timer); timing?.ready(); timing?.end("completed"); resolveReady(); watch(p);
        }
        else if (m?.t === "paletteRows" && p.search && p.requests.has(m.cid)) {
          try { p.search.emit(m.rows); } catch { p.search.cancel(); }
        }
        else if (m?.t === "call") onCall(p, m);
        else if (m?.t === "done") { const r = p.requests.get(m.cid); if (r) { p.requests.delete(m.cid); if (m.ok) r.resolve(m.value); else r.reject(Object.assign(Error(m.error?.message || "Extension error"), {stackText: m.error?.stack})); } }
        else if (m?.t === "log" && !p.ai) onLog(p.owner, m.level, m.text);
        else if (m?.t === "beat") onBeat(p, m.busy);
      }
    };
    w.onerror = ev => { ev.preventDefault?.(); stop(p, ev.message || "The extension host stopped."); };
    p.ready.catch(() => {});
    p._rejectReady = (error, outcome) => { clearTimeout(timer); timing?.end(outcome); rejectReady(error); };
    return p.ready;
  }
  function stop(p, reason, outcome = "failed") {
    if (p.ai) p.cancelled = true;
    if (!p.worker) return;
    const error = reason instanceof Error ? reason : Error(reason);
    try { p.worker.terminate(); } catch {}
    p.worker = null; p.queue.length = 0; p.moving = [];
    p._rejectReady?.(error, outcome);
    for (const [cid, r] of p.requests) { p.requests.delete(cid); r.reject(error, outcome); }
    for (const n of p.nets.values()) { try { n.ctrl?.abort(); } catch {} }
    p.nets.clear();
    for (const id of p.members) { const e = exts.get(id); if (e) { deactivateLocal(e); if (e.status === "active" || e.status === "activating") e.status = "inactive"; touch(e); } }
    for (const set of p.subs.values()) set.off?.();
    p.members.clear(); p.subs.clear(); p.paused = 0; p.cpu = [];
    clearTimeout(p.idle); clearTimeout(p.watch);
    if (p.key.startsWith("script:")) pools.delete(p.key);
    sweep();
  }
  // Outside a running command, and while the worker waits for the user, it must keep
  // beating and stay within its CPU budget.
  const unattended = p => !p.requests.size || p.paused > 0;
  function cpuStop(p, why) {
    const e = exts.get(p.owner), name = e?.manifest.name || "A script";
    if (e) { e.strikes++; log(e, "error", "Stopped: " + why + "."); }
    host?.info?.(name + " " + why + " and was stopped.");
    stop(p, name + " " + why + " and was stopped.");
    if (e && e.strikes >= 3) setEnabled(e.id, false, "Disabled after repeatedly overrunning its limits.");
  }
  function watch(p) {
    clearTimeout(p.watch);
    if (!p.worker || !(heartbeatMs())) return;
    p.watch = setTimeout(() => { if (!p.worker) return; if (unattended(p)) cpuStop(p, "stopped responding"); else watch(p); }, cpu().silenceMs);
  }
  const heartbeatMs = () => options.heartbeatMs ?? (options.createWorker ? 0 : cpu().beatMs);
  function onBeat(p, busy) {
    watch(p);
    if (!unattended(p)) { p.cpu = []; return; }
    p.cpu.push(Math.max(0, Number(busy) || 0));
    if (p.cpu.length > cpu().window) p.cpu.shift();
    if (p.cpu.length >= 3 && p.cpu.reduce((a, b) => a + b, 0) > cpu().budgetMs) cpuStop(p, "used too much processor time in the background");
  }
  function request(p, message, timeoutMs, owner) {
    return new Promise((resolve, reject) => {
      const cid = ++p.nextCid;
      p.lastUse = Date.now();
      const fire = () => {
        // Time spent waiting for the user (consent, review, dialogs) does not count.
        if (p.paused > 0) { entry.timer = setTimeout(fire, timeoutMs); return; }
        const e = exts.get(owner);
        if (e) { e.strikes++; log(e, "error", "Stopped: exceeded the " + timeoutMs + " ms time limit."); if (e.strikes >= 3) setEnabled(e.id, false, "Disabled after repeated time-outs."); }
        stop(p, (e?.manifest.name || "A script") + " exceeded its " + timeoutMs + " ms time limit and its worker was stopped.");
      };
      const performance = globalThis.AtriumDiagnostics?.performance;
      const timing = message.t === "script" ? performance?.queue("automation", "command") : performance?.queue("extensions", "request");
      const entry = {timer: setTimeout(fire, timeoutMs), slow: setTimeout(() => slowNotice(p, owner, true), LIMITS.slowMs), timing,
        resolve: v => { timing?.ready(); done("completed"); resolve(v); },
        reject: (e, outcome = "failed") => { done(outcome); reject(e); }};
      const done = outcome => {
        timing?.end(outcome); clearTimeout(entry.timer); clearTimeout(entry.slow); p.lastUse = Date.now(); slowNotice(p, owner, false);
      };
      p.requests.set(cid, entry);
      p.post({...message, cid});
    });
  }
  // Kill switch in the status bar while extension work runs longer than a second.
  function slowNotice(p, owner, on) {
    const r = scriptRecord("waffle.kill");
    if (!on) { if (![...pools.values()].some(q => [...q.requests.values()].some(x => x.slowShown))) ui.status(r, "stop", null); return; }
    for (const x of p.requests.values()) x.slowShown = true;
    ui.status(r, "stop", {text: "■ Stop " + (exts.get(owner)?.manifest.name || "script"), tooltip: "Stop the running extension or script", _action: () => stop(p, "Stopped by the user.", "cancelled")});
  }
  // Keep a pool's time limit from firing while the user answers a prompt.
  function hold(p, value) {
    if (!value || typeof value.then !== "function") return value;
    const worker = p.worker;
    p.paused++;
    return value.finally(() => { if (p.worker === worker) p.paused--; });
  }
  function scheduleIdle(p) {
    clearTimeout(p.idle);
    if (!p.members.size && !p.requests.size) stop(p, "idle");
  }
  // Active extensions with nothing to show and nothing to do stop after IDLE_STOP;
  // their commands, panels and events reactivate them on demand.
  let sweepTimer = 0;
  function sweep() {
    clearTimeout(sweepTimer); sweepTimer = 0;
    const live = [...pools.values()].filter(p => p.worker && p.key.startsWith("ext:"));
    if (!live.length) return;
    for (const p of live) {
      const e = exts.get(p.owner);
      if (!e || e.status !== "active" || p.requests.size || p.nets.size || Date.now() - p.lastUse < IDLE_STOP) continue;
      if ([...p.subs].some(([name, set]) => !PANEL_EVENTS.has(name) && set.size) || e.statusItems.size || decorations.has(e.id) || externalRuns.has(e.id) || [...e.panels.values()].some(x => x.open)) continue;
      log(e, "info", "Stopped after " + IDLE_STOP / 60000 + " idle minutes; it starts again when needed.");
      deactivate(e.id);
    }
    sweepTimer = setTimeout(sweep, 60000);
  }

  // Approximate message size in characters/bytes, without serialising binary data.
  function sizeOf(v, depth = 0) {
    if (v == null || typeof v === "boolean" || typeof v === "number") return 8;
    if (typeof v === "string") return v.length;
    if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v.byteLength;
    if (depth > 64 || typeof v !== "object") throw Error("API arguments must be plain data.");
    // Objects count 16 even when empty, so a view of many empty cells is not "small".
    let n = 16;
    for (const k in v) { n += k.length + 2 + sizeOf(v[k], depth + 1); if (n > LIMITS.messageChars) return n; }
    return n;
  }
  // Calls from the worker. Permissions are enforced here, never in the worker. Every
  // message is attributed to the pool's own principal; the `ext` it names is ignored.
  const contexts = new Map(); // ext id (incl. scripts) -> {core, pool, rate, perms}
  function onCall(p, m) {
    const c = p.ai || p.search || contexts.get(p.owner);
    p.lastUse = Date.now();
    const worker = p.worker;
    const reply = (ok, value, error) => {
      if (p.worker === worker) p.post({t: "reply", rid: m.rid, ok, value, error}, value instanceof ArrayBuffer ? [value] : null);
    };
    if (!c || c.pool !== p) { reply(false, undefined, {message: "Unknown extension context."}); return; }
    try {
      // Rate and size limits apply to every message before anything else runs.
      const now = Date.now(), rate = c.rate;
      if (now - rate.at > 1000) { rate.at = now; rate.calls = 0; }
      if (++rate.calls > (p.search || p.ai ? 64 : LIMITS.callsPerSecond)) throw Error("Too many API calls; the limit is " + LIMITS.callsPerSecond + " per second.");
      if (typeof m.method !== "string" || !Array.isArray(m.args)) throw Error("Malformed API call.");
      const size = sizeOf(m.args);
      if (size > LIMITS.messageChars) throw Error("The API call is too large (" + size + " characters).");
      if (m.method.startsWith("net.")) { net(p, m.method, m.args).then(x => reply(true, x), e => reply(false, undefined, {message: e.message})); return; }
      if (p.ai) throw Error("AI providers receive project data only from the approved tool broker.");
      if (p.search) throw Error("Search providers have read-only access to their declared hosts.");
      const e = exts.get(p.owner);
      if (e && e.writeTarget !== writeTarget()) syncPerms(e);
      const perm = c.core.handlers[m.method]?.[0];
      // Replies already queued hold live references; send them before an edit.
      if (perm === "edit") flush(p);
      const v = hold(p, c.core.call(m.method, m.args, false));
      if (v && typeof v.then === "function") v.then(x => reply(true, x), e => reply(false, undefined, {message: e.message}));
      else reply(true, v);
    } catch (e) { reply(false, undefined, {message: e.message}); }
  }
  function onLog(id, level, text) {
    const c = contexts.get(id);
    if (c) {
      const now = Date.now(), rate = c.rate;
      if (now - rate.at > 1000) { rate.at = now; rate.calls = 0; rate.logs = 0; }
      if (++rate.logs > LIMITS.logsPerSecond) { if (rate.logs === LIMITS.logsPerSecond + 1) text = "(further output this second was dropped)"; else return; }
    }
    level = ["debug", "info", "warn", "error"].includes(level) ? level : "info";
    text = String(text ?? "").slice(0, 4000);
    if (c?.onLog) c.onLog(level, text);
    const e = exts.get(id);
    if (e) log(e, level, text);
  }
  // network:<host>: the host makes the request for the worker, after checking the
  // live grant, and streams the body back in chunks. No cookies, no redirects.
  let netSeq = 0;
  const parseUrl = href => {
    if (typeof URL === "function") return new URL(href);
    const m = /^(https?:)\/\/(?:([^@/?#]*)@)?([a-z0-9.-]+(?::\d{1,5})?)([/?#][^\s]*)?$/i.exec(href);
    if (!m) throw Error("Invalid URL.");
    return {protocol: m[1].toLowerCase(), username: m[2] || "", password: "", host: m[3].toLowerCase(), href: m[1].toLowerCase() + "//" + m[3].toLowerCase() + (m[4] || "/")};
  };
  async function net(p, method, args) {
    const e = exts.get(p.owner);
    if (!e) throw Error("Scripts have no network access.");
    if (p.ai && !p.ai.available()) throw Error("The AI permission or project changed.");
    if (method === "net.fetch") {
      const [href, init = {}] = args;
      let url;
      try { url = parseUrl(String(href)); } catch { throw Error("Invalid URL."); }
      const hosts = hostsOf(e).filter(h => (!p.search || p.search.hosts.includes(h)) && (!p.ai || p.ai.hosts.includes(h)));
      if (p.search && (!paletteAvailable(e, true) || p.cancelled)) throw Error("Search cancelled.");
      const loopback = hosts.includes("localhost") && /^https?:$/.test(url.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(url.host);
      if ((!loopback && (url.protocol !== "https:" || !hosts.includes(url.host))) || url.username || url.password)
        throw Error(e.manifest.name + " may not contact " + url.host + ". Allow network:" + url.host + " in Tools › Extensions.");
      const methodName = String(init.method || "GET").toUpperCase();
      if (!(p.search ? ["GET", "HEAD"] : ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).includes(methodName)) throw Error("Unsupported HTTP method " + methodName + ".");
      if (p.nets.size >= 8) throw Error("Too many open requests.");
      const headers = (Array.isArray(init.headers) ? init.headers : []).filter(h => Array.isArray(h) && h.length === 2).map(([k, v]) => [String(k), String(v)]);
      const body = init.body == null ? undefined : typeof init.body === "string" || init.body instanceof ArrayBuffer ? init.body : String(init.body);
      if (p.ai) {
        if (!["GET", "POST"].includes(methodName) || sizeOf(body) > 65536 || headers.length > 24)
          throw Error("The AI network request exceeds its permitted shape.");
        if (headers.some(([name]) => /^(authorization|x-api-key|cookie|proxy-authorization)$/i.test(name)))
          throw Error("Provider credentials are supplied by the system keychain.");
      }
      const doFetch = options.fetch || globalThis.fetch;
      if (typeof doFetch !== "function") throw Error("This editor cannot make network requests.");
      const ctrl = typeof AbortController === "function" ? new AbortController() : null;
      // Count and cancel requests throughout credential lookup and network I/O.
      const id = ++netSeq, out = [];
      p.nets.set(id, {ctrl});
      let res;
      try {
        if (p.ai?.auth) {
          const account = p.ai.account, load = globalThis.AtriumHost?.aiCredential;
          let key, error;
          if (typeof load === "function") {
            try { key = await load.call(globalThis.AtriumHost,"load",account); }
            catch { error = aiError("credential_unavailable","The system credential store is unavailable."); }
          } else error = aiError("credential_unavailable","The system credential store is unavailable.");
          if (!p.worker || !p.nets.has(id) || !p.ai.available()) throw aiError("stale_source","The AI permission or project changed.");
          if (key?.available === false) error = aiError("credential_unavailable","The system credential store is unavailable.");
          else if (!error && (typeof key !== "string" || !key)) error = aiError("credential_missing","Add this provider's credential to the system credential store first.");
          if (error) { stop(p,error); throw error; }
          if (!p.ai.secrets.has(key) && p.ai.secrets.size >= 4) throw Error("The provider credential changed too many times.");
          p.ai.secrets.add(key);
          headers.push(p.ai.auth === "bearer" ? ["Authorization", "Bearer " + key] : ["x-api-key", key]);
        }
        if (p.ai && !p.ai.available()) throw aiError("stale_source","The AI permission or project changed.");
        res = await doFetch(url.href, {method: methodName, headers, body, redirect: "error", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", signal: ctrl?.signal});
      } catch (error) { p.nets.delete(id); throw error; }
      if (!p.worker || !p.nets.has(id)) { ctrl?.abort(); throw Error("The extension stopped."); }
      try { res.headers?.forEach?.((v, k) => out.push([k, v])); } catch {}
      p.nets.set(id, {ctrl, reader: res.body?.getReader?.() || null, res, bytes: 0});
      return {id, status: res.status, statusText: String(res.statusText || ""), headers: out};
    }
    const n = p.nets.get(args[0]);
    if (method === "net.abort") { if (n) { p.nets.delete(args[0]); try { n.ctrl?.abort(); n.reader?.cancel?.().catch?.(() => {}); } catch {} } return null; }
    if (method !== "net.read") throw Error("Unknown network call.");
    if (!n) throw Error("The response is closed.");
    if (!n.reader) {
      if (n.done) { p.nets.delete(args[0]); return null; }
      n.done = true;
      const t = await n.res.arrayBuffer?.();
      if (t && t.byteLength > (p.ai ? 131072 : MAX_NET_BYTES)) throw Error("The response exceeded its size limit.");
      return t && t.byteLength ? t : (p.nets.delete(args[0]), null);
    }
    const {done, value} = await n.reader.read();
    if (done || value == null) { p.nets.delete(args[0]); return null; }
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
    if ((n.bytes += bytes.byteLength) > (p.ai ? 131072 : MAX_NET_BYTES)) { p.nets.delete(args[0]); n.ctrl?.abort(); throw Error("The response exceeded its size limit."); }
    return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  }

  // ------------------------------------------------------------- API binding
  function hostAdapter() {
    if (!host) throw Error("Extensions need the editor. AtriumExtensions.attach(host) has not been called.");
    return host;
  }
  function makeCore(id, permissions, extra = {}) {
    const e = exts.get(id);
    const core = AtriumAPI.create(hostAdapter(), {
      async inspectMotion(action, args) {
        const D = globalThis.AtriumMotionDiagnostics ?? await globalThis.AtriumLazy?.need("AtriumMotionDiagnostics");
        if (!D) throw Error("Motion diagnostics are unavailable.");
        return D.inspect(action, args);
      },
      extension: {id, permissions},
      registry, ui: uiFor(), localCommands: new Map(),
      storage: e ? storageOf(e) : extra.storage,
      settings: () => (e ? settingsOf(e) : {}),
      dispatch: (cmd, args) => {
        const target = registry?.commands.get(String(cmd)), owner = target ? target.owner : [...exts.values()].find(x => (x.manifest.activationEvents || []).includes("onCommand:" + cmd))?.id;
        if (typeof cmd === "string" && !cmd.startsWith("waffle.") && !cmd.startsWith("atrium.") && owner !== id) throw Error("Extensions can only run their own commands (" + cmd + " belongs to " + (owner || "no extension") + ").");
        return execute(cmd, ...args);
      },
      subscribe: name => subscribe(id, name),
      approve: e ? info => approve(e, info) : undefined,
      assets: e ? path => readAsset(e, path) : undefined,
      external: e ? externalFor(e) : undefined,
      alive: () => contexts.get(id)?.core === core && (!e || e.enabled && exts.get(id) === e) && !safeMode(),
      target: writeTarget, editEpoch: () => e?.editEpoch || 0,
      group: extra.group, deadline: extra.deadline, trusted: extra.trusted,
      log: (level, a) => onLog(id, level, a.join(" "))
    });
    return core;
  }
  // Binary files bundled in the package (stored as base64 data strings) for the
  // extension's own use, e.g. WebAssembly.instantiate(await api.assets.read("x.wasm")).
  async function readAsset(e, path) {
    const files = await packageOf(e), data = files?.[norm(path)];
    if (typeof data !== "string") throw Error(path + " is not in " + e.manifest.name + "'s package.");
    const m = /^data:[^;,]*;base64,(.*)$/.exec(data);
    const bytes = m ? fromBase64(m[1]) : new TextEncoder().encode(data);
    return bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer;
  }
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  function toBase64(u8) {
    let out = "";
    for (let i = 0; i < u8.length; i += 3) {
      const n = u8[i] << 16 | (u8[i + 1] ?? 0) << 8 | (u8[i + 2] ?? 0);
      out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + (i + 1 < u8.length ? B64[n >> 6 & 63] : "=") + (i + 2 < u8.length ? B64[n & 63] : "=");
    }
    return out;
  }
  function fromBase64(text) {
    const clean = text.replace(/[^A-Za-z0-9+/]/g, ""), out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const n = B64.indexOf(clean[i]) << 18 | B64.indexOf(clean[i + 1]) << 12 | (B64.indexOf(clean[i + 2]) & 63) << 6 | (B64.indexOf(clean[i + 3]) & 63);
      out[o++] = n >> 16 & 255; if (i + 2 < clean.length) out[o++] = n >> 8 & 255; if (i + 3 < clean.length) out[o++] = n & 255;
    }
    return out.subarray(0, o);
  }
  const asData = bytes => "data:application/octet-stream;base64," + toBase64(bytes);
  // How an extension's change reaches the design: write:edits applies it (asking the
  // first time); propose:edits shows the review dialog; otherwise it is refused.
  // A proposal the user discarded is final: the same proposal again is refused without a dialog
  // (no silent retry), and five dismissals in 30 s disable the extension (dismissed()).
  const proposalKey = proposal => sha256(canonical(proposal?.ops || proposal));
  async function approve(e, {label, rows, proposal, review: always}) {
    const key = proposal ? proposalKey(proposal) : null;
    if (key && e.declined?.has(key)) throw Error("You already declined this change. " + e.manifest.name + " cannot ask again with the same proposal.");
    const decided = await approveOnce(e, {label, rows, proposal, always});
    if (key && (!decided || (Array.isArray(decided) && !decided.length))) { (e.declined ??= new Set()).add(key); if (e.declined.size > 500) e.declined.delete(e.declined.values().next().value); }
    return decided;
  }
  async function approveOnce(e, {label, rows, proposal, always}) {
    // proposals.propose always shows the review, whatever write:edits allows.
    if (always) return e.perms["propose:edits"] === true || e.perms["write:edits"] ? review(e, label, rows, proposal) : false;
    const w = e.perms["write:edits"], bound = writeTarget(), epoch = e.editEpoch;
    if (w === true) return true;
    if (w === "ask") {
      // While queued behind another prompt the user may already have decided.
      const answer = await ask({kind: "write", manifest: e.manifest, target:targetName(), label, rows, total:proposal?.ops?.length ?? rows.length}, e,
        () => e.perms["write:edits"] === true ? "once" : e.perms["write:edits"] === false ? "never" : undefined);
      if (exts.get(e.id) !== e || !e.enabled || safeMode()) return {cancelled:true};
      if (writeTarget() !== bound) return {stale:true};
      if (e.editEpoch !== epoch) return {revoked:true};
      if (answer === "always") { setGrant(e, "write:edits", true); return true; }
      if (answer === "once") return true;
      if (answer === "never") setGrant(e, "write:edits", false);
      if (answer !== "review") return e.perms["propose:edits"] === true && answer !== "never" ? review(e, label, rows, proposal) : false;
      return review(e, label, rows, proposal);
    }
    if (e.perms["propose:edits"] === true) return review(e, label, rows, proposal);
    return false;
  }
  const review = (e, label, rows, proposal) => ask({kind: "review", manifest: e.manifest, label, rows, total:proposal?.ops?.length ?? rows.length, summary: proposal?.summary ?? null}, e).then(v => { if (!v) dismissed(e); return v; });
  // run:external (external-tools.js): only tools the manifest declares, through the desktop host,
  // which runs the program the user chose and shows each new program's command for approval. Runs
  // are cancelled when the extension stops, is paused, or loses the permission.
  const externalRuns = new Map(); // extension id -> caller run id -> native run ticket
  let externalSeq = 0;
  const externalModule = () => globalThis.AtriumExternalTools ? Promise.resolve(globalThis.AtriumExternalTools) : Promise.reject(Error("Running external tools needs the Waffle desktop app."));
  function externalFor(e) {
    const declared = () => e.manifest.contributes?.externalTools || [];
    const tool = id => { const t = declared().find(x => x.id === id); if (!t) throw Error(e.manifest.name + " does not declare the external tool " + id + " (contributes.externalTools)."); return t; };
    return {
      tools: () => externalModule().then(T => T.status(declared())),
      run(ext, r) {
        const t = tool(r.tool);
        if (safeMode()) throw Error("Extensions are paused.");
        // A denied program stays denied until the extension is enabled again: no repeated approval dialogs.
        if (e.externalDenied?.has(r.tool)) throw Error("You did not allow " + e.manifest.name + " to run " + t.name + ". Disable and enable the extension to be asked again.");
        const key = r.runId || "run-" + (++externalSeq), set = externalRuns.get(e.id) || new Map();
        if (set.has(key)) throw Error("A run named " + r.runId + " is already going.");
        if (set.size >= 4) throw Error(e.manifest.name + " already has 4 external runs going.");
        const ticket = {key: "run-" + (globalThis.crypto?.randomUUID?.() || globalThis.Atrium.id()), cancelled: false};
        set.set(key, ticket); externalRuns.set(e.id, set);
        const done = () => { set.delete(key); if (!set.size && externalRuns.get(e.id) === set) externalRuns.delete(e.id); };
        // The host remembers its approval for this exact extension version (id@sha256 of the bundle, as
        // trust and project grants are) and its declared argument template; a new version asks again.
        return Promise.all([externalModule(), contentHash(e)]).then(([T, hash]) => T.run({...r, runKey: ticket.key, cancelled: () => ticket.cancelled, toolName: t.name, extension: e.id, extensionName: e.manifest.name,
          extensionHash: hash, argTemplate: Array.isArray(t.args) ? t.args.slice() : []}))
          .catch(err => { if (err?.denied) (e.externalDenied ??= new Set()).add(r.tool); throw err; }).finally(done);
      },
      cancel: (ext, runId) => cancelRun(externalRuns.get(e.id)?.get(runId)),
      // Opens Preferences; at most once every 10 s, so an extension cannot keep reopening it.
      configure: (ext, id) => {
        tool(id);
        if (Date.now() - (e.configuredAt || 0) < 10000) throw Error("Preferences \u203a External Tools was opened a moment ago.");
        e.configuredAt = Date.now();
        return externalModule().then(T => T.configure(id));
      }
    };
  }
  // sha256 of the bundle that runs (bundleDigest): project and unpacked loads carry it; installed and
  // built-in extensions digest their stored files once per record (an update makes a new record).
  const contentHashes = new WeakMap();
  function contentHash(e) {
    if (typeof e.hash === "string") return Promise.resolve(e.hash);
    if (!contentHashes.has(e)) contentHashes.set(e, Promise.resolve(packageOf(e)).then(files => {
      if (!files) throw Error(e.manifest.name + " has no stored files. Install it again.");
      return bundleDigest(e.manifest, files);
    }).catch(err => { contentHashes.delete(e); throw err; }));
    return contentHashes.get(e);
  }
  function cancelRun(ticket) {
    if (!ticket) return false;
    ticket.cancelled = true;
    globalThis.AtriumExternalTools?.cancel(ticket.key);
    return true;
  }
  function cancelExternal(id) {
    for (const ticket of externalRuns.get(id)?.values() || []) cancelRun(ticket);
  }
  // Events go only to the worker that subscribed, and design events only while it still
  // holds read:project: revoking the permission (or the pool stopping) ends delivery.
  const PANEL_EVENTS = new Set(["panelShown", "panelHidden"]);
  const OWN_EVENTS = [...PANEL_EVENTS, "settingsChanged"];
  const panelEvent = (e, name, id) => registry.emit(name, {id, owner:e.id});
  function eventAllowed(id, name, payload) {
    const c = contexts.get(id);
    if (!c) return false;
    if (PANEL_EVENTS.has(name)) return payload?.owner === id;
    if (name === "settingsChanged") return payload?.extension === id;
    return c.perms?.["read:project"] === true;
  }
  function subscribe(id, name) {
    const c = contexts.get(id);
    if (!c) return;
    const p = c.pool;
    let set = p.subs.get(name);
    if (!set) {
      p.subs.set(name, set = new Set());
      set.off = registry.on(name, payload => {
        if (!p.worker || p.subs.get(name) !== set) return;
        const to = [...set].filter(x => eventAllowed(x, name, payload));
        if (to.length) p.post({t: "event", name, payload:PANEL_EVENTS.has(name) ? {id:payload.id} : payload, exts: to});
      });
    }
    set.add(id);
  }
  function unsubscribe(id, names) {
    for (const p of pools.values()) for (const [name, set] of p.subs) {
      if (names && !names(name)) continue;
      set.delete(id);
      if (!set.size) { set.off?.(); p.subs.delete(name); }
    }
  }

  // -------------------------------------------------------------- activation
  const timeoutOf = e => Math.min(e.manifest.worker === "dedicated" ? LONG_TIMEOUT : MAX_TIMEOUT, e.manifest.timeoutMs || DEFAULT_TIMEOUT);
  // ------------------------------------------------------------------ grants
  // Stored per extension: {acknowledged, perms: {permission: true | false}}. A project
  // extension's grants belong to its exact bundle (id@sha256), so a changed bundle with
  // the same id starts with nothing and asks again.
  const grantKey = e => typeof e === "string" ? e : e.origin === "dev" ? "dev:" + e.id + "@" + e.hash : e.origin === "project" ? e.id + "@" + e.hash : e.id;
  const grantOf = e => ls.get(GRANTS, {})[grantKey(e)] || null;
  function saveGrant(e, g) { const all = ls.get(GRANTS, {}), k = grantKey(e); if (g) all[k] = g; else { delete all[k]; openWrites.delete(k); } ls.set(GRANTS, all); }
  // e.perms is the live object the API checks on every call; revocation edits it in place.
  const openWrites = new Map();
  const writeTarget = () => host?.savedTarget?.() || globalThis.AtriumHost?.projectPath || host?.project?.();
  const targetName = () => typeof writeTarget() === "string" ? writeTarget() : (host?.project?.()?.name || "This open project");
  function recordWrite(e, grant) {
    const target = writeTarget();
    if (typeof target === "string") (grant.writeTargets ||= {})[sha256(target)] = true;
    else if (target) {
      const key = grantKey(e);
      if (!openWrites.has(key)) openWrites.set(key, new WeakSet());
      openWrites.get(key).add(target);
    }
  }
  function currentWrite(e, grant, target) {
    if (grant?.perms?.["write:edits"] === false) return false;
    if (grant?.perms?.["write:edits"] === true && (typeof target === "string" ? grant.writeTargets?.[sha256(target)] === true : target && openWrites.get(grantKey(e))?.has(target))) return true;
    return "ask";
  }
  function syncPerms(e) {
    // Built-ins are trusted by provenance: their declared permissions start granted, except
    // write:edits (asks) and network hosts (off). The user can still revoke any of them.
    const g = grantOf(e) || (e.origin === "builtin" ? {acknowledged: true, perms: {}} : null), perms = e.perms;
    e.writeTarget = writeTarget();
    for (const k of Object.keys(perms)) delete perms[k];
    for (const p of g?.acknowledged ? e.manifest.permissions || [] : []) {
      if (AtriumAPI.isNetworkPermission(p)) continue;
      const v = g.perms?.[p];
      perms[p] = p === "write:edits" ? currentWrite(e, g, e.writeTarget) : v !== false;
    }
    if (e.manifest.contributes?.aiProviders?.length) {
      const signature = JSON.stringify([perms["ai:provider"],perms["propose:edits"],hostsOf(e)]);
      if (e.aiPermissions !== undefined && e.aiPermissions !== signature) invalidateAI(e);
      e.aiPermissions = signature;
    }
  }
  const hostsOf = e => { const g = grantOf(e); return (e.manifest.permissions || []).filter(p => AtriumAPI.isNetworkPermission(p) && g?.perms?.[p] === true).map(p => p.slice(8)).sort(); };
  function setGrant(e, perm, value) {
    const g = grantOf(e) || {acknowledged: true, perms: {}};
    if (["write:edits", "propose:edits", "read:project"].includes(perm) && value !== true) e.editEpoch = (e.editEpoch || 0) + 1;
    if (perm === "write:edits") {
      if (value === true) recordWrite(e, g);
      else { delete g.writeTargets; openWrites.delete(grantKey(e)); }
    }
    if (value == null) delete g.perms[perm]; else g.perms[perm] = !!value;
    saveGrant(e, g); syncPerms(e);
    if (perm === "read:project" && e.perms["read:project"] !== true) unsubscribe(e.id, name => !OWN_EVENTS.includes(name));
    if (perm === "ui:decorations" && e.perms["ui:decorations"] !== true) clearDecorations(e.id);
    if (perm === "run:external" && e.perms["run:external"] !== true) cancelExternal(e.id);
    notebookRuntime?.permissionChanged(e,perm,AtriumAPI.isNetworkPermission(perm));
    // A network change needs a fresh worker with the new host list.
    touch(e);
    if (AtriumAPI.isNetworkPermission(perm) && (e.status === "active" || e.status === "activating")) return deactivate(e.id);
    return Promise.resolve();
  }
  // Ask the user. Tests and hosts without a DOM supply options.consent; otherwise deny.
  // Only one consent dialog is shown at a time: prompts queue, each extension may have
  // only a few queued, and `gate` lets a queued prompt resolve without a dialog when an
  // earlier answer already decided it (or the extension was stopped meanwhile).
  let consentChain = Promise.resolve();
  const consentQueued = new Map();
  function ask(request, e, gate) {
    const id = request.manifest?.id || "?", deny = request.kind === "write" ? "never" : request.kind === "review" ? false : null;
    const queued = consentQueued.get(id) || 0;
    if (queued >= MAX_QUEUED_PROMPTS) return Promise.reject(Error((request.manifest?.name || id) + " already has " + queued + " prompts waiting."));
    consentQueued.set(id, queued + 1);
    const run = async () => {
      try {
        if (e && (!e.enabled || safeMode()) && request.kind !== "install") return deny;
        const decided = gate?.();
        if (decided !== undefined) return decided;
        if (options.consent) return await options.consent(request);
        return doc ? await consentDialog(request, e) : deny;
      } finally { const n = (consentQueued.get(id) || 1) - 1; if (n) consentQueued.set(id, n); else consentQueued.delete(id); }
    };
    const result = consentChain.then(run, run);
    consentChain = result.catch(() => {});
    return result;
  }
  async function acknowledge(e, kind, force = false) {
    if (e.origin === "builtin") return true; // built-ins: trusted by provenance
    if (!force && grantOf(e)?.acknowledged) return true;
    const bound = writeTarget();
    const answer = await ask({kind, target:targetName(), manifest: e.manifest, permissions: e.manifest.permissions || [], ...(e.origin === "dev" ? {developer: e.hash} : {})}, exts.get(e.id) === e ? e : null,
      force ? undefined : () => (grantOf(e)?.acknowledged ? true : undefined));
    if (answer === true) return true;
    if (!answer) return false;
    const perms = {};
    for (const p of e.manifest.permissions || []) if (answer[p] === true || answer[p] === false) perms[p] = answer[p];
    const grant = {acknowledged: true, perms};
    if (perms["write:edits"] === true && writeTarget() === bound) recordWrite(e, grant);
    saveGrant(e, grant); if (e.perms) syncPerms(e);
    return true;
  }
  const safeMode = () => ls.get(SAFE_MODE, false) === true;
  // One worker per extension: its realm is the trust principal. ("worker": "dedicated"
  // only raises the time limit now; every extension is isolated.)
  function poolFor(e) {
    const hosts = hostsOf(e), p = pool("ext:" + e.id, {network: hosts}, e.id);
    if (p.worker && p.config.network.join() !== hosts.join()) stop(p, "Network permissions changed.", "cancelled");
    if (!p.worker) p.config = {network: hosts};
    return p;
  }
  async function packageOf(e) {
    if (e.origin === "project") {
      // Recompute the digest at activation: only the exact bundle the user trusted runs.
      const pkg = projectPackages().get(e.id);
      if (!pkg || pkg.hash !== e.hash || !trusted(e)) throw Error(e.manifest.name + " changed since you trusted it. Review it again in Tools › Extensions.");
      return pkg.files;
    }
    if (e.origin === "builtin") return builtinPackage(e);
    if (e.origin === "dev") {
      // Only the exact files that were loaded (and digested) run, and only while developer mode is on.
      if (!developerMode()) throw Error("Developer mode is off. Turn it on in Preferences to run " + e.manifest.name + ".");
      const files = devCode.get(e.id);
      if (!files || bundleDigest(e.manifest, files) !== e.hash) throw Error(e.manifest.name + " changed since it was loaded. Reload it from its folder.");
      return files;
    }
    return code.get(e.id);
  }
  const aiEnabled = () => globalThis.AtriumButter?.state("ai").enabled === true;
  const availableAI = (e, provider) => aiEnabled() && exts.get(e.id) === e && e.enabled &&
    e.status !== "blocked" && !safeMode() && e.perms["ai:provider"] === true &&
    e.manifest.contributes?.aiProviders?.includes(provider) && provider.hosts.every(host => hostsOf(e).includes(host)) && (e.origin !== "project" || trusted(e));
  function providersAI() {
    if (!aiEnabled()) return [];
    return [...exts.values()].flatMap(e => (e.manifest.contributes?.aiProviders || []).filter(provider => availableAI(e, provider))
      .map(provider => ({id:e.id + ":" + provider.id, label:provider.label, hosts:[...provider.hosts], credential:!!provider.auth,
        proposals:e.perms["propose:edits"] === true})));
  }
  const aiError = (code, message) => Object.assign(Error(message),{code});
  function invalidateAI(e) {
    e.aiGeneration = (e.aiGeneration ?? 0) + 1;
    for (const listener of e.aiListeners ?? []) listener();
    for (const p of pools.values())
      if (p.owner === e.id && p.ai) stop(p,aiError("stale_source","The AI permission changed. Start a fresh request."),"cancelled");
  }
  globalThis.addEventListener?.("storage", event => {
    if (event.key === SAFE_MODE && event.newValue === "true") {
      for (const e of exts.values()) if (e.manifest.contributes?.aiProviders?.length) invalidateAI(e);
    }
    if (event.key !== GRANTS && event.key !== null) return;
    const stored = value => {
      try { return JSON.parse(value) ?? {}; } catch { return {}; }
    };
    const before = stored(event.oldValue), after = stored(event.newValue);
    for (const e of exts.values()) {
      if (!e.manifest.contributes?.aiProviders?.length) continue;
      const key = grantKey(e), project = grant => {
        const permissions = grant?.perms ?? {};
        const hosts = (e.manifest.permissions || []).filter(perm => AtriumAPI.isNetworkPermission(perm));
        return JSON.stringify([grant?.acknowledged,permissions["ai:provider"],permissions["propose:edits"],
          ...hosts.map(host => permissions[host])]);
      };
      if (event.key === null || project(before[key]) !== project(after[key])) invalidateAI(e);
      syncPerms(e);
    }
  });
  function providerAI(id) {
    const [owner, local, extra] = String(id).split(":");
    const e = exts.get(owner), provider = extra === undefined && e?.manifest.contributes?.aiProviders?.find(row => row.id === local);
    return provider ? {e, provider} : null;
  }
  function permissionAI(id) {
    const found = providerAI(id);
    if (!found || !availableAI(found.e,found.provider)) return null;
    const {e,provider} = found, generation = e.aiGeneration, epoch = activationEpoch;
    return {e,provider,current:() => e.aiGeneration === generation && activationEpoch === epoch && availableAI(e,provider)};
  }
  const aiAccount = (id, provider) => provider?.auth ? id + ":" + sha256(canonical([provider.hosts[0],provider.auth])) : null;
  const AI_ACCOUNTS = "atrium.ai.credentialAccounts";
  function credentialAI(id, operation) {
    const current = aiAccount(id,providerAI(id)?.provider);
    if (operation === "configure" || operation === undefined) return permissionAI(id) ? current : null;
    const known = ls.get(AI_ACCOUNTS, {});
    return operation === "forget" ? known[id]?.[0] ?? current : current ?? known[id]?.[0] ?? null;
  }
  function rememberCredentialAI(id, account, operation) {
    if (operation !== "configure" && operation !== "forget") return;
    const known = ls.get(AI_ACCOUNTS, {}), others = (known[id] ?? []).filter(value => value !== account);
    if (operation === "configure") known[id] = [account,...others];
    else if (others.length) known[id] = others;
    else delete known[id];
    ls.set(AI_ACCOUNTS,known);
  }
  function redactProviderResult(value, secrets) {
    if (!secrets.size || value == null) return value;
    if (typeof value === "string") {
      for (const secret of secrets) value = value.split(secret).join("[redacted]");
      return value;
    }
    if (Array.isArray(value)) return value.map(entry => redactProviderResult(entry,secrets));
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key,entry]) =>
      [key,redactProviderResult(entry,secrets)]));
    return value;
  }
  let nextAI = 0;
  async function askAI(id, input, current, signal) {
    const permission = permissionAI(id);
    if (!permission || typeof current !== "function" || !current() || signal?.aborted || sizeOf(input) > 65536)
      throw aiError("permission_denied","The AI provider or its read grant is unavailable.");
    const {e,provider} = permission, stale = () => aiError("stale_source","The AI permission or project changed.");
    const available = () => current() && !signal?.aborted && permission.current();
    const files = await packageOf(e);
    if (!available()) throw stale();
    if (!files || typeof files[norm(provider.entry)] !== "string") throw Error("The AI provider's script is unavailable.");
    const p = pool("ai:" + (++nextAI), {network:[...provider.hosts]}, e.id);
    p.ai = {account:aiAccount(id,provider), available:() => !p.cancelled && available(),
      hosts:provider.hosts, auth:provider.auth, secrets:new Set(), pool:p, rate:{at:0,calls:0}};
    const cancel = () => stop(p,stale(),"cancelled");
    signal?.addEventListener("abort",cancel,{once:true});
    let watch;
    function check() {
      if (!available()) cancel();
      else watch = setTimeout(check,50);
    }
    check();
    try {
      await start(p);
      if (!available()) throw stale();
      const value = await request(p, {t:"ai", source:files[norm(provider.entry)], input}, Math.min(15000,timeoutOf(e)), e.id);
      if (!available()) throw stale();
      if (sizeOf(value) > 65536) throw aiError("invalid_provider_result","The AI result exceeded its size limit.");
      return redactProviderResult(value,p.ai.secrets);
    } catch (error) {
      if (!available()) throw stale();
      if (p.cancelled && !error.code) throw aiError("cancelled","The AI request was stopped.");
      throw error;
    } finally {
      clearTimeout(watch);
      signal?.removeEventListener("abort",cancel);
      p.ai.secrets.clear();
      stop(p, "The AI request ended.");
      pools.delete(p.key);
    }
  }
  function activate(id, reason = "api") {
    const e = exts.get(id);
    if (!e) return Promise.reject(Error("Unknown extension " + id + "."));
    const optional=notebookOnly(e.manifest);
    if (!e.enabled || optional && !notebookEnabled()) return Promise.reject(Error(e.manifest.name + " is disabled."));
    if (e.status === "blocked") return Promise.reject(Error(e.manifest.name + " is waiting for you to trust this project's extensions."));
    if (safeMode()) return Promise.reject(Error("Extensions are paused. Resume them in Tools › Extensions."));
    const policy=optional ? globalThis.AtriumLabs.notebookSignal() : null;
    if (optional && !notebookRuntime?.isReady(e))
      return admitNotebook(e).then(() => {
        if (policy.aborted || !notebookRuntime?.isReady(e)) throw Error("Notebook extension unavailable.");
        return activate(id,reason);
      });
    if (e.status === "active") return Promise.resolve();
    if (e.activation) return e.activation;
    e.status = "activating"; touch(e);
    const epoch = activationEpoch;
    const canStart = () => epoch === activationEpoch && e.enabled && exts.get(id) === e && !safeMode() && !policy?.aborted;
    const checkEnabled = () => {
      if (!canStart()) throw Error(e.manifest.name + " was stopped before it could start.");
    };
    let p = null;
    e.activation = (async () => {
      if (!await acknowledge(e, "activate")) throw Error("You declined the permissions " + e.manifest.name + " asks for.");
      checkEnabled();
      const files = await packageOf(e);
      checkEnabled();
      if (!files) throw Error("The code for " + e.manifest.name + " is missing. Reinstall it.");
      p = poolFor(e);
      await start(p);
      checkEnabled();
      contexts.set(e.id, {record: e, core: makeCore(e.id, e.perms), pool: p, rate: e.rate, perms: e.perms});
      p.members.add(e.id); clearTimeout(p.idle); sweep();
      const main = norm(e.manifest.main);
      await request(p, {t: "activate", ext: {id: e.id}, source: files[main], main,
        files: Object.fromEntries(Object.entries(files).filter(([k]) => k !== main && /\.(js|json)$/.test(k))), settings: settingsOf(e)}, ACTIVATE_TIMEOUT, e.id);
      e.status = "active"; e.activatedBy = reason; e.activatedAt = Date.now(); touch(e);
      log(e, "info", "Activated (" + reason + ")" + (p.config.network.length ? "; network: " + p.config.network.join(", ") : "") + ".");
    })().catch(err => {
      e.status = canStart() ? "error" : e.enabled ? "inactive" : "disabled";
      log(e, "error", "Activation failed: " + err.message);
      contexts.delete(e.id); if (p) { p.members.delete(e.id); scheduleIdle(p); }
      throw err;
    }).finally(() => { e.activation = null; });
    return e.activation;
  }
  function deactivateLocal(e) {
    contexts.delete(e.id);
    for (const [cmd, c] of [...registry.commands]) if (c.owner === e.id && !c.contributed) registry.commands.delete(cmd);
    unsubscribe(e.id);
    clearDecorations(e.id); cancelExternal(e.id);
    for (const d of [...e.dialogs]) { try { d.close(); } catch {} }
    for (const id of [...e.statusItems.keys()]) ui.status(e, id, null);
    // Manifest contributions stay while the extension is enabled; runtime additions go.
    e.menuItems = e.menuItems.filter(item => { if (item.contributed) return true; item.node?.remove(); return false; });
    for (const panel of e.panels.values()) {
      panel.view = null;
      if (!panel.body) continue;
      panel.body.replaceChildren(el("p", e.manifest.name + " is not running.", "ext-text is-muted"));
      if (panel.open && e.enabled) panel.body.append(button("Start", () => activate(e.id, "onView:" + panel.id).then(() => panelEvent(e, "panelShown", panel.id), err => log(e, "error", err.message)), "ext-button"));
    }
  }
  async function deactivate(id) {
    const e = exts.get(id);
    if (!e || (e.status !== "active" && e.status !== "activating")) return;
    await e.activation?.catch(() => {});
    const c = contexts.get(id);
    // A detached project record can still own its old context.
    if (c ? c.record !== e : exts.get(id) !== e) return;
    if (c?.pool.worker) {
      try { await request(c.pool, {t: "deactivate", ext: id}, 2000, id); } catch {}
      if (contexts.get(id) !== c) return;
    }
    deactivateLocal(e);
    if (c) {
      // The hook has run. Remaining requests belong to the retired realm.
      c.pool.members.delete(id);
      stop(c.pool, "The extension was deactivated.", "cancelled");
    }
    if (e.status !== "error") e.status = e.enabled ? "inactive" : "disabled";
    touch(e);
  }

  // ---------------------------------------------------------------- commands
  const whenContext = () => {
    if (!host) return {};
    const d = host.project().documents.find(x => x.id === host.documentId()), sel = host.selection?.();
    return {pcb: d?.kind === "pcb", schematic: d?.kind === "schematic", selection: !!(sel?.size ?? sel?.length)};
  };
  function when(expr, ctx = whenContext()) {
    if (!expr) return true;
    return String(expr).split("&&").every(term => { const t = term.trim(), neg = t.startsWith("!"), k = t.replace(/^!/, "").trim(); return !!ctx[k] !== neg; });
  }
  async function execute(id, ...args) {
    if (typeof id !== "string") throw Error("Command id expected.");
    // Commands reachable from extension-described UI: only built-in view commands.
    if (id.startsWith("waffle.") || id.startsWith("atrium.")) return makeCore("waffle", {"ui:command": true}).call("commands.execute", [id, args], false);
    let c = registry?.commands.get(id);
    if (!c) {
      const owner = [...exts.values()].find(e => e.enabled && (e.manifest.activationEvents || []).includes("onCommand:" + id));
      if (!owner) throw Error("Unknown command " + id + ".");
      await activate(owner.id, "onCommand:" + id);
      c = registry.commands.get(id);
      if (!c) throw Error(owner.manifest.name + " did not register " + id + ".");
    }
    if (c.when && !when(c.when)) { host?.info?.(c.title + " is not available here."); return undefined; }
    // Old scripts and the extension manager use the same editor view as Tools and Panels.
    if (c.owner === "waffle.calculators" && (id === "calculators.show" || id === "calculators.compute" && !args.length)) {
      if (globalThis.AtriumLazy) { (await AtriumLazy.need("AtriumCalc")).open(); return true; }
      return host?.runAction?.("calculators");
    }
    const e = exts.get(c.owner);
    if (e && notebookCommand(e.manifest.contributes,id)) {
      if (!notebookEnabled()) throw Error("Notebook extensions are disabled.");
      await admitNotebook(e);
      if (!notebookRuntime?.isReady(e)) throw Error("Notebook extension unavailable.");
    }
    if (c.handler) return c.handler(...args);
    if (!e) throw Error("Unknown command " + id + ".");
    if (e.status !== "active") await activate(e.id, "onCommand:" + id);
    const ctx = contexts.get(e.id);
    try { return await request(ctx.pool, {t: "invoke", ext: e.id, command: id, args}, timeoutOf(e), e.id); }
    catch (err) { log(e, "error", id + ": " + err.message); host?.info?.(err.message); throw err; }
  }
  const run = (id, ...args) => execute(id, ...args).catch(() => {});

  // Ordinary extension packages never request the notebook worker bridge.
  let notebookRuntime;
  const paletteAvailable = (e, ui) => notebookEnabled() && exts.get(e.id) === e && e.enabled && e.status !== "blocked" && !safeMode() && (!ui || e.perms["ui:command"] === true);
  globalThis.AtriumLazy?.register("AtriumExtensionNotebookHost",{scripts:["extension-host/extension-notebook-host.js"]});
  async function notebookHost() {
    if (notebookRuntime) return notebookRuntime;
    const module=await notebookModule("AtriumExtensionNotebookHost","extension-notebook-host");
    return notebookRuntime ??= module.create({activate,paletteAvailable,paletteDeclared,notebookModule,
      commandPool:id=>contexts.get(id)?.pool,attached:()=>!!host,info:message=>host?.info?.(message),
      packageOf,bundleDigest,timeoutOf,hostsOf,pools,pool,start,stop,flush,request,sizeOf});
  }
  async function checkNotebook(manifest,files,record) {
    if (!notebookEnabled() || !notebookDeclared(manifest?.contributes)) return;
    const epoch=globalThis.AtriumLabs.notebookSignal();
    await (await notebookHost()).check(manifest,files,record,epoch);
  }
  async function admitNotebook(e) {
    if (!notebookEnabled() || !notebookDeclared(e.manifest.contributes) || !paletteAvailable(e,false)) return;
    const epoch=globalThis.AtriumLabs.notebookSignal();
    await (await notebookHost()).admit(e,epoch);
  }
  function readyNotebook() {
    if (!notebookEnabled()) return Promise.resolve();
    return Promise.all([...exts.values()].filter(e=>notebookDeclared(e.manifest.contributes))
      .map(e=>admitNotebook(e).catch(error=>log(e,"error",error.message))));
  }
  globalThis.AtriumLabs?.onChange?.(enabled=>{
    if (enabled) {if (host) readyNotebook();return;}
    for (const e of exts.values()) {
      if (!notebookDeclared(e.manifest.contributes)) continue;
      notebookRuntime?.remove(e,notebookOnly(e.manifest));
    }
  });
  function registerContributions(e) {
    const c = e.manifest.contributes || {};
    if (notebookEnabled() && notebookDeclared(c)) admitNotebook(e).catch(error=>log(e,"error",error.message));
    for (const cmd of c.commands || []) {
      const prior = registry.commands.get(cmd.command);
      if (prior && prior.owner !== e.id) { log(e, "error", "Command " + cmd.command + " is already provided by " + prior.owner + "."); continue; }
      registry.commands.set(cmd.command, {id: cmd.command, owner: e.id, title: cmd.title, when: cmd.when || "", handler: null, contributed: true});
    }
    for (const [menu, list] of Object.entries(c.menus || {})) for (const item of list) ui.menu(e, {...item, menu}, true);
    for (const p of c.panels || []) ui.panel(e, p.id, p, true);
    if ((e.manifest.activationEvents || []).some(a => a.startsWith("onDocumentKind:"))) kindWatchers.add(e.id);
    if ((c.themes || []).length) contributeThemes(e);
    // With the editor keymap, contributed commands appear in Keyboard Shortcuts and can be rebound.
    const KM = globalThis.AtriumKeymap;
    if (KM?.registerCommand) for (const cmd of c.commands || []) {
      if (e.id === "waffle.calculators") continue; // Legacy bindings migrate to the native command.
      try {
        const keys = (c.keybindings || []).filter(k => k.command === cmd.command).map(k => ({key: k.key, when: k.when || ""}));
        e.keymap.push(KM.registerCommand({id: cmd.command, title: cmd.title, notebook:widgetCommand(c,cmd.command), category: "Extensions", when: cmd.when || "", run: () => run(cmd.command), defaultKeys: keys}));
      } catch (err) { log(e, "warn", "Keyboard shortcut for " + cmd.command + ": " + err.message); }
    }
    installKeys();
  }
  // Themes are data: the files are read from the trusted package, parsed as JSON and validated by the theme
  // library (colours only); the extension's code never runs for them.
  async function contributeThemes(e) {
    try {
      const L = globalThis.AtriumLazy, files = await packageOf(e), list = [];
      const Lib = globalThis.AtriumThemes || await L.need("AtriumThemes");
      for (const th of e.manifest.contributes.themes) {
        const text = files?.[themePath(th.path)];
        if (typeof text !== "string") { log(e, "error", "Theme file " + th.path + " is missing."); continue; }
        let data = null; try { data = JSON.parse(text); } catch {}
        if (!data || !("atrium-theme" in data)) { const V = globalThis.AtriumVSCode || await L.need("AtriumVSCode"); try { data = V.parseJSONC(text); } catch (err) { log(e, "error", "Theme " + th.id + ": " + err.message); continue; } }
        list.push({id: th.id, label: th.label, theme: data});
      }
      if (!exts.get(e.id)?.enabled) return;
      const r = Lib.registerExtension(e.id, list);
      for (const m of r.errors) log(e, "error", "Theme " + m);
      globalThis.AtriumThemePicker?.refresh?.();
    } catch (err) { log(e, "error", "Themes: " + err.message); }
  }
  function removeContributions(e) {
    notebookRuntime?.remove(e);
    try { globalThis.AtriumThemes?.unregisterExtension(e.id); globalThis.AtriumThemePicker?.refresh?.(); } catch {}
    for (const [id, c] of [...registry.commands]) if (c.owner === e.id) registry.commands.delete(id);
    for (const item of e.menuItems.splice(0)) item.node?.remove();
    for (const panel of e.panels.values()) { panel.root?.remove(); panel.menuNode?.remove(); }
    e.panels.clear(); kindWatchers.delete(e.id);
    for (const h of e.keymap.splice(0)) { try { h.dispose(); } catch {} }
    installKeys();
  }

  // Keybindings: one capture listener exists only while some extension declares keys.
  function parseKey(text) {
    const parts = String(text).toLowerCase().split("+").map(s => s.trim()).filter(Boolean), key = parts.pop();
    if (!key) return null;
    const k = {ctrl: parts.includes("ctrl"), alt: parts.includes("alt") || parts.includes("option"), shift: parts.includes("shift"),
      meta: parts.includes("cmd") || parts.includes("meta"), mod: parts.includes("mod"), key};
    const fn = /^f([1-9]|1[0-2])$/.test(key);
    if (!fn && !k.alt && !k.meta && !k.mod && !k.ctrl) return null;
    // Leave the editor's own Ctrl/Cmd shortcuts alone.
    if ((k.ctrl || k.meta || k.mod) && !k.alt && !k.shift && /^[sozyxcvadmwgl\\]$/.test(key)) return null;
    return k;
  }
  function installKeys() {
    if (!doc) return;
    if (globalThis.AtriumKeymap?.registerCommand) return; // the editor keymap dispatches them
    const bindings = [];
    for (const e of exts.values()) if (e.enabled && e.status !== "blocked") for (const b of e.manifest.contributes?.keybindings || []) { const k = parseKey(b.key); if (k) bindings.push({...b, k}); }
    if (keyListener) { doc.removeEventListener("keydown", keyListener, true); keyListener = null; }
    if (!bindings.length) return;
    const mac = /Mac|iPhone|iPad/i.test(globalThis.navigator?.platform || "");
    keyListener = ev => {
      if (ev.defaultPrevented || ev.isComposing || doc.querySelector("dialog[open]:modal") || ev.target?.closest?.("input,textarea,select,[contenteditable]")) return;
      const key = (ev.key || "").toLowerCase();
      for (const b of bindings) {
        const k = b.k, ctrl = k.ctrl || (k.mod && !mac), meta = k.meta || (k.mod && mac);
        if (key === k.key && ev.ctrlKey === ctrl && ev.metaKey === meta && ev.altKey === k.alt && ev.shiftKey === k.shift && when(b.when)) {
          ev.preventDefault(); ev.stopPropagation(); run(b.command); return;
        }
      }
    };
    doc.addEventListener("keydown", keyListener, true);
  }

  // ---------------------------------------------------------------------- UI
  // Declarative rendering only: extensions describe; the host builds the DOM.
  function el(tag, text, cls) { return AtriumNavCommon.elementIn(doc, tag, text, cls); }
  function button(text, fn, cls) {
    const b = el("button", text, cls); b.type = "button"; b.onclick = fn;
    if (b.classList.contains("ext-button")) {
      globalThis.AtriumUI?.button(b, b.classList.contains("is-primary") ? "primary" : "secondary");
    }
    return b;
  }
  // A chip (the library badge): short text in a tone colour. Tones: info, success, warning, danger, accent, muted.
  const CHIP_TONES = new Set(["info", "success", "warning", "danger", "accent"]);
  function chip(text, tone, title) {
    const c = el("span", String(text ?? "").slice(0, 40), "ui-badge ext-chip");
    if (CHIP_TONES.has(tone)) c.dataset.tone = tone;
    if (title != null) c.title = String(title).slice(0, 200);
    return c;
  }
  const iconNode = name => AtriumNavCommon.icon(name);
  const closeMenus = () => doc?.querySelectorAll("details.work-menu[open]").forEach(d => { d.open = false; });
  // Every DOM node a view creates counts against VIEW_LIMITS.nodes, so no view (a 3000-column
  // table, deep stacks, huge forms) can hold the main thread: the worst case is a few tens of ms.
  const VIEW_LIMITS = {nodes: 20000, columns: 64, depth: 16, fields: 200, buttons: 200};
  const VIEW_FULL = {}, draftForms = new WeakMap();
  function renderView(e, view, budget = {n: 0, depth: 0}) {
    const mk = (...a) => { if (++budget.n > VIEW_LIMITS.nodes) throw VIEW_FULL; return el(...a); };
    const btn = (...a) => { if (++budget.n > VIEW_LIMITS.nodes) throw VIEW_FULL; return button(...a); };
    const frag = doc.createDocumentFragment();
    const nodes = Array.isArray(view) ? view : [view];
    for (const v of nodes) {
      if (!v || typeof v !== "object") continue;
      const cmd = (v2, extra) => v2?.command ? () => run(v2.command, ...(v2.args ? [].concat(v2.args) : extra !== undefined ? [extra] : [])) : null;
      switch (v.type) {
        case "heading": frag.append(mk("h3", String(v.text ?? ""), "ext-heading")); break;
        case "text": frag.append(mk("p", String(v.text ?? ""), "ext-text" + (v.muted ? " is-muted" : "") + (["info", "warn", "error"].includes(v.level) ? " is-" + v.level : ""))); break;
        case "code": frag.append(mk("pre", String(v.text ?? ""), "ext-code")); break;
        // {type:"chip", text, tone} and {type:"chips", items:[{text, tone}]}: status badges (no hover pop-ups).
        case "chip": { if (++budget.n > VIEW_LIMITS.nodes) throw VIEW_FULL; frag.append(chip(v.text, v.tone)); break; }
        case "chips": { const row = mk("div", null, "ext-chips"); for (const c of (Array.isArray(v.items) ? v.items : []).slice(0, VIEW_LIMITS.buttons)) { if (++budget.n > VIEW_LIMITS.nodes) throw VIEW_FULL; row.append(chip(c?.text, c?.tone)); } frag.append(row); break; }
        case "kv": { const dl = mk("dl", null, "ext-kv"); for (const [k, x] of (Array.isArray(v.rows) ? v.rows : []).slice(0, 2000)) dl.append(mk("dt", String(k)), mk("dd", String(x))); frag.append(dl); break; }
        case "button": frag.append(btn(String(v.label ?? "Run"), cmd(v), "ext-button")); break;
        // A button item with `pressed` (true or false) is a toggle: a segmented choice such as the analysis type.
        case "buttons": { const row = mk("div", null, "ext-buttons"); for (const b of (Array.isArray(v.items) ? v.items : []).slice(0, VIEW_LIMITS.buttons)) { const n = btn(String(b.label ?? "Run"), cmd(b), "ext-button"); if (typeof b.pressed === "boolean") n.setAttribute("aria-pressed", String(b.pressed)); row.append(n); } frag.append(row); break; }
        case "list": {
          const ul = mk("ul", null, "ext-list");
          for (const it of (v.items || []).slice(0, 2000)) {
            const li = mk("li"), act = it.locate ? () => host?.locate?.(it.locate) : cmd(it);
            const b = act ? btn(null, act, "ui-row ext-list-row") : mk("div", null, "ui-row ext-list-row");
            b.append(mk("span", String(it.label ?? "")), it.badge != null ? chip(it.badge?.text ?? it.badge, it.badge?.tone) : "", it.detail != null ? mk("small", String(it.detail)) : "");
            li.append(b); ul.append(li);
          }
          frag.append(ul); break;
        }
        case "table": {
          const wrap = mk("div", null, "ext-table-wrap"), t = mk("table", null, "ext-table"), head = mk("tr"), cols = (Array.isArray(v.columns) ? v.columns : []).slice(0, VIEW_LIMITS.columns);
          for (const c of cols) { const th = mk("th", String(c.title ?? c.key)); if (c.align) th.style.textAlign = c.align === "right" ? "right" : "left"; head.append(th); }
          if (v.layout === "details") t.classList.add("ext-detail-table");
          t.append(mk("thead"), mk("tbody")); t.tHead.append(head);
          const all = Array.isArray(v.rows) ? v.rows : [], rowCost = 1 + cols.length + cols.filter(c => c.type === "chip").length;
          const fit = Math.max(0, Math.floor((VIEW_LIMITS.nodes - budget.n - cols.length - 16) / rowCost));
          const shown = all.slice(0, Math.min(2000, fit));
          if (shown.length < all.length) wrap.dataset.truncated = String(all.length - shown.length);
          for (const r of shown) {
            const tr = mk("tr"), act = r.locate ? () => host?.locate?.(r.locate) : v.rowCommand ? () => run(v.rowCommand, r) : null;
            for (const c of cols) {
              const cell = r[c.key], td = mk("td");
              if (v.layout === "details") td.dataset.label = String(c.title ?? c.key);
              if (c.type === "chip" && cell != null) { if (++budget.n > VIEW_LIMITS.nodes) throw VIEW_FULL; td.append(chip(cell.text ?? cell, cell.tone)); }
              else td.textContent = cell == null ? "" : String(cell);
              if (c.align === "right") td.style.textAlign = "right";
              tr.append(td);
            }
            if (act) { tr.tabIndex = 0; tr.classList.add("is-action"); tr.onclick = act; tr.onkeydown = ev => { if (ev.key === "Enter") act(); }; }
            t.tBodies[0].append(tr);
          }
          wrap.append(t); if (wrap.dataset.truncated) wrap.append(mk("p", "… " + wrap.dataset.truncated + " more rows not shown", "ext-text is-muted")); frag.append(wrap); break;
        }
        case "form": {
          const form = mk("form", null, "ext-form"), inputs = [];
          if (v.retainDraft === true) {
            form.dataset.retainDraft = "";
            draftForms.set(form, JSON.stringify(v));
          }
          for (const f of (Array.isArray(v.fields) ? v.fields : []).slice(0, VIEW_LIMITS.fields)) {
            const l = mk("label", null, "ext-field"), name = String(f.key);
            let input;
            if (f.type === "enum") { input = mk("select", null, "ui-field"); for (const o of (Array.isArray(f.options) ? f.options : []).slice(0, 500)) input.add(new Option(String(o), String(o))); }
            else if (f.type === "textarea") {
              input = mk("textarea", null, "ui-field"); input.rows = Math.max(1, Math.min(12, f.rows | 0 || 3)); l.classList.add("is-wide");
              // Enter sends, Shift+Enter starts a new line.
              input.onkeydown = ev => { if (ev.key === "Enter" && !ev.shiftKey && !ev.isComposing && f.enterSubmits !== false) { ev.preventDefault(); if (form.requestSubmit) form.requestSubmit(); else form.onsubmit?.(ev); } };
            }
            else { input = mk("input", null, f.type === "boolean" ? "ui-checkbox" : "ui-field"); input.type = f.type === "boolean" ? "checkbox" : f.type === "number" ? "number" : f.type === "password" ? "password" : "text"; if (f.step) input.step = String(f.step); if (f.type === "password") input.autocomplete = "off"; }
            if(f.type==="number"){input.step=f.step ? String(f.step):"any";input.required=f.required===true;}
            if (f.type === "number") globalThis.AtriumLazy?.numericField?.(input,{unit:typeof f.unit==="string" ? f.unit.slice(0,48) : "",
              min:Number.isFinite(f.min) ? f.min : undefined,max:Number.isFinite(f.max) ? f.max : undefined,optional:!f.required,readDesign:()=>e.perms["read:project"]===true});
            if (f.placeholder != null && input.tagName !== "SELECT") input.placeholder = String(f.placeholder);
            if (f.type === "boolean") input.checked = !!f.value; else input.value = f.value ?? "";
            if (f.wide === true) l.classList.add("is-wide"); // label above a full-width field
            inputs.push([name, input, f.type]); l.append(mk("span", String(f.label ?? name)), input);
            if (typeof f.error === "string" && f.error) {
              input.setAttribute("aria-invalid", "true");
              l.append(mk("span", f.error.slice(0, 512), "ui-prop-error"));
            }
            form.append(l);
          }
          const submit = btn(String(v.submit?.label ?? "Apply"), null, v.submit?.primary === false ? "ext-button" : "ext-button is-primary");
          submit.type = "submit"; form.append(submit);
          const send = async action => { const ui=globalThis.AtriumNumericFields; if(ui && !await ui.flush(form))return; const values = {}; for (const [k, i, t] of inputs) values[k] = t === "boolean" ? i.checked : t === "number" ? Number(i.value) : i.value; if (action?.command) run(action.command, values); };
          form.onsubmit = ev => { ev.preventDefault(); send(v.submit); };
          if (v.secondarySubmit?.command) {
            const other = btn(String(v.secondarySubmit.label ?? "Save"), () => send(v.secondarySubmit), "ext-button");
            other.type = "button"; form.append(other);
          }
          frag.append(form); break;
        }
        case "stack": if (budget.depth < VIEW_LIMITS.depth) { budget.depth++; try { frag.append(renderView(e, v.children || [], budget)); } finally { budget.depth--; } } break;
        case "plot": frag.append(plot(v)); break;
      }
    }
    return frag;
  }
  // Render a whole panel view; past the node budget the rest is replaced by a note.
  function renderPanel(e, view) {
    const budget = {n: 0, depth: 0};
    try { return renderView(e, view, budget); }
    catch (err) {
      if (err !== VIEW_FULL) throw err;
      log(e, "warn", "A panel view was cut off at " + VIEW_LIMITS.nodes + " elements; page long lists.");
      const frag = doc.createDocumentFragment();
      frag.append(el("p", "This view is too large to show in full.", "ext-text is-warn"));
      return frag;
    }
  }
  // Line plot from numbers only (arrays or typed arrays), drawn as SVG by the host.
  // {type:"plot", title, xLabel, yLabel, xLog, series:[{name, x:[...], y:[...], color?, style?}]} — up to 8 series.
  // si-sim additions (all optional): size "large"; xRange/yRange [lo, hi]; hlines [{y, label}] (thresholds,
  // dashed); vlines [{x, label}] (cursors); series color (palette index 0-7, so corners of one probe share
  // a colour) and style "dash" | "faint"; legend false. Interaction stays declarative: zoomCommand gets
  // {x0, x1} for a drag across the plot, {x0, x1, wheel} for Ctrl/⌘+wheel and {fit: true} for a double
  // click; cursorCommand gets {x, cursor: "a"} for a click ("b" with Shift). Values are in the plot's x units.
  function plot(v) {
    const ns = "http://www.w3.org/2000/svg", big = v.size === "large", W = big ? 560 : 320, H = big ? 300 : 180, L = big ? 52 : 44, R = big ? 48 : 8, T = 10, B = 26;
    const svgEl = (tag, attrs) => { const n = doc.createElementNS(ns, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
    // null in y (NaN does not survive JSON) breaks the line.
    const series = (Array.isArray(v.series) ? v.series : []).slice(0, 8).map(sr => ({name: String(sr?.name ?? ""), x: Array.from(sr?.x || [], Number), y: Array.from(sr?.y || [], y => (y === null ? NaN : Number(y))),
      color: Number.isInteger(sr?.color) && sr.color >= 0 && sr.color < 8 ? sr.color : null, style: sr?.style === "dash" || sr?.style === "faint" ? sr.style : ""}));
    const fx = x => (v.xLog ? Math.log10(x) : x), ok = (x, y) => Number.isFinite(fx(x)) && Number.isFinite(y);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const sr of series) for (let i = 0; i < Math.min(sr.x.length, sr.y.length); i++) if (ok(sr.x[i], sr.y[i])) {
      const x = fx(sr.x[i]); x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, sr.y[i]); y1 = Math.max(y1, sr.y[i]);
    }
    const range = r => Array.isArray(r) && r.length === 2 && r.every(Number.isFinite) && r[1] > r[0] ? r : null;
    const hl = (Array.isArray(v.hlines) ? v.hlines : []).slice(0, 8).filter(h => Number.isFinite(h?.y)), vl = (Array.isArray(v.vlines) ? v.vlines : []).slice(0, 8).filter(c => Number.isFinite(c?.x));
    if (range(v.xRange)) [x0, x1] = range(v.xRange).map(fx);
    if (range(v.yRange)) [y0, y1] = range(v.yRange); else if (x0 !== Infinity) for (const h of hl) { y0 = Math.min(y0, h.y); y1 = Math.max(y1, h.y); }
    const figure = el("figure", null, "ext-plot" + (big ? " is-large" : ""));
    if (v.title) figure.append(el("figcaption", String(v.title)));
    const svg = svgEl("svg", {viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": String(v.title || "Plot")});
    figure.append(svg);
    if (x0 === Infinity) { figure.append(el("p", "No data.", "ext-text is-muted")); return figure; }
    if (x1 === x0) x1 = x0 + 1; if (y1 === y0) { y1 += 1; y0 -= 1; }
    if (!range(v.yRange)) { const pad = (y1 - y0) * 0.04; y0 -= pad; y1 += pad; }
    const sx = x => L + (fx(x) - x0) / (x1 - x0) * (W - L - R), sy = y => H - B - (y - y0) / (y1 - y0) * (H - T - B);
    const fmt = n => { const a = Math.abs(n); return a !== 0 && (a >= 1e4 || a < 1e-2) ? n.toExponential(1) : String(Number(n.toPrecision(3))); };
    const text = (t, attrs, cls) => { const n = svgEl("text", {...attrs, class: cls}); n.textContent = t; svg.append(n); };
    svg.append(svgEl("rect", {x: L, y: T, width: W - L - R, height: H - T - B, class: "ext-plot-frame"}));
    const ticks = big ? 5 : 2;
    for (let i = 0; i < ticks; i++) {
      const fy = y0 + (y1 - y0) * i / (ticks - 1), fxv = x0 + (x1 - x0) * i / (ticks - 1), py = sy(fy), px = L + (W - L - R) * i / (ticks - 1);
      if (big && i > 0 && i < ticks - 1) { svg.append(svgEl("line", {x1: L, x2: W - R, y1: py, y2: py, class: "ext-plot-grid"})); svg.append(svgEl("line", {x1: px, x2: px, y1: T, y2: H - B, class: "ext-plot-grid"})); }
      text(fmt(fy), {x: L - 4, y: i === ticks - 1 ? T + 4 : i === 0 ? H - B : py + 3, "text-anchor": "end"}, "ext-plot-tick");
      text(fmt(v.xLog ? 10 ** fxv : fxv), {x: px, y: H - B + 12, "text-anchor": i === 0 ? "start" : i === ticks - 1 ? "end" : "middle"}, "ext-plot-tick");
    }
    if (v.xLabel) text(String(v.xLabel), {x: (L + W - R) / 2, y: H - 3, "text-anchor": "middle"}, "ext-plot-label");
    if (v.yLabel) text(String(v.yLabel), {x: 10, y: (T + H - B) / 2, "text-anchor": "middle", transform: "rotate(-90 10 " + (T + H - B) / 2 + ")"}, "ext-plot-label");
    const inside = y => y >= Math.min(y0, y1) && y <= Math.max(y0, y1);
    for (const h of hl) if (inside(h.y)) {
      svg.append(svgEl("line", {x1: L, x2: W - R, y1: sy(h.y), y2: sy(h.y), class: "ext-plot-hline"}));
      if (h.label) text(String(h.label).slice(0, 16), {x: W - R + 2, y: sy(h.y) + 3, "text-anchor": "start"}, "ext-plot-tick");
    }
    const clip = "ext-clip-" + (++plotIds);
    const cp = svgEl("clipPath", {id: clip}); cp.append(svgEl("rect", {x: L, y: T, width: W - L - R, height: H - T - B})); svg.append(cp);
    series.forEach((sr, k) => {
      // A non-finite y breaks the line (folded eye traces, gaps).
      const n = Math.min(sr.x.length, sr.y.length), step = Math.max(1, Math.ceil(n / 1500)), runs = [[]];
      for (let i = 0; i < n; i += step) { if (ok(sr.x[i], sr.y[i])) runs[runs.length - 1].push(sx(sr.x[i]).toFixed(1) + "," + sy(sr.y[i]).toFixed(1)); else if (runs[runs.length - 1].length && runs.length < 400) runs.push([]); }
      for (const pts of runs) if (pts.length) svg.append(svgEl("polyline", {points: pts.join(" "), "clip-path": "url(#" + clip + ")", class: "ext-plot-line ext-plot-s" + (sr.color ?? k) + (sr.style ? " is-" + sr.style : "")}));
    });
    for (const c of vl) if (fx(c.x) >= x0 && fx(c.x) <= x1) {
      svg.append(svgEl("line", {x1: sx(c.x), x2: sx(c.x), y1: T, y2: H - B, class: "ext-plot-cursor"}));
      if (c.label) text(String(c.label).slice(0, 4), {x: sx(c.x) + 2, y: T + 9}, "ext-plot-tick");
    }
    if (v.legend !== false && (series.length > 1 || series[0]?.name)) {
      const legend = el("div", null, "ext-plot-legend"), seen = new Set();
      series.forEach((sr, k) => { const key = sr.name + "|" + (sr.color ?? k); if (seen.has(key)) return; seen.add(key); legend.append(el("span", sr.name, "ext-plot-key ext-plot-s" + (sr.color ?? k) + (sr.style ? " is-" + sr.style : ""))); });
      figure.append(legend);
    }
    // Declarative interaction: the extension gets data-space values and re-renders.
    const zoom = typeof v.zoomCommand === "string" ? v.zoomCommand : null, cursor = typeof v.cursorCommand === "string" ? v.cursorCommand : null;
    if ((zoom || cursor) && !v.xLog) {
      figure.classList.add("is-interactive");
      const toX = ev => { const r = svg.getBoundingClientRect(), px = (ev.clientX - r.left) * W / (r.width || W); return x0 + (Math.max(L, Math.min(W - R, px)) - L) / (W - L - R) * (x1 - x0); };
      let start = null, band = null;
      svg.addEventListener("pointerdown", ev => { if (ev.button !== 0) return; start = {x: toX(ev), cx: ev.clientX, shift: ev.shiftKey}; svg.setPointerCapture?.(ev.pointerId); });
      svg.addEventListener("pointermove", ev => {
        if (!start || !zoom || Math.abs(ev.clientX - start.cx) < 4) return;
        if (!band) { band = svgEl("rect", {y: T, height: H - T - B, class: "ext-plot-band"}); svg.append(band); }
        const a = sx(start.x), b = sx(toX(ev)); band.setAttribute("x", Math.min(a, b)); band.setAttribute("width", Math.abs(b - a));
      });
      svg.addEventListener("pointerup", ev => {
        if (!start) return;
        const s = start; start = null; band?.remove(); band = null;
        if (zoom && Math.abs(ev.clientX - s.cx) >= 4) { const x = toX(ev); run(zoom, {x0: Math.min(s.x, x), x1: Math.max(s.x, x)}); }
        else if (cursor) run(cursor, {x: toX(ev), cursor: s.shift || ev.shiftKey ? "b" : "a"});
      });
      if (zoom) {
        svg.addEventListener("dblclick", () => run(zoom, {fit: true}));
        svg.addEventListener("wheel", ev => {
          if (!(ev.ctrlKey || ev.metaKey)) return; // plain wheel scrolls the panel
          ev.preventDefault();
          const at = toX(ev), f = ev.deltaY > 0 ? 1.25 : 0.8;
          run(zoom, {x0: at - (at - x0) * f, x1: at + (x1 - at) * f, wheel: true});
        }, {passive: false});
      }
    }
    return figure;
  }
  let plotIds = 0;
  const FOCUSABLE = "textarea,input:not([type=hidden]),select,button,[tabindex]:not([tabindex='-1'])";
  // Repaint a panel. A view {type: "stack", follow: true} stays pinned to the bottom while the
  // user has not scrolled up (chat transcripts); other views keep their scroll offset.
  function paintPanel(e, panel, opening) {
    const b = panel.body, follow = panel.view?.follow === true && !Array.isArray(panel.view);
    const pinned = opening || b.scrollHeight - b.scrollTop - b.clientHeight < 24, top = b.scrollTop;
    // A repaint replaces the controls: keep keyboard focus on the same control (by position).
    const had = doc.activeElement && b.contains(doc.activeElement) ? doc.activeElement : null;
    const at = had ? [...b.querySelectorAll(FOCUSABLE)].indexOf(had) : -1;
    const next = renderPanel(e, panel.view);
    const retained = next.querySelectorAll("form[data-retain-draft]");
    if (retained.length) {
      const drafts = [...b.querySelectorAll("form[data-retain-draft]")];
      for (const form of retained) {
        const i = drafts.findIndex(candidate => draftForms.get(candidate) === draftForms.get(form));
        if (i >= 0) form.replaceWith(drafts.splice(i, 1)[0]);
      }
    }
    b.replaceChildren(next);
    b.scrollTop = follow && pinned ? b.scrollHeight : top;
    if (had && !b.contains(doc.activeElement)) {
      const again = [...b.querySelectorAll(FOCUSABLE)][at];
      if (again && again.tagName === had.tagName) again.focus({preventScroll: true});
    }
    if (panel.wantFocus) focusPanel(panel);
  }
  // Opening a panel moves focus into it: a chat box when there is one, else the first
  // control, else the heading until the view arrives. Focus the user has moved elsewhere
  // since the panel opened is left alone. Focus is a nicety: it never breaks a repaint.
  function focusPanel(panel) {
    try {
      const root = panel.root, active = doc.activeElement;
      if (!root || (active && active !== doc.body && active !== panel.focusFrom && !root.contains(active))) { panel.wantFocus = false; return; }
      const usable = n => !n.disabled && !n.closest("[hidden]") && n.getClientRects().length > 0;
      const all = [...panel.body.querySelectorAll(FOCUSABLE)].filter(usable);
      const target = all.find(n => n.tagName === "TEXTAREA") || all[0];
      if (target) { panel.wantFocus = false; target.focus(); return; }
      const h = root.querySelector(".ext-panel-head h2");
      if (h && root.getClientRects().length) { h.tabIndex = -1; h.focus({preventScroll: true}); }
    } catch { panel.wantFocus = false; }
  }
  function panelRoot(e, panel) {
    if (panel.root || !doc) return panel.root;
    const dialog = panel.location === "dialog";
    const root = dialog ? el("dialog", null, "work-dialog ext-dialog") : el("section", null, "ext-panel");
    const head = el("header", null, "ext-panel-head"), body = el("div", null, "ext-panel-body"), title = el("h2", panel.title);
    head.append(title, button(null, () => ui.show(e, panel.id, false), "ui-icon-button ext-close"));
    head.lastChild.setAttribute("aria-label", "Close " + panel.title); head.lastChild.append(iconNode("close"));
    root.append(head, body); root.hidden = !dialog; root.dataset.extension = e.id;
    if (panel.tall && !dialog) root.classList.add("is-tall");
    if (dialog) globalThis.AtriumShell?.adoptDialog(root, {title, body, modeless:true});
    (dialog ? doc.body : doc.getElementById("properties") || doc.body).append(root);
    if (dialog) root.addEventListener("close", () => { if (!root.open && panel.open) ui.show(e, panel.id, false); });
    panel.root = root; panel.body = body;
    return root;
  }
  function menuHost(menu) {
    if (!doc) return null;
    if (menu === "activeBar") return doc.getElementById("tools");
    return doc.querySelector('details[data-menu="' + menu + '"] .menu-items');
  }
  // menu-groups: extension entries form one group at the end of a menu, under a separator; more than
  // EXT_INLINE of them go into an "Extensions ›" submenu (index.html's submenu markup, so the menu bar's
  // keyboard and fit code apply).
  const EXT_INLINE = 3;
  // A contributed entry whose group (manifest "group", or NATIVE_GROUP) names a native submenu of its
  // menu goes into that submenu, without the "Group: " prefix: Tools › Signal Integrity, File › Export.
  const NATIVE_GROUP = {"spice.exportNetlist": "Export"};
  function groupMenu(parent, group) {
    if (typeof group !== "string" || !group) return null;
    const names = [group, globalThis.AtriumI18n?.text?.(group, "menu")];
    return [...parent.querySelectorAll(":scope > .submenu:not(.ext-submenu) > .submenu-trigger")].find(t => names.includes(t.textContent.trim()))?.nextElementSibling || null;
  }
  function placeMenuItem(parent, b) {
    let sep = parent.querySelector(":scope > hr.ext-sep"), sub = parent.querySelector(":scope > .ext-submenu");
    if (!sep) { sep = el("hr", null, "ext-sep"); parent.append(sep); }
    const loose = [...parent.querySelectorAll(":scope > .ext-menuitem")];
    if (!sub && loose.length >= EXT_INLINE) {
      const label = globalThis.AtriumI18n?.text?.("Extensions", "menu") ?? "Extensions";
      sub = el("div", null, "submenu ext-submenu"); sub.setAttribute("role", "none");
      const trig = button(label, null, "submenu-trigger"); trig.setAttribute("role", "menuitem"); trig.setAttribute("aria-haspopup", "menu"); trig.setAttribute("aria-expanded", "false");
      const list = el("div", null, "menu-items submenu-items"); list.setAttribute("role", "menu"); list.setAttribute("aria-label", label);
      list.append(...loose); sub.append(trig, list); parent.append(sub);
    }
    (sub ? sub.lastElementChild : parent).append(b);
  }
  // Keep the group last (modules add native items later) and hide its separator when it is empty.
  function tidyExtGroup(menuEl) {
    const list = menuEl?.querySelector?.(":scope > .menu-items"), sep = list?.querySelector(":scope > hr.ext-sep");
    if (!sep) return;
    const sub = list.querySelector(":scope > .ext-submenu");
    list.append(sep, ...(sub ? [sub] : []), ...list.querySelectorAll(":scope > .ext-menuitem"));
    sep.hidden = !list.querySelector(":scope > .ext-menuitem, :scope > .ext-submenu .ext-menuitem");
    if (sub) sub.hidden = !sub.querySelector(".ext-menuitem");
  }
  // ui.showMessage(text, {messages: [{class, text, objectId, point}]}): rows for the Messages panel,
  // in a group named after the extension, so it can neither replace nor pose as the editor's own
  // checks. Plain text only, Error/Warning/Info, at most MAX_REPORT rows.
  // Messages Source column (F7): always marked "(extension)", and never a built-in source's name.
  const RESERVED_SOURCES = /^(waffle|atrium|editor|compiler|drc|erc|rules?|rule summary|import|altium|kicad|eagle|easyeda|pdn|si|spice( \.op)?|waived|net antennae|netlist|netlist-import|messages|board|schematic|pcb|eco|bom|teardrops?|length|timing|dfa|z-clearance)$/i;
  const sourceName = e => (RESERVED_SOURCES.test(String(e.manifest.name).trim()) ? e.id : String(e.manifest.name).trim()) + " (extension)";
  const REPORT_CLASSES = ["Error", "Warning", "Info"], MAX_REPORT = 2000;
  function report(e, list) {
    const source = sourceName(e), group = source;
    const docName = (() => { try { const p = host.project(); return p.documents.find(d => d.id === host.documentId())?.name || ""; } catch { return ""; } })();
    const rows = list.slice(0, MAX_REPORT).filter(m => m && typeof m === "object" && !Array.isArray(m)).map(m => ({
      class: REPORT_CLASSES.includes(m.class) ? m.class : "Info", source, document: docName, text: String(m.text ?? "").slice(0, 2000),
      ...(typeof m.objectId === "string" && m.objectId ? {objectId: m.objectId} : {}),
      ...(Array.isArray(m.point) && m.point.length === 2 && m.point.every(Number.isFinite) ? {point: [m.point[0], m.point[1]]} : {})
    }));
    if (list.length > MAX_REPORT) rows.push({class: "Info", source, document: docName, text: "… " + (list.length - MAX_REPORT) + " more messages were not shown."});
    const ctx = {currentProject: () => host?.project(), info: t => host?.info?.(t), select: id => host?.locate?.(id), exportFile: host?.exportFile};
    const show = M => { M.update(group, rows); M.open(ctx); };
    if (globalThis.AtriumMessages) show(AtriumMessages);
    else globalThis.AtriumLazy?.need?.("AtriumMessages").then(show, () => {});
  }
  const ui = {
    message(e, text, o = {}) { host?.info?.(text); if (o.level === "error" || o.level === "warn") log(e, o.level, text); if (Array.isArray(o.messages)) report(e, o.messages); return true; },
    status(e, id, item) {
      const old = e.statusItems.get(id);
      if (!item) { old?.remove?.(); e.statusItems.delete(id); return true; }
      if (!doc) { e.statusItems.set(id, {remove() {}}); return true; }
      let bar = doc.getElementById("ext-status");
      if (!bar) { bar = el("span", null, "ext-status"); bar.id = "ext-status"; const s = doc.getElementById("status"); s ? s.after(bar) : doc.querySelector(".statusbar")?.append(bar); }
      // `_action` exists only for the host's own items; extension data cannot carry functions.
      const act = typeof item._action === "function" && e.origin === "script" && e.id.startsWith("waffle.") ? item._action : item.command ? () => run(item.command, ...(item.args || [])) : null;
      const n = act ? button(String(item.text ?? ""), act, "ext-status-item") : el("span", String(item.text ?? ""), "ext-status-item");
      if (act) n.dataset.hover = "raised-ink";
      if (item.tooltip) n.title = String(item.tooltip);
      if (old) old.replaceWith(n); else bar?.append(n);
      e.statusItems.set(id, n);
      return true;
    },
    panel(e, id, o = {}, contributed = false) {
      if (!contributed && !(e.manifest.contributes?.panels || []).some(p => p.id === id)) throw Error("Declare panel " + id + " under contributes.panels.");
      const existing = e.panels.get(id);
      if (existing) return true;
      const panel = {id, title: String(o.title || id), location: o.location === "dialog" ? "dialog" : "right", tall: o.tall === true, open: false, view: null};
      e.panels.set(id, panel);
      const host2 = menuHost("panels");
      if (host2) {
        const b = button(panel.title, () => { closeMenus(); toggle(e, id); }, "ext-menuitem");
        b.setAttribute("role", "menuitem"); b.dataset.extension = e.id; host2.append(b); panel.menuNode = b;
      }
      return true;
    },
    render(e, id, view) {
      const size = sizeOf(view);
      if (size > LIMITS.viewChars) throw Error("The panel view is too large; page long lists.");
      const panel = e.panels.get(id);
      if (!panel) throw Error("Unknown panel " + id + ".");
      panel.view = view;
      if (panel.open && doc) { panelRoot(e, panel); paintPanel(e, panel); }
      return true;
    },
    show(e, id, open) {
      const panel = e.panels.get(id);
      if (!panel) throw Error("Unknown panel " + id + ".");
      const closing = panel.open && !open;
      panel.open = !!open;
      if (closing) panelEvent(e, "panelHidden", id);
      if (!doc) return true;
      const root = panelRoot(e, panel);
      if (open) {
        const opening = panel.location === "dialog" ? !root.open : root.hidden;
        if (opening) { panel.wantFocus = true; panel.focusFrom = doc.activeElement; }
        if (panel.view) paintPanel(e, panel, true);
        else if (!panel.body.childNodes.length) panel.body.append(el("p", "Loading…", "ext-text is-muted"));
        if (panel.location === "dialog") { if (!root.open) root.show(); } else { root.hidden = false; doc.body.classList.remove("hide-right"); }
        if (panel.wantFocus) focusPanel(panel);
      } else if (panel.location === "dialog") root.open && root.close(); else root.hidden = true;
      panel.menuNode?.setAttribute("aria-pressed", String(!!open));
      return true;
    },
    menu(e, item, contributed = false) {
      const c = registry.commands.get(item.command);
      const title = String(item.title || c?.title || item.command), menu = item.menu || "tools";
      if (!MENUS.includes(menu)) throw Error("Unknown menu " + menu + ".");
      const entry = {menu, command: item.command, title, when: item.when, node: null, contributed};
      e.menuItems.push(entry);
      const parent = menuHost(menu);
      if (parent) {
        let b;
        if (menu === "activeBar") {
          b = button(null, () => run(item.command), "tool ext-tool");
          if (item.icon && /^[a-z-]+$/.test(item.icon)) b.append(iconNode(item.icon)); else b.append(el("span", title.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase(), "ext-tool-label"));
          b.title = title; b.setAttribute("aria-label", title);
        } else {
          b = button(title, () => { closeMenus(); run(item.command); }, "ext-menuitem");
          b.setAttribute("role", "menuitem");
        }
        b.dataset.extension = e.id;
        if (entry.when) { b.dataset.when = entry.when; whenNodes++; if (menu === "activeBar") b.hidden = !when(entry.when); }
        const into = menu === "activeBar" || !contributed ? null : groupMenu(parent, item.group || NATIVE_GROUP[item.command]);
        if (into && title.startsWith(item.group + ": ")) b.textContent = title.slice(item.group.length + 2);
        if (menu === "activeBar") parent.append(b); else if (into) into.append(b); else placeMenuItem(parent, b); // menu-groups
        entry.node = b;
      }
      return true;
    },
    input(e, o = {}) { return oneModal(e, () => dialogPrompt(String(o.title || ""), String(o.prompt || ""), String(o.value ?? ""), o.placeholder, e), v => v == null); },
    pick(e, items, o = {}) { return oneModal(e, () => dialogPick(String(o.title || ""), Array.isArray(items) ? items.slice(0, 500) : [], e), v => v == null); },
    confirm(e, text, o = {}) { return oneModal(e, () => dialogConfirm(String(o.title || ""), String(text ?? ""), String(o.confirm || "OK"), e), v => v !== true); },
    // si-sim: files.pickText opens the system picker, one dialog at a time like the others.
    pickFile(e, accept) { return oneModal(e, () => (host?.pickFile ? host.pickFile(accept) : null), v => v == null); }
  };
  // ------------------------------------------------------------ decorations
  // ui.decorations.set (AtriumAPI checks and scrubs the items): per extension, per document, drawn
  // by one canvas renderer above the design. Read-only: no hit testing, no hover pop-ups, no DOM.
  const decorations = new Map(); // ext id -> Map(doc id -> items)
  const decorationCache = new Map(); // doc id -> {rev, version, list}
  let decorationOff = null, decorationVersion = 0, decorationInk = null;
  ui.decorate = (e, docId, items) => {
    let m = decorations.get(e.id);
    if (items == null) { if (m) { if (docId == null) m.clear(); else m.delete(docId); } }
    else {
      if (!m) decorations.set(e.id, m = new Map());
      if (!m.has(docId) && m.size >= AtriumAPI.DECORATION_LIMITS.docs) throw Error("ui.decorations.set: decorations on at most " + AtriumAPI.DECORATION_LIMITS.docs + " documents.");
      if (items.length) m.set(docId, items); else m.delete(docId);
    }
    if (m && !m.size) decorations.delete(e.id);
    syncDecorations();
    return true;
  };
  function clearDecorations(id) { if (decorations.delete(id)) syncDecorations(); }
  function syncDecorations() {
    decorationVersion++; decorationCache.clear();
    const H = globalThis.AtriumNavHost;
    if (decorations.size && !decorationOff && H?.addRenderer)
      decorationOff = H.addRenderer(d => d && [...decorations.values()].some(m => m.has(d.id)) ? {overlay: (ctx, a) => drawDecorations(ctx, a, d)} : null);
    else if (!decorations.size && decorationOff) { decorationOff(); decorationOff = null; }
    if (H?.invalidate) H.invalidate(); else H?.redraw?.();
  }
  // Where each decoration of a document sits now: anchors follow their objects (a part's pin, a
  // part's origin, another object's centre); a decoration whose object is gone is not drawn.
  // Recomputed only when the design or the decorations change.
  function decorationPoints(d) {
    const rev = host?.revision?.() ?? 0, hit = decorationCache.get(d.id);
    if (hit && hit.rev === rev && hit.version === decorationVersion && hit.items === d.items) return hit.list;
    const A = globalThis.Atrium, list = [];
    let byId = null, defs = null;
    for (const [owner, m] of decorations) for (const it of m.get(d.id) || []) {
      let at = it.at;
      if (it.anchor) {
        byId ??= new Map(d.items.map(i => [i.id, i]));
        const obj = byId.get(it.anchor.id);
        if (!obj) continue;
        defs ??= host?.defs?.() || new Map((host?.project?.().library || []).map(x => [x.id, x]));
        const def = obj.def != null ? defs.get(obj.def) : null;
        if (obj.kind === "part" && it.anchor.pin != null) at = A?.pins?.(obj, def, d.kind)?.find(p => String(p.number) === it.anchor.pin)?.at;
        else if (obj.kind === "part" && Number.isFinite(obj.x)) at = [obj.x, obj.y];
        else { const b = A?.bounds?.(A.itemPoints(obj, def, d.kind)); at = b ? [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2] : null; }
        if (!at) continue;
      }
      if (it.offset) at = [at[0] + it.offset[0], at[1] + it.offset[1]];
      list.push({at, it, owner});
    }
    decorationCache.set(d.id, {rev, version: decorationVersion, items: d.items, list});
    return list;
  }
  function inks() {
    const now = Date.now();
    if (decorationInk && now - decorationInk.at < 2000) return decorationInk;
    let css = null;
    try { css = doc?.defaultView?.getComputedStyle?.(doc.documentElement); } catch {}
    const v = (name, fallback) => css?.getPropertyValue(name)?.trim() || fallback;
    return decorationInk = {at: now, info: v("--info", "#75beff"), success: v("--success", "#6fcf97"), warning: v("--warning", "#f0c46a"), danger: v("--danger", "#f0706a"),
      accent: v("--accent", "#4daafc"), muted: v("--muted", "#9a9a9a"), halo: v("--canvas-bg", "#1e1e1e")};
  }
  function drawDecorations(ctx, a, d) {
    const list = decorationPoints(d);
    if (!list.length || typeof a?.worldToScreen !== "function") return;
    const ink = inks(), W = (a.width || 1e5) / (a.dpr || 1) + 80, H = (a.height || 1e5) / (a.dpr || 1) + 80;
    ctx.save(); ctx.setTransform(a.dpr || 1, 0, 0, a.dpr || 1, 0, 0);
    ctx.textBaseline = "middle"; ctx.lineJoin = "round";
    for (const {at, it} of list) {
      const [x, y] = a.worldToScreen(at);
      if (!(x > -80 && y > -80 && x < W && y < H)) continue;
      const colour = ink[it.tone || (it.kind === "label" ? "info" : "accent")] || ink.info, small = it.size === "small";
      ctx.strokeStyle = colour; ctx.fillStyle = colour; ctx.lineWidth = 1.5;
      let tx = x + 6;
      if (it.kind === "marker") {
        ctx.beginPath(); ctx.arc(x, y, small ? 4 : 6, 0, Math.PI * 2); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke();
        tx = x + 11;
      } else if (it.kind === "probe") {
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 7, y - 7); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 2.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(x + 9, y - 9, small ? 3 : 4, 0, Math.PI * 2); ctx.stroke();
        tx = x + 15;
      }
      if (!it.text) continue;
      ctx.font = (small ? "500 10px" : "600 11px") + " system-ui, sans-serif";
      const ty = it.kind === "probe" ? y - 9 : y;
      ctx.lineWidth = 3; ctx.strokeStyle = ink.halo; ctx.strokeText(it.text, tx, ty); ctx.fillText(it.text, tx, ty);
    }
    ctx.restore();
  }
  // One dialog per extension at a time, so a loop cannot stack prompts; none while paused.
  function oneModal(e, open, cancelled) {
    if (safeMode()) throw Error("Extensions are paused.");
    if (e.modal) throw Error("A dialog from " + e.manifest.name + " is already open.");
    e.modal = true;
    return Promise.resolve(open()).then(v => { if (cancelled(v)) dismissed(e); return v; }).finally(() => { e.modal = false; });
  }
  // An extension that keeps reopening dialogs the user dismisses (a lock-out or
  // phishing loop) is disabled after MAX_DISMISSALS within DISMISS_WINDOW.
  function dismissed(e) {
    const now = Date.now();
    e.dismissals = (e.dismissals || []).filter(t => now - t < DISMISS_WINDOW);
    e.dismissals.push(now);
    if (e.dismissals.length < MAX_DISMISSALS) return;
    e.dismissals = [];
    const note = "Disabled: it kept reopening dialogs you dismissed.";
    host?.info?.(e.manifest.name + " was disabled because it kept reopening dialogs you dismissed.");
    if (exts.get(e.id) === e) setEnabled(e.id, false, note).catch(() => {});
    else for (const p of pools.values()) if (p.owner === e.id) stop(p, note);
  }
  // `ui` methods receive the extension record; API instances pass {id}.
  const uiFor = () => new Proxy(ui, {get: (t, k) => (ext, ...a) => t[k](exts.get(ext.id) || scriptRecord(ext.id), ...a)});
  const scriptRecords = new Map();
  function scriptRecord(id) {
    let r = scriptRecords.get(id);
    if (!r) scriptRecords.set(id, r = record({id, name: "Script", contributes: {}}, "script", true));
    return r;
  }
  function toggle(e, id) {
    const panel = e.panels.get(id);
    const open = !panel?.open;
    ui.show(e, id, open);
    if (open) {
      const fire = () => panelEvent(e, "panelShown", id);
      if (e.status !== "active") activate(e.id, "onView:" + id).then(fire, err => { panel.body?.replaceChildren(el("p", err.message, "ext-text is-error")); });
      else fire();
    }
  }
  // Every dialog an extension causes names the extension. Text the extension supplies
  // (its title, prompt, items) is shown below that label, never as the heading.
  function modal(title, build, owner, subtitle) {
    if (!doc) return Promise.resolve(null);
    return new Promise(resolve => {
      const d = el("dialog", null, "work-dialog ext-prompt"), form = el("form"), actions = el("div", null, "work-actions");
      let result = null;
      form.method = "dialog";
      const done = v => { result = v; d.close(); };
      if (owner) d.dataset.extension = owner.id;
      const heading = el("h2", owner && !title ? owner.manifest.name + " (extension)" : title);
      form.append(heading);
      if (subtitle) form.append(el("p", subtitle, "ext-text ext-prompt-title"));
      build(form, actions, done);
      if (owner && owner.origin !== "script" && exts.get(owner.id) === owner) {
        const stopIt = button("Disable " + owner.manifest.name, () => { done(null); setEnabled(owner.id, false, "Disabled from one of its dialogs.").catch(() => {}); }, "ext-prompt-stop");
        stopIt.dataset.variant = "danger";
        actions.prepend(stopIt);
      }
      const hint = el("p", null, "ext-text is-muted ext-prompt-hint");
      hint.append("Press ", AtriumShortcut.render("Escape", {variant:"inline"}), " three times or ",
        AtriumShortcut.render("Mod+Shift+Escape", {variant:"inline"}), " to pause all extensions.");
      form.append(hint);
      const body = Array.from(form.children).slice(1);
      const accept = actions.lastElementChild;
      if (accept && !accept.dataset.variant) {
        accept.dataset.variant = "primary";
        if (accept.type !== "submit") accept.dataset.uiDefault = "false";
      }
      const firstAction = actions.firstElementChild;
      const controls = Array.from(form.querySelectorAll("input, select, textarea, button"));
      form.append(actions); d.append(form);
      globalThis.AtriumShell?.adoptDialog(d, {title:heading, body, actions,
        initialFocus:() => controls.find(AtriumUI.available) || firstAction});
      owner?.dialogs?.add(d);
      d.addEventListener("close", () => { owner?.dialogs?.delete(d); d.remove(); resolve(result); }, {once: true});
      doc.body.append(d); d.showModal();
    });
  }
  const dialogPrompt = (title, prompt, value, placeholder, owner) => modal(null, (form, actions, done) => {
    const input = el("input", null, "ui-field"); input.value = String(value); if (placeholder) input.placeholder = String(placeholder);
    input.setAttribute("aria-label", prompt || title);
    if (prompt) form.append(el("p", prompt));
    form.append(input);
    actions.append(button("Cancel", () => done(null)), button("OK", () => done(input.value)));
    actions.lastChild.type = "submit"; form.onsubmit = ev => { ev.preventDefault(); done(input.value); };
    setTimeout(() => input.select(), 0);
  }, owner, title);
  const dialogPick = (title, items, owner) => modal(null, (form, actions, done) => {
    const list = el("div", null, "work-list ext-pick");
    for (const it of items) { const label = typeof it === "string" ? it : String(it?.label ?? ""); const b = button(null, () => done(it), "ui-row ext-list-row"); b.append(el("span", label)); if (it?.detail) b.append(el("small", String(it.detail))); list.append(b); }
    const cancel = button("Cancel", () => done(null));
    cancel.dataset.variant = "secondary";
    form.append(list); actions.append(cancel);
  }, owner, title);
  const dialogConfirm = (title, text, label, owner) => modal(owner ? null : title, (form, actions, done) => {
    form.append(el("p", text)); actions.append(button("Cancel", () => done(false)), button(label, () => done(true)));
  }, owner, owner ? title : null).then(v => v === true);

  // ------------------------------------------------------------ consent UI
  function consentDialog(r, owner) {
    const name = r.manifest.name;
    if (r.kind === "install" || r.kind === "activate") return modal((r.kind === "install" ? "Install " : "Allow ") + name + "?", (form, actions, done) => {
      form.append(el("p", (r.manifest.publisher ? r.manifest.publisher + " · " : "") + r.manifest.id + " " + r.manifest.version + " asks for:"));
      if (r.developer) form.append(el("p", "Developer mode: loaded unpacked from a folder you chose. This load is pinned to " + r.developer.slice(0, 23) + "…; it runs in the same sandbox.", "ext-text ext-dev-note"));
      const boxes = [], list = el("div", null, "ext-consent");
      for (const perm of r.permissions) {
        const l = el("label", null, "work-row"), cb = el("input", null, "ui-checkbox"), text = el("span", perm), [kind, tone] = permissionKind(perm);
        // Off until the user ticks them: direct writes (then it asks each time), network hosts, programs.
        cb.type = "checkbox"; cb.checked = !(perm === "write:edits" || perm === "run:external" || AtriumAPI.isNetworkPermission(perm));
        text.append(" ", chip(kind, tone), el("small", perm === "write:edits" ? "Allow direct edits to " + r.target + ". Leave unchecked to review the request first." : describePermission(perm)));
        l.append(cb, text); list.append(l); boxes.push([perm, cb]);
      }
      if (!r.permissions.length) list.append(el("p", "No permissions. It cannot read or change the design.", "ext-text is-muted"));
      form.append(list, el("p", "Extensions run in a sandbox with no access to your files, the network or the editor beyond these permissions. You can change them later in Tools › Extensions.", "ext-text is-muted"));
      actions.append(button("Cancel", () => done(null)), button(r.kind === "install" ? "Install" : "Allow", () => {
        const out = {};
        for (const [perm, cb] of boxes) if (cb.checked) out[perm] = true; else if (perm !== "write:edits") out[perm] = false;
        done(out);
      }));
    });
    const preview = list => {
      const box = el("div", null, "work-list ext-review");
      for (const row of list.slice(0, 200)) { const d = el("div", null, "work-row"), t = el("span", row.label); t.append(el("small", row.detail || "")); d.append(t); box.append(d); }
      if (list.length > 200) box.append(el("p", "… and " + (list.length - 200) + " more", "ext-text is-muted"));
      return box;
    };
    if (r.kind === "write") return modal(name + " wants to change the design", (form, actions, done) => {
      form.append(el("p", r.label + " · " + r.total + " change" + (r.total === 1 ? "" : "s") + " in " + r.target + ". It applies as one step you can undo."), preview(r.rows));
      actions.append(button("Deny", () => done("never")), button("Review…", () => done("review")), button("Allow once", () => done("once")), button("Allow for this project", () => done("always")));
    }, owner);
    if (r.kind === "review") return modal("Review changes from " + name, (form, actions, done) => {
      // The visual diff's property table (diff-props.js): one table per changed object, Before struck
      // through, After highlighted, a checkbox per change. Nothing applies until Apply selected.
      const box = el("div", null, "ext-review ext-review-diff"), checks = [], D = globalThis.AtriumDiffProps;
      form.append(el("p", r.label + " · " + r.total + " change" + (r.total === 1 ? "" : "s") + ". Choose the changes to apply; they apply as one step you can undo."));
      let shown = 0;
      const pick = index => { const cb = el("input"); cb.type = "checkbox"; cb.checked = true; checks.push([index, cb]); return cb; };
      if (D) for (const g of D.proposalGroups(r.rows.slice(0, 2000))) {
        if (shown >= 2000) break;
        const sec = el("section", null, "ext-review-object"), head = el("div", null, "ext-review-head");
        sec.dataset.status = g.status; head.append(D.glyph(doc, g.status), el("strong", g.title));
        sec.append(head, D.table(doc, g.rows.map(x => ({...x, control: pick(x.index)})), {limit: 2000}));
        box.append(sec); shown += g.rows.length;
      } else r.rows.slice(0, 2000).forEach(row => {
        const l = el("label", null, "work-row"), t = el("span", row.label);
        t.append(el("small", row.detail || "")); l.append(pick(row.index), t); box.append(l);
      });
      if (r.total > 2000) box.append(el("p", "… and " + (r.total - 2000) + " more, which stay unapplied.", "ext-text is-muted"));
      form.append(box);
      actions.append(button("Discard", () => done(false)), button("Apply selected", () => done(checks.filter(([, c]) => c.checked).map(([i]) => i)), "is-primary"));
    }, owner).then(v => v || false);
    return Promise.resolve(null);
  }

  // ------------------------------------------------------------ installation
  const MANIFEST_FILE = "waffle-extension.json";
  const manifestKey = files => Object.keys(files).find(k => k === MANIFEST_FILE || k.endsWith("/" + MANIFEST_FILE));
  const packagePrefix = key => key.slice(0, -MANIFEST_FILE.length);

  // JSONC is a host-side theme resource. Read only manifest-bound candidates under the package root.
  async function readDeclaredJSONC(files, candidates, read) {
    if (!candidates.size) return;
    const key = manifestKey(files);
    if (!key) return;
    let manifest;
    try { manifest = JSON.parse(files[key]); } catch { return; } // install reports the manifest error
    const prefix = packagePrefix(key);
    for (const path of declaredThemePaths(manifest)) {
      const name = prefix + path, entry = candidates.get(name);
      if (entry) await read(name, entry);
    }
  }

  async function readZip(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw Error("This is not a ZIP archive.");
    const count = dv.getUint16(eocd + 10, true), files = {}, tooBig = () => Error("Extension packages are limited to " + MAX_PACKAGE / 1e6 + " MB.");
    if (count > MAX_ZIP_ENTRIES) throw Error("The package has too many files.");
    let p = dv.getUint32(eocd + 16, true), total = 0;
    const candidates = new Map();
    async function readEntry(name, {method, size, declared, local}) {
      // Check sizes before inflating anything: the declared size against what is left
      // of the budget, then the inflated stream against the declared size (a lying
      // header is cut off at the first chunk past it).
      if (declared === 0xffffffff || size === 0xffffffff || total + declared > MAX_PACKAGE) throw tooBig();
      // Compression ratio as AtriumSexpr.unzip (sexpr.js).
      if (declared > 1024 * 1024 && declared > size * 400) throw Error("The ZIP entry " + name + " has a suspicious compression ratio.");
      if (local + 30 > u8.length) throw Error("The ZIP directory is damaged.");
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const raw = u8.subarray(start, start + size);
      let data;
      if (method === 0) data = raw;
      else if (method === 8 && typeof DecompressionStream === "function") data = await inflate(raw, declared);
      else throw Error("Unsupported ZIP compression in " + name + ".");
      if (data.length !== declared) throw Error("The ZIP entry " + name + " is damaged.");
      if ((total += data.length) > MAX_PACKAGE) throw tooBig();
      files[name] = /\.wasm$/i.test(name) ? asData(data) : new TextDecoder().decode(data);
    }
    for (let n = 0; n < count; n++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) throw Error("The ZIP directory is damaged.");
      const method = dv.getUint16(p + 10, true), size = dv.getUint32(p + 20, true), nameLen = dv.getUint16(p + 28, true), declared = dv.getUint32(p + 24, true);
      const extra = dv.getUint16(p + 30, true), comment = dv.getUint16(p + 32, true), local = dv.getUint32(p + 42, true);
      const name = norm(new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen)));
      p += 46 + nameLen + extra + comment;
      if (isJSONC(name)) {
        if (declared <= MAX_THEME_BYTES) candidates.set(name, {method, size, declared, local});
      } else if (/\.(js|json|md|txt|wasm)$/i.test(name)) await readEntry(name, {method, size, declared, local});
    }
    await readDeclaredJSONC(files, candidates, readEntry);
    return files;
  }
  async function inflate(raw, cap) {
    const reader = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader(), parts = [];
    let n = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      if ((n += value.length) > cap) { reader.cancel().catch(() => {}); throw Error("A ZIP entry inflates past its declared size."); }
      parts.push(value);
    }
    const out = new Uint8Array(n);
    let o = 0;
    for (const part of parts) { out.set(part, o); o += part.length; }
    return out;
  }
  // Strip a shared top-level folder ("my-ext/waffle-extension.json" -> "waffle-extension.json").
  function rootFiles(files) {
    const key = manifestKey(files);
    if (!key) throw Error("The package has no waffle-extension.json.");
    const prefix = packagePrefix(key), out = {};
    for (const [k, v] of Object.entries(files)) if (k.startsWith(prefix)) out[k.slice(prefix.length)] = v;
    return out;
  }
  async function packageFromFiles(list) {
    const files = {};
    const arr = Array.from(list || []), candidates = new Map();
    if (!arr.length) throw Error("Choose an extension package.");
    for (const f of arr) {
      const name = norm(f.webkitRelativePath || f.name);
      if (/\.zip$/i.test(name)) Object.assign(files, await readZip(new Uint8Array(await f.arrayBuffer())));
      else if (/\.waffle-extension$/i.test(name)) { const b = JSON.parse(await f.text()); Object.assign(files, b.files || {}, {"waffle-extension.json": JSON.stringify(b.manifest)}); }
      else if (/\.(js|json|md|txt)$/i.test(name)) files[name] = await f.text();
      else if (/\.wasm$/i.test(name)) files[name] = asData(new Uint8Array(await f.arrayBuffer()));
      else if (isJSONC(name) && !(f.size > MAX_THEME_BYTES)) candidates.set(name, f);
    }
    await readDeclaredJSONC(files, candidates, async (name, file) => { files[name] = await file.text(); });
    return rootFiles(files);
  }
  async function install(files, {origin = "user", enable} = {}) {
    const raw=JSON.parse(files["waffle-extension.json"]);
    await checkNotebook(raw,files);
    const manifest=validateManifest(raw,files);
    const prior = exts.get(manifest.id);
    if (prior?.origin === "project") throw Error(manifest.id + " is provided by the open project.");
    if (prior?.origin === "builtin") throw Error(manifest.id + " is built into Waffle.");
    const kept = {}, themes = declaredThemePaths(manifest);
    let total = 0;
    for (const [k, v] of Object.entries(files)) if (keepPackageFile(k, themes)) { kept[k] = v; total += v.length; }
    if (total > MAX_PACKAGE * 1.4) throw Error("Extension packages are limited to " + MAX_PACKAGE / 1e6 + " MB.");
    const hash = manifest.contributes?.mathFunctions?.length ? bundleDigest(manifest, kept) : null;
    if (hash) await checkNotebook(manifest,kept,{id:manifest.id,manifest,hash});
    // Show the permissions at install. An update that asks for different ones asks again.
    // Cancelling it leaves the installed version's answers as they were.
    const same = prior && JSON.stringify([...(prior.manifest.permissions || [])].sort()) === JSON.stringify([...(manifest.permissions || [])].sort());
    const previous = prior && !same ? {grant: grantOf(manifest.id), writes: openWrites.get(manifest.id)} : null;
    if (!same) saveGrant(manifest.id, null);
    let accepted = false;
    try { accepted = await acknowledge({id: manifest.id, manifest, perms: {}}, "install"); }
    finally {
      if (!accepted && previous?.grant && !grantOf(manifest.id)) { saveGrant(manifest.id, previous.grant); if (previous.writes) openWrites.set(manifest.id, previous.writes); }
    }
    if (!accepted) throw Error("Installation cancelled.");
    if (prior) { await deactivate(prior.id); removeContributions(prior); }
    await code.put(manifest.id, kept);
    const e = recordOf(manifest, origin, enable ?? (manifest.enabledByDefault !== false || prior?.enabled === true));
    if (hash) e.hash = hash;
    if (prior) { e.storage = prior.storage; e.logs = prior.logs; }
    exts.set(manifest.id, e);
    saveIndex();
    if (registry && e.enabled) { registerContributions(e); await admitNotebook(e); startupCheck(e); }
    log(e, "info", (prior ? "Updated to " : "Installed ") + manifest.version + ".");
    touch(e);
    return e;
  }
  async function uninstall(id) {
    const e = exts.get(id);
    if (!e || e.origin !== "user") throw Error("Only installed extensions can be removed.");
    e.enabled = false;
    await deactivate(id);
    if (exts.get(id) !== e) return;
    removeContributions(e);
    const key = "ext:" + id, owner = pools.get(key);
    if (owner?.worker) stop(owner, "Extension uninstalled.", "cancelled");
    pools.delete(key);
    exts.delete(id); await code.delete(id); ls.del(STORE + id); ls.del(SETTINGS + id); saveGrant(id, null);
    saveIndex(); touch(e);
  }
  async function setEnabled(id, enabled, note) {
    const e = exts.get(id);
    if (!e) throw Error("Unknown extension " + id + ".");
    if (enabled && e.manifest.contributes?.mathFunctions?.length && (e.origin !== "project" || trusted(e))) {
      await checkNotebook(e.manifest,null,e);
      if (exts.get(id) !== e) return;
    }
    if (!enabled) { e.enabled = false; if (e.manifest.contributes?.aiProviders?.length) invalidateAI(e); await deactivate(id); removeContributions(e); e.status = "disabled"; }
    else { e.enabled = true; e.strikes = 0; e.errors = []; e.status = e.origin === "project" && !trusted(e) ? "blocked" : "inactive"; if (registry && e.status !== "blocked") { registerContributions(e); await admitNotebook(e); startupCheck(e); } }
    if (note) log(e, "warn", note);
    if (e.origin === "user") saveIndex();
    if (e.origin === "builtin") { const st = ls.get(BUILTIN_STATE, {}); st[e.id] = e.enabled; ls.set(BUILTIN_STATE, st); }
    touch(e);
  }
  async function reload(id) {
    const e = exts.get(id);
    if (!e) return;
    await deactivate(id); removeContributions(e);
    e.errors = []; e.strikes = 0;
    if (e.enabled && registry) { registerContributions(e); if (e.status !== "blocked") { e.status = "inactive"; startupCheck(e); } }
    touch(e);
  }

  // ------------------------------------------------------------ developer mode
  // An unpacked folder loaded for development (app/extension-dev.js: Load unpacked…, Reload from
  // folder, Console). Off by default: Preferences › Extension Development. The sandbox does not
  // change: the code runs in its own worker in the CSP-locked iframe with the same per-call
  // permission checks and prompts. The code is held in memory only (never stored, gone at the next
  // start), and each load is pinned to the SHA-256 of its exact files: grants belong to id@sha256
  // (as for project bundles), the digest is re-checked at activation, and the install prompt shows
  // it. A reload whose permissions are unchanged keeps the previous answers, as an update of an
  // installed extension does; any other change asks again.
  const DEV_PREF = "extensions.developerMode", devCode = new Map();
  const developerMode = () => {
    const o = options.developerMode; // hosts and tests may decide; otherwise the preference
    if (typeof o === "function") return o() === true;
    if (o != null) return o === true;
    return (globalThis.AtriumPref || globalThis.AtriumPrefs)?.get?.(DEV_PREF) === true; // AtriumPref reads the stored value before prefs.js loads
  };
  const samePermissions = (a, b) => JSON.stringify([...(a.permissions || [])].sort()) === JSON.stringify([...(b.permissions || [])].sort());
  async function installDev(files) {
    if (!developerMode()) throw Error("Developer mode is off. Turn it on in Preferences › Extension Development.");
    if (typeof files?.["waffle-extension.json"] !== "string") throw Error("The folder has no waffle-extension.json.");
    const raw=JSON.parse(files["waffle-extension.json"]);
    await checkNotebook(raw,files);
    const manifest=validateManifest(raw,files);
    const prior = exts.get(manifest.id);
    if (prior && prior.origin !== "dev") throw Error(manifest.id + (prior.origin === "builtin" ? " is built into Waffle" : prior.origin === "project" ? " is provided by the open project" : " is already installed") + ". Give the unpacked copy another id.");
    const kept = {}, themes = declaredThemePaths(manifest);
    let total = 0;
    for (const [k, v] of Object.entries(files)) if (k !== MANIFEST_FILE && keepPackageFile(k, themes) && typeof v === "string") {
      kept[k] = v; total += v.length;
    }
    if (total > MAX_PACKAGE * 1.4) throw Error("Extension packages are limited to " + MAX_PACKAGE / 1e6 + " MB.");
    const e = record(manifest, "dev", true);
    e.hash = bundleDigest(manifest, kept); e.loadedAt = Date.now();
    if (manifest.contributes?.mathFunctions?.length) await checkNotebook(e.manifest,null,e);
    const same = !!prior && samePermissions(prior.manifest, manifest);
    if (same && prior.hash !== e.hash && grantOf(prior)) saveGrant(e, clone(grantOf(prior)));
    syncPerms(e);
    if (!await acknowledge(e, "install", !same)) { if (!prior || prior.hash !== e.hash) saveGrant(e, null); throw Error("Loading cancelled."); }
    if (prior) { await deactivate(prior.id); removeContributions(prior); if (prior.hash !== e.hash) saveGrant(prior, null); e.storage = prior.storage; e.logs = prior.logs; }
    devCode.set(manifest.id, kept);
    exts.set(manifest.id, e);
    if (registry) { registerContributions(e); await admitNotebook(e); startupCheck(e); }
    log(e, "info", (prior ? "Reloaded " : "Loaded ") + manifest.version + " unpacked (developer mode): " + Object.keys(kept).length + " file" + (Object.keys(kept).length === 1 ? "" : "s") + ", " + e.hash + ".");
    touch(e);
    return e;
  }
  async function unloadDev(id) {
    const e = exts.get(id);
    if (!e || e.origin !== "dev") throw Error("Only extensions loaded unpacked can be unloaded.");
    await deactivate(id); removeContributions(e);
    exts.delete(id); devCode.delete(id); saveGrant(e, null); pools.delete("ext:" + id);
    e.storage = null; ls.del(STORE + dataKey(e)); ls.del(SETTINGS + dataKey(e));
    touch(e);
  }

  // Project-bundled extensions: project.extensions = [{manifest, files}] (opt-in trust).
  function projectPackages() {
    const out = new Map();
    for (const b of host?.project().extensions || []) {
      try {
        const files = {...(b.files || {}), "waffle-extension.json": JSON.stringify(b.manifest)};
        validateManifest(b.manifest,files,{parked:true});
        out.set(b.manifest.id, {manifest: b.manifest, files, hash: bundleDigest(b.manifest, b.files)});
      } catch {}
    }
    return out;
  }
  const trustSet = () => new Set(ls.get(TRUST, []));
  const trusted = e => trustSet().has(e.id + "@" + e.hash);
  function syncProject() {
    if (!host) return;
    const p = host.project();
    if (p === lastProject && p.extensions === lastBundles && (p.extensions?.length ?? 0) === lastBundleCount) return;
    lastProject = p; lastBundles = p.extensions; lastBundleCount = p.extensions?.length ?? 0;
    const packages = projectPackages();
    for (const e of [...exts.values()]) if (e.origin === "project" && (!packages.has(e.id) || packages.get(e.id).hash !== e.hash)) { deactivate(e.id); removeContributions(e); exts.delete(e.id); touch(e); }
    let blocked = 0;
    for (const [id, pkg] of packages) {
      if (exts.has(id)) continue;
      // The grant key is id@sha256: set the digest before reading the grant.
      const e = record(pkg.manifest, "project", true);
      e.hash = pkg.hash; syncPerms(e);
      exts.set(id, e);
      if (trusted(e)) { registerContributions(e); startupCheck(e); } else { e.status = "blocked"; blocked++; }
      touch(e);
    }
    if (blocked) ui.status(scriptRecord("waffle.project-trust"), "trust", {text: blocked + " project extension" + (blocked === 1 ? "" : "s") + " blocked", tooltip: "This project includes extensions. Review them before they run.", _action: openManager});
  }
  async function trust(id) {
    const e = exts.get(id);
    if (!e || e.origin !== "project") return;
    // Always show the permissions: the grant belongs to this exact bundle (id@sha256).
    if (!await acknowledge(e, "install", true)) return;
    if (e.manifest.contributes?.mathFunctions?.length) await checkNotebook(e.manifest,null,e);
    if (exts.get(id) !== e) return;
    const set = trustSet(); set.add(e.id + "@" + e.hash); ls.set(TRUST, [...set]);
    e.status = "inactive"; registerContributions(e); await admitNotebook(e); startupCheck(e); touch(e);
    if (![...exts.values()].some(x => x.status === "blocked")) ui.status(scriptRecord("waffle.project-trust"), "trust", null);
  }
  async function addToProject(id) {
    const e = exts.get(id), files = e && await code.get(id);
    if (!files) throw Error("Install the extension first.");
    const bundle = {manifest: e.manifest, files: Object.fromEntries(Object.entries(files).filter(([k]) => k !== "waffle-extension.json"))};
    host.edit(() => { const p = host.project(); p.extensions = (p.extensions || []).filter(x => x?.manifest?.id !== id).concat([bundle]); });
    const set = trustSet(); set.add(id + "@" + bundleDigest(bundle.manifest, bundle.files)); ls.set(TRUST, [...set]);
    host.info?.(e.manifest.name + " is now saved with the project.");
  }

  // ---------------------------------------------------------------- events
  function startupCheck(e) {
    if (!e.enabled || e.status === "blocked" || !host || !notebookEnabled() && notebookOnly(e.manifest)) return;
    const events = e.manifest.activationEvents || [];
    if (events.includes("*") || events.includes("onStartup")) later(() => activate(e.id, "onStartup").catch(() => {}));
    const kind = host.project().documents.find(d => d.id === host.documentId())?.kind;
    if (kind && events.includes("onDocumentKind:" + kind)) later(() => activate(e.id, "onDocumentKind:" + kind).catch(() => {}));
  }
  const queued = new Map();
  function notify(name, payload) {
    if (!registry) return;
    if (name === "documentChanged") syncProject();
    if (name === "activeDocumentChanged" && kindWatchers.size) {
      const kind = host.project().documents.find(d => d.id === host.documentId())?.kind;
      if (kind !== lastKind) { lastKind = kind; for (const id of kindWatchers) { const e = exts.get(id); if (e?.enabled && e.status === "inactive" && (e.manifest.activationEvents || []).includes("onDocumentKind:" + kind)) activate(id, "onDocumentKind:" + kind).catch(() => {}); } }
    }
    if (whenNodes && doc && (name === "activeDocumentChanged" || name === "selectionChanged" || name === "documentChanged")) syncWhen();
    if (!registry.has(name)) return;
    // Coalesce bursts (a drag can change selection many times in one task).
    if (queued.has(name)) { queued.set(name, payload); return; }
    queued.set(name, payload);
    Promise.resolve().then(() => {
      let p = queued.get(name); queued.delete(name);
      if (p === undefined) p = defaultPayload(name);
      registry.emit(name, p);
    });
  }
  // Menu entries with a `when` clause are disabled, Active Bar buttons hidden, when it is false.
  function syncWhen(scope = doc) {
    const ctx = whenContext();
    for (const n of scope.querySelectorAll("[data-extension][data-when]")) { const ok = when(n.dataset.when, ctx); if (n.classList.contains("ext-tool")) n.hidden = !ok; else n.disabled = !ok; }
  }
  function defaultPayload(name) {
    if (!host) return {};
    if (name === "selectionChanged") { const ids = [...(host.selection?.() || [])]; return {count: ids.length, ids: ids.slice(0, 1000)}; }
    if (name === "documentChanged" || name === "activeDocumentChanged") { const d = host.project().documents.find(x => x.id === host.documentId()); return {revision: host.revision?.() ?? 0, document: d?.id, kind: d?.kind}; }
    return {};
  }

  // ----------------------------------------------------------------- attach
  function attach(h, opts = {}) {
    host = h; options = opts || {};
    registry = AtriumAPI.createRegistry();
    if (notebookEnabled() && globalThis.AtriumExtensionPalette) notebookHost().then(h=>h.connect());
    loadBuiltins();
    loadIndex();
    reportSkipped();
    purgeDevData();
    lastProject = null; syncProject();
    lastKind = host.project().documents.find(d => d.id === host.documentId())?.kind;
    for (const e of exts.values()) if (e.enabled && e.status !== "blocked") { registerContributions(e); startupCheck(e); }
    globalThis.AtriumScripting?.bind?.({project: () => host.project(), edit: fn => host.edit(() => fn(host.project()), undefined, [])});
    doc?.addEventListener("toggle", ev => { if (whenNodes && ev.target?.open && ev.target.matches?.("details.work-menu")) syncWhen(ev.target); }, true);
    globalThis.AtriumWorkbench?.onOpen?.(tidyExtGroup); // menu-groups: extension group last, before the menu is fitted
    // Kill switch, registered on the window in the capture phase so it works while any
    // dialog is open and before page handlers:
    //  - Ctrl/⌘+Shift+Esc always pauses every extension (same as the native menu item);
    //  - Esc three times within 1.5 s does so only while extension work is running or an
    //    extension dialog is open, so Altium-style repeated Esc to end a tool is harmless.
    if (doc && !escapeHatch) {
      let presses = [];
      const busy = () => [...pools.values()].some(p => p.worker && p.requests?.size) || !!doc.querySelector?.("dialog.ext-prompt[open]");
      escapeHatch = ev => {
        if (ev.key !== "Escape" || ev.repeat) return;
        if (ev.shiftKey && (ev.ctrlKey || ev.metaKey)) { presses = []; ev.preventDefault?.(); pauseAll(); return; }
        const t = Date.now();
        presses = presses.filter(x => t - x < 1500).concat(t);
        if (presses.length >= 3) { presses = []; if (busy()) pauseAll(); }
      };
      (doc.defaultView || globalThis).addEventListener?.("keydown", escapeHatch, true);
    }
    return api;
  }
  let escapeHatch = null;

  // ---------------------------------------------------------------- scripts
  // Console scripts: one-shot contexts in the "script" pool. Edits made by one run
  // share a single undo step when the host offers amend().
  let scriptEpoch = 0;
  async function runScript(source, o = {}) {
    hostAdapter();
    const epoch = scriptEpoch;
    const id = "script:" + (++scriptCount), p = pool(id, {network: []}, id);
    const group = {steps: 0, transactions: 0}, logs = [];
    const timeoutMs = Math.min(MAX_TIMEOUT * 5, Math.max(100, o.timeoutMs || 5000));
    const perms = {...AtriumAPI.SCRIPT_PERMISSIONS};
    if (o.write === false) delete perms["write:edits"];
    const core = makeCore(id, perms, {group, storage: o.storage || new Map()});
    const started = Date.now();
    try {
      await start(p);
      if (epoch !== scriptEpoch || safeMode()) throw Error("Stopped by the user.");
      contexts.set(id, {core, pool: p, rate: {at: 0, calls: 0, logs: 0}, perms, onLog: (level, text) => { logs.push({level, text}); o.onLog?.(level, text); }});
      const value = await request(p, {t: "script", ext: {id}, code: String(source), args: o.args ?? null}, timeoutMs, null);
      return {ok: true, value, logs, transactions: group.transactions, undoSteps: group.steps, ms: Date.now() - started, isolated: true};
    } catch (e) {
      return {ok: false, error: {message: e.message, stack: e.stackText}, logs, transactions: group.transactions, undoSteps: group.steps, ms: Date.now() - started, isolated: true};
    } finally {
      contexts.delete(id); scriptRecords.delete(id);
      stop(p, "The script finished."); pools.delete(id);
    }
  }
  // Kill switch: stop every extension and script now. Safe mode keeps them stopped.
  function stopAll(reason = "Stopped by the user.") { activationEpoch++; scriptEpoch++; for (const p of [...pools.values()]) { p.search?.cancel(); stop(p, reason, "cancelled"); } }
  function setSafeMode(on) { ls.set(SAFE_MODE, !!on); globalThis.AtriumExtensionPalette?.invalidate(); if (on) stopAll("Extensions paused."); for (const e of exts.values()) touch(e); }
  // Stop every worker and timer (page unload, tests).
  function shutdown() { for (const p of [...pools.values()]) clearTimeout(p.idle); stopAll("The extension host shut down."); clearTimeout(sweepTimer); }
  function stopScripts() { scriptEpoch++; for (const p of [...pools.values()]) if (p.key.startsWith("script:") && p.worker) stop(p, "Stopped by the user.", "cancelled"); }
  // The escape hatch: pause every extension, stop every script and close every
  // extension dialog. Bound to Esc pressed three times quickly (works while a modal is
  // open) and meant for a native "Pause Extensions" menu item.
  function pauseAll() {
    setSafeMode(true);
    for (const d of doc ? [...doc.querySelectorAll("dialog.ext-prompt")] : []) { try { d.close(); } catch {} }
    host?.info?.("Extensions paused. Resume them in Tools › Extensions.");
    for (const e of exts.values()) touch(e);
  }

  // ---------------------------------------------------------------- manager
  function scheduleManager() { if (!managerTimer) managerTimer = setTimeout(() => { managerTimer = 0; managerView?.render(); }, 30); }
  const STATUS = {active: "Active", activating: "Starting", inactive: "Installed", disabled: "Disabled", error: "Error", blocked: "Blocked"};
  // The status badge's tone; Installed and Disabled stay neutral.
  const PILL_TONES = {active: "success", activating: "accent", error: "danger", blocked: "danger"};
  function hostSummary() {
    const live = [...pools.values()].filter(p => p.worker);
    if (!live.length) return "Extension host idle · no worker running";
    const active = [...exts.values()].filter(e => e.status === "active").length;
    return "Extension host · " + live.length + " sandboxed worker" + (live.length === 1 ? "" : "s") + " · " + active + " active";
  }
  function openManager() {
    if (!doc) return;
    if (managerView) { if (!managerView.dialog.open) managerView.dialog.showModal(); managerView.render(); return; }
    const d = el("dialog", null, "work-dialog ext-manager");
    d.setAttribute("aria-label", "Extensions");
    const head = el("header", null, "ext-manager-head"), tabs = el("div", null, "ext-tabs ui-tabs"), body = el("div", null, "ext-manager-body");
    const title = el("h2", "Extensions");
    const list = el("div", null, "ext-cards"), detail = el("div", null, "ext-detail"), foot = el("footer", null, "work-actions ext-manager-foot");
    const note = el("span", null, "ext-host-note"), status = el("p", null, "ext-manager-message");
    status.setAttribute("role", "status");
    let tab = "installed", selected = null;
    const fileInput = el("input"), folderInput = el("input");
    fileInput.type = folderInput.type = "file"; fileInput.multiple = folderInput.multiple = true; fileInput.hidden = folderInput.hidden = true;
    fileInput.accept = ".zip,.waffle-extension,.json,.js"; folderInput.setAttribute("webkitdirectory", "");
    const onPick = async ev => {
      try { const e = await install(await packageFromFiles(ev.target.files)); selected = e.id; status.textContent = e.manifest.name + " " + e.manifest.version + " installed."; }
      catch (err) { status.textContent = err.message; }
      ev.target.value = ""; render();
    };
    fileInput.onchange = folderInput.onchange = onPick;
    // Browse Extensions (extension-registry.js, lazy). It contacts nothing until the user sets a registry,
    // verifies each package's SHA-256 against the index and installs through install() (same prompt).
    const openRegistry = () => (globalThis.AtriumLazy ? AtriumLazy.need("AtriumExtensionRegistry") : Promise.resolve(globalThis.AtriumExtensionRegistry))
      .then(R => { if (!R) throw Error("Browse Extensions is not available in this build."); R.open({onInstalled: id => { selected = id; tab = "installed"; render(); }}); })
      .catch(err => { status.textContent = err.message; });
    // Developer tools (extension-dev.js, lazy): New Extension… downloads a scaffold zip; Load unpacked…
    // (developer mode only) installs a folder through installDev(), sandboxed and pinned like any other.
    const devUI = (what, id, callbacks) => (globalThis.AtriumLazy ? AtriumLazy.need("AtriumExtensionDev") : Promise.resolve(globalThis.AtriumExtensionDev))
      .then(D => { if (!D) throw Error("Developer tools are not available in this build."); return D[what](id, {...callbacks, onLoaded: x => { selected = x; tab = "installed"; render(); }}); })
      .catch(err => { status.textContent = err.message; render(); });
    const tabButton = (key, label) => { const b = button(label, () => { tab = key; render(); }, "ext-tab ui-tab"); b.dataset.tab = key; return b; };
    tabs.append(tabButton("installed", "Installed"), tabButton("project", "Project"), tabButton("output", "Output"));
    const pause = el("label", null, "ext-pause"), pauseBox = el("input", null, "ui-checkbox");
    pauseBox.type = "checkbox"; pauseBox.checked = safeMode(); pause.append(pauseBox, el("span", "Pause all"));
    pause.title = "Safe mode: stop every extension and keep them from starting";
    pauseBox.onchange = () => { setSafeMode(pauseBox.checked); render(); };
    head.append(title, tabs, pause, button("Stop all", () => { stopAll(); status.textContent = "All extensions and scripts were stopped."; render(); }, "ext-install"),
      button("Browse…", openRegistry, "ext-install"), button("New Extension…", () => devUI("scaffold"), "ext-install"),
      ...(developerMode() ? [button("Load unpacked…", () => devUI("load"), "ext-install ext-dev-load")] : []),
      button("Install from package…", () => fileInput.click(), "ext-install"), button("Install folder…", () => folderInput.click(), "ext-install"));
    body.append(list, detail);
    const close = button("Close", () => d.close()); close.dataset.variant = "primary"; close.dataset.uiDefault = "false";
    foot.append(note, close);
    for (const b of head.querySelectorAll(".ext-install")) b.classList.add("ui-button");
    d.append(head, status, body, foot, fileInput, folderInput);
    globalThis.AtriumShell?.adoptDialog(d, {title, body:[status, body], actions:foot});
    doc.body.append(d);
    d.addEventListener("close", () => { managerView = null; d.remove(); });
    function card(e) {
      const b = button(null, () => { selected = e.id; render(); }, "ext-card");
      b.setAttribute("aria-pressed", String(selected === e.id));
      // The extension's monogram: a library avatar (32 px, square, the accent hue).
      const badge = el("span", (e.manifest.name.match(/\b\w/g) || ["?"]).slice(0, 2).join("").toUpperCase(), "ui-avatar ext-badge");
      Object.assign(badge.dataset, {size: "lg", shape: "square", hue: "0"});
      const text = el("span", null, "ext-card-text");
      text.append(el("strong", e.manifest.name), el("small", (e.manifest.publisher || e.id.split(".")[0]) + " · " + e.manifest.version));
      if (e.origin === "builtin") text.lastChild.textContent += " · Built-in";
      if (e.origin === "dev") { const dev = el("span", "Developer", "ui-badge ext-dev-badge"); dev.dataset.tone = "warning"; text.append(dev); b.title = "Loaded unpacked in developer mode · " + e.hash; }
      const pill = el("span", STATUS[e.status] || e.status, "ui-badge ext-pill");
      const tone = PILL_TONES[e.status];
      if (tone) pill.dataset.tone = tone;
      b.append(badge, text, pill);
      return b;
    }
    function section(parent, title) { const s = el("section", null, "ext-section"); s.append(el("h3", title)); parent.append(s); return s; }
    function act(label, fn, primary) {
      const b = button(label, async () => { try { status.textContent = ""; await fn(); } catch (err) { status.textContent = err.message; } render(); }, "ui-button");
      b.dataset.variant = primary ? "primary" : "secondary";
      return b;
    }
    function showDetail(e) {
      detail.replaceChildren();
      if (!e) { detail.append(el("p", tab === "project" ? "Extensions saved in this project appear here. They run only after you trust them." : "Install an extension from a .zip, a .waffle-extension bundle, or a folder containing waffle-extension.json.", "ext-text is-muted")); return; }
      if (e.writeTarget !== writeTarget()) syncPerms(e);
      const m = e.manifest, c = m.contributes || {};
      const top = el("div", null, "ext-detail-head");
      top.append(el("h3", m.name), el("small", m.id + " · " + m.version + (m.publisher ? " · " + m.publisher : "") + " · API " + m.apiVersion));
      detail.append(top);
      if (m.description) detail.append(el("p", m.description, "ext-text"));
      const actions = el("div", null, "ext-actions");
      if (e.status === "blocked") actions.append(act("Trust and enable", () => trust(e.id), true));
      else actions.append(act(e.enabled ? "Disable" : "Enable", () => setEnabled(e.id, !e.enabled), !e.enabled));
      if (e.enabled && e.status !== "blocked") actions.append(act(e.status === "active" ? "Reload" : "Activate", () => (e.status === "active" ? reload(e.id) : activate(e.id, "manager"))));
      if (e.origin === "user") { actions.append(act("Add to project", () => addToProject(e.id))); actions.append(act("Uninstall", async () => { if (await dialogConfirm("Uninstall " + m.name, "Remove this extension and its stored data?", "Uninstall")) { await uninstall(e.id); selected = null; } })); }
      if (e.origin === "dev") actions.append(act("Reload from folder", () => devUI("reload", e.id), true),
        act("Console", () => devUI("console", e.id, {onOpen:() => d.close()})),
        act("Unload", async () => { await unloadDev(e.id); selected = null; }));
      detail.append(actions);
      const st = section(detail, "Status");
      st.append(el("p", (STATUS[e.status] || e.status) + (e.activatedBy && e.status === "active" ? " · activated by " + e.activatedBy : "") + (e.origin === "project" ? " · saved in this project" : e.origin === "builtin" ? " · Built-in: bundled with Waffle, sandboxed like any extension" : e.origin === "dev" ? " · Developer: loaded unpacked, held in memory only, pinned to " + e.hash : ""), "ext-text"));
      for (const err of e.errors.slice(-5)) st.append(el("p", err, "ext-text is-error"));
      const perms = section(detail, "Permissions"), pl = el("ul", null, "ext-perms");
      const declared = m.permissions || [], g = grantOf(e);
      if (!declared.length) pl.append(el("li", "None. This extension cannot read or change the design."));
      for (const perm of declared) {
        const li = el("li"), v = g?.perms?.[perm], live = AtriumAPI.isNetworkPermission(perm) ? v === true : e.perms[perm];
        let control;
        if (perm === "write:edits") {
          control = el("select", null, "ui-field"); control.setAttribute("aria-label", perm);
          for (const [value, text] of [["ask", "Ask each time"], ["allow", "Allow for this project"], ["deny", "Deny"]]) control.add(new Option(text, value));
          control.value = live === true ? "allow" : live === false ? "deny" : "ask";
          control.onchange = () => setGrant(e, perm, control.value === "ask" ? null : control.value === "allow");
        } else {
          control = el("input"); control.type = "checkbox"; control.checked = live === true; control.setAttribute("aria-label", perm);
          control.disabled = !g?.acknowledged && !AtriumAPI.isNetworkPermission(perm);
          control.onchange = () => setGrant(e, perm, control.checked);
        }
        li.classList.toggle("is-granted", live === true || live === "ask");
        li.append(el("strong", perm), el("span", describePermission(perm)), control); pl.append(li);
      }
      perms.append(pl);
      if (g) perms.append(act("Reset permissions", async () => { e.editEpoch = (e.editEpoch || 0) + 1; saveGrant(e, null); syncPerms(e); await deactivate(e.id); }));
      else if (declared.length) perms.append(el("p", "You will be asked to allow these the first time it runs.", "ext-text is-muted"));
      const ac = section(detail, "Activation");
      ac.append(el("p", (m.activationEvents || []).join(", ") || "Only when another extension or script calls it.", "ext-text ext-mono"));
      const rows = [
        ...(c.commands || []).map(x => ["Command", x.title + "  (" + x.command + (x.when ? ", when " + x.when : "") + ")"]),
        ...Object.entries(c.menus || {}).flatMap(([menu, items]) => items.map(x => ["Menu · " + menu, x.title || registry?.commands.get(x.command)?.title || x.command])),
        ...(c.keybindings || []).map(x => ["Key", [AtriumShortcut.render(x.key, {variant:"inline"}), " → ", x.command]]),
        ...(c.panels || []).map(x => ["Panel", x.title + (x.location === "dialog" ? " (floating)" : " (right dock)")])
      ];
      if (rows.length) {
        const s = section(detail, "Contributions"), dl = el("dl", null, "ext-kv");
        for (const [key, value] of rows) {
          const dd = el("dd");
          dd.append(...[].concat(value));
          dl.append(el("dt", key), dd);
        }
        s.append(dl);
      }
      if ((c.settings || []).length) {
        const s = section(detail, "Settings"), values = settingsOf(e);
        for (const def of c.settings) {
          const l = el("label", null, "ext-field");
          let input;
          if (def.type === "enum") { input = el("select"); for (const o of def.options || []) input.add(new Option(String(o), String(o))); }
          else { input = el("input"); input.type = def.type === "boolean" ? "checkbox" : def.type === "number" ? "number" : "text"; }
          input.classList.add(def.type === "boolean" ? "ui-checkbox" : "ui-field");
          if (def.type === "boolean") input.checked = !!values[def.key]; else input.value = values[def.key] ?? "";
          input.onchange = () => { const all = ls.get(SETTINGS + dataKey(e), {}); all[def.key] = def.type === "boolean" ? input.checked : def.type === "number" ? Number(input.value) : input.value; ls.set(SETTINGS + dataKey(e), all); registry.emit("settingsChanged", {extension: e.id, key: def.key}); };
          l.append(el("span", def.title || def.key), input);
          if (def.description) l.append(el("small", def.description));
          s.append(l);
        }
      }
      if (e.logs.length) { const s = section(detail, "Recent output"); s.append(el("pre", e.logs.slice(-30).map(x => x.level.toUpperCase().padEnd(5) + " " + x.text).join("\n"), "ext-code")); }
    }
    function render() {
      for (const b of tabs.children) b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
      note.textContent = hostSummary();
      list.replaceChildren();
      if (tab === "output") {
        body.classList.add("is-output");
        const all = [...exts.values()].flatMap(e => e.logs.map(l => ({...l, name: e.manifest.name}))).sort((a, b) => a.time - b.time).slice(-300);
        detail.replaceChildren(el("pre", all.map(l => new Date(l.time).toLocaleTimeString() + "  " + l.name + "  " + l.level.toUpperCase() + "  " + l.text).join("\n") || "No output yet.", "ext-code ext-output"));
        return;
      }
      body.classList.remove("is-output");
      const shown = [...exts.values()].filter(e => (tab === "project") === (e.origin === "project")).sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
      if (!shown.length) list.append(el("p", tab === "project" ? "This project has no bundled extensions." : "No extensions installed.", "ext-text is-muted"));
      for (const e of shown) list.append(card(e));
      showDetail(shown.find(e => e.id === selected) || (selected = shown[0]?.id, shown[0]));
    }
    managerView = {dialog: d, render};
    render(); d.showModal();
  }

  const api = Object.freeze({
    attach, notify, execute, activate, deactivate, install, uninstall, setEnabled, reload, trust, addToProject, readyNotebook,
    openManager, runScript, stopScripts, shutdown, stats, stopAll, setSafeMode, pauseAll, get safeMode() { return safeMode(); },
    installDev, unloadDev, get developerMode() { return developerMode(); },
    grant: (id, perm, value) => { const e = exts.get(id); if (!e) throw Error("Unknown extension " + id + "."); return setGrant(e, perm, value); },
    permissions: id => { const e = exts.get(id); return e ? {declared: [...(e.manifest.permissions || [])], live: {...e.perms}, network: hostsOf(e)} : null; }, validateManifest, packageFromFiles, readZip, parseKey,
    describePermission, providersAI, askAI, credentialAI, rememberCredentialAI,
    permissionAI:id => {
      const permission = permissionAI(id);
      if (!permission) return null;
      return {current:permission.current, proposals:permission.e.perms["propose:edits"] === true, onChange(listener) {
        const listeners = permission.e.aiListeners ??= new Set();
        listeners.add(listener);
        return () => listeners.delete(listener);
      }};
    },
    list: () => [...exts.values()].map(e => ({id: e.id, name: e.manifest.name, version: e.manifest.version, origin: e.origin, enabled: e.enabled, status: e.status, errors: [...e.errors], ...(e.manifest.contributes?.externalTools ? {externalTools: clone(e.manifest.contributes.externalTools)} : {}), ...(e.origin === "dev" ? {developer: true, hash: e.hash} : {})})),
    logs: id => [...(exts.get(id)?.logs || [])],
    commands: () => registry ? [...registry.commands.values()].map(c => ({id: c.id, title: c.title, owner: c.owner, when: c.when})) : [],
    get attached() { return !!host; },
    get workers() { return [...pools.values()].filter(p => p.worker).map(p => ({pool: p.key, inline: p.inline, members: [...p.members]})); },
    _when: when, _sha256: sha256, _digest: bundleDigest,
    _panel: (id, panel) => exts.get(id)?.panels.get(panel)?.view ?? null
  });
  return api;
})();
