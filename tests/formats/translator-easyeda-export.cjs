"use strict";
// Reopen the bytes from a real Task 27 import after editing the native model.
// The checks of tilde fields and the Pro owner graph inspect the target documents directly.
const assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path");
for(const n of ["obsolete-project","model","sch-objects","hierarchy","board-shape","board-shape-sources","net-intent","signals","altium-rules","pcb-draw","component-classes","query","rules","project-rules","pcb-pours","stackup","polygon-pour","altium-ids","source-file","pcb-import","sexpr","import-easyeda","import-link","io","import-rules","translator-table","translator-registry","translator-provenance","translator-adapters","translators","zip","export-easyeda","export-easyeda-standard","export-easyeda-pro"])require(require("../support/app-source-paths.cjs").appFile(n+".js"));
const enc=txt=>AtriumZip.utf8(txt), txt=b=>AtriumImportFormats.utf8(b), fixture=n=>({name:n,bytes:new Uint8Array(fs.readFileSync(path.join(__dirname,"../fixtures/import",n)))}),
  open=files=>AtriumTranslators.import(files.map(f=>({name:f.name,bytes:f.bytes || enc(f.text)})),{source_rules:"use"}),
  copy=v=>JSON.parse(JSON.stringify(v)), close=(a,b)=>assert.ok(Math.abs(a-b)<.0002,a+" must equal "+b);
function save(src,options={}) {
  const report=[], out=AtriumEasyEDAExport.export(src.model,{provenance:src.provenance,...options},{add(kind,status,ref,reason,count=1){assert.ok(ref.file && ref.object && count>=1);if(status!=="kept")assert.ok(reason);report.push({kind,status,ref,reason,count});}});
  return {...out,report};
}
const item=(doc,k)=>doc.items.find(i=>i.kind===k);
const board=p=>p.documents.find(d=>d.kind==="pcb"), sheet=p=>p.documents.find(d=>d.kind==="schematic");
function pins(p,d,ref){
  const i=d.items.find(i=>i.kind==="part" && i.ref===ref);
  return Atrium.pins(i,p.library.find(def=>def.id===i.def),d.kind).map(q=>[String(q.number),q.at]).sort((a,b)=>a[0].localeCompare(b[0]));
}
function equalPins(expected,actual){assert.equal(expected.length,actual.length);for(let j=0;j<expected.length;j++){assert.equal(expected[j][0],actual[j][0]);close(expected[j][1][0],actual[j][1][0]);close(expected[j][1][1],actual[j][1][1]);}}
const stdNames=["demo-easyeda-sch.json","demo-easyeda-pcb.json"],sources=stdNames.map(fixture);
const orig=JSON.parse(txt(sources[1].bytes)),arc=orig.shape.find(s=>s.startsWith("ARC~"));assert.ok(arc);
orig.shape.push("FUTURE_VENDOR_SHAPE~future-row");
sources[1].bytes=enc(JSON.stringify(orig));
const standard=open(sources), b=board(standard.model), sch=sheet(standard.model), v=item(b,"via"), moved=b.items.find(i=>i.ref==="J1");
v.x+=1.27;v.drill=.33;v.net="USB_Ω";moved.x+=2.54;moved.angle+=90;
const stroke=item(b,"track");stroke.width=.32;stroke.points[0][1]+=.508;
const w=item(sch,"wire");w.points[0][0]-=.762;
sch.items.find(i=>i.ref==="R1").value="22kΩ";
b.items=b.items.filter(i=>!(i.kind==="label" && i.text==="EASYEDA"));
b.items.push({id:Atrium.id(),kind:"pad",number:"S1",x:-3.81,y:2.54,w:2,h:1,angle:30,layer:"Multi",drill:.3,slotLength:1.2,slotAngle:45,maskExpansion:.0508,pasteExpansion:-.0254,net:"USB_Ω",shape:"rect",plated:false});
const expectedPins=pins(standard.model,b,"J1"), sf=save(standard), a=sf.files.find(f=>f.name===stdNames[1]), pcb=JSON.parse(a.text);
assert.equal(sf.details.edition,"standard");assert.equal(sf.files.length,2);
assert.equal(pcb.head.docType,"3");assert.equal(pcb.canvas,orig.canvas);assert.ok(pcb.shape.includes(arc));
assert.ok(!pcb.shape.some(s=>s.includes("FUTURE_VENDOR_SHAPE") || s.includes("EASYEDA~")));
assert.ok(!sf.report.some(q=>/flexBuild|stiffener|bendCrossing|annularRing/.test(q.kind)),"implicit migration defaults are absent from the report");
assert.ok(sf.report.some(q=>q.status==="dropped" && /FUTURE_VENDOR_SHAPE/.test(q.reason)));
assert.ok(sf.report.some(q=>q.status==="kept" && q.reason?.includes("Original EasyEDA primitive")));
close(pcb.DRCRULE.Default.viaHoleD*.254,.3048);
const via=pcb.shape.find(s=>s.startsWith("VIA~")).split("~"),origin=pcb.canvas.split("~").slice(16,18).map(Number);
close((via[1]-origin[0])*.254,v.x);close((via[2]-origin[1])*.254,v.y);close(+via[5]*2*.254,.33);assert.equal(via[4],"USB_Ω");
const rawSheet=JSON.parse(sf.files.find(f=>f.name===stdNames[0]).text);
assert.ok(rawSheet.shape.some(t=>t.includes("22kΩ") && t.includes("#@$P~")));
const sb=open(sf.files).model,reloaded=board(sb);Atrium.validate(sb);
equalPins(expectedPins,pins(sb,reloaded,"J1"));close(item(reloaded,"track").width,.32);close(item(sheet(sb),"wire").points[0][0],w.points[0][0]);
const slot=reloaded.items.find(i=>i.number==="S1");close(slot.slotLength,1.2);close(slot.slotAngle,45);close(slot.maskExpansion,.0508);close(slot.pasteExpansion,-.0254);assert.equal(slot.plated,false);
const zipped=AtriumZip.create(sf.files.map(f=>({name:f.name,data:f.text})));
const zipIn=AtriumImportFormats.readSet([{name:"board-easyeda.zip",bytes:zipped}],{formatFor:()=>"easyeda"})[0];
assert.equal(zipIn.documents.length,2);assert.equal(zipIn.documents.find(d=>d.kind==="pcb").items.length,reloaded.items.length);
const tampered={...standard.provenance,files:standard.provenance.files.map(f=>({...f,sha256:"f".repeat(64)}))};
const regenerated=save(standard,{provenance:tampered});
assert.ok(!regenerated.report.some(q=>q.reason?.includes("Original EasyEDA primitive")));
close(item(board(open(regenerated.files).model),"via").x,v.x);
assert.equal(save(standard,{scope:"document",documentId:b.id}).files.length,1);
assert.throws(()=>save(standard,{scope:"document",documentId:"missing"}),/Choose/);
assert.throws(()=>save(standard,{edition:"other"}),/Standard or Pro/);
assert.throws(()=>save(standard,{signal:{aborted:true}}),/cancelled/);
let checks=0;assert.throws(()=>save(standard,{signal:{get aborted(){return ++checks>6;}}}),/cancelled/);
console.log("PASS edited Standard PCB/schematic, pin positions, origin/drill/slot/rule units, retained original, deleted feature, source loss, source authentication, scoped output, project ZIP and cancellation");

