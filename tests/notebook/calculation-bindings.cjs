"use strict";
const assert = require("node:assert/strict");
for (const file of ["model", "parts", "sch-objects", "hierarchy", "undo-store", "net-intent", "signals", "altium-rules", "rules", "project-rules",
  "checks", "erc", "waivers", "note-fields", "calculation-intent", "calculation-core", "calculators", "calculation-helpers", "calculation-records",
  "calculation-graph", "calculation-design", "calculation-checks", "calculations", "output-jobs", "release"]) require(require("../support/app-source-paths.cjs").appFile(file + ".js"));

const A = Atrium, C = AtriumCalculations, E = AtriumERC, K = AtriumChecks, R = AtriumCalculationRecords, U = AtriumUndoStore;
const resistor = {id: "res", name: "Resistor", category: "Resistors", prefix: "R", symbol: {shapes: [], pins: []}};
const capacitor = {id: "cap", name: "Capacitor", category: "Capacitors", prefix: "C", symbol: {shapes: [], pins: []}};
const assertResult = (p, id) => C.evaluateSnapshot(p).records.find(r => r.blockId === id);

function fixture() {
  const project = A.project("Binding bench", [resistor, capacitor]), a = project.documents[0], b = {...a, items: [], id: "cross-sheet", name: "Power"};
  a.id = "logic-sheet"; a.name = "Logic";
  project.documents.push(b);
  const r = {id: "r5-old", kind: "part", ref: "R5", def: resistor.id, value: "10k", x: 1, y: 1};
  const c = {id: "c3", kind: "part", ref: "C3", def: capacitor.id, value: "1n", x: 2, y: 2};
  a.items.push(r); b.items.push(c);
  return {project, a, b, r, c};
}

async function place(project, doc, id, source, assertions = [], o = {}) {
  const bind = source => C.bindSource(project, {documentId: doc.id, source, ...o});
  const bound = await bind(source), clauses = [];
  for (const [n, source] of assertions.entries()) {
    const {bindings} = await bind(source);
    clauses.push({id: id + "-" + n, source, bindings});
  }
  const row = R.backing({id, x:0, y:2, source, assertions:clauses, ...bound});
  assert.ok(R.valid(row), JSON.stringify(row));
  doc.items.push(row);
  return row;
}

function calculationFindings(project) {
  return E.run(project, {time: new Date(0)}).messages.filter(m => m.check === "calculationAssertion").map(m => K.fromERC(m));
}

async function futureAssertionScope() {
  const {project,a}=fixture();
  const normal=await place(project,a,"calc","3 V",["assert count(LED) = 0 ea"]);
  const primary=await place(project,a,"check","assert 1 < 2");
  C.syncRules(project);
  let reads=0;
  const countSnapshot=()=>{reads++;return {complete:true,count:0};};
  const previous=C.evaluateSnapshot(project,{countSnapshot}), pointers=project.rules.list.filter(r=>r.type==="ercCalculationAssertion");
  assert.equal(reads,1);
  assert.ok(previous.records.every(r=>r.assertions[0].status==="pass"));
  const scope={languageVersion:2,source:"object when future"};
  for (const pointer of pointers) {pointer.scope=scope; pointer.severity="warning";}
  AtriumProjectRules.validate(project.rules);
  const snapshot=C.evaluateSnapshot(project,{countSnapshot}), main=snapshot.records.find(r=>r.blockId===primary.id);
  assert.equal(reads,1,"unavailable assertion applicability prevents further query reads");
  assert.equal(main.result.diagnostic.code,"language-version");
  assert.equal(R.staticOutput(R.read(primary),main,"KiCad").fidelity.status,"incomplete");
  assert.equal(snapshot.records.find(r=>r.blockId===normal.id).result.display,"3 V");
  for (const row of snapshot.records) {
    const assertion=row.assertions[0];
    assert.equal(assertion.status,"incomplete"); assert.equal(assertion.result.ok,false);
    assert.deepEqual(assertion.result.diagnostic.span,[0,scope.source.length]);
  }
  for (const frozen of [previous,snapshot]) {
    const erc=E.run(project,{calculationSnapshot:frozen});
    assert.equal(erc.complete,false); assert.equal(erc.passed,false);
    assert.equal(erc.diagnostics.length,2);
    const matched=erc.messages.filter(m=>pointers.some(p=>p.id===m.ruleId));
    assert.equal(matched.length,2);
    for (const message of matched) {
      assert.equal(message.detail.status,"incomplete"); assert.equal(message.detail.scopeDiagnostic.side,"scope");
      assert.deepEqual(message.detail.scopeDiagnostic.span,[0,scope.source.length]);
    }
  }
  const pending=E.run(project,{calculationSnapshot:{records:[]}});
  assert.equal(pending.complete,false); assert.equal(pending.messages.filter(m=>m.check==="ruleScope").length,2);
  const job={name:"Future rule coverage",outputs:[{id:"erc",kind:"erc",options:{format:"json"}}]};
  const jobFile=AtriumOutputJobs.run(project,job).files[0].data;
  const report=JSON.parse(typeof jobFile==="string"?jobFile:new TextDecoder().decode(jobFile));
  assert.equal(report.complete,false); assert.equal(report.diagnostics.length,2);
  for (const finding of calculationFindings(project)) AtriumWaivers.waive(project,finding,{note:"Old arithmetic waiver",holds:"always"});
  assert.equal(AtriumRelease.preflight(project,job).checks.find(c=>c.id==="erc").status,"fail");
  for (const pointer of pointers) pointer.enabled=false;
  assert.ok(C.evaluateSnapshot(project).records.every(r=>r.assertions[0].status==="disabled"));
  assert.equal(E.run(project).complete,true);
}

