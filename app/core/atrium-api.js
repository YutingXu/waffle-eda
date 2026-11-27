"use strict";
// AtriumAPI v1: the single stable facade that scripts, extensions and the MCP
// headless runner program against. The same object shape is built in three places:
//
//   in the editor (main thread)   AtriumAPI.create(host).api      direct calls, values cloned
//   in the extension host worker  facade(rpc, env)                every read is a message
//   headless (JSC / Node)         AtriumAPI.headless(project).api same as the editor, no DOM
//
// `facade` is self-contained so extensions.js can stringify it into the worker
// source. It must not reference anything outside its own body.
//
// Every read returns a copy. Writes are collected as transaction operations and
// applied in one ctx.edit (one undo step), then checked with Atrium.validate.
globalThis.AtriumAPI = (() => {
  const VERSION = 1;

  // ------------------------------------------------------------------ facade
  // invoke(method, args) returns a value (editor, headless) or a Promise (worker).
  // env: {newId(), commands:Map, listeners:Map, log(level,args), subscribe(name)}
  function facade(invoke, env) {
    const then = (v, f) => v && typeof v.then === "function" ? v.then(f) : f(v);
    const m = name => (...args) => invoke(name, args);
    const MIL = 0.0254;
    const alias = {mm:"mm", mil:"mil", mils:"mil", th:"mil", thou:"mil", in:"in", inch:"in", inches:"in", '"':"in", um:"um", "µm":"um", "μm":"um", cm:"cm"};
    const perMm = {mm:1, mil:1/MIL, in:1/25.4, um:1000, cm:.1};
    const toMm = (v, u = "mm") => Math.round(v / perMm[alias[u] || "mm"] * 1e6) / 1e6 + 0;
    const fromMm = (mm, u = "mm") => mm * perMm[alias[u] || "mm"];
    const units = {
      get: m("units.get"),
      toMm, fromMm,
      format: (mm, u = "mm", digits) => Number(fromMm(mm, u).toFixed(digits ?? (alias[u] === "mil" ? 3 : 4))) + " " + (alias[u] || "mm"),
      parse(text, u = "mm") {
        const r = String(text ?? "").trim().toLowerCase().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(mm|mils?|thou|th|inch(?:es)?|in|"|µm|μm|um|cm)?$/);
        return r ? toMm(Number(r[1]), r[2] || u) : NaN;
      }
    };
    const geometry = {
      distance: (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]),
      rotate(p, deg) { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; },
      segmentDistance(p, a, b) {
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
        return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
      },
      pointInPolygon(p, poly) {
        let inside = false;
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
          const a = poly[i], b = poly[j];
          if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
        }
        return inside;
      },
      bounds(points) {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const [x, y] of points) { if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y; }
        return x0 === Infinity ? null : [x0, y0, x1, y1];
      },
      length(points) { let n = 0; for (let i = 1; i < points.length; i++) n += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]); return n; }
    };
    function transaction(label, fn) {
      if (typeof label === "function") { fn = label; label = "Script edit"; }
      const ops = [], select = {ids: null};
      const one = id => { if (typeof id !== "string" || !id) throw Error("Expected an object id."); return id; };
      const tx = Object.freeze({
        add(item, options = {}) {
          if (!item || typeof item !== "object") throw Error("tx.add expects an object.");
          const id = typeof item.id === "string" && item.id ? item.id : env.newId();
          ops.push({op: "add", doc: options.doc || null, item: {...item, id}});
          return id;
        },
        remove(ids) { for (const id of [].concat(ids)) ops.push({op: "remove", id: one(id)}); },
        update(id, patch) { ops.push({op: "update", id: one(id), set: patch}); },
        move(id, dx, dy) { ops.push({op: "move", id: one(id), dx, dy}); },
        transform(id, change) { ops.push({op: "transform", id: one(id), set: change}); },
        setDocument(doc, patch) { ops.push({op: "document", doc, set: patch}); },
        addDefinition(def) { const id = def?.id || env.newId(); ops.push({op: "definition", def: {...def, id}}); return id; },
        select(ids) { select.ids = [].concat(ids); },
        get size() { return ops.length; }
      });
      const commit = result => {
        if (!ops.length && !select.ids) return {applied: 0, result};
        return then(invoke("transaction.commit", [String(label || "Edit"), ops, select.ids]), r => ({...r, result}));
      };
      return then(fn(tx), commit);
    }
    const commands = {
      register(id, fn, meta = {}) {
        if (typeof id !== "string" || !/^[\w.-]+$/.test(id)) throw Error("Command ids use letters, digits, dots, dashes and underscores.");
        if (typeof fn !== "function") throw Error("A command needs a handler function.");
        env.commands.set(id, fn);
        const done = invoke("commands.register", [id, meta]);
        // A refused registration (for example, no ui:command) removes the local handler.
        if (done && typeof done.then === "function") done.then(null, e => { env.commands.delete(id); env.log("error", ["commands.register " + id + ": " + e.message]); });
        return {dispose() { env.commands.delete(id); invoke("commands.unregister", [id]); }, ready: done};
      },
      execute(id, ...args) { return env.commands.has(id) ? env.commands.get(id)(...args) : invoke("commands.execute", [id, args]); },
      list: m("commands.list")
    };
    const events = {
      on(name, fn) {
        if (typeof fn !== "function") throw Error("events.on expects a listener.");
        let set = env.listeners.get(name);
        if (!set) { const r = env.subscribe(name); env.listeners.set(name, set = new Set()); if (r && typeof r.catch === "function") r.catch(() => env.listeners.delete(name)); }
        set.add(fn);
        return {dispose() { set.delete(fn); }};
      }
    };
    const annotate = m("annotate.plan");
    annotate.apply = m("annotate.apply");
    const api = {
      version: 1,
      motion: {inspect: m("motion.inspect")},
      project: {info: m("project.info"), netlist: m("netlist")},
      documents: {list: m("documents.list"), active: m("documents.active"), get: m("documents.get"), activate: m("documents.activate")},
      items: {page: m("items.page"), list: m("items.list"), get: m("items.get"), count: m("items.count")},
      defs: {list: m("defs.list"), get: m("defs.get")},
      parts: {pins: m("parts.pins")},
      nets: {list: m("nets.list"), items: m("nets.items")},
      selection: {get: m("selection.get"), set: m("selection.set"), items: m("selection.items")},
      layers: {list: m("layers.list")},
      units, geometry,
      query: {spatial: m("query.spatial"), connectivity: m("query.connectivity")},
      rules: {query: m("rules.query"), get: m("rules.get")},
      transaction, commands, events,
      ui: {
        showMessage: m("ui.showMessage"), setStatus: m("ui.setStatus"), clearStatus: m("ui.clearStatus"),
        registerPanel: m("ui.registerPanel"), setPanel: m("ui.setPanel"), showPanel: m("ui.showPanel"), closePanel: m("ui.closePanel"),
        addMenuItem: m("ui.addMenuItem"), addActiveBarButton: m("ui.addActiveBarButton"),
        showInputBox: m("ui.showInputBox"), showQuickPick: m("ui.showQuickPick"), confirm: m("ui.confirm"),
        locate: m("ui.locate"),
        // Read-only canvas labels, probes and markers (ui:decorations). Cleared when the extension stops.
        decorations: {set: m("ui.decorations.set"), clear: m("ui.decorations.clear")}
      },
      storage: {get: m("storage.get"), set: m("storage.set"), delete: m("storage.delete"), keys: m("storage.keys")},
      settings: {get: m("settings.get")},
      files: {export: m("files.export"), pickText: m("files.pickText")},
      // Signal integrity (si-sim): routed copper per net, the field solver, stored IBIS models. Read-only.
      simulation: {get: m("simulation.get"), model: m("simulation.model"), channel: m("simulation.channel"), fieldSolve: m("simulation.fieldSolve")},
      // Bytes bundled in the extension's own package (for example a .wasm module), as an ArrayBuffer.
      assets: {read: m("assets.read")},
      // run:external: tools the user installed and chose in Preferences › External Tools (desktop app only).
      external: {tools: m("external.tools"), run: m("external.run"), cancel: m("external.cancel"), configure: m("external.configure")},
      // Mark an ArrayBuffer or typed array to be moved, not copied, in the next message.
      transfer: v => (env.transfer ? env.transfer(v) : v),
      // propose: whitelisted field edits the user reviews (propose:edits); submit: a whole version 2 proposal.
      proposals: {draft: m("proposals.draft"), review: m("proposals.review"), discard: m("proposals.discard"), submit: m("proposals.submit"), propose: m("proposals.propose"), fields: m("proposals.fields")},
      features: m("features.list"),
      bom: m("bom"), drc: m("drc"), erc: m("erc"), annotate, pour: m("pour"), route: m("route"),
      length: m("length"), fanout: m("fanout"), stackup: m("stackup"), autoplace: m("autoplace"), routePlan: m("routePlan"), planes: m("planes"),
      outputs: {gerber: m("outputs.gerber"), drill: m("outputs.drill"), build: m("outputs.build")},
      log: (...a) => env.log("info", a)
    };
    Object.freeze(api.ui.decorations);
    for (const k of Object.keys(api)) if (api[k] && typeof api[k] === "object") Object.freeze(api[k]);
    return Object.freeze(api);
  }

  const then = (v, f) => (v && typeof v.then === "function" ? v.then(f) : f(v));

  // ------------------------------------------------------------- registries
  // Shared by every API instance of one editor (or one headless run).
  function createRegistry() {
    const commands = new Map(), listeners = new Map();
    return {
      commands,
      on(name, fn) { let s = listeners.get(name); if (!s) listeners.set(name, s = new Set()); s.add(fn); return () => s.delete(fn); },
      has: name => !!listeners.get(name)?.size,
      emit(name, payload) { for (const fn of [...(listeners.get(name) || [])]) { try { fn(payload); } catch (e) { globalThis.console?.error?.(e); } } }
    };
  }

  // Built-in editor actions, exposed as commands "waffle.<action>".
  const BUILTIN = ["new", "open", "save", "undo", "redo", "copy", "cut", "paste", "duplicate", "select-all", "delete", "rotate",
    "fit", "fit-objects", "fit-document", "zoom-in", "zoom-out", "grid", "toggle-units", "library", "measure", "move-object",
    "select", "pan", "route", "via", "label", "junction", "split-wire", "layer-mode", "unrouted",
    "compare", "connectivity", "export", "symbols", "blocks", "eco", "rules", "mcp", "annotate", "bom", "drc", "erc",
    "fab-outputs", "stackup", "view-config", "add-schematic", "add-pcb", "rename-document",
    "split-right", "split-down", "split-close", "split-toggle", "toggle-left", "toggle-right", "shortcuts",
    "extensions", "scripting-console"];

  // What a user-run script may do: read, edit (one undo step), export, show dialogs.
  const SCRIPT_PERMISSIONS = Object.freeze({"read:project": true, "write:edits": true, "outputs:write": true, "ui:dialog": true});
  // Capability names describe declarations. Each host supplies its own grants.
  const PERMISSION_DESCRIPTIONS = Object.freeze({
    "read:motion": "Read the editor’s animation policy, timings and active track count",
    "read:project": "Read the design: documents, objects, nets, rules and selection",
    "ai:provider": "Respond to AI requests with only the approved project fields",
    "propose:edits": "Propose changes to the design; nothing changes until you review and apply them",
    "write:edits": "Apply approved edits to this project",
    "outputs:write": "Save files through the system save dialog",
    "ui:panel": "Show panels in the right dock or a floating window",
    "ui:widgets": "Render notebook widgets and update their own state on interaction",
    "ui:command": "Add commands, menu items, toolbar buttons, shortcuts and status items",
    "ui:decorations": "Draw read-only labels, probes and markers on the canvas (removed when it stops)",
    "run:external": "Run programs you installed and choose in Preferences › External Tools (you approve each one)"
  });
  const PERMISSIONS = Object.freeze(Object.keys(PERMISSION_DESCRIPTIONS));
  const NETWORK_PERMISSION = /^network:(([a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?|localhost)$/;
  const isNetworkPermission = permission => typeof permission === "string" && NETWORK_PERMISSION.test(permission);
  const isManifestPermission = permission => PERMISSIONS.includes(permission) || isNetworkPermission(permission);
  function describePermission(permission) {
    if (PERMISSIONS.includes(permission)) return PERMISSION_DESCRIPTIONS[permission];
    if (permission === "network:localhost") return "Contact servers on this computer (localhost, any port; off until you allow it)";
    return isNetworkPermission(permission) ? "Contact https://" + permission.slice(8) + " (off until you allow it)" : permission;
  }
  const VIEW_COMMANDS = new Set(["fit", "fit-objects", "fit-document", "zoom-in", "zoom-out", "grid", "toggle-units", "select", "pan", "measure",
    "layer-mode", "unrouted", "split-right", "split-down", "split-close", "split-toggle", "toggle-left", "toggle-right"]);
  // Reads return at most this many objects per call; page with offset/limit beyond it.
  const MAX_ITEMS = 20000;

  // ------------------------------------------------------ proposed field edits
  // proposals.propose(edits, {label}) edits only these fields (the first key of each edit's path).
  // They hold data the editor never runs: simulation models and test benches, values and parameters.
  // Each target's whole object, structure and the project afterwards are checked by Atrium.validate.
  const PROPOSE_FIELDS = Object.freeze({
    item: Object.freeze({part: Object.freeze(["sim", "value", "parameters"])}),
    definition: Object.freeze(["sim", "parameters", "description"]),
    project: Object.freeze(["simulation"])
  });
  const PROPOSE_LIMITS = Object.freeze({edits: 5000, depth: 6, valueChars: 4e6, totalChars: 12e6, label: 120});
  const SAFE_KEY = /^[A-Za-z0-9_][\w.-]{0,79}$/;
  const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

  // ---------------------------------------------------------- external tools
  // external.run(tool, {args, files, outputs, timeoutMs, maxOutputBytes, runId, encoding}): the desktop
  // host runs the executable the USER chose for `tool` (Preferences › External Tools), with these
  // arguments as a list (no shell), in a fresh temporary folder holding `files`, and returns exit
  // status, stdout, stderr and the `outputs` it finds there. The host asks before the first run of each
  // program for each extension version (full command shown) and again for any argument outside the
  // tool's declared template (docs/extensions.md, External programs).
  const EXTERNAL_LIMITS = Object.freeze({args: 256, argChars: 4096, files: 64, fileBytes: 64e6, outputs: 64, timeoutMs: 600000,
    defaultTimeoutMs: 60000, minTimeoutMs: 100, outputBytes: 64e6, defaultOutputBytes: 16e6});
  const EXTERNAL_UNAVAILABLE = "Running external tools needs the Waffle desktop app.";
  const TOOL_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
  const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/, OUTPUT_PATTERN = /^[A-Za-z0-9_*?][A-Za-z0-9_.*?-]{0,127}$/;
  function cleanExternalRun(tool, o) {
    const L = EXTERNAL_LIMITS, fail = m => { throw Error("external.run: " + m); };
    if (typeof tool !== "string" || !TOOL_ID.test(tool)) fail("name a tool the extension declares under contributes.externalTools.");
    if (!plain(o)) fail("options must be an object.");
    for (const k of Object.keys(o)) if (!["args", "files", "outputs", "timeoutMs", "maxOutputBytes", "runId", "encoding"].includes(k)) fail("unknown option " + k + ".");
    const args = o.args ?? [];
    if (!Array.isArray(args) || args.length > L.args || args.some(a => typeof a !== "string" || a.length > L.argChars || a.includes("\0")))
      fail("args must be a list of at most " + L.args + " strings (no NUL characters).");
    const files = {};
    let bytes = 0;
    if (o.files != null) {
      if (!plain(o.files)) fail("files must map file names to text or bytes.");
      const names = Object.keys(o.files);
      if (names.length > L.files) fail("at most " + L.files + " input files.");
      for (const name of names) {
        if (!FILE_NAME.test(name) || name.includes("..")) fail("input file names are plain names such as deck.cir (" + name.slice(0, 40) + ").");
        const v = o.files[name];
        if (typeof v === "string") bytes += v.length * 3;
        else if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) bytes += v.byteLength;
        else fail("file " + name + " must be text or bytes.");
        files[name] = v;
      }
      if (bytes > L.fileBytes) fail("the input files are larger than " + L.fileBytes / 1e6 + " MB.");
    }
    const outputs = o.outputs ?? [];
    if (!Array.isArray(outputs) || outputs.length > L.outputs || outputs.some(p => typeof p !== "string" || !OUTPUT_PATTERN.test(p) || p.includes("..")))
      fail("outputs must list file names or patterns such as *.raw in the working folder.");
    const timeoutMs = o.timeoutMs ?? L.defaultTimeoutMs, maxOutputBytes = o.maxOutputBytes ?? L.defaultOutputBytes;
    if (!(typeof timeoutMs === "number" && timeoutMs >= L.minTimeoutMs && timeoutMs <= L.timeoutMs)) fail("timeoutMs must be between " + L.minTimeoutMs + " and " + L.timeoutMs + ".");
    if (!(typeof maxOutputBytes === "number" && maxOutputBytes >= 1024 && maxOutputBytes <= L.outputBytes)) fail("maxOutputBytes must be between 1024 and " + L.outputBytes + ".");
    if (o.runId != null && (typeof o.runId !== "string" || !/^[\w.-]{1,64}$/.test(o.runId))) fail("runId must be a short name.");
    if (o.encoding != null && o.encoding !== "text" && o.encoding !== "binary") fail("encoding must be text or binary.");
    return {tool, args: [...args], files, outputs: [...outputs], timeoutMs: Math.round(timeoutMs), maxOutputBytes: Math.round(maxOutputBytes),
      runId: o.runId || null, encoding: o.encoding || "text"};
  }

  // ------------------------------------------------------------ decorations
  // ui.decorations.set(doc, items): read-only canvas text and marks, drawn by the host.
  // Only data crosses: no markup, no callbacks, no hover pop-ups. Capped and scrubbed here so
  // the editor, the worker path and headless contexts refuse the same input.
  const DECORATION_LIMITS = Object.freeze({items: 2000, text: 120, docs: 32, callsPerSecond: 20, chars: 524288, coord: 1e5, offset: 50});
  const DECORATION_KINDS = new Set(["label", "probe", "marker"]);
  const DECORATION_TONES = new Set(["info", "success", "warning", "danger", "accent", "muted"]);
  const DECORATION_KEYS = new Set(["id", "kind", "text", "at", "anchor", "offset", "tone", "size"]);
  // Control, bidirectional-override and zero-width characters never reach the canvas.
  const scrubText = t => String(t ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "").trim();
  function cleanDecorations(items) {
    const L = DECORATION_LIMITS, fail = m => { throw Error("ui.decorations.set: " + m); };
    if (!Array.isArray(items)) fail("expects a list of decorations.");
    if (items.length > L.items) fail("at most " + L.items + " decorations per document (" + items.length + " given).");
    if (!jsonSafe(items)) fail("decorations must be plain JSON data.");
    if (JSON.stringify(items).length > L.chars) fail("the decorations are larger than " + L.chars / 1024 + " KB.");
    const point = (v, lim, what, n) => {
      if (!Array.isArray(v) || v.length !== 2 || !v.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= lim)) fail("decoration " + (n + 1) + ": " + what + " must be [x, y] in mm within ±" + lim + ".");
      return [v[0], v[1]];
    };
    return items.map((d, n) => {
      if (!plain(d)) fail("decoration " + (n + 1) + " is not an object.");
      for (const k of Object.keys(d)) if (!DECORATION_KEYS.has(k)) fail("decoration " + (n + 1) + " has the unknown field " + k + ".");
      const kind = d.kind ?? "label";
      if (!DECORATION_KINDS.has(kind)) fail("decoration " + (n + 1) + ": kind must be label, probe or marker.");
      const out = {kind, text: scrubText(d.text).slice(0, L.text)};
      if (kind === "label" && !out.text) fail("decoration " + (n + 1) + ": a label needs text.");
      if (d.id != null) { if (typeof d.id !== "string" || d.id.length > 64) fail("decoration " + (n + 1) + ": id must be a short string."); out.id = d.id; }
      if (d.anchor != null) {
        const a = d.anchor;
        if (!plain(a) || typeof a.id !== "string" || !a.id || a.id.length > 256 || Object.keys(a).some(k => k !== "id" && k !== "pin") ||
            (a.pin != null && !(typeof a.pin === "string" || typeof a.pin === "number") || String(a.pin ?? "").length > 64))
          fail("decoration " + (n + 1) + ": anchor must be {id, pin?}.");
        out.anchor = a.pin == null ? {id: a.id} : {id: a.id, pin: String(a.pin)};
      } else if (d.at != null) out.at = point(d.at, L.coord, "at", n);
      else fail("decoration " + (n + 1) + " needs at [x, y] or anchor {id, pin?}.");
      if (d.offset != null) out.offset = point(d.offset, L.offset, "offset", n);
      if (d.tone != null) { if (!DECORATION_TONES.has(d.tone)) fail("decoration " + (n + 1) + ": tone must be one of " + [...DECORATION_TONES].join(", ") + "."); out.tone = d.tone; }
      if (d.size != null) { if (d.size !== "small" && d.size !== "normal") fail("decoration " + (n + 1) + ": size must be small or normal."); out.size = d.size; }
      return out;
    });
  }

  // ------------------------------------------------------------ operations
  const ITEM_KINDS = new Set(["part", "wire", "track", "graphic", "label", "netlabel", "junction", "via", "pad"]);
  const FROZEN = new Set(["id", "kind"]);
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  function jsonSafe(v, depth = 0) {
    if (depth > 32) throw Error("Values nest too deeply.");
    if (v === null || typeof v === "string" || typeof v === "boolean") return true;
    if (typeof v === "number") return Number.isFinite(v);
    if (Array.isArray(v)) return v.every(x => jsonSafe(x, depth + 1));
    if (plain(v)) return Object.values(v).every(x => x === undefined || jsonSafe(x, depth + 1));
    return false;
  }
  // Apply transaction operations to a project in place. Throws on the first bad
  // operation with a message naming it; the caller rolls the project back.
  function applyOps(project, ops, activeDocId, copyOnWrite = false, moved) {
    const A = globalThis.Atrium;
    if (!Array.isArray(ops)) throw Error("Transaction operations must be a list.");
    if (ops.length > 200000) throw Error("A transaction is limited to 200000 operations.");
    const where = new Map(), docs = new Map(project.documents.map(d => [d.id, d]));
    const needed = ops.some(o => o?.op === "add") ? null : new Set(ops.map(o => o?.id).filter(Boolean));
    for (const d of project.documents) {
      if (needed && !needed.size) break;
      for (const [at, item] of d.items.entries()) if (!needed || needed.delete(item.id)) {
        where.set(item.id, {d, item, at});
        if (needed && !needed.size) break;
      }
    }
    const defs = new Map(project.library.map(d => [d.id, d]));
    const removed = new Map(), added = [];
    const docFor = id => { const d = id ? docs.get(id) : docs.get(activeDocId) || project.documents[0]; if (!d) throw Error("Unknown document " + id + "."); return d; };
    const writable = hit => {
      if (copyOnWrite && !hit.owned) {
        const original = hit.item;
        hit.item = hit.d.items[hit.at] = {...original}; hit.owned = true;
        if (moved) moved.set(original, hit);
      }
      return hit.item;
    };
    const found = (op, n) => {
      const hit = where.get(op.id);
      if (!hit || removed.get(hit.d)?.has(op.id)) throw Error("Operation " + (n + 1) + " (" + op.op + "): object " + op.id + " does not exist.");
      return [hit.d, op.op === "remove" ? hit.item : writable(hit)];
    };
    // Draft on copies of the wires and junctions the shared transform can move.
    const isolated = new Set();
    function transform(d, item, change) {
      if (copyOnWrite && d.kind === "schematic" && !isolated.has(d)) {
        for (const [at, item] of d.items.entries()) if (item.kind === "wire" || item.kind === "junction")
          writable(where.get(item.id) || {d, item, at});
        isolated.add(d);
      }
      const deleted = removed.get(d), contacts = deleted && d.items.filter(i => !deleted.has(i.id));
      A.transformPart(d, item, defs.get(item.def), change, undefined, {defs, query: contacts && (() => contacts)});
    }
    // A one-item project validates a single object with the real rules, cheaply.
    const checkItem = (d, item, n) => {
      const def = item.def != null ? defs.get(item.def) : null;
      try {
        A.validate({format: "atrium", version: 1, name: "check", library: def ? [def] : [],
          documents: [{id: d.id, kind: d.kind, name: "check", grid: d.grid, items: [item], outline: [], notes: []}]});
      } catch {
        throw Error("Operation " + (n + 1) + " (" + ops[n].op + "): " + (item.kind || "object") + " " + item.id + " is not valid on a " + d.kind + " document.");
      }
    };
    ops.forEach((op, n) => {
      if (!plain(op)) throw Error("Operation " + (n + 1) + " is not an object.");
      const label = "Operation " + (n + 1) + " (" + op.op + "): ";
      switch (op.op) {
        case "add": {
          const d = docFor(op.doc), item = op.item;
          if (!plain(item) || !jsonSafe(item)) throw Error(label + "the object must be plain JSON data.");
          if (!ITEM_KINDS.has(item.kind)) throw Error(label + "unknown object kind " + item.kind + ".");
          if (typeof item.id !== "string" || !item.id || where.has(item.id)) throw Error(label + "the id " + item.id + " is missing or already used.");
          const copy = JSON.parse(JSON.stringify(item));
          checkItem(d, copy, n);
          where.set(copy.id, {d, item: copy, at: d.items.length, owned: true}); d.items.push(copy); added.push(copy.id);
          break;
        }
        case "remove": {
          const [d] = found(op, n);
          if (!removed.has(d)) removed.set(d, new Set());
          removed.get(d).add(op.id);
          break;
        }
        case "update": {
          const [d, item] = found(op, n);
          if (!plain(op.set) || !jsonSafe(op.set)) throw Error(label + "the patch must be plain JSON data.");
          for (const [k, v] of Object.entries(op.set)) {
            if (FROZEN.has(k)) throw Error(label + "the " + k + " of an object cannot change.");
            if (v === null || v === undefined) delete item[k]; else item[k] = JSON.parse(JSON.stringify(v));
          }
          checkItem(d, item, n);
          break;
        }
        case "move": {
          const [d, item] = found(op, n);
          if (!Number.isFinite(op.dx) || !Number.isFinite(op.dy)) throw Error(label + "dx and dy must be numbers.");
          if (item.kind === "part") transform(d, item, {x: item.x + op.dx, y: item.y + op.dy});
          else A.moveItem(item, op.dx, op.dy);
          checkItem(d, item, n);
          break;
        }
        case "transform": {
          const [d, item] = found(op, n);
          if (item.kind !== "part") throw Error(label + "only components can be transformed.");
          const change = {};
          for (const k of ["x", "y", "angle"]) if (op.set?.[k] != null) { if (!Number.isFinite(op.set[k])) throw Error(label + k + " must be a number."); change[k] = op.set[k]; }
          transform(d, item, change);
          checkItem(d, item, n);
          break;
        }
        case "document": {
          const d = docFor(op.doc), s = op.set;
          if (!plain(s)) throw Error(label + "expected a patch.");
          for (const [k, v] of Object.entries(s)) {
            if (k === "name") { if (typeof v !== "string" || !v.trim()) throw Error(label + "a document name cannot be empty."); d.name = v; }
            else if (k === "grid") { if (!(v >= A.units.MIN_GRID - 1e-9 && v < 1e4)) throw Error(label + "invalid grid."); d.grid = v; }
            else if (k === "outline") { if (!(Array.isArray(v) && (v.length === 0 || A.validOutline(v)))) throw Error(label + "the outline must enclose an area."); d.outline = JSON.parse(JSON.stringify(v)); }
            else throw Error(label + "document field " + k + " cannot be set from a script.");
          }
          break;
        }
        case "definition": {
          const def = op.def;
          if (!plain(def) || !jsonSafe(def) || defs.has(def.id)) throw Error(label + "the definition is not plain data or its id is used.");
          const copy = JSON.parse(JSON.stringify(def));
          try { A.validate({format: "atrium", version: 1, name: "check", library: [copy], documents: [A.sheet("schematic", "check")]}); }
          catch { throw Error(label + "definition " + copy.id + " is not valid."); }
          project.library.push(copy); defs.set(copy.id, copy);
          break;
        }
        default: throw Error(label + "unknown operation.");
      }
    });
    for (const [d, ids] of removed) d.items = d.items.filter(i => !ids.has(i.id));
    try { if (!copyOnWrite) A.validate(project); }
    catch (e) { throw Error("The edit would leave the project invalid: " + e.message); }
    return {added, removed: [...removed.values()].reduce((n, s) => n + s.size, 0)};
  }

  // ---------------------------------------------------------- feature table
  // One place that knows how each optional module is called. Missing modules are
  // reported by features.list() and fail with a clear message.
  const modules = {
    bom: () => globalThis.AtriumBOM?.report,
    drc: () => globalThis.AtriumDRC?.batch || (!globalThis.AtriumLazy && globalThis.AtriumRules?.drc),
    erc: () => globalThis.AtriumERC?.run,
    annotate: () => globalThis.AtriumAnnotate?.plan,
    pour: () => globalThis.AtriumPolygonPour?.apply,
    outputs: () => globalThis.AtriumFabOutputs?.build,
    length: () => globalThis.AtriumLength?.lengths,
    route: () => globalThis.AtriumAutorouter?.routeBoard,
    fanout: () => globalThis.AtriumFanout?.plan,
    stackup: () => globalThis.AtriumStackup?.stored,
    connectivity: () => globalThis.AtriumConnectivity?.inspect,
    rules: () => globalThis.AtriumRules?.query
  };
  // The global each feature lives in, for editors that load feature modules on first use (app/lazy.js).
  const FEATURE_GLOBALS = {bom: "AtriumBOM", drc: "AtriumDRC", erc: "AtriumERC", annotate: "AtriumAnnotate", pour: "AtriumPolygonPour",
    outputs: "AtriumFabOutputs", length: "AtriumLength", route: "AtriumAutorouter", fanout: "AtriumFanout", stackup: "AtriumStackup",
    connectivity: "AtriumConnectivity", rules: "AtriumRules"};
  function need(name) { const f = modules[name](); if (!f) throw Error("The " + name + " feature is unavailable in this build."); return f; }
  // Run `use(fn)` with the feature's entry point. When the module is not loaded yet and
  // AtriumLazy can load it, the result is a Promise (the worker path accepts Promises).
  function withFeature(name, use) {
    const f = modules[name]();
    if (f) return use(f);
    const L = globalThis.AtriumLazy, g = FEATURE_GLOBALS[name];
    if (L && g && typeof L.need === "function" && (typeof L.modules !== "function" || L.modules().includes(g)))
      return Promise.resolve(L.need(g)).then(() => use(need(name)));
    return use(need(name));
  }

  // Maps, Sets and typed arrays become JSON-friendly values for scripts and MCP. A Map entry is
  // {key, ...value} when its value is a plain record without its own `key` field, otherwise
  // [key, value], so every key survives. BigInts become decimal text and a cycle becomes null.
  // `json` also turns typed arrays into arrays, for results sent as JSON text.
  function toPlain(v, json = false, depth = 0, path = new Set()) {
    if (typeof v === "bigint") return String(v);
    if (v == null || typeof v !== "object") return typeof v === "function" || typeof v === "symbol" ? undefined : v;
    if (depth > 40 || path.has(v)) return null;
    path.add(v);
    try {
      const next = x => toPlain(x, json, depth + 1, path);
      const record = x => plain(x) && [Object.prototype, null].includes(Object.getPrototypeOf(x)) && !Object.prototype.hasOwnProperty.call(x, "key");
      if (v instanceof Map) return Array.from(v, ([k, x]) => (record(x) ? {key: next(k), ...next(x)} : [next(k), next(x)]));
      if (v instanceof Set) return Array.from(v, next);
      if (ArrayBuffer.isView(v)) {
        const wide = typeof BigInt64Array === "function" && (v instanceof BigInt64Array || v instanceof BigUint64Array);
        if (!json && !wide) return v;
        return Array.from(v instanceof DataView ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : v, next);
      }
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
      if (Array.isArray(v)) return v.map(next);
      const out = {};
      for (const k of Object.keys(v)) { const x = next(v[k]); if (x !== undefined) out[k] = x; }
      return out;
    } finally { path.delete(v); }
  }
  const clone = v => (v === undefined ? undefined : typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v)));
  // si-sim: field-solver results by geometry, shared by every caller (the key is the whole input).
  const FIELD_CACHE = new Map();

  // ------------------------------------------------------------ main-side API
  // host: {project(), documentId(), selection(), select(ids), edit(fn), amend?(fn),
  //        revision?(), defs?(), info?(text), locate?(id), activate?(docId), runAction?(name),
  //        exportFile?(name,text), pickFile?(exts), units?()}
  // options: {extension:{id, permissions:{read,write,files}}, registry, ui, storage,
  //           settings, dispatch(ownerId, commandId, args), deadline, group:{committed}}
  function create(host, options = {}) {
    const A = globalThis.Atrium;
    const ext = options.extension || {id: "script", permissions: {...SCRIPT_PERMISSIONS}};
    const registry = options.registry || createRegistry();
    const ui = options.ui || null;
    // Permission values: true (granted), "ask" (declared; the host asks on first use), else none.
    // The host may change ext.permissions at any time (revocation); every call re-checks.
    const can = p => ext.permissions?.[p] === true;
    const allowed = perm => !perm ? true : perm === "edit" ? !!(ext.permissions?.["propose:edits"] || ext.permissions?.["write:edits"])
      : perm === "ui" ? !!(can("ui:panel") || can("ui:command") || can("ui:dialog")) : can(perm);
    const project = () => host.project();
    let defsCache = null;
    const defs = () => {
      if (host.defs) return host.defs();
      const lib = project().library;
      if (defsCache?.lib !== lib || defsCache.n !== lib.length) defsCache = {lib, n: lib.length, map: new Map(lib.map(d => [d.id, d]))};
      return defsCache.map;
    };
    const revision = () => host.revision?.() ?? 0;
    const docOf = id => {
      const p = project(), d = id ? p.documents.find(x => x.id === id) : p.documents.find(x => x.id === host.documentId?.()) || p.documents[0];
      if (!d) throw Error("Unknown document " + id + ".");
      return d;
    };
    const board = id => { const d = docOf(id); if (d.kind !== "pcb") throw Error("Choose a PCB layout."); return d; };
    const pick = (o, fields) => {
      if (!Array.isArray(fields) || !fields.length) return o;
      const r = {};
      // Own data only: `fields: ["constructor"]` must not copy an inherited function.
      for (const f of fields) if (typeof f === "string" && Object.prototype.hasOwnProperty.call(o, f) && o[f] !== undefined) r[f] = o[f];
      return r;
    };
    const summary = d => ({id: d.id, name: d.name, kind: d.kind, grid: d.grid, itemCount: d.items.length});
    function itemBox(item, d) {
      const pts = A.itemPoints(item, defs().get(item.def), d.kind), b = A.bounds(pts);
      if (!b) return null;
      const r = (item.width || 0) / 2;
      return r ? [b[0] - r, b[1] - r, b[2] + r, b[3] + r] : b;
    }
    const indexes = new Map();
    function indexOf(d) {
      let e = indexes.get(d.id);
      if (!e || e.rev !== revision() || e.items !== d.items || e.n !== d.items.length) {
        const boxes = new Map();
        for (const i of d.items) boxes.set(i, itemBox(i, d));
        const spatial = globalThis.AtriumSpatial?.create(d.items, i => boxes.get(i));
        indexes.set(d.id, e = {rev: revision(), items: d.items, n: d.items.length, boxes, spatial});
      }
      return e;
    }
    function filterItems(f = {}, paged = false) {
      const d = docOf(f.doc);
      let list = d.items;
      if (Array.isArray(f.bounds)) {
        const e = indexOf(d), q = f.bounds, hit = b => b && b[0] <= q[2] && b[2] >= q[0] && b[1] <= q[3] && b[3] >= q[1];
        list = e.spatial ? e.spatial.query(q) : list.filter(i => hit(e.boxes.get(i)));
      }
      const kinds = f.kinds ? new Set([].concat(f.kinds)) : f.kind ? new Set([f.kind]) : null;
      const ids = f.ids ? new Set(f.ids) : null;
      const where = plain(f.where) ? Object.entries(f.where) : [];
      const filtered = kinds || ids || f.layer != null || f.net != null || where.length;
      const matches = i => (!kinds || kinds.has(i.kind)) && (!ids || ids.has(i.id)) && (f.layer == null || i.layer === f.layer) &&
        (f.net == null || i.net === f.net || (i.pinNets && Object.values(i.pinNets).includes(f.net))) && where.every(([k, v]) => i[k] === v);
      const offset = Math.max(0, f.offset | 0), limit = f.limit > 0 ? f.limit : Infinity;
      if (paged) {
        const size = Math.min(MAX_ITEMS, f.limit > 0 ? Math.floor(f.limit) : 50), end = offset + size;
        if (!filtered) return {items: list.slice(offset, end).map(i => pick(i, f.fields)), total:list.length, next_offset:end < list.length ? end : null};
        const items = []; let total = 0;
        for (const i of list) if (matches(i)) {
          if (total >= offset && total < end) items.push(pick(i, f.fields));
          total++;
        }
        return {items, total, next_offset:end < total ? end : null};
      }
      if (filtered) list = list.filter(matches);
      if (offset || limit < list.length) list = list.slice(offset, offset + limit);
      if (list.length > MAX_ITEMS && !f.count) throw Error(list.length + " objects match. Request at most " + MAX_ITEMS + " per call with limit and offset, or narrow the query.");
      return list;
    }
    function find(id) {
      for (const d of project().documents) { const i = d.items.find(x => x.id === id); if (i) return [d, i]; }
      return [];
    }
    function partPins(id) {
      const [d, item] = find(id);
      if (!item || item.kind !== "part") throw Error("Expected a component id.");
      const def = defs().get(item.def);
      return A.pins(item, def, d.kind).map(p => ({number: p.number, name: p.name, x: p.at[0], y: p.at[1], w: p.w, h: p.h,
        shape: p.shape, layer: p.layer, angle: (p.angle || 0) + (item.angle || 0), ...(typeof p.fn === "string" && p.fn ? {fn: p.fn} : {}), net: d.kind === "pcb" ? item.pinNets?.[p.number] ?? p.net ?? "" : undefined}));
    }
    function pcbNets(d) {
      const counts = new Map(), add = n => { if (n) counts.set(n, (counts.get(n) || 0) + 1); };
      for (const i of d.items) { add(i.net); if (i.pinNets) for (const n of Object.values(i.pinNets)) add(n); }
      return [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([name, objects]) => ({name, objects}));
    }
    // ---- edits: every change becomes a guarded AtriumProposal (version 2) ----
    // The change is computed on a fork that deep-copies only the touched documents,
    // validated, diffed into a proposal, approved (consent / review in the editor),
    // then applied to the live project in one edit, i.e. one undo step. Applying
    // re-checks every guard, so a change drafted against stale data is refused.
    function fork(live, touched, library) {
      const out = {...live, documents: live.documents.map(d => (touched === "all" || touched.has(d.id) ? JSON.parse(JSON.stringify(d)) : d)),
        library: library ? JSON.parse(JSON.stringify(live.library)) : live.library};
      // si-sim: project-level fields are copied too, so a dry run never writes through to the live project.
      if (touched === "all") for (const k of Object.keys(out)) if (k !== "documents" && k !== "library" && out[k] !== null && typeof out[k] === "object") out[k] = JSON.parse(JSON.stringify(out[k]));
      return out;
    }
    // The checkpoint and the captured proposal never cross the worker boundary.
    const group = options.group, initialProject = group && project(), drafts = new Map();
    const DRAFT = Symbol(), MAX_DRAFT_BYTES = 8 * 1024 * 1024;
    let draftBytes = 0;
    function runEdit(label, fn, touched, scope) {
      if (group && project() !== initialProject) throw Error("The script's project changed. Run it again in the new project.");
      const previous = group && group.revision === host.revision?.() && host.revision ? group.checkpoint : null;
      let ran = false;
      const run = () => { fn(); ran = true; };
      // Earlier v1 hosts provide a monotonic revision plus amend, but no checkpoint token.
      const legacy = previous === true && typeof host.amend === "function";
      const result = legacy ? host.amend(run, label, touched, scope) : host.edit(run, label, touched, {...scope, previous});
      if (!ran || result === false) return false;
      if (group) {
        group.transactions = (group.transactions || 0) + 1;
        if (!legacy && !result?.amended) group.steps = (group.steps || 0) + 1;
        group.revision = host.revision?.();
        group.checkpoint = result?.checkpoint || true;
      }
      return true;
    }
    function forget(id) {
      const entry = drafts.get(id);
      if (entry) { draftBytes -= entry.bytes; drafts.delete(id); }
      return !!entry;
    }
    function guardRevision(live, ids) {
      const rev = host.revision?.(), U = globalThis.AtriumUndoStore, docs = live.documents.filter(d => ids === "all" || ids.has(d.id));
      const stamp = d => {
        const v = U?.documentVersions?.(d, live);
        return v && [v.floor, v.items, v.outer, v.pours, v.library, v.project, v.parameters];
      };
      const stamps = docs.map(stamp);
      return () => project() === live && !host.editInProgress?.() && (rev != null && host.revision?.() === rev ||
        docs.length > 0 && docs.every((d, i) => stamps[i] && globalThis.AtriumProposal.equal(stamps[i], stamp(d))));
    }
    function change(label, mutate, touched, library = false, mode, work, moved) {
      if (!allowed("edit")) throw Error(ext.id + " needs the propose:edits or write:edits permission to change the design.");
      const live = project(), after = work || fork(live, touched, library);
      const out = mutate(after) || {};
      try { A.validate(after); } catch (e) { throw Error("The edit would leave the project invalid: " + e.message); }
      const P = globalThis.AtriumProposal;
      if (!P) throw Error("Proposals are unavailable in this build.");
      let itemPairs;
      if (moved) {
        const order = new Map(live.documents.map((d,n) => [d.id,n]));
        itemPairs = [...moved].sort(([,a],[,b]) => order.get(a.d.id)-order.get(b.d.id) || a.at-b.at);
      }
      const {proposal} = P.build(live, after, {allowV1: false, tool: ext.id, summary: String(label), itemPairs});
      if (!proposal) return {applied: 0, ...out};
      if (mode === DRAFT) {
        const text = JSON.stringify(proposal);
        if (text.length > MAX_DRAFT_BYTES) throw Error("The proposed edit is too large to hold for review. Choose fewer objects.");
        while (drafts.size >= 32 || draftBytes + text.length > MAX_DRAFT_BYTES) forget(drafts.keys().next().value);
        const id = A.id(), rows = P.inspect(proposal, live, 2000);
        drafts.set(id, {proposal, rows, label, valid: guardRevision(live, touched), target: options.target?.(), epoch: options.editEpoch?.(), bytes: text.length});
        draftBytes += text.length;
        return {handle: id, total: proposal.ops.length, changes: rows.slice(0, 100).map(r => ({label: r.label.slice(0, 512), detail: r.detail.slice(0, 512)})), ...out};
      }
      return then(settle(proposal, label, false), r => {
        if ("added" in out && r.applied === 0) return {...out, added: [], removed: 0, ...r};
        return {...out, ...r};
      });
    }
    function settle(proposal, label, untrusted, review = false, draft) {
      const P = globalThis.AtriumProposal, live = project(), permission = ext.permissions;
      if (!P) throw Error("Proposals are unavailable in this build.");
      const source = options.editEpoch?.(), binding = options.target?.();
      const write = permission?.["write:edits"], propose = permission?.["propose:edits"];
      const ready = () => {
        if (options.alive && !options.alive()) return {applied: 0, cancelled: true};
        if (options.target?.() !== binding || project() !== live || draft && !draft.valid()) return {applied: 0, stale: true};
        if (source !== options.editEpoch?.() || !allowed("edit") || write && !permission["write:edits"] ||
            propose && !permission["propose:edits"]) return {applied: 0, revoked: true};
        return null;
      };
      const denied = ready();
      if (denied) return denied;
      const direct = !review && write === true;
      // A direct commit checks the proposal during apply. The other paths
      // check before reviewing or returning it and only reviewers need rows.
      const rows = draft?.rows || (options.approve || untrusted || !direct
        ? P.inspect(proposal, live, options.approve ? 2000 : 0) : undefined);
      if (untrusted) {
        const scope = P.footprint(proposal);
        const trial = p => fork(p, scope.project || proposal.ops.some(o => o.target === "document") ? "all" : new Set(scope.documents), scope.library);
        P.applyChecked(live, proposal, {validate: A.validate, trial, validateOnly: true});
      }
      const decide = options.approve ? options.approve({ext, label: String(label), rows, proposal, review}) : direct;
      return then(decide, choice => {
        if (choice?.revoked || choice?.stale || choice?.cancelled) return {applied:0, ...choice};
        if (options.alive && !options.alive()) return {applied:0, cancelled:true};
        if (!choice || Array.isArray(choice) && !choice.length) {
          if (!options.approve && (review || can("propose:edits"))) return {applied: 0, proposal};
          return {applied: 0, declined: true};
        }
        const denied = ready();
        if (denied) return denied;
        const select = Array.isArray(choice) ? choice : null;
        const count = P.applyChecked(live, proposal, {select, validate:A.validate, trial:false,
          edit:(fn, _, touched, scope) => runEdit(label, fn, touched, scope)});
        if (!count) return {applied: 0, blocked: true};
        host.info?.(label + " · " + count + " change" + (count === 1 ? "" : "s"));
        const structural = select && proposal.ops.some(o => o.target === "item" && o.op !== "set");
        const chosen = structural && select.map(n => proposal.ops[n]).filter(o => o?.target === "item");
        return {applied: count, ...(chosen ? {added: chosen.filter(o => o.op === "add").map(o => o.value.id), removed: chosen.filter(o => o.op === "remove").length} : {})};
      });
    }
    function commit(label, ops, select, mode) {
      if (!Array.isArray(ops)) throw Error("Transaction operations must be a list.");
      const live = project(), docs = new Set(), ids = new Set(), named = new Set();
      for (const o of ops) {
        if (o?.op === "add" || o?.op === "document") named.add(o.doc || docOf().id);
        else if (o?.id) ids.add(o.id);
      }
      const work = {...live, library: [...live.library], documents: live.documents.map(d => {
        const target = named.has(d.id) || ids.size && d.items.some(i => ids.has(i.id));
        if (!target) return d;
        docs.add(d.id); return {...d, items: d.items.slice()};
      })};
      // A small board move changes only the guarded geometric fields of the copied items.
      // Schematic transforms can also reroute wires; mixed and structural edits use the full diff.
      const moved = ops.length <= 32 && ops.every(o => o?.op === "move") && work.documents.every(d => !docs.has(d.id) || d.kind === "pcb") ? new Map() : null;
      const r = ops.length ? change(label, after => applyOps(after, ops, host.documentId?.(), true, moved), docs, false, mode, work, moved) : {applied: 0, added: [], removed: 0};
      return then(r, res => { if (select && (res.applied || !ops.length)) host.select?.(select.filter(id => typeof id === "string")); return res; });
    }
    function draft(action, o = {}) {
      if (!can("read:project")) throw Error("Drafting a preview needs read:project.");
      if (action === "transaction") {
        if (!Array.isArray(o.ops)) throw Error("A transaction draft needs operations.");
        const ops = o.ops.map(op => op?.op === "add" && op.item && !op.item.id ? {...op, item: {...op.item, id: A.id()}} : op);
        return commit(String(o.label || "Proposed edit"), ops, null, DRAFT);
      }
      if (!["annotate.apply", "pour", "route", "fanout", "autoplace", "routePlan", "planes"].includes(action))
        throw Error("Unknown proposal planner.");
      return runFeature(action, {...o, dryRun: false}, DRAFT);
    }
    function reviewDraft(id) {
      const draft = drafts.get(id);
      if (!draft) return {applied: 0, stale: true};
      forget(id);
      if (!can("read:project") || draft.epoch !== options.editEpoch?.()) return {applied: 0, revoked: true};
      if (draft.target !== options.target?.()) return {applied: 0, stale: true};
      return settle(draft.proposal, draft.label, false, true, draft);
    }
    function submit(proposal, label = "Proposal") {
      if (!allowed("edit")) throw Error(ext.id + " needs the propose:edits or write:edits permission to submit proposals.");
      if (!plain(proposal) || !jsonSafe(proposal)) throw Error("A proposal must be plain JSON data.");
      if (proposal.version !== 2) throw Error("Submit version 2 proposals.");
      return settle(JSON.parse(JSON.stringify(proposal)), String(label), true);
    }
    // Whitelisted field edits (PROPOSE_FIELDS), reviewed as one proposal and applied as one undo step:
    //   [{target: "item", id, path: ["sim", ...], value}, {target: "definition", id, path, value},
    //    {target: "project", path: ["simulation", "benches"], value}]   value null or absent deletes the field.
    // The guards record the current values, so a change made meanwhile makes the proposal stale.
    function propose(edits, o = {}) {
      const L = PROPOSE_LIMITS, fail = m => { throw Error("proposals.propose: " + m); };
      if (!Array.isArray(edits) || !edits.length) fail("expects a non-empty list of edits.");
      if (edits.length > L.edits) fail("at most " + L.edits + " edits per proposal.");
      if (!plain(o)) fail("options must be an object.");
      const label = scrubText(o.label || "Proposed changes").slice(0, L.label) || "Proposed changes";
      const live = project(), touched = new Set(), seen = new Map(), locations = new Map();
      const requested = new Set(edits.filter(e => e?.target === "item").map(e => e.id));
      if (requested.size) for (const d of live.documents) for (const item of d.items) if (requested.has(item.id)) locations.set(item.id, [d, item]);
      let library = false, total = 0;
      const checked = edits.map((e, n) => {
        const at = "edit " + (n + 1);
        if (!plain(e) || Object.keys(e).some(k => !["target", "id", "path", "value"].includes(k))) fail(at + " must be {target, id?, path, value}.");
        if (!Array.isArray(e.path) || !e.path.length || e.path.length > L.depth || e.path.some(k => typeof k !== "string" || !SAFE_KEY.test(k) || FORBIDDEN_KEYS.has(k)))
          fail(at + ": path must list 1 to " + L.depth + " field names.");
        if (e.value !== undefined && !jsonSafe(e.value)) fail(at + ": the value must be plain JSON data.");
        const size = e.value == null ? 0 : JSON.stringify(e.value).length;
        if (size > L.valueChars || (total += size) > L.totalChars) fail(at + ": the value is too large.");
        let owner, fields;
        if (e.target === "item") {
          const [d, item] = locations.get(e.id) || [];
          if (!item) fail(at + ": object " + e.id + " does not exist.");
          fields = PROPOSE_FIELDS.item[item.kind];
          if (!fields) fail(at + ": " + item.kind + " objects have no fields an extension can propose.");
          touched.add(d.id); owner = {target: "item", id: item.id};
        } else if (e.target === "definition") {
          if (typeof e.id !== "string" || !defs().get(e.id)) fail(at + ": library definition " + e.id + " does not exist.");
          fields = PROPOSE_FIELDS.definition; library = true; owner = {target: "definition", id: e.id};
        } else if (e.target === "project") {
          if (e.id != null) fail(at + ": a project edit has no id.");
          fields = PROPOSE_FIELDS.project; owner = {target: "project"};
        } else fail(at + ": target must be item, definition or project.");
        if (!fields.includes(e.path[0])) fail(at + ": " + e.path[0] + " cannot be proposed here (allowed: " + fields.join(", ") + ").");
        // One edit per field: a path inside another edit's path would make the review ambiguous.
        const key = owner.target + "/" + (owner.id || ""), n2 = e.path.length;
        if (!seen.has(key)) seen.set(key, []);
        for (const path of seen.get(key)) if (path.slice(0, n2).every((k, i) => k === e.path[i]))
          fail(at + " overlaps an earlier edit of " + path.join(".") + ".");
        seen.get(key).push(e.path);
        return {...owner, path: e.path, value: e.value ?? null};
      });
      const after = fork(live, touched, library);
      // Project fields are copied before editing, so the live project is never written through.
      for (const k of PROPOSE_FIELDS.project) if (checked.some(c => c.target === "project" && c.path[0] === k) && live[k] !== undefined) after[k] = clone(live[k]);
      const items = new Map();
      for (const d of after.documents) if (touched.has(d.id)) for (const i of d.items) items.set(i.id, i);
      const lib = library ? new Map(after.library.map(d => [d.id, d])) : null;
      for (const c of checked) {
        let at = c.target === "project" ? after : c.target === "definition" ? lib.get(c.id) : items.get(c.id);
        for (const k of c.path.slice(0, -1)) {
          if (!Object.prototype.hasOwnProperty.call(at, k) || at[k] == null) { if (c.value === null) { at = null; break; } at[k] = {}; }
          if (!plain(at[k])) fail(c.path.join(".") + " goes through a value that is not an object.");
          at = at[k];
        }
        if (!at) continue;
        const last = c.path[c.path.length - 1];
        if (c.value === null) delete at[last]; else at[last] = clone(c.value);
      }
      try { A.validate(after); } catch (e) { fail("the change would leave the project invalid: " + e.message); }
      const P = globalThis.AtriumProposal;
      if (!P) throw Error("Proposals are unavailable in this build.");
      const {proposal} = P.build(live, after, {allowV1: false, tool: ext.id, summary: label});
      if (!proposal) return {applied: 0, unchanged: true};
      return settle(proposal, label, false, true);
    }
    // AI placement, routing and plane proposals (autoplace.js): dryRun reports, else review.
    function aiPlan(kind, o = {}, mode) {
      const M = globalThis.AtriumAutoplace || globalThis.AtriumLazy?.need?.("AtriumAutoplace") || Promise.reject(Error("AI planning is unavailable in this build."));
      return then(M, () => { const P = globalThis.AtriumAutoplace, id = board(o.doc).id;
        if (o.dryRun) { const copy = JSON.parse(JSON.stringify(project())); return toPlain(P.feature(kind, copy, id, defs(), o)); }
        return Promise.resolve().then(() => writeFeature(P.LABELS[kind], after => toPlain(P.feature(kind, after, id, defs(), o)), new Set([id]), mode)).finally(() => P.preview.clear()); });
    }
    function runFeature(action, o, mode) {
      const request = {mode, live: project(), target: options.target?.(), epoch: options.editEpoch?.()};
      if (action !== "annotate.apply") o = {...o, doc:board(o.doc).id};
      return featureEdits[action](o, request);
    }
    function writeFeature(label, fn, touched, request) {
      if (project() !== request.live || options.target?.() !== request.target) return {applied:0, stale:true};
      if (request.epoch !== options.editEpoch?.()) return {applied:0, revoked:true};
      if (options.alive && !options.alive()) return {applied:0, cancelled:true};
      return change(label, fn, touched, false, request.mode);
    }
    // Schematic netlist: JSON for tools, SPICE text for simulators. Nets with the same name
    // join across sheets; ground names map to SPICE node 0. Models and subcircuits are the
    // simulator's job: X lines name the component value as the subcircuit.
    function netlist(o = {}) {
      const p = project(), sheets = o.doc ? [docOf(o.doc)] : p.documents.filter(d => d.kind === "schematic");
      if (!sheets.length || sheets.some(d => d.kind !== "schematic")) throw Error("A netlist needs a schematic sheet.");
      const comps = [], nets = new Map(), channels = !o.doc && globalThis.AtriumMultichannel?.netlist(p, defs());
      for (const d of channels ? [] : sheets) {
        const c = A.connectivity(d, defs());
        for (const item of d.items) {
          if (item.kind !== "part") continue;
          const def = defs().get(item.def), pins = (A.geometries(def, "schematic")?.pins || []).filter(pin => !pin.hidden || pin.net);
          const rows = pins.map(pin => {
            const net = c.byPin.get(item.id + "/" + pin.number) || pin.net || "NC_" + item.ref + "_" + pin.number;
            if (!nets.has(net)) nets.set(net, []);
            nets.get(net).push(item.ref + "." + pin.number);
            return {number: String(pin.number), name: pin.name || "", net, ...(typeof pin.fn === "string" && pin.fn ? {fn: pin.fn} : {}), ...(pin.part ? {unit: pin.part} : {})};
          }).sort((a, b) => a.number.localeCompare(b.number, undefined, {numeric: true}));
          comps.push({id: item.id, ref: item.ref, value: item.value || "", definition: def?.name || "", footprint: def?.footprint?.name || null, sheet: d.id, pins: rows});
        }
      }
      comps.sort((a, b) => a.ref.localeCompare(b.ref, undefined, {numeric: true}));
      const json = channels || {project: p.name, components: comps, nets: [...nets].map(([name, pins]) => ({name, pins})).sort((a, b) => a.name.localeCompare(b.name))};
      if ((o.format || "json") === "json") return json;
      if (o.format !== "spice") throw Error("Netlist formats are json and spice.");
      const node = n => (/^(0|gnd|agnd|dgnd|pgnd|ground|vss)$/i.test(n) ? "0" : n.replace(/[^A-Za-z0-9_]/g, "_"));
      const value = v => String(v).replace(/\s+/g, "").replace(/[Ωω]|ohms?$/gi, "").replace(/^(\d+)([kKmMuUnNpPgGrR])(\d+)$/, (x, a, u, b) => a + "." + b + (/[rR]/.test(u) ? "" : u)).replace(/µ|μ/g, "u").replace(/([\d.]|[pnumkKMG])[FH]$/, "$1") || "0";
      const byName = (pins, order) => order.map(n => pins.find(q => q.name.toUpperCase() === n)).every(Boolean) ? order.map(n => pins.find(q => q.name.toUpperCase() === n)) : pins;
      const lines = ["* " + p.name + " (Waffle netlist)"];
      for (const c of comps) {
        const kind = (c.ref.match(/^[A-Za-z]+/)?.[0] || "X").toUpperCase(), nodes = list => list.map(q => node(q.net)).join(" ");
        if (/^(R|C|L)$/.test(kind) && c.pins.length === 2) lines.push(c.ref + " " + nodes(c.pins) + " " + value(c.value));
        else if (kind === "D" && c.pins.length === 2) lines.push(c.ref + " " + nodes(byName(c.pins, ["A", "K"])) + " " + (c.value || "D"));
        else if (kind === "Q" && c.pins.length === 3) lines.push(c.ref + " " + nodes(byName(c.pins, ["C", "B", "E"])) + " " + (c.value || "Q"));
        else lines.push((kind === "X" ? "" : "X") + c.ref + " " + nodes(c.pins) + " " + (c.value || c.definition || "SUBCKT").replace(/\s+/g, "_") + "  ; pins " + c.pins.map(q => q.number + (q.name ? ":" + q.name : "")).join(" "));
      }
      lines.push(".end");
      return {...json, text: lines.join("\n") + "\n"};
    }
    const fieldQueue = {last: Promise.resolve(), pending: 0};
    // ---- si-sim: read-only signal-integrity calls (simulation.*) for the Signal Integrity extension and
    // any other. The routed copper, stack-up and via data of one net; the field solver; IBIS models the
    // project stores in project.simulation (written only through reviewed proposals).
    const SIM_LIMITS = {models: 64, neighbours: 5, tracks: 20000, neighbourTracks: 4000, neighbourWork: 2e7}; // neighbourWork: segment-pair tests on the UI thread
    const simRoot = () => { const s = project().simulation; return plain(s) ? s : {}; };
    const own = (o, k) => plain(o) && Object.prototype.hasOwnProperty.call(o, k);
    function simulationGet() {
      const s = simRoot(), models = plain(s.models) ? s.models : {};
      const list = Object.keys(models).filter(k => /^[\w.-]{1,80}$/.test(k) && plain(models[k]) && typeof models[k].text === "string").slice(0, SIM_LIMITS.models).map(key => {
        const m = models[key];
        return {key, name: String(m.name || key).slice(0, 200), kind: String(m.kind || "ibis").slice(0, 20), size: m.text.length,
          sha256: typeof m.sha256 === "string" ? m.sha256.slice(0, 64) : null, added: typeof m.added === "string" ? m.added.slice(0, 40) : null,
          summary: plain(m.summary) && jsonSafe(m.summary) ? clone(m.summary) : null};
      });
      const pick2 = v => (plain(v) && jsonSafe(v) ? clone(v) : {});
      return {version: 1, models: list, assign: pick2(s.assign), settings: pick2(s.settings),
        benches: Array.isArray(s.benches) ? clone(s.benches) : []};
    }
    function simulationModel(key) {
      const models = simRoot().models;
      if (typeof key !== "string" || !own(models, key) || !plain(models[key]) || typeof models[key].text !== "string") return null;
      const m = models[key];
      return {key, name: String(m.name || key).slice(0, 200), kind: String(m.kind || "ibis").slice(0, 20), text: m.text};
    }
    // One net's routed copper with what a channel model needs. Modules load on first use.
    function simulationChannel(name, o = {}) {
      if (typeof name !== "string" || !name) throw Error("simulation.channel expects a net name.");
      const d = board(o.doc), need = ["AtriumStackup", "AtriumImpedance", "AtriumRules"].filter(g => !globalThis[g]);
      const go = () => channelOf(d, name, o);
      const L = globalThis.AtriumLazy;
      if (need.length && L?.need) return Promise.resolve(L.need(need)).then(() => (globalThis.AtriumViaStubs || !L.modules?.().includes("AtriumViaStubs") ? null : L.need("AtriumViaStubs").catch(() => null))).then(go);
      if (!globalThis.AtriumViaStubs && L?.need && L.modules?.().includes("AtriumViaStubs")) return Promise.resolve(L.need("AtriumViaStubs")).catch(() => null).then(go);
      return go();
    }
    function channelOf(d, name, o) {
      const D = defs(), ST = globalThis.AtriumStackup, IM = globalThis.AtriumImpedance;
      const round = x => Math.round(x * 1e6) / 1e6;
      let stackup = null;
      if (ST) {
        const st = ST.get(d, D), layers = st.layers || [];
        let z = 0, er = 0, h = 0;
        const out = [];
        for (const l of layers) {
          const t = Number(l.thickness) || 0;
          if (l.type === "Signal" || l.type === "Plane") {
            const g = IM?.geometry ? IM.geometry(layers, l.key) : null;
            out.push({key: l.key, name: l.name, type: l.type, z: round(z + t / 2), t, geometry: g ? toPlain(g) : null});
          } else if (l.type === "Dielectric" || l.type === "Adhesive") { er += (Number(l.dk) || 4.2) * t; h += t; }
          z += t;
        }
        stackup = {thickness: round(z), er: h > 0 ? round(er / h) : 4.2, derived: !!st.derived, layers: out};
      }
      const items = d.items, tracks = [], vias = [], parts = [];
      for (const i of items) {
        if (i.kind === "track" && i.net === name && Array.isArray(i.points)) tracks.push({id: i.id, layer: i.layer, width: i.width || 0, points: i.points.map(p => [p[0], p[1]])});
        else if (i.kind === "via" && i.net === name) vias.push({id: i.id, x: i.x, y: i.y, drill: i.drill || 0, diameter: i.diameter || 0, from: i.fromLayer || "Top", to: i.toLayer || "Bottom",
          backdrill: plain(i.backdrill) ? toPlain(i.backdrill) : null});
      }
      if (tracks.length > SIM_LIMITS.tracks) throw Error("Net " + name + " has more than " + SIM_LIMITS.tracks + " tracks.");
      // The Width rule's impedance profile per track: its cross-section as DRC and the Layer Stack Manager solve it
      // (the profile's references, etch and coplanar ground gap), in stackup.profiles[id][layer]; track.profile = id.
      const RL = globalThis.AtriumRules;
      if (stackup && ST.profileValues && RL?.resolver && tracks.length) {
        const profiles = {};
        let q = null; try { q = RL.resolver(d, {project: project()}); } catch { q = null; }
        for (const t of tracks) {
          let id = null; try { id = q?.("width", {net: name, layer: t.layer})?.impedance?.profile || null; } catch { id = null; }
          if (!id) continue;
          if (!profiles[id] || !(t.layer in profiles[id])) {
            let v = null; try { v = ST.profileValues(d, id, t.layer, D); } catch { v = null; }
            const {w, s, ...geom} = v?.geom || {};
            (profiles[id] ||= {})[t.layer] = v?.geom ? toPlain(geom) : null;
          }
          if (profiles[id][t.layer]) t.profile = id;
        }
        if (tracks.some(t => t.profile)) stackup.profiles = profiles;
      }
      const VS = globalThis.AtriumViaStubs;
      if (VS && vias.length) {
        try {
          const rows = new Map(VS.report(d, D).rows.map(r => [r.id, r]));
          for (const v of vias) { const r = rows.get(v.id); if (r) v.stub = {top: r.stubTop, bottom: r.stubBottom, residual: r.residual ?? null, used: r.used || [], status: r.status}; }
        } catch {}
      }
      const pads = [];
      for (const i of items) {
        if (i.kind !== "part") continue;
        const pn = i.pinNets ? Object.values(i.pinNets) : [];
        if (!pn.includes(name)) continue;
        const def = D.get(i.def), pins = partPins(i.id);
        parts.push({id: i.id, ref: i.ref, value: i.value || "", def: i.def, defName: def?.name || "", parameters: plain(i.parameters) ? toPlain(i.parameters) : {},
          pins: pins.map(p => ({pin: String(p.number), name: p.name || "", net: p.net || "", x: p.x, y: p.y, layer: p.layer || "Top", w: p.w, h: p.h}))});
        for (const p of pins) if (p.net === name) pads.push({part: i.id, ref: i.ref, pin: String(p.number), name: p.name || "", x: p.x, y: p.y, w: p.w, h: p.h, layer: p.layer || "Top", shape: p.shape});
      }
      const neighbours = [];
      let work = 0, truncated = false;
      const reach = Math.max(0, Math.min(SIM_LIMITS.neighbours, Number(o.neighbours) || 0));
      if (reach > 0 && tracks.length) {
        let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
        for (const t of tracks) for (const [x, y] of t.points) { bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y); }
        const own2 = tracks.map(t => ({layer: t.layer, w: t.width, pts: t.points}));
        const segD = (p, a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy, t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0; return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy); };
        const close = (t, w) => own2.some(s => s.layer === t.layer && s.pts.some((p, k) => k > 0 && t.points.some((q, j) => {
          if (++work > SIM_LIMITS.neighbourWork) { truncated = true; return true; }
          const lim = reach + (s.w + w) / 2;
          if (segD(q, s.pts[k - 1], p) <= lim) return true;
          return j > 0 && (segD(s.pts[k - 1], t.points[j - 1], q) <= lim || segD(p, t.points[j - 1], q) <= lim);
        })));
        for (const i of filterItems({doc: d.id, kind: "track", bounds: [bx0 - reach - 1, by0 - reach - 1, bx1 + reach + 1, by1 + reach + 1], count: true})) {
          if (i.net === name || !i.net || !Array.isArray(i.points) || neighbours.length >= SIM_LIMITS.neighbourTracks) continue;
          if (truncated) break;
          if (close(i, i.width || 0) && !truncated) neighbours.push({net: i.net, id: i.id, layer: i.layer, width: i.width || 0, points: i.points.map(p => [p[0], p[1]])});
        }
      }
      return {net: name, doc: {id: d.id, name: d.name}, stackup, tracks, vias, pads, parts, neighbours, neighboursTruncated: truncated, clearance: Number(o.clearance) > 0 ? Number(o.clearance) : 0.25};
    }
    // The 2D field solver for one cross-section (AtriumFieldSolver, in its own worker). Results are cached
    // for the session; at most a few solves are queued per caller.
    function simulationFieldSolve(geom, o = {}) {
      if (!plain(geom) || !jsonSafe(geom) || JSON.stringify(geom).length > 4096) throw Error("simulation.fieldSolve expects a cross-section object (see the field solver's geometry keys).");
      const quality = o.quality === "fast" ? "fast" : "normal", fGHz = Number(o.fGHz) > 0 && Number(o.fGHz) <= 100 ? Number(o.fGHz) : undefined;
      const key = JSON.stringify([geom, quality, fGHz ?? null]);
      if (FIELD_CACHE.has(key)) return clone(FIELD_CACHE.get(key));
      if (fieldQueue.pending >= 8) throw Error("Too many field solves are waiting; await the ones already running.");
      fieldQueue.pending++;
      const L = globalThis.AtriumLazy;
      const job = fieldQueue.last.then(() => globalThis.AtriumFieldSolver || (L?.need ? L.need("AtriumFieldSolver").then(() => globalThis.AtriumFieldSolver) : null)).then(FS => {
        if (!FS) throw Error("The field solver is unavailable in this build.");
        return FS.async(clone(geom), {quality, fGHz});
      }).then(r => {
        const pickN = k => (Number.isFinite(r?.[k]) ? r[k] : null);
        const out = {ok: r?.ok !== false, error: r?.error ? String(r.error) : null};
        for (const k of ["z", "z0", "zodd", "zeven", "zdiff", "zcommon", "eeff", "eeffOdd", "eeffEven", "delay", "kb", "kf", "kfPsPerMm", "alpha_c", "alpha_d", "ms"]) out[k] = pickN(k);
        out.warnings = Array.isArray(r?.warnings) ? r.warnings.map(String).slice(0, 20) : [];
        if (FIELD_CACHE.size >= 256) FIELD_CACHE.delete(FIELD_CACHE.keys().next().value);
        FIELD_CACHE.set(key, out);
        return clone(out);
      }).finally(() => { fieldQueue.pending--; });
      fieldQueue.last = job.catch(() => {});
      return job;
    }
    // A text file the user picks (IBIS models, tables). Read only through the picker; size-capped.
    function pickText(o = {}) {
      if (!host.pickFile) throw Error("Opening files is unavailable here.");
      const accept = (Array.isArray(o.accept) ? o.accept : []).filter(x => typeof x === "string" && /^\.[\w-]{1,16}$/.test(x)).slice(0, 8);
      const max = Math.min(Number(o.maxBytes) > 0 ? Number(o.maxBytes) : 4194304, 8388608);
      const open = ui?.pickFile ? ui.pickFile(ext, accept.length ? accept : [".txt"]) : host.pickFile(accept.length ? accept : [".txt"]);
      return Promise.resolve(open).then(f => {
        if (!f) return null;
        if (!(f.size <= max)) throw Error(String(f.name) + " is larger than " + Math.round(max / 104857.6) / 10 + " MB.");
        return Promise.resolve(f.text()).then(text => ({name: String(f.name || "").slice(0, 255), size: f.size, text: String(text)}));
      });
    }
    const store = options.storage || new Map();
    async function inspectMotion(action, args = {}) {
      if (!options.inspectMotion) throw Error("Motion diagnostics need an interactive editor.");
      const result = await options.inspectMotion(action, args);
      if (!can("read:motion") || options.alive?.() === false) throw Error("The motion grant is no longer active.");
      return result;
    }

    const R = "read:project", E = "edit", F = "outputs:write", U = "ui", UP = "ui:panel", UC = "ui:command", UD = "ui:decorations", MR = "read:motion", X = "run:external", N = null;
    // ui.decorations.set: at most DECORATION_LIMITS.callsPerSecond calls per second per extension.
    const decorationRate = {at: 0, n: 0};
    function decorate(docId, items) {
      const now = Date.now();
      if (now - decorationRate.at > 1000) { decorationRate.at = now; decorationRate.n = 0; }
      if (++decorationRate.n > DECORATION_LIMITS.callsPerSecond) throw Error("ui.decorations.set: at most " + DECORATION_LIMITS.callsPerSecond + " calls per second.");
      const d = docOf(docId ?? undefined), list = cleanDecorations(items);
      if (ui?.decorate) ui.decorate(ext, d.id, list);
      return {document: d.id, count: list.length};
    }
    function runDRC(o = {}) {
      const p = project(), doc = board(o.doc), rev = revision();
      const checkContext = () => {
        if (!can(R)) throw Error(ext.id + " needs the read:project permission for drc.");
        if (options.alive && !options.alive()) throw Error("The rule check was cancelled.");
        if (project() !== p || revision() !== rev) throw Error("The design changed while preparing the rule check.");
      };
      return withFeature("drc", batch => {
        checkContext();
        const rules = o.rules || globalThis.AtriumRules?.stored(doc, p) || undefined;
        return then(globalThis.AtriumDRC?.prepare?.(rules), () => {
          checkContext();
          return toPlain(batch(doc, defs(), rules, {project:p, types:o.types, limit:o.limit}));
        });
      });
    }
    const featureEdits = {
      "annotate.apply": (o, mode) => withFeature("annotate", f => writeFeature("Annotate", after => {
        const plan = f(after, o);
        return {report: toPlain(AtriumAnnotate.apply(after, plan, o)), ...(mode.mode === DRAFT ? {annotation: plan.rows.filter(r => r.changed).slice(0, 200).map(r => ({id:r.id, sheet:r.sheetName, current:r.current, proposed:r.proposed}))} : {})};
      }, "all", mode)),
      "pour": (o, mode) => withFeature("pour", f => { const id = board(o.doc).id; return writeFeature("Repour polygons", after => ({report: toPlain(f(after.documents.find(d => d.id === id), defs(), o))}), new Set([id]), mode); }),
      // Planners return {add, remove, modify, report}; the module's apply() edits the board.
      "route": (o, mode) => withFeature("route", f => { const id = board(o.doc).id; return writeFeature("Autoroute", after => {
        const d = after.documents.find(x => x.id === id), plan = f(d, defs(), {...o, project: after});
        AtriumAutorouter.apply(d, plan);
        return {report: toPlain(plan.report ?? {added: plan.add?.length ?? 0})};
      }, new Set([id]), mode); }),
      "fanout": (o, mode) => withFeature("fanout", f => { const id = board(o.doc).id; return writeFeature("Fanout", after => {
        const d = after.documents.find(x => x.id === id), plan = f(d, defs(), {...o, project: after});
        if (typeof AtriumFanout.apply === "function") AtriumFanout.apply(d, plan); else d.items.push(...(plan.add || []));
        return {report: toPlain(plan.report ?? {added: plan.add?.length ?? 0})};
      }, new Set([id]), mode); }),
      "autoplace": (o, mode) => aiPlan("place", o, mode), "routePlan": (o, mode) => aiPlan("route", o, mode), "planes": (o, mode) => aiPlan("planes", o, mode),
    };
    const handlers = {
      "project.info": [R, () => {
        const p = project();
        return {name: p.name, units: A.units.normal(p.units), apiVersion: VERSION, revision: revision(), activeDocument: docOf().id,
          documents: p.documents.map(summary), libraryCount: p.library.length, extensions: (p.extensions || []).length};
      }],
      "documents.list": [R, () => project().documents.map(summary)],
      "documents.active": [R, () => { const d = docOf(); return {...summary(d), outline: d.outline}; }],
      "documents.get": [R, (id, o = {}) => { const d = docOf(id); return {...summary(d), outline: d.outline, notes: d.notes, ...(o.items ? {items: filterItems({...o, doc: d.id}).map(i => pick(i, o.fields))} : {})}; }],
      "documents.activate": [U, id => { docOf(id); if (!host.activate) throw Error("Switching documents is unavailable here."); host.activate(id); return true; }],
      "items.page": [R, f => filterItems(f, true)],
      "items.list": [R, f => filterItems(f).map(i => pick(i, f?.fields))],
      "items.count": [R, f => filterItems({...f, offset: 0, limit: 0, count: true}).length],
      "items.get": [R, (id, o = {}) => { const [d, i] = find(id); return i ? {...pick(i, o.fields), document: d.id} : null; }],
      "defs.list": [R, (o = {}) => project().library.map(d => o.fields ? pick(d, o.fields) : {id: d.id, name: d.name, prefix: d.prefix, value: d.value, category: d.category, symbol: !!d.symbol, footprint: d.footprint?.name || (d.footprint ? d.name : null)})],
      "defs.get": [R, id => defs().get(id) || null],
      "parts.pins": [R, partPins],
      "nets.list": [R, (o = {}) => {
        const d = docOf(o.doc);
        if (d.kind === "pcb") return pcbNets(d);
        return A.connectivity(d, defs()).nets.map(n => ({name: n.name, pins: n.pins, wires: n.wires, conflict: n.conflict}));
      }],
      "nets.items": [R, (name, o = {}) => {
        const d = docOf(o.doc);
        if (d.kind === "pcb") return filterItems({doc: d.id, net: name, fields: o.fields}).map(i => pick(i, o.fields));
        const c = A.connectivity(d, defs()), ids = new Set();
        for (const [k, n] of c.byPin) if (n === name) ids.add(k.split("/")[0]);
        for (const [k, n] of c.byWire) if (n === name) ids.add(k);
        return d.items.filter(i => ids.has(i.id) || (i.kind === "netlabel" && i.text === name)).map(i => pick(i, o.fields));
      }],
      "selection.get": [R, () => [...(host.selection?.() || [])]],
      "selection.items": [R, (o = {}) => { const ids = new Set(host.selection?.() || []); return docOf().items.filter(i => ids.has(i.id)).map(i => pick(i, o.fields)); }],
      "selection.set": [U, ids => { if (!Array.isArray(ids)) throw Error("selection.set expects a list of ids."); host.select?.(ids.filter(id => typeof id === "string")); return true; }],
      "layers.list": [R, (o = {}) => {
        const d = docOf(o.doc);
        if (d.kind !== "pcb") return {copper: [], other: []};
        const copper = globalThis.AtriumCanvas?.routingLayers ? AtriumCanvas.routingLayers(d, defs()) : [...new Set(["Top", ...d.items.map(i => i.layer).filter(l => /^(Top|Bottom|Inner \d+)$/.test(l || "")), "Bottom"])];
        const other = [...new Set(d.items.map(i => i.layer).filter(l => l && !copper.includes(l)))].sort();
        return {copper, other};
      }],
      "units.get": [N, () => A.units.normal(host.units?.() ?? project().units)],
      "query.spatial": [R, (bounds, o = {}) => {
        if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) throw Error("query.spatial expects [x0, y0, x1, y1] in mm.");
        return filterItems({...o, bounds}).map(i => pick(i, o.fields));
      }],
      "query.connectivity": [R, (o = {}) => {
        const d = docOf(o.doc);
        if (d.kind === "pcb") return withFeature("connectivity", f => toPlain(f(d, defs())));
        const c = A.connectivity(d, defs());
        return {nets: c.nets, byPin: Object.fromEntries(c.byPin), byWire: Object.fromEntries(c.byWire)};
      }],
      "rules.query": [R, (type, o = {}) => withFeature("rules", f => toPlain(f(board(o.doc), type, o, {project: project()})))],
      "rules.get": [R, (o = {}) => { const d = docOf(o.doc); return globalThis.AtriumRules?.stored(d, project()) || globalThis.AtriumRules?.defaults() || null; }],
      "transaction.commit": [E, commit],
      "proposals.draft": [E, draft],
      "proposals.review": [E, reviewDraft],
      "proposals.discard": [N, forget],
      "proposals.submit": [E, submit],
      "proposals.propose": [E, propose],
      "proposals.fields": [N, () => clone(PROPOSE_FIELDS)],
      "motion.inspect": [MR, inspectMotion],
      "commands.register": [UC, (id, meta = {}) => {
        if (id.startsWith("butter.")) throw Error("Butter command IDs belong to Waffle.");
        const prior = registry.commands.get(id);
        if (prior && prior.owner !== ext.id) throw Error("Command " + id + " belongs to " + prior.owner + ".");
        // A command declared in the manifest keeps its declared title, `when` and place.
        registry.commands.set(id, {...prior, id, owner: ext.id, title: String(meta.title || prior?.title || id), when: meta.when ?? prior?.when ?? "",
          handler: options.localCommands?.get(id) || null});
        registry.emit("commandsChanged", id);
        return true;
      }],
      "commands.unregister": [N, id => { if (registry.commands.get(id)?.owner === ext.id) registry.commands.delete(id); return true; }],
      "commands.execute": [UC, (id, args = []) => {
        if (id.startsWith("butter.")) {
          const butter = globalThis.AtriumButter;
          if (!can("read:project")) throw Error(ext.id + " needs read:project permission for Butter commands.");
          if (!butter) throw Error("This Butter command is unavailable.");
          const {spec} = butter.resolve(id, "extension");
          if (spec.kind === "edit" && !allowed("edit"))
            throw Error("This Butter command is outside the extension's command permissions.");
          return butter.run(id, args[0], {source:"extension"});
        }
        if (id.startsWith("waffle.") || id.startsWith("atrium.")) {
          const name = id.slice(7);
          if (!BUILTIN.includes(name)) throw Error("Unknown command " + id + ".");
          // Extensions may drive the view, never editor actions that edit, open or save outside proposals.
          if (!options.trusted && !VIEW_COMMANDS.has(name)) throw Error(id + " is not available to extensions.");
          if (!host.runAction) throw Error("Editor commands are unavailable in headless mode.");
          host.runAction(name, ...args);
          return true;
        }
        const c = registry.commands.get(id);
        if (c?.handler) return c.handler(...args);
        if (options.dispatch) return options.dispatch(id, args);
        throw Error("Unknown command " + id + ".");
      }],
      "events.subscribe": [N, name => {
        if (!["panelShown", "panelHidden", "settingsChanged"].includes(String(name)) && !can("read:project")) throw Error(ext.id + " needs the read:project permission for design events."); options.subscribe?.(String(name)); return true; }],
      "commands.list": [N, () => [...BUILTIN.map(b => ({id: "waffle." + b, title: b, owner: "waffle"})),
        ...(can("read:project") ? globalThis.AtriumButter?.list("extension").filter(c => c.kind === "read" || allowed("edit")) ?? [] : []),
        ...[...registry.commands.values()].map(c => ({id: c.id, title: c.title, owner: c.owner}))]],
      "ui.showMessage": [U, (text, o = {}) => { const t = String(text); if (ui) ui.message(ext, t, o); else host.info?.(t); return true; }],
      "ui.setStatus": [UC, (id, item) => (ui ? ui.status(ext, String(id), item) : true)],
      "ui.clearStatus": [UC, id => (ui ? ui.status(ext, String(id), null) : true)],
      "ui.registerPanel": [UP, (id, o = {}) => (ui ? ui.panel(ext, String(id), o) : true)],
      "ui.setPanel": [UP, (id, view) => (ui ? ui.render(ext, String(id), view) : true)],
      "ui.showPanel": [UP, id => (ui ? ui.show(ext, String(id), true) : true)],
      "ui.closePanel": [UP, id => (ui ? ui.show(ext, String(id), false) : true)],
      "ui.addMenuItem": [UC, item => (ui ? ui.menu(ext, item) : true)],
      "ui.addActiveBarButton": [UC, item => (ui ? ui.menu(ext, {...item, menu: "activeBar"}) : true)],
      "ui.showInputBox": [U, (o = {}) => (ui ? ui.input(ext, o) : o.value ?? null)],
      "ui.showQuickPick": [U, (items, o = {}) => (ui ? ui.pick(ext, items, o) : null)],
      "ui.confirm": [U, (text, o = {}) => (ui ? ui.confirm(ext, String(text), o) : false)],
      "ui.locate": [U, id => { host.locate?.(id); return true; }],
      "ui.decorations.set": [UD, (doc, items) => decorate(doc, items)],
      "ui.decorations.clear": [UD, doc => { const id = doc == null ? null : docOf(doc).id; if (ui?.decorate) ui.decorate(ext, id, null); return true; }],
      "storage.get": [N, key => store.get(String(key)) ?? null],
      "storage.set": [N, (key, value) => {
        if (!jsonSafe(value) || JSON.stringify(value).length > 262144) throw Error("Storage values must be JSON data under 256 KB.");
        store.set(String(key), clone(value)); store.flush?.(); return true;
      }],
      "storage.delete": [N, key => { store.delete(String(key)); store.flush?.(); return true; }],
      "storage.keys": [N, () => [...store.keys()]],
      "settings.get": [N, key => { const s = options.settings?.() || {}; return key == null ? s : s[key] ?? null; }],
      "files.export": [F, (name, text) => {
        if (!host.exportFile) throw Error("Exporting files is unavailable here.");
        if (typeof name !== "string" || !(typeof text === "string" || ArrayBuffer.isView(text))) throw Error("files.export expects a file name and text.");
        return host.exportFile(name, text);
      }],
      "netlist": [R, (o = {}) => netlist(o)],
      "files.pickText": [U, pickText],
      "simulation.get": [R, simulationGet],
      "simulation.model": [R, simulationModel],
      "simulation.channel": [R, simulationChannel],
      "simulation.fieldSolve": [R, simulationFieldSolve],
      "assets.read": [N, path => { if (!options.assets) throw Error("This context has no bundled assets."); return options.assets(String(path)); }],
      "external.tools": [X, () => (options.external ? options.external.tools(ext) : {available: false, reason: EXTERNAL_UNAVAILABLE, tools: []})],
      "external.run": [X, (tool, o = {}) => { const run = cleanExternalRun(tool, o); if (!options.external) throw Error(EXTERNAL_UNAVAILABLE); return options.external.run(ext, run); }],
      "external.cancel": [X, runId => (options.external ? options.external.cancel(ext, String(runId ?? "")) : false)],
      "external.configure": [X, tool => { if (!options.external) throw Error(EXTERNAL_UNAVAILABLE); return options.external.configure(ext, String(tool ?? "")); }],
      "features.list": [N, () => Object.keys(modules).filter(k => modules[k]() || globalThis.AtriumLazy?.modules?.().includes(FEATURE_GLOBALS[k]))],
      "bom": [R, (settings = {}) => withFeature("bom", f => toPlain(f(project(), settings)))],
      "drc": [R, runDRC],
      "erc": [R, (o = {}) => withFeature("erc", f => toPlain(f(project(), o)))],
      "annotate.plan": [R, (o = {}) => withFeature("annotate", f => toPlain(f(project(), o)))],
      "annotate.apply": [E, (o = {}) => runFeature("annotate.apply", o)],
      "pour": [E, (o = {}) => runFeature("pour", o)],
      "route": [E, (o = {}) => runFeature("route", o)],
      "fanout": [E, (o = {}) => runFeature("fanout", o)],
      "autoplace": [E, (o = {}) => runFeature("autoplace", o)],
      "routePlan": [E, (o = {}) => runFeature("routePlan", o)],
      "planes": [E, (o = {}) => runFeature("planes", o)],
      "length": [R, (o = {}) => withFeature("length", f => {
        const d = board(o.doc), opts = {...o};
        delete opts.doc;
        const r = toPlain(f(d, defs(), opts));
        // Per-segment detail is large; it is returned only on request.
        const rows = Array.isArray(r) ? r.map(e => (Array.isArray(e) ? {net: e[0], ...e[1]} : {...e, net: e.net ?? e.key})) : r;
        if (Array.isArray(rows) && !o.segments) for (const e of rows) if (Array.isArray(e.segments)) { e.segmentCount = e.segments.length; delete e.segments; }
        return Array.isArray(rows) && o.nets ? rows.filter(e => o.nets.includes(e.net)) : rows;
      })],
      "stackup": [R, (o = {}) => toPlain(globalThis.AtriumStackup?.stored?.(board(o.doc)) ?? null)],
      "outputs.build": [R, (o = {}) => withFeature("outputs", build => { const r = build(project(), board(o.doc).id, o); return {name: r.name, warnings: toPlain(r.warnings), files: r.files.map(f => ({name: f.name, kind: f.kind, title: f.title, content: f.content}))}; })],
      "outputs.gerber": [R, (o = {}) => then(handlers["outputs.build"][1](o), r => { r.files = r.files.filter(f => /gerber|copper|mask|paste|silk|outline|mech/i.test(f.kind + " " + f.name) && !/drill|\.drl|\.xln/i.test(f.name)); return r; })],
      "outputs.drill": [R, (o = {}) => then(handlers["outputs.build"][1](o), r => { r.files = r.files.filter(f => /drill|\.drl|\.xln/i.test(f.kind + " " + f.name)); return r; })]
    };
    // `inProcess` callers get copies so a script can never mutate the live model.
    function call(method, args = [], inProcess = true) {
      const h = handlers[method];
      if (!h) throw Error("Unknown API method " + method + ".");
      if (options.deadline && Date.now() > options.deadline) throw Error("The script exceeded its time limit.");
      const [perm, fn] = h;
      if (method === "proposals.review" && !allowed(perm)) { forget(args[0]); return {applied:0, revoked:true}; }
      if (!allowed(perm)) throw Error(ext.id + " needs the " + (perm === "edit" ? "propose:edits or write:edits" : perm === "ui" ? "ui:panel or ui:command" : perm) + " permission for " + method + ".");
      const value = fn(...(Array.isArray(args) ? args : [args]));
      if (!inProcess) return value;
      return value && typeof value.then === "function" ? value.then(clone) : clone(value);
    }
    const env = {
      newId: A.id, commands: options.localCommands || new Map(), listeners: new Map(),
      log: (level, a) => options.log ? options.log(level, a) : globalThis.console?.log?.(...a),
      subscribe: name => { call("events.subscribe", [name]); return registry.on(name, payload => { for (const fn of env.listeners.get(name) || []) fn(clone(payload)); }); }
    };
    if (!options.localCommands) options.localCommands = env.commands;
    const api = facade((method, args) => call(method, args, true), env);
    return {api, call, registry, handlers, env};
  }

  // ------------------------------------------------------------ headless host
  // Wraps a project for JavaScriptCore or Node: edits are applied to this object,
  // each edit is atomic (rolled back on error) and counted as one step.
  function headless(project, options = {}) {
    const A = globalThis.Atrium;
    let p = A.validate(typeof project === "string" ? JSON.parse(project) : project), rev = 0, selection = [...(options.selection || [])];
    let current = options.documentId && p.documents.some(d => d.id === options.documentId) ? options.documentId : (p.documents.find(d => d.kind === "pcb") || p.documents[0]).id;
    const steps = [];
    const host = {
      project: () => p, documentId: () => current, revision: () => rev, selection: () => selection,
      select: ids => { selection = [...ids]; },
      activate: id => { current = id; },
      edit(fn, label = "Edit") { const before = JSON.stringify(p); try { fn(); } catch (e) { p = JSON.parse(before); throw e; } rev++; steps.push(label); },
      amend(fn, label = "Edit") { const before = JSON.stringify(p); try { fn(); } catch (e) { p = JSON.parse(before); throw e; } rev++; steps[steps.length - 1] += " + " + label; },
      info: options.info || (() => {}),
      units: () => p.units
    };
    const made = create(host, options);
    return {...made, host, steps, get project() { return p; }};
  }

  // Documentation table: what each method needs. Used by README, MCP and tests.
  function describe() {
    const probe = create({project: () => Atrium.project("x"), documentId: () => null, edit: f => f()});
    return Object.entries(probe.handlers).map(([method, [perm]]) => ({method, permission: perm || "none"}));
  }

  return Object.freeze({VERSION, BUILTIN, PERMISSIONS, isManifestPermission, isNetworkPermission, describePermission, SCRIPT_PERMISSIONS, VIEW_COMMANDS, MAX_ITEMS, PROPOSE_FIELDS, PROPOSE_LIMITS, DECORATION_LIMITS, cleanDecorations, scrubText, EXTERNAL_LIMITS, cleanExternalRun, facade, create, createRegistry, headless, applyOps, describe, toPlain, jsonSafe});
})();
