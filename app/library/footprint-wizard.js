"use strict";
// IPC-7351B land-pattern wizard. The core is DOM-free:
//
//   AtriumFootprintWizard.generate(spec)  -> library def {name, prefix, footprint, symbol?}
//   AtriumFootprintWizard.defaults(family, preset?) -> a ready spec
//   AtriumFootprintWizard.lands(dims, goal, opts)  -> {Z, G, X, ...} for one pair of land rows
//   AtriumFootprintWizard.name(spec)       -> IPC-7351B name, e.g. SOIC127P600X175-8N
//
// Dimensions are millimetres. A toleranced value is a number, {min,max}, {min,nom,max} or
// {nom,tol} (± tol). The equations are the IPC-7351B ones:
//   Zmax = Lmin + 2·JT + √(CL² + F² + P²)     outer land span (toe)
//   Gmin = Smax − 2·JH − √(CS² + F² + P²)     inner land span (heel)
//   Xmax = Wmin + 2·JS + √(CW² + F² + P²)     land width (side)
// L is the toe-to-toe terminal span, S the heel-to-heel span and W the terminal width; C
// is each one's tolerance (max − min). When only the terminal length T is known, S comes
// from L and T with the RMS tolerance IPC-7351B recommends: CS = √(CL² + 2·CT²), and Smax
// is pulled in from the worst case (Lmax − 2·Tmin) by half the difference.
// F (board fabrication) and P (placement) default to 0.10 and 0.05 mm, the values used by
// the IPC-7351B calculator conventions and KiCad's IPC generator. Z, G and X are rounded
// to the nearest 0.05 mm (the IPC "round-off"). Courtyards round outward to 0.05 mm.
//
// Density levels: A = Most (M suffix), B = Nominal (N), C = Least (L).
globalThis.AtriumFootprintWizard = (() => {
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const near = (v, step) => r6(Math.round(v / step + 1e-9) * step);
  const up = (v, step) => r6(Math.ceil(v / step - 1e-9) * step);
  const LEVEL = {A: "M", B: "N", C: "L", M: "M", N: "N", L: "L", most: "M", nominal: "N", least: "L"};
  // Silkscreen line width: 0.18 mm clears every built-in fab preset's minimum line (JLCPCB 0.15,
  // Eurocircuits class 6 0.17), the same width generic-parts.js uses. Silk stays 0.2 mm from copper.
  const SILK_W = .18, SILK_GAP = .2;
  const IDX = {M: 0, N: 1, L: 2};

  // ------------------------------------------------------------------ goal tables
  // [Most(A), Nominal(B), Least(C)] for toe, heel, side and courtyard excess, mm.
  // Gull-wing: IPC-7351B Table 3-2 (pitch > 0.625 mm), and the fine-pitch side goals
  // for pitch <= 0.625 mm. J-lead: Table 3-4. Chip >= 1608 (0603): Table 3-5.
  // Flat no-lead (QFN/SON): Tables 3-15/3-16. Values cross-checked against kicad-footprint-generator's
  // published IPC-7351B tables (src/kilibs/config/ipc_configs/ipc_7351b.yaml and ipc7351B_2terminal.yaml,
  // read 2026-11-19); every table here that KiCad publishes matches it value for value.
  // `round`: the round-off base KiCad uses for that table (only chips < 0603 differ: 0.02 mm).
  const GOALS = {
    gullwing:       {toe: [.55, .35, .15], heel: [.45, .35, .25], side: [.05, .03, .01], courtyard: [.5, .25, .1]},
    gullwingFine:   {toe: [.55, .35, .15], heel: [.45, .35, .25], side: [.01, -.02, -.04], courtyard: [.5, .25, .1]},
    jlead:          {toe: [.10, 0, -.10], heel: [.55, .35, .15], side: [.05, .03, .01], courtyard: [.5, .25, .1]},
    // Table 3-5 (chips ≥ 1608): heel 0 at every level. (Before 2026-11-19 this table had a heel of
    // −0.05, an IPC-7351 (2005) value; IPC-7351B, as published by KiCad, is 0.)
    chip:           {toe: [.55, .35, .15], heel: [0, 0, 0], side: [.05, 0, -.05], courtyard: [.5, .25, .1]},
    // Table 3-6 (chips smaller than 1608/0603).
    chipSmall:      {toe: [.30, .20, .10], heel: [0, 0, 0], side: [.05, 0, -.05], courtyard: [.2, .15, .1], round: .02},
    nolead:         {toe: [.40, .30, .20], heel: [0, 0, 0], side: [-.04, -.04, -.04], courtyard: [.5, .25, .1]},
    // FLAG: Table 3-7 (MELF, cylindrical end caps). Recalled values, not verified.
    melf:           {toe: [.60, .40, .20], heel: [.20, .10, .02], side: [.10, .05, .01], courtyard: [.5, .25, .1], flagged: "IPC-7351B Table 3-7 values not verified"},
    // FLAG: BGA courtyard excess per IPC-7351B Table 3-17 (2.0/1.0/0.5); land reduction below.
    bga:            {courtyard: [2, 1, .5], flagged: "IPC-7351B Table 3-17 BGA reductions recalled, not verified"},
    // FLAG: through-hole lands follow IPC-2222 / IPC-7251 levels (hole = lead + allowance,
    // land = hole + 2 × annular ring). Approximate; IPC-7251 was not consulted.
    tht:            {hole: [.25, .20, .15], annular: [.35, .25, .20], courtyard: [.5, .25, .1], flagged: "IPC-7251 through-hole allowances approximated"}
  };
  function goal(table, density) {
    const g = GOALS[table], k = IDX[LEVEL[density] || "N"], out = {table};
    for (const key of Object.keys(g)) out[key] = Array.isArray(g[key]) ? g[key][k] : g[key];
    return out;
  }

  // ------------------------------------------------------------------ tolerances
  function tol(v, label = "dimension") {
    let min, max, nom;
    if (typeof v === "number") min = max = nom = v;
    else if (v && typeof v === "object") {
      if (Number.isFinite(v.min) && Number.isFinite(v.max)) { min = v.min; max = v.max; nom = Number.isFinite(v.nom) ? v.nom : (min + max) / 2; }
      else if (Number.isFinite(v.nom)) { const t = Math.abs(v.tol || 0); nom = v.nom; min = nom - t; max = nom + t; }
    }
    if (![min, max, nom].every(Number.isFinite) || min > max + 1e-12 || nom < min - 1e-9 || nom > max + 1e-9) throw Error("Enter a valid " + label + " (min ≤ nom ≤ max).");
    if (max < 0 || max > 500) throw Error("The " + label + " is out of range.");
    return {min, max, nom, c: max - min};
  }
  const rss = (...v) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));

  // One pair of opposing land rows (or one two-terminal component).
  //   dims.L span toe-to-toe, dims.W terminal width, dims.T terminal length or dims.S heel span.
  // Round-off (Altium's "round-off"): opts.roundOff is a step in mm (0.05 IPC default, 0.025, 0.01)
  // or "kicad": KiCad's generator convention, the table's base (0.05; 0.02 for chips < 0603) with
  // round-half-to-even (Python round()). dims.heelReduction moves G out by 2× (a KiCad size option).
  const ROUND_OFFS = [.05, .025, .01, "kicad"];
  function roundOffOf(spec) { const v = spec?.roundOff; return v === "kicad" ? "kicad" : ROUND_OFFS.includes(+v) ? +v : .05; }
  function roundTo(v, step, even) {
    if (!even) return near(v, step);
    const q = v / step, f = Math.floor(q), d = q - f;
    const n = Math.abs(d - .5) < 1e-9 ? (f % 2 === 0 ? f : f + 1) : Math.round(q);
    return r6(n * step);
  }
  function lands(dims, g, opts = {}) {
    const F = opts.fab ?? .1, P = opts.place ?? .05, kicad = opts.roundOff === "kicad", step = kicad ? g.round ?? .05 : +opts.roundOff || .05;
    const L = tol(dims.L, "terminal span"), W = tol(dims.W, "terminal width");
    let Smin, Smax, CS;
    if (dims.S != null) { const S = tol(dims.S, "inner span"); Smin = S.min; Smax = S.max; CS = S.c; }
    else {
      const T = tol(dims.T, "terminal length");
      Smin = L.min - 2 * T.max; const worst = L.max - 2 * T.min;
      CS = rss(L.c, T.c, T.c);
      Smax = worst - ((worst - Smin) - CS) / 2;
    }
    const Zraw = L.min + 2 * g.toe + rss(L.c, F, P);
    const Graw = Smax - 2 * g.heel + 2 * (dims.heelReduction || 0) - rss(CS, F, P);
    const Xraw = W.min + 2 * g.side + rss(W.c, F, P);
    let Z = roundTo(Zraw, step, kicad), G = roundTo(Graw, step, kicad), X = roundTo(Xraw, step, kicad);
    if (G < 0) G = 0;
    if (!(Z > G) || !(X > 0)) throw Error("These dimensions leave no room for a land. Check the spans and terminal length.");
    return {Z, G, X, Zraw: r6(Zraw), Graw: r6(Graw), Xraw: r6(Xraw), Smin: r6(Smin), Smax: r6(Smax), CS: r6(CS), F, P, roundOff: kicad ? "kicad" : step,
      padLength: r6((Z - G) / 2), padCentre: r6((Z + G) / 4)};
  }
  // Exposed-pad clearance: a land's heel stays spec.epClearance (default 0.20 mm, KiCad's
  // min_ep_to_pad_clearance) from the exposed pad; G grows to EP + 2 × clearance when it is closer.
  function epClear(r, ep, spec, flagged) {
    const c = spec.epClearance ?? .2;
    if (!r || !(ep > 0) || !(c >= 0) || r.G >= ep + 2 * c - 1e-9) return;
    const G = r6(ep + 2 * c);
    if (!(r.Z > G)) throw Error("The exposed pad leaves no room for the lands at " + c.toFixed(2) + " mm clearance.");
    flagged.push("Land heels shortened (G " + r.G.toFixed(2) + " → " + G.toFixed(2) + " mm) to keep " + c.toFixed(2) + " mm from the exposed pad.");
    r.G = G; r.padLength = r6((r.Z - G) / 2); r.padCentre = r6((r.Z + G) / 4);
  }

  // ------------------------------------------------------------------ geometry
  const pad = (number, x, y, w, h, shape = "roundrect", extra) => ({number: String(number), x: r6(x), y: r6(y), w: r6(w), h: r6(h), shape, angle: 0, drill: 0, ...extra});
  const thPad = (number, x, y, d, drill, shape = "round", h = d) => ({number: String(number), x: r6(x), y: r6(y), w: r6(d), h: r6(h), drill: r6(drill), shape, angle: 0, layer: "Multi", plated: true});
  const rectPath = (x0, y0, x1, y1, extra) => ({kind: "path", points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => p.map(r6)), closed: true, ...extra});
  const padBox = p => {
    const a = Math.abs(Math.round((p.angle || 0) / 90)) % 2 === 1;
    const w = a ? p.h : p.w, h = a ? p.w : p.h;
    return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
  };
  const union = (a, b) => a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b.slice();

  // Keep the parts of segment a→b outside every box (axis-aligned segment clipping).
  function clipSegment(a, b, boxes) {
    let parts = [[0, 1]];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const r of boxes) {
      // Liang–Barsky entry/exit of the segment through the box.
      let t0 = 0, t1 = 1, ok = true;
      for (const [p, q] of [[-dx, a[0] - r[0]], [dx, r[2] - a[0]], [-dy, a[1] - r[1]], [dy, r[3] - a[1]]]) {
        if (Math.abs(p) < 1e-12) { if (q < 0) { ok = false; break; } continue; }
        const t = q / p;
        if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
        else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
      }
      if (!ok || t1 <= t0) continue;
      const next = [];
      for (const [s, e] of parts) {
        if (t1 <= s || t0 >= e) { next.push([s, e]); continue; }
        if (t0 > s) next.push([s, t0]);
        if (t1 < e) next.push([t1, e]);
      }
      parts = next;
    }
    return parts.map(([s, e]) => [[a[0] + dx * s, a[1] + dy * s], [a[0] + dx * e, a[1] + dy * e]]);
  }
  // Silkscreen: the body outline, moved out by half the line width, with gaps around pads.
  function silkOutline(body, pads, o = {}) {
    const w = o.width ?? SILK_W, gap = o.clearance ?? SILK_GAP, minLen = o.minLength ?? .2;
    const e = w / 2, b = [body[0] - e, body[1] - e, body[2] + e, body[3] + e];
    const boxes = pads.map(p => { const q = padBox(p); return [q[0] - gap - e, q[1] - gap - e, q[2] + gap + e, q[3] + gap + e]; });
    const corners = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]], out = [];
    for (let i = 0; i < 4; i++) for (const [p, q] of clipSegment(corners[i], corners[(i + 1) % 4], boxes)) {
      if (Math.hypot(q[0] - p[0], q[1] - p[1]) >= minLen) out.push({kind: "path", style: "silk", width: w, points: [p.map(r6), q.map(r6)]});
    }
    return out;
  }
  // Courtyard, assembly outline (pin-1 chamfer, .Designator) and silk around a body.
  function dressing(fp, body, g, o = {}) {
    const ext = fp.pads.reduce((b, p) => union(b, padBox(p)), null) || body;
    const all = union(ext, body), cy = g.courtyard ?? .25;
    const c = [-up(-all[0] + cy, .05), -up(-all[1] + cy, .05), up(all[2] + cy, .05), up(all[3] + cy, .05)];
    fp.shapes.push(rectPath(c[0], c[1], c[2], c[3], {layer: "Mechanical 15", style: "courtyard", width: .05}));
    // Assembly (Mechanical 13): body with a 1 mm (or 25%) chamfer at pin 1.
    const [x0, y0, x1, y1] = body, ch = Math.min(1, (x1 - x0) * .25, (y1 - y0) * .25);
    const asm = o.chamfer === false ? [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] : [[x0 + ch, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + ch]];
    // o.assembly === false: the caller draws its own body (a circle gives a cylinder in 3D).
    if (o.assembly !== false) fp.shapes.push({kind: "path", layer: "Mechanical 13", style: "assembly", width: .1, closed: true, points: asm.map(p => p.map(r6))});
    const size = Math.max(.3, Math.min(1, (x1 - x0) / 11, (y1 - y0) * .5));
    fp.shapes.push({kind: "text", text: ".Designator", layer: "Mechanical 13", x: r6((x0 + x1) / 2), y: r6((y0 + y1) / 2 + size * .35), size: r6(size), align: "center"});
    if (o.silk !== false) fp.shapes.push(...silkOutline(o.silkBody || body, fp.pads, o));
    if (o.pin1) fp.shapes.push({kind: "circle", style: "silk", x: r6(o.pin1[0]), y: r6(o.pin1[1]), r: .1, fill: true});
    fp.courtyard = c;
  }
  // A silk pin-1 dot just outside the toe of pad 1, on its outer side.
  function pin1Dot(p, side = "left") {
    const b = padBox(p), d = .35;
    if (side === "left") return [b[0] - d, p.y];
    if (side === "top") return [p.x, b[1] - d];
    return [b[0] - d, b[1] - d];
  }

  // ------------------------------------------------------------------ names
  // IPC name fields: hundredths (or tenths) of a millimetre, halves rounded down (1.25 -> "12").
  const n2 = (v, scale = 100) => String(Math.floor(v * scale + .5 - 1e-6)).padStart(scale === 10 ? 2 : 1, "0");
  const lvl = s => LEVEL[s.density] || "N";
  function heightCode(h) { return n2(h, 100); }

  // ------------------------------------------------------------------ families
  // Chip sizes (EIA inch code -> body L×W, terminal T, height). 0402–2512: IPC-SM-782 resistor
  // outlines (pages 72–76) as published in KiCad's resistor_chip.yaml / resistor_chip_smaller_0603.yaml
  // (2026-11-19); with them the wizard reproduces KiCad's R_0402…R_1206 lands exactly. 0201: typical
  // datasheet values (flagged). Heights are typical maxima.
  const SM782 = "IPC-SM-782 chip resistor outline (as in KiCad resistor_chip.yaml)";
  const CHIPS = {
    "0201": {L: {min: .57, max: .63}, W: {min: .27, max: .33}, T: {min: .1, max: .2}, H: .26, source: "Typical 0201 chip datasheet", flag: "0201 body and terminal ranges are typical datasheet values, not checked against an outline."},
    "0402": {L: {min: 1, max: 1.1}, W: {min: .48, max: .6}, T: {min: .1, max: .3}, H: .35, source: SM782},
    "0603": {L: {min: 1.5, max: 1.7}, W: {min: .7, max: .95}, T: {min: .15, max: .4}, H: .55, source: SM782},
    "0805": {L: {min: 1.85, max: 2.15}, W: {min: 1.1, max: 1.4}, T: {min: .15, max: .65}, H: .7, source: SM782},
    "1206": {L: {min: 3.05, max: 3.35}, W: {min: 1.45, max: 1.75}, T: {min: .25, max: .75}, H: .7, source: SM782},
    "1210": {L: {min: 3.05, max: 3.35}, W: {min: 2.34, max: 2.64}, T: {min: .25, max: .75}, H: .7, source: SM782},
    "1812": {L: {min: 4.3, max: 4.7}, W: {min: 3, max: 3.4}, T: {min: .3, max: .7}, H: .8, source: SM782},
    "2010": {L: {min: 4.85, max: 5.15}, W: {min: 2.35, max: 2.65}, T: {min: .35, max: .85}, H: .7, source: SM782},
    "2512": {L: {min: 6.15, max: 6.45}, W: {min: 3.05, max: 3.35}, T: {min: .35, max: .85}, H: .7, source: SM782}
  };
  // Gull-wing and no-lead presets. `source` names the outline each range was checked against on
  // 2026-11-19. JEDEC's own documents need a login, so the check uses the makers' public outline
  // drawings that cite the JEDEC outline (NXP SOT…) and KiCad's JEDEC-cited size definitions; where
  // a maker draws a tighter range than JEDEC (e.g. NXP SO8 bp 0.36–0.49 vs MS-012 b 0.31–0.51) the
  // JEDEC range is kept. Ranges no public outline confirmed carry a flag.
  const UNVERIFIED = "Not checked against a public outline drawing (JEDEC documents need a login); check the datasheet.";
  const GULL = {
    "SOIC-8":   {style: "SOIC", pins: 8, pitch: 1.27, L: {min: 5.8, max: 6.2}, T: {min: .4, max: 1.27}, W: {min: .31, max: .51}, D: {min: 4.8, max: 5}, E: {min: 3.8, max: 4}, H: 1.75, source: "JEDEC MS-012AA (as cited in KiCad soic.yaml); NXP SOT96-1 (MS-012) lies within"},
    "SOIC-14":  {style: "SOIC", pins: 14, pitch: 1.27, L: {min: 5.8, max: 6.2}, T: {min: .4, max: 1.27}, W: {min: .31, max: .51}, D: {min: 8.55, max: 8.75}, E: {min: 3.8, max: 4}, H: 1.75, source: "JEDEC MS-012AB (as cited in KiCad soic.yaml)"},
    "SOIC-16W": {style: "SOIC", pins: 16, pitch: 1.27, L: {min: 10, max: 10.65}, T: {min: .4, max: 1.27}, W: {min: .31, max: .51}, D: {min: 10.1, max: 10.5}, E: {min: 7.4, max: 7.6}, H: 2.65, source: "JEDEC MS-013AA; lead span as NXP SOT163-1 (MS-013)"},
    "SSOP-20":  {style: "SOP", pins: 20, pitch: .65, L: {min: 7.4, max: 8.2}, T: {min: .55, max: .95}, W: {min: .22, max: .38}, D: {min: 7.07, max: 7.33}, E: {min: 5, max: 5.6}, H: 2, source: "JEDEC MO-150AE", flag: UNVERIFIED},
    "TSSOP-14": {style: "SOP", pins: 14, pitch: .65, L: {min: 6.2, max: 6.6}, T: {min: .5, max: .75}, W: {min: .19, max: .3}, D: {min: 4.9, max: 5.1}, E: {min: 4.3, max: 4.5}, H: 1.2, source: "NXP SOT402-1 (JEDEC MO-153AB-1); height MO-153 A max 1.20"},
    "TSSOP-20": {style: "SOP", pins: 20, pitch: .65, L: {min: 6.2, max: 6.6}, T: {min: .5, max: .75}, W: {min: .19, max: .3}, D: {min: 6.4, max: 6.6}, E: {min: 4.3, max: 4.5}, H: 1.2, source: "NXP SOT360-1 (JEDEC MO-153AC); height MO-153 A max 1.20"},
    "LQFP-48":  {style: "QFP", pins: 48, pitch: .5, L: {min: 8.85, max: 9.15}, T: {min: .45, max: .75}, W: {min: .17, max: .27}, D: {min: 6.9, max: 7.1}, E: {min: 6.9, max: 7.1}, H: 1.6, source: "NXP SOT313-2 (JEDEC MS-026BBC)"},
    "LQFP-64":  {style: "QFP", pins: 64, pitch: .5, L: {min: 11.85, max: 12.15}, T: {min: .45, max: .75}, W: {min: .17, max: .27}, D: {min: 9.9, max: 10.1}, E: {min: 9.9, max: 10.1}, H: 1.6, source: "NXP SOT314-2 (JEDEC MS-026BCD)"},
    "LQFP-100": {style: "QFP", pins: 100, pitch: .5, L: {min: 15.75, max: 16.25}, T: {min: .45, max: .75}, W: {min: .17, max: .27}, D: {min: 13.9, max: 14.1}, E: {min: 13.9, max: 14.1}, H: 1.6, source: "NXP SOT407-1 (JEDEC MS-026BED)"}
  };
  const NOLEAD = {
    "QFN-16 3×3": {style: "QFN", pins: 16, pitch: .5, D: {min: 2.9, max: 3.1}, E: {min: 2.9, max: 3.1}, T: {min: .3, max: .5}, W: {min: .18, max: .3}, EP: {D: {min: 1.45, max: 1.75}, E: {min: 1.45, max: 1.75}}, H: {min: .8, max: 1}, source: "NXP SOT758-1 HVQFN16 (JEDEC MO-220)"},
    "QFN-32 5×5": {style: "QFN", pins: 32, pitch: .5, D: {min: 4.9, max: 5.1}, E: {min: 4.9, max: 5.1}, T: {min: .3, max: .5}, W: {min: .18, max: .3}, EP: {D: {min: 2.95, max: 3.25}, E: {min: 2.95, max: 3.25}}, H: {min: .8, max: 1}, vias: true, source: "NXP SOT617-1 HVQFN32 (JEDEC MO-220)"},
    "QFN-48 7×7": {style: "QFN", pins: 48, pitch: .5, D: {min: 6.9, max: 7.1}, E: {min: 6.9, max: 7.1}, T: {min: .3, max: .5}, W: {min: .18, max: .3}, EP: {D: {min: 4.95, max: 5.25}, E: {min: 4.95, max: 5.25}}, H: {min: .8, max: 1}, vias: true, source: "NXP SOT619-1 HVQFN48 (JEDEC MO-220)"},
    "DFN-8 3×3":  {style: "SON", pins: 8, pitch: .65, D: {min: 2.9, max: 3.1}, E: {min: 2.9, max: 3.1}, T: {min: .3, max: .5}, W: {min: .25, max: .35}, EP: {D: {min: 2.3, max: 2.5}, E: {min: 1.5, max: 1.7}}, H: {min: .7, max: .8}, source: "JEDEC MO-229 (WSON/VSON 3 × 3)", flag: UNVERIFIED},
    "DFN-6 2×2":  {style: "SON", pins: 6, pitch: .65, D: {min: 1.9, max: 2.1}, E: {min: 1.9, max: 2.1}, T: {min: .2, max: .4}, W: {min: .25, max: .35}, EP: {D: {min: 1.5, max: 1.7}, E: {min: .8, max: 1}}, H: {min: .7, max: .8}, source: "JEDEC MO-229 (WSON 2 × 2)", flag: UNVERIFIED}
  };

  const FAMILIES = [
    {id: "chip", title: "Chip R / C / L (0201–2512)", presets: Object.keys(CHIPS)},
    {id: "melf", title: "MELF (cylindrical)", presets: ["MicroMELF", "MiniMELF", "MELF"]},
    {id: "sod", title: "SOD (two-lead)", presets: ["SOD-123", "SOD-323", "SOD-523"]},
    {id: "sot23", title: "SOT-23 / -5 / -6", presets: ["SOT-23-3", "SOT-23-5", "SOT-23-6"]},
    {id: "sot223", title: "SOT-223", presets: ["SOT-223"]},
    {id: "gullwing", title: "SOIC / SSOP / TSSOP / QFP (gull-wing)", presets: Object.keys(GULL)},
    {id: "nolead", title: "QFN / DFN (no-lead, exposed pad)", presets: Object.keys(NOLEAD)},
    {id: "bga", title: "BGA (full or depopulated)", presets: ["BGA-64 0.8", "BGA-256 1.0", "BGA-144 0.8 (perimeter)"]},
    {id: "header", title: "Through-hole header", presets: ["1×6 2.54", "2×5 2.54", "1×4 2.00", "2×10 1.27"]},
    {id: "dip", title: "DIP (through-hole)", presets: ["DIP-8", "DIP-14", "DIP-16", "DIP-18", "DIP-20", "DIP-24", "DIP-28 wide", "DIP-24 wide", "DIP-40 wide"]},
    {id: "smdheader", title: "SMD header", presets: ["2×5 1.27 SMD", "2×10 2.54 SMD"]}
  ];

  function defaults(family, preset) {
    const base = {family, density: "B", fab: .1, place: .05, padShape: "roundrect"};
    switch (family) {
      case "chip": { const k = CHIPS[preset] ? preset : "0603", c = CHIPS[k]; return {...base, preset: k, kind: "RES", ...structuredCopy(c)}; }
      case "melf": {
        const m = {MicroMELF: {L: {min: 1.9, max: 2.1}, D: {min: 1.05, max: 1.15}, T: {min: .2, max: .3}}, MiniMELF: {L: {min: 3.3, max: 3.7}, D: {min: 1.4, max: 1.6}, T: {min: .25, max: .5}},
          MELF: {L: {min: 4.8, max: 5.2}, D: {min: 2.4, max: 2.6}, T: {min: .4, max: .6}}};
        const k = m[preset] ? preset : "MiniMELF";
        // Height = the largest body diameter, so the 3D body is a full cylinder.
        return {...base, preset: k, kind: "DIO", ...m[k], H: m[k].D.max};
      }
      case "sod": {
        const s = {"SOD-123": {L: {min: 3.55, max: 3.85}, T: {min: .25, max: .6}, W: {min: .45, max: .65}, D: {min: 2.55, max: 2.85}, E: {min: 1.4, max: 1.7}, H: 1.35},
          "SOD-323": {L: {min: 2.3, max: 2.7}, T: {min: .2, max: .45}, W: {min: .25, max: .4}, D: {min: 1.6, max: 1.8}, E: {min: 1.15, max: 1.35}, H: 1.1},
          "SOD-523": {L: {min: 1.5, max: 1.7}, T: {min: .15, max: .3}, W: {min: .25, max: .35}, D: {min: 1.15, max: 1.25}, E: {min: .75, max: .85}, H: .7}};
        const k = s[preset] ? preset : "SOD-123";
        return {...base, preset: k, ...s[k]};
      }
      case "sot23": {
        const k = ["SOT-23-3", "SOT-23-5", "SOT-23-6"].includes(preset) ? preset : "SOT-23-3", three = k === "SOT-23-3";
        return {...base, preset: k, pins: +k.slice(-1), pitch: .95, L: three ? {min: 2.1, max: 2.64} : {min: 2.6, max: 3}, T: {min: .3, max: .6}, W: {min: .3, max: .5},
          D: {min: 2.8, max: 3.04}, E: three ? {min: 1.2, max: 1.4} : {min: 1.5, max: 1.7}, H: three ? 1.12 : 1.45,
          source: three ? "JEDEC TO-236AB" : "JEDEC MO-178" + (k === "SOT-23-5" ? "AA" : "AB") + " (lead length 0.30–0.60 and width 0.30–0.50 as in KiCad sot.yaml)",
          flag: three ? UNVERIFIED : "Lead span 2.60–3.00 not checked against MO-178 (KiCad uses 2.80 BSC); check the datasheet."};
      }
      case "sot223": return {...base, preset: "SOT-223", pitch: 2.3, L: {min: 6.7, max: 7.3}, T: {min: .75, max: 1.1}, W: {min: .6, max: .84}, tab: {min: 2.9, max: 3.1},
        D: {min: 6.3, max: 6.7}, E: {min: 3.3, max: 3.7}, H: 1.8};
      case "gullwing": { const k = GULL[preset] ? preset : "SOIC-8"; return {...base, preset: k, ...structuredCopy(GULL[k])}; }
      case "nolead": {
        const k = NOLEAD[preset] ? preset : "QFN-32 5×5", q = structuredCopy(NOLEAD[k]);
        const vias = q.vias; delete q.vias;
        // Thermal-via land 0.70 on a 0.30 drill: a 0.20 mm ring, above JLCPCB's 0.18 mm PTH minimum
        // (a 0.50 land, the earlier default, failed DFM "Annular ring" on the JLCPCB presets).
        return {...base, preset: k, ...q, pasteCoverage: .6, thermalVias: vias ? {drill: .3, pitch: 1.2, pad: .7} : null};
      }
      case "bga": {
        const b = {"BGA-64 0.8": {rows: 8, cols: 8, pitch: .8, ball: .4, D: 7, E: 7, H: 1.2, depop: ""},
          "BGA-256 1.0": {rows: 16, cols: 16, pitch: 1, ball: .5, D: 17, E: 17, H: 1.7, depop: ""},
          "BGA-144 0.8 (perimeter)": {rows: 15, cols: 15, pitch: .8, ball: .4, D: 13, E: 13, H: 1.4, depop: "center:9"}};
        const k = b[preset] ? preset : "BGA-64 0.8";
        return {...base, preset: k, padShape: "round", ...b[k]};
      }
      case "header": {
        const h = {"1×6 2.54": {rows: 1, cols: 6, pitch: 2.54, lead: .64}, "2×5 2.54": {rows: 2, cols: 5, pitch: 2.54, lead: .64},
          "1×4 2.00": {rows: 1, cols: 4, pitch: 2, lead: .5}, "2×10 1.27": {rows: 2, cols: 10, pitch: 1.27, lead: .4}};
        const k = h[preset] ? preset : "1×6 2.54", p = h[k];
        return {...base, preset: k, padShape: "round", ...p, squareLead: true, H: p.pitch === 2.54 ? 8.5 : 6, numbering: "zigzag"};
      }
      case "dip": {
        const k = /^DIP-([1-9]\d?)( wide)?$/.test(preset || "") && !(parseInt(preset.slice(4), 10) % 2) ? preset : "DIP-8", pins = parseInt(k.slice(4), 10), wide = /wide/.test(k);
        return {...base, preset: k, padShape: "oval", pins, pitch: 2.54, span: wide ? 15.24 : 7.62, lead: {min: .36, max: .56}, D: pins * 1.27 + .9, E: wide ? 13.7 : 6.35, H: wide ? 5.1 : 5.33};
      }
      case "smdheader": {
        const k = preset === "2×10 2.54 SMD" ? preset : "2×5 1.27 SMD", wide = k.startsWith("2×10");
        return {...base, preset: k, rows: 2, cols: wide ? 10 : 5, pitch: wide ? 2.54 : 1.27, L: wide ? {min: 7.8, max: 8.2} : {min: 4.9, max: 5.3}, T: wide ? {min: 1.6, max: 2} : {min: 1, max: 1.4},
          W: wide ? {min: .59, max: .69} : {min: .35, max: .45}, E: wide ? 5.08 : 3.4, H: wide ? 8.5 : 4.5};
      }
    }
    if (EXT[family]) return {...base, ...structuredCopy(EXT[family].defaults(preset)), family};
    throw Error("Unknown package family " + family + ".");
  }
  function structuredCopy(v) { return JSON.parse(JSON.stringify(v)); }

  // BGA land: nominal ball diameter reduced per IPC-7351B Table 3-17 (collapsing balls).
  // FLAG: reductions recalled as 25 % (≥0.55 mm), 20 % (0.40–0.55 mm), 15 % (<0.40 mm).
  function bgaLand(ball, collapsing = true) {
    const r = !collapsing ? -.05 : ball >= .55 ? .25 : ball >= .4 ? .2 : .15;
    return near(ball * (1 - r), .05) || near(ball * (1 - r), .01);
  }
  // JEDEC ball rows skip I, O, Q, S, X and Z; after Y come AA, AB...
  const ROWS = "ABCDEFGHJKLMNPRTUVWY";
  function rowName(i) { let s = "", n = i; do { s = ROWS[n % ROWS.length] + s; n = Math.floor(n / ROWS.length) - 1; } while (n >= 0); return s; }
  // Depopulation: "", "center:N" (empty N×N centre), or a list such as "A1, B2, C3-C5".
  function depopulated(spec) {
    const out = new Set(), text = String(spec.depop || "").trim();
    if (!text) return out;
    const m = /^cent(?:er|re)\s*:\s*(\d+)$/i.exec(text);
    if (m) {
      const n = +m[1], r0 = Math.floor((spec.rows - n) / 2), c0 = Math.floor((spec.cols - n) / 2);
      for (let r = r0; r < r0 + n; r++) for (let c = c0; c < c0 + n; c++) out.add(rowName(r) + (c + 1));
      return out;
    }
    // Tokens: "A1", "C3-C5" (a row run), "A1-C3" (a rectangle of rows A..C, columns 1..3).
    out.invalid = [];
    for (const tok of text.split(/[\s,;]+/).filter(Boolean)) {
      const one = /^([A-Z]+)(\d+)$/i.exec(tok), range = /^([A-Z]+)(\d+)-([A-Z]+)?(\d+)$/i.exec(tok);
      if (one && rowIndex(one[1]) >= 0) { out.add(one[1].toUpperCase() + +one[2]); continue; }
      if (range) {
        const r0 = rowIndex(range[1]), r1 = range[3] ? rowIndex(range[3]) : r0, c0 = +range[2], c1 = +range[4];
        if (r0 >= 0 && r1 >= 0 && c0 > 0 && c1 > 0) {
          for (let r = Math.min(r0, r1); r <= Math.max(r0, r1); r++) for (let c = Math.min(c0, c1); c <= Math.max(c0, c1); c++) out.add(rowName(r) + c);
          continue;
        }
      }
      out.invalid.push(tok);
    }
    return out;
  }
  // Inverse of rowName ("A" -> 0, "Y" -> 19, "AA" -> 20); -1 for letters JEDEC skips.
  function rowIndex(name) {
    const s = String(name).toUpperCase();
    let n = 0;
    for (const ch of s) { const k = ROWS.indexOf(ch); if (k < 0) return -1; n = n * ROWS.length + k + 1; }
    return n - 1;
  }

  // Through-hole land for a lead (diagonal for square posts): hole = lead + allowance (rounded up to
  // 0.05), land = hole + 2 × annular ring. The ring never drops below RING_MIN (0.20 mm: JLCPCB's
  // 2-layer PTH minimum is 0.18 mm, fab-presets/jlcpcb.json "pthRing"). The land is kept 0.25 mm
  // from its neighbour; at fine pitch (1.27 mm headers) the hole allowance drops to 0.10 mm first,
  // then the copper gap may drop to 0.15 mm, so the ring stays fabricable.
  const RING_MIN = .2;
  function thtLand(lead, pitch, g, o = {}) {
    let hole = up(lead + g.hole, .05), note = "";
    const room = pitch > 0 ? pitch : 99, gapLand = r6(Math.floor((room - .25) / .05 + 1e-9) * .05);
    if (o.minHole) hole = Math.max(hole, o.minHole);
    if (hole + 2 * RING_MIN > room - .15 + 1e-9) {
      const tight = Math.max(o.minHole || 0, up(lead + .1, .05));
      if (tight < hole) { note = "Hole allowance reduced to 0.10 mm over the lead at " + room + " mm pitch, to keep a " + RING_MIN.toFixed(2) + " mm annular ring."; hole = tight; }
    }
    const land = Math.max(up(hole + 2 * RING_MIN, .05), Math.min(up(hole + 2 * g.annular, .05), gapLand));
    return {hole: r6(hole), land: r6(land), note};
  }

  // Exposed (thermal) pad: nominal size, paste reduced to the coverage asked for (default 60 %,
  // IPC-7525 suggests 50–80 %), stored both as a pad paste expansion (so Gerber paste carries the
  // right area) and as a grid of paste windows (spec.pasteWindows = [nx, ny] overrides the grid).
  // An optional thermal-via array (spec.thermalVias {drill, pitch, pad, tent}) shares the pad number.
  function exposedPad(fp, spec, num, ipc, at = [0, 0]) {
    const ed = tol(spec.EP.D, "exposed pad length"), ee = tol(spec.EP.E ?? spec.EP.D, "exposed pad width");
    const w = near(ee.nom, .01), h = near(ed.nom, .01);
    const cov = Math.max(.2, Math.min(1, spec.pasteCoverage ?? .6));
    const shrink = r6(-((w + h) - Math.sqrt((w + h) ** 2 - 4 * (1 - cov) * w * h)) / 4);
    const ep = pad(num, at[0], at[1], w, h, "rect", {thermal: true, pasteExpansion: shrink});
    const cells = Math.max(1, Math.round(Math.max(w, h) / 1.2));
    let gx = Math.max(1, Math.round(w / Math.max(w, h) * cells)), gy = Math.max(1, Math.round(h / Math.max(w, h) * cells));
    if (Array.isArray(spec.pasteWindows)) { gx = Math.max(1, Math.min(12, spec.pasteWindows[0] | 0)); gy = Math.max(1, Math.min(12, spec.pasteWindows[1] | 0)); }
    const k = Math.sqrt(cov), cw = w / gx, chh = h / gy;
    ep.pasteApertures = [];
    for (let i = 0; i < gx; i++) for (let j = 0; j < gy; j++) ep.pasteApertures.push({x: r6(-w / 2 + cw * (i + .5)), y: r6(-h / 2 + chh * (j + .5)), w: r6(cw * k), h: r6(chh * k)});
    fp.pads.push(ep);
    const tv = spec.thermalVias;
    if (tv && tv.drill > 0) {
      // Vias stay inside the pad by their land plus 0.1 mm, so their holes keep clear of the terminals.
      const pitchV = tv.pitch || 1.2, d = tv.pad || r6(tv.drill + 2 * RING_MIN), nx = Math.max(1, Math.floor((w - d - .2) / pitchV) + 1), ny = Math.max(1, Math.floor((h - d - .2) / pitchV) + 1);
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const x = at[0] + (i - (nx - 1) / 2) * pitchV, y = at[1] + (j - (ny - 1) / 2) * pitchV;
        fp.pads.push({...thPad(num, x, y, d, tv.drill), thermalVia: true, maskExpansion: tv.tent === false ? undefined : -d / 2});
      }
      ipc.thermalVias = nx * ny;
    }
    ipc.paste = {coverage: cov, expansion: shrink, windows: ep.pasteApertures.length};
    return ep;
  }

  // ------------------------------------------------------------------ generation
  // Lands may not close the copper gap between neighbours: clamp X to pitch − minGap (0.10 mm
  // default; spec.clampWidth = false keeps the raw IPC value and leaves the check to report it).
  function clampWidth(r, pitch, spec, flagged) {
    const gap = spec.minGap ?? .1;
    if (spec.clampWidth === false || !(pitch > 0) || !r) return;
    const max = r6(Math.floor((pitch - gap) / .01 + 1e-9) * .01);
    if (r.X > max + 1e-9 && max > 0) { flagged.push("Land width clamped from " + r.X.toFixed(2) + " to " + max.toFixed(2) + " mm to keep a " + gap.toFixed(2) + " mm copper gap at " + pitch + " mm pitch."); r.X = max; }
  }

  function generate(input) {
    const spec = {...defaults(input.family, input.preset), ...input};
    const density = lvl(spec), opts = {fab: spec.fab, place: spec.place, roundOff: roundOffOf(spec)};
    const fp = {name: "", pads: [], shapes: []};
    let ipc = {family: spec.family, density}, prefix = "U", name, flagged = [];
    const shape = spec.padShape || "roundrect";
    const H = spec.H != null ? tol(spec.H, "height") : null;
    const height = H ? H.max : null;
    // Families from footprint-packages.js either reuse a built-in generator (ext.base) with their
    // own presets, or generate here (ext.generate) with the same helpers and finish().
    const ext = EXT[spec.family], fam = ext?.base || spec.family;
    switch (fam) {
      case "chip": {
        const L = tol(spec.L, "body length"), W = tol(spec.W, "body width");
        const small = L.nom < 1.55, g = goal(small ? "chipSmall" : "chip", density);
        if (g.flagged) flagged.push(g.flagged);
        const r = lands({L: spec.L, W: spec.W, T: spec.T, S: spec.S}, g, opts);
        fp.pads.push(pad(1, -r.padCentre, 0, r.padLength, r.X, shape), pad(2, r.padCentre, 0, r.padLength, r.X, shape));
        const body = [-L.nom / 2, -W.nom / 2, L.nom / 2, W.nom / 2];
        const kind = ["RES", "CAP", "IND", "DIO", "LED", "FUS"].includes(spec.kind) ? spec.kind : "RES";
        // Diodes and LEDs (pin 1 cathode) and polarised capacitors (spec.polar, pin 1 +) mark pad 1, as MELF and SOD do.
        const polar = kind === "DIO" || kind === "LED" || spec.polar === true;
        dressing(fp, [-L.max / 2, -W.max / 2, L.max / 2, W.max / 2], g, {chamfer: false, silkBody: body, pin1: polar ? pin1Dot(fp.pads[0]) : null});
        if (polar) fp.shapes.push({kind: "path", layer: "Mechanical 13", width: .1, points: [[r6(-L.nom / 2 + L.nom * .2), r6(-W.nom / 2)], [r6(-L.nom / 2 + L.nom * .2), r6(W.nom / 2)]]});
        prefix = {RES: "R", CAP: "C", IND: "L", DIO: "D", LED: "D", FUS: "F"}[kind];
        name = kind + "C" + n2(L.nom, 10).padStart(2, "0") + n2(W.nom, 10).padStart(2, "0") + "X" + heightCode(height ?? .5) + density;
        ipc = {...ipc, ...r, goal: g};
        break;
      }
      case "melf": {
        const L = tol(spec.L, "body length"), D = tol(spec.D, "diameter"), g = goal("melf", density);
        flagged.push(g.flagged);
        const r = lands({L: spec.L, W: spec.D, T: spec.T}, g, opts);
        fp.pads.push(pad(1, -r.padCentre, 0, r.padLength, r.X, shape), pad(2, r.padCentre, 0, r.padLength, r.X, shape));
        const kind = spec.kind === "RES" ? "RES" : "DIO";
        dressing(fp, [-L.max / 2, -D.max / 2, L.max / 2, D.max / 2], g, {chamfer: false, silkBody: [-L.nom / 2, -D.nom / 2, L.nom / 2, D.nom / 2], pin1: kind === "DIO" ? pin1Dot(fp.pads[0]) : null});
        if (kind === "DIO") fp.shapes.push({kind: "path", layer: "Mechanical 13", width: .1, points: [[r6(-L.nom / 2 + L.nom * .2), r6(-D.nom / 2)], [r6(-L.nom / 2 + L.nom * .2), r6(D.nom / 2)]]});
        prefix = kind === "RES" ? "R" : "D";
        name = kind + "MELF" + n2(L.nom, 10) + n2(D.nom, 10) + density;
        ipc = {...ipc, ...r, goal: g};
        return finish();
      }
      case "sod": {
        const g = goal("gullwing", density);
        const r = lands({L: spec.L, W: spec.W, T: spec.T}, g, opts);
        fp.pads.push(pad(1, -r.padCentre, 0, r.padLength, r.X, shape), pad(2, r.padCentre, 0, r.padLength, r.X, shape));
        // Body is D (length, along the leads) × E (width).
        const d = tol(spec.D, "body length"), e = tol(spec.E, "body width");
        dressing(fp, [-d.max / 2, -e.max / 2, d.max / 2, e.max / 2], g, {silkBody: [-d.nom / 2, -e.nom / 2, d.nom / 2, e.nom / 2], pin1: pin1Dot(fp.pads[0])});
        fp.shapes.push({kind: "path", layer: "Mechanical 13", width: .1, points: [[r6(-d.nom / 4), r6(-e.nom / 2)], [r6(-d.nom / 4), r6(e.nom / 2)]]});
        prefix = "D";
        name = "SOD" + n2(tol(spec.L).nom, 10) + n2(e.nom, 10) + "X" + heightCode(height) + density;
        ipc = {...ipc, ...r, goal: g};
        return finish();
      }
      case "sot23": case "sot223": case "gullwing": case "smdheader": {
        const pitch = spec.pitch, g = goal(pitch <= .625 ? "gullwingFine" : "gullwing", density);
        const r = lands({L: spec.L, W: spec.W, T: spec.T, heelReduction: spec.heelReduction}, g, opts);
        if (fam !== "sot223") clampWidth(r, pitch, spec, flagged);
        // Exposed pad across x (dual and quad packages): the side lands keep their clearance from it.
        if (spec.EP && fam === "gullwing") epClear(r, tol(spec.EP.E ?? spec.EP.D).nom, spec, flagged);
        ipc = {...ipc, ...r, goal: g};
        if (fam === "sot223") {
          const rt = lands({L: spec.L, W: spec.tab, T: spec.T}, g, opts);
          [-1, 0, 1].forEach((k, i) => fp.pads.push(pad(i + 1, -r.padCentre, k * pitch, r.padLength, r.X, shape)));
          fp.pads.push(pad(4, r.padCentre, 0, r.padLength, rt.X, shape));
          ipc.tabX = rt.X;
          prefix = "U";
          name = "SOT" + n2(pitch, 100) + "P" + n2(tol(spec.L).nom, 100) + "X" + heightCode(height) + "-4" + density;
        } else if (fam === "sot23") {
          const n = spec.pins;
          const left = n === 3 ? [[1, -1], [2, 1]] : n === 8 ? [[1, -1.5], [2, -.5], [3, .5], [4, 1.5]] : [[1, -1], [2, 0], [3, 1]];
          const right = n === 3 ? [[3, 0]] : n === 5 ? [[4, 1], [5, -1]] : n === 8 ? [[5, 1.5], [6, .5], [7, -.5], [8, -1.5]] : [[4, 1], [5, 0], [6, -1]];
          if (![3, 5, 6, 8].includes(n)) throw Error("A SOT-23 style package has 3, 5, 6 or 8 pins.");
          for (const [num, k] of left) fp.pads.push(pad(num, -r.padCentre, k * pitch, r.padLength, r.X, shape));
          for (const [num, k] of right) fp.pads.push(pad(num, r.padCentre, k * pitch, r.padLength, r.X, shape));
          prefix = n === 3 ? "Q" : "U";
          name = "SOT" + n2(pitch, 100) + "P" + n2(tol(spec.L).nom, 100) + "X" + heightCode(height) + "-" + n + density;
        } else if (fam === "smdheader") {
          const cols = spec.cols, rows = spec.rows === 1 ? 1 : 2;
          for (let c = 0; c < cols; c++) {
            const y = (c - (cols - 1) / 2) * pitch;
            if (rows === 2) { fp.pads.push(pad(2 * c + 1, -r.padCentre, y, r.padLength, r.X, "rect")); fp.pads.push(pad(2 * c + 2, r.padCentre, y, r.padLength, r.X, "rect")); }
            else fp.pads.push(pad(c + 1, c % 2 ? r.padCentre : -r.padCentre, y, r.padLength, r.X, "rect"));
          }
          prefix = "J";
          name = "HDRSMD" + rows * cols + "P" + n2(pitch, 100) + "_" + rows + "X" + cols + "_" + n2(tol(spec.L).nom, 100) + "X" + heightCode(height) + density;
        } else {
          const n = spec.pins, quad = spec.style === "QFP";
          if (quad) {
            // spec.perSide = [pins on the left/right sides, pins on the top/bottom] for rectangular QFPs.
            const [perY, perX] = Array.isArray(spec.perSide) ? spec.perSide.map(v => v | 0) : [n / 4, n / 4];
            if (spec.perSide ? 2 * (perY + perX) !== n || !(perY > 0 && perX > 0) : n % 4) throw Error("A quad flat pack needs a pin count divisible by four (or pins per side that add up).");
            const Ly = spec.L2 ?? spec.L, ry = lands({L: Ly, W: spec.W, T: spec.T, heelReduction: spec.heelReduction}, g, opts);
            clampWidth(ry, pitch, spec, []);
            if (spec.EP) epClear(ry, tol(spec.EP.D).nom, spec, flagged);
            let num = 1;
            for (let i = 0; i < perY; i++) fp.pads.push(pad(num++, -r.padCentre, (i - (perY - 1) / 2) * pitch, r.padLength, r.X, shape));
            for (let i = 0; i < perX; i++) fp.pads.push(pad(num++, (i - (perX - 1) / 2) * pitch, ry.padCentre, ry.X, ry.padLength, shape));
            for (let i = 0; i < perY; i++) fp.pads.push(pad(num++, r.padCentre, ((perY - 1) / 2 - i) * pitch, r.padLength, r.X, shape));
            for (let i = 0; i < perX; i++) fp.pads.push(pad(num++, ((perX - 1) / 2 - i) * pitch, -ry.padCentre, ry.X, ry.padLength, shape));
            const ep = spec.EP ? (exposedPad(fp, spec, String(spec.EPnumber ?? n + 1), ipc), 1) : 0;
            name = (spec.ipcPrefix || "QFP") + n2(pitch, 100) + "P" + n2(tol(spec.L).nom, 100) + "X" + n2(tol(Ly).nom, 100) + "X" + heightCode(height) + "-" + (n + ep) + density;
          } else {
            if (n % 2) throw Error("A dual package needs an even pin count.");
            const per = n / 2;
            for (let i = 0; i < per; i++) fp.pads.push(pad(i + 1, -r.padCentre, (i - (per - 1) / 2) * pitch, r.padLength, r.X, shape));
            for (let i = 0; i < per; i++) fp.pads.push(pad(per + i + 1, r.padCentre, ((per - 1) / 2 - i) * pitch, r.padLength, r.X, shape));
            const ep = spec.EP ? (exposedPad(fp, spec, String(spec.EPnumber ?? n + 1), ipc), 1) : 0;
            const style = spec.ipcPrefix || (spec.style === "SOIC" ? "SOIC" : "SOP");
            name = style + n2(pitch, 100) + "P" + n2(tol(spec.L).nom, 100) + "X" + heightCode(height) + "-" + (n + ep) + density;
          }
          prefix = "U";
        }
        // Body: E across the leads (x), D along the rows (y). QFP bodies are E × D.
        const d = tol(spec.D ?? (fam === "smdheader" ? r6(spec.cols * spec.pitch) : undefined), "body length"), e = tol(spec.E ?? spec.D, "body width");
        const bodyMax = [-e.max / 2, -d.max / 2, e.max / 2, d.max / 2], bodyNom = [-e.nom / 2, -d.nom / 2, e.nom / 2, d.nom / 2];
        dressing(fp, bodyMax, g, {silkBody: bodyNom, pin1: pin1Dot(fp.pads[0], "left")});
        break;
      }
      case "nolead": {
        // goalTable: "nolead" (toe fillet), "noleadPullBack" (pull-back terminals, PQFN/PSON) or
        // "bottom" (bottom-only terminations, LGA). Lt / Lt2: terminal spans when the terminals are
        // pulled back from the body edge (default: the body).
        const g = goal(spec.goalTable || "nolead", density), pitch = spec.pitch, n = spec.pins;
        if (g.flagged) flagged.push(g.flagged);
        const D = tol(spec.D, "body length"), E = tol(spec.E ?? spec.D, "body width");
        // Terminals sit at the body edge: L is the body, S follows from the terminal length.
        const hr = spec.heelReduction;
        const rx = lands({L: spec.Lt ?? spec.E ?? spec.D, W: spec.W, T: spec.T, heelReduction: hr}, g, opts), ry = lands({L: spec.Lt2 ?? spec.Lt ?? spec.D, W: spec.W, T: spec.T, heelReduction: hr}, g, opts);
        clampWidth(rx, pitch, spec, flagged); clampWidth(ry, pitch, spec, []);
        if (spec.EP) { epClear(rx, tol(spec.EP.E ?? spec.EP.D).nom, spec, flagged); epClear(ry, tol(spec.EP.D).nom, spec, flagged); }
        ipc = {...ipc, ...rx, goal: g};
        const quad = spec.style !== "SON";
        if (quad) {
          if (n % 4) throw Error("A QFN needs a pin count divisible by four.");
          const per = n / 4;
          let num = 1;
          for (let i = 0; i < per; i++) fp.pads.push(pad(num++, -rx.padCentre, (i - (per - 1) / 2) * pitch, rx.padLength, rx.X, shape));
          for (let i = 0; i < per; i++) fp.pads.push(pad(num++, (i - (per - 1) / 2) * pitch, ry.padCentre, ry.X, ry.padLength, shape));
          for (let i = 0; i < per; i++) fp.pads.push(pad(num++, rx.padCentre, ((per - 1) / 2 - i) * pitch, rx.padLength, rx.X, shape));
          for (let i = 0; i < per; i++) fp.pads.push(pad(num++, ((per - 1) / 2 - i) * pitch, -ry.padCentre, ry.X, ry.padLength, shape));
        } else {
          if (n % 2) throw Error("A DFN needs an even pin count.");
          const per = n / 2;
          for (let i = 0; i < per; i++) fp.pads.push(pad(i + 1, -rx.padCentre, (i - (per - 1) / 2) * pitch, rx.padLength, rx.X, shape));
          for (let i = 0; i < per; i++) fp.pads.push(pad(per + i + 1, rx.padCentre, ((per - 1) / 2 - i) * pitch, rx.padLength, rx.X, shape));
        }
        let total = n;
        if (spec.EP) { exposedPad(fp, spec, String(spec.EPnumber ?? n + 1), ipc); total++; }
        const bodyMax = [-E.max / 2, -D.max / 2, E.max / 2, D.max / 2], bodyNom = [-E.nom / 2, -D.nom / 2, E.nom / 2, D.nom / 2];
        dressing(fp, bodyMax, g, {silkBody: bodyNom, pin1: pin1Dot(fp.pads[0], "left")});
        prefix = "U";
        name = (spec.ipcPrefix || (quad ? "QFN" : "SON")) + n2(pitch, 100) + "P" + n2(E.nom, 100) + "X" + n2(D.nom, 100) + "X" + heightCode(height) + "-" + total + density;
        break;
      }
      case "bga": {
        const g = goal("bga", density); flagged.push(g.flagged);
        // spec.map: a custom ball map, one text line per row ("X"/"O"/"1" a ball, "."/"-"/"0" none);
        // it sets rows and columns. spec.stagger: odd rows shift by half a pitch (staggered arrays);
        // spec.rowPitch sets the row spacing (default the pitch).
        const map = typeof spec.map === "string" && spec.map.trim() ? spec.map.trim().split(/\r?\n|;/).map(l => l.trim().replace(/\s+/g, "")) : null;
        const rows = map ? map.length : spec.rows | 0, cols = map ? Math.max(...map.map(l => l.length)) : spec.cols | 0, pitch = spec.pitch, rowPitch = spec.rowPitch || pitch;
        if (!(rows > 0 && cols > 0 && rows * cols <= 4096)) throw Error("Enter between 1 and 4096 balls.");
        const land = spec.land || bgaLand(spec.ball, spec.collapsing !== false), skip = depopulated(spec);
        if (skip.invalid?.length) flagged.push("Depopulation entries not understood: " + skip.invalid.join(", ") + " (use A1, C3-C5 or A1-C3).");
        // Solder mask: 0.05 mm over the land (NSMD), less at fine pitch so a 0.1 mm mask web remains.
        const mask = r6(Math.max(0, Math.min(.05, Math.floor(((Math.min(pitch, rowPitch) - land - .101) / 2) / .005 + 1e-9) * .005)));
        let count = 0;
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const id = rowName(r) + (c + 1);
          if (skip.has(id) || map && !/[XxOo1#*]/.test(map[r][c] || ".")) continue;
          const stagger = spec.stagger === true || spec.stagger === "true", dx = stagger && r % 2 ? pitch / 2 : 0;
          if (stagger && r % 2 && c === cols - 1 && spec.staggerTrim !== false) continue;
          fp.pads.push(pad(id, (c - (cols - 1) / 2) * pitch + dx, (r - (rows - 1) / 2) * rowPitch, land, land, "round", {maskExpansion: mask}));
          count++;
        }
        if (!count) throw Error("The ball map has no balls.");
        const D = tol(spec.D, "body length"), E = tol(spec.E ?? spec.D, "body width");
        const body = [-E.max / 2, -D.max / 2, E.max / 2, D.max / 2];
        dressing(fp, body, g, {silkBody: [-E.nom / 2, -D.nom / 2, E.nom / 2, D.nom / 2], pin1: [-E.nom / 2 - .4, -D.nom / 2 - .4]});
        prefix = "U";
        name = "BGA" + count + (spec.collapsing === false ? "N" : "C") + n2(pitch, 100) + "P" + cols + "X" + rows + "_" + n2(E.nom, 100) + "X" + n2(D.nom, 100) + "X" + heightCode(height) + density;
        ipc = {...ipc, land, balls: count, goal: g};
        break;
      }
      case "header": case "dip": {
        const g = goal("tht", density); flagged.push(g.flagged);
        const lead = tol(spec.lead, "lead size"), diag = spec.squareLead ? lead.max * Math.SQRT2 : lead.max;
        const {hole, land, note} = thtLand(diag, spec.pitch, g);
        if (note) flagged.push(note);
        ipc = {...ipc, hole, land, goal: g};
        if (fam === "header") {
          const rows = spec.rows | 0, cols = spec.cols | 0, pitch = spec.pitch;
          let n = 1;
          const at = (r, c) => [(r - (rows - 1) / 2) * pitch, (c - (cols - 1) / 2) * pitch];
          const order = [];
          if (spec.numbering === "columns") for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) order.push([r, c]);
          else for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) order.push([r, c]);
          for (const [r, c] of order) { const [x, y] = at(r, c); fp.pads.push(thPad(n, x, y, land, hole, n === 1 ? "rect" : shape === "oval" ? "oval" : "round")); n++; }
          const bx = rows * pitch / 2, by = cols * pitch / 2;
          dressing(fp, [-bx, -by, bx, by], g, {chamfer: true, silk: true, clearance: .2, pin1: [-bx - .45, -by + pitch / 2]});
          prefix = "J";
          name = "HDRV" + rows * cols + "W" + n2(lead.nom, 100) + "P" + n2(pitch, 100) + "_" + rows + "X" + cols + "_" + n2(rows * pitch, 100) + "X" + n2(cols * pitch, 100) + "X" + heightCode(height ?? 8.5) + density;
        } else {
          const n = spec.pins, per = n / 2, pitch = spec.pitch, span = spec.span;
          if (n % 2) throw Error("A DIP needs an even pin count.");
          const oval = shape === "oval", w = oval ? up(land * 1.6, .05) : land;
          for (let i = 0; i < per; i++) fp.pads.push(thPad(i + 1, -span / 2, (i - (per - 1) / 2) * pitch, w, hole, i === 0 ? "rect" : oval ? "oval" : "round", land));
          for (let i = 0; i < per; i++) fp.pads.push(thPad(per + i + 1, span / 2, ((per - 1) / 2 - i) * pitch, w, hole, oval ? "oval" : "round", land));
          const D = tol(spec.D, "body length"), E = tol(spec.E, "body width");
          dressing(fp, [-E.max / 2, -D.max / 2, E.max / 2, D.max / 2], g, {silkBody: [-E.nom / 2, -D.nom / 2, E.nom / 2, D.nom / 2]});
          // Silk notch at the pin-1 end.
          fp.shapes.push({kind: "path", style: "silk", width: SILK_W, points: [[-.6, r6(-D.nom / 2 - .09)], [0, r6(-D.nom / 2 + .5)], [.6, r6(-D.nom / 2 - .09)]]});
          prefix = "U";
          name = "DIP" + n2(span, 100) + "W" + n2(lead.nom, 100) + "P" + n2(pitch, 100) + "L" + n2(D.nom, 100) + "H" + heightCode(height ?? 5.33) + "Q" + n + density;
        }
        break;
      }
      default: {
        if (!ext?.generate) throw Error("Unknown package family " + spec.family + ".");
        const out = ext.generate(spec, {fp, density, opts, shape, H, height, flagged, ipc});
        ipc = {...ipc, ...(out.ipc || {})}; name = out.name; prefix = out.prefix || prefix;
      }
    }
    return finish();
    function finish() {
      fp.name = spec.name || name;
      if (height) fp.height = r6(height);
      // Package family presets name their dimension source and flag values that need checking.
      if (spec.source && !ipc.sources) ipc = {...ipc, sources: [spec.source]};
      if (spec.flag && !flagged.includes(spec.flag)) flagged.push(spec.flag);
      fp.ipc = {...ipc, name, flagged: [...new Set(flagged.filter(Boolean))]};
      fp.wizard = JSON.parse(JSON.stringify(spec));
      const def = {id: spec.id || (globalThis.Atrium?.id?.() || "fp-" + Math.random().toString(36).slice(2)), name: fp.name, prefix: spec.prefix || prefix,
        value: spec.value ?? "", category: spec.category || "Footprints", footprint: fp};
      if (spec.symbol !== false && globalThis.AtriumLibrary?.symbolForFootprint) {
        const s = AtriumLibrary.symbolForFootprint(fp, {prefix: def.prefix, kind: spec.kind});
        if (s) { def.symbol = s.symbol; if (s.schDrawing) def.schDrawing = s.schDrawing; }
      }
      return def;
    }
  }
  function name(spec) { return generate({...spec, symbol: false}).footprint.ipc.name; }

  // ------------------------------------------------------------------ dialog
  // Field list per family: [key, label, kind] where kind is "tol" (min/nom/max), "num", "int",
  // "text" or a list of choices.
  const FIELDS = {
    chip: [["kind", "Component", [["RES", "Resistor (RESC)"], ["CAP", "Capacitor (CAPC)"], ["IND", "Inductor (INDC)"], ["LED", "LED (LEDC)"], ["DIO", "Diode (DIOC)"]]], ["L", "Body length L", "tol"], ["W", "Body width W", "tol"], ["T", "Terminal length T", "tol"], ["H", "Height H", "tol"]],
    melf: [["kind", "Component", [["DIO", "Diode"], ["RES", "Resistor"]]], ["L", "Body length L", "tol"], ["D", "Diameter D", "tol"], ["T", "End cap T", "tol"]],
    sod: [["L", "Lead span L", "tol"], ["T", "Lead length T", "tol"], ["W", "Lead width W", "tol"], ["D", "Body length", "tol"], ["E", "Body width", "tol"], ["H", "Height", "tol"]],
    sot23: [["pins", "Pins", [["3", "3"], ["5", "5"], ["6", "6"]]], ["pitch", "Pitch e", "num"], ["L", "Lead span E", "tol"], ["T", "Lead length L", "tol"], ["W", "Lead width b", "tol"], ["D", "Body length D", "tol"], ["E", "Body width E1", "tol"], ["H", "Height A", "tol"]],
    sot223: [["pitch", "Pitch e", "num"], ["L", "Lead span E", "tol"], ["T", "Lead length L", "tol"], ["W", "Lead width b", "tol"], ["tab", "Tab width b2", "tol"], ["D", "Body length D", "tol"], ["E", "Body width E1", "tol"], ["H", "Height A", "tol"]],
    gullwing: [["style", "Style", [["SOIC", "SOIC"], ["SOP", "SOP / SSOP / TSSOP"], ["QFP", "QFP (quad)"]]], ["pins", "Pins", "int"], ["pitch", "Pitch e", "num"], ["L", "Lead span E", "tol"], ["T", "Lead length L", "tol"], ["W", "Lead width b", "tol"], ["D", "Body length D", "tol"], ["E", "Body width E1", "tol"], ["H", "Height A", "tol"]],
    nolead: [["style", "Style", [["QFN", "QFN (quad)"], ["SON", "DFN / SON (dual)"]]], ["pins", "Pins (excl. EP)", "int"], ["pitch", "Pitch e", "num"], ["D", "Body length D", "tol"], ["E", "Body width E", "tol"], ["T", "Terminal length L", "tol"], ["W", "Terminal width b", "tol"], ["EP.D", "Exposed pad D2", "tol"], ["EP.E", "Exposed pad E2", "tol"], ["pasteCoverage", "EP paste coverage", "num"], ["thermalVias.drill", "Thermal via drill (0 = none)", "num"], ["thermalVias.pitch", "Thermal via pitch", "num"], ["H", "Height A", "tol"]],
    bga: [["rows", "Rows", "int"], ["cols", "Columns", "int"], ["pitch", "Pitch e", "num"], ["ball", "Ball diameter (nom)", "num"], ["depop", "Depopulate (A1, C3-C5, center:N)", "text"], ["D", "Body length D", "num"], ["E", "Body width E", "num"], ["H", "Height A", "num"]],
    header: [["rows", "Rows", "int"], ["cols", "Pins per row", "int"], ["pitch", "Pitch", "num"], ["lead", "Lead size (square post)", "tol"], ["numbering", "Numbering", [["zigzag", "Across rows (1-2 / 3-4)"], ["columns", "Down each row"]]], ["H", "Height", "num"]],
    dip: [["pins", "Pins", "int"], ["pitch", "Pitch", "num"], ["span", "Row spacing", "num"], ["lead", "Lead width", "tol"], ["D", "Body length", "num"], ["E", "Body width", "num"], ["H", "Height", "num"]],
    smdheader: [["rows", "Rows", [["2", "2 (dual)"], ["1", "1 (alternating)"]]], ["cols", "Pins per row", "int"], ["pitch", "Pitch", "num"], ["L", "Lead span", "tol"], ["T", "Foot length", "tol"], ["W", "Lead width", "tol"], ["E", "Body width", "num"], ["H", "Height", "num"]]
  };
  const getPath = (o, k) => k.split(".").reduce((v, p) => v?.[p], o);
  function setPath(o, k, v) { const parts = k.split("."); let t = o; for (const p of parts.slice(0, -1)) { if (t[p] == null || typeof t[p] !== "object") t[p] = {}; t = t[p]; } t[parts.at(-1)] = v; }

  // ctx: {commit(def, andPlace), info?, spec?} — commit adds the def to the project library.
  function open(ctx = {}) {
    const L = globalThis.AtriumLibrary, ui = L.ui, el = ui.el;
    globalThis.AtriumI18n?.scope?.(".fw-dialog", ["fpwizard"]);
    const dlg = ui.dialog("IPC-7351B Footprint Wizard", "fw-dialog");
    let spec = ctx.spec ? JSON.parse(JSON.stringify(ctx.spec)) : defaults("gullwing", "SOIC-8");
    if (!FAMILIES.some(f => f.id === spec.family)) spec = defaults("gullwing", "SOIC-8");
    let result = null;
    const presetSel = el("select"), density = el("div", null, "fw-density"), fields = el("section", null, "fw-fields");
    density.setAttribute("role", "group");
    density.setAttribute("aria-label", "Density and rounding");
    fields.setAttribute("aria-label", "Footprint dimensions and outputs");
    const preview = el("canvas", null, "fw-canvas"), summary = el("div", null, "fw-summary"), status = el("p", null, "lib-error");
    presetSel.setAttribute("aria-label", "Preset");
    // Family picker: a searchable combobox grouped SMD / THT / Mechanical. Typing also finds presets
    // ("soic-16", "to-220", "0603"); arrows move, Enter picks, Escape closes the list.
    const famBox = el("div", null, "fw-pick"), famIn = el("input"), famList = el("div", null, "ui-select-list fw-list"); // a library completion list
    famList.dataset.completion = "";
    const listId = "fw-list-" + Math.random().toString(36).slice(2, 8);
    famList.id = listId; famList.setAttribute("role", "listbox"); famList.setAttribute("aria-label", "Package families"); famList.hidden = true;
    famIn.type = "search"; famIn.placeholder = "Search: SOIC, QFN, TO-220, 0603…"; famIn.spellcheck = false; famIn.autocomplete = "off";
    for (const [k, v] of [["role", "combobox"], ["aria-label", "Package family"], ["aria-controls", listId], ["aria-expanded", "false"], ["aria-autocomplete", "list"]]) famIn.setAttribute(k, v);
    famBox.append(famIn, famList);
    const GROUPS = [["SMD", "Surface mount"], ["THT", "Through-hole"], ["Mechanical", "Mechanical"]];
    const squash = t => String(t).toLowerCase().replace(/[\s×_\-–/().,]+/g, "");
    let options = [], active = -1, typed = false;
    function fillList() {
      const words = typed ? famIn.value.toLowerCase().split(/\s+/).filter(Boolean) : [];
      const hit = text => words.every(w => text.toLowerCase().includes(w) || squash(text).includes(squash(w)));
      famList.replaceChildren(); options = [];
      let presetRows = 0;
      for (const [g, label] of GROUPS) {
        const rows = [];
        for (const f of FAMILIES.filter(x => (x.group || "SMD") === g)) {
          const base = f.title + " " + f.id + " " + (f.keywords || "") + " " + g;
          if (!words.length || hit(base)) rows.push({f, preset: null});
          if (words.length) for (const p of f.presets) if (presetRows < 60 && words.some(w => squash(p).includes(squash(w))) && hit(p + " " + base)) { rows.push({f, preset: p}); presetRows++; }
        }
        if (!rows.length) continue;
        const head = el("div", label, "ui-select-group"); head.setAttribute("role", "presentation"); famList.append(head);
        for (const r of rows) {
          const o = el("div", null, "ui-select-option"); o.id = listId + "-" + options.length; o.setAttribute("role", "option"); o.setAttribute("aria-selected", "false");
          o.append(el("span", r.preset || r.f.title)); if (r.preset) o.append(el("small", r.f.title));
          o.onmousedown = e => { e.preventDefault(); choose(r); };
          famList.append(o); options.push({...r, node: o});
        }
      }
      if (!options.length) famList.append(el("div", "No package matches.", "fw-empty"));
      setActive(words.length ? 0 : Math.max(0, options.findIndex(o => o.f.id === spec.family && !o.preset)));
    }
    function setActive(i) {
      active = options.length ? Math.max(0, Math.min(options.length - 1, i)) : -1;
      options.forEach((o, k) => o.node.setAttribute("aria-selected", String(k === active)));
      if (active >= 0) { famIn.setAttribute("aria-activedescendant", options[active].node.id); options[active].node.scrollIntoView?.({block: "nearest"}); }
      else famIn.removeAttribute("aria-activedescendant");
    }
    function openList() { if (famList.hidden) { famList.hidden = false; famIn.setAttribute("aria-expanded", "true"); fillList(); } }
    function closeList() { famList.hidden = true; famIn.setAttribute("aria-expanded", "false"); famIn.removeAttribute("aria-activedescendant"); typed = false; showFamily(); }
    function showFamily() { famIn.value = FAMILIES.find(f => f.id === spec.family)?.title || spec.family; }
    function choose(r) {
      spec = {...defaults(r.f.id, r.preset || undefined), density: spec.density, ...(spec.roundOff != null ? {roundOff: spec.roundOff} : {})};
      closeList(); buildPresets(); buildFields(); recompute(true); needModule(r.f);
    }
    // Families built by another lazy module (the connector generator) load it, then regenerate.
    function needModule(f) {
      const ext = EXT[f?.id];
      if (ext?.needs && !globalThis.AtriumConnectorGen && globalThis.AtriumLazy?.need) AtriumLazy.need(ext.needs).then(() => recompute(true), () => {});
    }
    famIn.onclick = () => openList();
    famIn.oninput = () => { typed = true; famList.hidden = false; famIn.setAttribute("aria-expanded", "true"); fillList(); };
    famIn.onfocus = () => famIn.select();
    famIn.onblur = () => { if (!famList.hidden) closeList(); };
    famIn.onkeydown = e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); if (famList.hidden) openList(); else setActive(active + (e.key === "ArrowDown" ? 1 : -1)); }
      else if (e.key === "Home" && !famList.hidden && !typed) { e.preventDefault(); setActive(0); }
      else if (e.key === "End" && !famList.hidden && !typed) { e.preventDefault(); setActive(options.length - 1); }
      else if (e.key === "Enter" && !famList.hidden) { e.preventDefault(); e.stopPropagation(); if (active >= 0) choose(options[active]); }
      else if (e.key === "Escape" && !famList.hidden) { e.preventDefault(); e.stopPropagation(); closeList(); }
    };
    const stage = ui.stage(preview, {kind: "pcb", def: () => result || {name: "", footprint: {pads: [], shapes: []}}, overlay: (c, s) => drawDims(c, s)});
    const levels = el("div", null, "ui-segmented"); levels.setAttribute("role", "group"); levels.setAttribute("aria-label", "Density level");
    for (const [k, t, title] of [["A", "A · Most", "Density level A (Most): wave solder, rework, low density"], ["B", "B · Nominal", "Density level B (Nominal): typical reflow"], ["C", "C · Least", "Density level C (Least): high density"]]) {
      const b = el("button", t, "ui-segment"); b.type = "button"; b.dataset.level = k; b.title = title;
      b.onclick = () => { spec.density = k; sync(); recompute(true); }; levels.append(b);
    }
    // Round-off (house style), kept with the spec (fp.wizard) and remembered for the next wizard run.
    const ROUND_KEY = "atrium.footprintWizard.roundOff", roundSel = el("select");
    roundSel.setAttribute("aria-label", "Round-off"); roundSel.title = "Round-off of the land dimensions Z, G and X";
    for (const [v, t] of [["0.05", "Round 0.05 (IPC)"], ["0.025", "Round 0.025"], ["0.01", "Round 0.01"], ["kicad", "Round as KiCad"]]) roundSel.add(new Option(t, v));
    if (spec.roundOff == null) { try { const v = globalThis.localStorage?.getItem(ROUND_KEY); if (v) spec.roundOff = v === "kicad" ? v : +v; } catch { /* storage unavailable */ } }
    roundSel.onchange = () => { spec.roundOff = roundSel.value === "kicad" ? "kicad" : +roundSel.value; try { globalThis.localStorage?.setItem(ROUND_KEY, roundSel.value); } catch { /* storage unavailable */ } recompute(); };
    density.append(levels, roundSel);
    presetSel.onchange = () => { spec = {...defaults(spec.family, presetSel.value), density: spec.density, ...(spec.roundOff != null ? {roundOff: spec.roundOff} : {})}; buildFields(); recompute(true); };
    function buildPresets() {
      presetSel.replaceChildren(new Option("Custom", ""));
      for (const p of FAMILIES.find(f => f.id === spec.family).presets) presetSel.add(new Option(p, p));
      presetSel.value = spec.preset || "";
    }
    function numberInput(value, label, write, unit = "mm") {
      const i = el("input"); i.classList.add("ui-field", "ui-field-number"); i.type = "text"; i.inputMode = "decimal"; i.value = value ?? ""; i.setAttribute("aria-label", label); i.spellcheck = false;

      globalThis.AtriumLazy?.numericField?.(i, {unit: unit ?? "", integer: unit === "ea", nanometres: unit === "mm"});
      i.oninput = () => { const v = unit === "mm" && globalThis.Atrium ? Atrium.units.parse(i.value, unit) : Number(i.value); ui.rejectField(i, !Number.isFinite(v)); if (Number.isFinite(v)) { write(v); presetSel.value = ""; spec.preset = ""; recompute(); } };
      i.onkeydown = e => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); const v = Number(i.value) || 0, step = e.shiftKey ? .1 : .01; i.value = r6(v + (e.key === "ArrowUp" ? step : -step)); i.oninput(); } };
      return i;
    }
    function wideNumber(value, label, write, unit, count = false) {
      const input = numberInput(value, label, write, count ? "ea" : unit);
      if (!unit) {
        input.classList.add("fw-wide");
        return input;
      }
      const control = el("label", null, "fw-wide ui-field-measure");
      control.append(input, el("span", unit, "ui-field-unit"));
      return control;
    }
    function buildFields() {
      fields.replaceChildren();
      const head = el("div", null, "fw-row fw-head"); head.append(el("span", ""), el("span", "min (mm)"), el("span", "nom (mm)"), el("span", "max (mm)")); fields.append(head);
      for (const [key, label, kind] of FIELDS[spec.family]) {
        const row = el("div", null, "fw-row"), v = getPath(spec, key);
        row.append(el("span", label, "fw-label"));
        if (Array.isArray(kind)) {
          const s = el("select"); s.setAttribute("aria-label", label);
          for (const [val, text] of kind) s.add(new Option(text, val));
          s.value = String(v ?? kind[0][0]);
          s.onchange = () => { const num = Number(s.value); setPath(spec, key, String(num) === s.value ? num : s.value); recompute(); };
          s.className = "fw-wide"; row.append(s);
        } else if (kind === "tol") {
          let t; try { t = tol(v ?? 0); } catch { t = {min: 0, nom: 0, max: 0}; }
          const cur = {min: t.min, nom: t.nom, max: t.max};
          for (const part of ["min", "nom", "max"]) row.append(numberInput(r6(cur[part]), label + " " + part, x => {
            cur[part] = x;
            if (part === "nom") { const h = (cur.max - cur.min) / 2; cur.min = r6(x - h); cur.max = r6(x + h); row.querySelectorAll("input")[0].value = cur.min; row.querySelectorAll("input")[2].value = cur.max; }
            setPath(spec, key, {min: cur.min, max: cur.max, nom: part === "nom" ? x : r6((cur.min + cur.max) / 2)});
            if (part !== "nom") row.querySelectorAll("input")[1].value = r6((cur.min + cur.max) / 2);
          }));
        } else if (kind === "text") {
          // Lists (pads per side, terminal tables) are shown as text and parsed back by the family.
          const text = Array.isArray(v) ? v.map(o => o && typeof o === "object" ? [o.n, o.x, o.y, o.l, o.w, o.toe || "none"].join(" ") : o).join(v.some(o => o && typeof o === "object") ? "; " : ", ") : v;
          const i = el("input"); i.value = text ?? ""; i.setAttribute("aria-label", label); i.className = "fw-wide"; i.spellcheck = false;
          i.oninput = () => { setPath(spec, key, i.value); recompute(); }; row.append(i);
        } else {
          const unit = kind === "num" && key !== "pasteCoverage" ? "mm" : null;
          row.append(wideNumber(v, label, x => setPath(spec, key, kind === "int" ? Math.round(x) : x), unit, kind === "int"));
        }
        fields.append(row);
      }
      const adv = el("details", null, "fw-adv"); adv.append(el("summary", "Tolerances and outputs"));
      for (const [key, label] of [["fab", "Fabrication tolerance F"], ["place", "Placement tolerance P"]]) {
        const row = el("div", null, "fw-row"); row.append(el("span", label, "fw-label"), wideNumber(spec[key], label, x => { spec[key] = x; }, "mm")); adv.append(row);
      }
      const shapeRow = el("div", null, "fw-row"), shapeSel = el("select");
      for (const s of ["roundrect", "rect", "round", "oval"]) shapeSel.add(new Option(s, s));
      shapeSel.value = spec.padShape || "roundrect"; shapeSel.className = "fw-wide"; shapeSel.setAttribute("aria-label", "Pad shape");
      shapeSel.onchange = () => { spec.padShape = shapeSel.value; recompute(); };
      shapeRow.append(el("span", "Pad shape", "fw-label"), shapeSel); adv.append(shapeRow);
      const symRow = el("label", null, "fw-check"), sym = el("input"); sym.type = "checkbox"; sym.checked = spec.symbol !== false;
      sym.onchange = () => { spec.symbol = sym.checked; recompute(); }; symRow.append(sym, el("span", "Also create a schematic symbol"));
      adv.append(symRow); fields.append(adv);
    }
    function sync() { for (const b of levels.children) b.setAttribute("aria-pressed", String(b.dataset.level === (spec.density || "B"))); roundSel.value = String(roundOffOf(spec)); if (famList.hidden) showFamily(); }
    let frame = 0;
    let summaryTimer = 0, actions = [];
    function recompute(fit) {
      try { result = generate(spec); status.textContent = ""; }
      catch (e) { result = null; status.textContent = e.message; }
      // Validation decides whether the result may be added; the detailed summary is debounced.
      const v = result ? L.validateDef(result, {footprintWarnings: false}) : {ok: false, errors: []};
      if (result && !v.ok) status.textContent = v.errors[0];
      for (const b of actions) b.disabled = !v.ok;
      clearTimeout(summaryTimer); summaryTimer = setTimeout(renderSummary, fit ? 0 : 120);
      if (fit) stage.fit();
      if (!frame) frame = setTimeout(() => { frame = 0; stage.render(); }, 0);
    }
    function renderSummary() {
      summary.replaceChildren();
      if (!result) return;
      const fp = result.footprint, i = fp.ipc;
      const nameRow = el("div", null, "fw-name"); nameRow.append(el("strong", fp.name));
      nameRow.append(ui.button("Copy", () => globalThis.navigator?.clipboard?.writeText(fp.name), "lib-mini"));
      summary.append(nameRow);
      const dl = el("dl");
      const add = (k, v) => { const d = el("div"); d.append(el("dt", k), el("dd", v)); dl.append(d); };
      if (i.Z != null) { add("Z (toe span)", i.Z.toFixed(2) + " mm"); add("G (heel gap)", i.G.toFixed(2) + " mm"); add("X (land width)", i.X.toFixed(2) + " mm"); add("Land", i.padLength.toFixed(2) + " × " + i.X.toFixed(2) + " @ ±" + i.padCentre.toFixed(3)); }
      if (i.goal?.toe != null) add("Goals JT/JH/JS", [i.goal.toe, i.goal.heel, i.goal.side].map(v => v.toFixed(2)).join(" / "));
      if (i.roundOff != null) add("Round-off", i.roundOff === "kicad" ? "KiCad" : i.roundOff + " mm");
      if (i.land != null) add("Land Ø", i.land.toFixed(2) + " mm");
      if (i.hole != null) add("Hole Ø", i.hole.toFixed(2) + " mm");
      if (i.balls != null) add("Balls", String(i.balls));
      if (i.paste) add("EP paste", Math.round(i.paste.coverage * 100) + "% · " + i.paste.windows + " windows");
      if (i.thermalVias) add("Thermal vias", String(i.thermalVias));
      add("Courtyard", fp.courtyard ? (fp.courtyard[2] - fp.courtyard[0]).toFixed(2) + " × " + (fp.courtyard[3] - fp.courtyard[1]).toFixed(2) + " mm" : "—");
      if (fp.height) add("Height", fp.height.toFixed(2) + " mm");
      add("Pads", String(fp.pads.filter(p => !p.thermalVia).length));
      summary.append(dl);
      for (const s of i.sources || []) summary.append(el("p", s, "fw-source"));
      for (const f of i.flagged || []) summary.append(el("p", "⚑ " + f, "fw-flag"));
      const issues = L.checkFootprint(fp).filter(x => x.level !== "info");
      if (issues.length) { const ul = el("ul", null, "fw-issues"); for (const x of issues.slice(0, 6)) ul.append(el("li", x.message)); summary.append(ul); }
    }
    // Dimension call-outs for Z and G on the preview, in screen space.
    function drawDims(c, s) {
      const i = result?.footprint?.ipc; if (!i || i.Z == null) return;
      const y = (result.footprint.courtyard?.[3] ?? i.Z / 2) + .6, top = (result.footprint.courtyard?.[1] ?? -i.Z / 2) - .6;
      const line = (x0, x1, yy, label) => {
        const a = s.toScreen([x0, yy]), b = s.toScreen([x1, yy]);
        c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]);
        for (const p of [a, b]) { c.moveTo(p[0], p[1] - 4); c.lineTo(p[0], p[1] + 4); }
        c.stroke(); c.fillText(label, (a[0] + b[0]) / 2, a[1] - 4);
      };
      c.save(); c.strokeStyle = "#8fd8ff"; c.fillStyle = "#8fd8ff"; c.lineWidth = 1; c.font = "11px " + ui.mono; c.textAlign = "center";
      line(-i.Z / 2, i.Z / 2, y, "Z " + i.Z.toFixed(2)); line(-i.G / 2, i.G / 2, top, "G " + i.G.toFixed(2));
      c.restore();
    }
    const left = el("div", null, "fw-left"), right = el("div", null, "fw-right");
    const famRow = el("div", null, "fw-top"), famLabel = el("div", null, "lib-field");
    famLabel.append(el("span", "Family"), famBox); famRow.append(famLabel, ui.label("Preset", presetSel));
    left.append(famRow, density, fields);
    right.append(preview, summary, status);
    const body = el("div", null, "fw-body"); body.append(left, right);
    const footer = el("div", null, "lib-actions");
    const save = async (place, edit) => {
      const fields=globalThis.AtriumNumericFields;
      if(fields?.pending(dlg) && !await fields.flush(dlg))return;
      let def;
      try { def = generate(spec); } catch (e) { status.textContent = e.message; return; }
      const v = L.validateDef(def, {footprintWarnings: false});
      if (!v.ok) { status.textContent = v.errors[0]; return; }
      // The dialog stays open if the commit is refused, so nothing typed is lost.
      if (ctx.commit?.(def, place, edit) === false) return;
      dlg.close();
    };
    actions = [ui.button("Open in Footprint Editor", () => save(false, true)), ui.button("Add to library", () => save(false)), Object.assign(ui.button("Add and place", () => save(true)), {className: "lib-primary"})];
    ui.shortcut(actions[1], "Add to library", "Mod+Enter");
    footer.append(ui.button("Cancel", () => dlg.close()), ui.button("Batch…", () => openBatch(ui, ctx, status)), ...actions);
    dlg.append(body, footer);
    dlg.addEventListener("keydown", e => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); save(false); } });
    preview.tabIndex = 0;
    preview.setAttribute("aria-label", "IPC footprint preview");
    ui.paletteSurface(dlg, "ipc", preview, stage, {
      pins: () => result?.footprint?.pads || [],
      hitAt: point => result?.footprint?.pads.find(pad => globalThis.AtriumFootprintEditor?.padContains(pad, point)),
      families: () => FAMILIES,
      chooseFamily: (id, preset) => { const f = FAMILIES.find(row => row.id === id); if (dlg.open && f) choose({f, preset}); },
      commands: () => result ? [
        {key:"cmd:ipc:library", kind:"command", label:"Add to library", detail:"IPC-7351B Footprint Wizard", run:() => save(false)},
        {key:"cmd:ipc:edit", kind:"command", label:"Open in Footprint Editor", detail:"IPC-7351B Footprint Wizard", run:() => save(false, true)}
      ] : []
    });
    ui.show(dlg);
    buildPresets(); buildFields(); sync(); recompute(true); needModule({id: spec.family});
    stage.observe();
    return {dialog: dlg, spec: () => spec, result: () => result};
  }

  // Batch dialog: CSV or TSV specs, a result per row, then add every good footprint to the library.
  const BATCH_EXAMPLE = "family,preset,density,pins,pitch\nsop,SOIC-16,B\nqfn,QFN-20 4×4 0.5,B\nchip,0805,C\ndip,DIP-16,B\ngullwing,,B,24,0.65\n";
  function openBatch(ui, ctx, parentStatus) {
    const el = ui.el, d = ui.dialog("Batch Footprints", "fw-dialog fw-batch");
    const help = el("p", "One footprint per line. Columns: family, preset, density, then any dimension (L, W, T, pins, pitch, EP.D…). Ranges: 5.8..6.2 or 6±0.2.", "fw-help");
    const ta = el("textarea", null, "fw-csv"); ta.rows = 9; ta.spellcheck = false; ta.value = BATCH_EXAMPLE; ta.setAttribute("aria-label", "Footprint specs (CSV)");
    const list = el("ol", null, "fw-batch-out"), st = el("p", null, "lib-error");
    let rows = [];
    const run = () => {
      st.textContent = "";
      try { rows = batch(ta.value); } catch (e) { rows = []; st.textContent = e.message; }
      list.replaceChildren();
      for (const r of rows) { const li = el("li", null, r.ok ? "fw-ok" : "fw-bad"); li.append(el("span", String(r.row)), el("strong", r.ok ? r.name : r.error)); list.append(li); }
      addAll.disabled = !rows.some(r => r.ok);
    };
    const addAll = Object.assign(ui.button("Add all to library", () => {
      for (const r of rows) if (r.ok && ctx.commit?.(r.def, false, false) === false) { st.textContent = r.name; return; }
      d.close(); parentStatus.textContent = "";
    }), {className: "lib-primary"});
    addAll.disabled = true;
    const foot = el("div", null, "lib-actions"); foot.append(ui.button("Cancel", () => d.close()), ui.button("Generate", run), addAll);
    const body = el("div", null, "fw-batch-body"); body.append(help, ta, list, st);
    d.append(body, foot);
    ui.show(d); ta.focus(); run();
    return d;
  }

  // ------------------------------------------------------------------ batch and headless
  // A batch is CSV or TSV text with a header row: family, preset, density, name and any dimension
  // keys (L, W, T, pins, pitch, EP.D, thermalVias.drill, ...). A toleranced value is written
  // "5.8..6.2" (min..max), "6±0.2" or "6+-0.2" (nom ± tol), or a plain number. Empty cells keep the
  // preset's value. Lines starting with # are comments.
  function splitRow(line, sep) {
    const out = []; let cur = "", q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true; else if (ch === sep) { out.push(cur.trim()); cur = ""; } else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }
  function cellValue(v) {
    const t = String(v).trim().replace(/,(?=\d)/g, ".").replace(/\s*mm$/i, "");
    let m;
    if ((m = /^(-?\d*\.?\d+)\s*\.\.\s*(-?\d*\.?\d+)$/.exec(t))) return {min: +m[1], max: +m[2]};
    if ((m = /^(-?\d*\.?\d+)\s*(?:±|\+-|\+\/-)\s*(\d*\.?\d+)$/.exec(t))) return {nom: +m[1], tol: +m[2]};
    if (/^-?\d*\.?\d+$/.test(t)) return +t;
    if (/^(true|yes)$/i.test(t)) return true;
    if (/^(false|no|none)$/i.test(t)) return false;
    return t;
  }
  function parseBatch(text) {
    const lines = String(text || "").split(/\r?\n/).filter(l => l.trim() && !/^\s*#/.test(l));
    if (!lines.length) return [];
    const sep = lines[0].includes("\t") ? "\t" : lines[0].includes(";") && !lines[0].includes(",") ? ";" : ",";
    const head = splitRow(lines[0], sep).map(h => h.replace(/^\uFEFF/, ""));
    if (!head.some(h => /^family$/i.test(h))) throw Error("The first line must name the columns, with a family column (family, preset, density, …).");
    if (lines.length > 501) throw Error("A batch has at most 500 rows.");
    return lines.slice(1).map((line, i) => {
      const cells = splitRow(line, sep), spec = {};
      head.forEach((h, k) => {
        const v = cells[k];
        if (v == null || v === "") return;
        const key = /^family$/i.test(h) ? "family" : /^preset$/i.test(h) ? "preset" : /^density$/i.test(h) ? "density" : /^name$/i.test(h) ? "name" : /^round[_ -]?off$/i.test(h) ? "roundOff" : h;
        const val = ["family", "preset", "density", "name", "kind", "style", "depop", "map", "numbering"].includes(key) ? v : cellValue(v);
        if (key.includes(".")) setPath(spec, key, val); else spec[key] = val;
      });
      return {row: i + 2, spec};
    });
  }
  // Generate every row; a bad row is reported, the others still generate.
  function batch(input, o = {}) {
    const rows = typeof input === "string" ? parseBatch(input) : (input || []).map((spec, i) => ({row: i + 1, spec}));
    return rows.map(({row, spec}) => {
      try {
        if (!spec.family) throw Error("No family.");
        const def = generate({...(o.roundOff != null ? {roundOff: o.roundOff} : {}), ...spec, symbol: o.symbol !== false && spec.symbol !== false});
        return {row, ok: true, def, name: def.footprint.name};
      } catch (e) { return {row, ok: false, error: e.message, spec}; }
    });
  }
  function summary(def, o = {}) {
    const fp = def.footprint, i = fp.ipc || {}, L = globalThis.AtriumLibrary;
    const pads = fp.pads.filter(p => !p.thermalVia);
    return {name: fp.name, ipc_name: i.name || null, family: i.family || null, density: i.density || null, round_off: i.roundOff ?? null, Z: i.Z ?? null, G: i.G ?? null, X: i.X ?? null,
      land: i.padLength != null ? {length: i.padLength, width: i.X, centre: i.padCentre} : null, hole: i.hole ?? null, ring_land: i.land ?? null,
      courtyard: fp.courtyard || null, height: fp.height ?? null, prefix: def.prefix, pad_count: pads.length, thermal_vias: fp.pads.length - pads.length,
      ...(o.pads === false ? {} : {pads: pads.slice(0, 600).map(p => [p.number, p.x, p.y, p.w, p.h, p.drill || 0, p.shape])}),
      flagged: i.flagged || [], sources: i.sources || [],
      issues: L?.checkFootprint ? L.checkFootprint(fp).filter(x => x.level !== "info").map(x => ({level: x.level, code: x.code, message: x.message})) : []};
  }
  // Read-only entry point for MCP (footprint_wizard): list | describe | generate | batch.
  function headless(a = {}) {
    const action = a.action || (a.csv ? "batch" : a.family ? "generate" : "list");
    if (action === "list") return {families: FAMILIES.filter(f => !a.group || f.group === a.group).map(f => ({id: f.id, title: f.title, group: f.group, presets: f.presets}))};
    if (action === "describe") {
      const f = FAMILIES.find(x => x.id === a.family) || (() => { throw Error("Unknown package family " + String(a.family).slice(0, 40) + ". footprint_wizard action list names them."); })();
      return {family: f.id, title: f.title, group: f.group, presets: f.presets, spec: defaults(f.id, a.preset), fields: (FIELDS[f.id] || []).map(([k, label, kind]) => ({key: k, label, kind: Array.isArray(kind) ? kind.map(c => c[0]) : kind}))};
    }
    if (action === "generate") {
      const def = generate({family: a.family, ...(a.preset ? {preset: a.preset} : {}), density: a.density || "B", ...(a.dims || {}), ...(a.round_off != null ? {roundOff: a.round_off} : {}), symbol: false});
      return summary(def, a);
    }
    if (action === "batch") {
      const out = batch(a.csv ?? a.specs ?? [], {symbol: false, roundOff: a.round_off});
      return {rows: out.map(r => r.ok ? {row: r.row, ok: true, ...summary(r.def, {pads: false})} : {row: r.row, ok: false, error: r.error}), ok: out.filter(r => r.ok).length, failed: out.filter(r => !r.ok).length};
    }
    throw Error("action is list, describe, generate or batch.");
  }

  // ------------------------------------------------------------------ package families (footprint-packages.js)
  // AtriumFootprintPackages(KIT) returns more families: {id, title, group: "SMD"|"THT"|"Mechanical",
  // presets, defaults(preset), fields, keywords?, base? (a built-in generator) or generate(spec, ctx)}.
  // Either file may load first; install() runs once per module.
  for (const f of FAMILIES) f.group ||= /^(header|dip)$/.test(f.id) ? "THT" : "SMD";
  const EXT = {};
  const KIT = {r6, near, up, tol, rss, lands, goal, GOALS, pad, thPad, rectPath, padBox, union, dressing, pin1Dot, silkOutline, clipSegment, n2, heightCode,
    clampWidth, thtLand, exposedPad, rowName, rowIndex, depopulated, bgaLand, SILK_W, SILK_GAP, RING_MIN, LEVEL, IDX, structuredCopy,
    generate: (...a) => generate(...a), defaults: (...a) => defaults(...a), fieldsOf: id => FIELDS[id] || []};
  let installed = null;
  function install(factory) {
    if (typeof factory !== "function" || installed === factory) return;
    installed = factory;
    for (const f of factory(KIT) || []) {
      if (!f?.id || FIELDS[f.id] && !EXT[f.id]) continue;
      EXT[f.id] = f; FIELDS[f.id] = f.fields || [];
      const i = FAMILIES.findIndex(x => x.id === f.id), row = {id: f.id, title: f.title, group: f.group || "SMD", presets: f.presets || [], keywords: f.keywords || ""};
      if (i >= 0) FAMILIES[i] = row; else FAMILIES.push(row);
    }
  }
  install(globalThis.AtriumFootprintPackages);
  return Object.freeze({GOALS, FAMILIES, CHIPS, GULL, NOLEAD, SILK_W, ROUND_OFFS, roundTo, goal, tol, lands, generate, name, defaults, depopulated, rowName, bgaLand, silkOutline, clipSegment, thtLand, install, open,
    family: id => FAMILIES.find(f => f.id === id) || null, batch: (...a) => batch(...a), parseBatch: (...a) => parseBatch(...a), headless: (...a) => headless(...a)});
})();
