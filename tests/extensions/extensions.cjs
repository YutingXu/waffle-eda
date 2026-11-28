"use strict";
// Extension host: manifests, capabilities and consent, lazy activation, the worker
// protocol, guarded proposals, limits, the kill switch and the sample extensions.
// Extension code runs in a SEPARATE JS realm here (JavaScriptCore $262.createRealm or
// Node vm), joined to the host only by JSON strings, the way a Worker is. The browser
// test adds real Worker isolation and termination of synchronous infinite loops.
const assert=require("node:assert/strict");
const fs=require("node:fs");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/core/spatial.js");require("../../app/checks/altium-rules.js");
require("../../app/checks/rules.js");require("../../app/checks/connectivity.js");require("../../app/core/zip.js");require("../../app/editor/keymap.js");require("../../app/automation/proposal.js");
require("../../app/core/atrium-api.js");require("../../app/workers/extension-host-worker.js");require("../../app/extension-host/extensions.js");require("../../app/automation/scripting.js");
require("../../app/extensions/manifests.js");
require("../../app/checks/diagnostics.js");
const A=Atrium,X=AtriumExtensions;
const loadedBuiltins=()=>AtriumBuiltinExtensionManifests.map(({manifest})=>manifest.id).filter(id=>
  !!require.cache[require.resolve("../../app/extensions/packages/"+id+".js")]);
const root=__dirname+"/../../extensions/examples/";
const read=p=>String(fs.readFileSync(root+p,"utf8"));
const sample=name=>({"waffle-extension.json":read(name+"/waffle-extension.json"),"main.js":read(name+"/main.js")});
const pkg=(manifest,main)=>({"waffle-extension.json":JSON.stringify({version:"1.0.0",apiVersion:1,main:"main.js",name:manifest.id,...manifest}),"main.js":main});
const wait=ms=>new Promise(r=>setTimeout(r,ms));

const {realmWorker,realms,__enc,__dec}=require("./extension-realm.js");

// ----------------------------------------------- an editor-like host and a consent stub
let project=AtriumParts.example(),current=project.documents.find(d=>d.kind==="pcb").id,selection=new Set(),revision=0;
const history=[],messages=[],exported=[],actions=[],prompts=[];
let savedTarget;
const host={
  savedTarget:()=>savedTarget,project:()=>project,documentId:()=>current,revision:()=>revision,selection:()=>selection,
  select(ids){selection=new Set(ids);X.notify("selectionChanged");},
  edit(fn){const before=JSON.stringify(project);try{fn();}catch(e){project=JSON.parse(before);throw e;}history.push(before);revision++;X.notify("documentChanged");},
  amend(fn){const before=JSON.stringify(project);try{fn();}catch(e){project=JSON.parse(before);throw e;}revision++;X.notify("documentChanged");},
  info:t=>messages.push(t),activate(id){current=id;X.notify("activeDocumentChanged");},
  runAction:a=>actions.push(a),exportFile:(n,t)=>{exported.push([n,t]);return true;},locate:()=>{}
};
function undo(){project=JSON.parse(history.pop());revision++;X.notify("documentChanged");}
const board=()=>project.documents.find(d=>d.kind==="pcb");
const refOf=(d,r)=>d.items.find(i=>i.ref===r);
// What the user answers, per prompt kind. Tests change these as they go.
const answers={install:r=>Object.fromEntries(r.permissions.map(p=>[p,!p.startsWith("network:")])),activate:null,write:"always",review:r=>r.rows.map(x=>x.index)};
const consent=r=>{prompts.push(r.kind+":"+r.manifest.id);const a=answers[r.kind];return typeof a==="function"?a(r):a;};