async function stableBindingsAndRules() {
  const {project, a, b, r, c} = fixture();
  const note = await place(project, a, "corner", "f_c = 1/(2*pi*R5*C3)", ["assert f_c > 10 kHz", "assert 3.4 V = 3.3 V ± 2%"]);
  // A self-reference in an assertion is to its own named expression, not another assertion.
  note.calculation.assertions[0].bindings = (await C.bindSource(project, {documentId: a.id, source: note.calculation.assertions[0].source})).bindings;
  assert.equal(C.syncRules(project), true);
  assert.equal(C.syncRules(project), false);
  const pointers = () => project.rules.list.filter(x => x.type === "ercCalculationAssertion");
  assert.equal(pointers().length, 2);
  const [first, second] = pointers();
  const row = assertResult(project, "corner");
  assert.equal(row.result.display, "15.92 kHz");
  assert.ok(row.result.warnings.includes("tolerance unknown: R5, C3"));
  assert.ok(row.assertions[0].result.warnings.includes("tolerance unknown: R5, C3"));
  assert.deepEqual(row.assertions.map(x => x.status), ["pass", "fail"]);
  const [finding] = calculationFindings(project);
  assert.equal(finding.ruleId, second.id);
  assert.deepEqual(finding.origin, {kind:"calculation", sheet:a.id, object:note.id, assertion:note.calculation.assertions[1].id});
  assert.equal(finding.objects[0].id, "corner");
  assert.deepEqual(finding.detail.span, [0, note.calculation.assertions[1].source.length]);
  assert.deepEqual(finding.detail.actual, {min:3.4, max:3.4});
  assert.match(finding.text, /Fail.*3.4 V.*3.234 V.*3.366 V/);
  const job = {name:"Release check",outputs:[{id:"erc",kind:"erc",options:{format:"json"}}]};
  const gate = () => AtriumRelease.preflight(project,job).checks.find(x => x.id === "erc");
  assert.equal(gate().status,"fail");
  assert.ok(gate().items.some(x => x.target.id === "corner"));
  const report = AtriumOutputJobs.run(project,job).files[0].data;
  assert.match(typeof report === "string" ? report : new TextDecoder().decode(report), /calculationAssertion/);

  AtriumProjectRules.edit(project, book => {book.calculationTolerances = {resistor: .01};});
  const assumed = assertResult(project, "corner").result;
  assert.ok(assumed.warnings.includes("default tolerance: R5 (±1%)"));
  assert.ok(assumed.warnings.includes("tolerance unknown: C3"));
  r.parameters = {Tolerance: "0%"};
  c.parameters = {Tolerance: "5%"};
  const declared = assertResult(project, "corner").result;
  assert.equal(declared.warnings.length, 0);
  assert.ok(declared.worst.min < declared.value && declared.value < declared.worst.max);

  AtriumWaivers.waive(project, finding, {note:"Fixture waiver", holds:"always"});
  assert.ok(!gate().items.some(x => x.target.id === "corner"));
  note.x = 50;
  assert.equal(calculationFindings(project)[0].key, finding.key);
  assert.equal(AtriumWaivers.match(project, calculationFindings(project)).waived.length, 1);
  note.calculation.assertions[1].source = "assert 3.5 V = 3.3 V ± 2%";
  const drift = calculationFindings(project)[0];
  assert.equal(drift.key, finding.key);
  assert.equal(AtriumWaivers.match(project, [drift]).stale.length, 1, "new predicate invalidates the waiver's meaning");
  assert.equal(gate().status,"fail");

  r.ref = "R6";
  const saved = note.calculation.bindings.find(x => x.name === "R5");
  const kept = await C.bindSource(project, {source:"f_c = (1/(2*pi*R5*C3))", previousSource:note.text, bindings:note.calculation.bindings, documentId:a.id});
  assert.equal(kept.bindings.find(x => x.name === "R5").id, saved.id, "surviving token keeps its occurrence");
  assert.equal(kept.bindings.find(x => x.name === "R5").target.itemId, "r5-old");
  assert.equal(assertResult(project, "corner").result.display, "15.92 kHz");
  a.items.splice(a.items.indexOf(r), 1, {...r, id:"replacement", ref:"R5", value:"5k"});
  assert.equal(assertResult(project, "corner").result.diagnostic.code, "missing");
  assert.equal(C.evaluateExpressionSnapshot(project, {source:"R5 + 0Ω", documentId:a.id}).result.value, 5000);
  a.items.push(r);
  assert.equal(assertResult(project, "corner").result.display, "15.92 kHz");

  a.items.splice(a.items.indexOf(note), 1);
  b.items.push(note);
  for (const binding of note.calculation.assertions[0].bindings) {
    binding.target = AtriumNoteFields.remap(binding.target, {docIds:new Map([[a.id,b.id]])});
  }
  C.syncRules(project);
  assert.deepEqual(pointers().map(x => x.id), [first.id, second.id]);
  assert.ok(pointers().every(x => x.origin.sheet === b.id));
  AtriumProjectRules.edit(project, book => {book.list.find(x => x.id === second.id).enabled = false;});
  assert.equal(assertResult(project, "corner").assertions[1].status, "disabled");
  assert.equal(calculationFindings(project).length, 0);
}

