"use strict";
// The WebGL board layer sits exactly under the 2D canvas that carries every overlay (DRC markers, DNP
// crosses, selection, net names). editor.js pins a costly pane's canvas during a sash drag with its own
// left/top, centred in the pane, and the pane then resizes without a frame. A board layer placed at the
// canvas's pixel offset stayed behind while the canvas (and its overlays) re-centred: resizing a side
// panel moved the DRC and DNP marks off the board. canvas-gpu.js's place() now gives the layer the
// canvas's own rule while it is pinned, and pixel offsets otherwise.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
require("../../app/core/model.js");
require("../../app/pcb/pcb-appearance.js");

const file = process.argv[2] || path.join(__dirname, "../../app/canvas/canvas-gpu.js");
const sandbox = vm.createContext({Atrium, AtriumPCBAppearance, AtriumCanvas: {resizeBacking(c, w, h) { c.width = w; c.height = h; }}});
const code = fs.readFileSync(file, "utf8"), exported = "{render, damage, stats,";
assert.ok(code.includes(exported));
vm.runInContext(code.replace(exported, "{render, damage, stats, place,"), sandbox);
const {place} = sandbox.AtriumCanvasGPU;

const canvas = {width: 1836, height: 1568, offsetLeft: 0, offsetTop: 28, style: {position: "relative"}};
const board = {width: 1836, height: 1568, style: {}};
const st = {canvas: board, gl: {drawingBufferWidth: 1836, drawingBufferHeight: 1568}, backingValid: true, shown: true, place: ""};
const view = {canvas};
const rule = () => [board.style.left, board.style.top, board.style.width, board.style.height];

// In the pane's flow, the layer takes the canvas's offset.
assert.equal(place(view, st, 918, 784), true);
assert.deepEqual(rule(), ["0px", "28px", "918px", "784px"]);

// Pinned for a sash drag: the layer takes the canvas's own centring rule, so a pane that resizes
// without a frame moves both together (the offsets layout reports at this moment no longer matter).
const left = "round(nearest, calc(50% + -459px), 1px)", top = "calc(50% + -364px)";
Object.assign(canvas.style, {position: "absolute", left, top});
canvas.offsetLeft = -32;
place(view, st, 918, 784);
assert.deepEqual(rule(), [left, top, "918px", "784px"], "a pinned canvas's board layer follows the pin, not a pixel offset");
canvas.offsetLeft = 27; // the dock moved; no frame is drawn while the pane is pinned
assert.deepEqual(rule(), [left, top, "918px", "784px"]);
place(view, st, 918, 784);
assert.deepEqual(rule(), [left, top, "918px", "784px"], "the pinned rule holds through later frames of the drag");

// Released at the pinned size: the next frame gives the layer the canvas's offset again.
canvas.style = {position: "relative"};
canvas.offsetLeft = 0;
place(view, st, 918, 784);
assert.deepEqual(rule(), ["0px", "28px", "918px", "784px"], "the released canvas's layer returns to pixel offsets");

// An absolute canvas without its own left/top still uses the offsets layout reports.
canvas.style = {position: "absolute"};
canvas.offsetLeft = 12;
place(view, st, 918, 784);
assert.deepEqual(rule(), ["12px", "28px", "918px", "784px"]);

console.log("canvas-gpu-place: ok");
