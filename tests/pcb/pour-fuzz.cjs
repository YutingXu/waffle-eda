"use strict";
// Property-based fuzzing of the polygon pour core against an independent reference
// (tests/pcb/pour-reference.js: exact slab XOR, brute-force windings, ring validity, keep() from the
// unfiltered islands). Every task is solved by the JS core, by each Rust/WebAssembly build that
// loads (SIMD and MVP), and packed as the pour workers receive it; all must give identical
// islands, and those islands must match the reference within one grid unit (10 nm).
// Inputs are built to be degenerate: collinear and coincident edges, zero-length segments,
// touching and overlapping holes, one-unit slivers, near-coincident vertices, arcs approximated at
// tiny and huge radii, coordinates at the 2^24 limit, self-intersecting outlines, relief spokes at
// odd angles, anchors, dead-copper removal and area and size thresholds. A two-stage case solves
// the pour less the earlier pours, then clears those from its islands (as untiled repours do).
//
// A failure is shrunk (shapes, anchors, vertices, flags dropped while it still fails) and printed
// as a fixture; tests/fixtures/pour-fuzz/regressions.json keeps every one found so far, and they
// run first, every time.
//   scripts/test-jsc.sh pour-fuzz                       the seed-pinned short run (CI)
//   ATRIUM_POUR_FUZZ=20000 node tests/pcb/pour-fuzz.cjs     a long run (ATRIUM_POUR_FUZZ_SEED picks the seed;
//                                                        ATRIUM_POUR_FUZZ_SAVE=1 appends shrunk failures)
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const env = name => globalThis[name] ?? process.env[name];
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "pcb-text-rich", "pcb-text", "stackup", "rules", "viastack", "board-shape", "polygon-pour"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
try { require("../../app/engine-core.js"); } catch { /* the JS core alone */ }
require("./pour-reference.js");
const PP = AtriumPolygonPour, REF = AtriumPourReference, engine = globalThis.AtriumEngine;
const core = PP._internal.PourCore();

// The cores every task runs on: JS, then each WebAssembly build that loads here.
const kernels = [];
if (engine?.available && env("ATRIUM_ENGINE") !== "js") {
  for (const kind of engine.candidates || []) { try { const k = engine.create(kind); if (k.available) kernels.push([kind, k]); } catch { /* not here */ } }
  if (!kernels.length) kernels.push([engine.variant, engine]);
}
const withEngine = (on, f) => { const e = globalThis.AtriumEngine; globalThis.AtriumEngine = on || undefined; try { return f(); } finally { globalThis.AtriumEngine = e; } };
const jsSolve = task => withEngine(null, () => core.solve(task));
const clean = r => r && r.islands.map(i => ({ring: Array.from(i.ring), tags: Array.from(i.tags), links: Array.from(i.links),
  holes: i.holes.map(h => ({ring: Array.from(h.ring), tags: Array.from(h.tags)}))}));
const statsOf = s => Object.fromEntries(Object.entries(s).filter(([k]) => !/^t[A-Z]/.test(k)));

