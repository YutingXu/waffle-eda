"use strict";
const assert=require("node:assert/strict");
const {EventEmitter,once}=require("node:events");
const serveApp=require("../support/browser-app-server.cjs");

async function emptyStockBrowse(browser,url) {
  const page=await browser.newPage();
  page.setDefaultTimeout(7000);
  try {
    await page.goto(url);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await page.evaluate(async()=>{
      const h=AtriumNavHost;
      await h.replaceProject(Atrium.project("Empty palette fixture",[]),{force:true,dirty:false});
      await AtriumLazy.need("AtriumPalette");
      const index=await AtriumLazy.need("AtriumSearchIndex"), runIdle=index.runIdle;
      // Let the real index build, but hold the completion notification for the open view.
      index.runIdle=(gen,done,progress)=>runIdle(gen,stats=>{
        globalThis.finishPaletteIndex=()=>{index.runIdle=runIdle;done(stats);};
      },progress);
      h.act("goto-object");
    });
    const dialog=page.locator("#palette[open]"), empty=dialog.locator(".nav-palette-empty");
    await empty.filter({hasText:/^Searching…$/}).waitFor();
    await page.waitForFunction(()=>typeof globalThis.finishPaletteIndex==="function");
    await page.evaluate(()=>finishPaletteIndex());
    await empty.filter({hasText:/^No matching designator, net or pad\.$/}).waitFor();
    await page.evaluate(()=>{
      const h=AtriumNavHost,doc=h.doc();
      const label={id:"palette-fixture",kind:"netlabel",x:10,y:10,text:"FixtureNet"};
      h.edit(()=>doc.items.push(label),"Add fixture net",[label]);
    });
    await dialog.locator(".nav-palette-label").filter({hasText:/^FixtureNet$/}).waitFor();
    await page.evaluate(()=>{
      const h=AtriumNavHost,label=h.doc().items.find(item=>item.id==="palette-fixture");
      h.edit(()=>{label.text="RenamedFixtureNet";},"Rename fixture net",[label]);
    });
    await dialog.locator(".nav-palette-label").filter({hasText:/^RenamedFixtureNet$/}).waitFor();
    assert.equal(await dialog.locator(".nav-palette-label").filter({hasText:/^FixtureNet$/}).count(),0);
  } finally {await page.close();}
}

