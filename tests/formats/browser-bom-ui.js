"use strict";

// Bill of Materials beta fixes in real Chrome: the DNP toggle explains itself and lists the
// do-not-populate parts, the Columns side panel shows a column and remembers itself, scrolling stays
// inside a frame budget, and every select opens its option list on the field in several dialogs.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const root = path.resolve(__dirname, "../..");
const appUrl = pathToFileURL(path.join(root, "app", "index.html")).href;

// A project with `lines` distinct resistor lines (every 97th part is DNP) on schematic and board.
async function bomProject(page, lines) {
  await page.evaluate(async lines => {
    const p = AtriumParts.example(), [sch, brd] = p.documents;
    const base = sch.items.find(i => i.ref === "R1"), mate = brd.items.find(i => i.ref === "R1");
    for (let i = 0; i < lines; i++) {
      const ref = "R" + (100 + i), value = (1 + i) + " Ω", link = "bom-ui-" + i;
      sch.items.push({...Atrium.clone(base), id: "s" + i, ref, value, link, x: (i % 40) * 8, y: 20 + Math.floor(i / 40) * 6, dnp: i % 97 === 5});
      brd.items.push({...Atrium.clone(mate), id: "b" + i, ref, value, link, x: (i % 40) * 3, y: 10 + Math.floor(i / 40) * 3});
    }
    await AtriumNavHost.replaceProject(p, {force: true, dirty: false});
  }, lines);
  await page.waitForFunction(() => AtriumNavHost.project().documents[0].items.some(i => i.id === "s0"));
}
async function openBom(page) {
  await page.evaluate(() => AtriumNavHost.act("bom"));
  const dialog = page.locator("dialog.bom-dialog[open]");
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector(".ui-sheet-grid tbody tr.bom-line"));
  return dialog;
}
async function closeBom(page) {
  await page.evaluate(() => document.querySelector("dialog.bom-dialog[open]")?.close());
  await page.locator("dialog.bom-dialog").waitFor({state: "detached"});
}
const lineCount = page => page.evaluate(() => Number(/(\d+) lines?/.exec(document.querySelector(".bom-summary").textContent)?.[1]));

async function dnp(page) {
  const dialog = await openBom(page);
  const toggle = dialog.getByRole("checkbox", {name: "Show DNP parts"});
  assert.equal(await toggle.count(), 1, "the DNP control is a labelled checkbox");
  const description = await toggle.evaluate(n => document.getElementById(n.getAttribute("aria-describedby"))?.textContent || "");
  assert.match(description, /do not populate/i, "the DNP control describes what DNP means");
  assert.match(description, /Not Fitted/, "the description names the variant model");
  assert.equal(await dialog.getByRole("button", {name: "DNP", exact: true}).count(), 0, "no unexplained DNP button");
  assert.equal(await dialog.getByRole("button", {name: "Columns", exact: true}).count(), 0, "no Columns button: the chooser is a side panel");
  const before = await lineCount(page);
  assert.equal(await dialog.locator("tr.is-dnp").count(), 0);
  await toggle.check();
  const after = await lineCount(page);
  assert.ok(after > before, `showing DNP parts adds their lines (${before} -> ${after})`);
  assert.ok(await dialog.locator("tr.is-dnp").count() > 0, "DNP lines are drawn struck through");
  await toggle.uncheck();
  assert.equal(await lineCount(page), before);
  // The header's excluded count links to the list of excluded parts and why.
  const excluded = dialog.locator(".bom-summary .bom-link").first();
  assert.match(await excluded.textContent(), /excluded part/);
  await excluded.click();
  assert.equal(await dialog.locator("#bom-excluded").evaluate(n => n.open), true, "the excluded link opens the list");
  assert.match(await dialog.locator("#bom-excluded").textContent(), /DNP \(do not populate\)/);
  // The DNP count in the header turns the toggle on.
  await dialog.locator(".bom-summary .bom-link").nth(1).click();
  assert.equal(await toggle.isChecked(), true, "the DNP count shows the DNP parts");
  await toggle.uncheck();
  await closeBom(page);
  console.log("PASS BOM DNP toggle: labelled, described, toggles the excluded DNP parts; header links");
}

