"use strict";
// Pour clearance verification (app/checks/drc-pours.js): poured copper against
// the Clearance rules. A polygon poured with its own clearance below the rule is reported (both the
// polygon setting and every place its fill comes too close); stale fill that an edit left under other
// copper is reported; a pour that keeps the rule is clean; fab outputs verify before they are made.
// Run: scripts/test-jsc.sh drc-pours   (or node tests/checks/drc-pours.cjs)
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "net-ties", "parts", "spatial", "board-shape", "stackup", "pcb-pours", "pcb-appearance", "altium-rules", "pcb-draw", "component-classes", "net-intent", "signals",
  "rules", "project-rules", "viastack", "polygon-pour", "zip", "vectorize", "pcb-text-rich", "pcb-text", "designator-place", "fab-outputs", "diagnostics", "drc-pours", "drc"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, P = AtriumDRCPours, PP = AtriumPolygonPour, R = AtriumRules;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const rules = gap => ({...R.defaults(), defaults: {...R.defaults().defaults, clearance: gap}});
function board(own) {
  const d = A.sheet("pcb", "Board");
  d.outline = [[0, 0], [30, 0], [30, 20], [0, 20]];
  d.items = [
    {...PP.make([[2, 2], [28, 2], [28, 18], [2, 18]], {net: "GND", layer: "Top", pourIndex: 0, removeDeadCopper: false, ...(own != null ? {clearance: own} : {})}), id: "pour"},
    {id: "sig", kind: "track", net: "SIG", layer: "Top", width: .25, points: [[8, 10], [22, 10]]}];
  return d;
}
const pour = (d, gap) => { d.rules = rules(gap); const r = PP.repourAll(d, new Map(), {reuse: false}); d.pcbDrawing = {...(d.pcbDrawing || {}), pours: r.regions}; return d; };

test("a pour that keeps the rule is clean", () => {
  const d = pour(board(), .2);
  assert.ok(d.pcbDrawing.pours.length > 0, "the polygon poured");
  const r = P.verify(d, new Map(), rules(.2));
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations.map(v => v.title + " " + v.actual)));
  assert.ok(r.checked > 0);
});

test("a polygon poured with its own clearance below the rule is reported, setting and copper", () => {
  const d = pour(board(.1), .2);
  const r = P.verify(d, new Map(), rules(.2));
  const own = r.violations.find(v => v.what === "Polygon clearance"), near = r.violations.filter(v => v.what === "Pour clearance");
  assert.ok(own && own.actual === .1 && own.required === .2, "the polygon's clearance 0.1 mm is below the 0.2 mm rule");
  assert.ok(near.length >= 1 && near.every(v => v.otherId === "sig" && v.id === "pour"), "its fill comes too close to the SIG track");
  assert.ok(Math.abs(near[0].actual - .1) < .02, "about 0.1 mm: " + near[0].actual);
  assert.equal(near[0].type, "pourClearance");
});

test("batch tallies regular and poured copper under the same rule and cap", () => {
  const d = pour(board(.1), .2), D = AtriumDRC, defs = new Map(), book = rules(.2);
  d.items.push({id: "late", kind: "via", net: "SIG", layer: "Multi", x: 15, y: 5, diameter: .6, drill: .3},
    {id: "sig2", kind: "track", net: "OTHER", layer: "Top", width: .25, points: [[8, 10.3], [22, 10.3]]});
  const types = ["clearance"], base = D.run(d, defs, book, {types}), pours = P.verify(d, defs, book).violations;
  assert.ok(base.violations.length && pours.length > 1);
  let reported;
  const recording = AtriumDiagnostics.startPerformance();
  let full;
  try {
    full = D.batch(d, defs, book, {types, onPours: v => reported = v});
    const rows = AtriumDiagnostics.performanceSnapshot().rows;
    assert.equal(rows.length,1,"manual DRC records the combined clearance check once");
    assert.equal(rows[0].component,"drc");
    assert.equal(rows[0].operation,"check");
    assert.equal(rows[0].counts.completed,1);
  } finally { recording.stop(); }
  assert.deepEqual(full.violations, [...base.violations, ...pours]);
  assert.deepEqual(reported, pours);
  assert.equal(full.total, base.total + pours.length);
  assert.equal(full.rules[0].count, full.total);

  const capped = D.batch(d, defs, book, {types, limit: 1, onPours: v => reported = v});
  assert.equal(capped.total, full.total);
  assert.equal(capped.rules[0].count, full.total);
  assert.deepEqual(capped.violations, base.violations.slice(0, 1));
  assert.deepEqual(reported, []);
});

