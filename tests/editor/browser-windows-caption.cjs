"use strict";

// Waffle's own title bar on Windows (native/windows/window-caption.js, app/style.css). The page is
// loaded as the Windows host loads it: chrome.webview carries the host messages and the caption
// script runs at document creation with the window's state. In a roomy window and the smallest one
// the host allows, it checks that
//   - the window controls fill the top right of the caption band, the height of the app bar, and
//     no app-bar content sits under them;
//   - a press on the blank caption asks the host to move the window, a double press maximises it and
//     a right click opens the window menu, without reaching the editor's own handlers;
//   - Minimize, Maximize and Close send their commands and leave focus where it was;
//   - the top edge asks for a resize from its left corner, middle and right corner, and is gone while
//     the window is maximised; Maximize turns into Restore;
//   - full screen hides the controls and the app bar takes its usual padding again;
//   - every menu-bar menu clears the window controls and fits in the window;
//   - under a modal dialog (the Start Page at launch) the window still moves and closes from its
//     caption, and the dialog stays open;
//   - without chrome.webview (macOS, Linux, a browser) the script does nothing.
// Run: node tests/editor/browser-windows-caption.cjs (NODE_PATH for Playwright Core, CHROME for a Chromium binary).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const ROOT = path.join(__dirname, "../..");
const SCRIPT = fs.readFileSync(path.join(ROOT, "native/windows/window-caption.js"), "utf8");
const PAGE = pathToFileURL(path.join(ROOT, "app/index.html")).href;
const BUTTON = 46, VIEWPORTS = [{width:1440, height:900}, {width:770, height:500}];

