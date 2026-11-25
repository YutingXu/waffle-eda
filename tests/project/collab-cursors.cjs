"use strict";
// Drive the real cursor renderer with a deterministic display clock and a recording 2D canvas.
const assert = require("node:assert/strict");
require("../../app/project/collab-cursors.js");
let now = 0, frame = null, fullMotion = true;
Object.defineProperty(globalThis, "performance", {value: {now: () => now}, configurable: true});
globalThis.requestAnimationFrame = fn => { assert.equal(frame, null); frame = fn; return 1; };
globalThis.cancelAnimationFrame = () => { frame = null; };
globalThis.getComputedStyle = () => ({getPropertyValue: () => "black"});
globalThis.AtriumMotion = {moves: () => fullMotion};
function tick(time) {
  now = time;
  const run = frame;
  assert.ok(run, "expected a scheduled frame");
  frame = null; run(now);
}
function context() {
  return {
    setTransform(...m) { this.matrix = m; },
    clearRect() { this.labels = []; this.arrows = []; },
    measureText(s) { return {width: Array.from(s).length * 6}; },
    fillRect(x, y, w, h) { this.box = {x, y, w, h}; },
    fillText(text, x, y) { this.labels.push({text, x, y, box: this.box}); },
    moveTo(x, y) { this.tip = [x, y]; }, fill() { this.arrows.push(this.tip); },
    setLineDash() {}, strokeRect() { this.strokes = (this.strokes || 0) + 1; }, beginPath() {}, lineTo() {}, closePath() {}, stroke() {}
  };
}
globalThis.document = {documentElement: {}, createElement() {
  const ctx = context();
  return {ctx, getContext: () => ctx, setAttribute() {}, remove() { this.removed = true; }};
}};
function pane(docId, zoom) {
  return {docId, view: {worldToScreen: at => at.map(n => n * zoom), camera: () => ({cx: 0, cy: 0, scale: zoom})},
    canvas: {width: 800, height: 400, clientWidth: 400, clientHeight: 200, after(el) {
      if (el.className === "collab-selections") this.highlights = el;
      else this.surface = el;
    }}};
}
const board = {id: "board", items: []}, sheet = {id: "sheet", items: []}, panels = [pane("board", 2), pane("sheet", 1)];
const host = {panes: () => panels, docById: id => id === "board" ? board : sheet, revision: () => 1, defs: () => new Map()};
const a = {name: "Alice", colour: 0}, b = {name: "Bob", colour: 0};
const overlay = AtriumCollabCursors.create(host, () => [a, b], ["--ink"]);
const paint = (p, doc, at, time) => { now = time; overlay.sample(p, doc, at); };
paint(a, "board", [50, 40], 0);
tick(0);
const ctx = panels[0].canvas.surface.ctx;
assert.deepEqual(ctx.matrix, [2, 0, 0, 2, 0, 0]);
assert.deepEqual(ctx.arrows, [[100, 80]]);
assert.equal(frame, null, "a stationary cursor should release the animation frame");

paint(a, "board", [100, 40], 50);
tick(75); assert.deepEqual(ctx.arrows, [[150, 80]], "world-space midpoint appears between packets");
paint(a, "board", [115, 40], 75);
tick(75); assert.deepEqual(ctx.arrows, [[150, 80]], "an update starts from the visible position");
tick(140); assert.deepEqual(ctx.arrows, [[230, 80]]);
assert.equal(frame, null);
fullMotion = false;
paint(a, "board", [199, 99], 180);
paint(b, "board", [199, 99], 180);
tick(180);
assert.deepEqual(ctx.arrows, [[398, 198], [398, 198]], "both pointers keep the exact world location");
assert.equal(ctx.labels.length, 2, "both names fit in the lower right corner");
for (const {box, x, y, text} of ctx.labels) {
  assert.ok(box.x >= 0 && box.x + box.w <= 400 && box.y >= 0 && box.y + box.h <= 200);
  assert.ok(x >= box.x && x + ctx.measureText(text).width < box.x + box.w);
  assert.equal(y, box.y + box.h / 2);
}
assert.equal(ctx.textAlign, "left"); assert.equal(ctx.textBaseline, "middle");
const [one, two] = ctx.labels.map(label => label.box);
assert.ok(one.x + one.w <= two.x || two.x + two.w <= one.x || one.y + one.h <= two.y || two.y + two.h <= one.y);
assert.equal(frame, null, "reduced motion lands immediately");

