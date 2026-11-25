"use strict";

const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),os=require("node:os");
const {spawnSync}=require("node:child_process");
globalThis.CFB=require("../../app/vendor/cfb.min.js");
for(const name of ["model","altium-rules","source-file","pcb-import","pcb-patch","source-copy","io"])require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const arg=key=>process.argv.includes(key)?path.resolve(process.argv[process.argv.indexOf(key)+1]):null;
function props(text){
  const data=Buffer.from("|"+text+"\0","latin1"),len=Buffer.alloc(4);len.writeUInt32LE(data.length);return Buffer.concat([len,data]);
}
function framed(type,b){const len=Buffer.alloc(5);len[0]=type;len.writeUInt32LE(b.length,1);return Buffer.concat([len,b]);}
const geometry=Buffer.alloc(49);geometry[0]=33;geometry[1]=12;geometry.writeUInt16LE(0xffff,3);geometry.writeUInt16LE(0xffff,5);geometry.writeUInt16LE(0,7);
for(const [offset,v] of [[13,130000],[17,200000],[21,160000],[25,250000],[29,20000]])geometry.writeInt32LE(v,offset);
const trackFrame=framed(4,geometry);
const sample=new Map([["board6/data",props("VX0=0mil|VY0=0mil")],["components6/data",props("X=13mil|Y=20mil|SOURCEDESIGNATOR=R1|LOCKED=FALSE|Grouping=\x81")],["tracks6/data",trackFrame]]);
function checkSimple(){
  const doc=AtriumPCB.read("x.PcbDoc",sample,null).documents[0],before=doc.items[0],after={...before,x:.635,y:-.635};
  const plan=streams=>AtriumPCBPatch.plan(streams,[{before,after}]);
  const result=plan(sample);assert.deepEqual(result.records,["components6/data#0","tracks6/data#0"]);
  assert.deepEqual(Buffer.from(result.replacements.get("components6/data")),props("X=25mil|Y=25mil|SOURCEDESIGNATOR=R1|LOCKED=FALSE|Grouping=\x81"));
  assert.deepEqual(sample.get("tracks6/data"),trackFrame);
  for(const [field,value,reason] of [["LOCKED","TRUE",/Locked/],["UNIONINDEX","4",/grouped/],["ID","65535",/ownership/]]){
    const records=new Map(sample);
    records.set("components6/data",props("X=13mil|Y=20mil|"+field+"="+value));
    assert.throws(()=>plan(records),reason);
  }
  for(const [record,bytes,reason] of [["unknownobjects6/data",Buffer.from("X"),/no known placement/],["componentbodies6/data",framed(12,geometry),/owns an unsupported/],["tracks6/data",trackFrame.subarray(0,18),/Truncated/]]){
    const records=new Map(sample);records.set(record,bytes);assert.throws(()=>plan(records),reason);
  }
  assert.throws(()=>AtriumPCBPatch.plan(sample,[{before,after},{before,after}]),/repeated/);
  assert.throws(()=>AtriumPCBPatch.plan(sample,[{before,after:{...after,angle:90}}]),/Only X\/Y translation/);
  const overflow=Buffer.from(geometry);overflow.writeInt32LE(2147483640,13);
  const records=new Map(sample);records.set("tracks6/data",framed(4,overflow));assert.throws(()=>plan(records),/coordinate limits/);
}
checkSimple();

