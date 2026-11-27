"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/checks/connectivity.js");
const A=Atrium,C=AtriumConnectivity,defs=new Map();
const track=(id,net,points,layer="Top",width=.2)=>({id,kind:"track",net,points,layer,width});
const pad=(id,net,x,y,w=1,h=w,angle=0,shape="round",layer="Top",drill=0)=>({id,kind:"pad",number:"1",net,x,y,w,h,angle,shape,layer,drill});
const via=(id,net,x,y,fromLayer="Top",toLayer="Bottom",diameter=1,drill=.4)=>({id,kind:"via",net,x,y,fromLayer,toLayer,diameter,drill,layer:"Multi"});
const board=items=>({...A.sheet("pcb","Test"),items});
const inspect=items=>C.inspect(board(items),defs);
const once=(r,name)=>r.nets.find(n=>n.name===name);
{
  const slot={...pad("slot","A",0,0,6,2,0,"rect","Multi",.8),slotLength:4,plated:true};
  const probe=x=>pad("probe","B",x,0,.2,.2);
  assert.equal(inspect([slot,probe(1.2)]).shorts.length,0,"slot centreline is void");
  assert.equal(inspect([slot,probe(1.85)]).shorts.length,0,"slot end cap is void");
  assert.equal(inspect([slot,probe(1.96)]).shorts.length,1,"crossing the slot wall contacts the land");
  const oval=pad("oval","B",1.1,0,1.2,.2,0,"ellipse");
  assert.equal(inspect([slot,oval]).shorts.length,0,"an elliptical pad can fit along the slot");
}
{
  // A back-drill removes the land and barrel beyond its stop layer (AtriumViaStack.padOn, as DRC clearance).
  require("../../app/pcb/stackup.js");require("../../app/pcb/viastack.js");
  const drilled=via("v","A",0,0,"Top","Bottom",.8,.3);drilled.backdrill={from:"bottom",toLayer:"Inner 1",stubMax:.2};
  const top=track("t","A",[[0,0],[2,0]]),bottom=track("b","A",[[0,0],[-2,0]],"Bottom");
  assert.equal(inspect([drilled,track("x","B",[[0,0],[2,0]],"Bottom")]).shorts.length,0,"no bottom land to short");
  assert.equal(once(inspect([drilled,top,bottom]),"A").islands,2,"the barrel no longer joins the bottom");
  assert.equal(once(inspect([{...drilled,backdrill:undefined},top,bottom]),"A").islands,1);
  assert.equal(inspect([drilled,track("y","B",[[0,0],[2,0]])]).shorts.length,1,"the top land remains");
}
{
  // An unplated land keeps its pad's net, one node per copper layer and no barrel (DRC treats it the same way).
  // A GND mounting hole: 6 mm land, 3.2 mm drill; the ring runs from 1.6 to 3 mm.
  const mh={...pad("mh","GND",0,0,6,6,0,"round","Multi",3.2),plated:false};
  const across=(id,net,y,layer="Top")=>track(id,net,[[-5,y],[5,y]],layer);
  let r=inspect([mh,across("g","GND",2.5)]);
  assert.deepEqual([r.shorts.length,r.airwires.length,once(r,"GND").islands,once(r,"GND").pads],[0,0,1,1],"its own net touches it");
  assert.deepEqual(inspect([mh,across("v","VCC",2.5)]).shorts.map(s=>s.nets),[["GND","VCC"]],"another net crossing the ring is a short");
  assert.equal(inspect([mh,across("v","VCC",3.15)]).shorts.length,0,"near the ring is the DRC's clearance, not a short");
  assert.deepEqual(inspect([mh,across("v","VCC",2.5,"Bottom")]).shorts.map(s=>s.nets),[["GND","VCC"]],"the bottom land");
  // No barrel: top and bottom lands are separate islands, so a net on each side is two shorts with GND, not one.
  assert.deepEqual(inspect([mh,across("b","B",2.5),across("c","C",2.5,"Bottom")]).shorts.map(s=>s.nets),[["B","GND"],["C","GND"]]);
  // The ratsnest takes the pad's lands as one terminal: no airwire between them.
  r=inspect([mh]);
  assert.deepEqual([r.airwires.length,once(r,"GND").islands,once(r,"GND").pads,r.unassigned,r.stats.objects],[0,1,1,0,2]);
  const left=pad("p1","GND",-10,0,1,1,0,"round","Multi",.5),right=pad("p2","GND",10,0,1,1,0,"round","Multi",.5);
  r=inspect([mh,left,right,track("a","GND",[[-10,0],[-2.5,0]]),track("b","GND",[[2.5,0],[10,0]],"Bottom")]);
  assert.deepEqual([r.airwires.length,once(r,"GND").islands,once(r,"GND").missing],[0,1,0],"reached on each side, no zero-length airwire");
  // Pins that reach the land still need connecting to the rest of the net, never through a land-to-land airwire.
  r=inspect([mh,left,right,track("a","GND",[[-10,0],[-2.5,0]])]);
  assert.deepEqual(r.airwires.map(w=>[w.fromId,w.toId,w.distance]),[["mh","p2",10]]);
  // A land nothing of its net touches is optional, as on a board whose pour keeps clear of it.
  r=inspect([mh,left,right]);
  assert.deepEqual([r.airwires.map(w=>[w.fromId,w.toId]),once(r,"GND").islands,once(r,"GND").pads],[[["p1","p2"]],2,3]);
  // A footprint's mounting hole takes its pin's net.
  const lib=new Map([["MH",{id:"MH",footprint:{pads:[{number:"1",x:0,y:0,w:6,h:6,shape:"round",layer:"Multi",drill:3.2,plated:false}],shapes:[]}}]]);
  const part={id:"H",kind:"part",def:"MH",ref:"H1",x:0,y:0,pinNets:{"1":"GND"}};
  assert.deepEqual(C.inspect(board([part,across("v","VCC",2.5)]),lib).shorts.map(s=>s.nets),[["GND","VCC"]]);
  r=C.inspect(board([part,across("g","GND",2.5),track("g2","GND",[[20,0],[25,0]])]),lib);
  assert.deepEqual([r.airwires.length,once(r,"GND").islands],[1,2]);
  assert.ok(r.airwires[0].distance>0);
  // With no net the land is netless copper: one net may touch it, a land bridging two nets is a short,
  // and nothing joins its top and bottom lands.
  const bare={...mh,net:""};
  assert.equal(inspect([bare,across("b","B",2.5)]).shorts.length,0,"one net touching the land is no short");
  assert.deepEqual(inspect([bare,across("b","B",2.5),track("c","C",[[0,-5],[0,-2.5]])]).shorts.map(s=>s.nets),[["B","C"]],"two nets bridged by the land");
  assert.equal(inspect([bare,across("b","B",2.5),across("c","C",2.5,"Bottom")]).shorts.length,0,"no barrel joins the top and bottom lands");
  assert.equal(once(inspect([bare,across("t","N",2.5),across("u","N",2.5,"Bottom")]),"N").islands,2);
  assert.equal(inspect([bare]).unassigned,1);
  assert.deepEqual(inspect([{...mh,layer:"Top"},across("v","VCC",2.5)]).shorts.map(s=>s.nets),[["GND","VCC"]],"a single-layer unplated land carries its net too");
}
require("../../app/checks/rules.js");
{
  const fp={id:"FP",footprint:{name:"Bridge",pads:[
    {number:"1",x:-2,y:0,w:1,h:1,shape:"rect",layer:"Top"},
    {number:"2",x:2,y:0,w:1,h:1,shape:"rect",layer:"Top"}],
    shapes:[{kind:"path",layer:"Top",fill:true,width:0,closed:true,points:[[-2.6,-.4],[2.6,-.4],[2.6,.4],[-2.6,.4]]}]}};
  const lib=new Map([["FP",fp]]);
  const part={kind:"part",id:"U1",ref:"U1",def:"FP",x:0,y:0,angle:0,pinNets:{"1":"A","2":"B"}};
  const out=AtriumRules.drc(board([part]),lib,AtriumRules.create(),{types:["short"]});
  assert.equal(out.violations.filter(v=>v.type==="short").length,1);
  part.pinNets={"1":"A","2":"A"};
  assert.equal(C.inspect(board([part]),lib).airwires.length,0);
}

