"use strict";
// Net name intent (app/checks/net-intent.js): the golden corpus (tests/fixtures/net-intent/corpus.json), regression
// cases for the pair, rail, ground and voltage bugs covered by the
// AtriumRules.detectDiffPairs contract, ECO directive orientation, properties (partner round trip, case and
// separator stability), memoisation and determinism, and the cost of a cold read of 20k names.
// Run: scripts/test-jsc.sh net-intent   (or node tests/checks/net-intent.cjs)
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
require("../../app/checks/net-intent.js");
const N = globalThis.AtriumNetIntent;
const corpus = require("../fixtures/net-intent/corpus.json");
const now = () => globalThis.performance?.now?.() ?? Date.now();

// ---------------------------------------------------------------- golden corpus
let fields = 0;
for (const c of corpus.cases) {
  const r = N.read(c.name);
  for (const [k, want] of Object.entries(c)) {
    if (k === "name" || k === "why") continue;
    fields++;
    const got = r[k];
    if (want === null) assert.ok(got == null, c.name + ": " + k + " should be absent, got " + JSON.stringify(got));
    else assert.deepEqual(got, want, c.name + ": " + k + " " + JSON.stringify(got) + " ≠ " + JSON.stringify(want) + " (" + N.explain(c.name) + ")");
  }
  if (r.role !== "unknown") assert.ok(r.explain.length > 0, c.name + ": every reading explains itself");
}
assert.ok(corpus.cases.length >= 150 && fields >= 300, "the corpus stays substantial");

// ---------------------------------------------------------------- differential pairs
const pairsOf = (nets, existing, o) => N.pairs(nets, existing, o).map(p => [p.name, p.positive, p.negative]);
// AtriumRules.detectDiffPairs' own expectations (tests/checks/rules.cjs) hold unchanged.
const ruleNets = ["USB_DP", "USB_DN", "CLK+", "CLK-", "LVDS_P", "LVDS_N", "RXP", "RXN", "VDD", "SDA_P"];
assert.deepEqual(pairsOf(ruleNets), [["CLK", "CLK+", "CLK-"], ["LVDS", "LVDS_P", "LVDS_N"], ["RX", "RXP", "RXN"], ["USB", "USB_DP", "USB_DN"]]);
assert.deepEqual(N.pairs(ruleNets, [{name: "USB", positive: "USB_DP", negative: "USB_DN"}]).map(p => p.name), ["CLK", "LVDS", "RX"]);
// Pairs today's three suffix lists miss (rules.js, diffpair.js, eco.js) …
const must = [
  [["USB_DP", "USB_DM"], ["USB", "USB_DP", "USB_DM"]],
  [["USB1_D+", "USB1_D-"], ["USB1_D", "USB1_D+", "USB1_D-"]],
  [["CANH", "CANL"], ["CAN", "CANH", "CANL"]],
  [["CAN_H", "CAN_L"], ["CAN", "CAN_H", "CAN_L"]],
  [["CK_t", "CK_c"], ["CK", "CK_t", "CK_c"]],
  [["DQS3_t", "DQS3_c"], ["DQS3", "DQS3_t", "DQS3_c"]],
  [["TXP0", "TXN0"], ["TX0", "TXP0", "TXN0"]],
  [["TX_P0", "TX_N0"], ["TX_0", "TX_P0", "TX_N0"]],
  [["PCIE_TX0_P", "PCIE_TX0_N"], ["PCIE_TX0", "PCIE_TX0_P", "PCIE_TX0_N"]],
  [["PCIE_RX1_P_C", "PCIE_RX1_N_C"], ["PCIE_RX1_C", "PCIE_RX1_P_C", "PCIE_RX1_N_C"]],
  [["RX0+", "RX0-"], ["RX0", "RX0+", "RX0-"]],
  [["HDMI_D2+", "HDMI_D2-"], ["HDMI_D2", "HDMI_D2+", "HDMI_D2-"]],
  [["SATA_RXP", "SATA_RXN"], ["SATA_RX", "SATA_RXP", "SATA_RXN"]],
  [["DP_ML0_P", "DP_ML0_N"], ["DP_ML0", "DP_ML0_P", "DP_ML0_N"]],
  [["ADC_INP", "ADC_INM"], ["ADC_IN", "ADC_INP", "ADC_INM"]],
  [["SENSE_POS", "SENSE_NEG"], ["SENSE", "SENSE_POS", "SENSE_NEG"]],
  [["usb_dp", "usb_dm"], ["usb", "usb_dp", "usb_dm"]],
  [["RST_P", "RST_N"], ["RST", "RST_P", "RST_N"]], // _N is a pair negative once its _P exists
  [["/IO/USB_DP", "/IO/USB_DM"], ["USB", "/IO/USB_DP", "/IO/USB_DM"]]
];
for (const [nets, pair] of must) assert.deepEqual(pairsOf(nets), [pair], nets.join(" / ") + " is a pair");
// … and false pairs they make, or would make with a looser list.
const mustNot = [["CAP", "CAN"], ["STEP", "STEN"], ["UART_TX", "UART_RX"], ["TXD", "RXD"], ["SDA", "SCL"], ["MOSI", "MISO"], ["CTS", "RTS"], ["V+", "V-"],
  ["+12V", "-12V"], ["VCC+", "VCC-"], ["ENC_A", "ENC_B"], ["SPEED_H", "SPEED_L"], ["LED_H", "LED_L"], ["DM0", "DP0"], ["RST_N"], ["SDA_P"], ["CLK_P", "CLK_N2"],
  ["RS485_A", "RS485_B"], ["MOTOR_A", "MOTOR_B"], ["TEMP", "TEMN"]];
