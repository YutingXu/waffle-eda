"use strict";
// AtriumIBIS: a clean-room IBIS reader (I/O Buffer Information Specification, versions 1.1 to 7.x)
// for the Signal Integrity extension. It reads the core subset a reflection and crosstalk
// simulation needs and treats every file as untrusted text:
//   [IBIS Ver] [File Name] [File Rev] [Comment Char] [Component] [Manufacturer] [Package] [Pin]
//   [Model Selector] [Model] (Model_type, Polarity, Enable, Vinl, Vinh, Vmeas, Vref, Rref, Cref,
//   C_comp) [Model Spec] [Voltage Range] [Pullup|Pulldown|POWER Clamp|GND Clamp Reference]
//   [Temperature Range] [Pullup] [Pulldown] [GND Clamp] [POWER Clamp] [Ramp]
//   [Rising Waveform] [Falling Waveform] [End].
// Everything else (package models, board descriptions, algorithmic and external models, submodels,
// [Diff Pin] and so on) is skipped with a note, block keywords up to their [End …] keyword.
//
// Safety: no eval, no regular expression that can backtrack badly, names kept in Maps (a model
// called "__proto__" is just a name), and hard limits on bytes, lines, line length, rows, models,
// components and pins. Fatal problems throw IbisError with the line number; recoverable ones
// become warnings ({line, text}).
//
// Behavioural buffer (buffer()): the standard IBIS behavioural model. The current into the pin is
//   I(V, t) = Ku(t)·Ipu(Vpu − V) + Kd(t)·Ipd(V − Vpd) + Igc(V − Vgc) + Ipc(Vpc − V)
// (pullup and POWER clamp tables are referenced to their supply, as the specification defines)
// plus C_comp·dV/dt, which the circuit solver stamps as a linear capacitor. The switching
// coefficients Ku, Kd come from two V-t waveforms per edge (a 2×2 solve at every time point), from
// one waveform (Ku + Kd = 1), or from [Ramp] (a linear ramp over the 0-100 % time dt/0.6).
//
// DOM-free and dependency-free; runs in the extension worker, JSC and Node.
(function () {
  const LIMITS = Object.freeze({bytes: 8 * 1024 * 1024, lines: 400000, lineChars: 4096, ivRows: 1000, vtRows: 4000,
    models: 4000, components: 200, pins: 20000, selectors: 2000, waveforms: 16});
  const MODEL_TYPES = ["input", "output", "i/o", "3-state", "open_drain", "i/o_open_drain", "open_sink", "i/o_open_sink",
    "open_source", "i/o_open_source", "input_ecl", "output_ecl", "i/o_ecl", "3-state_ecl", "terminator", "series", "series_switch",
    "input_diff", "output_diff", "i/o_diff", "3-state_diff", "input_ecl_diff", "output_ecl_diff", "i/o_ecl_diff", "3-state_ecl_diff"];
  const DRIVERS = new Set(["output", "i/o", "3-state", "open_drain", "i/o_open_drain", "open_sink", "i/o_open_sink", "open_source",
    "i/o_open_source", "output_ecl", "i/o_ecl", "3-state_ecl", "output_diff", "i/o_diff", "3-state_diff", "output_ecl_diff", "i/o_ecl_diff", "3-state_ecl_diff"]);
  // Keywords that open a block running to a matching [End …] keyword; skipped as a whole.
  const BLOCKS = new Map([["define package model", "end package model"], ["begin board description", "end board description"],
    ["algorithmic model", "end algorithmic model"], ["external model", "end external model"], ["external circuit", "end external circuit"],
    ["begin emi component", "end emi component"], ["begin emi model", "end emi model"], ["interconnect model set", "end interconnect model set"],
    ["begin interconnect model", "end interconnect model"], ["series switch groups", "end series switch groups"]]);
  const HEADER = new Set(["ibis ver", "file name", "file rev", "date", "source", "notes", "disclaimer", "copyright", "comment char", "redistribution",
    "redistribution text", "end redistribution text"]);
  const COMPONENT_KEYS = new Set(["manufacturer", "package", "pin", "package model", "pin mapping", "diff pin", "series pin mapping",
    "si location", "timing location", "node declarations", "circuit call", "begin emi component", "alternate package models", "end alternate package models", "repeater pin", "bus label", "die supply pads"]);
  const MODEL_KEYS = new Set(["model spec", "voltage range", "pullup reference", "pulldown reference", "power clamp reference", "gnd clamp reference",
    "external reference", "temperature range", "pullup", "pulldown", "gnd clamp", "power clamp", "ramp", "rising waveform", "falling waveform",
    "receiver thresholds", "add submodel", "driver schedule", "on die termination", "test data", "test load", "composite current", "isso pu", "isso pd",
    "initial delay", "rgnd", "rpower", "rac", "cac", "r series", "l series", "rl series", "c series", "lc series", "rc series", "series current",
    "series mosfet", "model data", "end model data", "begin emi model"]);
  const SCALE = {T: 12, G: 9, M: 6, k: 3, K: 3, m: -3, u: -6, "µ": -6, n: -9, p: -12, f: -15}; // powers of ten

  class IbisError extends Error {
    constructor(message, line) { super(line ? "Line " + line + ": " + message : message); this.name = "IbisError"; this.line = line || 0; }
  }

  // A number with an optional scale letter and unit ("1.5nH", "-3.3V", "2.2k", "NA" -> NaN).
  // Returns undefined when the text is not a number at all.
  function num(text) {
    const s = String(text ?? "").trim();
    if (/^na$/i.test(s)) return NaN;
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)([TGMkKmuµnpf]?)/.exec(s);
    if (!m) return undefined;
    // "1meg" is not IBIS, but "Meg" would otherwise read as mega-then-"eg"; keep M = mega.
    // Scale through the exponent, so "2.2n" is exactly 2.2e-9.
    const [mant, ex] = m[1].split(/e/i), v = Number(mant + "e" + ((Number(ex) || 0) + (m[2] ? SCALE[m[2]] : 0)));
    return Number.isFinite(v) ? v : undefined;
  }
  const norm = k => String(k).toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();

  // ------------------------------------------------------------------ tokenizer
  // Lines with comments removed, each {n: line number, text, key?, arg?}.
  function* lines(text) {
    let comment = "|", n = 0, start = 0;
    const len = text.length;
    while (start <= len) {
      let end = text.indexOf("\n", start);
      if (end < 0) end = len;
      n++;
      if (n > LIMITS.lines) throw new IbisError("the file has more than " + LIMITS.lines + " lines.", n);
      let raw = text.slice(start, end);
      start = end + 1;
      if (raw.endsWith("\r")) raw = raw.slice(0, -1);
      if (raw.length > LIMITS.lineChars) throw new IbisError("the line is longer than " + LIMITS.lineChars + " characters.", n);
      // [Comment Char] changes the comment character for the lines after it.
      const cc = /^\s*\[comment[ _]char\]\s*(\S)_char/i.exec(raw);
      if (cc) { if ("!\"#$%&'()*,:;<>?@\\^`{|}~".includes(cc[1])) comment = cc[1]; else throw new IbisError("[Comment Char] must be a punctuation character.", n); yield {n, key: "comment char", arg: cc[1], text: ""}; continue; }
      const at = raw.indexOf(comment);
      const line = (at >= 0 ? raw.slice(0, at) : raw).replace(/\t/g, " ");
      const k = /^\s*\[([^\]]{1,80})\]\s*(.*)$/.exec(line);
      if (k) yield {n, key: norm(k[1]), arg: k[2].trim(), text: ""};
      else if (line.trim()) yield {n, text: line.trim()};
      if (end >= len) break;
    }
  }

  // ------------------------------------------------------------------ parser
  function parse(text, opts = {}) {
    if (typeof text !== "string") throw new IbisError("expected IBIS text.");
    const max = Math.min(opts.maxBytes || LIMITS.bytes, LIMITS.bytes);
    if (text.length > max) throw new IbisError("the file is larger than " + Math.round(max / 1048576 * 10) / 10 + " MB.");
    if (text.indexOf("\u0000") >= 0) throw new IbisError("the file is binary, not IBIS text.");
    const out = {format: "ibis", name: String(opts.name || ""), version: null, fileName: null, fileRev: null, date: null,
      components: [], models: new Map(), selectors: new Map(), warnings: [], skipped: [], ended: false};
    const warn = (line, t) => { if (out.warnings.length < 200) out.warnings.push({line, text: t}); };
    let comp = null, model = null, section = null, table = null, wave = null, skipTo = null, pinCols = null, selector = null;
    const skippedSeen = new Set();
    const skipNote = (key, n) => { if (!skippedSeen.has(key)) { skippedSeen.add(key); out.skipped.push({line: n, keyword: key}); } };
    const triple = (parts, n, what) => {
      const v = parts.map(num);
      if (v[0] === undefined || Number.isNaN(v[0])) throw new IbisError(what + " needs a typ value.", n);
      for (let i = 1; i < 3; i++) if (v[i] === undefined || Number.isNaN(v[i])) v[i] = v[0];
      return {typ: v[0], min: v[1], max: v[2]};
    };
    const endTable = () => {
      if (table && model) {
        const t = table;
        if (t.v.length < 2) warn(t.line, "[" + t.title + "] in model " + model.name + " has fewer than two rows; it is ignored.");
        else {
          // Voltages must increase; sort a table written in reverse and drop exact duplicates.
          let sorted = true;
          for (let i = 1; i < t.v.length; i++) if (!(t.v[i] > t.v[i - 1])) { sorted = false; break; }
          if (!sorted) {
            const idx = t.v.map((_, i) => i).sort((a, b) => t.v[a] - t.v[b]);
            const keep = idx.filter((k, i) => i === 0 || t.v[k] > t.v[idx[i - 1]]);
            if (keep.length !== t.v.length) warn(t.line, "[" + t.title + "] in model " + model.name + " repeats a voltage; the repeated rows are dropped.");
            for (const c of ["v", "typ", "min", "max"]) t[c] = keep.map(k => t[c][k]);
          }
          model[t.slot] = {v: t.v, typ: t.typ, min: t.min, max: t.max};
        }
      }
      table = null;
    };
    const endWave = () => {
      if (wave && model) {
        if (wave.t.length < 2) warn(wave.line, "a waveform in model " + model.name + " has fewer than two points; it is ignored.");
        else {
          for (let i = 1; i < wave.t.length; i++) if (!(wave.t[i] > wave.t[i - 1])) throw new IbisError("waveform times must increase.", wave.rows[i]);
          delete wave.rows;
          const list = model[wave.slot];
          if (list.length >= LIMITS.waveforms) warn(wave.line, "model " + model.name + " has more than " + LIMITS.waveforms + " waveforms; the rest are ignored.");
          else list.push(wave);
        }
      }
      wave = null;
    };
    const closeSection = () => { endTable(); endWave(); section = null; selector = null; };
    const newModel = (name, n) => {
      if (!name) throw new IbisError("[Model] needs a name.", n);
      if (out.models.has(name.toLowerCase())) throw new IbisError("model " + name + " is defined twice.", n);
      if (out.models.size >= LIMITS.models) throw new IbisError("the file has more than " + LIMITS.models + " models.", n);
      const m = {name, line: n, type: null, polarity: "non-inverting", enable: "active-high", ccomp: null, vinl: null, vinh: null, vmeas: null, vref: null, rref: null, cref: null,
        voltageRange: null, pullupRef: null, pulldownRef: null, powerClampRef: null, gndClampRef: null, temperatureRange: null,
        pullup: null, pulldown: null, gndClamp: null, powerClamp: null, ramp: null, rising: [], falling: [], spec: {}};
      out.models.set(name.toLowerCase(), m);
      return m;
    };
    for (const L of lines(text)) {
      const n = L.n;
      if (skipTo) { if (L.key === skipTo) skipTo = null; continue; }
      if (out.ended) { if (L.key || L.text) { warn(n, "text after [End] is ignored."); } break; }
      if (L.key) {
        const key = L.key, arg = L.arg;
        endTable(); endWave();
        if (BLOCKS.has(key)) { skipNote(key, n); skipTo = BLOCKS.get(key); section = null; continue; }
        if (key === "end") { closeSection(); out.ended = true; continue; }
        if (key === "comment char") continue;
        if (key === "ibis ver") { out.version = arg; if (!/^\d+\.\d+$/.test(arg)) warn(n, "[IBIS Ver] should be a version such as 5.1."); else if (Number(arg) > 7.99) warn(n, "IBIS " + arg + " is newer than this reader (7.x); unknown keywords are skipped."); section = null; continue; }
        if (key === "file name") { out.fileName = arg; section = null; continue; }
        if (key === "file rev") { out.fileRev = arg; section = null; continue; }
        if (key === "date") { out.date = arg; section = null; continue; }
        if (HEADER.has(key)) { section = "text"; continue; }
        if (key === "component") {
          closeSection(); model = null;
          if (!arg) throw new IbisError("[Component] needs a name.", n);
          if (out.components.length >= LIMITS.components) throw new IbisError("the file has more than " + LIMITS.components + " components.", n);
          comp = {name: arg, line: n, manufacturer: "", package: {R: null, L: null, C: null}, pins: new Map(), diffPins: false};
          out.components.push(comp);
          continue;
        }
        if (key === "model selector") {
          closeSection(); comp = null; model = null;
          if (!arg) throw new IbisError("[Model Selector] needs a name.", n);
          if (out.selectors.size >= LIMITS.selectors) throw new IbisError("too many model selectors.", n);
          selector = {name: arg, line: n, models: []};
          out.selectors.set(arg.toLowerCase(), selector);
          section = "selector";
          continue;
        }
        if (key === "model") { closeSection(); comp = null; model = newModel(arg, n); section = "model"; continue; }
        if (key === "submodel") { closeSection(); comp = null; model = null; skipNote(key, n); section = "skip"; continue; }
        if (comp && COMPONENT_KEYS.has(key)) {
          section = null;
          if (key === "manufacturer") { comp.manufacturer = arg; continue; }
          if (key === "package") { section = "package"; continue; }
          if (key === "pin") { section = "pin"; pinCols = /r_pin/i.test(arg) ? arg.split(/\s+/).map(s => s.toLowerCase()) : null; continue; }
          if (key === "diff pin") { comp.diffPins = true; skipNote(key, n); section = "skip"; continue; }
          skipNote(key, n); section = "skip"; continue;
        }
        if (model && MODEL_KEYS.has(key)) {
          const slot = {"pullup": "pullup", "pulldown": "pulldown", "gnd clamp": "gndClamp", "power clamp": "powerClamp"}[key];
          if (slot) {
            if (model[slot]) warn(n, "model " + model.name + " defines [" + key + "] twice; the last one is used.");
            table = {slot, title: key, line: n, v: [], typ: [], min: [], max: []};
            section = "table"; continue;
          }
          if (key === "rising waveform" || key === "falling waveform") {
            wave = {slot: key === "rising waveform" ? "rising" : "falling", line: n, rFixture: null, vFixture: null, vFixtureMin: null, vFixtureMax: null,
              cFixture: 0, lFixture: 0, rDut: 0, lDut: 0, cDut: 0, t: [], typ: [], min: [], max: [], rows: []};
            section = "wave"; continue;
          }
          if (key === "ramp") { model.ramp = {line: n, r: null, f: null, rLoad: 50}; section = "ramp"; continue; }
          if (key === "model spec") { section = "spec"; continue; }
          const ref = {"voltage range": "voltageRange", "pullup reference": "pullupRef", "pulldown reference": "pulldownRef", "power clamp reference": "powerClampRef",
            "gnd clamp reference": "gndClampRef", "temperature range": "temperatureRange"}[key];
          if (ref) { model[ref] = triple(arg.split(/\s+/), n, "[" + key + "]"); section = null; continue; }
          skipNote(key, n); section = "skip"; continue;
        }
        // A model keyword outside a model, or a component keyword outside a component.
        if (MODEL_KEYS.has(key) || COMPONENT_KEYS.has(key)) { warn(n, "[" + key + "] is outside a " + (MODEL_KEYS.has(key) ? "[Model]" : "[Component]") + "; it is ignored."); section = "skip"; continue; }
        skipNote(key, n); section = "skip";
        continue;
      }
      // A data line.
      const t = L.text, parts = t.split(/\s+/);
      if (section === "skip" || section === "text") continue;
      if (section === "package" && comp) {
        const k = parts[0].toLowerCase();
        const slot = {r_pkg: "R", l_pkg: "L", c_pkg: "C"}[k];
        if (slot) comp.package[slot] = triple(parts.slice(1), n, parts[0]);
        else warn(n, "unknown [Package] row " + parts[0] + ".");
        continue;
      }
      if (section === "pin" && comp) {
        if (parts.length < 3) throw new IbisError("a [Pin] row needs a pin, a signal name and a model name.", n);
        if (comp.pins.size >= LIMITS.pins) throw new IbisError("component " + comp.name + " has more than " + LIMITS.pins + " pins.", n);
        const pin = {pin: parts[0], signal: parts[1], model: parts[2], line: n, R: null, L: null, C: null};
        if (parts.length >= 6 || pinCols) {
          const r = num(parts[3]), l = num(parts[4]), c = num(parts[5]);
          if (r !== undefined && !Number.isNaN(r)) pin.R = r;
          if (l !== undefined && !Number.isNaN(l)) pin.L = l;
          if (c !== undefined && !Number.isNaN(c)) pin.C = c;
        }
        if (comp.pins.has(pin.pin.toLowerCase())) warn(n, "pin " + pin.pin + " is listed twice in " + comp.name + "; the last row is used.");
        comp.pins.set(pin.pin.toLowerCase(), pin);
        continue;
      }
      if (section === "selector" && selector) {
        if (selector.models.length < 256) selector.models.push({model: parts[0], description: parts.slice(1).join(" "), line: n});
        continue;
      }
      if (section === "model" && model) { modelParam(model, t, parts, n, warn); continue; }
      if (section === "spec" && model) {
        const k = parts[0].toLowerCase();
        if (parts.length >= 2 && num(parts[1]) !== undefined) model.spec[k] = triple(parts.slice(1), n, parts[0]);
        continue;
      }
      if (section === "table" && table) {
        if (table.v.length >= LIMITS.ivRows) { if (table.v.length === LIMITS.ivRows) warn(n, "[" + table.title + "] has more than " + LIMITS.ivRows + " rows; the rest are ignored."); table.v.push(NaN); continue; }
        if (Number.isNaN(table.v[table.v.length - 1])) continue;
        const v = num(parts[0]), c = parts.slice(1).map(num);
        if (v === undefined || Number.isNaN(v) || c[0] === undefined || Number.isNaN(c[0])) throw new IbisError("an I-V row needs a voltage and a typ current, not \"" + t.slice(0, 60) + "\".", n);
        table.v.push(v); table.typ.push(c[0]);
        table.min.push(c[1] === undefined || Number.isNaN(c[1]) ? c[0] : c[1]); table.max.push(c[2] === undefined || Number.isNaN(c[2]) ? c[0] : c[2]);
        if (table.v.length === 101) warn(n, "[" + table.title + "] in model " + model.name + " has more than 100 rows (the specification's limit).");
        continue;
      }
      if (section === "wave" && wave) {
        const eq = /^(\w+)\s*=\s*(\S+)/.exec(t);
        if (eq) {
          const k = eq[1].toLowerCase(), v = num(eq[2]);
          const slot = {r_fixture: "rFixture", v_fixture: "vFixture", v_fixture_min: "vFixtureMin", v_fixture_max: "vFixtureMax", c_fixture: "cFixture",
            l_fixture: "lFixture", r_dut: "rDut", l_dut: "lDut", c_dut: "cDut"}[k];
          if (!slot) { warn(n, "unknown waveform parameter " + eq[1] + "."); continue; }
          if (v === undefined || Number.isNaN(v)) throw new IbisError(eq[1] + " needs a number.", n);
          wave[slot] = v;
          continue;
        }
        if (wave.t.length >= LIMITS.vtRows) { if (wave.t.length === LIMITS.vtRows) { warn(n, "a waveform has more than " + LIMITS.vtRows + " points; the rest are ignored."); wave.t.push(Infinity); } continue; }
        if (wave.t[wave.t.length - 1] === Infinity) continue;
        const tt = num(parts[0]), c = parts.slice(1).map(num);
        if (tt === undefined || Number.isNaN(tt) || c[0] === undefined || Number.isNaN(c[0])) throw new IbisError("a V-t row needs a time and a typ voltage, not \"" + t.slice(0, 60) + "\".", n);
        wave.t.push(tt); wave.typ.push(c[0]); wave.rows.push(n);
        wave.min.push(c[1] === undefined || Number.isNaN(c[1]) ? c[0] : c[1]); wave.max.push(c[2] === undefined || Number.isNaN(c[2]) ? c[0] : c[2]);
        continue;
      }
      if (section === "ramp" && model?.ramp) {
        const eq = /^r_load\s*=\s*(\S+)/i.exec(t);
        if (eq) { const v = num(eq[1]); if (!(v > 0)) throw new IbisError("R_load must be a positive resistance.", n); model.ramp.rLoad = v; continue; }
        const k = parts[0].toLowerCase();
        if (k === "dv/dt_r" || k === "dv/dt_f") {
          const vals = parts.slice(1, 4).map(p => {
            if (/^na$/i.test(p)) return null;
            const sl = p.indexOf("/");
            const dv = sl > 0 ? num(p.slice(0, sl)) : undefined, dt = sl > 0 ? num(p.slice(sl + 1)) : undefined;
            if (dv === undefined || dt === undefined || Number.isNaN(dv) || Number.isNaN(dt) || !(dt > 0)) throw new IbisError(parts[0] + " values are written dV/dt, e.g. 1.2/0.5n.", n);
            return {dv: Math.abs(dv), dt};
          });
          if (!vals[0]) throw new IbisError(parts[0] + " needs a typ value.", n);
          model.ramp[k === "dv/dt_r" ? "r" : "f"] = {typ: vals[0], min: vals[1] || vals[0], max: vals[2] || vals[0]};
          continue;
        }
        warn(n, "unknown [Ramp] row " + parts[0] + ".");
        continue;
      }
      if (!section) {
        if (comp || model) warn(n, "unexpected text \"" + t.slice(0, 40) + "\" is ignored.");
        continue;
      }
    }
    endTable(); endWave();
    if (skipTo) throw new IbisError("a block is not closed: [" + skipTo + "] is missing.");
    if (!out.version) warn(0, "the file has no [IBIS Ver].");
    if (!out.ended) warn(0, "the file has no [End] keyword; it may be truncated.");
    if (!out.components.length) throw new IbisError("the file has no [Component].");
    finish(out, warn);
    return out;
  }

  function modelParam(model, t, parts, n, warn) {
    const eq = /^(\w+)\s*=\s*(\S+)/.exec(t);
    const key = (eq ? eq[1] : parts[0]).toLowerCase();
    const val = eq ? eq[2] : parts[1];
    switch (key) {
      case "model_type": {
        const v = String(val || "").toLowerCase();
        if (!MODEL_TYPES.includes(v)) throw new IbisError("Model_type " + val + " is not an IBIS model type.", n);
        model.type = v; return;
      }
      case "polarity": model.polarity = String(val || "").toLowerCase(); return;
      case "enable": model.enable = String(val || "").toLowerCase(); return;
      case "vinl": case "vinh": case "vmeas": case "vref": case "rref": case "cref": {
        const v = num(val);
        if (v === undefined || Number.isNaN(v)) throw new IbisError(key + " needs a number.", n);
        model[key] = v; return;
      }
      case "c_comp": {
        const v = parts.slice(1).map(num);
        if (v[0] === undefined || Number.isNaN(v[0]) || v[0] < 0) throw new IbisError("C_comp needs a typ capacitance.", n);
        model.ccomp = {typ: v[0], min: v[1] === undefined || Number.isNaN(v[1]) ? v[0] : v[1], max: v[2] === undefined || Number.isNaN(v[2]) ? v[0] : v[2]};
        return;
      }
      default:
        if (/^c_comp_/.test(key)) {
          // IBIS 4+ split C_comp; their sum is the total die capacitance.
          const v = num(parts[1]);
          if (v > 0) model.ccompSplit = (model.ccompSplit || 0) + v;
          return;
        }
        if (/^(mode|vref_|rgnd|rpower|rac|cac|cref_|rref_|vmeas_|vinh_|vinl_|tr|tf|ttr|ttf|model_spec)/.test(key)) return;
        warn(n, "model parameter " + (eq ? eq[1] : parts[0]) + " is not read.");
    }
  }

  // Cross-checks once the whole file is read.
  function finish(out, warn) {
    for (const m of out.models.values()) {
      if (!m.type) throw new IbisError("model " + m.name + " has no Model_type.", m.line);
      if (!m.ccomp) { if (m.ccompSplit) m.ccomp = {typ: m.ccompSplit, min: m.ccompSplit, max: m.ccompSplit}; else { warn(m.line, "model " + m.name + " has no C_comp; 0 F is used."); m.ccomp = {typ: 0, min: 0, max: 0}; } }
      for (const k of ["vinl", "vinh", "vmeas", "vref", "rref", "cref"]) if (m[k] == null && m.spec[k]) m[k] = m.spec[k].typ;
      if (DRIVERS.has(m.type)) {
        const open = /open_(drain|sink)/.test(m.type), source = /open_source/.test(m.type);
        if (!m.pulldown && !source) warn(m.line, "driver model " + m.name + " has no [Pulldown] table.");
        if (!m.pullup && !open) warn(m.line, "driver model " + m.name + " has no [Pullup] table.");
        if (!m.ramp && !m.rising.length) warn(m.line, "driver model " + m.name + " has no [Ramp] or waveforms.");
      }
      if (m.vinl != null && m.vinh != null && m.vinl > m.vinh) warn(m.line, "model " + m.name + " has Vinl above Vinh.");
    }
    for (const c of out.components) for (const p of c.pins.values()) {
      const name = p.model.toLowerCase();
      if (name === "power" || name === "gnd" || name === "nc" || name === "nd") continue;
      if (!out.models.has(name) && !out.selectors.has(name)) warn(p.line, "pin " + p.pin + " of " + c.name + " uses model " + p.model + ", which is not in the file.");
    }
    for (const s of out.selectors.values()) for (const e of s.models) if (!out.models.has(e.model.toLowerCase())) warn(e.line, "model selector " + s.name + " lists " + e.model + ", which is not in the file.");
  }

  // A compact, JSON-safe summary for lists and the project index.
  function summary(ibis) {
    return {version: ibis.version, fileName: ibis.fileName, fileRev: ibis.fileRev,
      components: ibis.components.map(c => ({name: c.name, manufacturer: c.manufacturer, pins: c.pins.size})),
      models: [...ibis.models.values()].map(m => ({name: m.name, type: m.type})),
      selectors: [...ibis.selectors.values()].map(s => ({name: s.name, models: s.models.map(e => e.model)})),
      warnings: ibis.warnings.length, skipped: ibis.skipped.map(s => s.keyword)};
  }

  // ------------------------------------------------------------------ model lookup
  const component = (ibis, name) => (name ? ibis.components.find(c => c.name.toLowerCase() === String(name).toLowerCase()) : ibis.components[0]) || null;
  // The model a pin uses: {model, selector?, choices?, pkg: {R, L, C} at the corner, special?}.
  // `choice` picks a [Model Selector] entry (default: the first).
  function pinModel(ibis, compName, pin, opts = {}) {
    const c = component(ibis, compName);
    if (!c) throw Error("Component " + compName + " is not in " + (ibis.name || "the IBIS file") + ".");
    const p = c.pins.get(String(pin).toLowerCase());
    if (!p) return null;
    const corner = opts.corner || "typ";
    const pkg = {R: p.R ?? c.package.R?.[corner] ?? 0, L: p.L ?? c.package.L?.[corner] ?? 0, C: p.C ?? c.package.C?.[corner] ?? 0};
    const name = p.model.toLowerCase();
    if (["power", "gnd", "nc", "nd"].includes(name)) return {pin: p, special: name, pkg};
    const sel = ibis.selectors.get(name);
    if (sel) {
      const pick = sel.models.find(e => e.model.toLowerCase() === String(opts.choice || "").toLowerCase()) || sel.models[0];
      const m = pick && ibis.models.get(pick.model.toLowerCase());
      return {pin: p, model: m || null, selector: sel.name, choice: pick?.model || null, choices: sel.models.map(e => ({model: e.model, description: e.description})), pkg};
    }
    return {pin: p, model: ibis.models.get(name) || null, pkg};
  }

  // ------------------------------------------------------------------ behavioural buffer
  // Piecewise-linear lookup with linear extrapolation from the end segments.
  function table(v, i) {
    const n = v.length;
    const f = x => {
      let lo = 0, hi = n - 1;
      if (x <= v[0]) hi = 1; else if (x >= v[n - 1]) lo = n - 2;
      else while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (v[mid] > x) hi = mid; else lo = mid; }
      if (hi === lo) hi = lo + 1;
      const s = (i[hi] - i[lo]) / (v[hi] - v[lo]);
      return [i[lo] + s * (x - v[lo]), s];
    };
    return {v, i, f};
  }
  const ZERO = {f: () => [0, 0], v: [0, 1], i: [0, 0]};
  const at = (tr, corner) => (tr ? tr[corner] ?? tr.typ : null);
  function iv(model, slot, corner) { const t = model[slot]; return t ? table(t.v, t[corner] || t.typ) : ZERO; }

  // buffer(model, corner) -> {type, driver, vcc, refs, ccomp, ivs, thresholds, edges, warnings}
  // edges.rise / edges.fall: {t: [s], ku: [], kd: []} starting at the edge (t = 0).
  function buffer(model, corner = "typ", opts = {}) {
    if (!model) throw Error("No model.");
    const warnings = [];
    const vr = at(model.voltageRange, corner);
    const vpu = at(model.pullupRef, corner) ?? vr ?? opts.vcc ?? 3.3, vpd = at(model.pulldownRef, corner) ?? 0;
    const vpc = at(model.powerClampRef, corner) ?? vpu, vgc = at(model.gndClampRef, corner) ?? 0;
    if (vr == null && model.pullupRef == null && DRIVERS.has(model.type)) warnings.push("Model " + model.name + " has no [Voltage Range]; " + vpu + " V is used.");
    const pu = iv(model, "pullup", corner), pd = iv(model, "pulldown", corner), gc = iv(model, "gndClamp", corner), pc = iv(model, "powerClamp", corner);
    const spec = k => (model.spec[k] ? model.spec[k][corner] : null);
    const thr = {vinl: spec("vinl") ?? model.vinl, vinh: spec("vinh") ?? model.vinh, vmeas: spec("vmeas") ?? model.vmeas ?? (vpu + vpd) / 2,
      vref: model.vref, rref: model.rref, cref: model.cref};
    if (thr.vinh == null) thr.vinh = vpd + 0.7 * (vpu - vpd);
    if (thr.vinl == null) thr.vinl = vpd + 0.3 * (vpu - vpd);
    const b = {name: model.name, type: model.type, driver: DRIVERS.has(model.type), corner, vcc: vpu, vgnd: vpd, refs: {vpu, vpd, vpc, vgc},
      ccomp: at(model.ccomp, corner) || 0, pu, pd, gc, pc, thresholds: thr, inverting: /^inverting/.test(model.polarity), warnings, edges: null};
    // Static current into the pin and its derivative, for switching state (ku, kd).
    b.current = (v, ku, kd) => {
      const a = pu.f(vpu - v), c = pd.f(v - vpd), g = gc.f(v - vgc), p = pc.f(vpc - v);
      return [ku * a[0] + kd * c[0] + g[0] + p[0], -ku * a[1] + kd * c[1] + g[1] - p[1]];
    };
    if (b.driver) b.edges = {rise: edge(model, b, "rising", corner, warnings), fall: edge(model, b, "falling", corner, warnings)};
    return b;
  }
  // Switching coefficients for one edge.
  function edge(model, b, which, corner, warnings) {
    const rising = which === "rising", waves = model[which] || [];
    const vpu = b.refs.vpu, vpd = b.refs.vpd;
    const C = b.ccomp;
    const fixtureV = w => (corner === "min" ? w.vFixtureMin : corner === "max" ? w.vFixtureMax : null) ?? w.vFixture ?? 0;
    const static0 = v => { const g = b.gc.f(v - b.refs.vgc)[0], p = b.pc.f(b.refs.vpc - v)[0]; return g + p; };
    const usable = waves.filter(w => w.rFixture > 0);
    if (waves.length && !usable.length) warnings.push("Model " + model.name + " has " + which + " waveforms without R_fixture; [Ramp] is used.");
    for (const w of usable) if (w.cFixture || w.lFixture || w.rDut || w.lDut || w.cDut) { warnings.push("Model " + model.name + ": C_fixture, L_fixture and the DUT parasitics of a waveform are not modelled."); break; }
    if (usable.length) {
      const ws = usable.slice(0, 2);
      // Common time grid: the union span, 400 points (or the finest table's spacing).
      const t0 = Math.min(...ws.map(w => w.t[0])), t1 = Math.max(...ws.map(w => w.t[w.t.length - 1]));
      const N = 400, dt = (t1 - t0) / (N - 1);
      const sample = (w, t) => { const ys = w[corner] || w.typ; return table(w.t, ys).f(Math.max(w.t[0], Math.min(w.t[w.t.length - 1], t)))[0]; };
      const T = [], KU = [], KD = [];
      for (let k = 0; k < N; k++) {
        const t = t0 + k * dt;
        const rows = ws.map(w => {
          const v = sample(w, t), dv = (sample(w, t + dt / 2) - sample(w, t - dt / 2)) / dt;
          const rhs = (fixtureV(w) - v) / w.rFixture - C * dv - static0(v);
          return {a: b.pu.f(vpu - v)[0], c: b.pd.f(v - vpd)[0], rhs};
        });
        let ku, kd;
        if (rows.length === 2) {
          const [r1, r2] = rows, det = r1.a * r2.c - r2.a * r1.c;
          if (Math.abs(det) > 1e-12 * (Math.abs(r1.a * r2.c) + Math.abs(r2.a * r1.c) + 1e-30)) { ku = (r1.rhs * r2.c - r2.rhs * r1.c) / det; kd = (r1.a * r2.rhs - r2.a * r1.rhs) / det; }
        }
        if (ku === undefined) {
          const r = rows[0], d = r.a - r.c;
          ku = Math.abs(d) > 1e-15 ? (r.rhs - r.c) / d : (rising ? 1 : 0); kd = 1 - ku;
        }
        T.push(t - t0); KU.push(Math.min(1.2, Math.max(-0.2, ku))); KD.push(Math.min(1.2, Math.max(-0.2, kd)));
      }
      // The edge's own end states: rising ends with the pullup on.
      const fin = rising ? [1, 0] : [0, 1], ini = rising ? [0, 1] : [1, 0];
      // Pin the first and last samples to the clean states (measured tables are noisy at rest).
      KU[0] = ini[0]; KD[0] = ini[1]; KU[N - 1] = fin[0]; KD[N - 1] = fin[1];
      return {t: T, ku: KU, kd: KD, source: ws.length === 2 ? "two waveforms" : "one waveform"};
    }
    const r = model.ramp?.[rising ? "r" : "f"];
    let tt;
    if (r) { const x = r[corner] || r.typ; tt = x.dt / 0.6; }
    else { tt = 1e-9; warnings.push("Model " + model.name + " has no " + which + " edge data; a 1 ns ramp is assumed."); }
    const t = [0, tt];
    return rising ? {t, ku: [0, 1], kd: [1, 0], source: "ramp"} : {t, ku: [1, 0], kd: [0, 1], source: "ramp"};
  }

  // A generic buffer when no IBIS model is assigned: linear Ron to the rails, a ramp edge,
  // C_comp and ideal-ish clamp diodes. Written as an IBIS model object so one code path runs.
  function generic(o = {}) {
    const vcc = o.vcc ?? 3.3, ron = o.ron ?? 25, tr = o.rise ?? 0.5e-9, cc = o.ccomp ?? 2e-12;
    const vs = [-vcc, 0, 2 * vcc];
    const mk = f => ({v: vs, typ: vs.map(f), min: vs.map(f), max: vs.map(f)});
    // A clamp that conducts 1 A/V beyond 0.6 V of forward bias.
    const clamp = {v: [-vcc, -0.6, 0, vcc], typ: [-(vcc - 0.6), 0, 0, 0], min: [-(vcc - 0.6), 0, 0, 0], max: [-(vcc - 0.6), 0, 0, 0]};
    // POWER clamp table (Vcc − V): current flows into the pin when the pin is above Vcc.
    const pclamp = {v: clamp.v, typ: clamp.typ.map(x => -x), min: clamp.min.map(x => -x), max: clamp.max.map(x => -x)};
    const m = {name: o.name || "Generic " + vcc + " V CMOS", type: o.type || "i/o", polarity: "non-inverting", enable: "active-high", generic: true,
      ccomp: {typ: cc, min: cc, max: cc}, vinl: o.vinl ?? 0.3 * vcc, vinh: o.vinh ?? 0.7 * vcc, vmeas: vcc / 2, vref: null, rref: null, cref: null,
      voltageRange: {typ: vcc, min: vcc, max: vcc}, pullupRef: null, pulldownRef: null, powerClampRef: null, gndClampRef: null, temperatureRange: null,
      pullup: mk(v => -v / ron), pulldown: mk(v => v / ron), gndClamp: clamp, powerClamp: pclamp,
      ramp: {r: {typ: {dv: 0.6 * vcc, dt: 0.6 * tr}, min: {dv: 0.6 * vcc, dt: 0.6 * tr}, max: {dv: 0.6 * vcc, dt: 0.6 * tr}}, f: {typ: {dv: 0.6 * vcc, dt: 0.6 * tr}, min: {dv: 0.6 * vcc, dt: 0.6 * tr}, max: {dv: 0.6 * vcc, dt: 0.6 * tr}}, rLoad: 50},
      rising: [], falling: [], spec: {}};
    return m;
  }

  const api = {version: "1.0.0", LIMITS, MODEL_TYPES, DRIVERS, IbisError, num, parse, summary, component, pinModel, buffer, generic, table};
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof globalThis === "object" && globalThis) globalThis.AtriumIBIS = api;
})();
