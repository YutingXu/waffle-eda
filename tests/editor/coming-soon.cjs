"use strict";
// Altium "coming soon" parity: board rule sets (rule-groups.js +
// rules.js), Z-axis clearance over polygon pours (z-clearance.js). Fixtures: synthetic, built here.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-appearance", "pcb-pours", "polygon-pour", "stackup", "connectivity", "altium-rules", "rules", "viastack", "fab-presets", "fab-presets/jlcpcb", "fab-profiles", "rule-sets", "rule-groups",
  "z-clearance", "drc", "router", "board-shape", "via-fence", "impedance", "rigid-flex", "si", "return-path", "related-parts"])
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, R = AtriumRules, G = AtriumRuleGroups, RS = AtriumRuleSets, Z = AtriumZClearance, S = AtriumStackup;
const scope = AtriumDesignQueryRecord.selector;

// ---------------------------------------------------------------- board rule sets
const track = (id, net, points, layer = "Top", width = .2) => ({kind: "track", id, net, points, width, layer});
// Two parallel tracks 0.25 mm apart (edge to edge).
const items = [track("a", "A", [[0, 0], [10, 0]]), track("b", "B", [[0, .45], [10, .45]])];
const board = rules => ({kind: "pcb", id: "pcb1", name: "Board", items: JSON.parse(JSON.stringify(items)), notes: [], outline: [[-5, -5], [15, -5], [15, 5], [-5, 5]], rules});
const clearanceOf = out => out.violations.filter(v => v.type === "clearance");
{
  // A board without sets behaves exactly as before: no ruleSet on violations or summaries.
  const plainRules = R.create();
  plainRules.list.find(r => r.type === "clearance").gap = .3;
  const out = R.drc(board(plainRules), new Map(), plainRules);
  assert.equal(clearanceOf(out).length, 1);
  assert.ok(!("ruleSet" in clearanceOf(out)[0]) && !out.rules.some(r => "ruleSet" in r), "no rule set keys on boards without sets");
  assert.ok(!("ruleSets" in R.normalize(plainRules)));
  assert.deepEqual(G.list(plainRules).map(s => [s.name, s.enabled]), [["Default", true]]);

  // Create a set, move a stricter clearance rule into it, priorities stay global.
  const doc = board(), project = {documents: [doc]};
  delete doc.rules; R.store(doc, project, plainRules);
  const cur = () => R.stored(doc, project);
  const tightId = A.id();
  G.edit(doc, project, r => {
    G.create(r, "Tight");
    r.list.push({id: tightId, type: "clearance", name: "Tight clearance", comment: "", enabled: true, priority: 99, scope: scope("all"), scope2: scope("all"), gap: .4});
    G.assign(r, [tightId], "Tight");
  });
  R.validate(cur());
  assert.deepEqual(G.list(cur()).map(s => [s.name, s.enabled, s.count]), [["Default", true, cur().list.length - 1], ["Tight", true, 1]]);
  const both = R.drc(doc, new Map(), cur()), hit = clearanceOf(both);
  assert.equal(hit.length, 1);
  // The board default (priority 1) wins over the Tight rule (priority 2) while both sets are on.
  assert.equal(hit[0].ruleName, "Clearance");
  assert.equal(hit[0].ruleSet, "Default");
  assert.equal(both.rules.find(r => r.id === tightId).ruleSet, "Tight");
  // Disabling Default leaves Tight: its rule now applies.
  G.edit(doc, project, r => G.setEnabled(r, "Default", false));
  const tight = clearanceOf(R.drc(doc, new Map(), cur()));
  assert.equal(tight.length, 1);
  assert.equal(tight[0].ruleId, tightId);
  assert.equal(tight[0].ruleName, "Tight clearance");
  assert.equal(tight[0].ruleSet, "Tight");
  assert.equal(tight[0].required, .4);
  assert.equal(R.compiled(doc, {rules: cur()}).first("clearance", {net: "A"}).name, "Tight clearance", "routers see only enabled sets");
  // Disabling every set: nothing is checked.
  G.edit(doc, project, r => G.setEnabled(r, "Tight", false));
  assert.equal(clearanceOf(R.drc(doc, new Map(), cur())).length, 0);
  assert.ok(!R.drc(doc, new Map(), cur()).rules.some(r => r.type === "clearance"), "disabled sets drop out of the summary");
  G.edit(doc, project, r => { G.setEnabled(r, "Tight", true); G.setEnabled(r, "Default", true); });

  // Duplicate: a disabled copy with new ids and names; enable it and the original keeps priority.
  G.edit(doc, project, r => G.duplicate(r, "Tight", "Tight B"));
  const copy = cur().list.filter(r => r.set === "Tight B");
  assert.equal(copy.length, 1);
  assert.ok(AtriumUUID.isV7(copy[0].id));
  assert.notEqual(copy[0].id, tightId);
  assert.equal(copy[0].name, "Tight clearance (Tight B)");
  assert.equal(G.list(cur()).find(s => s.name === "Tight B").enabled, false);
  // Rename keeps membership; delete moves rules to Default (or drops them).
  G.edit(doc, project, r => G.rename(r, "Tight B", "Tight 2"));
  assert.equal(cur().list.filter(r => r.set === "Tight 2").length, 1);
  assert.throws(() => G.edit(doc, project, r => G.rename(r, "Default", "Other")), /keeps its name/);
  assert.throws(() => G.edit(doc, project, r => G.remove(r, "Default")), /cannot be deleted/);
  assert.throws(() => G.edit(doc, project, r => G.create(r, "tight")), /already exists/);
  G.edit(doc, project, r => G.remove(r, "Tight 2"));
  assert.ok(!cur().list.some(r => /Tight 2|Tight B/.test(r.name)) && !G.list(cur()).some(s => s.name === "Tight 2"));

  // Export and import (rule set file format, shared with library sets).
  const text = G.exportText(cur(), ["Tight"]);
  const file = JSON.parse(text);
  assert.equal(file.format, "atrium-rule-set");
  assert.equal(file.name, "Tight");
  assert.equal(file.source, "board-rule-set");
  assert.equal(file.rules.list[0].id, tightId);
  assert.deepEqual(file.rules.list.map(r => r.name), ["Tight clearance"]);
  assert.ok(!file.rules.list.some(r => "set" in r), "exported rules carry no board set");
  const other = board(), op = {documents: [other]};
  delete other.rules;
  const oth = () => R.stored(other, op);
  const got = G.edit(other, op, r => G.importText(r, text, "Tight.waffle-rules.json"));
  assert.equal(got[0].set.name, "Tight");
  assert.equal(oth().list.find(r => r.set === "Tight").gap, .4);
  // Importing it again makes a second set with unique names.
  G.edit(other, op, r => G.importText(r, text));
  assert.deepEqual(G.list(oth()).map(s => s.name), ["Default", "Tight", "Tight 2"]);
  assert.equal(new Set(oth().list.map(r => r.name.toLowerCase())).size, oth().list.length);
  // A library starter set added to the board as its own set.
  const lib = RS.get({}, "JLC 2-layer");
  const added = G.edit(other, op, r => G.addSet(r, lib, {enabled: false}));
  assert.ok(added.rules > 3);
  assert.equal(G.list(oth()).find(s => s.name === "JLC 2-layer").enabled, false);

  // Validation: undefined sets, duplicate names and bad fields are refused; normalize repairs.
  const bad = R.normalize(R.create());
  bad.list[0].set = "Nope";
  bad.ruleSets = [{name: "Default", enabled: true}];
  assert.throws(() => R.validate(bad), /does not define|do not define/);
  assert.throws(() => R.validate({...R.normalize(R.create()), ruleSets: [{name: "X", enabled: true}, {name: "x", enabled: true}]}), /unique/);
  assert.throws(() => R.validate({...R.normalize(R.create()), ruleSets: [{name: "X", enabled: "yes"}]}));
  const repaired = R.normalize(bad);
  assert.ok(repaired.ruleSets.some(s => s.name === "Nope" && s.enabled));
  R.validate(repaired);

  // The project validates and survives a JSON round trip; DRC report and Messages name the set.
  const p = A.project("Sets");
  R.store(p.documents[1], p, cur());
  A.validate(JSON.parse(JSON.stringify(p)));
  const {nativeRoundTrip} = require("../support/native-cad.cjs");
  assert.deepEqual(nativeRoundTrip(p).rules, p.rules);
  const html = AtriumDRC.report(R.drc(doc, new Map(), cur()), {board: "Board", rules: cur()});
  assert.match(html, /Default › /);

  // A reusable preset creates its own live rule. The durable rule keeps both
  // its identity and the originating template when the preset is reapplied.
  const presetProject = A.project("Preset application"), presetBoard = presetProject.documents[1];
  presetBoard.items = A.clone(items);
  RS.save(presetProject, RS.importText(text)[0]);
  RS.activate(presetProject, presetBoard, "Tight");
  const applied = R.stored(presetBoard, presetProject).list[0];
  assert.ok(AtriumUUID.isV7(applied.id));
  assert.notEqual(applied.id, tightId);
  assert.deepEqual(applied, {...file.rules.list[0], id:applied.id, presetKey:`ruleset-${tightId}-`});
  const reopened = nativeRoundTrip(presetProject), reopenedBoard = reopened.documents.find(d => d.id === presetBoard.id);
  assert.equal(RS.get(reopened, "Tight").source, "board-rule-set");
  assert.equal(RS.get(reopened, "Tight").rules.list[0].id, tightId);
  assert.deepEqual(RS.active(reopened, reopenedBoard), {name:"Tight", modified:false, approximate:false});
  assert.deepEqual(R.stored(reopenedBoard, reopened).list, [applied]);
  RS.activate(reopened, reopenedBoard, "Tight");
  assert.deepEqual(R.stored(reopenedBoard, reopened).list, [applied]);
  const afterReapply = clearanceOf(R.drc(reopenedBoard, new Map(), R.stored(reopenedBoard, reopened)));
  assert.deepEqual(afterReapply.map(v => [v.ruleId, v.ruleName, v.required]), [[applied.id, "Tight clearance", .4]]);

  // MCP: board_rule_sets.
  const mp = A.project("MCP"), mb = mp.documents[1];
  let res = G.headless(mp, mb, {op: "create", name: "Fab"});
  assert.deepEqual(res.sets.map(s => s.name), ["Default", "Fab"]);
  res = G.headless(mp, mb, {op: "assign", name: "Fab", rules: [R.stored(mb, mp).list[0].name]});
  assert.equal(res.moved, 1);
  res = G.headless(mp, mb, {op: "disable", name: "Fab"});
  assert.equal(res.sets.find(s => s.name === "Fab").enabled, false);
  res = G.headless(mp, mb, {op: "list", name: "Fab"});
  assert.equal(res.rules.length, 1);
  assert.throws(() => G.headless(mp, mb, {op: "frobnicate"}), /Unknown operation/);
}

