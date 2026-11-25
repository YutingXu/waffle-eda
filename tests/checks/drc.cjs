"use strict";
// Design rule check engine (AtriumRules.drc) and the DRC report (AtriumDRC.report).
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/pcb/pcb-appearance.js");require("../../app/checks/connectivity.js");require("../../app/checks/rules.js");require("../../app/checks/drc.js");require("../../app/pcb/length-tuning.js");
const R=AtriumRules, scope=AtriumDesignQueryRecord.selector, defs=new Map();
const base=R.create();
const withRules=(f,set=base)=>{const c=JSON.parse(JSON.stringify(set));f(c);R.validate(c);return c;};
const rule=(type,name,props)=>({id:"t-"+name,type,name,comment:"",enabled:true,priority:1,scope:scope("all"),...(R.types[type].two?{scope2:scope("all")} : {}),...props});
const track=(id,net,points,width=.2,layer="Top")=>({kind:"track",id,net,points,width,layer});
const via=(id,net,x,y,diameter=.6,drill=.3)=>({kind:"via",id,net,x,y,diameter,drill,layer:"Multi"});
const pad=(id,net,x,y,w=1,h=1,shape="rect",layer="Top",drill=0)=>({kind:"pad",id,net,number:"1",x,y,w,h,shape,layer,drill});
const board=(items,extra={})=>({kind:"pcb",name:"Test",items,notes:[],...extra});
const run=(items,rules=base,options={},b={})=>R.drc(board(items,b),options.defs||defs,rules,options);
const of=(out,type)=>out.violations.filter(v=>v.type===type);
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-6,a+" differs from "+b);

// Width: minimum and the new maximum.
let rules=withRules(c=>{c.list.find(r=>r.type==="width").max=.5;});
let out=run([track("thin","A",[[0,0],[5,0]],.1),track("wide","B",[[0,5],[5,5]],.6),track("ok","C",[[0,9],[5,9]],.3)],rules);
assert.deepEqual(of(out,"width").map(v=>[v.id,v.limit,v.actual,v.required]),[["thin","min",.1,.15],["wide","max",.6,.5]]);
assert.ok(of(out,"width").every(v=>v.at&&v.ruleName==="Width"));

// Routing via style, hole size and annular ring.
rules=withRules(c=>{Object.assign(c.list.find(r=>r.type==="viaStyle"),{diameterMin:.5,diameterMax:1,holeMin:.25,holeMax:.5});
  Object.assign(c.list.find(r=>r.type==="annularRing"),{min:.15});Object.assign(c.list.find(r=>r.type==="holeSize"),{min:.2,max:3});});
out=run([via("v1","A",0,0,.45,.3),via("v2","B",5,0,1.2,.6),via("v3","C",10,0,.8,.4),pad("h","",20,0,3.5,3.5,"round","Multi",3.5),pad("th","D",30,0,1,1,"round","Multi",.8)],rules);
assert.deepEqual(of(out,"viaStyle").map(v=>[v.id,v.what,v.limit]).sort(),[["v1","Via diameter","min"],["v2","Via diameter","max"],["v2","Via hole","max"]]);
assert.deepEqual(of(out,"holeSize").map(v=>[v.id,v.actual]),[["h",3.5]]);
assert.deepEqual(of(out,"annularRing").map(v=>v.id).sort(),["th","v1"]);
close(of(out,"annularRing").find(v=>v.id==="th").actual,.1);

// Hole to hole clearance ignores nets; pairs are reported once.
out=run([via("a","A",0,0),via("b","A",.5,0),via("c","B",5,0)]);
assert.deepEqual(of(out,"holeToHole").map(v=>[v.id,v.otherId]),[["a","b"]]);
close(of(out,"holeToHole")[0].actual,.2);

// Routing layers.
rules=withRules(c=>{c.list.find(r=>r.type==="routingLayers").excluded=["Bottom"];});
assert.deepEqual(of(run([track("t1","A",[[0,0],[1,0]],.2,"Bottom"),track("t2","A",[[0,2],[1,2]])],rules),"routingLayers").map(v=>v.id),["t1"]);

