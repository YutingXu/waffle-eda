"use strict";

const assert = require("node:assert/strict");
const {watchResult} = require("../../../scripts/ci/interaction_trace.cjs");

async function shellInputs(page, measure) {
  const menu = name => page.locator('.menubar > details[data-menu="' + name + '"]');
  const menus = await page.locator(".menubar > details[data-menu]:visible").evaluateAll(entries => entries.map(e => e.dataset.menu));
  assert.ok(menus.includes("file") && menus.includes("edit") && menus.includes("view"));
  for (const name of menus) {
    const entry = menu(name);
    await measure("menu-open", () => entry.locator(":scope > summary").click());
    assert.ok(await entry.evaluate(e => e.open));
    await measure("menu-close", () => page.keyboard.press("Escape"));
    assert.ok(await entry.evaluate(e => !e.open));
  }
  const canvas = page.locator("#canvas");
  await measure("canvas-context-menu", () => canvas.click({button:"right", position:{x:40, y:40}}));
  await page.locator(".nav-menu:visible").first().waitFor();
  await page.keyboard.press("Escape");
  const sheets = await page.evaluate(() => AtriumNavHost.project().documents.filter(d => d.kind === "schematic").slice(0, 4).map(d => d.id));
  for (const id of sheets.slice(1)) {
    await measure("project-tree-switch", () => page.locator('#documents [data-doc="' + id + '"]:not([data-port])').click());
    assert.equal(await page.evaluate(() => AtriumNavHost.currentId()), id);
  }
  for (const id of [sheets[1], sheets[2], sheets[0], sheets[3]]) {
    await measure("document-tab-switch", () => page.locator('#document-tabs [data-tab="' + id + '"]').click());
    assert.equal(await page.evaluate(() => AtriumNavHost.currentId()), id);
  }
  await canvas.focus();
  await measure("palette-shortcut-open", () => page.keyboard.press("ControlOrMeta+Shift+p"));
  const palette = page.locator("dialog.nav-palette[open]"), query = palette.getByRole("combobox");
  await query.waitFor();
  await measure("palette-command-search", () => page.keyboard.type("preferences", {delay:23}));
  assert.match(await query.inputValue(), /preferences$/);
  await palette.getByRole("option").first().waitFor();
  await measure("palette-key-navigation", () => page.keyboard.press("ArrowDown"));
  assert.ok(await query.getAttribute("aria-activedescendant"));
  await measure("palette-close", () => page.keyboard.press("Escape"));
  await palette.waitFor({state:"hidden"});
  await menu("view").locator(":scope > summary").click();
  await measure("quick-open", () => menu("view").locator('[data-action="quick-open"]').click());
  await query.waitFor();
  await measure("quick-open-search", () => page.keyboard.type("Module", {delay:23}));
  await palette.getByRole("option", {name:/Module/i}).first().waitFor();
  await page.keyboard.press("Escape");

  await menu("file").locator(":scope > summary").click();
  await measure("preferences-open", () => menu("file").locator('[data-action="preferences"]').click());
  const prefs = page.locator(".prf-dialog[open]");
  await prefs.waitFor();
  for (const section of ["Schematic", "Appearance", "Keyboard", "General"]) {
    const button = prefs.locator(".prf-nav").getByRole("button", {name:section, exact:true});
    await measure("preferences-page", () => button.click());
    assert.equal(await button.getAttribute("aria-current"), "page");
    if (section === "Appearance") {
      for (const theme of ["light", "dark"]) {
        await measure("theme-switch", () => prefs.locator('.thg-card').filter({has:page.locator('input[value="' + theme + '"]')}).click());
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      }
    }
  }
  await prefs.locator(".prf-search").focus();
  await measure("preferences-search", () => page.keyboard.type("grid", {delay:24}));
  assert.equal(await prefs.locator(".prf-search").inputValue(), "grid");
  await prefs.evaluate(e => e.close());
  await menu("place").locator(":scope > summary").click();
  await measure("library-open", () => menu("place").locator('[data-action="library"]').first().click());
  const library = page.locator(".panel-library:visible");
  const find = library.getByRole("searchbox", {name:"Search the library"});
  await find.click();
  await measure("library-search", () => page.keyboard.type("resistor", {delay:24}));
  assert.equal(await find.inputValue(), "resistor");
  const resistor = library.locator('.lib-row[data-def="std-r"]');
  await resistor.waitFor();
  const parts = () => page.evaluate(() => AtriumNavHost.doc().items.filter(i => i.kind === "part").length);
  const before = await parts(), target = await canvas.boundingBox();
  const destX = target.x + target.width / 2, destY = target.y + target.height / 2;
  await resistor.hover();
  await measure("library-drag-place", async () => {
    await page.mouse.down();
    await page.mouse.move(destX - 30, destY, {steps:16});
    await page.waitForFunction(() => AtriumNavHost.placing());
    await page.keyboard.press("Space");
    await page.mouse.move(destX, destY, {steps:4});
    await page.mouse.up();
  });
  assert.equal(await parts(), before + 1);
  await menu("place").locator(":scope > summary").click();
  await measure("catalogue-open", () => menu("place").locator('[data-action="library-catalogue"]').click());
  const catalogue = page.locator("#library-dialog[open]");
  await catalogue.getByRole("searchbox").focus();
  await measure("catalogue-search", () => page.keyboard.type("resistor", {delay:24}));
  assert.equal(await catalogue.getByRole("searchbox").inputValue(), "resistor");
  await catalogue.getByRole("button", {name:"Close library"}).click();
  const sash = page.locator(".dock-sash-left:visible"), rect = await sash.boundingBox();
  assert.ok(rect, "visible dock sash");
  const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await measure("dock-resize", async () => {
    await page.mouse.down(); await page.mouse.move(x+50, y, {steps:24}); await page.mouse.up();
  });
  assert.ok(Math.abs((await sash.boundingBox()).x - rect.x) > 10, "drag resized the dock");
}

