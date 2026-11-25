"use strict";
// Violation inspector (app/checks/drc-inspector.js): finding a violation again after online DRC,
// the values and objects it shows, and Next / Previous Violation (F8 / Shift+F8) stepping
// through the board's violations with a fly-to, headless (no DOM).
// Node: node tests/checks/drc-inspector.cjs   JSC: scripts/test-jsc.sh drc-inspector
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/editor/nav-common.js");
require("../../app/core/spatial.js");
require("../../app/checks/connectivity.js");
require("../../app/checks/rules.js");
require("../../app/checks/drc.js");
require("../../app/checks/drc-view.js");
require("../../app/checks/problem-marks.js");
require("../../app/checks/drc-markers.js");
require("../../app/checks/drc-inspector.js");
const I = globalThis.AtriumDRCInspector, V = globalThis.AtriumDRCView, R = globalThis.AtriumRules;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

const defs = new Map();
const track = (id, net, points, width = .2) => ({kind: "track", id, net, points, width, layer: "Top"});

test("values and objects", () => {
  const v = {type: "clearance", id: "a", otherId: "b", title: "Track (Top) A ↔ Track (Top) B", actual: .15, required: .2, limit: "min"};
  assert.deepEqual(I.values(v, "mm"), {actual: "0.15 mm", required: "≥ 0.2 mm"});
  assert.deepEqual(I.values({...v, limit: "max"}, "mm").required, "≤ 0.2 mm");
  assert.deepEqual(I.values({type: "delay", delay: {actual: 120, required: 150, limit: "min"}}), {actual: "120.00 ps", required: "≥ 150.00 ps"});
  assert.deepEqual(I.objects(v), [{id: "a", text: "Track (Top) A"}, {id: "b", text: "Track (Top) B"}]);
  assert.deepEqual(I.objects({type: "width", id: "a", otherId: "a", title: "Track (Top) A"}), [{id: "a", text: "Track (Top) A"}]);
});

test("relocate: identity, else the same rule and objects nearest the old point", () => {
  const v = {type: "clearance", ruleName: "Clearance", id: "a", otherId: "b", at: [1, 1]};
  const same = {...v, at: [1.1, 1]}, far = {...v, at: [9, 9]}, other = {...v, otherId: "c"};
  assert.equal(I.relocate(v, [other, v]), v);
  assert.equal(I.relocate(v, [far, other, same]), same);
  assert.equal(I.relocate(v, [other]), null);
  assert.equal(I.relocate({...v, id: "b", otherId: "a"}, [same]), same, "object order does not matter");
});

test("next / previous violation cycle through the board and fly the camera", () => {
  const items = [];
  // Three pairs of tracks 0.1 mm apart (clearance errors), far from each other.
  for (let k = 0; k < 3; k++) items.push(track("p" + k, "N" + k, [[k * 20, 0], [k * 20 + 5, 0]]), track("q" + k, "M" + k, [[k * 20, .3], [k * 20 + 5, .3]]));
  const doc = {kind: "pcb", id: "b1", name: "T", items, notes: []};
  const zooms = [], infos = [], actions = new Map();
  const host = {doc: () => doc, docById: () => doc, defs: () => defs, project: () => ({rules: null, documents: [doc]}), units: () => "mm", info: t => infos.push(t),
    registerAction: (a, f) => actions.set(a, f), addRenderer() {}, on() {}, invalidate() {}, redraw() {}, zoomTo: b => zooms.push(b), act() {}, tool: () => "select"};
  V.attach(host); I.attach(host);
  V.check();
  const list = I.navigable("b1");
  assert.equal(list.length, 3, JSON.stringify(V.violations("b1").map(v => v.type)));
  assert.ok(actions.has("drc-next") && actions.has("drc-prev"));
  const first = actions.get("drc-next")();
  assert.equal(first, list[0]); assert.equal(I.current(), list[0]); assert.equal(V.focused(), list[0], "the marker is pinned");
  assert.equal(zooms.length, 1);
  assert.match(infos.at(-1), /^Violation 1 of 3: Clearance/);
  assert.equal(actions.get("drc-next")(), list[1]);
  assert.equal(actions.get("drc-prev")(), list[0]);
  assert.equal(actions.get("drc-prev")(), list[2], "wraps around");
  assert.ok(zooms.length === 4 && zooms.every(b => b[2] - b[0] >= 4 - 1e-9));
  assert.ok(I.close()); assert.equal(I.isOpen(), false); assert.equal(V.focused(), null);
  // Nothing to step through.
  doc.items = [track("x", "N", [[0, 0], [1, 0]])]; V.check();
  assert.equal(actions.get("drc-next")(), null);
  assert.match(infos.at(-1), /No rule violations/);
});

console.log(passed + " drc-inspector tests passed");
