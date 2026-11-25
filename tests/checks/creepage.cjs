"use strict";
// Creepage and clearance by voltage (app/checks/creepage.js): the encoded tables and
// their lookups, the working voltage per net with its basis, the layout hint (names, power ports, connectors;
// a false-positive set where it must stay quiet), the Creepage Distance rule in DRC (confirmed voltages only,
// the unified violation shape, the MCP check tool), slots and poured copper, the isolation barrier rating
// (schematic hint and board use), and the incremental pass: an edit near a high-voltage net re-checks only
// the pairs it can touch.
// Run: node tests/checks/creepage.cjs   (or scripts/test-jsc.sh creepage)
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "connectivity", "pcb-appearance", "sch-objects", "hierarchy", "erc", "net-intent", "altium-rules", "query", "signals", "rules", "project-rules", "pcb-pours",
  "stackup", "board-shape", "viastack", "polygon-pour", "net-intent-index", "insights", "insights-sch", "insights-pcb", "insights-intent", "checks", "drc-pours", "creepage", "messages"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, K = AtriumCreepage, I = AtriumInsights, R = AtriumRules, PR = AtriumProjectRules, T = K.tables;
const now = () => globalThis.performance?.now?.() ?? Date.now();
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const near = (a, b, m = "") => assert.ok(Math.abs(a - b) < 1e-9, m + ": " + a + " ≠ " + b);

// ---------------------------------------------------------------- fixtures
let uid = 0;
const id = p => (p || "i") + (++uid);
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const track = (net, points, extra = {}) => ({id: id("t"), kind: "track", net, layer: "Top", width: .3, points, ...extra});
const sym = (id, pins, prefix = "U", extra = {}) => ({id, name: id, prefix, symbol: {pins: pins.map((n, i) => ({number: String(i + 1), name: n, x: 0, y: -i * 2.54})), shapes: []}, ...extra});
const fp = pads => ({shapes: [], pads: pads.map(([n, x, y]) => ({number: n, x, y, w: 1.5, h: 1.5, drill: .8, shape: "round"}))});
const LIB = [sym("inlet", ["L", "N", "PE"], "J", {footprint: fp([["1", 0, 0], ["2", 5, 0], ["3", 10, 0]])}), sym("term", ["1", "2"], "J", {value: "AC inlet IEC 60320 C14", footprint: fp([["1", 0, 0], ["2", 5, 0]])}),
  sym("iso", ["VCC1", "GND1", "VCC2", "GND2"], "U", {footprint: fp([["1", 0, 0], ["2", 0, 2.54], ["3", 7.62, 0], ["4", 7.62, 2.54]])}), sym("two", ["1", "2"], "R", {footprint: fp([["1", 0, 0], ["2", 2, 0]])}),
  sym("reg", ["VIN", "OUT", "GND"], "U", {category: "Linear voltage regulator", parameters: {Vout: "48 V"}})];
const DEFS = new Map(LIB.map(d => [d.id, d]));
// A project whose board holds the items; a schematic only when parts are placed on it.
function project(items, o = {}) {
  const p = A.project("Creepage", LIB), sch = p.documents[0], pcb = p.documents[1];
  pcb.outline = rect(0, 0, 80, 60);
  pcb.items.push(...items);
  for (const [k, x] of (o.parts || []).entries()) {
    const part = {id: id("p"), kind: "part", def: x.def, ref: x.ref, value: x.value ?? "", x: k * 30, y: 0, angle: 0, pinNets: {}, ...(x.parameters ? {parameters: x.parameters} : {})};
    sch.items.push(part);
    A.pins(part, DEFS.get(x.def), "schematic").forEach((pin, i) => { const n = x.nets[i]; if (n) sch.items.push({id: id("l"), kind: (o.power || []).includes(n) ? "power" : "netlabel", text: n, x: pin.at[0], y: pin.at[1]}); });
  }
  if (o.signals) p.signals = o.signals;
  AtriumSignals.attach(p);
  return {p, sch, pcb};
}
const hints = (D, o = {}) => I.analyze(D.p, D.pcb, DEFS, {checks: ["creepage"], ...o}).insights.filter(x => x.check === "creepage");
const sheetHints = (D, check) => I.analyze(D.p, D.sch, DEFS, {checks: [check]}).insights.filter(x => x.check === check);
const withRule = (D, props = {}) => {
  PR.edit(D.p, b => { b.list.push({id: "creep-1", type: "creepage", name: "Creepage", comment: "", enabled: true, priority: 1, scope: {kind: "all"}, scope2: {kind: "all"}, ...R.types.creepage.fields.reduce((o, f) => (o[f.key] = f.def, o), {}), ...props}); });
  return D;
};
const drc = D => R.drc(D.pcb, DEFS, R.stored(D.pcb, D.p), {project: D.p}).violations.filter(v => v.type === "creepage");
const tagStore = (tags, nets) => ({version: 1, signals: [], tags, nets: Object.fromEntries(Object.entries(nets).map(([n, t]) => [n, {tags: [].concat(t)}]))});

