"use strict";
// A split pane can display a PCB while the user edits a different sheet or its shared library.
const assert = require("node:assert/strict");
for (const m of ["model","nav-common","spatial","connectivity","rules","drc","checks","drc-view","checks/problem-marks","drc-markers","drc-certs","waivers",
  "drc-waivers","undo-store","pcb-appearance","stackup","viastack","board-shape","pcb-pours","polygon-pour","stroke-font","vectorize",
  "pcb-text-rich","pcb-text","pcb-draw","pcb/mask-openings","pcb/resolved-geometry-curves","pcb/geometry-material","pcb/resolved-geometry"])
  require(require("../support/app-source-paths.cjs").appFile(m+".js"));
const V = globalThis.AtriumDRCView, U = globalThis.AtriumUndoStore, rules = globalThis.AtriumRules;
const setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout;
const timers = new Map(), jobs = new Map(), events = new Map(), repaints = [], camera={cx:0,cy:0,scale:12};
const material=AtriumGeometryMaterial, certs=AtriumDRCCerts;
let resolutions=0, certificateEdits=0;
globalThis.AtriumGeometryMaterial={...material,collect(ctx){resolutions++;return material.collect(ctx);}};
globalThis.AtriumDRCCerts={...certs,*building(...args){
  const store=yield* certs.building(...args);
  return store&&{...store,update(...edit){certificateEdits++;return store.update(...edit);}};
}};
let serial = 0, visible = true, visibleChanged;
globalThis.setTimeout = (fn, delay) => {const id = ++serial; timers.set(id, {fn, delay}); return id;};
globalThis.clearTimeout = id => timers.delete(id);
globalThis.AtriumPower = {visible:() => visible, onChange:fn => {visibleChanged = fn;}};
const board = id => ({kind:"pcb", id, name:id, outline:[[-15,-15],[15,-15],[15,15],[-15,15]], items:[
  {kind:"part", id:"p", def:"pkg", ref:"U1", x:0, y:0, angle:0, layer:"Top", pinNets:{"1":"A"}},
  {kind:"track", id:"t", net:"B", width:.2, layer:"Top", points:[[.4,-.25],[.4,.25]]}
]});
const sheet = {kind:"schematic", id:"s", name:"Sheet", items:[]};
const library = [{id:"pkg", footprint:{pads:[{kind:"pad", number:"1", layer:"Top", x:0, y:0, w:.5, h:1, shape:"rect"}], shapes:[]}}];
const first = board("a"), second = board("b"), hidden = board("hidden");
const bottom={id:"bottom",kind:"track",net:"A",width:.2,layer:"Bottom",points:[[8.63,-.25],[8.63,.25]]};
first.items.push(bottom);
library.push({id:"unused", footprint:{pads:[{number:"1",x:0,y:0,w:.5,h:.5,shape:"round"}],shapes:[]}});
let project = {id:"split",format:"atrium", name:"Split", library, documents:[sheet, first, second, hidden]}, panes = [sheet, first, second];
const defs = () => new Map(project.library.map(def => [def.id, def]));
const host = {project:() => project, doc:() => panes[0], panes:() => panes.map(d => ({docId:d.id})),
  docById:id => project.documents.find(d => d.id === id), defs, invalidate() {}, invalidateDocument(id) {repaints.push(id);}, registerAction() {}, addRenderer() {},
  view:()=>({camera:()=>camera}), boardGeometry:root=>AtriumResolvedGeometry.read({kind:"editor",project,root}),
  on(name, fn) {events.set(name, fn);},
  stageEdit(phase, key, fn) {
    const job = {phase, key, fn}; jobs.set(key, job);
    return {cancel() {if (jobs.get(key) === job) jobs.delete(key);}};
  }};