async function bomInputs(page, measure) {
  // An ungrouped BOM gives each schematic part its own line. This setting
  // belongs to this isolated browser context.
  await page.evaluate(() => localStorage.setItem("atrium-bom-v1", JSON.stringify({groupBy:[]})));
  const reports = page.locator('.menubar [data-menu="reports"]');
  await reports.locator(":scope > summary").click();
  await measure("bom-open", () => reports.locator('[data-action="bom"]').click());
  const dialog = page.locator(".bom-dialog[open]"), status = dialog.locator(".bom-summary");
  const baseline = await status.textContent(), lines = Number(/([\d,]+) lines/.exec(baseline)?.[1].replaceAll(",", ""));
  assert.ok(lines > 1000 && baseline.includes("All schematic sheets"), baseline);
  for (const [name, query, selector] of [["bom-search", "10k", '.bom-dialog input[aria-label="Search BOM lines"]'],
    ["bom-column-filter", "R", '.bom-dialog input[aria-label="Filter Designator"]']]) {
    const field = page.locator(selector);
    await field.click();
    const stop = await watchResult(page, {input:selector, output:".bom-summary", name:"line-count", requireChange:true});
    for (let i = 0; i < 5; i++) {
      const text = i % 2 ? "~" : query;
      await measure(name, () => page.keyboard.type(text, {delay:20}), () => status.filter({hasText:/\([\d,]+ shown\)/}).waitFor());
      const shown = Number(/\(([\d,]+) shown\)/.exec(await status.textContent())?.[1].replaceAll(",", ""));
      if (text === "~") assert.equal(shown, 0);
      else assert.ok(shown > 0 && shown < lines, "the query shows matching BOM lines");
      await page.keyboard.press("ControlOrMeta+a");
      await measure(name, () => page.keyboard.press("Backspace"), () => status.filter({hasNotText:/ shown\)/}).waitFor());
      assert.equal(await status.textContent(), baseline);
    }
    await stop();
  }
  const sort = dialog.locator('th[data-key="designator"]');
  for (const dir of ["descending","ascending"]) {
    await measure("bom-sort", () => sort.getByRole("button").click());
    assert.equal(await sort.getAttribute("aria-sort"), dir);
  }
  await dialog.evaluate(e => e.close());
  return lines;
}