// Clearance with oval pads (obround capsules) and octagons.
out=run([pad("o","A",0,0,2,1,"oval"),track("t","B",[[-1,.65],[1,.65]],.2)]);
close(of(out,"clearance")[0].actual,.05);
assert.equal(of(run([pad("o","A",0,0,2,1,"oval"),track("t","B",[[1.25,-2],[1.25,2]],.2)]),"clearance").length,1,"capsule end cap");
assert.equal(of(run([pad("o","A",0,0,2,1,"oval"),track("t","B",[[1.4,-2],[1.4,2]],.2)]),"clearance").length,0);

// Short-circuit and un-routed nets reuse the connectivity graph.
out=run([track("s1","A",[[0,0],[2,0]]),track("s2","B",[[1,-1],[1,1]]),pad("p1","C",10,0),pad("p2","C",14,0)]);
assert.equal(of(out,"short").length,1);assert.match(of(out,"short")[0].detail,/A, B/);
assert.deepEqual(of(out,"unrouted").map(v=>[v.actual,v.title.startsWith("Net C")]),[[4,true]]);
rules=withRules(c=>{c.list.find(r=>r.type==="short").allowed=true;});
assert.equal(of(run([track("s1","A",[[0,0],[2,0]]),track("s2","B",[[1,-1],[1,1]])],rules),"short").length,0,"Allow short circuit");
let calls=0;const conn={shorts:[],airwires:[]};
run([pad("p1","C",10,0)],base,{connections:()=>{calls++;return conn;}});assert.equal(calls,1,"connections callback");
assert.equal(calls,1);run([pad("p1","C",10,0)],base,{connections:()=>{calls++;return conn;},types:["clearance"]});assert.equal(calls,1,"lazy");

// Silk to solder mask and silk to silk.
const fp={id:"F",footprint:{pads:[{x:0,y:0,w:1,h:1,number:"1",shape:"rect"}],shapes:[
  {kind:"path",points:[[-1,.6],[1,.6]],width:.1,style:"silk"},{kind:"circle",x:3,y:0,r:.5,width:.1,style:"silk"},{kind:"text",x:0,y:2,text:"U1",style:"silk"}]}};
const lib=new Map([["F",fp]]),part=(id,x,y,layer)=>({kind:"part",id,ref:id,def:"F",x,y,angle:0,pinNets:{"1":"N"+id},...(layer?{layer}:{})});
out=run([part("U1",0,0)],base,{defs:lib});
const mask=of(out,"silkToMask");assert.equal(mask.length,1);
close(mask[0].actual,0);assert.equal(mask[0].required,.1);assert.ok(out.notes.some(n=>/overlay text/.test(n)));
out=run([part("U1",0,0,"Bottom"),{kind:"graphic",id:"g",layer:"Silk",points:[[-1,.6],[1,.6]],width:.1}],base,{defs:lib});
assert.deepEqual(of(out,"silkToMask").map(v=>v.id),["U1"],"bottom overlay meets the bottom pad; the top line has no top opening");
out=run([part("U1",0,0),part("U2",0,1.15)],base,{defs:lib});
assert.deepEqual(of(out,"silkToSilk").map(v=>[v.id,v.otherId].sort()),[["U1","U2"]]);
close(of(out,"silkToSilk")[0].actual,.05);
assert.equal(of(run([{kind:"graphic",id:"g1",layer:"Silk",points:[[0,0],[1,0]],width:.1},{kind:"graphic",id:"g2",layer:"Silk",points:[[1,0],[1,1]],width:.1}]),"silkToSilk").length,0,"free lines may touch");

