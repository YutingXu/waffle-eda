"use strict";
// Query language (app/checks/query.js): grammar, evaluation on the example project and a 25k-object
// board, rule-scope reuse (rules.js "query" scope kind), the MCP entry point, and robustness
// (deep nesting, long input, random input: always a QueryError or a result, never a hang).
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "connectivity", "stackup", "altium-rules", "rooms", "component-classes", "query", "rules"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../pcb/dense-board.js");
const Q = AtriumQuery, R = AtriumRules;
const p = AtriumParts.example(), sch = p.documents[0], board = p.documents[1];
const ids = (doc, q) => Q.run(p, doc, q).ids;

// 1. Grammar: the brief's examples parse and normalise.
for (const [q, want] of [
  ["IsTrack And OnLayer('Top') And Width < 0.2mm", "IsTrack And OnLayer('Top') And Width < 0.2mm"],
  ["InNet('GND')", "InNet('GND')"], ["innetclass('X')", "InNetClass('X')"], ["InComponent('U1')", "InComponent('U1')"],
  ["InComponentClass('X')", "InComponentClass('X')"], ["IsVia", "IsVia"], ["IsPad", "IsPad"], ["HoleSize > 0.3mm", "HoleSize > 0.3mm"],
  ["Comment Like '10k*'", "Comment Like '10k*'"], ["Not (IsVia Or IsPad) && Width >= 10mil", "Not (IsVia Or IsPad) And Width >= 0.254mm"],
  ["0.2 > Width", "Width < 0.2"], ["Name = 'It''s'", "Name = 'It''s'"], ["OnLayer(TopLayer)", "OnLayer('TopLayer')"]]) {
  const r = Q.check(q);
  assert.ok(r.ok, q + ": " + r.error);
  assert.equal(r.normalized, want, q);
}
for (const [q, re] of [["", /empty/], ["Width <", /ends too early/], ["Foo", /Unknown name/], ["InNet('GND'", /closing parenthesis/], ["InNet('GND", /quote/],
  ["IsVia And", /ends too early/], ["IsVia IsPad", /And or Or/], ["Width", /property/], ["3mm", /value on its own/], ["InNet()", /one argument/],
  ["IsVia(1)", /no arguments/], ["Width < 2furlong", /Unknown unit/], ["a$b", /Unexpected character/], [")", /closing parenthesis/]]) {
  const r = Q.check(q);
  assert.equal(r.ok, false, q);
  assert.match(r.error, re, q + " → " + r.error);
  assert.ok(r.at >= 0 && r.at <= q.length, q + " position");
}
assert.equal(Q.glob("10k*", "10 kΩ"), false); assert.ok(Q.glob("10*", "10 kΩ")); assert.ok(Q.glob("r?", "R1")); assert.ok(Q.glob("*a*b*c*", "xxaxxbxxcxx"));
assert.equal(Q.layerKey("MidLayer2"), "Inner 2"); assert.equal(Q.layerKey("TopOverlay"), "Silk"); assert.equal(Q.layerKey("Bottom Layer"), "Bottom");

// 2. Evaluation on the example board and schematic.
const parts = board.items.filter(i => i.kind === "part");
assert.equal(ids(board, "IsComponent").length, parts.length);
assert.deepEqual(ids(board, "InComponent('u1')"), [board.items.find(i => i.ref === "U1").id], "case-insensitive designators");
assert.deepEqual(ids(board,'part where designator = "u1"'),[],"native equality follows exact source text");
assert.deepEqual(ids(board,'part where designator like "u1"'),[board.items.find(i=>i.ref==="U1").id],"native wildcard comparison folds case");
const r1 = Q.run(p, board, "IsPad And InComponent('R1')");
assert.deepEqual(r1.subs.map(s => s.pin).sort(), ["1", "2"], "component pads are sub-objects");
assert.ok(r1.subs.every(s => s.id.startsWith(r1.subs[0].part.id + "/")));
const gnd = Q.run(p, board, "InNet('GND')");
assert.ok(gnd.ids.length + gnd.subs.length > 0);
assert.ok(gnd.ids.every(id => board.items.find(i => i.id === id).net === "GND"));
assert.deepEqual(ids(board, "Comment Like '10*'").sort(), parts.filter(i => /^10/.test(i.value)).map(i => i.id).sort());
const tracks = board.items.filter(i => i.kind === "track");
assert.equal(ids(board, "IsTrack And Width < 100mm").length, tracks.length);
assert.equal(ids(board, "IsTrack And Width < 0.001mm").length, 0);
assert.equal(ids(board, "IsTrack And Not OnLayer('Top')").length, tracks.filter(t => (t.layer || "Top") !== "Top").length);
assert.equal(ids(board, "IsVia And HoleSize > 0").length, board.items.filter(i => i.kind === "via" && i.drill > 0).length);
assert.equal(ids(board, "All").length, board.items.length);
assert.equal(ids(board, "IsVia Or Not IsVia").length, board.items.length);
assert.equal(ids(sch, "IsComponent").length, sch.items.filter(i => i.kind === "part").length);
const schGnd = Q.run(p, sch, "IsPin And InNet('GND')");
assert.ok(schGnd.subs.length >= 2, "schematic pins carry compiled nets");
assert.ok(ids(sch, "IsWire").length > 0);
// Component classes (user class on the board) and net classes.
AtriumComponentClasses.set(board, "Passives", ["R1", "R2", "C1"]);
assert.deepEqual(ids(board, "InComponentClass('passives')").length, 3);
board.rules = R.migrate ? board.rules : board.rules;
// fromItem builds a query that finds the object again.
const t0 = tracks[0], back = Q.fromItem(board, t0, {project:p});
assert.ok(Q.valid(back), back);
assert.ok(ids(board, back).includes(t0.id), back);
assert.ok(ids(board, Q.fromItem(board, parts[0], {project:p})).includes(parts[0].id));