// ---------------------------------------------------------------- tables
test("tables: IEC 60664-1 F.5 / IEC 62368-1 Table 17 creepage, step-up between rows, PWB columns only under 60664-1, reinforced doubles", () => {
  for (const [k, v] of Object.entries(T.CREEP)) assert.equal(v.length, T.CREEP_V.length, k + " has a value per row");
  for (const [k, v] of Object.entries(T.CREEP)) for (let i = 1; i < v.length; i++) assert.ok(v[i] >= v[i - 1], k + " never falls with the voltage");
  near(T.creepageBasic("iec62368", 2, "IIIb", 250), 2.5, "250 V PD2 IIIb");
  near(T.creepageBasic("iec62368", 2, "IIIb", 230), 2.5, "230 V steps up to the 250 V row");
  near(T.creepageBasic("iec60664", 2, "IIIb", 230), 1, "printed wiring material, PD2");
  near(T.creepageBasic("iec60664", 1, "IIIb", 400), 1, "printed wiring material, PD1");
  near(T.creepageBasic("iec60664", 3, "I", 400), 5, "PD3 has no printed-wiring column");
  near(T.creepageBasic("iec62368", 2, "I", 50), .6, "50 V is its own row");
  near(T.creepageBasic("iec62368", 2, "I", 50.1), .63, "just above a row: the next one");
  near(T.creepageBasic("iec62368", 2, "II", 48), .85, "48 V group II");
  near(T.creepageBasic("iec62368", 2, "IIIa", 5), .4, "below 10 V: the 10 V row");
  near(T.creepageBasic("iec62368", 2, "I", 2000), 10, "above the table: in proportion");
  near(T.creepageBasic("iec62368", 3, "IIIb", 32), 1.3, "PD3 low voltage");
  const q = K.required({}, {rms: 250, peak: 354, mains: true, insulation: "reinforced", surface: "outer"});
  near(q.creepage, 5, "reinforced creepage, 250 V mains"); near(q.clearance, 3, "reinforced clearance, 2.5 kV transient");
  const b = K.required({standard: "iec60664"}, {rms: 230, peak: 325, mains: true, insulation: "basic", surface: "outer"});
  near(b.clearance, 1.5); near(b.creepage, 1.5, "creepage is never below the clearance");
});
test("tables: F.1 transients by overvoltage category, F.2 clearances, the reinforced step, inner layers", () => {
  assert.equal(T.transientOf("II", 230), 2500); assert.equal(T.transientOf("III", 230), 4000); assert.equal(T.transientOf("I", 48), 330); assert.equal(T.transientOf("IV", 120), 4000);
  near(T.clearanceFor(2, 2500), 1.5); near(T.clearanceFor(1, 330), .01); near(T.clearanceFor(3, 800), .8); near(T.clearanceFor(2, 1200), .25); near(T.clearanceFor(2, 4000), 3);
  assert.equal(T.nextStep(2500), 4000); assert.equal(T.nextStep(1500), 2500); near(T.nextStep(2000), 3200, "off the series: 160 %");
  const iec = K.required({standard: "iec60664"}, {rms: 230, peak: 325, mains: true, insulation: "reinforced", surface: "outer"});
  near(iec.clearance, 3, "60664-1 reinforced: the next impulse step (4 kV)"); near(iec.creepage, 3, "PWB PD2 250 V reinforced = 2 mm, raised to the clearance");
  const ovc3 = K.required({overvoltage: "III"}, {rms: 230, peak: 325, mains: true, insulation: "basic", surface: "outer"});
  near(ovc3.clearance, 3, "OVC III: 4 kV");
  const inner = K.required({}, {rms: 400, peak: 400, mains: false, insulation: "functional", surface: "inner"});
  near(inner.clearance, 0, "no air inside the board"); near(inner.creepage, 1, "inner layers at pollution degree 1");
  const dc = K.required({}, {rms: 48, peak: 48, mains: false, insulation: "functional", surface: "outer"});
  near(dc.clearance, .2, "a DC circuit: the smallest impulse row"); near(dc.creepage, 1.2, "48 V, PD2, IIIb");
});
test("tables: IPC-2221B Table 6-1 by column and peak voltage, above 500 V, internal layers B1", () => {
  for (const [k, v] of Object.entries(T.IPC)) assert.equal(v.length, T.IPC_V.length, k);
  near(T.ipcSpacing("B2", 48), .6); near(T.ipcSpacing("B2", 15), .1); near(T.ipcSpacing("B2", 16), .1); near(T.ipcSpacing("B2", 31), .6);
  near(T.ipcSpacing("B2", 400), 2.5); near(T.ipcSpacing("B3", 230), 6.4); near(T.ipcSpacing("B1", 400), .25); near(T.ipcSpacing("B4", 120), .4); near(T.ipcSpacing("A5", 12), .13);
  near(T.ipcSpacing("B2", 600), 3, "500 V value + 0.005 mm/V over 500"); near(T.ipcSpacing("B1", 600), .5);
  const q = K.required({standard: "ipc2221b"}, {rms: 230, peak: 325, mains: true, insulation: "reinforced", surface: "outer"});
  near(q.creepage, 2.5); near(q.clearance, 2.5);
  near(K.required({standard: "ipc2221b"}, {rms: 230, peak: 325, mains: true, insulation: "basic", surface: "inner"}).creepage, .25, "internal: B1");
  assert.ok(T.UNCERTAIN.length >= 3, "the uncertain readings are listed");
});

