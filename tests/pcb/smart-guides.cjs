"use strict";
// Smart guides (drag alignment, equal spacing, pad alignment), align/distribute plans, benchmark.
// Node:  node tests/pcb/smart-guides.cjs [--bench]
// JSC:   jsc shim.js -- tests/pcb/smart-guides.cjs [--bench]
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/pcb/smart-guides.js");
const G = globalThis.AtriumGuides, A = globalThis.Atrium;
const now = () => globalThis.performance.now();
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= (eps ?? 1e-9), (msg || "") + " " + a + " vs " + b);
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

// The starter library has courtyards (so the sample passes DRC). These cases were written for the
// pads-and-body boxes, so they use the parts without their courtyard outlines.
const bare = d => { const c = JSON.parse(JSON.stringify(d)); if (c.footprint) { delete c.footprint.courtyard; c.footprint.shapes = (c.footprint.shapes || []).filter(s => s.style !== "courtyard"); } return c; };
const defs = new Map(AtriumParts.catalogue.map(d => [d.id, bare(d)]));
let n = 0;
const part = (def, x, y, angle = 0, extra = {}) => ({id: "p" + (++n), kind: "part", def, ref: "X" + n, value: "", x, y, angle, pinNets: {}, ...extra});
const board = (items, outline = []) => ({kind: "pcb", grid: .25, items, outline});
// std-c body box: x ±1.25 (pads), y ±0.475; std-j2 body box: x ±1.49, y ±2.54.

test("edge alignment snaps the top edge and overrides the grid on that axis only", () => {
  const ref = part("std-j2", 0, 0), mov = part("std-c", 10, -2.0);
  const s = G.begin(board([ref, mov]), defs, [mov.id]);
  const r = s.snap([0.03, 0], {scale: 20, threshold_px: 6, grid: .25, anchor: [10, -2]});
  close(r.delta[1], -0.065, 1e-9, "dy");
  assert.equal(r.snapped[1], true);
  assert.equal(r.snapped[0], false);
  close(r.delta[0], 0, 1e-9, "x falls back to the grid");
  const g = r.guides.find(x => x.kind === "edge" && x.y1 === x.y2);
  assert.ok(g, "horizontal edge guide");
  close(g.y1, -2.54);
  assert.ok(g.x1 <= -1.49 && g.x2 >= 10 + 1.25, "guide spans reference and moving part");
});

test("centre alignment", () => {
  const ref = part("std-j2", 0, 0), mov = part("std-c", 10, .1);
  const r = G.begin(board([ref, mov]), defs, [mov.id]).snap([0, 0], {scale: 20});
  close(r.delta[1], -.1);
  assert.ok(r.guides.some(x => x.kind === "center"));
});

test("pad-centre alignment lines up a rotated capacitor with its neighbour's pads", () => {
  const c1 = part("std-c", 0, 0), c2 = part("std-c", 3, .85, 90);
  const r = G.begin(board([c1, c2]), defs, [c2.id]).snap([0, 0], {scale: 20});
  close(r.delta[1], -.05, 1e-9, "pad wins over the nearer-looking edge");
  const g = r.guides.find(x => x.kind === "pad");
  assert.ok(g, "pad guide");
  close(g.y1, 0);
});

test("equal spacing in a row with PowerPoint-style markers", () => {
  const a = part("std-c", 0, 0), b = part("std-c", 4, 0), c = part("std-c", 8.1, 0);
  const r = G.begin(board([a, b, c]), defs, [c.id]).snap([0, 0], {scale: 20});
  close(r.delta[0], -.1, 1e-9, "dx");
  assert.equal(r.spacing.length, 2);
  for (const m of r.spacing) close(m.gap, 1.5, 1e-9, "gap");
});

test("equal spacing centred between two neighbours in a column", () => {
  const a = part("std-c", 0, 0), b = part("std-c", 0, 6), c = part("std-c", 0, 3.2);
  const r = G.begin(board([a, b, c]), defs, [c.id]).snap([0, 0], {scale: 20, threshold_px: 6});
  close(r.delta[1], -.2, 1e-9, "dy");
  assert.equal(r.spacing.length, 2);
  close(r.spacing[0].gap, r.spacing[1].gap, 1e-9);
});

