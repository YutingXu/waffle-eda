"use strict";
// Host and browser file controls used directly by the editor.
Object.assign(globalThis.AtriumIO ??= {}, (() => {
  function browserSave(name,text) {
    const url=URL.createObjectURL(new Blob([text],{type:"application/octet-stream"}));
    const a=document.createElement("a");a.href=url;a.download=name;document.body.append(a);a.click();a.remove();
    setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  // Incremental saving (save-cache.js, loaded on first use): the canonical text is rebuilt from
  // cached per-object text, and a native host gets a patch for the file it opened (Save) or the
  // save panel (Save As, a new project). o.as: always show the save panel.
  const G=globalThis;
  if(G.AtriumLazy?.register&&!G.AtriumSaveCache)AtriumLazy.register("AtriumSaveCache",{scripts:["project/save-cache.js"]});
  async function serializer(){
    if(G.AtriumSaveCache)return G.AtriumSaveCache;
    try{return G.AtriumLazy?await AtriumLazy.need("AtriumSaveCache"):null;}catch{return null;}
  }
  async function exportFile(name,text){
    if(globalThis.AtriumHost?.exportFile)return await AtriumHost.exportFile(name,text);
    browserSave(name,text);return true;
  }
  async function exportBinaryCopy(name,bytes,sourceFile){
    const review=G.AtriumDesignReview||await AtriumLazy.need("AtriumDesignReview");
    return review.exportBinaryCopy(name,bytes,sourceFile);
  }
  function pickFile(exts){
    if(globalThis.AtriumHost?.pickFile)return AtriumHost.pickFile(exts);
    return new Promise(resolve=>{const f=document.createElement("input");f.type="file";f.accept=exts.join(",");f.hidden=true;document.body.append(f);
      const done=v=>{f.remove();resolve(v);};f.addEventListener("change",()=>done(f.files[0]||null),{once:true});f.addEventListener("cancel",()=>done(null),{once:true});f.click();
    });
  }
  return {serializer,pickFile,exportFile,exportBinaryCopy};
})());
