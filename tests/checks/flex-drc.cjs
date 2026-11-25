"use strict";
// Flex routing and flex construction DRC (flex-drc.js through rules.js): teardrops in flex,
// stacked traces, track ends in bend zones, bend-to-rigid transition, stiffener gap,
// overlapping bend zones, bend lines that cannot fold, and coverlay webs.
const assert=require("node:assert/strict");
for(const m of ["model","rules","impedance","stackup","rigid-flex","flex-drc"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const S=AtriumStackup,RF=AtriumRigidFlex,R=AtriumRules,A=Atrium;
const TYPES=["flexRouting","flexBuild"];

function board(){
  const doc=A.sheet("pcb","Flex");doc.outline=[[0,0],[100,0],[100,30],[0,30]];
  const st=S.preset(4);delete st.derived;
  const cu=st.layers.filter(S.isCopper);
  st.substacks=[{id:"flex",name:"Flex",flex:true,layers:S.flexLayers(["Top","Bottom"],cu)},
    {id:"flex-stiff",name:"Flex + stiffener",flex:true,layers:[...S.flexLayers(["Top","Bottom"],cu),{type:"Stiffener",name:"Bottom Stiffener",material:"FR-4",thickness:.3}]}];
  doc.stackup=JSON.parse(JSON.stringify(st));
  S.splitRegion(doc,{a:[30,-1],b:[30,31]});S.splitRegion(doc,{a:[70,-1],b:[70,31]});S.splitRegion(doc,{a:[60,-1],b:[60,31]});
  const at=p=>RF.regions(doc).find(g=>RF.geometry.inside(p,g.points)).id;
  S.assignStack(doc,at([45,15]),"flex");S.assignStack(doc,at([65,15]),"flex-stiff");
  return doc;
}
const rules=R.create();
assert.ok(TYPES.every(t=>rules.list.some(r=>r.type===t)),"default rule set has the flex rules");
R.validate(JSON.parse(JSON.stringify(rules)));
assert.ok(R.categories.includes("Rigid-Flex"));

// A clean flex tail: perpendicular continuous tracks, teardrops, bend far from rigid.
{
  const doc=board();RF.addBend(doc,{a:[45,0],b:[45,30],angle:90,radius:2,name:"B1"});
  doc.items.push({id:"t1",kind:"track",net:"A",points:[[20,10],[55,10]],width:.2,layer:"Top"},
    {id:"t2",kind:"track",net:"B",points:[[20,12],[55,12]],width:.2,layer:"Bottom"});
  const out=R.drc(doc,new Map(),rules,{types:TYPES});
  assert.deepEqual(out.violations.map(v=>v.type+": "+v.title),[]);
  assert.ok(out.rules.some(r=>r.type==="flexRouting")&&out.rules.some(r=>r.type==="flexBuild"));
}
// Routing faults.
{
  const doc=board();RF.addBend(doc,{a:[45,0],b:[45,30],angle:90,radius:2,name:"B1"});
  const T=(id,points,layer="Top",net="S",width=.2)=>({id,kind:"track",net,points,width,layer});
  doc.items.push(
    T("stackTop",[[35,5],[55,5]],"Top","P"),T("stackBot",[[35,5.05],[55,5.05]],"Bottom","Q"),  // I-beam over 20 mm
    T("stub",[[35,20],[45,20]],"Top","R"),                                                 // ends in the bend zone
    T("toVia",[[38,25],[41,25]],"Top","V"),{id:"v1",kind:"via",x:41,y:25,diameter:.8,drill:.4,net:"V"}, // via in flex, no teardrop
    T("toVia2",[[38,27],[41,27]],"Top","W"),{id:"v2",kind:"via",x:41,y:27,diameter:.8,drill:.4,net:"W"},
    {id:"td",kind:"graphic",layer:"Top",net:"W",points:[[40.6,26.8],[39.5,26.9],[39.5,27.1],[40.6,27.2]],closed:true,fill:true,width:0,teardrop:true,teardropTrack:"toVia2",teardropAnchor:"v2",groupId:"teardrop:v2"},
    T("wide",[[38,29],[41,29]],"Top","X",.8),{id:"v3",kind:"via",x:41,y:29,diameter:.8,drill:.4,net:"X"}); // as wide as the land
  const out=R.drc(doc,new Map(),rules,{types:["flexRouting"]}),by=out.violations.map(v=>[v.id,v.severity||"error"]).sort();
  assert.deepEqual(by,[["stackTop","warning"],["stub","warning"],["toVia","error"]]);
  assert.match(out.violations.find(v=>v.id==="stackTop").detail,/I-beam/);
  // Turning the options off clears them.
  const off=JSON.parse(JSON.stringify(rules)),r=off.list.find(x=>x.type==="flexRouting");r.requireTeardrops=false;r.staggerLayers=false;r.bendTermination=false;
  assert.equal(R.drc(doc,new Map(),off,{types:["flexRouting"]}).total,0);
  // Tracks only in rigid regions are not flex routing.
  const rigid=board();RF.addBend(rigid,{a:[45,0],b:[45,30],angle:90,radius:2});
  rigid.items.push(T("r1",[[2,5],[25,5]],"Top","P"),T("r2",[[2,5],[25,5]],"Bottom","Q"));
  assert.equal(R.drc(rigid,new Map(),rules,{types:["flexRouting"]}).total,0);
}
// Construction faults.
{
  const doc=board();
  RF.addBend(doc,{a:[31,0],b:[31,30],angle:90,radius:2,name:"Near rigid"});        // zone reaches the rigid edge at 30
  RF.addBend(doc,{a:[59,0],b:[59,30],angle:45,radius:2,name:"Near stiffener"});    // stiffened region starts at 60
  RF.addBend(doc,{a:[45,5],b:[45,25],angle:90,radius:2,name:"Short"});             // ends inside the flex
  RF.addBend(doc,{a:[46,0],b:[46,30],angle:90,radius:2,name:"Overlap"});           // zone overlaps Short
  const out=R.drc(doc,new Map(),rules,{types:["flexBuild"]}),titles=out.violations.map(v=>v.title).sort();
  assert.ok(titles.includes("Bend Near rigid near "+RF.regions(doc).find(g=>RF.geometry.inside([10,15],g.points)).name),titles.join(" | "));
  assert.ok(titles.some(t=>/Near stiffener near stiffener/.test(t)),titles.join(" | "));
  assert.ok(titles.includes("Bend Short"),titles.join(" | "));
  assert.ok(titles.includes("Bends Short and Overlap"),titles.join(" | "));
  const tr=out.violations.find(v=>/Near rigid/.test(v.title));assert.equal(tr.required,1.5);assert.ok(tr.actual<1.5);
}
// Coverlay webs: two pads 0.15 mm apart after the 0.1 mm opening growth.
{
  const doc=board();
  const fp={id:"fp",name:"FPC",footprint:{shapes:[],pads:[{x:0,y:0,w:.6,h:1.5,number:"1",shape:"rect",layer:"Top"},{x:.95,y:0,w:.6,h:1.5,number:"2",shape:"rect",layer:"Top"},{x:3,y:0,w:.6,h:1.5,number:"3",shape:"rect",layer:"Top"}]}};
  doc.items.push({id:"J1",kind:"part",def:"fp",ref:"J1",value:"",x:45,y:15,angle:0,pinNets:{}});
  const out=R.drc(doc,new Map([["fp",fp]]),rules,{types:["flexBuild"]});
  assert.deepEqual(out.violations.map(v=>[v.id,v.severity]),[["J1","warning"]]);
  assert.match(out.violations[0].detail,/0\.150 mm of coverlay/);
}
console.log("flex-drc ok");
