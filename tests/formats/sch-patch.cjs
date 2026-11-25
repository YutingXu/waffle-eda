"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
require("../../app/core/model.js");require("../../app/formats/sch-import.js");require("../../app/formats/sch-patch.js");
globalThis.CFB=require("../../app/vendor/cfb.min.js");require("../../app/formats/io.js");
const raw=(line,flags=0)=>{const text=Buffer.isBuffer(line)?line:Buffer.from(line+"\0","latin1"),header=Buffer.alloc(4);header.writeUInt32LE(flags*0x1000000+text.length);return Buffer.concat([header,text]);};
const makeHeader=()=>raw("|HEADER=Protel for Windows - Schematic Capture Binary File Version 5.0");
function split(bytes){const b=Buffer.from(bytes),out=[];for(let n=0;n<b.length;){const size=b.readUInt32LE(n)&0xffffff;out.push(b.subarray(n,n+4+size));n+=4+size;}return out;}
function recordChanges(a,b){const before=split(a),after=split(b);assert.equal(before.length,after.length);return before.flatMap((rec,i)=>rec.equals(after[i])?[]:[i-1]);}
const ids=items=>items.map(item=>JSON.stringify(item.schSource));
const source=new Map([["fileheader",Buffer.concat([makeHeader(),
  raw("|RECORD=31"),raw("|RECORD=1|LibReference=Resistor|Location.X=40|Location.Y=50"),
  raw("|RECORD=34|OwnerIndex=1|Name=Designator|Text=R1|Location.X=41|Location.Y=50"),
  raw("|RECORD=41|OwnerIndex=1|Name=Value|Text=1k|Location.X=41|Location.Y=48|Opaque=\x91A\xe8"),
  raw("|RECORD=2|OwnerIndex=1|Location.X=40|Location.Y=50|PinLength=10|Designator=1"),
  raw("|RECORD=27|LocationCount=2|X1=50|Y1=50|X2=60|Y2=50"),
  raw("|RECORD=29|Location.X=60|Location.Y=50"),raw("|RECORD=25|Text=IN|Location.X=60|Location.Y=50"),
  raw("|RECORD=18|Name=OUT|Location.X=80|Location.Y=50|Width=20"),raw("|RECORD=225|Unknown=\xff\x90||Extra=x")])]]);
