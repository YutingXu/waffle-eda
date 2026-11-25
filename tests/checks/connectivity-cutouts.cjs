"use strict";
const assert = require("node:assert/strict");
for (const name of ["model", "parts", "board-shape", "net-ties", "undo-store", "engine-core",
  "connectivity", "connectivity-live", "pcb-appearance", "canvas", "edit-pipeline"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

const A = Atrium, B = AtriumBoardShape, C = AtriumConnectivity, L = AtriumConnectivityLive;
const U = AtriumUndoStore, defs = new Map();
const fields = r => [r.nets, r.shorts, r.airwires, r.excluded, r.unassigned, r.stats.objects, r.stats.features, r.sourceNotes];
const oracle = d => C.inspectFull(A.clone(d), defs);
const via = (id, x, y, net = "") => ({id, kind: "via", x, y, net, diameter: .8, drill: .3, layer: "Multi"});
const cutouts = (doc, x) => B.apply(doc, {...B.rect({x: 0, y: 20, width: 400, height: 20}), cutouts: [
  B.rect({x, y: 6, width: 2, height: 2}).contour, B.circle(3, [18, 12]).contour
]});
function board() {
  const d = A.sheet("pcb", "Cutout board");
  cutouts(d, 4);
  const moving = via("moving", 5, 5, "N");
  d.items = [moving, via("left", 1, 5, "N"), via("right", 9, 5, "N"), via("arc", 18, 12, "N"),
    {id: "track", kind: "track", net: "N", layer: "Top", width: .2, points: [[1, 5], [9, 5]]}];
  // Require multiple extraction and contact-building slices.
  for (let i = 0; i < 192; i++) d.items.push(via("extra" + i, 25 + i * 1.8, 10));
  return {d, moving};
}
function drain(work) {
  let slices = 0, next = work.next();
  while (!next.done) { slices++; next = work.next(); }
  return {slices, result: next.value};
}

{
  const {d, moving} = board(), project = {documents: [d], library: []}, history = [], future = [];
  U.reset(project);
  const initialCursor = U.recordedChanges(d, null).seq;
  let previous, beforeBytes;
  function check(label) {
    const {slices, result} = drain(L.stages(d, defs, U));
    assert.deepEqual(fields(result), fields(oracle(d)), label);
    if (previous) assert.equal(JSON.stringify(fields(previous)), beforeBytes, "published result is unchanged");
    previous = result;
    beforeBytes = JSON.stringify(fields(result));
    return {slices, result};
  }
  const initial = check("cold cutouts");
  assert.ok(initial.slices > 4, "cutout construction yields before the full pass could finish");
  assert.equal(initial.result.excluded, 2, "both cutout interiors remove vias");
  assert.equal(initial.result.nets[0].islands, 2, "the track is split by the rectangular cutout");
  const before = U.mark(project);
  moving.x = 2;
  U.checkpoint(history, future, before, "Move a via outside the hole");
  U.record(project, {doc: d, items: [moving]});
  assert.deepEqual([...U.recordedChanges(d, initialCursor).ids], [moving.id]);
  const after = check("known via edit");
  assert.equal(after.result.excluded, 1);
  assert.ok(after.slices < initial.slices, "a recorded item edit reuses unchanged copper");
  for (const direction of [-1, 1]) {
    assert.ok(U.jump(history, future, U.mark(project), direction));
    U.record(project);
    check(direction < 0 ? "undo the hole crossing" : "redo the hole crossing");
  }
  moving.x = 8;
  d.items.reverse();
  U.touch(project);
  check("unrecorded position and order");
  assert.ok(U.unrecorded(), "a projection does not record an unknown edit");
  cutouts(d, 14);
  U.record(project);
  const shifted = check("move the cutout");
  assert.equal(shifted.result.nets[0].islands, 1, "moving the cutout reconnects the track");
  U.reset();
}

// Abandon and supersede a cold inspection at every possible yield, including
// during contact mutations, and check which result can be returned afterward.
{
  const sample = board().d;
  const {slices} = drain(L.stages(sample, defs));
  for (let stop = 1; stop <= slices; stop++) {
    const {d, moving} = board();
    const old = L.stages(d, defs);
    for (let slice = 0; slice < stop; slice++) assert.equal(old.next().done, false);
    moving.x = 2;
    if (stop % 2) old.return();
    const latest = L.stages(d, defs);
    assert.equal(latest.next().done, false);
    if (!(stop % 2)) assert.deepEqual(old.next(), {done: true, value: undefined}, "superseded work returns no fallback result");
    assert.deepEqual(fields(drain(latest).result), fields(oracle(d)), "latest work is exact after an abandoned slice");
  }
}

// A temporary DRC view still uses the full sweep. It cannot start it in quick().
{
  const {d} = board();
  L.inspect(d, defs);
  const view = {...d, items: d.items.slice(0, 5)};
  const started = L.quick(view, defs, undefined, Infinity);
  assert.ok(started.work && !started.result, "a full fallback leaves the paint task");
  assert.deepEqual(fields(drain(started.work).result), fields(oracle(view)));
}

// Imported artwork can require a full copper signature even after a local move.
// Give the renderer back its task before that check.
{
  const {d} = board();
  d.pcbDrawing = {pours: [{links: [["a",0],["b",0]]}]};
  let signatures = 0;
  globalThis.AtriumPolygonPour = {contactRegions() { signatures++; return []; }};
  try {
    const started = L.quick(d, defs, undefined, Infinity);
    assert.ok(started.work && !started.result);
    assert.equal(signatures, 0, "the paint pass returns before checking the whole artwork");
    assert.deepEqual(fields(drain(started.work).result), fields(oracle(d)));
    assert.equal(signatures, 2, "both projections check the same artwork");
  } finally {
    delete globalThis.AtriumPolygonPour;
  }
}

// Drive the real canvas and shared edit scheduler without timers or a GPU.
{
  const original = globalThis.performance;
  let tick = 0;
  globalThis.performance = {now: () => ++tick};
  try {
    const {d, moving} = board(), project = {documents: [d], library: []}, tasks = [];
    d.pcbDrawing = {pours: [{links: []}]};
    let poured = "source", shownPour, pourChecks = 0;
    globalThis.AtriumPCBPours = {};
    globalThis.AtriumPolygonPour = {state: () => { pourChecks++; return poured; }};
    const pipeline = AtriumEditPipeline.create({afterFrame: fn => tasks.push(fn)}, () => true, fn => tasks.push(fn));
    globalThis.AtriumNavHost = {stageEdit: pipeline.stage};
    let painted, repaints = 0;
    globalThis.AtriumCanvasGPU = {render(I, doc, defs, opts) {
      if (opts.showUnrouted) painted = I.airwireConnectivity(doc, defs);
      if (!opts.hidden?.has("Source pours")) shownPour = I.pourState(doc, defs);
      return true;
    }};
    const makeView = () => AtriumCanvas.create({getContext: () => ({}), getBoundingClientRect: () => ({width: 300, height: 200})});
    const view = makeView();
    view.onRepaint(() => { repaints++; });
    U.mark(project);
    const paint = (showUnrouted = true) => view.render(d, defs,
      {showUnrouted, hidden: showUnrouted ? new Set() : new Set(["Source pours"])});
    function flush(){
      let turns = 0;
      while (tasks.length) {
        assert.ok(++turns < 100, "queued work drains");
        tasks.shift()();
      }
    }
    function move(x) {
      moving.x = x;
      U.record(project, {doc: d, items: [moving]});
      AtriumCanvas.edited(false);
    }
    paint();
    assert.ok(tasks.length, "cold overlay queued work through the edit pipeline");
    const otherView = makeView();
    otherView.onRepaint(() => {});
    otherView.render(d, defs, {showUnrouted: true});
    flush();
    const initial = view.internals().connectivity;
    assert.deepEqual(fields(initial.result), fields(oracle(d)));
    assert.deepEqual(fields(otherView.internals().connectivity.result), fields(initial.result), "split views both finish the same graph");
    otherView.onRepaint(null);

    cutouts(d, 12);
    U.record(project);
    AtriumCanvas.edited(false);
    paint();
    assert.ok(tasks.length, "the cutout edit queues a replacement");
    view.saveWritePending(true);
    move(1.5);
    paint();
    assert.equal(painted, initial.result, "the visible overlay keeps the preceding result during save");
    const beforeAck = repaints;
    flush();
    assert.equal(view.internals().connectivity, initial, "queued work cannot publish while the write is pending");
    assert.equal(repaints, beforeAck, "a pending write generates no repaint or timer");
    view.saveWritePending(false);
    assert.equal(repaints, beforeAck + 1, "the acknowledgement requests a single replacement paint");
    view.saveWritePending(false);
    assert.equal(repaints, beforeAck + 1, "a repeated acknowledgement creates no work");
    paint();
    flush();
    const latest = view.internals().connectivity;
    assert.notEqual(latest, initial);
    assert.deepEqual(fields(latest.result), fields(oracle(d)));

    const before = U.mark(project), history = [], future = [];
    const oldBox = view.internals().cache.boxes.get(moving), checkBefore = pourChecks;
    view.saveWritePending(true);
    move(3.5);
    U.checkpoint(history, future, before, "New move during save");
    poured = "stale";
    paint();
    assert.equal(shownPour, "source", "the existing pour stays visible during the durable write");
    assert.equal(pourChecks, checkBefore, "the paint defers the new pour signature");
    assert.equal(view.internals().cache.delta.known, true, "the edited frame uses recorded dirty geometry");
    assert.equal(view.internals().cache.boxes.get(moving)[0], oldBox[0] + 2, "the moved geometry is shown in that frame");
    d.items = d.items.slice();
    U.record(project);
    AtriumCanvas.edited(false);
    paint();
    assert.equal(pourChecks, checkBefore, "rebuilding the canvas cache reuses unchanged artwork");
    U.jump(history, future, U.mark(project), -1);
    U.record(project);
    AtriumCanvas.edited(false);
    paint();
    assert.deepEqual(view.internals().cache.boxes.get(moving), oldBox, "Undo immediately restores the displayed geometry");
    const failedSave = repaints;
    view.saveWritePending(false);
    assert.equal(repaints, failedSave + 1, "cancelling the write resumes both derived displays once");
    paint();
    flush();
    assert.equal(shownPour, "stale", "resumed paint checks the current artwork");
    assert.deepEqual(fields(view.internals().connectivity.result), fields(oracle(d)));
    view.saveWritePending(true);
    const beforeArtworkChange = pourChecks;
    d.pcbDrawing.pours = [{links: [], data: "explicitly replaced artwork"}];
    U.record(project);
    AtriumCanvas.edited(false);
    paint();
    assert.ok(pourChecks > beforeArtworkChange, "changed artwork gets its own display state");
    view.saveWritePending(false);
    paint();
    flush();
    const afterReplay = view.internals().connectivity;

    cutouts(d, 4);
    U.record(project);
    AtriumCanvas.edited(false);
    paint();
    assert.ok(tasks.length);
    move(9.25);
    flush();
    assert.equal(view.internals().connectivity, afterReplay, "an edit before the next frame prevents publication of the older request");
    paint();
    flush();
    assert.deepEqual(fields(view.internals().connectivity.result), fields(oracle(d)));

    view.saveWritePending(true);
    move(1);
    paint();
    paint(false);
    const beforeHideAck = repaints;
    view.saveWritePending(false);
    flush();
    assert.equal(repaints, beforeHideAck, "an overlay hidden during the write creates no work at acknowledgement");
    view.onRepaint(null);
  } finally {
    delete globalThis.AtriumCanvasGPU;
    delete globalThis.AtriumNavHost;
    delete globalThis.AtriumPCBPours;
    delete globalThis.AtriumPolygonPour;
    globalThis.performance = original;
    U.reset();
  }
}

console.log("PASS exact cutout airwires through geometry edits, history, cancellation and a pending durable save");
