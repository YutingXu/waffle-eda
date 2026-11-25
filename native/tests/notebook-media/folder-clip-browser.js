"use strict";
globalThis.__uiProbes={run:async(_,input)=>{
  const harness=payload=>webkit.messageHandlers.harness.postMessage(payload);
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(fn){for(let i=0;i<150;i++){const r=fn();if(r)return r;await wait(50);}throw Error("The expected editor state did not appear.");}
  const H=AtriumNavHost,S=H.folderProject(),I=await AtriumLazy.need("AtriumNotebookImageUI"),out={};
  const doc=H.doc(),before=doc.items.length;
  try{
    let row;
    if(input.reopen){
      row=doc.items.find(i=>i.id===input.reopen);
      if(!row?.clip || before!==1)throw Error("The saved clip did not reopen.");
    }else{
      if(!await harness({op:"notebook-fixture-clipboard",pdf:input.pdf}))throw Error("Private pasteboard unavailable.");
      const placement=I.insert({source:"clipboard",point:[14,12]});
      await until(()=>document.querySelector(".notebook-image-dialog button[type=submit]:not(:disabled)"));
      const panel=document.querySelector(".notebook-image-dialog"), labels=[...panel.querySelectorAll("label")];
      function inputNumber(name,n,type){const e=labels.find(l=>l.querySelector("span").textContent===name).querySelector("input");e.value=String(n);e.dispatchEvent(new Event(type));}
      inputNumber("Page",2,"change");
      await until(()=>!panel.querySelector("button[type=submit]").disabled);
      for(const [name,n] of [["Left %",10],["Top %",10],["Right %",40],["Bottom %",40]])inputNumber(name,n,"input");
      panel.querySelector("button[type=submit]").click();
      row=await placement;
      if(!row?.clip||doc.items.length!==before+1)throw Error("Clipped placement missing.");
      await harness({op:"key",key:"s",mods:["meta"]});
      const receipt=await until(()=>S.metrics().lastSave);
      out.written=receipt.paths.sort();
    }
    out.page=row.clip.page;out.region=row.clip.region;out.extent=row.extent;out.source=row.clip.source;out.snapshot=row.asset;out.id=row.id;out.docId=doc.id;
    const read=await S.readAsset({ownerId:doc.id,assetRef:row.asset,purpose:"saved-clip"});
    if(!read)throw Error("The keyboard save did not retain this clip.");
    const source=await S.readAsset({ownerId:doc.id,assetRef:row.clip.source,purpose:"source-page"});
    if(source.bytes.length!==input.length)throw Error("The saved datasheet changed.");
    out.originalBytes=source.bytes.length;
    out.sheetCountAfter=doc.items.length;
    if(input.reopen){
      const images=await AtriumLazy.need("AtriumNotebookImages");
      const prepared=await images.prepareAssets({documents:[doc]},{scale:32});
      try{
        const pixels=prepared.get(row.asset.sha256);
        if(!pixels?.rgba || pixels.width!==row.extent[0] || pixels.height!==row.extent[1])throw Error("The saved region could not be sampled at its original resolution.");
        let red=0;
        for(let i=0;i<pixels.rgba.length;i+=4)if(pixels.rgba[i]===255&&pixels.rgba[i+1]===0&&pixels.rgba[i+2]===0&&pixels.rgba[i+3]===255)red++;
        out.redPixels=red;
        if(red!==pixels.width*pixels.height)throw Error("The saved region differs from the selected red quadrant.");
      }finally{prepared.release();}
    }
  }catch(e){out.error=String(e.message||e);out.stack=e.stack;}
  await harness({op:"save",name:"folder-clip.json",text:JSON.stringify(out)});
  if(out.error)throw Error(out.error);
  return true;
}};
