"use strict";
// Poured copper in the design diff (app/history/diff.js pourChanges): copper is compared by geometry
// within copperTolerance, per (board, layer, net, polygon). The same copper stored another way
// (rotated rings, reversed ring / hole / region order, extra collinear vertices, ±30 nm float
// noise, regions split differently, other signatures) is no change and no suppressed difference;
// an island removed, an edge moved by 0.1 mm or copper on another net is found, counted in
// suppressed.pourFill by default and reported (with a box to highlight) with ignorePourFill off.
// Also times the comparison on the 25.6k-object dense board with ten pours.
// Run: scripts/test-jsc.sh diff-copper   (or node tests/history/diff-copper.cjs)
const assert = require("node:assert/strict");
const {nativeCAD} = require("../support/native-cad.cjs");
for (const m of ["model", "parts", "spatial", "pcb-appearance", "pcb-pours", "board-shape", "rules", "polygon-pour", "sch-objects", "hierarchy", "diff"])
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
try { require("../../app/engine-core.js"); } catch { /* JS core */ }
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const D = AtriumDiff, PP = AtriumPolygonPour, P = AtriumPCBPours;
const clone = v => JSON.parse(JSON.stringify(v));
const now = () => performance.now();
let seed = 7;
const rnd = () => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296; };
const jitter = () => (rnd() * 2 - 1) * 3e-5; // ±30 nm

// The same copper, stored another way: per ring a rotated start, every other ring reversed, a
// collinear midpoint on every third edge, ±30 nm noise on every vertex; holes and regions reversed;
// the first multi-island group's regions merged differently (every region kept, order reversed).
function reencode(doc) {
  const out = [];
  for (const r of doc.pcbDrawing.pours) {
    const rings = P.contours(r).map((xy, k) => {
      const n = xy.length >> 1, pts = [];
      for (let i = 0; i < n; i++) {
        const j = (i + 1 + k) % n, q = (j + 1) % n;
        pts.push([xy[2 * j] + jitter(), xy[2 * j + 1] + jitter()]);
        if (i % 3 === 0) pts.push([(xy[2 * j] + xy[2 * q]) / 2 + jitter(), (xy[2 * j + 1] + xy[2 * q + 1]) / 2 + jitter()]);
      }
      return k % 2 ? pts.reverse() : pts;
    });
    const [island, ...holes] = rings;
    const {layer, net, bounds, count, data, ...extra} = r;
    out.push(P.region([island, ...holes.reverse()], layer, net, {...extra, links: [...(extra.links || [])].reverse()}));
  }
  doc.pcbDrawing.pours = out.reverse();
  doc.pcbDrawing.pourSignatures = Object.fromEntries(Object.keys(doc.pcbDrawing.pourSignatures || {}).map(k => [k, "3:" + k]));
  doc.pcbDrawing.pourSignatureVersion = 3;
  doc.sourcePourSignature = "0123456789abcdef";
}
const project = () => {
  const p = nativeCAD("design-diff");
  const b = p.documents[1], defs = new Map(p.library.map(d => [d.id, d]));
  b.items.push(PP.make([[2, 2], [34, 2], [34, 20], [2, 20]], {id: "vddpour", net: "VDD", layer: "Top", pourIndex: 3}));
  // Two GND strips on Top, cut by a slot, so one pour has two islands.
  b.items.push(PP.make([[24, 14], [34, 14], [34, 20], [24, 20]], {id: "gndtop", net: "GND", layer: "Top", pourIndex: 1, removeDeadCopper: false}));
  b.items.push(PP.make([[28.6, 13], [29.2, 13], [29.2, 21], [28.6, 21]], {id: "slot", layer: "Top", cutout: true}));
  PP.apply(b, defs, {});
  return p;
};
const board = p => p.documents[1];
const sum = (r, k) => r.stats.suppressed[k];

const a = project();
assert.ok(board(a).pcbDrawing.pours.length >= 3, "the board pours: " + board(a).pcbDrawing.pours.length);
const gndTop = board(a).pcbDrawing.pours.filter(r => r.polygon === "gndtop");
assert.ok(gndTop.length >= 2, "the slot splits the Top GND pour into islands: " + gndTop.length);

