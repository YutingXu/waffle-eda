"use strict";
// Navigation and verification modules, headless: command palette search, cross-probe
// resolution, Nets panel summary, PCB List bulk edit, online DRC, shortcut contexts.
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/formats/import-link.js");require("../../app/checks/connectivity.js");
require("../../app/checks/rules.js");require("../../app/checks/drc.js");require("../../app/editor/keymap.js");require("../../app/pcb/length-tuning.js");
require("../../app/editor/keymap-editor.js");
require("../../app/editor/nav-common.js");require("../../app/editor/palette.js");require("../../app/editor/crossprobe.js");
require("../../app/checks/drc-view.js");require("../../app/editor/nets-panel.js");require("../../app/pcb/pcb-list.js");
require("../support/drc-geometry.cjs");
const A=Atrium,C=AtriumNavCommon,P=AtriumPalette,X=AtriumCrossProbe,N=AtriumNetsPanel,L=AtriumPCBList,D=AtriumDRCView;
const now=()=>globalThis.performance?.now?.()??Date.now();
const project=AtriumParts.example(),defs=new Map(project.library.map(d=>[d.id,d]));
const sch=project.documents.find(d=>d.kind==="schematic"),pcb=project.documents.find(d=>d.kind==="pcb");
const part=(d,ref)=>d.items.find(i=>i.kind==="part"&&i.ref===ref);

// ------------------------------------------------------------ fuzzy scoring and palette search
assert.ok(C.score("pl","pcb list")>0,"word starts match");
assert.equal(C.score("zz","pcb list"),-1);
assert.ok(C.score("drc","design rule check drc")>C.score("drc","dr c"),"contiguous beats scattered");
assert.ok(C.score("route","route track")>C.score("route","autoroute all"),"prefix beats infix");
assert.deepEqual(P.parse(">rules"),{mode:">",q:"rules"});assert.deepEqual(P.parse("@ U1"),{mode:"@",q:"U1"});
assert.deepEqual(P.parse(":10, 20"),{mode:":",q:"10, 20"});assert.deepEqual(P.parse("grid"),{mode:"",q:"grid"});
assert.deepEqual(P.parseLocation("10, 20"),[10,20]);assert.deepEqual(P.parseLocation(":100mil 50mil"),[2.54,1.27]);
assert.deepEqual(P.parseLocation("400 -250","mil"),[10.16,-6.35]);assert.equal(P.parseLocation("nope"),null);
const entries=[
  {key:"cmd:drc",kind:"command",label:"Design rule check…",detail:"Tools"},
  {key:"cmd:rules",kind:"command",label:"Design rules…",detail:"Design"},
  {key:"cmd:route",kind:"command",label:"Route track",detail:"Place"},
  {key:"cmd:nets",kind:"command",label:"Nets panel",detail:"Window"}];
assert.equal(P.search(entries,"design rule")[0].key,"cmd:drc");
assert.equal(P.search(entries,"tools")[0].key,"cmd:drc","detail text matches too");
assert.equal(P.search(entries,"",{recent:["cmd:nets"]})[0].key,"cmd:nets","recently used first");
assert.equal(P.search(entries,"design",{recent:["cmd:rules"]})[0].key,"cmd:rules","recent boosts ranking");
// Every keymap command is offered, extension commands included.
AtriumKeymap.registerCommand({id:"ext.hello",title:"Say hello",run(){}});
P.attach({doc:()=>pcb,registerAction(){},on(){}});
const cmds=P.entries(">");
assert.ok(cmds.some(e=>e.label==="Say hello"),"registered commands appear automatically");
assert.ok(cmds.some(e=>e.key==="cmd:drc"&&e.detail),"built-in commands carry a category");
// Objects: designators, nets and pads.
const objs=P.objectEntries(project,defs,pcb.id,"");
assert.ok(objs.some(e=>e.label==="U1"&&e.target.docId===pcb.id),"designators on the current board");
assert.ok(objs.some(e=>e.label==="VIN"&&e.target.type==="net"),"nets");
assert.equal(P.search(objs,"u1")[0].label,"U1");
const pads=P.objectEntries(project,defs,pcb.id,"U1-");
assert.ok(pads.some(e=>e.label==="U1-1"&&e.target.type==="pad"),"pads once a dash is typed");
// Benchmark: 2,000 entries per keystroke.
const big=[];for(let i=0;i<2000;i++)big.push({key:"k"+i,kind:"command",label:["Route","Place","Align","Toggle","Show"][i%5]+" item number "+i,detail:["View","Edit","Tools"][i%3]+" › sub "+i});
P.search(big,"x");
let t0=now();const queries=["r","ro","rou","rout","route","route i","route it","sh n 19"];for(let k=0;k<25;k++)for(const q of queries)P.search(big,q);
const perKey=(now()-t0)/(25*queries.length);
console.log("palette search: "+perKey.toFixed(3)+" ms per keystroke over 2000 entries");
assert.ok(perKey<2,"palette filters 2000 entries in under 2 ms ("+perKey.toFixed(3)+" ms)");

