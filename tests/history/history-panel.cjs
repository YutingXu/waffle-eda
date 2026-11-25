"use strict";
// History panel (app/history/history-panel.js): step labels made from the undo store's changes between two
// states (move, rotate, route, unroute, delete, place, repour, document and settings changes, the
// action's name for generic edits, explicit labels), and that a label costs only what changed.
// Runs under Node and JavaScriptCore (scripts/test-jsc.sh history-panel).
const assert = require("node:assert/strict");
require(globalThis.UNDO_STORE_PATH || "../../app/history/undo-store.js");
require("../../app/history/history-panel.js");
const U = AtriumUndoStore, P = AtriumHistoryPanel;

function project() {
  const items = [];
  for (let i = 0; i < 600; i++) items.push({id: "t" + i, kind: "track", layer: "Top", width: .2, net: "N" + (i % 9), points: [[i, 0], [i + 1, 0]]});
  for (let i = 1; i <= 20; i++) items.push({id: "p" + i, kind: "part", def: "r", x: i * 3, y: 5, angle: 0, ref: "R" + i, value: "1k"});
  items.push({id: "poly1", kind: "polygon", name: "GND_TOP", net: "GND", layer: "Top", points: [[0, 0], [9, 0], [9, 9]]});
  return {format: "atrium", name: "P", library: [{id: "r", name: "R"}],
    documents: [{id: "b", kind: "pcb", name: "Board", items, outline: [[0, 0], [100, 0], [100, 50]],
      pcbDrawing: {annotations: {}, pours: [{polygon: "poly1", net: "GND", layer: "Top", bounds: [0, 0, 9, 9], count: 1, data: "AAAA"}]}}]};
}
let p = project(), rev = 0;
const h = [], f = [];
U.reset();
// One edit the way editor.js makes it: a mark, the change, the checkpoint, then change() -> touch().
const step = (fn, o = {}) => {
  const a = U.mark(p, {current: "b"});
  if (o.action) U.action(o.action);
  fn(p.documents[0].items, p);
  U.checkpoint(h, f, a, o.label); U.touch(p);
  U.action(null);
  return P.label(a, U.live(++rev));
};
const items = () => p.documents[0].items, part = ref => items().find(i => i.ref === ref);

assert.equal(step(() => { part("R1").x += 1; part("R2").y += 2; }).label, "Move R1, R2");
assert.equal(step(() => { for (const r of ["R3", "R4", "R5", "R6"]) part(r).x += 1; }).label, "Move R3, R4 +2");
assert.equal(step(() => { part("R1").angle = 90; part("R1").x += 1; }).label, "Rotate R1");
assert.equal(step(it => { it.push({id: "n1", kind: "track", net: "GND", layer: "Top", width: .2, points: [[0, 0], [1, 1]]},
  {id: "n2", kind: "track", net: "GND", layer: "Top", width: .2, points: [[1, 1], [2, 1]]}, {id: "n3", kind: "track", net: "GND", layer: "Top", width: .2, points: [[2, 1], [3, 1]]}); }).label,
  "Route GND (3 tracks)");
assert.equal(step(it => { it.push({id: "v1", kind: "via", net: "VCC", x: 1, y: 1}, {id: "n4", kind: "track", net: "VCC", points: [[0, 0], [1, 1]]}); }).label, "Route VCC (1 track, 1 via)");
assert.equal(step((it, q) => { q.documents[0].items = it.filter(i => !/^t(1|2)\d$/.test(i.id)); }).label, "Unroute N1, N2 +7 (20 tracks)");
assert.equal(step((it, q) => { q.documents[0].items = it.filter(i => !["R7", "R8"].includes(i.ref) && !/^t3\d$/.test(i.id)); }).label, "Delete 12 objects");
assert.equal(step((it, q) => { q.documents[0].items = it.filter(i => i.ref !== "R9"); }).label, "Delete R9");
assert.equal(step(it => { it.push({id: "p99", kind: "part", def: "r", x: 0, y: 0, ref: "R99"}); }).label, "Place R99");
assert.equal(step((it, q) => { q.documents[0].pcbDrawing.pours[0].data = "BBBB"; }).label, "Repour GND_TOP");
assert.equal(step(() => { part("R10").value = "2k"; }).label, "Edit R10 (value)");
assert.equal(step(() => { part("R10").value = "3k"; }, {action: "annotate"}).label.startsWith("annotate"), false, "no keymap: the action id is not shown raw");
assert.equal(step(() => { items().find(i => i.id === "t100").width = .5; items().find(i => i.id === "t101").width = .5; }).label, "Change width of 2 tracks");
assert.equal(step((it, q) => { q.documents[0].outline = [[0, 0], [1, 1], [2, 0]]; }).label, "Change board outline");
assert.equal(step((it, q) => { q.documents.push({id: "s2", kind: "schematic", name: "Power", items: []}); }).label, "Add sheet Power");
assert.equal(step((it, q) => { q.documents.pop(); }).label, "Delete sheet Power");
assert.equal(step(() => { part("R11").x += 1; }, {label: "Align left"}).label, "Align left", "an explicit label wins");
// The action's title for a generic edit.
globalThis.AtriumKeymap = {command: id => id === "find-replace" ? {title: "Find and replace…"} : null};
assert.equal(step(() => { part("R12").value = "x"; part("R13").value = "y"; part("R14").value = "z"; }, {action: "find-replace"}).label, "Find and replace (3 objects)");
assert.equal(step(() => { part("R12").x += 5; }, {action: "find-replace"}).label, "Move R12", "a clear edit keeps its own label");

// A label on a big board parses only the objects the step changed.
{
  const big = {format: "atrium", name: "B", documents: [{id: "b", kind: "pcb", name: "B", items: Array.from({length: 25600}, (_, i) => ({id: "o" + i, kind: "via", x: i, y: 0, net: "N"}))}]};
  U.reset(); h.length = f.length = 0;
  const a = U.mark(big, {}); big.documents[0].items[12345].x += 1; U.checkpoint(h, f, a); U.touch(big); const b = U.live(++rev);
  const t0 = Date.now(), info = P.label(a, b);
  assert.equal(info.label, "Move via");
  assert.ok(Date.now() - t0 < 200, "label in " + (Date.now() - t0) + " ms");
  const ch = info.changes.find(c => c.path === "items");
  assert.equal(ch.modified.length, 1);
}
console.log("PASS history panel labels");