// Differential pairs: width, gap and uncoupled length; layer rows override.
const pairRules=(f=()=>{})=>withRules(c=>{
  c.diffPairs=[{name:"USB",positive:"USB_P",negative:"USB_N"}];
  Object.assign(c.list.find(r=>r.type==="diffPairsRouting"),{widthMin:.15,widthMax:.25,gapMin:.15,gapMax:.3,maxUncoupled:2});
  c.list.find(r=>r.type==="clearance").gap=.1;f(c);
});
const P=(y,x1=10,width=.2,layer="Top")=>track("p"+y+layer,"USB_P",[[0,y],[x1,y]],width,layer);
const N=(y,x1=10,width=.2,layer="Top")=>track("n"+y+layer,"USB_N",[[0,y],[x1,y]],width,layer);
out=run([P(0),N(.4)],pairRules());assert.equal(of(out,"diffPairsRouting").length,0,"coupled pair at 0.2 mm gap");
out=run([P(0),N(.3)],pairRules());
assert.deepEqual(of(out,"diffPairsRouting").map(v=>[v.what,v.limit]),[["Pair gap","min"]]);close(of(out,"diffPairsRouting")[0].actual,.1);
out=run([P(0,10,.1),N(.4)],pairRules());assert.deepEqual(of(out,"diffPairsRouting").map(v=>[v.what,v.actual]),[["Pair width",.1]]);
out=run([P(0,14),N(.4,10)],pairRules());
assert.deepEqual(of(out,"diffPairsRouting").map(v=>[v.what,v.limit,Math.round(v.actual*10)/10]),[["Uncoupled length","max",3.7]],"the first 0.3 mm past the end of N is still within the max gap");
out=run([P(0,0+10,.2,"Bottom"),N(.4,10,.2,"Bottom")],pairRules(c=>{c.list.find(r=>r.type==="diffPairsRouting").layers={Bottom:{gapMin:.25,gapMax:.5}};}));
assert.deepEqual(of(out,"diffPairsRouting").map(v=>[v.what,v.required]),[["Pair gap",.25]],"Bottom layer row");

// Length and matched lengths, with via heights from the board thickness.
const hs=withRules(c=>{
  c.netClasses={Bus:["D0","D1","D2"]};c.diffPairs=[{name:"CLK",positive:"CLK_P",negative:"CLK_N"}];c.diffPairClasses={Clocks:["CLK"]};
  c.list.unshift(rule("length","BusLength",{scope:scope("netclass","Bus"),min:5,max:12}));
  c.list.unshift(rule("matchedLengths","BusMatch",{scope:scope("netclass","Bus"),tolerance:.5,withinPair:false,pairTolerance:.1}));
  c.list.unshift(rule("matchedLengths","ClockMatch",{scope:scope("diffpairclass","Clocks"),tolerance:5,withinPair:true,pairTolerance:.1}));
});
const items=[track("d0","D0",[[0,0],[10,0]]),track("d1","D1",[[0,1],[9.7,1]]),track("d2","D2",[[0,2],[4,2]]),
  track("cp","CLK_P",[[0,5],[3,5]]),track("cn","CLK_N",[[0,6],[3.3,6]])];
out=run(items,hs);
assert.deepEqual(of(out,"length").map(v=>[v.id,v.limit]),[["d2","min"]]);
const matched=of(out,"matchedLengths");
assert.deepEqual(matched.map(v=>[v.ruleName,v.id,v.what]),[["ClockMatch","cp","Intra-pair skew"],["BusMatch","d2","Length"]].sort((a,b)=>matched.findIndex(v=>v.id===a[1])-matched.findIndex(v=>v.id===b[1])));
assert.equal(matched.find(v=>v.id==="d2").target,10);close(matched.find(v=>v.what==="Intra-pair skew").actual,.3);
assert.ok(out.notes.some(n=>/thickness is unknown/.test(n)));
// One length engine (AtriumLength): a via barrel counts between the copper layers it connects (copper
// centre to copper centre); a via with copper on one side only is a stub and adds nothing.
const down=(id,net,x,y,len=.4)=>track(id,net,[[x,y],[x,y+len]],.2,"Bottom");
out=run([...items,via("vx","D2",4,2,.6,.3),down("b1","D2",4,2)],hs,{},{thickness:1.6});
assert.equal(of(out,"length").length,0,"a 1.6 mm via barrel and 0.4 mm on Bottom bring D2 to 6 mm");
let lengths=R.netLengths(board([...items,via("vx","D2",4,2),down("b1","D2",4,2)],{thickness:1.6}),defs);
close(lengths.get("D2").length,6);close(lengths.get("D2").viaLength,1.6);close(lengths.get("D2").trackLength,4.4);
lengths=R.netLengths(board([...items,via("vx","D2",4,2)],{thickness:1.6}),defs);
close(lengths.get("D2").length,4);close(lengths.get("D2").viaLength,0);assert.equal(lengths.get("D2").vias,1);
lengths=R.netLengths(board([...items,via("vx","D2",4,2),down("b1","D2",4,2)],{thickness:1.6}),defs,{viaHeights:false});
close(lengths.get("D2").length,4.4,"via_heights:false leaves the barrel out");
globalThis.AtriumStackup={thickness:()=>2};
close(R.netLengths(board([via("v","N",0,0),track("a","N",[[0,0],[1,0]]),down("b","N",0,0,1)],{thickness:1.6}),defs).get("N").length,4,"AtriumStackup.thickness wins over board.thickness");
delete globalThis.AtriumStackup;
const blind={...via("bv","N",0,0),fromLayer:"Top",toLayer:"Inner 1"};
close(R.netLengths(board([blind,track("t","N",[[0,0],[1,0]]),track("u","N",[[0,0],[0,1]],.2,"Inner 1"),track("i","X",[[0,0],[1,0]],.2,"Inner 2")],{thickness:1.5}),defs).get("N").viaLength,.5,"blind via spans one of three layer gaps");