// ---------------------------------------------------------------- voltages
test("voltages: name, power port, mains connector pins and inlet, tag parameter and name, confirmed signal; each with its basis", () => {
  const D = project([], {parts: [{def: "inlet", ref: "J1", nets: ["LIVE", "NEUT", "EARTH1"]}, {def: "term", ref: "J2", nets: ["ACA", "ACB"], value: "AC inlet IEC 60320 C14"}, {def: "two", ref: "R1", nets: ["+48V", "GND"]}],
    power: ["GND"], signals: {version: 1, tags: [{name: "HV", params: {Voltage: "400 V"}}, {name: "230VAC"}], nets: {DCLINK: {tags: ["HV"]}, PRI: {tags: ["230VAC"]}},
      signals: [{id: "s1", name: "BUS12", kind: "single", legs: [{nets: ["BUS12"]}], span: false, intent: {role: "rail", voltage: 12, source: "name", confirmed: "2026-11-20"}}]}});
  const V = K.voltages(D.p, D.pcb);
  const v = n => V.of(n);
  assert.deepEqual([v("+48V").dc, v("+48V").level, v("+48V").basis], [48, "likely", "by its name"]);
  assert.deepEqual([v("GND").dc, v("GND").ground, v("GND").level, v("GND").basis], [0, true, "strong", "by its power port"]);
  assert.ok(v("LIVE").mains && v("NEUT").mains, "L and N pins of a connector");
  assert.equal(v("LIVE").basis, "by pin L on J1");
  assert.ok(v("EARTH1").earth && v("EARTH1").ground, "its PE pin is earth");
  assert.ok(v("ACA").mains && v("ACB").mains && v("ACA").basis === "by connector J2", "an AC inlet by its value");
  assert.deepEqual([v("DCLINK").dc, v("DCLINK").level, v("DCLINK").basis], [400, "user", "by tag HV"]);
  assert.deepEqual([v("PRI").mains, v("PRI").ac, v("PRI").level], [true, 230, "user"], "a tag named as a voltage");
  assert.deepEqual([v("BUS12").dc, v("BUS12").level, v("BUS12").basis], [12, "user", "by signal BUS12"]);
  assert.equal(v("SDA"), null, "a signal net has no voltage");
  assert.equal(v("VCC"), null, "a rail without a voltage in its name has none");
  assert.deepEqual(K.parseVolts("1.5 kV"), {dc: 1500}); assert.deepEqual(K.parseVolts("230VAC"), {ac: 230, mains: true}); assert.deepEqual(K.parseVolts("24 VAC"), {ac: 24, mains: false});
});

