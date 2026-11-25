"use strict";
// Exercise the same lexer, evaluator, unit propagation and formatter as a notebook block.
// Independent standard/table checkpoints are linked in docs/calculation-helpers.md.
const assert = require("node:assert/strict");
require("../../app/notebook/calculation-intent.js");
require("../../app/notebook/calculation-core.js");
require("../../app/analysis/calculators.js");
require("../../app/notebook/calculation-helpers.js");
const E = globalThis.AtriumCalculationCore, H = globalThis.AtriumCalculationHelpers;
let checks = 0;
function evaluate(text, options) {
  const r = E.evaluate(text, options);
  assert.equal(r.ok, true, text + ": " + JSON.stringify(r.diagnostic));
  checks++;
  return r;
}
function close(actual, expected, label, relative = 2e-12) {
  assert.ok(Math.abs(actual - expected) <= Math.max(1e-22, relative * Math.abs(expected)), label + ": " + actual + " vs " + expected);
  checks++;
}
function display(text, expected) { assert.equal(evaluate(text).display, expected, text); }
function fails(text, pattern) {
  const r = E.evaluate(text);
  assert.equal(r.ok, false, text);
  assert.match(r.diagnostic.message, pattern, text);
  assert.ok(r.diagnostic.span[1] > r.diagnostic.span[0] && r.diagnostic.span[1] <= text.length, text);
  checks++;
}

display("3.3k in E24", "3.3 k");
display("nearest E96 3.31k", "3.32 k");
display("nearest E96 3.31kΩ", "3.32 kΩ");
display("3.31 nF in E96", "3.32 nF");
display("(50 mil in mil) in E24", "51 mil");
close(E.as(evaluate("50 mil in E24"), "mil"), 51, "snap in authored length unit");
close(evaluate("nearest E96 3.31k").metadata.signedRelativeError, 0.0030211480362537764, "signed E96 error");
assert.deepEqual(evaluate("nearest E96 3.31k").dimensions, [0, 0, 0, 0, 0, 0, 0]);
assert.equal(evaluate("3.3E24").value, 3.3e24);
fails("3.3k E24", /unexpected|keyword|operator/i);
fails('nearest(3.3k,"E24")', /use nearest/i);
fails("nearest E24 0", /positive|above zero/i);
fails("nearest E24 (3 dBm)", /linear/i);

// Independent IEC checkpoints include E192's published exception and each decade boundary.
for (const [series, requested, nominal, last] of [
  ["E3", 2.3, 2.2, 4.7], ["E6", 4.9, 4.7, 6.8], ["E12", 3.92, 3.9, 8.2], ["E24", 7.46, 7.5, 9.1],
  ["E48", 4.88, 4.87, 9.53], ["E96", 3.31, 3.32, 9.76], ["E192", 9.19, 9.20, 9.88]
]) {
  const nominalAt = x => evaluate("nearest " + series + " " + x).value;
  assert.equal(nominalAt(requested), nominal, series);
  const tie = Math.sqrt(last * 10);
  assert.equal(nominalAt(tie), last, series + " tie");
  assert.equal(nominalAt(tie * (1 - 1e-10)), last, series + " below tie");
  assert.equal(nominalAt(tie * (1 + 1e-10)), 10, series + " above tie");
  assert.equal(nominalAt(9.999e-15), 1e-14, series + " scaled rollover");
}
const stable = evaluate("nearest E24 (3.3kΩ ± 1%)");
assert.deepEqual(stable.worst, {min: 3300, max: 3300});
assert.equal(stable.rss, 0);
const crossing = evaluate("nearest E6 (8.25 ± 0.2)");
assert.ok(crossing.worst.min <= 6.8 && crossing.worst.max >= 10);
assert.equal(crossing.rss, null);
assert.match(crossing.rssReason, /step/);