// 3. MCP entry point.
const h = Q.headless(p, {expression:"IsComponent Or InNet('GND')", apply:"select"});
assert.equal(h.document_id, board.id); assert.ok(h.count > parts.length); assert.match(h.note, /editor/);
assert.equal(Q.headless(p, {expression:"IsWire", document_id:sch.name}).document_id, sch.id);
assert.throws(() => Q.headless(p, {expression:"IsVia And"}), /Query error at character/);
assert.throws(() => Q.headless(p, {expression:"IsVia", document_id:"nope"}), /no document/);

// 4. A consumer supplies eligible object kinds. Unknown applicability stays distinguishable from false.
{
  const m=Q.ruleMatcher("InNetClass('Power') Or InNet('GND')",{classes:new Map([["Power",new Set(["VIN","+5V"])]])});
  assert.equal(m({net:"VIN"}),true);assert.equal(m({net:"gnd"}),true);assert.equal(m({net:"SDA"}),false);
  const layer=Q.ruleMatcher("OnLayer('Inner 2') And IsVia",{});
  assert.equal(layer.test({net:"A",span:[0,127]}),null);
  assert.equal(layer({net:"A",span:[0,127],kind:"via"}),true);
  assert.equal(layer({net:"A",span:[0,1],kind:"via"}),false);
  assert.equal(layer({net:"A",span:[0,127],kind:"track"}),false);
  const broken=Q.ruleMatcher("IsVia And",{});
  assert.equal(broken.complete,false); assert.equal(broken.test({net:"x"}),null);assert.ok(broken.diagnostics.length);
}

// 5. 25k-object board: a full query is fast and the result is exact.
const {d:dense, defs:denseDefs} = makeAtriumBenchmarkBoard(160);
const dp = {name:"dense", library:[...denseDefs.values()], documents:[dense]};
let t = Date.now();
const big = Q.run(dp, dense, "IsTrack And OnLayer('Top') And Width < 0.3mm");
const ms = Date.now() - t;
assert.equal(big.ids.length, dense.items.filter(i => i.kind === "track" && i.layer === "Top").length);
t = Date.now(); const vias = Q.run(dp, dense, "IsVia And HoleSize > 0.25mm"); const ms2 = Date.now() - t;
assert.equal(vias.ids.length, dense.items.filter(i => i.kind === "via").length);
assert.ok(ms < 3000 && ms2 < 3000, "25k board queries " + ms + " / " + ms2 + " ms");

// 6. Robustness: deep nesting, long input, many tokens, random input; nothing hangs.
const deep = "(".repeat(5000) + "IsVia" + ")".repeat(5000);
assert.match(Q.check(deep).error, /longer|nested|parts/);
assert.match(Q.check("(".repeat(60) + "IsVia" + ")".repeat(60)).error, /nested/);
assert.ok(Q.check("(".repeat(30) + "IsVia" + ")".repeat(30)).ok);
assert.match(Q.check("Not ".repeat(80) + "IsVia").error, /nested|parts/);
assert.match(Q.check("x".repeat(3000)).error, /longer/);
assert.match(Q.check(Array(310).fill("All").join("||")).error, /parts/);
assert.match(Q.check("Name = '" + "a".repeat(300) + "'").error, /Text longer/);
assert.ok(Q.check(Array(200).fill("IsVia").join(" Or ")).ok);
// A step budget stops an expensive query on a big board instead of running on.
assert.throws(() => Q.run(dp, dense, Array(120).fill("Not IsVia").join(" And "), {maxSteps:1e5}), /too costly/);
let seed = 7; const rnd = n => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n;
const atoms = ["IsVia", "IsTrack", "And", "Or", "Not", "(", ")", "'x'", "Width", "<", ">", "=", "0.2mm", "InNet(", "'GND'", ",", "Like", "'*'", "!", "&&", "||", "\"", "'", "9e999", "µm", "\u0000"];
const start = Date.now();
for (let k = 0; k < 3000; k++) {
  let s = ""; const n = rnd(40);
  for (let j = 0; j < n; j++) s += atoms[rnd(atoms.length)] + (rnd(3) ? " " : "");
  const r = Q.check(s);
  if (r.ok) Q.run(p, board, s); else assert.equal(typeof r.error, "string");
}
assert.ok(Date.now() - start < 20000, "fuzz finished in " + (Date.now() - start) + " ms");
console.log("PASS query: grammar, evaluation, rule scopes, MCP; 25k board " + ms + "/" + ms2 + " ms; 3000 fuzz cases in " + (Date.now() - start) + " ms");