// ------------------------------------------------------------------ representation only: nothing
{
  const b = clone(a); reencode(board(b));
  assert.notEqual(JSON.stringify(board(b).pcbDrawing.pours), JSON.stringify(board(a).pcbDrawing.pours));
  for (const opts of [{}, {ignorePourFill: false}, {ignorePourFill: false, ignoreMetadata: false}]) {
    const r = D.compare(a, b, opts);
    assert.deepEqual(r.changes.map(c => c.text), [], "re-encoded copper is no change " + JSON.stringify(opts));
    assert.equal(sum(r, "pourFill"), 0, "nor a suppressed one " + JSON.stringify(opts));
  }
  // An island stored in two entries a different way: the Top GND islands as one region each vs
  // merged by order into a single list of regions is still the same copper.
  const c = clone(a), d = board(c);
  d.pcbDrawing.pours = [...d.pcbDrawing.pours.filter(r => r.polygon === "gndtop").reverse(), ...d.pcbDrawing.pours.filter(r => r.polygon !== "gndtop")];
  assert.equal(sum(D.compare(a, c), "pourFill"), 0);
  assert.equal(D.compare(b, a).changes.length, 0, "symmetric");
  // The worker has no pcb-pours.js: diff.js decodes the regions itself, with the same result.
  const contours = P.contours, fromBase64 = Uint8Array.fromBase64;
  P.contours = undefined;
  Uint8Array.fromBase64 = undefined; // and the base64 fallback
  try {
    assert.equal(sum(D.compare(clone(a), clone(b)), "pourFill"), 0, "own decoder");
    const e = clone(b); board(e).pcbDrawing.pours.pop();
    assert.equal(sum(D.compare(clone(a), e), "pourFill"), 1, "own decoder finds a change");
  } finally { P.contours = contours; if (fromBase64) Uint8Array.fromBase64 = fromBase64; else delete Uint8Array.fromBase64; }
}

// ------------------------------------------------------------------ real copper changes: found
const cases = {
  "island removed": d => { const k = d.pcbDrawing.pours.findIndex(r => r.polygon === "gndtop"); d.pcbDrawing.pours.splice(k, 1); },
  "edge moved 0.1 mm": d => {
    const k = d.pcbDrawing.pours.findIndex(r => r.polygon === "vddpour"), r = d.pcbDrawing.pours[k];
    const rings = P.contours(r).map(xy => { const pts = []; for (let i = 0; i < xy.length; i += 2) pts.push([xy[i], xy[i + 1]]); return pts; });
    // The island's leftmost vertical edge moves 0.1 mm to the right.
    const o = rings[0], x0 = Math.min(...o.map(p => p[0]));
    for (const p of o) if (Math.abs(p[0] - x0) < 1e-6) p[0] += 0.1;
    const {layer, net, bounds, count, data, ...extra} = r;
    d.pcbDrawing.pours[k] = P.region(rings, layer, net, extra);
  },
  "other net": d => { const r = d.pcbDrawing.pours.find(x => x.polygon === "vddpour"); r.net = "VIN"; },
  "other layer": d => { const r = d.pcbDrawing.pours.find(x => x.polygon === "gndpour"); r.layer = "Top"; },
};
for (const [name, edit] of Object.entries(cases)) {
  const b = clone(a); reencode(board(b)); edit(board(b));
  const quiet = D.compare(a, b);
  assert.equal(quiet.changes.length, 0, name + ": suppressed by default");
  assert.ok(sum(quiet, "pourFill") >= 1, name + ": counted in suppressed.pourFill");
  const loud = D.compare(a, b, {ignorePourFill: false});
  const rows = loud.changes.filter(c => /^pour\.copper/.test(c.kind));
  assert.ok(rows.length >= 1 && rows.length === loud.changes.length, name + ": " + loud.changes.map(c => c.kind + " " + c.text).join(" | "));
  assert.equal(sum(loud, "pourFill"), 0);
  for (const c of rows) {
    assert.ok(c.geometry && c.geometry.box && c.geometry.box.every(Number.isFinite), name + ": a box to highlight");
    assert.equal(c.target.doc, board(b).id);
    assert.equal(c.category, "pcb");
  }
  if (name === "edge moved 0.1 mm") {
    // The box is around the moved edge (x ≈ 2.3 on the 2..34 pour), not the whole pour.
    const box = rows[0].geometry.box;
    assert.ok(box[2] < 6, "localised: " + JSON.stringify(box));
    assert.equal(rows[0].kind, "pour.copper");
  }
  if (name === "other net") {
    assert.deepEqual(rows.map(c => c.kind).sort(), ["pour.copper.added", "pour.copper.removed"]);
    assert.deepEqual(rows.map(c => c.status).sort(), ["added", "removed"]);
  }
}
// Below copperTolerance an edge move is noise; above it, a change (and the option can be widened).
{
  const shift = dx => { const b = clone(a), d = board(b), k = d.pcbDrawing.pours.findIndex(r => r.polygon === "vddpour"), r = d.pcbDrawing.pours[k];
    const rings = P.contours(r).map(xy => { const pts = []; for (let i = 0; i < xy.length; i += 2) pts.push([xy[i] + dx, xy[i + 1]]); return pts; });
    const {layer, net, bounds, count, data, ...extra} = r; d.pcbDrawing.pours[k] = P.region(rings, layer, net, extra); return b; };
  assert.equal(sum(D.compare(a, shift(0.0004)), "pourFill"), 0, "0.4 µm");
  assert.equal(sum(D.compare(a, shift(0.005)), "pourFill"), 1, "5 µm");
  assert.equal(sum(D.compare(a, shift(0.005), {copperTolerance: 0.01}), "pourFill"), 0, "copperTolerance widened");
}
// Other pcbDrawing content (annotations) is still compared as stored.
{
  const b = clone(a); board(b).pcbDrawing.annotations = {"components/data#0": [{field: "ref", at: [1, 2], angle: 0, size: 1, layer: "Top silk", mirrored: false}]};
  assert.equal(sum(D.compare(a, b), "pourFill"), 1);
  assert.ok(D.compare(a, b, {ignorePourFill: false, ignoreMetadata: false}).changes.some(c => c.kind === "document.setting" && c.target.field === "pcbDrawing"));
}

