"use strict";
// DRC waivers (drc-waivers.js): saved with the board, hidden from markers and counts, listed in a
// "Waived (N)" Messages group, kept (marked) in reports. A waiver held "until-changed" turns stale when an
// object's geometry changes and is removed only by prune();
// tests/checks/waivers.cjs covers while-not-worse, the project store and diffs.
const assert = require("node:assert/strict");
for (const m of ["model", "waivers", "drc-waivers", "drc-view"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const W = AtriumDRCWaivers, V = AtriumDRCView;
const track = {id:"t1", kind:"track", layer:"Top", net:"A", width:.1, points:[[0, 0], [5, 0]]};
const via = {id:"v1", kind:"via", x:5, y:.3, diameter:.6, drill:.3, layer:"Multi", net:"B"};
const doc = {id:"b", kind:"pcb", name:"Board", items:[track, via, {id:"t2", kind:"track", layer:"Top", net:"A", width:.05, points:[[0, 3], [5, 3]]}]};
const clear = {type:"clearance", ruleId:"r1", ruleName:"Clearance", id:"t1", otherId:"v1", title:"Track ↔ Via", at:[5, 0], actual:.05, required:.2};
const width = {type:"width", ruleId:"r2", ruleName:"Width", id:"t2", title:"Track t2", at:[0, 3], actual:.05, required:.1};
const unrouted = {type:"unrouted", ruleId:"r3", ruleName:"UnRoutedNet", title:"Net A between X and Y"};
const result = {violations:[clear, width, unrouted], rules:[{id:"r1", name:"Clearance", count:1}, {id:"r2", name:"Width", count:1}, {id:"r3", name:"UnRoutedNet", count:1}], total:3, stats:{ms:1}, notes:[]};

assert.ok(W.canWaive(clear) && !W.canWaive(unrouted), "a violation must name an object");
assert.throws(() => W.add(doc, unrouted), /names no object/);
const w = W.add(doc, clear, {note:"checked with the fab", holds:"until-changed"});
assert.deepEqual([w.check, w.rule, w.objects, w.note], ["layout.clearance", "Clearance", ["t1", "v1"], "checked with the fab"]);
assert.equal(W.add(doc, {...clear}, {note:"again"}), w, "waiving the same violation again updates its note");
assert.equal(w.note, "again"); W.add(doc, clear, {note:"checked with the fab"});
assert.equal(doc.drcWaivers.length, 1);
// The rule IDs of default rule sets are regenerated: waivers match by rule type, rule name and objects.
const split = W.split(doc, [{...clear, ruleId:"other"}, width]);
assert.deepEqual([split.active.map(v => v.type), split.waived.map(x => x.waiver.id)], [["width"], [w.id]]);
// Counts leave the waived violation out; the waived list keeps it.
const applied = W.apply(doc, result);
assert.deepEqual([applied.result.total, applied.result.rules.map(r => r.count), applied.waived.length], [2, [0, 1, 1], 1]);
// Messages: a collapsible Waived (N) group.
let rows = V.toMessages(result, {doc});
assert.ok(rows.some(r => r.waivedSummary && /Waived \(1\)/.test(r.text)) && !rows.some(r => r.waiver), "collapsed");
assert.ok(rows.some(r => /Design rule check: 2 violations/.test(r.text)));
rows = V.toMessages(result, {doc, waivedOpen:true});
const listed = rows.filter(r => r.waiver);
assert.equal(listed.length, 1); assert.match(listed[0].text, /^Waived · .*checked with the fab/); assert.equal(listed[0].objectId, "t1");
assert.ok(!rows.some(r => r.drc === clear && !r.waiver), "the waived violation is not an Error row");
// Reports keep it, marked waived.
const html = W.reportSection(applied.waived, "mm");
assert.match(html, /Waived violations <small>\(1\)<\/small>/); assert.match(html, /checked with the fab/); assert.match(html, /\(waived\)/);
assert.doesNotMatch(W.reportSection([{violation:{...clear, title:"<b>x</b>"}, waiver:{note:"<script>"}}]), /<script>|<b>x/, "escaped");
// Geometry change clears it: moving the via (one of its objects) makes it stale; prune removes it.
assert.deepEqual(W.stale(doc), []);
via.x = 5.1;
assert.deepEqual(W.stale(doc).map(x => x.id), [w.id]);
assert.equal(W.split(doc, [clear]).active.length, 1, "a stale waiver no longer hides the violation");
assert.equal(W.list(doc)[0].current, false);
assert.deepEqual(W.prune(doc).map(x => x.id), [w.id]);
assert.equal(doc.drcWaivers, undefined, "the last waiver removed drops the field");
// Deleting an object clears it too; remove() by id.
const w2 = W.add(doc, width, {note:""});
doc.items = doc.items.filter(i => i.id !== "t2");
assert.deepEqual(W.prune(doc).map(x => x.id), [w2.id]);
const w3 = W.add(doc, clear);
assert.equal(W.remove(doc, w3.id), 1);
// Malformed saved entries are ignored and pruned.
doc.drcWaivers = [{id:"x"}, null];
assert.deepEqual(W.split(doc, [clear]).waived, []);
assert.equal(W.prune(doc).length, 2);
// The project validator accepts a board with waivers (saved with the board).
const p = Atrium.project("W"), board = Atrium.sheet("pcb", "Board");
board.items.push({...track}); p.documents = [board]; W.add(board, {...clear, otherId:undefined}, {note:"ok"});
assert.doesNotThrow(() => Atrium.validate(JSON.parse(JSON.stringify(p))));
console.log("PASS DRC waivers: saved with the board, matched by rule and objects, hidden from counts, Waived group, report section, cleared on geometry change");
