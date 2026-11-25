"use strict";
const assert=require("node:assert/strict");
const {now,checkThroughput}=require("../analysis/timing-check.js");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/schematic/sch-objects.js");require("../../app/checks/altium-rules.js");require("../../app/checks/net-intent.js");require("../../app/core/signals.js");require("../../app/checks/rules.js");require("../../app/pcb/pcb-appearance.js");require("../../app/pcb/pcb-edit.js");require("../../app/schematic/eco.js");require("../../app/schematic/sch-author.js");
const A=Atrium,E=AtriumECO;
assert.equal(E.serialize({z:["b","a"],a:{k:1,b:3}}),E.serialize({a:{b:3,k:1},z:["b","a"]}));
assert.deepEqual(JSON.parse(E.serialize({z:["b","a"]})).z,["b","a"]);
const p=AtriumParts.example(),[s,b]=p.documents;
const source=s.items.find(i=>i.ref==="R1"),target=b.items.find(i=>i.ref==="R1");
const all=()=>E.preview(p,"*",b.id);
const routed=b.items.filter(i=>i.kind==="track"||i.kind==="via");
const copper=E.serialize(routed);
assert.equal(all().eco.rows.length,0);
source.ref="R11";source.value="2 kΩ";target.pinNets["1"]="STALE";
const {eco}=all();
assert.equal(eco.rows.length,3);
assert.deepEqual(new Set(eco.rows.map(r=>r.field)),new Set(["ref","value","net"]));
const pick=rows=>({...eco,rows});
assert.equal(E.apply(p,pick(eco.rows.filter(r=>r.field==="value"))),1);
assert.equal(target.value,"2 kΩ");assert.equal(target.ref,"R1");assert.equal(target.pinNets["1"],"STALE");
const remaining=all().eco;
let snap=E.serialize(p);
assert.throws(()=>E.apply(p,eco),/stale/);assert.equal(E.serialize(p),snap);
assert.throws(()=>E.apply(p,{...remaining,rows:[remaining.rows[0],remaining.rows[0]]}),/duplicate/);
assert.equal(E.serialize(p),snap);
const serialized=E.serialize(remaining),copy=JSON.parse(serialized);assert.deepEqual(copy,remaining);
const fresh=A.validate(JSON.parse(E.serialize(p)));E.apply(fresh,copy);
let ftarget=fresh.documents[1].items.find(i=>i.id===target.id);
assert.equal(ftarget.ref,"R11");assert.equal(ftarget.pinNets["1"],"VIN");
assert.equal(E.serialize(fresh.documents[1].items.filter(i=>i.kind==="track"||i.kind==="via")),copper);
assert.equal(E.apply(p,remaining),2);assert.equal(all().eco.rows.length,0);
const r2=s.items.find(i=>i.ref==="R2");r2.ref="R11";const conflicting=all();
assert.ok(conflicting.issues.some(m=>m.includes("already in use")));
snap=E.serialize(p);assert.throws(()=>E.apply(p,conflicting.eco),/duplicate/);assert.equal(E.serialize(p),snap);
r2.ref="R2";
const orphan=A.clone(target);orphan.id=A.id();orphan.ref="R99";orphan.link=A.id();b.items.push(orphan);
assert.ok(all().issues.some(m=>m.includes("R99")&&m.includes("no linked component")));
orphan.link=target.link;source.value="3 kΩ";const ambiguous=all();assert.ok(ambiguous.issues.some(m=>m.includes("Ambiguous")));
assert.ok(!ambiguous.eco.rows.some(r=>r.link===source.link));
b.items.pop();const current=all().eco;
const bad={...current,rows:current.rows.map(r=>({...r,field:"__proto__"}))};
assert.throws(()=>E.apply(p,bad),/Invalid/);
const alien=AtriumParts.example();assert.throws(()=>E.apply(alien,current),/Choose/);
console.log("PASS v1: deterministic Git serialization; selective ECO transfer and portable replay; immutable routed copper; stale, ambiguous, invalid and conflicting changes rejected atomically");