// ------------------------------------------------------------ cross-probe
const u1s=part(sch,"U1"),u1b=part(pcb,"U1");
let t=X.targetAt(sch,defs,u1s,null);
assert.equal(t.kind,"part");
let r=X.resolve(project,defs,sch.id,t);
assert.equal(r.docId,pcb.id);assert.deepEqual(r.ids,[u1b.id]);assert.ok(r.box&&r.box[2]>r.box[0]);
r=X.resolve(project,defs,pcb.id,X.targetAt(pcb,defs,u1b,null));assert.deepEqual(r.ids,[u1s.id],"board → schematic");
// Parts without a link match by designator.
const c2=part(pcb,"C2"),saved=c2.link;delete c2.link;
assert.deepEqual(X.resolve(project,defs,pcb.id,X.targetAt(pcb,defs,c2,null)).ids,[part(sch,"C2").id]);c2.link=saved;
// Pins: the pad under the pointer, with its net.
const pad1=A.pins(u1b,defs.get(u1b.def),"pcb")[0];
t=X.targetAt(pcb,defs,u1b,pad1.at);
assert.equal(t.kind,"pin");assert.equal(t.pin,String(pad1.number));
r=X.resolve(project,defs,pcb.id,t);assert.equal(r.docId,sch.id);assert.equal(r.label,"U1-"+pad1.number);
// Nets: board track → schematic wires of the same net.
const vin=pcb.items.find(i=>i.kind==="track"&&i.net==="VIN");
t=X.targetAt(pcb,defs,vin,null);assert.deepEqual(t,{kind:"net",net:"VIN",docId:pcb.id});
r=X.resolve(project,defs,pcb.id,t);
assert.equal(r.docId,sch.id);assert.equal(r.net,"VIN");assert.ok(r.ids.length>0);
const schNets=A.connectivity(sch,defs);
assert.ok(r.ids.every(id=>{const i=sch.items.find(x=>x.id===id);return schNets.byWire.get(id)==="VIN"||i.text==="VIN";}),"only VIN wires and labels");
const wire=sch.items.find(i=>i.kind==="wire"&&schNets.byWire.get(i.id)==="VIN");
r=X.resolve(project,defs,sch.id,X.targetAt(sch,defs,wire,null));
assert.ok(r.ids.includes(vin.id),"schematic wire → board tracks");
assert.equal(X.resolve(project,defs,pcb.id,{kind:"net",net:"NO_SUCH_NET"}),null);
// Cross Select Mode mirror.
assert.deepEqual(X.mirror(project,defs,sch.id,[u1s.id,part(sch,"R1").id],pcb.id).sort(),[u1b.id,part(pcb,"R1").id].sort());
assert.ok(X.mirror(project,defs,pcb.id,[vin.id],sch.id).includes(wire.id));

// ------------------------------------------------------------ Nets panel summary
const conn=AtriumConnectivity.inspect(pcb,defs);
let rows=N.summary(pcb,defs,{connections:conn,classes:{Power:["VIN","GND"],"All Nets":["VIN"]}});
const vinRow=rows.find(x=>x.name==="VIN");
assert.equal(vinRow.cls,"Power");assert.ok(vinRow.nodes>=2);assert.equal(typeof vinRow.unrouted,"number");
assert.equal(rows.reduce((n,x)=>n+x.unrouted,0),conn.airwires.length,"unrouted counts add up to the ratsnest");
const lengths=AtriumRules.netLengths(pcb,defs);
rows=N.summary(pcb,defs,{connections:conn,lengths});
assert.ok(Math.abs(rows.find(x=>x.name==="VIN").length-lengths.get("VIN").length)<1e-9,"routed length");
assert.deepEqual(rows.map(x=>x.name),[...rows.map(x=>x.name)].sort(new Intl.Collator("en",{numeric:true}).compare),"sorted naturally");
const schRows=N.summary(sch,defs);assert.ok(schRows.some(x=>x.name==="VIN"&&x.nodes>=2&&x.unrouted===null));
assert.deepEqual(N.classColours([{name:"A",cls:"P"},{name:"B",cls:"P"},{name:"C",cls:"S"},{name:"D",cls:""}],["#1","#2"]),{A:"#1",B:"#1",C:"#2"});

