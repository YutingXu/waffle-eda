"use strict";
// The History dock's pager, before/after tiles, preview, keyboard and restore.
const assert = require("node:assert/strict");
const S = require("../support/docs-family-ui.cjs");

module.exports = async function visualHistoryUI(browser) {
  const page = await S.editor(browser);
  try {
    await S.savedViewsProject(page);
    await page.evaluate(() => {
      const h = AtriumNavHost;
      for (let i = 0; i < 5; i++) { const n = {id:Atrium.id(), kind:"netlabel", x:10 + i * 5, y:16, text:"N" + i}; h.edit(() => h.doc().items.push(n), "Place net label N" + i, new Set([n.id])); }
      h.act("undo"); h.act("undo");
    });
    await page.evaluate(async () => {
      (await AtriumLazy.need("AtriumPrefs")).set("butter.visualHistory", false);
      AtriumNavHost.act("history-panel");
    });
    const panel = page.locator(".panel-history");
    const pager = panel.locator(".hist-scrub .ui-pager");
    await pager.waitFor();
    await panel.locator(".hist-rail .hist-row.ui-row").first().waitFor();
    assert.equal(await pager.locator(".ui-pager-position").textContent(), "4 of 6", "the current state, counted from the start");
    assert.equal(await panel.locator(".hist-rail .hist-row.is-current .ui-row-title").textContent(), "Place net label N2");
    assert.ok(await panel.locator(".hist-rail .hist-mini").count() >= 2, "before and after tiles");

    // A click previews; the preview shows its actions under the art; the pager follows.
    await panel.locator('.hist-row[data-index="2"]').click();
    await panel.locator(".hist-design-preview[data-ready=true]").waitFor();
    assert.equal(await pager.locator(".ui-pager-position").textContent(), "3 of 6");
    for (const name of ["Compare with now", "Fork here", "Restore"]) await panel.getByRole("button", {name, exact:true}).waitFor();
    assert.equal(await panel.getByRole("button", {name:"Restore", exact:true}).getAttribute("data-variant"), "primary");

    // Step with the pager: next previews the following state.
    await pager.getByRole("button", {name:"Next step"}).click();
    await page.waitForFunction(() => document.querySelector(".hist-preview strong")?.textContent === "Place net label N2");
    assert.equal(await pager.locator(".ui-pager-position").textContent(), "4 of 6");

    // Keyboard: Home previews the start; Escape closes the preview.
    await panel.locator(".hist-list").first().focus();
    await page.keyboard.press("Home");
    await panel.locator(".hist-preview:not([hidden])").waitFor();
    await page.keyboard.press("Escape");
    await panel.locator(".hist-preview").waitFor({state:"hidden"});
    assert.equal(await panel.locator(".hist-position").textContent(), "Current design");

    // Restore applies as one more undoable edit.
    const before = await page.evaluate(() => AtriumNavHost.undoSteps().history.length);
    await panel.locator('.hist-row[data-index="1"]').click();
    await panel.locator(".hist-design-preview[data-ready=true]").waitFor();
    await panel.getByRole("button", {name:"Restore", exact:true}).click();
    await page.waitForFunction(n => AtriumNavHost.undoSteps().history.length !== n, before);
    assert.deepEqual(page.errors, []);
    console.log("PASS the History dock: pager with slider, library rows with tiles, preview actions, pager and key stepping, restore");
  } finally { await page.close(); }
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}), args:["--allow-file-access-from-files"]});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
