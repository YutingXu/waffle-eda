"use strict";
// Altium rule-set parity: the Clearance object-kind
// matrix in the rule model, DRC and Altium import; the added query functions; the built-in
// "All Nets" / "All Components" classes; and the warning for scopes that match nothing.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "connectivity", "stackup", "altium-rules", "rooms", "component-classes", "query", "net-intent", "signals", "rules"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const R = AtriumRules, Q = AtriumQuery, defs = new Map();
const track = (id, net, points, width = .2, layer = "Top") => ({kind:"track", id, net, points, width, layer});
const via = (id, net, x, y, diameter = .6, drill = .3) => ({kind:"via", id, net, x, y, diameter, drill, layer:"Multi"});
const pad = (id, net, x, y, w = 1, h = 1, drill = 0, layer = drill > 0 ? "Multi" : "Top") => ({kind:"pad", id, net, number:"1", x, y, w, h, shape:"rect", layer, drill});
const board = (items, extra = {}) => ({kind:"pcb", name:"Test", items, notes:[], ...extra});
function filterScope(source) {
  const result=AtriumQueryExchange.fromClassic(source);assert.ok(result.ok,source);return result.scope;
}
const withRules = (f, set = R.create()) => {const c = JSON.parse(JSON.stringify(set)); f(c); R.validate(c); return c;};
const clearance = c => c.list.find(r => r.type === "clearance");
const cl = out => out.violations.filter(v => v.type === "clearance");
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, a + " differs from " + b);

// 1. Model: the matrix is optional, sparse and validated; old sets load unchanged.
const plain = R.create();
assert.equal("objects" in clearance(plain), false, "single-value rules store no matrix");
const v1 = {format:"atrium-rules", version:1, units:"mm", defaults:{clearance:.2, trackWidth:.15, viaDrill:.3}, nets:{VBUS:{clearance:.3}}};
assert.equal(JSON.stringify(R.migrate(v1)), JSON.stringify(R.migrate(JSON.parse(JSON.stringify(v1)))));
assert.ok(R.migrate(v1).list.filter(r => r.type === "clearance").every(r => !("objects" in r)), "version 1 sets gain no matrix");
const stored = R.normalize(R.migrate(v1));
assert.equal(JSON.stringify(R.normalize(JSON.parse(JSON.stringify(stored)))), JSON.stringify(stored), "a stored version 2 set round-trips byte for byte");
const matrix = withRules(c => {clearance(c).objects = {"track-smd":.25, "smd-via":.3, "track-hole":.4};});
assert.deepEqual(clearance(R.normalize(matrix)).objects, {"track-smd":.25, "smd-via":.3, "track-hole":.4});
for (const bad of [{"smd-track":.2}, {"hole-hole":.2}, {"track-pad":.2}, {"track-via":-1}, {"track-via":"x"}, []])
  assert.throws(() => withRules(c => {clearance(c).objects = bad;}), /object kind|between 0 and 1000|map object kind/, JSON.stringify(bad));
assert.match(R.describe(clearance(matrix)), /^Clearance Constraint \(Minimum clearance=0\.2mm Track–SMDPad=0\.25mm Track–Hole=0\.4mm SMDPad–Via=0\.3mm\) \(All\),\(All\)$/);
const rule = clearance(matrix);
assert.equal(R.clearanceGap(rule, "smd", "track"), .25); assert.equal(R.clearanceGap(rule, "via", "via"), .2);
assert.equal(R.clearanceMax(rule), .4); assert.equal(R.clearanceRoute(rule), .3, "routing gap: cells with a track, arc or via, not holes");
assert.equal(R.clearanceRoute(clearance(withRules(c => {clearance(c).objects = {"smd-smd":.1};}))), .2);
const q = R.query(board([]), "clearance", {net:"A", net2:"B"}, {rules:matrix});
assert.equal(q.gap, .2); assert.equal(q.routeGap, .3); assert.equal(q.maxGap, .4); assert.deepEqual(q.objects, rule.objects);
assert.equal(R.query(board([]), "clearance", {net:"A", net2:"B"}, {rules:plain}).routeGap, .2);
// The interactive router (router.js) keeps the routing gap; its upper bound includes every cell.
try {require("../../app/pcb/router.js");} catch {/* router.js is optional for these checks */}
if (globalThis.AtriumRouter?.core?.rulesFor || globalThis.AtriumRouter?.rulesFor) {
  const rf = AtriumRouter.core?.rulesFor || AtriumRouter.rulesFor, api = rf({kind:"pcb", items:[], rules:matrix});
  assert.equal(api.clearance("A", "B", "Top"), .3); assert.equal(api.maxClearance(), .4);
  assert.equal(rf({kind:"pcb", items:[], rules:plain}).clearance("A", "B", "Top"), .2);
}

