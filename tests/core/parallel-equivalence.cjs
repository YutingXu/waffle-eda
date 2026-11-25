"use strict";
// Serial and parallel / flattened paths give identical results.
//   1. KiCad export: the indexed fracture (kicad-export.js) against the plain left-to-right scan it
//      replaced (kept here as the reference), on rings with many ties (holes in rows and columns,
//      shared y values, holes whose bridge lands on an earlier bridge) and on real poured copper.
//   2. Parallel Repour All (polygon-pour.js repourParallel on a pool) against apply(), byte for byte.
// Runs under Node and under the JSC shim (scripts/test-jsc.sh).
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "query", "viastack", "rooms", "component-classes", "pcb-pours", "polygon-pour",
  "rules", "pcb-text-rich", "pcb-text", "pcb-draw", "zip", "kicad-export"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
require("../pcb/dense-board.js");
try { require("../../app/engine-core.js"); } catch { /* JS core only */ }
const A = Atrium, K = AtriumKiCad, PP = AtriumPolygonPour;

// ------------------------------------------------------------------ 1. fracture
// The reference: the scan over every edge of the growing ring, one array copy per hole.
const signedArea = r => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
function fractureReference(rings) {
  const list = rings.filter(r => r.length >= 3); if (!list.length) return null;
  let o = 0; for (let i = 1; i < list.length; i++) if (Math.abs(signedArea(list[i])) > Math.abs(signedArea(list[o]))) o = i;
  let outer = list[o].slice();
  if (signedArea(outer) < 0) outer.reverse();
  const minX = r => r.reduce((m, p) => Math.min(m, p[0]), Infinity);
  const holes = list.filter((_, i) => i !== o).map(r => { const h = r.slice(); if (signedArea(h) > 0) h.reverse(); return h; }).sort((a, b) => minX(a) - minX(b));
  for (const h of holes) {
    let mi = 0; for (let i = 1; i < h.length; i++) if (h[i][0] < h[mi][0] || h[i][0] === h[mi][0] && h[i][1] < h[mi][1]) mi = i;
    const M = h[mi]; let best = null;
    for (let i = 0; i < outer.length; i++) {
      const p = outer[i], q = outer[(i + 1) % outer.length];
      if ((p[1] > M[1]) === (q[1] > M[1])) continue;
      const x = p[0] + (M[1] - p[1]) * (q[0] - p[0]) / (q[1] - p[1]);
      if (x <= M[0] && (!best || x > best.x)) best = {x, i};
    }
    if (!best) continue;
    const I = [best.x, M[1]], loop = [...h.slice(mi), ...h.slice(0, mi), M];
    outer = [...outer.slice(0, best.i + 1), I, ...loop, I, ...outer.slice(best.i + 1)];
  }
  return outer;
}
const text = r => r === null ? "null" : r.map(p => p[0] + "," + p[1]).join(" ");
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const square = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
const diamond = (x, y, s) => [[x, y - s], [x + s, y], [x, y + s], [x - s, y]];
const cases = [];
cases.push([square(0, 0, 10), square(2, 2, 2).reverse(), square(6, 6, 2), square(2, 6, 1)]);
// Rows and columns of identical holes: every hole of a row has the same y, so rays run through
// earlier bridges and vertices (ties broken by ring order).
for (const n of [3, 8, 20]) {
  const r = [square(0, 0, n * 3 + 2)];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) r.push((i + j) % 3 ? square(1 + i * 3, 1 + j * 3, 1.5) : diamond(2 + i * 3, 2 + j * 3, .7));
  cases.push(r);
}
// Random holes on a coarse grid (many shared coordinates), some outside the outer ring.
for (let c = 0; c < 40; c++) {
  const r = [c % 2 ? square(0, 0, 50) : [[0, 0], [50, 0], [50, 20], [30, 25], [50, 30], [50, 50], [0, 50], [10, 25]]];
  const n = 5 + Math.floor(rnd() * 60);
  for (let k = 0; k < n; k++) {
    const x = Math.round(rnd() * 24) * 2, y = Math.round(rnd() * 24) * 2, s = 1 + Math.floor(rnd() * 2) * .5;
    r.push(rnd() < .5 ? square(x, y, s) : diamond(x + 1, y + 1, s / 2));
  }
  cases.push(r);
}
cases.push([square(0, 0, 1)], [], [[[0, 0], [1, 1]]]);
// Real copper: the pours of the benchmark board (one GND / VCC pair per side and six net pours).
{
  const {d, defs} = makeAtriumBenchmarkBoard(40), p = A.project("Fracture"); p.documents = [d]; p.library = [...defs.values()];
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 16), "2": "N" + ((k + 1) % 16)}; else if (i.kind !== "track") i.net = "N" + (k % 16); k++; }
  const b = A.bounds(d.outline), w = b[2] - b[0], h = b[3] - b[1];
  const rect = (x0, y0, x1, y1) => [[b[0] + x0 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y1 * h], [b[0] + x0 * w, b[1] + y1 * h]];
  [["Top", "GND", rect(0, 0, .5, 1)], ["Top", "VCC", rect(.5, 0, 1, 1)], ["Bottom", "GND", rect(0, 0, 1, .5)], ["Bottom", "N3", rect(.1, .1, .4, .3)]]
    .forEach(([layer, net, o], j) => d.items.push(PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: false})));
  PP.apply(d, defs, {project: p});
  let holes = 0;
  for (const region of d.pcbDrawing.pours) {
    const rings = AtriumPCBPours.contours(region).map(xy => { const r = []; for (let i = 0; i < xy.length; i += 2) r.push([xy[i], xy[i + 1]]); return r; });
    holes += rings.length - 1; cases.push(rings);
  }
  assert.ok(holes > 100, "the benchmark pours have holes (" + holes + ")");
}
for (const [n, c] of cases.entries()) assert.equal(text(K.fracture(c)), text(fractureReference(c)), "fracture case " + n);
// The UUID v5 names (flattened SHA-1) against the textbook version it replaced.
{
  const enc = new TextEncoder(), ns = Uint8Array.from([0x27, 0x77, 0xf2, 0x22, 0x74, 0x9b, 0x46, 0x85, 0xa1, 0xd8, 0x49, 0x96, 0xd0, 0xfa, 0x58, 0x21]);
  const rol = (x, n) => (x << n) | (x >>> (32 - n));
  const ref = name => {
    const text = enc.encode(name), length = 16 + text.length, input = new Uint8Array(Math.ceil((length + 9) / 64) * 64);
    input.set(ns); input.set(text, 16); input[length] = 128;
    const view = new DataView(input.buffer); view.setUint32(input.length - 4, length * 8);
    const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0], w = new Int32Array(80);
    for (let p = 0; p < input.length; p += 64) {
      for (let i = 0; i < 16; i++) w[i] = view.getInt32(p + i * 4);
      for (let i = 16; i < 80; i++) w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      let [a, b, c, d, e] = h;
      for (let i = 0; i < 80; i++) {
        const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
        const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
        const t = (rol(a, 5) + f + e + k + w[i]) | 0; e = d; d = c; c = rol(b, 30); b = a; a = t;
      }
      [a, b, c, d, e].forEach((v, i) => h[i] = (h[i] + v) | 0);
    }
    const bytes = new Uint8Array(16), v = new DataView(bytes.buffer);
    for (let i = 0; i < 4; i++) v.setInt32(i * 4, h[i]);
    bytes[6] = bytes[6] & 15 | 80; bytes[8] = bytes[8] & 63 | 128;
    const hex = Array.from(bytes, x => x.toString(16).padStart(2, "0")).join("");
    return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20);
  };
  const names = ["", "a", "x".repeat(47), "x".repeat(48), "y".repeat(55), "z".repeat(56), "w".repeat(119), "v".repeat(300), "Ω board \u001f id/segment/3", "\u{1F600}" + "q".repeat(70)];
  for (let i = 0; i < 400; i++) names.push("doc-" + i + "\u001f" + "item".repeat(i % 37) + "/pad/" + i);
  for (const s of names) assert.equal(K.uid(s), ref(s), "uid " + JSON.stringify(s));
  console.log("PASS KiCad UUIDs: " + names.length + " names identical to the reference SHA-1");
}
console.log("PASS fracture: " + cases.length + " ring sets identical to the reference scan");

