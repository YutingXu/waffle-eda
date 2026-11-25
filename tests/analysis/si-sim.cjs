"use strict";
// Signal Integrity extension (extensions/si): the IBIS reader, the circuit solver against analytic
// transmission-line cases (matched, open, lattice diagram, RC edge, lossy line, weakly coupled
// crosstalk), IBIS behavioural buffers against their own V-t data, channel extraction on a routed
// 6-layer board (field-solver cross-sections, vias, back-drill, series parts), the API additions
// (simulation.*, files.pickText) and the whole extension in the extension host in a separate realm.
// node tests/analysis/si-sim.cjs, or scripts/test-jsc.sh si-sim
const assert = require("node:assert/strict");
const fs = require("node:fs");
const IB = require("../../extensions/si/ibis.js");
const S = require("../../extensions/si/solver.js");
const CH = require("../../extensions/si/channel.js");
const EN = require("../../extensions/si/engine.js");
const PNG = require("../../extensions/si/png.js");
const U = require("../../extensions/si/util.js");
const FIXTURE = fs.readFileSync(__dirname + "/../fixtures/si/atrium-demo.ibs", "utf8");
const rows = [];
// assert.ok with the message kept under the JSC shim too.
const ok = (v, m) => { if (!v) throw Error("Assertion failed: " + (m || "")); };
function near(name, got, want, tol, abs = 0) {
  const err = want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);
  rows.push({name, got, want, err});
  ok(err <= (want === 0 ? abs : tol), name + ": got " + got + ", want " + want + " (error " + err.toExponential(2) + ")");
}

// ------------------------------------------------------------------ IBIS reader
{
  assert.equal(IB.num("2.2nH"), 2.2e-9); assert.equal(IB.num("-3.3V"), -3.3); assert.equal(IB.num("5M"), 5e6); assert.equal(IB.num("5m"), 5e-3);
  ok(Number.isNaN(IB.num("NA"))); assert.equal(IB.num("abc"), undefined); assert.equal(IB.num("1e-3A"), 1e-3);
  const f = IB.parse(FIXTURE, {name: "atrium-demo.ibs"});
  assert.equal(f.version, "5.1"); assert.equal(f.warnings.length, 0, JSON.stringify(f.warnings));
  assert.deepEqual(IB.summary(f).models.map(m => m.type), ["i/o", "output", "input"]);
  const c = IB.component(f, "atrium_demo");
  assert.equal(c.pins.size, 7); assert.equal(c.package.L.max, 2.5e-9);
  const p1 = IB.pinModel(f, "ATRIUM_DEMO", "1");
  assert.equal(p1.model.name, "DQ_IO"); near("pin 1 L_pin overrides L_pkg", p1.pkg.L, 2.2e-9, 1e-9);
  assert.equal(IB.pinModel(f, null, "2", {corner: "min"}).pkg.R, 0.15, "[Package] min column when the pin has no R_pin");
  assert.equal(IB.pinModel(f, null, "4").special, "power");
  const sel = IB.pinModel(f, null, "6", {choice: "CLK_OUT"});
  assert.equal(sel.selector, "DQ_SEL"); assert.equal(sel.model.name, "CLK_OUT"); assert.equal(sel.choices.length, 2);
  assert.equal(IB.pinModel(f, null, "6").model.name, "DQ_IO", "a selector defaults to its first entry");
  const m = f.models.get("dq_io");
  assert.equal(m.rising.length, 2); assert.equal(m.falling.length, 2); assert.equal(m.rising[1].vFixtureMin, 3);
  near("C_comp max column", m.ccomp.max, 2.5e-12, 1e-9); near("[Ramp] dV/dt_r min", m.ramp.r.min.dt, 0.577e-9, 1e-9);
  // Switching coefficients from two waveforms recover the raised-cosine ramp the fixture was made with.
  for (const [corner, tr] of [["typ", 0.6e-9], ["min", 0.8e-9], ["max", 0.45e-9]]) {
    const b = IB.buffer(m, corner);
    assert.equal(b.edges.rise.source, "two waveforms");
    let worst = 0;
    b.edges.rise.t.forEach((t, i) => { const x = t - 0.1e-9, r = x <= 0 ? 0 : x >= tr ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x / tr); worst = Math.max(worst, Math.abs(b.edges.rise.ku[i] - r), Math.abs(b.edges.rise.kd[i] - (1 - r))); });
    rows.push({name: "Ku/Kd from two waveforms (" + corner + ")", got: worst, want: 0, err: worst});
    ok(worst < 0.02, corner + " Ku/Kd error " + worst);
  }
  assert.equal(IB.buffer(f.models.get("clk_out"), "typ").edges.rise.source, "ramp");
  near("ramp-only 0-100 % time = dt/0.6", IB.buffer(f.models.get("clk_out"), "typ").edges.rise.t[1], 0.433e-9 / 0.6, 1e-9);
  // Errors carry line numbers; untrusted text cannot pollute prototypes or run code.
  const bad = (text, re) => assert.throws(() => IB.parse(text), e => e instanceof IB.IbisError && re.test(e.message), String(re));
  bad("[IBIS Ver] 5.1\n[Component] X\n[Pin]\n1 A\n[End]", /^Line 4: a \[Pin\] row/);
  bad("[IBIS Ver] 5.1\n[Component] X\n[Model] M\nModel_type Bogus\n", /^Line 4: Model_type Bogus/);
  bad("[IBIS Ver] 5.1\n[Component] X\n[Model] M\nModel_type Output\n[Pulldown]\n0 1\nabc def\n", /^Line 7: an I-V row/);
  bad("[IBIS Ver] 5.1\n[Component] X\n[Model] M\nModel_type Output\n[Rising Waveform]\nR_fixture = 50\n0 0\n2n 1\n1n 2\n[End]", /^Line 9: waveform times must increase/);
  bad("[IBIS Ver] 5.1\n[Component] X\n[Model] M\nModel_type Input\n[Model] m\nModel_type Input\n", /^Line 5: model m is defined twice/);
  bad("[IBIS Ver] 5.1\n[Define Package Model] P\n[Component] X\n", /not closed/);
  bad("x".repeat(5000), /longer than 4096/);
  bad("\u0000", /binary/);
  bad("[IBIS Ver] 5.1\n[Model] M\nModel_type Input\n", /no \[Component\]/);
  assert.throws(() => IB.parse("a".repeat(100), {maxBytes: 50}), /larger than/);
  const odd = IB.parse("[IBIS Ver] 7.1\n[Comment Char] #_char\n# comment | not a comment char now\n[Component] __proto__\n[Pin] signal_name model_name\n1 A __proto__\n" +
    "[Define Package Model] PK\nwhatever\n[End Package Model]\n[Model] __proto__\nModel_type Input\nC_comp 1p NA NA\n[GND Clamp]\n0 0 NA NA\n-1 -0.1 NA NA\n[Algorithmic Model]\nExecutable x\n[End Algorithmic Model]\n[End]\n");
  assert.equal(({}).polluted, undefined); assert.equal(Object.prototype.typ, undefined);
  assert.equal(odd.models.get("__proto__").ccomp.min, 1e-12, "NA falls back to typ");
  assert.deepEqual(odd.models.get("__proto__").gndClamp.v, [-1, 0], "a table written in reverse is sorted");
  assert.deepEqual(odd.skipped.map(s => s.keyword), ["define package model", "algorithmic model"]);
}

