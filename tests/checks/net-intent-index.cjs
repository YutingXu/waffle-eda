"use strict";
// Net intent index (app/checks/net-intent-index.js): project facts (names, pins,
// two-pin parts, two names on one net), suggestions (pairs, buses, rails, grounds) and what accepting or
// declining one writes, the project dictionary and conventions (learning, keep, forget, never), name
// completion, the journal-driven incremental facts against a fresh build, and the per-bucket suggestions.
// Run: node tests/checks/net-intent-index.cjs   (or scripts/test-jsc.sh net-intent-index)
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "net-intent", "altium-rules", "query", "signals", "rules", "net-intent-index"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, X = AtriumNetIntentIndex, S = AtriumSignals;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const def = (id, pins, prefix = "U") => ({id, name: id, prefix, symbol: {pins: pins.map((n, i) => ({number: String(i + 1), name: n, x: 0, y: -i * 2.54})), shapes: []}});
const LIB = [def("conn", ["D+", "D-", "VBUS", "GND"], "J"), def("two", ["1", "2"], "R")];
let uid = 0;
// parts: [{def, ref, nets}]; labels: free names; power: names placed as power ports.
function design(parts, o = {}) {
  const p = A.project("Index", LIB), sch = p.documents[0], defs = new Map(LIB.map(d => [d.id, d]));
  parts.forEach((x, k) => {
    const part = {id: "p" + (++uid), kind: "part", def: x.def, ref: x.ref, value: "", x: k * 30, y: 0, angle: 0, pinNets: {}};
    sch.items.push(part);
    A.pins(part, defs.get(x.def), "schematic").forEach((pin, i) => { for (const n of [].concat(x.nets[i] ?? [])) if (n) sch.items.push({id: "l" + (++uid), kind: (o.power || []).includes(n) ? "power" : "netlabel", text: n, x: pin.at[0], y: pin.at[1]}); });
  });
  (o.labels || []).forEach((n, k) => sch.items.push({id: "l" + (++uid), kind: "netlabel", text: n, x: 900, y: k * 5}));
  return {p, sch, pcb: p.documents[1], defs};
}
const kinds = list => list.map(g => g.kind + ":" + g.name);

test("facts: names with their sources, pins with names, two-pin parts, two names on one net", () => {
  const D = design([{def: "conn", ref: "J1", nets: ["USB_DP", "USB_DM", ["VBUS", "5V"], "GND"]}, {def: "two", ref: "R1", nets: ["3V3", "EN"]}], {power: ["GND", "3V3"]});
  const F = X.facts(D.p);
  assert.deepEqual([...F.names.keys()].sort(), ["3V3", "5V", "EN", "GND", "USB_DM", "USB_DP", "VBUS"]);
  assert.equal(F.names.get("GND").power, 1);
  assert.deepEqual(F.pins.get("USB_DP").map(p => p.ref + "." + p.name), ["J1.D+"]);
  assert.deepEqual(F.twoPin.map(c => c.ref + ":" + c.nets.join("/")), ["R1:3V3/EN"]);
  assert.deepEqual(F.aliases.map(a => a.net + "=" + a.name), ["VBUS=5V"]);
  // The board: nets from pinNets, pin names from the symbol.
  D.pcb.items.push({id: "b1", kind: "part", def: "conn", ref: "J1", x: 0, y: 0, angle: 0, pinNets: {1: "USB_DP", 2: "USB_DM", 4: "GND"}});
  const G = X.facts(D.p);
  assert.equal(G.names.get("USB_DP").board, 1);
  assert.deepEqual([...G.boardPins.get("USB_DM")].map(p => p.name), ["D-"]);
});

