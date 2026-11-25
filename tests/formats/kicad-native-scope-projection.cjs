"use strict";
const assert=require("node:assert/strict");
for(const name of ["model","design-query-record","signals","component-classes","rules","project-rules","kicad-export"])
  require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const Q=AtriumDesignQueryRecord, p=Atrium.project("Custom scopes",[]), doc=p.documents.find(d=>d.kind==="pcb");
const nets=["GND","SIG","AUX","BATT","VIO"];
doc.items=nets.map((net,y)=>({id:net,kind:"track",layer:"Top",width:.2,net,points:[[0,y],[1,y]]}));
const widths=AtriumRules.create().list.find(r=>r.type==="width"), gaps=AtriumRules.create().list.find(r=>r.type==="clearance");
const width=(id,priority,scope,preferred)=>({...widths,id,name:id,priority,scope,min:preferred,preferred,max:1});
const quoted=Q.selector("net","BATT").source, start=quoted.indexOf('"');
p.rules={format:"atrium-rules",version:3,units:"mm",list:[
  width("WithoutPower",1,Q.create('object where not in component class "Power"'),.81),
  width("SigOrAux",2,Q.create('object where net.name = "SIG" or net.name = "AUX"'),.72),
  width("BoundBattery",3,Q.create(quoted,[{id:"battery",name:"BATT",span:[start,quoted.length],target:{scope:"signal",signalId:"bat"}}]),.63),
  width("LowerLayer",4,Q.selector("layer","Bottom"),.54),
  width("ExactNet",5,Q.selector("net","VIO"),.45),
  width("Default",6,Q.selector("all"),.25),
  {...gaps,id:"PairOnly",name:"PairOnly",priority:1,scope:Q.selector("net","GND"),scope2:Q.selector("net","GND"),gap:.88},
  {...gaps,id:"AnyPair",name:"AnyPair",priority:2,gap:.2}
]};
const output=AtriumKiCad.exportBoard(p,doc), seen=[];
AtriumKiCad.designRules(doc,p,nets,p.name,{observed:(d,r,kind,status)=>{if(kind==="Design rule")seen.push([r.id,status]);}});
const file=ext=>output.files.find(f=>f.name.endsWith(ext)).content;
const rules=file(".kicad_dru"), pro=JSON.parse(file(".kicad_pro"));
for(const id of ["WithoutPower","SigOrAux","BoundBattery"]){
  assert.equal(rules.includes('(rule "'+id+'"'),false);
  assert.ok(seen.some(([rule,status])=>rule===id&&status==="dropped"),id);
}
for(const id of ["ExactNet","LowerLayer","PairOnly"])assert.ok(rules.includes('(rule "'+id+'"'),id);
const classes=pro.net_settings.classes;
assert.equal(classes.find(c=>c.name==="Default").track_width,.25);
assert.equal(classes.find(c=>c.name==="Default").clearance,.2);
const vio=classes.find(c=>c.nets?.includes("VIO"));assert.deepEqual(vio.nets,["VIO"]);assert.equal(vio.track_width,.45);
assert.equal(classes.length,2,"a dropped, layer-specific or two-sided custom rule cannot change a net-wide default");
console.log("KiCad custom, layer and two-sided scopes affect only their representable output; exact net classes keep their routing sizes.");