test("board outline edges and centre are references; suspend keeps only the grid", () => {
  const mov = part("std-c", 5, 5);
  const doc = board([mov], [[0, 0], [20, 0], [20, 10], [0, 10]]);
  const s = G.begin(doc, defs, [mov.id]);
  const r = s.snap([4.9, .1], {scale: 20});
  close(r.delta[0], 5, 1e-9, "centre on the board centre x");
  close(r.delta[1], 0, 1e-9, "centre on the board centre y");
  const left = s.snap([-3.8, 0], {scale: 20});
  close(left.delta[0], -3.75, 1e-9, "left edge on the outline");
  const off = s.snap([4.93, .1], {scale: 20, suspend: true, grid: .25, anchor: [5, 5]});
  close(off.delta[0], 5); close(off.delta[1], 0);
  assert.equal(off.guides.length, 0);
});

test("gridOnly keeps schematic anchors on the grid", () => {
  const r1 = {id: "s1", kind: "part", def: "std-r", ref: "R1", value: "", x: 0, y: 0, angle: 0};
  const r2 = {id: "s2", kind: "part", def: "std-c", ref: "C1", value: "", x: 15.24, y: 5.08, angle: 0};
  const doc = {kind: "schematic", grid: 1.27, items: [r1, r2], outline: []};
  const s = G.begin(doc, defs, ["s2"]);
  // Pins share y at a grid multiple: accepted.
  const pin = s.snap([0, -5.0], {scale: 4, grid: 1.27, anchor: [15.24, 5.08], gridOnly: true});
  close(pin.delta[1], -5.08); assert.equal(pin.snapped[1], true);
  // The capacitor symbol's top edge lines up only off-grid: rejected, the grid wins.
  const box = G.itemBox(r2, defs, "schematic"), ref = G.itemBox(r1, defs, "schematic");
  const dy = ref[1] - box[1];
  const edge = s.snap([0, dy + .05], {scale: 4, grid: 1.27, anchor: [15.24, 5.08], gridOnly: true});
  const y = 5.08 + edge.delta[1];
  close(A.snap(y, 1.27), y, 1e-9, "on grid");
});

test("viewport restriction drops far references", () => {
  const far = part("std-c", 500, 0), mov = part("std-c", 0, 3);
  const s = G.begin(board([far, mov]), defs, [mov.id], {viewport: [-10, -10, 10, 10], margin: 5});
  assert.equal(s.stats.boxes, 0);
});

test("align left / right / top / bottom / centres", () => {
  const a = part("std-c", 0, 0), b = part("std-j2", 5, 1), c = part("std-c", 9, -3);
  const doc = board([a, b, c]), ids = [a.id, b.id, c.id];
  const left = G.align(doc, defs, ids, "left");
  const box = id => G.itemBox(doc.items.find(i => i.id === id), defs, "pcb");
  const moved = (p, id) => { const m = p.moves.find(x => x.id === id) || {dx: 0, dy: 0}; const b0 = box(id); return [b0[0] + m.dx, b0[1] + m.dy, b0[2] + m.dx, b0[3] + m.dy]; };
  for (const id of ids) close(moved(left, id)[0], -1.25);
  assert.equal(left.moves.length, 2, "the leftmost stays");
  const right = G.align(doc, defs, ids, "right"); for (const id of ids) close(moved(right, id)[2], 10.25);
  const top = G.align(doc, defs, ids, "top"); for (const id of ids) close(moved(top, id)[1], -3.475);
  const bottom = G.align(doc, defs, ids, "bottom"); for (const id of ids) close(moved(bottom, id)[3], 3.54);
  const hc = G.align(doc, defs, ids, "hcenter"); for (const id of ids) { const m = moved(hc, id); close((m[0] + m[2]) / 2, 4.5); }
  const vc = G.align(doc, defs, ids, "vcenter"); for (const id of ids) { const m = moved(vc, id); close((m[1] + m[3]) / 2, (-3.475 + 3.54) / 2); }
});

test("distribute horizontally and vertically gives equal gaps", () => {
  const a = part("std-c", 0, 0), b = part("std-c", 1.7, 0), c = part("std-c", 10, 0);
  const doc = board([a, b, c]);
  const p = G.distribute(doc, defs, [a.id, b.id, c.id], "x");
  assert.equal(p.moves.length, 1);
  close(p.moves[0].dx, 3.3); close(p.moves[0].dy, 0);
  const d = part("std-c", 0, 0), e = part("std-j2", 0, 3), f = part("std-c", 0, 12);
  const doc2 = board([d, e, f]);
  const q = G.distribute(doc2, defs, [d.id, e.id, f.id], "y");
  G.applyPlan(doc2, defs, q);
  const bx = [d, e, f].map(i => G.itemBox(i, defs, "pcb"));
  close(bx[1][1] - bx[0][3], bx[2][1] - bx[1][3], 1e-9, "gaps");
});

