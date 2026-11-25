"use strict";
// PCB editing tools (app/pcb/pcb-edit.js, app/pcb/teardrops.js): flip to the bottom side through
// Gerber, PnP, connectivity and DRC; lock and unions; multi-object editing; Find Similar
// and the selection filter; object snap and HUD (with per-move benchmarks); teardrops;
// the flipped board camera (canvas.js, once integrated).
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "zip", "fab-outputs", "connectivity", "rules", "router", "edit-selection", "smart-guides", "via-fence", "pcb-edit", "teardrops"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("./dense-board.js");
const A = Atrium, E = AtriumPCBEdit, T = AtriumTeardrops, PCB = AtriumPCBAppearance;
const now = typeof performance !== "undefined" ? () => performance.now() : () => Date.now();
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, msg + ": " + a + " vs " + b);
const board = p => p.documents.find(d => d.kind === "pcb");
const defsOf = p => new Map(p.library.map(d => [d.id, d]));
const padWorld = (part, defs) => (defs.get(part.def).footprint.pads).map(p => ({n: p.number, at: A.world([p.x, p.y], part), layer: PCB.padLayer(part, p)}));

// ---------------------------------------------------------------- flip
{
  const proj = AtriumParts.example(), d = board(proj), defs = defsOf(proj);
  const u1 = d.items.find(i => i.kind === "part" && defs.get(i.def).footprint.pads.length === 5);
  const j = d.items.find(i => i.kind === "part" && defs.get(i.def).footprint.pads.some(p => p.drill > 0));
  u1.angle = 90; u1.refAt = [1, -2];
  const before = padWorld(u1, defs), origDef = u1.def, libSize = proj.library.length;
  const plan = E.flipPlan(d, defs, [u1.id]);
  assert.equal(plan.about, "each"); assert.equal(plan.parts[0].to.side, "Bottom"); assert.equal(plan.parts[0].to.angle, 270);
  E.applyFlip(d, proj, plan);
  const defs2 = defsOf(proj), after = padWorld(u1, defs2);
  assert.equal(u1.layer, "Bottom"); assert.equal(proj.library.length, libSize + 1);
  assert.equal(defs2.get(u1.def).mirrorOf, origDef);
  for (const [k, p] of before.entries()) {
    close(after[k].at[0], 2 * u1.x - p.at[0], "pad X mirrors about the part origin"); close(after[k].at[1], p.at[1], "pad Y stays");
    assert.equal(after[k].layer, "Bottom", "SMD pads move to bottom copper");
  }
  assert.deepEqual(u1.refAt, [-1, -2]);
  const silk = defs2.get(u1.def).footprint.shapes.find(s => s.style === "silk");
  if (silk) assert.equal(PCB.shapeLayer(u1, silk), "Bottom silk");
  // Through-hole pads stay multilayer.
  E.flip(d, proj, [j.id]);
  const defs3 = defsOf(proj);
  for (const p of defs3.get(j.def).footprint.pads) assert.equal(PCB.padLayer(j, p), "Multi");
  // Flipping back returns the original definition and geometry; the mirror is reused.
  E.flip(d, proj, [u1.id]);
  assert.equal(u1.def, origDef); assert.equal(u1.layer, undefined, "Top is the default side: layer is left unset"); assert.equal(u1.angle, 90);
  padWorld(u1, defsOf(proj)).forEach((p, k) => { close(p.at[0], before[k].at[0], "round trip X"); assert.equal(p.layer, "Top"); });
  E.flip(d, proj, [u1.id]); assert.equal(proj.library.length, libSize + 2, "no extra definition on a second flip");
  // Explicit layers swap: paste, mask, silk; text angle negates.
  const fp = {pads: [{number: "1", x: 1, y: 2, w: 1, h: .5, angle: 30, layer: "Top"}], shapes: [
    {kind: "path", points: [[1, 1], [2, 1]], layer: "Top paste"}, {kind: "path", points: [[0, 0], [1, 0]], layer: "Top mask"},
    {kind: "text", x: 2, y: 0, text: "A", angle: 20, layer: "Silk"}]};
  const m = E.mirrorFootprint(fp);
  assert.deepEqual([m.pads[0].x, m.pads[0].angle, m.pads[0].layer], [-1, 330, "Bottom"]);
  assert.deepEqual(m.shapes.map(s => s.layer), ["Bottom paste", "Bottom mask", "Bottom silk"]);
  assert.deepEqual(m.shapes[0].points, [[-1, 1], [-2, 1]]); assert.equal(m.shapes[2].angle, 340);
  assert.deepEqual(E.mirrorFootprint(m), {...fp, pads: [{...fp.pads[0]}], shapes: fp.shapes.map(s => ({...s}))}, "mirroring twice is the identity");
  // Multi-select flip keeps relative positions (mirrored about the selection centre).
  const two = d.items.filter(i => i.kind === "part").slice(0, 2), xs = two.map(i => i.x), cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  E.flip(d, proj, two.map(i => i.id));
  two.forEach((p, k) => close(p.x, 2 * cx - xs[k], "multi flip mirrors positions"));
  assert.doesNotThrow(() => A.validate(JSON.parse(JSON.stringify(proj))));
}
// Gerber, pick and place, connectivity and DRC see the bottom part.
{
  const proj = AtriumParts.example(), d = board(proj), defs = defsOf(proj);
  const u1 = d.items.find(i => i.kind === "part" && defs.get(i.def).footprint.pads.length === 5);
  const count = (model, l) => model.layers.get(l)?.length || 0;
  const m0 = AtriumFabOutputs.analyse(proj, d.id);
  E.flip(d, proj, [u1.id]);
  const m1 = AtriumFabOutputs.analyse(proj, d.id);
  assert.equal(count(m1, "Bottom paste") - count(m0, "Bottom paste"), 5, "five pads gain bottom paste");
  assert.equal(count(m0, "Top paste") - count(m1, "Top paste"), 5);
  assert.equal(count(m1, "Bottom mask") - count(m0, "Bottom mask"), 5);
  const pnp = AtriumFabOutputs.pickPlace(m1, {pnpUnits: "mm", origin: "absolute", date: new Date(2026, 0, 1)}).content;
  const line = pnp.split("\r\n").find(l => l.startsWith("\"" + u1.ref + "\""));
  assert.match(line, /"BottomLayer"/, "PnP side column");
  const c = AtriumConnectivity.inspect(d, defsOf(proj));
  assert.ok(c.nets.length > 0);
  const r = AtriumRules.drc(d, defsOf(proj), AtriumRules.defaults());
  assert.ok(Array.isArray(r.violations));
}