// ------------------------------------------------------------------ analytic transmission-line cases
const Z0 = 50, TD = 1e-9;
function ideal(rs, rl, o = {}) {
  const c = new S.Circuit(), a = c.node("a"), b = c.node("b"), tr = o.tr ?? 50e-12;
  c.V(a, rs, t => Math.min(1, Math.max(0, (t - 0.1e-9) / tr)));
  c.T(a, b, Z0, TD);
  if (rl) c.R(b, -1, rl);
  return {c, a, b, r: S.simulate(c, {dt: o.dt ?? 2.5e-12, tstop: o.tstop ?? 9e-9, probes: [a, b]})};
}
{
  // Matched: half the source at both ends, no reflection.
  const {r} = ideal(Z0, Z0);
  near("matched: driver 0.5 V", S.at(r.t, r.v[0], 3e-9), 0.5, 1e-6);
  near("matched: receiver 0.5 V after Td", S.at(r.t, r.v[1], 1.5e-9), 0.5, 1e-6);
  near("matched: receiver 0 V before Td", S.at(r.t, r.v[1], 1.05e-9), 0, 0, 1e-9);
  const m = S.measure(r.t, r.v[1], {edge: "rise", t0: 0, vlow: 0, vhigh: 0.5, vinl: 0.15, vinh: 0.35, vmeas: 0.25});
  ok(Math.abs(m.overshoot) < 1e-6 && m.monotonic && m.ringback > 0.14);
  near("matched: flight time to Vmeas = Td", m.tMeas - (0.1e-9 + 25e-12), TD, 1e-3);
}
{
  // Open end: Γ = +1, the receiver doubles to the full source voltage; the driver steps at 2 Td.
  const {r} = ideal(Z0, 0);
  near("open: receiver 1.0 V (doubling)", S.at(r.t, r.v[1], 1.5e-9), 1.0, 1e-6);
  near("open: driver 0.5 V before 2 Td", S.at(r.t, r.v[0], 1.9e-9), 0.5, 1e-6);
  near("open: driver 1.0 V after 2 Td", S.at(r.t, r.v[0], 2.5e-9), 1.0, 1e-6);
}
{
  // Mismatch: Rs 10 Ω, RL 200 Ω. Lattice: Vinc = 50/60, Γs = −2/3, ΓL = 0.6.
  const {r} = ideal(10, 200, {tstop: 20e-9});
  const vinc = Z0 / (Z0 + 10), gs = (10 - Z0) / (10 + Z0), gl = (200 - Z0) / (200 + Z0);
  let v = 0;
  for (let k = 0; k < 5; k++) {
    v += vinc * (1 + gl) * (gl * gs) ** k;
    near("lattice: receiver plateau after " + (2 * k + 1) + " Td", S.at(r.t, r.v[1], (2 * k + 1.5) * TD), v, 1e-6);
  }
  near("lattice: final value Vs·RL/(Rs+RL)", S.at(r.t, r.v[1], 19.9e-9), 200 / 210, 2e-3);
  const m = S.measure(r.t, r.v[1], {edge: "rise", t0: 0, vlow: 0, vhigh: 200 / 210, vinl: 0.3, vinh: 0.7, vmeas: 0.5});
  near("lattice: overshoot = first plateau − final", m.overshoot, vinc * (1 + gl) - 200 / 210, 1e-4);
  near("lattice: ringback margin = second plateau − Vinh", m.ringback, vinc * (1 + gl) * (1 + gl * gs) - 0.7, 1e-4);
}
{
  // RC-limited edge: 100 Ω into 10 pF; 10-90 % = RC ln 9.
  const c = new S.Circuit(), a = c.node("a");
  c.V(a, 100, t => (t > 0 ? 1 : 0)); c.C(a, -1, 10e-12);
  const r = S.simulate(c, {dt: 1e-12, tstop: 8e-9, probes: [a]});
  const t10 = S.crossings(r.t, r.v[0], 0.1)[0], t90 = S.crossings(r.t, r.v[0], 0.9)[0];
  near("RC edge 10-90 % = RC·ln 9", t90 - t10, 1e-9 * Math.log(9), 2e-3);
  near("RC edge V(τ) = 1 − 1/e", S.at(r.t, r.v[0], 1e-9), 1 - Math.exp(-1), 2e-3);
}
{
  // Weakly coupled lines, all four ends in Z0 = √(Ze·Zo): NEXT saturates at Kb·Vinc with
  // Kb = (Ze − Zo)/(2(Ze + Zo)); FEXT peaks at Vinc·(Te − To)/(2·tr) (Johnson & Graham 1993, 5.x).
  const ze = 52, zo = 48, te = 1.0e-9, to = 0.99e-9, tr = 100e-12, z = Math.sqrt(ze * zo);
  const c = new S.Circuit(), a1 = c.node("a1"), b1 = c.node("b1"), a2 = c.node("a2"), b2 = c.node("b2");
  c.V(a1, z, t => Math.min(1, Math.max(0, (t - 0.1e-9) / tr)));
  c.T2(a1, b1, a2, b2, ze, zo, te, to);
  c.R(b1, -1, z); c.R(a2, -1, z); c.R(b2, -1, z);
  const r = S.simulate(c, {dt: 1e-12, tstop: 1.9e-9, probes: [a2, b2, b1]});
  const vinc = 0.5, kb = (ze - zo) / (2 * (ze + zo));
  near("crosstalk NEXT (saturated) = Kb·Vinc", S.at(r.t, r.v[0], 1.0e-9), kb * vinc, 0.02);
  near("crosstalk FEXT peak = Vinc·ΔTd/(2 tr)", -S.peak(r.t, r.v[1]).v, vinc * (te - to) / (2 * tr), 0.03);
  near("crosstalk aggressor far end ≈ Vinc", S.at(r.t, r.v[2], 1.8e-9), vinc, 0.01);
}

