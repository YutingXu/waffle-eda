"use strict";
// Silkscreen Label Generator, in the extension sandbox (see ../harness.cjs).
const harness = require("../harness.cjs");

module.exports = async function test(h, dir) {
  const {assert, X} = h;
  const id = "atrium-samples.silk-labels";
  await X.install(h.files(dir));
  assert.deepEqual(X.permissions(id).live, {"read:project": true, "propose:edits": true, "ui:command": true}, "proposals only: no direct writes");

  h.open("pcb");
  const labels = () => h.board().items.filter(i => i.kind === "label" && String(i.groupId || "").startsWith("silk-labels:"));
  // Cancelling the text prompt changes nothing (no dialog can open in this headless host).
  assert.deepEqual(await X.execute("silkLabels.generate"), {placed: 0, cancelled: true});

  // Two selected parts: one proposal, reviewed, one undo step.
  const R1 = h.ref(h.board(), "R1"), U1 = h.ref(h.board(), "U1");
  h.host.edit(() => { h.ref(h.board(), "R1").parameters = {MPN: "RC0603-10K"}; });
  h.select([R1.id, U1.id]);
  h.prompts.length = 0;
  const steps = h.history.length;
  const r = await X.execute("silkLabels.generate", {template: "{ref} {param:MPN}"});
  assert.deepEqual(h.prompts, ["review:" + id], "the user reviews the proposal");
  assert.equal(r.placed, 2); assert.equal(h.history.length, steps + 1, "one undo step");
  assert.deepEqual(labels().map(l => l.text).sort(), ["R1 RC0603-10K", "U1"], "fields fill from the part; an empty parameter drops out");
  const r1 = labels().find(l => l.groupId === "silk-labels:" + R1.id);
  assert.equal(r1.layer, "Silk"); assert.equal(r1.x, R1.x); assert.ok(r1.y > R1.y, "placed below the part");
  h.A.validate(h.project);

  // Running again replaces the generated labels instead of stacking copies.
  await X.execute("silkLabels.generate", {template: "{value}"});
  assert.deepEqual(labels().map(l => l.text).sort(), ["10 kΩ", "Buffer"]);

  // The user can keep part of a proposal, or discard it.
  h.answers.review = false;
  const declined = await X.execute("silkLabels.generate", {template: "{ref}"});
  assert.equal(declined.declined, true); assert.deepEqual(labels().map(l => l.text).sort(), ["10 kΩ", "Buffer"], "a discarded review changes nothing");
  h.answers.review = rq => rq.rows.map(x => x.index);

  // With nothing selected it labels every component; undo reverts the whole run.
  h.select([]);
  assert.equal((await X.execute("silkLabels.generate", {template: "{ref}"})).placed, 7, "no selection: every component");
  h.undo();
  assert.deepEqual(labels().map(l => l.text).sort(), ["10 kΩ", "Buffer"], "undo removes the whole run");
  assert.equal((await X.execute("silkLabels.remove")).removed, 2);
  assert.equal(labels().length, 0);
  assert.equal(h.board().items.filter(i => i.kind === "label").length, 5, "the board's own silkscreen text is untouched");
  h.reset();
};

if (require.main === module) harness.run(module.exports, __dirname);
