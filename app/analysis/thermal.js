"use strict";
// Temperature Rise Map (Tools › Thermal › Temperature Rise Map…): a steady-state estimate of the
// board's temperature rise above ambient, per copper layer, from component power and the PDN
// Analyzer's I²R losses. It is a SIMPLE MODEL: read "Model" and "Not modelled" before using a number.
//
// Model
//  * Grid. The board outline (cutouts removed) on a square grid, one node per cell per copper
//    layer. The pitch is the finest that keeps the nodes under `maxNodes` (default 250 k), never
//    below 0.25 mm (heat spreads over millimetres). Partial cells at the outline keep their area fraction.
//  * In-plane conduction. Each layer node is a slab: its copper (k 385 W/m·K, thickness from the
//    stack-up, times the copper fraction of the cell: every net's tracks, pads, vias, fills,
//    polygons and stored pours, rasterised with exact horizontal coverage) plus half of the
//    dielectric above and below it (in-plane k, FR-4 0.8 W/m·K). Neighbours conduct through
//    the harmonic mean of their sheet conductances (k·t per square).
//  * Through-plane conduction. Between adjacent copper layers, the dielectric (through-plane k,
//    FR-4 0.3 W/m·K; layers in series), plus each via and plated hole in the cell as a copper
//    barrel k·π(d + t)·t/Δz (t the plating, 25 µm), so thermal via arrays count.
//  * Boundaries. Convection (and linearised radiation) from the top and bottom faces with h
//    (W/m²·K): natural air ≈ 10, forced air ≈ 25–100. Heatsink regions on either face add their
//    own h, or hold the face at a fixed rise (a cold plate or chassis). Board edges are
//    adiabatic, convective (h_edge on the edge area) or held at ambient (card guides).
//  * Heat. Component power (part parameter "Power Dissipation", "Pd", "Thermal Power" or "Power",
//    W; the active variant's parameters and fitting count; or a value typed in the panel) is
//    spread over the part's pads on its side by pad area (no pads: a 2 mm square at its origin).
//    PDN Analyzer results add I²R per grid cell (ρJ²·t·A), per 1D track piece (I·ΔV) and are
//    scaled so the total equals the PDN's I²R power exactly.
//  * Solve. The symmetric conductance matrix is solved with the PDN Analyzer's MIC(0)-
//    preconditioned conjugate gradients (pdn.js), in a Web Worker in the editor.
// Not modelled: component bodies and their own convection and radiation (all component heat
// enters the board under its pads, so parts with large bodies or heatsinks read hot), air flow
// direction and heating of the air, enclosure walls, temperature-dependent copper resistance
// and h, transient behaviour, contact resistance of thermal pads, solder voids, lead conduction
// inside plated holes (the plating alone is counted). Copper thinner than the grid pitch is
// smeared over its cells. Treat results as a screening estimate (expect ±30 % on the rise).
//
// API (DOM-free; the panel is thermal-view.js):
//   AtriumThermal.normalize(raw) / read(doc) / write(doc, setup)     doc.thermal, saved with the board
//   AtriumThermal.powers(doc, defs, project, setup) -> [{ref, id, power, source}]
//   AtriumThermal.job(doc, defs, setup, {project, pdn:[pdnResults]})  -> solver job (typed arrays)
//   AtriumThermal.solve(job) / run(job, {onProgress}) -> raw result; worker in the editor
//   AtriumThermal.report(doc, defs, job, result, opts) -> {summary, layers, hotspots, parts, notes, assumptions}
//   AtriumThermal.analyze(doc, defs, setup, {project, pdn}) -> {job, result, report}   (synchronous)
//   AtriumThermal.headless(args, host)                -> MCP thermal_map
// Units: mm, W, °C (rise above ambient), W/m·K, W/m²·K.