// ---------------------------------------------------------------- generators
function rng(seed) {
  let s = seed >>> 0 || 1;
  const r = () => { s = (Math.imul(s ^ s >>> 15, 0x2c1b3c6d) + 0x9e3779b9) >>> 0; s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  r.int = n => Math.floor(r() * n);
  r.pick = a => a[r.int(a.length)];
  r.range = (a, b) => a + (b - a) * r();
  return r;
}
const LIM = 16777216;
const clampI = v => Math.max(-LIM, Math.min(LIM, Math.round(v)));
function rect(x, y, w, h) { return [x, y, x + w, y, x + w, y + h, x, y + h]; }
function polyAround(cx, cy, n, r, phase = 0, jitter = 0, R) {
  const out = [];
  for (let i = 0; i < n; i++) { const a = phase + 6.283185307179586 * i / n, q = r * (1 + jitter * (R() - .5)); out.push(clampI(cx + q * Math.cos(a)), clampI(cy + q * Math.sin(a))); }
  return out;
}
function rotatedRect(cx, cy, len, w, deg) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), out = [];
  for (const [u, v] of [[0, -w / 2], [len, -w / 2], [len, w / 2], [0, w / 2]]) out.push(clampI(cx + u * c - v * s), clampI(cy + u * s + v * c));
  return out;
}
// One random ring in a box of side G at (ox, oy).
function ring(R, G, ox, oy, prev) {
  const x = ox + R.int(G), y = oy + R.int(G), w = 1 + R.int(Math.max(1, G / 2)), h = 1 + R.int(Math.max(1, G / 2));
  switch (R.int(11)) {
    case 0: return rect(x, y, w, h);
    case 1: { const out = []; for (let i = 3 + R.int(6); i > 0; i--) out.push(ox + R.int(G), oy + R.int(G)); return out; }           // self-crossing
    case 2: return polyAround(x, y, R.pick([8, 12, 16, 32, 64]), R.pick([1, 2, 3, 1 + R.int(G / 3)]), R() * 6.28, 0, R);     // arcs, tiny to large
    case 3: return [x, y, x + w, y, x + w, y + 1, x + 1, y + 1, x + 1, y + h, x, y + h];                                       // L, one unit thick
    case 4: return R() < .5 ? [x, y, x + w, y + h, x + w + 1, y + h] : rotatedRect(x, y, w, 1 + R.int(2), R.range(0, 360));  // slivers
    case 5: return rotatedRect(x, y, w, 1 + R.int(Math.max(1, h / 4)), R.range(0, 360));                                        // a spoke at any angle
    case 6: if (prev) { const d = R.pick([0, 0, 1, -1]), e = R.pick([0, 1, -1]); return prev.map((v, i) => clampI(v + (i & 1 ? e : d))); } return rect(x, y, w, h); // near-coincident
    case 7: { const r = rect(x, y, w, h), out = []; for (let i = 0; i < 8; i += 2) { out.push(r[i], r[i + 1], r[i], r[i + 1]); const j = (i + 2) % 8; out.push(Math.round((r[i] + r[j]) / 2), Math.round((r[i + 1] + r[j + 1]) / 2)); } return out; } // repeats, collinear
    case 8: { const p = polyAround(x, y, 5, 1 + R.int(G / 3), R() * 6.28, 0, R); return [0, 2, 4, 1, 3].flatMap(k => [p[2 * k], p[2 * k + 1]]); } // pentagram
    case 9: if (prev && prev.length >= 4) { const i = 2 * R.int(prev.length >> 1), j = (i + 2) % prev.length, s = R() < .5 ? 1 : -1; const mx = (prev[i] + prev[j]) / 2, my = (prev[i + 1] + prev[j + 1]) / 2, dx = prev[j] - prev[i], dy = prev[j + 1] - prev[i + 1];
      return [prev[i], prev[i + 1], prev[j], prev[j + 1], clampI(mx - s * dy), clampI(my + s * dx)]; } return rect(x, y, w, h);        // sharing an edge
    default: return polyAround(x, y, R.pick([3, 4, 6]), 1 + R.int(G / 2), R() * 6.28, .8, R);                                     // irregular convex-ish
  }
}
// A thermal relief group at (x, y): annulus (3), spokes (4) at an odd angle, relief pad (5), and its anchor.
function relief(R, x, y, r, gap, spoke) {
  const n = R.pick([8, 16, 32]), base = R.range(0, 90), spokes = [];
  for (let k = 0; k < 4; k += R() < .3 ? 2 : 1) spokes.push(rotatedRect(x, y, r + gap + spoke + 2, spoke, base + 90 * k));
  return {shapes: [[3, polyAround(x, y, n, r + gap, 0, 0, R)], ...spokes.map(s => [4, s]), [5, polyAround(x, y, n, r, .1, 0, R)]], anchor: polyAround(x, y, n, r + 1, 0, 0, R)};
}
function task(seed) {
  const R = rng(seed), G = R.pick([8, 16, 64, 1000, 100000, 4000000, LIM]), huge = G === LIM;
  const ox = huge ? -LIM : R.int(3) - 1, oy = huge ? -LIM : 0, span = huge ? 2 * LIM : G;
  const K = 6 + R.int(3), shapes = [], anchors = [], push = (cls, ring, sign = 1) => {
    const n = ring.length >> 1, tags = R() < .25 ? Array.from({length: n}, () => R() < .5 ? R.int(4) : -1) : null;
    shapes.push({cls, sign, ring: Int32Array.from(ring.map(clampI)), tags: tags && Int32Array.from(tags)});
  };
  // The polygon outline: a box, or a self-intersecting user outline.
  if (R() < .7) push(0, rect(ox, oy, span, span)); else push(0, ring(R, span, ox, oy), R() < .9 ? 1 : -1);
  if (R() < .2) push(0, ring(R, span, ox, oy));
  if (R() < .5) push(1, R() < .5 ? rect(ox + R.int(3) - 1, oy + 1, span - 2, span) : ring(R, span, ox, oy));
  let prev = null;
  for (let i = R.int(16); i > 0; i--) {
    const r = ring(R, span, ox, oy, prev);
    prev = r;
    push(R.pick([2, 2, 2, 3, 4, 5, 6, 7, 8]) % K, r, R() < .85 ? 1 : -1);
  }
  for (let i = R.int(3); i > 0; i--) {
    const s = Math.max(4, span / 20), g = relief(R, ox + R.int(span), oy + R.int(span), 1 + R.int(s), 1 + R.int(s), 1 + R.int(Math.max(1, s / 2)));
    for (const [cls, r] of g.shapes) push(cls, r);
    anchors.push(g.anchor);
  }
  for (let i = R.int(4); i > 0; i--) anchors.push(R() < .5 ? ring(R, span, ox, oy) : rect(ox + R.int(span), oy + R.int(span), 1 + R.int(span / 8), 1 + R.int(span / 8)));
  const area = span * span;
  const t = {shapes, K, hasBoard: shapes.some(s => s.cls === 1), anchors: anchors.map(a => Int32Array.from(a.map(clampI))),
    removeDead: R() < .5, minArea: R() < .3 ? Math.floor(R() * area / 50) + .25 : 0, minSize: R() < .3 ? R.int(Math.max(2, span / 10)) : 0,
    twoStage: R() < .3};
  // Remove Necks (mode 1) or Outlines Only (mode 2) on a third of the tasks below the 2^24 limit.
  // Arc approximations as pours use them: 8 to about 50 template vertices.
  if (!huge && G >= 16 && R() < .35) { const r = 4 + R.int(Math.max(1, span / 12)); t.morph = morphFor(R() < .75 ? 1 : 2, r, Math.max(1, r * R.pick([.002, .01, .05, .2])), shapes); }
  return t;
}
// task.morph as polygon-pour.js morphOf builds it: the template from its discTemplate, the relief
// spokes (class 4) counter-clockwise as the rings never removed.
function morphFor(mode, r, tol, shapes) {
  const area2 = q => { let s = 0; const n = q.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) s += q[2 * j] * q[2 * i + 1] - q[2 * i] * q[2 * j + 1]; return s; };
  const keep = [];
  for (const s of shapes) {
    if (s.cls !== 4 || !(area2(s.ring) * s.sign > 0)) continue;
    if (area2(s.ring) > 0) keep.push(s.ring); else { const q = []; for (let i = s.ring.length - 2; i >= 0; i -= 2) q.push(s.ring[i], s.ring[i + 1]); keep.push(Int32Array.from(q)); }
  }
  const {t, k} = PP._internal.discTemplate(r, tol);
  return mode === 2 ? {mode, t, keep} : {mode, t, u: PP._internal.discTemplate(r + 3, tol, k).t, keep};
}

