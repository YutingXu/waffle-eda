"use strict";
// SPICE model ladder, per-value provenance and generic behavioural templates (docs/design/spice-models.md
// §3–§7, phases 1–3). DOM-free; loaded by export.js inside the SPICE extension's worker.
//
// Rungs (best first): Vendor · Fitted · Generic · Ideal · Load-only · Primitive · Excluded · Missing.
//   Vendor     model text the user supplied (Spice.Lib, or a Spice parameter naming its own model)
//   Fitted     a template whose every required field is datasheet or user data and whose bench passed
//   Generic    a template with a Waffle default (or an unconfirmed AI value) in a required field, or a
//              built-in model from the table below (a Waffle approximation, never the vendor's model)
//   Ideal      ideal op-amp or diode;  Load-only: supply current only;  Primitive: R C L and sources
//   Excluded   not fitted in the variant, excluded with a reason, or a connector / test point / logo
//   Missing    nothing applies: the coverage report offers "Use generic"
//
// Provenance: every template value is a record {v, src, page?, quote?, doc?, note?}; src is one of
// datasheet, user, derived, default, ai (unconfirmed until the user ticks it), placeholder (carried from
// a placeholder after Resolve, not checked against the real part). Waffle never invents a manufacturer,
// part number or vendor parameter: defaults are labelled as Waffle defaults wherever they show.
//
// Templates are pure: template.build(values, ports) -> {letter, ports, name, text, notes}. Each has a
// stable id and version ("opamp@1"); a changed netlist needs a version bump (tests/spice-models.cjs
// keeps goldens). They use only R C L, E/F/G/H, D, Q, M and B sources, so they also suit ngspice later.
(function () {
  const S = typeof require === "function" ? require("./spice.js") : globalThis.AtriumSpice;
  const RUNGS = ["Vendor", "Fitted", "Generic", "Ideal", "Load-only", "Primitive", "Excluded", "Missing"];
  const SOURCES = ["datasheet", "user", "derived", "default", "ai", "placeholder"];
  const SOURCE_LABEL = {datasheet: "datasheet", user: "user", derived: "derived", default: "Waffle default", ai: "AI, unconfirmed", placeholder: "from placeholder"};
  const TRUSTED = new Set(["datasheet", "user"]);
  const VT = S.VT, TAU = 2 * Math.PI;
  const fail = m => { throw Error(m); };
  const g = x => String(Number(Number(x).toPrecision(6)));

  // ------------------------------------------------------------------ numbers as people type them
  // "1 MHz" = 1e6, "350 kHz", "10 mA", "50 mΩ", "4k7", "2.2µ", "1meg", "100 dB" = 100, "±15 V" = 15.
  // Unlike SPICE, M is mega and m is milli (datasheet units).
  const PREFIX = {T: 1e12, G: 1e9, M: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, "µ": 1e-6, "μ": 1e-6, n: 1e-9, p: 1e-12, f: 1e-15};
  function hnum(text) {
    if (typeof text === "number") return text;
    const s = String(text ?? "").trim().replace(/[−–]/g, "-").replace(/^±\s*/, "").replace(/,(?=\d{3}\b)/g, "");
    let m = /^([+-]?\d+)([kKmMrRuµμnp])(\d+)/.exec(s);
    if (m) return Number(m[1] + "." + m[3]) * (/[rR]/.test(m[2]) ? 1 : PREFIX[m[2]]);
    m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(meg|[TGMkKmuµμnpf](?![a-z]{2,}\b)|[TGMkKmuµμnpf](?=Hz|V|A|Ω|F|H|s|W|ohm))?/.exec(s);
    if (!m) return NaN;
    const k = m[2] === "meg" ? 1e6 : m[2] ? PREFIX[m[2]] : 1;
    return Number(m[1]) * k;
  }
  // "±15 V" -> {lo: -15, hi: 15}; "2.7–5.5 V" -> {lo: 0, hi: 5.5}; "5 V" -> {lo: 0, hi: 5}.
  function supply(text) {
    const s = String(text ?? "").replace(/[−–]/g, "-");
    if (/±/.test(s)) { const v = Math.abs(hnum(s)); return Number.isFinite(v) ? {lo: -v, hi: v} : null; }
    const range = /(\d+\.?\d*)\s*(?:-|to)\s*(\d+\.?\d*)/i.exec(s);
    if (range && !/(^|\s)-\s*\d/.test(s.slice(0, range.index + 1))) return {lo: 0, hi: Math.max(Number(range[1]), Number(range[2]))};
    const all = [...s.matchAll(/(?:^|[\s/,])([+-]?\d+\.?\d*)/g)].map(x => hnum(x[1])).filter(Number.isFinite);
    if (!all.length) return null;
    const neg = all.filter(v => v < 0), pos = all.filter(v => v > 0);
    if (neg.length && pos.length) return {lo: Math.min(...neg), hi: Math.max(...pos)};
    return {lo: 0, hi: Math.max(...all.map(Math.abs))};
  }
  const unitNum = (text, unit) => {
    let v = hnum(text);
    if (unit === "V/µs" && /V\s*\/\s*s\b/.test(String(text)) && !/[µu]s\b/.test(String(text))) v /= 1e6;
    if (unit === "dB" && v > 300) v = 20 * Math.log10(v);
    return v;
  };

  // ------------------------------------------------------------------ provenance records
  function rec(x, src = "user") {
    if (x == null || x === "") return null;
    if (typeof x === "object" && !Array.isArray(x)) {
      if (x.v == null || String(x.v).trim() === "") return null;
      const r = {v: String(x.v).slice(0, 200), src: SOURCES.includes(x.src) ? x.src : x.src ? "ai" : src};
      for (const k of ["doc", "quote", "note"]) if (typeof x[k] === "string" && x[k]) r[k] = x[k].slice(0, 300);
      if (x.page != null && x.page !== "") r.page = String(x.page).slice(0, 12);
      return r;
    }
    return {v: String(x).slice(0, 200), src};
  }
  const chip = r => (r ? SOURCE_LABEL[r.src] + (r.page ? " p." + r.page : "") : "");

  // ------------------------------------------------------------------ pin roles
  const norm = s => String(s ?? "").normalize("NFKC").toUpperCase().replace(/[−–]/g, "-").replace(/\s+/g, "").replace(/^~\{(.+)\}$/, "$1").replace(/^[~!/]/, "").replace(/̅/g, "");
  const SYN = {
    "IN+": ["IN+", "+IN", "INP", "IN_P", "NONINV", "NON-INV", "+", "V+IN", "VIN+", "NI", "+INA", "INA+"],
    "IN-": ["IN-", "-IN", "INN", "IN_N", "INV", "-", "V-IN", "VIN-", "-INA", "INA-"],
    OUT: ["OUT", "OUTPUT", "VOUT", "VO", "O", "OUTA", "Y", "Q"],
    "V+": ["V+", "VCC", "VDD", "VS+", "+VS", "VS", "AVDD", "VCC+", "V+S", "VDDA", "VBAT", "DVDD", "IOVDD"],
    "V-": ["V-", "VEE", "VSS", "VS-", "-VS", "GND", "AGND", "V-S", "VCC-"],
    VIN: ["VIN", "IN", "VI", "INPUT"], VOUT: ["VOUT", "OUT", "VO", "OUTPUT"], GND: ["GND", "VSS", "PGND", "AGND", "GROUND", "EP", "EPAD", "DGND"],
    EN: ["EN", "ENABLE", "SHDN", "CE", "ON", "ON/OFF", "SHDN#", "EN#"], FB: ["FB", "ADJ", "SENSE", "SNS"],
    D: ["D", "DRAIN"], G: ["G", "GATE"], S: ["S", "SOURCE"], C: ["C", "COLLECTOR"], B: ["B", "BASE"], E: ["E", "EMITTER"],
    A: ["A", "ANODE", "+"], K: ["K", "C", "CATHODE", "-", "KA"],
    IN1: ["IN1", "A", "IN", "I0", "I"], IN2: ["IN2", "B", "I1"], IN3: ["IN3", "C", "I2"], IN4: ["IN4", "D", "I3"], "OE#": ["OE#", "OE", "G#", "EN#"],
    COM: ["COM", "C", "1"], NO: ["NO", "2"], NC: ["NC", "3"], T1: ["1", "A", "+"], T2: ["2", "B", "-"]
  };
  const SUPPLY_ROLES = new Set(["V+", "V-", "GND"]);

  // ------------------------------------------------------------------ templates
  // field: [key, label, unit, required, default (value or fn(vals, raw) -> [value, src, note]), options]
  const F = (k, label, unit, req, def, options) => ({k, label, unit, req: !!req, def, options});
  const derived = (v, note) => ({derived: v, note});
  const ESL = {"0201": 0.2e-9, "0402": 0.3e-9, "0603": 0.5e-9, "0805": 0.7e-9, "1206": 1e-9, "1210": 1e-9, "1812": 1.2e-9};
  // Class-generic MLCC DC-bias knee as a fraction of the rated voltage, per dielectric, and a case
  // factor (smaller cases lose more). A Waffle estimate for planning, not vendor data.
  const BIAS_KNEE = {X5R: 0.45, X6S: 0.45, X7R: 0.55, X7S: 0.5, X8R: 0.6, Y5V: 0.2, Z5U: 0.25};
  const CASE_FACTOR = {"0201": 0.6, "0402": 0.75, "0603": 0.9, "0805": 1, "1206": 1.2, "1210": 1.35, "1812": 1.5};
  const LED_VF = {RED: 2, ORANGE: 2.05, AMBER: 2.1, YELLOW: 2.1, GREEN: 2.2, BLUE: 3, WHITE: 3, INFRARED: 1.3, IR: 1.3, ULTRAVIOLET: 3.3, UV: 3.3};
  const sp = (u, w) => w + "*(max((" + u + ")/" + w + ",0)+ln(1+exp(-abs((" + u + ")/" + w + "))))"; // smooth max(u, 0), width w
  const sclamp = (x, lo, hi, w = "0.01") => "(" + lo + ")+" + sp("(" + x + ")-(" + lo + ")", w) + "-" + sp("(" + x + ")-(" + hi + ")", w);

  const T = {};
  T.opamp = {
    v: 1, title: "Op-amp", rung: "Generic", letter: "X",
    roles: [["IN+", 1], ["IN-", 1], ["OUT", 1], ["V+", 0], ["V-", 0]], perUnit: ["IN+", "IN-", "OUT"],
    fields: [F("GBW", "Gain-bandwidth", "Hz", 1, "1 MHz"), F("Rails", "Rail-to-rail", "", 1, "RRO", ["RRIO", "RRO", "RRI", "none"]), F("Supply", "Supply range", "text", 1, "5 V"),
      F("Aol", "Open-loop gain", "dB", 0, "100 dB"), F("SR", "Slew rate", "V/µs", 0, v => derived(0.5 * v.GBW / 1e6, "0.5 V/µs per MHz of GBW")),
      F("Vos", "Offset voltage", "V", 0, "0 V"), F("Ib", "Input bias current", "A", 0, "0 A"), F("Iq", "Quiescent current", "A", 0, "1 mA"),
      F("Isc", "Output short-circuit current", "A", 0, "20 mA"), F("Rout", "Output resistance", "Ω", 0, "50 Ω"), F("PM", "Phase margin", "°", 0, "60"),
      F("Swing", "Output swing to the rails", "V", 0, v => [/RRO|RRIO/.test(v.Rails) ? "0.05 V" : "1.5 V"]), F("Rin", "Differential input resistance", "Ω", 0, "10 MΩ")],
    notModelled: ["THD and input-stage nonlinearity", "temperature drift", "overload recovery (anti-windup only)", "EMI rectification", "input common-mode range limits", "noise (no .noise analysis yet)", "EN/shutdown pin (always on)"],
    build(v, have) {
      const sup = have.has("V+") && have.has("V-"), C1 = 1e-9, gm = TAU * v.GBW * C1, R1 = Math.pow(10, v.Aol / 20) / gm, Is = v.SR * 1e6 * C1;
      const rails = sup ? null : supply(v.Supply) || {lo: 0, hi: 5};
      const out = "(" + g(v.Isc) + "*tanh((V(o)-V(out))/" + g(v.Rout * v.Isc) + "))";
      const L = [];
      L.push("Rin inp inn " + g(v.Rin));
      if (v.Ib) L.push("Ibp inp 0 " + g(v.Ib), "Ibn inn 0 " + g(v.Ib));
      if (rails) L.push("Vsp vcc 0 " + g(rails.hi), "Vsn vee 0 " + g(rails.lo));
      L.push("Bmid mid 0 V=(V(vcc)+V(vee))/2", "Bg mid p I=" + g(Is) + "*tanh(" + g(gm / Is) + "*(V(inp,inn)+" + g(v.Vos) + "))",
        "R1 p mid " + g(R1), "C1 p mid " + g(C1), "Baw p mid I=" + g(1000 / R1) + "*(max(V(p)-V(vcc)-1,0)-max(V(vee)-1-V(p),0))");
      let node = "V(p)";
      if (v.PM < 89.5) { const f2 = v.GBW / Math.tan((90 - Math.max(v.PM, 5)) * Math.PI / 180); L.push("Bq q 0 V=V(p)", "Rp2 q r 1k", "Cp2 r 0 " + g(1 / (TAU * 1e3 * f2))); node = "V(r)"; }
      L.push("Bo o 0 V=" + sclamp(node, "V(vee)+" + g(v.Swing), "V(vcc)-" + g(v.Swing)), "Bout o out I=" + out,
        "Bsp vcc 0 I=max(" + out + ",0)", "Bsn 0 vee I=max(-" + out + ",0)", "Iq vcc vee " + g(v.Iq));
      return {ports: sup ? ["IN+", "IN-", "OUT", "V+", "V-"] : ["IN+", "IN-", "OUT"], nodes: sup ? "inp inn out vcc vee" : "inp inn out", lines: L,
        notes: sup ? [] : ["no supply pins connected: rails fixed at " + g(rails.lo) + " V and " + g(rails.hi) + " V from the Supply field"]};
    },
    bench(v) {
      const rails = supply(v.Supply) || {lo: 0, hi: 5}, mid = (rails.hi + rails.lo) / 2, sup = "Vcc vcc 0 " + g(rails.hi) + "\nVee vee 0 " + g(rails.lo) + "\n";
      const m = [];
      // Open loop: DC unity feedback through a 1 GΩ / 1 F low-pass, AC open.
      const ol = sup + "Vin in 0 DC " + g(mid) + " AC 1\nRf out fb 1g\nCf fb 0 1\nX1 in fb out vcc vee DUT\n";
      const f1 = v.GBW / 10, fl = v.GBW / Math.pow(10, v.Aol / 20) / 100;
      m.push({key: "GBW", label: "Gain × frequency at GBW/10", unit: "Hz", want: v.GBW, tol: 0.05, deck: ol + ".ac lin 1 " + g(f1) + " " + g(f1), read: r => S.mag(S.signal(r, "out"))[0] * f1});
      m.push({key: "Aol", label: "Open-loop gain", unit: "dB", want: v.Aol, tol: 0.05, deck: ol + ".ac lin 1 " + g(fl) + " " + g(fl), read: r => S.db(S.signal(r, "out"))[0]});
      // Slew: unity follower, a step large enough to be slew-limited (if the rails allow it).
      const span = rails.hi - rails.lo - 2 * v.Swing - 0.2, step = Math.min(span * 0.8, 10 * v.SR * 1e6 / (TAU * v.GBW));
      if (step > 5 * v.SR * 1e6 / (TAU * v.GBW) && step > 0.05) {
        const lo = mid - step / 2, hi = mid + step / 2, tr = step / (v.SR * 1e6), tstop = 6 * tr + 20 / (TAU * v.GBW);
        m.push({key: "SR", label: "Slew rate, 20–80 % of a " + g(step) + " V step", unit: "V/µs", want: v.SR, tol: 0.05,
          deck: sup + "Vin in 0 PULSE(" + g(lo) + " " + g(hi) + " " + g(tr / 4) + " 1n 1n 1 2)\nX1 in out out vcc vee DUT\nRl out 0 10k\n.tran " + g(tstop / 2000) + " " + g(tstop),
          read: r => { const y = S.signal(r, "out").re, t1 = cross(r.x, y, lo + 0.2 * step), t2 = cross(r.x, y, lo + 0.8 * step); return 0.6 * step / (t2 - t1) / 1e6; }});
      }
      m.push({key: "Vohigh", label: "Output high into 10 kΩ", unit: "V", deck: sup + "Vin in 0 " + g(rails.hi) + "\nX1 in out out vcc vee DUT\nRl out m 10k\nVm m 0 " + g(mid) + "\n.op", read: r => r.nodes.out});
      return m;
    }
  };
  T.comparator = {
    v: 1, title: "Comparator", rung: "Generic", letter: "X",
    roles: [["IN+", 1], ["IN-", 1], ["OUT", 1], ["V+", 0], ["V-", 0]], perUnit: ["IN+", "IN-", "OUT"],
    fields: [F("Output", "Output type", "", 1, "push-pull", ["push-pull", "open-drain"]), F("tpd", "Propagation delay", "s", 1, "1 µs"), F("Supply", "Supply range", "text", 1, "5 V"),
      F("Hyst", "Hysteresis", "V", 0, "0 V"), F("Vos", "Offset voltage", "V", 0, "0 V"), F("Rout", "Output resistance (push-pull) or Ron (open-drain)", "Ω", 0, "50 Ω"), F("Iq", "Quiescent current", "A", 0, "100 µA")],
    notModelled: ["metastability", "overdrive-dependent delay (a single tpd)", "separate rise and fall times", "input common-mode range limits"],
    build(v, have) {
      const sup = have.has("V+") && have.has("V-"), rails = sup ? null : supply(v.Supply) || {lo: 0, hi: 5}, L = [];
      if (rails) L.push("Vsp vcc 0 " + g(rails.hi), "Vsn vee 0 " + g(rails.lo));
      L.push("Bt t 0 V=0.5*(1+tanh((V(inp,inn)+" + g(v.Vos) + "+" + g(v.Hyst) + "*(V(z)-0.5))/0.001))", "Rd t s 1k", "Cd s 0 " + g(v.tpd / Math.LN2 / 1e3), "Bz z 0 V=0.5*(1+tanh((V(s)-0.5)/0.002))");
      if (/open/i.test(v.Output)) L.push("Bod out vee I=V(out,vee)*((1-V(z))/" + g(v.Rout) + "+1e-9)");
      else L.push("Bo o 0 V=V(vee)+V(vcc,vee)*V(z)", "Ro o out " + g(v.Rout));
      L.push("Iq vcc vee " + g(v.Iq));
      return {ports: sup ? ["IN+", "IN-", "OUT", "V+", "V-"] : ["IN+", "IN-", "OUT"], nodes: sup ? "inp inn out vcc vee" : "inp inn out", lines: L,
        notes: sup ? [] : ["no supply pins connected: rails fixed from the Supply field"]};
    },
    bench(v) {
      const rails = supply(v.Supply) || {lo: 0, hi: 5}, mid = (rails.hi + rails.lo) / 2, hi = rails.hi, out = /open/i.test(v.Output) ? "Rpu out vcc 10k\n" : "";
      const sup = "Vcc vcc 0 " + g(hi) + "\nVee vee 0 " + g(rails.lo) + "\nVr ref 0 " + g(mid) + "\n" + out, t0 = v.tpd, tstop = 4 * v.tpd + t0;
      const m = [{key: "tpd", label: "Propagation delay, 100 mV overdrive", unit: "s", want: v.tpd, tol: 0.05,
        deck: sup + "Vin in 0 PULSE(" + g(mid - 0.1 - v.Hyst) + " " + g(mid + 0.1 + v.Hyst) + " " + g(t0) + " " + g(v.tpd / 1000) + " " + g(v.tpd / 1000) + " 1 2)\nX1 in ref out vcc vee DUT\n.tran " + g(tstop / 4000) + " " + g(tstop),
        read: r => cross(r.x, S.signal(r, "out").re, (hi + rails.lo) / 2) - t0 - v.tpd / 2000}];
      if (v.Hyst > 0) {
        const per = 400 * v.tpd, a = mid - 2 * v.Hyst - 0.05, b = mid + 2 * v.Hyst + 0.05;
        m.push({key: "Hyst", label: "Hysteresis (rising − falling threshold)", unit: "V", want: v.Hyst, tol: 0.05,
          deck: sup + "Vin in 0 PWL(0 " + g(a) + " " + g(per) + " " + g(b) + " " + g(2 * per) + " " + g(a) + ")\nX1 in ref out vcc vee DUT\n.tran " + g(per / 4000) + " " + g(2 * per),
          read: r => {
            const y = S.signal(r, "out").re, x = S.signal(r, "in").re, th = (hi + rails.lo) / 2, i1 = y.findIndex(q => q > th), i2 = y.findIndex((q, i) => i > i1 && q < th);
            return i1 < 0 || i2 < 0 ? NaN : x[i1] - x[i2] - (2 * (b - a) / per) * v.tpd; // remove the delay's share of the ramp
          }});
      }
      return m;
    }
  };
  T.ldo = {
    v: 1, title: "LDO regulator", rung: "Generic", letter: "X",
    roles: [["VIN", 1], ["VOUT", 1], ["GND", 1], ["EN", 0], ["FB", 0]],
    fields: [F("Vout", "Output voltage", "V", 1, "3.3 V"), F("Vdo", "Dropout voltage", "V", 1, "0.3 V"), F("Ido", "at output current", "A", 1, "100 mA"),
      F("Vref", "Feedback reference (adjustable parts)", "V", 0, "0.8 V"), F("Iq", "Ground current", "A", 0, "50 µA"), F("Ilim", "Current limit", "A", 0, v => [g(3 * v.Ido), "default", "three times the dropout current (Waffle default)"]),
      F("PSRR", "PSRR at low frequency", "dB", 0, "60 dB"), F("BW", "Loop bandwidth", "Hz", 0, "100 kHz"), F("Ven", "Enable threshold", "V", 0, "1 V"),
      F("Ro", "DC output resistance (load regulation)", "Ω", 0, "20 mΩ"), F("Rx", "Output resistance above the loop bandwidth", "Ω", 0, "1 Ω")],
    notModelled: ["stability with the real Cout and ESR: the load step shows its shape only", "noise", "thermal shutdown", "soft-start and inrush", "PG and NR pins (left open)", "shutdown current"],
    build(v, have) {
      const en = have.has("EN"), fb = have.has("FB"), k0 = Math.pow(10, -v.PSRR / 20), L = [];
      const vin = "V(vin,gnd)", target = fb ? "V(vout,gnd)+1000*(" + g(v.Vref) + "-V(fb,gnd))" : g(v.Vout);
      const wl = g(0.01 * v.Ilim), lim = "100*" + sp("I(Vs)-" + g(v.Ilim), wl);
      L.push("Be e 0 V=0.5*(1+tanh((" + (en ? "V(en,gnd)" : vin) + "-" + g(v.Ven) + ")/0.02))", "By y1 0 V=" + vin, "Ry y1 y 1k", "Cy y 0 " + g(1 / (TAU * 1e3 * v.BW)),
        "Bc c gnd V=max(min(V(e)*(" + target + "+" + g(k0) + "*(" + vin + "-V(vout,gnd))+" + g(1 - k0) + "*(" + vin + "-V(y))), " + vin + "-" + g(Math.max(v.Vdo / v.Ido - v.Ro, 0)) + "*I(Vs))-" + lim + ",0)",
        "Ro c m " + g(v.Ro), "Rx m n " + g(v.Rx), "Lx m n " + g(v.Rx / (TAU * v.BW)), "Vs n vout 0", "Bin vin gnd I=max(I(Vs),0)", "Bq vin gnd I=" + g(v.Iq) + "*V(e)");
      return {ports: ["VIN", "VOUT", "GND", ...(en ? ["EN"] : []), ...(fb ? ["FB"] : [])], nodes: "vin vout gnd" + (en ? " en" : "") + (fb ? " fb" : ""), lines: L,
        notes: [...(en ? [] : ["EN not connected: tied to VIN"]), ...(fb ? ["FB connected: regulates FB to Vref"] : [])]};
    },
    benchRoles: () => new Set(["VIN", "VOUT", "GND"]),
    bench(v) {
      const load = i => "Il vout 0 " + g(i) + "\n", psrrF = q => q.BW * Math.pow(10, -q.PSRR / 20) / 30;
      return [
        {key: "Vout", label: "Output at Vin = Vout + 1 V, 1 mA", unit: "V", want: v.Vout, tol: 0.02, deck: "Vin vin 0 " + g(v.Vout + 1) + "\n" + load(1e-3) + "Co vout 0 1u\nX1 vin vout 0 DUT\n.op", read: r => r.nodes.vout},
        {key: "Vdo", label: "Dropout at " + g(v.Ido) + " A (Vin = Vout)", unit: "V", want: v.Vdo, tol: 0.02, deck: "Vin vin 0 " + g(v.Vout) + "\n" + load(v.Ido) + "X1 vin vout 0 DUT\n.op", read: r => r.nodes.vin - r.nodes.vout},
        {key: "PSRR", label: "PSRR at low frequency", unit: "dB", want: v.PSRR, tol: 0.05, deck: "Vin vin 0 DC " + g(v.Vout + 1) + " AC 1\n" + load(1e-3) + "X1 vin vout 0 DUT\n.ac lin 1 " + g(psrrF(v)) + " " + g(psrrF(v)), read: r => -S.db(S.signal(r, "vout"))[0]},
        {key: "step", label: "Load step 1 mA → " + g(v.Ido) + " A (shape only)", unit: "V", plot: true, deck: "Vin vin 0 " + g(v.Vout + 1) + "\nIl vout 0 PULSE(1m " + g(v.Ido) + " " + g(2 / v.BW) + " 100n 100n " + g(10 / v.BW) + " 1)\nCo vout 0 1u\nX1 vin vout 0 DUT\n.tran " + g(0.02 / v.BW) + " " + g(20 / v.BW), read: r => Math.min(...S.signal(r, "vout").re)}
      ];
    }
  };
  // Diode family fitting: IS and N from two points, RS from a third (or from the highest point
  // with N assumed). Shockley: V = N·VT·ln(I/IS) + I·RS.
  function fitJunction(points, nDefault) {
    const p = points.filter(q => q.v > 0 && q.i > 0).sort((a, b) => a.i - b.i);
    if (!p.length) fail("A diode needs Vf at If.");
    let n = nDefault, is, rs = 0;
    // With three points, alternate: N and IS from the two lowest points with the RS drop removed,
    // then RS from the highest point, until RS settles.
    for (let it = 0; it < (p.length >= 3 ? 200 : 1); it++) {
      const v0 = p[0].v - p[0].i * rs, v1 = p.length >= 2 ? p[1].v - p[1].i * rs : 0;
      n = p.length >= 2 ? (v1 - v0) / (VT * Math.log(p[1].i / p[0].i)) : nDefault;
      if (!(n > 0.3 && n < 10)) n = nDefault;
      is = p[0].i / Math.exp(v0 / (n * VT));
      if (p.length < 3) break;
      const k = p[p.length - 1], next = Math.max(0, (k.v - n * VT * Math.log(k.i / is)) / k.i);
      if (Math.abs(next - rs) < 1e-12) break;
      rs = next;
    }
    return {is, n, rs};
  }
  const pts = (v, pairs) => pairs.map(([a, b]) => ({v: v[a], i: v[b]})).filter(q => Number.isFinite(q.v) && Number.isFinite(q.i));
  const diodeBench = (v, pairs, label) => pts(v, pairs).map((q, k) => ({key: pairs[k][0], label: label + " at " + g(q.i) + " A", unit: "V", want: q.v, tol: 0.01, deck: "I1 0 a " + g(q.i) + "\nD1 a 0 DUT\n.op", read: r => r.nodes.a}));
  T.diode = {
    v: 1, title: "Diode", rung: "Generic", letter: "D", roles: [["A", 1], ["K", 1]],
    fields: [F("Type", "Junction", "", 0, "silicon", ["silicon", "Schottky"]), F("Vf", "Forward voltage", "V", 1, v => [/schottky/i.test(v.Type) ? "0.35 V" : "0.7 V"]), F("If", "at forward current", "A", 1, "10 mA"),
      F("Vf2", "Second point: Vf", "V", 0, null), F("If2", "at If", "A", 0, null), F("Vf3", "High-current point: Vf (gives RS)", "V", 0, null), F("If3", "at If", "A", 0, null),
      F("Cj", "Junction capacitance", "F", 0, null), F("BV", "Reverse breakdown voltage", "V", 0, null), F("IR", "Reverse current at BV", "A", 0, null)],
    notModelled: ["reverse recovery (trr: the Quick engine has no transit time)", "temperature beyond 27 °C", "capacitance voltage dependence"],
    model(v) {
      const j = fitJunction(pts(v, [["Vf", "If"], ["Vf2", "If2"], ["Vf3", "If3"]]), /schottky/i.test(v.Type) ? 1.05 : 1.8);
      return "D(IS=" + g(j.is) + " N=" + g(j.n) + (j.rs ? " RS=" + g(j.rs) : "") + (v.Cj ? " CJO=" + g(v.Cj) : "") + (v.BV ? " BV=" + g(v.BV) + " IBV=" + g(v.IR || 1e-6) : "") + ")";
    },
    assume: v => (Number.isFinite(v.Vf2) && Number.isFinite(v.If2) ? [] : ["one Vf point: N = " + (/schottky/i.test(v.Type) ? "1.05 (Schottky)" : "1.8 (silicon)") + " (Waffle default)"]),
    bench: v => diodeBench(v, [["Vf", "If"], ["Vf2", "If2"], ["Vf3", "If3"]], "Vf")
  };
  T.zener = {
    v: 1, title: "Zener diode", rung: "Generic", letter: "D", roles: [["A", 1], ["K", 1]],
    fields: [F("Vz", "Zener voltage", "V", 1, "5.1 V"), F("Izt", "at test current", "A", 1, "5 mA"), F("Zzt", "Dynamic impedance at Izt", "Ω", 0, "5 Ω"), F("Vf", "Forward voltage at 10 mA", "V", 0, "0.75 V")],
    notModelled: ["the knee below Izk (Zzk)", "noise", "temperature coefficient of Vz"],
    model(v) {
      const n = 1, rs = Math.max(0, v.Zzt - n * VT / v.Izt), j = fitJunction([{v: v.Vf, i: 0.01}], 1);
      return "D(IS=" + g(j.is) + " N=1 RS=" + g(rs) + " BV=" + g(v.Vz - v.Izt * rs) + " IBV=" + g(v.Izt) + ")";
    },
    bench: v => [{key: "Vz", label: "Vz at " + g(v.Izt) + " A", unit: "V", want: v.Vz, tol: 0.01, deck: "I1 0 k " + g(v.Izt) + "\nD1 0 k DUT\n.op", read: r => r.nodes.k}]
  };
  T.led = {
    v: 1, title: "LED", rung: "Generic", letter: "D", roles: [["A", 1], ["K", 1]],
    fields: [F("Colour", "Colour", "", 0, "red", ["red", "orange", "amber", "yellow", "green", "blue", "white", "infrared", "ultraviolet"]),
      F("Vf", "Forward voltage", "V", 1, v => [g(LED_VF[String(v.Colour).toUpperCase()] || 2) + " V", "default", "typical for the colour (Waffle default)"]), F("If", "at forward current", "A", 1, "20 mA"),
      F("Vf2", "Second point: Vf", "V", 0, null), F("If2", "at If", "A", 0, null), F("Vf3", "High-current point: Vf (gives RS)", "V", 0, null), F("If3", "at If", "A", 0, null)],
    notModelled: ["optical output (a brightness probe is proportional to current only)", "temperature", "reverse breakdown"],
    model(v) { const j = fitJunction(pts(v, [["Vf", "If"], ["Vf2", "If2"], ["Vf3", "If3"]]), 2); return "D(IS=" + g(j.is) + " N=" + g(j.n) + (j.rs ? " RS=" + g(j.rs) : "") + ")"; },
    assume: v => (Number.isFinite(v.Vf2) && Number.isFinite(v.If2) ? [] : ["one Vf point: N = 2 (Waffle default)"]),
    bench: v => diodeBench(v, [["Vf", "If"], ["Vf2", "If2"], ["Vf3", "If3"]], "Vf")
  };
  T.bjt = {
    v: 1, title: "Bipolar transistor", rung: "Generic", letter: "X", roles: [["C", 1], ["B", 1], ["E", 1]],
    fields: [F("Polarity", "Polarity", "", 1, "NPN", ["NPN", "PNP"]), F("hFE", "DC current gain", "", 1, "100"), F("Ic", "at collector current", "A", 1, "10 mA"), F("Vce", "and Vce", "V", 0, "5 V"),
      F("Vbe", "Vbe at that Ic", "V", 0, null), F("VAF", "Early voltage", "V", 0, "100 V"), F("fT", "Transition frequency", "Hz", 0, null), F("Cob", "Output capacitance", "F", 0, null)],
    notModelled: ["saturation detail (Vce(sat), quasi-saturation)", "high injection (hFE roll-off)", "capacitance voltage dependence", "temperature"],
    build(v) {
      const pnp = /pnp/i.test(v.Polarity), kq = 1 + (v.Vce - 0.65) / v.VAF, bf = v.hFE / kq;
      const is = Number.isFinite(v.Vbe) ? v.Ic / kq / Math.exp(Math.abs(v.Vbe) / VT) : 1e-14;
      const L = ["Q1 c b e @M", ".model @M " + (pnp ? "PNP" : "NPN") + "(IS=" + g(is) + " BF=" + g(bf) + " BR=1 VAF=" + g(v.VAF) + ")"];
      if (v.Cob) L.push("Cbc b c " + g(v.Cob));
      if (v.fT) { const cbe = v.Ic / VT / (TAU * v.fT) - (v.Cob || 0); if (cbe > 0) L.push("Cbe b e " + g(cbe)); }
      return {ports: ["C", "B", "E"], nodes: "c b e", lines: L, notes: Number.isFinite(v.Vbe) ? [] : ["IS = 1e-14 (Waffle default; enter Vbe at Ic to fit it)"]};
    },
    bench(v) {
      const pnp = /pnp/i.test(v.Polarity), s = pnp ? -1 : 1;
      return [{key: "hFE", label: "hFE at " + g(v.Ic) + " A, Vce " + g(v.Vce) + " V", unit: "", want: v.hFE, tol: 0.03,
        deck: "Vc c 0 " + g(s * v.Vce) + "\nIb 0 b " + g(s * v.Ic / v.hFE) + "\nX1 c b 0 DUT\n.op", read: r => -s * r.currents.Vc / (v.Ic / v.hFE)}];
    }
  };
  T.mosfet = {
    v: 1, title: "MOSFET", rung: "Generic", letter: "X", roles: [["D", 1], ["G", 1], ["S", 1]],
    fields: [F("Polarity", "Channel", "", 1, "N", ["N", "P"]), F("Vth", "Gate threshold", "V", 1, "2 V"), F("Ith", "at drain current", "A", 0, "250 µA"),
      F("Rds", "Rds(on)", "Ω", 1, "100 mΩ"), F("VgsR", "at Vgs", "V", 1, "10 V"), F("Lambda", "Channel-length modulation", "1/V", 0, "0.01"),
      F("Ciss", "Ciss", "F", 0, null), F("Coss", "Coss", "F", 0, null), F("Crss", "Crss", "F", 0, null), F("Vsd", "Body diode Vsd at 1 A", "V", 0, "0.8 V"), F("BVdss", "BVdss", "V", 0, null)],
    notModelled: ["avalanche", "the thermal coefficient of Rds(on)", "the gate plateau shape (level 1)", "subthreshold conduction", "capacitance voltage dependence"],
    // Level 1: Rds(on) = 1/(KP·(Vgs − Vth')), with Vth' corrected from the datasheet's Id-at-threshold
    // definition (saturation at Vgs = Vth: Ith = KP/2·(Vth − Vth')²).
    fit(v) {
      const vth = Math.abs(v.Vth), vgs = Math.abs(v.VgsR);
      let vt = vth, kp = 1;
      for (let i = 0; i < 100; i++) { kp = 1 / (v.Rds * Math.max(vgs - vt, 1e-3)); const next = vth - Math.sqrt(2 * v.Ith / kp); if (Math.abs(next - vt) < 1e-12) { vt = next; break; } vt = next; }
      return {kp, vt};
    },
    build(v) {
      const p = /^p/i.test(v.Polarity), {kp, vt} = T.mosfet.fit(v), L = [];
      L.push("M1 d g s s @M", ".model @M " + (p ? "PMOS" : "NMOS") + "(VTO=" + g(p ? -vt : vt) + " KP=" + g(kp) + " LAMBDA=" + g(v.Lambda) + ")");
      L.push((p ? "Db d s" : "Db s d") + " @MB", ".model @MB D(IS=" + g(1 / Math.exp(v.Vsd / (1.3 * VT))) + " N=1.3" + (v.BVdss ? " BV=" + g(v.BVdss) + " IBV=1u" : "") + ")");
      if (v.Crss) L.push("Cgd g d " + g(v.Crss));
      if (v.Ciss) L.push("Cgs g s " + g(Math.max(v.Ciss - (v.Crss || 0), 0)));
      if (v.Coss) L.push("Cds d s " + g(Math.max(v.Coss - (v.Crss || 0), 0)));
      return {ports: ["D", "G", "S"], nodes: "d g s", lines: L, notes: v.Ciss || v.Coss || v.Crss ? [] : ["no capacitances entered: gate charge and switching edges are not modelled"]};
    },
    bench(v) {
      const p = /^p/i.test(v.Polarity), s = p ? -1 : 1, vth = Math.abs(v.Vth);
      return [
        {key: "Rds", label: "Rds(on) at Vgs " + g(v.VgsR) + " V, Vds 10 mV", unit: "Ω", want: v.Rds, tol: 0.03, deck: "Vg g 0 " + g(s * Math.abs(v.VgsR)) + "\nVd d 0 " + g(s * 0.01) + "\nX1 d g 0 DUT\n.op", read: r => 0.01 / Math.abs(r.currents.Vd)},
        {key: "Vth", label: "Vgs where Id = " + g(v.Ith) + " A (Vds = Vgs)", unit: "V", want: vth, tol: 0.03, deck: "Vg g 0 0\nX1 g g 0 DUT\n.dc Vg 0 " + g(s * 2 * vth) + " " + g(s * vth / 400),
          read: r => { const i = S.signal(r, "i(Vg)").re.map(Math.abs); return Math.abs(cross(r.x, i, v.Ith)); }}
      ];
    }
  };
  T.capacitor = {
    v: 1, title: "Capacitor", rung: "Generic", letter: "X", roles: [["T1", 1], ["T2", 1]], twoTerminal: true,
    fields: [F("C", "Capacitance", "F", 1, "100 nF"), F("Case", "Case size", "text", 0, null), F("Dielectric", "Dielectric", "", 0, null, ["C0G", "X5R", "X6S", "X7R", "X7S", "X8R", "Y5V"]),
      F("Vrated", "Rated voltage", "V", 0, null), F("ESR", "ESR", "Ω", 0, "0 Ω"), F("ESL", "ESL", "H", 0, v => (ESL[v.Case] ? [g(ESL[v.Case]), "default", "typical for " + v.Case + " (Waffle default)"] : ["0 H"])),
      F("Bias", "DC-bias points (V:% of nominal, e.g. 2.5:70, 5:45)", "text", 0, null)],
    notModelled: ["ageing", "temperature (unless a coefficient is given)", "dielectric absorption", "DC-bias hysteresis"],
    // C(V) = C0·(r + (1 − r)/(1 + (V/Vk)²)); charge Q(V) = C0·(r·V + (1 − r)·Vk·atan(V/Vk)).
    bias(v) {
      const d = String(v.Dielectric || "").toUpperCase().replace(/\s.*$/, "");
      const points = String(v.Bias || "").split(/[,;]+/).map(s => s.split(":").map(Number)).filter(q => q.length === 2 && q.every(Number.isFinite) && q[0] > 0).map(([x, y]) => [x, y / 100]);
      if (points.length) {
        let best = null;
        for (let k = 1; k <= 400; k++) {
          const vk = Math.max(...points.map(q => q[0])) * k / 50, h = points.map(([x]) => 1 / (1 + (x / vk) ** 2));
          // least squares for r in y = r + (1 − r)h: y − h = r(1 − h)
          let num = 0, den = 0; points.forEach(([, y], i) => { num += (y - h[i]) * (1 - h[i]); den += (1 - h[i]) ** 2; });
          const r = Math.min(1, Math.max(0, den ? num / den : 0)), err = points.reduce((s, [, y], i) => s + (r + (1 - r) * h[i] - y) ** 2, 0);
          if (!best || err < best.err) best = {r, vk, err};
        }
        return {r: best.r, vk: best.vk, src: "points"};
      }
      if (!BIAS_KNEE[d] || !(v.Vrated > 0)) return null;
      return {r: 0.15, vk: BIAS_KNEE[d] * v.Vrated * (CASE_FACTOR[v.Case] || 1), src: "class"};
    },
    build(v) {
      const b = T.capacitor.bias(v), L = [], segs = ["C", ...(v.ESR > 0 ? ["R"] : []), ...(v.ESL > 0 ? ["L"] : [])], at = i => (i === 0 ? "1" : i === segs.length ? "2" : "n" + i);
      segs.forEach((k, i) => {
        const a = at(i), z = at(i + 1);
        if (k === "C") L.push(b ? "Bc " + a + " " + z + " Q={" + g(v.C) + "*(" + g(b.r) + "*V(" + a + "," + z + ")+" + g((1 - b.r) * b.vk) + "*atan(V(" + a + "," + z + ")/" + g(b.vk) + "))}" : "C1 " + a + " " + z + " " + g(v.C));
        else if (k === "R") L.push("Resr " + a + " " + z + " " + g(v.ESR));
        else L.push("Lesl " + a + " " + z + " " + g(v.ESL));
      });
      return {ports: ["T1", "T2"], nodes: "1 2", lines: L, notes: b ? [b.src === "class" ? "DC bias: class-generic " + String(v.Dielectric).toUpperCase() + " curve, an estimate, not vendor data (C at " + g(v.Vrated) + " V ≈ " + Math.round(100 * (b.r + (1 - b.r) / (1 + (v.Vrated / b.vk) ** 2))) + " %)" : "DC bias fitted to the entered points"] : []};
    },
    bench(v) {
      const f = 1 / (TAU * Math.sqrt(v.C * Math.max(v.ESL, 1e-12))) / 100, b = T.capacitor.bias(v);
      const m = [{key: "C", label: "C at 0 V from |Z| at " + g(f) + " Hz", unit: "F", want: v.C, tol: 0.05, deck: "I1 0 a AC 1\nX1 a 0 DUT\nRb a 0 1g\n.ac lin 1 " + g(f) + " " + g(f), read: r => 1 / (TAU * f * S.mag(S.signal(r, "a"))[0])}];
      if (b && v.Vrated > 0) {
        const vb = v.Vrated / 2;
        m.push({key: "Cbias", label: "C at " + g(vb) + " V DC bias", unit: "F", deck: "Vb b 0 DC " + g(vb) + " AC 1\nRs b a 1\nX1 a 0 DUT\n.ac lin 1 " + g(f) + " " + g(f),
          read: r => { const ia = S.signal(r, "i(Vb)"); return Math.hypot(ia.re[0], ia.im[0]) / (TAU * f * S.mag(S.signal(r, "a"))[0]); }});
      }
      return m;
    }
  };
  T.inductor = {
    v: 1, title: "Inductor", rung: "Generic", letter: "X", roles: [["T1", 1], ["T2", 1]], twoTerminal: true,
    fields: [F("L", "Inductance", "H", 1, "10 µH"), F("DCR", "DC resistance", "Ω", 0, "0 Ω"), F("SRF", "Self-resonant frequency", "Hz", 0, null), F("Irated", "Rated current", "A", 0, null)],
    notModelled: ["saturation (Isat)", "core loss", "temperature"],
    build(v) {
      const L = ["L1 1 " + (v.DCR > 0 ? "a " : "2 ") + g(v.L)];
      if (v.DCR > 0) L.push("Rdcr a 2 " + g(v.DCR));
      if (v.SRF > 0) L.push("Cpar 1 2 " + g(1 / ((TAU * v.SRF) ** 2 * v.L)));
      return {ports: ["T1", "T2"], nodes: "1 2", lines: L, notes: []};
    },
    bench: v => [{key: "L", label: "L from |Z| at SRF/100 or 1 kHz", unit: "H", want: v.L, tol: 0.05, deck: "I1 0 a AC 1\nX1 a 0 DUT\n.ac lin 1 " + g(v.SRF > 0 ? v.SRF / 100 : 1e3) + " " + g(v.SRF > 0 ? v.SRF / 100 : 1e3),
      read: r => { const f = v.SRF > 0 ? v.SRF / 100 : 1e3, z = S.signal(r, "a"); return z.im[0] / (TAU * f); }}]
  };
  // Ferrite bead: Rdc + (L ∥ R ∥ C). One point: R = 1.25·Z100 and a resonance at 250 MHz (flagged);
  // more points: least squares on log |Z| (Nelder–Mead over log R, L, C).
  const ferriteZ = (p, f) => { const w = TAU * f, gR = 1 / p.R, b = w * p.C - 1 / (w * p.L); return Math.hypot(gR, b) ** -1; };
  T.ferrite = {
    v: 1, title: "Ferrite bead", rung: "Generic", letter: "X", roles: [["T1", 1], ["T2", 1]], twoTerminal: true,
    fields: [F("Z100", "Impedance at 100 MHz", "Ω", 1, "600 Ω"), F("Rdc", "DC resistance", "Ω", 0, "0.1 Ω"), F("Points", "Z(f) points (MHz:Ω, e.g. 10:120, 1000:300)", "text", 0, null), F("Irated", "Rated current", "A", 0, null)],
    notModelled: ["the DC-bias loss of impedance (enter a curve measured at bias)", "temperature"],
    fit(v) {
      const points = [[100e6, v.Z100], ...String(v.Points || "").split(/[,;]+/).map(s => s.split(":").map(Number)).filter(q => q.length === 2 && q.every(x => x > 0)).map(([f, z]) => [f * 1e6, z])];
      const w0 = TAU * 250e6, R = 1.25 * v.Z100, w = TAU * 100e6, inv = Math.sqrt(Math.max(1 / v.Z100 ** 2 - 1 / R ** 2, 1e-30)) / Math.abs(w * w / (w0 * w0) - 1);
      let p = {R, L: 1 / (w * inv), C: 0};
      p.C = 1 / (w0 * w0 * p.L);
      if (points.length < 2) return {...p, shape: "default"};
      const cost = q => points.reduce((s, [f, z]) => s + Math.log(ferriteZ({R: Math.exp(q[0]), L: Math.exp(q[1]), C: Math.exp(q[2])}, f) / z) ** 2, 0);
      const best = nelderMead(cost, [Math.log(p.R), Math.log(p.L), Math.log(p.C)]);
      return {R: Math.exp(best[0]), L: Math.exp(best[1]), C: Math.exp(best[2]), shape: "fitted"};
    },
    build(v) {
      const p = T.ferrite.fit(v);
      return {ports: ["T1", "T2"], nodes: "1 2", lines: ["Rdc 1 a " + g(Math.max(v.Rdc, 1e-6)), "Rp a 2 " + g(p.R), "Lp a 2 " + g(p.L), "Cp a 2 " + g(p.C)],
        notes: [p.shape === "default" ? "one Z point: default curve shape (R = 1.25·Z100, resonance 250 MHz; Waffle default)" : "fitted to the entered Z(f) points"]};
    },
    bench: v => [{key: "Z100", label: "|Z| at 100 MHz", unit: "Ω", want: v.Z100, tol: 0.05, deck: "I1 0 a AC 1\nX1 a 0 DUT\n.ac lin 1 100meg 100meg", read: r => S.mag(S.signal(r, "a"))[0]}]
  };
  T.crystal = {
    v: 1, title: "Crystal", rung: "Generic", letter: "X", roles: [["T1", 1], ["T2", 1]], twoTerminal: true,
    fields: [F("f", "Frequency", "Hz", 1, "16 MHz"), F("CL", "Load capacitance", "F", 1, "10 pF"), F("ESR", "ESR", "Ω", 1, "50 Ω"), F("C0", "Shunt capacitance C0", "F", 0, "3 pF"), F("C1", "Motional capacitance C1", "F", 0, "5 fF")],
    notModelled: ["oscillator start-up (millions of cycles: use an AC impedance plot)", "drive level", "overtones and spurious modes", "ageing and temperature"],
    build(v) {
      return {ports: ["T1", "T2"], nodes: "1 2", lines: ["R1 1 a " + g(v.ESR), "L1 a b " + g(1 / ((TAU * v.f) ** 2 * v.C1)), "C1 b 2 " + g(v.C1), "C0 1 2 " + g(v.C0)],
        notes: ["series resonance at f; parallel resonance with CL = " + g(v.f * (1 + v.C1 / (2 * (v.C0 + v.CL)))) + " Hz"]};
    },
    bench(v) {
      const span = v.f * 2e-4;
      return [{key: "f", label: "Series resonance (minimum |Z|)", unit: "Hz", want: v.f, tol: 1e-4, deck: "I1 0 a AC 1\nX1 a 0 DUT\nRb a 0 1g\n.ac lin 801 " + g(v.f - span) + " " + g(v.f + span),
        read: r => { const z = S.mag(S.signal(r, "a")); return r.x[z.indexOf(Math.min(...z))]; }},
      {key: "ESR", label: "|Z| at series resonance", unit: "Ω", want: v.ESR, tol: 0.05, deck: "I1 0 a AC 1\nX1 a 0 DUT\nRb a 0 1g\n.ac lin 801 " + g(v.f - span) + " " + g(v.f + span), read: r => Math.min(...S.mag(S.signal(r, "a")))}];
    }
  };
  const FAMILY = {cmos: "CMOS (HC, AC, LVC, AHC): threshold half the supply", ttl: "TTL-compatible inputs (HCT, ACT, AHCT): 1.4 V"};
  T.logic = {
    v: 1, title: "Logic gate", rung: "Generic", letter: "X",
    roles: [["IN1", 1], ["IN2", 0], ["IN3", 0], ["IN4", 0], ["OE#", 0], ["OUT", 1], ["V+", 0], ["GND", 0]], perUnit: ["IN1", "IN2", "IN3", "IN4", "OE#", "OUT"],
    fields: [F("Function", "Function", "", 1, "and", ["and", "nand", "or", "nor", "xor", "xnor", "not", "buffer", "tristate"]), F("Family", "Input thresholds", "", 1, "cmos", ["cmos", "ttl"]),
      F("Supply", "Supply (when no supply pins are connected)", "text", 1, "3.3 V"), F("tpd", "Propagation delay", "s", 0, "5 ns"), F("Rout", "Output resistance", "Ω", 0, "25 Ω"),
      F("Schmitt", "Schmitt-trigger inputs", "", 0, "no", ["no", "yes"]), F("Hyst", "Input hysteresis (Schmitt)", "V", 0, v => [g(0.1 * ((supply(v.Supply) || {hi: 3.3}).hi)) + " V", "default", "10 % of the supply (Waffle default)"]),
      F("Iq", "Quiescent current", "A", 0, "1 µA")],
    notModelled: ["timing violations and metastability", "separate rise and fall times", "output current limits (an IBIS model can replace the output stage later)"],
    build(v, have) {
      const ins = ["IN1", "IN2", "IN3", "IN4"].filter(r => have.has(r)), fn = String(v.Function).toLowerCase(), sup = have.has("V+"), gnd = have.has("GND"), oe = have.has("OE#") && fn === "tristate";
      const rails = supply(v.Supply) || {lo: 0, hi: 3.3}, L = [];
      if (!sup) L.push("Vsp vcc " + (gnd ? "gnd " : "0 ") + g(rails.hi - rails.lo));
      const g0 = gnd ? "gnd" : "0", th = /ttl/i.test(v.Family) ? "1.4" : "0.5*V(vcc," + g0 + ")", schmitt = /^y/i.test(v.Schmitt);
      const lv = (node, i) => {
        if (!schmitt) return "(0.5*(1+tanh((V(" + node + "," + g0 + ")-" + th + ")/0.02)))";
        L.push("Bh" + i + " h" + i + " 0 V=0.5*(1+tanh((V(" + node + "," + g0 + ")-" + th + "+" + g(v.Hyst) + "*(V(k" + i + ")-0.5))/0.02))", "Rh" + i + " h" + i + " k" + i + " 1", "Ch" + i + " k" + i + " 0 1p");
        return "V(k" + i + ")";
      };
      const l = ins.map((r, i) => lv("in" + (i + 1), i));
      const and = l.join("*") || "0", or = "(1-" + (l.map(x => "(1-" + x + ")").join("*") || "1") + ")", xor = l.reduce((a, b) => "(" + a + "+" + b + "-2*" + a + "*" + b + ")");
      const f = {and, nand: "(1-" + and + ")", or, nor: "(1-" + or + ")", xor, xnor: "(1-" + xor + ")", not: "(1-" + l[0] + ")", buffer: l[0], tristate: l[0]}[fn] || and;
      L.push("Bt t 0 V=" + f, "Rd t s 1k", "Cd s 0 " + g(v.tpd / Math.LN2 / 1e3), "Bo o " + g0 + " V=V(vcc," + g0 + ")*V(s)");
      if (oe) L.push("Boe o out I=(V(o)-V(out))/" + g(v.Rout) + "*(1-" + lv("oe", 9) + ")+1e-9*(V(o)-V(out))");
      else L.push("Ro o out " + g(v.Rout));
      L.push("Iq vcc " + g0 + " " + g(v.Iq));
      const ports = [...ins, ...(oe ? ["OE#"] : []), "OUT", ...(sup ? ["V+"] : []), ...(gnd ? ["GND"] : [])];
      const names = {IN1: "in1", IN2: "in2", IN3: "in3", IN4: "in4", "OE#": "oe", OUT: "out", "V+": "vcc", GND: "gnd"};
      return {ports, nodes: ports.map(p => names[p]).join(" "), lines: L, notes: [FAMILY[/ttl/i.test(v.Family) ? "ttl" : "cmos"], ...(sup ? [] : ["no supply pin connected: " + g(rails.hi) + " V from the Supply field"])]};
    },
    benchRoles: v => new Set([/^(not|buffer|tristate)$/i.test(v.Function) ? "IN1" : "IN2", "IN1", "OUT", "V+", "GND"]),
    bench(v) {
      const hi = (supply(v.Supply) || {hi: 3.3}).hi, fn = String(v.Function).toLowerCase(), inv = /^(nand|nor|xnor|not)$/.test(fn);
      const t0 = 4 * v.tpd, tstop = t0 + 6 * v.tpd, one = /^(and|nand)$/.test(fn) ? "Vb in2 0 " + g(hi) + "\n" : /^(or|nor|xor|xnor)$/.test(fn) ? "Vb in2 0 0\n" : "";
      const twoIn = !!one, ports = (twoIn ? "in1 in2 " : "in1 ") + "out vcc 0";
      return [{key: "tpd", label: "Propagation delay", unit: "s", want: v.tpd, tol: 0.05,
        deck: "Vcc vcc 0 " + g(hi) + "\n" + one + "Va in1 0 PULSE(0 " + g(hi) + " " + g(t0) + " " + g(v.tpd / 1000) + " " + g(v.tpd / 1000) + " 1 2)\nX1 " + ports + " DUT\n.tran " + g(tstop / 4000) + " " + g(tstop),
        read: r => cross(r.x, S.signal(r, "out").re, hi / 2) - t0 - v.tpd / 2000, bench: {inputs: twoIn ? 2 : 1, inv}}];
    }
  };
  T.load = {
    v: 1, title: "Load (supply current only)", rung: "Load-only", letter: "X", roles: [["V+", 1], ["GND", 0]],
    fields: [F("Iq", "Supply current", "A", 1, "1 mA")],
    notModelled: ["any logic behaviour", "pin capacitances", "a supply current profile over time"],
    build: (v, have) => ({ports: have.has("GND") ? ["V+", "GND"] : ["V+"], nodes: have.has("GND") ? "vcc gnd" : "vcc", lines: ["Iq vcc " + (have.has("GND") ? "gnd " : "0 ") + g(v.Iq)], notes: []}),
    bench: () => []
  };
  T.switch = {
    v: 1, title: "Switch", rung: "Generic", letter: "X", roles: [["T1", 0], ["T2", 0], ["COM", 0], ["NO", 0], ["NC", 0]],
    fields: [F("State", "State", "", 1, "open", ["open", "closed"]), F("Ron", "Contact resistance", "Ω", 0, "50 mΩ"), F("Roff", "Open resistance", "Ω", 0, "1 GΩ")],
    notModelled: ["contact bounce", "switching over time (the state is fixed for a run)", "current rating"],
    build(v, have) {
      const on = /clos/i.test(v.State), r = x => g(x ? v.Ron : v.Roff);
      if (have.has("COM")) return {ports: ["COM", "NO", "NC"], nodes: "com no nc", lines: ["Rno com no " + r(on), "Rnc com nc " + r(!on)], notes: ["closed means COM–NO"]};
      return {ports: ["T1", "T2"], nodes: "1 2", lines: ["Rsw 1 2 " + r(on)], notes: []};
    },
    bench: () => []
  };
  // Ideal rung.
  T["opamp-ideal"] = {
    v: 1, title: "Ideal op-amp", rung: "Ideal", letter: "X", roles: [["IN+", 1], ["IN-", 1], ["OUT", 1]], perUnit: ["IN+", "IN-", "OUT"], fields: [],
    notModelled: ["rails, slew rate, bandwidth, offsets, supply current: everything but gain"],
    build: () => ({ports: ["IN+", "IN-", "OUT"], nodes: "inp inn out", lines: ["E1 out 0 inp inn 1meg"], notes: []}), bench: () => []
  };
  T["diode-ideal"] = {
    v: 1, title: "Ideal diode", rung: "Ideal", letter: "D", roles: [["A", 1], ["K", 1]], fields: [],
    notModelled: ["forward drop beyond about 0.1 V, capacitance, breakdown, recovery"],
    model: () => "D(IS=1e-12 N=0.1)", bench: () => []
  };
  for (const [id, t] of Object.entries(T)) t.id = id;

  function nelderMead(f, x0, iters = 400) {
    const n = x0.length;
    let s = [x0, ...x0.map((_, i) => x0.map((v, j) => v + (i === j ? 0.5 : 0)))].map(x => ({x, f: f(x)}));
    for (let it = 0; it < iters; it++) {
      s.sort((a, b) => a.f - b.f);
      const c = x0.map((_, j) => s.slice(0, n).reduce((t, p) => t + p.x[j], 0) / n), w = s[n];
      const at = k => c.map((v, j) => v + k * (w.x[j] - v)), r = {x: at(-1)}; r.f = f(r.x);
      if (r.f < s[0].f) { const e = {x: at(-2)}; e.f = f(e.x); s[n] = e.f < r.f ? e : r; }
      else if (r.f < s[n - 1].f) s[n] = r;
      else { const k = {x: at(0.5)}; k.f = f(k.x); if (k.f < w.f) s[n] = k; else s = s.map((p, i) => (i ? {x: p.x.map((v, j) => s[0].x[j] + 0.5 * (v - s[0].x[j]))} : p)).map(p => ({x: p.x, f: p.f ?? f(p.x)})); }
    }
    s.sort((a, b) => a.f - b.f);
    return s[0].x;
  }
  // First time y crosses level (linear interpolation).
  function cross(xs, ys, level) {
    for (let i = 1; i < ys.length; i++) if ((ys[i - 1] - level) * (ys[i] - level) <= 0 && ys[i] !== ys[i - 1]) return xs[i - 1] + (xs[i] - xs[i - 1]) * (level - ys[i - 1]) / (ys[i] - ys[i - 1]);
    return NaN;
  }

  // ------------------------------------------------------------------ template ids and values
  function template(idv) {
    const m = /^([a-z][a-z-]*)(?:@(\d+))?$/.exec(String(idv || "").trim().toLowerCase());
    const t = m && T[m[1]];
    if (!t) return {error: "unknown template " + String(idv).slice(0, 40)};
    if (m[2] && Number(m[2]) !== t.v) return {error: "template " + m[1] + "@" + m[2] + " is not in this Waffle (it has @" + t.v + ")"};
    return {t};
  }
  // Resolve a template's fields from provenance records: entered values, derived values, then defaults.
  function values(t, params = {}) {
    const vals = {}, recs = {}, defaults = [], bad = [];
    const raw = {};
    for (const [k, x] of Object.entries(params || {})) { const r = rec(x); if (r) raw[k.toLowerCase()] = r; }
    for (const f of t.fields) {
      let r = raw[f.k.toLowerCase()];
      if (!r && f.def != null) {
        const d = typeof f.def === "function" ? f.def(vals, raw) : [f.def];
        if (d && d.derived != null) r = {v: g(d.derived), src: "derived", note: d.note};
        else if (d && d[0] != null) r = {v: String(d[0]), src: d[1] || "default", note: d[2] || "Waffle default"};
      }
      if (!r) continue;
      if (f.options || f.unit === "text") {
        if (f.options && !f.options.some(o => o.toLowerCase() === r.v.toLowerCase())) { bad.push(f.k); continue; }
        vals[f.k] = f.options ? f.options.find(o => o.toLowerCase() === r.v.toLowerCase()) : r.v;
      } else {
        const n = unitNum(r.v, f.unit);
        if (!Number.isFinite(n)) { bad.push(f.k); continue; }
        vals[f.k] = n;
      }
      recs[f.k] = r;
      if (r.src === "default") defaults.push(f.k);
    }
    return {vals, recs, defaults, bad};
  }
  // The rung follows from provenance (§5): Fitted needs every required field as datasheet or user
  // data and a passed bench check (placeholders: user sketch values count, no bench needed).
  function rungOf(t, recs, o = {}) {
    if (t.rung !== "Generic") return t.rung;
    const ok = t.fields.filter(f => f.req).every(f => recs[f.k] && TRUSTED.has(recs[f.k].src));
    return ok && (o.placeholder || o.check?.passed) ? "Fitted" : "Generic";
  }
  const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16).padStart(8, "0").slice(0, 6); };
  // Build the model text for a template: {name, letter, ports, model (".model" or ".subckt" text), notes, comments}.
  function instantiate(t, params, have = new Set(t.roles.map(r => r[0]))) {
    const {vals, recs, defaults, bad} = values(t, params);
    if (bad.length) return {error: "bad value for " + bad.join(", ")};
    const label = t.id + "@" + t.v, key = hash(label + JSON.stringify(vals) + [...have].sort().join(","));
    const name = "ATR_" + t.id.toUpperCase().replace(/-/g, "_") + "_" + key;
    const comments = ["* " + name + ": " + label + " template (" + t.title + "), generated by Waffle; not a vendor model"];
    for (const f of t.fields) if (recs[f.k]) comments.push("*   " + f.k + " = " + recs[f.k].v + " (" + (recs[f.k].src === "default" ? recs[f.k].note || "Waffle default" : SOURCE_LABEL[recs[f.k].src] + (recs[f.k].page ? " p." + recs[f.k].page : "")) + ")");
    if (t.letter === "D") {
      const assume = t.assume ? t.assume(vals) : [];
      return {name, letter: "D", ports: ["A", "K"], model: [...comments, ...assume.map(a => "*   " + a), ".model " + name + " " + t.model(vals)].join("\n"), notes: assume, vals, recs, defaults};
    }
    const b = t.build(vals, have);
    // Inner .model names (@M) are made unique per subcircuit: the deck's .model namespace is global.
    const lines = b.lines.map(l => l.replace(/@(\w+)/g, name + "_$1"));
    return {name, letter: "X", ports: b.ports, model: [...comments, ...b.notes.map(n => "*   " + n), ".subckt " + name + " " + b.nodes, ...lines, ".ends " + name].join("\n"), notes: b.notes, vals, recs, defaults};
  }
  // Run a template's bench in the Quick engine: measured values against entered ones.
  function benchCheck(t, params, o = {}) {
    const pre = values(t, params), inst = instantiate(t, params, t.benchRoles ? t.benchRoles(pre.vals) : undefined);
    if (inst.error) return {passed: false, error: inst.error, measures: []};
    const benches = t.bench(inst.vals), out = [], started = Date.now();
    for (const b of benches) {
      let got = NaN, err = null, res = null;
      const deck = "* bench " + b.key + "\n" + inst.model.replace(new RegExp("\\b" + inst.name + "\\b", "g"), "DUT") + "\n" + b.deck + "\n.end";
      try { res = S.simulate(deck); got = b.read(res); } catch (e) { err = e.message; }
      const ok = b.want == null ? null : Number.isFinite(got) && Math.abs(got - b.want) <= b.tol * Math.abs(b.want || 1);
      out.push({key: b.key, label: b.label, unit: b.unit, got, want: b.want, tol: b.tol, ok, error: err, ...(o.keep ? {res} : {})});
    }
    const checked = out.filter(m => m.ok != null);
    return {passed: checked.every(m => m.ok) && !out.some(m => m.error), measures: out, ms: Date.now() - started};
  }

  // ------------------------------------------------------------------ inference and placeholders
  const PLACEHOLDER = {opamp: "opamp", comparator: "comparator", bjt: "bjt", mosfet: "mosfet", ldo: "ldo", logic: "logic", memory: "load", mcu: "load", switch: "switch"};
  const GENERIC = {capacitor: "capacitor", polarised: "capacitor", electrolytic: "capacitor", inductor: "inductor", ferrite: "ferrite", crystal: "crystal", led: "led"};
  function suggest(c, def, alpha) {
    const gen = def?.generic;
    if (gen?.role === "placeholder" && PLACEHOLDER[gen.family]) return PLACEHOLDER[gen.family];
    if (gen && GENERIC[gen.family]) return GENERIC[gen.family];
    if (gen?.family === "diode") return gen.subtype === "zener" ? "zener" : "diode";
    const names = new Set((c.pins || []).map(p => norm(p.fn || p.name))), has = (...r) => r.every(x => SYN[x].some(s => names.has(s)));
    const text = [def?.name, def?.category, c.value].join(" ");
    if (has("IN+", "IN-", "OUT")) return /compar/i.test(text) ? "comparator" : "opamp";
    if (has("VIN", "VOUT", "GND")) return "ldo";
    if (["D", "G", "S"].every(r => names.has(r)) && (c.pins || []).length <= 4) return "mosfet";
    if (["C", "B", "E"].every(r => names.has(r)) && (c.pins || []).length <= 4) return "bjt";
    const two = (c.pins || []).length === 2;
    if (two && /^(Y|X|XTAL)$/.test(alpha)) return "crystal";
    if (two && /^(FB|L)$/.test(alpha)) return alpha === "FB" ? "ferrite" : "inductor";
    if (two && /^(ZD|DZ)$/.test(alpha)) return "zener";
    if (two && /^LED$/.test(alpha)) return "led";
    if (two && /^(SW|S)$/.test(alpha)) return "switch";
    if (/^(U|IC)$/.test(alpha) && has("V+")) return "load";
    return null;
  }
  // Fields filled from the part's own parameters (src user: typed into the design or its library);
  // structural placeholder parameters (units, polarity, output type) too.
  function fromPart(id, c, def, params) {
    const p = {}, get = k => { for (const [n, v] of Object.entries(params || {})) if (n.toLowerCase().replace(/[\s_.]/g, "") === k.toLowerCase().replace(/[\s_.]/g, "") && v != null && String(v).trim() !== "") return String(v); return null; };
    const set = (k, v, note) => { if (v != null && String(v).trim() !== "") p[k] = {v: String(v), src: "user", ...(note ? {note} : {})}; };
    const gp = def?.generic?.params || {}, value = String(c.value || "");
    const rr = {input: "RRI", output: "RRO", "input and output": "RRIO"};
    switch (id) {
      case "opamp": set("GBW", get("GBW")); set("Rails", rr[String(get("Rail-to-rail") || "").toLowerCase()] || null); set("Supply", get("Supply")); break;
      case "comparator": set("Hyst", get("Hysteresis")); set("Supply", get("Supply")); if (gp.output) set("Output", gp.output); break;
      case "ldo": set("Vout", get("Vout") || get("Output voltage")); if (get("Iout")) p.Ido = {v: get("Iout"), src: "derived", note: "dropout current taken as the rated output current"}; break;
      case "mosfet": set("Rds", get("Rds(on)")); if (gp.polarity) set("Polarity", String(gp.polarity).toUpperCase()); else if (/p-?ch|pmos/i.test(def?.name + " " + value)) set("Polarity", "P"); break;
      case "bjt": if (gp.polarity) set("Polarity", String(gp.polarity).toUpperCase()); else if (/pnp/i.test(def?.name + " " + value)) set("Polarity", "PNP"); break;
      case "capacitor": set("C", value, "the part value"); set("Vrated", get("Voltage")); set("Dielectric", (get("Dielectric") || "").replace(/\s.*$/, "") || null); set("Case", def?.generic?.package || def?.package || null); break;
      case "inductor": set("L", value, "the part value"); set("Irated", get("Current")); break;
      case "ferrite": set("Z100", (/(\d[\d.]*\s*[kM]?)\s*(Ω|ohm)?\s*@\s*100\s*MHz/i.exec(value) || [])[1] || null, "the part value"); set("Irated", get("Current")); break;
      case "crystal": set("f", value, "the part value"); set("CL", get("Load capacitance")); break;
      case "zener": set("Vz", get("Voltage")); break;
      case "diode": if (def?.generic?.subtype === "schottky" || /schottky/i.test(value)) set("Type", "Schottky"); break;
      case "led": { const col = Object.keys(LED_VF).find(k => new RegExp("\\b" + k + "\\b", "i").test(value)); if (col) set("Colour", col.toLowerCase()); set("Vf", get("Forward voltage")); set("If", get("Current")); break; }
      case "logic": if (gp.function) set("Function", gp.function); if (gp.schmitt) set("Schmitt", "yes"); { const fam = get("Logic family"); if (fam) set("Family", /T\b|TTL|HCT|ACT/i.test(fam) ? "ttl" : "cmos", fam); } set("Supply", get("Supply")); break;
      case "switch": break;
    }
    return p;
  }

  // ------------------------------------------------------------------ pin mapping
  // Placeholder pins carry pin.fn (and the unit); other parts map by normalised name. Returns per unit
  // {role: pin}, or null when a required role is missing.
  function mapPins(t, pins) {
    const real = p => p && !/^NC_/.test(String(p.net));
    const roleMatches = (p, role) => SYN[role]?.includes(norm(p.fn || p.name)) || norm(p.fn || p.name) === role;
    const units = t.perUnit ? [...new Set(pins.filter(p => t.perUnit.some(r => roleMatches(p, r))).map(p => p.unit || 1))].sort((a, b) => a - b) : [1];
    if (!units.length) units.push(1);
    const s = pins.slice().sort((a, b) => String(a.number).localeCompare(String(b.number), undefined, {numeric: true}));
    if (t.id === "switch") {
      const m = {};
      for (const r of ["COM", "NO", "NC"]) { const p = pins.find(q => norm(q.fn || q.name) === r); if (p) m[r] = p; }
      if (m.COM && (m.NO || m.NC)) return {units: [m], mapped: Object.values(m).filter(real).length};
      const a = pins.filter(q => q.fn === "A"), b = pins.filter(q => q.fn === "B");
      if (a.length && b.length) { const u = {T1: a.find(real) || a[0], T2: b.find(real) || b[0]}; return {units: [u], mapped: Object.values(u).filter(real).length}; }
      if (s.length === 2) return {units: [{T1: s[0], T2: s[1]}], mapped: s.filter(real).length};
      return {missing: "COM"};
    }
    if (t.twoTerminal) {
      if (s.length !== 2) return {missing: "T2"};
      return {units: [{T1: s[0], T2: s[1]}], mapped: s.filter(real).length};
    }
    const used = new Set(), out = [];
    for (const u of units) {
      const m = {};
      for (const [role] of t.roles) {
        const shared = !t.perUnit || !t.perUnit.includes(role);
        const candidates = pins.filter(q => !used.has(q) && (shared || (q.unit || 1) === u) && roleMatches(q, role));
        let p = candidates.find(q => q.fn && real(q)) || candidates.find(real) || candidates[0];
        if (!p && t.id === "opamp" && role === "V-") p = pins.find(q => norm(q.fn || q.name) === "GND");
        if (!p && t.id === "ldo" && role === "VIN") p = pins.find(q => !used.has(q) && norm(q.fn || q.name) === "IN");
        if (p) { m[role] = p; if (!shared) used.add(p); }
      }
      out.push(m);
    }
    for (const m of out) for (const [role, req] of t.roles) if (req && !m[role]) return {missing: role};
    const mappedPins = new Set(out.flatMap(m => Object.values(m)).filter(real));
    return {units: out, mapped: mappedPins.size};
  }

  // The built-in model table of export.js (kept for netlists that name these parts): rounded typical
  // values chosen for Waffle, never fitted to or checked against a datasheet. They are Generic:
  // "Generic (Waffle approximation)", and every netlist that uses one says so.
  const BUILTIN_NOTE = "Generic (Waffle approximation): rounded typical values, not the vendor's model and not checked against a datasheet";

  const api = {RUNGS, SOURCES, SOURCE_LABEL, TEMPLATES: T, BUILTIN_NOTE, hnum, supply, rec, chip, norm, SYN, template, values, rungOf, instantiate, benchCheck, suggest, fromPart, mapPins, fitJunction, cross, PLACEHOLDER};
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof globalThis === "object" && globalThis) globalThis.AtriumSpiceModels = api;
})();
