"use strict";
// Pin and gate swapping: library equivalence, board swaps (with connected copper),
// back-annotation through the reverse ECO, and the net/pin optimiser.
const assert = require("node:assert/strict");
for (const m of ["model", "connectivity", "parts", "library-panel", "footprint-wizard", "starter-library", "sch-objects", "altium-rules", "rules", "pcb-edit", "eco", "sch-author", "pin-swap"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, E = AtriumECO, W = AtriumSchAuthor, PS = AtriumPinSwap;
const cases = [];
const test = (name, run) => cases.push({name, run});
const defsOf = p => new Map(p.library.map(d => [d.id, d]));

// A project: U1 dual op amp (gates A and B), J1 a 1x4 header whose pins share Swap group "IO",
// J2 and J3 plain headers. Nets: U1A.1 → J2.1 (NA), U1B.7 → J2.2 (NB), J1.1..4 → J3.1..4 by wires.
function project() {
  const p = A.project("Swap", AtriumParts.catalogue), [sch, pcb] = p.documents;
  AtriumStarterLibrary.addTo(p);
  const io = A.clone(p.library.find(d => d.id === "starter-hdr-1x4"));
  io.id = "test-io4"; io.name = "Swappable IO"; for (const pin of io.symbol.pins) pin.swapGroup = "IO";
  p.library.push(io);
  pcb.outline = [[0, 0], [60, 0], [60, 40], [0, 40]];
  W.placePart(p, {def: "starter-opamp-dual", x: 0, y: 0, designator: "U1A"});
  W.placePart(p, {def: "starter-opamp-dual", x: 0, y: 30.48, designator: "U1B"});
  W.placePart(p, {def: "starter-hdr-1x4", x: 50.8, y: 0, designator: "J2"});
  W.placePart(p, {def: "test-io4", x: 0, y: 76.2, designator: "J1"});
  W.placePart(p, {def: "starter-hdr-1x4", x: 50.8, y: 76.2, designator: "J3"});
  W.addNetLabel(p, {text: "NA", at: {designator: "U1A", pin: "1"}}); W.addNetLabel(p, {text: "NA", at: {designator: "J2", pin: "1"}});
  W.addNetLabel(p, {text: "NB", at: {designator: "U1B", pin: "7"}}); W.addNetLabel(p, {text: "NB", at: {designator: "J2", pin: "2"}});
  for (const n of ["1", "2", "3", "4"]) W.addWire(p, {from: {designator: "J1", pin: n}, to: {designator: "J3", pin: n}});
  E.update(p, {direction: "pcb", board: pcb.id});
  return {p, sch, pcb, part: ref => pcb.items.find(i => i.kind === "part" && i.ref === ref)};
}
const schNet = (p, ref, unit, pin) => {
  const sch = p.documents.find(d => d.kind === "schematic"), item = sch.items.find(i => i.kind === "part" && i.ref === ref && (unit == null || (i.unit || 1) === unit));
  return A.connectivity(sch, defsOf(p)).byPin.get(item.id + "/" + pin);
};
const schPart = (p, ref, unit) => p.documents.find(d => d.kind === "schematic").items.find(i => i.kind === "part" && i.ref === ref && (i.unit || 1) === unit);

test("library equivalence: swap groups and equivalent gates", () => {
  const {p} = project(), defs = defsOf(p);
  assert.deepEqual(PS.peers(defs.get("test-io4"), "1").sort(), ["2", "3", "4"]);
  assert.deepEqual(PS.peers(defs.get("starter-hdr-1x4"), "1"), []);
  const op = defs.get("starter-opamp-dual"), I = PS.info(op);
  assert.deepEqual(I.gateGroups, [[1, 2]]);
  assert.deepEqual(PS.gatePairs(op, 1, 2).sort(), [["1", "7"], ["2", "6"], ["3", "5"]]);
  assert.equal(PS.gateOf(op, "8"), 0, "power pins are shared");
  assert.deepEqual(PS.gatePairs({...op, symbol: {...op.symbol, gateSwap: false}}, 1, 2), []);
});

test("pin swap on the board back-annotates the schematic (wires re-routed)", () => {
  const {p, pcb, part} = project(), defs = defsOf(p), J1 = part("J1");
  const n1 = J1.pinNets["1"], n2 = J1.pinNets["2"];
  assert.ok(n1 && n2 && n1 !== n2);
  assert.throws(() => PS.planPin(pcb, defs, part("J3").id, "1", "2"), /not swap-equivalent/);
  const plan = PS.planPin(pcb, defs, J1.id, "1", "2");
  const r = PS.applyPlans(p, pcb, defs, [plan]);
  // The pads swapped connections: J1.1 is now on J3.2's net and J1.2 on J3.1's (automatic
  // net names follow the schematic, which names a net after its first pin).
  const J3 = part("J3");
  assert.equal(J1.pinNets["1"], J3.pinNets["2"]); assert.equal(J1.pinNets["2"], J3.pinNets["1"]);
  assert.notEqual(J1.pinNets["1"], J1.pinNets["2"]);
  assert.equal(r.back.applied, 1, JSON.stringify(r.back));
  assert.equal(schNet(p, "J1", null, "1"), schNet(p, "J3", null, "2"), "J1.1 now wired to J3.2");
  assert.equal(schNet(p, "J1", null, "2"), schNet(p, "J3", null, "1"));
  // Schematic and board agree again: neither direction has net changes left.
  assert.equal(E.plan(p, {direction: "sch", board: pcb.id}).changes.filter(c => c.action === "pinSwap").length, 0);
  assert.equal(E.plan(p, {direction: "pcb", board: pcb.id}).changes.filter(c => c.action === "padNet").length, 0);
  A.validate(p);
});

test("gate swap U1A ↔ U1B swaps the board nets and the schematic units", () => {
  const {p, pcb, part} = project(), defs = defsOf(p), U1 = part("U1");
  assert.equal(U1.pinNets["1"], "NA"); assert.equal(U1.pinNets["7"], "NB");
  const plan = PS.planGate(pcb, defs, U1.id, 1, 2);
  const a = schPart(p, "U1", 1), b = schPart(p, "U1", 2);
  const r = PS.applyPlans(p, pcb, defs, [plan]);
  assert.equal(U1.pinNets["1"], "NB"); assert.equal(U1.pinNets["7"], "NA");
  assert.equal(r.back.applied, 1, JSON.stringify(r.back));
  assert.equal(a.unit, 2); assert.equal(b.unit, 1, "the gate drawn on the NA label is now gate B");
  assert.equal(schNet(p, "U1", 2, "7"), "NA"); assert.equal(schNet(p, "U1", 1, "1"), "NB");
  assert.equal(E.plan(p, {direction: "pcb", board: pcb.id}).changes.filter(c => c.action === "padNet").length, 0);
});

test("connected copper: a dead-end stub follows its pad, a routed connection is unrouted", () => {
  const {p, pcb, part} = project(), defs = defsOf(p), J1 = part("J1"), J3 = part("J3");
  J1.x = 10; J1.y = 30; J3.x = 40; J3.y = 30;
  const pin = (prt, n) => A.pins(prt, defs.get(prt.def), "pcb").find(q => q.number === n).at;
  const a = pin(J1, "1"), b = pin(J3, "1"), c = pin(J1, "2");
  pcb.items.push({id: "routed", kind: "track", points: [a, [a[0], a[1] + 3], [b[0], a[1] + 3], b], width: .25, layer: "Top", net: J1.pinNets["1"]});
  pcb.items.push({id: "stub", kind: "track", points: [c, [c[0] - 2, c[1]]], width: .25, layer: "Top", net: J1.pinNets["2"]});
  const n1 = J1.pinNets["1"];
  const r = PS.applyPlans(p, pcb, defs, [PS.planPin(pcb, defs, J1.id, "1", "2")], {backAnnotate: false});
  assert.equal(r.unrouted, 1); assert.equal(r.renetted, 1);
  assert.ok(!pcb.items.some(i => i.id === "routed"));
  assert.equal(pcb.items.find(i => i.id === "stub").net, n1);
});

function swapBoard(layer, drill = 0) {
  const def = {
    id: "swappable", name: "Swappable",
    symbol: {pins: ["1", "2"].map((number, k) => ({number, x: 0, y: k * 2, swapGroup: "IO"}))},
    footprint: {pads: ["1", "2"].map((number, k) => ({number, x: 0, y: k * 2, w: 1, h: 1, drill}))}
  };
  const part = {kind: "part", id: "source", def: def.id, ref: "U1", x: 5, y: 10, layer, pinNets: {"1": "N", "2": "M"}};
  const board = {kind: "pcb", items: [part]}, defs = new Map([[def.id, def]]);
  const swap = () => PS.applyBoard(board, defs, PS.planPin(board, defs, part.id, "1", "2"));
  return {board, part, swap};
}
const track = (id, layer, ...points) => ({kind: "track", id, layer, points, width: .25, net: "N"});
const freePad = (id, layer, x, y) => ({kind: "pad", id, layer, x, y, w: 1, h: 1, net: "N"});
const via = (id, span) => ({kind: "via", id, x: 10, y: 10, diameter: .6, drill: .3, layer: "Multi", net: "N", ...span});

for (const [side, opposite] of [["Top", "Bottom"], ["Bottom", "Top"]]) {
  test(`only ${side} copper attaches to a ${side} SMD pin and the pads it reaches`, () => {
    const {board, part, swap} = swapBoard(side);
    const stub = track("stub", side, [5, 10], [10, 10]);
    const joined = track("joined", side, [10, 10], [15, 10], [20, 10]);
    const crossing = track("crossing", opposite, [10, 9], [10, 10], [10, 11]);
    const underPin = track("under-pin", opposite, [5, 10], [4, 10]);
    const wrongFreePad = freePad("free-peer", opposite, 15, 10);
    const wrongPartPad = {...part, id: "opposite", ref: "U2", layer: opposite, x: 20, pinNets: {"1": "N"}};
    board.items.push(stub, joined, crossing, underPin, wrongFreePad, wrongPartPad);
    const before = A.clone(board.items);
    assert.deepEqual(swap(), {unrouted: 0, renetted: 2});
    before[0].pinNets = {"1": "M", "2": "N"};
    before[1].net = before[2].net = "M";
    assert.deepEqual(board.items, before);
  });
}

test("a plated footprint pad can seed Bottom copper, and a through via reaches a Top peer", () => {
  const {board, part, swap} = swapBoard("Top", .4);
  const entry = track("entry", "Bottom", [5, 10], [10, 10]);
  const upper = track("upper", "Top", [10, 10], [15, 10]);
  const peer = {...part, id: "peer", ref: "U2", x: 15, pinNets: {"1": "N"}};
  board.items.push(entry, via("through"), upper, peer);
  assert.deepEqual(swap(), {unrouted: 3, renetted: 0});
  assert.deepEqual(board.items, [part, peer]);
  assert.deepEqual(part.pinNets, {"1": "M", "2": "N"});
});

test("a blind via connects intervening layers and leaves copper beyond its span intact", () => {
  const {board, swap} = swapBoard("Top");
  const entry = track("entry", "Top", [5, 10], [10, 10]);
  const blind = via("blind", {fromLayer: "Inner 2", toLayer: "Top"});
  const inside = track("within-span", "Inner 1", [10, 10], [13, 10]);
  const outside = track("outside-span", "Bottom", [10, 10], [15, 10]);
  const separateVia = via("below-blind", {fromLayer: "Inner 3", toLayer: "Bottom"});
  const peer = freePad("bottom-peer", "Bottom", 15, 10);
  board.items.push(entry, blind, inside, outside, separateVia, peer);
  const before = A.clone(board.items);
  assert.deepEqual(swap(), {unrouted: 0, renetted: 3});
  before[0].pinNets = {"1": "M", "2": "N"};
  before[1].net = before[2].net = before[3].net = "M";
  assert.deepEqual(board.items, before);
});

test("optimiser: proposes the pin and gate swaps that untangle the ratsnest", () => {
  const {p, pcb, part} = project(), defs = defsOf(p);
  const J1 = part("J1"), J3 = part("J3"), U1 = part("U1"), J2 = part("J2");
  // J3 rotated half a turn: J1.1→J3.1 … crosses every airwire.
  J1.x = 10; J1.y = 20; J1.angle = 0; J3.x = 40; J3.y = 20; J3.angle = 180;
  U1.x = 10; U1.y = 5; U1.angle = 0; J2.x = 45; J2.y = 5; J2.angle = 180;
  const props = PS.optimise(pcb, defs);
  const pin = props.find(x => x.kind === "pin" && x.ref === "J1");
  assert.ok(pin, JSON.stringify(props.map(x => x.label)));
  assert.ok(pin.before.crossings > 0 && pin.after.crossings === 0, pin.before.crossings + " → " + pin.after.crossings);
  assert.ok(pin.after.length < pin.before.length);
  const before = pin.before.score;
  PS.applyPlans(p, pcb, defs, [pin]);
  const again = PS.optimise(pcb, defs).find(x => x.kind === "pin" && x.ref === "J1");
  assert.ok(!again, "nothing left to gain after applying");
  assert.ok(before > 0);
  // The schematic follows (all transpositions back-annotated).
  for (const n of ["1", "2", "3", "4"]) assert.equal(E.plan(p, {direction: "pcb", board: pcb.id}).changes.filter(c => c.action === "padNet").length, 0, n);
});

test("routed pads are left alone unless asked", () => {
  const {pcb, part, p} = project(), defs = defsOf(p), J1 = part("J1"), J3 = part("J3");
  J1.x = 10; J1.y = 20; J3.x = 40; J3.y = 20; J3.angle = 180;
  for (const pad of defs.get(J1.def).footprint.pads) { pad.layer = "Top"; pad.drill = 0; }
  const a = A.pins(J1, defs.get(J1.def), "pcb").find(q => q.number === "1").at;
  const nearby = {...track("nearby", "Bottom", a, [a[0] - 1, a[1]]), net: J1.pinNets["1"]};
  pcb.items.push(nearby);
  const separate = PS.optimise(pcb, defs).find(x => x.ref === "J1");
  assert.ok(separate && separate.pairs.some(pr => pr.includes("1")));
  nearby.layer = "Top";
  const free = PS.optimise(pcb, defs).find(x => x.ref === "J1");
  assert.ok(!free || free.pairs.every(pr => !pr.includes("1")));
  const all = PS.optimise(pcb, defs, {includeRouted: true}).find(x => x.ref === "J1");
  assert.ok(all && all.pairs.some(pr => pr.includes("1")));
});

let failed = 0;
test("a dead-end stub follows a pad swapped onto an unconnected pin", () => {
  const {board, part, swap} = swapBoard("Top");
  part.pinNets = {"1": "N"};
  board.items.push(track("stub", "Top", [5, 10], [8, 10]));
  swap();
  assert.equal(part.pinNets["2"], "N");
  assert.equal(part.pinNets["1"] || "", "");
  const stub = board.items.find(i => i.id === "stub");
  assert.equal(stub?.net, "", "the dead-end copper stays in place and follows the disconnected pad");
});

for (const c of cases) {
  try { c.run(); console.log("PASS " + c.name); }
  catch (e) { failed++; console.log("FAIL " + c.name + "\n  " + (e && e.message) + "\n" + (e && e.stack || "").split("\n").slice(0, 3).join(" | ")); }
}
if (failed) { if (typeof process !== "undefined") process.exitCode = 1; throw Error(failed + " pin-swap test(s) failed"); }
console.log("pin-swap: " + cases.length + " tests passed");
