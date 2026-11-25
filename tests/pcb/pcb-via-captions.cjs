"use strict";
// Via net names (app/canvas/canvas.js padText; canvas-board-batches.js and canvas-gpu.js choose the same objects):
// a via shows its net across it once it is large enough on screen, as a pad shows its caption: same
// threshold, font and contrast ink; never on a via without a net, too small, or with net captions off.
const assert = require("node:assert/strict");
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {value: {getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)}, configurable: true, writable: true});
for (const m of ["model", "spatial", "connectivity", "pcb-appearance", "pcb-pours", "canvas", "canvas-board-batches"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const PCB = AtriumPCBAppearance;

function recorder() {
  const texts = [], stack = [];
  const target = {
    fillText(t, x, y) { texts.push({text: String(t), ink: this.fillStyle, font: this.font}); },
    save() { stack.push([this.fillStyle, this.font]); }, restore() { [this.fillStyle, this.font] = stack.pop() || []; }
  };
  return {texts, ctx: new Proxy(target, {get: (o, k) => o[k] ?? (() => {}), set: (o, k, v) => { o[k] = v; return true; }})};
}
const {texts, ctx} = recorder(), W = 800, H = 600;
const view = AtriumCanvas.create({getContext: () => ctx, getBoundingClientRect: () => ({width: W, height: H})});
const board = Atrium.sheet("pcb", "Vias");
board.outline = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
const via = {id: "v1", kind: "via", x: 0, y: 0, diameter: .6, drill: .3, net: "VBUS", fromLayer: "Top", toLayer: "Bottom"};
const bare = {id: "v2", kind: "via", x: 2, y: 0, diameter: .6, drill: .3, fromLayer: "Top", toLayer: "Bottom"};
const pad = {id: "p1", kind: "pad", x: -2, y: 0, w: .6, h: .6, shape: "rect", layer: "Top", net: "SMD"};
board.items = [via, bare, pad];
const cam = scale => view.restoreCamera({...view.camera(), cx: 0, cy: 0, scale, referenceScale: view.fitScale()});
function drawn(opts = {}) { texts.length = 0; view.render(board, new Map(), {grid: false, origin: false, layer: "Top", ...opts}); return texts.map(t => t.text); }
view.fit(board, new Map());

// 40 px/mm: the 0.6 mm via is 24 px across, over the 15 px a pad needs for its caption.
cam(40);
let shown = drawn();
assert.ok(shown.includes("VBUS"), "the via's net is drawn on it: " + shown.join(","));
assert.ok(shown.includes("SMD"), "the pad of the same size shows its net too");
const t = texts.find(x => x.text === "VBUS"), p = texts.find(x => x.text === "SMD");
assert.equal(t.ink, PCB.system.padText, "the pad-caption ink on red copper");
assert.equal(t.font.split(" ").slice(2).join(" "), p.font.split(" ").slice(2).join(" "), "the pad caption's font family");
assert.ok(parseFloat(t.font.split(" ")[1]) >= 5, "legible");
assert.equal(shown.filter(x => x === "").length, 0, "a via without a net draws no caption");
assert.ok(!drawn({netNames: false}).includes("VBUS"), "net captions off hides it, as for pads");

// 10 px/mm: 6 px across, too small for a caption.
cam(10);
shown = drawn();
assert.ok(!shown.includes("VBUS") && !shown.includes("SMD"), "too small: hidden");

// A light via ink (Multi-Layer, a non-copper layer current) takes black text, as a light pad does.
cam(40);
drawn({layer: "Silk"});
const silk = texts.find(x => x.text === "VBUS");
assert.ok(silk, "shown with a non-copper layer current");
assert.equal(silk.ink, "#000000", "black on the light Multi-Layer ink");

// The batched level of detail (boards over 1,500 objects) draws a via one by one, over its batch, once its
// caption shows: the same rule as for a pad.
const C = AtriumCanvasBoardBatches.create({A: Atrium, PCB, T: null, chosen: () => false, netInk: () => null, boardLayer: i => i.layer || "Multi", union: (a, b) => a, appendArc: () => {}});
const lod = {size: 10, chunks: new Map(), info: new Map()}, defs = new Map(), opts = {layer: "Top"};
for (const item of board.items) {
  C.add(lod, item, defs, [item.x - .3, item.y - .3, item.x + .3, item.y + .3], board);
  assert.equal(lod.info.get(item)?.kind, "p", "the simple land was classified by the batcher");
}
const special = (item, scale, options = opts) => C.special(item, lod.info.get(item), options, scale);
assert.equal(special(via, 40), true, "a via large enough for its net leaves the batch");
assert.equal(special(pad, 40), true, "as a pad does");
assert.equal(special(via, 10), false, "too small: stays batched");
assert.equal(special(via, 25), false, "a 15 px land stays batched");
assert.equal(special(via, 25.01), true, "a land just over 15 px leaves the batch");
assert.equal(special(bare, 40), false, "no net: stays batched");
assert.equal(special(via, 40, {...opts, netNames: false}), false, "captions off: stays batched");
console.log("pcb via captions: ok");
