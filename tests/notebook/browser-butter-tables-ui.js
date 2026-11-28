"use strict";
// Table editor: library faces (toolbar, fields, buttons, status line),
// keyboard entry with Enter and arrows, a formula result, a failing formula marked on its cell with the
// diagnostic in the status line and the authored source kept, table and text history, grouped options, and the touch Edit cell.
const assert = require("node:assert/strict"), path = require("node:path"), {pathToFileURL} = require("node:url");

async function open(browser, touch) {
  const page = await browser.newPage({viewport:{width:1250, height:900}, hasTouch:touch, reducedMotion:"reduce"});
  page.errors = []; page.on("pageerror", e => page.errors.push(e.message)); page.setDefaultTimeout(10000);
  await require("../fixtures/notebook-labs.cjs").profile(page);
  await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
  await page.getByRole("button", {name:/^(Try the Demo|Load a demo)$/i}).click();
  await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
  await page.evaluate(async () => {
    const h = AtriumNavHost; h.selectDocument(h.project().documents.find(d => d.kind === "schematic").id);
    await AtriumLazy.need("AtriumSheetWidgetEditor"); const i = AtriumSheetWidgets.make("table", [12, 20]);
    h.edit(() => { h.doc().items.push(i); }, "Place table", [i]); await AtriumPrefs.set("butter.tables", true); h.select([i.id], i.id); AtriumSheetWidgetEditor.open(i.id, h);
  });
  await page.getByRole("button", {name:"Upgrade to full table"}).click();
  const dialog = page.getByRole("dialog", {name:"Edit table", exact:true});
  await dialog.getByRole("grid").waitFor();
  return {page, dialog};
}

module.exports = async function tablesUI(browser) {
  const {page, dialog} = await open(browser, false);
  try {
    // Library faces.
    assert.equal(await dialog.locator(".table-tools.ui-toolbar[role=toolbar]").count(), 1);
    assert.equal(await dialog.getByRole("button", {name:"Done", exact:true}).getAttribute("data-variant"), "primary");
    assert.equal(await dialog.getByRole("button", {name:"Merge", exact:true}).getAttribute("data-variant"), "quiet");
    assert.ok(await dialog.getByRole("combobox", {name:"Cell type"}).evaluate(n => n.classList.contains("ui-field")));
    assert.equal(await dialog.locator(".table-status").evaluate(n => n.classList.contains("ui-status-line") && n.getAttribute("role")), "status");

    // Options open as titled groups; add rows there.
    await dialog.locator("summary").click();
    assert.deepEqual(await dialog.locator(".table-group-title").allTextContents(), ["Rows and columns", "Cell", "Borders", "Column and row", "Insert", "Live data"]);
    for (let i = 0; i < 3; i++) await dialog.getByRole("button", {name:"Add row", exact:true}).click();
    await dialog.locator("summary").click();

    // Keyboard entry: Enter commits and moves down.
    const entry = dialog.getByRole("textbox", {name:"Cell contents or formula"});
    const type = async value => { await entry.fill(value); await entry.press("Enter"); };
    const grid = dialog.getByRole("grid");
    await grid.focus();
    for (const v of ["Gain", "Offset", "Total"]) await type(v);
    for (let i = 0; i < 3; i++) await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowRight");
    for (const v of ["12", "0.4", "=B1*2+B2"]) await type(v);
    await dialog.getByRole("gridcell", {name:"24.4", exact:true}).waitFor();

    // A failing formula: the cell is marked, the status line names the problem, the source stays.
    await type("=B4+1");
    const failed = dialog.locator(".table-cell[data-state=error]");
    await failed.waitFor();
    await failed.click();
    await page.waitForFunction(() => /^Formula: Circular/.test(document.querySelector(".table-editor .table-status").textContent));
    assert.equal(await dialog.locator(".table-status").getAttribute("data-tone"), "danger");
    assert.equal(await entry.inputValue(), "=B4+1");
    await dialog.getByRole("gridcell", {name:"24.4", exact:true}).click();
    await page.waitForFunction(() => document.querySelector(".table-editor .table-status").dataset.tone === undefined);

    const columnB = row => grid.locator(`[role=gridcell][aria-colindex="2"][aria-rowindex="${row}"]`);
    const values = async () => Promise.all([1,2,3].map(row => columnB(row).textContent()));
    await columnB(1).click();
    await grid.evaluate(element => {
      const clipboardData = new DataTransfer();
      clipboardData.setData("text/plain", "7\n1");
      element.dispatchEvent(new ClipboardEvent("paste", {bubbles:true, cancelable:true, clipboardData}));
    });
    assert.deepEqual(await values(), ["7","1","15"]);
    await grid.press("ControlOrMeta+z");
    assert.deepEqual(await values(), ["12","0.4","24.4"], "range paste undoes in one step with its dependent formula");
    await grid.press("ControlOrMeta+Shift+z");
    assert.deepEqual(await values(), ["7","1","15"]);

    await columnB(2).click({modifiers:["Shift"]});
    await grid.press("ControlOrMeta+d");
    assert.deepEqual(await values(), ["7","7","21"]);
    await page.evaluate(() => AtriumKeymap.setBindings("undo", ["Mod+K U"]));
    await grid.press("ControlOrMeta+z");
    assert.deepEqual(await values(), ["7","7","21"], "the replaced shortcut no longer undoes a table edit");
    await grid.press("ControlOrMeta+k");
    await grid.press("u");
    assert.deepEqual(await values(), ["7","1","15"], "the configured shortcut undoes fill and recalculates");
    await page.evaluate(() => AtriumKeymap.resetCommand("undo"));

    await columnB(1).click();
    await grid.press("F2");
    const revision = await page.evaluate(() => AtriumNavHost.revision());
    await page.keyboard.insertText("draft");
    assert.equal(await entry.inputValue(), "draft");
    await entry.press("ControlOrMeta+z");
    assert.equal(await entry.inputValue(), "7", "the entry retains native text undo");
    await entry.press("ControlOrMeta+Shift+z");
    assert.equal(await entry.inputValue(), "draft", "the entry retains native text redo");
    await entry.press("Escape");

    await page.evaluate(() => { AtriumUI.dialog({title:"Another modal"}); });
    const other = page.getByRole("dialog", {name:"Another modal"});
    await other.getByRole("button", {name:"Close", exact:true}).press("ControlOrMeta+z");
    assert.equal(await page.evaluate(() => AtriumNavHost.revision()), revision, "text and other modal shortcuts leave project history alone");
    await other.getByRole("button", {name:"Close", exact:true}).click();
    assert.deepEqual(await values(), ["7","1","15"]);
    await dialog.getByRole("button", {name:"Done", exact:true}).click();
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }

  // Touch: Edit cell opens the keyboard on the entry; targets are 44 px.
  const touch = await open(browser, true);
  try {
    const edit = touch.dialog.getByRole("button", {name:"Edit cell", exact:true});
    const height = await edit.evaluate(n => n.getBoundingClientRect().height);
    assert.ok(height >= 40, "touch buttons reach the touch height (" + height + ")");
    await edit.click();
    assert.equal(await touch.page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Cell contents or formula");
    assert.deepEqual(touch.page.errors, []);
  } finally { await touch.page.close(); }
  console.log("PASS table editor: library faces, grouped options, keyboard entry, formulas, table and text history, touch Edit cell");
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch({...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}), args:["--allow-file-access-from-files"]});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
