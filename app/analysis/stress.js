"use strict";
// Component stress and derating check (Tools › Component Stress…), after PSpice's smoke
// analysis: every fitted capacitor, resistor and diode/LED of the active assembly variant is
// checked against its ratings from the part parameters, with the net voltages it sees.
//
// Net voltages, in order of precedence:
//   1. options.voltages {NET: volts} (the dialog's overrides; MCP `voltages`);
//   2. a SPICE operating point: options.spice = {nodes: {NET: V}, devices: {REF: {id, ...}}}. In the
//      editor the dialog asks the SPICE extension for it through its public command
//      (AtriumExtensions.execute("spice.simulate", {analysis: "op"})): the solver keeps running in
//      the extension's sandboxed worker with its own read:project permission; this module never
//      loads or evaluates extension code. Headless (MCP) runs have no extension host and use 1 and 3;
//   3. power-net and power-port names: GND/AGND/VSS/0V = 0 V; +3V3, 3V3, 3.3V, P5V0, VCC_1V8,
//      12V_IN, VIN_24V, -12V, N5V, 1800mV; VBUS = 5 V (USB); VBAT = 4.2 V (one Li-ion cell, full
//      charge; nominal 3.7 V). Name-derived rails get the supply margin (default 0 %).
//   Nets with no voltage: with worstCase (default on) they may sit anywhere between the lowest
//   and the highest known rail, and the stress is evaluated at that worst case and marked so.
//
// Checks (status ok | warn = over the derated design limit | fail = over the absolute rating |
// unknown = stress not computable | missing = no rating to compare):
//   * Capacitor rated voltage (Voltage, Rated Voltage, or "50V" in the value/description) vs the
//     largest voltage across it; derating by dielectric class (class II MLCC X7R/X5R/Y5V 50 %,
//     C0G/NP0 80 %, solid tantalum 50 %, aluminium electrolytic 80 %, film 70 %, other 80 %;
//     typical guidance, e.g. NASA EEE-INST-002 / IPC-9592; all adjustable).
//   * Resistor power V²/R at the low tolerance limit R·(1 − tol) vs the rating (Power, or "1/4W"
//     in the value; else the standard thick-film chip rating of its 0402…2512 package, marked
//     assumed), derated linearly from full power at 70 °C to zero at the part's maximum
//     temperature (default 155 °C) at the ambient, then a design margin (default 50 %). Same
//     model as Tools › Calculators › Power derating. Working voltage when a Voltage is given.
//   * Diode/LED forward current where computable: one series resistor between the diode and a
//     known rail, I = (V1 − V2 − Vf)/R (Vf parameter, else by colour or type), or the SPICE
//     device current; vs Current / If. Reverse voltage vs Vr / Voltage when both nets are known.
//   * Temperature rating below the ambient.
// API (DOM-free): AtriumStress.check(project, options) -> {rows, nets, variant, notes, stats};
//   netVoltage(name) / parseValue(text, kind) / derate(...); headless(args, host) (MCP stress_check).
globalThis.AtriumStress = (() => {
  if (!globalThis.AtriumElectricalMaterial && typeof require === "function") require("./electrical-material.js");
  const DEFAULTS = Object.freeze({ambient: 25, resistorMargin: 50, supplyMargin: 0, worstCase: true,
    derating: Object.freeze({class2: 50, class1: 80, tantalum: 50, electrolytic: 80, film: 70, other: 80}), knee: 70, tmax: 155});
  const PACKAGE_POWER = [["2512", 1], ["2010", .75], ["1218", 1], ["1210", .5], ["1206", .25], ["0805", .125], ["0603", .1], ["0402", .0625], ["0201", .05], ["01005", .03125]];
  const VF = [[/\b(ir|infra)/i, 1.3], [/\b(blue|white|uv|true ?green|pure ?green|cyan|pink|violet)/i, 3.0], [/\bgreen/i, 2.2], [/\b(red|orange|amber|yellow)/i, 2.0]];
  const r4 = v => Number.isFinite(v) ? +v.toPrecision(6) + 0 : v; // 6 significant digits
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
  const key = k => clean(k).toUpperCase().replace(/[_\s.]+/g, " ");
  function fail(m) { throw Error(m); }

  // ------------------------------------------------------------------ parsing
  const SCALE = {p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, k: 1e3, K: 1e3, M: 1e6, G: 1e9, R: 1, r: 1, "": 1};
  // A component value: "10 kΩ", "4k7", "2R2", "100nF", "1M" (resistors: mega), "0.25W", "1/4 W".
  function parseValue(text, kind) {
    let s = clean(text).replace(/Ω|ohms?/gi, "").replace(/\s+/g, "");
    if (!s) return null;
    let m = /^(\d+)\/(\d+)([a-zA-Zµμ]*)$/.exec(s);
    if (m) return +m[1] / +m[2] * (kind === "W" && /^mW$/i.test(m[3]) ? 1e-3 : 1);
    m = /^(\d+)([pnuµμmkKMGRr])(\d+)/.exec(s);
    if (m && (kind === "R" || kind === "C" || kind === "L")) return +(m[1] + "." + m[3]) * SCALE[m[2]];
    m = /^([+-]?\d*\.?\d+(?:e[+-]?\d+)?)([pnuµμmkKMGRr]?)/i.exec(s);
    if (!m || m[1] === "" || m[1] === ".") return null;
    let u = m[2];
    if (kind === "W" || kind === "A" || kind === "V") { const unit = s.slice(m[0].length - u.length); return +m[1] * (/^m/.test(unit) && !/^M/.test(unit) ? 1e-3 : /^[uµμ]/.test(unit) ? 1e-6 : /^k/i.test(unit) ? 1e3 : 1); }
    if (kind === "R" && u === "m") u = "m"; // milliohm only when written so
    return +m[1] * (SCALE[u] ?? 1);
  }
  // A number with a unit inside free text: "50V", "0.1 W", "20mA".
  function findUnit(text, unit) {
    const re = new RegExp("(\\d+(?:\\.\\d+)?|\\d+/\\d+)\\s*(m|k|µ|u)?" + unit + "(?![a-z])", "i"), m = re.exec(clean(text));
    if (!m) return null;
    const v = m[1].includes("/") ? +m[1].split("/")[0] / +m[1].split("/")[1] : +m[1];
    return v * (m[2] === "m" ? 1e-3 : m[2] === "k" ? 1e3 : m[2] === "µ" || m[2] === "u" ? 1e-6 : 1);
  }
  // net-intent.js (isGround) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const GROUND_RE = /^(?:[ADPSC]?GND|GND[A-Z0-9_]*|[ADPSC]GND[A-Z0-9_]*|VSS[A-Z0-9_]*|0V|EARTH|CHASSIS|PE|SHIELD|GROUND|COM)$/i;
  const GROUND = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isGround ? N.isGround(String(n ?? "")) : GROUND_RE.test(n); }};
  // Voltage implied by a net name, or null: {v, how}.
  function netVoltage(name) {
    const n = clean(name).toUpperCase();
    if (!n) return null;
    if (GROUND.test(n.replace(/^[\\/]/, ""))) return {v: 0, how: "ground"};
    if (/^(USB_)?VBUS\b|^VUSB\b/.test(n)) return {v: 5, how: "VBUS (USB 5 V)"};
    if (/^\+?VBAT\b|^BAT\+?$|^VBATT\b/.test(n)) return {v: 4.2, how: "VBAT (Li-ion 4.2 V)"};
    const neg = /(^|[^A-Z0-9])(-|N(?=\d))\d/.test(n) || /^M\d+V/.test(n);
    let m = /(?:^|[^0-9.])(\d+)V(\d+)(?![0-9])/.exec(n);
    if (m) return {v: (neg ? -1 : 1) * +(m[1] + "." + m[2]), how: "name"};
    m = /(\d+)MV(?![A-Z0-9])/.exec(n);
    if (m) return {v: (neg ? -1 : 1) * +m[1] / 1000, how: "name"};
    m = /(?:^|[^0-9.A-Z]|[A-Z_](?=\d))(\d+(?:\.\d+)?)V(?![A-Z0-9])/.exec(n) || /^[+-]?(\d+(?:\.\d+)?)V?$/.exec(n) || /^[+-]?(\d+(?:\.\d+)?)V/.exec(n);
    if (m) return {v: (neg ? -1 : 1) * +m[1], how: "name"};
    return null;
  }
  // Linear derating: full rating to `knee`, zero at `tmax`. An unordered range stays at rated power.
  function derate(rated, ambient, knee = 70, tmax = 155) {
    if (!(tmax > knee)) return rated;
    return globalThis.AtriumElectricalMaterial.deratedPower(rated, ambient, knee, tmax);
  }
  const PARAMS = {
    voltage: ["VOLTAGE", "RATED VOLTAGE", "VOLTAGE RATING", "VRATED", "V RATED", "WORKING VOLTAGE", "MAX VOLTAGE", "VDC", "VOLTAGE DC", "VOLTAGE RATED"],
    power: ["POWER", "POWER RATING", "RATED POWER", "WATTAGE", "POWER MAX", "MAX POWER", "PD"],
    current: ["CURRENT", "IF", "FORWARD CURRENT", "MAX CURRENT", "RATED CURRENT", "IF MAX", "CURRENT RATING", "IFM"],
    reverse: ["VR", "VRRM", "REVERSE VOLTAGE", "VRWM", "VOLTAGE REVERSE"],
    tolerance: ["TOLERANCE", "TOL"],
    temperature: ["TEMPERATURE", "MAX TEMPERATURE", "TEMPERATURE RATING", "TEMP RATING", "OPERATING TEMPERATURE", "TEMP", "TMAX", "TEMPERATURE RANGE"],
    vf: ["VF", "FORWARD VOLTAGE", "VF TYP"],
    dielectric: ["DIELECTRIC", "TEMPERATURE COEFFICIENT", "TC", "TEMPCO", "CHARACTERISTIC", "MATERIAL", "TYPE"]
  };
  function param(params, which) { for (const k of PARAMS[which]) if (own(params, k) && clean(params[k]) !== "") return clean(params[k]); return null; }
  function maxTemp(text) { const nums = (clean(text).match(/[-+−]?\d+(?:\.\d+)?/g) || []).map(x => +x.replace("−", "-")); return nums.length ? Math.max(...nums) : null; }
  function capClass(text, ref) {
    if (/X[5-8][RSTPUV]|Y5V|Z5U|X7T|X6S|CLASS ?(II|2)/i.test(text)) return "class2";
    if (/C0G|COG|NP0|NPO|CLASS ?(I|1)\b/i.test(text)) return "class1";
    if (/TANT|TA\b|POLYMER TANT/i.test(text)) return "tantalum";
    if (/ELECTROLYTIC|ALUM|ELCO|E-CAP|\bECAP|POLARI[SZ]ED|\bCP\d/i.test(text) || /^CP\d/i.test(ref)) return "electrolytic";
    if (/FILM|\bPP\b|\bPET\b|POLYPROP|POLYESTER|MKT|MKP/i.test(text)) return "film";
    return "other";
  }
  function kindOf(ref, text) {
    const p = (/^[A-Z]+/i.exec(ref || "") || [""])[0].toUpperCase();
    if (p === "LED" || (/^D$/.test(p) && /\bLED\b/i.test(text))) return "led";
    if (p === "D" || p === "CR" || p === "Z" || p === "ZD") return "diode";
    if (p === "R") return "resistor";
    if (p === "C" || p === "CP") return "capacitor";
    return null;
  }

  // ------------------------------------------------------------------ design
  // Parts and nets from the schematics (project-wide, AtriumHierarchy), else the first board.
  function design(project, options) {
    const defs = new Map((project.library || []).map(d => [d.id, d])), A = globalThis.Atrium, notes = [];
    let resolved = null;
    try { resolved = globalThis.AtriumVariants?.resolve?.(project, options.variant) || null; } catch (e) { if (options.variant != null && options.variant !== "") throw e; resolved = null; }
    const variant = (() => { try { return globalThis.AtriumVariants?.current?.(project, options.variant) || null; } catch { return null; } })();
    const sheets = (project.documents || []).filter(d => d.kind === "schematic" && d.items.some(i => i.kind === "part"));
    const parts = new Map(), nets = new Map(), ports = new Set();
    const addPin = (net, part, number, name) => { if (!net) return; if (!nets.has(net)) nets.set(net, []); nets.get(net).push({part, number: String(number), name: clean(name)}); };
    const entryOf = (item, doc) => {
      const k = item.link || item.id;
      if (!parts.has(k)) {
        const r = resolved?.[k], def = defs.get(r?.def || item.def);
        const params = {};
        for (const src of [def?.parameters, item.parameters, r?.params]) if (src && typeof src === "object") for (const [pk, pv] of Object.entries(src)) if (pv != null && typeof pv !== "object") params[key(pk)] = clean(pv);
        parts.set(k, {key: k, id: item.id, docId: doc.id, ref: String(r?.ref || item.ref || ""), value: String(r?.value ?? item.value ?? ""), def, params, fitted: r ? r.fitted : !item.dnp,
          at: [item.x, item.y], footprint: clean(def?.footprint?.name || def?.footprintName || params.FOOTPRINT || ""), pins: new Map(), description: clean(def?.description || params.DESCRIPTION || "")});
      }
      return parts.get(k);
    };
    if (sheets.length) {
      let compiled = null;
      try { compiled = globalThis.AtriumHierarchy?.compile?.(project, {defs}) || null; } catch { compiled = null; }
      if (compiled) {
        for (const n of compiled.nets) for (const p of n.pins) { const e = entryOf(p.part, p.doc); e.pins.set(String(p.pin.number), n.name); addPin(n.name, e, p.pin.number, p.pin.name); }
      } else for (const doc of sheets) {
        const c = A.connectivity(doc, defs);
        for (const i of doc.items) if (i.kind === "part") for (const pin of A.pins(i, defs.get(i.def), "schematic")) {
          const net = c.byPin.get(i.id + "/" + pin.number), e = entryOf(i, doc);
          if (net) { e.pins.set(String(pin.number), net); addPin(net, e, pin.number, pin.name); }
        }
      }
      for (const doc of sheets) for (const i of doc.items) {
        if (i.kind === "part") entryOf(i, doc);
        else if (i.kind === "power" && i.text) ports.add(i.text);
        else if (i.kind === "netlabel" && i.schPaint?.type === "power") ports.add(i.text);
      }
      // Pin names from the symbols.
      for (const e of parts.values()) for (const pin of e.def?.symbol?.pins || []) if (pin.name && e.pins.has(String(pin.number))) {
        for (const p of nets.get(e.pins.get(String(pin.number))) || []) if (p.part === e && p.number === String(pin.number)) p.name = pin.name;
      }
    } else {
      const board = (project.documents || []).find(d => d.kind === "pcb");
      if (board) {
        notes.push("No schematic: nets come from the board's pad nets.");
        for (const i of board.items) if (i.kind === "part") { const e = entryOf(i, board); for (const [num, net] of Object.entries(i.pinNets || {})) if (net) { e.pins.set(num, net); addPin(net, e, num, ""); } }
      }
    }
    return {defs, parts, nets, ports, variant, notes};
  }

  // ------------------------------------------------------------------ check
  function check(project, options = {}) {
    if (!project?.documents) fail("Open a project for the component stress check.");
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    const given = Object.fromEntries(Object.entries(options).filter(([k, v]) => v !== undefined && (v !== null || k === "variant")));
    const o = {...DEFAULTS, ...given, derating: {...DEFAULTS.derating, ...Object.fromEntries(Object.entries(options.derating || {}).filter(([, v]) => Number.isFinite(+v) && v !== null))}};
    const D = design(project, o), notes = [...D.notes], rows = [];
    // Net voltages.
    const volts = new Map(), spiceNodes = o.spice?.nodes || null;
    for (const net of D.nets.keys()) {
      if (o.voltages && own(o.voltages, net) && Number.isFinite(+o.voltages[net])) { volts.set(net, {v: +o.voltages[net], source: "override"}); continue; }
      if (spiceNodes) { const k = Object.keys(spiceNodes).find(x => x.toLowerCase() === net.toLowerCase()); if (k != null && Number.isFinite(spiceNodes[k])) { volts.set(net, {v: spiceNodes[k], source: "SPICE .op"}); continue; } }
      const g = netVoltage(net);
      if (g) volts.set(net, {v: g.v === 0 ? 0 : g.v * (1 + o.supplyMargin / 100), source: g.how === "name" ? "net name" + (D.ports.has(net) ? " (power port)" : "") : g.how, nominal: g.v});
    }
    const known = [...volts.values()].map(x => x.v), lo = Math.min(0, ...known), hi = Math.max(0, ...known);
    const range = net => { const k = volts.get(net); return k ? {lo: k.v, hi: k.v, source: k.source, exact: true} : o.worstCase && known.length ? {lo, hi, source: "worst case", exact: false} : null; };
    // Largest |V(a) − V(b)| over the ranges.
    const across = (a, b) => { const A = range(a), B = range(b); if (!A || !B) return null; return {v: Math.max(Math.abs(A.hi - B.lo), Math.abs(A.lo - B.hi)), exact: A.exact && B.exact, source: A.exact && B.exact ? (A.source === B.source ? A.source : A.source + " / " + B.source) : "worst case", signed: A.exact && B.exact ? A.hi - B.hi : null}; };
    const row = (e, kind, check, extra) => {
      const r = {id: e.id, docId: e.docId, key: e.key, ref: e.ref, kind, value: e.value, check, applied: null, rating: null, limit: null, usage: null, unit: "", status: "unknown", basis: "", nets: [...new Set(e.pins.values())], detail: "", ...extra};
      rows.push(r); return r;
    };
    const grade = (r, worst) => {
      if (r.rating == null) { r.status = r.applied == null ? "unknown" : "missing"; if (r.status === "missing") r.detail ||= "No " + ({voltage: "voltage", power: "power", current: "current", reverse: "reverse voltage", temperature: "temperature"})[r.check] + " rating in the part parameters."; return r; }
      if (r.applied == null) { r.status = "unknown"; return r; }
      r.usage = r.limit > 0 ? r4(r.applied / r.limit * 100) : r.applied > 0 ? Infinity : 0;
      r.status = r.applied > r.rating * (1 + 1e-9) ? "fail" : r.applied > r.limit * (1 + 1e-9) ? "warn" : "ok";
      if (worst && r.status === "fail") { r.status = "warn"; r.worstCase = true; r.detail += " · over the rating only in the worst case (unknown net voltage)"; }
      return r;
    };
    const fitted = [...D.parts.values()].filter(e => e.fitted !== false);
    const unfitted = D.parts.size - fitted.length;
    if (unfitted) notes.push(unfitted + " part" + (unfitted === 1 ? " is" : "s are") + " not fitted in " + (D.variant ? "variant " + D.variant.name : "the base design") + " and not checked.");
    const twoNets = e => { const pins = [...e.pins.entries()].sort((a, b) => a[0] < b[0] ? -1 : 1); return pins.length >= 2 ? [pins[0][1], pins[1][1]] : null; };
    for (const e of fitted) {
      const text = [e.value, e.description, e.def?.name, ...Object.values(e.params)].join(" ");
      const kind = kindOf(e.ref, text);
      if (!kind) continue;
      const tRating = param(e.params, "temperature"), tMax = tRating != null ? maxTemp(tRating) : null;
      if (tMax != null && tMax < o.ambient) grade(Object.assign(row(e, kind, "temperature", {unit: "°C", basis: "ambient"}), {applied: o.ambient, rating: tMax, limit: tMax}));
      if (kind === "capacitor") {
        const nets = twoNets(e), V = nets ? across(nets[0], nets[1]) : null;
        const ratingText = param(e.params, "voltage"), rating = ratingText != null ? parseValue(ratingText, "V") ?? findUnit(ratingText, "V") : findUnit(e.value + " " + e.description, "V");
        const cls = capClass(param(e.params, "dielectric") + " " + text, e.ref), pct = o.derating[cls] ?? o.derating.other;
        const r = row(e, kind, "voltage", {unit: "V", applied: V ? r4(V.v) : null, rating: rating ?? null, limit: rating != null ? r4(rating * pct / 100) : null, basis: V?.source || "no net voltage", derating: pct, class: cls});
        if (!V) r.detail = "Voltage across it unknown: no rail or SPICE voltage on " + (nets || []).join(" / ") + ".";
        else r.detail = "Across " + nets.join(" – ") + "; derated to " + pct + " % (" + cls + ")";
        grade(r, V && !V.exact);
      } else if (kind === "resistor") {
        const nets = twoNets(e), V = nets ? across(nets[0], nets[1]) : null, R = parseValue(e.value, "R");
        const tolText = param(e.params, "tolerance"), tol = tolText != null ? Math.abs(parseFloat(tolText)) / 100 : (/(\d+(?:\.\d+)?)\s*%/.exec(e.value)?.[1] ?? null) / 100 || 0;
        const pText = param(e.params, "power");
        let rated = pText != null ? parseValue(pText, "W") ?? findUnit(pText, "W") : findUnit(e.value + " " + e.description, "W"), basis = "rating";
        if (rated == null) { const pk = PACKAGE_POWER.find(([p]) => new RegExp("(^|[^0-9])" + p + "([^0-9]|$)").test(e.footprint)); if (pk) { rated = pk[1]; basis = "assumed from " + pk[0] + " package"; } }
        const tmax = tMax ?? o.tmax, allowed = rated != null ? derate(rated, o.ambient, o.knee, tmax) : null;
        const Rmin = R > 0 ? R * (1 - tol) : null, P = V && Rmin ? V.v * V.v / Rmin : null;
        const r = row(e, kind, "power", {unit: "W", applied: P != null ? r4(P) : null, rating: allowed != null ? r4(allowed) : null, limit: allowed != null ? r4(allowed * o.resistorMargin / 100) : null,
          basis: V ? V.source : "no net voltage", resistance: R, tolerance: tol, ratedPower: rated, ratingBasis: basis});
        if (!(R > 0)) r.detail = "Resistance not readable from the value “" + e.value + "”.";
        else if (!V) r.detail = "Voltage across it unknown.";
        else r.detail = "V = " + r4(V.v) + " V across " + nets.join(" – ") + ", R min " + r4(Rmin) + " Ω (" + r4(tol * 100) + " %), rating " + (rated ?? "—") + " W " + basis + (o.ambient > o.knee ? ", derated at " + o.ambient + " °C" : "");
        grade(r, V && !V.exact);
        const vText = param(e.params, "voltage");
        if (vText != null && V) { const vr = parseValue(vText, "V") ?? findUnit(vText, "V"); grade(row(e, kind, "voltage", {unit: "V", applied: r4(V.v), rating: vr, limit: vr, basis: V.source, detail: "Working voltage"}), !V.exact); }
      } else {
        // Diode / LED: anode and cathode by pin name, else pin 1 = K, pin 2 = A.
        const pins = [...e.pins.entries()];
        const nameOf = num => (D.nets.get(e.pins.get(num)) || []).find(p => p.part === e && p.number === num)?.name || "";
        let A = pins.find(([n]) => /^(A|AN|ANODE|\+|A1)$/i.test(nameOf(n))), K = pins.find(([n]) => /^(K|C|CA|CATHODE|-|−|K1)$/i.test(nameOf(n)));
        let assumed = false;
        if (!A || !K) { A = pins.find(([n]) => n === "2"); K = pins.find(([n]) => n === "1"); assumed = true; }
        if (!A || !K) continue;
        const na = A[1], nk = K[1], spiceDev = o.spice?.devices?.[e.ref] || o.spice?.devices?.[e.ref.toUpperCase()];
        const vfText = param(e.params, "vf"), vf = vfText != null ? parseValue(vfText, "V") ?? findUnit(vfText, "V") : kind === "led" ? (VF.find(([re]) => re.test(text))?.[1] ?? 2.0) : /schottky|bat\d|1n58|ss\d/i.test(text) ? .3 : .7;
        const iText = param(e.params, "current"), iRating = iText != null ? parseValue(iText, "A") ?? findUnit(iText, "A") : findUnit(e.value + " " + e.description, "A");
        let I = null, basis = "", detail = "";
        if (spiceDev && Number.isFinite(spiceDev.id)) { I = Math.abs(spiceDev.id); basis = "SPICE .op"; detail = "Device current from the operating point"; }
        else {
          // One series resistor from the unknown side to a known rail.
          const series = (net, other) => {
            if (volts.has(net)) return null;
            const list = (D.nets.get(net) || []).filter(p => p.part !== e && p.part.fitted !== false);
            if (list.length !== 1 || kindOf(list[0].part.ref, list[0].part.value) !== "resistor") return null;
            const rp = list[0].part, far = [...rp.pins.values()].find(n => n !== net);
            return far && volts.has(far) && volts.has(other) ? {r: rp, R: parseValue(rp.value, "R"), v: volts.get(far).v} : null;
          };
          const sa = series(na, nk), sk = series(nk, na);
          if (sa && sa.R > 0) { I = Math.max(0, (sa.v - volts.get(nk).v - vf) / sa.R); basis = volts.get(nk).source; detail = "(" + r4(sa.v) + " V − " + r4(volts.get(nk).v) + " V − Vf " + vf + " V) / " + sa.r.ref + " " + r4(sa.R) + " Ω"; }
          else if (sk && sk.R > 0) { I = Math.max(0, (volts.get(na).v - sk.v - vf) / sk.R); basis = volts.get(na).source; detail = "(" + r4(volts.get(na).v) + " V − " + r4(sk.v) + " V − Vf " + vf + " V) / " + sk.r.ref + " " + r4(sk.R) + " Ω"; }
          else detail = volts.has(na) && volts.has(nk) ? "Directly across known nets: the current is set by the circuit, not computable here." : "No single series resistor to a known rail: the current is not computable.";
        }
        const r = row(e, kind, "current", {unit: "A", applied: I != null ? r4(I) : null, rating: iRating ?? null, limit: iRating ?? null, basis, detail: detail + (assumed ? " (polarity assumed: pin 1 cathode)" : ""), vf});
        grade(r, false);
        const vrText = param(e.params, "reverse") ?? (kind === "diode" ? param(e.params, "voltage") : null), vr = vrText != null ? parseValue(vrText, "V") ?? findUnit(vrText, "V") : kind === "led" ? 5 : null;
        if (volts.has(na) && volts.has(nk)) {
          const rev = volts.get(nk).v - volts.get(na).v;
          if (rev > 0) grade(row(e, kind, "reverse", {unit: "V", applied: r4(rev), rating: vr, limit: vr != null ? r4(vr * .8) : null, basis: volts.get(nk).source,
            detail: "Reverse bias " + nk + " → " + na + (vrText == null && kind === "led" ? " (LED typical 5 V assumed)" : "")}), false);
        }
      }
    }
    const order = {fail: 0, warn: 1, missing: 2, unknown: 3, ok: 4};
    rows.sort((a, b) => order[a.status] - order[b.status] || natural(a.ref, b.ref));
    const counts = {fail: 0, warn: 0, missing: 0, unknown: 0, ok: 0};
    for (const r of rows) counts[r.status]++;
    if (!volts.size) notes.push("No net voltage is known: name power nets (+3V3, 12V, GND…), set overrides or use a SPICE operating point.");
    return {rows, counts, nets: Object.fromEntries([...volts].map(([n, v]) => [n, {v: r4(v.v), source: v.source}])), unknownNets: [...D.nets.keys()].filter(n => !volts.has(n)).sort(natural),
      variant: D.variant ? {id: D.variant.id, name: D.variant.name} : null, options: {ambient: o.ambient, resistorMargin: o.resistorMargin, supplyMargin: o.supplyMargin, worstCase: o.worstCase, derating: o.derating},
      spice: !!o.spice, notes, stats: {parts: D.parts.size, checked: rows.length, ms: r4((globalThis.performance?.now?.() ?? Date.now()) - t0)}};
  }
  function natural(a, b) {
    const x = String(a).match(/\d+|\D+/g) || [], y = String(b).match(/\d+|\D+/g) || [];
    for (let i = 0; i < Math.min(x.length, y.length); i++) { const p = x[i], q = y[i]; if (/^\d/.test(p) && /^\d/.test(q) && +p !== +q) return +p - +q; if (p !== q) return p < q ? -1 : 1; }
    return x.length - y.length;
  }

  // ------------------------------------------------------------------ MCP stress_check
  function headless(a, host) {
    const p = host.project();
    const derating = {};
    for (const [k, v] of Object.entries(a.derating || {})) derating[k] = v;
    const rep = check(p, {variant: a.variant, ambient: a.ambient, voltages: a.voltages, derating, resistorMargin: a.resistor_margin, supplyMargin: a.supply_margin, worstCase: a.worst_case,
      spice: a.node_voltages ? {nodes: a.node_voltages} : undefined});
    let rows = rep.rows;
    if (a.failing_only) rows = rows.filter(r => r.status === "fail" || r.status === "warn" || r.status === "missing");
    if (a.refs?.length) { const s = new Set(a.refs.map(x => String(x).toUpperCase())); rows = rows.filter(r => s.has(r.ref.toUpperCase())); }
    const items = rows.map(r => ({ref: r.ref, id: r.id, document_id: r.docId, kind: r.kind, value: r.value, check: r.check, applied: r.applied, rating: r.rating, limit: r.limit,
      usage_pct: Number.isFinite(r.usage) ? r.usage : r.usage == null ? null : "inf", unit: r.unit, status: r.status, basis: r.basis, nets: r.nets, detail: r.detail}));
    const page = host.page || (x => ({items: x}));
    return {variant: rep.variant, counts: rep.counts, net_voltages: rep.nets, unknown_nets: rep.unknownNets.slice(0, 200), options: rep.options, notes: rep.notes,
      spice: "SPICE operating points come from the SPICE extension in the editor; pass node_voltages to use one here.", ...page(items, a)};
  }

  // ------------------------------------------------------------------ dialog
  let H = null, dlg = null;
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  const button = (text, act, cls, title) => globalThis.AtriumUI.nativeButton(text, act, cls, title);
  const PREF = "atrium.stress.options";
  const loadPrefs = () => { try { return JSON.parse(globalThis.localStorage?.getItem(PREF) || "{}") || {}; } catch { return {}; } };
  const savePrefs = o => { try { globalThis.localStorage?.setItem(PREF, JSON.stringify(o)); } catch { /* private mode */ } };
  const fmtNum = (v, unit) => {
    if (v == null) return "—";
    if (!Number.isFinite(v)) return "∞";
    const a = Math.abs(v), [s, p] = a >= 1 || a === 0 ? [1, ""] : a >= 1e-3 ? [1e-3, "m"] : [1e-6, "µ"];
    return +(v / s).toPrecision(3) + " " + p + unit;
  };
  function open(host) {
    H = host; dlg?.close();
    const prefs = {ambient: 25, resistorMargin: 50, supplyMargin: 0, worstCase: true, derating: {...DEFAULTS.derating}, voltages: {}, ...loadPrefs()};
    let spice = null, onlyIssues = false, rep = null;
    const d = el("dialog", null, "work-dialog ui-dialog stress-dialog", {"aria-labelledby": "stress-heading"});
    dlg = d;
    const head = el("div", null, "stress-head"), summary = el("p", null, "stress-summary", {role: "status", "aria-live": "polite"});
    const title = el("h2", "Component Stress", null, {id: "stress-heading"});
    head.append(title, summary);
    const tools = el("div", null, "work-toolbar stress-tools");
    const num = (label, unit, get, set, title) => {
      const lab = el("label", null, "stress-field"), inp = el("input", null, "ui-field", {type: "number", step: "any", "aria-label": label + " (" + unit + ")"});
      inp.dataset.numericUnit = unit; inp.value = String(get()); if (title) lab.title = title;
      inp.onchange = () => { if (inp.value !== "" && Number.isFinite(+inp.value)) { set(+inp.value); savePrefs(prefs); paint(); } };
      lab.append(el("span", label), inp, el("span", unit, "stress-unit")); return lab;
    };
    tools.append(num("Ambient", "°C", () => prefs.ambient, v => prefs.ambient = v), num("Resistor margin", "%", () => prefs.resistorMargin, v => prefs.resistorMargin = v, "Design limit as a share of the derated power rating"),
      num("Supply margin", "%", () => prefs.supplyMargin, v => prefs.supplyMargin = v, "Added to rails derived from net names"),
      num("MLCC X7R/X5R", "%", () => prefs.derating.class2, v => prefs.derating.class2 = v, "Capacitor voltage derating, class II ceramics"),
      num("C0G", "%", () => prefs.derating.class1, v => prefs.derating.class1 = v), num("Tantalum", "%", () => prefs.derating.tantalum, v => prefs.derating.tantalum = v),
      num("Electrolytic", "%", () => prefs.derating.electrolytic, v => prefs.derating.electrolytic = v));
    const V = globalThis.AtriumVariants, variants = (() => { try { return V?.list?.(host.project()) || []; } catch { return []; } })();
    const varSel = el("select", null, "ui-field", {"aria-label": "Assembly variant"});
    varSel.append(new Option("Active variant", "__active"), new Option("Base design", ""));
    for (const v of variants) varSel.append(new Option(v.name, v.id));
    varSel.onchange = () => paint();
    const varLab = el("label", null, "stress-field"); varLab.append(el("span", "Variant"), varSel);
    const wc = el("label", null, "stress-field"), wcBox = el("input", null, "ui-checkbox", {type: "checkbox"}); wcBox.checked = prefs.worstCase !== false;
    wcBox.onchange = () => { prefs.worstCase = wcBox.checked; savePrefs(prefs); paint(); };
    wc.append(wcBox, el("span", " Worst case for unknown nets"));
    const fl = el("label", null, "stress-field"), flBox = el("input", null, "ui-checkbox", {type: "checkbox"});
    flBox.onchange = () => { onlyIssues = flBox.checked; paint(); };
    fl.append(flBox, el("span", " Only issues"));
    const spiceBtn = button("Use SPICE operating point", async () => {
      const E = globalThis.AtriumExtensions;
      if (!E?.attached) { summary.textContent = "The SPICE extension is not running (Tools › Extensions…). Using net-name voltages."; return; }
      summary.textContent = "Running the SPICE operating point…";
      try {
        const r = await E.execute("spice.simulate", {analysis: "op"});
        if (!r?.nodes) throw Error("The SPICE extension returned no operating point.");
        spice = {nodes: r.nodes, devices: r.devices || {}}; paint();
        summary.textContent += " · SPICE .op: " + Object.keys(r.nodes).length + " nodes";
      } catch (e) { spice = null; summary.textContent = "SPICE: " + e.message + " Using net-name voltages."; }
    }, "", "Ask the SPICE extension (in its sandbox) for node voltages and device currents");
    tools.append(varLab, wc, fl, spiceBtn);
    const wrap = AtriumUIKit.analysisTable(["Part", "Value", "Check", "Applied", "Derated limit", "Rating", "Use", "Status", "Basis", "Detail", ""], null, null, {wrapClass: "stress-table-wrap", tableClass: "analysis-table stress-table"});
    const tbody = wrap.querySelector("tbody");
    const netsBox = el("details", null, "stress-nets"), netsBody = el("div", null, "stress-nets-body");
    netsBox.append(el("summary", "Net voltages"), netsBody);
    const footer = el("div", null, "work-actions ui-dialog-actions");
    footer.append(button("Export CSV", () => {
      if (!rep) return;
      // Same rule as AtriumBOM.csvCell: text a spreadsheet would evaluate as a formula gets a leading ' (numbers pass).
      const q = v => { let s = String(v ?? ""); if (/^[=+\-@\t\r]/.test(s) && !/^[-+]?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(s)) s = "'" + s; return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const lines = [["Ref", "Kind", "Value", "Check", "Applied", "Limit", "Rating", "Unit", "Use %", "Status", "Basis", "Nets", "Detail"].join(",")];
      for (const r of rep.rows) lines.push([r.ref, r.kind, r.value, r.check, r.applied, r.limit, r.rating, r.unit, Number.isFinite(r.usage) ? r.usage : "", r.status, r.basis, r.nets.join(" "), r.detail].map(q).join(","));
      host.exportFile?.("component-stress.csv", lines.join("\n") + "\n");
    }), button("Close", () => d.close(), "is-primary"));
    d.append(head, tools, wrap, netsBox, footer);
    d.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); d.close(); } });
    d.addEventListener("close", () => { if (dlg === d) dlg = null; d.remove(); });
    function locate(r) {
      try {
        if (host.currentId?.() !== r.docId) host.selectDocument(r.docId);
        host.select([r.id], r.id);
        const it = host.doc().items.find(i => i.id === r.id);
        if (it && Number.isFinite(it.x)) host.centerOn?.([it.x, it.y]);
      } catch (e) { summary.textContent = e.message; }
    }
    function paint() {
      const variant = varSel.value === "__active" ? undefined : varSel.value;
      try { rep = check(host.project(), {...prefs, variant, spice}); } catch (e) { summary.textContent = e.message; tbody.replaceChildren(); return; }
      const c = rep.counts;
      summary.textContent = rep.stats.checked + " checks on " + rep.stats.parts + " parts · " + c.fail + " over rating · " + c.warn + " over derated limit · " + c.missing + " missing ratings · " + c.unknown + " not computable" +
        (rep.variant ? " · variant " + rep.variant.name : "") + (spice ? " · SPICE .op" : "") + (rep.notes.length ? " · " + rep.notes.join(" ") : "");
      tbody.replaceChildren();
      const rows = onlyIssues ? rep.rows.filter(r => r.status !== "ok" && r.status !== "unknown") : rep.rows;
      const LABEL = {ok: "OK", warn: "Over derated", fail: "Over rating", missing: "No rating", unknown: "Not computable"};
      for (const r of rows.slice(0, 3000)) {
        const tr = el("tr", null, "stress-" + r.status); tr.tabIndex = 0;
        const loc = button("Locate", () => locate(r)); loc.setAttribute("aria-label", "Locate " + r.ref);
        const act = el("td"); act.append(loc);
        tr.append(el("td", r.ref), el("td", r.value), el("td", r.check), el("td", fmtNum(r.applied, r.unit), "n"), el("td", fmtNum(r.limit, r.unit), "n"), el("td", fmtNum(r.rating, r.unit), "n"),
          el("td", r.usage == null ? "—" : Number.isFinite(r.usage) ? Math.round(r.usage) + " %" : "∞", "n"), el("td", r.worstCase ? "Over rating (worst case)" : LABEL[r.status], "stress-status"), el("td", r.basis), el("td", r.detail, "stress-detail"), act);
        tr.ondblclick = () => locate(r);
        tr.onkeydown = e => { if (e.key === "Enter") locate(r); };
        tbody.append(tr);
      }
      if (!rows.length) { const tr = el("tr"); tr.append(el("td", onlyIssues ? "No component needs attention." : "No capacitors, resistors or diodes to check.", "stress-empty", {colspan: "11"})); tbody.append(tr); }
      // Net voltages with overrides.
      netsBody.replaceChildren();
      const list = el("div", null, "stress-net-grid");
      const addNet = (name, v, source) => {
        const inp = el("input", null, "ui-field", {type: "number", step: "any", "data-numeric-unit": "V", placeholder: v == null ? "unknown" : String(v), "aria-label": "Voltage of " + name});
        if (own(prefs.voltages, name)) inp.value = String(prefs.voltages[name]);
        inp.onchange = () => { if (inp.value === "") delete prefs.voltages[name]; else prefs.voltages[name] = +inp.value; savePrefs(prefs); paint(); };
        list.append(el("span", name, "stress-net-name"), inp, el("span", source || "", "stress-unit"));
      };
      for (const [n, v] of Object.entries(rep.nets)) addNet(n, v.v, v.source);
      for (const n of rep.unknownNets.slice(0, 200)) addNet(n, null, "");
      netsBody.append(list);
    }
    paint();
    globalThis.AtriumShell.adoptDialog(d, {title, body: wrap, actions: footer, defaultAction: false});
    document.body.append(d); d.showModal();
    return d;
  }
  function install(host) {
    if (H === host) return;
    H = host;
    host.registerAction("component-stress", () => open(host));
  }
  if (typeof document !== "undefined" && globalThis.AtriumNavCommon?.ready) AtriumNavCommon.ready(install);

  return Object.freeze({DEFAULTS, check, netVoltage, parseValue, derate, capClass, headless, open, install});
})();
