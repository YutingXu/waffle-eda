"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {File}=require("node:buffer");
const {option,setup}=require("../integration/integration.cjs");

async function run(){
  const dir=option("--fixtures");if(!dir)throw Error("Pass --fixtures with Level.Shifter.SchDoc");
  const name="Level.Shifter.SchDoc",bytes=fs.readFileSync(path.join(dir,name));
  const {window,document,files,folders,ruleFiles}=await setup({demo:false});
  const canvas=document.getElementById("canvas"),status=()=>document.getElementById("status").textContent;
  const action=name=>{const n=document.querySelector('[data-action="'+name+'"]');assert.ok(n,name);n.click();};
  async function until(test,description){const t=Date.now();while(!test()){if(Date.now()-t>5000)assert.fail(description+" · "+status());await new Promise(r=>setTimeout(r,6));}}
  async function save(){
    const saved=await folders.saveImportedAsWaffle();
    await AtriumNavHost.folderProject().ensureImportReports();
    return AtriumTranslatorProvenance.toLegacy(saved,AtriumImportReports.provenance());
  }
  files.set(name,bytes);action("open");await until(()=>globalThis.AtriumImportReports?.sourceDocument(AtriumNavHost.doc()).sourceName===name,"import native sheet");
  function setGrid(mm){
    const settings=[...document.querySelectorAll("#inspector details")].find(d=>d.querySelector("summary")?.textContent==="Document settings");
    assert.ok(settings);settings.open=true;settings.ontoggle();
    const pitch=settings.querySelector('[aria-label="Grid (mm)"]');pitch.value=String(mm);pitch.onchange();
  }
  setGrid(.635);
  const original=await save(),sheet=original.documents.find(d=>d.sourceName===name),lib=new Map(original.library.map(d=>[d.id,d]));
  assert.equal(sheet.grid,.635);
  const board=p=>p.documents.find(d=>d.id===sheet.id),wires=p=>board(p).items.filter(i=>i.kind==="wire");
  const target=wires(original).find(i=>i.points.length===2 && Math.abs(i.points[0][0]-460*.254)<1e-6 && Math.abs(i.points[0][1]+340*.254)<1e-6);
  const targetOf=p=>wires(p).find(i=>i.id===target.id),at=[475*.254,-340*.254],moved=[at[0],at[1]-.635];
  const view=AtriumNavHost.view();
  view.restoreCamera({...view.camera(),cx:at[0],cy:at[1],scale:40});AtriumNavHost.redraw();
  function send(type,attrs={}){const e=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(e,attrs);canvas.dispatchEvent(e);}
  function pointer(type,p){const [clientX,clientY]=view.worldToScreen(p);send(type,{button:0,pointerId:1,clientX,clientY});}
  function click(p){pointer("pointerdown",p);pointer("pointerup",p);}
  action("grid");
  pointer("pointerdown",at);pointer("pointermove",moved);pointer("pointercancel",moved);
  assert.deepEqual(await save(),original);
  pointer("pointerdown",at);pointer("pointermove",moved);pointer("pointerup",moved);
  const after=await save();assert.equal(targetOf(after).points.length,4);assert.equal(wires(after).length,wires(original).length);
  action("undo");assert.deepEqual(await save(),original);
  action("redo");assert.deepEqual(await save(),after);
  action("undo");
  action("split-wire");click(at);assert.match(status(),/Wire split/);
  action("junction");click(at);assert.match(status(),/Junction placed/);
  action("junction");click(at);assert.match(status(),/already exists/);
  const jump=[at[0],at[1]+1.27];
  action("route");click(at);click(jump);send("keydown",{key:"Escape",code:"Escape"});
  const result=await save(),newWire=wires(result).find(i=>!i.schSource&&i.points.some(p=>Atrium.same(p,jump)));
  assert.ok(newWire,"new wired branch");assert.equal(wires(result).length,wires(original).length+2);
  const j=board(result).items.filter(i=>i.kind==="junction"&&Atrium.same([i.x,i.y],at));assert.equal(j.length,1);
  const net=Atrium.connectivity(board(result),lib).byWire;assert.equal(net.get(newWire.id),net.get(target.id));
  let copy=null;globalThis.AtriumHost.exportBinaryCopy=async(n,b,f)=>{copy=b;return true;};
  action("export");const select=document.querySelector('[aria-label="Format"]');
  await until(()=>[...select.options].some(o=>o.value==="altium"),"load the native source-copy format");
  select.value="altium";select.dispatchEvent(new window.Event("change"));
  function button(s){return [...document.querySelectorAll("dialog[open] button")].find(n=>n.textContent===s);}
  ruleFiles.push(new File([bytes],name));await button("Choose original…").onclick();
  assert.equal(button("Export").disabled,false,document.querySelector("dialog[open]").textContent);
  await button("Export").onclick();assert.ok(copy);
  const reopened=AtriumIO.read(name,copy).documents[0];assert.equal(reopened.items.filter(i=>i.kind==="wire").length,wires(result).length);
  const output=option("--write-copy");if(output)fs.writeFileSync(output,copy,{flag:"wx"});
  send("keydown",{key:"Escape",code:"Escape"});setGrid(1);
  const coarse=await save(),start=target.points[0],priorIds=new Set(wires(coarse).map(i=>i.id));
  assert.equal(board(coarse).grid,1);assert.ok(start.every(n=>n!==Math.round(n)),"the imported wire end is off grid on both axes");
  action("route");click([start[0]+.075,start[1]-.05]);click([Math.round(start[0]),Math.round(start[1]+3)]);send("keydown",{key:"Escape",code:"Escape"});
  const branched=await save(),added=wires(branched).filter(i=>!priorIds.has(i.id));
  assert.equal(added.length,1);assert.deepEqual(added[0].points[0],start,"a nearby click starts at the imported electrical endpoint");
  const connected=Atrium.connectivity(board(branched),lib).byWire;assert.equal(connected.get(added[0].id),connected.get(target.id));
  action("undo");assert.deepEqual(await save(),coarse);action("redo");assert.deepEqual(await save(),branched);
  console.log("PASS real-sheet mouse drag and cancel, undo/redo, split, explicit junction, on-grid and off-grid wire starts, named-net continuity and native export from the workbench");
}
run().catch(e=>{console.error(e);process.exitCode=1;});