// A fresh profile exercises the Preview baseline and later the same editor's opt-in.
module.exports=async function paletteLabs(browser) {
  const page=await browser.newPage(), scripts=new Set(), errors=[];
  const timeout=7000, requests=new EventEmitter(), held=Promise.withResolvers(), searchData=Promise.withResolvers();
  const server=await serveApp({cacheControl:"no-store",beforeRead(pathname) {
    scripts.add(pathname.split("/").pop());
    if (pathname === "/editor/palette.js") {
      requests.emit("palette");
      return held.promise;
    }
    if (pathname === "/search-data.js") return searchData.promise;
  }});
  page.setDefaultTimeout(timeout);
  page.on("pageerror",e=>errors.push(e.message));
  try {
    await page.goto(server.url);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    assert.equal(await page.evaluate(()=>AtriumLabs.notebookEnabled()),false);
    const canvas=page.locator("#canvas"), dialog=page.locator("#palette"), box=dialog.getByRole("combobox");
    const place=page.locator('.work-menu[data-menu="place"]'), insert=place.locator('[data-action="insert-palette"]');
    const placeSummary=place.locator(":scope > summary");
    await placeSummary.click();
    assert.equal(await insert.isVisible(),false,"Preview hides the Insert placement when Labs is off");
    await placeSummary.click();
    assert.equal(await page.evaluate(()=>{
      window.dispatchEvent(new CustomEvent("atrium-command",{detail:"insert-palette"}));
      return document.getElementById("palette").open;
    }),false,"native editor dispatch still checks Labs");
    const scope=dialog.getByRole("button",{name:"Remove Commands scope",exact:true});
    const selected=dialog.locator('[role=option][aria-selected=true]'), labels=dialog.locator(".nav-palette-label");
    const redraws=await dialog.locator('[role="listbox"]').evaluateHandle(list=>{
      const probe={count:0,stop() {observer.disconnect();return probe.count;}};
      const observer=new MutationObserver(records=>{probe.count+=records.filter(record=>record.addedNodes.length).length;});
      observer.observe(list,{childList:true});
      return probe;
    });
    // / now searches everything with Labs off too (tests/editor/browser-search-keys.js); this cold check leaves the palette unloaded.
    assert.equal(await page.locator(".palette-insert-launch:visible").count(),0);
    for (const script of ["palette.js","search-index.js","palette-view.js","palette-actions.js","palette-personal.js","extension-notebook-host.js","extension-palette.js","extension-palette-declarations.js"]) assert.ok(!scripts.has(script),script+" stayed off cold Home and the ordinary canvas");
    try {
      const requested=once(requests,"palette",{signal:AbortSignal.timeout(timeout)}).catch(error=>{
        throw Error("The test server did not receive the cold palette script request after F1.",{cause:error});
      });
      await Promise.all([requested,page.keyboard.press("F1")]);
      assert.equal(await page.evaluate(()=>typeof AtriumPalette),"undefined");
      await scope.waitFor(); assert.equal(await box.inputValue(),"");
      await box.press("Backspace");
      assert.equal(await scope.isVisible(),false);
      assert.equal(await box.evaluate(node=>node===document.activeElement),true);
      await box.pressSequentially(">");
    } finally {held.resolve();}
    await selected.waitFor();
    await page.waitForFunction(()=>!!AtriumPalette.indexStats());
    searchData.resolve();
    await page.waitForFunction(()=>AtriumPalette.index().source("help").length>0);
    await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    assert.equal(await redraws.evaluate(probe=>probe.stop()),1,"loading unrelated sources leaves the stock command browse in place");
    await redraws.dispose();
    assert.equal(await box.inputValue(),""); assert.ok(await scope.isVisible());
    assert.equal(await dialog.locator(".nav-palette-preview-content").count(),1);
    assert.equal(await dialog.evaluate(d=>d.classList.contains("ui-dialog")),true);
    await box.pressSequentially("pref"); await labels.filter({hasText:/preferences/i}).first().waitFor();
    await box.fill(">save");
    const fileGroup=dialog.getByRole("group",{name:"File",exact:true});
    await fileGroup.getByRole("option",{name:/^Save Project/}).waitFor();
    assert.equal(await fileGroup.count(),1);
    assert.ok(await fileGroup.getByRole("option").count()>1);
    await box.press("Escape");
    await page.keyboard.press("Control+Shift+P"); await selected.waitFor();
    await dialog.getByRole("button",{name:"Actions",exact:true}).click();
    await dialog.getByRole("menu",{name:"Actions",exact:true}).getByRole("menuitem").first().waitFor();
    await page.keyboard.press("Escape"); await box.press("Escape");
    await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click(); await selected.waitFor();
    assert.equal(await box.inputValue(),""); assert.equal(await scope.isVisible(),false);
    await box.pressSequentially(">");
    assert.equal(await box.inputValue(),""); assert.ok(await scope.isVisible());
    await box.press("Backspace");
    assert.equal(await scope.isVisible(),false);
    assert.equal(await box.evaluate(node=>node===document.activeElement),true);
    await box.fill(":10,20"); await selected.filter({hasText:/10.*20/}).waitFor();
    for (const script of ["palette-actions.js","palette-personal.js","extension-notebook-host.js","extension-palette.js","calculation-intent.js"]) assert.ok(!scripts.has(script),script+" stayed unloaded for search with Labs off");
    await box.press("Escape");
    // Install a real, locally packaged provider while off. It can emit a selected
    // row only after opt-in and its worker remains alive until the query is cancelled.
    await page.waitForFunction(()=>globalThis.AtriumExtensions?.attached);
    const installing = page.evaluate(()=>{
      const manifest={id:"test.labs-stream",name:"Labs stream fixture",apiVersion:1,version:"1.0.0",main:"main.js",
        permissions:["ui:command"],contributes:{searchProviders:[{id:"pending",name:"Pending work",module:"pending.js",command:"fixture.details",hosts:[]}]}};
      return AtriumExtensions.install({"waffle-extension.json":JSON.stringify(manifest),"main.js":"exports.activate=()=>{};",
        "pending.js":`exports.search=async({query},{signal,emit})=>{
          if(query!=="pending result")return;
          emit([{id:"running",label:"Notebook worker started"}]);
          await new Promise(done=>signal.addEventListener("abort",done,{once:true}));
          emit([{id:"late",label:"Stale notebook worker row"}]);
        };`}).then(e=>e.id);
    });
    await page.locator("dialog.ext-prompt[open]").getByRole("button",{name:"Install",exact:true}).click();
    assert.equal(await installing,"test.labs-stream");
    scripts.clear(); await page.reload();
    await page.waitForFunction(()=>globalThis.AtriumExtensions?.attached && AtriumExtensions.list().some(e=>e.id==="test.labs-stream"));
    const demo=page.locator("dialog.sp-dialog[open] [data-start-action=demo]");
    if (await demo.isVisible()) await demo.click();
    assert.ok(!scripts.has("extension-notebook-host.js"));
    assert.ok(!scripts.has("extension-palette-declarations.js"));
    const file = page.locator('.menubar [data-menu="file"]');
    await file.locator(":scope > summary").click();
    await file.locator('[data-action="preferences"]').click();
    const prefs = page.getByRole("dialog",{name:"Preferences"});
    await prefs.getByRole("button",{name:"Experimental features",exact:true}).click();
    const toggle = prefs.getByRole("switch",{name:"Enable notebook features",exact:true});
    assert.equal(await toggle.isChecked(),false);
    await toggle.click();
    await page.waitForFunction(()=>AtriumLabs.notebookEnabled() &&
      JSON.parse(localStorage.getItem("atrium.prefs"))?.values["labs.notebook"]===true);
    assert.equal(await toggle.isChecked(),true);
    await page.keyboard.press("Escape");
    await prefs.waitFor({state:"hidden"});
    await page.evaluate(async()=>{
      await AtriumLazy.need("AtriumKeymapPresets");
      AtriumKeymap.setPreset("classic");
      AtriumKeymap.setBindings("insert-palette",["Alt+F8"]);
    });
    await placeSummary.click();
    await insert.waitFor();
    assert.equal(await insert.evaluate(node=>AtriumNavCommon.menuLabel(node)),"Insert or Search…");
    assert.equal(await insert.locator(".ui-shortcut").getAttribute("data-binding"),"Alt+F8");
    const localized=await page.evaluate(async()=>{
      await AtriumI18n.setLocale("en-XA");
      const messages=AtriumI18n.catalogue("en-XA"), menu=document.querySelector('[data-action="insert-palette"]');
      const launcher=document.querySelector(".palette-insert-launch");
      return [AtriumNavCommon.menuLabel(menu)===messages["menu.insert_or_search_more"],launcher.getAttribute("aria-label")===messages["shell.insert_at_pointer"]];
    });
    assert.deepEqual(localized,[true,true],"menu and touch launcher keep their own translation keys");
    await page.evaluate(()=>AtriumI18n.setLocale("en"));
    await insert.click();
    await selected.waitFor();
    assert.equal(await dialog.getAttribute("data-mode"),"insert");
    await box.press("Escape");
    assert.deepEqual(await page.evaluate(()=>{
      const h=AtriumNavHost, before=JSON.stringify(h.project());
      const row=AtriumPalette.entries(">").find(e=>e.key==="cmd:insert-palette");
      return [row.action,row.label,row.hint,JSON.stringify(h.project())===before,!document.getElementById("palette").open];
    }),["insert-palette","Insert or Search…","Alt+F8",true,true]);
    await canvas.focus();
    await page.keyboard.press("Alt+F8");
    await selected.waitFor();
    assert.equal(await dialog.getAttribute("data-mode"),"insert");
    await box.press("Escape");
    await page.evaluate(()=>{AtriumKeymap.resetCommand("insert-palette"); AtriumKeymap.setPreset("altium");});
    await canvas.focus(); await page.keyboard.press("/"); await selected.waitFor();
    await box.fill("res 10k"); await selected.filter({hasText:/10 kΩ/i}).waitFor();
    const saved=await page.evaluate(()=>{
      window.labsRace={index:AtriumPalette.index(),epoch:AtriumLabs.notebookSignal(),calls:0};
      AtriumPrefs.set("search.commandAliases",{"cmd:drc":["my clearance shortcut"]});
      AtriumPalette.registerProvider("labs-race",{stream(req,emit){
        if (req.query!=="pending result") return;
        labsRace.signal=req.signal;
        return new Promise(done=>{labsRace.finish=()=>{emit([{key:"stale-opt-in",label:"stale opt-in",run(){labsRace.calls++;}}]); done();};});
      }});
      return [JSON.stringify(AtriumPrefs.get("search.commandAliases")),AtriumKeymap.exportJSON(),JSON.stringify(AtriumPrefs.get("search.usage"))];
    });
    await box.fill("pending result"); await page.waitForFunction(()=>!!window.labsRace.finish);
    await labels.filter({hasText:"Notebook worker started"}).waitFor();
    assert.ok(await page.evaluate(()=>AtriumExtensions.workers.some(w=>w.pool.startsWith("search:"))));
    const state=await page.evaluate(()=>{
      AtriumPrefs.set("labs.notebook",false); labsRace.finish();
      return [labsRace.epoch.aborted,labsRace.signal.aborted,!document.getElementById("palette").open,labsRace.index===AtriumPalette.index()];
    });
    assert.deepEqual(state,[true,true,true,true]);
    await page.waitForFunction(()=>!AtriumExtensions.workers.some(w=>w.pool.startsWith("search:")));
    await canvas.focus(); await page.keyboard.press("F1"); await selected.waitFor();
    assert.equal(await box.inputValue(),""); assert.ok(await scope.isVisible()); assert.equal(await dialog.locator(".nav-palette-config:visible").count(),0);
    assert.deepEqual(await page.evaluate(()=>[JSON.stringify(AtriumPrefs.get("search.commandAliases")),AtriumKeymap.exportJSON(),JSON.stringify(AtriumPrefs.get("search.usage"))]),saved);
    assert.equal(await page.evaluate(()=>labsRace.calls),0);
    await box.press("Escape");
    await page.reload();
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.doc?.());
    assert.equal(await page.evaluate(()=>AtriumLabs.notebookEnabled()),false);
    assert.deepEqual(errors,[]);
    await emptyStockBrowse(browser,server.url);
  } finally {held.resolve(); searchData.resolve(); await page.close(); await server.close();}
};
