"use strict";

// DOM integration, Node 18+. Install linkedom locally or pass its standalone module:
// node tests/integration/integration.cjs [--dom /path/to/linkedom.mjs] [--fixtures /path/to/fixtures]
// The same HTML, scripts, event handlers and model used in the application run here.
// File dialogs use an in-memory desktop bridge. Canvas commands are observed without rasterization.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const {pathToFileURL} = require("node:url");
const {File, resolveObjectURL} = require("node:buffer");
const {Worker: NodeWorker} = require("node:worker_threads");

// LinkeDOM provides no browser workers. Run the production translator in the
// same isolated thread used by the worker suite, with real message transfers.
class ImportWorker {
  constructor(url) {
    const blob = resolveObjectURL(url);
    if (blob) {
      blob.text().then(source => this.start(source)).catch(error => this.onerror?.(error));
    } else {
      assert.equal(url, pathToFileURL(path.join(__dirname, "../../app/workers/import-worker.js")).href);
      this.start();
    }
  }
  start(source) {
    if (this.stopped) return;
    const thread = this.thread = new NodeWorker(require.resolve("../workers/import-worker.cjs"), {workerData: {source}});
    thread.on("message", data => { if (!this.stopped) this.onmessage?.({data}); });
    thread.on("error", error => { if (!this.stopped) this.onerror?.(error); });
    thread.on("messageerror", () => { if (!this.stopped) this.onmessageerror?.(); });
    thread.on("exit", status => { if (!this.stopped) this.onerror?.(Error("Translator worker exited (" + status + ").")); });
    // The client owns startup and request timers. An idle page worker may exit
    // with the test process when there are no requests left.
    thread.unref();
  }
  postMessage(message, transfers) { this.thread.postMessage(message, transfers); }
  terminate() { this.stopped = true; this.thread?.terminate(); }
}

function option(name, optionalValue=false) {
  const i=process.argv.indexOf(name);
  if(i<0)return null;
  const value=process.argv[i+1];
  if(optionalValue && (!value || value.startsWith("--")))return null;
  assert.ok(value && !value.startsWith("--"),"missing argument for "+name);
  return path.resolve(value);
}

function loadDOM() {
  const domModule=option("--dom",true);
  return domModule ? import(pathToFileURL(domModule).href) : require("linkedom");
}

