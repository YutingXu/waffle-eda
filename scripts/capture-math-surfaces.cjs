#!/usr/bin/env node
"use strict";

// Render the actual candidate's output through Canvas2D, SVG and the PDF writer.
// Raster comparison and independent XeTeX metrics run outside the renderer.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {parseArgs} = require("node:util");
const {chromium} = require("playwright-core");
const {corpus} = require("./check-math-reference.cjs");

const mathFiles = ["vendor/stix-two-math.js", "notebook/math-font.js", "notebook/math-tex.js", "notebook/math.js"];
const printFiles = ["core/path-record.js", "formats/pdf.js", "formats/pdf-fonts.js", "formats/print.js", "notebook/math-pdf.js"];
const surfaces = ["canvas", "svg", "standalone-svg"];

async function main() {
  const {values} = parseArgs({options: {
    "math-app": {type: "string"},
    "print-app": {type: "string"},
    output: {type: "string"},
    case: {type: "string", multiple: true},
  }});
  const ownApp = path.resolve(__dirname, "../app");
  const mathApp = path.resolve(values["math-app"] || ownApp);
  const printApp = path.resolve(values["print-app"] || mathApp);
  assert.ok(values.output, "Choose a temporary destination with --output.");
  const {all} = corpus(), examples = all.filter(c => c.errorAt === undefined && (!values.case || values.case.includes(c.id)));
  assert.ok(examples.length, "Choose existing renderable cases.");
  const browser = await chromium.launch({headless: true,
    ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"}),
  });
  try {
    const page = await browser.newPage();
    await page.route(/^https?:/, route => route.abort());
    for (const [app, files] of [[mathApp, mathFiles], [printApp, printFiles]]) {
      for (const file of files) await page.addScriptTag({path: path.join(app, file)});
    }
    const result = await page.evaluate(async examples => {
      const pointsPerInch = 72, dpi = 192, scale = dpi / pointsPerInch;
      const fontSize = 24 * pointsPerInch / 72.27, ink = "#000";
      const doc = AtriumPDF.document({title: "Schematic maths surface parity", date: new Date("2026-01-01T00:00:00Z")});
      const makeCanvas = (w, h) => {
        const c = document.createElement("canvas");
        c.width = Math.ceil(w * scale);
        c.height = Math.ceil(h * scale);
        return c;
      };
      const png = c => c.toDataURL("image/png").split(",")[1];
      const raster = async (xml, c, w, h) => {
        const url = URL.createObjectURL(new Blob([xml], {type: "image/svg+xml"}));
        try {
          const img = new Image();
          img.src = url;
          await img.decode();
          const ctx = c.getContext("2d");
          ctx.fillStyle = "#fff";
          ctx.fillRect(0, 0, c.width, c.height);
          ctx.drawImage(img, 0, 0, w * scale, h * scale);
          return png(c);
        } finally { URL.revokeObjectURL(url); }
      };
      const placeSVG = (source, w, h, x, y) => {
        const ns = "http://www.w3.org/2000/svg";
        const inner = new DOMParser().parseFromString(source, "image/svg+xml").documentElement;
        const [left, top] = inner.getAttribute("viewBox").split(/\s+/).map(Number);
        inner.setAttribute("x", x + left * fontSize);
        inner.setAttribute("y", y + top * fontSize);
        const outer = document.createElementNS(ns, "svg");
        outer.setAttribute("width", w);
        outer.setAttribute("height", h);
        outer.setAttribute("viewBox", "0 0 " + w + " " + h);
        outer.append(inner);
        return new XMLSerializer().serializeToString(outer);
      };
      const cases = [];
      for (const item of examples) {
        const l = AtriumMath.layout(item.tex, {display: item.display});
        if (l.errors.length || !l.commands.length) throw Error(item.id + " produced no drawable layout.");
        const x = 20, y = Math.max(70, Math.ceil(fontSize * l.ascent) + 20);
        const w = Math.max(160, Math.ceil(fontSize * l.advance) + 40);
        const h = Math.max(120, y + Math.ceil(fontSize * l.descent) + 23);
        const c = makeCanvas(w, h), live = c.getContext("2d");
        live.scale(scale, scale);
        live.fillStyle = "#fff";
        live.fillRect(0, 0, w + 1, h + 1);
        AtriumMath.draw(live, l, {x, y, size: fontSize, ink});

        const pdf = AtriumPDF.recorder(w, h);
        AtriumMath.draw(pdf.ctx, l, {x, y, size: fontSize, ink});
        doc.page(w, h, pdf.list);
        const preview = AtriumPDF.svg(w, h, pdf.list);
        const standalone = placeSVG(AtriumMath.svg(l, {size: fontSize, ink}), w, h, x, y);
        cases.push({id: item.id, plain: l.plain, origin: [x * scale, y * scale], canvas: png(c),
          svg: await raster(preview, makeCanvas(w, h), w, h),
          "standalone-svg": await raster(standalone, makeCanvas(w, h), w, h)});
      }
      const packed = bytes => {
        const chunks = [];
        for (let i = 0; i < bytes.length; i += 8192) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
        return btoa(chunks.join(""));
      };
      const pdf = packed(doc.bytes()), sameBytes = pdf === packed(doc.bytes());
      return {dpi, cases, pdf, sameBytes};
    }, examples);
    assert.ok(result.sameBytes, "The PDF writer produced different bytes for the same pages.");
    const destination = path.resolve(values.output);
    await Promise.all(surfaces.map(s => fs.mkdir(path.join(destination, s), {recursive: true})));
    await fs.writeFile(path.join(destination, "math.pdf"), Buffer.from(result.pdf, "base64"));
    for (const row of result.cases) await Promise.all(surfaces.map(s =>
      fs.writeFile(path.join(destination, s, row.id + ".png"), Buffer.from(row[s], "base64"))));
    const cases = result.cases.map(({id, plain, origin}) => ({id, plain, origin}));
    await fs.writeFile(path.join(destination, "surfaces.json"), JSON.stringify({dpi: result.dpi, cases}, null, 2) + "\n");
    console.log("Rendered " + cases.length + " formulas through Canvas2D, both SVG paths and the deterministic PDF writer.");
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
