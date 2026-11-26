"use strict";

// Installed before the app. Record the wall time of each outermost wrapped callback.
function instrumentCallbacks() {
  const W = window;
  W.__requireBoardAt = (canvas, x, y) => {
    if (canvas.inert || document.elementFromPoint(x, y) !== canvas)
      throw Error("The benchmark input point is not on the visible board");
  };
  W.__work = [];
  W.__rawTimeout = W.setTimeout.bind(W);
  let depth = 0;
  const timed = callback => typeof callback !== "function" ? callback : function (...args) {
    if (depth) return callback.apply(this, args);
    depth = 1;
    const start = performance.now();
    try { return callback.apply(this, args); }
    finally { depth = 0; W.__work.push(start, performance.now() - start); }
  };
  for (const name of ["requestAnimationFrame", "setTimeout", "setInterval", "requestIdleCallback", "queueMicrotask"]) {
    const original = W[name];
    if (typeof original === "function") W[name] = function (callback, ...args) {
      return original.call(this, timed(callback), ...args);
    };
  }
  const listeners = new WeakMap(), add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (name, listener, options) {
    if (typeof listener !== "function" && typeof listener?.handleEvent !== "function")
      return add.call(this, name, listener, options);
    if (!listeners.has(listener))
      listeners.set(listener, timed(typeof listener === "function" ? listener : event => listener.handleEvent(event)));
    return add.call(this, name, listeners.get(listener), options);
  };
  EventTarget.prototype.removeEventListener = function (name, listener, options) {
    return remove.call(this, name, listener && listeners.get(listener) || listener, options);
  };
  for (const Type of [W.Worker, W.MessagePort, W.BroadcastChannel]) {
    const descriptor = Type && Object.getOwnPropertyDescriptor(Type.prototype, "onmessage");
    if (descriptor?.set)
      Object.defineProperty(Type.prototype, "onmessage", {...descriptor, set(callback) { descriptor.set.call(this, timed(callback)); }});
  }
}

// Playwright serializes this function into the page. Keep measurements and pixel
// readback separate. Settle windows begin when the final synthetic input dispatch
// returns. Each wrapped callback whose start is in the window contributes one sample.
async function measureZoomSettle({bursts, events, quietMs, renderer, prepare}) {
  const H = AtriumNavHost, view = H.view(), canvas = H.canvas(), I = view.internals(), G = globalThis.AtriumCanvasGPU;
  const wait = ms => new Promise(resolve => window.__rawTimeout(resolve, ms));
  const r = canvas.getBoundingClientRect();
  const x = r.width * .45, y = r.height * .55;
  if (prepare) {
    window.dispatchEvent(new CustomEvent("atrium-command", {detail:"fit"}));
    H.redraw(true); await wait(400);
    view.zoom(4, [x, y]); H.redraw(true); await wait(1500);
  }
  window.__requireBoardAt(canvas, r.left + x, r.top + y);
  const gesture = [], settled = [], fallback = new Set(), perBurst = [];
  const render = view.render, move = view.moving;
  let moving = false;
  view.moving = function (...args) { moving = true; return move.apply(this, args); };
  view.render = function (...args) {
    const gestureFrame = moving;
    moving = false;
    const start = performance.now(), result = render.apply(this, args);
    if (gestureFrame) gesture.push(performance.now() - start);
    const state = G?.resourceCounters?.(I)?.renderState;
    const actual = state ?? G?.status(I)?.renderer ?? "2d";
    if (actual !== renderer) fallback.add(actual);
    return result;
  };
  const wheel = options => canvas.dispatchEvent(new WheelEvent("wheel", {
    clientX:r.left + x, clientY:r.top + y, bubbles:true, cancelable:true, ...options,
  }));
  try {
    for (const options of bursts) {
      const firstGesture = gesture.length, firstSettle = settled.length;
      const surface = canvas.previousElementSibling;
      const before = renderer === "gpu" ? G.resourceCounters?.(I) : null;
      for (let n = 0; n < events; n++) {
        wheel(options);
        if (n + 1 < events) await wait(16);
      }
      const start = performance.now();
      window.__work.length = 0;
      await wait(quietMs);
      for (let k = 0; k < window.__work.length; k += 2)
        if (window.__work[k] >= start && window.__work[k] < start + quietMs) settled.push(window.__work[k + 1]);
      const work = {gesture:gesture.length - firstGesture, settled:settled.length - firstSettle};
      if (before && Number.isSafeInteger(before.frames)) {
        const after = G.resourceCounters(I);
        if (!after || surface !== canvas.previousElementSibling) throw Error("The GPU view changed during the benchmark");
        work.gpu = {};
        for (const key of ["frames", "gridBufferAllocations", "driverFenceSubmissions", "driverMemoryChecks"]) {
          const delta = after[key] - before[key];
          if (!Number.isSafeInteger(delta) || delta < 0) throw Error("Invalid GPU work counter: " + key);
          work.gpu[key] = delta;
        }
        if ("retainedFrames" in before || "retainedFrames" in after) {
          const delta = after.retainedFrames - before.retainedFrames;
          if (!Number.isSafeInteger(before.retainedFrames) || !Number.isSafeInteger(after.retainedFrames) ||
              !Number.isSafeInteger(delta) || delta < 0 || delta > work.gpu.frames)
            throw Error("Invalid GPU work counter: retainedFrames");
          work.gpu.retainedFrames = delta;
        }
        for (const key of ["textSliceRows", "wideSliceRows", "textSliceWorkMs", "wideSliceWorkMs"]) {
          if (!(key in before) && !(key in after)) continue;
          const delta = after[key] - before[key];
          if (!Number.isFinite(delta) || delta < 0) throw Error("Invalid text raster work counter: " + key);
          work.gpu[key] = delta;
        }
      }
      perBurst.push(work);
    }
  } finally {
    view.render = render;
    view.moving = move;
  }
  const sample = values => {
    const sorted = [...values].sort((a,b) => a-b);
    const percentile = p => sorted.length ? +sorted[Math.floor(p * (sorted.length - 1))].toFixed(2) : null;
    return {n:sorted.length, p50:percentile(.5), p95:percentile(.95), max:percentile(1)};
  };
  return {gesture:sample(gesture), settled:sample(settled), perBurst, fallback:[...fallback],
    workload:{items:H.doc().items.length, schematics:H.project().documents.filter(doc => doc.kind === "schematic").length}};
}

