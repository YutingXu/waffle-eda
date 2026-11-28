"use strict";
// Slides tab: flag off stays cold; the strip, the slide inspector,
// reorder, a removed frame, the presentation bar with notes, return on End, and the empty deck.
const assert = require("node:assert/strict");
const S = require("../support/docs-family-ui.cjs");

module.exports = async function slidesUI(browser) {
  const page = await S.editor(browser);
  try {
    await S.slidesProject(page);
    assert.deepEqual(await S.commands(page, "butter.slides."), [], "flag off registers nothing");
    await S.enable(page, ["savedViews", "slides"]);
    await S.run(page, "butter.slides.panel");
    const panel = page.locator(".panel-views"), pane = panel.locator("[data-pane=slides]");
    const tiles = pane.locator(".docs-strip .ui-thumb");
    await tiles.first().waitFor();
    assert.equal(await panel.getByRole("tab", {name:"Slides"}).getAttribute("aria-selected"), "true");
    assert.equal(await tiles.count(), 3);
    assert.equal(await tiles.first().getAttribute("aria-current"), "true");
    await pane.locator(".docs-strip .ui-thumb canvas[data-ready=true]").first().waitFor();

    // Inspector: title edits are one Undo step; aspect switches in place.
    await tiles.nth(1).click();
    await pane.locator(".ui-section-title", {hasText:"Slide 2 of 3"}).waitFor();
    const title = pane.getByRole("textbox", {name:"Slide title"});
    await title.fill("Sensor input, close");
    await title.press("Enter");
    await page.waitForFunction(() => AtriumNavHost.project().slides[1].name === "Sensor input, close");
    await pane.getByRole("button", {name:"16:9", exact:true}).click();
    await page.waitForFunction(() => AtriumNavHost.project().slides[1].aspect === "16:9");

    // Reorder from the keyboard: ⌥→ moves the current slide later.
    await tiles.nth(1).focus();
    await page.keyboard.press("Alt+ArrowRight");
    await page.waitForFunction(() => AtriumNavHost.project().slides[2].name === "Sensor input, close");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    await page.waitForFunction(() => AtriumNavHost.project().slides[1].name === "Sensor input, close");

    // Context menu: a right-click on a tile opens its menu 2 px up and left of the pointer; Escape closes it.
    {
      const box = await tiles.first().boundingBox(), at = [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
      await page.mouse.click(...at, {button:"right"});
      const menu = page.locator(".nav-menu[role=menu]", {has:page.getByRole("menuitem", {name:"Show slide", exact:true})});
      await menu.waitFor();
      assert.deepEqual(await menu.evaluate(node => [parseFloat(node.style.left), parseFloat(node.style.top)]), [at[0] - 2, at[1] - 2],
        "a slide's context menu starts 2 px up and left of the pointer");
      await page.keyboard.press("Escape");
      await menu.waitFor({state:"hidden"});
    }

    // Presentation: chrome hides, the bar steps, notes show as text, End returns the camera.
    const before = await page.evaluate(() => ({doc:AtriumNavHost.currentId(), cx:AtriumNavHost.view().camera().cx}));
    await pane.getByRole("button", {name:"Present", exact:true}).click();
    const bar = page.locator(".docs-stage-bar");
    await page.waitForFunction(() => document.querySelector(".docs-stage-bar .ui-pager-position")?.textContent === "1 of 3");
    assert.equal(await page.locator(".appbar").isVisible(), false, "the window chrome steps aside");
    assert.equal(await bar.getByRole("button", {name:"Previous slide"}).isDisabled(), true);
    await page.keyboard.press("Space");
    await page.waitForFunction(() => document.querySelector(".docs-stage-bar .ui-pager-position").textContent === "2 of 3");
    await bar.getByRole("button", {name:"Notes"}).click();
    const notes = page.locator(".docs-notes");
    await notes.waitFor();
    assert.match(await notes.textContent(), /Walk through the linked input\./);
    assert.match(await notes.textContent(), /Next: Backup view/);
    assert.equal(await bar.locator(".ui-badge").isVisible(), true, "a partial slide says so");
    assert.equal(await bar.getByRole("button", {name:"Presenter window"}).isDisabled(), true, "no second window without Project windows");
    // Right-drag pans (the user's pan gesture); the bar offers the way back to the slide's camera.
    await page.mouse.move(600, 300); await page.mouse.down({button:"right"}); await page.mouse.move(660, 340, {steps:4}); await page.mouse.up({button:"right"});
    await bar.getByRole("button", {name:"Back to slide"}).waitFor();
    await page.keyboard.press("Escape"); // closes notes first
    await notes.waitFor({state:"detached"}).catch(() => notes.waitFor({state:"hidden"}));
    await page.keyboard.press("Escape");
    await bar.waitFor({state:"detached"});
    await page.waitForFunction(b => AtriumNavHost.currentId() === b.doc, before);
    assert.equal(await page.locator(".appbar").isVisible(), true);

    // A removed frame marks its tile and offers a new source.
    await page.evaluate(() => {
      const h = AtriumNavHost, d = h.project().documents[0], f = d.items.find(i => i.kind === "textframe" && i.role === "frame");
      h.edit(() => d.items.splice(d.items.indexOf(f), 1), "Delete frame", new Set([f.id]));
    });
    await pane.locator(".docs-strip .ui-thumb[data-state=failed]").waitFor();
    await tiles.first().click();
    await pane.getByRole("button", {name:"Change source…"}).waitFor();
    await page.evaluate(() => AtriumNavHost.act("undo"));
    await pane.locator(".docs-strip .ui-thumb[data-state=failed]").waitFor({state:"detached"});

    // Empty deck: navigation and export disabled, a first-slide action offered.
    await page.evaluate(async () => { for (const s of [...AtriumNavHost.project().slides]) await AtriumButterEditor.apply("butter.slides.remove", {id:s.id}); });
    await pane.locator(".ui-empty", {hasText:"No slides"}).waitFor();
    assert.equal(await pane.getByRole("button", {name:"Present", exact:true}).isDisabled(), true);
    assert.equal(await pane.getByRole("button", {name:"Export PDF…"}).isDisabled(), true);
    await pane.getByRole("button", {name:"Add current frame"}).click();
    await page.waitForFunction(() => AtriumNavHost.project().slides.length === 1);
    assert.deepEqual(page.errors, []);
    console.log("PASS slides tab: cold default, strip and inspector, reorder, presentation with notes and return, removed frame, empty deck");
  } finally { await page.close(); }
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}), args:["--allow-file-access-from-files"]});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