test("stale fill under other copper is reported", () => {
  const d = pour(board(), .2);
  d.items.push({id: "late", kind: "via", net: "SIG", layer: "Multi", x: 15, y: 5, diameter: .6, drill: .3}); // after the pour, without a repour
  const r = P.verify(d, new Map(), rules(.2));
  const v = r.violations.find(x => x.otherId === "late");
  assert.ok(v, "the via sits in the poured copper"); assert.equal(v.actual, 0);
});

test("a pour keeps the DRC's gap to an unplated land of another net, and clear of its own net's", () => {
  // The land keeps its pad's net (connectivity.js, rules.js extract): the pour clears it by the rule for that net.
  const set = R.create(), scope = AtriumDesignQueryRecord.selector;
  set.list.unshift({id: "mh-gap", type: "clearance", name: "MH", comment: "", enabled: true, priority: 1, scope: scope("net", "MH"), scope2: scope("all"), gap: .6});
  R.validate(set);
  const mh = net => ({id: "mh", kind: "pad", number: "1", net, x: 15, y: 15, w: 4, h: 4, shape: "round", layer: "Multi", drill: 2, plated: false});
  const make = net => { const d = board(); d.items.push(mh(net)); d.rules = set; d.pcbDrawing = {pours: PP.repourAll(d, new Map(), {reuse: false}).regions}; return d; };
  let d = make("MH");
  assert.deepEqual(P.verify(d, new Map(), set).violations.map(v => v.otherId + " " + v.actual), [], "0.6 mm from the MH land");
  assert.ok(R.kit.extract(d, new Map(), {nettedCopperOnly: true}).copper.some(f => f.id === "mh" && f.net === "MH"), "the land is checked");
  d = make("GND");
  assert.deepEqual(P.verify(d, new Map(), set).violations, []);
  require(require("../support/app-source-paths.cjs").appFile("connectivity.js"));
  const C = AtriumConnectivity.inspect(d, new Map());
  assert.deepEqual([C.shorts.length, C.airwires.length], [0, 0], "the pour keeps clear of its own net's land, which the ratsnest does not ask for");
});

