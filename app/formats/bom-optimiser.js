"use strict";
// BOM optimiser: offline consolidation proposals, rule checks and opt-in
// supplier pricing for the Bill of Materials (AtriumBOM).
//
// Everything above `panel` is DOM-free and synchronous except `price`, so the
// MCP server can run `analyse`/`apply` headlessly through JavaScriptCore.
//
// Privacy: nothing here touches the network unless the caller passes enabled,
// configured providers to `price`. Only a manufacturer part number, a supplier
// part code, or a value query such as "10kΩ 0603 resistor 1%" leaves the
// machine. Designators, net names, the project name and files never do.
// Supplier keys live in localStorage under `atrium.suppliers`, never in the
// project file. "Assign part numbers" writes only what a lookup returned (LCSC #,
// Basic/Extended, empty MPNs); Waffle never makes up a part number.
globalThis.AtriumBOMOptimiser = (() => {
  const clock = () => (globalThis.performance?.now ? performance.now() : Date.now());
  const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
  const upper = v => clean(v).toUpperCase();
  const paramKey = k => upper(k).replace(/[_\s]+/g, " ");
  const plural = (n, one, many = one + "s") => globalThis.AtriumI18n?.plural?.(n, one, many) ?? n + " " + (n === 1 ? one : many);
  const BOM = () => globalThis.AtriumBOM || (() => { throw Error("The Bill of Materials module is unavailable."); })();
  const compress = refs => globalThis.AtriumBOM?.compress ? AtriumBOM.compress(refs) : [...refs].join(", ");
  const naturalCompare = (a, b) => globalThis.AtriumBOM?.naturalCompare ? AtriumBOM.naturalCompare(a, b) : String(a).localeCompare(String(b));
  function hash(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }

  // ================================================================ values
  const PREFIX = {p: -12, P: -12, n: -9, N: -9, u: -6, U: -6, "µ": -6, m: -3, k: 3, K: 3, M: 6, G: 9, meg: 6, Meg: 6, MEG: 6, R: 0, r: 0};
  const UNIT_KIND = {"Ω": "R", F: "C", H: "L"};
  const UNIT_OF = {R: "Ω", C: "F", L: "H"};
  const VALUE = /^(\d+(?:\.\d+)?|\.\d+)(meg|Meg|MEG|[pPnNuUµmkKMGRr])?(\d+)?(Ω|[Oo]hms?|OHMS?|[FfHh])?$/;
  const RLEAD = /^[Rr](\d+)(Ω|[Oo]hms?|OHMS?)?$/;
  const SIZES = ["01005", "0201", "0402", "0603", "0805", "1206", "1210", "2010", "1812", "2512", "2220"];
  const METRIC = {"0402": "01005", "0603": "0201", "1005": "0402", "1608": "0603", "2012": "0805", "3216": "1206", "3225": "1210", "5025": "2010", "4532": "1812", "6332": "2512", "5750": "2220"};
  const FILLER = new Set(["RES", "RESISTOR", "RESISTORS", "CAP", "CAPACITOR", "CAPACITORS", "IND", "INDUCTOR", "INDUCTORS", "CHIP", "SMD", "SMT", "THICK", "THIN", "FILM", "-", "MULTILAYER", "MLCC", "CERAMIC", "SMD/SMT", "DC"]);
  // Typical ratings by chip size, used only as a labelled fallback.
  const TYPICAL_POWER = {"01005": 0.031, "0201": 0.05, "0402": 0.0625, "0603": 0.1, "0805": 0.125, "1206": 0.25, "1210": 0.5, "2010": 0.75, "1812": 0.75, "2512": 1, "2220": 1};

  function normaliseText(text) {
    return String(text ?? "")
      .replace(/[   ]/g, " ").replace(/Ω/g, "Ω").replace(/μ/g, "µ")
      .replace(/\+\/-|\+-/g, "±").replace(/±\s+/g, "±")
      .replace(/(\d+)\s*\/\s*(\d+)\s*W\b/g, (m, a, b) => (Number(b) ? String(Number((a / b).toPrecision(4))) : a) + "W")
      .replace(/(\d)\s+(%|ppm)/gi, "$1$2")
      .replace(/(\d)\s+((?:meg|Meg|MEG|[pnuµmkKMGUNP])?(?:Ω|[Oo]hms?|OHMS?|[FfHVvW]))(?![A-Za-z])/g, "$1$2")
      .replace(/(\d[pnuµmkKMGUNP])\s+(Ω|[Oo]hms?|OHMS?|F|H)(?![A-Za-z])/g, "$1$2")
      .replace(/(\d)\s+(meg|Meg|MEG|[pnuµmkKMG])(?=[\s\/,;_]|$)/g, "$1$2");
  }
  // One value token: "10k", "4k7", "4R7", "R47", "100nF", "0.1uF", "10 kΩ".
  function parseValueToken(tok) {
    let m = RLEAD.exec(tok);
    if (m) return {value: Number("0." + m[1]), kind: "R", bare: false};
    m = VALUE.exec(tok);
    if (!m) return null;
    const [, num, pre, rkm, unitRaw] = m;
    if (rkm && (!pre || num.includes("."))) return null;
    let unit = unitRaw ? (/^[Oo]|^O/.test(unitRaw) || unitRaw === "Ω" ? "Ω" : unitRaw.toUpperCase()) : "";
    let kind = unit ? UNIT_KIND[unit] : null;
    if (pre === "R" || pre === "r") { if (kind && kind !== "R") return null; kind = "R"; }
    if (pre === "M" && kind === "C") return null; // "1MF": legacy microfarad or megafarad, can't tell
    const exp = pre ? PREFIX[pre] : 0;
    const value = Number(num + (rkm ? "." + rkm : "")) * 10 ** exp;
    if (!Number.isFinite(value)) return null;
    return {value: Number(value.toPrecision(12)), kind, bare: !pre && !unit};
  }
  function normTech(t) {
    const s = String(t || "").toLowerCase();
    if (!s) return null;
    if (/thick/.test(s)) return "thick film";
    if (/thin/.test(s)) return "thin film";
    if (/metal ?film|^mf$/.test(s)) return "metal film";
    if (/carbon/.test(s)) return "carbon";
    if (/wire/.test(s)) return "wirewound";
    if (/ceramic|mlcc|multilayer/.test(s)) return "ceramic";
    if (/tant/.test(s)) return "tantalum";
    if (/polymer/.test(s)) return "polymer";
    if (/electrolytic|alumin/.test(s)) return "electrolytic";
    if (/film|polyester|polypropylene/.test(s)) return "film";
    return null;
  }
  const DIELECTRIC = /^(C0G|COG|NP0|NPO|[XYZ][245-9][A-V])$/i;
  const normDielectric = s => { const u = String(s).toUpperCase(); return /^(COG|C0G|NP0|NPO)$/.test(u) ? "C0G" : u; };
  function parseTolerance(s) {
    const t = String(s).replace(/\s/g, "");
    let m = /^±?(\d+(?:\.\d+)?|\.\d+)%?$/.exec(t);
    if (m) return {tolerance: Number(m[1])};
    m = /^±(\d+(?:\.\d+)?)(p|n)F$/i.exec(t);
    if (m) return {tolAbs: Number(m[1]) * (m[2].toLowerCase() === "p" ? 1e-12 : 1e-9)};
    return null;
  }
  function parseVoltage(s) {
    const t = String(s).replace(/\s/g, "");
    let m = /^(\d+)V(\d+)$/i.exec(t);
    if (m) return Number(m[1] + "." + m[2]);
    m = /^(\d+(?:\.\d+)?)(k)?(?:V(?:DC)?)?$/i.exec(t);
    return m ? Number(m[1]) * (m[2] ? 1000 : 1) : null;
  }
  function parsePower(s) {
    const t = normaliseText(s).replace(/\s/g, "");
    const m = /^(\d+(?:\.\d+)?|\.\d+)(m)?W?$/.exec(t);
    return m ? Number(m[1]) * (m[2] ? 1e-3 : 1) : null;
  }
  function parseTempco(s) {
    const m = /^±?(\d+(?:\.\d+)?)\s*ppm(\/°?[CK])?$/i.exec(String(s).trim());
    return m ? Number(m[1]) : null;
  }

  // Read a free-text comment or supplier description.
  function parseText(text) {
    const out = {value: null, kind: null, bare: false, values: 0, tolerance: null, tolAbs: null, voltage: null, power: null,
      dielectric: null, tempco: null, technology: null, package: null, extra: [], attrs: []};
    const tokens = normaliseText(text).split(/[\s,;\/_]+/).filter(Boolean);
    const sizes = [];
    for (const tok of tokens) {
      let v;
      if (/^±?\d+(\.\d+)?%$/.test(tok) || /^±\d+(\.\d+)?[pn]F$/i.test(tok)) { Object.assign(out, parseTolerance(tok)); out.attrs.push(out.tolAbs != null && /F$/i.test(tok) ? "tolAbs" : "tolerance"); continue; }
      if (/^\d+(\.\d+)?k?V(DC)?$/i.test(tok) || /^\d+V\d+$/i.test(tok)) { out.voltage = parseVoltage(tok); out.attrs.push("voltage"); continue; }
      if (/^(\d+(\.\d+)?|\.\d+)m?W$/.test(tok)) { out.power = parsePower(tok); out.attrs.push("power"); continue; }
      if (DIELECTRIC.test(tok)) { out.dielectric = normDielectric(tok); out.attrs.push("dielectric"); continue; }
      if (/^±?\d+(\.\d+)?ppm(\/°?[CK])?$/i.test(tok)) { out.tempco = parseTempco(tok); out.attrs.push("tempco"); continue; }
      if (SIZES.includes(tok)) { sizes.push(tok); continue; }
      const tech = /^(ceramic|mlcc|tantalum|tant|electrolytic|polymer|thick|thin|metal|carbon|wirewound)$/i.test(tok) ? normTech(tok) : null;
      if (tech) { if (!out.technology || tech !== "ceramic") out.technology = tech; if (!out.attrs.includes("technology")) out.attrs.push("technology"); continue; }
      if ((v = parseValueToken(tok))) { out.values++; if (out.values === 1) { out.value = v.value; out.kind = v.kind; out.bare = v.bare; } continue; }
      if (!FILLER.has(tok.toUpperCase())) out.extra.push(tok);
    }
    // A chip size is the package unless it's the only number, then it's the value.
    if (sizes.length && !out.values && sizes.length === 1 && !out.attrs.length && !out.extra.length) {
      const v = parseValueToken(sizes[0]); out.values = 1; out.value = v.value; out.bare = true;
    } else if (sizes.length) { out.package = sizes[0]; out.attrs.push("package"); }
    if (out.values > 1) { out.value = null; out.kind = null; }
    return out;
  }
  const PREFIXES = [[-12, "p"], [-9, "n"], [-6, "µ"], [-3, "m"], [0, ""], [3, "k"], [6, "M"], [9, "G"]];
  function formatValue(value, kind) {
    const unit = UNIT_OF[kind] || "";
    if (value === 0) return "0 " + unit;
    let e = Math.floor(Math.log10(Math.abs(value)) / 3 + 1e-9) * 3;
    e = Math.max(-12, Math.min(9, e));
    let mant = Number((value / 10 ** e).toPrecision(4));
    if (mant >= 1000 && e < 9) { e += 3; mant = Number((value / 10 ** e).toPrecision(4)); }
    return mant + " " + PREFIXES.find(p => p[0] === e)[1] + unit;
  }
  const formatPower = w => w >= 1 ? Number(w.toPrecision(4)) + " W" : Number((w * 1000).toPrecision(4)) + " mW";
  function formatAttr(attr, v) {
    if (v == null) return "";
    if (attr === "tolerance") return v + "%";
    if (attr === "tolAbs") return "±" + formatValue(v, "C").replace(" ", " ");
    if (attr === "voltage") return Number(v.toPrecision(4)) + " V";
    if (attr === "power") return formatPower(v);
    if (attr === "tempco") return v + " ppm";
    return String(v);
  }

  // ============================================================ E-series
  const E6 = [1.0, 1.5, 2.2, 3.3, 4.7, 6.8];
  const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
  const E24 = [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1];
  const computed = n => Array.from({length: n}, (_, i) => Number((10 ** (i / n)).toPrecision(3)));
  const SERIES = {E6, E12, E24, E48: computed(48), E96: computed(96)};
  function mantissa(v) {
    if (!(v > 0)) return null;
    const e = Math.floor(Math.log10(v) + 1e-9);
    let m = Number((v / 10 ** e).toPrecision(3));
    if (m >= 10) m = Number((m / 10).toPrecision(3));
    return m;
  }
  // The smallest E-series that contains the value, or null.
  function eSeries(v) {
    const m = mantissa(v);
    if (m == null) return null;
    for (const name of ["E6", "E12", "E24", "E48", "E96"]) if (SERIES[name].some(x => Math.abs(x - m) < 1e-9)) return name;
    return null;
  }
  function nearest(v, name) {
    const e = Math.floor(Math.log10(v) + 1e-9), list = SERIES[name], m = v / 10 ** e;
    let lo = list[list.length - 1] / 10, hi = 10;
    for (const x of list) { if (x <= m + 1e-9) lo = x; if (x >= m - 1e-9) { hi = x; break; } }
    return [Number((lo * 10 ** e).toPrecision(3)), Number((hi * 10 ** e).toPrecision(3))];
  }

  // ======================================================= parameters
  // Procurement categories read from part parameters (Altium, KiCad and
  // supplier-export spellings). Keys are compared upper-case with spaces.
  const CATEGORIES = [
    ["mpn", /^(MPN|MFR\.? ?(PART ?(NUMBER|NO\.?|#)|PN|P\/N)|MANUFACTURER ?(PART ?(NUMBER|NO\.?|#)|PN|P\/N)( ?\d)?|MFG ?(PART ?(NUMBER|NO\.?|#)|PN))$/],
    ["manufacturer", /^(MANUFACTURER( ?\d)?|MANUFACTURER NAME|MFR\.?|MFG|MAKER)$/],
    ["supplierPn", /^(SUPPLIER ?(PART ?(NUMBER|NO\.?|#)|PN|P\/N)( ?\d)?|LCSC( ?(PART ?(NUMBER|NO\.?|#)?|PN|#))?|JLC(PCB)?( ?(PART ?(NUMBER|NO\.?|#)?|PN|#))?|DIGI-?KEY( ?(PART ?(NUMBER|NO\.?|#)?|PN))?|MOUSER( ?(PART ?(NUMBER|NO\.?|#)?|PN))?)$/],
    ["supplier", /^SUPPLIER( ?\d)?$/],
    ["tolerance", /^(TOLERANCE|TOL\.?)$/],
    ["voltage", /^((RATED )?VOLTAGE( ?(RATING|RATED|- ?RATED|DC|\(DC\)))?|V ?RATED|WV|WORKING VOLTAGE)$/],
    ["power", /^((RATED )?POWER( ?(RATING|\(WATTS\)))?|WATTAGE)$/],
    ["tc", /^(DIELECTRIC( (MATERIAL|TYPE))?|TEMPERATURE CHARACTERISTICS?|TEMP(ERATURE)? COEFF?(ICIENT)?|TC|TCR|TEMPCO)$/],
    ["technology", /^(TYPE|TECHNOLOGY|COMPOSITION|MATERIAL)$/],
    ["package", /^(PACKAGE|CASE|CASE ?\/ ?PACKAGE|PACKAGE ?\/ ?CASE|SIZE|CASE CODE)$/],
    ["alternates", /^(ALT(ERNATE|ERNATIVE)? ?(FOOTPRINTS?|PACKAGES?)|FOOTPRINT ALTERNATES?)$/]
  ];
  const PROCUREMENT = ["mpn", "manufacturer", "supplierPn", "supplier", "tolerance", "voltage", "power", "tc", "technology"];
  const CANONICAL_KEY = {mpn: "Manufacturer Part Number", manufacturer: "Manufacturer", supplierPn: "Supplier Part Number", supplier: "Supplier",
    tolerance: "Tolerance", voltage: "Voltage", power: "Power", tc: "Dielectric", technology: "Type"};
  const categoryOf = key => { const k = paramKey(key); for (const [c, re] of CATEGORIES) if (re.test(k)) return c; return null; };
  // Category -> [{key, value, from}] with the original key spelling, item last.
  function rawParams(item, def) {
    const out = Object.create(null);
    for (const [from, source] of [["def", def?.parameters], ["item", item?.parameters]]) {
      if (!source || typeof source !== "object") continue;
      for (const [k, v] of Object.entries(source)) {
        if (typeof v === "object") continue;
        const c = categoryOf(k);
        if (!c) continue;
        const list = out[c] || (out[c] = []);
        const same = list.findIndex(x => paramKey(x.key) === paramKey(k));
        const entry = {key: k, value: clean(v), from};
        if (same >= 0) list[same] = entry; else list.push(entry);
      }
    }
    return out;
  }
  const firstValue = list => (list || []).map(x => x.value).find(Boolean) || "";

  function packageOf(footprint, pkgParam, alternatesText) {
    for (const text of [pkgParam, footprint]) {
      const s = clean(text);
      if (!s) continue;
      let m = /^(?:RES|CAP|IND|LED|DIO)[A-Z]*?(\d{4})X/i.exec(s);
      if (m && METRIC[m[1]]) return METRIC[m[1]];
      m = /(?:^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512|2220)(?![0-9])(?!\s*M(?:etric)?\b)/.exec(s);
      if (m) return m[1];
      m = /(?:^|[^0-9])(\d{4})(?:M|_?Metric)\b/i.exec(s);
      if (m && METRIC[m[1]]) return METRIC[m[1]];
    }
    return null;
  }
  function smdOf(pkg, footprint) {
    if (pkg) return true;
    const f = clean(footprint);
    if (/DIP|THT|TO-?(220|92|247|3)\b|Axial|Radial|Pin_?Header|PinHeader|THD|_TH\b|Terminal|Barrel|PinSocket/i.test(f)) return false;
    if (/SOT|SOD|SOIC|SSOP|TSSOP|MSOP|QFN|DFN|QFP|BGA|LGA|SON|SC-?70|SMA|SMB|SMC|DPAK|PowerPAK|SMD|SMT|_\d{4}\b/i.test(f)) return true;
    return null;
  }
  function kindHint(ref, def) {
    const r = clean(ref);
    if (/^R\d/i.test(r)) return "R";
    if (/^C\d/i.test(r)) return "C";
    if (/^L\d/i.test(r)) return "L";
    const text = [def?.category, def?.name, def?.description].map(clean).join(" ");
    if (/\b(network|array|potentiometer|trimmer|thermistor|varistor)\b/i.test(text)) return null;
    if (/\bresistors?\b/i.test(text)) return "R";
    if (/\bcapacitors?\b/i.test(text)) return "C";
    if (/\binductors?\b/i.test(text)) return "L";
    return null;
  }

  // Everything known about one included BOM entry (an AtriumBOM.collect part).
  function specOf(e, memo) {
    const key = clean(e.comment);
    let t = memo?.get(key);
    if (!t) { t = parseText(key); memo?.set(key, t); }
    const raw = rawParams(e.item, e.def);
    if (e.mate) { const m = rawParams(e.mate.item, e.mate.def); for (const c in m) if (!raw[c]) raw[c] = m[c]; }
    const hint = kindHint(e.ref, e.def);
    const s = {kind: null, value: null, valueKey: null, canonical: null, tolerance: t.tolerance, tolAbs: t.tolAbs, voltage: t.voltage, power: t.power,
      dielectric: t.dielectric, tempco: t.tempco, technology: t.technology, package: null, extra: t.extra, attrs: t.attrs,
      mpn: firstValue(raw.mpn), manufacturer: firstValue(raw.manufacturer), supplierPn: firstValue(raw.supplierPn),
      alternates: firstValue(raw.alternates), conflicts: [], unparsed: null, params: {}};
    for (const c of PROCUREMENT) s.params[c] = firstValue(raw[c]);
    const kind = t.kind && hint && t.kind !== hint ? null : (t.kind || hint);
    if (t.kind && hint && t.kind !== hint) s.unparsed = "The comment's unit doesn't match the designator.";
    s.kind = kind;
    if (kind && t.value != null) {
      if (t.bare && kind !== "R") s.unparsed = "No unit or multiplier, so the value can't be read.";
      else if (kind === "C" && t.value >= 1 && !/F/i.test(key)) s.unparsed = "Implausible capacitance.";
      else { s.value = t.value; s.valueKey = kind + Number(t.value.toPrecision(6)); s.canonical = formatValue(t.value, kind); }
    } else if (kind) s.unparsed = t.values > 1 ? "More than one value in the comment." : "No value in the comment.";
    // Parameters are explicit fields and win over the comment; disagreements are reported.
    const take = (attr, v, label) => {
      if (v == null) return;
      if (s[attr] != null && s[attr] !== v) s.conflicts.push(label + ": comment " + formatAttr(attr, s[attr]) + ", parameter " + formatAttr(attr, v));
      s[attr] = v;
    };
    if (s.params.tolerance) { const tol = parseTolerance(s.params.tolerance); if (tol?.tolerance != null) take("tolerance", tol.tolerance, "Tolerance"); if (tol?.tolAbs != null) take("tolAbs", tol.tolAbs, "Tolerance"); }
    if (s.params.voltage) take("voltage", parseVoltage(s.params.voltage), "Voltage");
    if (s.params.power) take("power", parsePower(s.params.power), "Power");
    if (s.params.tc) {
      const d = clean(s.params.tc);
      if (DIELECTRIC.test(d)) take("dielectric", normDielectric(d), "Dielectric"); else take("tempco", parseTempco(d), "Temperature coefficient");
    }
    if (s.params.technology) { const tech = normTech(s.params.technology); if (tech) s.technology = tech; }
    const pkg = packageOf(e.footprint, firstValue(raw.package));
    if (pkg && t.package && pkg !== t.package) s.conflicts.push("Package: comment " + t.package + ", footprint " + pkg);
    s.package = pkg || t.package;
    return s;
  }

  // ============================================================ ratings
  const LOW = {X: -55, Y: -30, Z: 10}, HIGH = {2: 45, 4: 65, 5: 85, 6: 105, 7: 125, 8: 150, 9: 200};
  const DRIFT = {A: 1, B: 1.5, C: 2.2, D: 3.3, E: 4.7, F: 7.5, P: 10, R: 15, S: 22, T: 33, U: 56, V: 82};
  function dielectricInfo(code) {
    if (code === "C0G") return {lo: -55, hi: 125, drift: 0.3, class1: true};
    const m = /^([XYZ])([245-9])([A-V])$/.exec(code || "");
    return m ? {lo: LOW[m[1]], hi: HIGH[m[2]], drift: DRIFT[m[3]] ?? 100, class1: false} : null;
  }
  // Is `d` at least as good as `l` for this attribute?
  function atLeast(attr, d, l) {
    if (attr === "tolerance" || attr === "tolAbs" || attr === "tempco") return d <= l + 1e-12;
    if (attr === "voltage" || attr === "power") return d >= l - 1e-12;
    if (attr === "dielectric") {
      const a = dielectricInfo(d), b = dielectricInfo(l);
      return !!(a && b && a.lo <= b.lo && a.hi >= b.hi && a.drift <= b.drift);
    }
    return d === l; // technology must match exactly
  }
  const RATINGS = ["tolerance", "tolAbs", "voltage", "power", "dielectric", "tempco", "technology"];
  const ATTR_LABEL = {tolerance: "tolerance", tolAbs: "tolerance", voltage: "voltage rating", power: "power rating", dielectric: "dielectric",
    tempco: "temperature coefficient", technology: "technology"};
  // May every part described by `l` use the part described by `d`?
  function dominates(d, l) {
    const caveats = [];
    for (const a of RATINGS) {
      const x = d[a], y = l[a];
      if (y == null) { if (x != null) caveats.push(a); continue; }
      if (x == null || !atLeast(a, x, y)) return {ok: false, caveats};
    }
    if ((l.mpn || l.supplierPn) && !(d.mpn || d.supplierPn)) return {ok: false, caveats};
    return {ok: true, caveats};
  }
  function describeSpec(s, line) {
    if (!s.canonical) return clean(line?.comment) || "?";
    const out = [s.canonical];
    if (s.package) out.push(s.package);
    for (const a of ["tolerance", "tolAbs", "dielectric", "voltage", "power", "tempco"]) if (s[a] != null) out.push(formatAttr(a, s[a]));
    if (s.technology && !(s.technology === "ceramic" && s.dielectric)) out.push(s.technology);
    return out.join(" ");
  }
  // Canonical comment: the value plus the attributes the comment itself listed.
  function canonicalComment(s, comment) {
    if (!s.canonical) return clean(comment);
    const t = parseText(comment);
    const out = [s.canonical];
    if (t.attrs.includes("package") && s.package) out.push(s.package);
    for (const a of ["tolerance", "tolAbs", "dielectric", "voltage", "power", "tempco"]) if (t.attrs.includes(a) && s[a] != null) out.push(formatAttr(a, s[a]));
    if (t.attrs.includes("technology") && s.technology) out.push(s.technology);
    return [...out, ...t.extra].join(" ");
  }

  // ======================================================= net voltages
  // A supply voltage read from a net name, or null when the name doesn't say.
  function netVoltage(name) {
    const n = clean(name);
    if (!n) return null;
    if (/^[ADPSE]?GND\w*$|^(GROUND|EARTH|CHASSIS|0V)$|^GND_/i.test(n)) return 0;
    const found = new Set();
    for (const tok of n.split(/[^A-Za-z0-9.+-]+/).filter(Boolean)) {
      let m = /^[A-Z]{0,4}?([+-]|N|P)?(\d+(?:\.\d+)?)V(\d+)?[A-Z]{0,4}$/i.exec(tok);
      if (m && !(m[3] && m[2].includes("."))) {
        const v = Number(m[2] + (m[3] ? "." + m[3] : "")) * (m[1] === "-" || m[1] === "N" ? -1 : 1);
        found.add(v); continue;
      }
      m = /^V?(\d+)P(\d+)V?$/i.exec(tok);
      if (m && /V/i.test(tok)) found.add(Number(m[1] + "." + m[2]));
    }
    return found.size === 1 ? [...found][0] : null;
  }

  // ============================================================ analysis
  function partNets(e, defs, sheetNets, project) {
    const board = e.side === "pcb" ? e.item : e.mate?.item;
    if (board?.pinNets && Object.keys(board.pinNets).length) {
      const pins = Object.keys(board.pinNets);
      return pins.length === 2 ? pins.map(k => board.pinNets[k] || "") : null;
    }
    if (e.side !== "schematic" || !globalThis.Atrium?.connectivity) return null;
    let nets = sheetNets.get(e.docId);
    if (!nets) {
      const doc = project.documents.find(d => d.id === e.docId);
      nets = doc ? Atrium.connectivity(doc, defs).byPin : new Map();
      sheetNets.set(e.docId, nets);
    }
    const pins = e.def?.symbol?.pins || [];
    return pins.length === 2 ? pins.map(p => nets.get(e.item.id + "/" + p.number) || "") : null;
  }
  const lineRefs = line => compress(line.parts.map(p => p.ref));

  function analyse(project, options = {}) {
    const t0 = clock();
    const B = BOM();
    const collected = options.collected || B.collect(project, {source: options.source, board: options.board});
    const memo = new Map(), parts = [];
    for (const e of collected.parts) {
      const spec = specOf(e, memo);
      parts.push({e, ref: e.ref, id: e.id, doc: e.docId, comment: clean(e.comment), footprint: clean(e.footprint), spec, smd: smdOf(spec.package, e.footprint)});
    }
    // Entry lines: what an assembler sees as distinct things to buy.
    const lines = new Map();
    for (const p of parts) {
      const s = p.spec;
      const key = [upper(p.comment), s.package || upper(p.footprint), ...PROCUREMENT.map(c => upper(s.params[c]))].join("\u0001");
      let line = lines.get(key);
      if (!line) lines.set(key, line = {key, parts: [], comment: p.comment, footprint: p.footprint, spec: s, smd: p.smd});
      line.parts.push(p);
    }
    const lineList = [...lines.values()];
    for (const l of lineList) l.qty = l.parts.length;
    const proposals = [];
    const groups = new Map();
    for (const l of lineList) {
      const s = l.spec;
      if (!s.kind || s.valueKey == null || s.unparsed) continue;
      const g = [s.valueKey, s.package || upper(l.footprint), s.extra.map(upper).sort().join(" ")].join("|");
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(l);
    }
    const merged = new Set();
    for (const [gk, members] of [...groups].sort((a, b) => naturalCompare(a[0], b[0]))) {
      if (members.length < 2) continue;
      let pool = members.slice().sort((a, b) => b.qty - a.qty || (b.spec.mpn ? 1 : 0) - (a.spec.mpn ? 1 : 0) || naturalCompare(a.key, b.key));
      while (pool.length >= 2) {
        let best = null;
        for (const D of pool.slice(0, 64)) {
          const covered = [];
          for (const L of pool) if (L !== D) { const r = dominates(D.spec, L.spec); if (r.ok) covered.push({line: L, caveats: r.caveats}); }
          if (covered.length && (!best || covered.length > best.covered.length)) best = {D, covered};
        }
        if (!best) break;
        proposals.push(mergeProposal(best.D, best.covered));
        for (const x of [best.D, ...best.covered.map(c => c.line)]) merged.add(x);
        pool = pool.filter(x => x !== best.D && !best.covered.some(c => c.line === x));
      }
      if (pool.length >= 2) proposals.push(uncoveredAdvisory(pool));
    }
    proposals.push(...packageAdvisories(lineList));
    const checks = runChecks(project, collected, parts, lineList, options);
    const smdLines = lineList.filter(l => l.smd).length;
    const result = {
      version: 1, source: collected.source, board: collected.board, generated: new Date().toISOString(),
      summary: {parts: parts.length, lineItems: lineList.length, feederSlots: smdLines, excluded: collected.excluded.length},
      lines: lineList.map(l => ({key: l.key, comment: l.comment, footprint: l.footprint, package: l.spec.package, refs: l.parts.map(p => p.ref), ids: l.parts.map(p => p.id),
        qty: l.qty, smd: l.smd, kind: l.spec.kind, value: l.spec.canonical, valueKey: l.spec.valueKey, description: describeSpec(l.spec, l),
        mpn: l.spec.mpn, manufacturer: l.spec.manufacturer, supplierPn: l.spec.supplierPn, spec: plainSpec(l.spec)})),
      proposals, checks
    };
    Object.assign(result.summary, after(result, proposals.filter(p => p.selected).map(p => p.id)));
    result.ms = Math.round((clock() - t0) * 10) / 10;
    return result;
  }
  const plainSpec = s => ({kind: s.kind, value: s.value, tolerance: s.tolerance, tolAbs: s.tolAbs, voltage: s.voltage, power: s.power,
    dielectric: s.dielectric, tempco: s.tempco, technology: s.technology, package: s.package, extra: s.extra});

  function changesFor(part, target, targetParams, copyParams) {
    const out = [], e = part.e;
    const items = [{item: e.item, def: e.def, doc: e.docId}];
    if (e.mate) items.push({item: e.mate.item, def: e.mate.def, doc: e.mate.docId, mate: true});
    for (const x of items) {
      if (clean(x.item.value) !== target.comment)
        out.push({doc: x.doc, id: x.item.id, ref: part.ref, path: ["value"], before: x.item.value, after: target.comment});
    }
    if (!copyParams) return out;
    const own = obj => obj && typeof obj === "object" ? obj : {};
    for (const x of items) {
      const raw = rawParams(x.item, x.def);
      for (const c of PROCUREMENT) {
        const want = targetParams[c];
        const have = raw[c] || [];
        if (x.mate && !have.some(h => h.from === "item")) continue; // the board copy inherits from the schematic
        for (const h of have) {
          const value = want ? want.value : "";
          if (h.value === value) continue;
          const exists = Object.prototype.hasOwnProperty.call(own(x.item.parameters), h.key);
          out.push({doc: x.doc, id: x.item.id, ref: part.ref, path: ["parameters", h.key], before: exists ? x.item.parameters[h.key] : undefined, after: value});
        }
        if (want && !have.length && !x.mate)
          out.push({doc: x.doc, id: x.item.id, ref: part.ref, path: ["parameters", want.key], before: undefined, after: want.value});
      }
    }
    return out;
  }
  function mergeProposal(D, covered) {
    const s = D.spec, comment = canonicalComment(s, D.comment);
    const draw = rawParams(D.parts[0].e.item, D.parts[0].e.def);
    if (D.parts[0].e.mate) { const m = rawParams(D.parts[0].e.mate.item, D.parts[0].e.mate.def); for (const c in m) if (!draw[c]) draw[c] = m[c]; }
    const targetParams = {};
    for (const c of PROCUREMENT) { const v = (draw[c] || []).find(x => x.value); if (v) targetParams[c] = {key: v.key, value: v.value}; }
    const target = {comment, description: describeSpec(s, D), mpn: s.mpn, manufacturer: s.manufacturer, package: s.package,
      params: Object.entries(targetParams).map(([category, v]) => ({category, key: v.key, value: v.value}))};
    const lines = [D, ...covered.map(c => c.line)];
    const changes = [];
    for (const p of D.parts) changes.push(...changesFor(p, target, targetParams, false));
    const caveats = [];
    let sameSpec = true, sameParams = true;
    for (const {line, caveats: cv} of covered) {
      for (const p of line.parts) changes.push(...changesFor(p, target, targetParams, true));
      if (cv.length) caveats.push(lineRefs(line) + " has no " + [...new Set(cv.map(a => ATTR_LABEL[a]))].join(" or ") +
        "; the merged part is " + cv.map(a => formatAttr(a, s[a])).join(", ") + ". Check it suits that circuit.");
      for (const a of RATINGS) if (line.spec[a] !== s[a]) sameSpec = false;
      for (const c of PROCUREMENT) if (upper(line.spec.params[c]) !== upper(s.params[c])) sameParams = false;
    }
    const subtype = sameSpec && sameParams ? "notation" : sameSpec ? "part" : "rating";
    const smd = lines.filter(l => l.smd).length;
    const savings = {lines: lines.length - 1, feeders: Math.max(0, smd - (smd ? 1 : 0)), parts: lines.reduce((n, l) => n + l.qty, 0)};
    const title = subtype === "notation" ? "Write " + s.canonical + " one way" :
      subtype === "part" ? "Use one part number for " + target.description : "Standardise on " + target.description;
    const explanation = subtype === "notation"
      ? lines.map(l => "“" + l.comment + "”").join(", ") + " are the same part written differently. Writing it as “" + comment + "” merges " + plural(lines.length, "line") + "."
      : subtype === "part" ? "These lines have the same ratings but different part numbers. Using " + (s.mpn || s.supplierPn || "one part") + " everywhere merges " + plural(lines.length, "line") + "."
      : target.description + " meets or exceeds every known rating of the other lines, so no voltage, power, tolerance, temperature coefficient or dielectric gets worse. It merges " + plural(lines.length, "line") + ".";
    return {
      id: "merge-" + hash(lines.map(l => l.key).sort().join("\u0002")), type: "merge", subtype, applicable: true,
      // Swapping one MPN for another is a design decision even at equal ratings.
      confidence: caveats.length || subtype === "part" ? "check" : "safe", selected: !caveats.length && subtype !== "part", title, explanation, caveats, kind: s.kind, value: s.canonical, target,
      from: lines.map(l => ({comment: l.comment, refs: lineRefs(l), qty: l.qty, description: describeSpec(l.spec, l), mpn: l.spec.mpn, target: l === D})),
      savings, changes, keys: lines.map(l => l.key)
    };
  }
  function uncoveredAdvisory(pool) {
    const best = {...pool[0].spec};
    for (const l of pool) for (const a of RATINGS) {
      const v = l.spec[a];
      if (v == null) continue;
      if (best[a] == null || (a !== "technology" && a !== "dielectric" && atLeast(a, v, best[a]))) best[a] = v;
      else if (a === "dielectric" && atLeast(a, v, best[a])) best[a] = v;
    }
    const smd = pool.filter(l => l.smd).length;
    return {id: "cover-" + hash(pool.map(l => l.key).sort().join("\u0002")), type: "advisory", subtype: "no-cover", applicable: false, selected: false,
      confidence: "check", title: "No single part covers " + pool[0].spec.canonical + " " + (pool[0].spec.package || ""),
      explanation: "No existing line meets every rating of the others. A part rated " + describeSpec(best, pool[0]) +
        " would replace all " + plural(pool.length, "line") + "; Waffle won't invent a part number.",
      caveats: [], kind: pool[0].spec.kind, value: pool[0].spec.canonical, target: {description: describeSpec(best, pool[0])},
      from: pool.map(l => ({comment: l.comment, refs: lineRefs(l), qty: l.qty, description: describeSpec(l.spec, l), mpn: l.spec.mpn})),
      savings: {lines: pool.length - 1, feeders: Math.max(0, smd - 1), parts: pool.reduce((n, l) => n + l.qty, 0)}, changes: [], keys: pool.map(l => l.key)};
  }
  // Same value and ratings in different chip sizes. Footprint changes belong
  // to the layout, so these are advisory only.
  function packageAdvisories(lineList) {
    const out = [], groups = new Map();
    for (const l of lineList) {
      const s = l.spec;
      if (!s.kind || s.valueKey == null || s.unparsed || !s.package) continue;
      const g = s.valueKey + "|" + s.extra.map(upper).sort().join(" ");
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(l);
    }
    for (const members of groups.values()) {
      const byPkg = new Map();
      for (const l of members) byPkg.set(l.spec.package, (byPkg.get(l.spec.package) || 0) + l.qty);
      if (byPkg.size < 2) continue;
      const T = [...byPkg].sort((a, b) => b[1] - a[1] || SIZES.indexOf(b[0]) - SIZES.indexOf(a[0]))[0][0];
      const targets = members.filter(l => l.spec.package === T);
      const movable = [], caveats = [];
      for (const l of members) {
        if (l.spec.package === T) continue;
        const ok = targets.find(t => dominates({...t.spec, mpn: "", supplierPn: ""}, {...l.spec, mpn: "", supplierPn: ""}).ok);
        if (!ok) continue;
        if (SIZES.indexOf(T) < SIZES.indexOf(l.spec.package)) {
          if (l.spec.kind === "R" && l.spec.power == null) caveats.push(lineRefs(l) + ": a " + T + " resistor is typically rated " + formatPower(TYPICAL_POWER[T]) + " against " + formatPower(TYPICAL_POWER[l.spec.package]) + " for " + l.spec.package + "; check dissipation.");
          if (l.spec.kind === "C" && l.spec.voltage == null) caveats.push(lineRefs(l) + ": smaller capacitors lose more capacitance under DC bias; check the voltage.");
        }
        movable.push(l);
      }
      if (!movable.length) continue;
      const declared = movable.every(l => upper(l.spec.alternates).includes(T));
      out.push({id: "package-" + hash(members.map(l => l.key).sort().join("\u0002")), type: "advisory", subtype: "package", applicable: false, selected: false,
        confidence: "check", title: "Standardise " + members[0].spec.canonical + " on " + T,
        explanation: members[0].spec.canonical + " appears in " + [...byPkg.keys()].join(" and ") + ". " +
          (declared ? "The parts list " + T + " as an alternate footprint. " : "Waffle can't tell whether the footprints allow either size. ") +
          "If the layout allows " + T + " for " + compress(movable.flatMap(l => l.parts.map(p => p.ref))) + ", change their footprints in the layout to save up to " + plural(movable.length, "line") + ".",
        caveats, kind: members[0].spec.kind, value: members[0].spec.canonical, target: {description: members[0].spec.canonical + " " + T, package: T},
        from: movable.map(l => ({comment: l.comment, refs: lineRefs(l), qty: l.qty, description: describeSpec(l.spec, l), mpn: l.spec.mpn})),
        savings: {lines: movable.length, feeders: movable.filter(l => l.smd).length, parts: movable.reduce((n, l) => n + l.qty, 0)}, changes: [], keys: movable.map(l => l.key)});
    }
    return out;
  }
  // Line items and feeder slots after the chosen proposals. Proposals never overlap.
  function after(analysis, ids) {
    const chosen = new Set(ids);
    let lines = analysis.summary.lineItems, feeders = analysis.summary.feederSlots;
    for (const p of analysis.proposals) if (p.applicable && chosen.has(p.id)) { lines -= p.savings.lines; feeders -= p.savings.feeders; }
    return {lineItemsAfter: lines, feederSlotsAfter: feeders};
  }

  // Apply chosen proposals to `project` in place. Every change is checked
  // against the value it replaces first, so a stale analysis changes nothing.
  function apply(project, analysis, ids) {
    const chosen = new Set(ids == null ? analysis.proposals.filter(p => p.selected).map(p => p.id) : ids);
    const props = analysis.proposals.filter(p => chosen.has(p.id));
    for (const p of props) if (!p.applicable) throw Error("“" + p.title + "” is advice only and can't be applied automatically.");
    const docs = new Map(project.documents.map(d => [d.id, d]));
    const index = new Map();
    const find = (doc, id) => {
      if (!index.has(doc)) index.set(doc, new Map((docs.get(doc)?.items || []).map(i => [i.id, i])));
      return index.get(doc).get(id);
    };
    const plan = [];
    for (const p of props) for (const c of p.changes) {
      const item = find(c.doc, c.id);
      if (!item) throw Error(c.ref + " is no longer in the design. Run the optimiser again.");
      const [k, sub] = c.path;
      const cur = sub == null ? item[k] : (item.parameters && Object.prototype.hasOwnProperty.call(item.parameters, sub) ? item.parameters[sub] : undefined);
      if (cur !== c.before) throw Error(c.ref + " changed since the analysis. Run the optimiser again.");
      plan.push([item, c]);
    }
    for (const [item, c] of plan) {
      const [k, sub] = c.path;
      if (sub == null) item[k] = c.after;
      else { if (!item.parameters || typeof item.parameters !== "object") item.parameters = {}; item.parameters[sub] = c.after; }
    }
    return {changed: plan.length, proposals: props.length, parts: new Set(plan.map(([i]) => i.id)).size};
  }

  // ============================================================== checks
  const DERATE_VOLTAGES = [2.5, 4, 6.3, 10, 16, 25, 35, 50, 63, 100, 200, 250, 450, 500, 630, 1000, 2000, 3000];
  function runChecks(project, collected, parts, lineList, options) {
    const checks = [];
    const add = (id, severity, title, message, items) => { if (items.length) checks.push({id, severity, title, message, count: items.length, items}); };
    const noMpn = lineList.filter(l => !l.spec.mpn && !l.spec.supplierPn);
    add("missing-mpn", "warning", "Missing manufacturer part number", "Lines without an MPN can't be priced exactly or ordered unambiguously.",
      noMpn.map(l => ({refs: lineRefs(l), text: l.comment || "(no comment)"})));
    add("missing-manufacturer", "info", "Missing manufacturer", "These lines have a part number but no manufacturer.",
      lineList.filter(l => l.spec.mpn && !l.spec.manufacturer).map(l => ({refs: lineRefs(l), text: l.spec.mpn})));
    const dnp = collected.excluded.filter(x => x.reason === "Do not populate");
    add("dnp", "info", "Do not populate", "DNP parts are left out of the optimisation and the cost.", dnp.length ? [{refs: compress(dnp.map(x => x.ref)), text: plural(dnp.length, "part")}] : []);
    if (project.variants) add("variants", "info", "Assembly variants", "The optimiser uses the base BOM; variant-specific fitting isn't modelled.", [{refs: "", text: "Variants found"}]);
    add("unparsed", "info", "Value not understood", "Waffle can't read these passive values, so it leaves them alone.",
      lineList.filter(l => l.spec.kind && l.spec.unparsed).map(l => ({refs: lineRefs(l), text: "“" + l.comment + "”: " + l.spec.unparsed})));
    add("conflict", "warning", "Comment and parameters disagree", "The parameter value is used; fix the other one.",
      lineList.filter(l => l.spec.conflicts.length).map(l => ({refs: lineRefs(l), text: l.spec.conflicts.join("; ")})));
    // E-series.
    const series = [];
    for (const l of lineList) {
      const s = l.spec;
      if (!s.value || s.unparsed || !(s.value > 0) || s.kind === "L" && false) continue;
      const found = eSeries(s.value);
      if (s.kind === "R") {
        const precise = s.tolerance != null && s.tolerance <= 1;
        if (found === "E6" || found === "E12" || found === "E24") continue;
        if ((found === "E48" || found === "E96") && precise) continue;
        if (found === "E48" || found === "E96") series.push({refs: lineRefs(l), keys: [l.key], severity: "info", text: s.canonical + " is an " + found + " value; " + (s.tolerance == null ? "set the tolerance to 1% or better" : s.tolerance + "% parts rarely come in it") + ". Nearest E24: " + nearest(s.value, "E24").map(v => formatValue(v, "R")).join(" / ") + "."});
        else series.push({refs: lineRefs(l), keys: [l.key], severity: "warning", text: s.canonical + " isn't in E96 or E24. Nearest E96: " + nearest(s.value, "E96").map(v => formatValue(v, "R")).join(" / ") + "."});
      } else if (s.kind === "C" || s.kind === "L") {
        if (found === "E6" || found === "E12") continue;
        series.push({refs: lineRefs(l), keys: [l.key], severity: found === "E24" ? "info" : "warning", text: s.canonical + (found === "E24" ? " is an E24 value; E12 values are easier to buy." : " is a non-standard value.") + " Nearest E12: " + nearest(s.value, "E12").map(v => formatValue(v, s.kind)).join(" / ") + "."});
      }
    }
    add("e-series", series.some(x => x.severity === "warning") ? "warning" : "info", "Non-standard values", "Checked against E6 to E96. Waffle never changes a value for you.", series);
    if (options.checks === false) return checks;
    // Capacitor DC bias and resistor power, only where the net names state a voltage.
    const defs = new Map((project.library || []).map(d => [d.id, d]));
    const sheetNets = new Map();
    const bias = [], biasUnknown = [], power = [], powerUnknown = [];
    for (const p of parts) {
      const s = p.spec;
      if (s.kind !== "C" && s.kind !== "R" || !s.value || s.unparsed) continue;
      const mlcc = s.kind === "C" && (s.dielectric || s.technology === "ceramic" ||
        (!s.technology && s.package && !/tant|elec|polymer|alum/i.test(p.footprint + " " + p.e.description)));
      if (s.kind === "C" && !mlcc) continue;
      const nets = partNets(p.e, defs, sheetNets, project);
      const v = nets && nets.every(Boolean) ? nets.map(netVoltage) : null;
      const across = v && v.every(x => x != null) ? Math.abs(v[0] - v[1]) : null;
      if (s.kind === "C") {
        if (across == null) { biasUnknown.push(p.ref); continue; }
        if (s.voltage == null) { biasUnknown.push(p.ref); continue; }
        const class1 = s.dielectric === "C0G";
        const label = nets.join(" – ");
        if (s.voltage < across) bias.push({refs: p.ref, ids: [p.id], severity: "error", text: s.canonical + " rated " + formatAttr("voltage", s.voltage) + " sits across " + across + " V (" + label + ")."});
        else if (!class1 && s.voltage < 2 * across) bias.push({refs: p.ref, ids: [p.id], severity: "warning", text: s.canonical + " " + (s.dielectric || "MLCC") + " rated " + formatAttr("voltage", s.voltage) + " on " + across + " V (" + label + ") loses much of its capacitance to DC bias. Use " + (DERATE_VOLTAGES.find(x => x >= 2 * across) || 2 * across) + " V or more" + (s.dielectric ? "" : " (assumed MLCC from the " + s.package + " package)") + "."});
      } else {
        if (across == null || s.value === 0) { powerUnknown.push(p.ref); continue; }
        const watts = across * across / s.value;
        const rated = s.power ?? (s.package ? TYPICAL_POWER[s.package] : null);
        if (rated == null) { powerUnknown.push(p.ref); continue; }
        const how = s.power != null ? "rated " : "typically rated ";
        if (watts > rated) power.push({refs: p.ref, ids: [p.id], severity: "error", text: s.canonical + " dissipates " + formatPower(watts) + " across " + nets.join(" – ") + ", above its " + how + formatPower(rated) + "."});
        else if (watts > rated / 2) power.push({refs: p.ref, ids: [p.id], severity: "warning", text: s.canonical + " dissipates " + formatPower(watts) + " across " + nets.join(" – ") + ", over half its " + how + formatPower(rated) + "."});
      }
    }
    const worst = list => list.some(x => x.severity === "error") ? "error" : "warning";
    add("dc-bias", worst(bias), "Capacitor voltage and DC bias", "MLCCs should be rated at least twice the voltage across them (class II dielectrics).", bias);
    add("dc-bias-unknown", "info", "DC bias not checked", "The net names or ratings don't say the voltage, so Waffle can't tell.", biasUnknown.length ? [{refs: compress(biasUnknown), text: plural(biasUnknown.length, "capacitor")}] : []);
    add("power", worst(power), "Resistor power", "Dissipation from supply-to-supply voltages stated in net names.", power);
    add("power-unknown", "info", "Resistor power not checked", "Only resistors between two nets with stated voltages can be checked.", powerUnknown.length ? [{refs: compress(powerUnknown), text: plural(powerUnknown.length, "resistor")}] : []);
    return checks;
  }

  // ===================================================== optimised lines
  // The BOM as it would be after the chosen merge proposals.
  function optimisedLines(analysis, ids) {
    const chosen = new Set(ids == null ? analysis.proposals.filter(p => p.selected).map(p => p.id) : ids);
    const byKey = new Map(analysis.lines.map(l => [l.key, l]));
    const into = new Map();
    for (const p of analysis.proposals) {
      if (!p.applicable || !chosen.has(p.id)) continue;
      const keys = analysis.lines.filter(l => p.from.some(f => f.refs === compress(l.refs) && f.comment === l.comment)).map(l => l.key);
      const target = analysis.lines.find(l => p.from.some(f => f.target && f.refs === compress(l.refs) && f.comment === l.comment));
      for (const k of keys) into.set(k, {proposal: p, target});
    }
    const out = new Map();
    for (const l of analysis.lines) {
      const m = into.get(l.key);
      const base = m ? m.target : l;
      const key = m ? "p:" + m.proposal.id : l.key;
      let row = out.get(key);
      if (!row) out.set(key, row = {key, refs: [], qty: 0, comment: m ? m.proposal.target.comment : l.comment, footprint: base.footprint,
        package: base.package, kind: base.kind, value: base.value, valueKey: base.valueKey, description: base.description, smd: base.smd,
        mpn: base.mpn, manufacturer: base.manufacturer, supplierPn: base.supplierPn, spec: base.spec, merged: !!m});
      row.refs.push(...l.refs);
      row.qty += l.qty;
      if (!byKey.has(l.key)) continue;
    }
    const rows = [...out.values()];
    for (const r of rows) r.refs.sort(naturalCompare);
    return rows.sort((a, b) => naturalCompare(a.refs[0], b.refs[0]));
  }

  // ============================================================ suppliers
  const LCSC_CODE = /^C\d{3,10}$/i;
  // What may leave the machine for one line: an MPN, a supplier code, or a
  // value description. Nothing else from the project is ever included.
  function queryFor(line) {
    const mpn = clean(line.mpn), code = upper(line.supplierPn);
    const q = {mpn: mpn || null, lcsc: LCSC_CODE.test(code) ? code : null, text: null, kind: line.kind || null,
      valueKey: line.valueKey || null, package: line.package || null, spec: line.spec || null};
    if (!mpn && line.value && line.kind) {
      const s = line.spec || {};
      q.text = [line.value.replace(" ", ""), line.package, {R: "resistor", C: "capacitor", L: "inductor"}[line.kind],
        s.tolerance != null ? s.tolerance + "%" : "", s.dielectric || "", s.voltage != null ? s.voltage + "V" : ""].filter(Boolean).join(" ");
    }
    return q.mpn || q.lcsc || q.text ? q : null;
  }
  const queryKey = q => q.mpn ? "mpn:" + upper(q.mpn) : q.lcsc ? "lcsc:" + q.lcsc : "text:" + q.text;
  const normMpn = s => upper(s).replace(/\s+/g, "");
  function lifecycle(s) {
    const t = clean(s).toLowerCase();
    if (!t) return "unknown";
    if (/obsolete|discontinued|no longer/.test(t)) return "obsolete";
    if (/end of life|\beol\b|last time buy|\bltb\b/.test(t)) return "eol";
    if (/nrnd|not recommended|not for new/.test(t)) return "nrnd";
    if (/active|production|new product|^new/.test(t)) return "active";
    return "unknown";
  }
  function money(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    let s = String(v ?? "").replace(/[^\d.,-]/g, "");
    if (!s) return null;
    if (s.includes(",") && s.includes(".")) s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    else if (s.includes(",")) s = /^-?0,|,\d{1,2}$|,\d{4,}$/.test(s) ? s.replace(",", ".") : s.replace(/,/g, "");
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const integer = v => { const n = money(String(v ?? "").replace(/[^\d]/g, "")); return n == null ? null : Math.round(n); };
  const currencyOf = (v, fallback) => { const s = String(v ?? ""); return /€/.test(s) ? "EUR" : /£/.test(s) ? "GBP" : /¥|CN/.test(s) ? "CNY" : fallback; };

  async function request(ctx, url, init = {}) {
    const fetch = ctx.fetch || (globalThis.fetch ? globalThis.fetch.bind(globalThis) : null);
    if (!fetch) throw Error("Network access isn't available here.");
    // No cookies, referrer or cache: the request carries only what we put in it.
    const res = await fetch(url, {credentials: "omit", referrerPolicy: "no-referrer", cache: "no-store", ...init, signal: ctx.signal});
    if (!res || !res.ok) throw Error((ctx.name || "Supplier") + " answered " + (res ? res.status : "nothing") + ".");
    return res.json();
  }
  const form = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");

  // ---------------------------------------------------------------- Mouser
  // Mouser Search API v1 (https://api.mouser.com/api/docs/ui/index), key in the query string:
  //   POST https://api.mouser.com/api/v1/search/partnumber?apiKey=KEY  {SearchByPartRequest:{mouserPartNumber:"A|B", partSearchOptions:"Exact"}}
  //   POST https://api.mouser.com/api/v1/search/keyword?apiKey=KEY     {SearchByKeywordRequest:{keyword, records, startingRecord}}
  // Up to 10 part numbers per request, separated by "|"; about 30 requests a minute.
  function mouserParts(json) {
    if (json?.Errors?.length) throw Error("Mouser: " + (json.Errors[0].Message || "request refused") + ".");
    return (json?.SearchResults?.Parts || []).map(p => ({
      mpn: clean(p.ManufacturerPartNumber), manufacturer: clean(p.Manufacturer), description: clean(p.Description), lifecycle: lifecycle(p.LifecycleStatus),
      offers: [{supplier: "Mouser", sku: clean(p.MouserPartNumber), stock: integer(p.AvailabilityInStock ?? (/(\d[\d,.]*)\s*In Stock/i.exec(p.Availability || "") || [])[1]) ?? 0,
        moq: integer(p.Min) || 1, mult: integer(p.Mult) || 1, url: clean(p.ProductDetailUrl), lifecycle: lifecycle(p.LifecycleStatus),
        currency: clean(p.PriceBreaks?.[0]?.Currency) || currencyOf(p.PriceBreaks?.[0]?.Price, "USD"),
        priceBreaks: (p.PriceBreaks || []).map(b => ({qty: integer(b.Quantity), price: money(b.Price)})).filter(b => b.qty && b.price != null)}]
    }));
  }
  const mouser = {
    id: "mouser", name: "Mouser", network: true, fields: [{key: "apiKey", label: "Search API key"}], batch: 10, interval: 2100,
    docs: "https://www.mouser.com/api-search/",
    configured: s => !!s?.apiKey,
    async searchMany(queries, ctx) {
      const key = encodeURIComponent(ctx.settings.apiKey);
      const mpns = queries.filter(q => q.mpn).map(q => q.mpn);
      const out = new Map();
      if (mpns.length) {
        const json = await request(ctx, "https://api.mouser.com/api/v1/search/partnumber?apiKey=" + key, {method: "POST",
          headers: {"Content-Type": "application/json", Accept: "application/json"},
          body: JSON.stringify({SearchByPartRequest: {mouserPartNumber: mpns.join("|"), partSearchOptions: "Exact"}})});
        const parts = mouserParts(json);
        for (const q of queries) if (q.mpn) out.set(q, parts.filter(p => normMpn(p.mpn) === normMpn(q.mpn)));
      }
      for (const q of queries) {
        if (q.mpn) continue;
        const json = await request(ctx, "https://api.mouser.com/api/v1/search/keyword?apiKey=" + key, {method: "POST",
          headers: {"Content-Type": "application/json", Accept: "application/json"},
          body: JSON.stringify({SearchByKeywordRequest: {keyword: q.lcsc || q.text, records: 10, startingRecord: 0}})});
        out.set(q, mouserParts(json));
      }
      return out;
    }
  };

  // --------------------------------------------------------------- DigiKey
  // DigiKey Product Information API v4 (https://developer.digikey.com/), OAuth2 client credentials:
  //   POST https://api.digikey.com/v1/oauth2/token  form client_id, client_secret, grant_type=client_credentials
  //   POST https://api.digikey.com/products/v4/search/keyword  {Keywords, Limit, Offset}
  //     headers X-DIGIKEY-Client-Id, Authorization: Bearer, X-DIGIKEY-Locale-Site/-Language/-Currency
  const tokens = new Map();
  async function bearer(ctx, id, url, body) {
    const memo = tokens.get(id);
    if (memo && memo.until > Date.now() && memo.secret === body.client_secret) return memo.token;
    const json = await request(ctx, url, {method: "POST", headers: {"Content-Type": "application/x-www-form-urlencoded", Accept: "application/json"}, body: form(body)});
    if (!json?.access_token) throw Error((ctx.name || "Supplier") + " didn't issue a token. Check the client ID and secret.");
    tokens.set(id, {token: json.access_token, secret: body.client_secret, until: Date.now() + Math.max(60, (json.expires_in || 600) - 60) * 1000});
    return json.access_token;
  }
  function digikeyParts(json) {
    const currency = clean(json?.SearchLocaleUsed?.Currency) || "USD";
    const list = [...(json?.ExactMatches || []), ...(json?.Products || [])];
    const seen = new Set();
    return list.filter(p => { const k = p.ManufacturerProductNumber; if (seen.has(k)) return false; seen.add(k); return true; }).map(p => {
      const life = lifecycle(p.ProductStatus?.Status);
      const variations = p.ProductVariations?.length ? p.ProductVariations : [{DigiKeyProductNumber: p.DigiKeyProductNumber, StandardPricing: p.StandardPricing, MinimumOrderQuantity: 1}];
      return {mpn: clean(p.ManufacturerProductNumber), manufacturer: clean(p.Manufacturer?.Name), description: clean(p.Description?.ProductDescription || p.Description?.DetailedDescription),
        lifecycle: life, offers: variations.map(v => ({supplier: "DigiKey", sku: clean(v.DigiKeyProductNumber), stock: integer(v.QuantityAvailableforPackageType ?? p.QuantityAvailable) ?? 0,
          moq: integer(v.MinimumOrderQuantity) || 1, mult: 1, currency, lifecycle: life, url: clean(p.ProductUrl), packaging: clean(v.PackageType?.Name),
          priceBreaks: (v.StandardPricing || []).map(b => ({qty: integer(b.BreakQuantity), price: money(b.UnitPrice)})).filter(b => b.qty && b.price != null)}))};
    });
  }
  const digikey = {
    id: "digikey", name: "DigiKey", network: true, interval: 600,
    fields: [{key: "clientId", label: "Client ID"}, {key: "clientSecret", label: "Client secret"}, {key: "site", label: "Site (US, UK, DE…)", optional: true}, {key: "currency", label: "Currency (USD…)", optional: true}],
    docs: "https://developer.digikey.com/products/product-information-v4",
    configured: s => !!(s?.clientId && s?.clientSecret),
    async search(q, ctx) {
      const s = ctx.settings;
      const token = await bearer(ctx, "digikey", "https://api.digikey.com/v1/oauth2/token", {client_id: s.clientId, client_secret: s.clientSecret, grant_type: "client_credentials"});
      const json = await request(ctx, "https://api.digikey.com/products/v4/search/keyword", {method: "POST",
        headers: {"Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token, "X-DIGIKEY-Client-Id": s.clientId,
          "X-DIGIKEY-Locale-Site": s.site || "US", "X-DIGIKEY-Locale-Language": "en", "X-DIGIKEY-Locale-Currency": s.currency || "USD"},
        body: JSON.stringify({Keywords: q.mpn || q.lcsc || q.text, Limit: 10, Offset: 0})});
      return digikeyParts(json);
    }
  };

  // ---------------------------------------------------------- Octopart/Nexar
  // Nexar Supply GraphQL (https://support.nexar.com/), OAuth2 client credentials:
  //   POST https://identity.nexar.com/connect/token  form grant_type=client_credentials, client_id, client_secret
  //   POST https://api.nexar.com/graphql  {query, variables}: supSearchMpn for part numbers, supSearch otherwise.
  const NEXAR_PART = "part { mpn manufacturer { name } shortDescription specs { attribute { shortname } displayValue } " +
    "sellers(authorizedOnly: true) { company { name } offers { sku inventoryLevel moq packaging clickUrl prices { quantity price currency } } } }";
  function nexarParts(json, field) {
    if (json?.errors?.length) throw Error("Nexar: " + (json.errors[0].message || "query refused") + ".");
    return (json?.data?.[field]?.results || []).map(r => r.part).filter(Boolean).map(p => {
      const life = lifecycle((p.specs || []).find(s => /lifecycle/i.test(s.attribute?.shortname || ""))?.displayValue);
      return {mpn: clean(p.mpn), manufacturer: clean(p.manufacturer?.name), description: clean(p.shortDescription), lifecycle: life,
        offers: (p.sellers || []).flatMap(s => (s.offers || []).map(o => {
          const prices = o.prices || [];
          return {supplier: clean(s.company?.name) || "Nexar", sku: clean(o.sku), stock: integer(o.inventoryLevel) ?? 0, moq: integer(o.moq) || 1, mult: 1,
            currency: clean(prices[0]?.currency) || "USD", lifecycle: life, url: clean(o.clickUrl), packaging: clean(o.packaging),
            priceBreaks: prices.map(b => ({qty: integer(b.quantity), price: money(b.price)})).filter(b => b.qty && b.price != null)};
        }))};
    });
  }
  const nexar = {
    id: "nexar", name: "Octopart (Nexar)", network: true, interval: 300,
    fields: [{key: "clientId", label: "Client ID"}, {key: "clientSecret", label: "Client secret"}],
    docs: "https://nexar.com/api",
    configured: s => !!(s?.clientId && s?.clientSecret),
    async search(q, ctx) {
      const s = ctx.settings;
      const token = await bearer(ctx, "nexar", "https://identity.nexar.com/connect/token", {grant_type: "client_credentials", client_id: s.clientId, client_secret: s.clientSecret});
      const field = q.mpn ? "supSearchMpn" : "supSearch";
      const query = "query AtriumSearch($q: String!, $limit: Int!) { " + field + "(q: $q, limit: $limit) { results { " + NEXAR_PART + " } } }";
      const json = await request(ctx, "https://api.nexar.com/graphql", {method: "POST",
        headers: {"Content-Type": "application/json", Accept: "application/json", Authorization: "Bearer " + token},
        body: JSON.stringify({query, variables: {q: q.mpn || q.lcsc || q.text, limit: 5}})});
      return nexarParts(json, field);
    }
  };

  // ------------------------------------------------------------- LCSC / JLC
  // TODO(lcsc): LCSC's product API is issued to approved partners with signed
  // requests, and its specification isn't public. Not implemented; use the
  // offline JLC parts library below, or Nexar, which lists LCSC as a seller.
  const lcsc = {id: "lcsc", name: "LCSC", network: true, stub: true, fields: [],
    docs: "https://www.lcsc.com/", note: "Not available: LCSC's API is partner-only and undocumented.",
    configured: () => false, async search() { throw Error("The LCSC provider isn't implemented (partner-only API)."); }};
  // TODO(jlc): JLCPCB's components API is likewise restricted to approved
  // customers. Basic/extended classes come from the offline library instead.
  const jlcApi = {id: "jlcpcb", name: "JLCPCB API", network: true, stub: true, fields: [],
    docs: "https://jlcpcb.com/parts", note: "Not available: JLCPCB's API is restricted. Import the parts library CSV instead.",
    configured: () => false, async search() { throw Error("The JLCPCB API provider isn't implemented (restricted API)."); }};

  // Offline JLC parts library from a CSV the user imports (JLCPCB's library
  // download or a community dump). No network. Kept in memory, filtered to
  // the parts this BOM can use, so a large file costs little afterwards.
  const ALIASES = {lcsc: ["LCSC PART", "LCSC PART #", "LCSC", "LCSC PART NUMBER", "JLCPCB PART #", "JLC PART", "PART #", "C"],
    mpn: ["MFR.PART", "MFR.PART #", "MFR PART", "MANUFACTURER PART", "MANUFACTURER PART NUMBER", "MPN"],
    package: ["PACKAGE", "FOOTPRINT", "CASE"], type: ["LIBRARY TYPE", "TYPE", "BASIC/EXTENDED", "BASIC"],
    manufacturer: ["MANUFACTURER", "MFR"], description: ["DESCRIPTION"], stock: ["STOCK", "QUANTITY"], price: ["PRICE", "PRICES"],
    category: ["FIRST CATEGORY", "SECOND CATEGORY", "CATEGORY"]};
  function eachCsvRow(text, fn) {
    let row = [], field = "", quoted = false, i = 0;
    const s = String(text).replace(/^﻿/, "");
    for (; i < s.length; i++) {
      const ch = s[i];
      if (quoted) {
        if (ch === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; } else field += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { row.push(field); field = ""; }
      else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && s[i + 1] === "\n") i++;
        row.push(field); field = "";
        if (row.length > 1 || row[0]) { if (fn(row) === false) return; }
        row = [];
      } else field += ch;
    }
    if (field || row.length) { row.push(field); fn(row); }
  }
  function priceList(s) {
    const out = [];
    const re = /(\d+)\s*(?:-\s*(\d*))?\s*:\s*\$?(\d*\.?\d+(?:e-?\d+)?)/gi;
    let m;
    while ((m = re.exec(String(s ?? "")))) out.push({qty: Number(m[1]), price: Number(m[3])});
    if (!out.length) { const n = money(s); if (n != null) out.push({qty: 1, price: n}); }
    return out.sort((a, b) => a.qty - b.qty);
  }
  function jlcCatalogue(text, options = {}) {
    const want = options.want || null; // {mpn:Set, lcsc:Set, values:Set("valueKey|package")}
    const cat = {rows: 0, kept: 0, byLcsc: new Map(), byMpn: new Map(), byValue: new Map()};
    let cols = null;
    eachCsvRow(text, row => {
      if (!cols) {
        const head = row.map(h => upper(h));
        cols = {};
        for (const [k, names] of Object.entries(ALIASES)) { const i = head.findIndex(h => names.includes(h)); if (i >= 0) cols[k] = i; }
        if (cols.lcsc == null && cols.mpn == null) throw Error("This CSV has no LCSC Part or MFR.Part column.");
        return;
      }
      cat.rows++;
      const get = k => cols[k] == null ? "" : clean(row[cols[k]]);
      const code = upper(get("lcsc")), mpn = get("mpn"), pkg = packageOf("", get("package")) || get("package");
      const desc = get("description");
      const parsed = parseText(desc + " " + get("package"));
      const kind = parsed.kind || (/resistor/i.test(get("category") + desc) ? "R" : /capacitor/i.test(get("category") + desc) ? "C" : /inductor/i.test(get("category") + desc) ? "L" : null);
      const valueKey = kind && parsed.value != null && !(parsed.bare && kind !== "R") ? kind + Number(parsed.value.toPrecision(6)) : null;
      const vk = valueKey && pkg ? valueKey + "|" + pkg : null;
      if (want && !(want.lcsc.has(code) || want.mpn.has(normMpn(mpn)) || (vk && want.values.has(vk)))) return;
      const type = get("type");
      const part = {mpn, manufacturer: get("manufacturer"), description: desc, package: pkg, lifecycle: "unknown", kind, valueKey,
        spec: {...parsed, kind, package: pkg},
        offers: [{supplier: "JLCPCB", sku: code, stock: integer(get("stock")) ?? 0, moq: 1, mult: 1, currency: "USD", lifecycle: "unknown",
          basic: /^basic$/i.test(type) ? true : /extended/i.test(type) ? false : null, libraryType: type, priceBreaks: priceList(get("price"))}]};
      cat.kept++;
      if (code) cat.byLcsc.set(code, part);
      if (mpn) { const k = normMpn(mpn); if (!cat.byMpn.has(k)) cat.byMpn.set(k, []); cat.byMpn.get(k).push(part); }
      if (vk) { if (!cat.byValue.has(vk)) cat.byValue.set(vk, []); cat.byValue.get(vk).push(part); }
    });
    return cat;
  }
  const jlcLibrary = {
    id: "jlc-library", name: "JLCPCB parts library (offline CSV)", network: false, fields: [],
    docs: "https://jlcpcb.com/parts", configured: s => !!s?.catalogue,
    async search(q, ctx) {
      const cat = ctx.settings.catalogue;
      if (!cat) return [];
      if (q.lcsc && cat.byLcsc.has(q.lcsc)) return [cat.byLcsc.get(q.lcsc)];
      if (q.mpn) return cat.byMpn.get(normMpn(q.mpn)) || [];
      if (q.valueKey && q.package) return cat.byValue.get(q.valueKey + "|" + q.package) || [];
      return [];
    }
  };
  const registry = new Map([mouser, digikey, nexar, lcsc, jlcApi, jlcLibrary].map(p => [p.id, p]));
  function register(def) {
    if (!def || typeof def.id !== "string" || typeof (def.search || def.searchMany) !== "function") throw Error("A provider needs an id and a search function.");
    registry.set(def.id, {network: true, fields: [], configured: () => true, ...def});
    return registry.get(def.id);
  }
  // A bound provider: {id, name, search(mpnOrQuery) -> Promise<parts[]>, fetch}.
  function provider(id, options = {}) {
    const def = registry.get(id);
    if (!def) throw Error("Unknown supplier " + id + ".");
    const ctx = {fetch: options.fetch, settings: options.settings || {}, signal: options.signal, name: def.name};
    const search = async q => {
      const query = typeof q === "string" ? (LCSC_CODE.test(q.trim()) ? {lcsc: q.trim().toUpperCase()} : {mpn: q.trim()}) : q;
      if (def.search) return def.search(query, ctx);
      return (await def.searchMany([query], ctx)).get(query) || [];
    };
    return {id, name: def.name, network: def.network, stub: !!def.stub, search, fetch: ctx.fetch, def, ctx};
  }

  // ------------------------------------------------------------- settings
  const SETTINGS_KEY = "atrium.suppliers", CACHE_KEY = "atrium.suppliers.cache";
  const DEFAULT_SETTINGS = {version: 1, providers: {}, quantity: 10, jlc: {enabled: false, extendedFee: 3}, sessionCache: true};
  function loadSettings(storage = globalThis.localStorage) {
    let v = null;
    try { v = JSON.parse(storage?.getItem(SETTINGS_KEY) || "null"); } catch {}
    const s = {...DEFAULT_SETTINGS, ...(v && typeof v === "object" ? v : {})};
    s.providers = s.providers && typeof s.providers === "object" ? s.providers : {};
    s.jlc = {...DEFAULT_SETTINGS.jlc, ...(s.jlc || {})};
    return s;
  }
  function saveSettings(s, storage = globalThis.localStorage) {
    const copy = JSON.parse(JSON.stringify({...s, providers: Object.fromEntries(Object.entries(s.providers || {}).map(([k, v]) => {
      const {catalogue, ...rest} = v || {}; return [k, rest]; }))}));
    try { storage?.setItem(SETTINGS_KEY, JSON.stringify(copy)); return true; } catch { return false; }
  }

  // ---------------------------------------------------------------- cache
  const memoCache = new Map();
  const TTL = 6 * 3600 * 1000;
  function cacheGet(key, session) {
    const now = Date.now();
    let hit = memoCache.get(key);
    if (!hit && session) {
      try { const all = JSON.parse(session.getItem(CACHE_KEY) || "{}"); hit = all[key]; if (hit) memoCache.set(key, hit); } catch {}
    }
    return hit && now - hit.t < TTL ? hit : null;
  }
  function cacheSet(key, parts, session) {
    const entry = {t: Date.now(), parts};
    memoCache.set(key, entry);
    if (memoCache.size > 4000) memoCache.delete(memoCache.keys().next().value);
    if (!session) return;
    try {
      const all = JSON.parse(session.getItem(CACHE_KEY) || "{}");
      all[key] = entry;
      const keys = Object.keys(all);
      if (keys.length > 600) for (const k of keys.slice(0, keys.length - 600)) delete all[k];
      session.setItem(CACHE_KEY, JSON.stringify(all));
    } catch { try { session.removeItem(CACHE_KEY); } catch {} }
  }
  function clearCache(session) { memoCache.clear(); try { session?.removeItem(CACHE_KEY); } catch {} }

  // Parts a provider returned that really are this line's part.
  function matchParts(line, q, parts) {
    if (q.mpn) {
      const exact = parts.filter(p => normMpn(p.mpn) === normMpn(q.mpn));
      return line.manufacturer ? exact.filter(p => !p.manufacturer || sameMaker(p.manufacturer, line.manufacturer)) : exact;
    }
    if (q.lcsc) return parts.filter(p => p.offers.some(o => upper(o.sku) === q.lcsc));
    if (!line.spec || !line.valueKey) return [];
    return parts.filter(p => {
      const s = p.spec || {...parseText(p.description + " " + (p.package || "")), package: p.package ? packageOf("", p.package) || p.package : null};
      const kind = s.kind || line.kind;
      if (kind !== line.kind || s.value == null || kind + Number(s.value.toPrecision(6)) !== line.valueKey) return false;
      const pkg = s.package || (p.package && packageOf("", p.package));
      if (line.package && pkg !== line.package) return false;
      return dominates({...s, mpn: "", supplierPn: ""}, {...line.spec, mpn: "", supplierPn: ""}).ok;
    });
  }
  const sameMaker = (a, b) => { const w = s => upper(s).split(/[^A-Z0-9]+/).filter(x => x.length > 2); const x = w(a); return w(b).some(t => x.includes(t)) || !x.length; };

  const sleep = (ms, signal) => new Promise((res, rej) => {
    if (!ms) return res();
    const t = setTimeout(res, ms);
    signal?.addEventListener?.("abort", () => { clearTimeout(t); rej(Error("Cancelled.")); });
  });
  // Look up every line at every enabled provider. Async and cancellable; it
  // yields between requests so the UI keeps responding.
  async function price(lines, options = {}) {
    const providers = (options.providers || []).map(p => typeof p === "string" ? provider(p, options) : p);
    const session = options.sessionCache === false ? null : options.session ?? (() => { try { return globalThis.sessionStorage; } catch { return null; } })();
    const result = {lines: new Map(), errors: [], requests: 0, cached: 0};
    const jobs = [];
    for (const line of lines) {
      const q = queryFor(line);
      result.lines.set(line.key, {query: q, parts: [], offers: [], providers: []});
      if (q) jobs.push({line, q});
    }
    const total = jobs.length * providers.length;
    let done = 0;
    const tick = () => options.onProgress?.({done, total});
    await Promise.all(providers.map(async pv => {
      const def = pv.def, todo = [];
      for (const j of jobs) {
        const key = pv.id + "|" + queryKey(j.q);
        const hit = cacheGet(key, session);
        if (hit) { record(j, pv, hit.parts); result.cached++; done++; } else if (!options.cacheOnly) todo.push({...j, key});
        else done++;
      }
      tick();
      const size = def.searchMany ? def.batch || 10 : 1;
      for (let i = 0; i < todo.length; i += size) {
        if (options.signal?.aborted) throw Error("Cancelled.");
        const batch = todo.slice(i, i + size);
        try {
          // Only these query objects reach the provider: MPN, supplier code or value text.
          const safe = batch.map(b => ({mpn: b.q.mpn, lcsc: b.q.lcsc, text: b.q.text, valueKey: b.q.valueKey, package: b.q.package}));
          result.requests++;
          let found;
          if (def.searchMany) found = await def.searchMany(safe, {...pv.ctx, signal: options.signal});
          else found = new Map([[safe[0], await def.search(safe[0], {...pv.ctx, signal: options.signal})]]);
          batch.forEach((b, k) => { const parts = slim(found.get(safe[k]) || []); cacheSet(b.key, parts, session); record(b, pv, parts); });
        } catch (e) {
          if (options.signal?.aborted) throw e;
          result.errors.push({provider: pv.id, message: e.message || String(e)});
          if (result.errors.filter(x => x.provider === pv.id).length >= 3) { done += todo.length - i - batch.length; break; }
        }
        done += batch.length; tick();
        if (i + size < todo.length) await sleep(options.interval ?? def.interval ?? 0, options.signal);
      }
    }));
    return result;
    function record(job, pv, parts) {
      const slot = result.lines.get(job.line.key);
      const ok = matchParts(job.line, job.q, parts);
      slot.providers.push(pv.id);
      for (const p of ok) { slot.parts.push(p); for (const o of p.offers) slot.offers.push({...o, mpn: p.mpn, manufacturer: p.manufacturer, lifecycle: o.lifecycle !== "unknown" ? o.lifecycle : p.lifecycle, provider: pv.id}); }
    }
  }
  const slim = parts => parts.slice(0, 20).map(p => ({mpn: p.mpn, manufacturer: p.manufacturer, description: (p.description || "").slice(0, 200), package: p.package || null,
    lifecycle: p.lifecycle, spec: p.spec ? plainSpec(p.spec) : undefined, offers: (p.offers || []).slice(0, 12)}));

  function priceAt(breaks, qty) {
    const list = (breaks || []).filter(b => b.qty > 0 && b.price >= 0).sort((a, b) => a.qty - b.qty);
    if (!list.length) return null;
    const buy = Math.max(qty, list[0].qty);
    let unit = list[0].price;
    for (const b of list) if (b.qty <= buy) unit = b.price;
    return {buy, unit};
  }
  // Choose an offer per line for `boards` boards and total the build.
  function cost(lines, priced, options = {}) {
    const boards = Math.max(1, Math.floor(options.boards || options.quantity || 1));
    const allowed = options.suppliers?.length ? new Set(options.suppliers.map(upper)) : null;
    const jlc = options.jlc?.enabled ? Math.max(0, Number(options.jlc.extendedFee) || 0) : 0;
    const currencies = new Map();
    for (const slot of priced.lines.values()) for (const o of slot.offers) currencies.set(o.currency, (currencies.get(o.currency) || 0) + 1);
    const currency = options.currency || [...currencies].sort((a, b) => b[1] - a[1])[0]?.[0] || "USD";
    const rows = [], suppliers = new Map();
    let total = 0, fees = 0, extended = 0;
    for (const line of lines) {
      const need = line.qty * boards;
      const slot = priced.lines.get(line.key);
      const offers = (slot?.offers || []).filter(o => o.currency === currency && (!allowed || allowed.has(upper(o.supplier)) || allowed.has(upper(o.provider))));
      const row = {key: line.key, refs: line.refs, comment: line.comment, qty: line.qty, need, chosen: null, flags: [], queried: !!slot?.query, matched: !!slot?.parts.length};
      let best = null;
      const bySupplier = new Map();
      for (const o of offers) {
        let buy = Math.max(need, o.moq || 1);
        if (o.mult > 1) buy = Math.ceil(buy / o.mult) * o.mult;
        const p = priceAt(o.priceBreaks, buy);
        if (!p) continue;
        const fee = jlc && o.basic !== true && /JLC/i.test(o.supplier) ? jlc : 0;
        const c = {offer: o, buy: p.buy, unit: p.unit, lineCost: p.unit * p.buy, fee, total: p.unit * p.buy + fee, inStock: o.stock >= need};
        if (c.inStock) {
          const prev = bySupplier.get(o.supplier);
          if (!prev || c.lineCost < prev.lineCost) bySupplier.set(o.supplier, c);
          if (!best || c.total < best.total - 1e-12 || (Math.abs(c.total - best.total) < 1e-12 && o.basic && !best.offer.basic)) best = c;
        }
      }
      for (const [s, c] of bySupplier) {
        const t = suppliers.get(s) || {supplier: s, lines: 0, cost: 0, fees: 0};
        t.lines++; t.cost += c.lineCost; t.fees += c.fee;
        suppliers.set(s, t);
      }
      if (!slot?.query) row.flags.push("no-query");
      else if (!slot.parts.length) row.flags.push("no-match");
      else if (!best) row.flags.push("out-of-stock");
      if (best) {
        row.chosen = {supplier: best.offer.supplier, sku: best.offer.sku, mpn: best.offer.mpn, manufacturer: best.offer.manufacturer, unit: best.unit, buy: best.buy,
          lineCost: best.lineCost, fee: best.fee, stock: best.offer.stock, lifecycle: best.offer.lifecycle, basic: best.offer.basic ?? null, url: best.offer.url || ""};
        total += best.total; fees += best.fee; if (best.fee) extended++;
        if (["eol", "nrnd", "obsolete"].includes(best.offer.lifecycle)) row.flags.push(best.offer.lifecycle);
      } else if (slot?.parts.length) {
        const life = slot.parts.map(p => p.lifecycle).find(l => ["eol", "nrnd", "obsolete"].includes(l));
        if (life) row.flags.push(life);
        row.bestStock = Math.max(0, ...slot.offers.map(o => o.stock || 0));
      }
      rows.push(row);
    }
    const priced_ = rows.filter(r => r.chosen).length;
    return {boards, currency, mixedCurrencies: currencies.size > 1, rows, total, perBoard: total / boards, fees, extendedParts: extended,
      pricedLines: priced_, lineCount: rows.length,
      suppliers: [...suppliers.values()].map(s => ({...s, missing: rows.length - s.lines, total: s.cost + s.fees, perBoard: (s.cost + s.fees) / boards}))
        .sort((a, b) => b.lines - a.lines || a.total - b.total),
      outOfStock: rows.filter(r => r.flags.includes("out-of-stock")).map(r => r.refs),
      lifecycle: rows.filter(r => r.flags.some(f => ["eol", "nrnd", "obsolete"].includes(f))).map(r => ({refs: r.refs, status: r.flags.find(f => ["eol", "nrnd", "obsolete"].includes(f))}))};
  }

  // ===================================================== assign part numbers
  // Write the supplier part a real lookup found onto the parts (JLC-ready BOM). Only offers
  // chosen by `cost` from `price` results (an imported JLC parts CSV, or a supplier the user
  // enabled and keyed) are used; nothing is guessed or generated. LCSC and JLCPCB codes go to
  // the part's "LCSC #" (or the LCSC-style key it already has), other suppliers to "Supplier" and
  // "Supplier Part Number". "JLC Part Type" (Basic / Extended) is written when the source says
  // which, and an empty MPN / Manufacturer is filled from the offer. Lines merged by a proposal
  // that isn't applied yet are skipped: their parts still differ.
  const LCSC_KEY = /^(LCSC|JLC(PCB)?)( ?(PART ?(NUMBER|NO\.?|#)?|PN|#))?$/;
  function assignments(project, analysis, costing, options = {}) {
    const out = {changes: [], lines: [], skipped: []};
    if (!costing) return out;
    const byRef = new Map();
    for (const doc of project.documents || []) for (const i of doc.items || []) if (i.kind === "part" && i.ref) {
      if (!byRef.has(i.ref)) byRef.set(i.ref, []);
      byRef.get(i.ref).push({doc, item: i});
    }
    const defs = new Map((project.library || []).map(d => [d.id, d]));
    const lines = new Map(analysis.lines.map(l => [l.key, l]));
    for (const row of costing.rows) {
      const c = row.chosen, line = lines.get(row.key);
      if (!c || !clean(c.sku)) { if (line && row.queried) out.skipped.push({refs: compress(row.refs), reason: row.flags.includes("out-of-stock") ? "out of stock" : "no match"}); continue; }
      if (!line) { out.skipped.push({refs: compress(row.refs), reason: "merged by a proposal that isn't applied"}); continue; }
      const lcsc = /^(LCSC|JLC)/i.test(c.supplier) && LCSC_CODE.test(upper(c.sku));
      out.lines.push({refs: compress(row.refs), supplier: c.supplier, sku: upper(c.sku), basic: c.basic, mpn: c.mpn || ""});
      for (const ref of row.refs) for (const {doc, item} of byRef.get(ref) || []) {
        const params = {...(defs.get(item.def)?.parameters || {}), ...(item.parameters || {})}, keys = Object.keys(params);
        const keyOf = (re, fallback) => keys.find(k => re.test(paramKey(k))) || fallback;
        const want = [];
        if (lcsc) want.push([keyOf(LCSC_KEY, "LCSC #"), upper(c.sku)]);
        else want.push([keyOf(/^SUPPLIER$/, "Supplier"), c.supplier], [keyOf(/^SUPPLIER ?(PART ?(NUMBER|NO\.?|#)|PN|P\/N)$/, "Supplier Part Number"), clean(c.sku)]);
        if (c.basic === true || c.basic === false) want.push([keyOf(/^JLC PART TYPE$|^BASIC\/EXTENDED$/, "JLC Part Type"), c.basic ? "Basic" : "Extended"]);
        if (options.fillMpn !== false && c.mpn && !firstValue(rawParams(item, defs.get(item.def)).mpn)) {
          want.push([keyOf(CATEGORIES[0][1], "Manufacturer Part Number"), clean(c.mpn)]);
          if (c.manufacturer && !firstValue(rawParams(item, defs.get(item.def)).manufacturer)) want.push([keyOf(CATEGORIES[1][1], "Manufacturer"), clean(c.manufacturer)]);
        }
        for (const [key, value] of want) {
          const before = params[key] ?? undefined;
          if (clean(before) === value) continue;
          if (clean(before) && !options.overwrite) { out.skipped.push({refs: ref, reason: key + " already set to " + clean(before)}); continue; }
          const own = item.parameters && Object.prototype.hasOwnProperty.call(item.parameters, key) ? item.parameters[key] : undefined;
          out.changes.push({doc: doc.id, id: item.id, ref, key, before: own, after: value});
        }
      }
    }
    return out;
  }
  // Apply assignments() in one step (wrap in the editor's edit() for one undo step).
  function assign(project, plan) {
    const docs = new Map(project.documents.map(d => [d.id, d])), todo = [];
    for (const c of plan.changes) {
      const item = docs.get(c.doc)?.items.find(i => i.id === c.id);
      if (!item) throw Error(c.ref + " is no longer in the design. Look the parts up again.");
      const cur = item.parameters && Object.prototype.hasOwnProperty.call(item.parameters, c.key) ? item.parameters[c.key] : undefined;
      if (cur !== c.before) throw Error(c.ref + " changed since the lookup. Look the parts up again.");
      todo.push([item, c]);
    }
    for (const [item, c] of todo) { if (!item.parameters || typeof item.parameters !== "object") item.parameters = {}; item.parameters[c.key] = c.after; }
    return {changed: todo.length, parts: new Set(todo.map(([i]) => i.id)).size, lines: plan.lines.length};
  }

  // ============================================================== report
  // An AtriumBOM report object (for csv/xlsx/html) of the optimised BOM.
  function report(project, analysis, options = {}) {
    const lines = optimisedLines(analysis, options.selected);
    const costing = options.costing || null;
    const byKey = new Map((costing?.rows || []).map(r => [r.key, r]));
    const columns = [{key: "line", label: "Line #", numeric: true}, {key: "comment", label: "Comment"}, {key: "designator", label: "Designator"},
      {key: "footprint", label: "Footprint"}, {key: "quantity", label: "Quantity", numeric: true}, {key: "manufacturer", label: "Manufacturer"},
      {key: "mpn", label: "Manufacturer Part Number"}, {key: "supplierPn", label: "Supplier Part Number"}];
    if (costing) columns.push({key: "supplier", label: "Supplier"}, {key: "sku", label: "Supplier SKU"}, {key: "buy", label: "Order qty", numeric: true},
      {key: "unit", label: "Unit price (" + costing.currency + ")", numeric: true}, {key: "cost", label: "Line cost (" + costing.currency + ")", numeric: true},
      {key: "stock", label: "Stock", numeric: true}, {key: "status", label: "Status"});
    const round = n => Math.round(n * 1e5) / 1e5;
    const rows = lines.map((l, i) => {
      const c = byKey.get(l.key);
      const row = [i + 1, l.comment, compress(l.refs), l.footprint, l.qty, l.manufacturer, l.mpn, l.supplierPn];
      if (costing) row.push(c?.chosen?.supplier || "", c?.chosen?.sku || "", c?.chosen ? c.chosen.buy : "", c?.chosen ? round(c.chosen.unit) : "",
        c?.chosen ? round(c.chosen.lineCost + c.chosen.fee) : "", c?.chosen ? c.chosen.stock : "", [c?.chosen?.basic === true ? "JLC basic" : c?.chosen?.basic === false ? "JLC extended" : "", ...(c?.flags || [])].filter(Boolean).join(", "));
      return row;
    });
    const now = options.now ? new Date(options.now) : new Date();
    return {title: "Optimised Bill of Materials", project: clean(project.name) || "Untitled",
      source: (analysis.source === "pcb" ? "Board" : "Schematic") + (costing ? " · " + plural(costing.boards, "board") + " · " + costing.currency + " " + costing.total.toFixed(2) + " per build" : ""),
      date: options.date || now.toISOString().slice(0, 10), created: options.created || now.toISOString().replace(/\.\d+Z$/, "Z"),
      totalParts: analysis.summary.parts, lineCount: rows.length, excluded: analysis.summary.excluded, titleBlock: options.titleBlock !== false,
      columns, rows};
  }

  // A compact, JSON-friendly result for automation (MCP).
  function summarise(analysis, options = {}) {
    const limit = options.limit ?? 100;
    return {summary: analysis.summary, ms: analysis.ms,
      proposals: analysis.proposals.slice(0, limit).map(p => ({id: p.id, type: p.type, subtype: p.subtype, applicable: p.applicable, selected: p.selected,
        confidence: p.confidence, title: p.title, explanation: p.explanation, caveats: p.caveats, savings: p.savings,
        from: p.from, target: {comment: p.target.comment, description: p.target.description, mpn: p.target.mpn}, changes: p.changes.length})),
      proposals_total: analysis.proposals.length,
      checks: analysis.checks.map(c => ({...c, items: c.items.slice(0, limit).map(({keys, ids, ...it}) => it)}))};
  }

  // ============================================================== hints
  // The suggestions the BOM Lines grid shows inline (bom.js): merges, package and E-series advice,
  // and the DC-bias / power warnings, each resolved to the part ids it concerns so the grid can
  // mark its own (differently grouped) lines. `groups` holds one id list per optimiser line; for a
  // merge the first group is the line that is kept. DOM-free.
  const HINT_CHECKS = {"e-series": "series", "dc-bias": "bias", power: "power"};
  function hints(analysis, options = {}) {
    const dismissed = options.dismissed, list = [], byPart = new Map();
    const idsOf = new Map((analysis?.lines || []).map(l => [l.key, l.ids || []]));
    const add = h => {
      if (dismissed?.has?.(h.id)) return;
      list.push(h);
      for (const id of h.parts) { const at = byPart.get(id); if (!at) byPart.set(id, [h]); else if (!at.includes(h)) at.push(h); }
    };
    for (const p of analysis?.proposals || []) {
      const groups = (p.keys || []).map(k => idsOf.get(k) || []);
      add({id: p.id, kind: p.type === "merge" ? "merge" : p.subtype === "package" ? "package" : "cover", proposal: p.id,
        severity: p.applicable && p.confidence === "safe" ? "info" : "check", applicable: !!p.applicable, subtype: p.subtype,
        title: p.title, text: p.explanation, caveats: p.caveats || [], savings: p.savings, from: p.from, target: p.target, groups, parts: groups.flat()});
    }
    for (const c of analysis?.checks || []) {
      const kind = HINT_CHECKS[c.id];
      if (!kind) continue;
      for (const it of c.items) {
        // Only what needs a look: E48/E96 notes and E24 capacitors stay in the Optimise tab.
        if (it.severity !== "warning" && it.severity !== "error") continue;
        const ids = it.ids || (it.keys || []).flatMap(k => idsOf.get(k) || []);
        if (!ids.length) continue;
        add({id: c.id + "-" + hash(it.refs + "\u0001" + it.text), kind, check: c.id, severity: it.severity, applicable: false,
          title: c.title, text: it.text, caveats: [], savings: null, from: [], target: null, groups: [ids], parts: ids});
      }
    }
    const lines = list.reduce((n, h) => n + (h.applicable && h.savings ? h.savings.lines : 0), 0);
    return {list, byPart, count: list.length, lines};
  }
  // A key for "the BOM content the analysis read" when the caller has no undo revision to offer.
  function contentKey(collected) {
    let s = (collected?.source || "") + "\u0002" + (collected?.board?.id || "") + "\u0002" + (collected?.excluded?.length || 0);
    for (const e of collected?.parts || []) {
      s += "\u0003" + e.id + "\u0001" + e.ref + "\u0001" + e.comment + "\u0001" + e.footprint + "\u0001" + (e.mate?.id || "");
      for (const k in e.params) s += "\u0001" + k + "=" + e.params[k];
      const nets = (e.side === "pcb" ? e.item : e.mate?.item)?.pinNets;
      if (nets) for (const k in nets) s += "\u0001" + k + ":" + nets[k];
    }
    return s.length + ":" + hash(s);
  }
  // One analysis per project and key (an undo revision or contentKey), so reopening the BOM, sorting,
  // filtering or switching tabs never analyses twice.
  const analyses = new WeakMap();
  function cachedAnalysis(project, key) { const c = project && analyses.get(project); return c && c.key === key ? c.analysis : null; }
  function analyseCached(project, key, options = {}) {
    const hit = cachedAnalysis(project, key);
    if (hit) return hit;
    const analysis = analyse(project, options);
    if (project && typeof project === "object") analyses.set(project, {key, analysis});
    return analysis;
  }
  // Dismissed hints, per project, in this viewer's localStorage (AtriumPrefsStorage "state";
  // never in the project file). `project` is the project's path, else its name.
  const DISMISS_PREFIX = "atrium.bom.dismissed:", DISMISS_MAX = 500;
  function dismissals(project, storage = globalThis.localStorage) {
    const key = DISMISS_PREFIX + hash(String(project || "untitled"));
    let set = new Set();
    try { const v = JSON.parse(storage?.getItem(key) || "[]"); if (Array.isArray(v)) set = new Set(v.filter(x => typeof x === "string" && x.length < 200).slice(-DISMISS_MAX)); } catch {}
    const save = () => { try { if (set.size) storage?.setItem(key, JSON.stringify([...set].slice(-DISMISS_MAX))); else storage?.removeItem(key); } catch {} };
    return {key, has: id => set.has(id), add(id) { set.delete(id); set.add(String(id)); save(); }, remove(id) { set.delete(id); save(); },
      clear() { set.clear(); save(); }, get size() { return set.size; }, list: () => [...set]};
  }
  // Apply one merge hint through `edit` (the editor's ctx.edit), so it is one undo step.
  function applyHint(project, analysis, id, edit) {
    const p = analysis?.proposals.find(x => x.id === id);
    if (!p) throw Error("This suggestion no longer applies.");
    if (!p.applicable) throw Error("“" + p.title + "” is advice only and can't be applied automatically.");
    let r;
    const run = () => { r = apply(project, analysis, [id]); };
    if (typeof edit === "function") edit(run); else run();
    return r;
  }

  // ================================================================== UI
  function panel(ctx, host) {
    const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
    // A proposal's confidence is a library badge: safe in success, check in warning, advice neutral.
    const tagBadge = (text, kind) => { const b = el("span", text, "ui-badge bomopt-tag"); const tone = {safe: "success", check: "warning"}[kind]; if (tone) b.dataset.tone = tone; return b; };
    const button = (text, fn, cls) => {
      const b = el("button", text, cls); b.type = "button"; b.onclick = fn;
      b.classList.add("ui-button");
      if (cls === "bomopt-primary") b.dataset.variant = "primary";
      if (cls === "bomopt-link") { b.dataset.variant = "quiet"; b.dataset.size = "sm"; }
      return b;
    };
    const settings = loadSettings();
    const catalogue = {value: null, name: ""};
    let analysis = null, chosen = new Set(), pricing = null, costing = null, busy = null;
    const root = el("div", null, "bomopt");
    const bar = el("div", null, "bomopt-bar");
    const metrics = el("div", null, "bomopt-metrics"); metrics.setAttribute("role", "status");
    const all = button("Select safe", () => { chosen = new Set(analysis.proposals.filter(p => p.applicable && p.confidence === "safe").map(p => p.id)); paint(); });
    const none = button("Clear", () => { chosen.clear(); paint(); });
    const applyBtn = button("Apply selected", applySelected, "bomopt-primary");
    bar.append(metrics, all, none, applyBtn);
    const main = el("div", null, "bomopt-main");
    const left = el("div", null, "bomopt-left"), right = el("aside", null, "bomopt-cost");
    right.setAttribute("aria-label", "Suppliers and cost");
    main.append(left, right);
    root.append(bar, main);
    const say = text => { if (host.status) host.status.textContent = text; };

    // `pre`: an analysis the caller already has for this `collected` (bom.js shares the Lines hints' one).
    function update(collected, pre) {
      try {
        analysis = pre || analyse(host.project(), {collected, source: collected?.source, board: collected?.board?.id});
      } catch (e) { left.replaceChildren(el("p", e.message, "bomopt-empty")); return; }
      chosen = new Set(analysis.proposals.filter(p => p.selected).map(p => p.id));
      costing = null;
      paint(); paintCost();
      if (pricing) repriceFromCache();
    }
    function paint() {
      const s = after(analysis, [...chosen]);
      metrics.replaceChildren();
      const metric = (label, a, b) => { const m = el("span", null, "bomopt-metric"); m.append(el("span", label), el("strong", a === b ? String(a) : a + " → " + b)); metrics.append(m); };
      metric("Line items", analysis.summary.lineItems, s.lineItemsAfter);
      metric("Feeder slots", analysis.summary.feederSlots, s.feederSlotsAfter);
      metric("Parts", analysis.summary.parts, analysis.summary.parts);
      const n = analysis.proposals.filter(p => p.applicable && chosen.has(p.id)).length;
      applyBtn.textContent = n ? "Apply " + plural(n, "change set") : "Apply selected";
      applyBtn.disabled = !n;
      left.replaceChildren();
      const props = analysis.proposals;
      const head = el("h3", "Proposals"); head.append(el("span", " " + props.length, "bomopt-count"));
      left.append(head);
      if (!props.length) left.append(el("p", "No consolidation found. Every passive line is already distinct by value, package or rating.", "bomopt-empty"));
      const list = el("ul", null, "bomopt-list");
      for (const p of props.slice(0, 300)) list.append(proposalRow(p));
      if (props.length > 300) list.append(el("li", "Showing 300 of " + props.length + ".", "bomopt-more"));
      left.append(list);
      const ch = el("h3", "Checks"); ch.append(el("span", " " + analysis.checks.length, "bomopt-count"));
      left.append(ch);
      if (!analysis.checks.length) left.append(el("p", "No issues found.", "bomopt-empty"));
      for (const c of analysis.checks) {
        const box = el("details", null, "bomopt-check sev-" + c.severity);
        box.dataset.id = c.id;
        const sum = el("summary");
        sum.append(el("span", c.severity === "error" ? "Error" : c.severity === "warning" ? "Warning" : "Info", "bomopt-sev"), el("strong", c.title), el("span", " · " + c.count, "bomopt-count"));
        box.append(sum, el("p", c.message, "bomopt-note"));
        const ul = el("ul");
        for (const it of c.items.slice(0, 200)) { const li = el("li"); if (it.refs) li.append(el("code", it.refs)); li.append(document.createTextNode(" " + it.text)); ul.append(li); }
        if (c.items.length > 200) ul.append(el("li", "Showing 200 of " + c.items.length + "."));
        box.append(ul); left.append(box);
      }
    }
    function proposalRow(p) {
      const li = el("li", null, "bomopt-prop" + (p.applicable ? "" : " advisory"));
      li.dataset.id = p.id;
      const label = el("label", null, "bomopt-prop-head");
      const box = el("input"); box.type = "checkbox"; box.checked = chosen.has(p.id); box.disabled = !p.applicable;
      box.setAttribute("aria-label", p.title);
      box.onchange = () => { if (box.checked) chosen.add(p.id); else chosen.delete(p.id); paint(); if (pricing) repriceFromCache(); };
      const tag = p.applicable ? (p.confidence === "safe" ? "Safe" : "Check") : "Advice";
      label.append(box, el("span", p.title, "bomopt-title"), tagBadge(tag, p.applicable ? p.confidence : "advice"),
        el("span", "−" + plural(p.savings.lines, "line") + (p.savings.feeders ? " · −" + plural(p.savings.feeders, "feeder") : ""), "bomopt-save"));
      li.append(label);
      const flow = el("div", null, "bomopt-flow");
      const many = p.from.length > 8;
      for (const f of many ? [...p.from.filter(x => x.target), ...p.from.filter(x => !x.target).slice(0, 6)] : p.from) {
        const r = el("div", null, "bomopt-from" + (f.target ? " is-target" : ""));
        r.append(el("span", f.comment || f.description, "bomopt-val"), el("span", f.description + (f.mpn ? " · " + f.mpn : ""), "bomopt-spec"), el("code", f.refs + " ×" + f.qty));
        flow.append(r);
      }
      if (many) flow.append(el("div", "+ " + plural(p.from.length - 7, "more line"), "bomopt-spec"));
      const to = el("div", null, "bomopt-to");
      to.append(el("span", "→", "bomopt-arrow"), el("span", p.target.comment || p.target.description, "bomopt-val"),
        el("span", (p.target.description || "") + (p.target.mpn ? " · " + p.target.mpn : ""), "bomopt-spec"));
      flow.append(to);
      li.append(flow, el("p", p.explanation, "bomopt-note"));
      for (const c of p.caveats) li.append(el("p", c, "bomopt-caveat"));
      // Hidden from the Lines grid (bom.js hints): say so, and offer it back.
      if (host.dismissed?.has?.(p.id)) {
        const row = el("p", null, "bomopt-note bomopt-dismissed");
        row.append(el("span", host.text?.hidden || "Hidden in Lines"), button(host.text?.restore || "Show again", () => { host.restore?.(p.id); row.remove(); }, "bomopt-link"));
        li.append(row);
      }
      return li;
    }
    function applySelected() {
      const ids = analysis.proposals.filter(p => p.applicable && chosen.has(p.id)).map(p => p.id);
      if (!ids.length) return;
      let r;
      try {
        const run = () => { r = apply(host.project(), analysis, ids); };
        if (typeof ctx.edit === "function") ctx.edit(run); else run();
      } catch (e) { say(e.message || String(e)); return; }
      say("Applied " + plural(r.proposals, "proposal") + " to " + plural(r.parts, "part") + ". Undo reverts it in one step.");
      ctx.info?.("BOM optimisation applied");
      host.onApplied?.();
    }

    // ---------------------------------------------------------- cost side
    function paintCost() {
      right.replaceChildren();
      right.append(el("h3", "Suppliers and cost"));
      const privacy = el("p", "Only manufacturer part numbers, supplier codes or a value and package (such as “10kΩ 0603 resistor 1%”) are sent, and only to suppliers you enable. Designators, net names, the project and its files never leave this computer. Keys stay in this app's local storage, not in the project.", "bomopt-privacy");
      right.append(privacy);
      const form = el("div", null, "bomopt-form");
      const qty = el("input"); qty.type = "number"; qty.min = "1"; qty.step = "1"; qty.value = String(settings.quantity || 10); qty.setAttribute("aria-label", "Build quantity");
      qty.onchange = () => { settings.quantity = Math.max(1, Math.floor(Number(qty.value) || 1)); qty.value = settings.quantity; saveSettings(settings); recost(); };
      const ql = el("label", null, "bomopt-field"); ql.append(el("span", "Boards"), qty);
      const jlcBox = el("input"); jlcBox.type = "checkbox"; jlcBox.checked = !!settings.jlc.enabled;
      const fee = el("input"); fee.type = "number"; fee.min = "0"; fee.step = "0.5"; fee.value = String(settings.jlc.extendedFee); fee.setAttribute("aria-label", "Fee per unique extended part");
      jlcBox.onchange = () => { settings.jlc.enabled = jlcBox.checked; saveSettings(settings); recost(); };
      fee.onchange = () => { settings.jlc.extendedFee = Math.max(0, Number(fee.value) || 0); saveSettings(settings); recost(); };
      const jl = el("label", null, "bomopt-field"); jl.append(jlcBox, el("span", "JLC assembly · extended fee"), fee);
      form.append(ql, jl);
      right.append(form);
      const sup = el("fieldset", null, "bomopt-suppliers"); sup.append(el("legend", "Suppliers"));
      for (const def of registry.values()) {
        const conf = settings.providers[def.id] || (settings.providers[def.id] = {});
        if (def.id === "jlc-library") conf.catalogue = catalogue.value;
        const row = el("div", null, "bomopt-supplier");
        const on = el("input"); on.type = "checkbox"; on.checked = !!conf.enabled && !def.stub; on.disabled = !!def.stub;
        on.onchange = () => { conf.enabled = on.checked; saveSettings(settings); paintCost(); };
        const name = el("label"); name.append(on, el("span", def.name));
        row.append(name);
        const ready = def.configured(conf);
        row.append(el("span", def.stub ? "Unavailable" : !def.network ? (catalogue.value ? catalogue.value.kept + " parts" : "No file") : ready ? "Key set" : "Needs key", "bomopt-state"));
        if (def.stub && def.note) row.append(el("p", def.note, "bomopt-note"));
        if (conf.enabled && def.fields.length) {
          const keys = el("div", null, "bomopt-keys");
          for (const f of def.fields) {
            const input = el("input"); input.type = /secret|key/i.test(f.key) ? "password" : "text"; input.autocomplete = "off"; input.spellcheck = false;
            input.value = conf[f.key] || ""; input.placeholder = f.label; input.setAttribute("aria-label", def.name + " " + f.label);
            input.onchange = () => { conf[f.key] = input.value.trim(); saveSettings(settings); };
            keys.append(input);
          }
          keys.append(button("Forget key", () => { for (const f of def.fields) delete conf[f.key]; saveSettings(settings); paintCost(); }, "bomopt-link"));
          row.append(keys);
        }
        if (def.id === "jlc-library" && conf.enabled) row.append(button(catalogue.value ? "Replace CSV…" : "Import CSV…", importCatalogue, "bomopt-link"));
        sup.append(row);
      }
      right.append(sup);
      const actions = el("div", null, "bomopt-actions");
      const go = button(busy ? "Cancel" : "Get prices", () => busy ? busy.abort() : getPrices(), "bomopt-primary");
      const enabled = activeProviders();
      go.disabled = !busy && !enabled.length;
      if (!enabled.length) go.title = "Enable and configure a supplier first.";
      actions.append(go, button("Clear cache", () => { clearCache(sessionStore()); pricing = null; costing = null; paintCost(); }, "bomopt-link"));
      right.append(actions);
      const out = el("div", null, "bomopt-results");
      out.setAttribute("aria-live", "polite");
      right.append(out);
      paintResults(out);
    }
    function sessionStore() { try { return settings.sessionCache ? globalThis.sessionStorage : null; } catch { return null; } }
    function activeProviders() {
      return [...registry.values()].filter(d => !d.stub && settings.providers[d.id]?.enabled && d.configured({...settings.providers[d.id], catalogue: catalogue.value}))
        .map(d => provider(d.id, {settings: {...settings.providers[d.id], catalogue: catalogue.value}, fetch: host.fetch}));
    }
    async function importCatalogue() {
      let file = null;
      if (typeof ctx.pickFile === "function") file = await ctx.pickFile([".csv"]).catch(() => null);
      else {
        file = await new Promise(res => { const i = el("input"); i.type = "file"; i.accept = ".csv,text/csv"; i.onchange = () => res(i.files[0] || null); i.click(); });
      }
      if (!file) return;
      try {
        const text = await file.text();
        const lines = optimisedLines(analysis, [...analysis.proposals.filter(p => p.applicable).map(p => p.id)]).concat(optimisedLines(analysis, []));
        const want = {mpn: new Set(), lcsc: new Set(), values: new Set()};
        for (const l of lines) { if (l.mpn) want.mpn.add(normMpn(l.mpn)); const c = upper(l.supplierPn); if (LCSC_CODE.test(c)) want.lcsc.add(c); if (l.valueKey && l.package) want.values.add(l.valueKey + "|" + l.package); }
        catalogue.value = jlcCatalogue(text, {want}); catalogue.name = file.name || "CSV";
        say("Read " + catalogue.value.rows + " rows from " + catalogue.name + "; kept " + catalogue.value.kept + " that match this BOM.");
      } catch (e) { say(e.message || String(e)); }
      paintCost();
    }
    async function getPrices() {
      const providers = activeProviders();
      if (!providers.length) return;
      busy = new AbortController();
      paintCost();
      const lines = optimisedLines(analysis, [...chosen]);
      try {
        pricing = await price(lines, {providers, signal: busy.signal, session: sessionStore(),
          onProgress: ({done, total}) => say("Pricing " + done + " of " + total + "…")});
        say("Priced " + plural(lines.length, "line") + (pricing.errors.length ? " · " + pricing.errors[0].message : "") + (pricing.cached ? " · " + pricing.cached + " from cache" : ""));
        recost(lines);
      } catch (e) { say(e.message || String(e)); }
      busy = null;
      paintCost();
    }
    async function repriceFromCache() {
      const providers = activeProviders();
      if (!providers.length) return;
      const lines = optimisedLines(analysis, [...chosen]);
      pricing = await price(lines, {providers, cacheOnly: true, session: sessionStore()});
      recost(lines); paintCost();
    }
    function recost(lines) {
      if (!pricing) return;
      lines = lines || optimisedLines(analysis, [...chosen]);
      costing = cost(lines, pricing, {boards: settings.quantity, jlc: settings.jlc});
      const out = right.querySelector(".bomopt-results");
      if (out) paintResults(out);
    }
    const fmt = (n, cur) => (cur ? cur + " " : "") + (n >= 100 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toFixed(4));
    function paintResults(out) {
      out.replaceChildren();
      if (!costing) { out.append(el("p", activeProviders().length ? "Choose Get prices to look up the optimised BOM." : "No supplier is enabled. Waffle stays offline until you set one up.", "bomopt-empty")); return; }
      const c = costing;
      const t = el("table", null, "bomopt-table");
      const h = el("tr"); for (const x of ["Supplier", "Lines", "Per build", "Per board"]) h.append(el("th", x));
      const tb = el("tbody");
      for (const s of c.suppliers) { const r = el("tr"); r.append(el("td", s.supplier), el("td", s.lines + "/" + c.lineCount, "num"), el("td", fmt(s.total, ""), "num"), el("td", fmt(s.perBoard, ""), "num")); tb.append(r); }
      const best = el("tr", null, "bomopt-best");
      best.append(el("td", "Best mix"), el("td", c.pricedLines + "/" + c.lineCount, "num"), el("td", fmt(c.total, ""), "num"), el("td", fmt(c.perBoard, ""), "num"));
      tb.append(best);
      const thead = el("thead"); thead.append(h); t.append(thead, tb);
      out.append(el("p", plural(c.boards, "board") + " · " + c.currency + (c.mixedCurrencies ? " (offers in other currencies are ignored)" : "") +
        (c.fees ? " · " + c.extendedParts + " extended JLC " + (c.extendedParts === 1 ? "part" : "parts") + " add " + fmt(c.fees, "") : ""), "bomopt-note"), t);
      const issues = c.rows.filter(r => r.flags.length);
      if (issues.length) {
        const ul = el("ul", null, "bomopt-issues");
        const text = {"out-of-stock": "Out of stock for this build", "no-match": "No exact match", "no-query": "Nothing to search for (add an MPN)", eol: "End of life", nrnd: "Not recommended for new designs", obsolete: "Obsolete"};
        for (const r of issues.slice(0, 200)) { const li = el("li"); li.append(el("code", compress(r.refs)), document.createTextNode(" " + r.flags.map(f => text[f] || f).join(", ") + (r.bestStock != null ? " (best stock " + r.bestStock + " of " + r.need + ")" : ""))); ul.append(li); }
        out.append(ul);
      }
      const det = el("details", null, "bomopt-lines");
      det.append(el("summary", "Chosen offers"));
      const lt = el("table", null, "bomopt-table"), lh = el("tr");
      for (const x of ["Designators", "Qty", "Supplier", "SKU", "Unit", "Line"]) lh.append(el("th", x));
      const lhead = el("thead"); lhead.append(lh); const lb = el("tbody");
      for (const r of c.rows.slice(0, 500)) {
        const tr = el("tr");
        tr.append(el("td", compress(r.refs), "refs"), el("td", String(r.need), "num"), el("td", r.chosen ? r.chosen.supplier + (r.chosen.basic === true ? " · basic" : r.chosen.basic === false ? " · extended" : "") : "–"),
          el("td", r.chosen?.sku || ""), el("td", r.chosen ? fmt(r.chosen.unit, "") : "", "num"), el("td", r.chosen ? fmt(r.chosen.lineCost + r.chosen.fee, "") : "", "num"));
        lb.append(tr);
      }
      lt.append(lhead, lb); det.append(lt); out.append(det);
      // JLC-ready BOM: put the part numbers this lookup found on the parts (one undo step).
      let plan = null;
      try { plan = assignments(host.project(), analysis, c); } catch { plan = null; }
      if (plan) {
        const box = el("div", null, "bomopt-assign");
        const go = button(plan.changes.length ? "Assign part numbers to " + plural(plan.lines.length, "line") : "Part numbers are up to date", () => {
          try {
            let r;
            const run = () => { r = assign(host.project(), plan); };
            if (typeof ctx.edit === "function") ctx.edit(run); else run();
            say("Assigned part numbers to " + plural(r.parts, "part") + " on " + plural(r.lines, "line") + ". Undo reverts it in one step.");
            ctx.info?.("Supplier part numbers assigned");
            host.onApplied?.();
          } catch (e) { say(e.message || String(e)); }
        }, "bomopt-primary");
        go.disabled = !plan.changes.length;
        box.append(go, el("p", "Writes the supplier part each line was matched to (LCSC # for LCSC / JLCPCB parts, with Basic or Extended when known). Only part numbers this lookup returned are used." +
          (plan.skipped.length ? " Skipped: " + plan.skipped.slice(0, 6).map(x => x.refs + " (" + x.reason + ")").join("; ") + (plan.skipped.length > 6 ? " …" : "") + "." : ""), "bomopt-note"));
        out.append(box);
      }
    }
    // Show in Optimise (from a Lines hint): scroll to the proposal or open the check, briefly marked.
    function reveal(id, check) {
      const target = [...left.querySelectorAll("[data-id]")].find(n => n.dataset.id === id || (check && n.dataset.id === check));
      if (!target) return false;
      if (target.tagName === "DETAILS") target.open = true;
      target.scrollIntoView?.({block: "nearest"});
      target.classList.remove("bomopt-flash"); void target.offsetWidth; target.classList.add("bomopt-flash");
      (target.querySelector("input,summary") || target).focus?.({preventScroll: true});
      return true;
    }
    return {
      element: root, update, reveal, repaint: () => { if (analysis) paint(); },
      report: extra => report(host.project(), analysis, {selected: [...chosen], costing, ...extra}),
      get analysis() { return analysis; }
    };
  }

  return {analyse, apply, after, optimisedLines, report, summarise, checks: runChecks, panel,
    hints, contentKey, cachedAnalysis, analyseCached, dismissals, applyHint, DISMISS_PREFIX,
    parseText, parseValueToken, formatValue, canonicalComment, packageOf, eSeries, nearest, netVoltage, dominates, specOf,
    providers: registry, provider, register, queryFor, price, cost, priceAt, assignments, assign, matchParts, jlcCatalogue, priceList, lifecycle, money,
    parse: {mouser: mouserParts, digikey: digikeyParts, nexar: nexarParts},
    loadSettings, saveSettings, clearCache, SETTINGS_KEY, SERIES};
})();
