"use strict";
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "multichannel", "rooms", "eco", "diff", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, E = AtriumECO, D = AtriumDiff, C = AtriumComponentMatch, U = AtriumUndoStore;
function part(id, ref, net, x, link = "") {
  return {kind:"part", id, ref, def:"std-r", value:"10k", link, x, y:10, angle:0, pinNets:{"1":net,"2":"GND"}};
}
function fixture() {
  const p = A.project("Component identity", AtriumParts.catalogue), [s,b] = p.documents;
  s.items = [part("symbol-5","R7","SENSE",10),part("symbol-7","R5","DRIVE",40)];
  b.items = [part("foot-5","R5","SENSE",101),part("foot-7","R7","DRIVE",104)];
  b.items.push({id:"track",kind:"track",layer:"Top",net:"SENSE",width:.2,points:[[101,10],[106,10]]});
  return {p,s,b};
}
const matching = (p, more = {}) => E.plan(p, {...more, reconcile:false});
const fields = (p, k) => p.changes.filter(c => c.action === k);
function recorded(project, fn) {
  U.reset();const history = [], future = [], before = E.serialize(project), mark = () => U.mark(project,{current:project.documents[0].id});
  const start = mark(); fn();U.checkpoint(history,future,start,"Execute changes");U.touch(project);
  const after = E.serialize(project);
  assert.ok(U.jump(history,future,mark(),-1));assert.equal(E.serialize(U.root()),before,"one undo restores the entire project");
  U.touch(project);assert.ok(U.jump(history,future,mark(),1));assert.equal(E.serialize(U.root()),after,"one redo restores the complete update");
  U.reset();
}

// R5 and R7 were re-annotated, and both component links disappeared. Schematic and PCB
// positions belong to different coordinate spaces. The same shared-ground pin is weak evidence.
{
  const {p,s,b} = fixture(), original=A.clone(p), plan=matching(p);
  assert.equal(plan.review.pending,0,JSON.stringify(plan.review.sources));
  assert.deepEqual(fields(plan,"ref").map(c=>[c.targetId,c.after]).sort(),[["foot-5","R7"],["foot-7","R5"]]);
  assert.ok(plan.matches.every(m=>m.confidence>.8 && m.reasons.includes("Same nets on 2 of 2 pins")));
  assert.equal(fields(plan,"footprint").length+fields(plan,"padNet").length,0);
  assert.deepEqual(E.preview(p,"*",b.id).eco.rows.map(r=>[r.targetId,r.after]).sort(),[["foot-5","R7"],["foot-7","R5"]]);
  recorded(p,()=>{
    assert.equal(E.execute(p,plan).failed,0);
    assert.deepEqual(b.items.slice(0,2).map(i=>[i.id,i.ref,i.x,i.def,i.pinNets["1"]]),[["foot-5","R7",101,"std-r","SENSE"],["foot-7","R5",104,"std-r","DRIVE"]]);
    assert.deepEqual(b.items[2],original.documents[1].items[2]);
  });
  const base=A.clone(original);base.documents[0].items.forEach((i,k)=>{i.id="old-"+k;i.ref=k?"R7":"R5";});
  const r=D.compare(base,original);
  assert.deepEqual(r.matching.items.get("old-0").id,s.items[0].id);
  assert.equal(r.matching.items.get("old-1").review,false);
  assert.ok(r.components.find(m=>m.before==="old-0").reasons.includes("Same nets on 2 of 2 pins"));
}

