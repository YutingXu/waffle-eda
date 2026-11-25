"use strict";
// Designator placement: hard constraints, readability, relayout, sample board and a 1,500-part benchmark.
// Node:  node tests/pcb/designator-place.cjs
// JSC:   jsc shim.js -- tests/pcb/designator-place.cjs
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/pcb/designator-place.js");require("../../app/pcb/designator-plan.js");
const D = globalThis.AtriumDesignators, A = globalThis.Atrium;
const now = () => globalThis.performance.now();
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

// The starter library has courtyards (so the sample passes DRC). These cases were written for the
// pads-and-body boxes, so they use the parts without their courtyard outlines.
const bare = d => { const c = JSON.parse(JSON.stringify(d)); if (c.footprint) { delete c.footprint.courtyard; c.footprint.shapes = (c.footprint.shapes || []).filter(s => s.style !== "courtyard"); } return c; };
const catalogue = new Map(AtriumParts.catalogue.map(d => [d.id, bare(d)]));
let n = 0;
const part = (def, x, y, angle = 0, extra = {}) => ({id: "p" + (++n), kind: "part", def, ref: (extra.prefix || "C") + n, value: "", x, y, angle, pinNets: {}, ...extra});

// Independent checker: every placed designator against pads (+ clearance + mask
// expansion), other designators (+ gap), the outline (+ edge clearance) and readability.
function verify(doc, defs, o = {}) {
  const clear = (o.clearance ?? .1) + (o.expansion ?? .1016) - 1e-6, gap = (o.silkGap ?? .1) - 1e-6, edge = (o.edgeClearance ?? .25) - 1e-6;
  const labels = [], pads = [];
  for (const i of doc.items) {
    if (i.kind !== "part") continue;
    const def = defs.get(i.def), bottom = i.layer === "Bottom";
    for (const p of def.footprint.pads) {
      const at = A.world([p.x, p.y], i), q = ((Math.round(((i.angle || 0) + (p.angle || 0)) / 90) % 2) + 2) % 2;
      const w = (q ? p.h : p.w) / 2 + clear, h = (q ? p.w : p.h) / 2 + clear;
      pads.push({b: [at[0] - w, at[1] - h, at[0] + w, at[1] + h], sides: p.drill > 0 ? 3 : bottom ? 2 : 1, ref: i.ref});
    }
    const l = D.label(i, def);
    if (l) labels.push({l, side: bottom ? 2 : 1, ref: i.ref, item: i});
  }
  const hit = (a, b) => a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1];
  const inside = (x, y, poly) => { let r = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const a = poly[i], b = poly[j]; if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) r = !r; } return r; };
  for (const x of labels) {
    const b = x.l.box;
    assert.ok(x.side === 1 ? [0, 270].includes(x.l.angle) : [0, 90].includes(x.l.angle), x.ref + " readable angle " + x.l.angle);
    assert.equal(x.l.mirror, x.side === 2);
    for (const p of pads) if (p.sides & x.side) assert.ok(!hit(b, p.b), x.ref + " overlaps a pad of " + p.ref);
    if (doc.outline?.length >= 3) for (const [px, py] of [[b[0] - edge, b[1] - edge], [b[2] + edge, b[1] - edge], [b[0] - edge, b[3] + edge], [b[2] + edge, b[3] + edge]])
      assert.ok(inside(px, py, doc.outline), x.ref + " leaves the board");
  }
  // Designator pairs, via a sort-and-sweep.
  const s = labels.slice().sort((a, b) => a.l.box[0] - b.l.box[0]);
  for (let i = 0; i < s.length; i++) for (let j = i + 1; j < s.length && s[j].l.box[0] < s[i].l.box[2] + gap; j++) {
    if (!(s[i].side & s[j].side)) continue;
    const a = s[i].l.box, b = s[j].l.box;
    assert.ok(!hit([a[0] - gap, a[1] - gap, a[2] + gap, a[3] + gap], b), s[i].ref + " overlaps designator " + s[j].ref);
  }
  return labels;
}

