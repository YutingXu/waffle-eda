"use strict";
// Board cutouts everywhere: connectivity, DRC edge clearance, polygon pours, the
// interactive router, the autorouter and fanout keep out of AtriumBoardShape.holes;
// Altium ISBOARDCUTOUT regions import as cutouts; drill and pick-and-place follow doc.origin.
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const m of ["model", "parts", "board-shape", "board-shape-editing", "spatial", "pcb-appearance", "pcb-pours", "connectivity", "altium-rules", "rules", "polygon-pour", "router", "autorouter",
  "fanout", "pcb-import", "zip", "fab-outputs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
const A = Atrium, S = AtriumBoardShape, C = AtriumConnectivity, R = AtriumRules, P = AtriumPolygonPour;
const defs = new Map();
const outline = [[0, 0], [40, 0], [40, 30], [0, 30]], hole = [[15, 10], [25, 10], [25, 20], [15, 20]];
function board(items = []) {
  const doc = {id: "b", kind: "pcb", name: "Cut", grid: 1, outline: outline.map(p => p.slice()), notes: [], items};
  const shape = S.addCutout(S.fromPolygon(doc.outline), S.fromPolygon(hole).contour);
  S.apply(doc, shape, "test");
  return doc;
}
const pad = (id, net, x, y, w = .8) => ({id, kind: "pad", number: "1", x, y, w, h: w, drill: 0, shape: "rect", layer: "Top", net});
const track = (id, net, ...points) => ({id, kind: "track", layer: "Top", net, width: .25, points});

// ---- board shape helpers ------------------------------------------------------------
{
  const doc = board();
  assert.equal(S.holes(doc).length, 1);
  assert.equal(S.inCutout(doc, [20, 15]), true);
  assert.equal(S.inCutout(doc, [5, 15]), false);
  const pieces = S.clipOutsideCutouts(doc, [5, 15], [35, 15]);
  assert.deepEqual(pieces.map(p => p.map(q => q.map(v => +v.toFixed(6)))), [[[5, 15], [15, 15]], [[25, 15], [35, 15]]]);
  assert.deepEqual(S.clipOutsideCutouts(doc, [1, 1], [2, 2]), [[[1, 1], [2, 2]]]);
}

// ---- connectivity: a track across a cutout is cut ----------------------------------------
{
  const items = [pad("p1", "A", 5, 15), pad("p2", "A", 35, 15), track("t", "A", [5, 15], [35, 15]), {id: "v", kind: "via", x: 20, y: 12, diameter: .6, drill: .3, net: "B", layer: "Multi"}];
  const cut = C.inspect(board(items.map(i => ({...i}))), defs);
  assert.equal(cut.nets.find(n => n.name === "A").islands, 2, "the track is severed by the cutout");
  assert.equal(cut.airwires.filter(w => w.net === "A").length, 1);
  assert.ok(!cut.nets.some(n => n.name === "B"), "a via inside the cutout is no copper");
  const plain = {id: "b", kind: "pcb", name: "Plain", grid: 1, outline, notes: [], items: items.map(i => ({...i}))};
  assert.equal(C.inspect(plain, defs).nets.find(n => n.name === "A").islands, 1, "without the cutout the track joins both pads");
}

// ---- DRC: Board Outline Clearance against outline and cutouts ----------------------------------
{
  const doc = board([pad("near", "A", 14.7, 15, .4), pad("edge", "A", .3, 5, .4), pad("ok", "A", 8, 5, .4), track("in", "B", [18, 12], [22, 12]), pad("in2", "C", 20, 18, .4)]);
  const rules = R.migrate(R.create());
  // Without a Board Outline Clearance rule (the default) nothing changes.
  assert.equal(R.drc(doc, defs, rules, {types: ["boardOutlineClearance"]}).total, 0);
  assert.ok(R.types.boardOutlineClearance && R.checkedTypes.includes("boardOutlineClearance"));
  rules.list.push({id: "edge-1", type: "boardOutlineClearance", name: "BoardOutlineClearance", comment: "", enabled: true, priority: 1, scope: AtriumDesignQueryRecord.selector("all"), gap: .5});
  R.validate(rules);
  const res = R.drc(doc, defs, rules, {types: ["boardOutlineClearance"]});
  const by = id => res.violations.find(v => v.id === id);
  assert.ok(by("edge"), "pad near the outer edge");
  assert.ok(Math.abs(by("edge").actual - .1) < 1e-6, "0.3 - 0.2 = 0.1 mm to the edge");
  assert.ok(by("near"), "pad near the cutout");
  assert.ok(Math.abs(by("near").actual - .1) < 1e-6, "15 - 14.9 = 0.1 mm to the cutout");
  assert.equal(by("ok"), undefined);
  assert.ok(by("in") && by("in").actual === 0 && /inside a board cutout/.test(by("in").title), "copper in a cutout measures 0");
  assert.ok(by("in2") && by("in2").actual === 0);
  assert.equal(R.drc(doc, defs, rules, {types: ["boardOutlineClearance"]}).rules[0].count, 4);
}

// ---- Altium edge rules include the physical overlay, with one row per primitive ----
{
  for(const name of ["stroke-font", "vectorize", "pcb-text-rich", "pcb-text", "checks", "waivers", "drc-waivers"])
    require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
  const edgeType = "boardOutlineClearance";
  const record = (scope = "All", extra = "") =>
    "RULEKIND=BoardOutlineClearance|NAME=Imported edge|SCOPE1EXPRESSION=" + scope +
    "|SCOPE2EXPRESSION=All|ENABLED=TRUE|PRIORITY=1|GAP=.25mm|GENERICCLEARANCE=.25mm|OBJECTCLEARANCES=" + extra;
  const graphic = (id, layer, points, width = .2) => ({id,kind:"graphic",layer,points,width});
  const arc = {kind:"arc",c:[1.3,4.3],r:1,start:163,end:216,ccw:true};
  const top = graphic("top", "Silk", [[.3,2],[.3,3]]);
  const bottom = graphic("bottom", "Bottom silk", [[.3,8],[.3,9]]);
  const cut = graphic("cutout", "Silk", [[14.7,11],[14.7,12]]);
  const drawing = {id:"text",kind:"label",layer:"Silk",x:-2,y:5,text:"T",size:.5,width:.1};
  const fp = {footprint:{shapes:[
    {kind:"path",style:"silk",points:[[0,0],[1,0]],width:.2},
    {kind:"path",style:"silk",points:[[0,0],[2,0]],width:.2},
  ]}};
  const part = {id:"owner",kind:"part",ref:"P1",def:"two-ink",layer:"Bottom",showRef:false,angle:90,mirror:true,x:.3,y:20};
  const library = new Map([["two-ink",fp]]);
  const doc = board([top,bottom,cut,drawing,part,pad("copper", "N", .3, 25, .2),
    {...graphic("arc", "Silk", A.arcProjection(arc)),arc},
    graphic("mask", "Top mask", top.points), {...graphic("keepout", "Silk", top.points),keepout:true},
    graphic("far", "Silk", [[2,2],[2,3]])]);
  const run = (rules, scopes = false) => R.drc(doc, library, rules, {types:[edgeType],scopes});
  const importRule = scope => R.replaceWithSource(R.migrate(R.create()), [record(scope)], doc).set;
  const native = R.migrate(R.create());
  native.list.push({id:"native-edge",type:edgeType,name:"Native edge",enabled:true,priority:1,
    scope:AtriumDesignQueryRecord.selector("all"),gap:.25});
  assert.deepEqual(run(native).violations.map(v=>v.id), ["copper"]);
  const rules = importRule();
  assert.equal(rules.list.find(r=>r.type===edgeType).includeOverlay, true);
  const result = run(rules);
  assert.deepEqual(result.violations.map(v=>v.id).sort(), ["arc","bottom","copper","cutout","owner","owner","text","top"]);
  const overlayArc = result.violations.find(v=>v.id==="arc");
  assert.equal(overlayArc.subject.kind, "arc");
  assert.ok(Math.abs(overlayArc.actual - .2) < .000015, overlayArc.actual);
  assert.equal(result.violations.find(v=>v.id==="text").actual, 0);
  assert.match(result.violations.find(v=>v.id==="cutout").title, /Board cutout/);
  const slots = result.violations.filter(v=>v.id==="owner");
  assert.deepEqual(slots.map(v=>v.subject.legendPrimitive).sort(), ["shape:0","shape:1"]);
  assert.equal(new Set(slots.map(v=>AtriumChecks.fromDRC(v,doc).key)).size, 2);
  AtriumDRCWaivers.add(doc,slots[0]);
  assert.equal(AtriumDRCWaivers.split(doc,slots).waived.length, 1);
  assert.deepEqual(run(importRule("IsTrack And OnLayer('Top Overlay')")).violations.map(v=>v.id).sort(), ["cutout","top"]);
  assert.deepEqual(run(importRule("OnLayer('Top Layer')")).violations.map(v=>v.id), ["copper"]);
  const textOnly = run(importRule("IsText And OnLayer('Top Overlay')"), true);
  assert.deepEqual(textOnly.violations.map(v=>v.id), ["text"]);
  assert.equal(textOnly.emptyScopes.length, 0);
  assert.equal(R.fromAltium(record("All", "ClearanceObj_Track-ClearanceObj_OutlineEdge:0"),doc).rule, null);
  assert.equal(R.fromAltium(record("All", "ClearanceObj_Other-ClearanceObj_CavityEdge:0"),doc).rule, null);
  assert.equal(R.fromAltium(record("All", "ClearanceObj_Track-ClearanceObj_CavityEdge:0"),doc).rule.includeOverlay, true);
  assert.equal(R.fromAltium(record().replace("SCOPE2EXPRESSION=All", "SCOPE2EXPRESSION=IsTrack"),doc).rule, null);
  assert.equal(R.fromAltium(record().replace("GENERICCLEARANCE=.25mm", "GENERICCLEARANCE=.3mm"),doc).rule, null);
  const zero = importRule();
  zero.list.find(r=>r.type===edgeType).gap = 0;
  assert.equal(run(zero).total, 0);
}

// ---- polygon pours leave the cutout empty ---------------------------------------------------------
{
  const doc = board();
  const poly = P.make(outline, {id: "pour", layer: "Top", net: "GND", boardClearance: .3, removeDeadCopper: false});
  doc.items.push(poly);
  const regions = P.pour(doc, defs, poly);
  assert.ok(regions.length >= 1);
  const inside = (pt, rings) => {
    let n = 0;
    for (const r of rings) { let c = false; for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) { const ax = r[i], ay = r[i + 1], bx = r[j], by = r[j + 1]; if ((ay > pt[1]) !== (by > pt[1]) && pt[0] < (bx - ax) * (pt[1] - ay) / (by - ay) + ax) c = !c; } if (c) n++; }
    return n % 2 === 1;
  };
  const all = regions.map(r => P.rings(r).map(x => Array.from(x)));
  assert.ok(all.some(rings => inside([5, 5], rings)), "copper on the board");
  assert.ok(!all.some(rings => inside([20, 15], rings)), "no copper in the cutout");
  assert.ok(!all.some(rings => inside([14.85, 15], rings)), "board clearance around the cutout");
  // The cutout is part of the pour signature, so editing it makes pours stale.
  const sig = P.polygonSignatures(doc, defs).pour;
  const other = board(); other.items.push(poly);
  S.apply(other, S.addCutout(S.fromPolygon(other.outline), S.fromPolygon([[15, 10], [26, 10], [26, 20], [15, 20]]).contour), "test");
  assert.notEqual(P.polygonSignatures(other, defs).pour, sig);
  const none = {id: "b", kind: "pcb", name: "Plain", grid: 1, outline, notes: [], items: [poly]};
  const noneSig = P.polygonSignatures(none, defs).pour;
  delete none.boardShape;
  assert.equal(P.polygonSignatures(none, defs).pour, noneSig, "boards without cutouts keep their signature");
}