// ---------------------------------------------------------------- Z-axis clearance over pours
{
  const st = S.preset("4"), cu = st.layers.map((l, i) => [l, i]).filter(([l]) => S.isCopper(l));
  const between = st.layers.slice(cu[0][1] + 1, cu[1][1]); for (const l of between) l.thickness = .05 / between.length;
  const zr = (props = {}) => ({id: "z", type: "zClearance", name: "ZAxis", comment: "", enabled: true, priority: 1, scope: scope("all"), gap: .1, adjacentOnly: true, ...props});
  const rulesWith = r => { const c = R.create(); c.list.push(r); R.validate(c); return c; };
  // A GND pour on Inner 1 from x 0..10 with a hole at 4..6; signal tracks on Top over it, beside it and over the hole.
  const pour = AtriumPCBPours.region([[[0, 0], [10, 0], [10, 10], [0, 10]], [[4, 4], [6, 4], [6, 6], [4, 6]]], "Inner 1", "GND", {polygon: "poly1"});
  const b = rules => ({kind: "pcb", name: "Z", stackup: st, rules, notes: [], outline: [[-5, -5], [25, -5], [25, 15], [-5, 15]],
    pcbDrawing: {pours: [pour]},
    items: [track("over", "S1", [[1, 2], [3, 2]], "Top", .1), track("near", "S2", [[10.08, 2], [12, 2]], "Top", .1), track("far", "S3", [[15, 2], [18, 2]], "Top", .1),
      track("hole", "S4", [[4.8, 5], [5.2, 5]], "Top", .1), track("gnd", "GND", [[1, 8], [3, 8]], "Top", .1)]});
  const zOf = out => out.violations.filter(v => v.type === "zClearance");
  const off = rulesWith(zr());
  assert.deepEqual(zOf(R.drc(b(off), new Map(), off)), [], "pours are not checked unless the rule says so (older boards unchanged)");
  const on = rulesWith(zr({pours: true}));
  const v = zOf(R.drc(b(on), new Map(), on));
  assert.deepEqual(v.map(x => x.id).sort(), ["near", "over"], JSON.stringify(v.map(x => [x.id, x.actual])));
  const over = v.find(x => x.id === "over");
  assert.ok(Math.abs(over.actual - .05) < 1e-6 && over.lateral === 0 && over.pour === true);
  assert.equal(over.otherId, "poly1");
  const near = v.find(x => x.id === "near");
  assert.ok(near.lateral > 0 && near.lateral < .0875 && near.actual < .1, JSON.stringify(near));
  // Scoped to one net (InNet): only that track.
  const scoped = rulesWith(zr({pours: true, scope: scope("net", "S2")}));
  assert.deepEqual(zOf(R.drc(b(scoped), new Map(), scoped)).map(x => x.id), ["near"]);
  // The field round-trips and defaults off.
  assert.notEqual(R.normalize(rulesWith(zr())).list.find(r => r.type === "zClearance").pours, true);
  assert.equal(Z.check(b(on), new Map()).length, 2);
}

