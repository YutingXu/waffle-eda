"use strict";
// A project with more documents than fit (beta: an imported 15-document Altium project hid its PCB):
//   1. The Projects tree, alone in the left side bar, fills it: its last row shows, and its group is not capped
//      at the 46 % an auto-sized group keeps while another group (Navigator) shares the side bar.
//   2. The document strip shows that it overflows: the side with more tabs fades, and a ⋯ after the tabs lists
//      every open document; choosing one shows it with its tab whole and in view. A wheel turn scrolls the tabs.
//      With the tabs fitting, there is neither.
//   3. Split panes' strips do the same, and their split and close controls stay in view while the tabs scroll.
// Run: node tests/editor/browser-tab-overflow.js (NODE_PATH for Playwright Core; CHROME=/path/to/chrome).
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const NAMES = ["Controller", "Controller part 2", "Controller part 3", "Flash", "USB", "CAN", "Audio input", "Debug",
  "SD card", "Power", "Accelerometer", "Temperature", "Connectors", "RS-485"];

module.exports = async function tabOverflow(browser) {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(8000);
  const frames = (n = 3) => page.evaluate(n => new Promise(done => {const step = () => --n ? requestAnimationFrame(step) : done(); requestAnimationFrame(step);}), n);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
    await page.evaluate(async names => {
      const project = Atrium.project("Sensor board", []);
      project.documents = [...names.map(n => Atrium.sheet("schematic", n)), Atrium.sheet("pcb", "Main board")];
      await AtriumNavHost.replaceProject(project, {copy: true, force: true});
      await AtriumLazy.need("AtriumDock");
      AtriumNavHost.selectDocument(AtriumNavHost.project().documents[0].id);
    }, NAMES);
    await page.locator("#doc-name", {hasText: "Controller"}).waitFor();
    await frames();

    // ---- 1. the Projects tree fills the side bar
    const tree = await page.evaluate(() => {
      const rows = [...document.querySelectorAll("#documents [data-doc]")], last = rows.at(-1).getBoundingClientRect();
      const group = rows[0].closest(".dock-group").getBoundingClientRect(), area = document.getElementById("navigator").getBoundingClientRect();
      return {rows: rows.length, last: Math.round(last.bottom), group: Math.round(group.bottom), area: Math.round(area.bottom)};
    });
    assert.equal(tree.rows, 15);
    assert.ok(tree.last <= tree.group, "the last document row shows inside the Projects group (" + JSON.stringify(tree) + ")");
    assert.ok(tree.area - tree.group <= 8, "alone in the side bar, the Projects group fills it (" + JSON.stringify(tree) + ")");
    // With Navigator below it, Projects still sizes to its content up to 46 % of the side bar.
    const shared = await page.evaluate(async () => {
      const before = AtriumDock.current(), layout = AtriumDock.builtin("schematic");
      layout.hide = {};
      AtriumDock.apply(layout, {quiet: true});
      AtriumNavHost.act("navigator-panel");
      for (let i = 0; i < 100 && document.querySelectorAll("#navigator > .dock-group:not(.dock-empty)").length < 2; i++) await new Promise(r => setTimeout(r, 30));
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      const groups = [...document.querySelectorAll("#navigator > .dock-group:not(.dock-empty)")].map(g => g.getBoundingClientRect().height);
      const area = document.getElementById("navigator").getBoundingClientRect().height;
      AtriumDock.apply(before, {quiet: true});
      return {groups, area};
    });
    assert.equal(shared.groups.length, 2, "Navigator opens below Projects");
    assert.ok(shared.groups[0] <= shared.area * .46 + 1, "Projects keeps its cap beside Navigator (" + JSON.stringify(shared) + ")");
    await frames();

    // ---- 2. the document strip
    const strip = page.locator("#document-tabs"), more = page.locator(".editor-tabbar > .ui-tab-overflow");
    await more.waitFor({state: "visible"});
    const look = () => page.evaluate(() => {
      const s = document.getElementById("document-tabs"), box = s.getBoundingClientRect(), wrap = document.querySelector(".editor-tabbar > .ui-tab-overflow");
      const fade = side => getComputedStyle(side === "start" ? s : wrap, "::before").visibility;
      const tab = s.querySelector('[aria-selected="true"]').getBoundingClientRect(), b = wrap?.getBoundingClientRect();
      return {overflow: s.dataset.overflow || "", start: fade("start"), end: wrap && fade("end"), shown: !!wrap && !wrap.hidden,
        moreInWindow: !!b && b.width > 0 && b.right <= innerWidth && b.left >= box.right - 1,
        tab: {left: tab.left - box.left, right: box.right - tab.right}, scroll: s.scrollLeft};
    });
    let s = await look();
    assert.equal(s.overflow, "end", "the first tab shown, more tabs lie past the end");
    assert.deepEqual([s.start, s.end, s.shown, s.moreInWindow], ["hidden", "visible", true, true], "the end fades and ⋯ shows after the tabs");
    await more.locator("button").click();
    const items = page.locator('[role=menu][aria-label="Open documents"] [role^=menuitem]');
    await items.first().waitFor();
    assert.deepEqual(await items.allTextContents().then(t => t.map(x => x.trim())), [...NAMES, "Main board"], "⋯ lists every open document");
    assert.equal(await items.first().getAttribute("aria-checked"), "true", "the shown document is ticked");
    await items.last().click();
    await page.locator("#doc-name", {hasText: "Main board"}).waitFor();
    await frames();
    s = await look();
    assert.equal(s.overflow, "start", "scrolled to the board's tab, the tabs before it fade out");
    assert.ok(s.tab.left >= 24 - .5 && s.tab.right >= -.5, "the board's tab shows whole, clear of the fade (" + JSON.stringify(s.tab) + ")");
    // Choosing a tab elsewhere (the Projects tree) brings it into view too.
    await page.locator("#documents [data-doc]", {hasText: "Controller part 3"}).click();
    await page.locator("#doc-name", {hasText: "Controller part 3"}).waitFor();
    await frames();
    s = await look();
    assert.ok(s.tab.left >= -.5 && s.tab.right >= 24 - .5, "a tab chosen in Projects shows whole (" + JSON.stringify(s.tab) + ")");
    // A second press on ⋯ closes its menu (the shared dropdown toggles).
    await more.locator("button").click();
    await items.first().waitFor();
    await more.locator("button").click();
    await items.first().waitFor({state: "detached"});
    assert.equal(await more.locator("button").getAttribute("aria-expanded"), "false", "a second press closes the ⋯ menu");
    // A vertical wheel turn over the tabs scrolls them sideways.
    const before = s.scroll;
    await strip.hover();
    await page.mouse.wheel(0, 240);
    await frames();
    assert.ok((await look()).scroll > before, "the wheel scrolls the tabs");

    // ---- 3. split panes' strips
    await page.evaluate(() => AtriumNavHost.act("split-toggle"));
    await page.waitForFunction(() => AtriumNavHost.panes().length === 2 && document.querySelector('.pane-tabs[data-pane="0"] .ui-tab-strip-end .ui-tab-overflow'));
    await frames();
    const pane = await page.evaluate(() => {
      const s = document.querySelector('.pane-tabs[data-pane="0"]'), box = s.getBoundingClientRect(), end = s.querySelector(".ui-tab-strip-end");
      const inside = n => {const r = n.getBoundingClientRect(); return r.width > 0 && r.left >= box.left - .5 && r.right <= box.right + .5;};
      s.scrollLeft = s.scrollWidth;
      const after = [...end.querySelectorAll(".pane-arrange, .pane-close")].map(inside);
      return {overflow: s.dataset.overflow || "", more: !end.querySelector(".ui-tab-overflow").hidden, controls: after, first: end.firstElementChild.className};
    });
    assert.equal(pane.more, true, "the pane's ⋯ shows while its tabs overflow");
    assert.equal(pane.first, "ui-tab-overflow", "⋯ leads the pane's trailing controls");
    assert.deepEqual(pane.controls, [true, true], "the split and close controls stay in view while the tabs scroll");
    await frames();
    assert.match(await page.locator('.pane-tabs[data-pane="0"]').getAttribute("data-overflow"), /start/);

    // ---- with the tabs fitting, no fade and no ⋯
    await page.evaluate(() => AtriumNavHost.act("split-close"));
    await page.waitForFunction(() => AtriumNavHost.panes().length === 1);
    await page.evaluate(async () => {
      const project = Atrium.project("Small", []);
      project.documents = [Atrium.sheet("schematic", "Main"), Atrium.sheet("pcb", "Board")];
      await AtriumNavHost.replaceProject(project, {copy: true, force: true});
    });
    await page.locator("#doc-name", {hasText: /Main|Board/}).waitFor();
    await frames();
    const fits = await page.evaluate(() => ({overflow: document.getElementById("document-tabs").dataset.overflow || "",
      shown: !document.querySelector(".editor-tabbar > .ui-tab-overflow")?.hidden}));
    assert.deepEqual(fits, {overflow: "", shown: false}, "tabs that fit have no fade and no ⋯");
    assert.deepEqual(errors, [], "no page errors");
    console.log("browser-tab-overflow: ok");
  } finally {
    await page.close();
  }
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
