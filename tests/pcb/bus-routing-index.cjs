"use strict";
// Foreground bus sessions on the same 25,600-object placement as the canvas benchmark.
// The oracle materializes a separate source board and obstacle grid for every comparison.
const assert = require("node:assert/strict");
for (const m of ["model","parts","undo-store","stackup","viastack","query","net-intent","signals","rules","xsignals","impedance","timing-vision","connectivity","topology","length-tuning","router","multi-route","bus-route"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("./dense-board.js");
const U = AtriumUndoStore, B = AtriumBusRoute, R = AtriumRouter, L = AtriumLength;
const {d: board, defs} = makeAtriumBenchmarkBoard();
const project = {format: "atrium", version: 1, name: "Sixteen lanes", library: [...defs.values()], documents: [board]};
board.outline[0][0] = board.outline[3][0] = -60;
const nets = Array.from({length: 16}, (_, k) => "BYTE" + k);
const pad = (id,net,x,y) => ({id,net,kind:"pad",number:id,x,y,w:.25,h:.25,layer:"Top",shape:"round"});
const sources = nets.map((net,k) => pad("s"+k,net,-50,5+k*.6));
const loads = nets.map((net,k) => pad("e"+k,net,-8,5+k*.6));
const obstacle = {id:"local",kind:"via",x:-31,y:20,net:"OTHER",layer:"Multi",diameter:.7,drill:.3,locked:true};
board.items.splice(0,33,...sources,...loads,obstacle);
let reads = 0;
board.items = new Proxy(board.items,{get(a,k,r){if(typeof k === "string" && /^\d+$/.test(k)) reads++; return Reflect.get(a,k,r);}});
const history=[], future=[], near=[-50,9.5], dest=[-8,9.5];
let rev=0;
U.touch(project); U.sync(project);
const edit = fn => { const mark = U.mark(project,{}); fn(); U.checkpoint(history,future,mark); U.touch(project); U.sync(project); rev++; };
const undo = () => { U.jump(history,future,U.mark(project,{}),-1); U.touch(project); U.sync(project); rev++; };
const options = () => ({project,revision:rev,layer:"Top",width:.15,gap:.2,corner:"45",mode:"walkaround",moveBudgetMs:50});
function sample(d, options, click = true) {
  const m = B.membersNear(d,defs,nets,near,options);
  assert.equal(m.length,16);
  const session = B.begin(d,defs,{...options,members:m});
  const p = session.move([-22,9.5]);
  const head = {status:p.status, end:p.end, lengths:p.bus.members.map(m=>m.length), geometry:p.preview.map(m=>[m.net,m.layer,m.width,m.points])};
  if (!click) { session.cancel(); return {m,head}; }
  assert.ok(session.click().anchored);
  const done = session.complete(dest);
  assert.equal(done.ok,true,done.message);
  let i=0;
  const plan = session.commit({makeId:()=>"new"+(++i)});
  return {m,head,add:plan.add};
}
function oracle(click) {
  const raw = JSON.parse(JSON.stringify(board));
  return sample(raw,{...options(),project:{...project,documents:[raw]},revision:undefined},click);
}
function compare(label, expectedReads, click=true) {
  reads=0;
  const result=sample(board,options(),click);
  assert.equal(reads,expectedReads,label+" source array slots");
  assert.deepEqual(result,oracle(click),label+" equals a fresh board/index");
  return result;
}
const initial=compare("cold",2*board.items.length);
compare("warm",0);
const copper={...board,items:[...board.items,...initial.add]};
assert.deepEqual(AtriumRules.drc(copper,defs,undefined,{types:["clearance"],scopes:false}).violations,[]);
assert.equal(AtriumConnectivity.inspect(copper,defs).airwires.filter(a=>nets.includes(a.net)).length,0);
// Compare bounded nearest queries with a linear oracle, including equal-distance source-order
// ties, several contacts at one X, explicit IDs, blocked layers and excluded starts.
const syntheticEnds=Array.from({length:180},(_,i)=>({id:"e"+i,at:[(i*7)%23,(i*29)%31],layer:i%4?"Top":"Bottom",kind:"pad",r:.1}));
syntheticEnds.unshift({id:"left",at:[-1,-2],layer:"Top",kind:"pad",r:.1},{id:"right",at:[1,-2],layer:"Top",kind:"pad",r:.1});
const inventory={ends:new Map([["N",syntheticEnds]])};
for(const q of [[0,-2],[16,8],[3,17],[71,-33]]) for(const opt of [{},{layer:"Bottom"},{ids:["e12","e66"],layer:"Top"},{ids:["absent"],layer:"Top"},{exclude:[[-1,-2]],skip:e=>e.at[0]===0}]) {
  let all=syntheticEnds.filter(e=>!opt.layer||e.layer===opt.layer);
  const wanted=opt.ids&&all.filter(e=>opt.ids.includes(e.id));if(wanted?.length) all=wanted;
  all=all.filter(e=>!opt.skip?.(e) && !opt.exclude?.some(p=>Math.hypot(p[0]-e.at[0],p[1]-e.at[1])<1e-6));
  const best=all.map(e=>({e,d:Math.hypot(e.at[0]-q[0],e.at[1]-q[1])})).sort((a,b)=>a.d-b.d)[0];
  assert.deepEqual(B.membersNear(board,defs,["N"],q,{inventory,...opt})[0]?.at,best?.e.at);
}
const prior=L.routingIndex(board,defs,options()), lane3=prior.itemsFor("BYTE3");
edit(()=>{sources[0].x-=.5;});
const revised=compare("source pad edit",0);
assert.notDeepEqual(revised.m[0].at,initial.m[0].at);
assert.equal(L.routingIndex(board,defs,options()).itemsFor("BYTE3"),lane3);
undo();
assert.deepEqual(compare("undo source pad",0),initial);
edit(()=>{project.parameters={Build:"A"};});
compare("unrelated project parameter",0);
edit(()=>{obstacle.y=9.5;});
const detour=compare("locked via moved into the corridor",0,false);
assert.notDeepEqual(detour.head.geometry,initial.head.geometry);
undo();
assert.deepEqual(compare("undo locked via movement",0),initial);
edit(()=>{board.items.reverse();});
compare("list reorder",2*board.items.length);
undo();
compare("undo list reorder",2*board.items.length);
const added = {...obstacle,id:"added",x:-24};
edit(()=>{board.items.push(added);});
compare("append one obstacle",2);
undo();
compare("undo obstacle append",0);
const before=JSON.stringify(board.items);
const bad=B.begin(board,defs,{...options(),nets,near,order:nets.slice().reverse()});
const violation=bad.move([-30,9.5]);
assert.equal(violation.status,"violation");
assert.equal(bad.click().anchored,false);
bad.cancel();
assert.equal(JSON.stringify(board.items),before);
const otherDefs = new Map(defs), other = JSON.parse(JSON.stringify(defs.get("std-r")));
other.footprint.pads[0].layer = "Inner 7"; otherDefs.set("std-r",other);
const otherIndex = L.routingIndex(board,otherDefs,options());
assert.deepEqual(AtriumStackup.get(board,otherDefs,otherIndex),AtriumStackup.get(board,otherDefs));
assert.notDeepEqual(AtriumStackup.get(board,otherDefs,otherIndex),AtriumStackup.get(board,defs));
assert.deepEqual(L.routingIndex(board,defs,options()).defs,defs);
console.log("PASS 16 indexed lanes on 25,600 objects, cold/warm, changed pad, unrelated metadata, near copper, reordered items, Undo, DRC, connectivity and refused crossing");