const types = V.online().types(), signature = list => list.map(v => JSON.stringify(v)).sort();
const batch = d => AtriumDRCWaivers.split(d,rules.drc(d,defs(),rules.stored(d,project)||rules.defaults(),{types,limit:5000,project}).violations).active;
const same = d => assert.deepEqual(signature(V.violations(d.id)), signature(batch(d)), d.id + " matches an independent full check");
const edit = fn => {fn(); U.touch(project); U.sync(project); events.get("change")();};
function debounce() {
  for (const [id, t] of [...timers]) if (t.delay === 150) {timers.delete(id); t.fn();}
}
function finish() {
  debounce();
  const keys = [...jobs.keys()];
  for (const job of [...jobs.values()]) {jobs.delete(job.key); job.fn(() => true, {timeRemaining:() => 100});}
  return keys;
}
try {
  U.reset(); U.touch(project); U.sync(project); V.attach(host);
  assert.deepEqual(finish(), ["online-drc:a", "online-drc:b"]);
  assert.deepEqual(repaints.splice(0), ["a", "b"], "publishing markers repaints the corresponding boards only");
  same(first); same(second);
  assert.ok(V.violations(first.id).some(v => v.type === "clearance"));
  assert.deepEqual(V.violations(hidden.id), []);
  assert.ok(resolutions>0,"the scheduler seeded its index from resolved physical owners");

  const clearance=d=>V.violations(d.id).filter(v=>v.type==="clearance");
  edit(()=>AtriumDRCWaivers.add(first,clearance(first)[0],{note:"Review fixture"}));
  finish(); same(first); assert.deepEqual(clearance(first),[]);
  const history=[], future=[], cursor=()=>U.mark(project,{current:first.id});
  const moving=first.items[1], before=cursor();
  const scheduler=AtriumChecks.scheduler;
  scheduler.queue("drc-certs",first,"idle");
  for(let i=0;jobs.size&&i<30;i++)finish();
  edit(()=>{moving.points=[[8.4,-.25],[8.4,.25]];moving.layer="Bottom";});
  U.checkpoint(history,future,before,"Move to Bottom");
  const step=()=>{
    const result=V.check(undefined,first);
    assert.equal(result.mode,"incremental");
    assert.ok(result.layers.includes("Top")&&result.layers.includes("Bottom"),"uses both layer receipts");
    assert.equal(result.checked,3,"both distant neighbourhoods contribute candidates");
    same(first);
    finish();
  };
  const beforeCertificates=certificateEdits;
  step(); assert.ok(certificateEdits>beforeCertificates,"the actual online check updated its clearance certificates");
  assert.ok(clearance(first).some(v=>[v.id,v.otherId].includes(bottom.id)));
  edit(()=>U.jump(history,future,cursor(),-1));step();assert.deepEqual(clearance(first),[],"Undo restores the effective waiver");
  edit(()=>U.jump(history,future,cursor(),1));step();assert.equal(clearance(first).length,1);
  edit(()=>U.jump(history,future,cursor(),-1));step();
  edit(()=>{delete first.drcWaivers;});finish();
  const quiet=resolutions; camera.cx+=49;
  assert.equal(V.check(undefined,first).mode,"none");assert.equal(resolutions,quiet,"camera changes resolve no physical owners");
  edit(()=>{library[1].footprint.pads[0].w=2;});
  assert.deepEqual(finish(),["online-drc:a","online-drc:b"]);
  assert.equal(resolutions,quiet,"an unused definition resolves no physical owners");
  const via={kind:"via",id:"drilled-via",x:-9,y:10,layer:"Multi",net:"A",diameter:.9,drill:.35};
  edit(()=>first.items.push(via));finish();same(first);
  edit(()=>{via.diameter=.45;});
  assert.equal(V.check(undefined,first).mode,"incremental");
  same(first);
  const ring=V.violations(first.id).find(v=>v.id===via.id&&v.type==="annularRing");
  assert.ok(ring&&Math.abs(ring.subject.ring-.05)<1e-9,"the finding retains its authored drill subject");
  finish();
  edit(()=>{first.items.splice(first.items.indexOf(via),1);});finish();same(first);
  repaints.length=0;

  edit(() => {sheet.name = "Renamed sheet";});
  assert.deepEqual(finish(), [], "a sheet rename queues no PCB work");
  assert.deepEqual(repaints, []);
  edit(() => {project.library[0].footprint.pads = [{...project.library[0].footprint.pads[0], x:8}];});
  assert.deepEqual(finish(), ["online-drc:a", "online-drc:b"]);
  same(first); same(second);
  assert.ok(!V.violations(first.id).some(v => v.type === "clearance"), "both split boards drop stale markers without a focus change");

  edit(() => {first.items[1].points = [[8.4,-.25],[8.4,.25]];});
  debounce();
  const stale = jobs.get("online-drc:a"); assert.ok(stale); assert.equal(jobs.size, 1);
  edit(() => {first.items[1].points = [[6,-.25],[6,.25]];});
  const prior = V.violations(first.id);
  stale.fn(() => true, {timeRemaining:() => 100});
  assert.equal(prior, V.violations(first.id), "superseded work cannot publish");
  assert.deepEqual(finish(), ["online-drc:a"]); same(first);

  const original=host.boardGeometry(first).revision;
  for(let i=0;i<32;i++){
    edit(()=>{first.items[1].points=[[6+i/100,-.25],[6+i/100,.25]];});
    host.boardGeometry(first);
  }
  assert.equal(host.boardGeometry(first).changes(original).kind,"cold");
  const compacted=V.check(undefined,first);
  assert.equal(compacted.why,"geometry history unavailable");
  same(first);finish();

  visible = false; visibleChanged({visible});
  edit(() => {second.items[1].points = [[8.4,-.25],[8.4,.25]];});
  assert.deepEqual(finish(), [], "a covered window sleeps through the edit");
  visible = true; visibleChanged({visible}); assert.deepEqual(finish(), ["online-drc:b"]); same(second);
  panes = [sheet]; events.get("panes")();
  edit(() => {project.library[0].footprint.pads[0].x = 0;}); assert.deepEqual(finish(), []);
  panes = [sheet, second]; events.get("panes")();
  assert.deepEqual(finish(), ["online-drc:b"]); same(second);
  project = JSON.parse(JSON.stringify(project)); U.touch(project); U.sync(project);
  panes = [project.documents[0], project.documents[3]];
  events.get("document")(); assert.deepEqual(V.violations(first.id), []);
  assert.deepEqual(finish(), ["online-drc:hidden"]); same(panes[1]);
  const dense = panes[1];
  dense.outline = [[-10,-20],[6200,-20],[6200,20],[-10,20]];
  const pad = (id, x, net) => ({id, kind:"pad", number:"1", x, y:0, w:1, h:1, shape:"round", layer:"Top", net});
  const moved = Array.from({length:600}, (_, k) => pad("p" + k, k * 10, "A"));
  dense.items = [...moved, pad("begin", .9, "B"), pad("end", 5990.9, "B")];
  U.touch(project); U.sync(project); V.check();
  const count = () => V.violations(dense.id).filter(v => v.type === "clearance").length;
  assert.equal(count(), 2);
  for (const item of moved) item.y = 4;
  U.touch(project); U.sync(project);
  const partial = V.check({timeRemaining:() => 0}, dense);
  assert.equal(partial.mode, "partial"); assert.equal(partial.violations.filter(v => v.type === "clearance").length, 1);
  V.refresh();
  assert.equal(V.status(), "Checking…", "an incomplete revision has a neutral status");
  assert.equal(count(), 0, "a waiver refresh cannot republish findings from a prior revision");
  assert.equal(AtriumChecks.violations({scope:dense.id, source:"drc"}).length, 0);
  finish(); same(dense); assert.equal(count(), 0); assert.equal(V.status(), null);
  edit(()=>rules.store(dense,project,rules.create()));
  V.check(undefined,dense);finish();
  const ruleSet=rules.migrate(rules.stored(dense,project));
  ruleSet.list.find(r=>r.type==="clearance").gap=.19;
  edit(()=>rules.store(dense,project,ruleSet));
  const checkRules=V.check(undefined,dense);
  assert.ok(checkRules.mode==="rules"||checkRules.why==="geometry history unavailable");
  same(dense);finish();
  const beforeFilm=resolutions;
  ruleSet.list.find(r=>r.type==="solderMask").expansion=.15;
  edit(()=>rules.store(dense,project,ruleSet));
  assert.equal(V.check(undefined,dense).mode,"full");same(dense);finish();
  assert.ok(resolutions>beforeFilm,"a changed film rule refreshes physical owner extents");
  console.log("PASS online DRC journal, clearance certificates, waivers, old/new layers and extents, idle cancellation and cold fallback");
} finally {
  U.reset(); globalThis.setTimeout = setTimer; globalThis.clearTimeout = clearTimer; delete globalThis.AtriumPower;
  globalThis.AtriumGeometryMaterial=material; globalThis.AtriumDRCCerts=certs;
}

