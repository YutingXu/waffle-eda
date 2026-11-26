"use strict";

// Shortcuts that hand focus back to the canvas or a document tab never ring it; keyboard
// navigation (Tab) still does. Run standalone or as part of integration-browser.cjs.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

// The active element's own outline, plus the pane overlay the canvas uses for keyboard focus.
function ring(page) {
  return page.evaluate(() => {
    const node = document.activeElement, css = getComputedStyle(node);
    const pane = node.matches("#canvas,#canvas-2") ? node.closest(".split-pane") : null;
    const after = pane && getComputedStyle(pane, "::after");
    return {
      id: node.id || node.className,
      outline: css.outlineStyle !== "none" && parseFloat(css.outlineWidth) > 0,
      shadow: css.boxShadow !== "none",
      overlay: !!after && after.content !== "none" && after.display !== "none"
    };
  });
}

async function noRing(page, label) {
  const state = await ring(page);
  assert.deepEqual({outline:state.outline, shadow:state.shadow, overlay:state.overlay},
    {outline:false, shadow:false, overlay:false}, label + " (" + state.id + ")");
}

module.exports = async function focusRings(browser) {
  const page = await browser.newPage({viewport:{width:1200, height:760}, reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  try {
    await page.addInitScript(() => {
      let reads = 0;
      const getClientRects = Element.prototype.getClientRects;
      Element.prototype.getClientRects = function() {
        if (document.currentScript?.src?.endsWith("/editor/shell.js") &&
            this.closest("[role=toolbar],#projects-tree")) reads++;
        return getClientRects.call(this);
      };
      document.addEventListener("DOMContentLoaded", () => {
        Element.prototype.getClientRects = getClientRects;
        globalThis.startupRovingGeometryReads = reads;
      }, {once:true});
    });
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    const demo = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Try the Demo", exact:true});
    await demo.click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    assert.equal(await page.evaluate(() => globalThis.startupRovingGeometryReads), 0,
      "initial keyboard stops do not force the workbench to lay out during shell startup");
    const quick = page.getByRole("toolbar", {name:"Quick access"});
    await quick.getByRole("button", {name:"Open", exact:true}).focus();
    await page.keyboard.press("ArrowRight");
    assert.ok(await quick.getByRole("button", {name:"Save", exact:true}).evaluate(n => n === document.activeElement && n.tabIndex === 0));
    await page.keyboard.press("Tab");
    assert.ok(await quick.evaluate(n => !n.contains(document.activeElement)), "Quick access remains a single Tab stop");
    const canvas = page.locator("#canvas"), palette = page.locator("#palette");
    const switcher = page.locator(".vsk-switch");
    async function shortcut(keys) {
      const before = await page.evaluate(() => AtriumNavHost.currentId());
      await page.keyboard.press(keys);
      if (keys !== "Escape") await page.waitForFunction(id => AtriumNavHost.currentId() !== id, before);
      await switcher.waitFor({state:"detached"});
    }

    const closePalette = async label => {
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => !document.getElementById("palette").open && document.activeElement?.id === "canvas");
      await noRing(page, label);
    };
    // Labs off: / opens the palette with no filter (2026-11-23); closing it leaves no stray ring on the canvas.
    assert.equal(await page.evaluate(() => AtriumLabs.notebookEnabled()), false);
    await canvas.click({position:{x:520, y:360}});
    await page.keyboard.press("/");
    await page.waitForFunction(() => document.getElementById("palette").open);
    await closePalette("Escape after / with Labs off");

    // Labs on: / opens the palette at the pointer, and Escape returns focus without a ring.
    await page.evaluate(async () => { await AtriumLazy.need("AtriumPrefs"); AtriumPrefs.set("labs.notebook", true); });
    await page.waitForFunction(() => AtriumLabs.notebookEnabled());
    await page.mouse.move(520, 360);
    await page.keyboard.press("/");
    await page.waitForFunction(() => document.getElementById("palette").open);
    const box = await palette.boundingBox();
    assert.ok(box && Math.abs(box.x - 520) < box.width && Math.abs(box.y - 360) < 400, "the insert palette opens near the pointer");
    await closePalette("Escape from the / palette");

    // Clicking a tab, then a tab-switch shortcut, leaves no ring on the tab or canvas.
    await page.locator('#document-tabs [data-kind="schematic"]').first().click();
    await page.locator("#doc-name", {hasText:"Analog front end"}).waitFor();
    await noRing(page, "clicking a document tab");
    for (const keys of ["Control+Tab", "Escape", "Control+Shift+Tab", "Escape"]) {
      await shortcut(keys);
      await noRing(page, "after " + keys);
    }

    // Tab key navigation onto a document tab still shows its ring.
    await page.locator('#document-tabs [aria-selected="true"]').first().focus();
    await page.keyboard.press("Shift+Tab");
    let reached = null, seen = [];
    for (let i = 0; i < 12 && !reached; i++) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(() => document.activeElement?.matches(".document-tab") ? document.activeElement.textContent : null);
      seen.push(await page.evaluate(() => document.activeElement?.id || document.activeElement?.className || document.activeElement?.tagName));
    }
    assert.ok(reached, "Tab reaches a document tab: " + seen.join(", "));
    const tabbed = await ring(page);
    assert.ok(tabbed.outline, "Tab onto a document tab shows its focus ring");
    // ...and the ring goes once a shortcut moves focus on.
    await shortcut("Control+Tab"); await shortcut("Escape");
    await noRing(page, "a shortcut after Tab navigation");

    // Tab onto the canvas marks the pane's top edge, never an outline round the sheet.
    await canvas.evaluate(node => node.blur());
    await page.locator('#document-tabs [aria-selected="true"]').first().focus();
    let onSheet = false;
    for (let i = 0; i < 40 && !onSheet; i++) {
      await page.keyboard.press("Tab");
      onSheet = await page.evaluate(() => document.activeElement?.id === "canvas");
    }
    assert.ok(onSheet, "Tab reaches the canvas");
    const sheet = await ring(page);
    assert.equal(sheet.outline, false, "no outline round the canvas on keyboard focus");
    assert.ok(sheet.overlay, "keyboard focus on the canvas shows the edge bar");
    const bar = await page.evaluate(() => {
      const pane = document.activeElement.closest(".split-pane"), after = getComputedStyle(pane, "::after");
      return {width:parseFloat(after.width), pane:pane.clientWidth, height:parseFloat(after.height)};
    });
    assert.ok(bar.height <= 3, "the canvas focus mark is a rule along one edge, not a frame");
    await page.keyboard.press("/"); await page.waitForFunction(() => document.getElementById("palette").open);
    await closePalette("Escape from the palette after Tab navigation");

    assert.deepEqual(errors, [], "no page errors");
    console.log("PASS focus rings: /, Escape, tab clicks and tab-switch shortcuts leave no ring; Tab still shows one");
  } finally { await page.close(); }
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => {
      const executablePath = process.env.CHROME;
      return executablePath ? {executablePath} : {channel:"chrome", args:["--allow-file-access-from-files"]};
    },
    browser => module.exports(browser),
    error => { console.error(error); process.exitCode = 1; });
}
