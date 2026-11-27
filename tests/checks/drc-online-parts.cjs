"use strict";
// Online DRC re-checks a large edit in parts (app/checks/drc-view.js online().update with timeRemaining):
// one part per idle slice, mode "partial" until every part is done, and the same violations as one
// pass and as a full check of the edited board.
// Node: node tests/checks/drc-online-parts.cjs   JSC: scripts/test-jsc.sh drc-online-parts
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "nav-common", "spatial", "connectivity", "design-query-record", "rules", "drc", "pcb-edit", "drc-view", "problem-marks", "drc-markers"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../pcb/dense-board.js");
require("../support/drc-geometry.cjs");
const V = globalThis.AtriumDRCView, R = globalThis.AtriumRules;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };

function board() {
  const {d, defs} = makeAtriumBenchmarkBoard(100);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++; }
  return {d, defs, rules: R.defaults()};
}
const key = v => JSON.stringify(Object.keys(v).sort().map(k => [k, v[k]]));
const set = list => list.map(key).sort();
const viaEdit = (d, dx) => { const ids = new Set(), items = new Map(); for (const i of d.items) if (i.kind === "via") { i.x += dx; ids.add(i.id); items.set(i.id, i); } return {ids, items}; };

test("a large edit re-checked in parts matches one pass and a full check", () => {
  const {d, defs, rules} = board();
  const one = V.online(), parts = V.online();
  one.update(d, defs, rules, {to: 1}); parts.update(d, defs, rules, {to: 1});
  const {ids, items} = viaEdit(d, .31);
  assert.ok(ids.size > 512 && ids.size < d.items.length * .25, "the edit is large but not a full re-check: " + ids.size);
  const hint = {from: 1, to: 2, ids, items};
  const a = one.update(d, defs, rules, hint);
  assert.equal(a.mode, "incremental");
  let calls = 0, r;
  do { r = parts.update(d, defs, rules, calls ? {from: 2, to: 2, ids: new Set(), items: new Map()} : hint, {timeRemaining: () => 0}); calls++; } while (r.mode === "partial" && calls < 100);
  assert.equal(r.mode, "incremental"); assert.ok(calls > 2, "several parts: " + calls); assert.equal(parts.pending(), 0);
  const full = R.drc(d, defs, rules, {types: one.types(), limit: 5000}).violations;
  assert.ok(full.length > 0, "the board has violations");
  assert.deepEqual(set(a.violations), set(full), "one pass = full check");
  assert.deepEqual(set(r.violations), set(full), "parts = full check");
});

test("an edit while parts are pending is folded in", () => {
  const {d, defs, rules} = board();
  const o = V.online();
  o.update(d, defs, rules, {to: 1});
  const first = viaEdit(d, .31);
  let r = o.update(d, defs, rules, {from: 1, to: 2, ...first}, {timeRemaining: () => 0});
  assert.equal(r.mode, "partial"); assert.ok(o.pending() > 0);
  // A second edit before the rest ran: a few tracks move; the hint names only them.
  const ids = new Set(), items = new Map();
  for (const i of d.items.filter(x => x.kind === "track").slice(0, 40)) { i.points = i.points.map(([x, y]) => [x + .2, y]); ids.add(i.id); items.set(i.id, i); }
  let calls = 0;
  r = o.update(d, defs, rules, {from: 2, to: 3, ids, items}, {timeRemaining: () => 0});
  while (r.mode === "partial" && calls++ < 100) r = o.update(d, defs, rules, {from: 3, to: 3, ids: new Set(), items: new Map()}, {timeRemaining: () => 0});
  assert.equal(r.mode, "incremental");
  assert.deepEqual(set(r.violations), set(R.drc(d, defs, rules, {types: o.types(), limit: 5000}).violations));
  // Without a deadline every part runs in one update.
  const again = viaEdit(d, -.31);
  r = o.update(d, defs, rules, {from: 3, to: 4, ...again});
  assert.equal(r.mode, "incremental"); assert.equal(o.pending(), 0);
  assert.deepEqual(set(r.violations), set(R.drc(d, defs, rules, {types: o.types(), limit: 5000}).violations));
});

