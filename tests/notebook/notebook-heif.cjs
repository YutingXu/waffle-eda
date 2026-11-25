"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs");
require("../../app/notebook/notebook-image-format.js");
const dimensions=bytes=>AtriumNotebookImageFormat.info(bytes).extent;
const u16=n=>{const b=new Uint8Array(2);new DataView(b.buffer).setUint16(0,n);return b;};
const u32=n=>{const b=new Uint8Array(4);new DataView(b.buffer).setUint32(0,n);return b;};
function box(type,...parts){
  const body=Buffer.concat(parts);
  return Buffer.concat([u32(body.length+8),Buffer.from(type),body]);
}
const ispe=(w,h)=>box("ispe",u32(0),u32(w),u32(h));
function file({wide=false,id=7,rotate=0,idx=2,crop=false}={}){
  const flags=wide?0x01000001:0,ident=wide?u32:u16,pin=wide?u16:n=>Buffer.from([n]);
  const prop=[ispe(512,512),ispe(4032,3024),box("irot",Buffer.from([rotate]))],associations=[idx];
  if(crop){
    prop.push(box("clap",...([3800,1,2800,1,0,1,0,1].map(u32))));
    associations.push(4);
  }
  associations.push(3);
  const ipma=box("ipma",u32(flags),u32(2),ident(1),Buffer.from([1]),pin(1),
    ident(id),Buffer.from([associations.length]),...associations.map(pin));
  const group=box("iprp",box("ipco",...prop),ipma);
  return Buffer.concat([box("ftyp",Buffer.from("heic"),u32(0)),box("meta",u32(0),
    box("pitm",u32(wide?0x01000000:0),ident(id)),group)]);
}
assert.deepEqual(dimensions(file()),[4032,3024]);
assert.deepEqual(dimensions(file({rotate:1})),[3024,4032]);
assert.deepEqual(dimensions(file({wide:true,id:70001,rotate:3,crop:true})),[2800,3800]);
assert.throws(()=>dimensions(file({idx:17})),/HEIF/);
assert.throws(()=>dimensions(file().subarray(0,-5)),/HEIF/);
if(process.argv[2]){
  const source=fs.readFileSync(process.argv[2]);
  assert.deepEqual(dimensions(source),[4032,3024]);
  console.log("Verified the 4032 × 3024 primary photo in a real encoded HEIC.");
}
console.log("HEIF primary associations, tile dimensions, clean aperture and rotated extent passed.");