// ---------------------------------------------------------------- ECO v2
const W=AtriumSchAuthor;
const byAction=(plan,a)=>plan.changes.filter(c=>c.action===a);
const parts=d=>d.items.filter(i=>i.kind==="part");
function scratch(){
  const p=A.project("Scratch",AtriumParts.catalogue),[sch,pcb]=p.documents;
  pcb.outline=[[0,0],[30,0],[30,20],[0,20]];
  const j=W.placePart(p,{def:"std-j2",x:0,y:0}),r=W.placePart(p,{def:"Resistor",x:20.32,y:0,value:"1 kΩ"}),c=W.placePart(p,{def:"std-c",x:40.64,y:0});
  W.addWire(p,{from:{designator:j.ref,pin:"1"},to:{designator:r.ref,pin:"1"}});
  W.addNetLabel(p,{text:"VOUT",at:{designator:r.ref,pin:"2"}});W.addNetLabel(p,{text:"VOUT",at:{designator:c.ref,pin:"1"}});
  W.addPowerPort(p,{net:"GND",at:{designator:c.ref,pin:"2"}});W.addPowerPort(p,{net:"GND",at:{designator:j.ref,pin:"2"}});
  return {p,sch,pcb,j,r,c};
}
// 1. A schematic drawn from scratch reaches an empty board in one ECO.
{
  const {p,sch,pcb,j,r,c}=scratch();
  assert.equal(E.preview(p,"*",pcb.id).eco.rows.length,0,"v1 sees nothing to change");
  const plan=E.plan(p,{board:pcb.id});
  assert.equal(plan.version,2);
  assert.deepEqual(byAction(plan,"addComponent").map(x=>x.object),["C1","J1","R1"]);
  assert.deepEqual(byAction(plan,"addNet").map(x=>x.object).sort(),["GND","Net-J1-1","VOUT"]);
  assert.equal(byAction(plan,"padNet").length,6);
  assert.ok(byAction(plan,"padNet").every(x=>x.requires?.length===2));
  for(const a of byAction(plan,"addComponent"))assert.ok(a.at[0]>30,"placed beside the board edge");
  const snap=E.serialize(p),check=E.validate(p,plan);
  assert.equal(E.serialize(p),snap,"validate never changes the project");
  assert.ok(check.valid&&check.failed===0,JSON.stringify(check.rows.filter(x=>x.state!=="done")));
  const done=E.execute(p,plan);
  assert.equal(done.failed,0);assert.equal(parts(pcb).length,3);
  const R1=parts(pcb).find(i=>i.ref===r.ref);
  assert.equal(R1.link,sch.items.find(i=>i.id===r.id).link,"links written both ways");
  assert.deepEqual(R1.pinNets,{"1":"Net-J1-1","2":"VOUT"});assert.equal(R1.value,"1 kΩ");
  A.validate(p);
  assert.equal(E.plan(p,{board:pcb.id}).changes.length,0,"in sync afterwards");
  assert.equal(E.preview(p,"*",pcb.id).eco.rows.length,0);
  // Boxes in the placement cluster do not overlap.
  const defs=new Map(p.library.map(d=>[d.id,d])),box=i=>A.bounds(A.itemPoints(i,defs.get(i.def),"pcb"));
  const bs=parts(pcb).map(box);for(let a=0;a<bs.length;a++)for(let b=a+1;b<bs.length;b++)assert.ok(bs[a][2]<=bs[b][0]||bs[b][2]<=bs[a][0]||bs[a][3]<=bs[b][1]||bs[b][3]<=bs[a][1]);
  void j;void c;
}
// 2. Unticked rows are skipped with their dependants; the rest still runs.
{
  const {p,pcb}=scratch(),plan=E.plan(p,{board:pcb.id});
  const off=byAction(plan,"addComponent").find(x=>x.object==="C1");off.selected=false;
  const r=E.execute(p,plan);
  assert.equal(parts(pcb).length,2);
  assert.ok(r.rows.filter(x=>x.object.startsWith("C1-")).every(x=>x.state==="skipped"&&/Needs/.test(x.message)));
  const again=E.plan(p,{board:pcb.id});
  assert.deepEqual(byAction(again,"addComponent").map(x=>x.object),["C1"]);
}
// 3. Designator, comment, parameter, footprint, rename and remove nets, extras and locks.
{
  const {p,sch,pcb}=scratch();E.update(p,{board:pcb.id});
  const sR=sch.items.find(i=>i.ref==="R1"),bR=parts(pcb).find(i=>i.ref==="R1");
  sR.ref="R7";sR.value="4k7";sR.parameters={TOLERANCE:"1%"};
  const big={...A.clone(p.library.find(d=>d.id==="std-r")),id:"r-1206",name:"Resistor 1206"};big.footprint.name="R_1206";big.footprint.pads.forEach(q=>q.x*=2);p.library.push(big);
  sR.def="r-1206";
  for(const l of sch.items)if(l.kind==="netlabel"&&l.text==="VOUT")l.text="SENSE";
  pcb.items.push({id:"t1",kind:"track",points:[[1,1],[2,1]],width:.25,layer:"Top",net:"VOUT"});
  pcb.items.push({id:"x1",kind:"part",def:"std-tp",ref:"TP9",value:"",link:"zz",x:5,y:5,angle:0,pinNets:{"1":"OLD"}});
  pcb.items.push({id:"x2",kind:"part",def:"std-tp",ref:"TP8",value:"",link:"yy",x:9,y:5,angle:0,pinNets:{},locked:true});
  const plan=E.plan(p,{board:pcb.id});
  const one=a=>{const l=byAction(plan,a);assert.equal(l.length,1,a+": "+JSON.stringify(l));return l[0];};
  assert.deepEqual([one("ref").before,one("ref").after],["R1","R7"]);
  assert.equal(one("value").after,"4k7");assert.equal(one("param").key,"TOLERANCE");
  assert.deepEqual([one("footprint").before,one("footprint").after],["R_0603","R_1206"]);
  assert.deepEqual([one("renameNet").before,one("renameNet").after],["VOUT","SENSE"]);
  assert.ok(!byAction(plan,"padNet").some(x=>!x.via),"pad moves are covered by the rename");
  const rm=one("removeComponent");assert.equal(rm.object,"TP9");assert.equal(rm.selected,false,"removal is opt-in");
  assert.ok(plan.issues.some(i=>/TP8/.test(i)&&/locked/.test(i)));
  assert.equal(byAction(plan,"removeNet").length,0,"a net on a footprint that was not compared is kept");
  assert.ok(plan.issues.some(i=>/Net OLD/.test(i)&&/kept/.test(i)));
  assert.equal(E.plan(p,{board:pcb.id,removeExtras:true}).changes.find(x=>x.action==="removeComponent").selected,true);
  const r=E.execute(p,plan);assert.equal(r.failed,0,JSON.stringify(r.rows.filter(x=>x.state==="failed")));
  assert.equal(bR.ref,"R7");assert.equal(bR.def,"r-1206");assert.equal(bR.parameters.TOLERANCE,"1%");assert.equal(bR.pinNets["2"],"SENSE");
  assert.equal(pcb.items.find(i=>i.id==="t1").net,"SENSE","routed copper follows a renamed net");
  assert.ok(pcb.items.some(i=>i.id==="x1"),"unticked removal keeps the footprint");
  assert.ok(pcb.items.some(i=>i.id==="x2"));
  rm.selected=true;
  const plan2=E.plan(p,{board:pcb.id,removeExtras:true});E.execute(p,plan2);
  assert.ok(!pcb.items.some(i=>i.id==="x1")&&pcb.items.some(i=>i.id==="x2"),"locked footprints are never removed");
  // Stale plans fail per change and change nothing for that row.
  const {p:q,pcb:qb}=scratch(),stale=E.plan(q,{board:qb.id});E.execute(q,stale);
  const again=E.execute(q,stale);assert.ok(again.failed>0&&parts(qb).length===3);
}
// 4. Multi-gate parts: the gates are one footprint; pins take the net of the gate that owns them.
{
  const p=A.project("Gates",AtriumParts.catalogue),[sch,pcb]=p.documents;
  const g=s=>[[-2,0],[2,0]].map(([x,y],k)=>({number:String(s*2+k-1),name:"P"+(s*2+k-1),x:x*1.27,y,part:s}));
  p.library.push({id:"dual",name:"Dual",prefix:"U",value:"Dual",symbol:{parts:2,pins:[...g(1),...g(2),{number:"5",name:"V",x:0,y:2.54,part:0}],shapes:[]},
    footprint:{name:"DUAL",shapes:[],pads:[1,2,3,4,5].map(n=>({number:String(n),x:n,y:0,w:.6,h:.6,shape:"rect",angle:0}))}});
  const a=W.placePart(p,{def:"dual",x:0,y:0}),b=W.placePart(p,{def:"dual",x:20.32,y:0,designator:a.ref});
  assert.equal(b.unit,2);assert.equal(b.ref,"U1");assert.equal(b.link,a.link);
  W.addNetLabel(p,{text:"A",at:{designator:"U1",pin:"1"}});W.addNetLabel(p,{text:"A",at:{designator:"U1",pin:"4"}});
  W.addNetLabel(p,{text:"VCC",at:{designator:"U1",pin:"5"}});
  const plan=E.plan(p,{board:pcb.id});
  assert.equal(byAction(plan,"addComponent").length,1);
  E.execute(p,plan);
  const u=parts(pcb)[0];assert.equal(u.pinNets["1"],"A");assert.equal(u.pinNets["4"],"A");assert.equal(u.pinNets["5"],"VCC");
  for(const s of parts(sch))assert.equal(s.link,u.link);
  assert.equal(E.plan(p,{board:pcb.id}).changes.length,0);
  assert.throws(()=>W.placePart(p,{def:"dual",x:0,y:10,designator:"U1"}),/Every gate/);
  void sch;
}
// 5. Net class and differential pair directives act on the board live (signals.js); Update PCB copies
//    nothing, and once the nets exist on the board the classes and the pair are there.
{
  const {p,pcb,r,c}=scratch();
  W.addNetLabel(p,{text:"USB_P",at:{designator:r.ref,pin:"1"},diffPair:"USB",netClass:"HS"});
  W.addNetLabel(p,{text:"USB_N",at:{designator:c.ref,pin:"2"},diffPair:"USB",netClass:"HS"});
  const plan=E.plan(p,{board:pcb.id});
  assert.ok(!plan.changes.some(x=>x.action==="netClass"||x.action==="diffPair"),"no class or pair rows");
  E.execute(p,plan);
  assert.deepEqual(AtriumRules.netClasses(pcb,{project:p}).HS,["USB_N","USB_P"]);
  assert.deepEqual(AtriumRules.diffPairs(pcb,{project:p}).map(x=>[x.name,x.positive,x.negative]),[["USB","USB_P","USB_N"]]);
  assert.equal(pcb.rules,undefined,"nothing was copied into the board rules");
  A.validate(p);
  assert.ok(!E.plan(p,{board:pcb.id}).changes.some(x=>x.action==="netClass"||x.action==="diffPair"));
  // Polarity without suffixes: USB_DP/USB_DM (net-intent), and arbitrary names are accepted with a note.
  const {p:q,pcb:qb,r:qr,c:qc}=scratch();
  W.addNetLabel(q,{text:"LINK_A",at:{designator:qr.ref,pin:"1"},diffPair:"LINK"});
  W.addNetLabel(q,{text:"LINK_B",at:{designator:qc.ref,pin:"2"},diffPair:"LINK"});
  E.execute(q,E.plan(q,{board:qb.id}));
  assert.deepEqual(AtriumRules.diffPairs(qb,{project:q}).map(x=>[x.positive,x.negative]),[["LINK_A","LINK_B"]]);
  assert.ok([...E.plan(q,{board:qb.id}).issues].some(t=>/Polarity of LINK was assumed/.test(t)));
}
// 6. Update Schematic from PCB: designator swaps, comments and footprints flow back.
{
  const {p,sch,pcb}=scratch();E.update(p,{board:pcb.id});
  const bR=parts(pcb).find(i=>i.ref==="R1"),bC=parts(pcb).find(i=>i.ref==="C1");
  bR.ref="C1";bC.ref="R1";bR.value="2k2";
  bC.def="std-tp";  // a footprint-only swap on the board
  const tp=p.library.find(d=>d.id==="std-tp");void tp;
  const back=E.plan(p,{board:pcb.id,direction:"sch"});
  assert.deepEqual(byAction(back,"ref").map(x=>x.before+">"+x.after).sort(),["C1>R1","R1>C1"]);
  const fp=byAction(back,"footprint")[0];assert.equal(fp.after,"TestPoint_1.5mm");
  const sC=sch.items.find(i=>i.ref==="C1");
  const r=E.execute(p,back);assert.equal(r.failed,0,JSON.stringify(r.rows));
  assert.equal(sch.items.find(i=>i.id===sC.id).ref,"R1");
  assert.equal(sch.items.find(i=>i.ref==="C1").value,"2k2");
  A.validate(p);
  assert.ok(!E.plan(p,{board:pcb.id}).changes.some(x=>x.action==="ref"||x.action==="value"),"forward ECO is clean after back-annotation");
}
// 7. Export and reopen: the selection survives; outdated changes are left out.
{
  const {p,pcb}=scratch(),plan=E.plan(p,{board:pcb.id});
  byAction(plan,"addComponent").find(x=>x.object==="J1").selected=false;
  const file=JSON.parse(E.serialize({...plan,changes:plan.changes.filter(x=>x.selected)}));
  const back=E.reopen(p,file);assert.equal(back.stale,0);
  assert.equal(back.plan.changes.find(x=>x.object==="J1").selected,false);
  const added=back.plan.changes.find(x=>x.object==="R1"&&x.action==="addComponent");
  assert.equal(added.partId,plan.changes.find(x=>x.object==="R1"&&x.action==="addComponent").partId);
  assert.ok(/Add R1/.test(E.report(plan,null)));
}
console.log("PASS v2: schematic from scratch to board in one ECO, dependencies, component/net/footprint/parameter changes, net rename keeps copper, opt-in removal never touches locks, gates share a footprint, net classes and diff pairs, update schematic from PCB, reopen");