// ---------------------------------------------------------------- lock and unions
{
  const proj = AtriumParts.example(), d = board(proj), ids = d.items.slice(0, 4).map(i => i.id);
  const lp = E.lockPlan(d, ids, true); assert.equal(lp.ids.length, 4); E.applyLock(d, lp);
  assert.equal(E.lockedIn(d, ids).length, 4); assert.equal(E.lockPlan(d, ids, true).ids.length, 0);
  E.applyLock(d, E.lockPlan(d, ids.slice(0, 2), false)); assert.equal(E.lockedIn(d, ids).length, 2);
  assert.ok(!("locked" in d.items[0]), "unlock removes the flag");
  const u = E.unionPlan(d, ids.slice(0, 2), "create"); E.applyUnion(d, u);
  assert.ok(E.isUnion(d.items[0])); assert.ok(E.isUnion(d.items[0].unionId)); assert.equal(d.items[1].unionId, d.items[0].unionId);
  E.applyUnion(d, E.unionPlan(d, [ids[0], ids[2]], "add", ids[0])); assert.equal(d.items[2].unionId, d.items[0].unionId);
  // A logo-style group joins whole, and keeps its own group: breaking the union leaves it.
  d.items[5].groupId = "logo-x"; d.items[6].groupId = "logo-x";
  const big = E.unionPlan(d, [ids[0], d.items[5].id], "create"); assert.equal(big.set.length, 5);
  E.applyUnion(d, big); E.applyUnion(d, E.unionPlan(d, [ids[0]], "break"));
  assert.ok(d.items.slice(0, 7).every(i => i.unionId == null)); assert.equal(E.unionPlan(d, [ids[0]], "create").set.length, 0);
  assert.deepEqual([d.items[5].groupId, d.items[6].groupId], ["logo-x", "logo-x"], "breaking a union keeps the logo group");
}

// ---------------------------------------------------------------- multi-edit, Find Similar, selection filter
{
  const proj = AtriumParts.example(), d = board(proj), defs = defsOf(proj);
  const tracks = d.items.filter(i => i.kind === "track"), ids = tracks.map(i => i.id);
  const f = E.sharedFields(d, ids); assert.equal(f.kind, "track");
  const width = f.fields.find(x => x.key === "width"); assert.equal(width.value, E.VARIES, "widths differ in the example");
  E.applyField(d, proj, ids, "width", .2); assert.ok(tracks.every(t => t.width === .2));
  assert.equal(E.sharedFields(d, ids).fields.find(x => x.key === "width").value, .2);
  E.applyField(d, proj, ids, "locked", true); assert.ok(tracks.every(E.isLocked));
  const parts = d.items.filter(i => i.kind === "part").slice(0, 3).map(i => i.id);
  E.applyField(d, proj, parts, "side", "Bottom", defs); assert.ok(parts.every(id => d.items.find(i => i.id === id).layer === "Bottom"));
  E.applyField(d, proj, parts, "angle", 450, defsOf(proj)); assert.ok(parts.every(id => d.items.find(i => i.id === id).angle === 90));
  const mixed = E.sharedFields(d, [ids[0], parts[0]]); assert.equal(mixed.kind, null); assert.equal(mixed.kinds.size, 2);
  // Find Similar: same net as a GND track.
  const gnd = tracks.find(t => t.net === "GND");
  const same = E.findSimilar(d, defs, gnd, {net: "same"});
  assert.deepEqual(same.sort(), tracks.filter(t => t.net === "GND").map(t => t.id).sort());
  const diff = E.findSimilar(d, defs, gnd, {net: "different"}); assert.equal(diff.length + same.length, tracks.length);
  assert.equal(E.findSimilar(d, defs, gnd, {}).length, tracks.length, "Any matches every track");
  const vias = d.items.filter(i => i.kind === "via");
  if (vias.length) assert.equal(E.findSimilar(d, defs, vias[0], {diameter: "same"}).length, vias.filter(v => v.diameter === vias[0].diameter).length);
  assert.ok(E.similarProps(d, defs, d.items.find(i => i.kind === "part")).some(p => p.key === "footprint"));
  // Selection filter.
  assert.equal(E.kindOf(gnd), "tracks"); assert.equal(E.kindOf({kind: "graphic", fill: true, layer: "Top"}), "regions"); assert.equal(E.kindOf({kind: "track", layer: "Keep-Out"}), "keepouts"); assert.equal(E.kindOf({kind: "power"}, "schematic"), "power"); assert.equal(E.kindOf({kind: "wire"}, "schematic"), "wires"); assert.equal(E.kindOf({kind: "label"}), "text");
  E.setFilter("tracks", false); assert.equal(E.allows(gnd), false); E.setFilter("tracks", true); assert.equal(E.allows(gnd), true);
}

{
  const {appFile} = require("../support/app-source-paths.cjs");
  require(appFile("automation/legacy-command-contract.js"));
  require(appFile("automation/commands-headless.js"));
  const project = A.project("Find Similar");
  const doc = board(project);
  doc.items = [
    {id: "layerless", kind: "graphic"},
    {id: "top", kind: "graphic", layer: "Top"},
    {id: "silk", kind: "graphic", layer: "Silk"},
    {id: "absent", kind: "pad"},
    {id: "zero", kind: "pad", drill: 0},
    {id: "positive", kind: "pad", drill: .8},
  ];
  const find = (id, criteria, within_ids) => AtriumCommandsHeadless.run(project, "find_similar",
    {document_id: doc.id, id, criteria, within_ids});
  const layers = find("layerless", {layer: "same"});
  assert.equal(layers.properties.find(p => p.key === "layer").value, "Top");
  assert.deepEqual(layers.ids, ["layerless", "top"]);
  assert.deepEqual(find("top", {layer: "same"}).ids, layers.ids, "the effective layer matches in both directions");
  assert.deepEqual(find("layerless", {layer: "different"}).ids, ["silk"]);
  assert.deepEqual(find("layerless", {layer: "same"}, ["layerless", "silk"]).ids, ["layerless"]);
  for (const [id, drill] of [["absent", ""], ["zero", 0], ["positive", .8]]) {
    const matches = find(id, {drill: "same"});
    assert.equal(matches.properties.find(p => p.key === "drill").value, drill);
    assert.deepEqual(matches.ids, [id], "each drill value is a selectable match criterion");
  }
  assert.deepEqual(find("absent", {drill: "different"}).ids, ["zero", "positive"]);
}