const parsed=(map,name="Test.SchDoc")=>AtriumSCH.read(name,map,null);
const copy=i=>JSON.parse(JSON.stringify(i));
const changed=(before,fields)=>({before,after:{...copy(before),...fields}});
{
  const bytes=Buffer.concat([makeHeader(),raw("|RECORD=31"),raw("|RECORD=17|IsCrossSheetConnector=T|Text=SDA|Location.X=10|Location.Y=20"),
    raw("|RECORD=41|OwnerIndex=1|Name=CrossRef|Text=MCU[3D]|Location.X=26|Location.X_Frac=50000|Location.Y=19"),
    raw("|RECORD=41|OwnerIndex=1|Name=Metadata|Text=Keep|IsHidden=T")]);
  const streams=new Map([["fileheader",bytes]]),port=parsed(streams).documents[0].items[0];
  const plan=AtriumSchPatch.plan(streams,[changed(port,{x:port.x+2.54,y:port.y-1.27})]);
  assert.deepEqual(plan.records,[1,2]);
  const again=parsed(new Map([...streams,...plan.replacements])).documents[0].items[0];
  assert.deepEqual(again.schPaint.crossReferences[0].at.map(x=>x.toFixed(6)),port.schPaint.crossReferences[0].at.map(x=>x.toFixed(6)));
}
const sheet=parsed(source).documents[0];assert.equal(new Set(ids(sheet.items)).size,sheet.items.length);
const part=sheet.items.find(i=>i.kind==="part"),wire=sheet.items.find(i=>i.kind==="wire"),port=sheet.items.find(i=>i.text==="OUT");
const geometry={x:part.x+.254,y:part.y+.127};const points=copy(wire.points);points[0][0]+=.254;points[0][1]+=.127;
const edits=[changed(part,{...geometry,ref:"R9",value:"47 kΩ"}),changed(wire,{points}),changed(port,{text:"OUTPUT"})];
const original=Buffer.from(source.get("fileheader")),plan=AtriumSchPatch.plan(source,edits),result=plan.replacements.get("fileheader");
assert.deepEqual(Buffer.from(source.get("fileheader")),original);
assert.deepEqual(recordChanges(original,result),[1,2,3,4,5,8]);
assert.deepEqual(plan.records,recordChanges(original,result));
const subTick=AtriumSchPatch.plan(source,[changed(part,{x:part.x+1e-9})]);assert.deepEqual(subTick.records,[]);assert.equal(subTick.replacements.size,0);
const valueRecord=split(result)[4].toString("latin1");assert.match(valueRecord,/\|%UTF8%Text=47 kÎ©\|\|\|Text=47 k\?/);assert.ok(valueRecord.includes("|Opaque=\x91A\xe8"));
const output=parsed(new Map([["fileheader",result]])),p=output.documents[0].items.find(i=>i.kind==="part");assert.equal(p.ref,"R9");assert.equal(p.value,"47 kΩ");
assert.ok(Math.abs(p.x-geometry.x)<1.3e-6);assert.ok(Math.abs(p.y-geometry.y)<1.3e-6);assert.equal(output.documents[0].items.filter(i=>i.text==="OUTPUT").length,1);
assert.deepEqual(output.library[0].symbol,parsed(source).library[0].symbol);
assert.throws(()=>AtriumSchPatch.plan(source,[changed(part,{angle:90})]),/angle/);
assert.throws(()=>AtriumSchPatch.plan(source,[changed(part,{value:"bad|field"})]),/literal/);
const longer=AtriumSchPatch.plan(source,[changed(wire,{points:[[0,0],[1,2],[2,2]]})]);
const expanded=parsed(new Map([...source,...longer.replacements])).documents[0].items.find(i=>i.kind==='wire');assert.equal(expanded.points.length,3);
const shorter=AtriumSchPatch.plan(new Map([...source,...longer.replacements]),[changed(expanded,{points:[[0,0],[2,2]]})]);
assert.doesNotMatch(split(shorter.replacements.get('fileheader'))[6].toString('latin1'),/\|[XY]3(?:_Frac)?=/i);
assert.throws(()=>AtriumSchPatch.plan(source,[changed(wire,{points:[[0,0]]})]),/vertex count/);
assert.throws(()=>AtriumSchPatch.plan(source,[changed(port,{x:3})]),/cannot be transferred/);
const unknown=new Map([["fileheader",Buffer.concat([source.get('fileheader'),raw('|RECORD=999|OwnerIndex=1|SomeOtherLocation=6')])]]);
assert.throws(()=>AtriumSchPatch.plan(unknown,[changed(part,geometry)]),/unsupported/);
assert.equal(AtriumSchPatch.plan(source,[]).replacements.size,0);
const fixtureDir=process.argv[process.argv.indexOf('--fixtures')+1];
if(process.argv.includes('--fixtures')){
  const name='Level.Shifter.SchDoc', bytes=fs.readFileSync(path.join(fixtureDir,name)),streams=AtriumIO.streams(bytes), sheet=parsed(streams,name).documents[0];
  const cap=sheet.items.find(i=>i.ref==='C17'),ic=sheet.items.find(i=>i.ref==='IC5');
  assert.equal(new Set(ids(sheet.items)).size,sheet.items.length);assert.ok(sheet.items.every(i=>Number.isInteger(i.schSource.record)));
  const plan=AtriumSchPatch.plan(streams,[changed(cap,{ref:'C117',value:'2.2 µF'})]);
  assert.deepEqual(recordChanges(streams.get('fileheader'),plan.replacements.get('fileheader')),[133,161]);
  assert.deepEqual(plan.records,[133,161]);
  const round=parsed(new Map([...streams,...plan.replacements]),name),placed=round.documents[0].items.find(i=>i.ref==='C117');assert.equal(placed.value,'2.2 µF');
  assert.equal(round.documents[0].items.length,sheet.items.length);
  assert.throws(()=>AtriumSchPatch.plan(streams,[changed(ic,{value:'99'})]),/computed or inherited/);
  assert.throws(()=>AtriumSchPatch.plan(streams,[changed(cap,{ref:'C18'})]),/already exists/);
  const proj=parsed(streams,name),defs=new Map(proj.library.map(d=>[d.id,d])),doc=proj.documents[0],moved=doc.items.find(i=>i.ref==='C17'),before=doc.items.map(copy);
  Atrium.transformPart(doc,moved,defs.get(moved.def),{x:moved.x+1.27,y:moved.y-.127});
  const transfers=AtriumSchPatch.plan(streams,before.map((i,n)=>({before:i,after:doc.items[n]})));
  assert.deepEqual(transfers.records,recordChanges(streams.get('fileheader'),transfers.replacements.get('fileheader')));
  assert.ok(transfers.records.includes(123)&&transfers.records.includes(128)&&transfers.records.includes(161)); // placed component, internal artwork, designator
  const reparsed=parsed(new Map([...streams,...transfers.replacements]),name),rd=reparsed.documents[0],rdefs=new Map(reparsed.library.map(d=>[d.id,d])), again=rd.items.find(i=>i.ref==='C17');
  assert.ok(Math.abs(again.x-moved.x)<1.3e-6&&Math.abs(again.y-moved.y)<1.3e-6);
  assert.deepEqual(defs.get(moved.def).symbol,rdefs.get(again.def).symbol);
  function pinGroups(document,defs){
    const graph=Atrium.connectivity(document,defs),groups=new Map();
    for(const i of document.items.filter(i=>i.kind==='part'))for(const pin of Atrium.pins(i,defs.get(i.def),'schematic')){
      const name=graph.byPin.get(i.id+'/'+pin.number);if(!groups.has(name))groups.set(name,[]);groups.get(name).push(i.ref+'.'+pin.number);
    }
    return [...groups.values()].map(pins=>pins.sort().join(',')).sort();
  }
  assert.deepEqual(pinGroups(doc,defs),pinGroups(rd,rdefs));
  const itemsBySource=new Map(rd.items.map(i=>[JSON.stringify(i.schSource),i]));
  for(const item of doc.items){const match=itemsBySource.get(JSON.stringify(item.schSource));assert.ok(match);
    if(item.points)for(let n=0;n<item.points.length;n++)assert.ok(Math.hypot(...item.points[n].map((v,k)=>v-match.points[n][k]))<2e-6);
  }
  console.log('PASS real SchDoc: designator/value transfer changes exactly two native records; component plus attached wires translated and re-read');
}
console.log('PASS SchDoc record mapping, source byte preservation, translated descendants, Unicode text and unsupported edit refusal');
