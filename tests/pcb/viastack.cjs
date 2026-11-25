"use strict";
// Via stacks (AtriumViaStack): per-layer lands, solder mask by IPC-4761 type,
// drill spans with back-drill, validation and via templates.
const assert=require("node:assert/strict");
for(const m of ["model","stackup","rules","viastack"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const V=AtriumViaStack,S=AtriumStackup;
const close=(a,b,m)=>assert.ok(Math.abs(a-b)<1e-6,(m||"")+" "+a+" differs from "+b);
const board=(items,extra={})=>({kind:"pcb",name:"T",id:"b",grid:1,items,notes:[],outline:[[0,0],[50,0],[50,40],[0,40]],...extra});
const six=board([],{stackup:{version:1,layers:S.preset("6").layers}});
const keys=S.copperLayers(six);
assert.deepEqual(keys,["Top","Inner 1","Inner 2","Inner 3","Inner 4","Bottom"]);

// ---- legacy via: nothing changes ------------------------------------------------
const plainVia={kind:"via",id:"v",x:0,y:0,diameter:.6,drill:.3,layer:"Multi",net:"A"};
for(const k of keys)assert.equal(V.diameterOn(plainVia,k),.6);
assert.equal(V.display(plainVia,"Inner 2"),plainVia,"simple vias are drawn as they are");
assert.deepEqual(V.drillSpans(plainVia,six).map(s=>[s.role,s.kind,s.from,s.to]),[["plated","through","Top","Bottom"]]);
assert.equal(V.maskOpening(plainVia,"top",.05).open,null,"no tent setting follows the output default");
close(V.maskOpening(plainVia,"top",.05).diameter,.7);

// ---- per-layer diameters --------------------------------------------------------
const tmb={...plainVia,stackMode:"tmb",padStack:{Top:{diameter:.7},Mid:{diameter:.5},Bottom:{diameter:.65}}};
assert.deepEqual(keys.map(k=>V.diameterOn(tmb,k)),[.7,.5,.5,.5,.5,.65]);
assert.equal(V.display(tmb,"Inner 3").diameter,.5);
V.sync(tmb,keys);assert.equal(tmb.diameter,.7,"via.diameter tracks the largest land");
// T-M-B follows the via span: a blind via's "Top" row is its first layer.
const blind={...tmb,fromLayer:"Inner 1",toLayer:"Bottom",padStack:{Top:{diameter:.55},Mid:{diameter:.45},Bottom:{diameter:.6}}};
assert.deepEqual(keys.map(k=>V.diameterOn(blind,k)),[0,.55,.45,.45,.45,.6]);
// Full stack, with a fallback for missing rows.
const full={...plainVia,stackMode:"full",padStack:{Top:{diameter:.8,shape:"rect"},"Inner 2":{diameter:.45}}};
assert.deepEqual(keys.map(k=>V.diameterOn(full,k)),[.8,.6,.45,.6,.6,.6]);
assert.equal(V.padOn(full,"Top").shape,"rect");
// Switching modes seeds the rows from the current lands and keeps them.
const m={...plainVia};V.setMode(m,"full",keys);
assert.deepEqual(Object.keys(m.padStack),keys);m.padStack["Inner 1"].diameter=.4;V.sync(m,keys);
V.setMode(m,"tmb",keys);assert.deepEqual([m.padStack.Top.diameter,m.padStack.Mid.diameter,m.padStack.Bottom.diameter],[.6,.4,.6]);
V.setMode(m,"simple",keys);assert.equal(m.padStack,undefined);assert.equal(m.diameter,.6);
close(V.minDiameter(tmb,keys),.5);

// ---- solder mask by IPC-4761 type ----------------------------------------------
const ipc=(t,extra={})=>({...plainVia,ipc4761:t,...extra});
const openOf=(v,side)=>V.maskOpening(v,side,.05).open;
assert.deepEqual(["top","bottom"].map(s=>openOf(ipc("I"),s)),[false,false],"Type I-b tents both sides");
assert.deepEqual(["top","bottom"].map(s=>openOf(ipc("I",{ipcSides:"top"}),s)),[false,true],"Type I-a tents one side");
assert.deepEqual(["top","bottom"].map(s=>openOf(ipc("II",{ipcSides:"bottom"}),s)),[true,false]);
assert.deepEqual(["top","bottom"].map(s=>openOf(ipc("III"),s)),[true,true],"plugged without covering is open");
assert.deepEqual(["top","bottom"].map(s=>openOf(ipc("IV"),s)),[false,false]);
assert.deepEqual(["top","bottom"].map(s=>openOf(ipc("V"),s)),[true,true]);
assert.deepEqual(["top","bottom"].map(s=>openOf(ipc("VI",{ipcSides:"top"}),s)),[false,true]);
assert.deepEqual(["top","bottom"].map(s=>openOf(ipc("VII"),s)),[true,true],"filled and capped lands stay open");
assert.equal(openOf(ipc("VII",{tent:{top:true}}),"top"),false,"an explicit tent covers a capped via");
assert.equal(openOf(ipc("I",{tent:{top:false}}),"top"),false,"covering types win over an open request");
assert.equal(V.maskOpening(ipc("I"),"top",.05).diameter,0);
assert.deepEqual(["top","bottom"].map(s=>openOf({...plainVia,tent:{top:true,bottom:false}},s)),[false,true]);
assert.equal(V.maskOpening(plainVia,"top",{tentDefault:true}).open,false);
assert.equal(V.ipcCode(ipc("I",{ipcSides:"top"})),"Ia");assert.equal(V.ipcCode(ipc("IV")),"IVb");assert.equal(V.ipcCode(ipc("VII")),"VII");
assert.equal(V.implications(ipc("VII")).viaInPadOk,true);assert.equal(V.implications(ipc("I")).viaInPadOk,false);
assert.equal(V.implications(ipc("V")).fillFile,true);assert.equal(V.implications(ipc("V")).x2,"ViaDrill,V");
// Expansion: number, via override, rules.
const rules=AtriumRules.create();rules.list.find(r=>r.type==="solderMask").expansion=.075;
close(V.maskOpening(plainVia,"top",rules).diameter,.75);
close(V.maskOpening({...plainVia,maskExpansion:0},"top",rules).diameter,.6);
// Mask uses the outer land of a T-M-B via; a buried via has no mask opening.
close(V.maskOpening(tmb,"bottom",0).diameter,.65);
assert.equal(V.maskOpening({...plainVia,fromLayer:"Inner 1",toLayer:"Inner 2"},"top",0).diameter,0);

// ---- drill spans and back-drill ------------------------------------------------
const bd={...plainVia,backdrill:{from:"bottom",toLayer:"Inner 2",stubMax:.1,diameter:.5}};
assert.deepEqual(keys.map(k=>V.diameterOn(bd,k)),[.6,.6,.6,0,0,0],"layers beyond the stop layer are cut off");
let spans=V.drillSpans(bd,six);
assert.deepEqual(spans.map(s=>[s.role,s.side,s.from,s.to,s.stopLayer,s.drill]),[["plated",undefined,"Top","Bottom",undefined,.3],["backdrill","bottom","Inner 3","Bottom","Inner 2",.5]]);
spans=V.drillSpans({...plainVia,backdrill:{from:"top",toLayer:"Inner 3"}},six);
assert.deepEqual(spans[1].from+"/"+spans[1].to+"/"+spans[1].drill+"/"+spans[1].stubMax,"Top/Inner 2/0.5/0.2","default tool is drill + 0.2 mm and stub 0.2 mm");
assert.equal(V.drillSpans({...plainVia,backdrill:{from:"top",toLayer:"Top"}},six).length,1,"nothing to remove");
const meas=V.measure(bd,six);
const p=V.physical(six),in2=p.copper.get("Inner 2"),total=p.total;
close(meas.backdrill.end,in2.z+in2.t+.1);const bot=p.copper.get("Bottom");close(meas.backdrill.depth,bot.z+bot.t-(in2.z+in2.t+.1),"depth from the bottom copper");assert.ok(total>bot.z+bot.t);
assert.equal(meas.backdrill.severs,true);
// A stub limit larger than the gap to the next layer leaves it connected.
const deep=V.validate({...bd,backdrill:{...bd.backdrill,stubMax:2}},six);
assert.ok(deep.messages.some(x=>x.code==="backdrill"&&x.level==="error"&&/leaves layer Inner 3/.test(x.text)),JSON.stringify(deep.messages));
// Back-drilling a blind via from the side it does not reach is refused.
assert.ok(V.validate({...plainVia,fromLayer:"Top",toLayer:"Inner 2",backdrill:{from:"bottom",toLayer:"Inner 1"}},six).messages.some(x=>x.code==="backdrill"&&x.level==="error"));
// Microvias: laser, one dielectric.
const uvia={...plainVia,diameter:.25,drill:.1,fromLayer:"Top",toLayer:"Inner 1"};
assert.equal(V.drillSpans(uvia,six)[0].kind,"microvia");assert.equal(V.drillSpans(uvia,six)[0].laser,true);
assert.equal(V.drillSpans({...uvia,drill:.2},six)[0].kind,"blind","a 0.2 mm blind via is mechanically drilled");
assert.equal(V.drillSpans({...uvia,drill:.2,microvia:true},six)[0].kind,"microvia");
const longMicro=V.validate({...uvia,toLayer:"Inner 2",microvia:true},six);
assert.ok(longMicro.messages.some(x=>x.code==="microvia-span"));

// ---- validation: per-layer annular ring and aspect ratio ------------------------
let r=V.validate(tmb,six,{annularRing:.15});
assert.deepEqual(r.messages.filter(x=>x.code==="ring").map(x=>x.layer),["Inner 1","Inner 2","Inner 3","Inner 4"],"0.1 mm inner rings are below 0.15");
assert.ok(r.rings.find(x=>x.layer==="Top").ring===.2);
const thick=V.measure(plainVia,six).depth;
r=V.validate({...plainVia,drill:.15,diameter:.45},six,{maxAspect:8});
close(r.aspect,thick/.15);assert.ok(r.messages.some(x=>x.code==="aspect"),"1.6 mm / 0.15 mm exceeds 8:1");
assert.ok(!V.validate({...plainVia},six,{maxAspect:8}).messages.some(x=>x.code==="aspect"));
r=V.validate({...uvia,drill:.125},six);
close(r.aspect,.12/.125,"microvia aspect is dielectric over drill");
assert.ok(!r.messages.some(x=>x.code==="aspect"),"0.12 mm prepreg over 0.125 mm is within 1:1 ("+r.aspect+")");
assert.ok(V.validate(uvia,six).messages.some(x=>x.code==="aspect"),"0.12 mm prepreg over 0.1 mm exceeds 1:1");
// Rule lookup for the annular ring minimum.
const ringRules=AtriumRules.create();ringRules.list.find(x=>x.type==="annularRing").min=.12;
assert.ok(V.validate(tmb,six,{rules:ringRules}).messages.some(x=>x.code==="ring"&&x.layer==="Inner 2"));
// Profile capabilities.
const prof={name:"Shop",maxAspect:10,microviaAspect:1,blind:false,buried:false,microvia:false,viaInPad:false,viaDrill:.2};
assert.ok(V.validate(uvia,six,{profile:prof}).messages.some(x=>x.code==="capability"));
assert.ok(V.validate({...plainVia,viaInPad:true},six,{profile:prof}).messages.some(x=>x.code==="via-in-pad"));
assert.ok(!V.validate({...plainVia,viaInPad:true,ipc4761:"VII"},six,{profile:{...prof,viaInPad:true}}).messages.some(x=>x.level!=="info"));
// Board check returns DRC-like rows.
const checked=V.check(board([tmb,{...plainVia,id:"ok"}],{stackup:six.stackup}),new Map(),{annularRing:.15});
assert.ok(checked.length===4&&checked.every(x=>x.id==="v"&&x.mode==="tmb"));

// ---- templates -----------------------------------------------------------------
const doc=board([],{stackup:six.stackup});
assert.equal(V.templates(doc).length,V.BUILTIN.length,"stock templates are always listed");
assert.deepEqual(V.BUILTIN.map(t=>t.name),["0.3/0.15 Tented","0.45/0.2 Through","Blind 1-2 µvia 0.25/0.1","VIP 0.35/0.2 Filled+Capped"]);
const t=V.addTemplate(doc,{name:"Fat BGA",diameter:.5,drill:.25,stackMode:"tmb",padStack:{Top:{diameter:.5},Mid:{diameter:.4},Bottom:{diameter:.5}},ipc4761:"IV",ipcSides:"both",backdrill:{from:"bottom",toLayer:"Inner 2",stubMax:.15}});
assert.equal(V.find(doc,t.id).name,"Fat BGA");
const dup=V.duplicateTemplate(doc,t.id);assert.equal(dup.name,"Fat BGA copy");assert.notEqual(dup.id,t.id);
V.updateTemplate(doc,dup.id,{drill:.2});assert.equal(V.find(doc,dup.id).drill,.2);
assert.throws(()=>V.updateTemplate(doc,dup.id,{drill:.6}),/smaller than the diameter/);
// Applying a template copies the construction, not position or net.
const target={kind:"via",id:"x",x:3,y:4,diameter:.6,drill:.3,layer:"Multi",net:"N",tent:{top:false}};
V.applyTemplate(target,V.find(doc,t.id));
assert.deepEqual([target.x,target.y,target.net,target.id,target.template,target.stackMode,target.ipc4761,target.tent],[3,4,"N","x",t.id,"tmb","IV",undefined]);
assert.deepEqual(keys.map(k=>V.diameterOn(target,k)),[.5,.4,.4,0,0,0]);
// Round trip: via -> template -> export -> import -> via.
const back=V.fromVia(target,{name:"Round trip"});
const text=JSON.stringify({format:"atrium-via-templates",version:1,list:[back],defaults:{via:back.id,diffPair:null,netClasses:{}}});
const other=board([]);V.importLibrary(other,text,"replace");
const again={kind:"via",id:"y",x:0,y:0,diameter:1,drill:.5,layer:"Multi",net:""};
V.applyTemplate(again,V.find(other,back.id));
for(const k of ["diameter","drill","stackMode","padStack","ipc4761","ipcSides","backdrill"])assert.deepEqual(again[k],target[k],k);
assert.equal(V.library(other).defaults.via,back.id);
assert.equal(JSON.parse(V.exportLibrary(other)).list[0].name,"Round trip");
// Defaults: board default, diff pair and net class.
const pairRules=AtriumRules.create();pairRules.diffPairs=[{name:"USB",positive:"D+",negative:"D-"}];pairRules.netClasses={Power:["VCC"]};
doc.rules=AtriumRules.normalize(pairRules);
V.setDefault(doc,"via","stock-045-020-through");V.setDefault(doc,"diffPair","stock-030-015-tented");V.setDefault(doc,"netClass",t.id,"Power");
assert.equal(V.defaultFor(doc,{net:"SIG"}).id,"stock-045-020-through");
assert.equal(V.defaultFor(doc,{net:"D-"}).id,"stock-030-015-tented");
assert.equal(V.defaultFor(doc,{net:"VCC"}).id,t.id);
const placed=V.place(doc,{id:"p1",x:1,y:2,net:"D+"});
assert.deepEqual([placed.diameter,placed.drill,placed.template,placed.ipc4761],[.3,.15,"stock-030-015-tented","I"]);
assert.equal(V.removeTemplate(doc,t.id),true);assert.equal(V.library(doc).defaults.netClasses.Power,undefined);
// Without a default the via tool uses the preferred Routing Via Style, then 0.84/0.4.
const plainDoc=board([]);assert.deepEqual([V.place(plainDoc,{id:"a",x:0,y:0}).diameter,V.place(plainDoc,{id:"a",x:0,y:0}).drill],[.84,.4]);
const pref=AtriumRules.create();Object.assign(pref.list.find(x=>x.type==="viaStyle"),{diameterPreferred:.55,holePreferred:.25});
plainDoc.rules=AtriumRules.normalize(pref);assert.deepEqual([V.place(plainDoc,{id:"a",x:0,y:0}).diameter,V.place(plainDoc,{id:"a",x:0,y:0}).drill],[.55,.25]);
// Template validation.
assert.throws(()=>V.cleanTemplate({name:"x",diameter:.3,drill:.3}),/smaller/);
assert.throws(()=>V.cleanTemplate({name:"x",diameter:.5,drill:.3,ipc4761:"VIII"}),/IPC-4761/);
assert.throws(()=>V.cleanTemplate({name:"x",diameter:.5,drill:.3,fromLayer:"Top"}),/both span layers/);
// The project still validates with the new optional fields.
const project=Atrium.project("P",[]);const pcb=project.documents.find(d=>d.kind==="pcb");
pcb.items.push(again);pcb.viaTemplates=V.library(other);Atrium.validate(JSON.parse(JSON.stringify(project)));

// ---- cross-section SVG -------------------------------------------------------
const svg=V.section({...target,ipc4761:"VII",viaInPad:true},six,new Map());
assert.match(svg,/^<svg/);assert.match(svg,/Back-drill ⌀/);assert.match(svg,/IPC-4761 VII/);assert.match(svg,/>cut</);
assert.ok(svg.length<20000,"cross-section stays small ("+svg.length+" bytes)");

// ---- speed: 20k vias -----------------------------------------------------------
const many=[];for(let i=0;i<20000;i++)many.push({...tmb,id:"m"+i,x:i%200,y:Math.floor(i/200)});
let t0=Date.now();let sum=0;for(const v of many)for(const k of keys)sum+=V.diameterOn(v,k);
for(const v of many)sum+=V.maskOpening(v,"top",.05).diameter;
const ms=Date.now()-t0;assert.ok(ms<1000,"20k vias × 6 layers in "+ms+" ms");
console.log("PASS via stacks: per-layer lands, IPC-4761 mask, back-drill and microvia spans, validation, templates and cross-section ("+ms+" ms for 20k vias)");
