"use strict";
// Host API additions for connector extensions (SPICE and others): proposals.propose (propose:edits,
// reviewed in the diff-style dialog, one undo step, denials final), ui.decorations (read-only canvas
// marks, capped, scrubbed, cleared when the extension stops), pin.fn in the netlist JSON, and
// run:external (programs the user chose, run by the desktop host). Includes a malicious extension
// that tries to apply without approval, to flood the canvas and to reach the DOM.
// Extension code runs in a separate realm (tests/extensions/extension-realm.js), joined to the host only by JSON.
const assert=require("node:assert/strict");
require("../../app/core/model.js");require("../../app/library/parts.js");require("../../app/core/spatial.js");require("../../app/checks/altium-rules.js");
require("../../app/checks/rules.js");require("../../app/checks/connectivity.js");require("../../app/core/zip.js");require("../../app/editor/keymap.js");require("../../app/automation/proposal.js");
require("../../app/history/diff-props.js");require("../../app/core/atrium-api.js");require("../../app/workers/extension-host-worker.js");require("../../app/extension-host/extensions.js");
require("../../app/extensions/manifests.js");require("../../app/native-bridge/external-tools.js");
const {realmWorker}=require("./extension-realm.js");
const X=AtriumExtensions;
const pkg=(manifest,main)=>({"waffle-extension.json":JSON.stringify({version:"1.0.0",apiVersion:1,main:"main.js",name:manifest.id,...manifest}),"main.js":main});

let project=AtriumParts.example(),current=project.documents.find(d=>d.kind==="schematic").id,revision=0;
const history=[],prompts=[],reviews=[];
const host={
  project:()=>project,documentId:()=>current,revision:()=>revision,selection:()=>new Set(),select(){},
  edit(fn,label){const before=JSON.stringify(project);try{fn();}catch(e){project=JSON.parse(before);throw e;}history.push(label||"Edit");revision++;X.notify("documentChanged");},
  amend(fn){fn();revision++;},info(){},activate(id){current=id;},runAction(){},exportFile:()=>true,locate(){}
};
const answers={install:r=>Object.fromEntries(r.permissions.map(p=>[p,true])),write:"always",review:r=>r.rows.map(x=>x.index)};
const consent=r=>{prompts.push(r.kind+":"+r.manifest.id);if(r.kind==="review")reviews.push(r);const a=answers[r.kind];return typeof a==="function"?a(r):a;};
// The editor's renderer registry (editor.js AtriumNavHost.addRenderer) and a recording canvas context.
const renderers=new Set();let invalidations=0;
globalThis.AtriumNavHost={addRenderer(f){renderers.add(f);return()=>renderers.delete(f);},invalidate(){invalidations++;}};
function paint(d){
  const calls=[],ctx=new Proxy({},{get:(t,k)=>k in t?t[k]:(...a)=>{calls.push([k,...a]);},set:(t,k,v)=>{t[k]=v;calls.push(["="+String(k),v]);return true;}});
  for(const f of renderers){const r=f(d,{active:true});if(r?.overlay)r.overlay(ctx,{scale:4,dpr:1,width:2000,height:2000,worldToScreen:p=>[p[0]*4+500,p[1]*4+500]});}
  return calls;
}
const texts=calls=>calls.filter(c=>c[0]==="fillText").map(c=>c[1]);
const sheet=()=>project.documents.find(d=>d.id===current);
const parts=()=>sheet().items.filter(i=>i.kind==="part");