for (const nets of mustNot) assert.deepEqual(pairsOf(nets), [], nets.join(" / ") + " is not a pair");
// RS-485 A/B: only on request, and marked as of unknown polarity.
const ab = N.pairs(["RS485_A", "RS485_B"], [], {min: "weak"});
assert.deepEqual(ab.map(p => [p.positive, p.negative, p.known, p.level]), [["RS485_A", "RS485_B", false, "weak"]]);
// Ambiguity gives no pair: USB_DP with both USB_DM and USB_DN present.
assert.deepEqual(pairsOf(["USB_DP", "USB_DM", "USB_DN"]), []);
// Names stay unique, and existing pairs keep their nets and names.
assert.deepEqual(pairsOf(["/A/USB_DP", "/A/USB_DM", "/B/USB_DP", "/B/USB_DM"]).map(p => p[0]), ["USB", "USB_1"]);
assert.deepEqual(pairsOf(["CLK_P", "CLK_N"], [{name: "CLK", positive: "A", negative: "B"}]), [["CLK_1", "CLK_P", "CLK_N"]]);
// Deterministic: input order does not matter.
const big = ["USB_DP", "USB_DM", "CANH", "CANL", "TXP0", "TXN0", "CK_t", "CK_c", "GND", "3V3", "RX0+", "RX0-", "CAP", "CAN"];
assert.deepEqual(N.pairs([...big].reverse()), N.pairs(big));
for (const p of N.pairs(big)) assert.ok(p.explain.length >= 2 && p.level === "likely" && p.known, p.name + " explains itself");

// ---------------------------------------------------------------- ECO directive orientation
assert.deepEqual(N.orient(["USB_DM", "USB_DP"]), {positive: "USB_DP", negative: "USB_DM", pattern: "DP/DM", known: true}, "eco.js rejected USB_DP/USB_DM");
assert.deepEqual(N.orient(["CLK_N", "CLK_P"]), {positive: "CLK_P", negative: "CLK_N", pattern: "P/N", known: true});
assert.deepEqual(N.orient(["CANL", "CANH"]).positive, "CANH");
assert.deepEqual(N.orient(["SIGN", "SIGP"]), {positive: "SIGP", negative: "SIGN", pattern: "P/N", known: true}, "eco.js accepted a bare P/N directive; still does");
assert.deepEqual(N.orient(["A-", "A+"]).positive, "A+");
assert.equal(N.orient(["RS485_A", "RS485_B"]).known, false);
assert.equal(N.orient(["UART_TX", "UART_RX"]), null);
assert.equal(N.orient(["USB_DP"]), null);
assert.equal(N.orient(["USB_DP", "USB_DP"]), null);
assert.deepEqual(N.polarity("RST_N"), {polarity: -1, pattern: "P/N", stem: "RST", known: true}, "a control _N still offers its pair reading");
assert.equal(N.polarity("CAP"), null);

