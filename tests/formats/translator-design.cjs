"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["obsolete-project","model","sch-objects","hierarchy","board-shape","board-shape-sources","net-intent","signals","altium-rules","pcb-draw","component-classes","query","rules","project-rules","pcb-pours","stackup",
  "pdf-fonts","altium-typefaces","altium-ids","source-file","sch-import","pcb-import","pcb-appearance","library-import-altium",
  "sexpr","import-kicad","import-eagle","sch-appearance","import-link","io","import-rules","translator-table","translator-registry","translator-provenance","translator-adapters","translators"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));

const T = AtriumTranslators, P = AtriumTranslatorProvenance, obsolete = AtriumObsoleteProject;
const fixture = path.join(__dirname,"../fixtures");
const encoded = (name,text) => ({name,bytes:new TextEncoder().encode(text)});
const row = (report,kind) => report.kinds.find(r=>r.kind===kind);
const counts = (reports,kind) => reports.filter(r=>r.documentKind===kind).reduce((n,r)=>n+r.count,0);
const read = (folder,name) => ({name,bytes:new Uint8Array(fs.readFileSync(path.join(folder,name)))});
const json = value => JSON.parse(JSON.stringify(value));
const altium = path.join(fixture,"altium","pidp11-io-expander");
const design = ["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"].map(n=>read(altium,n));
const hashes = design.map(f=>AtriumSourceFile.sha256(f.bytes));
assert.throws(()=>T.import([encoded("Empty.PrjPcb","[Design]\nVersion=1.0\n")]), /The project manifest lists no supported documents/);
const result = T.import(design,{source_rules:"use"}), {model,report,provenance} = result;
Atrium.validate(model);
const owners = p => [p.id, ...p.library.map(d => d.id), ...p.documents.flatMap(d => [d.id, ...d.items.map(i => i.id)])];
const nativeIds = new Set(owners(model));
assert.equal(nativeIds.size, owners(model).length);
assert.ok([...nativeIds].every(AtriumUUID.isV7), "the real Altium import adopts UUIDv7 owners and objects");
const independent = T.import(design,{source_rules:"use"});
assert.ok(owners(independent.model).every(id => !nativeIds.has(id)), "independent adoption creates different native IDs");
assert.deepEqual(independent.provenance.identityBindings.map(row => row[0]), provenance.identityBindings.map(row => row[0]));
const repeated = T.import(design,{source_rules:"use",identityBindings:provenance.identityBindings});
assert.deepEqual(owners(repeated.model), owners(model));
assert.deepEqual(repeated.report.modelObjects, report.modelObjects);
const compare = require("../../app/history/diff.js");
const parts = model.documents.flatMap(d => d.items.filter(i => i.kind === "part"));
const matched = compare.match(model, independent.model);
assert.ok(parts.every(i => matched.items.has(i.id)), "independent imports compare their source-equivalent components");
assert.deepEqual(provenance.files.map(f=>f.sha256),hashes);
assert.notStrictEqual(provenance.files[0].bytes,design[0].bytes);
assert.deepEqual(provenance.files.map(f=>AtriumSourceFile.sha256(f.bytes)),hashes);
assert.equal(model.documents.length,2);
for (const d of model.documents) {
  assert.equal(counts(report.modelObjects,d.kind),d.items.length);
  assert.ok(!("sourceName" in d) && !("sourceRules" in d) && !("sourceClasses" in d));
  assert.ok(d.items.every(i=>!Object.hasOwn(i,"sourceRecord") && !Object.hasOwn(i,"schSource")));
  assert.ok(provenance.files.some(f=>f.documents.includes(d.id)));
}
const rule = row(report,"Design rule");
assert.equal(rule.kept+rule.approximated+rule.dropped,41);
assert.ok(rule.dropped && rule.references.some(x=>x.status==="dropped" && x.source.object));
assert.equal(rule.kept+rule.approximated,28);
assert.equal(row(report,"Rule check settings").approximated,1);
assert.ok(row(report,"Track").references[0].source.object.startsWith("tracks6/data#"));
const orig = P.toLegacy(model,provenance), board = orig.documents.find(d=>d.kind==="pcb");
const part = board.items.find(i=>i.kind==="part" && board.pcbDrawing.annotations[i.sourceRecord]?.length);
const cleanBoard = model.documents.find(d=>d.id===board.id), cleanPart = cleanBoard.items.find(i=>i.id===part.id);
assert.ok(cleanBoard.ruleCheckSelection.batch.includes("viaStyle"));
assert.ok(!("sourceRuleChecks" in cleanBoard) && board.sourceRuleChecks.kinds.length===41);
assert.deepEqual(AtriumPCBAppearance.sourceLabels(cleanBoard,cleanPart),AtriumPCBAppearance.sourceLabels(board,part));
assert.ok(JSON.stringify(model).indexOf("componentbodies6/data#")<0);
const edited = json(model), editedBoard = edited.documents.find(d=>d.id===board.id);
editedBoard.items.reverse();
const editedPart = editedBoard.items.find(i=>i.id===part.id);
editedPart.x += 1; editedPart.boardLabels[0].size *= 1.2;
const removed = editedBoard.items.find(i=>i.kind==="via"); editedBoard.items = editedBoard.items.filter(i=>i!==removed);
const restored = P.toLegacy(edited,[provenance]), rb=restored.documents.find(d=>d.id===board.id);
assert.equal(rb.items.find(i=>i.id===part.id).x,part.x+1);
assert.equal(rb.items.find(i=>i.id===part.id).sourceRecord,part.sourceRecord);
assert.deepEqual(rb.pcbDrawing.annotations[part.sourceRecord],editedPart.boardLabels);
assert.ok(!rb.items.some(i=>i.id===removed.id));
assert.equal(board.items.find(i=>i.id===part.id).x,cleanPart.x);
assert.deepEqual(design.map(f=>AtriumSourceFile.sha256(f.bytes)),hashes);

