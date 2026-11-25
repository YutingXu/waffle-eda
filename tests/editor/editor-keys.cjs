"use strict";
const assert=require("node:assert/strict");
require("../../app/editor/keymap.js");
require("../../app/editor/editor-keys.js");
const events=[],hints=[];
const handle=AtriumEditorKeys.create((a,p)=>events.push([a,p]),v=>hints.push(v));
const state={documentId:"s",kind:"schematic",canvas:true,tool:"select"};
function key(key,flags={},s=state,target={closest:()=>null}){
  const e={key,target,...flags,preventDefault(){this.defaultPrevented=true;}};handle.handle(e,s);return e;
}
const last=()=>events.at(-1)?.[0];
key("p");assert.match(hints.at(-1),/W Wire/);key("p",{repeat:true});assert.equal(events.length,0);key("w");assert.equal(last(),"route");
key("p");key("Escape");assert.equal(last(),"prefix-cancel");
key("w",{ctrlKey:true});assert.equal(last(),"start-wire");
key("w",{ctrlKey:true},{...state,tool:"route"});assert.equal(last(),"start-wire");assert.equal(key("w",{metaKey:true}).defaultPrevented,undefined);
key("m",{ctrlKey:true});assert.equal(last(),"measure");assert.equal(key("m",{metaKey:true}).defaultPrevented,undefined);
key("g");assert.equal(last(),"grid-next");
key("g",{ctrlKey:true,shiftKey:true});assert.equal(last(),"grid");
key("g",{shiftKey:true});assert.deepEqual(events.at(-1),["grid-next",-1]);
key("g",{ctrlKey:true});assert.equal(last(),"grid-custom");
key("\\",{ctrlKey:true});assert.equal(last(),"split-toggle");key("\\",{metaKey:true,code:"Backslash"},{...state,kind:"pcb"});assert.equal(last(),"split-toggle");
key("q");assert.equal(last(),"toggle-units");key("q",{},{...state,kind:"pcb",tool:"route",interactive:true});assert.equal(last(),"toggle-units");
key("p");key("j");assert.equal(last(),"junction");
key("p");key("n");assert.equal(last(),"label");
key("x");key("a");assert.equal(last(),"deselect");
key("v");key("d");assert.equal(last(),"fit-document");
key("m");key("m");assert.equal(last(),"move-object");
const pcb={...state,documentId:"b",kind:"pcb"};
key("p");key("t",{},pcb);assert.equal(last(),"move-object","editor switch clears pending command");
assert.match(hints.at(-1),/^Tools · R Length tuning   I Diff pair tuning   G Polygon pours…   W Swap…/,"T opens the Tools sequence on boards");key("Escape",{},pcb);assert.equal(last(),"prefix-cancel");
for(const [prefix,k,a] of [["p","v","via"],["p","t","route"],["p","c","library"],["p","s","label"],["d","r","rules"],["v","f","fit-objects"]]){
  key(prefix,{},pcb);key(k,{},pcb);assert.equal(last(),a);
}
key("l",{},pcb);assert.equal(last(),"view-config");
key("d",{ctrlKey:true},pcb);assert.equal(last(),"duplicate","Ctrl+D duplicates on boards (Altium)");
key("g",{},pcb);assert.equal(last(),"grid-picker");key("g",{ctrlKey:true},pcb);assert.equal(last(),"grid-custom");
key("s",{shiftKey:true},pcb);assert.equal(last(),"layer-mode");
const route={...pcb,tool:"route",interactive:true,canProperties:true};
key(" ",{},route);assert.equal(last(),"route-bend");
key(" ",{shiftKey:true},route);assert.equal(last(),"route-mode");
key("Backspace",{},route);assert.equal(last(),"route-back");
key("Enter",{},route);assert.equal(last(),"place-at-pointer");
key("Tab",{},route);assert.equal(last(),"tool-properties");
key("ArrowRight",{shiftKey:true},route);assert.deepEqual(events.at(-1),["cursor-step",[10,0]]);
key(" ",{},{...route,tool:"place",rotatable:true});assert.equal(last(),"rotate-ccw");
key(" ",{shiftKey:true},{...route,tool:"place",rotatable:true});assert.equal(last(),"rotate-cw");
key("p");const readOnly={closest:()=>({}),isContentEditable:true};
assert.equal(key("w",{},state,readOnly).defaultPrevented,undefined);
assert.equal(key("z",{ctrlKey:true},state,readOnly).defaultPrevented,undefined);
assert.equal(key("s",{metaKey:true},state,readOnly).defaultPrevented,true);
assert.equal(key("s",{metaKey:true},{...state,modal:true},readOnly).defaultPrevented,undefined);
key("w",{isComposing:true});assert.equal(last(),"save");
console.log("PASS schematic and PCB command sequences, context precedence, rotation, routing, forms, dialogs, modifiers and repeat keys.");

