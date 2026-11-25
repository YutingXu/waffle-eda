"use strict";
// Usage: node scripts/bench-bus-locality.cjs /path/to/MainBoard_6_layers.PcbDoc
// APP=/other/checkout/app compares the same commands across revisions. The read counter covers
// numeric positions of board.items. Independent counters measure the broad phase and exact distances.
const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm"), crypto = require("node:crypto");
const assert = require("node:assert/strict");
const root = path.join(__dirname, ".."), app = process.env.APP || path.join(root, "app");
const bytes = fs.readFileSync(process.argv[2]);
const source = require("../tests/altium-fidelity/fixtures.json").projects.find(p => p.id === "garganturam");
assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), source.assets.find(a => a.path.endsWith("MainBoard_6_layers.PcbDoc")).sha256);
globalThis.CFB = require(path.join(app, "vendor/cfb.min.js"));
for (const m of ["core/model","library/parts","checks/connectivity","pcb/stackup","checks/altium-rules","pcb/rooms","pcb/component-classes","checks/query","checks/net-intent","core/signals","checks/rules","pcb/pcb-draw","pcb/board-shape","schematic/sch-objects","project/hierarchy","pcb/polygon-pour","formats/import-link","project/source-file","formats/sch-import","pcb/pcb-pours","formats/pcb-import","formats/io","history/undo-store","analysis/impedance","pcb/timing-vision","pcb/xsignals","pcb/topology","pcb/length-tuning"]) require(path.join(app, m+".js"));
let region;
const hook = "    return m;\n  }\n  // Exact edge-to-centreline distance";
let router = fs.readFileSync(path.join(app,"pcb/router.js"),"utf8");
assert.ok(router.includes(hook) && router.includes("function fdist(W, f, ax, ay, bx, by) {"), "update benchmark hooks for this router version");
globalThis.busBenchRegion = (W, count) => {
  if (!region) return;
  region.queries++; region.candidates += count;
  for (let j=0; j<count; j++) region.unique.add(W.qb[j]);
};
globalThis.busBenchExact = f => { if (region) { region.exact++; region.exactUnique.add(f); } };
router = router.replace(hook,"    globalThis.busBenchRegion(W,m);\n"+hook).replace("function fdist(W, f, ax, ay, bx, by) {","function fdist(W, f, ax, ay, bx, by) { globalThis.busBenchExact(f);");
vm.runInThisContext(router,{filename:path.join(app,"pcb/router.js")});
for (const m of ["pcb/diffpair","pcb/multi-route"]) require(path.join(app,m+".js"));
let bus = fs.readFileSync(path.join(app,"pcb/bus-route.js"),"utf8");
const compareEnd = "function consider(e, order) {";
globalThis.busBenchEnd = () => { if (region) region.endpointComparisons++; };
if (bus.includes(compareEnd)) bus = bus.replace(compareEnd,compareEnd+" globalThis.busBenchEnd();");
vm.runInThisContext(bus,{filename:path.join(app,"pcb/bus-route.js")});
const project = AtriumIO.read("MainBoard_6_layers.PcbDoc",new Uint8Array(bytes));
const board = project.documents.find(d => d.kind === "pcb"), defs = new Map(project.library.map(d => [d.id,d]));
const nets = [...new Set(board.items.filter(t => t.kind === "track" && t.net).map(t => t.net))].slice(0,11);
let reads = 0;
board.items = new Proxy(board.items,{get(target,key,receiver) {
  if (typeof key === "string" && /^\d+$/.test(key)) reads++;
  return Reflect.get(target,key,receiver);
}});
const U = AtriumUndoStore, B = AtriumBusRoute, opts = {project,revision:1,halos:false}, phases = [];
U.touch(project); U.sync(project);
function measure(phase, run) {
  reads = 0; region = {endpointComparisons:0,queries:0,candidates:0,exact:0,unique:new Set(),exactUnique:new Set()};
  const start = performance.now(), value = run(), ms = +(performance.now()-start).toFixed(3);
  const {endpointComparisons,queries,candidates,unique,exact,exactUnique} = region; region=null;
  phases.push({phase,sourceSlots:reads,ms,...bus.includes(compareEnd) ? {endpointComparisons} : {},queries,candidates,uniqueCandidates:unique.size,distances:exact,uniqueDistances:exactUnique.size,...value?.status ? {status:value.status} : {}});
  return value;
}
const W = measure("cold obstacle index",()=>AtriumRouter.world(board,defs,opts));
function session(label) {
  const members = measure(label+" source pick",()=>B.membersNear(board,defs,nets,[12,1],opts));
  const s = measure(label+" begin",()=>B.begin(board,defs,{...opts,members}));
  measure(label+" first point",()=>s.move([60,30]));
  measure(label+" changed point",()=>s.move([61,30])); s.cancel();
}
session("cold"); session("repeated");
const index = globalThis.AtriumLength.routingIndex?.(board,defs,opts);
const selected = index ? nets.map(net=>({net,sourceRows:index.itemsFor(net).length,endpoints:index.groups.get(net)?.endpoints?.length || 0})) : null;
const undo = [], redo = [];
function edit(fn) { const mark=U.mark(project,{}); fn(); U.checkpoint(undo,redo,mark); U.touch(project); U.sync(project); opts.revision++; }
const back = () => { U.jump(undo,redo,U.mark(project,{}),-1); U.touch(project); U.sync(project); opts.revision++; };
const track=board.items.find(t=>t.kind==="track" && t.net===nets[0]);
edit(()=>{track.width+=.02;}); session("selected track width");
back(); session("undo selected track width");
edit(()=>{project.parameters={...project.parameters,ImagePlot:"on"};}); session("project parameter");
edit(()=>{board.items.reverse();}); session("reverse source order");
back(); session("undo source order");
console.log(JSON.stringify({board:board.name,revision:source.revision,source:board.items.length,features:W.nBuilt,nets,selected,phases},null,2));
