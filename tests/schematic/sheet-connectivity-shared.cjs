"use strict";
const assert = require("node:assert/strict");
for (const name of ["model","parts","spatial","sch-objects","hierarchy","multichannel","rules","project-rules","component-match",
  "component-classes","eco","erc","insights","insights-sch","nav-common","crossprobe","undo-store"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
require("./sch-bench-project.js");
const A=Atrium, U=AtriumUndoStore, H=AtriumHierarchy, X=AtriumCrossProbe, E=AtriumERC, I=AtriumInsights;
let project=makeAtriumSchBenchProject({sheets:6,cells:3,channels:2}).project, revision=0, dragged=null, active=null;
const history=[], future=[], cache=new WeakMap(), time=new Date(0);
const definitions=p=>new Map(p.library.map(d=>[d.id,d]));
let defs=definitions(project);
const host={project:()=>project,doc:()=>active,defs:()=>defs,drag:()=>dragged,revision:()=>revision,
  registerAction(){},on(){},addRenderer(){}};
globalThis.AtriumNavHost=host; X.attach(host);
const ids=project.documents.filter(d=>d.kind==="schematic").map(d=>d.id);
const sheet=id=>project.documents.find(d=>d.id===id);
function edit(fn,hint) {const mark=U.mark(project); fn(); U.checkpoint(history,future,mark); U.record(project,hint); revision++; defs=definitions(project);}
function go(n) {assert.ok(U.jump(history,future,U.mark(project),n)); project=U.root(); U.record(project); revision++; defs=definitions(project);}
function content(h) {
  return {scope:h.effective, nets:h.nets.map(n=>[n.name,n.conflict,n.pins.map(p=>[p.ref,p.part.id,p.pin.number,p.pin.at])]),
    maps:[...h.byInstance].map(([id,v])=>[id,[...v.byPin],[...v.byWire]]), issues:h.issues.map(x=>[x.kind,x.text])};
}
function check(label) {
  const copy=A.clone(project), ds=definitions(copy), d=sheet(ids[2]), other=copy.documents.find(x=>x.id===d.id);
  for(const s of project.documents.filter(x=>x.kind==="schematic"))
    assert.deepEqual(X.schematicNets(s,defs),A.connectivity(copy.documents.find(x=>x.id===s.id),ds),label+" sheet "+s.id);
  assert.deepEqual(content(H.compileCached(project,{defs})),content(H.compile(copy,{defs:ds})),label+" hierarchy");
  assert.deepEqual(E.run(project,{cache,time}).messages,E.run(copy,{time}).messages,label+" ERC");
  const options={direction:"pcb",scope:d.id};
  function plan(p) {
    let next=0; const id=A.id; A.id=()=>"planned-"+(++next);
    try {return AtriumECO.plan(p,options);} finally {A.id=id;}
  }
  assert.deepEqual(plan(project),plan(copy),label+" ECO");
  const hints=(p,s,defs)=>I.analyze(p,s,defs,{checks:["singlePin","floatingInput","netTypo"]}).insights.map(i=>[i.key,i.message,i.at]);
  assert.deepEqual(hints(project,d,defs),hints(copy,other,ds),label+" Insights");
}
U.mark(project); U.prime();
const s=sheet(ids[2]), stable=sheet(ids[3]), part=s.items.find(x=>x.kind==="part"), label=s.items.find(x=>x.kind==="netlabel");
let e=A.sheetEntry(project,s,defs);
assert.ok(!e.local&&!e.erc&&!e.names&&!e.insights,"asking for an entry schedules and builds nothing");
const names=X.schematicNets(s,defs);
assert.equal(e.names,names); assert.equal(e.erc,undefined); assert.equal(e.local,undefined);
check("initial");
assert.equal(e.insights.conn,names,"Insights and cross-probe share the compact graph");
assert.equal(AtriumECO.cachedLocal(project,defs)(s,()=>assert.fail("duplicate hierarchy build")),e.local);
const stableEntry=A.sheetEntry(project,stable,defs), before=JSON.stringify(project);
let moved;
edit(()=>{moved=A.transformPart(s,part,defs.get(part.def),{x:part.x+2.54});}, {doc:s,get items(){return moved;}});
assert.ok(moved.some(i=>i.kind==="wire"),"the attached wires are reported");
assert.equal(A.sheetEntry(project,stable,defs),stableEntry);
check("transform");
edit(()=>{label.text="RENAMED_NET";},{doc:s,items:[label]}); check("rename");
edit(()=>{s.sourceName="Imported.SchDoc";},{doc:s,items:[]}); check("source net naming");
const sym=project.documents[0].items.find(i=>i.kind==="sheetsymbol");
edit(()=>{sym.sheet=stable.id; sym.entries[0].name="NEW_PORT";},{doc:project.documents[0],items:[sym]}); check("rewire hierarchy");
const beforeScope=A.sheetEntry(project,stable,defs);
edit(()=>{project.rules.list.find(x=>x.type==="ercNetScope").netScope="global";},[]); check("net scope");
assert.equal(A.sheetEntry(project,stable,defs),beforeScope,"a project net scope reuses local geometry");
edit(()=>{project.multichannel={naming:"custom",template:"{ref}_{n}"};},[]); check("instance naming");
const board=project.documents.find(d=>d.kind==="pcb");
edit(()=>{project.rules.list.push({id:"scoped",type:"ercSinglePinNets",enabled:true,priority:1,where:"schematic",severity:"off",
  scope:{kind:"componentclass",value:"selected"}});board.componentClasses={selected:[]};},[]);
edit(()=>{board.componentClasses.selected.push(part.ref);},{doc:board,items:[]});check("board class membership");
const cachedMessages=E.run(project,{cache,time:new Date(1000)}).messages;
assert.ok(cachedMessages.every(m=>m.time.getTime()===1000),"a new compilation dates every finding");
const def=defs.get(part.def), beforePin=A.sheetEntry(project,s,defs);
edit(()=>{def.symbol.pins[0].x+=2.54;def.symbol.pins[0].electrical=1;},[{library:true}]);
assert.notEqual(A.sheetEntry(project,s,defs),beforePin);
const published=cache.get(s), pass=E.steps(project,{cache,time});
let stage;
do {stage=pass.next();assert.ok(!stage.done);} while(stage.value!=="nets");
pass.return();
assert.equal(cache.get(s),published,"a cancelled ERC job cannot publish a partial generation");
check("library geometry and pin types");
const beforeUnused=A.sheetEntry(project,s,defs);
edit(()=>{project.library.push({id:"unused-def",name:"unused",symbol:{pins:[],shapes:[]}});},[]);
edit(()=>{project.library.at(-1).symbol.pins.push({x:0,y:1,number:"1"});},[{library:true}]);
assert.equal(A.sheetEntry(project,s,defs),beforeUnused,"unused definition edits keep this sheet");
const after=JSON.stringify(project), n=history.length;
go(-n); assert.equal(JSON.stringify(project),before);check("undo to origin");
go(n); assert.equal(JSON.stringify(project),after);check("redo all");
active=s; dragged={before:U.mark(project)}; part.x+=20;
assert.equal(A.sheetEntry(project,s,defs),null);check("live drag preview");
U.rollback(dragged.before,{doc:s,items:[part]}); dragged=null;
check("cancel drag");
const committedErc=cache.get(project), pin=defs.get(part.def).symbol.pins[0], electrical=pin.electrical, oldX=part.x;
U.duringEdit(()=>{
  part.x+=20;pin.electrical=electrical===2?1:2;
  assert.equal(A.sheetEntry(project,s,defs,host),null);check("mid-transaction");
  part.x=oldX;pin.electrical=electrical;
});
assert.equal(cache.get(project),committedErc,"a preview cannot publish findings to the committed ERC cache");
check("after preview");
const previous=project;
edit(()=>{project=A.clone(project);project.documents.find(d=>d.id===s.id).items.find(i=>i.id===label.id).text="REPLACED";});
check("replacement with reused ids");assert.equal(A.sheetEntry(project,previous.documents[0],defs),null);
go(-1);check("undo replacement");go(1);check("redo replacement");
const engine=I.engine(), current=sheet(ids[2]), checkOpts={prefs:false,checks:["singlePin","netTypo"],outer:U.outer(),sheetChanged:()=>false};
const first=U.recordedChanges(current), initial=engine.update(project,current,defs,{from:null,to:first.seq,ids:null},checkOpts);
while (!initial.next().done) {}
const old=engine.state(current.id), onSheet=current.items.find(i=>i.kind==="netlabel");
edit(()=>{onSheet.text="INTERRUPTED";},{doc:current,items:[onSheet]});
const delta=U.recordedChanges(current,first.seq), hint={...delta,from:first.seq,to:delta.seq};
const interrupted=engine.update(project,current,defs,hint,checkOpts);
let chunk;
do {chunk=interrupted.next();} while(!chunk.done&&chunk.value.phase!=="check");
assert.ok(!chunk.done);interrupted.return();
assert.equal(engine.state(current.id),old);assert.equal(old.at,first.seq);
const done=engine.update(project,current,defs,hint,checkOpts);while(!done.next().done) {}
const freshProject=A.clone(project);
const fresh=I.analyze(freshProject,freshProject.documents.find(d=>d.id===current.id),definitions(freshProject),checkOpts).insights;
assert.deepEqual(engine.list(current.id).map(i=>i.key),fresh.map(i=>i.key));
U.reset();delete globalThis.AtriumNavHost;
console.log("PASS all four consumers match fresh computations through scoped edits, library, hierarchy, previews, project replacement and history");