// ------------------------------------------------------------ PCB List
const board=JSON.parse(JSON.stringify(pcb));
let list=L.rows(board,defs,{kinds:["track"]});
assert.ok(list.length>0&&list.every(x=>x.kind==="track"&&x.cells.width>0));
const ids=list.map(x=>x.id);
let res=L.apply(board,defs,ids,"width","10mil",{unit:"mm"});
assert.equal(res.changed,ids.length);assert.ok(board.items.filter(i=>i.kind==="track").every(i=>i.width===.254));
res=L.apply(board,defs,ids,"width","0",{unit:"mm"});assert.equal(res.changed,0);assert.match(res.errors[0],/at least/);
res=L.apply(board,defs,[...ids,part(board,"U1").id],"net","GND");assert.equal(res.changed,ids.length);assert.equal(res.skipped,1,"parts have no net field");
const u1=part(board,"U1"),oldPad=A.pins(u1,defs.get(u1.def),"pcb")[0].at;
res=L.apply(board,defs,[u1.id],"rotation","90");assert.equal(u1.angle,90);
assert.notDeepEqual(A.pins(u1,defs.get(u1.def),"pcb")[0].at,oldPad,"pads follow the rotation");
res=L.apply(board,defs,[u1.id],"x","500mil");assert.equal(u1.x,12.7);
const via={id:"v1",kind:"via",x:0,y:0,diameter:.6,drill:.3,layer:"Multi",net:"GND"};board.items.push(via);
assert.equal(L.apply(board,defs,["v1"],"size","0.2mm").skipped,1,"diameter must exceed the drill");
assert.equal(L.apply(board,defs,["v1"],"size","0.8mm").changed,1);assert.equal(via.diameter,.8);
assert.equal(L.apply(board,defs,["v1"],"layer","Top",{layers:["Top","Bottom"]}).skipped,1,"via layer is fixed");
assert.ok(L.editable("width",{kind:"track"})&&!L.editable("width",{kind:"via"}));
assert.equal(L.apply(board,defs,[u1.id,part(board,"R1").id],"name","U9").skipped,2,"one designator cannot go on many parts");
{
  const pad = {id: "hole-pad", kind: "pad", x: 0, y: 0, w: 2, h: 1, drill: .9, shape: "rect", layer: "Top"};
  const doc = {kind: "pcb", items: [pad], outline: []};
  const rejected=L.apply(doc, new Map(), [pad.id], "size", "1mm", {unit:"mm"});
  assert.deepEqual([rejected.changed,rejected.skipped,pad.w,pad.h,pad.drill],[0,1,2,1,.9]);
  assert.equal(L.apply(doc,new Map(),[pad.id],"size","3mm").changed,1);
  assert.deepEqual([pad.w,pad.h,pad.drill],[3,1.5,.9]);
}

// The same List on a sheet (SCH List): schematic kinds, the same Designator / Comment / X / Y / Rotation edits.
const sheet=JSON.parse(JSON.stringify(sch));
const sl=L.rows(sheet,defs);
assert.ok(sl.length>0&&sl.every(r=>L.SCH_KINDS[r.kind]),"only schematic kinds");
assert.ok(sl.some(r=>r.kind==="part"&&r.cells.kind==="Component"&&r.cells.name),"components by designator");
assert.equal(L.FIELDS.find(f=>f.key==="value").label,"Comment","one name for the comment in both editors");
assert.deepEqual(L.FIELDS.filter(f=>f.pcb).map(f=>f.key),["layer","net","width","size","drill","length"],"board-only columns");
const sr1=part(sheet,"R1");
assert.equal(L.apply(sheet,defs,[sr1.id],"value","22k").changed,1);assert.equal(sr1.value,"22k");
assert.equal(L.apply(sheet,defs,[sr1.id],"x","100mil").changed,1);assert.equal(sr1.x,2.54);
const label=sheet.items.find(i=>i.kind==="netlabel");
if(label){assert.equal(L.apply(sheet,defs,[label.id],"name","NEWNET").changed,1);assert.equal(label.text,"NEWNET");}

