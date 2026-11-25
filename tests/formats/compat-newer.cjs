"use strict";
// Unknown fields in CAD records and complete future objects must survive editing
// a known property. Parse and serialize the original native rows for every case.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
require("../support/native-cad.cjs");
for (const file of ["parts","sch-objects","rules","project-rules","signals","output-jobs"]) require(require("../support/app-source-paths.cjs").appFile(file+".js"));
const F = AtriumFormat2, M = AtriumFormat2Model;
const dir = path.join(__dirname,"../fixtures/format-2/future");
const text = input => new TextDecoder().decode(input);
const bytes = name => new Uint8Array(fs.readFileSync(path.join(dir,name)));
const read = name => M.parse(bytes(name));
const ref = (n,unit) => ({limits:[0,null,{exact:[n,unit]}],mode:"μ"});
function editRow(file,id,change) {
  const original = file.get(id), amended = change(Atrium.clone(original));
  const edited = F.applyDelta(file,{put:[amended]});
  assert.equal(edited.changedRows,1);
  assert.deepEqual(file.get(id),original);
  const before = text(F.serialize(file)).split("\n"), after=text(F.serialize(edited.file)).split("\n");
  assert.deepEqual(after.filter((_,i)=>after[i]!==before[i]), [F.canonical(amended)]);
  const reopened = M.parse(F.serialize(edited.file));
  assert.equal(reopened.header.formatVersion,file.header.formatVersion);
  return reopened;
}

const manifest=read("Future.waffle"), {project,members}=M.manifest(manifest);
assert.deepEqual(project.rules.list[0].scope.future,ref(11,"nm"));
assert.deepEqual(project.signals.signals[0].legs[0].future,ref(13,"ohm"));
assert.deepEqual(project.projectExtensions["org.example.calibration"].future,ref(17,"pF"));
const rule=editRow(manifest,"fr",row=>{row.value.name="Bench clearance";return row;});
assert.equal(M.manifest(rule).project.rules.list[0].name,"Bench clearance");
assert.deepEqual(rule.get("fr").value.scope.future,ref(11,"nm"));
const signal=editRow(rule,"fg",row=>{row.value.tags=["Bench"];return row;});
assert.deepEqual(M.manifest(signal).project.signals.signals[0].tags,["Bench"]);
assert.deepEqual(signal.get("fg").value.legs[0].future,ref(13,"ohm"));
assert.deepEqual(signal.get("fe"),manifest.get("fe"));
assert.equal(members.find(item=>item.id==="fw").kind,"opaque");

const drawing=read("Assembly.wdraw"), view=editRow(drawing,"fv",row=>{row.value.x+=1000000;return row;});
assert.deepEqual(M.document(view,{name:"Assembly"}).drawing.views[0].options.future,ref(29,"nm"));
assert.equal(M.document(view).drawing.views[0].x-M.document(drawing).drawing.views[0].x,1);
const library=read("libraries/Probe.wlib"), part=editRow(library,"fl-settings",row=>{row.value.footprint.name="Calibrated probe";return row;});
assert.equal(M.library(part).footprint.name,"Calibrated probe");
assert.deepEqual(M.library(part).footprint.future,ref(31,"μm"));

const sheet=read("Logic.wsch"), doc=M.document(sheet,{name:"Logic"}), label=doc.items.find(i=>i.id==="fa");
assert.deepEqual(doc.items.map(i=>i.id),["fa"]);
assert.equal(sheet.isOpaque("fz"),true);
const edit=M.documentEdits(sheet,doc,{put:[{...label,text:"CAL"}]});
const updated=F.edit(sheet,edit), saved=M.parse(F.serialize(updated));
assert.equal(text(F.serialize(saved)),text(bytes("Logic.wsch")).replace('"text":"SENSE"','"text":"CAL"'));
assert.deepEqual(saved.get("fa").future,ref(19,"nm"));
assert.deepEqual(saved.get("fz").future,ref(23,"nA"));
assert.throws(()=>F.edit(saved,{remove:["fz"]}),e=>e.code==="read-only-format");
const currentBytes=text(bytes("Logic.wsch")).replace('"2.1"','"2.0"');
const current=M.parse(currentBytes);
assert.equal(current.isOpaque("fz"),true);
assert.equal(text(F.serialize(current)),currentBytes);
const unsupported=currentBytes.replace('"id":"fs"','"id":"fs","requires":["continuation-parts-v1"]');
assert.throws(()=>M.parse(unsupported),e=>e.code==="unsupported-feature");

const wave=bytes("Wave.wwave"), opaque=M.parse(wave,{opaque:true});
assert.equal(opaque.readOnly,true);
assert.deepEqual(F.serialize(opaque),wave);
assert.throws(()=>F.edit(opaque,{put:[{kind:"future",id:"new"}]}),e=>e.code==="read-only-format");
console.log("Newer native rule, signal, drawing, footprint, schematic and opaque waveform owners preserve their original fields");
