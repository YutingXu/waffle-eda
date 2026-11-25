"use strict";

const assert = require("node:assert/strict");
require("../../app/automation/command-broker.js");
for (const name of ["uuid-v7","model","proposal","undo-store","history-panel","history-edits",
    "visual-history","nav-common","history-session","selection-clipboard","paste-plan","edit-selection",
    "clip-history","butter-visualHistory"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const descriptor = require("../../app/automation/descriptors/visual-history.json");
const p = Atrium.project("Session test"), doc = p.documents[0], id = Atrium.id();
doc.items.push({kind:"label", id, x:0, y:0, text:"Filter reference", size:2.5});
const input = JSON.stringify(p);
const scope = {}, byId = new Map(descriptor.commands.map(c=>[c.id,c]));
function call(name,args={},mode) {
  return AtriumButter.invoke(descriptor.feature,byId.get(name),args,
    {source:"mcp",scope,project:p,mode,allowWrite:true}, r=>r.result);
}
const write = (name,args) => call(name,args,"write");
const read = (name,args) => call(name,args,"read");
const edit = (path,before,after,label) => write("record-edit",{label,ops:[
  {op:"set",target:"item",document:doc.id,id,path:[path],before,after}
]});
const peek = (step) => read("session-preview",{documentId:doc.id,...step&&{step}});
assert.deepEqual(call("session-open"),{requiresWrite:true});
assert.throws(()=>read("session-list"),/Open an MCP history session/);
write("session-open");
assert.equal(edit("x",0,1,"Move 1").applied,1);
assert.equal(edit("x",1,2,"Move 2").applied,1);
assert.throws(()=>edit("x",1,10,"Reject stale edit"),/has changed/);
assert.equal(peek().document.items[0].x,2);
write("undo");
assert.equal(peek().document.items[0].x,1);
write("redo");
assert.equal(peek().document.items[0].x,2);
write("undo");
assert.deepEqual(call("record-edit",{label:"Plan",ops:[{target:"item",op:"set"}]}),{requiresWrite:true});
edit("y",0,3,"Move 3");
const timeline = read("session-list",{limit:2});
assert.equal(timeline.total,3);
assert.equal(timeline.nextOffset,2);
assert.equal(timeline.branches.length,1);
const alternate = timeline.branches[0].tip;
const preview = peek(alternate);
assert.deepEqual(preview.document.items.map(item=>[item.x,item.y]),[[2,0]]);
assert.deepEqual(peek().document.items.map(item=>[item.x,item.y]),[[1,3]]);
assert.equal(read("session-compare",{step:alternate}).total,2);
const scene = read("session-thumbnail",{step:alternate,documentId:doc.id}).scene;
assert.ok(scene.bounds.every(Number.isFinite));
assert.equal(scene.before[0].x,1);
assert.equal(scene.after[0].x,2);
assert.deepEqual(write("session-fork",{receipt:preview.receipt}),{applied:2,preserved:0,fork:true});
assert.equal(peek().document.items[0].x,2);
assert.equal(read("session-list").branches.length,2);
write("undo");
assert.deepEqual(peek().document.items.map(item=>[item.x,item.y]),[[1,3]]);
const restore = peek(timeline.items[0].id);
assert.equal(write("session-restore",{receipt:restore.receipt}).applied,2);
assert.deepEqual(peek().document.items.map(item=>[item.x,item.y]),[[0,0]]);
assert.throws(()=>write("session-restore",{receipt:restore.receipt}),/fresh history preview/);
write("undo");
assert.deepEqual(peek().document.items.map(item=>[item.x,item.y]),[[1,3]]);
const copied=write("clipboard-copy",{documentId:doc.id,itemIds:[id]});
const text=write("clipboard-text",{text:"V = I × R",kind:"schematic",math:true});
assert.equal(read("clipboard-preview",{entry:copied.id}).items[0].text,"Filter reference");
assert.equal(read("clipboard-list",{query:"fiLter ref"}).items[0].id,copied.id);
assert.equal(read("clipboard-list",{query:"math"}).items[0].id,text.id);
write("clipboard-pin",{entry:copied.id,on:true});
write("clipboard-rename",{entry:copied.id,name:"Snippét"});
assert.equal(read("clipboard-list",{pinned:true,query:"snippE\u0301t"}).items[0].id,copied.id);
assert.equal(write("clipboard-paste",{entry:text.id,documentId:doc.id,x:10,y:20}).ids.length,1);
assert.equal(peek().document.items.find(item=>item.math).x,10);
write("undo");
assert.equal(peek().document.total,1);
write("clipboard-clear");
assert.deepEqual(read("clipboard-list").items.map(entry=>entry.id),[copied.id]);
assert.deepEqual(write("clipboard-remove",{entry:copied.id}),{removed:true});
assert.equal(read("clipboard-list").total,0);
write("session-close");
assert.throws(()=>read("session-list"),/Open an MCP history session/);
assert.equal(JSON.stringify(p),input,"the bound project remains invariant");
console.log("PASS checked in-memory edits, detached previews and touched bounds, branch and restore as one edit, indexed portable clipboard");

write("session-open");
const add = (label,ops) => write("record-edit",{label,ops});
const divider={id:"shared-resistor",name:"Resistor",symbol:{shapes:[],pins:[]}};
const resistor=(id,ref)=>({id,kind:"part",ref,def:divider.id,x:5,y:0,value:"10k"});
add("Add R1",[
  {op:"add",target:"library",value:divider},
  {op:"add",target:"item",document:doc.id,value:resistor("r1","R1"),after_id:id}
]);
const beforeResistors = peek(read("session-list").items[0].id);
add("Add R2",[{op:"add",target:"item",document:doc.id,value:resistor("r2","R2"),after_id:"r1"}]);
assert.deepEqual(write("session-restore",{receipt:beforeResistors.receipt}),{applied:1,preserved:1,fork:false});
assert.deepEqual(peek().document.items.map(item=>item.id),[id,"r2"]);
assert.equal(edit("x",0,2,"Checked edit after preserved definition").applied,1,"the combined model passes validation");
write("undo",{steps:2});
assert.deepEqual(peek().document.items.map(item=>item.id),[id,"r1","r2"],"one Undo reverses restore");
write("session-close");

write("session-open");
const marker={id:"marker-b",kind:"label",text:"B",x:0,y:0};
add("Add B",[{op:"add",target:"item",document:doc.id,value:marker,after_id:id}]);
const moveB=(before,after)=>add("Move B",[
  {op:"set",target:"item",document:doc.id,id:marker.id,path:["y"],before,after}
]);
moveB(0,5);edit("x",0,15,"Move A");
write("undo");edit("x",0,8,"Branch with original B");
const older=read("session-list").branches.at(-1).tip;
write("undo",{steps:2});
assert.deepEqual(peek(older).document.items.map(item=>[item.x,item.y]),[[15,0],[0,5]]);
moveB(0,100);edit("x",0,25,"Reuse original journal positions");
const recovered=peek(older);
assert.deepEqual(recovered.document.items.map(item=>[item.x,item.y]),[[15,0],[0,5]]);
assert.deepEqual(write("session-restore",{receipt:recovered.receipt}),{applied:2,preserved:0,fork:false});
assert.deepEqual(peek().document.items.map(item=>[item.x,item.y]),[[15,0],[0,5]]);
write("undo");
assert.deepEqual(peek().document.items.map(item=>[item.x,item.y]),[[25,0],[0,100]]);
write("session-close");
assert.equal(JSON.stringify(p),input);

async function crossDocumentPaste() {
  require("../../app/notebook/clipboard-media.js");
  const project=Atrium.project("Clipboard targets"), active=project.documents[0], target=Atrium.sheet("schematic","Another sheet");
  project.documents.push(target);
  const ref={mediaType:"image/png",byteLength:3,sha256:"a".repeat(64)}, bytes=new Uint8Array([2,3,5]);
  const image={id:"test-image",name:"Image.png",kind:"image",asset:ref,x:0,y:0,w:3,h:2};
  active.items.push(image);
  const transfers=[], staged=[], released=[], scopes=[];
  let readOnly=false, locked=false, lateLock=false;
  const session={
    grant:"folder-grant",
    canEdit:did=>did!==target.id || !readOnly,
    readAsset:async({ownerId})=>{assert.equal(ownerId,active.id);return {bytes};},
    stageAttachment:asset=>staged.push(asset),
    releaseAsset:async asset=>released.push(asset)
  };
  globalThis.AtriumHost={notebookTransfer:async options=>{
    transfers.push(options);assert.equal(options.grant,session.grant);assert.equal(options.ownerId,target.id);
    return {assetRef:ref,assetToken:"verified-"+transfers.length,ownerId:options.ownerId};
  }};
  globalThis.File ||= class File {constructor(parts,name,{type}){this.type=type;}};
  globalThis.AtriumLabs={butterEnabled:f=>f==="visualHistory",notebookEnabled:()=>true,notebookSignal:()=>null};
  globalThis.AtriumLazy={need:async()=>AtriumClipboardMedia};
  globalThis.AtriumCollabLock={guard:did=>did===target.id && locked};
  globalThis.AtriumNavHost={
    project:()=>project, undoSteps:()=>({history:[],future:[]}), folderProject:()=>session,
    doc:()=>active, docById:id=>project.documents.find(d=>d.id===id),
    defs:()=>new Map(), edit(fn,label,touched,scope){
      scopes.push(scope);
      if(scope?.documents.some(did=>did===target.id && lateLock))return false;
      fn();return true;
    }
  };
  const call=(id,args)=>AtriumButter.invoke(descriptor.feature,byId.get(id),args,
    {source:"editor",scope:project,project,mode:"write",allowWrite:true},r=>r.result);
  const copied=await call("clipboard-copy",{documentId:active.id,itemIds:[image.id]});
  const paste=()=>call("clipboard-paste",{entry:copied.id,documentId:target.id,x:10,y:20});
  readOnly=true;
  assert.deepEqual(await paste(),{ids:[]});assert.equal(transfers.length,0);
  readOnly=false;locked=true;
  assert.deepEqual(await paste(),{ids:[]});assert.equal(transfers.length,0);
  locked=false;lateLock=true;
  assert.deepEqual(await paste(),{ids:[]});
  assert.equal(released.length,1,"a refused transaction releases the staged original");
  assert.equal(staged.length,0);assert.equal(target.items.length,0);
  lateLock=false;
  const result=await paste();
  assert.equal(result.ids.length,1);
  assert.equal(transfers.length,2);assert.equal(staged.length,1);
  assert.deepEqual(scopes.map(scope=>scope.documents),[[target.id],[target.id]]);
  assert.equal(active.items.length,1);
  assert.deepEqual([target.items[0].x,target.items[0].y],[10,20]);
  AtriumClipHistory.clear(true);
  console.log("PASS session dependencies and reused journal offsets, explicit clipboard destination permissions and original-byte staging");
}
globalThis.__testDone=crossDocumentPaste().catch(e=>{console.error(e);process.exitCode=1;});
