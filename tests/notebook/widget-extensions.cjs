"use strict";
require("../fixtures/notebook-labs.cjs").enable();
const assert=require("node:assert/strict"),root=__dirname+"/../../extensions/examples/",harness=require(root+"harness.cjs");
for(const m of ["widget-catalogue","sheet-widgets","extension-widgets"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
async function additiveState(h,E,type,p,doc) {
  const files=h.files(root+"widget-inspection"),manifest=JSON.parse(files["waffle-extension.json"]);
  const spec=manifest.contributes.widgets[0],caption={type:"string",maxLength:20,default:""};
  spec.state.checks={type:"list",maxItems:8,fields:{done:{type:"boolean",default:false}}};
  const old=JSON.parse(JSON.stringify(manifest));
  manifest.version="1.1.0";
  spec.state.label=caption;
  spec.state.checks.fields.caption=caption;
  spec.state.notes={type:"list",maxItems:8,fields:{caption}};
  files["main.js"]='exports.activate=api=>{'
    +'api.commands.register("inspection.view",({state})=>({title:"Saved state",rows:[{cells:[{text:JSON.stringify(state)}]}]}));'
    +'api.commands.register("inspection.event",({state,event})=>({state:event.action==="bad" ? {count:-1} :'
    +'event.action==="unknown" ? {count:1,label:"injected"} : event.action==="noop" ? state :'
    +'event.action==="remove" ? {checks:state.checks.slice(1)} :'
    +'{count:state.count+1,checks:state.checks.slice().reverse()}}));};';
  const install=async m=>{
    files["waffle-extension.json"]=JSON.stringify(m);
    await h.X.install(files);
    await h.wait(E.limits.interval+10);
  };
  const item=E.make(type,[0,0]);
  item.widget.state={count:0,checks:[{id:"b",done:true},{id:"a",done:false}]};
  const ctx={revision:1},before=JSON.stringify(item.widget.state);
  const render=async()=>JSON.parse((await E.request(p,doc,item,ctx)).view.rows[0].cells[0].text);
  const act=action=>E.request(p,doc,item,ctx,{type:"activate",action});

  await install(manifest);
  assert.deepEqual(await render(),{count:0,checks:[{id:"b",done:true,caption:""},{id:"a",done:false,caption:""}],label:"",notes:[]});
  assert.equal(JSON.stringify(item.widget.state),before,"render must keep the saved state byte-identical");
  assert.equal(JSON.stringify((await act("noop")).state),before,"echoing a virtual default is a no-op");
  item.widget.state={count:0,label:"bench",checks:[{id:"b",done:true,caption:"second"},{id:"a",done:false,caption:"first"}],
    notes:[{id:"future",caption:"new field"}]};
  const updated=await act("increment");
  assert.deepEqual(updated.state,{count:1,label:"bench",checks:[{id:"a",done:false,caption:"first"},{id:"b",done:true,caption:"second"}],
    notes:[{id:"future",caption:"new field"}]},"an omitted defaulted field keeps its authored value");

  await install(old);
  assert.deepEqual(await render(),{count:0,checks:[{id:"b",done:true},{id:"a",done:false}]},
    "an older worker receives only its declared fields");
  assert.deepEqual((await act("increment")).state,updated.state,"preserve opaque fields by stable row ID across a downgrade");
  const removed=await act("remove");
  assert.deepEqual(removed.state,{...item.widget.state,checks:[item.widget.state.checks[1]]},"removed rows stay removed");
  await assert.rejects(act("unknown"),/invalid state/);
  await assert.rejects(act("bad"),/invalid state/);
  assert.equal(E.stateOK({...item.widget.state,count:-1},old.contributes.widgets[0].state),false);
  assert.equal(E.stateOK({...item.widget.state,checks:[{id:"a",done:true},{id:"a",done:false}]},old.contributes.widgets[0].state),false);
  const full={count:9,checks:[],opaque:[...Array(8).fill("x".repeat(4000)),""]};
  full.opaque[8]="x".repeat(E.limits.bytes-JSON.stringify(full).length);
  assert.equal(E.stateOK(full,old.contributes.widgets[0].state),true);
  item.widget.state=full;
  await assert.rejects(act("increment"),/invalid state/,"merged known and opaque state must still fit the byte limit");
}
async function run(){
  const h=await harness.setup(),E=AtriumExtensionWidgets,W=AtriumSheetWidgets,X=h.X;
  await h.installFolder(root+"widget-inspection");await h.installFolder(root+"widget-rail");
  const [counter,rail]=E.entries().map(e=>e.type);assert.equal(counter,"ext.example.inspection.counter");
  const doc=h.sheet(),p=h.project,ctx={revision:1,fields:{resolve:()=>({text:"3.3 V"})}};
  const a=E.make(counter,[0,0]),r=E.make(rail,[0,0]);
  const out=await E.request(p,doc,a,ctx);assert.equal(out.view.rows[0].cells[0].text,"0 complete");assert(Object.isFrozen(out.view.rows[1].cells));
  assert.equal(await E.request(p,doc,a,ctx),null);
  const changed=await E.request(p,doc,a,ctx,{type:"touch",action:"increment"});assert.equal(changed.state.count,1);assert.equal(a.widget.state.count,0);
  const ra=await E.request(p,doc,r,ctx);assert.equal(ra.view.rows[0].cells[1].text,"3.3 V");
  await X.grant("example.rail","read:project",false);assert(!E.allowed(rail));assert.equal(E.entries().length,1);
  await assert.rejects(E.request(p,doc,r,ctx),/unavailable/);assert.equal(W.view(p,doc,r).fallback.text.includes("Rail specification"),true);
  const files=h.files(root+"widget-inspection"),manifest=JSON.parse(files["waffle-extension.json"]);
  const invalid=(fn)=>{const m=JSON.parse(JSON.stringify(manifest));fn(m);assert.throws(()=>X.validateManifest(m),/widget/i);};
  invalid(m=>m.contributes.widgets[0].render="spice.simulate");invalid(m=>m.contributes.widgets[0].state.count.max=Infinity);
  invalid(m=>m.contributes.widgets[0].size.max=[4000,100]);invalid(m=>m.contributes.widgets[0].fallback={type:"image",assetId:"https://untrusted",alt:"X"});
  const badManifest=JSON.parse(files["waffle-extension.json"].replaceAll("inspection.view","slow.view").replaceAll("inspection.event","slow.event"));badManifest.id="example.slow";files["waffle-extension.json"]=JSON.stringify(badManifest);
  files["main.js"]='exports.activate=api=>api.commands.register("slow.view",async()=>{await new Promise(r=>setTimeout(r,350));return {title:"late",rows:[]};});';
  await X.install(files);const slow=E.make("ext.example.slow.counter",[0,0]);
  const invoke=E.request(p,doc,slow,ctx);const other=await E.request(p,doc,a,ctx,{type:"key",key:"Enter",action:"increment"});assert.equal(other.state.count,1);
  await assert.rejects(invoke,/budget|time limit|stopped/);await h.wait(30);
  assert(!X.workers.some(w=>w.members.includes("example.slow")));assert.equal(h.history.length,0);
  const large=JSON.parse(files["waffle-extension.json"].replaceAll("slow.view","large.view").replaceAll("slow.event","large.event"));large.id="example.large";files["waffle-extension.json"]=JSON.stringify(large);
  files["main.js"]='exports.activate=api=>api.commands.register("large.view",()=>({title:"Large",rows:[{cells:[{text:"A".repeat(32769)}]}]}));';
  await X.install(files);await assert.rejects(E.request(p,doc,E.make("ext.example.large.counter",[0,0]),ctx),/32 KiB/);
  const unicode=JSON.parse(files["waffle-extension.json"].replaceAll("large.view","unicode.view").replaceAll("large.event","unicode.event"));
  unicode.id="example.unicode";files["waffle-extension.json"]=JSON.stringify(unicode);
  files["main.js"]='exports.activate=api=>api.commands.register("unicode.view",()=>({title:"Unicode",rows:Array.from({length:30},()=>({cells:[{text:"電".repeat(400)}]}))}));';
  await X.install(files);await assert.rejects(E.request(p,doc,E.make("ext.example.unicode.counter",[0,0]),ctx),/32 KiB/);
  await additiveState(h,E,counter,p,doc);
  X.shutdown();console.log("widget-extensions: two actual packages, owner and grant checks, bounded output, slow-worker budget and independent interaction passed");
}
globalThis.__testDone=run().catch(e=>{console.error(e.stack || e);globalThis.AtriumExtensions?.shutdown();if(globalThis.process)process.exitCode=1;throw e;});