// 2. DRC: each pair of kinds uses its cell; empty cells use the rule gap.
const pair = [track("t1", "A", [[0, 0], [5, 0]]), track("t2", "B", [[0, .35], [5, .35]])]; // 0.15 mm apart
assert.equal(cl(R.drc(board(pair), defs, plain)).length, 1);
assert.equal(cl(R.drc(board(pair), defs, withRules(c => {clearance(c).objects = {"track-track":.1};}))).length, 0, "a smaller track-track cell");
const padNear = [track("t1", "A", [[0, 0], [5, 0]]), pad("p1", "B", 2, .75, 1, 1)]; // pad edge 0.15 from the track edge
let out = R.drc(board(padNear), defs, matrix);
assert.equal(cl(out).length, 1); close(cl(out)[0].required, .25); assert.deepEqual(cl(out)[0].kinds, ["track", "smd"]);
assert.equal(cl(R.drc(board(padNear), defs, withRules(c => {clearance(c).objects = {"track-smd":.1};}))).length, 0);
assert.equal(cl(R.drc(board(padNear), defs, withRules(c => {clearance(c).objects = {"track-th":.5};}))).length, 1, "an SMD pad does not use the TH cell");
const viaPad = [via("v1", "A", 0, 0), pad("p1", "B", .8, 0, .5, .5)]; // 0.25 mm edge gap
assert.equal(cl(R.drc(board(viaPad), defs, plain)).length, 0);
assert.equal(cl(R.drc(board(viaPad), defs, matrix)).length, 1, "the SMD pad to via cell is 0.3 mm");
// Holes: checked only where a hole cell is set; the hole's own pad is skipped.
const npth = [pad("h1", "", 0, 0, 1, 1, 1), track("t1", "A", [[-2, .7], [2, .7]])]; // NPTH hole edge 0.1 mm from the track edge
assert.equal(cl(R.drc(board(npth), defs, plain)).length, 0, "no hole cell, no hole check");
assert.equal(cl(R.drc(board(npth), defs, withRules(c => {clearance(c).objects = {"track-hole":.05};}))).length, 0);
out = R.drc(board(npth), defs, withRules(c => {clearance(c).objects = {"track-hole":.15};}));
assert.equal(cl(out).length, 1); assert.equal(cl(out)[0].what, "Hole clearance"); close(cl(out)[0].actual, .1);
assert.equal(cl(R.drc(board([pad("h1", "A", 0, 0, 1.6, 1.6, 1)]), defs, withRules(c => {clearance(c).objects = {"th-hole":5};}))).length, 0, "a pad's own hole is not checked against its copper");
{
  const options = {types:["clearance"], checkMode:"batch"};
  const crossing = track("overlap", "B", [[0, .05], [5, .05]]);
  const tracks = [pair[0], crossing];
  const zero = withRules(c => {clearance(c).gap = 0;});
  const zeroMatrix = withRules(c => Object.assign(clearance(c),
    {gap:0, objects:{"track-track":0, "track-hole":0, "track-poly":0}}));
  require("../../app/pcb/pcb-draw.js");
  const doc = board([...tracks, npth[0],
    track("unassigned", "", [[0, 3], [5, 3]]),
    {id:"stale", kind:"graphic", teardrop:true, teardropTrack:"removed", net:"A",
      layer:"Top", closed:true, fill:true, points:[[8, 0], [9, 0], [8, 1]]}
  ], {ruleCheckSelection:{batch:[]}});
  const keepout = AtriumPCBDraw.place(doc, {type:"keepout", shape:"fill", a:[2,-1], b:[3,1]});
  doc.items.push(keepout);
  for (const rules of [zero, zeroMatrix]) {
    const result = R.drc(doc, defs, rules, options);
    assert.equal(result.stats.candidates, 0, "zero clearance runs no copper or hole neighborhood scan");
    assert.ok(result.violations.some(v => v.id === "stale" && v.what === "Stale teardrop"));
    assert.ok(result.violations.some(v => v.otherId === keepout.id), "the keepout still flags touching copper");
    assert.ok(result.notes.some(n => n.includes("imported Altium batch")));
    assert.ok(result.notes.some(n => n.includes("without a net")));
    assert.equal(result.notes.some(n => n.includes("matrix cells for polygons")), rules === zeroMatrix);
    assert.equal(result.rules.find(r => r.type === "clearance").count, result.total);
  }
  const short = R.drc(board(tracks), defs, zero, {types:["clearance", "short"]});
  assert.equal(short.violations.filter(v => v.type === "short").length, 1, "electrical shorts remain independent of zero clearance");
  const copper = withRules(c => Object.assign(clearance(c), {gap:0, objects:{"track-track":.2}}));
  const hole = withRules(c => Object.assign(clearance(c), {gap:0, objects:{"track-hole":.15}}));
  assert.deepEqual(cl(R.drc(board(pair), defs, copper, options)).map(v => v.required), [.2], "a positive copper cell wins over the base zero");
  const holeResult = R.drc(board(npth), defs, hole, options);
  assert.deepEqual(cl(holeResult).map(v => v.what), ["Hole clearance"], "a positive hole cell wins over the base zero");
  close(cl(holeResult)[0].actual, .1);
  const measured = withRules(c => {
    clearance(c).scope = AtriumDesignQueryRecord.create("track where width < rule(MinWidth)");
    c.list = [clearance(c)];
  }, zero);
  const needed = R.drc(board(tracks), defs, measured, options);
  assert.equal(needed.complete, false, "required measurement diagnostics still appear at zero gap");
  assert.equal(needed.diagnostics[0].code, "measurement");
  assert.equal(R.kit.needsClearancePairs([{gap:0, objects:null}]), false);
  assert.equal(R.kit.needsClearancePairs([{gap:0, objects:{"track-track":0}}]), false);
  const ownCell = Object.defineProperty({}, "track-hole", {value:.25});
  assert.equal(R.kit.needsClearancePairs([{gap:0, objects:ownCell}]), true, "every own matrix cell can override the base gap");
  for (const invalid of [{gap:NaN}, {gap:Infinity}, {gap:-1}, {gap:"0"}, {gap:null}, {gap:0, objects:[]},
    {gap:0, objects:{"track-hole":NaN}}, {gap:0, objects:{"track-hole":null}}, {gap:0, objects:{"bad-pair":0}}]) {
    assert.equal(R.kit.needsClearancePairs([invalid]), true, "unknown thresholds conservatively retain pair checks");
  }
}
// Scoped rules each keep their own matrix.
const scoped = withRules(c => {
  c.netClasses = {HV:["A"]};
  c.list.push({id:"hv", type:"clearance", name:"HV", comment:"", enabled:true, priority:1, scope:AtriumDesignQueryRecord.selector("netclass","HV"), scope2:AtriumDesignQueryRecord.selector("all"), gap:.1, objects:{"track-track":.3}});
  clearance(c).priority = 2;
});
out = R.drc(board(pair), defs, scoped);
assert.equal(cl(out).length, 1); assert.equal(cl(out)[0].ruleName, "HV"); close(cl(out)[0].required, .3);

