"use strict";
// Calculators (Tools → Calculators…, a dock panel in the right pane): track width for current,
// via current and resistance, controlled impedance, E-series values and combinations, regulator
// feedback dividers, RC/LC, unit conversion, track resistance, Ohm's law, power derating and
// attenuator pads. KiCad's PCB Calculator, driven by the active board's stack-up.
//
// The math (the first half of this file) is DOM-free and runs headlessly: MCP `calculate`
// {calculator, inputs} calls AtriumCalc.calculate(id, inputs, {doc, defs}). Every calculator
// returns its values, display rows, the formula it used, its assumptions and its sources.
//
//   AtriumCalc.list()                         -> [{id, title, group, inputs, formula, assumptions, sources}]
//   AtriumCalc.calculate(id, inputs, ctx?)    -> {ok, calculator, values, rows, formula, assumptions, sources, warnings, inputs}
//   AtriumCalc.eseries(name)                  -> [1.0, 1.1, ...] (one decade)
//   AtriumCalc.nearest(x, name)               -> {value, error}
//   AtriumCalc.open(ctx?) / toggle()          -> the panel (browser only)
//
// Units: lengths in mm, copper weight in oz/ft², temperatures in °C, currents in A, resistances
// in Ω, capacitance in F, inductance in H, frequency in Hz unless an input says otherwise.
globalThis.AtriumCalc = (() => {
  const PI = Math.PI, finite = Number.isFinite;
  const MIL = 0.0254;            // mm per mil
  const OZ_UM = 35;              // nominal 1 oz/ft² copper, µm (IPC-4562 nominal; matches AtriumStackup.OZ)
  const K_CU = 385;              // W/(m·K), copper thermal conductivity
  const fail = m => { throw Error(m); };

  if (!globalThis.AtriumPreferredValues && typeof require === "function") require("../notebook/preferred-values.js");
  if (!globalThis.AtriumElectricalMaterial && typeof require === "function") require("./electrical-material.js");
  const {eseries, nearest, range, SERIES} = globalThis.AtriumPreferredValues;
  const near2 = (x, name) => { const n = nearest(x, name).value, s = eseries(name), d = Math.floor(Math.log10(n)), m = Math.pow(10, d), k = s.findIndex(v => Math.abs(v * m - n) < 1e-9 * n);
    const up = k < 0 ? n : +(k + 1 < s.length ? s[k + 1] * m : 10 * m).toPrecision(3), dn = k < 0 ? n : +(k > 0 ? s[k - 1] * m : s.at(-1) * m / 10).toPrecision(3);
    return [n, up, dn]; };

  // ------------------------------------------------------------------ current capacity
  // Track width and via current come from AtriumIPC2152 (ipc2152.js, loaded with the calculators):
  // the IPC-2152 chart fits with their modifier clamping and warnings, the Brooks & Adam fit and
  // IPC-2221, the same numbers as the Current Capacity rule and check.
  const IPC = () => globalThis.AtriumIPC2152 || fail("The IPC-2152 module (ipc2152.js) is not loaded.");
  // Copper resistance (Ω) of a conductor of length L mm and cross-section A mm² at T °C.
  const rho = T => {
    const material = globalThis.AtriumElectricalMaterial;
    return material.rhoAt(T, material.RHO20 / 1e3) * 1e3; // retain the calculator's Ω·m intermediate
  };
  const resistance = (L, A, T) => rho(T) * L / A;

  // ------------------------------------------------------------------ board context
  function stack(ctx) {
    const S = globalThis.AtriumStackup, doc = ctx?.doc;
    if (!S || doc?.kind !== "pcb") return null;
    try { return {S, st: ctx.stack || S.get(doc, ctx.defs), doc, defs: ctx.defs}; } catch { return null; }
  }
  const copperKeys = ctx => { const b = stack(ctx); return b ? b.st.layers.filter(l => l.type === "Signal" || l.type === "Plane").map(l => l.key) : []; };

  // ------------------------------------------------------------------ calculators
  const num = (key, label, unit, def, o = {}) => ({key, label, unit, def, kind: "number", ...o});
  const pick = (key, label, options, def, o = {}) => ({key, label, options, def, kind: "choice", ...o});
  const COPPER = num("copper", "Copper weight", "oz", 1, {min: 0.25, max: 6, step: 0.5, help: "1 oz/ft² = 35 µm"});
  const CALCS = {};
  const calc = (id, spec) => { CALCS[id] = {id, ...spec}; };

  calc("track_width", {
    title: "Track width for current", group: "PCB",
    inputs: [num("current", "Current", "A", 2, {min: 0.01, max: 100}), num("rise", "Temperature rise", "°C", 10, {min: 1, max: 100}), COPPER,
      pick("layer", "Layer", [["external", "External (outer)"], ["internal", "Internal (inner)"]], "external"),
      num("board", "Board thickness", "mm", 1.6, {min: 0.2, max: 6, board: "thickness"}), num("plane", "Distance to plane (0 = none)", "mm", 0, {min: 0, max: 10}),
      num("conductivity", "Board thermal conductivity", "W/m·K", 0.2, {min: 0.1, max: 1.5}),
      num("length", "Track length", "mm", 25, {min: 0}), num("ambient", "Ambient", "°C", 25)],
    formula: ["Brooks & Adam (IPC-2152 data): ΔT = K·I^a·W^b·Th^c → W = (ΔT / (K·I^a·Th^c))^(1/b)   [W, Th mil]",
      "  external: K 215.3, a 2.0, b −1.15, c −1.0; internal by copper weight (½ oz K 120 … 3 oz K 262.5, c −1.52)",
      "IPC-2152 universal chart: A = (I / (0.0897·ΔT^0.394))^(1/(0.504·ΔT^0.0385)) × M_cu × M_board × M_plane × M_k   [mil²]",
      "IPC-2221: A = (I / (k·ΔT^0.44))^(1/0.725), k = 0.048 external, 0.024 internal   [mil²]",
      "W = A / t;  R = ρ₂₀·(1 + 0.00393·(T − 20))·L / (W·t), T = ambient + ΔT"],
    assumptions: ["Steady DC (or RMS) current, still air, one isolated track; nearby hot tracks or parts add heat.",
      "Brooks & Adam is the recommended width: their fits reproduce the IPC-2152 charts within about 10 %.",
      "The IPC-2152 chart method applies the board-thickness, plane and conductivity modifiers; plane distance 0 means no plane. The modifier fits cover ½–3 oz, a 0.72–2.36 mm board, a plane 0.144–2.40 mm away and k 0.18–0.34 W/m·K; inputs outside are clamped, with a warning.",
      "IPC-2221 (1956 NBS data) is shown for comparison only; it halves the current of inner layers, which IPC-2152 found unnecessary.",
      "Copper thickness is the nominal foil (1 oz = 35 µm) without plating; outer layers usually carry extra plating."],
    sources: ["IPC-2152 (2009), Standard for Determining Current Carrying Capacity in Printed Board Design.",
      "D. Brooks, J. Adam, “Trace Currents and Temperatures Revisited” (2015), Table 3-1; as used by KiCad’s calculator.",
      "G. Hunter, NinjaCalc “Track Current (IPC-2152)” chart fits (blog.mbedded.ninja).", "IPC-2221B §6.2, Figure 6-4."],
    run(v) {
      const C = IPC(), internal = v.layer === "internal", t = v.copper * OZ_UM / 1000, I = v.current, dT = v.rise;
      const o = {width: null, current: I, rise: dT, thickness: t, internal, board: v.board, plane: v.plane, k: v.conductivity};
      const ba = C.conductor({...o, method: "brooksAdam"}), u = C.conductor({...o, method: "ipc2152"}), m = u.modifiers;
      const wBA = ba.width, w2152 = u.width, w2221 = C.conductor({...o, method: "ipc2221"}).width;
      const T = v.ambient + dT, R = v.length > 0 ? resistance(v.length, wBA * t, T) : 0;
      const warnings = [...new Set([...ba.warnings, ...u.warnings])];
      return {values: {width: wBA, width_ipc2152: w2152, width_ipc2221: w2221, area: wBA * t, resistance: R, drop: R * I, power: R * I * I,
        modifiers: {copper: m.copper, board: m.board, plane: m.plane, conductivity: m.conductivity}},
      rows: [["Width (Brooks & Adam, IPC-2152)", wBA, "mm", true], ["", wBA / MIL, "mil"],
        ["Width (IPC-2152 chart + modifiers)", w2152, "mm"], ["  modifiers cu·board·plane·k", [m.copper, m.board, m.plane, m.conductivity].map(x => x.toFixed(3)).join(" · "), ""],
        ["Width (IPC-2221, comparison)", w2221, "mm"], ["Cross-section", wBA * t * 1e6, "µm²"],
        ["Resistance at " + T + " °C", R, "Ω"], ["Voltage drop", R * I, "V"], ["Power", R * I * I, "W"]], warnings};
    }
  });

  // Current capacity (ipc2152.js, loaded with the calculators): solve width, current or rise from the other two.
  calc("current_capacity", {
    title: "Current capacity (width ↔ current ↔ rise)", group: "PCB",
    inputs: [pick("solve", "Solve for", [["width", "Track width"], ["current", "Current"], ["rise", "Temperature rise"]], "current"),
      num("width", "Track width", "mm", 0.5, {min: 0.01, max: 100}), num("current", "Current", "A", 2, {min: 0.001, max: 100}), num("rise", "Temperature rise", "°C", 10, {min: 0.5, max: 100}),
      COPPER, pick("layer", "Layer", [["external", "External (outer)"], ["internal", "Internal (inner)"]], "external"),
      num("board", "Board thickness", "mm", 1.6, {min: 0.2, max: 6, board: "thickness"}), num("plane", "Distance to plane (0 = none)", "mm", 0, {min: 0, max: 10}),
      num("conductivity", "Board thermal conductivity", "W/m·K", 0.2, {min: 0.1, max: 1.5}),
      pick("method", "Method", [["ipc2152", "IPC-2152 chart + modifiers"], ["brooksAdam", "IPC-2152 (Brooks & Adam fit)"], ["ipc2221", "IPC-2221 (comparison)"]], "ipc2152")],
    formula: ["IPC-2152 universal chart: A = (I / (0.0897·ΔT^0.394))^(1/(0.504·ΔT^0.0385)) × M_cu(oz, I) × M_board × M_plane × M_k   [mil²]",
      "Brooks & Adam: ΔT = K·I^a·W^b·Th^c (external K 215.3, a 2, b −1.15, c −1); IPC-2221: I = k·ΔT^0.44·A^0.725",
      "W = A / t; the unknown is solved exactly (closed forms) or by bisection (chart with the current-dependent copper modifier)"],
    assumptions: ["One isolated conductor in still air with steady DC (or RMS) current; nearby heat adds to the rise (Tools › Thermal › Temperature Rise Map).",
      "The IPC-2152 chart is the conservative baseline for internal and external conductors; the modifier fits cover ½–3 oz, a 0.72–2.36 mm board, a plane 0.144–2.40 mm away and k 0.18–0.34 W/m·K, and inputs outside are clamped.",
      "IPC-2221 is the 1956 NBS data, shown for comparison."],
    sources: ["IPC-2152 (2009) Figure 5-1 and its modifier charts, as fitted by G. Hunter's NinjaCalc (blog.mbedded.ninja).",
      "D. Brooks, J. Adam, “Trace Currents and Temperatures Revisited” (2015), Table 3-1.", "IPC-2221B §6.2, Figure 6-4."],
    run(v) {
      const C = IPC();
      const o = {width: v.width, current: v.current, rise: v.rise, thickness: v.copper * OZ_UM / 1000, internal: v.layer === "internal", board: v.board, plane: v.plane, k: v.conductivity};
      o[v.solve] = null;
      const all = C.compare(o), r = all[v.method];
      if (!r || r.error) fail(r?.error || "No result.");
      const unit = {width: "mm", current: "A", rise: "°C"}, label = {width: "Track width", current: "Current", rise: "Temperature rise"};
      const rows = [[label[v.solve] + " (" + C.METHODS[r.method] + ")", r[v.solve], unit[v.solve], true]];
      for (const [m, x] of Object.entries(all)) if (m !== v.method && !x.error) rows.push(["  " + C.METHODS[m], x[v.solve], unit[v.solve]]);
      rows.push(["Cross-section", r.area * 1e6, "µm²"]);
      if (r.modifiers) rows.push(["  modifiers cu·board·plane·k", [r.modifiers.copper, r.modifiers.board, r.modifiers.plane, r.modifiers.conductivity].map(x => x.toFixed(3)).join(" · "), ""]);
      return {values: {width: r.width, current: r.current, rise: r.rise, area: r.area, method: r.method, modifiers: r.modifiers,
        compare: Object.fromEntries(Object.entries(all).map(([m, x]) => [m, x.error ? null : {width: x.width, current: x.current, rise: x.rise}]))}, rows, warnings: [...new Set(r.warnings)]};
    }
  });

  calc("via_current", {
    title: "Via current and resistance", group: "PCB",
    inputs: [num("drill", "Finished hole diameter", "mm", 0.3, {min: 0.05, max: 6}), num("plating", "Barrel plating", "µm", 25, {min: 5, max: 100}),
      num("length", "Barrel length", "mm", 1.6, {min: 0.05, max: 10, board: "span"}), num("rise", "Temperature rise", "°C", 10, {min: 1, max: 100}),
      num("current", "Current", "A", 1, {min: 0}), num("ambient", "Ambient", "°C", 25),
      pick("from", "From layer", [], "", {board: "layers"}), pick("to", "To layer", [], "", {board: "layers"})],
    formula: ["A = π·(d + t)·t   (plated barrel, d = finished hole, t = plating)", "I_max: the IPC-2152 universal chart for the barrel cross-section A, no modifiers (as the Current Capacity rule)",
      "IPC-2221 external (comparison): I = 0.048·ΔT^0.44·A^0.725   [A mil²]",
      "R = ρ(T)·L / A,  ρ₂₀ = 1.724·10⁻⁸ Ω·m, α = 0.00393 /°C", "R_θ = L / (k·A), k = 385 W/m·K"],
    assumptions: ["The barrel is treated as a conductor of its plated cross-section on the IPC-2152 baseline chart (IPC-2152's guidance; ipc2152.js via()); the pads and planes it joins sink heat, so this is conservative. KiCad and Saturn use IPC-2221 external, shown for comparison.",
      "Length is the plated span: the board thickness for a through via, or the stack-up distance between the two layers when they are given.",
      "Plating is uniform copper; real barrels thin towards the middle (IPC-6012 class 2 minimum average 20 µm)."],
    sources: ["IPC-2152 (2009) Figure 5-1 (current); IPC-2221B §6.2 (comparison); IPC-6012 Table 3-3 (plating).", "KiCad PCB Calculator, Via size panel."],
    run(v, ctx, given) {
      const warnings = [];
      let L = v.length;
      const b = stack(ctx);
      if (b && !given.has("length")) {
        const keys = copperKeys(ctx), from = v.from || keys[0], to = v.to || keys.at(-1);
        const a = b.S.layerInfo(b.doc, from, b.defs), c = b.S.layerInfo(b.doc, to, b.defs);
        if (a?.copper && c?.copper) { const [p, q] = a.z <= c.z ? [a, c] : [c, a]; L = Math.max(0.01, q.z + q.thickness - p.z); }
        else if (v.from || v.to) warnings.push("Unknown copper layer; the board thickness is used.");
        else L = b.S.thickness(b.doc, b.defs);
      }
      const C = IPC(), d = v.drill, t = v.plating / 1000, A = C.barrelArea(d, t);
      const Imax = C.via({drill: d, plating: t, rise: v.rise}).current, I2221 = C.via({drill: d, plating: t, rise: v.rise, method: "ipc2221"}).current;
      const T = v.ambient + v.rise, R = resistance(L, A, T), Rth = (L / 1000) / (K_CU * A * 1e-6);
      if (v.rise > C.RANGE.rise || Imax > C.RANGE.current) warnings.push("Outside the IPC-2152 test data (up to 30 A and 100 °C rise).");
      if (v.current > Imax) warnings.push("The current exceeds the via's capacity for this rise: use more vias.");
      return {values: {area: A, current_max: Imax, current_max_ipc2221: I2221, length: L, resistance: R, drop: R * v.current, power: R * v.current ** 2, thermal_resistance: Rth,
        vias_needed: v.current > 0 ? Math.ceil(v.current / Imax) : 0},
      rows: [["Max current (ΔT " + v.rise + " °C)", Imax, "A", true], ["  IPC-2221 external (comparison)", I2221, "A"], ["Barrel cross-section", A * 1e6, "µm²"], ["Barrel length", L, "mm"],
        ["Resistance at " + T + " °C", R, "Ω"], ["Voltage drop at " + v.current + " A", R * v.current, "V"], ["Power", R * v.current ** 2, "W"],
        ["Thermal resistance", Rth, "°C/W"], ["Vias for " + v.current + " A", v.current > 0 ? Math.ceil(v.current / Imax) : 0, ""]], warnings};
    }
  });

  calc("impedance", {
    title: "Controlled impedance", group: "PCB",
    inputs: [pick("structure", "Structure", [["microstrip", "Microstrip"], ["stripline", "Stripline"]], "microstrip"),
      pick("mode", "Line", [["single", "Single-ended"], ["differential", "Differential (edge-coupled)"]], "single"),
      pick("layer", "Board layer (prefill)", [], "", {board: "layers"}),
      num("width", "Track width", "mm", 0.2, {min: 0.01, max: 25}), num("gap", "Pair gap", "mm", 0.15, {min: 0.01, max: 25}),
      num("thickness", "Copper thickness", "mm", 0.035, {min: 0, max: 0.5, board: "stack"}), num("height", "Dielectric height (microstrip)", "mm", 0.2, {min: 0.01, board: "stack"}),
      num("h1", "Height above (stripline)", "mm", 0.2, {min: 0.01, board: "stack"}), num("h2", "Height below (stripline)", "mm", 0.2, {min: 0.01, board: "stack"}),
      num("er", "Dielectric constant Dk", "", 4.3, {min: 1, max: 20, board: "stack"}), num("mask", "Solder mask thickness (microstrip)", "mm", 0, {min: 0, max: 0.2, board: "stack"}),
      num("mask_er", "Solder mask Dk", "", 3.5, {min: 1, max: 10}), num("target", "Target impedance (0 = analyse)", "Ω", 0, {min: 0, max: 1000}),
      num("ground", "Coplanar ground gap (0 = none)", "mm", 0, {min: 0}), num("etch", "Etch factor", "%", 0, {min: 0, max: 100}),
      num("freq", "Loss frequency", "GHz", 1, {min: 0.001, max: 100})],
    formula: ["Microstrip: Hammerstad & Jensen (1980) with Kirschning–Jansen dispersion; coated by a filling-factor model",
      "Stripline: Cohn (1954) exact at t = 0, Wheeler (1978) for thick strips; offset stripline as two parallel halves",
      "Edge-coupled: Kirschning & Jansen (1984) microstrip; Cohn (1955) stripline with a 2D-solver calibration",
      "Z_diff = 2·Z_odd;  delay = 3.336 ps/mm · √ε_eff;  target width by bisection (AtriumImpedance.synthesize)"],
    assumptions: ["Quasi-TEM, smooth copper, rectangular cross-section unless an etch factor is supplied.",
      "Heights and Dk come from the active board's stack-up for the chosen layer unless typed in.",
      "Accuracy as stated in impedance.js: within about 1 % for the main models, 2–5 % for offset or coated lines."],
    sources: ["AtriumImpedance (app/impedance.js) and its references: Hammerstad & Jensen 1980, Cohn 1954/1955, Wheeler 1978, Kirschning & Jansen 1982/1984.",
      "Pozar, Microwave Engineering 4th ed., Examples 3.5 and 3.7 (checked in tests)."],
    run(v, ctx, given) {
      const I = globalThis.AtriumImpedance || fail("The impedance solver (impedance.js) is not loaded.");
      const warnings = [];
      let structure = v.structure, cover = v.mask > 0 ? {t: v.mask, er: v.mask_er} : null, h = v.height, h1 = v.h1, h2 = v.h2, er = v.er, t = v.thickness, from = null;
      const b = stack(ctx);
      if (b && (v.layer || !given.has("height") && !given.has("h1"))) {
        const key = v.layer || copperKeys(ctx)[0], g = I.geometry(b.st.layers, key);
        if (!g || g.structure === "none") warnings.push("No reference plane next to " + (key || "that layer") + "; typed values are used.");
        else {
          from = key;
          if (!given.has("structure")) structure = g.structure;
          if (!given.has("thickness")) t = g.t;
          if (!given.has("er")) er = g.er;
          if (g.structure === "microstrip") { if (!given.has("height")) h = g.h; if (!given.has("mask") && g.cover) cover = {t: g.cover.t, er: given.has("mask_er") ? v.mask_er : g.cover.er}; }
          else { if (!given.has("h1")) h1 = g.h1; if (!given.has("h2")) h2 = g.h2; }
        }
      }
      const diff = v.mode === "differential";
      const geom = structure === "stripline" ? {structure, w: v.width, t, h1, h2, er, freq: v.freq} : {structure, w: v.width, t, h, er, cover, freq: v.freq};
      if (diff) geom.s = v.gap;
      if (v.ground > 0) geom.g = v.ground;
      if (v.etch > 0) geom.etch = v.etch;
      const actual = v.target > 0 ? I.solve(geom) : null;
      let w = v.width, syn = null;
      if (v.target > 0) {
        syn = I.synthesize(geom, {target: v.target});
        if (syn.w > 0) w = syn.w;
        if (!syn.ok) warnings.push(syn.error);
      }
      const r = syn?.result || I.solve({...geom, w});
      if (!r.ok) fail(r.error || "The geometry is outside the model range.");
      warnings.push(...(r.warnings || []));
      const z = diff ? r.zdiff : r.z0;
      return {values: {impedance: z, z0: r.z0, zdiff: diff ? r.zdiff : null, zodd: diff ? r.zodd : null, zeven: diff ? r.zeven : null, eeff: r.eeff,
        delay: r.delay, loss: r.loss?.total, width: w, synthesized: !!syn?.ok, actual:actual?.ok ? actual.z : null, structure, h: structure === "microstrip" ? h : null, h1: structure === "stripline" ? h1 : null,
        h2: structure === "stripline" ? h2 : null, er, t, layer: from, model: r.model},
      rows: [[diff ? "Differential impedance" : "Impedance", z, "Ω", true], ...(actual?.ok ? [["At input width", actual.z, "Ω"]] : []), ...(syn?.ok ? [["Width for " + v.target + " Ω", w, "mm", true]] : []),
        ...(diff ? [["Odd / even mode", r.zodd.toFixed(2) + " / " + r.zeven.toFixed(2), "Ω"], ["Single-ended Z0", r.z0, "Ω"]] : []),
        ["Effective Dk", r.eeff, ""], ["Delay", r.delay, "ps/mm"], ["Loss at " + v.freq + " GHz", r.loss?.total, "dB/mm"], ["Model", r.model, ""],
        ...(from ? [["Stack-up layer", from + (structure === "microstrip" ? " · h " + h.toFixed(3) : " · h " + h1.toFixed(3) + " / " + h2.toFixed(3)) + " mm · Dk " + er.toFixed(2), ""]] : [])], warnings};
    }
  });

  calc("eseries", {
    title: "E-series values", group: "Components",
    inputs: [num("value", "Target value", "", 4700, {min: 1e-15}), pick("series", "Series", SERIES.map(s => [s, s]), "E24"),
      num("tolerance", "Match within", "%", 1, {min: 0.001, max: 50})],
    formula: ["E-n value = 10^(i/n) rounded to 2 (E6–E24) or 3 (E48–E192) figures; IEC 60063 tables for E3–E24, E192 uses 9.20",
      "Nearest: minimum |ln(value / target)|", "Series: R1 + R2;  parallel: R1·R2 / (R1 + R2); every R1 of the series is tried with the best R2"],
    assumptions: ["Values repeat every decade; the target can be in any unit (Ω, pF, nH …).", "Two-part combinations use the same series for both parts."],
    sources: ["IEC 60063:2015, Preferred number series for resistors and capacitors."],
    run(v) {
      const T = v.value, s = v.series, n = nearest(T, s), lo = T / 1000, cand = range(s, lo, T * 1.0001);
      let ser = null, par = null;
      for (const a of cand) {
        const rest = T - a;
        if (rest > 0) for (const b of near2(rest, s)) { const e = (a + b - T) / T; if (!ser || Math.abs(e) < Math.abs(ser.error) - 1e-12) ser = {a: Math.max(a, b), b: Math.min(a, b), value: a + b, error: e}; }
      }
      for (const a of range(s, T, T * 1000)) {
        const need = 1 / (1 / T - 1 / a);
        if (!(need > 0) || !finite(need)) continue;
        for (const b of near2(need, s)) { const val = a * b / (a + b), e = (val - T) / T; if (!par || Math.abs(e) < Math.abs(par.error) - 1e-12) par = {a: Math.min(a, b), b: Math.max(a, b), value: val, error: e}; }
      }
      const pc = x => (x * 100).toFixed(3) + " %", warnings = [];
      if (Math.abs(n.error) * 100 > v.tolerance && (!ser || Math.abs(ser.error) * 100 > v.tolerance) && (!par || Math.abs(par.error) * 100 > v.tolerance)) warnings.push("No single value or pair is within ±" + v.tolerance + " %.");
      const adjacent = near2(T,s), below = Math.max(...adjacent.filter(x => x <= T)), above = Math.min(...adjacent.filter(x => x >= T));
      return {values: {nearest: n.value, below, above, error: n.error, series: ser, parallel: par},
        rows: [["Nearest " + s, n.value, "", true], ["  error", pc(n.error), ""], ["Below / above", fmt(below) + " / " + fmt(above), ""],
          ...(ser ? [["Series pair", fmt(ser.a) + " + " + fmt(ser.b) + " = " + fmt(ser.value), ""], ["  error", pc(ser.error), ""]] : []),
          ...(par ? [["Parallel pair", fmt(par.a) + " ∥ " + fmt(par.b) + " = " + fmt(par.value), ""], ["  error", pc(par.error), ""]] : [])], warnings};
    }
  });

  calc("divider", {
    title: "Regulator feedback divider", group: "Power",
    inputs: [pick("solve", "Solve for", [["resistors","Standard resistor pair"], ["voltage","Output from resistors"]], "resistors"),
      num("top", "Upper resistor", "Ω", 10000, {min:0}), num("bottom", "Lower resistor", "Ω", 10000, {min:0}),
      num("vout", "Output voltage", "V", 3.3, {min: 0.01, max: 1000}), num("vref", "Reference (feedback) voltage", "V", 0.8, {min: 0, max: 100}),
      pick("series", "Series", SERIES.slice(1).map(s => [s, s]), "E96"), num("rmin", "Bottom resistor min", "Ω", 1000, {min: 1}),
      num("rmax", "Bottom resistor max", "Ω", 100000, {min: 1}), num("iadj", "Feedback / ADJ pin current", "µA", 0, {help: "LM317: 50 µA"})],
    formula: ["Vout = Vref·(1 + R_top / R_bottom) + I_adj·R_top", "R_top(ideal) = (Vout − Vref) / (Vref / R_bottom + I_adj); the nearest series values either side are tried",
      "Divider current = Vref / R_bottom"],
    assumptions: ["Ideal reference and resistors; resistor tolerance and Vref accuracy add to the error shown.",
      "For an LDO or buck feedback pin the pin current is usually negligible (leave 0); an LM317 ADJ pin sources about 50 µA."],
    sources: ["TI LM317 datasheet (SLVS044), equation 1: Vo = Vref(1 + R2/R1) + I_ADJ·R2.", "IEC 60063 values."],
    run(v) {
      if (v.solve === "voltage") {
        if (!(v.top > 0 && v.bottom > 0)) fail("Enter both resistor values.");
        const ratio = v.top / v.bottom, vo = v.vref > 0 ? v.vref * (1 + ratio) + v.iadj * 1e-6 * v.top : null;
        return {values:{top:v.top,bottom:v.bottom,ratio,vout:vo}, rows:[...(vo != null ? [["Output voltage",vo,"V",true]] : []),
          ["Upper / lower ratio",ratio,"",true], ["Upper resistor",v.top,"Ω"], ["Lower resistor",v.bottom,"Ω"]],
          warnings:vo == null ? ["Enter the regulator’s feedback reference voltage to calculate its output."] : []};
      }
      if (!(v.vref > 0)) fail("Enter the regulator’s feedback reference voltage.");
      if (!(v.vout > v.vref)) fail("The output voltage must be above the reference.");
      if (!(v.rmax >= v.rmin)) fail("The maximum resistor must be at least the minimum.");
      const ia = v.iadj * 1e-6, out = [];
      for (const rb of range(v.series, v.rmin, v.rmax)) {
        const ideal = (v.vout - v.vref) / (v.vref / rb + ia);
        if (!(ideal > 0)) continue;
        for (const rt of near2(ideal, v.series)) { const vo = v.vref * (1 + rt / rb) + ia * rt; out.push({top: rt, bottom: rb, vout: vo, error: (vo - v.vout) / v.vout, current: v.vref / rb}); }
      }
      if (!out.length) fail("No resistor pair in that range.");
      out.sort((a, b) => Math.abs(a.error) - Math.abs(b.error) || b.bottom - a.bottom);
      const seen = new Set(), best = out.filter(c => { const k = c.top + "/" + c.bottom; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 5), x = best[0];
      return {values: {top: x.top, bottom: x.bottom, vout: x.vout, error: x.error, current: x.current, candidates: best},
        rows: [["R top", x.top, "Ω", true], ["R bottom", x.bottom, "Ω", true], ["Vout", x.vout, "V"], ["Error", (x.error * 100).toFixed(3) + " %", ""],
          ["Divider current", x.current, "A"], ...best.slice(1).map((c, i) => ["Alternative " + (i + 1), fmt(c.top) + " / " + fmt(c.bottom) + " → " + (c.error * 100).toFixed(3) + " %", ""])], warnings: []};
    }
  });

  calc("voltage_divider", {
    title: "Voltage divider", group: "Components",
    inputs: [num("vin", "Input voltage", "V", 5), num("top", "Upper resistor", "Ω", 10000, {min: 0}), num("bottom", "Lower resistor", "Ω", 10000, {min: 0})],
    formula: ["Vout = Vin · Rbottom / (Rtop + Rbottom)"],
    assumptions: ["Ideal source, unloaded output and nominal resistances."], sources: ["Ohm’s law and Kirchhoff’s voltage law."],
    run(v) {
      const total = v.top + v.bottom;
      if (!(total > 0)) fail("Enter a positive total resistance.");
      const current = v.vin / total, voltage = current * v.bottom;
      return {values:{voltage,current}, rows:[["Output voltage",voltage,"V",true], ["Divider current",current,"A"]]};
    }
  });

  calc("led_resistor", {
    title: "LED series resistor", group: "Components",
    inputs: [num("supply", "Supply voltage", "V", 5), num("forward", "Forward voltage", "V", 2, {min: 0}), num("current", "LED current", "mA", 10, {min: 0})],
    formula: ["R = (Vsupply − Vf) / I", "P = (Vsupply − Vf) · I"],
    assumptions: ["One LED with a constant forward drop at the specified current."], sources: ["Ohm’s law and resistor power dissipation."],
    run(v) {
      const drop = v.supply - v.forward, current = v.current / 1000;
      if (!(drop > 0 && current > 0)) fail("Supply voltage must exceed the LED forward voltage and current must be positive.");
      const resistance = drop / current, power = drop * current;
      return {values:{resistance,power}, rows:[["Series resistor",resistance,"Ω",true], ["Resistor dissipation",power,"W"]]};
    }
  });

  calc("rclc", {
    title: "RC / LC filters", group: "Components",
    inputs: [num("r", "Resistance", "Ω", 1000, {min: 0}), num("c", "Capacitance", "nF", 100, {min: 0}), num("l", "Inductance", "µH", 10, {min: 0})],
    formula: ["RC: τ = R·C,  f_c = 1 / (2π·R·C)", "RL: τ = L / R,  f_c = R / (2π·L)", "LC: f₀ = 1 / (2π·√(L·C)),  Z₀ = √(L/C),  series Q = Z₀ / R"],
    assumptions: ["First-order RC/RL: −3 dB at f_c; reaching 63.2 % takes τ and 99.3 % takes 5τ.", "Ideal components (no ESR, ESL or self-resonance)."],
    sources: ["Horowitz & Hill, The Art of Electronics 3rd ed., §1.4–1.7."],
    run(v) {
      const R = v.r, C = v.c * 1e-9, L = v.l * 1e-6, rows = [], values = {};
      if (R > 0 && C > 0) { values.tau_rc = R * C; values.fc_rc = 1 / (2 * PI * R * C); rows.push(["RC time constant τ", R * C, "s", true], ["RC corner f_c", values.fc_rc, "Hz", true]); }
      if (R > 0 && L > 0) { values.tau_rl = L / R; values.fc_rl = R / (2 * PI * L); rows.push(["RL time constant", L / R, "s"], ["RL corner", values.fc_rl, "Hz"]); }
      if (L > 0 && C > 0) { values.f0 = 1 / (2 * PI * Math.sqrt(L * C)); values.z0 = Math.sqrt(L / C); rows.push(["LC resonance f₀", values.f0, "Hz", true], ["Characteristic impedance", values.z0, "Ω"]);
        if (R > 0) { values.q = values.z0 / R; rows.push(["Series Q", values.q, ""]); } }
      if (!rows.length) fail("Enter two of R, C and L.");
      return {values, rows, warnings: []};
    }
  });

  const LEN = {mm: 1, mil: MIL, in: 25.4, um: 0.001, cm: 10, oz: OZ_UM / 1000};
  calc("units", {
    title: "Unit converter", group: "General",
    inputs: [num("value", "Value", "", 10), pick("unit", "Unit", [["mm", "mm"], ["mil", "mil (thou)"], ["in", "inch"], ["um", "µm"], ["cm", "cm"], ["oz", "oz/ft² copper"]], "mil")],
    formula: ["1 mil = 0.0254 mm = 25.4 µm; 1 in = 1000 mil = 25.4 mm", "Copper weight: 1 oz/ft² = 35 µm nominal (1.378 mil)"],
    assumptions: ["Copper weight converts at the IPC nominal 35 µm per oz/ft² (the mass alone gives 34.1 µm; fabs quote 34–35 µm)."],
    sources: ["NIST SP 811 (inch = 25.4 mm exactly).", "IPC-4562 copper foil nominal thickness."],
    run(v) {
      const mm = v.value * (LEN[v.unit] || fail("Unknown unit " + v.unit + "."));
      const values = {mm, mil: mm / MIL, in: mm / 25.4, um: mm * 1000, cm: mm / 10, oz: mm / LEN.oz};
      return {values, rows: [["mm", values.mm, "", true], ["mil", values.mil, "", true], ["inch", values.in, ""], ["µm", values.um, ""], ["cm", values.cm, ""], ["oz/ft² copper", values.oz, ""]], warnings: []};
    }
  });

  calc("track_resistance", {
    title: "Track resistance and current capacity", group: "PCB",
    inputs: [num("width", "Track width", "mm", 0.254, {min: 0.001}), num("length", "Length", "mm", 25.4, {min: 0}), {...COPPER,min:.001,max:300},
      num("current", "Current", "A", 1, {min: 0}), num("temperature", "Copper temperature", "°C", 20),
      num("rise", "Allowable temperature rise", "°C", 10, {min:0.5, max:100}),
      pick("layer","Layer",[["external","External (outer)"],["internal","Internal (inner)"]],"external")],
    formula: ["IPC-2152 (Brooks & Adam fit): solve ΔT = K·I^a·W^b·Th^c for current.", "R = ρ₂₀·(1 + α·(T − 20))·L / (W·t),  ρ₂₀ = 1.7241·10⁻⁸ Ω·m, α = 0.00393 /°C", "Sheet resistance R□ = ρ/t; squares = L/W", "V = I·R,  P = I²·R"],
    assumptions: ["DC; at high frequency the skin effect raises the resistance (skin depth 66 µm at 1 MHz).",
      "Annealed-copper resistivity; electrodeposited PCB copper is typically 5–10 % higher."],
    sources: ["Brooks & Adam (2015), Table 3-1, fitted to IPC-2152 track heating data.", "IEC 60028 (International Annealed Copper Standard).", "TI SLUA366 / common rule of thumb: 1 oz copper ≈ 0.5 mΩ per square at 25 °C."],
    run(v) {
      const t = v.copper * OZ_UM / 1000, R = resistance(v.length, v.width * t, v.temperature), sq = rho(v.temperature) / t;
      const capacity = IPC().conductor({method:"brooksAdam",width:v.width,thickness:t,rise:v.rise,internal:v.layer === "internal"});
      return {values: {resistance: R, current_max:capacity.current, drop: R * v.current, power: R * v.current ** 2, sheet: sq, squares: v.length / v.width},
        rows: [["Resistance", R, "Ω", true], ["Current capacity at " + v.rise + " °C rise", capacity.current, "A", true], ["Voltage drop", R * v.current, "V"], ["Power", R * v.current ** 2, "W"],
          ["Sheet resistance", sq * 1000, "mΩ/□"], ["Squares", v.length / v.width, ""]], warnings:capacity.warnings};
    }
  });

  calc("ohm", {
    title: "Ohm's law", group: "General",
    inputs: [num("v", "Voltage", "V", 5, {blank: true}), num("i", "Current", "A", 0, {blank: true}), num("r", "Resistance", "Ω", 1000, {blank: true}), num("p", "Power", "W", 0, {blank: true})],
    formula: ["V = I·R,  P = V·I = I²·R = V²/R; any two known values give the other two"],
    assumptions: ["DC or RMS values; a value of 0 or blank is unknown (the first two non-zero values are used)."],
    sources: ["Ohm's law and Joule's law."],
    run(v) {
      const k = ["v", "i", "r", "p"].filter(x => v[x] > 0).slice(0, 2).join("");
      let V, I, R, P;
      const r = {v: v.v, i: v.i, r: v.r, p: v.p};
      switch (k) {
        case "vi": V = r.v; I = r.i; R = V / I; P = V * I; break;
        case "vr": V = r.v; R = r.r; I = V / R; P = V * I; break;
        case "vp": V = r.v; P = r.p; I = P / V; R = V / I; break;
        case "ir": I = r.i; R = r.r; V = I * R; P = V * I; break;
        case "ip": I = r.i; P = r.p; V = P / I; R = V / I; break;
        case "rp": R = r.r; P = r.p; I = Math.sqrt(P / R); V = I * R; break;
        default: fail("Enter two of voltage, current, resistance and power.");
      }
      return {values: {v: V, i: I, r: R, p: P}, rows: [["Voltage", V, "V", true], ["Current", I, "A", true], ["Resistance", R, "Ω", true], ["Power", P, "W", true]], warnings: []};
    }
  });

  calc("derating", {
    title: "Power derating", group: "Power",
    inputs: [num("rated", "Rated power", "W", 0.25, {min: 0}), num("knee", "Full power up to", "°C", 70), num("tmax", "Zero power at", "°C", 155),
      num("ambient", "Ambient", "°C", 85), num("power", "Dissipated power", "W", 0.1, {min: 0}), num("margin", "Design margin (derate to)", "%", 50, {min: 1, max: 100})],
    formula: ["P_allowed = P_rated                              (T ≤ T_knee)", "P_allowed = P_rated·(T_max − T) / (T_max − T_knee)   (T_knee < T < T_max)",
      "Recommended limit = margin × P_allowed"],
    assumptions: ["Linear derating as in thick-film chip resistor datasheets (full power to 70 °C, zero at 155 °C).",
      "Margin follows common practice (50–60 % of the derated rating, e.g. NASA EEE-INST-002)."],
    sources: ["Vishay CRCW e3 datasheet, derating curve (70 °C / 155 °C).", "NASA EEE-INST-002, resistor derating."],
    run(v) {
      if (!(v.tmax > v.knee)) fail("The zero-power temperature must be above the knee.");
      const allowed = globalThis.AtriumElectricalMaterial.deratedPower(v.rated, v.ambient, v.knee, v.tmax);
      const limit = allowed * v.margin / 100, warnings = [];
      if (v.power > allowed) warnings.push("Over the derated rating.");
      else if (v.power > limit) warnings.push("Within the rating but above the " + v.margin + " % design margin.");
      return {values: {allowed, limit, ok: v.power <= limit, utilisation: allowed > 0 ? v.power / allowed : Infinity},
        rows: [["Allowed at " + v.ambient + " °C", allowed, "W", true], ["Design limit", limit, "W", true],
          ["Utilisation", allowed > 0 ? (v.power / allowed * 100).toFixed(1) + " %" : "∞", ""], ["Verdict", v.power <= limit ? "OK" : v.power <= allowed ? "Marginal" : "Overstressed", ""]], warnings};
    }
  });

  calc("attenuator", {
    title: "Attenuator pads", group: "Components",
    inputs: [num("db", "Attenuation", "dB", 3, {min: 0.01, max: 100}), num("z0", "Impedance", "Ω", 50, {min: 1})],
    formula: ["K = 10^(dB/20)", "Pi: shunt = Z₀·(K+1)/(K−1),  series = Z₀·(K²−1)/(2K)", "T: series = Z₀·(K−1)/(K+1),  shunt = 2·Z₀·K/(K²−1)"],
    assumptions: ["Matched, symmetric pad between equal source and load impedances."],
    sources: ["Reference Data for Engineers 9th ed., ch. 6 (attenuators)."],
    run(v) {
      const K = Math.pow(10, v.db / 20), Z = v.z0;
      const values = {pi_shunt: Z * (K + 1) / (K - 1), pi_series: Z * (K * K - 1) / (2 * K), t_series: Z * (K - 1) / (K + 1), t_shunt: 2 * Z * K / (K * K - 1)};
      return {values, rows: [["Pi shunt (×2)", values.pi_shunt, "Ω", true], ["Pi series", values.pi_series, "Ω", true], ["T series (×2)", values.t_series, "Ω"], ["T shunt", values.t_shunt, "Ω"]], warnings: []};
    }
  });

  // ------------------------------------------------------------------ dispatch
  function fmt(x, unit = "") {
    if (typeof x !== "number") return x == null ? "—" : String(x);
    if (!finite(x)) return x > 0 ? "∞" : "—";
    if (x === 0) return "0" + (unit ? " " + unit : "");
    const SI = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
    const si = ["Ω", "A", "V", "W", "s", "Hz", "F", "H", ""].includes(unit) && unit !== "" || (unit === "" && Math.abs(x) >= 1e4);
    if (si) { const [m, p] = SI.find(([m]) => Math.abs(x) >= m * 0.9995) || SI.at(-1); return +(x / m).toPrecision(4) + (p || unit ? " " + p + unit : ""); }
    return +x.toPrecision(Math.abs(x) >= 1000 ? 6 : 4) + (unit ? " " + unit : "");
  }
  const ALIAS = {track: "track_width", trackwidth: "track_width", via: "via_current", e_series: "eseries", regulator: "divider", rc: "rclc", lc: "rclc",
    unit: "units", resistance: "track_resistance", ohms_law: "ohm", power: "derating"};
  function spec(id) { return CALCS[id] || CALCS[ALIAS[String(id).toLowerCase()]] || fail("Unknown calculator " + id + ". Calculators: " + Object.keys(CALCS).join(", ") + "."); }
  function list() {
    return Object.values(CALCS).map(c => ({id: c.id, title: c.title, group: c.group, formula: c.formula, assumptions: c.assumptions, sources: c.sources,
      inputs: c.inputs.map(({key, label, unit, def, kind, options, min, max}) => ({key, label, unit, default: def, kind, ...(options?.length ? {options: options.map(o => o[0]), choices:options.map(o => o.slice())} : {}), ...(min != null ? {min} : {}), ...(max != null ? {max} : {})}))}));
  }
  function numberInput(c,f,raw) {
    if (typeof raw === "number") return raw;
    if (c.id === "eseries" && f.key === "value" && globalThis.AtriumGenericParts) {
      const text = String(raw).trim(), family = /F$/.test(text) ? "capacitor" : /H$/.test(text) ? "inductor" : "resistor";
      return AtriumGenericParts.parseValue(text,family)?.value;
    }
    const text = String(raw).trim().replace(",", ".");
    if (f.unit === "mm" && globalThis.Atrium?.units && /[^0-9eE.+-]/.test(text)) return Atrium.units.parse(text,"mm");
    return Number(f.unit && text.endsWith(f.unit) ? text.slice(0,-f.unit.length).trim() : text);
  }
  // inputs: {key: number | numeric string | option}. Unknown keys are refused; missing ones take defaults.
  function calculate(id, inputs = {}, ctx = {}) {
    const c = spec(id), v = {}, given = new Set();
    if (inputs == null || typeof inputs !== "object" || Array.isArray(inputs)) fail("Inputs must be an object.");
    const keys = new Map(c.inputs.map(i => [i.key, i]));
    for (const k of Object.keys(inputs)) if (!keys.has(k)) fail("Unknown input " + k + " for " + c.id + ". Inputs: " + [...keys.keys()].join(", ") + ".");
    for (const f of c.inputs) {
      const raw = inputs[f.key], has = raw != null && raw !== "";
      if (f.kind === "number") {
        const x = has ? numberInput(c,f,raw) : f.blank && Object.keys(inputs).length ? 0 : f.def;
        if (!finite(x)) fail(f.label + " must be a number.");
        if (has && f.min != null && x < f.min) fail(f.label + " must be at least " + f.min + (f.unit ? " " + f.unit : "") + ".");
        if (has && f.max != null && x > f.max) fail(f.label + " must be at most " + f.max + (f.unit ? " " + f.unit : "") + ".");
        v[f.key] = x;
      } else {
        const s = has ? String(raw) : f.def;
        if (has && f.options.length && !f.options.some(o => o[0] === s)) fail(f.label + " must be one of " + f.options.map(o => o[0]).join(", ") + ".");
        v[f.key] = s;
      }
      if (has) given.add(f.key);
    }
    // Board defaults (thickness) when not typed.
    const b = stack(ctx);
    for (const f of c.inputs) if (b && f.board === "thickness" && !given.has(f.key)) { try { v[f.key] = b.S.thickness(b.doc, b.defs) || v[f.key]; } catch { /* derived */ } }
    if (b && c.id === "track_width" && !given.has("copper")) {
      const keys = copperKeys(ctx), l = b.st.layers.find(x => x.key === keys[v.layer === "internal" ? 1 : 0]);
      if (l?.thickness > 0 && (v.layer !== "internal" || keys.length > 2)) v.copper = Math.round(l.thickness / (OZ_UM / 1000) * 100) / 100;
    }
    const r = c.run(v, ctx, given);
    const clean = o => JSON.parse(JSON.stringify(o, (k, x) => typeof x === "number" ? (finite(x) ? +x.toPrecision(10) : null) : x));
    return {ok: true, calculator: c.id, title: c.title, inputs: clean(v), values: clean(r.values),
      rows: r.rows.map(([label, value, unit, primary]) => ({label, value: typeof value === "number" ? +value.toPrecision(10) : value, unit, text: fmt(value, unit), ...(primary ? {primary: true} : {})})),
      formula: c.formula, assumptions: c.assumptions, sources: c.sources, warnings: r.warnings || [], board: b ? (ctx.doc.name || ctx.doc.id) : null};
  }
  // MCP / headless: {calculator, inputs, document_id?} with a project.
  function headless(a, {project, board} = {}) {
    if (a.calculator === "list") return {calculators: list()};
    let ctx = {};
    const p = project?.();
    if (p) {
      const doc = a.document_id ? board?.(p, a.document_id) : p.documents.find(d => d.kind === "pcb");
      if (doc?.kind === "pcb") ctx = {doc, defs: new Map(p.library.map(d => [d.id, d]))};
    }
    return calculate(a.calculator, a.inputs || {}, ctx);
  }

  // Browser UI is loaded with the math module only when someone opens the tool.
  const panel = () => globalThis.AtriumCalculatorPanel;
  return Object.freeze({list, calculate, headless, eseries, nearest, range, format:fmt, SERIES,
    open:id => panel()?.open(id), toggle:show => panel()?.toggle(show), _internal:{resistance}});
})();