test("pour extraction matches full DRC for persisted footprint nets, ties, and stack order", () => {
  const d = pour(board(), .2), tie = AtriumParts.catalogue.find(def => def.id === "std-nettie-2");
  const land = {x:0, y:0, w:.9, h:.9, shape:"round", layer:"Multi", drill:.25};
  const footprint = {id:"footprint-definition", footprint:{pads:[
    {...land, number:"1", net:"Footprint net"}, {...land, number:"2", x:1.2, net:"Overridden net"}, {...land, number:"3", x:2.4},
  ], shapes:[{kind:"path", layer:"Silk", width:.15, points:[[0,-1],[2.4,-1]]},
    {kind:"path", layer:"Inner 2", width:.15, points:[[0,1],[2.4,1]]}]}};
  const stack = {kind:"via", layer:"Multi", fromLayer:"Top", toLayer:"Bottom", diameter:.6, drill:.3,
    stackMode:"tmb", padStack:{Top:{diameter:.6}, Mid:{diameter:.55}, Bottom:{diameter:.6}}};
  d.items.push(
    {...land, kind:"pad", id:"unassigned-stacked-pad", stackMode:"tmb", padStack:{Mid:{w:.7}}},
    {...stack, id:"assigned-via", net:"Via net", x:7, y:5}, {...stack, id:"unassigned-via", x:7, y:7},
    {id:"unassigned-track", kind:"track", layer:"Top", width:.2, points:[[3,4],[6,4],[6.3,4.3]]},
    {id:"silk", kind:"graphic", layer:"Silk", width:.14, points:[[4,2],[6,2]]},
    {id:"fill", kind:"graphic", net:"Fill net", layer:"Top", fill:true, points:[[3,7],[4,7],[4,8],[3,8]]},
    {id:"footprint", kind:"part", def:footprint.id, ref:"U1", x:10, y:8, angle:90, pinNets:{2:"",3:"Initial pin net"}},
    {id:"tie", kind:"part", def:tie.id, ref:"NT1", x:18, y:8, pinNets:{1:"Tie net A",2:"Tie net B"}});
  const stored = JSON.parse(JSON.stringify({d, library:[footprint,tie]}));
  const doc = stored.d, defs = new Map(stored.library.map(def => [def.id,def]));
  function candidates() {
    let actual;
    for (const planeHoles of [false,true]) {
      const full = R.kit.extract(doc, defs, {planeHoles});
      actual = R.kit.extract(doc, defs, {planeHoles, nettedCopperOnly:true});
      assert.deepEqual(actual.copper, full.copper.filter(f => f.net), "ordered pour candidates match full extraction");
      assert.equal(actual.objects, full.objects);
      assert.equal(actual.copper.some(f => f.planeHole), planeHoles);
      for (const name of ["tracks","vias","holes","pads","testpoints","silk"]) assert.equal(actual[name].length, 0);
    }
    return actual.copper;
  }
  const spans = features => features.filter(f => f.id === "assigned-via").map(f => f.span);
  const before = candidates();
  assert.deepEqual(spans(before), [[0,0],[127,127]], "unassigned pad initializes the shared layer lookup");
  assert.ok(before.some(f => f.net === "Footprint net") && before.some(f => f.net === "Initial pin net"));
  assert.ok(!before.some(f => f.net === "Overridden net"));
  assert.ok(before.some(f => f.id === "tie" && f.kind === "track" && f.net === "Tie net A"));
  assert.ok(P.verify(doc, defs).violations.some(v => v.otherId === "footprint"));

  doc.items.unshift(doc.items.splice(doc.items.findIndex(i => i.id === "unassigned-via"), 1)[0]);
  doc.items.find(i => i.id === "unassigned-track").net = "Edited track net";
  doc.items.find(i => i.id === "footprint").pinNets[3] = "Edited pin net";
  const after = candidates();
  assert.deepEqual(spans(after), [[0,0],[1,1],[2,2],[127,127]], "unassigned via initializes the shared layer lookup");
  assert.ok(after.some(f => f.net === "Edited pin net") && !after.some(f => f.net === "Initial pin net"));
  assert.ok(P.verify(doc, defs).violations.some(v => v.otherId === "unassigned-track"), "newly assigned copper is checked");
});

test("outputs verify poured copper before they are made", () => {
  const d = pour(board(.1), .2), project = {format: "atrium", version: 1, formatVersion: "1.4", name: "P", library: [], documents: [d]};
  d.rules = rules(.2);
  const model = AtriumFabOutputs.analyse(project, d);
  assert.ok(model.pourClearance?.length >= 1, "the model carries the violations");
  assert.ok([...model.notes.keys()].some(m => /Poured copper is closer to other copper than the Clearance rules allow/.test(m)), "the outputs warn");
});

function observePourWork(d, rules, options = {}) {
  const source = AtriumPCBPours;
  const counts = {extract:0,contours:0,edgeBands:0};
  globalThis.AtriumRules = {...R,kit:{...R.kit,extract(...args){
    counts.extract++;return R.kit.extract(...args);
  }}};
  globalThis.AtriumPCBPours = {...source,contours(...args){
    counts.contours++;return source.contours(...args);
  },edgeBands(...args){
    counts.edgeBands++;return source.edgeBands(...args);
  }};
  try {
    const it = P.steps(d, new Map(), rules, options), checked = [];
    let result;
    while (!(result = it.next()).done) {
      if (result.value.region && !result.value.part) checked.push(result.value.region);
    }
    return {counts,checked,result:result.value};
  } finally {globalThis.AtriumPCBPours=source;globalThis.AtriumRules=R;}
}

test("zero clearance skips spatial work while counting only readable scoped copper regions", () => {
  const d = pour(board(.1), 0), r = d.pcbDrawing.pours[0];
  const other = {...r,polygon:"other"}, invalid = {...r,data:"!"}, nonCopper = {...r,layer:"Silk"};
  const options = {regions:[r,other,invalid,nonCopper,{...r,net:""}],polygons:new Set([r.polygon])};
  const q = observePourWork(d, rules(0), options);
  assert.deepEqual(q.checked,[r]);
  assert.equal(q.result.checked,1);
  assert.deepEqual(q.result.violations,[]);
  assert.deepEqual(q.counts,{extract:0,contours:2,edgeBands:0},"proved zero must skip copper extraction and both spatial indexes");
  const prior = PP.queryPending;
  globalThis.AtriumPolygonPour={...PP,queryPending:()=>true};
  try {
    const pending=observePourWork(d,rules(0),options);
    assert.deepEqual(pending.result,{violations:[],checked:0,ms:0,pending:true});
    assert.deepEqual(pending.counts,{extract:0,contours:0,edgeBands:0});
  } finally {globalThis.AtriumPolygonPour=PP;}
  assert.equal(AtriumPolygonPour.queryPending,prior);
});

