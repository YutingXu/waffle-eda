"use strict";
// Intent insights (app/checks/insights-intent.js): each check finds its case and
// stays quiet on a false-positive set (designs where it must not fire); messages say the basis; fixes are one
// edit that clears the insight; the checks join the one check registry as schematic.hint.* / layout.hint.*.
// Run: node tests/checks/insights-intent.cjs   (or scripts/test-jsc.sh insights-intent)
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "erc", "net-intent", "altium-rules", "query", "signals", "rules", "net-intent-index", "insights", "insights-sch", "insights-intent", "checks"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, I = AtriumInsights, X = AtriumNetIntentIndex;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

// ---------------------------------------------------------------- fixtures
// A part definition whose symbol pins carry names; parts are placed 30 mm apart and every pin gets a
// net label at its connection point (labels: one name, or several names on one net).
const def = (id, pins, prefix = "U") => ({id, name: id, prefix, symbol: {pins: pins.map((n, i) => ({number: String(i + 1), name: n, x: 0, y: -i * 2.54})), shapes: []}});
const LIB = [def("conn", ["D+", "D-", "VBUS", "GND"], "J"), def("phy", ["TXP", "TXN", "RXP", "RXN"]), def("two", ["1", "2"], "R"), def("cap", ["1", "2"], "C"),
  def("reg", ["VDD_1V8", "VDD", "VCCIO_3V3", "5V", "VDDIO_1V8_3V3", "1V8", "GND"]), def("rs485", ["A", "B", "DE", "RE"]), def("iso", ["GND1", "GND2", "VIN", "VOUT"]),
  {...def("supply", ["VIN", "VOUT", "FB", "GND"]), category: "Voltage regulator"},
  {...def("switcher", ["VIN", "SW", "FB", "GND"]), category: "Buck regulator"}];
let uid = 0;
function design(parts, o = {}) {
  const p = A.project("Intent", LIB), sch = p.documents[0], defs = new Map(LIB.map(d => [d.id, d]));
  parts.forEach((x, k) => {
    const d = defs.get(x.def), part = {id: "p" + (++uid), kind: "part", def: x.def, ref: x.ref, value: x.value ?? "", x: k * 30, y: 0, angle: 0, pinNets: {}, ...(x.parameters ? {parameters: x.parameters} : {})};
    sch.items.push(part);
    A.pins(part, d, "schematic").forEach((pin, i) => {
      for (const n of [].concat(x.nets[i] ?? [])) if (n) sch.items.push({id: "l" + (++uid), kind: (o.power || []).includes(n) ? "power" : "netlabel", text: n, x: pin.at[0], y: pin.at[1], ...((o.power || []).includes(n) ? {style: "bar"} : {})});
    });
  });
  for (const [n, k] of (o.labels || []).map((n, k) => [n, k])) sch.items.push({id: "l" + (++uid), kind: "netlabel", text: n, x: 500, y: k * 5});
  if (o.signals) p.signals = o.signals;
  return {p, sch, defs};
}
const run = ({p, sch, defs}, check, opts = {}) => I.analyze(p, sch, defs, {checks: [check], ...opts}).insights;
function pair(check, bad, goods) {
  const found = run(bad, check);
  assert.ok(found.length > 0, check + ": the case is found");
  for (const x of found) { assert.ok(x.message && x.why && x.title && x.key.startsWith(check + ":"), check + " reads well"); assert.ok(x.at.every(Number.isFinite)); }
  goods.forEach((g, i) => { const n = run(g, check); assert.equal(n.length, 0, check + ": false positive #" + i + ": " + n.map(x => x.message).join(" | ")); });
  return found;
}
const fix = (D, x) => { x.fix.apply(D.sch, D.p, D.defs); };

