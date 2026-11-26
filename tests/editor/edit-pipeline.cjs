"use strict";
const assert = require("node:assert/strict");
require("../../app/editor/edit-pipeline.js");
require("../../app/history/undo-store.js");

function harness() {
  const afterFrame = [], idleCalls = new Map();
  let visible = true, id = 0, paintRequests = 0, now = 0;
  const deadline = {timeRemaining: () => 8};
  const pipeline = AtriumEditPipeline.create({
    afterFrame(callback) {paintRequests++; afterFrame.push(callback);},
    idle(callback) {idleCalls.set(++id, callback); return id;},
    cancel: handle => idleCalls.delete(handle)
  }, () => visible, callback => afterFrame.push(callback), () => now);
  return {pipeline, idleCalls, deadline,
    get paintRequests() {return paintRequests;},
    spend(ms) {now += ms;},
    takeFrame: () => afterFrame.shift(),
    frame: () => afterFrame.shift()?.(),
    idle() {const [handle, call] = idleCalls.entries().next().value; idleCalls.delete(handle); call(deadline);},
    hide() {visible = false; pipeline.suspend();},
    show() {visible = true; pipeline.resume();}
  };
}

for (const [contactTime, projectionTime, firstTurn, secondTurn] of [
  [2,1,["contacts","airwires","inline"],["contacts","airwires","inline"]],
  [5,1,["contacts"],["contacts","airwires","inline"]],
  [2,4,["contacts","airwires"],["contacts","airwires","separate"]]
]) {
  const h = harness(), p = h.pipeline, ran = [];
  p.stage("connectivity", "contacts", () => {
    ran.push("contacts"); h.spend(contactTime);
    p.stage("airwires", "projection", (current, deadline) => {
      assert.ok(current()); assert.equal(deadline.timeRemaining(), contactTime < 5 ? 4 : 6);
      ran.push("airwires"); h.spend(projectionTime);
    }, {short:true});
  });
  p.stage("pours", "tiles", (current, deadline) => {assert.ok(current()); ran.push(deadline ? "inline" : "separate");}, {short:true});
  h.frame();
  assert.deepEqual(ran, firstTurn);
  h.frame();
  assert.deepEqual(ran, secondTurn);
}

{
  const h = harness(), phases = [], p = h.pipeline;
  p.stage("idle", "search", (current, deadline) => {assert.ok(current()); assert.equal(deadline, h.deadline); phases.push("search");});
  p.stage("pours", "tiles", () => phases.push("tiles"));
  p.stage("rules", "drc", () => phases.push("drc"));
  p.stage("connectivity", "contacts", () => {
    phases.push("contacts");
    p.stage("airwires", "projection", () => phases.push("airwires"));
  });
  assert.deepEqual(phases, [], "no work before the edit paints");
  h.frame(); h.frame(); h.frame(); h.frame(); h.frame();
  assert.deepEqual(phases, ["contacts", "airwires", "tiles", "drc"]);
  h.idle();
  assert.deepEqual(phases, ["contacts", "airwires", "tiles", "drc", "search"]);
  assert.equal(h.paintRequests, 1, "the follow-up work waits for only the edit's first paint");
}

{
  const h = harness(), p = h.pipeline, ran = [];
  const start = name => {
    p.stage("pours", "tiles", () => ran.push(name + " tiles"), {short:true});
    p.stage("connectivity", "board", () => {
      ran.push(name + " contacts");
      p.stage("airwires", "board", () => {
        ran.push(name + " projection slice");
        p.stage("airwires", "board", () => ran.push(name + " lines published"), {short:true});
      }, {short:true});
    });
  };
  start("old edit"); h.frame();
  assert.deepEqual(ran, ["old edit contacts", "old edit projection slice"], "a yielding projection keeps tiles waiting");
  const supersededContinuation = h.takeFrame();
  p.supersede(); start("new edit"); supersededContinuation();
  h.frame(); h.frame();
  assert.deepEqual(ran, ["old edit contacts", "old edit projection slice", "new edit contacts", "new edit projection slice",
    "new edit lines published", "new edit tiles"], "only the new edit publishes its lines and admits tiles");
  assert.equal(h.paintRequests, 2, "each edit waits for its first paint, including after superseding a slice");
}

{
  const h = harness(), p = h.pipeline, ran = [];
  const previous = p.stage("rules", "drc", () => ran.push("first edit"));
  const oldPostPaint = h.takeFrame();
  // The second edit arrives after the first animation frame, before its post-frame task.
  p.supersede();
  p.stage("rules", "drc", () => ran.push("second edit"));
  oldPostPaint();
  assert.deepEqual(ran, [], "the prior frame cannot run the second edit's work");
  assert.equal(previous.current(), false);
  h.frame();
  assert.deepEqual(ran, ["second edit"]);
}

{
  const h = harness(), p = h.pipeline, ran = [];
  const waiting = p.stage("airwires", "projection", () => ran.push("airwires"));
  h.hide();
  const oldPostPaint = h.takeFrame();
  p.stage("pours", "tiles", () => ran.push("tiles"));
  assert.equal(h.takeFrame(), undefined, "hidden work does not wake up");
  h.show(); oldPostPaint();
  assert.deepEqual(ran, []);
  assert.ok(waiting.current(), "hiding does not advance the pending job");
  h.frame(); h.frame();
  assert.deepEqual(ran, ["airwires", "tiles"]);
}

