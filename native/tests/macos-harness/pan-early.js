"use strict";
// Installed at document start for pan.sh (HARNESS_EARLY_PROBE): times the page's own callbacks (outermost
// only: event listeners, animation frames, timers, idle and worker messages) so pan-probes.js can charge
// main-thread work to the wheel event it follows, counts bytes sent to WebGL textures, and records when
// each wheel event reached the page. The same instrument as scripts/perf-view-feel.cjs.
(() => {
  const W = window, now = () => performance.now();
  W.__work = []; W.__depth = 0; W.__rawTimeout = W.setTimeout.bind(W); W.__uploads = 0; W.__wheels = [];
  W.__inputs = [];
  const timed = f => typeof f !== "function" ? f : function (...a) {
    if (W.__depth) return f.apply(this, a);
    W.__depth = 1; const t = now();
    try { return f.apply(this, a); } finally { W.__depth = 0; W.__work.push(t, now() - t); }
  };
  const wrap = (o, k) => { const raw = o[k]; if (typeof raw === "function") o[k] = function (f, ...a) { return raw.call(this, timed(f), ...a); }; };
  for (const k of ["setTimeout", "setInterval", "requestIdleCallback", "queueMicrotask"]) wrap(W, k);
  const raf = W.__rawRAF = W.requestAnimationFrame.bind(W);
  W.requestAnimationFrame = f => raf(timed(function (t) {
    W.__rafTime = t;
    try { return f.call(this, t); } finally { W.__rafTime = null; }
  }));
  const listeners = new WeakMap(), add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  const wrapped = f => {
    if (typeof f !== "function" && typeof f?.handleEvent !== "function") return f;
    let w = listeners.get(f);
    if (!w) listeners.set(f, w = typeof f === "function" ? timed(f) : timed(e => f.handleEvent(e)));
    return w;
  };
  EventTarget.prototype.addEventListener = function (t, f, o) { return add.call(this, t, wrapped(f), o); };
  EventTarget.prototype.removeEventListener = function (t, f, o) { return remove.call(this, t, f && listeners.get(f) || f, o); };
  for (const C of [W.Worker, W.MessagePort, W.BroadcastChannel]) {
    const d = C && Object.getOwnPropertyDescriptor(C.prototype, "onmessage");
    if (d?.set) Object.defineProperty(C.prototype, "onmessage", {...d, set(f) { d.set.call(this, timed(f)); }});
  }
  const GL = W.WebGL2RenderingContext?.prototype;
  if (GL) for (const k of ["texSubImage2D", "texImage2D"]) {
    const raw = GL[k];
    GL[k] = function (...a) {
      const src = a[a.length - 1], sub = k === "texSubImage2D";
      const w = a.length >= 9 ? a[sub ? 4 : 3] : src?.width, h = a.length >= 9 ? a[sub ? 5 : 4] : src?.height;
      if (src && typeof w === "number" && typeof h === "number") W.__uploads += w * h * 4;
      W.__observeCanvasUpload?.(src, w, h);
      return raw.apply(this, a);
    };
  }
  // Not timed (registered before the wrapper above sees it): arrival time, deltas and whether the page may cancel it.
  add.call(W, "wheel", e => { if (W.__wheels.length < 4096) W.__wheels.push([now(), e.deltaX, e.deltaY, e.cancelable ? 1 : 0, e.deltaMode, e.clientX, e.clientY, e.target?.tagName + "." + (e.target?.className?.baseVal ?? e.target?.className ?? "")]); }, {capture: true, passive: true});
  for (const type of ["wheel", "gesturestart", "gesturechange", "gestureend"]) add.call(W, type, e => {
    if (W.__inputs.length < 4096) W.__inputs.push({type, at: now(), stamp: e.timeStamp, trusted: e.isTrusted,
      ctrl: !!e.ctrlKey, dx: e.deltaX, dy: e.deltaY, mode: e.deltaMode, scale: e.scale, x: e.clientX, y: e.clientY, target: e.target?.id});
  }, {capture: true, passive: true});
})();
