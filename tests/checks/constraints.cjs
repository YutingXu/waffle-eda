"use strict";
// Constraint Manager: rows and live pass/fail per tab, cell edits writing scoped rules,
// ECSet templates, the spacing matrix, CSV, the MCP op and speed on a 25k-object board.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "stackup", "impedance", "altium-rules", "net-intent", "signals", "rules", "length-tuning", "dfa", "constraints"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const R = AtriumRules, K = AtriumConstraints, S = AtriumStackup;
const close = (a, b, m) => assert.ok(Math.abs(a - b) < 1e-4, (m || "") + " " + a + " differs from " + b);

const track = (id, net, layer, width, points) => ({id, kind: "track", net, layer, width, points});
const via = (id, net, x, y) => ({id, kind: "via", net, x, y, diameter: .6, drill: .3, layer: "Multi"});
const doc = {kind: "pcb", id: "b", name: "Board", outline: [[0, 0], [60, 0], [60, 40], [0, 40]], stackup: {version: 1, layers: S.preset("4").layers}, items: [
  track("t1", "CLK", "Top", .2, [[0, 0], [10, 0]]), track("t2", "CLK", "Bottom", .12, [[10, 0], [20, 0]]), via("v1", "CLK", 10, 0),
  track("t3", "D0", "Top", .2, [[0, 5], [30, 5]]),
  track("p1", "USB_P", "Top", .15, [[0, 10], [20, 10]]), track("n1", "USB_N", "Top", .15, [[0, 10.3], [12, 10.3], [12, 14], [20, 14]]),
  track("g1", "GND", "Top", .5, [[0, 20], [5, 20]])]};
const rules = R.create();
rules.netClasses = {Fast: ["CLK", "D0"]};
rules.diffPairs = [{name: "USB", positive: "USB_P", negative: "USB_N"}];
rules.list.push({id: "len-1", type: "length", name: "Length_Fast", comment: "", enabled: true, priority: 1, scope: {kind: "netclass", value: "Fast"}, min: 25, max: 40},
  {id: "dp-1", type: "diffPairsRouting", name: "DP", comment: "", enabled: true, priority: 1, scope: {kind: "all"}, widthMin: .1, widthPreferred: .15, widthMax: .3, gapMin: .1, gapPreferred: .15, gapMax: .2, maxUncoupled: 3, layers: {}},
  {id: "ml-1", type: "matchedLengths", name: "Match_Fast", comment: "", enabled: true, priority: 1, scope: {kind: "netclass", value: "Fast"}, tolerance: .5, withinPair: false, pairTolerance: .127});
const project = {name: "P", library: [], documents: [doc]}, defs = new Map();
R.store(doc, project, rules);   // the rule book; the classes and the pair go to the signal model
// The model under other rules: a copy of the project whose book holds them.
const withRules = set => { const q = JSON.parse(JSON.stringify(project)); R.store(q.documents[0], q, set); return q; };

// ---- nets ------------------------------------------------------------------------------------
let M = K.model(project, doc, defs);
const nets = M.rows("nets");
assert.deepEqual(nets.map(r => r.name), ["CLK", "D0", "GND", "USB_N", "USB_P"]);
const clk = M.metrics("nets", nets[0]);
close(clk.cells.length, 20 + R.netLengths(doc, defs).get("CLK").viaLength, "CLK length matches the DRC length");
assert.equal(clk.cells.vias, 1);
assert.equal(clk.cells.widthActual, "0.12–0.2");
assert.equal(clk.cells.lengthMin, 25); assert.equal(clk.cells.lengthMax, 40);
assert.equal(clk.cells.classes, "Fast");
assert.ok(clk.cells.delay > 20 * 5 && clk.cells.delay < 30 * 8, "delay from the stack-up " + clk.cells.delay);
assert.equal(clk.status, "fail");
assert.ok(clk.fails.has("length") && clk.fails.has("widthActual"), [...clk.fails].join());
const d0 = M.metrics("nets", nets[1]);
assert.equal(d0.status, "pass", [...d0.fails].join());
assert.equal(M.metrics("nets", nets[2]).status, "pass", "GND passes the default width rule");

