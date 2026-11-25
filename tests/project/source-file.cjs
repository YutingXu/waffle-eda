"use strict";
const assert=require("node:assert/strict");
const fs=require("node:fs"), path=require("node:path"), crypto=require("node:crypto");
const CFB=require("../../app/vendor/cfb.min.js");
require("../../app/project/source-file.js");
const {open,sha256}=AtriumSourceFile, FREE=0xffffffff, END=0xfffffffe;
const bytes=(n,seed)=>Uint8Array.from({length:n},(_,i)=>(i*17+seed)%251);
function sourceFixture(){
  const c=CFB.utils.cfb_new();
  for(const [p,n] of [["FileHeader",4250],["Folder/Properties",85],["Folder/Unknown",2359],["Other",9073],["Empty",0]])CFB.utils.cfb_add(c,p,bytes(n,n));
  return Buffer.from(CFB.write(c,{type:"buffer"}));
}
function allStreams(input){
  const c=CFB.read(Buffer.from(input),{type:"buffer"}),root=c.FullPaths[0],out=new Map();
  for(let i=0;i<c.FileIndex.length;i++)if(c.FileIndex[i].type===2)out.set(c.FullPaths[i].slice(root.length),Buffer.from(c.FileIndex[i].content||[]));
  return out;
}
function checkChange(source,replacements){
  const initial=Buffer.from(source), oldContents=allStreams(initial), original=open(source);
  const output=Buffer.from(original.write(replacements));
  assert.deepEqual(source,initial,"source is immutable");
  const expected=new Map(oldContents);
  for(const [p,value] of replacements)expected.set([...expected.keys()].find(k=>k.toLowerCase()===p.toLowerCase()),Buffer.from(value));
  const parsed=allStreams(output);
  assert.deepEqual([...parsed.keys()].sort(),[...expected.keys()].sort());
  const checked=open(output);
  for(const [p,data] of expected){assert.ok(parsed.get(p).equals(data),"independent reader: "+p);assert.ok(Buffer.from(checked.read(p)).equals(data),p);}
  return output;
}
function fixtureV4(){
  // A minimal CFB v4 with one 4096-byte stream, deliberately nonzero header
  // sector padding, and a root CLSID, to catch destructive reserialization.
  const size=4096,b=Buffer.alloc((1+3)*size),at=id=>(id+1)*size;
  Buffer.from('d0cf11e0a1b11ae1','hex').copy(b);b.writeUInt16LE(0x3e,24);b.writeUInt16LE(4,26);b.writeUInt16LE(0xfffe,28);b.writeUInt16LE(12,30);b.writeUInt16LE(6,32);
  for(const [off,value] of [[40,1],[44,1],[48,1],[56,4096],[60,END],[68,END]])b.writeUInt32LE(value,off);
  b.fill(255,76,512);b.writeUInt32LE(0,76);b.fill(0x61,512,size);b.fill(255,at(0),at(1));
  [0xfffffffd,END,END].forEach((n,i)=>b.writeUInt32LE(n,at(0)+4*i));
  function dir(name,type,id,child,start,len){const off=at(1)+128*id, str=Buffer.from(name+'\0','utf16le');str.copy(b,off);b.writeUInt16LE(str.length,off+64);b[off+66]=type;b[off+67]=1;
    for(const [j,n] of [[68,FREE],[72,FREE],[76,child],[116,start],[120,len]])b.writeUInt32LE(n,off+j);
  }
  dir('Root Entry',5,0,1,END,0);b.fill(0x9b,at(1)+80,at(1)+96);dir('FileHeader',2,1,FREE,2,4096);b.fill(7,at(2));return b;
}
function directoryBlocks(b){
  const size=2**b.readUInt16LE(30),words=size/4,at=id=>(id+1)*size;let id=b.readUInt32LE(48);const blocks=[];
  while(id!==END){blocks.push(b.subarray(at(id),at(id)+size));const table=b.readUInt32LE(76+Math.floor(id/words)*4);id=b.readUInt32LE(at(table)+(id%words)*4);}
  return Buffer.concat(blocks);
}
function verifyDirectory(before,after,mutableNames){
  const orig=directoryBlocks(before),patched=directoryBlocks(after);assert.equal(orig.length,patched.length);
  for(let i=0;i<orig.length;i+=128){const len=orig.readUInt16LE(i+64),name=len?orig.toString('utf16le',i,i+len-2):'';
    const end=mutableNames.includes(name)?116:128;assert.deepEqual(orig.subarray(i,i+end),patched.subarray(i,i+end),"directory metadata "+name);}
}
for(const len of [0,1,55,56,57,63,64,65,119,120,128,2001,65536]){
  const b=bytes(len+6,101).subarray(3,len+3);
  assert.equal(sha256(b),crypto.createHash('sha256').update(b).digest('hex'));
  assert.equal(sha256(new Int8Array(b.buffer,b.byteOffset,b.byteLength)),sha256(b));
}
assert.equal(sha256(new Uint8Array([97,98,99]).buffer),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
assert.throws(()=>sha256(new DataView(new ArrayBuffer(3))),/Expected binary file contents/);
assert.throws(()=>sha256("abc"),/Expected binary file contents/);
const source=sourceFixture(), pristine=open(source);
assert.ok(pristine.has('folder/pROPERTIES'));assert.deepEqual(Buffer.from(pristine.write(new Map())),source);
const data=pristine.read('FileHeader');data[4]^=255;data[4100]^=255;
const onlyTwo=checkChange(source,new Map([['fileHEADER',data]]));assert.equal(onlyTwo.length,source.length);
let changed=0;for(let i=0;i<source.length;i++)if(source[i]!==onlyTwo[i])changed++;assert.equal(changed,2);verifyDirectory(source,onlyTwo,[]);
const grown=checkChange(source,new Map([['FileHeader',bytes(9211,1)],['Folder/Properties',bytes(3840,2)],['Empty',bytes(3900,3)]]));
verifyDirectory(source,grown,['FileHeader','Properties','Empty','Root Entry']);
const switched=checkChange(grown,new Map([['FileHeader',bytes(100,4)],['Folder/Properties',bytes(4096,5)],['Folder/Unknown',new Uint8Array()]]));
verifyDirectory(grown,switched,['FileHeader','Properties','Unknown','Root Entry']);
checkChange(switched,new Map([['Folder/Properties',bytes(4095,7)],['Empty',new Uint8Array()]]));
assert.throws(()=>pristine.write(new Map([['absent',data]])),/missing/i);
assert.throws(()=>pristine.write(new Map([['Empty',data],['empty',data]])),/duplicate/i);
assert.throws(()=>open(source.subarray(0,-2)),/truncated/i);
const bad=Buffer.from(source);bad.writeUInt32LE(bad.readUInt32LE(76),48);assert.throws(()=>open(bad),/sector/i);
const v4=fixtureV4(),v4doc=open(v4);assert.deepEqual(Buffer.from(v4doc.write(new Map())),v4);
const v4mini=Buffer.from(v4doc.write(new Map([['FileHeader',bytes(144,12)]])));
assert.deepEqual(open(v4mini).read('FileHeader'),bytes(144,12));assert.deepEqual(v4.subarray(512,4096),v4mini.subarray(512,4096));verifyDirectory(v4,v4mini,['Root Entry','FileHeader']);
const v4again=Buffer.from(open(v4mini).write(new Map([['FileHeader',bytes(10000,19)]])));assert.deepEqual(open(v4again).read('FileHeader'),bytes(10000,19));
const big=checkChange(source,new Map([['FileHeader',new Uint8Array(8_000_000)]]));assert.ok(big.readUInt32LE(72)>0,"grew from inline DIFAT to external DIFAT sector");
const bigger=checkChange(big,new Map([['Other',new Uint8Array(8_000_000)]]));assert.ok(bigger.readUInt32LE(72)>1,"extended DIFAT chain");
console.log('PASS CFB byte-exact no-op and same-length edits, preserved directory metadata, small/large stream migration, mini/FAT/DIFAT growth, v4 sectors and SHA-256');
const flag=process.argv.indexOf('--fixtures');
if(flag>=0){
  const folder=process.argv[flag+1];let count=0;
  for(const file of fs.readdirSync(folder).filter(s=>/\.(schdoc|pcbdoc|pcblib|schlib)$/i.test(s))){
    const original=fs.readFileSync(path.join(folder,file));if(original[0]!==0xd0)continue;
    const src=open(original);assert.deepEqual(Buffer.from(src.write(new Map())),original);
    const p=src.paths().find(p=>src.read(p).length>10);const content=src.read(p);
    checkChange(original,new Map([[p,Buffer.concat([content,Buffer.from('one longer property value')])]]));count++;
  }
  assert.ok(count);console.log('PASS independently read all streams after growing a record stream in '+count+' Altium source files');
}
