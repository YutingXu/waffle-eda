"use strict";
// Run with Playwright Core after integrating the shared palette engine and view.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {pathToFileURL} = require("node:url"), {chromium} = require("playwright-core");
const screenshotArg = process.argv.indexOf("--screenshots"), shots = screenshotArg < 0 ? null : process.argv[screenshotArg+1];
const url = pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href;

async function menu(page, key, action) {
  const holder = page.locator('.menubar [data-menu="'+key+'"]');
  await holder.locator(":scope > summary").click();
  await holder.locator('[data-action="'+action+'"]:visible').first().click();
}
async function palette(page, query) {
  await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click();
  const panel = page.locator("#palette"), input = panel.getByRole("combobox");
  await input.fill(query);
  return {panel,input};
}
const choose = (panel, text) => panel.getByRole("option").filter({hasText:text}).first().click();
async function launch(browser, theme, touch = false) {
  const page = await browser.newPage({viewport:{width:touch?760:1440,height:900},hasTouch:touch,colorScheme:theme,reducedMotion:"reduce"});
  await require("../fixtures/notebook-labs.cjs").profile(page);
  page.setDefaultTimeout(12000);
  await page.route(/^https?:/, r => r.abort());
  await page.goto(url);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]")[touch?"tap":"click"]();
  await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
  await page.evaluate(theme => {
    AtriumTheme.set({preset:theme,followSystem:false},{persist:false});
    globalThis.personalTestLinks=[];
    globalThis.open=(u,target,features)=>personalTestLinks.push({u,target,features});
  },theme);
  return page;
}