async function columnsPanel(page) {
  let dialog = await openBom(page);
  const panel = dialog.locator("aside#bom-columns");
  assert.equal(await panel.isVisible(), true, "the Columns panel is part of the BOM view");
  const show = panel.getByRole("checkbox", {name: "Show Manufacturer", exact: true});
  const header = dialog.locator('.ui-sheet-grid th[data-key="manufacturer"]');
  if (await show.isChecked()) await show.uncheck();
  assert.equal(await header.count(), 0);
  await show.check();
  assert.equal(await header.count(), 1, "showing a column adds it to the grid");
  const edge = panel.getByRole("separator", {name: "Columns panel width"});
  await edge.focus();
  await page.keyboard.press("ArrowLeft");
  const width = Math.round((await panel.boundingBox()).width);
  const fold = panel.locator(".bom-panel-fold");
  assert.equal(await fold.getAttribute("aria-expanded"), "true");
  await fold.click();
  assert.equal(await fold.getAttribute("aria-label"), "Hide columns panel".replace("Hide", "Show"));
  assert.ok((await panel.boundingBox()).width <= 25, "the collapsed panel is a slim rail");
  await closeBom(page);
  dialog = await openBom(page);
  assert.equal(await dialog.locator('.ui-sheet-grid th[data-key="manufacturer"]').count(), 1, "the shown column persists");
  assert.equal(await dialog.locator("aside#bom-columns.collapsed").count(), 1, "the collapsed state persists");
  await dialog.locator("aside#bom-columns").click({position: {x: 12, y: 200}});
  assert.equal(Math.round((await dialog.locator("aside#bom-columns").boundingBox()).width), width, "the width persists");
  await dialog.locator("aside#bom-columns").getByRole("checkbox", {name: "Show Manufacturer", exact: true}).uncheck();
  await closeBom(page);
  console.log("PASS BOM Columns side panel: shows a column, resizes, collapses to a rail and remembers all three");
}

// Per-frame main-thread work while scrolling, from Chrome's own counters.
async function scrollBudget(page, lines, budget) {
  await bomProject(page, lines);
  await openBom(page);
  await page.evaluate(() => document.fonts.ready);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () => Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(m => [m.name, m.value]));
  const frames = 120, a = await metrics();
  await page.evaluate(async frames => {
    const g = document.querySelector(".ui-sheet-wrap");
    let dir = 1;
    for (let i = 0; i < frames; i++) {
      await new Promise(r => requestAnimationFrame(r));
      if (g.scrollTop + g.clientHeight >= g.scrollHeight - 1) dir = -1; else if (g.scrollTop <= 0) dir = 1;
      g.scrollTop += dir * 37;
    }
    await new Promise(r => requestAnimationFrame(r));
  }, frames);
  const b = await metrics();
  await cdp.detach();
  const per = k => (b[k] - a[k]) * 1000 / frames;
  const work = per("ScriptDuration") + per("RecalcStyleDuration") + per("LayoutDuration"), layouts = (b.LayoutCount - a.LayoutCount) / frames;
  assert.ok(work < budget, `${lines} lines: ${work.toFixed(2)} ms of script, style and layout per scroll frame (budget ${budget} ms)`);
  if (lines <= 150) assert.ok(layouts < .1, `${lines} lines: scrolling a fully rendered BOM lays out nothing (${layouts.toFixed(2)} per frame)`);
  else assert.ok(layouts < .5, `${lines} lines: most scroll frames reuse the rendered window (${layouts.toFixed(2)} layouts per frame)`);
  await closeBom(page);
  console.log(`PASS BOM scroll ${lines} lines: ${work.toFixed(2)} ms work, ${layouts.toFixed(2)} layouts per frame`);
}

// The option list sits on its field: left edges within 1 px, 2 px below (or above when flipped).
async function dropdown(page, select, name) {
  await select.scrollIntoViewIfNeeded();
  await select.click();
  const list = page.locator(".ui-select-list");
  await list.waitFor();
  const g = await page.evaluate(() => {
    const s = AtriumSelectPopup.field().getBoundingClientRect(), l = AtriumSelectPopup.element().getBoundingClientRect();
    return {s: {left: s.left, top: s.top, bottom: s.bottom, width: s.width}, l: {left: l.left, top: l.top, bottom: l.bottom, width: l.width},
      side: AtriumSelectPopup.element().dataset.side, options: AtriumSelectPopup.element().querySelectorAll("[role=option]").length,
      inDialog: !!AtriumSelectPopup.element().closest("dialog")};
  });
  assert.ok(Math.abs(g.l.left - g.s.left) <= 1, `${name}: left edges align (${g.l.left} vs ${g.s.left})`);
  const gap = g.side === "top" ? g.s.top - g.l.bottom : g.l.top - g.s.bottom;
  assert.ok(Math.abs(gap - 2) <= 1, `${name}: 2 px from the field (${gap})`);
  assert.ok(g.l.width >= g.s.width - 1, `${name}: at least as wide as the field`);
  assert.ok(g.options > 0, `${name}: lists the options`);
  await page.keyboard.press("Escape");
  await list.waitFor({state: "detached"});
  return g;
}

