"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {createStaticServer} = require("../support/browser-app-server.cjs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");

const app = path.resolve(process.argv[2] || path.join(__dirname,"../../app"));
// canvas-input.js is the shared touch recogniser (pan, tap, hold, move) and loads for every profile.
const notebookScript = /^(?:touch-precision|notebook[-.]|rich-text|math[-.]|review-notes|calculations?[-.]|sheet-widget|extension-palette|extension-widget|extension-notebook-host|widget-catalogue|widget-fallback|palette-personal|palette-actions|palette-view|search-index)/;
const sharedRuleScripts = new Set(["calculation-core.js","calculation-intent.js","note-fields.js"]);
const ruleQueryScript = /^(?:design-query|query-fields|query-field-ui|query-exchange)/;
const notebookRuntime = script => notebookScript.test(script) && !sharedRuleScripts.has(script);
const origin = url => new URL(url).pathname.split("/").at(-1);

async function blankEditor(browser,url) {
  const page=await browser.newPage(), scripts=new Set(), workers=[];
  try {
    page.on("request",r=>{if(r.resourceType()==="script")scripts.add(origin(r.url()));});
    page.on("worker",worker=>workers.push(worker.url()));
    await page.clock.install();
    await page.goto(url);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await page.waitForFunction(()=>globalThis.AtriumChecks?.scheduler?.host());
    await page.clock.runFor(1200);
    assert.equal(await page.evaluate(()=>AtriumNavHost.project().documents.every(doc=>doc.items.length===0)),true);
    assert.deepEqual([...scripts].filter(s=>ruleQueryScript.test(s) || sharedRuleScripts.has(s)),[],
      "an unused blank editor issues no rule or scalar compiler request");
    assert.equal(workers.length,0);

    const label=await page.evaluate(()=>{
      const host=AtriumNavHost, doc=host.doc(), row={id:Atrium.id(),kind:"netlabel",x:15,y:15,text:"Isolated"};
      host.edit(()=>doc.items.push(row),"Place net label",[row]);return row.id;
    });
    await page.waitForFunction(id=>globalThis.AtriumChecks?.live().result?.messages.some(m=>m.objectId===id),label);
    await page.evaluate(id=>{
      globalThis.testERCBeforeRemoval=AtriumChecks.live().result;
      AtriumNavHost.select([id],id);AtriumNavHost.act("delete");
    },label);
    await page.waitForFunction(id=>{
      const result=AtriumChecks.live().result;
      return AtriumNavHost.doc().items.length===0 && result && result!==testERCBeforeRemoval && !result.messages.some(m=>m.objectId===id);
    },label);
    console.log("Blank editor defers compiler loading; the first edit runs ERC and the last deletion clears its findings");
  } finally {await page.close();}
}

