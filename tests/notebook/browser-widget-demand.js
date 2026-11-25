"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {createStaticServer} = require("../support/browser-app-server.cjs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");

const root = path.resolve(__dirname, "../.."), app = path.join(root, "app");
const timeoutMs = 12000;
const heavy = new Set(["sheet-widgets.js", "sheet-widget-runtime.js", "sheet-widget-editor.js",
  "extension-widgets.js", "extension-palette-view.js"]);
const scripts = page => page.evaluate(() => [...document.scripts].filter(s => s.src).map(s => s.src.split("/").at(-1)));
const pkg = name => {
  const folder=path.join(root, "extensions/examples", name);
  return Object.fromEntries(fs.readdirSync(folder).filter(file => /\.(?:js|json)$/.test(file))
    .map(file => [file, fs.readFileSync(path.join(folder,file), "utf8")]));
};

async function nativeZIP() {
  const {nativeRecords}=require("../support/native-cad.cjs");
  for (const name of ["format-2-closure","import-sidecars","zip","project-archive"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const {read}=nativeRecords("widget-demand"), manifestPath="Project.waffle";
  const verified=await AtriumProjectArchive.verifyClosure({manifestPath,read});
  assert.equal(verified.manifest.header.formatVersion,"2.0");
  const {name,bytes}=await AtriumProjectArchive.archive({...verified,read});
  return {name,mimeType:"application/zip",buffer:Buffer.from(bytes)};
}

// Playwright's action timeout does not bound promises returned by page.evaluate.
async function within(promise, operation) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Error(operation + " did not complete")), timeoutMs);
    })]);
  } finally {clearTimeout(timer);}
}

async function install(page, name) {
  await Promise.all([
    within(page.evaluate(files => AtriumExtensions.install(files), pkg(name)), "Installing " + name),
    page.locator("dialog.ext-prompt").getByRole("button", {name:"Install", exact:true}).click(),
  ]);
}

