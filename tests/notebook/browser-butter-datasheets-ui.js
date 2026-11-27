"use strict";
// Datasheet reader: flag off stays cold; empty, Open PDF…, the page
// strip and pager, zoom, find with a match pager, snip preview, the project list and a missing source.
const assert = require("node:assert/strict");
const S = require("../support/docs-family-ui.cjs");
const {fixture} = require("../support/datasheet-pdf.cjs");

module.exports = async function datasheetsUI(browser) {
  const page = await S.editor(browser);
  try {
    await S.savedViewsProject(page);
    assert.deepEqual(await S.commands(page, "butter.datasheets."), [], "flag off registers nothing");
    await S.enable(page, ["datasheets"]);
    assert.ok(!page.scripts.some(n => /^(datasheet-reader|datasheets|datasheet-worker-source)\.js$/.test(n)), "the reader stays cold until opened");
    await S.run(page, "butter.datasheets.reader");
    const panel = page.locator(".panel-datasheet");
    await panel.locator(".ui-empty", {hasText:"No datasheets"}).waitFor();

    // Open PDF…: the file becomes a project reference (one Undo step) and opens at page 1.
    const steps = await page.evaluate(() => AtriumNavHost.undoSteps().history.length);
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), panel.getByRole("button", {name:"Open PDF…"}).click()]);
    await chooser.setFiles({name:"LMV321 datasheet.pdf", mimeType:"application/pdf", buffer:fixture(24)});
    await panel.locator(".docs-page img").first().waitFor();
    assert.equal(await page.evaluate(() => AtriumNavHost.undoSteps().history.length), steps + 1);
    assert.equal(await panel.locator(".docs-page").count(), 24);
    assert.ok(await panel.locator(".docs-page img").count() <= 8, "only pages near the view are drawn");
    const pager = panel.locator(".docs-foot .ui-pager");
    assert.equal(await pager.locator(".ui-pager-position").textContent(), "1 of 24");
    assert.match(await panel.locator(".docs-foot .ui-status-line").textContent(), /24 pages · Local copy/);
    await panel.locator(".docs-strip .ui-thumb canvas[data-ready=true]").first().waitFor();

    // Step with the pager and the keyboard; the strip follows.
    await pager.getByRole("button", {name:"Next page"}).click();
    await page.waitForFunction(() => document.querySelector(".panel-datasheet .docs-foot .ui-pager-position").textContent === "2 of 24");
    await panel.locator(".docs-pages").focus();
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelector(".panel-datasheet .docs-foot .ui-pager-position").textContent === "24 of 24");
    assert.equal(await panel.locator('.docs-strip .ui-thumb[aria-current=true]').getAttribute("data-id"), "24");
    await panel.locator('.docs-strip .ui-thumb[data-id="3"]').click();
    await page.waitForFunction(() => document.querySelector(".panel-datasheet .docs-foot .ui-pager-position").textContent === "3 of 24");

    // Zoom keeps the page in view.
    await panel.getByRole("combobox", {name:"Zoom"}).selectOption("1.5");
    await page.waitForFunction(() => document.querySelector(".panel-datasheet .docs-foot .ui-pager-position").textContent === "3 of 24");
    await panel.getByRole("combobox", {name:"Zoom"}).selectOption("fit");

    // Find: count, match pager, Enter steps.
    await panel.getByRole("button", {name:"Find in datasheet"}).click();
    await panel.getByRole("searchbox").fill("Ground");
    await page.waitForFunction(() => document.querySelector(".panel-datasheet .docs-find .ui-pager-position")?.textContent === "1 of 1");
    await panel.getByRole("searchbox").fill("page 1");
    await page.waitForFunction(() => /^1 of \d+$/.test(document.querySelector(".panel-datasheet .docs-find .ui-pager-position").textContent) &&
      document.querySelector(".panel-datasheet .docs-find .ui-pager-position").textContent !== "1 of 1");
    await panel.getByRole("searchbox").press("Enter");
    await page.waitForFunction(() => document.querySelector(".panel-datasheet .docs-find .ui-pager-position").textContent.startsWith("2 of"));
    await panel.getByRole("searchbox").fill("");
    await panel.getByRole("searchbox").press("Escape");

    // Snip: drag over a page in view; the preview shows the crop with its page.
    await panel.getByRole("button", {name:"Snip"}).click();
    const box = await page.evaluate(() => {
      const v = document.querySelector(".panel-datasheet .docs-pages").getBoundingClientRect();
      const p = [...document.querySelectorAll(".panel-datasheet .docs-page")].find(n => { const r = n.getBoundingClientRect(); return r.top >= v.top - 2 && r.top < v.bottom - 80 && n.querySelector("img"); });
      const r = p.getBoundingClientRect(); return {x:r.x, y:r.y, w:r.width, h:r.height};
    });
    await page.mouse.move(box.x + 12, box.y + 10); await page.mouse.down();
    await page.mouse.move(box.x + box.w * .7, box.y + box.h * .3, {steps:5}); await page.mouse.up();
    const card = panel.locator(".docs-snip-card");
    await card.locator("img").waitFor();
    assert.match(await card.textContent(), /Page \d+ · \d+ × \d+ mm/);
    await page.keyboard.press("Escape");
    await card.waitFor({state:"detached"});
    await panel.getByRole("button", {name:"Snip"}).click();

    // The project list and a reference whose PDF is not on this computer.
    await page.evaluate(() => AtriumNavHost.project().datasheets.push({id:"018cc251-f400-7000-8000-0000000000ee", sha256:"0".repeat(63) + "1",
      byteLength:4096, title:"TPS7A20 regulator", version:"C", sourceURL:"https://www.ti.com/lit/ds/symlink/tps7a20.pdf"}));
    await panel.getByRole("button", {name:"More…"}).click();
    await page.getByRole("menuitem", {name:"Show all datasheets"}).click();
    await panel.locator(".ui-row", {hasText:"LMV321 datasheet"}).waitFor();
    await panel.locator(".ui-row", {hasText:"TPS7A20"}).click();
    await panel.locator(".ui-notice", {hasText:"Not on this computer"}).waitFor();
    await panel.getByRole("button", {name:"Select PDF…"}).waitFor();
    await panel.getByRole("button", {name:"Download"}).waitFor();

    await page.evaluate(() => AtriumPrefs.set("butter.datasheets", false));
    await panel.waitFor({state:"hidden"});
    assert.deepEqual(page.errors, []);
    console.log("PASS datasheet reader: cold default, empty, open, visible pages only, pager and strip, zoom, find, snip, list, missing source, flag off");
  } finally { await page.close(); }
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}), args:["--allow-file-access-from-files"]});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
