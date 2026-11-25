"use strict";
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/schematic/sch-objects.js");
require("../../app/editor/editor-demand.js");

const listeners = new Map(), hostEvents = new Map(), loaded = [], queue = [];
let cancelled = 0, shown = true, efficient = true;
globalThis.document = {
  visibilityState: "visible",
  addEventListener(type, listener) {listeners.set(type, listener);}, getElementById() {return null;}
};
globalThis.AtriumPower = {visible: () => shown, efficient: () => efficient, onChange(fn) {listeners.set("power", fn);}};
const sheet = {id:"s", kind: "schematic", items: []}, board = {id:"b", kind: "pcb", items: []};
const project = {documents: [sheet, board]};
let view = sheet, displayed = [sheet];
const host = {
  project: () => project, doc: () => view,
  panes: () => displayed.map(d => ({docId:d.id})), docById: id => project.documents.find(d => d.id === id),
  on(type, fn) {hostEvents.set(type, fn);}
};
const loader = {
  need(name) {loaded.push(name); return Promise.resolve();},
  board: () => ["board-layer-reader"],
  forAction: action => [action],
  prefetch(names) {queue.push(names); return () => {queue.length = 0;};},
  cancelPrefetch() {queue.length = 0; cancelled++;}
};
AtriumEditorDemand.attach(host, loader);
assert.ok(loaded.includes("AtriumUndoStore") && loaded.includes("AtriumCamera"), "a real editor gets its edit and camera services");
assert.ok(!loaded.includes("board-layer-reader"), "an unopened board has no active board services");
assert.ok(!loaded.includes("AtriumPalette") && !loaded.includes("AtriumRouteSuggest"), "browsing a sheet has no search or route intent");
assert.deepEqual(queue, [], "opening a sheet does not imply intent to place");
assert.ok(!loaded.includes("AtriumSchObjectTools"));
const count = loaded.length;
hostEvents.get("change")();
assert.equal(loaded.length, count, "a new edit does not reload established services");
shown = false; displayed = [sheet, board];
hostEvents.get("panes")();
assert.equal(loaded.length, count, "a background document switch does no rendering preparation");
shown = true; listeners.get("power")();
assert.ok(loaded.includes("board-layer-reader") && loaded.includes("AtriumDRCView"), "a visible secondary board renders and checks rules in Efficiency while the sheet keeps focus");
assert.equal(new Set(loaded).size, loaded.length);
queue.length = 0;
const target = {closest: () => ({dataset: {action: "library-panel"}})};
listeners.get("pointerover")({type: "pointerover", target});
assert.deepEqual(queue, [], "Efficiency suppresses speculative preparation even on a control");
efficient = false;
hostEvents.get("change")();
assert.deepEqual(queue, [], "editing a visible sheet does not prepare placement tools on AC either");
listeners.get("pointerover")({type: "pointerover", target});
assert.deepEqual(queue, [["library-panel"]], "a hint targets the particular command");
listeners.get("pointerout")({type: "pointerout", target});
assert.deepEqual(queue, [], "leaving the control withdraws the hint");
listeners.get("focusin")({type: "focusin", target}); hostEvents.get("change")();
assert.deepEqual(queue, [], "an edit withdraws the previous command hint");
listeners.get("focusin")({type: "focusin", target: {closest: () => ({dataset: {action: "sch-unrelated"}})}});
assert.deepEqual(queue, [], "only commands implemented by the placement tools prepare them");
listeners.get("pointerover")({type: "pointerover", target: {closest: () => ({dataset: {action: "sch-power"}})}});
assert.deepEqual(queue.at(-1), "AtriumSchObjectTools", "pointing at a Place command prepares placement");
globalThis.AtriumSchObjectTools = {}; queue.length = 0; hostEvents.get("change")();
assert.deepEqual(queue, [], "nothing to prepare once the tools have loaded");
delete globalThis.AtriumSchObjectTools;
// Efficiency and keyboard-only invocation still load and actually arm the first explicit tool.
efficient = true;
let tool = "select", requests = 0;
globalThis.AtriumLazy = {need(name) {
  assert.equal(name, "AtriumSchObjectTools"); requests++;
  require("../../app/schematic/sch-object-tools.js");
  return {then(fn) {return fn(globalThis.AtriumSchObjectTools);}};
}};
globalThis.AtriumSchObjects.command("sch-bus", {...host, setTool(t) {tool = t;}, info() {}, draw() {}});
assert.equal(tool, "sch-place"); assert.equal(requests, 1);
globalThis.AtriumSchObjects.cancel();
assert.ok(cancelled >= 2);
{
  const attempts = new Map(); let rejectBoard;
  AtriumEditorDemand.attach(host, {...loader, need(name) {
    attempts.set(name, (attempts.get(name) || 0) + 1);
    return {catch(fn) {if (name === "board-layer-reader") rejectBoard = fn;}};
  }});
  rejectBoard();
  displayed = [sheet]; hostEvents.get("panes")();
  displayed = [sheet, board]; hostEvents.get("panes")();
  assert.equal(attempts.get("board-layer-reader"), 2, "revealing the board retries its failed reader");
  assert.equal(attempts.get("AtriumDRCView"), 1, "successful board services stay loaded");
}
console.log("editor demand: view activation, background resume, edit reuse and withdrawn intent OK");
