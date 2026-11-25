"use strict";
// Independent horizontal-track measurements and pin fixtures exercise the normal batch,
// rule resolver, certificate, online and schematic check paths with native query scopes.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const mod of ["model","parts","board-shape","rooms","stackup","query-exchange","altium-rules","component-classes","pcb-draw",
  "nav-common","spatial","connectivity","net-intent","signals","rules","project-rules","drc","checks","drc-view","drc-certs",
  "sch-objects","hierarchy","net-ties","multichannel","messages","erc","undo-store","xsignals","pcb-import","io"]) require(require("../support/app-source-paths.cjs").appFile(mod+".js"));
require("../support/drc-geometry.cjs");
const R = AtriumRules, E = AtriumERC, U = AtriumUndoStore, rec = source => ({languageVersion:1,source}), defs = new Map();
const track = (id,net,y,width,layer="Top") => ({id,kind:"track",net,layer,width,points:[[0,y],[5,y]]});
const p = Atrium.project("Scope checks"), board = Atrium.sheet("pcb","Board");
board.items = [track("vdd","VDD",0,.16),track("sig","SIG",.35,.20),track("gnd","GND",.68,.18),
  track("other","OTHER",1.05,.24),track("bottom","SIG",.35,.20,"Bottom")];
p.documents=[board]; p.library=[];
const types = ["clearance","width"], templates = R.create().list;
const mk = (type,id,source,extra) => ({...templates.find(r=>r.type===type),id,name:id,scope:rec(source),...extra});
const widthClass = 'track in class "Power" and width < 0.24 mm';
const left = 'object in class "Power"', right = 'object where net.name = "SIG"';
const clearance = mk("clearance","power-sig",left,{scope2:rec(right),priority:1,gap:.26});
const nominal = mk("clearance","ordinary","object",{scope2:rec("object"),priority:2,gap:.11});
const thin = mk("width","power-width",widthClass,{min:.21,preferred:.24,max:null,priority:1});
const ordinaryWidth = mk("width","ordinary-width","object",{min:.10,preferred:.20,max:null,priority:2});
board.rules = {...R.create(),netClasses:{Power:["VDD","GND"]},list:[clearance,nominal,thin,ordinaryWidth]};

const live = AtriumDRCView.online(), quant = x => Math.round(x*1e9);
const value = (type,rule,ids,actual,required) => [type,rule,[...ids].sort().join("/"),quant(actual),quant(required)].join("|");
const resultKeys = result => result.violations.filter(v=>types.includes(v.type)).map(v=>value(v.type,v.ruleId,
  [v.id,v.otherId].filter(Boolean),v.actual,v.required)).sort();
function oracle({power=["VDD","GND"],scopedFirst=true,gap=.26}={}) {
  const want = [];
  for (const [i,a] of board.items.entries()) {
    if (power.includes(a.net) && a.width < .21-1e-5)
      want.push(value("width","power-width",[a.id],a.width,.21));
    for (const b of board.items.slice(i+1)) {
      if (a.layer!==b.layer || a.net===b.net) continue;
      const dist = Math.max(0,Math.abs(a.points[0][1]-b.points[0][1])-(a.width+b.width)/2);
      const scoped = scopedFirst && ((power.includes(a.net)&&b.net==="SIG")||(power.includes(b.net)&&a.net==="SIG"));
      const need = scoped ? gap : .11;
      if (dist+1e-5<need) want.push(value("clearance",scoped?"power-sig":"ordinary",[a.id,b.id],dist,need));
    }
  }
  return want.sort();
}
function assertBoard(expected,label) {
  const batch=R.drc(board,defs,board.rules,{project:p,types,limit:5000});
  assert.equal(batch.complete,true,label+" scope completion");
  assert.deepEqual(resultKeys(batch),expected,label+" full geometry");
  const result=live.update(board,defs,board.rules);
  assert.deepEqual(resultKeys(result),expected,label+" live geometry");
}
const history=[],future=[];
U.reset(); U.touch(p); U.sync(p);
function edit(action) {const from=U.mark(p);action();U.checkpoint(history,future,from);U.touch(p);U.sync(p);}
function undo() {assert.ok(U.jump(history,future,U.mark(p),-1));U.touch(p);U.sync(p);}
const drain = g => {for(;;){const r=g.next();if(r.done)return r.value;}};
assertBoard(oracle(),"class membership, both symmetric roles and priority");
assert.ok(drain(live.buildStore()),"real certificate store");
const win=R.resolver(board,{project:p,rules:board.rules});
assert.equal(win.clearanceBetween({kind:"track",net:"SIG"},{kind:"pad",net:"VDD"}),.26);
assert.equal(win.clearanceBetween({kind:"pad",net:"VDD"},{kind:"track",net:"SIG"}),.26);
edit(()=>{board.rules.list[0].gap=.31;});
assertBoard(oracle({gap:.31}),"rule edit relabels the physical pairs");
undo();
assertBoard(oracle(),"Undo threshold");
edit(()=>{const list=board.rules.list;list[0].priority=2;list[1].priority=1;[list[0],list[1]]=[list[1],list[0]];});
assertBoard(oracle({scopedFirst:false}),"priority reorder");
undo();
assertBoard(oracle(),"Undo priority");
edit(()=>{board.rules.netClasses.Power=["VDD"];});
assertBoard(oracle({power:["VDD"]}),"remove a net from its class");
undo();
edit(()=>{board.items[1].points=[[0,.46],[5,.46]];});
assertBoard(oracle(),"move a single segment");
undo();
assertBoard(oracle(),"Undo segment move");

