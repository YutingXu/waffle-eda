"use strict";

const assert=require("node:assert/strict");
async function netProject({page,workload}) {
  Object.assign(workload,{schematicSheets:2,netPins:256,pinsPerSheet:128});
  await page.evaluate(async()=>{
    const h=AtriumNavHost;
    await AtriumLazy.need("AtriumDesignQueryRecord");
    const def={id:"trace-terminal",name:"Terminal",symbol:{pins:[{number:"1",name:"1",x:0,y:0,electrical:4}],shapes:[]}};
    const p=Atrium.project("Fanout navigation",[def]);
    p.rules={format:"atrium-rules",version:3,units:"mm",list:[{id:"net-scope",type:"ercNetScope",name:"Net Identifier Scope",
      enabled:true,priority:1,where:"schematic",scope:AtriumDesignQueryRecord.selector("all"),netScope:"global"}]};
    p.documents=["local","remote"].map((id,s)=>{
      const d={...Atrium.sheet("schematic",id),id};
      for(let i=0;i<128;i++){
        const number=2*i+1+s,x=(i%16)*10,y=Math.floor(i/16)*10;
        d.items.push({kind:"part",id:"pin-"+number,ref:"TP"+number,def:def.id,x,y,angle:0,value:""});
        if(i){const prev=i-1;d.items.push({kind:"wire",id:id+"-wire-"+i,points:[[(prev%16)*10,Math.floor(prev/16)*10],[x,y]]});}
      }
      d.items.push({kind:"netlabel",id:id+"-label",text:"FANOUT_A",x:0,y:0});
      return d;
    });
    await h.replaceProject(p,{force:true}); h.selectDocument("local"); globalThis.AtriumStartPage?.close();
    await AtriumLazy.need("AtriumNavigatorPanel"); await AtriumLazy.need("AtriumConnectionPreview");
    h.act("navigator-panel");
    h.on("frame",()=>{window.wafflePinFrame={doc:h.currentId(),net:h.highlight(),selection:h.selection()};});
  });
  const filter=page.getByRole("searchbox",{name:"Search the Navigator"});
  await filter.fill("FANOUT");
  await page.locator('.navp-row[data-type=net]').filter({hasText:"256 pins"}).waitFor();
}

async function navigator(env) {
  await netProject(env);
  const {page,repeat,measure}=env;
  const net=page.locator('.navp-row[data-type=net]').filter({hasText:"FANOUT_A"});
  const twist=net.locator(".navp-twisty");
  for(let i=0;i<repeat;i++){
    await measure("navigator-expand-256-pin-net",{type:"click",selector:".navp-twisty"},()=>()=>{
      const row=document.querySelector('.navp-row[data-type=net][aria-expanded=true]'),pins=AtriumNavigatorPanel.rows().filter(r=>r.type==="pin");
      return row?.querySelector(".navp-detail")?.textContent==="256 pins" && pins.length===256 &&
        document.querySelector('.navp-row[data-type=pin] .navp-label')?.textContent==="TP1-1" && pins.length;
    },null,()=>twist.click());
    const number=i%2?1:2, doc=i%2?"local":"remote";
    const target=page.getByText("TP"+number+"-1",{exact:true});
    await measure("navigator-jump-cross-sheet-highlight",{type:"click",selector:".navp-row"},({doc,id})=>()=>{
      const f=window.wafflePinFrame;
      return f?.doc===doc && f.net==="FANOUT_A" && f.selection.includes(id) &&
        document.querySelector('.navp-row[data-type=pin].is-lit') && {doc,id,net:f.net};
    },{doc,id:"pin-"+number},()=>target.click());
    await twist.click();
  }
}

