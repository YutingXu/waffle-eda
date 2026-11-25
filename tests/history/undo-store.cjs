"use strict";
// Undo store (app/history/undo-store.js): per-object deltas with undo and redo applied in place.
// Exact round trips over every kind of change (in-place edits, inserts, deletes, reorders, key
// order, documents, project replacement), randomised edit/undo/redo sequences checked against
// whole-project snapshots, object identity kept, derived changes, multi-step jumps, branches,
// labels, entries from before the store loaded, the byte budget, and the cost on the 25.6k board.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh undo-store).
const assert = require("node:assert/strict");
let budgetMB = 64;
globalThis.AtriumPref = {get: (k, d) => k === "history.undoBudgetMB" ? budgetMB : d};
require(globalThis.UNDO_STORE_PATH || "../../app/history/undo-store.js");
const U = AtriumUndoStore;
const json = x => JSON.stringify(x);
const clock = () => globalThis.performance?.now?.() ?? Date.now();

function board(n = 2000) {
  const items = [];
  for (let i = 0; i < n; i++) items.push(i % 5 ? {id: "t" + i, kind: "track", layer: "Top", width: .2, net: "N" + (i % 40), points: [[i, 0], [i + 1, 1]]}
    : {id: "p" + i, kind: "part", def: "r", x: i, y: 2, angle: 0, ref: "R" + i, value: "10 kΩ", note: undefined});
  return {format: "atrium", version: 8, name: "Test", library: Array.from({length: 20}, (_, i) => ({id: "d" + i, name: "Def " + i, pins: [{n: 1}, {n: 2}]})),
    documents: [{id: "s1", kind: "schematic", name: "Sheet", items: [{id: "w1", kind: "wire", points: [[0, 0], [1, 0]]}], outline: [[0, 0], [1, 1]]},
      {id: "b1", kind: "pcb", name: "Board", grid: .25, items, outline: [[0, 0], [10, 0], [10, 10]],
        pcbDrawing: {annotations: {}, pours: [{polygon: "g1", net: "GND", layer: "Top", bounds: [0, 0, 5, 5], count: 1, data: "A".repeat(40000)},
          {polygon: "g2", net: "VCC", layer: "Bottom", bounds: [0, 0, 5, 5], count: 1, data: "B".repeat(400)}]}}],
    extra: {deep: {deeper: [1, 2, {x: null}]}}, layers: ["Top", "Top", "Bottom"], fn() {}, gone: undefined};
}
// A tiny editor over the store, the way editor.js uses it.
function editor(project) {
  U.reset();
  const history = [], future = [];
  const snap = () => U.mark(project, {current: "b1"});
  return {history, future, get project() { return project; }, set project(p) { project = p; U.touch(p); },
    edit(fn, label) { const before = snap(); const r = fn(project); if (r) project = r; U.checkpoint(history, future, before, label); U.touch(project); },
    derive(fn) { fn(project); U.touch(project); },
    go(n, tip) { const here = snap(), t = tip ? U.adopt(history, future, here, tip) : U.jump(history, future, here, n); if (!t) return null; project = U.root(); U.touch(project, undefined, true); return t; }};
}
const B = p => p.documents.find(d => d.id === "b1"), I = p => B(p).items;

