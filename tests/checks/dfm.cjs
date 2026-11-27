"use strict";
// DFM Check (app/checks/dfm.js) against JLCPCB preset limits: every check finds a crafted fault
// (positive) and stays quiet on the same board built correctly (negative). Also the incremental
// cache, the Messages rows, the release gate and the speed on a large board.
// Run: scripts/test-jsc.sh dfm   (or node tests/checks/dfm.cjs)
const assert = require("node:assert/strict");
const {cpuNow: now, retryTiming} = require("../analysis/timing-check.js");
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "pcb-text-rich", "pcb-text", "designator-place", "board-shape", "hierarchy", "component-classes", "query", "stackup", "rules", "viastack",
  "polygon-pour", "fab-presets", "fab-presets/jlcpcb", "diagnostics", "dfm"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const D = AtriumDFM, FP = AtriumFabPresets, PP = AtriumPolygonPour;
const L = FP.limits("jlcpcb-2l");
const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const board = (items, extra = {}) => ({id: "b", kind: "pcb", name: "DFM", items, outline: rect(0, 0, 50, 40), grid: .25, notes: [], ...extra});
const track = (id, points, net = "A", width = .25, layer = "Top") => ({id, kind: "track", points, width, layer, net});
const via = (id, x, y, diameter = .6, drill = .3, net = "A") => ({id, kind: "via", x, y, diameter, drill, layer: "Multi", net});
const smd = (id, x, y, w = 1, h = 1, net = "A") => ({id, kind: "pad", number: "1", x, y, w, h, shape: "rect", layer: "Top", net});
const tht = (id, x, y, w, drill, net = "A", plated = true) => ({id, kind: "pad", number: "1", x, y, w, h: w, shape: "round", layer: "Multi", drill, net, plated});
const run = (items, check, extra, o = {}) => D.run(board(items, extra), new Map(), L, {checks: [check], ...o}).issues.filter(i => i.check === check);
const pair = (check, bad, good, extra, o) => {
  const p = run(bad, check, extra, o), n = run(good, check, extra, o);
  assert.ok(p.length > 0, check + ": the fault is found");
  assert.equal(n.length, 0, check + ": no false positive: " + JSON.stringify(n.map(i => i.text)));
  for (const i of p) { assert.ok(i.fix && i.title, check + " has a title and a fix"); assert.ok(i.at, check + " has a location"); }
  return p;
};

// ---- the limits come from the preset data (with sources)
assert.equal(L.track, .1); assert.equal(L.npthMin, .5); assert.equal(L.vScoreClearance, .4); assert.equal(L.pthRing, .18);
assert.equal(FP.limits("jlcpcb-4l").track, .09, "multilayer track");

