"use strict";

// Panel chrome the user reported (2026-11-23):
//  - every dock panel header's trailing buttons, and their icons, sit on the title row's centre line;
//  - scrolling never changes layout width: no native scrollbar takes space or paints a track (overlay
//    thumbs, ui/overlay-scroll.js), checked with Chrome's classic scrollbars turned on;
//  - Properties shows only properties: an imported design's report lives in Reports › Import Report and the
//    project's ⋯ menu, not in a Properties section.
// Run standalone or with integration-browser.cjs --panel-chrome-only.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const APP = path.join(__dirname, "../../app");

async function boot(browser, viewport = {width:1400, height:900}) {
  const page = await browser.newPage({viewport, reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.goto(pathToFileURL(path.join(APP, "index.html")).href);
  const demo = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Try the Demo", exact:true});
  await demo.click();
  await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
  await page.waitForFunction(() => !!globalThis.AtriumDock?.current?.() && !!globalThis.AtriumNavHost);
  return {page, errors};
}

// Each dock panel header: its title row's centre (the heading, or the first tab when a dock tab names
// the panel), and every button on that row with its icon.
function headerGeometry() {
  const out = [];
  for (const p of document.querySelectorAll("[data-dock-panel]")) {
    if (!p.getClientRects().length || p.hidden || p.classList.contains("dock-inactive")) continue;
    const shown = n => n?.getClientRects().length && n.getBoundingClientRect().height > 0;
    const measure = (b, centre) => {
      const r = b.getBoundingClientRect(), c = r.top + r.height / 2;
      const ir = b.querySelector(":scope > svg")?.getBoundingClientRect();
      out.push({panel:p.dataset.dockPanel, button:b.getAttribute("aria-label") || b.textContent.trim(),
        off:+(c - centre).toFixed(2), iconOff:ir ? +(ir.top + ir.height / 2 - centre).toFixed(2) : 0});
    };
    const tab = p.closest(".dock-group")?.querySelector(".dock-tab-wrap.is-active");
    const tabLabel = tab?.querySelector("[data-dock-tab]");
    const tabClose = tab?.querySelector("[data-dock-close]");
    if (shown(tabLabel) && shown(tabClose)) {
      const label = tabLabel.getBoundingClientRect();
      measure(tabClose, label.top + label.height / 2);
    }
    const head = p.querySelector(":scope > header, :scope > .pane-heading, :scope > .msg-head, :scope > .script-bar");
    if (!head?.getClientRects().length) continue;
    const title = [...head.querySelectorAll("h2, [role=tab]")].find(shown);
    if (!title) continue;
    const tr = title.getBoundingClientRect(), centre = tr.top + tr.height / 2;
    for (const b of head.querySelectorAll("button")) {
      if (!shown(b) || b.matches("[role=tab]") || title.contains(b)) continue;
      const r = b.getBoundingClientRect(), c = r.top + r.height / 2;
      if (Math.abs(c - centre) > tr.height) continue; // a wrapped second row (the compact Messages header)
      measure(b, centre);
    }
  }
  return out;
}

async function headers(browser) {
  const {page, errors} = await boot(browser);
  try {
    const actions = await page.evaluate(() => [...document.querySelectorAll("#sub-window-panels [data-action]")].map(n => n.dataset.action));
    const seen = new Map();
    for (const action of actions) {
      await page.evaluate(a => AtriumNavHost.act(a), action);
      await page.waitForFunction(a => AtriumLazy.has(AtriumLazy.forAction(a, AtriumNavHost.doc().kind) || []), action);
      for (const g of await page.evaluate(headerGeometry)) seen.set(g.panel + " · " + g.button, g);
    }
    const panels = new Set([...seen.values()].map(g => g.panel));
    assert.ok(panels.size >= 8 && panels.has("messages"), "header buttons measured on " + [...panels].join(", "));
    const off = [...seen.entries()].filter(([, g]) => Math.abs(g.off) > .5 || Math.abs(g.iconOff) > .5).map(([k, g]) => k + " " + g.off + "/" + g.iconOff);
    assert.deepEqual(off, [], "every header button and its icon sit on the title row's centre (±0.5 px)");
    assert.deepEqual(errors, [], "no page errors");
  } finally { await page.close(); }
}

async function closeControls(browser) {
  const {page, errors} = await boot(browser);
  try {
    await page.evaluate(async () => {
      await AtriumNavHost.act("comments-panel");
      AtriumDock.moveTo("comments", {area:"right", mode:"tab", group:0});
    });
    const comments = page.locator('[data-dock-panel="comments"]');
    const close = page.getByRole("button", {name:"Close Comments", exact:true});
    await comments.waitFor();
    await page.locator('[data-dock-close="comments"]').waitFor();
    assert.equal(await close.count(), 1, "tabbed Comments has one Close control");
    assert.equal(await close.getAttribute("data-dock-close"), "comments");
    assert.equal(await comments.getByRole("heading", {name:"Comments"}).isVisible(), true, "the count's header stays visible");
    await close.click();
    await comments.waitFor({state:"hidden"});

    await page.evaluate(async () => {
      await AtriumNavHost.act("comments-panel");
      AtriumDock.moveTo("comments", {area:"right", mode:"end"});
    });
    await comments.waitFor();
    await comments.getByRole("button", {name:"Close Comments", exact:true}).click();
    await comments.waitFor({state:"hidden"});
    assert.deepEqual(errors, [], "no page errors");
  } finally { await page.close(); }
}

// Every scroll container: no width taken by a scrollbar.
function gutters() {
  const out = [];
  for (const n of document.querySelectorAll("*")) {
    if (!n.getClientRects().length || n.classList.contains("ui-scroll-thumb")) continue;
    const s = getComputedStyle(n);
    if (!/auto|scroll/.test(s.overflowY + s.overflowX)) continue;
    const v = n.offsetWidth - n.clientWidth - parseFloat(s.borderLeftWidth) - parseFloat(s.borderRightWidth);
    const h = n.offsetHeight - n.clientHeight - parseFloat(s.borderTopWidth) - parseFloat(s.borderBottomWidth);
    if (Math.round(v) > 0 || Math.round(h) > 0) out.push((n.id ? "#" + n.id : n.tagName.toLowerCase() + "." + String(n.className).split(" ")[0]) + " " + Math.round(v) + "/" + Math.round(h));
  }
  return out;
}

async function scrollbars(browser) {
  // Chrome hides scrollbars in headless runs; turn them back on, as WebKit shows them with a mouse attached.
  const at = process.argv.indexOf("--executable"), type = browser.browserType();
  const classic = await type.launch({headless:true, ignoreDefaultArgs:["--hide-scrollbars"],
    ...(at > 0 ? {executablePath:process.argv[at + 1]} : {channel:"chrome"})});
  try {
    const {page, errors} = await boot(classic, {width:1400, height:1000});
    const fieldWidth = () => page.evaluate(() => document.querySelector("#inspector .ui-prop-row .ui-field")?.getBoundingClientRect().width);
    const overflowing = () => page.evaluate(() => { const i = document.getElementById("inspector"); return i.scrollHeight > i.clientHeight; });
    await page.evaluate(() => { const h = AtriumNavHost; h.select([h.doc().items.find(i => i.kind === "via").id]); });
    await page.locator("#inspector .ui-prop-row .ui-field").first().waitFor();
    assert.equal(await overflowing(), false, "Properties fits a tall window");
    const before = await fieldWidth();
    await page.setViewportSize({width:1400, height:420});
    await page.waitForFunction(() => { const i = document.getElementById("inspector"); return i.scrollHeight > i.clientHeight; });
    assert.equal(await fieldWidth(), before, "Properties keeps its width when its content starts to scroll");
    // Other scrolling surfaces: Messages, the Library and Preferences.
    for (const a of ["messages", "library-panel"]) await page.evaluate(a => AtriumNavHost.act(a), a);
    await page.evaluate(async () => { await AtriumLazy.need("AtriumPrefs"); AtriumPrefs.open("general"); });
    await page.getByRole("dialog", {name:"Preferences", exact:true}).waitFor();
    for (const id of ["messages", "library"]) await page.locator(`[data-dock-panel="${id}"]`).waitFor({state:"attached"});
    assert.deepEqual(await page.evaluate(gutters), [], "no scroll container gives width to a scrollbar");
    await page.keyboard.press("Escape");
    // Scrolling shows an overlay thumb on the scroller's edge; it fades once the scrolling stops.
    const box = await page.locator("#inspector").boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 160);
    await page.waitForFunction(() => [...document.querySelectorAll(".ui-scroll-thumb[data-shown]")].length > 0);
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.waitForFunction(() => !document.querySelector(".ui-scroll-thumb[data-shown]"), null, {timeout:3000});
    // At the edge the thumb widens with an animation, not in one step (with motion allowed).
    await page.emulateMedia({reducedMotion:"no-preference"});
    await page.evaluate(() => { globalThis.__thumbRuns = [];
      document.addEventListener("transitionrun", e => e.target.matches(".ui-scroll-thumb") && __thumbRuns.push(e.propertyName), true); });
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);
    const thumb = '.ui-scroll-thumb[data-axis=v][data-hot]';
    await page.waitForSelector(thumb);
    await page.waitForFunction(() => __thumbRuns.includes("scale"), null, {timeout:1000}).catch(() => {});
    assert.ok(await page.evaluate(() => __thumbRuns.includes("scale")), "the thumb animates its thickness (scale) as it widens at the edge");
    const fadesOnly = () => page.evaluate(sel => getComputedStyle(document.querySelector(sel)).transitionProperty, thumb);
    const motion = await page.evaluate(() => { const was = document.documentElement.dataset.motion ?? null; document.documentElement.dataset.motion = "reduce"; return was; });
    assert.equal(await fadesOnly(), "opacity", "with Preferences › Motion › Reduce the thumb only fades");
    await page.evaluate(was => { if (was == null) delete document.documentElement.dataset.motion; else document.documentElement.dataset.motion = was; }, motion);
    await page.emulateMedia({reducedMotion:"reduce"});
    assert.equal(await fadesOnly(), "opacity", "with the system's reduced motion the thumb only fades");
    // A menu drawn over a panel also covers that panel's thumb.
    assert.ok(await page.evaluate(sel => {
      const t = document.querySelector(sel).getBoundingClientRect(), x = t.left + t.width / 2, y = t.top + t.height / 2;
      const menu = Object.assign(document.createElement("div"), {className:"nav-menu"});
      Object.assign(menu.style, {left:x - 40 + "px", top:y - 20 + "px", width:"80px", height:"40px"});
      document.body.append(menu);
      const hit = document.elementFromPoint(x, y) === menu; menu.remove(); return hit;
    }, thumb), "a menu over the panel draws above its scroll thumb");
    // So does an app bar menu (the app bar is a low layer of its own, z-index 5).
    assert.ok(await page.evaluate(sel => {
      const t = document.querySelector(sel).getBoundingClientRect(), x = t.left + t.width / 2, y = t.top + t.height / 2;
      const menu = document.querySelector(".appbar .work-menu"), items = menu.querySelector(".menu-items");
      menu.open = true;
      Object.assign(items.style, {position:"fixed", left:x - 100 + "px", top:y - 10 + "px", right:"auto"});
      const hit = items.contains(document.elementFromPoint(x, y));
      items.removeAttribute("style"); menu.open = false; return hit;
    }, thumb), "an app bar menu over the panel draws above its scroll thumb");
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.waitForFunction(() => !document.querySelector(".ui-scroll-thumb[data-hot]"));
    // A z-indexed sticky header in the scroller does not cover the thumb.
    assert.ok(await page.evaluate(async () => {
      const box = Object.assign(document.createElement("div"), {style:"position:absolute;left:40px;top:40px;width:200px;height:150px;overflow:auto"});
      box.innerHTML = "<div style='position:sticky;top:0;z-index:4;height:60px;background:red'></div><div style='height:600px'></div>";
      document.body.append(box); box.scrollTop = 30; await new Promise(r => setTimeout(r, 100));
      const t = AtriumOverlayScroll.thumbs().find(t => t.style.position === "fixed" && Math.abs(parseFloat(t.style.top) - 42) < 2);
      t.style.pointerEvents = "auto"; const r = t.getBoundingClientRect();
      const ok = document.elementFromPoint(r.left + r.width / 2, r.top + 2) === t; t.style.pointerEvents = ""; box.remove(); return ok;
    }), "a z-indexed sticky header does not cover the thumb");
    // A scrolling popover inside a layered card (a select list in a modeless dialog) keeps its thumb on top.
    assert.ok(await page.evaluate(async () => {
      const card = Object.assign(document.createElement("div"), {style:"position:fixed;z-index:30;left:40px;top:40px;width:200px;height:200px"});
      const list = Object.assign(document.createElement("div"), {popover:"manual", style:"overflow:auto;height:120px;width:160px;margin:0;inset:auto;left:60px;top:60px;position:fixed"});
      list.innerHTML = "<div style='height:600px'></div>"; card.append(list); document.body.append(card); list.showPopover();
      list.scrollTop = 40; await new Promise(r => setTimeout(r, 100));
      const t = AtriumOverlayScroll.thumbs().find(t => t.parentElement === list || t.parentElement === card);
      const ok = t?.parentElement === list; card.remove(); return ok;
    }), "a scrolling popover's thumb stays in the popover");
    // In a floating panel the thumb still draws over that panel's own content.
    await page.evaluate(() => { for (const d of document.querySelectorAll("dialog[open]")) d.close(); });
    await page.setViewportSize({width:1400, height:1000});
    const id = await page.evaluate(() => document.getElementById("inspector").closest("[data-dock-panel]").dataset.dockPanel);
    await page.evaluate(id => AtriumDock.moveTo(id, {area:"float", rect:{x:400, y:200, w:320, h:220}}), id);
    await page.waitForFunction(() => document.getElementById("inspector").closest(".dock-float"));
    await page.waitForFunction(() => { const i = document.getElementById("inspector"); return i.scrollHeight > i.clientHeight; });
    const fbox = await page.locator("#inspector").boundingBox();
    await page.mouse.move(fbox.x + fbox.width / 2, fbox.y + fbox.height / 2);
    await page.mouse.wheel(0, 80);
    await page.mouse.move(fbox.x + fbox.width - 4, fbox.y + fbox.height / 2);
    await page.waitForSelector(thumb);
    assert.ok(await page.evaluate(sel => { const t = document.querySelector(sel), r = t.getBoundingClientRect();
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === t; }, thumb),
      "a floating panel's thumb draws above the panel");
    assert.deepEqual(errors, [], "no page errors");
    await page.close();
  } finally { await classic.close(); }
}

