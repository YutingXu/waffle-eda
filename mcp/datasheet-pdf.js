// One explicitly authorized PDF or image on stdin. No paths or document actions.
function rasterBackend() {
  const {createRequire} = require("node:module");
  const {join} = require("node:path");
  const trusted = createRequire(join(process.env.WAFFLE_PDF_CANVAS_ROOT,"package.json"));
  return trusted("@napi-rs/canvas");
}

async function image(raw, {pixels, mediaType}) {
  require("../app/notebook/notebook-image-format.js");
  const format = globalThis.AtriumNotebookImageFormat;
  if (!["image/png","image/jpeg"].includes(mediaType) || format.sniff(raw) !== mediaType ||
      !Number.isInteger(pixels) || pixels < 1 || pixels > 4096) throw Error("Invalid image inputs.");
  const {extent} = format.info(raw);
  if (extent[0] * extent[1] > 32 * 1048576) throw Error("Image exceeds the renderer's input limit.");
  const {loadImage,createCanvas} = rasterBackend();
  const raster = await loadImage(raw);
  const sourcePixels = raster.width * raster.height;
  if (!sourcePixels) throw Error("Image did not decode.");
  const scale = Math.min(1,pixels / Math.max(raster.width,raster.height),Math.sqrt(2 * 1048576 / sourcePixels));
  const width = Math.max(1,Math.floor(raster.width * scale)), height = Math.max(1,Math.floor(raster.height * scale));
  const ctx = createCanvas(width,height).getContext("2d");
  ctx.drawImage(raster,0,0,width,height);
  const {data} = ctx.getImageData(0,0,width,height), rgb = Buffer.alloc(width * height * 3), alpha = Buffer.alloc(width * height);
  let opaque = true;
  for (let p = 0; p < alpha.length; p++) {
    rgb[3*p] = data[4*p]; rgb[3*p+1] = data[4*p+1]; rgb[3*p+2] = data[4*p+2];
    alpha[p] = data[4*p+3];
    if (alpha[p] !== 255) opaque = false;
  }
  return {width,height,rgb:rgb.toString("base64"),...(!opaque && {alpha:alpha.toString("base64")})};
}

async function run(op, args, raw, engine) {
  const {openDocument,pageTable,pageText,renderPage,search} = engine;
  const pdf = await openDocument(raw);
  try {
    if (op === "info") return {pages:pdf.numPages};
    if (op === "search") return await search(pdf,args);
    if (op === "snip") {
      const {png,...image} = await renderPage(pdf,args.page,args);
      return {...image,base64:Buffer.from(png).toString("base64")};
    }
    return await (op === "pin-table" ? pageTable(pdf,args.page,args) : pageText(pdf,args.page,args));
  } finally {await pdf.destroy();}
}

(async function main() {
  const op = process.argv[2];
  try {
    const engine = op === "image" ? null : await import("../app/notebook/datasheet-document.mjs");
    const args = JSON.parse(process.argv[3]), chunks = [];
    if (!["info","search","snip","text","pin-table","image"].includes(op)) throw Error("Invalid operation.");
    let size = 0;
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > (engine?.PDF_BYTES ?? 32 * 1048576)) throw Error("Asset exceeds the renderer's input limit.");
      chunks.push(chunk);
    }
    if (op === "snip") {
      // Optional native canvas backend for command-line hosts without OffscreenCanvas.
      const {Canvas, DOMMatrix, ImageData, Path2D, createCanvas} = rasterBackend();
      Object.assign(globalThis,{DOMMatrix,ImageData,Path2D});
      if (!Canvas.prototype.convertToBlob) Object.defineProperty(Canvas.prototype,"convertToBlob",{
        value:async function() {return new Blob([await this.encode("png")],{type:"image/png"});}
      });
      globalThis.OffscreenCanvas = function(width,height) {return createCanvas(width,height);};
    }
    const raw = Buffer.concat(chunks,size);
    process.stdout.write(JSON.stringify(await (op === "image" ? image(raw,args) : run(op,args,raw,engine))));
  } catch (error) {
    const unavailable = ["ERR_MODULE_NOT_FOUND","MODULE_NOT_FOUND"].includes(error.code) || typeof OffscreenCanvas !== "function" &&
      op === "snip";
    process.stdout.write(JSON.stringify(op === "image"
      ? {error:unavailable ? "The optional headless image decoder is unavailable." : "The verified image could not be decoded.",code:"image_unavailable"}
      : unavailable
      ? {error:"This headless host has no PDF raster surface.",code:"pdf_raster_unavailable"}
      : {error:"The requested PDF operation failed.",code:"invalid_pdf"}));
    process.exitCode = 1;
  }
})();