async function dropdowns(page) {
  await bomProject(page, 40);
  let dialog = await openBom(page);
  // The asynchronous optimiser can populate a toolbar badge and move its fields.
  await page.locator("dialog.bom-dialog[open][data-hint-ms]").waitFor();
  await dropdown(page, dialog.getByRole("combobox", {name: "BOM source"}), "BOM source");
  const format = dialog.getByRole("combobox", {name: "Export format"});
  await dropdown(page, format, "BOM export format");
  assert.equal(await dialog.isVisible(), true, "Escape closes the list, not the dialog");
  // Keyboard: Space opens, a key moves, Enter chooses and fires change.
  const was = await format.inputValue();
  await format.focus();
  await page.keyboard.press(" ");
  await page.locator(".ui-select-list").waitFor();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  assert.notEqual(await format.inputValue(), was, "choosing from the list changes the select");
  assert.equal(await format.evaluate(n => document.activeElement === n), true, "focus returns to the field");
  await format.selectOption(was);
  await closeBom(page);

  await page.evaluate(() => AtriumNavHost.act("annotate"));
  dialog = page.locator("dialog[open]").filter({has: page.getByRole("combobox", {name: "Matching options"})});
  await dialog.waitFor();
  await dropdown(page, dialog.locator("select:enabled").first(), "Annotate order");
  await page.evaluate(() => document.querySelector("dialog[open]")?.close());

  await page.evaluate(() => AtriumNavHost.act("output-jobs"));
  const release = page.getByRole("combobox", {name: "Job set"});
  await release.waitFor();
  await dropdown(page, release, "Release job set");
  await page.evaluate(() => { for (const d of document.querySelectorAll("dialog[open]")) d.close(); });

  await page.evaluate(async () => { await AtriumLazy.need("AtriumPrefs"); AtriumPrefs.open("keyboard"); });
  const preset = page.locator("#prf-key-preset");
  await preset.waitFor();
  await dropdown(page, preset, "Preferences keyboard preset");
  await page.evaluate(() => { for (const d of document.querySelectorAll("dialog[open]")) d.close(); });
  console.log("PASS select option lists align with their field in the BOM, Annotate, Release and Preferences");
}

