"use strict";
// Waivers v2 (app/checks/waivers.js):
//   - while-not-worse: a measured waiver holds after a nudge that is no worse and turns stale when worse;
//   - until-changed (every waiver made before v2) turns stale when an object changes; always holds while
//     the objects exist; deleted objects make any waiver stale; nothing is removed except on request;
//   - Keep re-baselines a stale waiver; Remove Stale removes only stale ones;
//   - schematic (ERC) waivers live in project.waivers v1, board ones in doc.drcWaivers, insight
//     dismissals are read through the same records(); waivers survive validation and save;
//   - diffs: added, removed, changed and stale waivers in the "waivers" category.
// Run: scripts/test-jsc.sh waivers   (or node tests/checks/waivers.cjs)
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "net-ties", "messages", "erc", "eco", "insights", "checks", "waivers", "drc-waivers", "diff"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const W = AtriumWaivers, K = AtriumChecks, A = Atrium, DW = AtriumDRCWaivers;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const clone = v => JSON.parse(JSON.stringify(v));
function fixture() {
  const p = A.project("Waivers"), board = A.sheet("pcb", "Board"), sheet = A.sheet("schematic", "Sheet");
  board.items.push({id: "t1", kind: "track", layer: "Top", net: "A", width: .2, points: [[0, 0], [5, 0]]}, {id: "v1", kind: "via", x: 5, y: .3, diameter: .6, drill: .3, layer: "Multi", net: "B"});
  sheet.items.push({id: "u1", kind: "netlabel", x: 0, y: 0, text: "N1"});
  p.documents = [sheet, board];
  p.library = [{id: "x", name: "X", prefix: "U", symbol: {shapes: [], pins: [{number: "1", name: "1", x: 0, y: 0}]}}, {id: "y", name: "Y", prefix: "U", symbol: {shapes: [], pins: []}}];
  return {p, board, sheet};
}
const clearance = (actual, board, required = .2) => K.fromDRC({type: "clearance", ruleId: "r1", ruleName: "Clearance", id: "t1", otherId: "v1", title: "Track ↔ Via", at: [5, 0], actual, required, limit: "min"}, board);

test("while-not-worse holds after a nudge that is no worse and turns stale when worse", () => {
  const {p, board} = fixture();
  const w = W.waive(p, clearance(.186, board), {note: "checked with the fab", author: "Reviewer"});
  assert.equal(w.holds, "while-not-worse"); assert.deepEqual(w.measure, {actual: .186, required: .2, limit: "min", unit: "mm"});
  assert.deepEqual([w.check, w.rule, w.objects, w.key], ["layout.clearance", "Clearance", ["t1", "v1"], clearance(.186, board).key]);
  board.items[1].x = 5.004;
  let m = W.match(p, [clearance(.19, board)]);
  assert.equal(m.waived.length, 1, "0.19 mm after a nudge: no worse, still waived");
  assert.equal(m.states.get(w.id), "holds");
  m = W.match(p, [clearance(.15, board)]);
  assert.deepEqual([m.active.length, m.stale.map(r => r.id)], [1, [w.id]], "0.15 mm is worse: the violation shows and the waiver is stale");
  assert.ok(board.drcWaivers.some(x => x.id === w.id), "a stale waiver is never removed behind the user's back");
  assert.equal(W.match(p, []).states.get(w.id), "unused", "a fixed violation leaves the waiver unused, not stale");
  // Keep: re-baselined at today's value.
  W.keep(p, w.id, clearance(.15, board));
  assert.equal(W.match(p, [clearance(.15, board)]).waived.length, 1);
  assert.equal(W.match(p, [clearance(.14, board)]).stale.length, 1);
});

