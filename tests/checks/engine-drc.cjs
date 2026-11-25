"use strict";
// The Rust/WebAssembly DRC broad phase (engine/src/pairs.rs, app/engine-core.js gridPairs) against
// its JS loop: app/checks/rules.js pairs() visits the same pairs in the same order, on random boards and on
// hostile input (non-finite and huge coordinates, inverted and empty boxes, features covering the
// board, hundreds of features in one cell). Then the DRC of the dense boards (every rule type) is
// identical with and without the module; scripts/test-jsc.sh drc-equivalence checks the corpus digests.
// Run: scripts/test-jsc.sh engine-drc   (or node tests/checks/engine-drc.cjs; ATRIUM_ENGINE=js skips the module)
const assert = require("node:assert/strict");
const mode = globalThis.ATRIUM_ENGINE ?? process.env.ATRIUM_ENGINE;
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
require("../../app/engine-core.js");
const E = globalThis.AtriumEngine;
if (mode === "wasm") assert.ok(E.available, "The Wasm module must instantiate: " + E.failure);
for (const m of ["model", "parts", "net-ties", "spatial", "board-shape", "stackup", "viastack", "component-classes", "altium-rules", "net-intent", "signals", "rules", "connectivity"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../pcb/dense-board.js");
const R = AtriumRules, X = R.kit, C = AtriumConnectivity;
let passed = 0;
const test = (name, fn) => { if (skip) return; fn(); passed++; console.log("ok - " + name); };
const skip = !E.available;
if (skip) console.log("ok - skipped: no WebAssembly module (" + (mode === "js" ? "ATRIUM_ENGINE=js" : E.failure) + ")");
// Run fn with the JS loops only (the callers read globalThis.AtriumEngine on each call).
function withoutEngine(fn) { const keep = globalThis.AtriumEngine; globalThis.AtriumEngine = undefined; try { return fn(); } finally { globalThis.AtriumEngine = keep; } }
let seed = 0x5eed;
const rnd = () => (seed = (Math.imul(1664525, seed) + 1013904223) >>> 0) / 4294967296;
const visits = (F, reach) => { const out = []; X.pairs(F, reach, (a, b) => out.push(a.k + ">" + b.k)); return out; };

test("the grid (rules.js pairs) visits the same pairs in the same order", () => {
  for (let round = 0; round < 12; round++) {
    const n = 600 + Math.floor(rnd() * 2400), F = [], w = 20 + rnd() * 200;
    for (let k = 0; k < n; k++) {
      const x = rnd() * w, y = rnd() * w, s = rnd() < .02 ? rnd() * w : rnd() * 1.5;
      F.push({k, box: [x, y, x + s * rnd(), y + s * rnd()]});
    }
    // Hostile entries: non-finite, huge, inverted, a feature over the whole board, a stack in one cell.
    if (round % 3 === 0) F.push({k: n, box: [NaN, 1, 2, 3]}, {k: n + 1, box: [0, 0, Infinity, 4]}, {k: n + 2, box: [5, 5, 4, 4]}, {k: n + 3, box: [-1, -1, w + 1, w + 1]}, {k: n + 4, box: [1e9, 1e9, 1e9 + 1, 1e9 + 1]});
    if (round % 4 === 1) for (let k = 0; k < 300; k++) F.push({k: n + 10 + k, box: [3, 3, 3.01, 3.01]});
    const reach = [.2, .5, 1.3][round % 3];
    let calls = E.stats.calls;
    const got = visits(F, reach);
    assert.ok(E.stats.calls > calls, "the module ran");
    const want = withoutEngine(() => visits(F, reach));
    assert.equal(got.length, want.length, "round " + round + ": the same number of visits");
    assert.ok(got.every((v, i) => v === want[i]), "round " + round + ": the same order");
  }
});

test("the DRC of the dense boards is identical with and without the module", () => {
  for (const netted of [false, true]) {
    const {d, defs} = makeAtriumBenchmarkBoard(70);
    if (netted) { let n = 0; for (const i of d.items) if (i.kind !== "part") i.net = "N" + (n++ % 90); else i.pinNets = {"1": "N" + (n % 90), "2": "N" + ((n + 1) % 90)}; }
    const run = () => JSON.stringify(R.drc(d, defs, null, {limit: 1e6}).violations);
    const t0 = performance.now(), got = run(), t1 = performance.now(), want = withoutEngine(run), t2 = performance.now();
    assert.equal(got, want);
    console.log("   " + (netted ? "netted" : "un-netted") + " 4.9k-object board: DRC " + (t1 - t0).toFixed(0) + " ms with the module, " + (t2 - t1).toFixed(0) + " ms without");
  }
});

test("hostile parameters are refused, not trusted", () => {
  assert.equal(E.gridPairs(new Float64Array([0, 0, 1, 1, 0, 0, 1, 1]), 0, .2), null, "a zero cell size");
  assert.equal(E.gridPairs(new Float64Array([0, 0, 1]), 1, .2), null, "a partial box");
  assert.equal(E.gridPairs(new Float64Array([0, 0, 1, 1]), NaN, .2), null, "a NaN cell size");
  const p = E.gridPairs(new Float64Array([0, 0, 1, 1, .5, .5, 2, 2]), 1, .2);
  assert.deepEqual([...p], [0, 1]);
});

console.log(passed + " engine broad-phase tests passed");
