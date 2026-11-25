"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
globalThis.CFB=require("../../app/vendor/cfb.min.js");
// View Configuration overrides persist in localStorage; isolate the test from any real store.
const store=new Map(),storage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
Object.defineProperty(globalThis,"localStorage",{value:storage,configurable:true,writable:true});
for(const m of ["model","source-file","pcb-import","altium-rules","io","spatial","connectivity","pcb-appearance","canvas"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const PCB=AtriumPCBAppearance;
function recorder(){
  const marks=[],stack=[];let path=[];
  const target={
    beginPath(){path=[];},moveTo(...a){path.push(["M",...a]);},lineTo(...a){path.push(["L",...a]);},
    arc(...a){path.push(["A",...a]);},ellipse(...a){path.push(["E",...a]);},rect(...a){path.push(["R",...a]);},
    fill(){marks.push(["fill",this.fillStyle,path]);},stroke(){marks.push(["stroke",this.strokeStyle,path]);},
    fillRect(){marks.push(["surface",this.fillStyle]);},fillText(t){marks.push(["text",this.fillStyle,t]);},
    save(){stack.push([this.fillStyle,this.strokeStyle]);},restore(){[this.fillStyle,this.strokeStyle]=stack.pop();}
  };
  return {marks,ctx:new Proxy(target,{get:(obj,k)=>obj[k]??(()=>{})})};
}
const {marks,ctx}=recorder(),view=AtriumCanvas.create({getContext:()=>ctx,getBoundingClientRect:()=>({width:900,height:640})});
const board=Atrium.sheet("pcb","Layers");
board.outline=[[-8,-6],[8,-6],[8,6],[-8,6]];
const trace=(id,y,layer)=>({id,kind:"track",points:[[-5,y],[5,y]],width:.35,layer,net:id});
const pad={x:0,y:0,w:1,h:1,drill:0,number:"1",layer:"Top"};
const footprint={shapes:[{kind:"path",points:[[-1,1],[1,1]],layer:"Silk",width:.12}],pads:[pad]};
const part={id:"u",kind:"part",layer:"Top",def:"fp",ref:"U1",x:0,y:3,angle:0,pinNets:{}};
const through={id:"v",kind:"via",x:1,y:-2,diameter:1,drill:.45,layer:"Multi"};
const blind={...through,id:"b",x:4,fromLayer:"Top",toLayer:"Inner 1"};
const top=trace("red",0,"Top"),bottom=trace("blue",0,"Bottom"),defs=new Map([["fp",{footprint}]]);
board.items=[top,part,through,blind,bottom];
view.fit(board,defs);
function render(opts){marks.length=0;view.render(board,defs,{grid:false,...opts});return marks;}
const stroked=(ink,kind="stroke")=>marks.findIndex(m=>m[0]===kind&&m[1]===ink);
render({layer:"Top"});assert.equal(marks[0][1],PCB.system.workspace);
assert.ok(stroked(PCB.color("Bottom"))<stroked(PCB.color("Top")));
assert.ok(stroked(PCB.color("Top"),"fill")>=0,"SMD lands use their own copper color");
assert.ok(stroked(PCB.color("Silk"))>stroked(PCB.color("Top")));
const holeAt=()=>marks.findIndex(m=>m[0]==="fill"&&m[1]===PCB.system.hole);
assert.ok(holeAt()>stroked(PCB.color("Silk")),"vias paint above the overlay");
assert.ok(marks.some(m=>m[0]==="fill"&&m[1]===PCB.system.hole&&m[2][0][0]==="A"&&m[2][0][3]===.225),"drill radius follows finished diameter");
assert.ok(marks.some(m=>m[0]==="fill"&&m[1]===PCB.color("Inner 1")),"a blind via's ring shows its span's end layer");
assert.equal(view.hit(board,defs,[2,0],{layer:"Top"}),top);
render({layer:"Bottom"});assert.ok(stroked(PCB.color("Bottom"))>stroked(PCB.color("Top")));
assert.equal(view.hit(board,defs,[2,0],{layer:"Bottom"}),bottom);
render({layerMode:"single",layer:"Bottom"});
assert.equal(stroked(PCB.color("Top")),-1);assert.equal(stroked(PCB.color("Silk")),-1);assert.equal(stroked(PCB.color("Top"),"fill"),-1);
assert.equal(marks.filter(m=>m[0]==="fill"&&m[1]===PCB.system.hole).length,1,"only the through via reaches Bottom");
assert.ok(stroked(PCB.color("Bottom"),"fill")>=0,"a via takes the current copper layer's colour");
assert.equal(view.hit(board,defs,[4,-2],{layerMode:"single",layer:"Bottom"}),null);
assert.equal(view.selectable(part,board,{layer:"Bottom",layerMode:"single"},defs),false);
render({layerMode:"dim",layer:"Bottom"});assert.ok(stroked(PCB.system.dim)>=0);assert.ok(stroked(PCB.color("Bottom"))>=0);
render({hidden:new Set(["Multi","Silk"])});assert.equal(holeAt(),-1);assert.equal(stroked(PCB.color("Silk")),-1);
// Mixed footprint artwork and free board objects share the renderer's layer order.
{
  const mixed=Atrium.sheet("pcb","Mixed artwork");
  mixed.outline=board.outline;
  const ref={field:"ref",at:[0,-1],angle:0,size:.8,layer:"Mechanical 5"};
  const note={field:"value",at:[0,1],angle:0,size:.8,layer:"Mechanical 4"};
  const placed={...part,id:"p",layer:"Bottom",value:"18Ω",designator:{x:0,y:-1},boardLabels:[ref,note]};
  const shape={...footprint.shapes[0],layer:"Mechanical 3"};
  const mixedDefs=new Map([["fp",{footprint:{shapes:[shape,{...shape,layer:"Bottom silk"}],pads:[pad]}}]]);
  const string={id:"text",kind:"label",text:"Artwork",x:1,y:1,size:.6};
  const via={...through,layer:undefined};
  const smd={...pad,kind:"pad",layer:undefined},drilled={...smd,drill:.3};
  assert.deepEqual([string,via,smd,drilled,{...via,layer:"Inner 1"}].map(PCB.boardLayer),["Silk","Multi","Top","Multi","Inner 1"]);
  assert.ok(PCB.layerRank("Inner 1",{layer:"Top"})>PCB.layerRank("Inner 126",{layer:"Top"}));
  assert.ok(PCB.layerRank("Inner 1",{layer:"Top",flipped:true})<PCB.layerRank("Inner 126",{layer:"Top",flipped:true}));
  mixed.items=[placed,trace("mechanical",.5,"Mechanical 2"),string,trace("mask-b",0,"Bottom mask"),trace("mask-t",0,"Top mask"),top,bottom,via];
  view.fit(mixed,mixedDefs);
  const paintOrder=(flipped,options={})=>{
    view.setFlipped(flipped);
    const layers=[],opts={layer:"Top",grid:false,origin:false,...options};
    view.render(mixed,mixedDefs,{...opts,recordLayer:layer=>{if(layer)layers.push(layer);}});
    assert.deepEqual(view.internals().paintOrder(mixed,mixedDefs,opts),layers,"the GPU tie-order lookup uses the same layers as the painter");
    return layers;
  };
  const below=["Mechanical 3","Mechanical 4","Mechanical 2","Bottom","Top","Bottom mask","Top mask"];
  assert.deepEqual(paintOrder(false),[...below,"Bottom silk","Silk","Multi"]);
  assert.deepEqual(paintOrder(true),[...below,"Silk","Bottom silk","Multi"]);
  assert.deepEqual(paintOrder(true,{layer:"Mechanical 4",layerMode:"single"}),["Mechanical 4"]);
  assert.deepEqual(paintOrder(false,{hidden:new Set(["Mechanical 4","Bottom silk"])}),below.filter(l=>l!=="Mechanical 4").concat("Silk","Multi"));
  delete placed.designator;
  placed.showValue=false;
  view.invalidate(mixed,[placed]);
  assert.deepEqual(paintOrder(false).slice(0,3),["Mechanical 3","Mechanical 5","Mechanical 2"],"native reference returns when the placed reference is removed");
  view.fit(board,defs);
}
// A via is one copper ring and one dark drill: two discs, no outlines, in the current layer's copper colour
// (tenting adds nothing); a blind via 8 px across splits its ring into its span's colours; filled and
// back-drilled vias add one mark at zoom (viastack.js paintMarks).
{
  require("../../app/pcb/viastack.js");
  const one=Atrium.sheet("pcb","Via");one.outline=[[-2,-2],[2,-2],[2,2],[-2,2]];
  const v={id:"t",kind:"via",x:0,y:0,diameter:.6,drill:.3,layer:"Multi",net:"N",tent:{top:true,bottom:true}};
  one.items=[v];view.fit(one,new Map());
  const drawn=opts=>{marks.length=0;view.render(one,new Map(),{grid:false,origin:false,...opts});
    return marks.filter(m=>(m[0]==="fill"||m[0]==="stroke")&&m[2].length===1&&["A","E"].includes(m[2][0][0])).map(m=>[m[0],m[1]]);};
  assert.deepEqual(drawn({layer:"Top"}),[["fill",PCB.color("Top")],["fill",PCB.system.hole]],"tented through via on Top: ring and drill");
  assert.deepEqual(drawn({layer:"Bottom"}),[["fill",PCB.color("Bottom")],["fill",PCB.system.hole]],"the ring follows the current layer");
  assert.deepEqual(drawn({layer:"Top",layerMode:"dim"}),[["fill",PCB.color("Top")],["fill",PCB.system.hole]]);
  assert.deepEqual(drawn({layer:"Silk"}),[["fill",PCB.color("Multi")],["fill",PCB.system.hole]],"a non-copper current layer keeps the Multi-Layer colour");
  v.fromLayer="Top";v.toLayer="Inner 1";
  assert.deepEqual(drawn({layer:"Top"}),[["fill",PCB.color("Top")],["fill",PCB.color("Top")],["fill",PCB.color("Inner 1")],["fill",PCB.system.hole]],"blind: ring in its two span colours");
  assert.deepEqual(drawn({layer:"Bottom",layerMode:"dim"}),[["fill",PCB.system.dim],["fill",PCB.system.hole]],"off its span in the dimmed mode: one dim ring");
  delete v.fromLayer;delete v.toLayer;v.ipc4761="V";
  assert.deepEqual(drawn({layer:"Top"}),[["fill",PCB.color("Top")],["fill",PCB.system.hole],["fill","#6e737a"]],"filled: the drill shows closed");
  delete v.ipc4761;v.backdrill={from:"Bottom",to:"Inner 2",diameter:.5};
  assert.deepEqual(drawn({layer:"Top"}).map(m=>m[0]),["fill","fill","stroke"],"back-drilled: one ring at the drill's edge");
  assert.equal(AtriumViaStack.hasMark({kind:"via",tent:{top:true,bottom:true}}),false,"tenting draws no mark");
  view.fit(board,defs);
}
render({selectedIds:new Set(["blue","u"])});assert.ok(stroked(PCB.system.selection)>=0);assert.ok(stroked(PCB.system.selection,"fill")>=0);
// Altium's default 2D scheme, distinct from every system ink the renderer uses.
const altium={Top:"#ff0000",Bottom:"#0000ff",Silk:"#ffff00","Bottom silk":"#808000","Top paste":"#808080","Bottom paste":"#800000",
  "Top mask":"#800080","Bottom mask":"#ff00ff",Multi:"#c0c0c0"};
for(const [k,v] of Object.entries(altium))assert.equal(PCB.color(k),v,k);
assert.equal(PCB.system.board,"#000000");assert.equal(PCB.system.selection,"#ffffff");
const inks=[...Object.keys(altium),"Keepout","Mechanical","Mechanical 2","Drill guide","Drill drawing",...Array.from({length:6},(_,i)=>"Inner "+(i+1))].map(PCB.color);
for(const key of ["selection","dim","hole","padHole","board","workspace","connection","boardGrid","boardGridCoarse"])assert.ok(!inks.includes(PCB.system[key]),key);
assert.equal(new Set(Object.values(PCB.system)).size,Object.keys(PCB.system).length,"system colors are distinct");
assert.equal(PCB.name("Inner 2"),"Mid-Layer 2");assert.equal(PCB.group("Inner 2"),"Signal Layers");
assert.equal(PCB.group("Mechanical 13"),"Mechanical Layers");assert.equal(PCB.group("Top mask"),"Other Layers");
// Ratsnest is Altium's thin solid connection line.
const unrouted=Atrium.sheet("pcb","Unrouted");
unrouted.items=[{id:"p1",kind:"pad",net:"N",x:0,y:0,w:1,h:1,layer:"Top"},{id:"p2",kind:"pad",net:"N",x:6,y:0,w:1,h:1,layer:"Top"}];
let dashed=false;ctx.setLineDash=a=>{dashed=a.length>0;};
view.fit(unrouted,new Map());marks.length=0;view.render(unrouted,new Map(),{grid:false,showUnrouted:true});
assert.ok(marks.some(m=>m[0]==="stroke"&&m[1]===PCB.system.connection));assert.equal(dashed,false);
delete ctx.setLineDash;view.fit(board,defs);
// The current layer draws above everything once other layers are dimmed.
assert.ok(PCB.order("Bottom","Bottom","dim")>PCB.order("Multi","Bottom","dim"));assert.ok(PCB.order("Bottom","Bottom")<PCB.order("Silk","Bottom"));
// User colors flow through every consumer, persist, and reset to Altium's defaults.
assert.ok(PCB.setColor("Top","#12AB34"));assert.equal(PCB.color("Top"),"#12ab34");assert.ok(PCB.isCustom("Top"));
assert.ok(!PCB.setColor("Top","red"));assert.ok(PCB.setSystem("board","#101010"));assert.equal(PCB.system.board,"#101010");
assert.ok(PCB.setOpacity("track",.5));assert.equal(PCB.opacity.track,.5);
render({layer:"Top"});assert.ok(stroked("#12ab34")>=0);assert.ok(marks.some(m=>m[0]==="fill"&&m[1]==="#101010"));
const saved=JSON.parse(store.get(PCB.storageKey));
assert.deepEqual(saved,{colors:{Top:"#12ab34"},system:{board:"#101010"},opacity:{track:.5}});
PCB.reset();assert.equal(PCB.color("Top"),"#ff0000");assert.equal(PCB.system.board,"#000000");assert.equal(PCB.opacity.track,1);
assert.deepEqual(JSON.parse(store.get(PCB.storageKey)),{colors:{},system:{},opacity:{}});
store.set(PCB.storageKey,"{not json");assert.doesNotThrow(()=>PCB.setColor("Bottom","#0000ff"));
store.set(PCB.storageKey,JSON.stringify({colors:{Top:"#010203",Silk:"yellow"},system:{selection:"#fafafa",bogus:"#000001"},opacity:{pour:2}}));
if(require.cache)delete require.cache[require.resolve("../../app/pcb/pcb-appearance.js")];
require("../../app/pcb/pcb-appearance.js");const reopened=AtriumPCBAppearance;globalThis.AtriumPCBAppearance=PCB;
assert.notEqual(reopened,PCB);assert.equal(reopened.color("Top"),"#010203");assert.equal(reopened.color("Silk"),"#ffff00");
assert.equal(reopened.system.selection,"#fafafa");assert.equal(reopened.system.bogus,undefined);assert.equal(reopened.opacity.pour,1);
board.items.push(trace("off sheet",30,"Top"));view.fit(board,defs,"board");const edgeOnly=view.scale();
view.fit(board,defs,"document");assert.ok(view.scale()<edgeOnly);
console.log("PASS Altium default palette and system colors; persisted user colors, opacity and reset; solid connection lines.");
console.log("PASS 2D layer palette; active copper and footprint draw order; exact drill sizes and blind-via spans; layer visibility, hit and selection; separate board and artwork zoom.");
{
  // Independently constructed Texts6 and Components6 records. A centred designator on a
  // rotated part and a right-anchored free label have deliberately distinct legacy origins.
  require("../../app/canvas/vectorize.js");require("../../app/pcb/pcb-text-rich.js");require("../../app/pcb/pcb-text.js");
  const block = b => { const length=Buffer.alloc(4);length.writeUInt32LE(b.length,0);return Buffer.concat([length,b]); };
  const props = s => block(Buffer.from(s+"\0","latin1"));
  function textRecord(text,owner,anchor,x,y,options={}) {
    const g=Buffer.alloc(252),point=(k,n)=>g.writeInt32LE(Math.round(n/.00000254),k);
    g[0]=33;g.writeUInt16LE(65535,3);g.writeUInt16LE(65535,5);g.writeUInt16LE(owner,7);
    point(13,2);point(17,3);point(21,2);g.writeDoubleLE(45,27);
    g[41]=owner!==65535?1:0;g[43]=1;point(124,4);point(128,1);g[132]=anchor;g[240]=1;point(244,x);point(248,y);
    if(options.comment){g[40]=1;g[41]=0;}
    if(options.stroke){g[43]=0;point(36,.2);}
    if(options.baseline)g[240]=0;
    if(options.bottom)g[0]=34;
    if(options.frame)g[230]=1;
    return Buffer.concat([Buffer.from([5]),block(g),block(Buffer.concat([Buffer.from([text.length]),Buffer.from(text)]))]);
  }
  const streams=new Map([["board6/data",props("|RECORD=Board")],["components6/data",props("|SOURCEDESIGNATOR=U1|SOURCECOMMENT=4k7|COMMENTON=TRUE|X=8mm|Y=7mm|ROTATION=90")],
    ["texts6/data",Buffer.concat([textRecord("U1",0,5,20,15),textRecord("AB",65535,9,23,15),
      textRecord(".Comment",0,7,14,10,{comment:true,stroke:true,bottom:true}),
      textRecord("A1",65535,7,99,99,{baseline:true,bottom:true}),textRecord("A\r\nB",65535,3,10,8,{frame:true})])]]);
  // Two invented triangular letters with counters. The bank is shared by
  // text indices 0 and 1; no browser font provider is installed in this test.
  const u32=v=>{const b=Buffer.alloc(4);b.writeUInt32LE(v,0);return b;};
  function triangle(ch,advance){
    const rings=[[[0,0],[200000,0],[0,200000]],[[20000,20000],[20000,40000],[40000,20000]]];
    const contours=Buffer.concat([u32(2),u32(0),u32(1),...rings.flatMap(r=>[u32(r.length),...r.map(q=>{
      const p=Buffer.alloc(16);p.writeDoubleLE(q[0],0);p.writeDoubleLE(q[1],8);return p;
    })])]);
    const head=Buffer.alloc(22);head.writeUInt16LE(ch.charCodeAt(0),0);head.writeInt32LE(advance,10);
    head.writeUInt32LE(contours.length+4,14);
    return Buffer.concat([head,u32(contours.length),contours]);
  }
  streams.set("lettersgeometry/data",Buffer.concat([u32(4),...Array.from("ABU1",ch=>triangle(ch,300000)),u32(2),u32(0),u32(1)]));
  // Openings are independent per face. A one-sided tented via, a
  // hole-only pad, and a manual zero on an SMD pad all survive plotting.
  function material(type,x,flags,w,h,drill,manual,corner=null,stack=null){
    const b=Buffer.alloc(type===2?202:321),dim=(off,n)=>b.writeInt32LE(Math.round(n/.00000254),off);
    b[0]=type===2 && !drill?1:74;b[1]=flags;
    b.writeUInt16LE(65535,3);b.writeUInt16LE(65535,5);b.writeUInt16LE(65535,7);
    dim(13,x);dim(17,2);dim(21,w);dim(25,h);
    if(type===3){
      dim(25,drill);b[29]=1;b[30]=32;b[66]=manual==null?1:2;dim(54,manual||0);
      return Buffer.concat([Buffer.from([3]),block(b)]);
    }
    b[49]=1;b[60]=1;dim(45,drill);b[101]=1;b[102]=manual==null?1:2;dim(90,manual||0);
    if(stack){b[62]=1;b[50]=1;b[51]=1;stack.forEach((n,j)=>dim(29+j*4,n));}
    const extended=Buffer.alloc(corner==null ? 0 : 596);
    if(corner!=null){extended[532]=9;extended[564]=corner;}
    return Buffer.concat([Buffer.from([2]),...Array.from({length:4},()=>block(Buffer.alloc(0))),block(b),block(extended)]);
  }
  const maskStreams=new Map([["board6/data",props("|RECORD=Board")],
    ["vias6/data",Buffer.concat([material(3,2,32,.6,.6,.3,.05),material(3,6,64,.6,.6,.3,null)])],
    ["pads6/data",Buffer.concat([material(2,10,0,0,0,1,.8),material(2,12,0,1,1,0,0),material(2,14,0,2,1,0,null,25),
      material(2,16,0,1,1,.3,.1,null,[1,1,2,2]),material(2,18,0,0,0,.3,0,null,[0,0,1,1])])]]);
  function copperTrace(layer,y){
    const g=Buffer.alloc(40);g[0]=layer;
    for(const n of [3,5,7])g.writeUInt16LE(65535,n);
    for(const [k,v] of [[13,1],[17,y],[21,3],[25,y],[29,.6]])g.writeInt32LE(Math.round(v/.00000254),k);
    return Buffer.concat([Buffer.from([4]),block(g)]);
  }
  maskStreams.set("tracks6/data",Buffer.concat([copperTrace(1,1),copperTrace(32,4),copperTrace(1,3)]));
  maskStreams.set("extendedprimitiveinformation/data",Buffer.concat([
    props("|PRIMITIVEINDEX=0|PRIMITIVEOBJECTID=Track|TYPE=Mask|SOLDERMASKEXPANSIONMODE=Manual|SOLDERMASKEXPANSION_MANUAL=0mil|PASTEMASKEXPANSIONMODE=None"),
    props("|PRIMITIVEINDEX=1|PRIMITIVEOBJECTID=Track|TYPE=Mask|SOLDERMASKEXPANSIONMODE=Manual|SOLDERMASKEXPANSION_MANUAL=-0.31mm|PASTEMASKEXPANSIONMODE=Manual|PASTEMASKEXPANSION_MANUAL=0.1mm")]));
  const sample=AtriumPCB.read("Apertures.PcbDoc",maskStreams,null),board=sample.documents[0],project=Atrium.project("Apertures",[]);
  board.outline=[[0,0],[14,0],[14,-5],[0,-5]];project.documents=[board];project.library=sample.library;
  const hole=board.items.find(i=>i.holeOnly);assert(hole && hole.drill>0 && !hole.plotLand);
  assert.deepEqual(board.items.filter(i=>i.kind==="via").map(v=>v.tent),[{top:true,bottom:false},{top:false,bottom:true}]);
  for(const m of ["zip","fab-outputs"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
  const built=AtriumFabOutputs.build(project,board.id,{origin:"absolute",tentVias:true});
  const film=ext=>require("../formats/gerber-compare.cjs").parseGerber(built.files.find(f=>f.name.endsWith("."+ext)).content).flashes;
  function aperture(ext,x){
    const flash=film(ext).find(f=>Math.abs(f.x-x)<.00001);
    return flash && flash.ap.params[0];
  }
  assert.equal(aperture("GTS",2),undefined);assert(Math.abs(aperture("GBS",2)-.7)<.00001);
  assert(Math.abs(aperture("GTS",6)-.8032)<.00001);assert.equal(aperture("GBS",6),undefined);
  assert(Math.abs(aperture("GTS",10)-1.6)<.00001);assert.equal(aperture("GTL",10),undefined);
  assert(Math.abs(aperture("GTS",12)-1)<.00001,"manual zero overrides the fabrication default");
  const copperTracks=board.items.filter(i=>i.kind==="track"),parseExt=(f,ext)=>require("../formats/gerber-compare.cjs").parseGerber(f.files.find(a=>a.name.endsWith("."+ext)).content);
  const close=(a,b)=>Math.abs(a-b)<.000005;
  assert.deepEqual(copperTracks.map(i=>[i.maskExpansion,i.pasteExpansion]),[[0,undefined],[-.31,.1],[undefined,undefined]]);
  const topOpening=parseExt(built,"GTS").draws;
  assert.equal(topOpening.length,1);assert(close(topOpening[0].width,.6));
  assert(topOpening[0].points.every(([x,y],k)=>close(x,k?3:1) && close(y,1)));
  assert.equal(parseExt(built,"GBS").draws.length,0);assert.equal(parseExt(built,"GTP").draws.length,0);
  assert(close(parseExt(built,"GBP").draws[0].width,.8));
  const surface=PCB.footprintLayers({layer:"Top"},{pads:[],shapes:[{...copperTracks[0],kind:"path"}]});
  assert(surface.some(g=>g.layer==="Top mask" && close(g.shapes[0].width,.6)));
  marks.length=0;view.fit(board,new Map());view.render(board,new Map(),{grid:false,layer:"Top mask",layerMode:"single"});
  assert(stroked(PCB.color("Top mask"))>=0,"the exposed route is visible when its copper layer is hidden");
  assert.strictEqual(view.hit(board,new Map(),[2,-1],{layer:"Top mask",layerMode:"single"}),copperTracks[0]);
  const e=copperTracks[0];e.width=.4;e.points=[[2,-1.5],[4,-1.5]];
  const moved=parseExt(AtriumFabOutputs.build(project,board.id,{origin:"absolute"}),"GTS").draws;
  assert.equal(moved.length,1);assert(close(moved[0].width,.4));assert.deepEqual(moved[0].points,[[2,1.5],[4,1.5]]);
  const rounded=board.items.find(p=>p.shape==="roundrect");assert.equal(rounded.roundrectRadiusRatio,.125);
  function cornerRadius(ext){return film(ext).find(f=>Math.abs(f.x-14)<.00001).shapes.find(s=>s.k==="circle").r;}
  assert(Math.abs(cornerRadius("GTL")-.125)<.00001);
  assert(Math.abs(cornerRadius("GTS")-.2266)<.00001,"mask expansion offsets the copper corner");
  assert(Math.abs(aperture("GTL",16)-1)<.00001 && Math.abs(aperture("GBL",16)-2)<.00001);
  assert(Math.abs(aperture("GTS",16)-1.2)<.00001 && Math.abs(aperture("GBS",16)-2.2)<.00001);
  assert.equal(aperture("GTL",18),undefined);assert(Math.abs(aperture("GBL",18)-1)<.00001);
  assert.equal(board.items.find(p=>p.stackMode==="tmb" && p.padStack.Top.w===0).holeOnly,undefined,"an inner or bottom land is still copper");
  const zeroTop=board.items.find(p=>p.padStack?.Top.w===0);
  assert.equal(PCB.displayPad(zeroTop,"Top").w,zeroTop.drill,"an empty pad land shows the physical hole");
  require("../../app/pcb/viastack.js");
  const stackVia={kind:"via",stackMode:"tmb",diameter:.9,drill:.35,padStack:{Top:{diameter:1.2},Mid:{diameter:.7},Bottom:{diameter:1}}};
  assert.equal(PCB.displayPad(stackVia,"Top").diameter,1.2,"via stack rows use their diameter");
  assert.equal(PCB.displayPad(stackVia,"Inner 1").diameter,.7);
  assert.equal(PCB.displayPad(stackVia,"Bottom").diameter,1);
  assert.equal(AtriumViaStack.hasMark({...stackVia,tent:{top:false,bottom:false}}),false);
  assert.equal(AtriumViaStack.hasMark({...stackVia,tent:{top:true,bottom:true}}),false);
  assert.equal(AtriumViaStack.hasMark({...stackVia,ipc4761:"VII"}),true);
  require("../../app/formats/altium-export.js");
  const ascii=AtriumAltiumExport.exportBoard(project,board).content;
  const asciiPads=AtriumPCB.read("Corners.PcbDoc",null,ascii).documents[0].items;
  const openedTrack=asciiPads.find(p=>p.kind==="track" && p.maskExpansion===0);
  assert(openedTrack && close(openedTrack.width,.4) && openedTrack.pasteExpansion===undefined);
  assert(close(asciiPads.find(p=>p.kind==="track" && p.layer==="Bottom").pasteExpansion,.1));
  assert.equal(asciiPads.find(p=>p.shape==="roundrect").roundrectRadiusRatio,.125);
  assert(asciiPads.some(p=>p.stackMode==="tmb" && Math.abs(p.padStack.Bottom.w-2)<.00001));
  const asm=AtriumFabOutputs.assembly({extents:[0,0,20,10],outline:[],doc:board,
    parts:[{item:{x:0,y:0,ref:"J1"},fp:{pads:[hole,{x:12,y:2,w:1,h:1,shape:"rect"}]},side:"Top"}]},"Top",{date:new Date(0)}).content;
  assert.equal(asm.match(/<g id="pads"[^>]*>([\s\S]*?)<\/g>/)[1].match(/<polygon/g).length,1,"drill-only geometry is not a component land");
  // An older board stores writing origins and font programs, before glyph
  // banks/justification. Use the shipped open font to construct an independent
  // source, including a mirrored, rotated glyph with a descender.
  for(const m of ["sexpr","path-record","pdf","vendor/dejavu-sans","pdf-fonts","altium-typefaces"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
  const font=AtriumPDFFonts.font(),packed=AtriumPDF.deflate(font.bytes);
  const fontName=s=>block(Buffer.from(s+"\0","utf16le"));
  const embedded=Buffer.concat([fontName("Test typeface"),fontName("Test typeface"),fontName("Regular"),Buffer.from([0,0,1]),block(packed)]);
  const oldText=Buffer.from(textRecord("g",65535,5,0,0));
  oldText[5]=34;oldText[5+35]=1;oldText[5+240]=0;
  oldText.writeInt32LE(0,5+124);oldText.writeInt32LE(0,5+128);
  Buffer.from("Test typeface","utf16le").copy(oldText,5+46);
  const oldStreams=new Map([["board6/data",props("|RECORD=Board")],["texts6/data",oldText],["embeddedfonts6/data",embedded]]);
  const oldBoard=AtriumPCB.read("Old.PcbDoc",oldStreams,null).documents[0],oldLabel=oldBoard.items[0],T0=AtriumPCBText;
  const ll=T0.layoutItem(T0.withLetters(oldLabel,oldBoard));
  assert.equal(ll.strokes.length,0);assert.equal(ll.polygons.length,1);assert.equal(ll.polygons[0].holes.length,1);
  assert(Math.abs(ll.box[2])<1e-8 && ll.box[3]>0,"mirrored legacy text starts at the ink edge and descends below the writing baseline");
  assert(!JSON.stringify(oldBoard).includes(AtriumFontDejaVuSans),"used outlines only");
  assert.equal(oldBoard.pcbDrawing.letterSets.length,1);
  assert(Number.isInteger(oldBoard.pcbDrawing.letterSets[0]["g".codePointAt(0)][0]));
  const {documents:[d]}=AtriumPCB.read("Rotated.PcbDoc",streams,null);
  const part=d.items.find(i=>i.kind==="part"),native=PCB.sourceLabels(d,part)[0],free=d.items.find(i=>i.kind==="label"),T=AtriumPCBText;
  const near=(a,b)=>assert.ok(Math.abs(a-b)<.00001,a+" ≈ "+b);
  const [wx,wy]=Atrium.world(native.at,part);
  near(wx,20);near(wy,-15);near(part.angle+native.angle,-45);
  assert.equal(native.justify,"center");near(free.x,23);near(free.y,-15);assert.equal(free.justify,"bottom-right");
  const text=PCB.annotationText(part,native);
  const bound=T.withLetters(free,d),sourceLayout=T.layoutItem(bound);
  assert.equal(d.pcbDrawing.letterSets.length,1);
  assert.equal(sourceLayout.polygons.length,2);assert.equal(sourceLayout.polygons[0].holes.length,1);
  assert.equal(sourceLayout.strokes.length,0);
  const inverted=T.layoutItem(T.withLetters({...free,justify:"center",inverted:true,margin:.1,
    sourceTextBox:{...free.sourceTextBox,mode:"frame",width:6,height:3}},d));
  inverted.box.forEach((v,j)=>near(v,[-3,-1.5,3,1.5][j]));
  assert.equal(inverted.polygons[0].outer.length,4);assert.equal(inverted.polygons[0].holes.length,2);
  assert.equal(inverted.polygons.length,3,"saved counters remain positive islands in the native knockout frame");
  const translated=T.withLetters({...free,x:free.x+4,angle:free.angle+90},d);
  assert.strictEqual(T.layoutItem(translated),sourceLayout,"moving or rotating reuses local glyph contours");
  const restored=JSON.parse(JSON.stringify(d));
  assert.deepEqual(T.toPrimitives(T.withLetters(free,restored)),T.toPrimitives(bound),"saved board retains source outlines");
  const edit=T.withLetters({...free,text:"AA",mirrored:true},d);
  assert.equal(T.layoutItem(edit).polygons.length,2);
  assert.notDeepEqual(T.layoutItem(edit).box,sourceLayout.box);
  assert.equal(T.layoutItem(T.withLetters({...free,family:"Different"},d)).polygons.length,0,"changing typeface releases saved outlines");
  const boxes=[T.layoutItem(text).box,T.layoutItem(free).box];
  for(const [n,expected] of [[0,[-2,-.5,2,.5]],[1,[-4,-1,0,0]]])boxes[n].forEach((v,k)=>near(v,expected[k]));
  assert.notDeepEqual(T.layoutItem({...text,text:"U1234"}).box,boxes[0],"edited text no longer uses the recorded width");
  const value=PCB.sourceLabels(d,part).find(a=>a.field==="value"),label=PCB.annotationText(part,value);
  assert.equal(label.text,"4k7");assert.equal(label.mirrored,false);
  assert.equal(label.justify,"top-right");assert.equal(label.sourceTextBox.font,"stroke");
  const v=T.layoutItem(label);assert.ok(v.strokes.length);
  v.box.forEach((n,k)=>near(n,[-3.9,.1,-.1,.9][k]));
  const manual=d.items.find(i=>i.text==="A1");assert.equal(manual.sourceTextBox.mode,"baseline");
  near(manual.x,2);near(manual.y,-3);assert.equal(manual.mirrored,false);
  assert.equal(d.items.find(i=>i.text==="A\r\nB").sourceTextBox.mode,"frame");
  const v1=AtriumPCB.read("Rotated.PcbDoc",streams,null,{textPlacement:1}).documents[0];
  assert.equal(v1.pcbDrawing.textPlacement,1);
  assert.equal(PCB.sourceLabels(v1,v1.items.find(i=>i.kind==="part"))[1].sourceTextBox,undefined);
  const old=AtriumPCB.read("Rotated.PcbDoc",streams,null,{textPlacement:false}).documents[0];
  const before=old.items.find(i=>i.kind==="label");near(before.x,2);near(before.y,-3);assert.equal(before.justify,undefined);
}
const flag=process.argv.indexOf("--fixtures");
if(flag>=0){
  const file="qfsae-0.PcbDoc",data=fs.readFileSync(path.join(process.argv[flag+1],file));
  const {documents:[d],library}=AtriumIO.read(file,data), byDef=new Map(library.map(g=>[g.id,g]));
  const source=AtriumSourceFile.open(data),t=Buffer.from(source.read("Texts6/Data"));
  let actual=0;
  for(let n=0;n<t.length;){
    const size=t.readUInt32LE(n+1)&0xffffff,body=t.subarray(n+5,n+5+size);n+=5+size;
    const textSize=t.readUInt32LE(n)&0xffffff;n+=4+textSize;
    if(!body[41])continue;
    const owner="components6/data#"+body.readUInt16LE(7),part=d.items.find(i=>i.sourceRecord===owner);
    const label=d.pcbDrawing.annotations[owner]?.find(a=>a.field==="ref");
    assert.ok(label);const world=Atrium.world(label.at,part);
    const start=body.length>=252 && body[240] && body[43]<2 && !body[110] && body[132]>=1 && body[132]<=9 && body.readInt32LE(124)>0 && body.readInt32LE(128)>0 ? 244 : 13;
    for(const [i,source] of [body.readInt32LE(start)*.00000254,-body.readInt32LE(start+4)*.00000254].entries())assert.ok(Math.abs(world[i]-source)<1e-7);
    assert.ok(Math.abs(part.angle+label.angle+body.readDoubleLE(27))<1e-8);
    assert.equal(label.size,body.readInt32LE(21)*.00000254);assert.equal(label.mirrored,!!body[35]);actual++;
  }
  assert.equal(actual,52);assert.equal(Object.values(d.pcbDrawing.annotations).flat().length,52);
  view.fit(d,byDef,"board");view.render(d,byDef,{grid:false,layer:"Top"});
  console.log("PASS PDP V3 imported board: all 52 visible designators match source anchors, heights, orientations and mirroring; all suppressed comments stay hidden.");
}
