"use strict";
// BOM Template Export, in the extension sandbox (see ../harness.cjs).
const harness = require("../harness.cjs");

module.exports = async function test(h, dir) {
  const {assert, X} = h;
  const id = "atrium-samples.bom-template";
  await X.install(h.files(dir));
  assert.deepEqual(X.permissions(id).declared, ["read:project", "outputs:write", "ui:command"], "least privilege: no edit or network permission");
  assert.ok(X.commands().some(c => c.id === "bomTemplate.markdown"), "the command exists before activation");

  // Markdown from the board, one line per value + footprint.
  h.open("pcb");
  const before = JSON.stringify(h.project);
  const r = await X.execute("bomTemplate.markdown");
  assert.equal(JSON.stringify(h.project), before, "exporting never edits the design");
  const [name, text] = h.exported.at(-1);
  assert.equal(name, r.name); assert.match(name, /BOM\.md$/);
  assert.equal(r.parts, 7);
  assert.match(text, /^# .*Bill of Materials \(board\)/);
  assert.match(text, /\| Qty \| Designators \| Value \| Footprint \| Description \|/);
  assert.match(text, /\| 1 \| R1 \| 10 kΩ \| R_0603 \|/, "fields fill from the part and its footprint");

  // A custom template with a parameter and literal text, grouped by footprint only.
  const board = h.board();
  h.host.edit(() => { h.ref(board, "R1").parameters = {MPN: "RC0603-10K", Tolerance: "1%"}; h.ref(board, "R2").parameters = {Tolerance: "5%"}; });
  const custom = await X.execute("bomTemplate.csv", {template: "Refs={refs}, Part={value} ({param:tolerance}), MPN={param:MPN}, Count={qty}", groupBy: "footprint", save: false});
  const rows = custom.text.trim().split("\r\n");
  assert.equal(rows[0], "Refs,Part,MPN,Count");
  assert.ok(rows.includes('"R1, R2",10 kΩ (1%),RC0603-10K,2'), "parts sharing a footprint share a line: " + rows.join(" / "));
  assert.equal(h.exported.at(-1)[0], name, "save:false skips the save dialog");

  // CSV keeps spreadsheets from running formulas found in design text.
  h.host.edit(() => { h.ref(board, "C1").value = "=HYPERLINK(\"x\")"; });
  const guarded = await X.execute("bomTemplate.csv", {template: "{value}", groupBy: "value", save: false});
  assert.ok(guarded.text.includes("\"'=HYPERLINK(\"\"x\"\")\""), "formula text is neutralised: " + guarded.text);

  // The schematic source spans every sheet.
  h.open("schematic");
  const sch = await X.execute("bomTemplate.markdown", {source: "auto", save: false});
  assert.match(sch.text, /\(schematic\)/);
  assert.equal(sch.parts, 7);
  await assert.rejects(X.execute("bomTemplate.markdown", {template: "{nope}", save: false}), /Unknown BOM field/);
  h.reset();
};

if (require.main === module) harness.run(module.exports, __dirname);