test("align to grid and make a row / column at pitch", () => {
  const a = part("std-c", .13, 1.01), b = part("std-c", 3.1, .2), c = part("std-c", 5, -.1);
  const doc = board([a, b, c]);
  const g = G.alignToGrid(doc, defs, [a.id], .25);
  close(g.moves[0].dx, .12); close(g.moves[0].dy, -.01);
  const row = G.array(doc, defs, [a.id, b.id, c.id], "x", 2);
  G.applyPlan(doc, defs, row);
  assert.deepEqual([a, b, c].map(i => [i.x, i.y]), [[.13, 1.01], [2.13, 1.01], [4.13, 1.01]]);
  const col = G.array(doc, defs, [a.id, b.id, c.id], "y", 1.5, {align: false});
  G.applyPlan(doc, defs, col);
  assert.deepEqual([a, b, c].map(i => i.y).sort((p, q) => p - q), [1.01, 2.51, 4.01]);
  assert.throws(() => G.array(doc, defs, [a.id], "x", 0));
});

test("align plans move schematic wires with their parts", () => {
  const r1 = {id: "s1", kind: "part", def: "std-r", ref: "R1", value: "", x: 0, y: 0, angle: 0};
  const r2 = {id: "s2", kind: "part", def: "std-r", ref: "R2", value: "", x: 20, y: 3.81, angle: 0};
  const pin = A.pins(r2, defs.get("std-r"), "schematic")[0].at;
  const w = {id: "w", kind: "wire", points: [[pin[0] - 5.08, pin[1]], pin]};
  const doc = {kind: "schematic", grid: 1.27, items: [r1, r2, w], outline: []};
  G.applyPlan(doc, defs, G.align(doc, defs, ["s1", "s2"], "top"));
  close(r2.y, 0);
  assert.ok(A.same(w.points.at(-1), A.pins(r2, defs.get("std-r"), "schematic")[0].at), "wire end follows the pin");
});

test("draw paints guides and spacing markers in screen space", () => {
  const calls = [];
  const ctx = new Proxy({}, {get: (t, k) => k in t ? t[k] : (...a) => { calls.push(k); return {width: 20}; }, set: (t, k, v) => { t[k] = v; return true; }});
  const a = part("std-c", 0, 0), b = part("std-c", 4, 0), c = part("std-c", 8.1, 0);
  const r = G.begin(board([a, b, c]), defs, [c.id]).snap([0, 0], {scale: 20});
  G.draw(ctx, r, {scale: 20, dpr: 2, worldToScreen: p => [p[0] * 20, p[1] * 20]});
  assert.ok(calls.includes("setTransform") && calls.filter(k => k === "stroke").length >= 2);
});

// ---------------------------------------------------------------- benchmark
test("2,000-part board: begin once, snap per pointer move", () => {
  const items = [];
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const kinds = ["std-c", "std-r", "std-opamp", "std-j3"];
  for (let i = 0; i < 2000; i++) items.push(part(kinds[i % 4], (i % 50) * 4 + rnd() * .4, Math.floor(i / 50) * 4 + rnd() * .4, [0, 90, 180, 270][i % 4]));
  const doc = board(items, [[-5, -5], [205, -5], [205, 165], [-5, 165]]);
  const moving = [items[1020].id, items[1021].id];
  const t0 = now();
  const s = G.begin(doc, defs, moving, {viewport: [-10, -10, 210, 170]});
  const beginMs = now() - t0;
  let snapped = 0;
  const N = 4000;
  // Warm up, then time.
  for (let i = 0; i < 200; i++) s.snap([rnd() * 10 - 5, rnd() * 10 - 5], {scale: 8, grid: .25, anchor: [items[1020].x, items[1020].y]});
  const t1 = now();
  for (let i = 0; i < N; i++) {
    const r = s.snap([rnd() * 40 - 20, rnd() * 40 - 20], {scale: 8, grid: .25, anchor: [items[1020].x, items[1020].y]});
    if (r.snapped[0] || r.snapped[1]) snapped++;
  }
  const per = (now() - t1) / N;
  console.log("  begin " + beginMs.toFixed(2) + " ms (" + s.stats.references + " references, " + s.stats.boxes + " boxes); snap " + (per * 1000).toFixed(1) + " µs/move; " + snapped + "/" + N + " moves snapped");
  assert.ok(per < .3, "snap per move under 0.3 ms: " + per);
  assert.ok(beginMs < 60, "begin under 60 ms: " + beginMs);
});

console.log(passed + " smart-guide tests passed");