async function open(browser, viewport, {windows = true} = {}) {
  const context = await browser.newContext({viewport, reducedMotion:"reduce"});
  await context.route(/^https?:/, route => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  if (windows) await page.addInitScript(() => {
    window.__hostMessages = [];
    window.chrome = {webview:{postMessage:text => window.__hostMessages.push(JSON.parse(text))}};
    window.__waffleWindowCaptionState = {maximized:false, active:true, fullScreen:false};
  });
  await page.addInitScript(SCRIPT);
  await page.goto(PAGE);
  // The launch Start Page is a modal dialog; the backdrop case below reopens it.
  await page.locator("dialog.sp-dialog[open]").waitFor();
  await page.waitForFunction(() => globalThis.AtriumNavHost?.project()?.documents?.length > 0 && globalThis.AtriumNavHost.canvas());
  await page.evaluate(() => { for (const d of document.querySelectorAll("dialog.sp-dialog[open]")) d.close(); });
  await page.locator("dialog.sp-dialog[open]").waitFor({state:"hidden"});
  return {context, page, errors};
}

const messages = page => page.evaluate(() => window.__hostMessages.splice(0));
const setState = (page, state) => page.evaluate(state => window.__waffleWindowCaption(state), state);
const box = locator => locator.boundingBox();
const meets = (a, b) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

async function caption(browser, viewport) {
  const {context, page, errors} = await open(browser, viewport);
  const where = `${viewport.width}×${viewport.height}`;
  try {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.atriumNativeTitlebar), "windows", where + ": the root is marked as the Windows caption");
    const controls = page.locator(".window-controls");
    const buttons = controls.locator("button");
    assert.deepEqual(await buttons.evaluateAll(list => list.map(b => b.getAttribute("aria-label"))), ["Minimize", "Maximize", "Close"]);
    const bar = await box(page.locator(".appbar")), area = await box(controls);
    assert.equal(Math.round(area.x + area.width), viewport.width, where + ": the controls reach the right edge");
    assert.equal(area.y, 0, where + ": the controls start at the top edge");
    assert.equal(Math.round(area.width), 3 * BUTTON, where + ": three caption buttons, 46 px each");
    const appbarRow = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")));
    assert.equal(Math.round(area.height), appbarRow, where + ": the controls are as tall as the caption band");
    assert.ok(bar.height >= area.height, where + ": the app bar is at least the caption band");

    // No app-bar content under the controls.
    const under = await page.evaluate(rect => [...document.querySelectorAll(".appbar *")].filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && el.checkVisibility() && r.left < rect.x + rect.width && r.right > rect.x && r.top < rect.y + rect.height && r.bottom > rect.y;
    }).map(el => el.outerHTML.slice(0, 80)), area);
    assert.deepEqual(under, [], where + ": app-bar content under the window controls");

    // The blank caption: move, double press, window menu. The editor's handlers never see them.
    const blank = page.locator(".appbar-leading > [data-caption-drag]");
    const spot = await box(blank);
    assert.ok(spot && spot.width >= 24, where + ": the blank caption is there to grab");
    const x = spot.x + spot.width / 2, y = spot.y + spot.height / 2;
    await page.evaluate(() => { window.__editorSaw = 0; document.addEventListener("mousedown", () => window.__editorSaw++); });
    await page.mouse.move(x, y);
    await page.mouse.down(); await page.mouse.up();
    assert.deepEqual(await messages(page), [{action:"windowCaption", command:"drag"}]);
    await page.waitForTimeout(600); // past the double-click interval
    await page.mouse.dblclick(x, y);
    assert.deepEqual(await messages(page), [{action:"windowCaption", command:"drag"}, {action:"windowCaption", command:"maximize"}],
      where + ": a double press on the blank caption maximises");
    await page.mouse.click(x, y, {button:"right"});
    assert.deepEqual(await messages(page), [{action:"windowCaption", command:"menu"}], where + ": a right click opens the window menu");
    assert.equal(await page.evaluate(() => window.__editorSaw), 0, "the editor's press handlers never see a caption press");
    assert.equal(await page.locator(".nav-menu:visible").count(), 0, "no editor context menu opens on the caption");

    // The caption buttons send their commands and leave focus in the editor.
    await page.evaluate(() => AtriumNavHost.canvas().focus());
    for (const [label, command] of [["Minimize", "minimize"], ["Maximize", "maximize"], ["Close", "close"]]) {
      await controls.getByRole("button", {name:label, exact:true}).click();
      assert.deepEqual(await messages(page), [{action:"windowCaption", command}], where + ": " + label);
    }
    assert.ok(await page.evaluate(() => document.activeElement === AtriumNavHost.canvas()), "the caption buttons leave focus in the editor");

    // The top edge resizes from its corners and middle.
    for (const [px, edge] of [[3, "top-left"], [Math.round(viewport.width / 2), "top"], [viewport.width - 3, "top-right"]]) {
      await page.mouse.move(px, 2);
      await page.mouse.down(); await page.mouse.up();
      assert.deepEqual(await messages(page), [{action:"windowCaption", command:"resize", edge}], where + ": a press on the top edge at " + px);
    }

    // Maximised: Restore, and no resizing edge.
    await setState(page, {maximized:true});
    assert.equal(await buttons.nth(1).getAttribute("aria-label"), "Restore");
    assert.equal(await page.locator(".window-resize-edge").isVisible(), false, "no resizing edge while maximised");
    await page.mouse.move(Math.round(viewport.width / 2), 2);
    await page.mouse.down(); await page.mouse.up();
    assert.ok(!(await messages(page)).some(m => m.command === "resize"), "no resize request while maximised");
    await setState(page, {maximized:false});
    assert.equal(await buttons.nth(1).getAttribute("aria-label"), "Maximize");

    // An inactive window dims its controls; full screen hides them and the app bar's padding returns.
    await setState(page, {active:false});
    assert.ok(await page.evaluate(() => document.documentElement.hasAttribute("data-window-inactive")));
    await setState(page, {active:true, fullScreen:true});
    assert.equal(await controls.isVisible(), false, "no window controls in full screen");
    assert.equal(await page.locator(".appbar").evaluate(el => getComputedStyle(el).paddingRight), "6px");
    await page.mouse.move(x, y);
    await page.mouse.down(); await page.mouse.up();
    assert.deepEqual(await messages(page), [], "no move request in full screen");
    await setState(page, {fullScreen:false});

    // Under a modal dialog the caption still belongs to the window; the dialog stays open.
    await page.evaluate(async () => (await AtriumLazy.need("AtriumStartPage")).open());
    const start = page.locator("dialog.sp-dialog[open]");
    await start.waitFor();
    await page.mouse.move(x, y);
    await page.mouse.down(); await page.mouse.up();
    const closeAt = await box(controls.getByRole("button", {name:"Close", exact:true}));
    await page.mouse.click(closeAt.x + closeAt.width / 2, closeAt.y + closeAt.height / 2);
    await page.mouse.click(x, y, {button:"right"});
    assert.deepEqual(await messages(page), [{action:"windowCaption", command:"drag"}, {action:"windowCaption", command:"close"},
      {action:"windowCaption", command:"menu"}], where + ": the caption works over a modal dialog's backdrop");
    assert.ok(await start.isVisible(), "a press on the caption does not dismiss the dialog");
    await page.evaluate(() => { for (const d of document.querySelectorAll("dialog.sp-dialog[open]")) d.close(); });
    await start.waitFor({state:"hidden"});

    // Every menu-bar menu clears the window controls.
    for (const summary of await page.locator(".menubar .work-menu > summary:visible").all()) {
      await summary.click();
      const list = page.locator(".menubar .work-menu[open] > .menu-items");
      await list.waitFor();
      const menu = await box(list), title = await box(summary);
      assert.ok(menu.y >= title.y + title.height, where + ": " + await summary.innerText() + " opens below its title");
      assert.ok(!meets(menu, area), where + ": " + await summary.innerText() + " clears the window controls");
      // A menu starts in the caption band, under its title, and still stops at the bottom of the window.
      assert.ok(menu.y + menu.height <= viewport.height, where + ": " + await summary.innerText() + " fits above the bottom of the window");
      await page.keyboard.press("Escape");
      await list.waitFor({state:"hidden"});
    }
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  console.log(`ok Windows caption ${where}`);
}

async function elsewhere(browser) {
  const {context, page, errors} = await open(browser, VIEWPORTS[0], {windows:false});
  try {
    assert.equal(await page.evaluate(() => document.documentElement.dataset.atriumNativeTitlebar ?? null), null);
    assert.equal(await page.locator(".window-caption").count(), 0, "no caption without the Windows host");
    assert.equal(await page.locator(".appbar-leading > [data-caption-drag]").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
  console.log("ok Windows caption script is inert elsewhere");
}

module.exports = async function windowsCaption(browser) {
  for (const viewport of VIEWPORTS) await caption(browser, viewport);
  await elsewhere(browser);
};

if (require.main === module) (async () => {
  let chromium;
  try { ({chromium} = require("playwright-core")); }
  catch { console.log("SKIP Windows caption: Playwright Core is unavailable."); return; }
  const executablePath = process.env.CHROME;
  const browser = await chromium.launch({headless:true, args:["--allow-file-access-from-files"], ...(executablePath ? {executablePath} : {channel:"chrome"})});
  try { await module.exports(browser); } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
