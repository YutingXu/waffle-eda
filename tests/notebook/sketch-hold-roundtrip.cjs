"use strict";
const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url"),{chromium}=require("../support/playwright.cjs");
const {relay,editor}=require("../project/collab-pair-browser.cjs");
const {input,circle,line,snapped}=require("./sketch-hold-browser.cjs");
const root=path.resolve(__dirname,"../..");

async function exportShape(browser,writers,project) {
  const page=await browser.newPage();
  try{
    await page.goto(pathToFileURL(path.resolve(writers,"app/index.html")).href);
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.project?.());
    if(await page.evaluate(()=>AtriumLazy.modules().includes("AtriumMarkup")))await page.evaluate(()=>AtriumLazy.need("AtriumMarkup"));
    else for(const name of ["sch-note-ink","review-notes-model"])await page.addScriptTag({path:path.join(root,"app",name+".js")});
    const result=await page.evaluate(async p=>{
      await AtriumLazy.need(["AtriumNotebookForeign","AtriumImport"]);
      const d=p.documents[0],i=d.items[0],[art]=await AtriumNotebookForeign.prepare(p,{scale:12});
      const src="data:image/png;base64,"+art.data,image=new Image();image.src=src;await image.decode();
      const canvas=document.createElement("canvas");canvas.width=image.width;canvas.height=image.height;
      const ctx=canvas.getContext("2d");ctx.drawImage(image,0,0);
      const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
      let alpha=0;for(let n=3;n<pixels.length;n+=4)alpha=Math.max(alpha,pixels[n]);
      const centre=pixels[((canvas.height>>1)*canvas.width+(canvas.width>>1))*4+3],outputs=[];
      for(const [name,options] of [["kicad",{documentId:d.id}],["altium",{scope:"project"}],["altium",{documentId:d.id}]]) {
        const output=await AtriumImport.export(name,p,options);
        const back=await AtriumImport.import(output.files.map(f=>({name:f.name,bytes:f.bytes||new TextEncoder().encode(f.text)})));
        const item=back.model.documents[0].items[0];
        outputs.push({kind:item.kind,identical:item.src===src,text:item.text,fidelity:JSON.stringify(output.report).includes(d.id+"/"+i.id)});
      }
      return {alpha,centre,outputs,source:art.itemId===i.id};
    },project);
    assert.equal(result.alpha,71);assert.equal(result.centre,0);assert.ok(result.source);
    assert.ok(result.outputs.every(o=>o.fidelity));assert.ok(result.outputs.slice(0,2).every(o=>o.kind==="image"&&o.identical),JSON.stringify(result.outputs));
    assert.equal(result.outputs[2].kind,"label");assert.match(result.outputs[2].text,/Highlighter stroke, violet/);
    console.log("PASS the actual held highlighter circle survived KiCad and Altium project reimport as the identical PNG, with 71/255 alpha and a transparent centre; Altium sheet-only recorded its text fallback");
  }finally{await page.close();}
}

(async()=>{
  const {p,port}=await relay(),url="ws://127.0.0.1:"+port;
  const browser=await chromium.launch({channel:"chrome",args:["--allow-file-access-from-files"]});
  try{
    const labs={prefs:{"labs.notebook":true}},alice=await editor(browser,port,"Ada",url,labs),bob=await editor(browser,port,"Ben",url,labs),A=alice.page,B=bob.page;
    await Promise.all([A,B].map(x=>x.evaluate(()=>{globalThis.RTCPeerConnection=undefined;})));
    const docId=await A.evaluate(async()=>{const h=AtriumNavHost,p=Atrium.project("Collaborative sketch"),d=Atrium.sheet("schematic","Shape sheet");
      p.documents=[d];await h.replaceProject(p,{force:true,copy:true,dirty:false});h.selectDocument(d.id);return d.id;});
    const invite=await A.evaluate(u=>AtriumCollabLive.start(u),url);
    await B.evaluate(v=>AtriumCollabLive.join(v),invite.text);
    await B.waitForFunction(id=>AtriumCollabLive.session()?.r&&AtriumNavHost.project().documents.some(d=>d.id===id),docId);
    await A.waitForFunction(()=>AtriumCollabLive.peers().length>0);
    for(const page of [A,B])await page.evaluate(async id=>{
      const h=AtriumNavHost;h.selectDocument(id);await AtriumLazy.need("AtriumReviewNotes");
      AtriumReviewNotes.open();
    },docId);
    await B.getByRole("button",{name:"Start sketch",exact:true}).click();
    const ben=await input(B,await B.context().newCDPSession(B),"mouse");
    await ben.trace(line);await snapped(B,"Line");
    await B.evaluate(()=>AtriumNavHost.act("undo"));await ben.event("end");
    assert.equal(await B.evaluate(()=>AtriumNavHost.doc().items.filter(i=>i.ink).length),0,"an empty personal history still cancels wet ink");
    await ben.trace(line);await ben.event("end");
    const benId=await B.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.ink).id);
    await A.waitForFunction(id=>AtriumNavHost.doc().items.some(i=>i.id===id),benId);
    const panel=A.locator("#review-notes-panel");await panel.getByLabel("Drawing tool").selectOption("highlighter");
    await panel.getByLabel("Ink colour").selectOption("violet");
    const ada=await input(A,await A.context().newCDPSession(A),"pen");
    await ada.trace(circle);await snapped(A,"Circle");await ada.event("end");
    const id=await A.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.ink?.brush==="highlighter").id);
    await B.waitForFunction(id=>AtriumNavHost.doc().items.some(i=>i.id===id),id);
    const item=page=>page.evaluate(id=>AtriumNavHost.doc().items.find(i=>i.id===id),id);
    const original=await item(A);assert.deepEqual(await item(B),original);
    await A.evaluate(()=>AtriumNavHost.act("undo"));await B.waitForFunction(id=>!AtriumNavHost.doc().items.some(i=>i.id===id),id);
    assert.ok(await B.evaluate(id=>AtriumNavHost.doc().items.some(i=>i.id===id),benId));
    await A.evaluate(()=>AtriumNavHost.act("redo"));await B.waitForFunction(id=>AtriumNavHost.doc().items.some(i=>i.id===id),id);
    assert.deepEqual(await item(B),original);assert.deepEqual([...alice.errors,...bob.errors],[]);
    console.log("PASS two browser profiles on the encrypted relay converged on identical snapped ink and pressure; empty-history Undo canceled wet ink, personal Undo retained the other author's stroke and Redo restored the same item");
    if(process.argv[2]){
      const project=await A.evaluate(id=>{const p=JSON.parse(JSON.stringify(AtriumNavHost.project()));
        p.documents=p.documents.filter(d=>d.items.some(i=>i.id===id));p.documents[0].items=p.documents[0].items.filter(i=>i.id===id);return p;},id);
      await exportShape(browser,process.argv[2],project);
    }
  }finally{await browser.close();p.kill();}
})().catch(error=>{console.error(error);process.exitCode=1;});
