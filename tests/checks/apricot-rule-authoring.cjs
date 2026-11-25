"use strict";
const assert = require("node:assert/strict");
for (const name of ["model","design-query-record","rules","project-rules","hierarchy","source-file","format-2-codec",
  "format-2-units","format-2-values","format-2-model"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const Q = AtriumDesignQueryRecord, R = AtriumRules, P = AtriumProjectRules, M = AtriumFormat2Model;
const project = Atrium.project("Scoped rules"), board = project.documents.find(doc => doc.kind === "pcb");
project.id = "scoped-rules";
const all = Q.selector("all"), net = Q.selector("net",'V"BAT'), defaults = P.book(project);
assert.ok(defaults.list.every(r => Q.valid(r.scope) && (!R.types[r.type].two || Q.valid(r.scope2))));
assert.ok(!project.rules);
const native = book => M.createManifest({...project,rules:book});
for (const [type, metadata] of Object.entries(R.types)) {
  const side = {id:"test-rule",type,scope:all}, pair = {...side,scope2:net};
  native({...defaults,list:[metadata.two ? pair : side]});
  assert.throws(() => native({...defaults,list:[metadata.two ? side : pair]}),e => e.code === "invalid-rule-scope",type);
}
P.edit(project, b => {
  const r = b.list.find(r => r.type === "clearance");
  r.scope = {kind:"net",value:'V"BAT'};
  r.scope2 = Q.selector("netclass","Power");
});
const saved = project.rules.list.find(r => r.type === "clearance");
assert.deepEqual(saved.scope,net);
const p = M.manifest(native(project.rules)).project;
assert.deepEqual(p.rules.list.find(r => r.id === saved.id),saved);
const source = 'object in class "Power"', binding = {id:"ref",name:"Power",span:[16,23],target:{scope:"entity",entityId:"class-1"}};
const bound = Q.create(source,[binding]);
P.edit(project, b => { b.list.find(r => r.id === saved.id).scope2 = bound; });
const view = P.forBoard(project,board);
assert.deepEqual(view.list.find(r => r.id === saved.id).scope2,bound);
assert.equal(Q.toSelector(bound),null);
P.setNetScope(project,"hierarchical");
assert.equal(AtriumHierarchy.scopeSetting(project),"hierarchical");
const original = project.rules;
const future = {languageVersion:7,source:"later rule",extra:{width:9}};
assert.throws(() => P.edit(project,b => { b.list.find(r=>r.id===saved.id).scope2 = future; }), /unsupported/);
assert.equal(project.rules,original);
const retained = JSON.parse(JSON.stringify(project));
retained.rules.list.find(r=>r.id===saved.id).scope2 = future;
P.validate(retained.rules);
P.edit(retained, b => { b.list.find(r=>r.id===saved.id).comment = "Keep source"; });
assert.deepEqual(retained.rules.list.find(r=>r.id===saved.id).scope2,future);
P.validate(project.rules);

// An independently newer scope does not invalidate the saved assertion pointer or its owner.
{
  const F = AtriumFormat2, p = Atrium.project("Future assertion",[]);
  p.id = "future-assertion";
  const pointer = {id:"assert",type:"ercCalculationAssertion",name:"Declared check",enabled:true,priority:1,
    scope:all,where:"schematic",sheets:["sheet"],origin:{kind:"calculation",sheet:"sheet",object:"block",assertion:"clause"}};
  P.edit(p,b=>b.list.push(pointer));
  const first = M.createManifest(p), row = first.get(pointer.id);
  const file = F.edit(first,{put:[{...row,value:{...row.value,scope:future}}]});
  const reading = M.manifest(M.parse(F.serialize(file))).project;
  assert.doesNotThrow(()=>P.validate(reading.rules));
  P.edit(reading,b=>{b.list.find(r=>r.type==="width").comment="Documented";});
  assert.deepEqual(M.createManifest(reading,{previous:file}).get(pointer.id),file.get(pointer.id));
  assert.throws(()=>P.edit(p,b=>{b.list.find(r=>r.id===pointer.id).scope=future;}),/unsupported native scope/);
  assert.throws(()=>P.edit(p,b=>{b.list.find(r=>r.id===pointer.id).scope=Q.selector("net","GND");}),/one schematic assertion/);
}

// The Rules editor normalizes its controls before Apply. Its saved patch must leave
// authored omissions, non-contiguous priorities and interleaved metadata physically intact.
{
  const F = AtriumFormat2, source = Atrium.project("One edit",[]);
  source.id = "one-edit";
  const doc = board, {comment:omitted,...thin} = R.create().list.find(r => r.type === "width");
  const {comment:absent,...clearance} = R.create().list.find(r => r.type === "clearance");
  source.documents = [doc];
  const scopeRule = {id:"schematic",type:"ercNetScope",name:"Net IDs",enabled:true,priority:1,scope:all,netScope:"hierarchical"};
  source.rules = {format:"atrium-rules",version:3,units:"mm",list:[
    {...thin,priority:20},scopeRule,{...clearance,boards:[doc.id],priority:8},
    {...thin,id:"second",name:"Second width",priority:30}
  ]};
  const before = M.createManifest(source), loaded = M.manifest(M.parse(F.serialize(before))).project;
  loaded.documents = [doc];
  const draft = R.normalize(P.forBoard(loaded,doc));
  const edit = draft.list.find(r => r.id === clearance.id);
  edit.scope2 = bound;
  const extras = new Map([[clearance.id,{boards:[doc.id]}]]);
  P.edit(loaded,b => {
    P.setBoard(b,loaded,doc,draft,extras);
    P.setErc(b,b.list.filter(r => P.isErc(r.type)));
  });
  const after = M.createManifest(loaded,{previous:before}), row = before.get(clearance.id);
  const expected = F.applyDelta(before,{put:[{...row,value:{...row.value,scope2:bound}}]}).file;
  assert.deepEqual(F.serialize(after),F.serialize(expected),"exactly one scope differs on disk");
  const same = M.manifest(after).project;
  same.documents = [doc];
  P.store(same,doc,P.forBoard(same,doc));
  assert.deepEqual(F.serialize(M.createManifest(same,{previous:after})),F.serialize(after),"a second Apply is byte-stable");
  // A deliberate priority swap must still win with sparse earlier priority numbers.
  const reordered = R.normalize(P.forBoard(same,doc));
  reordered.list.find(r=>r.id==="second").priority=1;
  reordered.list.find(r=>r.id===thin.id).priority=2;
  P.store(same,doc,reordered);
  assert.deepEqual(P.forBoard(same,doc).list.filter(r=>r.type==="width").map(r=>r.id),["second",thin.id]);
}
assert.equal(globalThis.AtriumDesignQuery,undefined);
console.log("Apricot native rule defaults, both stored sides, scoped edits, hierarchy and per-family checks passed.");
