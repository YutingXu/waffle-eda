"use strict";
const assert=require("node:assert/strict");
for (const file of ["model","parts","source-file","format-2-codec","format-2-units","format-2-values","format-2-model","sch-objects","hierarchy","undo-store","signals","rules","project-rules","note-fields","calculation-intent",
  "calculation-core","query-fields","calculators","calculation-helpers","calculation-records","calculation-graph","calculation-design","calculations","numeric-fields","command-bar"])
  require(require("../support/app-source-paths.cjs").appFile(file+".js"));
const N=AtriumNumericFields, mm={unit:"mm",storageUnit:"mm",nanometres:true};
async function main() {
  const noScan={get documents(){throw Error("A constant or local input scanned the project");}};
  const evaluate=(s,spec={})=>N.evaluate(s,spec,{project:noScan});
  assert.equal((await evaluate("10mil + 0.1mm",mm)).value,.354);
  const mil=await evaluate("10mil + 0.1mm",{...mm,unit:"mil"});
  assert.equal(mil.display,"13.94 mil"); assert.equal(mil.value,.354);
  assert.equal((await evaluate("0.6 nm",mm)).value,.000001);
  assert.equal((await evaluate("5",{...mm,unit:"mil"})).value,.127);
  assert.equal((await evaluate("2+3",mm)).diagnostic.code,"dimension");
  assert.equal((await evaluate("3.3k in E24")).value,3300);
  assert.equal((await evaluate("3.3kΩ in E24",{unit:"Ω"})).value,3300);
  assert.equal((await evaluate("47 kΩ",{unit:"Ω",textValue:true})).marking,"47 kΩ");
  assert.equal((await evaluate("1 kΩ + 1 kΩ",{unit:"Ω",textValue:true})).marking,undefined);
  assert.equal((await evaluate("抵抗 Ω",{unit:"Ω",textValue:true,allowText:true})).value,"抵抗 Ω");
  assert.equal((await evaluate("1 / 3",{})).value,1/3);
  for(const [source,unit,value,display] of [
    ["2 ea + 3 pcs","ea",5,"5 ea"],["6 ea / 3 ea","",2,"2"],["3 ea * 20 mA","mA",60,"60 mA"],
    ["1.23456789 W","W",1.23456789,"1.235 W"],["250m","W",.25,"0.25 W"],
    ["16.667%","%",16.667,"16.67 %"],["50 ppm/K","ppm/K",50,"50 ppm/K"]]){
    const result=await evaluate(source,{unit});assert.equal(result.value,value);assert.equal(result.display,display);
  }
  const typed=(source,fieldUnit)=>AtriumCalculations.fieldExpression(noScan,{source,fieldUnit}).then(r=>r.result);
  assert.equal((await typed("2 ea + 3 pcs","ea")).tag,"count");
  assert.equal((await typed("6 ea / 3 ea","")).tag,"");
  assert.equal((await typed("2 V / 2 V","ea")).diagnostic.code,"dimension");
  assert.equal((await evaluate("2.5",{integer:true})).diagnostic.code,"range");
  assert.equal((await evaluate("999 mA",{unit:"A",max:.2})).diagnostic.code,"range");
  assert.equal((await evaluate("1 V",mm)).diagnostic.code,"dimension");
  assert.deepEqual((await evaluate("= 1 V",mm)).diagnostic.span,[2,5]);
  assert.equal((await evaluate("10mil +",mm)).ok,false);
  const obj={id:"rect",width:.25,height:.1}, locals=N.geometryLocals(obj,"s");
  assert.equal((await evaluate("2*w",{...mm,locals})).value,.5);
  const target={scope:"item",documentId:"s",itemId:"rect",path:["width"]};
  assert.equal((await evaluate("=2*w",{...mm,locals,target})).diagnostic.code,"cycle");
  const rdef={id:"rdef",name:"Resistor",prefix:"R",symbol:{shapes:[],pins:[]}};
  const p=Atrium.project("Bench",[rdef]), d=p.documents[0]; d.id="s";
  const r={id:"source",kind:"part",ref:"R5",def:"rdef",value:"10k",x:1,y:2};
  const out={...r,id:"out",ref:"R7",value:"1k"};d.items.push(r,out);
  const dst={scope:"item",documentId:d.id,itemId:out.id,path:["value"]};
  const lookup=(text,prior)=>N.evaluate(text,{unit:"Ω",target:dst},{project:p,documentId:d.id,prior});
  r.parameters={Power:"250m"};
  const powerOptions={source:"R5.Power",fieldUnit:"W",documentId:d.id};
  const detail=(fields,opts=powerOptions)=>AtriumCalculations.fieldExpression(p,{...opts,authority:{canReadField:fields}});
  const closed=await detail(k=>k!=="power");
  assert.equal(closed.result.diagnostic.code,"denied");assert.equal(closed.bindings,undefined);assert.equal(closed.watches,undefined);
  const two=await detail(k=>k!=="power",{...powerOptions,source:"R5.Value * R5.Power"});
  assert.deepEqual(two.result.diagnostic.span,[11,19]);
  assert.equal((await detail(()=>true)).result.value,.25);
  assert.equal((await detail(k=>k!=="power")).result.diagnostic.code,"denied");
  let granted=true;
  const revoked=await detail(()=>granted,{...powerOptions,source:"R5.Power * count(part)",countQuery:()=>{
    granted=false;return {count:2,complete:true,status:"complete"};
  }});
  assert.equal(revoked.result.diagnostic.code,"denied");assert.equal(revoked.bindings,undefined);
  const first=await lookup("= R5.Value"); assert.equal(first.value,10000);assert.ok(first.warnings.some(w=>w.includes("tolerance unknown")));
  assert.equal(first.entry.bindings[0].target.itemId,r.id);
  N.remember(p,dst,first.entry);
  const m=AtriumFormat2Model,file=m.createManifest(p,{id:"bench-manifest",entryDocument:d.id});
  const native=m.manifest(m.parse(AtriumFormat2.serialize(file))).project;
  assert.deepEqual(native.numericExpressions,p.numericExpressions);
  r.ref="R8"; r.value="22k";
  assert.equal((await lookup("= R5.Value",first.entry)).value,22000);
  d.items.splice(d.items.indexOf(r),1,{...r,id:"replacement",ref:"R5",value:"330"});
  assert.equal((await lookup("= R5.Value",first.entry)).diagnostic.code,"missing");
  const catalog=Array.from({length:1000},(_,i)=>({...first.entry,target:{...dst,itemId:"row"+i}}));
  const open={get documents(){throw Error("Opening a saved project read document geometry");},numericExpressions:catalog};
  const host={project:()=>open,revision:()=>0,on:()=>{}};
  const state=N.attachHost(host);await Promise.resolve();
  assert.equal(state.records.size,1000);assert.equal(state.pending.size,0);assert.equal(N.stats(host).evaluations,0);
  const board=p.documents.find(doc=>doc.kind==="pcb"), via={id:"v",kind:"via",drill:.25,diameter:.5},track={id:"t",kind:"track",width:.1};
  board.items.push(via,track);
  AtriumProjectRules.edit(p,b=>{b.list.find(r=>r.type==="width").max=.45;});
  const width=p.rules.list.find(r=>r.type==="width");
  const viaDrill={scope:"item",documentId:board.id,itemId:via.id,path:["drill"]};
  const ruleMin={scope:"rule",documentId:board.id,ruleId:width.id,path:["min"]};
  const trackWidth={scope:"item",documentId:board.id,itemId:track.id,path:["width"]};
  const rows=await Promise.all([viaDrill,ruleMin,trackWidth].map(target=>N.evaluate("=.6 mm",{...mm,target},{project:p})));
  const reopened={...p,numericExpressions:JSON.parse(JSON.stringify(rows.map(r=>r.entry)))};
  const derived={project:()=>reopened,revision:()=>1,on:()=>{},derive:fn=>fn()};
  const live=N.attachHost(derived);
  for(const target of [viaDrill,ruleMin,trackWidth])live.inspect(target);
  for(let n=0;n<100 && (live.queued || live.pending.size || live.batch);n++)await Promise.resolve();
  assert.equal(via.drill,.25);assert.equal(reopened.rules.list.find(r=>r.id===width.id).min,.15);
  assert.equal(N.issue(reopened,viaDrill).code,"range");assert.equal(N.issue(reopened,ruleMin).code,"range");
  assert.equal(track.width,.6);
  const row={id:"stable-row",cell:12};out.rows=[row];
  const address={...dst,path:["rows",{id:row.id},"cell"]};
  out.rows.unshift({id:"new",cell:0}); assert.equal(N.locate(p,address).object,row);
  assert.equal(N.locate(p,{...dst,path:["__proto__","x"]}),null);
  N.remember(p,dst,null); assert.ok(!p.numericExpressions);
  const opts={project:p,documentId:d.id,countQuery:()=>({count:3,complete:true,status:"complete"})};
  assert.equal((await N.evaluate("count(part)",{unit:"ea"},opts)).value,3);
  assert.equal((await N.evaluate("count(part)",mm,opts)).diagnostic.code,"dimension");
  assert.equal((await N.evaluate("count(part)",{unit:"ea",readDesign:()=>false},opts)).diagnostic.code,"permission");
  assert.equal((await N.evaluate("count(part)",{unit:"ea"},{...opts,countQuery:()=>({count:0,complete:false})})).diagnostic.code,"query-incomplete");
  assert.equal((await N.evaluate("5 %",{unit:"%"},opts)).value,5);
  assert.ok(Math.abs((await N.evaluate("1 oz/ft²",{unit:"kg/m²"},opts)).value-.305151727273)<1e-7);
  assert.equal((await N.evaluate("50 mW/m/K",{unit:"W/m/K"},opts)).value,.05);
  assert.equal((await N.evaluate("2 ea / 2 ea",mm,opts)).ok,false);
  const unitProject=Atrium.project("Declared units",[rdef]),[unitSheet,unitBoard]=unitProject.documents;
  const resistor={...r,id:"unit-source",ref:"R1",parameters:{Bias:"2"}};
  unitSheet.items.push(resistor);unitProject.parameters={Bias:{value:"1",unit:"mm"}};
  const unitTrack={id:"unit-width",kind:"track",width:2,points:[[0,0],[1,0]],layer:"Top"};
  unitBoard.items.push(unitTrack);
  const widthTarget={scope:"item",documentId:unitBoard.id,itemId:unitTrack.id,path:["width"]};
  const fresh=()=>N.evaluate("=R1.Bias",{...mm,target:widthTarget},{project:unitProject});
  const binding=await fresh();assert.equal(binding.value,2);N.remember(unitProject,widthTarget,binding.entry);
  const U=AtriumUndoStore, undo=[], redo=[];
  U.reset();U.record(unitProject);
  let revision=0;
  const unitsHost={project:()=>unitProject,revision:()=>revision,derive(fn,{touched}){fn();revision++;U.record(unitProject,touched);}};
  const unitsState=N.attachHost(unitsHost);
  const settled=async()=>{for(let n=0;n<100 && (n===0 || unitsState.pending.size || unitsState.batch || unitsState.queued);n++)await Promise.resolve();};
  function edit(fn){const mark=U.mark(unitProject);fn();U.checkpoint(undo,redo,mark);revision++;U.record(unitProject);}
  edit(()=>{unitProject.parameters.Bias.unit="mil";});await settled();
  assert.equal(unitTrack.width,.0508);assert.equal((await fresh()).value,unitTrack.width);
  edit(()=>{resistor.parameters.Bias={value:"2",unit:"mm"};});await settled();
  assert.equal(unitTrack.width,2);assert.equal((await fresh()).value,unitTrack.width);
  edit(()=>{resistor.parameters.Bias="2";});await settled();
  assert.equal(unitTrack.width,.0508);assert.equal((await fresh()).value,unitTrack.width);
  const evaluations=N.stats(unitsHost).evaluations;
  edit(()=>{unitBoard.items.push({id:"unrelated",kind:"track",layer:"Top",width:.15,points:[[1,0],[2,0]]});});await settled();
  assert.equal(N.stats(unitsHost).evaluations,evaluations);
  for(const [direction,value] of [[-1,.0508],[-1,2],[1,.0508]]) {
    U.jump(undo,redo,U.mark(unitProject),direction);revision++;await settled();
    assert.equal((await fresh()).value,value);assert.equal(unitTrack.width,value);
  }
  // A calculation widget can first paint while a second surface is already opening
  // its renderer. Its provisional canvas still needs exactly one invalidation.
  let finish,joins=0,repaints=0;
  const waiting=new Promise(done=>{finish=done;});
  globalThis.AtriumLazy={pending:()=>true,need(){joins++;return waiting;}};
  globalThis.AtriumWidgetCatalogue={paint(_ctx,_item,_o,request){if(!globalThis.AtriumSheetWidgetRuntime)request("AtriumSheetWidgetRuntime");return true;}};
  globalThis.AtriumNavHost={panes:()=>[{docId:"sheet"},{docId:"board"}],docById:id=>({kind:id==="sheet"?"schematic":"pcb"}),
    invalidateDocument(id,artwork){assert.equal(id,"sheet");assert.equal(artwork,true);repaints++;}};
  const widget={id:"table",kind:"textframe",x:0,y:0,w:10,h:5,widget:{type:"table"}};
  AtriumSchObjects.draw({},widget,{scale:1});AtriumSchObjects.draw({},widget,{scale:1});
  assert.equal(joins,1);assert.equal(repaints,0);
  globalThis.AtriumSheetWidgetRuntime={};finish();await Promise.resolve();
  AtriumSchObjects.draw({},widget,{scale:1});assert.equal(repaints,1);assert.equal(joins,1);
  console.log("PASS numeric fields: mixed units, SI grid, dimension errors, full precision, domain limits, local geometry, identity and tolerance.");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
