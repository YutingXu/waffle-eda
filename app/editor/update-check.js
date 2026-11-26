"use strict";
// Help › Check for Updates checks the signed release feed on demand. Startup only shows local
// What's New. On macOS the host owns the transport, verification and installation.
globalThis.AtriumUpdate = (() => {
  const G = globalThis;
  const APP_VERSION = "0.8.1";             // app/about.js VERSION (tests/update-check.cjs keeps them equal)
  // release-manifest.py copies these pins into the signed macOS bundle at build time.
  const PUBLIC_KEY = "7d128edc4ea2da4046ec17ed5ea29ce6866de98d3ad0b356e1a8f5d6e0343fa4";
  const RELEASE_REPOSITORY = "YutingXu/waffle-eda";
  const RELEASES = "https://github.com/" + RELEASE_REPOSITORY + "/releases";
  const MANIFEST_URL = RELEASES + "/latest/download/waffle-release.json";
  const STORE = "atrium.update", FORMAT = "atrium-update", VERSION = 1;
  // First supported release for each native project format, in chronological order.
  const FORMATS = [["2.0", "0.7.0"]];
  // i18n (docs/translating.md): static text is extracted from this file ("update"); built text goes
  // through t(). The stub keeps English where i18n.js is absent (tests/update-check.cjs).
  // "\u0029" is ")" after a placeholder: scripts/i18n-extract.py ends a define() table at the first "})".
  const AtriumI18n = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s), scope() {}};
  AtriumI18n.scope(".update-dialog, .update-notes", ["update"]);
  const t = AtriumI18n.define({
    "update.opens": "Projects saved with Waffle {app} (format {format}\u0029 open in Waffle {first} and later.",
    "update.other_format": "Waffle {app} saves projects in format {format}. This build uses format {installed}.",
    "update.api_ok": "Extensions using apiVersion {api} still work.",
    "update.api_update": "Extensions using apiVersion {api} need an update for Waffle {app} (it provides apiVersion {apis}\u0029.",
    "update.updated": "Updated from Waffle {from} to {to}.",
    "update.version_notes": "Waffle {version}. {notes}",
    "update.here": "Waffle {version} · project format {format} · extension API {api}",
    "update.up_to_date": "Waffle {version} is up to date.",
    "update.available": "Waffle {version} is available.",
    "update.available_on": "Waffle {version} is available ({date}\u0029.",
    "update.check_again": "Check Again",
    "update.checking": "Checking for updates…", // i18n-ignore: explicit key
    "update.download": "Download {file} ({size} MB)",
    "update.install": "Install Update ({size} MB)",
    "update.preparing": "Downloading and checking the macOS update…", // i18n-ignore: explicit key
    "update.install_cancelled": "Installation cancelled. You can try again when you’re ready to restart.", // i18n-ignore: explicit key
    "update.manual_install": "Automatic installation needs a writable copy of Waffle in Applications. Download the update to install it yourself.", // i18n-ignore: explicit key
    "update.cancelled_download": "Download cancelled.",
    "update.releases_link": "View downloads on GitHub", // i18n-ignore: explicit key
    "update.downloading": "Downloading {file}…",
    "update.saved": "Checked and saved. {how}"
  });

  // ---- versions --------------------------------------------------------------------------------------
  const VERSION_RE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})(?:[-+][A-Za-z0-9.-]+)?$/;
  function compare(a, b) {
    const x = VERSION_RE.exec(a), y = VERSION_RE.exec(b);
    if (!x || !y) return NaN;
    for (let i = 1; i <= 3; i++) if (x[i] !== y[i]) return Number(x[i]) - Number(y[i]);
    return 0;
  }
  const firstWriter = format => FORMATS.find(f => f[0] === format)?.[1] || null;

  // ---- hashing (SHA-256, SHA-512), no dependencies ---------------------------------------------------------
  // Round constants and initial values are computed from the primes (FIPS 180-4), so none is typed in.
  const primes = n => { const out = []; for (let k = 2; out.length < n; k++) if (out.every(p => k % p)) out.push(k); return out; };
  const iroot = (x, k) => { let r = 1n << BigInt(Math.ceil(x.toString(2).length / k)); for (;;) { const s = ((BigInt(k) - 1n) * r + x / r ** BigInt(k - 1)) / BigInt(k); if (s >= r) return r; r = s; } };
  const frac = (p, k, bits) => iroot(BigInt(p) << BigInt(bits * k), k) & ((1n << BigInt(bits)) - 1n);
  let K256, H256, K512, H512;
  function sha256(bytes) {
    if (!K256) { K256 = Uint32Array.from(primes(64), p => Number(frac(p, 3, 32))); H256 = Uint32Array.from(primes(8), p => Number(frac(p, 2, 32))); }
    const len = bytes.length, total = ((len + 9 + 63) >> 6) << 6, m = new Uint8Array(total);
    m.set(bytes); m[len] = 0x80;
    const view = new DataView(m.buffer); view.setUint32(total - 8, Math.floor(len / 0x20000000)); view.setUint32(total - 4, (len << 3) >>> 0);
    const h = H256.slice(), w = new Uint32Array(64), r = (x, n) => (x >>> n) | (x << (32 - n));
    for (let o = 0; o < total; o += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getUint32(o + i * 4);
      for (let i = 16; i < 64; i++) w[i] = (w[i - 16] + (r(w[i - 15], 7) ^ r(w[i - 15], 18) ^ (w[i - 15] >>> 3)) + w[i - 7] + (r(w[i - 2], 17) ^ r(w[i - 2], 19) ^ (w[i - 2] >>> 10))) >>> 0;
      let [a, b, c, d, e, f, g, k] = h;
      for (let i = 0; i < 64; i++) {
        const t1 = (k + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K256[i] + w[i]) >>> 0, t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
        k = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      [a, b, c, d, e, f, g, k].forEach((x, i) => { h[i] = (h[i] + x) >>> 0; });
    }
    return Array.from(h, x => x.toString(16).padStart(8, "0")).join("");
  }
  function sha512(bytes) {
    const M = (1n << 64n) - 1n;
    if (!K512) { K512 = primes(80).map(p => frac(p, 3, 64)); H512 = primes(8).map(p => frac(p, 2, 64)); }
    const len = bytes.length, total = ((len + 17 + 127) >> 7) << 7, m = new Uint8Array(total);
    m.set(bytes); m[len] = 0x80;
    let bits = BigInt(len) * 8n;
    for (let i = total - 1; i >= total - 16; i--) { m[i] = Number(bits & 255n); bits >>= 8n; }
    const r = (x, n) => ((x >> BigInt(n)) | (x << BigInt(64 - n))) & M, h = H512.slice(), w = new Array(80);
    for (let o = 0; o < total; o += 128) {
      for (let i = 0; i < 16; i++) { let x = 0n; for (let j = 0; j < 8; j++) x = (x << 8n) | BigInt(m[o + i * 8 + j]); w[i] = x; }
      for (let i = 16; i < 80; i++) w[i] = (w[i - 16] + (r(w[i - 15], 1) ^ r(w[i - 15], 8) ^ (w[i - 15] >> 7n)) + w[i - 7] + (r(w[i - 2], 19) ^ r(w[i - 2], 61) ^ (w[i - 2] >> 6n))) & M;
      let [a, b, c, d, e, f, g, k] = h;
      for (let i = 0; i < 80; i++) {
        const t1 = (k + (r(e, 14) ^ r(e, 18) ^ r(e, 41)) + ((e & f) ^ (~e & M & g)) + K512[i] + w[i]) & M, t2 = ((r(a, 28) ^ r(a, 34) ^ r(a, 39)) + ((a & b) ^ (a & c) ^ (b & c))) & M;
        k = g; g = f; f = e; e = (d + t1) & M; d = c; c = b; b = a; a = (t1 + t2) & M;
      }
      [a, b, c, d, e, f, g, k].forEach((x, i) => { h[i] = (h[i] + x) & M; });
    }
    const out = new Uint8Array(64);
    h.forEach((x, i) => { for (let j = 7; j >= 0; j--) { out[i * 8 + j] = Number(x & 255n); x >>= 8n; } });
    return out;
  }

  // ---- Ed25519 signature verification (RFC 8032, verification only) ------------------------------------------
  const P = (1n << 255n) - 19n, L = (1n << 252n) + 27742317777372353535851937790883648493n;
  const mod = (a, m = P) => { const r = a % m; return r < 0n ? r + m : r; };
  const pow = (b, e, m = P) => { let r = 1n; b = mod(b, m); while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; } return r; };
  const inv = a => pow(a, P - 2n);
  const D = mod(-121665n * inv(121666n)), SQRT_M1 = pow(2n, (P - 1n) / 4n);
  const le = bytes => { let x = 0n; for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]); return x; };
  function decode(bytes) {
    if (bytes.length !== 32) return null;
    const sign = bytes[31] >> 7, y = le(Uint8Array.from(bytes, (b, i) => i === 31 ? b & 127 : b));
    if (y >= P) return null;
    const y2 = y * y % P, x2 = mod((y2 - 1n) * inv(D * y2 + 1n));
    let x = pow(x2, (P + 3n) / 8n);
    if (mod(x * x - x2) !== 0n) x = x * SQRT_M1 % P;
    if (mod(x * x - x2) !== 0n || (x === 0n && sign)) return null;
    if (Number(x & 1n) !== sign) x = P - x;
    return [x, y, 1n, x * y % P];
  }
  function add([X1, Y1, Z1, T1], [X2, Y2, Z2, T2]) {
    const a = mod((Y1 - X1) * (Y2 - X2)), b = mod((Y1 + X1) * (Y2 + X2)), c = mod(T1 * 2n * D * T2), d = mod(Z1 * 2n * Z2);
    const e = b - a, f = d - c, g = d + c, h = b + a;
    return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
  }
  function times(point, n) { let r = [0n, 1n, 1n, 0n], q = point; while (n > 0n) { if (n & 1n) r = add(r, q); q = add(q, q); n >>= 1n; } return r; }
  function encode([X, Y, Z]) { const z = inv(Z), x = X * z % P; let y = Y * z % P; const out = new Uint8Array(32); for (let i = 0; i < 32; i++) { out[i] = Number(y & 255n); y >>= 8n; } out[31] |= Number(x & 1n) << 7; return out; }
  let BASE;
  const hex = s => typeof s === "string" && /^([0-9a-f]{2})*$/i.test(s) ? Uint8Array.from(s.match(/../g) || [], b => parseInt(b, 16)) : null;
  // message, signature: Uint8Array; publicKey: Uint8Array(32) or 64 hex digits. True only for a valid signature.
  function verify(message, signature, publicKey) {
    try {
      const pub = typeof publicKey === "string" ? hex(publicKey) : publicKey;
      if (!pub || pub.length !== 32 || !(signature instanceof Uint8Array) || signature.length !== 64) return false;
      const A = decode(pub), R = decode(signature.subarray(0, 32)), S = le(signature.subarray(32));
      if (!A || !R || S >= L) return false;
      BASE ||= decode(Uint8Array.from({length: 32}, (_, i) => i === 0 ? 0x58 : 0x66));
      const all = new Uint8Array(64 + message.length); all.set(signature.subarray(0, 32)); all.set(pub, 32); all.set(message, 64);
      const k = mod(le(sha512(all)), L), left = encode(times(BASE, S)), right = encode(add(R, times(A, k)));
      return left.every((b, i) => b === right[i]);
    } catch { return false; }
  }

  // ---- the release manifest --------------------------------------------------------------------------------
  const URL_OK = /^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//;
  function parseManifest(text) {
    let m;
    try { m = JSON.parse(text); } catch { throw Error("The release manifest is not valid JSON."); }
    const bad = why => { throw Error("The release manifest is not usable: " + why + "."); };
    if (!m || m.format !== "atrium-release") bad("unknown format");
    if (m.version !== 1) bad("version " + m.version + " needs a newer Waffle to read");
    if (typeof m.app !== "string" || !VERSION_RE.test(m.app)) bad("no app version");
    if (!Array.isArray(m.assets) || m.assets.length > 50) bad("no downloads");
    for (const a of m.assets) {
      if (!a || typeof a.name !== "string" || !/^[\w.+-]{1,120}$/.test(a.name) || typeof a.url !== "string" || !URL_OK.test(a.url)) bad("a download has no https GitHub address");
      if (typeof a.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(a.sha256) || !Number.isInteger(a.size) || a.size < 1 || a.size > 2e9) bad("a download has no checksum or size");
    }
    if (m.apiVersions != null && (!Array.isArray(m.apiVersions) || !m.apiVersions.every(Number.isSafeInteger))) bad("invalid extension API versions");
    if (m.notes != null && (!Array.isArray(m.notes) || !m.notes.every(n => typeof n === "string" && n.length <= 500))) bad("notes must be text");
    return m;
  }
  const b64 = s => { const t = G.atob(String(s).trim()); return Uint8Array.from(t, c => c.charCodeAt(0)); };
  async function bytesOf(res, limit) {
    const max = () => Error("The release download exceeds its expected size.");
    if (Number(res.headers?.get("content-length")) > limit) throw max();
    if (!res.body?.getReader) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > limit) throw max();
      return bytes;
    }
    const reader = res.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw max();
        chunks.push(value);
      }
    } finally { Promise.resolve(reader.cancel()).catch(() => {}); }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return bytes;
  }
  const request = {credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", redirect: "follow"};
  // {status: "unavailable" | "up-to-date" | "available", manifest?, notes}. Throws on network or signature problems.
  // o: {fetch, publicKey, url, current} (tests); the app passes nothing.
  async function check(o = {}) {
    const key = o.publicKey ?? PUBLIC_KEY, url = o.url || MANIFEST_URL, get = o.fetch || G.fetch?.bind(G), current = o.current || APP_VERSION;
    if (!hex(key) || hex(key).length !== 32) return {status: "unavailable", reason: "This build has no release signing key, so it can't check for updates safely. Check the releases page instead."};
    if (!url) return {status: "unavailable", reason: "This build has no configured release feed."};
    if (!get) throw Error("This window can't reach the network.");
    const [doc, sig] = await Promise.all([get(url, request), get(url + ".sig", request)]);
    if (!doc.ok) throw Error("The release manifest could not be downloaded (" + doc.status + ").");
    if (!sig.ok) throw Error("The release manifest is not signed, so it was ignored.");
    const body = await bytesOf(doc, 512 * 1024);
    let signature;
    try { signature = b64(new TextDecoder().decode(await bytesOf(sig, 256))); } catch { signature = null; }
    if (!signature || !verify(body, signature, key)) throw Error("The release manifest's signature is not valid, so it was ignored.");
    const manifest = parseManifest(new TextDecoder().decode(body));
    return {status: compare(manifest.app, current) > 0 ? "available" : "up-to-date", manifest, notes: notes(manifest)};
  }

  // ---- compatibility notes ------------------------------------------------------------------------------------
  function api() { return G.AtriumAPI?.VERSION ?? 1; }
  function format() { return FORMATS.at(-1)[0]; }
  // For this build, or for the release a manifest describes.
  function notes(manifest = null) {
    const out = [], fmt = manifest?.formats?.writes || format(), app = manifest?.app || APP_VERSION;
    const first = firstWriter(fmt);
    out.push(first ? t("update.opens", {app, format: fmt, first}) : t("update.other_format", {app, format: fmt, installed: format()}));
    const apis = manifest ? manifest.apiVersions || [] : [api()];
    if (apis.includes(api())) out.push(t("update.api_ok", {api: api()}));
    else out.push(t("update.api_update", {api: api(), app, apis: apis.join(", ")}));
    return out;
  }

  // ---- download and hand-off ------------------------------------------------------------------------------------
  function platform() {
    const ua = G.navigator?.userAgent || "";
    return /Windows/i.test(ua) ? "windows" : /Mac OS X|Macintosh/i.test(ua) ? "macos" : /Linux|X11/i.test(ua) ? "linux" : "source";
  }
  const HOW = {
    macos: "Quit Waffle, open the download, and move Waffle.app to Applications.",
    linux: "Quit Waffle, then install the downloaded .deb with your package manager.",
    windows: "Unzip it and replace the old Waffle folder. Quit Waffle first.",
    source: "Unpack it in place of the old copy."
  };
  // Only on click. Verifies size and SHA-256 against the signed manifest, then saves the file for the user.
  async function download(asset, o = {}) {
    const get = o.fetch || G.fetch?.bind(G);
    const res = await get(asset.url, request);
    if (!res.ok) throw Error(asset.name + " could not be downloaded (" + res.status + ").");
    const bytes = await bytesOf(res, asset.size);
    if (bytes.length !== asset.size) throw Error(asset.name + " has the wrong size, so it was discarded.");
    const digest = G.crypto?.subtle && !o.noSubtle ? Array.from(new Uint8Array(await G.crypto.subtle.digest("SHA-256", bytes)), b => b.toString(16).padStart(2, "0")).join("") : sha256(bytes);
    if (digest !== asset.sha256) throw Error(asset.name + " does not match the signed checksum, so it was discarded.");
    const save = o.save || ((name, data) => G.AtriumIO.exportFile(name, data));
    const saved = await save(asset.name, bytes);
    return {saved: saved !== false, how: HOW[asset.platform] || HOW.source};
  }

  // ---- state ------------------------------------------------------------------------------------------------------
  const storage = o => { if (o?.storage) return o.storage; try { return G.localStorage || null; } catch { return null; } };
  function readState(o) {
    try { const s = JSON.parse(storage(o)?.getItem(STORE) || "null"); if (s?.format === FORMAT && s.version <= VERSION) return s; } catch {}
    return {format: FORMAT, version: VERSION};
  }
  function writeState(s, o) { try { storage(o)?.setItem(STORE, JSON.stringify({...s, format: FORMAT, version: VERSION})); } catch {} }

  // ---- startup: what's new after an update ----------------------------------------
  let started = false;
  async function startup(o = {}) {
    if (started && !o.force) return null;
    started = true;
    const out = {whatsNew: false}, initial = readState(o), previous = initial.lastVersion;
    if (!previous) writeState({...initial, lastVersion: APP_VERSION}, o);
    else if (previous !== APP_VERSION) {
      out.whatsNew = true;
      const pending = () => readState(o).lastVersion === previous;
      const seen = () => {
        const s = readState(o);
        if (s.lastVersion === previous) writeState({...s, lastVersion: APP_VERSION}, o);
      };
      if (o.showWhatsNew) { if ((await o.showWhatsNew(previous)) !== false) seen(); }
      else showWhatsNew(previous, pending, seen);
    }
    return out;
  }

  // ---- UI --------------------------------------------------------------------------------------------------------------
  const el = (tag, text, cls) => AtriumNavCommon.elementIn(G.document, tag, text, cls);
  const visible = d => d.visibilityState !== "hidden" && G.AtriumPower?.visible?.() !== false;
  async function waitForNotes(d, pending) {
    while (pending()) {
      if (!visible(d)) {
        await new Promise(resolve => {
          const wake = () => {
            if (!visible(d)) return;
            d.removeEventListener("visibilitychange", wake); off?.(); resolve();
          };
          const off = G.AtriumPower?.onChange?.(wake);
          d.addEventListener("visibilitychange", wake);
        });
      } else {
        const open = d.querySelector("dialog[open]");
        if (!open) return true;
        await new Promise(resolve => open.addEventListener("close", resolve, {once: true}));
      }
    }
    return false;
  }
  async function showWhatsNew(previous, pending, seen) {
    try {
      const doc = G.document;
      if (!doc || !await waitForNotes(doc, pending)) return;
      // Home may still be loading. Give it the first dialog even when the version check wins the race.
      const mode = (G.AtriumPref || G.AtriumPrefs)?.get?.("general.startPage") || "auto";
      if (mode !== "never" && !G.__atriumOpeningProject && (mode !== "auto" || G.AtriumNavHost?.isStarter?.() !== false) && !doc.querySelector("dialog.sp-dialog")) {
        const home = G.AtriumStartPage || await G.AtriumLazy?.need?.("AtriumStartPage");
        if (!await waitForNotes(doc, pending)) return;
        if (visible(doc) && pending() && !doc.querySelector("dialog.sp-dialog")) await home?.launch?.();
        if (!await waitForNotes(doc, pending)) return;
      }
      const W = G.AtriumWhatsNew || await G.AtriumLazy?.need?.("AtriumWhatsNew");
      if (!W) return;
      do { if (!await waitForNotes(doc, pending)) return; }
      while (!visible(doc) || doc.querySelector("dialog[open]"));
      if (!pending()) return;
      const d = W.open(G.AtriumNavHost);
      const list = d?.querySelector?.(".whats-new-list");
      if (!d?.open || !list) return;
      const box = el("div", null, "update-notes");
      box.append(el("p", t("update.updated", {from: previous, to: APP_VERSION})));
      for (const n of notes()) box.append(el("p", n));
      list.before(box);
      // An exit while Home is still open must leave the notice due next launch.
      seen();
    } catch {}
  }
  function open(host) {
    const S = G.AtriumShell;
    if (!S?.dialog) { host?.info?.(t("update.version_notes", {version: APP_VERSION, notes: notes().join(" ")})); return null; }
    const existing = G.document.querySelector(".update-dialog[open]");
    if (existing) return existing;
    const native = G.AtriumHost?.checkForUpdate ? G.AtriumHost : null;
    const status = el("div", null, "update-status");
    status.setAttribute("role", "status");
    const result = el("div", null, "update-result");
    const here = el("div", null, "update-here");
    const button = (key, run, args) => G.AtriumUI.nativeButton(t(key, args), run);
    here.append(el("p", t("update.here", {version: APP_VERSION, format: format(), api: api()})));
    for (const n of notes()) here.append(el("p", n, "side-note"));

    let installing = false;
    const retry = button("update.check_again", run);
    const dialog = S.dialog({title: "Check for Updates", className: "update-dialog", body: [here, status, result, retry], actions: [
      {label: "What’s New", run: () => { G.AtriumLazy?.need?.("AtriumWhatsNew").then(W => W.open(host)).catch(() => {}); }},
      {label: "Close", primary: true}]}); // i18n-ignore: common button

    async function run() {
      retry.disabled = true;
      status.textContent = t("update.checking");
      result.replaceChildren();
      try {
        const r = await (native ? native.checkForUpdate() : check());
        if (!dialog.open) return;
        if (r.status === "unavailable") { status.textContent = r.reason; return; }
        if (r.status === "up-to-date") { status.textContent = t("update.up_to_date", {version: APP_VERSION}); return; }
        const m = r.manifest;
        status.textContent = t(m.published ? "update.available_on" : "update.available", {version: m.app, date: m.published});
        const list = el("ul", null, "update-notes");
        for (const n of [...(m.notes || []), ...notes(m)]) list.append(el("li", n));
        result.append(list);

        const assets = m.assets.filter(a => a.platform === (native ? "macos" : platform()));
        for (const a of assets) {
          const size = Math.round(a.size / 104857.6) / 10 || "<0.1", file = a.name;
          const downloadButton = button("update.download", () => act(downloadButton, t("update.downloading", {file}), async () => {
            const d = native ? {saved: await native.downloadUpdate(m.app, a.sha256), how: HOW.macos} : await download(a);
            status.textContent = d.saved ? t("update.saved", {how: G.AtriumI18n?.text?.(d.how, "update") ?? d.how}) : t("update.cancelled_download");
          }), {file, size});
          const showDownload = () => {
            if (native) result.append(el("p", t("update.manual_install"), "side-note"));
            result.append(downloadButton);
          };
          if (!native || !r.canInstall) { showDownload(); continue; }
          const install = button("update.install", () => act(install, t("update.preparing"), async () => {
            installing = true;
            const outcome = await native.installUpdate(m.app, a.sha256).finally(() => { installing = false; });
            if (outcome === "download") {
              install.remove();
              showDownload();
              downloadButton.focus();
              status.textContent = t("update.available", {version: m.app});
            } else if (outcome === "cancelled") status.textContent = t("update.install_cancelled");
          }), {size});
          result.append(install);
        }
        if (!assets.length) {
          const link = el("a", t("update.releases_link"));
          link.href = RELEASES;
          link.rel = "noopener noreferrer";
          result.append(link);
        }
      } catch (e) { status.textContent = e.message; }
      finally { retry.disabled = false; }
    }
    async function act(control, progress, action) {
      retry.disabled = control.disabled = true;
      status.textContent = progress;
      try { await action(); }
      catch (e) { status.textContent = e.message; }
      finally { retry.disabled = control.disabled = false; }
    }
    dialog.addEventListener("close", () => { if (installing) native.cancelUpdate()?.catch(() => {}); });
    void run();
    return dialog;
  }
  G.AtriumNavCommon?.ready?.(host => host.registerAction("check-updates", () => open(host)));
  return Object.freeze({APP_VERSION, PUBLIC_KEY, MANIFEST_URL, STORE, FORMATS, compare, sha256, sha512, verify, parseManifest, check, notes, download,
    platform, startup, open});
})();
