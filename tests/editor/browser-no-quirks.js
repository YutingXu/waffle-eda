"use strict";

// The window behaves like a native app, never like a web page (docs/design-system.md, Native
// behaviour): no selectable chrome, no browser context menu, no drag ghosts, no page scrolling or
// zoom, no browser shortcuts, no spelling marks in identifiers, the arrow cursor on buttons, and no
// focus ring after a shortcut moves focus. Run standalone or as part of integration-browser.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const APP = path.join(__dirname, "../../app");

// Static policies over every stylesheet: the pointing hand only on text links, and box-shadow
// focus rings only under the keyboard-navigation marker.
function stylesheetPolicies() {
  const LINK_CURSORS = [/(^|,)\s*:where\(a\[href\]\)$/, /\.blame-link$/, /\.netlist-source \[role=link\]$/, /\.sync-hint-link$/, /\.tut-link$/];
  const FIELDS = /(textarea|input|\[contenteditable)/;
  const problems = [];
  const files = [...fs.readdirSync(APP).filter(f => f.endsWith(".css")).map(f => path.join(APP, f)),
    ...fs.readdirSync(path.join(APP, "ui")).filter(f => f.endsWith(".css")).map(f => path.join(APP, "ui", f))];
  for (const file of files) {
    const css = fs.readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = match[1].trim().replace(/\s+/g, " "), body = match[2], name = path.relative(APP, file);
      if (/cursor:\s*pointer/.test(body) && !LINK_CURSORS.some(re => re.test(selector)))
        problems.push(name + ": cursor:pointer on " + selector + " (buttons use the arrow; only text links use the hand)");
      // Hand cursors only on canvases a hand moves (the 3D view); panels, tabs and headers use the arrow.
      if (/cursor:\s*grab/.test(body) && !/canvas/.test(selector))
        problems.push(name + ": cursor:grab on " + selector + " (draggable chrome keeps the arrow, as in Finder and Xcode)");
      if (/box-shadow:(?!\s*none)/.test(body)) for (const part of selector.split(",")) {
        if (part.includes(":focus-visible") && !part.includes("[data-focus-nav=keys]") && !FIELDS.test(part))
          problems.push(name + ": box-shadow focus ring without :root[data-focus-nav=keys] on " + part.trim());
      }
    }
  }
  assert.deepEqual(problems, [], "stylesheet policies");
}

// The active element shows no outline or box-shadow ring.
async function noRing(page, label) {
  const state = await page.evaluate(() => {
    const node = document.activeElement, css = getComputedStyle(node), probe = document.createElement("i");
    probe.style.color = "var(--focus)"; document.body.append(probe);
    const focus = getComputedStyle(probe).color; probe.remove();
    return {id: node.id || node.getAttribute("data-action") || node.className || node.tagName,
      ring: css.outlineStyle !== "none" && parseFloat(css.outlineWidth) > 0 || css.boxShadow.includes(focus)};
  });
  assert.equal(state.ring, false, label + " leaves no focus ring (" + state.id + ")");
}