// ---------------------------------------------------------------- pairSwap
test("pairSwap: USB_DP on J1 pin D− and USB_DM on D+; quiet when wired right, for PCIe at an IC, A/B, numbered pins, one crossed pin", () => {
  const bad = design([{def: "conn", ref: "J1", nets: ["USB_DM", "USB_DP", "VBUS", "GND"]}]);
  const [x] = pair("pairSwap", bad, [
    design([{def: "conn", ref: "J1", nets: ["USB_DP", "USB_DM", "VBUS", "GND"]}]),
    design([{def: "phy", ref: "U1", nets: ["PCIE_TX0_N", "PCIE_TX0_P", "PCIE_RX0_P", "PCIE_RX0_N"]}]),
    design([{def: "rs485", ref: "U2", nets: ["RS485_B", "RS485_A", "DE", "RE"]}]),
    design([{def: "two", ref: "R1", nets: ["USB_DM", "USB_DP"]}]),
    design([{def: "conn", ref: "J1", nets: ["USB_DM", "OTHER", "VBUS", "GND"]}, {def: "two", ref: "R2", nets: ["USB_DP", "X"]}])]);
  assert.match(x.message, /USB_DP \(positive by its name\) lands on J1 pin D-, and USB_DM on pin D\+/);
  // A PCIe lane swapped at a connector is reported (the inversion is only corrected inside the link).
  assert.equal(run(design([{def: "phy", ref: "J4", nets: ["PCIE_TX0_N", "PCIE_TX0_P", "PCIE_RX0_P", "PCIE_RX0_N"]}]), "pairSwap").length, 1);
  // A declared differential signal counts with the polarity of its legs.
  const declared = design([{def: "conn", ref: "J1", nets: ["DATA_A", "DATA_B", "VBUS", "GND"]}], {signals: {version: 1, signals: [{id: "s1", name: "DATA", kind: "diff", legs: [{polarity: 1, nets: ["DATA_B"]}, {polarity: -1, nets: ["DATA_A"]}]}], tags: []}});
  assert.equal(run(declared, "pairSwap").length, 1);
});

// ---------------------------------------------------------------- pairOrphan
test("pairOrphan: a lone _P where the project names two pairs _P/_N; a near miss renamed by the fix; quiet on RST_N, one pair, A/B, analog, TX/RX", () => {
  const lvds = (extra) => design([{def: "phy", ref: "U1", nets: ["LVDS0_P", "LVDS0_N", "LVDS1_P", "LVDS1_N"]}, ...extra]);
  const bad = lvds([{def: "two", ref: "R1", nets: ["LVDS2_P", "X1"]}]);
  const [x] = pair("pairOrphan", bad, [
    lvds([{def: "two", ref: "R1", nets: ["LVDS2_P", "LVDS2_N"]}]),
    lvds([{def: "two", ref: "R1", nets: ["RST_N", "X1"]}]),
    design([{def: "phy", ref: "U1", nets: ["LVDS0_P", "LVDS0_N", "CLK_N", "X"]}]),
    lvds([{def: "rs485", ref: "U2", nets: ["RS485_A", "X", "DE", "RE"]}]),
    lvds([{def: "two", ref: "R1", nets: ["ADC_INP", "X1"]}]),
    lvds([{def: "two", ref: "R1", nets: ["UART_TX", "UART_RX"]}])]);
  assert.equal(x.message, "LVDS2_P has no partner LVDS2_N, though this project names 2 pairs P/N (by its name).");
  assert.ok(!x.fix);
  const near = design([{def: "two", ref: "R1", nets: ["PCIE_TX1_P", "PCIE_TX1_M"]}]);
  const [y] = run(near, "pairOrphan");
  assert.match(y.message, /PCIE_TX1_P has no partner PCIE_TX1_N; PCIE_TX1_M is probably meant/);
  fix(near, y);
  assert.equal(run(near, "pairOrphan").length, 0, "the rename made the pair");
  assert.ok(near.sch.items.some(i => i.text === "PCIE_TX1_N"));
  // The Naming view's "lone _N is a pair member" turns RST_N... no: RST_N stays control; CLK_N in a P/N project is an orphan.
  const clk = lvds([{def: "two", ref: "R1", nets: ["CLK_N", "X1"]}]);
  assert.equal(run(clk, "pairOrphan").length, 1, "a lone CLK_N in a P/N project is half a pair");
});

// ---------------------------------------------------------------- railConflict
test("railConflict: one net named 3V3 and +5V, 3V3 and GND, 3V3 and +3V3 (fix); quiet for VCC/3V3, grounds, a rail signal, VBUS/5V spelling", () => {
  const on = names => design([{def: "two", ref: "R1", nets: [names, "X"]}]);
  const [v] = pair("railConflict", on(["3V3", "+5V"]), [on(["VCC", "3V3"]), on(["AGND", "GND"]), on(["3V3", "3V3_EN"]), on(["3V3"]), on(["VBUS", "5V"])]);
  assert.match(v.message, /This net is both 3V3 \(3\.3 V\) and \+5V \(5 V\), by their names\./);
  assert.equal(v.severity, "advice");
  assert.match(run(on(["3V3", "GND"]), "railConflict")[0].message, /both the rail 3V3 and the ground GND/);
  const same = design([{def: "two", ref: "R1", nets: [["3V3", "+3V3"], "X"]}, {def: "two", ref: "R2", nets: ["3V3", "Y"]}]);
  const [s] = run(same, "railConflict");
  assert.equal(s.severity, "tip");
  assert.match(s.message, /named both 3V3 and \+3V3: one 3\.3 V rail with two spellings/);
  assert.equal(s.fix.label, "Use 3V3 for +3V3");
  fix(same, s);
  assert.equal(run(same, "railConflict").length, 0);
});