// Restored style tables in older saved sheets used the original Record:Role primary key.
const oldSheetProject=json(orig), oldSheet=oldSheetProject.documents.find(d=>d.kind==="schematic");
const wire=oldSheet.items.find(i=>i.kind==="wire"), key=AtriumSchAppearance.sourceKey(wire);
oldSheet.schRestored={sheet:oldSheet.schDrawing,items:{[key]:{paint:{ink:"#012345"}}},definitions:{}};
delete oldSheet.schDrawing;
const styleGroup={version:1,files:[]}; P.separate(oldSheetProject,styleGroup);
assert.ok(!Object.hasOwn(oldSheet.schRestored.items,key));
assert.equal(AtriumSchAppearance.displayItem(oldSheet,wire).schPaint.ink,"#012345");
const oldMap=P.toLegacy(oldSheetProject,styleGroup).documents.find(d=>d.id===oldSheet.id).schRestored.items;
assert.deepEqual(oldMap,{[key]:{paint:{ink:"#012345"}}});

// Current and earlier 1.x layouts can coexist on one board or sheet. An explicit
// part-local table keeps its authored values even if the original annotation row also exists.
const coexist=json(orig), twoTables=coexist.documents.find(d=>d.kind==="pcb");
const placed=twoTables.items.find(i=>i.id===part.id);
placed.boardLabels=json(twoTables.pcbDrawing.annotations[placed.sourceRecord]); placed.boardLabels[0].size+=.001;
const blank=twoTables.items.find(i=>i.kind==="part" && i.id!==part.id);
twoTables.pcbDrawing.annotations[blank.sourceRecord]=[];
const twoStyles=coexist.documents.find(d=>d.kind==="schematic");
twoStyles.sheetOrigin="bottom-left"; twoStyles.netNaming="first-pin";
twoStyles.schRestored={sheet:twoStyles.schDrawing,items:{[wire.id]:{paint:{ink:"#ff00ff"}},[key]:{paint:{ink:"#abcdef"}}},definitions:{}};
const originalShape=json(coexist), group={version:1,files:[]}; P.separate(coexist,group);
assert.equal(AtriumSchAppearance.displayItem(twoStyles,twoStyles.items.find(i=>i.id===wire.id)).schPaint.ink,"#ff00ff");
assert.deepEqual(json(P.toLegacy(coexist,group)),originalShape);
const hidden=cleanBoard.items.find(i=>i.ref==="J4");
assert.equal(hidden.hiddenBoardLabels.length,2);
assert.deepEqual(AtriumPCBAppearance.sourceLabels(cleanBoard,hidden),[]);
assert.deepEqual(AtriumPCBAppearance.sourceLabels(cleanBoard,{...hidden,showRef:true}).map(r=>r.field),["ref"]);
assert.ok(cleanPart.boardLabels.some(r=>r.sourceTextBox?.writingOffset?.length===2));

