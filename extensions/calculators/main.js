// Engineering Calculators: a first-party extension. It runs in the same sandbox, through
// the same public API and permission checks, as any third-party extension.
const MIL = 0.0254, OZ_MIL = 1.378; // 1 oz/ft² copper is 1.378 mil (35 µm) thick

// ------------------------------------------------------------------ IPC-2221
// I = k · ΔT^0.44 · A^0.725 (A in mil²); k = 0.048 outer layers, 0.024 inner layers.
function trackWidth({current, rise = 10, copper = 1, layer = "external"}) {
  if (!(current > 0) || !(rise > 0) || !(copper > 0)) throw Error("Enter a current, temperature rise and copper weight above zero.");
  const k = layer === "internal" ? 0.024 : 0.048, area = (current / (k * rise ** 0.44)) ** (1 / 0.725);
  const mil = area / (copper * OZ_MIL);
  const notes = [];
  if (current > 35 || mil > 400 || rise < 10 || rise > 100) notes.push("Outside the IPC-2221 chart range (≤35 A, ≤400 mil, 10–100 °C rise).");
  return {widthMm: mil * MIL, widthMil: mil, areaMil2: area, notes};
}
// Via barrel as a plated cylinder: A = π·t·(d + t); the outer-layer constant is customary.
function viaCurrent({drill, plating = 25, rise = 10}) {
  if (!(drill > 0) || !(plating > 0) || !(rise > 0)) throw Error("Enter a drill, plating thickness and temperature rise above zero.");
  const d = drill / MIL, t = plating / 25.4, area = Math.PI * t * (d + t);
  return {current: 0.048 * rise ** 0.44 * area ** 0.725, areaMil2: area};
}

// ------------------------------------------------------------------ E-series
const BASE = {
  E3: [1.0, 2.2, 4.7], E6: [1.0, 1.5, 2.2, 3.3, 4.7, 6.8],
  E12: [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2],
  E24: [1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1]
};
function series(name) {
  if (BASE[name]) return BASE[name];
  const n = {E48: 48, E96: 96, E192: 192}[name];
  if (!n) throw Error("Choose E3, E6, E12, E24, E48, E96 or E192.");
  // IEC 60063: three significant figures; E192 has one listed exception (9.20).
  return Array.from({length: n}, (_, i) => (n === 192 && i === 185 ? 9.2 : Math.round(10 ** (i / n) * 100) / 100));
}
const PREFIX = {p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, m: 1e-3, "": 1, r: 1, R: 1, k: 1e3, K: 1e3, M: 1e6, G: 1e9};
function parseValue(text) {
  const m = String(text).trim().replace(/\s+/g, "").replace(/(ohms?|Ω|F|H)$/i, "").match(/^(\d*\.?\d+)([pnuµmrRkKMG]?)(\d*)$/);
  if (!m) return NaN;
  const v = Number(m[1] + (m[3] ? (m[1].includes(".") ? "" : ".") + m[3] : ""));
  return v * PREFIX[m[2]];
}
function formatValue(v, unit = "") {
  if (!Number.isFinite(v)) return "—";
  const steps = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
  const [scale, p] = steps.find(([s]) => Math.abs(v) >= s * 0.9995) || steps.at(-1);
  return Number((v / scale).toPrecision(3)) + " " + p + unit;
}
function nearest(value, name = "E24") {
  if (!(value > 0)) throw Error("Enter a value above zero, such as 4k7 or 2.2u.");
  const list = series(name), decade = Math.floor(Math.log10(value) + 1e-12);
  const candidates = [];
  for (const d of [decade - 1, decade, decade + 1]) for (const m of list) candidates.push(Number((m * 10 ** d).toPrecision(4)));
  candidates.sort((a, b) => a - b);
  const best = candidates.reduce((a, b) => (Math.abs(Math.log(b / value)) < Math.abs(Math.log(a / value)) ? b : a));
  const below = [...candidates].reverse().find(c => c <= value * (1 + 1e-9)), above = candidates.find(c => c >= value * (1 - 1e-9));
  return {value: best, below, above, error: (best - value) / value * 100};
}
// Regulator feedback: Vout = Vref · (1 + R1 / R2). Searches R2 over 1 kΩ–1 MΩ.
function divider({vout, vref = 0.8, series: name = "E96", prefer = 10000}) {
  if (!(vout > vref) || !(vref > 0)) throw Error("Vout must be above Vref, and Vref above zero.");
  const list = series(name), ratio = vout / vref - 1, options = [];
  for (let d = 3; d <= 5; d++) for (const m of list) {
    const r2 = Number((m * 10 ** d).toPrecision(4)), r1 = nearest(r2 * ratio, name).value, actual = vref * (1 + r1 / r2);
    options.push({r1, r2, vout: actual, error: (actual - vout) / vout * 100, current: actual / (r1 + r2)});
  }
  options.sort((a, b) => Math.abs(a.error) - Math.abs(b.error) || Math.abs(Math.log(a.r2 / prefer)) - Math.abs(Math.log(b.r2 / prefer)));
  const seen = new Set();
  return options.filter(o => { const k = o.r1 + "/" + o.r2; if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 4);
}
exports.math = {trackWidth, viaCurrent, series, nearest, divider, parseValue, formatValue};

// Compatibility commands for scripts written against the original extension. The
// window, menu entries, selection and undo belong to the editor's Calculators panel.
exports.activate = function (api) {
  const inputs = {track: {current: 1, rise: 10, copper: 1, layer: "external"}, via: {drill: 0.3, plating: 25, rise: 10},
    eseries: {value: "4k7", series: "E24"}, divider: {vout: 3.3, vref: 0.8, series: "E96"}};
  function compute(kind, values = {}) {
    if (!Object.hasOwn(inputs, kind)) throw Error("Unknown calculator " + kind + ".");
    const v = inputs[kind] = {...inputs[kind], ...values};
    if (kind === "track") return trackWidth(v);
    if (kind === "via") return viaCurrent(v);
    if (kind === "divider") return divider(v);
    const value = parseValue(v.value);
    return {...nearest(value, v.series), input: value};
  }
  api.commands.register("calculators.compute", compute);
  for (const kind of Object.keys(inputs)) api.commands.register("calculators.form." + kind, values => compute(kind, values));
};