async function run(browser,url,oldProfile) {
  const context = await browser.newContext({hasTouch:true,viewport:{width:1360,height:900}});
  const page = await context.newPage(), scripts = new Set(), workers = [], errors = [];
  page.setDefaultTimeout(10000);
  page.on("request",r => {if(r.resourceType()==="script")scripts.add(origin(r.url()));});
  page.on("worker", w => workers.push(w.url()));
  page.on("pageerror", e => errors.push(e.message));
  if (oldProfile) await context.addInitScript(() => {
    if (localStorage.getItem("atrium.prefs")) return;
    localStorage.setItem("atrium.prefs",JSON.stringify({format:"atrium-prefs",version:1,values:{"general.units":"mil"}}));
    localStorage.setItem("atrium-keymap-v1",JSON.stringify({format:"atrium-keys",version:1,bindings:{"menu:retired-palette-row":[{key:"Ctrl+Alt+Shift+F"}]}}));
  });
  async function prefs() {
    const file=page.locator(".menubar [data-menu=file]");
    await file.locator(":scope > summary").click();
    await file.locator('[data-action="preferences"]').click();
    const dialog=page.getByRole("dialog",{name:"Preferences"});
    await dialog.getByRole("button",{name:"Experimental features",exact:true}).click();
    const close=async()=>{
      await dialog.getByRole("button",{name:"Close Preferences",exact:true}).click();
      await dialog.waitFor({state:"hidden"});
    };
    return {close,box:dialog.getByRole("switch",{name:"Enable notebook features",exact:true})};
  }
  try {
    await page.clock.install();
    await page.goto(url);
    await page.locator("dialog.sp-dialog[open]").waitFor();
    await page.clock.runFor(700);
    assert.equal(scripts.has("extensions.js"),false,"Welcome keeps the extension runtime dormant on clean and migrated profiles");
    assert.deepEqual([...scripts].filter(s=>notebookScript.test(s) || sharedRuleScripts.has(s) || ruleQueryScript.test(s)),[],
      "Home does not fetch Notebook modules, the native rule record or any rule query compiler and scalar modules");
    assert.equal(workers.length,0);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    await page.waitForFunction(()=>globalThis.AtriumCamera && globalThis.AtriumEditorDemand && globalThis.AtriumExtensions?.attached);
    const canvas = page.locator("#canvas"), c = await canvas.boundingBox();
    const camera = () => page.evaluate(()=>AtriumNavHost.view().camera());
    const beforeWheel = await camera();
    await page.mouse.move(c.x+c.width/2,c.y+c.height/2);
    await page.mouse.wheel(0,-120);
    await page.waitForFunction(scale=>AtriumNavHost.view().scale()>scale,beforeWheel.scale);
    const beforeTouch = await camera(), cdp = await page.context().newCDPSession(page);
    // A finger on a part would move it; pan from blank board space.
    const blank = await page.evaluate(()=>{
      const h=AtriumNavHost,canvas=h.canvas(),r=canvas.getBoundingClientRect();
      for (let y=r.height/2; y<r.height-40; y+=17) for (let x=r.width/2; x>40; x-=17)
        if ([0,24,48,72].every(dx=>!h.hit(canvas,r.left+x+dx,r.top+y)?.item)) return [r.left+x,r.top+y];
      return null;
    });
    assert.ok(blank,"blank board space to pan from");
    const send = (type,dx=0) => cdp.send("Input.dispatchTouchEvent",{type,touchPoints:type==="touchEnd" ? [] :
      [{x:blank[0]+dx,y:blank[1],id:1}]});
    await send("touchStart"); await send("touchMove",72); await send("touchEnd");
    await page.waitForFunction(x=>Math.abs(AtriumNavHost.view().camera().cx-x)>0.1,beforeTouch.cx);
    assert.deepEqual([...scripts].filter(notebookRuntime),[],"the active board's rules, wheel and direct touch keep Notebook-specific code dormant");
    assert.equal(workers.length,0);
    assert.equal(await page.evaluate(()=>AtriumLabs.notebookEnabled()),false);
    if (oldProfile) assert.equal(await page.evaluate(()=>AtriumPref.get("general.units")),"mil");
    assert.equal(scripts.has("paste-plan.js"),false);
    const parts = await page.evaluate(()=>{
      const host=AtriumNavHost, items=host.doc().items.filter(item=>item.kind==="part");
      host.select([items[0].id]);host.act("duplicate");
      return items.length;
    });
    await page.waitForFunction(()=>AtriumNavHost.tool()==="paste");
    assert.equal(scripts.has("paste-plan.js"),true);
    await canvas.click({position:{x:c.width*.55,y:c.height*.6}});
    await page.waitForFunction(n=>AtriumNavHost.doc().items.filter(i=>i.kind==="part").length===n+1,parts);
    await page.evaluate(()=>AtriumNavHost.act("undo"));
    await page.waitForFunction(n=>AtriumNavHost.doc().items.filter(i=>i.kind==="part").length===n,parts);
    assert.deepEqual([...scripts].filter(s=>notebookScript.test(s)),[],"ordinary placement also stays within the Preview feature boundary");

    await page.evaluate(()=>AtriumNavHost.act("drc"));
    await page.waitForFunction(()=>/rule violation/i.test(document.getElementById("status").textContent));
    assert.ok(scripts.has("design-query-record.js") && !scripts.has("design-query.js"),"stock rules need only the native rule records");
    await page.evaluate(()=>{
      const host = AtriumNavHost, doc = host.doc(), project = host.project(), rules = AtriumRules.effective(doc, project);
      const width = rules.list.find(rule=>rule.type==="width");
      Object.assign(width,{name:"Scoped trace width",min:2,preferred:2,max:3,
        scope:AtriumDesignQueryRecord.create("track where width < 2 mm")});
      host.edit(()=>AtriumRules.store(doc, project, rules),"Set a native width rule");
      host.act("drc");
    });
    await page.waitForFunction(()=>AtriumChecks.violations({source:"drc",scope:AtriumNavHost.currentId()})
      .some(finding=>finding.ruleName==="Scoped trace width"));
    assert.ok(scripts.has("design-query.js"),"a scoped DRC finding uses the lazily loaded compiler");
    assert.deepEqual([...scripts].filter(notebookRuntime),[],"explicit native DRC uses its own rules without starting Notebook runtime");
    const drcWorkers=workers.length;

    const on = await prefs();
    assert.equal(await on.box.isChecked(),false);
    await on.box.check(); await on.close();
    assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem("atrium.prefs")).values["labs.notebook"]),true);
    await page.locator('#document-tabs [data-kind="schematic"]:visible').first().click();
    await page.waitForFunction(()=>AtriumNavHost.doc().kind==="schematic");
    await page.evaluate(()=>AtriumNavHost.act("sch-calculation"));
    const composer = page.getByRole("dialog",{name:"Place calculation"});
    const formula = composer.getByRole("textbox",{name:"Expression",exact:true});
    await formula.fill("2 + 2");
    assert.deepEqual(await page.evaluate(()=>{
      try {AtriumPrefs.set("labs.notebook",false);}
      catch {return [AtriumPrefs.get("labs.notebook"),AtriumLabs.notebookSignal().aborted];}
      return [];
    }),[true,false]);
    assert.equal(await formula.inputValue(),"2 + 2");
    await composer.getByRole("button",{name:"Insert calculation",exact:true}).click();
    await page.waitForFunction(()=>AtriumNavHost.doc().items.some(row=>row.calculation && row.text==="2 + 2"));
    const point = await page.evaluate(()=>{
      const host=AtriumNavHost,row=host.doc().items.find(row=>row.calculation && row.text==="2 + 2");
      const c=host.canvas().getBoundingClientRect(),[x,y]=host.view().worldToScreen([row.x+row.w/2,row.y+row.h/2]);
      return {x:c.left+x,y:c.top+y,cold:!globalThis.AtriumTouchPrecision};
    });
    assert.equal(point.cold,true,"ordinary mouse editing starts with the precision touch code still cold");
    await page.mouse.dblclick(point.x,point.y);
    const editing=page.getByRole("dialog",{name:"Edit calculation"});
    assert.equal(await editing.getByRole("textbox",{name:"Expression",exact:true}).inputValue(),"2 + 2");
    await editing.getByRole("button",{name:"Cancel",exact:true}).click();
    // The native close event also restores the previously focused editor control.
    await page.locator('dialog.calculation-dialog[aria-label="Edit calculation"]').waitFor({state:"detached"});
    const saved = await page.evaluate(()=>{
      globalThis.testNotebookEpoch=AtriumLabs.notebookSignal();
      return JSON.stringify(AtriumNavHost.doc().items.find(row=>row.calculation && row.text==="2 + 2"));
    });

    const off = await prefs();
    await off.box.uncheck(); await off.close();
    assert.deepEqual(await page.evaluate(()=>{
      const host=AtriumNavHost,item=host.doc().items.find(row=>row.calculation && row.text==="2 + 2");
      const direct=AtriumCalculationSheet.compose(host,item);
      host.edit(()=>{item.text="Different text";},"Try a direct edit",[item]);
      return [JSON.stringify(host.doc().items.find(row=>row.id===item.id)),testNotebookEpoch.aborted,direct];
    }),[saved,true,false]);
    const sheetName=await page.evaluate(()=>AtriumNavHost.doc().name);
    await page.evaluate(()=>AtriumNavHost.act("print"));
    const print = page.getByRole("dialog",{name:"Print",exact:true});
    await print.getByRole("button",{name:"Current document",exact:true}).click();
    await print.locator(".print-thumb").filter({hasText:sheetName}).first().waitFor();
    assert.equal(await print.getByText("Attach portable project ZIP").count(),0);
    assert.equal(await print.getByLabel("Links and bookmarks (Smart PDF)").isVisible(),true);
    await print.getByRole("button",{name:"Close",exact:true}).click();
    await page.reload();
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.doc?.());
    assert.equal(await page.evaluate(()=>AtriumLabs.notebookEnabled()),false);
    assert.deepEqual(errors,[]);
    console.log("Preview Labs",oldProfile?"existing profile":"fresh profile",new URL(url).protocol,
      "keeps basic input and printing, preserves a live draft, guards direct edits, idle workers 0, after DRC",drcWorkers);
  } finally {await context.close();}
}