// ---------------------------------------------------------------- the hint
test("hint: a 400 V rail 1 mm from ground; the message names the standard, the insulation and the basis", () => {
  const D = project([track("+400V", [[5, 10], [40, 10]]), track("GND", [[5, 11.3], [40, 11.3]])]);
  const [x, ...rest] = hints(D);
  assert.equal(rest.length, 0);
  assert.equal(x.severity, "tip");
  assert.equal(x.message, "+400V and GND are 1 mm apart (creepage along the surface); IEC 62368-1 asks 4 mm for 400 V (functional insulation, basic values; Table 17 and Table 14, pollution degree 2, material group IIIb). +400V: 400 V by its name; GND: 0 V by its name.");
  assert.ok(x.why && x.title && x.key.startsWith("creepage:") && x.line?.length === 2);
  assert.equal(x.value, 1);
  // Mains: the L pin of the inlet, 2 mm from the secondary ground: reinforced, advice.
  const M = project([track("LIVE", [[5, 30], [40, 30]]), track("GND", [[5, 32.3], [40, 32.3]])], {parts: [{def: "inlet", ref: "J1", nets: ["LIVE", "NEUT", "PE"]}]});
  const [m] = hints(M);
  assert.equal(m.severity, "advice");
  assert.match(m.message, /LIVE and GND are 2 mm apart \(creepage along the surface\); IEC 62368-1 asks 5 mm for 250 V \(reinforced insulation; .*overvoltage category II\)\. LIVE: mains by pin L on J1; GND: 0 V by its name\./);
  // The rule's standard: IPC-2221B B2 asks 2.5 mm for 400 V (1 mm is too close; 3 mm is fine).
  const P = withRule(project([track("+400V", [[5, 10], [40, 10]]), track("GND", [[5, 11.3], [40, 11.3]])]), {standard: "ipc2221b"});
  assert.match(hints(P)[0].message, /IPC-2221B asks 2\.5 mm for 400 V/);
});
test("regulator output drives creepage with its basis, user voltage takes precedence and unknown nets stay unknown", () => {
  const trace = (n, y) => track(n, [[5, y], [40, y]]);
  const items = () => [trace("BIAS", 10), trace("GND", 11.3), trace("SENSE", 10.6)];
  const reg = {def: "reg", ref: "U1", nets: ["SUPPLY", "BIAS", "GND"]};
  const D = withRule(project(items(), {parts: [reg]}), {unknown: "skip"});
  const [x, ...extra] = hints(D);
  assert.equal(extra.length, 0, "only BIAS to GND");
  assert.match(x.message, /for 48 V.*BIAS: 48 V from Vout on U1; GND: 0 V by its name/);
  assert.equal(K.voltages(D.p, D.pcb).of("SENSE"), null);
  assert.equal(drc(D).length, 0, "regulator evidence stays at hint tier");
  const M = project(items(), {parts: [reg], signals: tagStore([{name: "Known supply", params: {Voltage: "12 V"}}], {BIAS: "Known supply"})});
  assert.equal(K.voltages(M.p, M.pcb).of("BIAS").dc, 12);
  assert.equal(hints(M).length, 0);
  const N = project([trace("12V", 10), trace("GND", 11.3)], {parts: [{...reg, nets: ["SUPPLY", "12V", "GND"]}]});
  assert.equal(K.voltages(N.p, N.pcb).of("12V"), null, "conflicting output and rail name do not become a voltage estimate");
  const B = project(items());
  const another = {...B.pcb, id: "other-board", items: [{id: "remote-reg", kind: "part", ref: "U3", def: "reg", x: 20, y: 20, pinNets: {"1": "VIN", "2": "BIAS", "3": "GND"}}]};
  B.p.documents.push(another);
  assert.equal(K.voltages(B.p, another).of("BIAS").dc, 48);
  assert.equal(K.voltages(B.p, B.pcb).of("BIAS"), null, "a board-only regulator provides evidence for its own PCB");
});
test("48 V creepage groups only the same canonical net pair and expansion preserves individual locations", () => {
  const strip = (net, y) => track(net, [[5, y], [40, y]]);
  const D = project([strip("+48V", 10), strip("GND", 11.3), strip("5V", 8.7), strip("+48V", 30), strip("5V", 31.3), strip("GND", 28.7),
    strip("+48V", 45), strip("SENSE", 46.3)]);
  const raw = hints(D);
  // Both pair names and every distinct set of copper objects survive the normal Insights engine and the check adapter.
  const rows = raw.map((x, i) => ({no: i + 1, documentId: D.pcb.id, objectId: x.objects[0], text: x.message, problem: AtriumChecks.fromInsight(x)}));
  assert.equal(raw.length, 4);
  const M = AtriumMessages, collapsed = M.groupNetPairs(rows, new Set());
  assert.equal(collapsed.length, 2);
  assert.deepEqual(collapsed.map(r => r.text).sort(), ["+48V ↔ 5V", "+48V ↔ GND"]);
  assert.ok(collapsed.every(r => r.netGroup.count === 2));
  const expanded = M.groupNetPairs(rows, new Set(collapsed.map(r => r.netGroup.key)));
  assert.equal(expanded.length, 6);
  assert.deepEqual(expanded.filter(r => r.netGroupChild).map(r => r.problem).sort((a, b) => a.key.localeCompare(b.key)),
    rows.map(r => r.problem).sort((a, b) => a.key.localeCompare(b.key)));
  assert.ok(expanded.filter(r => r.netGroupChild).every(r => r.problem.objects.length === 2));
  const reverse = {...rows[0], no: 99, problem: {source: "insights", check: rows[0].problem.check, raw: {netPair: raw[0].netPair.slice().reverse()}}};
  assert.equal(M.groupNetPairs([rows[0], reverse], new Set()).length, 1, "producer order is irrelevant");
  const differentPCB = {...reverse, documentId: "other-board"};
  assert.equal(M.groupNetPairs([rows[0], differentPCB], new Set()).length, 2, "boards with the same names stay separate");
});
test("hint: false-positive set (quiet)", () => {
  const quiet = (items, o, opts) => { const D = withRuleIf(project(items, o), opts); const n = hints(D); assert.equal(n.length, 0, JSON.stringify(n.map(x => x.message))); };
  const withRuleIf = (D, props) => props ? withRule(D, props) : D;
  quiet([track("+400V", [[5, 10], [40, 10]]), track("GND", [[5, 15], [40, 15]])]); // 4.7 mm: far enough
  quiet([track("3V3", [[5, 10], [40, 10]]), track("GND", [[5, 10.4], [40, 10.4]])]); // below the check voltage
  quiet([track("+48V", [[5, 10], [40, 10]]), track("GND", [[5, 11.6], [40, 11.6]])]); // 48 V: 1.2 mm asked, 1.3 mm kept
  quiet([track("+400V", [[5, 10], [40, 10]]), track("SDA", [[5, 10.4], [40, 10.4]])]); // a net without a voltage: not guessed
  quiet([track("+400V", [[5, 10], [40, 10]]), track("400V_SENSE", [[5, 10.4], [40, 10.4]])]); // a rail's sense signal has no voltage
  quiet([track("+400V", [[5, 10], [40, 10]]), track("GND", [[5, 10.4], [40, 10.4]], {layer: "Bottom"})]); // other side of the board
  quiet([track("GND", [[5, 10], [40, 10]]), track("PGND", [[5, 10.4], [40, 10.4]])]); // two grounds
  quiet([track("+400V", [[5, 10], [40, 10]]), track("+390V", [[5, 10.4], [40, 10.4]])]); // 10 V apart
  quiet([track("AC_L", [[5, 10], [40, 10]]), track("GND", [[5, 10.4], [40, 10.4]])], {}, {detectMains: false}); // mains detection off
  quiet([track("+400V", [[5, 10], [40, 10]]), track("GND", [[5, 14], [40, 14]])], {}, {standard: "ipc2221b"}); // IPC: 2.5 mm asked, 3.7 kept
  quiet([track("+400V", [[5, 10], [40, 10]]), track("GND", [[5, 11.3], [40, 11.3]])], {}, {functional: "off"}); // other circuits not checked
  quiet([track("+400V", [[5, 10], [40, 10]]), track("GND", [[5, 11.3], [40, 11.3]])], {}, {threshold: 500}); // check from 500 V
  // A rule checks the pair with a confirmed voltage: DRC reports it, the hint stays quiet.
  quiet([track("DCLINK", [[5, 10], [40, 10]]), track("GND", [[5, 11.3], [40, 11.3]])], {signals: tagStore([{name: "HV", params: {voltage: 400}}], {DCLINK: "HV"})}, {});
});
test("hint: a board cutout wider than the groove width lengthens the creepage path; a narrow one does not", () => {
  const items = () => [track("+400V", [[5, 10], [40, 10]]), track("GND", [[5, 12.3], [40, 12.3]])];
  const plain = project(items());
  assert.equal(hints(plain).length, 1, "2 mm straight: 4 mm asked");
  const slot = project(items());
  AtriumBoardShape.apply(slot.pcb, {contour: AtriumBoardShape.fromPolygon(rect(0, 0, 80, 60)).contour, cutouts: [AtriumBoardShape.fromPolygon(rect(2, 10.6, 45, 11.7)).contour]});
  const s = AtriumBoardShape.holes(slot.pcb);
  assert.equal(s.length, 1, "the cutout is read");
  assert.equal(hints(slot).length, 0, "the path goes round the 43 mm slot (2 mm straight, about 2 × 21 mm round it)");
  const narrow = project(items());
  AtriumBoardShape.apply(narrow.pcb, {contour: AtriumBoardShape.fromPolygon(rect(0, 0, 80, 60)).contour, cutouts: [AtriumBoardShape.fromPolygon(rect(20, 10.9, 20.5, 11.4)).contour]});
  assert.equal(hints(narrow).length, 1, "a cutout narrower than X does not count");
});