// ---------------------------------------------------------------- one case
const unfiltered = t => ({...t, removeDead: false, minArea: 0, minSize: 0});
const TOL = .75, TOL2 = 1.45; // grid units: snapping moves an edge by at most 0.71 units a stage (sqrt(2)/2)
// The failures of one task (empty when it passes) and its measurements.
function run(t) {
  const errors = [], m = {ms: 0, dev: 0, dev2: 0, xor: 0, unresolved: false, snapped: false};
  let js;
  try { const t0 = performance.now(); js = jsSolve(t); m.ms = performance.now() - t0; }
  catch (e) { return {errors: ["JS core threw: " + (e && e.message)], m}; }
  m.unresolved = !!js.stats.unresolved; m.snapped = js.stats.passes > 12;
  if (js.stats.brokenRings) errors.push("trace dropped " + js.stats.brokenRings + " broken ring(s)");
  const base = jsSolve(unfiltered(t));
  if (t.morph) {
    // The unshaped copper against the reference; the shaped copper against it (checkMorph); keep()
    // from the shaped islands.
    const plain = {...t, morph: null}, P = jsSolve(unfiltered(plain)), ref = REF.check(plain, jsSolve(plain), P, {tol: TOL});
    errors.push(...ref.errors.map(e => "unshaped: " + e)); m.dev = ref.maxDev; m.xor = ref.xorArea;
    errors.push(...REF.checkMorph(t, P, base, {tol: TOL}).errors);
    errors.push(...REF.check(t, js, base, {tol: TOL, probes: 0}).errors.filter(e => /keep\(\)|ring|cross|overlap|hole/.test(e)));
    m.morph = true;
  } else {
    const ref = REF.check(t, js, base, {tol: TOL});
    errors.push(...ref.errors); m.dev = ref.maxDev; m.xor = ref.xorArea;
  }
  const want = JSON.stringify(clean(js));
  for (const [kind, k] of kernels) {
    let got;
    try { got = k.pourSolve(t); } catch (e) { errors.push(kind + " threw: " + e.message); continue; }
    if (!got) { errors.push(kind + " refused the task"); continue; }
    if (JSON.stringify(clean(got)) !== want) errors.push(kind + " islands differ from the JS core");
    else if (JSON.stringify(statsOf(got.stats)) !== JSON.stringify(statsOf(js.stats))) errors.push(kind + " stats differ: " + JSON.stringify(statsOf(got.stats)) + " vs " + JSON.stringify(statsOf(js.stats)));
  }
  // Pooled: packed and cloned as postMessage would, solved by the worker's core.
  const {task: packed} = core.pack(t), copy = {...packed, head: Int32Array.from(packed.head), data: Int32Array.from(packed.data)};
  if (JSON.stringify(clean(jsSolve(copy))) !== want) errors.push("the packed (pooled) task solves differently");
  if (t.twoStage) {
    // Stage 1 without the earlier pours (classes 6..), unfiltered; stage 2 clears them from its islands.
    const s1 = jsSolve(unfiltered({...t, shapes: t.shapes.filter(s => s.cls < 6)})), shapes = [];
    for (const isl of s1.islands) { shapes.push({cls: 0, ring: isl.ring, sign: 1, tags: isl.tags}); for (const h of isl.holes) shapes.push({cls: 0, ring: h.ring, sign: 1, tags: h.tags}); }
    for (const s of t.shapes) if (s.cls >= 6) shapes.push(s);
    const t2 = {...t, shapes, hasBoard: false}, s2 = jsSolve(t2), b2 = jsSolve(unfiltered(t2));
    // Checked against the one-stage reference: the copper of the whole task.
    const r2 = t.morph ? {errors: [], maxDev: 0} : REF.check({...t, removeDead: false, minArea: 0, minSize: 0}, b2, null, {tol: TOL2});
    errors.push(...r2.errors.map(e => "two-stage: " + e));
    // Shaped copper: without earlier copper (no class 6..) stage 2 is keepSolved (no second overlay) and must equal solve's.
    if (t.morph && !t.shapes.some(s => s.cls >= 6)) { const ks = withEngine(null, () => core.keepSolved(s1, t)); if (JSON.stringify(clean(ks)) !== JSON.stringify(clean(s2))) errors.push("two-stage: keepSolved shapes differently from solve"); }
    errors.push(...REF.check(t2, s2, b2, {tol: TOL, probes: 0}).errors.filter(e => /keep\(\)|hole|ring|cross|overlap/.test(e)).map(e => "two-stage keep: " + e));
    m.dev2 = r2.maxDev;
    for (const [kind, k] of kernels) { const g = k.pourSolve(t2); if (!g || JSON.stringify(clean(g)) !== JSON.stringify(clean(s2))) errors.push("two-stage: " + kind + " differs from the JS core"); }
  }
  return {errors, m};
}