const layerRule = mk("clearance","inner", 'pad on layer "Inner 2"', {scope2:rec(right),priority:1,gap:.41});
const inner=R.compiled(board,{rules:{...board.rules,list:[layerRule]},project:p,defs});
assert.equal(inner.pair("clearance",{kind:"track",net:"SIG",span:[2,2]},{kind:"pad",layer:"Multi",span:[0,127]})?.id,"inner");
assert.equal(inner.pair("clearance",{kind:"track",net:"SIG",span:[2,2]},{kind:"pad",layer:"Multi",span:[3,127]}),null);
edit(()=>{board.rules.list[0].scope2=rec("object where )");});
const invalid=R.drc(board,defs,board.rules,{project:p,types});
assert.equal(invalid.complete,false);
assert.ok(invalid.diagnostics.some(d=>d.ruleId==="power-sig"&&d.side==="scope2"&&d.span?.length===2));
assert.ok(invalid.violations.some(v=>v.scopeDiagnostic?.ruleId==="power-sig"));
assert.ok(live.update(board,defs,board.rules).violations.some(v=>v.scopeDiagnostic?.side==="scope2"));
undo();
assertBoard(oracle(),"Undo malformed scope");
const withCycle=R.drc(board,defs,{...board.rules,list:[{...thin,scope:rec("track where width < rule(MinWidth)")} ]},{types:["width"]});
assert.equal(withCycle.complete,false);
assert.match(withCycle.diagnostics[0].message,/cycle.*MinWidth/i);
console.log("ok - native PCB scopes, certificate relabel, layer span, edit, priority, Undo and incomplete checks");

const project=Atrium.project("Scope ERC"), sheet=Atrium.sheet("schematic","Power"), layout=Atrium.sheet("pcb","Layout");
const part=(id,ref,x,y) => ({kind:"part",id,ref,def:"pin",x,y,angle:0});
project.library=[{id:"pin",prefix:"J",name:"One output",symbol:{shapes:[],pins:[{number:"1",name:"OUT",x:0,y:0,electrical:2}]}}];
sheet.items=[part("a","J1",0,0),part("b","J2",20,0),part("c","J3",40,0),part("d","J4",60,0),
  {kind:"wire",id:"w",points:[[40,0],[60,0]]},{kind:"netlabel",id:"n",x:40,y:0,text:"SIG"}];
layout.items=[];layout.componentClasses={Probes:["J1","J2"]};

project.documents=[sheet,layout];
const er=(id,type,source,priority,extra)=>({id,type,name:id,enabled:true,priority,scope:rec(source),where:"schematic",...extra});
const fixture = [
  er("one","ercUnconnectedPins",'object where component.designator = "J2"',1,{severity:"fatal"}),
  er("group","ercUnconnectedPins",'object in component class "Probes"',2,{severity:"off"}),
  er("matrix","ercPinMatrix",'object in class "Outputs"',1,{matrix:{"2,2":"off"}})];
