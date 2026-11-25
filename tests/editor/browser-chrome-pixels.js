"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const url = pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href;
const editorChrome = [
  ".appbar, .brand, .brand-mark, .brand-wordmark, .menubar, .work-menu > summary, .appbar-actions, .appbar-actions button",
  "#workbench, #navigator, #properties, #editor-area, #editor-panes, .split-pane, .split-pane > canvas, .split-sash",
  ".dock-group, .dock-body, .dock-sash, .dock-tabs, .dock-tab-wrap, .dock-tab, .dock-tab-close, .pane-heading, .pane-heading button",
  ".editor-tabbar, #document-tabs, .document-tab, .document-tab-close, .split-button, .pane-tabs, .pane-tab, .pane-close",
  ".active-bar, .active-bar .tool, .active-bar .tool-divider",
  ".layer-bar, .layer-tabs, .layer-menu-button, .layer-tab, .layer-swatch",
  ".project-tree > summary, .tree-folder > summary, #documents > .doc-row",
  ".statusbar, .status-axis, .statusbar .status-action, .view-palette, .view-palette > button",
];

function isWhole({x,y,width,height}) {
  return [x,y,width,height].every(Number.isInteger);
}

async function boxes(page, selector) {
  return page.locator(selector).evaluateAll(nodes => nodes.flatMap(node => {
    const {x,y,width,height} = node.getBoundingClientRect();
    if (!width || !height || getComputedStyle(node).visibility !== "visible") return [];
    return [{name:node.id || node.dataset.action || node.getAttribute("aria-label") || node.classList[0] || node.tagName,
      x,y,width,height}];
  }));
}

async function boot(page, theme) {
  await page.goto(url);
  await page.evaluate(theme => AtriumTheme.set({preset:theme,followSystem:false,motion:"off"}),theme);
  const welcome = page.locator("dialog.sp-dialog[open]");
  await welcome.waitFor();
  const bounds = await welcome.boundingBox();
  assert.ok(isWhole(bounds),"the native top-layer Welcome box has whole-pixel edges");
  await welcome.locator("[data-start-action=demo]").click();
  await page.waitForFunction(() => AtriumNavHost.doc().kind === "pcb");
  await page.evaluate(() => AtriumLazy.need("AtriumDock"));
  await page.locator(".layer-tab").first().waitFor();
  await page.locator(".dock-sash-left").waitFor();
}

async function dragSash(page, locator, dx, dy, observe) {
  const {x,y,width,height} = await locator.boundingBox();
  const at = [x + width / 2,y + height / 2];
  await page.mouse.move(...at);
  await page.mouse.down();
  try {
    await page.mouse.move(at[0] + dx,at[1] + dy,{steps:4});
    await observe?.();
  } finally {
    await page.mouse.up();
  }
}

async function coldRestore(browser) {
  const page = await browser.newPage({viewport:{width:1281,height:801}});
  let resume;
  const deferred = new Promise(resolve => { resume = resolve; });
  try {
    await page.addInitScript(() => {
      localStorage.setItem("atrium.prefs",JSON.stringify({format:"atrium-prefs",version:1,values:{"workbench.layout":{sizes:{left:319.75,right:329.75}}}}));
    });
    await page.route("**/dock.js",async route => {await deferred; await route.continue();});
    await page.goto(url,{waitUntil:"domcontentloaded"});
    const widths = () => page.evaluate(() => ["navigator","properties"].map(id =>
      document.getElementById(id).getBoundingClientRect().width));
    assert.equal(await page.evaluate(() => !!globalThis.AtriumDock),false,"measure before the lazy dock script");
    assert.deepEqual(await widths(),[320,330],"the first-paint restored widths use the same rounding as the layout model");
    resume();
    await page.evaluate(() => AtriumLazy.need("AtriumDock"));
    await page.locator(".dock-sash-left").waitFor();
    assert.deepEqual(await widths(),[320,330],"the lazy dock preserves the first-paint widths");
  } finally {resume(); await page.close();}
}