// ---------------------------------------------------------------- the rule (DRC)
test("rule: Creepage Distance checks confirmed voltages in DRC (unified violation, rule severity); name-only voltages stay hints", () => {
  const items = () => [track("DCLINK", [[5, 10], [40, 10]]), track("GND", [[5, 11.3], [40, 11.3]]), track("SDA", [[5, 8.7], [40, 8.7]]), track("+400V", [[5, 30], [40, 30]]), track("GND", [[5, 31.3], [40, 31.3]])];
  const D = withRule(project(items(), {signals: tagStore([{name: "HV", params: {voltage: 400}}], {DCLINK: "HV"})}));
  assert.equal(R.stored(D.pcb, D.p).list.filter(r => r.type === "creepage").length, 1, "the rule book's rule applies to the board");
  const v = drc(D);
  assert.deepEqual(v.map(x => x.title).sort(), ["Track (Top Layer) DCLINK ↔ Track (Top Layer) GND", "Track (Top Layer) DCLINK ↔ Track (Top Layer) SDA"], "DCLINK against GND and against a net without a voltage (0 V)");
  for (const x of v) { assert.equal(x.what, "Creepage"); near(x.required, 4, "400 V, PD2, IIIb"); near(x.actual, 1, "measured"); assert.match(x.detail, /by tag HV/); assert.match(x.detail, /IEC 62368-1 Table 17/); }
  assert.ok(!v.some(x => /\+400V/.test(x.title)), "+400V is a voltage by name only: not a DRC violation");
  assert.equal(hints(D).length, 1, "it is a hint instead");
  assert.match(hints(D)[0].message, /^\+400V and GND/);
  const u = AtriumChecks.fromDRC(v[0], D.pcb.id);
  assert.equal(u.check, "layout.creepage"); assert.equal(u.severity, "error"); assert.equal(u.domain, "layout");
  assert.deepEqual(u.measure, {actual: 1, required: 4, limit: "min", unit: "mm"});
  assert.equal(u.objects.length, 2, "both tracks, for cross-probe"); assert.ok(u.at[0].point.every(Number.isFinite));
  assert.equal(AtriumChecks.check("layout.creepage").ruleTypes[0], "creepage", "in the check registry");
  // Unknown nets not checked: the SDA pair goes.
  const S = withRule(project(items(), {signals: tagStore([{name: "HV", params: {voltage: 400}}], {DCLINK: "HV"})}), {unknown: "skip"});
  assert.deepEqual(drc(S).map(x => x.title), ["Track (Top Layer) DCLINK ↔ Track (Top Layer) GND"]);
  // No rule: nothing in DRC; the type is not among a new board's default rules.
  const N = project(items(), {signals: tagStore([{name: "HV", params: {voltage: 400}}], {DCLINK: "HV"})});
  assert.equal(drc(N).length, 0);
  assert.ok(!R.create().list.some(r => r.type === "creepage"));
});
test("rule: the project rule book keeps it (severity, standard, pollution degree) and the MCP check tool lists it", () => {
  const D = withRule(project([track("DCLINK", [[5, 10], [40, 10]]), track("GND", [[5, 12.3], [40, 12.3]])], {signals: tagStore([{name: "HV", params: {voltage: 400}}], {DCLINK: "HV"})}), {severity: "warning", pollution: 1, standard: "iec60664"});
  const r = PR.book(D.p).list.find(x => x.type === "creepage");
  assert.deepEqual([r.severity, r.pollution, r.standard], ["warning", 1, "iec60664"]);
  assert.equal(PR.types().creepage.title, "Creepage Distance");
  assert.equal(drc(D).length, 0, "IEC 60664-1, PD1 printed wiring, 400 V: 1 mm; 2 mm kept");
  PR.edit(D.p, b => { b.list.find(x => x.type === "creepage").pollution = 3; });
  const v = drc(D);
  assert.equal(v.length, 1); near(v[0].required, 6.3, "PD3, IIIb, 400 V");
  const env = {project: () => D.p, mutable: () => D.p, touched() {}, drcOf: d => R.drc(d, DEFS, R.stored(d, D.p), {project: D.p})};
  const out = AtriumChecks.headless("check", {checks: ["layout.creepage"]}, env);
  assert.equal(out.total, 1); assert.equal(out.items[0].check, "layout.creepage"); assert.equal(out.items[0].rule, "Creepage");
  assert.equal(out.items[0].measure.required, 6.3);
  const hintsOut = AtriumChecks.headless("check", {checks: ["layout.hint.creepage"]}, {...env, project: () => project([track("+400V", [[5, 10], [40, 10]]), track("GND", [[5, 11.3], [40, 11.3]])]).p});
  assert.equal(hintsOut.total, 1, "the hint through the same tool"); assert.equal(hintsOut.items[0].severity, "hint");
});