test("readable angles and the part-relative model", () => {
  assert.equal(D.readable(0, false), 0); assert.equal(D.readable(180, false), 0);
  assert.equal(D.readable(90, false), 270); assert.equal(D.readable(270, false), 270);
  assert.equal(D.readable(-90, false), 270); assert.equal(D.readable(90, true), 90); assert.equal(D.readable(180, true), 0);
  const p = part("std-c", 10, 5, 0, {designator: {x: 0, y: -1.2, angle: 0, height: .8}});
  const def = catalogue.get("std-c");
  let l = D.label(p, def);
  assert.deepEqual(l.center.map(v => +v.toFixed(9)), [10, 3.8]); assert.equal(l.angle, 0);
  p.angle = 180; l = D.label(p, def);
  assert.deepEqual(l.center.map(v => +v.toFixed(9)), [10, 6.2]); assert.equal(l.angle, 0, "never upside down");
  p.angle = 90; l = D.label(p, def);
  assert.equal(l.angle, 270, "rotating the part turns the text to read bottom-to-top");
  p.showRef = false; assert.equal(D.label(p, def), null);
});

test("Gerber stroke text drawn at label() stays inside the designator box", () => {
  for (const m of ["pcb-pours", "pcb-appearance", "zip", "fab-outputs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
  const F = globalThis.AtriumFabOutputs, def = catalogue.get("std-c");
  for (const [angle, layer, rel, ref] of [[0, "Top", 0, "C12"], [90, "Top", 0, "U7"], [30, "Top", 90, "Jg1"], [90, "Bottom", 0, "R100"], [180, "Bottom", 90, "C3"]]) {
    const p = part("std-c", 3, 4, angle, {ref, layer, designator: {x: .4, y: -1.3, angle: rel, height: .9}});
    const l = D.label(p, def), t = F.strokeText(l.text, l.anchor, l.angle, l.height, "center", l.mirror);
    const pts = t.strokes.flat(), b = A.bounds(pts), half = l.stroke / 2, e = 1e-6;
    assert.ok(b[0] - half >= l.box[0] - e && b[2] + half <= l.box[2] + e && b[1] - half >= l.box[1] - e && b[3] + half <= l.box[3] + e, ref + " strokes " + b + " box " + l.box);
    // Text fills the box along its reading direction (tight, not padded).
    const vertical = l.angle % 180 !== 0, span = vertical ? b[3] - b[1] : b[2] - b[0], box = vertical ? l.box[3] - l.box[1] : l.box[2] - l.box[0];
    assert.ok(span + l.stroke > box - .2 * l.height, ref + " box is tight");
  }
});

test("Gerber metrics: box width follows the stroke font", () => {
  const m = D.metrics("C12", 1);
  assert.ok(Math.abs(m.w - ((6 * 3 - 2) / 6 + 1 / 6)) < 1e-9);
  assert.ok(Math.abs(m.h - (1 + 1 / 6)) < 1e-9);
  assert.ok(D.metrics("Jg", 1).desc > 0);
});

test("a row of capacitors gets aligned top designators, clear of pads", () => {
  const items = [];
  for (let i = 0; i < 6; i++) items.push(part("std-c", 2 + i * 3.2, 5));
  const doc = {kind: "pcb", grid: .25, items, outline: [[0, 0], [22, 0], [22, 10], [0, 10]]};
  const r = D.plan(doc, catalogue);
  assert.equal(r.unplaced.length, 0);
  D.apply(doc, r);
  const labels = verify(doc, catalogue);
  assert.equal(labels.length, 6);
  const ys = new Set(labels.map(x => x.l.center[1].toFixed(6)));
  assert.equal(ys.size, 1, "one baseline for the row");
  assert.ok(labels.every(x => x.l.center[1] < 5 && x.l.angle === 0), "above and horizontal");
});

test("a column of rotated resistors gets vertical designators on one side", () => {
  const items = [];
  for (let i = 0; i < 5; i++) items.push(part("std-r", 5, 2 + i * 2.9, 90, {prefix: "R"}));
  const doc = {kind: "pcb", grid: .25, items, outline: [[0, 0], [12, 0], [12, 16.5], [0, 16.5]]};
  const r = D.plan(doc, catalogue);
  D.apply(doc, r);
  const labels = verify(doc, catalogue);
  assert.equal(r.unplaced.length, 0);
  // Vertical parts in a tight column: labels sit beside the parts, vertical, on one side.
  assert.ok(labels.every(x => x.l.angle === 270), "vertical text: " + labels.map(x => x.l.angle));
  assert.equal(new Set(labels.map(x => Math.sign(x.l.center[0] - 5))).size, 1, "same side");
});

test("near the board edge the designator moves inside", () => {
  const c = part("std-c", 1.6, .8);
  const doc = {kind: "pcb", grid: .25, items: [c], outline: [[0, 0], [10, 0], [10, 10], [0, 10]]};
  const r = D.plan(doc, catalogue);
  D.apply(doc, r);
  verify(doc, catalogue);
  assert.ok(D.label(c, catalogue.get("std-c")).center[1] >= .8 - 1e-9, "not above, since above leaves the board");
});

test("bottom-side parts mirror and use 0 / 90", () => {
  const items = [part("std-c", 5, 5, 90, {layer: "Bottom"}), part("std-c", 5, 5, 0)];
  const doc = {kind: "pcb", grid: .25, items, outline: [[0, 0], [10, 0], [10, 10], [0, 10]]};
  D.apply(doc, D.plan(doc, catalogue));
  const labels = verify(doc, catalogue);
  const bottom = labels.find(x => x.side === 2);
  assert.equal(bottom.l.mirror, true);
  assert.ok([0, 90].includes(bottom.l.angle));
});

test("no free position: reported with a suggestion, not forced onto pads", () => {
  // A capacitor boxed in by test-point pads on every side.
  const items = [part("std-c", 5, 5)];
  for (let x = 1.5; x <= 8.5; x += 1.4) for (let y = 1.5; y <= 8.5; y += 1.4) if (Math.abs(x - 5) > 1.9 || Math.abs(y - 5) > 1.2) items.push(part("std-tp", x, y, 0, {prefix: "TP", showRef: false}));
  const doc = {kind: "pcb", grid: .25, items, outline: [[0, 0], [10, 0], [10, 10], [0, 10]]};
  const r = D.plan(doc, catalogue, {minHeight: 0});
  assert.deepEqual(r.unplaced, [items[0].ref]);
  assert.match(r.issues[0].suggestion, /Hide|assembly/);
  assert.equal(r.moves.length, 0);
});

test("dense leftovers fall back to smaller text before giving up", () => {
  const items = [];
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) items.push(part("std-c", 2.5 + i * 3.6, 2.5 + j * 2.4, 0, {ref: "C" + (100 + i * 8 + j)}));
  const doc = {kind: "pcb", grid: .25, items, outline: [[0, 0], [30, 0], [30, 21], [0, 21]]};
  const r = D.plan(doc, catalogue, {height: 1});
  D.apply(doc, r);
  verify(doc, catalogue);
  console.log("  dense 8×8 grid: placed " + r.stats.placed + "/64, shrunk " + r.stats.shrunk + ", unplaced " + r.unplaced.length + ", " + r.stats.ms + " ms");
  assert.ok(r.stats.placed >= 60, "placed " + r.stats.placed);
  assert.ok(r.stats.shrunk > 0, "rows too tight for 1 mm text use the smaller height");
});

test("relayout keeps a moved part's clean designator and re-places one it now covers", () => {
  const a = part("std-c", 5, 5), b = part("std-c", 12, 5);
  const doc = {kind: "pcb", grid: .25, items: [a, b], outline: [[0, 0], [20, 0], [20, 12], [0, 12]]};
  D.apply(doc, D.plan(doc, catalogue));
  const bBefore = JSON.stringify(b.designator), aLabel = D.label(a, catalogue.get("std-c"));
  // Move b right on top of a's designator.
  b.x = aLabel.center[0]; b.y = aLabel.center[1] - .2;
  const r = D.relayout(doc, catalogue, [b.id]);
  const ids = r.moves.map(m => m.id);
  assert.ok(ids.includes(a.id), "a's covered designator is re-placed");
  D.apply(doc, r);
  verify(doc, catalogue);
  // Moving b again to clear space keeps its designator when it still fits.
  b.x = 14; b.y = 8;
  const again = D.relayout(doc, catalogue, [b.id]);
  assert.equal(again.stats.kept, 1);
  assert.ok(!again.moves.some(m => m.id === b.id));
  void bBefore;
});

test("sample board: every designator placed, legal and readable", () => {
  const proj = AtriumParts.example(), doc = proj.documents.find(d => d.kind === "pcb"), defs = new Map(proj.library.map(d => [d.id, d]));
  const r = D.plan(doc, defs, {project: proj});
  D.apply(doc, r);
  const labels = verify(doc, defs);
  console.log("  sample: " + labels.map(x => x.ref + "@" + x.l.center.map(v => v.toFixed(2)).join(",") + "/" + x.l.angle).join("  ") + "  (" + r.stats.ms + " ms)");
  assert.equal(r.unplaced.length, 0);
  assert.equal(labels.length, doc.items.filter(i => i.kind === "part").length);
});

// ---------------------------------------------------------------- benchmark
function synthetic(count, pitch = 1) {
  let seed = 11;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const kinds = ["std-c", "std-c", "std-r", "std-r", "std-opamp", "std-c", "std-j2", "std-r"];
  const items = [], cols = Math.ceil(Math.sqrt(count * 1.4));
  for (let i = 0; i < count; i++) {
    const def = kinds[i % kinds.length], col = i % cols, row = Math.floor(i / cols);
    const x = 3 + col * 4.2 * pitch + rnd() * .3, y = 3 + row * 3.4 * pitch + rnd() * .3;
    items.push(part(def, x, y, [0, 90, 180, 270][Math.floor(rnd() * 4)], {prefix: def === "std-r" ? "R" : def === "std-opamp" ? "U" : def === "std-j2" ? "J" : "C", layer: rnd() < .25 ? "Bottom" : "Top"}));
  }
  for (let i = 0; i < count / 2; i++) items.push({id: "v" + i, kind: "via", x: 3 + rnd() * cols * 4.2 * pitch, y: 3 + rnd() * (count / cols) * 3.4 * pitch, diameter: .6, drill: .3, layer: "Multi"});
  const w = cols * 4.2 * pitch + 4, h = Math.ceil(count / cols) * 3.4 * pitch + 4;
  return {kind: "pcb", grid: .25, items, outline: [[0, 0], [w, 0], [w, h], [0, h]]};
}
test("1,500-part synthetic board under 100 ms", () => {
  const doc = synthetic(1500);
  D.plan(doc, catalogue); // warm the JIT
  const t0 = now();
  const r = D.plan(doc, catalogue);
  const ms = now() - t0;
  D.apply(doc, r);
  verify(doc, catalogue);
  console.log("  1500 parts: " + ms.toFixed(1) + " ms total (setup " + r.stats.setupMs + " ms), placed " + r.stats.placed + ", shrunk " + r.stats.shrunk + ", unplaced " + r.stats.unplaced + ", " + r.stats.evaluated + " candidate evaluations, " + r.stats.rounds + " rounds");
  assert.ok(ms < 100, "plan under 100 ms: " + ms);
  assert.ok(r.stats.placed >= 1490);
  // Relayout of a handful of moved parts is interactive-fast.
  const moved = doc.items.filter(i => i.kind === "part").slice(700, 705);
  for (const m of moved) { m.x += 1.1; m.angle = (m.angle + 90) % 360; }
  const t1 = now();
  const rr = D.relayout(doc, catalogue, moved.map(m => m.id));
  const rms = now() - t1;
  D.apply(doc, rr);
  verify(doc, catalogue);
  console.log("  relayout 5 moved parts: " + rms.toFixed(1) + " ms, " + rr.moves.length + " designators moved, " + rr.stats.kept + " kept");
});
test("dense 2,000-part board", () => {
  const doc = synthetic(2000, .82);
  const t0 = now();
  const r = D.plan(doc, catalogue);
  const ms = now() - t0;
  D.apply(doc, r);
  verify(doc, catalogue);
  console.log("  2000 dense parts: " + ms.toFixed(1) + " ms, placed " + r.stats.placed + ", shrunk " + r.stats.shrunk + ", unplaced " + r.stats.unplaced);
  assert.ok(ms < 150, "dense plan time " + ms);
});

console.log(passed + " designator tests passed");
