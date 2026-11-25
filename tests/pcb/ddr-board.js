"use strict";
// A DDR4-style test board for bus routing (tests/pcb/bus-route.cjs, the headless-Chrome demo): a BGA-like controller U1
// and two x8 DRAMs U2 and U3, all with synthetic, clean-room footprints (plain ball grids, no vendor data).
//   Byte lane 0: DQ0–DQ7, DQS0_P/DQS0_N (a differential pair), DM0. U1's east column -> U2's west column.
//     U2's DQ balls are in a different order (DQ bits are swappable within a byte: symbol Swap group "DQ").
//   ADDR/CMD fly-by: A0–A3, BA0, BA1. U1's north row -> U2's top row -> U3's top row. The ball orders are planned for
//   the fly-by (each hop turns twice, which mirrors the order), so the chain needs no swaps. The DRAM address balls are
//   via-in-pad, so the second hop leaves U2 on Bottom.
//   Obstacles: a fixed mounting pad H1 in the byte lane's path and a movable track GPIO7 dipping into it.
// Rules (version 2): clearance 0.1, width 0.1 (min 0.09), DQS pair 0.1 / gap 0.12, vias 0.45 / 0.2, matched lengths
// on net class DDR_BYTE0 (tolerance 0.254) and DDR_ADDR.
globalThis.makeAtriumDDRBoard = function(o = {}) {
  const pitch = 0.8, ball = 0.4;
  const BYTE = ["DQ0", "DQ1", "DQ2", "DQ3", "DQS0_P", "DQS0_N", "DM0", "DQ4", "DQ5", "DQ6", "DQ7"];
  const ADDR = ["A0", "A1", "A2", "A3", "BA0", "BA1"];
  // DRAM west column, top to bottom: DQ bits pairwise swapped relative to the controller.
  const DRAM_BYTE = ["DQ1", "DQ0", "DQ3", "DQ2", "DQS0_P", "DQS0_N", "DM0", "DQ5", "DQ4", "DQ7", "DQ6"];
  const pad = (number, x, y) => ({number, x: +x.toFixed(4), y: +y.toFixed(4), w: ball, h: ball, shape: "round", layer: "Top"});
  // Controller: 8 columns x 14 rows. Pad names R<row>C<col>.
  const ctrlPads = [], ctrlPins = [];
  for (let r = 1; r <= 14; r++) for (let c = 1; c <= 8; c++) {
    const n = "R" + r + "C" + c;
    ctrlPads.push(pad(n, (c - 4.5) * pitch, (r - 7.5) * pitch));
    ctrlPins.push({number: n, name: n, x: 0, y: 0});
  }
  // DRAM: 6 columns x 13 rows. West column C1 rows 2..12 carry the byte; the top row R1 the address group.
  const dramPads = [], dramPins = [];
  for (let r = 1; r <= 13; r++) for (let c = 1; c <= 6; c++) {
    const n = "R" + r + "C" + c;
    // The address row is via-in-pad (drilled, every layer), so the fly-by can leave a DRAM on another layer.
    dramPads.push(r === 1 ? {...pad(n, (c - 3.5) * pitch, (r - 7) * pitch), layer: "Multi", drill: 0.2} : pad(n, (c - 3.5) * pitch, (r - 7) * pitch));
    const net = c === 1 && r >= 2 && r <= 12 ? DRAM_BYTE[r - 2] : "";
    dramPins.push({number: n, name: net || n, x: 0, y: 0, ...(/^DQ\d$/.test(net) ? {swapGroup: "DQ"} : {})});
  }
  const defs = new Map([
    ["test-ctrl-bga", {id: "test-ctrl-bga", name: "Test controller BGA 112", footprint: {pads: ctrlPads, shapes: []}, symbol: {pins: ctrlPins, shapes: []}}],
    ["test-dram-x8", {id: "test-dram-x8", name: "Test DRAM x8 78-ball", footprint: {pads: dramPads, shapes: []}, symbol: {pins: dramPins, shapes: []}}]
  ]);
  const U1 = {id: "U1", kind: "part", def: "test-ctrl-bga", ref: "U1", value: "Memory controller", x: 15, y: 25, angle: 0, pinNets: {}};
  const U2 = {id: "U2", kind: "part", def: "test-dram-x8", ref: "U2", value: "DDR4 x8", x: 45, y: 25, angle: 0, pinNets: {}};
  const U3 = {id: "U3", kind: "part", def: "test-dram-x8", ref: "U3", value: "DDR4 x8", x: 60, y: 25, angle: 0, pinNets: {}};
  for (let r = 1; r <= 14; r++) for (let c = 1; c <= 8; c++) U1.pinNets["R" + r + "C" + c] = (r + c) % 3 ? "GND" : "VDDQ";
  BYTE.forEach((n, i) => { U1.pinNets["R" + (i + 2) + "C8"] = n; });
  ADDR.slice().reverse().forEach((n, i) => { U1.pinNets["R1C" + (i + 2)] = n; });
  for (const U of [U2, U3]) {
    for (let r = 1; r <= 13; r++) for (let c = 1; c <= 6; c++) U.pinNets["R" + r + "C" + c] = c >= 3 && (r + c) % 2 ? "GND" : "";
    (U === U2 ? ADDR : ADDR.slice().reverse()).forEach((n, i) => { U.pinNets["R1C" + (i + 1)] = n; });
  }
  DRAM_BYTE.forEach((n, i) => { U2.pinNets["R" + (i + 2) + "C1"] = n; });
  const items = [U1, U2, U3];
  if (o.obstacles !== false) {
    items.push({id: "H1", kind: "pad", x: 33, y: 24.6, w: 2.4, h: 2.4, shape: "round", layer: "Top", net: "GND"});
    items.push({id: "GPIO7", kind: "track", net: "GPIO7", layer: "Top", width: 0.1, points: [[23, 19], [25, 23.6], [27, 19]]});
  }
  const R = globalThis.AtriumRules;
  const rules = R.create();
  const find = t => rules.list.find(r => r.type === t);
  find("clearance").gap = 0.1;
  Object.assign(find("width"), {min: 0.09, preferred: 0.1, max: 1});
  Object.assign(find("viaStyle"), {diameterMin: 0.4, diameterPreferred: 0.45, diameterMax: 0.6, holeMin: 0.15, holePreferred: 0.2, holeMax: 0.3});
  Object.assign(find("diffPairsRouting"), {widthMin: 0.09, widthPreferred: 0.1, widthMax: 0.2, gapMin: 0.1, gapPreferred: 0.12, gapMax: 0.2});
  find("holeToHole").gap = 0.2;
  rules.netClasses = {DDR_BYTE0: BYTE.slice(), DDR_ADDR: ADDR.slice()};
  rules.diffPairs = [{name: "DQS0", positive: "DQS0_P", negative: "DQS0_N"}];
  rules.list.push({id: "ml-byte0", type: "matchedLengths", name: "MatchedLengths_Byte0", comment: "", enabled: true, priority: 1,
    scope: globalThis.AtriumDesignQueryRecord.selector("netclass", "DDR_BYTE0"), tolerance: 0.254, withinPair: false, pairTolerance: 0.127});
  R.validate?.(rules);
  const board = {id: "ddr", kind: "pcb", name: "DDR4 test board", grid: 0.05, items, outline: [[0, 0], [70, 0], [70, 50], [0, 50]], notes: [], rules};
  // Fly-by load order for the address group (Constraint Manager › Topology; topology.js specFor): U1 -> U2 -> U3.
  board.lengthTuning = {version: 1, groups: [], targets: {}, topologies: Object.fromEntries(ADDR.map(n => [n, {source: "U1", order: ["U2", "U3"]}]))};
  return {board, defs, BYTE, ADDR, DRAM_BYTE, U1, U2, U3};
};