// ---------------------------------------------------------------- railPinMismatch
test("railPinMismatch: U1 pin VDD_1V8 on 3V3; quiet for VDD, VCCIO_3V3 on VCC_3V3, 5V on VBUS, two voltages in a pin name, unknown rail voltage", () => {
  const reg = nets => design([{def: "reg", ref: "U1", nets}]);
  const [x] = pair("railPinMismatch", reg(["3V3", "3V3", "VCC_3V3", "VBUS", "3V3", "VDD", "GND"]), [
    reg(["1V8", "3V3", "VCC_3V3", "VBUS", "3V3", "VDD", "GND"]),
    reg(["VDD_1V8", "VDD", "3.3V", "+5V", "VCCIO", "VCORE", "GND"]),
    reg(["X1", "X2", "X3", "X4", "X5", "X6", "X7"])]);
  assert.equal(x.message, "U1 pin VDD_1V8 (1.8 V by the pin name) is on 3V3 (3.3 V by its name).");
  assert.equal(run(reg(["3V3", "3V3", "VCC_3V3", "VBUS", "3V3", "VDD", "GND"]), "railPinMismatch").length, 1, "only VDD_1V8: VDDIO_1V8_3V3 names two voltages");
});
test("regulator evidence gives schematic rail checks a voltage and basis, even for an unlabelled voltage", () => {
  const supply = {def: "supply", ref: "U7", nets: ["INPUT", "HEATER", "FEEDBACK", "GND"], parameters: {"Output voltage (mV)": "48000"}};
  const load = {def: "reg", ref: "U8", nets: ["HEATER"]};
  const cap = {def: "cap", ref: "C1", value: "10u/25V", nets: ["HEATER", "GND"]};
  const d = design([supply, load, cap]);
  assert.match(run(d, "railPinMismatch")[0].message, /HEATER \(48 V from Output voltage \(mV\) on U7\)/);
  assert.match(run(d, "capRating")[0].message, /48 V.*HEATER: 48 V from Output voltage \(mV\) on U7.*GND: 0 V by its name/);
  const named = design([{...supply, nets: ["INPUT", "12V", "FEEDBACK", "GND"]}]);
  assert.match(run(named, "railPinMismatch")[0].message, /U7 pin VOUT supplies 48 V.*12V is named for 12 V/);
  const typed = {...supply, def: "iso", nets: ["GND", null, "INPUT", "HEATER"], parameters: {"Part type": "Buck", Vout: "48V0"}};
  assert.match(run(design([typed, load]), "railPinMismatch")[0].message, /HEATER \(48 V from Vout on U7\)/);
  for (const candidate of [
    {...supply, def: "switcher"},
    {...supply, def: "iso"},
    {...supply, parameters: {Vout: "12–48 V"}},
    {...supply, parameters: {Vout: "48 V AC"}},
    {...supply, parameters: {Vout: "48 mA"}},
    {...supply, parameters: {Vout: "48 MV"}}
  ]) assert.equal(run(design([candidate, load, cap]), "railPinMismatch").length, 0);
});

test("feedback divider requires two resistors to the regulator's output and return, and a stated reference", () => {
  const supply = {def: "supply", ref: "U7", nets: ["INPUT", "HEATER", "REF", "GND"], parameters: {Vref: "800 mV"}};
  const top = {def: "two", ref: "R1", nets: ["HEATER", "REF"], value: "59k"};
  const bottom = {def: "two", ref: "R2", nets: ["REF", "GND"], value: "1K0"};
  const load = {def: "reg", ref: "U8", nets: ["HEATER"]};
  const make = (a, b, c, extra = []) => design([a, b, c, load, ...extra]);
  assert.match(run(make(supply, top, bottom), "railPinMismatch")[0].message, /48 V estimated from the feedback divider on U7 \(R1 59 kΩ, R2 1 kΩ; 0\.8 V reference\)/);
  for (const d of [
    make({...supply, parameters: {}}, top, bottom),
    make(supply, {...top, value: "0R"}, bottom),
    make(supply, top, {...bottom, nets: ["REF", "PGND"]}),
    make(supply, top, {...bottom, value: "1k to 3k"}),
    make(supply, top, bottom, [{...bottom, ref: "R3"}]),
    make({...supply, parameters: {Vref: ".8 V", Vout: "5 V"}}, top, bottom)
  ]) assert.equal(run(d, "railPinMismatch").length, 0, "ambiguous or incomplete dividers leave the rail voltage unknown");
});