const raw = [
  "|RECORD=Board|VX0=0|VY0=0|VX1=100mil|VY1=0|VX2=0|VY2=100mil",
  "|RECORD=Track|X1=0|Y1=0|X2=10mil|Y2=0|WIDTH=4mil|LAYER=TOP",
  "|RECORD=Pad|XSIZE=0|YSIZE=0|HOLESIZE=0",
  "|RECORD=UntranslatedObject|NAME=foreign-only-marker"
].join("\n");
const synthetic=T.import([encoded("Evidence.PcbDoc",raw)]);
assert.equal(row(synthetic.report,"Track").kept,1);
assert.equal(row(synthetic.report,"Pad").dropped,1);
assert.deepEqual(row(synthetic.report,"Pad").references[0].source,{file:"Evidence.PcbDoc",object:"ASCII record#2"});
assert.equal(row(synthetic.report,"Unsupported PCB record").dropped,1);
assert.ok(!JSON.stringify(synthetic.model).includes("foreign-only-marker"));
assert.ok(new TextDecoder().decode(synthetic.provenance.files[0].bytes).includes("foreign-only-marker"));
const sameName = T.import(["top","bottom"].map(folder=>({...encoded("Same.PcbDoc",raw),path:folder+"/Same.PcbDoc"})));
const traces=sameName.report.modelObjects.find(r=>r.kind==="track").references;
assert.equal(new Set(traces.map(r=>r.id)).size,2);
for(const trace of traces){
  const docId=sameName.provenance.files.find(f=>f.path===trace.source.file).documents[0];
  assert.ok(sameName.model.documents.find(d=>d.id===docId).items.some(i=>i.id===trace.id));
}
// Designer can place a native poured island before its sparse polygon ID. Each
// rejected island invalidates only the other stored islands of that same owner.
const outline="VX0=0mm|VY0=0mm|VX1=9mm|VY1=0mm|VX2=9mm|VY2=9mm|VX3=0mm|VY3=9mm";
const island=id=>"RECORD=Region|LAYER=TOP|KIND=0|POLYGON="+id+"|SUBPOLYINDEX=3|MAINCONTOURVERTEXCOUNT=3|MVX0=10000.25|MVY0=25000.5|MVX1=100000|MVY1=25000.5|MVX2=100000|MVY2=125000|HOLECOUNT=0";
const zone=id=>"RECORD=Polygon|ID="+id+"|LAYER=TOP|NET=0|HATCHSTYLE=Solid|POUROVER=FALSE|POUROVERSTYLE=2|"+outline;
const foreignRules=[
  "RECORD=Rule|INDEXFORSAVE=0|RULEKIND=Width|ENABLED=FALSE|NAME=ObsoleteScope",
  "RECORD=DXPRule|INDEXFORSAVE=0|RULEKIND=Width|NAME=Trace|SCOPE1EXPRESSION=All|SCOPE2EXPRESSION=All|NETSCOPE=AnyNet|LAYERKIND=SameLayer|ENABLED=TRUE|MINLIMIT=10mil",
  "RECORD=DXPRule|INDEXFORSAVE=2|NAME=MissingKind"
];
const records=["RECORD=Board|"+outline,"RECORD=Net|ID=0|NAME=GND",island(42),zone(42),zone(61),island(61),...foreignRules];
const parseRegions=lines=>T.import([encoded("Native.PcbDoc",lines.join("\r\n"))],{source_rules:"use"});
const native=parseRegions(records), nDoc=native.model.documents[0];
assert.equal(row(native.report,"Stored fill region").kept,2);
const nativeZone=nDoc.items.find(i=>i.kind==="polygon");
const keptIsland=nDoc.pcbDrawing.pours.find(r=>r.polygon===nativeZone.id);
assert.deepEqual(AtriumPCBPours.nativeContours(keptIsland),[[[10000.25,25000.5],[100000,25000.5],[100000,125000]]]);
assert.equal(nDoc.items.find(i=>i.id===nativeZone.id).sourcePourOver,undefined);
assert.deepEqual(P.toLegacy(native.model,native.provenance).documents[0].items.find(i=>i.id===nativeZone.id).sourcePourOver,{style:2,sameNet:false});
assert.deepEqual(row(native.report,"Compatibility rule mirror").references.map(r=>[r.status,r.source.object]),[["dropped","line 7"]]);
assert.deepEqual(row(native.report,"Design rule").references.map(r=>r.source.object).sort(),["line 8","line 9"]);
const damaged=parseRegions([...records,island(61).replace("MVY2=","TRUNCATED=")]);
assert.equal(damaged.model.documents[0].pcbDrawing.pours.length,1);
assert.deepEqual(row(damaged.report,"Stored fill region").references.filter(r=>r.status==="dropped").map(r=>r.source.object).sort(),["ASCII record#5","ASCII record#9"]);
const sheet = T.import([encoded("Evidence.SchDoc","|RECORD=31\n|RECORD=10|LOCATION.X=0|LOCATION.Y=0|CORNER.X=10|CORNER.Y=10\n|RECORD=30|EMBEDIMAGE=TRUE")]);
assert.equal(row(sheet.report,"Rounded rectangle").approximated,1);
assert.equal(row(sheet.report,"Image").dropped,1);
assert.deepEqual(row(sheet.report,"Image").references[0].source,{file:"Evidence.SchDoc",object:"ASCII record#2"});