// A single real silkscreen label provides an unambiguous ink check on each
// backend. Check the frame delivered at rest against a forced exact render at
// the same camera. The measurements above finish before any readback here.
async function visibleSettledLettering() {
  const G = AtriumCanvasGPU, canvas = document.createElement("canvas");
  const wait = ms => new Promise(resolve => window.__rawTimeout(resolve, ms));
  canvas.style.cssText = "position:fixed;left:10px;top:10px;width:420px;height:280px";
  document.body.append(canvas);
  const view = AtriumCanvas.create(canvas), I = view.internals();
  const doc = Atrium.sheet("pcb", "Zoom lettering witness"), defs = new Map();
  doc.items = [{id:"zoom-lettering",kind:"label",x:0,y:0,text:"ZOOM INK",layer:"Silk",size:1.5,width:.16,justify:"center"}];
  const options = {reuseBase:false, grid:false, origin:false, showUnrouted:false};
  const [red, green, blue] = AtriumPCBAppearance.color("Silk").slice(1).match(/../g).map(channel => parseInt(channel,16));
  const backend = typeof G.perfCounters === "function" ? "retained" : "legacy";
  const work = counters => counters && [counters.labelBuilds,counters.labelRasterizations,
    counters.labelTextureUploads,counters.labelBufferUploads,counters.wholeTextBandUploads];
  let frame;
  function paint(extra) {
    view.render(doc, defs, {...options,...extra});
    const actual = G.status(I), surface = actual.renderer === "gpu" && G.composite(I);
    if (!surface) { frame = {renderer:actual.renderer, reason:actual.reason}; return; }
    const ctx = surface.getContext("2d"), {width,height} = surface;
    const bytes = ctx.getImageData(0,0,width,height).data, mask = new Uint8Array(width * height);
    let ink = 0;
    for (let k = 0; k < mask.length; k++) {
      const n = k * 4;
      if (Math.abs(red - bytes[n]) + Math.abs(green - bytes[n+1]) + Math.abs(blue - bytes[n+2]) < 80) {
        mask[k] = 1;
        ink++;
      }
    }
    frame = {renderer:actual.renderer, ink, mask, counters:G.perfCounters?.(I)};
  }
  try {
    view.onRepaint(() => paint());
    view.restoreCamera({cx:0,cy:0,scale:18,referenceScale:18}); paint({noReuse:true});
    const initial = frame;
    view.restoreCamera({cx:0,cy:0,scale:30,referenceScale:18}); view.moving(); paint();
    const gestureFrame = frame;
    view.settle(); paint();
    await wait(900);
    const settled = frame;
    paint({noReuse:true});
    const exact = frame;
    const sameInk = (a,b) => !!a.mask && !!b.mask && a.mask.length === b.mask.length &&
      a.mask.every((value, index) => value === b.mask[index]);
    const reusedRetainedData = backend === "legacy" ? null : (!!initial.counters && !!settled.counters &&
      initial.counters.labelRasterizations > 0 && initial.counters.labelBufferUploads > 0 &&
      gestureFrame.counters?.labelDraws > initial.counters.labelDraws &&
      settled.counters.labelDraws > gestureFrame.counters?.labelDraws &&
      JSON.stringify(work(initial.counters)) === JSON.stringify(work(settled.counters)));
    return {backend, renderer:exact.renderer, initialInk:initial.ink || 0, gestureInk:gestureFrame.ink || 0,
      settledInk:settled.ink || 0, exactInk:exact.ink || 0, sameSettledInk:sameInk(settled,exact),
      sameGestureInk:sameInk(gestureFrame,exact), reusedRetainedData,
      fallback:[initial,gestureFrame,settled,exact].filter(value => value.renderer !== "gpu").map(value => value.reason || value.renderer)};
  } finally {
    view.onRepaint(null);
    G.release?.(I);
    canvas.remove();
  }
}

module.exports = {instrumentCallbacks, measureZoomSettle, visibleSettledLettering};