// Copies share a pasted link and value. Even when the optimal suggestion looks obvious,
// Validate and Execute (including a caller-provided selection) must wait for a human decision.
{
  const {p,s,b}=fixture();for(const i of [...s.items,...b.items.filter(i=>i.kind==="part")]){i.link="pasted";i.pinNets={"1":"GND","2":"GND"};}
  s.items[0].value="47k";
  const newer=A.clone(p);newer.documents[0].items.forEach(i=>i.id+="-copy");newer.documents[0].items[0].value="1M";
  const comparison=D.compare(p,newer);
  assert.equal(comparison.stats.components.review,2);
  assert.match(D.toMarkdown(comparison),/proposed match by/);assert.match(D.toHTML(comparison),/proposed match by/);
  assert.equal(D.toJSON(comparison).components.filter(m=>m.review).length,2);
  assert.ok(comparison.components.filter(m=>m.review).every(m=>m.alternatives.length===2));
  assert.ok(comparison.changes.some(c=>c.kind==="part.value" && c.text.startsWith("Possible change")));
  assert.equal(D.remap(p,newer).documents[0].items[0].id,s.items[0].id,"a suggested pair must not rewrite source identity");
  let q=matching(p);assert.equal(q.review.sources.length,2);assert.equal(q.review.pending,2);
  assert.equal(E.validate(p,q).valid,false);
  const before=E.serialize(p);assert.throws(()=>E.execute(p,q,new Set(q.changes.map(c=>c.id))),/Review component matches/);
  assert.throws(()=>E.apply(p,E.preview(p,"*",b.id).eco),/Review component matches/);
  assert.equal(E.serialize(p),before);
  const first=q.review.sources.find(r=>r.ref==="R7"),other=first.candidates.find(id=>id!==first.proposed);
  assert.ok(other,"another actual footprint can be selected");
  const next=(source,target,action)=>{q=matching(p,{matchDecisions:E.decide(q,source,target,action)});};
  next(first.source,other);assert.ok(q.review.pending);
  const second=q.review.sources.find(r=>r.ref==="R5");assert.throws(()=>E.decide(q,second.source,other),/already paired/);
  next(second.source,null);assert.equal(q.review.pending,1,"freed footprint needs a decision even with Remove extras off");
  const freed=q.review.targets.find(t=>!t.assigned);next(null,freed.target,"remove");assert.equal(q.review.pending,0);
  const parsed=E.reopen(p,JSON.parse(E.serialize(q))).plan;assert.equal(parsed.review.pending,0);
  const stale=A.clone(p);stale.documents[1].items.find(i=>i.id===other).value="changed";
  assert.throws(()=>E.execute(stale,parsed),/Review component matches|identities changed/);
  recorded(p,()=>{assert.equal(E.execute(p,q).failed,0);const parts=b.items.filter(i=>i.kind==="part");
    assert.equal(parts.length,2);assert.equal(parts.find(i=>i.id===other).value,"47k");assert.ok(!parts.some(i=>i.id===freed.target));
    assert.equal(new Set(parts.map(i=>i.link)).size,2);});
}

// Distinguish a value edit, a genuine package swap on a known part, and an unrelated new
// component reusing a designator. The latter may intentionally replace the existing footprint.
{
  const {p,s,b}=fixture();s.items=s.items.slice(0,1);b.items=b.items.slice(0,1);
  s.items[0].ref=b.items[0].ref;s.items[0].value="4k7";
  let q=matching(p);assert.equal(q.review.pending,0);assert.equal(fields(q,"value").length,1);
  assert.equal(E.execute(p,q).failed,0);
  const big=A.clone(p.library.find(d=>d.id==="std-r"));big.id="r-big";big.name="Resistor, large";big.footprint.name="R_1206";p.library.push(big);
  s.items[0].def=big.id;q=matching(p);assert.equal(q.review.pending,0);assert.equal(fields(q,"footprint").length,1);
  assert.equal(E.execute(p,q).failed,0);assert.equal(b.items[0].id,"foot-5");assert.equal(b.items[0].x,101);assert.equal(b.items[0].def,big.id);
  const replacement={...s.items[0],id:"different-symbol",link:"different-link",def:"std-j2",value:"Header",pinNets:{"1":"TX","2":"RX"}};
  s.items=[replacement];q=matching(p);assert.equal(q.review.pending,1,"a reused designator alone must not replace a package");
  const picks=E.decide(q,q.review.sources[0].source,null);
  q=matching(p,{matchDecisions:picks});q=matching(p,{matchDecisions:E.decide(q,null,b.items[0].id,"remove")});
  assert.equal(E.execute(p,q).failed,0);assert.equal(b.items.length,1);assert.notEqual(b.items[0].id,"foot-5");assert.equal(b.items[0].def,"std-j2");
}

