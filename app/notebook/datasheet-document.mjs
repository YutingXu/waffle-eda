// Static PDF bytes only. This module is loaded inside the dedicated worker.
import {AnnotationMode, getDocument} from "../vendor/pdfjs/pdf.min.mjs";
import "../vendor/pdfjs/pdf.worker.min.mjs";

export const FULL_PAGE = [0,0,1000000,1000000];
export const PDF_BYTES = 128 * 1024 ** 2;
const PAGE_LIMIT = 100000, MAX_SIDE = 4096, MAX_PIXELS = 8 * 1024 ** 2;
const cancelled = () => Object.assign(Error("The datasheet operation was cancelled."),{name:"AbortError"});
const check = signal => {if (signal?.aborted) throw cancelled();};

// PDF.js uses this for its fingerprint. The polyfill stays in the worker or
// one-shot headless process on engines predating the byte-array codecs.
if (!Uint8Array.prototype.toHex) Object.defineProperty(Uint8Array.prototype,"toHex",{
  configurable:true, writable:true, value() {
    return Array.from(this,byte=>byte.toString(16).padStart(2,"0")).join("");
  }
});

for (const {prototype} of [Map,WeakMap]) if (!prototype.getOrInsertComputed) Object.defineProperty(prototype,"getOrInsertComputed",{
  configurable:true, writable:true, value(key,compute) {
    if (this.has(key)) return this.get(key);
    const value = compute(key);
    this.set(key,value);
    return value;
  }
});

export function regionOf(region = FULL_PAGE) {
  if (!Array.isArray(region) || region.length !== 4 ||
      !region.every(n=>Number.isInteger(n) && n>=0 && n<=1000000) ||
      region[2]<=region[0] || region[3]<=region[1]) throw Error("Choose a nonempty datasheet region.");
  return region;
}

function surface(width, height, options) {
  if (typeof OffscreenCanvas !== "function") throw Error("This worker has no PDF raster surface.");
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width * height > MAX_PIXELS * 2) throw Error("The datasheet exceeds the supported canvas size.");
  const canvas = new OffscreenCanvas(width,height);
  const context = canvas.getContext("2d",options);
  if (!context) throw Error("The PDF raster surface could not be created.");
  return {canvas,context};
}
class CanvasFactory {
  create(w,h) {return surface(w,h);}
  getNoAlphaContext(canvas) {return canvas.getContext("2d",{alpha:false});}
  reset(holder,w,h) {
    if (w<1 || h<1 || w*h>MAX_PIXELS*2) throw Error("The datasheet exceeds the supported canvas size.");
    holder.canvas.width=w;
    holder.canvas.height=h;
  }
  destroy(holder) {
    if (holder.canvas) holder.canvas.width=holder.canvas.height=0;
    holder.canvas=holder.context=null;
  }
}

export async function openDocument(input,{signal}={}) {
  check(signal);
  if (!(input instanceof Uint8Array) || input.byteLength > PDF_BYTES ||
      !new TextDecoder().decode(input.subarray(0,1024)).includes("%PDF-")) throw Error("Unsupported PDF input.");
  // Supplying only bytes prevents the parser from resolving external document URLs.
  // Forms, scripts and attachments are never read and annotation appearances are disabled.
  const loading = getDocument({
    data:Uint8Array.from(input), stopAtErrors:true, isEvalSupported:false, enableXfa:false,
    useWorkerFetch:false, useWasm:false, useSystemFonts:false, disableFontFace:true,
    disableAutoFetch:true, disableRange:true, disableStream:true, disableWorkerRendering:true,
    isOffscreenCanvasSupported:typeof OffscreenCanvas==="function", isImageDecoderSupported:false,
    maxImageSize:MAX_PIXELS*2, canvasMaxAreaInBytes:MAX_PIXELS*4,
    verbosity:0, CanvasFactory
  });
  let password = false;
  const abort = () => { loading.destroy().catch(()=>{}); };
  loading.onPassword = () => {password = true; abort();};
  signal?.addEventListener("abort",abort,{once:true});
  try {
    const pdf = await loading.promise;
    check(signal);
    if (pdf.numPages<1 || pdf.numPages>PAGE_LIMIT) throw Error("Unsupported number of datasheet pages.");
    return Object.freeze({numPages:pdf.numPages,getPage:page=>pdf.getPage(page),destroy:()=>loading.destroy()});
  } catch (error) {
    await loading.destroy().catch(()=>{});
    check(signal);
    if (password) throw Error("This datasheet requires a password.");
    throw error;
  } finally {signal?.removeEventListener("abort",abort);}
}

async function pageAt(pdf,page,signal) {
  check(signal);
  if (!Number.isInteger(page) || page<1 || page>pdf.numPages) throw Error("Choose a page in this datasheet.");
  const row = await pdf.getPage(page);
  check(signal);
  return row;
}

function viewportFor(page,scale=1) {
  const viewport = page.getViewport({scale});
  if (![viewport.width,viewport.height].every(v=>Number.isFinite(v) && v>0 && v<=1e7))
    throw Error("Unsupported datasheet page dimensions.");
  return viewport;
}