async function editor(){
  if(!process.argv.includes("--dom"))return;
  const {setup}=require("../integration/integration.cjs"),{document,window,files,writes}=await setup();
  const canvas=document.getElementById("canvas");
  function send(k,props={},el=canvas){
    const e=new window.Event("keydown",{bubbles:true,cancelable:true});
    Object.assign(e,{key:k,code:k===" "?"Space":k},props);el.dispatchEvent(e);return e;
  }
  function point(type,x,y){const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,{clientX:x,clientY:y,button:0,pointerId:1});canvas.dispatchEvent(e);}
  function click(x,y){point("pointerdown",x,y);point("pointerup",x,y);}
  function command(a){document.querySelector('[data-action="'+a+'"]').click();}
  async function until(test){const stop=Date.now()+3000;while(!test()){assert.ok(Date.now()<stop,document.body.textContent.slice(-500));await new Promise(r=>setTimeout(r,5));}}
  async function save(){const n=writes.length;command("save");await until(()=>writes.length>n);return JSON.parse(writes.at(-1).text);}
  const design=Atrium.project("Shortcut fixture",AtriumParts.catalogue);files.set("Board.waffle",JSON.stringify(design));send("o",{ctrlKey:true});
  await until(()=>document.querySelector("#project-name").textContent===design.name);
  const doc=p=>p.documents[0];
  send("p");send("w");assert.equal(document.querySelector('[data-action="route"][aria-pressed="true"]')!==null,true);
  click(120,125);point("pointermove",205,155);send(" ");send("Enter");send("Backspace");
  point("pointermove",270,190);send("Enter");send("Escape");send("Escape");
  const w=doc(await save()).items;assert.equal(w.length,1);assert.equal(w[0].kind,"wire");assert.equal(w[0].points.length,3);
  assert.equal(w[0].points[0][0],w[0].points[1][0],"alternate orthogonal bend was placed");
  const designBeforeMeasurement=doc(await save());
  send("m",{ctrlKey:true});point("pointermove",90,90);send("Enter");point("pointermove",150,100);send("Enter");
  assert.match(document.getElementById("status").textContent,/mm/);send("Escape");
  assert.deepEqual(doc(await save()),designBeforeMeasurement);
  const oldGrid=doc(await save()).grid;send("g");assert.notEqual(doc(await save()).grid,oldGrid);send("z",{ctrlKey:true});
  // P P brings the Library panel forward with its search focused (as Altium's Components panel); the catalogue stays one command away.
  let focused=null;const realFocus=window.HTMLElement.prototype.focus;window.HTMLElement.prototype.focus=function(...a){focused=this;return realFocus?.apply(this,a);};
  send("p");send("p");await until(()=>focused&&focused===document.querySelector(".panel-library:not([hidden]) input[type=search]"));window.HTMLElement.prototype.focus=realFocus;
  assert.equal(document.querySelector("#library-dialog").open,false,"P P opens the Library panel, not the catalogue dialog");
  command("library-catalogue");assert.equal(document.querySelector("#library-dialog").open,true);
  const buttons=[...document.querySelectorAll("#library-list button")];
  (buttons.find(b=>b.textContent.includes("Resistor"))||buttons[0]).click();
  point("pointermove",470,390);send(" ");send("Enter");
  const part=doc(await save()).items.find(i=>i.kind==="part");assert.ok(part);assert.equal(part.angle,270);
  send("ArrowRight");assert.deepEqual(doc(await save()).items.find(i=>i.id===part.id),part,"bare arrows move the editor cursor");
  send("ArrowRight",{ctrlKey:true});assert.ok(doc(await save()).items.find(i=>i.id===part.id).x>part.x);
  send("z",{ctrlKey:true});assert.deepEqual(doc(await save()).items.find(i=>i.id===part.id),part);
  const value=document.querySelector('#inspector [aria-label="Comment"]');send("p",{},value);send("p",{},value);assert.equal(document.querySelector("#library-dialog").open,false);
  function coordinates(x,y){point("pointermove",x,y);return document.getElementById("coords").textContent.match(/-?\d+(?:\.\d+)?/g).map(Number);}
  const zero=coordinates(0,0),scale=(coordinates(100,0)[0]-zero[0])/100;
  const hit=[(part.x-zero[0])/scale,(part.y-zero[1])/scale];
  send("m");send("m");click(...hit);point("pointermove",531,420);assert.match(document.getElementById("status").textContent,/Click to place/);
  send("Escape");assert.deepEqual(doc(await save()).items.find(i=>i.id===part.id),part);
  send("m");send("m");click(...hit);point("pointermove",530,420);send("ArrowRight");send("Enter");const moved=doc(await save()).items.find(i=>i.id===part.id);
  assert.ok(moved.x>part.x);assert.ok(moved.y>part.y);assert.equal(moved.angle,270);
  send("z",{ctrlKey:true});assert.deepEqual(doc(await save()).items.find(i=>i.id===part.id),part);
  document.querySelector('[data-doc="'+design.documents[1].id+'"]').click();send("p");send("t");
  assert.ok(document.querySelector('#inspector [aria-label="Width (mm)"]'));
  click(120,125);point("pointermove",200,160);send("Enter");send("Escape");send("Escape");
  assert.equal((await save()).documents[1].items.filter(i=>i.kind==="track").length,1);
  send("g",{ctrlKey:true});let dialog=document.querySelector('dialog[aria-label="PCB snap grid"]');
  dialog.querySelector("input").value=".3175";dialog.querySelector("form").onsubmit({preventDefault(){}});
  assert.equal((await save()).documents[1].grid,.3175);
  send("g");dialog=document.querySelector('dialog[aria-label="PCB snap grid"]');dialog.querySelector("select").value="0.1";
  dialog.querySelector("form").onsubmit({preventDefault(){}});assert.equal((await save()).documents[1].grid,.1);
  // Units: Q and the Grid menu switch mm/mil; the model stays in millimetres.
  const units=document.getElementById("unit-toggle-label"),gridValue=()=>document.getElementById("grid-value").textContent;
  assert.equal(units.textContent,"Switch to mil");assert.equal(gridValue(),"Grid 0.1 mm");
  const mmAt=coordinates(300,200);assert.match(document.getElementById("coords").textContent,/^X -?\d+\.\d\d mm Y -?\d+\.\d\d mm$/);
  send("q");assert.equal(units.textContent,"Switch to mm");assert.equal(gridValue(),"Grid 3.937 mil");
  const milAt=coordinates(300,200);assert.match(document.getElementById("coords").textContent,/^X -?[\d.]+ mil Y -?[\d.]+ mil$/);
  assert.ok(Math.abs(milAt[0]*.0254-mmAt[0])<.01&&Math.abs(milAt[1]*.0254-mmAt[1])<.01);
  assert.equal((await save()).units,"mil");
  send("p");send("t");assert.ok(document.querySelector('#inspector [aria-label="Width (mil)"]'),"routing width follows the unit");send("Escape");
  send("g",{ctrlKey:true});dialog=document.querySelector('dialog[aria-label="PCB snap grid"]');
  assert.ok([...dialog.querySelectorAll("option")].some(o=>o.textContent==="1 mil"&&Number(o.value)===.0254));
  dialog.querySelector("input").value=".5";dialog.querySelector("form").onsubmit({preventDefault(){}});
  assert.match(dialog.textContent,/at least 1 mil/);assert.equal((await save()).documents[1].grid,.1,"sub-mil grid rejected");
  dialog.querySelector("input").value="0.127mm";dialog.querySelector("form").onsubmit({preventDefault(){}});
  assert.equal((await save()).documents[1].grid,.127);assert.equal(gridValue(),"Grid 5 mil");
  send("g",{ctrlKey:true});dialog=document.querySelector('dialog[aria-label="PCB snap grid"]');
  dialog.querySelector("input").value="1";dialog.querySelector("form").onsubmit({preventDefault(){}});
  assert.equal((await save()).documents[1].grid,.0254);assert.equal(gridValue(),"Grid 1 mil");
  send("z",{ctrlKey:true});assert.equal(units.textContent,"Switch to mm","undo does not revert the unit");
  command("toggle-units");assert.equal(units.textContent,"Switch to mil");assert.equal((await save()).units,undefined);
  send("d");send("r");assert.match(document.querySelector("dialog[open] h2").textContent,/Design rules/);document.querySelector("dialog[open]").close();
  send("F1",{shiftKey:true});assert.equal(document.querySelector('[aria-label="Shortcut editor"]').value,"pcb");
  assert.match(document.querySelector("dialog[open]").textContent,/Route track/);document.querySelector("dialog[open]").close();
  console.log("PASS workbench shortcuts: wire bend, anchor unwind, placement rotation, keyboard move/cancel/undo, PCB routing, board rules and contextual help.");
}
globalThis.__testDone=editor().catch(e=>{console.error(e);process.exitCode=1;});
