"use strict";
// Schematic → SPICE netlist for the SPICE extension. DOM-free: it takes plain data read through the
// public extension API (the JSON netlist, part and library parameters, and the fitted state of each
// designator under the active assembly variant) and returns netlist text, notes and a coverage report.
//
// Part parameters (names are case-insensitive; spaces, dots and underscores are ignored):
//   Spice         the model text after the nodes ("10k", "1N4148", "DC 5 AC 1", "OPAMP"), or a whole
//                 line template using %ref, %value, %1..%n (pin numbers), %{name} (pin names), %nodes
//   Spice.Prefix  the SPICE element letter (R C L V I D Q M X E F G H), e.g. X for a U-designated part
//   Spice.Pins    pin numbers or names in SPICE node order, e.g. "C B E" or "3 2 1"
//   Spice.Lib     .model / .subckt text appended to the netlist (lines separated by newlines or "|")
//   Spice.Exclude true leaves the part out ("Exclude from simulation" and "Sim.Enable = 0" also work)
//   DC, AC, AC Phase, PULSE, SIN, PWL, EXP   source settings for V and I parts
//
// The model ladder (models.js, docs/design/spice-models.md §3) picks one rung per placed part, explicit
// before inferred: (1) the placed part's assignment (input.assign["part:<id>"], or part.sim), (2) its
// legacy Spice parameters, (3) the component's assignment (input.assign["def:<id>"], or def.sim),
// (4) the component's legacy Spice parameters, (5) a placeholder's family template (pin.fn gives the
// node order), (6) inference from the designator prefix as before. Assignments: {template: "opamp@1",
// params: {GBW: {v, src, page?, quote?}}, check?} | {exclude: "reason"}. Designs without assignments
// produce the same elements as before; parts that do not simulate are listed in the coverage report
// with their rung and, where Waffle can tell the category, a suggested generic template.
(function () {
  const S = typeof require === "function" ? require("./spice.js") : globalThis.AtriumSpice;
  let M = null;
  const models = () => (M = M || (typeof require === "function" ? require("./models.js") : globalThis.AtriumSpiceModels));
  const key = k => String(k).toUpperCase().replace(/[^A-Z0-9]/g, "");
  const ALIASES = {model: ["SPICE", "SPICEMODEL", "SIMMODEL", "SIMVALUE"], prefix: ["SPICEPREFIX", "SIMPREFIX", "SIMDEVICE"], pins: ["SPICEPINS", "SIMPINS", "SPICEPINMAP"],
    lib: ["SPICELIB", "SPICEMODELTEXT", "SIMLIB"], exclude: ["SPICEEXCLUDE", "EXCLUDEFROMSIMULATION", "SIMEXCLUDE"], enable: ["SIMENABLE", "SPICEENABLE"],
    dc: ["DC", "SPICEDC"], ac: ["AC", "ACMAGNITUDE", "SPICEAC"], acPhase: ["ACPHASE"], pulse: ["PULSE"], sin: ["SIN", "SINE"], pwl: ["PWL"], exp: ["EXP"]};
  const truthy = v => /^(1|y|yes|true|t|on|x)$/i.test(String(v ?? "").trim());
  const falsy = v => /^(0|n|no|false|f|off)$/i.test(String(v ?? "").trim());
  function lookup(params) { const m = new Map(); for (const [k, v] of Object.entries(params || {})) if (v != null && typeof v !== "object") m.set(key(k), String(v)); return f => { for (const a of ALIASES[f]) if (m.has(a)) return m.get(a); return null; }; }
  const hasModelParams = get => ["model", "prefix", "pins", "lib"].some(f => (get(f) ?? "").trim() !== "");

  // Generic (Waffle approximation): rounded typical values chosen for this project. They are NOT the
  // vendors' models and were not fitted to or checked against a datasheet; the netlist and the coverage
  // report say so wherever one is used. Kept under these names so that existing designs still simulate.
  const MODELS = {
    D: "D(IS=1e-14)", "1N4148": "D(IS=2.7n N=1.8 RS=0.6 CJO=2p BV=100 IBV=1u)", "1N914": "D(IS=2.7n N=1.8 RS=0.6 CJO=2p BV=100 IBV=1u)",
    "1N4001": "D(IS=15n N=1.95 RS=0.03 CJO=25p BV=60 IBV=5u)", "1N4007": "D(IS=15n N=1.95 RS=0.03 CJO=15p BV=1000 IBV=5u)",
    "1N5819": "D(IS=10u N=1.05 RS=0.04 CJO=100p BV=40 IBV=1m)", "BAT54": "D(IS=0.1u N=1.0 RS=2 CJO=10p BV=30 IBV=1u)",
    LED: "D(IS=1e-19 N=1.9 RS=2)", "BZX84C5V1": "D(IS=1e-14 RS=1 BV=5.1 IBV=5m)", "ZENER": "D(IS=1e-14 RS=1 BV=5.1 IBV=5m)",
    NPN: "NPN(IS=1e-14 BF=100)", PNP: "PNP(IS=1e-14 BF=100)",
    "2N3904": "NPN(IS=6f BF=200 BR=4 VAF=100)", "2N2222": "NPN(IS=15f BF=200 BR=6 VAF=100)", "BC547": "NPN(IS=7f BF=300 BR=5 VAF=60)", "MMBT3904": "NPN(IS=6f BF=200 BR=4 VAF=100)",
    "2N3906": "PNP(IS=2f BF=180 BR=4 VAF=40)", "BC557": "PNP(IS=7f BF=250 BR=5 VAF=45)", "MMBT3906": "PNP(IS=2f BF=180 BR=4 VAF=40)",
    NMOS: "NMOS(VTO=1 KP=0.1)", PMOS: "PMOS(VTO=-1 KP=0.05)", "2N7000": "NMOS(VTO=2 KP=0.2 LAMBDA=0.01)", "BSS138": "NMOS(VTO=1.3 KP=0.3 LAMBDA=0.01)",
    "BSS84": "PMOS(VTO=-1.6 KP=0.1 LAMBDA=0.01)"
  };
  // Every built-in value's provenance: a Waffle default (unconfirmed against any datasheet).
  const MODEL_INFO = Object.fromEntries(Object.keys(MODELS).map(k => [k, {rung: "Generic", label: "Generic (Waffle approximation)", src: "default",
    note: /^(D|LED|ZENER|NPN|PNP|NMOS|PMOS)$/.test(k) ? "generic device model with Waffle default values" : "rounded typical values under the part number; not the vendor's model and not checked against its datasheet"}]));
  // A single-pole op-amp: 100 dB open-loop gain, 1 MHz gain-bandwidth, 10 Ω output (a Waffle default).
  const SUBCKTS = {OPAMP: {ports: ["inp", "inn", "out"], text: ".subckt OPAMP inp inn out\nRin inp inn 10meg\nG1 0 p inp inn 1\nR1 p 0 100k\nC1 p 0 159.155n\nE1 o 0 p 0 1\nRo o out 10\n.ends OPAMP"}};
  const ROLE_NAMES = {
    V: [["+", "P", "POS", "PLUS", "1"], ["-", "N", "NEG", "MINUS", "2"]], I: [["+", "P", "POS", "1"], ["-", "N", "NEG", "2"]],
    D: [["A", "ANODE", "+"], ["K", "C", "CATHODE", "-"]], Q: [["C", "COLLECTOR"], ["B", "BASE"], ["E", "EMITTER"]],
    M: [["D", "DRAIN"], ["G", "GATE"], ["S", "SOURCE"], ["B", "BULK", "SUB", "SUBSTRATE"]],
    OPAMP: [["IN+", "+IN", "INP", "NONINV", "NON-INV", "+", "V+IN"], ["IN-", "-IN", "INN", "INV", "-", "V-IN"], ["OUT", "OUTPUT", "VOUT", "O"]]
  };
  const GROUND = /^(0|gnd|agnd|dgnd|pgnd|sgnd|ground|earth)$/i;
  const NON_SIM = /^(J|P|CN|CON|TP|MH|H|FID|LOGO|SW|S|K|Y|XTAL|F|FB|RV|VR|POT|T|TR|BZ|LS|MK|E|G|ANT|NT|JP)$/;
  // Parts with nothing to simulate: Excluded (with the reason), not Missing.
  const NOTHING = {J: "connector", P: "connector", CN: "connector", CON: "connector", TP: "test point", MH: "mounting hole", H: "mounting hole", FID: "fiducial", LOGO: "logo", JP: "jumper", NT: "net tie", ANT: "antenna"};

  // "4k7" → 4.7k, "10 kΩ" → 10k, "100nF" → 100n, "1M" (resistor) → 1meg.
  function cleanValue(v, letter) {
    let s = String(v ?? "").trim().split(/[\s/,;]+(?=\d+%|±)/)[0].replace(/\s+/g, "").replace(/[Ωω]|ohms?$/gi, "").replace(/[µμ]/g, "u");
    s = s.replace(/^(\d+)([kKmMuUnNpPgGrR])(\d+)/, (x, a, u, b) => a + "." + b + (/[rR]/.test(u) ? "" : u));
    if (letter === "C") s = s.replace(/F$/, "");
    if (letter === "L") s = s.replace(/[Hh]$/, "");
    s = s.replace(/^([\d.]+(?:e[+-]?\d+)?)M(?![A-Za-z])/, "$1meg");
    return Number.isFinite(S.num(s)) ? s : null;
  }
  const safeName = t => String(t).replace(/[^A-Za-z0-9_.+\-]/g, "_");
  // A part placed as several units (a dual op-amp) arrives as one netlist component per unit, each
  // listing every pin; merge them by designator, keeping the connected net of each pin.
  function mergeUnits(list) {
    const out = [], by = new Map();
    for (const c of list) {
      const k = String(c.ref || "").toUpperCase(), first = by.get(k);
      if (!first || !k) { const copy = {...c, pins: (c.pins || []).map(p => ({...p}))}; out.push(copy); if (k) by.set(k, copy); continue; }
      for (const p of c.pins || []) {
        const q = first.pins.find(x => String(x.number) === String(p.number));
        if (!q) first.pins.push({...p});
        else if (/^NC_/.test(String(q.net)) && !/^NC_/.test(String(p.net))) q.net = p.net;
      }
    }
    return out;
  }
  const normAssign = a => {
    if (!a || typeof a !== "object") return null;
    if (typeof a.exclude === "string") return {exclude: a.exclude.slice(0, 200) || "excluded"};
    if (a.model && typeof a.model === "object") { // docs/design/spice-models.md §16 shape
      if (a.model.kind === "none") return {exclude: String(a.model.reason || "excluded").slice(0, 200)};
      if (a.model.kind === "template" && a.model.id) return {template: String(a.model.id), params: a.params || {}, check: a.check || null};
      return null;
    }
    if (typeof a.template === "string") return {template: a.template, params: a.params || {}, check: a.check || null};
    return null;
  };

  // input: {title, netlist: AtriumAPI JSON netlist, parts: [{id, ref, value, def, parameters, dnp, sim?}],
  //   defs: [{id, name, parameters, generic?, sim?, pins?: [{number, fn, unit}]}], fitted: {REF: false} (variant), variant,
  //   overrides: {REF: {param: text}}, assign: {"part:<id>" | "def:<id>": assignment}}
  function exportNetlist(input) {
    const warnings = [], omitted = [], elements = [], used = new Set(), libText = [], nodeMap = Object.create(null), taken = new Map(), occupied = new Set(["0"]), coverage = [], tplModels = new Map();
    const partsById = new Map((input.parts || []).map(p => [p.id, p])), partsByRef = new Map((input.parts || []).map(p => [String(p.ref).toUpperCase(), p]));
    const defs = new Map((input.defs || []).map(d => [d.id, d])), assign = input.assign || {};
    const node = net => {
      if (GROUND.test(String(net))) return "0";
      if (taken.has(net)) return taken.get(net);
      let s = safeName(net) || "N", k = s, i = 2;
      while (occupied.has(k.toLowerCase())) k = s + "_" + i++;
      occupied.add(k.toLowerCase()); taken.set(net, k); nodeMap[k] = net; return k;
    };
    const userModels = new Set(), userSubckts = new Map();
    const comps = mergeUnits(input.netlist?.components || []);
    // Collect Spice.Lib text first so parts can name models it defines.
    const info = comps.map(c => {
      const part = partsById.get(c.id) || partsByRef.get(String(c.ref).toUpperCase()) || {}, def = defs.get(part.def) || {};
      const own = {...(part.parameters || {}), ...((input.overrides || {})[String(c.ref).toUpperCase()] || {})};
      const params = {...(def.parameters || {}), ...own};
      const get = lookup(params), lib = get("lib");
      if (lib) for (const block of [lib.replace(/\|/g, "\n")]) if (!libText.includes(block)) {
        libText.push(block);
        for (const m of block.matchAll(/^[ \t]*\.model[ \t]+(\S+)/gim)) userModels.add(m[1].toUpperCase());
        for (const m of block.matchAll(/^[ \t]*\.subckt[ \t]+(\S+)((?:[ \t]+[^\s=]+(?=[ \t]|$))*)/gim)) userSubckts.set(m[1].toUpperCase(), m[2].trim().split(/\s+/));
      }
      return {c, part, def, get, params, own: lookup(own), base: lookup(def.parameters || {})};
    });
    const knownModel = m => userModels.has(String(m).toUpperCase()) || Object.prototype.hasOwnProperty.call(MODELS, String(m).toUpperCase());
    const modelType = m => (userModels.has(String(m).toUpperCase()) ? null : (MODELS[String(m).toUpperCase()] || "").replace(/\(.*$/, ""));
    for (const {c, part, def, get, params, own, base} of info) {
      const ref = String(c.ref || "?"), alpha = (ref.match(/^[A-Za-z]+/)?.[0] || "").toUpperCase(), value = String(c.value ?? part.value ?? "");
      const fnOf = new Map((def.pins || []).filter(p => p && p.fn).map(p => [String(p.number), p]));
      const pins = (c.pins || []).map(p => { const f = fnOf.get(String(p.number)); return f && !p.fn ? {...p, fn: String(f.fn), unit: f.unit || 0} : p; });
      if (!pins.length) continue; // power ports and graphics
      const entry = {ref, value, part: part.id || c.id, def: part.def || null, pins: "0/" + pins.length};
      const finish = (rung, o) => { coverage.push({...entry, rung, ...o}); };
      const skip = (reason, rung = "Missing", o = {}) => {
        omitted.push({ref, reason, rung});
        finish(rung, {model: "—", reason, ...o, ...(rung === "Missing" ? {suggest: o.suggest !== undefined ? o.suggest : models().suggest(c, def, alpha)} : {})});
      };
      if (input.fitted && input.fitted[ref.toUpperCase()] === false) { skip("not fitted" + (input.variant ? " in " + input.variant : ""), "Excluded"); continue; }
      const partAssign = normAssign(assign["part:" + entry.part]) || normAssign(part.sim);
      const defAssign = normAssign(assign["def:" + entry.def]) || normAssign(def.sim);
      if (partAssign) { if (partAssign.exclude) skip(partAssign.exclude, "Excluded", {source: "assigned"}); else template(partAssign, "assigned"); continue; }
      if (truthy(get("exclude")) || falsy(get("enable"))) { skip("excluded from simulation", "Excluded"); continue; }
      if (!hasModelParams(own) && defAssign) { if (defAssign.exclude) skip(defAssign.exclude, "Excluded", {source: "component"}); else template(defAssign, "component"); continue; }
      const ph = def.generic && def.generic.role === "placeholder" ? models().PLACEHOLDER[def.generic.family] : null;
      if (ph && !hasModelParams(get)) { template({template: ph, params: models().fromPart(ph, c, def, params)}, "placeholder"); continue; }
      legacy();

      // A generic template instance (one per unit of a multi-unit part).
      function template(a, source) {
        const Mo = models(), found = Mo.template(a.template);
        if (found.error) { skip(found.error, "Missing", {source}); return; }
        const t = found.t, map = Mo.mapPins(t, pins);
        if (!map || map.missing) { skip("cannot tell which pin is " + (map?.missing || "which") + " for the " + t.id + " template (map the pins in the model wizard)", "Missing", {source, suggest: t.id}); return; }
        const real = p => p && !/^NC_/.test(String(p.net)), u0 = map.units[0];
        const have = new Set(t.roles.map(r => r[0]).filter(r => u0[r] && (r === "OE#" ? real(u0[r]) : (t.perUnit && t.perUnit.includes(r)) || t.roles.find(x => x[0] === r)[1] ? true : real(u0[r]))));
        const inst = Mo.instantiate(t, a.params, have);
        if (inst.error) { skip(inst.error + " (" + t.id + ")", "Missing", {source, suggest: t.id}); return; }
        const rung = Mo.rungOf(t, inst.recs, {placeholder: source === "placeholder", check: a.check});
        const letter = inst.letter, many = map.units.length > 1;
        map.units.forEach((u, i) => {
          const nodes = inst.ports.map(r => node(u[r].net)), name = (ref.toUpperCase().startsWith(letter) && !many ? "" : letter) + safeName(ref) + (many ? "_" + String.fromCharCode(65 + i) : "");
          elements.push({ref, line: name + " " + nodes.join(" ") + " " + inst.name, rung, template: t.id + "@" + t.v});
        });
        tplModels.set(inst.name, inst.model);
        const label = t.id + "@" + t.v, d = inst.defaults.length;
        finish(rung, {model: label + (rung === "Generic" && d ? ", " + d + " default" + (d === 1 ? "" : "s") : ""), template: label, defaults: d, defaultFields: inst.defaults, source, units: map.units.length,
          pins: map.mapped + "/" + pins.length, notes: inst.notes, notModelled: t.notModelled, ...(source === "placeholder" ? {placeholder: def.generic.family} : {})});
      }

      // The netlist as before (parameters, then the designator prefix).
      function legacy() {
        const model = get("model"), explicit = (get("prefix") || "").trim().toUpperCase()[0] || "";
        let letter = explicit;
        if (!letter) letter = alpha === "LED" ? "D" : /^(U|IC|A|OA)$/.test(alpha) ? "X" : /^(B|BT|BAT)$/.test(alpha) ? "V" : /^(ZD|DZ)$/.test(alpha) ? "D" : alpha.length === 1 ? alpha : "";
        if (!model && !explicit && (NON_SIM.test(alpha) || !"RCLVIDQMX".includes(letter || "?"))) {
          if (NOTHING[alpha] && !models().suggest(c, def, alpha)) { skip(NOTHING[alpha] + ": nothing to simulate", "Excluded"); return; }
          skip(letter && "EFGH".includes(letter) ? "a controlled source needs a Spice parameter" : "no simulation model (add a Spice parameter or use a generic model)"); return;
        }
        if (!"RCLVIDQMXEFGH".includes(letter)) { skip("unknown SPICE prefix " + letter); return; }
        const name = (ref.toUpperCase().startsWith(letter) ? "" : letter) + safeName(ref);
        // Pin order.
        const normal = s => String(s || "").toUpperCase().replace(/[−–]/g, "-").replace(/\s+/g, "");
        const byRole = words => words.map(w => pins.find(p => p.fn && normal(p.fn) === w)).find(Boolean) ||
          words.map(w => pins.find(p => normal(p.name) === w)).find(Boolean);
        const byNumber = w => pins.find(p => String(p.number).toUpperCase() === w);
        const byWord = w => byNumber(w) || byRole([normal(w)]);
        const byName = w => byRole([normal(w)]) || byNumber(w);
        let order = null;
        const pinSpec = get("pins");
        if (pinSpec) {
          order = pinSpec.trim().split(/[\s,]+/).map(w => byWord(w.toUpperCase()));
          if (order.some(p => !p)) { warnings.push(ref + ": Spice.Pins \"" + pinSpec + "\" names a pin the part does not have."); order = null; }
        }

        let text = model ? model.trim() : "";
        if (text.includes("%")) {
          const nodes = (order || pins).map(p => node(p.net));
          const line = text.replace(/%\{([^}]+)\}/g, (x, w) => { const p = byName(w.toUpperCase()); if (!p) throw Error(ref + ": the Spice template names pin " + w + " which the part does not have."); return node(p.net); })
            .replace(/%ref\b/gi, name).replace(/%value\b/gi, value).replace(/%nodes\b/gi, nodes.join(" "))
            .replace(/%(\d+)/g, (x, d) => { const p = byWord(d); if (!p) throw Error(ref + ": the Spice template names pin " + d + " which the part does not have."); return node(p.net); });
          elements.push({ref, line}); noteUse(line.split(/\s+/).slice(1));
          finish("Vendor", {model: "Spice line template (user)", pins: pins.length + "/" + pins.length, source: "parameters"});
          return;
        }
        const roles = (k, need) => {
          if (order) return order;
          const r = ROLE_NAMES[k]; if (!r) return pins.slice(0, need || pins.length);
          const found = r.map(alts => byRole(alts) || alts.map(byNumber).find(Boolean));
          if (found.slice(0, need).every(Boolean)) return found.filter(Boolean);
          return null;
        };
        let nodes, tail, rung = "Primitive", label = null;
        if ("RCL".includes(letter)) {
          if (pins.length !== 2 && !order) { skip("a " + letter + " needs 2 pins (has " + pins.length + ")"); return; }
          const v = cleanValue(text || value, letter);
          if (!v) { skip("value \"" + (text || value) + "\" is not a number"); return; }
          nodes = (order || pins).slice(0, 2); tail = v; label = {R: "resistor ", C: "capacitor ", L: "inductor "}[letter] + v;
        } else if (letter === "V" || letter === "I") {
          nodes = roles(letter, 2) || pins.slice(0, 2);
          tail = text || sourceText(get, value);
          if (!tail) { skip("no source value (set DC, AC, PULSE, SIN or PWL)"); return; }
          label = (letter === "V" ? "voltage" : "current") + " source";
        } else if (letter === "D") {
          nodes = roles("D", 2) || (pins.length === 2 ? pins : null);
          tail = pickModel(text || value, alpha === "LED" ? "LED" : "D", ["D"], ref);
        } else if (letter === "Q") {
          nodes = roles("Q", 3) || (pins.length === 3 ? pins : null);
          const pnp = /pnp/i.test(def.name + " " + value + " " + text);
          tail = pickModel(text || value, pnp ? "PNP" : "NPN", ["NPN", "PNP"], ref);
        } else if (letter === "M") {
          nodes = roles("M", 3);
          if (nodes && nodes.length === 3) nodes = [...nodes, nodes[2]];
          const p = /p-?ch|pmos|p-?channel/i.test(def.name + " " + value + " " + text);
          tail = pickModel(text || value, p ? "PMOS" : "NMOS", ["NMOS", "PMOS"], ref);
        } else if (letter === "X") {
          const sub = (text || value).trim().split(/\s+/)[0], up = sub.toUpperCase();
          const ports = userSubckts.get(up) || SUBCKTS[up]?.ports;
          if (!ports) { skip("no .subckt " + (sub || "(empty)") + (text ? " (add Spice.Lib text)" : " (add a Spice parameter or use a generic model)")); return; }
          // A symbol pin number identifies its physical terminal, even across differently named records.
          if (order && userSubckts.has(up)) {
            const seen = new Set();
            for (const p of order) {
              const terminal = p.number == null ? p : String(p.number);
              if (seen.has(terminal)) { skip("Spice.Pins repeats pin " + p.number + ". Use a different symbol pin for each model port."); return; }
              seen.add(terminal);
            }
          }
          const mapped = ports.map(port => byName(normal(port)));
          nodes = order || (up === "OPAMP" && !userSubckts.has(up) ? roles("OPAMP", 3) : null) ||
            (mapped.every(Boolean) && new Set(mapped).size === ports.length ? mapped : null) || (pins.length === ports.length ? pins : null);
          if (nodes && nodes.length !== ports.length) nodes = null;
          if (!userSubckts.has(up)) used.add("SUB:" + up);
          tail = (text || sub);
          [rung, label] = userSubckts.has(up) ? ["Vendor", "subcircuit " + sub + " (user model text)"] : ["Generic", "OPAMP (Generic, Waffle approximation: 100 dB, 1 MHz, no rails)"];
        } else { // E F G H with a non-template Spice parameter: pins in number order
          nodes = order || pins; tail = text; label = "controlled source";
        }
        if (!nodes || nodes.some(p => !p)) { skip("cannot tell which pin is which (name the pins or set Spice.Pins)"); return; }
        if ("DQM".includes(letter)) {
          const m = tail.split(/\s+/)[0].toUpperCase();
          if (userModels.has(m)) [rung, label] = ["Vendor", m + " (user model text)"];
          else [rung, label] = ["Generic", m + " (" + MODEL_INFO[m].label + ")"];
        }
        const line = name + " " + nodes.map(p => node(p.net)).join(" ") + " " + tail;
        elements.push({ref, line, rung});
        finish(rung, {model: label || tail, pins: nodes.length + "/" + pins.length, source: hasModelParams(own) ? "part parameters" : hasModelParams(base) ? "component parameters" : "designator " + alpha});
      }
    }
    function noteUse(tokens) { for (const t of tokens) { const u = String(t).toUpperCase(); if (MODELS[u] && !userModels.has(u)) used.add("MOD:" + u); if (SUBCKTS[u] && !userSubckts.has(u)) used.add("SUB:" + u); } }
    function pickModel(text, fallback, types, ref) {
      const first = String(text || "").trim().split(/\s+/)[0] || "";
      const rest = String(text || "").trim().split(/\s+/).slice(1).join(" ");
      if (first && knownModel(first)) {
        const t = modelType(first);
        if (t && !types.includes(t)) warnings.push(ref + ": model " + first + " is a " + t + "; using it anyway.");
        if (!userModels.has(first.toUpperCase())) used.add("MOD:" + first.toUpperCase());
        return first + (rest ? " " + rest : "");
      }
      if (first && !/^\d/.test(first)) warnings.push(ref + ": no model " + first + "; using the generic " + fallback + " model.");
      used.add("MOD:" + fallback);
      return fallback + (rest ? " " + rest : "");
    }
    function sourceText(get, value) {
      const parts = [];
      const dc = get("dc"), ac = get("ac"), ph = get("acPhase");
      if (dc != null && dc !== "") parts.push("DC " + (cleanValue(dc) || dc));
      else if (cleanValue(value.replace(/V$|A$/i, ""))) parts.push("DC " + cleanValue(value.replace(/V$|A$/i, "")));
      if (ac != null && ac !== "") parts.push("AC " + (cleanValue(ac) || ac) + (ph ? " " + ph : ""));
      for (const w of ["pulse", "sin", "pwl", "exp"]) { const v = get(w); if (v != null && v !== "") parts.push(w.toUpperCase() + "(" + v.replace(/^\s*\(|\)\s*$/g, "") + ")"); }
      if (!parts.length && /^(DC|AC|PULSE|SIN|PWL|EXP)\b/i.test(value.trim())) parts.push(value.trim());
      return parts.join(" ");
    }
    const lines = ["* " + (input.title || "Waffle design") + " (Waffle SPICE netlist)", "* Assembly variant: " + (input.variant || "base design")];
    const cov = summarise(coverage, input.variant);
    lines.push("* Coverage: " + cov.simulated + " of " + cov.total + " parts simulate · " + models().RUNGS.filter(r => cov.counts[r]).map(r => r + " " + cov.counts[r]).join(" · "));
    for (const e of elements) {
      const ce = e.template && coverage.find(x => x.ref === e.ref);
      if (ce && !elements.some(x => x !== e && x.ref === e.ref && elements.indexOf(x) < elements.indexOf(e))) lines.push("* " + e.ref + ": " + ce.rung + " " + ce.template + (ce.defaults ? " (" + ce.defaults + " Waffle default" + (ce.defaults === 1 ? "" : "s") + ": " + ce.defaultFields.join(", ") + ")" : "") + (ce.source === "placeholder" ? ", from placeholder" : ""));
      lines.push(e.line);
    }
    for (const o of omitted) lines.push("* " + o.ref + " omitted (" + o.rung + "): " + o.reason);
    const mods = [...used].filter(u => u.startsWith("MOD:")).map(u => u.slice(4)).sort();
    const subs = [...used].filter(u => u.startsWith("SUB:")).map(u => u.slice(4)).sort();
    if (mods.length || subs.length) lines.push("* " + models().BUILTIN_NOTE);
    for (const m of mods) lines.push(".model " + m + " " + MODELS[m]);
    for (const s of subs) lines.push(SUBCKTS[s].text);
    for (const t of tplModels.values()) lines.push(t);
    for (const t of libText) lines.push(t);
    if (input.analysis) lines.push(analysisCard(input.analysis));
    if (input.probes?.length) lines.push(".probe " + input.probes.map(p => "v(" + node(p) + ")").join(" "));
    lines.push(".end");
    if (!elements.length) warnings.push("No part has a simulation model yet.");
    return {text: lines.join("\n") + "\n", elements, omitted, warnings, nodeMap, nodeOf: net => node(net), coverage: cov};
  }
  // Coverage report: one row per placed part with pins, counts per rung (docs/design/spice-models.md §12).
  function summarise(rows, variant) {
    const counts = {};
    for (const r of rows) counts[r.rung] = (counts[r.rung] || 0) + 1;
    const simulated = rows.filter(r => r.rung !== "Excluded" && r.rung !== "Missing").length;
    const defaults = rows.reduce((s, r) => s + (r.rung === "Generic" ? r.defaults || 0 : 0), 0);
    return {variant: variant || null, total: rows.length, simulated, counts, defaults, rows};
  }
  function analysisCard(a) {
    if (a.type === "op") return ".op";
    if (a.type === "dc") return [".dc", a.source, a.start, a.stop, a.step].join(" ");
    if (a.type === "ac") return [".ac", a.sweep || "dec", a.points, a.fstart, a.fstop].join(" ");
    if (a.type === "tran") return [".tran", a.tstep, a.tstop, ...(a.tstart || a.tmax ? [a.tstart || 0] : []), ...(a.tmax ? [a.tmax] : [])].join(" ") + (a.uic ? " uic" : "");
    throw Error("Unknown analysis " + a.type + ".");
  }
  const SIM_KEYS = new Set(Object.values(ALIASES).flat());
  const isSimParam = k => SIM_KEYS.has(key(k));
  const api = {exportNetlist, analysisCard, cleanValue, isSimParam, mergeUnits, MODELS, MODEL_INFO, SUBCKTS, GROUND};
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (typeof globalThis === "object" && globalThis) globalThis.AtriumSpiceExport = api;
})();
