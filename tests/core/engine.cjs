"use strict";
// Rust/WebAssembly kernels (app/engine-core.js, engine/): each kernel against its JS fallback.
// Run: scripts/test-jsc.sh engine   (ATRIUM_ENGINE=wasm requires the module; =js skips it)
//      node tests/core/engine.cjs [--asset other/engine-core.js] [--fixtures dir with qfsae-0.PcbDoc]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const option = name => {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  if (!process.argv[index + 1]) throw Error("Missing argument for " + name);
  return path.resolve(process.argv[index + 1]);
};
const asset = option("--asset"), fixtures = option("--fixtures");
const mode = globalThis.ATRIUM_ENGINE ?? process.env.ATRIUM_ENGINE;
require(asset || "../../app/engine-core.js");
const wasm = globalThis.AtriumEngine?.available ? globalThis.AtriumEngine : null;
if (asset || mode === "wasm") assert.ok(wasm, "The Wasm module must instantiate: " + globalThis.AtriumEngine?.failure);
if (mode === "js") assert.equal(globalThis.AtriumEngine.available, false, "ATRIUM_ENGINE=js never loads the module");
require("../../app/core/model.js");
require("../../app/library/parts.js");
require("../../app/checks/connectivity.js");
let seed = 0xbead;
function random() {
  seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
  return seed / 4294967296;
}
// The candidate sweep stays in JS: a Rust/WebAssembly sweep measured slower than the typed-array
// JS sweep, so the module offers none.
assert.equal(wasm?.openSweep, undefined);
function inspect(engine, doc, defs) {
  globalThis.AtriumEngine = engine || undefined;
  try { return AtriumConnectivity.inspect(doc, defs); }
  finally { globalThis.AtriumEngine = wasm || undefined; }
}
const board = Atrium.sheet("pcb","Intersecting copper");
board.items = Array.from({length: 90}, (_,i) => ({
  kind: "pad", id: String(i), number: "1", net: "N" + i%4,
  x: (i%10)*.9, y: Math.floor(i/10)*.9, w: 1, h: 1, shape: "round",
  layer: i%5 === 0 ? "Bottom" : "Top"
}));
const emptyDefs = new Map();
// An engine that refuses (null) or lacks a kernel leaves the JS result unchanged.
const expected = inspect(null, board, emptyDefs);
assert.ok(expected.stats.candidates > expected.stats.contacts, "fixture includes narrow-phase misses");
assert.deepEqual(inspect({airwires: () => null}, board, emptyDefs), expected);
assert.deepEqual(inspect({}, board, emptyDefs), expected);
function parity(doc, defs) {
  const reference = inspect(null, doc, defs);
  if (wasm) assert.deepEqual(inspect(wasm, doc, defs), reference);
  return reference;
}
parity(board, emptyDefs);
const example = AtriumParts.example();
parity(example.documents.find(d=>d.kind==="pcb"),new Map(example.library.map(d=>[d.id,d])));
// Airwires: random boards whose nets have many equal distances (a grid) and object IDs that
// JSON escapes differently from their raw order (quotes, backslashes, controls, surrogates).
const ids = ["a", "a!", "a#", "a\"", "a\\", "\"q", "A", "a\u0001", "a\n", "ab", "\u00e9", "\ud800", "\ud83d\ude00", "\udc00x", "z"];
function grid(count, nets, seedValue, unique = true) {
  seed = seedValue;
  const doc = Atrium.sheet("pcb", "Airwire grid");
  doc.items = Array.from({length: count}, (_, i) => {
    const id = (unique ? i + ":" : "") + ids[Math.floor(random() * ids.length)];
    const x = Math.floor(random() * 30) * 1.27, y = Math.floor(random() * 20) * 1.27;
    return random() < .25
      ? {kind: "track", id, net: "N" + i % nets, layer: "Top", width: .2, points: [[x, y], [x + 1.27, y]]}
      : {kind: "pad", id, number: String(i % 3), net: "N" + i % nets, x, y, w: .5, h: .5, shape: "round", layer: i % 7 ? "Top" : "Bottom"};
  });
  return doc;
}
if (wasm) {
  for (const [count, nets, s0] of [[60, 3, 1], [400, 7, 2], [900, 2, 3], [2600, 1, 4]]) {
    const doc = grid(count, nets, s0), before = wasm.stats.fallbacks;
    const result = parity(doc, emptyDefs);
    assert.ok(result.airwires.length > 0);
    assert.equal(wasm.stats.fallbacks, before, "no fallback for unique IDs");
  }
  // Duplicate IDs can make the JS order decide between equal keys: the kernel refuses and the
  // JS fallback runs, so the result is still identical.
  parity(grid(300, 2, 5, false), emptyDefs);
  // Non-finite anchors and malformed islands are refused, not misread.
  assert.equal(wasm.airwires([[[{kind: "pad", anchors: [{at: [NaN, 0], key: "a"}]}], [{kind: "pad", anchors: [{at: [1, 0], key: "b"}]}]]], ["N"]), null);
  assert.equal(wasm.airwires([[[{kind: "pad", anchors: [{at: [0, 0], key: 7}]}], [{kind: "pad", anchors: [{at: [1, 0], key: "b"}]}]]], ["N"]), null);
  assert.deepEqual(wasm.airwires([[[{kind: "pad", anchors: [{at: [0, 0], key: "a", id: "A", label: "A"}]}], [{kind: "pad", anchors: [{at: [3, 4], key: "b", id: "B", label: "B"}]}]]], ["N"]),
    [[{net: "N", from: [0, 0], to: [3, 4], fromId: "A", toId: "B", fromLabel: "A", toLabel: "B", distance: 5}]]);
}

if (fixtures) {
  global.CFB = require("../../app/vendor/cfb.min.js");
  require("../../app/formats/pcb-import.js");
  require("../../app/formats/io.js");
  const file = "qfsae-0.PcbDoc";
  const data = AtriumIO.read(file, fs.readFileSync(path.join(fixtures,file)));
  const result = parity(data.documents[0],new Map(data.library.map(d=>[d.id,d])));
  assert.equal(result.nets.length,42);
  assert.equal(result.nets.reduce((n,net)=>n+net.vias,0),53);
  console.log("QFSAE PDP V3 PCB fixture: " + result.stats.features + " copper features, 42 nets.");
}
console.log(wasm ? "engine: Rust/WebAssembly airwires match the JS fallback (grids, escaped IDs, refusals)."
  : "engine: JS fallback checked (the Rust/WebAssembly kernels were not loaded).");
