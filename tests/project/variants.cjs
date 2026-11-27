"use strict";
// Assembly variants (app/project/variants.js) and the outputs that follow them.
// Run against the repository or a copy with the variants integration patches applied:
// the integration checks at the end run only when model.js / step-export.js / fab-outputs.js
// carry the variants hooks.
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/core/zip.js");require("../../app/formats/bom.js");require("../../app/project/variants.js");
const A=Atrium,B=AtriumBOM,V=AtriumVariants;

const base=AtriumParts.example(),[sch,brd]=base.documents;
const refs=d=>d.items.filter(i=>i.kind==="part").map(i=>i.ref);
assert.ok(refs(sch).includes("R1")&&refs(brd).includes("R1"));
const part=(doc,ref)=>doc.items.find(i=>i.kind==="part"&&i.ref===ref);
const key=ref=>V.keyOf(part(sch,ref));
assert.equal(key("R1"),part(brd,"R1").link,"a schematic part and its footprint share a key");

// ------------------------------------------------------------ data model and validation
assert.deepEqual(V.list(base),[]);
assert.equal(V.current(base),null);
assert.throws(()=>V.current(base,"Nope"),/no assembly variant called Nope/);
const p=A.clone(base);
const lite=V.create(p,{name:"Lite",description:"No output buffer"});
const pro=V.create(p,{name:"Pro"});
assert.equal(p.variants.length,2);assert.ok(lite.id&&pro.id&&lite.id!==pro.id);
assert.equal(V.create(p,{name:"lite"}).name,"lite 2","names stay unique (case-insensitive)");
V.remove(p,V.find(p,"LITE 2").id);
assert.equal(V.find(p,"pro"),pro);assert.equal(V.find(p,pro.id),pro);
V.validate(p.variants);
A.validate(p);
for(const bad of [
  [{id:"a",name:"A"},{id:"a",name:"B"}],                       // duplicate id
  [{id:"a",name:"A"},{id:"b",name:" a "}],                     // duplicate name
  [{id:"a",name:""}],
  [{id:"a",name:"A",parts:{x:{fitted:"no"}}}],
  [{id:"a",name:"A",parts:{x:{alternate:{def:5}}}}],
  [{id:"a",name:"A",parts:{x:{params:{Value:7}}}}],
  [{id:"a",name:"A",parts:{x:{colour:"red"}}}],
  [{id:"a",name:"A",extra:1}],
])assert.throws(()=>V.validate(bad),/Assembly variants/);
V.validate([{id:"a",name:"A",parts:{x:{fitted:false},y:{alternate:{def:"std-r",value:"1k",params:{MPN:"X",Old:null}},params:{Note:"n"}},z:{params:{}}}}]);

// ------------------------------------------------------------ editing and resolve
V.setParts(p,lite.id,[key("U1")],{fitted:false});
V.setParts(p,lite.id,[key("R2")],{alternate:{value:"4.7 kΩ",params:{"Manufacturer Part Number":"RC0603FR-074K7L"}}});
V.setParts(p,lite.id,[key("C1")],{params:{Tolerance:"5%"}});
V.setParts(p,pro.id,[key("R1")],{fitted:true}); // R1 is fitted in the base design: no entry needed
assert.deepEqual(pro.parts,{});
assert.deepEqual(lite.parts[key("U1")],{fitted:false});
assert.deepEqual(lite.parts[key("R2")],{alternate:{value:"4.7 kΩ",params:{"Manufacturer Part Number":"RC0603FR-074K7L"}}});
let r=V.resolve(p,lite.id);
assert.equal(r[key("U1")].fitted,false);assert.equal(r[key("U1")].baseFitted,true);
assert.equal(r[key("U1")].items.length,2,"both views of U1");
assert.equal(r[key("R2")].fitted,true);assert.equal(r[key("R2")].alternate,true);assert.equal(r[key("R2")].value,"4.7 kΩ");
assert.equal(r[key("R2")].params["Manufacturer Part Number"],"RC0603FR-074K7L");
assert.equal(r[key("C1")].params.Tolerance,"5%");assert.equal(r[key("C1")].alternate,false);
assert.equal(r[key("R1")].overridden,false);
r=V.resolve(p,null);
assert.ok(Object.values(r).every(x=>x.fitted),"the base design fits everything");
// Not fitted wins over an alternate; Fitted clears an alternate; reset drops the entry.
V.setParts(p,pro.id,[key("R2")],{alternate:{def:"std-r",value:"1 kΩ"}});
assert.equal(V.resolve(p,pro.id)[key("R2")].value,"1 kΩ");
V.setParts(p,pro.id,[key("R2")],{fitted:false});
assert.deepEqual(pro.parts[key("R2")],{fitted:false});
V.setParts(p,pro.id,[key("R2")],{reset:true});
assert.deepEqual(pro.parts,{});
assert.throws(()=>V.setParts(p,null,[key("R2")],{alternate:{value:"x"}}),/base design/);

