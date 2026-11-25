"use strict";

// Use the editor's normal Open and first Save when a bounded headless import cannot finish.
// No screenshots, report contents, source names, paths or exception text leave this process.
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");
const input = JSON.parse(fs.readFileSync(0, "utf8"));

let phase = "launch";
async function main() {
  const browser = await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"});
  let page;
  try {
    const context = await browser.newContext({viewport:{width:1380,height:860}, acceptDownloads:true});
    await context.route(/^https?:/, route => route.abort());
    page = await context.newPage();
    page.setDefaultTimeout(20000);
    phase = "source open";
    await page.goto(pathToFileURL(path.join(input.product,"app/index.html")).href);
    const chooser = page.waitForEvent("filechooser");
    await page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Import from Altium or KiCad…", exact:true}).click();
    await (await chooser).setFiles(input.sources);
    await page.waitForFunction(() => globalThis.AtriumNavHost?.importSession()?.state === "unsaved", null, {timeout:120000});
    phase = "opening first Save";
    const guidance = page.locator(".import-save-link");
    if (await guidance.isVisible()) await guidance.click();
    else await page.locator('.quick-access [data-action="save"]').click();
    phase = "selecting native Save As";
    const sheet = page.locator(".import-save-sheet[open]");
    await sheet.getByRole("button",{name:"Save as Waffle Project…",exact:true}).click();
    phase = "native ZIP download";
    const downloading = page.waitForEvent("download",{timeout:180000});
    await sheet.getByRole("button",{name:"Download Format 2 ZIP",exact:true}).click();
    const download = await downloading;
    await download.saveAs(input.archive);
    if (await download.failure()) throw Error("The native ZIP did not finish");
  } catch (error) {
    if (input.private || !page) throw error;
    const status = await page.locator("#status").textContent().catch(() => "");
    console.error(JSON.stringify({phase, editorStatus:status?.slice(0,256), error:error.name}));
    throw error;
  } finally { await browser.close(); }
}

main().catch(() => { console.error("The isolated editor did not complete " + phase + "."); process.exitCode = 1; });
