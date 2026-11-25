"use strict";
// The two builds of the Rust/WebAssembly kernels (app/engine-core.js): the MVP module and the
// simd128 one (WebAssembly SIMD in the pour core's hot loops, engine/src/pour.rs `lanes`) give
// byte-identical pours, and both match the JS core (polygon-pour.js PourCore().solve):
//   * fuzz: random integer tasks full of crossings, shared and collinear edges, many-vertex
//     circles crowding the grid cells, holes and anchors, at every coordinate scale up to 2^24;
//   * boards: the tasks of a dense board with ten pours (tests/pcb/dense-board.js);
//   * selection: the SIMD module loads where WebAssembly.validate accepts the SIMD probe,
//     ATRIUM_ENGINE_SIMD=0 loads the MVP one, and a worker gets only the module that loaded.
// Where the runtime has no WebAssembly SIMD, the MVP module is still checked against the JS core.
// Run: scripts/test-jsc.sh engine-simd   (ATRIUM_ENGINE=wasm requires the modules; =js skips)
const assert = require("node:assert/strict");
const mode = globalThis.ATRIUM_ENGINE ?? process.env.ATRIUM_ENGINE;
require("../../app/engine-core.js");
const engine = AtriumEngine;
if (mode === "wasm") assert.ok(engine.available, "Rust/WebAssembly kernels: " + engine.failure);
for (const f of ["model", "parts", "spatial", "pcb-appearance", "pcb-pours", "board-shape", "polygon-pour"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
require("../pcb/dense-board.js");
const PP = AtriumPolygonPour;
if (!engine.available) {
  console.log("engine-simd: the Rust/WebAssembly kernels are not loaded (ATRIUM_ENGINE=" + (mode || "auto") + "); nothing to compare");
  return;
}

// ---------------------------------------------------------------- selection
const probe = Uint8Array.of(0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11);
const simdRuns = WebAssembly.validate(probe), simdEnv = globalThis.ATRIUM_ENGINE_SIMD ?? process.env.ATRIUM_ENGINE_SIMD;
const mvp = engine.create("mvp"), simd = engine.create("simd128");
assert.ok(mvp.available && mvp.variant === "mvp", "the MVP module loads: " + mvp.failure);
if (simdEnv === "0" || simdEnv === "off") assert.equal(engine.variant, "mvp", "ATRIUM_ENGINE_SIMD=0 loads the MVP module");
else assert.equal(engine.variant, simdRuns ? "simd128" : "mvp", "the SIMD module loads where SIMD runs");
assert.equal(simd.available, simdRuns && simdEnv !== "0" && simdEnv !== "off", "the SIMD module alone loads only where SIMD runs");
// A worker gets the loaded module only (one base64 string, not both).
const source = engine.workerSource(), strings = source.match(/"[A-Za-z0-9+/=]{1000,}"/g) || [];
assert.equal(strings.length, 1, "the worker source holds one module");
const engines = [["mvp", mvp]].concat(simd.available ? [["simd128", simd]] : []);

// ---------------------------------------------------------------- tasks
const clean = r => JSON.stringify({islands: r.islands.map(i => ({ring: Array.from(i.ring), tags: Array.from(i.tags), links: i.links,
  holes: i.holes.map(h => ({ring: Array.from(h.ring), tags: Array.from(h.tags)}))})), stats: Object.fromEntries(Object.entries(r.stats).filter(([k]) => !/^t[A-Z]/.test(k)))});
const core = PP._internal.PourCore();
const jsSolve = task => { const saved = globalThis.AtriumEngine; globalThis.AtriumEngine = undefined; try { return core.solve(task); } finally { globalThis.AtriumEngine = saved; } };
const time = {mvp: 0, simd128: 0};
function same(task, name, withJs) {
  const out = engines.map(([kind, e]) => {
    const t = performance.now(), r = e.pourSolve(task);
    time[kind] += performance.now() - t;
    assert.ok(r, name + ": the " + kind + " module refused the task");
    return clean(r);
  });
  for (let k = 1; k < out.length; k++) assert.equal(out[k], out[0], name + ": the " + engines[k][0] + " module differs from the MVP one");
  if (withJs) assert.equal(out[0], clean(jsSolve(task)), name + ": the modules differ from the JS core");
  return out[0];
}

let seed = 0x51d;
const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
const int = n => Math.floor(random() * n);
function shape(grid) {
  const kind = int(5), x = int(grid), y = int(grid), w = 1 + int(grid / 2), h = 1 + int(grid / 2), ring = [];
  if (kind === 0) ring.push(x, y, x + w, y, x + w, y + h, x, y + h);
  else if (kind === 1) for (let i = 3 + int(5); i > 0; i--) ring.push(int(grid), int(grid));
  else if (kind === 2 || kind === 3) { const n = 6 + int(kind === 3 ? 60 : 10), r = 1 + int(grid / 3); for (let i = 0; i < n; i++) ring.push(Math.round(x + r * Math.cos(6.283 * i / n)), Math.round(y + r * Math.sin(6.283 * i / n))); }
  else ring.push(x, y, x + w, y, x + w, y + 1, x + 1, y + 1, x + 1, y + h, x, y + h);
  return ring.map(v => Math.max(-16777216, Math.min(16777216, v))); // the exact range (2^24)
}
let fuzzed = 0, copper = 0;
for (let trial = 0; trial < 300; trial++) {
  const grid = [8, 40, 3000, 2e6, 16777214][trial % 5], K = 6 + int(3), shapes = [];
  shapes.push({cls: 0, ring: Int32Array.from([0, 0, grid, 0, grid, grid, 0, grid]), sign: 1, tags: null});
  if (random() < .5) shapes.push({cls: 1, ring: Int32Array.from([-1, -1, grid - 2, -1, grid - 2, grid + 1, -1, grid + 1]), sign: 1, tags: null});
  for (let i = int(trial % 3 ? 16 : 60); i > 0; i--) {
    const ring = Int32Array.from(shape(grid)), n = ring.length >> 1;
    const tags = random() < .3 ? Int32Array.from({length: n}, () => random() < .5 ? int(4) : -1) : null;
    shapes.push({cls: [2, 2, 3, 4, 5, 6, 7][int(7)] % K, ring, sign: random() < .8 ? 1 : -1, tags});
  }
  const anchors = Array.from({length: int(5)}, () => Int32Array.from(shape(grid)));
  const task = {shapes, K, hasBoard: shapes[1]?.cls === 1, anchors, removeDead: random() < .5, minArea: random() < .3 ? grid : 0, minSize: random() < .3 ? 2 : 0};
  if (JSON.parse(same(task, "trial " + trial, true)).islands.length) copper++;
  fuzzed++;
}
assert.ok(copper > 80, "the fuzz produces copper (" + copper + ")");

// The dense board: its pour tasks, captured from the pour manager, through every engine.
const tasks = [];
globalThis.AtriumEngine = {pourSolve(t) { tasks.push(t); return null; }};
try {
  const {d, defs} = makeAtriumBenchmarkBoard(64);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 16), "2": "N" + ((k + 1) % 16)}; else if (i.kind !== "track") i.net = "N" + (k % 16); k++; }
  const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]], W = 64 * 2.3, H = 64 * 1.72;
  const polys = [["Top", "N0", rect(1, 1, W / 2, H - 1)], ["Top", "N1", rect(W / 2, 1, W - 1, H - 1)], ["Bottom", "N0", rect(1, 1, W - 1, H / 2)], ["Bottom", "N1", rect(1, H / 2, W - 1, H - 1)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + (j + 2), rect(3 + j * 20, 3, 18 + j * 20, 25)]);
  polys.forEach(([layer, net, o], j) => d.items.push(PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: j % 3 === 0, connectStyle: j % 2 ? "relief" : "direct"})));
  PP.apply(d, defs, {});
} finally { globalThis.AtriumEngine = engine; }
assert.ok(tasks.length >= 8, "the pour tasks (" + tasks.length + ")");
time.mvp = time.simd128 = 0;
tasks.forEach((task, n) => same(task, "dense board task " + n, true));
console.log("engine-simd: " + fuzzed + " fuzzed tasks and " + tasks.length + " dense-board tasks identical across " + engines.map(e => e[0]).join(", ") + " and the JS core" +
  " (board: MVP " + time.mvp.toFixed(0) + " ms" + (simd.available ? ", simd128 " + time.simd128.toFixed(0) + " ms" : "; the SIMD module does not load here") + ")");
