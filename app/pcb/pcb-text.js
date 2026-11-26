"use strict";
if (!globalThis.AtriumPCBAppearance && typeof require === "function") require("./pcb-appearance.js");
if (!globalThis.AtriumStrokeFont && typeof require === "function") require("../canvas/stroke-font.js");

// PCB text, modelled on Altium's String object. One layout engine feeds the
// canvas, Gerber (fab-outputs) and KiCad export, so what is drawn is what is
// plotted.
//
// Item fields (all optional except text; existing labels keep working):
//   text        string, "\n" separates lines
//   size        text height in mm (cap height), default 0.75
//   fontWidth   nominal horizontal font size in mm, default equal to size
//   width       stroke width in mm, default max(0.1, size / 6)
//   angle       rotation in degrees (clockwise on screen, as everywhere)
//   font        "stroke" | "truetype" | "barcode"
//   strokeFont  "default" | "sans" | "serif" | "kicad"
//   family, bold, italic                      (TrueType; italic also slants stroke text)
//   justify     "top-left" ... "bottom-right" (9 anchors; bottom = last baseline)
//               legacy `align` ("left" | "center" | "right") is honoured
//   mirrored    true / false; absent = mirrored on bottom-side layers
//   lineSpacing line pitch as a multiple of the height, default 5/3
//   inverted    knockout: text cut out of a filled rectangle; `margin` mm
//   frame       rectangle outline around the text at `margin`
//   barcode     {type:"code39"|"code128"|"qr", module, quiet, ratio, text, ecc}
//
// Local coordinates are millimetres relative to the anchor, Y down, before
// rotation. layout() returns stroke polylines and polygons with holes;
// toPrimitives() returns world-space Gerber strokes and bridged regions.
globalThis.AtriumPCBText = (() => {
  const A = () => globalThis.Atrium;
  const PCB = globalThis.AtriumPCBAppearance;
  // TrueType, barcodes and knockout (pcb-text-rich.js, lazy): requested on first use; AtriumLazy
  // has the editor redraw once it arrives. must: throw when it is not loaded.
  let richRequested = false;
  function richText(must = false) {
    const R = globalThis.AtriumPCBTextRich;
    if (R) return R;
    if (must) throw Error("pcb-text-rich.js is not loaded.");
    if (!richRequested && globalThis.AtriumLazy) { richRequested = true; AtriumLazy.need("AtriumPCBTextRich").catch(() => { richRequested = false; }); }
    return null;
  }

  const {CAP, ADVANCE, GLYPH, textUnits, glyphSource, parse, glyphs: asciiGlyphs} = globalThis.AtriumStrokeFont;

  // Symbols common on boards. Superscripts sit between 3.6 and 6.5.
  const extraSource = {
    "Ω":"0 0 1.4 0 1.4 1 0.4 2 0 3.2 0 4.8 1 6 3 6 4 4.8 4 3.2 3.6 2 2.6 1 2.6 0 4 0",
    "µ":"0 -2 0 4,0 1 1 0 3 0 4 1,4 4 4 0", "±":"2 5.4 2 1.8,0 3.6 4 3.6,0 0.4 4 0.4",
    "°":"1.4 6 2.6 6 3 5.6 3 4.6 2.6 4.2 1.4 4.2 1 4.6 1 5.6 1.4 6", "×":"0.6 4.4 3.4 1.6,0.6 1.6 3.4 4.4",
    "÷":"0 3 4 3,2 5 2 4.6,2 1.4 2 1", "²":"1 6 1.6 6.5 2.4 6.5 3 6 3 5.4 1 3.6 3 3.6",
    "³":"1 6.1 1.6 6.5 2.4 6.5 3 6.1 3 5.6 2.4 5.1 3 4.6 3 4 2.4 3.6 1.6 3.6 1 4,1.8 5.1 2.4 5.1",
    "¹":"1.4 6 2 6.5 2 3.6,1.4 3.6 2.6 3.6", "·":"2 3.2 2 2.8", "•":"1.6 3.4 2.4 3.4 2.4 2.6 1.6 2.6 1.6 3.4,2 3.2 2 2.8",
    "π":"0 4 4 4,1.2 4 1.2 0,3 4 3 0.6 3.5 0", "Δ":"0 0 2 6 4 0 0 0", "λ":"0 0 2 3.3,0.6 6 1.2 6 4 0",
    "Φ":"2 6 2 0,1 1.5 0 2.5 0 3.5 1 4.5 3 4.5 4 3.5 4 2.5 3 1.5 1 1.5", "φ":"2 5 2 -2,1 0 0 1 0 3 1 4 3 4 4 3 4 1 3 0 1 0",
    "θ":"1 0 0 1 0 5 1 6 3 6 4 5 4 1 3 0 1 0,0 3 4 3", "α":"4 0 3.4 0.4 2.6 3.6 2 4 1 4 0 3 0 1 1 0 2 0 2.6 0.4 3.4 3.6 4 4",
    "β":"0 -2 0 5 1 6 2.6 6 3.4 5.2 3.4 4.2 2.4 3.4 1.2 3.4,2.4 3.4 4 2.4 4 1 3 0 1.6 0 0 0.8",
    "σ":"4 4 1 4 0 3 0 1 1 0 3 0 4 1 4 3 3 4", "τ":"0 4 4 4,2 4 2 1 2.6 0 3.4 0",
    "∞":"2 3 1.2 3.8 0.4 3.8 0 3.4 0 2.6 0.4 2.2 1.2 2.2 2.8 3.8 3.6 3.8 4 3.4 4 2.6 3.6 2.2 2.8 2.2 2 3",
    "≤":"4 5.4 0 3.8 4 2.2,0 0.8 4 0.8", "≥":"0 5.4 4 3.8 0 2.2,0 0.8 4 0.8", "≈":"0 3.6 1 4.4 3 3.6 4 4.4,0 1.8 1 2.6 3 1.8 4 2.6",
    "≠":"0 4 4 4,0 2 4 2,3.2 5.6 0.8 0.4", "√":"0 2.6 0.8 3 2 0 3.4 6.5 4.4 6.5",
    "€":"4 5 3 6 1.4 6 0.6 5 0.6 1 1.4 0 3 0 4 1,0 3.6 2.8 3.6,0 2.4 2.8 2.4", "£":"3.8 5.2 3 6 2 6 1.2 5.2 1.2 0.8 0.4 0 4 0,0 3 3 3",
    "¥":"0 6 2 3 4 6,2 3 2 0,0.6 2.4 3.4 2.4,0.6 1.2 3.4 1.2",
    "©":"1 0 0 1 0 5 1 6 3 6 4 5 4 1 3 0 1 0,2.8 3.8 2.4 4.2 1.6 4.2 1.2 3.8 1.2 2.2 1.6 1.8 2.4 1.8 2.8 2.2",
    "®":"1 0 0 1 0 5 1 6 3 6 4 5 4 1 3 0 1 0,1.4 1.6 1.4 4.4 2.4 4.4 2.8 4 2.8 3.4 2.4 3 1.4 3,2.2 3 2.8 1.6",
    "™":"0 6 2 6,1 6 1 4,2.2 4 2.2 6 3.1 5 4 6 4 4", "§":"3.6 5.6 2.8 6 1.2 6 0.4 5.4 0.8 4.6 3.2 3.4 3.6 2.6 3.2 1.6,0.8 4.4 0.4 3.6 0.8 2.6 3.2 1.4 3.6 0.6 2.8 0 1.2 0 0.4 0.4",
    "¶":"4 6 4 -1,2.6 6 2.6 -1,4 6 1.4 6 0.4 5 0.4 4 1.4 3 2.6 3", "†":"2 6 2 -1,0.6 4.4 3.4 4.4",
    "‰":"0 0 4 6,0 6 0 4.8 1.2 4.8 1.2 6 0 6,1.6 0 1.6 1.2 2.6 1.2 2.6 0 1.6 0,3 0 3 1.2 4 1.2 4 0 3 0",
    "←":"4 3 0 3,1.5 4.5 0 3 1.5 1.5", "→":"0 3 4 3,2.5 4.5 4 3 2.5 1.5", "↑":"2 0 2 6,0.5 4.5 2 6 3.5 4.5", "↓":"2 6 2 0,0.5 1.5 2 0 3.5 1.5",
    "↔":"0 3 4 3,1.2 4.2 0 3 1.2 1.8,2.8 4.2 4 3 2.8 1.8",
    "Ø":"1 0 0 1 0 5 1 6 3 6 4 5 4 1 3 0 1 0,0 -0.5 4 6.5", "ø":"1 0 0 1 0 3 1 4 3 4 4 3 4 1 3 0 1 0,0 -0.3 4 4.3",
    "–":"0 3 4 3", "—":"-1 3 5 3", "…":"0.4 0.4 0.4 0,2 0.4 2 0,3.6 0.4 3.6 0", "¼":"0 0 4 6,0.4 5.4 1 6 1 3.6,2.6 0 2.6 2.4 1.8 1 3.8 1",
    "½":"0 0 4 6,0.4 5.4 1 6 1 3.6,2.2 2.2 2.8 2.6 3.6 2.6 4 2.2 4 1.8 2.2 0 4 0", "¾":"0 0 4 6,2.6 0 2.6 2.4 1.8 1 3.8 1,0 6 1.2 6 0.6 5.2 1.2 4.6 1.2 4 0.6 3.6 0 3.8",
    "¿":"4 1 3 0 1 0 0 1 0 2 2 3.4 2 4.2,2 5.6 2 6", "¡":"2 0 2 4,2 5.6 2 6", "«":"2 5 0 3 2 1,4 5 2 3 4 1", "»":"0 5 2 3 0 1,2 5 4 3 2 1",
    "\u2300":"1 0 0 1 0 5 1 6 3 6 4 5 4 1 3 0 1 0,0 -0.5 4 6.5"
  };
  const aliases = {"\u03bc":"µ", "\u2126":"Ω", "\u2018":"'", "\u2019":"'", "\u201c":"\"", "\u201d":"\"", "\u2212":"-", "\u00a0":" ", "\u2022":"•", "\u2010":"-", "\u2011":"-", "\u00d8":"Ø"};
  // Combining marks, drawn over capitals; lowered by 2 over lowercase.
  const markSource = {"\u0300":"1.4 7.4 2.4 6.7", "\u0301":"1.6 6.7 2.6 7.4", "\u0302":"1 6.7 2 7.4 3 6.7", "\u0303":"0.8 6.8 1.4 7.3 2.6 6.8 3.2 7.3",
    "\u0308":"1.2 6.8 1.2 7.3,2.8 6.8 2.8 7.3", "\u030a":"2 6.6 1.6 6.9 2 7.4 2.4 6.9 2 6.6", "\u030c":"1 7.4 2 6.7 3 7.4",
    "\u0327":"2 0 2.4 -0.6 1.6 -1.2", "\u0328":"3 0 2.4 -0.6 3.2 -1.2"};
  const glyphs = new Map(asciiGlyphs);
  for (const [ch, src] of Object.entries(extraSource)) glyphs.set(ch, parse(src));
  // Latin-1 and Latin Extended-A letters that do not decompose into a base
  // and a mark, and the spacing marks. Original strokes on the same grid.
  const latinSource = {
    "¢":"3.6 3.6 1 3.6 0.4 3 0.4 1 1 0.4 3.6 0.4,2 4.6 2 -0.6", "¤":"1.4 1.6 2.6 1.6 3.2 2.2 3.2 3.4 2.6 4 1.4 4 0.8 3.4 0.8 2.2 1.4 1.6,0 0.8 0.9 1.7,4 0.8 3.1 1.7,0 4.8 0.9 3.9,4 4.8 3.1 3.9",
    "¦":"2 7 2 3.6,2 2.4 2 -1", "¨":"1.2 5.6 1.2 6.1,2.8 5.6 2.8 6.1", "¯":"0.5 6.6 3.5 6.6", "´":"1.6 5.4 2.6 6.4", "¸":"2 0 2.4 -0.6 1.6 -1.2",
    "ª":"1 6.2 2.6 6.2 3 5.8 3 4.2,3 5 1.4 5 1 4.6 1.4 4.2 3 4.2,1 3.4 3 3.4", "º":"1.4 4.2 1 4.6 1 5.8 1.4 6.2 2.6 6.2 3 5.8 3 4.6 2.6 4.2 1.4 4.2,1 3.4 3 3.4",
    "¬":"0 3.6 4 3.6 4 2", "Æ":"0 0 0 4 2 6 4 6,2 6 2 0 4 0,0 2.6 2 2.6,2 3 3.6 3",
    "æ":"0.4 4 1.6 4 2 3.6 2 0.4 1.6 0 0.4 0 0 0.4 0 1.6 0.4 2 2 2,2 2 4 2 4 3.6 3.6 4 2.4 4 2 3.6,2 0.4 2.4 0 4 0",
    "Ð":"0.6 0 0.6 6 2.5 6 4 4.5 4 1.5 2.5 0 0.6 0,0 3 2 3", "Đ":"0.6 0 0.6 6 2.5 6 4 4.5 4 1.5 2.5 0 0.6 0,0 3 2 3",
    "đ":"4 6 4 0 1 0 0 1 0 3 1 4 4 4,2.6 5.2 4.6 5.2", "ð":"1 0 0 1 0 2.6 1 3.6 3 3.6 4 2.6 4 1 3 0 1 0,4 2.6 3.4 4.8 2 6,1.4 4.4 3.6 5.4",
    "Þ":"0 0 0 6,0 4.6 3 4.6 4 3.6 4 2.6 3 1.6 0 1.6", "þ":"0 6 0 -2,0 4 3 4 4 3 4 1 3 0 0 0",
    "ß":"0 0 0 5 1 6 2.6 6 3.4 5.2 3.4 4.4 2.4 3.6 3.4 3 4 2.2 4 1 3 0 2 0",
    "Ħ":"0 0 0 6,4 0 4 6,0 3 4 3,-0.6 4.8 4.6 4.8", "ħ":"0 6 0 0,0 3 1 4 3 4 4 3 4 0,-0.6 5 2 5", "ı":"2 4 2 0",
    "Ĳ":"0.4 0 0.4 6,1.6 1 2.4 0 3.2 0 4 1 4 6", "ĳ":"1 4 1 0,1 5.6 1 6,3.4 4 3.4 -1 2.6 -2 1.8 -2,3.4 5.6 3.4 6", "ĸ":"0 4 0 0,3.6 4 0 1.6,1.4 2.4 4 0",
    "Ŀ":"0 6 0 0 4 0,2.6 3.2 2.6 2.8", "ŀ":"1 6 2 6 2 0,1 0 3 0,3.6 3.2 3.6 2.8", "Ł":"1 6 1 0 4 0,0 2.2 2.2 3.8", "ł":"1 6 2 6 2 0,1 0 3 0,0.8 2.4 3.2 3.8",
    "ŉ":"0.6 6 0.6 4.8 0.2 4.2,1.4 0 1.4 4,1.4 3 2.2 4 3.4 4 4 3 4 0", "Ŋ":"0 0 0 6,0 5 1 6 3 6 4 5 4 -1 3 -2 2 -2", "ŋ":"0 0 0 4,0 3 1 4 3 4 4 3 4 -1 3 -2 2 -2",
    "Œ":"4 6 1 6 0 5 0 1 1 0 4 0,2.2 6 2.2 0,2.2 3 3.6 3", "œ":"2 3 1.4 4 0.6 4 0 3.4 0 0.6 0.6 0 1.4 0 2 1 2 3 2.6 4 3.4 4 4 3.4 4 2 2 2,2 1 2.6 0 4 0",
    "Ŧ":"0 6 4 6,2 6 2 0,0.8 3 3.2 3", "ŧ":"2 6 2 1 3 0 4 0,0.5 4 3.5 4,0.8 2.4 3.2 2.4", "ſ":"4 6 3 6 2 5 2 0"
  };
  for (const [ch, src] of Object.entries(latinSource)) glyphs.set(ch, parse(src));
  aliases["\u00ad"] = "-";
  const marks = new Map(Object.entries(markSource).map(([k, v]) => [k, parse(v)]));
  // Macron, breve, dot above, double acute and comma below (ā ă ż ő ș).
  for (const [k, v] of Object.entries({"\u0304":"1 7 3 7", "\u0306":"1 7.4 1.4 6.8 2.6 6.8 3 7.4", "\u0307":"2 6.8 2 7.3", "\u030b":"1 6.7 1.8 7.4,2.4 6.7 3.2 7.4",
    "\u0326":"2 -0.4 2 -0.8 1.4 -1.6"})) marks.set(k, parse(v));

  // Glyph lookup with aliases and composed accents. Returns null if missing.
  function baseGlyph(ch) {
    if (glyphs.has(ch)) return glyphs.get(ch);
    if (aliases[ch] && glyphs.has(aliases[ch])) return glyphs.get(aliases[ch]);
    const parts = Array.from(ch.normalize ? ch.normalize("NFD") : ch);
    if (parts.length < 2 || !glyphs.has(parts[0])) return null;
    const lower = /[a-z]/.test(parts[0]);
    let g = parts[0] === "i" ? [[[2, 4], [2, 0]]] : parts[0] === "j" ? [[[3, 4], [3, -1], [2, -2], [1, -2]]] : glyphs.get(parts[0]);
    g = g.slice();
    for (const m of parts.slice(1)) {
      const mk = marks.get(m);
      if (!mk) return null;
      const below = m === "\u0327" || m === "\u0328" || m === "\u0326";
      for (const line of mk) g.push(line.map(([x, y]) => [x, below || !lower ? y : y - 2]));
    }
    glyphs.set(ch, g);
    return g;
  }

  // Altium's Sans Serif and Serif stroke fonts are derived from the default
  // glyphs: Sans Serif rounds the chamfered curves (corner-cutting at gentle
  // turns, sharp corners kept); Serif adds horizontal serifs at stem ends on
  // the baseline, x-height, cap height and descender line.
  const styled = {sans: new Map(), serif: new Map()};
  function turn(a, b, c) {
    const ux = b[0] - a[0], uy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    const lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
    if (!lu || !lv) return 0;
    return Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))));
  }
  function roundLine(line) {
    const closed = line.length > 3 && line[0][0] === line.at(-1)[0] && line[0][1] === line.at(-1)[1];
    let pts = closed ? line.slice(0, -1) : line.slice();
    for (let pass = 0; pass < 2; pass++) {
      const n = pts.length, out = [];
      for (let i = 0; i < n; i++) {
        const interior = closed || (i > 0 && i < n - 1);
        if (!interior) { out.push(pts[i]); continue; }
        const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
        if (turn(a, b, c) > 1.05) { out.push(b); continue; }
        const f = .3;
        out.push([b[0] + (a[0] - b[0]) * f, b[1] + (a[1] - b[1]) * f], [b[0] + (c[0] - b[0]) * f, b[1] + (c[1] - b[1]) * f]);
      }
      pts = out;
    }
    if (closed) pts.push(pts[0]);
    return pts.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
  }
  function serifLines(ch, g) {
    const out = g.slice();
    if (!/[\p{L}\p{N}]/u.test(ch)) return out;
    const lines = new Set([0, 6, -2, 4]);
    for (const line of g) {
      if (line.length < 2) continue;
      const closed = line[0][0] === line.at(-1)[0] && line[0][1] === line.at(-1)[1];
      if (closed) continue;
      for (const [e, nb] of [[line[0], line[1]], [line.at(-1), line.at(-2)]]) {
        if (!lines.has(e[1])) continue;
        const dx = e[0] - nb[0], dy = e[1] - nb[1], l = Math.hypot(dx, dy);
        if (!l) continue;
        if (Math.abs(dy) / l >= .6) out.push([[e[0] - .7, e[1]], [e[0] + .7, e[1]]]);
        else if (Math.abs(dy) / l < .1 && /\p{Lu}|[0-9]/u.test(ch) && (e[1] === 6 || e[1] === 0)) out.push([[e[0], e[1]], [e[0], e[1] + (e[1] === 6 ? -.8 : .8)]]);
      }
    }
    return out;
  }
  function glyph(ch, style) {
    const base = baseGlyph(ch);
    if (!base || style === "default" || !styled[style]) return base;
    const cache = styled[style];
    if (!cache.has(ch)) cache.set(ch, style === "sans" ? base.map(roundLine) : serifLines(ch, base));
    return cache.get(ch);
  }
  const supported = ch => !!baseGlyph(ch);

  // Vladimir Uryvaev's CC0 NewStroke, Basic Latin U+0020 through U+007D.
  // Source URL, checksum and extraction instructions: vendor/KICAD-NEWSTROKE-CC0.txt.
  // Keep the encoded subset in this lazy PCB text module and decode each glyph on first use.
  const kiCadStrokes = [
    "JZ", "MWRYSZR[QZRYR[ RRSQGRFSGRSRF", "JZNFNJ RVFVJ", "H]LM[M RRDL_ RYVJV RS_YD", "H\\LZO[T[VZWYXWXUWSVRTQPPNOMNLLLJMHNGPFUFXG RRCR^",
    "F^J[ZF RMFOGPIOKMLKKJIKGMF RYZZXYVWUUVTXUZW[YZ", "E_[[Z[XZUWPQNNMKMINGPFQFSGTITJSLRMLQKRJTJWKYLZN[Q[SZTYWUXRXP", "MWSFQJ", "KYVcUbS_R]QZPUPQQLRISGUDVC", "KYNcObQ_R]SZTUTQSLRIQGODNC",
    "JZRFRK RMIRKWI ROORKUO", "E_JSZS RR[RK", "MWSZS[R]Q^", "E_JSZS", "MWRYSZR[QZRYR[",
    "G][EI`", "H\\QFSFUGVHWJXNXSWWVYUZS[Q[OZNYMWLSLNMJNHOGQF", "H\\X[L[ RR[RFPINKLL", "H\\LHMGOFTFVGWHXJXLWOK[X[", "H\\KFXFQNTNVOWPXRXWWYVZT[N[LZKY",
    "H\\VMV[ RQELTYT", "H\\WFMFLPMOONTNVOWPXRXWWYVZT[O[MZLY", "H\\VFRFPGOHMKLOLWMYNZP[T[VZWYXWXRWPVOTNPNNOMPLR", "H\\KFYFP[", "H\\PONNMMLKLJMHNGPFTFVGWHXJXKWMVNTOPONPMQLSLWMYNZP[T[VZWYXWXSWQVPTO",
    "H\\N[R[TZUYWVXRXJWHVGTFPFNGMHLJLOMQNRPSTSVRWQXO", "MWRYSZR[QZRYR[ RRNSORPQORNRP", "MWSZS[R]Q^ RRNSORPQORNRP", "E_ZMJSZY", "E_JPZP RZVJV",
    "E_JMZSJY", "I[QYRZQ[PZQYQ[ RMGOFTFVGWIWKVMUNSORPQRQS", "D_VQUPSOQOOPNQMSMUNWOXQYSYUXVW RVOVWWXXXZW[U[PYMVKRJNKKMIPHTIXK[N]R^V]Y[", "I[MUWU RK[RFY[", "G\\SPVQWRXTXWWYVZT[L[LFSFUGVHWJWLVNUOSPLP",
    "F[WYVZS[Q[NZLXKVJRJOKKLINGQFSFVGWH", "G\\L[LFQFTGVIWKXOXRWVVXTZQ[L[", "H[MPTP RW[M[MFWF", "HZTPMP RM[MFWF", "F[VGTFQFNGLIKKJOJRKVLXNZQ[S[VZWYWRSR",
    "G]L[LF RLPXP RX[XF", "MWR[RF", "JZUFUUTXRZO[M[", "G\\L[LF RX[OO RXFLR", "HYW[M[MF",
    "F^K[KFRUYFY[", "G]L[LFX[XF", "G]PFTFVGXIYMYTXXVZT[P[NZLXKTKMLINGPF", "G\\L[LFTFVGWHXJXMWOVPTQLQ", "G]Z]X\\VZSWQVOV RP[NZLXKTKMLINGPFTFVGXIYMYTXXVZT[P[",
    "G\\X[QQ RL[LFTFVGWHXJXMWOVPTQLQ", "H\\LZO[T[VZWYXWXUWSVRTQPPNOMNLLLJMHNGPFUFXG", "JZLFXF RR[RF", "G]LFLWMYNZP[T[VZWYXWXF", "I[KFR[YF",
    "F^IFN[RLV[[F", "H\\KFY[ RYFK[", "I[RQR[ RKFRQYF", "H\\KFYFK[Y[", "KYVbQbQDVD",
    "KYID[_", "KYNbSbSDND", "LXNHREVH", "JZJ]Z]", "NVPESH",
    "I\\W[WPVNTMPMNN RWZU[P[NZMXMVNTPSUSWR", "H[M[MF RMNOMSMUNVOWQWWVYUZS[O[MZ", "HZVZT[P[NZMYLWLQMONNPMTMVN", "I\\W[WF RWZU[Q[OZNYMWMQNOONQMUMWN", "I[VZT[P[NZMXMPNNPMTMVNWPWRMT",
    "MYOMWM RR[RISGUFWF", "I\\WMW^V`UaSbPbNa RWZU[Q[OZNYMWMQNOONQMUMWN", "H[M[MF RV[VPUNSMPMNNMO", "MWR[RM RRFQGRHSGRFRH", "MWRMR_QaObNb RRFQGRHSGRFRH",
    "IZN[NF RPSV[ RVMNU", "MXU[SZRXRF", "D`I[IM RIOJNLMOMQNRPR[ RRPSNUMXMZN[P[[", "I\\NMN[ RNOONQMTMVNWPW[", "H[P[NZMYLWLQMONNPMSMUNVOWQWWVYUZS[P[",
    "H[MMMb RMNOMSMUNVOWQWWVYUZS[O[MZ", "I\\WMWb RWZU[Q[OZNYMWMQNOONQMUMWN", "KXP[PM RPQQORNTMVM", "J[NZP[T[VZWXWWVUTTQTOSNQNPONQMTMVN", "MYOMWM RRFRXSZU[W[",
    "H[VMV[ RMMMXNZP[S[UZVY", "JZMMR[WM", "G]JMN[RQV[ZM", "IZL[WM RLMW[", "JZMMR[ RWMR[P`OaMb",
    "IZLMWML[W[", "KYVcUcSbR`RVQTOSQRRPRFSDUCVC", "H\\RbRD", "KYNcOcQbR`RVSTUSSRRPRFQDOCNC",
  ];

  const kiCadGlyphs = new Map();
  function kiCadGlyph(ch) {
    const index = ch.charCodeAt(0) - 32;
    if (!kiCadGlyphs.has(index)) {
      const row = kiCadStrokes[index], bearing = row.charCodeAt(0);
      const advance = row.charCodeAt(1) - bearing;
      const strokes = row.slice(2).split(" R").filter(stroke => stroke.length >= 4).map(stroke => {
        const points = [];
        for (let i = 0; i < stroke.length; i += 2)
          points.push([stroke.charCodeAt(i) - bearing, stroke.charCodeAt(i + 1) - 90]);
        return points;
      });
      kiCadGlyphs.set(index, {advance, strokes});
    }
    return kiCadGlyphs.get(index);
  }
  const hasKiCadGlyphs = text => /^[\t\r\n -}]*$/.test(text) && !/[_^]\{/.test(text);

  function kiCadLine(line, p, base, hAlign, strokes) {
    const unitX = p.fontWidth / 21, unitY = p.height / 21;
    const runs = [];
    let advance = 0, column = 0;
    for (const ch of line) {
      if (ch === "\t") {
        column += 3 - column % 4;
        const space = kiCadGlyph(" ").advance * unitX;
        const stop = p.fontWidth * column + space;
        const skip = Math.max(0, 1 + Math.floor((advance - stop) / (4 * p.fontWidth)));
        advance = stop + skip * 4 * p.fontWidth;
      } else {
        const glyph = kiCadGlyph(ch);
        runs.push({at:advance, glyph});
        advance += glyph.advance * unitX;
      }
      column++;
    }
    const inset = p.width / 1.52;
    const start = hAlign === 0 ? inset : hAlign === 1 ? -advance - inset : -advance / 2;
    const tilt = p.italic ? 1 / 8 : 0;
    for (const {at, glyph} of runs) for (const path of glyph.strokes)
      strokes.push({points:path.map(([x, y]) => [start + at + x * unitX - y * unitY * tilt, base + y * unitY]), width:p.width});
    return advance;
  }


  // Centreline widths and advances in Altium's six-unit Default stroke grid.
  // Recorded run extents and printed character starts establish these metrics.
  // A null advance means only a terminal instance has been measured.
  const nativeCells = new Map();
  /** @type {Array<[string, number, number|null]>} */
  const cellGroups = [
    ["-/023456789ABCDEFGHLMNOPRSTUVWXabcdeghmnopsuvx",4,6],
    ["1Iilt",2,5], [".:",1,5], ["k",3,6], ["r",3,6], [" ",0,6]
  ];
  for (const [chars,ink,advance] of cellGroups) for (const ch of chars) nativeCells.set(ch,{ink,advance});
  // Across 265 published overlay strings the following nonterminal advances
  // are independent of the rest of the string. Terminal extents are unmeasured.
  for(const ch of "JKQY_wy")nativeCells.set(ch,{ink:null,advance:6});
  const projectValue = Symbol("resolved PCB project text");
  const sourceLetters=Symbol("saved PCB lettering"),letterKeys=new WeakMap(),sourceViews=new WeakMap();
  let nextLetterKey=0;
  function withLetters(item,doc){
    const index=item.sourceTextBox?.letterSet;
    if(!Number.isInteger(index))return item;
    const letters=doc?.pcbDrawing?.letterSets?.[index];
    if(!letters || typeof letters!=="object")return item;
    const old=sourceViews.get(item);
    if(old?.[sourceLetters]===letters)return old;
    if(!letterKeys.has(letters))letterKeys.set(letters,++nextLetterKey);
    const view=Object.assign(Object.create(item),{[sourceLetters]:letters});
    sourceViews.set(item,view);return view;
  }
  function importedGrid(item,box,height) {
    if (!(box.text===item.text || item[projectValue]) || !["ink","baseline"].includes(box.mode) || item.italic || item.bold || box.strokeFont!=="default") return 0;
    // The source supplies the actual cell size, including its internal rounding.
    // Integer counts distinguish capitals, x-height, punctuation and descenders.
    const span=box.height-box.strokeWidth, units=span*CAP/box.size, count=Math.round(units);
    return count>0 && Math.abs(units-count)<.02 ? span/count*height/box.size : 0;
  }
  const nativeGlyphs=new Map();
  function measuredRun(chars) {
    if (!chars.length || chars[0]===" " || chars.at(-1)===" ") return null;
    let cursor=0;
    const cells=[];
    for (let i=0;i<chars.length;i++) {
      const ch=chars[i],cell=nativeCells.get(ch),last=i===chars.length-1;
      if (!cell || last && cell.ink==null || !last && cell.advance==null) return null;
      let ext=nativeGlyphs.get(ch);
      if (!ext) {
        const xs=glyph(ch,"default").flat().map(q=>q[0]);
        ext=xs.length?[Math.min(...xs),Math.max(...xs)]:[0,0];
        nativeGlyphs.set(ch,ext);
      }
      // Align the outer ink edges to the measured run. Centre interior glyphs
      // in their native ink cells, preserving the shape and pen of every stroke.
      const weight=chars.length===1?.5:i===0?0:last?1:.5;
      cells.push(cursor-ext[0]+weight*((cell.ink??ext[1]-ext[0])-ext[1]+ext[0]));
      cursor+=last?cell.ink:cell.advance;
    }
    return {cells,width:cursor};
  }

  // Plot-compatible replacement for fab-outputs' strokeText: polylines in
  // model coordinates for a single line anchored at the baseline.
  function strokeText(text, at, angle, size, align = "left", mirror = false) {
    const l = layout(String(text), {height: size, align, mirrored: !!mirror, lineSpacing: 0});
    const frame = {x: at[0], y: at[1], angle: angle || 0};
    return {strokes: l.strokes.map(s => s.points.map(p => world(p, frame))), unsupported: l.unsupported};
  }

  // ---------------------------------------------------------------------------
  // Properties
  const JUSTIFY = PCB.textAnchors;
  const num = (v, d) => typeof v === "number" && Number.isFinite(v) ? v : d;
  // Normalised properties of an item (label or footprint text shape).
  function props(item, layer) {
    const font = item.font === "truetype" || item.font === "barcode" ? item.font : "stroke";
    const height = num(item.size, 0) > 0 ? item.size : .75;
    const justify = PCB.textJustification(item);
    const b = item.barcode || {}, sourceBox = item.sourceTextBox;
    const chosenStroke = item.strokeFont;
    const strokeFont = chosenStroke === "sans" || chosenStroke === "serif" || chosenStroke === "kicad" ? chosenStroke : "default";
    const fontWidth = num(item.fontWidth, 0) > 0 ? item.fontWidth : height;
    let pen = num(item.width, 0);
    if (font === "stroke" && strokeFont === "kicad")
      pen = Math.min(pen > 0 ? pen : fontWidth / (item.bold ? 5 : 8), Math.min(fontWidth, height) / 4);
    else if (!(pen > 0)) pen = Math.max(.1, height / 6);
    const sourceFont = sourceBox?.font || "truetype";
    const native = sourceBox && sourceFont === font && (sourceBox.mode==null || ["ink","baseline","frame"].includes(sourceBox.mode)) &&
      [sourceBox.width,sourceBox.height,sourceBox.size].every(n => Number.isFinite(n) && n > 0) &&
      (sourceBox.margin==null || Number.isFinite(sourceBox.margin) && sourceBox.margin>=0);
    const sameStyle = native && (font === "stroke" ? sourceBox.strokeFont === strokeFont && sourceBox.strokeWidth === (item.width || 0) :
      sourceBox.family === (item.family || "Arial") && sourceBox.bold === !!item.bold && sourceBox.italic === !!item.italic);
    return {
      normalised: true, font, height, justify,
      fontWidth,
      sourceBox: sameStyle && sourceBox.text === item.text && sourceBox.mode !== "frame" ? sourceBox : null,
      projectGrid: sameStyle && font==="stroke" ? importedGrid(item,sourceBox,height) : 0,
      sourceMode: native ? sourceBox.mode || "" : "",
      letters: sameStyle && item[sourceLetters] || null,
      letterSize: native ? sourceBox.size : height,
      sourceFrame: native && sourceBox.mode === "frame" ? sourceBox : null,
      width: pen,
      strokeFont,
      family: typeof item.family === "string" && item.family.trim() ? item.family.trim() : "Arial",
      bold: !!item.bold, italic: !!item.italic,
      mirrored: PCB.textMirrored(item, layer),
      lineSpacing: num(item.lineSpacing, 0) > 0 ? item.lineSpacing : 5 / 3,
      inverted: !!item.inverted, frame: !!item.frame,
      margin: num(item.margin, -1) >= 0 ? item.margin : Math.max(height * .25, .1),
      barcode: font === "barcode" ? {
        type: b.type === "code39" || b.type === "qr" ? b.type : "code128",
        module: num(b.module, 0) > 0 ? b.module : b.type === "qr" ? 0 : .254,
        quiet: num(b.quiet, -1) >= 0 ? b.quiet : b.type === "qr" ? 4 : 10,
        ratio: Math.min(3, Math.max(2, num(b.ratio, 3))),
        text: b.text !== false && b.type !== "qr", ecc: ["L", "M", "Q", "H"].includes(b.ecc) ? b.ecc : "M"
      } : null
    };
  }
  const negate = () => globalThis.AtriumSchAppearance?.negation || null;
  function signature(text, p) {
    return [text, text.includes("\\") && negate() ? +globalThis.AtriumSchAppearance.singleNegation() : "", p.font, p.height, p.fontWidth, p.width, p.strokeFont, p.family, p.bold, p.italic, p.justify, p.mirrored, p.lineSpacing,
      p.inverted, p.frame, p.margin, p.barcode ? JSON.stringify(p.barcode) : "",
      p.sourceMode,p.projectGrid,p.letters?letterKeys.get(p.letters):"",p.letterSize,p.sourceBox ? [p.sourceBox.width,p.sourceBox.height,p.sourceBox.size].join(",") : "",
      p.sourceFrame ? [p.sourceFrame.width,p.sourceFrame.height,p.sourceFrame.margin || 0].join(",") : ""].join("\u0001");
  }

  // ---------------------------------------------------------------------------
  // Geometry helpers
  function world(p, frame) {
    if (A()?.world) return A().world(p, frame);
    const r = (frame.angle || 0) * Math.PI / 180, c = Math.cos(r), s = Math.sin(r);
    return [p[0] * c - p[1] * s + frame.x, p[0] * s + p[1] * c + frame.y];
  }
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  function boxOf(strokes, polygons, width) {
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    const add = (p, e) => { if (p[0] - e < b[0]) b[0] = p[0] - e; if (p[1] - e < b[1]) b[1] = p[1] - e; if (p[0] + e > b[2]) b[2] = p[0] + e; if (p[1] + e > b[3]) b[3] = p[1] + e; };
    for (const s of strokes) for (const p of s.points) add(p, (s.width ?? width) / 2);
    for (const poly of polygons) for (const p of poly.outer) add(p, 0);
    return b[0] <= b[2] ? b : null;
  }

  // ---------------------------------------------------------------------------
  // Layout
  // Returns {strokes:[{points, width}], polygons:[{outer, holes}], width,
  //   box (ink extents), metrics (anchor box), lines, unsupported, fallback}.
  function layout(text, input) {
    const p = input?.normalised ? input : normalise(input);
    let lines = String(text ?? "").split(/\r?\n/);
    const h = p.height;
    let pitch = p.lineSpacing * h;
    let strokes = [], polygons = [], unsupported = 0, fallback = null;
    const [vert, horiz] = p.justify === "center" ? ["middle", "center"] : p.justify.split("-");
    const hFactor = horiz === "left" ? 0 : horiz === "center" ? .5 : 1;
    let top = -h, bottom = (lines.length - 1) * pitch, metricsWidth = 0;
    const vShift = (t = top, b = bottom) => vert === "top" ? -t : vert === "middle" ? -(t + b) / 2 : -b;
    let font = p.font;
    // TrueType, barcodes and knockout live in pcb-text-rich.js: stroke text (pending) until it loads.
    const rich = font !== "stroke" || p.inverted ? richText() : null, pending = (font !== "stroke" || p.inverted) && !rich;
    if (pending) font = "stroke";
    const saved=font==="truetype" && p.letters && rich.savedRun(p.letters,lines);
    if (font === "truetype" && !saved && !rich.available()) { font = "stroke"; fallback = "TrueType rendering is unavailable here; the stroke font was used."; }

    const wantsKiCad = font === "stroke" && p.strokeFont === "kicad";
    const useKiCad = wantsKiCad && hasKiCadGlyphs(String(text ?? ""));
    if (wantsKiCad && !useKiCad) fallback = "This field uses characters or formatting outside the bundled KiCad glyphs. Waffle’s stroke font was used.";

    if (font === "barcode") {
      const r = rich.barcodeLayout(lines.join(""), p);
      strokes = r.strokes; polygons = r.polygons; top = r.top; bottom = r.bottom; metricsWidth = r.width;
      const dx = -metricsWidth * hFactor, dy = vShift();
      const move = pt => [pt[0] + dx, pt[1] + dy];
      strokes = strokes.map(s => ({...s, points: s.points.map(move)}));
      polygons = polygons.map(poly => ({outer: poly.outer.map(move), holes: poly.holes.map(r => r.map(move))}));
      if (r.error) fallback = r.error;
    } else if (font === "truetype") {
      ({lines, pitch, top, bottom, metricsWidth, polygons} = saved ?
        rich.savedLayout(lines,p,saved,h,pitch,hFactor) : rich.truetype(lines, p, h, pitch, hFactor, vShift));
    } else if (useKiCad) {
      // KiCad applies a compatibility scale to its nominal 1.68 line spacing.
      // The imported line-spacing multiplier is stored in Waffle's 5/3 grid.
      lines = String(text ?? "").split(/\r\n?|\n/);
      pitch *= 1.68 * .9583 * 3 / 5;
      top = -h + p.width * .052;
      bottom = top + h * 1.17 + (lines.length - 1) * pitch;
      const baseline = vShift();
      lines.forEach((line, i) => {
        metricsWidth = Math.max(metricsWidth, kiCadLine(line, p, baseline + i * pitch, hFactor, strokes));
      });
    } else {
      const slant = p.italic ? Math.tan(12 * Math.PI / 180) : 0, dy0 = vShift();
      // Negation (AtriumSchAppearance.negation, as on schematics): drawn without the backslashes, with an overline
      // over the negated characters, on the canvas and on silk alike. Recorded Altium boxes keep their source text.
      const neg = !p.sourceBox && !p.sourceMode && negate();
      lines.forEach((line, li) => {
        const n0 = neg && line.includes("\\") ? neg(line) : null;
        if (n0) line = n0.text;
        const chars = Array.from(line), run = p.projectGrid && measuredRun(chars);
        const width = run ? run.width : textUnits(chars.length), u=run?p.projectGrid:h/CAP;
        metricsWidth = Math.max(metricsWidth, width * u);
        const start = hFactor === 0 ? 0 : hFactor === .5 ? -width / 2 : -width, base = li * pitch + dy0;
        chars.forEach((ch, n) => {
          let g = glyph(ch, p.strokeFont);
          if (!g) { unsupported++; g = glyph("?", p.strokeFont); }
          for (const line of g) strokes.push({points: line.map(([gx, gy]) => {
            const lx = (start + (run ? run.cells[n] : n*ADVANCE) + (slant ? gx + gy * slant : gx)) * u;
            return [lx, base ? base - gy * u : -gy * u];
          }), width: p.width});
        });
        // One bar per run of negated characters, 1.5 units above the capitals.
        const cell = n => start + (run ? run.cells[n] : n * ADVANCE), y = base - (CAP + 1.5) * u;
        for (let k = 0, b = n0?.bars || []; k < b.length;) {
          let e = k; while (e + 1 < b.length && b[e + 1] === b[e] + 1) e++;
          strokes.push({points: [[cell(b[k]) * u, y], [(cell(b[e]) + GLYPH) * u, y]], width: p.width}); k = e + 1;
        }
      });
    }
    // Anchor box in local coordinates (before mirroring).
    const dy = vShift();
    let metrics = [-metricsWidth * hFactor + 0, top + dy + 0, metricsWidth * (1 - hFactor) + 0, bottom + dy + 0];
    // Fit recorded ink about the justified anchor. In baseline-only records the pen
    // origin stays on the baseline, so descenders extend below it. A layout frame
    // controls the alignment and wrapping, never the scale of the outlines.
    if (p.sourceBox || p.sourceMode && p.sourceMode !== "baseline") {
      const bounds = boxOf(strokes.map(st => ({...st,width:0})), polygons, 0);
      if (bounds) {
        const bw = bounds[2]-bounds[0], bh = bounds[3]-bounds[1], b = p.sourceBox;
        const w = b ? b.width*h/b.size : bw + (strokes.length?p.width:0);
        const sh = b ? b.height*h/b.size : bh + (strokes.length?p.width:0);
        const line = strokes.length ? Math.min(p.width, w, sh) : 0;
        const baseline = p.sourceMode === "baseline" && p.justify === "bottom-left";
        const left = baseline ? (p.font==="stroke"?-line/2:0) : -w*hFactor;
        let y = vert === "top" ? 0 : vert === "middle" ? -sh/2 : -sh;
        if (baseline && bh>0) y=bounds[1]*(sh-line)/bh-line/2;
        const margin=p.sourceFrame?.margin || (p.sourceMode==="ink" && p.font==="stroke"?p.width/2:0);
        const x = left + margin*(1-2*hFactor);
        y += margin*(vert==="top"?1:vert==="bottom"?-1:0);
        const map = q => [x + (bw ? line/2 + (q[0]-bounds[0])*(w-line)/bw : w/2),
          y + (bh ? line/2 + (q[1]-bounds[1])*(sh-line)/bh : sh/2)];
        strokes = strokes.map(s => ({points:s.points.map(map),width:line}));
        polygons = polygons.map(poly => ({outer:poly.outer.map(map),holes:poly.holes.map(r => r.map(map))}));
        metrics = [x, y, x + w, y + sh];
      }
    }
    // A source may specify separate vertical and horizontal font dimensions.
    // Scale the outlines and advance, keeping the physical pen diameter.
    if (font !== "barcode" && !useKiCad && p.fontWidth > 0 && p.fontWidth !== h && !p.sourceBox && !p.sourceFrame) {
      const ratio = p.fontWidth / h, stretch = ([x,y]) => [x * ratio,y];
      strokes = strokes.map(s => ({...s, points:s.points.map(stretch)}));
      polygons = polygons.map(poly => ({outer:poly.outer.map(stretch), holes:poly.holes.map(r=>r.map(stretch))}));
      metrics[0] *= ratio; metrics[2] *= ratio;
    }
    // Frame and knockout.
    if (p.inverted && rich) {
      const ink = boxOf(strokes, polygons, p.width) || metrics;
      const m = p.margin;
      let r = [ink[0] - m, ink[1] - m, ink[2] + m, ink[3] + m];
      if (p.sourceFrame) {
        const {width:w,height:h} = p.sourceFrame, x = -w*hFactor, y = vert === "top" ? 0 : vert === "middle" ? -h/2 : -h;
        r = [Math.min(x,r[0]),Math.min(y,r[1]),Math.max(x+w,r[2]),Math.max(y+h,r[3])];
      }
      polygons = rich.knockout(strokes, polygons, r, p);
      strokes = [];
    } else if (p.frame) {
      const ink = boxOf(strokes, polygons, p.width) || metrics, m = p.margin + p.width / 2;
      const r = [ink[0] - m, ink[1] - m, ink[2] + m, ink[3] + m];
      strokes.push({points: [...rect(r[0], r[1], r[2], r[3]), [r[0], r[1]]], width: p.width});
    }
    if (p.mirrored) {
      const flip = pt => [-pt[0], pt[1]];
      strokes = strokes.map(s => ({...s, points: s.points.map(flip)}));
      polygons = polygons.map(poly => ({outer: poly.outer.map(flip).reverse(), holes: poly.holes.map(r => r.map(flip).reverse())}));
      metrics.splice(0, 4, -metrics[2] + 0, metrics[1], -metrics[0] + 0, metrics[3]);
    }
    const box = boxOf(strokes, polygons, p.width) || metrics.slice();
    let vertices = 0;
    for (const s of strokes) vertices += s.points.length;
    for (const poly of polygons) { vertices += poly.outer.length; for (const r of poly.holes) vertices += r.length; }
    return {strokes, polygons, width: p.width, box, metrics, lines: lines.length, unsupported, fallback, font, vertices, props: p, ...(pending ? {pending} : {})};
  }
  function normalise(input = {}) {
    // Accept either item-style fields (size, ...) or layout-style (height).
    const item = {...input};
    if (input.height != null && input.size == null) item.size = input.height;
    if (input.lineSpacing === 0) item.lineSpacing = undefined;
    return props(item, input.layer);
  }

  // ---------------------------------------------------------------------------
  // Cached item layout. The key covers every property that changes geometry,
  // so edits, undo snapshots and copies all hit the cache.
  const layoutCache = new Map(), LIMIT = 4000;
  let itemCache = new WeakMap();
  const projectViews = new WeakMap();
  const hasProjectText = item => typeof item?.text === "string" && /(?:^|[\s'"(\[{,;:=])\.[A-Za-z_]/.test(item.text);
  // Only the display value changes. An inherited source box still belongs to the
  // expression it was saved with, not to an edited parameter value.
  function projectItem(item, project, revision=null) {
    if (!project?.parameters || !hasProjectText(item)) return item;
    const prior=projectViews.get(item);
    if (revision!=null && prior?.project===project && prior.revision===revision && prior.expression===item.text) return prior.view;
    const text = A().projectText(project, item.text);
    const view=text===item.text ? item : prior?.view!==item && prior?.view.text===text ? prior.view :
      Object.assign(Object.create(item), {text,[projectValue]:true});
    projectViews.set(item,{project,revision,expression:item.text,view});
    return view;
  }
  function clearCache() { layoutCache.clear(); itemCache = new WeakMap(); glyphExtents = new WeakMap(); }
  function layoutItem(item, layer) {
    const p = props(item, layer), text = String(item.text ?? ""), key = signature(text, p);
    const hit = itemCache.get(item);
    if (hit && hit.key === key) return hit.layout;
    let l = layoutCache.get(key);
    if (l) { layoutCache.delete(key); layoutCache.set(key, l); }
    else {
      l = layout(text, p);
      if (l.pending) return l;
      layoutCache.set(key, l);
      if (layoutCache.size > LIMIT) layoutCache.delete(layoutCache.keys().next().value);
    }
    itemCache.set(item, {key, layout: l});
    return l;
  }
  const positioned = (item, o) => o.frame || item.upright ? PCB.placeText(item, o.frame, o.layer) : item;
  const frameOf = item => ({x:item.x||0,y:item.y||0,angle:item.angle||0});
  function placedInscription(item, doc, project, placement) {
    const frame = placement.frame, source = frame ? A().special(item, frame) : item;
    // Place the authored properties before attaching the inherited display value and saved lettering.
    return projectItem(withLetters(positioned(source, placement), doc), project);
  }
  // Primitives in model coordinates. The parent frame places footprint text
  // and the layer sets auto-mirroring. Writers with their own cut-ins can
  // request polygons with separate holes instead of bridged regions.
  /** @typedef {{layer?: string, frame?: {x: number, y: number, angle?: number}}} PrimitivePlacement */
  /** @typedef {{strokes: {points: number[][], width: number}[], unsupported: number, fallback: string | null, width: number}} PrimitiveStrokes */
  /** @typedef {PrimitiveStrokes & {regions: number[][][]}} BridgedPrimitives */
  /** @typedef {PrimitiveStrokes & {polygons: {outer: number[][], holes: number[][][]}[]}} PolygonPrimitives */
  /**
   * @overload
   * @param {object} item
   * @param {PrimitivePlacement & {keepHoles: true}} o
   * @returns {PolygonPrimitives}
   */
  /**
   * @overload
   * @param {object} item
   * @param {PrimitivePlacement & {keepHoles?: false}} [o]
   * @returns {BridgedPrimitives}
   */
  /**
   * @overload
   * @param {object} item
   * @param {PrimitivePlacement & {keepHoles?: boolean}} [o]
   * @returns {BridgedPrimitives | PolygonPrimitives}
   */
  /**
   * @param {object} item
   * @param {PrimitivePlacement & {keepHoles?: boolean}} [o]
   * @returns {BridgedPrimitives | PolygonPrimitives}
   */
  function toPrimitives(item, o = {}) {
    item = positioned(item, o);
    const l = layoutItem(item, o.layer), f = frameOf(item);
    const place = q => world(q, f);
    const strokes = l.strokes.map(s => ({points: s.points.map(place), width: s.width ?? l.width}));
    const metadata = {unsupported: l.unsupported, fallback: l.fallback, width: l.width};
    const bridge = poly => globalThis.AtriumVectorize.bridge(poly).map(place);
    if (o.keepHoles) {
      const polygons = l.polygons.map(poly => {
        const holes = (poly.holes || []).filter(h => h.length >= 3);
        if (holes.length) return {outer:poly.outer.map(place), holes:holes.map(h => h.map(place))};
        return {outer:bridge(poly), holes:[]};
      });
      return {strokes, polygons, ...metadata};
    }
    return {strokes, regions:l.polygons.map(bridge), ...metadata};
  }
  function physicalInk(item, doc, project, o) {
    return toPrimitives(placedInscription(item, doc, project, o), {layer:o.layer, keepHoles:true});
  }
  function edges(points, closed=false) {
    const result=[];
    for(let n=1;n<points.length;n++)result.push({kind:"line",a:points[n-1],b:points[n]});
    if(closed && !A().same(points.at(-1),points[0]))result.push({kind:"line",a:points.at(-1),b:points[0]});
    if(!closed && !result.length && points.length)result.push({kind:"line",a:points[0],b:points[0]});
    return result;
  }
  function collect({item,doc,project,defs,emit,diagnose}) {
    if(!item)return;
    function emitText(source, member, layer, role, frame, authoredDegrees=source.angle||0) {
      if(source.keepout || source.cutout || layer==="Drill drawing" && /^\.(?:legend|drilltable)$/i.test(String(source.text||"").trim()))return;
      const text=placedInscription(source,doc,project,{frame,layer});
      if(!text.text)return;
      const ink=toPrimitives(text,{layer,keepHoles:true});
      const metadata={text:{content:text.text,origin:[text.x||0,text.y||0],authoredDegrees,
        clockwiseDegrees:(((text.angle||0)+180)%360+360)%360-180,
        justification:PCB.textJustification(text),mirrored:PCB.textMirrored(text,layer)},net:text.net||null};
      if(ink.unsupported)diagnose(member,"text-unsupported-glyph");
      if(ink.fallback)diagnose(member,"text-font-fallback");
      for(const [i,path] of ink.strokes.entries())emit([...member,"stroke",String(i)],role,layer,
        {kind:"stroke",centerline:edges(path.points),width:path.width},metadata);
      for(const [i,poly] of ink.polygons.entries())emit([...member,"region",String(i)],role,layer,
        {kind:"region",islands:[{outer:edges(poly.outer,true),holes:poly.holes.map(h=>edges(h,true))}]},metadata);
    }
    if(item.kind==="part"){
      const def=PCB.readDefinition(defs,item.def,doc);
      if(!def?.footprint)return;
      for(const [i,shape] of (def.footprint.shapes||[]).entries())if(shape.kind==="text")
        emitText(shape,["shape",String(i)],PCB.shapeLayer(item,shape),"text",item);
      for(const row of PCB.partText(doc,item,def))emitText(row.text,row.member,row.text.layer,"legend",null,row.authoredDegrees);
    }else if(item.kind==="label")emitText(item,[],PCB.boardLayer(item),"text");
  }
  // A justified native ink rectangle is already exact. Culling, selecting, and
  // drawing a subpixel preview can use it without tracing a single glyph.
  function recordedBounds(item, layer,preview=false) {
    if (!item.sourceTextBox || !item.text) return null;
    const p = props(item,layer), b = p.sourceBox;
    if (!b || p.inverted || p.frame) return null;
    const w = b.width*p.height/b.size, h = b.height*p.height/b.size;
    if(b.mode==="baseline" && p.justify==="bottom-left"){
      if(!preview)return null;
      // At unreadable zoom this is the same low-detail mark as other labels.
      // The native height suffices without loading outlines to resolve descenders.
      const pen=p.font==="stroke"?p.width/2:0;
      return p.mirrored?[-w+pen,-h+pen,pen,pen]:[-pen,-h+pen,w-pen,pen];
    }
    const [v,j] = p.justify === "center" ? ["middle","center"] : p.justify.split("-");
    const m = p.sourceMode==="ink" && p.font==="stroke"?p.width/2:0;
    const x = j === "left" ? m : j === "right" ? -w-m : -w/2;
    const y = v === "top" ? m : v === "bottom" ? -h-m : -h/2;
    return p.mirrored ? [-(x+w),y,-x,y+h] : [x,y,x+w,y+h];
  }
  // An ordinary stroke label has the ink extents of its glyphs, translated by their advances.
  // A board overview can index thousands of distinct designators without building their paths.
  let glyphExtents = new WeakMap();
  function plainStrokeBox(item, p) {
    const text = item.text;
    if (typeof text !== "string" || !text || /[\\\r\n]/.test(text) || p.font !== "stroke" ||
        p.italic || p.inverted || p.frame || p.strokeFont === "kicad" || item.sourceTextBox) return null;
    const [vert, horiz] = p.justify === "center" ? ["middle", "center"] : p.justify.split("-");
    const chars = Array.from(text), advance = textUnits(chars.length);
    const start = horiz === "center" ? -advance / 2 : horiz === "right" ? -advance : 0;
    const unit = p.height / CAP, unitX = p.fontWidth / CAP, pad = p.width / 2;
    const baseline = vert === "top" ? p.height : vert === "middle" ? p.height / 2 : 0;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < chars.length; i++) {
      const lines = glyph(chars[i], p.strokeFont) || glyph("?", p.strokeFont);
      if (!glyphExtents.has(lines)) glyphExtents.set(lines, boxOf(lines.map(points => ({points})), [], 0));
      const box = glyphExtents.get(lines);
      if (!box) continue;
      const origin = start + i * ADVANCE;
      x0 = Math.min(x0,(origin + box[0]) * unitX - pad);
      x1 = Math.max(x1,(origin + box[2]) * unitX + pad);
      y0 = Math.min(y0,baseline - box[3] * unit - pad);
      y1 = Math.max(y1,baseline - box[1] * unit + pad);
    }
    if (x0 === Infinity) return null;
    return p.mirrored ? [-x1,y0,-x0,y1] : [x0,y0,x1,y1];
  }
  function worldBox(item,b) {
    const f = frameOf(item);
    const pts = rect(b[0], b[1], b[2], b[3]).map(q => world(q, f));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return [x0, y0, x1, y1];
  }
  // Exact bounds for editing and a conservative envelope for spatial indexing.
  // Many imported assembly pin labels have baseline-only records and are too
  // small to read at board zoom. Their native sizes suffice until a visible draw.
  function hitBox(item,o={}) {
    item = positioned(item,o);
    return worldBox(item,recordedBounds(item,o.layer) || layoutItem(item,o.layer).box);
  }
  function paintBox(item,o={}) {
    item = positioned(item,o);
    const p = props(item,o.layer), b = p.sourceBox || p.sourceFrame;
    if (!b || p.inverted || p.frame || !["baseline","frame"].includes(p.sourceMode)) {
      const ink = plainStrokeBox(item,p);
      return ink ? worldBox(item,ink) : hitBox(item,{layer:o.layer});
    }
    let w=b.width*p.height/b.size, h=b.height*p.height/b.size;
    if(p.sourceFrame){
      const words=String(item.text||"").split(/\s+/);
      for(const word of words)w=Math.max(w,3*p.height*word.length);
      h=Math.max(h,2*p.height*(words.length+1));
    }
    return worldBox(item,[-w-p.width,-h-p.width,w+p.width,h+p.width]);
  }
  // Oriented hit test: distance from p to the ink box (0 inside).
  function hitDistance(item, p, o = {}) {
    item = positioned(item,o);
    const f = frameOf(item), b = recordedBounds(item,o.layer) || layoutItem(item,o.layer).box;
    const r = -(f.angle || 0) * Math.PI / 180, dx = p[0] - f.x, dy = p[1] - f.y;
    const x = dx * Math.cos(r) - dy * Math.sin(r), y = dx * Math.sin(r) + dy * Math.cos(r);
    return Math.hypot(Math.max(b[0] - x, x - b[2], 0), Math.max(b[1] - y, y - b[3], 0));
  }
  // Corners of the oriented ink box in model coordinates.
  function corners(item, o = {}) {
    item = positioned(item,o);
    const f = frameOf(item), b = recordedBounds(item,o.layer) || layoutItem(item,o.layer).box;
    return rect(b[0], b[1], b[2], b[3]).map(q => world(q, f));
  }

  // ---------------------------------------------------------------------------
  // Canvas drawing in the current transform (world for board labels, part
  // frame for footprint text). Path2D objects are cached per layout.
  const paths = new WeakMap();
  function pathFor(l) {
    let c = paths.get(l);
    if (c) return c;
    c = {strokes: null, fill: null};
    if (typeof Path2D === "function") {
      if (l.strokes.length) {
        c.strokes = new Map();
        for (const s of l.strokes) {
          const w = s.width ?? l.width;
          let path = c.strokes.get(w);
          if (!path) { path = new Path2D(); c.strokes.set(w, path); }
          s.points.forEach((q, i) => i ? path.lineTo(q[0], q[1]) : path.moveTo(q[0], q[1]));
          if (s.points.length === 1) path.lineTo(s.points[0][0], s.points[0][1]);
        }
      }
      if (l.polygons.length) {
        c.fill = new Path2D();
        for (const poly of l.polygons) for (const ring of [poly.outer, ...poly.holes]) {
          ring.forEach((q, i) => i ? c.fill.lineTo(q[0], q[1]) : c.fill.moveTo(q[0], q[1]));
          c.fill.closePath();
        }
      }
    }
    paths.set(l, c);
    return c;
  }
  // draw(ctx, item, scale, ink, {layer, lod}) -> false if nothing was drawn.
  function draw(ctx, item, scale, ink, o = {}, bandBounds) {
    if (!item.text) return false;
    item = positioned(item,o);
    ctx.save();
    ctx.translate(item.x || 0, item.y || 0);
    if (item.angle) ctx.rotate((item.angle || 0) * Math.PI / 180);
    const lod = o.lod ?? 3;
    if ((item.size || .75) * scale < lod) {
      const b = recordedBounds(item,o.layer,true) || layoutItem(item,o.layer).box;
      ctx.globalAlpha *= .4; ctx.fillStyle = ink;
      const w = Math.max(b[2] - b[0], 1 / scale), h = Math.max(b[3] - b[1], 1 / scale);
      bandBounds?.(ctx, b[0], b[1], b[0] + w, b[1] + h);
      ctx.fillRect(b[0], b[1], w, h);
      ctx.restore();
      return true;
    }
    const l = layoutItem(item,o.layer), c = pathFor(l);
    if (bandBounds && (c.fill || c.strokes)) {
      if (l.polygons.some(p => p.holes.length)) bandBounds(null);
      else {
        const [x0, y0, x1, y1] = l.box, pad = c.strokes ? .4 / scale : 0;
        bandBounds(ctx, x0 - pad, y0 - pad, x1 + pad, y1 + pad);
      }
    }
    if (c.fill) { ctx.fillStyle = ink; ctx.fill(c.fill, "nonzero"); }
    if (c.strokes) {
      ctx.strokeStyle = ink; ctx.lineCap = "round"; ctx.lineJoin = "round";
      for (const [w, path] of c.strokes) { ctx.lineWidth = Math.max(w, .8 / scale); ctx.stroke(path); }
    }
    ctx.restore();
    return true;
  }

  // ---------------------------------------------------------------------------
  // KiCad: native text for stroke text, polygons for everything else.
  // Returns {mode:"text", size, thickness, bold, italic, justify, mirror}
  // or {mode:"poly", regions} (regions in the item's parent frame).
  function kicad(item, o = {}) {
    const p = props(item, o.layer);
    if (p.font === "stroke" && !p.inverted && !p.frame && !p.sourceBox) {
      const [vert, horiz] = p.justify === "center" ? ["middle", "center"] : p.justify.split("-");
      const justify = [horiz === "center" ? "" : horiz, vert === "middle" ? "" : vert, p.mirrored ? "mirror" : ""].filter(Boolean).join(" ");
      return {mode: "text", size: p.height, fontWidth: p.fontWidth, thickness: p.width, bold: false, italic: p.italic, justify, mirror: p.mirrored,
        note: p.strokeFont === "sans" || p.strokeFont === "serif" ? "Sans Serif and Serif stroke text was exported in KiCad's stroke font." : null};
    }
    const prim = toPrimitives(item, {layer: o.layer});
    return {mode: "poly", regions: prim.regions, strokes: prim.strokes, width: prim.width};
  }

  // Model validation for the text fields (used by model.validate).
  // lenient: a file from a newer version: an unknown font, stroke font, justification or barcode
  // setting is kept as written; props() draws it with the defaults.
  function valid(i, lenient) {
    const n = v => v == null || (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e4);
    const b = v => v == null || typeof v === "boolean";
    const s = (v, list) => v == null || (typeof v === "string" && (!list || list.includes(v) || lenient && v.length <= 64));
    if (!n(i.size) || !n(i.fontWidth) || i.fontWidth === 0 || !n(i.width) || !n(i.lineSpacing) || !n(i.margin)) return false;
    if (!s(i.font, ["stroke", "truetype", "barcode"]) || !s(i.strokeFont, ["default", "sans", "serif", "kicad"]) || !s(i.justify, JUSTIFY) || !s(i.family)) return false;
    if (!b(i.bold) || !b(i.italic) || !b(i.mirrored) || !b(i.inverted) || !b(i.frame)) return false;
    if (i.barcode != null) {
      const c = i.barcode;
      if (typeof c !== "object" || Array.isArray(c) || !s(c.type, ["code39", "code128", "qr"]) || !n(c.module) || !n(c.quiet) || !n(c.ratio) || !b(c.text) || !s(c.ecc, ["L", "M", "Q", "H"])) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Keep the inspector in its original position while its controls load on first selection.
  function inspector(container, item, apply, units = "mm", o = {}) {
    const root = (container.ownerDocument || document).createElement("div");
    root.className = "pcbtext-inspector";
    container.append(root);
    const fill = (ui, target) => ui.fill(target, item, apply, units, o);
    if (globalThis.AtriumPCBTextInspector) fill(globalThis.AtriumPCBTextInspector, root);
    else globalThis.AtriumLazy?.appendOnLoad("AtriumPCBTextInspector", root, fill, o.info);
    return root;
  }

  return {CAP, ADVANCE, GLYPH, JUSTIFY, glyphSource, glyphs, glyph, supported, strokeText, textUnits,
    props, layout, layoutItem, hasProjectText, projectItem, withLetters, toPrimitives, physicalInk, collect, hitBox, paintBox, hitDistance, corners, draw, kicad, valid, inspector,
    setGlyphSource: src => { richText(true).setGlyphSource(src); }, signature, clearCache};
})();
