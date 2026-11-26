"use strict";
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/core/spatial.js");
require("../../app/pcb/pcb-appearance.js");
require("../../app/canvas/canvas.js");
require("../../app/canvas/pcb-net-labels.js");

const events = [], defs = new Map();
const ctx = new Proxy({}, {get: (target, key) => target[key] ?? (() => {})});
const canvas = {isConnected: true, getContext: () => ctx, getBoundingClientRect: () => ({width: 400, height: 300})};
const view = AtriumCanvas.create(canvas), I = view.internals();
const board = Atrium.sheet("pcb", "Frame copper");
const region = net => ({layer: "Top", net, bounds: [-4, -3, 4, 3]});
const original = [region("original")], edited = [region("edited")], decoy = [region("second read")];
const opts = {editorPane: true, noReuse: true, grid: false, origin: false};
let source = true, animated = false, drag = false, reads = 0, states = 0, idle = 0, queries = 0;
let next = original;
const spatialCreate = AtriumSpatial.create;
AtriumSpatial.create = (...args) => {
  const index = spatialCreate(...args), query = index.query;
  index.query = box => { queries++; return query(box); };
  return index;
};
globalThis.AtriumPCBPours = {paint: (_, r) => events.push(["fill", r])};
globalThis.AtriumPolygonPour = {
  displayState() { states++; return source ? "source" : "stale"; },
  displayPours() { return ++reads === 1 ? next : decoy; },
  tiles: {dragVisible: () => drag},
};
globalThis.AtriumPourAnim = {active: () => animated};
globalThis.AtriumPCBNetLabels = {...AtriumPCBNetLabels,
  place({pours}) { events.push(["labels", pours]); return []; }, draw() {},
};
globalThis.AtriumIdle = {idle() { return ++idle; }, cancel() {}};
view.onRepaint(() => {});

function fresh(list) {
  reads = states = 0;
  events.length = 0;
  next = list;
}
function verify(list, consumers) {
  assert.equal(reads, list ? 1 : 0, "resolve the visible copper at most once in one frame");
  assert.deepEqual(events.map(([name]) => name), consumers);
  for (const [name, value] of events) assert.equal(value, name === "fill" ? list[0] : list);
}

fresh(null);
view.render(board, defs, opts);
verify(null, []);
assert.equal(states, 0, "an empty source does not check the stored signature");
assert.equal(idle, 0, "an empty board does not schedule copper work");
assert.equal(queries, 1, "only the ordinary board artwork queries the empty view");

board.pcbDrawing = {pours: original};
view.invalidate(board);
fresh(null);
view.render(board, defs, {...opts, hidden: new Set(["Source pours"])});
verify(null, []);
assert.equal(states, 0, "an explicitly hidden source does not check the signature");
assert.equal(idle, 0, "a hidden source does not schedule copper work");
assert.equal(queries, 2, "only the ordinary board artwork queries the hidden-pour view");

for (const revision of [original, edited, original]) {
  board.pcbDrawing.pours = revision;
  view.invalidate(board);
  fresh(revision);
  view.render(board, defs, opts);
  verify(revision, ["fill", "labels"]);
  fresh(revision);
  view.render(board, defs, opts);
  verify(revision, ["fill", "labels"]);
}

// An attempted GPU frame can fail after selecting its source and ordering the
// layers. The ordinary Canvas2D fallback must finish that same frame.
globalThis.AtriumCanvasGPU = {render(I, doc, defs, opts, gesture, frame) {
  const pours = frame ? frame.pours : AtriumPolygonPour.displayPours(doc);
  events.push(["gpu", pours]);
  assert.deepEqual(I.paintOrder(doc, defs, opts, undefined, undefined, pours), ["Top"]);
  return false;
}};
fresh(edited);
view.render(board, defs, opts);
verify(edited, ["gpu", "fill", "labels"]);
delete globalThis.AtriumCanvasGPU;

source = false;
view.invalidate(board);
fresh(null);
view.render(board, defs, opts);
verify(null, []);
assert.equal(states, 1, "reject stale stored copper");
source = true;
view.invalidate(board);

fresh(null);
view.render(board, defs, {...opts, transientGeometry: true});
verify(null, []);
drag = true;
fresh(original);
view.render(board, defs, {...opts, transientGeometry: true});
verify(original, ["fill"]);

// A first reveal has visible preview copper before any region is stored.
delete board.pcbDrawing;
animated = true;
view.invalidate(board);
fresh(edited);
view.render(board, defs, opts);
verify(edited, ["fill", "labels"]);
animated = false;

board.pcbDrawing = {pours: original};
view.invalidate(board);
fresh(original);
I.paint(board, defs, {...opts, print: true}, null, true);
verify(original, ["fill"]);
fresh(edited);
I.paint(board, defs, opts, [0, 0, 400, 300]);
verify(edited, ["fill", "labels"]);

// The retained fast path still reuses the existing physical layer. Labels are
// resolved for the shown frame, and unchanged pixels do not fetch live copper.
require("../../app/canvas/canvas-fast.js");
globalThis.OffscreenCanvas = class {
  getContext() { return new Proxy({}, {get: (target, key) => target[key] ?? (() => {})}); }
};
let copies = 0;
ctx.drawImage = surface => { if (surface instanceof OffscreenCanvas) copies++; };
board.items = Array.from({length:310}, (_, n) => ({
  kind:"graphic", id:"line-"+n, layer:"Mechanical", width:.2, points:[[-8,-8+n/20],[-7,-8+n/20]],
}));
view.invalidate(board);
const retained = {...opts, noReuse: false};
fresh(original);
view.render(board, defs, retained);
verify(original, ["fill", "labels"]);
fresh(original);
view.render(board, defs, retained);
verify(original, ["labels"]);
assert.equal(copies, 1, "retained artwork is still blitted");
view.onRepaint(null);
console.log("PASS frame copper is shared by artwork, labels, layer order and GPU fallback");