// 1. acid traps: a 45° corner (tight) against a 135° corner.
pair("acid", [track("t", [[5, 5], [15, 5], [7, 10]])], [track("t", [[5, 5], [15, 5], [22, 12]])]);
//    and a T-junction meeting at 45°
pair("acid", [track("a", [[5, 20], [25, 20]]), track("b", [[15, 20], [25, 30]], "A")], [track("a", [[5, 20], [25, 20]]), track("b", [[15, 20], [15, 30]], "A")]);
// 2. copper slivers: a 0.05 mm copper line.
{
  const recording = AtriumDiagnostics.startPerformance();
  try {
    pair("sliver", [track("t", [[5, 5], [15, 5]], "A", .05)], [track("t", [[5, 5], [15, 5]], "A", .2)]);
    const row = AtriumDiagnostics.performanceSnapshot().rows.find(row => row.component === "dfm" && row.operation === "check");
    assert.equal(row.counts.started, 2);
    assert.equal(row.counts.completed, 2, "a real finding is still a successfully run check");
    assert.ok(Number.isFinite(row.runP95));
  } finally { recording.stop(); }
}
// 3. annular ring: via ring 0.04 (< 0.05), PTH ring 0.1 (< 0.18); good: 0.3/0.6 via, 1.0/1.8 pad.
pair("ring", [via("v", 10, 10, .38, .3)], [via("v", 10, 10, .6, .3)]);
const ring = pair("ring", [tht("p", 10, 10, 1.2, 1)], [tht("p", 10, 10, 1.8, 1)]);
assert.equal(ring[0].level, "error");
// Fabrication uses the nominal PTH size. DRC measures the smallest actual land.
{
  const p=tht("stack",10,10,1.8,.8);
  p.stackMode="full";p.padStack={Top:{w:1.02}};
  assert.equal(run([p],"ring").length,0,"good nominal fabrication ring");
  const holes=AtriumRules.kit.extract(board([p]),new Map(),{physical:true}).holes;
  assert.ok(Math.abs(holes[0].ring-.11)<1e-9,"actual copper ring takes the narrower Top row");
}
//    at drill tolerance: ring 0.12 meets no minimum here but breaks out at +0.13 / ±0.075.
const tol = run([tht("p", 10, 10, 1.24, 1)], "ring", {}, {});
assert.equal(D.run(board([tht("p", 10, 10, 1.24, 1)]), new Map(), {...L, pthRing: .1}, {checks: ["ring"]}).issues[0].level, "warning", "breakout at tolerance is a warning");
assert.ok(tol.length);
//    a slotted pad: the ring is what the slot leaves of the land (the DRC's annular ring), not (min(w, h) - drill) / 2.
{
  const slot = {...tht("s", 10, 10, 2, .8), shape: "rect", slotLength: 2.2};
  const bad = run([slot], "ring");
  assert.equal(bad[0]?.actual, 0, "the slot breaks out of the land");
  assert.equal(AtriumRules.drc(board([slot]), new Map(), AtriumRules.create(), {types: ["annularRing"]}).violations[0].actual, 0, "as the DRC");
  assert.equal(run([{...slot, slotLength: 1.4}], "ring").length, 0);
}
// 4. silkscreen over a pad, and silk far from it.
const silk = (id, pts) => ({id, kind: "graphic", layer: "Silk", points: pts, width: .2});
pair("silkPad", [smd("p", 10, 10), silk("s", [[9, 10], [11, 10]])], [smd("p", 10, 10), silk("s", [[9, 12], [11, 12]])]);
{
  const S=AtriumBoardShape, outer=rect(8,8,14,14), hole=rect(10,10,12,12);
  const legend={...silk("fill",outer),fill:true,width:0,
    regionShape:{version:1,contour:S.fromPolygon(outer).contour,cutouts:[S.fromPolygon(hole).contour],sig:S.signature(outer)}};
  const findings=run([legend,smd("ink",9,11),smd("counter",11,11)],"silkPad");
  assert.deepEqual(findings.map(issue=>[issue.id,issue.otherId,issue.actual]),[["fill","ink",0]],"filled ink surrounds a clear counter");
  assert.deepEqual(run([{...legend,polarity:"clear"},smd("ink",9,11)],"silkPad"),[],"clear-only artwork adds no ink");
}
// 5. mask web: SMD pads 0.05 mm apart (web below 0.1 mm); good at 0.5 mm.
pair("maskWeb", [smd("p1", 10, 10), {...smd("p2", 11.05, 10), net: "B"}], [smd("p1", 10, 10), {...smd("p2", 11.5, 10), net: "B"}]);
{
  const blind={...via("blind",10,10),fromLayer:"Inner 1",toLayer:"Bottom",maskExpansion:0};
  const plated={...via("plated",10.65,10),maskExpansion:0};
  const findings=run([blind,plated],"maskWeb");
  assert.deepEqual(findings.map(issue=>[issue.maskSide,Math.round(issue.actual*100)]),[["bottom",5]],"the blind via opens only on its occupied outer face");
  assert.deepEqual(run([{...blind,tent:{bottom:true}},plated],"maskWeb"),[],"explicit physical tenting covers the opening");
}
//    mask sliver: an opening 0.05 mm from the board edge.
pair("maskSliver", [smd("p", 49.45, 10)], [smd("p", 45, 10)]);
//    trace near a mask opening (0.05 mm < 0.09 mm).
pair("maskTrace", [smd("p", 10, 10), track("t", [[10.5 + .05 + .125, 5], [10.5 + .05 + .125, 15]], "B")], [smd("p", 10, 10), track("t", [[11.5, 5], [11.5, 15]], "B")]);
// 6. drill to copper: via hole 0.1 mm from another net's track (< 0.2); good at 0.5 mm.
pair("drillCopper", [via("v", 10, 10, .6, .3), track("t", [[10.15 + .1 + .125, 5], [10.15 + .1 + .125, 15]], "B")],
  [via("v", 10, 10, .6, .3), track("t", [[11.2, 5], [11.2, 15]], "B")]);
