"use strict";
// Coordinate native and worker codecs. Encoded originals always come from a selected
// File or the current folder reader. Display data is disposable and lives outside the model.
globalThis.AtriumNotebookMedia = (()=>{
  const G=globalThis, F=G.AtriumNotebookImageFormat;
  let pool;
  const abortError=()=>new DOMException("Cancelled","AbortError");
  const checkSignal=s=>{if(s?.aborted)throw abortError();};
  const to64=bytes=>{
    if(bytes.toBase64)return bytes.toBase64();
    let text="";for(let p=0;p<bytes.length;p+=32768)text+=String.fromCharCode(...bytes.subarray(p,p+32768));
    return btoa(text);
  };
  const from64=s=>Uint8Array.fromBase64?Uint8Array.fromBase64(s):Uint8Array.from(atob(s),c=>c.charCodeAt(0));
  function mediaPool() {
    if(!pool) {
      const root=new URL("./",document.baseURI).href;
      const source=()=>'"use strict";self.notebookPackageRoot='+JSON.stringify(root)+';importScripts(new URL("workers/notebook-media-worker.js",self.notebookPackageRoot).href);';
      pool=G.AtriumWorkerPool.get("Notebook images",source,{watchdogMs:20000,crash:"fail",local:()=>{throw Error("This host requires a background media codec.");}});
    }
    return pool;
  }
  async function worker(op,raw,ref,pixels,purpose,signal) {
    checkSignal(signal);
    const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw);
    const job=mediaPool().run({op,bytes,hash:ref?.sha256,mediaType:ref?.mediaType||F.sniff(bytes),pixels,pixelsForPrint:purpose==="print"||purpose==="foreign",png:purpose==="foreign"||purpose==="cache"});
    const cancel=()=>job.cancel?.();signal?.addEventListener("abort",cancel,{once:true});
    try{return await job;}finally{signal?.removeEventListener("abort",cancel);}
  }
  async function info(raw,mediaType,signal) {
    const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw);
    const type=F.sniff(bytes);
    if(mediaType&&mediaType!==type&&!(type==="image/heic"&&mediaType==="image/heif"))throw Error("Media type does not match the selected file.");
    if(type==="application/pdf")return {mediaType:type};
    if((type==="image/heic"||type==="image/heif")&&G.AtriumHost?.notebookMedia){
      try {
        const result=await native("info",bytes,{mediaType:type},signal);
        if(result?.extent)return {mediaType:type,extent:F.checkedExtent(...result.extent)};
      } catch {checkSignal(signal);}
    }
    return worker("info",bytes,{mediaType:type},128,"display",signal);
  }
  async function native(op,bytes,args,signal) {
    checkSignal(signal);
    if(!G.AtriumHost?.notebookMedia)return null;
    const result=await G.AtriumHost.notebookMedia({op,...args,data:to64(bytes)});
    checkSignal(signal);return result;
  }
  function drawSurface(w,h,rgba) {
    const surface=typeof OffscreenCanvas==="function"?new OffscreenCanvas(w,h):document.createElement("canvas");
    surface.width=w;surface.height=h;
    const ctx=surface.getContext("2d");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer,rgba.byteOffset,rgba.byteLength),w,h),0,0);
    return surface;
  }
  async function decode(raw,ref,{pixels,signal,purpose="display"}={}) {
    const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw);
    if(bytes.length!==ref.byteLength||bytes.length>F.MAX_BYTES)throw Error("Image length does not match its reference.");
    checkSignal(signal);
    let out;
    try {out=await worker("decode",bytes,ref,pixels,purpose,signal);}
    catch(e){
      checkSignal(signal);
      if(!G.AtriumHost?.notebookMedia||ref.mediaType==="image/svg+xml"||!/(codec|worker|background|unsupported HEIF item properties)/i.test(e.message))throw e;
      const n=await native("decode",bytes,{mediaType:ref.mediaType,sha256:ref.sha256,side:pixels,png:purpose==="cache"||purpose==="foreign"},signal);
      if(!n?.rgba)throw Error("This host cannot decode "+ref.mediaType+".");
      const rgba=from64(n.rgba);
      if(!n.width||!n.height||n.width*n.height>8*1048576||rgba.length!==n.width*n.height*4)throw Error("Invalid decoded image.");
      const surface=drawSurface(n.width,n.height,rgba);
      out={width:n.width,height:n.height,extent:n.extent,bitmap:surface,rgba:purpose==="print"||purpose==="foreign"?rgba:null,...(n.png?{png:from64(n.png)}:{})};
    }
    if(signal?.aborted){out.bitmap.close?.();throw abortError();}
    return Object.freeze({...out,surface:out.bitmap,close:()=>{if(out.bitmap.close)out.bitmap.close();else out.bitmap.width=out.bitmap.height=0;}});
  }
  async function pdf(raw,{signal}={}) {
    checkSignal(signal);
    const bytes=raw instanceof Uint8Array?raw:new Uint8Array(raw);
    if(bytes.length>128*1048576||F.sniff(bytes)!=="application/pdf")throw Error("Unsupported PDF input.");
    let reader;
    try {
      const engine=await G.AtriumLazy.need("AtriumDatasheets");
      reader=await engine.createReaderFromBytes(bytes,{signal});
      const {pages}=await reader.info();
      let crop;
      return {pages,close:reader.close,render:(page,region,side)=>{
        crop?.abort();
        crop=new AbortController();
        return reader.snip({page,region,side,signal:crop.signal});
      }};
    } catch (error) {
      reader?.close();
      checkSignal(signal);
      if (!G.AtriumHost?.notebookMedia) throw error;
      const result=await native("pdfInfo",bytes,{},signal);
      if (!result?.pages) throw Error("This host has no available PDF reader.");
      return {pages:result.pages,close:()=>{},render:async(page,region,side)=>{
        const r=await native("pdfPage",bytes,{page,region,side},signal);
        return {width:r.width,height:r.height,physical:r.physical,png:from64(r.png)};
      }};
    }
  }
  return {info,decode,pdf,to64,from64};
})();
