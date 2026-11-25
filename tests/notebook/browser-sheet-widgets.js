"use strict";
const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url");
module.exports=async function(browser){
  for(const theme of ["light","dark"]){
    const page=await browser.newPage({viewport:{width:1250,height:900},hasTouch:true}),errors=[];
    page.on("pageerror",e=>errors.push(e.message));page.setDefaultTimeout(7000);
    try{
      await require("../fixtures/notebook-labs.cjs").profile(page);
      await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
      await page.evaluate(async theme=>{
        AtriumTheme.apply?.(theme);document.documentElement.dataset.theme=theme;
        const h=AtriumNavHost;h.selectDocument(h.project().documents.find(d=>d.kind==="schematic").id);h.canvas().focus();
      },theme);
      await page.keyboard.press("/");const field=page.locator("dialog[open] input").first();await field.fill("todo-list Verify regulator");
      const choice=page.getByRole("option",{name:/to-do list/i}).first();await choice.waitFor();await choice.click();
      await page.waitForFunction(()=>AtriumNavHost.doc().items.some(i=>i.widget?.type==="todo"));
      const initial=await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.widget?.type==="todo");return {id:i.id,text:i.widget.state.rows[0]?.text};});
      assert.equal(initial.text,"Verify regulator");
      await page.getByRole("button",{name:"Edit widget",exact:true}).click();
      const editor=page.locator("dialog.sw-editor");
      await editor.getByRole("checkbox").check();await editor.getByLabel("Assignee").fill("Mira");await editor.getByLabel("Assignee").press("Tab");
      await editor.getByRole("button",{name:"Add item",exact:true}).tap();await page.waitForFunction(()=>document.querySelectorAll(".sw-editor input[type=checkbox]").length===2);
      assert(await editor.getByRole("button",{name:"Done",exact:true}).evaluate(b=>b.getBoundingClientRect().height>=44));
      if(process.env.WIDGET_SCREENSHOTS) await page.screenshot({path:path.join(process.env.WIDGET_SCREENSHOTS,"sheet-widget-"+theme+".png")});
      await editor.getByRole("button",{name:"Done",exact:true}).tap();
      const selected=await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.widget);return {i:i.widget.state.rows,select:h.selection()};});
      assert.deepEqual(selected.select,[initial.id]);assert.equal(selected.i[0].assignee,"Mira");assert.equal(selected.i[0].done,true);assert.equal(selected.i.length,2);
      await page.evaluate(()=>AtriumNavHost.act("undo"));await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.widget).widget.state.rows.length===1);
      await page.evaluate(()=>AtriumNavHost.act("redo"));await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.widget).widget.state.rows.length===2);
      const results=await page.evaluate(async ()=>{
        const h=AtriumNavHost,p=h.project(),doc=h.doc(),item=doc.items.find(i=>i.widget);await AtriumLazy.need("AtriumInsights");
        return AtriumInsights.check("openSheetTodo").run({project:p,doc}).map(r=>r.sig);
      });
      assert.equal(results.length,1);assert.equal(results[0],selected.i[1].id);
      await page.evaluate(()=>AtriumNavHost.canvas().focus());await page.keyboard.press("Enter");await editor.waitFor();
      await editor.getByRole("button",{name:"Done",exact:true}).click();
      await page.evaluate(()=>{const h=AtriumNavHost;h.canvas().focus();});await page.keyboard.press("/");await field.fill("Pin-map table");
      const pin=page.getByRole("option",{name:/pin-map table/i}).first();await pin.waitFor();await pin.click();
      await page.waitForFunction(()=>AtriumNavHost.doc().items.some(i=>i.widget?.type==="pin-map"));
      await page.getByRole("button",{name:"Edit widget",exact:true}).click();const part=editor.getByLabel("Part",{exact:true});
      await part.selectOption({index:1});await page.waitForFunction(()=>document.querySelector(".sw-result pre")?.textContent.includes("Electrical type"));
      await editor.getByRole("button",{name:"Done",exact:true}).click();
      const paths=await page.evaluate(async ()=>{
        const h=AtriumNavHost,d=h.doc(),i=d.items.find(i=>i.widget?.type==="todo");
        const v=await AtriumSheetWidgetRuntime.prepare(h.project(),d,i,{host:h,revision:h.revision()});
        const canvas=document.createElement("canvas");canvas.width=250;canvas.height=140;const c=canvas.getContext("2d");c.scale(5,5);
        AtriumSchObjects.draw(c,{...i,x:0,y:0},{purpose:"print",widgetViews:new Map([[i.id,v]]),scale:5});
        const drawn=c.getImageData(0,0,250,140).data.some(n=>n>0),ref={sha256:"a".repeat(64),mediaType:"image/png",byteLength:100};
        const ext=AtriumSheetWidgets.make("ext.missing.sample",[0,0],{fallback:{type:"image",assetRef:ref,alt:"Regulator pinout"}});
        const source=document.createElement("canvas");source.width=3;source.height=2;const pixels=source.getContext("2d");
        pixels.fillStyle="#168f32";pixels.fillRect(0,0,3,2);
        const paint=assets=>{AtriumSchObjects.draw(c,ext,{purpose:"print",widgetViews:new Map(),assets,scale:5});return [...c.getImageData(120,80,1,1).data];};
        const original=window.AtriumHost,oldOpen=window.open;let navigated=false,blocked=false;
        try{window.AtriumHost={};window.open=()=>{navigated=true;};try{AtriumSheetWidgets.openURL("https://example.org/");}catch{blocked=true;}}
        finally{window.AtriumHost=original;window.open=oldOpen;}
        return {checked:v.rows.map(r=>r.checked),drawn,image:paint(new Map([[ref.sha256,{surface:source,width:3,height:2}]])),missing:paint(new Map()),blocked,navigated};
      });
      assert.deepEqual(paths.checked,[true,false]);assert(paths.drawn);assert.deepEqual(paths.image,[22,143,50,255]);
      assert.deepEqual(paths.missing,[255,255,255,255]);assert(paths.blocked && !paths.navigated);assert.deepEqual(errors,[]);
      const threadId=await page.evaluate(async()=>{
        const h=AtriumNavHost,p=h.project(),d=h.doc(),i=d.items.find(i=>i.widget?.type==="todo");
        const api=await AtriumLazy.need("AtriumReviewComments");let thread;
        h.edit(()=>{thread=api.add(p,{doc:d.id,anchor:{kind:"point",at:[i.x,i.y]},text:"Verify regulation",author:"QA"});
          i.widget.state.rows[0].threadId=thread.id;},"Connect Review to checklist");h.select([i.id]);return thread.id;
      });
      await page.getByRole("button",{name:"Edit checklist",exact:true}).click();
      await editor.getByRole("checkbox").first().check();await editor.getByRole("button",{name:"Done",exact:true}).click();
      assert.equal(await page.evaluate(id=>AtriumReviewComments.thread(AtriumNavHost.project(),id).status,threadId),"resolved");
      await page.evaluate(()=>AtriumNavHost.act("undo"));await page.waitForFunction(id=>AtriumReviewComments.thread(AtriumNavHost.project(),id).status==="open",threadId);
      const checkbox=await page.evaluate(()=>{
        const h=AtriumNavHost,i=h.doc().items.find(i=>i.widget?.type==="todo");
        h.edit(()=>{i.x=162;i.y=104;},"Move review checklist",[i]);h.view().restoreCamera({...h.view().camera(),cx:i.x+24,cy:i.y+13,scale:8});h.redraw();
        const at=h.view().worldToScreen([i.x+2,i.y+6.7]),b=h.canvas().getBoundingClientRect();return [at[0]+b.x,at[1]+b.y];
      });
      await page.touchscreen.tap(...checkbox);
      await page.waitForFunction(id=>AtriumReviewComments.thread(AtriumNavHost.project(),id).status==="resolved",threadId);
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      await page.waitForFunction(id=>AtriumReviewComments.thread(AtriumNavHost.project(),id).status==="open",threadId);
      if(theme==="light"){
        const folder=path.resolve(__dirname,"../../extensions/examples/widget-inspection");
        const sample=Object.fromEntries(["main.js","waffle-extension.json"].map(f=>[f,require("node:fs").readFileSync(path.join(folder,f),"utf8")]));
        await page.evaluate(async files=>{const X=await AtriumLazy.need("AtriumExtensions");window.__sampleInstall=X.install(files);},sample);
        await page.getByRole("button",{name:"Install",exact:true}).click();await page.evaluate(()=>window.__sampleInstall);
        await page.evaluate(()=>AtriumNavHost.canvas().focus());await page.keyboard.press("/");await field.fill("Inspection counter");
        await page.getByRole("option",{name:/Inspection counter/i}).first().click();
        await page.getByRole("button",{name:"Edit widget",exact:true}).click();
        const action=editor.getByRole("button",{name:"Record inspection",exact:true});await action.focus();await action.press("Enter");
        await page.waitForFunction(()=>AtriumNavHost.doc().items.find(i=>i.widget?.type==="ext.example.inspection.counter")?.widget.state.count===1);
        await editor.getByRole("button",{name:"Done",exact:true}).click();
        const widgetId=await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.widget?.type==="ext.example.inspection.counter");
          h.edit(()=>{i.x=225;i.y=135;},"Move inspection counter",[i]);h.view().restoreCamera({...h.view().camera(),cx:i.x+24,cy:i.y+13,scale:8});h.redraw();return i.id;});
        const point=await page.waitForFunction(id=>{
          const h=AtriumNavHost,d=h.doc(),i=d.items.find(i=>i.id===id),v=AtriumSheetWidgetRuntime.preparedView(h.project(),d,i,h.revision());
          if(!v?.rows[1]?.action)return null;
          const c=h.canvas(),b=c.getBoundingClientRect(),pt=h.view().worldToScreen([i.x+5,i.y+9]),x=b.x+pt[0],y=b.y+pt[1];
          return x>b.left && x<b.right && y>b.top && y<b.bottom && h.hit(c,x,y)?.item===i ? [x,y] : null;
        },widgetId);
        await page.touchscreen.tap(...await point.jsonValue());
        await page.waitForFunction(id=>AtriumNavHost.doc().items.find(i=>i.id===id)?.widget.state.count===2,widgetId);
        await page.evaluate(()=>AtriumNavHost.act("undo"));
        await page.waitForFunction(id=>AtriumNavHost.doc().items.find(i=>i.id===id)?.widget.state.count===1,widgetId);
        await page.evaluate(async()=>{
          const X=await AtriumLazy.need("AtriumExtensions"),m={id:"qa.heavy",name:"Slow widget fixture",version:"1.0.0",apiVersion:1,main:"main.js",permissions:["ui:command","ui:widgets"],
            activationEvents:["onCommand:qa.slow"],contributes:{commands:[{command:"qa.slow",title:"Slow widget"}],widgets:[{id:"test",name:"Load test",render:"qa.slow",state:{},inputs:[],
            size:{min:[10,10],preferred:[40,20],max:[100,80]},fallback:{type:"text",text:"Stopped load test"}}]}};
          window.__widgetInstallation=X.install({"waffle-extension.json":JSON.stringify(m),"main.js":'exports.activate=api=>api.commands.register("qa.slow",()=>{const end=Date.now()+1000;while(Date.now()<end) Math.sqrt(17);return {title:"Late",rows:[]};});'}).then(()=>true);
        });
        await page.getByRole("button",{name:"Install",exact:true}).click();
        const metrics=await page.evaluate(async()=>{
          await window.__widgetInstallation;const h=AtriumNavHost,E=await AtriumLazy.need("AtriumExtensionWidgets"),instance=E.make("ext.qa.heavy.test",[0,0]),samples=[];
          await AtriumExtensions.activate("qa.heavy","onCommand:qa.slow");
          let id;const tick=t=>{samples.push(t);id=requestAnimationFrame(tick);};id=requestAnimationFrame(tick);
          const at=performance.now();let error="";
          try{await E.request(h.project(),h.doc(),instance,{revision:h.revision()});}catch(e){error=e.message;}
          const ms=performance.now()-at;await new Promise(r=>setTimeout(r,50));cancelAnimationFrame(id);
          return {ms,frames:samples.filter(t=>t>=at && t<=at+ms).length,error,live:AtriumExtensions.workers.some(w=>w.members.includes("qa.heavy"))};
        });
        if(process.env.WIDGET_SCREENSHOTS)require("node:fs").writeFileSync(path.join(process.env.WIDGET_SCREENSHOTS,"slow-worker.json"),JSON.stringify(metrics,null,2));
        assert.match(metrics.error,/budget|time limit|stopped/);assert(metrics.ms<700 && metrics.frames>=3 && !metrics.live,JSON.stringify(metrics));
      }
    }catch(e){console.error(await page.evaluate(()=>({dialog:document.querySelector(".sw-editor")?.textContent,selected:AtriumNavHost.selection(),active:AtriumNavHost.doc().items.filter(i=>i.widget).map(i=>[i.id,i.widget.type])})));throw e;}finally{await page.close();}
  }
  console.log("browser-sheet-widgets: palette insertion, keyboard and touch editing, assignments, undo/redo, open Insights and live pin map in both themes passed");
};
if(require.main===module)(async()=>{const b=await require("playwright-core").chromium.launch({channel:"chrome"});try{await module.exports(b);}finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
