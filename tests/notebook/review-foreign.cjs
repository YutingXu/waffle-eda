"use strict";
// Pass a #38 checkout until its two writers and #40's source share a checkout.
const assert=require("node:assert/strict"),path=require("node:path"),{pathToFileURL}=require("node:url"),{chromium}=require("playwright-core");
const source=path.resolve(__dirname,"../.."),root=path.resolve(process.argv[2]||source);
(async()=>{
  const browser=await chromium.launch({channel:"chrome",args:["--allow-file-access-from-files"]});
  try{
    const page=await browser.newPage();
    await page.goto(pathToFileURL(path.join(root,"app/index.html")).href);
    await page.waitForFunction(()=>globalThis.AtriumNavHost?.project?.());
    const registered=await page.evaluate(()=>AtriumLazy.modules().includes("AtriumMarkup"));
    if(registered)await page.evaluate(()=>AtriumLazy.need("AtriumMarkup"));
    else for(const name of ["sch-note-ink","review-notes-model"])await page.addScriptTag({path:path.join(source,"app",name+".js")});
    const r=await page.evaluate(async()=>{
      await AtriumLazy.need(["AtriumImport","AtriumNotebookForeign"]);
      const p=Atrium.project("Static ink"),d=Atrium.sheet("schematic","Sketch sheet");
      d.id="sheet";p.documents=[d];
      const i=AtriumMarkup.stroke([[10,14,30],[30,34,110],[30,14,210],[10,34,255]],"highlighter","violet",2);
      i.id="freehand";d.items=[i];
      const [art]=await AtriumNotebookForeign.prepare(p,{scale:12});
      const src="data:image/png;base64,"+art.data,img=new Image();img.src=src;await img.decode();
      const canvas=document.createElement("canvas");canvas.width=img.naturalWidth;canvas.height=img.naturalHeight;
      const g=canvas.getContext("2d");g.drawImage(img,0,0);
      const pixel=(x,y)=>Array.from(g.getImageData(Math.floor((x-art.box[0])/(art.box[2]-art.box[0])*canvas.width),
        Math.floor((y-art.box[1])/(art.box[3]-art.box[1])*canvas.height),1,1).data);
      const rows=[];
      for(const [id,options] of [["kicad",{documentId:d.id}],["altium",{scope:"project"}],["altium",{documentId:d.id}]]) {
        // Give the actual worker exporter the authored project. It prepares art,
        // chooses the target representation and constructs its own fidelity rows.
        const out=await AtriumImport.export(id,p,options);
        const files=out.files.map(f=>({name:f.name,bytes:f.bytes||new TextEncoder().encode(f.text)}));
        const back=await AtriumImport.import(files);
        const kept=back.model.documents[0].items[0];
        rows.push({id,scope:options.scope||"sheet",kind:kept.kind,extent:[kept.w,kept.h],same:kept.src===src,text:kept.text,
          fidelity:JSON.stringify(out.report).includes("sheet/freehand"),files:files.map(f=>f.name)});
      }
      return {rows,cross:pixel(20,24),line:pixel(15,19),box:art.box,size:[art.width,art.height],source:art.itemId};
    });
    assert.deepEqual(r.box,[9,13,31,35]);assert.equal(r.source,"freehand");assert.deepEqual(r.size,[264,264]);
    assert.deepEqual(r.cross,r.line);assert(Math.abs(r.cross[3]-255*.28)<=1);
    for(const row of r.rows){assert(row.fidelity,JSON.stringify(row));if(row.id==="kicad"||row.scope==="project"){
      assert.equal(row.kind,"image");assert.ok(row.same);assert(row.extent.every(v=>Math.abs(v-22)<.001));
    }else{assert.equal(row.kind,"label");assert.match(row.text,/Highlighter.*violet/);}}
    console.log(JSON.stringify(r));
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