test("while-not-worse goes stale when the requirement tightens; a clipped value also needs unchanged objects", () => {
  const {p, board} = fixture();
  const ml = (required, actual = 48) => K.fromDRC({type: "matchedLengths", ruleName: "DDR", id: "t1", actual, required, limit: "min", title: "Net A against longest"}, board);
  W.waive(p, ml(49), {note: "ok"});
  assert.equal(W.match(p, [ml(49)]).waived.length, 1);
  assert.equal(W.match(p, [ml(59)]).waived.length, 0, "the longest net grew: 11 mm short instead of 1");
  assert.equal(W.match(p, [ml(48.5, 47.6)]).waived.length, 1, "a looser target with the same shortfall still holds");
  const c = r => clearance(.186, board, r);
  W.waive(p, c(.2), {});
  assert.equal(W.match(p, [c(.3)]).waived.length, 0, "a clearance rule tightened from 0.2 to 0.3 mm");
  const ring = K.fromDRC({type: "annularRing", ruleName: "Ring", id: "v1", actual: 0, required: .1, limit: "min", title: "Via"}, board);
  W.waive(p, ring, {});
  assert.equal(W.match(p, [ring]).waived.length, 1);
  board.items[1].drill = .5; // the ring is gone further, but DRC still says 0
  assert.equal(W.match(p, [ring]).waived.length, 0, "a value clipped at 0 cannot show it got worse: the objects must be unchanged");
  // A problem gone from a document that was fully checked: stale (to review), not silently unused.
  const m = W.match(p, [], {complete: () => true});
  assert.ok(m.stale.length >= 3);
});

test("until-changed, always, deleted objects and Remove Stale", () => {
  const {p, board} = fixture();
  const u = W.waive(p, clearance(.1, board), {holds: "until-changed"});
  board.items[1].x = 5.004;
  assert.deepEqual(W.match(p, [clearance(.1, board)]).stale.map(r => r.id), [u.id], "until-changed: an object changed");
  W.waive(p, clearance(.1, board), {holds: "always"});
  assert.equal(board.drcWaivers.length, 1, "waiving the same violation again updates the one record");
  assert.equal(board.drcWaivers[0].holds, "always");
  assert.equal(W.match(p, [clearance(.01, board)]).waived.length, 1, "always: holds whatever the value");
  board.items = board.items.filter(i => i.id !== "v1");
  assert.equal(W.match(p, [clearance(.01, board)]).stale.length, 1, "a deleted object makes any waiver stale");
  assert.equal(W.removeStale(p, []), 1); assert.equal(board.drcWaivers, undefined);
});

test("schematic waivers live in project.waivers; insight dismissals read through the same records", () => {
  const {p, sheet} = fixture();
  const m = {class: "Warning", check: "unconnectedPins", text: "Unconnected pin U1-1", documentId: sheet.id, objectId: "u1", point: [0, 0]};
  const v = K.fromERC(m), w = W.waive(p, v, {note: "test point"});
  assert.equal(p.waivers.version, 1); assert.equal(p.waivers.list[0].key, v.key); assert.equal(w.holds, "until-changed");
  assert.equal(W.match(p, [v]).waived.length, 1);
  sheet.items[0].x = 40;
  assert.equal(W.match(p, [v]).waived.length, 1, "moving the object keeps an ERC waiver (only what ERC reads counts)");
  sheet.items[0].text = "N2";
  assert.equal(W.match(p, [v]).stale.length, 1, "changing what ERC reads (its text) makes it stale");
  p.insights = {version: 1, dismissed: {"neck:abc": {check: "neck", doc: "b", objects: ["t1"], sig: "s", date: "2026-11-20", note: "ok"}}, muted: {}};
  const recs = W.records(p);
  assert.deepEqual(recs.map(r => r.store).sort(), ["insights", "project"]);
  assert.equal(recs.find(r => r.store === "insights").note, "ok");
  assert.equal(W.remove(p, ["neck:abc", w.id]), 2);
  assert.deepEqual(p.waivers.list, []); assert.deepEqual(p.insights.dismissed, {});
});