// ---------------------------------------------------------------- poured copper and the isolation barrier
test("poured copper: a ground pour too close to a 400 V track", () => {
  const D = project([track("+400V", [[10, 20], [40, 20]]), {id: id("g"), kind: "polygon", net: "GND", layer: "Top", points: rect(5, 21, 45, 40), clearance: .5, removeDeadCopper: false}]);
  AtriumPolygonPour.apply(D.pcb, DEFS);
  assert.ok((D.pcb.pcbDrawing?.pours || []).length, "poured");
  const [x] = hints(D);
  assert.ok(x, "found");
  assert.match(x.message, /^\+400V and GND are 0\.85 mm apart/);
  assert.ok(x.objects.includes(D.pcb.items[1].id), "the polygon is one of the objects");
});
test("isolation barrier: the schematic hint asks for the part's rated creepage; with it, the board holds GND_ISO to it", () => {
  const parts = params => [{def: "iso", ref: "U1", nets: ["3V3", "GND", "3V3_ISO", "GND_ISO"], ...(params ? {parameters: params} : {})}];
  const bad = project([], {parts: parts()});
  const [s] = sheetHints(bad, "isolationRating");
  assert.ok(s, "found");
  assert.equal(s.message, "U1 crosses the isolation barrier between GND and GND_ISO (by their names) but has no Creepage parameter: add its rated creepage from the datasheet (Creepage = 8 mm), so the board check can hold the copper to it.");
  assert.equal(sheetHints(project([], {parts: parts({Creepage: "8 mm"})}), "isolationRating").length, 0, "rated: quiet");
  assert.equal(sheetHints(project([], {parts: [{def: "iso", ref: "U1", nets: ["3V3", "GND", "5V", "AGND"]}]}), "isolationRating").length, 0, "GND and AGND are not an isolation barrier");
  assert.equal(sheetHints(project([], {parts: [{def: "two", ref: "C1", nets: ["GND", "GND_ISO"]}]}), "isolationRating").length, 0, "a two-pin part (Y capacitor) is not asked");
  const board = params => project([track("GND", [[5, 10], [40, 10]]), track("GND_ISO", [[5, 13.3], [40, 13.3]])], {parts: parts(params)});
  assert.equal(hints(board()).length, 0, "no rating: nothing to hold the gap to");
  const [b] = hints(board({Creepage: "8 mm"}));
  assert.ok(b, "rated 8 mm, 3 mm kept");
  assert.equal(b.severity, "advice");
  assert.match(b.message, /across the isolation barrier of U1, rated 8 mm by its parameter/);
  assert.equal(hints(project([track("GND", [[5, 10], [40, 10]]), track("GND_ISO", [[5, 19], [40, 19]])], {parts: parts({Creepage: "8 mm"})})).length, 0, "8.7 mm kept");
});