// ---------------------------------------------------------------- shrinking
const fails = t => { try { return run(t).errors.length > 0; } catch { return true; } };
function shrink(t, budget = 400) {
  let best = t, tries = 0;
  const attempt = c => { if (tries++ >= budget) return false; if (fails(c)) { best = c; return true; } return false; };
  for (let changed = true; changed && tries < budget;) {
    changed = false;
    for (let i = best.shapes.length - 1; i >= 0; i--) if (attempt({...best, shapes: best.shapes.filter((_, j) => j !== i)})) changed = true;
    for (let i = best.anchors.length - 1; i >= 0; i--) if (attempt({...best, anchors: best.anchors.filter((_, j) => j !== i)})) changed = true;
    for (const f of [{removeDead: false}, {minArea: 0}, {minSize: 0}, {twoStage: false}, {morph: undefined}]) if (Object.entries(f).some(([k, v]) => best[k] !== v) && attempt({...best, ...f})) changed = true;
    for (let i = 0; i < best.shapes.length; i++) {
      if (best.shapes[i].tags && attempt({...best, shapes: best.shapes.map((s, j) => j === i ? {...s, tags: null} : s)})) changed = true;
      for (let v = (best.shapes[i].ring.length >> 1) - 1; v >= 0 && best.shapes[i].ring.length > 6; v--) {
        const s = best.shapes[i], ring = Int32Array.from([...s.ring.subarray(0, 2 * v), ...s.ring.subarray(2 * v + 2)]);
        const tags = s.tags && Int32Array.from([...s.tags.subarray(0, v), ...s.tags.subarray(v + 1)]);
        if (attempt({...best, shapes: best.shapes.map((x, j) => j === i ? {...s, ring, tags} : x)})) changed = true;
      }
    }
  }
  return best;
}
const toJSON = t => ({shapes: t.shapes.map(s => ({cls: s.cls, sign: s.sign, ring: Array.from(s.ring), tags: s.tags ? Array.from(s.tags) : null})),
  K: t.K, hasBoard: t.hasBoard, anchors: t.anchors.map(a => Array.from(a)), removeDead: t.removeDead, minArea: t.minArea, minSize: t.minSize, twoStage: !!t.twoStage,
  ...(t.morph ? {morph: {mode: t.morph.mode, t: Array.from(t.morph.t), u: t.morph.u ? Array.from(t.morph.u) : null, keep: t.morph.keep.map(r => Array.from(r))}} : {})});
