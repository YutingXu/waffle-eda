"use strict";
// A committed selection can move together, or change which copper it touches.
const assert = require("node:assert/strict");
for (const name of ["model", "parts", "board-shape", "net-ties", "undo-store", "engine-core", "connectivity", "connectivity-live"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

const A = Atrium, U = AtriumUndoStore, C = AtriumConnectivity, L = AtriumConnectivityLive;
const d = A.sheet("pcb", "Grouped airwires"), defs = new Map();
const via = (id, x, y, net) => ({id,kind:"via",x,y,net,diameter:.8,drill:.3,layer:"Multi"});
const track = {id:"track",kind:"track",layer:"Top",net:"A",width:.2,points:[[0,0],[3,0]]};
const mover = via("mover",2,0,"A"), fixed = via("fixed",0,0,"A"), alternate = via("alternate",0,2,"A");
const spare = via("spare",0,10,"B"), untouched = via("untouched",0,20,"C");
d.items.push(track,mover,fixed,alternate,via("tail",9,0,"A"),
  spare,via("spare-tail",9,10,"B"),untouched,via("untouched-tail",9,20,"C"));
const project = {documents:[d],library:[]}, history = [], future = [];
const fields = r => [r.nets,r.airwires,r.shorts,r.excluded,r.unassigned,r.stats.objects,r.stats.features,r.sourceNotes];

let last, lastBytes;
function check(label) {
  const work = L.stages(d,defs,U);
  let next = work.next(), slices = 0;
  while (!next.done) { slices++; next = work.next(); }
  const result = next.value;
  const clone = A.clone(d);
  clone.id += "-reference";
  assert.deepEqual(fields(result),fields(C.inspectFull(clone,defs)),label);
  assert.equal(result.stats.contacts,L.inspect(clone,defs).stats.contacts,label + " contact count");
  if (last) assert.equal(JSON.stringify(fields(last)),lastBytes,label + " preserves the previously published result");
  last = result;
  lastBytes = JSON.stringify(fields(last));
  return {result,slices};
}
function commit(label, fn) {
  const mark = U.mark(project);
  fn();
  U.checkpoint(history,future,mark,label);
  U.record(project);
}
function edit(label, fn) {
  commit(label,fn);
  return check(label);
}
function jump(direction, label) {
  assert.ok(U.jump(history,future,U.mark(project),direction));
  U.record(project);
  return check(label);
}
function movePair(y) {
  track.points = track.points.map(([x]) => [x,y]);
  mover.y = y;
}

U.mark(project);
const first = check("seed").result;
const unchangedWire = first.airwires.find(w => w.net === "C");
assert.ok(unchangedWire);
const {result:moved,slices} = edit("move contacting copper together",() => movePair(.05));
assert.equal(slices,1,"a local group keeps the existing islands");
assert.equal(moved.airwires.find(w => w.net === "C"),unchangedWire,"unaffected net keeps its airwire");
assert.notDeepEqual(moved.airwires.filter(w => w.net === "A"),first.airwires.filter(w => w.net === "A"),"moved net updates the anchors");
const grouped = edit("group spans nets",() => { movePair(.1); spare.x += .15; });
assert.equal(grouped.slices,1,"several nets keep their existing islands");
assert.equal(jump(-1,"undo a group move").slices,1);
assert.equal(jump(1,"redo a group move").slices,1);
const newNeighbour = edit("swap a neighbour while preserving contact count",() => movePair(2));
assert.ok(newNeighbour.slices>1,"different neighbours rebuild the islands");
assert.equal(last.stats.contacts,moved.stats.contacts,"old and new neighbourhoods have the same number of contacts");
edit("split a contact between two moved items",() => { movePair(1); mover.y = .1; });
edit("move and assign a different net at the contact",() => { movePair(0); mover.net = "B"; });
assert.ok(last.shorts.some(s => s.nets.includes("A") && s.nets.includes("B")));
edit("remove a shorted item and move another",() => { d.items.splice(d.items.indexOf(mover),1); spare.x += .15; });
edit("replace an item with the same id and move another",() => {
  d.items[d.items.indexOf(alternate)] = {...alternate,net:"C"};
  spare.x += .15;
});
for (const direction of [-1,-1,-1,-1,1,1,1,1]) {
  jump(direction,direction < 0 ? "undo" : "redo");
}
const reordered = edit("reorder the existing array while changing an item",() => { d.items.reverse(); spare.x -= .05; });
assert.ok(reordered.slices>1,"changed item order rebuilds the islands");
commit("start projecting a group",() => { track.points[0][1] += .1; spare.x += .05; });
const abandoned = L.stages(d,defs,U);
assert.equal(abandoned.next().done,false);
edit("supersede the staged group",() => { track.points[0][1] -= .04; spare.x -= .1; });
abandoned.return();
edit("move a group after reconciliation",() => { track.points[0][1] -= .01; spare.x -= .1; });

// A large group yields before changing the graph and while verifying its new neighbours.
const large = Array.from({length:40},(_,i) => via("group-" + i,i*2,30,"D"));
edit("add contacts for a sliced group",() => { d.items.push(...large); });
for (const steps of [1,3]) {
  commit("move the sliced group",() => { for (const item of large) item.y += .05; });
  const older = L.stages(d,defs,U);
  for (let i=0;i<steps;i++) assert.equal(older.next().done,false);
  edit("supersede slice " + steps,() => { for (const item of large) item.y += .05; });
  assert.deepEqual(older.next(),{value:undefined,done:true},"the superseded slice publishes no result");
}
U.reset();
console.log("PASS grouped airwires: exact anchors and contact changes, removals, replacement, undo, redo and supersession");
