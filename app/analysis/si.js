"use strict";
// SI-lite in-design analysis (Tools › Signal Integrity…), after Allegro Sigrity Aurora:
// per-segment impedance, reference-plane continuity, return-path vias, a parallel-run
// crosstalk estimate and differential-pair phase/coupling, as a table, a per-net impedance
// profile plot and canvas overlays. The core (everything above "dialog") is DOM-free.
//
// Models and stated accuracy
//  * Impedance: AtriumImpedance (closed-form quasi-TEM, field-solver checked; see impedance.js:
//    microstrip 0.2 %, symmetric stripline 0.5 %, offset stripline 2-5 %, coupled stripline
//    0.6 %, coupled microstrip about 1.2 %). Geometry per piece of track: its width, its layer,
//    the substack of the rigid-flex region it runs through (AtriumRigidFlex.piecesAlong) and
//    the reference planes actually under it. A net with an impedance profile (Width or
//    Differential Pairs Routing rule) uses the profile's references, etch and coplanar gap.
//    Where the nominal reference has a void, the next copper layer outward that does have
//    copper there becomes the reference (the impedance rises); none at all reads "no model".
//    Antipads around the net's own vias are recognised and not counted as deviations.
//  * Reference copper on a layer: poured polygon regions (exact contours), unpoured polygons
//    (outline assumed solid), filled copper shapes, and a Plane layer with no copper objects
//    (assumed a solid plane over the board outline, like an Altium negative plane). Each
//    track is tested on its centre line and both edges on the nominal reference.
//    A void on that centre line falls back to the next copper under the centre line,
//    with each span bounded by the edges of that copper.
//  * Return path: at every via where the net changes layer, the references before and after
//    are compared. A shared reference needs nothing; the same net on two layers needs a
//    stitching via (or plated hole) of that net spanning both within `returnRadius`
//    (default 1 mm); different nets need a stitching capacitor between them within
//    `capRadius` (default 5 mm).
//  * Crosstalk (an ESTIMATE): backward (near-end) crosstalk with the saturation model
//        Kb = 1/4 (Cm/C + Lm/L),  NEXT = Kb · min(1, 2·Lc / (v·Tr)),  Lsat = v·Tr / 2
//    and forward (far-end) crosstalk  FEXT = Lc / (2·v·Tr) · |Cm/C − Lm/L|  (zero in a
//    homogeneous stripline). Same layer: Cm/C and Lm/L come from the even/odd modes of the
//    coupled-line model at the actual edge gap and mean width (Ce,o = √εe,o/(c·Ze,o),
//    Le,o = Ze,o·√εe,o/c; Cm/C = (Co−Ce)/(Co+Ce), Lm/L = (Le−Lo)/(Le+Lo)), so it inherits
//    the solver's accuracy for the coupling coefficient itself (about 2-5 %). Adjacent layers
//    (broadside): a wire-over-plane image model, k = ½·ln((d²+(h1+h2)²)/(d²+(h1−h2)²)) /
//    √(ln(2h1/r1)·ln(2h2/r2)), r = (w+t)/4, Kb = k/2; expect ±50 %. Stretches of one net
//    pair add linearly up to the strongest stretch's saturated value (conservative). The
//    terminations, driver edge and the routing beyond the coupled run are not modelled:
//    treat the numbers as a screening estimate, not a simulation.
//  * Differential pairs: per-piece coupling to the partner (edge gap on the same layer,
//    within the rule's gap max or 2× the gap), uncoupled runs against Max Uncoupled Length,
//    length and delay skew, and the phase (length) mismatch along the route: P's running
//    length minus N's running length at the nearest point of N.
//
// API (DOM-free):
//   AtriumSI.context(doc, defs, {project, revision, ...options}) -> ctx (cached per revision)
//   AtriumSI.analyzeNet(ctx | doc, net, options?) -> net result (segments, pieces, profile,
//       events, returns, crosstalk, diff)
//   AtriumSI.analyze(doc, defs, options) -> board result (nets, events, returns, crosstalk,
//       pairs, violations, stats); AtriumSI.steps(...) is the same as a generator (yields per net)
//   AtriumSI.kb(geom, w, s) / AtriumSI.crosstalk({kb, kf, length, v, rise}) / broadside(...)
//   AtriumSI.headless(args, host) (MCP si_analysis); AtriumSI.open(ctx) (dialog)
// Options: target (default 50 Ω) and diffTarget (100 Ω) with tolerance (10 %) for nets
//   without a profile; rise (ns, 0.5); returnRadius (1 mm); capRadius (5 mm); maxGap
//   (crosstalk search, edge gap mm; default 4 h clamped to 0.25..2 mm); maxCrosstalk (5 %);
//   antipad (1.0 mm beyond a via land); includePower (power/ground nets are skipped by default).
globalThis.AtriumSI = (() => {
  const EPS = 1e-9, C0 = 299.792458 /* mm/ns */, SIN_PAR = Math.sin(10 * Math.PI / 180);
  const COPPER = /^(Top|Bottom|Inner (?:[1-9]\d?|1[01]\d|12[0-6]))$/;
  // net-intent.js (isSupply) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const POWER_RE = /^(?:[ADPS]?GND\w*|GND\w*|VSS\w*|VCC\w*|VDD\w*|VEE\w*|VBUS\w*|VBAT\w*|VIN\w*|PWR\w*|[+-]?\d+V\d*\w*|[+-]?\d+(?:\.\d+)?V\w*|P\d+V\d*\w*|\+\w+)$/i;
  const POWER = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isSupply ? N.isSupply(String(n ?? "")) : POWER_RE.test(n); }};
  const DEFAULTS = Object.freeze({target: 50, diffTarget: 100, tolerance: 10, rise: .5, returnRadius: 1, capRadius: 5, maxGap: null, maxCrosstalk: 5, antipad: 1, minVoid: .05});
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const r4 = v => Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 + 0 : v;
  const r2 = v => Number.isFinite(v) ? Math.round(v * 100) / 100 + 0 : v;
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const I = () => globalThis.AtriumImpedance || fail("The impedance solver (impedance.js) is not loaded.");
  const S = () => globalThis.AtriumStackup || fail("The layer stack (stackup.js) is not loaded.");
  function fail(m) { throw Error(m); }
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const t = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return {d: Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy), t};
  }
  function inside(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }

  // ------------------------------------------------------------------ crosstalk models
  // Coupling coefficients of an edge-coupled geometry (AtriumImpedance geometry) at width w
  // and edge gap s: {kc: Cm/C, kl: Lm/L, kb, kf (per unit v: Cm/C − Lm/L), eeff, z0}.
  function kb(geom, w, s) {
    const r = I().solve({...geom, w, s: Math.max(s, 1e-3)});
    if (!r.ok) return null;
    const ze = r.zeven, zo = r.zodd, ee = r.eeffEven, eo = r.eeffOdd;
    const Ce = Math.sqrt(ee) / ze, Co = Math.sqrt(eo) / zo, Le = ze * Math.sqrt(ee), Lo = zo * Math.sqrt(eo);
    const kc = (Co - Ce) / (Co + Ce), kl = (Le - Lo) / (Le + Lo);
    return {kc, kl, kb: (kc + kl) / 4, kf: kc - kl, eeff: (ee + eo) / 2, z0: r.z0, zeven: ze, zodd: zo};
  }
  // Broadside (adjacent-layer) wire-over-plane estimate: heights of the strip centres above
  // their common nearest plane h1, h2; lateral centre offset d; widths w1, w2; thickness t.
  function broadside(w1, w2, t, h1, h2, d, er = 4.2) {
    const r1 = Math.max((w1 + t) / 4, 1e-3), r2 = Math.max((w2 + t) / 4, 1e-3);
    const L1 = Math.log(Math.max(2 * h1 / r1, 1.01)), L2 = Math.log(Math.max(2 * h2 / r2, 1.01));
    const Lm = .5 * Math.log((d * d + (h1 + h2) ** 2) / (d * d + (h1 - h2) ** 2 + 1e-12));
    const k = Math.min(.95, Lm / Math.sqrt(L1 * L2));
    return {kc: k, kl: k, kb: k / 2, kf: 0, eeff: er, model: "broadside"};
  }
  // NEXT and FEXT (fractions of the aggressor swing) for one coupled run.
  function crosstalk({kb: K, kf = 0, length, v, rise}) {
    const lsat = v * rise / 2, next = K * Math.min(1, length / lsat), fext = length / (2 * v * rise) * Math.abs(kf);
    return {next, fext, lsat, saturated: length >= lsat};
  }

  // ------------------------------------------------------------------ copper index
  // Reference copper of one layer: regions with rings (flat Float64Arrays, even-odd), edges
  // bucketed into horizontal bands for point and segment queries.
  function copperIndex(doc, defs, key, type, notes) {
    const regs = [], Pours = globalThis.AtriumPCBPours;
    const pours = (doc.pcbDrawing?.pours || []).filter(r => r.layer === key);
    const poured = new Set(pours.map(r => r.polygon).filter(v => v != null)), pourNets = new Set(pours.filter(r => r.polygon == null).map(r => r.net || ""));
    const flat = pts => { const a = new Float64Array(pts.length * 2); pts.forEach((p, i) => { a[2 * i] = +p[0]; a[2 * i + 1] = +p[1]; }); return a; };
    if (pours.length && Pours?.contours) for (const r of pours) { try { regs.push({net: r.net || "", rings: Pours.contours(r), source: "pour"}); } catch { /* unreadable region */ } }
    let assumed = 0;
    for (const i of doc.items || []) {
      if (i.layer !== key || !Array.isArray(i.points) || i.points.length < 3) continue;
      if (i.kind === "polygon") {
        if (i.cutout || i.shelved || i.keepout || poured.has(i.id) || pourNets.has(i.net || "")) continue;
        regs.push({net: i.net || "", rings: [flat(i.points)], source: "polygon"}); assumed++;
      } else if ((i.kind === "track" || i.kind === "graphic") && i.fill && i.closed !== false && !i.keepout) regs.push({net: i.net || "", rings: [flat(i.points)], source: "fill"});
    }
    if (assumed) notes?.add("Unpoured polygons on " + key + " are assumed solid; repour for exact voids.");
    if (!regs.length && type === "Plane" && Array.isArray(doc.outline) && doc.outline.length > 2) {
      regs.push({net: "(plane)", rings: [flat(doc.outline)], source: "plane"});
      notes?.add(key + " is a Plane layer without copper objects: assumed a solid plane.");
    }
    let n = 0;
    for (const g of regs) for (const r of g.rings) n += r.length / 2;
    const X1 = new Float64Array(n), Y1 = new Float64Array(n), X2 = new Float64Array(n), Y2 = new Float64Array(n), R = new Int32Array(n);
    let k = 0, y0 = Infinity, y1 = -Infinity;
    regs.forEach((g, ri) => {
      for (const r of g.rings) {
        const m = r.length / 2;
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          X1[k] = r[2 * i]; Y1[k] = r[2 * i + 1]; X2[k] = r[2 * j]; Y2[k] = r[2 * j + 1]; R[k] = ri;
          y0 = Math.min(y0, Y1[k]); y1 = Math.max(y1, Y1[k]); k++;
        }
      }
    });
    const nb = n ? Math.max(1, Math.min(4096, Math.ceil((y1 - y0) / .25))) : 0, H = nb ? Math.max((y1 - y0) / nb, 1e-6) : 1;
    const bandOf = y => Math.min(nb - 1, Math.max(0, Math.floor((y - y0) / H)));
    const count = new Int32Array(nb + 1);
    for (let e = 0; e < n; e++) { const a = bandOf(Math.min(Y1[e], Y2[e])), b = bandOf(Math.max(Y1[e], Y2[e])); for (let q = a; q <= b; q++) count[q + 1]++; }
    for (let q = 0; q < nb; q++) count[q + 1] += count[q];
    const list = new Int32Array(nb ? count[nb] : 0), fill = count.slice(0, nb);
    for (let e = 0; e < n; e++) { const a = bandOf(Math.min(Y1[e], Y2[e])), b = bandOf(Math.max(Y1[e], Y2[e])); for (let q = a; q <= b; q++) list[fill[q]++] = e; }
    const parity = new Uint8Array(regs.length), touched = [], stamp = new Uint32Array(n);
    let tick = 0;
    // Region index covering p, or -1 (void).
    function at(x, y) {
      if (!nb || y < y0 || y > y1) return -1;
      const q = bandOf(y);
      for (let k2 = count[q], end = count[q + 1]; k2 < end; k2++) {
        const e = list[k2];
        if ((Y1[e] > y) !== (Y2[e] > y) && x < X1[e] + (y - Y1[e]) * (X2[e] - X1[e]) / (Y2[e] - Y1[e])) { if (!parity[R[e]]) touched.push(R[e]); parity[R[e]] ^= 1; }
      }
      let best = -1;
      for (const r of touched) { if (parity[r] && (best < 0 || r < best)) best = r; parity[r] = 0; }
      touched.length = 0;
      return best;
    }
    // Parameters t in (0,1) where segment a-b crosses a copper edge.
    function cuts(ax, ay, bx, by, out) {
      if (!nb) return out;
      const lo = Math.min(ay, by), hi = Math.max(ay, by);
      if (hi < y0 || lo > y1) return out;
      if (++tick === 0xffffffff) { stamp.fill(0); tick = 1; }
      const dx = bx - ax, dy = by - ay;
      for (let q = bandOf(lo), qe = bandOf(hi); q <= qe; q++) for (let k2 = count[q], end = count[q + 1]; k2 < end; k2++) {
        const e = list[k2];
        if (stamp[e] === tick) continue;
        stamp[e] = tick;
        const ex = X2[e] - X1[e], ey = Y2[e] - Y1[e], den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-15) continue;
        const wx = X1[e] - ax, wy = Y1[e] - ay, t = (wx * ey - wy * ex) / den, u = (wx * dy - wy * dx) / den;
        if (t > 1e-9 && t < 1 - 1e-9 && u >= -1e-12 && u <= 1 + 1e-12) out.push(t);
      }
      return out;
    }
    return {key, regions: regs.length, edges: n, at, cuts, net: r => r >= 0 ? regs[r].net : null, empty: !regs.length};
  }

  // ------------------------------------------------------------------ context
  const contexts = new WeakMap();
  function context(doc, defs = new Map(), options = {}) {
    if (doc?.kind !== "pcb") fail("Choose a PCB layout for the signal integrity analysis.");
    const sig = options.revision != null ? "r" + options.revision : null;
    const cached = sig && contexts.get(doc);
    if (cached && cached.sig === sig && cached.project === options.project) { cached.opts = {...DEFAULTS, ...clean(options)}; return cached; }
    const span = globalThis.AtriumDiagnostics?.performance?.begin("analysis", "build");
    return span ? span.run(buildContext, doc, defs, options, sig) : buildContext(doc, defs, options, sig);
  }
  function buildContext(doc, defs, options, sig) {
    const t0 = now(), St = S(), stack = St.get(doc, defs), notes = new Set();
    const keys = stack.layers.filter(St.isCopper).map(l => l.key), order = new Map(keys.map((k, i) => [k, i]));
    const typeOf = new Map(stack.layers.filter(St.isCopper).map(l => [l.key, l.type]));
    // z (top surface) and thickness per copper key on the main stack.
    const zOf = new Map();
    { let z = 0; for (const l of stack.layers) { if (l.key && St.isCopper(l)) zOf.set(l.key, {z, t: l.thickness}); z += l.thickness || 0; } }
    const subs = new Map(St.substacks(stack).map(s => [s.id, s]));
    let regions = null;
    try { const R = globalThis.AtriumRigidFlex?.regionsResolved?.(doc, defs); if (R?.split) regions = R; } catch { regions = null; }
    let q = null, pairs = [];
    try { q = globalThis.AtriumRules?.resolver?.(doc, {project: options.project}) || null; } catch { q = null; }
    try { pairs = globalThis.AtriumRules?.diffPairs?.(doc, {project: options.project}) || []; } catch { pairs = []; }
    const pairOf = new Map();
    for (const p of pairs) if (p.positive && p.negative) { pairOf.set(p.positive, {name: p.name, role: "P", mate: p.negative}); pairOf.set(p.negative, {name: p.name, role: "N", mate: p.positive}); }
    // Board objects: segments per net, vias, plated holes and capacitors.
    const segs = [], byNet = new Map(), vias = [], holes = [], caps = [];
    const spanOf = (a, b) => { const i = order.get(a), j = order.get(b); return i == null || j == null ? [0, keys.length - 1] : [Math.min(i, j), Math.max(i, j)]; };
    const A = globalThis.Atrium;
    for (const i of doc.items || []) {
      if (i.kind === "track" && COPPER.test(i.layer || "Top") && Array.isArray(i.points) && !i.fill && !i.keepout && order.has(i.layer || "Top")) {
        const net = i.net || "";
        if (!net) continue;
        for (let k = 1; k < i.points.length; k++) {
          const a = i.points[k - 1], b = i.points[k], len = dist(a, b);
          if (!(len > EPS)) continue;
          const s = {n: segs.length, id: i.id, net, layer: i.layer || "Top", w: +i.width || .15, a, b, len};
          segs.push(s);
          if (!byNet.has(net)) byNet.set(net, []);
          byNet.get(net).push(s);
        }
      } else if (i.kind === "via" && Number.isFinite(i.x)) {
        const v = {id: i.id, net: i.net || "", at: [i.x, i.y], r: (+i.diameter || .6) / 2, span: (!i.fromLayer && !i.toLayer) ? [0, keys.length - 1] : spanOf(i.fromLayer, i.toLayer)};
        vias.push(v); holes.push(v);
      } else if (i.kind === "pad" && i.drill > 0 && i.plated !== false && Number.isFinite(i.x)) holes.push({id: i.id, net: i.net || "", at: [i.x, i.y], r: Math.max(+i.w || 0, +i.h || 0, +i.diameter || 0) / 2, span: [0, keys.length - 1]});
      else if (i.kind === "part") {
        const fp = defs?.get?.(i.def)?.footprint;
        if (/^C\d/i.test(i.ref || "") && i.pinNets) caps.push({id: i.id, ref: i.ref, at: [i.x, i.y], nets: new Set(Object.values(i.pinNets).filter(Boolean))});
        if (fp && A?.world) for (const p of fp.pads || []) if (p.drill > 0 && p.plated !== false) {
          const net = own(i.pinNets, p.number) ? i.pinNets[p.number] : "";
          if (net) holes.push({id: i.id, net, at: A.world([p.x, p.y], i), r: Math.max(+p.w || 0, +p.h || 0, +p.diameter || 0) / 2, span: [0, keys.length - 1], pad: p.number});
        }
      }
    }
    // Grid of segments for neighbour queries (crosstalk, partner search).
    const CELL = 2, grid = new Map(), cellKey = (cx, cy) => cx * 73856093 ^ cy * 19349663;
    for (const s of segs) {
      const x0 = Math.floor((Math.min(s.a[0], s.b[0]) - s.w) / CELL), x1 = Math.floor((Math.max(s.a[0], s.b[0]) + s.w) / CELL);
      const y0 = Math.floor((Math.min(s.a[1], s.b[1]) - s.w) / CELL), y1 = Math.floor((Math.max(s.a[1], s.b[1]) + s.w) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) { const k = cellKey(cx, cy); let c = grid.get(k); if (!c) grid.set(k, c = []); c.push(s); }
    }
    const stampNear = new Uint32Array(segs.length); let tickNear = 0;
    function near(a, b, m, visit) {
      if (++tickNear === 0xffffffff) { stampNear.fill(0); tickNear = 1; }
      const x0 = Math.floor((Math.min(a[0], b[0]) - m) / CELL), x1 = Math.floor((Math.max(a[0], b[0]) + m) / CELL);
      const y0 = Math.floor((Math.min(a[1], b[1]) - m) / CELL), y1 = Math.floor((Math.max(a[1], b[1]) + m) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const s of grid.get(cellKey(cx, cy)) || []) {
        if (stampNear[s.n] === tickNear) continue;
        stampNear[s.n] = tickNear; visit(s);
      }
    }
    const holeGrid = new Map();
    for (const h of holes) { const k = cellKey(Math.floor(h.at[0] / CELL), Math.floor(h.at[1] / CELL)); if (!holeGrid.has(k)) holeGrid.set(k, []); holeGrid.get(k).push(h); }
    function holesNear(p, r, visit) {
      const x0 = Math.floor((p[0] - r) / CELL), x1 = Math.floor((p[0] + r) / CELL), y0 = Math.floor((p[1] - r) / CELL), y1 = Math.floor((p[1] + r) / CELL);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) for (const h of holeGrid.get(cellKey(cx, cy)) || []) visit(h);
    }
    const copper = new Map();
    const layer = key => { if (!copper.has(key)) copper.set(key, copperIndex(doc, defs, key, typeOf.get(key), notes)); return copper.get(key); };
    // A Supply Nets rule explicitly declares a voltage for SI. Never infer a board power rail from it.
    const hasSupplies = globalThis.AtriumRules?.stored(doc,options.project)?.list?.some(r=>r.type==="supplyNets"&&r.enabled);
    const supply = net => hasSupplies ? memo(ctx,"supply/"+net,()=>q?.("supplyNets",{net})??null) : null;
    const ctx = {sig, project: options.project, doc, defs, supply, stack, keys, order, typeOf, zOf, subs, regions, q, pairs, pairOf, segs, byNet, vias, holes, caps,
      near, holesNear, layer, notes, cache: new Map(), nets: new Map(), opts: {...DEFAULTS, ...clean(options)}, built: now() - t0};
    if (!segs.length) notes.add("The board has no routed tracks on nets.");
    if (sig) contexts.set(doc, ctx);
    return ctx;
  }
  function clean(o) {
    const out = {};
    for (const k of Object.keys(DEFAULTS)) if (o[k] !== undefined && o[k] !== null && o[k] !== "") out[k] = +o[k];
    if (o.target === null) out.target = null;
    if (o.diffTarget === null) out.diffTarget = null;
    return out;
  }
  const memo = (ctx, k, f) => { if (ctx.cache.has(k)) return ctx.cache.get(k); const v = f(); ctx.cache.set(k, v); return v; };

  // ------------------------------------------------------------------ stack / impedance helpers
  const subOf = (ctx, id) => ctx.subs.get(id || "main") || ctx.subs.get("main");
  // Constraint for a net on a layer and substack: {target, tolerance, profile, diff, source}.
  function targetFor(ctx, net, key, stack) {
    return memo(ctx, "t\u0001" + net + "\u0001" + key + "\u0001" + (stack || ""), () => {
      const pair = ctx.pairOf.get(net), o = ctx.opts;
      let c = null;
      try { c = pair ? ctx.q?.("diffPairsRouting", {pairName: pair.name, layer: key, stack: stack || undefined}) : ctx.q?.("width", {net, layer: key, stack: stack || undefined}); } catch { c = null; }
      if (c?.impedance) return {target: c.impedance.target, tolerance: c.impedance.tolerance, profile: c.impedance.profile, diff: !!pair, source: "profile", gapMax: c.gapMax ?? null, gap: c.impedance.gap ?? null, maxUncoupled: c.maxUncoupled ?? null};
      const t = pair ? o.diffTarget : o.target;
      return {target: Number.isFinite(t) && t > 0 ? t : null, tolerance: o.tolerance, profile: null, diff: !!pair, source: Number.isFinite(t) && t > 0 ? "default" : "none",
        gapMax: c?.gapMax ?? null, gap: c?.gapPreferred ?? c?.gapMin ?? null, maxUncoupled: c?.maxUncoupled ?? null};
    });
  }
  // Nominal references [up, down] of a layer (the profile's, else the neighbouring copper).
  function nominalRefs(ctx, key, stack, profile) {
    return memo(ctx, "r\u0001" + key + "\u0001" + (stack || "") + "\u0001" + (profile || ""), () => {
      if (profile) { try { const p = S().profileValues(ctx.doc, profile, key, ctx.defs, stack || undefined); if (p && !p.error && p.geometry) return {refs: [p.geometry.refTop, p.geometry.refBottom], geom: p.geom}; } catch { /* stack */ } }
      const g = I().geometry(subOf(ctx, stack).layers, key);
      return {refs: g ? [g.refTop, g.refBottom] : [null, null], geom: null};
    });
  }
  // Solve one piece: {z, model, delay, eeff, structure} or {z:null, model}.
  function solvePiece(ctx, key, stack, up, down, w, gap, nominal) {
    const k = ["z", key, stack || "", up || "", down || "", r4(w), gap == null ? "" : r4(gap), nominal?.geom ? "p" : ""].join("\u0001");
    return memo(ctx, k, () => {
      const layers = subOf(ctx, stack).layers;
      let g = I().geometry(layers, key, [up, down]);
      if (!g || g.structure === "none") return {z: null, model: "no reference"};
      const geom = {structure: g.structure, t: g.t, er: g.er, tanD: g.tanD, h: g.h, h1: g.h1, h2: g.h2, cover: g.cover};
      const base = nominal?.geom;
      if (base && up === nominal.refs[0] && down === nominal.refs[1]) { geom.etch = base.etch || 0; if (base.g > 0) geom.g = base.g; }
      if (gap != null) geom.s = Math.max(gap, .005);
      const r = I().solve({...geom, w});
      if (!r.ok) return {z: null, model: r.error || "outside the model"};
      return {z: gap != null ? r.zdiff : r.z0 ?? r.z, z0: r.z0, model: r.model, delay: r.delay, eeff: r.eeff, structure: g.structure, h: g.structure === "stripline" ? Math.min(g.h1, g.h2) : g.h, geom};
    });
  }
  // Pieces of a segment by rigid-flex region.
  function regionPieces(ctx, s) {
    if (!ctx.regions) return [{a: s.a, b: s.b, stack: null}];
    let p = null;
    try { p = globalThis.AtriumRigidFlex.piecesAlong(ctx.doc, [s.a, s.b], ctx.defs); } catch { p = null; }
    return p?.length ? p.map(x => ({a: x.a, b: x.b, stack: x.stack === "main" ? null : x.stack})) : [{a: s.a, b: s.b, stack: null}];
  }
  // Split a nominal piece where the centre-line fallback changes on either side.
  function referencePieces(ctx, piece, a, b) {
    const layers = subOf(ctx, piece.stack).layers.filter(l => l.key).map(l => l.key);
    const nominal = [piece.up, piece.down];
    const ts = [0, 1], mid = lerp(a, b, .5);
    const candidates = nominal.map((side, i) => {
      if (side.status !== "void") return [];
      const dir = i ? 1 : -1, out = [];
      for (let j = layers.indexOf(side.layer) + dir; j >= 0 && j < layers.length; j += dir) {
        const C = ctx.layer(layers[j]);
        if (C.empty) continue;
        const count = ts.length;
        C.cuts(a[0], a[1], b[0], b[1], ts);
        if (ts.length > count) out.push(C);
        else if (C.at(mid[0], mid[1]) >= 0) {
          // This layer covers every remaining interval. Farther layers cannot win.
          out.push(C);
          break;
        }
      }
      return out;
    });
    ts.sort((x, y) => x - y);
    const pieces = [];
    for (let i = 1; i < ts.length; i++) {
      const t0 = ts[i - 1], t1 = ts[i];
      if (t1 - t0 < 1e-7) continue;
      const mid = lerp(a, b, (t0 + t1) / 2);
      const refs = nominal.map((side, j) => side.status === "void"
        ? candidates[j].find(C => C.at(mid[0], mid[1]) >= 0)?.key ?? null : side.layer);
      const last = pieces.at(-1);
      if (last && last.refs[0] === refs[0] && last.refs[1] === refs[1]) last.t1 = t1;
      else pieces.push({t0, t1, refs});
    }
    return pieces;
  }

  // ------------------------------------------------------------------ one segment
  // Partner (diff-pair mate) gap at a point: edge gap to the nearest parallel mate segment on
  // the same layer, or null.
  function mateGap(ctx, s, p, mate, limit) {
    let best = null;
    const ux = (s.b[0] - s.a[0]) / s.len, uy = (s.b[1] - s.a[1]) / s.len;
    ctx.near(p, p, limit + s.w + 1, o => {
      if (o.net !== mate || o.layer !== s.layer) return;
      const vx = (o.b[0] - o.a[0]) / o.len, vy = (o.b[1] - o.a[1]) / o.len;
      if (Math.abs(ux * vy - uy * vx) > SIN_PAR) return;
      const g = segDist(p, o.a, o.b).d - (s.w + o.w) / 2;
      if (best == null || g < best) best = g;
    });
    return best;
  }
  function analyzeSegment(ctx, s, endHoles) {
    const o = ctx.opts, pair = ctx.pairOf.get(s.net), out = [];
    for (const rp of regionPieces(ctx, s)) {
      const T = targetFor(ctx, s.net, s.layer, rp.stack), nom = nominalRefs(ctx, s.layer, rp.stack, T.profile), [up, down] = nom.refs;
      const ax = rp.a[0], ay = rp.a[1], bx = rp.b[0], by = rp.b[1], L = dist(rp.a, rp.b);
      if (!(L > EPS)) continue;
      const nx = -(by - ay) / L * s.w / 2, ny = (bx - ax) / L * s.w / 2;
      const lines = [[ax, ay, bx, by], [ax + nx, ay + ny, bx + nx, by + ny], [ax - nx, ay - ny, bx - nx, by - ny]];
      const sides = [up, down].map(k => k ? ctx.layer(k) : null), ts = [0, 1];
      for (const C of sides) if (C && !C.empty) for (const l of lines) C.cuts(l[0], l[1], l[2], l[3], ts);
      // Diff pairs: cut where the mate's segments start and end, so coupling is per piece.
      if (pair) {
        const lim = T.gapMax ?? (T.gap ? 2 * T.gap : .5), ux = (bx - ax) / L, uy = (by - ay) / L;
        ctx.near(rp.a, rp.b, lim + s.w + 1, m => {
          if (m.net !== pair.mate || m.layer !== s.layer) return;
          for (const q of [m.a, m.b]) { const t = ((q[0] - ax) * ux + (q[1] - ay) * uy) / L; if (t > 1e-6 && t < 1 - 1e-6) ts.push(t); }
        });
      }
      ts.sort((x, y) => x - y);
      let last = null;
      for (let k = 1; k < ts.length; k++) {
        if (ts[k] - ts[k - 1] < 1e-7) continue;
        const tm = (ts[k] + ts[k - 1]) / 2, state = sides.map(C => {
          if (!C) return {status: "none", net: null};
          const n = lines.map(l => C.net(C.at(l[0] + (l[2] - l[0]) * tm, l[1] + (l[3] - l[1]) * tm)));
          if (n[0] == null) return {status: "void", net: null};
          if (n[1] == null || n[2] == null) return {status: "partial", net: n[0]};
          return n[1] === n[0] && n[2] === n[0] ? {status: "ok", net: n[0]} : {status: "split", net: n[0]};
        });
        let gap = null, coupled = null;
        if (pair) {
          const lim = T.gapMax ?? (T.gap ? 2 * T.gap : .5), g = mateGap(ctx, s, [ax + (bx - ax) * tm, ay + (by - ay) * tm], pair.mate, lim);
          coupled = g != null && g <= lim + EPS;
          if (coupled) gap = Math.max(g, .005);
        }
        const sigk = state.map(x => x.status + ":" + x.net).join("|") + "|" + coupled + ":" + (gap == null ? "" : r4(gap));
        if (last && last.sigk === sigk) { last.t1 = ts[k]; continue; }
        out.push(last = {sigk, t0: ts[k - 1], t1: ts[k], up: {layer: up, ...state[0]}, down: {layer: down, ...state[1]}, stack: rp.stack, T, nom, ra: rp.a, rb: rp.b, gap, coupled});
      }
    }
    // Finish pieces: geometry, antipads, references used, impedance and deviation.
    const pieces = [];
    for (const p of out) {
      const a = lerp(p.ra, p.rb, p.t0), b = lerp(p.ra, p.rb, p.t1);
      // Antipad: a void within the clearance of a via or plated hole of this net at a segment end.
      const voidSide = [p.up, p.down].some(x => x.status === "void" || x.status === "partial");
      let antipad = false;
      if (voidSide) for (const h of endHoles) { const r = h.r + o.antipad; if (dist(a, h.at) <= r + EPS && dist(b, h.at) <= r + EPS) { antipad = true; break; } }
      const {gap, coupled} = p;
      const hasFallback = p.up.status === "void" || p.down.status === "void";
      const spans = hasFallback ? referencePieces(ctx, p, a, b) : [{t0: 0, t1: 1, refs: [p.up.layer, p.down.layer]}];
      // Keep nominal continuity findings on the original span when its impedance is subdivided.
      const referenceSpan = spans.length > 1 ? {a, b, len: dist(a, b)} : undefined;
      for (const span of spans) {
        const start = span.t0 === 0 ? a : lerp(a, b, span.t0), end = span.t1 === 1 ? b : lerp(a, b, span.t1);
        const zr = solvePiece(ctx, s.layer, p.stack, span.refs[0], span.refs[1], s.w, gap, p.nom);
        // An uncoupled diff piece: Zdiff ≈ 2 Z0.
        let z = zr.z;
        if (pair && !coupled && z != null) z = 2 * z;
        const target = p.T.target, dev = z != null && target ? (z - target) / target * 100 : null;
        let status = "ok";
        if (z == null) status = "nomodel";
        else if (antipad) status = "antipad";
        else if (dev != null && Math.abs(dev) > p.T.tolerance + 1e-9) status = Math.abs(dev) > 2 * p.T.tolerance ? "fail" : "warn";
        else if (dev == null) status = "info";
        pieces.push({id: s.id, a: start, b: end, len: dist(start, end), referenceSpan, stack: p.stack, up: p.up, down: p.down, refs: span.refs, z, model: zr.model, delay: zr.delay ?? null, target, tolerance: p.T.tolerance, source: p.T.source,
          profile: p.T.profile, dev, status, antipad, coupled, gap});
      }
    }
    return pieces;
  }

  // ------------------------------------------------------------------ net walk
  // Segments of a net in walking order (depth first from an end), with running distance.
  // start: prefer the end nearest this point.
  function walk(segs, start = null) {
    const keyOf = p => Math.round(p[0] * 1e3) + "," + Math.round(p[1] * 1e3), adj = new Map(), pos = new Map();
    for (const s of segs) for (const [e, p] of [[0, s.a], [1, s.b]]) { const k = keyOf(p); if (!adj.has(k)) { adj.set(k, []); pos.set(k, p); } adj.get(k).push([s, e]); }
    const seen = new Set(), order = [];
    let d = 0;
    const far = k => start ? dist(pos.get(k), start) : 0;
    const ends = [...adj.entries()].sort((x, y) => (x[1].length > 1) - (y[1].length > 1) || far(x[0]) - far(y[0]) || x[1].length - y[1].length || (x[0] < y[0] ? -1 : 1));
    for (const [startKey] of ends) {
      const stack = [startKey];
      while (stack.length) {
        const k = stack.pop();
        for (const [s, e] of adj.get(k) || []) {
          if (seen.has(s)) continue;
          seen.add(s);
          const fwd = e === 0, from = fwd ? s.a : s.b, to = fwd ? s.b : s.a;
          order.push({s, from, to, d0: d, d1: d + s.len, fwd});
          d += s.len;
          stack.push(keyOf(to));
        }
      }
    }
    return order;
  }

  // ------------------------------------------------------------------ return path
  // HDI via chains: blind/buried vias of one net whose spans meet on a layer, either stacked
  // (same place) or staggered (offset, joined by a track of the net on the shared layer). A chain
  // is one layer change from its top to its bottom layer, checked once (viastack.js stacks).
  const STAGGER_REACH = 2.5;
  function hdiChains(ctx, net, segs) {
    const last = ctx.keys.length - 1, out = new Map();
    const vs = ctx.vias.filter(v => v.net === net && !(v.span[0] === 0 && v.span[1] === last));
    if (vs.length < 2 || vs.length > 400) return out;
    const tracksAt = (v, li) => { const ids = new Set(); for (const s of segs) if (ctx.order.get(s.layer) === li && Math.min(dist(s.a, v.at), dist(s.b, v.at)) <= v.r + s.w / 2 + 1e-3) ids.add(s.id); return ids; };
    const up = vs.map((_, i) => i), find = i => { while (up[i] !== i) i = up[i] = up[up[i]]; return i; }, staggered = new Set();
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
      const u = vs[i], w = vs[j], li = u.span[1] === w.span[0] ? u.span[1] : w.span[1] === u.span[0] ? u.span[0] : -1;
      if (li < 0) continue;
      const d = dist(u.at, w.at);
      if (d <= Math.max(u.r, w.r) + 1e-3) { up[find(i)] = find(j); continue; }
      if (d > STAGGER_REACH) continue;
      const a = tracksAt(u, li), b = tracksAt(w, li);
      if ([...a].some(x => b.has(x))) { up[find(i)] = find(j); staggered.add(i); staggered.add(j); }
    }
    const groups = new Map();
    vs.forEach((v, i) => { const k = find(i); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(i); });
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const list = g.map(i => vs[i]).sort((p, q) => p.span[0] - q.span[0] || p.span[1] - q.span[1]);
      const ch = {vias: list, head: list[0], lo: Math.min(...list.map(x => x.span[0])), hi: Math.max(...list.map(x => x.span[1])), kind: g.some(i => staggered.has(i)) ? "staggered" : "stacked"};
      for (const v of list) out.set(v, ch);
    }
    return out;
  }
  // A return path through partial-span vias of the reference net near `at`: stacked or staggered
  // microvias whose spans join from layer lo to hi, each within the radius. {d, id, at, chain} or null.
  function refChain(ctx, at, radius, net, lo, hi) {
    const cand = [];
    ctx.holesNear(at, radius, h => { if (h.net === net && h.span[1] > h.span[0] && dist(h.at, at) <= radius + EPS && h.span[1] >= lo && h.span[0] <= hi) cand.push(h); });
    if (cand.length < 2) return null;
    cand.sort((p, q) => p.span[0] - q.span[0] || q.span[1] - p.span[1]);
    let reach = lo, used = [], kind = "stacked";
    while (reach < hi) {
      let next = null;
      for (const h of cand) if (h.span[0] <= reach && h.span[1] > reach && (!used.length || dist(h.at, used.at(-1).at) <= STAGGER_REACH) && (!next || h.span[1] > next.span[1] || h.span[1] === next.span[1] && dist(h.at, at) < dist(next.at, at))) next = h;
      if (!next) return null;
      if (used.length && dist(next.at, used.at(-1).at) > Math.max(next.r, used.at(-1).r) + 1e-3) kind = "staggered";
      used.push(next); reach = next.span[1];
    }
    if (used.length < 2 || used[0].span[0] > lo) return null;
    const d = Math.max(...used.map(h => dist(h.at, at)));
    return {d, id: used[0].id, at: used[0].at, chain: {kind, vias: used.map(h => h.id)}};
  }
  function returnPaths(ctx, net, results) {
    const o = ctx.opts, out = [], segs = ctx.byNet.get(net) || [], chains = hdiChains(ctx, net, segs);
    for (const v of ctx.vias) {
      if (v.net !== net) continue;
      const ch = chains.get(v);
      if (ch && ch.head !== v) continue; // a stacked or staggered chain is one layer change, checked at its first via
      const touching = new Map();
      for (const m of ch ? ch.vias : [v]) for (const s of segs) {
        if (ch) { const li = ctx.order.get(s.layer); if (li > ch.lo && li < ch.hi) continue; } // the chain's own jogs
        const da = dist(s.a, m.at), db = dist(s.b, m.at);
        if (Math.min(da, db) <= m.r + s.w / 2 + 1e-3) { const e = da <= db ? 0 : 1; if (!touching.has(s.layer)) touching.set(s.layer, {s, e, m}); }
      }
      if (touching.size < 2) continue;
      const refsAt = ({s, e, m = v}) => {
        const pieces = results.get(s) || [], list = e === 0 ? pieces : [...pieces].reverse(), set = [];
        for (const p of list) {
          if (dist(e === 0 ? p.a : p.b, m.at) > 2.5) break;
          if (p.antipad) continue;
          for (const x of [p.up, p.down]) if (x.layer && x.status !== "void" && x.net != null) set.push({layer: x.layer, net: x.net});
          if (set.length) break;
        }
        return set;
      };
      const layers = [...touching.keys()];
      for (let i = 0; i < layers.length; i++) for (let j = i + 1; j < layers.length; j++) {
        const A = refsAt(touching.get(layers[i])), B = refsAt(touching.get(layers[j]));
        const row = {via: v.id, net, at: v.at, from: layers[i], to: layers[j], refsFrom: A, refsTo: B, status: "ok", kind: null, distance: null, by: null, ...(ch ? {chain: {kind: ch.kind, vias: ch.vias.map(x => x.id)}} : {})};
        if (!A.length || !B.length) { row.status = "warn"; row.kind = "no-reference"; out.push(row); continue; }
        if (A.some(a => B.some(b => a.layer === b.layer && a.net === b.net))) { row.kind = "shared"; out.push(row); continue; }
        // Same net on different layers: a stitching via spanning both, nearest within the radius.
        let best = null;
        for (const a of A) for (const b of B) {
          if (a.net !== b.net || !a.net || a.net === "(plane)") continue;
          const ia = ctx.order.get(a.layer), ib = ctx.order.get(b.layer), lo = Math.min(ia, ib), hi = Math.max(ia, ib);
          ctx.holesNear(v.at, o.returnRadius, h => {
            if (h.net !== a.net || h.span[0] > lo || h.span[1] < hi) return;
            const d = dist(h.at, v.at);
            if (d <= o.returnRadius + EPS && (!best || d < best.d)) best = {d, id: h.id, at: h.at, net: a.net};
          });
        }
        // Partial-span return vias: a stacked or staggered chain of the reference net that joins both planes.
        if (!best) for (const a of A) for (const b of B) {
          if (best || a.net !== b.net || !a.net || a.net === "(plane)") continue;
          const ia = ctx.order.get(a.layer), ib = ctx.order.get(b.layer), c = refChain(ctx, v.at, o.returnRadius, a.net, Math.min(ia, ib), Math.max(ia, ib));
          if (c) best = {...c, net: a.net};
        }
        if (best) { row.kind = "via"; row.distance = r4(best.d); row.by = best.id; row.byAt = best.at; if (best.chain) row.byChain = best.chain; out.push(row); continue; }
        const sameNet = A.some(a => B.some(b => a.net === b.net));
        if (sameNet) { row.status = "fail"; row.kind = "missing-via"; out.push(row); continue; }
        // Different reference nets: a stitching capacitor between them nearby.
        let cap = null;
        for (const c of ctx.caps) for (const a of A) for (const b of B) {
          if (!c.nets.has(a.net) || !c.nets.has(b.net)) continue;
          const d = dist(c.at, v.at);
          if (d <= o.capRadius + EPS && (!cap || d < cap.d)) cap = {d, id: c.id, ref: c.ref, at: c.at};
        }
        if (cap) { row.kind = "capacitor"; row.distance = r4(cap.d); row.by = cap.ref; row.byAt = cap.at; }
        else { row.status = "fail"; row.kind = "net-change"; }
        out.push(row);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ crosstalk
  function maxGapFor(ctx, key) {
    if (ctx.opts.maxGap > 0) return ctx.opts.maxGap;
    return memo(ctx, "mg\u0001" + key, () => {
      const nom = nominalRefs(ctx, key, null, null), z = solvePiece(ctx, key, null, nom.refs[0], nom.refs[1], .15, null, nom);
      return Math.max(.25, Math.min(2, 4 * (z.h || .2)));
    });
  }
  function coupling(ctx, key, w, gap) {
    return memo(ctx, "k\u0001" + key + "\u0001" + r4(w) + "\u0001" + Math.round(gap * 200), () => {
      const nom = nominalRefs(ctx, key, null, null), z = solvePiece(ctx, key, null, nom.refs[0], nom.refs[1], w, null, nom);
      return z.geom ? kb(z.geom, w, Math.round(gap * 200) / 200) : null;
    });
  }
  function broadsideFor(ctx, s, o, d) {
    const za = ctx.zOf.get(s.layer), zb = ctx.zOf.get(o.layer);
    if (!za || !zb) return null;
    const ca = za.z + za.t / 2, cb = zb.z + zb.t / 2, ia = ctx.order.get(s.layer), ib = ctx.order.get(o.layer);
    // The common nearest plane: the copper layer beyond the pair on the side closer to it.
    const lo = Math.min(ia, ib), hi = Math.max(ia, ib), above = lo > 0 ? ctx.zOf.get(ctx.keys[lo - 1]) : null, below = hi < ctx.keys.length - 1 ? ctx.zOf.get(ctx.keys[hi + 1]) : null;
    const hAbove = above ? [ca - (above.z + above.t), cb - (above.z + above.t)] : null, hBelow = below ? [below.z - ca, below.z - cb] : null;
    const h = hAbove && hBelow ? (Math.max(...hAbove) <= Math.max(...hBelow) ? hAbove : hBelow) : hAbove || hBelow;
    if (!h) return null;
    return broadside(s.w, o.w, za.t, Math.abs(h[0]), Math.abs(h[1]), d);
  }
  function crosstalkFor(ctx, net, mateNet) {
    const o = ctx.opts, segs = ctx.byNet.get(net) || [], agg = new Map();
    for (const s of segs) {
      const ia = ctx.order.get(s.layer), mg = maxGapFor(ctx, s.layer);
      const ux = (s.b[0] - s.a[0]) / s.len, uy = (s.b[1] - s.a[1]) / s.len;
      ctx.near(s.a, s.b, mg + s.w + 1, t => {
        if (t.net === net || t.net === mateNet) return;
        const ib = ctx.order.get(t.layer), dz = Math.abs(ia - ib);
        if (dz > 1) return;
        const vx = (t.b[0] - t.a[0]) / t.len, vy = (t.b[1] - t.a[1]) / t.len;
        if (Math.abs(ux * vy - uy * vx) > SIN_PAR) return;
        // Overlap of t's projection on s, and the mean perpendicular centre distance.
        const pa = (t.a[0] - s.a[0]) * ux + (t.a[1] - s.a[1]) * uy, pb = (t.b[0] - s.a[0]) * ux + (t.b[1] - s.a[1]) * uy;
        const lo = Math.max(0, Math.min(pa, pb)), hi = Math.min(s.len, Math.max(pa, pb)), Lc = hi - lo;
        if (Lc < .05) return;
        const da = (t.a[0] - s.a[0]) * -uy + (t.a[1] - s.a[1]) * ux, db = (t.b[0] - s.a[0]) * -uy + (t.b[1] - s.a[1]) * ux;
        const d = Math.abs((da + db) / 2), gap = d - (s.w + t.w) / 2;
        let k = null;
        if (dz === 0) { if (gap > mg || gap < -EPS) return; k = coupling(ctx, s.layer, (s.w + t.w) / 2, Math.max(gap, .01)); }
        else { if (d - t.w / 2 - s.w / 2 > mg) return; k = broadsideFor(ctx, s, t, d); }
        if (!k) return;
        const v = C0 / Math.sqrt(k.eeff), x = crosstalk({kb: k.kb, kf: k.kf, length: Lc, v, rise: o.rise});
        const key = t.net + "\u0001" + (dz ? "adjacent" : "same");
        let e = agg.get(key);
        if (!e) agg.set(key, e = {victim: net, aggressor: t.net, relation: dz ? "adjacent" : "same", length: 0, minGap: Infinity, kbMax: 0, sum: 0, fext: 0, stretches: [], layers: new Set()});
        e.length += Lc; e.minGap = Math.min(e.minGap, Math.max(0, gap)); e.kbMax = Math.max(e.kbMax, k.kb);
        e.sum += k.kb * Math.min(1, Lc / x.lsat); e.fext += x.fext; e.layers.add(s.layer + (dz ? "/" + t.layer : ""));
        if (e.stretches.length < 200) e.stretches.push({a: lerp(s.a, s.b, lo / s.len), b: lerp(s.a, s.b, hi / s.len), w: s.w, kb: k.kb, gap: Math.max(0, gap), layer: s.layer});
      });
    }
    return [...agg.values()].map(e => {
      const next = Math.min(e.kbMax, e.sum);
      return {victim: e.victim, aggressor: e.aggressor, relation: e.relation, layers: [...e.layers], length: r4(e.length), minGap: r4(e.minGap), kb: e.kbMax,
        next, fext: e.fext, nextPct: r2(next * 100), fextPct: r2(e.fext * 100), status: next * 100 > o.maxCrosstalk ? "warn" : "ok", stretches: e.stretches, estimate: true};
    }).sort((a, b) => b.next - a.next);
  }

  // ------------------------------------------------------------------ diff pairs
  function diffPairOf(ctx, name, results) {
    const p = ctx.pairs.find(x => x.name === name);
    if (!p) return null;
    const P = ctx.byNet.get(p.positive) || [], N = ctx.byNet.get(p.negative) || [];
    const T = targetFor(ctx, p.positive, (P[0] || N[0])?.layer || "Top", null);
    const len = list => list.reduce((s, x) => s + x.len, 0);
    const delayOf = list => list.reduce((sum, s) => sum + (results.get(s) || []).reduce((q, x) => q + x.len * (x.delay ?? 0), 0), 0);
    // Uncoupled runs, merged along each net's walk.
    const runs = [];
    let uncP = 0, uncN = 0;
    for (const [list, role] of [[P, "P"], [N, "N"]]) {
      let cur = null;
      for (const w of walk(list)) for (const x of w.fwd ? results.get(w.s) || [] : [...(results.get(w.s) || [])].reverse()) {
        if (x.coupled === false) {
          const a = w.fwd ? x.a : x.b, b = w.fwd ? x.b : x.a;
          if (cur && dist(cur.b, a) < 1e-3) { cur.b = b; cur.length += x.len; cur.points.push(b); } else runs.push(cur = {role, a, b, length: x.len, points: [a, b], layer: w.s.layer});
          if (role === "P") uncP += x.len; else uncN += x.len;
        } else cur = null;
      }
    }
    // Phase: running length of P minus N's at its nearest point.
    const wp = walk(P), wn = N.length ? [1] : [], phase = [];
    if (wp.length && wn.length) {
      const wn2 = walk(N, wp[0].from);
      for (const w of wp) {
        for (const tp of [0, 1]) {
          const pt = tp ? w.to : w.from, dP = tp ? w.d1 : w.d0;
          let best = null;
          for (const m of wn2) { const r = segDist(pt, m.from, m.to); if (!best || r.d < best.d) best = {d: r.d, dn: m.d0 + r.t * (m.d1 - m.d0)}; }
          if (best && best.d < 5) phase.push({d: r4(dP), mismatch: r4(dP - best.dn), at: pt});
        }
      }
    }
    const lp = len(P), ln = len(N), dp = delayOf(P), dn = delayOf(N), maxUnc = T.maxUncoupled;
    const worstPhase = phase.reduce((m, x) => Math.max(m, Math.abs(x.mismatch)), 0);
    return {name, positive: p.positive, negative: p.negative, lengthP: r4(lp), lengthN: r4(ln), skew: r4(Math.abs(lp - ln)), delaySkew: r2(Math.abs(dp - dn)),
      uncoupledP: r4(uncP), uncoupledN: r4(uncN), uncoupled: r4(Math.max(uncP, uncN)), maxUncoupled: maxUnc, runs, phase, worstPhase: r4(worstPhase),
      status: maxUnc != null && Math.max(uncP, uncN) > maxUnc + 1e-6 ? "fail" : "ok"};
  }

  // ------------------------------------------------------------------ net and board
  function analyzeNet(ctxOrDoc, net, options = {}) {
    const span = globalThis.AtriumDiagnostics?.performance?.begin("analysis", "check");
    return span ? span.run(screenNet, ctxOrDoc, net, options) : screenNet(ctxOrDoc, net, options);
  }
  function screenNet(ctxOrDoc, net, options = {}) {
    const ctx = ctxOrDoc?.segs ? ctxOrDoc : context(ctxOrDoc, options.defs, options);
    const t0 = now(), segs = ctx.byNet.get(net) || [], pair = ctx.pairOf.get(net) || null;
    const endHoles = ctx.holes.filter(h => h.net === net);
    const results = new Map();
    for (const s of segs) results.set(s, analyzeSegment(ctx, s, endHoles));
    // Profile along the walk.
    const order = walk(segs), profile = [];
    for (const w of order) {
      const list = results.get(w.s) || [];
      for (const p of w.fwd ? list : [...list].reverse()) {
        const off = w.fwd ? dist(w.s.a, p.a) : dist(w.s.b, p.b);
        profile.push({d0: r4(w.d0 + off), d1: r4(w.d0 + off + p.len), z: p.z == null ? null : r2(p.z), target: p.target, tolerance: p.tolerance, layer: w.s.layer, status: p.status, id: w.s.id});
      }
    }
    const pieces = [...results.values()].flat(), events = [];
    for (const s of segs) {
      const list = results.get(s) || [];
      for (const side of ["up", "down"]) {
        let lastNet = null;
        for (let i = 0; i < list.length; i++) {
          const p = list[i], x = p[side], span = p.referenceSpan ?? p;
          if (!x.layer || p.antipad || (p.referenceSpan && list[i - 1]?.referenceSpan === span)) continue;
          if (x.status === "void" || x.status === "partial") {
            if (span.len >= ctx.opts.minVoid) events.push({kind: x.status === "void" ? "void" : "partial", net, id: s.id, layer: s.layer, ref: x.layer, length: r4(span.len), at: lerp(span.a, span.b, .5), a: span.a, b: span.b,
              detail: x.status === "void" ? "No copper on " + x.layer + " under " + r4(span.len) + " mm of track" : "The track edge overhangs the copper on " + x.layer});
          } else if (x.status === "split") events.push({kind: "split", net, id: s.id, layer: s.layer, ref: x.layer, length: r4(span.len), at: lerp(span.a, span.b, .5), a: span.a, b: span.b, detail: "The track straddles a split between nets on " + x.layer});
          if (x.net != null && x.status !== "void") {
            if (lastNet != null && x.net !== lastNet) events.push({kind: "split-crossing", net, id: s.id, layer: s.layer, ref: x.layer, at: p.a, a: p.a, b: p.a, from: lastNet, to: x.net,
              detail: "The track crosses from " + lastNet + " to " + x.net + " on " + x.layer});
            lastNet = x.net;
          }
        }
      }
      if (list.every(p => p.status === "nomodel") && list.length) events.push({kind: "no-reference", net, id: s.id, layer: s.layer, at: lerp(s.a, s.b, .5), a: s.a, b: s.b, length: r4(s.len), detail: "No reference plane: impedance undefined"});
    }
    const returns = returnPaths(ctx, net, results);
    const xt = crosstalkFor(ctx, net, pair?.mate);
    const zs = pieces.filter(p => p.z != null && !p.antipad).map(p => p.z);
    const devs = pieces.filter(p => p.dev != null && !p.antipad).map(p => p.dev);
    const worst = devs.reduce((m, d) => Math.abs(d) > Math.abs(m) ? d : m, 0);
    const length = segs.reduce((s, x) => s + x.len, 0);
    const unmodeled = r4(pieces.reduce((total, p) => total + (p.z == null ? p.len : 0), 0));
    const T = segs.length ? targetFor(ctx, net, segs[0].layer, null) : null;
    const res = {net, pair: pair ? {name: pair.name, role: pair.role, mate: pair.mate} : null, length: r4(length), segments: segs.length,
      target: T?.target ?? null, tolerance: T?.tolerance ?? null, source: T?.source ?? null, profileName: T?.profile ?? null,
      zMin: zs.length ? r2(Math.min(...zs)) : null, zMax: zs.length ? r2(Math.max(...zs)) : null, worstDev: devs.length ? r2(worst) : null,
      outside: r4(pieces.filter(p => p.status === "fail" || p.status === "warn").reduce((s, p) => s + p.len, 0)),
      ...(unmodeled > 0 ? {unmodeled} : null), events, returns, crosstalk: xt, results, profile, ms: 0};
    res.diff = pair && pair.role === "P" ? diffPairOf(ctx, pair.name, new Map([...results, ...analyzeMate(ctx, pair.mate, endHoles)])) : null;
    const counts = {ref: events.length, ret: returns.filter(r => r.status !== "ok").length, xt: xt.filter(x => x.status !== "ok").length};
    res.counts = counts;
    res.status = pieces.some(p => p.status === "fail") || counts.ret || events.some(e => e.kind === "split" || e.kind === "split-crossing" || e.kind === "void") || res.diff?.status === "fail" ? "fail"
      : pieces.some(p => p.status === "warn" || p.status === "nomodel") || counts.xt || events.length ? "warn" : "ok";
    res.ms = now() - t0;
    const supply=ctx.supply(net);if(supply)res.supply={voltage:supply.voltage,rule:supply.ruleName};
    ctx.nets.set(net, res);
    return res;
  }
  function analyzeMate(ctx, mate, ownHoles) {
    const known = ctx.nets.get(mate);
    if (known) return known.results;
    const holes = ctx.holes.filter(h => h.net === mate), m = new Map();
    for (const s of ctx.byNet.get(mate) || []) m.set(s, analyzeSegment(ctx, s, holes.length ? holes : ownHoles));
    return m;
  }
  function* steps(doc, defs, options = {}) {
    const t0 = now(), ctx = options.context || context(doc, defs, options);
    // Power and ground nets are planes or supplies, not signals: left out unless asked for.
    const names = options.nets ? options.nets.filter(n => ctx.byNet.has(n)) : [...ctx.byNet.keys()].filter(n => options.includePower || !POWER.test(n) && !ctx.supply(n)).sort();
    // A pair's P net is analysed after N so the mate's pieces are reused.
    names.sort((a, b) => (ctx.pairOf.get(a)?.role === "P") - (ctx.pairOf.get(b)?.role === "P"));
    const nets = [];
    let i = 0;
    for (const n of names) { nets.push(analyzeNet(ctx, n)); i++; yield {done: i, total: names.length}; }
    return summarize(ctx, nets, now() - t0);
  }
  function analyze(doc, defs, options = {}) {
    const it = steps(doc, defs, options);
    let r = it.next();
    while (!r.done) r = it.next();
    return r.value;
  }
  function summarize(ctx, nets, ms) {
    const events = nets.flatMap(n => n.events), returns = nets.flatMap(n => n.returns);
    const seen = new Map();
    for (const n of nets) for (const x of n.crosstalk) {
      const k = [x.victim, x.aggressor].sort().join("\u0001") + "\u0001" + x.relation, e = seen.get(k);
      if (!e || x.next > e.next) seen.set(k, x);
    }
    const crosstalk = [...seen.values()].sort((a, b) => b.next - a.next);
    const pairs = nets.map(n => n.diff).filter(Boolean);
    const out = {document_id: ctx.doc.id, nets, events, returns, crosstalk, pairs, notes: [...ctx.notes], options: {...ctx.opts},
      stats: {ms: r2(ms), nets: nets.length, segments: ctx.segs.length, context: r2(ctx.built)}};
    out.violations = violations(out);
    return out;
  }
  // DRC-style violations: [{kind, severity, net, id, at, title, detail}].
  function violations(rep) {
    const out = [];
    for (const n of rep.nets) {
      if (n.worstDev != null && n.target && Math.abs(n.worstDev) > n.tolerance) {
        const p = [...n.results.values()].flat().filter(x => x.dev != null && !x.antipad).sort((a, b) => Math.abs(b.dev) - Math.abs(a.dev))[0];
        out.push({kind: "impedance", severity: Math.abs(n.worstDev) > 2 * n.tolerance ? "Error" : "Warning", net: n.net, id: p?.id ?? null, at: p ? lerp(p.a, p.b, .5) : null,
          title: "Impedance " + n.net, detail: (n.pair ? "Zdiff" : "Z") + " " + r2(p?.z) + " Ω vs " + n.target + " Ω ±" + n.tolerance + " % (" + (n.worstDev > 0 ? "+" : "") + n.worstDev + " %), " + n.outside + " mm outside"});
      }
    }
    for (const e of rep.events) out.push({kind: "reference", severity: e.kind === "partial" ? "Warning" : "Error", net: e.net, id: e.id, at: e.at, title: "Reference plane " + e.net, detail: e.detail});
    for (const r of rep.returns) if (r.status !== "ok") out.push({kind: "return-path", severity: r.status === "fail" ? "Error" : "Warning", net: r.net, id: r.via, at: r.at, title: "Return path " + r.net,
      detail: r.kind === "missing-via" ? "Layer change " + r.from + "→" + r.to + ": no stitching via within " + rep.options.returnRadius + " mm" : r.kind === "net-change" ? "Reference changes net at " + r.from + "→" + r.to + ": no stitching capacitor within " + rep.options.capRadius + " mm" : "No reference plane on one side of the layer change"});
    for (const x of rep.crosstalk) if (x.status !== "ok") out.push({kind: "crosstalk", severity: "Warning", net: x.victim, id: null, at: x.stretches[0]?.a || null, title: "Crosstalk " + x.victim + " ↔ " + x.aggressor,
      detail: "Estimated NEXT " + x.nextPct + " %, FEXT " + x.fextPct + " % over " + x.length + " mm (" + x.relation + " layer, min gap " + x.minGap + " mm)"});
    for (const p of rep.pairs) if (p.status === "fail") out.push({kind: "diff-pair", severity: "Warning", net: p.positive, id: null, at: p.runs[0]?.a || null, title: "Diff pair " + p.name,
      detail: "Uncoupled " + p.uncoupled + " mm exceeds " + p.maxUncoupled + " mm"});
    return out;
  }

  // ------------------------------------------------------------------ MCP si_analysis
  function plainNet(n, full) {
    const pt = p => p ? [r4(p[0]), r4(p[1])] : null;
    const out = {net: n.net, pair: n.pair, length: n.length, segments: n.segments, target: n.target, tolerance: n.tolerance, target_source: n.source, profile: n.profileName,
      z_min: n.zMin, z_max: n.zMax, worst_deviation_pct: n.worstDev, length_outside: n.outside, status: n.status, counts: n.counts};
    if (n.unmodeled > 0) out.length_unmodeled = n.unmodeled;
    if (n.supply) out.supply = n.supply;
    if (full) {
      out.pieces = n.profile.map(p => ({...p}));
      out.events = n.events.map(e => ({kind: e.kind, id: e.id, layer: e.layer, ref: e.ref, length: e.length, at: pt(e.at), detail: e.detail}));
      out.returns = n.returns.map(r => ({via: r.via, at: pt(r.at), from: r.from, to: r.to, status: r.status, kind: r.kind, distance: r.distance, by: r.by}));
      out.crosstalk = n.crosstalk.slice(0, 20).map(x => ({aggressor: x.aggressor, relation: x.relation, length: x.length, min_gap: x.minGap, kb: r4(x.kb), next_pct: x.nextPct, fext_pct: x.fextPct, status: x.status}));
      if (n.diff) out.diff_pair = {...n.diff, runs: n.diff.runs.map(r => ({role: r.role, length: r4(r.length), a: pt(r.a), b: pt(r.b), layer: r.layer})), phase: n.diff.phase.slice(0, 200).map(x => ({d: x.d, mismatch: x.mismatch}))};
    }
    return out;
  }
  function headless(a, host) {
    const p = host.project(), doc = host.board(p, a.document_id), defs = host.defsOf(p);
    const opts = {project: p, target: a.target, diffTarget: a.diff_target, tolerance: a.tolerance, rise: a.rise_time_ns, returnRadius: a.return_radius, capRadius: a.cap_radius, maxGap: a.max_gap, maxCrosstalk: a.max_crosstalk_pct};
    const rep = analyze(doc, defs, {...opts, nets: a.nets});
    const full = !!a.nets?.length || a.detail === true;
    let nets = rep.nets;
    if (a.failing_only) nets = nets.filter(n => n.status !== "ok");
    const page = host.page || ((items) => ({items}));
    return {document_id: doc.id, units: "mm", models: {impedance: "AtriumImpedance closed-form quasi-TEM (field-solver checked)", crosstalk: "estimate: Kb = (Cm/C + Lm/L)/4, NEXT = Kb·min(1, 2Lc/(v·Tr)); FEXT = Lc/(2v·Tr)·|Cm/C − Lm/L|"},
      options: rep.options, stats: rep.stats, notes: rep.notes,
      summary: {nets: rep.nets.length, failing: rep.nets.filter(n => n.status === "fail").length, warnings: rep.nets.filter(n => n.status === "warn").length,
        reference_events: rep.events.length, return_path_issues: rep.returns.filter(r => r.status !== "ok").length, crosstalk_flags: rep.crosstalk.filter(x => x.status !== "ok").length},
      crosstalk: rep.crosstalk.slice(0, 50).map(x => ({victim: x.victim, aggressor: x.aggressor, relation: x.relation, length: x.length, min_gap: x.minGap, kb: r4(x.kb), next_pct: x.nextPct, fext_pct: x.fextPct, status: x.status})),
      diff_pairs: rep.pairs.map(d => ({name: d.name, positive: d.positive, negative: d.negative, skew: d.skew, delay_skew_ps: d.delaySkew, uncoupled: d.uncoupled, max_uncoupled: d.maxUncoupled, worst_phase: d.worstPhase, status: d.status})),
      violations: a.violations === false ? undefined : rep.violations.slice(0, 500).map(v => ({...v, at: v.at ? [r4(v.at[0]), r4(v.at[1])] : null})),
      ...page(nets.map(n => plainNet(n, full)), a)};
  }

  // ------------------------------------------------------------------ overlay
  const COLORS = {ok: "#3ee07a", warn: "#ffc233", fail: "#ff5cf0", info: "#6aa0ff", nomodel: "#c04fd8", antipad: "#7f8a99", void: "#e5484d", partial: "#e6a417", split: "#a970ff",
    xt: "#00b8d9", unc: "#ff8a00", ret: "#e5484d", retOk: "#2fb35a"};
  // Draws a board or net result in world coordinates. modes: Set of impedance | reference |
  // return | crosstalk | diff.
  function draw(g, rep, modes, {scale, focus} = {}) {
    if (!rep) return;
    const px = 1 / (scale || 1), nets = focus ? rep.nets.filter(n => n.net === focus) : rep.nets;
    g.save(); g.lineCap = "round"; g.lineJoin = "round";
    const line = (a, b, w, c, alpha, dash) => { g.globalAlpha = alpha; g.strokeStyle = c; g.lineWidth = w; g.setLineDash(dash || []); g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); };
    // Impedance: a dark casing under a coloured core, so the colour reads on any copper colour.
    if (modes.has("impedance")) for (const pass of [0, 1]) for (const n of nets) for (const [s, list] of n.results) for (const p of list) {
      const w = Math.max(s.w * .5, 2.5 * px);
      if (pass === 0) line(p.a, p.b, w + 3 * px, "#000", .55);
      else line(p.a, p.b, w, COLORS[p.status] || COLORS.info, 1, p.status === "nomodel" ? [4 * px, 3 * px] : null);
    }
    if (modes.has("reference")) {
      for (const e of rep.events) {
        if (focus && e.net !== focus) continue;
        if (e.a && e.b && dist(e.a, e.b) > 1e-6) line(e.a, e.b, 6 * px, COLORS[e.kind] || COLORS.void, .7);
        if (e.kind === "split-crossing" || e.kind === "split") { const r = 6 * px, [x, y] = e.at; g.globalAlpha = 1; g.strokeStyle = COLORS.split; g.lineWidth = 2 * px; g.setLineDash([]); g.beginPath(); g.moveTo(x - r, y - r); g.lineTo(x + r, y + r); g.moveTo(x + r, y - r); g.lineTo(x - r, y + r); g.stroke(); }
      }
    }
    if (modes.has("return")) for (const r of rep.returns) {
      if (focus && r.net !== focus) continue;
      g.globalAlpha = 1; g.setLineDash([]); g.lineWidth = 2 * px; g.strokeStyle = r.status === "ok" ? COLORS.retOk : COLORS.ret;
      g.beginPath(); g.arc(r.at[0], r.at[1], (r.status === "ok" ? 5 : 8) * px, 0, Math.PI * 2); g.stroke();
      if (r.byAt) line(r.at, r.byAt, 1.5 * px, COLORS.retOk, .9, [3 * px, 2 * px]);
    }
    if (modes.has("crosstalk")) for (const x of rep.crosstalk) {
      if (focus && x.victim !== focus && x.aggressor !== focus) continue;
      for (const s of x.stretches) line(s.a, s.b, Math.max(s.w * 2.5, 4 * px), x.status === "ok" ? COLORS.xt : COLORS.fail, Math.min(.75, .2 + s.kb * 6));
    }
    if (modes.has("diff")) for (const p of rep.pairs) {
      if (focus && p.positive !== focus && p.negative !== focus) continue;
      for (const r of p.runs) for (let i = 1; i < r.points.length; i++) line(r.points[i - 1], r.points[i], 5 * px, COLORS.unc, .9, [5 * px, 3 * px]);
    }
    g.restore();
  }

  // ------------------------------------------------------------------ dialog
  let H = null, last = null, modes = new Set(["impedance", "reference", "return"]), focusNet = null, job = 0, dlg = null;
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  const button = (text, act, cls, title) => globalThis.AtriumUI.nativeButton(text, act, cls, title);
  const PREF = "waffle.si.options";
  function loadPrefs() { try { return JSON.parse(globalThis.localStorage?.getItem(PREF) || "{}") || {}; } catch { return {}; } }
  function savePrefs(o) { try { globalThis.localStorage?.setItem(PREF, JSON.stringify(o)); } catch { /* private mode */ } }
  // SVG plot of a net's impedance along its length with the target band.
  function plot(n) {
    const NS = "http://www.w3.org/2000/svg", W = 560, Hh = 150, L = 44, R = 8, T = 10, B = 24;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 " + W + " " + Hh); svg.setAttribute("class", "si-plot"); svg.setAttribute("role", "img");
    const s = (tag, a, text) => { const x = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(a)) x.setAttribute(k, v); if (text != null) x.textContent = text; svg.append(x); return x; };
    const prof = n.profile.filter(p => p.z != null), len = Math.max(n.length, 1e-3);
    const length = n.unmodeled > 0 ? r4(n.length - n.unmodeled) + " of " + n.length : n.length;
    const description = prof.length ? (n.zMin ?? "–") + " to " + (n.zMax ?? "–") + " Ω over " + length + " mm" : "No impedance model";
    svg.setAttribute("aria-label", "Impedance along " + n.net + ": " + description);
    if (!prof.length) { s("text", {x: W / 2, y: Hh / 2, "text-anchor": "middle", class: "si-plot-muted"}, "No impedance model along this net"); return svg; }
    let lo = Math.min(...prof.map(p => p.z)), hi = Math.max(...prof.map(p => p.z));
    if (n.target) { lo = Math.min(lo, n.target * (1 - 2 * n.tolerance / 100)); hi = Math.max(hi, n.target * (1 + 2 * n.tolerance / 100)); }
    const pad = (hi - lo) * .08 || 1; lo -= pad; hi += pad;
    const X = d => L + (W - L - R) * d / len, Y = z => T + (Hh - T - B) * (1 - (z - lo) / (hi - lo));
    if (n.target) {
      const t = n.target, tol = n.tolerance / 100;
      s("rect", {x: L, y: Y(t * (1 + tol)), width: W - L - R, height: Math.max(0, Y(t * (1 - tol)) - Y(t * (1 + tol))), class: "si-band"});
      s("line", {x1: L, x2: W - R, y1: Y(t), y2: Y(t), class: "si-target"});
    }
    for (const z of [lo + pad, (lo + hi) / 2, hi - pad]) { s("text", {x: L - 4, y: Y(z) + 3, "text-anchor": "end", class: "si-axis"}, z.toFixed(0)); }
    s("text", {x: L, y: Hh - 6, class: "si-axis"}, "0"); s("text", {x: W - R, y: Hh - 6, "text-anchor": "end", class: "si-axis"}, r2(n.length) + " mm");
    s("line", {x1: L, x2: L, y1: T, y2: Hh - B, class: "si-axis-line"}); s("line", {x1: L, x2: W - R, y1: Hh - B, y2: Hh - B, class: "si-axis-line"});
    for (const p of prof) s("line", {x1: X(p.d0), x2: X(p.d1), y1: Y(p.z), y2: Y(p.z), class: "si-step si-" + p.status}).append(Object.assign(document.createElementNS(NS, "title"), {textContent: p.layer + " · " + p.z + " Ω · " + r2(p.d0) + "–" + r2(p.d1) + " mm"}));
    return svg;
  }
  function open(host) {
    H = host;
    const doc = host.doc();
    if (doc?.kind !== "pcb") {
      const board = host.project().documents.find(d => d.kind === "pcb");
      if (!board) { host.info("Open a board layout for the signal integrity analysis."); return null; }
      host.selectDocument(board.id);
    }
    dlg?.close();
    const prefs = {...loadPrefs()};
    const U = globalThis.Atrium?.units, unit = U ? U.normal(host.project()?.units) : "mm";
    const fmt = mm => mm == null ? "—" : U ? U.format(mm, unit, unit === "mil" ? 1 : 3) : r4(mm) + " mm";
    const d = el("dialog", null, "work-dialog ui-dialog ui-sheet si-dialog", {"aria-labelledby": "si-heading"});
    dlg = d;
    const head = el("div", null, "si-head"), summary = el("p", null, "si-summary", {role: "status", "aria-live": "polite"});
    const title = el("h2", "Signal Integrity", null, {id: "si-heading"});
    head.append(title, summary);
    // Settings.
    const tools = el("div", null, "work-toolbar si-tools");
    const fields = [["target", "Z target", "Ω", 50], ["diffTarget", "Zdiff target", "Ω", 100], ["tolerance", "Tolerance", "%", 10], ["rise", "Rise time", "ns", .5],
      ["returnRadius", "Return via within", "mm", 1], ["maxCrosstalk", "Crosstalk limit", "%", 5]];
    const inputs = {};
    for (const [k, label, u, dv] of fields) {
      const lab = el("label", null, "si-field"), inp = el("input", null, "ui-field", {type: "number", step: "any", min: "0", "aria-label": label + " (" + u + ")"});
      inp.dataset.numericUnit = u; inp.value = String(prefs[k] ?? dv); inputs[k] = inp;
      inp.onchange = () => { prefs[k] = inp.value === "" ? null : +inp.value; savePrefs(prefs); run(); };
      lab.append(el("span", label), inp, el("span", u, "si-unit")); tools.append(lab);
    }
    const ov = el("fieldset", null, "si-modes"); ov.append(el("legend", "Overlays"));
    for (const [k, label] of [["impedance", "Impedance"], ["reference", "Reference plane"], ["return", "Return vias"], ["crosstalk", "Crosstalk"], ["diff", "Diff pairs"]]) {
      const lab = el("label"), c = el("input", null, "ui-checkbox", {type: "checkbox"}); c.checked = modes.has(k);
      c.onchange = () => { if (c.checked) modes.add(k); else modes.delete(k); host.invalidate(); };
      lab.append(c, el("span", " " + label)); ov.append(lab);
    }
    const tabs = el("div", null, "si-tabs ui-tabs", {"data-strip": "", role: "tablist", "aria-label": "Analysis results"});
    const body = el("div", null, "si-body", {role: "tabpanel", id: "si-tab-panel"}), plotBox = el("div", null, "si-plot-box");
    const TABS = [["nets", "Nets"], ["reference", "Reference"], ["return", "Return path"], ["crosstalk", "Crosstalk"], ["pairs", "Diff pairs"]];
    let tab = "nets";
    const tabButtons = {};
    for (const [k, label] of TABS) {
      const b = button(label, () => { tab = k; paint(); }, "si-tab ui-tab");
      b.setAttribute("role", "tab"); b.id = "si-tab-" + k; tabButtons[k] = b; tabs.append(b);
    }
    const footer = el("div", null, "work-actions ui-dialog-actions");
    const toMessages = button("Send to Messages", () => {
      const M = globalThis.AtriumMessages;
      if (!M || !last) { host.info("Messages are not available."); return; }
      M.set("SI", last.violations.map(v => ({class: v.severity, source: "SI", text: v.title + ": " + v.detail, document: host.project().documents.find(x => x.id === last.document_id)?.name || "", objectId: v.id, point: v.at})));
      M.show?.(host.messageContext?.());
    }, "", "List the SI findings in the Messages panel");
    footer.append(button("Analyse selected net", () => { const n = selectedNet(); if (n) quick(n); else host.info("Select a track or highlight a net first."); }),
      button("Analyse board", () => run(), "is-primary"), toMessages, button("Close", () => d.close()));
    d.append(head, tools, ov, tabs, body, plotBox, footer);
    d.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); d.close(); } });
    d.addEventListener("close", () => { job++; if (dlg === d) dlg = null; d.remove(); host.invalidate(); });
    function opts() { const o = {project: host.project(), revision: host.revision()}; for (const k of Object.keys(inputs)) { const v = inputs[k].value; o[k] = v === "" ? null : +v; } return o; }
    function selectedNet() {
      const ids = new Set(host.selection()), it = host.doc().items.find(i => ids.has(i.id) && i.net);
      return it?.net || host.highlight?.() || null;
    }
    function quick(net) {
      try {
        const ctx = context(host.doc(), host.defs(), opts()), n = analyzeNet(ctx, net);
        if (!last || last.document_id !== host.doc().id) last = summarize(ctx, [n], n.ms);
        else { last.nets = last.nets.filter(x => x.net !== net).concat(n); last = summarize(ctx, last.nets, last.stats.ms); }
        focusNet = net; summary.textContent = net + ": " + r2(n.ms) + " ms · " + describe(n); paint(); host.invalidate();
      } catch (e) { summary.textContent = e.message; }
    }
    function run() {
      const my = ++job, t0 = now();
      let it;
      try { it = steps(host.doc(), host.defs(), opts()); } catch (e) { summary.textContent = e.message; return; }
      summary.textContent = "Analysing…";
      const slice = () => {
        if (my !== job) return;
        const t = now();
        let r = it.next();
        while (!r.done && now() - t < 12) r = it.next();
        if (!r.done) { summary.textContent = "Analysing… " + r.value.done + " / " + r.value.total + " nets"; setTimeout(slice, 0); return; }
        last = r.value; focusNet = null;
        const c = last.violations.length;
        summary.textContent = last.stats.nets + " nets · " + last.stats.segments + " segments · " + r2(now() - t0) + " ms · " + (c ? c + " finding" + (c === 1 ? "" : "s") : "no findings") + (last.notes.length ? " · " + last.notes.join(" ") : "");
        paint(); host.invalidate();
      };
      setTimeout(slice, 0);
    }
    const describe = n => (n.zMin != null ? n.zMin + "–" + n.zMax + " Ω" : "no model") + (n.target ? " vs " + n.target + " Ω" : "") + " · " + n.events.length + " reference · " + n.counts.ret + " return · " + n.counts.xt + " crosstalk";
    function locate(id, at, net) {
      if (net) { focusNet = net; host.setHighlight?.(net); }
      if (id) { try { host.select([id], id); } catch { /* gone */ } }
      if (at) host.centerOn?.(at);
      host.invalidate();
    }
    function table(cols, rows, onRow) {
      return AtriumUIKit.analysisTable(cols, rows.slice(0, 2000), row => {
        const tr = el("tr", null, "si-row si-" + (row.status || "ok")); tr.tabIndex = 0;
        for (const v of row.cells) tr.append(typeof v === "object" && v ? v : el("td", v == null ? "—" : String(v)));
        tr.onclick = () => onRow(row); tr.onkeydown = e => { if (e.key === "Enter") onRow(row); };
        return tr;
      }, {wrapClass: "si-table-wrap", tableClass: "analysis-table si-table", empty: "Nothing to report.", emptyClass: "si-empty"});
    }
    const pct = v => v == null ? "—" : (v > 0 ? "+" : "") + v + " %", st = s => ({ok: "OK", warn: "Check", fail: "Fail"})[s] || s;
    function paint() {
      for (const [k, b] of Object.entries(tabButtons)) {
        const selected = k === tab;
        b.setAttribute("aria-selected", String(selected)); b.tabIndex = selected ? 0 : -1;
        if (selected) b.setAttribute("aria-controls", body.id); else b.removeAttribute("aria-controls");
      }
      body.setAttribute("aria-labelledby", tabButtons[tab].id);
      body.replaceChildren(); plotBox.replaceChildren();
      if (!last) { body.append(el("p", "Analyse the board, or select a track and analyse its net.", "si-hint")); return; }
      const R = last;
      if (tab === "nets") body.append(table(["Net", "Pair", "Length", "Z min–max (Ω)", "Target", "Worst Δ", "Outside", "Ref", "Return", "Xtalk", "Status"],
        R.nets.slice().sort((a, b) => ({fail: 0, warn: 1, ok: 2}[a.status] - {fail: 0, warn: 1, ok: 2}[b.status]) || (a.net < b.net ? -1 : 1)).map(n => ({status: n.status, n,
          cells: [n.net, n.pair ? n.pair.name + " " + n.pair.role : "", fmt(n.length), n.zMin != null ? n.zMin + "–" + n.zMax : "—", n.target ? n.target + " ±" + n.tolerance + " %" + (n.source === "default" ? " *" : "") : "—",
            pct(n.worstDev), fmt(n.outside), n.events.length, n.counts.ret, n.counts.xt, st(n.status)]})), r => { locate(r.n.results.keys().next().value?.id, null, r.n.net); paint(); }));
      if (tab === "reference") body.append(table(["Net", "Kind", "Layer", "Reference", "Length", "Detail"], R.events.map(e => ({status: e.kind === "partial" ? "warn" : "fail", e,
        cells: [e.net, e.kind, e.layer, e.ref || "—", e.length != null ? fmt(e.length) : "—", e.detail]})), r => locate(r.e.id, r.e.at, r.e.net)));
      if (tab === "return") body.append(table(["Net", "Layers", "Kind", "Distance", "By", "Status"], R.returns.map(x => ({status: x.status, x,
        cells: [x.net, x.from + " → " + x.to, x.kind, x.distance != null ? fmt(x.distance) : "—", x.by || "—", st(x.status)]})), r => locate(r.x.via, r.x.at, r.x.net)));
      if (tab === "crosstalk") body.append(table(["Victim", "Aggressor", "Relation", "Coupled", "Min gap", "Kb", "NEXT (est.)", "FEXT (est.)", "Status"], R.crosstalk.map(x => ({status: x.status, x,
        cells: [x.victim, x.aggressor, x.relation, fmt(x.length), fmt(x.minGap), r4(x.kb), x.nextPct + " %", x.fextPct + " %", st(x.status)]})), r => locate(null, r.x.stretches[0]?.a, r.x.victim)));
      if (tab === "pairs") body.append(table(["Pair", "Length +", "Length −", "Skew", "Delay skew", "Worst phase", "Uncoupled", "Max uncoupled", "Status"], R.pairs.map(p => ({status: p.status, p,
        cells: [p.name, fmt(p.lengthP), fmt(p.lengthN), fmt(p.skew), p.delaySkew + " ps", fmt(p.worstPhase), fmt(p.uncoupled), p.maxUncoupled != null ? fmt(p.maxUncoupled) : "—", st(p.status)]})), r => locate(null, r.p.runs[0]?.a, r.p.positive)));
      if (tab === "crosstalk") body.append(el("p", "Crosstalk is an estimate: Kb = (Cm/C + Lm/L)/4 from the coupled-line model, NEXT = Kb·min(1, 2Lc/(v·Tr)), FEXT = Lc/(2v·Tr)·|Cm/C − Lm/L|. Broadside coupling ±50 %.", "si-hint"));
      if (tab === "nets") body.append(el("p", "* default target (no impedance profile on the net's Width or Differential Pairs Routing rule).", "si-hint"));
      const n = focusNet && R.nets.find(x => x.net === focusNet);
      if (n?.supply) plotBox.append(el("p","Supply voltage "+n.supply.voltage+" V · "+n.supply.rule,"si-hint"));
      if (n) { plotBox.append(el("h3", "Impedance along " + n.net + (n.pair ? " (Zdiff)" : "")), plot(n)); }
    }
    globalThis.AtriumShell.adoptDialog(d, {title, body, actions: footer, sheet: true, defaultAction: false});
    document.body.append(d); d.show(); paint();
    inputs.target.focus({preventScroll: true});
    const sel = selectedNet();
    if (sel) quick(sel); else run();
    return d;
  }
  function install(host) {
    if (H === host) return;
    H = host;
    host.registerAction("si-analysis", () => open(host));
    host.addRenderer(d => {
      if (d.kind !== "pcb" || !last || last.document_id !== d.id || !dlg?.open || !modes.size) return null;
      return {overlay: (g, info) => draw(g, last, modes, {scale: info.scale, focus: focusNet})};
    });
  }
  if (typeof document !== "undefined" && globalThis.AtriumNavCommon?.ready) AtriumNavCommon.ready(install);

  return Object.freeze({DEFAULTS, context, analyzeNet, analyze, steps, summarize, violations, walk, kb, broadside, crosstalk, copperIndex, draw, headless, open, install,
    state: () => ({result: last, open: !!dlg?.open, modes: [...modes], focus: focusNet})});
})();