// ---------------------------------------------------------------- incremental
test("voltage evidence refreshes distant PCB findings after a regulator edit, preserving other check caches", () => {
  const items = [track("BIAS", [[55, 37], [70, 37]]), track("GND", [[55, 38.3], [70, 38.3]])];
  const D = project(items, {parts: [{def: "reg", ref: "U1", nets: ["SUPPLY", "BIAS", "GND"]}]});
  const e = I.engine(), opts = {checks: ["edgeCopper", "creepage"], prefs: false};
  const run = (from, to, items = []) => {
    const hint = {from, to, ids: new Set(items.map(i => i.id)), items: new Map(items.map(i => [i.id, i]))};
    const pass = e.update(D.p, D.pcb, DEFS, hint, opts); let r = pass.next();
    while (!r.done) r = pass.next();
    return r.value;
  };
  const crc = rows => rows.filter(x => x.check === "creepage").map(x => [x.key, x.message, x.objects, x.netPair]);
  const original = run(null, 1);
  assert.equal(crc(original.insights).length, 1);
  const supply = D.sch.items.find(i => i.kind === "part");
  supply.parameters = {Vout: "12 V"};
  const edited = run(1, 2);
  assert.equal(edited.mode, "incremental");
  assert.equal(crc(edited.insights).length, 0);
  assert.deepEqual(edited.ran.map(x => x.id), ["creepage"], "only the check dependent on changed voltage needs a full scan");
  assert.deepEqual(crc(edited.insights), crc(hints(D)));
  supply.parameters = {Vout: "48 V"};
  assert.deepEqual(crc(run(2, 3).insights), crc(hints(D)));
  assert.equal(run(3, 4).mode, "none", "the same evidence keeps the shortcut");
});

