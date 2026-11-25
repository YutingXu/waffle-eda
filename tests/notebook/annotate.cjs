"use strict";
// Annotate Schematics: ordering, incremental/reset/duplicate handling, locks,
// sheet options, multi-unit packages and back-annotation to the linked board.
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/schematic/eco.js");require("../../app/notebook/annotate.js");
const A=Atrium,N=AtriumAnnotate,E=AtriumECO;
const parts=d=>d.items.filter(i=>i.kind==="part");
const byRef=(d,ref)=>parts(d).find(i=>i.ref===ref);
const seq=r=>r.rows.map(x=>x.current+">"+x.proposed).join(" ");

// Prefixes come from the existing designator, then the library default.
assert.equal(N.prefixOf("R12"),"R");assert.equal(N.prefixOf("TP?"),"TP");assert.equal(N.prefixOf("#PWR07"),"#PWR");
assert.equal(N.prefixOf("R4_B",null,"_B"),"R");assert.equal(N.prefixOf("",{prefix:"C"}),"C");assert.equal(N.prefixOf("?",null),"U");

// The sample is already annotated: an incremental update proposes nothing.
{
  const p=AtriumParts.example(),r=N.plan(p,{});
  assert.equal(r.rows.length,7);assert.equal(r.changes.length,0);assert.deepEqual(r.duplicates,[]);
  // Designator locations use model coordinates, where y grows down the screen.
  const loc=Object.fromEntries(r.rows.map(x=>[x.current,x.location]));
  assert.ok(loc.C1[1]>loc.U1[1],"C1's designator sits below U1's");
  // Reset All proposes "?" designators and leaves the model untouched.
  const before=JSON.stringify(p),reset=N.plan(p,{action:"reset-all"});
  assert.deepEqual(reset.rows.map(x=>x.proposed).sort(),["C?","C?","J?","J?","R?","R?","U?"]);
  assert.equal(JSON.stringify(p),before);
  // Reset, then re-annotate in each order (default 6 × 4 sheet zones).
  const expected={
    "up-across":"J1>J1 C1>C1 R1>R1 R2>R2 U1>U1 C2>C2 J2>J2",
    "down-across":"J1>J1 R1>R1 C1>C1 C2>C2 U1>U1 R2>R2 J2>J2",
    "across-up":"C1>C1 J1>J1 R1>R1 U1>U1 C2>C2 R2>R2 J2>J2",
    "across-down":"J1>J1 R1>R1 U1>U1 C2>C1 R2>R2 J2>J2 C1>C2"
  };
  for(const o of N.ORDERS){
    const reset=N.plan(p,{order:o.key,action:"reset-all"});
    const next=N.plan(p,{order:o.key,action:"update",proposed:reset.proposed});
    assert.equal(seq(next),expected[o.key],o.key);
    assert.equal(seq(N.plan(p,{order:o.key,action:"annotate"})),expected[o.key],o.key+" (one step)");
  }
}

// Order semantics on a 3 × 3 grid, one part per zone.
function grid(){
  const p=A.project("Grid",AtriumParts.catalogue),[s]=p.documents;
  for(const x of [20,60,100])for(const y of [20,60,100])
    s.items.push({id:"p"+x+"-"+y,kind:"part",def:"std-r",ref:"R?",value:"1k",x,y,angle:0,refAt:[0,0],link:"l"+x+"-"+y,pinNets:{}});
  return p;
}
{
  const p=grid(),name=r=>r.rows.map(x=>x.id.slice(1)+"="+x.proposed).join(" ");
  assert.equal(name(N.plan(p,{order:"up-across"})),"20-100=R1 20-60=R2 20-20=R3 60-100=R4 60-60=R5 60-20=R6 100-100=R7 100-60=R8 100-20=R9");
  assert.equal(name(N.plan(p,{order:"down-across"})),"20-20=R1 20-60=R2 20-100=R3 60-20=R4 60-60=R5 60-100=R6 100-20=R7 100-60=R8 100-100=R9");
  assert.equal(name(N.plan(p,{order:"across-up"})),"20-100=R1 60-100=R2 100-100=R3 20-60=R4 60-60=R5 100-60=R6 20-20=R7 60-20=R8 100-20=R9");
  assert.equal(name(N.plan(p,{order:"across-down"})),"20-20=R1 60-20=R2 100-20=R3 20-60=R4 60-60=R5 100-60=R6 20-100=R7 60-100=R8 100-100=R9");
  // Parts sharing a zone column are ordered by height only, not by x.
  const [s]=p.documents;s.items=s.items.filter(i=>i.id.startsWith("p20-"));
  s.items.push({id:"q35-80",kind:"part",def:"std-r",ref:"R?",value:"1k",x:35,y:80,angle:0,refAt:[0,0],pinNets:{}});
  assert.equal(name(N.plan(p,{order:"up-across"})),"20-100=R1 35-80=R2 20-60=R3 20-20=R4");
  // Finer regions separate the columns.
  assert.equal(name(N.plan(p,{order:"up-across",zonesX:24})),"20-100=R1 20-60=R2 20-20=R3 35-80=R4");
}

