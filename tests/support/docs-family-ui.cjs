"use strict";
// Shared set-up for the documents family UI tests (saved views, slides, datasheets, visual history, tables).
const fs = require("node:fs"), fsp = require("node:fs/promises"), path = require("node:path");
const {pathToFileURL} = require("node:url");
const APP = path.join(__dirname, "../../app");
require(path.join(APP, "core/zip.js"));
require(path.join(APP, "formats/import-sidecars.js"));
const FIXTURES = path.join(__dirname, "../fixtures/butter-acceptance");

async function entries(folder, prefix = "") {
  const out = [];
  for (const item of await fsp.readdir(folder, {withFileTypes:true})) {
    const name = prefix + item.name, file = path.join(folder, item.name);
    if (item.isDirectory()) out.push(...await entries(file, name + "/"));
    else out.push({name, data:await fsp.readFile(file)});
  }
  return out;
}
const PROFILES = {light:{theme:"light", touch:false, viewport:{width:1330, height:840}},
  dark:{theme:"dark", touch:false, viewport:{width:1330, height:840}},
  touch:{theme:"light", touch:true, viewport:{width:1180, height:820}}};

/** A page on the editor with the Start page dismissed. Records script requests and page errors. */
async function editor(browser, profile = "light") {
  const P = PROFILES[profile];
  const page = await browser.newPage({viewport:P.viewport, hasTouch:P.touch, reducedMotion:"reduce", deviceScaleFactor:1, acceptDownloads:true});
  page.setDefaultTimeout(20000);
  page.errors = []; page.scripts = [];
  page.on("pageerror", e => page.errors.push(e.message));
  page.on("request", r => { if (r.resourceType() === "script") page.scripts.push(r.url().split("/").pop()); });
  await page.goto(pathToFileURL(path.join(APP, "index.html")).href);
  await page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Continue to editor", exact:true}).click();
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, P.theme);
  return page;
}
async function savedViewsProject(page) {
  const {IGNORE, ignoreText} = globalThis.AtriumImportSidecars;
  const bytes = globalThis.AtriumZip.create([...await entries(path.join(FIXTURES, "saved-views")), {name:IGNORE, data:ignoreText}]);
  await page.locator("#file-input").setInputFiles({name:"Study.zip", mimeType:"application/zip", buffer:Buffer.from(bytes)});
  await page.getByRole("dialog", {name:"Open project ZIP", exact:true}).getByRole("button", {name:"Open project", exact:true}).click();
  await page.waitForFunction(() => AtriumNavHost.project().name === "Saved-view study");
}
async function slidesProject(page) {
  const dir = path.join(FIXTURES, "slides");
  const files = Object.fromEntries(["Slide study.waffle", "Top.wsch", "Sensor.wsch"].map(n => [n, fs.readFileSync(path.join(dir, n), "utf8")]));
  await page.waitForFunction(() => globalThis.AtriumNavHost?.captureViewState?.());
  await page.evaluate(async fixture => {
    const G = globalThis, host = G.AtriumNavHost;
    await G.AtriumLazy.need("AtriumFormat2Closure");
    const M = G.AtriumFormat2Model, bytes = n => new TextEncoder().encode(fixture[n]);
    const {project, members} = M.manifest(M.parse(bytes("Slide study.waffle")));
    for (const m of members) project.documents.push(M.document(M.parse(bytes(m.path)), {name:m.name}));
    await host.replaceProject(project, {force:true, dirty:false});
  }, files);
}
async function enable(page, features) {
  await page.evaluate(async list => {
    const prefs = await AtriumLazy.need("AtriumPrefs");
    for (const f of list) prefs.set("butter." + f, true);
    await AtriumLazy.need("AtriumButterEditor");
  }, features);
  await page.waitForFunction(() => globalThis.AtriumButterEditor);
}
const commands = (page, prefix) => page.evaluate(p => AtriumKeymap.commands().filter(c => c.id.startsWith(p)).map(c => c.id), prefix);
async function run(page, id) {
  await page.evaluate(id => AtriumKeymap.commands().find(c => c.id === id).run(), id);
}
module.exports = {editor, savedViewsProject, slidesProject, enable, commands, run, PROFILES, APP};
