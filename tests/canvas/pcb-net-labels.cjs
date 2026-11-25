"use strict";
// Net names on tracks and pours (app/canvas/pcb-net-labels.js through canvas.js paintTop): placed for the view,
// repeated along long tracks, kept on screen while panning, hidden when too small, upright, and drawn.
const assert = require("node:assert/strict");
const store = new Map();
Object.defineProperty(globalThis, "localStorage", {value: {getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k)}, configurable: true, writable: true});
for (const m of ["model", "spatial", "connectivity", "pcb-appearance", "pcb-pours", "canvas", "pcb-net-labels"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const N = AtriumPCBNetLabels, PCB = AtriumPCBAppearance;

function recorder() {
  const texts = [], stack = [];
  const target = {
    fillText(t, x, y) { texts.push({text: t, ink: this.fillStyle, font: this.font, x, y}); },
    save() { stack.push([this.fillStyle, this.font]); }, restore() { [this.fillStyle, this.font] = stack.pop(); }
  };
  return {texts, ctx: new Proxy(target, {get: (o, k) => o[k] ?? (() => {}), set: (o, k, v) => { o[k] = v; return true; }})};
}
const {texts, ctx} = recorder(), W = 800, H = 600;
const view = AtriumCanvas.create({getContext: () => ctx, getBoundingClientRect: () => ({width: W, height: H})});
const board = Atrium.sheet("pcb", "Labels");
board.outline = [[-60, -30], [60, -30], [60, 30], [-60, 30]];
// A long horizontal track (120 mm), a short one, a narrow one, a diagonal one heading left and down, and a Bottom track.
const long = {id: "long", kind: "track", layer: "Top", width: .5, net: "VBUS", points: [[-58, 0], [58, 0]]};
const short = {id: "short", kind: "track", layer: "Top", width: .5, net: "SHORT", points: [[0, 5], [.6, 5]]};
const thin = {id: "thin", kind: "track", layer: "Top", width: .05, net: "THIN", points: [[-50, 10], [50, 10]]};
const diag = {id: "diag", kind: "track", layer: "Top", width: .5, net: "DIAG", points: [[20, -20], [-20, -8]]};
const under = {id: "under", kind: "track", layer: "Bottom", width: .5, net: "BACK", points: [[-50, -4], [50, -4]]};
board.items = [long, short, thin, diag, under];
const cam = c => view.restoreCamera({...view.camera(), ...c, referenceScale: view.fitScale()});
function render(opts = {}) { texts.length = 0; view.render(board, new Map(), {grid: false, origin: false, layer: "Top", ...opts}); return view.internals().netLabels(); }
const onScreen = l => l.x >= 0 && l.x <= W && l.y >= 0 && l.y <= H;

// Fit: 120 mm across 800 px is under 7 px/mm, so a 0.5 mm track is about 3 px wide: no labels.
view.fit(board, new Map());
assert.equal(render().length, 0, "no labels on tracks too narrow on screen");
assert.equal(texts.length, 0);

// Zoom in (40 px/mm): a 0.5 mm track is 20 px wide; text fits inside it.
cam({cx: 0, cy: 0, scale: 40});
let labels = render();
const of = net => labels.filter(l => l.text === net);
assert.ok(of("VBUS").length >= 1, "the long track is labelled");
assert.ok(of("VBUS").every(onScreen), "its labels are in the view");
assert.ok(of("VBUS").every(l => Math.abs(l.y - H / 2) < 1 && l.angle === 0), "along the track, centred on it");
assert.ok(of("VBUS").every(l => l.size <= 20 * .62 + 1e-9 && l.size >= N.MIN_PX), "sized to the track width");
assert.equal(of("SHORT").length, 0, "a segment too short for its name is not labelled");
assert.equal(of("THIN").length, 0, "a track too narrow for legible text is not labelled");
assert.equal(of("BACK").length, 0, "only the current copper layer is labelled");
for (const l of of("DIAG")) assert.ok(l.angle > -Math.PI / 2 && l.angle <= Math.PI / 2, "never upside down");
assert.ok(texts.some(t => t.text === "VBUS"), "the labels are drawn");
const vbus = texts.find(t => t.text === "VBUS");
assert.equal(vbus.ink, PCB.system.padText, "the pad-caption ink on red copper, as pads");
assert.match(vbus.font, /px/);

// Pan along the long track, far from its middle: a label is still in view.
for (const cx of [-50, -33.3, -12.7, 21.1, 44, 55.5]) {
  cam({cx, cy: 0, scale: 40});
  labels = render();
  assert.ok(of("VBUS").some(onScreen), "a VBUS label stays in view at x = " + cx);
}
// Panned so the track passes through a corner of the view only: the label sits within the visible part.
cam({cx: 0, cy: 7.2, scale: 40});
labels = render();
assert.ok(of("VBUS").length && of("VBUS").every(onScreen), "the label moves onto the visible part of the track");
// Repeats: wide view of a long track shows several, at a world spacing, which pans with the board.
cam({cx: 0, cy: 0, scale: 25});
labels = render();
const xs = of("VBUS").map(l => l.x).sort((a, b) => a - b);
assert.ok(xs.length >= 2, "a long track repeats its name (" + xs.length + ")");
for (let k = 1; k < xs.length; k++) assert.ok(xs[k] - xs[k - 1] >= 300, "repeats are spread out");
cam({cx: 1, cy: 0, scale: 25});
const moved = render().filter(l => l.text === "VBUS").map(l => l.x).sort((a, b) => a - b);
const inner = xs.filter(x => x > 120 && x < W - 120);
for (const x of inner) assert.ok(moved.some(m => Math.abs(m - (x - 25)) < .01), "anchored labels move with the board");
// Labels never overlap one another.
const boxes = labels.map(l => [l.x - l.text.length * .3 * l.size, l.x + l.text.length * .3 * l.size, l.y - l.size / 2, l.y + l.size / 2]);
for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
  const p = boxes[a], q = boxes[b];
  if (labels[a].angle || labels[b].angle) continue;
  assert.ok(!(p[0] < q[1] && p[1] > q[0] && p[2] < q[3] && p[3] > q[2]), "labels do not overlap");
}
// Bottom current: the Bottom track's name instead.
cam({cx: 0, cy: 0, scale: 40});
labels = render({layer: "Bottom"});
assert.ok(of("BACK").length && !of("VBUS").length, "the current layer's tracks");
// Off: the option and hidden layers.
assert.equal(render({netNames: false}).length, 0);
assert.equal(render({hidden: new Set(["Top"])}).length, 0);
// Selected track: text contrasts with the selection colour.
labels = render({selected: "long"});
assert.equal(texts.find(t => t.text === "VBUS").ink, "#000000", "dark text on the white selection");

// Pours: a label at an interior point in view, not at the region's middle.
{
  const rings = [[[-40, -25], [40, -25], [40, 25], [-40, 25]], [[-5, -5], [5, -5], [5, 5], [-5, 5]]];
  const region = AtriumPCBPours.region(rings, "Top", "GND");
  const pours = [region];
  const v = {items: [], pours, scale: 40, width: W, height: H, PCB, opts: {layer: "Top"}, maxWidth: 0, trackInk: () => "#ff0000", pourInk: () => "#ff0000"};
  const at = (cx, cy) => {
    const toScreen = p => [(p[0] - cx) * 40 + W / 2, (p[1] - cy) * 40 + H / 2];
    return N.place({...v, toScreen, view: [cx - W / 80, cy - H / 80, cx + W / 80, cy + H / 80]});
  };
  // View centred on the hole in the pour: the label is placed on copper beside it, in view.
  let got = at(0, 0);
  assert.ok(got.length >= 1 && got.every(l => l.kind === "pour" && l.text === "GND" && onScreen(l)), "pour labelled in view");
  for (const l of got) {
    const wx = (l.x - W / 2) / 40, wy = (l.y - H / 2) / 40;
    assert.ok(Math.abs(wx) > 5 || Math.abs(wy) > 5, "not over the void");
  }
  // Panned near a corner of the pour, far from its middle.
  got = at(36, 21);
  assert.ok(got.length >= 1 && got.every(onScreen), "pour labelled near its corner");
  assert.ok(got.length <= 4, "sparse");
  // Zoomed out so the pour is small on screen: none.
  const tiny = N.place({...v, scale: 2, toScreen: p => [p[0] * 2 + W / 2, p[1] * 2 + H / 2], view: [-200, -150, 200, 150]});
  assert.ok(tiny.length <= 1);
}
console.log("PASS net names on tracks (level of detail, repeats, pan, upright, current layer) and pours (interior points in view).");