project.rules={format:"atrium-rules",version:3,units:"mm",keys:{netClasses:{Outputs:["SIG"]}},list:fixture};
const eh=[],ef=[],cache=new WeakMap();
U.reset();U.touch(project);U.sync(project);
function ee(change) {const m=U.mark(project);change();U.checkpoint(eh,ef,m);U.touch(project);U.sync(project);}
function eu() {assert.ok(U.jump(eh,ef,U.mark(project),-1));U.touch(project);U.sync(project);}
const select = r => r.messages.filter(m=>["unconnectedPins","matrix","ruleScope"].includes(m.check)).map(m=>[m.check,m.class,m.objectId??"",m.net??""].join("|")).sort();
function assertSheet(expected,label) {
  const full=E.run(project), cached=drain(E.steps(project,{cache}));
  assert.deepEqual(select(full),expected.slice().sort(),label+" direct pin/net oracle");
  assert.deepEqual(select(cached),select(full),label+" incremental findings and affected objects");
  return full;
}
assertSheet(["unconnectedPins|Fatal|b|"],"cross-board component/net classes and priority");
ee(()=>{project.rules.list[0].priority=2;project.rules.list[1].priority=1;project.rules.list.reverse();});
assertSheet([],"ERC reorder");
eu();
assertSheet(["unconnectedPins|Fatal|b|"],"ERC Undo priority");
ee(()=>{layout.componentClasses.Probes=["J2"];});
assertSheet(["unconnectedPins|Warning|a|","unconnectedPins|Fatal|b|"],"ERC class edit on another board");
eu();
ee(()=>{project.rules.list[0].scope=rec("object where unknown_field > )");});
const failed=assertSheet(["ruleScope|Error||"],"invalid ERC scope");
assert.equal(failed.passed,false);assert.equal(failed.complete,false);assert.equal(failed.diagnostics[0].ruleId,"one");
eu();
assertSheet(["unconnectedPins|Fatal|b|"],"ERC Undo malformed scope");
ee(()=>{project.rules.list[0].scope=rec("object where rule(MinWidth) > 0mm");});
const withoutBoardWidth=E.run(project);
assert.equal(withoutBoardWidth.complete,false,"a schematic pin has no effective PCB width constraint");
assert.ok(withoutBoardWidth.diagnostics.some(d=>d.ruleId==="one" && d.code==="measurement" && d.objectId));
eu();
console.log("ok - native ERC pin and net findings, class updates, priority, Undo and incomplete checks");

// These classes, endpoints and rules were written and read back by Altium Designer.
const filename="PairsXSignals.PcbDoc", bytes=fs.readFileSync(path.join(__dirname,"../fixtures/altium/pairs-xsignals",filename));
const imported=AtriumIO.read(filename,new Uint8Array(bytes)), pcb=imported.documents.find(d=>d.kind==="pcb");
const translated=pcb.sourceRules.map(line=>R.fromAltium(line,pcb)).filter(result=>result.rule);
const pairRule=translated.find(result=>result.rule.name==="HS_DiffPairs")?.rule;
const xsRule=translated.find(result=>result.rule.name==="PCIE_TX_MatchedLength")?.rule;
assert.equal(pairRule?.scope.languageVersion,1,"native first side from Designer");
assert.equal(xsRule?.scope.languageVersion,1,"native xSignal-class side from Designer");
const native=R.compiled(pcb,{rules:R.normalize({...R.create(),list:[pairRule,xsRule]}),defs:new Map(imported.library.map(d=>[d.id,d]))});
assert.deepEqual(native.diagnostics,[]);
const candidates=["GND","USB_DP","USB_DM","CLK","PCIE_TX_P","PCIE_TX_N"];
assert.deepEqual(candidates.filter(net=>native.first("diffPairsRouting",{net})),["USB_DP","USB_DM","PCIE_TX_P","PCIE_TX_N"]);
const xr=native.byType.matchedLengths[0];assert.ok(R.isXsScope(xr));
assert.deepEqual(AtriumXSignals.members(pcb,xr).map(x=>x.name).sort(),["PCIE_TX_N_XS","PCIE_TX_P_XS"]);
console.log("ok - real Altium paired copper and xSignal rule scopes select the original members");

const workingPair=mk("width","negative-working-pair",'object where polarity = "-"',{min:.18});
const workingBook={...board.rules,list:[workingPair],diffPairs:[{name:"Working pair",positive:"VDD",negative:"SIG"}]};
const negative=R.compiled(board,{project:p,rules:workingBook,defs});
assert.deepEqual(["SIG","VDD","GND",undefined].filter(net=>negative.first("width",{net})),["SIG"]);

const routed=R.netLengths;
require("../../app/pcb/length-tuning.js");
const lengthScope='net in class "Power" and length > 4 mm';
const lengthRule={id:"r-length",name:"Long routed power net",type:"length",priority:1,enabled:true,scope:rec(lengthScope),min:6,max:null};
const measured=R.drc(board,defs,{...board.rules,list:[lengthRule]},{project:p,types:["length"]});
assert.deepEqual(measured.diagnostics,[]);
const netGeometry=routed(board,defs);
assert.deepEqual(measured.violations.map(v=>[v.id,v.actual,v.required]).sort(),[["gnd",5,6],["vdd",5,6]]);
assert.equal(netGeometry.get("VDD").length,5);
console.log("ok - net class and length scopes use the routed measurement");