//    the via's own net touching it is fine
assert.equal(run([via("v", 10, 10), track("t", [[10, 10], [20, 10]], "A")], "drillCopper").length, 0);
//    copper wholly inside a hole is measured to the hole wall, as the DRC's bore: a track on a slot's centreline
//    is 0.9 mm from the wall; one crossing the wall meets the drill.
{
  const slotted = {...tht("p", 10, 10, 3, 2), w: 7, shape: "rect", slotLength: 5};
  assert.equal(run([slotted, track("t", [[9, 10], [11, 10]], "B", .2)], "drillCopper").length, 0, "0.9 mm to the slot wall");
  assert.match(run([slotted, track("t", [[11, 9], [11, 11]], "B", .2)], "drillCopper")[0]?.text || "", /: 0 mm/);
  assert.equal(run([via("v", 10, 10, 2, 1.4), smd("p", 10, 10, .2, .2, "B")], "drillCopper").length, 0, "inside a round hole");
}
//    a back-drilled via has no land beyond its stop layer (AtriumViaStack.padOn, as the DRC).
{
  const four = {stackup: {version: 1, layers: AtriumStackup.preset("4").layers}};
  const drilled = {...via("v", 10, 10, .6, .3), fromLayer: "Top", toLayer: "Bottom", backdrill: {from: "bottom", toLayer: "Inner 1", stubMax: .1}};
  const blind = {...via("b", 10.55, 10, .2, .2, "B"), fromLayer: "Inner 2", toLayer: "Bottom"};
  assert.equal(run([drilled, blind], "drillCopper", four).length, 0, "no land left on Inner 2 or Bottom");
  assert.equal(run([{...drilled, backdrill: undefined}, blind], "drillCopper", four).length, 1);
}
//    an unplated hole's land is copper of its pad's net (as the DRC and connectivity): a via hole 0.1 mm from
//    a GND mounting hole's ring is too close unless it is on GND; with no net it is copper all the same.
{
  const mh = tht("mh", 20, 20, 6, 3.2, "GND", false), near = net => via("v", 23.25, 20, .6, .3, net);
  assert.deepEqual(run([mh, near("VCC")], "drillCopper").map(i => i.text), ["Via hole to Pad 1 (GND): 0.1 mm, minimum 0.2 mm."]);
  assert.equal(run([mh, near("GND")], "drillCopper").length, 0, "its own net");
  assert.equal(run([{...mh, net: ""}, near("VCC")], "drillCopper").length, 1, "a netless land");
  assert.equal(run([{...mh, w: 3.2, h: 3.2}, near("VCC")], "drillCopper").length, 0, "no land left around the drill");
}
//    drill to edge: a hole 0.2 mm from the board edge.
pair("drillEdge", [tht("p", 49.3, 20, 1.6, 1)], [tht("p", 45, 20, 1.6, 1)]);
//    pad hole to hole: 0.3 mm apart (< 0.45).
pair("holeToHole", [tht("p1", 10, 10, 1.2, .8), {...tht("p2", 11.1, 10, 1.2, .8), id: "p2"}], [tht("p1", 10, 10, 1.6, .8), {...tht("p2", 12.54, 10, 1.6, .8), id: "p2"}]);
// 7. min hole: a 0.4 mm NPTH (< 0.5) and a 0.1 mm plated hole (< 0.15).
pair("minHole", [tht("n", 10, 10, .4, .4, "", false)], [tht("n", 10, 10, .6, .6, "", false)]);
pair("minHole", [via("v", 10, 10, .4, .1)], [via("v", 10, 10, .45, .2)]);
// 8. unplated slot: a 0.6 mm wide routed cutout (< 1.0 mm).
const BS = AtriumBoardShape, withCutout = w => { const o = rect(0, 0, 50, 40), s = BS.fromPolygon(o); s.cutouts = [BS.fromPolygon(rect(20, 10, 20 + w, 30)).contour]; return {outline: o, boardShape: s}; };
assert.equal(BS.holes(board([], withCutout(.6))).length, 1, "the cutout is read");
{
  const p = D.run(board([], withCutout(.6)), new Map(), L, {checks: ["slot"]}).issues, n = D.run(board([], withCutout(3)), new Map(), L, {checks: ["slot"]}).issues;
  assert.equal(p.length, 1); assert.equal(n.length, 0); assert.match(p[0].text, /0\.6 mm wide/);
}
// 9. starved thermals: other-net tracks cut three of four spokes (as tests/pcb/polygon-connect.cjs).
{
  const make = cut => {
    const tp = {id: "tp", kind: "pad", number: "1", x: 20, y: 20, w: 1.6, h: 1.6, drill: .9, shape: "round", layer: "Multi", net: "GND"};
    const cuts = cut ? [[[16, 19.0], [24, 19.0]], [[16, 21.0], [24, 21.0]], [[21.0, 16], [21.0, 24]]].map((p, i) => track("c" + i, p, "SIG" + i, .2)) : [];
    const poly = PP.make(rect(2, 2, 48, 38), {net: "GND", connectStyle: "relief", removeDeadCopper: false});
    const doc = board([tp, ...cuts, via("va", 10, 10, .6, .3, "GND"), poly], {rules: AtriumRules.create()});
    PP.apply(doc, new Map());
    return doc;
  };
  const p = D.run(make(true), new Map(), L, {checks: ["thermal"]}).issues, n = D.run(make(false), new Map(), L, {checks: ["thermal"]}).issues;
  assert.equal(p.length, 1); assert.equal(p[0].id, "tp"); assert.match(p[0].text, /1 of 4 relief spokes/); assert.equal(n.length, 0);
}
// 10. panel: copper 0.2 mm from a V-score line (< 0.4); mouse bites use the bite edge clearance.
{
  const panel = sep => ({documents: [{id: "b"}, {id: "pn", kind: "panel", name: "Panel", items: [], panel: {version: 1, board: "b", separation: sep, tabs: {hole: .5}}}]});
  const bad = [track("t", [[5, 39.6], [40, 39.6]], "A", .2)], good = [track("t", [[5, 38], [40, 38]], "A", .2)];
  const p = D.run(board(bad), new Map(), L, {checks: ["panel"], project: panel("vscore")}).issues, n = D.run(board(good), new Map(), L, {checks: ["panel"], project: panel("vscore")}).issues;
  assert.equal(p.length, 1); assert.equal(p[0].level, "error"); assert.match(p[0].text, /V-score/); assert.equal(n.length, 0);
  assert.equal(D.run(board(bad), new Map(), L, {checks: ["panel"]}).issues.length, 0, "no panel, no panel check");
  const mb = D.run(board(bad), new Map(), L, {checks: ["panel"], project: panel("mousebite")});
  assert.equal(mb.issues[0].level, "warning"); assert.ok(mb.notes.some(t => /tabs/.test(t)));
}
// 11. small text: 0.8 mm text (< 1.0); stroke thinner than 1:6.
const label = (id, size, width) => ({id, kind: "label", layer: "Silk", text: "R1", x: 10, y: 10, size, ...(width ? {width} : {})});
pair("text", [label("l", .8)], [label("l", 1.2, .2)]);
pair("text", [label("l", 1.2, .16)], [label("l", 1.2, .25)]);
pair("text", [silk("s", [[5, 5], [10, 5]]), {id: "s2", kind: "graphic", layer: "Silk", points: [[5, 8], [10, 8]], width: .1}], [silk("s", [[5, 5], [10, 5]])]);

