"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function heldSettings(browser) {
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.evaluate(async () => (await AtriumLazy.need("AtriumPrefs")).open("general"));
    const input = page.locator("dialog.prf-dialog[open] .prf-row input[type=file]");
    const confirm = page.locator("dialog.prf-held[open]");
    const current = () => page.evaluate(() => ["extensions.developerMode","general.updateCheck"].map(key=>AtriumPrefs.get(key) === true));
    const file = {name:"held.json",mimeType:"application/json",buffer:Buffer.from(JSON.stringify({
      format:"atrium-prefs", version:1, values:{"extensions.developerMode":true,"general.updateCheck":true}
    }))};
    await input.setInputFiles(file);
    await confirm.waitFor();
    const boxes = confirm.getByRole("checkbox");
    assert.deepEqual(await current(),[false,false]);
    assert.deepEqual(await boxes.evaluateAll(nodes=>nodes.map(box=>box.checked)),[false,false]);
    await confirm.getByRole("button",{name:"Keep off",exact:true}).click();
    await confirm.waitFor({state:"hidden"});
    assert.deepEqual(await current(),[false,false]);

    await input.setInputFiles(file);
    await confirm.waitFor();
    const dev = confirm.getByRole("checkbox",{name:/Developer mode/});
    await dev.check();
    assert.deepEqual(await current(),[false,false],"ticking requires a separate confirmation");
    await confirm.getByRole("button",{name:"Turn on ticked",exact:true}).click();
    await confirm.waitFor({state:"hidden"});
    await page.waitForFunction(() => AtriumPrefs.get("extensions.developerMode") === true);
    assert.deepEqual(await current(),[true,false],"only the approved guard is enabled");
    assert.deepEqual(errors,[]);
  } finally {await page.close();}
  console.log("PASS settings imports defer guarded switches and enable only explicitly confirmed checkboxes");
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch({channel:"chrome"});
    try {await module.exports(browser);} finally {await browser.close();}
  })().catch(error => {console.error(error);process.exitCode=1;});
}