// ---------------------------------------------------------------- object snap and HUD (benchmarks)
{
  const {d, defs} = makeAtriumBenchmarkBoard(160);
  const index = AtriumSpatial.create(d.items, i => i.points ? A.bounds(i.points) : [i.x - 1.5, i.y - 1.5, i.x + 1.5, i.y + 1.5], 4);
  const query = b => index.query(b);
  const via = d.items.find(i => i.kind === "via");
  const s = E.objectSnap(d, defs, [via.x + .05, via.y - .04], {radius: .2, query});
  assert.equal(s.kind, "via"); assert.deepEqual(s.point, [via.x, via.y]);
  assert.equal(E.objectSnap(d, defs, [via.x + .05, via.y], {radius: .2, query, kinds: {vias: false}})?.kind === "via", false);
  const tr = d.items.find(i => i.kind === "track"), v = tr.points[1];
  assert.deepEqual(E.objectSnap(d, defs, [v[0] + .03, v[1]], {radius: .1, query, kinds: {tracks: true}}).point, v);
  const part = d.items.find(i => i.kind === "part"), pad = A.world([defs.get(part.def).footprint.pads[0].x, 0], part);
  const ps = E.objectSnap(d, defs, [pad[0] + .02, pad[1] + .02], {radius: .15, query, kinds: {pads: true}});
  assert.equal(ps.kind, "pad"); close(ps.point[0], pad[0], "pad centre");
  assert.deepEqual(E.objectSnap(d, defs, [.03, .02], {radius: .1, query, kinds: {outline: true}}).point, [0, 0]);
  assert.equal(E.objectSnap(d, defs, [1.1, 1.0], {radius: .01, query}), null);
  let t0 = now(), n = 4000;
  for (let k = 0; k < n; k++) E.objectSnap(d, defs, [(k * 7.3) % 360, (k * 3.1) % 270], {radius: .35, query});
  const snapUs = (now() - t0) / n * 1000;
  t0 = now();
  const vs = [{at: [10, 10], ruleName: "Clearance", title: "Track ↔ Pad"}];
  for (let k = 0; k < n; k++) E.hudLines({pointer: [k % 300, 5], origin: [0, 0], hit: tr, violation: E.nearestViolation(vs, [k % 300, 5], .5)});
  const hudUs = (now() - t0) / n * 1000;
  const lines = E.hudLines({pointer: [3, 1], origin: [1, 2], hit: {kind: "track", width: .25, net: "GND", layer: "Top"}, violation: vs[0], layerName: l => l + " Layer"});
  assert.match(lines[0], /^Δx 2\.000mm/); assert.match(lines[2], /GND · Top Layer/); assert.match(lines[3], /Clearance/);
  console.log("snap " + snapUs.toFixed(1) + " µs/move, HUD text " + hudUs.toFixed(1) + " µs/move on " + d.items.length + " objects");
  assert.ok(snapUs < 500, "object snap stays under 0.5 ms per move");
}

// ---------------------------------------------------------------- teardrops
{
  const d = A.sheet("pcb", "TD"), defs = new Map();
  d.outline = [[0, 0], [20, 0], [20, 20], [0, 20]];
  d.items.push({id: "v1", kind: "via", x: 5, y: 5, diameter: 1, drill: .4, net: "A", layer: "Multi"},
    {id: "t1", kind: "track", points: [[5, 5], [12, 5]], width: .2, layer: "Top", net: "A"},
    {id: "p1", kind: "pad", x: 12, y: 5, w: 1.6, h: 1.6, layer: "Top", net: "A", shape: "round"},
    {id: "v2", kind: "via", x: 5, y: 12, diameter: 1, drill: .4, net: "B", layer: "Multi"},
    {id: "t2", kind: "track", points: [[5, 12], [12, 12]], width: .2, layer: "Top", net: "B"},
    {id: "x", kind: "via", x: 6.0, y: 12.6, diameter: .5, drill: .25, net: "C", layer: "Multi"});
  const p = T.plan(d, defs, {style: "straight"});
  const onT1 = p.add.filter(i => i.teardropTrack === "t1");
  assert.equal(onT1.length, 2, "via and pad ends of t1 get teardrops");
  assert.ok(onT1.every(i => i.kind === "graphic" && i.fill && i.net === "A" && i.layer === "Top" && i.teardrop && i.groupId.startsWith("teardrop:")));
  assert.equal(onT1.find(i => i.teardropAnchor === "v1").points.length, 4, "straight teardrops are quads");
  assert.ok(p.skipped.some(s => s.track === "t2"), "a teardrop that would break clearance to net C is skipped");
  T.apply(d, p);
  const n = d.items.filter(T.isTeardrop).length;
  // Regeneration replaces, never stacks.
  const again = T.plan(d, defs, {style: "curved"}); assert.equal(again.remove.length, n); T.apply(d, again);
  assert.equal(d.items.filter(T.isTeardrop).length, again.add.length); assert.ok(d.items.find(T.isTeardrop).points.length > 4, "curved outline");
  // Selection scope and removal.
  assert.equal(T.plan(d, defs, {scope: "selection", selection: ["p1"]}).add.length, 1);
  T.apply(d, T.removePlan(d, {scope: "selection", selection: ["t1"]})); assert.equal(d.items.filter(T.isTeardrop).length, again.add.length - 2);
  T.apply(d, T.removePlan(d)); assert.equal(d.items.filter(T.isTeardrop).length, 0);
  // T junctions.
  d.items.push({id: "t3", kind: "track", points: [[8, 5], [8, 9]], width: .15, layer: "Top", net: "A"});
  assert.ok(T.plan(d, defs, {tjunctions: true}).add.some(i => i.teardropTrack === "t3"));
  // Gerber: teardrops plot as conductor regions on the track's layer.
  const proj = A.project("td", []); proj.documents = [d]; T.apply(d, T.plan(d, defs, {}));
  const model = AtriumFabOutputs.analyse(proj, d.id);
  assert.ok(model.layers.get("Top").some(f => f.t === "region" && f.fn === "Conductor"));
  assert.doesNotThrow(() => A.validate(JSON.parse(JSON.stringify(proj))));
  // DRC raises no false violations for them (same net).
  const r = AtriumRules.drc(d, defs, AtriumRules.defaults());
  assert.ok(!r.violations.some(v => /teardrop/i.test(v.title || "")));
}