function separatedLayers(){
  const items=[track("a","N",[[-5,0],[5,0]]),track("b","N",[[0,-5],[0,5]],"Bottom")];
  const two=inspect(items);
  assert.equal(once(two,"N").islands,2);assert.equal(two.airwires.length,1);
  assert.equal(inspect([...items,via("v","N",0,0)]).airwires.length,0);
  const blind=inspect([...items,via("v","N",0,0,"Top","Inner 2")]);assert.equal(blind.airwires.length,1);
  const cross=inspect([...items,track("c","Other",[[2,-3],[2,3]])]);assert.deepEqual(cross.shorts[0].nets,["N","Other"]);
  assert.equal(once(cross,"N").shorted,true);
}
function copperContacts(){
  assert.equal(inspect([track("a","N",[[0,0],[5,0]]),track("b","N",[[0,.19],[5,.19]])]).airwires.length,0);
  assert.equal(inspect([track("a","N",[[0,0],[5,0]]),track("b","N",[[0,.201],[5,.201]])]).airwires.length,1);
  assert.equal(inspect([pad("ellipse","N",0,0,4,1,45),pad("probe","N",1.35,1.35,.1)]).airwires.length,0);
  assert.equal(inspect([pad("ellipse","N",0,0,4,1,45),pad("probe","N",1.35,-1.35,.1)]).airwires.length,1);
  const pos=[1.7/Math.sqrt(2),1.7/Math.sqrt(2)];
  assert.equal(inspect([pad("rect","N",0,0,4,.3,45,"rect"),pad("probe","N",...pos,.1)]).airwires.length,0);
  assert.equal(inspect([pad("roundrect","N",0,0,2,2,0,"roundrect"),pad("p","N",.99,.99,.02)]).airwires.length,1);
  assert.equal(inspect([pad("oct","N",0,0,2,2,0,"octagonal"),pad("p","N",.96,.96,.02)]).airwires.length,1);
  assert.equal(inspect([via("v","A",0,0),pad("inside-drill","B",0,0,.05)]).shorts.length,0);
  assert.equal(inspect([via("v","A",0,0),pad("ring","B",.28,0,.05)]).shorts.length,1);
  assert.equal(inspect([via("v","A",0,0),pad("ellipse","B",.02,0,.2,.06,37)]).shorts.length,0);
  assert.equal(inspect([pad("outer","N",0,0,1),pad("tangent","N",1,0,1)]).airwires.length,0);
  assert.equal(inspect([pad("outer","N",0,0,1),pad("gap","N",1.00001,0,1)]).airwires.length,1);
}
function unassignedAndGeometry(){
  const items=[pad("a","A",0,0),pad("b","B",5,0),track("bridge","",[[0,0],[5,0]])],r=inspect(items);
  assert.equal(r.unassigned,1);assert.equal(r.shorts.length,1);assert.deepEqual(r.shorts[0].nets,["A","B"]);
  // A netless board fill is copper (pcb-draw review H6): counted as unassigned copper, not excluded.
  assert.equal(inspect([...items.slice(0,2),{id:"fill",kind:"graphic",fill:true,layer:"Top",points:[[0,0],[5,0],[5,2]]}]).excluded,0);
  assert.equal(inspect([pad("npth","",0,0,2,2,0,"round","Mechanical",2)]).stats.objects,0);
  const mountingHole={...pad("mount","",0,0,2,2,0,"round","Multi",2),plated:false};
  assert.equal(inspect([mountingHole]).excluded,0,"a drill-only mounting hole has no copper to exclude");
  const ringed=inspect([{...mountingHole,w:3,h:3}]);
  assert.deepEqual([ringed.excluded,ringed.unassigned,ringed.stats.objects],[0,1,2],"an unplated land is netless copper, one node per layer");
  const fp={id:"FP",footprint:{pads:[{x:1,y:0,w:2,h:.4,angle:10,shape:"rect",number:"1",net:"WRONG",layer:"Top"}],shapes:[]}};
  const component={id:"P",kind:"part",def:"FP",ref:"U1",x:3,y:4,angle:90,pinNets:{"1":"N"}};
  const point=A.world([1,0],component);
  const inspected=C.inspect(board([component,track("R","N",[point,[4,6]])]),new Map([["FP",fp]]));
  assert.equal(inspected.nets.length,1);assert.equal(once(inspected,"N").islands,1);
}
function ratTree(){
  const items=[pad("a","N",0,0),pad("b","N",4,0),pad("c","N",9,0),pad("d","N",20,0)];
  const r=inspect(items);assert.equal(once(r,"N").missing,3);
  assert.deepEqual(r.airwires.map(w=>w.distance).sort((a,b)=>a-b),[4,5,11]);
  assert.deepEqual(inspect(items.slice().reverse()).airwires,r.airwires);
  const sparse=inspect(Array.from({length:800},(_,j)=>pad("p"+j,"N",j%100*3,Math.floor(j/100)*3)));
  assert.equal(sparse.airwires.length,799);assert.equal(sparse.stats.candidates,0);assert.ok(sparse.airwires.every(w=>w.distance===3));
}
function defaultBoard() {
  require("../../app/checks/rules.js");
  const p=AtriumParts.example(),d=p.documents.find(x=>x.kind==="pcb"),lib=new Map(p.library.map(x=>[x.id,x]));
  const result=C.inspect(d,lib);
  assert.equal(result.nets.length,6);
  assert.deepEqual(result.shorts,[]);assert.deepEqual(result.airwires,[]);
  assert.deepEqual(AtriumRules.check(d,lib).issues,[]);
}
function independentFootprintFeatures() {
  const pads=[{number:"1",x:-3,y:0,w:.6,h:.6,shape:"round"},{number:"2",x:3,y:0,w:.6,h:.6,shape:"round"}];
  const footprint={id:"FP",footprint:{pads,shapes:[]}},lib=new Map([["FP",footprint]]);
  const item={id:"chip",kind:"part",ref:"U1",def:"FP",x:20,y:20,angle:45,pinNets:{"1":"A","2":"A"}};
  const between=pad("between","B",20,20,.2),d=board([item,between]);
  let result=C.inspect(d,lib);
  assert.equal(once(result,"A").missing,1);assert.equal(result.shorts.length,0);
  footprint.footprint.shapes.push({kind:"path",layer:"Top",width:.2,net:"A",points:[[-3,0],[3,0]]});
  result=C.inspect(d,lib);assert.equal(once(result,"A").missing,0);assert.equal(result.shorts.length,1);assert.ok(result.shorts[0].direct);
  footprint.footprint.shapes[0].layer="Silk";
  result=C.inspect(d,lib);assert.equal(once(result,"A").missing,1);assert.equal(result.shorts.length,0);
}
function compoundCopperRegions() {
  require("../../app/pcb/board-shape-core.js");
  const outer=[[0,0],[10,0],[10,10],[0,10]],hole=[[8,2],[2,2],[2,8],[8,8]];
  const slit=[[0,0],[10,0],[10,2],...hole,hole[0],[10,2],[10,10],[0,10]];
  const contour=points=>points.map((a,i)=>({kind:"line",a,b:points[(i+1)%points.length]}));
  for(const points of [outer,slit]){
    const fill={id:"fill",kind:"graphic",net:"A",layer:"Top",fill:true,points,
      regionShape:{version:1,sig:AtriumBoardShape.signature(points),contour:contour(outer),cutouts:[contour(hole)]}};
    assert.equal(inspect([fill,pad("in-void","B",5,5)]).shorts.length,0);
    assert.deepEqual(inspect([fill,pad("crossing","B",2.4,5)]).shorts.map(s=>s.nets),[["A","B"]]);
    assert.deepEqual(inspect([fill,pad("in-copper","B",1,5)]).shorts.map(s=>s.nets),[["A","B"]]);
    assert.equal(inspect([fill,track("in-void","B",[[3,3],[7,7]])]).shorts.length,0);
  }
}
separatedLayers();copperContacts();unassignedAndGeometry();ratTree();independentFootprintFeatures();compoundCopperRegions();defaultBoard();
console.log("PCB connectivity tests passed: geometry, layer spans, drill holes, physical shorts, pad nets and stable ratsnest.");
const root=process.argv[process.argv.indexOf("--fixtures")+1];
if(process.argv.includes("--fixtures")){
  global.CFB=require("../../app/vendor/cfb.min.js");require("../../app/formats/pcb-import.js");require("../../app/formats/io.js");
  const result=AtriumIO.read("PDP_V3.PcbDoc",fs.readFileSync(path.join(root,"qfsae-0.PcbDoc")));
  const start=performance.now(),r=C.inspect(result.documents[0],new Map(result.library.map(d=>[d.id,d]))),ms=performance.now()-start;
  assert.equal(r.nets.length,42);assert.equal(r.nets.reduce((s,n)=>s+n.vias,0),53);assert.equal(r.nets.reduce((s,n)=>s+n.missing,0),r.airwires.length);
  assert.ok(r.stats.candidates<r.stats.features*r.stats.features/20);
  console.log(JSON.stringify({fixture:"PDP_V3",nets:r.nets.length,airwires:r.airwires.length,shorts:r.shorts.length,excluded:r.excluded,unassigned:r.unassigned,ms:ms.toFixed(1),...r.stats}));
}
{
  // Shorts without airwires (DRC without the un-routed check): the same shorts, the same order; a grid of
  // stacked, crossing and overlapping copper on many nets (the broad phase visits pairs in sweep order).
  const items=[];let k=0;
  for(let x=0;x<14;x++)for(let y=0;y<14;y++){
    const net="N"+((x*7+y*3)%9),at=[x*1.3,y*1.1];
    if((x+y)%3===0)items.push(track("t"+(++k),net,[at,[at[0]+1.6,at[1]+(x%2?.9:-.4)]],(x%2?"Top":"Bottom"),.25+(y%3)*.1));
    else if((x+y)%3===1)items.push(via("v"+(++k),net,at[0]+.2,at[1],"Top","Bottom",.7,.3));
    else items.push(pad("p"+(++k),net,at[0],at[1],.9,.6,(x*15)%90,"rect"));
  }
  const b=board(items),full=C.inspectFull(b,defs),lean=C.inspectFull(b,defs,{airwires:false});
  assert.ok(full.shorts.length>5,"the grid shorts nets: "+full.shorts.length);
  assert.deepEqual(lean.shorts,full.shorts);assert.deepEqual(lean.airwires,[]);
  assert.ok(lean.nets.every(n=>n.missing===null)&&full.nets.every(n=>Number.isInteger(n.missing)));
  console.log("ok - shorts without airwires equal the full pass's ("+full.shorts.length+" shorts)");
}