function proGraph(bytes) {
  const files=AtriumImportFormats.unzip(bytes), manifest=JSON.parse(txt(files.get("project.json")));
  const rows=n=>txt(files.get(n)).trim().split(/\r?\n/).map(s=>JSON.parse(s));
  for(const [id,s] of Object.entries(manifest.schematics))for(const page of s.sheets)assert.equal(rows("SHEET/"+id+"/"+page.id+".esch")[0][1],"SCH");
  for(const id of Object.keys(manifest.pcbs))assert.equal(rows("PCB/"+id+".epcb")[0][1],"PCB");
  for(const [id,d] of Object.entries(manifest.devices)){assert.ok(id);if(d.attributes.Symbol)assert.ok(files.has("SYMBOL/"+d.attributes.Symbol+".esym"));if(d.attributes.Footprint)assert.ok(files.has("FOOTPRINT/"+d.attributes.Footprint+".efoo"));}
  for(const bd of Object.values(manifest.boards)){if(bd.schematic)assert.ok(manifest.schematics[bd.schematic]);if(bd.pcb)assert.ok(manifest.pcbs[bd.pcb]);}
  const boardFiles=[...files.keys()].filter(n=>n.endsWith(".epcb")).map(rows),sheetFiles=[...files.keys()].filter(n=>n.endsWith(".esch")).map(rows);
  for(const b of boardFiles){
    const placed=new Set(b.filter(r=>r[0]==="COMPONENT").map(r=>r[1])), footprints=new Map(b.filter(r=>r[0]==="ATTR" && r[7]==="Footprint").map(r=>[r[3],r[8]])),nets=new Set(b.filter(r=>r[0]==="NET").map(r=>r[1]));
    for(const r of b.filter(r=>r[0]==="PAD_NET")){assert.ok(placed.has(r[1]) && nets.has(r[3]));const lands=rows("FOOTPRINT/"+footprints.get(r[1])+".efoo");assert.ok(lands.some(p=>p[0]==="PAD" && p[1]===r[4] && p[5]===r[2]));}
  }
  return {manifest,boardFiles,sheetFiles,files,rows};
}
const pro=open([fixture("demo-easyeda.epro")]), pb=board(pro.model), ps=sheet(pro.model), pv=item(pb,"via"), placement=item(pb,"part"), sym=item(ps,"part"), track=item(pb,"track");
pv.y+=2.54;pv.diameter+=.127;pv.net="RADIO_Ω";placement.x-=3.81;placement.layer="Bottom";placement.angle=-90;placement.pinNets["1"]="EDITED";
sym.mirror=true;sym.angle=90;sym.value="changed Ω";sym.parameters={Tolerance:"2%"};sym.showValue=false;
track.width=.305;track.points[1][0]+=.127;
const pw=item(ps,"wire");pw.points[0][0]+=1.27;pw.net="CONNECT_1";
ps.items.push({id:Atrium.id(),kind:"netlabel",x:pw.points[0][0],y:pw.points[0][1],text:pw.net});
ps.items.push({id:Atrium.id(),kind:"bus",points:[[5.08,-2.54],[10.16,-2.54]],net:"A[0..3]"});
ps.items.push({id:Atrium.id(),kind:"label",x:-5.08,y:5.08,text:"Edited 電",size:1.778});
const pexp=save(pro), graph=proGraph(pexp.files[0].bytes);
assert.equal(pexp.files.length,1);assert.equal(pexp.details.edition,"pro");assert.ok(pexp.files[0].name.endsWith(".epro"));
const rawP=graph.boardFiles[0].find(r=>r[0]==="COMPONENT"), devP=graph.boardFiles[0].find(r=>r[0]==="ATTR" && r[3]===rawP[1] && r[7]==="Device");
const rawS=graph.sheetFiles[0].find(r=>r[0]==="ATTR" && r[3]==="Designator" && r[4]===placement.ref)[2];
const sAttrs=Object.fromEntries(graph.sheetFiles[0].filter(r=>r[0]==="ATTR" && r[2]===rawS).map(r=>[r[3],r[4]]));
assert.equal(devP[8],sAttrs.Device);assert.equal(rawP[7]["Unique ID"],sAttrs["Unique ID"]);
const gate=graph.sheetFiles[0].find(r=>r[0]==="COMPONENT" && r[1]===rawS)[2];
assert.ok(graph.rows("SYMBOL/"+sAttrs.Symbol+".esym").some(r=>r[0]==="PART" && r[1]===gate));
const rawVia=graph.boardFiles[0].find(r=>r[0]==="VIA" && r[3]===pv.net);
close(rawVia[5]*.0254,pv.x);close(-rawVia[6]*.0254,pv.y);close(rawVia[8]*.0254,pv.diameter);
assert.ok(graph.sheetFiles[0].some(r=>r[0]==="WIRE" && r[2][0][0]===pw.points[0][0]/.254));
const pr=open(pexp.files).model;Atrium.validate(pr);
const revivedB=board(pr),revivedS=sheet(pr),rp=revivedB.items.find(i=>i.ref===placement.ref),rs=revivedS.items.find(i=>i.ref===sym.ref);
assert.equal(rp.layer,"Bottom");assert.equal(rp.pinNets["1"],"EDITED");assert.equal(rs.value,"changed Ω");assert.equal(rs.parameters.Tolerance,"2%");assert.equal(rs.showValue,false);
equalPins(pins(pro.model,pb,placement.ref),pins(pr,revivedB,placement.ref));equalPins(pins(pro.model,ps,sym.ref),pins(pr,revivedS,sym.ref));
assert.ok(revivedS.items.some(i=>i.kind==="netlabel" && i.text===pw.net));assert.ok(revivedS.items.some(i=>i.kind==="bus" && i.net==="A[0..3]"));assert.ok(revivedS.items.some(i=>i.kind==="label" && i.text==="Edited 電"));
const mixed=copy(standard.model);
mixed.documents.push(copy(ps));
const legacy=AtriumTranslatorProvenance.toLegacy(mixed,[standard.provenance,pro.provenance]);
legacy.documents.at(-1).sourceEncoding="easyeda-pro";legacy.documents[0].sourceEncoding="easyeda-standard";
assert.throws(()=>save({model:legacy}),/both editions/);
const converted=save({model:legacy},{edition:"standard"});assert.equal(converted.report.filter(x=>x.kind==="EasyEDA document edition" && x.status==="approximated").length,1);
const cross=save(standard,{scope:"document",documentId:b.id,edition:"pro"}), editedSlot=board(open(cross.files).model).items.find(i=>i.number==="S1");
close(editedSlot.slotLength,1.2);close(editedSlot.slotAngle,45);close(editedSlot.maskExpansion,.0508);close(editedSlot.pasteExpansion,-.0254);assert.equal(editedSlot.plated,false);
const native=copy(standard.model);assert.equal(save({model:native},{edition:"pro",scope:"documents"}).files.length,2);
const one=save(pro,{scope:"document",documentId:ps.id}),selfContained=proGraph(one.files[0].bytes);assert.equal(selfContained.boardFiles.length,0);assert.equal(selfContained.sheetFiles.length,1);
assert.ok(Object.keys(selfContained.manifest.symbols).length>0);
console.log("PASS edited Pro project and selected sheet, package owners, linked devices and footprint-pad-net references, mil/inch axes, named wires/buses, Unicode, mirrored symbol pins and bottom footprints");

