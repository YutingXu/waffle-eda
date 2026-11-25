"use strict";
if (!globalThis.AtriumElectricalMaterial && typeof require === "function") require("./electrical-material.js");
if (!globalThis.AtriumLandContours && typeof require === "function") require("../pcb/land-contours.js");
if (!globalThis.AtriumWorkerPool && typeof require === "function") require("../workers/worker-pool.js");
// PDN Analyzer (Tools › PDN Analyzer…): DC voltage drop and current density on power nets.
//
// Model (a 2D sheet model; read "Accuracy" before trusting a number)
//  * Each copper layer of the net is a resistive sheet, R□ = ρ(T)/t, with t the layer's copper
//    thickness from the stack-up and ρ(T) = ρ20·(1 + α·(T − 20)), ρ20 = 1.7241·10⁻⁸ Ω·m
//    (annealed copper, IEC 60028), α = 0.00393 /°C. Current is uniform through the thickness.
//  * Area copper (poured polygon regions, unpoured polygons, fills, and tracks at least three
//    cells wide) is rasterised on a square grid whose pitch adapts to the board: the finest
//    pitch the fine-cell cap allows (`maxCells`, default 4 M over all layers; never below
//    `minPitch`, 0.05 mm). Partial cells keep their exact horizontal coverage (4 sub-rows per
//    cell), and the conductance across a cell boundary uses the harmonic mean of the two
//    coverages, so a strip that is not a whole number of cells wide keeps its true width.
//    Interiors of solid copper are then coarsened into quadtree blocks (up to 64 × 64 cells)
//    that stay at least their own size away from any edge, void, pad or via, with
//    two-point flux conductances between neighbours of different size (normal distance).
//  * Tracks narrower than three cells are exact 1D resistors, ρ·L/(w·t), split where they
//    cross pads, meet other tracks and vias, and every two cells where they run over a grid.
//  * Pads and via lands are lumps: the cells under them are one node. Source and load pins are
//    therefore equipotential (a soldered lead). Component leads in plated holes join their
//    layers directly; vias and free plated pads join consecutive layers through the barrel,
//    R = ρ·Δz / (π·(d + tp)·tp), d the finished hole, tp the plating, Δz between layer centres.
//  * The source pins are held at the net voltage; each load draws its current (per pin, or a
//    total split equally across its pins). The return net is solved the same way with the
//    source's return pins at 0 V and the loads' return pins injecting the load currents.
//    Load voltage = V(supply at the load) − V(return at the load).
//  * The sheet-resistance network is solved with conjugate gradients preconditioned by a
//    modified incomplete Cholesky factorisation (MIC(0)), in a Web Worker in the editor.
//
// Accuracy (tests/pdn.cjs checks the analytic cases)
//  * Uniform strip R = ρL/(wt): within 0.2 %. Two vias in parallel: exact (R_via/2).
//    L-shaped trace with the corner square at 0.559 squares: within 0.5 %.
//  * Not modelled: self-heating (one temperature for the whole board), current crowding
//    through the copper thickness, plating on outer layers (enter the finished thickness in
//    the stack-up), thermal-relief spokes narrower than the grid pitch, via-to-plane spreading
//    below the pitch, component internal resistance, AC effects. Current density next to a
//    small pad or via is resolved only to the grid pitch.
//
// API (DOM-free; the panel is pdn-view.js):
//   AtriumPDN.normalize(raw)                 -> saved setup {version, temperature, plating, ..., nets:[...]}
//   AtriumPDN.read(doc) / AtriumPDN.write(doc, setup)    doc.pdn, saved with the board
//   AtriumPDN.guess(doc, defs, net?)         -> a net setup with a likely source, loads and return net
//   AtriumPDN.job(doc, defs, netSetup, setup, "supply"|"return") -> worker job (plain + typed arrays)
//   AtriumPDN.solve(job)                     -> raw result (synchronous; AtriumPDNCore)
//   AtriumPDN.run(job, {onProgress})         -> {promise, cancel} (Web Worker; without one, on the UI thread)
//   AtriumPDN.analyze(doc, defs, netSetup, setup) -> report (both solves, synchronous)
//   AtriumPDN.report(...)                    -> loads, densities, vias, violations, notes
//   AtriumPDN.headless(args, host)           -> MCP pdn_analyze
// Units: mm, V, A, A/mm², °C.