async function encodePixels(context,width,height) {
  // A file-origin WebKit worker can encode a canvas blob while denying reads
  // of that blob's bytes. The fallback encodes the same worker-rendered pixels.
  const pixels = context.getImageData(0,0,width,height).data, stride = width*4;
  const scan = new Uint8Array((stride+1)*height);
  for (let y=0;y<height;y++) scan.set(pixels.subarray(y*stride,(y+1)*stride),y*(stride+1)+1);
  const source = new ReadableStream({start(controller){controller.enqueue(scan);controller.close();}});
  const reader = source.pipeThrough(new CompressionStream("deflate")).getReader(), encoded = [];
  for (;;) {
    const {done,value} = await reader.read();
    if (done) break;
    encoded.push(value);
  }
  const crcTable = Uint32Array.from({length:256},(_,i)=>{
    for (let j=0;j<8;j++) i = i&1 ? 0xedb88320^(i>>>1) : i>>>1;
    return i;
  });
  function chunk(name, data) {
    const length = data.reduce((sum,row)=>sum+row.byteLength,0);
    const bytes = new Uint8Array(length+12), view = new DataView(bytes.buffer);
    view.setUint32(0,length);
    for (let i=0;i<4;i++) bytes[4+i]=name.charCodeAt(i);
    let at=8;
    for (const row of data) {bytes.set(row,at);at+=row.byteLength;}
    let crc=0xffffffff;
    for (let i=4;i<at;i++) crc=crcTable[(crc^bytes[i])&255]^(crc>>>8);
    view.setUint32(at,crc^0xffffffff);
    return bytes;
  }
  const header = new Uint8Array(13), dimensions = new DataView(header.buffer);
  dimensions.setUint32(0,width); dimensions.setUint32(4,height); header[8]=8;header[9]=6;
  const blocks = [Uint8Array.of(137,80,78,71,13,10,26,10),chunk("IHDR",[header]),chunk("IDAT",encoded),chunk("IEND",[])];
  const png = new Uint8Array(blocks.reduce((sum,row)=>sum+row.byteLength,0));
  let at=0;
  for (const row of blocks) {png.set(row,at);at+=row.byteLength;}
  return png;
}

export async function renderPage(pdf,page,{region,side=1200,signal}={}) {
  region = regionOf(region);
  if (!Number.isFinite(side) || side<1 || side>MAX_SIDE) throw Error("Unsupported datasheet image size.");
  const p = await pageAt(pdf,page,signal);
  try {
    const base = viewportFor(p);
    const rw = (region[2]-region[0])/1e6, rh = (region[3]-region[1])/1e6;
    const scale = Math.min(side/Math.max(base.width*rw,base.height*rh),Math.sqrt(MAX_PIXELS/(base.width*rw*base.height*rh)));
    const viewport = p.getViewport({scale});
    const width = Math.max(1,Math.round(viewport.width*rw)), height = Math.max(1,Math.round(viewport.height*rh));
    const {canvas,context} = surface(width,height,{alpha:false});
    const task = p.render({canvas,canvasContext:context,viewport,annotationMode:AnnotationMode.DISABLE,
      transform:[1,0,0,1,-viewport.width*region[0]/1e6,-viewport.height*region[1]/1e6],background:"#fff"});
    const abort = () => task.cancel();
    signal?.addEventListener("abort",abort,{once:true});
    try {
      await task.promise;
      check(signal);
      let png;
      try {
        const blob = await canvas.convertToBlob({type:"image/png"});
        png = new Uint8Array(await blob.arrayBuffer());
      } catch {
        check(signal);
        png = await encodePixels(context,width,height);
      }
      check(signal);
      return {page,width,height,physical:[base.width,base.height],region,png};
    } catch (error) {check(signal);throw error;}
    finally {signal?.removeEventListener("abort",abort);canvas.width=canvas.height=0;}
  } finally {p.cleanup();}
}

function textBox(item,viewport) {
  const [a,b,c,d,x,y] = item.transform;
  const h = Math.hypot(a,b) || 1, v = Math.hypot(c,d) || 1;
  const dx = a/h * item.width, dy = b/h * item.width;
  const ex = c/v * item.height, ey = d/v * item.height;
  const points = [[x,y],[x+dx,y+dy],[x+ex,y+ey],[x+dx+ex,y+dy+ey]].map(point=>viewport.convertToViewportPoint(...point));
  const xs = points.map(point=>point[0]), ys = points.map(point=>point[1]);
  const scale = (n,size)=>Math.round(1e6*n/size);
  return [scale(Math.min(...xs),viewport.width),scale(Math.min(...ys),viewport.height),
    scale(Math.max(...xs),viewport.width),scale(Math.max(...ys),viewport.height)];
}