// Incremental update keeps numbered parts, fills gaps, and avoids every
// designator on every sheet, including locked parts and excluded sheets.
{
  const p=grid(),[s]=p.documents,other=A.sheet("schematic","Power");p.documents.push(other);
  s.items[0].ref="R2";s.items[1].ref="R5";s.items[1].designatorLocked=true;
  other.items.push({id:"o1",kind:"part",def:"std-r",ref:"R1",value:"1k",x:0,y:0,angle:0,pinNets:{}});
  other.items.push({id:"o2",kind:"part",def:"std-c",ref:"C?",value:"1n",x:30,y:0,angle:0,pinNets:{}});
  const r=N.plan(p,{order:"up-across",sheets:{[other.id]:{enabled:false}}});
  assert.equal(r.rows.length,9,"excluded sheets are not listed");
  const proposals=r.rows.map(x=>x.proposed);
  assert.equal(proposals[r.rows.findIndex(x=>x.id===s.items[0].id)],"R2");
  assert.equal(proposals[r.rows.findIndex(x=>x.id===s.items[1].id)],"R5");
  assert.ok(r.rows.find(x=>x.id===s.items[1].id).locked);
  assert.deepEqual(r.changes.map(x=>x.proposed),["R3","R4","R6","R7","R8","R9","R10"]);
  assert.ok(!proposals.includes("R1"),"R1 on the excluded sheet is reserved");
  // Reset All never touches locked parts.
  const reset=N.plan(p,{action:"reset-all",sheets:{[other.id]:{enabled:false}}});
  assert.equal(reset.rows.find(x=>x.id===s.items[1].id).proposed,"R5");
  // A per-sheet start index and suffix.
  const indexed=N.plan(p,{action:"annotate",sheets:{[s.id]:{startIndex:100,suffix:"_A"}},locks:{[s.items[1].id]:false}});
  assert.deepEqual(indexed.rows.filter(x=>x.sheet===s.id).map(x=>x.proposed),["R100_A","R101_A","R102_A","R103_A","R104_A","R105_A","R106_A","R107_A","R108_A"]);
  assert.deepEqual(indexed.rows.filter(x=>x.sheet===other.id).map(x=>x.proposed).sort(),["C1","R1"]);
  // Scope by selection.
  const only=N.plan(p,{action:"annotate",selected:["o2"],sheets:{[s.id]:{scope:"only-selected"},[other.id]:{scope:"only-selected"}}});
  assert.deepEqual(only.rows.map(x=>x.id),["o2"]);assert.equal(only.rows[0].proposed,"C1");
}

// Duplicates: the first part in processing order keeps its designator.
{
  const p=AtriumParts.example(),[s]=p.documents;
  byRef(s,"R2").ref="R1";byRef(s,"C2").ref="C1";
  const r=N.plan(p,{action:"none"});
  assert.deepEqual(r.duplicates,["C1","R1"]);
  assert.ok(r.issues.some(m=>m.includes("Duplicate designators")));
  const dup=N.plan(p,{order:"up-across",action:"reset-duplicates"});
  assert.equal(seq(dup),"J1>J1 C1>C1 R1>R1 R1>R? U1>U1 C1>C? J2>J2");
  assert.deepEqual(dup.duplicates,[]);
  const fixed=N.plan(p,{order:"up-across",action:"update",proposed:dup.proposed});
  assert.equal(seq(fixed),"J1>J1 C1>C1 R1>R1 R1>R2 U1>U1 C1>C2 J2>J2");
  // A locked duplicate wins over unlocked ones and is reported if it cannot.
  const locked=N.plan(p,{action:"reset-duplicates",locks:{["s-R2"]:true}});
  assert.equal(locked.rows.find(x=>x.id==="s-R1").proposed,"R?");
  const both=N.plan(p,{action:"reset-duplicates",locks:{"s-R2":true,"s-R1":true}});
  assert.ok(both.issues.some(m=>m.includes("cannot be reset")));
}

