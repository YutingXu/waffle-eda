"use strict";
const assert = require("node:assert/strict");
for (const module of ["model", "hierarchy", "undo-store", "power", "component-families", "eco", "edit-pipeline", "sync-status"]) require(require("../support/app-source-paths.cjs").appFile(module));

const A = Atrium, U = AtriumUndoStore, S = AtriumSyncStatus, E = AtriumECO, hierarchy = AtriumHierarchy;
const symbol = (id, x) => ({id, name: id, prefix: "U", symbol: {pins: [{number: "1", name: "Pin", x, y: 0}], shapes: []},
  footprint: {name: id, pads: [{number: "1", x: 0, y: 0, w: 1, h: 1, shape: "rect"}], shapes: []}});
const project = A.project("Shared symbol", [symbol("shared", 2), symbol("other", 2)]);
const [sheet, board] = project.documents, untouched = A.sheet("schematic", "Untouched");
project.documents.push(untouched);
const defs = new Map(project.library.map(def => [def.id, def])), shared = defs.get("shared");
shared.symbol.parts = 2;
shared.symbol.pins[0].part = 1;
const placed = {...A.instantiate(project, shared, [0, 0]), id: "gate", ref: "U1"};
sheet.items.push(placed);
for (const [x, label] of [[2, "SIGNAL"], [9, "ALTERNATE"]]) {
  sheet.items.push({id: "wire-" + x, kind: "wire", points: [[x, 0], [x, 5]]}, {id: "label-" + x, kind: "netlabel", x, y: 5, text: label});
}
const unrelated = {...A.instantiate(project, defs.get("other"), [0, 0]), id: "unrelated", ref: "U2"};
untouched.items.push(unrelated);
board.items.push({...A.instantiate(project, shared, [10, 10], 0, placed), id: "board-gate", pinNets: {"1": "SIGNAL"}},
  {...A.instantiate(project, defs.get("other"), [15, 15], 0, unrelated), id: "board-unrelated"},
  {id: "route", kind: "track", layer: "Top", net: "SIGNAL", width: .2, points: [[10, 10], [10, 11]]});

let revision = 0, plans = 0;
const graphReads = [];
globalThis.AtriumHierarchy = {...hierarchy, local(d, ds) { graphReads.push(d.id); return hierarchy.local(d, ds); }};
globalThis.AtriumECO = {...E, planAsync(p, o, current) { plans++; return E.planAsync(p, o, current); }};
const options = {board: board.id, scope: "*", direction: "pcb"};
function fullPlan() {
  return E.plan(A.clone(project), options).changes.filter(c => c.selected || c.conflict);
}
function assertStatus(p, d, s) {
  const plan = E.plan(A.clone(p), {...options, board: d.id, layout: false});
  const reviews = plan.review?.pending || 0, changes = plan.changes.filter(c => c.selected || c.conflict);
  assert.deepEqual({board:s.board, name:s.boardName, count:s.count, reviews:s.reviews,
    forward:s.forward, reverse:s.reverse, conflicts:s.conflicts, ignored:s.ignored, extras:s.extras, checked:s.checked}, {
    board:d.id, name:d.name, count:changes.length + reviews, reviews,
    forward:changes.filter(c => c.use !== "reverse" && !c.conflict).length,
    reverse:changes.filter(c => c.use === "reverse").length, conflicts:changes.filter(c => c.conflict).length,
    ignored:plan.changes.filter(c => c.ignored).length,
    extras:plan.issues.filter(issue => /has no schematic component/.test(issue)).length, checked:true});
}
const history = [], future = [];
function edit(fn, commit = true) {
  const before = U.mark(project, {current: board.id});
  fn(); U.checkpoint(history, future, before); revision++;
  if (commit) U.record(project); else U.touch(project);
}
function moveHistory(n) {
  assert.ok(U.jump(history, future, U.mark(project, {current: board.id}), n)); revision++;
}
function readConnect() { return hierarchy.compile(A.clone(project)).byDoc.get(sheet.id).byPin.get("gate/1"); }