// A content-selected registry format can read the original name unchanged. The
// raw multi-file reader remains usable by consumers which only provide a suffix.
for (const [format,originalName,selectedName] of [["kicad","demo.kicad_pcb","outline.design"],["eagle","demo-eagle.brd","layout.xml"]]) {
  const input=read(path.join(fixture,"import"),originalName);
  const old=AtriumImportFormats.readSet([input])[0], renamed=AtriumImportFormats.readSet([{...input,name:selectedName}],{formatFor:()=>format})[0];
  assert.equal(renamed.documents[0].sourceName,selectedName);
  assert.deepEqual(renamed.documents[0].items.map(i=>i.kind),old.documents[0].items.map(i=>i.kind));
}
const libraryRule="RULEKIND=Width|NAME=Library constraint|ENABLED=TRUE|SCOPE1EXPRESSION=InPadClass('Source only')|MINLIMIT=10mil";
const libraryFile=encoded("Rule.PcbLib","|RECORD=Library\r\n|RECORD=Component|PATTERN=Part|HEIGHT=1mm\r\n|RECORD=Rule|"+libraryRule+"\r\n");
const importedLibrary=T.import([{...libraryFile,path:"libs/Rule.PcbLib"}]);
const libraryNote=importedLibrary.provenance.libraryRules[0];
assert.equal(libraryNote.sha256,AtriumSourceFile.sha256(libraryFile.bytes));
assert.deepEqual(libraryNote.source,{file:"libs/Rule.PcbLib",object:"line 3"});
assert.equal(libraryNote.text,libraryRule);
assert.ok(!JSON.stringify(importedLibrary.model).includes(libraryRule));
assert.ok(!JSON.stringify(importedLibrary.report).includes(libraryRule));
const asProject={...importedLibrary.model,documents:[Atrium.sheet("pcb","Board")]};
const written=P.toLegacy(asProject,importedLibrary.provenance);
assert.ok(written.importNotes.includes(libraryNote.prefix+" "+libraryRule));
assert.ok(!written.documents[0].sourceRules?.length);
asProject.importNotes=asProject.importNotes.filter(note=>note!==libraryNote.summary);
assert.ok(!P.toLegacy(asProject,importedLibrary.provenance).importNotes.some(note=>note.includes(libraryRule)));

