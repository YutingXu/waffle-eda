"use strict";
// SPICE Simulation (extensions/spice): solver accuracy against analytic answers, the netlist
// parser, schematic → netlist export (parameters, sources, pin roles, variants), and the whole
// extension in the extension host in a separate JS realm (panel, probes, cursors, zoom, budgets).
// node tests/analysis/spice.cjs, or scripts/test-jsc.sh spice
const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");
const S = require("../../extensions/spice/spice.js");
const X = require("../../extensions/spice/export.js");
const VT = S.VT;
const rows = [];
// Record an accuracy check: |got − want| <= tol·|want| (relative) or abs when want is 0.
function near(name, got, want, tol, abs = 0) {
  const err = want === 0 ? Math.abs(got) : Math.abs(got - want) / Math.abs(want);
  rows.push({name, got, want, err});
  assert.ok(err <= (want === 0 ? abs : tol), name + ": got " + got + ", want " + want + " (error " + err.toExponential(2) + ")");
}
const sim = (text, an, o) => S.simulate(text, an, o);
const v = (r, n) => S.signal(r, n).re;
const at = (r, n, t) => S.at(r.x, v(r, n), t);
// Scalar Newton solve for analytic references (f increasing).
function solve(f, lo, hi) { for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; } return (lo + hi) / 2; }

// ------------------------------------------------------------------ numbers and parsing
assert.equal(S.num("4.7k"), 4700); assert.equal(S.num("10meg"), 1e7); assert.equal(S.num("2.2uF"), 2.2e-6); assert.equal(S.num("4k7"), 4700);
assert.equal(S.num("1r5"), 1.5); assert.equal(S.num("1e-3"), 1e-3); assert.equal(S.num("100p"), 1e-10); assert.equal(S.num("5V"), 5); assert.ok(Number.isNaN(S.num("abc")));
assert.equal(S.num("1M"), 1e-3, "SPICE M is milli");
{
  const d = S.parse("title line\nR1 a b\n+ 1k ; trailing comment\n* comment\n.model dm D(IS=1e-15 N=2)\n.tran 1u 1m\n.end\nR9 junk");
  assert.equal(d.title, "title line"); assert.equal(d.elements.length, 1); assert.deepEqual(d.elements[0].tokens, ["R1", "a", "b", "1k"]);
  assert.equal(d.models.dm.params.is, 1e-15); assert.equal(d.analyses[0].tstop, 1e-3);
  assert.throws(() => S.parse("t\nZ1 a b 1"), /unsupported element Z1/);
  assert.throws(() => sim("t\nV1 a 0 1\nV2 a 0 2\n.op"), /singular/);
  assert.throws(() => sim("t\nV1 a 0 1\nD1 a 0 nomodel\n.op"), /no \.model nomodel/);
  assert.throws(() => sim("t\nV1 a 0 1\nR1 a 0 1k\nX1 a 0 MISSING\n.op"), /no \.subckt MISSING/);
  assert.match(sim("t\nV1 a 0 1\nR1 a 0 1k\nX1 a 0 MISSING\n.op", null, {missing: "skip"}).warnings.join(), /MISSING/);
  assert.match(S.parse("t\n.include x.lib\n").warnings[0], /ignored/);
}

