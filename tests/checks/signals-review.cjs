"use strict";
// Regressions from the review of the signals work (C1–C9): a class edit keeps every role of a dual-role tag;
// deleting a pair keeps the xSignals it hosts; deleted classes and derived stages stay deleted; InxSignal
// keeps a stored xSignal's end nets; spans stop at high fan-out nets and bussed resistor networks; rails the
// old regexes knew stay rails; undo across adoption; the cost of a rule query with a store (headless).
const assert = require("node:assert/strict");
for (const f of ["model", "net-intent", "query", "rules", "signals"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const S = AtriumSignals, R = AtriumRules;
const part = (ref, pinNets) => ({id: "p-" + ref, kind: "part", ref, def: "d", value: "", x: 0, y: 0, pinNets});
const ic = (ref, nets) => part(ref, Object.fromEntries(nets.map((n, i) => [String(i + 1), n])));
const mk = () => ({id: "b1", kind: "pcb", name: "B", items: [ic("U1", ["USB_P", "USB_N", "X", "Y", "Z"]), ic("J1", ["USB_P", "USB_N", "X", "Y", "Z"])]});
const rules = extra => R.validate(R.normalize({...R.migrate(null), ...extra}));
const proj = b => S.attach({format: "atrium", documents: [b], library: []});
const adopt = p => S.edit(p, st => { st.tags.push({name: "Other"}); });

// Class edits (an importer's or an editor's class view) go through AtriumSignals.applyClasses.
const classes = (p, b, keys) => S.applyClasses(p, b, keys);
{
  // #1 A net class and a pair class of one name are one tag; adding a net to the net class keeps the pair
  // class's member, and the reverse.
  const b = mk(), p = proj(b);
  classes(p, b, {netClasses: {USB: ["USB_N", "USB_P"]}, diffPairs: [{name: "USBD", positive: "USB_P", negative: "USB_N"}], diffPairClasses: {USB: ["USBD"]}});
  classes(p, b, {netClasses: {USB: ["USB_N", "USB_P", "X"]}});
  let L = S.model(p, b).legacy();
  assert.deepEqual(L.netClasses.USB, ["USB_N", "USB_P", "X"]);
  assert.deepEqual(L.diffPairClasses.USB, ["USBD"], "the pair class survives a net-class edit");
  assert.equal(R.query(b, "width", {net: "USB_P"}, {project: p}) !== undefined, true);
  // Reverse: the pair class loses its pair; the net class keeps its nets.
  const b2 = mk(), p2 = proj(b2);
  classes(p2, b2, {netClasses: {USB: ["USB_N", "USB_P"]}, diffPairs: [{name: "USBD", positive: "USB_P", negative: "USB_N"}], diffPairClasses: {USB: ["USBD"]}});
  classes(p2, b2, {diffPairClasses: {USB: []}});
  L = S.model(p2, b2).legacy();
  assert.deepEqual(L.netClasses.USB, ["USB_N", "USB_P"], "the net class survives a pair-class edit");
  assert.deepEqual(L.diffPairClasses.USB, []);
}
{
  // #2 Deleting a pair that hosts an xSignal keeps the xSignal (on a single-ended signal).
  const b = mk();
  const p = proj(b);
  classes(p, b, {xSignals: [{name: "XP", from: {ref: "U1", pin: "1"}, to: {ref: "J1", pin: "1"}, nets: ["USB_P"]}]});
  classes(p, b, {diffPairs: [{name: "USBD", positive: "USB_P", negative: "USB_N"}]});
  classes(p, b, {diffPairs: []});
  const L = S.model(p, b).legacy();
  assert.deepEqual(L.xSignals.map(x => x.name), ["XP"]);
  assert.equal(p.signals.signals.flatMap(s => s.paths || []).filter(x => x.name === "XP").length, 1, "one path, hosted once");
  assert.ok(!L.diffPairs.length, "the pair is gone");
}
{
  // #3 A deleted class stays deleted; deleting a derived stage (D.1) excludes its series parts.
  const b = {id: "b1", kind: "pcb", name: "B", items: [ic("U1", ["A", "B", "C"]), ic("U2", ["A", "B", "C"])]}, p = proj(b);
  classes(p, b, {netClasses: {HS: ["A"], LS: ["C"]}});
  classes(p, b, {netClasses: {LS: ["C"]}});
  assert.deepEqual(S.model(p, b).legacy().netClasses, {LS: ["C"]});
  const b2 = {id: "b2", kind: "pcb", name: "B2", items: [ic("U1", ["DP", "DN", "q"]), part("C1", {1: "DP", 2: "DP1"}), part("C2", {1: "DN", 2: "DN1"}), ic("J1", ["DP1", "DN1", "r"])]};
  const p2 = proj(b2);
  S.edit(p2, st => { st.signals.push({id: "d", name: "D", kind: "diff", legs: [{polarity: 1, nets: ["DP"]}, {polarity: -1, nets: ["DN"]}]}); });
  const pairs = R.effective(b2, p2).diffPairs;
  assert.deepEqual(pairs.map(x => x.name), ["D", "D.1"]);
  classes(p2, b2, {diffPairs: pairs.filter(x => x.name !== "D.1")});
  assert.deepEqual(S.model(p2, b2).legacy().diffPairs.map(x => x.name), ["D"]);
  assert.deepEqual(p2.signals.signals[0].exclude.sort(), ["p-C1", "p-C2"]);
}
{
  // #4 InxSignal of a stored xSignal without nets: its end nets, not the whole signal.
  const b = mk();
  const p = proj(b);
  classes(p, b, {xSignals: [{name: "XP", from: {ref: "U1", pin: "1"}, to: {ref: "J1", pin: "1"}}]});
  classes(p, b, {diffPairs: [{name: "USBD", positive: "USB_P", negative: "USB_N"}]});
  assert.deepEqual([...S.scopeEnv(b, p).xs.byName.get("xp")], ["usb_p"]);
}
{
  // #7 #8 Spans stop at high fan-out nets, bussed networks and rails the old regexes knew.
  const many = Array.from({length: 10}, (_, i) => ic("L" + i, ["BUSNET", "q" + i]));
  const b = {id: "b1", kind: "pcb", name: "B", items: [ic("U1", ["SIG", "SIG2", "a", "b"]), part("R1", {1: "SIG", 2: "BUSNET"}), ...many,
    part("R2", {1: "SIG2", 2: "VBATT"}), part("RN1", {1: "VIO", 2: "D1", 3: "D2", 4: "D3", 5: "D4", 6: "D5", 7: "D6", 8: "D7", 9: "D8", 10: "D9"})]};
  const p = proj(b);
  S.edit(p, st => { st.signals.push({id: "s", name: "S", kind: "single", legs: [{nets: ["SIG"]}]}, {id: "s2", name: "S2", kind: "single", legs: [{nets: ["SIG2"]}]}, {id: "d", name: "D", kind: "single", legs: [{nets: ["D1"]}]}); });
  const M = S.model(p, b);
  assert.deepEqual(M.signals.find(s => s.name === "S").legs[0].nets, ["SIG"], "no span into a 11-pin net");
  assert.ok(M.issues.some(i => i.kind === "fanout" && i.net === "BUSNET"));
  assert.deepEqual(M.signals.find(s => s.name === "S2").legs[0].nets, ["SIG2"], "VBATT is a rail");
  assert.deepEqual(M.signals.find(s => s.name === "D").legs[0].nets, ["D1"], "a bussed network (pin 1 on VIO) joins nothing");
  assert.deepEqual(S.series(b.items.find(i => i.ref === "RN1")), []);
  for (const n of ["VBATT", "V_BAT", "+BATT", "VUSB", "V_USB", "VIO"]) assert.ok(AtriumNetIntent.isRail(n), n);
}
{
  // Undo across adoption: the project as it was (no store) reads as before and saves as is.
  const b = mk(), p = proj(b), before = JSON.stringify(p);
  adopt(p);
  assert.ok(p.signals);
  delete p.signals;      // what undo restores
  assert.equal(JSON.stringify(p), before);
  assert.deepEqual(R.netClasses(b, {project: p}), {});
  assert.equal(S.scopeEnv(b, p), null);
}
{
  // #5 #6 Headless cost: per-object rule queries with a store stay within a few times the legacy path.
  const items = [];
  for (let i = 0; i < 1500; i++) items.push({id: "u" + i, kind: "part", ref: "U" + i, def: "d", x: 0, y: 0, pinNets: Object.fromEntries(Array.from({length: 8}, (_, k) => [String(k + 1), "N" + ((i * 8 + k) % 3000)]))});
  for (let i = 0; i < 300; i++) items.push(part("R" + i, {1: "N" + i, 2: "M" + i}));
  const b = {id: "b1", kind: "pcb", name: "B", items};
  const keys = {netClasses: Object.fromEntries(Array.from({length: 20}, (_, c) => ["C" + c, Array.from({length: 40}, (_, k) => "N" + (c * 40 + k))])),
    diffPairs: Array.from({length: 100}, (_, k) => ({name: "P" + k, positive: "N" + (2 * k + 2000), negative: "N" + (2 * k + 2001)}))};
  const p = proj(b), plain = rules(keys);
  // Legacy path: a rule set that carries its own classes and pairs (no store); then the same classes in a store.
  const time = (n, o) => { const t0 = Date.now(); for (let i = 0; i < n; i++) R.query(b, "clearance", {net: "N" + i}, {project: p, ...o}); return (Date.now() - t0) / n; };
  const legacy = time(300, {rules: plain});
  classes(p, b, keys);
  S.edit(p, st => { st.signals.push({id: "sx", name: "SPAN", kind: "single", legs: [{nets: ["N5"]}]}); });
  const store = time(300, {});
  assert.ok(store < Math.max(1, legacy * 6), "a rule query with a store costs " + store.toFixed(3) + " ms (legacy " + legacy.toFixed(3) + " ms)");
  // A part moved (no netlist change) keeps the model; a pin moved to another net rebuilds it.
  const M = S.model(p, b);
  b.items[0] = {...b.items[0], x: 5};
  assert.equal(S.model(p, b), M, "a move is not a netlist change");
  b.items[0] = {...b.items[0], pinNets: {...b.items[0].pinNets, 1: "NEWNET"}};
  assert.notEqual(S.model(p, b), M);
}
console.log("signals-review ok");