const done=(async()=>{
  // ------------------------------------------------------------- manifests
  const ok={id:"a.b",name:"N",version:"1.0.0",apiVersion:1,main:"main.js"};
  assert.equal(X.validateManifest(ok,{"main.js":""}),ok);
  for(const [patch,re] of [[{id:"nodot"},/publisher\.name/],[{apiVersion:2},/not supported/],[{version:"1"},/semantic/],
    [{activationEvents:["onLoad"]},/activationEvents/],[{permissions:["root"]},/permissions/],[{permissions:["read"]},/permissions/],
    [{permissions:["network:*.example.com"]},/permissions/],[{permissions:["network:http://x.com"]},/permissions/],
    [{permissions:["ui:command"],contributes:{keybindings:[{command:"x",key:"k"}]}},/keybinding/],
    [{permissions:["ui:command"],contributes:{keybindings:[{command:"x",key:"ctrl+s"}]}},/keybinding/],
    [{permissions:["ui:command"],contributes:{menus:{nowhere:[{command:"x"}]}}},/unknown menu/],[{timeoutMs:999999},/timeoutMs/],
    [{contributes:{commands:[{command:"x",title:"X"}]}},/ui:command/],[{contributes:{panels:[{id:"p",title:"P"}]}},/ui:panel/]])
    assert.throws(()=>X.validateManifest({...ok,...patch},{"main.js":""}),re);
  assert.ok(X.validateManifest({...ok,permissions:["read:project","network:api.example.com","network:eu.example.org:8443"]},{"main.js":""}));
  assert.throws(()=>X.validateManifest(ok,{}),/missing/);
  assert.ok(X.parseKey("ctrl+alt+r"));assert.ok(X.parseKey("F5"));assert.equal(X.parseKey("shift+r"),null);
  assert.ok(X._when("pcb && !selection",{pcb:true,selection:false}));assert.ok(!X._when("schematic",{pcb:true}));

  // ------------------------------------------------- zero cost until activation
  // network:<host> requests are made by the host: a recorded fake network stands in.
  const netLog=[];
  const fakeFetch=async(url,init)=>{netLog.push({url,method:init.method,headers:init.headers,body:init.body,redirect:init.redirect,credentials:init.credentials});
    const chunks=["hello ","from ","the host"].map(t=>new TextEncoder().encode(t));let i=0;
    return {status:200,statusText:"OK",headers:{forEach:f=>f("text/plain","content-type")},body:{getReader:()=>({read:async()=>i<chunks.length?{done:false,value:chunks[i++]}:{done:true},cancel:async()=>{}})}};};
  X.attach(host,{createWorker:realmWorker,consent,fetch:fakeFetch,heartbeatMs:100,cpu:{window:10,budgetMs:600,silenceMs:4000}});
  assert.deepEqual(X.list().filter(e=>e.origin!=="builtin"),[]);assert.deepEqual(X.workers,[],"no worker until something activates");
  assert.deepEqual(loadedBuiltins(),[],"manifest registration does not read any built-in package");
  const builtin=X.list().find(e=>e.id==="waffle.calculators");
  assert.ok(builtin&&builtin.origin==="builtin"&&builtin.enabled&&builtin.status==="inactive","built-ins register from the manifest index and await activation");
  for(const {manifest} of AtriumBuiltinExtensionManifests){
    assert.deepEqual(X.permissions(manifest.id).declared,manifest.permissions);
    assert.deepEqual(X.commands().filter(c=>c.owner===manifest.id).map(c=>c.id),manifest.contributes.commands.map(c=>c.command));
    for(const key of manifest.contributes.keybindings||[])assert.ok(AtriumKeymap.command(key.command),"keybindings register before loading package source");
  }
  await X.install(sample("renumber-by-x"));
  assert.deepEqual(prompts,["install:atrium-samples.renumber-by-x"],"permissions are shown at install");
  assert.deepEqual(X.permissions("atrium-samples.renumber-by-x").live,{"read:project":true,"write:edits":true,"ui:command":true});
  const listed=id=>X.list().find(e=>e.id===id);
  assert.equal(listed("atrium-samples.renumber-by-x").status,"inactive");
  assert.deepEqual(X.workers,[],"installing does not load extension code");
  assert.ok(X.commands().some(c=>c.id==="renumber.byX"&&c.owner==="atrium-samples.renumber-by-x"),"contributed commands exist before activation");
  assert.deepEqual(AtriumKeymap.bindingsFor("renumber.byX").map(b=>b.key),["Ctrl+Alt+R"],"keybindings join the editor keymap");
  answers.install=null;
  await assert.rejects(X.install(pkg({id:"test.declined",permissions:["read:project"]},"")),/cancelled/,"declining the install prompt installs nothing");
  assert.ok(!X.list().some(e=>e.id==="test.declined"));
  answers.install=r=>Object.fromEntries(r.permissions.map(p=>[p,!p.startsWith("network:")]));
  // Cancelling an update that asks for a new permission keeps the installed version's grant.
  await X.install(pkg({id:"test.upgrade",permissions:["read:project"]},""));
  answers.install=null;
  await assert.rejects(X.install(pkg({id:"test.upgrade",version:"1.1.0",permissions:["read:project","ui:command"]},"")),/cancelled/);
  answers.install=r=>Object.fromEntries(r.permissions.map(p=>[p,!p.startsWith("network:")]));
  {
    const asked=prompts.length;
    await X.install(pkg({id:"test.upgrade",permissions:["read:project"]},""));
    assert.equal(prompts.length,asked,"reinstalling the installed version does not ask again after a cancelled update");
    assert.deepEqual(X.permissions("test.upgrade").live,{"read:project":true});
  }
  // Queued updates each decide against the saved grant: cancelling one never lets the next
  // install without asking, and only the answer the user accepts is saved.
  {
    const pending=[],upgrade=["read:project","ui:command","propose:edits"],v11=()=>pkg({id:"test.upgrade",version:"1.1.0",permissions:upgrade},"");
    const versionOf=()=>X.list().find(e=>e.id==="test.upgrade")?.version;
    answers.install=()=>new Promise(res=>pending.push(res));
    const asked=prompts.length;
    const runs=[0,1,2].map(()=>X.install(v11()).then(()=>"installed",e=>e.message));
    for(let n=0;n<3;n++){
      for(let t=0;t<50&&!pending.length;t++)await wait(2);
      assert.equal(pending.length,1,"update "+(n+1)+" asks the user");
      pending.shift()(null);
      assert.match(await runs[n],/cancelled/);
      assert.equal(versionOf(),"1.0.0");
      assert.deepEqual(X.permissions("test.upgrade").live,{"read:project":true},"a cancelled update leaves the installed grant");
    }
    assert.equal(prompts.length,asked+3,"every queued update asks");
    // Accepting after a cancel installs with exactly the accepted answers.
    const two=[X.install(v11()),X.install(v11())];
    for(let t=0;t<50&&!pending.length;t++)await wait(2);
    pending.shift()(null);
    await assert.rejects(two[0],/cancelled/);
    for(let t=0;t<50&&!pending.length;t++)await wait(2);
    pending.shift()({"read:project":true,"ui:command":true,"propose:edits":false});
    await two[1];
    assert.equal(versionOf(),"1.1.0");
    assert.deepEqual(X.permissions("test.upgrade").live,{"read:project":true,"ui:command":true,"propose:edits":false});
    // A permission without an explicit yes is not live, whether the answer or a later edit leaves it out.
    await X.grant("test.upgrade","ui:command",null);
    assert.deepEqual(X.permissions("test.upgrade").live,{"read:project":true,"ui:command":false,"propose:edits":false});
    answers.install=()=>({"read:project":true});
    await X.install(pkg({id:"test.upgrade",version:"1.2.0",permissions:[...upgrade,"ui:panel"]},""));
    assert.deepEqual(X.permissions("test.upgrade").live,{"read:project":true,"ui:command":false,"propose:edits":false,"ui:panel":false});
    answers.install=r=>Object.fromEntries(r.permissions.map(p=>[p,!p.startsWith("network:")]));
  }
  await X.uninstall("test.upgrade");
  // A fresh install always asks.
  {
    const id="test.leftover",asked=prompts.length;
    await X.install(pkg({id,permissions:["read:project"]},""));await X.uninstall(id);
    answers.install=null;
    await assert.rejects(X.install(pkg({id,permissions:["read:project"]},"")),/cancelled/);
    assert.equal(prompts.length,asked+2);
    answers.install=r=>Object.fromEntries(r.permissions.map(p=>[p,!p.startsWith("network:")]));
  }

  // ----------------------------------------- onCommand activation and one undo step
  const C1=refOf(board(),"C1").id,C2=refOf(board(),"C2").id;
  host.edit(()=>{refOf(board(),"C1").ref="CX";refOf(board(),"C2").ref="C1";refOf(board(),"CX").ref="C2";});
  const steps=history.length;
  assert.deepEqual(await X.execute("renumber.byX"),{changed:2});
  assert.equal(board().items.find(i=>i.id===C1).ref,"C1");assert.equal(board().items.find(i=>i.id===C2).ref,"C2");
  assert.equal(history.length,steps+1,"one transaction, one undo step");
  assert.equal(listed("atrium-samples.renumber-by-x").status,"active");
  assert.deepEqual(X.workers.map(w=>[w.pool,w.members]),[["ext:atrium-samples.renumber-by-x",["atrium-samples.renumber-by-x"]]],"each extension runs in its own worker");
  A.validate(project);
  undo();assert.equal(board().items.find(i=>i.id===C1).ref,"C2","undo restores the previous designators");
  assert.deepEqual(await X.execute("renumber.byX"),{changed:2},"a second run reuses the active extension");

  // ------------------------------------------------------------ no ambient authority
  await X.install(pkg({id:"test.probe",activationEvents:["onCommand:probe.run"],permissions:["ui:command"]},
    `exports.activate = api => api.commands.register("probe.run", async () => {
       const g = Function("return this")(), names = Object.getOwnPropertyNames(g);
       let readable = "refused";
       try { await api.items.count(); readable = "allowed"; } catch (e) { readable = e.message; }
       let intercepted = false;
       try { self.addEventListener("message", () => { intercepted = true; }); } catch {}
       try { g.onmessage = () => { intercepted = true; }; } catch {}
       return {
         types: [typeof document, typeof window, typeof parent, typeof localStorage, typeof fetch, typeof XMLHttpRequest, typeof WebSocket,
           typeof importScripts, typeof indexedDB, typeof AtriumHost, typeof webkit, typeof Atrium, typeof AtriumAPI, typeof AtriumExtensions,
           typeof postMessage, typeof g.postMessage, typeof g.fetch, typeof g.close],
         atriumGlobals: names.filter(n => /^Atrium|^__/.test(n)),
         escape: (() => {}).constructor("return [typeof Atrium, typeof document, typeof localStorage]")(),
         readable, intercepted, frozen: Object.isFrozen(api)
       };
     });`));
  const probe=await X.execute("probe.run");
  assert.deepEqual(probe.types,Array(18).fill("undefined"),"no DOM, storage, network, bridge, editor globals or raw messaging");
  assert.deepEqual(probe.atriumGlobals,[],"the realm holds no editor modules, only the facade the host built");
  assert.deepEqual(probe.escape,["undefined","undefined","undefined"],"the Function constructor reaches only the sandbox realm");
  assert.match(probe.readable,/read:project/,"undeclared capabilities are refused by the host");
  assert.equal(probe.frozen,true);

  // ----------------------------------------------------- permissions on every message
  const W=board().items.find(i=>i.kind==="track").id;
  await X.install(pkg({id:"test.readonly",activationEvents:["onCommand:ro.edit"],permissions:["read:project","ui:command"]},
    `exports.activate = api => {
       api.commands.register("ro.edit", () => api.transaction("x", tx => tx.remove(${JSON.stringify(C1)})));
       api.commands.register("ro.submit", () => api.proposals.submit({format: "atrium-ai", version: 2, project: "x", ops: []}));
       api.commands.register("ro.save", () => api.commands.execute("waffle.save"));
       api.commands.register("ro.fit", () => api.commands.execute("waffle.fit"));
       api.commands.register("ro.export", () => api.files.export("a.txt", "x"));
       api.commands.register("ro.count", () => api.items.count());
     };`));
  let snapshot=JSON.stringify(project);
  await assert.rejects(X.execute("ro.edit"),/propose:edits or write:edits/,"an edit without permission is refused");
  await assert.rejects(X.execute("ro.submit"),/propose:edits or write:edits/);
  await assert.rejects(X.execute("ro.save"),/not available to extensions/,"editor actions outside proposals are refused");
  await assert.rejects(X.execute("ro.export"),/outputs:write/);
  assert.equal(JSON.stringify(project),snapshot);
  await X.execute("ro.fit");assert.deepEqual(actions,["fit"],"view commands are allowed");
  assert.ok(await X.execute("ro.count")>0);
  X.grant("test.readonly","read:project",false);
  await assert.rejects(X.execute("ro.count"),/read:project/,"revoking takes effect on the next message");
  X.grant("test.readonly","read:project",true);

  // write:edits asks first; propose:edits reviews; both apply as one step
  answers.install=r=>Object.fromEntries(r.permissions.filter(p=>p!=="write:edits").map(p=>[p,true])); // unchecked write:edits = ask
  await X.install(pkg({id:"test.writer",activationEvents:["onCommand:w.edit"],permissions:["read:project","write:edits","ui:command"]},
    `exports.activate = api => api.commands.register("w.edit", w => api.transaction("Widen", tx => tx.update(${JSON.stringify(W)}, {width: w})));`));
  assert.equal(X.permissions("test.writer").live["write:edits"],"ask");
  answers.write="once";prompts.length=0;
  assert.ok((await X.execute("w.edit",.41)).applied>0);assert.equal(board().items.find(i=>i.id===W).width,.41);
  assert.deepEqual(prompts,["write:test.writer"],"the first write asks");
  answers.write="never";
  assert.deepEqual(await X.execute("w.edit",.42),{added:[],removed:0,applied:0,declined:true});
  assert.equal(board().items.find(i=>i.id===W).width,.41);assert.equal(X.permissions("test.writer").live["write:edits"],false);
  const before=history.length;
  prompts.length=0;await assert.rejects(X.execute("w.edit",.43),/propose:edits or write:edits/);
  assert.equal(history.length,before);assert.deepEqual(prompts,[],"a denied write stays denied without asking");
  answers.install=r=>Object.fromEntries(r.permissions.map(p=>[p,true]));
  await X.install(pkg({id:"test.proposer",activationEvents:["onCommand:pr.edit"],permissions:["read:project","propose:edits","ui:command"]},
    `exports.activate = api => {
       let draft = null;
       api.commands.register("pr.edit", () => api.transaction("Two edits", tx => { tx.update(${JSON.stringify(W)}, {width: .55}); tx.update(${JSON.stringify(C1)}, {value: "47n"}); }));
       api.commands.register("pr.values", () => api.proposals.propose([
         {target: "item", id: "s-R1", path: ["value"], value: "22 kΩ"},
         {target: "item", id: "s-C1", path: ["value"], value: "47 nF"}
       ], {label: "Update component values"}));
       // A proposal drafted from a read, submitted later: its guard is the value read.
       api.commands.register("pr.draft", async () => {
         const t = await api.items.get(${JSON.stringify(W)}), info = await api.project.info();
         draft = {format: "atrium-ai", version: 2, project: info.name, ops: [{op: "set", target: "item", document: t.document, id: t.id, path: ["width"], before: t.width, after: .77}]};
       });
       api.commands.register("pr.submit", () => api.proposals.submit(draft, "Drafted"));
       api.commands.register("pr.forge", () => api.proposals.submit({format: "atrium-ai", version: 2, project: ${JSON.stringify(project.name)},
         ops: [{op: "remove", target: "document", id: ${JSON.stringify(current)}, before: {id: ${JSON.stringify(current)}}}]}));
     };`));
  answers.review=r=>[r.rows[0].index];prompts.length=0;
  const reviewed=await X.execute("pr.edit");
  assert.deepEqual(prompts,["review:test.proposer"],"propose:edits shows the review");
  assert.equal(reviewed.applied,1,"only the selected change applies");
  answers.review=false;
  assert.equal((await X.execute("pr.edit")).declined,true,"a discarded review changes nothing");
  answers.review=r=>r.rows.map(x=>x.index);
  await X.execute("pr.draft");
  host.edit(()=>{board().items.find(i=>i.id===W).width=.3;});
  snapshot=JSON.stringify(project);
  await assert.rejects(X.execute("pr.submit"),/changed since this proposal was drafted/,"a stale proposal guard is rejected");
  await assert.rejects(X.execute("pr.forge"),/changed since|malformed/,"a forged guard is rejected");
  assert.equal(JSON.stringify(project),snapshot);
  await X.execute("pr.draft");assert.ok((await X.execute("pr.submit")).applied>0);assert.equal(board().items.find(i=>i.id===W).width,.77);

  // An edit arriving while the review is open only invalidates a checked row.
  const schematicPart = ref => refOf(project.documents.find(d => d.kind === "schematic"), ref);
  const values = () => ["R1", "C1"].map(ref => schematicPart(ref).value);
  const originalValues = values(), reviewSteps = history.length;
  const changedDuringReview = pick => review => {
    assert.deepEqual(values(), originalValues);
    host.edit(() => { schematicPart("C1").value = "15 nF"; });
    return review.rows.filter(row => pick(row.op.id)).map(row => row.index);
  };
  answers.review = changedDuringReview(id => id === "s-R1");
  assert.deepEqual(await X.execute("pr.values"), {applied: 1});
  assert.deepEqual(values(), ["22 kΩ", "15 nF"]);
  assert.equal(history.length, reviewSteps + 2, "the incoming edit and selected proposal each take one undo");
  undo();
  assert.deepEqual(values(), [originalValues[0], "15 nF"], "Undo preserves the other edit");
  undo();
  for (const pick of [() => true, id => id === "s-C1"]) {
    answers.review = changedDuringReview(pick);
    await assert.rejects(X.execute("pr.values"), /C1.*changed since/);
    assert.deepEqual(values(), [originalValues[0], "15 nF"], "a stale selected row invalidates the chosen batch");
    assert.equal(history.length, reviewSteps + 1);
    undo();
  }
  answers.review = async review => {
    await X.grant("test.proposer", "propose:edits", false);
    return [review.rows.find(row => row.op.id === "s-R1").index];
  };
  assert.deepEqual(await X.execute("pr.values"), {applied: 0, revoked: true});
  assert.deepEqual(values(), originalValues);
  assert.equal(history.length, reviewSteps);
  await X.grant("test.proposer", "propose:edits", true);
  answers.review = review => review.rows.map(row => row.index);

  // ----------------------------------------------------- PCB geometry sample
  await X.install(sample("pcb-geometry"));
  assert.ok(X.workers.every(w=>w.members.length<=1),"no two extensions share a worker (realm)");
  const tracksBefore=board().items.filter(i=>i.kind==="track").length,stepsBefore=history.length;
  const added=await X.execute("teardrops.add");
  const drops=board().items.filter(i=>i.teardrop);
  assert.ok(added>0&&drops.length===added,"teardrops added: "+added);
  assert.equal(history.length,stepsBefore+1);
  assert.ok(drops.every(t=>t.kind==="track"&&t.points.length===2&&t.net&&t.width>0));
  assert.equal(await X.execute("teardrops.add"),0,"teardrops are not duplicated");
  assert.equal(await X.execute("teardrops.remove"),added);
  assert.equal(board().items.filter(i=>i.kind==="track").length,tracksBefore);
  const vias=await X.execute("stitching.add",{net:"GND",pitch:3,clearance:.4});
  const stitched=board().items.filter(i=>i.stitching);
  assert.ok(vias>0&&stitched.length===vias,"stitching vias: "+vias);
  const g=AtriumAPI.facade(()=>{},{commands:new Map(),listeners:new Map()}).geometry;
  for(const v of stitched){
    assert.equal(v.net,"GND");assert.ok(g.pointInPolygon([v.x,v.y],board().outline));
    for(const t of board().items.filter(i=>i.kind==="track"&&!i.teardrop))
      for(let k=1;k<t.points.length;k++)assert.ok(A.nearSegment([v.x,v.y],t.points[k-1],t.points[k])>=v.diameter/2+t.width/2,"via clears track");
  }
  undo();assert.equal(board().items.filter(i=>i.stitching).length,0);

  // A direct-write grant to one saved document does not follow this actor to another file.
  savedTarget = "/fixtures/first/Board.waffle";
  await X.grant("test.writer","write:edits",true);
  prompts.length=0;await X.execute("w.edit",.81);assert.deepEqual(prompts,[]);
  savedTarget = "/fixtures/second/Board.waffle";answers.write="once";
  await X.execute("w.edit",.82);assert.deepEqual(prompts,["write:test.writer"]);
  savedTarget = "/fixtures/first/Board.waffle";prompts.length=0;
  await X.execute("w.edit",.83);assert.deepEqual(prompts,[]);
  await X.grant("test.writer","write:edits",false);
  await assert.rejects(X.execute("w.edit",.84),/permission/);
  savedTarget=undefined;
  // ------------------------------------------------------ panels and events
  await X.install(sample("net-length-report"));
  await X.execute("netLengths.show");
  let view=X._panel("atrium-samples.net-length-report","netLengths");
  assert.ok(view.find(v=>v.type==="table").rows.some(r=>r.net==="VIN"),"the panel lists routed nets");
  await X.execute("netLengths.select",{net:"VIN"});
  assert.ok(selection.size>0&&[...selection].every(id=>board().items.find(i=>i.id===id)),"row command selects the net");
  host.edit(()=>board().items.push({id:"t-new",kind:"track",points:[[1,1],[6,1]],width:.2,layer:"Top",net:"NEWNET"}));
  await wait(400);
  view=X._panel("atrium-samples.net-length-report","netLengths");
  assert.ok(view.find(v=>v.type==="table").rows.some(r=>r.net==="NEWNET"),"documentChanged re-renders the panel");
  await X.execute("netLengths.export");
  assert.equal(exported.at(-1)[0],"net-lengths.csv");assert.match(exported.at(-1)[1],/NEWNET/);

  // -------------------------------------------------- events reach subscribers only
  await X.install(pkg({id:"test.events",activationEvents:["onStartup"],permissions:["read:project","ui:command"]},
    `let last = null; exports.activate = api => { api.events.on("selectionChanged", e => { last = e; }); api.commands.register("ev.last", () => last); };`));
  await wait(120);
  assert.equal(X.list().find(e=>e.id==="test.events").status,"active","onStartup activates after load");
  host.select([C1,C2]);host.select([C1]);
  await wait(10);
  assert.deepEqual(await X.execute("ev.last"),{count:1,ids:[C1]},"bursts are coalesced to the last state");

  // ------------------------------------------------- batching, rate and size limits
  const s0={...X.stats};
  await X.install(pkg({id:"test.batch",activationEvents:["onCommand:batch.run"],permissions:["read:project","ui:command","ui:panel"],contributes:{panels:[{id:"big",title:"Big"}]}},
    `exports.activate = api => {
       api.commands.register("batch.run", async n => (await Promise.all(Array.from({length: n}, () => api.items.count().then(() => 1, () => 0)))).reduce((a, b) => a + b, 0));
       api.commands.register("batch.big", () => api.ui.setPanel("big", {type: "text", text: "x".repeat(1100000)}));
       api.commands.register("batch.store", () => api.storage.set("k", "x".repeat(300000)));
       api.commands.register("batch.log", () => { for (let i = 0; i < 500; i++) console.log("line", i); });
     };`));
  assert.equal(await X.execute("batch.run",60),60);
  const sent=X.stats.messagesOut-s0.messagesOut,batches=X.stats.batchesOut-s0.batchesOut;
  assert.ok(sent>=60&&batches<=8,"60 replies in "+batches+" posts");
  await wait(1100);
  const served=await X.execute("batch.run",2600);
  assert.ok(served<=2000&&served>=1500,"calls beyond the rate limit are refused ("+served+" served)");
  await wait(1100);
  await assert.rejects(X.execute("batch.big"),/too large/);
  await assert.rejects(X.execute("batch.store"),/256 KB/);
  await X.execute("batch.log");
  assert.ok(X.logs("test.batch").filter(l=>/^line/.test(l.text)).length<=50,"log output is rate limited");

  // ------------------------------------------------------- time limits and kill switch
  await X.install(pkg({id:"test.slow",activationEvents:["onCommand:slow.run"],permissions:["ui:command"],timeoutMs:150},
    `exports.activate = api => api.commands.register("slow.run", () => new Promise(() => {}));`));
  await assert.rejects(X.execute("slow.run"),/time limit/);
  assert.deepEqual(X.workers.filter(w=>w.pool==="ext:test.slow"),[],"the worker running it was stopped");
  assert.equal(listed("atrium-samples.renumber-by-x").status,"active","other extensions keep running in their own workers");
  const td=X.commands().find(c=>c.id==="teardrops.add");
  assert.equal(td.title,"Add Teardrops");assert.equal(td.when,"pcb","declared titles and when clauses survive restarts");
  assert.deepEqual(await X.execute("renumber.byX"),{changed:0},"others reactivate lazily after a restart");
  for(let i=0;i<2;i++)await assert.rejects(X.execute("slow.run"),/time limit/);
  assert.equal(X.list().find(e=>e.id==="test.slow").enabled,false,"three time-outs disable an extension");
  X.stopAll();assert.deepEqual(X.workers,[],"Stop all terminates every worker");
  X.setSafeMode(true);
  await assert.rejects(X.execute("renumber.byX"),/paused/,"safe mode keeps extensions from starting");
  X.setSafeMode(false);
  assert.deepEqual(await X.execute("renumber.byX"),{changed:0});

  // --------------------------------------------- scripts: one undo step, own worker
  const hist=history.length;
  const performanceLease=AtriumDiagnostics.startPerformance(), privateArgument="DEVELOPER_SCRIPT_PRIVATE_MARKER";
  assert.equal((await X.runScript("return args",{args:privateArgument})).value,privateArgument);
  performanceLease.stop();
  const performanceSnapshot=AtriumDiagnostics.performanceSnapshot();
  const scriptTiming=performanceSnapshot.rows.find(row=>row.component==="automation"&&row.operation==="command");
  assert.equal(scriptTiming.counts.completed,1);
  assert.equal(scriptTiming.counts.started,1);
  assert.ok(!JSON.stringify(performanceSnapshot).includes(privateArgument));
  let r=await X.runScript(`
    const parts = await api.items.list({kind: "part", fields: ["id", "x"]});
    await api.transaction("A", tx => tx.move(parts[0].id, 1, 0));
    await api.transaction("B", tx => tx.move(parts[1].id, 1, 0));
    console.log("moved", 2);
    return parts.length;`);
  assert.equal(r.ok,true,r.error?.message);assert.equal(r.value,7);assert.equal(r.transactions,2);
  assert.equal(history.length,hist+1,"a script's transactions form one undo step");
  assert.deepEqual(r.logs,[{level:"info",text:"moved 2"}]);
  assert.ok(!X.workers.some(w=>w.pool.startsWith("script")),"each script run gets a fresh worker that ends with it");
  r=await X.runScript("return [typeof document, typeof localStorage, typeof Atrium, typeof AtriumHost, typeof fetch, Object.getOwnPropertyNames(Function('return this')()).filter(n => /^Atrium/.test(n)).length]");
  assert.deepEqual(r.value,["undefined","undefined","undefined","undefined","undefined",0],"console scripts have no ambient authority either");
  r=await X.runScript("await api.transaction(tx => tx.add({kind: 'blob'}));");
  assert.equal(r.ok,false);assert.match(r.error.message,/unknown object kind/);
  r=await X.runScript("await api.commands.register('x.y', () => 1).ready");
  assert.equal(r.ok,false);assert.match(r.error.message,/ui:command/,"scripts cannot leave commands behind");
  r=await X.runScript("return new Promise(() => {})",{timeoutMs:100});
  assert.equal(r.ok,false);assert.match(r.error.message,/time limit/);
  const text="return (await api.items.list({kind: 'part'})).length";
  assert.equal((await X.runScript(text)).value,(await AtriumScripting.runHeadless(project,text)).result,"the same text runs headlessly");

  // ----------------------------------------------- disable releases the worker
  for(const e of X.list())if(e.enabled)await X.setEnabled(e.id,false);
  assert.deepEqual(X.workers,[],"no enabled extensions, no extension worker");
  await assert.rejects(X.execute("renumber.byX"),/Unknown command/);
  assert.equal(AtriumKeymap.command("renumber.byX"),null,"disabling removes keymap entries");
  await X.setEnabled("atrium-samples.renumber-by-x",true);
  assert.deepEqual(await X.execute("renumber.byX"),{changed:0});
  await X.uninstall("test.probe");assert.ok(!X.list().some(e=>e.id==="test.probe"));assert.equal(X.permissions("test.probe"),null);

  // ---------------------------------------------------- first-party (built-in) extensions
  await X.setEnabled("waffle.calculators",true); // the loop above disabled everything
  assert.ok(!prompts.some(p=>p.endsWith("waffle.calculators")),"built-ins are trusted by provenance: no install prompt");
  assert.deepEqual(X.permissions("waffle.calculators").live,{"ui:command":true},"calculator scripts need no project or panel access");
  assert.deepEqual(loadedBuiltins(),[],"toggling inactive built-ins leaves their source unloaded");
  await X.execute("calculators.show");
  assert.equal(actions.at(-1),"calculators","the legacy view command opens the native panel");
  assert.deepEqual(loadedBuiltins(),[],"opening the native view does not start a worker");
  const track1=await X.execute("calculators.form.track",{current:1,rise:10,copper:1,layer:"external"});
  assert.deepEqual(loadedBuiltins(),["waffle.calculators"],"the first script calculation loads only its own source");
  assert.ok(Math.abs(track1.widthMil-11.8)<.1,"IPC-2221: 1 A, 10 °C, 1 oz outer = 11.8 mil ("+track1.widthMil+")");
  const inner=await X.execute("calculators.compute","track",{layer:"internal"});
  assert.ok(Math.abs(inner.widthMil/track1.widthMil-2**(1/0.725))<.01,"inner layers need 2^(1/0.725) the area");
  const via=await X.execute("calculators.compute","via",{drill:.3,plating:25,rise:10});
  assert.ok(Math.abs(via.current-1.9)<.05,"0.3 mm via, 25 µm plating ≈ 1.9 A ("+via.current+")");
  assert.equal((await X.execute("calculators.compute","eseries",{value:"4k7",series:"E24"})).value,4700);
  const e12=await X.execute("calculators.compute","eseries",{value:"5k",series:"E12"});
  assert.deepEqual([e12.value,e12.below,e12.above],[4700,4700,5600]);
  assert.equal((await X.execute("calculators.compute","eseries",{value:"10.5k",series:"E96"})).value,10500);
  assert.equal((await X.execute("calculators.compute","eseries",{value:"9.2",series:"E192"})).value,9.2,"E192 keeps its IEC exception");
  assert.equal((await X.execute("calculators.compute","eseries",{value:"2.2u",series:"E6"})).value,2.2e-6);
  const div=await X.execute("calculators.compute","divider",{vout:3.3,vref:.8,series:"E96"});
  // Exhaustive search over all E96 pairs: 35.7k/11.5k (−0.50 %) is the best E96 can do for 3.3 V from 0.8 V.
  assert.deepEqual([div[0].r1,div[0].r2],[35700,11500]);assert.ok(Math.abs(div[0].error+.5007)<.001&&Math.abs(.8*(1+div[0].r1/div[0].r2)-div[0].vout)<1e-9);
  const div192=await X.execute("calculators.compute","divider",{vout:3.3,vref:.8,series:"E192"});
  assert.ok(Math.abs(div192[0].error)<Math.abs(div[0].error),"a finer series finds a closer divider");
  await assert.rejects(X.execute("calculators.compute","divider",{vout:.5,vref:.8}),/above Vref/);
  await X.execute("calculators.show");
  assert.equal(actions.at(-1),"calculators");
  assert.ok(!X._panel("waffle.calculators","waffle.calculators"),"no duplicate extension panel");
  assert.equal((await X.execute("calculators.form.track",{current:3})).widthMm,
    (await X.execute("calculators.compute","track",{current:3})).widthMm,"legacy script form commands still calculate");
  await assert.rejects(X.install(pkg({id:"evil.builtin",builtin:true,permissions:[]},"")),/only extensions bundled/,"only bundle-path extensions may claim builtin");
  await assert.rejects(X.install(pkg({id:"waffle.calculators",permissions:[]},"")),/built into Waffle/);
  await assert.rejects(X.uninstall("waffle.calculators"),/Only installed/);
  await X.setEnabled("waffle.calculators",false);assert.ok(!X.commands().some(c=>c.id==="calculators.show"),"built-ins can be disabled");
  await X.setEnabled("waffle.calculators",true);

  // ------------------------------------- long-running work: dedicated worker, wasm, transfer
  const ADD_WASM=[0,97,115,109,1,0,0,0,1,7,1,96,2,127,127,1,127,3,2,1,0,7,7,1,3,97,100,100,0,0,10,9,1,7,0,32,0,32,1,106,11];
  await X.install({...pkg({id:"test.sim",activationEvents:["onCommand:sim.run"],permissions:["read:project","ui:command"],worker:"dedicated",timeoutMs:300000},
    `exports.activate = api => api.commands.register("sim.run", async () => {
       const bytes = await api.assets.read("add.wasm");
       const {instance} = await WebAssembly.instantiate(bytes);
       const samples = new Float64Array(1000).map((_, i) => Math.sin(i / 50));
       const net = await api.project.netlist({format: "spice"});
       return {sum: instance.exports.add(2, 3), size: bytes.byteLength, wave: api.transfer(samples), spice: net.text.split(String.fromCharCode(10))[0], moved: samples.byteLength === 0 || true};
     });`),"add.wasm":"data:application/wasm;base64,"+(typeof btoa==="function"?btoa(String.fromCharCode(...ADD_WASM)):Buffer.from(ADD_WASM).toString("base64"))});
  const sim=await X.execute("sim.run");
  assert.equal(sim.sum,5,"WebAssembly instantiates from bytes bundled with the extension");
  assert.equal(sim.size,ADD_WASM.length);assert.ok(sim.wave instanceof Float64Array&&sim.wave.length===1000,"typed arrays cross intact");
  assert.match(sim.spice,/^\* /,"the SPICE netlist is readable with read:project");
  assert.ok(X.workers.some(w=>w.pool.startsWith("ext:test.sim")&&w.members.includes("test.sim")),"long-running extensions get a dedicated worker");
  assert.throws(()=>X.validateManifest({...ok,timeoutMs:300000},{"main.js":""}),/dedicated worker/);

  // ------------------------------------------------------------- ZIP packages
  const zip=AtriumZip.create([{name:"renumber/waffle-extension.json",data:sample("renumber-by-x")["waffle-extension.json"]},{name:"renumber/main.js",data:sample("renumber-by-x")["main.js"]},{name:"renumber/icon.png",data:"x"}]);
  const files=await X.readZip(zip);
  assert.deepEqual(Object.keys(files).sort(),["renumber/main.js","renumber/waffle-extension.json"]);
  const fake=(name,bytes)=>({name,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),text:async()=>new TextDecoder().decode(bytes)});
  const unpacked=await X.packageFromFiles([fake("renumber.zip",zip)]);
  assert.ok(unpacked["waffle-extension.json"]&&unpacked["main.js"],"a shared top folder is stripped");

  const themeManifest = {...ok, contributes: {themes: [{id: "dusk", label: "Dusk", path: "./themes\\Dusk.JSONC"}]}};
  const themeText = '{// fixture\n"colors": {},\n}';
  const chosen = (relative, text, prefix = "Theme pack") => ({
    webkitRelativePath: prefix + "/" + relative, text: async () => text
  });
  const selected = [
    chosen("waffle-extension.json", JSON.stringify(themeManifest)),
    chosen("main.js", ""),
    {webkitRelativePath: "Theme pack/themes/unlisted.jsonc", text() { assert.fail("Undeclared JSONC must not be read"); }},
    {webkitRelativePath: "Neighbour/themes/Dusk.JSONC", text() { assert.fail("A theme in a different root must not be read"); }}
  ];
  const absent = await X.packageFromFiles(selected);
  assert.throws(() => X.validateManifest(themeManifest, absent), /theme file .* is missing/);
  const themeFiles = await X.packageFromFiles([...selected, chosen("themes/Dusk.JSONC", themeText)]);
  assert.equal(X.validateManifest(themeManifest, themeFiles), themeManifest);
  assert.equal(themeFiles["themes/Dusk.JSONC"], themeText);
  assert.throws(() => X.validateManifest(themeManifest, {...themeFiles, "themes/Dusk.JSONC": " ".repeat(524289)}), /larger than 512 KB/);
  const wrongCase = await X.packageFromFiles([...selected, chosen("themes/dusk.JSONC", themeText)]);
  assert.throws(() => X.validateManifest(themeManifest, wrongCase), /theme file .* is missing/);
  const oversized = await X.packageFromFiles([...selected, {
    webkitRelativePath: "Theme pack/themes/Dusk.JSONC", size: 2 * 1024 * 1024,
    text() { assert.fail("A theme above the possible UTF-8 byte limit must not be read"); }
  }]);
  assert.throws(() => X.validateManifest(themeManifest, oversized), /larger than 512 KB/);

  // ---------------------------------------------- project-bundled extensions (opt-in)
  const bundled={manifest:{id:"proj.tool",name:"Project tool",version:"1.0.0",apiVersion:1,main:"main.js",activationEvents:["onCommand:proj.hello"],permissions:["read:project","ui:command"],
    contributes:{commands:[{command:"proj.hello",title:"Hello"}]}},files:{"main.js":`exports.activate = api => api.commands.register("proj.hello", async () => (await api.project.info()).name);`}};
  host.edit(()=>{project.extensions=[bundled];});
  assert.equal(X.list().find(e=>e.id==="proj.tool").status,"blocked","project extensions wait for trust");
  await assert.rejects(X.execute("proj.hello"),/trust/);
  prompts.length=0;await X.trust("proj.tool");
  assert.deepEqual(prompts,["install:proj.tool"],"trusting shows the permissions");
  assert.equal(await X.execute("proj.hello"),project.name);
  A.validate(project);

  // ======================= security regressions (attacks must fail)
  const proj=(id,files,perms=["read:project"],extra={})=>({manifest:{id,name:id,version:"1.0.0",apiVersion:1,main:"main.js",permissions:perms,...extra},files});
  answers.install=r=>Object.fromEntries(r.permissions.map(p=>[p,!p.startsWith("network:")]));answers.write="always";

  // Finding 2: a zero-permission extension cannot hijack another one through shared intrinsics,
  // and a message naming another extension is attributed to the worker it came from.
  await X.install(pkg({id:"acme.victim",activationEvents:["onCommand:victim.run"],permissions:["read:project","write:edits","ui:command"],
    contributes:{commands:[{command:"victim.run",title:"Victim"}]}},`exports.activate = api => api.commands.register("victim.run", () => api.items.count({}));`));
  await X.grant("acme.victim","write:edits",true);
  await X.install(pkg({id:"evil.zero",activationEvents:["onStartup"],permissions:[]},`
    let victim = null, seen = 0;
    const get = Map.prototype.get, set = Map.prototype.set;
    const look = v => { seen++; if (v && v.api && v.ext && v.ext.id !== "evil.zero" && !victim) victim = v; };
    Map.prototype.get = function (k) { const v = get.call(this, k); look(v); return v; };
    Map.prototype.set = function (k, v) { look(v); return set.call(this, k, v); };
    setTimeout(async () => { if (victim) await victim.api.transaction("x", tx => tx.remove(${JSON.stringify(C1)})); }, 50);
    exports.activate = () => {};`));
  await X.activate("evil.zero");
  const parts0=board().items.length;
  await X.execute("victim.run");await wait(300);
  assert.equal(board().items.length,parts0,"the victim's permissions were not usable by another extension");
  const evilRealm=realms.find(r=>!r.terminated&&r.sent.some(m=>m.batch?.some(x=>x.t==="activate"&&x.ext?.id==="evil.zero")));
  assert.ok(evilRealm&&!evilRealm.sent.some(m=>m.batch?.some(x=>x.ext?.id==="acme.victim"||x.ext==="acme.victim")),"the evil worker never sees the victim's traffic");
  evilRealm.onmessage({data:{batch:[{t:"call",rid:4242,ext:"acme.victim",method:"items.count",args:[{}]}]}});
  await wait(20);
  const forged=evilRealm.sent.flatMap(m=>m.batch||[]).find(x=>x.t==="reply"&&x.rid===4242);
  assert.ok(forged&&forged.ok===false&&/read:project/.test(forged.error.message),"a forged extension id is ignored: the call runs as evil.zero");

  // Finding 3: no network without a grant; with network:<host> the host fetches, only that host.
  await X.install(pkg({id:"test.net",activationEvents:["onCommand:net.get"],permissions:["ui:command","network:api.example.com"]},
    `exports.activate = api => api.commands.register("net.get", async url => {
       if (typeof fetch !== "function") return "no fetch";
       const r = await fetch(url, {method: "POST", headers: {"x-key": "k"}, body: "q"});
       return r.status + " " + (await r.text());
     });`));
  assert.equal(await X.execute("net.get","https://api.example.com/v1"),"no fetch","network stays off until the user allows it");
  await X.grant("test.net","network:api.example.com",true);
  assert.equal(await X.execute("net.get","https://api.example.com/v1"),"200 hello from the host","the host makes the request and streams the body");
  assert.deepEqual([netLog[0].url,netLog[0].method,netLog[0].redirect,netLog[0].credentials,netLog[0].body],["https://api.example.com/v1","POST","error","omit","q"]);
  await assert.rejects(X.execute("net.get","https://evil.example.net/x"),/not permitted/);
  await assert.rejects(X.execute("net.get","http://api.example.com/x"),/not permitted/);
  const netCalls=netLog.length;
  await X.grant("test.net","network:api.example.com",false);
  assert.equal(await X.execute("net.get","https://api.example.com/v1"),"no fetch","revoking takes the fetch away");
  assert.equal(netLog.length,netCalls);

  // network:localhost reaches loopback only (a local model server), never look-alike hosts.
  await X.install(pkg({id:"test.local",activationEvents:["onCommand:local.get"],permissions:["ui:command","network:localhost"]},
    `exports.activate = api => api.commands.register("local.get", async url => (await fetch(url)).status);`));
  await X.grant("test.local","network:localhost",true);
  assert.equal(await X.execute("local.get","http://localhost:11434/v1/models"),200);
  assert.equal(await X.execute("local.get","http://127.0.0.1:8080/x"),200);
  for(const url of ["http://localhost.evil.com/x","http://0.0.0.0:11434/","http://127.0.0.2/","https://api.example.com/","http://user@localhost:1/"])
    await assert.rejects(X.execute("local.get",url),/not permitted|may not contact/,url);
  assert.deepEqual(netLog.slice(-2).map(n=>n.url),["http://localhost:11434/v1/models","http://127.0.0.1:8080/x"]);

  // Findings 4 and 5: SHA-256 trust bound to the exact bundle; a changed bundle asks again.
  assert.equal(X._sha256("abc"),"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(X._sha256(""),"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  // The reviewer's FNV-1a collision: same id and same 32-bit hash, different code and permissions.
  const good=proj("acme.helper",{"main.js":"exports.activate=()=>{}"});
  const evil=proj("acme.helper",{"main.js":"exports.activate=async api=>{await api.ui.setStatus('pwn',{text:'forged'});}","pad.txt":"yPPbSL"},["read:project","ui:command","outputs:write"],{activationEvents:["onStartup"]});
  host.edit(()=>{project.extensions=[good];});
  prompts.length=0;await X.trust("acme.helper");assert.deepEqual(prompts,["install:acme.helper"]);
  host.edit(()=>{project.extensions=[evil];});
  await wait(150);
  assert.equal(listed("acme.helper").status,"blocked","a forged bundle with a colliding FNV hash is not trusted");
  assert.deepEqual(X.permissions("acme.helper").live,{},"…and inherits no grants");
  prompts.length=0;await X.trust("acme.helper");
  assert.deepEqual(prompts,["install:acme.helper"],"trusting a changed bundle always shows its permissions");

  // Finding 6: proposals cannot write code-bearing project fields.
  for(const field of ["extensions","scripts"]){
    const r=await X.runScript(`const info = await api.project.info();
      return api.proposals.submit({format: "atrium-ai", version: 2, project: info.name, ops: [{op: "set", target: "project", path: [${JSON.stringify(field)}], after: [{name: "x", code: "1"}]}]});`);
    assert.equal(r.ok,false);assert.match(r.error.message,/code/,field+" is refused");
  }
  assert.throws(()=>AtriumProposal.inspect({format:"atrium-ai",version:2,project:project.name,ops:[{op:"set",target:"project",path:["scripts"],after:[]}]},project),/holds code/);
  assert.equal(project.scripts,undefined);

  // Finding 8: revoking read:project stops event delivery.
  await X.install(pkg({id:"test.flood",activationEvents:["onStartup"],permissions:["read:project","ui:command"]},
    `let n = 0; exports.activate = api => { api.events.on("selectionChanged", () => { n++; }); api.commands.register("flood.n", () => n); };`));
  await X.activate("test.flood");await wait(20);
  host.select([C1]);await wait(20);
  const heard=await X.execute("flood.n");assert.ok(heard>=1);
  X.grant("test.flood","read:project",false);
  host.select([C2]);await wait(10);host.select([C1,C2]);await wait(20);
  assert.equal(await X.execute("flood.n"),heard,"no events after read:project is revoked");

  // Finding 9: an uncloneable value never reaches a reply, and other calls are unaffected.
  const [bad,okRun]=await Promise.all([X.runScript("return await api.items.list({fields:['constructor','toString'], limit:1})"),X.runScript("return await api.items.count({})")]);
  assert.equal(bad.ok,true,bad.error?.message);assert.deepEqual(bad.value,[{}],"pick copies own data only");
  assert.equal(okRun.ok,true);

  // Finding 10: ZIP sizes are checked before anything inflates.
  const zbytes=AtriumZip.create([{name:"waffle-extension.json",data:"{}"},{name:"main.js",data:"x"}]);
  const zdv=new DataView(zbytes.buffer,zbytes.byteOffset,zbytes.byteLength);
  for(let i=zbytes.length-22;i>=0;i--)if(zdv.getUint32(i,true)===0x06054b50){let q=zdv.getUint32(i+16,true);for(let n=0;n<2;n++){zdv.setUint32(q+24,400e6,true);q+=46+zdv.getUint16(q+28,true)+zdv.getUint16(q+30,true)+zdv.getUint16(q+32,true);}break;}
  await assert.rejects(X.readZip(zbytes),/limited to 32 MB/,"a declared 400 MB entry is refused before inflating");

  // Finding 7: one consent dialog at a time, a capped queue, and dialog loops get disabled.
  let open=0,most=0;answers.write=async()=>{open++;most=Math.max(most,open);await wait(15);open--;return "once";};
  await X.install(pkg({id:"test.spam",activationEvents:["onCommand:spam.run"],permissions:["read:project","ui:command","write:edits"]},
    `exports.activate = api => api.commands.register("spam.run", async () => {
       const outcomes = await Promise.allSettled(Array.from({length: 10}, () => api.transaction("x", tx => tx.update(${JSON.stringify(W)}, {width: .5}))));
       return outcomes.map(o => o.status).join(",");
     });`));
  X.grant("test.spam","write:edits",null);
  const spam=(await X.execute("spam.run")).split(",");
  assert.equal(most,1,"consent dialogs never stack");
  assert.ok(spam.filter(x=>x==="rejected").length>=6,"extra prompts beyond the per-extension queue are refused: "+spam);
  answers.write="always";
  await X.install(pkg({id:"test.phish",activationEvents:["onStartup"],permissions:["ui:command"]},
    `exports.activate = api => { (async () => { for (let i = 0; i < 50; i++) await api.ui.showInputBox({title: "Session expired", prompt: "Password"}).catch(() => {}); })(); };`));
  await X.activate("test.phish");await wait(200);
  assert.equal(listed("test.phish").enabled,false,"an extension that keeps reopening dismissed dialogs is disabled");
  // Background CPU: a worker that burns its budget between commands is terminated.
  await X.install(pkg({id:"test.hog",activationEvents:["onStartup"],permissions:[]},
    `exports.activate = () => { setInterval(() => { const t = Date.now(); while (Date.now() - t < 80) {} }, 100); };`));
  await X.activate("test.hog");
  for(let i=0;i<40&&listed("test.hog").status==="active";i++)await wait(100);
  assert.notEqual(listed("test.hog").status,"active","a background CPU hog is stopped");
  assert.ok(X.logs("test.hog").some(l=>/processor time/.test(l.text)));
  X.pauseAll();assert.equal(X.safeMode,true,"the escape hatch pauses every extension");assert.deepEqual(X.workers,[]);
  X.setSafeMode(false);

  // A read-only extension calls the same DRC batch through the worker RPC.
  for (const name of ["board-shape", "stackup", "pcb-pours", "pcb-appearance", "pcb-draw",
    "viastack", "polygon-pour", "drc-pours", "drc"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  project=A.project("Poured board");
  const d=board(), pour=AtriumPolygonPour;
  current=d.id;
  d.outline=[[0,0],[30,0],[30,20],[0,20]];
  d.items=[
    pour.make([[2,2],[28,2],[28,18],[2,18]], {net:"GND",layer:"Top",pourIndex:0,removeDeadCopper:false,clearance:.1}),
    {id:"sig",kind:"track",net:"SIG",layer:"Top",width:.1,points:[[8,10],[22,10]]}];
  pour.apply(d,new Map(),{project});
  const beforeDRC=JSON.stringify(project), drcRevision=revision;
  await X.install(pkg({id:"test.drc",activationEvents:["onCommand:test.drc"],permissions:["read:project","ui:command"]},
    `exports.activate = api => api.commands.register("test.drc", async (types, limit) => {
      const report = await api.drc({types,limit});
      return {total:report.total, types:report.violations.map(v=>v.type)};
    });`));
  assert.deepEqual(await X.execute("test.drc",["clearance"]),{total:2,types:["pourClearance","pourClearance"]});
  assert.deepEqual(await X.execute("test.drc",["clearance"],1),{total:2,types:["pourClearance"]});
  assert.deepEqual(await X.execute("test.drc",["width"]),{total:1,types:["width"]});
  X.grant("test.drc","read:project",false);
  await assert.rejects(X.execute("test.drc",["clearance"]),/read:project/);
  assert.equal(JSON.stringify(project),beforeDRC);
  assert.equal(revision,drcRevision);

  X.shutdown();
  assert.deepEqual(X.workers,[]);
  console.log("extensions tests passed");
})();
// Runners that understand it (tests/jsc-shim.js with the proposed patch) wait for this promise.
globalThis.__testDone=done.catch(e=>{console.error(e);X.shutdown();if(globalThis.process)process.exitCode=1;throw e;});