// ---------------------------------------------------------------- review fixes
// H1. A scoped ECO never clears nets of footprints it did not compare; nor does a skipped pin.
{
  const {p,sch,pcb}=scratch();
  const second=A.sheet("schematic","Second");p.documents.push(second);
  const t=W.placePart(p,{sheet:second.id,def:"std-tp",x:0,y:0});
  W.addNetLabel(p,{sheet:second.id,text:"SPI_CLK",at:{designator:t.ref,pin:"1"}});
  W.addNetLabel(p,{sheet:second.id,text:"SPI_CLK",x:20,y:20});
  E.update(p,{board:pcb.id});
  const tp=parts(pcb).find(i=>i.ref===t.ref);assert.equal(tp.pinNets["1"],"SPI_CLK");
  const scoped=E.plan(p,{board:pcb.id,scope:sch.id});
  assert.equal(byAction(scoped,"removeNet").length,0,"nets of other sheets are not removed");
  assert.equal(E.plan(p,{board:pcb.id,scope:"Second"}).scope,second.id,"scope by sheet name");
  assert.throws(()=>E.plan(p,{board:pcb.id,scope:"Nope"}),/No schematic sheet/);
  E.execute(p,scoped);assert.equal(tp.pinNets["1"],"SPI_CLK");
  // A conflicting label skips C1-2: GND stays on every pad.
  W.addNetLabel(p,{text:"AGND",at:{designator:"C1",pin:"2"}});
  const conflict=E.plan(p,{board:pcb.id});
  assert.ok(conflict.issues.some(i=>/conflicting/.test(i)));
  assert.ok(!byAction(conflict,"removeNet").some(c=>c.object==="GND"));
  E.execute(p,conflict);
  assert.equal(parts(pcb).find(i=>i.ref==="J1").pinNets["2"],"GND");assert.equal(parts(pcb).find(i=>i.ref==="C1").pinNets["2"],"GND");
}
// H1 (gates). Scoped to one sheet, a part whose other gate is on another sheet keeps that gate's nets.
{
  const p=A.project("Gates2",AtriumParts.catalogue),[s1,pcb]=p.documents,s2=A.sheet("schematic","Two");p.documents.push(s2);
  const g=k=>[[-2,0],[2,0]].map(([x,y],j)=>({number:String(k*2+j-1),name:"P",x:x*1.27,y,part:k}));
  p.library.push({id:"dual",name:"Dual",prefix:"U",value:"Dual",symbol:{parts:2,pins:[...g(1),...g(2)],shapes:[]},footprint:{name:"D",shapes:[],pads:[1,2,3,4].map(n=>({number:String(n),x:n,y:0,w:.6,h:.6,shape:"rect",angle:0}))}});
  W.placePart(p,{sheet:s1.id,def:"dual",x:0,y:0,designator:"U1"});W.placePart(p,{sheet:s2.id,def:"dual",x:0,y:0,designator:"U1B"});
  W.addNetLabel(p,{sheet:s1.id,text:"A",at:{designator:"U1",pin:"1"}});W.addNetLabel(p,{sheet:s2.id,text:"B",at:{designator:"U1",pin:"3"}});
  E.update(p,{board:pcb.id});assert.equal(parts(pcb)[0].pinNets["3"],"B");
  assert.equal(E.plan(p,{board:pcb.id,scope:s1.id}).changes.length,0);
}
// H2. add_wire never shorts what its route passes over: the other elbow, else a refusal.
{
  const p=A.project("Short",AtriumParts.catalogue),sch=p.documents[0],defs=()=>new Map(p.library.map(d=>[d.id,d]));
  const r1=W.placePart(p,{def:"std-r",x:0,y:0}),r3=W.placePart(p,{def:"std-r",x:15.24,y:0}),r2=W.placePart(p,{def:"std-r",x:20.32,y:10.16});
  W.addPowerPort(p,{net:"GND",at:{designator:r3.ref,pin:"1"}});
  const w=W.addWire(p,{from:{designator:r1.ref,pin:"2"},to:{designator:r2.ref,pin:"1"}});
  assert.deepEqual(w.points,[[5.08,0],[5.08,10.16],[15.24,10.16]],"took the vertical-first elbow");
  const g=A.connectivity(sch,defs());
  assert.notEqual(g.byPin.get(r3.id+"/1"),g.byPin.get(r1.id+"/2"));
  // Both elbows blocked: refused, listing what it would hit; allow_join connects on purpose.
  const r4=W.placePart(p,{def:"std-r",x:40.64,y:20.32}),r5=W.placePart(p,{def:"std-r",x:60.96,y:40.64});
  W.addNetLabel(p,{text:"X",x:55.88,y:20.32});W.addNetLabel(p,{text:"Y",x:45.72,y:40.64});
  const before=sch.items.length;
  assert.throws(()=>W.addWire(p,{from:{designator:r4.ref,pin:"2"},to:{designator:r5.ref,pin:"1"}}),/would connect to net label X/);
  assert.throws(()=>W.addWire(p,{points:[[0,30],[100,30],[100,20.32],[0,20.32]]}),/would connect to/);
  assert.equal(sch.items.length,before,"nothing is drawn on a refusal");
  W.addWire(p,{from:{designator:r4.ref,pin:"2"},to:{designator:r5.ref,pin:"1"},allowJoin:true});
}
// M1. A footprint change on the bottom side uses the mirrored definition.
{
  const {p,sch,pcb}=scratch();E.update(p,{board:pcb.id});
  const bR=parts(pcb).find(i=>i.ref==="R1");AtriumPCBEdit.flip(pcb,p,[bR.id]);assert.equal(bR.layer,"Bottom");
  const big={...A.clone(p.library.find(d=>d.id==="std-r")),id:"r-1206",name:"R 1206"};big.footprint.name="R_1206";p.library.push(big);
  sch.items.find(i=>i.ref==="R1").def="r-1206";
  E.execute(p,E.plan(p,{board:pcb.id}));
  const d=p.library.find(x=>x.id===bR.def);assert.equal(d.mirrorOf,"r-1206");assert.equal(bR.layer,"Bottom");
  assert.equal(byAction(E.plan(p,{board:pcb.id}),"footprint").length,0);
}
// M2. Pad rows against a new footprint wait for the footprint change.
{
  const {p,sch,pcb}=scratch();E.update(p,{board:pcb.id});
  const three={...A.clone(p.library.find(d=>d.id==="std-j3")),id:"j3b",name:"J3b",symbol:A.clone(p.library.find(d=>d.id==="std-j3").symbol)};
  p.library.push(three);
  const j=sch.items.find(i=>i.ref==="J1");j.def="j3b";
  const plan=E.plan(p,{board:pcb.id}),fp=byAction(plan,"footprint")[0];fp.selected=false;
  const r=E.execute(p,plan),rows=r.rows.filter(x=>x.object.startsWith("J1-")&&x.message!=="Not selected");
  assert.ok(rows.length&&rows.every(x=>x.state==="skipped"&&/Change footprint/.test(x.message)),JSON.stringify(rows));
  assert.equal(r.failed,0);
}
// M3. A rename moves only the pads the schematic keeps on the net.
{
  const {p,sch,pcb}=scratch();E.update(p,{board:pcb.id});
  for(const l of sch.items)if(l.kind==="netlabel"&&l.text==="VOUT")l.text="VS";
  const cLabel=sch.items.find(l=>l.kind==="netlabel"&&l.text==="VS"&&A.same([l.x,l.y],W.pinAt(p,sch,"C1","1").at));
  sch.items.splice(sch.items.indexOf(cLabel),1);
  const plan=E.plan(p,{board:pcb.id});
  assert.equal(byAction(plan,"renameNet")[0].after,"VS");
  const drop=byAction(plan,"padNet").find(x=>x.object==="C1-1");assert.equal(drop.after,"");assert.equal(drop.selected,true,"ticked: its net goes away");
  const r=E.execute(p,plan);assert.equal(r.failed,0,JSON.stringify(r.rows.filter(x=>x.state==="failed")));
  assert.equal(parts(pcb).find(i=>i.ref==="C1").pinNets["1"],"");
  assert.equal(E.plan(p,{board:pcb.id}).changes.length,0,"converges in one pass");
}
// M6. Rooms need at least one added footprint and are not duplicated (rooms.js).
{
  require("../../app/pcb/rooms.js");
  try{
    const {p,pcb}=scratch(),plan=E.plan(p,{board:pcb.id,rooms:true}),rooms=()=>pcb.rooms||[];
    for(const c of byAction(plan,"addComponent"))c.selected=false;
    const r=E.execute(p,plan);assert.equal(rooms().length,0);assert.ok(/None of its footprints/.test(r.rows.find(x=>x.action==="room").message));
    E.execute(p,E.plan(p,{board:pcb.id,rooms:true}));assert.equal(rooms().length,1);assert.equal(rooms()[0].members.length,3);
    W.placePart(p,{def:"std-tp",x:80,y:0});
    const r2=E.execute(p,E.plan(p,{board:pcb.id,rooms:true}));
    assert.equal(rooms().length,1,"the sheet's room takes the new footprint");assert.equal(rooms()[0].members.length,4);
    assert.ok(/added to room/.test(r2.rows.find(x=>x.action==="room").message));A.validate(p);
  }finally{delete globalThis.AtriumRooms;}
}
// L1. "U1B" places gate B of U1.
{
  const p=A.project("Gate",AtriumParts.catalogue);
  const g=s=>[[-2,0],[2,0]].map(([x,y],k)=>({number:String(s*2+k-1),name:"P",x:x*1.27,y,part:s}));
  p.library.push({id:"dual",name:"Dual",prefix:"U",value:"Dual",symbol:{parts:2,pins:[...g(1),...g(2)],shapes:[]},footprint:{name:"D",shapes:[],pads:[1,2,3,4].map(n=>({number:String(n),x:n,y:0,w:.6,h:.6,shape:"rect",angle:0}))}});
  W.placePart(p,{def:"dual",x:0,y:0,designator:"U1"});
  const b=W.placePart(p,{def:"dual",x:20.32,y:0,designator:"U1B"});
  assert.deepEqual([b.ref,b.unit],["U1",2]);
  assert.throws(()=>W.placePart(p,{def:"dual",x:0,y:20,designator:"U2C"}),/gates/);
  assert.equal(byAction(E.plan(p,{board:p.documents[1].id}),"addComponent").length,1);
}
// L4. A net class follows a renamed net and drops names the schematic no longer has.
{
  const {p,sch,pcb}=scratch();
  for(const l of sch.items)if(l.kind==="netlabel"&&l.text==="VOUT")l.netClass="PWR";
  assert.deepEqual(AtriumRules.netClasses(pcb,{project:p}).PWR,["VOUT"],"live, without an update");
  for(const l of sch.items)if(l.kind==="netlabel"&&l.text==="VOUT")l.text="VSENSE";
  const r=E.update(p,{board:pcb.id});assert.equal(r.report.failed,0,JSON.stringify(r.report.rows.filter(x=>x.state==="failed")));
  assert.deepEqual(AtriumRules.netClasses(pcb,{project:p}).PWR,["VSENSE"]);
  assert.equal(E.plan(p,{board:pcb.id}).changes.length,0);
}
// L5. Giving an unlinked schematic part a link keeps its assembly-variant entry.
{
  const {p,sch,pcb}=scratch(),r=sch.items.find(i=>i.ref==="R1");delete r.link;
  p.variants=[{id:"v1",name:"Lite",parts:{[r.id]:{fitted:false}}}];
  E.update(p,{board:pcb.id});
  assert.ok(r.link);assert.deepEqual(p.variants[0].parts,{[r.link]:{fitted:false}});
}
// L7. A new outline does not silently drop board-shape cutouts.
{
  const {p,pcb}=scratch();pcb.boardShape={version:1,contour:[],cutouts:[[]]};
  assert.throws(()=>W.setBoardOutline(p,{rect:[0,0,10,10]}),/cutout/);
  assert.equal(W.setBoardOutline(p,{rect:[0,0,10,10],replaceCutouts:true}).replaced.cutouts,1);
  assert.throws(()=>W.deleteItems(p,{designators:["R1"]}),/Name the document/);
  assert.equal(W.deleteItems(p,{designators:["R1"],document:p.documents[0].id}).removed.length,1);
}
// M4. A board with 2,000 parts and 20,000 tracks validates within the test budget.
{
  const p=A.project("Big",AtriumParts.catalogue),[sch,pcb]=p.documents;
  for(let n=0;n<2000;n++){const r=W.placePart(p,{def:"std-r",x:(n%40)*12.7,y:Math.floor(n/40)*7.62,designator:"R"+(n+1)});
    W.addNetLabel(p,{text:"N"+(n%700),at:{designator:r.ref,pin:"1"}});W.addNetLabel(p,{text:"M"+((n+1)%700),at:{designator:r.ref,pin:"2"}});}
  E.update(p,{board:pcb.id});
  for(let n=0;n<20000;n++)pcb.items.push({id:"t"+n,kind:"track",points:[[n,0],[n,1]],width:.2,layer:"Top",net:"N"+(n%700)});
  for(const l of sch.items)if(l.kind==="netlabel"&&l.text.startsWith("N"))l.text="Q"+l.text;
  const planStart=now(),plan=E.plan(p,{board:pcb.id}),planned=now()-planStart;
  assert.equal(byAction(plan,"renameNet").length,700);
  const {ms:validated}=checkThroughput(clock=>{
    const start=clock(),result=E.validate(p,plan),ms=clock()-start;
    assert.equal(result.failed,0);
    assert.ok(result.valid,result.error);
    return {ms};
  },"ECO validation took",1000);
  console.log("perf: plan "+planned.toFixed(1)+" ms, validate "+validated.toFixed(1)+" ms for "+plan.changes.length+" changes");
}
console.log("PASS review fixes: scoped ECO keeps other nets (H1), wires refuse unintended joins (H2), bottom-side footprints mirror, pad rows wait for footprints, renames keep disconnected pads, rooms, gate designators, net classes follow renames, variants re-keyed, cutouts kept");
