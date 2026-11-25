"use strict";

const assert = require("node:assert/strict");
for (const name of ["model","sch-objects","note-fields","notebook","calculation-helpers","calculation-intent","calculation-core","calculation-records",
  "calculation-actions","calculation-design","calculation-graph","calculation-checks","calculations","edit-selection","selection-clipboard","calculation-sheet",
  "diff","project-history-summary","rules","project-rules"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));

const {Atrium:A,AtriumCalculationRecords:R,AtriumCalculations:C,AtriumCalculationActions:actions} = globalThis;
const part = {kind:"part",id:"res",def:"resistor",ref:"R5",value:"10k",x:10,y:10};
const other = {kind:"part",id:"cap",def:"capacitor",ref:"C3",value:"1n",x:20,y:10};
const project = A.project("Timing",[
  {id:"resistor",name:"Resistor",prefix:"R",symbol:{pins:[],shapes:[]}},
  {id:"capacitor",name:"Capacitor",prefix:"C",symbol:{pins:[],shapes:[]}}
]);
const doc = project.documents[0]; doc.id = "timing"; doc.items.push(part,other);
const clone = o => JSON.parse(JSON.stringify(o));
async function run() {
  const source = "frequency = 1/(2*pi*R5*C3)", bound = await C.bindSource(project,{documentId:doc.id,source});
  assert.equal(bound.bindings.length,2);
  const note = R.backing({id:"block",x:0,y:0,source,bindings:bound.bindings,assertions:[]});
  assert.equal(note.text,source); assert.ok(!("source" in note.calculation)); assert.ok(!("role" in note)); assert.ok(R.valid(note));
  doc.items.push(note); A.validate(project);
  for (const extra of [{math:true},{widget:{}},{role:"frame"},{kind:"label"}]) assert.throws(() => A.validate({...project,documents:[{...doc,items:[{...note,...extra}]}]}));
  assert.ok(!R.valid({...note,calculation:{...note.calculation,result:0}}));
  const original = clone(project), fixed = R.frozen(project,doc,"A").get(note.id);
  assert.equal(fixed.result.display,"15.92 kHz"); assert.deepEqual(project,original);
  assert.ok(fixed.result.warnings.some(m => /tolerance unknown/i.test(m)));
  other.value="10n"; const changed = R.frozen(project,doc,"B").get(note.id);
  assert.equal(changed.result.display,"1.592 kHz"); assert.equal(R.compareSides(note,fixed,note,changed)[0].kind,"result");
  const changes = AtriumDiff.compare(original,project,{drc:false}).changes.filter(c=>c.category==="notes");
  assert.equal(changes.length,1);assert.match(changes[0].kind,/result/);
  assert.equal(changes[0].before.value.display,"15.92 kHz");assert.equal(changes[0].after.value.display,"1.592 kHz");
  assert.ok(AtriumHistorySummary.fromProjects(original,project,"all",true).regions.some(r=>r.group==="Notes"));
  const revised = R.backing({...R.read(note),source:"2",bindings:[]});
  assert.equal(R.compareSides(note,fixed,revised,null)[0].kind,"formula");
  assert.equal(R.staticOutput(R.read(note),changed,"KiCad").fidelity.blockId,"block");
  assert.ok(R.staticOutput(R.read(note),changed,"Altium").text.includes("1.592 kHz"));
  part.ref = "R17"; assert.equal(R.frozen(project,doc,"renamed").get(note.id).result.display,"1.592 kHz");
  doc.items.splice(doc.items.indexOf(part),1,{...part,id:"replacement",ref:"R5"});
  const missing = R.frozen(project,doc,"broken").get(note.id); assert.equal(missing.result.ok,false);
  assert.equal(R.staticOutput(R.read(note),missing,"KiCad").fidelity.status,"incomplete");
  doc.items[0]=part; part.ref="R5"; other.value="1n";
  const selection = new Set([note.id,part.id]), defs = new Map(project.library.map(d=>[d.id,d]));
  const clip = AtriumEditSelection.capture(doc,defs,selection,false,null,project);
  const encoded = AtriumSelectionClipboard.encode(clip,"test"), decoded = AtriumSelectionClipboard.decode(encoded.data);
  const copied = AtriumEditSelection.prepare(project,doc,decoded,defs).items, noteCopy=copied.find(i=>i.calculation), partCopy=copied.find(i=>i.kind==="part");
  assert.notEqual(noteCopy.id,note.id); assert.notEqual(noteCopy.calculation.bindings[0].id,bound.bindings[0].id);
  assert.equal(noteCopy.calculation.bindings.find(b=>b.name==="R5").target.itemId,partCopy.id);
  assert.equal(noteCopy.calculation.bindings.find(b=>b.name==="C3").target.itemId,other.id);
  const foreign = clone(project), far = foreign.documents[0], imported = AtriumEditSelection.prepare(foreign,far,decoded,defs).items.find(i=>i.calculation);
  assert.equal(imported.calculation.bindings.find(b=>b.name==="C3").target.detached,true);
  const movedProject=clone(original), old=movedProject.documents[0], child=A.sheet("schematic","Extracted");
  const moved=old.items.splice(0,1), childId=child.id; child.items.push(...moved); movedProject.documents.push(child);
  const retained=old.items.find(i=>i.calculation);retained.calculation.bindings.forEach(b=>{b.target.instanceId="old";});
  const paths=new Map();paths.forTarget=(instance,document,item)=>item==="res"?"wrapper":"old";
  const movedScopes=R.moveBindings(movedProject,old.id,childId,moved,paths);
  assert.equal(movedScopes[0].items[0].id,retained.id);
  assert.equal(retained.calculation.bindings.find(b=>b.name==="R5").target.docId,childId);
  assert.equal(retained.calculation.bindings.find(b=>b.name==="C3").target.instanceId,"old");
  const assertion=R.backing({id:"test-assert",x:2,y:2,source:"assert 3 V > 2 V",bindings:[],assertions:[]});
  const primary=assertion.calculation.primaryAssertionId;assert.ok(primary);assert.equal(assertion.calculation.assertions.length,0);
  doc.items.push(assertion); C.syncRules(project);
  assert.equal(project.rules.list.filter(r=>r.origin?.assertion===primary).length,1);
  assert.equal(R.frozen(project,doc,9).get(assertion.id).assertions[0].result.assertion.status,"pass");
  doc.items.pop();C.syncRules(project);assert.equal(project.rules.list.filter(r=>r.origin?.assertion===primary).length,0);
  const host={project:()=>project,doc:()=>doc,selection:()=>[part.id],revision:()=>4,currentId:()=>doc.id};
  const ready=await C.answer({queryId:1,text:"3.3V/10mA",documentId:doc.id,projectRevision:4,selection:[part.id]},{host,project});
  assert.ok(ready.result?.ok,JSON.stringify(ready)); assert.deepEqual(ready.actions,["copy","insert","apply"]);
  const pure=await C.answer({queryId:2,text:"10k || 4.7k",documentId:doc.id,projectRevision:4,selection:[part.id]},{host,project});
  assert.deepEqual(pure.actions,["copy","insert"]); assert.equal(pure.display,"3.197 k");
  part.locked=true; assert.deepEqual(actions.eligibleActions(ready,{host}),["copy","insert"]); delete part.locked;
  project.atriumCompat={readOnly:"2"}; assert.deepEqual(actions.eligibleActions(ready,{host}),["copy"]); delete project.atriumCompat;
  assert.ok(!C.resolvePaletteAnswer({...ready,resultKey:"fake"}));
  const originalLength=doc.items.length; let writes=0;
  host.edit=f=>{writes++; f();}; host.select=()=>{};
  const result=await C.applyPaletteAnswer(ready,"insert",{host,docId:doc.id,selection:[part.id],point:[2.1234567,3]});
  assert.equal(result.status,"inserted"); assert.equal(writes,1); assert.equal(doc.items.length,originalLength+1);
  assert.equal(doc.items.at(-1).x,2.123457);

  // Register the actual math-registry listener while a calculation is in a split pane beside an active PCB.
  const board = project.documents.find(d => d.kind === "pcb"), redraws = [];
  let registryChanged, completed, active = project;
  const rendered = new Promise(done => { completed = done; });
  globalThis.AtriumNavHost = {...host, project: () => active, doc: () => board, currentId: () => board.id,
    panes: () => [{docId:board.id}, {docId:doc.id}],
    invalidateDocument(id, artwork) { redraws.push([id, artwork]); completed(); }};
  globalThis.AtriumCalculationDisplay = {draw() {}};
  globalThis.AtriumExtensionPalette = {mathFunctions: () => [], onMathFunctionsChanged(callback) { registryChanged = callback; }};
  AtriumCalculationSheet.draw({}, note, {doc});
  await rendered;
  assert.deepEqual(redraws.splice(0), [[doc.id,true]], "completion invalidates the owning schematic artwork");
  assert.equal(typeof registryChanged, "function");
  registryChanged();
  assert.deepEqual(redraws.splice(0), [[doc.id,true]], "registry invalidation repaints the visible calculation without invalidating the active PCB");

  let request;
  globalThis.AtriumCalculations = {...C, evaluate(...args) { return request = C.evaluate(...args); }};
  AtriumCalculationSheet.draw({}, note, {doc});
  active = clone(project); // Keep the same document IDs and host revision.
  await assert.rejects(request, {name:"AbortError"});
  assert.deepEqual(redraws, [], "a rejected result from the old project does not invalidate art in its replacement");
  console.log("Calculation sheet records, live quantities, uncertainty, identity, copy, actions, Compare and export passed");
}
globalThis.__testDone=run(); globalThis.__testDone.catch(e=>{console.error(e);process.exitCode=1;});
