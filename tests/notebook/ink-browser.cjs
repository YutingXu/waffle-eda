"use strict";

// Review-only integration probe. Pass a checkout with the task 41 input
// foundation. Load the geometry from this checkout into its isolated window.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("../support/playwright.cjs");

async function run() {
  const foundation = process.argv[2] || path.join(__dirname, "../..");
  const browser = await chromium.launch({channel: "chrome", headless: true, args: ["--allow-file-access-from-files"]});
  try {
    const page = await browser.newPage({viewport: {width: 1200, height: 800}, reducedMotion: "reduce"});
    await page.route(/^https?:\/\//, route => route.abort());
    await page.goto(pathToFileURL(path.resolve(foundation, "app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#document-tabs [data-kind=schematic]").first().click();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.doc().kind === "schematic");
    await page.evaluate(() => AtriumLazy.need("AtriumCamera").then(() => true));
    await page.evaluate(fs.readFileSync(path.join(__dirname, "../../app/notebook/sch-note-ink.js"), "utf8"));
    const proof = await page.evaluate(() => {
      const canvas = AtriumNavHost.canvas(), box = canvas.getBoundingClientRect();
      const before = JSON.stringify(AtriumNavHost.doc()), traces = [], completed = [], drafts = new Map(), erasers = new Map();
      let eraserHits = 0;
      const x = box.left + box.width / 2, y = box.top + box.height / 2;
      AtriumCanvasInput.setSketchActive(canvas, true);
      canvas.addEventListener("waffle-sketch-input", e => {
        const d = e.detail; traces.push([d.pointerType, d.pointerId, d.phase]);
        if (d.phase === "start" && d.eraser) {
          e.preventDefault(); erasers.set(d.pointerId, {last: d.world, hits: new Set()});
        }
        const erase = erasers.get(d.pointerId);
        if (erase) {
          for (const s of d.samples) {
            for (const stroke of completed) if (AtriumSchNoteInk.hit(stroke.points, {width: .48, brush: "pen"}, erase.last, s.world, .25)) erase.hits.add(stroke);
            erase.last = s.world;
          }
          if (d.phase === "end") eraserHits = erase.hits.size;
          if (d.phase === "end" || d.phase === "cancel") erasers.delete(d.pointerId);
          return;
        }
        if (d.phase === "start") {
          e.preventDefault();
          drafts.set(d.pointerId, AtriumSchNoteInk.capture(d.pointerType, .48));
        }
        const draft = drafts.get(d.pointerId);
        if (d.phase === "end") {
          completed.push({type: d.pointerType, points: draft.finish(d.samples)});
          drafts.delete(d.pointerId);
        } else if (d.phase === "cancel") {
          draft.cancel(); drafts.delete(d.pointerId);
        } else draft.append(d.samples);
      });
      function send(id, type, phase, dx, pressure, eraser = false) {
        const down = phase === "down", up = phase === "up";
        canvas.dispatchEvent(new PointerEvent("pointer" + phase, {bubbles: true, cancelable: true, pointerType: type,
          pointerId: id, clientX: x + dx, clientY: y + dx / 2, isPrimary: true,
          button: down || up ? (eraser ? 5 : 0) : -1, buttons: up ? 0 : eraser ? 32 : 1, pressure}));
      }
      send(1, "pen", "down", 0, .2); send(2, "touch", "down", 2, .5);
      send(1, "pen", "move", 10, .8); send(2, "touch", "up", 2, 0); send(1, "pen", "up", 20, 0);
      for (const [id, type] of [[3, "mouse"], [4, "touch"]]) {
        send(id, type, "down", 0, .5); send(id, type, "move", 12, .5); send(id, type, "up", 16, 0);
      }
      send(5, "touch", "down", 0, .5); send(5, "touch", "move", 6, .5);
      send(6, "touch", "down", 18, .5); send(6, "touch", "up", 18, 0); send(5, "touch", "up", 6, 0);
      send(7, "pen", "down", 0, .6, true); send(7, "pen", "move", 10, .8, true); send(7, "pen", "up", 12, 0, true);
      AtriumCanvasInput.setSketchActive(canvas, false);

      const surface = document.createElement("canvas"); surface.width = 64; surface.height = 64;
      const ctx = surface.getContext("2d", {willReadFrequently: true});
      AtriumSchNoteInk.draw(ctx, [[8,8,10],[56,56,200],[8,56,100],[56,8,240]], {brush: "highlighter", width: 6}, "#ffd020");
      const alpha = (a, b) => ctx.getImageData(a, b, 1, 1).data[3];
      const centreAlpha = alpha(32, 32), singleAlpha = alpha(18, 18), outsideAlpha = alpha(4, 24);
      const timings = [], benchmark = AtriumSchNoteInk.capture("pen", .48), brush = {brush: "pen", width: .48};
      for (let batch = 0; batch < 256; batch++) {
        const samples = Array.from({length: 16}, (_, i) => {
          const t = batch * 16 + i;
          return {world: [32 + 25 * Math.cos(t / 31), 32 + 25 * Math.sin(t / 26)], pressure: .5 + .45 * Math.sin(t / 44)};
        });
        const start = performance.now(), first = benchmark.append(samples);
        const wet = benchmark.points.slice(first); wet.push(benchmark.tip);
        AtriumSchNoteInk.draw(ctx, wet, brush, "#285b81");
        ctx.getImageData(32, 32, 1, 1);
        timings.push(performance.now() - start);
      }
      timings.sort((a, b) => a - b);
      return {traces, completed, eraserHits, pending: drafts.size + erasers.size, circuitUnchanged: JSON.stringify(AtriumNavHost.doc()) === before,
        centreAlpha, singleAlpha, outsideAlpha, wetBatchMs: {p95: +timings[243].toFixed(2), max: +timings.at(-1).toFixed(2)}};
    });
    assert.deepEqual(proof.completed.map(s => s.type), ["pen", "mouse", "touch"]);
    assert.ok(proof.completed[0].points[0][2] < proof.completed[0].points.at(-1)[2]);
    assert.ok(proof.traces.some(([, id, phase]) => id === 5 && phase === "cancel"));
    assert.equal(proof.traces.some(([, id]) => id === 2), false, "palm contact reached the sketch collector");
    assert.equal(proof.eraserHits, 3, "the pen tail eraser identifies all three original strokes");
    assert.equal(proof.pending, 0); assert.equal(proof.circuitUnchanged, true);
    assert.equal(proof.centreAlpha, proof.singleAlpha); assert.ok(Math.abs(proof.singleAlpha - .28 * 255) <= 1);
    assert.equal(proof.outsideAlpha, 0);
    console.log(JSON.stringify({browser: browser.version(), input: proof.completed.map(s => s.type), cancelledSecondTouch: true,
      circuitUnchanged: true, eraserHits: proof.eraserHits, crossingAlpha: proof.centreAlpha, singleAlpha: proof.singleAlpha, outsideAlpha: proof.outsideAlpha,
      wetBatchMs: proof.wetBatchMs}));
  } finally { await browser.close(); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