test("zero pour clearance keeps actual copper contact and batch Short Circuit diagnostics", () => {
  require(require("../support/app-source-paths.cjs").appFile("connectivity.js"));
  const d = pour(board(), 0), defs = new Map();
  d.items.push({id:"crossing",kind:"track",net:"OTHER",layer:"Top",width:.2,points:[[15,8],[15,12]]});
  const conn = AtriumConnectivity.inspect(d,defs);
  assert.ok(conn.shorts.length>0,"the physical copper contact remains a short");
  let onPours;
  const book=R.create();
  book.list.find(r=>r.type==="clearance").gap=0;
  d.rules=book;
  const batch=AtriumDRC.batch(d,defs,book,{types:["clearance","short"],connections:()=>conn,onPours:v=>{onPours=v;}});
  assert.ok(batch.violations.some(v=>v.type==="short"));
  assert.deepEqual(onPours,[]);
  assert.ok(!batch.notes.some(note=>note.startsWith("Poured copper checked")));
});

test("positive object cells and scoped polygon rules still use the normal clearance path", () => {
  const template=R.create(), clear=template.list.find(r=>r.type==="clearance");
  const defaultRule={...clear,gap:0,priority:9};
  const symbolic=AtriumDesignQueryRecord.selector;
  const cases=[
    [{...defaultRule,objects:{"track-poly":.2}}],
    [{...defaultRule,id:"pour-selective",name:"Ground pour",priority:1,
      scope:symbolic("net","GND"),scope2:symbolic("all"),gap:.2},defaultRule]
  ];
  for(const list of cases){
    const set={...template,list};
    const d=pour(board(.1),0);
    const q=observePourWork(d,set);
    assert.equal(q.counts.extract,1);
    assert.ok(q.counts.edgeBands>0);
    assert.ok(q.result.violations.some(v=>v.what==="Polygon clearance" && v.required===.2));
    assert.ok(q.result.violations.some(v=>v.what==="Pour clearance" && v.otherId==="sig" && v.required===.2));
  }
});

test("an internal plane checks its barrel clearance beyond a zero or smaller global gap", () => {
  const d = board(.6), plane = d.items[0];
  plane.layer = "Inner 1";
  plane.powerPlane = {sourceLayer:"PLANE1"};
  const via = (id, x) => ({id, x, y:7, kind:"via", net:"SIG", layer:"Multi", diameter:.6, drill:.4});
  d.items = [plane, via("contact",20), via("near-edge",28.55), via("clear-edge",28.95)];
  const region = AtriumPCBPours.region([plane.points], plane.layer, plane.net, {polygon:plane.id});
  for (const global of [0,.1]) {
    const book = rules(global);
    const result = P.verify(d, new Map(), book, {regions:[region]});
    const hits = new Map(result.violations.map(row=>[row.otherId,row]));
    assert.equal(result.checked,1);
    assert.deepEqual([...hits.keys()].sort(),["contact","near-edge"],
      "local plane clearance must include a barrel beyond the global reach");
    assert.equal(hits.get("contact").actual,0);
    assert.ok(Math.abs(hits.get("near-edge").actual-.35)<1e-8);
    for (const row of hits.values()) {
      assert.equal(row.what,"Plane clearance");
      assert.equal(row.required,.6);
    }
  }
  delete plane.powerPlane;
  const book = R.create(), clearance = book.list.find(rule=>rule.type==="clearance");
  clearance.gap = 0;
  clearance.objects = {"poly-hole":.6};
  const result = P.verify(d, new Map(), book, {regions:[region]});
  assert.deepEqual(result.violations.map(row=>[row.otherId,row.what]).sort(),
    [["contact","Hole clearance"],["near-edge","Hole clearance"]]);
});