async function usedRulesInFirstSave() {
  for(const n of ["i18n","i18n-core","import-export","design-query-record","format-2-codec","format-2-units","format-2-values","format-2-model","import-sidecars"])require(require("../support/app-source-paths.cjs").appFile(n+".js"));
  const cleanup=require("../support/import-worker.cjs")({client:true});
  const C=AtriumTranslatorClient, E=AtriumImportExport, M=AtriumFormat2Model;
  const prepare=(src,edition="standard",provenance=src.provenance)=>E.prepare({format:"easyeda",edition,project:src.model,provenance});
  const features=plan=>plan.report.kinds.filter(k=>k.kind.startsWith("Board rule "));
  const table=plan=>JSON.parse(plan.files[0].text).DRCRULE?.Default || {};
  function projected(src){
    const storage=M.fromEditor(src.model),project=M.manifest(storage.manifest).project;
    for(const {file} of storage.files){
      const read=M.parse(AtriumFormat2.serialize(file));
      if(read.header.kind==="library")project.library.push(M.library(read));
      if(["schematic","pcb"].includes(read.header.kind))project.documents.push(M.document(read));
    }
    return {...src,model:project};
  }
  try{
    const source={name:"one-board.json",bytes:enc(JSON.stringify({head:{docType:"3"},shape:[],DRCRULE:{Default:{clearance:.2/.254}}}))};
    const src=await C.import([source]), rules=src.provenance.classRuleDefaults[0].rules;
    assert.deepEqual(Array.from(rules).filter(r=>r.explicit).map(r=>r.type),["clearance"]);
    const observations=src.provenance.classRuleDefaults;
    const old={...src.provenance,classRuleDefaults:[]};
    const thin={...src.provenance,files:src.provenance.files.map(f=>({...f,bytes:undefined}))};
    // This test transport passes VM values directly. Recreate the host-side structured clone.
    const hostProvenance=copy(src.provenance);
    hostProvenance.files.forEach((f,i)=>{f.bytes=new Uint8Array(src.provenance.files[i].bytes);});
    const entry={scopeId:"easyeda-rule-check",adopted:true,names:[source.name],documents:Array.from(src.model.documents,d=>d.id),report:copy(src.report),provenance:hostProvenance};
    const sidecars=await AtriumImportSidecars.prepare([entry]),ref=sidecars.refs[0];
    const restored=AtriumImportSidecars.restore(AtriumImportSidecars.parse(sidecars.files.get(ref.path),ref)).provenance;
    assert.deepEqual(copy(restored.classRuleDefaults),copy(observations));
    const reopened=projected(src);
    const importedClearance=reopened.model.rules.list.find(r=>r.type==="clearance");
    assert.ok(AtriumUUID.isV7(importedClearance.id));
    assert.deepEqual(copy(importedClearance.origin),{kind:"default",key:"clearance-1"});
    const importedWidth=reopened.model.rules.list.find(r=>r.type==="width");
    assert.equal(importedWidth.scope.source,"object");close(importedWidth.min,.25);
    assert.equal(importedWidth.max,null,"the imported minimum leaves the maximum unset");
    for(const evidence of [src.provenance,old,thin,restored]){
      const only=await prepare(reopened,"standard",evidence), rows=features(only);
      assert.deepEqual(Object.keys(table(only)),["clearance"]);close(table(only).clearance*.254,.2);
      assert.deepEqual(Array.from(rows,r=>[r.kind,r.kept,r.approximated,r.dropped]),[["Board rule clearance",1,0,0]]);
      const intoPro=await prepare(reopened,"pro",evidence);
      assert.equal(intoPro.report.kinds.find(k=>k.kind==="Board design rules").dropped,1);
    }
    const all=await C.import([fixture("demo-easyeda-pcb.json")]),real=await prepare(all);
    assert.deepEqual(Object.keys(table(real)).sort(),["clearance","trackWidth","viaHoleD"]);
    assert.equal(features(real).reduce((n,r)=>n+r.kept,0),3);assert.ok(features(real).every(r=>r.dropped===0));
    const authored=projected(src),width=authored.model.rules.list.find(r=>r.type==="width");
    width.min=.15; // A deliberate edit back to the native stock value, distinct from inherited .25.
    const emitted=await prepare(authored);
    assert.deepEqual(Object.keys(table(emitted)).sort(),["clearance","trackWidth"]);close(table(emitted).trackWidth*.254,.15);
    const limited=projected(src), bounded=limited.model.rules.list.find(r=>r.type==="width");
    bounded.min=.31;bounded.max=.45;
    const savedLimit=projected(limited), limitedPlan=await prepare(savedLimit);
    close(savedLimit.model.rules.list.find(r=>r.type==="width").max,.45);
    close(table(limitedPlan).trackWidth*.254,.31);
    assert.equal(features(limitedPlan).find(k=>k.kind==="Board rule width").approximated,1,"Standard loses an authored maximum even though the minimum is written");
    const limitedRoundTrip=await C.import(limitedPlan.files.map(f=>({name:f.name,bytes:enc(f.text)})));
    const widthRoundTrip=limitedRoundTrip.model.rules.list.find(r=>r.type==="width");
    close(widthRoundTrip.min,.31);assert.equal(widthRoundTrip.max,null);
    const rename=projected(src),alias=rename.model.rules.list.find(r=>r.type==="width");
    alias.id="board-width-authored";alias.name="Prototype width";
    const aliased=await prepare(rename);
    close(table(aliased).trackWidth*.254,.25);assert.equal(features(aliased).find(k=>k.kind==="Board rule width").approximated,1);
    const disabled=projected(src),switchedOff=disabled.model.rules.list.find(r=>r.type==="width");
    switchedOff.enabled=false;switchedOff.name="Disabled evaluated width";
    const disabledPlan=await prepare(disabled);assert.equal(features(disabledPlan).find(k=>k.kind==="Board rule width").dropped,1);
    assert.ok(!Object.hasOwn(table(disabledPlan),"trackWidth"));
    const additional=projected(src),native=additional.model.rules.list.find(r=>r.type==="width");
    additional.model.rules.list.push({...native,id:"explicit-identical",name:"Equal stock but explicit",priority:2,min:.15});
    const shadowed=await prepare(additional);
    assert.equal(features(shadowed).find(k=>k.kind==="Board rule width").dropped,1);
    assert.ok(!Object.hasOwn(table(shadowed),"trackWidth"),"a shadowed rule must not replace the effective width");
    const noRules=await C.import([{...source,bytes:enc(JSON.stringify({head:{docType:"3"},shape:[],DRCRULE:{Default:{}}}))}]);
    assert.deepEqual(Object.keys(table(await prepare(noRules))),[]);
    assert.equal((await prepare(noRules,"pro")).report.kinds.some(k=>k.kind==="Board design rules"),false);
    assert.equal(observations,src.provenance.classRuleDefaults);
    console.log("PASS actual first Save counts only sourced or authored EasyEDA rule dimensions, using typed scopes, historical source and native storage reopens");
  }finally{C.cancel();cleanup();}
}
usedRulesInFirstSave().catch(error=>{console.error(error);process.exitCode=1;});