{
  U.reset();
  const part={id:"p",kind:"part",ref:"R1",value:"1k"}, project={name:"History",
    documents:[{id:"s",kind:"schematic",name:"Sheet",items:[part]}]};
  const history=[],future=[];
  function edit(value){
    const before=U.mark(project);
    part.value=value;
    U.checkpoint(history,future,before);
    U.touch(project);
  }
  edit("5k");
  assert.ok(U.jump(history,future,U.mark(project),-1));
  assert.equal(part.value,"1k");
  edit("3k");
  edit("9k");
  assert.ok(U.jump(history,future,U.mark(project),-1));
  assert.equal(part.value,"3k");
  assert.ok(U.jump(history,future,U.mark(project),1));
  assert.equal(part.value,"9k");
  U.reset();
}
// Folder reads before the first authored action do not allocate an Undo shadow or change footprint geometry.
{
  const p = board(32), e = editor(p), original = p.documents[1].items[0], version = U.libraryVersion();
  const child = {id:"external",kind:"schematic",name:"Added sheet",items:[]};
  U.reconcile(p, () => p.documents.push(child), {structureChanged:true});
  assert.equal(U.stats().shadow, 0);
  assert.equal(U.libraryVersion(), version);
  assert.equal(U.root(), p);
  const value = original.value;
  e.edit(() => { original.value = "10k"; }, "Change part");
  const prior = U.libraryVersion(), other = {id:"second",kind:"schematic",name:"Second",items:[]};
  U.reconcile(p, () => p.documents.push(other), {structureChanged:true});
  assert.equal(U.libraryVersion(), prior);
  e.go(-1);
  assert.equal(original.value, value);
  assert.equal(p.documents.at(-1), other);
  e.go(1);
  assert.equal(original.value, "10k");
  assert.equal(p.documents.at(-2), child);
  U.reset();
  const beforeLibrary = U.libraryVersion();
  U.reconcile(p, () => p.library.push({id:"d-new",name:"Loaded definition"}), {library:true});
  assert.ok(U.libraryVersion() > beforeLibrary);
  assert.equal(U.stats().shadow, 0);
  U.reset();
}

// The first visible cursor of a verified folder covers its first authored move.
{
  const p = board(16), d = B(p), item = d.items[5], history = [], future = [], x = item.x;
  U.reset(p);
  const shown = U.recordedChanges(d, null).seq, version = U.libraryVersion();
  assert.equal(U.stats().shadow, 0, "opening a verified folder remains lazy");
  const before = U.mark(p, {current:d.id});
  item.x += 1;
  U.checkpoint(history, future, before, "Move part");
  U.record(p, {doc:d, items:[item]});
  const edited = U.recordedChanges(d, shown);
  assert.deepEqual([...edited.ids], [item.id]);
  assert.equal(edited.items.get(item.id), item);
  assert.equal(U.libraryVersion(), version);
  assert.ok(U.jump(history, future, U.mark(p), -1));
  assert.equal(item.x, x);
  assert.ok(U.jump(history, future, U.mark(p), 1));
  assert.equal(item.x, x + 1);

  U.reset(p);
  const unreported = U.recordedChanges(d, null).seq;
  item.x += 1;
  U.touch(p);
  U.sync(p);
  assert.equal(U.recordedChanges(d, unreported).ids, null, "an unknown first change invalidates the earlier raster");

  U.reset(p);
  const oldDefinition = U.recordedChanges(d, null).seq, oldVersion = U.libraryVersion();
  U.reconcile(p, () => { p.library[0].footprint = {name:"Replacement"}; }, {library:true});
  U.mark(p);
  assert.equal(U.recordedChanges(d, oldDefinition).ids, null, "disk hydration invalidates the old footprint cursor");
  assert.ok(U.libraryVersion() > oldVersion);

  U.reset(p);
  const oldOwner = U.recordedChanges(d, null).seq;
  U.mark(board(16));
  assert.equal(U.recordedChanges(d, oldOwner).ids, null, "a different project cannot reuse the verified cursor");
  U.reset();
}

