"use strict";
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/history/undo-store.js");

const A = Atrium, U = AtriumUndoStore;
const project = A.project("Dense document items"), board = project.documents.find(d => d.kind === "pcb");
const tracks = Array.from({length: 25596}, (_, i) => ({id: "track-" + i, kind: "track", width: .2, layer: "Top", points: [[i,0],[i,1]]}));
const parts = Array.from({length: 4}, (_, i) => ({id: "part-" + i, kind: "part", ref: "R" + i, def: "def", x: i, y: 0}));
board.items.push(...parts, ...tracks);
const meta = {current: board.id}, history = [], future = [];
U.mark(project, meta);

let visits = 0;
function projectItems() {
  const items = board.items, iterator = items[Symbol.iterator];
  Object.defineProperty(items, Symbol.iterator, {configurable:true, value() {
    visits += this.length;
    return iterator.call(this);
  }});
  try { return U.documentItems(board, project); }
  finally { delete items[Symbol.iterator]; }
}
function compare() {
  const expected = new Map(), matches = new Map();
  board.items.forEach(item => {
    expected.set(item.kind, (expected.get(item.kind) || 0) + 1);
    matches.set(item.id,item);
  });
  const view = projectItems();
  assert.ok(view);
  assert.deepEqual(new Map([...view.counts].filter(([,n]) => n > 0)), expected);
  assert.deepEqual(view.byId, matches);
  assert.deepEqual(view.components, board.items.filter(item => item.kind === "part"));
  return view;
}
function edit(fn, items = []) {
  const before = U.mark(project, meta);
  fn();
  U.checkpoint(history, future, before);
  U.record(project, {doc:board, items});
}
function step(direction) {
  assert.ok(U.jump(history, future, U.mark(project,meta), direction));
}

const first = compare(), originalParts = first.components;
assert.equal(visits, 25600);
visits = 0;
for (let i = 0; i < 12; i++) {
  edit(() => { tracks[0].points[1][1] += .05; }, [tracks[0]]);
  const current = compare();
  assert.equal(current.components,originalParts,"same components after a track reshape");
}
assert.equal(visits,0,"settled track reshapes never walk the document");
const beforePartEdit = projectItems().components;
edit(() => { parts[1].ref = "R1X"; }, [parts[1]]);
assert.notEqual(compare().components,beforePartEdit);
step(-1); assert.equal(compare().components[1].ref,"R1");
step(1); assert.equal(compare().components[1].ref,"R1X");
assert.equal(visits,0,"part updates are journal patches through Undo and Redo");

const addition = {id:"added",kind:"part",ref:"R0",def:"def",x:5,y:0};
edit(() => board.items.push(addition), [addition]);
assert.equal(compare().components.at(-1),addition);
step(-1); assert.equal(compare().byId.has(addition.id),false);
step(1); assert.equal(compare().components.at(-1),addition);
assert.equal(visits,0,"append and removal preserve item order without an item walk");

edit(() => board.items.splice(2,0,board.items.pop()), [addition]);
assert.equal(compare().components[2],addition,"middle insertion uses true document order");
assert.equal(visits,board.items.length,"ambiguous reordering uses the full projection");
visits = 0;
edit(() => { board.items = [...board.items]; }, [addition]);
compare();
assert.equal(visits,board.items.length,"replacing the item array uses the full projection");
U.touch(project, {doc:board, items:[parts[0]]});
assert.equal(U.documentItems(board,project),null,"the committed projection is withheld while an edit is unrecorded");
U.record(project);
compare();
console.log("PASS dense document item projection, membership, ordering, and Undo/Redo");
