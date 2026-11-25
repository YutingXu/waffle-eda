"use strict";
// Messages › Problems and the problem navigation of both editors:
//   - a check group (Compiler, DRC, DFM) opens Problems filtered to its domain; Log keeps one-shot outputs;
//   - Problems rows come from the check store: severities, domain and Fab sign-off chips, waived rows,
//     and stale waivers as "Waiver to review";
//   - F8 / Shift+F8 step through a sheet's ERC problems (the Violation inspector on sheets), and Compile
//     publishes at the configured severity.
// Run: scripts/test-jsc.sh problems   (or node tests/checks/problems.cjs)
const assert = require("node:assert/strict");
for (const m of ["model", "nav-common", "parts", "sch-objects", "hierarchy", "net-ties", "messages", "erc", "undo-store", "problem-marks", "checks", "sch-markers", "waivers", "drc-inspector"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const K = AtriumChecks, M = AtriumMessages, E = AtriumERC, W = AtriumWaivers, I = AtriumDRCInspector;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const res = {id: "res", name: "R", prefix: "R", symbol: {shapes: [], pins: [{number: "1", name: "1", x: 0, y: 0, electrical: 4}, {number: "2", name: "2", x: 10, y: 0, electrical: 4}]}};
const sheet = {kind: "schematic", id: "s", name: "Sheet", items: [{kind: "part", id: "r1", def: "res", ref: "R1", x: 0, y: 0, angle: 0}, {kind: "part", id: "r2", def: "res", ref: "R2", x: 0, y: 20, angle: 0}]};
const board = {kind: "pcb", id: "b", name: "Board", items: []};
const project = {format: "atrium", name: "P", library: [res], documents: [sheet, board]};
const infos = [];
const host = {project: () => project, doc: () => sheet, docById: id => project.documents.find(d => d.id === id), currentId: () => "s", panes: () => [], defs: () => new Map([[res.id, res]]),
  info: t => infos.push(t), invalidate() {}, on() {}, addRenderer() {}, registerAction() {}, units: () => "mm", zoomTo() {}, select() {}, edit: fn => fn(), messageContext: () => ({project})};
AtriumNavCommon.hostReady(host);

test("Compile publishes at the configured severity; a check group opens Problems on its domain", () => {
  const r = E.run(project);
  K.compiled(project, r);
  M.show({project}, {group: "Compiler", messages: r.messages});
  assert.equal(M.view(), "problems");
  const rows = M.problems();
  assert.ok(rows.length >= 4 && rows.every(m => m.problem?.domain === "schematic"), "ERC problems: " + rows.length);
  assert.ok(rows.every(m => m.class === "Warning"), "unconnected pins are warnings after Compile");
  assert.equal(M.messages().filter(m => m.group === "Compiler").length, r.messages.length, "the group's rows stay readable");
  M.show({project}, {group: "Import", messages: [{class: "Info", text: "Imported 2 sheets"}]});
  assert.equal(M.view(), "log", "a one-shot output opens Log");
});

test("chips, waived rows and stale waivers", () => {
  K.publish("b", "dfm", [{check: "ring", level: "error", title: "Annular ring", text: "Via: annular ring 0.05 mm is below the 0.1 mm via minimum.", id: "v9", at: [1, 1]}], i => K.fromDFM(i, "b", "jlcpcb-2l"));
  M.open(null, {view: "problems", domain: null, fab: false});
  const all = M.problems();
  assert.ok(all.some(m => m.problem?.check === "layout.annularRing" && m.problem.alias === "layout.fab.ring") && all.some(m => m.problem?.domain === "schematic"), "the fab's ring check is the merged Annular Ring check");
  M.open(null, {view: "problems", domain: null, fab: true});
  assert.deepEqual(M.problems().map(m => m.problem.alias), ["layout.fab.ring"], "Fab sign-off: only checks against the fab's limits");
  M.open(null, {view: "problems", domain: "schematic", fab: false});
  const v = M.problems()[0].problem;
  W.waive(project, v, {note: "test point"});
  const after = M.problems();
  assert.ok(!after.some(m => m.problem?.key === v.key), "a waived problem leaves the list");
  sheet.items.find(i => i.id === v.objects[0].id).ref = "R9";
  K.publish("project", "erc", E.run(project).messages, m => K.fromERC(m)); // the live check after the edit
  const stale = M.problems().filter(m => m.staleWaiver);
  assert.equal(stale.length, 1, "its object changed: listed as a waiver to review");
  assert.equal(stale[0].source, "Waiver to review");
  W.remove(project, stale[0].staleWaiver.id); sheet.items.find(i => i.id === v.objects[0].id).ref = v.text.includes("R1") ? "R1" : "R2";
});

test("F8 / Shift+F8 step through a sheet's problems", () => {
  K.compiled(project, E.run(project));
  const list = K.navigable("s", host);
  assert.ok(list.length >= 4, "the sheet's ERC problems are navigable");
  const a = I.step(1), b = I.step(1), back = I.step(-1);
  assert.equal(a.key, list[0].key); assert.equal(b.key, list[1].key); assert.equal(back.key, a.key);
  assert.equal(I.current().key, a.key, "the inspector holds the problem");
  assert.match(infos.at(-1), /^Problem 1 of \d+/);
  I.close();
});

console.log(passed + " problems tests passed");