// ------------------------------------------------------------------ IBIS driver against its own V-t data
{
  const f = IB.parse(FIXTURE), m = f.models.get("dq_io");
  for (const corner of ["typ", "min", "max"]) for (const [k, w] of m.rising.entries()) {
    const b = IB.buffer(m, corner), c = new S.Circuit(), d = c.node("die");
    c.C(d, -1, b.ccomp);
    const vf = (corner === "min" ? w.vFixtureMin : corner === "max" ? w.vFixtureMax : null) ?? w.vFixture;
    c.V(d, w.rFixture, () => vf);
    const e = b.edges.rise, K = t => { const i = Math.min(e.t.length - 1, Math.max(0, Math.round(t / (e.t[1] - e.t[0])))); return [e.ku[i], e.kd[i]]; };
    c.D(d, {i: (v, t) => { const [ku, kd] = K(t); return b.current(v, ku, kd); }});
    const r = S.simulate(c, {dt: 1e-12, tstop: 2e-9, probes: [d]});
    let worst = 0;
    w.t.forEach((t, i) => { worst = Math.max(worst, Math.abs(S.at(r.t, r.v[0], t) - w[corner][i])); });
    rows.push({name: "IBIS buffer reproduces rising waveform " + (k + 1) + " (" + corner + "), V", got: worst, want: 0, err: worst});
    ok(worst < 0.03, "waveform " + k + " " + corner + " worst error " + worst + " V");
  }
}

