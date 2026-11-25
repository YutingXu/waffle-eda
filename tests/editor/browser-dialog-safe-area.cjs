"use strict";

// Large work dialogs stay inside the window's safe area (below the title bar and app bar, and
// --dialog-margin clear of the edges), in the browser and with the macOS host's transparent title
// bar simulated; the Rules editor, a document tab, fills its document view below the app bar. Also: the Footprint Editor's Quick add buttons each add their shapes on the right
// layer as one undo step, select and draw them, and clear the related check.
// Run with NODE_PATH for Playwright Core (CHROME for a Chromium binary).
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const root = path.join(__dirname, "../..");
const MARGIN = 24, APPBAR = 30;
const R0603 = {id:"fp-test", name:"R0603", prefix:"R", footprint:{name:"R0603", shapes:[], pads:[
  {number:"1", x:-.8, y:0, w:.9, h:.95, shape:"roundrect"}, {number:"2", x:.8, y:0, w:.9, h:.95, shape:"roundrect"}]}};

// Each opener returns the selector of the dialog it opened.
const dialogs = [
  ["Footprint Editor", async page => { await page.evaluate(async def => {
    await AtriumLazy.need("AtriumLibrary"); globalThis.__fe = AtriumFootprintEditor.open({def}); }, R0603); return "dialog.fe-dialog[open]"; }],
  ["Symbol Editor", async page => { await page.evaluate(async () => {
    await AtriumLazy.need("AtriumLibrary"); AtriumSymbolEditor.open({}); }); return "dialog.se-dialog[open]"; }],
  ["Preferences", async page => { await page.evaluate(async () => { await AtriumLazy.need("AtriumPrefs"); AtriumPrefs.open(); }); return ".prf-dialog[open]"; }],
  ["Release", async page => { await act(page, "output-jobs"); return "dialog.rel-dialog[open]"; }],
  ["Print", async page => {
    await page.evaluate(async () => (await AtriumLazy.need("AtriumStartPage")).open());
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
    await act(page, "print");
    return "dialog.print-dialog[open]";
  }],
];
// Work surfaces that open as a document tab in the active pane (doc-views.js), not as a modal sheet.
const tabs = [
  ["Rules", async page => { await act(page, "rules"); return "dialog.rules-editor[open]"; }],
];

async function act(page, action) {
  await page.evaluate(async action => {
    const need = AtriumLazy.forAction(action, AtriumNavHost.doc()?.kind);
    if (need) await AtriumLazy.need(need);
    AtriumNavHost.act(action);
  }, action);
}

