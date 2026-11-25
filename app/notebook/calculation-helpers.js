"use strict";
// Pure catalogue for the notebook evaluator. The parser, physical units, formatter and
// uncertainty sources belong to the evaluator. Only the worker/read-only calculation path loads this.
globalThis.AtriumCalculationHelpers = (() => {
  const specs = new Map();
  function define(name, args, result, domain, tolerance, call) {
    const optional = args.findIndex(s => s.startsWith("?"));
    const minArgs = optional < 0 ? args.length : optional;
    specs.set(name.toLowerCase(), {name, args, minArgs, maxArgs: args.length, result, domain, tolerance, call});
  }
  const seriesNames = /^(?:E3|E6|E12|E24|E48|E96|E192)$/i;
  const source = {
    series: "IEC 60063:2015",
    bands: "IEC 60062:2016 + AMD1:2019, Table 1",
    wire: "NBS Handbook 100, American Wire Gage"
  };
  function fail(api, message) { throw api.error("helper-domain", message); }
  function arity(api, args, min, max, usage) {
    if (args.length < min || args.length > max) fail(api, usage);
  }
  function range(q) { return q.worst || {min: q.value, max: q.value}; }
  function typed(api, q, unit, label) {
    if (!q || typeof q !== "object" || !Number.isFinite(q.value)) fail(api, label + " needs a finite quantity.");
    try { return api.as(q, unit); }
    catch (_) { fail(api, label + " requires " + (unit || "a dimensionless value") + "."); }
  }
  function is(api, q, unit) { try { return Number.isFinite(api.as(q, unit)); } catch (_) { return false; } }
  function positive(api, q, label) {
    if (!(range(q).min > 0)) fail(api, label + " must remain above zero throughout its range.");
  }
  function exact(api, q, label) {
    if (range(q).min !== range(q).max) fail(api, label + " must be an exact marked value.");
  }
  function signedPercent(api, fraction) {
    return (fraction > 0 ? "+" : "") + api.format(api.quantity(fraction * 100, "%"));
  }
  function annotated(q, metadata) { return {...q, metadata: {...q.metadata, ...metadata}}; }

  function makeRecord(api, display, fields, inputs, metadata) {
    // Record projection must retain the same tolerance labels as the whole answer.
    const labels = {};
    for (const key of ["unknown", "defaults", "warnings"]) {
      const values = [...new Set(inputs.flatMap(q => q?.[key] || []))];
      if (values.length) labels[key] = values;
    }
    const inherited = {};
    for (const [name, field] of Object.entries(fields)) inherited[name] = {...field, ...labels};
    const record = {...api.record(display, inherited), ...labels};
    const rssReason = Object.values(fields).find(f => f.rssReason)?.rssReason;
    if (rssReason) record.rssReason = rssReason;
    return annotated(record, metadata);
  }

  // These functions are monotone in each input across its checked domain. Evaluating the
  // endpoints encloses their complete range, including a divider with a signed supply.
  // The engine applies outward rounding and combines derivatives by input identity.
  function smooth(api, args, unit, evalAt, partials, metadata) {
    const xs = args.map(q => q.value), value = evalAt(...xs);
    if (!Number.isFinite(value)) fail(api, "The result is outside the finite number range.");
    let bounds;
    if (args.some(q => range(q).min !== range(q).max)) {
      const ends = [[]];
      for (const q of args) {
        const {min, max} = range(q);
        for (const row of ends.splice(0)) {
          ends.push([...row, min]);
          if (min !== max) ends.push([...row, max]);
        }
      }
      const ys = ends.map(row => evalAt(...row));
      if (!ys.every(Number.isFinite)) fail(api, "The input range gives an unbounded result.");
      bounds = {min: Math.min(...ys), max: Math.max(...ys)};
    }
    const q = api.lift(args, {value, unit, partials: partials(value, ...xs), bounds});
    if (bounds) {
      const sources = args.flatMap(x => Object.keys(x.contributions || {}).filter(k => x.contributions[k] !== 0));
      if (new Set(sources).size < sources.length)
        q.warnings = [...new Set([...q.warnings, "Worst-case bounds may be conservative for shared inputs."])];
    }
    return metadata ? annotated(q, metadata) : q;
  }

  define("nearest", ["quantity", "series"], "same quantity", "positive; E3, E6, E12, E24, E48, E96, E192",
    "monotone steps; RSS unavailable across a step", (args, api) => {
      arity(api, args, 2, 2, "Use value in E24 or nearest E24 value.");
      const [q, series] = args;
      if (!q || !Number.isFinite(q.value) || typeof series !== "string" || !seriesNames.test(series))
        fail(api, "Choose a positive value and a preferred series from E3 through E192.");
      if (q.tag && q.tag !== "delta" && q.tag !== "angle") fail(api, "A preferred-value search needs a linear quantity.");
      positive(api, q, "Preferred value");
      const name = series.toUpperCase(), target = q.preferred || q.inputUnit || "";
      const at = value => {
        const inTarget = target ? api.as({...q, value}, target) : value;
        let selected;
        try { selected = globalThis.AtriumPreferredValues.nearest(inTarget, name); }
        catch (e) { fail(api, e.message); }
        return {value: target ? api.quantity(selected.value, target).value : selected.value, error: selected.error};
      };
      const snapped = at(q.value), span = range(q);
      const min = span.min === q.value ? snapped.value : at(span.min).value;
      const max = span.max === q.value ? snapped.value : at(span.max).value;
      const selected = api.lift([q], {value: snapped.value, like: q, partials: [0],
        bounds: {min, max}, exactBounds: true, rssReason: min === max ? undefined : "The input range crosses a preferred-value step."});
      return annotated(selected, {series: name, targetUnit: target, signedRelativeError: snapped.error, signedErrorText: signedPercent(api, snapped.error), source: source.series});
    });

  // IEC 60062 colour roles. Percentages below are percentage points; temperature coefficients
  // are magnitudes in ppm/K. Swatches are illustrative: the adjacent names identify each band.
  const colourRows = [
    ["black", "#171717", 0, 0, null, 250], ["brown", "#824d34", 1, 1, 1, 100],
    ["red", "#d73931", 2, 2, 2, 50], ["orange", "#ee902b", 3, 3, 0.05, 15],
    ["yellow", "#efcf3c", 4, 4, 0.02, 25], ["green", "#31834b", 5, 5, 0.5, 20],
    ["blue", "#376eb8", 6, 6, 0.25, 10], ["violet", "#845096", 7, 7, 0.1, 5],
    ["grey", "#777b80", 8, 8, 0.01, 1], ["white", "#ffffff", 9, 9, null, null],
    ["gold", "#bc9644", null, -1, 5, null], ["silver", "#b9bcc0", null, -2, 10, null],
    ["pink", "#e6a0c4", null, -3, null, null]
  ];
  const colours = colourRows.map(([name, swatch, digit, exponent, tolerance, tcr]) => ({name, swatch, digit, exponent, tolerance, tcr}));
  function decodeColours(rows) {
    const count = rows.length, digits = count < 5 ? 2 : 3;
    if (rows[0].digit === 0 || rows.slice(0, digits).some(c => c.digit == null)) return null;
    const tolerance = count === 3 ? 20 : rows[digits + 1].tolerance;
    const tcr = count === 6 ? rows[5].tcr : null;
    if (tolerance == null || count === 6 && tcr == null) return null;
    const significand = rows.slice(0, digits).reduce((n, c) => n * 10 + c.digit, 0);
    const exponent = rows[digits].exponent;
    return {rows, digits, resistance: Number(significand + "e" + exponent), multiplier: 10 ** exponent, tolerance, tcr};
  }
  function bandRecord(api, b, inputs = []) {
    const names = b.rows.map(c => c.name), fields = {
      resistance: api.quantity(b.resistance, "Ω"), tolerance: api.quantity(b.tolerance, "%"),
      digitCount: api.quantity(b.digits), multiplier: api.quantity(b.multiplier), bandCount: api.quantity(names.length)
    };
    if (b.tcr != null) fields.tcr = api.withUnit(api.quantity(b.tcr, "ppm/K"), "ppm/K");
    const rating = api.format(fields.resistance) + " ±" + api.format(fields.tolerance);
    const display = rating + (fields.tcr ? ", " + api.format(fields.tcr) : "") + " · " + names.join(" · ");
    return makeRecord(api, display, fields, inputs, {bands: b.rows.map(({name, swatch}) => ({name, swatch})), source: source.bands});
  }
  define("bands", ["colour names", "?reading direction"], "resistor marking",
    "three to six bands; first digit nonzero; ordered, reverse or auto", "exact discrete marking", (args, api) => {
      arity(api, args, 1, 2, 'Use bands("yellow violet red gold"), optionally with "reverse" or "auto".');
      const [text, direction = "ordered"] = args;
      if (typeof text !== "string" || text.length > 100 || !["ordered", "reverse", "auto"].includes(direction))
        fail(api, 'Enter three to six colour names and a reading direction of "ordered", "reverse" or "auto".');
      const names = text.toLowerCase().trim().split(/[ ,;·-]+/);
      if (names.length < 3 || names.length > 6) fail(api, "A marking needs three, four, five or six colour bands.");
      const rows = names.map(name => colours.find(c => c.name === (name === "gray" ? "grey" : name)));
      if (rows.some(c => !c)) fail(api, "The marking contains an unknown band colour.");
      const forward = decodeColours(rows), backward = decodeColours(rows.slice().reverse());
      if (direction === "auto" && forward && backward && names.join("/") !== names.slice().reverse().join("/"))
        fail(api, 'Both band orders are valid. Identify the first digit and use "ordered" or "reverse".');
      const chosen = direction === "reverse" ? backward : direction === "auto" ? forward || backward : forward;
      if (!chosen) fail(api, "These bands cannot represent a resistor in the specified order.");
      return bandRecord(api, chosen);
    });
  define("resistorBands", ["resistance", "tolerance", "band count", "?TCR"], "resistor marking",
    "positive representable resistance, IEC tolerance; six bands require TCR", "exact nominal marking; no rounding", (args, api) => {
      arity(api, args, 3, 4, "Use resistorBands(resistance, tolerance, band count[, TCR]).");
      const [rq, tq, nq, cq] = args;
      const ohms = typed(api, rq, "Ω", "Resistance"), tolerance = typed(api, tq, "%", "Tolerance"),
        count = typed(api, nq, "", "Band count");
      // A physical resistor may have a tolerance. Its digits describe the nominal.
      args.slice(1).forEach(q => exact(api, q, "The marking tolerance, count and TCR"));
      if (!(ohms > 0) || ![3, 4, 5, 6].includes(count)) fail(api, "Choose a positive resistance and three to six bands.");
      if (count === 3 && tolerance !== 20) fail(api, "A three-band resistor has ±20% tolerance.");
      if (count === 6 && !cq || count !== 6 && cq) fail(api, "A temperature coefficient is required only for a six-band marking.");
      const tol = colours.find(c => c.tolerance != null && tolerance === c.tolerance);
      if (count !== 3 && !tol) fail(api, "This tolerance has no IEC colour band.");
      const tcr = cq && typed(api, cq, "ppm/K", "Temperature coefficient");
      const temperature = cq && colours.find(c => c.tcr != null && Math.abs(c.tcr - tcr) <= 4 * Number.EPSILON * c.tcr);
      if (cq && !temperature) fail(api, "This temperature coefficient has no IEC colour band.");
      const n = count < 5 ? 2 : 3;
      for (const mult of colours) {
        const digits = Math.round(ohms / 10 ** mult.exponent);
        if (digits < 10 ** (n - 1) || digits >= 10 ** n) continue;
        const marked = Number(digits + "e" + mult.exponent);
        if (Math.abs(ohms - marked) > 4 * Number.EPSILON * marked) continue;
        const rows = [...String(digits)].map(d => colours[Number(d)]).concat(mult);
        if (count >= 4) rows.push(tol);
        if (temperature) rows.push(temperature);
        return bandRecord(api, decodeColours(rows), args);
      }
      fail(api, "This resistance cannot be represented by the requested bands without rounding.");
    });

  const wireDiameter = n => 0.000127 * 92 ** ((36 - n) / 39);
  const wireArea = n => Math.PI * wireDiameter(n) ** 2 / 4;
  const gaugeName = n => n <= 0 ? "0".repeat(1 - n) : String(n);
  function gaugeRecord(api, n, extra, metadata, inputs) {
    const fields = {
      gauge: api.quantity(n), diameter: api.withUnit(api.quantity(wireDiameter(n), "metre"), "mm"),
      area: api.withUnit(api.quantity(wireArea(n), "metre^2"), "mm²"), ...extra
    };
    const display = "AWG " + gaugeName(n) + " · " + api.format(fields.diameter) + " diameter · " + api.format(fields.area) + " area" +
      (metadata?.signedErrorText ? " · " + metadata.signedErrorText : "");
    return makeRecord(api, display, fields, inputs, {gauge: gaugeName(n), conductor: "solid round, bare", source: source.wire, ...metadata});
  }
  define("awg", ["gauge"], "wire geometry", "integer -3 to 56 or string 0, 00, 000, 0000",
    "exact discrete gauge", (args, api) => {
      arity(api, args, 1, 1, 'Use awg(24) or awg("0000").');
      const [q] = args;
      let n;
      if (typeof q === "string" && /^0{1,4}$/.test(q)) n = 1 - q.length;
      else {
        n = typed(api, q, "", "AWG gauge");
        exact(api, q, "AWG gauge");
        if (n === 0 && /^0{2,4}$/.test(q.rawLiteral)) n = 1 - q.rawLiteral.length;
      }
      if (!Number.isInteger(n) || n < -3 || n > 56) fail(api, "AWG must be a whole gauge from 0000 to 56.");
      return gaugeRecord(api, n, {}, {}, args);
    });
  define("nearestAWG", ["diameter or area"], "wire geometry with signed error",
    "positive bare diameter or area; nearest gauge 0000 to 56 by log ratio", "discrete nominal selection with enclosing gauge range", (args, api) => {
      arity(api, args, 1, 1, "Use nearestAWG(bare diameter or cross-sectional area).");
      const [q] = args, diameterInput = is(api, q, "metre"), unit = diameterInput ? "metre" : "metre^2";
      const input = typed(api, q, unit, "Wire diameter or cross-sectional area");
      positive(api, q, "Wire dimension");
      const size = diameterInput ? wireDiameter : wireArea;
      const snap = x => {
        for (let n = -3; n < 56; n++) if (x >= Math.sqrt(size(n) * size(n + 1))) return n;
        return 56;
      };
      const n = snap(input), lo = snap(range(q).max), hi = snap(range(q).min);
      const error = size(n) / input - 1;
      const reason = lo === hi ? undefined : "The measured interval crosses an AWG selection threshold.";
      const field = (measurement, outputUnit, preferred) =>
        api.withUnit(api.lift([q], {value: measurement(n), unit: outputUnit, partials: [0],
          bounds: {min: measurement(hi), max: measurement(lo)}, exactBounds: true, rssReason: reason}), preferred);
      const value = api.lift([q], {value: n, unit: "", partials: [0], bounds: {min: lo, max: hi}, exactBounds: true, rssReason: reason});
      // The selection error is relative to the input dimension (area error differs from diameter error).
      return gaugeRecord(api, n, {gauge: value, diameter: field(wireDiameter, "metre", "mm"), area: field(wireArea, "metre^2", "mm²")},
        {inputKind: diameterInput ? "diameter" : "area", signedRelativeError: error, signedErrorText: signedPercent(api, error)}, args);
    });

  const smoothTolerance = "monotone bounds and analytic local sensitivity";
  const ln10 = Math.LN10;
  function ratioDb(name, unit, factor, convention) {
    define(name, ["positive ratio or measurement", "?reference"], "dB", "positive dimensionless ratio or two positive " + unit + " inputs",
      smoothTolerance, (args, api) => {
        arity(api, args, 1, 2, name + " needs a dimensionless ratio or a measurement and reference.");
        for (const q of args) {
          typed(api, q, args.length === 1 ? "" : unit, name);
          positive(api, q, name);
        }
        const [a, b] = args;
        const metadata = {convention, ...(b && {reference: {value: b.value, unit}})};
        if (a.bound && a.bound === b?.bound && a.value === b.value && range(a).min === range(b).min && range(a).max === range(b).max) {
          const d = factor / (ln10 * a.value);
          return annotated(api.lift(args, {value: 0, unit: "dB", partials: [d, -d],
            bounds: {min: 0, max: 0}, exactBounds: true}), metadata);
        }
        return smooth(api, args, "dB", (x, ref = 1) => factor * (Math.log10(x) - Math.log10(ref)),
          (y, x, ref) => ref == null ? [factor / (ln10 * x)] : [factor / (ln10 * x), -factor / (ln10 * ref)],
          metadata);
      });
  }
  ratioDb("dbPower", "W", 10, "power ratio");
  ratioDb("dbVoltage", "V", 20, "voltage amplitude ratio");
  for (const [name, factor, convention] of [["powerRatio", 10, "power ratio"], ["voltageRatio", 20, "voltage amplitude ratio"]]) {
    define(name, ["dB"], "dimensionless ratio", "finite relative level in dB", smoothTolerance, (args, api) => {
      arity(api, args, 1, 1, name + " needs a relative level in dB.");
      typed(api, args[0], "dB", "Relative level");
      return smooth(api, args, "", db => 10 ** (db / factor), y => [ln10 * y / factor], {convention});
    });
  }
  define("dbm", ["power or RMS voltage", "?resistive impedance for voltage"], "dBm",
    "positive watts; or positive RMS volts and resistive ohms", smoothTolerance, (args, api) => {
      arity(api, args, 1, 2, "Use dbm(power) or dbm(RMS voltage, resistive impedance).");
      const [input, impedance] = args, metadata = {reference: {value: 0.001, unit: "W"}};
      if (is(api, input, "V")) {
        if (!impedance) fail(api, "Converting RMS volts to dBm requires a positive resistive impedance.");
        typed(api, impedance, "Ω", "Resistive impedance"); positive(api, impedance, "Resistive impedance"); positive(api, input, "RMS voltage");
        return smooth(api, args, "dBm", (v, r) => 20 * Math.log10(v) - 10 * Math.log10(r) + 30,
          (y, v, r) => [20 / (ln10 * v), -10 / (ln10 * r)], {...metadata, impedanceOhms: impedance.value, voltage: "RMS"});
      }
      if (impedance) fail(api, "Use a single power quantity or supply RMS volts and a resistive impedance.");
      typed(api, input, "W", "Power"); positive(api, input, "Power");
      return smooth(api, args, "dBm", w => 10 * Math.log10(w) + 30, (y, w) => [10 / (ln10 * w)], metadata);
    });
  define("watts", ["dBm or dB", "?power reference for relative dB"], "W",
    "finite dBm; relative power dB requires a positive power reference", smoothTolerance, (args, api) => {
      arity(api, args, 1, 2, "Use watts(level in dBm) or watts(relative dB, power reference).");
      const [level, ref] = args;
      if (is(api, level, "dBm")) {
        if (ref) fail(api, "dBm fixes its reference at 1 mW.");
        return smooth(api, args, "W", db => 10 ** ((db - 30) / 10), y => [ln10 * y / 10], {reference: {value: 0.001, unit: "W"}});
      }
      typed(api, level, "dB", "Power ratio");
      if (!ref) fail(api, "Converting relative dB to watts needs a power reference.");
      typed(api, ref, "W", "Power reference"); positive(api, ref, "Power reference");
      return smooth(api, args, "W", (db, w) => 10 ** (db / 10 + Math.log10(w)),
        (y, db, w) => [ln10 * y / 10, y / w], {reference: {value: ref.value, unit: "W"}});
    });
  define("dbv", ["RMS voltage"], "dBV", "positive RMS volts; fixed 1 V RMS reference", smoothTolerance, (args, api) => {
    arity(api, args, 1, 1, "Use dbv(RMS voltage).");
    typed(api, args[0], "V", "RMS voltage"); positive(api, args[0], "RMS voltage");
    return smooth(api, args, "dBV", v => 20 * Math.log10(v), (y, v) => [20 / (ln10 * v)],
      {reference: {value: 1, unit: "V"}, voltage: "RMS"});
  });
  define("vrms", ["dBm, dBV or dB", "?resistive impedance or amplitude reference"], "V RMS",
    "dBm needs positive resistive impedance; relative dB needs positive RMS voltage reference", smoothTolerance, (args, api) => {
      arity(api, args, 1, 2, "Use vrms(level[, resistive impedance or RMS voltage reference]).");
      const [level, ref] = args;
      if (is(api, level, "dBV")) {
        if (ref) fail(api, "dBV fixes its reference at 1 V RMS.");
        return smooth(api, args, "V", db => 10 ** (db / 20), y => [ln10 * y / 20], {voltage: "RMS", reference: {value: 1, unit: "V"}});
      }
      if (is(api, level, "dBm")) {
        if (!ref) fail(api, "Converting dBm to RMS volts requires a positive resistive impedance.");
        typed(api, ref, "Ω", "Resistive impedance"); positive(api, ref, "Resistive impedance");
        return smooth(api, args, "V", (db, r) => 10 ** ((db - 30) / 20 + Math.log10(r) / 2),
          (y, db, r) => [ln10 * y / 20, y / (2 * r)], {voltage: "RMS", impedanceOhms: ref.value, reference: {value: 0.001, unit: "W"}});
      }
      typed(api, level, "dB", "Relative level");
      if (!ref) fail(api, "Converting relative dB to volts needs an explicit RMS voltage reference.");
      typed(api, ref, "V", "Amplitude reference"); positive(api, ref, "Amplitude reference");
      return smooth(api, args, "V", (db, v) => 10 ** (db / 20 + Math.log10(v)),
        (y, db, v) => [ln10 * y / 20, y / v], {voltage: "RMS", reference: {value: ref.value, unit: "V"}});
    });
  const crestFactors = new Map([["sine", Math.SQRT2], ["square", 1], ["triangle", Math.sqrt(3)]]);
  for (const [name, scale, kind] of [["vpeak", 1, "peak"], ["vpp", 2, "peak-to-peak"]]) {
    define(name, ["RMS voltage", "waveform or crest factor"], "V " + kind, "nonnegative RMS; sine, square, triangle or crest factor ≥ 1",
      smoothTolerance, (args, api) => {
        arity(api, args, 2, 2, name + " needs an RMS voltage and a waveform or crest factor.");
        const [voltage, crest] = args;
        typed(api, voltage, "V", "RMS voltage");
        if (range(voltage).min < 0) fail(api, "RMS voltage cannot be negative.");
        const metadata = {voltage: kind, ...(scale === 2 && {waveformSymmetry: "symmetric about zero"})};
        if (typeof crest === "string") {
          const k = crestFactors.get(crest.toLowerCase());
          if (!k) fail(api, 'Choose "sine", "square", "triangle" or an explicit crest factor.');
          return smooth(api, [voltage], "V", v => v * k * scale, () => [k * scale], {...metadata, waveform: crest, crestFactor: k});
        }
        const k = typed(api, crest, "", "Crest factor");
        if (range(crest).min < 1) fail(api, "An amplitude crest factor must be at least one.");
        return smooth(api, args, "V", (v, factor) => v * factor * scale, (y, v, factor) => [factor * scale, v * scale],
          {...metadata, crestFactor: k});
      });
  }
  for (const [name, inputUnit, outputUnit] of [["period", "Hz", "s"], ["frequency", "s", "Hz"]]) {
    define(name, [inputUnit], outputUnit, "positive " + inputUnit, smoothTolerance, (args, api) => {
      arity(api, args, 1, 1, name + " needs one positive " + inputUnit + " quantity.");
      typed(api, args[0], inputUnit, name); positive(api, args[0], name);
      return smooth(api, args, outputUnit, x => 1 / x, (y, x) => [-y / x]);
    });
  }
  define("wavelength", ["frequency", "propagation speed"], "metre", "positive frequency and explicit positive propagation speed",
    smoothTolerance, (args, api) => {
      arity(api, args, 2, 2, "Wavelength needs an explicit propagation speed, such as c for vacuum.");
      const [f, speed] = args;
      typed(api, f, "Hz", "Frequency"); typed(api, speed, "metre/s", "Propagation speed");
      positive(api, f, "Frequency"); positive(api, speed, "Propagation speed");
      return smooth(api, args, "metre", (hz, v) => v / hz, (y, hz) => [-y / hz, 1 / hz],
        {speedMetresPerSecond: speed.value, ...(speed.metadata?.medium && {medium: speed.metadata.medium})});
    });
  define("corner", ["resistance", "capacitance"], "Hz", "positive R and C for a single-pole RC corner",
    smoothTolerance, (args, api) => {
      arity(api, args, 2, 2, "Use corner(resistance, capacitance).");
      typed(api, args[0], "Ω", "Resistance"); typed(api, args[1], "F", "Capacitance");
      positive(api, args[0], "Resistance"); positive(api, args[1], "Capacitance");
      return smooth(api, args, "Hz", (r, c) => {
        const product = r * c;
        if (product > 0 && Number.isFinite(product)) return (0.5 / Math.PI) / product;
        return Math.exp(-Math.log(2 * Math.PI) - Math.log(r) - Math.log(c));
      }, (y, r, c) => [-y / r, -y / c]);
    });
  define("divider", ["input voltage", "top resistance", "bottom resistance"], "V", "passive divider with positive resistances",
    smoothTolerance, (args, api) => {
      arity(api, args, 3, 3, "Use divider(input voltage, top resistance, bottom resistance).");
      typed(api, args[0], "V", "Input voltage");
      for (const q of args.slice(1)) { typed(api, q, "Ω", "Divider resistance"); positive(api, q, "Divider resistance"); }
      const gain = (t, b) => t > b ? (b / t) / (1 + b / t) : 1 / (1 + t / b);
      return smooth(api, args, "V", (v, t, b) => v * gain(t, b), (y, v, t, b) => {
        const k = gain(t, b), complement = gain(b, t);
        return [k, -y * complement / t, y * complement / b];
      });
    });

  function invoke(name, args, api) {
    const entry = specs.get(String(name).toLowerCase());
    return entry ? entry.call(args, api) : null;
  }
  // The ordinary "in unit" operator asks here only for physically defined cross-unit
  // conversions. The same functions supply both the value and any missing-reference diagnostic.
  function convert(q, targetUnit, api) {
    if (q?.kind !== "quantity" || is(api, q, targetUnit)) return null;
    const target = api.quantity(1, targetUnit);
    let name;
    if (["dB", "dBm", "dBV"].includes(q.tag)) {
      if (is(api, target, "V")) name = "vrms";
      else if (is(api, target, "W")) {
        if (q.tag === "dBV") fail(api, "Converting dBV to watts requires a positive resistive impedance.");
        name = "watts";
      } else if (target.tag && ["dBm", "dBV"].includes(target.tag)) {
        if (q.tag === "dB") fail(api, "Converting relative dB to an absolute level requires an explicit reference.");
        fail(api, "Converting between dBm and dBV requires a positive resistive impedance.");
      }
    } else if (target.tag === "dBm" && (is(api, q, "W") || is(api, q, "V"))) name = "dbm";
    else if (target.tag === "dBV" && is(api, q, "V")) name = "dbv";
    return name ? api.withUnit(invoke(name, [q], api), targetUnit) : null;
  }
  const catalogue = Object.freeze([...specs.values()].map(({call, ...s}) => Object.freeze({...s, args: Object.freeze(s.args)})));
  return Object.freeze({invoke, convert, catalogue, names: Object.freeze(catalogue.map(s => s.name))});
})();