// ---------------------------------------------------------------- capRating
test("capRating: 6.3 V on 12V (below), 16 V on 12V (under 1.5×); quiet for 25 V, no rating, unknown rail, signals, a parameter rating, a resistor", () => {
  const cap = (value, nets, extra = {}) => design([{def: "cap", ref: "C1", value, nets, ...extra}]);
  const [x] = pair("capRating", cap("100n/6.3V", ["12V", "GND"]), [
    cap("100n 25V", ["12V", "GND"]), cap("100n", ["12V", "GND"]), cap("100n 6.3V", ["VCC", "GND"]), cap("100n 6.3V", ["SIG_A", "SIG_B"]),
    cap("10u", ["24V", "GND"], {parameters: {Voltage: "50V"}}), design([{def: "two", ref: "R1", value: "10V", nets: ["12V", "GND"]}])]);
  assert.equal(x.severity, "advice");
  assert.equal(x.message, "C1 is rated 6.3 V across 12V (12 V by its name): below the rail itself.");
  const [y] = run(cap("10u 16V", ["12V", "GND"]), "capRating");
  assert.equal(y.severity, "tip");
  assert.match(y.message, /rated 16 V across 12V \(12 V by its name\): under 1\.5× derating/);
  assert.equal(run(cap("10u 16V", ["12V", "GND"]), "capRating", {settings: {capRating: {derate: 1.25}}}).length, 0, "the derating is a setting");
  // Between two rails the voltage across is their difference: 1.7 V needs 2.55 V at 1.5×.
  assert.match(run(cap("1u/2.5V", ["5V", "3V3"]), "capRating")[0].message, /rated 2\.5 V across 5V\/3V3 \(1\.7 V by its name\)/);
  assert.equal(run(cap("1u/6.3V", ["5V", "3V3"]), "capRating").length, 0);
});

// ---------------------------------------------------------------- busGap
test("busGap: D0–D7 without D5; quiet for a full bus, three members, three holes, a misspelt member, rails, a never-suggested stem", () => {
  const bus = (names, o) => design([], {labels: names, ...o});
  const [x] = pair("busGap", bus(["D0", "D1", "D2", "D3", "D4", "D6", "D7"]), [
    bus(["D0", "D1", "D2", "D3", "D4", "D5", "D6", "D7"]), bus(["D0", "D1", "D5"]), bus(["ADDR0", "ADDR1", "ADDR2", "ADDR6", "ADDR7"]),
    bus(["D0", "D1", "D2", "D3", "D4", "d_5", "D6", "D7"]), bus(["VDD1", "VDD2", "VDD4", "VDD5"]),
    bus(["D0", "D1", "D2", "D3", "D4", "D6", "D7"], {signals: {version: 1, signals: [], tags: [], conventions: {never: {bus: ["D"]}}}})]);
  assert.equal(x.message, "D0–D7 has no D5 (by their names).");
  assert.equal(run(bus(["A_1", "A_2", "A_4", "A_6", "A_7"]), "busGap")[0].message, "A_1–A_7 has no A_3, A_5 (by their names).");
});

// ---------------------------------------------------------------- isolationBridge
test("isolationBridge: GND_ISO named GND, a 0R and a ferrite across the barrier; quiet for a Y capacitor, a bleeder, 10k, AGND/DGND 0R, an isolator", () => {
  const across = (ref, def, value, a = "GND_ISO", b = "GND") => design([{def, ref, value, nets: [a, b]}]);
  pair("isolationBridge", design([{def: "two", ref: "R1", value: "1k", nets: [["GND_ISO", "GND"], "X"]}]), [
    across("C1", "cap", "4.7nF Y2"), across("R1", "two", "1M"), across("R1", "two", "10k"), across("R1", "two", "0R", "AGND", "DGND"),
    design([{def: "iso", ref: "U1", nets: ["GND", "GND_ISO", "3V3", "ISO_5V"]}]), design([{def: "two", ref: "R1", value: "0R", nets: ["GND_ISO", "X"]}])]);
  for (const [ref, d, v] of [["R5", "two", "0R"], ["R6", "two", "0 Ω"], ["FB1", "two", "600R@100MHz"], ["JP1", "two", ""]]) {
    const [x] = run(across(ref, d, v), "isolationBridge");
    assert.ok(x, ref + " bridges");
    assert.equal(x.message, ref + " joins GND_ISO and GND: the isolation barrier is bridged (by their names).");
  }
  // The board: a 0 Ω part between the isolated and the main ground.
  const p = A.project("Iso", LIB), pcb = A.sheet("pcb", "Board");
  pcb.items.push({id: "b1", kind: "part", def: "two", ref: "R7", value: "0R", x: 5, y: 5, angle: 0, pinNets: {1: "GND_ISO", 2: "GND"}},
    {id: "b2", kind: "part", def: "cap", ref: "C7", value: "2.2nF", x: 9, y: 5, angle: 0, pinNets: {1: "GND_ISO", 2: "GND"}});
  p.documents = [pcb];
  const hits = I.analyze(p, pcb, new Map(LIB.map(d => [d.id, d])), {checks: ["isolationBridgeBoard"]}).insights;
  assert.deepEqual(hits.map(h => h.objects[0]), ["b1"]);
});