// ---- router: cutouts are outside the board ---------------------------------------------------------
{
  const RC = AtriumRouter.core || AtriumRouter;
  const W = RC.buildWorld(board(), defs);
  assert.equal(RC.insideOutline(W, 5, 5), true);
  assert.equal(RC.insideOutline(W, 20, 15), false, "inside the cutout is off the board");
  assert.ok(W.owners.filter(o => o.kind === "outline").length >= 2, "cutout edges are outline obstacles");
}

// ---- autorouter: a connection across the cutout routes around it --------------------------------------
{
  const doc = board([pad("a", "N", 10, 15), pad("b", "N", 30, 15)]);
  doc.layers = undefined;
  const plan = AtriumAutorouter.routeBoard(doc, defs, {});
  AtriumAutorouter.apply(doc, plan);
  const routed = doc.items.filter(i => i.kind === "track" && i.net === "N");
  assert.ok(routed.length, "routed");
  for (const t of routed) for (let k = 1; k < t.points.length; k++) {
    for (const [a, b] of S.clipOutsideCutouts(doc, t.points[k - 1], t.points[k])) assert.ok(a && b);
    const pieces = S.clipOutsideCutouts(doc, t.points[k - 1], t.points[k]);
    const len = ([p, q]) => Math.hypot(q[0] - p[0], q[1] - p[1]);
    assert.ok(Math.abs(pieces.reduce((s, x) => s + len(x), 0) - len([t.points[k - 1], t.points[k]])) < 1e-6, "no routed segment enters the cutout");
  }
}