// The solver core is one self-contained function so it can be serialised into a Blob worker
// without a build step, even from file:// (the autorouter's pattern). It must not close over
// anything outside itself.
function AtriumPDNCore() {
  "use strict";
  const SUB = 4;                 // sub-rows per cell row for coverage
  const COPPER = 0.02;           // a cell with less coverage is not copper
  const ATTACH = 0.25;           // a point attaches to a cell with at least this coverage
  const MAXB = 64;               // largest quadtree block, in cells
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

  // ---------------------------------------------------------------- growable typed arrays
  function I32(n) { return {a: new Int32Array(Math.max(16, n)), n: 0}; }
  function F64(n) { return {a: new Float64Array(Math.max(16, n)), n: 0}; }
  function push(v, x) { if (v.n === v.a.length) { const b = new v.a.constructor(v.a.length * 2); b.set(v.a); v.a = b; } v.a[v.n++] = x; }

  // ---------------------------------------------------------------- coverage raster
  // Adds the even-odd interior of rings (flat [x, y, ...] arrays) on grid g to acc (cell area
  // fractions). touched, when given, collects the cells that were zero before.
  function raster(rings, g, acc, touched) {
    const x0 = g.x0, y0 = g.y0, nx = g.nx, ny = g.ny, h = g.h, hs = h / SUB;
    let lo = Infinity, hi = -Infinity;
    for (const r of rings) for (let i = 1; i < r.length; i += 2) { const y = r[i]; if (y < lo) lo = y; if (y > hi) hi = y; }
    const s0 = Math.max(0, Math.ceil((lo - y0) / hs - .5)), s1 = Math.min(ny * SUB - 1, Math.ceil((hi - y0) / hs - .5) - 1);
    if (!(s1 >= s0)) return;
    const nr = s1 - s0 + 1, start = new Int32Array(nr + 1);
    let xs = null, put = null;
    for (let pass = 0; pass < 2; pass++) {
      if (pass === 1) { for (let r = 0; r < nr; r++) start[r + 1] += start[r]; xs = new Float64Array(start[nr]); put = start.slice(0, nr); }
      for (const r of rings) {
        const m = r.length >> 1;
        for (let i = 0; i < m; i++) {
          const j = i + 1 === m ? 0 : i + 1, ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * j], by = r[2 * j + 1];
          if (ay === by) continue;
          const ylo = ay < by ? ay : by, yhi = ay < by ? by : ay;
          let a = Math.ceil((ylo - y0) / hs - .5), b = Math.ceil((yhi - y0) / hs - .5) - 1;
          if (a < s0) a = s0;
          if (b > s1) b = s1;
          if (b < a) continue;
          if (pass === 0) { for (let s = a; s <= b; s++) start[s - s0 + 1]++; continue; }
          const k = (bx - ax) / (by - ay);
          for (let s = a; s <= b; s++) { const y = y0 + (s + .5) * hs; xs[put[s - s0]++] = ax + (y - ay) * k; }
        }
      }
    }
    const w = 1 / SUB;
    for (let r = 0; r < nr; r++) {
      const a = start[r], b = start[r + 1];
      if (b - a < 2) continue;
      const row = xs.subarray(a, b);
      row.sort();
      const base = Math.floor((s0 + r) / SUB) * nx;
      for (let k = 0; k + 1 < row.length; k += 2) {
        let fa = (row[k] - x0) / h, fb = (row[k + 1] - x0) / h;
        if (fa < 0) fa = 0;
        if (fb > nx) fb = nx;
        if (!(fb > fa)) continue;
        const ia = Math.floor(fa), ib = Math.min(nx - 1, Math.floor(fb));
        if (ia === ib) { add(base + ia, (fb - fa) * w); continue; }
        add(base + ia, (ia + 1 - fa) * w);
        for (let i = ia + 1; i < ib; i++) add(base + i, w);
        add(base + ib, (fb - ib) * w);
      }
    }
    function add(c, v) { if (touched && acc[c] === 0) push(touched, c); acc[c] += v; }
  }

  // ---------------------------------------------------------------- geometry helpers
  function inside(x, y, r) {
    let c = false;
    const m = r.length >> 1;
    for (let i = 0, j = m - 1; i < m; j = i++) {
      const ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * j], by = r[2 * j + 1];
      if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) c = !c;
    }
    return c;
  }
  function ringBox(r) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (let i = 0; i < r.length; i += 2) { const x = r[i], y = r[i + 1]; if (x < a) a = x; if (x > c) c = x; if (y < b) b = y; if (y > d) d = y; }
    return [a, b, c, d];
  }
  function ringArea(r) {
    let s = 0;
    const m = r.length >> 1;
    for (let i = 0, j = m - 1; i < m; j = i++) s += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
    return Math.abs(s) / 2;
  }
  // Capsule polygon around segment a-b of width w (9 points per end).
  function capsuleRing(ax, ay, bx, by, w) {
    const r = w / 2, dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1, ux = dx / l, uy = dy / l, nx = -uy, ny = ux, out = new Float64Array(36);
    let k = 0;
    // End b: from +normal through +direction to −normal.
    for (let i = 0; i <= 8; i++) { const t = Math.PI * i / 8, c = Math.cos(t), s = Math.sin(t); out[k++] = bx + r * (nx * c + ux * s); out[k++] = by + r * (ny * c + uy * s); }
    // End a: from −normal through −direction to +normal.
    for (let i = 0; i <= 8; i++) { const t = Math.PI * i / 8, c = Math.cos(t), s = Math.sin(t); out[k++] = ax + r * (-nx * c - ux * s); out[k++] = ay + r * (-ny * c - uy * s); }
    return out;
  }

  // ---------------------------------------------------------------- sparse kernels
  // Kept as small standalone functions over typed arrays so every engine optimises them.
  // MIC(0): incomplete Cholesky (as ILU(0) on a symmetric pattern, LDLᵀ), with the dropped
  // fill moved to the diagonal (omega 0.97). Rows sorted by column; dp points at diagonals.
  function micFactor(n, urow, col, val, dp) {
    const f = val.slice(), pos = new Int32Array(n).fill(-1), omega = .97;
    for (let i = 0; i < n; i++) {
      const s = urow[i], e = urow[i + 1], di = dp[i], d0 = f[di];
      for (let k = s; k < e; k++) pos[col[k]] = k;
      let drop = 0;
      for (let k = s; k < di; k++) {
        const j = col[k], lik = f[k] / f[dp[j]];
        f[k] = lik;
        for (let m = dp[j] + 1, me = urow[j + 1]; m < me; m++) { const q = pos[col[m]]; if (q >= 0) f[q] -= lik * f[m]; else drop += lik * f[m]; }
      }
      f[di] -= omega * drop;
      if (!(f[di] > 1e-12 * d0)) f[di] = d0;
      for (let k = s; k < e; k++) pos[col[k]] = -1;
    }
    return f;
  }
  function precond(n, urow, col, dp, f, r, z) {
    for (let i = 0; i < n; i++) { let s = r[i]; for (let k = urow[i], e = dp[i]; k < e; k++) s -= f[k] * z[col[k]]; z[i] = s; }
    for (let i = n - 1; i >= 0; i--) { let s = z[i]; for (let k = dp[i] + 1, e = urow[i + 1]; k < e; k++) s -= f[k] * z[col[k]]; z[i] = s / f[dp[i]]; }
  }
  // q = A·p; returns p·q.
  function matvec(n, urow, col, val, p, q) {
    let pq = 0;
    for (let i = 0; i < n; i++) { let s = 0; for (let k = urow[i], e = urow[i + 1]; k < e; k++) s += val[k] * p[col[k]]; q[i] = s; pq += p[i] * s; }
    return pq;
  }
  function dot(n, a, b) { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; }
  function axpy2(n, alpha, p, q, x, r) { let rr = 0; for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; const v = r[i] - alpha * q[i]; r[i] = v; rr += v * v; } return rr; }
  function xpby(n, z, beta, p) { for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i]; }
  // Preconditioned conjugate gradients; stops at |r|/|b| < tol.
  function pcg(n, urow, col, val, dp, f, b, tol, maxIter, progress) {
    const x = new Float64Array(n), r = b.slice(), z = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n);
    const bn = Math.sqrt(dot(n, b, b));
    let it = 0, res = 0;
    if (!n || !(bn > 0)) return {x, it, res, bn};
    precond(n, urow, col, dp, f, r, z); p.set(z);
    let rz = dot(n, r, z);
    for (it = 1; it <= maxIter; it++) {
      const alpha = rz / matvec(n, urow, col, val, p, q);
      res = Math.sqrt(axpy2(n, alpha, p, q, x, r)) / bn;
      if (res < tol) break;
      precond(n, urow, col, dp, f, r, z);
      const rz2 = dot(n, r, z), beta = rz2 / rz;
      rz = rz2;
      xpby(n, z, beta, p);
      if (it % 20 === 0) progress({phase: "solve", done: it, residual: res});
    }
    return {x, it, res, bn};
  }

  // ---------------------------------------------------------------- the solver
  // job: {rho Ω·mm, plating mm, maxCells, minPitch, pitch?, tol, maxIter,
  //   layers:[{key, t, zMid}], shapes:[{layer, rings}], tracks:[{layer, pts, w}],
  //   pads:[{layers:[li], ring, x, y, lead, barrel, drill, term, via}], terms:[{kind:"source"|"sink", i}]}
  // Calls progress({phase, done?, unknowns?}); returns the result. A plain function, not a
  // generator: V8 does not optimise long loops inside generators (no on-stack replacement).
  function compute(job, progress = () => {}) {
    const T = {start: now()}, notes = [];
    const rho = job.rho, L = job.layers, nl = L.length;
    if (!(rho > 0) || !nl) throw Error("No copper layers.");
    const gs = L.map(l => l.t / rho);                       // sheet conductance per layer (S)
    // ---- 1. pitch and grids
    const areaBox = L.map(() => [Infinity, Infinity, -Infinity, -Infinity]), areaCu = new Float64Array(nl), hasArea = new Uint8Array(nl);
    const grow = (b, q) => { if (q[0] < b[0]) b[0] = q[0]; if (q[1] < b[1]) b[1] = q[1]; if (q[2] > b[2]) b[2] = q[2]; if (q[3] > b[3]) b[3] = q[3]; };
    const minPitch = job.minPitch > 0 ? job.minPitch : .05, wideMin = 3 * minPitch;
    for (const s of job.shapes) {
      const b = ringBox(s.rings[0]); grow(areaBox[s.layer], b); hasArea[s.layer] = 1;
      let a = ringArea(s.rings[0]); for (let i = 1; i < s.rings.length; i++) a -= ringArea(s.rings[i]);
      areaCu[s.layer] += Math.max(0, a);
    }
    for (const t of job.tracks) if (t.w >= wideMin) {
      const b = ringBox(t.pts); grow(areaBox[t.layer], [b[0] - t.w, b[1] - t.w, b[2] + t.w, b[3] + t.w]); hasArea[t.layer] = 1;
    }
    for (const p of job.pads) { const b = ringBox(p.ring); for (const l of p.layers) if (hasArea[l]) grow(areaBox[l], b); }
    let boxArea = 0;
    for (let l = 0; l < nl; l++) if (hasArea[l]) boxArea += (areaBox[l][2] - areaBox[l][0] + 4 * minPitch) * (areaBox[l][3] - areaBox[l][1] + 4 * minPitch);
    const maxCells = job.maxCells > 0 ? job.maxCells : 4e6;
    let h = Math.max(minPitch, job.pitch > 0 ? job.pitch : 0, Math.sqrt(boxArea / maxCells));
    h = Math.ceil(h / 1e-3 - 1e-9) * 1e-3;                   // a whole micrometre: grids line up with round coordinates
    const wide = 3 * h;
    for (const t of job.tracks) if (t.w >= wide) hasArea[t.layer] = 1; else if (t.w >= wideMin) { /* became a 1D element */ }
    const grids = [];
    let cells = 0;
    for (let l = 0; l < nl; l++) {
      if (!hasArea[l]) { grids.push(null); continue; }
      const b = areaBox[l];
      const x0 = (Math.floor(b[0] / h) - 1) * h, y0 = (Math.floor(b[1] / h) - 1) * h;
      const nx = Math.max(1, Math.ceil((b[2] - x0) / h) + 1), ny = Math.max(1, Math.ceil((b[3] - y0) / h) + 1);
      grids.push({l, x0, y0, nx, ny, h, n: nx * ny, base: cells, cov: new Float32Array(nx * ny)});
      cells += nx * ny;
    }
    if (cells > maxCells * 1.6) throw Error("The copper needs " + cells + " grid cells; the cap is " + maxCells + ".");
    progress({phase: "raster"});
    // ---- 2. area copper
    for (const s of job.shapes) raster(s.rings, grids[s.layer], grids[s.layer].cov);
    const chainsIn = [];
    for (let k = 0; k < job.tracks.length; k++) {
      const t = job.tracks[k], g = grids[t.layer];
      if (g && t.w >= wide) { for (let i = 2; i < t.pts.length; i += 2) raster([capsuleRing(t.pts[i - 2], t.pts[i - 1], t.pts[i], t.pts[i + 1], t.w)], g, g.cov); }
      else chainsIn.push(k);
    }
    // ---- 3. nodes: union-find over grid vertices (bilinear elements), then point nodes
    let verts = 0;
    for (const g of grids) if (g) { g.vx = g.nx + 1; g.vbase = verts; verts += g.vx * (g.ny + 1); }
    let cap = verts + 1024, parent = new Int32Array(cap), nodes = verts;
    (() => { for (let i = 0; i < verts; i++) parent[i] = i; })();
    const corner = (g, c, k) => g.vbase + (Math.floor(c / g.nx) + (k >> 1)) * g.vx + (c % g.nx) + (k & 1);
    const make = () => { if (nodes === cap) { cap *= 2; const p = new Int32Array(cap); p.set(parent); parent = p; } parent[nodes] = nodes; return nodes++; };
    const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    const union = (a, b) => { a = find(a); b = find(b); if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; } return a < b ? a : b; };
    const pinned = grids.map(g => g && new Uint8Array(g.n));
    // Lumps: pads and via lands. On a grid layer, the cells they cover (half or more, and the
    // cell at the centre); on a layer without a grid, one point node each.
    const scratch = grids.map(g => g && new Float32Array(0));
    const lumpNode = job.pads.map(() => new Int32Array(nl).fill(-1));
    const gridless = L.map(() => []);                      // per layer: pad indices for point lookups
    for (let k = 0; k < job.pads.length; k++) {
      const p = job.pads[k];
      for (const l of p.layers) {
        const g = grids[l];
        if (!g) { lumpNode[k][l] = make(); gridless[l].push(k); continue; }
        if (scratch[l].length !== g.n) scratch[l] = new Float32Array(g.n);
        const s = scratch[l], touched = I32(64);
        raster([p.ring], g, s, touched);
        const cx = Math.floor((p.x - g.x0) / h), cy = Math.floor((p.y - g.y0) / h), cc = cx >= 0 && cy >= 0 && cx < g.nx && cy < g.ny ? cy * g.nx + cx : -1;
        let rep = -1, centre = false;
        const take = c => { pinned[l][c] = 1; for (let q = 0; q < 4; q++) rep = rep < 0 ? corner(g, c, q) : union(rep, corner(g, c, q)); if (c === cc) centre = true; };
        for (let i = 0; i < touched.n; i++) { const c = touched.a[i]; g.cov[c] += s[c]; if (s[c] >= .5) take(c); s[c] = 0; }
        if (cc >= 0 && !centre) { if (g.cov[cc] < ATTACH) g.cov[cc] = ATTACH; take(cc); }
        lumpNode[k][l] = rep;
      }
    }
    (() => { for (const g of grids) if (g) for (let c = 0; c < g.n; c++) if (g.cov[c] > 1) g.cov[c] = 1; })();
    // Lumps on a grid-less layer that overlap (a via in a pad) are one node.
    for (let l = 0; l < nl; l++) {
      const list = gridless[l];
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
        const a = job.pads[list[i]], b = job.pads[list[j]];
        if (Math.abs(a.x - b.x) > 50 || Math.abs(a.y - b.y) > 50) continue;
        if (inside(a.x, a.y, b.ring) || inside(b.x, b.y, a.ring)) union(lumpNode[list[i]][l], lumpNode[list[j]][l]);
      }
    }
    // Component leads in plated holes join their layers.
    for (let k = 0; k < job.pads.length; k++) { const p = job.pads[k]; if (p.lead && p.layers.length > 1) for (let i = 1; i < p.layers.length; i++) union(lumpNode[k][p.layers[0]], lumpNode[k][p.layers[i]]); }
    // Pad lookup per layer (spatial hash, 2 mm cells) for attaching points.
    const PH = 2, padHash = L.map(() => new Map());
    for (let k = 0; k < job.pads.length; k++) {
      const p = job.pads[k], b = ringBox(p.ring);
      for (const l of p.layers) for (let ix = Math.floor(b[0] / PH); ix <= Math.floor(b[2] / PH); ix++) for (let iy = Math.floor(b[1] / PH); iy <= Math.floor(b[3] / PH); iy++) {
        const key = ix * 65537 + iy, m = padHash[l];
        let a = m.get(key); if (!a) m.set(key, a = []); a.push(k);
      }
    }
    const padAt = (l, x, y) => {
      const a = padHash[l].get(Math.floor(x / PH) * 65537 + Math.floor(y / PH));
      if (a) for (const k of a) if (inside(x, y, job.pads[k].ring)) return k;
      return -1;
    };
    const points = new Map();
    // Node for a point on layer l: a copper cell, else the pad under it, else a point node.
    function attach(l, x, y) {
      const g = grids[l];
      if (g) {
        const ix = Math.floor((x - g.x0) / h), iy = Math.floor((y - g.y0) / h);
        if (ix >= 0 && iy >= 0 && ix < g.nx && iy < g.ny) {
          const c = iy * g.nx + ix;
          if (g.cov[c] >= ATTACH) { pinned[l][c] = 1; return g.vbase + Math.round((y - g.y0) / h) * g.vx + Math.round((x - g.x0) / h); }
        }
      }
      const k = padAt(l, x, y);
      if (k >= 0 && lumpNode[k][l] >= 0) return lumpNode[k][l];
      const key = l + ":" + Math.round(x * 1e4) + ":" + Math.round(y * 1e4);
      let id = points.get(key);
      if (id == null) points.set(key, id = make());
      return id;
    }
    // ---- 4. narrow tracks: exact 1D elements
    // Key points where a track may join another: vertices of narrow tracks and pad centres.
    const KH = 1, keyHash = L.map(() => new Map());
    const addKey = (l, x, y) => { const key = Math.floor(x / KH) * 65537 + Math.floor(y / KH), m = keyHash[l]; let a = m.get(key); if (!a) m.set(key, a = []); a.push(x, y); };
    for (const k of chainsIn) { const t = job.tracks[k]; for (let i = 0; i < t.pts.length; i += 2) addKey(t.layer, t.pts[i], t.pts[i + 1]); }
    for (const p of job.pads) for (const l of p.layers) if (!grids[l]) addKey(l, p.x, p.y);
    const CA = I32(64), CB = I32(64), CT = I32(64), CG = F64(64), CX = F64(256);   // chain pieces: nodes, track, conductance, geometry
    for (const k of chainsIn) {
      const t = job.tracks[k], l = t.layer, g = grids[l], w = t.w, gk = w * L[l].t / rho;
      if (!(w > 0)) continue;
      for (let i = 2; i < t.pts.length; i += 2) {
        const ax = t.pts[i - 2], ay = t.pts[i - 1], bx = t.pts[i], by = t.pts[i + 1], dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
        if (!(len > 1e-9)) continue;
        // Split parameters: junction key points (snapped onto them), pad edges and grid steps.
        const cut = [[0, ax, ay], [1, bx, by]];
        const r = w / 2 + 1e-6;
        for (let ix = Math.floor((Math.min(ax, bx) - r) / KH); ix <= Math.floor((Math.max(ax, bx) + r) / KH); ix++) for (let iy = Math.floor((Math.min(ay, by) - r) / KH); iy <= Math.floor((Math.max(ay, by) + r) / KH); iy++) {
          const a = keyHash[l].get(ix * 65537 + iy);
          if (a) for (let q = 0; q < a.length; q += 2) {
            const px = a[q], py = a[q + 1], u = ((px - ax) * dx + (py - ay) * dy) / (len * len);
            if (u <= 1e-9 || u >= 1 - 1e-9) continue;
            if (Math.hypot(ax + u * dx - px, ay + u * dy - py) <= r) cut.push([u, px, py]);
          }
        }
        const b0 = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
        const seen = new Set();
        for (let ix = Math.floor(b0[0] / PH); ix <= Math.floor(b0[2] / PH); ix++) for (let iy = Math.floor(b0[1] / PH); iy <= Math.floor(b0[3] / PH); iy++) {
          const a = padHash[l].get(ix * 65537 + iy);
          if (a) for (const pk of a) {
            if (seen.has(pk)) continue;
            seen.add(pk);
            const ring = job.pads[pk].ring, m = ring.length >> 1;
            for (let e = 0; e < m; e++) {
              const f = e + 1 === m ? 0 : e + 1, ex = ring[2 * f] - ring[2 * e], ey = ring[2 * f + 1] - ring[2 * e + 1], den = dx * ey - dy * ex;
              if (Math.abs(den) < 1e-15) continue;
              const wx = ring[2 * e] - ax, wy = ring[2 * e + 1] - ay, u = (wx * ey - wy * ex) / den, v = (wx * dy - wy * dx) / den;
              if (u > 1e-9 && u < 1 - 1e-9 && v >= 0 && v <= 1) cut.push([u, ax + u * dx, ay + u * dy, pk]);
            }
          }
        }
        if (g) { const step = 2 * h, n = Math.floor(len / step); for (let q = 1; q <= n; q++) { const u = q * step / len; if (u < 1 - 1e-9) cut.push([u, ax + u * dx, ay + u * dy]); } }
        cut.sort((p, q) => p[0] - q[0]);
        let prev = attach(l, ax, ay), px = ax, py = ay, pu = 0;
        for (let q = 1; q < cut.length; q++) {
          const [u, x, y, onPad] = cut[q];
          if (u - pu < 1e-9 && q < cut.length - 1) continue;
          const node = onPad != null && lumpNode[onPad][l] >= 0 ? lumpNode[onPad][l] : attach(l, x, y), d = Math.hypot(x - px, y - py);
          // A piece over copper of the net (both ends on cells and its middle too) is already in the sheet.
          let over = false;
          if (g && prev < verts && node < verts) { const mx = Math.floor(((px + x) / 2 - g.x0) / h), my = Math.floor(((py + y) / 2 - g.y0) / h); over = mx >= 0 && my >= 0 && mx < g.nx && my < g.ny && g.cov[my * g.nx + mx] >= ATTACH; }
          if (d > 1e-9 && !over) { push(CA, prev); push(CB, node); push(CT, k); push(CG, gk / d); push(CX, px); push(CX, py); push(CX, x); push(CX, y); push(CX, l); }
          prev = node; px = x; py = y; pu = u;
        }
      }
    }
    // ---- 5. quadtree coarsening of solid interiors
    progress({phase: "mesh"});
    const rep = [], blk = [];
    (() => { for (const g of grids) {
      if (!g) { rep.push(null); blk.push(null); continue; }
      const {nx, ny, n, cov} = g, D = new Uint16Array(n), P = pinned[g.l];
      for (let c = 0; c < n; c++) D[c] = cov[c] >= .999 && !P[c] ? 65535 : 0;
      // Chessboard distance to the nearest cell that is not solid copper (or is pinned).
      for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        const c = y * nx + x; if (!D[c]) continue;
        let v = D[c];
        if (x === 0 || y === 0 || x === nx - 1 || y === ny - 1) v = 0;
        else { const a = D[c - 1] + 1, b = D[c - nx] + 1, d1 = D[c - nx - 1] + 1, d2 = D[c - nx + 1] + 1; v = Math.min(v, a, b, d1, d2); }
        D[c] = v;
      }
      for (let y = ny - 1; y >= 0; y--) for (let x = nx - 1; x >= 0; x--) {
        const c = y * nx + x; if (!D[c]) continue;
        const a = D[c + 1] + 1, b = D[c + nx] + 1, d1 = D[c + nx + 1] + 1, d2 = D[c + nx - 1] + 1;
        D[c] = Math.min(D[c], a, b, d1, d2);
      }
      const R = new Int32Array(n), B = new Uint8Array(n);
      for (let c = 0; c < n; c++) R[c] = c;
      // Min pyramid: level k holds the minimum of D over aligned 2^k blocks.
      const lv = [{w: nx, h: ny, m: D}];
      for (let size = 2; size <= MAXB; size *= 2) {
        const p = lv[lv.length - 1], w = Math.ceil(p.w / 2), hh = Math.ceil(p.h / 2), m = new Uint16Array(w * hh);
        for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
          const x2 = 2 * x, y2 = 2 * y;
          let v = p.m[y2 * p.w + x2];
          v = x2 + 1 < p.w ? Math.min(v, p.m[y2 * p.w + x2 + 1]) : 0;
          v = y2 + 1 < p.h ? Math.min(v, p.m[(y2 + 1) * p.w + x2], x2 + 1 < p.w ? p.m[(y2 + 1) * p.w + x2 + 1] : 0) : 0;
          m[y * w + x] = v;
        }
        lv.push({w, h: hh, m});
      }
      for (let k = job.noBlocks ? 0 : lv.length - 1; k >= 1; k--) {
        const size = 1 << k, q = lv[k];
        for (let by = 0; by < q.h; by++) for (let bx = 0; bx < q.w; bx++) {
          if (q.m[by * q.w + bx] < size) continue;
          const x0 = bx * size, y0 = by * size;
          if (x0 + size > nx || y0 + size > ny) continue;
          const c0 = y0 * nx + x0;
          if (R[c0] !== c0 || B[c0]) continue;               // inside a larger block already
          let k2 = 0; for (let s = size; s > 1; s >>= 1) k2++;
          B[c0] = k2;
          for (let y = y0; y < y0 + size; y++) for (let x = x0; x < x0 + size; x++) R[y * nx + x] = c0;
        }
      }
      rep.push(R); blk.push(B);
    } })();
    // ---- 6. edges: bilinear (Q1) elements on the quadtree, hanging vertices constrained
    // A square Q1 element of sheet conductance G·f is exactly four side conductances G·f/6
    // and two diagonal ones G·f/3, whatever its size. A vertex inside a block's side that a
    // smaller element uses is "hanging": its potential is the linear interpolation of the
    // side's end vertices, substituted into the element (the Galerkin constraint).
    progress({phase: "assemble"});
    const EA = I32(cells), EB = I32(cells), EG = F64(cells), hang = new Map();
    (() => { for (const g of grids) {
      if (!g) continue;
      const B = blk[g.l], R = rep[g.l], vx = g.vx;
      for (let c = 0; c < g.n; c++) {
        const k = B[c];
        if (!k || R[c] !== c) continue;
        const size = 1 << k, x0 = c % g.nx, y0 = Math.floor(c / g.nx), v = (x, y) => g.vbase + y * vx + x;
        const sides = [[x0, y0, 1, 0], [x0, y0 + size, 1, 0], [x0, y0, 0, 1], [x0 + size, y0, 0, 1]];
        for (const [sx, sy, dx, dy] of sides) {
          const a = v(sx, sy), e = v(sx + dx * size, sy + dy * size);
          for (let t = 1; t < size; t++) hang.set(v(sx + dx * t, sy + dy * t), [a, e, t / size]);
        }
      }
    } })();
    const expand = (v, w, out) => { const hg = hang.get(v); if (hg) { expand(hg[0], w * (1 - hg[2]), out); expand(hg[1], w * hg[2], out); } else out.push(find(v), w); };
    const ex1 = [], ex2 = [];
    function link(p, q, gk) {
      if (!hang.has(p) && !hang.has(q)) { const a = find(p), b = find(q); if (a !== b) { push(EA, a); push(EB, b); push(EG, gk); } return; }
      ex1.length = 0; ex2.length = 0; expand(p, 1, ex1); expand(q, -1, ex2);
      const c = ex1.concat(ex2);
      for (let i = 0; i < c.length; i += 2) for (let j = i + 2; j < c.length; j += 2) {
        if (c[i] === c[j]) continue;
        const w = -gk * c[i + 1] * c[j + 1];
        if (w !== 0) { push(EA, c[i]); push(EB, c[j]); push(EG, w); }
      }
    }
    (() => { for (const g of grids) {
      if (!g) continue;
      const {nx, cov} = g, G = gs[g.l], B = blk[g.l], R = rep[g.l], vx = g.vx;
      for (let c = 0; c < g.n; c++) {
        const f = cov[c];
        if (f < COPPER) continue;
        let v00, v10, v01, v11, gk;
        if (B[R[c]]) {
          if (R[c] !== c) continue;
          const size = 1 << B[c], x0 = c % nx, y0 = Math.floor(c / nx);
          v00 = g.vbase + y0 * vx + x0; v10 = v00 + size; v01 = v00 + size * vx; v11 = v01 + size; gk = G;
        } else { v00 = corner(g, c, 0); v10 = v00 + 1; v01 = v00 + vx; v11 = v01 + 1; gk = G * f; }
        link(v00, v10, gk / 6); link(v10, v11, gk / 6); link(v11, v01, gk / 6); link(v01, v00, gk / 6);
        link(v00, v11, gk / 3); link(v10, v01, gk / 3);
      }
    } })();
    const gridEdges = EA.n;
    for (let i = 0; i < CA.n; i++) { push(EA, find(CA.a[i])); push(EB, find(CB.a[i])); push(EG, CG.a[i]); }
    // Barrels: vias and free plated pads, between consecutive layers of their span.
    const tp = job.plating > 0 ? job.plating : .025, barrels = [];
    for (let k = 0; k < job.pads.length; k++) {
      const p = job.pads[k];
      if (!p.barrel || p.lead || p.layers.length < 2) continue;
      const area = platedBarrelArea(p.drill, tp);
      for (let i = 1; i < p.layers.length; i++) {
        const la = p.layers[i - 1], lb = p.layers[i], dz = Math.max(1e-3, Math.abs(L[lb].zMid - L[la].zMid));
        barrels.push({pad: k, a: lumpNode[k][la], b: lumpNode[k][lb], la, lb, g: area / (rho * dz)});
        push(EA, find(lumpNode[k][la])); push(EB, find(lumpNode[k][lb])); push(EG, area / (rho * dz));
      }
    }
    // ---- 7. compact numbering, terminals, reachability
    const total = nodes, cid = new Int32Array(total).fill(-1);
    let N = 0;
    const used = new Uint8Array(total);
    (() => { for (let i = 0; i < EA.n; i++) { used[find(EA.a[i])] = 1; used[find(EB.a[i])] = 1; } })();
    for (const row of lumpNode) for (const v of row) if (v >= 0) used[find(v)] = 1;
    for (let i = verts; i < total; i++) used[find(i)] = 1;
    (() => { for (let i = 0; i < total; i++) if (used[i] && parent[i] === i) cid[i] = N++; })();
    const ne = EA.n, ea = new Int32Array(ne), eb = new Int32Array(ne), eg = EG.a.subarray(0, ne);
    (() => { for (let i = 0; i < ne; i++) { ea[i] = cid[find(EA.a[i])]; eb[i] = cid[find(EB.a[i])]; } })();
    const fixed = new Uint8Array(N), sink = new Float64Array(N), termNode = new Int32Array(job.terms.length).fill(-1);
    for (let k = 0; k < job.pads.length; k++) {
      const p = job.pads[k];
      if (p.term == null || p.term < 0) continue;
      const nd = cid[find(lumpNode[k][p.layers[0]])];
      termNode[p.term] = nd;
      const t = job.terms[p.term];
      if (t.kind === "source") fixed[nd] = 1; else sink[nd] += t.i;
    }
    if (!fixed.some(v => v)) throw Error("No source pin carries copper of this net.");
    // Full adjacency (CSR, merged duplicates).
    const deg = new Int32Array(N + 1);
    (() => { for (let i = 0; i < ne; i++) if (ea[i] !== eb[i]) { deg[ea[i] + 1]++; deg[eb[i] + 1]++; } })();
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    const ac = new Int32Array(deg[N]), av = new Float64Array(deg[N]), fillp = deg.slice(0, N);
    (() => { for (let i = 0; i < ne; i++) { const a = ea[i], b = eb[i]; if (a === b) continue; ac[fillp[a]] = b; av[fillp[a]++] = eg[i]; ac[fillp[b]] = a; av[fillp[b]++] = eg[i]; } })();
    // Reachable from a source.
    const seen = new Uint8Array(N), queue = new Int32Array(N);
    let qh = 0, qt = 0;
    for (let i = 0; i < N; i++) if (fixed[i]) { seen[i] = 1; queue[qt++] = i; }
    while (qh < qt) { const i = queue[qh++]; for (let k = deg[i]; k < deg[i + 1]; k++) { const j = ac[k]; if (!seen[j]) { seen[j] = 1; queue[qt++] = j; } } }
    const unreached = [];
    job.terms.forEach((t, k) => { if (t.kind !== "source" && (termNode[k] < 0 || !seen[termNode[k]])) unreached.push(k); });
    let floating = 0;
    for (let i = 0; i < N; i++) if (!seen[i]) floating++;
    // Unknowns: reachable and not fixed.
    const uid = new Int32Array(N).fill(-1);
    let n = 0;
    for (let i = 0; i < N; i++) if (seen[i] && !fixed[i]) uid[i] = n++;
    const urow = new Int32Array(n + 1), mark = new Int32Array(n).fill(-1);
    let nnz = 0;
    (() => { for (let i = 0; i < N; i++) { const u = uid[i]; if (u < 0) continue; let c = 1; for (let k = deg[i]; k < deg[i + 1]; k++) { const v = uid[ac[k]]; if (v >= 0 && mark[v] !== u) { mark[v] = u; c++; } } urow[u + 1] = c; nnz += c; } })();
    for (let u = 0; u < n; u++) urow[u + 1] += urow[u];
    const col = new Int32Array(nnz), val = new Float64Array(nnz), dp = new Int32Array(n), b = new Float64Array(n), at = new Int32Array(n).fill(-1);
    (() => { for (let i = 0; i < N; i++) {
      const u = uid[i];
      if (u < 0) continue;
      let p = urow[u], diag = 0;
      const s = p; col[p] = u; val[p] = 0; at[u] = p; p++;
      for (let k = deg[i]; k < deg[i + 1]; k++) {
        const gk = av[k], v = uid[ac[k]];
        diag += gk;
        if (v < 0) continue;
        if (at[v] >= s && at[v] < p && col[at[v]] === v) val[at[v]] -= gk;
        else { col[p] = v; val[p] = -gk; at[v] = p; p++; }
      }
      val[s] = diag; b[u] = sink[i];
      // Sort the row by column (insertion sort; rows are short except big blocks).
      for (let q = s + 1; q < p; q++) { const cq = col[q], vq = val[q]; let r = q - 1; while (r >= s && col[r] > cq) { col[r + 1] = col[r]; val[r + 1] = val[r]; r--; } col[r + 1] = cq; val[r + 1] = vq; }
      for (let q = s; q < p; q++) if (col[q] === u) dp[u] = q;
    } })();
    T.assembled = now();
    // ---- 8. MIC(0) factorisation and PCG
    progress({phase: "factor", unknowns: n});
    const f = micFactor(n, urow, col, val, dp);
    T.factored = now();
    progress({phase: "solve", done: 0, unknowns: n});
    const tol = job.tol > 0 ? job.tol : 1e-10, maxIter = job.maxIter > 0 ? job.maxIter : 20000;
    const {x, it, res, bn} = pcg(n, urow, col, val, dp, f, b, tol, maxIter, progress);
    if (n && bn > 0 && !(res < Math.max(tol, 1e-6))) notes.push("The solver stopped at a relative residual of " + res.toExponential(1) + ".");
    T.solved = now();
    progress({phase: "post"});
    // ---- 9. results. u = V0 − V (a drop, ≥ 0 on a supply net with loads).
    const U = new Float64Array(N).fill(NaN);
    for (let i = 0; i < N; i++) if (fixed[i]) U[i] = 0; else if (uid[i] >= 0) U[i] = x[uid[i]];
    const power = (() => { let s = 0; for (let i = 0; i < ne; i++) { const a = ea[i], c = eb[i]; if (a !== c && U[a] === U[a] && U[c] === U[c]) s += eg[i] * (U[a] - U[c]) ** 2; } return s; })();
    // Vertex potentials (hanging vertices interpolated), then per cell: the bilinear field at
    // the cell centre and its gradient (J = |∇V|/ρ).
    const vU = v => { const hg = hang.get(v); if (hg) return vU(hg[0]) * (1 - hg[2]) + vU(hg[1]) * hg[2]; const id = cid[find(v)]; return id >= 0 ? U[id] : NaN; };
    const layersOut = [];
    let jMaxAll = 0;
    (() => { for (let l = 0; l < nl; l++) {
      const g = grids[l], out = {key: L[l].key, grid: null, jMax: 0, jMaxAt: null, uMin: Infinity, uMax: -Infinity};
      if (g) {
        const {nx, cov} = g, v = new Float32Array(g.n).fill(NaN), j = new Float32Array(g.n), cv = new Uint8Array(g.n), B = blk[l], R = rep[l], vx = g.vx;
        let bc = -1, b00 = 0, b10 = 0, b01 = 0, b11 = 0;
        for (let c = 0; c < g.n; c++) {
          if (cov[c] < COPPER) continue;
          cv[c] = Math.max(1, Math.round(cov[c] * 255));
          let s0, t0, size, q00, q10, q01, q11;
          const r = R[c], k = B[r];
          if (k) {
            size = 1 << k;
            if (r !== bc) { bc = r; const v00 = g.vbase + Math.floor(r / nx) * vx + r % nx; b00 = vU(v00); b10 = vU(v00 + size); b01 = vU(v00 + size * vx); b11 = vU(v00 + size * vx + size); }
            q00 = b00; q10 = b10; q01 = b01; q11 = b11;
            s0 = ((c % nx) - (r % nx) + .5) / size; t0 = (Math.floor(c / nx) - Math.floor(r / nx) + .5) / size;
          } else {
            size = 1; s0 = .5; t0 = .5;
            const v00 = corner(g, c, 0);
            q00 = vU(v00); q10 = vU(v00 + 1); q01 = vU(v00 + vx); q11 = vU(v00 + vx + 1);
          }
          if (!(q00 === q00 && q10 === q10 && q01 === q01 && q11 === q11)) continue;     // floating copper: shown, no value
          const u = q00 * (1 - s0) * (1 - t0) + q10 * s0 * (1 - t0) + q01 * (1 - s0) * t0 + q11 * s0 * t0;
          const gx = ((q10 - q00) * (1 - t0) + (q11 - q01) * t0) / (size * h), gy = ((q01 - q00) * (1 - s0) + (q11 - q10) * s0) / (size * h);
          const jj = Math.hypot(gx, gy) / rho;
          v[c] = u; j[c] = jj;
          if (u < out.uMin) out.uMin = u;
          if (u > out.uMax) out.uMax = u;
          if (jj > out.jMax) { out.jMax = jj; out.jMaxAt = [g.x0 + ((c % nx) + .5) * h, g.y0 + (Math.floor(c / nx) + .5) * h]; }
        }
        out.grid = {x0: g.x0, y0: g.y0, nx, ny: g.ny, h, cov: cv, u: v, j};
      }
      layersOut.push(out);
    } })();
    // Chains: current and density per piece.
    const nc = CA.n, chain = {n: nc, layer: new Uint8Array(nc), track: new Int32Array(nc), geo: new Float32Array(nc * 4), ua: new Float32Array(nc), ub: new Float32Array(nc), i: new Float32Array(nc), j: new Float32Array(nc)};
    for (let k = 0; k < nc; k++) {
      const a = cid[find(CA.a[k])], c = cid[find(CB.a[k])], l = CX.a[5 * k + 4], t = job.tracks[CT.a[k]];
      chain.layer[k] = l; chain.track[k] = CT.a[k];
      for (let q2 = 0; q2 < 4; q2++) chain.geo[4 * k + q2] = CX.a[5 * k + q2];
      chain.ua[k] = U[a]; chain.ub[k] = U[c];
      const cur = CG.a[k] * (U[a] - U[c]);
      chain.i[k] = cur === cur ? cur : NaN;
      chain.j[k] = cur === cur ? Math.abs(cur) / (t.w * L[l].t) : NaN;
      const out = layersOut[l];
      for (const u of [U[a], U[c]]) if (u === u) { if (u < out.uMin) out.uMin = u; if (u > out.uMax) out.uMax = u; }
      if (chain.j[k] > out.jMax) { out.jMax = chain.j[k]; out.jMaxAt = [(CX.a[5 * k] + CX.a[5 * k + 2]) / 2, (CX.a[5 * k + 1] + CX.a[5 * k + 3]) / 2]; }
    }
    for (const o of layersOut) if (o.jMax > jMaxAll) jMaxAll = o.jMax;
    // Pads and vias: potential per layer, barrel currents.
    const pads = job.pads.map((p, k) => ({u: p.layers.map(l => { const id = lumpNode[k][l] >= 0 ? cid[find(lumpNode[k][l])] : -1; return id >= 0 ? U[id] : NaN; }), i: 0, sections: []}));
    for (const br of barrels) {
      const a = cid[find(br.a)], c = cid[find(br.b)], cur = br.g * (U[a] - U[c]);
      const o = pads[br.pad];
      o.sections.push({from: br.la, to: br.lb, i: cur === cur ? cur : NaN});
      if (Math.abs(cur) > Math.abs(o.i)) o.i = cur;
    }
    // Terminals: potential and current (a source's current from its neighbours).
    const terms = job.terms.map((t, k) => {
      const nd = termNode[k];
      if (nd < 0) return {u: NaN, i: 0, reached: false};
      let cur = t.kind === "source" ? 0 : t.i;
      if (t.kind === "source") for (let e = deg[nd]; e < deg[nd + 1]; e++) { const u = U[ac[e]]; if (u === u) cur -= av[e] * (0 - u); }
      return {u: U[nd], i: cur, reached: !!seen[nd]};
    });
    // A source node shared by several source pins: split its current equally.
    const share = new Map();
    job.terms.forEach((t, k) => { if (t.kind === "source" && termNode[k] >= 0) share.set(termNode[k], (share.get(termNode[k]) || 0) + 1); });
    job.terms.forEach((t, k) => { if (t.kind === "source" && termNode[k] >= 0) terms[k].i = terms[k].i / share.get(termNode[k]); });
    let uMin = Infinity, uMax = -Infinity;
    for (const o of layersOut) { if (o.uMin < uMin) uMin = o.uMin; if (o.uMax > uMax) uMax = o.uMax; }
    for (const p of pads) for (const u of p.u) if (u === u) { if (u < uMin) uMin = u; if (u > uMax) uMax = u; }
    T.done = now();
    return {ok: true, pitch: h, layers: layersOut, chain, pads, terms, unreached, power, jMax: jMaxAll, uMin: uMin === Infinity ? 0 : uMin, uMax: uMax === -Infinity ? 0 : uMax, notes,
      stats: {cells, nodes: N, unknowns: n, nnz, edges: ne, gridEdges, chainPieces: nc, barrels: barrels.length, floating, iterations: it, residual: res,
        ms: {mesh: T.assembled - T.start, factor: T.factored - T.assembled, solve: T.solved - T.factored, post: T.done - T.solved, total: T.done - T.start}}};
  }
  function solve(job) { return compute(job); }
  // Plated barrel cross-section in mm²: π·(drill + plating)·plating. Thermal scales the same area to m².
  function platedBarrelArea(drill, plating) { return Math.PI * (drill + plating) * plating; }
  // Transferable buffers of a result (worker → page).
  function transfers(res) {
    const out = [];
    for (const l of res.layers || []) if (l.grid) out.push(l.grid.cov.buffer, l.grid.u.buffer, l.grid.j.buffer);
    if (res.chain) for (const k of ["layer", "track", "geo", "ua", "ub", "i", "j"]) out.push(res.chain[k].buffer);
    return out;
  }
  return {compute, solve, transfers, raster, capsuleRing, inside, micFactor, pcg, platedBarrelArea};   // thermal.js reuses the MIC(0)-PCG kernels and the barrel area
}

