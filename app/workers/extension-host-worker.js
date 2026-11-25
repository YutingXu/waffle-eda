"use strict";
// Extension host: the worker side. This file only defines a function. extensions.js
// turns its source text into a Blob worker together with AtriumAPI.facade, so the
// offline file:// build needs no bundling step and no extension code is parsed on
// the main thread. The function must stay self-contained (no outer references).
//
// One worker runs ONE extension (or one console script run): the worker realm is the
// trust principal. In the editor the worker lives inside a sandboxed, opaque-origin
// iframe whose Content-Security-Policy is `default-src 'none'`, which Blob workers
// inherit, so no network request (fetch, import(), FontFace, WebSocket, ...) can leave
// it. The host talks to it over a private MessagePort (`port`); without one (tests),
// over self.postMessage.
//
// Protocol (every postMessage carries {batch:[...]}, flushed once per microtask):
//   main → worker  activate {cid, ext:{id}, source, main, files, settings}
//                  invoke {cid, ext, command, args}   deactivate {cid, ext}
//                  script {cid, ext:{id}, code, args}  event {name, payload, exts}
//                  reply {rid, ok, value, error}
//   worker → main  ready   call {rid, ext, method, args}   done {cid, ok, value, error}
//                  log {ext, level, text}   beat {busy}
// The host binds every message to the worker it came from; `ext` fields are informational.
globalThis.AtriumExtensionHostWorker = function AtriumExtensionHostWorker(self, facade, config, port) {
  "use strict";
  config = config || {};
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const post = port ? port.postMessage.bind(port) : self.postMessage.bind(self);
  const selfListen = self.addEventListener.bind(self);
  const listen = port ? fn => { port.addEventListener("message", fn); port.start(); } : fn => selfListen("message", fn);
  const nativeTimeout = typeof self.setTimeout === "function" ? self.setTimeout.bind(self) : null;
  const nativeInterval = typeof self.setInterval === "function" ? self.setInterval.bind(self) : null;
  const now = typeof self.performance?.now === "function" ? self.performance.now.bind(self.performance) : Date.now;

  // ---- No ambient authority ----------------------------------------------------
  // Messaging is reachable only through the functions captured above. Every other
  // channel out of the worker is removed from the global object and its prototypes.
  // This is defence in depth: the iframe's CSP is what blocks the network.
  const BLOCKED = ["postMessage", "onmessage", "onmessageerror", "close", "fetch", "XMLHttpRequest", "WebSocket", "WebSocketStream",
    "EventSource", "importScripts", "indexedDB", "caches", "WebTransport", "BroadcastChannel", "Request", "Worker", "SharedWorker",
    "FileReaderSync", "FontFace", "FontFaceSet", "fonts", "Notification", "ServiceWorker", "ServiceWorkerContainer", "serviceWorker",
    "CacheStorage", "IDBFactory", "StorageManager", "Lock", "LockManager", "NavigatorUAData", "webkitRequestFileSystem",
    "webkitRequestFileSystemSync", "webkitResolveLocalFileSystemURL", "webkitResolveLocalFileSystemSyncURL", "RTCPeerConnection",
    "RTCDataChannel", "PushManager", "BackgroundFetchManager", "cookieStore", "CookieStore", "WebTransportError"];
  const shut = (o, name) => { try { Object.defineProperty(o, name, {get() { return undefined; }, set() {}, configurable: false}); } catch {} };
  const chain = [];
  for (let o = self; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) chain.push(o);
  // An extension granted network:<host> gets the host-mediated fetch defined below instead.
  const hosts = Array.isArray(config.network) ? config.network.map(String) : [];
  for (const name of BLOCKED) {
    for (const o of chain) if (o !== self && own(o, name)) shut(o, name);
    if (!(name === "fetch" && hosts.length)) shut(self, name);
  }
  // navigator: harmless facts only (no sendBeacon, storage/OPFS, locks, serviceWorker, permissions).
  const nav = self.navigator;
  if (nav) {
    const safe = Object.freeze({userAgent: String(nav.userAgent || ""), platform: String(nav.platform || ""), language: String(nav.language || "en"),
      languages: Object.freeze(Array.from(nav.languages || [nav.language || "en"], String)), hardwareConcurrency: Number(nav.hardwareConcurrency) || 1, onLine: false});
    for (const o of chain) if (own(o, "navigator")) { try { Object.defineProperty(o, "navigator", {get() { return safe; }, configurable: false}); } catch {} }
    try { Object.defineProperty(self, "navigator", {get() { return safe; }, configurable: false}); } catch {}
  }
  const addListener = self.addEventListener;
  try {
    Object.defineProperty(self, "addEventListener", {value(type, ...rest) { if (type === "message" || type === "messageerror") return; return addListener.call(self, type, ...rest); }, configurable: false});
  } catch {}

  // ---- Batching ----------------------------------------------------------------
  // Buffers marked with api.transfer() move with the next batch instead of being copied.
  let queue = [], scheduled = false, moving = [];
  function flush() {
    scheduled = false;
    const batch = queue, transfer = moving; queue = []; moving = [];
    try { post({batch}, transfer); }
    catch {
      // One uncloneable value must not drop the whole batch.
      post({batch: batch.map(m => { try { if (typeof structuredClone === "function") structuredClone(m); else JSON.stringify(m); return m; } catch { return {...m, value: undefined, args: [], ok: m.ok === undefined ? undefined : false, error: m.error || {message: "The value could not be sent between threads."}}; } })});
    }
  }
  function send(message) { queue.push(message); if (!scheduled) { scheduled = true; Promise.resolve().then(flush); } }

  // ---- CPU accounting ----------------------------------------------------------
  // With config.heartbeat (ms) the worker reports how long it was busy since the last
  // beat. Every task the extension can schedule (timers, frames, host messages) opens a
  // busy span that closes at the next macrotask, so microtask chains count too. A
  // worker that stops beating is stuck in a loop; the host terminates it either way.
  let busy = 0, busyFrom = -1;
  const leave = () => { if (busyFrom >= 0) { busy += now() - busyFrom; busyFrom = -1; } };
  let tick = null;
  if (config.heartbeat > 0 && typeof self.MessageChannel === "function") { tick = new self.MessageChannel(); tick.port1.onmessage = leave; }
  const enter = config.heartbeat > 0 ? () => { if (busyFrom >= 0) return; busyFrom = now(); if (tick) tick.port2.postMessage(0); else if (nativeTimeout) nativeTimeout(leave, 0); } : () => {};
  if (config.heartbeat > 0) {
    const wrap = native => native && function (fn, ms, ...rest) {
      if (typeof fn !== "function") throw new TypeError("Timers take a function.");
      return native(function () { enter(); return fn.apply(this, rest.length ? rest : arguments); }, ms);
    };
    for (const [name, native] of [["setTimeout", nativeTimeout], ["setInterval", nativeInterval],
      ["requestAnimationFrame", typeof self.requestAnimationFrame === "function" ? self.requestAnimationFrame.bind(self) : null]]) {
      if (native) { try { Object.defineProperty(self, name, {value: wrap(native), writable: false, configurable: false}); } catch {} }
    }
    const beat = () => { leave(); send({t: "beat", busy: Math.round(busy)}); busy = 0; };
    if (nativeInterval) nativeInterval(beat, config.heartbeat);
    else if (nativeTimeout) { const again = () => { beat(); nativeTimeout(again, config.heartbeat); }; nativeTimeout(again, config.heartbeat); }
  }

  const pending = new Map();
  let nextRid = 0;
  function rpc(ext, method, args) {
    return new Promise((resolve, reject) => {
      const rid = ++nextRid;
      pending.set(rid, {resolve, reject});
      send({t: "call", rid, ext, method, args});
    });
  }

  // ---- network:<host> -----------------------------------------------------------
  // The worker has no network of its own. An extension the user allowed to contact
  // exact https hosts gets a `fetch` that asks the host to make the request; the host
  // checks the live grant on every call and streams the body back.
  if (hosts.length) {
    const Resp = typeof self.Response === "function" && typeof self.ReadableStream === "function" ? self.Response : null, Stream = self.ReadableStream;
    const Abort = () => Object.assign(new Error("The request was aborted."), {name: "AbortError"});
    const headerList = h => {
      if (!h) return [];
      if (typeof h.forEach === "function" && !Array.isArray(h)) { const out = []; h.forEach((v, k) => out.push([String(k), String(v)])); return out; }
      return (Array.isArray(h) ? h : Object.entries(h)).map(([k, v]) => [String(k), String(v)]);
    };
    const utf8 = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)); try { return decodeURIComponent(escape(s)); } catch { return s; } };
    // Where the realm has no Response/ReadableStream (test realms), a minimal equivalent.
    const lite = (head, read, abort) => {
      const map = new Map(head.headers.map(([k, v]) => [String(k).toLowerCase(), v]));
      let used = false;
      const all = async () => {
        if (used) throw new TypeError("Body has already been consumed.");
        used = true;
        const parts = []; let n = 0;
        for (let c; (c = await read()) != null;) { parts.push(c); n += c.length; }
        const out = new Uint8Array(n); let o = 0;
        for (const c of parts) { out.set(c, o); o += c.length; }
        return out;
      };
      const r = {ok: head.status >= 200 && head.status < 300, status: head.status, statusText: head.statusText,
        headers: Object.freeze({get: k => map.get(String(k).toLowerCase()) ?? null, has: k => map.has(String(k).toLowerCase()), forEach: f => map.forEach((v, k) => f(v, k))}),
        arrayBuffer: async () => (await all()).buffer, text: async () => utf8(await all()), json: async () => JSON.parse(utf8(await all())),
        body: {getReader: () => { used = true; return {read: async () => { const c = await read(); return c == null ? {done: true, value: undefined} : {done: false, value: c}; }, cancel: async () => abort(), releaseLock() {}}; }}};
      return Object.freeze(r);
    };
    // URL where the realm has it; otherwise a strict parse of absolute http(s) URLs.
    const parseUrl = href => {
      if (typeof self.URL === "function") return new self.URL(href);
      const m = /^(https?:)\/\/(?:([^@/?#]*)@)?([a-z0-9.-]+(?::\d{1,5})?)([/?#][^\s]*)?$/i.exec(href);
      if (!m) throw new TypeError("Invalid URL.");
      return {protocol: m[1].toLowerCase(), username: m[2] || "", password: "", host: m[3].toLowerCase(), href: m[1].toLowerCase() + "//" + m[3].toLowerCase() + (m[4] || "/")};
    };
    const hostFetch = function fetch(input, init = {}) {
      let url;
      try { url = parseUrl(typeof input === "string" ? input : String(input?.url ?? input)); } catch { return Promise.reject(new TypeError("Invalid URL.")); }
      // network:localhost: loopback only, any port, http or https. Every other host: exact https host.
      const loopback = hosts.includes("localhost") && /^https?:$/.test(url.protocol) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/.test(url.host);
      if (url.username || url.password || !loopback && (url.protocol !== "https:" || !hosts.includes(url.host))) return Promise.reject(new TypeError("Network access to " + url.host + " is not permitted."));
      const signal = init.signal;
      if (signal?.aborted) return Promise.reject(Abort());
      let body = init.body;
      if (body != null && typeof body !== "string" && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return Promise.reject(new TypeError("fetch bodies must be strings or bytes."));
      if (ArrayBuffer.isView(body)) body = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
      const method = String(init.method || "GET").toUpperCase();
      return rpc(null, "net.fetch", [url.href, {method, headers: headerList(init.headers), body: body ?? null}]).then(head => {
        let open = true;
        const abort = () => { if (open) { open = false; rpc(null, "net.abort", [head.id]).catch(() => {}); } };
        signal?.addEventListener?.("abort", abort, {once: true});
        const read = () => (open ? rpc(null, "net.read", [head.id]).then(c => { if (c == null) { open = false; return null; } return new Uint8Array(c); },
          e => { open = false; throw signal?.aborted ? Abort() : e; }) : Promise.reject(signal?.aborted ? Abort() : new TypeError("The response is closed.")));
        const empty = [101, 204, 205, 304].includes(head.status) || method === "HEAD";
        if (empty) abort();
        if (!Resp) return lite(head, empty ? async () => null : read, abort);
        const stream = empty ? null : new Stream({pull: c => read().then(v => { if (v == null) c.close(); else c.enqueue(v); }, e => c.error(e)), cancel: abort});
        return new Resp(stream, {status: head.status, statusText: head.statusText, headers: head.headers});
      });
    };
    try { Object.defineProperty(self, "fetch", {value: hostFetch, configurable: false, writable: false}); } catch {}
  }

  const errorOf = e => ({message: String(e?.message || e), stack: typeof e?.stack === "string" ? e.stack.split("\n").slice(0, 8).join("\n") : undefined});
  function text(args) {
    return args.map(a => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.message;
      try { const s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch { return String(a); }
    }).join(" ").slice(0, 4000);
  }
  const newId = () => self.crypto?.randomUUID?.() || ("x" + Date.now().toString(36) + Math.random().toString(36).slice(2));

  const extensions = new Map();
  function context(ext) {
    let entry = extensions.get(ext.id);
    if (entry) return entry;
    const log = (level, args) => send({t: "log", ext: ext.id, level, text: text(args)});
    const env = {newId, commands: new Map(), listeners: new Map(), log, subscribe: name => rpc(ext.id, "events.subscribe", [name]),
      transfer: v => { const b = v instanceof ArrayBuffer ? v : ArrayBuffer.isView(v) ? v.buffer : null; if (b && !moving.includes(b)) moving.push(b); return v; }};
    const api = facade((method, args) => rpc(ext.id, method, args), env);
    const console = Object.freeze({log: (...a) => log("info", a), info: (...a) => log("info", a), debug: (...a) => log("debug", a),
      warn: (...a) => log("warn", a), error: (...a) => log("error", a)});
    entry = {ext, env, api, console, module: null, subscriptions: []};
    extensions.set(ext.id, entry);
    return entry;
  }
  // Names that resolve to undefined inside extension and script code.
  const SHADOW = ["self", "globalThis", "postMessage", "close", "XMLHttpRequest", "WebSocket", "importScripts", "Worker"];
  function evaluate(source, params, values) {
    const fn = new Function(...params, ...SHADOW, '"use strict";\n' + source);
    return fn(...values, ...SHADOW.map(() => undefined));
  }
  async function activate(m) {
    const entry = context(m.ext);
    // A small CommonJS loader over the package's own .js/.json files.
    const files = m.files || {}, cache = new Map();
    const dir = path => path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
    const resolve = (from, spec) => {
      if (!/^\.{1,2}\//.test(spec)) throw Error("Extensions can only require files from their own package (" + spec + ").");
      const parts = (dir(from) + spec).split("/"), out = [];
      for (const part of parts) { if (part === "..") out.pop(); else if (part && part !== ".") out.push(part); }
      const path = out.join("/");
      for (const p of [path, path + ".js", path + "/index.js"]) if (own(files, p) || p === m.main) return p;
      throw Error("Cannot find " + spec + " from " + from + ".");
    };
    const load = (path, source) => {
      if (cache.has(path)) return cache.get(path).exports;
      if (/\.json$/.test(path)) { const v = JSON.parse(files[path]); cache.set(path, {exports: v}); return v; }
      const module = {exports: {}};
      cache.set(path, module);
      evaluate(source ?? files[path], ["exports", "module", "require", "api", "console"], [module.exports, module, spec => load(resolve(path, spec)), entry.api, entry.console]);
      return module.exports;
    };
    entry.module = load(m.main || "main.js", m.source);
    const ctx = Object.freeze({extensionId: m.ext.id, settings: m.settings || {}, subscriptions: entry.subscriptions});
    if (typeof entry.module.activate === "function") await entry.module.activate(entry.api, ctx);
    return {commands: [...entry.env.commands.keys()]};
  }
  async function invoke(m) {
    const entry = extensions.get(m.ext);
    const fn = entry?.env.commands.get(m.command);
    if (!fn) throw Error("Command " + m.command + " is not registered by " + m.ext + ".");
    return fn(...(m.args || []));
  }
  async function deactivate(m) {
    const entry = extensions.get(m.ext);
    if (!entry) return null;
    extensions.delete(m.ext);
    try { if (typeof entry.module?.deactivate === "function") await entry.module.deactivate(); }
    finally { for (const s of entry.subscriptions) { try { s?.dispose?.(); } catch {} } }
    return null;
  }
  async function script(m) {
    const entry = context(m.ext);
    try {
      return await evaluate("return (async () => {\n" + m.code + "\n})();", ["api", "console", "args"], [entry.api, entry.console, m.args ?? null]);
    } finally { extensions.delete(m.ext.id); }
  }
  let searchController = null;
  async function search(m) {
    // Each provider invocation gets a fresh realm. Its module receives query text and editor kind only.
    const listeners = new Set();
    searchController = typeof AbortController === "function" ? new AbortController() : {
      signal: {aborted: false, addEventListener(type, fn) { if (type === "abort") listeners.add(fn); }, removeEventListener(type, fn) { if (type === "abort") listeners.delete(fn); }},
      abort() { this.signal.aborted = true; for (const fn of listeners) fn(); }
    };
    const signal = searchController.signal, module = {exports: {}};
    evaluate(m.source, ["module", "exports"], [module, module.exports]);
    if (typeof module.exports.search !== "function") throw Error("A search provider module must export search(query, {signal, emit}).");
    let chunks = 0, rows = 0;
    function emit(batch) {
      if (signal.aborted || !Array.isArray(batch) || chunks >= 8 || rows >= 24) return;
      const part = batch.slice(0, 24 - rows); chunks++; rows += part.length;
      if (part.length) {
        const data = JSON.stringify(part);
        if (data.length <= 192000) send({t: "paletteRows", cid: m.cid, rows: JSON.parse(data)});
      }
    }
    const result = await module.exports.search(Object.freeze(m.query), Object.freeze({signal, emit, data: m.data ? JSON.parse(m.data) : undefined}));
    if (Array.isArray(result)) emit(result);
  }
  function settle(cid, work) {
    let out;
    try { out = Promise.resolve(work()); } catch (e) { out = Promise.reject(e); }
    out.then(value => {
      let safe = value;
      // Results must survive structured cloning; anything else is reported as text.
      try { if (typeof structuredClone === "function") structuredClone(value); }
      catch { safe = text([value]); }
      send({t: "done", cid, ok: true, value: safe});
    }, e => send({t: "done", cid, ok: false, error: errorOf(e)}));
  }
  function event(m) {
    for (const id of m.exts || extensions.keys()) {
      const entry = extensions.get(id);
      for (const fn of entry?.env.listeners.get(m.name) || []) {
        try { const r = fn(m.payload); if (r && typeof r.then === "function") r.catch(e => entry.env.log("error", [e])); }
        catch (e) { entry.env.log("error", [e]); }
      }
    }
  }
  function handle(m) {
    switch (m?.t) {
      case "reply": {
        const p = pending.get(m.rid);
        if (!p) return;
        pending.delete(m.rid);
        if (m.ok) p.resolve(m.value); else p.reject(Object.assign(Error(m.error?.message || "Host error"), {remote: true}));
        return;
      }
      case "activate": return settle(m.cid, () => activate(m));
      case "invoke": return settle(m.cid, () => invoke(m));
      case "widgetInvoke": return settle(m.cid, async () => {
        const result = await invoke(m), data = JSON.stringify(result);
        // JSON escapes lone surrogates. Percent encoding counts UTF-8 bytes even in headless worker realms.
        if (!data || data.length > 32768 || data.length*3 > 32768 && encodeURIComponent(data).replace(/%[0-9A-F]{2}/g,".").length > 32768)
          throw Error("Widget responses are limited to 32 KiB.");
        return JSON.parse(data);
      });
      case "paletteInvoke": return settle(m.cid, async () => {
        const result = await invoke(m);
        if (result == null) return null;
        const data = JSON.stringify(result);
        if (data.length > 524288) throw Error("Palette views are limited to 512 KiB.");
        return JSON.parse(data);
      });
      case "ai": return settle(m.cid, async () => {
        const module = {exports:{}};
        evaluate(m.source, ["module", "exports"], [module, module.exports]);
        if (typeof module.exports.respond !== "function") throw Error("The AI provider must export respond(input).");
        const value = JSON.stringify(await module.exports.respond(m.input));
        if (!value || value.length > 65536) throw Error("The AI provider response exceeded its limit.");
        return JSON.parse(value);
      });
      case "search": return settle(m.cid, () => search(m));
      case "cancelSearch": return searchController?.abort();
      case "deactivate": return settle(m.cid, () => deactivate(m));
      case "script": return settle(m.cid, () => script(m));
      case "event": return event(m);
    }
  }
  listen(e => { enter(); for (const m of e.data?.batch || []) handle(m); });
  send({t: "ready"});
};