module.exports = async function noQuirks(browser) {
  stylesheetPolicies();
  const page = await browser.newPage({viewport:{width:1200, height:760}, reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  try {
    await page.goto(pathToFileURL(path.join(APP, "index.html")).href);
    const demo = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Try the Demo", exact:true});
    await demo.waitFor(); await demo.click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    // A plain single-line field, as modules create them (the demo board shows none at rest).
    await page.evaluate(() => {
      window.__noQuirksPage = true;
      const field = Object.assign(document.createElement("input"), {type:"text", id:"nq-field", value:"VCC_3V3"});
      field.style.cssText = "position:fixed;left:40%;top:40%;z-index:9999";
      document.body.append(field);
    });

    // 1. Selection, cursors, scrolling, zoom and touch on the root.
    const base = await page.evaluate(() => {
      const css = node => getComputedStyle(node), html = css(document.documentElement);
      const pick = sel => [...document.querySelectorAll(sel)].find(n => n.getClientRects().length && getComputedStyle(n).visibility === "visible");
      const chrome = ["#status", ".appbar", ".document-tab", ".pane-heading h2", "#documents button, #documents summary", "#coord-x", "#zoom-value", "button"]
        .map(sel => [sel, pick(sel)]).filter(([, n]) => n);
      const area = document.body.appendChild(document.createElement("textarea")), pre = document.body.appendChild(document.createElement("pre"));
      const out = {
        root: {userSelect: html.userSelect, overscroll: html.overscrollBehaviorY, body: css(document.body).overscrollBehaviorY,
          touch: html.touchAction, cursor: html.cursor, overflow: html.overflow},
        chrome: Object.fromEntries(chrome.map(([sel, n]) => [sel, css(n).userSelect])),
        cursors: Object.fromEntries(chrome.map(([sel, n]) => [sel, css(n).cursor])),
        fields: {search: css(document.getElementById("nq-field")).userSelect, textarea: css(area).userSelect, pre: css(pre).userSelect,
          searchCursor: css(document.getElementById("nq-field")).cursor},
        titles: [...document.querySelectorAll("[title]")].filter(n => n.localName !== "title").length
      };
      area.remove(); pre.remove();
      return out;
    });
    assert.deepEqual(base.root, {userSelect:"none", overscroll:"none", body:"none", touch:"pan-x pan-y", cursor:"default", overflow:"hidden"}, "root policies");
    for (const [sel, value] of Object.entries(base.chrome)) assert.equal(value, "none", sel + " is not selectable");
    // auto would resolve to the I-beam over text; grab and resize cursors on handles are fine.
    for (const [sel, value] of Object.entries(base.cursors)) assert.ok(!["pointer", "text", "auto"].includes(value), sel + " uses the arrow, not " + value);
    assert.deepEqual({search:base.fields.search, textarea:base.fields.textarea, pre:base.fields.pre}, {search:"text", textarea:"text", pre:"text"}, "fields and text stay selectable");
    assert.equal(base.fields.searchCursor, "auto", "fields keep the I-beam");
    assert.equal(base.titles, 0, "no element keeps a native title tooltip");

    // Double- and triple-click on chrome select nothing.
    for (const sel of ["#status", ".pane-heading h2", ".document-tab"]) {
      const box = await page.locator(sel).filter({visible:true}).first().boundingBox();
      await page.mouse.click(box.x + 6, box.y + box.height / 2, {clickCount:3});
      assert.equal(await page.evaluate(() => getSelection().toString()), "", "triple-click on " + sel + " selects no text");
    }
    await page.keyboard.press("Escape");

    // 2. Context menus: the browser's never opens, on chrome, fields or the canvas.
    await page.evaluate(() => {
      window.__menus = [];
      addEventListener("contextmenu", e => window.__menus.push(e.defaultPrevented));
    });
    for (const sel of ["#status", ".appbar", ".document-tab", "#inspector", "#nq-field"]) {
      const box = await page.locator(sel).filter({visible:true}).first().boundingBox();
      await page.mouse.click(box.x + 8, box.y + Math.min(8, box.height / 2), {button:"right"});
      await page.keyboard.press("Escape");
    }
    const menus = await page.evaluate(() => window.__menus);
    assert.ok(menus.length >= 5 && menus.every(Boolean), "every right-click cancels the browser menu: " + JSON.stringify(menus));

    // 3. Drags: images, icons and links are not draggable; the app's own draggable tabs still are.
    const drags = await page.evaluate(() => {
      const start = node => { const e = new DragEvent("dragstart", {bubbles:true, cancelable:true}); node.dispatchEvent(e); return e.defaultPrevented; };
      const link = document.body.appendChild(document.createElement("a")); link.href = "https://example.org/"; link.textContent = "x";
      const icon = document.querySelector("svg.icon"), img = document.querySelector("img");
      const out = {userDrag: [img, icon, link].map(n => getComputedStyle(n).webkitUserDrag),
        prevented: [img, icon, link, document.querySelector(".document-tab").firstChild || document.querySelector(".document-tab")].map(start),
        tab: start(document.querySelector('.document-tab[draggable="true"]'))};
      link.remove();
      return out;
    });
    assert.deepEqual(drags.userDrag, ["none", "none", "none"], "images, icons and links have no drag ghost");
    assert.deepEqual(drags.prevented, [true, true, true, false], "dragstart is cancelled except inside the app's own draggable tab");
    assert.equal(drags.tab, false, "a draggable document tab still starts its drag");

    // 4. The page never scrolls, even when focus() or script scrolls the root.
    const scrolled = await page.evaluate(async () => {
      document.documentElement.scrollTop = 40; document.body.scrollTop = 40;
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      return [document.documentElement.scrollTop, document.body.scrollTop, scrollY];
    });
    assert.deepEqual(scrolled, [0, 0, 0], "the root stays unscrolled");

    // 5. Browser shortcuts never reach the browser: the window does not reload or navigate.
    const shortcut = (key, o = {}) => page.evaluate(([key, o]) => {
      const target = o.field ? Object.assign(document.createElement("input"), {type:"text"}) : document.body;
      const event = {key, metaKey:!!o.meta, ctrlKey:!!o.ctrl, altKey:!!o.alt, shiftKey:!!o.shift, target};
      return AtriumShell.browserShortcut(event);
    }, [key, o]);
    const mac = await page.evaluate(() => /Mac/i.test(navigator.platform)), mod = mac ? {meta:true} : {ctrl:true};
    for (const key of ["r", "f", "g", "[", "]", "p", "s", "o", "l", "d", "j", "=", "-", "0"])
      assert.equal(await shortcut(key, mod), true, "Mod+" + key + " is a browser shortcut");
    for (const key of ["F5", "F3", "F7", "F12"]) assert.equal(await shortcut(key), true, key + " is a browser shortcut");
    assert.equal(await shortcut("Backspace"), true, "Backspace outside a field never navigates back");
    assert.equal(await shortcut("Backspace", {field:true}), false, "Backspace still deletes in a field");
    for (const key of ["c", "v", "x", "a", "z"]) assert.equal(await shortcut(key, mod), false, "Mod+" + key + " stays an editing key");
    assert.equal(await shortcut("u", {...mod, field:true}), false, "Mod+U still formats text in a field");
    assert.equal(await shortcut("y", {...mod, field:true}), false, "Mod+Y still redoes in a field");
    await page.locator("#canvas").click({position:{x:520, y:360}});
    await page.keyboard.press("Escape");
    await page.evaluate(() => {
      window.__keys = [];
      addEventListener("keydown", e => { if (e.isTrusted) window.__keys.push([e.key, e.defaultPrevented]); });
    });
    for (const key of ["ControlOrMeta+BracketLeft", "ControlOrMeta+BracketRight", "ControlOrMeta+d", "ControlOrMeta+j", "F3", "F7", "Backspace", "ControlOrMeta+r"]) {
      await page.locator("#canvas").focus();
      await page.keyboard.press(key);
      await page.keyboard.press("Escape");
    }
    // Mod+G opens the lazy snap-grid dialog. Wait for its field before dismissing it.
    await page.locator("#canvas").focus();
    await page.keyboard.press("ControlOrMeta+g");
    const gridSpacing = page.getByRole("textbox", {name:/^Custom grid spacing/});
    await gridSpacing.waitFor();
    await page.keyboard.press("Escape");
    await gridSpacing.waitFor({state:"hidden"});
    const keys = await page.evaluate(() => window.__keys.filter(([key]) => !["Escape", "Meta", "Control"].includes(key)));
    assert.deepEqual(keys, ["[", "]", "d", "j", "F3", "F7", "Backspace", "r", "g"].map(key => [key,true]), "browser shortcuts are cancelled");
    assert.equal(await page.evaluate(() => window.__noQuirksPage), true, "the window never reloaded or navigated");

    // 6. Fields: identifiers never check spelling; prose and explicit opt-ins keep it.
    const fields = await page.evaluate(() => {
      const search = document.getElementById("nq-field");
      search.focus();
      const prose = document.body.appendChild(document.createElement("textarea")); prose.focus();
      const optIn = document.body.appendChild(Object.assign(document.createElement("input"), {type:"text"}));
      optIn.setAttribute("spellcheck", "true"); optIn.focus();
      const out = {search: [search.spellcheck, search.getAttribute("autocorrect"), search.getAttribute("autocapitalize"), search.getAttribute("autocomplete")],
        prose: prose.spellcheck, optIn: optIn.spellcheck,
        query: document.querySelector(".query-input")?.spellcheck ?? false};
      prose.remove(); optIn.remove();
      return out;
    });
    assert.deepEqual(fields.search, [false, "off", "off", "off"], "single-line fields: no spelling, autocorrect, autocapitalise or autofill");
    assert.equal(fields.prose, true, "multi-line prose keeps spelling");
    assert.equal(fields.optIn, true, "spellcheck=true opts a single-line field back in");

    // 7. Links open in the system browser; the window never navigates.
    const link = await page.evaluate(() => {
      const opened = [], open = window.open;
      window.open = (url, target) => { opened.push([url, target]); return null; };
      const a = document.body.appendChild(Object.assign(document.createElement("a"), {href:"https://example.org/datasheet.pdf", textContent:"Datasheet"}));
      const click = new MouseEvent("click", {bubbles:true, cancelable:true}); a.dispatchEvent(click);
      const middle = new MouseEvent("auxclick", {bubbles:true, cancelable:true, button:1}); a.dispatchEvent(middle);
      a.remove(); window.open = open;
      return {prevented:[click.defaultPrevented, middle.defaultPrevented], opened, cursor:getComputedStyle(document.body).cursor};
    });
    assert.deepEqual(link.prevented, [true, true], "an external link never navigates the window");
    assert.deepEqual(link.opened, [["https://example.org/datasheet.pdf", "_blank"], ["https://example.org/datasheet.pdf", "_blank"]], "it opens outside the window");

    // 8. Focus rings: programmatic focus after a shortcut never rings a control in any surface;
    //    keyboard navigation still does.
    const surfaces = [".work-menu > summary", ".document-tab", "#inspector button", ".pane-heading .section-toggle", "#documents summary, #documents button",
      ".status-bar button, footer button", "[role=toolbar] button", ".dock-tabs .dock-tab"];
    await page.locator("#canvas").click({position:{x:520, y:360}});
    for (const sel of surfaces) {
      const target = page.locator(sel).filter({visible:true}).first();
      if (!await target.count()) continue;
      await page.keyboard.press("F7");
      await target.evaluate(node => node.focus());
      await noRing(page, "focus() after a shortcut on " + sel);
    }
    // A menu opened by click and closed with Escape hands focus back without a ring.
    await page.locator('.work-menu[data-menu="file"] > summary').click();
    await page.keyboard.press("Escape");
    await noRing(page, "Escape from the File menu");
    // A dialog opened by shortcut and closed with Escape.
    await page.locator("#canvas").click({position:{x:520, y:360}});
    await page.keyboard.press("ControlOrMeta+Shift+P");
    await page.waitForFunction(() => document.querySelector("dialog[open]:not(.sp-dialog), #palette[open]"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("dialog[open]:not(.sp-dialog), #palette[open]") && document.activeElement === AtriumNavHost.canvas());
    await noRing(page, "Escape from the command palette");
    // Tab still shows a ring.
    await page.locator('.work-menu[data-menu="file"] > summary').evaluate(node => node.focus());
    await page.keyboard.press("Tab");
    const tabbed = await page.evaluate(() => {
      const node = document.activeElement, css = getComputedStyle(node);
      return {nav: document.documentElement.dataset.focusNav, ring: css.outlineStyle !== "none" && parseFloat(css.outlineWidth) > 0, id: node.outerHTML.slice(0, 80)};
    });
    assert.equal(tabbed.nav, "keys", "Tab marks keyboard navigation");
    assert.ok(tabbed.ring, "Tab shows the focus ring (" + tabbed.id + ")");

    assert.deepEqual(errors, [], "no page errors");
    console.log("PASS no quirks: chrome unselectable, no browser menus, drags, scrolling, zoom or shortcuts, fields and focus rings behave natively");
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
