"use strict";
// Embedded Unicode fonts in AtriumPDF (app/formats/pdf-fonts.js, app/vendor/dejavu-sans.js): TrueType
// parsing, per-PDF subsetting, Type 0 / CIDFontType2 objects with ToUnicode, measurement, and
// the tiling helpers (AtriumPDF.tiles/shift).
const assert = require("node:assert/strict");
for (const m of ["path-record", "pdf", "vendor/dejavu-sans", "pdf-fonts"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const P = AtriumPDF, F = AtriumPDFFonts;

// ---- the vendored font parses and covers the symbols drawings need ----
const font = F.font();
assert(font, "DejaVu Sans parses");
assert.equal(font.unitsPerEm, 2048);
assert.equal(font.name, "DejaVuSans");
for (const ch of "AZaz09 µΩ±≤≥×°⌀→€√∅∞ПЖ✓") assert(font.gid(ch.codePointAt(0)) > 0, "glyph for " + ch);
assert(font.cellHeight>font.unitsPerEm);
const contours=ch=>font.contours(font.gid(ch.codePointAt(0)));
assert.equal(contours(" ").length,0);
assert.equal(contours("O").length,2,"outer contour and counter");
assert(contours("é").length>1 && contours("A").every(r=>r.length>=3),"simple and composite outlines");
assert.equal(font.gid(0x4e2d), 0, "CJK is outside the subset");
assert(P.embeddedFont === font, "pdf-fonts.js registers the font on load");
assert.equal(F.decode("V2FmZmxl").length, 6);
assert.equal(String.fromCharCode(...F.decode("V2FmZmxl")), "Waffle");

// ---- measuring uses the embedded advances ----
const r = P.runs("1 kΩ", "H");
assert.equal(r.runs.length, 1, "one run: Ω is in the font, not a stroke glyph");
assert.equal(r.runs[0].f, "U");
assert.equal(r.runs[0].g.length, 4);
const expect = [..."1 kΩ"].reduce((w, ch) => w + font.advance(font.gid(ch.codePointAt(0))) / 2048, 0);
assert(Math.abs(r.width - expect) < 1e-9);
assert.equal(P.runs("Bold", "HB").runs[0].f, "UB");

// ---- subsetting keeps glyph IDs, empties the rest and stays a valid sfnt ----
const used = [font.gid(65), font.gid(0x3a9)], sub = F.parse(font.subset(used));
assert(sub.bytes.length < font.bytes.length / 4, "subset is small: " + sub.bytes.length);
assert.equal(sub.numGlyphs, font.numGlyphs, "glyph IDs are kept");
assert.equal(sub.gid(65), font.gid(65));
assert.equal(sub.advance(font.gid(65)), font.advance(font.gid(65)));
{
  // Table checksums and the whole-font adjustment (0xB1B0AFBA).
  const b = font.subset(used), u32 = p => (b[p] << 24 >>> 0) + (b[p + 1] << 16 | b[p + 2] << 8 | b[p + 3]);
  let total = 0;
  for (let i = 0; i < b.length; i += 4) total = total + u32(i) >>> 0;
  assert.equal(total, 0xb1b0afba, "checkSumAdjustment");
}

// ---- a PDF with text: Type 0 font, FontFile2, ToUnicode, widths; deterministic ----
function pdfOf(lines, compress = false) {
  const rec = [];
  for (const [i, t] of lines.entries()) {
    const g = P.runs(t, "H").runs[0];
    rec.push({k: "t", f: "U", s: "", u: g.u, g: g.g, m: [10, 0, 0, -10, 20, 40 + 20 * i], c: [0, 0, 0, 1], a: 1, sw: 0, clip: null});
  }
  rec.push({k: "p", d: [0, 10, 10, 1, 100, 10, 1, 100, 100, 3], c: [0, 0, 0, 1], a: 1, w: 1, cap: "butt", join: "miter"});
  const doc = P.document({title: "Fonts", compress});
  doc.page(595.28, 841.89, rec);
  return doc.bytes();
}
const bytes = pdfOf(["R1 10 kΩ ±1 %", "⌀0.8 mm ≤ 2 µA"]), text = String.fromCharCode(...bytes);
assert.match(text, /\/Subtype \/Type0 \/BaseFont \/[A-Z]{6}\+DejaVuSans \/Encoding \/Identity-H/);
assert.match(text, /\/Subtype \/CIDFontType2/);
assert.match(text, /\/CIDToGIDMap \/Identity/);
assert.match(text, /\/FontFile2 \d+ 0 R/);
assert.match(text, /\/ToUnicode \d+ 0 R/);
assert.doesNotMatch(text, /\/BaseFont \/Helvetica/, "no standard-14 font when the embedded one is used");
assert.match(text, /\/MediaBox \[0 0 595\.28 841\.89\]/);
assert.match(text, /<[0-9a-f]{8,}> Tj/, "hex glyph strings");
const ohm = font.gid(0x3a9).toString(16).toUpperCase().padStart(4, "0");
assert(text.includes("<" + ohm + "> <03A9>"), "ToUnicode maps Ω back to U+03A9");
// The embedded program is the subset: its declared length is small and it starts as an sfnt.
const m = /\/Length1 (\d+) \/Length (\d+) >>\nstream\n/.exec(text);
assert(m && +m[1] < 30000, "subset program " + (m && m[1]) + " bytes");
const start = text.indexOf(m[0]) + m[0].length;
assert.deepEqual([...bytes.subarray(start, start + 4)], [0, 1, 0, 0], "uncompressed FontFile2 is a TrueType sfnt");
assert.deepEqual(pdfOf(["R1 10 kΩ ±1 %", "⌀0.8 mm ≤ 2 µA"]), bytes, "deterministic");
assert(pdfOf(["R1 10 kΩ"], true).length < bytes.length, "compressed");

// ---- tiling helpers ----
const grid = P.tiles(1000, 500, [20, 20, 420, 300], 10);
assert.equal(grid[0].cols, 3); assert.equal(grid[0].rows, 2); assert.equal(grid.length, 6);
assert.deepEqual([grid[1].x, grid[1].y, grid[3].x, grid[3].y], [390, 0, 0, 270]);
assert.equal(P.tiles(100, 100, [0, 0, 200, 200]).length, 1, "a small drawing is one tile");
const op = {k: "p", d: [0, 1, 2, 2, 1, 1, 2, 2, 3, 3, 3], c: [0, 0, 0, 1], a: 1, clip: {d: [0, 0, 0, 1, 5, 5, 3], parent: null}};
const [moved] = P.shift([op], 10, 20, [0, 0, 50, 50]);
assert.deepEqual(moved.d, [0, 11, 22, 2, 11, 21, 12, 22, 13, 23, 3]);
assert.deepEqual(moved.clip.d, [0, 10, 20, 1, 15, 25, 3]);
assert.deepEqual(moved.clip.parent.d.slice(0, 3), [0, 0, 0], "tile clip at the root of the chain");
assert.equal(op.d[1], 1, "the source list is unchanged");
assert.deepEqual(P.counts([op, {k: "t"}, {k: "i"}]), {paths: 1, text: 1, images: 1});
// Without a font, text falls back to the standard 14 fonts again.
P.useFont(null);
assert.equal(P.runs("AB", "H").width, 1.334);
assert(F.install());
console.log("pdf-fonts ok");
