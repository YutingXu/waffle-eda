"use strict";
// Worker pool supplies the application's package root. Input contains verified bytes, never a URL.
importScripts(new URL("notebook/notebook-image-format.js",self.notebookPackageRoot).href);
self.onmessage=async ({data:{id,task}})=>{
  try {
    const bytes=new Uint8Array(task.bytes);
    const F=globalThis.AtriumNotebookImageFormat, type=F.sniff(bytes);
    if(type==="image/svg+xml"&&!globalThis.AtriumXML)importScripts(new URL("formats/mcad-xml.js",self.notebookPackageRoot).href);
    if(type!==task.mediaType && !(type==="image/heic"&&task.mediaType==="image/heif"))throw Error("Media type does not match the selected bytes.");
    if(task.hash && self.crypto?.subtle) {
      const hash=new Uint8Array(await crypto.subtle.digest("SHA-256",bytes));
      if(Array.from(hash,c=>c.toString(16).padStart(2,"0")).join("")!==task.hash)throw Error("The image digest does not match its reference.");
    }
    const meta=F.info(bytes);
    if(task.op==="info"){postMessage({id,result:{extent:meta.extent,mediaType:type,omitted:meta.svg?.omitted||0}});return;}
    if(!meta.extent||!Number.isInteger(task.pixels)||task.pixels<1||task.pixels>4096)throw Error("Unsupported preview size.");
    const k=Math.min(1,task.pixels/Math.max(...meta.extent),Math.sqrt(8*1048576/(meta.extent[0]*meta.extent[1])));
    const width=Math.max(1,Math.round(k*meta.extent[0])),height=Math.max(1,Math.round(k*meta.extent[1]));
    const canvas=new OffscreenCanvas(width,height),ctx=canvas.getContext("2d",{willReadFrequently:!!task.pixelsForPrint});
    if(meta.svg)F.renderSVG(ctx,meta.svg,width,height);
    else {
      let frame;
      try {
        try {frame=await createImageBitmap(new Blob([bytes],{type}),{resizeWidth:width,resizeHeight:height,imageOrientation:"from-image"});}
        catch (_) {
          if(typeof ImageDecoder!=="function"||!await ImageDecoder.isTypeSupported(type))throw Error("No worker codec for "+type);
          const worker=new ImageDecoder({data:bytes,type,desiredWidth:width,desiredHeight:height,preferAnimation:false});
          try {frame=(await worker.decode({frameIndex:0})).image;} finally {worker.close();}
        }
        ctx.drawImage(frame,0,0,width,height);
      } finally {frame?.close();}
    }
    const result={width,height,extent:meta.extent,omitted:meta.svg?.omitted||0};
    const transfer=[];
    if(task.pixelsForPrint){
      result.rgba=ctx.getImageData(0,0,width,height).data;transfer.push(result.rgba.buffer);
    }
    if(task.png && canvas.convertToBlob){
      const png=await canvas.convertToBlob({type:"image/png"});
      if(png.size<=8*1048576){result.png=new Uint8Array(await png.arrayBuffer());transfer.push(result.png.buffer);}
    }
    result.bitmap=canvas.transferToImageBitmap();transfer.push(result.bitmap);
    postMessage({id,result},transfer);
  } catch(e){postMessage({id,error:String(e.message||e)});}
};
