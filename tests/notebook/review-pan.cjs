"use strict";
const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url");
const {chromium}=require("../support/playwright.cjs");
(async()=>{
  const browser=await chromium.launch({channel:"chrome",args:["--allow-file-access-from-files"]});
  try{
    const page=await browser.newPage({viewport:{width:1280,height:860}});
    await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.doc());
    const results=await page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumReviewNotes","AtriumPrefs"]);await AtriumRichText.ready();
      AtriumPrefs.set("checks.liveErc",false);
      const h=AtriumNavHost,p=Atrium.project("Notes pan"),d=Atrium.sheet("schematic","Notes");
      p.documents=[d];const target={id:"target",kind:"label",x:66,y:38,text:"SENSE"};d.items.push(target);
      let first;
      for(let n=0;n<500;n++){
        const at=[(n%25)*39,Math.floor(n/25)*18];
        if(n%5===4)d.items.push(AtriumMarkup.stroke([[...at,128],[at[0]+8,at[1]+1,176]],"pen","blue",.5));
        else {
          const type=n%5===3?"callout":"sticky",ref=type==="callout"?AtriumMarkup.reference(p,d,target):undefined;
          const i=AtriumMarkup.card(type,at,"Review "+n,"amber",p,d,ref);first??=i;d.items.push(i);
        }
      }
      await h.replaceProject(p,{force:true,copy:true,dirty:false});const v=h.view(),defs=h.defs();
      v.restoreCamera({...v.camera(),cx:128,cy:65,scale:3,referenceScale:3});
      const render=()=>v.render(d,defs,{project:p,grid:false,origin:false,selectedIds:new Set(),hidden:new Set()});
      // Warm both ends of the small pan range. Subsequent field layout counts
      // measure invalidation only, never an object's first appearance.
      render();v.pan(8,0);render();v.pan(-8,0);render();
      const warm=AtriumRichText.stats.paragraphs,samples=[];
      for(let j=0;j<90;j++) {
        await new Promise(r=>requestAnimationFrame(r));v.pan(j%2?8:-8,0);
        const start=performance.now();render();samples.push(performance.now()-start);
      }
      const redraws=AtriumRichText.stats.paragraphs-warm;
      // The authored edit is in the visible window. Only its paragraph may reflow.
      first=d.items.find(i=>i.sticky&&i.x===117&&i.y===54) || first;
      const n=AtriumRichText.stats.paragraphs;h.edit(()=>{first.text="Revised note";first.richText=AtriumMarkup.body(first.text,p,d);},"Edit one sticky",[first]);render();
      samples.sort((a,b)=>a-b);
      return {notes:d.items.length-1,frames:samples.length,medianMs:samples[45],p95Ms:samples[85],maxMs:samples.at(-1),
        panParagraphLayouts:redraws,editedParagraphLayouts:AtriumRichText.stats.paragraphs-n};
    });
    assert.equal(results.notes,500);assert.equal(results.panParagraphLayouts,0);assert.equal(results.editedParagraphLayouts,1);
    console.log(JSON.stringify(results));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