test("waivers survive validation and save; malformed records are ignored", () => {
  const {p, board} = fixture();
  board.drcWaivers = [{id: "bad", rule: "Clearance", objects: ["t1"]}];
  assert.equal(W.records(p, board).length, 0, "a record without key, check and geometry is not a waiver");
  board.drcWaivers = [];
  W.waive(p, clearance(.12, board), {note: "new"});
  W.waive(p, K.fromERC({class: "Warning", check: "unconnectedPins", text: "Unconnected pin U1-1", documentId: p.documents[0].id, objectId: "u1"}), {});
  const saved = require("../support/native-cad.cjs").nativeRoundTrip(A.validate(clone(p)));
  assert.equal(saved.waivers.list.length, 1); assert.equal(saved.documents[1].drcWaivers[0].holds, "while-not-worse");
  assert.equal(saved.documents[1].drcWaivers[0].key, clearance(.12, board).key);
  // A newer store version is read as far as it matches and left as it is.
  p.waivers.version = 2; p.waivers.extra = {x: 1};
  assert.equal(W.records(p).filter(r => r.store === "project").length, 1);
  assert.deepEqual(p.waivers.extra, {x: 1});
});

test("merged problems are waived as the engine's own finding", () => {
  const {p, board} = fixture();
  const drc = K.fromDRC({type: "annularRing", ruleName: "Ring", id: "v1", actual: .05, required: .1, limit: "min", title: "Via"}, board);
  const dfm = K.fromDFM({check: "ring", level: "error", title: "Annular ring", text: "below 0.13", id: "v1", actual: .05, required: .13}, board, "jlc");
  const [merged] = K.merge([drc, dfm]);
  const w = W.waive(p, merged, {note: "fab ok"});
  assert.deepEqual([w.check, w.key], ["layout.fab.ring", dfm.key], "the fab's finding won: it is waived as the fab's own finding");
  assert.equal(W.match(p, K.merge([drc, dfm])).waived.length, 1);
  assert.equal(W.match(p, K.merge([drc, {...dfm, measure: {...dfm.measure, required: .09}}].map(x => x.key ? x : x))).waived.length, 1, "it holds while the rule is stricter too (the other member's key)");
});

test("diffs: muting a hint check is a waiver change", () => {
  const a = A.project("P"), b = clone(a);
  a.insights = {version: 1, dismissed: {}, muted: {}};
  b.insights = {version: 1, dismissed: {}, muted: {decoupling: {date: "2026-11-20"}}};
  const c = AtriumDiff.compare(a, clone(b)).changes.filter(x => x.category === "waivers");
  assert.equal(c.length, 1); assert.match(c[0].text, /Waiver added: All “decoupling” hints/);
});

test("diffs: waivers added, removed, changed and stale", () => {
  const {p, board} = fixture(), before = clone(p);
  W.waive(p, clearance(.15, board), {note: "first", author: "A"});
  let changes = AtriumDiff.compare(before, p).changes.filter(c => c.category === "waivers");
  assert.deepEqual(changes.map(c => c.kind), ["waiver.added"]); assert.match(changes[0].text, /first · A/); assert.equal(changes[0].severity, "electrical");
  assert.ok(!AtriumDiff.compare(before, p).changes.some(c => c.kind === "document.setting" && c.fields.includes("drcWaivers")), "no raw field diff");
  const mid = clone(p);
  board.drcWaivers[0].note = "second";
  W.waive(p, K.fromERC({class: "Warning", check: "unconnectedPins", text: "Unconnected pin U1-1", documentId: p.documents[0].id, objectId: "u1"}), {holds: "until-changed"});
  p.documents[0].items[0].text = "N9";
  changes = AtriumDiff.compare(mid, p).changes.filter(c => c.category === "waivers");
  assert.deepEqual(changes.map(c => c.kind).sort(), ["waiver.added", "waiver.changed", "waiver.stale"]);
  board.drcWaivers = [];
  assert.deepEqual(AtriumDiff.compare(mid, p).changes.filter(c => c.category === "waivers").map(c => c.kind).sort(), ["waiver.added", "waiver.removed", "waiver.stale"]);
});

console.log(passed + " waivers tests passed");