// ---------------------------------------------------------------- via fences along pour and region edges
{
  const F = AtriumViaFence;
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const rules = {format: "atrium-rules", version: 2, units: "mm", list: [
    {id: "c", type: "clearance", name: "Clearance", enabled: true, priority: 1, scope: scope("all"), scope2: scope("all"), gap: .2},
    {id: "v", type: "viaStyle", name: "RoutingVias", enabled: true, priority: 1, scope: scope("all"), diameterPreferred: .5, holePreferred: .25, holeMin: .2}]};
  const poly = {id: "pg", kind: "polygon", name: "GND pour", net: "GND", layer: "Top", points: rect(10, 10, 30, 20)};
  const region = {id: "rg", kind: "graphic", layer: "Inner 1", fill: true, net: "GND", points: rect(35, 5, 45, 15)};
  const b = {id: "fb", kind: "pcb", name: "F", grid: .25, outline: rect(0, 0, 60, 40), notes: [], rules, items: [poly, region]};
  const inside = (pts, x, y) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const [ax, ay] = pts[i], [bx, by] = pts[j]; if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) c = !c; } return c; };
  const edgeDist = (pts, x, y) => Math.min(...pts.map((a, i) => { const q = pts[(i + 1) % pts.length], dx = q[0] - a[0], dy = q[1] - a[1], l = dx * dx + dy * dy, u = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / l)); return Math.hypot(a[0] + dx * u - x, a[1] + dy * u - y); }));
  const plan = F.plan(b, new Map(), {kind: "edge", source: {polygonId: "pg"}, params: {pitch: 2, rows: 2, stagger: true}});
  assert.ok(plan.add.length > 20, "pour outline fence: " + plan.add.length);
  for (const v of plan.add) {
    assert.ok(inside(poly.points, v.x, v.y), "inside the pour: " + v.x + "," + v.y);
    assert.equal(v.net, "GND", "stitch net from the polygon");
    const d = edgeDist(poly.points, v.x, v.y);
    assert.ok(d > .25 - 1e-6 && d < 3, "two rows near the pour edge: " + d);
  }
  assert.match(plan.fences.set[0].name, /^Region edge/);
  F.applyPlan(b, plan, {defs: new Map()});
  assert.deepEqual(F.status(b, new Map()).map(s => [s.stale, s.vias > 20]), [[false, true]]);
  // Moving the pour makes the fence stale; regenerate replaces its vias in one plan.
  poly.points = rect(12, 10, 32, 20);
  assert.equal(F.status(b, new Map())[0].stale, true, "stale after the pour moved");
  const re = F.regenerate(b, new Map(), null, {staleOnly: true});
  assert.equal(re.remove.length, plan.add.length);
  F.applyPlan(b, re, {defs: new Map()});
  assert.equal(F.status(b, new Map())[0].stale, false);
  assert.ok(b.items.filter(i => i.kind === "via").every(v => inside(poly.points, v.x, v.y)));
  // A copper region edge.
  const rp = F.plan(b, new Map(), {kind: "edge", source: {regionId: "rg"}, params: {pitch: 1.5, rows: 1}});
  assert.ok(rp.add.length >= 20 && rp.add.every(v => inside(region.points, v.x, v.y)), "region fence " + rp.add.length);
  // Poured copper edges: the stored pour of the polygon, its island and its hole.
  b.pcbDrawing = {pours: [AtriumPCBPours.region([rect(12, 10, 32, 20), rect(20, 13, 24, 17)], "Top", "GND", {polygon: "pg"})]};
  const pp = F.plan(b, new Map(), {kind: "edge", source: {polygonId: "pg", poured: true}, params: {pitch: 1.5, rows: 1}});
  assert.ok(pp.add.some(v => v.x > 19 && v.x < 25 && v.y > 12 && v.y < 18), "a ring around the hole");
  assert.ok(!pp.add.some(v => v.x > 20 && v.x < 24 && v.y > 13 && v.y < 17), "none inside the hole");
  assert.match(pp.fences.set[0].name, /^Pour edge/);
  assert.throws(() => F.plan(b, new Map(), {kind: "edge", source: {polygonId: "gone"}}), /no longer on the board/);
}