U.mark(project, {current: board.id});
// Install the status consumer without its delayed first refresh or a UI.
const timer = globalThis.setTimeout, hostListeners = new Map();
let activeProject = project, activeBoard = board, activeDefs = defs, pipeline;
globalThis.setTimeout = () => 0;
globalThis.document = {querySelector: () => null};
try {
  S.install({project: () => activeProject, doc: () => activeBoard, defs: () => activeDefs, revision: () => revision,
    stageEdit: (...args) => pipeline?.stage(...args),
    on: (event, fn) => hostListeners.set(event, fn), addRenderer() {}});
} finally { globalThis.setTimeout = timer; delete globalThis.document; }

globalThis.__testDone = (async () => {
  assert.equal(readConnect(), "SIGNAL");
  const before = await S.refresh();
  assert.equal(before.count, fullPlan().length);
  assert.equal(before.count, 0);
  graphReads.length = 0;
  const version = U.libraryVersion();
  edit(() => { shared.symbol.pins[0].x = 9; });
  assert.equal(defs.get("shared"), shared, "the definition identity and map stay intact");
  assert.ok(U.libraryVersion() > version);
  assert.equal(readConnect(), "ALTERNATE");
  const expected = fullPlan();
  assert.ok(expected.some(c => c.action === "padNet" && c.after === "ALTERNATE"));
  const after = await S.refresh();
  assert.equal(after.count, expected.length, "an in-place pin move refreshes the status like the full ECO");
  assert.deepEqual(graphReads, [sheet.id], "only the sheet using the changed symbol is refingerprinted");

  for (const [direction, net] of [[-1, "SIGNAL"], [1, "ALTERNATE"]]) {
    moveHistory(direction);
    assert.equal(readConnect(), net);
    assert.equal((await S.refresh()).count, fullPlan().length, "undo and redo keep the ECO status current");
  }

  graphReads.length = 0;
  const checked = plans;
  edit(() => { board.items.find(i => i.id === "route").points[1][1] += 1; });
  await S.refresh();
  edit(() => AtriumComponentFamilies.create(project, "Family", [{defId: "shared", part: "Chip"}]));
  await S.refresh();
  assert.deepEqual(graphReads, [], "board geometry and library organisation leave schematic graphs untouched");
  assert.equal(plans, checked, "unrelated edits leave the ECO plan reusable");

  const route = board.items.find(i => i.id === "route"), originalNet = route.net;
  const previousPlan = fullPlan();
  edit(() => { route.net = "ALTERNATE"; });
  assert.notDeepEqual(fullPlan().map(c => c.action), previousPlan.map(c => c.action), "fixture exercises ECO's copper-dependent choices");
  assertStatus(project, board, await S.refresh());
  moveHistory(-1); assertStatus(project, board, await S.refresh());
  moveHistory(1); assertStatus(project, board, await S.refresh());
  edit(() => { route.net = originalNet; });
  assertStatus(project, board, await S.refresh());

  const footprint = board.items.find(i => i.id === "board-gate"), originalId = footprint.id, originalRef = footprint.ref;
  edit(() => { footprint.id = "renamed-footprint"; footprint.ref = "U9"; });
  assertStatus(project, board, await S.refresh());
  moveHistory(-1); assertStatus(project, board, await S.refresh());
  moveHistory(1); assertStatus(project, board, await S.refresh());
  edit(() => { footprint.id = originalId; footprint.ref = originalRef; });
  assertStatus(project, board, await S.refresh());

  const beforeSettings = plans;
  edit(() => { project.parameters = {...project.parameters, DrawingTitle: "Test board"}; });
  assertStatus(project, board, await S.refresh());
  assert.equal(plans, beforeSettings + 1, "changed project settings bypass the prior status fingerprint");

  edit(() => { shared.footprint.pads[0].number = "2"; });
  assert.equal((await S.refresh()).count, fullPlan().length, "pad-only changes invalidate the ECO comparison");
  assert.ok(plans > checked);
  assert.deepEqual(graphReads, [], "a footprint-only edit does not require reading schematic items");

  edit(() => { shared.footprint.pads[0].number = "1"; shared.symbol.pins[0] = {...shared.symbol.pins[0], x: 2}; }, false);
  assert.equal(U.documentVersions(sheet, project), null, "recording is deferred");
  assert.equal((await S.refresh()).count, fullPlan().length, "unrecorded changes still get an exact comparison");
  assert.equal(U.unrecorded(), true, "the sync indicator does not force undo recording");
  U.record(project);
  assert.equal((await S.refresh()).count, fullPlan().length);

  const engine = globalThis.AtriumECO, loader = globalThis.AtriumLazy;
  let finish;
  globalThis.AtriumECO = undefined;
  globalThis.AtriumLazy = {need: () => new Promise(resolve => { finish = resolve; })};
  const loading = S.refresh(true), beforeLoad = plans;
  assert.equal(typeof finish, "function");
  edit(() => { shared.symbol.pins[0].x = 9; });
  globalThis.setTimeout = () => 0;
  try {
    finish(engine);
    await loading;
    assert.equal(plans, beforeLoad, "a refresh superseded during module loading cannot publish a plan");
  } finally {
    globalThis.setTimeout = timer;
    globalThis.AtriumLazy = loader;
    globalThis.AtriumECO = engine;
  }
  assert.equal((await S.refresh()).count, fullPlan().length);

  // Schematic positions can resolve a lost component link when a PCB remembers the original layout.
  const bp = board.items.find(i => i.id === "board-unrelated"), saved = [unrelated.link, bp.link, board.sync, unrelated.x];
  edit(() => { unrelated.link = bp.link = ""; board.sync = {...board.sync, locations:{[bp.id]:{sheet:untouched.id,x:unrelated.x,y:unrelated.y}}}; });
  await S.refresh(); const positionalPlan = plans;
  edit(() => { unrelated.x += 10; }); await S.refresh();
  assert.equal(plans, positionalPlan + 1, "a moved symbol with a lost identity is compared against its remembered position");
  edit(() => { [unrelated.link, bp.link, board.sync, unrelated.x] = saved; }); await S.refresh();

  // Exercise both scheduling queues without relying on browser or OS timer timing.
  const nativeClearTimeout = globalThis.clearTimeout, realIdle = globalThis.AtriumIdle;
  const timers = new Map(), idle = new Map(), power = AtriumPower;
  let serial = 0, loads = 0;
  function runOne(queue) {
    assert.equal(queue.size, 1);
    const [id, fn] = queue.entries().next().value;
    queue.delete(id); fn();
  }
  globalThis.setTimeout = (fn, delay) => { fn.delay = delay; timers.set(++serial, fn); return serial; };
  globalThis.clearTimeout = id => { timers.delete(id); };
  globalThis.AtriumIdle = {idle(fn) { idle.set(++serial, fn); return serial; }, cancel(id) { idle.delete(id); }};
  globalThis.AtriumECO = undefined;
  globalThis.AtriumLazy = {need: async () => { loads++; return engine; }};
  const cover = () => power.host({occluded: true}), uncover = () => power.host({occluded: false});
  try {
    power.setMode("always");
    cover(); uncover();
    assert.equal(timers.size, 0, "showing an already checked window in Efficiency does not wake the ECO");
    // A same-net edit and a document event resolving to the same board leave no work queued.
    const beforeGeometry = plans;
    for (let i = 0; i < 8; i++) {
      edit(() => { route.points[1][1] += 1; });
      hostListeners.get("change")();
      assert.equal(timers.size + idle.size, 0, "committed copper geometry does not start a check");
    }
    hostListeners.get("document")();
    cover(); edit(() => { route.points[1][1] += 1; }); hostListeners.get("change")(); uncover();
    assert.equal(timers.size + idle.size, 0, "an unchanged comparison does not restart on show");
    assert.equal(plans, beforeGeometry);
    assertStatus(project, board, S.state());
    edit(() => { shared.symbol.pins[0].x = 2; });
    hostListeners.get("change")();
    const oldTimer = timers.values().next().value;
    assert.equal(oldTimer.delay, 1800, "visible automatic checks respect the Efficiency debounce");
    cover();
    assert.equal(timers.size, 0, "occlusion cancels the debounce timer");
    oldTimer();
    assert.equal(idle.size, 0, "a stale timer cannot enqueue an ECO check");
    edit(() => { shared.symbol.pins[0].x = 2; });
    hostListeners.get("change")(); hostListeners.get("change")();
    assert.equal(timers.size, 0, "hidden edits only mark the status stale");
    uncover(); runOne(timers);
    const oldIdle = idle.values().next().value;
    cover();
    assert.equal(idle.size, 0, "occlusion cancels work already queued for idle");
    oldIdle();
    assert.equal(loads, 0, "a canceled refresh never loads the ECO engine");
    uncover(); runOne(timers); runOne(idle);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(loads, 1);
    assert.equal(S.state().count, fullPlan().length, "the visible check catches up with the latest hidden edit");
    assert.equal(timers.size + idle.size, 0, "pending edits coalesce into one check");

    // Cover a running check while it is suspended between sheets.
    edit(() => { shared.symbol.pins[0].x = 9; });
    const dateNow = Date.now, previousPlans = plans;
    let elapsed = 0;
    Date.now = () => elapsed += 12;
    try {
      const sliced = S.refresh();
      assert.equal(idle.size, 1);
      cover();
      assert.equal(idle.size, 0, "occlusion cancels an in-flight sheet slice");
      await sliced;
    } finally { Date.now = dateNow; }
    assert.equal(plans, previousPlans);
    uncover(); runOne(timers); runOne(idle);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(S.state().count, fullPlan().length);
    assert.equal(plans, previousPlans + 1);

    const frame = [], view = {timeRemaining: () => 8};
    pipeline = AtriumEditPipeline.create({...AtriumIdle, afterFrame: fn => frame.push(fn)},
      () => power.visible(), fn => frame.push(fn));
    globalThis.AtriumECO = engine;
    edit(() => { route.net = "ALTERNATE"; });
    hostListeners.get("change")();
    runOne(timers);
    assert.equal(idle.size, 0, "the shared scheduler waits until the editor's frame");
    const retired = frame.shift();
    cover();
    pipeline.suspend();
    retired();
    assert.equal(idle.size, 0, "covering the window retires the scheduled frame");
    uncover(); pipeline.resume();
    runOne(timers);
    frame.shift()();
    runOne(idle);
    await Promise.resolve();
    assertStatus(project, board, S.state());
    assert.equal(timers.size + idle.size + frame.length, 0);

    cover();
    activeProject = A.clone(project);
    activeBoard = activeProject.documents.find(d => d.id === board.id);
    activeBoard.name = "Replacement board";
    activeDefs = new Map(activeProject.library.map(d => [d.id, d]));
    revision++;
    assert.equal(U.documentVersions(activeBoard, activeProject), null);
    hostListeners.get("replace")();
    assert.equal(timers.size + idle.size + frame.length, 0, "a replacement stays deferred while covered");
    uncover();
    const previous = plans;
    const explicit = S.refresh(true);
    assert.equal(plans, previous + 1, "an explicit refresh starts immediately, without the debounce or editor frame");
    assertStatus(activeProject, activeBoard, await explicit);
    assert.equal(timers.size + idle.size + frame.length, 0, "the explicit check retires the background replacement job");
  } finally {
    globalThis.setTimeout = timer;
    globalThis.clearTimeout = nativeClearTimeout;
    globalThis.AtriumIdle = realIdle;
    globalThis.AtriumLazy = loader;
    globalThis.AtriumECO = engine;
  }
  console.log("PASS sync status follows recorded and pending library edits, history, and relevant sheet changes");
})().catch(error => { console.error(error); process.exitCode = 1; });