// Known links witness a rename in one sheet's net namespace. The same text on a second sheet
// has a different rename. Only the selected sheet's pads and copper are changed, including undo.
{
  const {p,s,b}=fixture(),other=A.sheet("schematic","Other");
  p.documents.push(other);s.items=[part("anchor-a","J1","NEW_A",10,"A"),part("unknown-a","R19","NEW_A",45)];
  other.items=[part("anchor-b","J2","NEW_B",10,"B"),part("unknown-b","R20","NEW_B",45)];
  b.items=[part("board-a","J1","OLD_A",1,"A"),part("board-b","J2","OLD_B",2,"B"),part("board-r1","R1","OLD_A",3),part("board-r2","R2","OLD_B",4)];
  b.rooms=[{id:"ra",name:s.name,sheet:s.id,members:["board-a","board-r1"],points:[[0,0],[5,0],[5,5]]},{id:"rb",name:other.name,sheet:other.id,members:["board-b","board-r2"],points:[[10,0],[15,0],[15,5]]}];
  b.items.push({id:"a-trace",kind:"track",layer:"Top",width:.2,net:"OLD_A",points:[[1,10],[3,10]]},
    {id:"b-trace",kind:"track",layer:"Top",width:.2,net:"OLD_B",points:[[2,10],[4,10]]});
  const q=matching(p,{scope:s.id}),match=q.matches.find(m=>m.target==="board-r1");
  assert.ok(match.reasons.some(t=>t.includes("after net rename")));assert.equal(q.review.pending,0);
  assert.deepEqual(fields(q,"renameNet").map(c=>[c.before,c.after]),[["OLD_A","NEW_A"]]);
  recorded(p,()=>{assert.equal(E.execute(p,q).failed,0);assert.equal(b.items.find(i=>i.id==="b-trace").net,"OLD_B");
    assert.equal(b.items.find(i=>i.id==="a-trace").net,"NEW_A");assert.equal(b.items.find(i=>i.id==="board-r2").ref,"R2");});
  // Same local label can mean two different nets when comparing two independent sheets.
  const a=A.clone(p),z=A.clone(p);a.documents=a.documents.filter(d=>d.kind==="schematic");z.documents=z.documents.filter(d=>d.kind==="schematic");
  for(const d of a.documents)for(const i of d.items)i.pinNets["1"]="LOCAL";
  for(const d of z.documents){d.items[1].id+="-fresh";d.items[1].ref+="9";d.items[1].link="fresh-"+d.id;}
  const r=D.match(a,z,{schematicNets:"pinNets"});
  for(const d of a.documents)assert.ok(r.items.get(d.items[1].id).reasons.some(t=>t.includes("after net rename")));
}

// Reimporting same-named sibling sheet symbols needs their distinct instance sites. When both
// instances collapse to the same site with fresh IDs, component lineage becomes ambiguous.
{
  const {p,s,b}=fixture(), top=A.sheet("schematic","Repeated assemblies");
  p.documents=[top,s,b]; b.items=[];
  top.items=[10,40].map((x,i)=>({...AtriumSchObjects.make("sheetsymbol",[x,0],{name:"Assembly",sheet:s.id}),id:"site"+i}));
  s.items=[part("device","R1","LOCAL",10,"old-link")];
  const fresh=A.clone(p);
  fresh.documents[0].items.forEach((i,n)=>i.id="fresh-site"+n);
  fresh.documents[1].items[0].id="fresh-device";fresh.documents[1].items[0].link="fresh-link";
  assert.equal(D.match(p,fresh).components.find(c=>c.before==="device").review,false);
  fresh.documents[0].items[1].x=fresh.documents[0].items[0].x;
  const changed=D.match(p,fresh).components.find(c=>c.before==="device");
  assert.ok(changed.review && changed.reasons.some(t=>t.includes("sheet instances")));
}
// A rename observed only through competing proposed pairs is a conditional interpretation
// of the two sets of pins. It must not become an unqualified electrical statement.
{
  const {p,s,b}=fixture();b.items=[];
  s.items.forEach(i=>{i.link="shared";i.pinNets={1:"SOURCE_NODE",2:"GROUND"};});
  const fresh=A.clone(p);
  fresh.documents[0].items.forEach(i=>{i.id+="-fresh";i.pinNets[1]="DESTINATION_NODE";});
  const r=D.compare(p,fresh,{schematicNets:"pinNets"});
  const rename=r.changes.find(c=>c.kind==="net.renamed");
  assert.ok(rename?.match?.review && rename.text.startsWith("Possible change"));
}

// Two otherwise identical channels retain their full hierarchy paths after a naming scheme
// change and the loss of the base links. Deliberately cross the printed channel refs.
{
  const {p,s,b}=fixture(),top=A.sheet("schematic","Top");p.documents.unshift(top);
  top.items.push(AtriumSchObjects.make("sheetsymbol",[40,0],{name:"Repeat(CH,1,2)",sheet:s.id}));
  s.items=[part("symbol","R1","SENSE",10,"base")];
  const ch=AtriumMultichannel.channels(p);b.items=ch.map((r,i)=>({...part("fp"+i,"R1_CH"+(2-i),"SENSE",50+i),channel:r.id}));
  const q=matching(p);assert.equal(q.review.pending,0);assert.deepEqual(fields(q,"ref").map(c=>[c.targetId,c.after]).sort(),[["fp0","R1_CH1"],["fp1","R1_CH2"]]);
  E.execute(p,q);assert.equal(new Set(b.items.map(i=>i.link)).size,2);assert.ok(b.items.every((i,k)=>i.link.endsWith("@"+ch[k].id)));
  b.items.forEach((i,k)=>{i.ref="R8_CH"+(k+1);});
  const back=matching(p,{direction:"sch"});assert.deepEqual(fields(back,"ref").map(c=>[c.before,c.after]),[["R1","R8"]]);
  assert.equal(E.execute(p,back).failed,0);assert.equal(s.items[0].ref,"R8");
  s.items[0].link="";b.items=[];
  assert.equal(E.execute(p,matching(p)).failed,0);
  assert.ok(b.items.every((i,k)=>i.link===s.items[0].link+"@"+ch[k].id),"all repeated copies inherit the same new base link");
}

