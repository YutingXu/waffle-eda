"use strict";
// Report printing (app/formats/print-report.js): tables laid out as PDF pages with repeated header rows,
// fitted and wrapped columns, page numbers and the automatic orientation, and the BOM and Messages
// reports that use it.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "pcb-text", "path-record", "pdf", "vendor/dejavu-sans", "pdf-fonts", "print", "print-report"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const R = AtriumPrintReport, MM = 72 / 25.4;
const date = new Date(Date.UTC(2026, 10, 22));
const texts = page => page.list.filter(op => op.k === "t").map(op => op.u ?? op.s ?? "");
const has = (page, s) => texts(page).some(t => t.includes(s));
const latin = bytes => { let s = ""; for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192)); return s; };
function pdfPages(bytes) {
  assert.ok(bytes instanceof Uint8Array && bytes.length > 500, "non-empty PDF bytes");
  const s = latin(bytes);
  assert.equal(s.slice(0, 5), "%PDF-", "%PDF header");
  assert.match(s.slice(-64), /%%EOF\s*$/, "%%EOF trailer");
  return (s.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
}

// The text op's field: the recorder writes .u (Unicode) for the embedded font.
{
  const r = R.layout({title: "Probe", sections: [{columns: [{label: "A"}], rows: [["x"]]}]}, {date});
  const ops = r.pages[0].list.filter(op => op.k === "t");
  assert.ok(ops.length && ops.some(op => /Probe/.test(op.u ?? op.s ?? "")), "title is real text in the page");
}

// Narrow table: portrait, one page, headers once, footer with "Waffle EDA" and the page number.
{
  const r = R.layout({title: "Short list", subtitle: "Demo · 2026-11-22", sections: [{columns: [{label: "Ref"}, {label: "Qty", numeric: true}], rows: [["R1", 1], ["R2", 2]]}]}, {date});
  assert.equal(r.orientation, "portrait");
  assert.equal(r.pages.length, 1);
  const [w, h] = [r.pages[0].w, r.pages[0].h];
  assert.ok(Math.abs(w - 210 * MM) < .01 && Math.abs(h - 297 * MM) < .01, "A4 portrait from print.js's paper table");
  assert.ok(has(r.pages[0], "Waffle EDA") && has(r.pages[0], "Page 1 of 1"));
  assert.equal(pdfPages(r.bytes()), 1);
}

// A wide, long table: landscape automatically, header repeated on every page, rows never lost.
const columns = ["Line", "Comment", "Description", "Designator", "Footprint", "Manufacturer", "Manufacturer Part Number", "Supplier", "Supplier PN", "Quantity"]
  .map((label, i) => ({label, numeric: i === 0 || i === 9}));
const rows = Array.from({length: 240}, (_, i) => [i + 1, "10k", "Thick film resistor, 1 %, 0.1 W, AEC-Q200 qualified " + "x".repeat(i % 7),
  Array.from({length: 1 + i % 30}, (_, k) => "R" + (i * 40 + k)).join(", "), "RESC1608X55N", "Yageo", "RC0603FR-0710KL" + i, "Digi-Key", "311-10.0KHRCT-ND", 1 + i % 30]);
{
  const r = R.layout({title: "Bill of Materials", subtitle: "Big board · Variant A · 2026-11-22", meta: [["Source", "Schematic · 4 sheets"], ["Total parts", 3720]],
    sections: [{columns, rows}]}, {date});
  assert.equal(r.orientation, "landscape", "a ten-column BOM turns the page");
  assert.ok(r.pages[0].w > r.pages[0].h);
  assert.ok(r.pages.length >= 4, "the table breaks across pages (" + r.pages.length + ")");
  r.pages.forEach((p, n) => {
    assert.ok(has(p, "Supplier PN"), "header row on page " + (n + 1));
    assert.ok(has(p, "Page " + (n + 1) + " of " + r.pages.length), "page number on page " + (n + 1));
    assert.ok(has(p, "Waffle EDA"));
  });
  // Every row's unique part number is printed once, in order.
  const seen = r.pages.flatMap(texts).filter(t => /^RC0603FR-0710KL\d+$/.test(t)).map(t => +t.slice(15));
  assert.deepEqual(seen, rows.map((_, i) => i));
  // Long designator lists wrap within their column: more than one text line holds R designators for row 30.
  const lines = r.pages.flatMap(texts).filter(t => /\bR11(99|8\d)\b/.test(t));
  assert.ok(lines.length >= 1);
  const wrapped = r.pages.flatMap(texts).filter(t => /^R\d+,/.test(t) || /, R\d+$/.test(t));
  assert.ok(wrapped.length > rows.length, "designator cells wrap to several lines");
  // Nothing is drawn past the right margin or into the footer.
  for (const p of r.pages) for (const op of p.list) if (op.k === "t" && op.m) assert.ok(op.m[4] <= p.w - 12 * MM + .5, "text inside the margin");
  assert.equal(pdfPages(r.bytes()), r.pages.length, "PDF page count matches the layout");
  // Overrides: portrait on request, and Letter paper.
  const p = R.layout({title: "BOM", sections: [{columns, rows: rows.slice(0, 20)}]}, {orientation: "portrait", paper: "Letter", date});
  assert.equal(p.orientation, "portrait");
  assert.ok(Math.abs(p.pages[0].w - 215.9 * MM) < .01);
  assert.ok(has(p.pages[0], "Supplier PN"));
}

// Wrapping: words, then characters for a word wider than the column; fitted widths fill the room.
{
  const measure = (t) => t.length * 5;
  assert.deepEqual(R.wrap("C1, C2, C3, C4", 40, "", measure), ["C1, C2,", "C3, C4"]);
  assert.deepEqual(R.wrap("ABCDEFGHIJ", 25, "", measure), ["ABCDE", "FGHIJ"]);
  assert.deepEqual(R.wrap("a\nb", 100, "", measure), ["a", "b"]);
  const w = R.fit([{want: 50, min: 20, numeric: true}, {want: 100, min: 30}], 300);
  assert.equal(Math.round(w[0] + w[1]), 300); assert.equal(w[0], 50, "numeric columns keep their width");
  const s = R.fit([{want: 200, min: 40}, {want: 200, min: 60}], 200);
  assert.ok(Math.abs(s[0] + s[1] - 200) < 1e-9 && s[0] >= 40 && s[1] >= 60);
}

// A row taller than a page splits across pages instead of overflowing.
{
  const tall = "word ".repeat(4000);
  const r = R.layout({title: "Tall", sections: [{columns: [{label: "Text"}], rows: [[tall]]}]}, {date});
  assert.ok(r.pages.length >= 2);
  for (const p of r.pages) for (const op of p.list) if (op.k === "t" && op.m) assert.ok(op.m[5] <= p.h, "inside the page");
  assert.equal(pdfPages(r.bytes()), r.pages.length);
}

// Empty tables print a note; the file name follows the report.
{
  const r = R.layout({title: "Nothing", name: "Demo-BOM.pdf", sections: [{columns: [{label: "A"}], rows: [], empty: "No lines."}]}, {date});
  assert.ok(has(r.pages[0], "No lines."));
  assert.equal(r.name, "Demo-BOM.pdf");
  assert.equal(R.fileName({title: "a/b"}), "a-b.pdf");
}

// The BOM's printable report and Messages' report go through the same layout.
{
  require("../../app/project/variants.js"); require("../../app/schematic/multichannel.js"); require("../../app/formats/bom.js");
  const p = AtriumParts.example(), b = AtriumBOM.report(p, {now: date});
  const spec = AtriumBOM.printable(b);
  assert.equal(spec.name, AtriumBOM.fileName(p.name, "pdf"));
  assert.ok(spec.subtitle.includes(b.date));
  const r = R.layout(spec, {date});
  assert.ok(has(r.pages[0], "Bill of Materials") && has(r.pages[0], b.columns[0].label));
  assert.ok(pdfPages(r.bytes()) >= 1);
}
console.log("print-report ok");
