"use strict";
// Transfer the original verified attachment bytes with a local clipboard entry. User-pinned
// bytes use the browser's per-user database. Placement uses the ordinary native asset grant.
globalThis.AtriumClipboardMedia=(()=>{
  const G=globalThis, memory=new Map(),pending=new WeakMap();
  const MAX=48*1024*1024;
  let opening,total=0,armed=null;
  function db(){return opening||=new Promise(resolve=>{
    try{const q=indexedDB.open("waffle-clipboard-media",1);q.onupgradeneeded=()=>q.result.createObjectStore("entries");q.onsuccess=()=>resolve(q.result);q.onerror=q.onblocked=()=>resolve(null);}
    catch{resolve(null);}
  });}
  const fileSize=bytes=>bytes?.size ?? bytes?.byteLength;
  function sizeOf(files){
    if(!Array.isArray(files)||!files.length)return null;
    let bytes=0;
    for(const file of files){
      const size=fileSize(file?.bytes);
      if(!file?.ref?.sha256||!Number.isSafeInteger(size)||size<=0)return null;
      bytes+=size;
      if(bytes>MAX)return null;
    }
    return bytes;
  }
  function forgetMemory(id){
    const old=memory.get(id);
    if(old)total-=old.bytes;
    memory.delete(id);
  }
  function remember(id,files,saved=false){
    const bytes=sizeOf(files);
    if(bytes===null)return null;
    const used=()=>total-(memory.get(id)?.bytes||0)+bytes;
    for(const [key,value] of memory){
      if(used()<=MAX)break;
      if(key!==id&&value.saved)forgetMemory(key);
    }
    if(used()>MAX)return null;
    forgetMemory(id);
    memory.set(id,{files,bytes,saved});total+=bytes;
    return bytes;
  }
  async function get(id){
    if(memory.has(id))return memory.get(id).files;
    const d=await db();if(!d)return null;
    const files=await new Promise(resolve=>{const q=d.transaction("entries").objectStore("entries").get(id);
      q.onsuccess=()=>resolve(q.result);q.onerror=()=>resolve(null);});
    if(memory.has(id))return memory.get(id).files;
    if(sizeOf(files)===null || G.AtriumClipHistory?.contains(id)===false)return null;
    remember(id,files,true);
    return files;
  }
  // Only IDs whose metadata was successfully saved are eligible. A single read/write
  // transaction applies the cap across all records and removes older orphaned bytes.
  async function sync(ids){
    const d=await db();if(!d)return false;
    return new Promise(resolve=>{
      const tx=d.transaction("entries","readwrite"), table=tx.objectStore("entries");
      const disk=new Map(), retained=new Map();
      let limited=false;
      const scan=table.openCursor();
      scan.onsuccess=()=>{
        const row=scan.result;
        if(row){disk.set(row.key,row.value);row.continue();return;}
        let bytes=0;
        for(const id of new Set(ids)){
          const entry=memory.get(id), existing=disk.get(id), files=entry?.files ?? existing;
          if(!files)continue;
          const size=entry?.bytes ?? sizeOf(files);
          if(size===null||bytes+size>MAX){limited=true;continue;}
          bytes+=size;retained.set(id,files);
          if(!existing||entry&&!entry.saved)table.put(files,id);
        }
        for(const id of disk.keys())if(!retained.has(id))table.delete(id);
      };
      tx.oncomplete=()=>{
        for(const [id,entry] of memory)entry.saved=retained.get(id)===entry.files;
        resolve(!limited);
      };
      tx.onerror=tx.onabort=()=>resolve(false);
    });
  }
  async function forget(id){
    forgetMemory(id);
    const d=await db();if(!d)return false;
    return new Promise(resolve=>{
      const tx=d.transaction("entries","readwrite");
      tx.objectStore("entries").delete(id);
      tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>resolve(false);
    });
  }
  function refs(items){
    const m=new Map();for(const item of items)if(item.kind==="image"&&item.asset){
      for(const ref of [item.asset,item.clip?.source])if(ref)m.set(ref.sha256,ref);
    }return [...m.values()];
  }
  async function capture(entry,session,doc,items,provided){
    if(!session?.readAsset||!doc)return;
    const values=refs(items),files=[];
    let totalBytes=0;
    if(values.reduce((n,ref)=>n+(ref.byteLength||0),0)>MAX)
      throw Error("This clipboard entry exceeds the 48 MiB limit for original images.");
    for(const ref of values){
      const bytes=provided?.get(ref.sha256)|| (await session.readAsset({ownerId:doc.id,assetRef:ref,purpose:"preview"})).bytes;
      const size=fileSize(bytes);
      if(!Number.isSafeInteger(size)||size<=0||totalBytes+size>MAX)
        throw Error("This clipboard entry exceeds the 48 MiB limit for original images.");
      totalBytes+=size;
      files.push({ref,bytes:typeof Blob==="function"?new Blob([bytes],{type:ref.mediaType}):bytes});
    }
    if(!files.length||!G.AtriumClipHistory?.contains(entry.id))return;
    const cost=remember(entry.id,files);
    if(cost===null)throw Error("The clipboard has reached its 48 MiB limit for original images.");
    G.AtriumClipHistory.setMediaSize?.(entry.id,cost);
  }
  async function release(transfer){if(!transfer)return;for(const t of transfer.temps.splice(0))await Promise.resolve(transfer.session.releaseAsset?.({assetToken:t.assetToken})).catch(()=>{});}
  function cancel(which=armed){
    if(!which)return;
    if(which===armed)armed=null;
    release(which);
  }
  async function prepare(id,clip,host,{document,isCurrent}={}){
    const attachments=refs(clip.items);if(!attachments.length)return;
    const session=host.folderProject?.(), doc=document ?? host.doc();
    if(!session?.readAsset)throw Error("Open a folder project to paste this image.");
    const valid=()=>!!doc && session===host.folderProject?.() &&
      (isCurrent ? isCurrent() : document ? doc===host.docById(doc.id) : doc===host.doc());
    if(!valid())throw Error("The paste target changed.");
    if(session.canEdit?.(doc.id)===false)throw Error("This Waffle document is read-only.");
    cancel();
    const x={session,doc,temps:[],followFocus:!document};armed=x;
    const current=()=>armed===x&&valid()&&session.canEdit?.(doc.id)!==false;
    try{
      const files=await get(id);
      for(const ref of attachments){
        if(!current())throw Error("The paste target changed.");
        const r=files?.find(f=>f.ref.sha256===ref.sha256);
        if(!r){await session.readAsset({ownerId:doc.id,assetRef:ref,purpose:"preview"});continue;}
        const file=new File([r.bytes],"clipboard",{type:ref.mediaType});
        const staged=await G.AtriumHost.notebookTransfer({grant:session.grant,ownerId:doc.id,file,mediaType:ref.mediaType});
        if(staged?.assetToken)x.temps.push(staged);
        if(!staged?.assetToken||staged.ownerId!==doc.id||staged.assetRef?.sha256!==ref.sha256||staged.assetRef?.mediaType!==ref.mediaType||staged.assetRef?.byteLength!==ref.byteLength||!current())throw Error("The original clipboard attachment could not be verified.");
      }
      if(!current())throw Error("The paste target changed.");
      pending.set(clip,x);
    }catch(e){if(armed===x)armed=null;await release(x);throw e;}
  }
  function commit(clip,doc,x=pending.get(clip)){
    if(!x)return;
    if(x!==armed||doc!==x.doc)throw Error("The paste target changed.");
    for(const t of x.temps)x.session.stageAttachment(t);
    x.temps.length=0;pending.delete(clip);armed=null;
  }
  async function artwork(id,items,signal,pixels=120){
    const needed=refs(items).filter(r=>r.mediaType?.startsWith("image/"));
    if(!needed.length)return null;
    const files=await get(id);if(!files)return null;
    await G.AtriumLazy.need(["AtriumNotebookMedia","AtriumNotebookImages"]);
    const assets=new Map();
    try{for(const ref of needed){
      const f=files.find(x=>x.ref.sha256===ref.sha256);if(!f)continue;
      if(signal?.aborted)throw new DOMException("Cancelled","AbortError");
      const raw=f.bytes.arrayBuffer?await f.bytes.arrayBuffer():f.bytes;
      assets.set(ref.sha256,await G.AtriumNotebookMedia.decode(raw,ref,{pixels,signal}));
    }return assets;}catch(e){close(assets);throw e;}
  }
  function close(assets){for(const asset of assets?.values()||[])asset.close?.();}
  return Object.freeze({capture,sync,forget,prepare,commit,binding:clip=>pending.get(clip),cancel,
    cancelClip(clip){const transfer=pending.get(clip);if(transfer)cancel(transfer);},
    cancelFocusChange(){if(armed?.followFocus)cancel();},artwork,close,bytes:()=>total});
})();
