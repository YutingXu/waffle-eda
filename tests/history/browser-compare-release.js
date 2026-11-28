"use strict";

// Closing a comparison releases it. The Change table (Project › Compare › Change Table…) is opened,
// filled from a saved project ZIP and closed several times, with the pointer crossing its lists as a
// user's would. After the first round (which loads the comparison modules and their styles once) the
// document's node count stays flat and no closed dialog survives as a detached tree. The overlay
// scrollbars (ui/overlay-scroll.js) used to keep every scroller the pointer had crossed in a Map, so
// each closed Change table stayed in memory with its whole subtree (about 220 nodes on the soak's
// schematic bench; about 2,000 for each visual comparison, Project › Compare › Compare…). The visual
// comparison is opened and closed the same way, and a removed scroller whose edge the pointer reached
// is collected as well. The suite clicks with the plain mouse and waits on booleans: a locator click
// or an element handle would itself keep the closed dialog alive.
// Run standalone: node tests/history/browser-compare-release.js
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {once} = require("node:events");
const {pathToFileURL} = require("node:url");
const {projectZIP} = require("../support/browser-native-project.cjs");

const ROUNDS = 6;

async function compareRelease(browser) {
  const page = await browser.newPage({viewport:{width:1280, height:860}, reducedMotion:"reduce"}), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waffle-compare-release-"));
  const cdp = await page.context().newCDPSession(page);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.kind === "pcb");
    // The overlay scrollbars load at idle or on the first scroll; a long session always has them.
    await page.evaluate(() => AtriumLazy.need("AtriumOverlayScroll"));
    const baseline = path.join(dir, "baseline.zip");
    const saved = JSON.parse(await page.evaluate(() => JSON.stringify(AtriumNavHost.project())));
    await fs.writeFile(baseline, (await projectZIP(saved)).buffer);
    // Moved parts on each document and a page's worth of new tracks, so the dialog and its change list
    // scroll, as on the soak's schematic bench.
    await page.evaluate(() => {
      const h = AtriumNavHost;
      for (const d of h.project().documents.filter(d => d.kind === "pcb" || d.kind === "schematic")) {
        h.selectDocument(d.id);
        const parts = h.doc().items.filter(i => i.kind === "part");
        h.edit(() => { for (const p of parts) p.x += 1.27; }, "Move parts", parts);
      }
      h.selectDocument(h.project().documents.find(d => d.kind === "pcb").id);
      h.edit(() => { for (let i = 0; i < 60; i++) h.doc().items.push({id:"release-track-" + i, kind:"track", layer:"Top", width:.25, net:"", points:[[i, 0], [i, 3]]}); }, "Add tracks");
      h.select([]);
    });

    const counters = async () => {
      // A shown thumb fades 900 ms after its scroller last scrolled; until then its timer still holds it.
      await page.evaluate(() => new Promise(r => setTimeout(() => requestAnimationFrame(() => r()), 1000)));
      await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage");
      const {nodes, jsEventListeners} = await cdp.send("Memory.getDOMCounters");
      // A short-lived inspector, so its node identifiers do not keep anything into the next round.
      const inspector = await page.context().newCDPSession(page);
      try {
        await inspector.send("DOM.enable");
        const {detachedNodes} = await inspector.send("DOM.getDetachedDomNodes");
        const dialogs = detachedNodes.filter(t => t.treeNode.nodeName === "DIALOG").length;
        return {nodes, listeners:jsEventListeners, detached:detachedNodes.reduce((n, t) => n + t.retainedNodeIds.length, 0), dialogs};
      } finally { await inspector.detach(); }
    };
    async function compare() {
      await page.evaluate(() => AtriumNavHost.act("compare"));
      const dialog = page.getByRole("dialog", {name:"Change table"});
      const picker = await page.context().newCDPSession(page);
      try {
        await picker.send("Page.enable");
        await picker.send("Page.setInterceptFileChooserDialog", {enabled:true});
        // A plain mouse click: a locator click leaves Playwright's own mark on the button, and that mark
        // keeps the closed dialog alive, which would hide what the app itself releases.
        await dialog.getByRole("button", {name:"Choose project ZIP…"}).waitFor();
        const at = await page.evaluate(() => {
          const b = [...document.querySelectorAll(".revision-dialog .rev-sources button")].find(b => !b.hidden && /ZIP/.test(b.textContent));
          const r = b.getBoundingClientRect(); return {x:r.left + r.width / 2, y:r.top + r.height / 2};
        });
        const [opened] = await Promise.all([once(picker, "Page.fileChooserOpened", {signal:AbortSignal.timeout(15000)}), page.mouse.click(at.x, at.y)]);
        await picker.send("DOM.setFileInputFiles", {backendNodeId:opened[0].backendNodeId, files:[baseline]});
      } finally { await picker.detach(); }
      await dialog.getByRole("status").filter({hasText:/Working design · \d+–\d+ of \d+ changes?/}).waitFor();
      // The pointer crosses the dialog, its change list and its detail pane, away from their edges; the
      // keyboard closes it. Before the fix each closed dialog stayed with every scroller it had crossed.
      const boxes = await page.evaluate(() => [".revision-dialog", ".revision-dialog .rev-list", ".revision-dialog .rev-detail"].map(s => {
        const r = document.querySelector(s)?.getBoundingClientRect(); return r && {x:r.left, y:r.top, w:r.width, h:r.height};
      }).filter(Boolean));
      for (const b of boxes) await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, {steps:4});
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.querySelector(".revision-dialog"));
    }

    const rows = [];
    for (let i = 0; i < ROUNDS; i++) { await compare(); rows.push(await counters()); }
    const report = rows.map((r, i) => (i + 1) + ": " + r.nodes + " nodes, " + r.detached + " detached").join("; ");
    const growth = rows.at(-1).nodes - rows[0].nodes;
    // Each leaked Change table here was over 100 nodes, so five rounds of growth stay far below that.
    assert.ok(growth <= 40, "the Change table leaves nothing behind once closed: " + growth + " more nodes after " + (ROUNDS - 1) + " rounds (" + report + ")");
    assert.ok(rows.every(r => r.dialogs === 0), "no closed Change table survives as a detached tree (" + report + ")");
    assert.ok(rows.at(-1).detached <= 8, "detached nodes stay few: " + report);
    assert.ok(rows.at(-1).listeners - rows[0].listeners <= 8, "event listeners stay flat: " + rows.map(r => r.listeners).join(", "));

    // The visual comparison (Project › Compare › Compare…) shares the overlay scrollbars: its change
    // list and inspector scroll. It too leaves nothing behind once closed.
    async function visual() {
      await page.evaluate(async before => {
        const [V] = await Promise.all([AtriumLazy.need("AtriumDiffView"), AtriumLazy.need("AtriumGitPicker")]);
        const after = await AtriumGit.readSpec({type:"working"}, AtriumNavHost);
        await V.start({project:before, label:"baseline.zip"}, {project:after.project, label:after.label, working:true});
      }, saved);
      // A boolean: waitForFunction hands back a handle to a truthy result, and a handle to a row would keep it.
      await page.waitForFunction(() => !!document.querySelector("section.dv .dv-list [role=option]"));
      const boxes = await page.evaluate(() => ["section.dv", "section.dv .dv-list"].map(s => {
        const r = document.querySelector(s)?.getBoundingClientRect(); return r && {x:r.left, y:r.top, w:r.width, h:r.height};
      }).filter(Boolean));
      for (const b of boxes) await page.mouse.move(b.x + b.w / 2, b.y + b.h / 2, {steps:4});
      await page.evaluate(() => AtriumDiffView.close());
      await page.waitForFunction(() => !document.querySelector("section.dv"));
    }
    const views = [];
    for (let i = 0; i < 4; i++) { await visual(); views.push(await counters()); }
    const viewReport = views.map((r, i) => (i + 1) + ": " + r.nodes + " nodes, " + r.detached + " detached").join("; ");
    assert.ok(views.at(-1).nodes - views[0].nodes <= 40, "the visual comparison leaves nothing behind once closed (" + viewReport + ")");
    assert.ok(views.at(-1).detached <= 8, "detached nodes stay few after the visual comparison: " + viewReport);

    // The same for any scroller: one whose edge the pointer reached, with its thumb shown, is collected
    // once it leaves the document, and its thumb goes with it.
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumOverlayScroll");
      const s = Object.assign(document.createElement("div"), {id:"release-probe"});
      s.style.cssText = "position:fixed;left:200px;top:200px;width:300px;height:200px;overflow:auto;z-index:5";
      s.append(Object.assign(document.createElement("div"), {style:"height:2000px"}));
      document.body.append(s);
      AtriumOverlayScroll.show(s);
      globalThis.__releaseProbe = new WeakRef(s);
    });
    await page.mouse.move(350, 300, {steps:3});
    await page.mouse.move(497, 300, {steps:3});
    await page.waitForFunction(() => AtriumOverlayScroll.thumbs().length > 0);
    await page.evaluate(() => document.getElementById("release-probe").remove());
    await page.mouse.move(8, 400, {steps:3});
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))));
    await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage");
    const probe = await page.evaluate(() => ({collected:globalThis.__releaseProbe.deref() === undefined,
      thumbs:AtriumOverlayScroll.thumbs().filter(t => t.isConnected).length}));
    assert.equal(probe.collected, true, "a removed scroller is not kept by its overlay scrollbar");
    assert.equal(probe.thumbs, 0, "a removed scroller's thumb leaves with it");
    assert.deepEqual(errors, []);
    console.log("PASS compare release: " + ROUNDS + " Change table rounds, " + growth + " nodes of growth (" + report + "); visual comparison " + viewReport + "; a removed scroller is collected");
  } finally {
    await cdp.detach().catch(() => {});
    await page.close();
    await fs.rm(dir, {recursive:true, force:true});
  }
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({headless:true, ...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"})}, compareRelease, error => { console.error(error); process.exitCode = 1; });
module.exports = compareRelease;
