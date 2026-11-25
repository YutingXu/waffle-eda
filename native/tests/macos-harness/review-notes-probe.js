"use strict";
// Inject as HARNESS_PROBES with HARNESS_SUITE=ui. This runs inside the
// nonpersistent desktop WKWebView and edits only the synthetic project below.
globalThis.__uiProbes={async run(){
  const post=(ok,name,detail)=>webkit.messageHandlers.harness.postMessage({op:"log",ok,name,detail:detail||null});
  const wait=ms=>new Promise(r=>setTimeout(r,ms));
  async function until(fn,message){for(let n=0;n<100;n++){const v=fn();if(v)return v;await wait(30);}throw Error(message);}
  const h=AtriumNavHost,p=Atrium.project("Native notes"),d=Atrium.sheet("schematic","Notes sheet");
  p.documents=[d];d.items=[{id:"sense",kind:"label",text:"SENSE",x:40,y:30}];
  await h.replaceProject(p,{force:true,copy:true,dirty:false});h.selectDocument(d.id);h.canvas().focus();
  const errors=[];window.addEventListener("error",e=>errors.push(e.message));
  try{
    await h.act("insert-palette");
    const q=await until(()=>document.querySelector("dialog[open] input"),"Insert palette did not open");
    q.value="Sticky note";q.dispatchEvent(new Event("input",{bubbles:true}));
    (await until(()=>Array.from(document.querySelectorAll('dialog[open] [role="option"]')).find(o=>o.textContent.includes("Sticky note")),"Sticky note did not appear")).click();
    await until(()=>d.items.find(i=>i.sticky),"Sticky note did not insert");
    const editor=await until(()=>document.querySelector('[contenteditable="true"][aria-label="Engineering note"]'),"In-place editor did not open");
    editor.textContent="WK verification";editor.dispatchEvent(new Event("input",{bubbles:true}));
    (await until(()=>document.querySelector('button[aria-label="Finish editing"],button[title="Finish editing"]'),"Rich editor Done control missing")).click();
    const sticky=await until(()=>d.items.find(i=>i.sticky&&i.text==="WK verification"),"Rich edit did not commit");
    post(true,"Native palette inserted a sticky and committed rich text");
    const ui=AtriumReviewNotes;h.select(["sense"]);const call=ui.place("callout",[50,28],"Check net");
    await until(()=>document.querySelector('[contenteditable="true"][aria-label="Engineering note"]'),"Callout rich editor did not open");
    document.querySelector('button[aria-label="Finish editing"],button[title="Finish editing"]').click();
    const before=AtriumMarkup.read(p,d,call).anchor;
    h.select(["sense"]);h.act("delete");const gone=AtriumMarkup.read(p,d,call).anchor;h.act("undo");
    post(before.live && !gone.live && AtriumMarkup.read(p,d,call).anchor.live,"Native deleting and undoing the target preserved its callout");
    const list=ui.place("reviewChecklist",[64,42],"Verify sensor rail"),row=list.widget.state.rows[0];
    const check=document.querySelector('#review-notes-panel input[aria-label="Verify sensor rail"]');check.click();
    post(AtriumReviewComments.thread(p,row.threadId)?.status==="resolved","Native checklist resolved the linked Review thread");
    h.act("undo");post(AtriumReviewComments.thread(p,row.threadId)?.status==="open","Native Undo reopened the same thread");
    h.select([sticky.id]);ui.place("sketch",[0,0]);const c=h.canvas(),r=c.getBoundingClientRect();
    for(const [j,phase] of ["down","move","up"].entries())c.dispatchEvent(new PointerEvent("pointer"+phase,{pointerType:"pen",pointerId:8,isPrimary:true,
      clientX:r.left+60+j*12,clientY:r.top+95+j*3,button:phase==="move"?-1:0,buttons:phase==="up"?0:1,pressure:phase==="down"?.3:phase==="up"?0:.8,bubbles:true,cancelable:true}));
    const ink=d.items.find(i=>i.ink);post(!!ink&&AtriumMarkup.points(ink).length>=2,"WK pointer samples produced a compact stroke");
    h.act("undo");post(!d.items.some(i=>i.ink),"Native Undo removed the whole stroke");
    post(!errors.length,"No native page errors",errors.join(", "));return "Complete";
  }catch(error){post(false,"Native Notes workflow",error.message);return "Incomplete";}
}};