async function notebookInputs(page, cdp, measure) {
  const fixture = await page.evaluate(async () => {
    const h = AtriumNavHost;
    h.selectDocument("trace-notebook");
    const doc = h.doc(), editor = await AtriumLazy.need("AtriumTableEditor"), T = AtriumTableData;
    const table = AtriumSheetWidgets.make("table", [5, 35]);
    const state = T.create(1000, 50);
    table.widget.state = T.batch(state, state.rows.map((r, i) => ({rowId:r.id, columnId:state.columns[0].id,
      content:{kind:"literal", text:(i % 4 ? "Offset " : "Gain ") + i}})));
    h.edit(() => doc.items.push(table), "Insert notebook table", [table]);
    editor.open(h, doc.id, table.id);
    return {tableId:table.id, rowId:state.rows[0].id, secondColumn:state.columns[1].id};
  });
  const dialog = page.getByRole("dialog", {name:"Edit table"}), grid = dialog.getByRole("grid");
  const count = () => grid.getAttribute("aria-rowcount");
  await dialog.locator("summary").click();
  const filter = dialog.getByRole("searchbox", {name:"Column filter"});
  const stop = await watchResult(page, {input:'.table-editor input[aria-label="Column filter"]', output:".table-viewport", name:"row-count",
    key:"Tab", attribute:"aria-rowcount", requireChange:true});
  const filterEdits = 12;
  for (let i = 0; i < filterEdits; i++) {
    await filter.click();
    await measure("notebook-column-filter-type", () => page.keyboard.type("Gain", {delay:24}));
    assert.equal(await filter.inputValue(), "Gain"); assert.equal(await count(), "1000");
    await measure("notebook-column-filter-commit", () => page.keyboard.press("Tab"), () => dialog.locator('[role=grid][aria-rowcount="250"]').waitFor());
    assert.equal(await count(), "250");
    await filter.click(); await page.keyboard.press("ControlOrMeta+a");
    await measure("notebook-column-filter-delete", () => page.keyboard.press("Backspace"));
    assert.equal(await count(), "250");
    await measure("notebook-column-filter-reset", () => page.keyboard.press("Tab"), () => dialog.locator('[role=grid][aria-rowcount="1000"]').waitFor());
    assert.equal(await count(), "1000");
  }
  await stop();
  const sort = dialog.getByRole("combobox", {name:"Sort column"});
  for (const [label, value] of [["Ascending","1"], ["Descending","-1"], ["Sheet order",""]]) {
    await sort.click();
    await measure("notebook-column-sort", () => dialog.getByRole("listbox").getByRole("option", {name:label, exact:true}).click());
    assert.equal(await sort.inputValue(), value);
  }
  await dialog.locator("summary").click();
  await grid.getByRole("gridcell", {name:"Gain 0", exact:true}).click();
  const cell = grid.locator('[role=gridcell][aria-rowindex="1"][aria-colindex="2"]');
  await cell.click(); await grid.press("F2");
  const formula = dialog.getByRole("textbox", {name:"Cell contents or formula"});
  await measure("notebook-formula-type", () => page.keyboard.type("=2*3+1", {delay:24}));
  assert.equal(await formula.inputValue(), "=2*3+1");
  await measure("notebook-formula-commit", () => page.keyboard.press("Enter"));
  await grid.getByRole("gridcell", {name:"7", exact:true}).first().waitFor();
  assert.equal(await page.evaluate(({tableId,rowId,secondColumn}) => {
    const table = AtriumNavHost.doc().items.find(i => i.id === tableId);
    return AtriumTableData.get(table.widget.state, rowId, secondColumn).content.source;
  }, fixture), "=2*3+1");
  await measure("notebook-grid-keys", async () => {
    for (let i = 0; i < 12; i++) await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Shift+ArrowRight");
  });
  assert.equal(await dialog.locator(".table-address").textContent(), "C14");
  const rect = await grid.boundingBox();
  await page.mouse.move(rect.x+rect.width/2, rect.y+rect.height/2);
  await measure("notebook-grid-scroll", async () => {
    for (let i=0; i<18; i++) await page.mouse.wheel(25, 92);
  });
  assert.ok(await grid.evaluate(e => e.scrollTop > 400 && e.scrollLeft > 0));
  const rendered = await grid.getByRole("gridcell").count();
  assert.ok(rendered > 0 && rendered < 1000, "a window of table cells is mounted");
  await measure("notebook-table-close", () => dialog.getByRole("button", {name:"Done", exact:true}).click());

  const noteId = await page.evaluate(async () => {
    const h = AtriumNavHost, rich = await AtriumLazy.need("AtriumRichText");
    const item = await rich.insert({context:{host:h,docId:h.currentId(),point:[8,7]},argument:"Measurements"}, "paragraph");
    const editor = await AtriumLazy.need("AtriumRichTextEditor");
    await editor.open(h, item); return item.id;
  });
  const note = page.getByRole("textbox", {name:"Engineering note"});
  await note.click(); await page.keyboard.press("ControlOrMeta+a");
  await measure("note-text-entry", () => page.keyboard.type("Measured gain", {delay:24}));
  await measure("note-paragraph-edit", async () => {
    await page.keyboard.press("End"); await page.keyboard.press("Enter"); await page.keyboard.type("Second reading", {delay:24});
    await page.keyboard.press("Backspace");
  });
  assert.match(await note.innerText(), /Second readin/);
  await measure("note-commit", () => page.getByRole("button", {name:"Finish editing"}).click());
  assert.ok(await page.evaluate(id => JSON.stringify(AtriumNavHost.doc().items.find(i => i.id === id).richText).includes("Second readin"), noteId));

  const canvas = page.locator("#canvas");
  await canvas.focus(); await page.keyboard.press("/");
  const palette = page.locator("dialog.nav-palette[open]");
  await palette.getByRole("combobox").fill("Sketch");
  await measure("notebook-sketch-open", () => palette.getByRole("option", {name:/Sketch/i}).first().click());
  await page.waitForFunction(() => AtriumNavHost.tool() === "sketch");
  const box = await canvas.boundingBox(), x = box.x + box.width / 3, y = box.y + box.height / 2;
  const pen = (type, step, buttons) => cdp.send("Input.dispatchMouseEvent", {type, pointerType:"pen",
    x:x + step * 3, y:y + 12 * Math.sin(step / 4), force:buttons ? .2 + step / 60 : 0, buttons,
    button:type === "mouseMoved" ? "none" : "left", clickCount:type === "mouseMoved" ? 0 : 1});
  await pen("mouseMoved", 0, 0);
  await measure("notebook-pen-stroke", async () => {
    await pen("mousePressed", 0, 1);
    for (let i = 1; i <= 36; i++) await pen("mouseMoved", i, 1);
    await pen("mouseReleased", 36, 0);
  });
  const stroke = await page.evaluate(() => {
    const ink = AtriumNavHost.doc().items.filter(i => i.ink);
    return ink.length === 1 ? AtriumMarkup.points(ink[0]) : [];
  });
  assert.ok(stroke.length > 2 && new Set(stroke.map(p => p[2])).size > 1, "the recorded ink carries pen pressure");
  await canvas.focus();
  await measure("notebook-stroke-undo", () => page.keyboard.press("ControlOrMeta+z"));
  assert.ok(await page.evaluate(() => !AtriumNavHost.doc().items.some(i => i.ink)));
  return {tableRows:1000, tableColumns:50, populatedLabels:1000, filteredRows:250, filterEdits, renderedCellsAfterScroll:rendered, strokeVertices:stroke.length};
}

module.exports = {shellInputs, bomInputs, notebookInputs};