async function cyclesAndDiagnostics() {
  const {project, a, b} = fixture();
  const left = await place(project, a, "left", "ALPHA = 1");
  await place(project, b, "right", "BETA = ALPHA + 1");
  await place(project, b, "blocked", "BETA + 1");
  await place(project, b, "independent", "2 + 2");
  const src = "ALPHA = BETA + 1", bound = await C.bindSource(project, {documentId:a.id, source:src});
  left.text = src; left.calculation.bindings = bound.bindings;
  const byId = new Map(C.evaluateSnapshot(project).records.map(r => [r.blockId, r.result]));
  assert.equal(byId.get("left").diagnostic.code, "cycle");
  assert.equal(byId.get("right").diagnostic.code, "cycle");
  assert.deepEqual(new Set(byId.get("left").diagnostic.cycle.map(x => x.blockId)), new Set(["left", "right"]));
  assert.equal(byId.get("blocked").diagnostic.code, "dependency");
  assert.equal(byId.get("independent").value, 4);
  const self = await place(project, a, "self", "SELF = 3");
  self.text = "SELF = SELF";
  self.calculation.bindings = (await C.bindSource(project, {documentId:a.id, source:self.text})).bindings;
  assert.deepEqual(assertResult(project, "self").result.diagnostic.cycle.map(x => x.blockId), ["self", "self"]);

  // A rail-looking designator is not electrical evidence, and only a declared
  // voltage in a declared unit or the confirmed numeric field can be bound.
  project.signals = {version:1, tags:[], signals:[{id:"power", name:"VDD_48V", kind:"single", legs:[{nets:["VDD_48V"]}], params:{Voltage:"12"}}]};
  const expr = () => C.evaluateExpressionSnapshot(project, {source:"net VDD_48V.voltage + 1 V", documentId:a.id}).result;
  assert.equal(expr().diagnostic.code, "voltage-required");
  project.signals.signals[0].params.Voltage = "12 V";
  assert.equal(expr().value, 13);
  delete project.signals.signals[0].params;
  assert.equal(expr().ok, false);
  project.signals.signals[0].intent = {confirmed:true, voltage:48};
  assert.equal(expr().value, 49);
  project.signals.signals[0].name = "48V";
  assert.equal(C.evaluateExpressionSnapshot(project,{source:"net 48V.voltage + 1 V",documentId:a.id}).result.value,49);
  project.signals.signals[0].name = "Battery +/A::sense.1";
  const signal = await place(project,a,"quoted",'net "Battery +/A::sense.1".voltage + 1 V');
  assert.equal(signal.calculation.bindings[0].target.signalId,"power");
  project.signals.signals[0].name = "Battery supply";
  assert.equal(assertResult(project,"quoted").result.value,49,"renaming a signal keeps its authorized voltage field");

  project.parameters = [{id:"old-gain", name:"Gain", value:"2"}];
  const gain = await place(project, a, "gain", "project.Gain * 2");
  assert.equal(assertResult(project, "gain").result.value, 4);
  project.parameters[0].name = "GainRenamed";
  assert.equal(assertResult(project, "gain").result.value, 4);
  project.parameters = [{id:"new-gain", name:"Gain", value:"7"}];
  assert.equal(assertResult(project, "gain").result.ok, false);
  assert.equal(C.evaluateExpressionSnapshot(project, {source:gain.text, documentId:a.id}).result.value, 14);
}