// ---- edits write scoped rules (one change each) ---------------------------------------------------
let set = JSON.parse(JSON.stringify(R.effective(doc, project)));
const msg = K.setCell(set, "nets", nets[0], "lengthMin", 15, M);
assert.match(msg, /Length_CLK/);
let next = R.validate(R.normalize(set));
const own = next.list.find(r => r.type === "length" && r.scope.source === 'object where net.name = "CLK"');
assert.equal(own.min, 15); assert.equal(own.max, 40, "an override starts from the effective rule");
assert.equal(own.priority, 1, "overrides go first");
R.store(doc, project, next);
M = K.model(project, doc, defs);
assert.ok(!M.metrics("nets", M.rows("nets")[0]).fails.has("length"), "CLK now meets its length");
// Editing the same net again updates its rule instead of adding another.
set = JSON.parse(JSON.stringify(R.effective(doc, project)));
K.setCell(set, "nets", M.rows("nets")[0], "lengthMax", 30, M);
assert.equal(set.list.filter(r => r.type === "length" && r.scope.source === 'object where net.name = "CLK"').length, 1);
// Width min on the class; blank clears an optional max.
set = JSON.parse(JSON.stringify(R.effective(doc, project)));
K.setCell(set, "classes", M.rows("classes")[0], "widthMin", .1, M);
K.setCell(set, "classes", M.rows("classes")[0], "widthMax", null, M);
next = R.validate(R.normalize(set));
const cw = next.list.find(r => r.type === "width" && AtriumDesignQueryRecord.toSelector(r.scope)?.kind === "netclass");
assert.equal(cw.min, .1); assert.equal(cw.max, null);
assert.throws(() => K.setCell(set, "nets", M.rows("nets")[0], "length", 3, M), /not editable/);
assert.throws(() => K.setCell(set, "nets", M.rows("nets")[0], "widthMin", null, M), /needs a value/);
assert.equal(K.parseValue(K.COLUMNS.nets.find(c => c.key === "widthMin"), "8 mil"), .2032);
// A range error is reported by the rules engine.
set = JSON.parse(JSON.stringify(R.effective(doc, project)));
K.setCell(set, "nets", M.rows("nets")[1], "lengthMin", 50, M);
assert.throws(() => R.validate(R.normalize(set)), /must not be less/);

// ---- classes, pairs, groups, physical ----------------------------------------------------------
const fast = M.metrics("classes", M.rows("classes")[0]);
assert.equal(fast.cells.members, 2);
close(fast.cells.spread, Math.abs(M.metrics("nets", M.rows("nets")[0]).cells.length - 30));
const pairs = M.rows("pairs");
assert.equal(pairs.length, 1);
const usb = M.metrics("pairs", pairs[0]);
usb.heavy();
close(usb.cells.skew, Math.abs(20 - (12 + 3.7 + 8)), "skew");
assert.ok(usb.cells.uncoupled > 3, "N leaves the pair for ~11 mm: " + usb.cells.uncoupled);
assert.ok(usb.fails.has("uncoupled"));
assert.ok(Math.abs(usb.cells.gapActual - .15) < .01, "coupled gap " + usb.cells.gapActual);
set = JSON.parse(JSON.stringify(R.effective(doc, project)));
K.setCell(set, "pairs", pairs[0], "maxUncoupled", 20, M);
K.setCell(set, "pairs", pairs[0], "skewMax", .1, M);
next = R.validate(R.normalize(set));
assert.equal(next.list.find(r => r.type === "diffPairsRouting" && AtriumDesignQueryRecord.toSelector(r.scope)?.kind === "diffpair").maxUncoupled, 20);
const ml = next.list.find(r => r.type === "matchedLengths" && AtriumDesignQueryRecord.toSelector(r.scope)?.kind === "diffpair");
assert.ok(ml.withinPair && ml.pairTolerance === .1);
const groups = M.rows("groups");
assert.ok(groups.some(g => g.name === "Match_Fast"), groups.map(g => g.name).join());
const gm = M.metrics("groups", groups.find(g => g.name === "Match_Fast"));
assert.equal(gm.status, "fail", "CLK and D0 differ by more than 0.5 mm");
set = JSON.parse(JSON.stringify(R.effective(doc, project)));
K.setCell(set, "groups", groups.find(g => g.name === "Match_Fast"), "tolerance", 20, M);
assert.equal(R.validate(R.normalize(set)).list.find(r => r.id === "ml-1").tolerance, 20);
const phys = M.rows("physical");
assert.deepEqual(phys.map(r => r.name).slice(0, 2), ["All", "Fast"]);
assert.ok(phys.some(r => r.layer === "Bottom"));
const top = M.metrics("physical", phys.find(r => r.layer === "Top")); top.heavy();
assert.equal(top.cells.tracks, 5); close(top.cells.narrowest, .15);
const all = M.metrics("physical", phys[0]); all.heavy();
assert.equal(all.cells.violations, 1, "the 0.12 mm CLK track breaks the 0.15 mm default");
set = JSON.parse(JSON.stringify(R.effective(doc, project)));
K.setCell(set, "physical", phys.find(r => r.layer === "Bottom"), "widthMin", .1, M);
assert.ok(R.validate(R.normalize(set)).list.some(r => r.type === "width" && r.scope.source === 'object on layer "Bottom"' && r.min === .1));