// The existing DNP flag is the base design's not-fitted state, inherited by variants.
V.setParts(p,null,[key("J2")],{fitted:false});
assert.equal(part(sch,"J2").dnp,undefined,"base edits go to the project, not the source example");
assert.equal(p.documents[0].items.find(i=>i.ref==="J2").dnp,true);
assert.equal(p.documents[1].items.find(i=>i.ref==="J2").dnp,true,"and to the board copy");
assert.equal(V.resolve(p,null)[key("J2")].fitted,false);
assert.equal(V.resolve(p,lite.id)[key("J2")].fitted,false,"variants inherit base DNP");
V.setParts(p,pro.id,[key("J2")],{fitted:true});
assert.deepEqual(pro.parts[key("J2")],{fitted:true},"fitted is kept where the base says DNP");
assert.equal(V.resolve(p,pro.id)[key("J2")].fitted,true);
// BOM parameter spellings count as base DNP too.
const q=A.clone(base);
q.documents[0].items.find(i=>i.ref==="C2").parameters={DNP:"Yes"};
assert.equal(V.resolve(q,null)[V.keyOf(part(sch,"C2"))].fitted,false);

// Compare.
let diff=V.compare(p,null,lite.id);
assert.deepEqual(diff.map(x=>x.ref+":"+x.fields.join("+")),["C1:params","R2:value+params","U1:fitted"]);
diff=V.compare(p,lite.id,pro.id);
assert.ok(diff.some(x=>x.ref==="J2"&&x.fields[0]==="fitted"));

// Rows for the manager: one per designator, physical parts only.
const rows=V.rows(p);
assert.deepEqual(rows.map(x=>x.ref),["C1","C2","J1","J2","R1","R2","U1"]);
assert.equal(rows.find(x=>x.ref==="U1").keys.length,1);

// Rename, duplicate, active variant.
V.rename(p,lite.id,{name:"Lite edition",description:""});
assert.equal(lite.name,"Lite edition");assert.equal(lite.description,undefined);
assert.throws(()=>V.rename(p,lite.id,{name:"pro"}),/already a variant/);
const copy=V.duplicate(p,lite.id);
assert.equal(copy.name,"Lite edition copy");assert.deepEqual(copy.parts,lite.parts);assert.notEqual(copy.parts,lite.parts);
V.remove(p,copy.id);
V.setActive(p,"Lite edition");assert.equal(p.activeVariant,lite.id);
assert.equal(V.current(p),lite);assert.equal(V.current(p,null),null);assert.equal(V.current(p,""),null);
A.validate(p);