// ------------------------------------------------------------ DRC → Messages, online DRC
const rules=AtriumRules.defaults();
const full=AtriumRules.drc(pcb,defs,rules);
const msgs=D.toMessages(full,{doc:pcb,unit:"mm"});
assert.equal(msgs.filter(m=>m.drc).length,full.violations.length);
assert.ok(msgs.some(m=>m.source==="Rule summary"),"rule summary rows");
{const passed=full.rules.filter(r=>!r.count).length,open=D.toMessages(full,{doc:pcb,unit:"mm",expanded:true});
  assert.equal(msgs.filter(m=>m.ruleSummary).length,passed?1:0,"passed rules collapse into one row");
  assert.equal(open.length-msgs.length,passed,"expanded lists every passed rule");}
assert.ok(msgs.filter(m=>m.drc).every(m=>m.objectId&&m.point),"each violation locates");
// Online: a clearance violation appears after an edit and disappears after undoing it.
const work=JSON.parse(JSON.stringify(pcb));
const eng=D.online({budget:30});
let o=eng.update(work,defs,rules);assert.equal(o.mode,"full");
const base=o.violations.length;
assert.equal(eng.update(work,defs,rules).mode,"none","no edit, no check");
const tr=work.items.find(i=>i.kind==="track"&&i.net==="VIN"),other=work.items.find(i=>i.kind==="track"&&i.net!=="VIN"&&i.net);
const before=JSON.stringify(tr.points);
tr.points=other.points.map(p=>[p[0]+.05,p[1]+.05]);          // lay VIN right over another net
o=eng.update(work,defs,rules);
assert.equal(o.mode,"incremental");assert.equal(o.dirty,1);
assert.ok(o.violations.length>base,"the edit is flagged");
assert.ok(o.violations.some(v=>v.id===tr.id||v.otherId===tr.id));
const fresh=AtriumRules.drc(work,defs,rules,{types:eng.types()});
const key=v=>v.ruleId+"|"+[v.id,v.otherId].sort().join("/");
assert.deepEqual([...new Set(o.violations.map(key))].sort(),[...new Set(fresh.violations.map(key))].sort(),"incremental result equals a full run");
console.log("online DRC: incremental "+o.ms.toFixed(2)+" ms ("+o.checked+" of "+work.items.length+" objects re-checked)");
assert.ok(o.ms<30,"within the 30 ms budget on the sample board");
tr.points=JSON.parse(before);
o=eng.update(work,defs,rules);assert.equal(o.violations.length,base,"undoing the edit clears it");
assert.notEqual(D.signature({kind:"track",points:[[0,0],[1,1]]}),D.signature({kind:"track",points:[[0,0],[1,2]]}));

// ------------------------------------------------------------ shortcut contexts in words (keymap patch)
const KM=AtriumKeymap;
if(KM.describeWhen){
  assert.equal(KM.describeWhen("pcb && routing"),"On boards, while routing");
  assert.equal(KM.describeWhen("!placing && selection"),"Not placing, something selected");
  assert.equal(KM.describeWhen("canvas && !placing && cursorAt && tool == select"),"Canvas focused, not placing, keyboard cursor shown, with the Select tool");
  assert.equal(KM.describeWhen("selection && !pcb"),"Not on boards, something selected");
  assert.equal(KM.describeWhen(""),"");
  assert.equal(KM.describeWhen("(a || b) && c"),"(a || b) && c");
  const pcbState={kind:"pcb",tool:"select",canvas:true},schState={kind:"schematic",tool:"select",canvas:true};
  assert.equal(KM.resolve("Mod+Shift+P",pcbState),"command-palette");assert.equal(KM.resolve("F1",schState),"command-palette");
  assert.equal(KM.resolve("Shift+F1",schState),"shortcuts");assert.equal(KM.resolve("J C",pcbState),"goto-object");
  assert.equal(KM.resolve("N",pcbState),"unrouted");assert.equal(KM.resolve("N",schState),null);assert.equal(KM.resolve("F5",pcbState),"net-colours");
  assert.equal(KM.resolve("Shift+F10",pcbState),"context-menu");
  console.log("keymap integration: palette, jump, unrouted, net colour and context-menu keys resolve");
}else console.log("keymap integration patch not applied: skipped the binding checks");

