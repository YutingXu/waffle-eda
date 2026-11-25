"use strict";
const assert = require("node:assert/strict");
for (const m of ["model","net-intent","net-intent-index","generic-parts","signals","altium-rules","query","stackup","impedance","ipc2152","viastack","rules","revisions","proposal","calculators","calculator-context","undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const fixture = require("./calculator-design.js");
const X = AtriumCalculatorContext, U = AtriumUndoStore, C = AtriumCalc, p = fixture();
const [s,b] = p.documents, defs = new Map(p.library.map(d=>[d.id,d]));
Atrium.validate(p);
assert.equal(C.calculate("eseries",{value:"4k7"}).values.nearest,4700);
assert.equal(C.calculate("eseries",{value:"2.2µF"}).values.nearest,2.2e-6);
assert.equal(C.calculate("via_current",{drill:"12mil"}).inputs.drill,.3048);
let doc = b, ids = [], net = "", rev = 0;
const host = {project:()=>p,doc:()=>doc,defs:()=>defs,selection:()=>ids,highlight:()=>net,activeLayer:()=>"Top",units:()=>p.units,revision:()=>rev};
const reader = X.createReader(host);
function select(d,items,highlight="") { doc=d; ids=items; net=highlight; return reader.read(); }
function check(now) {
  const q = Atrium.clone(p), d = q.documents.find(d=>d.id===doc.id), qdefs = new Map(q.library.map(x=>[x.id,x]));
  const fresh = X.context(q,d,qdefs,ids,net,"Top");
  assert.deepEqual(now.facts,fresh.facts,"incremental selection equals a fresh project computation");
  if (now.facts) {
    const calc = now.facts.id;
    assert.deepEqual(C.calculate(calc,now.facts.fields[calc],{doc:now.board,defs}).values,
      C.calculate(calc,fresh.facts.fields[calc],{doc:fresh.board,defs:qdefs}).values);
  }
  return now.facts;
}
function edit(d,changes,op) { op(); U.record(p,{doc:d,items:changes}); rev++; }
U.mark(p);
let saved = select(b,["clock"]), f = check(saved);
assert.equal(f.id,"impedance"); assert.equal(f.fields.impedance.width,.11); assert.equal(f.fields.impedance.target,50); assert.equal(f.fields.impedance.mode,"single");
let result = C.calculate("impedance",f.fields.impedance,{doc:b,defs});
assert.ok(result.values.synthesized); assert.ok(result.values.actual !== result.values.impedance);
const plan = X.plan(saved,"impedance",result);
assert.equal(plan.proposal.ops[0].id,"clock"); assert.equal(plan.proposal.ops[0].before,.11);
const clock = b.items[0], spare = b.items.find(i=>i.id==="spare");
edit(b,[spare],()=>{spare.width=.29;});
assert.equal(reader.read(),saved,"unrelated routed width does not re-read the selection");
edit(b,[clock],()=>{clock.color="#abcdef";});assert.equal(reader.read(),saved,"cosmetic property of selected track is ignored");
edit(b,[clock],()=>{clock.width=.13;}); f=check(reader.read()); assert.equal(f.fields.impedance.width,.13);
edit(b,[clock],()=>{clock.locked=true;});
saved=reader.read(); assert.equal(X.plan(saved,"impedance",C.calculate("impedance",saved.facts.fields.impedance,{doc:b,defs})),null);
edit(b,[clock],()=>{delete clock.locked;});
f=check(select(b,[],"D_N")); assert.equal(f.fields.impedance.mode,"differential"); assert.equal(f.fields.impedance.gap,.18); assert.equal(f.fields.impedance.width,.24);
f=check(select(b,[],"FROM_DIRECTIVE")); assert.equal(f.profile.id,"clock50");
f=check(select(b,[],"FROM_TAG")); assert.equal(f.profile.id,"clock50");
f=check(select(b,["positive","negative"])); assert.equal(f.fields.impedance.mode,"differential"); assert.equal(f.fields.impedance.gap,.18);
assert.equal(check(select(b,["clock","negative"])),null);
f=check(select(b,["via"])); assert.equal(f.fields.via_current.drill,.27);assert.equal(f.fields.via_current.to,"Inner 1");assert.ok(f.fields.via_current.length<.5);
f=check(select(b,["spare"]));assert.equal(f.id,"track_resistance");assert.equal(f.fields.track_resistance.width,.29);assert.equal(f.fields.track_resistance.length,65);
assert.ok(C.calculate(f.id,f.fields[f.id]).values.current_max>0);
const copper = b.stackup.layers.find(l=>l.key==="Top"), originalCopper = copper.thickness;
function copperThickness(value) {
  copper.thickness=value; U.record(p,{doc:b}); rev++;
  return check(reader.read());
}
f=copperThickness(.005);
assert.ok(Math.abs(f.fields.track_resistance.copper-.005/AtriumStackup.OZ)<1e-10);
assert.ok(C.calculate(f.id,f.fields[f.id]).values.resistance>0);
copperThickness(originalCopper);
f=check(select(s,["R3","R90"])); assert.equal(f.id,"divider");assert.equal(f.fields.divider.top,30000);assert.equal(f.fields.divider.bottom,10000);
assert.equal(C.calculate(f.id,f.fields.divider).values.vout,3.2);
const upper = s.items.find(i=>i.id==="R90"), lower=s.items.find(i=>i.id==="R3"), regulator = s.items.find(i=>i.id==="U9");
edit(s,[upper],()=>{upper.value="59k";}); f=check(reader.read()); assert.equal(f.fields.divider.top,59000);
edit(s,[regulator],()=>{delete regulator.parameters.Vref;});f=check(reader.read());assert.equal(f.fields.divider.vref,0);assert.equal(C.calculate(f.id,f.fields.divider).values.vout,null);
assert.equal(check(select(s,["R75","R76"])),null,"names resembling resistor or feedback roles are insufficient");
f=check(select(s,["R5","C7"]));assert.equal(f.fields.rclc.c,22);assert.equal(C.calculate("rclc",f.fields.rclc).values.tau_rc,48.4e-6);
const detached=s.items.find(i=>i.id==="C7-pin-0");
edit(s,[detached],()=>{detached.text="ISOLATED";});assert.equal(check(reader.read()),null,"electrically disconnected RC is not reported");
edit(s,[detached],()=>{detached.text="FILTER_X";});check(reader.read());
const legs=[upper,lower], sense=s.items.find(i=>i.id==="R90-pin-0");
select(s,legs.map(i=>i.id));edit(s,[sense],()=>{sense.text="FALSE_FB";});assert.equal(check(reader.read()),null);
f=check(select(s,["clk-label"]));assert.equal(f.fields.impedance.layer,"Top");assert.equal(f.fields.impedance.target,50);
const context=reader.read();result=C.calculate(f.id,f.fields.impedance,{doc:b,defs});
assert.equal(X.plan(context,f.id,result).owner,b.id,"a net-profile proposal belongs to the board from the schematic");
Object.defineProperty(p,"atriumCompat",{configurable:true,value:{readOnly:"2"}});
assert.equal(X.plan(context,f.id,result),null);delete p.atriumCompat;
p.revision={letter:"A",status:"released"};assert.equal(X.plan(context,f.id,result),null);delete p.revision;
// The Altium true-arc representation belongs to the shared model in the same preview.
if (Atrium.arcProjection) {
  for (const [end,sweep] of [[90,270],[0,360]]) {
    const arc = {kind:"arc",c:[12,-12],r:3,start:0,end,ccw:false};
    const curved = {...spare,arc,points:Atrium.arcProjection(arc)};
    edit(b,[spare],()=>Object.assign(spare,curved));
    f=check(select(b,[spare.id]));
    const chordLength = curved.points.slice(1).reduce((sum,[x,y],i)=>sum+Math.hypot(x-curved.points[i][0],y-curved.points[i][1]),0);
    const length = f.fields.track_resistance.length;
    assert.ok(Math.abs(length-3*sweep*Math.PI/180)<1e-9 && length>chordLength);
  }
}
U.reset();console.log("PASS incremental calculator selection, electrical roles, routing profiles, physical dimensions and proposal ownership");
