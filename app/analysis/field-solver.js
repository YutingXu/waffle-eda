"use strict";
if (!globalThis.AtriumWorkerPool && typeof require === "function") require("../workers/worker-pool.js");
// AtriumFieldSolver: 2D quasi-static (quasi-TEM) transmission-line field solver.
// Clean-room implementation from textbook physics (no third-party solver code).
//
// Method
//  * Laplace's equation div(eps grad V) = 0 on the cross-section, discretised by
//    box integration (finite volumes; Varga, "Matrix Iterative Analysis", 1962) on a
//    graded rectangular mesh. Permittivity is constant per cell; each node couples to
//    its four neighbours with sum(eps_cell * half-face / spacing), so normal D is
//    continuous across dielectric interfaces that lie on mesh lines (all of them do:
//    every interface, conductor face and ground plane is a mesh line).
//  * Mesh: key coordinates (conductor corners, interfaces, planes, box walls) each with a
//    target size; the size grows geometrically away from every key (ratio 1.1 near the
//    structure, 1.3 beyond twice its size at "normal"). Strip corners get feature/300.
//  * Conductors are Dirichlet nodes (1 V on the driven signal, 0 V elsewhere). Etched
//    (trapezoidal) strips are staircased on the mesh. Zero-thickness strips are a row
//    of nodes.
//  * Linear solver: conjugate gradients (Hestenes & Stiefel 1952) with a modified
//    incomplete Cholesky MIC(0) preconditioner (Gustafsson 1978); the vacuum solution
//    warm-starts the dielectric one.
//  * Capacitance from the discrete field energy, C_kl = eps0 sum_e a_e dV_k dV_l
//    (variational: second-order in the potential error; Harrington, "Field Computation
//    by Moment Methods", 1968; Silvester & Ferrari, "Finite Elements for Electrical
//    Engineers"). Maxwell matrices C (with dielectrics) and C0 (vacuum):
//      L = mu0 eps0 C0^-1,  Z0 = 1/(c sqrt(C C0)),  eps_eff = C/C0,  delay = sqrt(eps_eff)/c.
//    Pairs: Codd = C11 - C12, Ceven = C11 + C12 (likewise C0); Zdiff = 2 Zodd,
//    Zcommon = Zeven/2; kb = (Cm/C + Lm/L)/4, kf = (Cm/C - Lm/L)/2 (FEXT =
//    kf * length * delay / rise time; kfPsPerMm = kf * delay). Asymmetric pairs use
//    line 1's modal values; use the matrices for exact modal analysis.
//  * Open boundaries: a grounded box (Dirichlet) at 40x the structure size ("normal";
//    25x fast, 60x fine) for open-top structures, reached with a coarse graded mesh.
//    The box adds less than 0.05 % to C for a microstrip (measured: halving the
//    margin to 20x moves Z0 by -0.13 %, the error scales as 1/margin^2). Between two
//    planes the side walls sit 5 plane spacings away (field decays as exp(-pi x / b)).
//  * Conductor loss: the quasi-TEM surface current follows the vacuum surface charge,
//    J_s/I = rho_s/Q (Collin, "Foundations for Microwave Engineering", 1992, 3.x;
//    the same field as Wheeler's 1942 incremental-inductance rule), so
//    R = Rs sum (rho_s/Q)^2 ds over signal and ground surfaces, Rs = sqrt(pi f mu0/sigma),
//    alpha_c = R / (2 Z) (per line of the mode), times a roughness factor:
//    Hammerstad-Jensen (1980), Groisse (1996) or Huray snowball (2010).
//    Valid when the copper is a few skin depths thick; t = 0 strips give a mesh-dependent
//    value (warned).
//  * Dielectric loss: G = omega eps0 sum_cells eps tanD |grad V|^2 (energy-weighted),
//    alpha_d = G Z / 2. Optional causal Djordjevic-Sarkar dispersion (2001) re-solves
//    with eps(f) of every dielectric fitted to (er, tanD) at fRef.
//
// Units: lengths mm; f GHz; Z ohm; C pF/mm, L nH/mm, R ohm/mm, G S/mm; delay ps/mm;
// alpha dB/mm; roughness parameters um (Huray tile area um^2); sigma S/m.
//
// Geometry keys (same as AtriumImpedance.solve): structure "microstrip" | "stripline" |
// "cpwg" | "coupled-microstrip" | "coupled-stripline" | "cpwg-diff" (or "microstrip" /
// "stripline" with s > 0 for a pair and g > 0 for coplanar ground, as AtriumImpedance),
// w (bottom width), s (pair gap), g (coplanar gap), gw (side-ground width, default
// max(10 h, 3 w, 6 g)), h (microstrip substrate), h1 / h2 (stripline dielectric above /
// below the strip; er1 / er2 optional), t, er, tanD (default 0.02), cover {t, er, tanD}
// (conformal solder mask / coverlay over the substrate and the traces), etch (IPC etch
// factor E = t / undercut per side, as stackup.js draws it: top width = w - 2 t / E;
// AtriumImpedance's closed forms use the mean width w - t / E, which is the same
// trapezoid), freq (GHz) and rough (rms, mm) as AtriumImpedance.
// Generic form: {conductors:[{x0, x1, y, t, role:"signal"|"ground", wt? | xt0?, xt1? | etch?}],
//   dielectrics:[{y0, y1, er, tanD, x0?, x1?}] (later entries paint over earlier ones),
//   coats:[{t, er, tanD, ySurf}], groundPlanes:[y, ...]} (y up, x across).
//
// API (DOM-free; plain and typed arrays only, so the core can move to Rust/WASM):
//   AtriumFieldSolver.solve(geom, {quality:"fast"|"normal"|"fine", fGHz, sigma,
//       roughness:{model:"hammerstad"|"groisse"|"huray", rq | radius, N, Ahex, ratio, sr},
//       dispersion:"djordjevic-sarkar", fRef})
//     -> {ok, z, z0, eeff, delay, zodd, zeven, zdiff, zcommon, eeffOdd, eeffEven, kb, kf,
//         kfPsPerMm, matrices:{C, L, G, R, C0}, loss:{alpha_c, alpha_d, total,
//         roughnessFactor}, alpha_c, alpha_d, mesh:{nx, ny, nodes, iterations}, ms, warnings}
//     z is Zdiff for pairs (as AtriumImpedance), else Z0. For pairs eeff/delay are the
//     odd mode and z0 = sqrt(Zodd Zeven).
//   AtriumFieldSolver.async(geom, opts)  -> Promise of solve(): Blob worker, then
//     field-solver-worker.js, then synchronous on a later tick (no Worker, e.g. JSC).
//   AtriumFieldSolver.compare(geom, opts) -> {solver, closedForm, deltaPct}
//   AtriumFieldSolver.synthesize(geom, {target, vary:"w"|"s"|"g"|..., min, max, quality})
//     -> {ok, [vary], solves, result}: safeguarded secant on ln Z vs ln x.
//   AtriumFieldSolver.mesh(geom, {quality:"fast"}) -> {xs, ys, nx, ny, er (cells), owner
//     (nodes: -1 free, 0 ground, k+1 signal k), potential (Float32, signal 0 at 1 V), box, z}
//   AtriumFieldSolver.roughness.{hammerstad, groisse, huray}(fGHz, params) -> K >= 1
//   AtriumFieldSolver.dielectric.djordjevicSarkar({er, tanD, fRef GHz, f1 = 1e3 Hz,
//     f2 = 1e12 Hz}) -> fGHz => {er, tanD}
//
// Accuracy at quality "normal" (tests/field-solver.cjs checks these with the stated
// tolerances). Zero-thickness and exact cases converge from below (energy capacitance
// is an upper bound): about -0.3 % at "normal", -0.15 % at "fine", -1.2 % at "fast".
//
// | Case                                         | Reference                       | Ref.    | Solver  | Err %  |
// |----------------------------------------------|---------------------------------|---------|---------|--------|
// | Air microstrip w/h = 1, t = 0                 | Wheeler 1965 (exact)            | 126.510 | 126.064 | -0.35  |
// | Microstrip er 2.2, h 1.27, w 3.916: Z0        | Pozar Ex. 3.7                   |  50.000 |  49.874 | -0.25  |
// |   same: eps_eff (Pozar's approximate formula) | Pozar Ex. 3.7                   |   1.870 |   1.883 | +0.71  |
// | Stripline b 3.2, er 2.2, w 2.66               | Pozar Ex. 3.5                   |  50.000 |  49.799 | -0.40  |
// | Stripline t = 0, w/b = 0.1 (air)              | Cohn 1954 (exact)               | 194.361 | 193.885 | -0.24  |
// | Stripline t = 0, w/b = 0.3                    | Cohn 1954 (exact)               | 129.396 | 129.045 | -0.27  |
// | Stripline t = 0, w/b = 1                      | Cohn 1954 (exact)               |  65.399 |  65.201 | -0.30  |
// | Stripline t = 0, w/b = 3                      | Cohn 1954 (exact)               |  27.387 |  27.341 | -0.17  |
// | Coupled stripline t = 0, w/b 0.2, s/b 0.1 odd | Cohn 1955 (exact)               |  96.007 |  95.748 | -0.27  |
// |   same: even                                  | Cohn 1955 (exact)               | 203.677 | 203.326 | -0.17  |
// | Coupled stripline w/b 0.5, s/b 0.3 odd        | Cohn 1955 (exact)               |  86.332 |  86.096 | -0.27  |
// |   same: even                                  | Cohn 1955 (exact)               | 112.845 | 112.637 | -0.18  |
// | Coupled stripline w/b 1, s/b 0.5 odd          | Cohn 1955 (exact)               |  62.200 |  62.054 | -0.23  |
// |   same: even                                  | Cohn 1955 (exact)               |  68.243 |  68.120 | -0.18  |
// | Stripline w/b 0.2, t/b 0.05 (air)             | Wheeler 1978 (+/-0.5 %)         | 132.275 | 132.152 | -0.09  |
// | Stripline w/b 0.5, t/b 0.1                    | Wheeler 1978                    |  83.015 |  83.016 |  0.00  |
// | Stripline w/b 1, t/b 0.2                      | Wheeler 1978                    |  48.272 |  48.500 | +0.47  |
// | Coupled microstrip w/h 0.5, s/h 0.5, er 4.3 odd | Kirschning-Jansen 1984 (+/-1 %) |  69.564 |  69.583 | +0.03  |
// |   same: even                                  | Kirschning-Jansen 1984          | 121.093 | 121.027 | -0.05  |
// | Coupled microstrip w/h 1, s/h 0.3, er 4.3 odd | Kirschning-Jansen 1984          |  48.118 |  48.131 | +0.03  |
// |   same: even                                  | Kirschning-Jansen 1984          |  91.011 |  90.897 | -0.13  |
// | Coupled microstrip w/h 2, s/h 1, er 9.8 odd   | Kirschning-Jansen 1984          |  29.650 |  29.610 | -0.13  |
// |   same: even                                  | Kirschning-Jansen 1984          |  37.094 |  36.988 | -0.29  |
// | Coupled microstrip w/h 0.3, s/h 2, er 2.2 odd | Kirschning-Jansen 1984          | 139.704 | 139.798 | +0.07  |
// |   same: even                                  | Kirschning-Jansen 1984          | 161.449 | 160.821 | -0.39  |
// | CPWG w 0.3, g 0.15, h 0.2, er 4.3             | Ghione-Naldi (Wadell 3.4.3)     |  54.196 |  53.787 | -0.76  |
// | CPWG w 0.2, g 0.1, h 0.4                      | Ghione-Naldi (Wadell 3.4.3)     |  70.215 |  69.921 | -0.42  |
// | CPWG w 0.5, g 0.2, h 0.2                      | Ghione-Naldi (Wadell 3.4.3)     |  41.400 |  40.976 | -1.02  |
// | Microstrip 8/5 mil, t 1.4 mil, er 4           | Hammerstad-Jensen 1980          |  53.758 |  53.760 |  0.00  |
// | Microstrip w .15 h .1 t .035, 5 GHz: alpha_c  | Wheeler incr. inductance (mdB/mm) |  7.513 |   7.023 | -6.5   |
// |   same: alpha_d                               | Pozar 3.30 filling factor       |  13.127 |  12.828 | -2.3   |
// | Stripline w .15 b .435, 5 GHz: alpha_c        | Wheeler incr. inductance        |   6.921 |   6.585 | -4.9   |
// |   same: alpha_d                               | Pozar (exact for stripline)     |  18.205 |  18.204 |  0.00  |
// Conductor loss converges slowly from below (corner charge, rho ~ r^-1/3): -11 % fast,
// -6 % normal, -4.6 % fine against Wheeler's rule for the microstrip above. The microstrip
// alpha_d differs from Pozar's formula because that formula freezes the filling factor;
// the energy-weighted G is the exact quasi-static value. Solder mask (0.5 mil, er 3.3 on
// the 8/5 mil line) lowers Z0 by 3.0 %; etch factor 2 raises it by 2.1 %.
//
// Timings, macOS JavaScriptCore, after JIT warm-up (first call within 10 %):
//   quality   microstrip  stripline  CPWG   coupled ms  coupled sl  CPWG-diff
//   fast        11 ms       6 ms      9 ms     8 ms        6 ms       16 ms
//   normal      29 ms      19 ms     56 ms   105 ms       82 ms      169 ms
//   fine       210 ms     120 ms    330 ms   780 ms      480 ms     1030 ms
//   (t = 35 um copper; meshes of 36k-86k nodes at normal.)