// Worker entry: answers {type:"solve", id, job} with progress and one result. It is serialised
// into a Blob together with AtriumPDNCore, so it must not close over anything.
function AtriumPDNServe(scope, core) {
  "use strict";
  scope.onmessage = event => {
    const msg = event.data || {};
    if (msg.type !== "solve") return;
    try {
      let last = 0;
      const value = core.compute(msg.job, v => { const t = Date.now(); if (t - last > 80) { last = t; scope.postMessage({type: "progress", id: msg.id, value: v}); } });
      scope.postMessage({type: "result", id: msg.id, value}, core.transfers(value));
    } catch (error) {
      scope.postMessage({type: "error", id: msg.id, message: String(error && error.message || error)});
    }
  };
  scope.postMessage({type: "ready"});
}

// One worker or one foreground solve, with a single terminal transition.
function AtriumSolverClient(job, {onProgress, foreground = false} = {}, adapt) {
  let cancel, timer, worker, settled = false;
  const meta = job.meta;
  const promise = new Promise((resolve, reject) => {
    function release() {
      clearTimeout(timer);
      const active = worker;
      worker = null;
      if (active) {
        active.onmessage = active.onerror = null;
        active.terminate();
      }
    }
    function finish(error, result) {
      if (settled) return;
      settled = true;
      try {
        release();
        if (error) reject(error);
        else resolve(Object.assign(result, {meta}));
      } catch (failure) { reject(error || failure); }
    }
    cancel = () => finish(Error("Cancelled."));
    const progress = value => { if (!settled) onProgress?.(value); };
    const fore = () => {
      timer = setTimeout(() => {
        if (settled) return;
        try { finish(null, adapt.compute(job, progress)); } catch (error) { finish(error); }
      }, 0);
    };
    const active = foreground ? null : adapt.makeWorker();
    if (!active) { fore(); return; }
    worker = active;
    let ready = false;
    function fallback() {
      if (worker !== active || ready) return;
      release();
      adapt.markBroken();
      fore();
    }
    timer = setTimeout(fallback, 4000);
    active.onmessage = ({data}) => {
      if (worker !== active) return;
      if (data.type === "ready" && !ready) {
        ready = true;
        clearTimeout(timer);
        const {meta: _meta, ...plain} = job, message = {type: "solve", id: 1, job: plain};
        try {
          const transfers = adapt.transfers?.(plain);
          if (transfers) active.postMessage(message, transfers); else active.postMessage(message);
        } catch (error) { finish(error); }
      } else if (data.type === "progress") progress(data.value);
      else if (data.type === "result") finish(null, data.value);
      else if (data.type === "error") finish(Error(data.message));
    };
    active.onerror = event => {
      event.preventDefault?.();
      if (worker !== active) return;
      if (ready) finish(Error(event.message || adapt.failed)); else fallback();
    };
  });
  return {promise, cancel};
}