test("invalid matrix entries and measured zero scopes stay on the existing pair path", () => {
  const d=pour(board(),0), book=rules(0), defs=new Map();
  delete d.items[0].clearance;
  const original=R.compiled(d,{rules:book,defs});
  const zero=original.byType.clearance[0];
  const withRule=(rule,match)=>({...original,byType:{...original.byType,clearance:[rule]},clearanceRule(a,b){return match(a,b);}});
  for(const bad of [NaN,undefined]){
    const invalid={...zero,objects:{"track-poly":bad}};
    const broken=observePourWork(d,book,{compiled:withRule(invalid,()=>invalid)});
    assert.equal(broken.counts.extract,1,"invalid matrix does not qualify for the shortcut");
    assert.ok(broken.result.violations.some(v=>v.otherId==="sig" && Object.is(v.required,bad)));
  }
  const {appFile}=require("../support/app-source-paths.cjs");
  for (const name of ["query-fields","design-query-parser","design-query-geometry","design-query-context",
    "design-query-index","design-query"]) require(appFile(name+".js"));
  const set=R.create(), measured=set.list.find(r=>r.type==="clearance");
  measured.gap=0;
  measured.scope=AtriumDesignQueryRecord.create("track where width < rule(MinWidth)");
  set.list=[measured];
  const compiled=R.compiled(d,{rules:set,defs});
  assert.ok(compiled.byType.clearance[0]?.measured,"the query really uses a geometric rule measurement");
  assert.equal(compiled.measurementIssues.size,0,"no pair has been evaluated yet");
  const deferred=observePourWork(d,set,{compiled});
  assert.equal(deferred.counts.extract,1,"measured zero still checks geometric rule scopes");
  assert.ok([...compiled.measurementIssues.values()].some(issue=>issue.code==="measurement"));
  assert.deepEqual(deferred.result.violations,[]);
});

test("the banded inside test gives the full scan's answer, on vertices and edges too", () => {
  // A ring with holes (a real fill round a track and a via) plus a hand-made ring with horizontal and
  // vertical edges; points at random, on vertices, at edge midpoints and on the band boundaries.
  const d = pour(board(), .2);
  d.items.push({id: "v2", kind: "via", net: "SIG", layer: "Multi", x: 15, y: 5, diameter: .6, drill: .3});
  const regions = PP.repourAll(d, new Map(), {reuse: false}).regions.filter(r => r.count);
  const sets = regions.map(r => AtriumPCBPours.contours(r)).filter(r => r?.length);
  sets.push([[0, 0, 4, 0, 4, 2, 2, 2, 2, 4, 0, 4], [1, 1, 1.5, 1, 1.5, 1.5, 1, 1.5]]);
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let checked = 0;
  for (const rings of sets) for (const h of [.5, 1, .37]) {
    const fast = P.bands(rings, h), pts = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of rings) for (let i = 0; i + 1 < ring.length; i += 2) { const x = ring[i], y = ring[i + 1]; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); if (i % 6 === 0) pts.push([x, y]); }
    for (const ring of rings) for (let i = 0; i + 3 < ring.length; i += 10) pts.push([(ring[i] + ring[i + 2]) / 2, (ring[i + 1] + ring[i + 3]) / 2]);
    for (let k = 0; k < 2000; k++) pts.push([x0 - 1 + rnd() * (x1 - x0 + 2), y0 - 1 + rnd() * (y1 - y0 + 2)]);
    for (let k = 0; k < 200; k++) pts.push([x0 + rnd() * (x1 - x0), Math.floor(y0 / h + k) * h]);
    for (const [x, y] of pts) { assert.equal(fast(x, y), P.inside(x, y, rings), "at " + x + "," + y); checked++; }
  }
  assert.ok(checked > 10000, "points checked: " + checked);
});

test("verification runs in small steps (a large region is many idle slices)", () => {
  const d = pour(board(), .2);
  for (let i = 0; i < 400; i++) d.items.push({id: "t" + i, kind: "via", net: "N" + i, layer: "Multi", x: 3 + (i % 25), y: 3 + Math.floor(i / 25) * .9, diameter: .3, drill: .15});
  const it = P.steps(d, new Map(), rules(.2));
  let n = 0, r = it.next();
  while (!r.done) { n++; r = it.next(); }
  const once = P.verify(d, new Map(), rules(.2));
  assert.ok(n > 6, "steps: " + n);
  assert.deepEqual(r.value.violations, once.violations);
});

console.log(passed + " pour clearance tests passed");
