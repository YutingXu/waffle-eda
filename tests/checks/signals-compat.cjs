"use strict";
const assert = require("node:assert/strict");
for (const f of ["model","parts","sch-objects","hierarchy","board-shape","stackup","altium-rules","pcb-appearance","pcb-pours","polygon-pour","rules","signals"]) require(require("../support/app-source-paths.cjs").appFile(f+".js"));
const {nativeCAD,nativeRecords,nativeRoundTrip} = require("../support/native-cad.cjs");
const A=Atrium, S=AtriumSignals, F=AtriumFormat2, M=AtriumFormat2Model;
const board=p=>p.documents.find(d=>d.kind==="pcb");
{
  const project=A.validate(nativeCAD("signal-board")), b=board(project), model=S.model(project,b);
  assert.equal(S.projectOf(b),project);
  assert.deepEqual(model.stages().map(x=>x.name),["LINK","LINK_C"]);
  assert.ok(model.legacy().xSignals.length>0 && b.lengthTuning?.xSignals===undefined);
  assert.deepEqual(S.xsView(b,project).xSignals,model.legacy().xSignals);
  assert.deepEqual(AtriumRules.netClasses(b,{project}).HS,["TX_N","TX_N_C","TX_P","TX_P_C"]);
  assert.deepEqual(nativeRoundTrip(project).signals,project.signals,"every path and intent survives native storage");
}
for (const name of ["sample-sensor","eco-benchmark"]) {
  const p=nativeCAD(name); S.model(p,board(p)).legacy();
  assert.equal(p.signals,undefined,"reading "+name+" does not adopt a signal store");
  assert.equal(nativeRoundTrip(p).signals,undefined);
}
{
  const record=nativeRecords("signal-board").manifest;
  const futureHeader={...record.header,formatVersion:"2.1"};
  const rows=Array.from(record.records(),row=>Atrium.clone(row));
  const signal=rows.find(row=>row.kind==="signal"), settings=rows.find(row=>row.kind==="projectSetting"&&row.key==="signals");
  signal.value.futureField={value:1}; settings.value.future={note:"a newer signal setting"};
  const render=rows=>[F.canonical(futureHeader),...rows.map(row=>F.canonical(row))].join("\n")+"\n";
  const future=M.parse(render(rows)), q=M.manifest(future).project;
  assert.deepEqual(q.signals.future,settings.value.future);
  assert.deepEqual(q.signals.signals.find(s=>s.id===signal.id).futureField,{value:1});
  const renamed=F.edit(future,{header:{...future.header,name:"Edited title"}});
  assert.deepEqual(M.parse(F.serialize(renamed)).get(signal.id),signal);
  assert.deepEqual(renamed.get(settings.id),settings);

  const required=M.parse([F.canonical({...futureHeader,compatibleWith:"2.0",requires:["signal-store-v2"]}),...rows.map(row=>F.canonical(row))].join("\n")+"\n");
  assert.equal(required.readOnly,true);
  assert.throws(()=>F.edit(required,{remove:[signal.id]}),e=>e.code==="read-only-format");
  assert.deepEqual(required.get(settings.id),settings);
}
{
  const p=nativeCAD("signal-board"),b=board(p);
  S.applyClasses(p,b,{netClasses:{...AtriumRules.effective(b,p).netClasses,Power:["GND","VDD"]}});
  assert.deepEqual(S.model(p,b).legacy().netClasses.Power,["GND","VDD"]);
  const saved=nativeRoundTrip(p);
  assert.deepEqual(saved.signals,p.signals);
  assert.ok(saved.signals.signals.some(s=>s.name==="LINK"&&s.intent?.role==="pairMember"));
}
console.log("Native signal stages, complete paths, classes, freeze and future store preservation");