// The navigation consumers share net geometry during a committed editor revision.
{
  require("../../app/history/undo-store.js");
  const U=AtriumUndoStore, p=A.project("Net navigation",[{id:"driver",footprint:{pads:[
    {number:"1",x:0,y:0,w:1,h:1}, {number:"2",x:2,y:0,w:1,h:1,net:"Pad fallback"}
  ]}}]);
  const [sheet,board]=p.documents, second=A.sheet("pcb","Second board");
  const track={id:"trace-a",kind:"track",points:[[0,0],[1,0]],net:"A"};
  const part={id:"driver-1",kind:"part",def:"driver",ref:"U1",x:5,y:0,angle:0,pinNets:{1:"A",2:null}};
  board.items.push(track,
    {id:"trace-b",kind:"track",points:[[3,0],[4,0]],net:"B"},
    {id:"plane-a",kind:"polygon",points:[[0,0],[1,0],[1,1]],net:"A"},
    {id:"pad-a",kind:"pad",x:2,y:0,w:1,h:1,angle:0,net:"A"},
    part,{...part,id:"unwired-part",x:100,pinNets:undefined});
  sheet.items.push({id:"wire-b",kind:"wire",points:[[0,0],[2,0]],net:"B"},
    {id:"wire-a",kind:"wire",points:[[0,4],[2,4]],net:"A"},
    {id:"label-a",kind:"netlabel",text:"A",x:2,y:4});
  second.items.push({...track,id:"other-a",points:[[30,0],[31,0]]});
  p.documents.push(second);
  const definitions=new Map(p.library.map(def=>[def.id,def])), custom=new Map(definitions);
  const names=["B","A","Pad fallback","Missing"], h=[], f=[];
  let drag=null, live=p;
  X.attach({project:()=>live,doc:()=>board,defs:()=>definitions,revision:()=>1,drag:()=>drag,registerAction(){},on(){},addRenderer(){}});
  U.reset(p); U.mark(p);
  const scan=doc=>new Map(names.map(name=>[name,X.netObjects(doc,custom,name)]));
  const batch=doc=>X.netObjectsBatch(doc,definitions,names);
  const original=batch(board);
  assert.deepEqual(original,scan(board));
  assert.deepEqual(original.get("A"),{ids:["trace-a","plane-a","pad-a"],box:[0,-.5,5.5,1]});
  assert.deepEqual(original.get("Pad fallback"),{ids:[],box:[6.5,-.5,7.5,.5]});
  assert.deepEqual(original.get("Missing"),{ids:[],box:null});
  original.get("A").ids.push("consumer mutation");original.get("A").box[0]=100;
  assert.deepEqual(batch(board),scan(board));
  assert.deepEqual(batch(sheet),scan(sheet));
  assert.deepEqual(batch(second).get("A").ids,["other-a"]);
  assert.deepEqual(X.mirror(p,definitions,sheet.id,["wire-a","wire-b"],board.id),["trace-b","trace-a","plane-a","pad-a"]);

  const before=U.mark(p);
  track.net="B"; part.x=10;
  U.checkpoint(h,f,before); U.record(p,{doc:board,items:[track,part]});
  assert.deepEqual(batch(board),scan(board));
  assert.deepEqual(batch(board).get("B").ids,["trace-a","trace-b"]);
  assert.equal(batch(board).get("A").box[2],10.5);
  assert.ok(U.jump(h,f,U.mark(p),-1));
  assert.deepEqual(batch(board),scan(board));
  assert.equal(batch(board).get("A").box[2],5.5);
  assert.ok(U.jump(h,f,U.mark(p),1));
  assert.equal(batch(board).get("A").box[2],10.5);

  drag={before:true};part.x=20;
  assert.equal(batch(board).get("A").box[2],20.5);
  part.x=10;drag=null;
  assert.equal(batch(board).get("A").box[2],10.5);
  U.duringEdit(()=>{
    part.x=25;
    assert.equal(batch(board).get("A").box[2],25.5);
    part.x=10;
  });
  const libraryBefore=U.mark(p);
  p.library[0].footprint.pads[0].x=3;
  U.checkpoint(h,f,libraryBefore); U.record(p,{doc:board,library:true});
  assert.equal(batch(board).get("A").box[2],13.5);
  assert.ok(U.jump(h,f,U.mark(p),-1));
  assert.equal(batch(board).get("A").box[2],10.5);

  live=A.project("Replacement");
  const replacement={...second,id:board.id,items:[{...track,id:"replacement-a",net:"A",points:[[40,0],[41,0]]}]};
  live.documents=[replacement]; U.reset(live);
  assert.deepEqual(batch(replacement).get("A"),{ids:["replacement-a"],box:[40,0,41,0]});
}
console.log("PASS nav: palette, cross-probe, nets summary, PCB List, online DRC");