fullMotion = true;
paint(a, "sheet", [12, 15], 190); tick(190);
assert.deepEqual(panels[1].canvas.surface.ctx.arrows, [[12, 15]], "switching documents uses the other pane's projection immediately");
paint(b, "board", null, 200); tick(200);
assert.ok(panels[0].canvas.surface.removed);
paint(a, "sheet", [111, 55], 1500); tick(1500);
assert.deepEqual(panels[1].canvas.surface.ctx.arrows, [[111, 55]], "a long gap doesn't animate across the design");
const sheetCtx = panels[1].canvas.surface.ctx;
// Sparse, uneven arrivals should retarget from the painted point in either direction.
for (const [arrival, x] of [[1660, 150], [1930, 202], [2330, 250], [2580, 90]]) {
  paint(a, "sheet", [x, 55], arrival); tick(arrival);
  const start = sheetCtx.arrows[0][0];
  tick(arrival + 125);
  const mid = sheetCtx.arrows[0][0];
  assert.ok(mid > Math.min(start, x) && mid < Math.max(start, x), "still moving locally after 125 ms");
}
now = 2720;
overlay.sample(a, "sheet", [82, 55], true); tick(2870);
assert.deepEqual(sheetCtx.arrows, [[82, 55]]); assert.equal(frame, null, "a final waypoint lands exactly and goes idle");
paint(a, "sheet", [60, 30], 4150); tick(4150);
now = 4310; overlay.sample(a, "sheet", [150, 30], false, true); tick(4310);
now = 4320; overlay.sample(a, "sheet", [150, 120], true);
const atCorner = now + a.glide.ms * a.glide.split;
tick(atCorner);
assert.ok(Math.hypot(sheetCtx.arrows[0][0] - 150, sheetCtx.arrows[0][1] - 30) < .001,
  "an early stop still takes the painted pointer through the preceding turn");
tick(4460); assert.deepEqual(sheetCtx.arrows, [[150, 120]]);

// A path entirely off one side needs no canvas frames. A path crossing the pane does.
paint(a, "sheet", [-30, 45], 4550); tick(4550);
paint(a, "sheet", [-55, 40], 4780); tick(4780);
assert.equal(frame, null, "two offscreen points on the same side stay idle");
paint(a, "sheet", [430, 40], 5010); tick(5010);
assert.ok(frame, "crossing the view from outside animates");

// Redrawing a pointer leaves a stationary selection on its own surface.
sheet.items = [{id: "wire"}];
globalThis.Atrium = {itemPoints: () => [[5, 5], [10, 10]], bounds: () => [5, 5, 10, 10]};
b.sel = ["wire"]; paint(b, "sheet", [12, 12], 5300); tick(5300);
const highlights = panels[1].canvas.highlights;
assert.equal(highlights.ctx.strokes, 1);
paint(a, "sheet", [250, 30], 5500); tick(5500); tick(5540); tick(5580);
assert.equal(highlights.ctx.strokes, 1, "the same board outline is drawn only once");
panels[1].view.worldToScreen = at => [at[0] + 50, at[1]];
panels[1].view.camera = () => ({cx: -50, cy: 0, scale: 1});
overlay.refresh();
assert.equal(highlights.ctx.strokes, 2, "a camera change updates outlines in the same frame");
assert.deepEqual(sheetCtx.arrows.at(-1), [62, 12]);
overlay.stop();
assert.ok(panels[1].canvas.surface.removed);
assert.ok(highlights.removed);
assert.equal(frame, null);

const group = Array.from({length: 12}, (_, i) => ({name: "Peer " + (i + 1), colour: 0, doc: "board", at: [2, 2]}));
const crowd = AtriumCollabCursors.create(host, () => group, ["--ink"]);
crowd.refresh();
const crowdCtx = panels[0].canvas.surface.ctx;
assert.equal(crowdCtx.labels.length, 12, "crowded names use another column when the near column is full");
group.splice(0, 11); crowd.refresh();
assert.ok(crowdCtx.labels[0].box.x < 20 && crowdCtx.labels[0].box.y < 25, "a lone name returns to its pointer");
crowd.stop();

// Replay 125 Hz pointer input against the production sender using a deterministic timer.
const timers = new Map();
let id = 0;
globalThis.setTimeout = (fn, ms) => { timers.set(++id, {fn, at: now + ms}); return id; };
globalThis.clearTimeout = key => timers.delete(key);
function advance(time) {
  for (;;) {
    const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
    if (!next || next[1].at > time) break;
    timers.delete(next[0]); now = next[1].at; next[1].fn();
  }
  now = time;
}
now = 0;
const sent = [];
const sender = AtriumCollabCursors.waypoints((at, end, turn) => sent.push({at, end, turn, time: now}));
for (let i = 0; i <= 250; i++) {
  advance(i * 8);
  sender.move(i <= 125 ? [2 * i, 0] : [250, 2 * (i - 125)]);
}
advance(2300);
assert.ok(sent.length <= 10, "at most ten waypoints for 251 local events including a turn");
assert.deepEqual(sent[0].at, [0, 0]);
assert.ok(sent.some(p => Math.hypot(p.at[0] - 250, p.at[1]) < 18), "the turn is retained");
assert.deepEqual(sent.at(-1), {at: [250, 250], time: 2100, end: true, turn: false});
assert.equal(timers.size, 0, "the sender goes idle after the final point");
sender.move([251, 251]); sender.reset(); advance(3000);
assert.deepEqual(sent.at(-1).at, [250, 250], "a cancelled gesture has no late sends");
for (const [t, at] of [[0,[0,0]], [15,[45,0]], [30,[90,0]], [45,[90,40]], [60,[90,80]]]) {
  advance(3000 + t); sender.move(at);
}
advance(3200);
assert.deepEqual(sent.slice(-3).map(p => [p.at, p.turn, p.end]), [
  [[0,0],false,false], [[90,0],true,false], [[90,80],false,true]
], "a fast gesture sends its pending turn and its final point");
console.log("collab-cursors: sparse motion, high-DPI labels, collisions, split views and cleanup passed");
