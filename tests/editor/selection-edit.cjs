"use strict";
const assert=require("node:assert/strict");
const {setup}=require("../integration/integration.cjs");
async function run(){
  const {window,document,folders}=await setup({demo:false});
  const canvas=document.getElementById("canvas"),status=()=>document.getElementById("status").textContent;
  const action=name=>{const button=document.querySelector('[data-action="'+name+'"]');assert.ok(button&&!button.disabled,name);button.click();};
  async function until(test,msg){const end=Date.now()+4000;while(!test()){if(Date.now()>end)throw Error(msg+" · "+status());await new Promise(done=>setTimeout(done,5));}}
  const save=folders.save;
  const project=Atrium.project("Placement QA",AtriumParts.catalogue),[sheet,board]=project.documents;
  for(const [id,x] of [["Q1",10],["Q2",20],["Q3",30]])board.items.push({kind:"part",def:"std-r",id,link:"linked-"+id,ref:id,value:"10 kΩ",x,y:10,angle:0,pinNets:{"1":"GND"}});
  board.outline=[[0,0],[40,0],[40,30],[0,30]];project.documents=[board,sheet];
  await folders.openModel(project,"Selection.waffle");
  const coord=AtriumNavHost.view();
  function send(type,p,extra={}){
    const [clientX,clientY]=coord.worldToScreen(p),e=new window.Event(type,{bubbles:true,cancelable:true});
    Object.assign(e,{button:0,pointerId:1,clientX,clientY,...extra});canvas.dispatchEvent(e);
  }
  function click(p,shiftKey=false){send("pointerdown",p,{shiftKey});send("pointerup",p,{shiftKey});}
  function docOf(project){return project.documents.find(d=>d.id===board.id);}
  function count(n){assert.ok(document.querySelector("#inspector").textContent.includes(n+" objects selected"));}
  send("pointerdown",[6,7]);send("pointermove",[23,13]);send("pointerup",[23,13]);count(2);
  send("pointerdown",[10,10]);send("pointermove",[12,13]);send("pointerup",[12,13]);
  let moved=docOf(await save());assert.deepEqual(moved.items.map(i=>[i.x,i.y]),[[12,13],[22,13],[30,10]]);
  action("undo");assert.deepEqual(docOf(await save()).items,board.items);
  click([30,10],true);count(3);click([30,10],true);count(2);
  action("duplicate");click([10,20]);
  const added=docOf(await save()).items;assert.equal(added.length,5);assert.deepEqual(added.slice(3).map(i=>i.ref),["Q4","Q5"]);
  assert.deepEqual(added.slice(3).map(i=>[i.x,i.y]),[[10,20],[20,20]]);assert.equal(new Set(added.map(i=>i.id)).size,5);
  assert.deepEqual(added[3].pinNets,added[0].pinNets);assert.notEqual(added[3].link,added[0].link);
  action("delete");assert.equal(docOf(await save()).items.length,3);action("undo");count(2);
  let system=null;AtriumHost.writeSelection=async packet=>{system=packet;return true;};AtriumHost.readSelection=async()=>system;
  action("cut");await until(()=>status().includes("cut"),"cut");
  assert.equal(docOf(await save()).items.length,3);
  action("paste");await until(()=>status().startsWith("Click to place"),"paste");click([10,16]);
  const restored=docOf(await save());assert.deepEqual(restored.items.slice(3).map(i=>[i.id,i.ref,i.link]),added.slice(3).map(i=>[i.id,i.ref,i.link]));
  action("measure");click([2,2]);click([5,6]);
  assert.match(status(),/^Board distance 5 mm \(196\.85 mil\)\s+Δx 3 mm\s+Δy 4 mm$/);
  assert.deepEqual(docOf(await save()),restored);
  await AtriumNavHost.selectDocument(sheet.id);action("measure");assert.equal(status(),"Click the first measurement point.");
  const curves=Atrium.project("Arc properties",[]),arcBoard=curves.documents[1];
  curves.documents=[arcBoard,curves.documents[0]];arcBoard.outline=board.outline;
  const arc={kind:"arc",c:[12,12],r:4,start:0,end:90,ccw:true};
  arcBoard.items.push({id:"arc",kind:"track",layer:"Top",width:.4,net:"",arc,points:Atrium.arcProjection(arc)});
  const legacy={id:"legacy",kind:"graphic",layer:"Top",width:.25,arc:true,points:[[24,12],[25,11],[26,12]]};
  arcBoard.items.push(legacy);
  await folders.openModel(curves,"Curves.waffle");
  coord.fit(arcBoard,new Map());click([16,12]);
  const property=name=>[...document.querySelectorAll(".ui-prop-row")].find(label=>label.textContent.startsWith(name))?.querySelector("input,select");
  await until(()=>property("Radius"),"arc properties");
  const change=(label,v)=>{const input=property(label);assert.ok(input,label);input.value=v;input.dispatchEvent(new window.Event("change",{bubbles:true}));};
  change("Radius","5mm");change("Direction","cw");change("Center X","14mm");
  const edited=(await save()).documents[0].items[0];
  assert.deepEqual(edited.arc,{...arc,c:[14,12],r:5,ccw:false});assert.ok(Atrium.pathArc(edited));
  action("undo");assert.deepEqual((await save()).documents[0].items[0].arc.c,[12,12]);
  click([25,11]);
  assert.deepEqual((await save()).documents[0].items[1],legacy,"inspecting a legacy arc keeps its saved vertices");
  change("Radius","2mm");
  const converted=(await save()).documents[0].items[1];
  assert.ok(Atrium.pathArc(converted));assert.equal(converted.arc.r,2);
  action("undo");assert.deepEqual((await save()).documents[0].items[1],legacy);
  console.log("PASS marquee / shift selection, group drag, undo, duplicate, cut and paste identities, and a 3–4–5 board measurement with no project edits.");
}
run().catch(e=>{console.error(e);process.exitCode=1;});