function parseParts(input){
  const data=Buffer.from(input),result=[];
  for(let i=0;i<data.length;){
    const n=data.readUInt32LE(i)&0xffffff;result.push(data.subarray(i,i+4+n));i+=4+n;
  }
  return result;
}
// Independently identify original record boundaries and overlay expected bytes
// on an untouched copy. Include opaque subblocks, text and pad-stack payloads.
function expectPrimitiveChanges(pathName,input,owners){
  const data=Buffer.from(input),copy=Buffer.from(input),receipt=[];
  for(let pos=0,ordinal=0;pos<data.length;ordinal++){
    const type=data[pos++];let geomAt;
    for(let i=0,n=type===2?6:type===5?2:1;i<n;i++){
      const size=data.readUInt32LE(pos)&0xffffff;pos+=4;
      if(i===(type===2?4:0))geomAt=pos;
      pos+=size;
    }
    const owner=data.readUInt16LE(geomAt+7),offset=owners.get(owner);
    if(offset){
      for(const base of (type===4||type===6?[13,21]:[13])){
        copy.writeInt32LE(data.readInt32LE(geomAt+base)+offset[0],geomAt+base);
        copy.writeInt32LE(data.readInt32LE(geomAt+base+4)+offset[1],geomAt+base+4);
      }
      receipt.push(pathName+"#"+ordinal);
    }
    if(pathName==="tracks6/data"&&ordinal===497){
      assert.equal(owner,65535);copy.writeInt32LE(130000,geomAt+29);receipt.push(pathName+"#497");
    }
  }
  return {bytes:copy,receipt};
}
function native(baseline){
  const {documents:[d],library}=AtriumIO.read("PDP_V3.PcbDoc",baseline),parts=d.items.filter(i=>i.kind==="part");
  const move=(part,x,y)=>{part.x+=x;part.y+=y;};
  const crystal=parts.find(i=>i.ref==="Y2"),resistor=parts.find(i=>i.ref==="R6");
  assert.equal(crystal.sourceRecord,"components6/data#0");assert.equal(resistor.sourceRecord,"components6/data#4");
  move(crystal,1.524,-.762);move(resistor,-2.54,.508);
  d.items.find(i=>i.sourceRecord==="tracks6/data#497").width=.3302;
  const old=AtriumIO.streams(baseline),out=AtriumSourceCopy.prepare(d,library,baseline),patched=AtriumIO.streams(out.bytes);
  const receipt=["components6/data#0","components6/data#4"];
  const moved=new Map([[0,[600000,300000]],[4,[-1000000,-200000]]]);
  assert.deepEqual([...old.keys()].sort(),[...patched.keys()].sort());
  for(const [name,original] of old){
    const bytes=Buffer.from(patched.get(name));
    if(name==="components6/data"){
      const a=parseParts(original),b=parseParts(bytes);
      assert.equal(a.length,52);assert.equal(a.length,b.length);
      for(let i=0;i<a.length;i++){
        if(!moved.has(i)){assert.deepEqual(a[i],b[i]);continue;}
        const r=a[i].subarray(4).toString("latin1").slice(1,-1).replace(/\|(X|Y)=([\d.]+)mil/g,(_,key,raw)=>"|"+key+"="+(Number(raw)+moved.get(i)[key==="X"?0:1]/10000)+"mil");
        assert.deepEqual(b[i],props(r));
      }
    }else if(["texts6/data","tracks6/data","arcs6/data","pads6/data"].includes(name)){
      const predicted=expectPrimitiveChanges(name,original,moved);
      assert.deepEqual(bytes,predicted.bytes,name);receipt.push(...predicted.receipt);
    }else assert.deepEqual(bytes,Buffer.from(original),name);
  }
  assert.deepEqual(out.records.slice().sort(),receipt.sort());assert.equal(receipt.length,20);
  // One rejected model-bearing placement fails the complete transaction, including both valid moves.
  const bad=parts.find(i=>i.ref==="U1");move(bad,.254,0);assert.throws(()=>AtriumSourceCopy.prepare(d,library,baseline),/owns an unsupported/);
  return out.bytes;
}
function convert(root,dir,data){
  fs.mkdirSync(dir);fs.writeFileSync(path.join(dir,"Board.PcbDoc"),data);
  for(const script of ["unpack.pl","convertpcb.pl"]){
    const proc=spawnSync("perl",[path.join(root,script)],{cwd:dir,encoding:"utf8",timeout:60000,maxBuffer:8*1024*1024});assert.equal(proc.status,0,proc.stderr?.slice(-1800));
  }
  const text=fs.readFileSync(path.join(dir,"Board-PcbDoc.kicad_pcb"),"utf8");
  const modules=new Map(),labels=new Map();
  for(const block of text.matchAll(/^ \(module [\s\S]*?^  \)$/gm)){
    const ref=/\(fp_text reference "([^"]+)"/.exec(block[0])[1];
    const pos=/^    \(at ([^ )]+) ([^ )]+)/m.exec(block[0]).slice(1).map(Number);
    const pads=block[0].match(/^\s*\(pad [^\n]+\n[^\n]+/gm)||[];
    modules.set(ref,{pos,pads});
  }
  for(const m of text.matchAll(/^ \(gr_text "(Y2|R6)" \(at ([^ ]+) ([^ )]+)/gm))labels.set(m[1],[Number(m[2]),Number(m[3])]);
  return {modules,labels};
}
if(arg("--fixtures")){
  const bytes=fs.readFileSync(path.join(arg("--fixtures"),"qfsae-0.PcbDoc")),output=native(bytes);
  console.log("PASS PDP V3 translated Y2 and R6 and independently changed track 497. All 104 native streams matched byte-exact expectations, including the 20 touched records.");
  const root=arg("--altium2kicad");
  if(root){
    const temp=fs.mkdtempSync(path.join(os.tmpdir(),"atrium-placement-"));
    try{
      const old=convert(root,path.join(temp,"before"),bytes),now=convert(root,path.join(temp,"after"),output);
      assert.equal(old.modules.size,52);assert.deepEqual([...old.modules.keys()],[...now.modules.keys()]);
      for(const [ref,{pos,pads}] of old.modules){
        assert.deepEqual(now.modules.get(ref).pads,pads);
        const delta=ref==="R6"?[-2.54,.508]:ref==="Y2"?[1.524,-.762]:[0,0];
        for(let axis=0;axis<2;axis++){
          assert.ok(Math.abs(now.modules.get(ref).pos[axis]-pos[axis]-delta[axis])<1e-5);
          if(old.labels.has(ref))assert.ok(Math.abs(now.labels.get(ref)[axis]-old.labels.get(ref)[axis]-delta[axis])<1e-5);
        }
      }
      assert.equal(old.labels.size,2);console.log("PASS independent Altium2KiCad conversion confirmed both placements and offset designators, all 52 component placements and unchanged local pad geometry/nets.");
    }finally{fs.rmSync(temp,{recursive:true,force:true});}
  }
}
console.log("PASS placement properties, unchanged source buffers and atomic refusal of locked, grouped, model-bearing, unknown and out-of-range geometry.");