// ---------------------------------------------------------------- rails, grounds and voltages (old regex bugs)
for (const n of ["VCC_EN", "VDD_PG", "3V3_PG", "VBUS_DET", "VIN_SENSE", "+IN", "VINP", "VIN_N", "24V_RTN", "VCC_EN"]) assert.equal(N.isRail(n), false, n + " is not a rail");
for (const n of ["3V3", "+5V", "VCC", "VDD_1V8", "VBUS", "VCC_IO", "1V8_A", "-12V", "VDDA"]) assert.equal(N.isRail(n), true, n + " is a rail");
for (const n of ["GND", "AGND", "DGND", "PGND", "GND_ISO", "ISO_GND", "VSS", "24V_RTN", "EARTH", "0V"]) { assert.equal(N.isGround(n), true, n + " is a ground"); assert.equal(N.isSupply(n), true); }
for (const n of ["CLK", "USB_DP", "VCC_EN", "nRST"]) assert.equal(N.isSupply(n), false, n + " is not a supply net");
// pdn.voltageOf's own expectations (tests/analysis/pdn.cjs) hold; its misreadings do not.
assert.equal(N.voltage("+3V3"), 3.3); assert.equal(N.voltage("1V8"), 1.8); assert.equal(N.voltage("VCC_5V"), 5); assert.equal(N.voltage("12V"), 12);
assert.equal(N.voltage("3,3V"), 3.3); assert.equal(N.voltage("LDO2VIN"), null); assert.equal(N.voltage("VDD_CORE_2"), null); assert.equal(N.voltage("12V_EN"), null);
assert.equal(N.voltage("VCC_3.3"), 3.3); assert.equal(N.voltage("GND"), null); assert.equal(N.voltage(""), null); assert.equal(N.voltage(null), null);
assert.equal(N.isClock("CLK_25M"), true); assert.equal(N.isClock("CLK_P"), true); assert.equal(N.isClock("SDA"), false);
assert.equal(N.isHighSpeed("PCIE_TX0_P"), true); assert.equal(N.isHighSpeed("I2C_SCL"), false); assert.equal(N.isHighSpeed("CANH"), false); assert.equal(N.isHighSpeed("3V3"), false);

// ---------------------------------------------------------------- properties
for (const c of corpus.cases) {
  const r = N.read(c.name);
  if (r.role !== "pairMember" || !r.known) continue;
  for (const q of r.partners) {
    const o = N.read(q);
    assert.equal(o.role === "pairMember" ? o.polarity : o.alt?.polarity, -r.polarity, c.name + " → " + q + " flips polarity");
    assert.ok((o.role === "pairMember" ? o : o.alt).partners.includes(c.name), q + " leads back to " + c.name);
  }
}
for (const [a, b] of [["3V3", "3v3"], ["VCC_3V3", "vcc_3v3"], ["VCC_3V3", "VCC-3V3"], ["VCC_3V3", "VCC.3V3"], ["VDD_1V8_A", "vdd-1v8-a"], ["+5V", "+5v"]])
  assert.equal(N.voltage(a), N.voltage(b), a + " and " + b + " read the same voltage");
for (const [a, b] of [["GND", "gnd"], ["AGND", "agnd"], ["USB_DP", "usb_dp"], ["VCC_EN", "vcc_en"]]) assert.equal(N.read(a).role, N.read(b).role, a + " / " + b);

// ---------------------------------------------------------------- memoised, frozen, explained
const r1 = N.read("USB_DP");
assert.equal(N.read("USB_DP"), r1, "memoised by string");
assert.ok(Object.isFrozen(r1) && Object.isFrozen(r1.explain) && Object.isFrozen(r1.partners));
assert.throws(() => { "use strict"; r1.role = "rail"; });
assert.match(N.explain("3V3_PG"), /railSignal \(likely\).*PG/);
assert.match(N.explain("USB_DP"), /pairMember \(weak\).*protocol USB.*positive/);
assert.match(N.explain("RST_N"), /active low/);
assert.equal(N.read(42).name, "42");

// ---------------------------------------------------------------- size and cost
const src = fs.readFileSync(path.join(__dirname, "../../app/checks/net-intent.js"), "utf8"), bytes = unescape(encodeURIComponent(src)).length;
assert.ok(bytes <= 17000, "app/checks/net-intent.js is " + bytes + " bytes (target 14 KB, guard 17 KB)");
const stems = ["USB", "PCIE_TX", "DDR_DQ", "VCC", "GND", "CLK", "SPI1_CS", "I2C2_SDA", "ADC_IN", "LED", "MOTOR", "3V3", "nRST", "CAN"], suffixes = ["", "_P", "_N", "+", "-", "_EN", "_PG", "_t", "_c", "#"];
const names = [];
for (let i = 0; names.length < 20000; i++) names.push(stems[i % stems.length] + "_" + Math.floor(i / 140) + suffixes[Math.floor(i / stems.length) % suffixes.length]);
const t0 = now();
for (const n of names) N.read(n);
const cold = now() - t0, t1 = now();
for (const n of names) N.read(n);
const warm = now() - t1, t2 = now();
const found = N.pairs(names).length, tp = now() - t2;
assert.ok(cold < 1500, "20k cold reads took " + cold.toFixed(0) + " ms");
assert.ok(found > 0 && tp < 1500, "pairs over 20k names took " + tp.toFixed(0) + " ms");
console.log("net-intent: " + corpus.cases.length + " corpus cases, " + fields + " fields; " + bytes + " bytes; 20k names cold " + cold.toFixed(1) + " ms, warm " + warm.toFixed(1) + " ms, pairs " + tp.toFixed(1) + " ms (" + found + ")");
