"use strict";
globalThis.__uiProbes={run:async(_,input)=>{
  const harness=payload=>webkit.messageHandlers.harness.postMessage(payload);
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(test,why){
    for(let n=0;n<160;n++){const value=test();if(value)return value;await wait(50);}
    throw Error(why);
  }
  const h=AtriumNavHost,session=h.folderProject(),out={};
  const ensure=(ok,message)=>{if(!ok)throw Error(message);};
  try{
    if(input.reopen){
      ensure(session.getDocumentRef(input.reopen),"A new process could not find the child in the manifest.");
      await h.selectDocument(input.reopen);
      const child=h.doc(),items=child.items.filter(i=>i.asset?.sha256===input.sha256);
      ensure(items.length===2 && items[0].id!==items[1].id,"The two saved placements did not reopen.");
      const {bytes}=await session.readAsset({ownerId:child.id,assetRef:items[0].asset,purpose:"saved-photo"});
      out.reopenedItems=items.length;out.reopenedBytes=bytes.length;
      if(input.editMarks){
        const beforeMarkup=Atrium.clone(h.project());
        const ui=await AtriumLazy.need("AtriumNotebookImageUI");
        const editing=ui.edit(items[0]), panel=await until(()=>document.querySelector(".notebook-image-dialog[open]"),"Missing image edit dialog.");
        const fields=new Map([...panel.querySelectorAll("label")].map(label=>[label.querySelector("span").textContent,label.querySelector("input,select")]));
        function change(key,value,event="input"){const control=fields.get(key);control.value=String(value);control.dispatchEvent(new Event(event));}
        for(const [key,value] of [["Caption","Board photo"],["Alt text","Two colour pads"],["Rotation °",90],["Left %",10],["Right %",95]])change(key,value);
        const add=[...panel.querySelectorAll("button")].find(b=>b.textContent==="Add mark");
        for(const shape of ["arrow","ellipse","box","highlight","text"]){
          change("Tool",shape,"change");
          for(const [key,value] of [["Left %",80],["Top %",20],["Right %",25],["Bottom %",shape==="arrow"?20:75]])change(key,value);
          if(shape==="text")change("Markup text","Test pin");
          add.click();
        }
        panel.querySelector("button[type=submit]").click();
        ensure(await editing,"The edit was cancelled.");
        const marks=child.items.filter(i=>i.imageId===items[0].id);
        ensure(marks.length===5 && marks[0].at[1]===marks[0].to[1],"The horizontal arrow or another mark was lost.");
        ensure(String(items[0].crop)==="100000,0,950000,1000000"&&items[0].angle===90&&items[0].caption==="Board photo"&&items[0].alt==="Two colour pads",
          "Adding a mark changed the placement crop or discarded a caption.");
        const [notebook,diff,,print]=await AtriumLazy.need(["AtriumNotebook","AtriumDiff","AtriumProjectHistoryData","AtriumPrint"]);
        const pin=marks.find(i=>i.shape==="text");
        h.select([pin.id],pin.id);
        const row=notebook.read(h.project(),{docId:child.id,itemId:h.selection()[0]}).rows[0];
        ensure(row?.type==="image-markup"&&row.text==="Test pin"&&!row.fields.length,"The selected annotation lost its accessible text.");
        const notes=diff.compare(beforeMarkup,h.project(),{validate:false}).changes.filter(c=>c.category==="notes");
        ensure(notes.some(change=>change.after?.text==="Test pin")&&
          AtriumHistorySummary.fromProjects(beforeMarkup,h.project(),"all").regions.some(r=>r.group==="Notes"),
        "History lost the annotation text or its Notes region.");
        const assets=await AtriumNotebookImages.prepareAssets(h.project(),{documentIds:[child.id]});
        try{
          const pages=print.build(h.project(),{documents:[child.id],assets,includeNotes:true}).pages;
          ensure(pages.some(page=>page.list.some(op=>op.k==="t"&&op.u==="Test pin")),"The PDF omitted the attached annotation text.");
        }finally{assets.release();}
        out.annotationText=row.text;
        h.canvas().focus();await harness({op:"key",key:"s",mods:["meta"]});
        await until(()=>session.metrics().lastSave&&!session.pendingSave,"The five image marks were not saved.");
        out.markCount=marks.length;out.crop=items[0].crop;out.angle=items[0].angle;
      }
    }else{
      await h.requireProjectClosure({purpose:"project"});
      const cover=h.doc(),board=h.project().documents.find(i=>i.kind==="pcb");
      await h.selectDocument(board.id);
      const marker=board.items[0];
      h.edit(()=>{marker.x+=.127;},"Move board marker",[marker.id],{documents:[board.id],items:[marker.id]});
      ensure(session.modified(board.id),"The independent board edit was not registered.");
      await h.selectDocument(cover.id);
      h.act("add-schematic");
      const field=await until(()=>document.querySelector('dialog[open] input[aria-label="Add schematic sheet"]'),"Missing Add Schematic dialog.");
      field.value="New photo sheet";field.form.requestSubmit();
      const child=await until(()=>h.doc().kind==="schematic"&&h.doc().id!==cover.id&&h.doc(),"The new schematic was not selected.");
      ensure(!session.getDocumentRef(child.id),"The child was already on disk before its first save.");
      const ui=await AtriumLazy.need("AtriumNotebookImageUI");
      async function place(point){
        ensure(await harness({op:"notebook-fixture-clipboard",png:input.png}),"The private clipboard could not stage the synthetic PNG.");
        const item=await ui.insert({source:"clipboard",point});
        ensure(item?.asset?.sha256===input.sha256 && child.items.includes(item),"The new image was not placed in the unpublished child.");
        return item;
      }
      async function save(){
        const previous=session.metrics().lastSave;
        h.canvas().focus();
        await harness({op:"key",key:"s",mods:["meta"]});
        return until(()=>{const r=session.metrics().lastSave;return r&&r!==previous&&!session.pendingSave&&r;},
          "No new durable receipt arrived after Command-S.");
      }
      const item=await place([7,9]);
      const before=await session.readAsset({ownerId:child.id,assetRef:item.asset,purpose:"preview"});
      ensure(before.bytes.length===input.length,"The original photo preview is missing.");
      out.id=child.id;out.firstPaths=(await save()).paths.slice().sort();
      const owner=session.getDocumentRef(child.id)?.path,blob="assets/"+item.asset.sha256;
      out.owner=owner||null;out.otherDirty=session.modified(board.id);out.childDirty=session.modified(child.id);
      const expected=[owner,blob,session.manifestPath].sort();
      ensure(owner&&JSON.stringify(out.firstPaths)===JSON.stringify(expected),"The first save acknowledged an incomplete owner, manifest or PNG.");
      ensure(out.otherDirty&&!out.childDirty,"The first save cleared the wrong owner.");
      await place([15,20]);
      out.secondPaths=(await save()).paths.slice().sort();
      ensure(JSON.stringify(out.secondPaths)===JSON.stringify([owner]),"Reusing the photo wrote files outside the child.");
      ensure(session.modified(board.id)&&!session.modified(child.id),"The second save cleared the wrong owner.");
    }
  }catch(e){out.error=e.message;out.stack=e.stack;}
  await harness({op:"save",name:"folder-clip.json",text:JSON.stringify(out)});
  if(out.error)throw Error(out.error+" "+JSON.stringify(out));
  return true;
}};
