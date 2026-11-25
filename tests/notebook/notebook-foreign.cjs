"use strict";
// Exercise the same isolated translators used by the native File Open and Export commands.
const assert = require("node:assert/strict");
const path = require("node:path");
const {deflateSync} = require("node:zlib");
const app = path.resolve(__dirname,"../../app");
require(path.join(app,"project/obsolete-project.js"));
require(path.join(app,"translator-worker-modules"));
for(const family of ["import-formats","kicad-schematic","altium-export","altium-io","source-copy","frame-conversion"]){
  for(const file of AtriumTranslatorWorkerModules[family]){
    if(file==="vendor/cfb.min.js")globalThis.CFB=require(require("../support/app-source-paths.cjs").appFileFrom(app, file));
    else require(require("../support/app-source-paths.cjs").appFileFrom(app, file));
  }
}
for(const file of ["sch-objects","kicad-schematic","translator-table","translator-registry","translator-provenance","translator-adapters","translator-exports","translators"])
  require(require("../support/app-source-paths.cjs").appFileFrom(app, file+".js"));
function chunk(tag,payload){
  const bytes=Buffer.alloc(12+payload.length);
  bytes.writeUInt32BE(payload.length);bytes.write(tag,4);payload.copy(bytes,8);
  bytes.writeUInt32BE(AtriumZip.crc32(bytes.subarray(4,bytes.length-4)),bytes.length-4);
  return bytes;
}
function png(pixelsPerMetre=0){
  const header=Buffer.alloc(13);header.writeUInt32BE(2,0);header.writeUInt32BE(1,4);header[8]=8;header[9]=2;
  const density=Buffer.alloc(9);density.writeUInt32BE(pixelsPerMetre);density.writeUInt32BE(pixelsPerMetre,4);density[8]=1;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk("IHDR",header),...(pixelsPerMetre?[chunk("pHYs",density)]:[]),
    chunk("IDAT",deflateSync(Buffer.from([0,222,56,56,6,123,119]))),chunk("IEND",Buffer.alloc(0))]);
}
const P=Atrium.project("Public image fixture"),D=P.documents[0];
D.id="sheet";D.name="Bench";P.documents=[D];
const base=png(),asset={sha256:AtriumSourceFile.sha256(base),mediaType:"image/png",byteLength:base.length};
const picture={id:"photo",kind:"image",x:10,y:14,w:40,h:20,asset,name:"Fixture.png",extent:[2,1],caption:"Bench image",alt:"Synthetic palette"};
const mark={id:"mark",kind:"imageMarkup",imageId:"photo",shape:"box",at:[100000,100000],to:[900000,900000],width:8000,colour:"#de3838"};
D.items=[picture,mark];
const image=bytes=>({type:"image",data:bytes.toString("base64"),width:2,height:1,box:[10,14,50,34],alt:picture.alt,documentId:D.id,itemId:picture.id});
const child={type:"child",documentId:D.id,itemId:mark.id,owner:picture.id,represented:true,reason:"Part of the static image."};
const projection=[image(base),child];
const asInput=f=>({name:f.name,bytes:f.bytes||new TextEncoder().encode(f.text)});
const approx=(value,n,epsilon=1e-3)=>assert.ok(Math.abs(value-n)<epsilon,String(value)+" ≠ "+n);
function imported(files){const r=AtriumTranslators.import(files.map(asInput));return r.model.documents[0].items;}
for(const input of [base,png(3780)]){
  const output=AtriumTranslators.export("kicad",P,{documentId:D.id,notebookProjection:[image(input),child]});
  assert.equal(output.files.length,1);
  const [reopened]=imported(output.files);
  assert.equal(reopened.kind,"image");assert.deepEqual(reopened.extent,[2,1]);
  approx(reopened.w,40);approx(reopened.h,20);assert.deepEqual(Buffer.from(reopened.src.split(",")[1],"base64"),input);
}
const project=AtriumTranslators.export("altium",P,{scope:"project",notebookProjection:projection});
const sheet=project.files.find(f=>f.name.endsWith(".SchDoc")),companion=project.files.find(f=>f.name.endsWith(".png"));
const manifest=project.files.find(f=>f.name.endsWith(".PrjPcb"));
assert.equal(companion.name,"notebook-"+asset.sha256+".png");
assert.deepEqual(Buffer.from(companion.bytes),base);
assert(Buffer.from(sheet.bytes).toString("latin1").includes("|RECORD=30|"));
assert(Buffer.from(manifest.bytes).toString("latin1").includes(companion.name));
const retained=imported([manifest,sheet,companion]);
assert.equal(retained.length,1);const [i]=retained;
assert.equal(i.kind,"image");assert.deepEqual(i.extent,[2,1]);
const [ox,oy]=AtriumAltiumExport.exportSchematic(P,D).offset;
approx(i.x,10+ox);approx(i.y,14-oy);approx(i.w,40);approx(i.h,20);
assert.deepEqual(Buffer.from(i.src.split(",")[1],"base64"),base);
const [absent]=imported([manifest,sheet]);
assert.equal(absent.kind,"textframe");assert.equal(absent.text,"Schematic image unavailable");
for(const field of ["x","y","w","h"])approx(absent[field],i[field]);
assert.throws(()=>imported([sheet,{name:companion.name,bytes:png(3780)}]),/does not match/);
assert.throws(()=>imported([companion]),/Unrecognised input/);
const single=AtriumTranslators.export("altium",P,{documentId:D.id,notebookProjection:projection});
const [label]=imported(single.files);assert.equal(label.kind,"label");assert.equal(label.text,picture.alt);
const missing={type:"text",text:"Source unavailable",reason:"Missing image pixels.",box:[10,14,50,34],documentId:D.id,itemId:picture.id};
for(const format of ["altium","kicad"]){
  const file=AtriumTranslators.export(format,P,{documentId:D.id,notebookProjection:[missing,{...child,represented:false}]});
  assert(imported(file.files).some(k=>k.text===missing.text));
  const trace=JSON.stringify(file.report);
  assert(trace.includes("sheet/photo")&&trace.includes("sheet/mark"));
}
const wide=Atrium.clone(P),wideSheet=wide.documents[0],S=AtriumSchObjects;
wideSheet.sheet={infinite:true,titleBlock:"none"};
wideSheet.items.push(S.make("frame",[0,0],{w:100,h:100,text:"Photographs"}),
  S.make("frame",[12000,0],{w:100,h:100,text:"Other end"}),
  {id:"far-text",kind:"textframe",x:12010,y:10,w:30,h:8,text:"End of sheet"});
for(const format of ["altium","kicad"]){
  const output=AtriumTranslators.export(format,wide,{documentId:D.id,pageMode:"frames",notebookProjection:projection});
  const docs=AtriumTranslators.import(output.files.map(asInput)).model.documents;
  const photoSheet=docs.find(doc=>doc.name==="Photographs"),photo=photoSheet?.items.find(item=>item.kind==="image");
  assert(photo,format+" retains the picture and attached annotation in the new child sheet");
  assert.deepEqual(Buffer.from(photo.src.split(",")[1],"base64"),base);
  assert.equal(wideSheet.items.filter(item=>item.kind==="imageMarkup").length,1,"foreign export leaves the authored document intact");
}
console.log("PASS native foreign translator round trips, retained PNG bytes, physical size at two densities, per-object reports and text fallbacks");
