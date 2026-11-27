"use strict";
// Generic parts: passives and other simple parts placed without picking a library part, plus the
// shared machinery the parametric connector generator (connector-gen.js) builds on.
//
//   AtriumGenericParts.parseValue("4k7", "resistor")   -> {value: 4700, unit: "Ω", text: "4.7 kΩ", rkm: "4k7"}
//   AtriumGenericParts.series("E24") / nearest(v, "E24") / hint(text, family, tolerance)
//   AtriumGenericParts.make({family, package, style, subtype})  -> library def (deterministic)
//   AtriumGenericParts.place(project, doc, at, o)       -> {def, part}; o: {family, package, value, parameters}
//   AtriumGenericParts.edit(project, part, change)      -> report; value, parameters, package, style, subtype
//   AtriumGenericParts.candidates(project, part) / bind(project, part, defId) / unbind(project, part)
//   AtriumGenericParts.check(project)                   -> per generic def: current, customised or out of date
//   AtriumGenericParts.headless(op, args, ctx)          -> MCP place_generic_part / edit_generic_part / list_generic_parts
//
// Storage. A generic definition is an ordinary library definition (symbol, footprint, 3D height)
// marked def.generic = {v, family, package, style, subtype?, fields, digest}. It depends only on
// what shapes the geometry (family, package, symbol style, subtype), never on the value, so every
// 0603 resistor of a project shares one definition. Its id is derived from those parameters
// ("gen-res-0603-…"), so the same parameters always give the same id and the same geometry, byte
// for byte: regenerating never changes Gerber, BOM or pick-and-place output. What differs per part
// is stored on the part as text: part.value ("4.7 kΩ") and part.parameters (Tolerance, Power,
// Voltage, Temperature coefficient, Dielectric, ... and a Description). The geometry is written to
// the file as well, once per shared definition, so older Waffle builds (format 1.2, whose
// validator needs a symbol or footprint on every definition) and other tools still open the
// project; generic.digest tells a regenerated definition from one edited by hand, and a
// definition edited by hand is never regenerated over.
//
// Footprints come from the IPC-7351B wizard (footprint-wizard.js: chips, MELF, SOD, molded
// tantalum) or, for through-hole axial and radial parts, crystals, test points and jumpers, from
// the IPC-7251-style lands below (hole and annular ring from the wizard's tht goals). Every
// footprint has pads, a courtyard (Mechanical 15), an assembly outline (Mechanical 13) that
// step-export.js extrudes into the 3D body, footprint.height and silk with a pin-1 or polarity mark.
//
// Binding to a manufacturer part never invents a part number: candidates come only from library
// data the app already has (the project library and the library sources), and binding copies that
// part's own Manufacturer / MPN / supplier parameters onto the generic part.
globalThis.AtriumGenericParts = (() => {
  const VERSION = 1, G = 2.54;
  const A = () => globalThis.Atrium, L = () => globalThis.AtriumLibrary, W = () => globalThis.AtriumFootprintWizard;
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const up = (v, step) => r6(Math.ceil(v / step - 1e-9) * step);
  const clone = v => JSON.parse(JSON.stringify(v));
  const fail = m => { throw Error(m); };
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);

  // ------------------------------------------------------------------ hashing (stable ids and digests)
  function fnv(text, seed = 0x811c9dc5) {
    let h = seed >>> 0;
    for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return h.toString(16).padStart(8, "0");
  }
  const hash = text => fnv(text) + fnv(text, 0x9e3779b9);
  // JSON with sorted object keys, so equal values always hash alike.
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
    if (obj(v)) return "{" + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    return JSON.stringify(v);
  }
  function digestOf(def) {
    const {symbol, schDrawing, footprint} = A().definitionGeometry(def);
    return hash(canonical({symbol:symbol || null, schDrawing:schDrawing || null, footprint:footprint || null}));
  }

  // ------------------------------------------------------------------ values
  // Engineering notation: 4k7, 4.7k, 4.7 kΩ, 100n, 100nF, 2u2, 2.2µH, 4R7, R10, 0R, 1M, 1meg, 16MHz,
  // 4,7k (decimal comma). M is mega and m is milli; K/k are kilo; R is the decimal mark of resistors.
  const MULT = {f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, m: 1e-3, "": 1, r: 1, k: 1e3, K: 1e3, M: 1e6, meg: 1e6, G: 1e9, T: 1e12};
  const UNIT = {resistor: "Ω", capacitor: "F", polarised: "F", electrolytic: "F", inductor: "H", ferrite: "Ω", crystal: "Hz", fuse: "A"};
  const unitWords = {"Ω": /(Ω|ω|ohms?|Ohms?)$/, F: /F$/i, H: /H$/, Hz: /hz$/i, A: /A$/i};
  function parseValue(text, family = "resistor") {
    const unit = UNIT[family] || "";
    let s = String(text ?? "").normalize("NFKC").trim().replace(/[µμ]/g, "u").replace(/\s+/g, "");
    if (!s || s.length > 40) return null;
    if (/^\d+,\d+[a-zA-Z]*$/.test(s)) s = s.replace(",", ".");
    // A trailing unit (Ω, ohm, F, H, Hz, A) is optional; "@ 100 MHz" notes on ferrites are dropped.
    if (family === "ferrite") s = s.replace(/@.*$/, "");
    const uw = unitWords[unit];
    if (uw && uw.test(s) && !(unit === "F" && /^\d+(\.\d+)?f$/.test(s))) s = s.replace(uw, "");
    if (unit === "Ω" && /^\d*\.?\d+R$/i.test(s)) s = s.slice(0, -1);
    let m, v = NaN;
    if ((m = /^(\d+)(meg|[fpnumkKMGTRr])(\d+)$/.exec(s))) {
      if (/^[Rr]$/.test(m[2]) && unit !== "Ω") return null;
      v = Number(m[1] + "." + m[3]) * MULT[/^[Rr]$/.test(m[2]) ? "r" : m[2]];
    } else if ((m = /^[Rr](\d+)$/.exec(s)) && unit === "Ω") v = Number("0." + m[1]);
    else if ((m = /^(\d*\.?\d+(?:[eE][+-]?\d+)?)(meg|MEG|[fpnumkKMGT])?$/.exec(s))) v = Number(m[1]) * MULT[m[2] === "MEG" ? "meg" : m[2] || ""];
    if (!Number.isFinite(v) || v < 0 || v > 1e15) return null;
    v = Number(v.toPrecision(12));
    return {value: v, unit, text: formatValue(v, unit), rkm: rkm(v, unit)};
  }
  const PREFIXES = [[1e12, "T"], [1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];
  function scaled(v) {
    if (v === 0) return [0, ""];
    for (const [f, p] of PREFIXES) if (Math.abs(v) >= f * (1 - 1e-12)) return [v / f, p];
    return [v / 1e-15, "f"];
  }
  const trim = n => String(Number(n.toPrecision(4)));
  // "4.7 kΩ", "100 nF", "16 MHz": the canonical text written to part.value.
  function formatValue(v, unit) { const [n, p] = scaled(v); return trim(n) + " " + p + unit; }
  // Resistor-style code: 4k7, 100n, 2u2, 4R7, 0R.
  function rkm(v, unit) {
    if (unit === "Ω" && v > 0 && v < 1) return "R" + String(Number(v.toPrecision(4))).slice(2);
    const [n, p0] = scaled(v), p = p0 === "µ" ? "u" : p0 || (unit === "Ω" ? "R" : "");
    const t = trim(n);
    if (!p) return t;
    return t.includes(".") ? t.replace(".", p) : t + p;
  }

  // ------------------------------------------------------------------ E-series (IEC 60063)
  const E6 = [10, 15, 22, 33, 47, 68];
  const E12 = [10, 12, 15, 18, 22, 27, 33, 39, 47, 56, 68, 82];
  const E24 = [10, 11, 12, 13, 15, 16, 18, 20, 22, 24, 27, 30, 33, 36, 39, 43, 47, 51, 56, 62, 68, 75, 82, 91];
  const E96 = [100, 102, 105, 107, 110, 113, 115, 118, 121, 124, 127, 130, 133, 137, 140, 143, 147, 150, 154, 158, 162, 165, 169, 174,
    178, 182, 187, 191, 196, 200, 205, 210, 215, 221, 226, 232, 237, 243, 249, 255, 261, 267, 274, 280, 287, 294, 301, 309, 316, 324,
    332, 340, 348, 357, 365, 374, 383, 392, 402, 412, 422, 432, 442, 453, 464, 475, 487, 499, 511, 523, 536, 549, 562, 576, 590, 604,
    619, 634, 649, 665, 681, 698, 715, 732, 750, 768, 787, 806, 825, 845, 866, 887, 909, 931, 953, 976];
  const E48 = E96.filter((_, i) => i % 2 === 0);
  const SERIES = {E6, E12, E24, E48, E96};
  const series = name => (SERIES[name] || []).slice();
  // The series a tolerance implies: 20% E6, 10% E12, 5% E24, 2% E48, 1% and tighter E96.
  function seriesFor(tolerance) {
    const t = parseFloat(String(tolerance ?? "").replace(/[^\d.]/g, ""));
    if (!Number.isFinite(t)) return "E24";
    return t >= 20 ? "E6" : t >= 10 ? "E12" : t >= 5 ? "E24" : t >= 2 ? "E48" : "E96";
  }
  // Neighbours of v in a series: {lower, upper, nearest, exact, error (fraction, nearest vs v)}.
  function nearest(v, name = "E24") {
    const list = SERIES[name];
    if (!list || !(v > 0)) return null;
    const digits = list[0] >= 100 ? 100 : 10, decade = Math.floor(Math.log10(v) + 1e-12);
    const cands = [];
    for (const d of [decade - 1, decade, decade + 1]) for (const k of list) cands.push(Number((k / digits * 10 ** d).toPrecision(6)));
    cands.sort((a, b) => a - b);
    const exact = cands.find(c => Math.abs(c - v) <= v * 1e-9);
    let lower = null, upper = null;
    for (const c of cands) { if (c <= v * (1 + 1e-9)) lower = c; if (c >= v * (1 - 1e-9) && upper == null) upper = c; }
    const near = [lower, upper].filter(x => x != null).sort((a, b) => Math.abs(Math.log(a / v)) - Math.abs(Math.log(b / v)))[0];
    return {lower, upper, nearest: near, exact: exact != null, error: r6((near - v) / v)};
  }
  // Text for the value field: what was understood, and the E-series neighbours when it is off-series.
  function hint(text, family, o = {}) {
    if (!UNIT[family]) return {ok: true, message: ""};
    const p = parseValue(text, family);
    if (!p) return {ok: false, message: "Enter a value such as " + (UNIT[family] === "F" ? "100n, 4.7µF or 2u2" : UNIT[family] === "H" ? "10µH or 2u2" : UNIT[family] === "Hz" ? "16MHz" : UNIT[family] === "A" ? "500mA or 2A" : "4k7, 10k or 4.7 kΩ") + "."};
    const out = {ok: true, value: p.value, text: p.text, rkm: p.rkm, message: p.text + (p.rkm !== p.text.replace(/\s/g, "") ? " (" + p.rkm + ")" : ""), snap: []};
    const name = o.series === "none" || !["resistor", "capacitor", "inductor", "polarised", "electrolytic"].includes(family) ? null : o.series && SERIES[o.series] ? o.series : seriesFor(o.tolerance);
    if (name && p.value > 0) {
      const n = nearest(p.value, name);
      out.series = name;
      if (n.exact) out.message += " · in " + name;
      else {
        const pct = x => (x >= p.value ? "+" : "−") + Math.abs((x - p.value) / p.value * 100).toFixed(1) + " %";
        out.snap = [n.lower, n.upper].filter(x => x != null && x > 0).map(x => ({value: x, text: formatValue(x, p.unit), delta: pct(x)}));
        out.message += " · not an " + name + " value; nearest " + out.snap.map(s => s.text + " (" + s.delta + ")").join(" or ");
        out.offSeries = true;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ symbols
  // Two-terminal symbols: pin tips at ±5.08 mm, the body between ±2.54 mm (the starter library's layout).
  const line = (pts, extra) => ({kind: "path", style: "body", points: pts.map(p => p.map(r6)), ...extra});
  const poly = (pts, fill = true) => ({kind: "path", style: "body", closed: true, fill, points: pts.map(p => p.map(r6))});
  const circle = (x, y, r, fill = false) => ({kind: "circle", style: "body", x: r6(x), y: r6(y), r: r6(r), ...(fill ? {fill: true} : {})});
  const text = (t, x, y, size = 1.5) => ({kind: "text", text: t, x: r6(x), y: r6(y), size, align: "center", style: "body"});
  const arc = (cx, cy, r, a0, a1, n = 8) => Array.from({length: n + 1}, (_, i) => { const a = (a0 + (a1 - a0) * i / n) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; });
  const pin = (number, name, x, y, orientation, electrical = 4, o = {}) => ({number: String(number), name, x, y, orientation, electrical, length: G, hideName: true, ...(o.number === false ? {} : {hideNumber: true}), ...o.extra});
  const build = (pins, shapes) => L().buildSymbol({pins, shapes, parts: 1, alternate: false});
  const two = (shapes, n1 = "1", n2 = "2", o) => build([pin(1, n1, -2 * G, 0, "left", 4, o), pin(2, n2, 2 * G, 0, "right", 4, o)], shapes);
  const leads = (a, b) => [line([[-G, 0], [-a, 0]]), line([[G, 0], [b ?? a, 0]])];
  const SYMBOLS = {
    resistor: s => two(s === "ansi"
      ? [line([[-G, 0], ...Array.from({length: 6}, (_, n) => [-G + (n + .5) * 2 * G / 6, n % 2 ? .93 : -.93]), [G, 0]])]
      : [poly([[-G, -.76], [G, -.76], [G, .76], [-G, .76]], false)]),
    capacitor: () => two([...leads(.4), line([[-.4, -1.6], [-.4, 1.6]], {width: .38}), line([[.4, -1.6], [.4, 1.6]], {width: .38})]),
    polarised: s => two(s === "ansi"
      ? [line([[-G, 0], [-.4, 0]]), line([[G, 0], [.55, 0]]), line([[-.4, -1.6], [-.4, 1.6]], {width: .38}), line(arc(2.4, 0, 1.9, 145, 215), {width: .38}), text("+", -1.5, -1.3, 1.6)]
      : [...leads(.4), line([[-.4, -1.6], [-.4, 1.6]], {width: .38}), line([[.4, -1.6], [.4, 1.6]], {width: .38}), text("+", -1.5, -1.3, 1.6)], "+", "−"),
    electrolytic: s => two(s === "ansi"
      ? [line([[-G, 0], [-.4, 0]]), line([[G, 0], [.55, 0]]), line([[-.4, -1.6], [-.4, 1.6]], {width: .38}), line(arc(2.4, 0, 1.9, 145, 215), {width: .38}), text("+", -1.5, -1.3, 1.6)]
      : [...leads(.75), poly([[-.75, -1.6], [-.25, -1.6], [-.25, 1.6], [-.75, 1.6]], false), poly([[.25, -1.6], [.75, -1.6], [.75, 1.6], [.25, 1.6]]), text("+", -1.6, -1.3, 1.6)], "+", "−"),
    inductor: () => two([...[0, 1, 2, 3].map(k => line(arc(-1.905 + 1.27 * k, 0, .635, 180, 360)))]),
    ferrite: () => two([...leads(1.6), poly([[-1.6, -.8], [1.6, -.8], [1.6, .8], [-1.6, .8]])]),
    // Diodes: pin 1 is the cathode (IPC-7351 pin-1 marking), drawn on the right.
    diode: (s, sub) => diodeSymbol(sub || "rectifier"),
    led: () => diodeSymbol("led"),
    crystal: (s, sub) => {
      const body = [line([[-G, 0], [-1.5, 0]]), line([[G, 0], [1.5, 0]]), line([[-1.5, -1.9], [-1.5, 1.9]]), line([[1.5, -1.9], [1.5, 1.9]]),
        poly([[-.8, -1.6], [.8, -1.6], [.8, 1.6], [-.8, 1.6]], false)];
      if (sub !== "4pin") return two(body);
      body.push(line([[-3.3, G], [3.3, G], [3.3, -G], [-3.3, -G], [-3.3, G]], {width: .1}));
      return build([pin(1, "1", -2 * G, 0, "left"), pin(3, "3", 2 * G, 0, "right"), pin(2, "GND", -G, 2 * G, "down", 7), pin(4, "GND", G, 2 * G, "down", 7)], body);
    },
    fuse: s => two(s === "ansi"
      ? [line([[-G, 0], [-1.9, 0]]), line([[1.9, 0], [G, 0]]), line([...arc(-.95, 0, .95, 180, 360), ...arc(.95, 0, .95, 180, 0).slice(1)])]
      : [poly([[-1.9, -.76], [1.9, -.76], [1.9, .76], [-1.9, .76]], false), line([[-G, 0], [G, 0]])]),
    testpoint: () => build([pin(1, "1", 0, G, "down")], [circle(0, -.8, .8)]),
    jumper: (s, sub) => {
      const three = /^3/.test(sub || ""), bridged = /bridged/.test(sub || "");
      if (!three) return two([line([[-G, 0], [-.9, 0]]), line([[.9, 0], [G, 0]]), line(arc(-.3, 0, .6, 90, 270)), line([...arc(.3, 0, .6, 270, 450)]),
        ...(bridged ? [line([[-.3, 0], [.3, 0]], {width: .5})] : [])]);
      return build([pin(1, "1", -2 * G, 0, "left"), pin(2, "2", 0, 2 * G, "down"), pin(3, "3", 2 * G, 0, "right")],
        [line([[-G, 0], [-1.6, 0]]), line([[1.6, 0], [G, 0]]), line([[0, G], [0, .7]]), poly([[-1.6, -.6], [-.5, -.6], [-.5, .6], [-1.6, .6]], false),
          poly([[-.35, -.6], [.35, -.6], [.35, .6], [-.35, .6]], false), poly([[.5, -.6], [1.6, -.6], [1.6, .6], [.5, .6]], false),
          ...(bridged ? [line([[-.5, 0], [-.35, 0]], {width: .5})] : [])]);
    }
  };
  function diodeSymbol(kind) {
    const body = [line([[-G, 0], [-1.1, 0]]), line([[1.1, 0], [G, 0]]), poly([[-1.1, -1.27], [-1.1, 1.27], [1.1, 0]])];
    if (kind === "schottky") body.push(line([[1.6, -1.6], [1.6, -1.27], [1.1, -1.27], [1.1, 1.27], [.6, 1.27], [.6, 1.6]]));
    else if (kind === "zener") body.push(line([[1.6, -1.6], [1.1, -1.27], [1.1, 1.27], [.6, 1.6]]));
    else if (kind === "tvs") {
      // Bidirectional TVS: two triangles meeting at a zener bar.
      body.splice(0, 3, line([[-G, 0], [-2.2, 0]]), line([[2.2, 0], [G, 0]]), poly([[-2.2, -1.27], [-2.2, 1.27], [0, 0]]), poly([[2.2, -1.27], [2.2, 1.27], [0, 0]]));
      body.push(line([[.5, -1.6], [0, -1.27], [0, 1.27], [-.5, 1.6]]));
    }
    else body.push(line([[1.1, -1.27], [1.1, 1.27]]));
    if (kind === "led") for (const dx of [0, .9]) body.push(line([[-.2 + dx, -1.6], [.7 + dx, -2.5]]), poly([[.7 + dx, -2.5], [.25 + dx, -2.35], [.55 + dx, -2.05]]));
    return build([pin(2, "A", -2 * G, 0, "left"), pin(1, "K", 2 * G, 0, "right")], body);
  }

  // ------------------------------------------------------------------ footprints
  const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => p.map(r6));
  // Silkscreen line width of generated parts: 0.18 mm clears every built-in fab preset's minimum
  // (JLCPCB 0.153, Eurocircuits class 6 0.17), so a new board passes DFM. IPC's 0.12 did not.
  const SILK_W = .18;
  const silk = (pts, closed = false) => ({kind: "path", style: "silk", width: SILK_W, points: pts.map(p => p.map(r6)), ...(closed ? {closed: true} : {})});
  const smd = (number, x, y, w, h, shape = "roundrect") => ({number: String(number), x: r6(x), y: r6(y), w: r6(w), h: r6(h), shape, angle: 0, drill: 0});
  const tht = (number, x, y, d, drill, shape = "round") => ({number: String(number), x: r6(x), y: r6(y), w: r6(d), h: r6(d), drill: r6(drill), shape, angle: 0, layer: "Multi", plated: true});
  const padBox = p => [p.x - p.w / 2, p.y - p.h / 2, p.x + p.w / 2, p.y + p.h / 2];
  const union = (a, b) => a ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : b.slice();
  // Courtyard (pads and body plus the IPC excess, out to 0.05 mm), assembly outline with .Designator.
  function dress(fp, body, o = {}) {
    const excess = o.courtyard ?? .25;
    let ext = fp.pads.reduce((b, p) => union(b, padBox(p)), null);
    if (body) ext = union(ext, body);
    if (o.extra) ext = union(ext, o.extra);
    const c = [-up(-ext[0] + excess, .05), -up(-ext[1] + excess, .05), up(ext[2] + excess, .05), up(ext[3] + excess, .05)];
    fp.shapes.push({kind: "path", points: box(c[0], c[1], c[2], c[3]), closed: true, layer: "Mechanical 15", style: "courtyard", width: .05});
    if (o.circle) fp.shapes.push({kind: "circle", layer: "Mechanical 13", style: "assembly", width: .1, x: 0, y: 0, r: r6(o.circle)});
    else if (body) fp.shapes.push({kind: "path", layer: "Mechanical 13", style: "assembly", width: .1, closed: true, points: box(...body)});
    if (body) {
      const size = r6(Math.max(.3, Math.min(1, (body[2] - body[0]) / 6, (body[3] - body[1]) * .5)));
      fp.shapes.push({kind: "text", text: ".Designator", layer: "Mechanical 13", x: r6((body[0] + body[2]) / 2), y: r6((body[1] + body[3]) / 2 + size * .35), size, align: "center"});
    }
    fp.courtyard = c;
    return fp;
  }
  const silkAround = (body, pads) => W()?.silkOutline ? W().silkOutline(body, pads, {clearance: .25, width: SILK_W}) : [silk(box(...body), true)];
  // Through-hole land from a lead diameter: IPC-7251-style allowances (the wizard's tht goals).
  function thtLand(lead, pitch) {
    const g = W()?.goal ? W().goal("tht", "B") : {hole: .2, annular: .25, courtyard: .25};
    // The wizard's thtLand keeps a 0.20 mm ring (JLCPCB's PTH minimum is 0.18 mm) at fine pitch
    // (1.27 mm headers); at 2.0 mm pitch and above it gives the same land as before.
    if (W()?.thtLand) { const t = W().thtLand(lead, pitch || 0, g); return {hole: t.hole, land: Math.max(t.land, Math.min(1.6, pitch ? pitch - .3 : 1.6)), courtyard: g.courtyard ?? .25}; }
    const hole = up(lead + g.hole, .05);
    const land = Math.max(r6(hole + .2), Math.min(up(hole + 2 * g.annular, .05), pitch ? r6(Math.floor((pitch - .25) / .05 + 1e-9) * .05) : 99));
    return {hole, land: Math.max(land, Math.min(1.6, pitch ? pitch - .3 : 1.6)), courtyard: g.courtyard ?? .25};
  }
  const code = (v, s = 100) => String(Math.round(v * s));
  function axial(o) {
    // Lying axial body (resistors, diodes): pads at ±P/2, body L×D centred, height D.
    const {hole, land} = thtLand(o.lead, o.pitch), pol = !!o.polar;
    const pads = [tht(1, -o.pitch / 2, 0, land, hole, pol ? "rect" : "round"), tht(2, o.pitch / 2, 0, land, hole)];
    const fp = {name: o.name, pads, shapes: []};
    const body = [-o.L / 2, -o.D / 2, o.L / 2, o.D / 2];
    fp.shapes.push(...silkAround(body, pads));
    for (const s of [-1, 1]) { const a = s * (o.L / 2 + .12), b = s * (o.pitch / 2 - land / 2 - .32); if (Math.abs(b) > Math.abs(a) + .2) fp.shapes.push(silk([[a, 0], [b, 0]])); }
    if (pol) fp.shapes.push(silk([[-o.L / 2 + o.L * .18, -o.D / 2], [-o.L / 2 + o.L * .18, o.D / 2]]), {kind: "path", layer: "Mechanical 13", width: .1, points: [[r6(-o.L / 2 + o.L * .18), r6(-o.D / 2)], [r6(-o.L / 2 + o.L * .18), r6(o.D / 2)]]});
    dress(fp, body);
    fp.height = r6(o.D);
    fp.ipc = {name: o.name, family: "axial", hole, land, standard: "IPC-7251 (approximated through-hole allowances)"};
    return fp;
  }
  function radial(o) {
    // Standing radial can (electrolytic, LED, disc): pads at ±P/2, round body of diameter D, height H.
    const {hole, land} = thtLand(o.lead, o.pitch), pol = !!o.polar;
    const pads = [tht(1, -o.pitch / 2, 0, land, hole, pol ? "rect" : "round"), tht(2, o.pitch / 2, 0, land, hole)];
    const fp = {name: o.name, pads, shapes: []}, R = o.D / 2;
    if (o.disc) {
      const body = [-R, -o.T / 2, R, o.T / 2];
      fp.shapes.push(...silkAround(body, pads));
      dress(fp, body);
    } else {
      fp.shapes.push({kind: "circle", style: "silk", x: 0, y: 0, r: r6(R + .12), width: SILK_W});
      // The + mark sits beyond pad 1 when the pads reach past the body (3 mm LED).
      const mx = Math.min(-R - .6, -o.pitch / 2 - land / 2 - .2 - SILK_W / 2 - .3);
      if (pol) fp.shapes.push(silk([[mx - .3, -R * .55], [mx + .3, -R * .55]]), silk([[mx, -R * .55 - .3], [mx, -R * .55 + .3]]));
      if (o.flat) fp.shapes.push(silk([[-R - .12, -R * .7], [-R - .12, R * .7]]));
      clearSilk(fp, true);
      dress(fp, [-R, -R, R, R], {circle: R});
    }
    fp.height = r6(o.H);
    fp.ipc = {name: o.name, family: "radial", hole, land, standard: "IPC-7251 (approximated through-hole allowances)"};
    return fp;
  }
  // Silk at SILK_W with its edge 0.2 mm from every pad: straight runs are clipped and a circle that
  // crosses a pad becomes arcs. `all` false only touches silk thinner than SILK_W (the wizard's 0.12).
  function clearSilk(fp, all) {
    const gap = .2 + SILK_W / 2, boxes = fp.pads.map(p => {
      const t = Math.abs(Math.round((p.angle || 0) / 90)) % 2 === 1, w = (t ? p.h : p.w) / 2 + gap, h = (t ? p.w : p.h) / 2 + gap;
      return [p.x - w, p.y - h, p.x + w, p.y + h];
    });
    const clear = q => boxes.every(b => q[0] < b[0] || q[0] > b[2] || q[1] < b[1] || q[1] > b[3]);
    const long = pts => pts.slice(1).reduce((n, q, i) => n + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0) >= .2;
    fp.shapes = fp.shapes.flatMap(s => {
      if (s.style !== "silk" || s.fill || !(all || s.width < SILK_W)) return [s];
      if (s.kind === "path" && !s.closed && s.points?.length === 2 && W()?.clipSegment)
        return W().clipSegment(s.points[0], s.points[1], boxes).filter(long).map(([p, q]) => ({...s, width: SILK_W, points: [p.map(r6), q.map(r6)]}));
      if (s.kind !== "circle") return [{...s, width: SILK_W}];
      const n = 96, pts = arc(s.x, s.y, s.r, 0, 360, n).slice(0, n), k = pts.findIndex(q => !clear(q));
      if (k < 0) return [{...s, width: SILK_W}];
      const runs = [];
      let run = [];
      for (let i = 1; i <= n; i++) {
        const q = pts[(k + i) % n];
        if (clear(q)) run.push(q);
        else { if (run.length > 1) runs.push(run); run = []; }
      }
      return runs.filter(long).map(r => ({kind: "path", style: "silk", width: SILK_W, points: r.map(q => q.map(r6))}));
    });
  }
  // The wizard's land pattern without its derivation copy (fp.wizard) and with a short IPC note.
  function wizard(spec) {
    const fp = W().generate({...spec, symbol: false, id: "gen-tmp"}).footprint;
    delete fp.wizard;
    clearSilk(fp, false);
    if (!fp.height && spec.family === "melf") fp.height = r6((W().defaults("melf", spec.preset).D || {max: 1.5}).max);
    const i = fp.ipc || {};
    fp.ipc = {name: i.name, family: i.family, density: i.density, ...(i.Z != null ? {Z: i.Z, G: i.G, X: i.X} : {}), ...(i.flagged?.length ? {flagged: i.flagged} : {})};
    if (spec.name) fp.name = spec.name;
    return fp;
  }
  function chipFp(size, kind) { return wizard({family: "chip", preset: size, kind}); }
  const TANTALUM = {
    "3216-18 (A)": {L: {min: 3, max: 3.4}, W: {min: 1, max: 1.4}, T: {min: .5, max: 1.1}, H: 1.8},
    "3528-21 (B)": {L: {min: 3.3, max: 3.7}, W: {min: 2, max: 2.4}, T: {min: .5, max: 1.1}, H: 2.1},
    "6032-28 (C)": {L: {min: 5.7, max: 6.3}, W: {min: 2, max: 2.4}, T: {min: 1, max: 1.6}, H: 2.8},
    "7343-31 (D)": {L: {min: 7, max: 7.6}, W: {min: 2.2, max: 2.6}, T: {min: 1, max: 1.6}, H: 3.1}
  };
  const DO214 = {
    SMA: {L: {min: 4.8, max: 5.3}, T: {min: .75, max: 1.6}, W: {min: 1.25, max: 1.65}, D: {min: 4, max: 4.6}, E: {min: 2.29, max: 2.92}, H: 2.3},
    SMB: {L: {min: 5.21, max: 5.59}, T: {min: .76, max: 1.52}, W: {min: 1.96, max: 2.21}, D: {min: 4.06, max: 4.57}, E: {min: 3.3, max: 3.94}, H: 2.4},
    SMC: {L: {min: 7.75, max: 8.13}, T: {min: .76, max: 1.52}, W: {min: 2.92, max: 3.18}, D: {min: 6.6, max: 7.11}, E: {min: 5.59, max: 6.22}, H: 2.4}
  };
  function alucan(D, H) {
    // SMD aluminium electrolytic (vertical chip, square base D+0.3): flat terminals under the base.
    const base = r6(D + .3), w = r6(Math.max(.6, Math.min(1.6, D * .2)));
    const l = r6(Math.max(1.6, D * .45)), x = r6(base / 2 - l / 2 + .7);
    const pads = [smd(1, -x, 0, l, w + .5, "rect"), smd(2, x, 0, l, w + .5)];
    const name = "CAPAE" + code(D, 10) + "0X" + code(H, 10) + "0N";
    const fp = {name, pads, shapes: []};
    const h = base / 2, ch = r6(base * .25);
    fp.shapes.push(...silkAround([-h, -h, h, h], pads).filter(s => s.points.every(p => p[0] > -h + ch - .01 || Math.abs(p[1]) < h - ch + .01)));
    fp.shapes.push(silk([[-h, -h + ch], [-h + ch, -h]]), silk([[-h, h - ch], [-h + ch, h]]), silk([[-h - .9, -h - .4], [-h - .3, -h - .4]]), silk([[-h - .6, -h - .7], [-h - .6, -h - .1]]));
    dress(fp, [-h, -h, h, h]);
    fp.height = r6(H);
    fp.ipc = {name, family: "alucan", standard: "lands approximated from the IPC-7351B chip goals"};
    return fp;
  }
  function crystalFp(kind) {
    if (kind === "3225") return dress({name: "XTAL_SMD_3225-4", pads: [smd(1, -1.1, .8, 1.4, 1.15), smd(2, 1.1, .8, 1.4, 1.15), smd(3, 1.1, -.8, 1.4, 1.15), smd(4, -1.1, -.8, 1.4, 1.15)],
      shapes: [silk([[-2.1, 1.75], [-2.1, -1.75]]), silk([[-2.1, 1.75], [2.0, 1.75]])], height: .8, ipc: {name: "XTAL_SMD_3225-4", family: "crystal"}}, [-1.6, -1.25, 1.6, 1.25]);
    if (kind === "2016") return dress({name: "XTAL_SMD_2016-4", pads: [smd(1, -.7, .55, .9, .8), smd(2, .7, .55, .9, .8), smd(3, .7, -.55, .9, .8), smd(4, -.7, -.55, .9, .8)],
      shapes: [silk([[-1.45, 1.25], [-1.45, -1.25]]), silk([[-1.45, 1.25], [1.35, 1.25]])], height: .55, ipc: {name: "XTAL_SMD_2016-4", family: "crystal"}}, [-1, -.8, 1, .8], {courtyard: .15});
    if (kind === "5032") return dress({name: "XTAL_SMD_5032-2", pads: [smd(1, -1.85, 0, 1.9, 2.4), smd(2, 1.85, 0, 1.9, 2.4)],
      shapes: [silk([[-.6, -1.75], [.6, -1.75]]), silk([[-.6, 1.75], [.6, 1.75]]), silk([[-3.15, -1.4], [-3.15, 1.4]])], height: 1.2, ipc: {name: "XTAL_SMD_5032-2", family: "crystal"}}, [-2.5, -1.6, 2.5, 1.6]);
    // HC-49/U through-hole: 4.88 mm lead spacing, oval body 11 × 4.65 mm, 13.5 mm tall.
    const {hole, land} = thtLand(.45, 4.88);
    const pads = [tht(1, -2.44, 0, land, hole), tht(2, 2.44, 0, land, hole)];
    const fp = {name: "XTAL_THT_HC49U", pads, shapes: [silk([[-3.2, -2.45], [3.2, -2.45]]), silk([[-3.2, 2.45], [3.2, 2.45]]),
      silk(arc(-3.2, 0, 2.45, 90, 270)), silk(arc(3.2, 0, 2.45, -90, 90))], height: 13.5, ipc: {name: "XTAL_THT_HC49U", family: "crystal", hole, land}};
    return dress(fp, [-5.5, -2.33, 5.5, 2.33]);
  }
  function testpointFp(d, thru) {
    if (thru) {
      const pads = [tht(1, 0, 0, 2, 1)];
      return dress({name: "TP_THT_D2.0_DRILL1.0", pads, shapes: [{kind: "circle", style: "silk", x: 0, y: 0, r: 1.3, width: SILK_W}], height: 4, ipc: {name: "TP_THT_D2.0_DRILL1.0", family: "testpoint"}}, null, {extra: [-1.3, -1.3, 1.3, 1.3]});
    }
    const name = "TP_PAD_D" + d.toFixed(1);
    return dress({name, pads: [smd(1, 0, 0, d, d, "round")], shapes: [{kind: "circle", style: "silk", x: 0, y: 0, r: r6(d / 2 + .35), width: SILK_W}], ipc: {name, family: "testpoint"}}, null, {extra: [-d / 2 - .41, -d / 2 - .41, d / 2 + .41, d / 2 + .41]});
  }
  function jumperFp(sub) {
    const three = /^3/.test(sub), bridged = /bridged/.test(sub), p = 1.3;
    const n = three ? 3 : 2, pads = [];
    for (let i = 0; i < n; i++) pads.push(smd(i + 1, (i - (n - 1) / 2) * (three ? 1.1 : p), 0, three ? .8 : 1, 1.5, "rect"));
    const name = "JUMPER_SOLDER_" + n + (bridged ? "_BRIDGED" + (three ? "12" : "") : "_OPEN");
    const fp = {name, pads, shapes: [], ipc: {name, family: "jumper"}};
    const x0 = pads[0].x - pads[0].w / 2 - .25, x1 = pads.at(-1).x + pads.at(-1).w / 2 + .25;
    fp.shapes.push(silk([[x0, -1.05], [x1, -1.05]]), silk([[x0, 1.05], [x1, 1.05]]));
    if (bridged) {
      // A bridged jumper is a net tie: the copper bridge joins pads 1 and 2 on purpose.
      fp.shapes.push({kind: "path", layer: "Top", width: .3, points: [[r6(pads[0].x), 0], [r6(pads[1].x), 0]]});
      fp.netTie = true; fp.netTieGroups = [["1", "2"]];
    }
    return dress(fp, null);
  }

  // Packages: id -> {title, make(family), families}. Heights for chips come from the wizard.
  const CHIP_SIZES = ["0201", "0402", "0603", "0805", "1206", "1210", "1812", "2010", "2512"];
  const METRIC = {"0201": "0603", "0402": "1005", "0603": "1608", "0805": "2012", "1206": "3216", "1210": "3225", "1812": "4532", "2010": "5025", "2512": "6332"};
  const KIND = {resistor: "RES", capacitor: "CAP", inductor: "IND", ferrite: "IND", led: "LED", fuse: "FUS"};
  const PACKAGES = {};
  for (const s of CHIP_SIZES) PACKAGES[s] = {title: s + " (" + METRIC[s] + " metric)", group: "SMD chip", make: f => chipFp(s, KIND[f] || "RES")};
  for (const [k, d] of Object.entries(TANTALUM)) PACKAGES["Tantalum " + k] = {title: "Molded tantalum " + k, group: "SMD molded",
    make: () => wizard({family: "chip", kind: "CAP", ...clone(d), name: "CAPMP" + k.slice(0, 4) + "X" + code(d.H, 10) + "0N"})};
  for (const m of ["MicroMELF", "MiniMELF", "MELF"]) PACKAGES[m] = {title: m, group: "SMD MELF", make: f => wizard({family: "melf", preset: m, kind: f === "resistor" ? "RES" : "DIO"})};
  for (const s of ["SOD-123", "SOD-323", "SOD-523"]) PACKAGES[s] = {title: s, group: "SMD diode", make: () => wizard({family: "sod", preset: s})};
  for (const [k, d] of Object.entries(DO214)) PACKAGES[k] = {title: k + " (DO-214" + {SMA: "AC", SMB: "AA", SMC: "AB"}[k] + ")", group: "SMD diode",
    make: () => wizard({family: "sod", preset: "SOD-123", ...clone(d), name: "DIO_" + k})};
  // Axial resistors (DIN body codes) and diodes: [body L, D, lead, pitch].
  const AXIAL = {"DIN0204": [3.6, 1.6, .4, 7.62], "DIN0207": [6.3, 2.5, .6, 10.16], "DIN0309": [9, 3.2, .6, 12.7], "DIN0411": [9.9, 3.6, .8, 15.24], "DIN0617": [17, 6, .8, 20.32]};
  for (const [k, [Lb, D, lead, P]] of Object.entries(AXIAL)) PACKAGES["Axial " + k] = {title: "Axial " + k + ", " + P.toFixed(2) + " mm pitch", group: "Through-hole",
    make: () => axial({name: "RESAD" + code(P) + "W" + code(lead) + "L" + code(Lb) + "D" + code(D) + "N", L: Lb, D, lead, pitch: P})};
  const DIODES = {"DO-35": [4, 2, .55, 7.62], "DO-41": [5.2, 2.7, .86, 10.16], "DO-201AD": [9.5, 5.3, 1.3, 15.24]};
  for (const [k, [Lb, D, lead, P]] of Object.entries(DIODES)) PACKAGES[k] = {title: k + " axial, " + P.toFixed(2) + " mm pitch", group: "Through-hole",
    make: () => axial({name: "DIOAD" + code(P) + "W" + code(lead) + "L" + code(Lb) + "D" + code(D) + "N", L: Lb, D, lead, pitch: P, polar: true})};
  const DISC = {"Disc D5.0 P2.50": [5, 2.5, 2.5, .5, 7], "Disc D5.0 P5.00": [5, 2.5, 5, .5, 7], "Disc D7.5 P5.00": [7.5, 3, 5, .6, 10]};
  for (const [k, [D, T, P, lead, H]] of Object.entries(DISC)) PACKAGES[k] = {title: "Ceramic disc " + k.slice(5), group: "Through-hole",
    make: () => radial({name: "CAPRD" + code(P) + "W" + code(lead) + "D" + code(D) + "T" + code(T) + "H" + code(H) + "N", D, T, pitch: P, lead, H, disc: true})};
  const RADIAL = {"Radial D5 P2.0": [5, 2, .5, 11], "Radial D6.3 P2.5": [6.3, 2.5, .5, 11], "Radial D8 P3.5": [8, 3.5, .6, 11.5], "Radial D10 P5.0": [10, 5, .6, 16], "Radial D12.5 P5.0": [12.5, 5, .6, 20]};
  for (const [k, [D, P, lead, H]] of Object.entries(RADIAL)) PACKAGES[k] = {title: "Radial can, D" + D + " mm, " + P.toFixed(1) + " mm pitch", group: "Through-hole",
    make: () => radial({name: "CAPPRD" + code(P) + "W" + code(lead) + "D" + code(D) + "H" + code(H) + "N", D, pitch: P, lead, H, polar: true})};
  const CANS = {"SMD can 4×5.4": [4, 5.4], "SMD can 5×5.4": [5, 5.4], "SMD can 6.3×5.4": [6.3, 5.4], "SMD can 6.3×7.7": [6.3, 7.7], "SMD can 8×10": [8, 10]};
  for (const [k, [D, H]] of Object.entries(CANS)) PACKAGES[k] = {title: "SMD aluminium can " + k.slice(8), group: "SMD can", make: () => alucan(D, H)};
  for (const [k, D, H] of [["LED 3 mm", 3, 5.3], ["LED 5 mm", 5, 8.6]]) PACKAGES[k] = {title: "Through-hole " + k + ", 2.54 mm pitch", group: "Through-hole",
    make: () => radial({name: "LEDRD254W50D" + code(D) + "H" + code(H) + "N", D, pitch: 2.54, lead: .5, H, polar: true, flat: true})};
  for (const k of ["3225", "2016", "5032"]) PACKAGES["Crystal " + k] = {title: "SMD crystal " + k + (k === "5032" ? ", 2 pads" : ", 4 pads"), group: "Crystal", make: () => crystalFp(k), sub: k === "5032" ? "2pin" : "4pin"};
  PACKAGES["HC-49/U"] = {title: "HC-49/U through-hole", group: "Crystal", make: () => crystalFp("hc49"), sub: "2pin"};
  // Packages from the wizard's package families (footprint-packages.js), added 2026-11-19. Existing
  // packages keep their own lands, so existing generic ids and geometry do not change.
  const WIZ = (family, preset, title, group, extra) => ({title, group, make: () => wizard({family, preset}), ...extra});
  for (const [k, p] of [["Power 4×4", "Power 4040 (4×4×2)"], ["Power 5×5", "Power 5040 (5×5×4)"], ["Power 6×6", "Power 6045 (6×6×4.5)"], ["Power 7×7", "Power 7040 (7×7×4)"], ["Power 10×10", "Power 1040 (10×10×4)"]])
    PACKAGES[k] = WIZ("inductor", p, "Power inductor " + p.slice(6), "SMD power inductor");
  PACKAGES["Wire-wound 1008"] = WIZ("inductor", "Wire-wound 1008 (2520)", "Wire-wound chip 1008 (2520 metric)", "SMD chip");
  PACKAGES["SOD-123F"] = WIZ("sodfl", "SOD-123F", "SOD-123F (flat lead)", "SMD diode");
  PACKAGES["SOD-128"] = WIZ("sodfl", "SOD-128", "SOD-128 (flat lead)", "SMD diode");
  PACKAGES["PLCC-2 3528"] = WIZ("led", "PLCC-2 3528", "PLCC-2 3528", "SMD LED");
  PACKAGES["HC-49/S"] = WIZ("xtaltht", "HC-49/S", "HC-49/S through-hole, low profile", "Crystal", {sub: "2pin"});
  PACKAGES["Crystal 3215"] = WIZ("xtal", "2-pad 3215 (32.768 kHz)", "SMD crystal 3215, 2 pads (32.768 kHz)", "Crystal", {sub: "2pin"});
  PACKAGES["Fuse holder 5×20"] = WIZ("fuseholder", "5×20 holder, 22.5 mm", "5 × 20 mm fuse holder, 22.5 mm pitch", "Through-hole");
  PACKAGES["Fuse TR5"] = WIZ("fuseholder", "TR5 radial 5.08", "TR5 radial fuse, 5.08 mm pitch", "Through-hole");
  for (const d of [1, 1.5, 2]) PACKAGES["Pad D" + d.toFixed(1)] = {title: "SMD pad, " + d.toFixed(1) + " mm", group: "Test point", make: () => testpointFp(d)};
  PACKAGES["THT loop"] = {title: "Through-hole, 1.0 mm drill", group: "Test point", make: () => testpointFp(2, true)};
  for (const [k, t] of [["2-open", "2-pad, open"], ["2-bridged", "2-pad, bridged"], ["3-open", "3-pad, open"], ["3-bridged", "3-pad, bridged 1–2"]])
    PACKAGES["Solder jumper " + k] = {title: "Solder jumper, " + t, group: "Jumper", make: () => jumperFp(k), sub: k};

  // ------------------------------------------------------------------ families
  // fields: [parameter name, label, options | null (free text), default (string or fn(package))].
  const PCT = ["0.1%", "0.5%", "1%", "2%", "5%", "10%", "20%"];
  const RES_POWER = {"0201": "50 mW", "0402": "63 mW", "0603": "100 mW", "0805": "125 mW", "1206": "250 mW", "1210": "500 mW", "1812": "750 mW", "2010": "750 mW", "2512": "1 W",
    MicroMELF: "200 mW", MiniMELF: "250 mW", MELF: "1 W", "Axial DIN0204": "125 mW", "Axial DIN0207": "250 mW", "Axial DIN0309": "500 mW", "Axial DIN0411": "1 W", "Axial DIN0617": "2 W"};
  const RES_VOLT = {"0201": "25 V", "0402": "50 V", "0603": "75 V", "0805": "150 V", "1206": "200 V", "1210": "200 V", "1812": "200 V", "2010": "200 V", "2512": "200 V"};
  const CAP_VOLT = {"0201": "6.3 V", "0402": "16 V", "0603": "25 V", "0805": "50 V", "1206": "50 V", "1210": "50 V", "1812": "100 V", "2010": "100 V", "2512": "100 V"};
  const VOLTS = ["4 V", "6.3 V", "10 V", "16 V", "25 V", "35 V", "50 V", "63 V", "100 V", "200 V", "250 V", "400 V", "450 V", "500 V", "630 V", "1 kV"];
  const chips = list => list.filter(s => PACKAGES[s]);
  const FAMILIES = {
    resistor: {title: "Resistor", prefix: "R", category: "Resistors", value: "10 kΩ", styled: true, pkg: "0603",
      packages: [...CHIP_SIZES, "MicroMELF", "MiniMELF", "MELF", ...Object.keys(AXIAL).map(k => "Axial " + k)],
      fields: [["Tolerance", "Tolerance", PCT, "1%"], ["Power", "Power", null, p => RES_POWER[p] || "250 mW"], ["Voltage", "Max. voltage", null, p => RES_VOLT[p] || "250 V"],
        ["Temperature coefficient", "Temp. coefficient", ["25 ppm/K", "50 ppm/K", "100 ppm/K", "200 ppm/K"], "100 ppm/K"]]},
    capacitor: {title: "Capacitor", prefix: "C", category: "Capacitors", value: "100 nF", pkg: "0603",
      packages: [...CHIP_SIZES, ...Object.keys(DISC)],
      fields: [["Tolerance", "Tolerance", ["1%", "2%", "5%", "10%", "20%", "+80/−20%"], "10%"], ["Voltage", "Voltage", VOLTS, p => CAP_VOLT[p] || "50 V"],
        ["Dielectric", "Dielectric", ["C0G (NP0)", "X5R", "X6S", "X7R", "X7S", "X8R", "Y5V"], "X7R"], ["Temperature coefficient", "Temp. coefficient", null, ""]]},
    polarised: {title: "Polarised capacitor", short: "polarised capacitor", prefix: "C", category: "Capacitors", value: "10 µF", styled: true, pkg: "Tantalum 3528-21 (B)",
      packages: Object.keys(TANTALUM).map(k => "Tantalum " + k), polar: true,
      fields: [["Tolerance", "Tolerance", ["10%", "20%"], "20%"], ["Voltage", "Voltage", VOLTS, "16 V"], ["Dielectric", "Type", ["Tantalum (MnO₂)", "Polymer tantalum", "Polymer aluminium"], "Tantalum (MnO₂)"]]},
    electrolytic: {title: "Electrolytic capacitor", short: "electrolytic capacitor", prefix: "C", category: "Capacitors", value: "100 µF", styled: true, pkg: "Radial D6.3 P2.5",
      packages: [...Object.keys(RADIAL), ...Object.keys(CANS)], polar: true,
      fields: [["Tolerance", "Tolerance", ["10%", "20%"], "20%"], ["Voltage", "Voltage", VOLTS, "25 V"], ["Temperature rating", "Temp. rating", ["85 °C", "105 °C", "125 °C"], "105 °C"]]},
    inductor: {title: "Inductor", prefix: "L", category: "Inductors", value: "10 µH", pkg: "0805", packages: [...chips(["0402", "0603", "0805", "1206", "1210", "1812"]), "Wire-wound 1008", "Power 4×4", "Power 5×5", "Power 6×6", "Power 7×7", "Power 10×10"],
      fields: [["Tolerance", "Tolerance", ["5%", "10%", "20%", "30%"], "20%"], ["Current", "Rated current", null, ""]]},
    ferrite: {title: "Ferrite bead", short: "ferrite bead", prefix: "FB", category: "Inductors", value: "600 Ω @ 100 MHz", pkg: "0603", packages: chips(["0402", "0603", "0805", "1206"]),
      fields: [["Tolerance", "Tolerance", ["25%"], "25%"], ["Current", "Rated current", null, ""]]},
    diode: {title: "Diode", prefix: "D", category: "Diodes", value: "Rectifier", pkg: "SOD-123", subtypes: [["rectifier", "Rectifier"], ["schottky", "Schottky"], ["zener", "Zener"], ["tvs", "TVS"]],
      packages: ["SOD-123", "SOD-323", "SOD-523", "SMA", "SMB", "SMC", "MiniMELF", "MELF", ...Object.keys(DIODES), "SOD-123F", "SOD-128"], polar: true, textValue: true,
      fields: [["Voltage", "Voltage (Vᵣ / V₂)", null, ""], ["Current", "Current", null, ""]]},
    led: {title: "LED", prefix: "D", category: "Optoelectronics", value: "Red", pkg: "0603", packages: [...chips(["0402", "0603", "0805", "1206"]), "LED 3 mm", "LED 5 mm", "PLCC-2 3528"], polar: true, textValue: true,
      colours: ["Red", "Green", "Blue", "Yellow", "Amber", "Orange", "White", "Infrared", "Ultraviolet"],
      fields: [["Forward voltage", "Forward voltage", null, ""], ["Current", "Current", null, "20 mA"]]},
    crystal: {title: "Crystal", prefix: "Y", category: "Frequency control", value: "16 MHz", pkg: "Crystal 3225", packages: ["Crystal 3225", "Crystal 2016", "Crystal 5032", "HC-49/U", "Crystal 3215", "HC-49/S"],
      fields: [["Load capacitance", "Load capacitance", ["6 pF", "8 pF", "9 pF", "10 pF", "12 pF", "12.5 pF", "18 pF", "20 pF"], "10 pF"], ["Tolerance", "Frequency tolerance", ["10 ppm", "20 ppm", "30 ppm", "50 ppm"], "20 ppm"]]},
    fuse: {title: "Fuse", prefix: "F", category: "Circuit protection", value: "500 mA", styled: true, pkg: "1206", packages: [...chips(["0402", "0603", "0805", "1206", "1812"]), "Fuse holder 5×20", "Fuse TR5"],
      fields: [["Voltage", "Voltage", ["6 V", "16 V", "24 V", "32 V", "63 V", "125 V"], "32 V"], ["Type", "Type", ["Fast", "Slow", "PTC resettable"], "Fast"]]},
    testpoint: {title: "Test point", short: "test point", prefix: "TP", category: "Test points", value: "TP", pkg: "Pad D1.5", packages: ["Pad D1.0", "Pad D1.5", "Pad D2.0", "THT loop"], textValue: true, fields: []},
    jumper: {title: "Jumper", prefix: "JP", category: "Jumpers", value: "Open", pkg: "Solder jumper 2-open", packages: Object.keys(PACKAGES).filter(k => k.startsWith("Solder jumper")), textValue: true, fields: []}
  };
  const SHORT = {resistor: "res", capacitor: "cap", polarised: "cpol", electrolytic: "cel", inductor: "ind", ferrite: "fb", diode: "dio", led: "led", crystal: "xtal",
    fuse: "fuse", testpoint: "tp", jumper: "jp", connector: "conn"};
  const ORDER = ["resistor", "capacitor", "polarised", "electrolytic", "inductor", "ferrite", "diode", "led", "crystal", "fuse", "testpoint", "jumper"];
  // Other generators (connector-gen.js) register their family here: {make(spec) -> def, normalise(spec), ...}.
  const EXTRA = {};
  function registerFamily(name, impl) { EXTRA[name] = impl; SHORT[name] ||= name.slice(0, 4); }

  // ------------------------------------------------------------------ definitions
  function preference(project) {
    const s = project?.symbolPreferences?.resistor;
    return s === "ansi" ? "ansi" : "iec";
  }
  // The geometry-shaping parameters of a spec, normalised. Throws on anything unknown.
  function normalise(spec, project) {
    if (!obj(spec)) fail("Give the generic part parameters.");
    if (EXTRA[spec.family]) return EXTRA[spec.family].normalise(spec, project);
    const f = FAMILIES[spec.family] || fail("Unknown generic part family " + String(spec.family).slice(0, 40) + ". Use one of: " + [...ORDER, ...Object.keys(EXTRA)].join(", ") + ".");
    const pkg = spec.package ?? f.pkg;
    if (!f.packages.includes(pkg)) fail("A " + (f.short || f.title.toLowerCase()) + " has no package " + String(pkg).slice(0, 60) + ". Packages: " + f.packages.join(", ") + ".");
    const out = {family: spec.family, package: pkg};
    if (f.styled) out.style = spec.style === "ansi" || spec.style === "iec" ? spec.style : preference(project);
    if (f.subtypes) out.subtype = f.subtypes.some(([k]) => k === spec.subtype) ? spec.subtype : f.subtypes[0][0];
    const sub = PACKAGES[pkg].sub;
    if (sub) out.subtype = sub;
    return out;
  }
  const keyOf = n => canonical({v: VERSION, ...n});
  const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24);
  function idOf(n) { return "gen-" + SHORT[n.family] + "-" + slug(n.package || n.type || "") + "-" + fnv(keyOf(n)); }
  // A fresh, deterministic definition for normalised parameters.
  function make(spec, project) {
    const n = normalise(spec, project);
    if (EXTRA[n.family]) return finishDef(EXTRA[n.family].make(n), n);
    const f = FAMILIES[n.family], P = PACKAGES[n.package];
    if (!L()?.buildSymbol || !W()?.generate) fail("Generic parts need the library modules (library-panel.js, footprint-wizard.js).");
    const s = SYMBOLS[n.family](n.style, n.subtype);
    const fp = P.make(n.family);
    const sub = f.subtypes?.find(([k]) => k === n.subtype)?.[1];
    const what = (sub ? sub + " " + (f.short || f.title.toLowerCase()) : f.title);
    // Solder jumpers and SMD test pads are copper only: a copper-thin 3D body and no BOM line.
    const flat = n.family === "jumper" || (n.family === "testpoint" && n.package !== "THT loop");
    if (flat) fp.height = .035;
    const def = {id: idOf(n), name: (sub ? sub + " diode" : f.title) + ", " + n.package, category: f.category, prefix: f.prefix, value: f.value, ...(flat ? {excludeFromBOM: true} : {}),
      description: "Generic " + what.toLowerCase().replace(/^led/, "LED") + ", " + P.title + ". Value and ratings are set on each part; bind a manufacturer part before ordering.",
      package: n.package, symbol: s.symbol, ...(s.schDrawing ? {schDrawing: s.schDrawing} : {}), footprint: fp};
    return finishDef(def, n, f.fields.map(x => x[0]));
  }
  function finishDef(def, n, fields) {
    def.id = idOf(n);
    def.generic = {v: VERSION, ...n, fields: fields || def.generic?.fields || [], digest: ""};
    def.generic.digest = digestOf(def);
    return def;
  }
  const isGeneric = d => !!d && obj(d.generic) && typeof d.generic.family === "string";
  const customised = d => isGeneric(d) && d.generic.digest !== digestOf(d);
  // The project's definition for these parameters, added if missing. Returns the def.
  function ensure(project, spec) {
    const def = make(spec, project), have = project.library.find(d => d.id === def.id);
    if (have) return have;
    project.library.push(def);
    return def;
  }
  // Generic definitions no part uses any more (after an edit retargeted the last one).
  function prune(project, keep = new Set()) {
    const used = new Set();
    for (const d of project.documents) for (const i of d.items || []) if (i.kind === "part") used.add(i.def);
    if (Array.isArray(project.componentFamilies)) for (const family of project.componentFamilies) {
      if (Array.isArray(family?.members)) for (const member of family.members) used.add(member?.defId);
    }
    const before = project.library.length;
    project.library = project.library.filter(d => !isGeneric(d) || used.has(d.id) || keep.has(d.id) || customised(d));
    return before - project.library.length;
  }

  // ------------------------------------------------------------------ per-part values
  function fieldsOf(def) {
    if (EXTRA[def?.generic?.family]?.fields) return EXTRA[def.generic.family].fields(def);
    return FAMILIES[def?.generic?.family]?.fields || [];
  }
  function defaults(n) {
    const f = FAMILIES[n.family];
    if (!f) return {};
    const out = {};
    for (const [k, , , d] of f.fields) { const v = typeof d === "function" ? d(n.package) : d; if (v) out[k] = v; }
    return out;
  }
  // part.value text for a family: numeric families are parsed and written canonically.
  function valueText(family, raw) {
    if (!UNIT[family]) {
      const t = String(raw ?? "").trim().slice(0, 100);
      return t || null;
    }
    const p = parseValue(raw, family);
    if (!p) return null;
    return family === "ferrite" ? p.text + " @ 100 MHz" : p.text;
  }
  function describe(def, value, params) {
    const g = def.generic, f = FAMILIES[g.family];
    const sub = f?.subtypes?.find(([k]) => k === g.subtype)?.[1];
    const name = EXTRA[g.family]?.title?.(def) || (sub ? sub + " diode" : f?.title || def.name);
    const bits = [name, value, ...fieldsOf(def).map(([k]) => params?.[k]).filter(Boolean), g.package || def.footprint?.name].filter(Boolean);
    const seen = new Set();
    return bits.filter(b => { const k = String(b).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; }).join(", ");
  }
  function applyValues(part, def, value, params) {
    const g = def.generic, fields = fieldsOf(def).map(f => f[0]);
    const out = {};
    // Bound manufacturer fields and the user's own parameters stay; generic fields are rewritten in order.
    const own = {...(part.parameters || {})};
    for (const k of [...fields, "Description"]) delete own[k];
    for (const k of fields) { const v = params[k]; if (v != null && String(v).trim()) out[k] = String(v).trim().slice(0, 200); }
    if (value != null) part.value = value;
    out.Description = describe(def, part.value, out);
    part.parameters = {...out, ...own};
    void g;
    return part;
  }

  // ------------------------------------------------------------------ place and edit
  function place(project, doc, at, o = {}) {
    if (doc?.kind !== "schematic") fail("Generic parts are placed on a schematic sheet.");
    const def = ensure(project, o);
    const family = def.generic.family;
    const value = o.value != null ? valueText(family, o.value) : (EXTRA[family]?.value?.(def) ?? FAMILIES[family]?.value ?? def.value);
    if (value == null) fail("Can't read the value " + JSON.stringify(String(o.value)).slice(0, 40) + ". " + hint(o.value, family).message);
    const p = [A().snap(+at?.[0] || 0, G), A().snap(+at?.[1] || 0, G)];
    const part = A().instantiate(project, def, p, o.angle || 0);
    if (o.designator) part.ref = String(o.designator).slice(0, 64);
    applyValues(part, def, value, {...defaults(def.generic), ...(o.parameters || {})});
    doc.items.push(part);
    return {def, part};
  }
  // Parts that are one component with `part`: itself, its gates (same designator) and its board copies (same link).
  function family(project, part) {
    const out = [];
    for (const d of project.documents) for (const i of d.items || []) {
      if (i.kind !== "part" || i.def !== part.def) continue;
      if (i === part || (part.link && i.link === part.link) || (part.ref && !String(part.ref).includes("?") && i.ref === part.ref && d.kind === "schematic")) out.push([d, i]);
    }
    return out;
  }
  // Pins of the old definition that would disappear and have something connected.
  function losses(project, part, next) {
    const old = project.library.find(d => d.id === part.def);
    const keep = new Set([...(next.symbol?.pins || []), ...(next.footprint?.pads || [])].map(p => String(p.number)));
    const lost = [...new Set([...(old?.symbol?.pins || []), ...(old?.footprint?.pads || [])].map(p => String(p.number)))].filter(n => !keep.has(n));
    if (!lost.length) return {lost: [], connected: [], gates: []};
    const defs = new Map(project.library.map(d => [d.id, d])), connected = new Set();
    for (const [d, i] of family(project, part)) {
      if (d.kind === "schematic") {
        const net = A().connectivity(d, defs);
        const counts = new Map(); for (const v of net.byPin.values()) counts.set(v, (counts.get(v) || 0) + 1);
        for (const n of lost) { const k = net.byPin.get(i.id + "/" + n); if (k && (!A().isAutoNetName(k) || counts.get(k) > 1 || net.nets.some(x => x.name === k && x.wires))) connected.add(n); }
      } else for (const n of lost) if (i.pinNets?.[n]) connected.add(n);
    }
    const parts = Math.max(1, next.symbol?.parts || 1);
    const gates = family(project, part).filter(([d, i]) => d.kind === "schematic" && (i.unit || i.part || 1) > parts).map(([, i]) => i.ref + String.fromCharCode(64 + (i.unit || i.part)));
    return {lost, connected: [...connected].sort((a, b) => a.localeCompare(b, "en", {numeric: true})), gates};
  }
  // Move one component (all its gates and board copies) to another definition. Schematic wires
  // follow pins that moved (matched by number); nets of pads that no longer exist are dropped.
  function retarget(project, part, def) {
    const Lib = L(), report = {parts: 0, rewired: 0, stubs: 0, dropped: 0, removedGates: 0};
    const oldDef = project.library.find(d => d.id === part.def);
    if (!project.library.some(d => d.id === def.id)) project.library.push(def);
    const members = family(project, part);
    const beforeDefs = new Map(project.library.map(d => [d.id, d]));
    const pads = new Set((def.footprint?.pads || []).map(p => String(p.number))), parts = Math.max(1, def.symbol?.parts || 1);
    const byDoc = new Map();
    for (const [d, i] of members) { if (!byDoc.has(d)) byDoc.set(d, []); byDoc.get(d).push(i); }
    for (const [d, list] of byDoc) {
      const moved = new Map(), froms = new Map(), touched = new Set(), movedPins = [];
      const sch = d.kind === "schematic", netBefore = sch ? A().connectivity(d, beforeDefs).byPin : null;
      const wiresBefore = sch ? d.items.filter(i => i.kind === "wire").map(w => [w, w.points.map(q => q.slice())]) : [];
      for (const i of list) {
        if (d.kind === "schematic" && (i.unit || i.part || 1) > parts) { d.items.splice(d.items.indexOf(i), 1); report.removedGates++; continue; }
        if (d.kind === "schematic" && oldDef?.symbol && def.symbol) {
          const before = A().pins(i, oldDef, "schematic");
          i.def = def.id;
          const after = new Map(A().pins(i, def, "schematic").map(p => [String(p.number), p.at]));
          for (const p of before) { const next = after.get(String(p.number)); if (next && !A().same(p.at, next)) { moved.set(A().pointKey(p.at), next); froms.set(A().pointKey(p.at), p.at); movedPins.push([i, p, next]); } }
        } else i.def = def.id;
        if (i.pinNets) for (const k of Object.keys(i.pinNets)) if (!pads.has(k)) { delete i.pinNets[k]; report.dropped++; }
        touched.add(i.id); report.parts++;
      }
      if (moved.size && Lib?.rewire) {
        const r = Lib.rewire(d, moved, {froms, skip: touched, defs: beforeDefs, detail: true});
        // Rerouted wire ends can run over other pins (a pin that moved to the other side). When any
        // net of the part changed, undo the reroute and join each moved pin by net label instead.
        if (sameNets(netBefore, A().connectivity(d, new Map(project.library.map(x => [x.id, x]))).byPin, list)) { report.rewired += r.wires; report.stubs += r.stubs; }
        else {
          const kept = new Set(wiresBefore.map(([w]) => w));
          d.items = d.items.filter(i => i.kind !== "wire" || kept.has(i));
          for (const [w, pts] of wiresBefore) w.points = pts;
          report.labelled = (report.labelled || 0) + labelMoved(d, movedPins, netBefore, def);
        }
      }
    }
    return report;
  }
  // Same partition of the part's pins into nets (pins that no longer exist ignored).
  function sameNets(before, after, list) {
    const ids = new Set(list.map(i => i.id + "/")), mine = k => [...ids].some(p => k.startsWith(p));
    const groups = m => { const by = new Map(); for (const [k, n] of m) if (mine(k)) { if (!by.has(n)) by.set(n, []); by.get(n).push(k); } return by; };
    const a = groups(before), b = groups(after), netOf = (m, k) => m.get(k);
    for (const [k] of before) if (mine(k) && after.has(k)) {
      const x = a.get(netOf(before, k)).filter(q => after.has(q)).sort().join(), y = b.get(netOf(after, k)).filter(q => before.has(q)).sort().join();
      if (x !== y) return false;
    }
    for (const [k] of after) if (mine(k) && !before.has(k) && b.get(netOf(after, k)).some(q => before.has(q))) return false;
    return true;
  }
  const DIRS = {left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1]};
  function labelMoved(d, movedPins, netBefore, def) {
    let n = 0;
    for (const [i, p, next] of movedPins) {
      const net = netBefore.get(i.id + "/" + p.number);
      if (!net) continue;
      const name = A().isAutoNetName(net) ? String(i.ref + "_" + p.number).replace(/[^A-Za-z0-9_+-]/g, "_") : net;
      const pin = def.symbol.pins.find(q => String(q.number) === String(p.number)), dir = DIRS[pin?.orientation] || [-1, 0];
      const end = A().world([pin.x + dir[0] * G, pin.y + dir[1] * G], i).map(r6);
      d.items.push({id: A().id(), kind: "netlabel", text: name, x: r6(p.at[0]), y: r6(p.at[1])},
        {id: A().id(), kind: "wire", points: [next.map(r6), end]}, {id: A().id(), kind: "netlabel", text: name, x: end[0], y: end[1]});
      n++;
    }
    return n;
  }
  // A definition a newer generator made (generic.v above VERSION) is kept as it is: this build can't
  // rebuild it without losing what that version added.
  function newerGuard(def) {
    if (typeof def.generic?.v === "number" && def.generic.v > VERSION) fail("The generic part " + (def.name || def.id) + " was made by a newer version of Waffle. This version keeps it as it is and can't regenerate or edit it.");
  }
  // change: {value, parameters, package, style, subtype, ...family parameters}. Returns a report.
  function edit(project, part, change = {}) {
    const def = project.library.find(d => d.id === part?.def);
    if (!isGeneric(def)) fail("That part is not a generic part.");
    newerGuard(def);
    const g = def.generic, report = {designator: part.ref, def_id: def.id, regenerated: false};
    const shape = EXTRA[g.family] ? EXTRA[g.family].shapeKeys : ["package", "style", "subtype"];
    const asked = shape.filter(k => change[k] !== undefined && change[k] !== g[k]);
    let target = def;
    if (asked.length) {
      const spec = {...g, ...Object.fromEntries(shape.map(k => [k, change[k] !== undefined ? change[k] : g[k]]))};
      delete spec.digest; delete spec.fields; delete spec.v;
      const next = make(spec, project);
      if (next.id !== def.id) {
        const loss = losses(project, part, next);
        report.removed_pins = loss.lost; report.disconnected_pins = loss.connected; report.removed_gates = loss.gates;
        if ((loss.connected.length || loss.gates.length) && !change.force) {
          report.refused = true;
          report.message = (loss.connected.length ? "Pins " + loss.connected.join(", ") + " of " + part.ref + " are connected and would be removed. " : "") +
            (loss.gates.length ? "Parts " + loss.gates.join(", ") + " would be removed. " : "") + "Pass force to apply anyway.";
          return report;
        }
        target = project.library.find(d => d.id === next.id) || next;
        Object.assign(report, retarget(project, part, target));
        report.def_id = target.id; report.regenerated = true;
      }
    }
    const fam = target.generic.family;
    let value = null;
    if (change.value !== undefined) {
      value = valueText(fam, change.value);
      if (value == null) fail("Can't read the value " + JSON.stringify(String(change.value)).slice(0, 40) + ". " + hint(change.value, fam).message);
    }
    const params = {};
    for (const [k] of fieldsOf(target)) params[k] = part.parameters?.[k];
    // A new package brings its own default ratings unless the part had other values.
    if (report.regenerated && change.package !== undefined) {
      const was = defaults(def.generic), now = defaults(target.generic);
      for (const k of Object.keys(now)) if (params[k] == null || params[k] === was[k]) params[k] = now[k];
    }
    if (obj(change.parameters)) for (const [k, v] of Object.entries(change.parameters)) if (fieldsOf(target).some(f => f[0] === k)) params[k] = v == null ? "" : String(v);
    for (const [d, i] of family(project, part)) { void d; applyValues(i, target, value ?? (i.value === def.value ? target.value : i.value), params); }
    if (report.regenerated) report.pruned = prune(project);
    report.value = part.value;
    return report;
  }
  // Regenerate a definition from its parameters (discards hand edits); parts keep their pins.
  function regenerate(project, defId) {
    const def = project.library.find(d => d.id === defId);
    if (!isGeneric(def)) fail("That definition is not a generic part.");
    newerGuard(def);
    const spec = {...def.generic}; delete spec.digest; delete spec.fields; delete spec.v;
    const next = make(spec, project);
    if (next.id !== def.id) next.id = def.id;
    next.generic.digest = digestOf(next);
    const k = project.library.indexOf(def);
    project.library[k] = next;
    if (L()?.updateParts) L().updateParts(project, next, {oldDef: def});
    return next;
  }
  // Every generic definition: whether it matches its parameters ("current"), was edited by hand
  // ("customised") or was made by another generator version ("other-version").
  function check(project) {
    return (project?.library || []).filter(isGeneric).map(d => {
      let state = "current";
      if (d.generic.v !== VERSION) state = "other-version";
      else if (customised(d)) state = "customised";
      else { try { const spec = {...d.generic}; delete spec.digest; delete spec.fields; delete spec.v; if (digestOf(make(spec, project)) !== d.generic.digest) state = "stale"; } catch { state = "unknown"; } }
      return {def_id: d.id, family: d.generic.family, package: d.generic.package || null, state};
    });
  }
  // Detach: the part becomes an ordinary library definition (its own copy, no generator link).
  function detach(project, part) {
    const def = project.library.find(d => d.id === part?.def);
    if (!isGeneric(def)) fail("That part is not a generic part.");
    const copy = clone(def);
    delete copy.generic;
    copy.id = A().id();
    copy.name = def.name + " (" + part.ref + ")";
    project.library.push(copy);
    for (const [, i] of family(project, part)) i.def = copy.id;
    prune(project);
    return copy;
  }

  // ------------------------------------------------------------------ manufacturer parts
  const MPN_KEYS = /^(mpn|manufacturer part( number|#| no\.?)?|mfr\.? ?part( number|#)?|manufacturer pn|part number)$/i;
  const MAKER_KEYS = /^(manufacturer|mfr|mfg|maker)$/i;
  const SUPPLIER_KEYS = /^(lcsc ?#?|lcsc part( number)?|supplier( \d)?|supplier part( number)?( \d)?|digi-?key( part number| pn)?|mouser( part number| pn)?)$/i;
  const paramOf = (p, re) => { for (const [k, v] of Object.entries(p || {})) if (re.test(k.trim()) && String(v ?? "").trim()) return [k, String(v).trim()]; return null; };
  // Library parts that have a manufacturer part number and fit this generic part: same family
  // prefix, same package (footprint name or package parameter) and, for numeric families, the same value.
  function candidates(project, part, o = {}) {
    const def = project.library.find(d => d.id === part?.def);
    if (!isGeneric(def)) fail("That part is not a generic part.");
    const fam = def.generic.family, pkg = String(def.generic.package || "").toLowerCase();
    const want = UNIT[fam] ? parseValue(part.value, fam)?.value : null;
    const pools = [{name: "Project library", defs: project.library}];
    try { for (const lib of L()?.sourceStore?.list?.() || []) pools.push({name: lib.name, library: lib.id, defs: lib.defs}); } catch { /* storage unavailable */ }
    for (const extra of o.pools || []) pools.push(extra);
    const out = [], seen = new Set();
    for (const pool of pools) for (const d of pool.defs || []) {
      if (!d || isGeneric(d) || !obj(d.parameters)) continue;
      const mpn = paramOf(d.parameters, MPN_KEYS);
      if (!mpn) continue;
      if ((d.prefix || "").toUpperCase() !== def.prefix.toUpperCase()) continue;
      const hay = [d.package, d.footprint?.name, d.name, d.parameters.Package, d.parameters.Footprint, d.parameters["Case/Package"]].filter(Boolean).join(" ").toLowerCase();
      const code = pkg.match(/^\d{4}$/) ? pkg : pkg.split(/\s+/).pop();
      if (pkg && !hay.includes(pkg) && !(code && new RegExp("(^|[^0-9])" + code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^0-9]|$)").test(hay)) &&
        !(METRIC[pkg] && hay.includes(METRIC[pkg]))) continue;
      if (want != null) {
        const v = parseValue(d.parameters.Value ?? d.value, fam)?.value;
        if (v == null || Math.abs(v - want) > want * 1e-6) continue;
      }
      const key = (mpn[1] + "|" + (paramOf(d.parameters, MAKER_KEYS)?.[1] || "")).toUpperCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({def_id: d.id, source: pool.name, library: pool.library || null, mpn: mpn[1], manufacturer: paramOf(d.parameters, MAKER_KEYS)?.[1] || "",
        name: d.name, value: d.parameters.Value ?? d.value ?? "", def: d});
    }
    return out;
  }
  // Copy the chosen candidate's own manufacturer and supplier fields onto the part (and its gates
  // and board copies). Only a candidate from candidates() is accepted.
  function bind(project, part, defId, o = {}) {
    const c = candidates(project, part, o).find(x => x.def_id === defId);
    if (!c) fail("That library part is not a match for " + part.ref + " (it needs a manufacturer part number, the same package and value).");
    const copy = {};
    for (const [k, v] of Object.entries(c.def.parameters)) if (MPN_KEYS.test(k.trim()) || MAKER_KEYS.test(k.trim()) || SUPPLIER_KEYS.test(k.trim())) copy[k] = String(v);
    for (const [, i] of family(project, part)) {
      unbindOne(i);
      i.parameters = {...(i.parameters || {}), ...copy};
      i.boundTo = {def: c.def_id, source: c.source, ...(c.library ? {library: c.library} : {})};
    }
    return {designator: part.ref, mpn: c.mpn, manufacturer: c.manufacturer, source: c.source, fields: Object.keys(copy)};
  }
  function unbindOne(i) {
    if (!i.boundTo && !i.parameters) return;
    for (const k of Object.keys(i.parameters || {})) if (MPN_KEYS.test(k.trim()) || MAKER_KEYS.test(k.trim()) || SUPPLIER_KEYS.test(k.trim())) delete i.parameters[k];
    delete i.boundTo;
  }
  function unbind(project, part) { for (const [, i] of family(project, part)) unbindOne(i); return {designator: part.ref}; }

  // ------------------------------------------------------------------ headless (MCP)
  const clip = (v, n = 200) => String(v ?? "").slice(0, n);
  function row(project, def, parts) {
    const g = def.generic;
    return {def_id: def.id, family: g.family, package: g.package ?? null, style: g.style ?? null, subtype: g.subtype ?? null, state: check({library: [def]})[0].state,
      pins: def.symbol?.pins?.length || 0, pads: def.footprint?.pads?.length || 0, footprint: def.footprint?.name || null, height: def.footprint?.height ?? null,
      ...(EXTRA[g.family]?.summary ? EXTRA[g.family].summary(def) : {}), parts: parts.length};
  }
  function findPart(project, a) {
    const want = a.designator != null ? String(a.designator) : null;
    for (const d of project.documents) for (const i of d.items || []) {
      if (i.kind !== "part") continue;
      if ((a.part_id && i.id === a.part_id) || (want && i.ref === want && (d.kind === "schematic" || !a.part_id))) return i;
    }
    fail("No part " + clip(a.part_id || want, 64) + ".");
  }
  function partRow(i, def) {
    return {part_id: i.id, designator: i.ref, value: i.value, unit: i.unit || null, def_id: def.id, bound: !!i.boundTo, parameters: {...(i.parameters || {})}};
  }
  function headless(op, a = {}, ctx) {
    // Placeholders (placeholder-parts.js): resolve to a library component, or revert to the placeholder.
    const PH = globalThis.AtriumPlaceholders;
    if (op === "edit" && PH && (a.resolve_def_id || a.revert_placeholder)) {
      const r = PH.headless(a.revert_placeholder ? "revert" : "resolve", a, ctx), {message, unused, ...rest} = r;
      return {...rest, refused: !!r.refused, unused_pins: (unused || []).length, untrusted_design_text: {...(message ? {message} : {}), unused: (unused || []).slice(0, 64)}};
    }
    const p = op === "list" ? ctx.project() : ctx.mutable();
    const defs = new Map(p.library.map(d => [d.id, d]));
    if (op === "list") {
      const rows = [];
      for (const def of p.library.filter(isGeneric)) {
        const parts = [];
        for (const d of p.documents) for (const i of d.items || []) if (i.kind === "part" && i.def === def.id && d.kind === "schematic") parts.push(partRow(i, def));
        rows.push({...row(p, def, parts), untrusted_design_text: {name: def.name, parts: parts.slice(0, 500)}});
      }
      const out = {generic_parts: rows, families: [...ORDER, ...Object.keys(EXTRA)]};
      if (a.family && FAMILIES[a.family]) out.packages = FAMILIES[a.family].packages;
      if (a.designator || a.part_id) {
        const part = findPart(p, a), def = defs.get(part.def);
        if (!isGeneric(def)) fail("That part is not a generic part.");
        if (def.generic.role === "placeholder" && PH) {
          // Existing library components whose pins cover every connected function; never a part number.
          const list = a.candidates ? PH.candidates(p, part).slice(0, 50) : [];
          out.part = {...row(p, def, [part]), ...(a.candidates ? {resolve_candidates: list.map(c => ({def_id: c.def_id, library: c.library, mapped: c.mapped, unused: c.unused, inferred: c.inferred}))} : {}),
            untrusted_design_text: {...partRow(part, def), ...(a.candidates ? {resolve_candidates: list.map(c => ({def_id: c.def_id, name: c.name, source: c.source, footprint: c.footprint, mpn: c.mpn}))} : {})}};
          return out;
        }
        out.part = {...row(p, def, [part]), ...(a.candidates ? {candidates: candidates(p, part).map(({def, ...c}) => ({def_id: c.def_id, source: c.source}))} : {}),
          untrusted_design_text: {...partRow(part, def), ...(a.candidates ? {candidates: candidates(p, part).map(({def, ...c}) => c)} : {})}};
      }
      return out;
    }
    if (op === "place") {
      const doc = a.document_id != null ? p.documents.find(d => d.id === a.document_id || d.name === a.document_id) : p.documents.find(d => d.kind === "schematic");
      if (!doc) fail("The project has no schematic" + (a.document_id != null ? " " + clip(a.document_id, 64) : "") + ".");
      if (a.designator && p.documents.some(d => d.items.some(i => i.kind === "part" && i.ref === a.designator))) fail("Designator " + clip(a.designator, 64) + " is already used.");
      const spec = {...(a.parameters_of_family || {}), ...a};
      const {def, part} = place(p, doc, [a.x ?? 0, a.y ?? 0], {...spec, parameters: a.parameters});
      ctx.touched();
      return {document_id: doc.id, ...row(p, def, [part]), untrusted_design_text: partRow(part, def)};
    }
    if (op === "edit") {
      const part = findPart(p, a);
      const def = defs.get(part.def);
      if (!isGeneric(def)) fail("That part is not a generic part.");
      let r;
      if (a.unbind) r = unbind(p, part);
      else if (a.bind_def_id) r = bind(p, part, a.bind_def_id);
      else if (a.detach) { const c = detach(p, part); r = {designator: part.ref, def_id: c.id, detached: true}; }
      else if (a.regenerate) { const d = regenerate(p, part.def); r = {designator: part.ref, def_id: d.id, regenerated: true}; }
      else r = edit(p, part, a);
      if (!r.refused) ctx.touched();
      const now = defs.get(part.def) || p.library.find(d => d.id === part.def);
      const {message, ...rest} = r;
      return {...rest, ...(message ? {} : {}), refused: !!r.refused, ...(now && isGeneric(now) ? {part: row(p, now, [part])} : {}),
        untrusted_design_text: {...(message ? {message} : {}), ...(now ? partRow(part, now) : {})}};
    }
    fail("Unknown generic part operation " + clip(op, 40) + ".");
  }

  // ------------------------------------------------------------------ BOM key (bom.js reads def.generic.fields)
  const bomKey = (part, def) => isGeneric(def) ? JSON.stringify([part.value, ...fieldsOf(def).map(([k]) => part.parameters?.[k] ?? "")]) : null;

  const api = {VERSION, FAMILIES, PACKAGES, ORDER, SERIES, UNIT, parseValue, formatValue, rkm, series, seriesFor, nearest, hint,
    normalise, make, ensure, prune, isGeneric, customised, digestOf, idOf, place, edit, retarget, losses, family, regenerate, check, detach,
    candidates, bind, unbind, defaults, fieldsOf, valueText, applyValues, describe, headless, bomKey, registerFamily, canonical, hash, fnv,
    dress, thtLand, silkAround, smd, tht, silk, box, SILK_W};
  return api;
})();