async function incremental() {
  const {project, a, b, r} = fixture();
  await place(project, a, "leader", "LEADER = R5 + 0Ω");
  await place(project, b, "follower", "LEADER + 1Ω", ["assert LEADER > 1kΩ"]);
  for (let n = 0; n < 497; n++) (n % 2 ? a : b).items.push(R.backing({id:"independent-" + n, x:0, y:n, source:"2 + 2"}));
  const D = AtriumCalculationDesign.create(project,U), history = [], future = [], mark = () => U.mark(project,{current:a.id});
  mark();
  const read = revision => {
    D.sync(revision);
    const {request,selection} = D.plan();
    const evaluated = AtriumCalculationGraph.task(request);
    D.accept(evaluated);
    const snapshot = D.snapshot(selection,evaluated.stats,revision);
    assert.deepEqual(snapshot.records,C.evaluateSnapshot(project).records);
    return {snapshot, sent:request.nodes.length, known:request.known.length};
  };
  const initial = read(0);
  assert.equal(initial.sent, 500);
  const change = mark();
  U.checkpoint(history,future,change,"Edit one bound part");
  r.value = "5k";
  U.record(project,{doc:a,items:[r]});
  const next = read(1);
  assert.equal(next.sent, 3);
  assert.equal(next.known, 0);
  assert.equal(next.snapshot.stats.reads - initial.snapshot.stats.reads, 1);
  assert.equal(next.snapshot.records.find(x=>x.blockId==="follower").result.value,5001);
  U.jump(history,future,mark(),-1);
  assert.equal(read(2).snapshot.records.find(x=>x.blockId==="follower").result.value,10001);
  U.jump(history,future,mark(),1);
  assert.equal(read(3).snapshot.records.find(x=>x.blockId==="follower").result.value,5001);

  const deleteAt = mark();
  U.checkpoint(history,future,deleteAt,"Delete the calculation");
  const old = a.items.find(x=>x.id==="leader");
  a.items.splice(a.items.indexOf(old),1);
  U.record(project,{doc:a,items:[old]});
  assert.equal(read(4).snapshot.records.find(x=>x.blockId==="follower").result.ok,false);
  U.jump(history,future,mark(),-1);
  assert.equal(read(5).snapshot.records.find(x=>x.blockId==="follower").result.value,5001);
  U.reset();
}

async function staleOccurrence() {
  if (typeof AbortController !== "function") return;
  const {project,a} = fixture();
  let occurrence="input/one";
  const host = {project:() => project,revision:() => 1,currentId:() => a.id,instanceId:() => occurrence,on() {}};
  const result = await C.answer({queryId:31,text:"2+2",projectRevision:1,documentId:a.id,instanceId:occurrence},{host,project});
  assert.equal(result.state,"ready");
  assert.equal(C.resolvePaletteAnswer(result).result.value,4);
  occurrence="input/two";
  assert.equal(C.resolvePaletteAnswer(result),null,"the same sheet and revision can represent a different occurrence");
}

(async () => {
  await stableBindingsAndRules();
  await futureAssertionScope();
  await cyclesAndDiagnostics();
  await incremental();
  await staleOccurrence();
  console.log("calculation bindings: stable fields, qualified voltage, cycles, assertion rules, waivers and 500-node incremental equivalence passed");
})().catch(e => { console.error(e); process.exitCode = 1; });
