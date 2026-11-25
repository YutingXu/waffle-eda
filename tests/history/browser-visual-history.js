"use strict";
const assert=require("node:assert/strict"),path=require("node:path");
const {pathToFileURL}=require("node:url");
const fs=require("node:fs/promises");
const {appServer}=require("./browser-project-history");
function durableMedia({id,present}) {
  return new Promise((resolve,reject)=>{
    const request=indexedDB.open("waffle-clipboard-media",1);
    request.onerror=()=>reject(request.error);
    request.onsuccess=()=>{
      const db=request.result, read=db.transaction("entries").objectStore("entries").openCursor();
      const sizes={};
      read.onerror=()=>{db.close();reject(read.error);};
      read.onsuccess=()=>{
        const row=read.result;
        if(row){sizes[row.key]=row.value.reduce((n,file)=>n+file.bytes.size,0);row.continue();return;}
        db.close();
        resolve(Object.hasOwn(sizes,id)===present?sizes:null);
      };
    };
  });
}
async function run(browser){
  const page=await browser.newPage({viewport:{width:1440,height:950},hasTouch:true});
  const errors=[],server=appServer();page.on("pageerror",e=>errors.push(e.message));
  try{
    await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
    await page.addInitScript(()=>{globalThis.ATRIUM_UNDO_VERIFY="throw";});
    await page.goto("http://127.0.0.1:"+server.address().port+"/app/index.html");
    assert.equal(await page.evaluate(()=>!!window.AtriumVisualHistory),false);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.evaluate(async()=>{await AtriumLazy.need("AtriumHistoryPanel");AtriumNavHost.act("history-panel");});
    await page.locator(".panel-history .hist-list:visible").first().waitFor();
    await page.locator(".hist-scrub").waitFor();
    assert.equal(await page.locator(".hist-list > .hist-row").count(),0,"only reviewed Undo rows are mounted");
    await page.locator(".panel-history").getByRole("button",{name:"Close History",exact:true}).click();
    await page.evaluate(async()=>{
      const prefs=await AtriumLazy.need("AtriumPrefs");
      prefs.set("butter.visualHistory",true);prefs.set("labs.notebook",true);
    });
    assert.equal(await page.evaluate(async()=>{
      const [art, captions]=await AtriumLazy.need(["AtriumHistoryArtwork","AtriumPCBNetLabels"]);
      const board=Atrium.sheet("pcb","Thumbnail");
      board.outline=[[0,0],[24,0],[24,12],[0,12]];
      const via={id:"caption-via",kind:"via",x:8,y:3,diameter:2,drill:.4,net:"POWER"};
      board.items=[{id:"caption-track",kind:"track",layer:"Top",net:"CLOCK",width:2,points:[[2,6],[22,6]]},via];
      const thumbnail=()=>art.render(board,new Map(),{w:400,h:220},[0,0,24,12]).toDataURL();
      let cold;
      try {
        globalThis.AtriumPCBNetLabels=undefined;
        cold=thumbnail();
      } finally {globalThis.AtriumPCBNetLabels=captions;}
      const warm=thumbnail();
      via.net="OTHER";
      return warm===cold && thumbnail()===warm;
    }),true,"history and clipboard artwork exclude track captions and pad net names");
    for(const kind of ["schematic","pcb"]){
      await page.evaluate(theme=>AtriumTheme.setPreset(theme),kind==="schematic"?"light":"dark");
      await page.locator('#document-tabs [data-kind="'+kind+'"]:visible').first().click();
      await page.evaluate(async kind=>{
        const h=AtriumNavHost;await AtriumLazy.need("AtriumUndoStore");
        const d=h.doc(),i=d.items.find(x=>x.kind==="part");
        window.histCase={id:i.id,doc:d.id,x:i.x,oldValue:i.value||"",len:h.undoSteps().history.length};
        h.edit(()=>{i.x+=1;},"Move "+i.ref,[i]);
        h.edit(()=>{i.value="Butter test";},"Set value "+i.ref,[i]);
        AtriumNavHost.act("history-panel");
      },kind);
      const panel=page.locator(".panel-history"),list=panel.locator(".hist-list[aria-label='Undo steps']");
      await panel.waitFor();await list.locator(".hist-row").first().waitFor();
      const index=await page.evaluate(()=>histCase.len+1), entry=panel.locator('.hist-row[data-index="'+index+'"]');
      await entry.click();await panel.locator('.hist-design-preview[data-ready=true]').waitFor();
      assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.id===histCase.id).value),"Butter test");
      if(process.env.WAFFLE_HISTORY_SHOTS){await fs.mkdir(process.env.WAFFLE_HISTORY_SHOTS,{recursive:true});
        await panel.screenshot({path:path.join(process.env.WAFFLE_HISTORY_SHOTS,kind+"-undo.png")});}
      const enabled=panel.getByRole("button",{name:"Restore",exact:true});await enabled.waitFor();
      const documentPicker=panel.getByRole("combobox",{name:"Preview document",exact:true});
      assert.equal(await enabled.evaluate(button=>button.matches(".ui-button[data-size=sm]")),true);
      assert.equal(await documentPicker.evaluate(field=>field.matches(".ui-field") && getComputedStyle(field).appearance==="none"),true);
      await documentPicker.click();
      const options=page.getByRole("listbox",{name:"Preview document",exact:true});
      await options.waitFor();
      await page.keyboard.press("Escape");
      await options.waitFor({state:"hidden"});
      await page.evaluate(()=>{const h=AtriumNavHost,i=h.doc().items.find(i=>i.id===histCase.id);h.edit(()=>{i.x+=4;},"Later move",[i]);});
      await entry.click();
      assert.deepEqual(await page.evaluate(()=>{const i=AtriumNavHost.doc().items.find(i=>i.id===histCase.id);return [i.value||"",i.x];}),
        await page.evaluate(()=>[histCase.oldValue,histCase.x+5]));
      await page.evaluate(()=>AtriumNavHost.act("undo"));
      assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.id===histCase.id).value),"Butter test");
      await list.focus();await page.keyboard.press("Home");await panel.locator(".hist-preview:not([hidden])").waitFor();
      await page.keyboard.press("Escape");await panel.locator(".hist-preview").waitFor({state:"hidden"});
      await panel.getByRole("button",{name:"Close History"}).click();
      await page.evaluate(async()=>{
        const h=AtriumNavHost,d=h.doc(),i=d.items.find(x=>x.kind==="part");h.select([i.id]);
        const transfer=new DataTransfer();h.canvas().dispatchEvent(new ClipboardEvent("copy",{bubbles:true,cancelable:true,clipboardData:transfer}));
        await AtriumLazy.need("AtriumClipHistory");AtriumNavHost.act("clipboard-panel");
      });
      const clip=page.locator(".panel-clip");await clip.waitFor();
      const pins=clip.getByRole("button",{name:"Pinned",exact:true});if(await pins.getAttribute("aria-pressed")==="true")await pins.click();
      const rows=clip.locator(".clip-item");await clip.getByRole("searchbox").fill("");await rows.first().waitFor();
      await clip.getByRole("searchbox").fill("does-not-occur");await clip.getByText("No matching clips.").waitFor();
      await clip.getByRole("searchbox").fill(kind);await rows.first().waitFor();
      await rows.first().getByRole("button",{name:/^Pin/}).click();
      await clip.getByRole("button",{name:"Pinned",exact:true}).click();await rows.first().waitFor();
      if(process.env.WAFFLE_HISTORY_SHOTS)await clip.screenshot({path:path.join(process.env.WAFFLE_HISTORY_SHOTS,kind+"-clips.png")});
      await clip.getByRole("button",{name:"Close Clipboard"}).click();
    }
    await page.evaluate(()=>AtriumNavHost.act("clipboard-picker"));
    const picker=page.getByRole("dialog",{name:"Clipboard history"});await picker.waitFor();
    await picker.getByRole("searchbox").fill("pcb");await picker.locator(".clip-item").first().waitFor();
    // Library search field: the first Escape clears the query, the next closes the picker.
    await page.keyboard.press("Escape");assert.equal(await picker.getByRole("searchbox").inputValue(),"","Escape clears the clipboard search first");
    await page.keyboard.press("Escape");await picker.waitFor({state:"detached"});
    await page.locator('#document-tabs [data-kind="schematic"]:visible').first().click();
    await page.evaluate(()=>{
      const h=AtriumNavHost,transfer=new DataTransfer();transfer.setData("text/plain","Thermal reference");
      h.canvas().dispatchEvent(new ClipboardEvent("paste",{bubbles:true,cancelable:true,clipboardData:transfer}));
    });
    await page.waitForFunction(()=>AtriumClipHistory.list("Thermal reference Text").length===1);
    const n0=await page.evaluate(()=>AtriumNavHost.doc().items.length);
    await page.locator("#canvas").click({position:{x:120,y:120}});
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.length),n0+1);
    await page.evaluate(async()=>{const h=AtriumNavHost,m=await AtriumLazy.need("AtriumMathEditor");
      void m.open({context:{host:h,docId:h.currentId(),point:[0,0]},argument:"V=IR"});});
    const tex=page.getByRole("textbox",{name:"TeX source"});await tex.waitFor();
    await tex.evaluate(e=>{e.select();e.dispatchEvent(new ClipboardEvent("copy",{bubbles:true,clipboardData:new DataTransfer()}));});
    await page.waitForFunction(()=>AtriumClipHistory.list("V=IR Math").length===1);
    await tex.press("Escape");
    await page.evaluate(()=>AtriumNavHost.act("clipboard-picker"));await picker.waitFor();
    await picker.getByRole("searchbox").fill("V=IR");const mathRow=picker.locator(".clip-item").first();await mathRow.waitFor();
    await mathRow.locator(".clip-thumb[data-ready=true]").waitFor();
    await mathRow.tap();await picker.waitFor({state:"detached"});
    await page.locator("#canvas").click({position:{x:150,y:150}});
    assert.ok(await page.evaluate(()=>AtriumNavHost.doc().items.some(i=>i.math&&i.text==="V=IR")));
    await page.evaluate(()=>{
      const h=AtriumNavHost,d=h.doc(),i=d.items.find(x=>x.kind==="part");
      h.edit(()=>{i.x+=2;},"Anchor fork",[i]);h.edit(()=>{i.y+=3;},"Later fork edit",[i]);
      window.forksBefore=AtriumUndoStore.branches().length;h.act("history-panel");
    });
    const sessionPanel=page.locator(".panel-history");
    const anchor=sessionPanel.getByRole("option").filter({hasText:"Anchor fork"});
    await anchor.click();await sessionPanel.locator(".hist-design-preview[data-ready=true]").waitFor();
    await sessionPanel.getByRole("button",{name:"Fork here"}).click();
    assert.equal(await page.evaluate(()=>AtriumUndoStore.branches().length),await page.evaluate(()=>forksBefore+1));
    await sessionPanel.locator(".hist-branches summary").click();
    await sessionPanel.locator(".hist-branch").first().getByRole("button",{name:"Preview"}).click();
    await sessionPanel.locator(".hist-design-preview[data-ready=true]").waitFor();
    await sessionPanel.getByRole("button",{name:"Close History"}).click();

    const photo=await page.evaluate(async()=>{
      const c=document.createElement("canvas");c.width=24;c.height=12;
      const g=c.getContext("2d");g.fillStyle="rgb(150,48,235)";g.fillRect(0,0,12,12);g.fillStyle="rgb(16,205,145)";g.fillRect(12,0,12,12);
      const blob=await new Promise(done=>c.toBlob(done,"image/png")),bytes=new Uint8Array(await blob.arrayBuffer());
      const sha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",bytes))].map(i=>i.toString(16).padStart(2,"0")).join("");
      const ref={mediaType:"image/png",byteLength:bytes.length,sha256},d=AtriumNavHost.doc();
      const row={id:"clipboard-test-photo",kind:"image",name:"Colour sample.png",x:0,y:0,w:24,h:12,extent:[24,12],asset:ref};
      const entry=AtriumClipHistory.recordImage(row,d);
      const media=await AtriumLazy.need("AtriumClipboardMedia");
      await media.capture(entry,{readAsset:()=>Promise.resolve({bytes})},d,[row]);
      AtriumClipHistory.pin(entry.id,true);AtriumClipHistory.save();
      return entry.id;
    });
    await page.waitForFunction(durableMedia,{id:photo,present:true});
    const storeImage=async (letter, byteLength, largeEntry=false)=>page.evaluate(async ({letter,byteLength,largeEntry})=>{
      const H=AtriumClipHistory, d=AtriumNavHost.doc(), M=await AtriumLazy.need("AtriumClipboardMedia");
      const row={id:"clipboard-"+letter,kind:"image",name:letter+".png",x:0,y:0,w:24,h:12,
        asset:{sha256:letter.repeat(64),mediaType:"image/png",byteLength}};
      const entry=largeEntry?
        H.record({data:"x".repeat(H.limits.saveEntry+1),items:[row],kind:"schematic"}):
        H.recordImage(row,d);
      try {
        await M.capture(entry,{readAsset:()=>Promise.resolve({bytes:new Uint8Array(byteLength)})},d,[row]);
      } catch (error) {
        return {id:entry.id, error:error.message};
      }
      H.pin(entry.id,true);H.save();
      return {id:entry.id};
    },{letter,byteLength,largeEntry});
    const large=await storeImage("b",3,true);
    const exceeds=await storeImage("c",49*1048576);
    assert.match(exceeds.error,/48 MiB limit/);
    const first=await storeImage("d",25*1048576);
    await page.waitForFunction(durableMedia,{id:first.id,present:true});
    const second=await storeImage("e",25*1048576);
    const sizes=await (await page.waitForFunction(durableMedia,{id:second.id,present:true})).jsonValue();
    assert.equal(sizes[second.id],25*1048576);
    assert.equal(sizes[first.id],undefined);
    assert.equal(sizes[large.id],undefined,"metadata that cannot be persisted cannot retain original bytes");
    assert.equal(sizes[exceeds.id],undefined);
    assert.ok(Object.values(sizes).reduce((a,b)=>a+b,0)<=48*1048576);
    await page.reload();await page.waitForFunction(()=>!!window.AtriumNavHost);
    const retained=await page.evaluate(async id=>{
      const history=await AtriumLazy.need("AtriumClipHistory");
      const found=history.list("Colour sample Image",true).find(e=>e.id===id);
      const canvas=found&&await history.imagePreview(id);
      if(!canvas)return null;
      const data=canvas.getContext("2d").getImageData(0,0,canvas.width,canvas.height).data;
      let violet=0,green=0;
      for(let i=0;i<data.length;i+=4) {
        if(Math.abs(data[i]-150)<4&&Math.abs(data[i+1]-48)<4&&Math.abs(data[i+2]-235)<4)violet++;
        if(Math.abs(data[i]-16)<4&&Math.abs(data[i+1]-205)<4&&Math.abs(data[i+2]-145)<4)green++;
      }
      return [violet,green];
    },photo);
    assert.ok(retained?.every(n=>n>100),"pinned preview renders both original image colours after a restart");
    await page.reload();await page.waitForFunction(()=>!!window.AtriumNavHost);
    const removed=await page.evaluate(async id=>{
      const history=await AtriumLazy.need("AtriumClipHistory"), lazy=!window.AtriumClipboardMedia;
      const removed=history.remove(id);
      history.save();
      return lazy && removed;
    },second.id);
    assert.equal(removed,true,"the image can be removed before loading the media module");
    await page.waitForFunction(durableMedia,{id:second.id,present:false});
    assert.deepEqual(errors,[]);
    console.log("PASS real schematic and PCB: preview, guarded restore in one edit, normal Undo, fork preview, keyboard, touch paste, text/equation search and original pinned image pixels after reload");
  }finally{await page.close();if(server.listening)await new Promise(resolve=>server.close(resolve));}
}
// Opt in on a quiet machine. The ordinary browser suite only runs functional checks.
async function measure(browser){
  const page=await browser.newPage({viewport:{width:1440,height:950}});
  const cdp=await page.context().newCDPSession(page);
  try{
    await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.evaluate(async()=>{(await AtriumLazy.need("AtriumPrefs")).set("butter.visualHistory",true);});
    await page.locator('#document-tabs [data-kind="schematic"]:visible').first().click();
    const fixture=await page.evaluate(async()=>{
      const h=AtriumNavHost,d=h.doc(),u=await AtriumLazy.need("AtriumUndoStore");
      AtriumPower.setMode("always");
      const objects=Array.from({length:1200},(_,i)=>({id:"measure-"+i,kind:"label",x:i%60*3,y:Math.floor(i/60)*3,text:"N"+i,size:1.5}));
      h.edit(()=>d.items.push(...objects),"Import labels",objects);
      const {history,future}=h.undoSteps();
      for(let n=0;n<496;n++){
        const mark=u.mark(h.project()),item=objects[n%objects.length];
        item.x+=2;u.checkpoint(history,future,mark,"Move label "+n);u.record(h.project(),[{doc:d,items:[item]}]);
      }
      h.edit(()=>{objects[0].x+=3;},"Move first label",[objects[0]]);
      return {total:d.items.length,steps:history.length,store:u.stats().bytes};
    });
    await cdp.send("Performance.enable");
    await cdp.send("HeapProfiler.collectGarbage");
    const baseline=(await cdp.send("Runtime.getHeapUsage")).usedSize;
    const firstAt=performance.now();
    await page.evaluate(()=>AtriumNavHost.act("history-panel"));
    const panel=page.locator(".panel-history"),list=panel.locator(".hist-list[aria-label='Undo steps']");
    await list.locator(".hist-row").first().waitFor();
    const firstMs=performance.now()-firstAt;
    const run=await page.evaluate(async()=>{
      const box=document.querySelector(".hist-list[aria-label='Undo steps']"),frames=[];
      let previous,peakRows=0;
      for(let n=0;n<=80;n++){
        const stamp=await new Promise(requestAnimationFrame);if(previous)frames.push(stamp-previous);previous=stamp;
        box.scrollTop=(box.scrollHeight-box.clientHeight)*n/80;
        peakRows=Math.max(peakRows,box.querySelectorAll(".hist-rail > .hist-row").length);
      }
      return {frames,peakRows};
    });
    const peaks=[baseline,(await cdp.send("Runtime.getHeapUsage")).usedSize],latencies=[];
    const slider=panel.getByRole("slider",{name:"Session and Git history"});
    await slider.waitFor();
    for(const i of [40,270,495,130,400,230]){
      const start=performance.now();
      await slider.evaluate((e,v)=>{e.value=String(v);e.dispatchEvent(new Event("input",{bubbles:true}));},i);
      await panel.locator(".hist-design-preview[data-ready=true]").waitFor();
      latencies.push(performance.now()-start);
      peaks.push((await cdp.send("Runtime.getHeapUsage")).usedSize);
    }
    await panel.getByRole("button",{name:"Close History"}).click();
    await cdp.send("HeapProfiler.collectGarbage");
    const idleStart=await page.evaluate(()=>AtriumHistoryArtwork.stats());
    const task=async()=>Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({name,value})=>[name,value])).TaskDuration;
    const activeAt=await task();await new Promise(resolve=>setTimeout(resolve,2500));
    const idleMs=(await task()-activeAt)*1000,final=await page.evaluate(()=>AtriumHistoryArtwork.stats());
    const restored=(await cdp.send("Runtime.getHeapUsage")).usedSize;
    assert.equal(final.draws,idleStart.draws);assert.equal(final.scheduled,0);assert.ok(run.peakRows<=20);
    const p95=arr=>+arr.slice().sort((a,b)=>a-b)[Math.floor(arr.length*.95)].toFixed(1);
    const mib=b=>+(b/1048576).toFixed(2);
    const sessionResult={objects:fixture.total,steps:fixture.steps,undoMiB:mib(fixture.store),peakRows:run.peakRows,
      firstRowsMs:+firstMs.toFixed(1),scrollDisplayP95Ms:p95(run.frames),previewP95Ms:p95(latencies),previewSamples:latencies.length,
      peakMeasuredHeapMiB:mib(Math.max(...peaks)),baselineHeapMiB:mib(baseline),idleHeapMiB:mib(restored),
      idleSampleMs:2500,idleBrowserTaskMs:+idleMs.toFixed(1),idleArtworkDraws:final.draws-idleStart.draws,idleScheduled:final.scheduled};
    await page.evaluate(async()=>{
      const h=await AtriumLazy.need("AtriumClipHistory"),prefs=await AtriumLazy.need("AtriumPrefs");
      prefs.set("clipboard.historySize",100);
      for(let i=0;i<100;i++)h.recordText((i%2?"Filter":"Clock")+" node "+i,{kind:i%4?"schematic":"pcb"});
      AtriumNavHost.act("clipboard-panel");
    });
    const clip=page.locator(".panel-clip"),search=clip.getByRole("searchbox");
    await clip.locator(".clip-thumb[data-ready=true]").first().waitFor();
    const searches=[],heap=[(await cdp.send("Runtime.getHeapUsage")).usedSize];
    for(const query of ["Clock","Filter schematic","node 9","node","missing","pcb"]){
      const t=performance.now();await search.fill(query);
      const actual=await clip.locator(".clip-item").evaluateAll(rows=>rows.map(r=>r.dataset.id));
      const expected=await page.evaluate(q=>AtriumClipHistory.list(q).map(e=>e.id),query);
      assert.deepEqual(actual,expected,"incremental search agrees with the full result list");
      searches.push(performance.now()-t);heap.push((await cdp.send("Runtime.getHeapUsage")).usedSize);
    }
    await clip.getByRole("button",{name:"Close Clipboard"}).click();
    const clipStart=await page.evaluate(()=>AtriumHistoryArtwork.stats().draws);
    await cdp.send("HeapProfiler.collectGarbage");await new Promise(resolve=>setTimeout(resolve,1000));
    const stats=await page.evaluate(()=>({...AtriumClipHistory.stats(),art:AtriumHistoryArtwork.stats()}));
    assert.equal(stats.entries,100);assert.equal(stats.art.draws,clipStart);assert.equal(stats.art.scheduled,0);
    console.log(JSON.stringify({session:sessionResult,clipboard:{entries:stats.entries,peakMeasuredHeapMiB:mib(Math.max(...heap)),
      idleHeapMiB:mib((await cdp.send("Runtime.getHeapUsage")).usedSize),retainedThumbnailCount:stats.thumbs,
      retainedThumbnailKiB:+(stats.thumbBytes/1024).toFixed(1),searchP95Ms:p95(searches),idleSampleMs:1000,
      idleArtworkDraws:stats.art.draws-clipStart,idleScheduled:stats.art.scheduled}},null,2));
  }finally{await page.close();}
}
module.exports=run;
if(require.main===module)(async()=>{
  const {chromium}=require("playwright-core"),browser=await chromium.launch({headless:true,...(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"})});
  try{if(process.argv.includes("--measure"))await measure(browser);else await run(browser);}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