// Every top-level menu title has the same font metrics idle, hovered and open: size, weight, letter-spacing,
// family, no transform or zoom, and the same rendered glyph box (beta: "File" looked smaller than "Edit").
async function menuTitles(page, theme) {
  const metrics = () => page.locator(".menubar .work-menu > summary").evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).map(node => {
    const css = getComputedStyle(node), range = document.createRange(); range.selectNodeContents(node);
    let scaled = false;
    for (let n = node; n; n = n.parentElement) {const c = getComputedStyle(n); if (c.transform !== "none" || c.scale !== "none" || c.zoom !== "1") scaled = true;}
    return {name:node.textContent.trim(), scaled, font:[css.fontSize,css.fontWeight,css.letterSpacing,css.fontFamily,css.fontStretch,css.fontVariationSettings].join("|"),
      glyph:range.getBoundingClientRect().height, phase:(node.getBoundingClientRect().left % 1).toFixed(3)};
  }));
  const same = (list, state) => {
    assert.ok(list.length >= 6 && list[0].name === "File",theme + " " + state + ": the menu bar titles are measured " + JSON.stringify(list));
    for (const key of ["font","glyph","phase","scaled"]) assert.equal(new Set(list.map(m => String(m[key]))).size,1,
      theme + " " + state + ": every top-level menu title has the same " + key + " " + JSON.stringify(list.map(m => [m.name,m[key]])));
    assert.equal(list[0].scaled,false,theme + " " + state + ": no menu title is transformed");
  };
  same(await metrics(),"idle");
  const file = page.locator("details[data-menu=file] > summary");
  await file.hover();
  same(await metrics(),"File hovered");
  await file.click();
  await page.locator("details[data-menu=file][open] > .menu-items").waitFor();
  same(await metrics(),"File open");
  await page.keyboard.press("Escape");
  await page.mouse.move(640,400);
}

