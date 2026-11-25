"use strict";
// Public PiDP-11 source and the shipping writer output are independent checks on
// the adapter. The native original, encoded ASCII, KiCad UUIDs and companion
// files must survive the registry/worker boundary without re-serializing them.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model","parts","sch-objects","hierarchy","board-shape","board-shape-sources","stackup","net-intent","signals","altium-rules",
  "query","component-classes","rules","pcb-pours","pcb-appearance","pcb-text-rich","pcb-text","pcb-draw","designator-place",
  "altium-ids","source-file","sch-import","pcb-import","sch-patch","pcb-patch","source-copy","sexpr","import-kicad","import-link","io",
  "zip","altium-export","kicad-export","kicad-schematic","component-families","library-store","library-panel","netlist",
  "translator-provenance","translator-exports"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

for (const name of ["translator-table", "translator-registry", "translator-worker-modules"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const A = Atrium, X = AtriumTranslatorExports, P = AtriumTranslatorProvenance;
const file = (name,text) => ({name,bytes:Buffer.from(text)});
function run(id, direction, value, options = {}) {
  // Exercise the direct adapter with the same optional modules as its registered worker.
  for (const root of AtriumTranslatorRegistry.get(id).modules[direction]) {
    for (const name of AtriumTranslatorWorkerModules[root]) require(require("../support/app-source-paths.cjs").appFile(name));
  }
  const rows = [], notes = [];
  const fidelity = {add:(kind,status,source,reason,count=1) => {
    assert.ok(source.file && source.object !== "undefined"); rows.push({kind,status,source,reason,count});
  },note:s => notes.push(s)};
  return {...X[id][direction](value,options,fidelity),rows,notes};
}
const fixture = path.join(__dirname,"../fixtures/altium/pidp11-io-expander");
{
  const source=A.project("Connector shapes"),doc=source.documents[0];
  source.documents=[doc];
  for (const [n,io] of [undefined,"unspecified","input","output","bidirectional"].entries()) {
    doc.items.push({id:"connector-"+n,kind:"offsheet",text:"REPEATED",x:n*3,y:4,...(io?{io}:{})});
  }
  const saved=JSON.stringify(source);
  const altium=run("altium","export",source,{scope:"document",documentId:doc.id});
  const drops=altium.rows.filter(r=>r.kind==="Off-sheet connector direction");
  assert.deepEqual(drops.map(r=>r.source.object),[2,3,4].map(n=>doc.id+"/connector-"+n));
  assert.ok(drops.every(r=>r.status==="dropped"&&r.source.file===doc.name&&r.reason.includes("REPEATED")));
  assert.deepEqual(altium.rows.filter(r=>r.kind==="offsheet").map(r=>r.status),["kept","kept","approximated","approximated","approximated"]);
  const kicad=run("kicad","export",source,{scope:"document",documentId:doc.id});
  assert.ok(kicad.rows.filter(r=>r.kind==="offsheet").every(r=>r.status==="kept"));
  assert.equal(JSON.stringify(source),saved);
}
const name = "PiDP11IOExpander", sch = file(name + ".SchDoc",fs.readFileSync(path.join(fixture,name + ".SchDoc")));
const board = file(name + ".PcbDoc",fs.readFileSync(path.join(fixture,name + ".PcbDoc")));
const p = A.project(name); p.documents = []; p.library = [];
const provenance = {version:1,files:[]};
for (const f of [sch,board]) {
  const read = AtriumIO.read(f.name,f.bytes);
  p.documents.push(...read.documents); p.library.push(...read.library);
  provenance.files.push({...f,sha256:AtriumSourceFile.sha256(f.bytes),documents:read.documents.map(d => d.id),library:read.library.map(d => d.id)});
}
const legacy = A.clone(p);
P.separate(p,provenance);
const sheetId = p.documents[0].id, boardId = p.documents[1].id;
for (const [index,f] of [sch,board].entries()) {
  const opts = {documentId:p.documents[index].id,original:f,provenance};
  const model = A.clone(p);
  for (const doc of model.documents) doc.netScope = "automatic";
  const result = run("altium-source-copy","export",model,opts);
  assert.deepEqual(Buffer.from(result.files[0].bytes),f.bytes);
  assert.equal(result.details.sourceSha256,AtriumSourceFile.sha256(f.bytes));
  assert.deepEqual(result.details.records,[]);
  assert.ok(result.rows.some(r => r.source.file === f.name && r.status === "kept"));
  assert.throws(() => run("altium-source-copy","export",p,{...opts,original:{...f,bytes:new Uint8Array(9)}}),/digest|differ|SHA-256/);
}
const legacyLink = A.clone(legacy);
delete legacyLink.documents[0].sourceSha256;
for (const item of legacyLink.documents[0].items) { delete item.schSource; delete item.sourceRecord; }
const proposal = run("altium-source-copy","export",legacyLink,{documentId:sheetId,original:sch});
assert.equal(proposal.files.length,0); assert.ok(proposal.details.binding.sha256);
const ascii = run("altium","export",p,{provenance});
const control = AtriumAltiumExport.exportProject(legacy);
assert.deepEqual(ascii.files.map(f => f.name),control.files.map(f => f.name));
assert.deepEqual(ascii.files.map(f => Buffer.from(f.bytes)),control.files.map(f => Buffer.from(f.bytes)));
assert.ok(ascii.files.some(f => /\.step$/i.test(f.name)));
assert.ok(ascii.rows.some(r => r.kind === "part" && r.source.file === board.name));
const pcb = ascii.files.find(f => f.name.endsWith(".PcbDoc")), reopened = AtriumIO.read(pcb.name,pcb.bytes);
assert.equal(reopened.documents[0].items.filter(i => i.kind === "part").length,23);
assert.throws(() => run("altium-source-copy","export",{...p,documents:reopened.documents,library:reopened.library},
  {documentId:reopened.documents[0].id,original:board}),/ASCII/);
const justBoard = run("altium","export",p,{provenance,scope:"document",documentId:boardId});
assert.deepEqual(justBoard.files.map(f => f.name),ascii.files.filter(f => /\.pcbdoc$|\.step$/i.test(f.name)).map(f => f.name));
assert.deepEqual(justBoard.files[0].bytes,pcb.bytes);
assert.deepEqual(AtriumKiCad.exportProject(legacy).files.map(f => [f.name,f.content]),
  run("kicad","export",p,{provenance}).files.map(f => [f.name,f.text]));
assert.throws(() => run("kicad","export",p,{documentId:"absent"}),/existing/);
const another = A.clone(p);
another.documents.push({...A.sheet("pcb","Second"),items:[]});
assert.ok(run("kicad","export",another,{provenance}).rows.some(r => r.kind === "PCB document" && r.status === "dropped"));
assert.equal(run("kicad","export",another,{scope:"documents",provenance}).files.filter(f => /\.kicad_pcb$/.test(f.name)).length,2);
const repeated = AtriumParts.example(), firstBoard = repeated.documents.find(d => d.kind === "pcb");
repeated.documents.push({...A.clone(firstBoard),id:"secondary-board"});
const multi = run("kicad","export",repeated,{scope:"documents"});
const originalName = AtriumKiCad.nameFor(firstBoard.name,"");
assert.ok(multi.files.some(f => f.name === originalName + "-2.kicad_pcb"));
assert.equal(JSON.parse(multi.files.find(f => f.name === originalName + "-2.kicad_pro").text).meta.filename,originalName + "-2.kicad_pro");
assert.equal(new Set(multi.files.map(f => f.name)).size,multi.files.length);
const primary = run("kicad","export",repeated,{documentId:firstBoard.id,primaryOnly:true});
assert.deepEqual(primary.files.map(f => f.name),[originalName + ".kicad_pcb"]);
assert.ok(primary.rows.some(r => r.kind === "Rule companion" && r.status === "dropped"));
assert.ok(primary.rows.some(r => r.kind === "Design rule" && r.status === "dropped"));
assert.ok(ascii.rows.some(r => r.kind === "polygon" && r.status === "kept"));
assert.ok(ascii.rows.filter(r => r.kind === "Source design rule").length > 15);
assert.ok(ascii.rows.some(r => r.kind === "STEP body" && r.status === "approximated"));
const sample = AtriumParts.example(), sheet = sample.documents.find(d => d.kind === "schematic");
sheet.items.push({id:"retained-logo-ref",kind:"image",x:1,y:1,w:2,h:2});
for (const id of ["kicad","altium"]) {
  const r = run(id,"export",sample,{documentId:sheet.id});
  assert.ok(r.rows.some(e => e.kind === "image" && e.status === "dropped" && e.source.object.includes("retained-logo-ref")));
  assert.ok(r.rows.some(e => e.kind === "wire" && e.status === "kept"));
}
const project = AtriumParts.example();
for (const format of ["kicad","protel","csv"]) {
  const id = "netlist-" + format, result = run(id,"export",project);
  const f = file(result.files[0].name,result.files[0].text), parsed = AtriumNetlist.parse(f.bytes.toString());
  const imported = run(id,"import",[f]);
  const again = run(id,"export",imported.model,{provenance:imported.provenance});
  const netSig = n => n.nets.map(t => [t.name,t.nodes.map(v => v.ref + "/" + v.pin).sort()]);
  assert.deepEqual(netSig(AtriumNetlist.parse(again.files[0].text)),netSig(parsed),"retained connectivity " + id);
  assert.equal(result.details.connections,parsed.nets.reduce((n,x) => n+x.nodes.length,0));
  assert.equal(imported.provenance.netlist.components,parsed.components.length);
  assert.equal(imported.provenance.files[0].sha256,AtriumSourceFile.sha256(f.bytes));
  const already = run(id,"import",[f],{project:imported.model});
  assert.equal(already.provenance.netlist.components,0);
  assert.ok(!already.provenance.fields.some(r => imported.model.library.some(def => def.id === r.id)));
}
const one = run("netlist-csv","import",[file("One.csv","Net,Designator,Pin,Pin Name\nsolo,R1,1,In\n")]);
assert.ok(one.rows.some(r => r.kind === "Pin connection" && r.status === "dropped" && r.source.object === "solo/R1/1"));
assert.ok(one.rows.some(r => r.kind === "Symbol geometry" && r.status === "approximated" && r.source.object === "R1"));
const badRows = run("netlist-csv","import",[file("Rows.csv","Net,Designator,Pin\n\nN,ZX1,\nN,ZX1,1\nN,ZX2,1\nV,ZX1,1\n")]);
assert.deepEqual(badRows.rows.filter(r => r.kind === "Pin connection" && r.status === "dropped").map(r => r.source.object),["CSV record 3","V/ZX1/1"]);
const badNode = run("netlist-protel","import",[file("Incomplete.net","[\nR1\n]\n(\nN\nR1-1\nmissing-pin\n)\n")]);
assert.ok(badNode.rows.some(r => r.kind === "Pin connection" && r.status === "dropped" && r.source.object === "N/missing-pin"));
const def = A.clone(project.library.find(d => d.footprint));
def.source = {kind:"kicad-symbol",file:"example.kicad_sym",attribution:{credit:"Fixture contributors",licence:"CC0",author:"Fixture author"}};
const step = fs.readFileSync(path.join(__dirname,"../fixtures/mcad/tray.step"),"utf8");
def.model3d = {file:"/fixture/authoring/main.step",stepText:step};
def.footprint.model3d = {file:"C:\\fixture\\authoring\\footprint.step",stepText:step,offset:[1,2,3]};
def.rev = 4;
const relative = {...A.clone(def),id:"relative",model3d:{file:"assets/relative.step",stepText:step}};
const external = {...A.clone(def),id:"external",model3d:{file:"/fixture/external/reference.step"}};
const lib = A.project("Portable",[def,relative,external]);
lib.documents = []; AtriumLibraryStore.hoistAll(lib);
const originalProject = JSON.stringify(lib);
const portable = run("waffle-library","export",lib,{library:{id:"L",name:"Portable",description:"test",tombstones:[{id:"old",rev:3}]}});
const raw = JSON.parse(portable.files[0].text);
assert.deepEqual(raw.defs[0].source,def.source);
assert.deepEqual(raw.defs[0].model3d,{file:"main.step",stepText:step});
assert.deepEqual(raw.defs[0].footprint.model3d,{file:"footprint.step",stepText:step,offset:[1,2,3]});
assert.deepEqual(raw.defs[1].model3d,relative.model3d);
assert.deepEqual(raw.defs[2].model3d,external.model3d);
assert.deepEqual([raw.id,raw.defs[0].id,raw.defs[0].rev],["L",def.id,4]);
assert.equal(JSON.stringify(lib),originalProject);
assert.throws(() => run("waffle-library","export",{...lib,blobs:{} }),/referenced STEP data/);
const broken = {...raw,defs:[{id:def.id},...raw.defs,raw.defs[0]]};
const imported = run("waffle-library","import",[file("Portable.atrlib",JSON.stringify(broken))]);
assert.equal(imported.model.library.length,3); assert.equal(imported.model.documents.length,0);
assert.equal(imported.model.library[0].source,undefined);
assert.deepEqual(imported.rows.filter(r => r.status === "dropped").map(r => r.source.object),["defs[0] "+def.id,"defs[4] "+def.id]);
const round = run("waffle-library","export",imported.model,{provenance:imported.provenance});
assert.deepEqual(JSON.parse(round.files[0].text),raw);
const target = {id:"shared-draft",defs:[]}, nativeDef = imported.model.library[0];
AtriumLibrary.saveToLibrary(target,nativeDef,imported.model,P.toLegacy(imported.model,imported.provenance).library[0]);
assert.equal(target.defs[0].source.attribution.author,"Fixture author");
assert.equal(nativeDef.source,undefined); assert.equal(nativeDef.libraryRef.library,"shared-draft");
console.log("PASS design translators: public PiDP-11 exact source copies, ASCII bytes/STEP files, KiCad UUIDs and scopes, three netlists, and attributed portable library.");
