"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function symbolWizard(browser) {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  const dialog = page.getByRole("dialog", {name: "Symbol Wizard"});
  const source = dialog.getByRole("textbox", {name: "Pin table"});
  const pins = count => "Pin\tName\tType\n" + Array.from({length: count}, (_, i) => (i + 1) + "\tSIG" + i + "\tinput").join("\n");
  const pasteTable = text => source.evaluate((field, value) => {
    field.focus();
    field.value = value;
    field.dispatchEvent(new InputEvent("input", {bubbles: true, inputType: "insertFromPaste"}));
  }, text);
  const scrollGrid = end => page.evaluate(end => {
    const wrap = wizard.dialog.querySelector(".sw-grid-wrap");
    wrap.scrollTop = end ? wrap.scrollHeight : 0;
  }, end);
  const focusedLabel = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label"));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.evaluate(async () => {
      const W = await AtriumLazy.need("AtriumSymbolWizard");
      const proto = CanvasRenderingContext2D.prototype, fillText = proto.fillText;
      window.wizardText = new Set();
      proto.fillText = function (text, ...args) {
        if (this.canvas.matches(".sw-canvas")) wizardText.add(text);
        return fillText.call(this, text, ...args);
      };
      window.wizard = W.open({
        pickFile: () => new Promise(resolve => { window.chooseWizardFile = resolve; }),
        apply: (_, def) => { window.appliedSymbol = def; }
      });
    });
    await source.fill(pins(12));
    await page.waitForFunction(() => wizardText.has("SIG11"));
    const name = dialog.getByRole("textbox", {name: "Name of pin 1", exact: true});
    await name.fill("EDITED");
    await name.press("Tab");
    await page.waitForFunction(() => wizardText.has("EDITED"));
    assert.equal(await dialog.getByRole("checkbox", {name: "Active low pin 1", exact: true}).evaluate(i => i === document.activeElement), true);

    let latest;
    for (const count of [1024, 4096, 2048]) {
      latest = pins(count);
      await pasteTable(latest);
      await page.waitForFunction(n => wizard.result().pins.length === n, count);
      assert.ok(await dialog.locator(".sw-grid tbody tr[data-r]").count() < 100, "large paste keeps grid DOM bounded");
    }
    await name.fill("EDITED OFFSCREEN");
    await scrollGrid(true);
    const tail = dialog.getByRole("textbox", {name: "Name of pin 2048", exact: true});
    await tail.waitFor();
    assert.equal(await name.evaluate(i => i === document.activeElement && i.value === "EDITED OFFSCREEN"), true);
    await tail.fill("LAST PIN");
    await tail.press("Tab");
    const rows = await page.evaluate(() => wizard.result().pins);
    assert.equal(rows[0].base, "EDITED OFFSCREEN");
    assert.equal(rows.at(-1).base, "LAST PIN");

    // Tab crosses the logical row boundary when an active row is far from the scroll window.
    await scrollGrid(false);
    await dialog.getByRole("textbox", {name: "Gate of pin 1", exact: true}).focus();
    await scrollGrid(true);
    await tail.waitFor();
    await page.keyboard.press("Tab");
    assert.equal(await focusedLabel(), "Include pin 2");
    await scrollGrid(true);
    await dialog.getByRole("checkbox", {name: "Include pin 2048", exact: true}).focus();
    await scrollGrid(false);
    await name.waitFor();
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focusedLabel(), "Gate of pin 2047");
    await dialog.getByRole("textbox", {name: "Gate of pin 2048", exact: true}).focus();
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => !!document.activeElement.closest(".sw-grid")), false);

    // Issue buttons can find an affected pin that was never mounted.
    await scrollGrid(false);
    await pasteTable(latest.replace("2048\tSIG2047", "2047\tSIG2047"));
    const duplicate = dialog.getByRole("button", {name: /Pin 2047 appears 2 times/});
    await dialog.locator('.sw-grid tbody tr[data-r="2046"]').waitFor({state: "detached"});
    await duplicate.click();
    assert.equal(await focusedLabel(), "Number of pin 2047");
    assert.equal(await dialog.getByRole("button", {name: "Apply to symbol"}).isDisabled(), true);

    // A file chooser opened before another paste must not overwrite the new table.
    await dialog.getByRole("button", {name: "Import file…"}).click();
    await source.fill("1 NEW input");
    await page.evaluate(() => chooseWizardFile(new File(["1 OLD input"], "stale.csv")));
    await page.waitForFunction(() => wizard.result().pins[0]?.base === "NEW");
    await source.evaluate(field => {
      field.value = "1 SUBMITTED output";
      field.dispatchEvent(new Event("input", {bubbles: true}));
      field.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", ctrlKey: true, bubbles: true}));
    });
    await dialog.waitFor({state: "detached"});
    assert.equal(await page.evaluate(() => appliedSymbol.symbol.pins[0].name), "SUBMITTED");
    assert.deepEqual(errors, []);
    console.log("PASS Symbol Wizard live preview, focused pin edits, windowed large pastes, issue jumps and immediate Apply");
  } finally { await page.close(); }
};