// ------------------------------------------------------------ apply / forOutput
const applied=V.apply(p);
assert.equal(applied.activeVariant,undefined);assert.deepEqual(applied.variantApplied,{id:lite.id,name:"Lite edition"});
const ap=(d,ref)=>applied.documents[d].items.find(i=>i.ref===ref);
assert.equal(ap(0,"U1").dnp,true);assert.equal(ap(1,"U1").dnp,true);
assert.equal(ap(0,"R2").value,"4.7 kΩ");assert.equal(ap(0,"R2").dnp,false);
assert.equal(ap(0,"C1").parameters.Tolerance,"5%");
assert.equal(p.documents[0].items.find(i=>i.ref==="U1").dnp,undefined,"apply never touches the source");
assert.equal(applied.documents[1].items.find(i=>i.kind==="track"),p.documents[1].items.find(i=>i.kind==="track"),"non-part items are shared");
assert.equal(V.forOutput(base),base,"no variants: the project itself");
assert.equal(V.forOutput(applied),applied,"already applied");
assert.equal(V.forOutput(p,null).variantApplied,null,"the base design explicitly");
assert.equal(V.forOutput(p,null).documents[0].items.find(i=>i.ref==="U1").dnp,undefined);
assert.equal(V.current(applied),null);
// An alternate library part: schematic uses it, the board keeps its copper unless the pads match.
const alt={...A.clone(base.library.find(d=>d.id==="std-r")),id:"alt-r",name:"Precision resistor",value:"10k 0.1%",parameters:{Manufacturer:"Vishay",MPN:"TNPW060310K0BEEA"}};
p.library.push(alt);
V.setParts(p,lite.id,[key("R1")],{alternate:{def:"alt-r"}});
const a2=V.apply(p,lite.id),r1s=a2.documents[0].items.find(i=>i.ref==="R1"),r1b=a2.documents[1].items.find(i=>i.ref==="R1");
assert.equal(r1s.def,"alt-r");assert.equal(r1s.value,"10k 0.1%");assert.deepEqual(r1s.parameters,{Manufacturer:"Vishay",MPN:"TNPW060310K0BEEA"});
assert.equal(r1b.def,"std-r","the board keeps its footprint (variants never change copper)");
assert.equal(r1b.value,"10k 0.1%");assert.equal(r1b.parameters.MPN,"TNPW060310K0BEEA");
assert.equal(V.resolve(p,lite.id)[key("R1")].def,"alt-r");
// Includer for STEP / 3D.
const inc=V.includer(p);
assert.equal(inc(part(brd,"U1")),false);assert.equal(inc(part(brd,"R1")),true);

// ------------------------------------------------------------ BOM follows the variant
let c=B.collect(p);
assert.equal(c.variant.name,"Lite edition");
assert.ok(c.dnp.some(e=>e.ref==="U1"),"active variant: U1 not fitted");
assert.ok(c.dnp.some(e=>e.ref==="J2"));
assert.equal(c.parts.find(e=>e.ref==="R2").comment,"4.7 kΩ");
assert.equal(c.parts.find(e=>e.ref==="R1").mpn,"TNPW060310K0BEEA");
assert.equal(c.parts.find(e=>e.ref==="R1").item,p.documents[0].items.find(i=>i.ref==="R1"),"BOM edits land on the live part");
c=B.collect(p,{variant:""});
assert.equal(c.variant,null);assert.ok(!c.dnp.some(e=>e.ref==="U1"));assert.ok(c.dnp.some(e=>e.ref==="J2"));
c=B.collect(p,{variant:"Pro"});
assert.equal(c.variant.name,"Pro");assert.ok(!c.dnp.some(e=>e.ref==="J2"),"Pro fits J2 despite base DNP");
assert.throws(()=>B.collect(p,{variant:"Nope"}),/no assembly variant/);
assert.equal(B.collect(V.apply(p,"Pro")).variant.name,"Pro","an applied copy is not re-applied");
let rep=B.report(p,{now:"2026-01-02T00:00:00Z"});
assert.equal(rep.variant,"Lite edition");
assert.ok(B.csv(rep).includes("Variant,Lite edition"));
assert.ok(B.html(rep).includes("<dt>Variant</dt><dd>Lite edition</dd>"));
rep=B.report(p,{variant:"",now:"2026-01-02T00:00:00Z"});
assert.equal(rep.variant,undefined);assert.ok(!B.csv(rep).includes("Variant,"));
// Saved views can pin a variant.
B.saveView(p,{name:"Pro build",variant:pro.id});
assert.equal(B.findView(p,"Pro build").variant,pro.id);
rep=B.report(p,{view:"Pro build",now:"2026-01-02T00:00:00Z"});
assert.equal(rep.variant,"Pro");
A.validate(p);
// Projects without variants report exactly as before.
assert.equal(B.report(base,{now:"2026-01-02T00:00:00Z"}).variant,undefined);
assert.equal(B.collect(base).variant,null);

