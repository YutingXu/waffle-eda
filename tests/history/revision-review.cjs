"use strict";
const assert=require("node:assert/strict");
const {performance}=require("node:perf_hooks");
for(const m of ["model","parts","rules","altium-rules","blocks","revision-review"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const A=Atrium,R=AtriumRevisionReview;
const orig=AtriumParts.example(),p=A.clone(orig),[sch,pcb]=p.documents;
const [oldSch,oldBoard]=orig.documents;
const defs=new Map(orig.library.map(d=>[d.id,d]));
const block=AtriumBlocks.capture(oldBoard,defs,[-10,-10],[50,50],"Input stage");
block.id="fixed-block";p.layoutBlocks=[A.clone(block)];orig.layoutBlocks=[A.clone(block)];
// The project rule book (project.rules, app/checks/project-rules.js): the board's rules are the book's.
orig.rules=A.clone(AtriumProjectRules.book(orig));p.rules=A.clone(orig.rules);
const raw="RULEKIND=Width|NAME=Power width|UNIQUEID=MYRULEID|ENABLED=TRUE|SCOPE1EXPRESSION=InNet('VIN')|MINLIMIT=10mil";
oldBoard.sourceRules=[raw];pcb.sourceRules=[raw];
assert.equal(R.compare(orig,p).rows.length,0);
const saved=JSON.parse(JSON.stringify(orig,(_,v)=>typeof v==="number"?A.projectNumber(v):v));
assert.equal(R.compare(saved,orig).rows.length,0,"saving preserves the meaning of every coordinate");
assert.throws(()=>R.compare(orig,AtriumParts.example()),/share no document IDs/);
assert.throws(()=>R.compare({},p),/Invalid Waffle editor model/);
const part=pcb.items.find(i=>i.ref==="R1"),track=pcb.items.find(i=>i.kind==="track"),via=pcb.items.find(i=>i.kind==="via");
part.ref="R47";part.x+=2;part.y-=1;part.angle+=90;part.pinNets["1"]="POWER_NEW";
track.width=.46;track.points[0][0]+=2;part.value="27 kΩ";
const def=p.library.find(i=>i.id===part.def);def.footprint.pads[0].w+=.25;
const oldRef=pcb.items.find(i=>i.ref==="J1");pcb.items=pcb.items.filter(i=>i!==oldRef);
const added=A.instantiate(p,def,[1,1]);pcb.items.push(added);
const moving=sch.items.find(i=>i.kind==="graphic") || {id:"movable",kind:"label",x:1,y:2,text:"data"};
if(moving.id==="movable")oldSch.items.push(A.clone(moving));
sch.items=sch.items.filter(i=>i.id!==moving.id);pcb.items.push(moving);
via.layer="Multi";p.rules.list.find(r=>r.type==="width").min=.25;pcb.sourceRules=[raw.replace("10mil","12mil")];
p.layoutBlocks[0].name="Power filter";p.layoutBlocks[0].items.find(i=>i.kind==="track").width=.8;p.name="Variant A";
const snapshots=[orig,p].map(a=>JSON.stringify(a));const report=R.compare(orig,p);
const rows=report.rows, find=predicate=>{const r=rows.find(predicate);assert.ok(r);return r;};
const item=(id,status="Changed")=>find(r=>r.status===status && (r.next||r.previous).data.id===id), fields=r=>[...R.fields(report,r)];
const movement=fields(item(part.id));assert.equal(movement.filter(f=>f.label==="Position").length,1);assert.ok(movement.some(f=>f.label==="Pin 1 net"&&f.after==="POWER_NEW"));
assert.ok(movement.some(f=>f.label==="Rotation"&&f.after.endsWith("°")));assert.ok(!movement.some(f=>f.before===f.after));assert.equal(item(part.id).oldName,"R1");
assert.ok(fields(item(track.id)).some(f=>f.label.includes("Vertex 1")&&f.after.endsWith("mm")));assert.ok(fields(item(track.id)).some(f=>f.label==="Width"&&f.after==="0.46 mm"));
assert.ok(fields(item(def.id)).some(f=>f.label.includes("Pad 1")&&f.label.includes("Width")&&f.after.endsWith("mm")));
assert.equal(item(oldRef.id,"Removed").locate,null);assert.equal(item(added.id,"Added").locate,added.id);
assert.equal(item(moving.id).document,pcb.id);assert.ok(fields(item(moving.id)).some(f=>f.label==="Document"&&f.before===sch.name&&f.after===pcb.name));
assert.equal(rows.filter(r=>r.name==="Drawing order").length,0);
assert.ok(fields(find(r=>r.area==="Blocks")).some(f=>f.label.includes("Width")&&f.after==="0.8 mm"));
assert.ok(fields(find(r=>r.name==="Design rules")).some(f=>f.label.includes("Minimum")&&f.before==="0.15"&&f.after==="0.25"));
assert.ok(fields(find(r=>r.name==="Power width")).some(f=>f.before==="10mil"&&f.after==="12mil"));
assert.ok(R.findRows(report,"PCB","Changed","power_new").some(r=>r.name==="R47"));assert.ok(R.findRows(report,"PCB","Changed","R1").some(r=>r.name==="R47"));
assert.equal(R.findRows(report,"Rules","Removed","").length,0);assert.deepEqual([orig,p].map(a=>JSON.stringify(a)),snapshots);
const reordered=A.clone(orig);reordered.documents[1].items.reverse();reordered.library.reverse();reordered.documents.reverse();
assert.deepEqual(R.compare(orig,reordered).rows.map(r=>r.name).sort(),["Document order","Drawing order","Library order"].sort());
const rawOrder=A.clone(orig);rawOrder.documents[1].sourceRules=[raw.split("|").reverse().join("|")];
const source=R.compare(orig,rawOrder);assert.equal(source.rows.length,1);assert.equal([...R.fields(source,source.rows[0])][0].label,"Source record");
const ext=A.clone(orig);ext.documents[0].custom={enabled:false,zero:0,unset:null,empty:[],flags:{}};
const unknown=R.compare(orig,ext);assert.equal([...R.fields(unknown,unknown.rows[0])].length,5);
assert.equal(R.compare(orig,orig).rows.length,0);
const projectRow=rows.find(r=>r.area==="Project"&&r.name==="Variant A");
for(const side of [projectRow.previous,projectRow.next]){
  assert.ok(!Object.hasOwn(side.data,"documents"));assert.ok(!Object.hasOwn(side.data,"library"));
}
assert.equal(item(part.id).previous.geometry,defs.get(part.def).footprint);
assert.equal(item(part.id).next.geometry,def.footprint);
assert.equal(report.oldDefs.get(part.def),defs.get(part.def).name);
// Search also matches object IDs, and new objects get random UUIDs ("47" occurs in about one in nine),
// so the query carries a non-hexadecimal letter: only the renamed part's rows can match it.
assert.ok(R.findRows(report,"","Changed","r47",pcb.id).some(r=>r.name==="R47"));
assert.deepEqual(R.findRows(report,"","Changed","r47",sch.id),[]);
assert.deepEqual(R.findRows(report,"PCB","Changed","r47",pcb.id).map(r=>r.key),
  rows.filter(r=>r.name==="R47"&&r.document===pcb.id).map(r=>r.key));
// Mix deletions, insertions, a transfer and relative order changes. Number only
// shared positions in the owning document, retain just the displaced names.
const ordered=A.project("Ordered"),left=ordered.documents[1];left.name="Left";
const mk=n=>({kind:"label",id:"mark"+n,text:String(n),x:n,y:0});
left.items=[1,2,3,4,5,6,7,8].map(mk);const right=A.sheet("pcb","Right");ordered.documents.push(right);
const edited=A.clone(ordered),edoc=edited.documents[1];edoc.items=[1,12,5,4,2,6,8].map(mk);
edited.documents[2].items=[mk(3)];
const shifted=R.compare(ordered,edited);
const reversed=shifted.rows.find(r=>r.name==="Drawing order");
assert.deepEqual([...R.fields(shifted,reversed)],[
  {label:"Order · 2",before:"Text (mark2)",after:"Text (mark5)"},
  {label:"Order · 4",before:"Text (mark5)",after:"Text (mark2)"}
]);
assert.deepEqual(shifted.rows.filter(r=>r.status==="Removed").map(r=>r.previous.data.id),["mark7"]);
assert.deepEqual(shifted.rows.filter(r=>r.status==="Added").map(r=>r.locate),["mark12"]);
assert.deepEqual([...R.fields(shifted,shifted.rows.find(r=>r.locate==="mark3"))],[{label:"Document",before:"Left",after:"Right"}]);
const sourceIndex=orig.documents[1].items.findIndex(i=>i.kind==="part");
const changedItem={...orig.documents[1].items[sourceIndex],x:1234};
const changedItems=orig.documents[1].items.slice();changedItems[sourceIndex]=changedItem;
const shared={...orig,documents:orig.documents.map((d,i)=>i===1?{...d,items:changedItems}:d)};
assert.deepEqual(R.compare(orig,shared).rows.map(r=>r.locate),[changedItem.id]);
const duplicate={...shared,documents:[shared.documents[0],{...shared.documents[1],items:[...changedItems,changedItem]}]};
assert.throws(()=>R.compare(shared,duplicate),/Invalid Waffle editor model/);
console.log("PASS revision lineage, stable identity, cross-document moves, PCB geometry, pin nets, libraries, layout blocks, board and source rules, removed items, collection order, search and read-only comparison");
async function benchmarks(){
  if(!process.argv.includes("--benchmark"))return;
  require("../pcb/dense-board.js");const {d:doc}=makeAtriumBenchmarkBoard();
  const dense=A.project("Dense",AtriumParts.catalogue);dense.documents=[doc];const after=A.clone(dense);
  const track=after.documents[0].items.find(i=>i.kind==="track");track.width=.91;
  const t=performance.now(),list=R.compare(dense,after);assert.equal(list.rows.length,1);console.log(`${doc.items.length} objects compared in ${(performance.now()-t).toFixed(1)} ms.`);
  for(const item of after.documents[0].items)item.net=item.id===track.id?"SPECIAL_RAIL":"UPDATED_RAIL";
  async function timed(name,task){
    const start=performance.now();let last=start,gap=0,ticks=0;
    function sample(){const now=performance.now();gap=Math.max(gap,now-last);last=now;}
    const timer=setInterval(()=>{sample();ticks++;},1);
    try{
      const result=await task();sample();assert.ok(ticks>0,"foreground must run during "+name);
      console.log(name+": "+(last-start).toFixed(1)+" ms total, "+ticks+" foreground callbacks, "+gap.toFixed(1)+" ms maximum observed foreground gap");
      return result;
    }finally{clearInterval(timer);}
  }
  const all=await timed("25,600-object comparison",()=>R.compareAsync(dense,after));assert.equal(all.rows.length,doc.items.length);
  const found=await timed("25,600-row semantic field search",()=>R.findRowsAsync(all,"PCB","Changed","special_rail"));
  assert.deepEqual(found.map(r=>r.locate),[track.id]);assert.deepEqual(found,R.findRows(all,"PCB","Changed","special_rail"));
  let active=true;setTimeout(()=>{active=false;},0);
  assert.equal(await R.findRowsAsync(all,"","","absent-value",()=>active),null);
}

async function dialogCheck(){
  if(!process.argv.includes("--dom"))return;
  await require("./revision-ui.cjs").run();
}

async function gitFixture(){
  const arg=process.argv.indexOf("--fixtures");
  if(arg<0&&!process.argv.includes("--git"))return;
  const fs=require("node:fs"),path=require("node:path"),cp=require("node:child_process"),os=require("node:os");
  const {projectFromRecords}=require("../support/native-cad.cjs");
  globalThis.CFB=require("../../app/vendor/cfb.min.js");
  for(const name of ["source-file","board-shape","altium-ids","pcb-import","io","sexpr","zip","vendor/zipjs-deflate","format-2-models","import-sidecars","format-2-closure"])require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const source=arg>=0?path.join(process.argv[arg+1],"qfsae-0.PcbDoc"):path.join(__dirname,"../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.PcbDoc");
  const parsed=AtriumIO.read(path.basename(source),new Uint8Array(fs.readFileSync(source)));
  const before=A.project("Review board",parsed.library);before.documents=parsed.documents;const after=A.clone(before);
  const board=after.documents[0],track=board.items.find(i=>i.kind==="track"),part=board.items.find(i=>i.kind==="part");
  track.width+=.2;part.x+=1.5;part.pinNets["1"]="TEST_SUPPLY";after.rules=A.clone(AtriumProjectRules.book(after));
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"waffle-review-")),manifest="Review board.waffle";
  const git=(...args)=>cp.execFileSync("git",["-c","user.name=Waffle test","-c","user.email=review@example.invalid","-c","commit.gpgsign=false","-c","core.hooksPath="+os.devNull,...args],{cwd:tmp,maxBuffer:32*1024*1024});
  function writeProject(project){
    const stored=AtriumFormat2Model.fromEditor(project,{projectId:"review-fixture",manifestPath:manifest});
    const files=[...stored.files.map(r=>[r.path,AtriumFormat2.serialize(r.file)]),...[...stored.models,...stored.assets].map(r=>[r.path,r.bytes])];
    for(const [name,bytes] of files){
      const file=path.join(tmp,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);
    }
  }
  async function readProject(read){
    const root=AtriumFormat2Model.parse(read(manifest),{kind:"project"});
    await AtriumFormat2Closure.verify(root,read);
    return projectFromRecords(root,read,{nativeAssets:true});
  }
  try{
    git("init","-q");writeProject(before);git("add","--",".");git("commit","-qm","Import board");
    writeProject(after);
    const original=await readProject(name=>new Uint8Array(git("show","HEAD:"+name)));
    const current=await readProject(name=>new Uint8Array(fs.readFileSync(path.join(tmp,name))));
    const result=R.compare(original,current);assert.equal(result.rows.length,3);
    assert.deepEqual(result.rows.filter(r=>r.area==="PCB").map(r=>r.locate).sort(),[track.id,part.id].sort());
    assert.equal(R.findRows(result,"PCB","Changed","test_supply").length,1);assert.equal(R.findRows(result,"Rules","Added").length,1);
    console.log("PASS imported Altium board against its native Git HEAD: track width, component movement, assigned pad net and new project rules");
  }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}
async function main(){await gitFixture();await dialogCheck();await benchmarks();}
globalThis.__testDone=main().catch(error=>{console.error(error);process.exitCode=1;});