async function testEditor(browser, {dpr, width, height, theme}) {
  const page = await browser.newPage({viewport:{width,height},deviceScaleFactor:dpr});
  page.setDefaultTimeout(6500);
  const failures = [];
  let checked = 0;
  async function check(state, selectors) {
    for (const selector of selectors) {
      const measured = await boxes(page,selector);
      assert.ok(measured.length,state + " exercised " + selector);
      checked += measured.length;
      failures.push(...measured.filter(rect=>!isWhole(rect)).map(rect=>({state,...rect})));
    }
  }
  const widths = () => page.evaluate(() => ["navigator","properties"].map(id=>document.getElementById(id).getBoundingClientRect().width));
  const defaults = w => [Math.round(Math.min(250,Math.max(196,w*.16))),Math.round(Math.min(344,Math.max(256,w*.23)))];
  const act = action => page.evaluate(action=>AtriumNavHost.act(action),action);

  try {
    assert.equal(await page.evaluate(()=>devicePixelRatio),dpr,"verify the actual screenshot scale");
    await boot(page,theme);
    await check("Default editor",editorChrome);
    assert.deepEqual(await widths(),defaults(width));
    // More panels than the right dock's tab header holds: it ends with the overflow menu button.
    const panels = ["nets-panel","messages","pcb-list","library-panel","query-panel","comments-panel"];
    for (const action of panels) await act(action);
    await page.locator("#properties .dock-tab-wrap.dock-tab-hidden").first().waitFor({state:"attached"});
    await check("Dock tab overflow",["#properties .dock-tab-overflow, #properties .dock-tab-more, #properties .dock-tab-more .icon"]);
    for (const action of panels) await act(action);
    await page.locator("#properties .dock-tab-wrap.dock-tab-hidden").first().waitFor({state:"detached"});
    await check("Dock tab strip without overflow",["#properties .dock-tab-overflow, #properties .dock-tab-more, #properties .dock-tab-more .icon"]);
    await menuTitles(page,theme);
    const search = page.locator("#collab-share");
    const searchBounds = await search.boundingBox();
    await search.evaluate(node => { node.style.translate = "0 .5px"; });
    const shifted = await search.boundingBox();
    assert.equal(shifted.y - searchBounds.y,.5);
    assert.equal(isWhole(shifted),false,"the exact rect check rejects a real half-pixel shift");
    await search.evaluate(node => { node.style.removeProperty("translate"); });

    await page.locator("details[data-menu=edit] > summary").click();
    const menu = page.locator("details[data-menu=edit][open] > .menu-items");
    await menu.getByRole("menuitem",{name:/Undo/}).waitFor();
    await check("Open Edit menu",["details[data-menu=edit][open] > .menu-items",
      "details[data-menu=edit][open] [role=menuitem], details[data-menu=edit][open] hr"]);
    await page.keyboard.press("Escape");

    const grid = page.locator("#status-grid-menu");
    await grid.locator("summary").click();
    await grid.getByRole("menuitemcheckbox",{name:"Show Grid"}).waitFor();
    await check("Status Grid menu",["#status-grid-menu > .menu-items,#status-grid-menu [role^=menuitem]"]);
    await page.keyboard.press("Escape");

    await page.locator("#canvas").click({button:"right",position:{x:300,y:200}});
    const context = page.locator(".nav-menu:visible").first();
    await context.waitFor();
    await check("Canvas context menu",[".nav-menu:visible", ".nav-menu .nav-menu-head,.nav-menu .nav-menu-item"]);
    await page.keyboard.press("Escape");
    await context.waitFor({state:"hidden"});

    await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click();
    const palette = page.locator("#palette[open]");
    await palette.locator(".nav-palette-item").first().waitFor();
    await check("Open Command Palette",["#palette[open], .nav-palette-query, .nav-palette-body, .nav-palette-results, .nav-palette-list",
      ".nav-palette-group, .nav-palette-item, .nav-palette-foot, .nav-palette-foot-btn"]);
    const query = palette.getByRole("combobox");
    await query.fill("undo");
    await palette.getByRole("option",{name:/Undo/}).first().waitFor();
    await check("Filtered Command Palette",["#palette[open], .nav-palette-query, .nav-palette-body, .nav-palette-list",
      ".nav-palette-item"]);
    await query.press("Escape");
    await palette.waitFor({state:"hidden"});

    await page.locator('#document-tabs [data-kind="schematic"]').click();
    await page.waitForFunction(()=>AtriumNavHost.doc().kind==="schematic");
    await check("Schematic editor",editorChrome.filter(selector=>!selector.startsWith(".layer-bar")));
    // The Annotate status line shares the action row and stays whole inside it, even in a short window.
    for (const height of [h => h, () => 520]) {
      const size = page.viewportSize();
      await page.setViewportSize({width:size.width,height:height(size.height)});
      await act("annotate");
      const annotate = page.locator("dialog.annotate-dialog[open]");
      await annotate.waitFor();
      await annotate.locator(".ann-start-cell input[type=checkbox]").first().click();
      const footer = await annotate.evaluate(dialog => {
        const status = dialog.querySelector(".ui-dialog-status"), row = dialog.querySelector(".ui-dialog-actions");
        const range = document.createRange(); range.selectNodeContents(status);
        const [s,t,r,d] = [status.getBoundingClientRect(),range.getBoundingClientRect(),row.getBoundingClientRect(),dialog.getBoundingClientRect()];
        return {text:status.textContent,inRow:status.parentElement === row,
          inside:[s,t].every(b => b.top >= r.top && b.bottom <= r.bottom && b.left >= r.left && b.right <= r.right),
          rowInDialog:r.bottom <= d.bottom + .01,whole:[r.top,r.height].every(Number.isInteger),
          centred:Math.abs((s.top + s.bottom) / 2 - (r.top + r.bottom) / 2) <= 1};
      });
      assert.match(footer.text,/Start index changed/);
      assert.ok(footer.inRow && footer.inside && footer.rowInDialog && footer.centred,"the Annotate status is fully inside its footer " + JSON.stringify(footer));
      assert.ok(footer.whole,"the Annotate footer sits on whole pixels " + JSON.stringify(footer));
      await page.keyboard.press("Escape");
      await annotate.waitFor({state:"hidden"});
      await page.setViewportSize(size);
    }
    await page.locator('#document-tabs [data-kind="pcb"]').click();
    await page.waitForFunction(()=>AtriumNavHost.doc().kind==="pcb");

    if (dpr === 1) {
      for (const [side, delta, index] of [["left",37,0],["right",-39,1]]) {
        const sash = page.locator(".dock-sash-" + side);
        const previous = (await widths())[index];
        await dragSash(page,sash,delta,0,() => check("Dragging the " + side + " dock",editorChrome));
        assert.equal((await widths())[index],previous+Math.abs(delta),side + " dock uses the real drag delta");
      }
      await page.evaluate(() => {
        const layout = AtriumDock.current();
        AtriumPref.set("workbench.layouts",{"Pixel test":{...layout, sizes:{left:900,right:346.6}}});
        AtriumDock.applyNamed("Pixel test");
      });
      const savedSizes = w => [Math.round(w*.45),Math.min(347,Math.round(w*.45))];
      assert.deepEqual(await widths(),savedSizes(width),"restoring a named layout keeps a whole-pixel viewport cap");
      for (const [w,h] of [[1280,800],[1281,801],[1049,713],[1440,900]]) {
        await page.setViewportSize({width:w,height:h});
        assert.deepEqual(await widths(),savedSizes(w),"resizing does not move either dock off the pixel grid");
        await check("Restored layout at " + w + "×" + h,editorChrome);
      }
      for (const side of ["left","right"]) await page.locator(".dock-sash-" + side).press("Enter");
      assert.deepEqual(await widths(),defaults(1440),"reset restores the responsive pixel grid");
      await check("Reset dock widths",editorChrome);

      await page.setViewportSize({width:1281,height:801});
      await page.evaluate(() => AtriumNavHost.openSplit("right"));
      const split = page.locator("#canvas-sash");
      await split.waitFor();
      await check("Split editor",editorChrome);
      await dragSash(page,split,39,0,() => check("Drag split editor",editorChrome));
    }

    await act("about");
    await page.getByRole("dialog",{name:/About Waffle/}).waitFor();
    await check("Native centered About dialog",["dialog.about-dialog[open]"]);
    const about = await page.locator("dialog.about-dialog[open]").evaluate(dialog => {
      const close = [...dialog.querySelectorAll("button")].find(button => button.textContent === "Close");
      const css = getComputedStyle(close);
      return {text:dialog.textContent,variant:close.dataset.variant,focused:document.activeElement?.localName,
        outline:css.outlineStyle === "none" || parseFloat(css.outlineWidth) === 0,ring:css.boxShadow,
        focusRing:getComputedStyle(document.activeElement).outlineStyle};
    });
    assert.doesNotMatch(about.text,/native 2\.0 project folder|\.waffle manifest|re-import/,"About has no file-format paragraph");
    assert.equal(about.variant,"secondary","About closes with the standard secondary button");
    assert.ok(about.outline && !/rgb/.test(about.ring) && about.focused !== "button","the Close button shows no outline on open " + JSON.stringify(about));
    assert.equal(about.focusRing,"none","the focused dialog title draws no ring");
    await page.keyboard.press("Escape");
    await page.locator("dialog.about-dialog[open]").waitFor({state:"hidden"});
    const file = page.locator("details[data-menu=file]");
    await file.locator("summary").click();
    await file.locator('[data-action="preferences"]').click();
    await page.getByRole("dialog",{name:"Preferences",exact:true}).waitFor();
    await check("Modeless Preferences window",["dialog.prf-dialog[open]"]);
    assert.deepEqual(failures,[],theme + " at " + dpr + "× has fractional chrome");
    console.log(`PASS chrome pixels ${width}×${height} ${theme} at ${dpr}×: ${checked} measured boxes`);
  } finally { await page.close(); }
}

