"use strict";
// Build detached, serializable art on the editor side before entering the existing
// foreign writer worker. Each source retains its own owner and object identity.
globalThis.AtriumNotebookForeign=(()=>{
  const domains=new Map(),known=new Set(["richtext","math","calculation","widget","sticky","callout","reviewItem","inkStroke","imageMarkup","notebookTable"]);
  function register(kind,project){if(kind==="ink")kind="inkStroke";if(!known.has(kind)||typeof project!=="function")throw Error("Invalid notebook projection.");domains.set(kind,project);}
  function kindOf(i){return i.widget?.state?.tableVersion===1?"notebookTable":i.ink?"inkStroke":i.richText?"richtext":i.math?"math":i.kind;}
  function accepts(i){const kind=kindOf(i);return i.kind==="image"&&!!i.asset || kind==="inkStroke" || kind==="notebookTable" || domains.has(kind);}
  function raster(options,paint){return globalThis.AtriumNotebookImages.staticRaster(options,paint);}
  function fallback(i,why){
    const text=[i.caption,i.alt,i.name,i.fallback?.text,i.text].find(x=>typeof x==="string"&&x.trim())||i.kind;
    return {type:"text",text,box:[i.x||0,i.y||0,(i.x||0)+(i.w||18),(i.y||0)+(i.h||4)],reason:why};
  }
  async function prepare(project,{documentIds,windows,resolveAsset,signal,preparedAssets,scale=12}={}){
    const files=new Set(documentIds||project.documents.map(d=>d.id)),images=globalThis.AtriumNotebookImages;
    const lease=preparedAssets||await images.prepareAssets(project,{documentIds:files,windows,resolveAsset,signal,scale,purpose:"foreign"});
    const out=[];
    try {
      if(!domains.has("inkStroke") && project.documents.some(d=>files.has(d.id)&&d.items?.some(i=>i.ink||i.kind==="inkStroke"))){
        const markup=globalThis.AtriumMarkup || (globalThis.AtriumLazy?.has("AtriumMarkup") && await globalThis.AtriumLazy.need("AtriumMarkup"));
        markup?.registerForeign?.(api);
      }
      if (!domains.has("notebookTable") && project.documents.some(d=>files.has(d.id)&&d.items?.some(i=>i.widget?.state?.tableVersion===1))) {
        const table=globalThis.AtriumTableVisual || await globalThis.AtriumLazy?.need("AtriumTableVisual");table?.registerForeign(api);
      }
      for(const d of project.documents)if(files.has(d.id)&&d.kind==="schematic"){
        const owners=new Map();
        for(const i of d.items)if(accepts(i)&&i.kind!=="imageMarkup"){
          if(signal?.aborted)throw new DOMException("Cancelled","AbortError");
          const kind=kindOf(i),options={doc:d,project,assets:lease,scale,signal,raster};
          const art=i.kind==="image"?images.foreignImage(i,options):domains.has(kind)?await domains.get(kind)(i,options):fallback(i,"The target format retains static text.");
          if(!art || !["image","text"].includes(art.type) || !Array.isArray(art.box) || art.box.length!==4 || !art.box.every(Number.isFinite))throw Error("Invalid notebook export geometry.");
          const row={...art,documentId:d.id,itemId:i.id};
          if(row.type==="image" && (!Number.isSafeInteger(row.width)||!Number.isSafeInteger(row.height)||typeof row.data!=="string"||row.data.length>7999900))throw Error("Invalid static export image.");
          out.push(row);owners.set(i.id,row);
        }
        for(const m of d.items)if(m.kind==="imageMarkup")out.push({type:"child",documentId:d.id,itemId:m.id,owner:m.imageId,
          represented:owners.get(m.imageId)?.type==="image",reason:"Markup is part of its owner's static image."});
      }
      return out;
    }finally{if(!preparedAssets)lease.release();}
  }
  const api=Object.freeze({register,accepts,prepare,raster});
  globalThis.AtriumMarkup?.registerForeign?.(api);
  globalThis.AtriumTableVisual?.registerForeign?.(api);
  return api;
})();