async function setup({demo=true}={}) {
  const {parseHTML}=await loadDOM();
  const app = path.join(__dirname,"../../app");
  const {window,document} = parseHTML(fs.readFileSync(path.join(app,"index.html"),"utf8"));
  const calls=new Map(), files=new Map(), writes=[], store=new Map(), ruleFiles=[];
  const contexts=new WeakMap(),canvasListeners=new Set();
  window.HTMLCanvasElement.prototype.getContext=function(kind){
    if(kind!=="2d")return null;
    if(!contexts.has(this))contexts.set(this,new Proxy({canvas:this},{
      get(target,name){
        if(name in target)return target[name];
        return (...args)=>{
          calls.set(name,(calls.get(name)||0)+1);
          for(const observe of canvasListeners)observe(target.canvas,name,args);
          if(name==="measureText")return {width:String(args[0]).length*7};
          if(name==="getImageData"){const [, ,width,height]=args;return {width,height,data:new Uint8ClampedArray(width*height*4)};}
          if(name==="getTransform")return {a:1,b:0,c:0,d:1,e:0,f:0};
        };
      }
    }));
    return contexts.get(this);
  };
  const prototype=window.HTMLElement.prototype;
  prototype.getBoundingClientRect=function(){
    const top=this.id==="parts"?-(this.closest(".pane-scroll")?.scrollTop||0):0;
    return {x:0,y:top,left:0,top,width:this.id==="canvas"?880:84,height:this.id==="canvas"?680:50};
  };
  prototype.getClientRects=function(){
    for(let n=this;n?.nodeType===1;n=n.parentElement)if(n.hidden||n.style.display==="none"||n.classList.contains("dock-inactive"))return [];
    return this.isConnected?[this.getBoundingClientRect()]:[];
  };
  // LinkeDOM has no layout observer. Deliver changed visible sizes when an observed
  // pane is attached, hidden, or made active by the real dock controls.
  const observers=new Set();
  let resizeQueued=false;
  function queueResizes(){
    if(resizeQueued)return;
    resizeQueued=true;
    setTimeout(()=>{
      resizeQueued=false;
      for(const observer of observers){
        const entries=[];
        for(const [target,previous] of observer.targets){
          const contentRect=target.getClientRects()[0]||{width:0,height:0};
          if(previous?.width===contentRect.width&&previous?.height===contentRect.height)continue;
          observer.targets.set(target,contentRect);entries.push({target,contentRect});
        }
        if(entries.length)observer.callback(entries,observer);
      }
    },0);
  }
  class ResizeObserver{
    constructor(callback){this.callback=callback;this.targets=new Map();}
    observe(target){this.targets.set(target,null);observers.add(this);queueResizes();}
    unobserve(target){this.targets.delete(target);if(!this.targets.size)observers.delete(this);}
    disconnect(){this.targets.clear();observers.delete(this);}
  }
  new window.MutationObserver(queueResizes).observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:["class","hidden","style"]});
  for(const [property,axis] of [["clientWidth","width"],["clientHeight","height"]])Object.defineProperty(prototype,property,{configurable:true,get(){return this.getBoundingClientRect()[axis];}});
  prototype.setPointerCapture=()=>{};
  prototype.select=()=>{};
  // Reflect the custom validity state that the Rules editor checks before applying a query.
  const input=window.HTMLInputElement.prototype;
  input.setCustomValidity=function(message){this.validationMessage=String(message);this.toggleAttribute("data-test-invalid",!!message);};
  input.reportValidity=function(){return !this.validationMessage;};
  // LinkeDOM has no top layer or :modal selector. Track showModal separately from a
  // non-modal dialog's open attribute so the editor keeps its keyboard focus rules.
  for(const owner of [window.Document.prototype,window.Element.prototype]){
    for(const method of ["querySelector","querySelectorAll","matches","closest"]){
      const original=owner[method];
      if(original)owner[method]=function(selector){return original.call(this,selector.replace(/:modal\b/g,"[data-test-modal]").replace(/:invalid\b/g,"[data-test-invalid]"));};
    }
  }
  prototype.showModal=function(){this.setAttribute("data-test-modal","");this.setAttribute("open","");this.open=true;};
  prototype.close=function(){
    if(!this.hasAttribute("open"))return;
    this.removeAttribute("data-test-modal");this.removeAttribute("open");this.open=false;
    setTimeout(()=>this.dispatchEvent(new window.Event("close")),0);
  };
  window.HTMLSelectElement.prototype.add=function(o){this.append(o);};
  Object.defineProperty(window.HTMLSelectElement.prototype,"value",{
    configurable:true,get(){return this._value ?? this.querySelector("option")?.value;},set(v){this._value=v;}
  });
  const write=async(name,text)=>{writes.push({name,text});return true;};
  const host={
    pickFile:async()=>ruleFiles.shift()||null,exportFile:write,open:async()=>Array.from(files,([name,bytes])=>new File([bytes],name)),setDirty(){}
  };
  const interval=globalThis.setInterval;
  Object.assign(globalThis,{
    window,self:window,document,location:new URL(pathToFileURL(path.join(app,"index.html"))),AtriumHost:host,
    Option:class {constructor(name,value){const o=document.createElement("option");o.value=value;o.textContent=name;return o;}},
    addEventListener:window.addEventListener,removeEventListener:window.removeEventListener,dispatchEvent:window.dispatchEvent,
    Event:window.Event,CustomEvent:window.CustomEvent,MutationObserver:window.MutationObserver,HTMLElement:window.HTMLElement,
    CSS:{escape:s=>Array.from(String(s),c=>"\\"+(c.codePointAt(0)||0xfffd).toString(16)+" ").join("")},
    requestAnimationFrame:cb=>setTimeout(()=>cb(performance.now()),0),cancelAnimationFrame:clearTimeout,
    requestIdleCallback:cb=>setTimeout(()=>cb({didTimeout:false,timeRemaining:()=>8}),0),cancelIdleCallback:clearTimeout,
    // A browser page owns its background timers. Heartbeats may run during a test
    // without keeping the Node process alive after the last test assertion.
    setInterval:(...args)=>interval(...args).unref(),
    ResizeObserver,matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}}),
    getComputedStyle:node=>node.style,innerWidth:1440,innerHeight:900,
    localStorage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,String(value)),removeItem:key=>store.delete(key)}
  });
  const loaded=new Set(),readScript=src=>{
    if(loaded.has(src))return;
    loaded.add(src);
    const file=path.join(app,src);
    if(src==="vendor/cfb.min.js")globalThis.CFB=require(file);
    // Supply this capability only to the translator. Other modules keep their
    // existing LinkeDOM host environment.
    else if(src==="workers/import-worker-client.js")vm.compileFunction(fs.readFileSync(file,"utf8"),["Worker"],{filename:file})(ImportWorker);
    else vm.runInThisContext(fs.readFileSync(file,"utf8"),{filename:file});
  };
  // LinkeDOM parses the page but does not execute its scripts or emit normal loading events.
  // Register inline feature gates in document order, then expose the whole offline build.
  document.readyState="loading";
  const append=document.head.append.bind(document.head);
  document.head.append=(...nodes)=>{
    append(...nodes);
    for(const n of nodes)if(n.localName==="script" || n.localName==="link")queueMicrotask(()=>{
      if(n.localName==="script")readScript(n.getAttribute("src"));
      n.onload?.();
    });
  };
  for(const node of [...document.querySelectorAll("script")]){
    if(node.hasAttribute("src"))readScript(node.getAttribute("src"));
    else if(node.textContent.trim())vm.runInThisContext(node.textContent,{filename:"index.html"});
  }
  // Keep opt-in features and their dependents out of the ordinary editor preload.
  // Real first-use requests still load the complete dependency graph.
  const lazy = globalThis.AtriumLazy;
  const optedIn = new Set(lazy.files("AtriumButterEditor"));
  const ordinary = lazy.modules().filter(name => !lazy.files(name).some(file => optedIn.has(file)));
  for (const file of lazy.files(ordinary)) readScript(file);
  require("../support/folder-worker.cjs")();
  const folders=require("../support/editor-folders.cjs")(host);
  // These fixtures enter through File > Open in a blank editor. Use its saved startup preference
  // so the first-launch Home dialog cannot take focus during later pointer and keyboard steps.
  if(!demo)AtriumPrefs.set("general.startPage","never");
  document.readyState="interactive";document.dispatchEvent(new window.Event("DOMContentLoaded",{bubbles:true}));
  document.readyState="complete";window.dispatchEvent(new window.Event("load"));
  // Existing-object tests use the demo. File-open fixtures start in a new editor.
  if(demo)await AtriumNavHost.replaceProject(AtriumParts.example(),{copy:true,dirty:false});
  async function openPanel(id){
    const selected=()=>document.querySelector('[data-dock-tab="'+id+'"][aria-selected="true"]');
    if(selected())return;
    document.querySelector('#sub-window-panels [data-dock-target="'+id+'"]').click(); // Window › Panels
    const deadline=Date.now()+3500;
    while(!selected()){
      if(Date.now()>deadline)assert.fail("Opening panel "+id);
      await new Promise(resolve=>setTimeout(resolve,8));
    }
  }
  return {window,document,calls,files,writes,ruleFiles,openPanel,folders,
    onCanvasCall(fn){canvasListeners.add(fn);return ()=>canvasListeners.delete(fn);}};
}

