"use strict";

const assert=require("node:assert/strict");
async function drawing({page,repeat,measure,workload}) {
  const id=await page.evaluate(async()=>{
    const h=AtriumNavHost,D=AtriumDrawing,doc=h.project().documents.find(d=>d.kind==="drawing");
    await h.selectDocument(doc.id);
    await AtriumLazy.need("AtriumAutosave");
    let id;
    h.edit(()=>{id=D.apply(h.project(),doc,[{op:"add_view",type:"notes",sheet:doc.drawing.sheets[0].id,
      x:28,y:62,options:{width:60}}])[0].id;},"Insert notes view");
    D.selectIds(doc,[id]);
    h.on("frame",()=>{
      if(!window.waffleDrag) return;
      const d=window.waffleDrag,hit=D.inputAt(null,h.view().scale());
      if(hit?.item?.id===id && Math.abs(hit.box[2]-d.origRight)>1)
        d.frame={at:performance.now(),right:hit.box[2],scale:h.doc().drawing.views.find(v=>v.id===id).scale};
    });
    const tx=IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction=function(stores,mode,...rest){
      const t=tx.call(this,stores,mode,...rest), d=window.waffleDrag;
      if(d && this.name==="waffle-editor-drafts" && mode==="readwrite" && Array.from(stores).includes("meta") && Array.from(stores).includes("slots"))
        t.addEventListener("complete",()=>{d.stored=performance.now();},{once:true});
      return t;
    };
    return id;
  });
  workload.drawingView="notes";
  workload.autosaves=[];
  for(let i=0;i<repeat;i++){
    const p=await page.evaluate(({id,i})=>{
      const h=AtriumNavHost,D=AtriumDrawing,d=h.doc(),v=h.view(),scale=4,view=d.drawing.views.find(o=>o.id===id);
      D.selectIds(d,[id]);
      const b=D.inputAt(null,scale).box,handle=[b[2]+1,b[3]+1],dx=(i%2?-1:1)*12;
      v.restoreCamera({...v.camera(),cx:handle[0],cy:handle[1],scale,rotation:0});h.redraw();
      const r=h.canvas().getBoundingClientRect(),from=v.worldToScreen(handle);
      if(!D.inputAt(handle,scale)?.item?.handle)throw Error("Notes resize handle was obscured");
      window.waffleDrag={origRight:b[2],origScale:view.scale};
      const x=r.left+from[0],y=r.top+from[1];
      window.waffleDebug=()=>({i,d:window.waffleDrag,hit:D.inputAt(null,v.scale()),cam:v.camera()});
      return {x,y,toX:x+dx*scale,toY:y+dx*(b[3]-b[1])/(b[2]-b[0])*scale,origScale:view.scale};
    },{id,i});
    await page.mouse.move(p.x,p.y);
    // Time a real asynchronous recovery write. Trigger it on the press so the following
    // movement takes place while the serializer or the IndexedDB write is outstanding.
    await page.evaluate(()=>{
      window.addEventListener("pointerdown",()=>{
        const d=window.waffleDrag;d.saveStart=performance.now();
        d.save=AtriumAutosave.save("auto",false).then(meta=>{
          if(!meta)throw Error("Autosave produced no checkpoint");
          return {revision:meta.revision,bytes:meta.size,backend:AtriumAutosave.backend(),fresh:AtriumAutosave.stats().fresh};
        });
      },{capture:true,once:true});
    });
    await measure("drawing-handle-preview-during-autosave",{type:"pointermove",selector:"#canvas"},()=>()=>{
      const d=window.waffleDrag;
      return d.frame && d.frame.scale===d.origScale && {right:d.frame.right,inputAt:window.waffleResult.input.time};
    },null,async()=>{await page.mouse.down();await page.mouse.move(p.toX,p.toY);});
    const inputAt=await page.evaluate(()=>window.waffleResult.input.time);
    await measure("drawing-handle-release-committed",{type:"pointerup",selector:"#canvas"},({id,scale})=>()=>{
      const f=window.waffleDrag.frame,v=AtriumNavHost.doc().drawing.views.find(o=>o.id===id);
      return f && f.scale===v.scale && v.scale!==scale && v.scale;
    },{id,scale:p.origScale},()=>page.mouse.up());
    const proof=await page.evaluate(async input=>{
      const d=window.waffleDrag,result=await d.save;
      return {...result,inputAfterSaveStartMs:input-d.saveStart,writeCompletedAfterInputMs:d.stored-input};
    },inputAt);
    assert.ok(proof.backend==="indexeddb" && proof.bytes>0 && proof.inputAfterSaveStartMs>=0 && proof.writeCompletedAfterInputMs>=0,
      "Resize must overlap the verified recovery write: "+JSON.stringify(proof));
    workload.autosaves.push(proof);
  }
}
module.exports={drawing};
