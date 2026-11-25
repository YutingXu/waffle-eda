"use strict";
// One impedance / delay source (consolidation audit §5): for the same layer and width, the
// length engine, Timing Vision, the Constraint Manager and via-fence's pitch all read the
// delay of AtriumStackup.delay (the AtriumImpedance solver), and without a stack-up the one
// fallback AtriumImpedance.delayFallback. Before the fix each kept its own εeff formula (and
// stackup.js its own IPC-2141 model with a 4.8 default Dk).
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "pcb-appearance", "pcb-pours", "polygon-pour", "connectivity", "impedance", "stackup", "altium-rules", "rules",
  "viastack", "router", "board-shape", "via-fence", "timing-vision", "length-tuning", "dfa", "constraints"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const S = AtriumStackup, I = AtriumImpedance, L = AtriumLength, T = AtriumTiming, K = AtriumConstraints, F = AtriumViaFence;
const close = (a, b, m, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), (m || "") + " " + a + " differs from " + b);
const tol = who => who === "viaFence" ? 1e-6 : 1e-9; // suggestPitch reports eeff to 6 decimals
const C0 = 0.299792458; // mm/ps

const board = (stack, layer, w) => {
  const d = {kind: "pcb", id: "b", name: "B", grid: 1, notes: [], outline: [[0, 0], [50, 0], [50, 50], [0, 50]],
    items: [{id: "t", kind: "track", net: "N", layer, width: w, points: [[0, 0], [10, 0]]}]};
  if (stack) d.stackup = {version: 1, layers: S.preset(stack).layers};
  d.rules = AtriumRules.create();
  return d;
};
// Every caller's ps/mm for a 10 mm track on `layer`.
function callers(d, layer, w) {
  const defs = new Map(), out = {};
  out.length = L.netLength(d, defs, "N").delay / 10;
  out.timing = T.model(d, defs).factor(layer, w);
  const saved = globalThis.AtriumTiming; delete globalThis.AtriumTiming; // the Constraint Manager's own column
  try { out.constraints = K.model({name: "P", library: [], documents: [d]}, d, defs).metrics("nets", {key: "N", name: "N"}).cells.delay / 10; }
  finally { globalThis.AtriumTiming = saved; }
  if (layer === "Top" || layer === "Bottom") out.viaFence = Math.sqrt(F.suggestPitch(d, defs, {layer, width: w}).eeff) / C0;
  return out;
}

// With a stack-up: everyone reads the solver, through AtriumStackup.delay.
for (const stack of ["2", "4", "6"]) for (const layer of ["Top", "Inner 1", "Bottom"]) for (const w of [.1, .15, .25, .4]) {
  const d = board(stack, layer, w), want = S.delay(d, layer, w, new Map());
  if (stack === "2" && layer === "Inner 1") continue;
  const g = I.geometry(S.get(d, new Map()).layers, layer);
  close(want, I.solve({...g, w}).delay, "stack-up delay is AtriumImpedance.solve");
  for (const [who, v] of Object.entries(callers(d, layer, w))) close(v, want, who + " " + stack + "L " + layer + " w " + w, tol(who));
}

// Without the stack-up module: everyone uses AtriumImpedance.delayFallback (outer: microstrip 0.2 mm over the plane; Dk 4.2).
const keepS = globalThis.AtriumStackup; delete globalThis.AtriumStackup;
try {
  for (const layer of ["Top", "Bottom"]) for (const w of [.1, .15, .25, .4]) {
    const want = I.delayFallback({outer: true, w, h: .2, er: 4.2}).delay;
    close(want, Math.sqrt(I.models.microstrip(w, .2, .035, 4.2).ee) * I.PS_PER_MM);
    for (const [who, v] of Object.entries(callers(board(null, layer, w), layer, w))) close(v, want, who + " fallback " + layer + " w " + w, tol(who));
  }
} finally { globalThis.AtriumStackup = keepS; }
assert.equal(S.impedance, undefined, "stackup.js keeps no second impedance model");
console.log("PASS one delay source: length engine = Timing = Constraint Manager = via fence = AtriumImpedance");
