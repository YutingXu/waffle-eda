"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {createStaticServer} = require("../support/browser-app-server.cjs");
const {chromium} = require("../support/playwright.cjs");
const root = process.env.WAFFLE_CALC_ROOT || path.resolve(__dirname,"../..");
const assets = process.env.WAFFLE_CALC_ASSETS;
async function run() {
  const server = createStaticServer({
    root,
    requireFile: true,
    mime: {".js":"text/javascript",".html":"text/html",".css":"text/css",".svg":"image/svg+xml",".png":"image/png"},
  });
  await new Promise(r=>server.listen(0,"127.0.0.1",r));
  const origin="http://127.0.0.1:"+server.address().port;
  const browser = await chromium.launch({channel:"chrome",headless:true});
  const rows=[];
  try {
    for (const theme of ["light","dark"]) {
      const context = await browser.newContext({viewport:{width:1240,height:790},permissions:["clipboard-read","clipboard-write"],
        reducedMotion:"reduce",hasTouch:true});
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      await page.addInitScript(()=>{globalThis.ATRIUM_UNDO_VERIFY="throw";});
      const errors=[]; page.on("pageerror",e=>errors.push(e.message));
      await require("../fixtures/notebook-labs.cjs").profile(page);
      await page.clock.install();
      await page.goto(origin+"/app/index.html");
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.waitForFunction(()=>globalThis.AtriumNavHost?.project()?.name);
      await page.evaluate(async t=>{
        await AtriumLazy.need(["AtriumUndoStore","AtriumTheme"]); AtriumTheme.setPreset(t);
        const defs=[{id:"resistor",name:"Resistor",prefix:"R",symbol:{pins:[],shapes:[{kind:"path",points:[[-4,-1.7],[4,-1.7],[4,1.7],[-4,1.7],[-4,-1.7]]}]}},
          {id:"capacitor",name:"Capacitor",prefix:"C",symbol:{pins:[],shapes:[{kind:"path",points:[[-2,-2],[-2,2]]},{kind:"path",points:[[2,-2],[2,2]]}]}}];
        const p=Atrium.project("Timing network",defs), d=p.documents[0];
        d.id="timing"; d.name="Analog timing"; p.documents=[d];
        d.items=[{id:"r5",def:"resistor",kind:"part",ref:"R5",value:"10k",x:22,y:28},
          {id:"c3",def:"capacitor",kind:"part",ref:"C3",value:"1n",x:48,y:28}];
        await AtriumNavHost.replaceProject(p,{force:true,dirty:false}); AtriumNavHost.selectDocument(d.id);
        AtriumNavHost.select(["r5"]); AtriumNavHost.view().restoreCamera({cx:41,cy:33,scale:5,referenceScale:5}); AtriumNavHost.redraw();
      },theme);
      const cold=await page.evaluate(()=>performance.getEntriesByType("resource").filter(e=>/\/calculation(?:s|-[\w-]+)\.js/.test(e.name)).length);
      assert.equal(cold,0,"ordinary schematic loaded calculation resources");
      const history=()=>page.evaluate(()=>AtriumNavHost.undoSteps().history.length);
      const value=()=>page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.id==="r5").value);
      const count=()=>page.evaluate(()=>AtriumNavHost.doc().items.filter(i=>i.calculation).length);
      const query=async (source,expected)=>{
        await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click();
        const input=page.locator("dialog[open] [role=combobox]").first(); await input.fill(source);
        await page.getByRole("option",{name:new RegExp(expected)}).first().waitFor();
        return input;
      };
      const shot=async label=>{if(assets){fs.mkdirSync(assets,{recursive:true});await page.screenshot({path:path.join(assets,label+"-"+theme+".png"),animations:"disabled"});}};
      const h0=await history(); const input=await query("3.3V/10mA","330");
      await input.press("Enter"); assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),"330 Ω");
      assert.equal(await history(),h0); assert.equal(await value(),"10k");
      const screen=await page.evaluate(()=>{const r=AtriumNavHost.canvas().getBoundingClientRect();return [r.left+r.width*.53,r.top+r.height*.52];});
      await page.mouse.move(...screen); await page.mouse.wheel(3.5,-19.5); await page.mouse.move(screen[0]+3,screen[1]+2);
      const point=await page.evaluate(()=>AtriumNavHost.palettePoint());
      const insert=await query("frequency = 1/(2*pi*R5*C3)","15.92");
      await insert.press("Alt+Enter"); await page.waitForFunction(()=>AtriumNavHost.doc().items.some(i=>i.calculation));
      assert.equal(await history(),h0+1);
      const block=await page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.calculation).id);
      const coords=await page.evaluate(id=>{const i=AtriumNavHost.doc().items.find(x=>x.id===id);return [i.x,i.y];},block);
      assert.ok(point.every((n,k)=>Math.abs(n-coords[k])<1e-6),"placed at captured sheet location after scrolling");
      await page.getByRole("button",{name:"Edit calculation"}).waitFor();
      await page.waitForFunction(()=>document.querySelector('.calculation-inspector output')?.textContent==="15.92 kHz");
      const chip=page.locator(".calculation-inspector .calculation-inputs details").filter({has:page.locator("summary",{hasText:"R5"})}).first();
      await chip.locator("summary").tap();
      await chip.getByRole("button",{name:"Go to source"}).waitFor();
      assert.match(await chip.locator(".calculation-input-detail").innerText(),/10k/);
      await chip.locator("summary").tap();assert.ok(!(await chip.evaluate(e=>e.open)));
      const tip=await chip.locator("summary").boundingBox(), contacts=await context.newCDPSession(page);
      await contacts.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x:tip.x+tip.width/2,y:tip.y+tip.height/2}]});
      await chip.getByRole("button",{name:"Go to source"}).waitFor();
      await page.clock.runFor(500);
      await contacts.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
      if (await chip.evaluate(e=>e.open)) await chip.locator("summary").tap();
      await page.evaluate(id=>{const h=AtriumNavHost,i=h.doc().items.find(x=>x.id===id);h.zoomTo([i.x-15,i.y-13,i.x+i.w+15,i.y+i.h+13]);},block);
      await shot("sheet");
      await page.getByRole("button",{name:"Edit calculation"}).click();
      const dlg=page.getByRole("dialog",{name:"Edit calculation",exact:true});
      await dlg.getByRole("button",{name:"Add assertion"}).click();
      await dlg.getByLabel("Assertion",{exact:true}).fill("assert frequency > 10 kHz");
      await dlg.getByRole("button",{name:"Save calculation"}).click();
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.calculation).calculation.assertions.length===1);
      assert.equal(await history(),h0+2);
      const frozen=await page.evaluate(id=>{const h=AtriumNavHost;return AtriumCalculations.evaluateSnapshot(h.project(),{documentId:h.doc().id,blockId:id,revision:h.revision()}).records[0];},block);
      assert.equal(frozen.result.display,"15.92 kHz");assert.equal(frozen.assertions[0].result.assertion.status,"pass");
      await page.evaluate(()=>AtriumNavHost.act("undo")); await page.waitForFunction(()=>!AtriumNavHost.doc().items.find(i=>i.calculation)?.calculation.assertions.length);
      await page.evaluate(()=>AtriumNavHost.act("redo")); await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.calculation).calculation.assertions.length===1);
      await page.evaluate(()=>AtriumNavHost.select(["r5"]));
      const before=await history(), apply=await query("3.3V/10mA","330");
      await apply.press("Shift+Enter"); const proposal=page.getByRole("dialog",{name:"Apply calculation to R5"});
      await proposal.waitFor(); assert.equal(await history(),before); assert.equal(await value(),"10k");
      await proposal.getByLabel("Preferred value").selectOption("E24");
      await proposal.getByText("E24 preferred value",{exact:true}).waitFor(); await shot("apply");
      await proposal.getByRole("button",{name:"Apply value"}).tap();
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.id==="r5").value==="330 Ω");
      assert.equal(await history(),before+1);
      await page.evaluate(()=>AtriumNavHost.act("undo")); assert.equal(await value(),"10k");
      await page.evaluate(()=>AtriumNavHost.act("redo")); assert.equal(await value(),"330 Ω");
      const again=await query("1kΩ","1 kΩ"); await again.press("Shift+Enter");
      await proposal.waitFor(); await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.id==="r5"); h.edit(()=>{i.value="470";},"External value edit",[i]);});
      await proposal.getByRole("button",{name:"Review current selection"}).waitFor(); assert.ok(await proposal.getByRole("button",{name:"Apply value"}).isDisabled());
      await proposal.getByRole("button",{name:"Review current selection"}).click(); await proposal.getByText(/current Value 470/).waitFor();
      await proposal.getByRole("button",{name:"Cancel"}).click(); assert.equal(await value(),"470");
      await query("1kΩ","1 kΩ");
      const panel = page.locator("dialog[open]").first();
      await panel.getByRole("button",{name:"Actions",exact:true}).click();
      const menu = panel.getByRole("menu",{name:"Actions",exact:true});
      const insertion = menu.getByRole("menuitem",{name:"Insert Calculation",exact:true});
      await insertion.waitFor(); await shot("actions");
      assert.ok(await menu.getByRole("menuitem",{name:"Copy Result",exact:true}).isVisible());
      assert.ok(await menu.getByRole("menuitem",{name:"Set Selected Part Value…",exact:true}).isVisible());
      const position = await insertion.boundingBox(), cdp = await context.newCDPSession(page);
      const pen = {x:position.x+position.width/2,y:position.y+position.height/2,pointerType:"pen",button:"left",clickCount:1};
      await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",...pen,buttons:1});
      await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",...pen,buttons:0});
      await page.waitForFunction(()=>AtriumNavHost.doc().items.filter(i=>i.calculation).length===2);
      await page.evaluate(()=>AtriumNavHost.act("undo")); assert.equal(await count(),1);
      await page.evaluate(id=>{
        const h=AtriumNavHost,d=h.doc(),old=d.items.find(i=>i.id==="r5"),replacement={...old,id:"new-r5",value:"2k"};
        h.edit(()=>{d.items[d.items.indexOf(old)]=replacement;},"Replace target with same designator",[old,replacement]);
        h.select([id],id);
      },block);
      const target=()=>page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.calculation).calculation.bindings.find(b=>b.name==="R5").target.itemId);
      assert.equal(await target(),"r5");
      await page.getByRole("button",{name:"Edit calculation"}).click();
      const broken=page.getByRole("dialog",{name:"Edit calculation",exact:true});
      const reference=broken.locator(".calculation-references details").filter({has:page.locator("summary",{hasText:"R5"})});
      await reference.locator("summary").click();
      await reference.getByRole("searchbox").fill("R5.Value");
      await reference.getByRole("button",{name:/R5\.Value/i}).first().click();
      await broken.getByRole("button",{name:"Save calculation"}).click();
      await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.calculation).calculation.bindings.find(b=>b.name==="R5").target.itemId==="new-r5");
      await page.waitForFunction(()=>document.querySelector(".calculation-inspector output")?.textContent==="79.58 kHz");
      await page.evaluate(()=>AtriumNavHost.act("undo")); assert.equal(await target(),"r5");
      await page.evaluate(()=>AtriumNavHost.act("redo")); assert.equal(await target(),"new-r5");
      await page.evaluate(()=>{AtriumNavHost.select(["new-r5"]);AtriumNavHost.act("sch-calculation");});
      const place=page.getByRole("dialog",{name:"Place calculation",exact:true});
      await place.getByRole("button",{name:"Insert R5",exact:true}).tap();
      assert.equal(await place.getByLabel("Expression",{exact:true}).inputValue(),"R5");
      await place.getByRole("button",{name:"Insert calculation",exact:true}).click();
      await page.waitForFunction(()=>AtriumNavHost.doc().items.some(i=>i.calculation && i.text==="R5" && i.calculation.bindings[0].target.itemId==="new-r5"));
      await page.evaluate(()=>AtriumNavHost.act("undo")); assert.equal(await count(),1);
      const metrics=await page.evaluate(()=>{
        const t=performance.now(),h=AtriumNavHost,item=h.doc().items.find(i=>i.calculation),times=[];
        for(let i=0;i<30;i++){const start=performance.now();AtriumCalculationRecords.frozen(h.project(),h.doc(),h.revision());times.push(performance.now()-start);}
        times.sort((a,b)=>a-b);return {samples:times.length,frozenP95ms:times[Math.ceil(times.length*.95)-1],elapsedMs:performance.now()-t,
          workers:AtriumCalculations.stats(),coldCalculationScripts:0,undo:AtriumUndoStore.stats(),source:item.text};
      });
      assert.ok(metrics.undo.verified>0); assert.equal(metrics.undo.missed,0); assert.equal(metrics.undo.mismatch,0);
      assert.equal(await count(),1); assert.deepEqual(errors,[]);rows.push({theme,...metrics});await context.close();
    }
    if(assets)fs.writeFileSync(path.join(assets,"browser-measurements.json"),JSON.stringify(rows,null,2)+"\n");
    console.log(JSON.stringify(rows));
  } finally {await browser.close();await new Promise(r=>server.close(r));}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