// The manufacturing report keeps waived width findings and counts a stale pour.
{
  require(require("../support/app-source-paths.cjs").appFile("design-query.js"));
  const Q = AtriumDesignQueryRecord, P = AtriumPolygonPour;
  const rect = (x, y, w, h) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
  const track = (id, net, width, y) => ({id, kind:"track", layer:"Top", net, width, points:[[1, y], [6, y]]});
  const book = {format:"atrium-rules", version:2, units:"mm", list:[
    {id:"width-gnd", type:"width", name:"GND width", comment:"", enabled:true, priority:1,
      scope:Q.selector("net", "GND"), min:.15, preferred:.2, max:null},
    {id:"mod-1", type:"modifiedPolygon", name:"Modified Polygon", comment:"", enabled:true, priority:1,
      scope:Q.selector("all"), allowModified:false, allowShelved:false}]};
  const stale = P.make(rect(2, 8, 8, 6), {id:"pour-stale", layer:"Top", net:"GND", removeDeadCopper:false});
  const fresh = P.make(rect(14, 8, 8, 6), {id:"pour-fresh", layer:"Top", net:"VCC", removeDeadCopper:false});
  const board = {kind:"pcb", id:"pf03", name:"Synthetic", outline:rect(0, 0, 30, 20), rules:book, items:[
    track("track-thin", "GND", .1, 1), track("track-wide", "GND", .2, 3), track("track-other", "VCC", .1, 5), stale, fresh]};
  const project = {name:"Synthetic", library:[], documents:[]}, defs = new Map();
  P.apply(board, defs, {project, reuse:false});
  stale.points = rect(2.4, 8, 8, 6);
  const found = rules.drc(board, defs, book, {project, checkMode:"all", limit:2000});
  AtriumDRCWaivers.add(board, found.violations.find(v => v.id === "track-thin"), {note:"accepted"});
  const ids = list => [...list].map(v => v.id).sort();
  const limits = [];
  let passed, inspects = 0;
  const run = AtriumDRC.run, batch = AtriumDRC.batch, inspect = AtriumConnectivity.inspect, savedW = AtriumDRCWaivers;
  AtriumConnectivity.inspect = () => { inspects++; return {shorts:[], airwires:[], ties:[]}; };
  AtriumDRC.batch = () => { throw Error("The manufacturing check retains its existing DRC entry point."); };
  AtriumDRC.run = function(doc, lib, set, options) {
    passed = options; limits.push(options.limit); assert.equal(options.checkMode, "all");
    return run.call(this, doc, lib, set, options);
  };
  try {
    const host = {connections:null};
    const prepared = rules.reportInput(board, {project, limit:2000, cache:host});
    const thin = prepared.all.violations.find(v => v.id === "track-thin");
    const pour = prepared.all.violations.find(v => v.id === "pour-stale");
    assert.equal(thin.actual, .1); assert.equal(thin.required, .15);
    assert.equal(pour.detail, "Polygon needs to be repoured");
    assert.deepEqual(ids(prepared.all.violations), ["pour-stale", "track-thin"]);
    assert.equal(prepared.waived.length, 1, "gate keeps a waived count");
    assert.deepEqual(ids(prepared.result.violations), ["pour-stale"]);
    assert.deepEqual(prepared.waived.map(row => row.violation.id), ["track-thin"], "report keeps the waived error");
    assert.deepEqual(prepared.warnings, []);
    assert.equal(inspects, 0, "connectivity inspect stays lazy");
    passed.connections(); passed.connections();
    assert.equal(inspects, 1, "the report reuses ctx.connections");
    assert.equal(host.connections, passed.connections());
    rules.reportInput(board, {project, limit:200});
    passed.connections(); passed.connections();
    assert.equal(inspects, 2, "the gate reuses its own connection");
    assert.deepEqual(limits, [2000, 200]);
    let calls = 0;
    AtriumDRCWaivers = {...savedW, apply(...args) { calls++; return savedW.apply(...args); }};
    const clean = rules.reportInput({...board, drcWaivers:[]}, {project, limit:2000});
    assert.equal(calls, 0, "an empty waiver list leaves apply uncalled");
    assert.deepEqual(ids(clean.result.violations), ["pour-stale", "track-thin"]);
    assert.deepEqual(clean.waived, []); assert.deepEqual(clean.warnings, []);
    AtriumDRCWaivers = {...savedW, apply:undefined};
    const hidden = rules.reportInput(board, {project, limit:2000});
    assert.deepEqual(hidden.warnings, ["DRC waivers are not loaded: waived violations are counted."]);
    assert.deepEqual(ids(hidden.result.violations), ids(hidden.all.violations));
    assert.equal(hidden.waived.length, 0);
  } finally {
    AtriumDRC.batch = batch; AtriumDRC.run = run; AtriumConnectivity.inspect = inspect; AtriumDRCWaivers = savedW;
  }
  console.log("PASS physical DRC findings: scoped width, stale pour, waived error");
}
