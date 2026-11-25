"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function checkDiffBlink(browser, root = path.resolve(__dirname, "../..")) {
  const page = await browser.newPage({viewport: {width: 1280, height: 860}});
  page.setDefaultTimeout(5000);
  try {
    await page.route(/^https?:/, route => route.abort());
    await page.clock.install();
    await page.goto(pathToFileURL(path.join(root, "app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumDiffView");
      AtriumPower.setMode("off");
      AtriumTheme.set({motion: "full"});
      const after = AtriumNavHost.project(), before = Atrium.clone(after);
      before.documents[0].items.find(item => item.ref).ref += "9";
      await AtriumDiffView.start({project: before, label: "Before"}, {project: after, label: "After"});
    });
    const pane = page.locator(".dv-pane.dv-before");
    const auto = page.locator(".dv-blink input");
    const blink = page.locator('.dv-mode[data-mode="blink"]');
    await blink.click();
    assert.equal(await auto.isChecked(), true, "the visible comparison starts in Auto");
    await pane.evaluate(node => {
      window.blinkUpdates = 0;
      let hidden = node.classList.contains("is-off");
      new MutationObserver(() => {
        const next = node.classList.contains("is-off");
        if (hidden !== next) blinkUpdates++;
        hidden = next;
      }).observe(node, {attributes: true, attributeFilter: ["class"]});
    });
    const updates = () => page.evaluate(() => blinkUpdates);
    async function advances() {
      const start = await updates();
      await page.waitForFunction(before => blinkUpdates >= before + 2, start, {timeout: 5000});
    }
    async function holds(message) {
      const start = await updates();
      await page.clock.runFor(1450); // Enough for two automatic flips of the 650 ms Blink cadence.
      assert.equal(await updates(), start, message);
    }
    const setOccluded = occluded => page.evaluate(value => dispatchEvent(new CustomEvent("atrium-power", {detail: {occluded: value}})), occluded);
    await advances();
    await page.evaluate(() => AtriumPower.setMode("always"));
    await holds("Efficiency holds the displayed revision");
    assert.equal(await auto.isChecked(), true, "Efficiency preserves the Auto selection");
    const beforeFlip = await pane.evaluate(node => node.classList.contains("is-off"));
    await page.locator(".dv-list").focus();
    await page.keyboard.press("Space");
    assert.equal(await pane.evaluate(node => node.classList.contains("is-off")), !beforeFlip,
      "Space still flips the visible revision in Efficiency");
    await page.evaluate(() => AtriumPower.setMode("off"));
    await advances();
    await setOccluded(true);
    assert.equal(await page.evaluate(() => AtriumPower.visible()), false);
    await holds("occlusion holds the displayed revision");
    await setOccluded(false);
    await advances();
    await auto.uncheck();
    await holds("unchecking Auto stops automatic flips");
    await auto.check();
    await page.locator('.dv-mode[data-mode="side"]').click();
    await holds("changing view stops automatic flips");
    await blink.click();
    await setOccluded(true);
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.locator(".dv-close").click();
    assert.equal(await pane.count(), 0);
    await setOccluded(false);
    await holds("closing a covered comparison cancels its pending flip");
    assert.deepEqual(errors, [], "a retired comparison leaves no callback that can fail when the window becomes visible");
    console.log("PASS Design Compare Blink respects Efficiency and occlusion, resumes while visible, and cancels on leaving Auto");
  } finally {
    await page.close();
  }
}

module.exports = checkDiffBlink;
if (require.main === module) {
  const {chromium} = require("playwright-core");
  (async () => {
    const browser = await chromium.launch({channel: "chrome"});
    try { await checkDiffBlink(browser, process.argv[2]); }
    finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