async function run(browser, appURL, archive) {
  const context = await browser.newContext({viewport:{width:1280,height:900}});
  await require("../fixtures/notebook-labs.cjs").profile(context);
  await context.addInitScript(() => {
    window.widgetSheetPaints=new Set();
    const fillText=CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText=function(text,...args) {
      if (text==="☐ Verify source" || text==="0 complete") window.widgetSheetPaints.add(globalThis.AtriumNavHost?.currentId()+"/"+text);
      return fillText.call(this,text,...args);
    };
  });
  const page = await context.newPage(), errors = [], workers = [];
  let rejectViews = true, denied = 0, heldRequests = 0, releaseView, heldView;
  const viewRequest = request => new URL(request.url()).pathname.endsWith("/extension-palette-view.js");
  page.setDefaultTimeout(timeoutMs);
  page.on("pageerror", error => errors.push(error.message));
  page.on("worker", worker => workers.push(worker.url().startsWith("blob:") ? "blob" : worker.url().split("/").at(-1)));
  await context.route("**/extension-palette-view.js", async route => {
    if (rejectViews) {denied++; await route.abort(); return;}
    if (heldView) {heldRequests++; await heldView;}
    await route.continue();
  });
  try {
    await page.goto(appURL);
    await page.locator("dialog.sp-dialog[open]").waitFor();
    const home = await scripts(page);
    assert.deepEqual(home.filter(s => heavy.has(s) || s === "widget-catalogue.js" || s === "extensions.js"), []);
    assert.deepEqual(workers, []);
    await page.getByRole("button", {name:"Continue to editor", exact:true}).click();
    await page.waitForFunction(() => !AtriumStartPage.isOpen() && globalThis.AtriumExtensions?.attached);
    await install(page, "widget-inspection");
    await install(page, "palette-footprints");
    await page.reload();
    await page.locator("dialog.sp-dialog[open]").waitFor();
    await page.waitForFunction(() => globalThis.AtriumExtensionWidgetDeclarations?.entries().some(e => e.title === "Inspection counter"));
    const installed = await scripts(page);
    assert.deepEqual(installed.filter(s => heavy.has(s) || s === "widget-catalogue.js"), []);
    assert.deepEqual(workers, []);

    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    assert.deepEqual((await scripts(page)).filter(s => heavy.has(s)), []);
    await page.locator("#file-input").setInputFiles(archive);
    await page.getByRole("dialog", {name:"Open project ZIP"}).getByRole("button", {name:"Open project", exact:true}).click();
    await page.waitForFunction(() => AtriumNavHost.folderProject()?.temporary && AtriumNavHost.doc().id === "electrical-sheet");
    const unopened = await scripts(page);
    assert.deepEqual(unopened.filter(s => heavy.has(s) || s === "widget-catalogue.js"), [], "unopened child sheets load no widget rendering");
    assert.equal(await page.evaluate(() => AtriumExtensions.workers.length), 0);

    const first = Date.now();
    await page.locator('#documents [data-doc="checklist-sheet"]').click();
    await page.waitForFunction(() => {
      const host=AtriumNavHost, doc=host.doc();
      return window.widgetSheetPaints.has("checklist-sheet/☐ Verify source") && doc.id === "checklist-sheet" && globalThis.AtriumSheetWidgetRuntime?.preparedView(host.project(),doc,doc.items[0],host.revision())?.rows[0]?.cells[0]?.text === "Verify source";
    });
    const checklistMs = Date.now() - first;
    assert.deepEqual((await scripts(page)).filter(s => heavy.has(s)), ["sheet-widgets.js","sheet-widget-runtime.js"]);
    const notebookPresets = await page.evaluate(() => AtriumWidgetCatalogue.calculatorPresets.map(([id, label]) => [id, label, AtriumWidgetCatalogue.valid({kind:"textframe", w:48, h:28, widget:{type:"calculator", state:{calculator:id}, fallback:{type:"text", text:"Calculator"}}})]));
    assert.deepEqual(notebookPresets, [["voltage_divider", "Voltage divider", true], ["led_resistor", "LED resistor", true], ["rclc", "RC filter", true]]);
    assert.equal(notebookPresets.some(([id]) => id === "via" || id === "track"), false);
    assert.equal(await page.evaluate(() => AtriumWidgetCatalogue.valid({kind:"textframe", w:48, h:28, widget:{type:"calculator", state:{calculator:"via"}, fallback:{type:"text", text:"Calculator"}}})), false);
    assert.equal(await page.evaluate(() => AtriumWidgetCatalogue.valid({kind:"textframe", w:48, h:28, widget:{type:"calculator", state:{calculator:"track"}, fallback:{type:"text", text:"Calculator"}}})), false);
    assert.equal(await page.evaluate(() => AtriumWidgetCatalogue.valid({kind:"textframe", w:48, h:28, widget:{type:"calculator", state:{calculator:"voltage_divider"}, fallback:{type:"text", text:"Calculator"}}})), true);

    const rejected=await page.evaluate(() => {
      const trial=Atrium.project("Widget bounds",[]);
      trial.documents=[Atrium.clone(AtriumNavHost.doc())];
      Atrium.validate(trial);
      trial.documents[0].items[0].w=401;
      try {Atrium.validate(trial); return false;} catch {return true;}
    });
    assert.equal(rejected, true, "the hydrated widget retains its structural bounds");

    const extensionStart = Date.now();
    await page.locator('#documents [data-doc="extension-sheet"]').click();
    await page.waitForFunction(() => {
      const host=AtriumNavHost, doc=host.doc();
      return window.widgetSheetPaints.has("extension-sheet/0 complete") && doc.id === "extension-sheet" && AtriumSheetWidgetRuntime.preparedView(host.project(),doc,doc.items[0],host.revision())?.rows[0]?.cells[0]?.text === "0 complete";
    });
    const extensionMs = Date.now() - extensionStart;
    assert.ok(await page.evaluate(() => AtriumExtensions.workers.some(w => w.members.includes("example.inspection"))));

    await install(page, "palette-calculator");
    const math=await within(page.evaluate(async () => {
      const args=[{value:10,dimension:"voltage"},{value:2000,dimension:"resistance"},{value:1000,dimension:"resistance"}];
      const quantity=await AtriumExtensionPalette.evaluateMath("example.divider.vout","1.0.0",args);
      return {value:quantity.display, stats:AtriumCalculations.stats(), paletteView:typeof globalThis.AtriumExtensionPaletteView};
    }), "Evaluating the divider definition");
    assert.equal(math.value,"3.333 V");
    assert.ok(math.stats.workerMs>=0 && math.stats.jobs>0 && math.stats.local===0);
    assert.equal(math.paletteView,"undefined", "declared math can run without opening the palette");
    const shortcut="command:ext:example.divider:divider";
    await page.evaluate(key => AtriumKeymap.setBindings(key,["Ctrl+Alt+Shift+G"]),shortcut);


    await page.evaluate(() => AtriumNavHost.act("start-page"));
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    const query=page.locator("#palette[open] [role=combobox]");
    await page.locator("#canvas").focus();
    await Promise.all([
      page.waitForEvent("requestfailed", {predicate:viewRequest, timeout:timeoutMs}),
      (async () => {await page.keyboard.press("/"); await query.fill("Choose footprint");})(),
    ]);
    assert.equal(await page.evaluate(() => typeof globalThis.AtriumExtensionPaletteView), "undefined");
    await page.keyboard.press("Escape");
    await query.waitFor({state:"hidden"});
    // The network failure can reach Playwright before the script error clears the lazy load.
    await page.waitForFunction(() => !AtriumLazy.pending("AtriumExtensionPaletteView"));

    rejectViews=false;
    const paletteAt=Date.now();
    heldView=new Promise(resolve => {releaseView=resolve;});
    await Promise.all([
      page.waitForEvent("request", {predicate:viewRequest, timeout:timeoutMs}),
      page.keyboard.press("Control+Alt+Shift+G"),
      query.waitFor(),
    ]);
    await page.keyboard.press("Escape");
    await query.waitFor({state:"hidden"});
    assert.equal(heldRequests, 1, "Escape closes the palette while exactly one retry request is held");
    heldView=null;
    releaseView();
    await page.waitForFunction(() => globalThis.AtriumExtensionPaletteView && !AtriumLazy.pending("AtriumExtensionPaletteView"));
    const cancelled = await page.evaluate(() => ({
      paletteOpen: document.getElementById("palette").open,
      focusOnCanvas: document.activeElement === document.getElementById("canvas"),
      dividerWorker: AtriumExtensions.workers.some(w => w.members.includes("example.divider")),
    }));
    assert.deepEqual(cancelled, {paletteOpen:false, focusOnCanvas:true, dividerWorker:false});

    await page.keyboard.press("Control+Alt+Shift+G");
    await page.locator("#palette[open] .nav-palette-screen form").waitFor();
    assert.ok(await page.evaluate(() => AtriumExtensions.workers.some(w => w.members.includes("example.divider"))));
    const shortcutMs=Date.now()-paletteAt;
    await page.keyboard.press("Escape");
    await page.locator("#palette .nav-palette-screen form").waitFor({state:"hidden"});
    await page.keyboard.press("Escape");
    await query.waitFor({state:"hidden"});
    await page.locator("#canvas").focus();
    const gridAt=Date.now();
    await page.keyboard.press("/");
    await query.fill("Choose footprint");
    await page.getByRole("option").filter({has:page.locator(".nav-palette-label").filter({hasText:/^Choose footprint$/})}).click();
    await page.locator("#palette .nav-palette-screen [data-kind=grid]").waitFor();
    assert.ok(denied > 0);
    assert.deepEqual(errors, []);
    const final = await scripts(page);
    assert.equal(final.filter(s => s === "widget-fallback.js").length, 1);
    assert.equal(final.filter(s => s === "extension-palette-view.js").length, 1);
    return {origin:new URL(appURL).protocol, homeScripts:home.length, installedScripts:installed.length,
      deniedViewRequests:denied, heldViewRequests:heldRequests, cancelled, firstUseMs:{checklist:checklistMs, extension:extensionMs, paletteRetryAndShortcut:shortcutMs, paletteGrid:Date.now()-gridAt}};
  } finally {releaseView?.();await context.close();}
}

(async () => {
  const server=createStaticServer({
    root: app,
    requireFile: true,
    mime: {".js":"text/javascript",".html":"text/html",".css":"text/css",".svg":"image/svg+xml"},
  });
  await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
  let browser;
  try {
    const archive=await nativeZIP();
    const executablePath=process.env.CHROME;
    browser=await chromium.launch({...(executablePath ? {executablePath} : {channel:"chrome"}), timeout:timeoutMs});
    for (const url of [pathToFileURL(path.join(app,"index.html")).href, "http://127.0.0.1:"+server.address().port+"/index.html"])
      console.log(JSON.stringify(await run(browser,url,archive)));
  } finally {
    try {await browser?.close();}
    finally {
      await new Promise(resolve => {server.close(resolve);server.closeAllConnections?.();});
    }
  }
})().catch(error => {console.error(error);process.exitCode=1;});