// ---------------------------------------------------------------- flipped board camera (canvas.js after integration)
{
  globalThis.document = globalThis.document || undefined;
  try { require("../../app/canvas/canvas.js"); } catch {}
  const C = globalThis.AtriumCanvas;
  if (C?.create) {
    const stub = new Proxy({}, {get: (t, k) => k in t ? t[k] : typeof k === "string" && /^(fill|stroke|line|font|text|global)/.test(k) && !/^(fill|stroke)(Rect|Text)?$/.test(k) ? undefined : () => ({width: 0})});
    const canvas = {width: 0, height: 0, getContext: () => stub, getBoundingClientRect: () => ({width: 400, height: 300, left: 0, top: 0})};
    const v = C.create(canvas);
    if (v.setFlipped) {
      const d = A.sheet("pcb", "F"); d.outline = [[0, 0], [10, 0], [10, 10], [0, 10]];
      v.fit(d, new Map());
      const p = [3, 4], s0 = v.worldToScreen(p);
      v.setFlipped(true);
      const s1 = v.worldToScreen(p);
      close(s1[0], 400 - s0[0], "flipped X mirrors about the view centre"); close(s1[1], s0[1], "Y unchanged");
      const back = v.screenToWorld(s1); close(back[0], 3, "round trip X"); close(back[1], 4, "round trip Y");
      v.pan(10, 0); close(v.worldToScreen(p)[0], s1[0] + 10, "panning follows the pointer when flipped");
      assert.equal(v.camera().flipped, true); v.restoreCamera({...v.camera(), flipped: false}); assert.equal(v.flipped(), false);
      console.log("flipped camera ok");
    } else console.log("canvas.js not yet integrated: flipped camera skipped");
  }
}