async function start(browser, viewport, native) {
  const context = await browser.newContext({viewport, reducedMotion:"reduce"});
  await context.route(/^https?:/, route => route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("dialog", dialog => dialog.accept());
  // The macOS host sets these from its window (native/macos/main.swift installCaptionScript).
  await page.goto(pathToFileURL(path.join(root, "app/index.html")).href);
  await page.waitForFunction(() => globalThis.AtriumNavHost && globalThis.AtriumLazy);
  if (native) await page.evaluate(height => {
    const root = document.documentElement;
    root.dataset.atriumNativeTitlebar = "macos";
    root.style.setProperty("--macos-caption-inset", "78px");
    root.style.setProperty("--macos-caption-height", height + "px");
  }, native);
  await page.evaluate(() => document.querySelectorAll("dialog[open]").forEach(d => d.close()));
  return {context, page, errors};
}

async function checkDialogs(browser, viewport, native) {
  const safeTop = Math.max(APPBAR, native || 0) + MARGIN;
  for (const [name, open] of dialogs) {
    const {context, page, errors} = await start(browser, viewport, native);
    try {
      const selector = await open(page);
      const box = await page.locator(selector).first().boundingBox();
      assert.ok(box, `${name} opened`);
      const where = `${name} at ${viewport.width}×${viewport.height}${native ? " (native title bar " + native + " px)" : ""}: ` + JSON.stringify(box);
      assert.ok(box.y >= safeTop - .5, `${where} starts below the title bar safe area (${safeTop} px)`);
      assert.ok(box.x >= MARGIN - .5, `${where} clears the left edge`);
      assert.ok(box.x + box.width <= viewport.width - MARGIN + .5, `${where} clears the right edge`);
      assert.ok(box.y + box.height <= viewport.height - MARGIN + .5, `${where} clears the bottom edge`);
      for (const v of [box.x, box.y, box.width, box.height]) assert.equal(v, Math.round(v), `${where} sits on whole pixels`);
      assert.deepEqual(errors, [], `${name} opened without page errors`);
    } finally { await context.close(); }
  }
  for (const [name, open] of tabs) {
    const {context, page, errors} = await start(browser, viewport, native);
    try {
      const view = await page.locator(await open(page)).first().evaluate(d => {
        const box = r => ({x:r.x, y:r.y, width:r.width, height:r.height});
        const host = d.closest(".doc-view"), bar = document.querySelector(".appbar");
        return {modal:d.matches(":modal"), box:box(d.getBoundingClientRect()), host:host && box(host.getBoundingClientRect()),
          barBottom:bar.getBoundingClientRect().bottom};
      });
      const where = `${name} at ${viewport.width}×${viewport.height}${native ? " (native title bar " + native + " px)" : ""}: ` + JSON.stringify(view);
      assert.equal(view.modal, false, `${where} is a document tab, not a modal sheet`);
      assert.ok(view.host, `${where} is mounted in a document view`);
      assert.deepEqual(view.box, view.host, `${where} fills its document view`);
      assert.ok(view.box.y >= Math.max(APPBAR, native || 0) && view.box.y >= view.barBottom - .5, `${where} starts below the app bar and title bar`);
      assert.ok(view.box.x >= 0 && view.box.x + view.box.width <= viewport.width + .5, `${where} stays inside the window width`);
      assert.ok(view.box.y + view.box.height <= viewport.height + .5, `${where} stays inside the window height`);
      for (const v of Object.values(view.box)) assert.equal(v, Math.round(v), `${where} sits on whole pixels`);
      assert.deepEqual(errors, [], `${name} opened without page errors`);
    } finally { await context.close(); }
  }
}

async function checkQuickAdd(browser) {
  const {context, page, errors} = await start(browser, {width:1440, height:900}, 0);
  try {
    await dialogs[0][1](page);
    const state = () => page.evaluate(() => ({
      shapes:structuredClone(__fe.draft.footprint.shapes),
      checks:[...document.querySelectorAll(".fe-checks li")].map(li => li.textContent),
      selected:[...document.querySelectorAll(".fe-props .fe-section h3, .fe-props h3")].map(h => h.textContent)
    }));
    const painted = () => page.evaluate(() => {
      const c = document.querySelector(".fe-canvas"), g = c.getContext("2d"), d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0; for (let i = 0; i < d.length; i += 4) n += d[i] + d[i + 1] + d[i + 2];
      return n;
    });
    const undo = () => page.keyboard.press(process.platform === "darwin" ? "Meta+Z" : "Control+Z");
    let before = await state();
    assert.ok(before.checks.some(t => /No courtyard/.test(t)));
    assert.ok(before.checks.some(t => /No silkscreen outline/.test(t)));
    const cases = [
      ["Courtyard from pads and body (+0.25)", s => s.layer === "Mechanical 15" && s.style === "courtyard" && s.closed, /No courtyard/],
      ["Silk outline around pads", s => s.style === "silk" && s.kind === "path", /No silkscreen outline/],
      [".Designator text on silk", s => s.kind === "text" && s.text === ".Designator" && s.layer === "Silk", null],
    ];
    for (const [label, wanted, check] of cases) {
      const ink = await painted();
      await page.getByRole("button", {name:label, exact:true}).click();
      const after = await state();
      const added = after.shapes.slice(before.shapes.length);
      assert.ok(added.length > 0 && added.every(wanted), `${label} adds shapes on the right layer: ${JSON.stringify(added)}`);
      if (check) assert.ok(!after.checks.some(t => check.test(t)), `${label} clears its check: ${after.checks}`);
      assert.notEqual(await painted(), ink, `${label} redraws the canvas with the new shapes`);
      const selection = await page.evaluate(() => document.querySelector(".fe-props .fe-section")?.textContent || "");
      assert.ok(!/^Footprint/.test(selection), `${label} selects the added shapes`);
      // One undo step removes exactly what the quick add added; redo-free state matches.
      await page.locator(".fe-canvas").focus();
      await undo();
      const undone = await state();
      assert.deepEqual(undone.shapes, before.shapes, `${label} is one undo step`);
      await page.locator(".fe-canvas").focus();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+Z" : "Control+Shift+Z");
      before = await state();
      assert.deepEqual(before.shapes, after.shapes, `${label} redoes`);
    }
    assert.deepEqual(before.checks, [], "All checks clear after the three quick adds");
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
}

async function dialogSafeArea(browser) {
  await checkQuickAdd(browser);
  console.log("ok quick add");
  for (const viewport of [{width:1440, height:900}, {width:1024, height:640}])
    for (const native of [0, 28]) await checkDialogs(browser, viewport, native);
  console.log("ok dialog safe area");
}

module.exports = dialogSafeArea;

async function main() {
  let chromium;
  try { ({chromium} = require("playwright-core")); }
  catch { console.log("SKIP dialog safe area: Playwright Core is unavailable."); return; }
  const executablePath = process.env.CHROME;
  const browser = await chromium.launch({headless:true, args:["--allow-file-access-from-files"], ...(executablePath ? {executablePath} : {channel:"chrome"})});
  try { await dialogSafeArea(browser); }
  finally { await browser.close(); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