// ---- every kind of change round-trips exactly ---------------------------------------------------
{
  const e = editor(board()), states = [json(e.project)];
  const steps = [
    p => { I(p)[5].x += 1; },                                            // in place
    p => { I(p)[7].points = I(p)[7].points.map(q => [q[0] + 1, q[1]]); }, // nested replaced
    p => { I(p)[8].points[0][0] = 99; },                                  // nested in place
    p => { I(p).push({id: "new1", kind: "via", x: 1, y: 1}); },          // insert at end
    p => { I(p).splice(3, 0, {id: "new2", kind: "via", x: 2, y: 2}); },  // insert in the middle
    p => { B(p).items = I(p).filter(i => !/^t1\d$/.test(i.id)); },       // delete scattered (new array)
    p => { const it = I(p); [it[0], it[1]] = [it[1], it[0]]; },          // reorder
    p => { I(p)[11].locked = true; },                                     // key added
    p => { delete I(p)[12].net; },                                        // key removed (order restored on undo)
    p => { I(p)[13] = {...I(p)[13], width: 3}; },                         // element replaced
    p => { B(p).outline = [[0, 0], [20, 0], [20, 20]]; },                 // doc leaf
    p => { B(p).pcbDrawing.pours[0] = {...B(p).pcbDrawing.pours[0], data: "C".repeat(30000)}; },
    p => { B(p).pcbDrawing = {...B(p).pcbDrawing, extraKey: 1}; },        // container replaced
    p => { delete B(p).grid; },                                           // doc key removed
    p => { B(p).rules = {clearance: .2}; },                               // doc key added (container)
    p => { p.name = "Renamed"; p.layers.push("Top"); },
    p => { p.documents.push({id: "s2", kind: "schematic", name: "Power", items: []}); },
    p => { p.documents = p.documents.filter(d => d.id !== "s1"); },
    p => { p.library[3].name = "Changed"; p.library.splice(0, 1); },
    p => { p.extra.deep.deeper[2].x = 4; },
    p => { const q = JSON.parse(JSON.stringify(p)); q.name = "Opened"; return q; }, // project replaced (Open)
    p => { I(p)[0].x = -1; },
  ];
  for (const f of steps) { e.edit(f); states.push(json(e.project)); }
  for (let k = steps.length - 1; k >= 0; k--) { e.go(-1); assert.equal(json(e.project), states[k], "undo to state " + k); }
  for (let k = 1; k <= steps.length; k++) { e.go(1); assert.equal(json(e.project), states[k], "redo to state " + k); }
  e.go(-9); assert.equal(json(e.project), states[steps.length - 9]);
  e.go(4); assert.equal(json(e.project), states[steps.length - 5]);
  e.go(-100); assert.equal(json(e.project), states[0], "a jump past the start stops at the oldest state");
  e.go(100); assert.equal(json(e.project), states[steps.length]);
}
// ---- identity: undo patches in place ---------------------------------------------------------------
{
  const e = editor(board());
  const items = I(e.project), keep = items[999], edited = items[5], doc = B(e.project);
  e.edit(p => { I(p)[5].x += 3; });
  e.go(-1);
  assert.equal(I(e.project), items, "the item list keeps its identity");
  assert.equal(I(e.project)[999], keep, "an untouched object keeps its identity");
  assert.equal(I(e.project)[5], edited, "the edited object is patched in place");
  assert.equal(B(e.project), doc);
  e.go(1); assert.equal(I(e.project)[5], edited); assert.equal(edited.x, 8);
}
// ---- randomised sequences against whole-project snapshots ---------------------------------------
{
  let seed = 11;
  const rnd = k => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  const e = editor(board(300));
  const line = [json(e.project)];   // states of the current line, index = history length
  let at = 0, nid = 0;
  const ops = [
    p => { const it = I(p); it[rnd(it.length)].x = rnd(100); },
    p => { const it = I(p); const o = it[rnd(it.length)]; o.points = [[rnd(9), rnd(9)]]; },
    p => { I(p).splice(rnd(I(p).length + 1), 0, {id: "r" + (++nid), kind: "via", x: rnd(50), y: 0}); },
    p => { const it = I(p); if (it.length > 5) it.splice(rnd(it.length), 1 + rnd(3)); },
    p => { B(p).items = I(p).filter(() => rnd(40)); },
    p => { const it = I(p), a = rnd(it.length), b = rnd(it.length); [it[a], it[b]] = [it[b], it[a]]; },
    p => { const o = I(p)[rnd(I(p).length)]; if (o.tag) delete o.tag; else o.tag = "t" + rnd(9); },
    p => { p.name = "n" + rnd(99); },
    p => { B(p).outline.push([rnd(9), rnd(9)]); },
    p => { p.documents[0].items.push({id: "w" + (++nid), kind: "wire", points: [[0, 0], [1, rnd(5)]]}); },
  ];
  for (let n = 0; n < 600; n++) {
    const c = rnd(10);
    if (c < 6) { e.edit(ops[rnd(ops.length)]); line.length = at + 1; line.push(json(e.project)); at++; }
    else if (c < 8) { const k = 1 + rnd(3); if (e.go(-k)) at = Math.max(0, at - k); }
    else if (c < 9) { const k = 1 + rnd(2); if (e.go(k)) at = Math.min(line.length - 1, at + k); }
    else { e.derive(p => { B(p).pcbDrawing.pours[1].count = rnd(9); }); line[at] = json(e.project); }
    assert.equal(json(e.project), line[at], "step " + n);
  }
}
// ---- derived changes: they belong to the step before them; redo restores the saved state -------------
{
  const e = editor(board(100));
  e.edit(p => { I(p)[1].x = 50; });
  e.derive(p => { B(p).pcbDrawing.pours[0].count = 7; });
  const s1 = json(e.project);
  e.edit(p => { I(p)[2].x = 60; });
  const s2 = json(e.project);
  e.go(-1); assert.equal(json(e.project), s1, "undo keeps the derived change made before the edit");
  e.derive(p => { B(p).pcbDrawing.pours[0].count = 9; });
  e.go(1); assert.equal(json(e.project), s2, "redo restores the saved state");
}
// ---- failed edits and cancelled drags roll back without a step ------------------------------------------
{
  const e = editor(board(100));
  const s0 = json(e.project), before = U.mark(e.project, {});
  I(e.project)[3].width = 9; I(e.project).push({id: "x"}); U.touch(e.project);
  U.sync();
  const p = U.rollback(before);
  assert.equal(p, e.project); assert.equal(json(p), s0);
  assert.equal(e.history.length, 0);
}
// ---- branches ----------------------------------------------------------------------------------------
{
  const e = editor(board(200));
  e.edit(p => { p.name = "A"; }, "Rename A");
  e.edit(p => { p.name = "B"; });
  e.edit(p => { p.name = "C"; });
  e.go(-2);
  assert.equal(e.project.name, "A");
  e.edit(p => { p.name = "Z"; });
  assert.equal(e.future.length, 0, "an edit clears redo");
  const [br] = U.branches();
  assert.ok(br, "the replaced redo states are kept as a branch");
  assert.deepEqual(br.trees.map(t => U.project(t).name), ["B", "C"], "branch states, oldest first");
  assert.equal(U.project(br.fork).name, "A", "the fork point");
  assert.equal(e.project.name, "Z", "reading a branch leaves the live project as it was");
  e.go(0, br.trees.at(-1));
  assert.equal(e.project.name, "C", "switching restores the branch tip");
  assert.equal(U.current().label, "Switch to branch", "as one labelled step");
  e.go(-1); assert.equal(e.project.name, "Z", "undo returns to the other line");
  for (let k = 0; k < 12; k++) { e.go(-1); e.edit(p => { p.name = "x" + k; }); }
  assert.ok(U.branches().length <= U.limits.MAX_BRANCHES, "branches are bounded");
}
// ---- labels: explicit, the action that ran, and changes() --------------------------------------------
{
  const e = editor(board(50));
  U.action("annotate");
  e.edit(p => { p.name = "N"; });
  assert.equal(U.current().action, "annotate");
  e.edit(p => { p.name = "M"; }, "Rename project");
  assert.equal(U.current().label, "Rename project");
  e.go(-1); assert.equal(U.current().action, "annotate", "undo restores the step's label");
  e.go(1);
  e.edit(p => { I(p)[0].x += 1; I(p).push({id: "v9", kind: "via"}); B(p).items = I(p).filter(i => i.id !== "t2"); });
  const ch = U.changes(e.history.at(-1), U.live(1)).find(c => c.path === "items");
  assert.equal(ch.doc.id, "b1");
  assert.deepEqual([ch.added.map(i => i.id), ch.removed.map(i => i.id), ch.modified.map(m => m[1].id)], [["v9"], ["t2"], ["p0"]]);
  assert.equal(ch.modified[0][0].x + 1, ch.modified[0][1].x);
  e.go(-1);
  const back = U.changes(null, e.future.at(-1)).find(c => c.path === "items");
  assert.deepEqual(back.added.map(i => i.id), ["v9"], "a redo state names the same change");
}
// ---- entries made before the store loaded (whole-project JSON) -----------------------------------------
{
  U.reset();
  let project = board(300);
  const history = [], future = [], legacy = () => ({project: JSON.stringify(project), current: "b1", selected: null, ids: []});
  const states = [JSON.stringify(project)];
  for (let k = 0; k < 3; k++) { history.push(legacy()); I(project)[k].width = 1 + k; states.push(JSON.stringify(project)); }
  const before = legacy(); project.name = "after load"; states.push(JSON.stringify(project));
  U.checkpoint(history, future, before); U.touch(project); U.sync();
  assert.ok(history.every(t => t.pos != null), "legacy entries lifted");
  let here = U.mark(project, {}); U.jump(history, future, here, -4); project = U.root();
  assert.equal(JSON.stringify(project), states[0]);
  here = U.mark(project, {}); U.jump(history, future, here, 4); project = U.root();
  assert.equal(JSON.stringify(project), states[4]);
}
// ---- byte budget ---------------------------------------------------------------------------------
{
  budgetMB = 4;
  const e = editor(board(8000));
  for (let k = 0; k < 40; k++) e.edit(p => { for (const i of I(p)) if (i.kind === "track") i.width += .001; });
  const st = U.stats();
  assert.ok(st.bytes <= st.budget, "trimmed to the budget: " + st.bytes + " of " + st.budget);
  assert.ok(e.history.length >= 1 && e.history.length < 40, "oldest steps dropped: " + e.history.length);
  budgetMB = 64;
}
// ---- the 25.6k-object board: cost proportional to the edit ------------------------------------------
{
  const items = [];
  let id = 0;
  for (let row = 0; row < 160; row++) for (let col = 0; col < 160; col++) {
    const x = 2.3 * col, y = 1.72 * row, base = {id: "o" + (++id)};
    if ((row + col) % 12 === 0) items.push({...base, kind: "part", def: "std-r", x, y, angle: 0, ref: "R" + id, value: "10 kΩ"});
    else if ((row + col) % 12 < 3) items.push({...base, kind: "via", x, y, diameter: .6, drill: .3, layer: "Multi"});
    else items.push({...base, kind: "track", layer: "Top", width: .22, points: [[x, y], [x + .5, y - .5], [x + 2.15, y - .5]]});
  }
  const e = editor({format: "atrium", version: 8, name: "Dense", library: [], documents: [{id: "b1", kind: "pcb", name: "Dense", items}]});
  e.edit(() => {}); U.sync();
  const b0 = U.stats().bytes, full = json(e.project).length, rec = [], syncs = [], undos = [], redos = [];
  for (let k = 0; k < 20; k++) {
    let t = clock();
    const before = U.mark(e.project, {});
    const it = e.project.documents[0].items; it[k * 997].x += 1; it[k * 997 + 50].x += 1;
    U.checkpoint(e.history, e.future, before); U.touch(e.project);
    rec.push(clock() - t);
    t = clock(); U.sync(); syncs.push(clock() - t);
  }
  for (let k = 0; k < 10; k++) { const t = clock(); e.go(-1); undos.push(clock() - t); U.sync(); }
  for (let k = 0; k < 10; k++) { const t = clock(); e.go(1); redos.push(clock() - t); U.sync(); }
  const per = (U.stats().bytes - b0) / 20, med = a => a.sort((x, y) => x - y)[a.length >> 1];
  assert.ok(per < 4096, "a two-object step costs a few hundred bytes: " + Math.round(per));
  assert.ok(med(rec) < 1, "recording a step < 1 ms: " + med(rec).toFixed(3));
  assert.ok(med(undos) < 5 && med(redos) < 5, "undo / redo of a step < 5 ms: " + med(undos).toFixed(2) + " / " + med(redos).toFixed(2));
  console.log("25.6k board: " + (full / 1048576).toFixed(2) + " M chars; per step " + Math.round(per) + " B, record " + med(rec).toFixed(3) +
    " ms, idle sync " + med(syncs).toFixed(1) + " ms, undo " + med(undos).toFixed(2) + " ms, redo " + med(redos).toFixed(2) + " ms");
  // A History-panel jump over 200 steps each way: one replay, not one object index per step.
  for (let k = 0; k < 200; k++) { const before = U.mark(e.project, {}); const it = e.project.documents[0].items; for (let j = 0; j < 20; j++) it[(k * 131 + j * 977) % it.length].x += .1; U.checkpoint(e.history, e.future, before); U.touch(e.project); U.sync(); }
  const tip = json(e.project), steps = e.history.length - 1;
  let t = clock(); e.go(-steps); const back = clock() - t; U.sync();
  t = clock(); e.go(steps); const fwd = clock() - t; U.sync();
  assert.equal(json(e.project), tip, "back and forward over " + steps + " steps lands on the same design");
  assert.ok(back < 300 && fwd < 300, "a " + steps + "-step jump each way: " + back.toFixed(1) + " / " + fwd.toFixed(1) + " ms");
  console.log("jump over " + steps + " steps: back " + back.toFixed(1) + " ms, forward " + fwd.toFixed(1) + " ms");
}
// ---- rollback reverts in-place changes nobody touched (editor endDrag cancel, a failed edit) --------
// Mirroring a part while dragging, then Esc, used to leave it moved and mirrored: rollback() trusted the
// shadow, which had not seen the untouched change. And a live repour's commit recorded mid-drag (the
// part at its dragged place) made the next undo return to that mid-drag place after the cancel.
{
  const e = editor(board(50));
  const S0 = json(e.project), mark = U.mark(e.project, {current: "b1"});
  I(e.project)[5].x += 3; I(e.project)[5].mirror = true;          // in place, no touch
  assert.equal(U.rollback(mark), e.project, "rolled back in place");
  assert.equal(json(e.project), S0, "an untouched change since the mark is rolled back");
  const drag = U.mark(e.project, {current: "b1"}), x0 = I(e.project)[5].x;
  I(e.project)[5].x = x0 + 7;                                       // the drag moves the part
  e.derive(p => { B(p).pcbDrawing.pours[1] = {...B(p).pcbDrawing.pours[1], data: "D".repeat(500)}; });
  U.sync();                                                         // an idle pass records the mid-drag state
  I(e.project)[5].x = x0;                                           // Esc restores the part (no touch)
  U.rollback(drag);
  assert.equal(json(e.project), S0, "the cancelled drag leaves nothing, the mid-drag pour included");
  e.edit(p => { I(p)[9].x += 1; }); e.go(-1);
  assert.equal(json(e.project), S0, "the next undo returns to the state before the drag, not to a mid-drag one");
}
// A drag dropped back where it started records nothing: changes(mark, live) is empty, even when an
// idle pass recorded the mid-drag position (editor.js endDrag then adds no undo step).
{
  const e = editor(board(50));
  const drag = U.mark(e.project, {current: "b1"}), x0 = I(e.project)[5].x;
  I(e.project)[5].x = x0 + 4; U.touch(e.project); U.sync();          // moved away, recorded
  I(e.project)[5].x = x0; U.touch(e.project);                         // and back
  assert.equal(U.changes(drag, {live: true}).length, 0, "a round-trip drag is no change");
  I(e.project)[5].x = x0 + 1; U.touch(e.project);
  assert.equal(U.changes(drag, {live: true}).length, 1, "a real move is a change");
  // unchanged() sees in-place edits nobody reported (a drag mutates without touch()).
  const m2 = U.mark(e.project, {current: "b1"});
  I(e.project)[10].x += 2;                                         // a part (index 10)
  assert.equal(U.unchanged(m2, e.project), false, "an unreported move is seen");
  I(e.project)[10].x -= 2;
  assert.equal(U.unchanged(m2, e.project), true, "moved back: unchanged");
}
// Paint-time readers can distinguish an unrecorded edit from an empty committed journal range.
{
  const e = editor(board(50)), d = B(e.project), item = d.items[5];
  const drag = U.mark(e.project, {current: d.id}), start = U.recordedChanges(d).seq;
  item.x += 1;
  assert.equal(U.unchanged(drag, e.project), false);
  U.checkpoint(e.history, e.future, drag, "Move part");
  const move = U.recordedChanges(d, start);
  assert.deepEqual([...move.ids], [item.id]);
  assert.equal(move.items.get(item.id), item);
  e.go(-1);
  const undo = U.recordedChanges(d, move.seq);
  assert.deepEqual([...undo.ids], [item.id]);
  assert.equal(undo.items.get(item.id).x, 5);
  e.go(1);
  const redo = U.recordedChanges(d, undo.seq);
  assert.deepEqual([...redo.ids], [item.id]);
  assert.equal(redo.items.get(item.id).x, 6);

  const outer = U.outer(), libraryVersion = U.libraryVersion();
  e.edit(p => { p.library[0].footprint = {name: "Replacement footprint"}; });
  assert.deepEqual(U.recordedChanges(d, redo.seq), {seq: null, ids: null, items: null});
  assert.equal(U.unrecorded(), true, "reading the committed journal does not synchronize it");
  const library = U.changed(d, redo.seq);
  assert.equal(library.ids.size, 0);
  assert.ok(U.outer() > outer, "a library edit invalidates dependencies outside the items");
  assert.ok(U.libraryVersion() > libraryVersion, "in-place definition edits invalidate geometry caches");
  const afterLibrary = U.libraryVersion();

  item.x += .5; U.record(e.project);
  const visibleCommit = U.recordedChanges(d, library.seq);
  assert.deepEqual([...visibleCommit.ids], [item.id]);
  assert.equal(U.unrecorded(), false, "a visible commit can paint from the journal immediately");

  e.derive(() => { d.pcbDrawing.pours[0] = {...d.pcbDrawing.pours[0], data: "changed pour"}; });
  assert.deepEqual(U.recordedChanges(d, visibleCommit.seq), {seq: null, ids: null, items: null});
  assert.equal(U.changed(d, visibleCommit.seq).ids.size, 0, "the pour cache is separate from the item journal");
  assert.equal(U.libraryVersion(), afterLibrary, "copper updates do not invalidate library geometry");
  e.edit(p => { p.documents = p.documents.filter(doc => doc === d); });
  U.sync();
  assert.equal(U.recordedChanges(d, library.seq).ids, null, "document replacement invalidates the prior cursor");
}
// Feedback for a one-part replay reads only direct references already in its journal.
{
  const p = board(25600), d = B(p), items = d.items, item = items[0], history = [], future = [];
  U.reset();
  const before = U.mark(p,{current:d.id}), x = item.x;
  U.checkpoint(history,future,before,"Move part");
  item.x += 1;
  U.record(p,{doc:d,items:[item]});
  function feedback(n, expected) {
    U.jump(history,future,U.mark(p,{current:d.id}),n);
    assert.equal(item.x,expected);
    const parse = JSON.parse, stringify = JSON.stringify;
    Object.defineProperty(d,"items",{get(){assert.fail("feedback walked the board");},configurable:true});
    JSON.parse = JSON.stringify = () => assert.fail("feedback serialized an item");
    let change;
    try { change = U.motion(d,400); }
    finally {
      JSON.parse = parse; JSON.stringify = stringify;
      Object.defineProperty(d,"items",{value:items,writable:true,configurable:true,enumerable:true});
    }
    assert.equal(change.changed.length,1);
    assert.equal(change.changed[0],item);
    assert.deepEqual(change.removed,[]);
    assert.equal(U.motion(d,400),null);
  }
  feedback(-1,x);
  feedback(1,x+1);
  U.reset();
}
// Undoing a deletion highlights the restored reference. Redo retains the removed reference.
{
  const e = editor(board(8)), d = B(e.project), item = d.items[5];
  e.edit(() => {d.items.splice(5,1);});
  e.go(-1);
  assert.deepEqual(U.motion(d,400),{changed:[item],removed:[]});
  e.go(1);
  assert.deepEqual(U.motion(d,400),{changed:[],removed:[item]});
  e.edit(() => board(8));
  e.go(-1);
  assert.equal(U.motion(d,400),null,"project replacement leaves no safe highlight range");
  U.reset();
}
// A grid edit records an exact cell delta. General item edits keep the full
// fallback, including a second scope touching that same table by ID.
{
  require("../../app/project/source-file.js");require("../../app/notebook/table-data.js");
  const T=AtriumTableData,history=[],future=[];
  let serial=0,state=T.create(70,2,()=>"axis-"+(++serial));
  state=T.batch(state,state.rows.flatMap(row=>state.columns.map(column=>({
    rowId:row.id,columnId:column.id,content:{kind:"literal",text:'}, { ["a,b"] \\ '+row.id}
  }))));
  const doc={id:"sheet",kind:"schematic",name:"Table",items:[]},project={id:"project",library:[],documents:[doc]};
  const item={id:"table",kind:"textframe",text:"Original",opaque:{cells:null},widget:{type:"table",state}};
  doc.items.push(item);
  U.reset();U.mark(project);U.prime();
  function edit(mutate,{compound=false,explicit=true,mixed=false}={}){
    const before=U.mark(project),prior=item.widget.state,stats=U.stats();
    item.widget={...item.widget,state:mutate(prior)};
    if(compound)item.text="Scoped frame and cell";
    if(mixed)item.widget.state.columns[0].title="A changed in place";
    const scope=T.cellUndoScope(doc,item,prior,item.widget.state);
    U.checkpoint(history,future,before,"Edit table");
    U.record(project,mixed?[scope,{doc,items:[item.id]}]:explicit?scope:{doc,items:[item]});
    assert.equal(U.stats().tableCells-stats.tableCells,explicit&&!compound&&!mixed?1:0);
    assert.equal(U.stats().tableSnapshots,stats.tableSnapshots);
    return {before,json:JSON.stringify(project),hash:U.hash()};
  }
  const change=(r,c,text)=>s=>T.change(s,state.rows[r].id,state.columns[c].id,{content:text===null?null:{kind:"literal",text}});
  const start=JSON.stringify(project), initialHash=U.hash();
  const first=edit(change(32,0,'new, }, \\ "quoted"'));
  const second=edit(change(32,1,null));
  const third=edit(change(32,1,"Restored to the end as a new cell"));
  const full=edit(change(0,0,"Compound"),{compound:true});
  const mixed=edit(change(0,1,"Second hint"),{mixed:true});
  const pre=U.stats().tableSnapshots;
  const summary=U.changeSummary(first.before,second.before);
  assert.deepEqual(summary.rows[0].modified[0][1].widget.state,{tableVersion:1,cellsChanged:true});
  assert.equal(U.stats().tableSnapshots,pre);
  const actual=()=>JSON.stringify(project);
  function go(dir,text,hash){
    assert.ok(U.jump(history,future,U.mark(project),dir));
    assert.equal(actual(),text);
    assert.equal(U.hash(),hash);
    assert.equal(doc.items[0],item);
  }
  go(-1,full.json,full.hash);go(-1,third.json,third.hash);
  const beforeReplay=U.stats().tableSnapshots;
  go(-1,second.json,second.hash);go(-1,first.json,first.hash);go(-1,start,initialHash);
  go(1,first.json,first.hash);go(1,second.json,second.hash);go(1,third.json,third.hash);
  assert.equal(U.stats().tableSnapshots,beforeReplay);
  go(1,full.json,full.hash);go(1,mixed.json,mixed.hash);
  go(-3,second.json,second.hash);
  const alternate=edit(change(69,0,"Alternate branch"));
  const branch=U.branches().at(-1),tip=branch.trees.at(-1);
  assert.equal(JSON.stringify(U.project(tip)),mixed.json);
  assert.equal(actual(),alternate.json);
  U.adopt(history,future,U.mark(project),tip);
  assert.equal(actual(),mixed.json);
  go(-1,alternate.json,alternate.hash);
  const [old,newer]=summary.details()[0].modified[0];
  assert.equal(JSON.stringify(old),JSON.stringify(JSON.parse(start).documents[0].items[0]));
  assert.equal(JSON.stringify(newer),JSON.stringify(JSON.parse(first.json).documents[0].items[0]));
  for(let i=0;i<520;i++)edit(change(1,1,String(i)));
  assert.ok(history.length<=U.limits.MAX_STEPS);
  assert.ok(U.stats().bytes<4*1048576,"retained history accounts for only the scoped cell chunks");
  assert.equal(U.stats().mismatch,0);
  U.reset();
}
console.log("PASS undo store: round trips, identity, random sequences, derived changes, branches, labels, legacy, budget and compact tables");
