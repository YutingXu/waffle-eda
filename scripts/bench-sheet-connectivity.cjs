"use strict";
// node --expose-gc scripts/bench-sheet-connectivity.cjs [checkout]
// Same editor-side consumers and deterministic 100-sheet project on both revisions.
const path = require("node:path");
const root = path.resolve(process.argv[2] || path.join(__dirname, ".."));
for (const mod of ["core/model","library/parts","core/spatial","schematic/sch-objects","project/hierarchy","schematic/multichannel","pcb/rooms","checks/rules","checks/project-rules","checks/erc",
  "library/component-match","schematic/eco","checks/insights","checks/insights-sch","editor/nav-common","editor/crossprobe","history/undo-store"]) require(path.join(root,"app",mod+".js"));
require(path.join(root,"tests/schematic/sch-bench-project.js"));
if (!global.gc) throw Error("Run Node with --expose-gc to measure retained memory.");
const {project,stats} = makeAtriumSchBenchProject({sheets:100});
const sheets = project.documents.filter(d => d.kind === "schematic"), doc = sheets[3], cache = new WeakMap();
const defs = new Map(project.library.map(d => [d.id,d])), engine = AtriumInsights.engine(), U = AtriumUndoStore;
let revision = 0, seq = null;
AtriumCrossProbe.attach({project:() => project, doc:() => doc, defs:() => defs, revision:() => revision,
  registerAction(){}, on(){}, addRenderer(){}});
U.mark(project); U.prime();
function heap() { global.gc(); global.gc(); return process.memoryUsage().heapUsed / 1048576; }
function pass() {
  const start = performance.now(), v = U.documentVersions(doc,project);
  const erc = AtriumERC.run(project,{cache, stamp:[v.floor,v.library,v.project].join("/"), sheetVersion:d => {
    const x=U.documentVersions(d,project); return [x.floor,x.items,x.outer,x.library].join("/");
  }});
  const eco = AtriumECO.plan(project,{scope:doc.id});
  const nets = sheets.reduce((n,d) => n + AtriumCrossProbe.schematicNets(d,defs).byPin.size, 0);
  const changes = U.recordedChanges(doc,seq), it = engine.update(project,doc,defs,{...changes,from:seq,to:changes.seq},
    {prefs:false, checks:["singlePin"], outer:U.outer(), sheetChanged:s => s === doc});
  let r = it.next(); while (!r.done) r = it.next(); seq=changes.seq;
  return {ms:performance.now()-start,counts:[erc.messages.length,eco.changes.length,nets,r.value.insights.length]};
}
const before = heap(), cold = pass(), warm = [], edits = [];
const after = heap(), history=[], future=[], label=doc.items.find(i => i.kind === "netlabel" && i.text !== "GND");
for (let k=0;k<5;k++) {
  warm.push(pass().ms);
  const mark=U.mark(project); label.text="EDIT_"+k; revision++;
  U.checkpoint(history,future,mark); U.record(project,{doc,items:[label]});
  edits.push(pass());
}
const median = a => +a.sort((x,y)=>x-y)[a.length>>1].toFixed(1);
console.log(JSON.stringify({sheets:stats.sheets,parts:stats.parts,coldMs:+cold.ms.toFixed(1),warmMs:median(warm),
  editedMs:median(edits.map(e=>e.ms)),retainedMiB:+(after-before).toFixed(1),counts:[cold.counts,...edits.map(e=>e.counts)]}));
