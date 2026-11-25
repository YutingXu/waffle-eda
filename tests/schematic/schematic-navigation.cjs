"use strict";
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/schematic/sch-objects.js");
require("../../app/editor/nav-common.js");
require("../../app/editor/crossprobe.js");
require("../../app/editor/altium-keys.js");
require("../../app/history/undo-store.js");

const A = Atrium, X = AtriumCrossProbe, K = AtriumAltiumKeys, U = AtriumUndoStore;
const full = A.connectivity, mapDefs = lib => new Map(lib.map(d => [d.id, d]));
function sheet(id) {
  return {id, kind:"schematic", name:id, items:[
    {id:id+"j", kind:"junction", x:4.00002, y:0},
    {id:id+"mid", kind:"junction", x:2, y:0},
    {id:id+"w", kind:"wire", points:[[0,0],[4,0]]},
    {id:id+"p", kind:"part", def:"gate", ref:"U"+id, x:0, y:0, unit:1},
    {id:id+"n", kind:"netlabel", text:"SIGNAL", x:0, y:0},
    {id:id+"child", kind:"sheetsymbol", name:"Child", sheet:"B", x:2, y:-1, w:2, h:3,
      entries:[{name:"IN", side:"left", offset:1}]}
  ]};
}
const a = sheet("A"), b = sheet("B");
const board = {id:"pcb", kind:"pcb", name:"Board", items:[{id:"track", kind:"track", net:"SIGNAL", points:[[0,0],[4,0]]}],
  pcbDrawing:{pours:[{polygon:"pour", net:"SIGNAL", data:"a"}]}};
let project = {documents:[a,b,board], library:[{id:"gate", symbol:{parts:2, shapes:[],
  pins:[{part:1, number:"1", x:4, y:0}, {part:2, number:"2", x:8, y:0}]}}]};
let defs = mapDefs(project.library), rev = 0, highlight = "SIGNAL", active = a, drag = null;
const history = [], future = [], listeners = new Map(), renderers = [], builds = [];
const host = {project:() => project, doc:() => active, drag:() => drag, defs:() => defs, revision:() => rev, highlight:() => highlight,
  on(name, f) {if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(f);},
  registerAction() {}, addRenderer(f) {renderers.push(f);}};
X.attach(host); K.attach(host);
const renderMask = renderers.at(-1);
U.mark(project);
A.connectivity = (doc, ds) => {if (project.documents.includes(doc)) builds.push(doc.id); return full(doc, ds);};
function changed() {
  rev++;
  for (const f of listeners.get("change") || []) f();
}
function edit(fn, pending = false) {
  const s = U.mark(project);
  fn(); U.checkpoint(history, future, s);
  if (pending) U.touch(project); else U.record(project);
  changed();
}
function go(n) {
  assert.ok(U.jump(history, future, U.mark(project), n));
  project = U.root(); U.record(project); changed();
}
function expectBuilds(ids, fn) {
  const pos = builds.length;
  fn();
  assert.deepEqual(builds.slice(pos), ids);
}
// The original mask joins a junction only at a vertex of a highlighted wire,
// including vertices equal after grid rounding. Preserve the fills' drawing order.
function referenceMask(d, ds, graph, net) {
  const fills = [], points = [];
  const onNet = w => w.kind === "wire" && graph.byWire.get(w.id) === net;
  for (const i of d.items) {
    if (onNet(i)) points.push(i.points);
    else if (i.kind === "part") {
      for (const pin of A.pins(i, ds.get(i.def), "schematic"))
        if (graph.byPin.get(i.id+"/"+pin.number) === net) fills.push({circle:[...pin.at, 1.1]});
    } else if ((i.kind === "netlabel" || AtriumSchObjects.KINDS.has(i.kind)) && i.text === net) {
      const r = AtriumNavCommon.itemBox(d, ds, i);
      if (r) fills.push({rect:[r[0]-.6, r[1]-.6, r[2]+.6, r[3]+.6]});
    } else if (i.kind === "junction" && d.items.some(w => onNet(w) && w.points.some(p => A.same(p, [i.x,i.y])))) {
      fills.push({circle:[i.x,i.y,1]});
    }
  }
  return {fills, strokes:points.length ? [[.6,points]] : []};
}
function check(doc) {
  const copy = A.clone(doc), ds = mapDefs(A.clone(project.library)), wanted = full(copy, ds);
  assert.deepEqual(X.schematicNets(doc, defs), wanted, doc.name + " matches a new full solve");
  for (const {name} of wanted.nets) {
    const expectedItems = copy.items.filter(i => (i.kind === "wire" && wanted.byWire.get(i.id) === name) ||
      (i.kind === "netlabel" && i.text === name)).map(i => i.id);
    assert.deepEqual(X.netObjects(doc, defs, name).ids, expectedItems);
    assert.deepEqual(K.maskShapes(doc, defs, name), referenceMask(copy, ds, wanted, name));
  }
}

