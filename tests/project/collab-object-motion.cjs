"use strict";
const assert = require("node:assert/strict");
require("../../app/project/collab-object-motion.js");

// Deterministic display frames, with the same base-render → frame-notification
// order as editor.js. Record the actual items passed to the pane's shape painter.
let now = 0, sequence = 0, level = "full", editorFrames = 0;
const frames = new Map(), dirty = new Set(), events = new Map(), renderers = new Set();
globalThis.AtriumMotion = {level: () => level};
let saveEnergy = false, onPower;
globalThis.AtriumPower = {idle: () => saveEnergy, onChange(fn) { onPower = fn; return () => { onPower = null; }; }};
Object.defineProperty(globalThis, "performance", {value: {now: () => now}, configurable: true});
globalThis.requestAnimationFrame = fn => { frames.set(++sequence, fn); return sequence; };
globalThis.cancelAnimationFrame = id => frames.delete(id);
globalThis.document = {createElement() {
  const ctx = {ink: [], clearRect() { this.ink = []; }, save() {}, restore() {}, setTransform(a, b, c, d, e, f) { this.at = [e, f]; }};
  return {ctx, setAttribute() {}, getContext: () => ctx, remove() { this.removed = true; }};
}};
const docs = new Map([["board", {id: "board", kind: "pcb", items: []}], ["sheet", {id: "sheet", kind: "schematic", items: []}]]);
// The pane's canvas internals: the last frame's options, an identity camera and the shape painters.
function pane(docId) {
  const paint = (g, item, defs, opts) => {
    assert.equal(opts.hide, null, "a detached appearance is never itself hidden");
    g.ink.push({id: item.id, x: (item.points?.[0][0] ?? item.x) + g.at[0], y: (item.points?.[0][1] ?? item.y) + g.at[1], alpha: g.globalAlpha, defs});
  };
  const internals = {frame: () => [docs.get(docId), defs, {}], cam: () => [0, 0, 1, false, 800, 600, 1], worldToScreen: p => p,
    drawBoard: (g, [item], doc, defs, scale, opts) => paint(g, item, defs, opts), drawItem: (g, item, doc, defs, scale, opts) => paint(g, item, defs, opts)};
  return {docId, canvas: {width: 800, height: 600, after(el) { this.surface = el; }}, view: {internals: () => internals}};
}
const board = pane("board"), sheet = pane("sheet"), panes = [board, sheet], defs = new Map(), oldDefs = new Map();
let selected = [];
const host = {
  panes: () => panes, docById: id => docs.get(id), currentId: () => "board", defs: () => defs, selection: () => selected,
  invalidateDocument: id => dirty.add(id), addRenderer(f) { renderers.add(f); return () => renderers.delete(f); },
  on(k, f) { if (!events.has(k)) events.set(k, new Set()); events.get(k).add(f); return () => events.get(k).delete(f); }
};
const emit = type => { for (const fn of events.get(type) || []) fn(); };
function frame(time) {
  now = time;
  const display = [...frames.keys()];
  if (dirty.size) {
    for (const p of panes) if (dirty.has(p.docId)) {
      p.hidden = new Set();
      for (const f of renderers) {
        const o = f(docs.get(p.docId));
        for (const i of o?.hide || []) { assert.ok(docs.get(p.docId).items.includes(i), "hidden items are the live objects"); p.hidden.add(i.id); }
        if (o) p.noReuse = o.noReuse;
      }
      editorFrames++;
    }
    dirty.clear(); emit("frame");
  }
  for (const id of display) { const fn = frames.get(id); if (fn) { frames.delete(id); fn(now); } }
}
const live = AtriumCollabObjectMotion.create(host);
const item = (x, y = 5) => ({id: "V1", kind: "via", x, y, diameter: 1});
const ink = p => p.canvas.surface.ctx.ink[0];
function update(docId, a, b) {
  live.change(docId, a, b, oldDefs);
  docs.get(docId).items = b ? [b] : [];
}

