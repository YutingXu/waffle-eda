"use strict";
// Package families for the IPC-7351B footprint wizard (footprint-wizard.js). Lazy, loaded with the
// library module. The wizard calls AtriumFootprintPackages(KIT) once and adds the families it
// returns to its picker, presets and generator; KIT is the wizard's land-equation toolkit (lands,
// goal, tol, dressing, thtLand, exposedPad, …), so every family uses the same IPC-7351B equations,
// rounding, courtyards, assembly outlines and silk rules as the built-in ones.
//
// A family is {id, title, group: "SMD" | "THT" | "Mechanical", keywords, presets: [names],
// defaults(preset) -> spec, fields, and either base (a built-in generator that takes the spec, e.g.
// "gullwing") or generate(spec, ctx) -> {name, prefix, ipc}}. ctx = {fp, density ("M"|"N"|"L"),
// opts {fab, place}, shape, H, height, flagged, ipc}.
//
// Sources and flags. Package dimensions are min/max ranges from JEDEC/EIAJ outlines (MS-012,
// MS-013, MO-153, MO-187, MS-026, MS-022, MO-220, MS-016/018, TO-252/263/268, DO-214) and public
// manufacturer datasheets (Kemet tantalum case codes, Panasonic aluminium SMD can sizes, Yageo chip
// arrays, crystal/LED/switch makers' recommended outlines). Ranges that could not be re-checked
// against the document while writing this module carry a `flag` that the wizard shows (⚑) and
// stores in footprint.ipc.flagged; check them against the drawing of the part you buy. Goal tables
// beyond the ones KiCad's generator publishes (gull-wing, J-lead, flat no-lead, pull-back) are
// flagged the same way. Every preset lists its `source`.
globalThis.AtriumFootprintPackages = function footprintPackages(K) {
  const {r6, near, up, tol, rss, lands, goal, GOALS, pad, thPad, padBox, dressing, pin1Dot, clipSegment, n2, heightCode, clampWidth, thtLand, rowName, depopulated, SILK_W, SILK_GAP} = K;
  const R = (min, max) => ({min, max});
  const PM = (nom, t) => ({min: r6(nom - t), max: r6(nom + t), nom});
  const RECALLED = "Dimensions recalled from the outline/datasheet named in the source; not re-checked against the document. Verify before production use.";
  const EXAMPLE = "Example layout of a typical part: enter the pin positions and sizes from your part's datasheet.";
  // Presets checked on 2026-11-19 against makers' public outline drawings that cite the JEDEC outline
  // (NXP SOT… package information) or KiCad's JEDEC-cited size definitions carry no flag; JEDEC's own
  // documents need a login, so ranges no public drawing confirmed are flagged UNVERIFIED.
  const UNVERIFIED = "Not checked against a public outline drawing (JEDEC documents need a login); check the datasheet.";

  // ------------------------------------------------------------------ goal tables
  // [Most (A), Nominal (B), Least (C)] in mm. Checked on 2026-11-19 against the IPC-7351B tables KiCad's
  // footprint generator publishes (src/kilibs/config/ipc_configs/ipc_7351b.yaml, ipc7351B_2terminal.yaml,
  // ipc7351B_capae_crystal.yaml; castellated from its earlier ipc7351B_smd_two_terminal_chip.yaml).
  // Tables KiCad does not publish (chip array, bottom-only) stay flagged.
  Object.assign(GOALS, {
    // IPC-7351B inward flat ribbon L leads (molded tantalum, DO-214 SMA/SMB/SMC, molded inductors):
    // toe 0.25/0.15/0.07, heel 0.8/0.5/0.2, side 0.01/−0.05/−0.10. The lead end is under the body, so
    // the toe fillet forms there and the heel fillet at the outer end: lands() takes the heel goals as
    // its outer (toe) goals, as KiCad's ipc_spec_tantalum does ("heel and toe values are flipped").
    molded: {toe: [.8, .5, .2], heel: [.25, .15, .07], side: [.01, -.05, -.1], courtyard: [.5, .25, .1]},
    // IPC-7351B Table 3-20: aluminium electrolytic capacitor and 2-pin crystal, below 10 mm and ≥ 10 mm.
    // KiCad publishes side C = 0.03 for the smaller cans (0.3 looks intended); kept as published.
    capae: {toe: [.7, .5, .3], heel: [0, -.1, -.2], side: [.5, .4, .03], courtyard: [1, .5, .25]},
    capaeLarge: {toe: [1, .7, .4], heel: [0, -.05, -.1], side: [.6, .5, .4], courtyard: [1, .5, .25]},
    // IPC-7351B flat lead (SODFL, SOTFL): KiCad ipc_spec_flat_lead.
    flatlead: {toe: [.3, .2, .1], heel: [0, 0, 0], side: [.05, 0, 0], courtyard: [.2, .15, .1]},
    // IPC-7351B leadless chip carrier with castellated terminations (LCC, castellated modules).
    lcc: {toe: [.65, .55, .45], heel: [.25, .15, .05], side: [.05, -.05, -.15], courtyard: [.5, .25, .1]},
    // IPC-7351B chip array, concave terminations (RESCAV / CAPCAV).
    chipArray: {toe: [.55, .45, .35], heel: [-.05, -.07, -.1], side: [-.05, -.07, -.1], courtyard: [.5, .25, .1], flagged: "IPC-7351B concave chip array goals recalled, not verified (KiCad does not publish this table)"},
    // IPC-7351B bottom-only terminations (crystals, oscillators, PLCC LEDs, LGA, CSP terminals).
    bottom: {toe: [.15, .05, 0], heel: [.05, 0, 0], side: [.05, 0, 0], courtyard: [.5, .25, .1], flagged: "IPC-7351B bottom-only termination goals recalled, not verified (KiCad does not publish this table)"},
    // IPC-7351B pull-back flat no-lead (PQFN/PSON); KiCad ipc_spec_flat_no_lead_pull_back.
    noleadPullBack: {toe: [.05, 0, -.05], heel: [.05, 0, -.05], side: [.05, 0, -.05], courtyard: [.5, .25, .1]}
  });

  // ------------------------------------------------------------------ helpers
  const silk = (pts, closed) => ({kind: "path", style: "silk", width: SILK_W, points: pts.map(p => p.map(r6)), ...(closed ? {closed: true} : {})});
  const dot = (x, y) => ({kind: "circle", style: "silk", x: r6(x), y: r6(y), r: .1, fill: true});
  const asmPath = (pts, closed = true) => ({kind: "path", layer: "Mechanical 13", style: "assembly", width: .1, ...(closed ? {closed: true} : {}), points: pts.map(p => p.map(r6))});
  const asmCircle = (x, y, r) => ({kind: "circle", layer: "Mechanical 13", style: "assembly", x: r6(x), y: r6(y), r: r6(r), width: .1});
  const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const arc = (cx, cy, r, a0, a1, n = 48) => { const out = []; for (let i = 0; i <= n; i++) { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } return out; };
  const len = l => l.reduce((s, p, i) => i ? s + Math.hypot(p[0] - l[i - 1][0], p[1] - l[i - 1][1]) : 0, 0);
  // A silk polyline clipped SILK_GAP (0.2 mm) clear of every pad edge, pieces joined back up.
  function silkPoly(fp, pts, closed = false, minLength = .2) {
    const e = SILK_W / 2, g = SILK_GAP + e;
    const boxes = fp.pads.map(p => { const q = padBox(p); return [q[0] - g, q[1] - g, q[2] + g, q[3] + g]; });
    const out = [], n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) for (const [a, b] of clipSegment(pts[i], pts[(i + 1) % n], boxes)) {
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1e-3) continue;
      const last = out.at(-1), end = last?.at(-1);
      if (end && Math.hypot(end[0] - a[0], end[1] - a[1]) < 1e-6) last.push(b); else out.push([a, b]);
    }
    if (closed && out.length > 1) { const f = out[0], l = out.at(-1); if (Math.hypot(l.at(-1)[0] - f[0][0], l.at(-1)[1] - f[0][1]) < 1e-6) { out.pop(); out[0] = [...l, ...f.slice(1)]; } }
    return out.filter(l => len(l) >= minLength).map(l => silk(l));
  }
  const nom = (v, label) => tol(v, label).nom;
  const lv = ctx => ctx.density;
  const push = (ctx, ...a) => { for (const x of a) if (x) ctx.flagged.push(x); };
  const srcOf = spec => [spec.source].filter(Boolean);
  // Wizard-style family record. presets: {name: dims}.
  function fam(id, title, group, presets, extra) {
    const names = Object.keys(presets), first = extra.preset || names[0];
    return {id, title, group, presets: names, keywords: extra.keywords || "",
      defaults: p => ({preset: presets[p] ? p : first, ...JSON.parse(JSON.stringify(presets[presets[p] ? p : first]))}), ...extra};
  }
  // Pins of a SOT-style package: [number, side (-1 left / 1 right), position in pitches].
  function sotLayout(n) {
    if (n === 3) return [[1, -1, -1], [2, -1, 1], [3, 1, 0]];
    if (n === 4) return [[1, -1, -.5], [2, -1, .5], [3, 1, .5], [4, 1, -.5]];
    if (n === 5) return [[1, -1, -1], [2, -1, 0], [3, -1, 1], [4, 1, 1], [5, 1, -1]];
    if (n === 6) return [[1, -1, -1], [2, -1, 0], [3, -1, 1], [4, 1, 1], [5, 1, 0], [6, 1, -1]];
    if (n === 8) return [[1, -1, -1.5], [2, -1, -.5], [3, -1, .5], [4, -1, 1.5], [5, 1, 1.5], [6, 1, .5], [7, 1, -.5], [8, 1, -1.5]];
    throw Error("This package has 3, 4, 5, 6 or 8 pins.");
  }
  // Perimeter order of a quad package: CCW from pin 1. start "left-top" (QFN/QFP: top of the left
  // side) or "top-centre" (PLCC/LCC: centre of the top side, JEDEC). Returns [{side, i}] where i
  // indexes the side's positions from left to right (top/bottom) or top to bottom (left/right).
  function perimeter(perY, perX, start = "left-top") {
    const out = [];
    const left = () => { for (let i = 0; i < perY; i++) out.push({side: "L", i}); };
    const bottom = () => { for (let i = 0; i < perX; i++) out.push({side: "B", i}); };
    const right = () => { for (let i = perY - 1; i >= 0; i--) out.push({side: "R", i}); };
    if (start === "top-centre") {
      const c = Math.floor(perX / 2);
      for (let i = c; i >= 0; i--) out.push({side: "T", i});
      left(); bottom(); right();
      for (let i = perX - 1; i > c; i--) out.push({side: "T", i});
    } else { left(); bottom(); right(); for (let i = perX - 1; i >= 0; i--) out.push({side: "T", i}); }
    return out;
  }
  // Quad lands from two land results (rx: left/right rows, ry: top/bottom rows).
  function quadPads(ctx, order, perY, perX, pitch, rx, ry, shape) {
    order.forEach((q, k) => {
      const n = k + 1, py = (q.i - (perY - 1) / 2) * pitch, px = (q.i - (perX - 1) / 2) * pitch;
      if (q.side === "L") ctx.fp.pads.push(pad(n, -rx.padCentre, py, rx.padLength, rx.X, shape));
      else if (q.side === "R") ctx.fp.pads.push(pad(n, rx.padCentre, py, rx.padLength, rx.X, shape));
      else if (q.side === "B") ctx.fp.pads.push(pad(n, px, ry.padCentre, ry.X, ry.padLength, shape));
      else ctx.fp.pads.push(pad(n, px, -ry.padCentre, ry.X, ry.padLength, shape));
    });
  }
  // Corner clearance of a quad layout: the inner (heel) ends of one side's lands must clear the end
  // lands of the adjacent sides by `gap`. When they do not, the heel is shortened (G grows) and flagged.
  function cornerFix(r, endOffset, endWidth, ctx, gap = .15) {
    const need = r6(2 * (endOffset + endWidth / 2 + gap));
    if (r.G >= need - 1e-9) return;
    const G = up(need, .05);
    if ((r.Z - G) / 2 < .3) throw Error("The lands at the corners would be shorter than 0.3 mm: check the pins per side and the pitch.");
    ctx.flagged.push("Land heels shortened at the corners (G " + r.G.toFixed(2) + " → " + G.toFixed(2) + " mm) to keep " + gap.toFixed(2) + " mm from the adjacent side's lands.");
    r.G = G; r.padLength = r6((r.Z - G) / 2); r.padCentre = r6((r.Z + G) / 4);
  }
  // Two-terminal part: lands from L (terminal span), W (terminal width), T or S. Body BL × BW.
  function twoTerm(spec, ctx, table, o = {}) {
    const g = goal(table, lv(ctx)); push(ctx, g.flagged);
    const r = lands({L: spec.L, W: spec.W, T: spec.T, S: spec.S}, g, ctx.opts);
    // A large heel goal (density A, inward-L terminals) can close the gap: keep 0.30 mm between the lands.
    if (r.G < .3) { ctx.flagged.push("Gap between the lands raised from " + r.G.toFixed(2) + " to 0.30 mm."); r.G = .3; r.padLength = r6((r.Z - r.G) / 2); r.padCentre = r6((r.Z + r.G) / 4); }
    ctx.fp.pads.push(pad(1, -r.padCentre, 0, r.padLength, r.X, ctx.shape), pad(2, r.padCentre, 0, r.padLength, r.X, ctx.shape));
    const bl = tol(spec.BL ?? spec.L, "body length"), bw = tol(spec.BW ?? spec.W, "body width");
    const bodyMax = [-bl.max / 2, -bw.max / 2, bl.max / 2, bw.max / 2], bodyNom = [-bl.nom / 2, -bw.nom / 2, bl.nom / 2, bw.nom / 2];
    dressing(ctx.fp, bodyMax, g, {chamfer: false, silkBody: bodyNom, pin1: o.polar ? pin1Dot(ctx.fp.pads[0]) : null, assembly: o.assembly});
    if (o.polar) ctx.fp.shapes.push(asmPath([[-bl.nom / 2 + bl.nom * .2, -bw.nom / 2], [-bl.nom / 2 + bl.nom * .2, bw.nom / 2]], false));
    return {r, g, bl, bw};
  }
  // Bottom terminations at given centres: [{n, x, y, l, w, toe: "x" | "y" | null}], l along the toe
  // axis. Land = terminal + toe (outward) + heel (inward) + side × 2 + √(C² + F² + P²).
  function bottomTerms(spec, ctx, list, table = "bottom") {
    const g = goal(table, lv(ctx)); push(ctx, g.flagged);
    const t = rss(spec.termTol ?? .1, ctx.opts.fab ?? .1, ctx.opts.place ?? .05);
    for (const q of list) {
      const out = q.toe === "y" ? Math.sign(q.y) || 1 : Math.sign(q.x) || 1;
      const L = q.toe ? near(q.l + g.toe + g.heel + t, .05) : near(q.l + 2 * g.side + t, .05), W = near(q.w + 2 * g.side + t, .05);
      const shift = q.toe ? (g.toe - g.heel) / 2 * out : 0;
      if (q.toe === "y") ctx.fp.pads.push(pad(q.n, q.x, q.y + shift, W, L, q.shape || ctx.shape));
      else ctx.fp.pads.push(pad(q.n, q.x + shift, q.y, L, W, q.shape || ctx.shape));
    }
    return g;
  }
  // Through-hole pins: [{n, x, y, shape?}]. Hole and land from the lead (diagonal for a rectangular
  // lead) and the nearest pin, IPC-7251-style (the wizard's tht goals, ring ≥ 0.20 mm).
  function thtPins(spec, ctx, list, o = {}) {
    const g = goal("tht", lv(ctx)); push(ctx, g.flagged);
    let room = Infinity;
    // Nearest pin by the larger axis offset: lands are checked by their bounding boxes, so diagonal
    // neighbours (pitch circles, staggered grids) are kept apart as if they were side by side.
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) room = Math.min(room, Math.max(Math.abs(list[i].x - list[j].x), Math.abs(list[i].y - list[j].y)));
    const lead = tol(spec.lead, "lead size"), diag = spec.leadT != null ? Math.hypot(lead.max, tol(spec.leadT, "lead thickness").max) : lead.max;
    const t = thtLand(diag, Number.isFinite(room) ? room : 0, g, {minHole: spec.minHole});
    push(ctx, t.note);
    const oval = spec.padShape === "oval" && o.oval !== false, long = oval ? up(Math.max(t.land * 1.45, t.land + .5), .05) : t.land;
    list.forEach((q, i) => {
      const shape = q.shape || (i === 0 && o.pin1Square !== false ? "rect" : oval ? "oval" : "round");
      const [w, h] = o.ovalAxis === "x" ? [long, t.land] : [t.land, long];
      ctx.fp.pads.push(thPad(q.n, q.x, q.y, w, t.hole, shape, h));
    });
    ctx.ipc.hole = t.hole; ctx.ipc.land = t.land;
    return {g, ...t};
  }
  const NPTH = (x, y, d) => ({number: "", x: r6(x), y: r6(y), w: r6(d), h: r6(d), drill: r6(d), shape: "round", angle: 0, layer: "Multi", plated: false});
  const tolField = (k, l) => [k, l, "tol"], numField = (k, l) => [k, l, "num"], intField = (k, l) => [k, l, "int"];

  const families = [];
  const add = f => families.push(f);

  // ================================================================== SMD
  // ---- chip arrays (RESCAV / CAPCAV): terminals on the two long sides, concave.
  // Source: Yageo YC/TC chip resistor array datasheet (YC122, YC124, YC162, YC164).
  add(fam("chiparray", "Chip array (resistor / capacitor network)", "SMD", {
    "0402×2 (1010)": {pins: 4, pitch: .65, L: R(.9, 1.1), D: R(.9, 1.1), W: R(.2, .4), T: R(.1, .3), H: .4, kind: "RES", source: "Yageo YC122", flag: RECALLED},
    "0402×4 (2010)": {pins: 8, pitch: .5, L: R(.9, 1.1), D: R(1.9, 2.1), W: R(.15, .35), T: R(.1, .3), H: .45, kind: "RES", source: "Yageo YC124", flag: RECALLED},
    "0603×2 (1616)": {pins: 4, pitch: .8, L: R(1.5, 1.7), D: R(1.5, 1.7), W: R(.25, .45), T: R(.15, .45), H: .55, kind: "RES", source: "Yageo YC162", flag: RECALLED},
    "0603×4 (3216)": {pins: 8, pitch: .8, L: R(1.5, 1.7), D: R(3.05, 3.35), W: R(.25, .45), T: R(.15, .45), H: .55, kind: "RES", source: "Yageo YC164", flag: RECALLED}
  }, {keywords: "resistor network array rescav capcav yc124 yc164 cay16",
    fields: [["kind", "Component", [["RES", "Resistor array (RESCAV)"], ["CAP", "Capacitor array (CAPCAV)"]]], intField("pins", "Pins"), numField("pitch", "Pitch e"), tolField("L", "Body width (terminal span)"),
      tolField("D", "Body length"), tolField("T", "Terminal length"), tolField("W", "Terminal width"), tolField("H", "Height")],
    generate(spec, ctx) {
      const g = goal("chipArray", lv(ctx)); push(ctx, g.flagged, spec.flag);
      const n = spec.pins | 0, pitch = spec.pitch;
      if (n < 4 || n % 2) throw Error("A chip array has an even number of pins (4 or more).");
      const r = lands({L: spec.L, W: spec.W, T: spec.T}, g, ctx.opts);
      clampWidth(r, pitch, spec, ctx.flagged);
      const per = n / 2;
      for (let i = 0; i < per; i++) ctx.fp.pads.push(pad(i + 1, -r.padCentre, (i - (per - 1) / 2) * pitch, r.padLength, r.X, ctx.shape));
      for (let i = 0; i < per; i++) ctx.fp.pads.push(pad(per + i + 1, r.padCentre, ((per - 1) / 2 - i) * pitch, r.padLength, r.X, ctx.shape));
      const L = tol(spec.L), D = tol(spec.D, "body length");
      dressing(ctx.fp, [-L.max / 2, -D.max / 2, L.max / 2, D.max / 2], g, {silkBody: [-L.nom / 2, -D.nom / 2, L.nom / 2, D.nom / 2], pin1: pin1Dot(ctx.fp.pads[0])});
      const cap = spec.kind === "CAP";
      return {name: (cap ? "CAPCAV" : "RESCAV") + n2(pitch) + "P" + n2(D.nom) + "X" + n2(L.nom) + "X" + heightCode(ctx.height ?? .5) + "-" + n + lv(ctx), prefix: cap ? "C" : "RN",
        ipc: {...r, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- molded body two-terminal (tantalum CAPMP, DO-214 DIOM).
  // Tantalum: Kemet case code table (L, W, H, F termination width, S termination length).
  // SMA/SMB/SMC: JEDEC DO-214AC/AA/AB.
  add(fam("molded", "Molded body (tantalum, SMA / SMB / SMC)", "SMD", {
    "Tantalum A (3216-18)": {kind: "CAP", L: PM(3.2, .2), BW: PM(1.6, .2), W: PM(1.2, .1), T: PM(.8, .3), H: R(1.4, 1.8), source: "Kemet tantalum case A (EIA 3216-18)"},
    "Tantalum B (3528-21)": {kind: "CAP", L: PM(3.5, .2), BW: PM(2.8, .2), W: PM(2.2, .1), T: PM(.8, .3), H: R(1.7, 2.1), source: "Kemet tantalum case B (EIA 3528-21)"},
    "Tantalum C (6032-28)": {kind: "CAP", L: PM(6, .3), BW: PM(3.2, .3), W: PM(2.2, .1), T: PM(1.3, .3), H: R(2.2, 2.8), source: "Kemet tantalum case C (EIA 6032-28)"},
    "Tantalum D (7343-31)": {kind: "CAP", L: PM(7.3, .3), BW: PM(4.3, .3), W: PM(2.4, .1), T: PM(1.3, .3), H: R(2.5, 3.1), source: "Kemet tantalum case D (EIA 7343-31)"},
    "Tantalum E (7343-43)": {kind: "CAP", L: PM(7.3, .3), BW: PM(4.3, .3), W: PM(2.4, .1), T: PM(1.3, .3), H: R(3.7, 4.3), source: "Kemet tantalum case E (EIA 7343-43)"},
    "Tantalum T (3528-12)": {kind: "CAP", L: PM(3.5, .2), BW: PM(2.8, .2), W: PM(2.2, .1), T: PM(.8, .3), H: R(.9, 1.2), source: "Kemet tantalum case T (EIA 3528-12)"},
    "SMA (DO-214AC)": {kind: "DIO", L: R(4.8, 5.59), BL: R(4.06, 4.57), BW: R(2.29, 2.92), W: R(1.25, 1.65), T: R(.76, 1.52), H: R(1.98, 2.44), source: "JEDEC DO-214AC"},
    "SMB (DO-214AA)": {kind: "DIO", L: R(5.21, 5.59), BL: R(4.06, 4.57), BW: R(3.3, 3.94), W: R(1.96, 2.21), T: R(.76, 1.52), H: R(1.96, 2.44), source: "JEDEC DO-214AA"},
    "SMC (DO-214AB)": {kind: "DIO", L: R(7.75, 8.13), BL: R(6.6, 7.11), BW: R(5.59, 6.22), W: R(2.92, 3.18), T: R(.76, 1.52), H: R(1.96, 2.62), source: "JEDEC DO-214AB"}
  }, {preset: "Tantalum B (3528-21)", keywords: "tantalum capmp diom sma smb smc do-214 polarised molded",
    fields: [["kind", "Component", [["CAP", "Polarised capacitor (CAPMP)"], ["DIO", "Diode (DIOM)"], ["IND", "Inductor (INDM)"]]], tolField("L", "Overall length L"), tolField("BL", "Body length"),
      tolField("BW", "Body width"), tolField("W", "Terminal width"), tolField("T", "Terminal length"), tolField("H", "Height")],
    generate(spec, ctx) {
      push(ctx, spec.flag);
      const k = ["CAP", "DIO", "IND"].includes(spec.kind) ? spec.kind : "CAP";
      const {r, g, bw} = twoTerm(spec, ctx, "molded", {polar: k !== "IND"});
      return {name: {CAP: "CAPMP", DIO: "DIOM", IND: "INDM"}[k] + n2(nom(spec.L), 10) + n2(bw.nom, 10) + "X" + heightCode(ctx.height ?? 1) + lv(ctx), prefix: {CAP: "C", DIO: "D", IND: "L"}[k],
        ipc: {...r, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- aluminium electrolytic SMD (CAPAE). Panasonic SMD can size codes B–K: can D, base A × A,
  // terminal span (tip to tip), gap between the terminals and terminal width.
  const CAN = (D, A, H, span, gap, w, code) => ({D, A, H: R(r6(H - .3), r6(H + .3)), L: PM(span, .2), S: PM(gap, .2), W: PM(w, .1), source: "Panasonic aluminium SMD can size " + code, flag: RECALLED});
  add(fam("capae", "Aluminium electrolytic SMD (CAPAE)", "SMD", {
    "4×5.4 (B)": CAN(4, 4.3, 5.4, 5.1, 1, .65, "B"), "5×5.4 (C)": CAN(5, 5.3, 5.4, 6.1, 1.4, .65, "C"), "6.3×5.4 (D)": CAN(6.3, 6.6, 5.4, 7.4, 1.8, .65, "D"),
    "6.3×7.7 (D8)": CAN(6.3, 6.6, 7.7, 7.4, 1.8, .65, "D8"), "8×6.2 (E)": CAN(8, 8.3, 6.2, 9.1, 2.2, .65, "E"), "8×10.2 (F)": CAN(8, 8.3, 10.2, 9.1, 3.1, .9, "F"),
    "10×10.2 (G)": CAN(10, 10.3, 10.2, 11.1, 4.6, .9, "G"), "12.5×13.5 (H13)": CAN(12.5, 13.5, 13.5, 14.2, 4.4, 1.2, "H13"), "16×16.5 (J16)": CAN(16, 17, 16.5, 17.8, 6.7, 1.2, "J16"),
    "18×16.5 (K16)": CAN(18, 19, 16.5, 19.8, 6.7, 1.2, "K16")
  }, {preset: "6.3×5.4 (D)", keywords: "electrolytic aluminium aluminum capacitor can capae polarised smd elko",
    fields: [numField("D", "Can diameter"), numField("A", "Base size A"), tolField("L", "Terminal span"), tolField("S", "Gap between terminals"), tolField("W", "Terminal width"), tolField("H", "Height")],
    generate(spec, ctx) {
      push(ctx, spec.flag);
      const A = +spec.A, D = +spec.D, h = A / 2;
      if (!(A > 0 && D > 0 && D <= A + .5)) throw Error("Enter the can diameter and a base at least as large.");
      const {r, g} = twoTerm({...spec, BL: A, BW: A}, ctx, D >= 10 ? "capaeLarge" : "capae", {assembly: false});
      // Silk: the base with the two corners at the + (pin 1) end chamfered, clipped at the pads; a + mark.
      ctx.fp.shapes = ctx.fp.shapes.filter(s => s.style !== "silk");
      const c = Math.min(h * .5, 1.5), e = SILK_W / 2 + .05;
      ctx.fp.shapes.push(...silkPoly(ctx.fp, [[-h - e + c, -h - e], [h + e, -h - e], [h + e, h + e], [-h - e + c, h + e], [-h - e, h + e - c], [-h - e, -h - e + c]], true));
      const px = r6(-r.padCentre - r.padLength / 2 - .5), py = r6(-r.X / 2 - .6);
      ctx.fp.shapes.push(...silkPoly(ctx.fp, [[px - .4, py], [px + .4, py]]), ...silkPoly(ctx.fp, [[px, py - .4], [px, py + .4]]));
      ctx.fp.shapes.push(asmCircle(0, 0, D / 2), asmPath([[-h + c, -h], [h, -h], [h, h], [-h + c, h], [-h, h - c], [-h, -h + c]]));
      return {name: "CAPAE" + n2(A) + "X" + heightCode(ctx.height ?? 5.4) + lv(ctx), prefix: "C", ipc: {...r, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- SOD flat lead (SODFL). Nexperia/onsemi package outlines SOD123F, SOD123FL, SOD323F, SOD128.
  add(fam("sodfl", "SOD flat lead (SODFL: SOD-123F, SOD-323F, SOD-128)", "SMD", {
    "SOD-123F": {L: R(3.4, 3.8), T: R(.5, .9), W: R(.8, 1), BL: R(2.6, 2.8), BW: R(1.6, 1.8), H: R(.9, 1.1), source: "Nexperia SOD123F package outline", flag: RECALLED},
    "SOD-123FL": {L: R(3.5, 3.9), T: R(.6, 1), W: R(.8, 1.1), BL: R(2.6, 2.9), BW: R(1.6, 1.9), H: R(.9, 1.1), source: "onsemi SOD-123FL case outline", flag: RECALLED},
    "SOD-323F": {L: R(2.3, 2.7), T: R(.25, .45), W: R(.25, .4), BL: R(1.6, 1.8), BW: R(1.15, 1.35), H: R(.7, .85), source: "Nexperia SOD323F package outline", flag: RECALLED},
    "SOD-128": {L: R(4.6, 5), T: R(.55, .95), W: R(1.4, 1.8), BL: R(3.6, 3.9), BW: R(2.4, 2.6), H: R(.9, 1.1), source: "Nexperia SOD128 package outline", flag: RECALLED}
  }, {keywords: "diode flat lead sodfl sod123f sod-123fl sod128 sod323f",
    fields: [tolField("L", "Lead span L"), tolField("T", "Lead length"), tolField("W", "Lead width"), tolField("BL", "Body length"), tolField("BW", "Body width"), tolField("H", "Height")],
    generate(spec, ctx) {
      push(ctx, spec.flag);
      const {r, g, bw} = twoTerm(spec, ctx, "flatlead", {polar: true});
      return {name: "SODFL" + n2(nom(spec.L), 10) + n2(bw.nom, 10) + "X" + heightCode(ctx.height ?? 1) + lv(ctx), prefix: "D", ipc: {...r, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- SOT flat lead (SOTFL): SOT-23F, SOT-563, SOT-666.
  add(fam("sotfl", "SOT flat lead (SOTFL: SOT-563, SOT-666, SOT-23F)", "SMD", {
    "SOT-563": {pins: 6, pitch: .5, L: R(1.5, 1.7), T: R(.1, .3), W: R(.15, .3), D: R(1.5, 1.7), E: R(1.1, 1.3), H: R(.5, .6), source: "onsemi SOT-563 case outline", flag: RECALLED},
    "SOT-666": {pins: 6, pitch: .5, L: R(1.5, 1.7), T: R(.1, .3), W: R(.17, .27), D: R(1.5, 1.7), E: R(1.1, 1.3), H: R(.5, .6), source: "Nexperia SOT666 package outline", flag: RECALLED},
    "SOT-23F": {pins: 3, pitch: .95, L: R(2.3, 2.5), T: R(.3, .5), W: R(.3, .5), D: R(2.8, 3), E: R(1.5, 1.7), H: R(.8, .95), source: "Toshiba SOT-23F package outline", flag: RECALLED}
  }, {keywords: "sotfl flat lead sot563 sot666 sot23f",
    fields: [["pins", "Pins", [["3", "3"], ["5", "5"], ["6", "6"], ["8", "8"]]], numField("pitch", "Pitch e"), tolField("L", "Lead span"), tolField("T", "Lead length"), tolField("W", "Lead width"),
      tolField("D", "Body length D"), tolField("E", "Body width E"), tolField("H", "Height")],
    generate(spec, ctx) {
      const g = goal("flatlead", lv(ctx)); push(ctx, g.flagged, spec.flag);
      const r = lands({L: spec.L, W: spec.W, T: spec.T}, g, ctx.opts), n = spec.pins | 0, pitch = spec.pitch;
      clampWidth(r, pitch, spec, ctx.flagged);
      for (const [num, side, k] of sotLayout(n)) ctx.fp.pads.push(pad(num, side * r.padCentre, k * pitch, r.padLength, r.X, ctx.shape));
      const D = tol(spec.D, "body length"), E = tol(spec.E, "body width");
      dressing(ctx.fp, [-E.max / 2, -D.max / 2, E.max / 2, D.max / 2], g, {silkBody: [-E.nom / 2, -D.nom / 2, E.nom / 2, D.nom / 2], pin1: pin1Dot(ctx.fp.pads[0])});
      return {name: "SOTFL" + n2(pitch) + "P" + n2(nom(spec.L)) + "X" + heightCode(ctx.height ?? .6) + "-" + n + lv(ctx), prefix: n === 3 ? "Q" : "U", ipc: {...r, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- more SOT-23 style gull-wing packages (built-in SOT-23 generator). JEDEC TO-236, MO-178 (SOT-23-5/6),
  // MO-193 (TSOT), EIAJ SC-70 (SOT-323/353/363), SOT-23-8.
  add(fam("sotx", "SOT-23-8, TSOT-23, SC-70 (SOT-323 / 353 / 363)", "SMD", {
    "SOT-23-8": {pins: 8, pitch: .65, L: R(2.6, 3), T: R(.3, .6), W: R(.22, .38), D: R(2.8, 3), E: R(1.5, 1.7), H: 1.45, source: "JEDEC MO-178BA (lead length and width as in KiCad sot.yaml)", flag: "Lead span 2.60–3.00 not checked against MO-178 (KiCad uses 2.80 BSC)."},
    "TSOT-23-5": {pins: 5, pitch: .95, L: R(2.6, 3), T: R(.3, .6), W: R(.3, .5), D: R(2.8, 3), E: R(1.5, 1.7), H: 1, source: "JEDEC MO-193AB (lead length and width as in KiCad tsot.yaml)", flag: "Lead span 2.60–3.00 not checked against MO-193 (KiCad uses 2.80 BSC)."},
    "TSOT-23-6": {pins: 6, pitch: .95, L: R(2.6, 3), T: R(.3, .6), W: R(.3, .5), D: R(2.8, 3), E: R(1.5, 1.7), H: 1, source: "JEDEC MO-193AA (lead length and width as in KiCad tsot.yaml)", flag: "Lead span 2.60–3.00 not checked against MO-193 (KiCad uses 2.80 BSC)."},
    "SOT-323 (SC-70-3)": {pins: 3, pitch: .65, L: R(2, 2.2), T: R(.15, .45), W: R(.3, .4), D: R(1.8, 2.2), E: R(1.15, 1.35), H: R(.8, 1.1), source: "NXP SOT323 (SC-70)"},
    "SOT-353 (SC-70-5)": {pins: 5, pitch: .65, L: R(2, 2.25), T: R(.15, .46), W: R(.15, .3), D: R(1.85, 2.25), E: R(1.15, 1.35), H: R(.8, 1.1), source: "NXP SOT353-1 (SC-88A, JEDEC MO-203)"},
    "SOT-363 (SC-70-6)": {pins: 6, pitch: .65, L: R(2, 2.2), T: R(.15, .45), W: R(.2, .3), D: R(1.8, 2.2), E: R(1.15, 1.35), H: R(.8, 1.1), source: "NXP SOT363 (SC-88)"}
  }, {base: "sot23", keywords: "sot23-8 tsot sc70 sc-70 sot323 sot353 sot363 sc88", get fields() { return K.fieldsOf("sot23").map(f => f[0] === "pins" ? ["pins", "Pins", [["3", "3"], ["5", "5"], ["6", "6"], ["8", "8"]]] : f); }}));

  // ---- SOT-143 / SOT-343: four leads, pin 1 wide.
  add(fam("sot143", "SOT-143 / SOT-343 (4 leads, wide pin 1)", "SMD", {
    "SOT-143": {pitch: 1.9, L: R(2.1, 2.64), T: R(.3, .6), W: R(.37, .51), W1: R(.76, .89), D: R(2.8, 3.04), E: R(1.2, 1.4), H: 1.12, source: "JEDEC TO-253 (SOT-143)", flag: RECALLED},
    "SOT-343 (SC-70-4)": {pitch: 1.3, L: R(2, 2.2), T: R(.26, .46), W: R(.15, .35), W1: R(.55, .7), D: R(1.8, 2.2), E: R(1.15, 1.35), H: 1.1, source: "EIAJ SC-82AB (SOT-343)", flag: RECALLED}
  }, {keywords: "sot143 sot343 sc82 rf transistor",
    fields: [numField("pitch", "Pitch (pin 1 to 2)"), tolField("L", "Lead span"), tolField("T", "Lead length"), tolField("W", "Lead width"), tolField("W1", "Pin 1 width"), tolField("D", "Body length"), tolField("E", "Body width"), tolField("H", "Height")],
    generate(spec, ctx) {
      const g = goal("gullwing", lv(ctx)); push(ctx, spec.flag);
      const r = lands({L: spec.L, W: spec.W, T: spec.T}, g, ctx.opts), r1 = lands({L: spec.L, W: spec.W1, T: spec.T}, g, ctx.opts), p = spec.pitch;
      // The wide pin 1 shares its outer edge with a narrow lead: its centre moves in by (b1 − b) / 2.
      const y1 = r6(-p / 2 + (tol(spec.W1).nom - tol(spec.W).nom) / 2);
      ctx.fp.pads.push(pad(1, -r.padCentre, y1, r.padLength, r1.X, ctx.shape), pad(2, -r.padCentre, p / 2, r.padLength, r.X, ctx.shape),
        pad(3, r.padCentre, p / 2, r.padLength, r.X, ctx.shape), pad(4, r.padCentre, -p / 2, r.padLength, r.X, ctx.shape));
      const D = tol(spec.D), E = tol(spec.E);
      dressing(ctx.fp, [-E.max / 2, -D.max / 2, E.max / 2, D.max / 2], g, {silkBody: [-E.nom / 2, -D.nom / 2, E.nom / 2, D.nom / 2], pin1: pin1Dot(ctx.fp.pads[0])});
      return {name: "SOT" + n2(p) + "P" + n2(nom(spec.L)) + "X" + heightCode(ctx.height ?? 1.1) + "-4" + lv(ctx), prefix: "Q", ipc: {...r, pin1Width: r1.X, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- SOT-89: three leads on one side, the centre lead widens into the tab under the body.
  add(fam("sot89", "SOT-89 (3 leads + tab)", "SMD", {
    "SOT-89-3": {pitch: 1.5, L: R(3.94, 4.25), T: R(.89, 1.2), W: R(.36, .48), tab: R(1.62, 1.83), D: R(4.4, 4.6), E: R(2.29, 2.6), H: R(1.4, 1.6), source: "JEDEC TO-243AA (SOT-89)", flag: RECALLED}
  }, {keywords: "sot89 sot-89 to-243 regulator",
    fields: [numField("pitch", "Pitch e"), tolField("L", "Overall span (lead tip to tab)"), tolField("T", "Lead length"), tolField("W", "Lead width"), tolField("tab", "Tab width"), tolField("D", "Body length"), tolField("E", "Body width"), tolField("H", "Height")],
    generate(spec, ctx) {
      const g = goal("gullwing", lv(ctx)); push(ctx, spec.flag);
      const r = lands({L: spec.L, W: spec.W, T: spec.T}, g, ctx.opts), p = spec.pitch, Lsp = tol(spec.L), tab = tol(spec.tab, "tab width");
      const tabX = near(tab.min + 2 * g.side + rss(tab.c, ctx.opts.fab ?? .1, ctx.opts.place ?? .05), .05);
      const x0 = -r.padCentre, outer = r6(r.Z / 2), inner = r6(-r.G / 2 - r.padLength / 2);
      ctx.fp.pads.push(pad(1, x0, -p, r.padLength, r.X, ctx.shape), pad(2, x0, 0, r.padLength, r.X, ctx.shape), pad(3, x0, p, r.padLength, r.X, ctx.shape));
      // The tab land joins pin 2's lead land and runs under the body to the far toe.
      ctx.fp.pads.push(pad(2, (inner + outer) / 2, 0, outer - inner, tabX, "rect"));
      const E = tol(spec.E), D = tol(spec.D), bx1 = Lsp.nom / 2, bx0 = bx1 - E.nom;
      dressing(ctx.fp, [r6(Lsp.max / 2 - E.max), -D.max / 2, Lsp.max / 2, D.max / 2], g, {silk: false});
      ctx.fp.shapes.push(...silkPoly(ctx.fp, box(bx0, -D.nom / 2, bx1, D.nom / 2), true), dot(ctx.fp.pads[0].x - ctx.fp.pads[0].w / 2 - .35, -p));
      return {name: "SOT" + n2(p) + "P" + n2(Lsp.nom) + "X" + heightCode(ctx.height ?? 1.6) + "-3" + lv(ctx), prefix: "Q", ipc: {...r, tabX, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- DPAK / D2PAK / D3PAK (TO-252 / TO-263 / TO-268): gull-wing leads on one side, the tab on the other.
  // Tab land: from the tab end (toe, the same Z as the leads) in to the tab length plus the heel goal.
  const DP = (pins, pitch, L, T, W, E, D, tabW, tabL, H, src, cut) => ({pins, pitch, L, T, W, E, D, tabW, tabL, H, cut: !!cut, source: src, flag: RECALLED});
  add(fam("dpak", "DPAK / D2PAK / D3PAK (TO-252 / 263 / 268, with tab)", "SMD", {
    "TO-252-2 (DPAK)": DP(3, 2.28, R(9.4, 10.41), R(.9, 1.5), R(.64, .89), R(6.35, 6.73), R(5.97, 6.22), R(5, 5.5), R(4.7, 5.5), R(2.18, 2.38), "JEDEC TO-252AA", true),
    "TO-252-3 (DPAK)": DP(3, 2.28, R(9.4, 10.41), R(.9, 1.5), R(.64, .89), R(6.35, 6.73), R(5.97, 6.22), R(5, 5.5), R(4.7, 5.5), R(2.18, 2.38), "JEDEC TO-252AA"),
    "TO-252-5 (DPAK-5)": DP(5, 1.14, R(9.4, 10.41), R(.9, 1.5), R(.5, .7), R(6.35, 6.73), R(5.97, 6.22), R(5, 5.5), R(4.7, 5.5), R(2.18, 2.38), "JEDEC TO-252AD"),
    "TO-263-2 (D2PAK)": DP(3, 2.54, R(14.61, 15.88), R(1.78, 2.79), R(.51, .99), R(9.65, 10.67), R(8.38, 9.65), R(6.5, 8), R(7, 8), R(4.06, 4.83), "JEDEC TO-263AB", true),
    "TO-263-3 (D2PAK)": DP(3, 2.54, R(14.61, 15.88), R(1.78, 2.79), R(.51, .99), R(9.65, 10.67), R(8.38, 9.65), R(6.5, 8), R(7, 8), R(4.06, 4.83), "JEDEC TO-263AB"),
    "TO-263-5 (D2PAK-5)": DP(5, 1.7, R(14.61, 15.88), R(1.78, 2.79), R(.66, .91), R(9.65, 10.67), R(8.38, 9.65), R(6.5, 8), R(7, 8), R(4.06, 4.83), "JEDEC TO-263BA"),
    "TO-263-7 (D2PAK-7)": DP(7, 1.27, R(14.61, 15.88), R(1.78, 2.79), R(.5, .7), R(9.65, 10.67), R(8.38, 9.65), R(6.5, 8), R(7, 8), R(4.06, 4.83), "JEDEC TO-263CB"),
    "TO-268 (D3PAK)": DP(3, 5.45, R(18.7, 19.1), R(2.4, 3.3), R(1.15, 1.45), R(15.8, 16.2), R(13.3, 13.9), R(12, 13.5), R(10, 11.5), R(4.9, 5.1), "JEDEC TO-268AA", true)
  }, {preset: "TO-252-2 (DPAK)", keywords: "dpak d2pak d3pak to-252 to-263 to-268 power tab regulator mosfet",
    fields: [intField("pins", "Lead positions"), ["cut", "Centre lead", [["false", "Present (tab is the next number)"], ["true", "Cut (tab takes its number)"]]], numField("pitch", "Pitch e"),
      tolField("L", "Overall span HE"), tolField("T", "Lead foot length"), tolField("W", "Lead width"), tolField("E", "Body width"), tolField("D", "Body length"), tolField("tabW", "Tab width"),
      tolField("tabL", "Tab length (from the tab end)"), tolField("H", "Height")],
    generate(spec, ctx) {
      const g = goal("gullwing", lv(ctx)); push(ctx, spec.flag);
      const n = spec.pins | 0, p = spec.pitch, cut = spec.cut === true || spec.cut === "true";
      if (n < 2 || n > 9) throw Error("Enter 2 to 9 lead positions.");
      const r = lands({L: spec.L, W: spec.W, T: spec.T}, g, ctx.opts);
      clampWidth(r, p, spec, ctx.flagged);
      const centre = (n + 1) / 2, f = ctx.opts.fab ?? .1, pl = ctx.opts.place ?? .05, Lsp = tol(spec.L), tl = tol(spec.tabL, "tab length"), tw = tol(spec.tabW, "tab width");
      for (let i = 1; i <= n; i++) { if (cut && i === centre) continue; ctx.fp.pads.push(pad(i, -r.padCentre, (i - centre) * p, r.padLength, r.X, ctx.shape)); }
      const outer = r6(r.Z / 2), inner = near(Lsp.max / 2 - tl.max - g.heel - rss(tl.c, f, pl) / 2, .05), tabX = near(tw.min + 2 * g.side + rss(tw.c, f, pl), .05);
      const tabNum = cut && Number.isInteger(centre) ? centre : n + 1;
      ctx.fp.pads.push(pad(tabNum, (inner + outer) / 2, 0, outer - inner, tabX, "rect"));
      const E = tol(spec.E), D = tol(spec.D), bx1 = Lsp.nom / 2 - .5, bx0 = bx1 - D.nom;
      dressing(ctx.fp, [r6(Lsp.max / 2 - .5 - D.max), -E.max / 2, Lsp.max / 2, E.max / 2], g, {silk: false});
      ctx.fp.shapes.push(...silkPoly(ctx.fp, box(bx0, -E.nom / 2, bx1, E.nom / 2), true), dot(ctx.fp.pads[0].x - ctx.fp.pads[0].w / 2 - .35, ctx.fp.pads[0].y));
      return {name: "TO" + n2(p) + "P" + n2(Lsp.nom) + "X" + heightCode(ctx.height ?? 2.4) + "-" + (ctx.fp.pads.length) + lv(ctx), prefix: "Q", ipc: {...r, tabX, tab: tabNum, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- J-lead: SOJ (dual) and PLCC (quad, pin 1 at the centre of the top row, counter-clockwise).
  // IPC-7351B Table 3-4 J-lead goals (the wizard's jlead). PLCC: JEDEC MS-016 (rectangular) / MS-018
  // (square); SOJ: JEDEC MS-027 (300 / 400 mil).
  // S / S2: the J-lead contact rows (eD / eE: lead centre to lead centre across the package), the
  // "lead inside" span KiCad's PLCC generator uses; the lands are computed from L and S (no T).
  const PLCC = (pins, perY, perX, Ly, Lx, Dy, Dx, H, Sx, Sy, src, flag) => ({style: "PLCC", pins, perY, perX, pitch: 1.27, L: Lx, L2: Ly, S: Sx, S2: Sy, W: R(.33, .53), E: Dx, D: Dy, H,
    source: src, ...(flag ? {flag} : {})});
  const MS018 = "JEDEC MS-018 (NXP SOT261-2 PLCC28; Microsemi PLCC44/68/84 as in KiCad plcc_jLead_definitions.yaml)";
  const MS018D = "eD/eE derived from the MS-018 pattern (body − 1.09 mm ± 0.51), not read from a drawing; check the datasheet.";
  add(fam("jlead", "J-lead: PLCC and SOJ", "SMD", {
    "PLCC-20": PLCC(20, 5, 5, R(9.78, 10.03), R(9.78, 10.03), R(8.89, 9.04), R(8.89, 9.04), R(4.2, 4.57), R(7.37, 8.38), R(7.37, 8.38), MS018, MS018D),
    "PLCC-28": PLCC(28, 7, 7, R(12.32, 12.57), R(12.32, 12.57), R(11.43, 11.58), R(11.43, 11.58), R(4.19, 4.57), R(9.91, 10.92), R(9.91, 10.92), "NXP SOT261-2 (JEDEC MS-018)"),
    "PLCC-32": PLCC(32, 9, 7, R(14.86, 15.11), R(12.32, 12.57), R(13.89, 14.05), R(11.35, 11.51), R(3.12, 3.56), R(9.91, 10.92), R(12.47, 13.49), "JEDEC MS-016AE (Microchip doc0015, as in KiCad plcc_jLead_definitions.yaml)"),
    "PLCC-44": PLCC(44, 11, 11, R(17.4, 17.65), R(17.4, 17.65), R(16.51, 16.66), R(16.51, 16.66), R(4.2, 4.57), R(14.99, 16), R(14.99, 16), MS018),
    "PLCC-52": PLCC(52, 13, 13, R(19.94, 20.19), R(19.94, 20.19), R(19.05, 19.2), R(19.05, 19.2), R(4.2, 5.08), R(17.53, 18.54), R(17.53, 18.54), MS018, MS018D),
    "PLCC-68": PLCC(68, 17, 17, R(25.02, 25.27), R(25.02, 25.27), R(24.13, 24.28), R(24.13, 24.28), R(4.2, 5.08), R(22.61, 23.62), R(22.61, 23.62), MS018),
    "PLCC-84": PLCC(84, 21, 21, R(30.1, 30.35), R(30.1, 30.35), R(29.21, 29.36), R(29.21, 29.36), R(4.2, 5.08), R(27.69, 28.7), R(27.69, 28.7), MS018),
    "SOJ-20 (300 mil)": {style: "SOJ", pins: 20, pitch: 1.27, L: R(8.38, 8.64), T: R(1, 1.6), W: R(.38, .51), E: R(7.49, 7.75), D: R(12.7, 12.95), H: R(3.25, 3.75), source: "JEDEC MS-027 (SOJ 300 mil)", flag: RECALLED},
    "SOJ-26 (300 mil)": {style: "SOJ", pins: 26, pitch: 1.27, L: R(8.38, 8.64), T: R(1, 1.6), W: R(.38, .51), E: R(7.49, 7.75), D: R(17.02, 17.27), H: R(3.25, 3.75), source: "JEDEC MS-027 (SOJ 300 mil)", flag: RECALLED},
    "SOJ-28 (400 mil)": {style: "SOJ", pins: 28, pitch: 1.27, L: R(10.92, 11.18), T: R(1, 1.6), W: R(.38, .51), E: R(10.03, 10.29), D: R(18.29, 18.54), H: R(3.25, 3.75), source: "JEDEC MS-027 (SOJ 400 mil)", flag: RECALLED}
  }, {preset: "PLCC-44", keywords: "plcc soj j-lead jlead chip carrier socket",
    fields: [["style", "Style", [["PLCC", "PLCC (quad)"], ["SOJ", "SOJ (dual)"]]], intField("pins", "Pins"), intField("perY", "Pins per left/right side (PLCC)"), numField("pitch", "Pitch e"),
      tolField("L", "Lead span (across x)"), tolField("L2", "Lead span (across y, PLCC)"), tolField("S", "Lead contact rows eD (across x)"), tolField("S2", "Lead contact rows eE (across y, PLCC)"), tolField("T", "Lead contact length (when no S)"), tolField("W", "Lead width"), tolField("E", "Body width"), tolField("D", "Body length"), tolField("H", "Height")],
    generate(spec, ctx) {
      const g = goal("jlead", lv(ctx)); push(ctx, spec.flag);
      // With S (the contact rows) the lands come from L and S, as KiCad's PLCC generator does; else from T.
      const n = spec.pins | 0, p = spec.pitch, rx = lands({L: spec.L, W: spec.W, ...(spec.S ? {S: spec.S} : {T: spec.T})}, g, ctx.opts);
      clampWidth(rx, p, spec, ctx.flagged);
      const E = tol(spec.E), D = tol(spec.D);
      let name;
      if (spec.style === "SOJ") {
        if (n % 2) throw Error("An SOJ has an even pin count.");
        const per = n / 2;
        for (let i = 0; i < per; i++) ctx.fp.pads.push(pad(i + 1, -rx.padCentre, (i - (per - 1) / 2) * p, rx.padLength, rx.X, ctx.shape));
        for (let i = 0; i < per; i++) ctx.fp.pads.push(pad(per + i + 1, rx.padCentre, ((per - 1) / 2 - i) * p, rx.padLength, rx.X, ctx.shape));
        name = "SOJ" + n2(p) + "P" + n2(nom(spec.L)) + "X" + heightCode(ctx.height ?? 3.75) + "-" + n + lv(ctx);
      } else {
        const perY = spec.perY | 0 || n / 4, perX = n / 2 - perY;
        if (!(perY > 0 && perX > 0) || 2 * (perX + perY) !== n) throw Error("Pins per side must add up to the pin count.");
        const ry = lands({L: spec.L2 ?? spec.L, W: spec.W, ...(spec.S2 ?? spec.S ? {S: spec.S2 ?? spec.S} : {T: spec.T})}, g, ctx.opts);
        clampWidth(ry, p, spec, []);
        cornerFix(rx, (perX - 1) / 2 * p, ry.X, ctx); cornerFix(ry, (perY - 1) / 2 * p, rx.X, ctx);
        quadPads(ctx, perimeter(perY, perX, "top-centre"), perY, perX, p, rx, ry, ctx.shape);
        name = "PLCC" + n2(p) + "P" + n2(nom(spec.L)) + "X" + n2(nom(spec.L2 ?? spec.L)) + "X" + heightCode(ctx.height ?? 4.57) + "-" + n + lv(ctx);
      }
      const p1 = ctx.fp.pads[0];
      dressing(ctx.fp, [-E.max / 2, -D.max / 2, E.max / 2, D.max / 2], g, {silkBody: [-E.nom / 2, -D.nom / 2, E.nom / 2, D.nom / 2],
        pin1: spec.style === "SOJ" ? pin1Dot(p1) : [p1.x, p1.y - p1.h / 2 - .35]});
      return {name, prefix: "U", ipc: {...rx, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- LCC / LCCC: leadless ceramic chip carrier, castellated terminals, pin 1 at the top centre.
  const LCCP = (pins, body) => ({pins, pitch: 1.27, D: PM(body, .25), T: R(1.14, 1.4), W: R(.56, .71), H: R(1.4, 2.54), source: "JEDEC MS-004 (LCCC)", flag: RECALLED});
  add(fam("lcc", "LCC / LCCC (leadless chip carrier)", "SMD", {"LCC-20": LCCP(20, 8.89), "LCC-28": LCCP(28, 11.43), "LCC-44": LCCP(44, 16.51), "LCC-68": LCCP(68, 24.13)},
    {preset: "LCC-28", keywords: "lcc lccc leadless chip carrier ceramic castellated",
      fields: [intField("pins", "Pins"), numField("pitch", "Pitch e"), tolField("D", "Body size"), tolField("T", "Terminal length"), tolField("W", "Terminal width"), tolField("H", "Height")],
      generate(spec, ctx) {
        const g = goal("lcc", lv(ctx)); push(ctx, g.flagged, spec.flag);
        const n = spec.pins | 0, p = spec.pitch, per = n / 4;
        if (n % 4 || per < 1) throw Error("An LCC has a pin count divisible by four.");
        const r = lands({L: spec.D, W: spec.W, T: spec.T}, g, ctx.opts);
        clampWidth(r, p, spec, ctx.flagged);
        cornerFix(r, (per - 1) / 2 * p, r.X, ctx);
        quadPads(ctx, perimeter(per, per, "top-centre"), per, per, p, r, r, ctx.shape);
        const D = tol(spec.D), p1 = ctx.fp.pads[0];
        dressing(ctx.fp, [-D.max / 2, -D.max / 2, D.max / 2, D.max / 2], g, {silkBody: [-D.nom / 2, -D.nom / 2, D.nom / 2, D.nom / 2], pin1: [p1.x, p1.y - p1.h / 2 - .35]});
        return {name: "LCC" + n2(p) + "P" + n2(D.nom) + "X" + n2(D.nom) + "X" + heightCode(ctx.height ?? 2) + "-" + n + lv(ctx), prefix: "U", ipc: {...r, goal: g, sources: srcOf(spec)}};
      }}));

  // ---- QFP family (built-in gull-wing generator). JEDEC MS-026 (LQFP 1.4 mm / TQFP 1.0 mm body),
  // MS-022 (PQFP / MQFP), MO-069 (BQFP), MO-112 (CQFP). Lead span = body + 2.0 (MS-026) or + 3.2 (MS-022).
  const BW = {.8: R(.3, .45), .65: R(.22, .38), .5: R(.17, .27), .4: R(.13, .23)};
  const QFP = (pins, body, pitch, H, o = {}) => ({style: "QFP", pins, pitch, L: o.L || PM(body + 2, .2), T: o.T || R(.45, .75), W: o.W || BW[pitch], D: PM(body, .1), E: PM(body, .1), H,
    ...(o.ipcPrefix ? {ipcPrefix: o.ipcPrefix} : {}), source: o.source || (H <= 1.2 ? "JEDEC MS-026 (TQFP, 1.0 mm body)" : "JEDEC MS-026 (LQFP, 1.4 mm body)"), ...(o.ok ? {} : {flag: o.flag || UNVERIFIED})});
  // LQFP presets with an NXP outline drawing (JEDEC MS-026): lead span HD, lead width bp and foot Lp from it.
  const NXPQ = (pins, body, pitch, sot, L, W, T) => QFP(pins, body, pitch, 1.6, {L, W, T, ok: true, source: "NXP " + sot + " (JEDEC MS-026)"});
  add(fam("qfp", "QFP: LQFP, TQFP, PQFP, BQFP, CQFP (+ exposed pad)", "SMD", {
    "LQFP-32 7×7 0.8": NXPQ(32, 7, .8, "SOT358-1", R(8.85, 9.15), R(.3, .4)), "LQFP-44 10×10 0.8": NXPQ(44, 10, .8, "SOT389-1", R(11.85, 12.15), R(.3, .45)),
    "LQFP-52 10×10 0.65": QFP(52, 10, .65, 1.6), "LQFP-80 12×12 0.5": NXPQ(80, 12, .5, "SOT315-1", R(13.85, 14.15), R(.13, .27), R(.3, .75)),
    "LQFP-80 14×14 0.65": QFP(80, 14, .65, 1.6), "LQFP-128 14×14 0.4": QFP(128, 14, .4, 1.6), "LQFP-144 20×20 0.5": NXPQ(144, 20, .5, "SOT486-1", R(21.85, 22.15), R(.17, .27)),
    "LQFP-176 24×24 0.5": NXPQ(176, 24, .5, "SOT506-1", R(25.85, 26.15), R(.17, .27)), "LQFP-208 28×28 0.5": NXPQ(208, 28, .5, "SOT459-1", R(29.85, 30.15), R(.17, .27)),
    "TQFP-32 7×7 0.8": QFP(32, 7, .8, 1.2), "TQFP-44 10×10 0.8": QFP(44, 10, .8, 1.2), "TQFP-48 7×7 0.5": QFP(48, 7, .5, 1.2), "TQFP-64 10×10 0.5": QFP(64, 10, .5, 1.2),
    "TQFP-100 14×14 0.5": QFP(100, 14, .5, 1.2), "TQFP-144 20×20 0.5": QFP(144, 20, .5, 1.2),
    "HTQFP-64 10×10 0.5 EP": {...QFP(64, 10, .5, 1.2), EP: {D: R(5.9, 6.1), E: R(5.9, 6.1)}, pasteCoverage: .6, thermalVias: {drill: .3, pitch: 1.2, pad: .7}, source: "JEDEC MS-026 with exposed pad (HTQFP)", flag: "Exposed pad size varies by maker. " + RECALLED},
    "PQFP-44 10×10 0.8": QFP(44, 10, .8, 2.45, {L: R(12.95, 13.45), T: R(.73, 1.03), source: "JEDEC MS-022 (PQFP)"}),
    "PQFP-100 14×20 0.65": {...QFP(100, 14, .65, 3.4, {L: R(16.95, 17.45), T: R(.73, 1.03), source: "JEDEC MS-022 (PQFP, 14 × 20)"}), D: PM(20, .1), L2: R(22.95, 23.45), perSide: [30, 20]},
    "PQFP-208 28×28 0.5": QFP(208, 28, .5, 4.1, {L: R(30.35, 30.85), T: R(.5, .75), source: "JEDEC MS-029 (PQFP 28 × 28)"}),
    "BQFP-132 0.635": QFP(132, 24.13, .635, 4.57, {L: R(27.18, 27.69), T: R(.51, 1.02), W: R(.2, .3), ipcPrefix: "BQFP", source: "JEDEC MO-069 (bumpered QFP)", flag: "Bumper corners are part of the body (courtyard follows the body). " + RECALLED}),
    "CQFP-64 0.8": QFP(64, 14, .8, 3, {L: R(17.6, 18.4), T: R(.6, 1), W: R(.3, .45), ipcPrefix: "CQFP", source: "JEDEC MO-112 (ceramic QFP)", flag: RECALLED})
  }, {base: "gullwing", preset: "LQFP-32 7×7 0.8", keywords: "qfp lqfp tqfp pqfp bqfp cqfp mqfp htqfp quad flat pack", get fields() { return K.fieldsOf("gullwing"); }}));

  // ---- SOP family (built-in gull-wing generator): SOIC, SSOP, QSOP, TSSOP, MSOP / VSSOP, TSOP I and II.
  const SO = (pins, pitch, L, T, W, D, E, H, src, o = {}) => ({style: pitch === 1.27 && !o.sop ? "SOIC" : "SOP", pins, pitch, L, T, W, D, E, H, source: src, ...o.extra});
  // SOIC keeps the JEDEC ranges (KiCad's JEDEC-cited soic.yaml); NXP's SO drawings (SOT96-1, SOT109-1,
  // SOT163-1, SOT137-1, SOT136-1) lie within them. TSSOP and MSOP use NXP's MO-153 / 3 × 3 drawings.
  const MS012 = (pins, D, sot) => SO(pins, 1.27, R(5.8, 6.2), R(.4, 1.27), R(.31, .51), D, R(3.8, 4), 1.75, "JEDEC MS-012 (as cited in KiCad soic.yaml); NXP " + sot + " lies within");
  const MS013 = (pins, D, sot) => SO(pins, 1.27, R(10, 10.65), R(.4, 1.27), R(.31, .51), D, R(7.4, 7.6), 2.65, "JEDEC MS-013; lead span and body as NXP " + sot);
  const MO150 = (pins, D) => SO(pins, .65, R(7.4, 8.2), R(.55, .95), R(.22, .38), D, R(5, 5.6), 2, "JEDEC MO-150 (SSOP 5.3 mm)", {extra: {flag: UNVERIFIED}});
  const MO153 = (pins, D, sot, L = R(6.2, 6.6), T = R(.5, .75)) => SO(pins, .65, L, T, R(.19, .3), D, R(4.3, 4.5), 1.2, "NXP " + sot + " (JEDEC MO-153); height MO-153 A max 1.20");
  const MO187 = (pins, pitch) => pitch === .5 ? SO(pins, .5, R(4.8, 5), R(.4, .7), R(.15, .23), R(2.9, 3.1), R(2.9, 3.1), 1.1, "NXP SOT552-1 (3 × 3 mm, 0.5 pitch)")
    : SO(pins, .65, R(4.7, 5.1), R(.4, .7), R(.25, .45), R(2.9, 3.1), R(2.9, 3.1), 1.1, "NXP SOT505-1 (3 × 3 mm, 0.65 pitch)");
  const EPX = (o, D, E, flag) => ({...o, EP: {D, E}, pasteCoverage: .6, thermalVias: {drill: .3, pitch: 1.2, pad: .7}, flag});
  add(fam("sop", "SOP: SOIC, SSOP, QSOP, TSSOP, MSOP, VSSOP, TSOP I / II (+ exposed pad)", "SMD", {
    "SOIC-16": MS012(16, R(9.8, 10), "SOT109-1"), "SOIC-8 EP": EPX(MS012(8, R(4.8, 5), "SOT96-1"), R(3.1, 3.5), R(2.2, 2.6), "Exposed pad size varies by maker. " + RECALLED),
    "SOIC-20W": MS013(20, R(12.6, 13), "SOT163-1"), "SOIC-24W": MS013(24, R(15.2, 15.6), "SOT137-1"), "SOIC-28W": MS013(28, R(17.7, 18.1), "SOT136-1"),
    "SSOP-16": MO150(16, R(5.9, 6.5)), "SSOP-24": MO150(24, R(7.9, 8.5)), "SSOP-28": MO150(28, R(9.9, 10.5)),
    "QSOP-16": SO(16, .635, R(5.8, 6.2), R(.4, 1.27), R(.2, .3), R(4.8, 5), R(3.8, 4), 1.75, "JEDEC MO-137 (QSOP)", {extra: {flag: UNVERIFIED}}),
    "QSOP-24": SO(24, .635, R(5.8, 6.2), R(.4, 1.27), R(.2, .3), R(8.55, 8.75), R(3.8, 4), 1.75, "JEDEC MO-137 (QSOP)", {extra: {flag: UNVERIFIED}}),
    "TSSOP-8": MO153(8, R(2.9, 3.1), "SOT530-1", R(6.3, 6.5), R(.5, .7)), "TSSOP-16": MO153(16, R(4.9, 5.1), "SOT403-1"), "TSSOP-24": MO153(24, R(7.7, 7.9), "SOT355-1"),
    "TSSOP-28": MO153(28, R(9.6, 9.8), "SOT361-1"),
    "TSSOP-38 0.5": SO(38, .5, R(6.2, 6.6), R(.45, .75), R(.17, .27), R(9.6, 9.8), R(4.3, 4.5), 1.2, "JEDEC MO-153 (0.5 pitch)", {extra: {flag: UNVERIFIED}}),
    "TSSOP-20 EP": EPX(MO153(20, R(6.4, 6.6), "SOT360-1"), R(3.8, 4.2), R(2.2, 2.6), "Exposed pad size varies by maker (TI PowerPAD PWP). " + RECALLED),
    "MSOP-8": MO187(8, .65), "MSOP-10": MO187(10, .5), "VSSOP-8": MO187(8, .65), "VSSOP-10": MO187(10, .5),
    "MSOP-8 EP": EPX(MO187(8, .65), R(1.7, 1.9), R(1.5, 1.8), "Exposed pad size varies by maker. " + RECALLED),
    "TSOP-I-32 8×20": SO(32, .5, R(19.8, 20.2), R(.5, .7), R(.17, .27), R(7.9, 8.1), R(18.3, 18.5), 1.2, "JEDEC MO-142 (TSOP type I)", {extra: {flag: UNVERIFIED}}),
    "TSOP-I-48 12×20": SO(48, .5, R(19.8, 20.2), R(.5, .7), R(.17, .27), R(11.9, 12.1), R(18.3, 18.5), 1.2, "JEDEC MO-142 (TSOP type I)", {extra: {flag: UNVERIFIED}}),
    "TSOP-I-56 14×20": SO(56, .5, R(19.8, 20.2), R(.5, .7), R(.17, .27), R(13.9, 14.1), R(18.3, 18.5), 1.2, "JEDEC MO-142 (TSOP type I)", {extra: {flag: UNVERIFIED}}),
    "TSOP-II-44 400 mil": SO(44, .8, R(11.56, 11.96), R(.4, .6), R(.3, .45), R(18.31, 18.52), R(10.03, 10.29), 1.2, "JEDEC MS-024 (TSOP type II, 400 mil)", {extra: {flag: UNVERIFIED}}),
    "TSOP-II-54 400 mil": SO(54, .8, R(11.56, 11.96), R(.4, .6), R(.3, .45), R(22.09, 22.35), R(10.03, 10.29), 1.2, "JEDEC MS-024 (TSOP type II, 400 mil)", {extra: {flag: UNVERIFIED}}),
    "TSOP-II-66 400 mil": SO(66, .65, R(11.56, 11.96), R(.4, .6), R(.22, .38), R(22.09, 22.35), R(10.03, 10.29), 1.2, "JEDEC MS-024 (TSOP type II, 400 mil)", {extra: {flag: UNVERIFIED}})
  }, {base: "gullwing", preset: "SOIC-16", keywords: "soic so sop ssop qsop tssop msop vssop tsop powerpad exposed pad", get fields() { return K.fieldsOf("gullwing"); }}));

  // ---- QFN / DFN / SON family (built-in no-lead generator): JEDEC MO-220 (QFN), MO-229 (DFN/SON),
  // pull-back PQFN / PSON (IPC-7351B pull-back goals), LGA perimeter (bottom-only goals).
  const QFNP = (pins, body, pitch, ep, H = R(.8, 1), o = {}) => ({style: o.style || "QFN", pins, pitch, D: o.D || PM(body, .1), E: PM(o.E ?? body, .1), T: o.T || R(.3, .5),
    W: o.W || (pitch <= .4 ? R(.15, .25) : pitch <= .5 ? R(.18, .3) : R(.25, .35)), ...(ep ? {EP: o.EP || {D: PM(ep[0], .1), E: PM(ep[1] ?? ep[0], .1)}} : {}), H,
    pasteCoverage: .6, thermalVias: ep && Math.min(ep[0], ep[1] ?? ep[0]) >= 2.4 ? {drill: .3, pitch: 1.2, pad: .7} : null, source: o.source || (o.style === "SON" ? "JEDEC MO-229 (DFN/SON)" : "JEDEC MO-220 (QFN)"),
    ...(o.ok ? {} : {flag: o.flag ?? UNVERIFIED}), ...(o.extra || {})});
  // QFN presets with an NXP HVQFN outline drawing (JEDEC MO-220): terminal L, width b and exposed pad Dh from it.
  const NXPN = (pins, body, sot, T, ep) => QFNP(pins, body, .5, [(ep.min + ep.max) / 2], R(.8, 1), {T, W: R(.18, .3), EP: {D: ep, E: ep}, ok: true, source: "NXP " + sot + " (JEDEC MO-220)"});
  add(fam("qfn", "QFN / DFN / SON, PQFN (pull-back), LGA perimeter", "SMD", {
    "QFN-20 4×4 0.5": NXPN(20, 4, "SOT917-1 HVQFN20", R(.4, .6), R(2.15, 2.45)), "QFN-24 4×4 0.5": NXPN(24, 4, "SOT616-3 HVQFN24", R(.3, .5), R(2.45, 2.75)),
    "QFN-28 5×5 0.5": QFNP(28, 5, .5, [3.25]), "QFN-40 6×6 0.5": NXPN(40, 6, "SOT618-1 HVQFN40", R(.3, .5), R(3.95, 4.25)),
    "QFN-56 7×7 0.4": QFNP(56, 7, .4, [5.2]), "QFN-64 9×9 0.5": NXPN(64, 9, "SOT804-1 HVQFN64", R(.3, .5), R(4.55, 4.85)), "QFN-16 4×4 0.65": QFNP(16, 4, .65, [2.1]),
    "DFN-8 2×2 0.5": QFNP(8, 2, .5, [1.6, .9], R(.7, .8), {style: "SON", T: R(.25, .45), W: R(.2, .3)}), "DFN-10 3×3 0.5": QFNP(10, 3, .5, [2.4, 1.65], R(.8, 1), {style: "SON", W: R(.18, .3)}),
    "DFN-8 5×6 1.27 (SO-8 flat lead)": QFNP(8, 5, 1.27, [4, 3.8], R(.9, 1.1), {style: "SON", D: PM(5, .1), E: 6, T: R(.5, .7), W: R(.33, .51), source: "JEDEC MO-240 (5 × 6 power SON)", flag: "Exposed pad position (offset towards pins 5–8) is centred here. " + RECALLED}),
    "PQFN-12 4×4 0.65 (pull-back)": QFNP(12, 4, .65, [2.4], R(.8, 1), {T: R(.3, .5), extra: {goalTable: "noleadPullBack", ipcPrefix: "PQFN", Lt: R(3.7, 3.9)}, flag: "Pull-back distance (0.15 mm) estimated; take Lt from the datasheet. " + RECALLED}),
    "PSON-8 3×3 0.65 (pull-back)": QFNP(8, 3, .65, [2.4, 1.5], R(.7, .8), {style: "SON", extra: {goalTable: "noleadPullBack", ipcPrefix: "PSON", Lt: R(2.7, 2.9)}, flag: "Pull-back distance estimated; take Lt from the datasheet. " + RECALLED}),
    "LGA-14 2.5×3 0.5 (perimeter)": {style: "QFN", pins: 12, pitch: .5, D: PM(3, .1), E: PM(2.5, .1), T: R(.375, .475), W: R(.2, .3), H: R(.9, 1), goalTable: "bottom", ipcPrefix: "LGA",
      pasteCoverage: .6, thermalVias: null, source: "Typical MEMS sensor LGA-12/14 outline", flag: "Perimeter LGA approximated with equal pins per side; enter the pad map from the datasheet. " + RECALLED}
  }, {base: "nolead", preset: "QFN-20 4×4 0.5", keywords: "qfn dfn son vqfn wqfn wson pqfn pson lga exposed pad thermal", get fields() {
    return [...K.fieldsOf("nolead"), ["goalTable", "Goal table", [["nolead", "Toe fillet (QFN/SON)"], ["noleadPullBack", "Pull-back (PQFN/PSON)"], ["bottom", "Bottom only (LGA)"]]], tolField("Lt", "Terminal span (pull-back)")];
  }}));

  // ---- QFN dual row: outer and inner terminal rings, inner row staggered by half a pitch.
  add(fam("qfn2row", "QFN dual row (QFN-2ROW)", "SMD", {
    "QFN-2ROW-84 7×7 0.5": {perOuter: 11, perInner: 10, pitch: .5, rowPitch: .55, D: PM(7, .1), T: R(.25, .35), W: R(.2, .3), EP: {D: PM(3.5, .1), E: PM(3.5, .1)}, H: R(.8, .9), pasteCoverage: .6,
      thermalVias: {drill: .3, pitch: 1.2, pad: .7}, source: "Dual-row QFN (A/B rows) outline, typical of MCU and RF parts", flag: EXAMPLE},
    "QFN-2ROW-52 5×5 0.5": {perOuter: 7, perInner: 6, pitch: .5, rowPitch: .55, D: PM(5, .1), T: R(.25, .35), W: R(.2, .3), EP: {D: PM(2.1, .1), E: PM(2.1, .1)}, H: R(.8, .9), pasteCoverage: .6,
      thermalVias: null, source: "Dual-row QFN outline", flag: EXAMPLE}
  }, {keywords: "qfn 2row dual row a b ring staggered",
    fields: [intField("perOuter", "Outer pins per side (A)"), intField("perInner", "Inner pins per side (B)"), numField("pitch", "Pitch in a row"), numField("rowPitch", "Row-to-row spacing"),
      tolField("D", "Body size"), tolField("T", "Terminal length"), tolField("W", "Terminal width"), tolField("EP.D", "Exposed pad D2"), tolField("EP.E", "Exposed pad E2"), numField("pasteCoverage", "EP paste coverage"),
      numField("thermalVias.drill", "Thermal via drill (0 = none)"), tolField("H", "Height")],
    generate(spec, ctx) {
      const g = goal("nolead", lv(ctx)); push(ctx, spec.flag);
      const po = spec.perOuter | 0, pi = spec.perInner | 0, p = spec.pitch, rp = spec.rowPitch, D = tol(spec.D), T = tol(spec.T), Wt = tol(spec.W);
      if (!(po > 0 && pi >= 0)) throw Error("Enter the pins per side.");
      const r = lands({L: spec.D, W: spec.W, T: spec.T}, g, ctx.opts);
      clampWidth(r, p, spec, ctx.flagged);
      quadPads(ctx, perimeter(po, po), po, po, p, r, r, ctx.shape);
      ctx.fp.pads.forEach(q => { q.number = "A" + q.number; });
      // Inner row: a bottom-only land centred one row pitch inside the outer terminals
      // (dual-row parts leave little room between the rows: the inner land is the nominal terminal + 0.10).
      const il = near(T.nom + .1, .05), iw = Math.min(r.X, near(Wt.nom + .05, .05));
      const c = D.nom / 2 - T.nom / 2 - rp;
      if (r.G / 2 - (c + il / 2) < .1 - 1e-9 || c - il / 2 < .1) throw Error("The inner row is closer than 0.1 mm to the outer lands or the centre: change the row spacing.");
      perimeter(pi, pi).forEach((q, k) => {
        const off = (q.i - (pi - 1) / 2) * p, n = "B" + (k + 1);
        if (q.side === "L") ctx.fp.pads.push(pad(n, -c, off, il, iw, ctx.shape)); else if (q.side === "R") ctx.fp.pads.push(pad(n, c, off, il, iw, ctx.shape));
        else if (q.side === "B") ctx.fp.pads.push(pad(n, off, c, iw, il, ctx.shape)); else ctx.fp.pads.push(pad(n, off, -c, iw, il, ctx.shape));
      });
      if (spec.EP) K.exposedPad(ctx.fp, spec, "EP", ctx.ipc);
      dressing(ctx.fp, [-D.max / 2, -D.max / 2, D.max / 2, D.max / 2], g, {silkBody: [-D.nom / 2, -D.nom / 2, D.nom / 2, D.nom / 2], pin1: pin1Dot(ctx.fp.pads[0])});
      const count = 4 * (po + pi) + (spec.EP ? 1 : 0);
      return {name: "QFN" + n2(p) + "P" + n2(D.nom) + "X" + n2(D.nom) + "X" + heightCode(ctx.height ?? .9) + "-" + count + lv(ctx), prefix: "U", ipc: {...r, inner: {length: il, width: iw, centre: r6(c)}, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- LGA grid: lands equal to the terminal (bottom-only, 1:1), JEDEC row letters.
  add(fam("lga", "LGA (land grid array)", "SMD", {
    "LGA-16 3×3 0.65": {rows: 4, cols: 4, pitch: .65, termW: .35, termH: .35, termShape: "rect", D: PM(3, .1), E: PM(3, .1), H: 1, depop: "", source: "Typical LGA module outline", flag: EXAMPLE},
    "LGA-100 10×10 1.0": {rows: 10, cols: 10, pitch: 1, termW: .5, termH: .5, termShape: "round", D: PM(10, .1), E: PM(10, .1), H: 1.2, depop: "", source: "Typical LGA outline", flag: EXAMPLE},
    "LGA-48 module 1.0 (perimeter)": {rows: 8, cols: 8, pitch: 1, termW: .6, termH: .6, termShape: "rect", D: PM(9, .1), E: PM(9, .1), H: 1.5, depop: "center:4", source: "Typical LGA module outline", flag: EXAMPLE}
  }, {keywords: "lga land grid array module sensor",
    fields: [intField("rows", "Rows"), intField("cols", "Columns"), numField("pitch", "Pitch e"), numField("termW", "Terminal width"), numField("termH", "Terminal length"),
      ["termShape", "Terminal shape", [["rect", "Rectangular"], ["round", "Round"]]], ["depop", "Depopulate (A1, C3-C5, center:N)", "text"], tolField("D", "Body length"), tolField("E", "Body width"), tolField("H", "Height")],
    generate(spec, ctx) {
      const g = goal("bottom", lv(ctx)); push(ctx, g.flagged, spec.flag);
      const rows = spec.rows | 0, cols = spec.cols | 0, p = spec.pitch, skip = depopulated(spec);
      if (!(rows > 0 && cols > 0 && rows * cols <= 4096)) throw Error("Enter between 1 and 4096 lands.");
      // IPC-7351B: LGA lands equal the terminal (1:1); the side goal and tolerances do not widen them.
      const w = near(Math.min(spec.termW, p - .15), .01), h = near(Math.min(spec.termH, p - .15), .01), shape = spec.termShape === "round" ? "round" : "rect";
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const id = rowName(r) + (c + 1); if (!skip.has(id)) ctx.fp.pads.push(pad(id, (c - (cols - 1) / 2) * p, (r - (rows - 1) / 2) * p, w, h, shape)); }
      const D = tol(spec.D), E = tol(spec.E ?? spec.D);
      dressing(ctx.fp, [-E.max / 2, -D.max / 2, E.max / 2, D.max / 2], g, {silkBody: [-E.nom / 2, -D.nom / 2, E.nom / 2, D.nom / 2], pin1: [-E.nom / 2 - .4, -D.nom / 2 - .4]});
      const n = ctx.fp.pads.length;
      return {name: "LGA" + n + "P" + n2(p) + "P" + cols + "X" + rows + "_" + n2(E.nom) + "X" + n2(D.nom) + "X" + heightCode(ctx.height ?? 1) + lv(ctx), prefix: "U", ipc: {land: w, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- CSP / WLCSP and BGA variants (built-in BGA generator: staggered rows, custom ball maps).
  const BGAP = (rows, cols, pitch, ball, D, H, o = {}) => ({rows, cols, pitch, ball, D, E: o.E ?? D, H, depop: o.depop || "", padShape: "round", ...(o.map ? {map: o.map} : {}), ...(o.stagger ? {stagger: true, rowPitch: o.rowPitch} : {}),
    ...(o.collapsing === false ? {collapsing: false} : {}), source: o.source || "JEDEC MO-275 / MO-211 (fine-pitch BGA)", flag: o.flag});
  add(fam("csp", "CSP / WLCSP / fine-pitch BGA", "SMD", {
    "WLCSP-9 0.4": BGAP(3, 3, .4, .25, 1.2, .5, {source: "Typical WLCSP outline", flag: "Body size depends on the die. " + RECALLED}),
    "WLCSP-16 0.4": BGAP(4, 4, .4, .25, 1.6, .5, {source: "Typical WLCSP outline", flag: "Body size depends on the die. " + RECALLED}),
    "WLCSP-20 0.4": BGAP(5, 4, .4, .25, 1.6, .5, {E: 2, source: "Typical WLCSP outline", flag: "Body size depends on the die. " + RECALLED}),
    "WLCSP-25 0.4": BGAP(5, 5, .4, .25, 2, .5, {source: "Typical WLCSP outline", flag: "Body size depends on the die. " + RECALLED}),
    "WLCSP-36 0.35": BGAP(6, 6, .35, .22, 2.1, .5, {source: "Typical WLCSP outline", flag: "Body size depends on the die. " + RECALLED}),
    "UFBGA-64 0.5": BGAP(8, 8, .5, .3, 5, .6, {source: "JEDEC MO-195 (UFBGA)"}),
    "TFBGA-100 0.8": BGAP(10, 10, .8, .4, 9, 1.2, {source: "JEDEC MO-275 (TFBGA)"}),
    "LFBGA-144 0.8": BGAP(12, 12, .8, .45, 10, 1.4, {source: "JEDEC MO-275 (LFBGA)"}),
    "BGA-484 1.0": BGAP(22, 22, 1, .5, 23, 2.2, {source: "JEDEC MS-034 (PBGA 1.0 mm)"}),
    "BGA-81 0.8 staggered": BGAP(9, 9, .8, .4, 8, 1.2, {stagger: true, rowPitch: .8, source: "Staggered (offset-row) ball array", flag: EXAMPLE}),
    "BGA custom map 1.0": BGAP(0, 0, 1, .5, 7, 1.2, {map: "XXXXXX\nX....X\nX.XX.X\nX.XX.X\nX....X\nXXXXXX", source: "Custom ball map", flag: EXAMPLE})
  }, {base: "bga", preset: "WLCSP-16 0.4", keywords: "csp wlcsp ufbga tfbga lfbga fbga bga staggered custom ball map", get fields() {
    return [...K.fieldsOf("bga"), ["map", "Ball map (X = ball, . = none; one row per line)", "text"], ["stagger", "Rows", [["false", "Aligned"], ["true", "Staggered (odd rows +½ pitch)"]]], numField("rowPitch", "Row pitch")];
  }}));

  // ---- inductors: wire-wound chip (chip goals) and molded / shielded power inductors (inward L goals).
  const IND = (table, L, BW, W, T, H, src, o = {}) => ({table, L, BW, W, T, H, source: src, flag: o.flag ?? RECALLED});
  add(fam("inductor", "Inductors: power (molded, shielded) and wire-wound chip", "SMD", {
    "Wire-wound 0402 (1005)": IND("chip", R(.96, 1.16), R(.5, .66), R(.4, .56), R(.15, .35), R(.5, .66), "Coilcraft 0402HP outline"),
    "Wire-wound 0603 (1608)": IND("chip", R(1.6, 1.9), R(1, 1.2), R(.6, .8), R(.2, .45), R(.9, 1.1), "Coilcraft 0603HP outline"),
    "Wire-wound 0805 (2012)": IND("chip", R(2.1, 2.4), R(1.5, 1.8), R(1, 1.3), R(.3, .6), R(1.3, 1.6), "Coilcraft 0805HP outline"),
    "Wire-wound 1008 (2520)": IND("chip", R(2.6, 2.95), R(2.4, 2.8), R(1.6, 2), R(.35, .65), R(1.7, 2.1), "Coilcraft 1008HQ outline"),
    "Power 2520 (2.5×2.0×1.2)": IND("chip", R(2.3, 2.7), R(1.8, 2.2), R(1.7, 2.1), R(.4, .8), R(1, 1.2), "Metal-composite 2520 power inductor outline"),
    "Power 4040 (4×4×2)": IND("molded", R(3.8, 4.2), R(3.8, 4.2), R(2.8, 3.4), R(.8, 1.4), R(1.8, 2), "Shielded 4 × 4 power inductor outline"),
    "Power 5040 (5×5×4)": IND("molded", R(4.7, 5.3), R(4.7, 5.3), R(3.4, 4), R(1, 1.6), R(3.7, 4), "Shielded 5 × 5 power inductor outline"),
    "Power 6045 (6×6×4.5)": IND("molded", R(5.7, 6.3), R(5.7, 6.3), R(4.2, 4.8), R(1.2, 1.8), R(4.2, 4.5), "Shielded 6 × 6 power inductor outline"),
    "Power 7040 (7×7×4)": IND("molded", R(6.7, 7.3), R(6.7, 7.3), R(4.8, 5.6), R(1.3, 1.9), R(3.7, 4), "Molded 7 × 7 power inductor outline"),
    "Power 1040 (10×10×4)": IND("molded", R(9.7, 10.3), R(9.7, 10.3), R(5.8, 6.6), R(2, 2.8), R(3.7, 4), "Molded 10 × 10 power inductor outline"),
    "Power 1265 (12.5×12.5×6.5)": IND("molded", R(12.2, 12.8), R(12.2, 12.8), R(6, 7), R(2.3, 3.1), R(6.2, 6.5), "Molded 12.5 × 12.5 power inductor outline")
  }, {preset: "Power 4040 (4×4×2)", keywords: "inductor power shielded molded wire-wound coil choke ihlp srp",
    fields: [["table", "Terminal type", [["molded", "Molded / inward L (INDM)"], ["chip", "Chip ends (INDC)"]]], tolField("L", "Body length (terminal span)"), tolField("BW", "Body width"), tolField("W", "Terminal width"),
      tolField("T", "Terminal length"), tolField("H", "Height")],
    generate(spec, ctx) {
      push(ctx, spec.flag);
      const chip = spec.table === "chip", {r, g, bw} = twoTerm(spec, ctx, chip ? "chip" : "molded", {});
      return {name: (chip ? "INDC" : "INDM") + n2(nom(spec.L), 10).padStart(2, "0") + n2(bw.nom, 10).padStart(2, "0") + "X" + heightCode(ctx.height ?? 1) + lv(ctx), prefix: "L", ipc: {...r, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- terminal-array parts (crystals, oscillators, LEDs): terminal centres and sizes per preset.
  // 2-pad: toe along x at ±x; 4-pad: corners, counter-clockwise from the top left (pin 1).
  const two = (x, l, w) => [{n: 1, x: -x, y: 0, l, w, toe: "x"}, {n: 2, x, y: 0, l, w, toe: "x"}];
  const four = (x, y, l, w) => [{n: 1, x: -x, y: -y, l, w, toe: "x"}, {n: 2, x: -x, y, l, w, toe: "x"}, {n: 3, x, y, l, w, toe: "x"}, {n: 4, x, y: -y, l, w, toe: "x"}];
  const six = (x, p, l, w) => [{n: 1, x: -x, y: -p, l, w, toe: "x"}, {n: 2, x: -x, y: 0, l, w, toe: "x"}, {n: 3, x: -x, y: p, l, w, toe: "x"}, {n: 4, x, y: p, l, w, toe: "x"}, {n: 5, x, y: 0, l, w, toe: "x"}, {n: 6, x, y: -p, l, w, toe: "x"}];
  function termFamily(id, title, presets, o) {
    add(fam(id, title, "SMD", presets, {preset: o.preset, keywords: o.keywords,
      fields: [numField("BL", "Body length"), numField("BW", "Body width"), tolField("H", "Height"), ["terms", "Terminals (n x y length width; …)", "text"], numField("termTol", "Terminal tolerance")],
      generate(spec, ctx) {
        push(ctx, spec.flag);
        const list = typeof spec.terms === "string" ? parseTerms(spec.terms) : spec.terms;
        if (!list?.length) throw Error("Enter at least one terminal: number, x, y, length, width.");
        const g = bottomTerms(spec, ctx, list, spec.goalTable || "bottom");
        const bl = +spec.BL, bw = +spec.BW;
        dressing(ctx.fp, [-bl / 2, -bw / 2, bl / 2, bw / 2], g, {silk: false, chamfer: o.chamfer !== false});
        ctx.fp.shapes.push(...silkPoly(ctx.fp, box(-bl / 2 - SILK_W / 2 - .05, -bw / 2 - SILK_W / 2 - .05, bl / 2 + SILK_W / 2 + .05, bw / 2 + SILK_W / 2 + .05), true));
        const p1 = ctx.fp.pads.find(p => p.number === "1") || ctx.fp.pads[0];
        if (o.polar !== false) ctx.fp.shapes.push(dot(p1.x - p1.w / 2 - .35, p1.y));
        const pins = ctx.fp.pads.length;
        return {name: o.name(spec, ctx, pins), prefix: o.prefix, ipc: {goal: g, sources: srcOf(spec), terminals: list.length}};
      }}));
  }
  function parseTerms(text) {
    return String(text).split(/[;\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
      const [n, x, y, l, w, toe] = s.split(/[\s,]+/);
      const v = [x, y, l, w].map(Number);
      if (!n || !v.every(Number.isFinite) || !(v[2] > 0 && v[3] > 0)) throw Error("Each terminal is: number x y length width [x|y|none].");
      return {n, x: v[0], y: v[1], l: v[2], w: v[3], toe: toe === "none" ? null : toe === "y" ? "y" : "x"};
    });
  }
  const XT = (BL, BW, H, terms, src) => ({BL, BW, H: R(r6(H * .85), H), terms, source: src, flag: RECALLED});
  termFamily("xtal", "Crystals and oscillators, SMD (2 and 4 pad)", {
    "2-pad 2012 (32.768 kHz)": XT(2, 1.2, .6, two(.7, .5, 1), "Epson FC-12M / 2012 tuning-fork crystal outline"),
    "2-pad 3215 (32.768 kHz)": XT(3.2, 1.5, .9, two(1.15, .8, 1.2), "Epson FC-135 / 3215 tuning-fork crystal outline"),
    "2-pad 5032": XT(5, 3.2, 1.1, two(1.85, 1.3, 2), "5032 2-pad crystal outline"),
    "2-pad HC-49 SMD 11.4×4.7": XT(11.4, 4.7, 4.3, two(4.4, 4, 1.6), "HC-49/SMD (HC-49S-SMD) crystal outline"),
    "4-pad 2016": XT(2, 1.6, .55, four(.65, .5, .6, .45), "2016 4-pad crystal outline"),
    "4-pad 2520": XT(2.5, 2, .6, four(.85, .65, .7, .6), "2520 4-pad crystal / oscillator outline"),
    "4-pad 3225": XT(3.2, 2.5, .8, four(1.1, .8, 1, .8), "3225 4-pad crystal / oscillator outline"),
    "4-pad 5032": XT(5, 3.2, 1.1, four(1.27, 1.1, 1.2, 1), "5032 4-pad crystal / oscillator outline"),
    "4-pad 7050 (oscillator)": XT(7, 5, 1.6, four(2.54, 1.3, 1.8, 1.4), "7050 4-pad oscillator outline")
  }, {preset: "4-pad 3225", keywords: "crystal oscillator xtal xo tcxo resonator 32.768 smd quartz", prefix: "Y",
    name: (s, ctx, n) => (n === 4 ? "OSCCC" : "XTAL") + n2(+s.BL) + "X" + n2(+s.BW) + "X" + heightCode(ctx.height ?? 1) + "-" + n + lv(ctx)});

  // LEDs: PLCC-2 (pin 1 cathode), PLCC-4 and PLCC-6 (5050 RGB), counter-clockwise from the top left.
  termFamily("led", "LEDs, SMD: PLCC-2, PLCC-4, 5050 (PLCC-6)", {
    "PLCC-2 3528": {BL: 3.5, BW: 2.8, H: R(1.7, 1.9), terms: two(1.45, .9, 2.2), source: "PLCC-2 3528 LED outline (e.g. Osram TOPLED)", flag: RECALLED},
    "PLCC-4 3528": {BL: 3.5, BW: 2.8, H: R(1.7, 1.9), terms: four(1.45, .75, .9, .8), source: "PLCC-4 3528 LED outline", flag: RECALLED},
    "PLCC-6 5050": {BL: 5, BW: 5, H: R(1.4, 1.6), terms: six(2.35, 1.6, 1.2, .9), source: "PLCC-6 5050 RGB LED outline", flag: RECALLED},
    "PLCC-4 5050": {BL: 5, BW: 5, H: R(1.4, 1.6), terms: four(2.35, 1.6, 1.2, 1), source: "PLCC-4 5050 LED outline", flag: RECALLED}
  }, {preset: "PLCC-2 3528", keywords: "led plcc 3528 5050 rgb smd light ws2812 topled", prefix: "D",
    name: (s, ctx, n) => "LEDSC" + n2(+s.BL) + "X" + n2(+s.BW) + "X" + heightCode(ctx.height ?? 1.9) + "-" + n + lv(ctx)});

  // ---- SMD tactile switches: gull-wing leads (gull-wing goals), counter-clockwise from the top left.
  const TACT = (n, L, T, W, py, BL, BW, H, src) => ({pins: n, L, T, W, py, BL, BW, H, source: src, flag: RECALLED});
  add(fam("tact", "Tactile switches, SMD", "SMD", {
    "6×6 SMD, 4 leads": TACT(4, R(8, 8.6), R(.8, 1.2), R(.6, .8), 2.25, 6, 6, R(4.1, 4.3), "6 × 6 mm SMD tactile switch outline (gull-wing)"),
    "4.5×4.5 SMD, 4 leads": TACT(4, R(6.2, 6.8), R(.6, 1), R(.5, .7), 1.5, 4.5, 4.5, R(3.3, 3.5), "4.5 × 4.5 mm SMD tactile switch outline"),
    "3×6 SMD, 2 leads": TACT(2, R(8, 8.6), R(.8, 1.2), R(.7, .9), 0, 6, 3.5, R(2.4, 2.6), "3 × 6 mm SMD tactile switch outline")
  }, {keywords: "tactile switch tact button pushbutton smd",
    fields: [["pins", "Leads", [["2", "2"], ["4", "4"]]], tolField("L", "Lead span"), tolField("T", "Foot length"), tolField("W", "Lead width"), numField("py", "Lead row offset (±y)"),
      numField("BL", "Body length"), numField("BW", "Body width"), tolField("H", "Height (with actuator)")],
    generate(spec, ctx) {
      const g = goal("gullwing", lv(ctx)); push(ctx, spec.flag);
      const r = lands({L: spec.L, W: spec.W, T: spec.T}, g, ctx.opts), y = +spec.py || 0;
      if ((spec.pins | 0) === 2) ctx.fp.pads.push(pad(1, -r.padCentre, 0, r.padLength, r.X, ctx.shape), pad(2, r.padCentre, 0, r.padLength, r.X, ctx.shape));
      else ctx.fp.pads.push(pad(1, -r.padCentre, -y, r.padLength, r.X, ctx.shape), pad(2, -r.padCentre, y, r.padLength, r.X, ctx.shape), pad(3, r.padCentre, y, r.padLength, r.X, ctx.shape), pad(4, r.padCentre, -y, r.padLength, r.X, ctx.shape));
      const bl = +spec.BL, bw = +spec.BW;
      dressing(ctx.fp, [-bl / 2, -bw / 2, bl / 2, bw / 2], g, {silk: false});
      ctx.fp.shapes.push(...silkPoly(ctx.fp, box(-bl / 2 - .14, -bw / 2 - .14, bl / 2 + .14, bw / 2 + .14), true), ...silkPoly(ctx.fp, arc(0, 0, Math.min(bl, bw) * .3, 0, 360), true), dot(ctx.fp.pads[0].x - ctx.fp.pads[0].w / 2 - .35, ctx.fp.pads[0].y));
      return {name: "SWT" + n2(bl) + "X" + n2(bw) + "X" + heightCode(ctx.height ?? 4) + "-" + (spec.pins | 0) + lv(ctx), prefix: "SW", ipc: {...r, goal: g, sources: srcOf(spec)}};
    }}));

  // ---- SMD buzzers and transducers: bottom terminals.
  termFamily("buzzer", "Buzzers and transducers, SMD", {
    "Magnetic 9×9 SMD": {BL: 9.6, BW: 9.6, H: R(4.8, 5), terms: [{n: 1, x: -3.5, y: 4.25, l: 1.4, w: 1.8, toe: "y"}, {n: 2, x: 3.5, y: 4.25, l: 1.4, w: 1.8, toe: "y"}], source: "9.6 × 9.6 mm SMD magnetic buzzer outline", flag: EXAMPLE},
    "Piezo 12×12 SMD": {BL: 12, BW: 12, H: R(2.8, 3), terms: [{n: 1, x: -5.5, y: 0, l: 1.5, w: 2.5, toe: "x"}, {n: 2, x: 5.5, y: 0, l: 1.5, w: 2.5, toe: "x"}], source: "12 × 12 mm SMD piezo transducer outline", flag: EXAMPLE}
  }, {keywords: "buzzer beeper transducer piezo magnetic speaker smd", prefix: "BZ", chamfer: false,
    name: (s, ctx, n) => "BUZZER" + n2(+s.BL) + "X" + n2(+s.BW) + "X" + heightCode(ctx.height ?? 3) + "-" + n + lv(ctx)});

  // ---- test pads: round or square copper, no paste.
  add(fam("testpad", "Test pads (SMD)", "SMD", {
    "Round 0.8": {size: .8, padShape: "round"}, "Round 1.0": {size: 1, padShape: "round"}, "Round 1.5": {size: 1.5, padShape: "round"}, "Round 2.0": {size: 2, padShape: "round"},
    "Square 1.0": {size: 1, padShape: "rect"}, "Square 1.5": {size: 1.5, padShape: "rect"}
  }, {preset: "Round 1.0", keywords: "test point pad probe tp ict",
    fields: [numField("size", "Pad size"), ["padShape", "Shape", [["round", "Round"], ["rect", "Square"]]], ["paste", "Solder paste", [["false", "None (bare probe pad)"], ["true", "Paste"]]]],
    generate(spec, ctx) {
      const d = +spec.size;
      if (!(d >= .3 && d <= 10)) throw Error("Enter a pad size from 0.3 to 10 mm.");
      const shape = spec.padShape === "rect" ? "rect" : "round", paste = spec.paste === true || spec.paste === "true";
      ctx.fp.pads.push(pad(1, 0, 0, d, d, shape, paste ? undefined : {pasteExpansion: r6(-d / 2), noPaste: true}));
      const g = goal("bottom", lv(ctx));
      dressing(ctx.fp, [-d / 2, -d / 2, d / 2, d / 2], {...g, courtyard: .25}, {silk: false, assembly: false});
      ctx.fp.shapes.push(...silkPoly(ctx.fp, shape === "round" ? arc(0, 0, d / 2 + SILK_GAP + SILK_W / 2 + .02, 0, 360) : box(-d / 2 - .31, -d / 2 - .31, d / 2 + .31, d / 2 + .31), true, .1));
      ctx.fp.height = .035;
      return {name: "TESTPAD" + (shape === "round" ? "R" : "S") + n2(d) + lv(ctx), prefix: "TP", ipc: {land: d, sources: ["Waffle test pad (no IPC-7351B family)"]}};
    }}));

  // ---- castellated modules: host-board lands under the module's half-holes (IPC-7351B LCC goals).
  // halfHoles = true builds the module's own edge instead: plated holes centred on the board edge.
  const MOD = (W, Lm, sides, per, pitch, padW, padL, H) => ({W: PM(W, .2), L: PM(Lm, .2), sides, per, pitch, padW: R(r6(padW - .1), r6(padW + .1)), padL: R(r6(padL - .2), r6(padL + .2)), H, halfHoles: false, hole: .6,
    source: "Castellated module (half-hole) layout", flag: EXAMPLE});
  add(fam("castellated", "Castellated modules (edge half-holes)", "SMD", {
    "Module 18×25.5, 1.27, 3 sides (14+10+14)": MOD(18, 25.5, 3, [14, 10, 14], 1.27, .9, 1.5, 3.2),
    "Module 16×16, 1.27, 4 sides (11 per side)": MOD(16, 16, 4, [11, 11, 11, 11], 1.27, .9, 1.5, 2.8),
    "Module 21×51, 2.54, 2 sides (20 per side)": MOD(21, 51, 2, [20, 20], 2.54, 1.6, 2.2, 3.9),
    "Module 15×20, 1.5, 3 sides (11+8+11)": MOD(15, 20, 3, [11, 8, 11], 1.5, 1, 1.6, 2.5)
  }, {keywords: "castellated module half hole stamp edge wifi radio",
    fields: [tolField("W", "Module width"), tolField("L", "Module length"), ["sides", "Sides with pads", [["2", "2 (left, right)"], ["3", "3 (left, bottom, right)"], ["4", "4"]]],
      ["per", "Pads per side (comma separated, from the left side, CCW)", "text"], numField("pitch", "Pitch"), tolField("padW", "Castellation width"), tolField("padL", "Castellation length"),
      ["halfHoles", "Build", [["false", "Host land pattern"], ["true", "Module edge (plated half-holes)"]]], numField("hole", "Half-hole drill"), tolField("H", "Height")],
    generate(spec, ctx) {
      const g = goal("lcc", lv(ctx)); push(ctx, g.flagged, spec.flag);
      const sides = spec.sides | 0 || 2, per = (Array.isArray(spec.per) ? spec.per : String(spec.per).split(/[,\s]+/)).map(v => v | 0), p = spec.pitch;
      if (per.length < sides || per.slice(0, sides).some(v => v < 1)) throw Error("Enter the pads on each side.");
      const Wm = tol(spec.W, "module width"), Lm = tol(spec.L, "module length");
      const rx = lands({L: spec.W, W: spec.padW, T: spec.padL}, g, ctx.opts), ry = lands({L: spec.L, W: spec.padW, T: spec.padL}, g, ctx.opts);
      clampWidth(rx, p, spec, ctx.flagged); clampWidth(ry, p, spec, []);
      const lr = Math.max(per[0], per[sides >= 3 ? 2 : 1]), tb = sides >= 3 ? Math.max(per[1], sides === 4 ? per[3] : 0) : 0;
      if (tb) { cornerFix(rx, (tb - 1) / 2 * p, ry.X, ctx); cornerFix(ry, (lr - 1) / 2 * p, rx.X, ctx); }
      const half = spec.halfHoles === true || spec.halfHoles === "true", hole = +spec.hole || .6;
      const order = [["L", per[0]], ...(sides >= 3 ? [["B", per[1]]] : []), ["R", per[sides >= 3 ? 2 : 1]], ...(sides === 4 ? [["T", per[3]]] : [])];
      let n = 1;
      for (const [side, count] of order) for (let k = 0; k < count; k++) {
        const i = side === "R" || side === "T" ? count - 1 - k : k, off = (i - (count - 1) / 2) * p;
        if (half) {
          const t = tol(spec.padL).nom, w = tol(spec.padW).nom, ex = Wm.nom / 2, ey = Lm.nom / 2;
          const at = side === "L" ? [-ex, off, t, w] : side === "R" ? [ex, off, t, w] : side === "B" ? [off, ey, w, t] : [off, -ey, w, t];
          ctx.fp.pads.push({...thPad(n++, at[0], at[1], at[2], hole, "rect", at[3]), castellated: true});
        } else if (side === "L" || side === "R") ctx.fp.pads.push(pad(n++, (side === "L" ? -1 : 1) * rx.padCentre, off, rx.padLength, rx.X, ctx.shape));
        else ctx.fp.pads.push(pad(n++, off, (side === "T" ? -1 : 1) * ry.padCentre, ry.X, ry.padLength, ctx.shape));
      }
      dressing(ctx.fp, [-Wm.max / 2, -Lm.max / 2, Wm.max / 2, Lm.max / 2], g, {silkBody: [-Wm.nom / 2, -Lm.nom / 2, Wm.nom / 2, Lm.nom / 2], pin1: pin1Dot(ctx.fp.pads[0])});
      if (half) ctx.ipc.halfHoles = {drill: hole, note: "Castellated (half-hole) plating is a fab option: JLCPCB needs ≥ 0.5 mm holes and ≥ 1 mm hole-to-edge on the module."};
      return {name: (half ? "MODCAST" : "MODLAND") + n2(p) + "P" + n2(Wm.nom) + "X" + n2(Lm.nom) + "X" + heightCode(ctx.height ?? 3) + "-" + (n - 1) + lv(ctx), prefix: "U", ipc: {...rx, goal: g, sources: srcOf(spec)}};
    }}));

  return families.concat(thtFamilies(), mechFamilies());

  // ================================================================== THT
  function thtFamilies() {
    const out = [], A = f => out.push(f);
    const PREFIX = {RES: "R", DIO: "D", CAP: "C", IND: "L", FUS: "F", LED: "D"};

    // ---- axial: lying (pads at ±pitch/2) or standing (body over pin 1). DIN 44 052 body codes; JEDEC DO-35/41/15/201AD.
    const AX = (kind, L, D, lead, pitch, src, mount = "horizontal") => ({kind, L, D, lead, pitch, mount, padShape: "round", source: src, flag: RECALLED});
    A(fam("axial", "Axial (resistor, diode, at pitch)", "THT", {
      "DIN0204 P7.62": AX("RES", 3.6, 1.6, R(.4, .5), 7.62, "DIN 0204 resistor body"), "DIN0207 P10.16": AX("RES", 6.3, 2.5, R(.55, .65), 10.16, "DIN 0207 resistor body"),
      "DIN0309 P12.70": AX("RES", 9, 3.2, R(.55, .65), 12.7, "DIN 0309 resistor body"), "DIN0411 P15.24": AX("RES", 9.9, 3.6, R(.75, .85), 15.24, "DIN 0411 resistor body"),
      "DIN0414 P15.24": AX("RES", 11.9, 4.5, R(.75, .85), 15.24, "DIN 0414 resistor body"), "DIN0617 P20.32": AX("RES", 17, 6, R(.75, .85), 20.32, "DIN 0617 resistor body"),
      "DIN0207 standing P2.54": AX("RES", 6.3, 2.5, R(.55, .65), 2.54, "DIN 0207 resistor body", "vertical"), "DIN0207 standing P5.08": AX("RES", 6.3, 2.5, R(.55, .65), 5.08, "DIN 0207 resistor body", "vertical"),
      "DO-35 P7.62": AX("DIO", 4, 2, R(.46, .56), 7.62, "JEDEC DO-204AH (DO-35)"), "DO-41 P10.16": AX("DIO", 5.2, 2.7, R(.71, .86), 10.16, "JEDEC DO-204AL (DO-41)"),
      "DO-15 P12.70": AX("DIO", 7.6, 3.6, R(.69, .88), 12.7, "JEDEC DO-204AC (DO-15)"), "DO-201AD P15.24": AX("DIO", 9.5, 5.3, R(1.2, 1.3), 15.24, "JEDEC DO-201AD"),
      "DO-41 standing P5.08": AX("DIO", 5.2, 2.7, R(.71, .86), 5.08, "JEDEC DO-204AL (DO-41)", "vertical")
    }, {preset: "DIN0207 P10.16", keywords: "axial resistor diode din0207 do-35 do-41 do-15 do-201 through-hole lying standing",
      fields: [["kind", "Component", [["RES", "Resistor (RESAD)"], ["DIO", "Diode (DIOAD)"], ["CAP", "Capacitor (CAPAD)"], ["IND", "Inductor (INDAD)"], ["FUS", "Fuse (FUSAD)"]]],
        ["mount", "Mounting", [["horizontal", "Lying"], ["vertical", "Standing"]]], numField("pitch", "Lead pitch"), numField("L", "Body length"), numField("D", "Body diameter"), tolField("lead", "Lead diameter")],
      generate(spec, ctx) {
        push(ctx, spec.flag);
        const k = PREFIX[spec.kind] ? spec.kind : "RES", polar = k === "DIO", p = +spec.pitch, Lb = +spec.L, D = +spec.D, stand = spec.mount === "vertical";
        if (!(p > 0 && Lb > 0 && D > 0)) throw Error("Enter the pitch and the body size.");
        if (!stand && p < Lb + .5) throw Error("A lying body needs a pitch longer than the body.");
        const t = thtPins(spec, ctx, [{n: 1, x: -p / 2, y: 0}, {n: 2, x: p / 2, y: 0}], {pin1Square: polar});
        const fp = ctx.fp;
        if (stand) {
          dressing(fp, [-p / 2 - D / 2, -D / 2, -p / 2 + D / 2, D / 2], t.g, {silk: false, assembly: false});
          fp.shapes.push(asmCircle(-p / 2, 0, D / 2), ...silkPoly(fp, arc(-p / 2, 0, Math.max(D / 2, t.land / 2 + SILK_GAP) + SILK_W / 2 + .05, 0, 360), true), ...silkPoly(fp, [[-p / 2 + D / 2, 0], [p / 2, 0]]));
          fp.height = r6(Lb + 2);
        } else {
          dressing(fp, [-Lb / 2, -D / 2, Lb / 2, D / 2], t.g, {chamfer: false, silk: false});
          fp.shapes.push(...silkPoly(fp, box(-Lb / 2 - .09, -D / 2 - .09, Lb / 2 + .09, D / 2 + .09), true), ...silkPoly(fp, [[-p / 2, 0], [-Lb / 2 - .09, 0]]), ...silkPoly(fp, [[Lb / 2 + .09, 0], [p / 2, 0]]));
          if (polar) { const x = -Lb / 2 + Lb * .18; fp.shapes.push(...silkPoly(fp, [[x, -D / 2], [x, D / 2]]), asmPath([[x, -D / 2], [x, D / 2]], false)); }
          fp.height = r6(D);
        }
        return {name: k + "A" + (stand ? "V" : "D") + n2(p) + "W" + n2(tol(spec.lead).nom) + "L" + n2(Lb) + "D" + n2(D) + lv(ctx), prefix: PREFIX[k], ipc: {goal: t.g, sources: srcOf(spec)}};
      }}));

    // ---- radial: polarised can (CAPPRD), ceramic disc (CAPRD), film box (CAPRR), round LED (LEDRD).
    const RD = (type, D, pitch, lead, H, o = {}) => ({type, D, T: o.T ?? D, L: o.L ?? D, pitch, lead, H: R(r6(H * .95), H), padShape: "round", source: o.source, flag: o.flag ?? RECALLED});
    A(fam("radial", "Radial (electrolytic, disc, box capacitor, LED)", "THT", {
      "Can D5 P2.0": RD("can", 5, 2, R(.45, .55), 11, {source: "Radial aluminium electrolytic, 5 mm can"}), "Can D6.3 P2.5": RD("can", 6.3, 2.5, R(.45, .55), 11, {source: "Radial aluminium electrolytic, 6.3 mm can"}),
      "Can D8 P3.5": RD("can", 8, 3.5, R(.55, .65), 11.5, {source: "Radial aluminium electrolytic, 8 mm can"}), "Can D10 P5.0": RD("can", 10, 5, R(.55, .65), 16, {source: "Radial aluminium electrolytic, 10 mm can"}),
      "Can D12.5 P5.0": RD("can", 12.5, 5, R(.55, .65), 20, {source: "Radial aluminium electrolytic, 12.5 mm can"}), "Can D16 P7.5": RD("can", 16, 7.5, R(.75, .85), 25, {source: "Radial aluminium electrolytic, 16 mm can"}),
      "Can D18 P7.5": RD("can", 18, 7.5, R(.75, .85), 35.5, {source: "Radial aluminium electrolytic, 18 mm can"}),
      "Disc D5 P2.5": RD("disc", 5, 2.5, R(.45, .55), 7, {T: 2.5, source: "Ceramic disc capacitor, 5 mm"}), "Disc D5 P5.0": RD("disc", 5, 5, R(.45, .55), 7, {T: 2.5, source: "Ceramic disc capacitor, 5 mm"}),
      "Disc D7.5 P5.0": RD("disc", 7.5, 5, R(.55, .65), 10, {T: 3, source: "Ceramic disc capacitor, 7.5 mm"}),
      "Box 7.2×2.5 P5.0": RD("box", 2.5, 5, R(.45, .55), 6.5, {L: 7.2, T: 2.5, source: "WIMA MKS2 5 mm pitch box"}), "Box 7.2×3.5 P5.0": RD("box", 3.5, 5, R(.45, .55), 8.5, {L: 7.2, T: 3.5, source: "WIMA MKS2 5 mm pitch box"}),
      "Box 13×4 P10": RD("box", 4, 10, R(.55, .65), 9.5, {L: 13, T: 4, source: "WIMA MKS4 10 mm pitch box"}), "Box 18×5 P15": RD("box", 5, 15, R(.75, .85), 11, {L: 18, T: 5, source: "WIMA MKS4 15 mm pitch box"}),
      "Box 26.5×6 P22.5": RD("box", 6, 22.5, R(.75, .85), 15.5, {L: 26.5, T: 6, source: "WIMA MKS4 22.5 mm pitch box"}),
      "LED 3 mm P2.54": RD("led", 3.8, 2.54, R(.45, .55), 5.3, {source: "T-1 (3 mm) LED, 3.8 mm flange"}), "LED 5 mm P2.54": RD("led", 5.8, 2.54, R(.45, .55), 8.6, {source: "T-1¾ (5 mm) LED, 5.8 mm flange"})
    }, {preset: "Can D6.3 P2.5", keywords: "radial electrolytic capacitor can disc ceramic film box mkp mks led through-hole",
      fields: [["type", "Body", [["can", "Polarised can (CAPPRD)"], ["disc", "Disc (CAPRD)"], ["box", "Box (CAPRR)"], ["led", "Round LED (LEDRD)"]]], numField("pitch", "Lead pitch"), numField("D", "Diameter / box thickness"),
        numField("L", "Box length"), numField("T", "Disc thickness"), tolField("lead", "Lead diameter"), tolField("H", "Height")],
      generate(spec, ctx) {
        push(ctx, spec.flag);
        const type = ["can", "disc", "box", "led"].includes(spec.type) ? spec.type : "can", p = +spec.pitch, D = +spec.D, round = type === "can" || type === "led";
        const polar = type === "can" || type === "led", fp = ctx.fp;
        const t = thtPins(spec, ctx, [{n: 1, x: -p / 2, y: 0}, {n: 2, x: p / 2, y: 0}], {pin1Square: polar});
        const bx = round ? D / 2 : Math.max(+spec.L || D, p) / 2, by = round ? D / 2 : type === "disc" ? (+spec.T || D) / 2 : D / 2;
        dressing(fp, [-bx, -by, bx, by], t.g, {silk: false, assembly: false, chamfer: false});
        const e = SILK_W / 2 + .05;
        if (round) {
          const r = bx + e;
          if (type === "led") { const a = 180 - 30; fp.shapes.push(...silkPoly(fp, arc(0, 0, r, -a, a)), ...silkPoly(fp, [[r * Math.cos(a * Math.PI / 180), -r * .5], [r * Math.cos(a * Math.PI / 180), r * .5]])); }
          else fp.shapes.push(...silkPoly(fp, arc(0, 0, r, 0, 360), true));
          fp.shapes.push(asmCircle(0, 0, bx));
          if (type === "can") { const x = -bx * .55, y = -by * .55; fp.shapes.push(...silkPoly(fp, [[x - .5, y], [x + .5, y]]), ...silkPoly(fp, [[x, y - .5], [x, y + .5]])); }
        } else {
          fp.shapes.push(...silkPoly(fp, box(-bx - e, -by - e, bx + e, by + e), true), asmPath(box(-bx, -by, bx, by)));
        }
        if (polar) fp.shapes.push(dot(-p / 2 - t.land / 2 - .35, -t.land / 2 - .2));
        const code = {can: "CAPPRD", disc: "CAPRD", box: "CAPRR", led: "LEDRD"}[type], lead = n2(tol(spec.lead).nom);
        const dims = type === "box" ? "L" + n2(+spec.L) + "T" + n2(D) : "D" + n2(D) + (type === "disc" ? "T" + n2(+spec.T) : "");
        return {name: code + n2(p) + "W" + lead + dims + "H" + heightCode(ctx.height ?? 10) + lv(ctx), prefix: type === "led" ? "D" : "C", ipc: {goal: t.g, sources: srcOf(spec)}};
      }}));

    // ---- TO-92: three leads in line (1.27) or formed (2.54), flat face to +y.
    A(fam("to92", "TO-92 (inline and formed leads)", "THT", {
      "TO-92 inline 1.27": {pins: 3, pitch: 1.27, lead: R(.36, .53), D: 4.8, T: 3.6, H: R(4.32, 5.33), padShape: "round", source: "JEDEC TO-226AA (TO-92)", flag: "Rectangular leads are taken by their larger side. " + RECALLED},
      "TO-92 formed 2.54": {pins: 3, pitch: 2.54, lead: R(.36, .53), D: 4.8, T: 3.6, H: R(4.32, 5.33), padShape: "round", source: "JEDEC TO-226AA (TO-92), leads formed to 2.54 mm", flag: RECALLED},
      "TO-92-2 1.27": {pins: 2, pitch: 2.54, lead: R(.36, .53), D: 4.8, T: 3.6, H: R(4.32, 5.33), padShape: "round", source: "TO-92 two-lead (outer leads)", flag: RECALLED}
    }, {keywords: "to92 to-92 transistor regulator through-hole small signal",
      fields: [["pins", "Leads", [["2", "2"], ["3", "3"]]], numField("pitch", "Pitch"), tolField("lead", "Lead size"), numField("D", "Body diameter"), numField("T", "Body thickness (flat to back)"), tolField("H", "Height")],
      generate(spec, ctx) {
        push(ctx, spec.flag);
        const n = (spec.pins | 0) === 2 ? 2 : 3, p = +spec.pitch, R0 = +spec.D / 2, flat = r6(+spec.T - R0), fp = ctx.fp;
        const list = n === 2 ? [{n: 1, x: -p / 2, y: 0}, {n: 2, x: p / 2, y: 0}] : [{n: 1, x: -p, y: 0}, {n: 2, x: 0, y: 0}, {n: 3, x: p, y: 0}];
        const t = thtPins(spec, ctx, list);
        dressing(fp, [-R0, -R0, R0, flat], t.g, {silk: false, assembly: false});
        const a = Math.asin(Math.min(1, flat / R0)) * 180 / Math.PI, r = R0 + SILK_W / 2 + .05;
        fp.shapes.push(...silkPoly(fp, arc(0, 0, r, 180 - a, 360 + a)), ...silkPoly(fp, [[-r * Math.cos(a * Math.PI / 180), flat + .14], [r * Math.cos(a * Math.PI / 180), flat + .14]]));
        fp.shapes.push(asmPath([...arc(0, 0, R0, 180 - a, 360 + a, 24)]));
        return {name: "TO92" + n2(p) + "P" + n2(+spec.D) + "X" + n2(+spec.T) + "X" + heightCode(ctx.height ?? 5.3) + "-" + n + lv(ctx), prefix: "Q", ipc: {goal: t.g, sources: srcOf(spec)}};
      }}));

    // ---- TO-220 / TO-247 / TO-126: standing (vertical) or laid on the board (horizontal, mounting hole).
    // body: W wide, front (lead row to front face) and back (lead row to the back of the tab); laid:
    // body length Lb from the bend, mounting hole at holeY from the lead-side edge of the body.
    const TO = (pins, pitch, lead, leadT, W, front, back, tabT, Lb, holeY, hole, H, src, mount = "vertical") => ({pins, pitch, lead, leadT, W, front, back, tabT, Lb, holeY, hole, H, mount, bend: 3, padShape: "oval", source: src,
      flag: "Body position relative to the lead row and the hole position are typical values. " + RECALLED});
    const T220 = (n, p, mount) => TO(n, p, R(.69, .93), R(.36, .61), 10.16, 1.8, 2.8, 1.3, 15.3, 12.5, 3.5, mount === "vertical" ? 19 : 4.6, "JEDEC TO-220AB", mount);
    A(fam("to220", "TO-220 / TO-247 / TO-126 (vertical, horizontal)", "THT", {
      "TO-220-3 vertical": T220(3, 2.54, "vertical"), "TO-220-3 horizontal": T220(3, 2.54, "horizontal"), "TO-220-2 vertical": T220(2, 5.08, "vertical"),
      "TO-220-5 vertical": {...T220(5, 1.7, "vertical"), lead: R(.7, .9), leadT: R(.4, .55)}, "TO-220-5 horizontal": {...T220(5, 1.7, "horizontal"), lead: R(.7, .9), leadT: R(.4, .55)},
      "TO-247-3 vertical": TO(3, 5.45, R(1, 1.4), R(.4, .8), 15.9, 2, 3, 0, 20.5, 15, 3.6, 24, "JEDEC TO-247AD"),
      "TO-247-3 horizontal": TO(3, 5.45, R(1, 1.4), R(.4, .8), 15.9, 2, 3, 0, 20.5, 15, 3.6, 5, "JEDEC TO-247AD", "horizontal"),
      "TO-126 vertical": TO(3, 2.29, R(.5, .88), R(.45, .6), 7.8, 1.2, 1.6, 0, 11, 7.8, 3.2, 13, "JEDEC TO-225AA (TO-126)"),
      "TO-126 horizontal": TO(3, 2.29, R(.5, .88), R(.45, .6), 7.8, 1.2, 1.6, 0, 11, 7.8, 3.2, 2.8, "JEDEC TO-225AA (TO-126)", "horizontal")
    }, {keywords: "to220 to-220 to247 to-247 to126 to-126 power transistor regulator heatsink vertical horizontal",
      fields: [intField("pins", "Leads"), numField("pitch", "Pitch"), tolField("lead", "Lead width"), tolField("leadT", "Lead thickness"), ["mount", "Mounting", [["vertical", "Standing"], ["horizontal", "Laid flat (tab down)"]]],
        numField("W", "Body width"), numField("front", "Lead row to front face"), numField("back", "Lead row to back (tab)"), numField("Lb", "Body length (laid)"), numField("holeY", "Hole from body edge (laid)"),
        numField("hole", "Mounting hole (laid)"), numField("bend", "Lead bend to body (laid)"), numField("H", "Height")],
      generate(spec, ctx) {
        push(ctx, spec.flag);
        const n = spec.pins | 0, p = +spec.pitch, W = +spec.W, fp = ctx.fp, laid = spec.mount === "horizontal";
        if (n < 2 || n > 9) throw Error("Enter 2 to 9 leads.");
        const list = []; for (let i = 0; i < n; i++) list.push({n: i + 1, x: (i - (n - 1) / 2) * (n === 2 ? p : p), y: 0});
        const t = thtPins(spec, ctx, list);
        const e = SILK_W / 2 + .05;
        let body;
        if (laid) {
          const y0 = -(+spec.bend || 3), y1 = y0 - +spec.Lb, hy = y0 - +spec.holeY;
          if (+spec.hole > 0) fp.pads.push(NPTH(0, hy, +spec.hole));
          body = [-W / 2, y1, W / 2, y0];
          for (const q of list) fp.shapes.push(...silkPoly(fp, [[q.x, y0 + .1], [q.x, -t.land / 2 - .1]], false, .3));
        } else body = [-W / 2, -+spec.back, W / 2, +spec.front];
        dressing(fp, body, t.g, {silk: false, chamfer: false});
        fp.shapes.push(...silkPoly(fp, box(body[0] - e, body[1] - e, body[2] + e, body[3] + e), true));
        if (!laid && +spec.tabT > 0) fp.shapes.push(...silkPoly(fp, [[body[0], body[1] + +spec.tabT], [body[2], body[1] + +spec.tabT]]));
        return {name: "TO" + n2(p) + "P" + n2(W) + "X" + n2(laid ? +spec.Lb : +spec.front + +spec.back) + "X" + heightCode(ctx.height ?? 5) + "-" + n + (laid ? "H" : "V") + lv(ctx), prefix: "Q", ipc: {goal: t.g, sources: srcOf(spec)}};
      }}));

    // ---- metal cans: leads on a pitch circle (TO-18, TO-39/TO-5, TO-5 8-lead) and TO-3 (two pins, flange holes).
    // Pins counter-clockwise (top view) from the tab, which sits at 225° (upper left).
    const CANP = (pins, pcd, lead, D, H, step, src, o = {}) => ({pins, pcd, lead, D, H, step, padShape: "round", ...o, source: src, flag: o.flag || RECALLED});
    A(fam("tocan", "Metal can: TO-18, TO-39 / TO-5, TO-3", "THT", {
      "TO-18 (3 leads)": CANP(3, 2.54, R(.41, .53), 5.84, R(4.32, 5.33), 90, "JEDEC TO-206AA (TO-18)"),
      "TO-39 (3 leads)": CANP(3, 5.08, R(.41, .53), 9.4, R(6.1, 6.6), 90, "JEDEC TO-205AD (TO-39)"),
      "TO-5 (8 leads)": CANP(8, 5.08, R(.41, .53), 9.4, R(4.19, 4.7), 45, "JEDEC TO-99 (TO-5 8-lead)"),
      "TO-5 (10 leads)": CANP(10, 5.84, R(.41, .53), 9.4, R(4.19, 4.7), 36, "JEDEC TO-100 (TO-5 10-lead)"),
      "TO-3 (2 pins)": CANP(2, 10.92, R(.97, 1.09), 22.2, R(7, 8), 180, "JEDEC TO-204AA (TO-3)", {holes: 30.15, hole: 4.1, flange: [39.4, 26.7], flag: "Pin and hole positions are typical: check the drawing. " + RECALLED})
    }, {preset: "TO-18 (3 leads)", keywords: "to18 to39 to5 to3 to-99 metal can header transistor op-amp",
      fields: [intField("pins", "Leads"), numField("pcd", "Pitch circle diameter"), numField("step", "Angle between leads (°)"), tolField("lead", "Lead diameter"), numField("D", "Can diameter"), tolField("H", "Height"),
        numField("holes", "Mounting hole spacing (TO-3)"), numField("hole", "Mounting hole drill")],
      generate(spec, ctx) {
        push(ctx, spec.flag);
        const n = spec.pins | 0, rr = +spec.pcd / 2, step = +spec.step || 360 / n, fp = ctx.fp, D = +spec.D;
        if (n < 2 || n > 16) throw Error("Enter 2 to 16 leads.");
        const list = [];
        for (let i = 0; i < n; i++) {
          const a = (n === 2 ? 180 - i * 180 : 225 - step / 2 - i * step) * Math.PI / 180;
          list.push({n: i + 1, x: r6(rr * Math.cos(a)), y: r6(rr * Math.sin(a))});
        }
        const t = thtPins(spec, ctx, list);
        if (+spec.holes > 0) for (const s of [-1, 1]) fp.pads.push(NPTH(s * +spec.holes / 2, 0, +spec.hole || 4));
        const fx = spec.flange ? spec.flange[0] / 2 : D / 2, fy = spec.flange ? spec.flange[1] / 2 : D / 2;
        dressing(fp, [-fx, -fy, fx, fy], t.g, {silk: false, assembly: false});
        const r = D / 2 + SILK_W / 2 + .05;
        fp.shapes.push(...silkPoly(fp, arc(0, 0, r, 0, 360), true), asmCircle(0, 0, D / 2));
        if (spec.flange) fp.shapes.push(...silkPoly(fp, [[-fx, 0], [0, -fy], [fx, 0], [0, fy]], true));
        else { const a = 225 * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); fp.shapes.push(...silkPoly(fp, [[r * c, r * s], [(r + .8) * c, (r + .8) * s]])); }
        return {name: "TO" + (n === 2 ? "3" : "CAN") + n2(+spec.pcd) + "D" + n2(D) + "H" + heightCode(ctx.height ?? 5) + "-" + n + lv(ctx), prefix: "Q", ipc: {goal: t.g, sources: srcOf(spec)}};
      }}));

    // ---- SIP: single in-line, 2.54 mm.
    const SIPP = n => ({pins: n, pitch: 2.54, lead: R(.4, .56), T: 3, H: 8, padShape: "oval", source: "Single in-line package (resistor network / module)", flag: RECALLED});
    A(fam("sip", "SIP (single in-line)", "THT", {"SIP-4": SIPP(4), "SIP-6": SIPP(6), "SIP-8": SIPP(8), "SIP-9": SIPP(9), "SIP-10": SIPP(10), "SIP-12": SIPP(12)},
      {preset: "SIP-8", keywords: "sip single inline resistor network bussed",
        fields: [intField("pins", "Pins"), numField("pitch", "Pitch"), tolField("lead", "Lead size"), numField("T", "Body thickness"), numField("H", "Height")],
        generate(spec, ctx) {
          push(ctx, spec.flag);
          const n = spec.pins | 0, p = +spec.pitch, fp = ctx.fp;
          if (n < 2 || n > 64) throw Error("Enter 2 to 64 pins.");
          const list = []; for (let i = 0; i < n; i++) list.push({n: i + 1, x: (i - (n - 1) / 2) * p, y: 0});
          const t = thtPins(spec, ctx, list);
          const bx = n * p / 2, by = Math.max(+spec.T / 2, t.land * .725 + .3);
          dressing(fp, [-bx, -by, bx, by], t.g, {silk: false});
          fp.shapes.push(...silkPoly(fp, box(-bx - .14, -by - .14, bx + .14, by + .14), true), ...silkPoly(fp, [[-bx + p * .5, -by - .14], [-bx + p * .5, by + .14]]));
          return {name: "SIP" + n2(p) + "P" + n2(2 * bx) + "X" + n2(2 * by) + "X" + heightCode(ctx.height ?? 8) + "-" + n + lv(ctx), prefix: "U", ipc: {goal: t.g, sources: srcOf(spec)}};
        }}));

    // ---- PGA / SPGA: pin grid (JEDEC row letters), depopulation, staggered rows.
    A(fam("pga", "PGA / SPGA (pin grid array)", "THT", {
      "PGA-68 11×11 2.54 (2 rows)": {rows: 11, cols: 11, pitch: 2.54, lead: R(.43, .51), depop: "center:7", D: 28, H: 3.5, padShape: "round", source: "JEDEC MO-067 (PGA)", flag: RECALLED},
      "PGA-121 13×13 2.54 (3 rows)": {rows: 13, cols: 13, pitch: 2.54, lead: R(.43, .51), depop: "center:7", D: 34.5, H: 3.5, padShape: "round", source: "JEDEC MO-067 (PGA)", flag: RECALLED},
      "SPGA-145 15×15 staggered": {rows: 15, cols: 15, pitch: 2.54, rowPitch: 1.27, stagger: true, lead: R(.43, .51), depop: "", D: 25, H: 3, padShape: "round", source: "Staggered PGA grid", flag: EXAMPLE}
    }, {keywords: "pga spga pin grid array socket cpu",
      fields: [intField("rows", "Rows"), intField("cols", "Columns"), numField("pitch", "Pitch"), numField("rowPitch", "Row pitch (staggered)"), ["stagger", "Rows", [["false", "Aligned"], ["true", "Staggered"]]],
        tolField("lead", "Pin diameter"), ["depop", "Depopulate (A1, C3-C5, center:N)", "text"], numField("D", "Body size"), numField("H", "Height")],
      generate(spec, ctx) {
        push(ctx, spec.flag);
        const rows = spec.rows | 0, cols = spec.cols | 0, p = +spec.pitch, rp = +spec.rowPitch || p, st = spec.stagger === true || spec.stagger === "true", skip = depopulated(spec);
        if (!(rows > 0 && cols > 0 && rows * cols <= 2500)) throw Error("Enter up to 2500 pins.");
        const list = [];
        for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
          const id = rowName(r) + (c + 1);
          if (skip.has(id) || st && r % 2 && c === cols - 1) continue;
          list.push({n: id, x: r6((c - (cols - 1) / 2) * p + (st && r % 2 ? p / 2 : 0)), y: r6((r - (rows - 1) / 2) * (st ? rp : p))});
        }
        const t = thtPins(spec, ctx, list);
        const D = +spec.D / 2;
        dressing(ctx.fp, [-D, -D, D, D], t.g, {pin1: [-D - .45, -D - .45]});
        return {name: "PGA" + list.length + "P" + n2(p) + "_" + cols + "X" + rows + "_" + n2(2 * D) + "X" + heightCode(ctx.height ?? 3) + lv(ctx), prefix: "U", ipc: {goal: t.g, sources: srcOf(spec)}};
      }}));

    // ---- headers, sockets, box/IDC, JST-style, terminal blocks: the parametric connector generator (connector-gen.js).
    A(connectorFamily("connector", "Pin headers, sockets, IDC, wire-to-board, terminal blocks", "THT", {
      "Pin header 1×6 2.54": {type: "header", rows: 1, cols: 6, pitch: 2.54}, "Pin header 2×10 2.54": {type: "header", rows: 2, cols: 10, pitch: 2.54},
      "Pin header 2×5 1.27": {type: "header", rows: 2, cols: 5, pitch: 1.27}, "Pin header 1×6 2.54 right-angle": {type: "header", rows: 1, cols: 6, pitch: 2.54, orientation: "right-angle"},
      "Pin socket 1×8 2.54": {type: "socket", rows: 1, cols: 8, pitch: 2.54}, "IDC box header 2×5 2.54": {type: "box", rows: 2, cols: 5, pitch: 2.54},
      "IDC box header 2×20 2.54": {type: "box", rows: 2, cols: 20, pitch: 2.54}, "Wire-to-board 1×4 2.0": {type: "jst", rows: 1, cols: 4, pitch: 2},
      "Wire-to-board 1×4 1.0 SMD": {type: "jst", rows: 1, cols: 4, pitch: 1, mount: "smd", orientation: "right-angle"},
      "Terminal block 1×2 5.08": {type: "terminal", rows: 1, cols: 2, pitch: 5.08}, "Terminal block 1×3 3.5": {type: "terminal", rows: 1, cols: 3, pitch: 3.5}
    }, ["header", "socket", "box", "jst", "terminal"], "header socket idc box jst terminal block pin header connector wire-to-board"));

    // ---- crystals HC-49/U and HC-49/S.
    const HC = (H, src) => ({pitch: 4.88, lead: R(.38, .48), BL: 11.05, BW: 4.65, H: R(r6(H * .95), H), padShape: "round", source: src, flag: RECALLED});
    A(fam("xtaltht", "Crystals, through-hole (HC-49/U, HC-49/S)", "THT", {"HC-49/U": HC(13.46, "HC-49/U outline (IEC 60122-3)"), "HC-49/S": HC(3.6, "HC-49/S low-profile outline")},
      {keywords: "crystal hc49 hc-49 quartz through-hole",
        fields: [numField("pitch", "Lead pitch"), tolField("lead", "Lead diameter"), numField("BL", "Body length"), numField("BW", "Body width"), tolField("H", "Height")],
        generate(spec, ctx) {
          push(ctx, spec.flag);
          const p = +spec.pitch, l = +spec.BL / 2, w = +spec.BW / 2, fp = ctx.fp, c = l - w;
          const t = thtPins(spec, ctx, [{n: 1, x: -p / 2, y: 0}, {n: 2, x: p / 2, y: 0}], {pin1Square: false});
          dressing(fp, [-l, -w, l, w], t.g, {silk: false, assembly: false});
          const outline = (r) => [...arc(c, 0, r, -90, 90, 24), ...arc(-c, 0, r, 90, 270, 24)];
          fp.shapes.push(...silkPoly(fp, outline(w + SILK_W / 2 + .05), true), asmPath(outline(w)));
          return {name: "XTAL" + n2(p) + "W" + n2(tol(spec.lead).nom) + "L" + n2(2 * l) + "D" + n2(2 * w) + "H" + heightCode(ctx.height ?? 4) + lv(ctx), prefix: "Y", ipc: {goal: t.g, sources: srcOf(spec)}};
        }}));

    // ---- fuse holders: 5 × 20 mm cartridge holders and TR5 radial fuses.
    const FH = (pitch, lead, BL, BW, H, round, src) => ({pitch, lead, BL, BW, H: R(r6(H * .95), H), round, padShape: "round", source: src, flag: EXAMPLE});
    A(fam("fuseholder", "Fuse holders (5×20, TR5)", "THT", {
      "5×20 holder, 22.5 mm": FH(22.5, R(1, 1.2), 27, 8.5, 10, false, "5 × 20 mm PCB fuse holder, 22.5 mm pin pitch"),
      "5×20 holder, 22.6 mm": FH(22.6, R(1, 1.2), 28, 9, 10, false, "5 × 20 mm PCB fuse holder, 22.6 mm pin pitch"),
      "TR5 radial 5.08": FH(5.08, R(.55, .65), 8.4, 8.4, 7.7, true, "TR5 radial fuse (8.4 mm body, 5.08 mm pitch)")
    }, {keywords: "fuse holder 5x20 cartridge tr5 clip",
      fields: [numField("pitch", "Pin pitch"), tolField("lead", "Pin size"), numField("BL", "Body length"), numField("BW", "Body width"), tolField("H", "Height")],
      generate(spec, ctx) {
        push(ctx, spec.flag);
        const p = +spec.pitch, l = +spec.BL / 2, w = +spec.BW / 2, fp = ctx.fp, round = spec.round === true || spec.round === "true";
        const t = thtPins(spec, ctx, [{n: 1, x: -p / 2, y: 0}, {n: 2, x: p / 2, y: 0}], {pin1Square: false});
        dressing(fp, [-l, -w, l, w], t.g, {silk: false, assembly: !round ? undefined : false, chamfer: false});
        if (round) fp.shapes.push(...silkPoly(fp, arc(0, 0, l + SILK_W / 2 + .05, 0, 360), true), asmCircle(0, 0, l));
        else fp.shapes.push(...silkPoly(fp, box(-l - .14, -w - .14, l + .14, w + .14), true));
        return {name: "FUSH" + n2(p) + "W" + n2(tol(spec.lead).nom) + "L" + n2(2 * l) + "W" + n2(2 * w) + "H" + heightCode(ctx.height ?? 8) + lv(ctx), prefix: "F", ipc: {goal: t.g, sources: srcOf(spec)}};
      }}));

    // ---- relays, transformers and other parts by pin grid: "n x y; …" in mm.
    A(fam("pingrid", "Relays, transformers, any part by pin grid", "THT", {
      "Relay SPDT, 5 pins (cube)": {pins: "1 -6 0; 2 -4 -6; 3 -4 6; 4 8 -6; 5 8 6", lead: R(.9, 1.1), BL: 19, BW: 15.5, H: 15.5, padShape: "round", source: "Sugar-cube SPDT power relay pin pattern", flag: EXAMPLE},
      "Relay DPDT, 8 pins (signal)": {pins: "1 -3.81 -5.08; 2 -3.81 0; 3 -3.81 2.54; 4 -3.81 5.08; 5 3.81 5.08; 6 3.81 2.54; 7 3.81 0; 8 3.81 -5.08", lead: R(.4, .6), BL: 14, BW: 9.5, H: 10, padShape: "round", source: "DIP-style DPDT signal relay pin pattern", flag: EXAMPLE},
      "Transformer EE16, 2×5": {pins: "1 -6.25 -5; 2 -6.25 -2.5; 3 -6.25 0; 4 -6.25 2.5; 5 -6.25 5; 6 6.25 5; 7 6.25 2.5; 8 6.25 0; 9 6.25 -2.5; 10 6.25 -5", lead: R(.55, .65), BL: 17, BW: 16, H: 14, padShape: "round", source: "EE16 bobbin, two rows of five", flag: EXAMPLE},
      "Transformer EI30, 2×3": {pins: "1 -12.5 -5; 2 -12.5 0; 3 -12.5 5; 4 12.5 5; 5 12.5 0; 6 12.5 -5", lead: R(.75, .85), BL: 32, BW: 27, H: 23, padShape: "round", source: "EI30 PCB transformer, two rows of three", flag: EXAMPLE}
    }, {keywords: "relay transformer pin grid custom bobbin ee ei coil",
      fields: [["pins", "Pins (n x y; … in mm)", "text"], tolField("lead", "Lead size"), numField("BL", "Body length"), numField("BW", "Body width"), numField("H", "Height")],
      generate(spec, ctx) {
        push(ctx, spec.flag);
        const list = String(spec.pins || "").split(/[;\n]+/).map(s => s.trim()).filter(Boolean).map(s => {
          const [n, x, y] = s.split(/[\s,]+/);
          if (!n || !Number.isFinite(+x) || !Number.isFinite(+y)) throw Error("Each pin is: number x y (mm).");
          return {n, x: +x, y: +y};
        });
        if (!list.length || list.length > 400) throw Error("Enter 1 to 400 pins.");
        if (new Set(list.map(q => q.n)).size !== list.length) throw Error("Pin numbers must be unique.");
        const t = thtPins(spec, ctx, list);
        const l = +spec.BL / 2, w = +spec.BW / 2;
        dressing(ctx.fp, [-l, -w, l, w], t.g, {pin1: pin1Dot(ctx.fp.pads[0])});
        return {name: "PINGRID" + list.length + "_" + n2(2 * l) + "X" + n2(2 * w) + "X" + heightCode(ctx.height ?? 10) + lv(ctx), prefix: /relay/i.test(spec.preset || "") ? "K" : /transformer/i.test(spec.preset || "") ? "T" : "U", ipc: {goal: t.g, sources: srcOf(spec)}};
      }}));
    return out;
  }

  // Families built by connector-gen.js (generic parts). It loads with Place › Generic Part (the
  // dialog loads it on demand); headless callers load generic-parts.js and connector-gen.js.
  function connectorFamily(id, title, group, presets, types, keywords) {
    const keys = ["type", "pitch", "rows", "cols", "numbering", "gender", "orientation", "mount", "shrouded", "key", "pegs"];
    const bool = v => v === true || v === "true";
    return fam(id, title, group, presets, {keywords, needs: "AtriumGenericPartsUI", padShape: "round",
      fields: [["type", "Type", types.map(t => [t, {header: "Pin header", socket: "Pin socket", box: "Box header (IDC)", jst: "Wire-to-board", terminal: "Terminal block", cardedge: "Card edge fingers"}[t]])],
        numField("pitch", "Pitch"), intField("rows", "Rows"), intField("cols", "Pins per row"), ["numbering", "Numbering", [["odd-even", "Odd/even (1–2 across rows)"], ["row-by-row", "Row by row"], ["ccw", "Counter-clockwise (DIP)"], ["zigzag", "Zigzag (staggered)"]]],
        ["orientation", "Orientation", [["vertical", "Vertical"], ["right-angle", "Right-angle"]]], ["mount", "Mount", [["tht", "Through-hole"], ["smd", "SMD"]]], ["gender", "Gender", [["male", "Male"], ["female", "Female"]]],
        ["shrouded", "Shroud", [["false", "No"], ["true", "Yes"]]], ["key", "Key", [["false", "No"], ["true", "Yes"]]], ["pegs", "Pegs", [["false", "No"], ["true", "Yes"]]]],
      generate(spec, ctx) {
        const CG = globalThis.AtriumConnectorGen;
        if (!CG?.make || !globalThis.AtriumGenericParts) throw Error("The connector generator is still loading. Try again in a moment.");
        const s = {family: "connector", split: 0};
        for (const k of keys) if (spec[k] != null && spec[k] !== "") s[k] = ["shrouded", "key", "pegs"].includes(k) ? bool(spec[k]) : spec[k];
        const def = CG.make(CG.normalise(s)), f = def.footprint;
        ctx.fp.pads.push(...f.pads); ctx.fp.shapes.push(...f.shapes);
        ctx.fp.courtyard = f.courtyard;
        if (!ctx.height && f.height) ctx.fp.height = f.height;
        return {name: f.name, prefix: def.prefix, ipc: {sources: ["connector-gen.js (" + (f.ipc?.standard || "parametric connector") + ")"], hole: f.pads.find(p => p.drill > 0)?.drill ?? null}};
      }});
  }

  // ================================================================== mechanical
  function mechFamilies() {
    const out = [], A = f => out.push(f);
    // ---- mounting holes: ISO 273 medium clearance drill, pad = screw head / washer.
    // M6: 6.3 mm, the largest drill on the JLCPCB presets (ISO 273 fine is 6.4; larger holes are milled).
    const M = {M2: [2.2, 4], "M2.5": [2.7, 5], M3: [3.2, 6], M4: [4.3, 8], M5: [5.3, 10], M6: [6.3, 11]}, P = {};
    for (const [k, [d, pd]] of Object.entries(M)) {
      const o = {source: "ISO 273 fine clearance hole", ...(k === "M6" ? {flag: "6.3 mm drill instead of ISO 273's 6.4 mm, to stay within the 6.3 mm maximum drill of the JLCPCB presets."} : {})};
      P[k + " unplated"] = {drill: d, pad: pd, plated: false, vias: 0, ...o};
      P[k + " plated"] = {drill: d, pad: pd, plated: true, vias: 0, ...o};
      P[k + " plated, 8 vias"] = {drill: d, pad: pd, plated: true, vias: 8, viaDrill: .3, viaPad: .7, ...o};
    }
    A(fam("mounting", "Mounting holes (plated, unplated, via ring)", "Mechanical", P, {preset: "M3 plated", keywords: "mounting hole screw m2 m2.5 m3 m4 m5 m6 standoff npth via ring",
      fields: [numField("drill", "Hole"), numField("pad", "Pad / keep-out diameter"), ["plated", "Plating", [["true", "Plated (pad 1)"], ["false", "Unplated (NPTH)"]]], intField("vias", "Vias in the ring"),
        numField("viaDrill", "Via drill"), numField("viaPad", "Via land")],
      generate(spec, ctx) {
        const d = +spec.drill, pd = +spec.pad, plated = spec.plated === true || spec.plated === "true", fp = ctx.fp;
        push(ctx, spec.flag);
        if (!(d >= .5 && pd >= d)) throw Error("Enter a hole of 0.5 mm or more and a pad at least as large.");
        if (plated) {
          if (pd - d < 2 * K.RING_MIN - 1e-9) throw Error("The pad leaves less than a " + K.RING_MIN.toFixed(2) + " mm ring.");
          fp.pads.push(thPad(1, 0, 0, pd, d));
          const n = spec.vias | 0, vd = +spec.viaDrill || .3, vp = +spec.viaPad || r6(vd + 2 * K.RING_MIN), rr = (d / 2 + pd / 2) / 2;
          if (n > 0) {
            if (rr - vp / 2 < d / 2 + .05 || rr + vp / 2 > pd / 2 + 1e-9) throw Error("The vias do not fit in the ring: enlarge the pad or use a smaller via.");
            for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; fp.pads.push({...thPad(1, rr * Math.cos(a), rr * Math.sin(a), vp, vd), thermalVia: true}); }
          }
        } else fp.pads.push(NPTH(0, 0, d));
        dressing(fp, [-pd / 2, -pd / 2, pd / 2, pd / 2], {courtyard: .25}, {silk: false, assembly: false});
        fp.shapes.push(...silkPoly(fp, arc(0, 0, pd / 2 + SILK_GAP + SILK_W / 2 + .02, 0, 360, 64), true));
        return {name: (plated ? "MTGP" : "MTGNP") + n2(pd) + "H" + n2(d) + ((spec.vias | 0) && plated ? "V" + (spec.vias | 0) : ""), prefix: "H", ipc: {hole: d, land: pd, sources: srcOf(spec)}};
      }}));

    // ---- fiducials: copper dot, mask opening 2–3 × the dot, no paste, no silk.
    A(fam("fiducial", "Fiducials", "Mechanical", {
      "1.0 dot, 2.0 opening": {size: 1, mask: 2}, "1.0 dot, 3.0 opening": {size: 1, mask: 3}, "0.5 dot, 1.5 opening": {size: .5, mask: 1.5}, "1.5 dot, 3.0 opening": {size: 1.5, mask: 3}
    }, {keywords: "fiducial global local vision mark",
      fields: [numField("size", "Copper dot"), numField("mask", "Mask opening")],
      generate(spec, ctx) {
        const d = +spec.size, m = +spec.mask;
        if (!(d >= .3 && m >= d + .2)) throw Error("Enter a dot of 0.3 mm or more and an opening at least 0.2 mm larger.");
        ctx.fp.pads.push(pad(1, 0, 0, d, d, "round", {fiducial: true, noPaste: true, maskExpansion: r6((m - d) / 2), pasteExpansion: r6(-d / 2)}));
        dressing(ctx.fp, [-m / 2, -m / 2, m / 2, m / 2], {courtyard: .25}, {silk: false, assembly: false});
        return {name: "FID" + n2(d) + "M" + n2(m), prefix: "FID", ipc: {land: d, mask: m, sources: ["SMEMA fiducial guidelines (dot 1.0 mm, clear area 2–3 × the dot)"]}};
      }}));

    // ---- card-edge fingers (connector generator, type cardedge).
    A(connectorFamily("cardedge", "Edge-connector fingers (card edge)", "Mechanical", {
      "Card edge 2×10 1.27": {type: "cardedge", rows: 2, cols: 10, pitch: 1.27}, "Card edge 2×18 2.54": {type: "cardedge", rows: 2, cols: 18, pitch: 2.54},
      "Card edge 1×30 1.0": {type: "cardedge", rows: 1, cols: 30, pitch: 1}
    }, ["cardedge"], "card edge fingers gold edge connector pcie isa"));

    // ---- net ties: pads joined by copper (fp.netTie, netTieGroups) so two nets meet at one place.
    const NT = (n, s, gap) => ({pads: n, size: s, gap});
    A(fam("nettie", "Net ties", "Mechanical", {"2 pads, 0.5": NT(2, .5, .25), "2 pads, 1.0": NT(2, 1, .3), "2 pads, 2.0": NT(2, 2, .5), "3 pads, 0.5": NT(3, .5, .25), "4 pads, 0.5": NT(4, .5, .25)},
      {preset: "2 pads, 0.5", keywords: "net tie star ground split short",
        fields: [intField("pads", "Pads"), numField("size", "Pad size"), numField("gap", "Gap between pads")],
        generate(spec, ctx) {
          const n = spec.pads | 0, s = +spec.size, g = +spec.gap, fp = ctx.fp;
          if (n < 2 || n > 8 || !(s >= .2) || !(g >= .1)) throw Error("Enter 2 to 8 pads, 0.2 mm or larger, at least 0.1 mm apart.");
          for (let i = 0; i < n; i++) fp.pads.push(pad(i + 1, (i - (n - 1) / 2) * (s + g), 0, s, s, "rect", {noPaste: true, pasteExpansion: r6(-s / 2)}));
          const w = r6(Math.max(.15, Math.min(s * .5, .5)));
          fp.shapes.push({kind: "path", layer: "Top", width: w, points: [[fp.pads[0].x, 0], [fp.pads.at(-1).x, 0]]});
          fp.netTie = true; fp.netTieGroups = [fp.pads.map(p => p.number)];
          const x = (n - 1) / 2 * (s + g) + s / 2;
          dressing(fp, [-x, -s / 2, x, s / 2], {courtyard: .25}, {silk: false, assembly: false});
          return {name: "NETTIE" + n + "P" + n2(s) + "G" + n2(g), prefix: "NT", ipc: {sources: ["Waffle net tie"]}};
        }}));
    return out;
  }
};
if (globalThis.AtriumFootprintWizard?.install) AtriumFootprintWizard.install(globalThis.AtriumFootprintPackages);
