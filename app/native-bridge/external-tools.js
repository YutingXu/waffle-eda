"use strict";
// AtriumExternalTools: programs the user installed (LTspice, ngspice, ...) that connector extensions
// run through the run:external permission, VS Code style (like an interpreter path):
//
//   - The USER chooses each program in Preferences › External Tools: Choose… opens the system file
//     picker, and a detected install path (CANDIDATES, checked by the desktop host) is used only after
//     the host's own confirmation dialog. Nothing is downloaded, and nothing is chosen silently.
//   - The desktop host keeps the chosen paths. Pages and extensions name a tool by id; they never pass
//     a path to run. The first run shows the full command in a native approval dialog; the host
//     remembers Allow for that extension version (id@sha256 content hash), tool and resolved program,
//     for runs within the tool's declared argument template (contributes.externalTools[].args plus the
//     run's own file names). Any other argument asks again for that exact command (docs/extensions.md).
//   - The host runs it with the extension's arguments as a list (no shell), in a new temporary folder
//     holding the extension's input files, with a minimal environment, a timeout, caps on stdout,
//     stderr and output files, and cancellation; then deletes the folder.
//   - In the browser build there is no host: tools report unavailable and runs fail with a message.
//
// Host bridge (native/bridge.js → AtriumHost): externalToolList(), externalToolProbe(paths),
// externalToolChoose({id, name, path?}), externalToolForget(id), externalRun(request), externalCancel(key).
// The bridge sends the tool id to the host as toolId: "id" on the wire is the request's own number.
globalThis.AtriumExternalTools = (() => {
  // Common install locations, offered for the user to confirm. Never used without confirmation.
  const CANDIDATES = Object.freeze({
    ngspice: {macos: ["/opt/homebrew/bin/ngspice", "/usr/local/bin/ngspice", "/opt/local/bin/ngspice"],
      linux: ["/usr/bin/ngspice", "/usr/local/bin/ngspice", "/snap/bin/ngspice"],
      windows: ["C:\\Program Files\\Spice64\\bin\\ngspice_con.exe", "C:\\Spice64\\bin\\ngspice_con.exe"]},
    ltspice: {macos: ["/Applications/LTspice.app"],
      linux: [],
      windows: ["C:\\Program Files\\ADI\\LTspice\\LTspice.exe", "C:\\Program Files\\LTC\\LTspiceXVII\\XVIIx64.exe"]}
  });
  const UNAVAILABLE = "Running external tools needs the Waffle desktop app.";
  const H = () => globalThis.AtriumHost;
  const available = () => typeof H()?.externalRun === "function" && typeof H()?.externalToolList === "function";
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
    const clean = String(text || "").replace(/[^A-Za-z0-9+/]/g, ""), out = new Uint8Array(Math.floor(clean.length * 3 / 4));
    let o = 0;
    for (let i = 0; i < clean.length; i += 4) {
      const n = B64.indexOf(clean[i]) << 18 | B64.indexOf(clean[i + 1]) << 12 | (B64.indexOf(clean[i + 2]) & 63) << 6 | (B64.indexOf(clean[i + 3]) & 63);
      out[o++] = n >> 16 & 255; if (i + 2 < clean.length) out[o++] = n >> 8 & 255; if (i + 3 < clean.length) out[o++] = n & 255;
    }
    return out.subarray(0, o);
  }
  const bytesOf = v => typeof v === "string" ? new TextEncoder().encode(v) : v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  const text = u8 => new TextDecoder().decode(u8);

  async function list() {
    if (!available()) return {available: false, platform: null, tools: {}};
    const r = await H().externalToolList();
    return {available: true, platform: r?.platform || null, tools: r?.tools && typeof r.tools === "object" ? r.tools : {}};
  }
  // What an extension may know: its declared tools and whether each is set. Never the path.
  async function status(declared) {
    const l = await list();
    return {available: l.available, reason: l.available ? null : UNAVAILABLE,
      tools: declared.map(t => ({id: t.id, name: t.name, configured: !!l.tools[t.id]?.path}))};
  }
  async function candidates(id) {
    const l = await list(), paths = (CANDIDATES[id]?.[l.platform] || []).slice(0, 16);
    if (!l.available || !paths.length || typeof H().externalToolProbe !== "function") return [];
    const found = await H().externalToolProbe(paths);
    return Array.isArray(found) ? found.filter(p => paths.includes(p)) : [];
  }
  const runs = new Map();
  // run: the request is already checked by AtriumAPI.cleanExternalRun; extensions.js adds the
  // tool's name, the extension and a run key unique to the extension.
  async function run(r) {
    if (!available()) throw Error(UNAVAILABLE);
    const l = await list();
    if (r.cancelled?.()) return {exitCode: null, signal: null, timedOut: false, cancelled: true, durationMs: 0, truncated: false, stdout: "", stderr: "", files: []};
    if (!l.tools[r.tool]?.path) throw Error(r.toolName + " is not set up. Choose it in Preferences \u203a External Tools.");
    const files = Object.entries(r.files || {}).map(([name, v]) => ({name, data: toBase64(bytesOf(v))}));
    runs.set(r.runKey, true);
    try {
      const out = await H().externalRun({tool: r.tool, toolName: r.toolName, extension: r.extension, extensionName: r.extensionName,
        extensionHash: r.extensionHash, argTemplate: r.argTemplate || [], args: r.args, files,
        outputs: r.outputs, timeoutMs: r.timeoutMs, maxOutputBytes: r.maxOutputBytes, runId: r.runKey});
      if (out?.denied) throw Object.assign(Error("You did not allow " + r.extensionName + " to run " + r.toolName + "."), {denied: true});
      const decode = f => { const u8 = fromBase64(f.data); return r.encoding === "binary" ? {name: String(f.name), size: u8.length, bytes: u8.slice().buffer} : {name: String(f.name), size: u8.length, text: text(u8)}; };
      return {exitCode: Number.isInteger(out?.exitCode) ? out.exitCode : null, signal: out?.signal ?? null, timedOut: !!out?.timedOut, cancelled: !!out?.cancelled,
        durationMs: Number(out?.durationMs) || 0, truncated: !!out?.truncated, stdout: text(fromBase64(out?.stdout)), stderr: text(fromBase64(out?.stderr)),
        files: (Array.isArray(out?.files) ? out.files : []).map(decode)};
    } finally { runs.delete(r.runKey); }
  }
  function cancel(key) {
    if (!runs.has(key) || typeof H()?.externalCancel !== "function") return false;
    H().externalCancel(key); return true;
  }
  async function configure(tool) {
    const P = globalThis.AtriumPrefs || await globalThis.AtriumLazy?.need?.("AtriumPrefs");
    P?.open?.("external-tools");
    return !!P;
  }

  // ------------------------------------------------------------ preferences
  // Every tool an installed extension declares (contributes.externalTools), plus any already chosen.
  function declaredTools() {
    const X = globalThis.AtriumExtensions, out = new Map();
    for (const e of X?.list?.() || []) for (const t of e.externalTools || []) {
      const row = out.get(t.id) || {id: t.id, name: t.name, description: t.description || "", homepage: t.homepage || "", by: []};
      row.by.push(e.name || e.id); out.set(t.id, row);
    }
    return out;
  }
  function prefsPage(P) {
    P.registerPage({id: "external-tools", title: "External Tools", order: 5.4, keywords: "external tools programs ltspice ngspice simulator path executable connector run",
      render(c, api) {
        const g = api.group(c, "Programs extensions may run");
        if (!available()) { const row = api.el("div", "prf-row"); row.dataset.search = "external tools desktop"; row.append(api.el("small", "prf-help", UNAVAILABLE)); g.append(row); return; }
        const note = api.el("small", "prf-help", "Choose programs and approve their commands before they run.");
        note.title = "You choose each executable. New extension versions and undeclared arguments ask again.";
        const intro = api.el("div", "prf-row prf-link"); intro.dataset.search = "external tools approve command"; intro.append(note); g.append(intro);
        const body = api.el("div", "prf-ext-tools"); g.append(body);
        const paint = async () => {
          const l = await list(), tools = declaredTools();
          for (const id of Object.keys(l.tools)) if (!tools.has(id)) tools.set(id, {id, name: l.tools[id].name || id, description: "", by: []});
          body.replaceChildren();
          if (!tools.size) { body.append(api.el("small", "prf-help", "No installed extension uses an external program.")); return; }
          for (const t of tools.values()) {
            const row = api.el("div", "prf-row prf-link"); row.dataset.search = "external " + t.id + " " + t.name;
            const path = l.tools[t.id]?.path;
            row.append(api.el("strong", null, t.name), api.el("small", "prf-help", (path ? path : "Not set") + (t.by.length ? " \u00b7 used by " + t.by.join(", ") : "") + (t.description ? " \u00b7 " + t.description : "")));
            const say = e => { row.append(api.el("small", "prf-help", e.message)); };
            const actions = api.el("div", "prf-inline-actions");
            actions.append(api.button("Choose\u2026", () => H().externalToolChoose({id: t.id, name: t.name}).then(paint, say), "prf-button"));
            if (path) actions.append(api.button("Forget", () => H().externalToolForget(t.id).then(paint, say), "prf-button"));
            if (!path) for (const p of await candidates(t.id).catch(() => []))
              actions.append(api.button("Use " + p, () => H().externalToolChoose({id: t.id, name: t.name, path: p}).then(paint, say), "prf-button"));
            row.append(actions); body.append(row);
          }
        };
        paint().catch(e => body.append(api.el("small", "prf-help", e.message)));
      }});
  }
  // Loaded with AtriumExtensions; prefs.js registers the page when it loads after this file.
  if (globalThis.AtriumPrefs?.registerPage) prefsPage(AtriumPrefs);

  return Object.freeze({CANDIDATES, UNAVAILABLE, prefsPage, available, list, status, candidates, run, cancel, configure, toBase64, fromBase64});
})();
