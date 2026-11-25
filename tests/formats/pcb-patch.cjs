const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
globalThis.CFB=require('../../app/vendor/cfb.min.js');
for(const module of ['model','altium-rules','pcb-import','io','pcb-patch'])require(require("../support/app-source-paths.cjs").appFile(module+'.js'));
const unit=.00000254;
function props(text){const p=Buffer.from('|'+text+'\0','latin1'),b=Buffer.alloc(4);b.writeUInt32LE(p.length);return Buffer.concat([b,p]);}
function frame(type,bytes){const b=Buffer.alloc(5);b[0]=type;b.writeUInt32LE(bytes.length,1);return Buffer.concat([b,bytes]);}
function sample(){
  const track=Buffer.alloc(49,0),via=Buffer.alloc(316,0xaa);
  track[0]=1;via[0]=74;for(const b of [track,via]){b[1]=12;b[2]=0;b.writeUInt16LE(0,3);b.writeUInt16LE(0xffff,5);b.writeUInt16LE(0xffff,7);b.writeInt32LE(1000000,13);b.writeInt32LE(2000000,17);}
  track.writeInt32LE(3000000,21);track.writeInt32LE(4000000,25);track.writeInt32LE(100000,29);track.writeUInt32LE(0x01000001,41);
  via.writeInt32LE(500000,21);via.writeInt32LE(200000,25);via[29]=1;via[30]=32;via[74]=0;for(let i=0;i<32;i++)via.writeInt32LE(500000,75+i*4);
  // Include a footprint-owned track first to catch accidental use of display order.
  const owned=Buffer.from(track);owned.writeUInt16LE(0,7);
  return new Map([['board6/data',props('VX0=0mil|VY0=0mil')],['components6/data',props('NAME=R1|PATTERN=R_0603')],['tracks6/data',Buffer.concat([frame(4,owned),frame(4,track)])],['vias6/data',frame(3,via)],['nets6/data',Buffer.concat([props('NAME=Signal'),props('NAME=GND')])]]);
}
const read=m=>AtriumPCB.read('test.PcbDoc',m,null).documents[0];
const clone=v=>JSON.parse(JSON.stringify(v));
function check(streams,real=false){
  const original=read(streams), tracks=original.items.filter(i=>i.kind==='track'&&i.sourceRecord.startsWith('tracks6/data#'));
  const track=tracks.find(i=>i.layer==='Top'),via=original.items.find(i=>i.kind==='via');
  assert.ok(track&&via);assert.equal(new Set(original.items.map(i=>i.sourceRecord)).size,original.items.length);
  if(!real)assert.equal(track.sourceRecord,'tracks6/data#1');
  const nets=AtriumPCB.netNames(streams),other=nets.find(n=>n!==track.net);
  const afterTrack={...clone(track),points:track.points.map(([x,y],i)=>[x+(i?0:.075),y+(i?.05:0)]),net:other,layer:'Bottom',width:track.width+.075};
  const afterVia={...clone(via),x:via.x+.12,y:via.y-.09,net:'',diameter:via.diameter+.25,drill:via.drill+.05};
  const originalTrack=Buffer.from(streams.get('tracks6/data')), originalVia=Buffer.from(streams.get('vias6/data'));
  const plan=AtriumPCBPatch.plan(streams,[{before:track,after:afterTrack},{before:via,after:afterVia}]);
  assert.deepEqual(plan.records,[track.sourceRecord,via.sourceRecord]);
  const small=AtriumPCBPatch.plan(streams,[{before:track,after:{...track,width:track.width+unit/100}}]);
  assert.deepEqual(small.records,[]);assert.equal(small.replacements.size,0);
  const mixed=AtriumPCBPatch.plan(streams,[{before:via,after:{...via,x:via.x+unit/100}},{before:track,after:afterTrack}]);
  assert.deepEqual(mixed.records,[track.sourceRecord]);assert.deepEqual([...mixed.replacements.keys()],['tracks6/data']);
  assert.deepEqual([...plan.replacements.keys()],['tracks6/data','vias6/data']);
  assert.deepEqual(Buffer.from(streams.get('tracks6/data')),originalTrack);assert.deepEqual(Buffer.from(streams.get('vias6/data')),originalVia);
  assert(plan.changes.length>=8);
  const updated=new Map([...streams,...plan.replacements]),again=read(updated),t=again.items.find(i=>i.sourceRecord===track.sourceRecord),v=again.items.find(i=>i.sourceRecord===via.sourceRecord);
  for(const [a,b]of [[t.width,afterTrack.width],[v.x,afterVia.x],[v.y,afterVia.y],[v.drill,afterVia.drill],[v.diameter,afterVia.diameter],...t.points.flatMap((p,i)=>p.map((n,j)=>[n,afterTrack.points[i][j]]))])assert(Math.abs(a-b)<=unit*.51);
  assert.equal(t.net,other);assert.equal(t.layer,'Bottom');assert.equal(v.net,'');
  for(const [key,src,target,item,fields]of [['tracks6/data',originalTrack,Buffer.from(updated.get('tracks6/data')),track,[[0,1],[3,5],[13,33],[41,45]]],['vias6/data',originalVia,Buffer.from(updated.get('vias6/data')),via,[[3,5],[13,29],[75,203]]]]){
    const n=Number(item.sourceRecord.split('#')[1]);let pos=0;for(let i=0;i<n;i++)pos+=5+(src.readUInt32LE(pos+1)&0xffffff);pos+=5;
    const changed=k=>fields.some(([begin,end])=>k>=pos+begin&&k<pos+end);
    assert.equal(src.length,target.length);for(let i=0;i<src.length;i++)if(!changed(i))assert.equal(src[i],target[i],key+' unknown byte '+i);
    if(item===track)assert.equal(target.readUInt32LE(pos+41),0x0100ffff);
    else for(let i=0;i<32;i++)assert.equal(target.readInt32LE(pos+75+i*4),Math.round(afterVia.diameter/unit));
  }
  const reject=(before,patch,rx)=>assert.throws(()=>AtriumPCBPatch.plan(streams,[{before,after:{...clone(before),...patch}}]),rx);
  reject(track,{net:'NoSuchNet'},/existing unambiguous/);reject(track,{points:[...track.points,...track.points]},/exactly two/);reject(track,{points:[track.points[0],track.points[0]]},/distinct/);
  reject(track,{width:1e-12},/representable/);reject(track,{width:0},/representable/);reject(track,{width:NaN},/representable/);
  reject(track,{points:[[1e10,0],[0,1]]},/range/);reject(track,{layer:'Inner 7'},/source mapping/);reject(via,{drill:via.diameter+.1},/exceed/);
  reject(via,{fromLayer:'Inner 1'},/Unsupported source edit/);reject(track,{sourceRecord:via.sourceRecord},/source identity/);
  reject(original.items.find(i=>i.kind==='part'),{angle:12},/Only X\/Y translation/);
  assert.throws(()=>AtriumPCBPatch.plan(streams,[{before:{...track,width:track.width*2},after:afterTrack}]),/fields differ/);
  assert.equal(AtriumPCBPatch.plan(streams,[{before:track,after:clone(track)}]).replacements.size,0);
  if(!real){
    const unsafe=(key,mutate,before,after,rx)=>{const m=new Map(streams),b=Buffer.from(m.get(key));mutate(b);m.set(key,b);assert.throws(()=>AtriumPCBPatch.plan(m,[{before,after}]),rx);};
    const tv=5+49+5;unsafe('tracks6/data',b=>b[tv+1]=0,track,afterTrack,/locked/);unsafe('tracks6/data',b=>b[tv+2]=2,track,afterTrack,/keepout/);
    unsafe('vias6/data',b=>b[5+74]=1,via,afterVia,/per-layer/);unsafe('vias6/data',b=>b.writeInt32LE(20000,5+75+5*4),via,afterVia,/different per-layer/);
    const m=new Map(streams);m.set('nets6/data',Buffer.concat([props('NAME=Signal'),props('NAME=GND'),props('NAME=GND')]));
    assert.throws(()=>AtriumPCBPatch.plan(m,[{before:track,after:afterTrack}]),/existing unambiguous/);
  }
  return {tracks:tracks.length,vias:original.items.filter(i=>i.kind==='via').length,changed:plan.changes.length};
}
check(sample());
const idx=process.argv.indexOf('--fixtures');if(idx>=0){const bytes=fs.readFileSync(path.join(process.argv[idx+1],'qfsae-0.PcbDoc'));const out=check(AtriumIO.streams(bytes),true);assert.equal(out.tracks,501);assert.equal(out.vias,53);console.log('PDP V3:',out.tracks,'tracks,',out.vias,'vias;',out.changed,'fields verified.');}
console.log('PASS native copper edits, existing nets, fixed-point precision, both layer IDs, simple via pad stacks, source boundaries and rejection cases.');
