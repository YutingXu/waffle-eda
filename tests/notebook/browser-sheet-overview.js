"use strict";
// Run with Playwright Core and installed Chrome. --screenshots DIRECTORY captures both themes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");
const screens = process.argv.includes("--screenshots") ? process.argv[process.argv.indexOf("--screenshots")+1] : null;
const url = pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href;

function fixture() {
  const A = Atrium, S = AtriumSchObjects, project = A.project("Sensor controller");
  const [top, board] = project.documents;
  top.name = "Controller";
  const sensor = A.sheet("schematic","Sensor input"), power = A.sheet("schematic","Power supply"), debug = A.sheet("schematic","Debug port");
  const entries = (symbol, names) => {symbol.entries = names.map((name,i) => ({id:"entry"+i,name,side:"left",offset:5+5*i,io:"input"})); return symbol;};
  top.items.push(entries(S.make("sheetsymbol",[45,45],{name:"Sensors",sheet:sensor.id}),["CLK","DATA[0..3]"]));
  top.items.push(entries(S.make("sheetsymbol",[45,100],{name:"Regulator",sheet:power.id}),["ENABLE"]));
  sensor.items.push(S.make("sheetsymbol",[140,75],{name:"Debug",sheet:debug.id}));
  const port = (doc, name, y) => {const q = S.make("port",[70,y],{text:name,io:"input"}); doc.items.push(q); return q.id;};
  const clk = port(sensor,"CLK",30), bus = port(sensor,"DATA[0..3]",50);
  port(power,"ENABLE",45);
  top.items.push(S.make("power",[90,70],{text:"GND"}));
  sensor.items.push(S.make("power",[90,100],{text:"GND"}));
  power.items.push(S.make("power",[100,100],{text:"GND"}));
  project.documents.push(sensor,power,debug);
  return {project,ids:{top:top.id,board:board.id,sensor:sensor.id,clk,bus}};
}

async function open(page) {
  const menu = page.locator('.menubar [data-menu="project"]');
  await menu.locator(":scope > summary").click();
  await menu.getByRole("menuitem",{name:"Sheet Overview",exact:true}).click();
  const box = page.locator("#doc-view-sheet-overview");
  await box.locator(".sheet-overview-node").first().waitFor();
  return box;
}
async function backOrForward(page, name, doc) {
  const menu = page.locator('.menubar [data-menu="view"]');
  await menu.locator(":scope > summary").click();
  await menu.getByRole("menuitem",{name,exact:true}).click();
  await page.waitForFunction(id => AtriumNavHost.currentId() === id, doc);
}

(async () => {
  const browser = await chromium.launch({headless:true,...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"})});
  try {
    if (screens) fs.mkdirSync(screens,{recursive:true});
    for (const theme of ["light","dark"]) {
      const page = await browser.newPage({viewport:{width:1440,height:880},colorScheme:theme,reducedMotion:"reduce"});
      const errors = [];
      page.on("pageerror", e => errors.push(e.message));
      page.setDefaultTimeout(12000);
      try {
        await page.goto(url);
        await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
        await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
        const {project,ids} = await page.evaluate(fixture);
        await page.evaluate(async ({project,theme}) => {
          await AtriumLazy.need(AtriumLazy.validatorsFor(project));
          await AtriumNavHost.replaceProject(Atrium.validate(project),{force:true,dirty:false});
          AtriumTheme.set({preset:theme,followSystem:false},{persist:false});
        },{project,theme});
        assert.equal(await page.evaluate(() => globalThis.AtriumSheetOverviewModel),undefined,"the diagram is lazy");
        const original = await page.evaluate(() => JSON.stringify(AtriumNavHost.project()));
        assert.equal(await page.evaluate(() => AtriumNavHost.currentId()),ids.board);
        const box = await open(page);
        assert.equal(await box.getByRole("button",{name:"Open Controller",exact:true}).count(),1);
        assert.equal(await box.locator(".sheet-overview-node").count(),4);
        assert.equal(await box.locator(".sheet-overview-branch").count(),3);
        assert.ok(await box.locator(".sheet-overview-wire-label").filter({hasText:"DATA[0..3]"}).count());
        if (screens) await page.screenshot({path:path.join(screens,"sheet-overview-"+theme+".png"),animations:"disabled"});
        await page.waitForFunction(() => document.activeElement?.classList.contains("sheet-overview-node"));
        await page.keyboard.press("ArrowRight");
        assert.match(await page.evaluate(() => document.activeElement.getAttribute("aria-label")),/Sensor input/);
        await page.keyboard.press("Enter");
        await box.waitFor({state:"hidden"});
        assert.equal(await page.evaluate(() => AtriumNavHost.currentId()),ids.sensor);
        await backOrForward(page,"Previous View",ids.board);
        await backOrForward(page,"Next View",ids.sensor);

        await page.evaluate(id => AtriumNavHost.selectDocument(id), ids.top);
        await open(page);
        const search = box.getByRole("searchbox",{name:"Filter connections"});
        await search.fill("DATA[0..3]");
        assert.equal(await box.locator(".sheet-overview-connection").count(),1);
        await box.locator(".sheet-overview-wire-label").click();
        await page.waitForFunction(({sensor,bus}) => AtriumNavHost.currentId() === sensor && AtriumNavHost.selection().includes(bus),ids);
        await box.waitFor({state:"hidden"});
        await backOrForward(page,"Previous View",ids.top);
        await backOrForward(page,"Next View",ids.sensor);
        assert.equal(await page.evaluate(() => JSON.stringify(AtriumNavHost.project())),original,"navigation has no project writes");

        await open(page);
        await search.fill("nothing here");
        assert.equal(await box.locator(".sheet-overview-connection").count(),0);
        assert.ok(await box.getByText("No matching connections.",{exact:true}).isVisible());
        await search.press("Escape");
        await box.waitFor({state:"hidden"});
        assert.ok(await page.getByRole("tab",{name:"Sheet Overview",exact:true}).isVisible());
        if (theme === "light") {
          await page.evaluate(async () => {
            const project = Atrium.project("Shared supply");
            const sheets = Array.from({length:120}, (_,i) => Atrium.sheet("schematic","Sheet "+String(i+1).padStart(3,"0")));
            for (const doc of sheets) doc.items.push(AtriumSchObjects.make("power",[0,0],{text:"GND"}));
            project.documents = [project.documents[1], ...sheets];
            await AtriumNavHost.replaceProject(Atrium.validate(project),{force:true,dirty:false});
          });
          await open(page);
          await box.getByText("1–12 of 119",{exact:true}).waitFor();
          await box.getByRole("button",{name:"Next connections"}).click();
          await box.getByText("13–24 of 119",{exact:true}).waitFor();
          assert.equal(await box.locator(".sheet-overview-connection").count(),12);
          assert.ok(await box.locator(".sheet-overview-node").count() < 24,"offscreen sheets do not allocate DOM");
          await box.locator('.sheet-overview-node[tabindex="0"]').focus();
          await page.keyboard.press("End");
          assert.equal(await page.evaluate(() => document.activeElement.getAttribute("aria-label")),"Open Sheet 120");
          assert.ok(await box.locator(".sheet-overview-node").count() < 24,"scrolling removes offscreen sheet DOM");
          await search.fill("Sheet 120");
          assert.equal(await box.locator(".sheet-overview-connection").count(),1);
        }
        assert.deepEqual(errors,[]);
        console.log(theme,"sheet and connection jumps, back and forward, keyboard, read-only");
      } finally {await page.close();}
    }
  } finally {await browser.close();}
})().catch(error => {console.error(error); process.exitCode=1;});
