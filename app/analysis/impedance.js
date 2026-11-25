"use strict";

// Controlled-impedance field-solver substitute: closed-form quasi-TEM models
// for the transmission lines a PCB stack-up produces. Lengths are mm (any
// consistent unit works for the impedances; losses and delay assume mm).
//
// Models and their expected accuracy against a 2D field solver (quasi-static,
// smooth copper, within the stated ranges):
//  * Microstrip: Hammerstad & Jensen (1980, IEEE MTT-S Digest), Z0 within
//    0.2 % and eps_eff within 0.2 % for 0.01 <= w/h <= 100, er <= 128 at t = 0.
//    Strip thickness by H&J's Wheeler-derived width correction (about 1 %).
//    Dispersion eps_eff(f) by Kirschning & Jansen (1982), 0.6 % up to 60 GHz.
//  * Coated / embedded microstrip (solder mask, coverlay, buried outer layer):
//    a filling-factor model. The part of the field that sees air in the
//    uncoated line, (1 - q), is replaced by the coating with weight
//    1 - exp(-2 c / h). It reproduces the IPC-2141A embedded microstrip
//    within about 2 % and the 1-3 % drop a thin solder mask causes. Expect
//    +/-3 % on top of the base model.
//  * Symmetric stripline: Cohn (1954) exact conformal map at t = 0; Wheeler
//    (1978) for thick strips, within 0.5 % for w/(b-t) > 0.1.
//  * Offset (asymmetric) stripline: parallel combination of two symmetric
//    striplines of spacing 2 h1 + t and 2 h2 + t (Wadell 3.5.3 / IPC-2141),
//    about 2-5 % for h2/h1 < 3 (+7 % at 5, +11 % at 10; warned above 3).
//  * Edge-coupled stripline: Cohn (1955) exact even/odd modes at t = 0. For
//    t > 0 a capacitance decomposition (Wheeler single line plus Cohn's
//    coupling and a fading gap-wall term) with a correction table from a 2D
//    finite-difference solver: within 0.6 % of the solver (itself within
//    0.3 % of Cohn's exact t = 0 solution) for 0.1 <= w/b <= 2,
//    t/b <= 0.25, s/b >= 0.1 (120 grid and 34 off-grid points); 1.1 % at
//    t/b = 0.28. Outside that range it extrapolates and warns.
//  * Edge-coupled microstrip: Kirschning & Jansen (1984) at t = 0, within
//    0.5 % of the solver (11 points) and stated within 1 % for 0.1 <= w/h,
//    s/h <= 10, er <= 18; Jansen's thickness widths, calibrated (see
//    coupledMicro): within about 1.2 % at t > 0.
//  * Coplanar waveguide with ground (conductor-backed CPW): Ghione & Naldi
//    conformal mapping as given by Wadell 3.4.3, plus Gupta's thickness
//    correction; about 3-5 % when the side grounds are wide and stitched.
//  * Differential CPW and coplanar stripline: superposition of the coupled
//    line and the coplanar-ground capacitances; about 5-10 %.
// Losses: conductor loss by Wheeler's incremental-inductance rule on the
// models above (includes edge current crowding; smooth copper unless
// `rough` gives an rms roughness, Hammerstad-Jensen factor); dielectric loss
// from Df (Pozar 3.198, 3.30). Treat them as estimates (+/-20 %).
globalThis.AtriumImpedance = (() => {
  const PI = Math.PI, ETA0 = 376.730313, C0 = 299.792458 /* mm/ns */, MU0 = 4e-7 * PI, SIGMA_CU = 5.8e7;
  const PS_PER_MM = 1000 / C0;
  const finite = Number.isFinite;
  const sq = x => x * x;
  const coth = x => 1 / Math.tanh(x);

  // ---- Complete elliptic integrals via the arithmetic-geometric mean ----
  function agm(a, b) {
    for (let i = 0; i < 40 && Math.abs(a - b) > 1e-15 * a; i++) [a, b] = [(a + b) / 2, Math.sqrt(a * b)];
    return (a + b) / 2;
  }
  // K(k)/K(k') with k' = sqrt(1 - k^2), stable at both ends.
  function kRatio(k) {
    k = Math.min(Math.max(k, 1e-300), 1 - 1e-16);
    const kp = Math.sqrt(1 - k * k);
    return agm(1, k) / agm(1, kp);
  }

  // ---- Microstrip: Hammerstad & Jensen ----
  function z01(u) {
    const f = 6 + (2 * PI - 6) * Math.exp(-Math.pow(30.666 / u, 0.7528));
    return ETA0 / (2 * PI) * Math.log(f / u + Math.sqrt(1 + 4 / (u * u)));
  }
  function eeHJ(u, er) {
    const a = 1 + Math.log((u ** 4 + sq(u / 52)) / (u ** 4 + 0.432)) / 49 + Math.log(1 + (u / 18.1) ** 3) / 18.7;
    const b = 0.564 * Math.pow((er - 0.9) / (er + 3), 0.053);
    return (er + 1) / 2 + (er - 1) / 2 * Math.pow(1 + 10 / u, -a * b);
  }
  // Single microstrip, uncoated. Returns {z, ee, ur} (ur = effective w/h).
  function microstrip(w, h, t, er) {
    const u = w / h;
    let u1 = u, ur = u;
    if (t > 0) {
      const T = t / h, du1 = T / PI * Math.log(1 + 4 * Math.E / (T * sq(coth(Math.sqrt(6.517 * u)))));
      u1 = u + du1; ur = u + 0.5 * (1 + 1 / Math.cosh(Math.sqrt(Math.max(0, er - 1)))) * du1;
    }
    const eer = eeHJ(ur, er), zr = z01(ur);
    return {z:zr / Math.sqrt(eer), ee:eer * sq(z01(u1) / zr), ur};
  }
  // Kirschning & Jansen dispersion: eps_eff at f GHz (h in mm).
  function dispersion(ee0, er, u, h, f) {
    if (!(f > 0) || er <= 1) return ee0;
    const fn = f * h;
    const P1 = 0.27488 + (0.6315 + 0.525 / Math.pow(1 + 0.0157 * fn, 20)) * u - 0.065683 * Math.exp(-8.7513 * u);
    const P2 = 0.33622 * (1 - Math.exp(-0.03442 * er));
    const P3 = 0.0363 * Math.exp(-4.6 * u) * (1 - Math.exp(-Math.pow(fn / 38.7, 4.97)));
    const P4 = 1 + 2.751 * (1 - Math.exp(-Math.pow(er / 15.916, 8)));
    const P = P1 * P2 * Math.pow((0.1844 + P3 * P4) * fn, 1.5763);
    return er - (er - ee0) / (1 + P);
  }
  // Coating (solder mask, coverlay, prepreg above an embedded line).
  function coat(z, ee, er, cover, h) {
    if (!cover || !(cover.t > 0) || !(cover.er >= 1) || er <= 1) return {z, ee};
    const q = (ee - 1) / (er - 1), w = 1 - Math.exp(-2 * cover.t / h);
    const ec = ee + (1 - q) * w * (cover.er - 1);
    return {z:z * Math.sqrt(ee / ec), ee:ec};
  }

  // Kirschning & Jansen (1984, IEEE MTT-32 pp. 83-90) coupled microstrip,
  // static even/odd modes at zero thickness: {even:{z, ee}, odd:{z, ee}}.
  // Stated within 1 % for 0.1 <= u <= 10, 0.1 <= g <= 10, er <= 18; its
  // even/odd values tend to the single line as g grows.
  function kjModes(u, g, er) {
    const ee = eeHJ(u, er), z0 = z01(u) / Math.sqrt(ee);
    const v = u * (20 + g * g) / (10 + g * g) + g * Math.exp(-g);
    const ae = 1 + Math.log((v ** 4 + sq(v / 52)) / (v ** 4 + 0.432)) / 49 + Math.log(1 + (v / 18.1) ** 3) / 18.7;
    const be = 0.564 * Math.pow((er - 0.9) / (er + 3), 0.053);
    const eeE = (er + 1) / 2 + (er - 1) / 2 * Math.pow(1 + 10 / v, -ae * be);
    const a0 = 0.7287 * (ee - (er + 1) / 2) * (1 - Math.exp(-0.179 * u));
    const b0 = 0.747 * er / (0.15 + er), c0 = b0 - (b0 - 0.207) * Math.exp(-0.414 * u), d0 = 0.593 + 0.694 * Math.exp(-0.562 * u);
    const eeO = ((er + 1) / 2 + a0 - ee) * Math.exp(-c0 * Math.pow(g, d0)) + ee;
    const Q1 = 0.8695 * Math.pow(u, 0.194), Q2 = 1 + 0.7519 * g + 0.189 * Math.pow(g, 2.31);
    const Q3 = 0.1975 + Math.pow(16.6 + Math.pow(8.4 / g, 6), -0.387) + Math.log(Math.pow(g, 10) / (1 + Math.pow(g / 3.4, 10))) / 241;
    const Q4 = 2 * Q1 / Q2 / (Math.exp(-g) * Math.pow(u, Q3) + (2 - Math.exp(-g)) * Math.pow(u, -Q3));
    const Q5 = 1.794 + 1.14 * Math.log(1 + 0.638 / (g + 0.517 * Math.pow(g, 2.43)));
    const Q6 = 0.2305 + Math.log(Math.pow(g, 10) / (1 + Math.pow(g / 5.8, 10))) / 281.3 + Math.log(1 + 0.598 * Math.pow(g, 1.154)) / 5.1;
    const Q7 = (10 + 190 * g * g) / (1 + 82.3 * g ** 3), Q8 = Math.exp(-6.5 - 0.95 * Math.log(g) - Math.pow(g / 0.15, 5));
    const Q9 = Math.log(Q7) * (Q8 + 1 / 16.5), Q10 = (Q2 * Q4 - Q5 * Math.exp(Math.log(u) * Q6 * Math.pow(u, -Q9))) / Q2;
    return {even:{z:z0 * Math.sqrt(ee / eeE) / (1 - z0 / ETA0 * Math.sqrt(ee) * Q4), ee:eeE},
      odd:{z:z0 * Math.sqrt(ee / eeO) / (1 - z0 / ETA0 * Math.sqrt(ee) * Q10), ee:eeO}};
  }
  // Coupled microstrip: Kirschning & Jansen (t = 0) with Jansen's strip-
  // thickness widths (as used with KJ in Qucs and ADS MCLIN): the even mode
  // widens by dW (1 - 0.5 exp(-0.69 dW / dt)), the odd mode by dt = 2 t h /
  // (er s) more (the gap walls); dW is H&J's thickness widening. C comes from
  // the dielectric widths, Ca from the air-filled widths (dW = H&J's du1),
  // and C is scaled by H&J's Z01(u1) / Z01(ur) so a wide gap gives H&J's
  // thick single line exactly. In the air-filled odd mode only 0.75 of dt is
  // added: calibrated against a 2D finite-difference solver (12 points,
  // t/h 0.17-0.7, er 3.4-4.4), Zodd/Zeven within 1.2 % and eps_eff within
  // 0.8 % there; plain Jansen (1.0) put Zodd 1-3.5 % and eps_eff,odd up to
  // 7 % low. Capacitances normalised to eps0.
  function coupledMicro(w, h, t, er, s) {
    const u = w / h, g = Math.max(s / h, 1e-6), T = t > 0 ? t / h : 0;
    const du1 = T > 0 ? T / PI * Math.log(1 + 4 * Math.E / (T * sq(coth(Math.sqrt(6.517 * u))))) : 0;
    const widths = e => {
      if (!(T > 0)) return {ue:u, uo:u};
      const dW = e > 1 ? 0.5 * (1 + 1 / Math.cosh(Math.sqrt(e - 1))) * du1 : du1, dt = 2 * T / (e * g);
      const ue = u + dW * (1 - 0.5 * Math.exp(-0.69 * dW / dt));
      return {ue, uo:ue + (e > 1 ? 1 : 0.75) * dt};
    };
    const pick = (ws, e) => ({even:kjModes(ws.ue, g, e).even, odd:kjModes(ws.uo, g, e).odd});
    const d = pick(widths(er), er), a = pick(widths(1), 1), one = microstrip(w, h, t, er);
    // C from the dielectric widths, Ca from the air widths; C is scaled by
    // H&J's Z01(u1) / Z01(ur) so the single-line limit is H&J's thick line.
    const k = z01(u + du1) / z01(one.ur);
    const mode = (c, ca) => ({z:ETA0 / Math.sqrt(c * ca), ee:c / ca, c, ca});
    const cOf = m => k * ETA0 * Math.sqrt(m.ee) / m.z, caOf = m => ETA0 / m.z;
    return {single:mode(ETA0 * Math.sqrt(one.ee) / one.z, ETA0 / (one.z * Math.sqrt(one.ee))), even:mode(cOf(d.even), caOf(a.even)), odd:mode(cOf(d.odd), caOf(a.odd)), ur:one.ur};
  }
  // Conductor-backed coplanar waveguide (centre w, gaps g, substrate h).
  function cpwg(w, h, t, er, g) {
    if (t > 0) {const D = 1.25 * t / PI * (1 + Math.log(4 * PI * w / t)); w += D; g = Math.max(g - D, g * 0.2);}
    const k = w / (w + 2 * g), k3 = Math.tanh(PI * w / (4 * h)) / Math.tanh(PI * (w + 2 * g) / (4 * h));
    const r1 = kRatio(k), r3 = kRatio(k3), x = r3 / r1;
    const ee = (1 + er * x) / (1 + x);
    const z = 60 * PI / Math.sqrt(ee) / (r1 + r3);
    return {z, ee, c:ETA0 * Math.sqrt(ee) / z, ca:ETA0 / (z * Math.sqrt(ee))};
  }

  // ---- Stripline ----
  function stripCohn(w, b) { // t = 0, er = 1
    const k = 1 / Math.cosh(PI * w / (2 * b));
    return 30 * PI * kRatio(k);
  }
  function stripWheeler(w, b, t) { // er = 1
    if (!(t > 0)) return stripCohn(w, b);
    const x = t / b, n = 2 / (1 + 2 / 3 * x / (1 - x));
    const dw = x / (PI * (1 - x)) * (1 - 0.5 * Math.log(sq(x / (2 - x)) + Math.pow(0.0796 * x / (w / b + 1.1 * x), n)));
    const m = w / (b - t) + dw, p = 8 / (PI * m);
    return 30 * Math.log(1 + 4 / (PI * m) * (p + Math.sqrt(p * p + 6.27)));
  }
  // Symmetric edge-coupled stripline in air (ground spacing b, strip t):
  // {single, even, odd} impedances.
  // t = 0: Cohn (1955), exact. t > 0: capacitances per strip, normalised to
  // eps0 (C = eta0 / Z in air): C_mode = C_single + kappa_mode * dC_mode, with
  //   C_single  Wheeler's thick single stripline (0.5 %),
  //   dC_odd  = r (C_odd0 - C_single0) + (2 t / s) exp(-2 s / (b - t)),
  //   dC_even = r (C_even0 - C_single0),
  // where C_mode0 are Cohn's exact zero-thickness values and r = Cf'(t) /
  // Cf'(0) is Cohn's fringe ratio. The gap-wall term is the odd-mode parallel
  // plate between the strip sides, fading once the gap exceeds the plate
  // spacing (Cohn's own 2t/s term never fades and made Zodd 3-13 % low).
  // kappa is a correction table from a 2D finite-difference Laplace solve
  // (quasi-static, graded mesh, energy capacitance; validated against Cohn's
  // exact t = 0 solution within 0.3 %), interpolated in ln(w/b), t/b and
  // ln(s/b): kappa = 1 at t = 0, and dC -> 0 recovers the single line as s
  // grows. Accuracy against the solver: see coupledRange and tests/impedance.cjs.
  const KW = [0.1, 0.2, 0.35, 0.6, 1, 2], KT = [0, 0.03, 0.07, 0.15, 0.25], KS = [0.1, 0.2, 0.4, 0.8, 1.6];
  // kappa[w][t][s] for t/b = 0.03 ... 0.25 (t = 0 is 1), odd then even.
  const KAPPA_ODD = [
    1.0011,1.0133,1.0242,1.023,0.9105,0.9917,1.0092,1.0308,1.0386,0.9175,1.0061,1.0337,1.0761,1.1177,1.031,1.042,1.0949,1.1817,1.3002,1.3238,
    0.9808,0.9877,0.9939,0.9911,0.8932,0.9659,0.9751,0.9883,0.9913,0.8854,0.977,0.9924,1.0205,1.0495,0.971,1.0124,1.0484,1.1121,1.2026,1.2117,
    0.9714,0.9757,0.9795,0.9757,0.8848,0.9526,0.9574,0.966,0.9665,0.868,0.9607,0.9689,0.989,1.0114,0.9367,0.995,1.0211,1.0719,1.1483,1.15,
    0.9671,0.9701,0.9728,0.9686,0.8801,0.9461,0.9486,0.9551,0.9543,0.859,0.9525,0.957,0.9731,0.9925,0.9198,0.9862,1.0072,1.0518,1.1216,1.1202,
    0.966,0.9686,0.971,0.9666,0.8776,0.9443,0.9462,0.952,0.9509,0.855,0.9502,0.9537,0.9688,0.9874,0.9138,0.9838,1.0035,1.0466,1.1148,1.1122,
    0.9659,0.9685,0.9708,0.9664,0.8767,0.9441,0.9459,0.9516,0.9504,0.854,0.95,0.9533,0.9683,0.987,0.9135,0.9835,1.0032,1.0461,1.114,1.1101
  ];
  const KAPPA_EVEN = [
    1.1488,1.1645,1.1845,1.21,1.3187,1.2826,1.3186,1.3615,1.4077,1.5346,1.505,1.5832,1.677,1.7685,1.9343,1.7771,1.9026,2.0648,2.22,2.4353,
    1.0903,1.1019,1.1181,1.14,1.2348,1.1819,1.2076,1.241,1.2793,1.3875,1.349,1.4031,1.474,1.5477,1.6864,1.5674,1.6526,1.7723,1.8945,2.0728,
    1.0628,1.0726,1.0871,1.1077,1.1961,1.133,1.1541,1.1834,1.2185,1.3182,1.2715,1.3149,1.3755,1.4414,1.568,1.4622,1.5299,1.6308,1.7394,1.9044,
    1.0505,1.0596,1.0735,1.0936,1.1798,1.1108,1.13,1.1576,1.1914,1.2874,1.236,1.2751,1.3314,1.3942,1.5161,1.4142,1.4749,1.5681,1.6709,1.8285,
    1.0474,1.0564,1.0702,1.0903,1.1772,1.1052,1.124,1.1512,1.1848,1.282,1.2272,1.2653,1.3206,1.3826,1.5043,1.4025,1.4617,1.5532,1.6546,1.8122,
    1.0471,1.056,1.0698,1.0899,1.1754,1.1047,1.1234,1.1506,1.1842,1.2825,1.2264,1.2644,1.3196,1.3814,1.5027,1.4014,1.4606,1.5519,1.6531,1.8136
  ];
  function cfStrip(t, b) {return 2 / PI * Math.log((2 * b - t) / (b - t)) - (t > 0 ? t / (PI * b) * Math.log(t * (2 * b - t) / sq(b - t)) : 0);}
  function coupledBase(w, b, t, s) {
    const a = Math.tanh(PI * w / (2 * b)), c = PI * (w + s) / (2 * b);
    const ce0 = ETA0 / (30 * PI / kRatio(a * Math.tanh(c))), co0 = ETA0 / (30 * PI / kRatio(a * coth(c))), cs0 = ETA0 / stripCohn(w, b);
    const r = cfStrip(t, b) / cfStrip(0, b);
    return {odd:r * (co0 - cs0) + (t > 0 ? 2 * t / s * Math.exp(-2 * s / (b - t)) : 0), even:r * (ce0 - cs0), ce0, co0};
  }
  // Index and weight of x in an ascending node list (clamped at the ends).
  function at(nodes, x, log) {
    const f = log ? Math.log : v => v, n = nodes.length;
    if (x <= nodes[0]) return [0, 0];
    if (x >= nodes[n - 1]) return [n - 2, 1];
    let i = 0; while (x > nodes[i + 1]) i++;
    return [i, (f(x) - f(nodes[i])) / (f(nodes[i + 1]) - f(nodes[i]))];
  }
  function kappa(table, wb, tb, sb) {
    const [i, u] = at(KW, wb, true), [j, v] = at(KT, tb, false), [k, q] = at(KS, sb, true);
    const val = (a, b, c) => b === 0 ? 1 : table[(a * 4 + b - 1) * 5 + c];
    let out = 0;
    for (const [di, wi] of [[0, 1 - u], [1, u]]) for (const [dj, wj] of [[0, 1 - v], [1, v]]) for (const [dk, wk] of [[0, 1 - q], [1, q]]) {
      const wt = wi * wj * wk;
      if (wt) out += wt * val(i + di, j + dj, k + dk);
    }
    return out;
  }
  // Where the table extrapolates: a description, or "" inside the calibrated range.
  function coupledRange(wb, tb, sb) {
    const out = [];
    if (wb < KW[0]) out.push("w/b < " + KW[0]); if (wb > KW[KW.length - 1]) out.push("w/b > " + KW[KW.length - 1]);
    if (tb > KT[KT.length - 1]) out.push("t/b > " + KT[KT.length - 1]);
    if (sb < KS[0]) out.push("s/b < " + KS[0]);
    return out.join(", ");
  }
  function coupledStripAir(w, b, t, s) {
    const zt = stripWheeler(w, b, t);
    if (!(t > 0)) {const c = coupledBase(w, b, 0, s); return {single:zt, even:ETA0 / c.ce0, odd:ETA0 / c.co0};}
    if (s > 50 * b) return {single:zt, even:zt, odd:zt};
    const c = coupledBase(w, b, t, s), cs = ETA0 / zt, wb = w / b, tb = t / b, sb = s / b;
    return {single:zt, even:ETA0 / (cs + kappa(KAPPA_EVEN, wb, tb, sb) * c.even), odd:ETA0 / (cs + kappa(KAPPA_ODD, wb, tb, sb) * c.odd)};
  }
  // Offset stripline: combine the two symmetric halves (admittances add).
  const halves = (h1, h2, t, fn) => {
    const a = fn(2 * h1 + t), b = fn(2 * h2 + t);
    const out = {};
    for (const k of Object.keys(a)) out[k] = 2 * a[k] * b[k] / (a[k] + b[k]);
    return out;
  };

  // ---- Losses (dB/mm) ----
  // Conductor loss by Wheeler's incremental-inductance rule (Wheeler 1942;
  // Pozar 4th ed. 3.9): R = (Rs / eta0) dZ0air/dn, where dZ0air/dn is the
  // change of the air-filled impedance when every copper surface (strip and
  // reference planes) recedes by n. It includes current crowding at the strip
  // edges, which the parallel-plate Rs / (Z0 W) misses (1.3-3x too high for
  // w/h <= 10). Valid while the copper is several skin depths thick.
  // Roughness (optional, rms in mm): Hammerstad & Jensen's factor
  // 1 + (2/pi) atan(1.4 (rough / skin depth)^2), at most 2.
  function surfaceR(fGHz, sigma) {return Math.sqrt(PI * fGHz * 1e9 * MU0 / sigma);}
  function roughFactor(rough, fGHz, sigma) {
    if (!(rough > 0)) return 1;
    const delta = 1e3 / Math.sqrt(PI * fGHz * 1e9 * MU0 * sigma); // mm
    return 1 + 2 / PI * Math.atan(1.4 * sq(rough / delta));
  }
  // zAir(n): air-filled impedance of the mode with every surface receded by n mm.
  function conductorLoss(z, zAir, scale, fGHz, sigma, rough) {
    const n = 1e-4 * scale, dz = (zAir(n) - zAir(0)) / n; // ohm per mm
    const R = surfaceR(fGHz, sigma) / ETA0 * dz * 1e3; // ohm per m
    return 8.686 * R / (2 * z) / 1000 * roughFactor(rough, fGHz, sigma); // dB/mm
  }
  function lossDielectric(ee, er, fGHz, tanD) {
    const k0 = 2 * PI * fGHz * 1e9 / (C0 * 1e6);
    return er > 1 ? 8.686 * k0 * er * (ee - 1) * tanD / (2 * Math.sqrt(ee) * (er - 1)) / 1000 : 0;
  }

  // ---- Public solver ----
  // geom: {structure:"microstrip"|"stripline", w, t, er,
  //   microstrip: h, cover:{t, er} (mask, coverlay or dielectric above)
  //   stripline: h1 (above), h2 (below), er (weighted)
  //   s: pair gap (edge-coupled differential), g: gap to coplanar ground,
  //   etch: IPC etch factor E = t / undercut per side (0 = rectangular),
  //   freq GHz (default 1), tanD (default 0.02), sigma S/m (default copper),
  //   rough: rms copper roughness in mm (default 0, smooth)}
  // Returns impedances in ohm, eps_eff, delay ps/mm and loss dB/mm.
  // modes(): the quasi-static modes of a geometry whose width is already etched.
  function modes(g, w, warn) {
    const t = g.t > 0 ? +g.t : 0, er = +g.er;
    const s = g.s > 0 ? +g.s : 0, cg = g.g > 0 ? +g.g : 0, diff = s > 0, cop = cg > 0;
    let single, even, odd, model;
    if (g.structure === "stripline") {
      const h1 = +g.h1, h2 = +g.h2;
      if (!(h1 > 0 && h2 > 0)) return {error:"Both dielectric heights are required."};
      const sym = Math.abs(h1 - h2) <= 1e-9 * (h1 + h2), se = Math.sqrt(er);
      const air = b => {
        const c = coupledStripAir(w, b, t, diff ? s : 1e6);
        if (cop) { // coplanar ground: odd mode against a virtual ground at g.
          const side = coupledStripAir(w, b, t, 2 * cg), y = 1 / side.odd - 1 / side.single;
          return {single:1 / (1 / c.single + 2 * y), even:1 / (1 / c.even + y), odd:1 / (1 / c.odd + y)};
        }
        return c;
      };
      const z = sym ? air(2 * h1 + t) : halves(h1, h2, t, air);
      single = {z:z.single / se, ee:er};
      even = diff ? {z:z.even / se, ee:er} : single; odd = diff ? {z:z.odd / se, ee:er} : single;
      model = (sym ? "Symmetric" : "Offset") + " stripline" + (diff ? ", edge-coupled" : "") + (cop ? ", coplanar ground" : "");
      if (warn) {
        if (!sym && Math.max(h1, h2) / Math.min(h1, h2) > 3) warn.push("Strongly offset stripline: the closed form loses accuracy beyond h2/h1 = 3.");
        if (t > 0 && (diff || cop)) {
          const b = sym ? 2 * h1 + t : Math.min(h1, h2) * 2 + t, x = coupledRange(w / b, t / b, (diff ? s : 2 * cg) / b);
          if (x) warn.push("Edge-coupled stripline outside the calibrated range (" + x + "): expect a few % error.");
        }
      }
    } else {
      const h = +g.h;
      if (!(h > 0)) return {error:"Dielectric height is required."};
      const cover = g.cover && g.cover.t > 0 ? g.cover : null;
      if (diff || cop) {
        const cm = coupledMicro(w, h, t, er, diff ? s : 1e3 * h);
        let e = cm.even, o = cm.odd, sg = cm.single;
        if (cop) {
          const cw = cpwg(w, h, t, er, cg);
          if (!diff) sg = e = o = cw;
          else {
            const dc = (cw.c - cm.single.c) / 2, dca = (cw.ca - cm.single.ca) / 2;
            const add = m => ({z:ETA0 / Math.sqrt((m.c + dc) * (m.ca + dca)), ee:(m.c + dc) / (m.ca + dca)});
            e = add(e); o = add(o);
          }
        }
        single = coat(sg.z, sg.ee, er, cover, h); even = coat(e.z, e.ee, er, cover, h); odd = coat(o.z, o.ee, er, cover, h);
        const u = w / h, sh = s / h;
        if (warn && diff && (u < 0.1 || u > 10 || sh < 0.1 || sh > 10)) warn.push("Outside the Kirschning-Jansen range (0.1 <= w/h <= 10, 0.1 <= s/h <= 10).");
      } else {
        const m = microstrip(w, h, t, er);
        single = coat(m.z, m.ee, er, cover, h); even = odd = single;
        if (warn && t > w) warn.push("Strip narrower than its thickness: H&J's thickness correction overestimates Z0 and eps_eff (about 4 % at w = t / 7).");
      }
      model = (cover ? "Coated microstrip" : "Microstrip") + (diff ? ", edge-coupled" : "") + (cop ? ", coplanar ground (CPWG)" : "");
    }
    return {single, even, odd, model, diff};
  }
  function solve(g) {
    const out = {ok:false, warnings:[]};
    const t = g.t > 0 ? +g.t : 0, er = +g.er, f = g.freq > 0 ? +g.freq : 1, tanD = g.tanD >= 0 ? +g.tanD : 0.02, sigma = g.sigma > 0 ? +g.sigma : SIGMA_CU;
    let w = +g.w;
    if (!(w > 0) || !(er >= 1)) {out.error = "Width and Dk are required."; return out;}
    if (g.etch > 0) w = Math.max(w * 0.05, w - t / g.etch);
    const m = modes(g, w, out.warnings);
    if (m.error) {out.error = m.error; return out;}
    const {single, even, odd, model, diff} = m, strip = g.structure === "stripline";
    const main = diff ? odd : single;
    // Air-filled impedance of the main mode with the copper receded by n.
    const tc = Math.max(t, 1e-3);
    const zAir = n => {
      const r = strip ? {...g, er:1, t:Math.max(tc - 2 * n, 1e-6), h1:+g.h1 + 2 * n, h2:+g.h2 + 2 * n}
        : {...g, er:1, cover:null, t:Math.max(tc - 2 * n, 1e-6), h:+g.h + 2 * n};
      if (r.s > 0) r.s = +g.s + 2 * n;
      if (r.g > 0) r.g = +g.g + 2 * n;
      const q = modes(r, w - 2 * n, null);
      return q.error ? NaN : (diff ? q.odd.z : q.single.z);
    };
    const conductor = conductorLoss(main.z, zAir, Math.min(w, tc), f, sigma, g.rough);
    const dielectric = strip ? 8.686 * (2 * PI * f * 1e9 / (C0 * 1e6) * Math.sqrt(er)) * tanD / 2 / 1000 : lossDielectric(main.ee, er, f, tanD);
    if (!strip) out.eeffDispersed = dispersion(main.ee, er, w / g.h, +g.h, f);
    Object.assign(out, {ok:true, model, z0:single.z, zodd:odd.z, zeven:even.z, zdiff:2 * odd.z, zcommon:even.z / 2,
      z:diff ? 2 * odd.z : single.z, eeff:main.ee, eeffOdd:odd.ee, eeffEven:even.ee,
      delay:PS_PER_MM * Math.sqrt(main.ee), delayEven:PS_PER_MM * Math.sqrt(even.ee),
      loss:{freq:f, conductor, dielectric, total:conductor + dielectric}});
    if (!finite(out.z) || out.z <= 0) {out.ok = false; out.error = "The geometry is outside the model range.";}
    if (out.ok && !(conductor >= 0)) out.loss.conductor = out.loss.total = NaN;
    return out;
  }
  const valueOf = (g) => {const r = solve(g); return r.ok ? r.z : NaN;};

  // Width (or another dimension) for a target impedance by bisection on a log
  // scale; the direction is found from the ends. vary: "w" (default), "s" (pair
  // gap), "g" (gap to coplanar ground), "h" (microstrip dielectric height),
  // "h1" / "h2" (stripline heights above / below).
  const VARY = {w:"width", s:"gap", g:"ground gap", h:"dielectric height", h1:"dielectric height above", h2:"dielectric height below"};
  function synthesize(geom, {target, vary = "w", min, max, iterations = 60} = {}) {
    if (!(target > 0)) return {ok:false, error:"Choose a target impedance."};
    const key = Object.hasOwn(VARY, vary) ? vary : "w";
    if (min > 0 && max > 0 && max <= min) return {ok:false, error:"The " + VARY[key] + " maximum must be above the minimum."};
    let lo = min > 0 ? min : key === "w" ? 0.01 : 0.01, hi = max > lo ? max : key === "w" ? 25 : 25;
    const at = v => valueOf({...geom, [key]:v});
    let zlo = at(lo), zhi = at(hi);
    if (!finite(zlo) || !finite(zhi)) return {ok:false, error:"The model is undefined at the width limits."};
    const rising = zhi > zlo;
    const clamp = v => ({ok:false, clamped:true, [key]:v, result:solve({...geom, [key]:v}),
      error:"The target is outside the " + VARY[key] + " limits."});
    if (rising ? target <= zlo : target >= zlo) return clamp(lo);
    if (rising ? target >= zhi : target <= zhi) return clamp(hi);
    let a = Math.log(lo), b = Math.log(hi);
    for (let i = 0; i < iterations && b - a > 1e-9; i++) {
      const m = (a + b) / 2, z = at(Math.exp(m));
      if ((z > target) !== rising) a = m; else b = m;
    }
    const v = Math.exp((a + b) / 2);
    return {ok:true, [key]:v, result:solve({...geom, [key]:v})};
  }

  // ---- Stack geometry ----
  const isCopper = l => !!l && (l.type === "Signal" || l.type === "Plane");
  const DEFAULT_DK = {Dielectric:4.4, "Solder Mask":3.5, Coverlay:3.4, Adhesive:3.6, Stiffener:4.4};
  const sum = a => a.reduce((s, v) => s + v, 0);
  const dkOf = l => l.dk > 0 ? l.dk : DEFAULT_DK[l.type] || 4.2;
  // Weighted Dk and Df of the insulating layers between two stack indexes.
  function span(layers, from, to) {
    let h = 0, e = 0, d = 0;
    for (let i = from; i < to; i++) {
      const l = layers[i];
      if (!l || isCopper(l) || l.type === "Overlay" || l.type === "Surface Finish" || l.type === "Stiffener" || !(l.thickness > 0)) continue;
      h += l.thickness; e += l.thickness * dkOf(l); d += l.thickness * (l.df >= 0 ? l.df : 0.02);
    }
    return {h, er:h > 0 ? e / h : 4.2, df:h > 0 ? d / h : 0.02};
  }
  // Copper z between two copper indexes includes the copper in between.
  function gapBetween(layers, a, b) {
    const ins = span(layers, a + 1, b);
    let cu = 0;
    for (let i = a + 1; i < b; i++) if (isCopper(layers[i])) cu += layers[i].thickness;
    return {...ins, h:ins.h + cu};
  }
  // Geometry for the copper layer `key` in a layer list. refs = [above, below]
  // copper keys (null for none); by default the neighbouring copper layers.
  function geometry(layers, key, refs) {
    const cuIdx = layers.map((l, i) => isCopper(l) ? i : -1).filter(i => i >= 0);
    const n = cuIdx.findIndex(i => layers[i].key === key);
    if (n < 0) return null;
    const at = cuIdx[n], sig = layers[at];
    const find = k => k == null ? -1 : cuIdx.find(i => layers[i].key === k) ?? -1;
    let up = refs ? find(refs[0]) : n > 0 ? cuIdx[n - 1] : -1;
    let down = refs ? find(refs[1]) : n < cuIdx.length - 1 ? cuIdx[n + 1] : -1;
    if (up >= at) up = -1;
    if (down >= 0 && down <= at) down = -1;
    const t = sig.thickness;
    const base = {key, t, refTop:up >= 0 ? layers[up].key : null, refBottom:down >= 0 ? layers[down].key : null, names:[up >= 0 ? layers[up].name : null, down >= 0 ? layers[down].name : null]};
    if (up >= 0 && down >= 0) {
      const a = gapBetween(layers, up, at), b = gapBetween(layers, at, down);
      const er = (a.h * a.er + b.h * b.er) / (a.h + b.h), df = (a.h * a.df + b.h * b.df) / (a.h + b.h);
      return {...base, structure:"stripline", h1:a.h, h2:b.h, er, tanD:df};
    }
    if (up < 0 && down < 0) return {...base, structure:"none"};
    const below = down >= 0, sub = below ? gapBetween(layers, at, down) : gapBetween(layers, up, at);
    const cov = below ? span(layers, 0, at) : span(layers, at + 1, layers.length);
    return {...base, structure:"microstrip", h:sub.h, er:sub.er, tanD:sub.df, cover:cov.h > 0 ? {t:cov.h, er:cov.er} : null, facing:below ? "up" : "down"};
  }

  // The one εeff and delay (ps/mm) fallback, for a layer whose stack-up cannot be solved (no stack,
  // no reference plane): the quasi-static microstrip model above for an outer layer (w over h, default
  // 0.15 mm over 0.2 mm, 35 µm copper), εr itself for an inner layer; εr defaults to 4.2, as span()
  // does with no dielectric. AtriumStackup.delay uses it, so length-tuning, timing-vision, the
  // Constraint Manager and via-fence give the same delay for the same layer.
  function delayFallback({outer = true, w = 0.15, h = 0.2, t = 0.035, er = 4.2} = {}) {
    const ee = outer ? microstrip(w > 0 ? w : 0.15, h > 0 ? h : 0.2, t >= 0 ? t : 0.035, er >= 1 ? er : 4.2).ee : er >= 1 ? er : 4.2;
    return {ee, delay:PS_PER_MM * Math.sqrt(ee)};
  }

  return Object.freeze({solve, synthesize, geometry, delayFallback, dispersion, kRatio, ETA0, PS_PER_MM,
    models:Object.freeze({microstrip, coupledMicro, kjModes, cpwg, stripCohn, stripWheeler, coupledStripAir, coupledBase, coupledRange})});
})();