async function run(){
  const {window,document,calls,files,writes,ruleFiles,openPanel,folders}=await setup({demo:false});
  assert.equal(typeof AtriumRules.compiled, "function");
  assert.equal(typeof AtriumMotion.sample, "function");
  assert.equal(globalThis.AtriumMotionDiagnostics, undefined, "ordinary startup leaves developer diagnostics cold");
  assert.equal(globalThis.AtriumButterEditor, undefined, "ordinary startup leaves Butter opt-in commands cold");
  const sample=AtriumParts.example(), sampleBoard=sample.documents.find(d=>d.kind==="pcb");
  await folders.openModel(sample);
  await AtriumNavHost.folderProject().requireClosure({purpose:"editor fixture"});
  await AtriumNavHost.selectDocument(sampleBoard.id);
  const fixtureDirectory=option("--fixtures");
  const step=()=>new Promise(resolve=>setTimeout(resolve,8));
  async function until(fn,context,timeout=3500){
    const deadline=Date.now()+timeout;
    while(!fn()){if(Date.now()>deadline)assert.fail(context+"; status = "+document.getElementById("status").textContent);await step();}
  }
  function node(selector){const element=document.querySelector(selector);assert.ok(element,selector);return element;}
  function action(name){node('[data-action="'+name+'"]').click();}
  async function selectComponent(id){
    const row='#parts [data-part="'+id+'"]';
    await openPanel("components");
    await until(()=>document.querySelector(row),"find component "+id);
    node(row).click();
    await openPanel("properties");
  }
  // Opening into this window: "Replace project" for a saved project, "Don’t Save" for one with unsaved changes.
  const replaceChoice=()=>[...document.querySelectorAll("dialog[open] button")].find(n=>["Replace project","Don’t Save"].includes(n.textContent));
  function button(selector,label){const buttons=[...document.querySelectorAll(selector)],b=buttons.find(n=>n.textContent.includes(label));assert.ok(b,selector+" "+label+"; available: "+buttons.map(n=>n.textContent.trim()).join(", "));b.click();}
  function change(label,value){const input=node('[aria-label="'+label+'"]');input.value=value;input.dispatchEvent(new window.Event("change",{bubbles:true}));}
  function key(k){const e=new window.Event("keydown",{bubbles:true,cancelable:true});Object.assign(e,{key:k,code:k});node("#canvas").dispatchEvent(e);}
  function pointerEvent(type,x,y){
    const e=new window.Event(type,{bubbles:true,cancelable:true});
    Object.assign(e,{button:0,pointerId:1,clientX:x,clientY:y});node("#canvas").dispatchEvent(e);
  }
  function pointer(x,y){pointerEvent("pointerdown",x,y);pointerEvent("pointerup",x,y);}
  const status=()=>node("#status").textContent;
  const save=folders.save;
  function closeDialog(){const dlg=node("dialog[open]");dlg.close();if(dlg.isConnected && dlg.id!=="library-dialog")dlg.remove();}
  await until(()=>calls.get("stroke")>0,"first frame");
  assert.equal(node("#doc-name").textContent,"Sensor board");
  button("#documents button","Analog front end");assert.equal(node("#doc-kind").textContent,"Schematic");
  await selectComponent("s-R1");
  const initial=node('[aria-label="Comment"]').value;
  change("Comment","47 kΩ");action("undo");assert.equal(node('[aria-label="Comment"]').value,initial);
  action("redo");assert.equal(node('[aria-label="Comment"]').value,"47 kΩ");
  action("eco");await until(()=>[...document.querySelectorAll("dialog[open] button")].some(b=>/^Execute \d+ Changes?$/i.test(b.textContent)),"ECO review");
  const execute=[...document.querySelectorAll("dialog[open] button")].find(b=>/^Execute \d+ Changes?$/i.test(b.textContent));
  execute.click();const warning=[...document.querySelectorAll("dialog[open] button")].find(b=>b.textContent==="Execute anyway");
  if(warning)warning.click();
  await until(()=>node("#doc-name").textContent==="Sensor board","execute ECO on the board");
  button("#documents button","Analog front end");await selectComponent("s-R1");
  button("#inspector button","Show on board");assert.equal(node("#doc-name").textContent,"Sensor board");
  assert.equal(node('[aria-label="Comment"]').value,"47 kΩ");
  const baseline=await save(), board=p=>p.documents.find(d=>d.kind==="pcb");
  for(const [cmd,title] of [["mcp","AI integration"],["rules","Rules and Constraints Editor"],["blocks","Layout blocks"],["symbols","Symbol styles"]]){
    action(cmd);await until(()=>document.querySelector("dialog[open] h2"),"open "+cmd);assert.equal(node("dialog[open] h2").textContent.toLowerCase(),title.toLowerCase());
    if(cmd==="rules"){
      // A document tab over the pane (doc-views.js), not a floating window: Escape shows the canvas and keeps the tab.
      assert.ok(node(".doc-view:not([hidden]) dialog.rules-window"),"the editor is in a view over the pane");
      const tab=node('#document-tabs .view-tab[data-view="rules"]');assert.equal(tab.getAttribute("aria-selected"),"true");
      {const e=new window.Event("keydown",{bubbles:true});e.key="Escape";node("dialog.rules-window").dispatchEvent(e);}
      assert.ok(node('.doc-view[data-view="rules"]').hidden,"Escape shows the canvas");assert.equal(tab.getAttribute("aria-selected"),"false");
      tab.click();assert.equal(node('.doc-view[data-view="rules"]').hidden,false,"its tab shows it again");
    }
    if(cmd==="mcp"){
      const input=node("[data-project-path]"),copy=node("[data-copy-config]"),preview=node("[data-config-preview]");
      assert.equal(copy.disabled,true);input.value='/home/designer/A&B \"prototype\".waffle';input.oninput();assert.equal(copy.disabled,false);
      const expected=JSON.parse(preview.textContent);assert.equal(expected.mcpServers["waffle-eda"].args[2],input.value);
      let copied;Object.defineProperty(globalThis,"navigator",{configurable:true,value:{clipboard:{writeText:async(text)=>{copied=text;}}}});
      await copy.onclick();assert.equal(copied,preview.textContent);assert.equal(node("[data-copy-status]").textContent,"Copied");
    }
    closeDialog();
  }
  // R1 is selected on the board after cross-probing. Moving it disconnects both lands.
  change("X (mm)",42);key("Escape");
  function openSection(title){
    const item=[...document.querySelectorAll("#inspector details")].find(d=>d.querySelector("summary")?.textContent===title);
    assert.ok(item,title);item.open=true;item.ontoggle();
  }
  openSection("Connectivity");
  const toggleSelector='#inspector [data-action="unrouted"]',overlay=node(toggleSelector).getAttribute("aria-pressed");
  node(toggleSelector).click();assert.notEqual(node(toggleSelector).getAttribute("aria-pressed"),overlay);
  action("connectivity");await until(()=>document.querySelector('dialog[open] h2')?.textContent==="Board connectivity","board connectivity");
  const search=node('[aria-label="Find a net or terminal"]');search.value="VIN";search.oninput();
  const gap=node("dialog[open] .review-line");
  assert.match(gap.textContent,/VIN/);assert.match(gap.textContent,/R1/);
  const pinpoint=[...gap.querySelectorAll("button")].find(b=>b.getAttribute("aria-label").includes("R1"));
  assert.ok(pinpoint,"R1 disconnected terminal");pinpoint.click();assert.equal(node('[aria-label="Designator"]').value,"R1");
  action("undo");
  const exportReady=()=>until(()=>[...document.querySelectorAll("dialog[open] .work-actions button")].some(b=>b.textContent==="Export" && !b.disabled),"Export preview ready");
  await save(); // The external documents below must reflect the current saved owner state.
  action("export");assert.equal(node('dialog[open] h2').textContent,"Export Design");
  assert.ok([...document.querySelectorAll("dialog[open] .work-actions button")].find(b=>b.textContent==="Export").disabled,"native export waits for its reviewed output");
  await exportReady();
  button("dialog[open] .work-actions button","Export");await until(()=>writes.at(-1)?.name.endsWith(".kicad_pcb") && !document.querySelector("dialog[open]"),"KiCad board export");
  assert.match(writes.at(-1).text,/^\(kicad_pcb/);assert.match(writes.at(-1).text,/\(segment /);assert.match(writes.at(-1).text,/"VIN"/);
  // The legacy CSV BOM left Export design: it offers no BOM format and points to the Active BOM.
  action("export");assert.ok(![...node('[aria-label="Format"]').options].some(o=>o.value==="bom"),"no legacy CSV BOM");
  assert.match(node("dialog[open] .review-bom-note").textContent,/Active BOM/);button("dialog[open] .work-actions button","Cancel");
  await step();
  action("export");change("Document",baseline.documents.find(d=>d.kind==="schematic").id);
  assert.equal(node('[aria-label="Format"]').value,"schematic");await exportReady();button("dialog[open] .work-actions button","Export");
  await until(()=>writes.at(-1)?.name.endsWith(".kicad_sch") && !document.querySelector("dialog[open]"),"KiCad schematic export");
  assert.match(writes.at(-1).text,/^\(kicad_sch/);assert.match(writes.at(-1).text,/\(lib_symbols/);assert.match(writes.at(-1).text,/47 kΩ/);
  const rul="RULEKIND=Width|NAME=Bench width|ENABLED=TRUE|LAYERKIND=SameLayer|NETSCOPE=AnyNet|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|MINLIMIT=10mil";
  const ruleFile=new TextEncoder().encode(rul+"¶\r\n"), host=AtriumNavHost;
  async function stageRule(){
    ruleFiles.push(new File([ruleFile],"bench.RUL"));action("rules");
    await until(()=>document.querySelector("dialog.rules-window[open]"),"open Rules editor");
    button("dialog[open] button","Import rules");
    await until(()=>document.querySelector("dialog[open] .source-rule"),"Altium rule import");
    const row=node("dialog[open] .source-rule");assert.match(row.textContent,/Bench width/);
    button("dialog[open] .source-rule button","Use ");
  }
  await stageRule();button("dialog[open] button","Close");assert.equal(board(await save()).sourceRules,undefined);
  assert.deepEqual(host.folderProject().importIndexes(),[],"closing the staged file retains nothing");
  await stageRule();
  // Apply keeps the non-modal editor open; OK applies and closes (as Altium's editor).
  const apply=[...document.querySelectorAll("dialog[open] .work-actions button, dialog[open] button")].find(n=>n.textContent==="OK");
  assert.ok(apply);apply.click();await until(()=>!document.querySelector("dialog[open]"),"rule commit");
  const updated=await save();assert.equal(board(updated).sourceRules,undefined,"source records stay outside the native board");assert.equal(board(updated).rules,undefined,"rules live in the project rule book");
  assert.ok(updated.rules.list.some(r=>r.type==="width"&&[r.min,r.preferred].includes(.254)),"the used source rule is in the book");
  assert.ok(!updated.documents.find(d=>d.kind==="schematic").rules);
  await folders.reopen();
  await host.selectDocument(sampleBoard.id);
  action("rules");await until(()=>document.querySelector("dialog.rules-window[open]"),"reopen original rules in editor");
  button(".rules-window [role=treeitem]","Altium Source Rules");
  assert.match(node(".rules-window .source-rule").textContent,/Bench width/);
  button(".rules-window .work-actions button","Close");await step();
  const entry=AtriumImportReports.recent(sampleBoard.id),archive=await AtriumLazy.need("AtriumProjectArchiveUI");
  assert.deepEqual(entry.names,["bench.RUL"]);assert.deepEqual(AtriumImportReports.sourceDocument(host.doc()).sourceRules,[rul]);
  const [original]=await archive.originalFiles(entry.index);
  assert.equal(original.name,"bench.RUL");assert.deepEqual(original.bytes,ruleFile);
  action("import-report");await until(()=>document.querySelector(".doc-view.import-report:not([hidden])"),"retained rules report");
  assert.match(document.querySelector(".doc-view.import-report:not([hidden])").textContent,/bench\.RUL/);
  await host.selectDocument(sampleBoard.id);
  const discard=archive.discard();await until(()=>document.querySelector('dialog[aria-label="Discard Import Data"]'),"discard rules");
  button('dialog[aria-label="Discard Import Data"] button',"Discard selected import");assert.equal(await discard,true);
  await save();assert.deepEqual(host.folderProject().importIndexes(),[]);
  assert.deepEqual(host.project().rules,updated.rules,"discarding source data leaves translated rules intact");
  host.act("undo");await save();assert.equal(host.folderProject().importIndexes().length,1);
  assert.deepEqual(AtriumImportReports.sourceDocument(host.doc()).sourceRules,[rul]);
  console.log("PASS located a disconnected board pad, toggled airwires, exported editable KiCad sheets, copper and BOM data, cancelled and applied a staged .RUL on its board");
  // Place › Component: the Library panel with its search focused; Enter on a row places it like the catalogue dialog.
  let focused=null;const realFocus=window.HTMLElement.prototype.focus;window.HTMLElement.prototype.focus=function(...a){focused=this;return realFocus?.apply(this,a);};
  action("library");await until(()=>focused?.matches?.(".panel-library input[type=search]"),"Library panel search focused");window.HTMLElement.prototype.focus=realFocus;
  assert.ok(!node("#library-dialog").open,"Place › Component opens the Library panel, not the dialog");
  {const lib=node(".panel-library"),search=focused;search.value="test point";search.dispatchEvent(new window.Event("input",{bubbles:true}));
    const find=()=>[...lib.querySelectorAll(".lib-row")].find(r=>/test point/i.test(r.textContent));await until(find,"a Test point row");const row=find();
    row.click();const e=new window.Event("keydown",{bubbles:true,cancelable:true});e.key="Enter";row.dispatchEvent(e);
    await until(()=>AtriumNavHost.tool?.()==="place","placing from the Library panel");key("Escape");}
  action("library-catalogue");assert.ok(node("#library-dialog").open);
  button("#library-list button","Test point");pointer(560,105);
  const part=host.doc().items.find(i=>i.kind==="part"&&i.ref==="J1");
  const pad=Atrium.pins(part,host.defs().get(part.def),"pcb").find(p=>part.pinNets[p.number]),view=host.view();
  view.restoreCamera({...view.camera(),cx:pad.at[0]+1.5,cy:pad.at[1],scale:40});host.redraw();
  action("route");await until(()=>host.tool()==="route","interactive router");
  pointer(...view.worldToScreen(pad.at));await until(()=>host.liveRoute(),"start a route on J1");
  pointer(...view.worldToScreen([pad.at[0]+3,pad.at[1]]));key("Escape");
  const snapshot=await save();
  for(const kind of ["part","track"]){
    const count=d=>d.items.filter(i=>i.kind===kind).length;
    assert.equal(count(board(snapshot)),count(board(baseline))+1,kind+" was added");
  }
  action("new");node("dialog[open] input").value="Fresh board";
  node("dialog[open] form").onsubmit({preventDefault(){}});
  await until(()=>node("#project-name").textContent==="Fresh board","new project");
  await openPanel("components");
  await until(()=>document.querySelector("#parts .side-note")?.textContent==="No components placed","empty component list");
  assert.equal(document.querySelectorAll("#parts button").length,0);
  await openPanel("properties");
  host.edit(()=>{host.doc().name="Unsaved replacement";});
  const reopened=folders.reopen();
  await until(replaceChoice,"replace edited project");replaceChoice().click();await reopened;
  assert.deepEqual(await save(),snapshot);
  console.log("PASS editing, undo/redo, reviewed ECO, cross-probe, workflow dialogs, part placement, track routing, save and reopen");
  if(fixtureDirectory){
    files.clear();for(const file of ["Level.Shifter.SchDoc","Panel.PcbDoc","PE42442.SchLib","QFN24.PcbLib"])files.set(file,fs.readFileSync(path.join(fixtureDirectory,file)));
    action("open");
    await until(()=>replaceChoice()||host.project().name==="Level.Shifter","review four-format import",30000);
    replaceChoice()?.click();
    await until(()=>host.project().name==="Level.Shifter","four-format import",30000);
    const all=await folders.saveImportedAsWaffle();assert.deepEqual(all.documents.map(d=>d.kind).sort(),["pcb","schematic"]);
    assert.ok(all.documents.every(d=>!snapshot.documents.some(old=>old.id===d.id)));
    assert.ok(all.library.length>snapshot.library.length);
    const pcb=all.documents.find(d=>d.kind==="pcb");
    await host.selectDocument(pcb.id);await host.folderProject().ensureImportReports();
    const designScope=AtriumImportReports.recent(pcb.id).scopeId;
    await stageRule();button(".rules-window .work-actions button","OK");
    await until(()=>!document.querySelector("dialog.rules-window[open]"),"apply rules to imported board");
    await save();await folders.reopen();await host.selectDocument(pcb.id);await host.folderProject().ensureImportReports();
    assert.equal(AtriumImportReports.recent(pcb.id).scopeId,designScope,"a standalone rule file preserves the PCB's design report");
    assert.deepEqual(AtriumImportReports.sourceDocument(host.doc()).sourceRules,[rul]);
    const importedRules=archive.discard();await until(()=>document.querySelector('dialog[aria-label="Discard Import Data"] select'),"select only rule data");
    const list=node('dialog[aria-label="Discard Import Data"] select');
    const selected=[...list.options].find(o=>o.textContent==="bench.RUL");assert.ok(selected);list.value=selected.value;
    button('dialog[aria-label="Discard Import Data"] button',"Discard selected import");
    assert.equal(await importedRules,true);await save();await folders.reopen();await host.selectDocument(pcb.id);await host.folderProject().ensureImportReports();
    const design=AtriumImportReports.recent(pcb.id);assert.equal(design.scopeId,designScope);
    const boardSource=(await archive.originalFiles(design.index)).find(file=>file.name==="Panel.PcbDoc");
    assert.deepEqual(Buffer.from(boardSource.bytes),files.get("Panel.PcbDoc"));
    console.log("PASS four real binary formats through Open, native Save and a byte-exact original after independently discarding a rule import");
  }
  const routed=Atrium.project("Four layer board"),layout=Atrium.sheet("pcb","Stack");
  routed.documents=[layout];
  layout.outline=[[0,0],[20,0],[20,15],[0,15]];
  layout.items=[
    {id:"buried",kind:"via",x:3,y:3,diameter:.8,drill:.3,layer:"Multi",fromLayer:"Inner 1",toLayer:"Inner 2",net:"BURIED"},
    {id:"existing",kind:"track",points:[[12,10],[15,10]],width:.25,layer:"Inner 2",net:"BUS"}
  ];
  await folders.openModel(routed,"Stack.waffle");
  assert.equal(node("#doc-name").textContent,"Stack");
  node('#document-tabs [data-tab="'+host.currentId()+'"]').click();
  const viewport=host.view();viewport.fit(host.doc(),host.defs());
  const clickAt=(x,y)=>pointer(...viewport.worldToScreen([x,y]));
  const options=label=>[...node('[aria-label="'+label+'"]').querySelectorAll("option")].map(o=>o.value);
  clickAt(13,10);
  assert.equal(node('[aria-label="Layer"]').value,"Inner 2");
  assert.deepEqual(options("Layer"),["Top","Inner 1","Inner 2","Bottom"]);
  action("route");
  assert.deepEqual(options("Copper layer"),["Top","Inner 1","Inner 2","Bottom"]);
  change("Copper layer","Bottom");clickAt(3,3);
  pointerEvent("pointermove",...viewport.worldToScreen([7,3]));key("Enter");
  // Enter places the corner at the pointer. The first Escape commits the path and leaves routing active.
  assert.equal(board(await save()).items.filter(i=>i.kind==="track").length,1,"draft route stays out of the saved board");
  key("Escape");
  change("Copper layer","Inner 1");clickAt(3,3);clickAt(3,8);key("Escape");
  const tracks=board(await save()).items.filter(i=>i.kind==="track");
  assert.deepEqual(tracks.map(i=>[i.layer,i.net]),[["Inner 2","BUS"],["Bottom",""],["Inner 1","BURIED"]]);
  assert.deepEqual(tracks.find(i=>i.layer==="Bottom").points,[[3,3],[7,3]]);
  assert.deepEqual(tracks.find(i=>i.layer==="Inner 1").points,[[3,3],[3,8]]);
  openSection("Layers");button("#inspector .layer-row","Inner 1");
  assert.deepEqual(options("Copper layer"),["Top","Inner 2","Bottom"]);
  assert.equal(node('[aria-label="Copper layer"]').value,"Top");
  console.log("PASS routed on inner copper, retained existing track layers, ignored a buried via on Bottom, adopted its net on Inner 1 and switched off hidden copper");
  const spec=AtriumPolygonPour.speculation;
  const paletteIntents=spec.stats.intents.palette ?? 0;
  const typeRepour=input=>{
    const previous=input.value;
    input.value="Repour All";
    input.dispatchEvent(new window.Event("input",{bubbles:true}));
    input.value=previous;
  };
  typeRepour(node("#library-search"));
  assert.equal(spec.stats.intents.palette ?? 0,paletteIntents,"library input is outside pour intent");
  typeRepour(node("#palette input"));
  assert.equal(spec.stats.intents.palette,paletteIntents+1,"the real palette input signals pour intent");
  console.log("PASS pour intent follows the command palette and ignores unrelated editor input");
  const diagnostics = await AtriumLazy.need("AtriumMotionDiagnostics");
  assert.equal(diagnostics.inspect("sample", {from:0, to:80, elapsedMs:50, durationMs:200, curve:"linear"}).value, 20);
  assert.equal(globalThis.AtriumButterEditor, undefined, "diagnostics need the broker without opening the Butter editor");
  console.log("PASS cold developer diagnostics load their registered providers on demand");
}

module.exports = { setup, option, loadDOM };
if(require.main===module)run().catch(error=>{console.error(error);process.exitCode=1;});
