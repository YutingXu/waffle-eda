"use strict";
// Unconnected Pins, in the extension sandbox (see ../harness.cjs).
const harness = require("../harness.cjs");

module.exports = async function test(h, dir) {
  const {assert, X} = h;
  const id = "atrium-samples.unconnected-pins";
  await X.install(h.files(dir));
  assert.deepEqual(X.permissions(id).declared, ["read:project", "ui:command", "ui:panel"], "read-only");
  const cmd = X.commands().find(c => c.id === "unconnectedPins.find");
  assert.equal(cmd.when, "selection", "the command is offered only with a selection");
  assert.equal(X._when(cmd.when, {selection: false}), false);

  // Board: a fully connected op-amp, then one pad with no net and one alone on its net.
  const board = h.open("pcb"), U1 = h.ref(board, "U1");
  h.select([]);
  assert.equal(await X.execute("unconnectedPins.find"), undefined, "with nothing selected the editor does not run it");
  assert.match(h.messages.at(-1), /not available here/);
  h.select([U1.id]);
  assert.deepEqual((await X.execute("unconnectedPins.find")).unconnected, [], "every U1 pad has a net shared with another pin");
  let view = h.panel(id, "unconnectedPins");
  assert.ok(view.some(v => v.type === "text" && /Every pin/.test(v.text)));
  const before = JSON.stringify(h.project);
  h.host.edit(() => { const u = h.ref(h.board(), "U1"); delete u.pinNets["3"]; u.pinNets["4"] = "LONELY"; });
  h.select([U1.id]);
  const found = await X.execute("unconnectedPins.find");
  assert.deepEqual(found.unconnected, ["U1.3", "U1.4"]);
  view = h.panel(id, "unconnectedPins");
  const table = view.find(v => v.type === "table");
  assert.deepEqual(table.rows.map(r => r.reason), ["No net", "Only pin on LONELY"]);
  assert.equal(table.rowCommand, "unconnectedPins.locate");
  h.select([]);
  await X.execute(table.rowCommand, table.rows[0]);
  assert.deepEqual([...h.selection], [U1.id], "clicking a row selects its part");
  assert.notEqual(JSON.stringify(h.project), before);

  // Schematic: a resistor moved off its wires has two unconnected pins.
  h.reset();
  const sheet = h.open("schematic"), R2 = h.ref(sheet, "R2");
  h.select([R2.id]);
  assert.deepEqual((await X.execute("unconnectedPins.find")).unconnected, [], "R2 is wired on the sheet");
  h.host.edit(() => { const r = h.ref(h.sheet(), "R2"); r.x += 200; r.y += 200; });
  h.select([R2.id]);
  assert.deepEqual((await X.execute("unconnectedPins.find")).unconnected, ["R2.1", "R2.2"], "pins off the wires are unconnected");
  h.reset();
};

if (require.main === module) harness.run(module.exports, __dirname);
