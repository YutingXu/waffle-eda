"use strict";
// SPICE work limits: a subcircuit fan-out bomb and an
// oversized dense matrix fail fast with a clear error instead of exhausting memory.
// node tests/analysis/spice-limits.cjs, or scripts/test-jsc.sh spice-limits
const assert = require("node:assert/strict");
const S = require("../../extensions/spice/spice.js");
const level = k => [".subckt L" + k + " a b", ...Array.from({length: 10}, (_, i) => "X" + i + " a b L" + (k - 1)), ".ends"].join("\n");
const bomb = ["* bomb", "V1 in 0 1", ".subckt L0 a b", "R1 a b 1k", ".ends", ...Array.from({length: 8}, (_, k) => level(k + 1)), "X1 in 0 L8", ".op", ".end"].join("\n");
let t = Date.now();
assert.throws(() => S.simulate(bomb), /expands to more than 200,000 elements/);
assert.ok(Date.now() - t < 5000, "the fan-out bomb is refused quickly");
const chain = ["* wide", "V1 n0 0 1", ...Array.from({length: 4500}, (_, i) => "R" + i + " n" + i + " n" + (i + 1) + " 1k"), "R9999 n4500 0 1k", ".op", ".end"].join("\n");
t = Date.now();
assert.throws(() => S.simulate(chain), /dense solver is limited to 4000/);
assert.ok(Date.now() - t < 5000);
const ok = S.simulate("* divider\nV1 in 0 10\nR1 in out 1k\nR2 out 0 1k\n.op\n.end");
assert.ok(JSON.stringify(ok).includes("5"), "ordinary circuits still simulate");
console.log("spice limits tests passed");