async function rename(env) {
  await netProject(env);
  const {page,repeat,measure}=env;
  await page.evaluate(async()=>{await AtriumLazy.need("AtriumChecks");await AtriumLazy.need("AtriumERC");AtriumChecks.scheduler.plan("erc",{now:true});});
  await page.waitForFunction(()=>AtriumChecks.live().result?.hierarchy.nets.some(n=>n.name==="FANOUT_A" && n.pins.length===256));
  await page.evaluate(()=>AtriumNavHost.act("find-replace"));
  const dialog=page.locator(".fr-dialog"),find=dialog.locator(".fr-find"),replace=dialog.locator(".fr-replace");
  await dialog.getByLabel("Scope",{exact:true}).selectOption("project");
  for(let i=0;i<repeat;i++) {
    const before=i%2?"FANOUT_B":"FANOUT_A",after=i%2?"FANOUT_A":"FANOUT_B";
    await find.fill(before);await replace.fill(after);
    await dialog.locator(".fr-hit").nth(1).waitFor();
    await measure("net-rename-navigator-and-live-erc",{type:"click"},({before,after})=>{
      let navMs,ercMs;
      return ()=>{
        const start=window.waffleResult.input.time;
        const row=document.querySelector('.navp-row[data-type=net] .navp-label');
        if(navMs===undefined && row?.getClientRects().length && row.textContent===after) navMs=performance.now()-start;
        const nets=AtriumChecks.live().result?.hierarchy.nets || [];
        if(ercMs===undefined && nets.some(n=>n.name===after && n.pins.length===256) && !nets.some(n=>n.name===before)) ercMs=performance.now()-start;
        return navMs!==undefined && ercMs!==undefined && {net:after,navMs,ercMs,pins:256};
      };
    },{before,after},()=>dialog.getByRole("button",{name:"Replace All",exact:true}).click());
  }
}

async function schematicPaste({page,repeat,measure,workload}) {
  const set=await page.evaluate(()=>{
    const h=AtriumNavHost,source=h.project().documents.find(d=>d.id==="sheet-m1"),items=source.items.filter(i=>["part","wire","netlabel"].includes(i.kind)).slice(-24);
    h.on("frame",()=>{window.wafflePasteFrame={doc:h.currentId(),tool:h.tool(),selection:h.selection(),revision:h.revision()};});
    return {source:source.id,target:"sheet-m2",ids:items.map(i=>i.id),kinds:items.map(i=>i.kind).sort()};
  });
  workload.copiedObjects=set.ids.length;
  const canvas=page.locator("#canvas");
  for(let i=0;i<repeat;i++){
    await page.evaluate(({source,ids})=>{const h=AtriumNavHost;h.selectDocument(source);h.select(ids);h.canvas().focus();},set);
    await page.keyboard.press("ControlOrMeta+c");
    await page.evaluate(id=>{const h=AtriumNavHost;h.selectDocument(id);h.canvas().focus();},set.target);
    const r=await canvas.boundingBox(),x=r.x+r.width*.45,y=r.y+r.height*.45;
    await page.mouse.move(x,y);
    await measure("schematic-cross-sheet-paste-preview",{type:"keydown",key:"v"},id=>()=>window.wafflePasteFrame?.doc===id &&
      window.wafflePasteFrame.tool==="paste" && id,set.target,()=>page.keyboard.press("ControlOrMeta+v"));
    const before=await page.evaluate(()=>AtriumNavHost.doc().items.length);
    await measure("schematic-cross-sheet-paste-commit",{type:"pointerdown",selector:"#canvas"},({before,set})=>()=>{
      const f=window.wafflePasteFrame,h=AtriumNavHost;
      if(f?.doc!==set.target || f.tool!=="select" || f.selection.length!==set.ids.length ||
        h.doc().items.length!==before+set.ids.length || f.selection.some(id=>set.ids.includes(id)))return;
      const ids=new Set(f.selection),kinds=h.doc().items.filter(o=>ids.has(o.id)).map(o=>o.kind).sort();
      return kinds.join()===set.kinds.join() && kinds.length;
    },{before,set},()=>page.mouse.click(x,y));
    await page.keyboard.press("ControlOrMeta+z");
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.length),before);
  }
}
module.exports={navigator,rename,schematicPaste};
