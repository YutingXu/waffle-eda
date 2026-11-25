"use strict";

const assert = require("node:assert/strict"), os = require("node:os");
for (const mod of ["core/model","library/parts","project/source-file","formats/format-2-codec","checks/design-query","history/undo-store","schematic/sch-objects","project/hierarchy","schematic/multichannel","checks/query-service"])
  require("../app/"+mod+".js");
require("../tests/pcb/dense-board.js");
const Q = AtriumQueryService, U = AtriumUndoStore;
const simple = ref => "part where designator = " + JSON.stringify(ref);
const complex = value => 'track where width < ' + value + ' mm and (layer = "Top" or width < 0.14 mm)';
const local = "track where width < 0.23 mm";
const percentile = (list,p) => +list.slice().sort((a,b) => a-b)[Math.max(0,Math.ceil(list.length*p)-1)].toFixed(3);
const summary = values => ({p50:percentile(values,.5),p95:percentile(values,.95)});
function setup() {
  const project = Atrium.project("Butter query benchmark",AtriumParts.catalogue), {d:board} = makeAtriumBenchmarkBoard();
  const def = project.library.find(d => d.symbol);
  const sheets = Array.from({length:60},(_,i) => {
    const sheet = Atrium.sheet("schematic","Sheet "+(i+1));
    sheet.id = "sheet-" + String(i).padStart(2,"0");
    for (let j=0;j<100;j++)
      sheet.items.push({id:"part-"+j,kind:"part",ref:"R"+(j+1),def:def.id,value:"1k",x:j%10*10,y:Math.floor(j/10)*10,angle:0});
    return sheet;
  });
  for (let i=1;i<sheets.length;i++) {
    const parent = sheets[Math.floor((i-1)/5)], child = sheets[i];
    parent.items.push({id:"use-"+i,kind:"sheetsymbol",name:i === 1 ? "Repeat(CH,1,2)" : child.name,sheet:child.id,entries:[]});
  }
  project.documents = [board,...sheets];
  U.reset(project);
  U.mark(project);
  return {project,board};
}
async function run({project,board}, source, options = {}) {
  const start = performance.now(), revision = () => U.recordedChanges(board).seq;
  let first;
  const result = await Q.search(source,{enabled:true,project,documentId:board.id,store:U,revision:revision(),getRevision:revision,limit:1,
    onPage:() => { first ??= performance.now() - start; },...options});
  assert.equal(result.complete,true,JSON.stringify(result.diagnostic)); assert.ok(first != null);
  return {...result,first,final:performance.now()-start};
}
function samples(results) {
  return {runs:results.length,firstMs:summary(results.map(r => r.first)),finalMs:summary(results.map(r => r.final)),
    visited:summary(results.map(r => r.visited))};
}
async function main() {
  const cold = [], coldCompound = [];
  for (let n=0;n<10;n++) {
    const state = setup();
    global.gc?.();
    const before = process.memoryUsage().heapUsed;
    const value = await run(state,simple("R1"));
    assert.equal(value.count,1);
    global.gc?.();
    cold.push({...value,retainedBytes:Math.max(0,process.memoryUsage().heapUsed-before)});
    const other = setup();
    const expected = other.board.items.filter(item => item.kind === "track" && item.width < .23 &&
      (item.layer === "Top" || item.width < .14)).length;
    const compoundResult = await run(other,complex(.23));
    assert.equal(compoundResult.count,expected);
    coldCompound.push(compoundResult);
  }
  const state = setup(), {board,project} = state;
  await run(state,simple("R1"));
  await run(state,complex(.23));
  const parts = board.items.filter(item => item.kind === "part"), exact = [], repeated = [], distinctive = [], complexes = [];
  for (let i=0;i<24;i++) {
    exact.push(await run(state,simple(parts[i+1].ref)));
    repeated.push(await run(state,simple("R1")));
    distinctive.push(await run(state,complex((.22+i*.001).toFixed(3))));
    complexes.push(await run(state,complex(.23)));
  }
  await run(state,local);
  const track = board.items.find(item => item.kind === "track");
  track.width = .35; U.record(project,{doc:board,items:[track]});
  const changed = await run(state,local); assert.equal(changed.visited,1);
  const note = {id:Atrium.id(),kind:"graphic",shape:"text",x:0,y:0,layer:"Top Silk",text:"A benchmark note"};
  board.items.push(note); U.record(project,{doc:board,items:[note]});
  const unchanged = await run(state,local); assert.equal(unchanged.visited,0);
  const aggregate = await run(state,simple("R1"),{documentId:undefined});
  const warmAggregate = await run(state,simple("R1"),{documentId:undefined});
  assert.equal(aggregate.count,61);
  assert.equal(warmAggregate.count,aggregate.count);
  assert.equal(warmAggregate.visited,0);
  const occurrenceScope = {documentId:"sheet-01",instanceId:"sheet-00/use-1#0"};
  const occurrence = await run(state,simple("R1_CH1"),occurrenceScope);
  assert.equal(occurrence.count,1);
  assert.equal((await run(state,simple("R1_CH1"),occurrenceScope)).visited,0);
  const report = {hardware:os.cpus()[0]?.model,node:process.version,objects:board.items.length-1,sheets:60,sheetParts:6000,
    cold:{...samples(cold),retainedBytes:summary(cold.map(r => r.retainedBytes))},
    coldCompound:samples(coldCompound),
    warm:{simple:samples(repeated),distinctSimple:samples(exact),complex:samples(complexes),distinctComplex:samples(distinctive)},
    touched:{track:changed.visited,note:unchanged.visited},aggregate:{count:aggregate.count,coldSheets:samples([aggregate]),warm:samples([warmAggregate])}};
  console.log(JSON.stringify(report,null,2));
  assert.ok(report.warm.distinctSimple.firstMs.p95 <= 16,"Warm simple query first-row budget");
  assert.ok(report.warm.distinctComplex.firstMs.p95 <= 50,"Warm complex query p95 first-row budget");
}
main().catch(error => {console.error(error); process.exitCode = 1;});
