"use strict";

// Long-session soak: scripted edits (move, add and delete copper, undo/redo, switching documents,
// opening the library and Properties) for SOAK_SECONDS (default 20) on the demo, with the undo
// history held to its smallest budget. The JavaScript heap, measured after a forced collection,
// must plateau: the last third of the run may not sit more than SOAK_GROWTH_MB (default 6) above
// the middle third. Caches, the undo log, the autosave queue and worker queues are all bounded,
// so steady editing must not grow the heap without limit.
// Run alone: node tests/editor/browser-soak.js [seconds]   (inside integration-browser.cjs otherwise)
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function openSoakPage(browser, smallHistory = true) {
  const page = await browser.newPage({viewport: {width: 1280, height: 860}}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  try {
    const cdp = await page.context().newCDPSession(page);
    if (smallHistory) await page.addInitScript(() => {
      if (self !== top) return;
      try { localStorage.setItem("atrium.prefs", JSON.stringify({format: "atrium-prefs", version: 1, values: {"history.undoBudgetMB": 4}})); } catch { /* defaults */ }
    });
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    return {page, cdp, errors};
  } catch (error) {
    await page.close();
    throw error;
  }
}

async function collectHeap(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  return (await cdp.send("Runtime.getHeapUsage")).usedSize;
}

async function soak(browser, seconds = +(process.env.SOAK_SECONDS || 20)) {
  const {page, cdp, errors} = await openSoakPage(browser);
  const heap = async () => await collectHeap(cdp) / 1048576;
  try {
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !!globalThis.AtriumNavHost && AtriumNavHost.doc().kind === "pcb");
    // One round of edits; returns how many undo steps the editor holds.
    const round = n => page.evaluate(async n => {
      const H = AtriumNavHost, frame = () => new Promise(r => requestAnimationFrame(() => r()));
      const docs = H.project().documents;
      for (let i = 0; i < 12; i++) {
        const pcb = docs.find(d => d.kind === "pcb"), sch = docs.find(d => d.kind === "schematic");
        if (H.doc() !== pcb) H.selectDocument(pcb.id);
        const part = H.doc().items.find(it => it.kind === "part");
        H.select([part.id]);
        H.edit(() => { part.x += (n + i) % 2 ? .1 : -.1; });
        const id = "soak-" + n + "-" + i;
        H.edit(() => { H.doc().items.push({id, kind: "track", layer: "Top", width: .25, net: "", points: [[0, 0], [5 + i, 3]]}); });
        H.edit(() => { const items = H.doc().items, k = items.findIndex(t => t.id === id); if (k >= 0) items.splice(k, 1); });
        H.act("undo"); H.act("redo");
        if (i % 4 === 0 && sch) { H.selectDocument(sch.id); await frame(); H.select([H.doc().items.find(it => it.kind === "part").id]); }
        await frame();
      }
      if (n % 5 === 0) { H.act("library"); await frame(); for (const d of document.querySelectorAll("dialog[open]")) d.close(); }
      await new Promise(r => setTimeout(r, 30));
      return H.undoSteps?.() ?? null;
    }, n);
    const start = Date.now(), end = start + seconds * 1000, samples = [];
    let n = 0, next = start;
    while (Date.now() < end) {
      await round(n++);
      if (Date.now() >= next) { samples.push({t: (Date.now() - start) / 1000, mb: await heap()}); next = Date.now() + seconds * 1000 / 12; }
    }
    samples.push({t: (Date.now() - start) / 1000, mb: await heap()});
    const third = Math.max(1, Math.floor(samples.length / 3));
    const avg = rows => rows.reduce((a, r) => a + r.mb, 0) / rows.length;
    const middle = avg(samples.slice(third, 2 * third)), last = avg(samples.slice(2 * third));
    const limit = +(process.env.SOAK_GROWTH_MB || 6);
    const report = samples.map(s => s.t.toFixed(0) + "s " + s.mb.toFixed(1)).join(", ");
    assert.ok(n >= 3, "the soak ran several rounds");
    assert.ok(last - middle <= limit, "the heap plateaus over a long session: " + (last - middle).toFixed(1) + " MB growth in the last third (limit " + limit + " MB): " + report);
    assert.deepEqual(errors, []);
    console.log("PASS soak: " + n * 12 + " edit rounds in " + seconds + " s; heap " + middle.toFixed(1) + " → " + last.toFixed(1) + " MB (" + report + ")");
  } finally { await page.close(); }
}

module.exports = Object.assign(soak, {openSoakPage, collectHeap});
if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch({headless: true, channel: "chrome"});
    try { await soak(browser, +(process.argv[2] || process.env.SOAK_SECONDS || 20)); } finally { await browser.close(); }
  })().catch(e => { console.error(e.stack || e.message); process.exitCode = 1; });
}
