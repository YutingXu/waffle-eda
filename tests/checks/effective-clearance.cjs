"use strict";
const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");
for (const name of ["model", "parts", "nav-common", "spatial", "board-shape", "stackup", "viastack",
  "altium-rules", "pcb-pours", "polygon-pour", "pcb-draw", "pcb-appearance", "net-ties", "connectivity",
  "query", "component-classes", "net-intent", "signals", "rules", "router", "drc", "drc-pours",
  "drc-view", "drc-certs", "undo-store"]) require(appFile(name + ".js"));

require("../support/drc-geometry.cjs");
const R = AtriumRules, Q = AtriumDesignQueryRecord, P = AtriumPolygonPour, U = AtriumUndoStore;
const defs = new Map(), all = Q.selector("all");
const rule = (id, gap, props) => ({
  id, type: "clearance", name: id, enabled: true, priority: 1, scope: all, scope2: all, gap, ...props
});
const rect = (x0,y0,x1,y1) => [[x0,y0],[x1,y0],[x1,y1],[x0,y1]];
const track = (id,net,y) => ({id,kind:"track",net,layer:"Top",width:.2,points:[[4,y],[16,y]]});
const pairRows = rows => rows.filter(AtriumDRCCerts.isPair);
const compact = rows => rows.map(v => [v.ruleId,v.id,v.otherId,Number(v.actual.toFixed(4)),v.required]);
function drain(iterator) {
  for (;;) {
    const step = iterator.next();
    if (step.done) return step.value;
  }
}
function copperAt(regions,x,y) {
  function inside(ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i], yi = ring[i+1], xj = ring[j], yj = ring[j+1];
      if ((yi > y) !== (yj > y) && x < xi + (xj-xi)*(y-yi)/(yj-yi)) inside = !inside;
    }
    return inside;
  }
  return regions.some(region => {
    const [outline, ...holes] = P.rings(region);
    return inside(outline) && !holes.some(inside);
  });
}

{
  const doc = {id:"group",kind:"pcb",outline:rect(0,0,20,20),items:[track("obstacle","OTHER",10)]};
  const project = Atrium.project("Effective clearance",[]);
  project.documents = [doc];
  const polygon = P.make(rect(1,1,19,18),{id:"ground",net:"GROUND",layer:"Top",removeDeadCopper:false});
  doc.items.push(polygon);
  const group = "High voltage";
  for (const enabled of [false,true,false]) {
    R.store(doc,project,R.normalize({list:[rule("group-gap",.9,{set:group})],ruleSets:[{name:group,enabled}]}));
    const view = R.stored(doc,project), resolve = R.resolver(doc,{defs,project});
    assert.equal(view.defaults.clearance,.9,"the serialized mirror retains the rule's value");
    assert.equal(resolve.routingClearance("GROUND","OTHER","Top"),enabled ? .9 : null,"compiled result honors the rule-set switch");
    const preview = AtriumRouter.begin(doc,defs,{project,net:"GROUND",layer:"Top",width:.2,start:[2,10.7],mode:"walkaround"}).move([18,10.7]);
    assert.equal(preview.status,"ok");
    assert.deepEqual(preview.end,[18,10.7]);
    assert.equal(preview.preview[0].points.length===2,!enabled,"interactive route honors the same clearance authority");
    const regions = P.pour(doc,defs,polygon,{project});
    assert.equal(copperAt(regions,10,10.6),!enabled,"tested point is .5 mm from the existing copper edge");
    assert.ok(copperAt(regions,10,11.1),"copper stays beyond both limits");
    const batchDoc = {...doc,items:[doc.items[0],track("route","GROUND",10.7)]};
    const result = AtriumDRC.batch(batchDoc,defs,undefined,{project,types:["clearance"],scopes:false});
    assert.deepEqual(compact(pairRows(result.violations)),enabled ? [["group-gap","obstacle","route",.5,.9]] : []);
    const check = AtriumDRCPours.verify(doc,defs,view,{project,regions});
    assert.deepEqual(check.violations,[],"the effective rule accepts the resulting pour");
  }
  // A disabled group used to produce .9 mm copper and sign it as current.
  // Its inherited-clearance stamp was captured on d9b40c78 with these exact inputs.
  const oldRegions = P.pour(doc,defs,polygon,{project,clearance:.9});
  assert.ok(!copperAt(oldRegions,10,10.6));
  const staleBoard = {...doc,pcbDrawing:{pours:oldRegions,pourSignatureVersion:4,
    pourSignatures:{[polygon.id]:"4:a780425a7ff34966"}}};
  assert.deepEqual(P.stale(staleBoard,defs,{project}),[polygon.id],"upgrade invalidates the former mirror-backed fill");
  const output = P.outputCopper(staleBoard,defs,{project});
  assert.ok(copperAt(output.regions,10,10.6),"manufacturing derives copper under the current authority");
  // An active zero cell is a limit. A missing hole cell remains an explicit no-match.
  const typed = R.normalize({list:[rule("matrix",.2,{objects:{"track-track":0}})]});
  const between = R.resolver(doc,{rules:typed}).clearanceBetween;
  assert.equal(between({ck:"track"},{ck:"track"}),0);
  assert.equal(between({ck:"track"},{ck:"hole"}),null);
  console.log("ok - native rule-set switch agrees across batch, routing and generated copper");
}

