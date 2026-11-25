"use strict";
// Browse Extensions: reads a Waffle extension index (docs/extension-registry.md), shows each
// extension's permissions before anything is downloaded, verifies the package's SHA-256
// against the index, and installs through AtriumExtensions.install, which shows the usual
// permission prompt. Lazy: opened from Tools › Extensions… › Browse….
//
// Off by default. Until the user sets a registry URL (or opens an index file), this module
// makes no request at all, and loading it never makes one. With a URL set it fetches only
// that index (when the view opens or on Refresh) and the packages the user installs.
// Requests omit credentials and referrer and bypass the cache.
//
// It does not touch the extension sandbox: installed code runs exactly like any other
// user-installed extension (own worker, CSP default-src 'none', permission grants).
globalThis.AtriumExtensionRegistry = (() => {
  const CONFIG = "atrium.extensions.registry", PROVENANCE = "atrium.extensions.registry.installed";
  const FORMAT = "atrium-extension-index", VERSION = 1;
  const MAX_INDEX = 4e6, MAX_PACKAGE = 32e6, MAX_ENTRIES = 5000, MAX_PERMISSIONS = 32;
  const ID = /^[a-z0-9][a-z0-9_-]*(\.[a-z0-9][a-z0-9_-]*)+$/i, SEMVER = /^\d+\.\d+\.\d+([-+][\w.-]+)?$/, HEX64 = /^[0-9a-f]{64}$/;
  const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

  // Injection points for tests; the editor uses the defaults.
  const deps = {
    fetch: (...a) => globalThis.fetch(...a),
    storage: {
      get(k, fallback) { try { const v = globalThis.localStorage?.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; } },
      set(k, v) { try { globalThis.localStorage?.setItem(k, JSON.stringify(v)); } catch {} }
    },
    extensions: () => globalThis.AtriumExtensions,
    document: () => globalThis.document
  };
  let state = {index: null, origin: null, error: null}; // origin: the index URL, or "file" for a local index
  function configure(o = {}) { for (const k of Object.keys(deps)) if (o[k]) deps[k] = typeof deps[k] === "function" && typeof o[k] !== "function" ? () => o[k] : o[k]; state = {index: null, origin: null, error: null}; }

  // ------------------------------------------------------------------ URLs and settings
  // https anywhere; http only to this computer (a local test server). No credentials in URLs.
  // A small strict parser of its own (no URL dependency), so the editor, workers and tests agree.
  function parseUrl(text, what) {
    const bad = () => Error("The " + what + " is not a valid address.");
    const m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^#]*)(?:#.*)?$/i.exec(String(text).trim());
    if (!m) throw bad();
    if (m[2].includes("@")) throw Error("The " + what + " must not contain a user name or password.");
    const h = /^(\[[0-9a-f:.]+\]|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/i.exec(m[2]);
    if (!h || /[\s\\<>"]/.test(m[3]) || (m[3] && !/^[/?]/.test(m[3]))) throw bad();
    const protocol = m[1].toLowerCase() + ":", hostname = h[1].toLowerCase(), port = h[5] || "";
    const origin = protocol + "//" + hostname + (port ? ":" + port : ""), path = m[3].startsWith("/") ? m[3] : "/" + m[3];
    return {protocol, hostname, port, origin, path, href: origin + path};
  }
  function checkUrl(text, what = "URL") {
    const u = parseUrl(text, what);
    if (u.protocol === "https:") return u;
    if (u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname)) return u;
    throw Error("The " + what + " must use https:// (http:// only for localhost).");
  }
  // A download address relative to the index: "pkg.zip", "../x/pkg.zip" or "/x/pkg.zip".
  function resolveUrl(ref, base) {
    ref = String(ref);
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || !base) return ref;
    const b = parseUrl(base, "registry URL");
    if (ref.startsWith("//")) return b.protocol + ref;
    const [pathPart, query = ""] = (ref.startsWith("/") ? ref : b.path.split("?")[0].replace(/[^/]*$/, "") + ref).split(/\?(.*)/s);
    const out = [];
    for (const seg of pathPart.split("/").slice(1)) { if (seg === "..") out.pop(); else if (seg !== ".") out.push(seg); }
    return b.origin + "/" + out.join("/") + (query ? "?" + query : "");
  }
  const config = () => { const c = deps.storage.get(CONFIG, {}); return {url: typeof c?.url === "string" ? c.url : ""}; };
  function setUrl(url) {
    url = String(url || "").trim();
    if (url) checkUrl(url, "registry URL");
    deps.storage.set(CONFIG, {url});
    state = {index: null, origin: null, error: null};
    return config();
  }
  const enabled = () => !!config().url;

  // ------------------------------------------------------------------ the index
  function validateIndex(raw, base) {
    const fail = msg => { throw Error("Invalid extension index: " + msg); };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("expected an object.");
    if (raw.format !== FORMAT) fail("format must be \"" + FORMAT + "\".");
    if (raw.version !== VERSION) fail("version " + raw.version + " is not supported (this editor reads " + VERSION + ").");
    if (!Array.isArray(raw.extensions)) fail("extensions must be a list.");
    if (raw.extensions.length > MAX_ENTRIES) fail("more than " + MAX_ENTRIES + " extensions.");
    const str = (v, max) => typeof v === "string" && v.length <= max;
    const seen = new Set();
    const entries = raw.extensions.map((x, n) => {
      const at = "extensions[" + n + "]";
      if (!x || typeof x !== "object" || Array.isArray(x)) fail(at + " must be an object.");
      if (!str(x.id, 80) || !ID.test(x.id)) fail(at + ".id must look like publisher.name.");
      if (!str(x.name, 120) || !x.name.trim()) fail(at + ".name is required.");
      if (!str(x.version, 64) || !SEMVER.test(x.version)) fail(at + ".version must be semantic, e.g. 1.0.0.");
      if (!str(x.publisher, 120) || !x.publisher.trim()) fail(at + ".publisher is required.");
      if (x.apiVersion !== AtriumAPI.VERSION) fail(at + ".apiVersion must be " + AtriumAPI.VERSION + ".");
      if (seen.has(x.id + "@" + x.version)) fail(at + " repeats " + x.id + " " + x.version + ".");
      seen.add(x.id + "@" + x.version);
      if (!Array.isArray(x.permissions) || x.permissions.length > MAX_PERMISSIONS || !x.permissions.every(AtriumAPI.isManifestPermission) ||
          new Set(x.permissions).size !== x.permissions.length) fail(at + ".permissions must list Waffle permissions, each once.");
      if (typeof x.sha256 !== "string" || !HEX64.test(x.sha256)) fail(at + ".sha256 must be 64 lowercase hex digits.");
      if (!str(x.download, 2000)) fail(at + ".download is required.");
      let download;
      try { download = checkUrl(resolveUrl(x.download, base), "download URL").href; } catch (e) { fail(at + ".download: " + e.message); }
      if (x.source != null) { if (!str(x.source, 2000)) fail(at + ".source must be a URL."); try { checkUrl(x.source, "source URL"); } catch (e) { fail(at + ".source: " + e.message); } }
      if (x.size != null && (!Number.isInteger(x.size) || x.size <= 0 || x.size > MAX_PACKAGE)) fail(at + ".size must be a byte count up to " + MAX_PACKAGE / 1e6 + " MB.");
      if (x.description != null && !str(x.description, 2000)) fail(at + ".description is too long.");
      if (x.license != null && !str(x.license, 120)) fail(at + ".license is too long.");
      if (x.signature != null && (typeof x.signature !== "object" || Array.isArray(x.signature))) fail(at + ".signature must be null or an object.");
      if (x.bundleSha256 != null && (typeof x.bundleSha256 !== "string" || !HEX64.test(x.bundleSha256))) fail(at + ".bundleSha256 must be 64 lowercase hex digits.");
      return {id: x.id, name: x.name.trim(), version: x.version, publisher: x.publisher.trim(), apiVersion: x.apiVersion, permissions: [...x.permissions],
        sha256: x.sha256, download, source: x.source ?? null, size: x.size ?? null, description: x.description ?? "", license: x.license ?? null,
        signature: x.signature ?? null, bundleSha256: x.bundleSha256 ?? null};
    });
    return {name: typeof raw.name === "string" ? raw.name.slice(0, 120) : "", updated: typeof raw.updated === "string" ? raw.updated.slice(0, 40) : "", extensions: entries};
  }
  // The newest version of each extension, by semantic version.
  function latest(entries) {
    const cmp = (a, b) => { const pa = a.split(/[-+]/)[0].split(".").map(Number), pb = b.split(/[-+]/)[0].split(".").map(Number); for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]; return (a.includes("-") ? 0 : 1) - (b.includes("-") ? 0 : 1); };
    const best = new Map();
    for (const e of entries) if (!best.has(e.id) || cmp(e.version, best.get(e.id).version) > 0) best.set(e.id, e);
    return [...best.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  // ------------------------------------------------------------------ network (opt-in only)
  const REQUEST = {method: "GET", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer", mode: "cors"};
  async function readCapped(res, cap, what) {
    const declared = Number(res.headers?.get?.("content-length"));
    if (declared > cap) throw Error("The " + what + " is larger than " + cap / 1e6 + " MB.");
    if (res.body?.getReader) {
      const reader = res.body.getReader(), parts = [];
      let n = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        if ((n += value.length) > cap) { reader.cancel?.().catch?.(() => {}); throw Error("The " + what + " is larger than " + cap / 1e6 + " MB."); }
        parts.push(value);
      }
      const out = new Uint8Array(n);
      let o = 0;
      for (const p of parts) { out.set(p, o); o += p.length; }
      return out;
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.length > cap) throw Error("The " + what + " is larger than " + cap / 1e6 + " MB.");
    return buf;
  }
  async function get(url, cap, what, redirect) {
    const res = await deps.fetch(url, {...REQUEST, redirect});
    if (!res || !res.ok) throw Error("The " + what + " could not be downloaded" + (res?.status ? " (HTTP " + res.status + ")" : "") + ".");
    return readCapped(res, cap, what);
  }
  // Fetch the configured index. Without a configured URL this returns at once and fetches nothing.
  async function refresh() {
    const {url} = config();
    if (!url) { state = {index: null, origin: null, error: null}; return {configured: false, index: null}; }
    try {
      const u = checkUrl(url, "registry URL");
      const bytes = await get(u.href, MAX_INDEX, "extension index", "error");
      state = {index: validateIndex(JSON.parse(new TextDecoder().decode(bytes)), u.href), origin: u.href, error: null};
    } catch (e) { state = {index: null, origin: url, error: e.message}; throw e; }
    return {configured: true, index: state.index};
  }
  // A local index file (no network): download URLs in it must be absolute.
  function loadIndexText(text) {
    state = {index: validateIndex(JSON.parse(String(text)), null), origin: "file", error: null};
    return state.index;
  }

  // ------------------------------------------------------------------ verification
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,
    0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,
    0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,
    0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
  // SHA-256 of raw bytes, in pure JS (works without a secure context, in workers and tests).
  function sha256(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), n = data.length, blocks = Math.ceil((n + 9) / 64) * 64;
    const buf = new Uint8Array(blocks); buf.set(data); buf[n] = 0x80;
    const dv = new DataView(buf.buffer); dv.setUint32(blocks - 4, n * 8 >>> 0); dv.setUint32(blocks - 8, Math.floor(n / 0x20000000));
    const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]), w = new Uint32Array(64);
    const rot = (x, k) => (x >>> k) | (x << (32 - k));
    for (let off = 0; off < blocks; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) w[i] = (rot(w[i - 15], 7) ^ rot(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 16] + (rot(w[i - 2], 17) ^ rot(w[i - 2], 19) ^ (w[i - 2] >>> 10)) + w[i - 7];
      let [a, b, c, d, e, f, g, k] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = k + (rot(e, 6) ^ rot(e, 11) ^ rot(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i] | 0;
        const t2 = (rot(a, 2) ^ rot(a, 13) ^ rot(a, 22)) + ((a & b) ^ (a & c) ^ (b & c)) | 0;
        k = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
      }
      h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += k;
    }
    return Array.from(h, x => x.toString(16).padStart(8, "0")).join("");
  }
  // Bytes -> extension files, refusing anything that is not exactly what the index describes.
  // The digest is checked before the package is parsed at all.
  async function verify(entry, bytes) {
    const X = deps.extensions();
    if (!X) throw Error("Extensions are not available in this build.");
    if (entry.size != null && bytes.length !== entry.size) throw Error(entry.name + ": the package is " + bytes.length + " bytes; the index says " + entry.size + ". Nothing was installed.");
    const digest = sha256(bytes);
    if (digest !== entry.sha256) throw Error(entry.name + ": SHA-256 mismatch. The package does not match the index (expected " + entry.sha256.slice(0, 12) + "…, got " + digest.slice(0, 12) + "…). Nothing was installed.");
    const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
    const file = {name: zip ? "package.zip" : "package.waffle-extension", arrayBuffer: async () => bytes.slice().buffer, text: async () => new TextDecoder().decode(bytes)};
    const files = await X.packageFromFiles([file]);
    const manifest = JSON.parse(files["waffle-extension.json"]);
    X.validateManifest(manifest, files);
    if (manifest.id !== entry.id || manifest.version !== entry.version) throw Error(entry.name + ": the package is " + manifest.id + " " + manifest.version + ", not " + entry.id + " " + entry.version + ". Nothing was installed.");
    const a = [...(manifest.permissions || [])].sort(), b = [...entry.permissions].sort();
    if (a.length !== b.length || a.some((p, i) => p !== b[i])) throw Error(entry.name + ": the package asks for permissions the index does not list (" + a.join(", ") + "). Nothing was installed.");
    // Optional: the canonical bundle digest Waffle binds project trust to (id@sha256), over the
    // stored code files (.js, .json, .wasm) without the manifest, as "Add to project" computes it.
    if (entry.bundleSha256) {
      const code = Object.fromEntries(Object.entries(files).filter(([k]) => k !== "waffle-extension.json" && /\.(js|json|wasm)$/.test(k)));
      if (X._digest(manifest, code) !== "sha256:" + entry.bundleSha256) throw Error(entry.name + ": the bundle digest does not match the index. Nothing was installed.");
    }
    return files;
  }
  // Download (or take the given bytes), verify, then install through the normal flow,
  // which shows the permission prompt and stores the grant for this exact bundle.
  async function install(entry, {bytes} = {}) {
    if (!bytes) {
      if (!state.index) throw Error("Load an extension index first.");
      bytes = await get(checkUrl(entry.download, "download URL").href, Math.min(MAX_PACKAGE, entry.size || MAX_PACKAGE), "package", "follow");
    }
    const files = await verify(entry, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    const record = await deps.extensions().install(files, {origin: "user"});
    const prov = deps.storage.get(PROVENANCE, {});
    prov[entry.id] = {version: entry.version, sha256: entry.sha256, index: state.origin, source: entry.source, installed: new Date().toISOString()};
    deps.storage.set(PROVENANCE, prov);
    return record;
  }
  const provenance = id => deps.storage.get(PROVENANCE, {})[id] || null;

  // ------------------------------------------------------------------ the view
  let view = null;
  function open(opts = {}) {
    const doc = deps.document();
    if (!doc) return null;
    if (view?.dialog.isConnected) { view.dialog.showModal?.(); return view; }
    const X = deps.extensions();
    const el = (tag, text, cls) => AtriumNavCommon.elementIn(doc, tag, text, cls);
    const button = (text, fn, variant = "secondary") => {
      const b = el("button", text, "ui-button"); b.type = "button"; b.onclick = fn; b.dataset.variant = variant; return b;
    };
    const d = el("dialog", null, "work-dialog ext-registry");
    d.setAttribute("aria-label", "Browse Extensions");
    const status = el("p", null, "ext-registry-status"); status.setAttribute("role", "status");
    const list = el("div", null, "ext-registry-list");
    const urlInput = el("input", null, "ui-field"); urlInput.type = "url"; urlInput.placeholder = "https://example.org/atrium-extensions.json"; urlInput.value = config().url;
    urlInput.setAttribute("aria-label", "Registry URL"); urlInput.spellcheck = false;
    const indexInput = el("input"), pkgInput = el("input");
    indexInput.type = pkgInput.type = "file"; indexInput.hidden = pkgInput.hidden = true;
    indexInput.accept = ".json"; pkgInput.accept = ".zip,.waffle-extension";
    let pendingEntry = null, busy = false;
    const say = (text, level) => { status.textContent = text || ""; status.className = "ext-registry-status" + (level ? " is-" + level : ""); };
    const guard = fn => async () => { if (busy) return; busy = true; try { await fn(); } catch (e) { say(e.message, "error"); } finally { busy = false; render(); } };

    const settings = el("div", null, "ext-registry-settings");
    const field = el("label", null, "ext-registry-field");
    field.append(el("span", "Registry URL"), urlInput);
    settings.append(field,
      button("Save", guard(async () => { setUrl(urlInput.value); if (enabled()) { say("Loading…"); await refresh(); say(""); } else say("Registry turned off. Waffle will not contact any registry."); }), "primary"),
      button("Refresh", guard(async () => { if (!enabled()) return say("Set a registry URL first, or open an index file."); say("Loading…"); await refresh(); say(""); })),
      button("Open index file…", () => indexInput.click()));
    indexInput.onchange = guard(async () => { const f = indexInput.files?.[0]; indexInput.value = ""; if (f) { loadIndexText(await f.text()); say("Loaded " + f.name + ". Choose each package file to install; it is checked against the index."); } });
    pkgInput.onchange = guard(async () => {
      const f = pkgInput.files?.[0], entry = pendingEntry; pkgInput.value = ""; pendingEntry = null;
      if (!f || !entry) return;
      if (f.size > MAX_PACKAGE) throw Error("Extension packages are limited to " + MAX_PACKAGE / 1e6 + " MB.");
      const rec = await install(entry, {bytes: new Uint8Array(await f.arrayBuffer())});
      say(entry.name + " " + entry.version + " installed."); opts.onInstalled?.(rec.id);
    });
    const note = el("p", "Off until you set a registry. Waffle then contacts only that address, when this view opens or you press Refresh, and the package addresses of extensions you install. Every package is checked against the SHA-256 in the index, and installing shows the permissions again.", "ext-registry-note");

    function card(e) {
      const c = el("article", null, "ext-registry-card");
      const head = el("div", null, "ext-registry-head"), title = el("div", null, "ext-registry-title");
      title.append(el("strong", e.name), el("small", e.publisher + " · " + e.id + " · " + e.version + (e.license ? " · " + e.license : "")));
      const installed = X?.list().find(x => x.id === e.id);
      let action;
      if (installed?.origin === "builtin") action = el("span", "Built-in", "ui-badge");
      else if (installed && installed.version === e.version) { action = el("span", "Installed", "ui-badge"); action.dataset.tone = "success"; }
      else {
        const label = (installed ? "Update to " + e.version : "Install") + (state.origin === "file" ? " from file…" : "");
        action = button(label, state.origin === "file" ? () => { pendingEntry = e; pkgInput.click(); }
          : guard(async () => { say("Downloading " + e.name + "…"); const rec = await install(e); say(e.name + " " + e.version + " installed."); opts.onInstalled?.(rec.id); }), "primary");
      }
      head.append(title, action);
      c.append(head);
      if (e.description) c.append(el("p", e.description, "ext-registry-desc"));
      const perms = el("ul", null, "ext-registry-perms");
      perms.setAttribute("aria-label", "Permissions");
      if (!e.permissions.length) perms.append(el("li", "No permissions: it cannot read or change the design."));
      for (const p of e.permissions) {
        const li = el("li", null, /^network:|^write:edits$|^run:external$/.test(p) ? "is-sensitive" : "");
        li.append(el("code", p), el("span", X?.describePermission ? X.describePermission(p) : p));
        perms.append(li);
      }
      c.append(el("h4", "Permissions requested"), perms);
      const meta = el("dl", null, "ext-registry-meta");
      const row = (k, v) => meta.append(el("dt", k), el("dd", v));
      row("SHA-256", e.sha256);
      row("Package", e.download + (e.size ? " (" + Math.ceil(e.size / 1024) + " KB)" : ""));
      if (e.source) row("Source", e.source);
      row("Signature", e.signature ? "Present, not verified (signing is not implemented yet)" : "Unsigned");
      const prov = provenance(e.id);
      if (prov) row("Installed from", (prov.index === "file" ? "a local index" : prov.index) + " · " + prov.version);
      c.append(meta);
      return c;
    }
    function render() {
      list.replaceChildren();
      urlInput.value = config().url;
      if (!state.index) {
        list.append(el("p", state.error ? "The index could not be loaded: " + state.error : enabled() ? "Press Refresh to load the index." : "No registry is set. Enter a registry URL and press Save, or open an index file from disk.", "ext-registry-empty"));
        return;
      }
      const entries = latest(state.index.extensions);
      list.append(el("p", (state.index.name || (state.origin === "file" ? "Local index" : state.origin)) + " · " + entries.length + " extension" + (entries.length === 1 ? "" : "s"), "ext-registry-source"));
      for (const e of entries) list.append(card(e));
    }
    const head = el("header", null, "ext-registry-header"), heading = el("h2", "Browse Extensions");
    head.append(heading, button("Close", () => d.close()));
    d.append(head, settings, note, status, list, indexInput, pkgInput);
    globalThis.AtriumShell?.adoptDialog(d, {title:heading, body:[settings, note, status, list]});
    doc.body.append(d);
    d.addEventListener("close", () => { view = null; d.remove(); });
    view = {dialog: d, render};
    render(); d.showModal?.();
    if (enabled() && !state.index) guard(async () => { say("Loading…"); await refresh(); say(""); })();
    return view;
  }

  return Object.freeze({FORMAT, VERSION, configure, config, setUrl, enabled, checkUrl, validateIndex, latest, refresh, loadIndexText, sha256, verify, install, provenance, open,
    get index() { return state.index; }});
})();