// ------------------------------------------------------------------ helpers
{
  assert.equal(CH.value("33R"), 33); assert.equal(CH.value("4k7"), 4700); assert.equal(CH.value("22Ω"), 22); assert.equal(CH.value("10nF"), 1e-8); assert.equal(CH.value("0R"), 0);
  assert.equal(CH.railVoltage("GND"), 0); assert.equal(CH.railVoltage("+3V3"), 3.3); assert.equal(CH.railVoltage("VCC_1V8"), 1.8); assert.equal(CH.railVoltage("5V"), 5); assert.equal(CH.railVoltage("VDD"), null);
  ok(CH.isRail("VTT") && CH.isRail("+5V") && !CH.isRail("DQ0") && !CH.isRail("CLK"));
  near("via barrel L (1.6 mm, 0.3 mm drill)", CH.viaL(1.6, 0.3), 0.2e-9 * 1.6 * (Math.log(4 * 1.6 / 0.3) + 1), 1e-12);
  assert.equal(U.sha256("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(U.sha256(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(U.eng(1.5e-9, "s"), "1.5 ns"); assert.equal(U.parseEng("100M"), 1e8);
  // PNG: a valid signature, IHDR and IEND, and a CRC that checks.
  const png = PNG.png({series: [{name: "a", x: [0, 1, 2], y: [0, 1, 0], color: 0}], hlines: [{y: 0.5, label: "VINH"}]}, {width: 200, height: 120});
  assert.deepEqual([...png.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(String.fromCharCode(...png.slice(12, 16)), "IHDR");
  assert.equal(String.fromCharCode(...png.slice(png.length - 8, png.length - 4)), "IEND");
  const len = (png[8] << 24 | png[9] << 16 | png[10] << 8 | png[11]) >>> 0, crc = (png[16 + len] << 24 | png[17 + len] << 16 | png[18 + len] << 8 | png[19 + len]) >>> 0;
  assert.equal(PNG.crc32(png, 12, 16 + len), crc);
}

// ------------------------------------------------------------------ the engine on synthetic and routed boards
const {appFile} = require("../support/app-source-paths.cjs");
for (const f of ["model", "parts", "spatial", "altium-rules", "stackup", "viastack", "query", "polygon-pour", "rules", "connectivity", "keymap", "proposal", "variants", "bom",
  "impedance", "field-solver", "via-stubs", "atrium-api", "extension-host-worker", "extensions"]) require(appFile(f + ".js"));
require("../../app/extensions/manifests.js");
const BOARD = require("../fixtures/si/board.cjs");

// A straight 100 mm line from U1 to a 50 Ω shunt at U2 with an ideal source: no reflection.
function synthetic(o = {}) {
  const rec = {net: "S", stackup: {thickness: 1.6, er: 4.2, layers: [{key: "Top", z: 0, t: 0.035, geometry: {structure: "microstrip", h: 0.2, er: 4.2, t: 0.035}}]},
    tracks: [{id: "t", layer: "Top", width: 0.3, points: [[0, 0], [60, 0], [100, 0]]}], vias: [], neighbours: [],
    pads: [{part: "U1", ref: "U1", pin: "1", x: 0, y: 0, w: 0.5, h: 0.5, layer: "Top"}, {part: "U2", ref: "U2", pin: "1", x: 100, y: 0, w: 0.5, h: 0.5, layer: "Top"}, {part: "R9", ref: "R9", pin: "1", x: 100, y: 0, w: 0.5, h: 0.5, layer: "Top"}],
    parts: [{id: "U1", ref: "U1", value: "", pins: [{pin: "1", net: "S", x: 0, y: 0, layer: "Top"}]}, {id: "U2", ref: "U2", value: "", pins: [{pin: "1", net: "S", x: 100, y: 0, layer: "Top"}]},
      ...(o.load === false ? [] : [{id: "R9", ref: "R9", value: String(o.load ?? 50), pins: [{pin: "1", net: "S", x: 100, y: 0}, {pin: "2", net: "GND", x: 101, y: 0}]}])]};
  if (o.load === false) rec.pads.pop();
  const p = EN.plan({nets: [rec], ideal: {rs: o.rs ?? 50, v0: 0, v1: 1, rise: 50e-12}, generic: {ccomp: 1e-18}, driver: "U1.1"});
  const solved = new Map([[CH.xsKey("Top", 0.3), {ok: true, z0: 50, delay: 6, alpha_c: o.alpha ?? 0, alpha_d: 0}]]);
  EN.solveList(p, {corners: ["typ"]});
  return {p, solved, r: EN.simulate(p, solved, {corners: ["typ"], loss: o.alpha > 0, tstop: 6e-9, vinl: 0.15, vinh: 0.35})};
}
{
  const {r} = synthetic();
  const rx = r.metrics.find(m => m.role === "receiver");
  near("engine: matched line receiver level", rx.vhigh, 0.5, 1e-3);
  ok(Math.abs(rx.overshoot) < 2e-3, "engine: no reflection on a matched line (" + rx.overshoot + ")");
  near("engine: matched line delay = 100 mm × 6 ps/mm", rx.delay, 600e-12, 0.01);
  assert.equal(r.channel.lines.length, 1, "collinear segments merge into one line");
  const open = synthetic({load: false}).r.metrics.find(m => m.role === "receiver");
  near("engine: open line doubles", open.max, 1.0, 5e-3);
  // Lossy: 10 Ω of series R over the line (α = R/2Z0): first arrival ≈ 0.5·e^(−R/2Z0), DC 50/110.
  const Rtot = 10, alpha = Rtot / 100 / (2 * 50) * 8.685889638;
  const lossy = synthetic({alpha});
  const w = lossy.r.waves.find(x => x.role === "receiver");
  near("engine: lossy line first arrival 0.5·exp(−R/2Z0)", S.at(lossy.r.t, w.v, 0.9e-9), 0.5 * Math.exp(-Rtot / 100), 0.01);
  near("engine: lossy line DC level", S.at(lossy.r.t, w.v, 5.9e-9), 50 / 110, 2e-3);
  // Series sweep: Rs 10 Ω into an open line wants about Z0 − 10 = 40 Ω.
  const sp = synthetic({rs: 10, load: false});
  const sw = EN.drain(EN.sweep(sp.p, sp.solved, {kind: "series", sim: {corners: ["typ"], tstop: 6e-9, vinl: 0.3, vinh: 0.7}}));
  ok(sw.best >= 33 && sw.best <= 47, "series sweep suggests about 40 Ω, got " + sw.best);
  near("series rule of thumb Z0 − Rout", sw.theory, 40, 1e-6);
}

const done = (async () => {
  const project = BOARD.project();
  const h = AtriumAPI.headless(project, {extension: {id: "t", permissions: {"read:project": true}}});
  // API: the routed copper, stack-up and via data of one net.
  const ch = await h.call("simulation.channel", ["DQ0_R", {neighbours: 0.8}], false);
  assert.deepEqual(ch.tracks.map(t => t.id), ["t-dqr1", "t-dqr2", "t-dqr3"]);
  assert.equal(ch.stackup.layers.length, 6); assert.equal(ch.stackup.layers[0].geometry.structure, "microstrip"); assert.equal(ch.stackup.layers[2].geometry.structure, "stripline");
  const stub = Object.fromEntries(ch.vias.map(v => [v.id, v.stub]));
  ok(stub["v-dq1"].bottom > 0.8 && stub["v-dq2"].residual === 0.2, "via stubs and back-drill: " + JSON.stringify(stub));
  assert.deepEqual(ch.neighbours.map(n => n.net).sort(), ["CLK", "DQ0"]);
  assert.deepEqual(ch.parts.map(p => p.ref).sort(), ["R1", "U2"]);
  assert.throws(() => h.call("simulation.channel", [""], false), /expects a net name/);
  const denied = AtriumAPI.headless(project, {extension: {id: "x", permissions: {}}});
  assert.throws(() => denied.call("simulation.channel", ["DQ0"], false), /read:project/);
  assert.throws(() => denied.call("simulation.fieldSolve", [{structure: "microstrip"}], false), /read:project/);
  assert.throws(() => h.call("simulation.fieldSolve", [{structure: "microstrip", big: "x".repeat(5000)}], false), /cross-section object/);
  assert.throws(() => h.call("files.pickText", [{}], false), /ui:panel or ui:command/);
  assert.deepEqual(h.call("simulation.get", [], false).models, []);
  assert.equal(h.call("simulation.model", ["__proto__"], false), null);
  // Field solver through the API: cached on repeat.
  const geom = CH.solverGeometry(ch.stackup, "Top", 0.2);
  let t0 = Date.now();
  const fs1 = await h.call("simulation.fieldSolve", [geom, {}], false);
  const first = Date.now() - t0; t0 = Date.now();
  const fs2 = await h.call("simulation.fieldSolve", [geom, {}], false);
  ok(fs1.ok && fs1.z0 > 40 && fs1.z0 < 60 && fs2.z0 === fs1.z0 && Date.now() - t0 < first, "field solve cached");
  // A Width rule with an impedance profile: the SI cross-section is the profile's, as DRC and the Layer Stack
  // Manager solve it (its reference plane, etch and coplanar ground gap), not the layer's default. Before the
  // fix solverGeometry dropped etch and g and always used the neighbouring planes.
  {
    const pp = BOARD.project(), pd = pp.documents.find(x => x.kind === "pcb"), layer = ch.tracks[0].layer;
    pd.stackup.impedanceProfiles = [{id: "cpw50", name: "50 Ω CPWG", type: "cpw", target: 50, tolerance: 10,
      layers: {[layer]: {enabled: true, etch: 2, ground: 0.15, reference: [null, "Inner 2"]}}}];
    const rs = AtriumRules.create();
    rs.list.unshift({id: "w-dq", type: "width", name: "Width_DQ0_R", comment: "", enabled: true, priority: 1, scope: {kind: "net", value: "DQ0_R"}, min: 0.1, preferred: 0.2, max: 0.5, impedanceProfile: "cpw50"});
    AtriumRules.store(pd, pp, rs);  // the board's rules in the project rule book
    const hp = AtriumAPI.headless(pp, {extension: {id: "t", permissions: {"read:project": true}}});
    const cp = await hp.call("simulation.channel", ["DQ0_R", {}], false);
    const t = cp.tracks.find(x => x.layer === layer);
    assert.equal(t.profile, "cpw50");
    const want = AtriumStackup.profileValues(pd, "cpw50", layer, new Map()).geom, got = CH.solverGeometry(cp.stackup, layer, t.width, null, t.profile);
    for (const k of ["structure", "h", "er", "t", "etch", "g"]) assert.equal(got[k], want[k], "SI cross-section " + k);
    assert.equal(got.etch, 2); assert.equal(got.g, 0.15);
    ok(got.h > CH.solverGeometry(cp.stackup, layer, t.width).h, "referenced to Inner 2, not the adjacent plane");
    const xs = CH.crossSections(CH.graph(cp)).find(x => x.layer === layer);
    assert.equal(xs.profile, "cpw50"); assert.equal(xs.geometry.etch, 2);
  }

  // The whole routed net: driver U1.1 (two-waveform DQ_IO) → 22 Ω R1 → via → Inner 2 → back-drilled via → U2.1.
  const ibis = IB.parse(FIXTURE);
  const assign = {U1: {model: "k", component: "ATRIUM_DEMO"}, U2: {model: "k", component: "ATRIUM_DEMO"}, U3: {model: "k", component: "ATRIUM_DEMO"}};
  const recs = [await h.call("simulation.channel", ["DQ0", {neighbours: 0.8}], false)];
  for (const n of EN.seriesNets(recs[0], ["DQ0"])) recs.push(await h.call("simulation.channel", [n, {}], false));
  assert.deepEqual(recs.map(r => r.net), ["DQ0", "DQ0_R"]);
  const plan = EN.plan({nets: recs, library: () => ibis, assign});
  assert.equal(plan.driver.ref + "." + plan.driver.pin, "U1.1"); assert.deepEqual(plan.receivers.map(e => e.ref), ["U2"]);
  assert.equal(plan.series[0].part.ref, "R1");
  const opts = {corners: ["typ", "min", "max"], loss: true, crosstalk: {maxGap: 0.5}};
  const jobs = EN.solveList(plan, opts), solved = new Map();
  t0 = Date.now();
  for (const j of jobs) solved.set(j.key, await h.call("simulation.fieldSolve", [j.geometry, {fGHz: j.fGHz, quality: j.quality}], false));
  const solveMs = Date.now() - t0;
  t0 = Date.now();
  const res = EN.simulate(plan, solved, opts);
  const simMs = Date.now() - t0;
  ok(res.channel.lines.length === 4 && res.channel.vias.length === 4, "4 lines, 2 vias with 2 stubs");
  ok(res.channel.vias.find(v => v.id === "v-dq2" && v.kind === "stub").length === 0.2, "back-drilled stub");
  for (const c of ["typ", "min", "max"]) {
    const m = res.metrics.find(x => x.corner === c && x.role === "receiver");
    ok(m.reachesVinh && m.monotonic && m.overshootPct < 10, c + " receiver: " + JSON.stringify(m));
    ok(m.tVinh > 0 && m.tVinh < 3e-9, c + " flight time " + m.tVinh);
  }
  const sw = (c, k) => res.metrics.find(x => x.corner === c && x.role === "receiver")[k];
  ok(sw("max", "vhigh") > sw("typ", "vhigh") && sw("typ", "vhigh") > sw("min", "vhigh"), "corner rails 3.6 / 3.3 / 3.0 V");
  ok(sw("max", "tVinh") < sw("typ", "tVinh") && sw("typ", "tVinh") < sw("min", "tVinh"), "the fast corner is fastest");
  assert.equal(res.crosstalk[0]?.victim, "CLK");
  ok(res.crosstalk[0].nextPct > 0.05 && res.crosstalk[0].nextPct < 5, "NEXT on CLK " + res.crosstalk[0].nextPct + " %");
  ok(Math.abs(res.crosstalk[0].next) <= 1.1 * res.crosstalk[0].kb * 3.6, "NEXT within the saturated closed-form bound Kb·Vswing");
  // Speed: a few-ns run of three corners plus crosstalk well under a second.
  rows.push({name: "DQ0 → DQ0_R: 3 corners + crosstalk, sim ms", got: simMs, want: 1000, err: 0}, {name: "DQ0 → DQ0_R: " + jobs.length + " field solves, ms", got: solveMs, want: 0, err: 0});
  ok(simMs < 1000, "simulation took " + simMs + " ms");
  // CLK: a T-branch to two receivers, with the series-R sweep finding a value that tames the fast corner.
  const clk = EN.plan({nets: [await h.call("simulation.channel", ["CLK", {neighbours: 0.8}], false)], library: () => ibis, assign});
  assert.deepEqual(clk.receivers.map(e => e.ref + "." + e.pin), ["U2.3", "U3.3"]);
  for (const j of EN.solveList(clk, opts)) if (!solved.has(j.key)) solved.set(j.key, await h.call("simulation.fieldSolve", [j.geometry, {fGHz: j.fGHz, quality: j.quality}], false));
  const rc = EN.simulate(clk, solved, opts);
  assert.deepEqual(rc.crosstalk.map(x => x.victim).sort(), ["DQ0", "DQ0_R"]);
  const sweep = EN.drain(EN.sweep(clk, solved, {kind: "series", sim: opts}));
  ok(sweep.best > 0 && sweep.rows.length === 14 && sweep.theory > 5, "CLK series sweep " + JSON.stringify([sweep.best, sweep.theory]));

  // ---------------------------------------------------------------- the extension in the host
  const E = AtriumExtensions;
  const BOOT = `(function(){
    const post = globalThis.__hostPost; delete globalThis.__hostPost;
    const inbox = [];
    globalThis.self = globalThis;
    // Typed arrays survive the JSON transport (a browser worker uses structured clone).
    self.postMessage = m => post(JSON.stringify(m, (k, v) => (v instanceof Uint8Array ? {__u8: Array.from(v)} : v)));
    self.addEventListener = (type, f) => { if (type === "message") inbox.push(f); };
    globalThis.__deliver = text => { const data = JSON.parse(text); for (const f of inbox) f({data}); };
  })();`;
  function realmWorker(source) {
    const outer = {onmessage: null, terminated: false, terminate() { this.terminated = true; }};
    const revive = (k, v) => (v && typeof v === "object" && Array.isArray(v.__u8) ? Uint8Array.from(v.__u8) : v);
    const hostPost = text => { if (!outer.terminated) Promise.resolve().then(() => { if (!outer.terminated) outer.onmessage?.({data: JSON.parse(text, revive)}); }); };
    let deliver;
    if (globalThis.$262?.createRealm) { const r = $262.createRealm(); r.global.__hostPost = hostPost; r.evalScript(BOOT); deliver = r.global.__deliver; r.evalScript(source); }
    else { const vm = require("node:vm"), ctx = vm.createContext({__hostPost: hostPost}); vm.runInContext(BOOT, ctx); deliver = vm.runInContext("__deliver", ctx); vm.runInContext(source, ctx); }
    outer.postMessage = m => { const text = JSON.stringify(m); Promise.resolve().then(() => { if (!outer.terminated) deliver(text); }); };
    return outer;
  }
  let live = BOARD.project(), rev = 0, selection = new Set();
  const exported = [], reviews = [];
  let pick = null;
  const host = {project: () => live, documentId: () => "si-board", revision: () => rev, selection: () => [...selection],
    select(ids) { selection = new Set(ids); E.notify("selectionChanged"); }, edit(fn) { fn(); rev++; }, info() {}, activate() {}, locate() {},
    exportFile: (name, data) => { exported.push({name, data}); return true; }, pickFile: () => pick};
  E.attach(host, {createWorker: realmWorker, consent: req => { if (req.kind === "review") { reviews.push(req.label); return true; } return null; }});
  const ID = "waffle.si", PANEL = "waffle.si";
  const info = E.list().find(e => e.id === ID);
  ok(info && info.origin === "builtin" && info.enabled && info.status === "inactive", "ships as a built-in, inactive until used");
  assert.deepEqual(E.permissions(ID).live, {"read:project": true, "propose:edits": true, "outputs:write": true, "ui:panel": true, "ui:command": true}, "no network, no direct writes");
  assert.deepEqual(E.permissions(ID).network, []);
  // Import the IBIS fixture through the picker: parsed, then a reviewed proposal stores it.
  pick = {name: "atrium-demo.ibs", size: FIXTURE.length, text: async () => FIXTURE};
  const imp = await E.execute("si.importIbis");
  assert.equal(imp.applied, 1); assert.match(reviews[0], /Add IBIS model atrium-demo\.ibs/);
  const key = Object.keys(live.simulation.models)[0];
  assert.equal(live.simulation.models[key].text, FIXTURE); assert.equal(live.simulation.models[key].sha256, U.sha256(FIXTURE));
  assert.deepEqual((await E.execute("si.importIbis")).existing, true, "the same file twice is recognised");
  // A broken file is refused with its line number and never stored.
  pick = {name: "bad.ibs", size: 40, text: async () => "[IBIS Ver] 5.1\n[Component] X\n[Pin]\n1 A\n"};
  assert.match((await E.execute("si.importIbis")).error, /^Line 4:/);
  pick = {name: "huge.ibs", size: 9e6, text: async () => ""};
  await assert.rejects(E.execute("si.importIbis"), /larger than/);
  assert.equal(Object.keys(live.simulation.models).length, 1);
  // Assign the model to U1, U2 and U3 (remembered per part, one reviewed proposal each).
  for (const id of ["U1", "U2", "U3"]) assert.equal((await E.execute("si.assignModel", id, {model: key, component: "ATRIUM_DEMO"})).applied, 1);
  assert.deepEqual(Object.keys(live.simulation.assign).sort(), ["U1", "U2", "U3"]);
  // Programmatic simulation.
  const out = await E.execute("si.simulate", {net: "DQ0", corners: ["typ", "max"], crosstalk: true, waves: true});
  assert.equal(out.driver.ref, "U1"); assert.equal(out.driver.source, "ibis"); assert.equal(out.driver.model, "DQ_IO");
  assert.deepEqual(out.nets, ["DQ0", "DQ0_R"]);
  ok(out.metrics.some(m => m.corner === "max" && m.probe === "U2.1" && m.reachesVinh));
  assert.equal(out.crosstalk[0].victim, "CLK");
  ok(out.waves.t.length > 100 && out.waves.series.length === 4);
  // The panel: Simulate Net from the selection, waveform viewer, zoom, cursors, eye, exports, Messages.
  selection = new Set(["t-clk1"]);
  await E.execute("si.simulateNet");
  const walk = (v, f) => { if (Array.isArray(v)) v.forEach(x => walk(x, f)); else if (v && typeof v === "object") { f(v); walk(v.children, f); } };
  const find = type => { const o = []; walk(E._panel(ID, PANEL), v => { if (v.type === type) o.push(v); }); return o; };
  let plots = find("plot");
  assert.equal(plots.length, 1, "one waveform plot");
  ok(plots[0].series.length >= 3 && plots[0].hlines.length === 2 && plots[0].vlines.length === 2 && plots[0].zoomCommand === "si.zoom");
  assert.deepEqual([...new Set(plots[0].series.map(s => s.style))].sort(), ["", "dash", "faint"], "corners overlaid: solid typ, dashed min, faint max");
  const results = find("table").find(t => t.columns.some(c => c.title === "Ringback margin"));
  ok(results.rows.length >= 6 && results.rows.every(r => r.locate && /^U[23]\.3$/.test(r.probe)), "receiver rows zoom to the part");
  await E.execute("si.zoom", {x0: 0.5, x1: 1.5});
  plots = find("plot");
  assert.deepEqual(plots[0].xRange.map(x => Math.round(x * 100) / 100), [0.5, 1.5]);
  await E.execute("si.cursor", {x: 0.8, cursor: "a"}); await E.execute("si.cursor", {x: 1.2, cursor: "b"});
  const cur = find("table").find(t => t.columns[0].title === "Cursor");
  assert.equal(cur.rows[0].d, "400 ps");
  await E.execute("si.zoom", {fit: true});
  await E.execute("si.run", {stimulus: "clock", freq: "200M"});
  await E.execute("si.toggle", "eye");
  plots = find("plot");
  assert.match(plots[0].title, /^Eye overlay/); ok(plots[0].series[0].y.some(y => y === null), "folded traces break between periods");
  await E.execute("si.toggle", "eye");
  const csv = await E.execute("si.exportCsv"), png = await E.execute("si.exportPng");
  ok(csv.rows > 100 && png.bytes > 1000);
  assert.match(exported[0].name, /^CLK-si\.csv$/); assert.match(String(exported[0].data).split("\n")[0], /^time_s,U1\.2_typ_V,/);
  const bytes = exported[1].data;
  assert.equal(exported[1].name, "CLK-si.png"); assert.deepEqual([...new Uint8Array(bytes.buffer || bytes).slice(1, 4)], [80, 78, 71]);
  const swp = await E.execute("si.sweep", "series");
  ok(swp.rows.length === 14 && swp.best != null);
  ok(find("table").some(t => t.columns[0].title === "Series R"));
  // Removing the model is reviewed too and takes the assignments with it.
  await E.execute("si.removeModel", key);
  assert.deepEqual(Object.keys(live.simulation.models), []); assert.deepEqual(Object.keys(live.simulation.assign), []);
  await E.execute("si.cancel");
  // Stop the extension so no watchdog or idle timer keeps the test runner alive.
  await E.deactivate(ID);

  for (const r of rows) console.log(r.name.padEnd(64) + " got " + String(Number(Number(r.got).toPrecision(6))).padStart(12) + "  want " + String(Number(Number(r.want).toPrecision(6))).padStart(10) + "  err " + (Number.isFinite(r.err) ? r.err.toExponential(2) : r.err));
  console.log("si-sim: ok");
})();
globalThis.__testDone = done;
module.exports = done;
done.catch(e => { console.error(e && e.stack || e); if (globalThis.process) process.exitCode = 1; });
