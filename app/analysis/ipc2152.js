"use strict";
if (!globalThis.AtriumPDN && typeof require === "function") require("./pdn.js");
// IPC-2152 conductor current capacity: the chart curve fits, the Brooks & Adam closed forms, IPC-2221
// for comparison, plated-via capacity, and the "Current Capacity" design rule and check
// (Tools › Thermal › Current Capacity Check, Design › Rules › Current Capacity, MCP current_capacity_check).
//
// Models and sources (read the limits before trusting a number)
//  * IPC-2152 (2009) "Standard for Determining Current Carrying Capacity in Printed Board Design".
//    Its baseline is the universal chart (Figure 5-1): internal and external conductors in a
//    0.070 in (1.78 mm) polyimide test board, 3 oz copper, no planes, still air. It is applied to
//    both internal and external conductors (IPC-2152 notes that external conductors in still air
//    run cooler, so the chart is conservative for them). Modifier charts scale the cross-section
//    for copper weight, board thickness, a copper plane and its distance, and the board's
//    thermal conductivity.
//  * The chart and modifier curves are the published curve fits of G. Hunter's NinjaCalc
//    "Track Current (IPC-2152)" calculator (blog.mbedded.ninja, MIT licence), transcribed in
//    calculators.js and checked here against its published worked example (1 A, 40 °C, 1 oz,
//    1.6 mm board, plane at 1.6 mm, k 0.2 W/m·K: modifiers 0.903 · 1.092 · 0.602 · 1.032, area
//    3361 → 2058 µm², width 0.0588 mm; tests/ipc2152.cjs). The fits are valid for copper ½–3 oz,
//    board 0.72–2.36 mm, plane distance 0.144–2.40 mm and k 0.18–0.34 W/m·K; outside, the inputs
//    are clamped and a warning is returned. The chart data go up to about 30 A and 100 °C rise.
//  * Brooks & Adam, "Trace Currents and Temperatures Revisited" (2015), Table 3-1: closed-form fits
//    of the same IPC-2152 data, ΔT = K·I^a·W^b·Th^c (mil), separate for external and internal
//    traces (the coefficients KiCad's calculator uses). They agree with the chart within about
//    10–20 % and are offered as an alternative method.
//  * IPC-2221B §6.2 (Figure 6-4, the 1956 NBS data): I = k·ΔT^0.44·A^0.725, k 0.048 external,
//    0.024 internal. For comparison only.
//  * Vias: the plated barrel A = π·(d + t)·t (d the finished hole, t the plating) is treated as a
//    conductor of that cross-section on the baseline chart (no modifiers), following IPC-2152's
//    guidance that a via is a conductor of its plated cross-section. Short barrels are cooled by
//    the copper they join, so this is conservative; IPC-2221 external is the comparison.
// Not modelled: neighbouring heat sources (use the Temperature Rise Map, thermal.js), AC/pulsed
// currents (enter the RMS value), altitude, conformal coating, extra plating on outer layers
// (enter the finished thickness in the stack-up).
//
// API (DOM-free):
//   AtriumIPC2152.chartArea(I, dT) -> mil²     chartCurrent(A, dT)    chartRise(A, I)
//   AtriumIPC2152.modifiers({oz, current, board, plane, k}) -> {copper, board, plane, conductivity, total, warnings}
//   AtriumIPC2152.conductor({width?, current?, rise?, thickness, internal, board, plane, k, method}) -> solves the missing one
//   AtriumIPC2152.via({drill, plating, current?, rise?, method}) -> {area, current, rise, ...}
//   AtriumIPC2152.check(doc, defs, opts) -> {rows, violations, notes, summary}   (also MCP current_capacity_check)
//   AtriumIPC2152.drc(doc, defs, ctx)    -> the rules.js hook for the currentCapacity rule
// Units: mm, A, °C, W/m·K unless a name says mil.
globalThis.AtriumIPC2152 = (() => {
  const MIL = 0.0254, OZ_UM = 35;
  const METHODS = Object.freeze({ipc2152: "IPC-2152 chart with modifiers", brooksAdam: "IPC-2152 (Brooks & Adam fit)", ipc2221: "IPC-2221 (comparison)"});
  const RANGE = Object.freeze({oz: [0.5, 3], board: [0.72, 2.36], plane: [0.144, 2.40], k: [0.18, 0.34], current: 30, rise: 100});
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const r4 = v => fin(v) ? Math.round(v * 1e4) / 1e4 + 0 : v;

  // ---------------------------------------------------------------- IPC-2152 chart fits (NinjaCalc)
  // Universal chart (Figure 5-1): unadjusted cross-section in mil² for I (A) at a rise dT (°C).
  const chartArea = (I, dT) => Math.pow(I / (0.089710902134 * Math.pow(dT, 0.39379253898)), 1 / (0.50382053698 * Math.pow(dT, 0.038495772461)));
  // Copper-weight modifier: a polynomial in copper weight (oz, columns) and current (A, rows).
  const CU = [[0.98453567795, -0.22281787548, 0.20061423196, -0.041541116264],
    [-0.01657194921, 0.00017520059279, -0.0050615234096, 0.002281483634],
    [0.00088711317661, 0.0013631745743, -0.0002237330971, -0.00010974218613],
    [-6.6729255031e-6, -0.00014976736827, 5.8082340133e-5, -2.4728159584e-6],
    [-7.9576264561e-7, 5.5788354958e-6, -2.4912026388e-6, 2.4000295954e-7],
    [1.6619678738e-8, -7.1122635445e-8, 3.3800191741e-8, -3.9797591878e-9]];
  function copperMod(oz, I) {
    let s = 0;
    const x = clamp(oz, RANGE.oz[0], RANGE.oz[1]), i = clamp(I, 0, RANGE.current);
    for (let r = 0; r < 6; r++) for (let c = 0; c < 4; c++) s += CU[r][c] * Math.pow(x, c) * Math.pow(i, r);
    return s;
  }
  const boardMod = mm => 24.929779905 * Math.pow(clamp(mm, RANGE.board[0], RANGE.board[1]) / MIL, -0.75501997929);
  // A plane at distance d (mm) under or over the conductor; none (null, 0) leaves 1.
  const planeMod = mm => mm > 0 ? Math.min(1, 0.0031298662911 * clamp(mm, RANGE.plane[0], RANGE.plane[1]) / MIL + 0.40450883823) : 1;
  // Board thermal conductivity, W/m·K (the fit takes BTU/(h·ft·°F)).
  const condMod = k => -1.4210148167 * clamp(k, RANGE.k[0], RANGE.k[1]) * 0.577789 + 1.1958174134;
  function modifiers({oz = 1, current = 1, board = 1.6, plane = 0, k = 0.2} = {}) {
    const warnings = [];
    if (oz < RANGE.oz[0] - 1e-9 || oz > RANGE.oz[1] + 1e-9) warnings.push("The copper-weight fit covers ½ to 3 oz; " + r4(oz) + " oz was clamped.");
    if (board < RANGE.board[0] - 1e-9 || board > RANGE.board[1] + 1e-9) warnings.push("The board-thickness fit covers 0.72 to 2.36 mm; " + r4(board) + " mm was clamped.");
    if (plane > 0 && (plane < RANGE.plane[0] - 1e-9 || plane > RANGE.plane[1] + 1e-9)) warnings.push("The plane-distance fit covers 0.144 to 2.40 mm; " + r4(plane) + " mm was clamped.");
    if (k < RANGE.k[0] - 1e-9 || k > RANGE.k[1] + 1e-9) warnings.push("The conductivity fit covers 0.18 to 0.34 W/m·K; " + r4(k) + " was clamped.");
    const m = {copper: copperMod(oz, current), board: boardMod(board), plane: planeMod(plane), conductivity: condMod(k)};
    m.total = m.copper * m.board * m.plane * m.conductivity;
    m.warnings = warnings;
    return m;
  }
  // Monotone bisection in log space: f increasing in x on [lo, hi]; returns x with f(x) = target.
  function solveUp(f, target, lo, hi) {
    let a = Math.log(lo), b = Math.log(hi);
    if (!(f(lo) < target)) return lo;
    if (!(f(hi) > target)) return hi;
    for (let i = 0; i < 80; i++) { const m = (a + b) / 2; if (f(Math.exp(m)) < target) a = m; else b = m; }
    return Math.exp((a + b) / 2);
  }
  // Inverses of the bare chart (no modifiers).
  const chartCurrent = (A, dT) => solveUp(I => chartArea(I, dT), A, 1e-6, 1e4);
  const chartRise = (A, I) => solveUp(dT => -chartArea(I, dT), -A, 1e-4, 1e4);

  // ---------------------------------------------------------------- Brooks & Adam (2015) and IPC-2221
  const BA = {external: {K: 215.3, a: 2.0, b: -1.15, c: -1.0},
    internal: [[0.689, {K: 120.0, a: 2.0, b: -1.10, c: -1.52}], [1.378, {K: 200.0, a: 1.9, b: -1.10, c: -1.52}],
      [2.756, {K: 300.0, a: 2.0, b: -1.15, c: -1.52}], [4.134, {K: 262.5, a: 1.9, b: -1.15, c: -1.52}]]};
  function baCoeff(internal, thMil) {
    if (!internal) return BA.external;
    const w = BA.internal;
    for (let i = 0; i < w.length - 1; i++) if (thMil < (w[i][0] + w[i + 1][0]) / 2) return w[i][1];
    return w.at(-1)[1];
  }
  const brooksAdam = Object.freeze({
    rise: (wMil, I, thMil, internal) => { const k = baCoeff(internal, thMil); return k.K * Math.pow(I, k.a) * Math.pow(wMil, k.b) * Math.pow(thMil, k.c); },
    width: (I, dT, thMil, internal) => { const k = baCoeff(internal, thMil); return Math.pow(dT / (k.K * Math.pow(I, k.a) * Math.pow(thMil, k.c)), 1 / k.b); },
    current: (wMil, dT, thMil, internal) => { const k = baCoeff(internal, thMil); return Math.pow(dT / (k.K * Math.pow(wMil, k.b) * Math.pow(thMil, k.c)), 1 / k.a); }
  });
  // mil² current lives on AtriumPDN. Area and rise keep using that same k.
  const kOf = internal => globalThis.AtriumPDN.ipc2221K(internal);
  const ipc2221 = Object.freeze({
    area: (I, dT, internal) => Math.pow(I / (kOf(internal) * Math.pow(dT, 0.44)), 1 / 0.725),
    current: (aMil2, dT, internal) => globalThis.AtriumPDN.ipc2221Current(aMil2, dT, internal),
    rise: (aMil2, I, internal) => Math.pow(I / (kOf(internal) * Math.pow(aMil2, 0.725)), 1 / 0.44)
  });

  // ---------------------------------------------------------------- conductor and via
  // o: {width (mm), current (A), rise (°C): exactly one missing (null), thickness (mm), internal,
  //     board (mm), plane (mm, 0 = none), k (W/m·K), method}. Returns all three plus the others.
  function conductor(o) {
    const method = METHODS[o.method] ? o.method : "ipc2152", t = +o.thickness > 0 ? +o.thickness : OZ_UM / 1000, thMil = t / MIL, oz = t * 1000 / OZ_UM;
    const internal = !!o.internal, board = +o.board > 0 ? +o.board : 1.6, plane = +o.plane > 0 ? +o.plane : 0, k = +o.k > 0 ? +o.k : 0.2;
    let W = fin(o.width) && o.width > 0 ? o.width : null, I = fin(o.current) && o.current >= 0 ? o.current : null, dT = fin(o.rise) && o.rise > 0 ? o.rise : null;
    const missing = [W, I, dT].filter(v => v == null).length;
    if (missing !== 1) throw Error("Give two of width, current and temperature rise.");
    const warnings = [];
    let mods = null;
    const aMil = w => w * t / (MIL * MIL);
    if (method === "ipc2152") {
      const mFor = cur => modifiers({oz, current: cur, board, plane, k});
      if (W == null) { mods = mFor(I); W = chartArea(I, dT) * mods.total * MIL * MIL / t; }
      else if (I == null) { I = solveUp(c => chartArea(c, dT) * mFor(c).total, aMil(W), 1e-6, 1e4); mods = mFor(I); }
      else { mods = mFor(I); dT = solveUp(d => -chartArea(I, d) * mods.total, -aMil(W), 1e-4, 1e4); }
      if (mods.copper <= 0) warnings.push("The copper-weight modifier fit is out of range at this current.");
      warnings.push(...mods.warnings);
    } else if (method === "brooksAdam") {
      if (W == null) W = brooksAdam.width(I, dT, thMil, internal) * MIL;
      else if (I == null) I = brooksAdam.current(W / MIL, dT, thMil, internal);
      else dT = brooksAdam.rise(W / MIL, I, thMil, internal);
    } else {
      if (W == null) W = ipc2221.area(I, dT, internal) * MIL * MIL / t;
      else if (I == null) I = ipc2221.current(aMil(W), dT, internal);
      else dT = ipc2221.rise(aMil(W), I, internal);
    }
    if (I > RANGE.current || dT > RANGE.rise) warnings.push("Outside the IPC-2152 test data (up to 30 A and 100 °C rise).");
    return {method, width: W, current: I, rise: dT, area: W * t, thickness: t, internal, modifiers: mods ? {copper: mods.copper, board: mods.board, plane: mods.plane, conductivity: mods.conductivity, total: mods.total} : null, warnings};
  }
  // All three methods side by side, solving for the same unknown.
  function compare(o) {
    const out = {};
    for (const m of Object.keys(METHODS)) { try { out[m] = conductor({...o, method: m}); } catch (e) { out[m] = {error: e.message}; } }
    return out;
  }
  const barrelArea = (drill, plating) => globalThis.AtriumPDN.core.platedBarrelArea(drill, plating);
  // o: {drill (mm), plating (mm), current?, rise?, method}: capacity at the rise and/or the rise at the current.
  function via(o) {
    const d = +o.drill > 0 ? +o.drill : .3, t = +o.plating > 0 ? +o.plating : .025, A = barrelArea(d, t), aMil = A / (MIL * MIL);
    const method = o.method === "ipc2221" ? "ipc2221" : "ipc2152", rise = fin(o.rise) && o.rise > 0 ? o.rise : null, I = fin(o.current) && o.current >= 0 ? o.current : null;
    const cap = dT => method === "ipc2221" ? ipc2221.current(aMil, dT, false) : chartCurrent(aMil, dT);
    const riseAt = cur => !(cur > 0) ? 0 : method === "ipc2221" ? ipc2221.rise(aMil, cur, false) : chartRise(aMil, cur);
    return {method, area: A, drill: d, plating: t, current: rise != null ? cap(rise) : null, rise: I != null ? riseAt(I) : null,
      basis: method === "ipc2221" ? "IPC-2221 external conductor of the barrel cross-section" : "IPC-2152 baseline chart for the barrel cross-section (no modifiers)"};
  }

  // ---------------------------------------------------------------- board context
  const COPPER_KEY = /^(Top|Bottom|Inner (?:[1-9]\d?|1[01]\d|12[0-6]))$/;
  const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
  const world = (p, parent) => globalThis.Atrium?.world ? Atrium.world(p, parent) : [p[0] + parent.x, p[1] + parent.y];
  // Copper layers with z, thickness, internal flag, and the distance to the nearest plane.
  function layersOf(doc, defs) {
    const S = globalThis.AtriumStackup, out = new Map();
    let board = 1.6;
    try {
      if (S?.get) {
        const st = S.get(doc, defs), list = st.layers;
        let z = 0;
        const cu = [];
        for (const l of list) { const t = +l.thickness || 0; if (S.isCopper(l) && l.key) cu.push({key: l.key, t: t || .035, z: z + (t || .035) / 2, type: l.type}); z += t; }
        board = z || 1.6;
        cu.forEach((l, i) => out.set(l.key, {...l, internal: i > 0 && i < cu.length - 1}));
      }
    } catch { /* default two layers below */ }
    if (!out.size) { out.set("Top", {key: "Top", t: .035, z: 0, type: "Signal", internal: false}); out.set("Bottom", {key: "Bottom", t: .035, z: board, type: "Signal", internal: false}); }
    // Planes: Plane layers, and copper layers that carry a polygon or pour (solid copper).
    const solid = new Set([...out.values()].filter(l => l.type === "Plane").map(l => l.key));
    for (const i of doc.items || []) if (i.kind === "polygon" && !i.cutout && !i.keepout && out.has(i.layer)) solid.add(i.layer);
    for (const r of doc.pcbDrawing?.pours || []) if (out.has(r.layer)) solid.add(r.layer);
    for (const l of out.values()) {
      let best = 0;
      for (const k of solid) if (k !== l.key) { const d = Math.abs(out.get(k).z - l.z); if (d > 0 && (!best || d < best)) best = d; }
      l.plane = best;
    }
    return {layers: out, board};
  }
  // Required current of a net: the rule's own current, else Net currents, else the largest Class current.
  function requiredCurrent(set, rule, net) {
    if (rule && +rule.current > 0) return +rule.current;
    if (!net || !set) return 0;
    if (own(set.netCurrents, net) && +set.netCurrents[net] > 0) return +set.netCurrents[net];
    let best = 0;
    for (const [cls, members] of Object.entries(set.netClasses || {})) if (Array.isArray(members) && members.includes(net) && +set.classCurrents?.[cls] > best) best = +set.classCurrents[cls];
    return best;
  }
  const fmtA = v => !fin(v) ? "—" : Math.abs(v) < 1 ? (v * 1000).toFixed(0) + " mA" : v.toFixed(2) + " A";
  const fmtT = v => !fin(v) ? "—" : v >= 1000 ? "> 1000 °C" : v.toFixed(1) + " °C";
  const layerName = k => k === "Top" ? "Top Layer" : k === "Bottom" ? "Bottom Layer" : k;

  // ---------------------------------------------------------------- PDN currents
  // Per-object currents from the PDN Analyzer setups saved with the board (doc.pdn): tracks
  // (max |I| over their pieces; wide tracks on the grid: J·w·t sampled along the centreline) and
  // vias (barrel current). Cached per board by a fingerprint of the setup and the copper.
  const pdnCache = new WeakMap();
  function fingerprint(doc) {
    let h = 2166136261 >>> 0;
    const mix = v => { const s = typeof v === "number" ? Math.round(v * 1e4) : String(v); const str = String(s); for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619) >>> 0; };
    mix(JSON.stringify(doc.pdn || null)); mix((doc.items || []).length);
    for (const i of doc.items || []) { if (i.kind !== "track" && i.kind !== "via" && i.kind !== "polygon" && i.kind !== "part") continue; mix(i.id); mix(i.x || 0); mix(i.y || 0); mix(i.width || 0); mix(i.net || ""); if (i.points) for (const p of i.points) { mix(p[0]); mix(p[1]); } }
    mix((doc.pcbDrawing?.pours || []).length);
    return h;
  }
  function pdnCurrents(doc, defs, opts = {}) {
    const P = globalThis.AtriumPDN;
    const out = {tracks: new Map(), vias: new Map(), nets: new Set(), notes: [], ran: false};
    if (!P) { out.notes.push("PDN currents need the PDN Analyzer module (pdn.js)."); return out; }
    const fp = fingerprint(doc), hit = pdnCache.get(doc);
    if (hit && hit.fp === fp && !opts.fresh) return hit.out;
    const saved = P.read(doc), setup = saved.nets.filter(n => n.enabled);
    if (!setup.length) { out.notes.push("No PDN Analyzer setup is saved with this board (Tools › PDN Analyzer…), so there are no analysed currents."); pdnCache.set(doc, {fp, out}); return out; }
    const put = (map, id, v) => { const p = map.get(id); if (!p || v.current > p.current) map.set(id, v); };
    for (const n of setup) {
      let r;
      try { r = P.analyze(doc, defs, n, saved); } catch (e) { out.notes.push("PDN " + n.net + ": " + e.message); continue; }
      out.ran = true;
      for (const res of [r.supply, r.ret]) {
        if (!res) continue;
        const m = res.meta, ids = m.ids, ch = res.chain;
        out.nets.add(m.net);
        for (let k = 0; k < ch.n; k++) {
          const cur = Math.abs(ch.i[k]);
          if (!(cur === cur)) continue;
          put(out.tracks, ids.tracks[ch.track[k]], {current: cur, at: [(ch.geo[4 * k] + ch.geo[4 * k + 2]) / 2, (ch.geo[4 * k + 1] + ch.geo[4 * k + 3]) / 2], net: m.net});
        }
        // Wide tracks (on the grid): sample J along the centreline.
        const job = res.meta, wide = new Set();
        for (let k = 0; k < ch.n; k++) wide.add(ch.track[k]);
        (doc.items || []).forEach(it => {
          if (it.kind !== "track" || it.net !== m.net || it.fill || !Array.isArray(it.points)) return;
          const k = ids.tracks.indexOf(it.id);
          if (k < 0 || wide.has(k)) return;
          const li = res.layers.findIndex(l => l.key === (it.layer || "Top")), g = li >= 0 ? res.layers[li].grid : null;
          if (!g) return;
          const t = (P.copperStack(doc, defs).find(l => l.key === (it.layer || "Top"))?.t) || .035;
          let best = 0, at = null;
          for (let s = 1; s < it.points.length; s++) {
            const a = it.points[s - 1], b = it.points[s], L = Math.hypot(b[0] - a[0], b[1] - a[1]), n2 = Math.max(2, Math.ceil(L / g.h));
            for (let q = 1; q < n2; q++) {
              const x = a[0] + (b[0] - a[0]) * q / n2, y = a[1] + (b[1] - a[1]) * q / n2, ix = Math.floor((x - g.x0) / g.h), iy = Math.floor((y - g.y0) / g.h);
              if (ix < 0 || iy < 0 || ix >= g.nx || iy >= g.ny) continue;
              const j = g.j[iy * g.nx + ix];
              if (j > best) { best = j; at = [x, y]; }
            }
          }
          if (at) put(out.tracks, it.id, {current: best * it.width * t, at, net: m.net, sampled: true});
          void job;
        });
        res.pads.forEach((p, k) => { const id = ids.pads[k]; if (id?.via && p.sections.length) put(out.vias, id.id, {current: Math.abs(p.i), at: id.at, net: m.net}); });
      }
    }
    pdnCache.set(doc, {fp, out});
    return out;
  }

  // ---------------------------------------------------------------- evaluation
  // Every conductor of the nets in scope against the allowable rise. ruleFor(o) returns the
  // parameters for an object ({maxRise, current, method, source, checkVias, checkPads, plating,
  // rule?}) or null. Returns rows (all checked objects) and the failing ones.
  function evaluate(doc, defs, {ruleFor, set, notes = []}) {
    const {layers, board} = layersOf(doc, defs), rows = [];
    let pdn = null;
    const pdnFor = () => pdn || (pdn = pdnCurrents(doc, defs));
    const spanOf = key => { const i = key === "Top" ? 0 : key === "Bottom" ? 127 : +String(key).slice(6); return [i, i]; };
    const currentFor = (r, net, kind, id) => {
      const req = r.source === "pdn" ? 0 : requiredCurrent(set, r, net);
      let an = 0, at = null;
      if (r.source !== "rule") { const P = pdnFor(), m = kind === "via" ? P.vias : P.tracks, hit = m.get(id); if (hit) { an = hit.current; at = hit.at; } }
      const current = Math.max(req, an);
      return {current, basis: current > 0 && an >= req && an > 0 ? "pdn" : "required", at};
    };
    // Tracks: per segment, the worst one is the row.
    for (const it of doc.items || []) {
      if (it.kind !== "track" || it.fill || !it.net || !(+it.width > 0) || !Array.isArray(it.points) || it.points.length < 2 || it.keepout) continue;
      const key = it.layer || "Top", L = layers.get(key);
      if (!L) continue;
      const o = {id:it.id, item:it, kind:it.arc ? "arc" : "track", net:it.net, layer:key, span:spanOf(key), at:it.points[0]};
      const r = ruleFor(o);
      if (!r) continue;
      const c = currentFor(r, it.net, "track", it.id);
      if (!(c.current > 0)) continue;
      const res = conductor({width: +it.width, rise: r.maxRise, thickness: L.t, internal: L.internal, board, plane: L.plane, k: r.k ?? .2, method: r.method});
      const rise = c.current > 0 ? conductor({width: +it.width, current: c.current, thickness: L.t, internal: L.internal, board, plane: L.plane, k: r.k ?? .2, method: r.method}).rise : 0;
      let at = c.at;
      if (!at) { let bi = 1, bl = -1; for (let s = 1; s < it.points.length; s++) { const a = it.points[s - 1], b = it.points[s], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > bl) { bl = l; bi = s; } } const a = it.points[bi - 1], b = it.points[bi]; at = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]; }
      rows.push({kind: "track", id: it.id, net: it.net, layer: key, label: "Track (" + layerName(key) + ") " + it.net, width: +it.width, thickness: L.t, internal: L.internal,
        current: c.current, basis: c.basis, allowed: res.current, rise, maxRise: r.maxRise, method: res.method, at, rule: r.rule || null, ok: c.current <= res.current * (1 + 1e-9)});
    }
    // Vias: the barrel.
    for (const it of doc.items || []) {
      if (it.kind !== "via" || !it.net || !Number.isFinite(it.x)) continue;
      const o = {id:it.id, item:it, kind:"via", net:it.net, layer:"Multi",
        span:globalThis.AtriumRules?.kit.layerSpan(it) ?? [0,127], at:[it.x,it.y]};
      const r = ruleFor(o);
      if (!r || r.checkVias === false) continue;
      const c = currentFor(r, it.net, "via", it.id);
      if (!(c.current > 0)) continue;
      const plating = (+r.plating || 25) / 1000, v = via({drill: +it.drill || .3, plating, rise: r.maxRise, current: c.current, method: r.method === "ipc2221" ? "ipc2221" : "ipc2152"});
      rows.push({kind: "via", id: it.id, net: it.net, layer: "Multi", label: "Via " + it.net, drill: v.drill, plating, current: c.current, basis: c.basis, allowed: v.current, rise: v.rise,
        maxRise: r.maxRise, method: v.method, at: [it.x, it.y], rule: r.rule || null, ok: c.current <= v.current * (1 + 1e-9)});
    }
    // Pads: the narrowest copper cross-section of the pad (a neck where a track enters it).
    const fpOf = part => defs?.get?.(part.def)?.footprint;
    for (const it of doc.items || []) {
      const list = it.kind === "part" ? (fpOf(it)?.pads || []).map(p => ({p, parent: it, net: it.pinNets && own(it.pinNets, p.number) ? it.pinNets[p.number] : ""}))
        : it.kind === "pad" ? [{p: it, parent: null, net: it.net || ""}] : [];
      for (const {p, parent, net} of list) {
        if (!net) continue;
        const w = Math.min(+(p.w ?? p.diameter) || 0, +(p.h ?? p.diameter) || 0);
        if (!(w > 0)) continue;
        const key = p.layer && p.layer !== "Multi" ? p.layer : parent?.layer === "Bottom" ? "Bottom" : "Top", L = layers.get(COPPER_KEY.test(key) ? key : "Top") || layers.get("Top");
        const at = parent ? world([+p.x || 0, +p.y || 0], parent) : [+p.x || 0, +p.y || 0];
        const o = {id:parent?.id || p.id, item:p, part:parent, definition:parent && defs?.get(parent.def),
          net, layer:L.key, span:spanOf(L.key), kind:"pad", component:parent?.ref, pin:p.number==null?undefined:String(p.number), at};
        const r = ruleFor(o);
        if (!r || r.checkPads === false || r.source === "pdn") continue;
        const cur = requiredCurrent(set, r, net);
        if (!(cur > 0)) continue;
        const res = conductor({width: w, rise: r.maxRise, thickness: L.t, internal: L.internal, board, plane: L.plane, k: r.k ?? .2, method: r.method});
        const rise = conductor({width: w, current: cur, thickness: L.t, internal: L.internal, board, plane: L.plane, k: r.k ?? .2, method: r.method}).rise;
        rows.push({kind: "pad", id: parent?.id || p.id, net, layer: L.key, label: "Pad " + (parent ? (parent.ref || "") + "-" : "") + (p.number ?? "?") + " " + net, width: w, thickness: L.t,
          current: cur, basis: "required", allowed: res.current, rise, maxRise: r.maxRise, method: res.method, at, rule: r.rule || null, ok: cur <= res.current * (1 + 1e-9)});
      }
    }
    if (pdn) notes.push(...pdn.notes);
    rows.sort((a, b) => (a.ok - b.ok) || (b.current / b.allowed) - (a.current / a.allowed));
    return {rows, failing: rows.filter(r => !r.ok), pdnRan: !!pdn?.ran};
  }
  const detailOf = x => fmtA(x.current) + (x.basis === "pdn" ? " (PDN)" : "") + " raises this " + (x.kind === "via" ? "via barrel (" + r4(x.drill) + " mm hole, " + r4(x.plating * 1000) + " µm)" : x.kind === "pad" ? "pad (" + r4(x.width) + " mm wide)" : r4(x.width) + " mm track") +
    " by " + fmtT(x.rise) + " > " + x.maxRise + " °C; it carries " + fmtA(x.allowed) + " at " + x.maxRise + " °C (" + METHODS[x.method] + ")";

  // ---------------------------------------------------------------- DRC hook (rules.js currentCapacity)
  let capture = null;   // check() collects every row of a DRC run here
  function drc(doc, defs, ctx) {
    const rules = ctx.rules || [];
    if (!rules.length) return 0;
    const params = r => ({rule: r.name, maxRise: +r.maxRise || 10, current: +r.current || 0, method: r.method || "ipc2152", source: r.source || "rule", checkVias: r.checkVias !== false, checkPads: r.checkPads !== false, plating: +r.plating || 25});
    const byRule = new Map(rules.map(r => [r, params(r)]));
    const notes = [], cap = capture, only = cap?.only, src = cap?.opts?.source;
    const ruleFor = o => { if (only && !only.has(o.net)) return null; const r = ctx.first("currentCapacity", o); if (!r) return null; const p = byRule.get(r) || params(r); return src ? {...p, source: src} : p; };
    const {rows, failing, pdnRan} = evaluate(doc, defs, {ruleFor, set: ctx.set, notes});
    if (cap) { cap.rows.push(...rows); cap.failing.push(...failing); cap.pdnRan ||= pdnRan; cap.notes = notes; }
    const byName = new Map(rules.map(r => [r.name, r]));
    for (const x of failing) ctx.flag(byName.get(x.rule) || rules[0], {id: x.id, title: x.label, detail: detailOf(x), at: x.at,
      current: {actual: r4(x.current), allowed: r4(x.allowed), rise: r4(x.rise), maxRise: x.maxRise, basis: x.basis, method: x.method}});
    if (!rows.length) ctx.notes?.push("Current Capacity: no copper of the nets in scope has a required current. Set the rule's current, Net currents or Class currents, or use the PDN Analyzer currents.");
    for (const n of new Set(notes)) ctx.notes?.push("Current Capacity: " + n);
    return rows.length;
  }

  // ---------------------------------------------------------------- Current Capacity Check (menu, MCP)
  // opts: {max_rise, method, source: "rule"|"pdn"|"both", currents:{NET:A}, nets:[...], k, plating_um}.
  // Uses the board's Current Capacity rules when there are any, else the options for every net
  // with a current.
  function check(doc, defs, opts = {}, project = null) {
    if (doc?.kind !== "pcb") throw Error("Open a PCB layout for the current capacity check.");
    const R = globalThis.AtriumRules, notes = [];
    let raw = null, set = null;
    try { raw = R?.effective ? R.effective(doc, project) : null; } catch { raw = R?.stored?.(doc, project) ?? null; }
    try { set = raw && R?.migrate ? R.migrate(raw) : raw; } catch { set = raw; }
    const rules = (set?.list || []).filter(r => r.type === "currentCapacity" && r.enabled !== false);
    const extra = opts.currents && typeof opts.currents === "object" ? opts.currents : null;
    if (extra) set = {...(set || {}), netCurrents: {...(set?.netCurrents || {}), ...extra}};
    const only = Array.isArray(opts.nets) && opts.nets.length ? new Set(opts.nets) : null;
    const base = {maxRise: +opts.max_rise > 0 ? +opts.max_rise : 10, current: 0, method: METHODS[opts.method] ? opts.method : "ipc2152", source: ["rule", "pdn", "both"].includes(opts.source) ? opts.source : "both",
      checkVias: true, checkPads: true, plating: +opts.plating_um > 0 ? +opts.plating_um : 25, k: +opts.k > 0 ? +opts.k : .2};
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    let ev;
    if (rules.length && !opts.ignore_rules && R?.drc) {
      // The rules' own scopes and priorities: run the DRC for this rule type and collect every row.
      capture = {rows: [], failing: [], pdnRan: false, only, opts};
      try { R.drc(doc, defs, extra ? {...set, netCurrents: set.netCurrents} : raw, {types: ["currentCapacity"], scopes: false, limit: 100000, project}); ev = capture; }
      finally { capture = null; }
      notes.push("Checked with the board's Current Capacity rules (" + rules.map(r => r.name).join(", ") + ").");
    } else {
      ev = evaluate(doc, defs, {ruleFor: o => only && !only.has(o.net) ? null : base, set, notes});
      notes.push("No Current Capacity rule on this board: every net with a current (Net or Class currents" + (base.source !== "rule" ? ", or PDN Analyzer currents" : "") + ") is checked at " + base.maxRise + " °C.");
    }
    const ms = (globalThis.performance?.now?.() ?? Date.now()) - t0;
    if (ev.notes) notes.push(...ev.notes);
    const violations = ev.failing.map(x => ({kind: "current-capacity", severity: x.rise > 2 * x.maxRise ? "Error" : "Warning", id: x.id, net: x.net, at: x.at, title: "Current capacity: " + x.label, detail: detailOf(x)}));
    const nets = [...new Set(ev.rows.map(r => r.net))];
    return {rows: ev.rows, violations, notes: [...new Set(notes)], method: base.method,
      summary: {checked: ev.rows.length, failing: ev.failing.length, nets: nets.length, worstRise: ev.rows.reduce((m, r) => Math.max(m, r.rise || 0), 0), pdn: ev.pdnRan, ms: Math.round(ms)}};
  }
  // MCP current_capacity_check (read-only).
  function headless(a, host) {
    const p = host.project(), doc = host.board(p, a.document_id), defs = host.defsOf(p);
    const r = check(doc, defs, a, p), lim = a.max_rows ?? 100;
    const row = x => ({kind: x.kind, id: x.id, net: x.net, layer: x.layer, ...(x.width != null ? {width_mm: r4(x.width)} : {}), ...(x.drill != null ? {drill_mm: r4(x.drill), plating_um: r4(x.plating * 1000)} : {}),
      current_a: r4(x.current), current_basis: x.basis, allowed_a: r4(x.allowed), rise_c: r4(x.rise), max_rise_c: x.maxRise, method: x.method, at: x.at ? [r4(x.at[0]), r4(x.at[1])] : null, rule: x.rule, ok: x.ok});
    const rows = a.only_failing ? r.rows.filter(x => !x.ok) : r.rows;
    return {document_id: doc.id, units: {length: "mm", current: "A", temperature: "°C"},
      model: "IPC-2152 universal chart with copper-weight, board-thickness, plane and conductivity modifiers (NinjaCalc curve fits), or the Brooks & Adam fit, or IPC-2221; vias as the plated barrel pi*(d+t)*t on the baseline chart. Each conductor is treated as isolated in still air.",
      summary: r.summary, violations: r.violations.slice(0, lim), rows: rows.slice(0, lim).map(row), row_count: rows.length, notes: r.notes};
  }

  return Object.freeze({MIL, OZ_UM, METHODS, RANGE, chartArea, chartCurrent, chartRise, modifiers, copperMod, boardMod, planeMod, condMod, brooksAdam, ipc2221,
    conductor, compare, via, barrelArea, layersOf, requiredCurrent, pdnCurrents, evaluate, drc, check, headless, fmtA, fmtT});
})();
