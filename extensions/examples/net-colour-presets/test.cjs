"use strict";
// Net Colour Presets, in the extension sandbox (see ../harness.cjs).
const harness = require("../harness.cjs");

module.exports = async function test(h, dir) {
  const {assert, X} = h;
  const id = "atrium-samples.net-colour-presets";
  await X.install(h.files(dir));
  assert.ok(!X.permissions(id).declared.includes("write:edits"), "colours are proposed, never written directly");
  assert.ok(X.commands().some(c => c.id === "netColours.show"), "View › Net Colour Presets…");

  h.open("pcb");
  await X.execute("netColours.show");
  const table = h.panel(id, "netColours").find(v => v.type === "table");
  const power = table.rows.find(r => r.preset === "power");
  assert.equal(power.nets, 3, "GND, VDD and VIN match the power preset: " + JSON.stringify(power));
  assert.equal(table.rowCommand, "netColours.apply");

  // Apply from a panel row: one reviewed proposal, one undo step.
  h.prompts.length = 0;
  const steps = h.history.length;
  assert.deepEqual(await X.execute("netColours.apply", power), {changed: 3});
  assert.deepEqual(h.prompts, ["review:" + id]);
  assert.equal(h.history.length, steps + 1);
  assert.deepEqual(h.board().netColors, {GND: "#3f7fbf", VDD: "#c84f4f", VIN: "#c84f4f"});
  await X.execute("netColours.apply", "power");
  assert.match(h.messages.at(-1), /nothing to change/);

  // Another preset replaces this extension's colours; a colour set elsewhere (VOUT) is kept.
  h.host.edit(() => { h.board().netColors.VOUT = "#123456"; });
  assert.deepEqual(await X.execute("netColours.apply", {rules: "BUF=#00aa55; FILT*=#aa5500"}), {changed: 5});
  assert.deepEqual(h.board().netColors, {VOUT: "#123456", BUF: "#00aa55", FILTER: "#aa5500"});
  await assert.rejects(X.execute("netColours.apply", {rules: "GND=red"}), /Pattern=#rrggbb/);

  // A colour changed elsewhere since the preset set it: the guard refuses the whole change.
  h.host.edit(() => { h.board().netColors.BUF = "#000000"; });
  assert.deepEqual(await X.execute("netColours.clear"), {changed: 0, stale: true}, "nothing is overwritten");
  assert.equal(h.board().netColors.BUF, "#000000");
  assert.match(X.logs(id).at(-1).text, /recoloured elsewhere/);
  h.host.edit(() => { h.board().netColors.BUF = "#00aa55"; });
  assert.deepEqual(await X.execute("netColours.clear"), {changed: 2});
  assert.deepEqual(h.board().netColors, {VOUT: "#123456"}, "clearing removes only the preset's colours");
  h.undo();
  assert.equal(h.board().netColors.FILTER, "#aa5500", "undo restores them");

  // The command is offered on boards only ("when": "pcb").
  h.open("schematic");
  assert.equal(await X.execute("netColours.show"), undefined);
  h.reset();
};

if (require.main === module) harness.run(module.exports, __dirname);
