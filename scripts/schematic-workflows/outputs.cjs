"use strict";

const assert = require("node:assert/strict");
const {menu} = require("./browser.cjs");

async function print(page) {
  const built = await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumPrint", "AtriumOutputJobs"]);
    const h = AtriumNavHost, p = h.project(), d = h.doc(), print = AtriumPrint;
    const box = AtriumSchAppearance.drawingBounds(d, h.defs());
    const scale = Math.max(.4, 345 / Math.max(box[2] - box[0], box[3] - box[1]));
    const options = {documents: [d.id], paper: "A4", infiniteScale: scale};
    const pdfPages = bytes => {
      const pdf = new TextDecoder().decode(bytes);
      if (!pdf.startsWith("%PDF-")) return 0;
      return (pdf.match(/\/Type\s*\/Page\b/g) || []).length;
    };
    const cases = ["fit", "frames", "tile"];
    const checks = cases.map(infiniteLayout => {
      const each = {...options, infiniteLayout};
      const r = print.build(p, each);
      const o = AtriumOutputJobs.run(p, {name: "QA schematic PDF", folder: "qa", outputs: [{kind: "pdf", options: each}]});
      const file = o.files.find(f => f.name.endsWith(".pdf"));
      return {pages: r.pages.length, pdf: pdfPages(r.bytes()), output: file ? pdfPages(file.data) : 0,
        overlap: r.notes.some(n => /6 mm overlap/.test(n))
          && r.pages.every(page => /overlap 6 mm/.test(page.list.map(op => op.u || "").join("")))
          && r.pages.some(page => page.list.some(op => op.dash?.length)),
        scale: r.pages[0].scale, named: r.pages.some(page => page.label === "QA circuit")};
    });
    return {checks, scale};
  });
  const [fit, frames, tile] = built.checks;
  for (const entry of built.checks) assert.equal(entry.pages === entry.pdf && entry.pdf === entry.output, true,
    "Print, PDF file and Output Job produced a different number of pages.");
  assert.equal(fit.pages, 1);
  assert.equal(frames.pages, 1);
  assert.ok(frames.named, "The frame page did not use the frame's title.");
  assert.ok(tile.pages > 1 && tile.overlap && Math.abs(tile.scale - built.scale * 72 / 25.4) < 1e-6, "Tiled output lacked the specified scale or overlap.");

  await page.evaluate(() => {
    window.print = () => {
      window.__printedPageCount = document.querySelectorAll("#atrium-print-root .atrium-print-page").length;
      window.dispatchEvent(new Event("afterprint"));
    };
  });
  await menu(page, "file", "print");
  const dialog = page.getByRole("dialog", {name: "Print", exact: true});
  await dialog.getByRole("button", {name: "Current document", exact: true}).click();
  const layout = dialog.getByRole("combobox", {name: "Layout", exact: true});
  assert.deepEqual(await layout.locator("option").evaluateAll(options => options.map(o => o.value)), ["fit", "frames", "tile"]);
  await layout.selectOption("frames");
  await dialog.getByRole("button", {name: "Print…", exact: true}).click();
  await page.waitForFunction(() => window.__printedPageCount === 1);
  await dialog.getByRole("button", {name: "Close", exact: true}).click();
  return {fit: fit.pages, frames: frames.pages, tile: tile.pages, overlap: true, pdfAndOutput: true, printCommand: true};
}

async function exportDrawing(page, oversized) {
  const result = await page.evaluate(async oversized => {
    await AtriumLazy.need(["AtriumAltiumExport", "AtriumKiCad", "AtriumSexpr", "AtriumFrameConversion", "AtriumTranslatorClient"]);
    const h = AtriumNavHost, p = h.project(), d = h.doc(), S = AtriumSchematicOutput;
    const box = Atrium.bounds(d.items.flatMap(i => Atrium.itemPoints(i, h.defs().get(i.def), d.kind)));
    const k = AtriumKiCadSchematic.exportSheet(p, d.id);
    const [kind, width, height] = AtriumSexpr.one(AtriumSexpr.parse(k.content), "paper").slice(1);
    const a = AtriumAltiumExport.exportSchematic(p, d.id);
    const drawing = a.content.split(/\r?\n/).find(line => line.includes("|RECORD=31|"));
    const fields = Object.fromEntries(drawing.split("|").slice(1).map(field => field.split("=")));
    const covers = (width, height, maximum) =>
      width <= maximum && height <= maximum && width >= box[2] - box[0] - .001 && height >= box[3] - box[1] - .001;
    let split = null;
    if (oversized) {
      const test = Atrium.project("Oversized public export check", []);
      const doc = test.documents[0];
      doc.sheet = {infinite: true, titleBlock: "none"};
      for (const [k, x] of [10, 4200].entries()) {
        doc.items.push(AtriumSchObjects.make("frame", [x - 3, 7], {text: "Export frame " + (k + 1), w: 40, h: 24}),
          {id: Atrium.id(), kind: "wire", points: [[x, 12], [x + 11, 12]]},
          {id: Atrium.id(), kind: "netlabel", text: "SOURCE_" + (k + 1), x, y: 12});
      }
      split = await Promise.all(["altium", "kicad"].map(async format => {
        let asks = false;
        const options = {scope:"document",documentId:doc.id};
        try { await AtriumTranslatorClient.export(format,test,options); } catch (error) { asks = /one sheet per frame/i.test(error.message); }
        const original = JSON.stringify(test);
        const result = await AtriumTranslatorClient.export(format,test,{...options,pageMode:"frames"});
        return {asks, children: result.files.filter(f => /\.(SchDoc|kicad_sch)$/i.test(f.name)).length - 1,
          unchanged: JSON.stringify(test) === original, report: result.report.notes.some(n => /one sheet per frame/i.test(n))};
      }));
    }
    return {
      kicad: kind === "User" && covers(+width, +height, 3048) && k.diagnostics.some(n => /custom paper/i.test(n)),
      altium: fields.USECUSTOMSHEET === "T" && covers(+fields.CUSTOMX * .254, +fields.CUSTOMY * .254, 1651)
        && a.diagnostics.some(n => /custom paper/i.test(n)),
      split,
    };
  }, oversized);
  assert.ok(result.altium && result.kicad, "A foreign writer omitted valid custom paper or its fidelity note.");
  if (result.split) for (const f of result.split) assert.ok(f.asks && f.unchanged && f.children === 2 && f.report,
    "Oversized drawing did not yield a read-only two-child export with a reported page choice.");
  return {altiumCustom: true, kicadCustom: true, oversizedSplit: Boolean(result.split)};
}

module.exports = {print, exportDrawing};