// 3. Altium import: OBJECTCLEARANCES cells (1/10000 mil) become matrix cells.
const altium = "RULEKIND=Clearance|NETSCOPE=DifferentNets|LAYERKIND=SameLayer|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|NAME=Clearance|ENABLED=TRUE|PRIORITY=1|GAP=5mil|GENERICCLEARANCE=5mil|IGNOREPADTOPADCLEARANCEINFOOTPRINT=FALSE|OBJECTCLEARANCES=ClearanceObj_Arc-ClearanceObj_Hole:98425;ClearanceObj_Track-ClearanceObj_Hole:98425;ClearanceObj_SMDPad-ClearanceObj_Hole:98425;ClearanceObj_THPad-ClearanceObj_Hole:98425;ClearanceObj_Via-ClearanceObj_Hole:98425;ClearanceObj_Fill-ClearanceObj_Hole:98425;ClearanceObj_Poly-ClearanceObj_Hole:98425;ClearanceObj_Region-ClearanceObj_Hole:98425;ClearanceObj_Text-ClearanceObj_Hole:98425;ClearanceObj_SMDPad-ClearanceObj_Track:40000;ClearanceObj_Via-ClearanceObj_Via:50000";
let conv = R.fromAltium(altium);
assert.ok(conv.rule, conv.reason); assert.equal(conv.rule.gap, .127);
assert.deepEqual(conv.rule.objects, {"arc-hole":.25, "track-hole":.25, "smd-hole":.25, "th-hole":.25, "via-hole":.25, "fill-hole":.25, "poly-hole":.25, "region-hole":.25, "text-hole":.25, "track-smd":.1016});
assert.equal(conv.warning, undefined);
conv = R.fromAltium(altium.replace("OBJECTCLEARANCES=", "OBJECTCLEARANCES=ClearanceObj_Wire-ClearanceObj_Hole:1;"));
assert.ok(conv.rule); assert.match(conv.warning, /not read: ClearanceObj_Wire/);
assert.equal(R.fromAltium(altium.replace(/OBJECTCLEARANCES=[^|]*/, "OBJECTCLEARANCES=  ")).rule.objects, null, "an empty matrix is single-value");
// The real-world compound scopes from an Altium board now parse (OnMid, OnOutside, OnMultiLayer, InPolygon, IsTeardrop).
for (const s of ["not InNetClass('PRIMARY') and (OnMid or OnMultiLayer)", "InNetClass('PRIMARY') and (OnOutside or OnMultiLayer)", "NOT (IsPad or IsVia or IsTeardrop or InPolygon or IsRegion)"])
  assert.ok(R.fromAltium(altium.replace("SCOPE2EXPRESSION=All", "SCOPE2EXPRESSION=" + s)).rule, s);

