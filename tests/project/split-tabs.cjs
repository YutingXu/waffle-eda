"use strict";
// Split editor tab lists (app/project/split-tabs.js), headless: AtriumSplitTabs.plan keeps each pane's tabs valid.
const assert=require("node:assert/strict");
require("../../app/project/split-tabs.js");
const P=AtriumSplitTabs.plan;
assert.deepEqual(P([["a","b"],["b"]],["a","b"],["a","b"],0),[["a","b"],["b"]],"a document can be open in both panes");
assert.deepEqual(P([["a","x"],["b"]],["a","b"],["a","b"],0),[["a"],["b"]],"deleted documents leave every pane");
assert.deepEqual(P([["a"],[]],["a","b"],["a","b"],0),[["a"],["b"]],"a pane's shown document is always one of its tabs");
assert.deepEqual(P([["a"],["b"]],["a","b","c"],["a","b"],1),[["a"],["b","c"]],"a new document goes to the active pane");
assert.deepEqual(P(null,["a","b"],["a",null],0),[["a","b"],[]]);
assert.deepEqual(P([["a","a"],["b"]],["a","b"],["a","b"],0),[["a"],["b"]],"no duplicate tabs in a pane");
console.log("PASS split-tabs: per-pane tab lists");
