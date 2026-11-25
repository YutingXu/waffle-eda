"use strict";
// Installed by WKWebView at document start. Leave the original console, error propagation and frame pacing intact.
(() => {
  // WebKit's idle fallback observes application frame requests. The measurement itself must leave
  // those idle windows available, including between two consecutive physical display callbacks.
  const requestFrame = globalThis.requestAnimationFrame.bind(globalThis);
  const cancelFrame = globalThis.cancelAnimationFrame.bind(globalThis);
  let action = "startup", last, handle, count = 0;
  const frames = [], events = [], actions = [], changes = [], spans = [];
  function emit(type, value) {
    events.push({type, action, ms: Math.round(performance.now()), text: String(value)});
  }
  for (const type of ["warn", "error"]) {
    const original = console[type];
    console[type] = function (...args) {
      try { emit("console." + type, args.map(a => a?.stack || String(a)).join(" ")); } catch { /* logging must still reach WebKit */ }
      return original.apply(this, args);
    };
  }
  addEventListener("error", e => emit(e.message ? "uncaught" : "resource-error", e.message || e.target?.src || e.target?.href || "resource"), true);
  addEventListener("unhandledrejection", e => emit("rejection", e.reason?.stack || e.reason));
  addEventListener("securitypolicyviolation", e => emit("browser-policy", e.violatedDirective + " " + e.blockedURI));
  // WebKit's test delegate forwards the page console but skips dedicated worker consoles. Insert a
  // listener before each real Blob worker program. The original source follows byte-for-byte. Keep
  // its strict-mode directive, and never deliver the observer's own messages to the application.
  const workerCounts = {created: 0, listening: 0, withoutConsole: 0};
  if (globalThis.Worker && globalThis.Blob) {
    const token = Array.from(crypto.getRandomValues(new Uint32Array(4))).join("-"), scripts = new Map(), directives = new WeakMap();
    const originalBlob = Blob, makeURL = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
    const listen = `(() => { const send = (type, text) => self.postMessage({tourConsole: ${JSON.stringify(token)}, type, text});
      for (const level of ["warn", "error"]) { const original = console[level];
        console[level] = function(...args) { try { send("worker-console." + level, args.map(a => a?.stack || String(a)).join(" ")); } catch {}
          return original.apply(this, args); }; }
      self.addEventListener("unhandledrejection", e => send("worker-rejection", String(e.reason?.stack || e.reason)));
      send("ready", ""); })();\n`;
    globalThis.Blob = new Proxy(originalBlob, {construct(target, args, receiver) {
      const blob = Reflect.construct(target, args, receiver);
      if (/^(?:text|application)\/(?:java|ecma)script(?:;|$)/i.test(blob.type) && typeof args[0]?.[0] === "string") {
        const strict = /^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\n]*\n)*(["'])use strict\1(?:\s*;|\s*\n)/.test(args[0][0].slice(0, 16384));
        directives.set(blob, strict ? '"use strict";\n' : '');
      }
      return blob;
    }});
    URL.createObjectURL = object => {
      const url = makeURL(object);
      if (directives.has(object)) scripts.set(url, {blob: object, directive: directives.get(object)});
      return url;
    };
    URL.revokeObjectURL = url => {
      const script = scripts.get(String(url));
      if (script?.observed) revoke(script.observed);
      scripts.delete(String(url)); return revoke(url);
    };
    globalThis.Worker = new Proxy(globalThis.Worker, {construct(target, args, receiver) {
      const script = scripts.get(String(args[0]));
      if (script) {
        script.observed ||= makeURL(new originalBlob([script.directive, listen, script.blob], {type: script.blob.type}));
        args[0] = script.observed;
      } else workerCounts.withoutConsole++;
      const worker = Reflect.construct(target, args, receiver); workerCounts.created++;
      worker.addEventListener("message", e => {
        const m = e.data;
        if (m?.tourConsole === token) {
          e.stopImmediatePropagation();
          if (m.type === "ready") workerCounts.listening++;
          else emit(m.type, m.text);
        } else if (m && (m.type === "parse-error" || m.type === "unavailable" || m.error && typeof m.error === "string")) {
          emit("worker-reply", m.message || m.error || m.type);
        }
      }, true);
      worker.addEventListener("error", e => emit("worker-error", e.message || "Worker error"));
      worker.addEventListener("messageerror", () => emit("worker-message-error", "Worker message could not be read"));
      return worker;
    }});
  }
  function frame(now) {
    if (last !== undefined) {
      const dt = now - last;
      if (dt > 100) frames.push({ms: +dt.toFixed(2), at: +now.toFixed(2), actions: [...new Set([...changes, action])]});
      count++;
    }
    last = now; changes.length = 0; handle = requestFrame(frame);
  }
  handle = requestFrame(frame);
  globalThis.tourTrace = {
    mark(name) { changes.push(action); action = name; actions.push({name, at: +performance.now().toFixed(2)}); },
    timed(name, fn) {
      const start = performance.now();
      try { return fn(); } finally { spans.push({name, action, start: +start.toFixed(2), end: +performance.now().toFixed(2)}); }
    },
    finish(redact) {
      cancelFrame(handle);
      return {frameCount: count, over100: frames, actions, spans, workers: workerCounts,
        events: events.map(({text, ...event}) => redact ? event : {...event, text: text.replace(/file:\/\/[^\s)]+/g, "[local resource]")})};
    }
  };
})();