{
  const h = harness(), p = h.pipeline, ran = [];
  let accept;
  p.stage("pours", "worker", current => {accept = () => {if (current()) ran.push("first result");};});
  h.frame();
  p.stage("rules", "drc", () => ran.push("drc"));
  const beforePourPaint = h.takeFrame();
  // Committing derived copper waits for its paint without cancelling unrelated work.
  p.suspend(); p.resume(); beforePourPaint();
  accept();
  assert.deepEqual(ran, ["first result"]);
  h.frame();
  assert.deepEqual(ran, ["first result", "drc"]);
  p.supersede(); accept();
  assert.deepEqual(ran, ["first result", "drc"], "a superseded worker result never applies");
}

{
  const h = harness(), p = h.pipeline, ran = [];
  p.stage("idle", "search", () => ran.push("search"));
  h.frame();
  const oldIdle = h.idleCalls.values().next().value;
  p.stage("connectivity", "airwires", () => ran.push("airwires"));
  oldIdle(h.deadline);
  assert.deepEqual(ran, []);
  h.frame(); h.frame(); h.idle();
  assert.deepEqual(ran, ["airwires", "search"], "new high-priority work preempts idle work");
}

{
  const h = harness(), p = h.pipeline, U = AtriumUndoStore;
  const doc = {id:"board", items:[{id:"first", x:0}, {id:"second", x:0}]};
  const project = {documents:[doc]};
  U.mark(project);
  let cursor = U.recordedChanges(doc).seq;
  const consumed = [];
  const draw = () => {
    const changes = U.recordedChanges(doc, cursor);
    consumed.push(...changes.ids);
    cursor = changes.seq;
  };
  doc.items[0].x++; U.touch(project); U.sync();
  p.stage("connectivity", "board", draw);
  doc.items[1].x++; U.touch(project); U.sync();
  p.supersede(); p.stage("connectivity", "board", draw);
  h.frame(); h.frame();
  assert.deepEqual(consumed, ["first", "second"], "the latest frame reads both changes since the old cursor");
}

{
  const h = harness(), p = h.pipeline, ran = [];
  p.stage("idle", "online", () => ran.push("old"));
  h.frame();
  const delivered = h.idleCalls.values().next().value;
  const first = p.holdIdle(), second = p.holdIdle();
  delivered(h.deadline);
  p.stage("idle", "online", () => ran.push("current"));
  p.stage("rules", "urgent", () => ran.push("urgent"));
  h.frame();
  assert.deepEqual(ran, ["urgent"]);
  first(); first();
  assert.equal(h.takeFrame(), undefined, "waiting for another pane schedules no callbacks");
  assert.equal(h.idleCalls.size, 0);
  second(); h.frame(); h.idle();
  assert.deepEqual(ran, ["urgent","current"], "released checks consume the latest work once");
}

{
  const h = harness(), p = h.pipeline, ran = [];
  const save = p.holdFrom("pours"), viewer = p.holdIdle();
  const abandoned = p.stage("pours", "old board", () => ran.push("stale pour"));
  p.stage("rules", "other board", () => ran.push("old rules"));
  assert.equal(h.takeFrame(), undefined, "held derived jobs schedule no frames or timers");
  p.supersede();
  assert.equal(abandoned.current(), false, "a newer edit supersedes a held job");
  p.stage("pours", "new board", () => ran.push("current pour"));
  p.stage("rules", "other board", () => ran.push("current rules"));
  p.stage("idle", "viewer", () => ran.push("viewer idle"));
  p.stage("airwires", "interactive", () => ran.push("interactive"));
  h.frame();
  assert.deepEqual(ran, ["interactive"]);
  assert.equal(h.takeFrame(), undefined);
  save(); save();
  h.frame(); h.frame();
  assert.deepEqual(ran, ["interactive","current pour","current rules"]);
  assert.equal(h.idleCalls.size, 0, "a second owner still holds idle work");
  viewer(); h.frame(); h.idle();
  assert.deepEqual(ran, ["interactive","current pour","current rules","viewer idle"]);
}

{
  require("../../app/checks/diagnostics.js");
  const diagnostics = globalThis.AtriumDiagnostics, capture = diagnostics.startPerformance();
  const h = harness(), p = h.pipeline, called = [];
  const cancel = p.stage("pours", "private-board", () => assert.fail("cancelled callback ran"));
  cancel.cancel();
  p.stage("rules", "private-rule", () => assert.fail("superseded callback ran"));
  p.supersede();
  p.stage("airwires", "private-net", () => assert.fail("replaced callback ran"));
  p.stage("airwires", "private-net", () => called.push("applied"));
  h.frame(); h.frame();
  assert.deepEqual(called, ["applied"]);
  const expected = new Error("fixture failure");
  p.stage("rules", "private-rule", () => { throw expected; });
  assert.throws(() => h.frame(), e => e === expected);
  capture.stop();
  const rows = diagnostics.performanceSnapshot().rows;
  assert.deepEqual(rows.map(r => [r.component, r.operation, r.counts.queued, r.counts.started,
    r.counts.completed, r.counts.cancelled, r.counts.failed]), [["editor", "request", 5, 2, 1, 3, 1]]);
  assert.ok(!JSON.stringify(rows).includes("private-"));
}
console.log("PASS edit phases, repaint tickets, hidden work, superseded results, and cumulative journal changes");
