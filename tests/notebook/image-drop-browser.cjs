"use strict";

// Use the real editor, its two schematic tabs and its paste/drop dispatch. The
// fixture adapter supplies one synthetic PNG and lets the test delay native I/O.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");

async function main() {
  const browser = await chromium.launch({channel:"chrome",headless:true,args:["--allow-file-access-from-files"]});
  try {
    const page = await browser.newPage({viewport:{width:1200,height:800},reducedMotion:"reduce"});
    const errors=[];
    page.on("pageerror",error=>errors.push(error.message));
    await page.route(/^https?:\/\//,route=>route.abort());
    await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(()=>!!globalThis.AtriumNavHost?.doc());
    const result = await page.evaluate(async()=>{
      const h=globalThis.AtriumNavHost, real=globalThis.AtriumLazy;
      await real.need("AtriumPrefs");
      AtriumPrefs.set("labs.notebook",true);
      const a=Atrium.sheet("schematic","First"), b=Atrium.sheet("schematic","Second");
      const project=Atrium.project("Drop test",[]);
      project.documents=[a,b];
      await h.replaceProject(project,{force:true,dirty:false});
      const first=h.docById(a.id), second=h.docById(b.id);
      const canvas=h.canvas(), bounds=canvas.getBoundingClientRect(), x=bounds.left+80, y=bounds.top+80;
      const tile=document.createElement("canvas");tile.width=2;tile.height=1;
      const blob=await new Promise(resolve=>tile.toBlob(resolve,"image/png"));
      const file=new File([blob],"Bench.png",{type:"image/png"}),bytes=new Uint8Array(await blob.arrayBuffer());
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),n=>n.toString(16).padStart(2,"0")).join("");
      const assetRef={sha256:digest,byteLength:bytes.length,mediaType:"image/png"};
      const calls=[],staged=[],released=[];
      const session={grant:"fixture",canEdit:()=>true,completeFor:()=>true,readAsset:async()=>({bytes,assetRef}),
        stageAttachment:t=>staged.push(t.assetToken),releaseAsset:async t=>released.push(t.assetToken)};
      h.folderProject=()=>session;
      const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
      let mediaWait, nativeWait;
      globalThis.AtriumLazy={...real,need(name){
        if(name==="AtriumNotebookImageUI" && mediaWait){mediaWait.started=true;return mediaWait.promise.then(()=>real.need(name));}
        return real.need(name);
      }};
      async function selected({ownerId,dropToken}){
        const n=calls.push({ownerId,dropToken});
        if(nativeWait){nativeWait.started=true;await nativeWait.promise;}
        return {ownerId,assetRef,assetToken:"fixture-"+n,name:"Bench.png"};
      }
      globalThis.AtriumHost={...globalThis.AtriumHost,notebookDrop:selected,notebookTransfer:selected};
      const next=()=>new Promise(r=>setTimeout(r,0));
      async function until(fn){for(let i=0;i<250;i++){if(fn())return;await new Promise(r=>setTimeout(r,8));}throw Error("Expected editor action did not complete");}
      function event(kind){
        const data=new DataTransfer();data.items.add(file);
        const e=kind==="drop"?new DragEvent("drop",{dataTransfer:data,bubbles:true,cancelable:true,clientX:x,clientY:y})
          :new ClipboardEvent("paste",{clipboardData:data,bubbles:true,cancelable:true});
        canvas.focus();canvas.dispatchEvent(e);
        if(!e.defaultPrevented)throw Error("Editor did not handle "+kind);
      }
      async function switchSheets(back){
        await h.selectDocument(b.id);
        if(h.doc().id!==b.id)throw Error("Second sheet was not active");
        if(back)await h.selectDocument(a.id);
      }
      const before=[first.items.length,second.items.length], cold=[];
      for(const [kind,back] of [["paste",false],["drop",true]]){
        await h.selectDocument(a.id);mediaWait=deferred();event(kind);
        await until(()=>mediaWait.started);await switchSheets(back);
        mediaWait.resolve();await real.need("AtriumNotebookImageUI");await next();mediaWait=null;
        cold.push(calls.length);
      }
      const ui=await real.need("AtriumNotebookImageUI");
      const origin=AtriumNotebookImageDrop.capture(h);nativeWait=deferred();
      const late=ui.dropCaptured(session.grant,"held",x,y,{signal:origin.signal}).catch(e=>e.name);
      await until(()=>nativeWait.started);await switchSheets(true);nativeWait.resolve();
      const lateResult=await late;nativeWait=null;origin.close();
      const dialog=deferred(), dismissed=[], copies=[];
      Object.assign(globalThis.AtriumHost,{
        folderPickAsset:async()=>{dialog.started=true;await dialog.promise;return {sourceToken:"selected",name:"Bench.png",mediaType:"image/png"};},
        folderStageAsset:async t=>{copies.push(t.sourceToken);return selected(t);},
        folderDropAsset:async t=>dismissed.push([t.ownerId===a.id,t.sourceToken])
      });
      const picking=ui.insert({host:h,source:"image",point:[3,6]}).catch(e=>e.name);
      await until(()=>dialog.started);await switchSheets(true);dialog.resolve();const pickerResult=await picking;
      const afterCancelled=[first.items.length,second.items.length];
      const fresh=AtriumNotebookImageDrop.capture(h);
      const placed=await ui.dropCaptured(session.grant,"current",x,y,{signal:fresh.signal});fresh.close();
      return {cold,before,afterCancelled,lateResult,lateOwner:calls[0]?.ownerId===a.id,released,staged,dismissed,copies,pickerResult,
        current:placed?.asset.sha256===digest,final:[first.items.length,second.items.length]};
    });
    assert.deepEqual(result,{cold:[0,0],before:[0,0],afterCancelled:[0,0],lateResult:"AbortError",lateOwner:true,
      released:["fixture-1"],staged:["fixture-2"],dismissed:[[true,"selected"]],copies:[],pickerResult:"AbortError",current:true,final:[1,0]});
    assert.deepEqual(errors,[]);
    console.log("Two-sheet clipboard/drop cancellation, one released late source and one unchanged-sheet placement passed.");
  } finally { await browser.close(); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