// WebKit (the macOS app) has no calc-size(), which rounds content-sized chrome up to whole pixels in CSS.
// Emulate that here: CSS.supports() says no and those widths fall back to auto, as WebKit drops the
// declaration. AtriumWholePixels then rounds the same boxes, so menu titles, document and dock tabs and
// context menus (and the labels after them) still start on whole pixels, with no label cut short.
async function withoutCalcSize(browser) {
  const page = await browser.newPage({viewport:{width:1440,height:900}});
  page.setDefaultTimeout(6500);
  const families = [".menubar .work-menu > summary",".document-tab",".dock-tab-wrap",".dock-tab",".nav-menu-portal .nav-menu"];
  const frames = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(done)))));
  try {
    await page.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => !args.join(" ").includes("calc-size") && supports(...args);
      addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style");
        style.textContent = ":is(.work-menu > summary,.document-tab,.dock-tab-wrap,.dock-tab,.nav-menu) {inline-size:auto !important}";
        document.head.append(style);
      });
    });
    await boot(page,"light");
    await page.evaluate(() => AtriumNavHost.act("nets-panel"));
    await page.locator("#document-tabs .document-tab").first().click({button:"right"});
    await page.locator(".nav-menu-portal .nav-menu").first().waitFor();
    await page.waitForFunction(() => globalThis.AtriumWholePixels);
    await frames();
    const state = await page.evaluate(families => {
      const measured = families.map(selector => [...document.querySelectorAll(selector)].filter(n => n.getClientRects().length).map(node => {
        const {x,width} = node.getBoundingClientRect(), label = node.matches(".document-tab") ? node.querySelector("span") : node;
        return {selector,name:node.textContent.trim().slice(0,24),x,width,rounded:!!node.style.minInlineSize,
          cut:node.matches(".nav-menu") ? false : label.scrollWidth > label.clientWidth};
      }));
      return {measured};
    },families);
    for (const [i,list] of state.measured.entries()) assert.ok(list.length,"without calc-size: exercised " + families[i]);
    const all = state.measured.flat();
    assert.ok(all.some(m => m.rounded),"without calc-size some chrome has a fractional text width to round " + JSON.stringify(all));
    assert.deepEqual(all.filter(m => !Number.isInteger(m.x) || !Number.isInteger(m.width)),[],"without calc-size every menu title, tab and menu sits on whole pixels");
    assert.deepEqual(all.filter(m => m.cut),[],"rounding never cuts a label short");
    const titles = await page.locator(".menubar .work-menu > summary").evaluateAll(nodes => nodes.map(n => n.getBoundingClientRect().left % 1));
    assert.equal(new Set(titles).size,1,"every menu title starts on the same pixel phase without calc-size");
    await page.keyboard.press("Escape");
    console.log(`PASS chrome pixels without calc-size: ${all.length} menu titles, document and dock tabs and menus on whole pixels`);
  } finally { await page.close(); }
}

async function run(browser) {
  await withoutCalcSize(browser);
  await coldRestore(browser);
  await testEditor(browser,{dpr:1,width:1440,height:900,theme:"light"});
  await testEditor(browser,{dpr:2,width:1281,height:801,theme:"dark"});
}

module.exports = run;

if (require.main === module) {
  const {chromium} = require("playwright-core");
  (async () => {
    const browser = await chromium.launch({
      ...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--allow-file-access-from-files"],
    });
    try {await run(browser);} finally {await browser.close();}
  })().catch(error=>{console.error(error);process.exitCode=1;});
}