// ---- every check id has a positive case above
const covered = ["acid", "sliver", "ring", "silkPad", "maskWeb", "maskSliver", "maskTrace", "drillCopper", "drillEdge", "holeToHole", "minHole", "slot", "thermal", "panel", "text"];
assert.deepEqual(D.CHECKS.map(c => c.id).sort(), [...covered].sort());

// ---- footprints: pads of a placed part, rotated
{
  const defs = new Map([["r", {id: "r", footprint: {pads: [{number: "1", x: -.5, y: 0, w: .95, h: .6, shape: "rect"}, {number: "2", x: .5, y: 0, w: .95, h: .6, shape: "rect"}], shapes: [{kind: "line", layer: "Silk", points: [[-.5, 0], [.5, 0]], width: .2}]}}]]);
  const doc = board([{id: "u", kind: "part", ref: "R1", def: "r", x: 10, y: 10, angle: 90, layer: "Top", pinNets: {1: "A", 2: "B"}}]);
  const r = D.run(doc, defs, L, {checks: ["silkPad", "maskWeb"]});
  assert.ok(r.issues.some(i => i.check === "silkPad"), "footprint silk over its pads");
  assert.ok(r.issues.some(i => i.check === "maskWeb" && /R1-1/.test(i.text) && /R1-2/.test(i.text)), "web between pads of a part: " + JSON.stringify(r.issues.map(i => i.text)));
}