// Solver core: self-contained (serialised into a Blob worker next to AtriumPDNCore, whose raster
// and MIC(0)-PCG kernels it reuses). It must not close over anything outside itself.
function AtriumThermalCore(pdn) {
  "use strict";
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());
  // job: {x0, y0, nx, ny, h, outline:[rings], kCu, plating,
  //   layers:[{key, t, kd, td, shapes:[rings], tracks:[{pts, w}]}], gaps:[{d, kz}],
  //   vias:[{x, y, from, to, drill}], hTop, hBottom, edge:{mode, h}, sinks:[{layer, ring, h?, rise?}],
  //   q:[Float64Array per layer, W per cell], tol, maxIter}
  function compute(job, progress = () => {}) {
    const T = {start: now()}, notes = [];
    const nx = job.nx, ny = job.ny, n = nx * ny, h = job.h, L = job.layers, nl = L.length, g = {x0: job.x0, y0: job.y0, nx, ny, h};
    if (!nl || !(n > 0)) throw Error("Nothing to solve.");
    progress({phase: "raster"});
    // ---- board and copper fractions
    const bf = new Float32Array(n);
    pdn.raster(job.outline, g, bf);
    const ACT = .02;
    (() => { for (let c = 0; c < n; c++) bf[c] = bf[c] > 1 ? 1 : bf[c] < ACT ? 0 : bf[c]; })();
    const cu = L.map(l => {
      const a = new Float32Array(n);
      for (const r of l.shapes) pdn.raster(r, g, a);
      for (const t of l.tracks) for (let i = 2; i < t.pts.length; i += 2) pdn.raster([pdn.capsuleRing(t.pts[i - 2], t.pts[i - 1], t.pts[i], t.pts[i + 1], t.w)], g, a);
      for (let c = 0; c < n; c++) { const v = a[c]; a[c] = v > bf[c] ? bf[c] : v; }
      return a;
    });
    T.raster = now();
    progress({phase: "assemble"});
    // ---- per-node coefficients (W/K)
    const kCu = job.kCu || 385;
    // Sheet conductance per square: k·t (W/m·K × mm → ×1e-3).
    const sheet = L.map((l, li) => { const s = new Float64Array(n), a = cu[li], kc = kCu * l.t * 1e-3, kd = l.kd * l.td * 1e-3; for (let c = 0; c < n; c++) s[c] = bf[c] ? kc * a[c] + kd * bf[c] : 0; return s; });
    const area = h * h * 1e-6;                                // m² per full cell
    // Vertical: dielectric + via barrels, per gap.
    const vz = job.gaps.map(gp => { const v = new Float64Array(n), k = gp.kz * area / (gp.d * 1e-3); for (let c = 0; c < n; c++) v[c] = k * bf[c]; return v; });
    let viaCount = 0;
    for (const v of job.vias) {
      const ix = Math.floor((v.x - g.x0) / h), iy = Math.floor((v.y - g.y0) / h);
      if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) continue;
      const c = iy * nx + ix;
      if (!bf[c]) continue;
      const tp = v.plating > 0 ? v.plating : job.plating, A = pdn.platedBarrelArea(v.drill, tp) * 1e-6;     // m²
      for (let k = Math.max(0, v.from); k < Math.min(nl - 1, v.to); k++) vz[k][c] += kCu * A / (job.gaps[k].d * 1e-3);
      viaCount++;
    }
    // To ambient: faces, heatsinks, edges. Fixed: Dirichlet rise (NaN = free).
    const amb = L.map(() => new Float64Array(n)), fixed = L.map(() => null);
    (() => {
      const ht = job.hTop * area, hb = job.hBottom * area;
      for (let c = 0; c < n; c++) { if (!bf[c]) continue; amb[0][c] += ht * bf[c]; amb[nl - 1][c] += hb * bf[c]; }
    })();
    for (const s of job.sinks || []) {
      const li = s.layer < 0 ? 0 : s.layer >= nl ? nl - 1 : s.layer, cov = new Float32Array(n);
      pdn.raster([s.ring], g, cov);
      if (s.rise != null && Number.isFinite(s.rise)) {
        const f = fixed[li] || (fixed[li] = new Float64Array(n).fill(NaN));
        for (let c = 0; c < n; c++) if (bf[c] && cov[c] >= .5) f[c] = s.rise;
      } else {
        const hs = (s.h || 0) * area;
        for (let c = 0; c < n; c++) if (bf[c] && cov[c] > 0) amb[li][c] += hs * Math.min(cov[c], bf[c]);
      }
    }
    const edge = job.edge || {mode: "adiabatic"};
    let edgeCells = 0;
    if (edge.mode === "convective" || edge.mode === "fixed") {
      for (let c = 0; c < n; c++) {
        if (!bf[c]) continue;
        const ix = c % nx, iy = (c - ix) / nx;
        let open = 0;
        if (ix === 0 || !bf[c - 1]) open++;
        if (ix === nx - 1 || !bf[c + 1]) open++;
        if (iy === 0 || !bf[c - nx]) open++;
        if (iy === ny - 1 || !bf[c + nx]) open++;
        if (!open) continue;
        edgeCells++;
        for (let l = 0; l < nl; l++) {
          if (edge.mode === "fixed") amb[l][c] += open * 2 * sheet[l][c];
          else amb[l][c] += open * (edge.h || 0) * (h * 1e-3) * ((L[l].t + L[l].td) * 1e-3);
        }
      }
    }
    // ---- unknowns: node = c·nl + l (layers of a cell adjacent: vertical coupling stays local)
    const N = n * nl, uid = new Int32Array(N).fill(-1);
    let m = 0;
    (() => { for (let c = 0; c < n; c++) { if (!bf[c]) continue; for (let l = 0; l < nl; l++) { const f = fixed[l]; if (f && f[c] === f[c]) continue; uid[c * nl + l] = m++; } } })();
    if (!m) throw Error("Every board cell is held at a fixed temperature.");
    const urow = new Int32Array(m + 1), col = new Int32Array(m * 7), val = new Float64Array(m * 7), dp = new Int32Array(m), b = new Float64Array(m);
    const fixedOf = (l, c) => { const f = fixed[l]; return f ? f[c] : NaN; };
    const pair = (a, x) => a > 0 && x > 0 ? 2 * a * x / (a + x) : 0;
    let nnz = 0;
    (() => {
      for (let c = 0; c < n; c++) {
        if (!bf[c]) continue;
        const ix = c % nx;
        for (let l = 0; l < nl; l++) {
          const u = uid[c * nl + l];
          if (u < 0) continue;
          const s = sheet[l];
          let diag = amb[l][c], rhs = job.q[l] ? job.q[l][c] : 0;
          // Neighbours in node order: c−nx, c−1, (c, l−1), self, (c, l+1), c+1, c+nx.
          urow[u] = nnz;
          for (let k = 0; k < 7; k++) {
            if (k === 3) { dp[u] = nnz; col[nnz] = u; val[nnz++] = 0; continue; }
            const vert = k === 2 || k === 4, ll = k === 2 ? l - 1 : k === 4 ? l + 1 : l;
            const cc = k === 0 ? (c >= nx ? c - nx : -1) : k === 1 ? (ix > 0 ? c - 1 : -1) : k === 5 ? (ix < nx - 1 ? c + 1 : -1) : k === 6 ? (c + nx < n ? c + nx : -1) : c;
            if (cc < 0 || ll < 0 || ll >= nl || !bf[cc]) continue;
            const G = vert ? vz[ll < l ? ll : l][c] : pair(s[c], s[cc]);
            if (!(G > 0)) continue;
            diag += G;
            const v = uid[cc * nl + ll];
            if (v >= 0) { col[nnz] = v; val[nnz++] = -G; }
            else { const fv = fixedOf(ll, cc); if (fv === fv) rhs += G * fv; }
          }
          val[dp[u]] = diag;
          b[u] = rhs;
        }
      }
      urow[m] = nnz;
    })();
    // A node without any path to ambient would make the matrix singular: tie it weakly.
    (() => { for (let u = 0; u < m; u++) if (!(val[dp[u]] > 0)) val[dp[u]] = 1e-12; })();
    T.assembled = now();
    progress({phase: "factor", unknowns: m});
    const f = pdn.micFactor(m, urow, col, val, dp);
    T.factored = now();
    progress({phase: "solve", done: 0, unknowns: m});
    const tol = job.tol > 0 ? job.tol : 1e-8, maxIter = job.maxIter > 0 ? job.maxIter : 20000;
    const sol = pdn.pcg(m, urow, col, val, dp, f, b, tol, maxIter, progress);
    if (m && sol.bn > 0 && !(sol.res < Math.max(tol, 1e-5))) notes.push("The solver stopped at a relative residual of " + sol.res.toExponential(1) + ".");
    T.solved = now();
    progress({phase: "post"});
    // ---- results per layer (rise, °C; NaN outside the board)
    const x = sol.x, out = [];
    let qIn = 0, qOut = 0, tMax = -Infinity, tMaxAt = null, tMaxLayer = -1;
    for (let l = 0; l < nl; l++) {
      const t = new Float32Array(n).fill(NaN), q = job.q[l];
      let mx = -Infinity, at = null, sum = 0, cnt = 0;
      for (let c = 0; c < n; c++) {
        if (!bf[c]) continue;
        const u = uid[c * nl + l], v = u >= 0 ? x[u] : fixedOf(l, c);
        t[c] = v;
        if (q) qIn += q[c];
        qOut += amb[l][c] * v;
        sum += v * bf[c]; cnt += bf[c];
        if (v > mx) { mx = v; at = c; }
      }
      // Heat into fixed nodes: from their free neighbours.
      if (fixed[l]) for (let c = 0; c < n; c++) {
        if (!bf[c] || !(fixed[l][c] === fixed[l][c])) continue;
        const fv = fixed[l][c], ix = c % nx;
        for (const [cc, ll, vert] of [[c - nx, l, 0], [ix > 0 ? c - 1 : -1, l, 0], [ix < nx - 1 ? c + 1 : -1, l, 0], [c + nx, l, 0], [c, l - 1, 1], [c, l + 1, 1]]) {
          if (cc < 0 || cc >= n || ll < 0 || ll >= nl || !bf[cc]) continue;
          const u = uid[cc * nl + ll];
          if (u < 0) continue;
          const G = vert ? vz[Math.min(l, ll)][c] : pair(sheet[l][c], sheet[l][cc]);
          qOut += G * (x[u] - fv);
        }
      }
      const cx = at == null ? null : [g.x0 + ((at % nx) + .5) * h, g.y0 + (Math.floor(at / nx) + .5) * h];
      out.push({key: L[l].key, t, max: mx === -Infinity ? 0 : mx, maxAt: cx, mean: cnt ? sum / cnt : 0, copper: cu[l]});
      if (mx > tMax) { tMax = mx; tMaxAt = cx; tMaxLayer = l; }
    }
    T.done = now();
    return {ok: true, grid: {x0: g.x0, y0: g.y0, nx, ny, h}, board: bf, layers: out, tMax: tMax === -Infinity ? 0 : tMax, tMaxAt, tMaxLayer, power: qIn, balance: qIn > 0 ? (qOut - qIn) / qIn : 0, notes,
      stats: {cells: n, active: bf.reduce((s, v) => s + (v > 0), 0), nodes: m, nnz: urow[m], vias: viaCount, edgeCells, iterations: sol.it, residual: sol.res,
        ms: {raster: T.raster - T.start, assemble: T.assembled - T.raster, factor: T.factored - T.assembled, solve: T.solved - T.factored, post: T.done - T.solved, total: T.done - T.start}}};
  }
  function transfers(res) {
    const out = [res.board.buffer];
    for (const l of res.layers || []) out.push(l.t.buffer, l.copper.buffer);
    return out;
  }
  return {compute, solve: compute, transfers};
}