test("incremental: an edit near the high-voltage net re-checks only its pairs, and matches a full pass", () => {
  const items = [track("+400V", [[30, 30], [50, 30]])];
  for (let r = 0; r < 40; r++) for (let c = 0; c < 20; c++) items.push(track(c % 2 ? "GND" : "+12V", [[2 + c * 3.8, 2 + r * 1.4], [4 + c * 3.8, 2 + r * 1.4]], {width: .2}));
  const D = project(items), e = I.engine(), it = (hint) => { const g = e.update(D.p, D.pcb, DEFS, hint, {checks: ["creepage"], prefs: false}); let r = g.next(); while (!r.done) r = g.next(); return r.value; };
  K.resetStats();
  const t0 = now(), first = it({from: null, to: 1, ids: null, items: null}), full = K.stats().last, tFull = now() - t0;
  assert.equal(first.mode, "full");
  // Move a ground track next to the 400 V track.
  const g = D.pcb.items.find(i => i.net === "GND" && Math.abs(i.points[0][1] - 30.2) < .8 && i.points[0][0] > 30 && i.points[0][0] < 48);
  assert.ok(g, "a ground track near the 400 V net");
  const moved = {...g, points: g.points.map(p => [p[0], 30.9])};
  D.pcb.items[D.pcb.items.indexOf(g)] = moved;
  const t1 = now(), inc = it({from: 1, to: 2, ids: new Set([g.id]), items: new Map([[g.id, moved]])}), part = K.stats().last, tInc = now() - t1;
  assert.equal(inc.mode, "incremental");
  console.log("creepage: full pass " + full.pairs + " pairs, " + full.features + " features, " + tFull.toFixed(1) + " ms; the edit " + part.pairs + " pairs, " + part.features + " features, " + tInc.toFixed(1) + " ms");
  assert.ok(part.pairs < full.pairs / 3, "the edit re-checks a few pairs (" + part.pairs + " of " + full.pairs + ")");
  const fresh = hints(D).map(x => x.key).sort();
  assert.deepEqual(inc.insights.filter(x => x.check === "creepage").map(x => x.key).sort(), fresh, "the incremental result equals a full pass");
  assert.ok(fresh.some(k => inc.insights.find(x => x.key === k)?.objects.includes(g.id)), "the moved track is reported");
  // An edit far from any high-voltage net extracts nothing.
  const far = D.pcb.items.find(i => i.net === "+12V" && i.points[0][1] < 4 && i.points[0][0] < 6), farMoved = {...far, points: far.points.map(p => [p[0] + .1, p[1]])};
  D.pcb.items[D.pcb.items.indexOf(far)] = farMoved;
  it({from: 2, to: 3, ids: new Set([far.id]), items: new Map([[far.id, farMoved]])});
  assert.equal(K.stats().last.pairs, 0, "nothing near a high-voltage net");
  assert.equal(K.stats().last.features, 0, "and nothing measured");
  // The online DRC window grows by the rule's reach.
  assert.ok(K.reach({...K.DEFAULTS}) >= 4, "the reach covers 400 V");
});

test("cost: a 20k-object board, full hint pass and one edit near the 400 V nets", () => {
  const items = [];
  for (let r = 0; r < 100; r++) for (let c = 0; c < 200; c++) {
    const k = r * 200 + c, net = k % 7 === 0 ? "GND" : k % 11 === 0 ? "+12V" : k % 13 === 0 ? "+48V" : "SIG" + (k % 500);
    items.push(track(net, [[c * 1.2, r * .9], [c * 1.2 + .8, r * .9]], {width: .15}));
  }
  for (let r = 10; r < 100; r += 20) items.push(track("+400V", [[0, r * .9 + .45], [239, r * .9 + .45]], {width: .5}));
  const D = project(items), e = I.engine(), run = hint => { const g = e.update(D.p, D.pcb, DEFS, hint, {checks: ["creepage"], prefs: false}); let x = g.next(); while (!x.done) x = g.next(); return x.value; };
  const t0 = now(), full = run({from: null, to: 1, ids: null, items: null}), tFull = now() - t0, fullStats = K.stats().last;
  const g = D.pcb.items.find(i => i.net === "GND" && Math.abs(i.points[0][1] - 9) < .01), moved = {...g, points: g.points.map(p => [p[0] + .3, p[1]])};
  D.pcb.items[D.pcb.items.indexOf(g)] = moved;
  const t1 = now(), inc = run({from: 1, to: 2, ids: new Set([g.id]), items: new Map([[g.id, moved]])}), tInc = now() - t1, incStats = K.stats().last;
  console.log("creepage cost: " + items.length + " objects; full hint pass " + tFull.toFixed(1) + " ms (" + fullStats.pairs + " pairs, " + full.insights.length + " hints); one edit " + tInc.toFixed(1) + " ms (" + incStats.pairs + " pairs, " + incStats.features + " features)");
  assert.equal(inc.mode, "incremental");
  assert.ok(incStats.pairs * 20 < fullStats.pairs, "the edit re-checks a small share of the pairs");
  assert.ok(tFull < 4000 && tInc < 400, "within twice the budget (full pass at idle, sliced by the engine; an edit about 10–20 ms)");
});

console.log("creepage: " + passed + " tests passed");