// ---------------------------------------------------------------- nameSuggestion (P1 as quiet hints)
test("nameSuggestion: a pair and a bus the names suggest; declaring clears it; a declared or declined pair is quiet; dismissing the hint declines it", () => {
  const D = design([{def: "conn", ref: "J1", nets: ["USB_DP", "USB_DM", "VBUS", "GND"]}], {labels: ["A0", "A1", "A2", "A3"]});
  const hints = run(D, "nameSuggestion");
  assert.deepEqual(hints.map(h => h.message), ["USB_DP and USB_DM look like one differential pair (by pin D+ on J1).", "A0–A3 look like one bus of 4 nets (by their names)."]);
  assert.equal(hints[0].severity, "tip");
  assert.equal(hints[0].fix.label, "Declare pair USB");
  const host = {project: () => D.p, edit: fn => fn(), info() {}};
  hints[0].fix.open(host);
  assert.deepEqual(run(D, "nameSuggestion").map(h => h.message), ["A0–A3 look like one bus of 4 nets (by their names)."]);
  assert.equal(D.p.signals.signals.find(s => s.kind === "diff").intent.source, "name");
  // Dismissed in Insights = declined in the Signals panel.
  const bus = run(D, "nameSuggestion")[0];
  I.dismiss(D.p, bus);
  assert.equal(X.suggest(D.p).filter(g => g.kind === "bus").length, 0);
  // A declined suggestion is not hinted.
  const E = design([{def: "conn", ref: "J1", nets: ["USB_DP", "USB_DM", "VBUS", "GND"]}]);
  X.decline(E.p, X.suggest(E.p).find(g => g.kind === "diff"));
  assert.equal(run(E, "nameSuggestion").length, 0);
});

// ---------------------------------------------------------------- registry, messages, incremental
test("the checks join the one check registry at the hint tier, schematic and layout", () => {
  const ids = AtriumChecks.checks({source: "insights"}).map(e => e.id);
  for (const id of ["pairSwap", "pairOrphan", "railConflict", "railPinMismatch", "capRating", "busGap", "isolationBridge", "nameSuggestion"]) assert.ok(ids.includes("schematic.hint." + id), id);
  assert.ok(ids.includes("layout.hint.isolationBridgeBoard"));
  assert.ok(AtriumChecks.checks({source: "insights"}).every(e => e.tiers.length === 1 && e.tiers[0] === "hint"));
});
test("every message names its basis (by its name, by their names, by the pin name)", () => {
  for (const c of I.checks().filter(c => ["pairSwap", "pairOrphan", "railConflict", "railPinMismatch", "capRating", "busGap", "isolationBridge", "isolationBridgeBoard", "nameSuggestion"].includes(c.id)))
    assert.ok(c.title && c.why && c.learnMore, c.id);
});
test("cost: 2000 nets on one sheet, all intent checks, under 400 ms cold", () => {
  const parts = [];
  for (let k = 0; k < 500; k++) parts.push({def: "phy", ref: "U" + k, nets: ["L" + k + "_P", "L" + k + "_N", "D" + k, k % 7 ? "3V3" : "GND"]});
  const D = design(parts);
  const t0 = Date.now(), r = I.analyze(D.p, D.sch, D.defs, {checks: ["pairSwap", "pairOrphan", "railConflict", "railPinMismatch", "capRating", "busGap", "isolationBridge", "nameSuggestion"]});
  const ms = Date.now() - t0;
  assert.ok(ms < 400, ms + " ms");
  assert.deepEqual(r.insights.map(x => x.message).sort(), ["500 net pairs named P/N (L0, L1 …) look like differential pairs (by their names).", "D0–D499 look like one bus of 500 nets (by their names)."], "one hint for a bank of pairs");
  console.log("intent insights: 2000 nets, " + r.insights.length + " hints, " + ms + " ms");
});
console.log("insights-intent: " + passed + " tests passed");
