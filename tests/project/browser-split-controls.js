"use strict";
// Split controls stay after a split (beta: "split view controls are gone once clicked"). Each pane's tab
// strip keeps a split control, which turns the split between side by side and stacked, and a close
// button. Mouse and touch: split, re-split each way from either pane, close each pane, split again.
// Enter then opens that split and closes Close pane 2. Pointer and touch close stay on press().
// Run: node tests/project/browser-split-controls.js (NODE_PATH for Playwright Core).
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function run(browser, touch) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}, hasTouch: touch});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(8000);
  const press = locator => touch ? locator.tap() : locator.click();
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
    const panes = page.locator("#editor-panes"), split = page.locator('.editor-tabbar [data-action="split-toggle"]');
    const strip = k => page.locator(`.pane-tabs[data-pane="${k}"]`);
    const stacked = () => panes.evaluate(n => n.classList.contains("split-down"));
    const count = () => page.evaluate(() => AtriumNavHost.panes().length);
    for (const closing of [1, 0]) {
      await press(split);
      await page.waitForFunction(() => AtriumNavHost.panes().length === 2);
      for (const k of [0, 1]) {
        await strip(k).locator(".pane-arrange").waitFor();
        await strip(k).locator(".pane-close").waitFor();
      }
      assert.equal(await stacked(), false);
      assert.equal(await strip(0).locator(".pane-arrange").getAttribute("aria-label"), "Split down (stacked)");
      await press(strip(0).locator(".pane-arrange"));
      await page.waitForFunction(() => document.getElementById("editor-panes").classList.contains("split-down"));
      assert.equal(await count(), 2);
      await strip(1).locator('.pane-arrange[aria-label="Split right (side by side)"]').waitFor();
      await press(strip(1).locator(".pane-arrange"));
      await page.waitForFunction(() => !document.getElementById("editor-panes").classList.contains("split-down"));
      await press(strip(closing).locator(".pane-close"));
      await page.waitForFunction(() => AtriumNavHost.panes().length === 1);
      await split.waitFor({state: "visible"});
    }
    // The retired Properties scenario measured the split close target at this viewport.
    if (!touch) {
      await page.setViewportSize({width:1480,height:950});
      await split.focus();
      await page.keyboard.press("Enter");
      const close = page.getByRole("button", {name:"Close pane 2",exact:true});
      await close.waitFor();
      const closeMetrics = await close.evaluate(button => {
        const rect = button.getBoundingClientRect(), strip = button.closest(".pane-tabs").getBoundingClientRect();
        const glyph = button.querySelector(".icon").getBoundingClientRect();
        return [rect.width,rect.height,rect.y-strip.y,glyph.width,glyph.height];
      });
      assert.deepEqual(closeMetrics,[24,24,4,14,14],"the pane close target is centered with a dense glyph");
      await close.focus();
      await page.keyboard.press("Enter");
      await page.waitForFunction(() => AtriumNavHost.panes().length === 1);
      await split.waitFor();
    }
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
}

module.exports = async function splitControls(browser) {
  await run(browser, false);
  await run(browser, true);
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => ({headless: true, channel: "chrome"}),
    async browser => {await module.exports(browser); console.log("split controls: ok");},
    e => {console.error(e); process.exit(1);});
}