// ------------------------------------------------------------ canvas overlay (DOM-free part)
const boxes=V.notFittedBoxes(p,p.documents[1]);
assert.equal(boxes.length,2,"U1 and J2 on the board");
assert.ok(boxes.every(b=>b.length===4&&b[2]>b[0]&&b[3]>b[1]));
assert.equal(V.notFittedBoxes(p,p.documents[1],"Pro").length,0);assert.equal(V.notFittedBoxes(p,p.documents[1],null).length,1);
const calls=[];
const ctx2d=new Proxy({},{get:(t,k)=>k in t?t[k]:(...a)=>calls.push(k),set:(t,k,v)=>(t[k]=v,true)});
const seen={fill:[],stroke:[],width:[],alpha:[]};
const ctxSeen=new Proxy({},{get:(t,k)=>k in t?t[k]:(...a)=>calls.push(k),set:(t,k,v)=>{({fillStyle:seen.fill,strokeStyle:seen.stroke,lineWidth:seen.width,globalAlpha:seen.alpha})[k]?.push(v);t[k]=v;return true;}});
V.paint(ctxSeen,boxes,10,"pcb");
assert.equal(calls.filter(k=>k==="fillRect").length,2);assert.equal(calls.filter(k=>k==="stroke").length,2);
// Not fitted is information, not a fault: a light veil of the canvas colour and a hairline neutral cross,
// one screen pixel and a quarter wide at any zoom, never a dark slab or a saturated red X.
assert.ok(seen.alpha.every(a=>a<=.5),"quiet alphas "+seen.alpha);
assert.ok(seen.width.every(w=>Math.abs(w*10-1.25)<1e-9),"hairline "+seen.width);
assert.ok([...seen.fill,...seen.stroke].every(c=>/^#(?:([0-9a-f])\1{5}|fffcf8)$/i.test(c)),"neutral canvas inks "+seen.fill+" "+seen.stroke);
seen.width.length=0;V.paint(ctxSeen,boxes,200,"schematic");
assert.ok(seen.width.every(w=>Math.abs(w*200-1.25)<1e-9),"hairline when zoomed in "+seen.width);

// ------------------------------------------------------------ parameter text
assert.deepEqual(V.parseParams("Value = 4.7k\n\n -Supplier \nNote=a=b"),{Value:"4.7k",Supplier:null,Note:"a=b"});
assert.throws(()=>V.parseParams("just text"),/Name = value/);
assert.equal(V.formatParams({Value:"4.7k",Supplier:null}),"Value = 4.7k\n-Supplier");

// ------------------------------------------------------------ integration (after the patches)
const integrated=String(A.validationSteps).includes("AtriumVariants");
if(integrated){
  const broken=A.clone(p);broken.variants[0].parts.x={fitted:"no"};
  assert.throws(()=>A.validate(broken));
  const notList=A.clone(p);notList.variants={};assert.throws(()=>A.validate(notList));
  require("../../app/pcb/pcb-appearance.js");require("../../app/pcb/pcb-pours.js");require("../../app/pcb/stackup.js");require("../../app/formats/fab-outputs.js");
  const F=AtriumFabOutputs,boardId=p.documents[1].id;
  let m=F.analyse(p,boardId);
  assert.ok([...m.dnp].some(i=>i.ref==="U1"),"PnP follows the active variant");
  let pnp=F.pickPlace?F.generate(m,F.plan(m,{date:new Date(0)}),F.plan(m,{date:new Date(0)}).files.find(f=>f.kind==="pnp")).content:"";
  assert.ok(!/\bU1\b/.test(pnp)&&/\bR2\b/.test(pnp));
  m=F.analyse(p,boardId,{variant:"Pro"});
  assert.ok(![...m.dnp].some(i=>i.ref==="U1"));
  const plan=F.plan(F.analyse(p,boardId),{date:new Date(0)}),asm=plan.files.find(f=>f.kind==="assembly");
  const svg=F.generate(F.analyse(p,boardId),plan,asm).content;
  assert.ok(svg.includes("Variant Lite edition")&&svg.includes("#d0281e"),"assembly drawing: variant title and crosses");
  require("../../app/formats/step-export.js");
  const S=AtriumSTEP;
  const names=o=>S.model(p,boardId,o).parts.map(x=>x.ref);
  assert.ok(!names().includes("U1")&&names().includes("R1"),"STEP leaves out not-fitted parts of the active variant");
  assert.ok(names({variant:"Pro"}).includes("U1"));
  assert.ok(names({include:()=>true}).includes("J2"),"a caller's include hook wins");
}