async function gridLayout(browser, url = appUrl, evidence) {
  const results = {};
  for (const mode of ["light", "dark", "touch"]) {
    for (const order of [["bom", "constraints"], ["constraints", "bom"]]) {
      const page = await browser.newPage({viewport: {width: 1440, height: 900}, reducedMotion: "reduce", hasTouch: mode === "touch"});
      page.setDefaultTimeout(8000);
      try {
        await page.goto(url);
        await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
        await page.waitForFunction(() => AtriumNavHost.project().name === "Sensor interface" &&
          AtriumNavHost.doc().kind === "pcb" && !document.querySelector("dialog.sp-dialog[open]"));
        await page.evaluate(mode => AtriumTheme.set({preset: mode === "dark" ? "dark" : "light", density: mode === "touch" ? "comfortable" : "default"}), mode);
        assert.equal(await page.evaluate(() => matchMedia("(any-pointer:coarse)").matches), mode === "touch");
        const key = mode + "-" + order[0], grids = {};
        for (const feature of order) {
          await page.evaluate(feature => AtriumNavHost.act(feature), feature);
          const prefix = feature === "bom" ? "bom" : "cm";
          const dialog = page.locator("dialog." + prefix + "-dialog[open]");
          await dialog.locator("." + prefix + "-sort").first().waitFor();
          if (feature === "bom") await page.locator("dialog.bom-dialog[open][data-hint-ms]").waitFor();
          grids[feature] = await dialog.evaluate((d, prefix) => {
            const watch = {
              dialog: ".", body: "." + prefix + "-body", wrap: "." + prefix + "-grid-wrap",
              sort: "." + prefix + "-sort", resize: "." + prefix + "-resize",
              filterCell: "." + prefix + "-filter-row th", filter: "." + prefix + "-filter",
              rowCell: "." + prefix + "-grid tbody tr:not([class$=-spacer]) td",
              search: prefix === "bom" ? 'input[aria-label="Search BOM lines"]' : ".cm-search"
            };
            if (prefix === "bom") Object.assign(watch, {
              panel: ".bom-columns", panelHead: ".bom-panel-head", panelFold: ".bom-panel-fold",
              panelEdge: ".bom-panel-edge", column: ".bom-column", source: 'select[aria-label="BOM source"]',
              dnp: ".bom-dnp-toggle", export: 'select[aria-label="Export format"]'
            });
            const at = d.getBoundingClientRect();
            const box = Object.fromEntries(Object.entries(watch).map(([name, selector]) => {
              const n = name === "dialog" ? d : d.querySelector(selector);
              const r = n.getBoundingClientRect(), c = getComputedStyle(n);
              return [name, {x: name === "dialog" ? r.x : r.x - at.x, y: name === "dialog" ? r.y : r.y - at.y,
                width: r.width, height: r.height, top: c.top,
                background: c.backgroundColor, color: c.color, cursor: c.cursor, radius: c.borderRadius, padding: c.padding,
                border: c.borderBottomWidth, position: c.position, font: c.fontSize, overflow: c.overflowX}];
            }));
            return box;
          }, prefix);
          const box = grids[feature];
          if (evidence) await dialog.screenshot({path: path.join(evidence, key + "-" + feature + ".png"), animations: "disabled"});
          const wrap = dialog.locator("." + prefix + "-grid-wrap");
          const shadows = await wrap.evaluate(n => {
            n.focus({preventScroll: true});
            return {shadow: getComputedStyle(n).boxShadow, outline: getComputedStyle(n).outlineStyle};
          });
          await page.keyboard.press("Tab");
          const keyboardShadow = await wrap.evaluate(n => {
            n.focus({preventScroll: true});
            return getComputedStyle(n).boxShadow;
          });
          assert.equal(box.sort.cursor, "default", feature + " sortable headings keep the arrow cursor");
          assert.equal(box.resize.cursor, "col-resize", feature + " resize handles keep the resize cursor");
          assert.equal(box.filterCell.position, "sticky", feature + " filters remain sticky");
          assert.equal(box.wrap.overflow, "auto", feature + " grid remains scrollable");
          assert.deepEqual(shadows, {shadow: "none", outline: "none"}, feature + " programmatic focus has no ring");
          assert.match(keyboardShadow, /1px inset/, feature + " keyboard focus retains the one-pixel ring");
          if (feature === "bom") {
            assert.equal(box.column.cursor, "default", "BOM column rows keep the arrow cursor");
            assert.equal(box.panelEdge.cursor, "col-resize", "BOM Columns panel retains its resize handle");
            assert.equal(box.panel.width, 272, "BOM Columns panel keeps its default width");
            if (evidence) {
              await dialog.getByRole("button", {name: "Hide columns panel"}).click();
              await dialog.locator(".bom-columns.collapsed").waitFor();
              await page.mouse.move(0, 0);
              await dialog.screenshot({path: path.join(evidence, key + "-bom-collapsed.png"), animations: "disabled"});
            }
          }
          await page.mouse.click(5, 5);
          await dialog.evaluate(d => d.close());
          await dialog.waitFor({state: "detached"});
        }
        const links = await page.locator('link[rel="stylesheet"]').evaluateAll(nodes => nodes.map(n => n.getAttribute("href")));
        const sheets = {bom:"formats/bom.css", constraints:"checks/constraints.css"};
        assert.deepEqual(links.filter(href => Object.values(sheets).includes(href)), order.map(feature => sheets[feature]));
        assert.ok(links.filter(href => href === "ui/spreadsheet.css").length <= 1);
        results[key] = grids;
      } finally { await page.close(); }
    }
    assert.deepEqual(results[mode + "-bom"], results[mode + "-constraints"], mode + " grid styles and geometry match in both opening orders");
  }
  return results;
}

module.exports = async function bomUI(browser) {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}, reducedMotion: "reduce"});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("dialog", d => d.dismiss());
  page.setDefaultTimeout(8000);
  try {
    await page.goto(appUrl);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !AtriumStartPage.isOpen() && AtriumNavHost.project().name === "Sensor interface");
    await page.evaluate(() => { try { localStorage.removeItem("atrium-bom-v1"); } catch {} });
    await bomProject(page, 200);
    await dnp(page);
    await columnsPanel(page);
    await scrollBudget(page, 60, 8);
    await scrollBudget(page, 1000, 8);
    await dropdowns(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
  await gridLayout(browser);
  console.log("PASS BOM and Constraint Manager geometry, cursors and keyboard focus in both opening orders (light, dark, touch)");
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch({channel: "chrome", headless: true});
    try {
      if (!process.env.BOM_STYLE_EVIDENCE) return await module.exports(browser);
      const output = path.resolve(process.env.BOM_STYLE_EVIDENCE);
      for (const [name, dir] of [["beta", process.env.BOM_STYLE_REFERENCE], ["merged", root]]) {
        if (!dir) continue;
        const evidence = path.join(output, name);
        await fs.mkdir(evidence, {recursive: true});
        const results = await gridLayout(browser, pathToFileURL(path.join(dir, "app", "index.html")).href, evidence);
        await fs.writeFile(path.join(evidence, "geometry.json"), JSON.stringify(results, null, 2) + "\n");
      }
    } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