{
  const project = Atrium.project("Predicate edits",[]), doc = Atrium.sheet("pcb","Board");
  project.documents = [doc];
  const subject = track("subject","SIGNAL",10), obstacle = track("obstacle","OTHER",10.5);
  const remote = {...track("remote","GROUND",30),comment:"guard"};
  doc.items = [subject,obstacle,remote,track("remote-obstacle","OTHER",30.5)];
  R.store(doc,project,R.normalize({list:[
    rule("guard",.8,{scope:Q.create('track where comment = "guard"')}),
    rule("inspect",.7,{priority:2,scope:Q.create('track where comment = "inspect"')}),
    rule("nominal",.2,{priority:3})
  ]}));
  const rules = R.stored(doc,project), view = AtriumDRCView.online(), history = [], future = [];
  U.reset(); U.touch(project); U.sync(project);
  function online() {
    const from = view.at(), change = U.changed(doc,from), versions = U.documentVersions(doc,project,true);
    return view.update(doc,defs,rules,{from,to:change.seq,ids:change.ids,items:change.items,
      project,outer:versions.outer,library:versions.library});
  }
  function edit(comment) {
    const before = U.mark(project);
    if (comment) subject.comment = comment; else delete subject.comment;
    U.checkpoint(history,future,before); U.touch(project); U.sync(project);
  }
  function jump(direction) {
    assert.ok(U.jump(history,future,U.mark(project),direction));
    U.touch(project); U.sync(project);
  }
  const batch = () => pairRows(AtriumDRC.batch(doc,defs,rules,{project,types:["clearance"],scopes:false}).violations);
  const first = online();
  assert.deepEqual(pairRows(first.violations),batch());
  assert.deepEqual(compact(pairRows(first.violations)),[["guard","remote","remote-obstacle",.3,.8]]);
  const store = drain(view.buildStore());
  assert.ok(store,"the idle build accepts these ordinary field predicates");
  assert.ok(store.memory().live>1,"there is an unrelated certificate");
  const counts = [];
  function check(label,expected,narrow) {
    const before = {...store.stats}, result = online();
    assert.equal(result.mode,"incremental",label);
    assert.equal(result.dirty,1,label);
    assert.equal(view.store(),store,label);
    const findings = pairRows(result.violations);
    assert.deepEqual(findings.slice().sort((a,b)=>a.id.localeCompare(b.id)),batch().slice().sort((a,b)=>a.id.localeCompare(b.id)),label+" matches full");
    const subjectFinding = compact(findings.filter(v => v.id==="subject"));
    assert.deepEqual(subjectFinding,expected ? [[expected,"subject","obstacle",.3,expected==="guard" ? .8 : .7]] : [],label);
    const resolved = store.stats.resolved-before.resolved, measured = store.stats.narrow-before.narrow;
    assert.equal(resolved,1,label+" resolves only the affected pair");
    assert.equal(measured,narrow,label+" reuses the cached exact distance");
    assert.equal(store.stats.requeries-before.requeries,0,label+" keeps its spatial index");
    counts.push([label,result.dirty,resolved,measured]);
  }
  edit("guard"); check("add comment","guard",1);
  edit("inspect"); check("change comment","inspect",0);
  jump(-1); check("Undo","guard",0);
  jump(1); check("Redo","inspect",0);
  edit(""); check("remove comment",null,0);
  const compiler = globalThis.AtriumDesignQuery;
  try {
    globalThis.AtriumDesignQuery = undefined;
    const waiting = R.resolver(doc,{project,defs});
    assert.equal(waiting.routingClearance("SIGNAL","OTHER","Top"),undefined,"unavailable compiler is distinct from a miss");
    assert.equal(waiting.clearanceBetween({ck:"track"},{ck:"track"}),undefined);
  } finally {
    globalThis.AtriumDesignQuery = compiler;
    U.reset();
  }
  console.log("ok - predicate edit, Undo and Redo match full DRC [step, dirty, resolved, narrow] " + JSON.stringify(counts));
}