// ---- Altium import: ISBOARDCUTOUT regions -----------------------------------------------------------------
{
  const unit = .00000254;
  const props = text => { const raw = Buffer.from("|" + text + "\0", "latin1"), length = Buffer.alloc(4); length.writeUInt32LE(raw.length); return Buffer.concat([length, raw]); };
  function region(points, extra) {
    const main = Buffer.alloc(18); main[0] = 1; main.writeUInt16LE(65535, 3); main.writeUInt16LE(65535, 5); main.writeUInt16LE(65535, 7);
    const raw = Buffer.alloc(4 + 16 * points.length); raw.writeUInt32LE(points.length);
    points.forEach(([x, y], i) => { raw.writeDoubleLE(x / unit, 4 + 16 * i); raw.writeDoubleLE(-y / unit, 12 + 16 * i); });
    const data = Buffer.concat([main, props("KIND=0|V7_LAYER=MULTILAYER" + extra), raw]), header = Buffer.alloc(5);
    header[0] = 11; header.writeUInt32LE(data.length, 1); return Buffer.concat([header, data]);
  }
  const perimeter = "VX0=0mm|VY0=0mm|VX1=40mm|VY1=0mm|VX2=40mm|VY2=-30mm|VX3=0mm|VY3=-30mm";
  const streams = new Map([["board6/data", props(perimeter)], ["nets6/data", props("NAME=GND")],
    ["regions6/data", Buffer.concat([region(hole, "|ISBOARDCUTOUT=TRUE"), region([[1, 1], [2, 1], [2, 2]], "")])]]);
  const doc = AtriumPCB.read("Cut.PcbDoc", streams, null, {}).documents[0];
  assert.ok(doc.boardShape, "a board shape carries the cutout");
  const holes = S.holes(doc);
  assert.equal(holes.length, 1, "only the ISBOARDCUTOUT region is a cutout");
  assert.equal(S.inCutout(doc, [20, 15]), true);
  assert.ok(doc.notes.some(n => /1 board cutout imported/.test(n)));
  assert.ok(A.validate({...A.project("Imported"), documents: [doc], library: []}));
}