const fromJSON = j => ({...j, shapes: j.shapes.map(s => ({cls: s.cls, sign: s.sign, ring: Int32Array.from(s.ring), tags: s.tags ? Int32Array.from(s.tags) : null})),
  anchors: j.anchors.map(a => Int32Array.from(a)),
  ...(j.morph ? {morph: {mode: j.morph.mode, t: Int32Array.from(j.morph.t), ...(j.morph.u ? {u: Int32Array.from(j.morph.u)} : {}), keep: j.morph.keep.map(r => Int32Array.from(r))}} : {})});

// ---------------------------------------------------------------- 1. regressions
const FIXTURES = path.join(__dirname, "../fixtures/pour-fuzz/regressions.json");
const regressions = fs.existsSync(FIXTURES) ? JSON.parse(fs.readFileSync(FIXTURES, "utf8")) : [];
for (const r of regressions) {
  const {errors} = run(fromJSON(r.task));
  assert.deepEqual(errors, [], "regression " + r.name + " (" + r.note + ")");
}
console.log("pour-fuzz: " + regressions.length + " regression fixtures pass (" + (kernels.map(k => k[0]).join(", ") || "JS only") + ")");

// ---------------------------------------------------------------- 2. dense fans
// Hundreds of thin spokes through one small disk on a board-sized frame: tens of thousands of
// crossings in one grid cell (what offset rings of fine concave boundaries made). The grid
// refines and gives crowded cells their own grids, so this stays near-linear (it took minutes).
function fan(spokes, seed, spread, len) {
  const R = rng(seed), shapes = [{cls: 0, sign: 1, ring: Int32Array.from(rect(-LIM, -LIM, 2 * LIM - 1, 2 * LIM - 1)), tags: null}];
  for (let k = 0; k < spokes; k++) shapes.push({cls: 2, sign: 1, ring: Int32Array.from(rotatedRect(R.int(spread) - spread / 2, R.int(spread) - spread / 2, len, 3 + R.int(4), R.range(0, 360))), tags: null});
  return {shapes, K: 6, hasBoard: false, anchors: [], removeDead: false, minArea: 0, minSize: 0};
}
{
  const small = fan(70, 5, 400, 60000), r = run(small);
  assert.deepEqual(r.errors, [], "a dense fan of 70 spokes");
  const big = fan(300, 6, 40000, 600000), t0 = performance.now(), js = jsSolve(big), ms = performance.now() - t0;
  for (const [kind, k] of kernels) assert.equal(JSON.stringify(clean(k.pourSolve(big))), JSON.stringify(clean(js)), "dense fan: " + kind);
  assert.ok(ms < 15000, "a 300-spoke fan solves in " + ms.toFixed(0) + " ms");
  console.log("pour-fuzz: dense fans match the reference; 300 spokes (" + js.stats.edges + " edges) in " + ms.toFixed(0) + " ms");
}

