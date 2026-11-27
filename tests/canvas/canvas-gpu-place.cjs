"use strict";
// The WebGL board layer and the 2D canvas over it, which carries every overlay (DRC markers, DNP crosses,
// selection, net names), while a pane resizes. Reallocating the layer's multisampled backing costs about a
// frame, so a resizing pane (camera-only frames) keeps a backing that holds its view and grows one with
// room to spare; a frame at rest trims it to the view. The view is drawn in the backing's bottom-left
// corner: the layer is placed and clipped so that corner lies exactly under the canvas, at the canvas's own
// CSS pixels per device pixel. (Pinned panes once left the board layer behind the overlays: PR #68.)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
require("../../app/core/model.js");
require("../../app/pcb/pcb-appearance.js");

const file = process.argv[2] || path.join(__dirname, "../../app/canvas/canvas-gpu.js");
const allocations = [];
const sandbox = vm.createContext({Atrium, AtriumPCBAppearance, AtriumCanvas: {resizeBacking(c, w, h) { if (c.width !== w || c.height !== h) allocations.push([w, h]); c.width = w; c.height = h; }}});
const code = fs.readFileSync(file, "utf8"), exported = "{render, damage, stats,";
assert.ok(code.includes(exported));
vm.runInContext(code.replace(exported, "{render, damage, stats, place,"), sandbox);
const {place} = sandbox.AtriumCanvasGPU;

const canvas = {width: 1836, height: 1568, offsetLeft: 0, offsetTop: 28, style: {position: "relative"}};
const board = {width: 1, height: 1, style: {}};
const st = {canvas: board, gl: {get drawingBufferWidth() { return board.width; }, get drawingBufferHeight() { return board.height; }},
  backingValid: false, shown: true, place: "", maxW: 4096, maxH: 4096};
const view = {canvas};
// The canvas's box and the visible part of the board layer (its box less the clip-path inset), in CSS pixels.
const px = v => +String(v).replace("px", "");
const visible = () => {
  const s = board.style, m = /inset\(([\d.]+)px ([\d.]+)px/.exec(s.clipPath || "") || [0, 0, 0];
  return [px(s.left), px(s.top) + +m[1], px(s.width) - m[2], px(s.height) - m[1]];
};
const under = (width, height, what) => assert.deepEqual(visible(), [canvas.offsetLeft, canvas.offsetTop, width, height], what);
const resize = (w, h) => { canvas.width = w; canvas.height = h; };

// At rest the backing is the view, placed at the canvas's offset.
assert.equal(place(view, st, 918, 784, false), true);
assert.deepEqual([board.width, board.height], [1836, 1568]);
assert.equal(board.style.clipPath, "");
under(918, 784, "at rest the board layer is the canvas's box");

// A pane growing while it resizes: the backing grows with room to spare; the view's corner stays under the canvas.
allocations.length = 0;
resize(1936, 1568);
assert.equal(place(view, st, 968, 784, true), true);
assert.deepEqual(allocations, [[1936 + 484, 1568 + 392]], "one allocation, a quarter larger than the view each way");
under(968, 784, "a grown pane's board layer shows its view under the canvas");
// Further resizes inside the backing allocate nothing, wider or narrower.
for (const [w, cssW] of [[2100, 1050], [1736, 868], [2420, 1210]]) {
  resize(w, 1568);
  place(view, st, cssW, 784, true);
  under(cssW, 784, "the board layer follows the canvas at " + cssW + " px");
}
// A taller pane too (the Messages sash). The slack above the view is clipped, not drawn over the pane's tabs.
resize(1736, 1668);
place(view, st, 868, 834, true);
assert.ok(px(board.style.top) < canvas.offsetTop, "the backing extends above the canvas");
under(868, 834, "a taller pane's board layer shows its view under the canvas");
assert.deepEqual(allocations, [[2420, 1960]], "resizes inside the backing allocate nothing");

// Fractional CSS sizes: the layer uses the canvas's own CSS pixels per device pixel.
resize(1737, 1668);
place(view, st, 868.5, 834, true);
under(868.5, 834, "a fractional CSS width keeps the view under the canvas");

// The top layer's pixels belong to the old size: a size change releases them.
st.overlayCopy = {width: 9, height: 9}; st.ovAt = [3, 4];
resize(1700, 1668);
place(view, st, 850, 834, true);
assert.equal(st.overlayCopy, null, "a resized view releases the moved top layer");
assert.equal(st.ovAt, null);

// The frame at rest trims the backing to the view.
allocations.length = 0;
place(view, st, 850, 834, false);
assert.deepEqual(allocations, [[1700, 1668]]);
assert.equal(board.style.clipPath, "");
under(850, 834, "at rest the board layer is the canvas's box again");
place(view, st, 850, 834, false);
assert.deepEqual(allocations, [[1700, 1668]], "an unchanged view allocates nothing");

console.log("canvas-gpu-place: ok");