// Accepting renames the schematic and back-annotates linked board footprints in one mutation.
{
  const p=AtriumParts.example(),[s,b]=p.documents;
  const r=N.plan(p,{order:"across-down",action:"annotate"});
  assert.deepEqual(r.changes.map(x=>x.current+">"+x.proposed),["C2>C1","C1>C2"]);
  const back=N.backAnnotation(p,r.changes,b.id);
  assert.deepEqual(back.rows.map(x=>x.before+">"+x.after).sort(),["C1>C2","C2>C1"]);
  assert.deepEqual(back.issues,[]);
  for(const row of back.rows)assert.equal(row.link,b.items.find(i=>i.id===row.targetId).link);
  const job=N.prepare(p,r,{boards:"*",locks:{"s-U1":true}});
  const counts=job.execute();
  assert.deepEqual(counts,{schematic:2,board:2,locks:1});
  assert.equal(s.items.find(i=>i.id==="s-C2").ref,"C1");assert.equal(b.items.find(i=>i.id==="b-C2").ref,"C1");
  assert.equal(s.items.find(i=>i.id==="s-C1").ref,"C2");assert.equal(b.items.find(i=>i.id==="b-C1").ref,"C2");
  assert.equal(byRef(s,"U1").designatorLocked,true);
  for(const bp of parts(b))assert.equal(bp.ref,parts(s).find(sp=>sp.link===bp.link).ref);
  assert.equal(E.preview(p,"*",b.id).eco.rows.length,0,"the ECO comparison is clean afterwards");
  A.validate(JSON.parse(JSON.stringify(p)));
  // The accepted plan is now stale.
  assert.throws(()=>N.prepare(p,r,{}),/changed since/);
  // Unlocking removes the flag.
  N.apply(p,N.plan(p,{}),{locks:{"s-U1":false}});assert.ok(!("designatorLocked" in byRef(s,"U1")));
  // Without back-annotation the board is left alone and the ECO reports the difference.
  const again=N.plan(p,{order:"up-across",action:"annotate"});
  N.apply(p,again,{boards:null});
  assert.equal(byRef(s,"C1").id,"s-C1");assert.equal(b.items.find(i=>i.id==="b-C1").ref,"C2");
  assert.deepEqual(E.preview(p,"*",b.id).eco.rows.filter(x=>x.field==="ref").map(x=>x.before+">"+x.after).sort(),["C1>C2","C2>C1"]);
}

// Board renames that would collide are dropped with a note; "?" never reaches the board.
{
  const p=AtriumParts.example(),[s,b]=p.documents;
  b.items.find(i=>i.id==="b-C2").designatorLocked=true;
  const r=N.plan(p,{order:"across-down",action:"annotate"}),back=N.backAnnotation(p,r.changes,"*");
  assert.deepEqual(back.rows,[]);
  assert.ok(back.issues.some(m=>m.includes("is locked")));
  assert.ok(back.issues.some(m=>m.includes("would duplicate designator C2")));
  const reset=N.plan(p,{action:"reset-all"}),pendingBack=N.backAnnotation(p,reset.changes,"*");
  assert.deepEqual(pendingBack.rows,[]);assert.ok(pendingBack.issues.some(m=>m.includes("is annotated")));
  // Accepting "?" designators is allowed on the schematic, as in Altium.
  N.apply(p,reset,{boards:"*"});
  assert.ok(parts(s).every(i=>i.ref.endsWith("?")));assert.ok(parts(b).every(i=>!i.ref.includes("?")));
  // Re-annotating restores the pairing with the untouched board.
  const restored=N.plan(p,{order:"up-across",action:"update"});
  N.apply(p,restored,{boards:"*"});
  for(const bp of parts(b))assert.equal(bp.ref,parts(s).find(sp=>sp.link===bp.link).ref);
}

// Multi-unit packages (optional item.unit, def.unitCount).
{
  const p=A.project("Units",AtriumParts.catalogue),[s]=p.documents,def=p.library.find(d=>d.id==="std-opamp");def.unitCount=2;
  const add=(id,ref,unit,x)=>s.items.push({id,kind:"part",def:"std-opamp",ref,value:"",x,y:20,angle:0,refAt:[0,0],unit,pinNets:{}});
  add("a","U?",1,10);add("b","U?",2,20);add("c","U?",1,80);
  assert.deepEqual(N.plan(p,{order:"across-down"}).rows.map(x=>x.proposed),["U1","U1","U2"]);
  s.items.length=0;add("a","U1",1,10);add("b","U?",2,80);
  assert.equal(N.plan(p,{matching:"none"}).changes[0].proposed,"U2");
  assert.equal(N.plan(p,{matching:"sheet"}).changes[0].proposed,"U1");
  assert.deepEqual(N.plan(p,{action:"none"}).duplicates,[]);
  s.items.find(i=>i.id==="b").ref="U1";s.items.find(i=>i.id==="b").unit=1;
  assert.deepEqual(N.plan(p,{action:"none"}).duplicates,["U1"],"two copies of unit A are duplicates");
}
console.log("annotate tests passed");
