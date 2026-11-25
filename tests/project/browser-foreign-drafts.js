"use strict";
// The translator, format worker, closure verifier, and strict IndexedDB transactions are real.
// The host adapter controls Save outcomes independently of any host picker.
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),{pathToFileURL}=require("node:url");
const url=pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href;
const source=fs.readFileSync(path.join(__dirname,"../fixtures/import/review/proto/p.kicad_pcb"),"utf8");
async function ready(page) {
  await page.goto(url);
  await page.waitForFunction(()=>!!globalThis.AtriumNavHost);
  await page.evaluate(async()=>{
    await AtriumLazy.need("AtriumForeignDrafts");
    const h=globalThis.qaHost={revision:()=>h.rev,project:()=>h.model,importSession:()=>h.pending,
      isDirty:()=>h.dirty,info:()=>{},rev:0,dirty:true,saves:0,
      async saveProject(){h.saves++;if(h.saveResult){await AtriumForeignDrafts.retire(h.pending);h.pending=null;h.dirty=false;}return h.saveResult;},
      async restoreImportSession({pending,model,entries}){
        h.model=model;h.pending=pending;h.entries=entries;
        AtriumImportReports.installRetained(AtriumNavHost.fileSession(),entries);return true;
      }};
  });
}
module.exports=async function run(browser) {
  const context=await browser.newContext(), first=await context.newPage();
  try {
    await ready(first);
    assert.equal(await first.evaluate(()=>typeof globalThis.AtriumFolderCopperWorkerSource),"undefined");
    const begun=await first.evaluate(async text=>{
      const parser=await AtriumLazy.need("AtriumTranslatorClient"), data=new TextEncoder().encode(text);
      const parsed=await parser.import([{name:"Source.kicad_pcb",bytes:data}],{translator:"kicad"});
      const ids=parsed.model.documents.map(d=>d.id), scopes=[], writes=[];
      const storage=AtriumFolderDrafts.storage, write=storage.write.bind(storage);
      storage.write=(...args)=>{writes.push((args[4] || []).filter(row=>row.id.endsWith("/source")).length);return write(...args);};
      for(const id of ["draft-alpha","draft-bravo"]) {
        const pending={id,kind:"foreign",sourceKey:"same-source",nativeKey:"opaque-binding",sourceLabel:"Source.kicad_pcb",state:"unsaved",name:"Same",translator:"kicad",formatLabel:"KiCad",grant:"never-store"};
        const entry={id,scopeId:id,adopted:true,names:["Source.kicad_pcb"],documents:ids,report:parsed.report,provenance:parsed.provenance};
        const model={...parsed.model,name:"Same"}, stamp=await AtriumForeignDrafts.begin({pending,model,entries:[entry]});
        scopes.push(stamp);
        if(id==="draft-bravo"){
          qaHost.pending=pending;qaHost.model=model;qaHost.entries=[entry];
          AtriumImportReports.installRetained(AtriumNavHost.fileSession(),[entry]);
          model.documents[0].name="Edited before crash";qaHost.rev++;
          await AtriumForeignDrafts.flush(qaHost);
          const prefs=await AtriumLazy.need("AtriumPrefs"), timer=globalThis.setTimeout, delays=[];
          try {
            globalThis.setTimeout=(_fn,ms)=>{delays.push(ms);return 0;};
            prefs.set("general.autosaveMinutes",7);AtriumForeignDrafts.schedule(qaHost);
            prefs.set("general.autosaveMinutes",1);AtriumForeignDrafts.configure(qaHost);
            prefs.set("general.autosave",false);AtriumForeignDrafts.configure(qaHost);
            if(delays.length!==2 || delays[0]<410000 || delays[0]>420000 || delays[1]<50000 || delays[1]>60000)
              throw Error("Pending foreign edits did not follow the live autosave interval and enable switch: "+delays);
          } finally {
            globalThis.setTimeout=timer;prefs.set("general.autosaveMinutes",5);prefs.set("general.autosave",true);
          }
          const earlier=await AtriumForeignDrafts.resolveClose(qaHost,pending,"discard",true);
          if(!earlier || !await AtriumForeignDrafts.finishReview(qaHost,pending.id,false))throw Error("Canceling aggregate Quit failed");
        }
      }
      const editor=AtriumNavHost, previous=editor.project(), originalPost=Worker.prototype.postMessage;
      let cancelled=false;
      Worker.prototype.postMessage=function(message,...transfer) {
        const sent=originalPost.call(this,message,...transfer);
        if(message?.op==="draftConversionMembers")queueMicrotask(()=>{
          document.querySelector("button.import-cancel").click();
          cancelled=true;
        });
        return sent;
      };
      try {
        const opened=await editor.openFiles([new File([data],"Cancelled.kicad_pcb")]);
        if(!cancelled || opened || editor.project()!==previous || editor.importSession())
          throw Error("The cancelled open replaced the current editor project");
      } finally {
        Worker.prototype.postMessage=originalPost;
      }
      const heads=await AtriumFolderDrafts.storage.list("foreign-import-v1");
      return {writes,scopes,ids:heads.map(h=>h.writer).sort(),safe:heads.every(h=>!("grant" in h.pending) && !("sourceFile" in h.pending))};
    },source);
    assert.deepEqual(begun.writes,[1,1,0]);
    assert.equal(new Set(begun.scopes).size,2);assert.deepEqual(begun.ids,["draft-alpha","draft-bravo"]);assert.ok(begun.safe);
    assert.equal(await first.evaluate(()=>typeof globalThis.AtriumFolderCopperWorkerSource),"string");
    await first.evaluate(()=>{for(const key of Object.keys(localStorage)) if(key.startsWith("waffle-foreign-draft:")) localStorage.removeItem(key);});
    await first.close();
    const page=await context.newPage();await ready(page);
    const result=await page.evaluate(async()=>{
      const D=AtriumForeignDrafts,h=qaHost,heads=await AtriumAutosave.foreignHeads(),outcome=[];
      if(heads.length!==2)throw Error("IndexedDB discovery did not recover both imports after local storage was cleared");
      const first=heads.find(row=>row.writer==="draft-alpha");
      // Display metadata is never trusted as restored source or grant authority.
      const tampered={...first,pending:{...first.pending,sourceKey:"a-forged-offer"}};
      if(!await D.restore(tampered,h))throw Error("Untouched import could not recover");
      const baseline={name:h.model.documents[0].name,key:h.pending.sourceKey,original:h.entries[0].provenance.files[0].sha256,
        raw:await AtriumImportSidecars.sha(h.entries[0].provenance.files[0].bytes),status:AtriumForeignDraftUI.status(h.pending)};
      const known=()=>AtriumFolderDrafts.storage.list("foreign-import-v1");
      h.saveResult=false;
      const one=D.review(h),two=D.review(h);
      if(one!==two)throw Error("Double quit prompted twice");
      document.querySelector(".foreign-import-close [data-choice=save]").click();
      outcome.push(await one,await two,h.saves,(await known()).length);
      const cancel=D.review(h);document.querySelector(".foreign-import-close").close();outcome.push(await cancel,h.saves);
      const p=h.pending;
      if(!await D.resolveClose(h,p,"keep"))throw Error("Keep did not preserve the recovered import");
      await D.release(p);h.pending=null;
      const edited=(await known()).find(row=>row.writer==="draft-bravo");
      if(!await D.restore(edited,h))throw Error("Edited import could not recover");
      const editedName=h.model.documents[0].name;
      if(!await D.resolveClose(h,h.pending,"discard"))throw Error("Explicit discard did not complete");
      await D.flush(h);
      outcome.push((await known()).length);
      h.pending=null;
      const kept=(await known())[0];
      if(!await D.restore(kept,h))throw Error("Kept draft missing");
      h.saveResult=true;outcome.push(await D.resolveClose(h,h.pending,"save"),(await known()).length,h.saves);
      return {baseline,editedName,outcome};
    });
    const sha=require("node:crypto").createHash("sha256").update(source).digest("hex");
    assert.equal(result.baseline.key,"same-source");assert.equal(result.baseline.original,sha);assert.equal(result.baseline.raw,sha);
    assert.equal(result.baseline.status,"Not saved yet (imported from KiCad)");
    assert.notEqual(result.baseline.name,result.editedName);assert.equal(result.editedName,"Edited before crash");
    assert.deepEqual(result.outcome,[false,false,1,2,false,1,1,true,0,2]);
    assert.equal(await page.evaluate(()=>typeof globalThis.AtriumFolderCopperWorkerSource),"undefined");
  } finally {await context.close();}
};
if(require.main===module) (async()=>{
  const browser=await require("playwright-core").chromium.launch(process.env.CHROME ?
    {executablePath:process.env.CHROME} : {channel:"chrome"});
  try{await module.exports(browser);console.log("PASS foreign import recovery, verified originals, two identities, restore, keep, discard and quit Save");}
  finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