// Published marking examples and the rarely used pink, orange, yellow and grey roles.
for (const [text, resistance, tol, digits, mult, tcr] of [
  ["green blue red", 5600, 20, 2, 100],
  ["yellow violet red gold", 4700, 5, 2, 100],
  ["yellow violet black brown brown", 4700, 1, 3, 10],
  ["red violet black orange silver", 270000, 10, 3, 1000],
  ["blue grey black green gold black", 68e6, 5, 3, 1e5, 250],
  ["red white pink orange", 0.029, 0.05, 2, 0.001],
  ["brown black silver yellow", 0.1, 0.02, 2, 0.01],
  ["brown black black pink grey grey", 0.1, 0.01, 3, 0.001, 1]
]) {
  const q = evaluate('bands("' + text + '")'), f = q.fields;
  close(f.resistance.value, resistance, text);
  close(E.as(f.tolerance, "%"), tol, text + " tolerance");
  assert.equal(f.digitCount.value, digits); assert.equal(f.multiplier.value, mult);
  const terms = text.split(" ");
  assert.deepEqual(q.metadata.bands.map(b => b.name), terms);
  assert.ok(q.metadata.bands.every(b => /^#[0-9a-f]{6}$/.test(b.swatch)));
  if (tcr != null) close(E.as(f.tcr, "ppm/K"), tcr, text + " TCR");
  const encoded = evaluate("resistorBands(" + resistance + " Ω," + tol + "%," + terms.length + (tcr == null ? "" : "," + tcr + " ppm/K") + ")");
  assert.deepEqual(encoded.metadata.bands.map(b => b.name), terms);
}
display('bands("gold red violet yellow","auto").resistance', "4.7 kΩ");
display('bands("brown brown black violet yellow","reverse").resistance', "4.7 kΩ");
fails('bands("yellow violet black brown brown","auto")', /both band orders/i);
fails('bands("black violet red gold")', /cannot represent/i);
fails('bands("purple black black")', /unknown band/i);
fails("resistorBands(4.71kΩ, 5%, 4)", /without rounding/i);
fails("resistorBands(4.7k, 5%, 4)", /resistance.*Ω/i);
fails("resistorBands(4.7kΩ, 1%, 6)", /temperature coefficient/i);
fails("resistorBands(4.7kΩ, 5%, 3)", /20%/);
fails("resistorBands(4.7kΩ, 3%, 4)", /tolerance/i);
fails("resistorBands(4.7kΩ, 1%, 6, 77 ppm/K)", /temperature coefficient/i);

// Formula-derived diameters, compared to the definition anchors and high-precision vectors.
// The rounded tabular diameters should not feed the area calculation.
for (const [gauge, mm, mm2] of [
  ['"0000"', 11.684, 107.21930257703052], ['"000"', 10.404902483053985, 85.028772574277663],
  ['"00"', 9.265833249046815, 67.43088223591081], ['"0"', 8.251462802171463, 53.47512073211764],
  ["24", 0.51055922706257235, 0.20473030814712210], ["36", 0.127, 0.012667686977437444],
  ["56", 0.012494907352710485, 0.00012261848950449657]
]) {
  const g = evaluate("awg(" + gauge + ")"), f = g.fields;
  close(E.as(f.diameter, "mm"), mm, "diameter " + gauge);
  close(E.as(f.area, "mm²"), mm2, "area " + gauge);
  assert.equal(evaluate("nearestAWG(" + mm + " mm)").fields.gauge.value, f.gauge.value);
  assert.equal(evaluate("nearestAWG(" + mm2 + " mm²)").fields.gauge.value, f.gauge.value);
}
display("awg(24).diameter", "0.5106 mm");
display("awg(24).area", "0.2047 mm²");
close(evaluate("nearestAWG(0.5 mm)").metadata.signedRelativeError, 0.0211184541251447, "signed diameter error");
close(evaluate("nearestAWG(0.2 mm²)").metadata.signedRelativeError, 0.023651540735610495, "signed area error");
const gauges = evaluate("nearestAWG(0.51 mm ± 15%)").fields.gauge;
assert.ok(gauges.worst.min <= 23 && gauges.worst.max >= 25);
assert.equal(gauges.rss, null);
fails("awg(57)", /whole gauge/i); fails("awg(2.5)", /whole gauge/i);
fails("nearestAWG(2 Ω)", /diameter|area/i); fails("nearestAWG(0 mm)", /above zero/i);

for (const [text, expected] of [
  ["dbPower(2)", 3.010299956639812], ["dbVoltage(2 V, 1 V)", 6.020599913279624],
  ["powerRatio(20 dB)", 100], ["voltageRatio(20 dB)", 10],
  ["dbm(1 mW)", 0], ["watts(0 dBm)", 0.001], ["watts(-30 dBm)", 0.000001],
  ["dbm(1 V, 50 Ω)", 13.010299956639812], ["vrms(0 dBm, 50 Ω)", 0.22360679774997897],
  ["dbv(1 V)", 0], ["vrms(-20 dBV)", 0.1], ["vrms(6 dB, 2 V)", 3.990524629937759],
  ["watts(10 dB, 2 W)", 20], ['vpeak(1 V, "triangle")', 1.7320508075688773],
  ['vpp(1 V, "sine")', 2.8284271247461901], ["vpeak(1 V, 2.5)", 2.5]
]) close(evaluate(text).value, expected, text);
display("dbVoltage(2)", "6.021 dB"); display("dbm(1 V, 50 Ω)", "13.01 dBm");
display("0 dBm in mW", "1 mW"); display("1 mW in dBm", "0 dBm");
display("0 dBV in V", "1 V"); display("2 V in dBV", "6.021 dBV");
fails("6 dB in V", /reference/i); fails("0 dBm in V", /impedance/i);
fails("1 V in dBm", /impedance/i); fails("0 dBV in W", /impedance/i);
fails("0 dBm in dBV", /impedance/i);
assert.equal(evaluate("vrms(0 dBm, 50 Ω)").metadata.impedanceOhms, 50);
assert.equal(evaluate("vrms(0 dBm, 50 Ω)").metadata.voltage, "RMS");
fails("vrms(0 dBm)", /impedance/i); fails("dbm(1 V)", /impedance/i);
fails("vrms(6 dB)", /reference/i); fails("watts(1 dBV)", /dB/i);
fails("dbPower(-1)", /above zero/i); fails("dbVoltage(2 W, 1 W)", /requires V/i);
fails("vrms(0 dBm, -50 Ω)", /above zero/i); fails("vpp(1 V)", /waveform|crest/i);
fails("voltageRatio(20 dBm)", /dB/i); fails("vpeak(1 V, 0.5)", /at least one/i);

display("period(100 MHz)", "10 ns"); display("frequency(10 ns)", "100 MHz");
display("wavelength(100 MHz,c)", "2.998 m");
const vacuum = evaluate("wavelength(100 MHz, c)");
close(vacuum.value, 2.99792458, "vacuum wavelength"); assert.equal(vacuum.metadata.medium, "vacuum");
const medium = evaluate("wavelength(100 MHz, 200000000 metre/s)");
assert.equal(medium.value, 2); assert.equal(medium.metadata.speedMetresPerSecond, 200000000);
fails("wavelength(100 MHz)", /propagation speed/i); fails("wavelength(100 MHz, 2)", /metre\/s/i);
fails("period(100M)", /requires Hz/i); fails("frequency(-10 ns)", /above zero/i);
display("corner(10 kΩ, 1 nF)", "15.92 kHz"); display("divider(5 V, 1 kΩ, 2 kΩ)", "3.333 V");
fails("corner(10k, 1n)", /requires Ω/i);
close(evaluate("corner(1e308 Ω, 1e-308 F)").value, 0.15915494309189534, "RC with finite cancelling scales");
const rc = evaluate("corner((10 kΩ ± 1%), (1 nF ± 5%))");
close(rc.worst.min, 15007.538245346095, "RC worst-case minimum");
close(rc.worst.max, 16922.375661020238, "RC worst-case maximum");
close(rc.rss, 811.5341605103235, "RC independent RSS");
const bindings = {
  R5: {raw: "4k7", unit: "Ω", label: "R5", sourceId: "part/r5", tolerance: null},
  R6: {raw: "1k", unit: "Ω", label: "R6", sourceId: "part/r6", tolerance: {relative: .01}},
  Vin: {raw: "2", unit: "V", label: "Vin", sourceId: "net/in", tolerance: {relative: .01}}
};
const marking = evaluate("resistorBands(R5, 5%, 4)", {bindings});
assert.ok(marking.warnings.includes("tolerance unknown: R5"));
assert.equal(evaluate("resistorBands(R6, 1%, 5).resistance", {bindings}).value, 1000);
fails("awg(0 V)", /dimensionless/i);
assert.ok(evaluate("resistorBands(R5, 5%, 4).resistance", {bindings}).warnings.includes("tolerance unknown: R5"));
const shared = evaluate("dbVoltage(Vin, Vin)", {bindings});
assert.deepEqual(shared.worst, {min: 0, max: 0}); assert.equal(shared.rss, 0);
const sharedDivider = evaluate("divider(5 V, R6, R6)", {bindings});
assert.equal(sharedDivider.rss, 0); assert.ok(sharedDivider.warnings.some(w => w.includes("conservative")));
assert.ok(H.catalogue.every(s => s.name && s.args.length && s.domain && s.result && s.tolerance && s.minArgs > 0 && s.minArgs <= s.maxArgs));
assert.deepEqual(H.catalogue.filter(s => s.minArgs < s.maxArgs).map(s => s.name), ["bands", "resistorBands", "dbPower", "dbVoltage", "dbm", "watts", "vrms"]);
assert.ok(H.names.includes("nearest") && H.names.includes("resistorBands"));
console.log("engineering helper catalogue: " + checks + " numerical, domain and display checks");