// ---- drill and pick-and-place follow doc.origin --------------------------------------------------------------
{
  const project = AtriumParts.example(), doc = project.documents[1], F = AtriumFabOutputs, date = new Date("2026-01-01T00:00:00Z");
  const via = doc.items.find(i => i.kind === "via"), r1 = doc.items.find(i => i.ref === "R1");
  const drillHit = files => {
    const text = files.find(f => /\.TXT$/.test(f.name) && /T\d+C/.test(f.content)).content;
    return text.split("\n").filter(l => /^X-?[\d.]+Y-?[\d.]+$/.test(l)).map(l => l.match(/^X(-?[\d.]+)Y(-?[\d.]+)$/).slice(1).map(Number));
  };
  const pnpRow = files => files.find(f => f.kind === "pnp" || /Pick Place/.test(f.name)).content.split("\n").find(l => l.includes("R1"));
  doc.origin = [via.x - 1, via.y + 2];
  const out = F.build(project, doc, {date, drillFormat: "decimal", drillUnits: "mm"}).files;
  assert.ok(drillHit(out).some(([x, y]) => Math.abs(x - 1) < 1e-3 && Math.abs(y - 2) < 1e-3), "drill X/Y are relative to doc.origin (Y up)");
  const row = pnpRow(out);
  assert.ok(row && row.includes((r1.x - doc.origin[0]).toFixed(2)), "pick and place X is relative to doc.origin: " + row);
  const absolute = F.build(project, doc, {date, origin: "absolute", drillFormat: "decimal", drillUnits: "mm"}).files;
  assert.ok(drillHit(absolute).some(([x, y]) => Math.abs(x - via.x) < 1e-3 && Math.abs(y + via.y) < 1e-3), "absolute ignores the origin");
}
console.log("board cutouts: connectivity, DRC, pours, router, autorouter, import and origin OK");
