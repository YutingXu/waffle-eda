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
let created = 0;
globalThis.ResizeObserver = class {
  constructor(cb) { this.cb = cb; created++; }
  observe(el) { observed.push(el); }
  disconnect() {}
};
require("../../app/canvas/canvas-fast.js");
const canvas = {getBoundingClientRect: () => ({width: 300, height: 200})}, I = {canvas};
AtriumCanvasFast.observe(I);
AtriumCanvasFast.observe(I);
assert.equal(created, 1, "one observer per view");
assert.equal(observed.length, 0, "nothing is observed during the caller's pass");
globalThis.__testDone = new Promise(resolve => setTimeout(resolve, 5)).then(() => {
  assert.deepEqual(observed, [canvas], "the canvas is observed once, after the pass");
  console.log("PASS canvas-fast observe: the size observer starts after the current pass");
});