// Native annotation visibility and placement are the same after a cached rerun.
{
  const sourceRecord="components6/data#2", part={id:"body",kind:"part",ref:"F2",value:"Hidden",def:"empty",x:10,y:10,sourceRecord,showValue:false};
  const defs=new Map([["empty",{id:"empty",footprint:{pads:[],shapes:[]}}]]);
  const ref={field:"ref",at:[4,2],angle:0,size:.8,width:.2,layer:"Bottom silk"};
  const annotations={[sourceRecord]:[ref,{...ref,field:"value",at:[5,2]}]};
  const doc=board([part],{pcbDrawing:{annotations}}), cache=D.createCache(), options={cache,checks:["text"]};
  const before=D.run(doc,defs,L,options);
  assert.equal(before.issues.length,1,"the source ref is visible and the source value is hidden");
  assert.match(before.issues[0].text,/F2/);
  assert.deepEqual(D.run(doc,defs,L,options).issues,before.issues);
  ref.at=[7,2];
  const after=D.run(doc,defs,L,options);
  assert.equal(after.rebuilt,1);
  assert.deepEqual(after.issues[0].at,[before.issues[0].at[0]+3,before.issues[0].at[1]]);
  assert.deepEqual(D.run(board([part]),defs,L,{checks:["text"]}).issues,[],"the generated default reference follows existing DFM policy");
  part.designator={x:0,y:0,angle:0,height:.8};
  const managed=D.run(doc,defs,L,options).issues;
  assert.equal(managed.length,1,"the managed designator replaces the source reference");
  assert.match(managed[0].text,/F2/);
  assert.ok(managed[0].at[0]<after.issues[0].at[0]);
}

// ---- incremental: an unchanged board reuses every object; one edit rebuilds one
{
  const items = Array.from({length: 50}, (_, i) => track("t" + i, [[1, i * .7 + 1], [40, i * .7 + 1]], "N" + i, .2));
  const doc = board(items), cache = D.createCache();
  const a = D.run(doc, new Map(), L, {cache});
  assert.equal(a.rebuilt, 50);
  const b = D.run(doc, new Map(), L, {cache});
  assert.equal(b.reused, 50); assert.equal(b.rebuilt, 0); assert.deepEqual(b.issues, a.issues);
  doc.items[3] = {...doc.items[3], width: .05};
  const c = D.run(doc, new Map(), L, {cache});
  assert.equal(c.rebuilt, 1); assert.ok(c.issues.some(i => i.check === "sliver" && i.id === "t3"));
}