globalThis.AtriumPDN = (() => {
  const VERSION = 1;
  const {RHO20, ALPHA, rhoAt} = globalThis.AtriumElectricalMaterial;
  const MIL = 0.0254;
  const COPPER = /^(Top|Bottom|Inner (?:[1-9]\d?|1[01]\d|12[0-6]))$/;
  // net-intent.js (isGround) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const GROUND_RE = /^(?:[ADPSC]?GND\w*|GND\w*|VSS\w*|0V|EARTH\w*|CHASSIS\w*)$/i;
  const GROUND = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isGround ? N.isGround(String(n ?? "")) : GROUND_RE.test(n); }};
  // net-intent.js (isRail) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const SUPPLY_RE = /^(?:VDD\w*|VCC\w*|VEE\w*|VBAT\w*|VBUS\w*|VIN\w*|VSYS|VREF\w*|AVDD\w*|DVDD\w*|PWR\w*|\+?\d+V\d*\w*|\d+V\d+|V\d+(?:V\d+)?|[+-]\d+(?:\.\d+)?V\w*|P\d+V\d*\w*)$/i;
  const SUPPLY = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isRail ? N.isRail(String(n ?? "")) : SUPPLY_RE.test(n); }};
  const SOURCE_REF = /^(?:J|P|CN|X|BT|PS|VR|REG|CON|U)\d/i;
  const DEFAULTS = Object.freeze({temperature: 25, plating: .025, minPitch: .05, maxCells: 4e6, pitch: null, viaRise: 10});
  const NET_DEFAULTS = Object.freeze({voltage: 3.3, maxDropPct: 5, maxDensity: 100, viaCurrent: null});
  const core = AtriumPDNCore();
  const fail = m => { throw Error(m); };
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const num = (v, lo, hi, d) => { const x = +v; return v !== null && v !== "" && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  const str = (v, max = 256) => typeof v === "string" ? v.slice(0, max) : "";
  const r4 = v => fin(v) ? Math.round(v * 1e4) / 1e4 + 0 : v;
  const r6 = v => fin(v) ? Math.round(v * 1e8) / 1e8 + 0 : v;
  const r2 = v => fin(v) ? Math.round(v * 100) / 100 + 0 : v;
  const natural = typeof Intl !== "undefined" ? new Intl.Collator("en", {numeric: true}).compare : (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const ipc2221K = internal => internal ? .024 : .048;
  const ipc2221Current = (areaMil2, rise, internal) => ipc2221K(internal) * Math.pow(rise, .44) * Math.pow(areaMil2, .725);
  // PDN passes mm²; the conductor kernel uses mil².
  const ipc2221 = (areaMM2, rise) => ipc2221Current(areaMM2 / (MIL * MIL), rise, false);

  // ---------------------------------------------------------------- setup (doc.pdn)
  function pinList(v) { return Array.isArray(v) ? [...new Set(v.filter(x => typeof x === "string" || typeof x === "number").map(x => String(x).slice(0, 32)))].slice(0, 512) : []; }
  function normalizeNet(raw, i = 0) {
    const o = raw && typeof raw === "object" ? raw : {};
    const src = o.source && typeof o.source === "object" ? o.source : {};
    return {id: str(o.id, 64) || "pdn" + (i + 1), net: str(o.net), voltage: num(o.voltage, -1000, 1000, NET_DEFAULTS.voltage), enabled: o.enabled !== false,
      source: {ref: str(src.ref, 64), pins: pinList(src.pins)},
      loads: (Array.isArray(o.loads) ? o.loads : []).slice(0, 256).map(l => ({ref: str(l?.ref, 64), pins: pinList(l?.pins), current: num(l?.current, 0, 1000, .1), mode: l?.mode === "per-pin" ? "per-pin" : "total"})),
      returnNet: str(o.returnNet), maxDropPct: num(o.maxDropPct, 0, 100, NET_DEFAULTS.maxDropPct), maxDensity: num(o.maxDensity, 0, 1e6, NET_DEFAULTS.maxDensity),
      viaCurrent: o.viaCurrent == null || o.viaCurrent === "" ? null : num(o.viaCurrent, 0, 1000, null)};
  }
  function normalize(raw) {
    const o = raw && typeof raw === "object" ? raw : {};
    return {version: VERSION, temperature: num(o.temperature, -55, 250, DEFAULTS.temperature), plating: num(o.plating, .001, .2, DEFAULTS.plating),
      minPitch: num(o.minPitch, .005, 5, DEFAULTS.minPitch), maxCells: Math.round(num(o.maxCells, 1e4, 2e7, DEFAULTS.maxCells)),
      pitch: o.pitch == null || o.pitch === "" ? null : num(o.pitch, .005, 10, null), viaRise: num(o.viaRise, 1, 100, DEFAULTS.viaRise),
      nets: (Array.isArray(o.nets) ? o.nets : []).slice(0, 64).map(normalizeNet)};
  }
  const read = doc => normalize(doc?.pdn);
  function write(doc, setup) { doc.pdn = normalize(setup); return doc.pdn; }

  // ---------------------------------------------------------------- board queries
  const world = (p, parent) => globalThis.Atrium?.world ? Atrium.world(p, parent) : [p[0] + parent.x, p[1] + parent.y];
  const padLayer = (parent, p) => p.layer || (p.kind === "via" || p.drill > 0 ? "Multi" : parent?.layer || "Top");
  function copperStack(doc, defs) {
    const St = globalThis.AtriumStackup;
    if (St?.get) {
      try {
        const out = St.layerDepths(St.get(doc, defs)).filter(({row}) => St.isCopper(row) && row.key)
          .map(({row,z}) => {
            const t = +row.thickness || .035;
            return {key:row.key, t, zMid:z + t / 2, type:row.type};
          });
        if (out.length) return out;
      } catch { /* fall back */ }
    }
    const keys = new Set(["Top", "Bottom"]);
    for (const i of doc.items || []) for (const k of [i.layer, i.fromLayer, i.toLayer]) if (COPPER.test(k || "")) keys.add(k);
    const idx = k => k === "Top" ? 0 : k === "Bottom" ? 999 : +k.slice(6);
    const list = [...keys].sort((a, b) => idx(a) - idx(b));
    return list.map((key, i) => ({key, t: .035, zMid: 1.6 * i / Math.max(1, list.length - 1), type: "Signal"}));
  }
  // Pad polygon in world coordinates (flat ring).
  function padRing(p,parent,layer){
    const L=AtriumResolvedLand,g=L.geometry(p,layer);
    if(!g||g.holeOnly)return new Float64Array();
    const {at,angle,mirror}=L.place(g,parent),frame={x:at[0],y:at[1],angle,mirror};
    return Float64Array.from(AtriumLandContours.outline(g).flatMap(q=>Atrium.world(q,frame)));
  }
  function pinNet(part, p) { return part.pinNets && Object.prototype.hasOwnProperty.call(part.pinNets, p.number) ? part.pinNets[p.number] : ""; }
  // Nets with copper or pads on the board, sorted: supplies first, then grounds, then the rest.
  function nets(doc, defs) {
    const s = new Set();
    for (const i of doc.items || []) {
      if (i.net) s.add(i.net);
      if (i.kind === "part" && i.pinNets) for (const n of Object.values(i.pinNets)) if (n) s.add(n);
    }
    for (const r of doc.pcbDrawing?.pours || []) if (r.net) s.add(r.net);
    const rank = n => SUPPLY.test(n) && !GROUND.test(n) ? 0 : GROUND.test(n) ? 1 : 2;
    return [...s].sort((a, b) => rank(a) - rank(b) || natural(a, b));
  }
  // Parts with pins on a net: [{ref, id, pins:[numbers], value}].
  function partsOn(doc, defs, net) {
    const out = [];
    for (const i of doc.items || []) {
      if (i.kind !== "part" || !i.pinNets) continue;
      const pins = Object.keys(i.pinNets).filter(k => i.pinNets[k] === net).sort(natural);
      if (pins.length) out.push({ref: i.ref || i.id, id: i.id, pins, value: i.value || ""});
    }
    return out.sort((a, b) => natural(a.ref, b.ref));
  }
  const isGround = n => GROUND.test(n || ""), isSupply = n => !!n && !isGround(n) && SUPPLY.test(n);
  // Voltage from a net name: 3V3 → 3.3, +5V → 5, 1V8 → 1.8, 12V → 12, VCC_3.3 → 3.3.
  function voltageOf(name) {
    const s = String(name || ""), N = globalThis.AtriumNetIntent;
    // net-intent.js reads the voltage (3V3, +5V, 1V8, 3,3V; a rail's nominal, VBUS → 5); the parse below is its fallback.
    if (N?.voltage) { const v = N.voltage(s) ?? N.read?.(s)?.nominal ?? null; if (v != null) return v; }
    let m = /(\d+)V(\d+)/i.exec(s);
    if (m) return +(m[1] + "." + m[2]);
    m = /(\d+(?:\.\d+)?)\s*V/i.exec(s) || /_(\d+(?:\.\d+)?)$/.exec(s);
    return m ? +m[1] : null;
  }
  // A starting setup for a net: the likeliest source (a connector or regulator), the other parts
  // as loads (the net's rule current, else 0.1 A each) and a ground net as the return.
  function guess(doc, defs, net, opts = {}) {
    const all = nets(doc, defs);
    net = net || all.find(isSupply) || all.find(n => !isGround(n)) || "";
    const parts = partsOn(doc, defs, net), ground = all.find(isGround) || "";
    const src = parts.find(p => /^(?:J|P|CN|X|BT|PS)\d/i.test(p.ref)) || parts.find(p => /^(?:VR|REG|U)\d/i.test(p.ref)) || parts[0];
    const loads = parts.filter(p => p !== src && /^(?:U|IC|Q|D|LED|M)\d/i.test(p.ref));
    const rules = globalThis.AtriumRules?.stored?.(doc, opts.project) ?? null, total = fin(rules?.netCurrents?.[net]) ? rules.netCurrents[net] : null;
    const each = total && loads.length ? total / loads.length : .1;
    return normalizeNet({id: "pdn-" + net.replace(/[^\w.+-]/g, "_"), net, voltage: voltageOf(net) ?? NET_DEFAULTS.voltage, source: {ref: src?.ref || "", pins: []},
      loads: loads.map(p => ({ref: p.ref, pins: [], current: r4(each), mode: "total"})), returnNet: ground});
  }

  // ---------------------------------------------------------------- job (board -> solver input)
  // which: "supply" solves netSetup.net; "return" solves netSetup.returnNet.
  function job(doc, defs, netSetup, setup = {}, which = "supply") {
    if (doc?.kind !== "pcb") fail("Choose a PCB layout for the PDN analysis.");
    const S = normalize(setup), N = normalizeNet(netSetup), notes = [];
    const net = which === "return" ? N.returnNet : N.net;
    if (!net) fail(which === "return" ? "No return net." : "Choose the power net.");
    const layers = copperStack(doc, defs), index = new Map(layers.map((l, i) => [l.key, i]));
    const span = (a, b) => { const i = index.get(a), j = index.get(b); if (i == null || j == null) return layers.map((_, k) => k); const lo = Math.min(i, j), hi = Math.max(i, j); return layers.map((_, k) => k).filter(k => k >= lo && k <= hi); };
    const flat = pts => { const a = new Float64Array(pts.length * 2); pts.forEach((p, i) => { a[2 * i] = +p[0]; a[2 * i + 1] = +p[1]; }); return a; };
    const shapes = [], tracks = [], pads = [], ids = {tracks: [], pads: []};
    const pours = (doc.pcbDrawing?.pours || []).filter(r => r.net === net && index.has(r.layer));
    const poured = new Set(pours.map(r => r.polygon).filter(v => v != null)), pourKey = new Set(pours.filter(r => r.polygon == null).map(r => r.layer));
    const P = globalThis.AtriumPCBPours;
    if (pours.length && !P?.contours) notes.push("Poured copper could not be read in this build; polygons are assumed solid.");
    for (const r of pours) { if (!P?.contours) break; try { const rings = P.contours(r).map(x => Float64Array.from(x)); if (rings.length) shapes.push({layer: index.get(r.layer), rings}); } catch { notes.push("A pour region on " + r.layer + " could not be read."); } }
    let assumed = 0, hatched = 0;
    for (const i of doc.items || []) {
      if (i.net !== net || !index.has(i.layer || "Top") && i.kind !== "via" && i.kind !== "pad") continue;
      const l = index.get(i.layer || "Top");
      if (i.kind === "polygon") {
        if (i.cutout || i.shelved || i.keepout || poured.has(i.id) || pourKey.has(i.layer) || !Array.isArray(i.points) || i.points.length < 3) continue;
        if (i.fillMode === "hatched" || i.fillMode === "none") hatched++;
        shapes.push({layer: l, rings: [flat(i.points)]}); assumed++;
      } else if ((i.kind === "track" || i.kind === "graphic") && Array.isArray(i.points) && !i.keepout) {
        if (i.fill && i.closed !== false && i.points.length >= 3) shapes.push({layer: l, rings: [flat(i.points)]});
        else if (i.kind === "track" && i.points.length >= 2 && +i.width > 0) { tracks.push({layer: l, pts: flat(i.points), w: +i.width}); ids.tracks.push(i.id); }
      }
    }
    if (assumed) notes.push(assumed + " unpoured polygon" + (assumed === 1 ? " is" : "s are") + " assumed solid; repour for exact voids and reliefs.");
    if (hatched) notes.push("Hatched polygons are treated as solid copper.");
    const terms = [], termOf = new Map();   // "ref\u0001pin" -> [pad indices]
    const addPad = (p, parent, ref, pin, id) => {
      const L0 = padLayer(parent, p), plated = p.drill > 0 && p.plated !== false && !(p.drill >= Math.min(+(p.w ?? p.diameter) || 0, +(p.h ?? p.diameter) || 0) - 1e-9);
      let ls;
      if (L0 === "Multi") ls = p.kind === "via" ? span(p.fromLayer, p.toLayer) : layers.map((_, k) => k);
      else if (index.has(L0)) ls = [index.get(L0)];
      else return;
      const ring = padRing(p, parent), c = parent ? world([+p.x || 0, +p.y || 0], parent) : [+p.x || 0, +p.y || 0];
      const k = pads.length;
      pads.push({layers: ls, ring, x: c[0], y: c[1], lead: !!parent && ls.length > 1, barrel: plated && ls.length > 1 && !parent, drill: +p.drill || 0, term: -1, via: p.kind === "via"});
      ids.pads.push({id, ref: ref || null, pin: pin ?? null, via: p.kind === "via", at: c});
      if (ref != null) { const key = ref + "\u0001" + pin; if (!termOf.has(key)) termOf.set(key, []); termOf.get(key).push(k); }
    };
    for (const i of doc.items || []) {
      if (i.kind === "via" && i.net === net && Number.isFinite(i.x)) addPad({kind: "via", x: i.x, y: i.y, diameter: +i.diameter || .6, drill: +i.drill || .3, shape: "round", fromLayer: i.fromLayer, toLayer: i.toLayer}, null, null, null, i.id);
      else if (i.kind === "pad" && i.net === net) addPad(i, null, null, null, i.id);
      else if (i.kind === "part") {
        const fp = defs?.get?.(i.def)?.footprint;
        for (const p of fp?.pads || []) if (pinNet(i, p) === net && (+(p.w ?? p.diameter) > 0)) addPad(p, i, i.ref || i.id, String(p.number), i.id);
      }
    }
    // Terminals.
    const pinsOf = (ref, list, n2) => {
      const part = (doc.items || []).find(i => i.kind === "part" && (i.ref || i.id) === ref);
      if (!part) return {error: "No component " + ref + " on the board."};
      const on = Object.keys(part.pinNets || {}).filter(k => part.pinNets[k] === n2);
      const want = list.length ? list.filter(p => on.includes(p)) : on;
      return {pins: want, missing: list.filter(p => !on.includes(p))};
    };
    const src = N.source;
    if (!src.ref) fail("Choose the source component for " + N.net + ".");
    const srcNet = which === "return" ? N.returnNet : N.net;
    const sp = pinsOf(src.ref, which === "return" ? [] : src.pins, srcNet);
    if (sp.error) fail(sp.error);
    if (!sp.pins.length) fail(src.ref + " has no pin on " + srcNet + ".");
    if (sp.missing?.length) notes.push(src.ref + " pins " + sp.missing.join(", ") + " are not on " + srcNet + ".");
    for (const pin of sp.pins) {
      const list = termOf.get(src.ref + "\u0001" + pin) || [];
      for (const k of list) { pads[k].term = terms.length; terms.push({kind: "source", ref: src.ref, pin, load: -1}); }
    }
    N.loads.forEach((ld, li) => {
      const lp = pinsOf(ld.ref, which === "return" ? [] : ld.pins, srcNet);
      if (lp.error) { notes.push(lp.error); return; }
      if (!lp.pins.length) { notes.push(ld.ref + " has no pin on " + srcNet + "."); return; }
      const supplyPins = which === "return" ? pinsOf(ld.ref, ld.pins, N.net).pins || [] : lp.pins;
      const totalI = ld.mode === "per-pin" ? ld.current * Math.max(1, supplyPins.length) : ld.current;
      const padsFor = lp.pins.map(pin => termOf.get(ld.ref + "\u0001" + pin) || []).filter(a => a.length);
      const per = totalI / Math.max(1, padsFor.reduce((s, a) => s + a.length, 0));
      for (let q = 0; q < lp.pins.length; q++) for (const k of termOf.get(ld.ref + "\u0001" + lp.pins[q]) || []) {
        pads[k].term = terms.length;
        // A supply load draws its current out of the copper; the return net receives it.
        terms.push({kind: "sink", i: which === "return" ? -per : per, ref: ld.ref, pin: lp.pins[q], load: li});
      }
    });
    return {rho: rhoAt(S.temperature), plating: S.plating, maxCells: S.maxCells, minPitch: S.minPitch, pitch: S.pitch, tol: 1e-10, maxIter: 20000,
      layers, shapes, tracks, pads, terms, meta: {net, which, ids, notes, voltage: which === "return" ? 0 : N.voltage, trackWidths: tracks.map(t => t.w)}};
  }
  const solve = j => core.solve(j);

  // ---------------------------------------------------------------- worker
  let scriptURL = null;
  try { scriptURL = globalThis.document?.currentScript?.src || null; } catch { scriptURL = null; }
  let workerBroken = false;
  function makeWorker() {
    if (workerBroken || typeof Worker !== "function") return null;
    try {
      if (typeof Blob === "function" && typeof URL?.createObjectURL === "function") {
        const src = '"use strict";\n' + AtriumPDNCore.toString() + "\n" + AtriumPDNServe.toString() + "\nAtriumPDNServe(self, AtriumPDNCore());\n";
        const worker = AtriumWorkerPool.blobWorker(src);
        if (worker) return worker;
      }
    } catch { /* blob workers may be blocked */ }
    try { if (scriptURL) return new Worker(new URL("../workers/pdn-worker.js", scriptURL).href); } catch { /* fall back */ }
    return null;
  }
  // Solves a job off the UI thread: {promise, cancel}. Without workers the generator is
  // time-sliced on the UI thread.
  function run(j, options) {
    return AtriumSolverClient(j, options, {
      compute: (job, onProgress) => core.compute(job, onProgress),
      makeWorker, markBroken() { workerBroken = true; },
      failed: "The PDN worker failed."});
  }

  // ---------------------------------------------------------------- report
  // supply and ret are solver results (ret may be null). Voltages are absolute.
  function report(doc, netSetup, setup, supply, ret, opts = {}) {
    const N = normalizeNet(netSetup), S = normalize(setup), V0 = N.voltage;
    const notes = [...(supply.meta?.notes || []), ...(ret?.meta?.notes || []), ...(supply.notes || []), ...(ret?.notes || [])];
    const sj = supply.meta || {}, rj = ret?.meta || {};
    const loads = N.loads.map((ld, li) => {
      const st = (sj.terms || []).map((t, k) => ({t, r: supply.terms[k]})).filter(x => x.t.load === li);
      const rt = ret ? (rj.terms || []).map((t, k) => ({t, r: ret.terms[k]})).filter(x => x.t.load === li) : [];
      const vS = st.filter(x => x.r.reached).map(x => V0 - x.r.u), vR = rt.filter(x => x.r.reached).map(x => -x.r.u);
      const vMin = vS.length ? Math.min(...vS) : null, gnd = vR.length ? Math.max(...vR) : null;
      const eff = vMin == null ? null : vMin - (gnd ?? 0), drop = eff == null ? null : V0 - eff;
      const pct = drop == null || !V0 ? null : Math.abs(drop / V0) * 100;
      const unreached = st.some(x => !x.r.reached), retOpen = !!ret && rt.some(x => !x.r.reached);
      const current = st.reduce((s, x) => s + x.t.i, 0);
      const worst = st.filter(x => x.r.reached).sort((a, b) => b.r.u - a.r.u)[0];
      return {ref: ld.ref, pins: st.map(x => x.t.pin), current: r6(current), supply: r6(vMin), ret: r6(gnd), voltage: r6(eff), drop: r6(drop), dropPct: r4(pct),
        worstPin: worst?.t.pin ?? null, at: null,
        status: unreached || retOpen || !st.length ? "fail" : pct != null && pct > N.maxDropPct ? "fail" : "ok", unreached, retOpen};
    });
    for (const ld of loads) {
      const k = (sj.terms || []).findIndex(t => t.ref === ld.ref && t.pin === ld.worstPin && t.kind === "sink");
      const pk = k < 0 ? -1 : (supply.meta?.padOfTerm || [])[k];
      ld.at = pk >= 0 ? sj.ids.pads[pk]?.at || null : null;
    }
    const layerRows = (res, which) => res ? res.layers.map(l => ({net: which === "supply" ? N.net : N.returnNet, layer: l.key, jMax: r2(l.jMax), at: l.jMaxAt ? [r4(l.jMaxAt[0]), r4(l.jMaxAt[1])] : null,
      status: l.jMax > N.maxDensity && N.maxDensity > 0 ? "fail" : "ok"})).filter(r => r.jMax > 0) : [];
    const density = [...layerRows(supply, "supply"), ...layerRows(ret, "return")];
    const viaRows = (res, which) => {
      if (!res) return [];
      const m = res.meta || {}, out = [], tp = S.plating;
      res.pads.forEach((p, k) => {
        const id = m.ids?.pads?.[k];
        if (!id?.via || !p.sections.length) return;
        const drill = m.padDrill?.[k] ?? .3, limit = N.viaCurrent != null ? N.viaCurrent : ipc2221(core.platedBarrelArea(drill, tp), S.viaRise);
        out.push({net: which === "supply" ? N.net : N.returnNet, id: id.id, at: [r4(id.at[0]), r4(id.at[1])], current: r4(Math.abs(p.i)), limit: r4(limit), status: Math.abs(p.i) > limit ? "fail" : "ok"});
      });
      return out;
    };
    const vias = [...viaRows(supply, "supply"), ...viaRows(ret, "return")].sort((a, b) => b.current - a.current);
    const current = loads.reduce((s, l) => s + (l.current || 0), 0);
    const out = {net: N.net, returnNet: ret ? N.returnNet : null, voltage: V0, current: r6(current), loads, density, vias,
      power: {supply: r6(supply.power), ret: ret ? r6(ret.power) : null}, pitch: r4(supply.pitch),
      limits: {maxDropPct: N.maxDropPct, maxDensity: N.maxDensity, viaCurrent: N.viaCurrent, viaRule: N.viaCurrent == null ? "IPC-2221 external, " + S.viaRise + " °C rise" : "fixed"},
      stats: {supply: supply.stats, ret: ret?.stats || null}, notes: [...new Set(notes)]};
    out.violations = violations(out, N);
    return out;
  }
  function violations(rep, N) {
    const out = [];
    for (const l of rep.loads) {
      if (l.unreached) out.push({kind: "pdn-open", severity: "Error", net: rep.net, ref: l.ref, at: l.at, title: "PDN " + rep.net + ": " + l.ref + " not connected", detail: l.ref + " has a pin the source's copper does not reach."});
      else if (l.retOpen) out.push({kind: "pdn-open", severity: "Error", net: rep.returnNet, ref: l.ref, at: l.at, title: "PDN " + rep.returnNet + ": " + l.ref + " return not connected", detail: l.ref + " has a " + rep.returnNet + " pin the source's return copper does not reach."});
      else if (l.status === "fail") out.push({kind: "pdn-drop", severity: "Error", net: rep.net, ref: l.ref, at: l.at, title: "PDN " + rep.net + ": drop at " + l.ref,
        detail: l.ref + " sees " + l.voltage + " V, a drop of " + r2(l.drop * 1000) + " mV (" + l.dropPct + " %) against " + N.maxDropPct + " %"});
    }
    for (const d of rep.density) if (d.status === "fail") out.push({kind: "pdn-density", severity: "Warning", net: d.net, ref: null, at: d.at, title: "PDN " + d.net + ": current density on " + d.layer,
      detail: d.jMax + " A/mm² on " + d.layer + " exceeds " + N.maxDensity + " A/mm²"});
    for (const v of rep.vias) if (v.status === "fail") out.push({kind: "pdn-via", severity: "Warning", net: v.net, id: v.id, at: v.at, title: "PDN " + v.net + ": via current",
      detail: "Via carries " + v.current + " A; its limit is " + v.limit + " A (" + rep.limits.viaRule + ")"});
    return out;
  }
  // Index helpers the report needs: the pad behind each terminal, the drill per pad.
  function decorate(j) {
    const m = j.meta;
    m.terms = j.terms;
    m.padOfTerm = new Int32Array(j.terms.length).fill(-1);
    j.pads.forEach((p, k) => { if (p.term >= 0) m.padOfTerm[p.term] = k; });
    m.padDrill = j.pads.map(p => p.drill);
    return j;
  }
  // Both solves, synchronously (headless, tests).
  function analyze(doc, defs, netSetup, setup = {}) {
    const N = normalizeNet(netSetup), sj = decorate(job(doc, defs, N, setup, "supply")), supply = Object.assign(core.solve(sj), {meta: sj.meta});
    let ret = null;
    if (N.returnNet) {
      try { const rj = decorate(job(doc, defs, N, setup, "return")); ret = Object.assign(core.solve(rj), {meta: rj.meta}); }
      catch (e) { supply.meta.notes.push("Return net " + N.returnNet + " not analysed: " + e.message); }
    }
    return {supply, ret, report: report(doc, N, setup, supply, ret)};
  }

  // ---------------------------------------------------------------- MCP pdn_analyze
  function headless(a, host) {
    const p = host.project(), doc = host.board(p, a.document_id), defs = host.defsOf(p);
    const saved = read(doc), setup = normalize({...saved, ...(a.temperature != null ? {temperature: a.temperature} : {}), ...(a.plating_um != null ? {plating: a.plating_um / 1000} : {}),
      ...(a.pitch != null ? {pitch: a.pitch} : {}), ...(a.max_cells != null ? {maxCells: a.max_cells} : {})});
    let list = setup.nets.filter(n => n.enabled);
    if (Array.isArray(a.setups) && a.setups.length) list = a.setups.map((s, i) => normalizeNet({...s, returnNet: s.return_net ?? s.returnNet, maxDropPct: s.max_drop_pct ?? s.maxDropPct,
      maxDensity: s.max_density ?? s.maxDensity, viaCurrent: s.via_current ?? s.viaCurrent}, i));
    if (a.net) { list = list.filter(n => n.net === a.net); if (!list.length) list = [guess(doc, defs, a.net, {project: p})]; }
    if (!list.length) fail("No PDN setup is saved with this board. Pass net (a starting setup is guessed) or setups.");
    const out = [];
    for (const n of list.slice(0, 8)) {
      try {
        const r = analyze(doc, defs, n, setup).report;
        out.push({net: r.net, return_net: r.returnNet, voltage: r.voltage, current: r.current, pitch_mm: r.pitch, limits: r.limits,
          loads: r.loads.map(l => ({ref: l.ref, pins: l.pins, current: l.current, supply_v: l.supply, return_v: l.ret, voltage: l.voltage, drop_v: l.drop, drop_pct: l.dropPct, status: l.status})),
          max_density: r.density, vias: r.vias.slice(0, a.max_vias ?? 20), via_count: r.vias.length, vias_over_limit: r.vias.filter(v => v.status === "fail").length,
          power_w: r.power, violations: r.violations, notes: r.notes,
          stats: {supply: summaryStats(r.stats.supply), ret: r.stats.ret ? summaryStats(r.stats.ret) : null}, setup: n});
      } catch (e) { out.push({net: n.net, error: e.message, setup: n}); }
    }
    return {document_id: doc.id, units: {length: "mm", voltage: "V", current: "A", density: "A/mm²", power: "W"},
      model: "DC 2D sheet model: R□ = ρ(T)/t per copper layer, adaptive quadtree grid, exact 1D tracks, via barrels ρ·Δz/(π(d+t)t), MIC(0)-preconditioned CG. Uniform current through the thickness; no self-heating.",
      temperature: setup.temperature, plating_mm: setup.plating, saved_setups: saved.nets.length, results: out};
  }
  const summaryStats = s => s && ({cells: s.cells, nodes: s.nodes, unknowns: s.unknowns, iterations: s.iterations, residual: s.residual, ms: r2(s.ms.total)});

  // ---------------------------------------------------------------- colour ramp (viridis-like)
  // Perceptually ordered, colour-blind safe (blue-violet to yellow, monotonic lightness).
  // paletteRamp is the one stop interpolation and legend. Thermal binds its own tables to it.
  function paletteRamp(stops) {
    const ramp = t => {
      t = !(t > 0) ? 0 : t >= 1 ? 1 : t;
      const x = t * (stops.length - 1), i = Math.min(stops.length - 2, Math.floor(x)), f = x - i, a = stops[i], b = stops[i + 1];
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
    };
    const rgb = t => { const c = ramp(t); return "rgb(" + Math.round(c[0]) + "," + Math.round(c[1]) + "," + Math.round(c[2]) + ")"; };
    const gradient = (dir = "to right") => "linear-gradient(" + dir + "," + stops.map((c, i) => "rgb(" + c.join(",") + ") " + Math.round(i / (stops.length - 1) * 100) + "%").join(",") + ")";
    return {ramp, rgb, gradient};
  }
  const RAMP = [[68, 1, 84], [72, 36, 117], [65, 68, 135], [53, 95, 141], [42, 120, 142], [33, 145, 140], [34, 168, 132], [68, 191, 112], [122, 209, 81], [189, 223, 38], [253, 231, 37]];
  const {ramp, rgb, gradient} = paletteRamp(RAMP);

  return Object.freeze({VERSION, DEFAULTS, NET_DEFAULTS, RHO20, ALPHA, rhoAt, ipc2221K, ipc2221Current, ipc2221, normalize, normalizeNet, read, write, nets, partsOn, guess, voltageOf, isGround, isSupply,
    copperStack, padRing, job: (...a) => decorate(job(...a)), solve, run, analyze, report, violations, headless, paletteRamp, ramp, rgb, gradient, core,
    coreFactory: AtriumPDNCore, serve: AtriumPDNServe, runSolver: AtriumSolverClient});
})();