// ------------------------------------------------------------------ .op: linear and controlled sources
{
  const r = sim("divider\nV1 in 0 10\nR1 in out 3k\nR2 out 0 1k\n.op");
  near("divider V(out)", r.nodes.out, 2.5, 1e-8);
  near("divider I(V1)", r.currents.V1, -2.5e-3, 1e-8);
  const c = sim("controlled\nV1 a 0 1\nR1 a 0 1k\nF1 0 b V1 2\nR2 b 0 1k\nH1 c 0 V1 1k\nR3 c 0 1\nG1 0 d a 0 1m\nR4 d 0 2k\nE1 e 0 a 0 -3\nR5 e 0 1k\n.op");
  near("CCCS F", c.nodes.b, -2, 1e-8); near("CCVS H", c.nodes.c, -1, 1e-8); near("VCCS G", c.nodes.d, 2, 1e-8); near("VCVS E", c.nodes.e, -3, 1e-8);
  const i = sim("isrc\nI1 0 a 2m\nR1 a 0 1k\n.op");
  near("current source into R", i.nodes.a, 2, 1e-8);
}
// ------------------------------------------------------------------ B sources (safe expressions, automatic derivatives)
{
  const r = sim("square\nV1 a 0 2\nB1 b 0 V={V(a)*V(a)+1}\nR1 b 0 1k\n.op");
  near("B V = V(a)^2 + 1", r.nodes.b, 5, 1e-9);
  const t = sim("tanh\nV1 a 0 3\nB1 0 b I=1m*tanh(V(a))\nR1 b 0 1k\n.op");
  near("B I = 1m·tanh(V(a)) into 1k", t.nodes.b, Math.tanh(3), 1e-6);
  const s = sim("sense\nV1 a 0 1\nVs a b 0\nR1 b 0 1k\nB1 c 0 V=I(Vs)*1k\nR2 c 0 1\n.op");
  near("B V = I(Vs)·1k", s.nodes.c, 1, 1e-6);
  const p = sim("param\n.param gain=3\n.subckt amp i o\nB1 o 0 V={gain}*V(i)\n.ends\nV1 a 0 1\nX1 a b amp\nR1 b 0 1k\n.op");
  near("B in a subcircuit with a .param", p.nodes.b, 3, 1e-9);
  // Functions, each with its derivative exercised by Newton on a nonlinear loop: solve x = f(x).
  for (const [f, want] of [["limit(V(x)+1, 0, 0.5)", 0.5], ["table(V(x), 0, 0, 1, 2)", 0], ["-pwr(V(x)-1, 3)", solve(x => x + Math.pow(x - 1, 3), -2, 2)], ["max(0.3, 0.5*V(x))", 0.3], ["if(V(x) > 10, 1, 0.25)", 0.25], ["sqrt(abs(V(x)))*0 + exp(0)/4", 0.25]]) {
    const q = sim("fixed point\nB1 x 0 V={" + f + "}\nR1 x 0 1k\n.op");
    near("B " + f, q.nodes.x, want, 1e-6, 1e-9);
  }
  // A diode written as a B source converges like the D element: 1 V through 1 kΩ.
  const d = sim("bdiode\nV1 a 0 1\nR1 a k 1k\nB1 k 0 I=1e-14*(exp(V(k)/" + VT + ")-1)\n.op");
  const vd = solve(x => 1e-14 * (Math.exp(x / VT) - 1) - (1 - x) / 1e3, 0, 1);
  near("B exponential junction", d.nodes.k, vd, 1e-6);
  // Q = 1µ·V is a 1 µF capacitor: RC step at τ, and −3 dB at 1/(2πRC).
  const q = sim("charge\nV1 a 0 PULSE(0 1 0 1n 1n 1 2)\nR1 a b 1k\nB1 b 0 Q=1u*V(b)\n.tran 10u 3m");
  near("B Q = C·V step at τ", at(q, "b", 1e-3), 1 - Math.exp(-1), 2e-3);
  const qa = sim("charge ac\nV1 a 0 AC 1\nR1 a b 1k\nB1 b 0 Q=1u*V(b)\n.ac lin 1 " + 1 / (2 * Math.PI * 1e-3) + " " + 1 / (2 * Math.PI * 1e-3));
  near("B Q = C·V at fc", S.db(S.signal(qa, "b"))[0], -10 * Math.log10(2), 1e-4);
  // A voltage-dependent capacitor C(V) = C0·(1 + V/Vk) charged by a constant current I:
  // Q(V) = C0·(V + V²/(2Vk)) = I·t, so V(t) = Vk·(√(1 + 2It/(C0·Vk)) − 1).
  const c0 = 1e-6, vk = 2, ic = 1e-3, tt = 2e-3;
  const nl = sim("cv\nI1 0 b " + ic + "\nB1 b 0 Q={" + c0 + "*(V(b)+V(b)*V(b)/(2*" + vk + "))}\n.tran 5u 3m uic");
  near("B nonlinear charge C(V) under constant current", at(nl, "b", tt), vk * (Math.sqrt(1 + 2 * ic * tt / (c0 * vk)) - 1), 2e-3);
  assert.throws(() => sim("t\nB1 a 0 V=foo(1)\nR1 a 0 1\n.op"), /Unknown function foo/);
  assert.throws(() => sim("t\nB1 a 0 V=1+\nR1 a 0 1\n.op"), /ends too early/);
  assert.throws(() => sim("t\nB1 a 0 V=nope*2\nR1 a 0 1\n.op"), /Unknown name nope/);
  assert.throws(() => sim("t\nB1 a 0 V=" + "(".repeat(80) + "1" + ")".repeat(80) + "\nR1 a 0 1\n.op"), /nests more than 64/);
  assert.throws(() => sim("t\nB1 a 0 V=I(R1)\nR1 a 0 1\n.op"), /must name a voltage source/);
  assert.throws(() => sim("t\nB1 a 0 X=1\n.op"), /B source reads/);
  // Never eval: a JavaScript-looking expression is rejected by the grammar, not run.
  assert.throws(() => sim("t\nB1 a 0 V=globalThis.x=1\nR1 a 0 1\n.op"), /Unexpected|Cannot read|Unknown name/);
}
// Op-amp built from a VCVS (A = 1e5): non-inverting gain 10 and inverting gain −4.7.
{
  const A = 1e5;
  const r = sim("noninv\nV1 in 0 1\nE1 out 0 in fb 100k\nRf out fb 9k\nRg fb 0 1k\n.op");
  near("VCVS op-amp non-inverting", r.nodes.out, 10 / (1 + 10 / A), 1e-6);
  const s = sim("inv\nV1 in 0 1\nR1 in m 10k\nR2 m out 47k\nE1 out 0 0 m 100k\n.op");
  near("VCVS op-amp inverting", s.nodes.out, -4.7 / (1 + 5.7 / A), 1e-6);
  // Subcircuit wrapping the same VCVS, used twice (prefixing of internal nodes and names).
  const x = sim("sub\n.subckt AMP p n o\nE1 o 0 p n 100k\n.ends\nV1 in 0 0.5\nX1 in fb out AMP\nR1 out fb 1k\nR2 fb 0 1k\nX2 out fb2 out2 AMP\nR3 out2 fb2 3k\nR4 fb2 0 1k\n.op");
  near("subcircuit cascade", x.nodes.out2, 0.5 * (2 / (1 + 2 / A)) * (4 / (1 + 4 / A)), 1e-6);
}
// ------------------------------------------------------------------ diode
{
  const IS = 1e-14, n = 1, R = 1e3, Vs = 5;
  const vd = solve(x => IS * (Math.exp(x / (n * VT)) - 1) - (Vs - x) / R, 0, Vs);
  const r = sim("diode\nV1 in 0 5\nR1 in a 1k\nD1 a 0 dm\n.model dm D(IS=1e-14 N=1)\n.op");
  near("diode .op Vd (Shockley)", r.nodes.a, vd, 1e-6);
  // Series resistance and emission coefficient.
  const rs = 10, n2 = 1.8, IS2 = 2.7e-9;
  const vd2 = solve(x => { const i = (Vs - x) / R; return x - (n2 * VT * Math.log(i / IS2 + 1) + i * rs); }, 0, Vs);
  near("diode with RS, N", sim("d2\nV1 in 0 5\nR1 in a 1k\nD1 a 0 dm\n.model dm D(IS=2.7n N=1.8 RS=10)\n.op").nodes.a, vd2, 1e-6);
  // Zener breakdown: reverse-biased 5.1 V zener through 1 kΩ from 12 V.
  const z = sim("zener\nV1 in 0 12\nR1 in k 1k\nD1 0 k dz\n.model dz D(IS=1e-14 BV=5.1 IBV=5m)\n.op");
  const vz = solve(x => 5e-3 * Math.exp((x - 5.1) / VT) - 1e-14 * (Math.exp(-x / VT) - 1) - (12 - x) / 1e3, 0, 12);
  near("zener breakdown", z.nodes.k, vz, 1e-6);
  // DC sweep of the I–V curve.
  const d = sim("iv\nV1 a 0 0\nD1 a 0 dm\n.model dm D(IS=1e-14)\n.dc V1 0 0.8 0.05");
  near("diode .dc at 0.7 V", -S.at(d.x, v(d, "i(V1)"), 0.7), 1e-14 * (Math.exp(0.7 / VT) - 1), 1e-6);
  assert.equal(d.x.length, 17);
  // Half-wave rectifier: the peak is the source peak minus the diode drop at that current.
  const h = sim("rect\nV1 in 0 SIN(0 5 1k)\nD1 in out dm\nR1 out 0 1k\nC1 out 0 1p\n.model dm D(IS=1e-14)\n.tran 2u 2m");
  near("rectifier peak", Math.max(...v(h, "out")), Vs - vd, 2e-3);
  near("rectifier reverse half", Math.min(...v(h, "out")), 0, 0, 1e-5);
  near("rectifier at 0.25 ms", at(h, "out", 0.25e-3), Vs - vd, 2e-3);
}
// ------------------------------------------------------------------ RC, RL, RLC transients
{
  const r = sim("rc\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 5m");
  for (const t of [0.1e-3, 1e-3, 2e-3, 5e-3]) near("RC step at " + t * 1e3 + " ms", at(r, "out", t), 1 - Math.exp(-(t - 0.5e-9) / 1e-3), 1e-3);
  const be = sim("rc\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nR1 in out 1k\nC1 out 0 1u\n.tran 10u 5m", {type: "tran", tstep: 10e-6, tstop: 5e-3, method: "be"});
  near("RC step backward Euler 1 ms", S.at(be.x, v(be, "out"), 1e-3), 1 - Math.exp(-1), 5e-3);
  const l = sim("rl\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nR1 in a 100\nL1 a 0 10m\n.tran 1u 500u");
  near("RL step current at τ", S.at(l.x, v(l, "i(L1)"), 1e-4), 0.01 * (1 - Math.exp(-1)), 1e-3);
  // Series RLC, underdamped: R = 20, L = 1 mH, C = 1 µF; capacitor voltage after a 1 V step.
  const R = 20, L = 1e-3, C = 1e-6, a = R / (2 * L), w0 = 1 / Math.sqrt(L * C), wd = Math.sqrt(w0 * w0 - a * a);
  const vc = t => 1 - Math.exp(-a * t) * (Math.cos(wd * t) + a / wd * Math.sin(wd * t));
  const q = sim("rlc\nV1 in 0 PULSE(0 1 0 1n 1n 1 2)\nR1 in a 20\nL1 a b 1m\nC1 b 0 1u\n.tran 1u 1m");
  for (const t of [0.1e-3, 0.3e-3, 0.6e-3]) near("RLC step at " + t * 1e3 + " ms", at(q, "b", t), vc(t), 3e-3);
  // Lossless LC from an initial condition (UIC): period 2π√(LC).
  const lc = sim("lc\nL1 a 0 1m\nC1 a 0 1u IC=1\n.tran 0.5u 0.2m uic");
  near("LC (UIC) at T/2", at(lc, "a", Math.PI * Math.sqrt(1e-9)), -1, 2e-3);
  // PWL ramp into an RC: v = k(t − τ(1 − e^(−t/τ))).
  const p = sim("pwl\nV1 in 0 PWL(0 0 1m 1)\nR1 in out 1k\nC1 out 0 0.1u\n.tran 5u 1m");
  near("PWL ramp through RC", at(p, "out", 1e-3), 1e3 * (1e-3 - 1e-4 * (1 - Math.exp(-10))), 1e-3);
  // RC low-pass with a sinusoid, steady state: amplitude 1/√(1+(ωRC)²).
  const s = sim("sin\nV1 in 0 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 159.155n\n.tran 2u 10m");
  const tail = v(s, "out").filter((_, i) => s.x[i] > 8e-3);
  near("RC sine steady-state amplitude", Math.max(...tail), 1 / Math.SQRT2, 2e-3);
}
// ------------------------------------------------------------------ AC
{
  const f0 = 1 / (2 * Math.PI * Math.sqrt(1e-3 * 1e-6));
  const r = sim("rlc\nV1 in 0 AC 1\nR1 in a 10\nL1 a b 1m\nC1 b 0 1u\n.ac lin 1 " + f0 + " " + f0);
  near("RLC resonance |Vc| = Q", S.mag(S.signal(r, "b"))[0], Math.sqrt(1e-3 / 1e-6) / 10, 1e-6);
  near("RLC resonance phase", S.phase(S.signal(r, "b"))[0], -90, 1e-6);
  const sweep = sim("rlc\nV1 in 0 AC 1\nR1 in a 10\nL1 a b 1m\nC1 b 0 1u\n.ac dec 200 1k 30k");
  const vr = S.mag(S.signal(sweep, "v(in,a)"));
  near("RLC series peak frequency", sweep.x[vr.indexOf(Math.max(...vr))], f0, 6e-3);
  assert.equal(sweep.x[0], 1e3); assert.ok(Math.abs(sweep.x[sweep.x.length - 1] - 30e3) < 1e-6);
  const rc = sim("rc\nV1 in 0 AC 1\nR1 in out 1k\nC1 out 0 1u\n.ac lin 1 159.1549 159.1549");
  near("RC −3 dB point", S.db(S.signal(rc, "out"))[0], -10 * Math.log10(2), 1e-4);
  near("RC phase at fc", S.phase(S.signal(rc, "out"))[0], -45, 1e-4);
  // VCVS op-amp integrator-free check: inverting amp gain is flat.
  const oa = sim("inv\nV1 in 0 AC 1\nR1 in m 10k\nR2 m out 47k\nE1 out 0 0 m 100k\n.ac dec 5 10 100k");
  near("VCVS inverting gain in AC", S.mag(S.signal(oa, "out"))[3], 4.7 / (1 + 5.7 / 1e5), 1e-6);
}
// ------------------------------------------------------------------ BJT (Ebers–Moll)
{
  const IS = 1e-14, BF = 100, RC = 4.7e3, VBE = 0.65;
  const deck = "ce\nVCC vcc 0 12\nVB b 0 DC 0.65 AC 1\nRC vcc c 4.7k\nQ1 c b 0 qn\n.model qn NPN(IS=1e-14 BF=100 BR=1)\n";
  // Ebers–Moll transport model with Vbc = 0.65 − 12 V (Vbc term ≈ −1):
  //   Ic = IS(e^(Vbe/VT) − e^(Vbc/VT)) − (IS/BR)(e^(Vbc/VT) − 1),  Ib = (IS/BF)(e^(Vbe/VT) − 1) + (IS/BR)(e^(Vbc/VT) − 1)
  const eb = Math.exp(VBE / VT), ec = Math.exp((VBE - 12) / VT);
  const op = sim(deck + ".op");
  near("BJT collector current", op.devices.Q1.ic, IS * (eb - ec) - IS * (ec - 1), 1e-6);
  near("BJT base current", op.devices.Q1.ib, IS / BF * (eb - 1) + IS * (ec - 1), 1e-6);
  const g = sim(deck + ".ac lin 1 1k 1k");
  near("common-emitter gain −gm·RC", S.signal(g, "c").re[0], -(IS * Math.exp(VBE / VT) / VT) * RC, 1e-5);
  // Degenerated CE with a resistive base divider; gain from the small-signal hybrid-π formula
  // evaluated at the simulated operating point.
  const d2 = "ce2\nVCC vcc 0 12\nVS s 0 DC 0 AC 1\nCS s b 100\nR1 vcc b 47k\nR2 b 0 10k\nRC vcc c 2.2k\nRE e 0 470\nQ1 c b e qn\n.model qn NPN(IS=1e-14 BF=100 BR=1)\n";
  const o2 = sim(d2 + ".op"), Ic = o2.devices.Q1.ic, gm = Ic / VT, rpi = BF / gm;
  const a2 = sim(d2 + ".ac lin 1 1k 1k");
  near("degenerated CE gain (hybrid-π)", S.signal(a2, "c").re[0], -BF * 2.2e3 / (rpi + (BF + 1) * 470), 2e-3);
  assert.ok(o2.devices.Q1.vce > 1, "biased in the active region");
  // PNP mirror image.
  const p = sim("pnp\nVEE e 0 5\nVB b 0 4.35\nRC c 0 1k\nQ1 c b e qp\n.model qp PNP(IS=1e-14 BF=100 BR=1)\n.op");
  near("PNP collector current", -p.devices.Q1.ic, IS * Math.exp(0.65 / VT) + IS, 1e-6);
  // Early effect: Ic grows by (1 − Vbc/VAF).
  const e = sim("early\nVC c 0 5\nVB b 0 0.65\nQ1 c b 0 qn\n.model qn NPN(IS=1e-14 BF=100 VAF=50)\n.op");
  near("BJT Early effect", e.devices.Q1.ic, (IS * (Math.exp(0.65 / VT) - Math.exp(-4.35 / VT))) * (1 + 4.35 / 50) - IS * (Math.exp(-4.35 / VT) - 1), 1e-6);
}
// ------------------------------------------------------------------ MOSFET level 1
{
  const r = sim("cs\nVDD vdd 0 10\nVG g 0 3\nRD vdd d 1k\nM1 d g 0 0 nm W=10u L=1u\n.model nm NMOS(VTO=1 KP=100u LAMBDA=0.01)\n.op");
  const vds = solve(x => x - (10 - 1e3 * 0.5e-3 * 4 * (1 + 0.01 * x)), 0, 10);
  near("NMOS saturation Vds", r.nodes.d, vds, 1e-6); assert.equal(r.devices.M1.region, "saturation");
  const t = sim("triode\nVDD vdd 0 5\nVG g 0 5\nRD vdd d 10k\nM1 d g 0 0 nm W=10u L=1u\n.model nm NMOS(VTO=1 KP=100u)\n.op");
  const vt = solve(x => 1e-3 * (4 * x - x * x / 2) - (5 - x) / 1e4, 0, 4);
  near("NMOS triode Vds", t.nodes.d, vt, 1e-6); assert.equal(t.devices.M1.region, "triode");
  const p = sim("pmos\nVDD vdd 0 10\nVG g 0 7\nRD d 0 1k\nM1 d g vdd vdd pm W=10u L=1u\n.model pm PMOS(VTO=-1 KP=100u)\n.op");
  near("PMOS saturation drain", p.nodes.d, 2, 1e-6);
  const g = sim("csac\nVDD vdd 0 10\nVG g 0 DC 3 AC 1\nRD vdd d 1k\nM1 d g 0 0 nm W=10u L=1u\n.model nm NMOS(VTO=1 KP=100u)\n.ac lin 1 1k 1k");
  near("common-source gain −gm·RD", S.signal(g, "d").re[0], -(1e-3 * 2) * 1e3, 1e-6);
  // CMOS inverter transfer: output is VDD/2 when both devices match at the midpoint.
  const inv = sim("inv\nVDD vdd 0 5\nVIN in 0 0\nMP out in vdd vdd pm W=10u L=1u\nMN out in 0 0 nm W=10u L=1u\n.model nm NMOS(VTO=1 KP=100u LAMBDA=0.02)\n.model pm PMOS(VTO=-1 KP=100u LAMBDA=0.02)\n.dc VIN 0 5 0.1");
  near("CMOS inverter at Vin=0", at(inv, "out", 0), 5, 1e-6); near("CMOS inverter at Vin=5", at(inv, "out", 5), 0, 0, 1e-6);
  near("CMOS inverter midpoint", at(inv, "out", 2.5), 2.5, 1e-3);
}