// ---- one cache across rule selections, shared footprint edits and shape-only requests
{
  const pad = {number: "1", x: 0, y: 0, w: 1.2, h: 1.2, drill: .3, layer: "Multi"};
  const defs = new Map([["pkg", {id: "pkg", footprint: {pads: [pad], shapes: []}}]]);
  const placed = id => ({id, kind: "part", ref: id, x: id === "P1" ? 10 : 20, y: 10, def: "pkg"});
  const doc = board([placed("P1"), placed("P2"), track("thin", [[2, 2], [4, 2]], "A", .05)], withCutout(.6));
  const cache = D.createCache();
  const check = checks => {
    const actual = D.run(doc, defs, L, {cache, checks}), full = D.run(doc, defs, L, {checks});
    assert.deepEqual(actual.issues, full.issues);
    assert.deepEqual(actual.notes, full.notes);
    assert.deepEqual(actual.counts, full.counts);
    return actual;
  };
  assert.equal(check(["sliver"]).byCheck.sliver, 1);
  assert.deepEqual(check(["minHole"]).issues, [], "a narrower check excludes the previous rule's findings");
  pad.drill = .05;
  const changed = check(["minHole"]);
  assert.equal(changed.rebuilt, 2, "both placements follow an in-place footprint edit");
  assert.equal(changed.byCheck.minHole, 2);
  assert.equal(check(["minHole", "sliver"]).byCheck.sliver, 1);
  const shape = {...doc, get items() { throw Error("shape-only checks traversed board items"); }};
  const noLibrary = {get library() { throw Error("shape-only checks traversed the library"); }};
  const contour = D.run(shape, null, L, {project: noLibrary, cache, checks: ["slot", "thermal"]});
  assert.equal(contour.byCheck.slot, 1); assert.equal(contour.reused + contour.rebuilt, 0);
  pad.drill = .3;
  assert.equal(check(undefined).byCheck.minHole, undefined, "restoring the footprint clears its issues");
}

// ---- Messages rows: zoom-to object and point, the fix in the text, a summary row
{
  const doc = board([via("v", 10, 10, .38, .3)]), r = D.run(doc, new Map(), L, {});
  const rows = D.messages(r, doc);
  const e = rows.find(m => m.class === "Error");
  assert.equal(e.objectId, "v"); assert.deepEqual(e.point, [10, 10]); assert.match(e.text, /Fix: /); assert.match(e.source, /^DFM · /);
  assert.match(rows.at(-1).text, /Limits from JLCPCB 2-layer \(cheapest\)/);
}

// ---- release gate: only with a preset (or a vendor package), fail on errors
{
  const check = (id, label, status, summary, items = [], fix = null) => ({id, label, status, summary, items, fix});
  const project = {documents: [board([via("v", 10, 10, .38, .3)])], library: []};
  assert.equal(D.releaseGate(project, {name: "x", outputs: []}, check), null, "no preset, no gate");
  const g = D.releaseGate(project, {name: "x", package: {mode: "vendor", vendor: "JLCPCB"}, outputs: []}, check);
  assert.equal(g.id, "dfm"); assert.equal(g.status, "fail"); assert.equal(g.items[0].target.id, "v"); assert.equal(g.fix.action, "dfm-check");
  project.documents[0].fabPreset = FP.recordOf(FP.get("jlcpcb-2l"));
  project.documents[0].items = [via("v", 10, 10, .6, .3)];
  assert.equal(D.releaseGate(project, {name: "x", outputs: []}, check).status, "pass");
  assert.equal(D.releaseGate(project, {name: "x", gates: {dfm: false}, outputs: []}, check), null, "the gate can be turned off");
}

// ---- speed: cold and incremental checks on a 20k-object board (spatial index)
{
  const items = [];
  for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) {
    items.push(via("v" + i + "_" + j, 2 + i * 1.4, 2 + j * 1.4, .6, .3, "N" + i));
    items.push(track("t" + i + "_" + j, [[2 + i * 1.4, 2 + j * 1.4], [2.5 + i * 1.4, 2.5 + j * 1.4]], "N" + i, .2));
  }
  const doc = board(items, {outline: rect(0, 0, 145, 145)});
  const {issues, first, second} = retryTiming(() => {
    const cache = D.createCache(), defs = new Map();
    const t0 = now(), initial = D.run(doc, defs, L, {cache}), first = now() - t0;
    const t1 = now(), repeated = D.run(doc, defs, L, {cache}), second = now() - t1;
    assert.deepEqual(repeated.issues, initial.issues);
    return {issues: initial.issues, first, second};
  }, ({first, second}) => {
    if (!(first < 8000)) return "DFM first run " + first.toFixed(1) + " ms (budget < 8000 ms)";
    return second <= first ? "" : "DFM incremental re-run " + second.toFixed(1) + " ms vs " + first.toFixed(1) + " ms cold";
  });
  console.log("dfm: 20000 objects, " + issues.length + " issues, first " + first.toFixed(1) + " ms, re-run " + second.toFixed(1) + " ms");
}
console.log("dfm: ok");
