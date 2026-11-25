"use strict";

const assert = require("node:assert/strict");
for (const module of ["model", "parts", "design-query-record", "rules", "project-rules", "note-fields",
  "calculation-intent","calculation-core","query-fields","calculation-helpers","calculation-records","calculation-graph",
  "calculation-design","calculations","numeric-fields","proposal","butter","butter-numericFields"])
  require(require("../support/app-source-paths.cjs").appFile(module+".js"));
const descriptor = require("../../app/automation/descriptors/numeric-fields.json");

async function main() {
  const B = AtriumButter, A = Atrium;
  const resistor = {id:A.id(), name:"resistor",prefix:"R",symbol:{shapes:[],pins:[{x:0,y:0,number:"1"}]}};
  const project = A.project("Bench",[resistor]), doc = project.documents[0];
  const part = (ref,value) => ({id:A.id(),kind:"part",ref,def:resistor.id,value,x:1,y:0});
  const first = part("R1","12k"), second = part("R2","1k");
  doc.items.push(first,second);
  const to = (id,path) => ({scope:"item",documentId:doc.id,itemId:id,path});
  const value = to(second.id,["value"]), x = to(second.id,["x"]);
  let current = true;
  const invoke = (id,args,options={}) => B.invoke("numericFields",descriptor.commands.find(c=>c.id===id),args,
    {source:"mcp",documentId:doc.id,project,scope:project,isCurrent:()=>current,...options},
    (reply,plan)=>({...reply,ops:plan.ops}));
  const apply = reply => AtriumProposal.apply(project,B.proposal(project,reply.command,reply.ops));
  const unchanged = JSON.stringify(project);
  const direct = await invoke("evaluate",{source:"10mil + 0.1 mm",unit:"mil",storageUnit:"mm"});
  assert.equal(direct.result.value,.354);
  assert.deepEqual((await invoke("evaluate",{source:"=2 V",target:x})).result.diagnostic.span,[1,4]);
  assert.equal((await invoke("inspect",{target:value})).result.value,"1k");
  assert.equal((await invoke("set",{source:"500 mV",target:value})).result.diagnostic.code,"dimension");
  assert.equal((await invoke("set",{source:"2",target:to(second.id,["id"])})).result.diagnostic.code,"missing");
  const binding = await invoke("set",{source:"=R1.Value + 5 kΩ",target:value});
  assert.equal(binding.result.value,17000);
  assert.equal(JSON.stringify(project),unchanged);
  assert.equal(binding.ops.length,2);
  assert.equal(apply(binding),2);
  assert.equal(second.value,"17000");
  assert.equal(project.numericExpressions[0].bindings[0].target.itemId,first.id);
  assert.equal((await invoke("inspect",{target:value})).result.binding.source,"R1.Value + 5 kΩ");
  assert.equal((await invoke("set",{source:"=R2.Value",target:value})).result.diagnostic.code,"cycle");
  first.ref="R9";
  const repeat = await invoke("evaluate",{source:"=R1.Value",target:value});
  assert.equal(repeat.result.value,12000);
  current=false;
  assert.equal((await invoke("set",{source:"10 mm",target:x})).result.diagnostic.code,"stale");
  current=true;
  second.locked=true;
  assert.equal((await invoke("clear",{target:value})).result.diagnostic.code,"read_only");
  second.locked=false;
  const clear=await invoke("clear",{target:value});
  assert.equal(clear.ops.length,1);
  apply(clear);
  assert.equal(project.numericExpressions,undefined);
  assert.equal(second.value,"17000");
  const wire={id:A.id(),kind:"wire",points:[[second.x,second.y],[second.x+1,second.y]]};
  doc.items.push(wire);
  const move=await invoke("set",{target:x,source:"1.25 mm"});
  assert.deepEqual(new Set(move.ops.map(op=>op.id)),new Set([second.id,wire.id]));
  wire.locked=true;
  assert.equal((await invoke("set",{target:x,source:"1.25 mm"})).result.diagnostic.code,"read_only");
  delete wire.locked;
  apply(move);
  assert.equal(second.x,1.25);
  assert.deepEqual(wire.points[0],[1.25,0]);
  const angle=await invoke("set",{target:to(second.id,["angle"]),source:"720 deg + 90 deg"});
  apply(angle);assert.equal(second.angle,90);
  second.y=2;
  const local=await invoke("set",{target:x,source:"2*y"});
  apply(local);assert.equal(second.x,4);
  const marking=await invoke("set",{target:value,source:"10k ±1%"});
  apply(marking);assert.equal(second.value,"10k ±1%");
  assert.equal((await invoke("set",{target:value,source:"10k +"})).result.ok,false);
  const board=project.documents.find(d=>d.kind==="pcb");
  const via={id:A.id(),kind:"via",x:0,y:0,drill:.2,diameter:.4};
  board.items.push(via);
  const drill={scope:"item",documentId:board.id,itemId:via.id,path:["drill"]};
  assert.equal((await invoke("set",{target:drill,source:"0.5 mm"})).result.diagnostic.code,"constraint");
  const good=await invoke("set",{target:drill,source:"10 mil"});
  apply(good); assert.equal(via.drill,.254);
  assert.throws(()=>apply(good),/changed since/);
  const pad={id:A.id(),kind:"pad",x:0,y:0,w:1,h:1,layer:"Top"};
  board.items.push(pad);
  const hole={scope:"item",documentId:board.id,itemId:pad.id,path:["drill"]};
  const bored=await invoke("set",{target:hole,source:"=3 mm"});
  apply(bored);assert.equal(pad.drill,1);assert.equal(pad.layer,"Multi");
  const clearHole=await invoke("set",{target:hole,source:"0 mm"});
  apply(clearHole);assert.equal(pad.drill,undefined);assert.equal(pad.layer,"Top");
  const label={id:A.id(),kind:"label",layer:"Silk",text:"Legend",x:0,y:0,angle:90};
  board.items.push(label);
  const labelAngle={scope:"item",documentId:board.id,itemId:label.id,path:["angle"]};
  const rotated=await invoke("set",{target:labelAngle,source:"-30 deg"});
  apply(rotated); assert.equal(label.angle,330);
  const defaultAngle=await invoke("set",{target:labelAngle,source:"= 720 deg"});
  apply(defaultAngle);
  assert.equal(label.angle,undefined);
  assert.equal(project.numericExpressions.at(-1).omitZero,true);
  const grid={scope:"document",documentId:doc.id,path:["grid"]};
  assert.equal((await invoke("set",{target:grid,source:"10 µm"})).result.diagnostic.code,"range");
  const boardGrid={...grid,documentId:board.id};
  board.grid=.00025;
  const old=await invoke("inspect",{target:boardGrid});
  assert.equal(old.result.value,.00025);
  assert.equal(old.result.spec.min,.001);
  assert.equal((await invoke("set",{target:boardGrid,source:"0.5 µm"})).result.diagnostic.code,"range");
  for(const [source,expected] of [["10 µm",.01],["0.025 mm",.025],["1 µm",.001]]){
    const spacing=await invoke("set",{target:boardGrid,source});
    assert.equal(spacing.result.value,expected);
    apply(spacing);assert.equal(board.grid,expected);
  }
  assert.equal((await invoke("set",{target:grid,source:"1 mil"})).result.value,.0254);
  console.log("PASS all four Butter numeric commands: read purity, typed spans, one atomic plan, guarded writes, and stable binding lineage.");
}
main().catch(e=>{console.error(e);process.exitCode=1;});
