"use strict";
// Open the frozen 2.0 project through the normal folder grant and persist an
// unrelated net rename. The grant serves private copies of the fixture bytes.
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {pathToFileURL}=require("node:url"),{chromium}=require("../support/playwright.cjs");
const root=path.resolve(process.argv[2] || path.join(__dirname,"../.."));
const fixture=process.env.APRICOT_NOTEBOOK_FIXTURE || path.join(root,"tests/fixtures/format-2/notebook");
const hash=b=>crypto.createHash("sha256").update(b).digest("hex");
function files(dir){
  const out=new Map();
  for(const f of fs.readdirSync(dir,{recursive:true,withFileTypes:true}))if(f.isFile()){
    const name=path.join(f.parentPath || f.path,f.name);out.set(path.relative(dir,name),fs.readFileSync(name));
  }
  return out;
}
async function run(){
  const browser=await chromium.launch({...(process.env.CHROME?{executablePath:process.env.CHROME}:{channel:"chrome"}),
    args:["--allow-file-access-from-files"]});
  const page=await browser.newPage({viewport:{width:1350,height:940}});
  page.setDefaultTimeout(10000);
  const original=files(fixture),disk=new Map(original),writes=[],errors=[],requested=[];
  page.on("pageerror",e=>errors.push(e.message));
  page.on("request",r=>requested.push(new URL(r.url()).pathname.split("/").pop()));
  async function grant(page){
  await page.exposeFunction("readMembers",names=>({files:names.map(name=>{
    const bytes=disk.get(name);assert.ok(bytes,name);return {path:name,data:bytes.toString("base64"),length:bytes.length,sha256:hash(bytes)};
  })}));
  await page.exposeFunction("readImage",({assetRef,offset,length})=>{
    const bytes=disk.get("assets/"+assetRef.sha256),part=bytes.subarray(offset,offset+length);
    return {data:part.toString("base64"),offset,length:part.length,eof:offset+part.length===bytes.length};
  });
  await page.exposeFunction("saveMembers",({plan})=>{
    writes.push(plan);const hashes={};
    for(const member of plan){
      const old=disk.get(member.path);assert.equal(hash(old),member.expected);
      let bytes;
      if(member.data)bytes=Buffer.from(member.data,"base64");
      else {
        const pieces=[];let offset=0;
        for(const edit of member.splice.edits){pieces.push(old.subarray(offset,edit.offset),Buffer.from(edit.insert));offset=edit.offset+edit.remove;}
        bytes=Buffer.concat([...pieces,old.subarray(offset)]);
      }
      disk.set(member.path,bytes);hashes[member.path]=hash(bytes);
    }
    return {saved:true,transaction:"txn-"+writes.length,hashes};
  });
  await page.addInitScript(()=>{
    const entry={grant:"fixture",manifest:"Notebook.waffle",name:"Notebook"};
    window.AtriumHost={platform:"mac",open:async()=>[{name:entry.manifest,folderProject:entry}],finishedOpening(){},markOpened(){},
      folderReadLease:async()=>({lease:"frozen"}),folderRelease:async()=>{},folderClose:async()=>{},folderLocalState:async()=>({}),
      folderAdopt:async()=>true,clearProjectPath(){},setDirty(){},folderRead:q=>readMembers(q.paths),folderCommit:q=>saveMembers(q),folderReadAsset:q=>readImage(q)};
    window.previewDraws={math:[],rich:[],ink:[]};window.nativeEquationOpen=null;
    window.addEventListener("dblclick",event=>{
      const host=window.AtriumNavHost;
      if(!event.isTrusted || !window.AtriumLabs?.notebookEnabled() || event.target!==host?.canvas?.())return;
      const hit=host.hit(event.target,event.clientX,event.clientY);
      if(hit?.item?.id==="math-note" && !window.nativeEquationOpen)window.nativeEquationOpen={event:event.type,at:performance.now()};
    },true);
    for(const [name,key] of [["AtriumMath","math"],["AtriumRichTextView","rich"],["AtriumNotebookImages","image"]]){
      let module;
      Object.defineProperty(window,name,{configurable:true,get(){return module;},set(loaded){
        const method=key==="math"?"drawItem":"draw";
        module={...loaded,[method](ctx,item,...opts){(previewDraws[key] ||= []).push(item.id);return loaded[method](ctx,item,...opts);}};
      }});
    }
    const text=CanvasRenderingContext2D.prototype.fillText;window.seenText=new Set();
    CanvasRenderingContext2D.prototype.fillText=function(s,...a){window.seenText.add(String(s));return text.call(this,s,...a);};
  });
  }
  await grant(page);
  const raw=()=>page.evaluate(()=>JSON.stringify(AtriumNavHost.doc().items.filter(Atrium.notebookItemKind)));
  const state=()=>page.evaluate(()=>({history:AtriumNavHost.undoSteps().history.length,future:AtriumNavHost.undoSteps().future.length,dirty:AtriumNavHost.isDirty()}));
  const select=(...ids)=>page.evaluate(ids=>{AtriumNavHost.select(ids);AtriumNavHost.canvas().focus();},ids);
  const act=id=>page.evaluate(id=>AtriumNavHost.act(id),id);
  const pref=value=>page.evaluate(async value=>{const prefs=await AtriumLazy.need("AtriumPrefs");prefs.set("labs.notebook",value);if(AtriumLabs.notebookEnabled()!==value)throw Error("Labs did not change to "+value);},value);
  async function screenPoint(id,offset=[2.5,2.5]){
    return page.evaluate(async({id,offset})=>{const h=AtriumNavHost,i=h.doc().items.find(x=>x.id===id),v=h.view(),c=h.canvas(),r=c.getBoundingClientRect();
      v.restoreCamera({...v.camera(),cx:i.x+10,cy:i.y+5,scale:7});h.redraw(true);await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const xy=v.worldToScreen([i.x+offset[0],i.y+offset[1]]);
      return [r.left+xy[0],r.top+xy[1]];},{id,offset});
  }
  try{
    await page.goto(pathToFileURL(path.join(root,"app/index.html")).href);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    assert.equal(await page.evaluate(()=>AtriumLabs.notebookEnabled()),false);
    assert.ok(!requested.includes("notebook-compat.js"),"no compatibility reader on an ordinary project");
    await page.evaluate(()=>AtriumPower.setMode("always"));await act("open");
    await page.waitForFunction(()=>AtriumNavHost.folderProject()?.hasPresented("notebook-sheet") && globalThis.AtriumNotebookCompat);
    await page.evaluate(()=>{const h=AtriumNavHost;h.view().fit(h.doc(),h.defs());h.redraw(true);});
    await page.waitForFunction(()=>previewDraws.math.includes("math-note") && previewDraws.rich.includes("rich-note") &&
      previewDraws.image?.includes("photo") && previewDraws.image?.includes("fallback-widget") && seenText.has("Lab") && [...seenText].some(s=>s.includes("☑ Confirm the rail")));
    for(const name of ["rich-text-editor.js","math-editor.js","calculation-sheet.js","sheet-widget-editor.js","rich-text.js","review-notes.js"]){
      assert.ok(!requested.includes(name),name+" must not load to display saved geometry");
    }
    const contrast=await page.evaluate(async()=>{
      const h=AtriumNavHost,doc=h.doc(),items=doc.items,ratios=[];
      for(const theme of ["dark","light"]){
        AtriumTheme.set({preset:theme,followSystem:false},{persist:false});
        for(const print of [false,true]){
          for(const id of ["math-note","rail-calc","sticky-note","callout-note"]){
            const item=items.find(i=>i.id===id),opts={print,includeNotes:true,project:h.project(),scale:6};
            const c=document.createElement("canvas");c.width=Math.ceil(item.w*6);c.height=Math.ceil(item.h*6);
            const g=c.getContext("2d",{willReadFrequently:true});g.scale(6,6);g.translate(-item.x,-item.y);
            const palette=AtriumNotebookCompat.colours(doc,item,opts),paper=print?"#ffffff":AtriumSchAppearance.paper;
            g.fillStyle=paper;g.fillRect(item.x,item.y,item.w,item.h);
            AtriumNotebookCompat.draw(g,item,doc,opts);
            const data=g.getImageData(0,0,c.width,c.height).data,distribution=new Map();
            for(let n=0;n<data.length;n+=4){
              const hex="#"+[data[n],data[n+1],data[n+2]].map(v=>v.toString(16).padStart(2,"0")).join("");
              distribution.set(hex,(distribution.get(hex)||0)+1);
            }
            const foreground=distribution.get(palette.ink);
            if(!foreground)throw Error("No actual ink for "+id+" in "+theme+" print="+print);
            ratios.push({theme,print,id,ink:palette.ink,surface:palette.surface,ratio:AtriumTheme.color.contrast(palette.ink,palette.surface)});
          }
        }
      }
      return ratios;
    });
    assert.ok(contrast.every(v=>v.ratio>=4.5));
    const media=await page.evaluate(async()=>{
      const h=AtriumNavHost,d=h.doc(),p=h.project(),assets=await AtriumNotebookImages.prepareAssets(p,{documentIds:[d.id],resolveAsset:x=>h.folderProject().readAsset(x),scale:4});
      try{
        return ["photo","pdf-clip","fallback-widget","pen-stroke"].map(id=>{
          const item=d.items.find(i=>i.id===id);
          const c=document.createElement("canvas");c.width=Math.ceil(item.w*4);c.height=Math.ceil(item.h*4);
          const g=c.getContext("2d");g.scale(4,4);g.translate(-item.x,-item.y);
          AtriumNotebookCompat.draw(g,item,d,{project:p,assets,scale:4,print:true,includeNotes:true});
          const bytes=g.getImageData(0,0,c.width,c.height).data;
          let copper=0,seen=0;for(let n=0;n<bytes.length;n+=4){if(bytes[n+3])seen++;if(bytes[n]===200&&bytes[n+1]===64&&bytes[n+2]===32)copper++;}
          return {id,seen,copper};
        });
      }finally{assets.release();}
    });
    assert.ok(media.every(v=>v.seen>0));assert.ok(media.slice(0,3).every(v=>v.copper>0));
    const initial=await raw(),before=await state();
    await select("math-note");
    await page.locator("#inspector").getByText("Notebook · Read-only",{exact:true}).waitFor();
    assert.match(await page.locator("#inspector").innerText(),/frac/);
    for(const id of ["sticky-note","review-todo","fallback-widget","rich-note","photo","rail-calc","bench-table"]){
      await select(id);assert.equal(await page.locator("#inspector input,#inspector textarea").count(),0,id);
    }
    const point=await screenPoint("math-note");
    await page.mouse.dblclick(...point);await page.mouse.move(...point);await page.mouse.down();await page.mouse.move(point[0]+70,point[1]+40,{steps:8});await page.mouse.up();
    assert.equal(await page.locator("dialog.math-editor[open]").count(),0);
    await page.keyboard.press("ArrowRight");await page.keyboard.press("Delete");await act("duplicate");
    assert.equal(await page.evaluate(()=>AtriumNavHost.tool()),"select");
    assert.equal(await raw(),initial);assert.deepEqual(await state(),before);
    const rejected=await page.evaluate(async()=>{
      const h=AtriumNavHost,p=h.project(),d=h.doc(),get=id=>d.items.find(i=>i.id===id),note=get("math-note");
      const edit=h.edit(()=>{note.futureField={kept:true};get("plain-label").text="UNEXPECTED";},"Attempt stale property edit",[get("plain-label")]);
      const proposal=await AtriumLazy.need("AtriumProposal"),after=structuredClone(p);
      after.documents.find(v=>v.id===d.id).items.find(i=>i.id===note.id).text="lost";
      const patch=proposal.build(p,after,{allowV1:false}).proposal;
      const applied=proposal.applyChecked(p,patch,{edit:h.edit,trial:false});
      const settings=h.edit(()=>{d.notesLayer.print=true;},"Attempt saved Notes change");
      return {edit,applied,settings,label:h.doc().items.find(i=>i.id==="plain-label").text};
    });
    assert.deepEqual(rejected,{edit:false,applied:0,settings:false,label:"SENSE"});
    assert.equal(await raw(),initial);assert.deepEqual(await state(),before);
    await select("math-note","plain-text");await act("delete");
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.some(i=>i.id==="plain-text")),false);
    assert.equal(await raw(),initial);await act("undo");
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.some(i=>i.id==="plain-text")),true);assert.equal(await raw(),initial);
    await select("plain-label");
    const label=page.locator('#inspector input').filter({visible:true});let edited=false;
    for(const field of await label.all())if(await field.inputValue()==="SENSE"){
      await field.fill("SENSE_RENAMED");await field.press("Enter");edited=true;break;
    }
    assert.equal(edited,true);
    await page.evaluate(()=>AtriumNavHost.saveAll());
    assert.equal(writes.length,1);assert.deepEqual(writes[0].map(i=>i.path),["Notebook.wsch"]);
    for(const [member,bytes] of original){
      if(member!=="Notebook.wsch"){assert.deepEqual(disk.get(member),bytes,member);continue;}
      const diffs=bytes.toString().split("\n").filter((line,i)=>line!==disk.get(member).toString().split("\n")[i]);
      assert.equal(diffs.length,1);assert.equal(JSON.parse(diffs[0]).id,"plain-label");
      assert.equal(disk.get(member).toString(),bytes.toString().replace('"text":"SENSE"}','"text":"SENSE_RENAMED"}'));
    }
    assert.equal(await raw(),initial);
    await select("callout-note");await page.getByRole("button",{name:"Go to callout target"}).click();
    assert.equal(await page.evaluate(()=>AtriumNavHost.selection()[0]),"plain-label");
    await pref(true);await select("math-note");
    await page.mouse.dblclick(...await screenPoint("math-note"));const dialog=page.locator("dialog.math-editor[open]");await dialog.waitFor();
    const firstEquation=await page.evaluate(()=>window.nativeEquationOpen && {...nativeEquationOpen,open:performance.now()});
    assert.equal(firstEquation?.event,"dblclick");assert.ok(firstEquation.open>=firstEquation.at);
    const source=dialog.locator("textarea");await source.fill("V=I R + 1");
    const veto=await page.evaluate(()=>{try{AtriumPrefs.set("labs.notebook",false);}catch{}return AtriumLabs.notebookEnabled();});
    assert.equal(veto,true);assert.equal(await source.inputValue(),"V=I R + 1");
    await source.press("Control+Enter");await dialog.waitFor({state:"detached"});
    const authored=await raw();assert.notEqual(authored,initial);
    await pref(false);await select("math-note");await page.locator("#inspector").getByText("Notebook · Read-only",{exact:true}).waitFor();
    const held=await state();assert.equal(held.dirty,true);
    await act("undo");assert.equal(await raw(),authored);assert.deepEqual(await state(),held);
    await pref(true);await act("undo");assert.equal(await raw(),initial);
    // The folder worker compares the restored journal with the saved member asynchronously.
    await page.waitForFunction(()=>!AtriumNavHost.isDirty());
    await pref(false);const redo=await state();assert.equal(redo.dirty,false);assert.ok(redo.future>0);
    await act("redo");assert.equal(await raw(),initial);assert.deepEqual(await state(),redo);
    assert.equal(writes.length,1,"Undo to saved content and refused Redo must not write to the folder");
    await pref(true);await select("rich-note");await page.mouse.dblclick(...await screenPoint("rich-note"));
    const editor=page.locator(".rn-editor[contenteditable]");await editor.waitFor();
    await editor.fill("Pending rich note");
    await pref(false);await editor.waitFor({state:"detached"});
    assert.equal(await page.evaluate(()=>AtriumNavHost.doc().items.find(i=>i.id==="rich-note").text),"Pending rich note");
    await pref(true);await act("undo");assert.equal(await raw(),initial);
    await select("rich-note");await page.mouse.dblclick(...await screenPoint("rich-note"));await editor.waitFor();
    await editor.evaluate(node=>{node.firstElementChild.dataset.style="unfinished";});
    assert.equal(await page.evaluate(()=>{try{AtriumPrefs.set("labs.notebook",false);}catch{}return AtriumLabs.notebookEnabled();}),true);
    assert.equal(await editor.isVisible(),true);await editor.press("Escape");await pref(false);assert.equal(await raw(),initial);
    // A fresh browser context has never painted this sheet. The normal PDF
    // entry must await its passive readers and resolve the selected assets.
    const cold=await browser.newPage({viewport:{width:1200,height:840}});
    let pdfProof;
    try{
      await grant(cold);cold.on("pageerror",e=>errors.push(e.message));
      await cold.goto(pathToFileURL(path.join(root,"app/index.html")).href);
      await cold.getByRole("button",{name:"Continue to editor",exact:true}).click();
      pdfProof=await cold.evaluate(async()=>{
        const h=AtriumNavHost;await AtriumLazy.need("AtriumFolderProjectUI");
        const folder=await AtriumFolderProject.open({grant:"fixture",manifest:"Notebook.waffle",name:"Notebook"},{host:AtriumHost});
        try{
          await folder.ensureDocument("notebook-sheet",{purpose:"validation"});
          if(h.currentId()==="notebook-sheet" || window.AtriumMath || window.AtriumNotebookImages)throw Error("Print fixture was already rendered");
          const print=await AtriumLazy.need("AtriumPrint"),p=folder.project,id="notebook-sheet",doc=p.documents.find(d=>d.id===id);
          const before=JSON.stringify(p),resolveAsset=q=>folder.readAsset(q);
          const bytes=await print.preparePDF(p,{documents:[id],compress:false,titleBlock:false,scale:"fit"},{resolveAsset});
          const proof={
            pdf:String.fromCharCode(...bytes.subarray(0,5)),
            glyphs:previewDraws.math.includes("math-note"),
            rich:previewDraws.rich.includes("rich-note"),
            hidden:!previewDraws.rich.includes("sticky-note") && !previewDraws.rich.includes("callout-note"),
            image:previewDraws.image?.includes("photo"),fallback:previewDraws.image?.includes("fallback-widget"),
            same:JSON.stringify(p)===before && !folder.dirty,editors:!!(window.AtriumRichText || window.AtriumMathEditor || window.AtriumSheetWidgetEditor)
          };
          const orphan={...p,documents:[{...doc,items:doc.items.filter(i=>i.id==="fallback-widget")}]};
          const isolated=await AtriumNotebookImages.prepareAssets(orphan,{documentIds:[id],resolveAsset});
          try{proof.orphan=!!isolated.get(orphan.documents[0].items[0].widget.fallback.assetRef.sha256)?.bitmap;}finally{isolated.release();}
          let binary="";for(let n=0;n<bytes.length;n+=8192)binary+=String.fromCharCode(...bytes.subarray(n,n+8192));
          return {proof,data:btoa(binary)};
        }finally{await folder.close();}
      });
      const pdf=Buffer.from(pdfProof.data,"base64");delete pdfProof.data;
      assert.deepEqual(pdfProof.proof,{pdf:"%PDF-",glyphs:true,rich:true,hidden:true,image:true,fallback:true,same:true,editors:false,orphan:true});
      assert.match(pdf.toString("latin1"),/\/Subtype \/Image/);assert.match(pdf.toString("latin1"),/\/ActualText/);
      if(process.env.APRICOT_NOTEBOOK_PDF)fs.writeFileSync(process.env.APRICOT_NOTEBOOK_PDF,pdf);
      pdfProof.sha256=hash(pdf);pdfProof.bytes=pdf.length;
    }finally{await cold.close();}
    assert.deepEqual(errors,[]);console.log(JSON.stringify({readOnly:before,protectedItems:JSON.parse(initial).length,changedMembers:writes[0].map(i=>i.path),changedRows:1,transitionAndUndo:true,firstEquation,coldPDF:pdfProof,minContrast:Math.min(...contrast.map(v=>v.ratio)),media,errors}));
  }finally{await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
