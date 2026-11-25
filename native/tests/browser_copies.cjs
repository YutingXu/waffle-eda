"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
const bytes=Uint8Array.from([4,255,0,3,2,1]).subarray(1,4), source=new File([bytes],"Board.PcbDoc");
let download, object, clicked=false, removed=false, cleaned;
const anchor={
  click(){clicked=true;download=this.download;},
  remove(){removed=true;}
};
const globals={URL:{createObjectURL(blob){object=blob;return "blob:binary";},revokeObjectURL(){}},Blob,Uint8Array,
  document:{body:{append(){}},createElement(){return anchor;}},setTimeout(fn,ms){cleaned=ms;}};
async function test(){
  const page=vm.createContext(globals);
  for(const script of ["formats/io-browser.js","history/design-review.js"]){
    vm.runInContext(fs.readFileSync(path.join(__dirname,"../../app",script),"utf8"),page,{filename:script});
  }
  const io=globals.AtriumIO;
  assert.equal(await io.exportBinaryCopy("Board.PcbDoc",bytes,source),true);
  assert.equal(download,"Board-edited.PcbDoc");assert.ok(clicked&&removed&&cleaned>0);
  assert.deepEqual(new Uint8Array(await object.arrayBuffer()),bytes);
  await assert.rejects(io.exportBinaryCopy("unrelated.txt",bytes,source),/extension/);
  let native;
  globals.AtriumHost={exportBinaryCopy(name,data,file){native=[name,data,file];return false;}};
  assert.equal(await io.exportBinaryCopy("custom.PcbDoc",bytes,source),false);
  assert.deepEqual(native,["custom.PcbDoc",bytes,source]);
  console.log("Passed browser binary copy naming, byte preservation, extension checks, native handoff and cancel.");
}
test().catch(e=>{console.error(e);process.exitCode=1;});