test("suggestions: a pair (strong by pin D+), a bus, rails and grounds; RS-485 A positive by default, flipped by the Naming choice", () => {
  const D = design([{def: "conn", ref: "J1", nets: ["USB_DP", "USB_DM", "VBUS", "GND"]}], {labels: ["D0", "D1", "D2", "D3", "RS485_A", "RS485_B", "nRST", "UART_TX", "UART_RX"], power: ["GND"]});
  const list = X.suggest(D.p);
  assert.deepEqual(kinds(list), ["diff:RS485", "diff:USB", "bus:D", "rail:VBUS", "ground:GND"]);
  const usb = list.find(g => g.name === "USB"), rs = list.find(g => g.name === "RS485"), gnd = list.find(g => g.kind === "ground");
  assert.deepEqual([usb.positive, usb.negative, usb.level, usb.basis], ["USB_DP", "USB_DM", "strong", "by pin D+ on J1"]);
  assert.deepEqual([rs.positive, rs.pattern], ["RS485_A", "A/B"]);
  assert.match(rs.why, /A taken as the non-inverting line/);
  assert.deepEqual([gnd.level, gnd.basis, gnd.tags[0]], ["strong", "by its power port", "GND"]);
  assert.deepEqual(list.find(g => g.kind === "bus").range, [0, 3]);
  assert.deepEqual(list.find(g => g.kind === "rail").intent, {role: "rail", voltage: 5, kind: "bus"}, "VBUS: 5 V nominal, a USB bus supply");
  X.conventionEdits.set(D.p, "rs485", "B");
  assert.equal(X.suggest(D.p).find(g => g.name === "RS485").positive, "RS485_B");
  // Two transceivers that disagree on which line is A: the suggestion asks.
  LIB.push(def("xcvr", ["A", "B"], "U"), def("xcvr2", ["B", "A"], "U"));
  const E = design([{def: "xcvr", ref: "U1", nets: ["RS485_A", "RS485_B"]}, {def: "xcvr2", ref: "U2", nets: ["RS485_A", "RS485_B"]}]);
  const ask = X.suggest(E.p).find(g => g.name === "RS485");
  assert.equal(ask.level, "weak");
  assert.equal(ask.ask, "U1 calls RS485_A its A line and U2 its B line: check which is non-inverting before accepting");
  const agree = design([{def: "xcvr", ref: "U1", nets: ["RS485_A", "RS485_B"]}, {def: "xcvr", ref: "U2", nets: ["RS485_A", "RS485_B"]}]);
  assert.equal(X.suggest(agree.p).find(g => g.name === "RS485").ask, undefined, "parts that agree: no question");
});

test("accept writes confirmed intent (one store edit each): pair, bus of single signals, rail with its tag; decline remembers and counts", () => {
  const D = design([{def: "conn", ref: "J1", nets: ["USB_DP", "USB_DM", "VBUS", "GND"]}], {labels: ["A0", "A1", "A2", "3V3"]});
  const g = () => X.suggest(D.p);
  X.accept(D.p, g().find(x => x.kind === "diff"));
  X.accept(D.p, g().find(x => x.kind === "bus"));
  X.accept(D.p, g().find(x => x.name === "3V3"));
  const st = D.p.signals;
  S.validate(st);
  const pair = st.signals.find(s => s.kind === "diff"), bus = st.signals.find(s => s.kind === "bus"), rail = st.signals.find(s => s.name === "3V3");
  assert.deepEqual(pair.legs.map(l => [l.polarity, l.nets[0]]), [[1, "USB_DP"], [-1, "USB_DM"]]);
  assert.equal(pair.intent.source, "name"); assert.ok(pair.intent.confirmed);
  assert.deepEqual(bus.members.map(id => st.signals.find(s => s.id === id).name), ["A0", "A1", "A2"]);
  assert.deepEqual([rail.intent.role, rail.intent.voltage, rail.tags[0], rail.span], ["rail", 3.3, "Power", false]);
  assert.ok(st.tags.some(t => t.name === "Power"));
  assert.deepEqual(kinds(g()), ["rail:VBUS", "ground:GND"], "accepted ones are gone");
  X.decline(D.p, g()[0]);
  assert.deepEqual(kinds(g()), ["ground:GND"]);
  assert.deepEqual(Object.values(D.p.signals.declined).map(d => [d.kind, d.name]), [["rail", "VBUS"]]);
  assert.deepEqual(D.p.signals.conventions.tally, {"diff:DP/DM": [1, 0], "bus:A": [1, 0], "rail:": [1, 1]});
  X.restore(D.p);
  assert.deepEqual(kinds(g()), ["rail:VBUS", "ground:GND"]);
});

test("never-suggest offers after three declines of one pattern; the dictionary makes rails, grounds and clocks; not-a-rail words", () => {
  const D = design([], {labels: ["ENC0_A", "ENC0_B", "ENC1_A", "ENC1_B", "RS485_A", "RS485_B", "RS422_A", "RS422_B", "PROFIBUS_A", "PROFIBUS_B", "VPROG", "VPROG_EN", "GND_MOT", "SYSREF", "VSEL_3V3"]});
  for (const n of ["RS485", "RS422", "PROFIBUS"]) X.decline(D.p, X.suggest(D.p).find(g => g.name === n));
  assert.deepEqual(X.offers(D.p).map(o => [o.kind, o.value, o.declined]), [["diff", "A/B", 3]]);
  X.conventionEdits.stopSuggesting(D.p, X.offers(D.p)[0]);
  assert.deepEqual(X.offers(D.p), []);
  assert.deepEqual(D.p.signals.conventions.never.pair, ["A/B"]);
  assert.equal(X.classify("VPROG").role, "signal");
  for (const [group, kind, word] of [["stems", "rail", "VPROG"], ["stems", "ground", "GND_MOT"], ["stems", "clock", "SYSREF"], ["never", "rail", "VSEL"]]) X.conventionEdits.addWord(D.p, group, kind, word);
  const conv = X.conventions(D.p).effective;
  assert.equal(X.classify("VPROG", conv).role, "rail");
  assert.deepEqual([X.classify("VPROG_EN", conv).role, X.classify("VPROG_EN", conv).rail], ["railSignal", "VPROG"]);
  assert.equal(X.classify("GND_MOT", conv).role, "ground");
  assert.equal(X.classify("SYSREF", conv).role, "clock");
  assert.equal(X.classify("VSEL_3V3", conv).role, "signal", "VSEL is not a rail here");
  assert.deepEqual(kinds(X.suggest(D.p)), ["rail:VPROG", "ground:GND_MOT"]);
  assert.equal(X.suggest(D.p)[0].basis, "by the project's naming dictionary");
  assert.throws(() => X.conventionEdits.addWord(D.p, "stems", "rail", "a b"), /dictionary word/);
  X.conventionEdits.removeWord(D.p, "stems", "rail", "vprog");
  assert.equal(X.classify("VPROG", X.conventions(D.p).effective).role, "signal");
});