// Disabled rules, type selection, per-rule limits and summaries.
rules=withRules(c=>{c.list.find(r=>r.type==="width").enabled=false;});
assert.equal(of(run([track("thin","A",[[0,0],[5,0]],.1)],rules),"width").length,0);
out=run(Array.from({length:30},(_,i)=>track("w"+i,"A",[[0,i],[1,i]],.1)),base,{limit:5,types:["width"]});
assert.equal(out.violations.length,5);assert.equal(out.total,30);assert.deepEqual(out.rules.map(r=>[r.type,r.count]),[["width",30]]);
assert.throws(()=>R.drc({kind:"schematic",items:[]},defs,base),/PCB/);

// Report export.
out=run([track("a","A",[[0,0],[3,0]]),track("b","B",[[0,.35],[3,.35]]),track("thin","C",[[0,5],[1,5]],.1)]);
const html=AtriumDRC.report(out,{board:"Main <board>",project:"P",unit:"mil",rules:base,date:new Date(0)});
assert.match(html,/^<!doctype html>/);assert.match(html,/Main &lt;board&gt;/);assert.match(html,/Rule violations: <b>2<\/b>/);
assert.match(html,/Clearance Constraint \(Minimum clearance=7\.874mil\) \(All\),\(All\)/);assert.match(html,/5\.906mil &lt; 7\.874mil/);
assert.equal(AtriumDRC.message(of(out,"width")[0],"mm"),"Width Constraint: (0.1mm < 0.15mm) Track (Top Layer) C");

// Performance: a dense 25k-object board stays well under a few seconds.
const dense=[];let seed=3;const rnd=()=>(seed=(seed*16807)%2147483647)/2147483647;
for(let i=0;i<25000;i++){
  const x=(i%250)*.8,y=Math.floor(i/250)*.8,net="N"+(i%400);
  if(i%5===0)dense.push(via("v"+i,net,x,y,.45,.2));
  else if(i%5===1)dense.push(pad("p"+i,net,x,y,.4,.3,"rect"));
  else dense.push(track("t"+i,net,[[x,y],[x+.5+rnd()*.2,y+(rnd()<.5?0:.3)]],.15,rnd()<.5?"Top":"Bottom"));
}
const started=Date.now();out=R.drc(board(dense),defs,base,{types:["clearance","width","viaStyle","holeSize","annularRing","holeToHole"]});
const ms=Date.now()-started;
assert.ok(ms<8000,"dense board took "+ms+" ms");assert.ok(out.total>0);
console.log("PASS DRC width, via style, holes, annular ring, routing layers, clearance shapes, shorts, un-routed nets, silk, differential pairs, lengths, matched lengths, limits and report ("+ms+" ms for 25k objects, "+out.stats.candidates+" candidate pairs)");