const spatialProject=Atrium.project("Anchor scope"), spatialBoard=Atrium.sheet("pcb","Anchor");
spatialProject.library=[];spatialProject.documents=[spatialBoard];
const anchor={kind:"part",id:"anchor",ref:"U3",x:1,y:0,angle:0};
spatialBoard.items=[track("near","SIG",0,.12),track("middle","PWR",4,.12),track("far","GND",9,.12),anchor];
const source="track near origin of U3 within 0.1 mm", start=source.indexOf("U3");
const bound={...rec(source),bindings:[{id:"selected-anchor",name:"U3",span:[start,start+2],target:{scope:"item",docId:spatialBoard.id,itemId:anchor.id}}]};
const sr={...thin,id:"scoped-place",name:"Scoped near origin",scope:bound};
spatialBoard.rules={...R.create(),list:[sr]};
U.reset();U.touch(spatialProject);U.sync(spatialProject);
const spatialLive=AtriumDRCView.online();
function spatialResults(expected,label,broken=false) {
  const full=R.drc(spatialBoard,defs,spatialBoard.rules,{project:spatialProject,types:["width"]});
  assert.equal(full.complete,!broken,label+" full scope completion");
  const running=spatialLive.update(spatialBoard,defs,spatialBoard.rules);
  for(const r of [full,running]) {
    if(broken)assert.ok(r.violations.some(v=>v.scopeDiagnostic?.ruleId==="scoped-place"),label);
    else assert.deepEqual(r.violations.filter(v=>v.type==="width").map(v=>v.id).sort(),expected,label);
  }
  return running.mode;
}
spatialResults(["near"],"physical width scope through normal entry");
spatialBoard.items[2].width=.13;
U.touch(spatialProject);U.sync(spatialProject);
assert.equal(spatialResults(["near"],"unrelated remote feature stays local"),"incremental");
anchor.y=4;anchor.ref="U7";U.touch(spatialProject);U.sync(spatialProject);
spatialResults(["middle"],"bound anchor moved and renamed");
const mark=U.mark(spatialProject), history2=[],future2=[];
spatialBoard.items[3]={...anchor,id:"foreign",ref:"U3"};
U.checkpoint(history2,future2,mark);U.touch(spatialProject);U.sync(spatialProject);
spatialResults([],"different ID reuses name",true);
assert.ok(U.jump(history2,future2,U.mark(spatialProject),-1));U.touch(spatialProject);U.sync(spatialProject);
spatialResults(["middle"],"Undo restores stable anchor");
console.log("ok - physical stable anchor, remote edit, movement, deletion, name reuse and Undo");

const later=R.drc(board,defs,{...board.rules,list:[{...thin,scope:{languageVersion:2,source:"object"}}]},{types:["width"]});
assert.equal(later.complete,false);assert.equal(later.diagnostics[0].code,"language-version");
const measurementBook = scope2 => ({...board.rules,list:[{...clearance,scope:rec("track where width < rule(MinWidth)"),scope2:rec(scope2)}]});
const necessary=R.drc(board,defs,measurementBook("object"),{types:["clearance"]});
assert.equal(necessary.complete,false);
assert.equal(necessary.diagnostics[0].code,"measurement");assert.ok(necessary.diagnostics[0].objectId);
const impossiblePair=R.drc(board,defs,measurementBook('object where net.name = "ABSENT"'),{types:["clearance"]});
assert.equal(impossiblePair.complete,true,"the false pair side decides the outcome without a width measurement");
assert.deepEqual(impossiblePair.violations,[]);
console.log("ok - unsupported language and an indispensable measurement identify the affected scope");