update("board", null, item(10)); frame(0);
assert.ok(board.hidden.has("V1")); assert.deepEqual(board.canvas.surface.ctx.ink, []);
assert.equal(sheet.canvas.surface, undefined);
frame(70); assert.ok(ink(board).alpha > 0 && ink(board).alpha < 1);
const opacity = ink(board).alpha;
update("board", item(10), item(30)); frame(70);
assert.equal(ink(board).x, 10); assert.equal(ink(board).alpha, opacity);
frame(140); const halfway = ink(board).x;
assert.ok(halfway > 10 && halfway < 30);
update("board", item(30), item(50)); frame(140);
assert.equal(ink(board).x, halfway, "a new move starts at the visible geometry");
const bases = editorFrames;
frame(170); frame(200); frame(230); assert.equal(editorFrames, bases, "object motion does not redraw the board each frame");
const last = {...ink(board)};
update("board", item(50), null); frame(230);
assert.equal(ink(board).x, last.x); assert.equal(ink(board).alpha, last.alpha);
assert.equal(ink(board).defs, oldDefs);
frame(300); assert.equal(ink(board).x, last.x); assert.ok(ink(board).alpha < last.alpha);
frame(450); frame(470); assert.ok(board.canvas.surface.removed); assert.equal(frames.size, 0);

const line = n => ({id: "L", kind: "wire", points: [[n, 2], [n + 8, 2]]});
update("sheet", line(0), line(8)); frame(500); assert.equal(ink(sheet).x, 0);
frame(600); assert.ok(ink(sheet).x > 0 && ink(sheet).x < 8);
update("sheet", line(8), {...line(8), points: [[8, 2], [23, 7]]}); frame(620);
assert.ok(sheet.canvas.surface.removed, "a stretch releases the committed shape");
update("sheet", line(8), line(12)); frame(621);
const large = {...line(12), points: Array.from({length: AtriumCollabObjectMotion.limits.points + 1}, (_, i) => [i, 3])};
// The capture path skips copying this geometry and releases its earlier moving shape.
live.cancel("sheet", large.id); docs.get("sheet").items = [large]; frame(622);
assert.ok(sheet.canvas.surface.removed); assert.equal(sheet.hidden.size, 0);
update("sheet", null, large); assert.equal(dirty.size, 0);
update("board", item(2), item(8)); frame(630); selected = ["V1"]; emit("selection"); frame(640);
assert.ok(board.canvas.surface.removed); assert.equal(board.hidden.size, 0);
update("board", item(8), item(9)); assert.equal(dirty.size, 0, "an existing local selection stays at its committed position");
selected = [];
update("board", item(8), item(16)); frame(650); docs.get("board").items = [item(90)]; live.localChange(); frame(660);
assert.ok(board.canvas.surface.removed, "a local edit owns the committed geometry immediately");

level = "reduced";
update("board", item(8), item(36)); assert.equal(dirty.size, 0, "reduced motion skips travel");
update("board", null, item(36)); frame(700); frame(760);
assert.equal(ink(board).x, 36); assert.ok(ink(board).alpha > 0 && ink(board).alpha < 1);
level = "off"; frame(770); frame(780); assert.ok(board.canvas.surface.removed);
update("board", null, item(16)); assert.equal(dirty.size, 0, "off bypasses fade as well as travel");
level = "full";
update("board", item(8), item(20)); frame(800);
assert.ok(frames.size);
saveEnergy = true; onPower(); frame(810);
assert.equal(frames.size, 0); assert.equal(board.hidden.size, 0);
update("board", item(20), item(48)); assert.equal(dirty.size, 0, "a hidden or efficient editor schedules no decorative motion");
saveEnergy = false; onPower();
update("board", item(48), item(31)); frame(815); live.stop(); frame(820);
assert.equal(onPower, null);
assert.equal(frames.size, 0); assert.ok(board.canvas.surface.removed);
assert.equal(renderers.size, 0); assert.ok([...events.values()].every(set => !set.size));
console.log("collab-object-motion: fades, retargeting, split panes, authoritative edits, preferences and cleanup passed");