// ================================================================ regressions
const inPoly = (p, pts) => { let c = false; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) { const a = pts[i], b = pts[j]; if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
const tdBoard = (R, w) => {
  const d = A.sheet("pcb", "x"); d.outline = [[-20, -20], [20, -20], [20, 20], [-20, 20]];
  d.items.push({id: "p", kind: "pad", x: 0, y: 0, w: 2 * R, h: 2 * R, shape: "round", layer: "Top", net: "A"},
    {id: "t", kind: "track", points: [[0, 0], [15, 0]], width: w, layer: "Top", net: "A"});
  return d;
};
// 1. A teardrop never covers another net's via, even one wholly inside it; DRC and
// connectivity see filled copper as filled.
{
  for (const [R, w, len, wid, at, dia] of [[3, .2, 150, 100, [3.46, .61], .55], [4, .25, 100, 100, [4.52, .7], .67], [2, .2, 100, 90, [2.25, .38], .13]]) {
    const d = tdBoard(R, w), free = T.plan(d, new Map(), {length: len, width: wid}).add[0];
    assert.ok(inPoly(at, free.points), "the probe point lies inside the teardrop");
    d.items.push({id: "v", kind: "via", x: at[0], y: at[1], diameter: dia, drill: dia / 2, net: "B"});
    const p = T.plan(d, new Map(), {length: len, width: wid});
    assert.equal(p.add.length, 0, "no teardrop over a net-B via inside its area (pad Ø" + 2 * R + ")");
    assert.ok(p.skipped.some(k => k.reason === "clearance"));
    // The same copper placed by hand: DRC flags it and connectivity reports the short.
    d.items.push({...free, id: "td"});
    const drc = AtriumRules.drc(d, new Map(), AtriumRules.defaults());
    assert.ok(drc.violations.some(v => v.type === "clearance" && [v.id, v.otherId].includes("td") && [v.id, v.otherId].includes("v")), "DRC checks the filled area");
    assert.ok(drc.violations.some(v => v.type === "short"), "the short is reported");
    assert.equal(AtriumConnectivity.inspect(d, new Map()).shorts.length, 1, "connectivity treats the teardrop as filled area");
  }
  // A filled copper graphic near another net: clearance measured to the real outline.
  const d = A.sheet("pcb", "g"); d.outline = [[0, 0], [20, 0], [20, 20], [0, 20]];
  d.items.push({id: "g", kind: "graphic", points: [[2, 2], [8, 2], [8, 3], [3, 3], [3, 8], [2, 8]], closed: true, fill: true, width: 0, layer: "Top", net: "A"},
    {id: "tb", kind: "track", points: [[3.1, 3.1], [3.1, 7]], width: .1, layer: "Top", net: "B"}, {id: "tc", kind: "track", points: [[5, 5], [7, 5]], width: .1, layer: "Top", net: "C"});
  const v = AtriumRules.drc(d, new Map(), AtriumRules.defaults()).violations.filter(x => x.type === "clearance");
  assert.ok(v.some(x => [x.id, x.otherId].includes("tb")), "a track 0.05 mm from an L-shaped fill is flagged");
  assert.ok(!v.some(x => [x.id, x.otherId].includes("tc")), "the concave notch of the fill is not copper");
}
// Fuzz: dense random boards, teardrops checked by an independent exact checker
// (point-in-polygon and edge distances), so the planner can never place a violating one.
{
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const segDist = (p, a, b) => A.nearSegment(p, a, b);
  const segSeg = (a, b, c, d) => { const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]); if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0; return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b)); };
  const gapTo = (poly, ob) => {
    if (ob.kind === "via" || ob.kind === "pad") { const c = [ob.x, ob.y], r = (ob.diameter || ob.w) / 2; if (inPoly(c, poly)) return -1; let m = Infinity; for (let i = 0; i < poly.length; i++) m = Math.min(m, segDist(c, poly[i], poly[(i + 1) % poly.length])); return m - r; }
    let m = Infinity; for (let k = 1; k < ob.points.length; k++) { if (inPoly(ob.points[k - 1], poly)) return -1; for (let i = 0; i < poly.length; i++) m = Math.min(m, segSeg(ob.points[k - 1], ob.points[k], poly[i], poly[(i + 1) % poly.length])); }
    return m - ob.width / 2;
  };
  let drops = 0, bad = 0, interiorProbes = 0;
  const t0 = now();
  for (let b = 0; b < 60; b++) {
    const d = A.sheet("pcb", "f" + b); d.outline = [[-1, -1], [31, -1], [31, 31], [-1, 31]];
    for (let k = 0; k < 18; k++) {
      const x = 2 + rnd() * 26, y = 2 + rnd() * 26, R = .4 + rnd() * 1.8, net = "N" + k, ang = rnd() * Math.PI * 2, L = 2 + rnd() * 4, off = (rnd() - .5) * R * .8;
      const n = [-Math.sin(ang), Math.cos(ang)], s = [x + n[0] * off, y + n[1] * off];
      d.items.push(rnd() < .5 ? {id: "a" + k, kind: "via", x, y, diameter: 2 * R, drill: R * .6, net} : {id: "a" + k, kind: "pad", x, y, w: 2 * R, h: 2 * R, shape: "round", layer: "Top", net},
        {id: "t" + k, kind: "track", points: [s, [s[0] + Math.cos(ang) * L, s[1] + Math.sin(ang) * L]], width: .1 + rnd() * .3, layer: "Top", net});
    }
    // Small other-net vias scattered everywhere, many inside where teardrops would go.
    for (let k = 0; k < 140; k++) d.items.push({id: "o" + k, kind: "via", x: rnd() * 30, y: rnd() * 30, diameter: .2 + rnd() * .3, drill: .1, net: "X" + (k % 9)});
    const p = T.plan(d, new Map(), {style: rnd() < .5 ? "curved" : "straight", length: 100 + rnd() * 100, width: 60 + rnd() * 30});
    for (const td of p.add) {
      drops++;
      for (const ob of d.items) {
        if (ob.kind === "graphic" || (ob.net || "") === td.net) continue;
        const g = gapTo(td.points, ob);
        if (g < 0) interiorProbes++;
        if (g < .2 - 1e-6) { bad++; break; }
      }
    }
    // Teardrops from one plan also keep clearance to each other (different nets).
    for (const a of p.add) for (const c of p.add) if (a.net < c.net && a.points.some(q => inPoly(q, c.points))) bad++;
  }
  console.log("teardrop fuzz: " + drops + " teardrops on 60 dense boards, " + bad + " clearance violations (independent check) in " + Math.round(now() - t0) + " ms");
  assert.ok(drops > 200, "the fuzz places teardrops");
  assert.equal(bad, 0, "no teardrop violates clearance");
}
// Fuzz on an autorouted dense board, checked with tests/pcb/autorouter.cjs's independent copper
// extraction (copperOf) and exact polygon gaps.
{
  const H = require("./autorouter.cjs"), {d, defs} = H.routingBoard({width: 70, height: 55, ics: 5, passives: 50, headers: 2, seed: 3});
  H.routeAndCheck(d, defs, {});
  assert.equal(H.clearanceViolations(d, defs, null).length, 0, "the routed board starts clean");
  const p = T.plan(d, defs, {length: 150, width: 100}), need = .2;
  const idx = n => n === "Top" ? 0 : n === "Bottom" ? 32 : +(/^Inner (\d+)$/.exec(n) || [0, -1])[1];
  const cross = (a, b, c, e) => { const o = (p, q, r) => Math.sign((q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])); return o(a, b, c) * o(a, b, e) < 0 && o(c, e, a) * o(c, e, b) < 0; };
  const objs = H.copperOf(d, defs, null);
  let bad = 0;
  for (const td of p.add) {
    const li = idx(td.layer), P = td.points, edges = P.map((q, i) => [q, P[(i + 1) % P.length]]);
    for (const o of objs) {
      if (o.net === td.net || o.hi < li || o.lo > li) continue;
      const oe = o.pts.length === 1 ? [[o.pts[0], o.pts[0]]] : o.pts.length === 2 ? [[o.pts[0], o.pts[1]]] : o.pts.map((q, i) => [q, o.pts[(i + 1) % o.pts.length]]);
      let g = o.pts.some(q => inPoly(q, P)) ? -1 : Infinity;
      for (const [a, b] of edges) for (const [c, e] of oe) { if (g < 0) break; if (cross(a, b, c, e)) g = -1; else g = Math.min(g, A.nearSegment(a, c, e), A.nearSegment(b, c, e), A.nearSegment(c, a, b), A.nearSegment(e, a, b)); }
      if (g - o.r < need - 1e-6) { bad++; break; }
    }
  }
  T.apply(d, p);
  const ids = new Set(p.add.map(i => i.id)), drc = AtriumRules.drc(d, defs, d.rules || AtriumRules.defaults(), {types: ["clearance"]});
  const drcBad = drc.violations.filter(v => ids.has(v.id) || ids.has(v.otherId)).length;
  console.log("dense routed board: " + p.add.length + " teardrops, " + bad + " violations (autorouter.cjs copperOf, exact), " + drcBad + " DRC violations");
  assert.ok(p.add.length > 300); assert.equal(bad, 0); assert.equal(drcBad, 0);
}
// 2. A mirrored definition never goes stale: settle regenerates it under the same id.
{
  const proj = AtriumParts.example(), d = board(proj), defs = defsOf(proj);
  const [r1, r2] = d.items.filter(i => i.kind === "part" && /^R[12]$/.test(i.ref));
  assert.equal(r1.def, r2.def, "R1 and R2 share a definition");
  E.flip(d, proj, [r1.id]);
  const mirrorId = r1.def, orig = proj.library.find(x => x.id === r2.def);
  assert.deepEqual(E.settle(d, proj).mirrors, [], "nothing stale after a flip");
  const w0 = orig.footprint.pads[0].w; orig.footprint.pads[0].w = w0 + .5;
  const r = E.settle(d, proj);
  assert.equal(r.mirrors.length, 1, "the edit to the original is detected");
  assert.equal(r1.def, mirrorId, "the bottom part keeps its definition id");
  assert.equal(defsOf(proj).get(r1.def).footprint.pads[0].w, w0 + .5, "bottom pads follow the original");
  // Flipping a sibling when nothing is stale rewrites no other part.
  const plan = E.flipPlan(d, defsOf(proj), [r2.id]); E.applyFlip(d, proj, plan, defsOf(proj));
  assert.deepEqual(plan.refreshed, [], "no silent rewrite of other bottom parts");
  E.flip(d, proj, [r2.id]);
  orig.footprint.pads[0].w = w0;
  const plan2 = E.flipPlan(d, defsOf(proj), [r2.id]); E.applyFlip(d, proj, plan2, defsOf(proj));
  assert.equal(plan2.refreshed.length, 1, "a stale mirror refreshed by a flip is reported");
  assert.equal(defsOf(proj).get(r1.def).footprint.pads[0].w, w0);
  // Fab output sees the current pads.
  orig.footprint.pads[0].w = w0 + .3; E.settle(d, proj);
  assert.equal(defsOf(proj).get(r1.def).footprint.pads[0].w, w0 + .3);
}
// 3. L during a drag with drag re-route: the session restarts on the flipped pads; no
// track lands on another pin, and nothing shorts that the plain move and flip do not.
{
  const S = AtriumEditSelection, R = AtriumRouter;
  const header = () => {
    const d = A.sheet("pcb", "B"); d.outline = [[0, 0], [40, 0], [40, 30], [0, 30]];
    const proj = A.project("t", []); proj.documents = [d];
    proj.library = [{id: "hdr", name: "HDR", footprint: {name: "HDR2", pads: [{number: "1", x: -1.27, y: 0, w: 1.6, h: 1.6, drill: .9, shape: "round"}, {number: "2", x: 1.27, y: 0, w: 1.6, h: 1.6, drill: .9, shape: "round"}], shapes: []}}];
    d.items.push({id: "J", kind: "part", def: "hdr", ref: "J1", x: 20, y: 15, angle: 0, pinNets: {"1": "A", "2": "B"}},
      {id: "va", kind: "via", x: 10, y: 15, diameter: .6, drill: .3, net: "A"}, {id: "vb", kind: "via", x: 30, y: 15, diameter: .6, drill: .3, net: "B"},
      {id: "ta", kind: "track", points: [[18.73, 15], [10, 15]], width: .25, layer: "Top", net: "A"},
      {id: "tb", kind: "track", points: [[21.27, 15], [30, 15]], width: .25, layer: "Top", net: "B"});
    return {proj, d, ref: "J1"};
  };
  const example = () => { const proj = AtriumParts.example(); return {proj, d: board(proj), ref: "U1"}; };
  const dragFlip = (make, delta, flip) => {
    const {proj, d, ref} = make(); let defs = defsOf(proj);
    const u = d.items.find(i => i.ref === ref);
    if (flip === "static") { u.x += delta[0]; u.y += delta[1]; E.applyFlip(d, proj, E.flipPlan(d, defs, [u.id], {about: "each"}), defs); }
    else {
      const sess = R.dragSession(d, defs, [u.id], {project: proj, revision: 1}), tr = S.translation(d, defs, [u], () => []);
      tr.apply(delta[0] / 2, delta[1] / 2); sess.move([delta[0] / 2, delta[1] / 2]);
      E.applyFlip(d, proj, E.flipPlan(d, defs, [u.id], {about: "each"}), defs); defs = defsOf(proj);
      sess.restart(d, defs);
      tr.apply(...delta); sess.move(delta); R.apply(d, sess.commit());
    }
    const all = defsOf(proj), c = AtriumConnectivity.inspect(d, all);
    const pads = all.get(u.def).footprint.pads.map(p => ({at: A.world([p.x, p.y], u), net: u.pinNets?.[p.number]}));
    const wrong = d.items.filter(i => i.kind === "track").flatMap(t => [t.points[0], t.points.at(-1)].filter(q => pads.some(p => Math.hypot(q[0] - p.at[0], q[1] - p.at[1]) < 1e-3 && p.net !== t.net)));
    return {shorts: c.shorts.length, airwires: c.airwires.length, wrong: wrong.length};
  };
  for (const delta of [[0, 4], [0, .5], [3, 0]]) {
    const r = dragFlip(header, delta, "drag");
    assert.deepEqual(r, {shorts: 0, airwires: 0, wrong: 0}, "through-hole header: tracks re-route to their own pins on the flipped part " + delta);
  }
  for (const delta of [[2, 0], [0, -3], [1, 1]]) {
    const r = dragFlip(example, delta, "drag"), base = dragFlip(example, delta, "static");
    assert.equal(r.wrong, 0, "no track ends on another pin of the flipped U1");
    assert.ok(r.shorts <= base.shorts, "re-route adds no short beyond the placement itself " + delta);
    assert.equal(r.airwires, base.airwires, "the SMD pins on the far side show as airwires (opens the ratsnest reports)");
  }
}
// 4. Off-centre track entry: the teardrop is built on the track's own line.
{
  const d = A.sheet("pcb", "o"); d.outline = [[-5, -5], [10, -5], [10, 5], [-5, 5]];
  d.items.push({id: "p", kind: "pad", x: 0, y: 0, w: 1.6, h: 1.6, shape: "round", layer: "Top", net: "A"},
    {id: "t", kind: "track", points: [[0, .38], [5, .38]], width: .15, layer: "Top", net: "A"});
  const td = T.plan(d, new Map(), {}).add[0];
  assert.ok(td, "the teardrop is added");
  const far = Math.max(...td.points.map(p => p[0])), tail = td.points.filter(p => p[0] > far - 1e-9).map(p => p[1]).sort();
  assert.deepEqual(tail.map(y => +y.toFixed(4)), [.305, .455], "the tail ends exactly on the track's edges (no spur)");
  assert.ok(inPoly([1.0, .38], td.points), "the track centreline runs inside the teardrop");
  assert.ok(td.points.every(p => Math.hypot(p[0], p[1]) <= .8 + 1e-6 || p[0] > 0), "the flanks start inside the land");
}
// 5. Teardrop lifecycle: stale teardrops are found, flagged by DRC and removed by settle.
{
  const fresh = () => {
    const proj = AtriumParts.example(), d = board(proj), defs = defsOf(proj);
    T.apply(d, T.plan(d, defs, {}));
    return {proj, d, defs, n: d.items.filter(T.isTeardrop).length};
  };
  { const {proj, d, n} = fresh(); assert.ok(n > 10); assert.deepEqual(AtriumRules.staleTeardrops(d, defsOf(proj)), [], "fresh teardrops are not stale"); assert.deepEqual(E.settle(d, proj).teardrops, []); }
  { // Delete a track: its teardrops go with it.
    const {proj, d, n} = fresh(), td = d.items.find(T.isTeardrop), track = td.teardropTrack;
    d.items = d.items.filter(i => i.id !== track);
    const gone = E.settle(d, proj).teardrops;
    assert.ok(gone.length >= 1 && d.items.filter(T.isTeardrop).every(i => i.teardropTrack !== track));
    assert.equal(d.items.filter(T.isTeardrop).length, n - gone.length);
  }
  { // Move a part: its teardrops are stale.
    const {proj, d} = fresh(), part = d.items.find(i => i.kind === "part" && d.items.some(t => T.isTeardrop(t) && String(t.teardropAnchor).startsWith(i.id + ":")));
    part.x += 3;
    const stale = AtriumRules.staleTeardrops(d, defsOf(proj));
    assert.ok(stale.length && stale.every(s => /moved|track/.test(s.reason)));
    // DRC reports stale teardrops (a locked one survives settle and stays flagged).
    const lockedId = stale[0].id; d.items.find(i => i.id === lockedId).locked = true;
    E.settle(d, proj);
    assert.deepEqual(d.items.filter(i => T.isTeardrop(i) && AtriumRules.staleTeardrops(d, defsOf(proj)).some(s => s.id === i.id)).map(i => i.id), [lockedId]);
    const drc = AtriumRules.drc(d, defsOf(proj), AtriumRules.defaults());
    assert.ok(drc.violations.some(v => v.id === lockedId && v.stale), "DRC flags the stale teardrop");
  }
  { // Net and layer changes on tracks leave no teardrop on the old net (no short through it).
    const {proj, d} = fresh(), tracks = d.items.filter(i => i.kind === "track" && i.net === "VIN").map(i => i.id);
    E.applyField(d, proj, tracks, "net", "RENAMED"); E.settle(d, proj);
    const shorts = AtriumConnectivity.inspect(d, defsOf(proj)).shorts;
    const bare = {...d, items: d.items.filter(i => !T.isTeardrop(i))};
    assert.deepEqual(shorts.map(x => x.nets), AtriumConnectivity.inspect(bare, defsOf(proj)).shorts.map(x => x.nets), "no extra short through a teardrop left on the old net");
    assert.ok(!d.items.some(i => T.isTeardrop(i) && i.net === "VIN" && tracks.includes(i.teardropTrack)));
    const top = d.items.filter(i => i.kind === "track" && i.layer === "Top").map(i => i.id);
    E.applyField(d, proj, top, "layer", "Bottom"); E.settle(d, proj);
    assert.deepEqual(AtriumRules.staleTeardrops(d, defsOf(proj)), []);
  }
  { // Flipping a part removes its top-side teardrops.
    const {proj, d} = fresh(), part = d.items.find(i => i.ref === "U1");
    E.flip(d, proj, [part.id]); E.settle(d, proj);
    assert.ok(!d.items.some(i => T.isTeardrop(i) && String(i.teardropAnchor).startsWith(part.id + ":") && i.layer === "Top"));
  }
}
// 6. Unions keep fence, logo and teardrop groups.
{
  const d = A.sheet("pcb", "u"), VF = AtriumViaFence;
  d.items.push({id: "f1", kind: "via", x: 1, y: 1, diameter: .5, drill: .25, net: "GND", groupId: "fence:F"},
    {id: "f2", kind: "via", x: 2, y: 1, diameter: .5, drill: .25, net: "GND", groupId: "fence:F"},
    {id: "a", kind: "track", points: [[0, 0], [1, 0]], width: .2, layer: "Top", net: "A"},
    {id: "b", kind: "track", points: [[0, 2], [1, 2]], width: .2, layer: "Top", net: "A"},
    {id: "lg", kind: "graphic", points: [[5, 5], [6, 5], [5, 6]], closed: true, fill: true, width: 0, layer: "Silk", groupId: "logo-1"});
  const fenceOf = () => d.items.filter(i => i.kind === "via").map(i => VF.fenceOfItem(i));
  const before = fenceOf();
  E.applyUnion(d, E.unionPlan(d, ["a", "f1", "lg"], "create"));
  assert.deepEqual(fenceOf(), before, "fence membership survives a union");
  assert.ok(d.items.find(i => i.id === "f2").unionId, "the whole fence joins (no split)");
  E.applyUnion(d, E.unionPlan(d, ["a"], "break"));
  assert.equal(d.items.find(i => i.id === "lg").groupId, "logo-1", "breaking the union keeps the logo group");
  assert.deepEqual(fenceOf(), before);
  E.applyUnion(d, E.unionPlan(d, ["a", "b"], "create"));
  E.applyUnion(d, E.unionPlan(d, ["a", "f1"], "add", "a"));
  assert.deepEqual(d.items.filter(i => i.groupId === "fence:F").map(i => i.id), ["f1", "f2"], "union-add does not split the fence");
  assert.ok(d.items.filter(i => i.groupId === "fence:F").every(i => i.unionId === d.items.find(x => x.id === "a").unionId));
  assert.deepEqual(E.mates(d, d.items.find(i => i.id === "b")).map(i => i.id).sort(), ["a", "b", "f1", "f2"], "clicking a member selects the union and the whole fence");
  const proj = A.project("u", []); proj.documents = [d]; assert.doesNotThrow(() => A.validate(JSON.parse(JSON.stringify(proj))), "unionId is a valid field");
  // Documents from earlier builds: a groupId "union:…" still reads and breaks.
  const old = A.sheet("pcb", "o"); old.items.push({id: "x", kind: "via", x: 0, y: 0, groupId: "union:old"}, {id: "y", kind: "via", x: 1, y: 0, groupId: "union:old"});
  assert.ok(E.isUnion(old.items[0])); E.applyUnion(old, E.unionPlan(old, ["x"], "break")); assert.ok(old.items.every(i => i.groupId == null && i.unionId == null));
}
// 7, 8. Locks: align plans report locked movers (the editor asks first); teardrop and via
// fence regeneration keep locked members.
{
  const proj = AtriumParts.example(), d = board(proj), defs = defsOf(proj);
  const parts = d.items.filter(i => i.kind === "part").map(i => i.id);
  for (const p of d.items.filter(i => i.kind === "part")) p.locked = true;
  const plan = AtriumGuides.align(d, defs, parts, "top");
  assert.ok(plan.moves.length > 0); assert.deepEqual(plan.locked.sort(), plan.moves.map(m => m.id).sort(), "every locked mover is reported");
  assert.deepEqual(AtriumGuides.distribute(d, defs, parts, "x").locked.length > 0, true);
  T.apply(d, T.plan(d, defs, {}));
  const td = d.items.find(T.isTeardrop); td.locked = true;
  const again = T.plan(d, defs, {});
  assert.ok(!again.remove.includes(td.id), "regeneration keeps a locked teardrop");
  assert.ok(!again.add.some(i => i.teardropTrack === td.teardropTrack && i.teardropAnchor === td.teardropAnchor), "and adds no copy next to it");
  assert.ok(!T.removePlan(d).remove.includes(td.id));
  const vf = A.sheet("pcb", "vf"); vf.outline = [[0, 0], [20, 0], [20, 20], [0, 20]];
  vf.items.push({id: "s", kind: "track", points: [[2, 10], [18, 10]], width: .2, layer: "Top", net: "SIG"});
  const VF = AtriumViaFence;
  VF.applyPlan(vf, VF.plan(vf, new Map(), {kind: "path", source: {trackIds: ["s"]}, params: {net: "GND"}}));
  const fenceVias = vf.items.filter(i => i.kind === "via" && VF.fenceOfItem(i));
  assert.ok(fenceVias.length > 4);
  fenceVias[0].locked = true;
  const regen = VF.regenerate(vf, new Map(), null);
  assert.ok(!regen.remove.includes(fenceVias[0].id), "fence regeneration keeps a locked via");
  assert.equal(regen.remove.length, fenceVias.length - 1);
}
// 9. Multi-edit checks the design rules and can clamp.
{
  const proj = AtriumParts.example(), d = board(proj);
  const tracks = d.items.filter(i => i.kind === "track").map(i => i.id), vias = d.items.filter(i => i.kind === "via");
  const w = E.ruleCheck(d, proj, tracks, "width", .01);
  assert.equal(new Set(w.issues.map(i => i.id)).size, tracks.length, "0.01 mm is below the Width rule for every track");
  E.applyField(d, proj, tracks, "width", .01, null, {values: w.values});
  assert.ok(d.items.filter(i => i.kind === "track").every(t => t.width >= .01 + 1e-9));
  assert.equal(AtriumRules.drc(d, defsOf(proj), AtriumRules.defaults(), {types: ["width"]}).violations.length, 0, "clamped widths pass DRC");
  assert.equal(E.ruleCheck(d, proj, tracks, "width", .25).issues.length, 0);
  for (const v of vias) { v.drill = .4; v.diameter = .8; }
  const ring = E.ruleCheck(d, proj, vias.map(v => v.id), "diameter", .41);
  assert.equal(ring.issues.length, vias.length, "a 5 µm annular ring is flagged");
  assert.ok(ring.issues.every(i => i.what === "Annular ring" || i.what === "Via diameter"));
  E.applyField(d, proj, vias.map(v => v.id), "diameter", .41, null, {values: ring.values});
  assert.equal(AtriumRules.drc(d, defsOf(proj), AtriumRules.defaults(), {types: ["annularRing", "viaStyle"]}).violations.length, 0, "clamped vias pass DRC");
}
// 10. A pasted union is still a union that Break Union breaks; teardrops follow their copy.
{
  const proj = AtriumParts.example(), d = board(proj), defs = defsOf(proj), S = AtriumEditSelection;
  const t2 = d.items.filter(i => i.kind === "track").slice(0, 2).map(i => i.id);
  E.applyUnion(d, E.unionPlan(d, t2, "create"));
  const clip = S.capture(d, defs, new Set(t2)), ids = S.prepare(proj, d, clip, defs).commit([50, 50]);
  const pasted = d.items.filter(i => ids.includes(i.id));
  assert.ok(pasted.every(i => E.isUnion(i)) && pasted[0].unionId === pasted[1].unionId && pasted[0].unionId !== d.items.find(i => i.id === t2[0]).unionId);
  assert.match(E.unionPlan(d, ids, "break").message, /1 union broken/);
  const d2 = tdBoard(1, .2); T.apply(d2, T.plan(d2, new Map(), {}));
  const proj2 = A.project("p", []); proj2.documents = [d2];
  const all = new Set(d2.items.map(i => i.id)), ids2 = S.prepare(proj2, d2, S.capture(d2, new Map(), all), new Map()).commit([30, 0]);
  assert.deepEqual(AtriumRules.staleTeardrops(d2, new Map()), [], "pasted teardrops point at the pasted track and pad");
  assert.equal(ids2.length, 3);
}
// 11. Object snap: hidden layers and the selection filter.
{
  const d = A.sheet("pcb", "s"), defs = new Map([["r", {id: "r", footprint: {pads: [{number: "1", x: 0, y: 0, w: 1, h: 1, layer: "Top"}, {number: "2", x: 2, y: 0, w: 1, h: 1, layer: "Bottom"}]}}]]);
  d.items.push({id: "v", kind: "via", x: 10, y: 10, diameter: .6}, {id: "P", kind: "part", def: "r", x: 0, y: 0});
  assert.equal(E.objectSnap(d, defs, [10.1, 10], {radius: .5, kinds: {vias: true}})?.id, "v");
  assert.equal(E.objectSnap(d, defs, [10.1, 10], {radius: .5, kinds: {vias: true}, visible: i => i.kind !== "via"}), null, "filtered objects do not attract");
  assert.equal(E.objectSnap(d, defs, [2.1, 0], {radius: .5, kinds: {pads: true}, padVisible: (part, pad) => pad.layer !== "Bottom"}), null, "pads on hidden layers do not attract");
  assert.deepEqual(E.objectSnap(d, defs, [.1, 0], {radius: .5, kinds: {pads: true}, padVisible: (part, pad) => pad.layer !== "Bottom"}).point, [0, 0]);
}
// 12, 14. Inner layers mirror through the stack; flipping twice is exact.
{
  assert.equal(E.mirrorLayer("Inner 2", 4), "Inner 3"); assert.equal(E.mirrorLayer("Inner 1", 4), "Inner 4"); assert.equal(E.mirrorLayer("Inner 2"), "Inner 2", "unknown stack: unchanged");
  const m = E.mirrorFootprint({pads: [{number: "1", x: 1, y: 0, w: .3, h: .3, layer: "Inner 2"}, {number: "v", kind: "via", x: 0, y: 0, diameter: .3, drill: .1, fromLayer: "Top", toLayer: "Inner 1"}], shapes: []}, 4);
  assert.equal(m.pads[0].layer, "Inner 3"); assert.deepEqual([m.pads[1].fromLayer, m.pads[1].toLayer], ["Bottom", "Inner 4"], "a Top→Inner 1 microvia becomes Bottom→Inner 4");
  const d = A.sheet("pcb", "i"); d.items.push({id: "x", kind: "via", x: 0, y: 0, fromLayer: "Top", toLayer: "Inner 4"});
  assert.equal(E.innerCount(d, new Map()), 4);
  const proj = AtriumParts.example(), b = board(proj), snap = JSON.stringify(proj);
  const all = b.items.filter(i => i.kind === "part").map(i => i.id);
  E.flip(b, proj, all); E.flip(b, proj, all);
  for (const id of all) { E.flip(b, proj, [id]); E.flip(b, proj, [id]); }
  const back = JSON.parse(JSON.stringify(proj)); back.library = back.library.filter(x => !x.mirrorOf);
  const want = JSON.parse(snap);
  assert.deepEqual(back.documents, want.documents, "flipping twice restores every part exactly");
}
// 18. A blind via's teardrop stays on the layers it joins.
{
  const d = A.sheet("pcb", "bv"); d.outline = [[-5, -5], [10, -5], [10, 5], [-5, 5]];
  d.items.push({id: "v", kind: "via", x: 0, y: 0, diameter: 1, drill: .3, fromLayer: "Top", toLayer: "Inner 1", net: "A"},
    {id: "tb", kind: "track", points: [[0, 0], [5, 0]], width: .15, layer: "Bottom", net: "A"},
    {id: "tt", kind: "track", points: [[0, 0], [-4, 0]], width: .15, layer: "Top", net: "A"});
  const add = T.plan(d, new Map(), {}).add;
  assert.deepEqual(add.map(i => i.layer), ["Top"], "no teardrop on Bottom for a Top→Inner 1 via");
}
console.log("PASS pcb-edit");
