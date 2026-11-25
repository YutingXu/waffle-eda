"use strict";

// Run the actual editor with the DOM and simulated local IO from integration.cjs.
const assert = require("node:assert/strict");
const {File} = require("node:buffer");
const fs = require("node:fs"), path = require("node:path");
const {Worker} = require("node:worker_threads");
const {setup} = require("../integration/integration.cjs");

async function check(workers) {
  const {window,document,ruleFiles,folders}=await setup();
  const pool=globalThis.AtriumWorkerPool;
  globalThis.AtriumWorkerPool={...pool,script(name){
    const local=String(name).split("/").pop();
    if(local!=="diff-worker.js")return pool.script(name);
    const thread=new Worker(require.resolve("../workers/import-worker.cjs"),{workerData:{source:"importScripts("+JSON.stringify(local)+")"}});
    const worker={postMessage:(...args)=>thread.postMessage(...args),terminate:()=>thread.terminate()};
    thread.on("message",data=>worker.onmessage?.({data}));
    thread.on("error",error=>worker.onerror?.(error));
    workers.push(worker);return worker;
  }};
  const manifest="Sensor.waffle", C=AtriumFormat2, M=AtriumFormat2Model;
  function nativeFiles(project){
    const storage=M.fromEditor(project,{manifestPath:manifest});
    return new Map([...storage.files.map(r=>[r.path,C.serialize(r.file)]),...[...storage.assets,...storage.models].map(r=>[r.path,r.bytes])]);
  }
  const node=(selector,scope=document)=>{
    const n=scope.querySelector(selector);assert.ok(n,selector);return n;
  };
  const openTable=async()=>{
    node('[data-action="compare"]').click();
    await until(()=>document.querySelector('dialog[open][aria-label="Change table"]'),"open change table");
  };
  const dialog=()=>node('dialog[open][aria-label="Change table"]');
  const status=()=>node('[role="status"]',dialog()).textContent;
  const button=(name,scope=dialog())=>{
    const n=[...scope.querySelectorAll("button")].find(b=>b.textContent.trim()===name);
    assert.ok(n,"missing button "+name+" in "+scope.textContent.slice(0,160));return n;
  };
  const list=()=>node('[role="listbox"][aria-label="Changed objects"]',dialog());
  const options=()=>Array.from(list().querySelectorAll('[role="option"]'));
  const selected=()=>node('[role="option"][aria-selected="true"]',list());
  const details=()=>node('[aria-label="Change details"]',dialog());
  const tick=()=>new Promise(resolve=>setTimeout(resolve,6));
  async function until(check,label){
    const deadline=Date.now()+4000;
    while(!check()){
      if(Date.now()>deadline)assert.fail(label+"; "+(document.querySelector('dialog[open] [role="status"]')?.textContent||node('#status').textContent)+"; "+Array.from(document.querySelectorAll('.rev-list [role="option"]'),row=>row.textContent).slice(0,4).join(" | "));
      await tick();
    }
  }
  function event(el,name,props={}){
    const e=new window.Event(name,{bubbles:true,cancelable:true});
    Object.assign(e,props);el.dispatchEvent(e);
  }
  function control(label,value,name="change"){
    const input=node('[aria-label="'+label+'"]',dialog());input.value=value;event(input,name);
  }
  async function search(term,check,label){
    control("Find revision changes",term,"input");await until(check,label);
  }
  function rowValues(label){
    const tr=[...details().querySelectorAll("tr")].find(n=>n.firstElementChild?.textContent.trim()===label);
    assert.ok(tr,"missing detail field "+label);return [...tr.children].map(c=>c.textContent.trim());
  }
  async function clickAndWait(name,check){button(name).click();await until(()=>!/^(Reading|Comparing) /.test(status()) && check(),name);}
  async function choose(project,name){
    const files=nativeFiles(project),read=path=>files.get(path);
    files.set(AtriumImportSidecars.IGNORE,new TextEncoder().encode(AtriumImportSidecars.ignoreText));
    const archive=AtriumProjectArchive,closure=await archive.verifyClosure({manifestPath:manifest,read});
    const {bytes}=await archive.archive({...closure,manifestPath:manifest,read});
    ruleFiles.push(new File([bytes],name));
  }
  const ownerIDs=p=>[p.documents,p.library].map(list=>list.map(owner=>owner.id));
  const authored=ownerIDs(AtriumNavHost.project()),live=await folders.save(),baseline=structuredClone(live);
  assert.deepEqual(ownerIDs(live),authored,"verified Save All retains manifest document and library order");
  assert.deepEqual(ownerIDs(await AtriumNavHost.requireProjectClosure({purpose:"comparison"})),authored,
    "the working folder retains authored order when definitions were loaded by dependency");
  const [sheet,board]=baseline.documents,currentBoard=live.documents.find(d=>d.kind==="pcb");
  const part=board.items.find(i=>i.ref==="R1");
  part.value="18 kΩ";part.x+=2.1;
  sheet.items.find(i=>i.ref==="C1").value="5.1 nF";
  baseline.library.find(i=>i.id===part.def).prefix="OLD_PREFIX";
  // Author the shared rule book before making a second revision of the same design.
  const defaults=AtriumRules.migrate(AtriumRules.defaults());
  baseline.rules={format:"atrium-rules",version:3,units:"mm",list:defaults.list.map(rule=>({...rule,id:Atrium.id()}))};
  const template=board.items.find(i=>i.kind==="via");
  for(let i=0;i<85;i++)board.items.push({...template,id:"deleted-via-"+i,net:"REMOVED_RAIL_"+i});
  const earlier=structuredClone(baseline);
  earlier.documents[1].items.find(i=>i.ref==="R1").value="82 kΩ";
  const headId="123456789abcdef0123456789abcdef012345678", oldId="abcdef9876543210abcdef9876543210abcdef98";
  const host=globalThis.AtriumHost;
  const projects=new Map([[headId,baseline],[oldId,earlier]]), committed=new Map();
  for(const [revision,project] of projects){
    const files={},objects={};
    for(const [name,bytes] of nativeFiles(project)){
      files[name]=C.sha256(bytes);objects[files[name]]=Buffer.from(bytes).toString("base64");
    }
    committed.set(revision,{side:{revision,blob:revision,manifest,files},objects});
  }
  const ruleLineage=revision=>{
    const {side,objects}=committed.get(revision);
    const rows=Buffer.from(objects[side.files[manifest]],"base64").toString("utf8").trimEnd().split("\n").map(JSON.parse);
    return [rows[0].id,rows.filter(row=>row.kind==="rule")];
  };
  assert.deepEqual(ruleLineage(headId),ruleLineage(oldId),"saved revisions share the same project and rule identities");
  let gitCalls=0;
  const commits=[{revision:headId,parents:[oldId],subject:"Tuned divider",date:"2026-11-18"},
    {revision:oldId,parents:[],subject:"Initial divider",date:"2026-11-17"}];
  host.folderGitGrant="review-folder";
  host.gitQuery=async(op,args)=>{
    assert.equal(host.folderGitGrant,"review-folder");
    if(op==="refs")return {head:headId,refs:[]};
    if(op==="log")return {commits};
    assert.equal(op,"folderRevisions");gitCalls++;
    const versions=args.revisions.map(revision=>committed.get(revision));
    return {revisions:versions.map(value=>value.side),objects:Object.assign({},...versions.map(value=>value.objects))};
  };
  await openTable();assert.equal(gitCalls,0,"opening review does not read repository");
  await clickAndWait("Compare with HEAD",()=>options().length===40);
  assert.equal(gitCalls,1);assert.equal(options().length,40);assert.equal(selected().id,list().getAttribute("aria-activedescendant"));
  assert.equal([...details().querySelectorAll("thead th")].map(n=>n.textContent).join("|"),"Field|Before|After");
  assert.ok(list().querySelector('[role="group"][aria-label="'+sheet.name+'"]'));
  const first=selected().id;
  options()[1].click();assert.equal(selected(),options()[1]);options()[0].click();
  event(list(),"keydown",{key:"ArrowDown"});assert.notEqual(selected().id,first);
  event(list(),"keydown",{key:"Home"});assert.equal(selected().id,first);
  event(list(),"keydown",{key:"End"});assert.equal(selected(),options().at(-1));
  await clickAndWait("Next",()=>/41[–-]80/.test(status()));
  await clickAndWait("Next",()=>/81[–-]/.test(status()));assert.ok(options().length>0&&options().length<40);
  assert.equal(button("Next").disabled,true);
  control("Revision area","Library");await until(()=>options().length===1,"library changes");
  assert.ok(list().querySelector('[role="group"][aria-label="Library"]'));
  assert.deepEqual(rowValues("Designator prefix"),["Designator prefix","OLD_PREFIX","R"]);
  control("Revision area","doc:"+sheet.id);await until(()=>options().length===1&&selected().textContent.includes("C1"),"one document");
  control("Revision area","");
  control("Change type","Removed");await until(()=>/1[–-]40/.test(status()),"removed page reset");
  await search("REMOVED_RAIL_79",()=>options().length===1&&selected().textContent.includes("REMOVED_RAIL_79"),"deleted object search");
  assert.ok([...details().querySelectorAll("button")].every(b=>!/^Locate/.test(b.textContent)||b.disabled||b.hidden));
  control("Change type","Changed");await until(()=>/No matching/i.test(status())||/No matching/i.test(dialog().textContent),"empty results");
  control("Revision area","PCB");await search("18 kΩ",()=>options().length===1&&selected().textContent.includes("R1"),"field value search");
  assert.deepEqual(rowValues("Value"),["Value","18 kΩ","10 kΩ"]);
  assert.ok(node('svg[role="img"]',details()).getAttribute("aria-label").includes("Before and after"));
  assert.ok(list().querySelector('[role="group"][aria-label="'+board.name+'"]'));
  await button("Choose project ZIP…").onclick();assert.equal(options().length,1);assert.deepEqual(rowValues("Value"),["Value","18 kΩ","10 kΩ"]);
  const recreated=AtriumParts.example();recreated.id=live.id;
  await choose(recreated,"Recreated sensor.zip");
  await clickAndWait("Choose project ZIP…",()=>status().includes("Recreated sensor.zip")&&status().includes("No differences"));
  const editedPadProject=structuredClone(recreated);
  const editedPad=editedPadProject.library.find(def=>def.id===part.def).footprint.pads[0];
  const beforePadWidth=editedPad.w;
  editedPad.w=Atrium.projectNumber(editedPad.w+.1);
  await choose(editedPadProject,"Wider pad.zip");
  await clickAndWait("Choose project ZIP…",()=>status().includes("Wider pad.zip")&&options().length===1);
  const padWidthRow=[...details().querySelectorAll("tr")].find(row=>/Footprint.*Pad 1.*Width/.test(row.firstElementChild?.textContent));
  assert.ok(padWidthRow,"a real pad-width edit appears in the revision details");
  assert.deepEqual([...padWidthRow.children].slice(1).map(cell=>cell.textContent.trim()),[editedPad.w+" mm",beforePadWidth+" mm"]);
  assert.doesNotMatch(details().textContent,/Native Id/);
  ruleFiles.push(new File([fs.readFileSync(path.join(__dirname,"../fixtures/compat/projects/v1.4-sample.atrium"))],"Historical.atrium"));
  await clickAndWait("Choose project ZIP…",()=>status()==="This file is from a pre-release Waffle build; re-import the design from its source EDA");
  assert.equal(options().length,0);
  assert.equal(button("Visual diff").hidden,true);
  const unrelated=Atrium.project("Fabrication drawing");
  unrelated.documents=[];
  unrelated.documents.push(AtriumDrawing.create(unrelated));
  await choose(unrelated,"unrelated.zip");
  await clickAndWait("Choose project ZIP…",()=>/share no document IDs/.test(status()));
  assert.equal(dialog().querySelectorAll('[role="option"]').length,0);
  await choose(baseline,"Review baseline.zip");
  await clickAndWait("Choose project ZIP…",()=>status().includes("Review baseline.zip"));
  assert.equal(options().length,40);assert.equal(node('[aria-label="Find revision changes"]',dialog()).value,"");
  await search("18 kΩ",()=>options().length===1&&selected().textContent.includes("R1"),"locatable placement");
  button("Locate",details()).click();
  assert.equal(document.querySelector('dialog[open]'),null);
  assert.equal(node("#doc-name").textContent,currentBoard.name);assert.equal(node('[aria-label="Designator"]').value,"R1");
  await openTable();
  button("Git history…").click();
  await until(()=>document.querySelectorAll(".gp-dialog .gp-row").length===2,"committed native folders");
  const picker=node(".gp-dialog"),versions=picker.querySelectorAll(".gp-row");
  assert.ok(node('[data-slot="after"]',picker).textContent.includes("Working design"));
  versions[1].click();versions[0].click();button("Compare",picker).click();
  await until(()=>options().length===1,"two saved revisions");
  assert.deepEqual(rowValues("Value"),["Value","82 kΩ","18 kΩ"]);
  assert.ok([...details().querySelectorAll("button")].every(b=>!/^Locate/.test(b.textContent)||b.hidden||b.disabled));
  await choose(live,"Current.zip");await clickAndWait("Choose project ZIP…",()=>/No differences/i.test(dialog().textContent));
  // Earlier comparisons deliberately warmed HEAD. Force a real transport read before
  // testing a failed response and a separate late response after closing the table.
  const originalQuery=host.gitQuery;
  function holdHead(){
    const source=AtriumProjectHistoryData.source(AtriumGit);
    source.refresh({commits:true});
    source.close();
    let release;
    host.gitQuery=async(op,args)=>{
      const value=await originalQuery(op,args);
      if(op==="folderRevisions"&&args.revisions.includes(headId)){
        assert.deepEqual(args.revisions,[headId]);
        await new Promise((resolve,reject)=>{release=error=>error?reject(error):resolve();});
      }
      return value;
    };
    return {pending:()=>!!release,release:error=>release?.(error)};
  }
  let focused;
  const prototype=window.HTMLElement.prototype,focusing=prototype.focus;
  prototype.focus=function(...args){focused=this;return focusing?.apply(this,args);};
  let failed,late;
  try {
    const head=button("Compare with HEAD");
    const ready=dialog();
    failed=holdHead();
    head.click();
    await until(failed.pending,"pending native HEAD read");
    assert.equal(status(),"Reading Git HEAD…");
    assert.equal(head.disabled,true);
    failed.release(Error("The saved revision read was interrupted."));
    await until(()=>status()==="The saved revision read was interrupted."&&!head.disabled,"visible native read failure");
    assert.equal(dialog(),ready);
    assert.equal(head.hidden,false);
    assert.equal(options().length,0);
    host.gitQuery=originalQuery;
    await clickAndWait("Compare with HEAD",()=>options().length===40);
    assert.match(status(),/^HEAD .*Working design/);

    late=holdHead();
    const lateHead=button("Compare with HEAD"), click=lateHead.onclick;
    let operation;
    lateHead.onclick=event=>{operation=click(event);};
    lateHead.click();
    await until(late.pending,"pending native read before closing");
    assert.equal(status(),"Reading Git HEAD…");
    button("Done").click();host.folderGitGrant=null;await openTable();
    assert.ok(button("Compare with HEAD").hidden);
    await choose(earlier,"Earlier.zip");await clickAndWait("Choose project ZIP…",()=>status().includes("Earlier.zip"));
    const activeList=list(), activeRow=selected(), prior=status();
    activeRow.click();
    assert.equal(focused,activeList,"the user focused the new report's change list");
    late.release();await operation;
    assert.equal(status(),prior);
    assert.equal(selected(),activeRow);
    assert.equal(focused,activeList,"the late response does not move the new dialog's focus");
    assert.equal(document.querySelectorAll("dialog.revision-dialog[open]").length,1);
    button("Done").click();assert.deepEqual(await folders.save(),live);
  } finally {
    failed?.release(); late?.release();
    host.gitQuery=originalQuery;
    prototype.focus=focusing;
  }
  console.log("PASS editor revision review: HEAD, file and two historical commits, grouped list, keyboard navigation, pagination, filters, before/after geometry, locate, visible retry, cancellation, late responses and retained focus");
}
async function run(){
  const workers=[];
  try {await check(workers);}
  finally {await Promise.all(workers.map(worker=>worker.terminate()));}
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={run};