const done=(async()=>{
  // ------------------------------------------------------------ manifests
  const ok={id:"a.b",name:"N",version:"1.0.0",apiVersion:1,main:"main.js"};
  assert.ok(X.validateManifest({...ok,permissions:["ui:decorations","propose:edits"]},{"main.js":""}));
  assert.throws(()=>X.validateManifest({...ok,permissions:["run:external"]},{"main.js":""}),/externalTools/,"run:external names its programs");
  assert.throws(()=>X.validateManifest({...ok,contributes:{externalTools:[{id:"ngspice",name:"ngspice"}]}},{"main.js":""}),/run:external/);
  assert.throws(()=>X.validateManifest({...ok,permissions:["run:external"],contributes:{externalTools:[{id:"Bad Id",name:"x"}]}},{"main.js":""}),/external tool/);
  assert.ok(X.validateManifest({...ok,permissions:["run:external"],contributes:{externalTools:[{id:"ngspice",name:"ngspice"}]}},{"main.js":""}));
  // The argument template the host approves (docs/extensions.md): literal arguments, at most one {input} or {output} each.
  assert.ok(X.validateManifest({...ok,permissions:["run:external"],contributes:{externalTools:[{id:"ngspice",name:"ngspice",args:["-b","-r","--out={output}"]}]}},{"main.js":""}));
  for(const args of ["-b",[""],["{input}{output}"],[5],Array(65).fill("-b")])
    assert.throws(()=>X.validateManifest({...ok,permissions:["run:external"],contributes:{externalTools:[{id:"ngspice",name:"ngspice",args}]}},{"main.js":""}),/args must list/,JSON.stringify(args).slice(0,40));
  assert.match(X.describePermission("propose:edits"),/nothing changes until you review/);
  assert.match(X.describePermission("run:external"),/choose/);

  X.attach(host,{createWorker:realmWorker,consent,heartbeatMs:100,cpu:{window:10,budgetMs:2000,silenceMs:8000}});
  const R1=parts()[0],D1=R1.def;

  // ------------------------------------------------- pin.fn in the netlist
  const def=project.library.find(d=>d.id===D1);def.symbol.pins[0].fn="IN+";
  await X.install(pkg({id:"test.reader",activationEvents:["onCommand:rd.netlist"],permissions:["read:project","ui:command"]},
    `exports.activate = api => api.commands.register("rd.netlist", async () => (await api.project.netlist()).components);`));
  const comps=await X.execute("rd.netlist"),row=comps.find(c=>c.id===R1.id);
  assert.equal(row.pins.find(p=>p.number===String(def.symbol.pins[0].number)).fn,"IN+","pin function tags reach the netlist JSON");
  assert.ok(comps.flatMap(c=>c.pins).filter(p=>p.fn).length===1,"untagged pins carry no fn");

  // ------------------------------------------------- proposals.propose
  await X.install(pkg({id:"test.sim",activationEvents:["onCommand:sim.save","onCommand:sim.fields","onCommand:sim.probe","onCommand:sim.clear"],permissions:["read:project","propose:edits","ui:command","ui:decorations"]},
    `exports.activate = api => {
       api.commands.register("sim.save", () => api.proposals.propose([
         {target: "item", id: ${JSON.stringify(R1.id)}, path: ["sim"], value: {model: "R", params: {r: "10k"}}},
         {target: "definition", id: ${JSON.stringify(D1)}, path: ["sim"], value: {template: "resistor@1"}},
         {target: "project", path: ["simulation", "benches"], value: [{id: "b1", analyses: [{kind: "op"}]}]}], {label: "Save test bench"}));
       api.commands.register("sim.fields", () => api.proposals.fields());
       api.commands.register("sim.probe", items => api.ui.decorations.set(null, items));
       api.commands.register("sim.clear", () => api.ui.decorations.clear());
     };`));
  assert.deepEqual(X.permissions("test.sim").live["propose:edits"],true);
  assert.deepEqual((await X.execute("sim.fields")).project,["simulation"]);
  prompts.length=0;const steps=history.length;
  const saved=await X.execute("sim.save");
  assert.deepEqual(prompts,["review:test.sim"],"a proposal is reviewed by the user");
  assert.equal(saved.applied,3);assert.equal(history.length,steps+1,"one undo step");
  assert.deepEqual(parts()[0].sim,{model:"R",params:{r:"10k"}});
  assert.equal(project.library.find(d=>d.id===D1).sim.template,"resistor@1");
  assert.equal(project.simulation.benches[0].id,"b1");
  // The review is the visual diff's property table: one group per changed object, before and after.
  const groups=AtriumDiffProps.proposalGroups(reviews.at(-1).rows);
  assert.equal(groups.length,3);assert.ok(groups.every(g=>g.status==="properties"&&g.rows.every(r=>r.changed&&r.after)));
  assert.ok(groups.some(g=>g.title==="Project"&&g.rows[0].label==="simulation"));
  // Unchanged: nothing to review.
  prompts.length=0;
  assert.deepEqual(await X.execute("sim.save"),{applied:0,unchanged:true});assert.deepEqual(prompts,[]);

  // ------------------------------------------------- decorations
  const probe=await X.execute("sim.probe",[{kind:"probe",text:"1.65 V",anchor:{id:R1.id,pin:String(def.symbol.pins[0].number)}},{kind:"label",text:"OP",at:[10,20]}]);
  assert.equal(probe.count,2);assert.ok(invalidations>0);
  let calls=paint(sheet());
  assert.deepEqual(texts(calls).sort(),["1.65 V","OP"],"decorations are drawn as canvas text");
  assert.deepEqual(paint(project.documents.find(d=>d.kind==="pcb")).length,0,"only on their own document");
  // The anchor follows its part.
  const at0=calls.find(c=>c[0]==="fillText"&&c[1]==="1.65 V");
  host.edit(()=>{parts()[0].x+=5;parts()[0].y+=0;},"Move");
  const at1=paint(sheet()).find(c=>c[0]==="fillText"&&c[1]==="1.65 V");
  assert.ok(Math.abs(at1[2]-at0[2]-20)<1e-6,"anchored decorations follow the object");

  // ------------------------------------------------- write:edits does not skip the review
  await X.install(pkg({id:"test.both",activationEvents:["onCommand:both.go"],permissions:["read:project","propose:edits","write:edits","ui:command"]},
    `exports.activate = api => api.commands.register("both.go", v => api.proposals.propose([{target: "item", id: ${JSON.stringify(R1.id)}, path: ["value"], value: v}]));`));
  X.grant("test.both","write:edits",true);
  prompts.length=0;
  assert.equal((await X.execute("both.go","22k")).applied,1);
  assert.deepEqual(prompts,["review:test.both"],"proposals.propose always asks, even with write:edits");

  // ------------------------------------------------- a malicious extension
  await X.install(pkg({id:"evil.ext",activationEvents:["onCommand:evil.go"],permissions:["read:project","propose:edits","ui:command","ui:decorations"]},
    `exports.activate = api => {
       const r1 = ${JSON.stringify(R1.id)};
       const tryIt = async f => { try { return {ok: await f()}; } catch (e) { return {error: e.message}; } };
       api.commands.register("evil.go", async what => {
         if (what === "ref") return tryIt(() => api.proposals.propose([{target: "item", id: r1, path: ["ref"], value: "X1"}]));
         if (what === "code") return tryIt(() => api.proposals.propose([{target: "project", path: ["extensions"], value: [{id: "evil"}]}]));
         if (what === "scripts") return tryIt(() => api.proposals.submit({format: "atrium-ai", version: 2, project: ${JSON.stringify(project.name)}, ops: [{op: "set", target: "project", path: ["scripts"], after: ["alert(1)"]}]}));
         if (what === "proto") return tryIt(() => api.proposals.propose([{target: "item", id: r1, path: ["sim", "__proto__", "x"], value: 1}]));
         if (what === "value") return tryIt(() => api.proposals.propose([{target: "item", id: r1, path: ["value"], value: "666"}], {label: "Harmless"}));
         if (what === "spam") return tryIt(() => api.ui.decorations.set(null, Array.from({length: 2001}, (_, i) => ({text: "x" + i, at: [0, 0]}))));
         if (what === "huge") return tryIt(() => api.ui.decorations.set(null, Array.from({length: 1500}, () => ({text: "y".repeat(400), at: [0, 0]}))));
         if (what === "html") return tryIt(() => api.ui.decorations.set(null, [{text: "<img src=x onerror=alert(1)>\\u202e\\u0007ok", at: [1, 1]}]));
         if (what === "field") return tryIt(() => api.ui.decorations.set(null, [{text: "a", at: [1, 1], html: "<b>a</b>"}]));
         if (what === "nan") return tryIt(() => api.ui.decorations.set(null, [{text: "a", at: [1e9, 0]}]));
         if (what === "rate") { let last = null; for (let i = 0; i < 25; i++) last = await tryIt(() => api.ui.decorations.set(null, [{text: "r", at: [0, 0]}])); return last; }
         if (what === "dom") return {document: typeof document, window: typeof window, parent: typeof parent, top: typeof top, localStorage: typeof localStorage, importScripts: typeof importScripts};
         if (what === "panelHtml") return tryIt(() => api.ui.setPanel("nope", [{type: "html", html: "<script>"}]));
       });
     };`));
  const snapshot=JSON.stringify(project),evil=w=>X.execute("evil.go",w);
  prompts.length=0;
  assert.match((await evil("ref")).error,/ref cannot be proposed/,"only whitelisted fields");
  assert.match((await evil("code")).error,/extensions cannot be proposed/);
  assert.match((await evil("scripts")).error,/holds code/,"code fields are refused in any proposal");
  assert.match((await evil("proto")).error,/path must list/);
  assert.deepEqual(prompts,[],"refused proposals never reach the user");
  answers.review=false;
  assert.deepEqual((await evil("value")).ok,{applied:0,declined:true},"without approval nothing applies");
  assert.equal(JSON.stringify(project),snapshot);
  prompts.length=0;
  assert.match((await evil("value")).error,/already declined/,"a denial is final: no silent retry");
  assert.deepEqual(prompts,[],"the retry shows no dialog");
  assert.equal(JSON.stringify(project),snapshot);
  answers.review=r=>r.rows.map(x=>x.index);
  assert.match((await evil("spam")).error,/at most 2000/,"oversize decorations are refused");
  assert.match((await evil("huge")).error,/larger than/);
  assert.match((await evil("field")).error,/unknown field html/);
  assert.match((await evil("nan")).error,/within/);
  assert.equal((await evil("html")).ok.count,1);
  calls=paint(sheet());
  assert.ok(texts(calls).includes("<img src=x onerror=alert(1)>ok"),"markup is drawn as plain text; control and bidi characters are removed");
  assert.match((await evil("rate")).error,/calls per second/,"decorations are rate limited");
  assert.deepEqual(await evil("dom"),{document:"undefined",window:"undefined",parent:"undefined",top:"undefined",localStorage:"undefined",importScripts:"undefined"},"no DOM in the extension realm");
  assert.ok((await evil("panelHtml")).error,"an undeclared panel cannot be written");
  // Disabling an extension clears its decorations; another extension's stay.
  await X.setEnabled("evil.ext",false);
  calls=paint(sheet());
  assert.ok(!texts(calls).some(t=>/img|^r$/.test(t)),"disabled: its decorations are gone");
  assert.ok(texts(calls).includes("OP"),"other extensions' decorations stay");
  X.grant("test.sim","ui:decorations",false);
  assert.equal(paint(sheet()).length,0,"revoking ui:decorations clears them");
  assert.equal(renderers.size,0,"no renderer while nothing is decorated");
  X.grant("test.sim","ui:decorations",true);

  // ------------------------------------------------- run:external
  await X.install(pkg({id:"test.connector",activationEvents:["onCommand:ext.go"],permissions:["run:external","ui:command"],
    contributes:{commands:[{command:"ext.go",title:"Go"}],externalTools:[{id:"ngspice",name:"ngspice",args:["-b","-r"]}]}},
    `exports.activate = api => api.commands.register("ext.go", async what => {
       try {
         if (what === "tools") return await api.external.tools();
         if (what === "other") return await api.external.run("ltspice", {args: ["-b"]});
         if (what === "nul") return await api.external.run("ngspice", {args: ["a\\u0000b"]});
         if (what === "path") return await api.external.run("ngspice", {files: {"../evil": "x"}});
         if (what === "slow") return await api.external.run("ngspice", {args: ["-b", "slow.cir"], runId: "slow"});
         return await api.external.run("ngspice", {args: ["-b", "deck.cir"], files: {"deck.cir": "* deck\\n.end\\n"}, outputs: ["*.raw"], timeoutMs: 5000});
       } catch (e) { return {error: e.message}; }
     });`));
  const ext=w=>X.execute("ext.go",w);
  assert.equal((await ext("tools")).available,false,"the browser build reports external tools unavailable");
  assert.match((await ext()).error,/desktop app/);
  // A desktop host: it keeps the user's choices and runs only those (the native side approves).
  const ran=[],cancelled=[];let deny=false,enteredRun;
  globalThis.AtriumHost={
    externalToolList:async()=>({platform:"macos",tools:{ngspice:{path:"/opt/homebrew/bin/ngspice",name:"ngspice"}}}),
    externalToolProbe:async paths=>paths.filter(p=>p==="/opt/homebrew/bin/ngspice"),
    externalRun:async r=>{ran.push(r);if(deny)return {denied:true};
      if(r.args.includes("slow.cir"))return new Promise(res=>{globalThis.__finish=()=>res({exitCode:null,cancelled:true,stdout:"",stderr:"",files:[]});enteredRun();});
      return {exitCode:0,durationMs:12,stdout:AtriumExternalTools.toBase64(new TextEncoder().encode("Circuit: deck\n")),stderr:"",files:[{name:"deck.raw",data:AtriumExternalTools.toBase64(new TextEncoder().encode("Values:\n0 1.0\n"))}]};},
    externalCancel:k=>{cancelled.push(k);globalThis.__finish?.();}
  };
  const tools=await ext("tools");
  assert.deepEqual(tools,{available:true,reason:null,tools:[{id:"ngspice",name:"ngspice",configured:true}]},"extensions learn whether a tool is set, never its path");
  assert.deepEqual(await AtriumExternalTools.candidates("ngspice"),["/opt/homebrew/bin/ngspice"]);
  const out=await ext();
  assert.equal(out.exitCode,0);assert.equal(out.stdout,"Circuit: deck\n");assert.deepEqual(out.files,[{name:"deck.raw",size:14,text:"Values:\n0 1.0\n"}]);
  const sent=ran.at(-1);
  assert.deepEqual([sent.tool,sent.args,sent.outputs,sent.extension,sent.timeoutMs],["ngspice",["-b","deck.cir"],["*.raw"],"test.connector",5000]);
  assert.equal(sent.files[0].name,"deck.cir");assert.ok(!("path" in sent),"the page never sends a program path");
  // The host keys its approval by extension version and checks the declared argument template.
  assert.match(sent.extensionHash,/^sha256:[0-9a-f]{64}$/,"the extension's content hash (id@sha256, as trust and grants)");
  assert.deepEqual(sent.argTemplate,["-b","-r"],"the manifest's argument template");
  await ext();assert.equal(ran.at(-1).extensionHash,sent.extensionHash,"the same version sends the same hash");
  assert.match((await ext("other")).error,/does not declare the external tool ltspice/,"only declared tools");
  assert.match((await ext("nul")).error,/NUL/);assert.match((await ext("path")).error,/plain names/);
  const started=new Promise(resolve=>{enteredRun=resolve;}), slow=ext("slow");
  await Promise.race([started,slow.then(()=>assert.fail("the slow tool exited before starting"))]);
  await X.setEnabled("test.connector",false);
  assert.ok(cancelled.includes(ran.at(-1).runId),"stopping the extension cancels its runs");
  await slow.catch(()=>{});
  await X.setEnabled("test.connector",true);
  const getTools = AtriumHost.externalToolList; let releaseLookup, enteredLookup;
  const querying = new Promise(resolve => { enteredLookup = resolve; });
  AtriumHost.externalToolList = () => new Promise(resolve => { releaseLookup = async () => resolve(await getTools()); enteredLookup(); });
  const beforeLookup = ran.length, deferred = ext();
  await Promise.race([querying, deferred.then(() => assert.fail("the tool exited before looking up its configuration"))]);
  await X.setEnabled("test.connector", false);
  await releaseLookup(); await deferred.catch(() => {});
  assert.equal(ran.length, beforeLookup, "deactivating an extension during lookup prevents a native run");
  AtriumHost.externalToolList = getTools;
  await X.setEnabled("test.connector", true);
  deny=true;assert.match((await ext()).error,/did not allow/,"the user's denial in the host dialog is reported");deny=false;
  const asked=ran.length;
  assert.match((await ext()).error,/Disable and enable/,"a denied program is not asked about again");
  assert.equal(ran.length,asked,"no second approval request reaches the host");
  // An update (other code, same id) is another version: the host asks again.
  await X.install(pkg({id:"test.connector",activationEvents:["onCommand:ext.go"],permissions:["run:external","ui:command"],
    contributes:{commands:[{command:"ext.go",title:"Go"}],externalTools:[{id:"ngspice",name:"ngspice",args:["-b","-r"]}]}},
    `// v2
     exports.activate = api => api.commands.register("ext.go", async () => {
       try { return await api.external.run("ngspice", {args: ["-b", "deck.cir"], files: {"deck.cir": "* deck\\n"}}); } catch (e) { return {error: e.message}; }
     });`));
  const updated=await ext();
  assert.equal(updated.exitCode,0,JSON.stringify(updated));
  assert.match(ran.at(-1).extensionHash,/^sha256:[0-9a-f]{64}$/);
  assert.notEqual(ran.at(-1).extensionHash,sent.extensionHash,"an update sends its own hash, so the host asks again");
  delete globalThis.AtriumHost;

  // One inspector source, with declarations that opt into the normal extension lifecycle.
  const fs = require("node:fs"), source = __dirname + "/../../extensions/developer/motion-inspector/";
  const files = Object.fromEntries(["waffle-extension.json", "main.js"].map(name => [name, fs.readFileSync(source + name, "utf8")]));
  const manifest = JSON.parse(files["waffle-extension.json"]), motionId = manifest.id;
  for (const name of ["motion-inspector.js", "motion-inspector.css"]) assert.equal(fs.existsSync(__dirname + "/../../app/editor/" + name),false);
  for (const name of ["editor/theme-picker.js","automation/editor-command-host.js"]) {
    const former = fs.readFileSync(__dirname + "/../../app/" + name,"utf8");
    assert.doesNotMatch(former,/AtriumMotionInspector|motion-inspector/);
  }
  assert.deepEqual(manifest.permissions,["read:motion","ui:command","ui:panel"]);
  assert.equal(AtriumBuiltinExtensionManifests.some(e=>e.manifest.id===motionId),false);
  require("../../app/editor/editor-motion.js");
  require("../../app/automation/command-broker.js");
  require("../../app/editor/motion-service.js");
  globalThis.AtriumButterCatalog={motion:require("../../app/automation/descriptors/motion.json")};
  const {inspect}=AtriumMotionDiagnostics;
  let motionReads=0;
  globalThis.AtriumMotionDiagnostics={inspect(action,args){ motionReads++; return inspect(action,args); }};
  assert.equal(AtriumButter.state("motion").enabled,false,"diagnostics do not turn on Butter Motion");
  const motionWorker=()=>X.workers.some(w=>w.pool==="ext:"+motionId);
  await X.install(files);
  await assert.rejects(X.execute("motion-inspector.open"),/Unknown command/);
  await X.setEnabled(motionId,true);
  assert.equal(motionWorker(),false,"enable is passive");
  const beforeMotion=JSON.stringify(project);
  await X.grant(motionId,"read:motion",false);
  await X.execute("motion-inspector.open");
  assert.equal(motionReads,0,"an ungranted worker cannot reach the host motion commands");
  await X.grant(motionId,"read:motion",true);
  await X.execute("motion-inspector.open");
  assert.ok(motionReads>=7,"the installed worker reads the exact motion commands");
  assert.equal(JSON.stringify(project),beforeMotion);
  const motionOnly=AtriumAPI.create(host,{extension:{id:"test.motion-only",permissions:{"read:motion":true}},inspectMotion:inspect}).api;
  assert.deepEqual(await motionOnly.motion.inspect("active"),{count:0});
  assert.equal((await motionOnly.motion.inspect("sample",{from:0,to:80,elapsedMs:50,durationMs:200,curve:"linear"})).value,20);
  await assert.rejects(motionOnly.motion.inspect("sample",{from:0,to:80,elapsedMs:-1,durationMs:200}),/elapsedMs/);
  await assert.rejects(motionOnly.motion.inspect("transaction.commit"),/Unknown motion diagnostic/);
  assert.throws(()=>motionOnly.project.info(),/read:project/);
  await X.setEnabled(motionId,false);
  assert.equal(motionWorker(),false,"disable retires the owner worker");

  X.shutdown();
  console.log("extensions host API tests passed");
})();
globalThis.__testDone=done.catch(e=>{console.error(e);X.shutdown();if(globalThis.process)process.exitCode=1;throw e;});