globalThis.AtriumThermal = (() => {
  const VERSION = 1;
  const K_CU = 385;
  // h presets (W/m²·K, convection plus linearised radiation at ε ≈ 0.9).
  const AIR = Object.freeze({natural: 10, "forced-1": 25, "forced-3": 50, "forced-5": 80});
  const DEFAULTS = Object.freeze({ambient: 25, air: "natural", hTop: 10, hBottom: 10, edge: "adiabatic", hEdge: 10, plating: .025, kz: .3, kxy: .8,
    maxNodes: 2.5e5, minPitch: .25, pitch: null, includePDN: true, includeParts: true, sinks: [], power: {}});
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const num = (v, lo, hi, d) => { const x = +v; return v !== null && v !== "" && v !== undefined && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const str = (v, max = 256) => typeof v === "string" ? v.slice(0, max) : "";
  const r2 = v => fin(v) ? Math.round(v * 100) / 100 + 0 : v;
  const r4 = v => fin(v) ? Math.round(v * 1e4) / 1e4 + 0 : v;
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const pdnCore = () => globalThis.AtriumPDN?.core || (globalThis.AtriumPDNCore ? AtriumPDNCore() : null);
  let coreInst = null;
  const core = () => coreInst || (coreInst = AtriumThermalCore(pdnCore() || (() => { throw Error("The thermal solver needs the PDN Analyzer module (pdn.js)."); })()));

  // ---------------------------------------------------------------- setup (doc.thermal)
  function normSink(s, i) {
    const o = s && typeof s === "object" ? s : {};
    const box = Array.isArray(o.box) && o.box.length === 4 && o.box.every(Number.isFinite) ? o.box.map(Number) : null;
    const pts = Array.isArray(o.points) && o.points.length >= 3 && o.points.every(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) ? o.points.slice(0, 512).map(p => [+p[0], +p[1]]) : null;
    if (!box && !pts) return null;
    return {id: str(o.id, 64) || "sink" + (i + 1), name: str(o.name, 80), side: o.side === "bottom" ? "bottom" : "top", ...(pts ? {points: pts} : {box}),
      mode: o.mode === "fixed" ? "fixed" : "h", h: num(o.h, 0, 1e6, 1000), rise: num(o.rise, -100, 500, 0)};
  }
  function normalize(raw) {
    const o = raw && typeof raw === "object" ? raw : {};
    const air = own(AIR, o.air) || o.air === "custom" ? o.air : DEFAULTS.air;
    const power = {};
    if (o.power && typeof o.power === "object") for (const [k, v] of Object.entries(o.power).slice(0, 5000)) { const x = +v; if (k && k.length <= 64 && Number.isFinite(x) && x >= 0 && x <= 1e4) power[k] = x; }
    return {version: VERSION, ambient: num(o.ambient, -55, 200, DEFAULTS.ambient), air,
      hTop: air === "custom" ? num(o.hTop, .1, 1e5, DEFAULTS.hTop) : AIR[air], hBottom: air === "custom" ? num(o.hBottom, .1, 1e5, DEFAULTS.hBottom) : AIR[air],
      edge: ["adiabatic", "convective", "fixed"].includes(o.edge) ? o.edge : DEFAULTS.edge, hEdge: num(o.hEdge, 0, 1e5, DEFAULTS.hEdge),
      plating: num(o.plating, .001, .2, DEFAULTS.plating), kz: num(o.kz, .01, 500, DEFAULTS.kz), kxy: num(o.kxy, .01, 500, DEFAULTS.kxy),
      maxNodes: Math.round(num(o.maxNodes, 1e3, 5e6, DEFAULTS.maxNodes)), minPitch: num(o.minPitch, .02, 10, DEFAULTS.minPitch),
      pitch: o.pitch == null || o.pitch === "" ? null : num(o.pitch, .02, 20, null), includePDN: o.includePDN !== false, includeParts: o.includeParts !== false,
      sinks: (Array.isArray(o.sinks) ? o.sinks : []).slice(0, 64).map(normSink).filter(Boolean), power};
  }
  const read = doc => normalize(doc?.thermal);
  function write(doc, setup) { doc.thermal = normalize(setup); return doc.thermal; }

  // ---------------------------------------------------------------- materials
  // Thermal conductivity (W/m·K) by material name: [through-plane, in-plane].
  function material(name, setup) {
    const s = String(name || "");
    if (/polyimide|kapton|coverlay/i.test(s)) return [.2, .2];
    if (/adhesive|acrylic|epoxy film/i.test(s)) return [.2, .2];
    if (/ro\s?4|rogers|ro3|ro\s?5|taconic|isola|megtron|ptfe|teflon/i.test(s)) return [.6, .6];
    if (/alumina|ceramic|aln|nitride/i.test(s)) return [25, 25];
    if (/alumin(i)?um|copper core|metal/i.test(s)) return [150, 150];
    if (/solder|resist|mask/i.test(s)) return [.25, .25];
    return [setup.kz, setup.kxy];
  }
  // Copper layers and the dielectric between them, from the stack-up.
  function stack(doc, defs, setup) {
    const S = globalThis.AtriumStackup;
    let list = null;
    try { list = S?.get ? S.get(doc, defs).layers : null; } catch { list = null; }
    if (!list) {
      const cu = (globalThis.AtriumPDN?.copperStack?.(doc, defs)) || [{key: "Top", t: .035}, {key: "Bottom", t: .035}];
      list = [];
      cu.forEach((l, i) => { if (i) list.push({type: "Dielectric", material: "FR-4", thickness: 1.5 / (cu.length - 1)}); list.push({type: "Signal", key: l.key, thickness: l.t}); });
    }
    const isCu = l => l.type === "Signal" || l.type === "Plane";
    const idx = list.map((l, i) => isCu(l) && l.key ? i : -1).filter(i => i >= 0);
    const layers = idx.map(i => ({key: list[i].key, t: +list[i].thickness || .035, type: list[i].type, kd: 0, td: 0, shapes: [], tracks: []}));
    const gaps = [];
    const slab = arr => {
      let d = 0, rz = 0, kx = 0;
      for (const l of arr) { const t = +l.thickness || 0; if (!(t > 0)) continue; const [z, xy] = material(l.material || l.type, setup); d += t; rz += t / z; kx += t * xy; }
      return {d, kz: d > 0 ? d / rz : setup.kz, kxy: d > 0 ? kx / d : setup.kxy};
    };
    for (let k = 0; k + 1 < idx.length; k++) {
      const s = slab(list.slice(idx[k] + 1, idx[k + 1]).filter(l => !isCu(l)));
      gaps.push(s.d > 0 ? s : {d: .1, kz: setup.kz, kxy: setup.kxy});
    }
    // In-plane share: half of each adjacent gap, plus the outer layers outside the copper.
    const top = slab(list.slice(0, idx[0]).filter(l => !isCu(l))), bot = slab(list.slice(idx.at(-1) + 1).filter(l => !isCu(l)));
    layers.forEach((l, i) => {
      const parts = [];
      if (i > 0) parts.push({t: gaps[i - 1].d / 2, k: gaps[i - 1].kxy}); else if (top.d > 0) parts.push({t: top.d, k: top.kxy});
      if (i < layers.length - 1) parts.push({t: gaps[i].d / 2, k: gaps[i].kxy}); else if (bot.d > 0) parts.push({t: bot.d, k: bot.kxy});
      l.td = parts.reduce((s, p) => s + p.t, 0);
      l.kd = l.td > 0 ? parts.reduce((s, p) => s + p.t * p.k, 0) / l.td : setup.kxy;
    });
    const thickness = list.reduce((s, l) => s + (+l.thickness || 0), 0);
    return {layers, gaps, thickness};
  }

  // ---------------------------------------------------------------- component power
  const POWER_KEYS = [/^(thermal ?power|power ?dissipation|dissipation|pdiss|p ?diss|heat|heat ?dissipation)$/i, /^(pd|p_d)$/i, /^power$/i];
  const RATED_REF = /^(R|RN|RA|C|L|FB|F|RV|VR)\d/i;   // passives: "Power" is a rating, not a dissipation
  function parsePower(v) {
    const m = /^\s*([+]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(k|m|µ|u|μ)?\s*w?\s*$/i.exec(String(v ?? ""));
    if (!m) return null;
    const x = +m[1] * ({k: 1e3, K: 1e3, m: 1e-3, M: 1e-3, "µ": 1e-6, u: 1e-6, U: 1e-6, "μ": 1e-6}[m[2]] ?? 1);
    return Number.isFinite(x) && x >= 0 && x <= 1e4 ? x : null;
  }
  // Parts with a power: [{ref, id, power, source, key}]. Order: the panel's value, the variant's
  // parameters, the board part, its schematic part, the library part.
  function powers(doc, defs, project, setup) {
    const S = normalize(setup ?? read(doc)), out = [], ignored = [];
    let resolved = null;
    try { resolved = project && globalThis.AtriumVariants?.resolve ? AtriumVariants.resolve(project) : null; } catch { resolved = null; }
    const sch = new Map();
    for (const d of project?.documents || []) if (d.kind === "schematic") for (const i of d.items || []) if (i.kind === "part" && i.link) sch.set(i.link, i);
    for (const i of doc.items || []) {
      if (i.kind !== "part") continue;
      const ref = String(i.ref || i.id), key = i.link || i.id, r = resolved?.[key];
      if (r && r.fitted === false) continue;
      if (!r && (i.dnp === true || i.fitted === false)) continue;
      if (own(S.power, ref)) { if (S.power[ref] > 0) out.push({ref, id: i.id, power: S.power[ref], source: "panel"}); continue; }
      const sources = [["variant", r?.params], ["board part", i.parameters], ["schematic part", sch.get(i.link)?.parameters], ["library", defs?.get?.(r?.def || i.def)?.parameters]];
      let hit = null;
      for (let p = 0; p < POWER_KEYS.length && !hit; p++) for (const [name, params] of sources) {
        if (!params || typeof params !== "object") continue;
        const k = Object.keys(params).find(x => POWER_KEYS[p].test(x.trim()));
        if (k == null) continue;
        const w = parsePower(params[k]);
        if (w == null) continue;
        if (p === 2 && RATED_REF.test(ref)) { ignored.push(ref); break; }
        hit = {ref, id: i.id, power: w, source: name + " " + k};
        break;
      }
      if (hit && hit.power > 0) out.push(hit);
    }
    out.ignored = ignored;
    return out;
  }

  // ---------------------------------------------------------------- job (board -> solver input)
  const flat = pts => { const a = new Float64Array(pts.length * 2); pts.forEach((p, i) => { a[2 * i] = +p[0]; a[2 * i + 1] = +p[1]; }); return a; };
  function outlineOf(doc) {
    let o = Array.isArray(doc.outline) && doc.outline.length >= 3 ? doc.outline : null;
    if (!o) {
      let b = [Infinity, Infinity, -Infinity, -Infinity];
      const grow = (x, y) => { if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; };
      for (const i of doc.items || []) { if (Array.isArray(i.points)) for (const p of i.points) grow(p[0], p[1]); else if (Number.isFinite(i.x)) grow(i.x, i.y); }
      if (!(b[2] > b[0])) b = [0, 0, 50, 50];
      o = [[b[0] - 2, b[1] - 2], [b[2] + 2, b[1] - 2], [b[2] + 2, b[3] + 2], [b[0] - 2, b[3] + 2]];
    }
    let holes = [];
    try { holes = globalThis.AtriumBoardShape?.holes?.(doc) || []; } catch { holes = []; }
    return {outer: o, holes};
  }
  // Spread W over the cells overlapping box [x0, y0, x1, y1] by overlap area.
  function deposit(q, G, box, w) {
    const {x0, y0, nx, ny, h} = G;
    const a = Math.max(0, Math.floor((box[0] - x0) / h)), b = Math.min(nx - 1, Math.floor((box[2] - x0) / h)), c = Math.max(0, Math.floor((box[1] - y0) / h)), d = Math.min(ny - 1, Math.floor((box[3] - y0) / h));
    if (b < a || d < c) return 0;
    const tot = Math.max(1e-12, (box[2] - box[0]) * (box[3] - box[1]));
    if (!(box[2] > box[0]) || !(box[3] > box[1])) { q[c * nx + a] += w; return w; }
    let put = 0;
    for (let iy = c; iy <= d; iy++) for (let ix = a; ix <= b; ix++) {
      const ox = Math.min(box[2], x0 + (ix + 1) * h) - Math.max(box[0], x0 + ix * h), oy = Math.min(box[3], y0 + (iy + 1) * h) - Math.max(box[1], y0 + iy * h);
      if (ox > 0 && oy > 0) { const v = w * ox * oy / tot; q[iy * nx + ix] += v; put += v; }
    }
    return put;
  }
  function job(doc, defs, setupIn, opts = {}) {
    if (doc?.kind !== "pcb") throw Error("Choose a PCB layout for the temperature map.");
    const S = normalize(setupIn ?? read(doc)), notes = [];
    const st = stack(doc, defs, S), L = st.layers, nl = L.length, index = new Map(L.map((l, i) => [l.key, i]));
    const {outer, holes} = outlineOf(doc);
    let bx = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of outer) { if (p[0] < bx[0]) bx[0] = p[0]; if (p[1] < bx[1]) bx[1] = p[1]; if (p[0] > bx[2]) bx[2] = p[0]; if (p[1] > bx[3]) bx[3] = p[1]; }
    const W = bx[2] - bx[0], H = bx[3] - bx[1];
    let h = Math.max(S.minPitch, S.pitch > 0 ? S.pitch : 0, Math.sqrt(W * H * nl / S.maxNodes));
    h = Math.ceil(h / 1e-3 - 1e-9) * 1e-3;
    const x0 = bx[0] - h, y0 = bx[1] - h, nx = Math.ceil(W / h) + 3, ny = Math.ceil(H / h) + 3, n = nx * ny, G = {x0, y0, nx, ny, h};
    if (n * nl > S.maxNodes * 2.5) throw Error("The grid needs " + n * nl + " nodes; raise the pitch.");
    // Copper of every net.
    const P = globalThis.AtriumPDN, Pours = globalThis.AtriumPCBPours;
    const pours = (doc.pcbDrawing?.pours || []).filter(r => index.has(r.layer));
    const poured = new Set(pours.map(r => r.polygon).filter(v => v != null)), pourLayer = new Set(pours.filter(r => r.polygon == null).map(r => r.layer));
    for (const r of pours) { if (!Pours?.contours) break; try { const rings = Pours.contours(r).map(x => Float64Array.from(x)); if (rings.length) L[index.get(r.layer)].shapes.push(rings); } catch { notes.push("A pour region on " + r.layer + " could not be read."); } }
    if (pours.length && !Pours?.contours) notes.push("Poured copper could not be read; polygons are assumed solid.");
    let assumed = 0;
    const vias = [];
    const padRing = (p, parent) => P?.padRing ? P.padRing(p, parent) : null;
    const world = (p, parent) => globalThis.Atrium?.world ? Atrium.world(p, parent) : [p[0] + parent.x, p[1] + parent.y];
    const span = (a, b) => { const i = index.get(a), j = index.get(b); return i == null || j == null ? [0, nl - 1] : [Math.min(i, j), Math.max(i, j)]; };
    const partPads = new Map();   // part id -> [{layer, box, area}]
    const addPad = (p, parent) => {
      const L0 = p.layer || (p.kind === "via" || p.drill > 0 ? "Multi" : parent?.layer || "Top"), ring = padRing(p, parent);
      if (!ring) return;
      const ls = L0 === "Multi" ? (p.kind === "via" ? (([a, b]) => L.map((_, k) => k).filter(k => k >= a && k <= b))(span(p.fromLayer, p.toLayer)) : L.map((_, k) => k)) : index.has(L0) ? [index.get(L0)] : [];
      for (const l of ls) L[l].shapes.push([ring]);
      const c = parent ? world([+p.x || 0, +p.y || 0], parent) : [+p.x || 0, +p.y || 0];
      if (+p.drill > 0 && ls.length > 1 && p.plated !== false) vias.push({x: c[0], y: c[1], from: ls[0], to: ls.at(-1), drill: +p.drill});
      if (parent) {
        let b = [Infinity, Infinity, -Infinity, -Infinity];
        for (let i = 0; i < ring.length; i += 2) { const x = ring[i], y = ring[i + 1]; if (x < b[0]) b[0] = x; if (y < b[1]) b[1] = y; if (x > b[2]) b[2] = x; if (y > b[3]) b[3] = y; }
        const side = parent.layer === "Bottom" ? nl - 1 : 0;
        if (L0 === "Multi" || ls.includes(side)) { if (!partPads.has(parent.id)) partPads.set(parent.id, []); partPads.get(parent.id).push({layer: side, box: b, area: Math.max(1e-6, (b[2] - b[0]) * (b[3] - b[1]))}); }
      }
    };
    for (const i of doc.items || []) {
      if (i.kind === "part") { const fp = defs?.get?.(i.def)?.footprint; for (const p of fp?.pads || []) if (+(p.w ?? p.diameter) > 0) addPad(p, i); continue; }
      if (i.kind === "via" && Number.isFinite(i.x)) { addPad({kind: "via", x: i.x, y: i.y, diameter: +i.diameter || .6, drill: +i.drill || .3, shape: "round", fromLayer: i.fromLayer, toLayer: i.toLayer}, null); continue; }
      if (i.kind === "pad") { addPad(i, null); continue; }
      const l = index.get(i.layer || "Top");
      if (l == null || i.keepout || i.cutout || i.shelved) continue;
      if (i.kind === "polygon") {
        if (poured.has(i.id) || pourLayer.has(i.layer) || !Array.isArray(i.points) || i.points.length < 3) continue;
        L[l].shapes.push([flat(i.points)]); assumed++;
      } else if ((i.kind === "track" || i.kind === "graphic") && Array.isArray(i.points)) {
        if (i.fill && i.closed !== false && i.points.length >= 3) L[l].shapes.push([flat(i.points)]);
        else if (i.kind === "track" && i.points.length >= 2 && +i.width > 0) L[l].tracks.push({pts: flat(i.points), w: +i.width});
      }
    }
    if (assumed) notes.push(assumed + " unpoured polygon" + (assumed === 1 ? " is" : "s are") + " assumed solid.");
    // Heat.
    const q = L.map(() => new Float64Array(n));
    const sources = {parts: [], pdn: 0, pdnNets: []};
    if (S.includeParts) {
      const list = powers(doc, defs, opts.project, S);
      for (const pw of list) {
        const part = doc.items.find(i => i.id === pw.id), pads = partPads.get(pw.id);
        if (pads?.length) { const tot = pads.reduce((s, p) => s + p.area, 0); for (const p of pads) deposit(q[p.layer], G, p.box, pw.power * p.area / tot); }
        else if (part) deposit(q[part.layer === "Bottom" ? nl - 1 : 0], G, [part.x - 1, part.y - 1, part.x + 1, part.y + 1], pw.power);
        sources.parts.push({ref: pw.ref, id: pw.id, power: pw.power, source: pw.source});
      }
      if (list.ignored?.length) notes.push("\"Power\" on " + list.ignored.slice(0, 8).join(", ") + (list.ignored.length > 8 ? " …" : "") + " reads as a rating (passive part) and is not counted; enter dissipation in the panel or as \"Power Dissipation\".");
    }
    if (S.includePDN && opts.pdn?.length) {
      for (const res of opts.pdn) {
        if (!res) continue;
        const add = depositPDN(res, q, G, index, doc, defs);
        if (add > 0) { sources.pdn += add; sources.pdnNets.push(res.meta?.net); }
      }
    }
    const sinks = [];
    for (const s of S.sinks) {
      const ring = s.points ? flat(s.points) : flat([[s.box[0], s.box[1]], [s.box[2], s.box[1]], [s.box[2], s.box[3]], [s.box[0], s.box[3]]]);
      sinks.push({layer: s.side === "bottom" ? nl - 1 : 0, ring, ...(s.mode === "fixed" ? {rise: s.rise} : {h: s.h}), name: s.name || s.id});
    }
    const outline = [flat(outer), ...holes.map(flat)];
    return {x0, y0, nx, ny, h, outline, kCu: K_CU, plating: S.plating, layers: L, gaps: st.gaps, vias, hTop: S.hTop, hBottom: S.hBottom,
      edge: {mode: S.edge, h: S.hEdge}, sinks, q, tol: 1e-6, maxIter: 20000,
      meta: {notes, sources, setup: S, thickness: st.thickness, board: bx}};
  }
  // PDN result -> I²R per thermal cell; scaled so the total equals the PDN's power. Returns W.
  function depositPDN(res, q, G, index, doc, defs) {
    const P = globalThis.AtriumPDN, rho = res.rho ?? P?.rhoAt?.(res.meta?.temperature ?? 25) ?? globalThis.AtriumElectricalMaterial.RHO20;
    const cu = P?.copperStack ? P.copperStack(doc, defs) : [];
    const tOf = k => cu.find(l => l.key === k)?.t || .035;
    const tmp = new Map(), {x0, y0, nx, ny, h} = G;
    const at = (l, x, y, w) => {
      const ix = Math.floor((x - x0) / h), iy = Math.floor((y - y0) / h);
      if (ix < 0 || iy < 0 || ix >= nx || iy >= ny || !(w > 0)) return 0;
      let a = tmp.get(l); if (!a) tmp.set(l, a = new Float64Array(nx * ny));
      a[iy * nx + ix] += w; return w;
    };
    let sum = 0;
    for (const lay of res.layers || []) {
      const g = lay.grid, l = index.get(lay.key);
      if (!g || l == null) continue;
      const t = tOf(lay.key), cell = g.h * g.h;
      for (let c = 0; c < g.nx * g.ny; c++) {
        const cv = g.cov[c], j = g.j[c];
        if (!cv || !(j > 0)) continue;
        sum += at(l, g.x0 + ((c % g.nx) + .5) * g.h, g.y0 + (Math.floor(c / g.nx) + .5) * g.h, rho * j * j * t * cell * cv / 255);
      }
    }
    const ch = res.chain;
    for (let k = 0; ch && k < ch.n; k++) {
      const l = index.get(res.layers[ch.layer[k]]?.key), w = Math.abs(ch.i[k] * (ch.ua[k] - ch.ub[k]));
      if (l == null || !(w > 0)) continue;
      const ax = ch.geo[4 * k], ay = ch.geo[4 * k + 1], bx = ch.geo[4 * k + 2], by = ch.geo[4 * k + 3], len = Math.hypot(bx - ax, by - ay), m = Math.max(1, Math.ceil(len / h));
      for (let s = 0; s < m; s++) sum += at(l, ax + (bx - ax) * (s + .5) / m, ay + (by - ay) * (s + .5) / m, w / m);
    }
    const total = res.power > 0 ? res.power : sum, scale = sum > 0 ? total / sum : 0;
    for (const [l, a] of tmp) { const dst = q[l]; for (let c = 0; c < a.length; c++) if (a[c]) dst[c] += a[c] * scale; }
    return sum > 0 ? total : 0;
  }
  const solve = j => core().compute(j);

  // ---------------------------------------------------------------- worker
  let scriptURL = null;
  try { scriptURL = globalThis.document?.currentScript?.src || null; } catch { scriptURL = null; }
  let workerBroken = false;
  function makeWorker() {
    const pdn = globalThis.AtriumPDN;
    if (workerBroken || typeof Worker !== "function" || !pdn) return null;
    try {
      if (typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
        const src = '"use strict";\n' + pdn.coreFactory.toString() + "\n" + AtriumThermalCore.toString() + "\n" + pdn.serve.toString() + "\nAtriumPDNServe(self, AtriumThermalCore(AtriumPDNCore()));\n";
        const worker = AtriumWorkerPool.blobWorker(src);
        if (worker) return worker;
      }
    } catch { /* blob workers may be blocked */ }
    try { if (scriptURL) return new Worker(new URL("../workers/thermal-worker.js", scriptURL).href); } catch { /* fall back */ }
    return null;
  }
  // Off the UI thread: {promise, cancel}. Without a worker, one solve after the current frame.
  function run(j, options) {
    return globalThis.AtriumPDN.runSolver(j, options, {
      compute: (job, onProgress) => core().compute(job, onProgress),
      makeWorker, markBroken() { workerBroken = true; },
      transfers(plain) { return plain.q.map(a => a.buffer); },
      failed: "The thermal worker failed."});
  }

  // ---------------------------------------------------------------- report
  const ASSUMPTIONS = Object.freeze([
    "Steady state; temperatures are rises above ambient.",
    "Copper k 385 W/m·K by layer and copper fraction per cell; dielectric k from the stack-up material (FR-4 0.3 through-plane, 0.8 in-plane).",
    "Vias and plated holes conduct through their plating only (k·π(d+t)·t/Δz).",
    "Component heat enters the board under the part's pads; bodies do not convect or radiate on their own.",
    "Convection plus radiation as one h per face; edges and heatsinks as set.",
    "One temperature for copper resistance (the PDN Analyzer's); no self-heating feedback."]);
  function partAt(doc, p, parts) {
    let best = null, bd = 5;
    for (const i of parts) { const d = Math.hypot(i.x - p[0], i.y - p[1]); if (d < bd) { bd = d; best = i; } }
    return best;
  }
  // Local maxima per layer with suppression, highest first.
  function hotspots(res, L, {count = 10, radius = 4, floor = .25} = {}) {
    const {x0, y0, nx, ny, h} = res.grid, cand = [];
    const thr = Math.max(.5, res.tMax * floor);
    res.layers.forEach((lay, li) => {
      const t = lay.t;
      for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
        const c = iy * nx + ix, v = t[c];
        if (!(v >= thr)) continue;
        let peak = true;
        for (let dy = -1; dy <= 1 && peak; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const jx = ix + dx, jy = iy + dy;
          if (jx < 0 || jy < 0 || jx >= nx || jy >= ny) continue;
          const w = t[jy * nx + jx];
          if (w > v || (w === v && jy * nx + jx < c)) { peak = false; break; }
        }
        if (peak) cand.push({layer: lay.key, li, rise: v, at: [x0 + (ix + .5) * h, y0 + (iy + .5) * h]});
      }
    });
    cand.sort((a, b) => b.rise - a.rise);
    const out = [];
    for (const c of cand) { if (out.some(o => Math.hypot(o.at[0] - c.at[0], o.at[1] - c.at[1]) < radius)) continue; out.push(c); if (out.length >= count) break; }
    void L;
    return out;
  }
  function sample(res, li, p) {
    const {x0, y0, nx, ny, h} = res.grid, ix = Math.floor((p[0] - x0) / h), iy = Math.floor((p[1] - y0) / h);
    if (ix < 0 || iy < 0 || ix >= nx || iy >= ny) return NaN;
    return res.layers[li]?.t[iy * nx + ix];
  }
  function report(doc, defs, j, res, opts = {}) {
    const S = j.meta.setup, parts = (doc.items || []).filter(i => i.kind === "part");
    const hs = hotspots(res, j.layers, opts).map(x => { const p = partAt(doc, x.at, parts); return {layer: x.layer, rise: r2(x.rise), temperature: r2(S.ambient + x.rise), at: [r4(x.at[0]), r4(x.at[1])], ref: p?.ref || null, id: p?.id || null}; });
    const partRows = j.meta.sources.parts.map(s => {
      const p = parts.find(i => i.id === s.id), li = p?.layer === "Bottom" ? res.layers.length - 1 : 0, v = p ? sample(res, li, [p.x, p.y]) : NaN;
      return {ref: s.ref, id: s.id, power: r4(s.power), source: s.source, rise: r2(v), temperature: fin(v) ? r2(S.ambient + v) : null, at: p ? [r4(p.x), r4(p.y)] : null};
    }).sort((a, b) => (b.rise || 0) - (a.rise || 0));
    const totalPower = j.meta.sources.parts.reduce((s, p) => s + p.power, 0) + j.meta.sources.pdn;
    const notes = [...j.meta.notes, ...(res.notes || [])];
    if (!(totalPower > 0)) notes.push("No heat source: give parts a \"Power Dissipation\" parameter (W) or a value in the panel, or include the PDN Analyzer's losses.");
    if (Math.abs(res.balance) > .02 && totalPower > 0) notes.push("Energy balance is off by " + (res.balance * 100).toFixed(1) + " %; raise the solver accuracy (finer pitch).");
    return {summary: {ambient: S.ambient, maxRise: r2(res.tMax), maxTemperature: r2(S.ambient + res.tMax), at: res.tMaxAt ? [r4(res.tMaxAt[0]), r4(res.tMaxAt[1])] : null, layer: res.layers[res.tMaxLayer]?.key || null,
      power: r4(totalPower), partsPower: r4(j.meta.sources.parts.reduce((s, p) => s + p.power, 0)), pdnPower: r4(j.meta.sources.pdn), pdnNets: j.meta.sources.pdnNets,
      pitch: r4(res.grid.h), nodes: res.stats.nodes, iterations: res.stats.iterations, ms: r2(res.stats.ms.total), phases: Object.fromEntries(Object.entries(res.stats.ms).map(([k, v]) => [k, Math.round(v)])), balance: r4(res.balance),
      minRise: r2(res.layers.reduce((m, l) => { const t = l.t; for (let i = 0; i < t.length; i++) if (t[i] < m) m = t[i]; return m; }, Infinity))},
    layers: res.layers.map(l => ({layer: l.key, maxRise: r2(l.max), meanRise: r2(l.mean), at: l.maxAt ? [r4(l.maxAt[0]), r4(l.maxAt[1])] : null})),
    hotspots: hs, parts: partRows, boundaries: {hTop: S.hTop, hBottom: S.hBottom, air: S.air, edge: S.edge, hEdge: S.hEdge, sinks: S.sinks.length},
    notes: [...new Set(notes)], assumptions: ASSUMPTIONS};
  }
  // Synchronous: PDN (when asked and saved), job, solve, report.
  function pdnResults(doc, defs, setup, project) {
    const P = globalThis.AtriumPDN, out = [], notes = [];
    if (!P) return {out, notes: ["PDN losses need the PDN Analyzer module."]};
    const saved = P.read(doc);
    for (const n of saved.nets.filter(x => x.enabled)) {
      try { const r = P.analyze(doc, defs, n, saved); out.push(Object.assign(r.supply, {rho: P.rhoAt(saved.temperature)})); if (r.ret) out.push(Object.assign(r.ret, {rho: P.rhoAt(saved.temperature)})); }
      catch (e) { notes.push("PDN " + n.net + ": " + e.message); }
    }
    if (!saved.nets.length) notes.push("No PDN Analyzer setup is saved with this board, so I²R losses are not included.");
    void setup; void project;
    return {out, notes};
  }
  function analyze(doc, defs, setup, opts = {}) {
    const S = normalize(setup ?? read(doc));
    let pdn = opts.pdn, pnotes = [];
    if (!pdn && S.includePDN) ({out: pdn, notes: pnotes} = pdnResults(doc, defs, S, opts.project));
    const j = job(doc, defs, S, {project: opts.project, pdn});
    j.meta.notes.push(...pnotes);
    const res = Object.assign(solve(j), {meta: j.meta});
    return {job: j, result: res, report: report(doc, defs, j, res, opts)};
  }
  // MCP thermal_map (read-only).
  function headless(a, host) {
    const p = host.project(), doc = host.board(p, a.document_id), defs = host.defsOf(p), saved = read(doc);
    const setup = normalize({...saved, ...(a.ambient != null ? {ambient: a.ambient} : {}), ...(a.air ? {air: a.air} : {}), ...(a.h_top != null || a.h_bottom != null ? {air: "custom", hTop: a.h_top ?? saved.hTop, hBottom: a.h_bottom ?? saved.hBottom} : {}),
      ...(a.edge ? {edge: a.edge} : {}), ...(a.pitch != null ? {pitch: a.pitch} : {}), ...(a.max_nodes != null ? {maxNodes: a.max_nodes} : {}), ...(a.include_pdn != null ? {includePDN: !!a.include_pdn} : {}),
      ...(a.power && typeof a.power === "object" ? {power: {...saved.power, ...a.power}} : {}), ...(Array.isArray(a.heatsinks) ? {sinks: [...saved.sinks, ...a.heatsinks]} : {})});
    const r = analyze(doc, defs, setup, {project: p, count: a.max_hotspots ?? 10});
    const R = r.report;
    return {document_id: doc.id, estimate: true, units: {length: "mm", temperature: "°C", rise: "°C above ambient", power: "W", h: "W/m²·K"},
      model: "ESTIMATE. Steady-state 2D finite-volume grid per copper layer with through-plane coupling: copper (k 385) by copper fraction per cell, dielectric k from the stack-up, vias as plated copper barrels, convection h per face, heatsinks and edges as set; heat from part power and PDN I²R; MIC(0)-preconditioned CG. Component bodies are not modelled.",
      summary: R.summary, layers: R.layers, hotspots: R.hotspots, parts: R.parts.slice(0, a.max_parts ?? 50), boundaries: R.boundaries, assumptions: R.assumptions, notes: R.notes, setup};
  }

  // ---------------------------------------------------------------- colour ramps (sequential, one hue)
  // Orange, light to dark on light canvases and dark to light on dark ones, so the lowest rise
  // recedes into the canvas. Lightness is monotonic (OKLCH L 0.93 → 0.38 and 0.30 → 0.92), so the
  // order reads without colour vision; the readout and legend carry the numbers.
  const RAMP_LIGHT = [[253, 236, 222], [252, 214, 186], [249, 186, 145], [244, 155, 103], [235, 122, 65], [216, 92, 36], [184, 69, 22], [147, 52, 15], [110, 38, 10]];
  const RAMP_DARK = [[70, 30, 12], [104, 42, 14], [140, 55, 17], [178, 70, 22], [214, 92, 36], [236, 124, 66], [246, 160, 110], [251, 197, 160], [254, 230, 210]];
  // Same interpolation and legend as PDN. A missing dark argument stays on the dark theme; a provided falsy value selects light.
  const lightRamp = globalThis.AtriumPDN.paletteRamp(RAMP_LIGHT);
  const darkRamp = globalThis.AtriumPDN.paletteRamp(RAMP_DARK);
  const palette = (dark = true) => dark ? darkRamp : lightRamp;
  const ramp = (t, dark) => palette(dark).ramp(t);
  const rgb = (t, dark) => palette(dark).rgb(t);
  const gradient = (dark, dir) => palette(dark).gradient(dir);

  return Object.freeze({VERSION, DEFAULTS, AIR, K_CU, ASSUMPTIONS, normalize, read, write, material, stack, powers, parsePower, job, depositPDN, solve, run, report, hotspots, sample, analyze, pdnResults, headless,
    ramp, rgb, gradient, RAMP_LIGHT, RAMP_DARK, core: () => core()});
})();