export async function pageText(pdf,page,{region,signal,limit=4096}={}) {
  region = regionOf(region);
  if (!Number.isInteger(limit) || limit<1 || limit>8192) throw Error("Unsupported datasheet text limit.");
  const p = await pageAt(pdf,page,signal), viewport = viewportFor(p);
  const reader = p.streamTextContent({includeMarkedContent:false,disableNormalization:false}).getReader();
  const fields = [];
  let partial = false, total = 0;
  const abort = () => {reader.cancel().catch(()=>{});};
  signal?.addEventListener("abort",abort,{once:true});
  try {
    for (;;) {
      check(signal);
      const {value,done} = await reader.read();
      if (done) break;
      for (const item of value.items || []) {
        if (!item.str?.trim()) continue;
        const box = textBox(item,viewport);
        if (!box.every(Number.isFinite) || box[2]<=region[0] || box[0]>=region[2] || box[3]<=region[1] || box[1]>=region[3]) continue;
        if (fields.length>=limit || total+item.str.length>262144) {partial=true; break;}
        total += item.str.length;
        fields.push({text:item.str,box,endLine:!!item.hasEOL});
      }
      if (partial) break;
    }
    check(signal);
    return {page,fields,partial};
  } finally {
    signal?.removeEventListener("abort",abort);
    await reader.cancel().catch(()=>{});
    p.cleanup();
  }
}

export function textTable(fields) {
  const rows = [];
  const runs = fields.map(({text,box})=>({
    text:text.trim(),left:box[0],right:box[2],baseline:box[3],height:box[3]-box[1],
    glyph:Math.max(500,(box[2]-box[0])/Math.max(1,[...text.trim()].length))
  })).sort((a,b)=>a.baseline-b.baseline || a.left-b.left);
  for (const run of runs) {
    const row = rows.at(-1);
    if (row && run.baseline-row.baseline<=Math.max(250,Math.min(row.height,run.height)*.27)) {
      row.runs.push(run);
      row.height=Math.max(row.height,run.height);
    } else rows.push({baseline:run.baseline,height:run.height,runs:[run]});
  }
  // A smaller raised run next to ordinary text is a footnote marker. Keep it
  // in the source fields, where it can be inspected, without altering a pin.
  const cells = rows.map((row,i)=>{
    const below = rows.slice(i,i+2).flatMap(item=>item.runs);
    const visible = row.runs.filter(run=>!below.some(anchor=>
      anchor.height>run.height*1.22 && anchor.baseline-run.baseline>anchor.height*.12 &&
      anchor.baseline-run.baseline<=anchor.height*.72 && run.left>=anchor.left-anchor.glyph*.35 &&
      run.left<=anchor.right+anchor.glyph*.75));
    const line = [];
    for (const run of visible.sort((a,b)=>a.left-b.left)) {
      const cell = line.at(-1);
      if (cell && run.left-cell.right<=Math.max(500,Math.min(cell.glyph,run.glyph)*.85)) {
        cell.text += (run.left-cell.right>cell.glyph*.12 ? " " : "")+run.text;
        cell.right = Math.max(cell.right,run.right);
      } else line.push({...run});
    }
    return line;
  }).filter(row=>row.length);
  // Align each row to the same columns, using start, end, and center positions
  // to accommodate left-, right- and center-aligned cells.
  const columns = [], assignments = new Map();
  let partial = false;
  for (const row of [...cells].sort((a,b)=>b.length-a.length)) {
    const values = new Map();
    for (const cell of row) {
      let match, best = Infinity;
      for (const column of columns) {
        if (values.has(column)) continue;
        const left = Math.abs(cell.left-column.left), right = Math.abs(cell.right-column.right);
        const center = Math.abs(cell.left+cell.right-column.left-column.right)/2;
        const distance = Math.min(left,1.1*right,1.1*center);
        if (distance<best && distance<=Math.max(cell.glyph,column.glyph)*1.15) {
          best=distance;
          match=column;
        }
      }
      if (!match) {
        if (columns.length>=128) {partial=true;continue;}
        match=cell;
        columns.push(match);
      }
      values.set(match,cell.text);
    }
    assignments.set(row,values);
  }
  columns.sort((a,b)=>a.left-b.left);
  return {rows:cells.map(row=>columns.map(column=>assignments.get(row).get(column) ?? "")),partial};
}

export async function pageTable(pdf,page,options) {
  const content=await pageText(pdf,page,options), table=textTable(content.fields);
  return {...content,rows:table.rows,partial:content.partial || table.partial};
}

export async function search(pdf,{query,start=1,maxPages=16,limit=64},signal) {
  if (typeof query !== "string" || !query.trim() || query.length>200 ||
      !Number.isSafeInteger(start) || start<1 || start>pdf.numPages ||
      !Number.isSafeInteger(maxPages) || maxPages<1 || maxPages>64 ||
      !Number.isSafeInteger(limit) || limit<1 || limit>200) throw Error("Invalid datasheet search.");
  const needle = query.trim().toLowerCase(), matches = [];
  let page = start, partial = false;
  for (; page <= pdf.numPages && page < start+maxPages && matches.length<limit; page++) {
    const content = await pageText(pdf,page,{signal});
    partial ||= content.partial;
    const text = content.fields.map(field=>field.text).join(" ");
    const at = text.toLowerCase().indexOf(needle);
    if (at>=0) matches.push({page,excerpt:text.slice(Math.max(0,at-48),at+needle.length+48)});
  }
  return {pages:pdf.numPages,matches,partial,nextPage:page<=pdf.numPages ? page : null};
}