(async () => {
  if (shots) fs.mkdirSync(shots,{recursive:true});
  const browser = await chromium.launch({headless:true,...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"})});
  try {
    for (const theme of ["light","dark"]) {
      const page = await launch(browser,theme), errors = [];
      page.on("pageerror", e => errors.push(e.message));
      try {
        assert.ok(await page.evaluate(() => !globalThis.AtriumPalettePersonal));
        await page.evaluate(() => {
          globalThis.personalTestRuns = 0;
          AtriumKeymap.registerCommand({id:"tests.local-extension",title:"Local extension command",category:"Extensions",run:()=>{personalTestRuns++;}});
        });
        await menu(page,"file","preferences");
        const prefs = page.getByRole("dialog",{name:"Preferences"});
        await prefs.getByRole("button",{name:"Keyboard",exact:true}).click();
        const commands = prefs.getByRole("combobox",{name:"Command",exact:true}), aliases = prefs.getByRole("textbox",{name:"Aliases",exact:true});
        await commands.selectOption("cmd:grid");
        await aliases.fill("dot toggle");
        await prefs.getByRole("button",{name:"Save aliases"}).click();
        await commands.selectOption("cmd:undo");
        await aliases.fill("dot toggle");
        await prefs.getByRole("button",{name:"Save aliases"}).click();
        await prefs.getByText("dot toggle already belongs to another command.",{exact:true}).waitFor();
        await commands.selectOption("cmd:grid");
        assert.equal(await aliases.inputValue(),"dot toggle");

        await prefs.getByRole("textbox",{name:"Name",exact:true}).fill("Supplier");
        await prefs.getByRole("textbox",{name:"URL template",exact:true}).fill("https://example.test/find?q={query}");
        await prefs.getByRole("button",{name:"Save quicklink",exact:true}).click();
        await prefs.getByRole("button",{name:"Edit Supplier",exact:true}).waitFor();
        if (shots) await page.screenshot({path:path.join(shots,"search-preferences-"+theme+".png"),animations:"disabled"});

        await prefs.getByRole("button",{name:"Edit shortcut…"}).click();
        const keys = page.getByRole("dialog",{name:"Keyboard shortcuts editor"});
        const grid = keys.locator('tr[data-command="grid"]');
        await grid.getByRole("button",{name:/Add a key/}).click();
        await page.keyboard.press("Control+Alt+Shift+G");
        await page.keyboard.press("Enter");
        assert.ok(await page.evaluate(()=>AtriumKeymap.bindingsFor("grid").some(b=>b.source==="user"&&b.key.endsWith("+G"))));
        await keys.getByRole("button",{name:"Done"}).click();

        await menu(page,"file","preferences");
        await prefs.getByRole("button",{name:"Keyboard",exact:true}).click();
        await commands.selectOption("cmd:tests.local-extension");
        await aliases.fill("local-probe-command");
        await prefs.getByRole("button",{name:"Save aliases"}).click();
        await prefs.getByRole("button",{name:"Edit shortcut…"}).click();
        const extension = keys.locator('tr[data-command="tests.local-extension"]');
        await extension.getByRole("button",{name:/Add a key/}).click();
        await page.keyboard.press("Control+Alt+Shift+G");
        await page.keyboard.press("Enter");
        await keys.getByRole("status").filter({hasText:"in the same context"}).waitFor();
        await extension.getByRole("button",{name:/Change/}).click();
        await page.keyboard.press("Control+Alt+Shift+Y");
        await page.keyboard.press("Enter");
        await keys.getByRole("button",{name:"Done"}).click();
        const extAlias = await palette(page,"local-probe-command");
        await choose(extAlias.panel,"Local extension command");
        assert.equal(await page.evaluate(()=>personalTestRuns),1);

        await menu(page,"file","preferences");
        await prefs.getByRole("button",{name:"Keyboard",exact:true}).click();
        await commands.selectOption("power:GND");
        await aliases.fill("earth-zero");
        await prefs.getByRole("button",{name:"Save aliases"}).click();
        await prefs.getByRole("button",{name:"Edit shortcut…"}).click();
        const ground = keys.locator('tr[data-command="power:GND"]');
        await ground.getByRole("button",{name:/Add a key/}).click();
        await page.keyboard.press("Control+Alt+Shift+J");
        await page.keyboard.press("Enter");
        await keys.getByRole("button",{name:"Done"}).click();
        await page.evaluate(() => AtriumKeymap.unregisterCommand("power:GND"));
        await page.waitForFunction(() => !!AtriumKeymap.command("power:GND"));
        await page.locator('#document-tabs [data-kind="schematic"]:visible').first().click();
        const earth = await palette(page,"earth-zero");
        assert.equal(await earth.panel.getByRole("option").filter({hasText:"Place Power Port: GND"}).count(),1);
        await earth.input.press("Escape");
        await page.keyboard.press("Control+Alt+Shift+J");
        await page.waitForFunction(()=>AtriumNavHost.tool()==="sch-place" && AtriumSchPlace.power().text==="GND");
        await page.keyboard.press("Escape");

        const alias = await palette(page,"dot toggle");
        await alias.panel.getByRole("option").filter({hasText:/grid/i}).first().hover();
        await alias.input.press("Meta+k");
        await alias.panel.getByRole("menuitem",{name:"Set aliases…",exact:true}).click();
        await alias.panel.getByRole("textbox",{name:"Aliases",exact:true}).fill("dot toggle, wafer-grid");
        await alias.panel.getByRole("button",{name:"Save aliases",exact:true}).click();
        await alias.panel.waitFor({state:"hidden"});
        assert.deepEqual(await page.evaluate(()=>AtriumPalettePersonal.aliases("cmd:grid")),["dot toggle","wafer-grid"]);
        const quick = await palette(page,"Supplier");
        await choose(quick.panel,"Supplier");
        assert.equal(await page.evaluate(()=>personalTestLinks.length),0);
        const query = "10 kΩ & C=3#✦/Q";
        await quick.panel.getByRole("textbox",{name:"Search text"}).fill(query);
        if (shots) await page.screenshot({path:path.join(shots,"quicklink-"+theme+".png"),animations:"disabled"});
        await quick.panel.getByRole("button",{name:"Open",exact:true}).click();
        assert.equal(await page.evaluate(()=>personalTestLinks[0]?.u),"https://example.test/find?q="+encodeURIComponent(query));

        for (const kind of ["schematic","pcb"]) {
          await page.locator('#document-tabs [data-kind="'+kind+'"]:visible').first().click();
          const ran = await page.evaluate(()=>personalTestRuns);
          await page.keyboard.press("Control+Alt+Shift+Y");
          assert.equal(await page.evaluate(()=>personalTestRuns),ran+1,"the extension hotkey works from both editors");
          const before = await page.evaluate(()=>{
            const h = AtriumNavHost, part = h.doc().items.find(i=>i.kind==="part");
            h.select([part.id]); return {count:h.doc().items.length,ref:part.ref};
          });
          await menu(page,"edit","copy");
          await page.waitForFunction(k=>globalThis.AtriumClipHistory?.list().some(e=>e.kind===k),kind);
          const history = await palette(page,before.ref);
          const clip = history.panel.getByRole("option").filter({hasText:before.ref}).filter({hasText:/part/i}).first();
          await clip.waitFor();
          await history.input.fill("Save Selection as Snippet");
          await choose(history.panel,"Save Selection as Snippet");
          await history.panel.getByRole("textbox",{name:"Snippet name"}).fill("Probe assembly");
          await history.panel.getByRole("button",{name:"Save",exact:true}).click();
          await history.panel.waitFor({state:"hidden"});
          assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.length),before.count);

          const named = await palette(page,"Probe assembly");
          const row = named.panel.getByRole("option").filter({hasText:"Probe assembly"}).first();
          await row.hover();
          const image = named.panel.locator('img[src^="data:image/png;base64,"]');
          await image.waitFor();
          assert.ok(await image.evaluate(n=>n.naturalWidth >= 256));
          if (shots && kind === "schematic") await page.screenshot({path:path.join(shots,"snippet-"+theme+".png"),animations:"disabled"});
          await row.click();
          await page.waitForFunction(count=>AtriumNavHost.doc().items.length===count+1,before.count);
          await menu(page,"edit","undo");
          await page.waitForFunction(count=>AtriumNavHost.doc().items.length===count,before.count);
        }
        const fallback = await palette(page,"QZ908271XC4VV2ZK789LZQ");
        await fallback.panel.getByRole("option").filter({hasText:"Search Extension Providers"}).first().waitFor();
        await choose(fallback.panel,"Create Text");
        assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.at(-1).text),"QZ908271XC4VV2ZK789LZQ");
        assert.deepEqual(errors,[]);
        console.log(theme,"Preferences, duplicate aliases, keymap, explicit quicklinks, clipboard preview, both snippet editors and one Undo");
      } finally {await page.close();}
    }
    const touch = await launch(browser,"dark",true);
    try {
      const file = touch.locator('.menubar [data-menu="file"]');
      await file.locator(":scope > summary").tap();
      await file.locator('[data-action="preferences"]').tap();
      const prefs = touch.getByRole("dialog",{name:"Preferences"});
      await prefs.getByRole("button",{name:"Keyboard",exact:true}).tap();
      await prefs.getByRole("textbox",{name:"Name",exact:true}).fill("Touch supplier");
      await prefs.getByRole("textbox",{name:"URL template",exact:true}).fill("https://example.test/?q={query}");
      const save = prefs.getByRole("button",{name:"Save quicklink",exact:true});
      assert.ok((await save.boundingBox()).height>=44);
      await save.tap();
      await prefs.getByRole("button",{name:"Close Preferences",exact:true}).tap();
      await prefs.waitFor({state:"hidden"});
      await touch.locator('.work-menu[data-menu="view"] > summary').tap(); await touch.locator('.work-menu[data-menu="view"] [data-action="search"]').tap();
      const panel = touch.locator("#palette");
      await panel.getByRole("combobox").fill("Touch supplier");
      await panel.getByRole("option").filter({hasText:"Touch supplier"}).first().tap();
      const field = panel.getByRole("textbox",{name:"Search text"});
      if (!await field.isVisible()) await panel.getByRole("button",{name:/^(Run|Open)$/}).tap();
      await field.fill("tap & confirm");
      await panel.getByRole("button",{name:"Open",exact:true}).tap();
      assert.equal(await touch.evaluate(()=>personalTestLinks[0]?.u),"https://example.test/?q=tap%20%26%20confirm");
      console.log("touch Preferences targets and quicklink confirmation");
    } finally {await touch.close();}
  } finally {await browser.close();}
})().catch(error => {console.error(error);process.exitCode=1;});
