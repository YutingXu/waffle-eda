"use strict";
// AtriumIdle: background work when the page is idle (undo recording, autosave, indexes, prefetch).
//   AtriumIdle.idle(fn, {timeout}) → id    fn({didTimeout, timeRemaining()}), like requestIdleCallback
//   AtriumIdle.cancel(id)
//   AtriumIdle.afterFrame(fn)              fn in a task just after the frame already requested has
//                                          been drawn (an edit's frame paints first), else next task
// requestIdleCallback where the engine has one (Chrome, WebView2). WebKit (WKWebView, WebKitGTK) has
// none, and a setTimeout stand-in runs the work before the frame of the edit that asked for it, or
// between the frames of a gesture or an animation (an undo's next frames). There callbacks wait until
// QUIET ms have passed with no pointer, wheel, key, touch or gesture input and no animation frame, and
// none is requested; then up to SLICE ms of them run. A frame requested STALE ms ago that has not run
// means the page draws no frames (hidden, occluded) and does not count. `timeout` (default 2000 ms)
// bounds the wait, as for requestIdleCallback.
// Dev guard (globalThis.ATRIUM_DEV, set by the test shim and the harness): a callback that runs over
// SLOW × SLICE ms is reported with console.warn and in AtriumIdle.slow ([{ms, owner}], the caller's
// frame) so work that ignores timeRemaining() shows up in tests.
globalThis.AtriumIdle = (() => {
  const G = globalThis, QUIET = 50, SLICE = 50, STALE = 100;
  const now = () => G.performance?.now?.() ?? Date.now();
  const raf = G.requestAnimationFrame, caf = G.cancelAnimationFrame;
  // Diagnostics watch the frame clock without counting as editor work in the WebKit idle fallback.
  const sampleFrame = callback => raf.call(G, callback), cancelSample = id => caf.call(G, id);
  const later = fn => setTimeout(fn, 0);
  const SLOW = 3, slow = [];
  const owner = fn => { const s = String(new Error().stack || "").split("\n").map(l => l.trim()).filter(l => l && !/idle\.js|\[native code\]|^Error|^(at )?(owner|timed|idle)\b/.test(l)); return (s[0] || "") + " " + (fn.name || String(fn).slice(0, 80).replace(/\s+/g, " ")); };
  const guard = (fn, ms, who) => { if (ms <= SLOW * SLICE) return; const o = who || owner(fn); if (slow.length >= 50) slow.shift(); slow.push({ms: Math.round(ms), owner: o}); G.console?.warn?.("AtriumIdle: callback ran " + Math.round(ms) + " ms (slice " + SLICE + " ms): " + o); };
  const timed = fn => { if (!G.ATRIUM_DEV) return fn; const who = owner(fn); return d => { const t = now(); try { return fn(d); } finally { guard(fn, now() - t, who); } }; };
  if (typeof G.requestIdleCallback === "function") {
    let measured;
    function idle(fn, o) {
      const callback = timed(fn), options = {timeout: o?.timeout ?? 2000};
      const span = G.AtriumDiagnostics?.performance?.queue("idle", "idle");
      if (!span) return G.requestIdleCallback(callback, options);
      const id = G.requestIdleCallback(deadline => {
        measured.delete(id);
        return span.run(callback, deadline);
      }, options);
      (measured ??= new Map()).set(id, span);
      return id;
    }
    function cancel(id) {
      measured?.get(id)?.end("cancelled");
      measured?.delete(id);
      return G.cancelIdleCallback?.(id);
    }
    return Object.freeze({idle, cancel,
      afterFrame: fn => typeof raf === "function" ? raf.call(G, () => later(fn)) : later(fn), sampleFrame, cancelSample, native: true, slow});
  }
  let busy = -Infinity, asked = -Infinity, seq = 0, timer = 0;
  const queue = new Map(), frames = new Set();   // id → {fn, due}; requested animation frames
  const mark = () => { busy = now(); };
  if (typeof raf === "function") {
    G.requestAnimationFrame = function (cb) { const id = raf.call(this, t => { frames.delete(id); busy = now(); cb(t); }); frames.add(id); asked = now(); return id; };
    if (typeof caf === "function") G.cancelAnimationFrame = function (id) { frames.delete(id); return caf.call(this, id); };
  }
  for (const t of ["pointerdown", "pointermove", "pointerup", "wheel", "keydown", "keyup", "touchstart", "touchmove", "gesturestart", "gesturechange"])
    G.addEventListener?.(t, mark, {capture: true, passive: true});
  const quiet = () => now() - busy >= QUIET && !(frames.size && now() - asked < STALE);
  function pump() {
    timer = 0;
    const t = now(), q = quiet();
    for (const [id, e] of queue) {
      if (!q && t < e.due) continue;
      queue.delete(id);
      const start = now(), late = !q;
      // The slice is shared: a callback that starts late in it gets only what is left (as requestIdleCallback's deadline).
      const deadline = {didTimeout: late, timeRemaining: () => late ? 0 : Math.max(0, SLICE - (now() - t))};
      try {
        if (e.span) e.span.run(() => e.fn(deadline));
        else e.fn(deadline);
      } catch (err) { G.console?.error?.(err); }
      if (G.ATRIUM_DEV) guard(e.fn, now() - start, e.who);
      if (!quiet() || now() - t >= SLICE) break;   // a frame was asked for, input arrived, or the slice is used
    }
    arm();
  }
  function arm() {
    if (timer || !queue.size || typeof setTimeout !== "function") return;
    let due = Infinity; for (const e of queue.values()) if (e.due < due) due = e.due;
    const t = now(), wait = Math.max(busy + QUIET - t, frames.size ? Math.min(QUIET, asked + STALE - t) : 0);
    timer = setTimeout(pump, Math.max(1, Math.min(due - t, wait)));
  }
  function idle(fn, o) {
    const id = ++seq;
    const span = G.AtriumDiagnostics?.performance?.queue("idle", "idle");
    queue.set(id, {fn, due: now() + (o?.timeout ?? 2000), who: G.ATRIUM_DEV ? owner(fn) : "", span});
    arm();
    return id;
  }
  function cancel(id) {
    queue.get(id)?.span?.end("cancelled");
    if (queue.delete(id) && !queue.size && timer) {
      clearTimeout(timer);
      timer = 0;
    }
  }
  const afterFrame = fn => { if (frames.size && typeof raf === "function") raf.call(G, () => later(fn)); else later(fn); };
  return Object.freeze({idle, cancel, afterFrame, sampleFrame, cancelSample, native: false, slow});
})();
