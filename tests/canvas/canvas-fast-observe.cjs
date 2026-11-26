"use strict";
// AtriumCanvasFast.observe (app/canvas/canvas-fast.js): the canvas-size ResizeObserver starts observing
// after the current pass, never inside it. A view's first measure often runs inside another
// ResizeObserver's callback (the library stage and the Symbol Wizard preview fit their canvas
// when it gets a size); an element observed there could not be delivered in that pass, and the
// browser reported "ResizeObserver loop completed with undelivered notifications"
// (scripts/click-through.sh, symbol-wizard, intermittently).
// Run: scripts/test-jsc.sh canvas-fast-observe   (or node tests/canvas/canvas-fast-observe.cjs)
const assert = require("node:assert/strict");
const observed = [];
let created = 0, disconnected = 0;
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; created++; }
  observe(el) { observed.push(el); }
  disconnect() { disconnected++; }
};
require("../../app/canvas/canvas-fast.js");
const canvas = {getBoundingClientRect: () => ({width: 300, height: 200})}, I = {canvas};
AtriumCanvasFast.observe(I);
AtriumCanvasFast.observe(I);
assert.equal(created, 1, "one observer per view");
assert.equal(observed.length, 0, "nothing is observed during the caller's pass");
globalThis.__testDone = new Promise(resolve => setTimeout(resolve, 5)).then(() => {
  assert.deepEqual(observed, [canvas], "the canvas is observed once, after the pass");
  verifyClosedPane();
  console.log("PASS canvas-fast observe: deferred observation, shrink-first resize and pane teardown");
});

function verifyClosedPane() {
  const {appFile} = require("../support/app-source-paths.cjs");
  for (const name of ["model", "pcb-appearance", "spatial", "canvas"]) require(appFile(name + ".js"));
  let width = 2000, height = 4000;
  const sizes = [], backing = {
    get width() { return width; }, set width(w) { width=w; sizes.push([w,height]); },
    get height() { return height; }, set height(h) { height=h; sizes.push([width,h]); },
  };
  AtriumCanvas.resizeBacking(backing,4000,2000);
  AtriumCanvas.resizeBacking(backing,2000,4000);
  AtriumCanvas.resizeBacking(backing,2000,4000);
  assert.deepEqual(sizes, [[2000,2000],[4000,2000],[2000,2000],[2000,4000]], "turning the viewport avoids an oversized intermediate");
  const ctx = new Proxy({}, {get: (o,k) => o[k] ?? (()=>{})}), surfaces = [];
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.width=w; this.height=h; surfaces.push(this); }
    getContext() { return ctx; }
  };
  const timers = new Map(), jobs = new Map(), listeners = new Map();
  let next = 0, indexes = 0;
  const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => { timers.set(++next, {fn, ms}); return next; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.AtriumIdle = {idle(fn) { jobs.set(++next, fn); return next; }, cancel(id) { jobs.delete(id); }};
  try {
    const board = {id:"a",kind:"pcb",items:[]}, defs = new Map();
    const surface = {width:2000,height:1500,getContext:() => ctx,
      getBoundingClientRect:() => ({width:2000,height:1500}),
      addEventListener:(type,fn) => listeners.set(type,fn),
      removeEventListener:(type,fn) => { if (listeners.get(type) === fn) listeners.delete(type); }};
    const view = AtriumCanvas.create(surface), i = view.internals(), fast = AtriumCanvasFast;
    view.render(board, defs, {grid:false});
    fast.under(i, board, {}, 300);
    fast.saved(i, board, defs, {}, 8, 300);
    assert.deepEqual(surfaces.map(c => [c.width,c.height]), [[2000,1500],[2000,1500]]);
    globalThis.AtriumCanvasGPU = {render:() => true, release() {}};
    view.render(board, defs, {grid:false});
    assert.deepEqual(surfaces.map(c => [c.width,c.height]), [[1,1],[1,1]], "GPU takeover releases the saved 2D frame and underlay");
    surfaces.length = 0;
    fast.under(i, board, {}, 300);
    fast.saved(i, board, defs, {}, 8, 300);
    fast.under(i, {...board}, {}, 300);
    assert.equal(surfaces.length, 3);
    const owner = i.connectivity = {result:{airwires:[]}};
    globalThis.AtriumSpatial = {create() { indexes++; }};
    fast.later(i, owner, () => {});
    const [stale] = jobs.values();
    i.armIdle();
    assert.ok([...timers.values()].some(t => t.ms === 140));
    view.dispose();
    assert.equal(disconnected, 1);
    assert.equal(listeners.size, 0);
    assert.deepEqual([surface, ...surfaces].map(c => [c.width,c.height]), [[1,1],[1,1],[1,1],[1,1]]);
    assert.equal(timers.size, 0, "no size callback or gesture repaint survives the pane");
    assert.equal(jobs.size, 0, "closed panes release their pending airwire index");
    stale({didTimeout:true}); // Cancellation can race with an already-delivered callback.
    assert.equal(indexes, 0);
    assert.deepEqual(observed, [canvas]);
  } finally {
    globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear;
  }
}