// ------------------------------------------------------------------ 2. parallel repour
// repourParallel (solves on a pool, in any finishing order) stores the same copper, byte for byte,
// as the serial Repour All. The mock pools answer in shuffled order, as workers would.
(async () => {
  const board = (size, polys) => {
    const {d, defs} = makeAtriumBenchmarkBoard(size), p = A.project("Pours"); p.documents = [d]; p.library = [...defs.values()];
    let k = 0;
    for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 16), "2": "N" + ((k + 1) % 16)}; else if (i.kind !== "track") i.net = "N" + (k % 16); k++; }
    const b = A.bounds(d.outline), w = b[2] - b[0], h = b[3] - b[1];
    const rect = (x0, y0, x1, y1) => [[b[0] + x0 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y0 * h], [b[0] + x1 * w, b[1] + y1 * h], [b[0] + x0 * w, b[1] + y1 * h]];
    polys.forEach(([layer, net, o, extra], j) => d.items.push(PP.make(rect(...o), {layer, net, pourIndex: j, removeDeadCopper: j % 3 === 0, ...extra})));
    return {p, d, defs};
  };
  // The perf-pour layout: GND / VCC halves per side, six small net pours over them; plus a pour on an
  // inner layer, one with no net, one of a net already poured, and a hatched pour.
  const layout = [["Top", "GND", [0, 0, .5, 1]], ["Top", "VCC", [.5, 0, 1, 1]], ["Bottom", "GND", [0, 0, 1, .5]], ["Bottom", "VCC", [0, .5, 1, 1]],
    ...[0, 1, 2, 3, 4, 5].map(j => [j % 2 ? "Top" : "Bottom", "N" + j, [.03 + j * .15, .04, .14 + j * .15, .15]]),
    ["Inner 1", "GND", [0, 0, 1, 1]], ["Top", "", [.4, .4, .6, .6]], ["Top", "GND", [.45, .7, .55, .8]], ["Bottom", "N7", [.6, .6, .9, .9], {fillMode: "hatched"}]];
  // A pool that answers its waiting tasks in a random order, after a macrotask, so several
  // solves are in flight at once and finish out of pour order.
  let seed2 = 11;
  const shuffledPool = (size = 4) => {
    const waiting = [];
    return {size, available: true, run(task) {
      return new Promise((ok, no) => {
        waiting.push([task, ok, no]);
        setTimeout(() => {
          const k = Math.min(waiting.length - 1, Math.floor(((seed2 = (seed2 * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * waiting.length));
          const [t, yes, nope] = waiting.splice(k, 1)[0];
          try { yes(PP._internal.core.solve(t)); } catch (e) { nope(e); }
        }, 0);
      });
    }};
  };
  const json = d => JSON.stringify(d.pcbDrawing);
  for (const [size, polys, label] of [[40, layout, "benchmark 40"], [24, layout.slice(0, 4), "halves"], [60, layout.slice(0, 10), "perf-pour layout"]]) {
    const a = board(size, polys), copy = () => { const p = JSON.parse(JSON.stringify(a.p)); return {p, d: p.documents[0], defs: new Map(p.library.map(x => [x.id, x]))}; };
    const b = copy(), c = copy();
    PP.apply(a.d, a.defs, {project: a.p});
    const deps = PP.pourDependencies(b.d, b.defs, PP.polygons(b.d), {project: b.p});
    const result = await PP.repourParallel(b.d, b.defs, {project: b.p}, shuffledPool());
    PP.apply(b.d, b.defs, {project: b.p, result});
    assert.equal(json(b.d), json(a.d), label + ": parallel repour stores the serial copper");
    // Without a pool (headless), the same answer.
    PP.apply(c.d, c.defs, {project: c.p, result: await PP.repourParallel(c.d, c.defs, {project: c.p}, null)});
    assert.equal(json(c.d), json(a.d), label + ": no pool");
    // Copper is a pure function of the board: 1, 2 and 8 workers answering in random order, the view
    // priority (pours in view first), the JS core and the Rust/WebAssembly core, and a repour whose
    // reuse book was filled by another order of runs all store the same bytes.
    for (const n of [1, 2, 8]) {
      const e = copy();
      if (n === 2) PP.noteView([0, 0, 10, 10], 4, e.d);
      PP.apply(e.d, e.defs, {project: e.p, result: await PP.repourParallel(e.d, e.defs, {project: e.p}, shuffledPool(n))});
      PP.noteView([-1e9, -1e9, 1e9, 1e9], 1, null);
      assert.equal(json(e.d), json(a.d), label + ": " + n + " workers");
    }
    {
      const e = copy(), engine = globalThis.AtriumEngine;
      try { delete globalThis.AtriumEngine; PP.apply(e.d, e.defs, {project: e.p, reuse: false}); } finally { if (engine) globalThis.AtriumEngine = engine; }
      assert.equal(json(e.d), json(a.d), label + ": JS core and " + (engine ? "WebAssembly core" : "JS core") + " agree");
    }
    // Partial repour (only some pours), as Repour Selected and live pours ask.
    const ids = PP.polygons(a.d).filter((_, k) => k % 2).map(x => x.id);
    for (const it of a.d.items) if (it.kind === "via") { it.x += .05; break; }
    for (const it of b.d.items) if (it.kind === "via") { it.x += .05; break; }
    PP.apply(a.d, a.defs, {project: a.p, only: ids});
    PP.apply(b.d, b.defs, {project: b.p, only: ids, result: await PP.repourParallel(b.d, b.defs, {project: b.p, only: ids}, shuffledPool())});
    assert.equal(json(b.d), json(a.d), label + ": partial parallel repour");
    console.log("PASS parallel repour (" + label + "): " + a.d.pcbDrawing.pours.length + " regions identical; dependency chains " +
      deps.map((x, k) => k + ":" + (x.join(",") || "-")).join(" "));
  }
})().catch(e => { console.log("FAIL " + (e && e.stack || e)); throw e; });