// ---------------------------------------------------------------- 3. random tasks
const cases = +(env("ATRIUM_POUR_FUZZ") || 0) || 600, seed0 = +(env("ATRIUM_POUR_FUZZ_SEED") || 0) || 0x9047;
const found = [], times = [];
let maxDev = 0, maxDev2 = 0, xorTotal = 0, unresolved = 0, snapped = 0, copper = 0, shaped = 0;
const t0 = performance.now();
for (let c = 0; c < cases; c++) {
  const seed = (seed0 + Math.imul(c, 0x9e3779b1)) >>> 0, t = task(seed);
  const t1 = performance.now(), r = run(t);
  times.push(performance.now() - t1);
  maxDev = Math.max(maxDev, r.m.dev); maxDev2 = Math.max(maxDev2, r.m.dev2); xorTotal += r.m.xor; if (r.m.unresolved) unresolved++; if (r.m.snapped) snapped++; if (r.m.morph) shaped++;
  if (r.errors.length) {
    const small = shrink(t), why = run(small).errors;
    const fixture = {name: "seed-" + seed.toString(16), note: why[0] || r.errors[0], task: toJSON(small)};
    found.push(fixture);
    console.log("FAIL seed " + seed.toString(16) + ": " + r.errors.slice(0, 3).join("; ") + "\n  shrunk: " + JSON.stringify(fixture));
    if (found.length >= 5 && !env("ATRIUM_POUR_FUZZ")) break;
  }
  if (jsSolve(t).islands.length) copper++;
}
times.sort((a, b) => a - b);
const pct = q => times[Math.min(times.length - 1, Math.floor(q * times.length))].toFixed(1);
console.log("pour-fuzz: " + times.length + " tasks from seed " + seed0.toString(16) + " in " + ((performance.now() - t0) / 1000).toFixed(1) + " s (per task median " + pct(.5) + " ms, p99 " + pct(.99) +
  " ms, with the reference); " + copper + " with copper, " + shaped + " with necks removed or outlines only, " + snapped + " snap rounded, " + unresolved + " unresolved; max deviation " + maxDev.toFixed(3) +
  " units (two-stage " + maxDev2.toFixed(3) + "); " + found.length + " failures");
if (found.length && env("ATRIUM_POUR_FUZZ_SAVE")) {
  fs.writeFileSync(FIXTURES, JSON.stringify(regressions.concat(found), null, 1) + "\n");
  console.log("pour-fuzz: appended " + found.length + " shrunk failures to " + FIXTURES);
}
assert.equal(found.length, 0, found.length + " fuzz failures (shrunk fixtures above)");
assert.ok(copper > times.length / 3, "the fuzz produces copper: " + copper);