// 4. Query functions on design objects.
const p = AtriumParts.example(), pcb = p.documents[1];
const run = (doc, text) => Q.run(p, doc, text);
for (const text of ["IsSMDPad", "IsTHPad", "InAnyNet", "OnSignal", "OnMid", "OnOutside", "OnMultiLayer", "IsDiffPair", "InPolygon", "IsTeardrop",
  "InNamedPolygon('GND pour')", "InRoom('Power')", "HasPad('1')", "HasPad('U1', '3')", "InNetClass('All Nets')", "InComponentClass('All Components')"])
  assert.ok(Q.check(text).ok, text + ": " + Q.check(text).error);
assert.equal(Q.check("HasPad('U1', '3')").normalized, "HasPad('U1', '3')");
assert.match(Q.check("HasPad('a','b','c')").error, /1 to 2 arguments/); assert.match(Q.check("InRoom('a','b')").error, /one argument/);
const parts = pcb.items.filter(i => i.kind === "part");
assert.equal(run(pcb, "InComponentClass('All Components') And IsComponent").ids.length, parts.length, "All Components matches every component");
const netted = pcb.items.filter(i => i.net).length;
assert.equal(run(pcb, "InNetClass('All Nets')").ids.length, netted, "All Nets matches every object with a net");
assert.equal(run(pcb, "InAnyNet").ids.length, netted);
const smd = run(pcb, "IsSMDPad"), th = run(pcb, "IsTHPad");
assert.ok(smd.subs.length > 0 && smd.subs.every(s => !(s.drill > 0)));
assert.ok(th.subs.every(s => s.drill > 0));
assert.equal(smd.subs.length + th.subs.length, run(pcb, "IsPad").subs.length);
const u1 = parts.find(i => i.ref === "U1");
assert.deepEqual(run(pcb, "HasPad('U1', '3')").subs.map(s => s.id), [u1.id + "/3"]);
assert.ok(run(pcb, "HasPad('1') And IsComponent").ids.length === parts.length, "every part has a pad 1");
// Rooms, polygons, layer groups and pairs on a small board.
const room = {id:"room1", name:"Power", points:[[0, 0], [10, 0], [10, 10], [0, 10]]};
const b2 = board([track("in", "A", [[1, 1], [2, 2]]), track("out", "A", [[1, 1], [20, 2]]), track("mid", "B", [[1, 1], [2, 1]], .2, "Inner 1"),
  via("v", "B", 3, 3), {kind:"polygon", id:"poly", name:"GND pour", net:"GND", layer:"Top", points:[[0, 0], [4, 0], [4, 4]]},
  {kind:"graphic", id:"tear", teardrop:true, fill:true, closed:true, net:"A", layer:"Top", points:[[0, 0], [1, 0], [0, 1]]}], {rooms:[room]});