test("lone _N: active low by default; a pair member when the Naming view says so (then CLK_N pairs with CLK_P only by its partner)", () => {
  const D = design([], {labels: ["RST_N", "RST_P"]});
  assert.equal(X.classify("RST_N").role, "control");
  assert.deepEqual(kinds(X.suggest(D.p)), ["diff:RST"], "with its _P present it is a pair");
  X.conventionEdits.set(D.p, "loneN", "pair");
  assert.equal(X.classify("CS_N", X.conventions(D.p).effective).role, "pairMember");
});

test("conventions: rails 3V3 learned from five power ports (≥ 90 %), active low n, keep and forget", () => {
  const rails = ["3V3", "1V8", "5V0", "12V0", "2V5", "1V2"];
  const D = design([], {labels: [...rails, "nRST", "nCS", "nOE", "nWE", "nIRQ", "+3.3V", "USB_DP", "USB_DM"]});
  const C = X.conventions(D.p), rail = C.learned.find(c => c.id === "rail"), low = C.learned.find(c => c.id === "activeLow");
  assert.deepEqual([rail.value, rail.status, rail.n, rail.total], ["3V3 · 5V0", "seen", 6, 7], "6 of 7 is under 90 %: seen, not applied");
  assert.deepEqual(rail.others.map(o => o.value), ["+3.3V · +5V"]);
  assert.deepEqual([low.value, low.status, low.n, low.describe], ["n", "learned", 5, "nRST, nCS"]);
  X.conventionEdits.keep(D.p, "rail", X.railStyleOf("3V3"));
  const K = X.conventions(D.p);
  assert.equal(K.learned.find(c => c.id === "rail").status, "kept");
  assert.equal(X.renderRail(1.5, K.effective.rail), "1V5");
  X.conventionEdits.forget(D.p, "activeLow");
  assert.equal(X.conventions(D.p).learned.find(c => c.id === "activeLow").status, "forgotten");
  assert.equal(X.conventions(D.p).effective.activeLow, null);
  X.conventionEdits.reset(D.p, "activeLow");
  assert.equal(X.conventions(D.p).effective.activeLow, "n");
  for (const [v, s, out] of [[3.3, "+3.3V", "+3.3V"], [5, "+3.3V", "+5V"], [12, "5V0", "12V0"], [-12, "+5V", "-12V"], [0.9, "VCC_3V3", "VCC_0V9"], [-5, "P3V3", "N5V"]]) assert.equal(X.renderRail(v, X.railStyleOf(s)), out, s);
});

test("completion: the missing partner, the next and missing bus member, rails in the project's style, active low, existing names by use", () => {
  const D = design([], {labels: ["USB_DP", "D0", "D1", "D2", "D4", "3V3", "1V8", "nRST", "nCS", "nOE", "nWE", "nIRQ", "SPI_MOSI", "SPI_MOSI", "SPI_MISO", "GND"]});
  const names = (q, o) => X.complete(D.p, q, o).map(c => c.name);
  assert.equal(names("USB_D")[0], "USB_DM");
  assert.equal(X.complete(D.p, "USB_D")[0].why, "partner of USB_DP");
  assert.deepEqual(names("D").slice(0, 2), ["D3", "D5"]);
  assert.equal(X.complete(D.p, "D")[0].why, "missing from D0–D4");
  assert.equal(names("2.5", {kind: "power"})[0], "2V5", "the project writes 3V3, not +2.5V");
  assert.equal(names("+12v", {kind: "power"})[0], "12V");
  assert.deepEqual(names("SPI_M"), ["SPI_MOSI", "SPI_MISO"], "by use");
  assert.equal(names("g", {kind: "power"})[0], "GND");
  assert.equal(names("wp")[0], "nWP", "a control word in the project's active-low style");
  assert.deepEqual(names("USB_DP"), [], "nothing to add to an exact name");
  // A fresh project: power ports default to +3V3 style.
  assert.equal(X.complete(design([]).p, "3.3", {kind: "power"})[0].name, "+3V3");
});

