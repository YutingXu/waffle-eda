"use strict";

globalThis.AtriumSelectionClipboard=(()=>{
  const mime="application/x-waffle-selection+json",marker="\nWaffle-Selection/1\n",maxLength=16*1024*1024;
  // Every object kind each editor's model accepts (power ports, buses and pours too), so a copy
  // that pastes in its own window also pastes from another window or the clipboard history.
  const kinds={schematic:new Set(["part","wire","junction","label","netlabel","graphic","power","port","offsheet","sheetsymbol","bus","busentry","noerc","textframe","image","imageMarkup"]),
    pcb:new Set(["part","track","via","pad","label","graphic","polygon"])};
  function fits(text){
    if(text.length>maxLength)return false;
    if(text.length<=maxLength/3)return true;
    let size=0;
    for(let i=0;i<text.length;i++){
      const code=text.charCodeAt(i);
      if(code<128)size++;
      else if(code<2048)size+=2;
      else if(code>=0xd800 && code<=0xdbff && text.charCodeAt(i+1)>=0xdc00 && text.charCodeAt(i+1)<=0xdfff){size+=4;i++;}
      else size+=3;
      if(size>maxLength)return false;
    }
    return true;
  }
  function summarize(kind,items){
    const names=items.slice(0,4).map(i=>String(i.ref||i.text||i.net||i.kind).replace(/[\r\n]+/g," ").slice(0,48));
    return "Waffle "+(kind==="pcb"?"PCB":"schematic")+" · "+items.length+" "+(items.length===1?"object":"objects")+" · "+names.join(", ")+(items.length>4?"…":"");
  }
  function encode(clip,token){
    const {kind,origin,items,library,blobs,calculationProject,calculationDoc}=clip;
    const summary=summarize(kind,items);
    const data=JSON.stringify({format:"atrium-selection",version:1,token,kind,origin,items,library,blobs,calculationProject,calculationDoc,noteProject:clip.noteProject,noteDoc:clip.noteDoc});
    if(!fits(data))throw Error("This selection exceeds the 16 MiB clipboard limit.");
    return {summary,data};
  }
  function fromText(text){
    if(typeof text!=="string" || text.length>maxLength+512 || !text.startsWith("Waffle "))return null;
    const at=text.indexOf(marker);
    return at>0 && at<512?text.slice(at+marker.length):null;
  }
  function decode(wire){
    if(typeof wire!=="string" || !wire || !fits(wire))throw Error("Choose a Waffle object selection to paste.");
    const v=JSON.parse(wire);
    if(!v || v.format!=="atrium-selection" || v.version!==1 || !["pcb","schematic"].includes(v.kind) ||
       typeof v.token!=="string" || !v.token || v.token.length>128 || !Array.isArray(v.origin) || v.origin.length!==2 || !v.origin.every(n=>Number.isFinite(n)&&Math.abs(n)<1e8) ||
       !Array.isArray(v.items) || !v.items.length || !Array.isArray(v.library))throw Error("Invalid Waffle selection on the clipboard.");
    if(v.items.some(i=>!i || !kinds[v.kind].has(i.kind)))throw Error("The clipboard contains an object from another editor.");
    const doc=Atrium.sheet(v.kind,"Clipboard");
    doc.items=v.items;
    Atrium.validate({format:"atrium",version:1,name:"Clipboard",documents:[doc],library:v.library});
    // Only a cut owned by this editor can restore identities or native source records.
    // 3D models of the copied parts (project.blobs entries), well-formed ones only.
    const b=v.blobs&&typeof v.blobs==="object"?Object.fromEntries(Object.entries(v.blobs).filter(([k,x])=>/^[0-9a-f]{64}$/.test(k)&&typeof x?.stepText==="string")):{};
    const owner=typeof v.calculationProject==="string"&&typeof v.calculationDoc==="string"?{calculationProject:v.calculationProject,calculationDoc:v.calculationDoc}:{};
    return {kind:v.kind,origin:v.origin,items:v.items,library:v.library,...owner,...(typeof v.noteProject==="string" && typeof v.noteDoc==="string"?{noteProject:v.noteProject,noteDoc:v.noteDoc}:{}),...(Object.keys(b).length?{blobs:b}:{}),cut:false,doc:null};
  }
  function validTarget(target){
    if(document.querySelector("dialog[open]"))return false;
    if(target?.isContentEditable||target?.closest?.("input,textarea,select,[contenteditable]:not([contenteditable=false]),[role=textbox]"))return false;
    return !globalThis.window?.getSelection?.()?.toString();
  }
  function remember(job){
    try{
      const h=globalThis.AtriumClipHistory, source=job.owner?.name;
      if(h)h.recordSelection(job,source);
      else globalThis.AtriumLazy?.need("AtriumClipHistory").then(m=>m.recordSelection(job,source)).catch(()=>{});
    }catch{/* History is optional. */}
  }
  let active=null;
  function install({capture,store,local,place,report,context,attachment,memberFiles,revision=()=>null}){
    let current=null,pending=null,serial=0;
    const host=()=>globalThis.AtriumHost;
    function stage(cut){
      const clip=capture(cut);if(!clip)return null;
      const version=revision(),owner=context(),id=++serial,packet=encode(clip,Atrium.id());
      return {clip,cut,version,owner,id,packet};
    }
    function finish(job){
      if(job.done || serial!==job.id || job.owner!==context() || job.version!==revision())return;
      const owner=job.owner && typeof job.owner==="object" && typeof WeakRef==="function"?new WeakRef(job.owner):null;
      current={data:job.packet.data,clip:job.clip,owner};store(job.clip,job.cut);job.done=true;
      if(!job.recopy)remember(job);
    }
    function read(data){
      if(!data){report("The clipboard contains no Waffle objects.");return;}
      try{
        const clip=current && data===current.data && current.clip===local() && (!current.clip.cut || current.owner?.deref()===context())?current.clip:decode(data);
        const id=serial,owner=context(),version=revision(),assets=globalThis.AtriumClipHistory?.preparePacket?.(data,clip);
        if(assets)return assets.then(()=>{
          if(id===serial&&owner===context()&&version===revision())place(clip);
          else {const media=globalThis.AtriumClipboardMedia,binding=media?.binding(clip);if(binding)media.cancel(binding);}
        },e=>report(e.message));
        place(clip);
      }catch(error){report(error instanceof SyntaxError?"Invalid Waffle selection on the clipboard.":error.message);}
    }
    async function pasteText(text, id, owner, version) {
      if (!globalThis.AtriumLabs?.butterEnabled("visualHistory") || !text?.trim() || text.length>65536 || !globalThis.AtriumLazy ||
          !["schematic","pcb"].includes(owner?.kind)) return false;
      const history=await globalThis.AtriumLazy.need("AtriumClipHistory");
      if (serial!==id || context()!==owner || revision()!==version) return true;
      const entry=history.recordText(text,{kind:owner.kind,source:owner.name});
      if (entry) place(history.read(entry.id));
      return !!entry;
    }
    function writeEvent(event,cut){
      if(event.defaultPrevented || !event.clipboardData || (!pending && !validTarget(event.target)))return;
      let job;
      try{
        job=pending||stage(cut);if(!job)return;
        const {data,summary}=job.packet;
        // WebKit may limit custom types to a single origin. The typed text
        // form also survives system clipboard managers and file-origin tabs.
        event.clipboardData.setData("text/plain",summary+marker+data);
        try{event.clipboardData.setData(mime,data);}catch{/* The typed text carries the same validated envelope. */}
        event.preventDefault();job.written=true;finish(job);
      }catch(error){report(error.message);}
    }
    function readEvent(event){
      if(event.defaultPrevented || !event.clipboardData || !validTarget(event.target))return;
      event.preventDefault();++serial;
      const text=event.clipboardData.getData("text/plain"), selection=event.clipboardData.getData(mime)||fromText(text);
      if(!selection && attachment?.(event.clipboardData.files?.[0]))return;
      if (!selection && text) {
        pasteText(text,serial,context(),revision()).then(used=>{if(!used)read(null);},e=>report(e.message));
      } else read(selection);
    }
    document.addEventListener("copy",e=>writeEvent(e,false));
    document.addEventListener("cut",e=>writeEvent(e,true));
    document.addEventListener("paste",readEvent);
    async function copy(cut){
      let job;
      try{
        job=stage(cut);if(!job)return;
        if(host()?.writeSelection){
          if(await host().writeSelection(job.packet))finish(job);
          else report("The selection could not be written to the clipboard.");
          return;
        }
        if(document.execCommand){
          pending=job;
          try{document.execCommand("copy");}finally{pending=null;}
          if(job.written)return;
        }
        const api=globalThis.navigator?.clipboard;
        let system=!!api?.writeText;
        // Without clipboard permission (a browser tab, a sandboxed host) the copy still
        // lands on Waffle's own clipboard, so Paste inside Waffle keeps working.
        // A cut never removes objects that only Waffle holds: it becomes a copy.
        if(system){try{await api.writeText(job.packet.summary+marker+job.packet.data);}catch{system=false;}}
        if(!system)job.cut=false;
        finish(job);
        if(!system && current?.clip===job.clip)report("Copied inside Waffle; the system clipboard is unavailable"+(cut?", so nothing was cut.":"."));
      }catch(error){if(!job || job.id===serial)report(error.message||"The selection could not be written to the clipboard.");}
    }
    async function paste(){
      const id=++serial,owner=context(),version=revision();
      try{
        let data,text;
        if(host()?.readSelection){
          const packet=/** @type {{data?:string,text?:string,files?:{name:string,data:string,memberPath?:string,nativeCopy?:{grant:string,sha256:string}}[]}|null} */ (await host().readSelection());
          text=packet?.text;data=packet?.data||fromText(text);
          if(!data && packet?.files?.length && memberFiles){
            if(id===serial && owner===context() && version===revision())await memberFiles(packet.files);
            return;
          }
        }else if(globalThis.navigator?.clipboard?.readText){
          text=await globalThis.navigator.clipboard.readText();data=fromText(text);
        }else{
          const clip=local();if(clip)place(clip);else report("Use the system Paste shortcut to paste Waffle objects.");
          return;
        }
        if(id===serial && owner===context() && version===revision() && (data || !await pasteText(text,id,owner,version)))return read(data);
      }catch(error){
        if(id!==serial)return;
        // No read permission: fall back to Waffle's own clipboard.
        const clip=local();
        if(clip && owner===context() && version===revision())place(clip);
        else report("Clipboard access was unavailable. Use the system Paste shortcut.");
      }
    }
    function nativeAction(e){
      const k=e.key?.toLowerCase();
      const action=k==="c"?"copy":k==="x"?"cut":k==="v"?"paste":null;
      if(!action||e.altKey||e.shiftKey)return null;
      const mac=globalThis.AtriumKeymap?.mac??/Mac|iPhone|iPad/i.test(globalThis.navigator?.platform||"");
      return (mac ? e.metaKey&&!e.ctrlKey : e.ctrlKey&&!e.metaKey)?action:null;
    }
    function nativeShortcut(e,action){
      return e.isTrusted && !host()?.readSelection && typeof globalThis.ClipboardEvent==="function" && nativeAction(e)===action;
    }
    function textShortcut(e){return nativeAction(e)&&!validTarget(e.target);}
    function preventUnboundShortcut(e){
      if(!e.isComposing&&nativeAction(e)&&validTarget(e.target))e.preventDefault();
    }
    // Clipboard history: make an earlier copy (its validated wire text) the current clipboard
    // again, at once inside Waffle; written resolves true once the system clipboard has it too.
    function adopt(data){
      const clip=decode(data);
      const job={clip,cut:false,version:revision(),owner:context(),id:++serial,packet:{data,summary:summarize(clip.kind,clip.items)},recopy:true};
      finish(job);
      return {clip,written:system(job)};
    }
    async function system(job){
      try{
        if(host()?.writeSelection)return !!await host().writeSelection(job.packet);
        if(document.execCommand){pending=job;try{document.execCommand("copy");}finally{pending=null;}if(job.written)return true;}
        const api=globalThis.navigator?.clipboard;
        if(api?.writeText){await api.writeText(job.packet.summary+marker+job.packet.data);return true;}
      }catch{/* No permission: the copy stays on Waffle's own clipboard. */}
      return false;
    }
    active={copy,paste,nativeShortcut,textShortcut,preventUnboundShortcut,adopt,place:clip=>place(clip)};
    return active;
  }
  return {mime,encode,decode,fromText,install,active:()=>active};
})();