// ---- spacing matrix ------------------------------------------------------------------------------
const sp = M.spacing();
assert.deepEqual(sp.names, ["All", "Fast"]);
assert.equal(sp.cell("All", "All").own, true);
assert.equal(sp.cell("Fast", "All").own, false);
set = JSON.parse(JSON.stringify(R.effective(doc, project)));
K.setSpacing(set, "Fast", "All", .3);
next = R.validate(R.normalize(set));
const cr = next.list.find(r => r.type === "clearance" && AtriumDesignQueryRecord.toSelector(r.scope)?.kind === "netclass");
assert.equal(cr.gap, .3); assert.deepEqual(cr.scope2, {languageVersion:1,source:"object"});
assert.equal((q => K.model(q, q.documents[0], defs))(withRules(next)).spacing().cell("All", "Fast").gap, .3, "symmetric lookup");

// ---- DFA through the manager ---------------------------------------------------------------------
set = JSON.parse(JSON.stringify(R.effective(doc, project)));
K.setDfa(set, {a: "0402", b: "bga", gap: 1.5});
next = R.validate(R.normalize(set));
const dr = next.list.find(r => r.type === "dfaSpacing");
assert.ok(dr.matrix.some(e => e.a === "0402" && e.b === "bga" && e.gap === 1.5));

// ---- templates (ECSets) ------------------------------------------------------------------------
set = JSON.parse(JSON.stringify(R.effective(doc, project)));
const made = K.createTemplate(set, "DDR_DQ", {net: "D0"}, M);
assert.ok(made.rules.some(n => /Length/.test(n)), made.rules.join());
const ap = K.applyTemplate(set, "DDR_DQ", ["CLK", "GND", "D0"]);
assert.equal(ap.added, 2); assert.equal(ap.members, 3);
next = R.validate(R.normalize(set));
assert.deepEqual(K.templates(next).map(t => [t.name, t.kind, t.members.length]), [["DDR_DQ", "net", 3]]);
const tq = withRules(next), tm = K.model(tq, tq.documents[0], defs);
assert.equal(tm.metrics("nets", tm.rows("nets").find(r => r.name === "GND")).cells.lengthMin, 25, "GND follows the template's length");
assert.throws(() => K.createTemplate(set, "DDR_DQ", {net: "CLK"}, M), /already named/);
const pt = K.createTemplate(set, "USB2", {pair: "USB"}, M);
assert.ok(pt.rules.length >= 1);
assert.equal(K.templates(R.normalize(set)).find(t => t.name === "USB2").kind, "pair");
assert.throws(() => K.applyTemplate(set, "USB2", ["NOPE"]), /No differential pair/);