test("footprint and outline changes refresh the grid before the next local check", () => {
  const d = {kind:"pcb", id:"dependencies", name:"Dependencies", items:[]}, rules = R.defaults(), engine = V.online();
  d.outline = [[-10, -10], [20, -10], [20, 10], [-10, 10]];
  const pad = {kind:"pad", number:"1", layer:"Top", x:0, y:0, w:.5, h:1, shape:"rect"};
  const defs = new Map([["pkg", {id:"pkg", footprint:{pads:[pad], shapes:[]}}]]);
  const part = {kind:"part", id:"u1", def:"pkg", x:0, y:0, angle:0, layer:"Top", pinNets:{"1":"A"}};
  const track = {kind:"track", id:"t1", net:"B", width:.2, layer:"Top", points:[[6, -.25], [6, .25]]};
  d.items = [part, track];
  const hint = (from, outer, changed = []) => ({from, to:from + 1, outer,
    ids:new Set(changed.map(i => i.id)), items:new Map(changed.map(i => [i.id, i]))});
  const batch = (doc, lib) => set(R.drc(doc, lib, rules, {types:engine.types(), limit:5000}).violations);
  const same = (doc, defs, hint, mode) => {
    const got = engine.update(doc, defs, rules, hint);
    if (mode) assert.equal(got.mode, mode);
    assert.deepEqual(set(got.violations), batch(doc, defs));
    return got.violations;
  };
  same(d, defs, hint(0, 0), "full");
  track.points = [[6.1, -.25], [6.1, .25]];
  same(d, defs, hint(1, 0, [track]), "incremental"); // Builds the pick grid with the small footprint.
  pad.w = 9;
  same(d, defs, hint(2, 1), "full");
  track.points = [[4.625, -.25], [4.625, .25]];
  const near = same(d, defs, hint(3, 1, [track]), "incremental");
  assert.ok(near.some(v => v.type === "clearance" && Math.abs(v.actual - .025) < .001), "the enlarged pad is picked by the next local check");
  pad.w = .5;
  same(d, defs, hint(4, 2), "full"); // Undo advances the outer journal even when no PCB item changed.
  d.outline = [[-10, -10], [5, -10], [5, 10], [-10, 10]];
  same(d, defs, hint(5, 3), "full");
  const replacement = JSON.parse(JSON.stringify(d));
  same(replacement, defs, hint(6, 3), "full"); // Opening a project can preserve every document and item ID.
  pad.w = 9;
  same(replacement, defs, {to:8}, "full"); // Headless calls can lack the journal.
});

test("the first edit after opening is incremental when the first check ran before the journal knew the board", () => {
  const {d, defs, rules} = board(), o = V.online();
  // The first check: no journal versions yet (the undo store records the project at the first edit).
  assert.equal(o.update(d, defs, rules, {from: null, to: 0, ids: null, items: null, outer: 0}).mode, "full");
  const v = d.items.find(i => i.kind === "via"); v.x += .2;
  // The first edit: the journal now has versions, and no item list since the first check (a new root).
  const r = o.update(d, defs, rules, {from: 0, to: 2, ids: null, items: null, outer: "1/0/0/1", library: 1, pours: 0});
  assert.equal(r.mode, "incremental", "the board's content did not change: " + r.why);
  assert.deepEqual(set(r.violations), set(R.drc(d, defs, rules, {types: o.types(), limit: 5000}).violations));
  // A changed outline before the versions are known is still a full check.
  const o2 = V.online();
  o2.update(d, defs, rules, {from: null, to: 0, ids: null, items: null, outer: 0});
  d.outline = d.outline.map(([x, y]) => [x + 1, y]);
  assert.equal(o2.update(d, defs, rules, {from: 0, to: 2, ids: null, items: null, outer: "1/1/0/1", library: 1, pours: 0}).mode, "full");
});

test("a part move stays incremental when only a net-wide rule's scope reads components", () => {
  // Matched Lengths runs in batch DRC only. Its InXSignalClass/InComponentClass scope made every component
  // move or its Undo a whole-board check (hundreds of ms on imported Altium boards).
  const Q = globalThis.AtriumDesignQueryRecord;
  const d = {kind:"pcb", id:"net-wide-scope", name:"Net-wide scope", items:[], outline:[[-10, -10], [20, -10], [20, 10], [-10, 10]]};
  const pad = {kind:"pad", number:"1", layer:"Top", x:0, y:0, w:.5, h:1, shape:"rect"};
  const defs = new Map([["pkg", {id:"pkg", footprint:{pads:[pad], shapes:[]}}]]);
  const part = {kind:"part", id:"u1", def:"pkg", x:0, y:0, angle:0, layer:"Top", pinNets:{"1":"A"}};
  const track = {kind:"track", id:"t1", net:"B", width:.2, layer:"Top", points:[[3, -.25], [3, .25]]};
  d.items = [part, track];
  const withScope = type => {
    const rules = R.migrate(R.defaults());
    for (const r of rules.list) if (r.type === type) r.priority++;
    rules.list.push({id:"scoped", type, name:"Components", comment:"", enabled:true, priority:1, scope:Q.selector("componentclass", "All Components"),
      ...(type === "matchedLengths" ? {tolerance:.5, withinPair:false, pairTolerance:.1} : {scope2:Q.selector("all"), gap:.5})});
    return rules;
  };
  for (const [type, mode] of [["matchedLengths", "incremental"], ["clearance", "full"]]) {
    const rules = withScope(type), engine = V.online();
    part.x = 0;
    assert.equal(engine.update(d, defs, rules, {from:0, to:1, outer:0, ids:new Set(), items:new Map()}).mode, "full");
    part.x = 2.6;
    const got = engine.update(d, defs, rules, {from:1, to:2, outer:0, ids:new Set(["u1"]), items:new Map([["u1", part]])});
    assert.equal(got.mode, mode, type + ": " + got.why);
    assert.deepEqual(set(got.violations), set(R.drc(d, defs, rules, {types:engine.types(), limit:5000}).violations));
    assert.ok(got.violations.some(v => v.type === "clearance"), "the moved pad is checked against the track");
  }
});

console.log(passed + " drc-online-parts tests passed");
