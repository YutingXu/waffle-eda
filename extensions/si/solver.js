"use strict";
// AtriumSISolver: a fixed-step time-domain circuit solver for signal integrity.
//
// Elements: resistors, capacitors and inductors (trapezoidal companion models), Norton voltage
// sources with a series resistance, lossless transmission lines by the method of characteristics
// (Bergeron: each end is a conductance 1/Z0 in parallel with a history current read Td ago, with
// linear interpolation between steps), symmetric coupled line pairs (the same, per even/odd mode
// after the modal transform T = [[1, 1], [1, -1]]/√2), and nonlinear one-port devices (IBIS
// behavioural buffers: I(V, t) into the pin and dI/dV).
//
// Method: with a fixed step every linear element has a constant conductance, so the nodal matrix
// G is inverted once. The nonlinear devices are few (one per buffer), so each step uses the
// compensation method (EMTP): solve the linear network with the devices removed, v0 = G⁻¹·rhs,
// then Newton on the k device nodes only, v_K = v0_K − Z_KK·I(v_K) with Z = G⁻¹, and correct the
// other nodes with the columns of G⁻¹. The start is a DC operating point (capacitors open,
// inductors and lines short, the same Newton). Loss is added by the caller as lumped series R and
// shunt G between line sections.
//
// run(circuit, opts) is a generator (it yields between chunks of steps, so a caller can stay
// responsive and cancel); simulate() drains it. measure() turns a waveform into the usual metrics.
(function () {
  const GND = -1, SHORT = 1e6, GMIN = 1e-12, SQ = Math.SQRT1_2;

  class Circuit {
    constructor() { this.n = 0; this.names = []; this.el = []; this.devices = []; }
    node(name) { this.names.push(String(name ?? "n" + this.n)); return this.n++; }
    R(a, b, r, tag) { if (!(r > 0)) throw Error("A resistor needs a positive value."); this.el.push({k: "R", a, b, g: 1 / r, tag}); }
    C(a, b, c, tag) { if (c > 0) this.el.push({k: "C", a, b, c, tag}); }
    L(a, b, l, tag) { if (l > 0) this.el.push({k: "L", a, b, l, tag}); else this.el.push({k: "R", a, b, g: SHORT, tag}); }
    // Voltage source fn(t) behind rs, from node a to ground.
    V(a, rs, fn, tag) { if (!(rs > 0)) rs = 1e-3; this.el.push({k: "V", a, g: 1 / rs, fn, tag}); }
    T(a, b, z, td, tag) { if (!(z > 0) || !(td > 0)) throw Error("A line needs a positive impedance and delay."); this.el.push({k: "T", a, b, z, td, tag}); }
    // Symmetric coupled pair: conductors 1 (a1 → b1) and 2 (a2 → b2), even/odd mode impedances and delays.
    T2(a1, b1, a2, b2, ze, zo, te, to, tag) { this.el.push({k: "T2", a1, b1, a2, b2, ze, zo, te, to, tag}); }
    // Nonlinear device at node a: dev.i(v, t) -> [current into the device, dI/dV].
    D(a, dev, tag) { this.devices.push({a, dev, tag}); }
  }

  // Dense inverse by Gauss-Jordan elimination with partial pivoting (row-major Float64Array).
  function invert(M, n) {
    const A = Float64Array.from(M), I = new Float64Array(n * n);
    for (let i = 0; i < n; i++) I[i * n + i] = 1;
    for (let c = 0; c < n; c++) {
      let p = c, best = Math.abs(A[c * n + c]);
      for (let r = c + 1; r < n; r++) { const x = Math.abs(A[r * n + c]); if (x > best) { best = x; p = r; } }
      if (!(best > 1e-300)) throw Error("The circuit matrix is singular (a node has no path to ground).");
      if (p !== c) for (let j = 0; j < n; j++) { let t = A[c * n + j]; A[c * n + j] = A[p * n + j]; A[p * n + j] = t; t = I[c * n + j]; I[c * n + j] = I[p * n + j]; I[p * n + j] = t; }
      const d = 1 / A[c * n + c];
      for (let j = 0; j < n; j++) { A[c * n + j] *= d; I[c * n + j] *= d; }
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const f = A[r * n + c];
        if (f === 0) continue;
        const ra = r * n, ca = c * n;
        for (let j = 0; j < n; j++) { A[ra + j] -= f * A[ca + j]; I[ra + j] -= f * I[ca + j]; }
      }
    }
    return I;
  }
  function stamp(G, n, a, b, g) {
    if (a >= 0) G[a * n + a] += g;
    if (b >= 0) G[b * n + b] += g;
    if (a >= 0 && b >= 0) { G[a * n + b] -= g; G[b * n + a] -= g; }
  }
  // Small dense solve for the Newton step (k ≤ a few dozen).
  function solveSmall(J, r, k) {
    const A = J.slice(), x = r.slice();
    for (let c = 0; c < k; c++) {
      let p = c; for (let i = c + 1; i < k; i++) if (Math.abs(A[i * k + c]) > Math.abs(A[p * k + c])) p = i;
      if (p !== c) { for (let j = 0; j < k; j++) { const t = A[c * k + j]; A[c * k + j] = A[p * k + j]; A[p * k + j] = t; } const t = x[c]; x[c] = x[p]; x[p] = t; }
      const d = A[c * k + c] || 1e-30;
      for (let i = c + 1; i < k; i++) { const f = A[i * k + c] / d; if (!f) continue; for (let j = c; j < k; j++) A[i * k + j] -= f * A[c * k + j]; x[i] -= f * x[c]; }
    }
    for (let c = k - 1; c >= 0; c--) { let s = x[c]; for (let j = c + 1; j < k; j++) s -= A[c * k + j] * x[j]; x[c] = s / (A[c * k + c] || 1e-30); }
    return x;
  }

  // Newton on the device nodes: v_K = v0_K − Z·I(v_K, t). Returns the device currents.
  function newton(devs, Z, k, v0K, guess, t, stats) {
    const v = guess.slice(), I = new Array(k).fill(0), dI = new Array(k).fill(0);
    for (let it = 0; it < 60; it++) {
      for (let j = 0; j < k; j++) { const r = devs[j].dev.i(v[j], t); I[j] = r[0]; dI[j] = r[1]; }
      const F = new Array(k), J = new Array(k * k);
      let worst = 0;
      for (let r = 0; r < k; r++) {
        let s = v[r] - v0K[r];
        for (let c = 0; c < k; c++) { s += Z[r * k + c] * I[c]; J[r * k + c] = Z[r * k + c] * dI[c] + (r === c ? 1 : 0); }
        F[r] = -s; worst = Math.max(worst, Math.abs(s));
      }
      stats.iterations++;
      if (worst < 1e-9) return {v, I};
      const dv = solveSmall(J, F, k);
      // Damp large steps (the I-V tables are steep beyond the clamps).
      let scale = 1;
      for (const x of dv) if (Math.abs(x) * scale > 0.5) scale = 0.5 / Math.abs(x);
      for (let j = 0; j < k; j++) v[j] += dv[j] * scale;
    }
    stats.nonConverged++;
    for (let j = 0; j < k; j++) I[j] = devs[j].dev.i(v[j], t)[0];
    return {v, I};
  }

  // Ring buffer of past samples for one line end; read(x) interpolates at fractional step x.
  function ring(len, v0, i0) {
    const V = new Float64Array(len).fill(v0), I = new Float64Array(len).fill(i0);
    return {
      put(step, v, i) { const k = step % len; V[k] = v; I[k] = i; },
      read(x) { // x may be negative (before t = 0): the DC state
        if (x <= 0) return [v0, i0];
        const lo = Math.floor(x), f = x - lo, a = lo % len, b = (lo + 1) % len;
        return f ? [V[a] + (V[b] - V[a]) * f, I[a] + (I[b] - I[a]) * f] : [V[a], I[a]];
      }
    };
  }

  // ------------------------------------------------------------------ simulation
  // opts: {dt, tstop, probes: [node], chunk (steps per yield), dc: true}
  function* run(ckt, opts) {
    const n = ckt.n, dt = opts.dt, steps = Math.ceil(opts.tstop / dt);
    if (!(dt > 0) || !(steps > 0)) throw Error("Choose a positive time step and stop time.");
    if (steps > 2e6) throw Error("The simulation needs more than 2 million steps; shorten it or lengthen the step.");
    if (n > 3000) throw Error("The circuit has more than 3000 nodes.");
    const t0 = Date.now(), stats = {nodes: n, elements: ckt.el.length, devices: ckt.devices.length, steps, iterations: 0, nonConverged: 0, ms: 0, invertMs: 0};
    if (!opts.dcOnly) for (const e of ckt.el) if ((e.k === "T" && e.td < dt * (1 - 1e-9)) || (e.k === "T2" && Math.min(e.te, e.to) < dt * (1 - 1e-9))) throw Error("Line " + (e.tag || "") + " is shorter than one time step; model it as lumped.");
    const devs = ckt.devices, k = devs.length, K = devs.map(d => d.a);

    // ---- DC operating point
    const Gdc = new Float64Array(n * n);
    for (let i = 0; i < n; i++) Gdc[i * n + i] += GMIN;
    const rhsDC = new Float64Array(n);
    for (const e of ckt.el) {
      if (e.k === "R") stamp(Gdc, n, e.a, e.b, e.g);
      else if (e.k === "L" || e.k === "T") stamp(Gdc, n, e.a, e.b, SHORT);
      else if (e.k === "T2") { stamp(Gdc, n, e.a1, e.b1, SHORT); stamp(Gdc, n, e.a2, e.b2, SHORT); }
      else if (e.k === "V") { stamp(Gdc, n, e.a, GND, e.g); rhsDC[e.a] += e.fn(0) * e.g; }
    }
    let ti = Date.now();
    const Zdc = invert(Gdc, n);
    stats.invertMs += Date.now() - ti;
    const mul = (Zi, rhs, out) => { for (let r = 0; r < n; r++) { let s = 0; const o = r * n; for (let c = 0; c < n; c++) s += Zi[o + c] * rhs[c]; out[r] = s; } return out; };
    const v = mul(Zdc, rhsDC, new Float64Array(n));
    const ZKK = Z => { const m = new Array(k * k); for (let r = 0; r < k; r++) for (let c = 0; c < k; c++) m[r * k + c] = Z[K[r] * n + K[c]]; return m; };
    if (k) {
      const sol = newton(devs, ZKK(Zdc), k, K.map(a => v[a]), K.map(a => v[a]), 0, stats);
      for (let r = 0; r < n; r++) { let s = 0; for (let j = 0; j < k; j++) s += Zdc[r * n + K[j]] * sol.I[j]; v[r] -= s; }
    }
    const V = (x, a) => (a >= 0 ? x[a] : 0);
    if (opts.dcOnly) return {dc: Float64Array.from(v), stats};

    // ---- transient matrix and element states
    const G = new Float64Array(n * n);
    for (let i = 0; i < n; i++) G[i * n + i] += GMIN;
    const state = [];
    for (const e of ckt.el) {
      if (e.k === "R") stamp(G, n, e.a, e.b, e.g);
      else if (e.k === "V") stamp(G, n, e.a, GND, e.g);
      else if (e.k === "C") { const g = 2 * e.c / dt; stamp(G, n, e.a, e.b, g); state.push({e, g, h: g * (V(v, e.a) - V(v, e.b))}); }
      else if (e.k === "L") {
        const g = dt / (2 * e.l), i0 = (V(v, e.a) - V(v, e.b)) * SHORT;
        stamp(G, n, e.a, e.b, g); state.push({e, g, h: i0});
      } else if (e.k === "T") {
        const g = 1 / e.z, va = V(v, e.a), vb = V(v, e.b), i0 = (va - vb) * SHORT, len = Math.ceil(e.td / dt) + 3;
        stamp(G, n, e.a, GND, g); stamp(G, n, e.b, GND, g);
        state.push({e, g, ra: ring(len, va, i0), rb: ring(len, vb, -i0), lag: e.td / dt});
      } else if (e.k === "T2") {
        const ye = 1 / e.ze, yo = 1 / e.zo, y11 = (ye + yo) / 2, y12 = (ye - yo) / 2;
        for (const [p, q] of [[e.a1, e.a2], [e.b1, e.b2]]) {
          if (p >= 0) G[p * n + p] += y11; if (q >= 0) G[q * n + q] += y11;
          if (p >= 0 && q >= 0) { G[p * n + q] += y12; G[q * n + p] += y12; }
        }
        const i1 = (V(v, e.a1) - V(v, e.b1)) * SHORT, i2 = (V(v, e.a2) - V(v, e.b2)) * SHORT;
        const m = (x, y) => [(x + y) * SQ, (x - y) * SQ];
        const [vae, vao] = m(V(v, e.a1), V(v, e.a2)), [vbe, vbo] = m(V(v, e.b1), V(v, e.b2)), [ie, io] = m(i1, i2);
        const le = Math.ceil(e.te / dt) + 3, lo = Math.ceil(e.to / dt) + 3;
        state.push({e, ye, yo, rae: ring(le, vae, ie), rbe: ring(le, vbe, -ie), rao: ring(lo, vao, io), rbo: ring(lo, vbo, -io), lage: e.te / dt, lago: e.to / dt});
      }
    }
    ti = Date.now();
    const Z = invert(G, n);
    stats.invertMs += Date.now() - ti;
    const Zk = ZKK(Z);

    const probes = opts.probes || [];
    const rec = probes.map(() => new Float64Array(steps + 1));
    const time = new Float64Array(steps + 1);
    probes.forEach((p, j) => { rec[j][0] = V(v, p); });
    const rhs = new Float64Array(n), v0 = new Float64Array(n);
    let guess = K.map(a => v[a]);
    const chunk = opts.chunk || 2000;
    for (let s = 1; s <= steps; s++) {
      const t = s * dt;
      rhs.fill(0);
      // Sources and history currents.
      for (const e of ckt.el) if (e.k === "V") rhs[e.a] += e.fn(t) * e.g;
      for (const st of state) {
        const e = st.e;
        if (e.k === "C") { if (e.a >= 0) rhs[e.a] += st.h; if (e.b >= 0) rhs[e.b] -= st.h; }
        else if (e.k === "L") { if (e.a >= 0) rhs[e.a] -= st.h; if (e.b >= 0) rhs[e.b] += st.h; }
        else if (e.k === "T") {
          const x = s - st.lag, [vb, ib] = st.rb.read(x), [va, ia] = st.ra.read(x);
          st.ha = vb * st.g + ib; st.hb = va * st.g + ia;
          if (e.a >= 0) rhs[e.a] += st.ha; if (e.b >= 0) rhs[e.b] += st.hb;
        } else {
          const xe = s - st.lage, xo = s - st.lago;
          const [vbe, ibe] = st.rbe.read(xe), [vae, iae] = st.rae.read(xe), [vbo, ibo] = st.rbo.read(xo), [vao, iao] = st.rao.read(xo);
          st.hae = vbe * st.ye + ibe; st.hbe = vae * st.ye + iae; st.hao = vbo * st.yo + ibo; st.hbo = vao * st.yo + iao;
          const add = (p, x) => { if (p >= 0) rhs[p] += x; };
          add(e.a1, (st.hae + st.hao) * SQ); add(e.a2, (st.hae - st.hao) * SQ);
          add(e.b1, (st.hbe + st.hbo) * SQ); add(e.b2, (st.hbe - st.hbo) * SQ);
        }
      }
      mul(Z, rhs, v0);
      if (k) {
        const sol = newton(devs, Zk, k, K.map(a => v0[a]), guess, t, stats);
        guess = sol.v;
        for (let r = 0; r < n; r++) { let x = v0[r]; for (let j = 0; j < k; j++) x -= Z[r * n + K[j]] * sol.I[j]; v[r] = x; }
      } else v.set(v0);
      // Update element states.
      for (const st of state) {
        const e = st.e;
        if (e.k === "C") { const u = V(v, e.a) - V(v, e.b), i = st.g * u - st.h; st.h = st.g * u + i; }
        else if (e.k === "L") { const u = V(v, e.a) - V(v, e.b), i = st.g * u + st.h; st.h = i + st.g * u; }
        else if (e.k === "T") {
          const va = V(v, e.a), vb = V(v, e.b);
          st.ra.put(s, va, va * st.g - st.ha); st.rb.put(s, vb, vb * st.g - st.hb);
        } else {
          const m = (x, y) => [(x + y) * SQ, (x - y) * SQ];
          const [vae, vao] = m(V(v, e.a1), V(v, e.a2)), [vbe, vbo] = m(V(v, e.b1), V(v, e.b2));
          st.rae.put(s, vae, vae * st.ye - st.hae); st.rbe.put(s, vbe, vbe * st.ye - st.hbe);
          st.rao.put(s, vao, vao * st.yo - st.hao); st.rbo.put(s, vbo, vbo * st.yo - st.hbo);
        }
      }
      time[s] = t;
      for (let j = 0; j < probes.length; j++) rec[j][s] = V(v, probes[j]);
      if (s % chunk === 0 && s < steps) yield {progress: s / steps};
    }
    stats.ms = Date.now() - t0;
    return {t: time, v: rec, stats, dc: Float64Array.from(v)};
  }
  // Drain the generator.
  function simulate(ckt, opts) {
    const g = run(ckt, opts);
    for (;;) { const r = g.next(); if (r.done) return r.value; }
  }
  // DC operating point only (used for the settled levels of each driver state).
  function dc(ckt) {
    const r = run(ckt, {dt: 1, tstop: 1, probes: [], dcOnly: true}).next();
    return r.value.dc;
  }

  // ------------------------------------------------------------------ waveforms and metrics
  const at = (t, y, x) => {
    if (x <= t[0]) return y[0];
    const n = t.length;
    if (x >= t[n - 1]) return y[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] > x) hi = m; else lo = m; }
    return y[lo] + (y[hi] - y[lo]) * (x - t[lo]) / (t[hi] - t[lo]);
  };
  // Times y crosses level (interpolated); dir +1 rising, −1 falling, 0 either.
  function crossings(t, y, level, dir = 0, from = 0) {
    const out = [];
    for (let i = 1; i < y.length; i++) {
      if (t[i] < from) continue;
      const a = y[i - 1] - level, b = y[i] - level;
      if ((a < 0 && b >= 0 && dir >= 0) || (a > 0 && b <= 0 && dir <= 0)) out.push(t[i - 1] + (t[i] - t[i - 1]) * (a / (a - b)));
    }
    return out;
  }
  // Metrics for one edge. o: {edge: "rise"|"fall", t0, vlow, vhigh, vinl, vinh, vmeas, settle (fraction), tref}
  function measure(t, y, o) {
    const rise = o.edge !== "fall";
    // Work on a rising edge: mirror a falling one about the levels.
    const lo = o.vlow, hi = o.vhigh, swing = hi - lo;
    const f = rise ? x => x : x => lo + hi - x;
    const vinl = rise ? o.vinl : lo + hi - o.vinh, vinh = rise ? o.vinh : lo + hi - o.vinl;
    const from = o.t0 || 0, to = o.t1 ?? t[t.length - 1];
    let max = -Infinity, min = Infinity, tmax = from;
    const yy = new Float64Array(y.length);
    for (let i = 0; i < y.length; i++) yy[i] = f(y[i]);
    for (let i = 0; i < y.length; i++) if (t[i] >= from && t[i] <= to) { if (yy[i] > max) { max = yy[i]; tmax = t[i]; } if (yy[i] < min) min = yy[i]; }
    const up = crossings(t, yy, vinh, +1, from).filter(x => x <= to), upL = crossings(t, yy, vinl, +1, from).filter(x => x <= to), any = crossings(t, yy, vinh, 0, from).filter(x => x <= to);
    const meas = crossings(t, yy, rise ? o.vmeas : lo + hi - o.vmeas, +1, from).filter(x => x <= to);
    // Ringback: the lowest value after first passing Vinh.
    // Ringback: the lowest value after the first peak that follows the first Vinh crossing.
    let ringMin = Infinity;
    if (up.length) {
      let k = 0;
      while (k < yy.length - 1 && t[k] <= up[0]) k++;
      const eps = 1e-4 * Math.abs(swing);
      while (k < yy.length - 1 && t[k + 1] <= to && yy[k + 1] >= yy[k] - eps) k++;
      for (let i = k; i < yy.length && t[i] <= to; i++) if (yy[i] < ringMin) ringMin = yy[i];
      if (ringMin === Infinity) ringMin = yy[k];
    }
    // Monotonic through the threshold region.
    let mono = true, peak = -Infinity;
    const tol = Math.max(0.01 * Math.abs(swing), 0.005);
    for (let i = 0; i < yy.length; i++) {
      if (t[i] < from || t[i] > to) continue;
      if (yy[i] > peak) peak = yy[i];
      if (yy[i] > vinl && yy[i] < vinh && peak - yy[i] > tol && peak > vinl) { mono = false; break; }
    }
    // Settling: the last time outside ±settle·swing around the final level.
    const band = (o.settle ?? 0.05) * Math.abs(swing);
    let last = null;
    for (let i = yy.length - 1; i > 0; i--) if (t[i] <= to && Math.abs(yy[i] - hi) > band) { last = t[Math.min(yy.length - 1, i + 1)]; break; }
    const settled = last === null ? from : last < to - 1e-15 ? last : null;
    const tref = o.tref ?? from;
    const back = x => (rise ? x : lo + hi - x);
    return {
      edge: rise ? "rise" : "fall", vlow: lo, vhigh: hi, swing,
      max: back(rise ? max : min), min: back(rise ? min : max), tPeak: tmax,
      overshoot: max - hi, overshootPct: swing ? 100 * (max - hi) / Math.abs(swing) : 0,
      undershoot: lo - min, // below the starting rail (a falling edge's value is measured above its rail)
      ringback: up.length ? ringMin - vinh : null, // margin above Vinh after first crossing; < 0 re-enters the threshold region
      reachesVinh: up.length > 0, reachesVinl: upL.length > 0,
      monotonic: mono, settle: settled === null ? null : settled - from,
      tVinl: upL.length ? upL[0] - tref : null, tVinh: up.length ? (any.length ? Math.max(...any) : up[up.length - 1]) - tref : null,
      tMeas: meas.length ? meas[0] : null, crossings: any.length
    };
  }
  // Peak (signed, largest magnitude) of y relative to its starting value, inside [from, to].
  function peak(t, y, from = 0, to = Infinity) {
    let best = 0, tb = from;
    const base = y[0];
    for (let i = 0; i < y.length; i++) if (t[i] >= from && t[i] <= to && Math.abs(y[i] - base) > Math.abs(best)) { best = y[i] - base; tb = t[i]; }
    return {v: best, t: tb};
  }
  // Fewer points for display: min/max per bucket so peaks survive.
  function decimate(t, ys, points = 1200, lo = -Infinity, hi = Infinity) {
    const idx = [];
    for (let i = 0; i < t.length; i++) if (t[i] >= lo && t[i] <= hi || (t[i + 1] >= lo && t[i] < lo) || (t[i - 1] <= hi && t[i] > hi)) idx.push(i);
    if (idx.length <= points) return {t: idx.map(i => t[i]), ys: ys.map(y => idx.map(i => y[i]))};
    const per = Math.ceil(idx.length / (points / 2)), keep = [];
    for (let k = 0; k < idx.length; k += per) {
      const end = Math.min(idx.length, k + per), set = new Set([idx[k], idx[end - 1]]);
      for (const y of ys) { let mn = idx[k], mx = idx[k]; for (let j = k; j < end; j++) { if (y[idx[j]] < y[mn]) mn = idx[j]; if (y[idx[j]] > y[mx]) mx = idx[j]; } set.add(mn); set.add(mx); }
      keep.push(...[...set].sort((a, b) => a - b));
    }
    return {t: keep.map(i => t[i]), ys: ys.map(y => keep.map(i => y[i]))};
  }

  const api = {version: "1.0.0", GND, Circuit, run, simulate, dc, invert, measure, crossings, peak, at, decimate};
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof globalThis === "object" && globalThis) globalThis.AtriumSISolver = api;
})();