async function formalProfile(browser,url) {
  const page=await browser.newPage();
  try {
    // Exercise the formal packaging profile with a real old Preview "off" preference.
    await page.addInitScript(()=>localStorage.setItem("atrium.prefs",JSON.stringify({format:"atrium-prefs",version:1,values:{"labs.notebook":false}})));
    await page.route(url,route=>route.fulfill({contentType:"text/html",body:fs.readFileSync(path.join(app,"index.html"),"utf8")
      .replace(/\bdata-release="[^"]+"/,'data-release="apricot"')}));
    await page.goto(url);
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.doc?.());
    assert.deepEqual(await page.evaluate(async()=>{
      const prefs=await AtriumLazy.need("AtriumPrefs");
      prefs.set("labs.notebook",false);
      return [AtriumLabs.notebookEnabled(),AtriumLabs.notebookSignal().aborted,
        document.documentElement.hasAttribute("data-notebook-labs"),prefs.pages().some(p=>p.id==="labs")];
    }),[true,false,true,false]);
    console.log("Formal Apricot enables Notebook despite a saved Preview off setting");
  } finally {await page.close();}
}

async function main() {
  const mime = file => file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : file.endsWith(".html") ? "text/html" : "application/octet-stream";
  const server = createStaticServer({root: app, mime, missing: "status"});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const browser=await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"});
  try {
    const host="http://127.0.0.1:"+server.address().port;
    const file=pathToFileURL(path.join(app,"index.html")).href;
    await blankEditor(browser,file);
    await run(browser,file,false);
    await run(browser,host+"/index.html",true);
    await formalProfile(browser,host+"/index.html?formal=1");
  } finally {await browser.close(); server.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
