"use strict";
// Saved views panel: flag off stays cold; the Views panel lists,
// captures, renames, applies, reports partial and missing states, exports and presents.
const assert = require("node:assert/strict");
const S = require("../support/docs-family-ui.cjs");

module.exports = async function savedViewsUI(browser) {
  const page = await S.editor(browser);
  try {
    await S.savedViewsProject(page);
    assert.deepEqual(await S.commands(page, "butter.savedViews."), [], "flag off registers nothing");
    assert.ok(!page.scripts.some(n => ["views-panel.js", "docs-family.js"].includes(n)), "flag off loads no family UI");
    await S.enable(page, ["savedViews"]);
    const ids = await S.commands(page, "butter.savedViews.");
    assert.ok(ids.includes("butter.savedViews.panel") && ids.includes("butter.savedViews.capture-current"));
    assert.ok(!page.scripts.includes("views-panel.js"), "the panel loads only when opened");

    await S.run(page, "butter.savedViews.panel");
    const panel = page.locator(".panel-views"), pane = panel.locator("[data-pane=views]");
    await pane.locator(".ui-row").first().waitFor();
    assert.equal(await panel.locator(".ui-tabs").isHidden(), true, "one feature, no tab strip");
    assert.deepEqual(await pane.locator(".ui-row .ui-row-title").allTextContents(), ["Copper probe", "Schematic signal"]);
    assert.match(await pane.locator(".ui-status-line").textContent(), /2 views/);

    // Apply: the row becomes current and the board camera moves.
    await pane.locator(".ui-row").first().click();
    await page.waitForFunction(() => AtriumNavHost.currentId() === "board");
    await pane.locator(".ui-row[aria-current=true]").waitFor();

    // Capture opens an inline rename; Enter commits one Undo step each.
    const undo = () => page.evaluate(() => AtriumNavHost.undoSteps().history.length);
    const before = await undo();
    await pane.getByRole("button", {name:"Save view", exact:true}).click();
    const field = pane.getByRole("textbox", {name:"View name"});
    await field.waitFor();
    await field.fill("Probe close-up");
    await field.press("Enter");
    await pane.locator(".ui-row-title", {hasText:"Probe close-up"}).waitFor();
    assert.equal(await undo(), before + 2, "capture and rename are one step each");

    // Partial: a highlighted object is gone; the notice says so and navigation stays.
    await page.evaluate(() => {
      const h = AtriumNavHost, d = h.project().documents.find(x => x.kind === "pcb"), it = d.items.find(i => i.id === "run");
      h.edit(() => d.items.splice(d.items.indexOf(it), 1), "Delete track", new Set(["run"]));
    });
    await pane.locator(".ui-row").first().click();
    await pane.locator(".ui-notice", {hasText:"missing"}).waitFor();

    // Keyboard: arrows move, F2 renames, Escape cancels, Delete removes (Undo restores).
    await pane.locator(".ui-list").focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("F2");
    await pane.getByRole("textbox", {name:"View name"}).press("Escape");
    const count = await pane.locator(".ui-row").count();
    await page.keyboard.press("Delete");
    await page.waitForFunction(n => document.querySelectorAll(".panel-views [data-pane=views] .ui-row").length === n - 1, count);
    await page.evaluate(() => AtriumNavHost.act("undo"));
    await page.waitForFunction(n => document.querySelectorAll(".panel-views [data-pane=views] .ui-row").length === n, count);

    // The row menu shows the list's keys from the keymap, and a rebinding moves the key and the hint.
    const hints = async () => {
      await pane.locator(".ui-row").first().click({button:"right"});
      const menu = page.locator(".nav-menu[role=menu]").last();
      await menu.waitFor();
      const out = await menu.locator("[role=menuitem]").evaluateAll(items => Object.fromEntries(items.map(item =>
        [item.querySelector(":scope > span")?.textContent, item.querySelector(":scope > .ui-shortcut")?.dataset.binding || null])));
      await page.keyboard.press("Escape");
      await menu.waitFor({state:"detached"});
      return out;
    };
    const keys = await hints();
    assert.deepEqual([keys["Rename"], keys["Copy link"], keys["Remove"], keys["Go to view"]], ["F2", "Mod+C", "Backspace", null]);
    await page.evaluate(() => AtriumKeymap.setBindings("views-rename", ["Shift+F2"]));
    assert.equal((await hints())["Rename"], "Shift+F2", "the menu hint follows the rebinding");
    await pane.locator(".ui-list").focus();
    await page.keyboard.press("Shift+F2");
    await pane.getByRole("textbox", {name:"View name"}).press("Escape");
    await page.evaluate(() => AtriumKeymap.resetCommand("views-rename"));

    // Export: progress while the PDF is prepared, then a receipt.
    const [download] = await Promise.all([page.waitForEvent("download"), pane.getByRole("button", {name:"Export PDF…"}).click()]);
    assert.match(download.suggestedFilename(), /Saved views\.pdf$/);

    // Presentation: the shared floating bar steps with keys and ends with Escape.
    await pane.getByRole("button", {name:"Present", exact:true}).click();
    const bar = page.locator(".docs-stage-bar");
    await bar.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.presenting), "views");
    await page.waitForFunction(() => document.querySelector(".docs-stage-bar .ui-pager-position").textContent === "1 of 3");
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => document.querySelector(".docs-stage-bar .ui-pager-position").textContent === "2 of 3");
    await page.keyboard.press("End");
    await page.waitForFunction(() => document.querySelector(".docs-stage-bar .ui-pager-position").textContent === "3 of 3");
    assert.equal(await bar.getByRole("button", {name:"Next view"}).isDisabled(), true, "the end disables next");
    await page.keyboard.press("Escape");
    await bar.waitFor({state:"detached"});
    assert.equal(await page.evaluate(() => document.documentElement.dataset.presenting ?? null), null);

    // Empty: removing every view leaves one action.
    await page.evaluate(async () => { for (const v of [...AtriumNavHost.project().savedViews]) await AtriumButterEditor.apply("butter.savedViews.remove", {id:v.id}); });
    await pane.locator(".ui-empty", {hasText:"No saved views"}).waitFor();
    assert.equal(await pane.getByRole("button", {name:"Present", exact:true}).isDisabled(), true);

    // Flag off closes the panel.
    await page.evaluate(() => AtriumPrefs.set("butter.savedViews", false));
    await panel.waitFor({state:"hidden"});
    assert.deepEqual(page.errors, []);
    console.log("PASS saved views panel: cold default, list, capture and rename, partial notice, keys, export, presentation, empty, flag off");
  } finally { await page.close(); }
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}), args:["--allow-file-access-from-files"]});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