// ---- CSV -------------------------------------------------------------------------------------------
const text = K.csv(M, "nets", {keys: ["name", "status", "length", "lengthMin"]});
const lines = text.trim().split("\r\n");
assert.equal(lines[0], "Net,Status,Length (mm),Length min (mm)");
assert.match(lines[1], /^CLK,fail,21\.545,15$/, lines[1]); // 20 mm + the via barrel Top copper centre to Bottom copper centre (1.545 mm; was the whole 1.6003 mm stack with mask)
assert.match(K.csv(M, "spacing"), /^,All,Fast\r\n/);

// ---- MCP op ------------------------------------------------------------------------------------
let work = JSON.parse(JSON.stringify(project));
const H = {project: () => work, mutable: () => work, board: (p, id) => p.documents.find(d => d.kind === "pcb" && (id == null || d.id === id)), defsOf: () => defs,
  touched: () => {}, page: (items, a) => ({items: items.slice(a.offset || 0, (a.offset || 0) + (a.limit || 50)), total: items.length})};
const listed = K.headless({action: "list", tab: "nets", failing_only: true}, H);
assert.ok(listed.items.every(r => r.status === "fail"));
assert.ok(listed.columns.find(c => c.key === "lengthMin").editable);
const ch = K.headless({action: "set", tab: "nets", name: "D0", key: "widthMin", value: "0.18"}, H);
assert.match(ch.applied[0], /Width_D0/);
assert.ok(R.stored(work.documents[0], work).list.some(r => r.type === "width" && r.scope.source === 'object where net.name = "D0"' && r.min === .18));
K.headless({action: "apply_template", template: "Sig", create_from: {net: "D0"}, members: ["CLK"]}, H);
assert.deepEqual(K.headless({action: "list", tab: "templates"}, H).items.map(t => t.name), ["Sig"]);
assert.equal(K.headless({action: "list", tab: "spacing"}, H).classes[0], "All");
K.headless({action: "set", changes: [{tab: "dfa", name: "0402", other: "0402", value: .3}]}, H);
assert.equal(K.headless({action: "list", tab: "dfa"}, H).rule.matrix.find(e => e.a === "0402" && e.b === "0402").gap, .3);
assert.throws(() => K.headless({action: "set", tab: "nets", name: "NOPE", key: "widthMin", value: 1}, H), /No nets row/);

// ---- speed: 25 600 objects, 3 000 nets ------------------------------------------------------------
require("../pcb/dense-board.js");
const bench = makeAtriumBenchmarkBoard(160);
let n = 0;
for (const i of bench.d.items) if (i.kind === "track" || i.kind === "via") i.net = "SIG" + (n++ % 3000);
const bp = {name: "Bench", library: AtriumParts.catalogue, documents: [bench.d]};
const t0 = Date.now(), BM = K.model(bp, bench.d, bench.defs), rows = BM.rows("nets");
const tRows = Date.now() - t0;
const t1 = Date.now(); for (const r of rows.slice(0, 40)) { const m = BM.metrics("nets", r); m.heavy?.(); }
const tVisible = Date.now() - t1;
const t2 = Date.now(); for (const r of rows) BM.metrics("nets", r);
const tAll = Date.now() - t2;
assert.equal(rows.length, 3000);
assert.ok(tRows < 800, "rows " + tRows + " ms");
assert.ok(tVisible < 300, "40 visible rows " + tVisible + " ms");
assert.ok(tAll < 3000, "all 3000 rows " + tAll + " ms");
const tp = Date.now(), ph = BM.rows("physical"); for (const r of ph) BM.metrics("physical", r).heavy(); const tPhys = Date.now() - tp;
assert.ok(tPhys < 2000, "physical " + tPhys + " ms");
console.log("constraints: nets, classes, pairs, groups, physical, spacing, templates, CSV, MCP OK; 25.6k objects: index+rows " + tRows + " ms, 40 rows " + tVisible + " ms, all 3000 " + tAll + " ms, physical " + tPhys + " ms");