const p2 = {documents:[b2], library:[]};
R.store(b2, p2, withRules(c => {c.diffPairs = [{name:"D", positive:"A", negative:"B"}];}));  // the pair goes to the signal model
const ids2 = text => Q.run(p2, b2, text).ids.sort();
assert.deepEqual(ids2("InRoom('power')"), ["in", "mid", "poly", "tear", "v"].sort());
assert.deepEqual(ids2("InPolygon"), ["poly"]); assert.deepEqual(ids2("InNamedPolygon('GND POUR')"), ["poly"]); assert.deepEqual(ids2("InNamedPolygon('Other')"), []);
assert.deepEqual(ids2("IsTeardrop"), ["tear"]); assert.deepEqual(ids2("OnMid"), ["mid"]); assert.deepEqual(ids2("OnMultiLayer"), ["v"]);
assert.deepEqual(ids2("OnOutside And IsTrack"), ["in", "out"]); assert.deepEqual(ids2("IsDiffPair And IsTrack"), ["in", "mid", "out"]);
assert.deepEqual(ids2("OnSignal And Not IsPolygon"), ["in", "mid", "out", "tear", "v"]);

// 5. The same functions in rule scopes (DRC objects carry their kind).
const scopedBy = (s1, s2 = AtriumDesignQueryRecord.selector("all")) => withRules(c => {Object.assign(clearance(c), {scope:s1, scope2:s2});});
const mixed = [track("t1", "A", [[0, 0], [5, 0]]), track("t2", "B", [[0, .35], [5, .35]]), via("v1", "C", 10, 0), pad("p1", "D", 10.7, 0, .5, .5)]; // via to pad 0.15 mm
assert.equal(cl(R.drc(board(mixed), defs, scopedBy(filterScope("IsSMDPad")))).length, 1, "IsSMDPad scopes only the pad pair");
assert.equal(cl(R.drc(board(mixed), defs, scopedBy(filterScope("IsVia"), filterScope("IsPad")))).length, 1);
assert.equal(cl(R.drc(board(mixed), defs, scopedBy(filterScope("IsTrack"), filterScope("IsTrack")))).length, 1);
assert.equal(cl(R.drc(board(mixed), defs, scopedBy(filterScope("InNetClass('All Nets')")))).length, 2);
assert.equal(cl(R.drc(board(mixed), defs, scopedBy(AtriumDesignQueryRecord.selector("netclass","All Nets")))).length, 2, "the built-in class as a scope kind");
const roomBoard = board(mixed, {rooms:[{id:"r", name:"Left", points:[[-1, -1], [6, -1], [6, 1], [-1, 1]]}]});
assert.equal(cl(R.drc(roomBoard, defs, scopedBy(filterScope("InRoom('Left')")))).length, 1);
const hasPad = scopedBy(filterScope("HasPad('1')"));
assert.equal(cl(R.drc(board(mixed), defs, hasPad)).length, 1, "HasPad matches pad 1");

// 6. Scopes that match nothing: a DRC note and AtriumRules.scopeCoverage.
const ghost = withRules(c => {c.list.push({id:"g", type:"width", name:"Ghost", comment:"", enabled:true, priority:1, scope:AtriumDesignQueryRecord.selector("netclass","Nope"), min:.1, max:null, preferred:null});});
out = R.drc(board(mixed), defs, ghost);
assert.equal(out.emptyScopes.length, 1); assert.equal(out.emptyScopes[0].name, "Ghost");
assert.ok(out.notes.some(n => /Width rule Ghost: the first scope object in class "Nope" matches no objects/.test(n)), out.notes.join("\n"));
assert.deepEqual(R.scopeCoverage(board(mixed), defs, {rules:ghost}).map(e => [e.id, e.which]), [["g", "scope"]]);
assert.deepEqual(R.drc(board(mixed), defs, plain).emptyScopes, [], "All scopes are never reported");
assert.deepEqual(R.drc(board(mixed), defs, ghost, {types:["width"]}).emptyScopes, [], "partial (online) runs skip the coverage check");
assert.equal(R.scopeCoverage(board(mixed), defs, {rules:scopedBy(filterScope("InNamedPolygon('X')"))})[0].query, filterScope("InNamedPolygon('X')").source);
assert.deepEqual(R.scopeCoverage(board(mixed), defs, {rules:scopedBy(filterScope("InNetClass('All Nets')"), AtriumDesignQueryRecord.selector("componentclass","All Components"))}).map(e => e.which), ["scope2"], "no components on this board");

console.log("PASS Altium parity: clearance object-kind matrix (model, DRC, holes, routing gap, import), query functions, built-in classes, empty-scope warnings");