// Optimal total weight: the locally best A-X would leave B without an alternative. The
// Hungarian assignment instead selects A-Y + B-X; both uncertain pairs remain reviewable.
{
  const d={id:"r",name:"Resistor",footprint:{name:"0603"}};
  const rec=(key,ref,nets)=>C.describe({...part(key,ref,"",0),pinNets:nets},d);
  const l=[rec("a","R1",{1:"A",2:"B"}),rec("b","R2",{1:"A",2:"C"})];
  const r=[rec("x","R9",{1:"A",2:"B"}),rec("y","R1",{1:"Z",2:"B"})];
  const pairs=C.finish(C.steps(l,r)).pairs;assert.equal(pairs.get("a").target,"y");assert.equal(pairs.get("b").target,"x");
  const many=Array.from({length:160},(_,i)=>rec("s"+i,"R?",{1:"GND"}));
  const iter=C.steps(many,many.map(x=>({...x,key:"t"+x.key,ids:[]})));assert.equal(iter.next().done,false);
  globalThis.__testDone=C.inSlices(iter,()=>false).then(r=>assert.equal(r,null));
}
// Large boards: thousands of interchangeable parts on shared nets keep a bounded candidate list
// per part and are assigned in chunks, so memory and time stay far from cubic. Re-annotated
// parts with distinct nets still pair exactly; parts only a designator could tell apart go to review.
{
  const d={id:"c",name:"Capacitor",footprint:{name:"0402"}}, n=2000;
  const rec=(key,ref,nets)=>C.describe({...part(key,ref,"",0),value:"100n",pinNets:nets},d);
  const t0=Date.now();
  const same=C.finish(C.steps(Array.from({length:n},(_,i)=>rec("a"+i,"C?",{1:"GND",2:"VDD"})),Array.from({length:n},(_,i)=>rec("b"+i,"C?",{1:"GND",2:"VDD"}))));
  assert.ok(same.pairs.size>=n-8 && [...same.pairs.values()].every(m=>m.review),"indistinct copies pair for review");
  assert.ok([...same.choices.values()].every(c=>c.length<=8),"review choices stay short");
  assert.ok(same.work.scored <= n*32 && same.work.largestPool <= 32,"a shared rail cannot cause a full Cartesian search");
  const left=Array.from({length:n},(_,i)=>rec("a"+i,"C"+i,{1:"N"+i,2:"GND"})), right=Array.from({length:n},(_,i)=>rec("b"+i,"C"+((i*7919)%n),{1:"N"+i,2:"GND"}));
  const moved=C.finish(C.steps(left,right));
  assert.ok([...moved.pairs].every(([a,m])=>m.target==="b"+a.slice(1)),"re-annotated parts follow their nets");
  assert.ok(moved.work.scored < n*70,"rare terminal observations find distant reannotations independently of the crowded pool");
  assert.ok(Date.now()-t0<30000,"2,000-part assignment took "+(Date.now()-t0)+" ms");
}
// Reviewing a second row on the same committed project reuses the global solution. A real
// journaled edit invalidates it, and direct validation remains independent of this cache.
globalThis.__testDone=globalThis.__testDone.then(async()=>{
  const {p,s}=fixture(), solve=C.steps;let calls=0;
  U.reset();U.mark(p);
  C.steps=function*(...args){calls++;return yield* solve(...args);};
  try{
    const q=await E.planAsync(p,{reconcile:false});
    await E.planAsync(p,{reconcile:false,matchDecisions:[]});
    assert.equal(calls,1,"unchanged component evidence keeps its assignment");
    s.items[0].value="changed";U.touch(p);U.mark(p);
    await E.planAsync(p,{reconcile:false});assert.equal(calls,2,"changed evidence is rescored");
    E.validate(p,q);assert.ok(calls>=3,"validation checks the live model");
  }finally{C.steps=solve;U.reset();}
});
console.log("PASS smart correspondence in ECO and Compare, reannotation in place, reviewed copies and replacements, package swaps, scoped net renames, repeated channels, global assignment, cancellation and undo");