// ------------------------------------------------------------------ the dense board: time
{
  require("../pcb/dense-board.js");
  const {d, defs} = makeAtriumBenchmarkBoard(160);
  const W = 160 * 2.3, H = 160 * 1.72, nets = ["GND", "VCC", "V3", "V5", "AGND"];
  // Ten pours: five strips on each copper layer, alternate nets.
  for (let k = 0; k < 10; k++) {
    const layer = k < 5 ? "Top" : "Bottom", s = k % 5, x0 = s * W / 5 + .5, x1 = (s + 1) * W / 5 - .5;
    d.items.push(PP.make([[x0, .5], [x1, .5], [x1, H - .5], [x0, H - .5]], {id: "dp" + k, net: nets[s], layer, pourIndex: k, removeDeadCopper: false}));
  }
  const t0 = now();
  PP.apply(d, defs, {});
  const tPour = now() - t0;
  const p = {format: "atrium", version: 1, name: "Dense", library: AtriumParts.catalogue, documents: [d]};
  let vertices = 0; for (const r of d.pcbDrawing.pours) for (const xy of P.contours(r)) vertices += xy.length >> 1;
  const q = clone(p); reencode(q.documents[0]);
  // The copper comparison alone, then the whole diff.
  const groups = q.documents[0].pcbDrawing.pours.length;
  let t = now(), r = D.compare(p, q, {ignorePourFill: false});
  const tAll = now() - t;
  assert.equal(r.changes.length, 0, r.changes.slice(0, 3).map(c => c.text).join(" | "));
  assert.equal(sum(r, "pourFill"), 0);
  const plain = clone(p); delete plain.documents[0].pcbDrawing; delete plain.documents[0].sourcePourSignature; const plainQ = clone(plain);
  t = now(); D.compare(plain, plainQ); const tBase = now() - t;
  console.log("dense board: " + d.items.length + " objects, " + d.pcbDrawing.pours.length + " → " + groups + " regions, " + vertices + " vertices; pour " + Math.round(tPour) +
    " ms; diff " + Math.round(tAll) + " ms (without copper " + Math.round(tBase) + " ms, copper ≈ " + Math.round(tAll - tBase) + " ms)");
}
console.log("diff-copper ok");