// ---------------------------------------------------------------- tabbed routing on arc traces
{
  const RT = AtriumRouter, arc = [];
  for (let k = 0; k <= 90; k++) { const a = Math.PI * k / 90; arc.push([10 + 4 * Math.cos(a), 10 - 4 * Math.sin(a)]); }
  const b = {kind: "pcb", items: [{id: "arc", kind: "track", arc: true, points: arc, width: .2, layer: "Top", net: "S"}]};
  for (const side of ["left", "right"]) {
    const plan = RT.tabs(b, new Map(), {ids: ["arc"], pitch: 1, tabWidth: .5, tabLength: .3, side, shape: "T", rules: {clearance: .2}});
    assert.ok(plan.tabs >= 9, side + " tabs on an arc: " + plan.tabs + " " + JSON.stringify(plan.skipped.slice(0, 3)));
    // Every neck runs along the arc's radius (normal to the curve) and reaches w/2 + tabLength.
    for (const t of plan.add.filter(x => x.points.length >= 2)) {
      const [c, tip] = t.points, r0 = Math.hypot(c[0] - 10, c[1] - 10), r1 = Math.hypot(tip[0] - 10, tip[1] - 10);
      assert.ok(Math.abs(r0 - 4) < 2e-3, "neck starts on the arc: " + r0);
      assert.ok(Math.abs(Math.abs(r1 - r0) - (.1 + .3 - .1)) < .02, "neck is radial: " + (r1 - r0));
    }
  }
  // A 90° corner still blocks tabs near it; an L track gets none within the margin of its bend.
  const L = {kind: "pcb", items: [{id: "l", kind: "track", points: [[0, 0], [6, 0], [6, 6]], width: .2, layer: "Top", net: "S"}]};
  const lp = RT.tabs(L, new Map(), {ids: ["l"], pitch: .5, tabLength: .3, tabWidth: .6, side: "left", rules: {clearance: .2}});
  assert.ok(lp.skipped.some(s => s.reason === "corner" && Math.abs(s.at - 6) < .8));
}

