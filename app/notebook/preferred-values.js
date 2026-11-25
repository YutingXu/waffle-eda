"use strict";
// Pure IEC preferred values shared by the engineering calculators and notebook worker.
globalThis.AtriumPreferredValues = (() => {
  // ------------------------------------------------------------------ E-series (IEC 60063)
  // E6–E24 are the historical rounded values; E48–E192 are 10^(i/n) to three figures, except
  // the one IEC exception: E192 uses 9.20 where the formula gives 9.19.
  const FIXED = {
    E3: [1.0, 2.2, 4.7],
    E6: [1.0, 1.5, 2.2, 3.3, 4.7, 6.8],
    E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
    E24: [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1]
  };
  const SERIES = ["E3", "E6", "E12", "E24", "E48", "E96", "E192"];
  const cache = {};
  function eseries(name = "E24") {
    name = String(name).toUpperCase();
    if (cache[name]) return cache[name];
    if (FIXED[name]) return (cache[name] = FIXED[name].slice());
    const n = {E48: 48, E96: 96, E192: 192}[name];
    if (!n) throw Error("Unknown E-series " + name + ". Use one of " + SERIES.join(", ") + ".");
    const out = [];
    for (let i = 0; i < n; i++) out.push(Math.round(Math.pow(10, i / n) * 100) / 100);
    if (n === 192) out[out.indexOf(9.19)] = 9.2;
    return (cache[name] = out);
  }
  // Standard values from lo to hi (inclusive), ascending.
  function range(name, lo, hi) {
    const s = eseries(name), out = [];
    for (let d = Math.floor(Math.log10(lo)) - 1; d <= Math.ceil(Math.log10(hi)); d++) {
      const m = Math.pow(10, d);
      for (const v of s) { const x = +(v * m).toPrecision(3); if (x >= lo * (1 - 1e-9) && x <= hi * (1 + 1e-9)) out.push(x); }
    }
    return out;
  }
  // Logarithmic distance switches at the geometric mean. Comparing the midpoint directly
  // makes an exact tie choose the lower value on both sides of a decade.
  function nearest(x, name = "E24") {
    if (!Number.isFinite(x) || x <= 0) throw Error("The value must be finite and above zero.");
    const values = eseries(name), [mantissa, exponent] = x.toExponential().split("e");
    const scaled = Number(mantissa);
    let lo = 0, hi = values.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (values[mid] < scaled) lo = mid + 1;
      else hi = mid;
    }
    const lower = values[lo - 1] ?? values[0], upper = values[lo] ?? 10;
    const threshold = Math.sqrt(lower * upper);
    const chosen = scaled <= threshold ? lower : upper;
    // The decimal construction works even when 10^exponent would underflow on its own.
    const value = Number(chosen + "e" + exponent);
    if (!Number.isFinite(value) || value === 0) throw Error("The nearest preferred value is outside the finite number range.");
    return {value, error: (value - x) / x};
  }
  return Object.freeze({SERIES, eseries, range, nearest});
})();
