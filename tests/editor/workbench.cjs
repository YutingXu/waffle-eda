"use strict";

// Exercise the production shell and editor, including tab focus, native menu access
// and tool changes. Pass --dom /absolute/path/to/linkedom.mjs for offline runs.
const assert=require("node:assert/strict");
const {setup,option}=require("../integration/integration.cjs");
const {readFileSync}=require("node:fs");
const {createContext,runInContext}=require("node:vm");

function checkThemeEvents(window){
  const doc=new window.DOMParser().parseFromString('<html><body><button data-action="theme-toggle"><span>Toggle</span></button></body></html>',"text/html");
  const realm=createContext({document:doc,addEventListener:doc.addEventListener.bind(doc)});
  runInContext(readFileSync(require.resolve("../../app/editor/theme.js"),"utf8"),realm);
  const button=doc.querySelector("button"), label=button.firstElementChild;
  const click=()=>label.dispatchEvent(new window.Event("click",{bubbles:true}));
  const command=detail=>doc.dispatchEvent(new window.CustomEvent("atrium-command",{detail}));
  const theme=()=>doc.documentElement.dataset.theme;
  assert.equal(runInContext('typeof Element + "/" + typeof CustomEvent',realm),"undefined/undefined");
  command("theme-light");
  assert.equal(theme(),"light","a command created in the host document works without a local CustomEvent");
  runInContext("globalThis.Element=class Element {}; globalThis.CustomEvent=class CustomEvent {};",realm);
  command("theme-dark");
  assert.equal(theme(),"dark","a command from a different event realm still runs");
  command({toString:()=>"theme-light"});
  doc.dispatchEvent(new window.Event("atrium-command"));
  assert.equal(theme(),"dark","only string command details are accepted");
  button.disabled=true;
  click();
  assert.equal(theme(),"dark","a nested target within a disabled action is ignored");
  button.disabled=false;
  click();
  assert.equal(theme(),"light","a nested target from the host document reaches its action");
}
async function main(){
  const {document,window,folders,files}=await setup();
  checkThemeEvents(window);
  const get=q=>{const node=document.querySelector(q);assert.ok(node,q);return node;};
  const all=q=>[...document.querySelectorAll(q)];
  const board=get('#document-tabs [data-kind="pcb"]'),sheet=get('#document-tabs [data-kind="schematic"]');
  function key(node,name){
    const event=new window.Event("keydown",{bubbles:true,cancelable:true});
    Object.defineProperty(event,"key",{value:name});node.dispatchEvent(event);return event;
  }
  assert.equal(board.getAttribute("aria-selected"),"true");
  assert.equal(get("#doc-name").textContent,"Sensor board");
  assert.equal(sheet.tabIndex,-1);
  assert.equal(key(board,"Home").defaultPrevented,true);
  assert.equal(sheet.getAttribute("aria-selected"),"true");
  assert.equal(get("#doc-name").textContent,"Analog front end");
  assert.equal(all("#current-document-tab").length,1);
  assert.equal(get("#canvas-stage").getAttribute("aria-labelledby"),"current-document-tab");
  assert.equal(get(".active-layer").hidden,true);
  assert.ok(all("#tools [data-scope=pcb]").every(n=>n.hidden));
  assert.ok(all("#tools [data-scope=schematic]").every(n=>!n.hidden));
  assert.equal(get("#grid-value").textContent,"Grid 1.27 mm");
  assert.ok(key(sheet,"End").defaultPrevented);
  assert.equal(get("#doc-name").textContent,"Sensor board");
  assert.equal(get(".active-layer").hidden,false);
  const edit=get('[data-menu="edit"]'),view=get('[data-menu="view"]');
  edit.querySelector("summary").click();assert.equal(edit.open,true);
  assert.equal(edit.querySelector("summary").getAttribute("aria-expanded"),"true");
  key(edit.querySelector("summary"),"ArrowRight");assert.equal(view.open,true);assert.equal(edit.open,false);
  key(view.querySelector("summary"),"Escape");assert.equal(view.open,false);
  const windowMenu=get('.work-menu[data-menu="window"]');
  windowMenu.querySelector("summary").click();
  const hide=windowMenu.querySelector('[data-action="toggle-right"]');
  hide.click();assert.ok(document.body.classList.contains("hide-right"));assert.equal(windowMenu.open,false);
  windowMenu.querySelector("summary").click();hide.click();assert.ok(!document.body.classList.contains("hide-right"));
  // Split view: the board stays in the primary pane; the schematic opens beside it and takes focus.
  get(".split-button").click();
  assert.ok(get("#canvas-stage-2").contains(get("#canvas-2")));assert.ok(get("#canvas-stage-2").classList.contains("is-active"));
  assert.equal(get(".split-button").getAttribute("aria-pressed"),"true");assert.equal(get('[data-action="split-close"]').disabled,false);
  assert.equal(get("#doc-name").textContent,"Analog front end");assert.ok(get("#canvas-stage-2").contains(get("#tools")));
  assert.equal(board.dataset.pane,"other");assert.deepEqual(all(".pane-caption").map(n=>n.textContent),["Sensor board","Analog front end"]);
  board.click();assert.equal(get("#doc-name").textContent,"Sensor board","a tab shown in the other pane activates that pane");
  assert.ok(get("#canvas-stage").classList.contains("is-active"));assert.ok(get("#canvas-stage").contains(get("#tools")));assert.equal(all("#canvas-2").length,1);
  get("#canvas-2").dispatchEvent(new window.Event("focus"));assert.equal(get("#doc-name").textContent,"Analog front end");
  get("#canvas").dispatchEvent(new window.Event("focus"));
  get('[data-action="split-close"]').click();assert.equal(all("#canvas-2,#canvas-sash,.pane-caption").length,0);
  assert.equal(get("#doc-name").textContent,"Sensor board");assert.equal(get(".split-button").getAttribute("aria-pressed"),"false");
  assert.ok(get("#canvas-stage").contains(get("#tools")));assert.equal(get('[data-action="split-close"]').disabled,true);
  const action=get('[data-menu="project"] [data-action="compare"]');
  action.closest("details").querySelector("summary").click();action.click();
  assert.equal(get('dialog[open] h2').textContent,"Change table");
  assert.equal(action.closest("details").open,false);
  get('dialog[open]').close();
  const projectCommand=name=>{
    const menu=get('[data-menu="project"]');menu.querySelector("summary").click();menu.querySelector('[data-action="'+name+'"]').click();
  };
  const cancel=()=>[...get('dialog[open]').querySelectorAll("button")].find(n=>n.textContent==="Cancel").click();
  const acceptName=(value)=>{const form=get('dialog[open] form');form.querySelector("input").value=value;form.dispatchEvent(new window.Event("submit",{bubbles:true,cancelable:true}));};
  const act=name=>get('[data-action="'+name+'"]').click();
  const activeName=()=>get("#doc-name").textContent;
  projectCommand("add-schematic");assert.equal(get('dialog[open] input').value,"Schematic 1");cancel();
  assert.equal(all('#documents button').length,2);
  async function ready(fn,timeout=4000){const until=Date.now()+timeout;while(!fn()){if(Date.now()>until)assert.fail("Editor did not settle: "+get("#status").textContent);await new Promise(r=>setTimeout(r,5));}}
  async function openInThisWindow(source){
    act("open");
    const replace=()=>all("dialog[open] button").find(n=>["Replace project","Don’t Save"].includes(n.textContent));
    const opened=()=>globalThis.AtriumImportReports?.sourceDocument(AtriumNavHost.doc()).sourceName===source;
    await ready(()=>replace()||opened(),30000);replace()?.click();
    await ready(opened,30000);
  }
  // The zoom readout is absolute (100% = real size), so a fitted view reads whatever fits.
  function zoomText(scale){const value=scale/(96/25.4)*100;return (value>=10?Math.round(value):+value.toFixed(1))+"%";}
  const zoomed=AtriumNavHost.view().scale()*1.25;
  const oldZoom=zoomText(zoomed);
  act("zoom-in");await ready(()=>Math.abs(AtriumNavHost.view().scale()-zoomed)<1e-6&&get("#zoom-value").textContent===oldZoom);
  projectCommand("add-schematic");acceptName(" Schematic 1 ");const sheetZoom=zoomText(AtriumNavHost.view().scale());
  await ready(()=>activeName()==="Schematic 1"&&get("#zoom-value").textContent===sheetZoom);
  act("undo");await ready(()=>get("#zoom-value").textContent===oldZoom);assert.equal(activeName(),"Sensor board");
  act("redo");await ready(()=>get("#zoom-value").textContent===sheetZoom);
  assert.equal(activeName(),"Schematic 1");assert.equal(get("#doc-kind").textContent,"Schematic");assert.match(get("#zoom-value").textContent,/^\d+(\.\d)?%$/);
  projectCommand("add-schematic");assert.equal(get('dialog[open] input').value,"Schematic 2");acceptName("Schematic 2");
  const addedId=get("#current-document-tab").dataset.tab;
  projectCommand("rename-document");assert.equal(get('dialog[open] input').value,"Schematic 2");acceptName("Power");
  assert.equal(activeName(),"Power");assert.equal(get("#current-document-tab").dataset.tab,addedId);
  act("undo");assert.equal(activeName(),"Schematic 2");act("undo");assert.equal(activeName(),"Schematic 1");
  act("redo");assert.equal(activeName(),"Schematic 2");act("redo");assert.equal(activeName(),"Power");
  projectCommand("add-pcb");assert.equal(get('dialog[open] input').value,"PCB layout 1");acceptName("Carrier");
  assert.equal(activeName(),"Carrier");assert.equal(get("#doc-kind").textContent,"Board layout");assert.equal(get("#grid-value").textContent,"Grid 0.25 mm");
  const perimeterAction=()=>all("#inspector > section button").find(button=>button.textContent==="Enter Coordinates…");
  assert.ok(perimeterAction(),"A blank board offers typed coordinates directly in Properties");
  perimeterAction().click();
  const perimeter=[[0,0],[26,0],[24,14],[0,14]];
  get('[aria-label="Perimeter vertices in millimetres"]').value=perimeter.map(point=>point.join(", ")).join("\n");
  all("dialog[open] button").find(button=>button.textContent==="Apply").click();
  assert.equal(document.querySelector("dialog[open]"),null);
  assert.equal(perimeterAction(),undefined);
  act("undo");assert.ok(perimeterAction());act("redo");assert.equal(perimeterAction(),undefined);
  const saved=await folders.save();assert.equal(saved.documents.length,5);
  assert.ok(saved.documents.some(d=>d.id===addedId&&d.name==="Power"&&d.kind==="schematic"));
  assert.deepEqual(saved.documents.find(d=>d.name==="Carrier").items,[]);
  assert.deepEqual(saved.documents.find(d=>d.name==="Carrier").outline,perimeter);
  await folders.reopen();
  assert.deepEqual(await folders.snapshot(),saved);
  assert.equal(AtriumNavHost.folderProject().documents().length,5);
  await AtriumNavHost.selectDocument(addedId);assert.equal(activeName(),"Power");
  {// Save As during a native Save writes a distinct complete project.
    const host=AtriumHost, original=host.folderCommit, current=AtriumNavHost.folderProject(), grants=[];
    let release, entered;
    const waiting=new Promise(r=>{entered=r;}), pending=new Promise(r=>{release=r;});
    host.folderCommit=async data=>{
      grants.push(data.grant);
      if(data.grant===current.grant){entered();await pending;}
      return original(data);
    };
    try {
      projectCommand("rename-document");acceptName("Power rail");
      act("save");await waiting;act("save-as");release();
      await ready(()=>AtriumNavHost.folderProject()!==current);
      assert.deepEqual(grants,[current.grant,AtriumNavHost.folderProject().grant]);
      assert.equal((await folders.snapshot()).documents.find(d=>d.id===addedId).name,"Power rail");
    } finally {release();host.folderCommit=original;}
  }
  const fixtures=option("--fixtures");
  if(fixtures){
    const fs=require("node:fs"),path=require("node:path");
    const source="Level.Shifter.SchDoc",bytes=fs.readFileSync(path.join(fixtures,source));
    files.clear();files.set(source,bytes);await openInThisWindow(source);
    const sourceId=get("#current-document-tab").dataset.tab;
    projectCommand("rename-document");acceptName("Level translation");
    const savedImport=await folders.saveImportedAsWaffle();
    assert.equal(savedImport.documents.find(d=>d.id===sourceId).name,"Level translation");
    await AtriumNavHost.folderProject().ensureImportReports();
    const project=await AtriumImportReports.snapshot(AtriumNavHost.project()),d=project.documents.find(d=>d.id===sourceId);
    assert.equal(d.name,"Level translation");assert.equal(d.sourceName,source);
    assert.deepEqual(Buffer.from(AtriumSourceCopy.prepare(d,project.library,bytes).bytes),bytes);

    const boardSource="PDP_V3.PcbDoc";
    files.clear();files.set(boardSource,fs.readFileSync(path.join(fixtures,"qfsae-0.PcbDoc")));await openInThisWindow(boardSource);
    // Manual mode exposes freshness directly. Live mode can display the last
    // complete fill while a replacement is calculated.
    if(AtriumPolygonPour.live.mode()==="live")act("pour-live");
    function sourcePourState(label,pressed,disabled){
      const layers=all("#inspector details").find(details=>details.querySelector("summary").textContent==="Layers");
      assert.ok(layers,"Layers disclosure");
      if(!layers.open){layers.open=true;layers.ontoggle();}
      const toggle=[...layers.querySelectorAll(".layer-row")].find(button=>button.querySelector("span").textContent==="Source pours");
      assert.ok(toggle,"Imported board exposes native polygon fills");
      assert.equal(toggle.querySelector("small").textContent,label);
      assert.equal(toggle.getAttribute("aria-pressed"),String(pressed));assert.equal(Boolean(toggle.disabled),disabled);
      return toggle;
    }
    sourcePourState("Visible",true,false).click();
    sourcePourState("Hidden",false,false).click();
    sourcePourState("Visible",true,false);
    act("via");
    for(const type of ["pointerdown","pointerup"]){
      const event=new window.Event(type,{bubbles:true,cancelable:true});
      Object.assign(event,{button:0,pointerId:1,clientX:412,clientY:316});get("#canvas").dispatchEvent(event);
    }
    sourcePourState("Needs repour",false,true);
    act("undo");sourcePourState("Visible",true,false);
    console.log("PASS PDP V3 native pours: Layers visibility, stale copper state and undo recovery");
  }
  console.log("PASS workbench: document tabs and keyboard focus, schematic/PCB commands, grid units, View panel controls, command menus, revision review, new sheets and boards, direct perimeter creation, naming, undo/redo and saved project reload");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