// ---------------------------------------------------------------- return path through stacked and staggered HDI vias
{
  const SI = AtriumSI;
  const via = (id, net, x, y, from, to) => ({id, kind: "via", net, x, y, diameter: .3, drill: .1, layer: "Multi", fromLayer: from, toLayer: to});
  const plane = (id, net, layer) => ({id, kind: "polygon", net, layer, points: [[0, 0], [60, 0], [60, 40], [0, 40]]});
  const stack = {version: 1, layers: S.build(["Signal", "Plane", "Signal", "Signal", "Plane", "Signal"]).layers};
  const hb = items => ({kind: "pcb", id: "hb", name: "HDI", outline: [[0, 0], [60, 0], [60, 40], [0, 40]], stackup: JSON.parse(JSON.stringify(stack)), items});
  const rows = items => SI.analyzeNet(SI.context(hb(items), new Map(), {}), "SIG").returns;
  // Top → Inner 3 through three stacked microvias: one layer change (Inner 1 GND → Inner 4 GND).
  const stacked = [plane("g1", "GND", "Inner 1"), plane("g4", "GND", "Inner 4"), track("t1", "SIG", [[5, 5], [20, 5]], "Top", .1),
    via("a", "SIG", 20, 5, "Top", "Inner 1"), via("b", "SIG", 20, 5, "Inner 1", "Inner 2"), via("c", "SIG", 20, 5, "Inner 2", "Inner 3"), track("t3", "SIG", [[20, 5], [35, 5]], "Inner 3", .1)];
  let r = rows(stacked);
  assert.equal(r.length, 1, "a stacked chain is one layer change: " + JSON.stringify(r.map(x => [x.via, x.from, x.to])));
  assert.deepEqual([r[0].from, r[0].to, r[0].kind, r[0].chain.kind, r[0].chain.vias], ["Top", "Inner 3", "missing-via", "stacked", ["a", "b", "c"]]);
  // A return through partial-span GND microvias (two stacked, one staggered) joining Inner 1 and Inner 4.
  const gnd = [via("g", "GND", 20.8, 5, "Inner 1", "Inner 2"), via("h", "GND", 20.8, 5, "Inner 2", "Inner 3"), via("k", "GND", 20.5, 5.3, "Inner 3", "Inner 4")];
  r = rows([...stacked, ...gnd]);
  assert.deepEqual([r[0].kind, r[0].status, r[0].byChain.kind, r[0].byChain.vias], ["via", "ok", "staggered", ["g", "h", "k"]]);
  assert.ok(Math.abs(r[0].distance - .8) < 1e-6, "farthest chain member: " + r[0].distance);
  // A gap in the GND chain (no Inner 2–Inner 3 via) is still a missing return via.
  assert.equal(rows([...stacked, gnd[0], gnd[2]])[0].kind, "missing-via");
  // Staggered signal chain: Top–Inner 1, a jog on Inner 1, then two stacked vias.
  const stag = [plane("g1", "GND", "Inner 1"), plane("g4", "GND", "Inner 4"), track("t1", "SIG", [[5, 5], [20, 5]], "Top", .1),
    via("a", "SIG", 20, 5, "Top", "Inner 1"), track("j", "SIG", [[20, 5], [20.6, 5]], "Inner 1", .1), via("b", "SIG", 20.6, 5, "Inner 1", "Inner 2"),
    via("c", "SIG", 20.6, 5, "Inner 2", "Inner 3"), track("t3", "SIG", [[20.6, 5], [35, 5]], "Inner 3", .1)];
  r = rows(stag);
  assert.deepEqual([r.length, r[0].chain.kind, r[0].from, r[0].to], [1, "staggered", "Top", "Inner 3"]);
  // The Return Path DRC rule reports the chain.
  const rp = R.create(); rp.list.push({id: "rp", type: "returnPath", name: "RP", comment: "", enabled: true, priority: 1, scope: scope("all"), voids: false, splits: false, layerChange: true, distance: 1, capDistance: 5, minVoid: .1});
  const b = hb(stag); b.rules = R.normalize(rp);
  const v = R.drc(b, new Map(), b.rules).violations.filter(x => x.type === "returnPath");
  assert.ok(v.some(x => /Top → Inner 3 \(staggered vias\)/.test(x.detail)), JSON.stringify(v.map(x => x.detail)));
}

