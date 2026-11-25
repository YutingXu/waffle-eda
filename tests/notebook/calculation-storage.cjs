"use strict";
const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path");
const {nativeCAD,nativeRecords,nativeRoundTrip}=require("../support/native-cad.cjs");
for(const name of ["obsolete-project","note-fields","calculation-helpers","calculation-intent","calculation-core",
  "calculation-records","calculation-design","calculation-graph","calculation-checks","calculations"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));

for(const name of ["v1.4-calculation-frame.waffle","v1.4-notebook.waffle"]) {
  const input=new Uint8Array(fs.readFileSync(path.join(__dirname,"../fixtures/compat/projects",name)));
  const digest=AtriumFormat2.sha256(input);
  assert.throws(()=>AtriumObsoleteProject.reject(input,name),e=>e.code==="pre-release-format"&&/re-import/.test(e.message));
  assert.throws(()=>AtriumFormat2Model.parse(input));
  assert.equal(AtriumFormat2.sha256(input),digest);
}

const p=nativeCAD("calculation"), doc=p.documents[0], block=doc.items.find(i=>i.calculation);
const {read,manifest}=nativeRecords("calculation"), member=AtriumFormat2Model.manifest(manifest).members.find(m=>m.id===doc.id);
const row=AtriumFormat2Model.parse(read(member.path)).get(block.id);
assert.equal(row.kind,"calculation");
assert.equal(row.text,"f_c = 1/(2π·R5·C3)");
assert.deepEqual(row.calculation.bindings.map(b=>b.target.itemId),["r5","c3"]);
const evaluate=project=>AtriumCalculations.evaluateSnapshot(project,{documentId:doc.id}).records.find(r=>r.blockId===block.id).result;
const first=evaluate(p);
assert.equal(first.display,"15.92 kHz");
doc.items.find(i=>i.id==="r5").value="20k";
const again=nativeRoundTrip(p), savedBlock=again.documents[0].items.find(i=>i.id===block.id);
assert.deepEqual(savedBlock.calculation,block.calculation);
assert.equal(evaluate(again).display,"7.958 kHz");
assert.equal(first.display,"15.92 kHz");
again.documents[0].items.find(i=>i.id==="r5").id="replacement";
assert.equal(evaluate(again).ok,false,"an equal display name cannot silently substitute for a lost bound ID");
console.log("Native calculation storage retains authored bindings, evaluates both RC states and rejects both pre-release notebook fixtures.");