const corpus=path.join(fixture,"compat","projects"), entries=JSON.parse(fs.readFileSync(path.join(fixture,"compat","index.json"),"utf8"));
for (const {file} of entries.projects) {
  const input=read(corpus,file), exact=Buffer.from(input.bytes);
  for (const options of [{},{translator:"legacy"},{translator:"easyeda"}]) {
    assert.throws(()=>T.import([input],options),{code:obsolete.code,message:obsolete.note},file);
  }
  assert.deepEqual(Buffer.from(input.bytes),exact,file);
}
const enclosure=Atrium.project("Enclosure"), d=enclosure.documents[1], step="ISO-10303-21;\nEND-ISO-10303-21;";
d.mcad={enclosure:{name:"housing.step",digest:"source-A",text:step}};
const savedGroup={version:1,files:[]}; P.separate(enclosure,savedGroup);
assert.equal(d.mcad.enclosure.text,undefined);
assert.equal(P.toLegacy(enclosure,savedGroup).documents[1].mcad.enclosure.text,step);
d.mcad.enclosure.digest="replacement";
assert.equal(P.toLegacy(enclosure,savedGroup).documents[1].mcad.enclosure.text,undefined);
for (const name of ["polygon-pour", "format-2-codec", "format-2-units", "format-2-values", "format-2-model", "import-sidecars"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const F = AtriumFormat2, M = AtriumFormat2Model, S = AtriumImportSidecars;
const converted = M.fromEditor(result, {entryDocument:model.documents[0].id});
const anotherProjection = M.fromEditor(result, {entryDocument:model.documents[0].id});
const memberProofs = conversion => conversion.residuals.filter(proof => proof.owner !== model.id);
assert.ok(memberProofs(converted).some(proof => proof.recordKind === "shape" && proof.property.startsWith("/footprint/shapes/")));
assert.deepEqual(memberProofs(anotherProjection), memberProofs(converted),
  "the original source yields identical precision addresses despite fresh native wrapper IDs");
const permuted = Atrium.clone(model);
for (const def of permuted.library) def.footprint?.shapes?.reverse();
const shapeProofs = conversion => memberProofs(conversion).filter(proof => proof.recordKind === "shape")
  .map(proof => proof.fingerprint).sort();
assert.deepEqual(shapeProofs(M.fromEditor({...result, model:permuted})), shapeProofs(converted),
  "reordering unnamed footprint shapes retains their scoped source proof addresses");
const indexed = T.import(design), standalone = Atrium.clone(indexed.model);
const copper = standalone.documents.find(doc => doc.kind === "pcb").pcbDrawing.pours;
assert.ok(copper.some(region => region.source === "altium" && region.links?.length), "the project has indexed copper contacts");
for (const region of copper) if (region.source === "altium" && region.polygon != null) region.links = [];
const copperProofs = conversion => memberProofs(conversion).filter(proof => proof.recordKind === "copperRegion");
const withContacts = copperProofs(M.fromEditor(indexed));
assert.ok(withContacts.length);
assert.deepEqual(copperProofs(M.fromEditor({...indexed, model:standalone})), withContacts,
  "opening only the source PCB without its derived contact index retains the copper proof addresses");
const manifest = M.manifest(M.parse(F.serialize(converted.manifest)));
assert.equal(manifest.project.id, model.id);
assert.equal(manifest.entryDocument, model.documents[0].id);
for (const member of converted.files.slice(1)) {
  const saved = M.parse(F.serialize(member.file)), id = member.file.header.id;
  assert.ok(manifest.members.some(ref => ref.id === id));
  if (saved.header.kind === "library") {
    assert.ok(model.library.some(def => def.id === M.library(saved).id));
  } else {
    const reopened = M.document(saved), imported = model.documents.find(doc => doc.id === id);
    assert.deepEqual(reopened.items.map(i => i.id), imported.items.map(i => i.id));
    for (const item of reopened.items.filter(i => i.kind === "part"))
      assert.ok(manifest.members.some(ref => ref.kind === "library" && ref.id === item.def));
  }
}
const savedImports = S.prepareSync([{documents:model.documents.map(doc => doc.id), names:design.map(f => f.name),
  report, provenance:converted.provenance}]);
const ref = savedImports.refs[0], restoredImport = S.restore(S.parse(savedImports.files.get(ref.path), ref));
assert.ok(AtriumUUID.isV7(ref.id));
assert.equal(JSON.parse(new TextDecoder().decode(savedImports.files.get(ref.path)).split("\n")[0]).id, ref.id);
assert.deepEqual(restoredImport.provenance.identityBindings, provenance.identityBindings);
const reopenedOriginal = T.import(design, {source_rules:"use", identityBindings:restoredImport.provenance.identityBindings});
assert.deepEqual(owners(reopenedOriginal.model), owners(model));
// Native signal owners and their endpoints survive the actual Altium importer,
// JSONL serialization and a fresh read using the previous source bindings.
const signalInput = [read(path.join(fixture, "altium", "pairs-xsignals"), "PairsXSignals.PcbDoc")];
const signalImport = T.import(signalInput);
const signalBoard = signalImport.model.documents[0];
const signalRows = signalImport.model.signals.signals;
const partIds = new Set(signalBoard.items.filter(item => item.kind === "part").map(item => item.id));
assert.equal(signalRows.length, 2);
assert.ok(signalRows.every(signal => AtriumUUID.isV7(signal.id)));
const ends = signalRows.flatMap(signal => (signal.paths || []).flatMap(p => [p.from.part, p.to.part]));
assert.equal(ends.length, 8);
assert.ok(ends.every(id => partIds.has(id)), "source signal endpoints use the adopted PCB part IDs");
const signalSave = M.fromEditor(signalImport);
const signalsReopened = M.manifest(M.parse(F.serialize(signalSave.manifest))).project.signals.signals;
assert.deepEqual(signalsReopened, signalRows);
const signalReimport = T.import(signalInput, {identityBindings:signalImport.provenance.identityBindings});
assert.deepEqual(signalReimport.model.signals.signals, signalRows);

const profileInput = [encoded("Profile.PrjPcb", [
  "[Document1]", "DocumentPath=PiDP11IOExpander.PcbDoc", "[OutputGroup1]",
  "Configuration1_Item1=Record=GerberView|GerberUnit=Imperial|NumberOfDecimals=5|OriginPosition=Relative|Plot.Set=16908289~1|DocumentPath=[PCB Document]"
].join("\n")), design[2]];
const profileImport = T.import(profileInput);
const [profileJob] = profileImport.model.outputJobs;
assert.ok(AtriumUUID.isV7(profileJob.id) && AtriumUUID.isV7(profileJob.outputs[0].id));
assert.equal(profileJob.board, profileImport.model.documents[0].id);
const profileAgain = T.import(profileInput, {identityBindings:profileImport.provenance.identityBindings});
assert.deepEqual(profileAgain.model.outputJobs, profileImport.model.outputJobs);
console.log("Design translators: licensed Altium source records and edited projections pass. Historical project fixtures are rejected.");