// ---------------------------------------------------------------- related components
{
  const RP = AtriumRelated, p = AtriumParts.example(), lib = p.library, [a, b] = lib;
  RP.add(p, a.id, {kind: "alternate", def: b.id, note: "same footprint"});
  RP.add(p, a.id, {kind: "associated", mpn: "M2x6", manufacturer: "Würth", qty: 2});
  assert.deepEqual(RP.list(p, a.id).map(e => e.kind), ["alternate", "associated"]);
  assert.deepEqual(RP.usedBy(p, b.id).map(x => x.def), [a.id]);
  assert.throws(() => RP.add(p, a.id, {kind: "alternate", def: b.id}), /twice/);
  assert.throws(() => RP.add(p, a.id, {kind: "alternate", def: a.id}), /itself/);
  assert.throws(() => RP.add(p, a.id, {kind: "alternate", qty: 2, mpn: "X"}), /Associated hardware/);
  assert.throws(() => RP.add(p, a.id, {kind: "spare", mpn: "X"}));
  A.validate(JSON.parse(JSON.stringify(p)));
  const board = p.documents.find(d => d.kind === "pcb"), placed = board.items.filter(i => i.kind === "part" && i.def === a.id).length;
  const hw = RP.headless(p, {op: "hardware"}, () => board).hardware;
  if (placed) assert.equal(hw.find(h => h.mpn === "M2x6").qty, 2 * placed);
  RP.remove(p, a.id, 0);
  assert.equal(RP.headless(p, {op: "list", part: a.name}).related.length, 1);
  RP.set(p, a.id, []);
  assert.ok(!("related" in a), "an empty list leaves no field");
}
console.log("coming-soon ok");