async function placedSubjectExpansion() {
  require(require("../support/app-source-paths.cjs").appFile("query.js"));
  const Qy = AtriumQuery, Ctx = AtriumDesignQueryContext;
  const track = (id, net, y) => ({id, kind:"track", net, layer:"Top", width:.2, points:[[0, y], [1, y]]});
  const hiddenLib = [{id:"sym", symbol:{pins:[
    {number:"1", name:"A", x:0, y:0},
    {number:"2", name:"HIDE", x:10, y:0, hidden:true}]}}];
  const hidden = {id:"h", kind:"schematic", items:[{id:"u", kind:"part", def:"sym", ref:"U1", x:0, y:0, angle:0}]};
  const hiddenProject = {id:"hp", documents:[hidden], library:hiddenLib};
  const hiddenDefs = new Map(hiddenLib.map(d => [d.id, d]));
  const pinOf = result => result.subs.map(row => row.pin);
  const syncPins = Qy.run(hiddenProject, hidden, "pin", {defs:hiddenDefs});
  const indexPins = await Qy.runIndexed(hiddenProject, hidden, "pin", {defs:hiddenDefs});
  assert.deepEqual(pinOf(syncPins), ["1"], "the hidden schematic pin stays out of the Filter");
  assert.deepEqual(pinOf(indexPins), pinOf(syncPins), "indexed pins agree with the Filter");
  const padDef = {id:"probe", footprint:{pads:[
    {number:"1", x:0, y:0, w:1, h:1, shape:"rect"},
    {number:"1", x:2, y:0, w:1, h:1, shape:"rect"}]}};
  const board = {id:"pads", kind:"pcb", items:[
    {id:"tp", kind:"part", def:"probe", ref:"TP1", x:0, y:0, angle:0, layer:"Top"},
    track("t", "SIG", 0)]};
  const padProject = {id:"pp", documents:[board], library:[padDef]};
  const padDefs = new Map([[padDef.id, padDef]]);
  const syncPads = Qy.run(padProject, board, "pad", {defs:padDefs});
  const indexPads = await Qy.runIndexed(padProject, board, "pad", {defs:padDefs});
  assert.deepEqual(syncPads.subs.map(row => row.id), ["tp/1", "tp/1/1"], "duplicate pad numbers stay in document order");
  assert.deepEqual(indexPads.subs.map(row => row.id), syncPads.subs.map(row => row.id));
  assert.equal(indexPads.visited, 2, "the pad index does not read the track");
  assert.equal(Qy.run(padProject, board, "pad", {defs:padDefs, subs:false}).count, 0);
  const tracks = await Qy.runIndexed(padProject, board, "track", {defs:padDefs});
  assert.deepEqual(tracks.ids, ["t"]);
  assert.equal(tracks.visited, 1, "track mode stays narrow");
  const nets = {id:"nets", kind:"pcb", items:[track("a", "VCC", 0), track("b", "VCC", 1), track("c", "vcc", 2)]};
  const netProject = {id:"np", documents:[nets], library:[]};
  const ctx = AtriumDesignQuery.context(netProject, nets);
  const seen = [], members = new Map();
  for (const item of nets.items) for (const name of Ctx.projectOwner(nets, item, ctx, {nets:true})) {
    if (!seen.includes(name)) seen.push(name);
    const owners = members.get(name) || [];
    owners.push(item.id);
    members.set(name, owners);
  }
  assert.deepEqual(seen, ["VCC", "vcc"], "case-distinct nets both remain");
  assert.deepEqual(members.get("VCC"), ["a", "b"], "the repeated name is recorded on each owner");
  assert.deepEqual(Qy.run(netProject, nets, "net").ids, ["net/VCC", "net/vcc"]);
  let seq = 1, changed = [];
  const store = {
    documentVersions:() => ({seq, outer:0, parameters:0, assembly:0}),
    recordedChanges:() => ({ids:new Set(changed.map(row => row.id)), items:new Map(changed.map(row => [row.id, row]))}),
    libraryVersion:() => 0
  };
  const opt = () => ({store, revision:seq});
  const ids = result => result.ids.slice().sort();
  const indexed = await Qy.runIndexed(netProject, nets, "net", opt());
  assert.deepEqual(ids(indexed), ["net/VCC", "net/vcc"]);
  nets.items[0].net = "ALT"; changed = [nets.items[0]]; seq++;
  const kept = await Qy.runIndexed(netProject, nets, "net", opt());
  assert.deepEqual(ids(kept), ["net/ALT", "net/VCC", "net/vcc"]);
  assert.equal(kept.visited, 2, "the journal delta revisits the changed net names");
  nets.items[1].net = "OTHER"; changed = [nets.items[1]]; seq++;
  const dropped = await Qy.runIndexed(netProject, nets, "net", opt());
  assert.deepEqual(ids(dropped), ["net/ALT", "net/OTHER", "net/vcc"]);
  assert.equal(dropped.visited, 1);
  console.log("ok - placed subjects agree for hidden pins, duplicate pads and case-distinct nets");
}
placedSubjectExpansion().catch(error => { console.error(error); process.exitCode = 1; });