test("incremental: the journal patches a board part and skips a sheet's non-electrical edits; suggestions recompute only touched buckets", () => {
  const D = design([{def: "conn", ref: "J1", nets: ["USB_DP", "USB_DM", "VBUS", "GND"]}], {labels: ["D0", "D1", "D2", "A0", "A1", "A2"]});
  for (let k = 0; k < 40; k++) D.pcb.items.push({id: "b" + k, kind: "part", def: "two", ref: "R" + k, x: k, y: 0, angle: 0, pinNets: {1: "N" + k + "_P", 2: "N" + k + "_N"}});
  // A minimal undo store: the journal of changed ids per document, as AtriumUndoStore.changed reports it.
  let seq = 0, lib = 0; const log = [];
  globalThis.AtriumUndoStore = {
    documentVersions: (doc) => ({seq, items: log.filter(e => e.doc === doc).length, library: lib}),
    changed(doc, since) { const ids = new Set(), items = new Map(); for (const e of log.slice(since)) if (e.doc === doc) { ids.add(e.id); const live = doc.items.find(i => i.id === e.id); if (live) items.set(e.id, live); } return {seq, ids, items}; }
  };
  const touch = (doc, id) => { log.push({doc, id}); seq = log.length; };
  try {
    X.resetStats();
    const F0 = X.facts(D.p), s0 = X.suggest(D.p), st0 = X.stats();
    assert.equal(st0.sheets + st0.boards, 2);
    // A graphic on the sheet: no re-read.
    D.sch.items.push({id: "g1", kind: "graphic", x: 0, y: 0}); touch(D.sch, "g1");
    assert.equal(X.facts(D.p), F0, "nothing electrical changed: the same facts");
    // A board part's nets change: patched alone, and equal to a fresh build.
    const at = id => D.pcb.items.findIndex(i => i.id === id);
    D.pcb.items[at("b3")].pinNets = {1: "M3_P", 2: "M3_N"}; touch(D.pcb, "b3");
    D.pcb.items.splice(at("b6"), 1); touch(D.pcb, "b6");
    X.resetStats();
    const F1 = X.facts(D.p), st1 = X.stats();
    assert.deepEqual([st1.patched, st1.sheets, st1.boards], [1, 0, 0]);
    const s1 = X.suggest(D.p);
    assert.ok(X.stats().buckets <= 3, "only the touched stems: " + X.stats().buckets);
    globalThis.AtriumUndoStore = undefined;
    const fresh = X.facts(D.p);
    const flat = F => JSON.stringify([...F.names].map(([n, e]) => [n, e.n, e.board]).sort(), null, 0) + JSON.stringify([...F.boardPins].map(([n, s]) => [n, [...s].map(p => p.ref + p.number).sort()]).sort());
    assert.ok(flat(F1) === flat(fresh), "the patched facts equal a fresh build");
    assert.deepEqual(kinds(s1), kinds(X.suggest(D.p)));
    assert.ok(kinds(s1).includes("diff:M3") && !kinds(s1).includes("diff:N3") && !kinds(s1).includes("diff:N6"));
    assert.ok(s0.length > 0);
  } finally { globalThis.AtriumUndoStore = undefined; }
});

test("MCP: conventions and completion read as the Naming view does", () => {
  const D = design([], {labels: ["3V3", "1V8", "2V5", "1V2", "5V0", "USB_DP"]});
  const H = {project: () => D.p};
  const c = X.headless({action: "conventions"}, H);
  assert.equal(c.learned.find(x => x.id === "rail").status, "learned");
  assert.equal(c.lone_n, "activeLow");
  assert.deepEqual(X.headless({action: "complete", name: "USB_"}, H).completions[0], {name: "USB_DM", why: "partner of USB_DP"});
});

test("cost: facts and suggestions for 20k names stay within budget", () => {
  const labels = [];
  for (let k = 0; k < 5000; k++) labels.push("L" + k + "_P", "L" + k + "_N", "Q" + k, k % 50 ? "SIG" + k : "R" + (k / 50) + "V3");
  const D = design([], {labels});
  const t0 = Date.now(); X.facts(D.p); const t1 = Date.now(); X.suggest(D.p); const t2 = Date.now(); X.complete(D.p, "L12"); const t3 = Date.now();
  console.log("index: 20k names, facts " + (t1 - t0) + " ms, suggest " + (t2 - t1) + " ms, complete " + (t3 - t2) + " ms");
  assert.ok(t2 - t0 < 3000 && t3 - t2 < 1500, "cold, without the undo journal (the editor reuses the facts)");
});
console.log("net-intent-index: " + passed + " tests passed");