expectBuilds(["A","B"], () => {check(a); check(b);});
const original = X.schematicNets(a, defs);
assert.equal(X.pinNet(a, defs, a.items[3], "1"), "SIGNAL");
expectBuilds([], () => {
  edit(() => {board.items[0].points[1][0] += 1;});
  check(a); check(b);
  assert.equal(X.schematicNets(a, defs), original);
  board.pcbDrawing.pours[0].data = "b";
  U.touch(project); changed(); U.sync();
  check(a); check(b);
});
const label = a.items[4], wire = a.items[2], symbol = a.items[5];
const edits = [
  () => {label.text = "CLOCK";},
  () => {wire.points[1] = [3,2];},
  () => {a.items.push({id:"new",kind:"wire",points:[[3,2],[4,0]]});},
  () => {a.items.splice(a.items.indexOf(label), 1);},
  () => {a.sourceName = "Top.SchDoc";},
  () => {symbol.entries[0].offset = 2; symbol.sheet = "C";},
  () => {a.items[3].unit = 2;},
  () => {wire.id = "renamed-wire";}
];
for (const fn of edits) {
  expectBuilds([], () => edit(fn)); // no edit listener walks or rebuilds a closed sheet
  expectBuilds(["A"], () => {check(b); check(a);});
}
for (const n of [-1,-1,1,1]) expectBuilds(["A"], () => {go(n); check(b); check(a);});

// A pending edit gets a full answer immediately and leaves recording to idle.
// When the store later commits a changed definition, even the same host revision
// and same defs Map must observe the new pin array.
edit(() => {project.library[0].symbol.pins.splice(0, 1, {part:1, number:"new", x:4, y:0});}, true);
expectBuilds(["B"], () => check(b));
assert.equal(U.unrecorded(), true);
assert.equal(X.pinNet(b, defs, b.items[3], "new"), "SIGNAL");
U.sync();
expectBuilds(["A","B"], () => {check(a); check(b);});
project.library[0].symbol.pins[0].x = 20;
U.record(project); // even without a new paint/edit revision
expectBuilds(["B","A"], () => {check(b); check(a);});
assert.equal(X.pinNet(b, defs, b.items[3], "new"), "");

edit(() => {a.items = a.items.slice().reverse();});
expectBuilds(["A"], () => {check(a); check(b);});
edit(() => {project.documents.push(sheet("C"));});
expectBuilds(["B","A"], () => {check(b); check(a);}); // journal gap
active = project.documents[3];
drag = {before:U.mark(project)};
active.items[4].x = 50;
assert.notEqual(X.netOf(active, defs, active.items[2]), "SIGNAL");
active.items[4].x = 0;
U.rollback(drag.before); drag = null;
assert.equal(X.netOf(active, defs, active.items[2]), "SIGNAL", "a first lookup mid-drag cannot survive cancellation");
active = a;

// Exercise the actual overlay renderer and count Path2D allocations. Reuse its
// world-space paths on board edits; rebuild after a local change even at equal length.
let paths = 0;
globalThis.Path2D = class {constructor() {paths++;} arc() {} rect() {} moveTo() {} lineTo() {}};
const noop = () => {};
globalThis.document = {createElement:() => ({getContext:() => ({setTransform:noop, clearRect:noop, fillRect:noop, fill:noop, stroke:noop})})};
const ctx = {canvas:{width:80,height:60}, getTransform:() => ({a:1,b:0,c:0,d:1,e:0,f:0}),
  save:noop, restore:noop, setTransform:noop, drawImage:noop};
const paint = () => renderMask(b, {active:false}).overlay(ctx, {scale:1});
paint(); const initialPaths = paths; assert.ok(initialPaths >= 2);
expectBuilds([], () => {edit(() => {board.items[0].net = "OTHER";}); paint();});
assert.equal(paths, initialPaths, "same schematic mask reuses its paths after a board edit");
expectBuilds(["B"], () => {edit(() => {b.items[2].points[1][0] += .5;}); paint();});
assert.ok(paths > initialPaths);
highlight = "";
assert.equal(renderMask(b, {active:false}), null, "no highlight does not query the graph");
delete globalThis.Path2D; delete globalThis.document;

const oldProject = project;
project = A.clone(project); defs = mapDefs(project.library);
project.documents[1].items[4].text = "REPLACEMENT";
U.record(project); changed();
expectBuilds(["B"], () => check(project.documents[1]));
assert.equal(X.netOf(project.documents[1], defs, project.documents[1].items[2]), "REPLACEMENT");
assert.notEqual(X.schematicNets(oldProject.documents[1], defs), X.schematicNets(project.documents[1], defs));
const preview = mapDefs([{id:"gate", symbol:{pins:[{number:"preview", x:0, y:0}]}}]);
const placed = project.documents[1].items[3];
assert.equal(X.pinNet(project.documents[1], preview, placed, "preview"), "REPLACEMENT");
preview.get("gate").symbol.pins[0].x = 20;
assert.equal(X.pinNet(project.documents[1], preview, placed, "preview"), "", "a preview library is outside the editor journal");
A.connectivity = full; U.reset();
console.log("PASS schematic navigation: per-sheet graph and mask reuse, fresh solve parity, undo/redo, library pins and journal gaps");