function AtriumFieldSolverFactory() {
  "use strict";
  const PI = Math.PI, ETA0 = 376.730313668, C_MM_NS = 299.792458, MU0 = 4e-7 * PI, EPS0 = 8.8541878128e-12;
  const PS_PER_MM = 1000 / C_MM_NS, SIGMA_CU = 5.8e7, NP_DB = 8.685889638;
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  const fin = Number.isFinite;
  const pos = v => typeof v === "number" ? v > 0 : +v > 0;

  const QUALITY = {
    fast:   {edge: 1 / 60,   ratio: 1.2,  near: 1, far: 1.4, div: 3, margin: 25, tol: 1e-4},
    normal: {edge: 1 / 300,  ratio: 1.1,  near: 2, far: 1.3, div: 5, margin: 40, tol: 1e-5},
    fine:   {edge: 1 / 1000, ratio: 1.07, near: 4, far: 1.2, div: 8, margin: 60, tol: 1e-7}
  };

  // ------------------------------------------------------------------ geometry
  function conductor(x0, x1, y, t, etch, role, name) {
    t = t > 0 ? +t : 0;
    const w = x1 - x0;
    const cut = etch > 0 && t > 0 ? Math.min(t / etch, 0.475 * w) : 0;
    return {x0, x1, xt0: x0 + cut, xt1: x1 - cut, y, t, role, name};
  }
  function normalize(geom) {
    const g = geom || {};
    if (Array.isArray(g.conductors)) return generic(g);
    let st = String(g.structure || "microstrip");
    const s = pos(g.s) ? +g.s : 0, cg = pos(g.g) ? +g.g : 0;
    if (st === "microstrip" && s > 0) st = cg > 0 ? "cpwg-diff" : "coupled-microstrip";
    else if (st === "microstrip" && cg > 0) st = "cpwg";
    else if (st === "stripline" && s > 0) st = cg > 0 ? "coupled-stripline-cpw" : "coupled-stripline";
    else if (st === "stripline" && cg > 0) st = "stripline-cpw";
    const w = +g.w, t = pos(g.t) ? +g.t : 0, er = pos(g.er) ? +g.er : 1, tanD = g.tanD >= 0 ? +g.tanD : 0.02, etch = pos(g.etch) ? +g.etch : 0;
    if (!(w > 0)) throw Error("Trace width w is required.");
    const pair = /coupled|diff/.test(st), cop = /cpw/.test(st);
    if (pair && !(s > 0)) throw Error("Pair gap s is required.");
    if (cop && !(cg > 0)) throw Error("Coplanar ground gap g is required.");
    const out = {structure: st, conductors: [], dielectrics: [], coats: [], planes: [], pair, cop};
    let ySig, h;
    if (/stripline/.test(st)) {
      const h1 = +g.h1, h2 = +g.h2;
      if (!(h1 > 0 && h2 > 0)) throw Error("Stripline heights h1 (above) and h2 (below) are required.");
      const b = h1 + h2 + t, er1 = pos(g.er1) ? +g.er1 : er, er2 = pos(g.er2) ? +g.er2 : er;
      ySig = h2; h = Math.min(h1, h2);
      out.dielectrics.push({x0: -Infinity, x1: Infinity, y0: 0, y1: h2 + t / 2, er: er2, tanD: g.tanD2 >= 0 ? +g.tanD2 : tanD});
      out.dielectrics.push({x0: -Infinity, x1: Infinity, y0: h2 + t / 2, y1: b, er: er1, tanD: g.tanD1 >= 0 ? +g.tanD1 : tanD});
      if (er1 !== er2) out.dielectrics[0].y1 = out.dielectrics[1].y0 = h2 + t;
      out.planes.push(0, b);
    } else {
      h = +g.h;
      if (!(h > 0)) throw Error("Substrate height h is required.");
      ySig = h;
      out.dielectrics.push({x0: -Infinity, x1: Infinity, y0: 0, y1: h, er, tanD});
      out.planes.push(0);
    }
    if (pair) {
      out.conductors.push(conductor(-s / 2 - w, -s / 2, ySig, t, etch, "signal", "P"));
      out.conductors.push(conductor(s / 2, s / 2 + w, ySig, t, etch, "signal", "N"));
    } else out.conductors.push(conductor(-w / 2, w / 2, ySig, t, etch, "signal", "S"));
    if (cop) {
      const half = pair ? s / 2 + w : w / 2, gw = pos(g.gw) ? +g.gw : pos(g.groundWidth) ? +g.groundWidth : Math.max(10 * h, 3 * w, 6 * cg);
      out.conductors.unshift(conductor(-half - cg - gw, -half - cg, ySig, t, etch, "ground", "GL"));
      out.conductors.push(conductor(half + cg, half + cg + gw, ySig, t, etch, "ground", "GR"));
    }
    const cover = g.cover && pos(g.cover.t) ? g.cover : null;
    if (cover && !/stripline/.test(st)) {
      out.coats.push({c: +cover.t, er: pos(cover.er) ? +cover.er : 3.5, tanD: cover.tanD >= 0 ? +cover.tanD : 0.02, ySurf: h, around: out.conductors.map((_, i) => i)});
    }
    return finishProblem(out);
  }
  // Generic cross-section: {conductors:[{x0, x1, wt?|xt0?,xt1?|etch?, y, t, role}], dielectrics:[{y0, y1, er, tanD, x0?, x1?}], groundPlanes:[y]}
  function generic(g) {
    const out = {structure: "generic", conductors: [], dielectrics: [], coats: [], planes: [], pair: false, cop: false};
    for (const [i, c] of g.conductors.entries()) {
      const x0 = +c.x0, x1 = +c.x1, y = +c.y || 0, t = pos(c.t) ? +c.t : 0;
      if (!(x1 > x0)) throw Error("Conductor " + i + " needs x1 > x0.");
      const k = conductor(x0, x1, y, t, pos(c.etch) ? +c.etch : g.etch, c.role === "ground" ? "ground" : "signal", c.name || "C" + i);
      if (pos(c.wt)) {const cut = Math.max(0, (x1 - x0 - c.wt) / 2); k.xt0 = x0 + cut; k.xt1 = x1 - cut;}
      if (fin(c.xt0) && fin(c.xt1) && c.xt1 > c.xt0) {k.xt0 = +c.xt0; k.xt1 = +c.xt1;}
      out.conductors.push(k);
    }
    for (const d of g.dielectrics || []) {
      out.dielectrics.push({x0: fin(d.x0) ? +d.x0 : -Infinity, x1: fin(d.x1) ? +d.x1 : Infinity, y0: +d.y0, y1: +d.y1, er: pos(d.er) ? +d.er : 1, tanD: d.tanD >= 0 ? +d.tanD : (pos(d.er) && d.er > 1 ? 0.02 : 0)});
    }
    for (const c of g.coats || []) out.coats.push({c: +c.t, er: +c.er || 3.5, tanD: c.tanD >= 0 ? +c.tanD : 0.02, ySurf: +c.ySurf, around: out.conductors.map((_, i) => i)});
    for (const y of g.groundPlanes || []) out.planes.push(+y);
    const sig = out.conductors.filter(c => c.role === "signal").length;
    if (!sig) throw Error("At least one signal conductor is required.");
    out.pair = sig === 2;
    return finishProblem(out);
  }
  function finishProblem(p) {
    p.planes = [...new Set(p.planes)].sort((a, b) => a - b);
    const cy0 = Math.min(...p.conductors.map(c => c.y)), cy1 = Math.max(...p.conductors.map(c => c.y + c.t));
    p.bottomPlane = p.planes.some(y => y <= cy0 + 1e-12);
    p.topPlane = p.planes.some(y => y >= cy1 - 1e-12);
    p.signals = p.conductors.map((c, i) => c.role === "signal" ? i : -1).filter(i => i >= 0);
    return p;
  }

  // ------------------------------------------------------------------ mesh
  // Graded tensor-product mesh. Each axis gets key coordinates (conductor
  // edges, interfaces, planes, box walls) with a target size h_k at the key;
  // the local size is min_k(h_k + (r - 1) |x - x_k|) (geometric grading away
  // from every key), so the corners where the field is singular are resolved
  // finely while far regions stay coarse.
  function axis(keys, ratio, near, ratioFar) {
    keys.sort((a, b) => a.p - b.p);
    const merged = [];
    for (const k of keys) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(k.p - last.p) <= 1e-9 * (1 + Math.abs(k.p))) last.h = Math.min(last.h, k.h);
      else merged.push({p: k.p, h: k.h});
    }
    // Growth (r - 1) near the keys, a faster one beyond `near` (the
    // structure's own scale), where the field is smooth.
    const gr = ratio - 1, gf = Math.max(gr, ratioFar - 1);
    const size = x => {
      let s = Infinity;
      for (const k of merged) {const d = Math.abs(x - k.p), v = k.h + (d < near ? gr * d : gr * near + gf * (d - near)); if (v < s) s = v;}
      return s;
    };
    const out = [merged[0].p];
    for (let i = 0; i + 1 < merged.length; i++) {
      const a = merged[i].p, b = merged[i + 1].p, march = [a];
      let x = a;
      while (x < b) {x += size(x); march.push(x);}
      let n = march.length - 1;
      if (n > 1 && march[n] - b > 0.5 * (march[n] - march[n - 1])) {n--; march.length = n + 1;}
      const span = march[n] - a;
      for (let k = 1; k < n; k++) out.push(a + (march[k] - a) * (b - a) / span);
      out.push(b);
    }
    return Float64Array.from(out);
  }
  function inside(c, x, y, tol) {
    if (c.t === 0) return Math.abs(y - c.y) <= tol && x >= c.x0 - tol && x <= c.x1 + tol;
    if (y < c.y - tol || y > c.y + c.t + tol) return false;
    const f = Math.min(1, Math.max(0, (y - c.y) / c.t));
    return x >= c.x0 + (c.xt0 - c.x0) * f - tol && x <= c.x1 + (c.xt1 - c.x1) * f + tol;
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
    const u = l > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / l)) : 0;
    return Math.hypot(px - ax - u * dx, py - ay - u * dy);
  }
  function distTo(c, x, y) {
    if (inside(c, x, y, 0)) return 0;
    const P = [[c.x0, c.y], [c.x1, c.y], [c.xt1, c.y + c.t], [c.xt0, c.y + c.t]];
    let d = Infinity;
    for (let i = 0; i < 4; i++) d = Math.min(d, segDist(x, y, P[i][0], P[i][1], P[(i + 1) % 4][0], P[(i + 1) % 4][1]));
    return d;
  }
  function buildMesh(p, quality) {
    const Q = QUALITY[quality] || QUALITY.normal;
    const cs = p.conductors;
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, feat = Infinity;
    for (const c of cs) {
      xmin = Math.min(xmin, c.x0, c.xt0); xmax = Math.max(xmax, c.x1, c.xt1);
      ymin = Math.min(ymin, c.y); ymax = Math.max(ymax, c.y + c.t);
      feat = Math.min(feat, c.x1 - c.x0, Math.max(c.xt1 - c.xt0, (c.x1 - c.x0) * 0.2));
      if (c.t > 0) feat = Math.min(feat, 2 * c.t);
    }
    const sorted = cs.slice().sort((a, b) => a.x0 - b.x0);
    for (let i = 1; i < sorted.length; i++) {const gap = sorted[i].x0 - sorted[i - 1].x1; if (gap > 0) feat = Math.min(feat, gap);}
    for (const y of p.planes) {ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); for (const c of cs) {const d = y < c.y ? c.y - y : y - c.y - c.t; if (d > 0) feat = Math.min(feat, 2 * d);}}
    for (const d of p.dielectrics) for (const y of [d.y0, d.y1]) {
      ymin = Math.min(ymin, y); ymax = Math.max(ymax, y);
      for (const c of cs) {const dd = Math.min(Math.abs(y - c.y), Math.abs(y - c.y - c.t)); if (dd > 0) feat = Math.min(feat, 2 * dd);}
    }
    for (const k of p.coats) {feat = Math.min(feat, 2 * k.c); ymax = Math.max(ymax, k.ySurf + k.c, ...cs.map(c => c.y + c.t + k.c));}
    const hEdge = feat * Q.edge, span = Math.max(xmax - xmin, ymax - ymin);
    const yBot = p.bottomPlane ? Math.min(...p.planes) : ymin - Q.margin * span;
    const yTop = p.topPlane ? Math.max(...p.planes) : ymax + Q.margin * span;
    const vert = yTop - yBot;
    const side = p.topPlane && p.bottomPlane ? Math.max(5 * vert, 2 * span) : Q.margin * span;
    const XL = xmin - side, XR = xmax + side;
    const xk = [{p: XL, h: side / 4}, {p: XR, h: side / 4}], yk = [{p: yBot, h: vert / 4}, {p: yTop, h: vert / 4}];
    // Edges far from every signal conductor (the outer edges of wide coplanar
    // grounds) carry little field and get a coarser key size.
    const sigs = cs.filter(c => c.role === "signal");
    const away = x => Math.min(...sigs.map(c => Math.max(0, Math.min(c.x0, c.xt0) - x, x - Math.max(c.x1, c.xt1))));
    for (const c of cs) {
      for (const x of [c.x0, c.x1, c.xt0, c.xt1]) xk.push({p: x, h: hEdge + 0.02 * away(x)});
      for (const y of [c.y, c.y + c.t]) yk.push({p: y, h: hEdge});
    }
    for (const y of p.planes) yk.push({p: y, h: Infinity});
    for (const d of p.dielectrics) {
      for (const y of [d.y0, d.y1]) if (y > yBot && y < yTop) yk.push({p: y, h: Infinity});
      for (const x of [d.x0, d.x1]) if (x > XL && x < XR) xk.push({p: x, h: Infinity});
    }
    for (const k of p.coats) {
      yk.push({p: k.ySurf + k.c, h: Infinity});
      for (const i of k.around) {const c = cs[i]; yk.push({p: c.y + c.t + k.c, h: Infinity}); xk.push({p: c.x0 - k.c, h: Infinity}, {p: c.x1 + k.c, h: Infinity});}
    }
    // Keys without a set size: a fraction of the neighbouring intervals.
    const fill = keys => {
      keys.sort((a, b) => a.p - b.p);
      for (let i = 0; i < keys.length; i++) if (!(keys[i].h < Infinity)) {
        let gap = Infinity;
        for (let j = i - 1; j >= 0; j--) if (keys[i].p - keys[j].p > 1e-12) {gap = Math.min(gap, keys[i].p - keys[j].p); break;}
        for (let j = i + 1; j < keys.length; j++) if (keys[j].p - keys[i].p > 1e-12) {gap = Math.min(gap, keys[j].p - keys[i].p); break;}
        keys[i].h = gap / Q.div;
      }
      return keys;
    };
    const xs = axis(fill(xk.filter(k => k.p >= XL && k.p <= XR)), Q.ratio, Q.near * span, Q.far), ys = axis(fill(yk.filter(k => k.p >= yBot && k.p <= yTop)), Q.ratio, Q.near * span, Q.far);
    const nx = xs.length, ny = ys.length, N = nx * ny;
    // Cell permittivity and loss tangent (cell (i, j) spans xs[i..i+1] x ys[j..j+1]).
    const er = new Float64Array((nx - 1) * (ny - 1)).fill(1), td = new Float64Array((nx - 1) * (ny - 1));
    const layer = new Int16Array((nx - 1) * (ny - 1)).fill(-1);
    for (let j = 0; j < ny - 1; j++) {
      const yc = (ys[j] + ys[j + 1]) / 2;
      for (let i = 0; i < nx - 1; i++) {
        const xc = (xs[i] + xs[i + 1]) / 2, n = j * (nx - 1) + i;
        for (let k = 0; k < p.dielectrics.length; k++) {
          const d = p.dielectrics[k];
          if (yc >= d.y0 && yc <= d.y1 && xc >= d.x0 && xc <= d.x1) {er[n] = d.er; td[n] = d.tanD; layer[n] = k;}
        }
        for (let k = 0; k < p.coats.length; k++) {
          const c = p.coats[k];
          if (yc < c.ySurf) continue;
          let hit = yc <= c.ySurf + c.c;
          if (!hit) for (const i2 of c.around) if (distTo(cs[i2], xc, yc) <= c.c) {hit = true; break;}
          if (hit) {er[n] = c.er; td[n] = c.tanD; layer[n] = p.dielectrics.length + k;}
        }
      }
    }
    // Node owners: -1 free, 0 grounded, k + 1 = signal k.
    const owner = new Int8Array(N).fill(-1);
    const tol = 1e-9 * (1 + span);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const n = j * nx + i;
      if (i === 0 || j === 0 || i === nx - 1 || j === ny - 1) {owner[n] = 0; continue;}
      const x = xs[i], y = ys[j];
      for (const yp of p.planes) if (Math.abs(y - yp) <= tol) owner[n] = 0;
      for (let k = 0; k < cs.length; k++) if (inside(cs[k], x, y, tol)) owner[n] = cs[k].role === "signal" ? p.signals.indexOf(k) + 1 : 0;
    }
    return {xs, ys, nx, ny, er, tanD: td, layer, owner, hEdge, box: [XL, XR, yBot, yTop]};
  }
  // Finite-volume coupling coefficients of the 5-point stencil: the edge
  // between nodes (i, j) and (i + 1, j) gets sum over its two adjacent cells
  // of eps_cell * (half cell height) / dx. This is the box-integration
  // discretisation of div(eps grad V) = 0 (Varga 1962; Wait & Mitchell),
  // which keeps the normal D continuous at dielectric interfaces on mesh lines.
  function coefficients(m, cellValue) {
    const {xs, ys, nx, ny} = m, ax = new Float64Array(nx * ny), ay = new Float64Array(nx * ny);
    for (let j = 0; j < ny - 1; j++) {
      const dy = ys[j + 1] - ys[j];
      for (let i = 0; i < nx - 1; i++) {
        const dx = xs[i + 1] - xs[i], e = cellValue(j * (nx - 1) + i), n = j * nx + i;
        const hx = e * 0.5 * dy / dx, hy = e * 0.5 * dx / dy;
        ax[n] += hx; ax[n + nx] += hx; ay[n] += hy; ay[n + 1] += hy;
      }
    }
    return {ax, ay};
  }

  // ------------------------------------------------------------------ linear solver
  // Conjugate gradients (Hestenes & Stiefel 1952) preconditioned with the
  // modified incomplete Cholesky factorisation MIC(0) (Gustafsson 1978) in
  // natural ordering. V holds the Dirichlet values on fixed nodes and the
  // initial guess on free nodes; it is overwritten with the solution.
  function factor(m, A) {
    const {nx, ny, owner} = m, N = nx * ny, {ax, ay} = A;
    const free = [];
    for (let n = 0; n < N; n++) if (owner[n] < 0) free.push(n);
    const F = Int32Array.from(free), diag = new Float64Array(N), bx = new Float64Array(N), by = new Float64Array(N), inv = new Float64Array(N);
    for (const n of F) {
      diag[n] = ax[n] + ax[n - 1] + ay[n] + ay[n - nx];
      if (owner[n + 1] < 0) bx[n] = ax[n];
      if (owner[n + nx] < 0) by[n] = ay[n];
    }
    const w = 0.95;
    const d = new Float64Array(N);
    for (const n of F) {
      let v = diag[n];
      const a = bx[n - 1], c = by[n - nx];
      if (a) v -= a * (a + w * by[n - 1]) / d[n - 1];
      if (c) v -= c * (c + w * bx[n - nx]) / d[n - nx];
      if (!(v > 1e-3 * diag[n])) v = diag[n];
      d[n] = v; inv[n] = 1 / v;
    }
    return {F, diag, bx, by, inv, d};
  }
  function pcg(m, A, P, V, tol, maxIter) {
    const {nx} = m, N = V.length, {ax, ay} = A, {F, diag, bx, by, inv, d} = P;
    const r = new Float64Array(N), z = new Float64Array(N), p = new Float64Array(N), q = new Float64Array(N);
    const nf = F.length;
    let bnorm = 0, rr = 0;
    for (let k = 0; k < nf; k++) {
      const n = F[k];
      // b: contributions of the fixed neighbours only.
      let b = 0;
      if (m.owner[n + 1] >= 0) b += ax[n] * V[n + 1];
      if (m.owner[n - 1] >= 0) b += ax[n - 1] * V[n - 1];
      if (m.owner[n + nx] >= 0) b += ay[n] * V[n + nx];
      if (m.owner[n - nx] >= 0) b += ay[n - nx] * V[n - nx];
      bnorm += b * b;
      const res = ax[n] * V[n + 1] + ax[n - 1] * V[n - 1] + ay[n] * V[n + nx] + ay[n - nx] * V[n - nx] - diag[n] * V[n];
      r[n] = res; rr += res * res;
    }
    bnorm = Math.sqrt(bnorm) || 1;
    const stop = tol * bnorm;
    let it = 0, rz = 0;
    const precond = () => {
      for (let k = 0; k < nf; k++) {const n = F[k]; z[n] = (r[n] + bx[n - 1] * z[n - 1] + by[n - nx] * z[n - nx]) * inv[n];}
      for (let k = nf - 1; k >= 0; k--) {const n = F[k]; z[n] += (bx[n] * z[n + 1] + by[n] * z[n + nx]) * inv[n];}
      let s = 0;
      for (let k = 0; k < nf; k++) {const n = F[k]; s += r[n] * z[n];}
      return s;
    };
    if (Math.sqrt(rr) > stop) {
      rz = precond();
      for (let k = 0; k < nf; k++) p[F[k]] = z[F[k]];
      for (it = 1; it <= maxIter; it++) {
        let pq = 0;
        for (let k = 0; k < nf; k++) {
          const n = F[k];
          const v = diag[n] * p[n] - ax[n] * p[n + 1] - ax[n - 1] * p[n - 1] - ay[n] * p[n + nx] - ay[n - nx] * p[n - nx];
          q[n] = v; pq += p[n] * v;
        }
        const alpha = rz / pq;
        rr = 0;
        for (let k = 0; k < nf; k++) {const n = F[k]; V[n] += alpha * p[n]; r[n] -= alpha * q[n]; rr += r[n] * r[n];}
        if (Math.sqrt(rr) <= stop) break;
        const rz2 = precond(), beta = rz2 / rz;
        rz = rz2;
        for (let k = 0; k < nf; k++) {const n = F[k]; p[n] = z[n] + beta * p[n];}
      }
    }
    return {iterations: it, residual: Math.sqrt(rr) / bnorm};
  }
  // Discrete energy bilinear form sum_e a_e dU_e dW_e (= U^T A W on the full
  // mesh). With U, W the potentials of conductors k, l at 1 V it is the
  // Maxwell capacitance C_kl / eps0, and it is variational: errors in the
  // potentials enter only to second order (Harrington 1961; Silvester & Ferrari).
  function bilinear(m, A, U, W) {
    const {nx, ny} = m, {ax, ay} = A;
    let s = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const n = j * nx + i;
      if (i < nx - 1) {const a = ax[n]; if (a) s += a * (U[n + 1] - U[n]) * (W[n + 1] - W[n]);}
      if (j < ny - 1) {const a = ay[n]; if (a) s += a * (U[n + nx] - U[n]) * (W[n + nx] - W[n]);}
    }
    return s;
  }
  function excite(m, k, V0) {
    const {owner} = m, V = V0 ? Float64Array.from(V0) : new Float64Array(owner.length);
    for (let n = 0; n < owner.length; n++) if (owner[n] >= 0) V[n] = owner[n] === k + 1 ? 1 : 0;
    return V;
  }

  // ------------------------------------------------------------------ small matrix helpers
  function inv2(M) {
    if (M.length === 1) return [[1 / M[0][0]]];
    const n = M.length, A = M.map((r, i) => [...r, ...M.map((_, j) => i === j ? 1 : 0)]);
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r;
      [A[c], A[piv]] = [A[piv], A[c]];
      const d = A[c][c];
      for (let k = 0; k < 2 * n; k++) A[c][k] /= d;
      for (let r = 0; r < n; r++) if (r !== c) {const f = A[r][c]; for (let k = 0; k < 2 * n; k++) A[r][k] -= f * A[c][k];}
    }
    return A.map(r => r.slice(n));
  }

  // ------------------------------------------------------------------ roughness & dielectric models
  // Skin depth (um) of a conductor of conductivity sigma at f GHz.
  const skinDepthUm = (fGHz, sigma = SIGMA_CU) => 1e6 / Math.sqrt(PI * fGHz * 1e9 * MU0 * sigma);
  const roughness = {
    // Hammerstad & Jensen (1980, from Morgan 1949): K = 1 + (2/pi) atan(1.4 (Rq/delta)^2), saturates at 2.
    hammerstad(fGHz, {rq = 1, sigma = SIGMA_CU} = {}) {
      if (!(fGHz > 0) || !(rq > 0)) return 1;
      const d = skinDepthUm(fGHz, sigma);
      return 1 + 2 / PI * Math.atan(1.4 * (rq / d) ** 2);
    },
    // Groisse et al. (1996): K = 1 + exp(-(delta / (2 Rq))^1.6), saturates at 2.
    groisse(fGHz, {rq = 1, sigma = SIGMA_CU} = {}) {
      if (!(fGHz > 0) || !(rq > 0)) return 1;
      const d = skinDepthUm(fGHz, sigma);
      return 1 + Math.exp(-Math.pow(d / (2 * rq), 1.6));
    },
    // Huray snowball model (Huray et al. 2010, "The Foundations of Signal
    // Integrity"): spheres of radius a on a hexagonal tile of area Ahex,
    //   K = Amatte/Aflat + (3/2) sum_i (N_i 4 pi a_i^2 / Ahex) / (1 + delta/a_i + delta^2/(2 a_i^2)).
    // Parameters (um, um^2): radius (default 0.5), N (spheres per tile, default 14),
    // Ahex (default 9.4 um^2), ratio = Amatte/Aflat (default 1). The common
    // "Cannonball-Huray" simplification (Simonovich 2015) fixes the tile from
    // the stacking; here it is entered through sr = N 4 pi a^2 / Ahex directly.
    huray(fGHz, {radius = 0.5, N = 14, Ahex = 9.4, ratio = 1, sr, spheres, sigma = SIGMA_CU} = {}) {
      const list = Array.isArray(spheres) && spheres.length ? spheres : [{radius, N}];
      if (!(fGHz > 0)) return ratio;
      const d = skinDepthUm(fGHz, sigma);
      let k = ratio;
      for (const s of list) {
        const a = s.radius > 0 ? s.radius : radius, srf = sr > 0 && list.length === 1 ? sr : (s.N > 0 ? s.N : N) * 4 * PI * a * a / Ahex;
        k += 1.5 * srf / (1 + d / a + d * d / (2 * a * a));
      }
      return k;
    }
  };
  // Djordjevic-Sarkar wideband Debye model (Djordjevic, Biljic, Likar-Smiljanic
  // & Sarkar, IEEE Trans. EMC 43, 2001): a uniform distribution of Debye
  // relaxations between f1 and f2,
  //   eps(f) = eps_inf + (d_eps / ln(f2/f1)) ln((f2 + j f) / (f1 + j f)),
  // which is analytic in the lower half f-plane, hence causal (it satisfies the
  // Kramers-Kronig relations by construction). Fitted so that eps(fRef) =
  // er (1 - j tanD) exactly.
  const dielectric = {
    djordjevicSarkar({er, tanD = 0.02, fRef = 1, f1 = 1e3, f2 = 1e12} = {}) {
      if (!(er >= 1)) throw Error("er is required.");
      const fr = fRef * 1e9;
      const lnRe = (f) => 0.5 * Math.log((f2 * f2 + f * f) / (f1 * f1 + f * f)), lnIm = (f) => Math.atan(f / f2) - Math.atan(f / f1);
      const k = tanD > 0 ? -er * tanD / lnIm(fr) : 0; // = d_eps / ln(f2/f1)
      const einf = er - k * lnRe(fr);
      const model = fGHz => {
        const f = fGHz * 1e9, re = einf + k * lnRe(f), im = -k * lnIm(f);
        return {er: re, tanD: re > 0 ? im / re : 0};
      };
      model.params = {einf, deps: k * Math.log(f2 / f1), f1, f2, fRef};
      return model;
    }
  };

  // ------------------------------------------------------------------ main solve
  function solveProblem(p, opts) {
    const t0 = now();
    const quality = QUALITY[opts.quality] ? opts.quality : "normal";
    const Q = QUALITY[quality];
    const m = buildMesh(p, quality);
    const tol = opts.tol > 0 ? opts.tol : Q.tol, maxIter = 4000;
    const ns = p.signals.length;
    // Frequency and dielectric dispersion.
    const fGHz = opts.fGHz > 0 ? +opts.fGHz : opts.freq > 0 ? +opts.freq : 0;
    let erCell = m.er, tdCell = m.tanD, dispersive = false;
    if (fGHz > 0 && (opts.dispersion === "djordjevic-sarkar" || opts.dispersion === true)) {
      const fRef = opts.fRef > 0 ? +opts.fRef : 1;
      const layers = [...p.dielectrics, ...p.coats].map(d => d.er > 1 ? dielectric.djordjevicSarkar({er: d.er, tanD: d.tanD, fRef})(fGHz) : {er: 1, tanD: 0});
      erCell = new Float64Array(m.er.length); tdCell = new Float64Array(m.er.length);
      for (let n = 0; n < erCell.length; n++) {const L = m.layer[n]; if (L >= 0) {erCell[n] = layers[L].er; tdCell[n] = layers[L].tanD;} else erCell[n] = 1;}
      dispersive = true;
    }
    const A = coefficients(m, n => erCell[n]), A0 = coefficients(m, () => 1), AG = coefficients(m, n => erCell[n] * tdCell[n]);
    const P = factor(m, A), P0 = factor(m, A0);
    const V = [], V0 = [];
    let iters = 0;
    for (let k = 0; k < ns; k++) {
      const v0 = excite(m, k, null);
      iters += pcg(m, A0, P0, v0, tol, maxIter).iterations;
      const v = excite(m, k, v0);
      iters += pcg(m, A, P, v, tol, maxIter).iterations;
      V.push(v); V0.push(v0);
    }
    const mat = (AA, VV) => VV.map(U => VV.map(W => bilinear(m, AA, U, W)));
    const Cn = mat(A, V), C0n = mat(A0, V0), Gn = mat(AG, V);
    // Per-unit-length matrices (per mm): C pF/mm, L nH/mm, G S/mm (at fGHz).
    const eps0pFmm = EPS0 * 1e9; // pF/mm
    const C = Cn.map(r => r.map(v => v * eps0pFmm));
    const L = inv2(C0n).map(r => r.map(v => v * MU0 * 1e6)); // nH/mm
    const omega = 2 * PI * (fGHz > 0 ? fGHz : 1) * 1e9;
    const G = Gn.map(r => r.map(v => v * EPS0 * 1e-3 * omega)); // S/mm
    // Mode quantities.
    const mode = (exc) => {
      // capacitance seen by line 0 when lines carry voltages exc (normalised to eps0)
      let c = 0, c0 = 0, g = 0;
      for (let l = 0; l < ns; l++) {c += Cn[0][l] * exc[l]; c0 += C0n[0][l] * exc[l]; g += Gn[0][l] * exc[l];}
      const z = ETA0 / Math.sqrt(c * c0), ee = c / c0;
      return {z, eeff: ee, c, c0, g};
    };
    const out = {ok: true, structure: p.structure, quality, solver: "FD-Laplace (graded mesh, MIC-PCG)", warnings: []};
    const se = mode(ns === 1 ? [1] : [1, 0]);
    out.z0 = se.z; out.eeff = se.eeff; out.delay = PS_PER_MM * Math.sqrt(se.eeff);
    out.matrices = {C, L, G, R: null, C0: C0n.map(r => r.map(v => v * eps0pFmm)), units: {C: "pF/mm", L: "nH/mm", G: "S/mm", R: "ohm/mm"}};
    let main = se, mainExc = ns === 1 ? [1] : [1, 0];
    if (ns === 2) {
      const odd = mode([1, -1]), even = mode([1, 1]);
      Object.assign(out, {zodd: odd.z, zeven: even.z, zdiff: 2 * odd.z, zcommon: even.z / 2, eeffOdd: odd.eeff, eeffEven: even.eeff,
        delayOdd: PS_PER_MM * Math.sqrt(odd.eeff), delayEven: PS_PER_MM * Math.sqrt(even.eeff), z: 2 * odd.z});
      const Cm = -Cn[0][1], Cs = Cn[0][0], Lm = L[0][1], Ls = L[0][0];
      out.kb = 0.25 * (Cm / Cs + Lm / Ls);
      out.kf = 0.5 * (Cm / Cs - Lm / Ls);
      out.kfPsPerMm = out.kf * PS_PER_MM * Math.sqrt(se.eeff); // FEXT = kfPsPerMm * length / rise time
      // Main mode of a pair is the odd (differential) mode; z0 is the line's
      // characteristic impedance in the coupled system, sqrt(Zodd Zeven).
      out.z0 = Math.sqrt(odd.z * even.z); out.eeffSingle = se.eeff; out.zSingle = se.z;
      out.eeff = odd.eeff; out.delay = out.delayOdd;
      main = odd; mainExc = [1, -1];
    } else out.z = se.z;
    if (ns > 2) out.warnings.push("More than two signal conductors: z0 is line 0 alone; use the matrices.");
    // Losses.
    if (fGHz > 0) {
      const sigma = opts.sigma > 0 ? +opts.sigma : SIGMA_CU;
      const rs = Math.sqrt(PI * fGHz * 1e9 * MU0 / sigma); // ohm/square
      const rough = opts.roughness || null;
      const K = rough && roughness[rough.model] ? roughness[rough.model](fGHz, {sigma, ...rough}) : 1;
      // Surface current from the vacuum (TEM) charge: J_s = rho_s * c, so on
      // each conductor surface piece J/I = rho/Q. R = Rs sum |J/I|^2 ds.
      const U = new Float64Array(V0[0].length);
      for (let l = 0; l < ns; l++) if (mainExc[l]) for (let n = 0; n < U.length; n++) U[n] += mainExc[l] * V0[l][n];
      const loss = surfaceLoss(m, A0, U);
      const q = main.c0; // charge on line 0 for the mode (eps0 units)
      const rTot = rs * loss.sum / (q * q) * 1e3; // ohm/m, all conductors, per line-0 current
      const nLines = mainExc.filter(Boolean).length;
      const zMode = main.z;
      const alphaC = rTot / (2 * nLines * zMode) * K; // Np/m
      const alphaD = 0.5 * (main.g * EPS0 * omega) * zMode; // Np/m: G Z / 2 with G = omega eps0 sum(eps tanD |E|^2)
      const thinStrip = p.conductors.some(c => c.t === 0);
      if (thinStrip) out.warnings.push("Zero-thickness strip: conductor loss depends on the mesh at the strip edges; give t.");
      const minT = Math.min(...p.conductors.filter(c => c.t > 0).map(c => c.t));
      const delta = skinDepthUm(fGHz, sigma) / 1000;
      if (fin(minT) && minT < 2 * delta) out.warnings.push("Copper thinner than two skin depths: the surface-impedance loss model overstates alpha_c.");
      out.loss = {fGHz, alpha_c: alphaC * NP_DB / 1000, alpha_d: alphaD * NP_DB / 1000, roughnessFactor: K, skinDepthUm: delta * 1000, rs};
      out.loss.total = out.loss.alpha_c + out.loss.alpha_d;
      out.alpha_c = out.loss.alpha_c; out.alpha_d = out.loss.alpha_d;
      // Per-line resistance matrix (diagonal approximation from each line's own currents).
      const R = [];
      for (let k = 0; k < ns; k++) {
        const lk = surfaceLoss(m, A0, V0[k]), qk = C0n[k][k];
        R.push(p.signals.map((_, l) => l === k ? rs * lk.sum / (qk * qk) * K : 0));
      }
      out.matrices.R = R;
      if (dispersive) {out.dispersion = "djordjevic-sarkar"; out.eeffAtF = out.eeff;}
    }
    out.mesh = {nx: m.nx, ny: m.ny, nodes: m.nx * m.ny, hEdge: m.hEdge, iterations: iters};
    out.ms = now() - t0;
    out._m = m; out._V = V;
    return out;
  }
  // sum over conductor surface pieces of flux^2 / face (eps0 units^2 / mm).
  function surfaceLoss(m, A, U) {
    const {nx, ny, owner, xs, ys} = m, {ax, ay} = A;
    let sum = 0;
    for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
      const n = j * nx + i;
      if (owner[n] >= 0) continue;
      // free node: fluxes into fixed neighbours
      const fy = (ys[Math.min(j + 1, ny - 1)] - ys[j - 1]) / 2, fx = (xs[i + 1] - xs[i - 1]) / 2;
      if (owner[n + 1] >= 0) {const f = ax[n] * (U[n] - U[n + 1]); sum += f * f / fy;}
      if (owner[n - 1] >= 0) {const f = ax[n - 1] * (U[n] - U[n - 1]); sum += f * f / fy;}
      if (owner[n + nx] >= 0) {const f = ay[n] * (U[n] - U[n + nx]); sum += f * f / fx;}
      if (owner[n - nx] >= 0) {const f = ay[n - nx] * (U[n] - U[n - nx]); sum += f * f / fx;}
    }
    return {sum};
  }

  function clean(r) {const o = {...r}; delete o._m; delete o._V; return o;}
  function solve(geom, opts = {}) {
    try {
      const p = normalize(geom);
      const o = {...opts};
      if (!(o.fGHz > 0) && geom && geom.freq > 0) o.fGHz = +geom.freq;
      if (!o.roughness && geom && geom.rough > 0) o.roughness = {model: "hammerstad", rq: geom.rough * 1000};
      if (!(o.sigma > 0) && geom && geom.sigma > 0) o.sigma = +geom.sigma;
      return clean(solveProblem(p, o));
    } catch (e) {
      return {ok: false, error: String(e && e.message || e)};
    }
  }
  function mesh(geom, opts = {}) {
    const p = normalize(geom), r = solveProblem(p, {quality: opts.quality || "fast"}), m = r._m;
    return {xs: m.xs, ys: m.ys, nx: m.nx, ny: m.ny, er: m.er, owner: m.owner, potential: Float32Array.from(r._V[0]), box: m.box, z: r.z};
  }
  function compare(geom, opts = {}) {
    const solver = solve(geom, opts);
    const I = globalThis.AtriumImpedance;
    if (!I || !solver.ok) return {solver, closedForm: null, deltaPct: null};
    const closedForm = I.solve(geom);
    const pct = (a, b) => fin(a) && fin(b) && b ? 100 * (a - b) / b : null;
    const deltaPct = closedForm.ok ? {z: pct(solver.z, closedForm.z), eeff: pct(solver.eeff, closedForm.eeff)} : null;
    if (deltaPct && fin(solver.zodd)) Object.assign(deltaPct, {zodd: pct(solver.zodd, closedForm.zodd), zeven: pct(solver.zeven, closedForm.zeven)});
    return {solver, closedForm, deltaPct};
  }
  // Width (or gap) for a target impedance: secant steps on ln(Z) vs ln(x),
  // safeguarded by bisection inside a bracket.
  function synthesize(geom, {target, vary = "w", min, max, quality = "normal", tolerance = 1e-3, iterations = 30} = {}) {
    if (!(target > 0)) return {ok: false, error: "Choose a target impedance."};
    const key = vary;
    const zAt = v => {const r = solve({...geom, [key]: v}, {quality}); return r.ok ? r.z : NaN;};
    let lo = min > 0 ? min : (geom[key] > 0 ? geom[key] / 8 : 0.01), hi = max > lo ? max : (geom[key] > 0 ? geom[key] * 8 : 10);
    let x0 = geom[key] > 0 ? Math.min(hi, Math.max(lo, +geom[key])) : Math.sqrt(lo * hi);
    const I = globalThis.AtriumImpedance;
    if (I && (key === "w" || key === "s")) {try {const s = I.synthesize(geom, {target, vary: key, min: lo, max: hi}); if (s.ok && s[key] > 0) x0 = s[key];} catch (e) { /* closed form unavailable */ }}
    let a = Math.log(lo), b = Math.log(hi), fa = Math.log(zAt(lo) / target), fb = Math.log(zAt(hi) / target);
    if (!fin(fa) || !fin(fb)) return {ok: false, error: "The solver failed at the limits."};
    if (fa * fb > 0) {const v = Math.abs(fa) < Math.abs(fb) ? lo : hi; return {ok: false, clamped: true, [key]: v, result: solve({...geom, [key]: v}, {quality}), error: "The target is outside the limits."};}
    let x = Math.log(x0), fx = Math.log(zAt(x0) / target), n = 3;
    for (; n < iterations && Math.abs(fx) > tolerance * 0.5; n++) {
      if (fx * fa < 0) {b = x; fb = fx;} else {a = x; fa = fx;}
      let xn = x - fx * (b - a) / (fb - fa);
      if (!(xn > a && xn < b)) xn = (a + b) / 2;
      x = xn; fx = Math.log(zAt(Math.exp(x)) / target);
    }
    const v = Math.exp(x);
    return {ok: Math.abs(fx) <= tolerance, [key]: v, solves: n, result: solve({...geom, [key]: v}, {quality})};
  }

  // ------------------------------------------------------------------ worker
  let scriptURL = null;
  try {scriptURL = globalThis.document && globalThis.document.currentScript && globalThis.document.currentScript.src || null;} catch (e) {scriptURL = null;}
  let workerBroken = false, seq = 0;
  function makeWorker() {
    if (workerBroken || typeof Worker !== "function") return null;
    try {
      if (typeof Blob === "function" && typeof URL !== "undefined" && typeof URL.createObjectURL === "function" && typeof AtriumFieldSolverFactory === "function") {
        const src = '"use strict";\n' + AtriumFieldSolverFactory.toString() + "\n" + AtriumFieldSolverServe.toString() + "\nAtriumFieldSolverServe(self, AtriumFieldSolverFactory());\n";
        const worker = AtriumWorkerPool.blobWorker(src);
        if (worker) return worker;
      }
    } catch (e) { /* Blob workers may be blocked */ }
    try {if (scriptURL) return new Worker(new URL("../workers/field-solver-worker.js", scriptURL).href);} catch (e) { /* fall back */ }
    return null;
  }
  // One worker serves every solve, in order, and retires after 30 s idle. Each solve gets 10 s once it
  // reaches the front: a slow cross-section is reported, never re-run on the UI thread (security
  // review), and the worker is replaced so the solves queued behind it still run.
  let shared = null, idleTimer = null;
  const jobs = new Map();
  function retire() {const w = shared; shared = null; if (w) try {w.terminate();} catch (e) { /* already stopped */ }}
  function settle() {
    clearTimeout(idleTimer);
    if (jobs.size) {
      const [id, job] = jobs.entries().next().value;
      if (!job.timer) {
        job.span?.start();
        job.timer = setTimeout(() => timedOut(id), 10000);
      }
      return;
    }
    idleTimer = setTimeout(() => {if (!jobs.size) retire();}, 30000);
    idleTimer?.unref?.();
  }
  function timedOut(id) {
    const job = jobs.get(id);
    if (!job) return;
    jobs.delete(id); retire();
    job.resolve({ok: false, error: "The field solver took longer than 10 s on this cross-section."});
    const rest = [...jobs.values()]; jobs.clear();
    for (const j of rest) submit(j);
    if (!rest.length) settle();
  }
  function worker() {
    if (shared) return shared;
    const w = makeWorker();
    if (!w) return null;
    w.onmessage = ({data}) => {
      const job = w === shared && data && jobs.get(data.id);
      if (!job) return;
      clearTimeout(job.timer); jobs.delete(data.id); job.resolve(data.result); settle();
    };
    w.onerror = () => {
      if (w !== shared) return;
      retire(); workerBroken = true;
      const rest = [...jobs.values()]; jobs.clear();
      for (const j of rest) {clearTimeout(j.timer); j.fallback();}
    };
    return shared = w;
  }
  function submit(job) {
    const w = worker();
    if (!w) {Promise.resolve().then(job.fallback); return;}
    const id = ++seq, {geom, opts} = job;
    try {w.postMessage({type: "solve", id, geom, opts});}
    catch (e) {job.resolve({ok: false, error: "The cross-section could not be sent to the field solver."}); return;}
    jobs.set(id, job);
    settle();
  }

  // Promise of solve(geom, opts) computed off the UI thread when a worker is
  // available, else synchronously on a later tick.
  function solveAsync(geom, opts = {}) {
    const perf = globalThis.AtriumDiagnostics?.performance;
    const span = perf?.queue("analysis", "request");
    return new Promise((resolve, reject) => {
      function finish(result) {
        if (!result?.ok) span?.end("failed");
        else { span?.ready(); span?.end(); }
        resolve(result);
      }
      function fallback() {
        span?.start();
        const local = perf?.begin("analysis", "fallback");
        try {
          const result = solve(geom, opts);
          local?.end(result?.ok ? "completed" : "failed");
          finish(result);
        } catch (error) {
          local?.end("failed");
          span?.end("failed");
          reject(error);
        }
      }
      submit({geom, opts, span, resolve: finish, fallback, timer: null});
    });
  }

  return Object.freeze({solve, async: solveAsync, compare, synthesize, mesh, normalize, roughness: Object.freeze(roughness), dielectric: Object.freeze(dielectric),
    skinDepthUm, QUALITY, ETA0, PS_PER_MM});
}

// Worker entry: answers {type:"solve", id, geom, opts} with {id, result}. Serialised
// into a Blob with AtriumFieldSolverFactory, so it must not close over anything.
function AtriumFieldSolverServe(scope, api) {
  "use strict";
  scope.onmessage = event => {
    const msg = event.data || {};
    if (msg.type !== "solve") return;
    let result;
    try {result = api.solve(msg.geom, msg.opts || {});} catch (e) {result = {ok: false, error: String(e && e.message || e)};}
    scope.postMessage({type: "result", id: msg.id, result});
  };
}

globalThis.AtriumFieldSolver = AtriumFieldSolverFactory();