// ------------------------------------------------------------------ schematic → netlist
{
  const pin = (number, name, net) => ({number: String(number), name, net});
  const comp = (id, ref, value, pins) => ({id, ref, value, definition: "", pins});
  const netlist = {components: [
    comp("v", "V1", "", [pin(1, "+", "IN"), pin(2, "−", "GND")]),
    comp("r", "R1", "4k7", [pin(1, "1", "IN"), pin(2, "2", "MID")]),
    comp("c", "C1", "100nF", [pin(1, "1", "MID"), pin(2, "2", "GND")]),
    comp("rm", "R2", "1M", [pin(1, "1", "MID"), pin(2, "2", "GND")]),
    comp("d", "D1", "1N4148", [pin(1, "K", "OUT"), pin(2, "A", "MID")]),
    comp("q", "Q1", "2N3906", [pin(1, "E", "IN"), pin(2, "B", "MID"), pin(3, "C", "OUT")]),
    comp("m", "M1", "BSS138", [pin(1, "G", "MID"), pin(2, "S", "GND"), pin(3, "D", "OUT")]),
    comp("u", "U1", "LM358", [pin(1, "OUT", "OUT"), pin(2, "−IN", "OUT"), pin(3, "+IN", "MID"), pin(4, "V−", "GND"), pin(8, "V+", "IN")]),
    comp("j", "J1", "Header", [pin(1, "1", "IN"), pin(2, "2", "GND")]),
    comp("dnp", "R9", "10k", [pin(1, "1", "IN"), pin(2, "2", "OUT")]),
    comp("x", "X1", "", [pin(1, "1", "OUT"), pin(2, "2", "My Net(1)")]),
    comp("led", "LED1", "LED", [pin(1, "A", "OUT"), pin(2, "K", "GND")]),
    comp("tpl", "R5", "1k", [pin(1, "1", "OUT"), pin(2, "2", "GND")])
  ]};
  const parts = [
    {id: "v", ref: "V1", parameters: {DC: "5", AC: "1", "AC Phase": "0", PULSE: "0 5 0 1u 1u 1m 2m"}},
    {id: "u", ref: "U1", parameters: {Spice: "OPAMP"}},
    {id: "x", ref: "X1", parameters: {"Spice.Lib": ".subckt LOAD a b|R1 a b 1k|.ends", Spice: "LOAD"}},
    {id: "tpl", ref: "R5", parameters: {Spice: "%ref %2 %1 2k"}},
    {id: "dnp", ref: "R9", parameters: {}}
  ];
  const out = X.exportNetlist({title: "T", netlist, parts, defs: [], fitted: {R9: false}, variant: "Lite", analysis: {type: "tran", tstep: 1e-6, tstop: 1e-3}, probes: ["OUT"]});
  const line = ref => out.elements.find(e => e.ref === ref)?.line;
  assert.equal(line("V1"), "V1 IN 0 DC 5 AC 1 0 PULSE(0 5 0 1u 1u 1m 2m)");
  assert.equal(line("R1"), "R1 IN MID 4.7k"); assert.equal(line("C1"), "C1 MID 0 100n"); assert.equal(line("R2"), "R2 MID 0 1meg", "a schematic 1M resistor is 1 megohm");
  assert.equal(line("D1"), "D1 MID OUT 1N4148", "anode first by pin name");
  assert.equal(line("Q1"), "Q1 OUT MID IN 2N3906", "collector, base, emitter");
  assert.equal(line("M1"), "M1 OUT MID 0 0 BSS138", "drain, gate, source, bulk = source");
  assert.equal(line("U1"), "XU1 MID OUT OUT OPAMP", "op-amp roles from pin names (Unicode minus)");
  assert.equal(line("X1"), "X1 OUT My_Net_1_ LOAD");
  assert.equal(line("LED1"), "DLED1 OUT 0 LED");
  assert.equal(line("R5"), "R5 0 OUT 2k", "line template");
  assert.ok(!line("R9") && out.omitted.some(o => o.ref === "R9" && /not fitted in Lite/.test(o.reason)), "not-fitted parts are omitted");
  assert.ok(out.omitted.some(o => o.ref === "J1" && o.rung === "Excluded" && /connector/.test(o.reason)), "a connector is Excluded with its reason");
  // Every part has a rung in the coverage report; built-in part-number models are Generic, labelled.
  const rung = ref => out.coverage.rows.find(r => r.ref === ref);
  assert.deepEqual(["V1", "R1", "D1", "Q1", "M1", "U1", "X1", "R9", "J1", "R5"].map(r => rung(r).rung), ["Primitive", "Primitive", "Generic", "Generic", "Generic", "Generic", "Vendor", "Excluded", "Excluded", "Vendor"]);
  assert.match(rung("D1").model, /^1N4148 \(Generic \(Waffle approximation\)\)$/);
  assert.match(out.text, /^\* Generic \(Waffle approximation\): rounded typical values, not the vendor's model/m);
  assert.match(out.text, /^\* Coverage: 11 of 13 parts simulate · Vendor 2 · Generic 5 · Primitive 4 · Excluded 2$/m);
  assert.match(out.text, /^\* J1 omitted \(Excluded\): connector: nothing to simulate$/m);
  for (const [k, i] of Object.entries(X.MODEL_INFO)) assert.ok(i.rung === "Generic" && i.src === "default" && /Waffle approximation/.test(i.label), k + " is labelled a Waffle approximation");
  assert.match(out.text, /^\.model 2N3906 PNP\(/m); assert.match(out.text, /^\.subckt OPAMP inp inn out$/m); assert.match(out.text, /^\.subckt LOAD a b$/m);
  assert.match(out.text, /^\.tran 0\.000001 0\.001$/m); assert.match(out.text, /^\.probe v\(OUT\)$/m); assert.match(out.text, /\n\.end\n$/);
  assert.match(out.text, /Assembly variant: Lite/);
  assert.equal(out.nodeMap.My_Net_1_, "My Net(1)");
  // The exported netlist runs.
  const r = S.simulate(out.text, {type: "op"});
  assert.ok(Number.isFinite(r.nodes.OUT));
  // Values.
  for (const [a, b, l] of [["10 kΩ", "10k", "R"], ["2u2", "2.2u", "C"], ["4.7µF", "4.7u", "C"], ["1R5", "1.5", "R"], ["10mH", "10m", "L"], ["1.5M", "1.5meg", "R"], ["100", "100", "R"], ["abc", null, "R"]]) assert.equal(X.cleanValue(a, l), b, a);
  // Pins that cannot be told apart, a bad Spice.Pins, a source without a value.
  const bad = X.exportNetlist({netlist: {components: [comp("q", "Q2", "", [pin(1, "1", "A"), pin(2, "2", "B")]), comp("s", "V2", "", [pin(1, "1", "A"), pin(2, "2", "GND")]),
    comp("p", "Q3", "", [pin(1, "C", "A"), pin(2, "B", "B"), pin(3, "E", "GND")])]}, parts: [{id: "p", ref: "Q3", parameters: {"Spice.Pins": "C B X"}}]});
  assert.ok(bad.omitted.some(o => o.ref === "Q2" && /which pin/.test(o.reason)));
  assert.ok(bad.omitted.some(o => o.ref === "V2" && /no source value/.test(o.reason)));
  assert.ok(bad.warnings.some(w => /Spice\.Pins/.test(w)));
  assert.match(bad.elements.find(e => e.ref === "Q3").line, /^Q3 A B 0 NPN$/, "falls back to pin names and the generic model");
  const roles = [{number: "1", name: "1", fn: "K", net: "GND"}, {number: "2", name: "2", fn: "A", net: "BIAS"}];
  const mapped = X.exportNetlist({netlist: {components: [comp("d", "D4", "", roles), comp("x", "U3", "", roles)]}, parts: [
    {id: "d", ref: "D4"}, {id: "x", ref: "U3", parameters: {Spice: "DUT", "Spice.Lib": ".subckt DUT A K\nRpass A K 1k\n.ends DUT"}}]});
  assert.match(mapped.text, /^D4 BIAS 0 D$/m, "pin functions on an ordinary symbol determine diode polarity");
  assert.match(mapped.text, /^XU3 BIAS 0 DUT$/m, "matching subcircuit port functions precede the numeric pin order");
}

// ------------------------------------------------------------------ the extension in the host
const done = (async () => {
  require(appFile("model.js")); require(appFile("parts.js")); require(appFile("spatial.js")); require(appFile("altium-rules.js"));
  require(appFile("rules.js")); require(appFile("connectivity.js")); require(appFile("keymap.js")); require(appFile("proposal.js"));
  require(appFile("variants.js")); require(appFile("bom.js"));
  require(appFile("atrium-api.js")); require(appFile("extension-host-worker.js")); require(appFile("extensions.js"));
  require(appFile("extensions/manifests.js"));
  const E = AtriumExtensions;
  const {realmWorker} = require("../extensions/extension-realm.js");
  // The sample design as an RC low-pass (R1 10 kΩ, C1 10 nF) driving a follower (U1) and R2 to VOUT.
  let project = AtriumParts.example();
  const sheet = project.documents.find(d => d.kind === "schematic"), part = r => sheet.items.find(i => i.ref === r);
  part("J1").parameters = {"Spice.Prefix": "V", "Spice.Pins": "2 3", DC: "0", AC: "1", PULSE: "0 1 0 1n 1n 1 2"};
  part("U1").parameters = {Spice: "OPAMP"};
  let current = project.documents.find(d => d.kind === "pcb").id, selection = new Set(); // a board is active: parts are read per sheet
  const exported = [], renderers = new Set(), reviews = [];
  let revision = 0, accept = true;
  globalThis.AtriumNavHost = {addRenderer(f) { renderers.add(f); return () => renderers.delete(f); }, invalidate() {}};
  const host = {project: () => project, documentId: () => current, revision: () => revision, selection: () => selection,
    select(ids) { selection = new Set(ids); E.notify("selectionChanged"); }, edit(fn) { fn(); revision++; E.notify("documentChanged"); },
    info() {}, activate(id) { current = id; }, locate() {}, exportFile: (name, text) => { exported.push({name, text}); return true; }};
  E.attach(host, {createWorker: realmWorker, consent: r => { if (r.kind === "review") { reviews.push(r); return accept && r.rows.map(x => x.index); } return false; }});
  const ID = "waffle.spice", PANEL = "waffle.spice";
  const info = E.list().find(e => e.id === ID);
  assert.ok(info && info.origin === "builtin" && info.enabled && info.status === "inactive", "ships as a built-in, inactive until used");
  assert.deepEqual(E.permissions(ID).live, {"read:project": true, "outputs:write": true, "ui:panel": true, "ui:command": true, "ui:decorations": true, "propose:edits": true, "run:external": true}, "reviewed project edits and declared external tools");
  assert.deepEqual(E.permissions(ID).network, []);

  const tau = 10e3 * 10e-9, fc = 1 / (2 * Math.PI * tau);
  // Programmatic simulation of the design.
  const op = await E.execute("spice.simulate", {analysis: "op"});
  assert.ok(Math.abs(op.nodes.VIN) < 1e-9 && Math.abs(op.nodes.VOUT) < 1e-6, JSON.stringify(op.nodes));
  assert.match(op.netlist, /^VJ1 VIN 0 DC 0 AC 1 PULSE\(0 1 0 1n 1n 1 2\)$/m);
  assert.match(op.netlist, /^XU1 FILTER BUF BUF OPAMP$/m);
  assert.match(op.netlist, /^\* J2 omitted \(Excluded\): connector: nothing to simulate$/m);
  const tr = await E.execute("spice.simulate", {analysis: "tran", tstep: "2u", tstop: "500u", probes: ["FILTER", "VOUT"]});
  assert.deepEqual(Object.keys(tr.signals).sort(), ["FILTER", "VOUT"]);
  near("design RC (R1·C1) at τ", S.at(tr.x, tr.signals.FILTER, tau), 1 - Math.exp(-1), 2e-3);
  near("design follower output at τ", S.at(tr.x, tr.signals.VOUT, tau), 1 - Math.exp(-1), 3e-3);
  const ac = await E.execute("spice.simulate", {analysis: {type: "ac", sweep: "lin", points: 1, fstart: fc, fstop: fc}, probes: ["VOUT"]});
  near("design −3 dB at 1/(2πRC)", ac.signals.VOUT.db[0], -10 * Math.log10(2), 1e-3);
  // Variant: C1 not fitted in the active variant, so the filter is flat.
  const c1 = part("C1");
  project.variants = [{id: "v1", name: "No filter", parts: {[c1.link || c1.id]: {fitted: false}}}]; project.activeVariant = "v1";
  const flat = await E.execute("spice.simulate", {analysis: {type: "ac", sweep: "lin", points: 1, fstart: fc, fstop: fc}, probes: ["VOUT"]});
  assert.match(flat.netlist, /^\* C1 omitted \(Excluded\): not fitted in No filter$/m);
  assert.ok(Math.abs(flat.signals.VOUT.db[0]) < 1e-3, "no filter in this variant");
  delete project.variants; delete project.activeVariant;

  // The panel.
  await E.execute("spice.show");
  assert.equal(E.list().find(e => e.id === ID).status, "active");
  const walk = (v, f) => { if (Array.isArray(v)) v.forEach(x => walk(x, f)); else if (v && typeof v === "object") { f(v); walk(v.children, f); } };
  const find = type => { const out = []; walk(E._panel(ID, PANEL), v => { if (v.type === type) out.push(v); }); return out; };
  const texts = () => { const out = []; walk(E._panel(ID, PANEL), v => { if (v.text) out.push(v.text); for (const i of v.items || []) if (i.label) out.push(i.label); }); return out.join("\n"); };
  assert.match(texts(), /Variant: base design · 7 simulated parts|Variant: base design · \d+ simulated parts/);
  current = sheet.id;
  // Probe a wire on the sheet: its net becomes a probe.
  const conn = AtriumAPI.headless(project, {extension: {id: "t", permissions: AtriumAPI.SCRIPT_PERMISSIONS}}).api.query.connectivity({doc: sheet.id});
  const wire = Object.entries(conn.byWire).find(([, n]) => n === "FILTER")[0];
  host.select([wire, part("R2").id]);
  const nets = await E.execute("spice.probeSelection");
  assert.deepEqual(nets.sort(), ["BUF", "FILTER", "VOUT"]);
  await E.execute("spice.removeProbe", "BUF");
  await E.execute("spice.analysis", "tran");
  await E.execute("spice.run", {tstop: "500u", tstep: "2u", method: "trap"});
  let plots = find("plot");
  assert.equal(plots.length, 1);
  assert.deepEqual(plots[0].series.map(s => s.name).sort(), ["FILTER", "VOUT", "cursor A", "cursor B"]);
  assert.equal(plots[0].xLabel, "Time (µs)");
  assert.ok(plots[0].series.every(s => s.x.length <= 1200), "decimated");
  const cursorRows = () => find("table").find(t => t.columns[0].title === "Cursor").rows;
  await E.execute("spice.cursors", {a: "100", b: "300", lo: "0", hi: "500"});
  const rowsC = cursorRows();
  assert.equal(rowsC[0].a, "100 µs"); assert.equal(rowsC[0].d, "200 µs");
  near("cursor A reads V(FILTER) at τ", S.num(rowsC.find(r => r.sig === "FILTER").a.replace(/\s/g, "").replace(/V$/, "")), 1 - Math.exp(-1), 3e-3);
  await E.execute("spice.view", "in");
  plots = find("plot");
  const xs = plots[0].series[0].x;
  assert.ok(xs[0] >= 120 && xs[0] <= 126 && xs[xs.length - 1] >= 374 && xs[xs.length - 1] <= 380, "zoomed to the middle half: " + xs[0] + "…" + xs[xs.length - 1]);
  await E.execute("spice.view", "cursors");
  assert.ok(find("plot")[0].series[0].x[0] >= 95, "zoomed to the cursors");
  await E.execute("spice.view", "fit");
  assert.ok(find("plot")[0].series[0].x[0] <= 0.001);
  // AC: magnitude and phase plots on a log axis.
  await E.execute("spice.analysis", "ac");
  await E.execute("spice.run", {sweep: "dec", points: 20, fstart: "10", fstop: "1meg"});
  plots = find("plot");
  assert.deepEqual(plots.map(p => p.title), ["Magnitude", "Phase"]); assert.ok(plots.every(p => p.xLog));
  // Operating point and DC sweep.
  await E.execute("spice.analysis", "op");
  await E.execute("spice.run");
  assert.ok(!find("table").some(t => t.columns[1]?.title === "Voltage"), "voltages appear on the schematic");
  const ink = [];
  const ctx = new Proxy({}, {get: (o,k) => k === "fillText" ? (...a) => ink.push(a) : () => {}});
  for (const renderer of renderers) renderer(sheet)?.overlay(ctx, {scale: 4, dpr: 1, width: 3000, height: 3000, worldToScreen: p => [p[0]*4+500,p[1]*4+500]});
  assert.ok(ink.some(([v]) => /^VIN\s+0 V$/.test(v)), "operating point voltage drawn at a pin");
  await E.execute("spice.analysis", "dc");
  await E.execute("spice.run", {source: "VJ1", start: "0", stop: "2", step: "0.5"});
  assert.equal(find("plot")[0].title, "DC sweep");
  near("DC sweep VOUT at 0.5 V", S.num(cursorRows().find(r => r.sig === "VOUT").a.replace(/\s/g, "").replace(/V$/, "")), 0.5, 1e-3);
  // Netlist preview and exports.
  await E.execute("spice.toggleNetlist");
  assert.ok(find("code").some(c => /^VJ1 VIN 0/m.test(c.text)));
  await E.execute("spice.exportNetlist");
  assert.equal(exported.at(-1).name, "Sensor interface.cir");
  assert.match(exported.at(-1).text, /\.dc VJ1 0 2 0\.5/);
  await E.execute("spice.exportCsv");
  assert.match(exported.at(-1).text, /^VJ1,(FILTER,VOUT|VOUT,FILTER)\n0,0,0\n/);
  // An error shows in the panel, not as a crash.
  await E.execute("spice.analysis", "tran");
  await E.execute("spice.run", {tstop: "abc"});
  assert.match(texts(), /Stop time "abc" is not a number/);
  // UI node budget: every view stays well inside 20 000 nodes and 64 columns.
  let nodes = 0; walk(E._panel(ID, PANEL), v => { nodes += 1 + (v.rows?.length || 0) * ((v.columns?.length || 0) + 1) + (v.items?.length || 0) + (v.fields?.length || 0) * 2; if (v.columns) assert.ok(v.columns.length <= 64); });
  assert.ok(nodes < 2000, nodes + " nodes");

  // Coverage report, one-click "Use generic", the model wizard, exclude with a reason (P1–P3).
  const cov0 = await E.execute("spice.coverage");
  assert.equal(cov0.total, 7); assert.equal(cov0.rows.find(r => r.ref === "J2").rung, "Excluded");
  assert.equal(cov0.rows.find(r => r.ref === "U1").rung, "Generic", "Spice=OPAMP is the built-in generic op-amp");
  part("U1").parameters = {};
  let cov = await E.execute("spice.coverage"), u1 = () => cov.rows.find(r => r.ref === "U1");
  assert.equal(u1().rung, "Missing"); assert.equal(u1().suggest, "opamp", "inferred from the symbol's pin names");
  assert.ok(find("table").some(t => t.rowCommand === "spice.coverageRow" && t.rows.some(r => r.ref === "U1" && r.action === "Use generic opamp")), "the coverage row offers Use generic");
  await E.execute("spice.coverageRow", {ref: "U1"}); // one click
  cov = await E.execute("spice.coverage");
  assert.equal(u1().rung, "Generic"); assert.equal(u1().template, "opamp@1"); assert.ok(u1().defaults >= 3, "the defaults are counted");
  let sim = await E.execute("spice.simulate", {analysis: "op", netlist: "* t\nV1 a 0 1\nR1 a 0 1k\n.op"});
  assert.ok(sim.nodes.a === 1);
  // The wizard: values with their sources and pages, a bench preview, then save. Every required
  // field from the datasheet or the user and a passed bench make the model Fitted.
  await E.execute("spice.modelWizard", "U1");
  const wiz = {f_GBW: "2 MHz", s_GBW: "datasheet", p_GBW: "5", f_Rails: "RRO", s_Rails: "user", f_Supply: "±5 V", s_Supply: "datasheet", p_Supply: "1", f_SR: "1.5 V/µs", s_SR: "datasheet", p_SR: "5"};
  const pre = await E.execute("spice.wizardPreview", wiz);
  assert.ok(pre.passed, JSON.stringify(pre.measures));
  assert.ok(pre.measures.some(m => m.key === "GBW" && m.ok) && pre.measures.some(m => m.key === "SR" && m.ok));
  assert.ok(find("table").some(t => t.rows.some(r => r.k === "Gain-bandwidth" && r.src === "[datasheet p.5]")), "source chips"); assert.match(texts(), /Not modelled: THD/);
  assert.ok(find("plot").length >= 2, "bench plots");
  const saved = await E.execute("spice.wizardSave");
  assert.equal(saved.rung, "Fitted");
  assert.equal(part("U1").sim.params.GBW.v, "2 MHz");
  assert.ok(reviews.length && reviews.every(r => r.kind === "review"), "model changes use host review");
  assert.ok(find("chips").some(g => g.items.some(c => c.text === "Fitted 1")));
  cov = await E.execute("spice.coverage");
  assert.equal(u1().rung, "Fitted");
  const netText = (await E.execute("spice.simulate", {analysis: "op", netlist: "* t\nV1 a 0 1\nR1 a 0 1k\n.op"})) && (await E.execute("spice.exportNetlist"), exported.at(-1).text);
  assert.match(netText, /^\*   GBW = 2 MHz \(datasheet p\.5\)$/m); assert.match(netText, /^XU1 FILTER BUF BUF VDD 0 ATR_OPAMP_\w+$/m);
  // Exclude with a reason, then include again.
  await E.execute("spice.modelWizard", "C2");
  await E.execute("spice.exclude", {reason: "decoupling only"});
  cov = await E.execute("spice.coverage");
  assert.equal(cov.rows.find(r => r.ref === "C2").rung, "Excluded"); assert.equal(cov.rows.find(r => r.ref === "C2").reason, "decoupling only");
  await E.execute("spice.coverageRow", {ref: "C2"});
  cov = await E.execute("spice.coverage");
  assert.equal(cov.rows.find(r => r.ref === "C2").rung, "Primitive");
  await E.execute("spice.clearModel", "U1");
  cov = await E.execute("spice.coverage");
  assert.equal(u1().rung, "Missing");
  assert.deepEqual(await E.execute("spice.useGenericAll"), ["U1"]);
  nodes = 0; walk(E._panel(ID, PANEL), v => { nodes += 1 + (v.rows?.length || 0) * ((v.columns?.length || 0) + 1) + (v.items?.length || 0) + (v.fields?.length || 0) * 2; });
  assert.ok(nodes < 2000, nodes + " nodes with the coverage report");
  void sim;

  // A real placeholder (app/library/placeholder-parts.js through generic-parts.js, not a synthetic def): the
  // extension reads its pin functions from the JSON netlist and orders the op-amp template's
  // nodes by them; the netlist names the placeholder as the model's source.
  for (const m of ["component-families", "library-store", "library-panel", "footprint-wizard", "symbol-wizard", "generic-parts", "placeholder-parts"]) require(appFile(m + ".js"));
  {
    const {def, part: ph} = AtriumGenericParts.place(project, sheet, [203.2, 152.4], {family: "opamp", params: {units: 1}, package: "SOT-23-5", designator: "U9"});
    assert.equal(def.generic.role, "placeholder");
    const fnPin = fn => def.symbol.pins.find(q => q.fn === fn);
    const at = fn => Atrium.pins(ph, def, "schematic").find(q => String(q.number) === String(fnPin(fn).number)).at;
    const label = (p, text) => sheet.items.push({id: Atrium.id(), kind: "wire", points: [p, [p[0] - 5.08, p[1]]]}, {id: Atrium.id(), kind: "netlabel", text, x: p[0] - 5.08, y: p[1]});
    label(at("IN+"), "PH_IN"); label(at("IN-"), "PH_OUT"); label(at("OUT"), "PH_OUT"); label(at("V+"), "PH_VCC"); label(at("V-"), "GND");
    exported.length = 0;
    await E.execute("spice.exportNetlist");
    const text = exported.at(-1).text;
    assert.match(text, /^XU9 PH_IN PH_OUT PH_OUT PH_VCC 0 ATR_OPAMP_\w+$/m, "node order from the real placeholder's pin functions");
    assert.match(text, /^\* U9: \w+ opamp\b.*from placeholder$/m);
    const row = (await E.execute("spice.coverage")).rows.find(r => r.ref === "U9");
    assert.equal(row.placeholder, "opamp");
    sheet.items = sheet.items.filter(i => i !== ph && !(i.kind === "netlabel" && /^PH_/.test(i.text)));
  }
  await E.execute("spice.analysis", "op");
  accept = false;
  assert.equal((await E.execute("spice.saveBench", {name:"Declined trace", engine:"LTspice"})).declined, true);
  assert.equal(project.simulation?.benches, undefined);
  accept = true;
  const savedBench = await E.execute("spice.saveBench", {name:"Input bias", engine:"ngspice"});
  assert.equal(savedBench.applied, 1);
  const b1 = project.simulation.benches[0];
  assert.equal(b1.engine, "ngspice"); assert.equal(b1.analyses[0].type, "op");
  await E.execute("spice.selectBench");
  await E.execute("spice.analysis", "tran");
  await E.execute("spice.saveBench", {name:"Output step", engine:"Built-in", tstep:"1u", tstop:"200u"});
  assert.equal(project.simulation.benches.length, 2);
  await E.execute("spice.selectBench", b1.id);
  const fields = find("form").find(f => f.secondarySubmit?.command === "spice.saveBench").fields;
  assert.equal(fields.find(f => f.key === "engine").value, "ngspice");
  assert.equal(fields.find(f => f.key === "name").value, "Input bias");
  assert.deepEqual(project.simulation.benches[0], b1);

  // Explicit vendor maps identify terminals even when the schematic gives them the same name and net.
  try {
    const u = part("U1"), def = project.library.find(d => d.id === u.def);
    host.edit(() => {
      delete u.sim;
      part("J1").parameters.DC = "5";
      def.symbol.pins.find(pin => pin.number === "4").name = "OUT";
      u.parameters = {Spice: "BUFFER", "Spice.Lib": ".subckt BUFFER OUT PLUS MINUS|Ebuf OUT 0 PLUS MINUS 2|.ends BUFFER",
        "Spice.Pins": "1 3 4"};
    });
    const pins = () => AtriumAPI.headless(project, {extension: {id: "test", permissions: AtriumAPI.SCRIPT_PERMISSIONS}}).api
      .project.netlist({format: "json"}).components.find(c => c.ref === "U1").pins;
    assert.deepEqual(pins().filter(pin => pin.name === "OUT").map(pin => [pin.number, pin.net]), [["1", "BUF"], ["4", "BUF"]]);
    await E.execute("spice.analysis", "op");
    const coverage = async () => (await E.execute("spice.coverage")).rows.find(r => r.ref === "U1");
    const row = await coverage();
    assert.equal(row.rung, "Vendor");
    assert.equal(row.pins, "3/5");
    const tied = await E.execute("spice.simulate", {analysis: "op"});
    assert.match(tied.netlist, /^XU1 BUF FILTER BUF BUFFER$/m);
    near("vendor buffer with two tied pins", tied.nodes.BUF, 10 / 3, 1e-6);

    // Imported or multi-gate symbols can expose the same terminal as multiple pin records.
    host.edit(() => { def.symbol.pins.push({...def.symbol.pins.find(pin => pin.number === "1"), name: "OUT_ALIAS"}); });
    assert.deepEqual(pins().filter(pin => pin.number === "1").map(pin => [pin.name, pin.net]), [["OUT", "BUF"], ["OUT_ALIAS", "BUF"]]);
    for (const pinOrder of ["1 1 4", "1 OUT 4", "1 OUT_ALIAS 4"]) {
      host.edit(() => { u.parameters["Spice.Pins"] = pinOrder; });
      const missing = await coverage();
      assert.equal(missing.rung, "Missing", "repeated terminal in Spice.Pins: " + pinOrder);
      assert.equal(missing.pins, "0/6");
      assert.match(missing.reason, /^Spice\.Pins repeats pin 1\./);
      const panelRow = find("table").find(t => t.rowCommand === "spice.coverageRow").rows.find(r => r.ref === "U1");
      assert.equal(panelRow.model, missing.reason);
      assert.equal(panelRow.rung.tone, "warning");
      assert.equal((await E.execute("spice.run", {engine: "builtin"})).analysis, "op");
      const solved = await E.execute("spice.simulate", {analysis: "op"});
      assert.ok(!/^XU1 /m.test(solved.netlist));
      assert.match(solved.netlist, /^\* U1 omitted \(Missing\): Spice\.Pins repeats pin 1\./m);
      near("independent filter input after omission " + pinOrder, solved.nodes.FILTER, 5, 1e-6);
      await E.execute("spice.exportNetlist");
      assert.equal(exported.at(-1).text, solved.netlist);
    }
  } finally { E.shutdown(); }

  console.log("\nSolver accuracy (" + rows.length + " checks)");
  for (const r of rows) console.log("  " + r.name.padEnd(36) + " got " + String(Number(r.got.toPrecision(7))).padStart(14) + "  want " + String(Number(r.want.toPrecision(7))).padStart(14) + "  err " + r.err.toExponential(1));
})();
globalThis.__testDone = done;
module.exports = done;
done.catch(e => { console.error(e && e.stack || e); if (globalThis.process) process.exitCode = 1; });
