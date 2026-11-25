"use strict";

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// Creepage and clearance by voltage (docs/design/net-intent.md §7 creepage, §17; phase P3). Board copper of nets
// at different voltages, against the distances a safety or spacing standard asks for them.
//
//   Working voltage per net, with its basis: a tag or signal the user confirmed (user), a power port or a
//   mains connector pin (strong), a regulator's output or feedback divider, the name (likely). Mains nets come from names (AC_L, LINE, 230VAC) and from
//   connector parts (pins L and N, or an AC inlet by its value); mains detection is a rule setting, on.
//   Required distances from the selected standard (tables below): IEC 62368-1 (default), IEC 60664-1 or
//   IPC-2221B, with the pollution degree, material group, overvoltage category and insulation (mains to other
//   circuits reinforced; mains to mains and to earth basic; other circuits functional, at basic values).
//   Clearance is the in-plane gap between the copper (DRC's own geometry, AtriumRules.kit). Creepage is a
//   path along the surface: the straight gap, unless a board cutout at least X wide (0.25 / 1.0 / 1.5 mm for
//   pollution degree 1 / 2 / 3) blocks it; the path then goes round the cutouts through their corners (the
//   first and last legs are not tested against other cutouts, so it is a lower bound). Inner layers have no
//   air: clearance is not asked there and creepage uses pollution degree 1 (a cemented joint, approximated).
//
// Two consumers, one engine (scan):
//   the rule (rules.js type "creepage", Design › Rules › Electrical › Creepage Distance, in the project rule
//     book): batch and online DRC, net pairs whose governing voltage the user confirmed (DRC reads user intent
//     only, docs/design/net-intent.md §1), at the rule's severity. drc(doc, defs, ctx) is its hook.
//   the hint (Design Insights layout.hint.creepage): the same question for voltages from names, power ports
//     and connectors, always at the hint tier, each message stating its basis ("by its name"). An isolated
//     ground domain (GND_ISO) against the main one uses the barrier part's own Creepage parameter.
//
//   AtriumCreepage.required(settings, {rms, peak, mains, insulation, surface}) -> {clearance, creepage, refs}
//   AtriumCreepage.tables   the encoded values (read-only), for tests and the Learn more text
//   AtriumCreepage.voltages(project, board) -> {of(net) -> V | null}   memoised on the project facts
//   AtriumCreepage.scan(doc, defs, {project, mode: "rule"|"hint", R?, items?, near?}) -> {findings, stats}
//   AtriumCreepage.drc(doc, defs, {geo, R, rules, flag, notes, project})   rules.js hook
//   AtriumCreepage.reach(rule?)   the largest distance a rule may ask on the boards seen so far (online DRC)
//   AtriumCreepage.install()   registers the hint with AtriumInsights (idempotent)
// DOM-free. Lazy: loaded with AtriumRules (app/lazy.js); nothing runs until a rule or the hint asks.
globalThis.AtriumCreepage = (() => {
  const G = globalThis, R = () => G.AtriumRules, X = () => G.AtriumNetIntentIndex, N = () => G.AtriumNetIntent;
  const AtriumI18n = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = AtriumI18n.define({
    "creepage.pref_help": "Check copper spacing against voltage.",
    "creepage.title": "Creepage and clearance by voltage",
    "creepage.message": "{a} and {b} are {actual} mm apart ({what}); {standard} asks {required} mm for {volts} V ({insulation}; {cond}). {basis}.",
    "creepage.what.clearance": "clearance",
    "creepage.what.creepage": "creepage along the surface",
    "creepage.ins.reinforced": "reinforced insulation",
    "creepage.ins.basic": "basic insulation",
    "creepage.ins.functional": "functional insulation, basic values",
    "creepage.ins.barrier": "across the isolation barrier",
    "creepage.barrier": "{a} and {b} are {actual} mm apart ({what}) across the isolation barrier of {ref}, rated {required} mm by its parameter. {basis}.",
    "creepage.basis": "{net}: {volts} {by}",
    "creepage.by.name": "by its name",
    "creepage.by.port": "by its power port",
    "creepage.by.pin": "by pin {pin} on {ref}",
    "creepage.by.connector": "by connector {ref}",
    "creepage.by.tag": "by tag {tag}",
    "creepage.by.signal": "by signal {name}",
    "creepage.by.assumed": "assumed 0 V (no confirmed voltage)",
    "creepage.mains": "mains",
    "creepage.why": "Copper at different voltages needs a minimum distance through air (clearance) and along the board surface (creepage), or the gap can flash over or track under dirt and humidity. Mains circuits need reinforced insulation from anything a user can touch.",
    "creepage.learn": "Hint voltages come from confirmed tags and signals, power ports, mains connectors, regulator outputs and net names. A regulator can give a nominal output voltage or a feedback-divider estimate. Each hint includes its voltage source. Distances follow the board's Creepage Distance rule (Design › Rules › Electrical), or IEC 62368-1 with pollution degree 2, material group IIIb, overvoltage category II and reinforced insulation from mains to other circuits. A wide enough cutout extends the path along the board surface. Confirmed working voltages can be checked by DRC.",
    "creepage.note.module": "Creepage checks need the rules geometry kit (AtriumRules.kit)."
  });
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const lower = s => String(s).toLowerCase();
  const r2 = v => String(Math.round(v * 100) / 100);
  const r3 = v => Math.round(v * 1000) / 1000;
  const SQRT2 = Math.SQRT2, EPS = 1e-6;

  // ------------------------------------------------------------------ tables
  // IEC 60664-1:2020 Table F.5 (Table F.4 in the 2007 edition): creepage distances to avoid failure due to
  // tracking, basic insulation, in mm, by the working voltage (V RMS, DC as is). Columns: printed wiring
  // material at pollution degree 1 and 2 (pwb1, pwb2), then pollution degree 1 (all material groups) and
  // pollution degree 2 and 3 by material group I, II, III (IIIa and IIIb share the column). IEC 62368-1
  // Table 17 lists the general columns with the same values (no printed-wiring reduction is applied under it).
  const CREEP_V = [10, 12.5, 16, 20, 25, 32, 40, 50, 63, 80, 100, 125, 160, 200, 250, 320, 400, 500, 630, 800, 1000];
  const CREEP = Object.freeze({
    pwb1: [.025, .025, .025, .025, .025, .025, .025, .025, .04, .063, .1, .16, .25, .4, .56, .75, 1, 1.3, 1.8, 2.4, 3.2],
    pwb2: [.04, .04, .04, .04, .04, .04, .04, .04, .063, .1, .16, .25, .4, .63, 1, 1.6, 2, 2.5, 3.2, 4, 5],
    pd1: [.08, .09, .1, .11, .125, .14, .16, .18, .2, .22, .25, .28, .32, .42, .56, .75, 1, 1.3, 1.8, 2.4, 3.2],
    pd2I: [.4, .42, .45, .48, .5, .53, .56, .6, .63, .67, .71, .75, .8, 1, 1.25, 1.6, 2, 2.5, 3.2, 4, 5],
    pd2II: [.4, .42, .45, .48, .5, .53, .8, .85, .9, .95, 1, 1.05, 1.1, 1.4, 1.8, 2.2, 2.8, 3.6, 4.5, 5.6, 7.1],
    pd2III: [.4, .42, .45, .48, .5, .53, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 2, 2.5, 3.2, 4, 5, 6.3, 8, 10],
    pd3I: [1, 1.05, 1.1, 1.2, 1.25, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2, 2.5, 3.2, 4, 5, 6.3, 8, 10, 12.5],
    pd3II: [1, 1.05, 1.1, 1.2, 1.25, 1.3, 1.6, 1.7, 1.8, 1.9, 2, 2.1, 2.2, 2.8, 3.6, 4.5, 5.6, 7.1, 9, 11, 14],
    pd3III: [1, 1.05, 1.1, 1.2, 1.25, 1.3, 1.8, 1.9, 2, 2.1, 2.2, 2.4, 2.5, 3.2, 4, 5, 6.3, 8, 10, 12.5, 16]
  });
  // IEC 60664-1 Table F.2, case A (inhomogeneous field): clearance in mm by the required impulse withstand
  // voltage (kV), pollution degree 1, 2, 3. IEC 62368-1 Table 14 is read as the same values (marked uncertain).
  const IMPULSE_KV = [.33, .4, .5, .6, .8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12];
  const CLEAR = Object.freeze({
    pd1: [.01, .02, .04, .06, .1, .15, .25, .5, 1, 1.5, 2, 3, 4, 5.5, 8, 11, 14],
    pd2: [.2, .2, .2, .2, .2, .2, .25, .5, 1, 1.5, 2, 3, 4, 5.5, 8, 11, 14],
    pd3: [.8, .8, .8, .8, .8, .8, .8, .8, 1, 1.5, 2, 3, 4, 5.5, 8, 11, 14]
  });
  // IEC 60664-1 Table F.1 / IEC 62368-1 Table 12: rated impulse (mains transient) voltage in V by the nominal
  // line-to-neutral voltage up to 50, 100, 150, 300, 600, 1000 V and the overvoltage category.
  const MAINS_V = [50, 100, 150, 300, 600, 1000];
  const TRANSIENT = Object.freeze({I: [330, 500, 800, 1500, 2500, 4000], II: [500, 800, 1500, 2500, 4000, 6000], III: [800, 1500, 2500, 4000, 6000, 8000], IV: [1500, 2500, 4000, 6000, 8000, 12000]});
  // The preferred series of impulse voltages (IEC 60664-1 4.2.3): reinforced clearances take the next step.
  const SERIES = [330, 500, 800, 1500, 2500, 4000, 6000, 8000, 12000];
  // IPC-2221B Table 6-1: electrical conductor spacing in mm by the voltage between conductors (DC or AC
  // peak) up to 15, 30, 50, 100, 150, 170, 250, 300, 500 V; above 500 V the 500 V value plus mm per volt
  // over 500 (marked uncertain for B1, B4, A5–A7, whose per-volt values do not continue the 500 V row).
  const IPC_V = [15, 30, 50, 100, 150, 170, 250, 300, 500];
  const IPC = Object.freeze({
    B1: [.05, .05, .1, .1, .2, .2, .2, .2, .25], B2: [.1, .1, .6, .6, .6, 1.25, 1.25, 1.25, 2.5], B3: [.1, .1, .6, 1.5, 3.2, 3.2, 6.4, 12.5, 12.5],
    B4: [.05, .05, .13, .13, .4, .4, .4, .4, .8], A5: [.13, .13, .13, .13, .4, .4, .4, .4, .8], A6: [.13, .25, .4, .5, .8, .8, .8, .8, 1.5], A7: [.13, .13, .13, .13, .4, .4, .4, .8, .8]
  });
  const IPC_PER_V = Object.freeze({B1: .0025, B2: .005, B3: .025, B4: .00305, A5: .00305, A6: .00305, A7: .00305});
  // Groove width X (IEC 60664-1 Table 2): a cutout narrower than this does not lengthen the creepage path.
  const GROOVE = [0, .25, 1, 1.5];
  const UNCERTAIN = Object.freeze([
    "IEC 62368-1 Table 17 creepage is read as IEC 60664-1 Table F.5's general columns (same values); no printed-wiring reduction is taken under IEC 62368-1.",
    "IEC 62368-1 Table 14 clearance is read as IEC 60664-1 Table F.2 case A; reinforced takes the larger of twice the basic value and the next impulse step.",
    "IPC-2221B above 500 V: the 500 V value plus the per-volt figure for the volts over 500.",
    "Above the tables (1000 V creepage, 12 kV impulse) values grow in proportion to the voltage."
  ]);
  const STANDARDS = Object.freeze({iec62368: "IEC 62368-1", iec60664: "IEC 60664-1", ipc2221b: "IPC-2221B"});
  const DEFAULTS = Object.freeze({standard: "iec62368", pollution: 2, material: "IIIb", overvoltage: "II", mainsInsulation: "reinforced", functional: "basic",
    detectMains: true, mainsVoltage: 250, threshold: 30, ipcClass: "B2", unknown: "zero"});
  const FIELDS = Object.keys(DEFAULTS);
  /** @typedef {{standard: string, pollution: number, material: string, overvoltage: string, mainsInsulation: string, functional: string, detectMains: boolean, mainsVoltage: number, threshold: number, ipcClass: string, unknown: string}} Settings */
  /** @type {(r: any) => Settings} */
  const settingsOf = r => { const s = {...DEFAULTS}; if (r) for (const k of FIELDS) if (r[k] != null) s[k] = r[k]; return s; };

  // Step lookup: the first row at or above v (conservative: the standards also allow linear interpolation);
  // beyond the last row, in proportion to the voltage.
  function step(rows, vals, v) {
    for (let i = 0; i < rows.length; i++) if (v <= rows[i] + 1e-9) return vals[i];
    return vals.at(-1) * v / rows.at(-1);
  }
  const groupOf = m => m === "I" ? "I" : m === "II" ? "II" : "III";
  // Creepage, basic insulation (mm), at the working voltage (V RMS).
  function creepageBasic(std, pd, material, rms) {
    const pwb = std === "iec60664" && pd <= 2;
    const col = pwb ? "pwb" + pd : pd === 1 ? "pd1" : "pd" + pd + groupOf(material);
    return step(CREEP_V, CREEP[col], Math.max(rms, 0));
  }
  // Clearance (mm) for an impulse withstand voltage (V).
  const clearanceFor = (pd, uw) => step(IMPULSE_KV, CLEAR["pd" + pd], uw / 1000);
  const transientOf = (ovc, mainsRms) => step(MAINS_V, TRANSIENT[ovc] || TRANSIENT.II, mainsRms);
  const nextStep = uw => { const i = SERIES.findIndex(x => x >= uw - 1e-9); return i < 0 ? uw * 1.6 : SERIES[i] === uw ? SERIES[i + 1] ?? uw * 1.6 : uw * 1.6; };
  function ipcSpacing(col, peak) {
    const c = IPC[col] ? col : "B2";
    if (peak <= 500) return step(IPC_V, IPC[c], Math.max(peak, 0));
    return IPC[c].at(-1) + (peak - 500) * IPC_PER_V[c];
  }
  // The distances one pair needs. q: {rms, peak, mains (one side is mains), insulation: basic | reinforced |
  // functional, surface: outer | inner, mainsRms?}. Functional insulation uses basic values.
  function required(settings, q) {
    const s = settingsOf(settings), std = /** @type {string} */ (STANDARDS[s.standard] ? s.standard : "iec62368"), inner = q.surface === "inner";
    if (std === "ipc2221b") {
      const col = inner ? "B1" : s.ipcClass, d = ipcSpacing(col, q.peak);
      return {clearance: inner ? 0 : d, creepage: d, refs: "IPC-2221B Table 6-1 " + col, cond: "Table 6-1, " + col};
    }
    const pd = inner ? 1 : Math.min(3, Math.max(1, +s.pollution || 2)), reinforced = q.insulation === "reinforced";
    let creep = creepageBasic(std, pd, s.material, q.rms);
    if (reinforced) creep *= 2;
    let clear = 0;
    if (!inner) {
      const uw = Math.max(q.mains ? transientOf(s.overvoltage, q.mainsRms ?? q.rms) : 0, q.peak, SERIES[0]);
      const basic = clearanceFor(pd, uw);
      clear = !reinforced ? basic : std === "iec60664" ? clearanceFor(pd, nextStep(uw)) : Math.max(2 * basic, clearanceFor(pd, nextStep(uw)));
    }
    creep = Math.max(creep, clear); // creepage is never less than the clearance (IEC 60664-1 5.2.2.1, IEC 62368-1 5.4.3)
    const t17 = std === "iec60664" ? "Table F.5" : "Table 17", t14 = std === "iec60664" ? "Table F.2" : "Table 14";
    const cond = inner ? t17 + ", inner layer at pollution degree 1" : t17 + " and " + t14 + ", pollution degree " + pd + ", material group " + s.material + (q.mains ? ", overvoltage category " + s.overvoltage : "");
    return {clearance: r3(clear), creepage: r3(creep), refs: STANDARDS[std] + " " + cond, cond};
  }
  const tables = Object.freeze({CREEP_V, CREEP, IMPULSE_KV, CLEAR, MAINS_V, TRANSIENT, SERIES, IPC_V, IPC, IPC_PER_V, GROOVE, UNCERTAIN, STANDARDS, DEFAULTS,
    creepageBasic, clearanceFor, transientOf, ipcSpacing, nextStep});

  // ------------------------------------------------------------------ voltages
  // V = {dc, ac, mains, ground, earth, domain, iso, level: user | strong | likely, basis: text}
  const VOLT = /^\s*([+-]?\d+(?:[.,]\d+)?)\s*(k)?\s*V?\s*(AC|DC|RMS)?\s*$/i;
  /** @typedef {{dc?: number | null, ac?: number | null, mains?: boolean, ground?: boolean, earth?: boolean, domain?: string, iso?: boolean, line?: string, level?: string, basis?: string, assumed?: boolean}} Volts */
  /** @param {any} v @returns {Volts | null} */
  function parseVolts(v) {
    if (typeof v === "number" && Number.isFinite(v)) return {dc: v};
    const m = VOLT.exec(String(v ?? ""));
    if (!m) return null;
    const n = +m[1].replace(",", ".") * (m[2] ? 1000 : 1), ac = /AC|RMS/i.test(m[3] || "");
    return ac ? {ac: Math.abs(n), mains: Math.abs(n) >= 100} : {dc: n};
  }
  const paramOf = (o, names) => { if (plain(o)) for (const [k, v] of Object.entries(o)) if (names.includes(lower(k).replace(/[^a-z0-9]/g, "")) && typeof v !== "object") return v; return null; };
  const VOLT_KEYS = ["voltage", "workingvoltage", "volts", "v"];
  /** @param {any} r @returns {Volts | null} */
  function fromReading(r) {
    if (!r) return null;
    if (r.role === "ground") { const earth = /^(?:PE|C|EARTH|CHASSIS)(?:_?\d+)?$/i.test(r.domain || ""); return {dc: 0, ground: true, earth, domain: r.domain || "", iso: !!r.isolated}; }
    if (r.role === "mains") { const v = Number.isFinite(r.voltage) ? Math.abs(r.voltage) : null; return v != null && v < 100 ? {ac: v} : {ac: v, mains: true, line: r.part || "line"}; }
    if (r.role === "rail") {
      const v = Number.isFinite(r.voltage) ? r.voltage : Number.isFinite(r.nominal) ? r.nominal : null;
      if (v == null) return null;
      return {dc: v, domain: /ISO/i.test(r.variant || "") ? "ISO" : "", iso: /ISO/i.test(r.variant || "")};
    }
    return null;
  }
  const CONNECTOR = /^(?:J|CN|CON|X|XS|TB|PL|SK|K)\d/i;
  const LINE_PIN = /^(?:L|L1|LINE|AC_?L|ACL|PHASE|~1|AC1)$/i, NEUTRAL_PIN = /^(?:N|NEUTRAL|AC_?N|ACN|~2|AC2)$/i, EARTH_PIN = /^(?:PE|E|EARTH|GND|PG|PROTECTIVE ?EARTH|⏚)$/i;
  const INLET = /mains|IEC ?60320|\bC1[3-6]\b|\bC[5-8]\b|AC ?inlet|power ?entry|schuko|NEMA ?[15]-|230 ?V ?AC|240 ?V ?AC|120 ?V ?AC/i;
  // Mains connector pins: a connector with pins named L and N, or a mains inlet by its value or library name.
  function mainsPins(F, defs) {
    const parts = new Map();
    const add = p => { if (!p?.part || !p.net || !CONNECTOR.test(p.ref || "")) return; let a = parts.get(p.part); if (!a) parts.set(p.part, a = []); a.push(p); };
    for (const list of F.pins.values()) for (const p of list) add(p);
    for (const list of F.boardPins.values()) for (const p of list) add(p);
    const out = new Map();
    for (const [part, pins] of parts) {
      const hasL = pins.some(p => LINE_PIN.test(p.name || "")), hasN = pins.some(p => NEUTRAL_PIN.test(p.name || ""));
      const def = defs?.get?.(part.def), text = [part.value, part.description, part.parameters?.Description, def?.name, def?.description].filter(x => typeof x === "string").join(" ");
      const inlet = INLET.test(text);
      if (!(hasL && hasN) && !inlet) continue;
      for (const p of pins) {
        if (out.has(p.net)) continue;
        const name = String(p.name || ""), by = name && !/^\d+$/.test(name) ? t("creepage.by.pin", {pin: name, ref: p.ref}) : t("creepage.by.connector", {ref: p.ref});
        if (EARTH_PIN.test(name)) out.set(p.net, {dc: 0, ground: true, earth: true, domain: "PE", iso: false, level: "strong", basis: by});
        else if (hasL && hasN ? LINE_PIN.test(name) || NEUTRAL_PIN.test(name) : true) out.set(p.net, {ac: null, mains: true, line: NEUTRAL_PIN.test(name) ? "neutral" : "line", level: "strong", basis: by});
      }
    }
    return out;
  }
  const RATING = ["creepage", "ratedcreepage", "creepagedistance", "externalcreepage", "cpg", "isolationcreepage", "creepagemm"], CLEARANCE_P = ["clearance", "ratedclearance", "clr", "externalclearance", "isolationclearance"];
  const mm = v => { const m = /^\s*(\d+(?:[.,]\d+)?)\s*(mm|mil)?/i.exec(String(v ?? "")); return m ? +m[1].replace(",", ".") * (/mil/i.test(m[2] || "") ? .0254 : 1) : null; };
  // Isolation barrier parts: three or more pins, on grounds of two domains, one of them isolated.
  function barriersOf(F, read, defs) {
    const parts = new Map();
    for (const [net, list] of F.pins) for (const p of list) { let a = parts.get(p.part); if (!a) parts.set(p.part, a = {ref: p.ref, nets: new Set(), pins: 0, doc: p.doc, at: p.at}); a.nets.add(net); a.pins++; }
    for (const [net, list] of F.boardPins) for (const p of list) { let a = parts.get(p.part); if (!a) parts.set(p.part, a = {ref: p.ref, nets: new Set(), pins: 0, board: true}); a.nets.add(net); a.pins++; }
    const out = [];
    for (const [part, e] of parts) {
      if (e.pins < 3) continue;
      const grounds = [...e.nets].map(n => [n, read(n)]).filter(([, r]) => r.role === "ground");
      const doms = new Map();
      for (const [n, r] of grounds) { const k = r.isolated ? "ISO:" + (r.domain || "ISO") : "MAIN"; if (!doms.has(k)) doms.set(k, n); }
      if (doms.size < 2 || ![...doms.keys()].some(k => k.startsWith("ISO"))) continue;
      const def = defs?.get?.(part.def), creep = mm(paramOf(part.parameters, RATING) ?? paramOf(def?.parameters, RATING)), clear = mm(paramOf(part.parameters, CLEARANCE_P) ?? paramOf(def?.parameters, CLEARANCE_P));
      out.push({part, ref: e.ref, domains: [...doms.keys()], grounds: [...doms.values()], creepage: creep, clearance: clear, doc: e.doc, at: e.at, board: !!e.board});
    }
    return out;
  }
  const vMemo = new WeakMap();
  let lastMax = 0;
  function voltages(project, board, defs) {
    const Xi = X(), F = Xi.facts(project || {documents: [board], library: []}, defs), conv = Xi.conventions(project, F).effective;
    let M = null;
    try { M = board && G.AtriumSignals?.model?.(project, board) || null; } catch { M = null; }
    const key = project || board, old = key && vMemo.get(key);
    if (old && old.board === board && old.F === F && old.conv === conv && old.M === M) return old.out;
    defs ||= F.defs;
    const read = n => Xi.classify(n, conv);
    let pins = null, sources = null, barriers = null;
    const regulators = () => sources ||= Xi.regulatorVoltages(F, conv, board);
    const tagMeta = new Map((M?.store?.tags || []).map(x => [lower(x.name), x]));
    const cache = new Map();
    function user(net) {
      if (!M) return null;
      for (const tag of M.tagNames(net)) {
        const meta = tagMeta.get(lower(tag)), by = t("creepage.by.tag", {tag});
        const pv = paramOf(meta?.params, VOLT_KEYS), pm = paramOf(meta?.params, ["mains"]);
        /** @type {Volts | null} */
        let v = pv != null ? parseVolts(pv) : null;
        if (pm === true || /^(?:yes|true|1)$/i.test(String(pm ?? ""))) v = {...(v || {}), ac: v?.ac ?? null, mains: true};
        if (!v) v = fromReading(N().read(tag));
        if (v) return {...v, level: "user", basis: by};
      }
      const sig = M.signalOf(net), decl = sig && M.byId.get(sig.id)?.decl;
      if (decl) {
        const by = t("creepage.by.signal", {name: decl.name}), pv = paramOf(decl.params, VOLT_KEYS);
        if (pv != null) { const v = parseVolts(pv); if (v) return {...v, level: "user", basis: by}; }
        const it = plain(decl.intent) ? decl.intent : null;
        if (it?.confirmed && (it.role === "rail" && Number.isFinite(it.voltage) || it.role === "ground" || it.role === "mains")) {
          const v = it.role === "ground" ? {dc: 0, ground: true, domain: it.domain || "", iso: /ISO/i.test(it.domain || "")} : it.role === "mains" ? {ac: Number.isFinite(it.voltage) ? it.voltage : null, mains: true} : {dc: it.voltage};
          return {...v, level: "user", basis: by};
        }
      }
      return null;
    }
    function of(net) {
      if (!net) return null;
      if (cache.has(net)) return cache.get(net);
      /** @type {Volts | null} */
      let v = user(net);
      if (!v) {
        const r = read(net), base = fromReading(r), e = F.names.get(net);
        pins ||= mainsPins(F, defs);
        v = pins.get(net) || null;
        if (!v && !base?.ground && !base?.mains) {
          const evidence = regulators().get(net);
          if (evidence) {
            if (Xi.regulatorMatchesName(r, evidence)) v = {dc: evidence.voltage, level: evidence.level, basis: evidence.basis, domain: evidence.domain, iso: evidence.isolated};
            else { cache.set(net, null); return null; }
          }
        }
        if (!v && base) v = {...base, level: e?.power && (base.ground || Number.isFinite(base.dc)) ? "strong" : "likely", basis: e?.power ? t("creepage.by.port") : t("creepage.by.name")};
      }
      cache.set(net, v || null);
      if (v) lastMax = Math.max(lastMax, Math.abs(v.dc || 0) + (v.ac || 0));
      return v || null;
    }
    const out = {of, read, F, regulators, barriers: () => barriers ||= barriersOf(F, read, defs)};
    if (key) vMemo.set(key, {board, F, conv, M, out});
    return out;
  }
  // A regulator edit can change the result far beyond its own copper (or on a different
  // document). Only this check loses its area-scan shortcut when that evidence changes.
  function voltageStamp(project, board, defs) {
    const V = voltages(project, board, defs), sources = [...V.regulators()]
      .filter(([, e]) => e)
      .map(([net, e]) => JSON.stringify([net, e.voltage, e.level, e.basis, e.returnNet, e.domain, e.isolated]));
    return sources.sort().join("\n");
  }

  // ------------------------------------------------------------------ pairs
  const volts = v => Math.abs(v.dc || 0) + (v.ac || 0);
  const rank = v => v ? (v.mains ? 1e6 : 0) + volts(v) + (v.iso ? .5 : 0) : -1;
  const netsOf = i => i?.kind === "part" ? Object.values(i.pinNets || {}).filter(Boolean) : i?.net ? [i.net] : [];
  // The working voltage between two nets and the insulation it needs, or null (not checked).
  function pairOf(a, b, s) {
    if (!a || !b) return null;
    const ma = a.mains && s.detectMains, mb = b.mains && s.detectMains;
    if (a.mains && !s.detectMains || b.mains && !s.detectMains) return null;
    // Different isolation domains: no common reference (the barrier part's rating applies instead).
    if (!ma && !mb && !!a.iso !== !!b.iso) return {barrier: true};
    if (!ma && !mb && a.iso && b.iso && a.domain && b.domain && a.domain !== b.domain && a.domain !== "ISO" && b.domain !== "ISO") return null;
    if (a.ground && b.ground) return null;
    const acOf = v => v.mains ? v.ac ?? s.mainsVoltage : v.ac || 0;
    if (ma && mb) { const rms = Math.max(acOf(a), acOf(b)); return {rms, peak: rms * SQRT2, mains: true, mainsRms: rms, insulation: "basic", kind: "mains"}; }
    if (ma || mb) {
      const m = ma ? a : b, o = ma ? b : a, ac = acOf(m), rms = ac + Math.abs(o.dc || 0) + (o.ac || 0);
      return {rms, peak: ac * SQRT2 + Math.abs(o.dc || 0) + (o.ac || 0) * SQRT2, mains: true, mainsRms: ac, insulation: o.earth ? "basic" : s.mainsInsulation, kind: "mains"};
    }
    const dv = Math.abs((a.dc || 0) - (b.dc || 0)), ac = (a.ac || 0) + (b.ac || 0), rms = dv + ac;
    if (rms + EPS < s.threshold || s.functional === "off") return null;
    return {rms, peak: dv + ac * SQRT2, mains: false, insulation: "functional", kind: "dc"};
  }
  const insulationText = k => k === "reinforced" ? t("creepage.ins.reinforced") : k === "basic" ? t("creepage.ins.basic") : k === "barrier" ? t("creepage.ins.barrier") : t("creepage.ins.functional");

  // ------------------------------------------------------------------ geometry
  // Poured regions as features: rings from AtriumPCBPours.contours, an edge grid for neighbour queries.
  function edgeGrid(rings, cell) {
    const m = new Map(), key = (x, y) => x * 73856093 ^ y * 19349663;
    for (let r = 0; r < rings.length; r++) {
      const ring = rings[r], n = ring.length >> 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, x0 = Math.min(ring[2 * i], ring[2 * j]), x1 = Math.max(ring[2 * i], ring[2 * j]), y0 = Math.min(ring[2 * i + 1], ring[2 * j + 1]), y1 = Math.max(ring[2 * i + 1], ring[2 * j + 1]);
        for (let x = Math.floor(x0 / cell); x <= Math.floor(x1 / cell); x++) for (let y = Math.floor(y0 / cell); y <= Math.floor(y1 / cell); y++) { const k = key(x, y); let l = m.get(k); if (!l) m.set(k, l = []); l.push(r, i); }
      }
    }
    return {query(b, fn) {
      const seen = new Set();
      for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++) for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++) {
        const l = m.get(key(x, y)); if (!l) continue;
        for (let k = 0; k < l.length; k += 2) { const id = l[k] * 1e7 + l[k + 1]; if (!seen.has(id)) { seen.add(id); fn(l[k], l[k + 1]); } }
      }
    }};
  }
  function inRings(x, y, rings) {
    let c = false;
    for (const ring of rings) { const n = ring.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) { const xi = ring[2 * i], yi = ring[2 * i + 1], xj = ring[2 * j], yj = ring[2 * j + 1]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; } }
    return c;
  }
  function regionFeatures(doc, K, keep) {
    const P = G.AtriumPCBPours, out = [];
    if (!P?.contours) return out;
    const polys = new Map(doc.items.filter(i => i.kind === "polygon").map(i => [i.id, i]));
    for (const region of doc.pcbDrawing?.pours || []) {
      if (!region?.net || !region.count || !keep(region)) continue;
      const idx = K.copperIndex(region.layer); if (idx == null) continue;
      let rings; try { rings = P.contours(region); } catch { continue; }
      if (!rings?.length) continue;
      const id = region.polygon ?? null, name = polys.get(region.polygon)?.name || region.net;
      out.push({region: true, rings, grid: null, net: region.net, span: [idx, idx], id, label: "Poured copper " + name + " (" + region.layer + ")", box: region.bounds.slice(), kind: "polygon", ck: "poly", layer: region.layer});
    }
    return out;
  }
  const gridOf = f => f.grid ||= edgeGrid(f.rings, 2);
  // Closest points between two features, either of which may be a poured region: {d, pa, pb}.
  function closest(a, b, need, K) {
    if (a.region && !b.region) { const c = closest(b, a, need, K); return {d: c.d, pa: c.pb, pb: c.pa}; }
    let best = {d: Infinity, pa: null, pb: null};
    const segTo = (edges, rad, box, rg) => rg.grid.query(box, (r, i) => {
      const ring = rg.rings[r], n = ring.length >> 1, j = (i + 1) % n, u = [ring[2 * i], ring[2 * i + 1]], v = [ring[2 * j], ring[2 * j + 1]];
      for (const [s, e] of edges) { const c = K.closestSegments(s, e, u, v), d = Math.max(0, c.d - rad); if (d < best.d) best = {d, pa: shift(c.pa, c.pb, rad), pb: c.pb}; }
    });
    if (b.region && a.region) {
      gridOf(b);
      const p0 = [a.rings[0][0], a.rings[0][1]], q0 = [b.rings[0][0], b.rings[0][1]];
      if (inRings(p0[0], p0[1], b.rings)) return {d: 0, pa: p0, pb: p0};
      if (inRings(q0[0], q0[1], a.rings)) return {d: 0, pa: q0, pb: q0};
      for (const ed of ringEdges(a, b.box, need)) segTo([ed], 0, [Math.min(ed[0][0], ed[1][0]) - need, Math.min(ed[0][1], ed[1][1]) - need, Math.max(ed[0][0], ed[1][0]) + need, Math.max(ed[0][1], ed[1][1]) + need], b);
      return best;
    }
    if (b.region) {
      gridOf(b);
      for (const p of a.pieces || [a]) {
        if (inRings(p.core[0][0], p.core[0][1], b.rings)) return {d: 0, pa: p.core[0], pb: p.core[0]};
        if (p.core.length > 2 && K.containsConvex([b.rings[0][0], b.rings[0][1]], p.core)) { const q = [b.rings[0][0], b.rings[0][1]]; return {d: 0, pa: q, pb: q}; }
        segTo(p.edges, p.radius, [p.box[0] - need, p.box[1] - need, p.box[2] + need, p.box[3] + need], b);
      }
      return best;
    }
    for (const p of a.pieces || [a]) for (const q of b.pieces || [b]) {
      if (p.box[0] - q.box[2] >= need || q.box[0] - p.box[2] >= need || p.box[1] - q.box[3] >= need || q.box[1] - p.box[3] >= need) continue;
      if (K.containsConvex(p.core[0], q.core)) return {d: 0, pa: p.core[0], pb: p.core[0]};
      if (K.containsConvex(q.core[0], p.core)) return {d: 0, pa: q.core[0], pb: q.core[0]};
      for (const [s, e] of p.edges) for (const [u, v] of q.edges) {
        const c = K.closestSegments(s, e, u, v), d = Math.max(0, c.d - p.radius - q.radius);
        if (d < best.d) best = {d, pa: shift(c.pa, c.pb, p.radius), pb: shift(c.pb, c.pa, q.radius)};
      }
    }
    return best;
  }
  // Edges of a region's rings near a box (region against region).
  function ringEdges(f, box, need) {
    const out = [], b = [box[0] - need, box[1] - need, box[2] + need, box[3] + need];
    for (const ring of f.rings) { const n = ring.length >> 1; for (let i = 0; i < n; i++) { const j = (i + 1) % n, u = [ring[2 * i], ring[2 * i + 1]], v = [ring[2 * j], ring[2 * j + 1]];
      if (Math.max(u[0], v[0]) < b[0] || Math.min(u[0], v[0]) > b[2] || Math.max(u[1], v[1]) < b[1] || Math.min(u[1], v[1]) > b[3]) continue; out.push([u, v]); } }
    return out;
  }
  function shift(p, toward, r) {
    if (!r) return p;
    const dx = toward[0] - p[0], dy = toward[1] - p[1], l = Math.hypot(dx, dy);
    return l > EPS ? [p[0] + dx / l * Math.min(r, l), p[1] + dy / l * Math.min(r, l)] : p;
  }
  // Board cutouts that lengthen the creepage path: polygons at least the groove width X wide.
  function slotsOf(doc, x) {
    let holes = [];
    try { holes = (G.AtriumBoardShape?.holes?.(doc) || []).filter(h => h.length >= 3); } catch { holes = []; }
    const out = [];
    for (const h of holes) {
      const pts = h.length > 64 ? hull(h) : h.map(p => [p[0], p[1]]);
      if (widthOf(hull(h)) + EPS < x) continue;
      let b = [Infinity, Infinity, -Infinity, -Infinity];
      for (const p of pts) b = [Math.min(b[0], p[0]), Math.min(b[1], p[1]), Math.max(b[2], p[0]), Math.max(b[3], p[1])];
      out.push({pts, box: b});
    }
    return out;
  }
  function hull(points) {
    const p = points.map(q => [q[0], q[1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (p.length < 3) return p;
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]), lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.slice().reverse()) { while (up.length >= 2 && cr(up.at(-2), up.at(-1), q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  // Minimum width of a convex polygon (rotating calipers, by edge).
  function widthOf(h) {
    let w = Infinity;
    for (let i = 0; i < h.length; i++) {
      const a = h[i], b = h[(i + 1) % h.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l < EPS) continue;
      let m = 0; for (const p of h) m = Math.max(m, Math.abs((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / l);
      w = Math.min(w, m);
    }
    return w;
  }
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const proper = (p, q, r, s) => { const o1 = cross(p, q, r), o2 = cross(p, q, s), o3 = cross(r, s, p), o4 = cross(r, s, q); return o1 * o2 < -1e-12 && o3 * o4 < -1e-12; };
  const insidePts = globalThis.AtriumGeometry.inRing;
  function blocked(p, q, slots) {
    const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
    for (const s of slots) {
      if (Math.max(p[0], q[0]) < s.box[0] || Math.min(p[0], q[0]) > s.box[2] || Math.max(p[1], q[1]) < s.box[1] || Math.min(p[1], q[1]) > s.box[3]) continue;
      if (insidePts(mid, s.pts)) return true;
      for (let i = 0; i < s.pts.length; i++) if (proper(p, q, s.pts[i], s.pts[(i + 1) % s.pts.length])) return true;
    }
    return false;
  }
  // Distance from a feature (or region) to a point.
  function toPoint(f, p, K) { const pt = {core: [p], edges: [[p, p]], radius: 0, box: [p[0], p[1], p[0], p[1]]}; return closest(f, pt, Infinity, K).d; }
  // The surface path between two features around the slots in the way (Dijkstra through slot corners).
  function surfacePath(a, b, c, slots, K) {
    if (!slots.length || !c.pa || !blocked(c.pa, c.pb, slots)) return c.d;
    const nodes = [];
    for (const s of slots) for (const p of s.pts) nodes.push(p);
    if (nodes.length > 256) return c.d;
    const n = nodes.length, dist = new Array(n).fill(Infinity), done = new Array(n).fill(false);
    // Corners are reached from a straight leg off each feature (not itself tested for other cutouts).
    for (let i = 0; i < n; i++) dist[i] = toPoint(a, nodes[i], K);
    let best = Infinity;
    for (;;) {
      let u = -1; for (let i = 0; i < n; i++) if (!done[i] && dist[i] < Infinity && (u < 0 || dist[i] < dist[u])) u = i;
      if (u < 0 || dist[u] >= best) break;
      done[u] = true;
      best = Math.min(best, dist[u] + toPoint(b, nodes[u], K));
      for (let v = 0; v < n; v++) {
        if (done[v]) continue;
        const p = nodes[u], q = nodes[v], l = Math.hypot(q[0] - p[0], q[1] - p[1]);
        if (dist[u] + l >= dist[v]) continue;
        // Shrink the chord a little so a shared corner or edge does not count as crossing.
        const e = 1e-6, pp = [p[0] + (q[0] - p[0]) * e, p[1] + (q[1] - p[1]) * e], qq = [q[0] + (p[0] - q[0]) * e, q[1] + (p[1] - q[1]) * e];
        if (!blocked(pp, qq, slots)) dist[v] = dist[u] + l;
      }
    }
    return Math.max(c.d, best);
  }

  // ------------------------------------------------------------------ the scan
  let stats = {runs: 0, features: 0, pairs: 0, measured: 0, ms: 0};
  const now = () => G.performance?.now?.() ?? Date.now();
  const surfaceOf = (a, b) => {
    if (a.span[1] < b.span[0] || b.span[1] < a.span[0]) return null;
    return a.span[0] === 0 && b.span[0] === 0 || a.span[1] === 127 && b.span[1] === 127 ? "outer" : "inner";
  };
  // The rule that applies to a pair (rule mode), else the board's first creepage rule's settings (hint mode).
  function ruleFor(C, a, b) { try { return C?.pair?.("creepage", a, b) || null; } catch { return null; } }
  function projectFor(doc, project) {
    if (project?.documents?.some(d => d === doc || d.id === doc.id)) return project;
    const S = G.AtriumSignals, p = S?.projectOf?.(doc);
    if (p) return p;
    try { const h = G.AtriumNavHost?.project?.(); if (h?.documents?.some(d => d.id === doc.id)) return h; } catch { /* headless */ }
    return null;
  }
  // o: {project, mode: "rule" | "hint", C (compiled rules; rule mode), geo?, items? (only pairs touching these
  // items' features), near? (boxes: also features there), limit?}
  function scan(doc, defs, o = {}) {
    const t0 = now(), K = R()?.kit, out = [];
    if (!K || doc?.kind !== "pcb") return {findings: out, stats: {pairs: 0, features: 0}, note: K ? null : t("creepage.note.module")};
    const project = projectFor(doc, o.project), board = project?.documents?.find(d => d.id === doc.id) || doc;
    const V = voltages(project, board, defs), mode = o.mode || "hint";
    let C = o.C || null;
    if (!C) { try { C = K.compile(K.migrate(R().stored?.(board, project) ?? null), {doc: board, project}); } catch { C = null; } }
    const rules = C?.byType?.creepage || [], base = settingsOf(rules[0]);
    if (mode === "rule" && !rules.length) return {findings: out, stats: {pairs: 0, features: 0}};
    // The voltage a mode may use for a net: the rule reads confirmed (user) voltages, grounds, and nets without
    // one as 0 V (unless the rule says not checked); the hint reads every basis and skips nets without one.
    const eff = new Map();
    const usable = (net, s) => {
      const k = net + "\u0001" + (s ? s.unknown : "");
      if (eff.has(k)) return eff.get(k);
      const v = V.of(net);
      let u = null;
      if (mode === "hint") u = v;
      else if (v?.level === "user") u = v;
      else if (v?.ground) u = {...v, level: v.level, basis: v.basis};
      else if (!s || s.unknown !== "skip") u = {dc: 0, assumed: true, level: "user", basis: t("creepage.by.assumed")};
      eff.set(k, u);
      return u;
    };
    // Only objects on nets with a usable voltage are measured (a hint skips the rest); none high: nothing to do.
    const isHighV = v => !!v && !v.assumed && (v.mains || volts(v) * 2 + EPS >= base.threshold || v.iso);
    let geo = o.geo;
    if (!geo) {
      const items = (o.partners || doc.items).filter(i => netsOf(i).some(n => usable(n, base)));
      if (!items.some(i => netsOf(i).some(n => isHighV(usable(n, base)))) && !(doc.pcbDrawing?.pours || []).some(r => isHighV(usable(r.net, base)))) {
        stats = {...stats, runs: stats.runs + 1, ms: now() - t0, last: {pairs: 0, measured: 0, features: 0, high: 0}};
        return {findings: out, stats: {pairs: 0, features: 0, high: 0}};
      }
      geo = K.extract({...doc, items}, defs);
    }
    let F = geo.copper.filter(f => f.net);
    // Poured copper (Waffle polygon pours) near the window.
    const grown = (list, m) => list && list.map(b => [b[0] - m, b[1] - m, b[2] + m, b[3] + m]), wide = grown(o.near, o.reach || 0);
    F = F.concat(regionFeatures(doc, K, r => !wide || wide.some(b => r.bounds && r.bounds[0] <= b[2] && r.bounds[2] >= b[0] && r.bounds[1] <= b[3] && r.bounds[3] >= b[1])));
    // High nets: mains, or half the threshold or more (two rails of opposite sign can still differ by it); an
    // isolated domain when a barrier part states its creepage (hint).
    const barriers = V.barriers(), rated = mode === "hint" && barriers.some(b => b.creepage);
    const known = F.filter(f => usable(f.net, base));
    const isHigh = f => { const v = usable(f.net, base); return !v.assumed && (v.mains || volts(v) * 2 + EPS >= base.threshold || rated && v.iso); };
    const high = new Set(known.filter(isHigh));
    if (!high.size) { stats = {...stats, runs: stats.runs + 1, features: known.length, ms: now() - t0, last: {pairs: 0, measured: 0, features: known.length, high: 0}}; return {findings: out, stats: {pairs: 0, features: known.length, high: 0}}; }
    // Reach: the largest distance any pair can ask.
    const reach = reachOf([...high].map(f => usable(f.net, base)), known.map(f => usable(f.net, base)), rules.length ? rules : [base], barriers);
    // A window (an edit): pairs whose features meet it, grown by half the reach (a finding sits midway).
    const win = grown(o.near, reach / 2);
    // Which features start a pair: all (full scan), or those of the given items and in the window. Partners
    // come from a grid of the high features (full scan) or of every known feature (window: a high feature
    // in the window pairs with low ones outside it).
    // A changed object's features pair with anything in reach; others in the window only with each other (an
    // unchanged pair's finding is kept unless it sits in the window).
    const touch = o.items ? new Set(o.dirty ? [...o.dirty] : o.items.map(i => i.id)) : null, inWin = f => !!win && win.some(b => f.box[0] <= b[2] && f.box[2] >= b[0] && f.box[1] <= b[3] && f.box[3] >= b[1]);
    const local = new Set(touch ? known.filter(inWin) : []);
    const starts = touch ? known.filter(f => touch.has(f.id) || local.has(f)) : known, partners = touch ? known : [...high];
    const index = new Map(known.map((f, k) => [f, k])), nK = known.length;
    const cell = Math.max(2, reach), grid = new Map(), gk = (x, y) => x * 73856093 ^ y * 19349663;
    for (const f of partners) { const k = index.get(f); for (let x = Math.floor(f.box[0] / cell); x <= Math.floor(f.box[2] / cell); x++) for (let y = Math.floor(f.box[1] / cell); y <= Math.floor(f.box[3] / cell); y++) { const c = gk(x, y); let l = grid.get(c); if (!l) grid.set(c, l = []); l.push(k); } }
    const ties = G.AtriumNetTies?.drcTies?.(doc, defs) || null, reqMemo = new Map(), slotMemo = new Map(), best = new Map(), visited = new Set();
    let pairs = 0, measured = 0;
    const slots = pd => { if (!slotMemo.has(pd)) slotMemo.set(pd, slotsOf(board, GROOVE[pd] || 1)); return slotMemo.get(pd); };
    const userHigh = v => !!v && v.level === "user" && !v.assumed && !v.ground;
    for (const f of starts) {
      const fk = index.get(f), fh = high.has(f), fd = !touch || touch.has(f.id);
      for (let x = Math.floor((f.box[0] - reach) / cell); x <= Math.floor((f.box[2] + reach) / cell); x++) for (let y = Math.floor((f.box[1] - reach) / cell); y <= Math.floor((f.box[3] + reach) / cell); y++) {
        for (const hk of grid.get(gk(x, y)) || []) {
          const h = known[hk];
          if (h === f || !fh && !high.has(h) || h.net === f.net || !fd && !local.has(h) && !touch.has(h.id)) continue;
          const pid = Math.min(fk, hk) * nK + Math.max(fk, hk);
          if (visited.has(pid)) continue;
          visited.add(pid);
          if (ties && !f.region && !h.region && ties.skip(f, h)) continue;
          const surface = surfaceOf(f, h); if (!surface) continue;
          const key = [f.net, h.net].sort().join("\u0001") + "|" + surface;
          let q = reqMemo.get(key);
          if (q === undefined) {
            q = null;
            // The rule for the pair (rule mode: none, nothing to check); a hint stays quiet where a rule checks
            // the pair with a confirmed voltage, and otherwise uses the matching (else the first) rule's settings.
            const rule = ruleFor(C, f, h), s = settingsOf(rule || rules[0]);
            const va = usable(f.net, s), vb = usable(h.net, s);
            const ok = va && vb && (mode === "rule" ? !!rule && (userHigh(va) || userHigh(vb)) : !(rule && (userHigh(V.of(f.net)) || userHigh(V.of(h.net)))));
            const p = ok ? pairOf(va, vb, s) : null;
            if (p?.barrier) {
              const bar = mode === "hint" ? barrierFor(barriers, va, vb, f.net, h.net) : null;
              if (bar?.creepage) q = {pair: {kind: "barrier", rms: 0, mains: false, insulation: "barrier"}, req: {clearance: surface === "inner" ? 0 : bar.clearance ?? bar.creepage, creepage: bar.creepage, refs: bar.ref}, s, bar, rule, v: new Map([[f.net, va], [h.net, vb]])};
            } else if (p) q = {pair: p, req: required(s, {...p, surface}), s, rule, v: new Map([[f.net, va], [h.net, vb]])};
            reqMemo.set(key, q);
          }
          if (!q) continue;
          pairs++;
          const need = Math.max(q.req.clearance, q.req.creepage);
          if (f.box[0] - h.box[2] >= need || h.box[0] - f.box[2] >= need || f.box[1] - h.box[3] >= need || h.box[1] - f.box[3] >= need) continue;
          measured++;
          const c = closest(f, h, need, K);
          if (!(c.d + EPS < need)) continue;
          // Creepage first (it is never less than the clearance); a slot can lengthen it, never the clearance.
          let kind = null, actual = c.d, req = 0;
          const pd = surface === "inner" ? 1 : Math.min(3, Math.max(1, +q.s.pollution || 2));
          const path = surface === "outer" && q.s.standard !== "ipc2221b" ? surfacePath(f, h, c, slots(pd), K) : c.d;
          if (path + EPS < q.req.creepage) { kind = "creepage"; req = q.req.creepage; actual = path; }
          else if (c.d + EPS < q.req.clearance) { kind = "clearance"; req = q.req.clearance; }
          if (!kind) continue;
          const delta = rank(q.v.get(h.net)) - rank(q.v.get(f.net));
          const swap = delta > 0 || delta === 0 && h.net < f.net, A1 = swap ? h : f, B1 = swap ? f : h;
          const pk = [A1.id ?? "", B1.id ?? "", A1.net, B1.net].join("\u0001") + "|" + kind, prev = best.get(pk);
          if (prev && prev.actual <= actual) continue;
          best.set(pk, {a: A1, b: B1, kind, actual: r3(actual), required: r3(req), pair: q.pair, req: q.req, settings: q.s, rule: q.rule, bar: q.bar || null, surface, va: q.v.get(A1.net), vb: q.v.get(B1.net),
            at: c.pa && c.pb ? [(c.pa[0] + c.pb[0]) / 2, (c.pa[1] + c.pb[1]) / 2] : f.at || h.at || [f.box[0], f.box[1]], line: c.pa && c.pb ? (swap ? [c.pb, c.pa] : [c.pa, c.pb]) : null});
        }
      }
    }
    for (const x of best.values()) { if (o.limit && out.length >= o.limit) break; out.push(x); }
    stats = {runs: stats.runs + 1, features: known.length, pairs: stats.pairs + pairs, measured: stats.measured + measured, ms: now() - t0, last: {pairs, measured, features: known.length, high: high.size}};
    return {findings: out, stats: {pairs, measured, features: known.length, high: high.size, reach}};
  }
  // A barrier part between the isolated domain and the other side of a pair, with its rating.
  function barrierFor(list, va, vb, na, nb) {
    const iso = va.iso ? va : vb, isoNet = va.iso ? na : nb;
    for (const b of list) {
      if (!b.creepage) continue;
      const isoDom = b.domains.find(d => d.startsWith("ISO"));
      if (iso.ground ? isoDom === "ISO:" + (iso.domain || "ISO") || b.grounds.includes(isoNet) : true) return b;
    }
    return null;
  }
  // The largest distance any pair can ask: the highest net against the farthest voltage of the other sign,
  // reinforced when mains is among them; a barrier part's rating.
  function reachOf(highs, all, rules, barriers = []) {
    let hi = 0, lo = 0, mains = false;
    for (const v of highs) if (v) { hi = Math.max(hi, volts(v)); mains ||= !!v.mains; }
    for (const v of all) if (v) lo = Math.max(lo, volts(v));
    let m = 1;
    for (const r of rules) {
      const s = settingsOf(r), vw = hi + lo + (mains ? s.mainsVoltage : 0);
      const q = required(s, {rms: vw, peak: vw * SQRT2, mains, mainsRms: Math.max(s.mainsVoltage, hi), insulation: mains ? "reinforced" : "basic", surface: "outer"});
      m = Math.max(m, q.clearance, q.creepage);
    }
    for (const b of barriers) m = Math.max(m, b.creepage || 0, b.clearance || 0);
    return m;
  }
  // Online DRC's window for a Creepage Distance rule: the reach at the highest voltage seen so far.
  function reach(rule) { const s = settingsOf(rule), v = {dc: Math.max(lastMax, s.threshold)}; return reachOf([v], [v], [s]); }
  // The hint's partner window on a board: the reach over every net with a voltage (memoised on the facts).
  const reachMemo = new WeakMap();
  function hintReach(project, board, defs) {
    const V = voltages(project, board, defs), old = reachMemo.get(V);
    let rules = [];
    try { rules = (R()?.stored?.(board, project)?.list || []).filter(r => r.type === "creepage" && r.enabled !== false); } catch { rules = []; }
    const sig = JSON.stringify(rules);
    if (old && old.sig === sig) return old.reach;
    const vs = [];
    for (const n of V.F.names.keys()) { const v = V.of(n); if (v) vs.push(v); }
    const base = settingsOf(rules[0]), highs = vs.filter(v => v.mains || volts(v) * 2 + EPS >= base.threshold || v.iso);
    const out = highs.length ? reachOf(highs, vs, rules.length ? rules : [base], V.barriers()) : 0;
    reachMemo.set(V, {sig, reach: out});
    return out;
  }

  // ------------------------------------------------------------------ text
  const voltsText = v => v.mains ? t("creepage.mains") + (v.ac ? " " + r2(v.ac) + " V" : "") : v.ac ? r2(v.ac) + " V AC" : r2(v.dc || 0) + " V";
  const basisOf = (net, v) => t("creepage.basis", {net, volts: voltsText(v), by: v.basis});
  function messageOf(x) {
    const what = x.kind === "clearance" ? t("creepage.what.clearance") : t("creepage.what.creepage"), basis = [basisOf(x.a.net, x.va), basisOf(x.b.net, x.vb)].join("; ");
    if (x.bar) return t("creepage.barrier", {a: x.a.net, b: x.b.net, actual: r2(x.actual), what, ref: x.bar.ref, required: r2(x.required), basis});
    return t("creepage.message", {a: x.a.net, b: x.b.net, actual: r2(x.actual), what, standard: STANDARDS[x.settings.standard] || STANDARDS.iec62368, required: r2(x.required),
      volts: r2(x.pair.rms), insulation: insulationText(x.pair.insulation), cond: x.req.cond, basis});
  }

  // ------------------------------------------------------------------ DRC hook (rules.js drc)
  function drc(doc, defs, ctx) {
    const r = scan(doc, defs, {project: ctx.project, mode: "rule", C: ctx.R, geo: ctx.geo});
    if (r.note) ctx.notes?.push(r.note);
    for (const x of r.findings) {
      ctx.flag(x.rule, {id: x.a.id ?? null, otherId: x.b.id ?? null, title: x.a.label + " ↔ " + x.b.label, what: x.kind === "clearance" ? "Clearance" : "Creepage",
        actual: x.actual, required: x.required, limit: "min", at: x.at, otherAt: x.at, net: x.a.net, detail: messageOf(x) + " (" + x.req.refs + ")"});
    }
    return r.stats.pairs || 0;
  }

  // ------------------------------------------------------------------ the hint (Design Insights)
  // The insights engine re-checks an edit's boxes grown by the registered reach (kept small: findings sit
  // midway between the copper); the partners come from the board's own reach.
  const REACH = .5;
  function hint(ctx, scope) {
    const doc = ctx.doc, defs = ctx.defs;
    let o = {project: ctx.project, mode: "hint"};
    if (scope?.boxes) {
      const project = projectFor(doc, ctx.project), board = project?.documents?.find(d => d.id === doc.id) || doc, r = hintReach(project, board, defs);
      if (!r) return [];
      const items = ctx.itemsIn(scope.boxes.map(b => ctx.grow(b, r / 2))), partners = ctx.itemsIn(scope.boxes.map(b => ctx.grow(b, r * 1.5 + 1)));
      if (!items.length) return [];
      o = {...o, items, partners, near: scope.boxes, reach: r * 1.5 + 1, dirty: scope.dirty};
    }
    const r = scan(doc, defs, o), out = [];
    for (const x of r.findings) {
      const mainsPair = x.pair.mains, user = x.va.level === "user" && x.vb.level === "user";
      out.push({objects: [...new Set([x.a.id, x.b.id].filter(Boolean))], at: x.at, line: x.line || undefined, net: x.a.net, netPair: [x.a.net, x.b.net].sort(), layer: x.a.layer || x.b.layer || undefined,
        severity: mainsPair || user || x.bar ? "advice" : "tip", value: x.actual, message: messageOf(x),
        sig: ["creepage", ...[x.a.net, x.b.net].sort(), x.kind, x.surface, r2(x.required)].join("|")});
    }
    return out;
  }
  let installed = null;
  function install() {
    const I = G.AtriumInsights;
    if (!I?.register) return false;
    if (installed === I) return true;
    I.register({id: "creepage", kind: "pcb", severity: "tip", title: t("creepage.title"), why: t("creepage.why"), prefHelp: () => t("creepage.pref_help"), learnMore: t("creepage.learn"), scope: "area", reach: REACH,
      dirtyKinds: ["track", "via", "pad", "part", "polygon", "graphic"], schematicInputs: true, inputStamp: voltageStamp, run: hint});
    installed = I;
    return true;
  }
  install();

  return Object.freeze({required, tables, settingsOf, DEFAULTS, STANDARDS, voltages, pairOf, scan, drc, reach, install, messageOf, parseVolts,
    stats: () => ({...stats}), resetStats: () => { stats = {runs: 0, features: 0, pairs: 0, measured: 0, ms: 0}; }});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumCreepage;