async function importReport(browser) {
  const {page, errors} = await boot(browser);
  try {
    await page.evaluate(() => {
      const h = AtriumNavHost, p = h.project(), d = h.doc();
      h.edit(() => { p.importNotes = ["Imported 3 polygons as outlines."]; d.sourceName = "Sensor.PcbDoc"; });
      h.select([]);
    });
    await page.locator("#inspector :is(h3, summary)").first().waitFor();
    const headings = await page.locator("#inspector :is(h3, summary)").allTextContents();
    assert.ok(!headings.some(h => /import/i.test(h)), "Properties has no import section: " + headings.join(", "));
    // The project's ⋯ menu leads to the report.
    await page.locator('[data-project-menu="more"]').click();
    const item = page.locator(".nav-menu [role=menuitem]", {hasText:"Import Report"});
    await item.waitFor();
    await item.click();
    const sheet = page.locator("dialog[open]", {hasText:"Import details"});
    await sheet.waitFor();
    assert.ok((await sheet.textContent()).includes("Imported 3 polygons as outlines."), "the import notes are in the report");
    assert.deepEqual(errors, [], "no page errors");
  } finally { await page.close(); }
}

module.exports = async function panelChrome(browser) {
  await closeControls(browser);
  await headers(browser);
  await scrollbars(browser);
  await importReport(browser);
  console.log("panel chrome: one Close per panel, header buttons centred, overlay scrollbars, import report out of Properties: ok");
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => {
      const at = process.argv.indexOf("--executable");
      return {headless:true, ...(at > 0 ? {executablePath:process.argv[at + 1]} : {channel:"chrome"})};
    },
    browser => module.exports(browser),
    error => { console.error(error); process.exit(1); });
}
