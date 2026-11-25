"use strict";
const assert = require("node:assert/strict");
const {nativeCAD,nativeRecords,nativeRoundTrip}=require("../support/native-cad.cjs");
for(const name of ["board-shape","eco","revisions"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const A=Atrium, R=AtriumRevisions, F=AtriumFormat2, M=AtriumFormat2Model;
const fixture=()=>nativeCAD("source-geometry");
const originalMetadata=()=>nativeCAD("source-metadata");
const pcb=p=>p.documents.find(d=>d.kind==="pcb");
const part=d=>d.items.find(i=>i.kind==="part");
const item=(d,id)=>d.items.find(i=>i.id===id);
const round=(project,revision)=>nativeRoundTrip(project,revision,nativeRecords(project.id).read);
const time=new Date("2026-01-01T00:00:00Z");

{
  const p=fixture(), d=pcb(p);
  const native = item(d, "native-arc");
  assert.equal(A.pathArc(native), native.arc, "the exact arc remains active after reopening");
  assert.equal(item(d, "legacy-arc").arc, true);
  assert.equal(item(d, "copper-region").regionShape.cutouts[0][0].kind, "arc");
  assert.equal(d.boardShape.cutoutRegions[0].cutouts.length, 1);
  assert.equal(part(d).bodies3d[0].modelId, d.bodyModels[0].id);
  assert.equal(item(d, "drilled-slot").slotLength, 1.5);
  assert.equal(item(d, "plane").powerPlane.pad.entries, 4);
  assert.equal(item(d, "lettered").sourceTextBox.letterSet, 0);
  assert.equal(p.library[0].footprint.pads[0].maskExpansion, .07);
  assert.equal(p.library[0].footprint.shapes[0].keepoutRestrictions, 31);
  assert.deepEqual(pcb(round(p)),d,"saved CAD records and their verified STEP model reopen with the same geometry");
  const rev=R.freeze(p,{date:time,time});
  const released=round(p,rev.letter);
  assert.deepEqual(pcb(released),d,"the hashed release owns the same geometry and fallback contours");
  assert.deepEqual(released.library,p.library);
  part(d).x+=1;
  assert.notEqual(part(pcb(round(p))).x,part(pcb(round(p,rev.letter))).x,"a later working edit does not alter the release");
  const expectInvalid = (edit, message, make=fixture) => {
    const q = make();
    edit(pcb(q), q);
    assert.throws(() => A.validate(q), /Invalid Waffle editor model/, message);
  };
  expectInvalid(b => {item(b, "native-arc").arc.r = -1;}, "PCB arcs require positive radii");
  expectInvalid(b => {item(b, "copper-region").regionShape.cutouts[0][0].r = -1;}, "circular holes require positive radii");
  expectInvalid(b => {item(b, "copper-region").planeVoid = "true";}, "plane aperture flags use booleans");
  expectInvalid(b => {b.boardShape.cutoutRegions[99] = b.boardShape.cutoutRegions[0];}, "cutout override refers to an existing cutout");
  expectInvalid(b => {part(b).bodies3d[0].rotation.pop();}, "body rotations need three axes");
  expectInvalid(b => {delete b.bodyModels[0].stepText; b.bodyModels[0].zlib = "A!+b";}, "body asset keeps encoded bytes only");
  const aliases = fixture(), aliasBoard = pcb(aliases);
  aliasBoard.bodyModels.push({id:"alias", file:"Alias.step", assetId:aliasBoard.bodyModels[0].id});
  aliasBoard.bodyModels.push({id:"unresolved", file:"External.step"});
  part(aliasBoard).bodies3d[0].modelId = "alias";
  const reopenedAliases=pcb(round(A.validate(aliases)));
  assert.equal(part(reopenedAliases).bodies3d[0].modelId,"alias");
  assert.deepEqual(reopenedAliases.bodyModels.map(m=>m.file),aliasBoard.bodyModels.map(m=>m.file));
  assert.deepEqual(reopenedAliases.bodyModels[1].model,reopenedAliases.bodyModels[0].model,"two authored names retain a single physical STEP stream");
  assert.equal(reopenedAliases.bodyModels[1].stepText,reopenedAliases.bodyModels[0].stepText);
  assert.equal(reopenedAliases.bodyModels[2].model,undefined);
  expectInvalid(b => {b.bodyModels.push({id:"alias", file:"A.step", assetId:"missing"});}, "aliases need a target in the same board");
  expectInvalid(b => {b.bodyModels.push({id:"alias", file:"A.step", assetId:"alias"});}, "aliases cannot reference themselves");
  expectInvalid(b => {b.bodyModels[0].assetId = "a";}, "an alias cannot also carry a payload");
  expectInvalid(b => {
    b.bodyModels.push({id:"unresolved", file:"External.step"}, {id:"alias", file:"A.step", assetId:"unresolved"});
  }, "an alias must point to stored STEP data");
  const packaged = fixture(), footprint = packaged.library[0].footprint;
  Object.assign(footprint, {bodyModelVersion:1, bodies3d:part(aliasBoard).bodies3d, bodyModels:aliasBoard.bodyModels});
  footprint.bodies3d[0].sourceRecord = "footprint/data#1";
  const savedFootprint=round(A.validate(packaged)).library[0].footprint;
  assert.deepEqual(savedFootprint.bodies3d,footprint.bodies3d);
  assert.deepEqual(savedFootprint.bodyModels,reopenedAliases.bodyModels,"footprint aliases use the same verified model payload");
  expectInvalid((b, q) => {
    q.library[0].footprint.bodyModels = [{id:"alias", file:"A.step", assetId:b.bodyModels[0].id}];
  }, "a footprint alias cannot refer to a board asset");
  expectInvalid(b => {item(b, "drilled-slot").slotLength = .1;}, "slot length covers the drilled diameter");
  const rounded = fixture(), roundPad = item(pcb(rounded), "drilled-slot"), libraryPad = rounded.library[0].footprint.pads[0];
  Object.assign(roundPad, {shape:"roundrect", roundrectRadiusRatio:.5, stackMode:"tmb", padStack:{Top:{roundrectRadiusRatio:.25}}});
  Object.assign(libraryPad, {shape:"roundrect", roundrectRadiusRatio:0});
  const roundedAgain=round(A.validate(rounded));
  assert.deepEqual(roundedAgain.documents, rounded.documents, "standalone pad keeps the imported radius ratio");
  assert.deepEqual(roundedAgain.library, rounded.library, "footprint pad keeps the imported radius ratio");
  expectInvalid(b => {item(b, "drilled-slot").roundrectRadiusRatio = .6;}, "radius cannot exceed half the short side");
  expectInvalid((b, q) => {q.library[0].footprint.pads[0].roundrectRadiusRatio = -.1;}, "radius cannot be negative");
  expectInvalid(b => {item(b, "drilled-slot").padStack = {Top:{roundrectRadiusRatio:".25"}};}, "per-land radii use a numeric fraction");
  const drills = fixture(), drillBoard = pcb(drills);
  drillBoard.sourceDrillDrawing = {tools:[{mark:4, diameter:.6, slot:1.5, plated:false, hits:1, slotted:true}]};
  item(drillBoard, "drilled-slot").sourceDrillTool = 0;
  drills.sourceDrillPlots = [{board:"fixture.pcbdoc", size:.508}, {board:"other.pcbdoc", size:null}];
  const drillRev=R.freeze(drills,{date:time,time});
  for(const design of [round(drills),round(drills,drillRev.letter)]) {
    assert.deepEqual(pcb(design).sourceDrillDrawing,drillBoard.sourceDrillDrawing);
    const slot=item(pcb(design),"drilled-slot"), [tool]=pcb(design).sourceDrillDrawing.tools;
    assert.equal(slot.drill,tool.diameter);
    assert.equal(slot.slotLength,tool.slot);
  }
  expectInvalid(b => {item(b, "drilled-slot").sourceDrillTool = -.1;}, "drill tool index is a nonnegative integer");
  expectInvalid(b => {b.sourceDrillDrawing = {tools:[{...drillBoard.sourceDrillDrawing.tools[0], hits:-1}]};}, "source tool counts cannot be negative");
  expectInvalid((b, q) => {q.sourceDrillPlots = [{board:"fixture.pcbdoc", size:".508"}];}, "drill symbol size is numeric or null");
  const remapped = fixture(), remappedBoard = pcb(remapped);
  remappedBoard.sourceRuleLayers = {"Inner 2": "Inner 4", "Inner 3": null};

  expectInvalid(b => {b.sourceRuleLayers = {"Inner 2": 4};}, "source rule-layer names are strings");
  expectInvalid(b => {item(b, "plane").powerPlane.pad.entries = 3;}, "plane relief counts match the stored form");
  expectInvalid(b => {b.pcbDrawing.letterSets[0]["65"][0] = "12000";}, "source advance is numeric");
  expectInvalid(b => {b.pcbDrawing.letterSets[0]["65"][0] += .125;}, "source advance uses integer ticks");
  const lettering = fixture(), letteringBoard = pcb(lettering);
  const table = letteringBoard.pcbDrawing.letterSets[0];
  table[128512] = [12345, table[65][1]];
  assert.deepEqual(pcb(round(A.validate(lettering))).pcbDrawing.letterSets[0], table, "recovered typefaces retain supplementary glyphs");
  expectInvalid((b, q) => {q.library[0].footprint.shapes[0].keepoutRestrictions = 32;}, "the mask contains five bits");

  const metadata=originalMetadata();
  const model=pcb(metadata).bodyModels[0];
  assert.equal(F.sha256(new TextEncoder().encode(model.stepText)),model.model.sha256,"the model digest confirms the original STEP bytes");
  assert.deepEqual(pcb(metadata).appliedSourceRuleRecords, [2]);
  assert.equal(pcb(metadata).pcbDrawing.pours[0].subPolygonIndex, 4);
  assert.equal(pcb(metadata).pcbDrawing.nativeText, true);
  assert.deepEqual(part(pcb(metadata)).boardLabels[0].sourceTextBox.writingOffset, [-.2,.35]);
  assert.equal(part(pcb(metadata)).hiddenBoardLabels[0].field, "value");
  part(pcb(metadata)).x += 1;
  const reloadedMetadata=round(metadata), metadataRev=R.freeze(reloadedMetadata,{date:time,time});
  assert.deepEqual(pcb(reloadedMetadata),pcb(metadata));
  assert.deepEqual(pcb(round(reloadedMetadata,metadataRev.letter)),pcb(metadata),"frozen release keeps writing offsets, hidden labels and source pour geometry");
  const withSourceRules=()=>{const p=originalMetadata(); pcb(p).sourceRules=["RECORD=Rule|RULEKIND=Clearance","RECORD=Rule|RULEKIND=Width"];return p;};
  for (const checksum of [-1, .5, 0x100000000]) {
    expectInvalid(b => {b.bodyModels[0].checksum = checksum;}, "checksum uses unsigned 32-bit integers", originalMetadata);
  }
  for (const records of [[0], [3], [2,2]]) {
    expectInvalid(b => {b.appliedSourceRuleRecords = records;}, "applied rule indices are distinct one-based source records", withSourceRules);
  }
  const detached = originalMetadata();
  delete pcb(detached).sourceRules;
  assert.deepEqual(pcb(A.validate(detached)).appliedSourceRuleRecords, [2], "an editable board retains its ledger with the source records in import provenance");
  for (const records of [[0],[10001],[2,2]]) {
    expectInvalid(b => {delete b.sourceRules;b.appliedSourceRuleRecords=records;}, "a detached ledger still has unique bounded indices", originalMetadata);
  }
  expectInvalid(b => {b.pcbDrawing.nativeText=false;}, "native text marker uses true", originalMetadata);
  expectInvalid(b => {part(b).boardLabels[0].sourceTextBox.writingOffset=[1];}, "writing origin uses a text-local point", originalMetadata);
  expectInvalid(b => {part(b).hiddenBoardLabels[0].size=0;}, "hidden text keeps a positive authored size", originalMetadata);
  const anchor="future-anchor";
  expectInvalid(b=>{part(b).boardLabels[0].sourceTextBox.sourceJustify=anchor;},"unknown text anchors require a future record",originalMetadata);
  const region={version:2,contour:{kind:"future"},cutouts:[]};
  expectInvalid(b=>{item(b,"copper-region").regionShape=region;},"the current geometry validator refuses a later contour");
  expectInvalid(b=>{b.boardShape.cutoutRegions[0]=region;},"the current geometry validator refuses a later board hole");
  function editedFuture(name,mutate,editedId) {
    const {manifest,read}=nativeRecords(name), member=M.manifest(manifest).members.find(m=>m.kind==="pcb");
    const source=M.parse(read(member.path)), rows=Array.from(source.records(),r=>A.clone(r));
    mutate(rows);
    const bytes=(format,header={})=>[F.canonical({...source.header,formatVersion:format,...header}),...rows.map(r=>F.canonical(r))].join("\n")+"\n";
    const future=M.parse(bytes("2.1")), placement=future.get(editedId);
    const output=M.parse(F.serialize(F.edit(future,{put:[{...placement,at:[placement.at[0]+1000000,placement.at[1]]}]})));
    assert.equal(output.header.formatVersion,"2.1");
    assert.deepEqual(output.get(editedId).at,[placement.at[0]+1000000,placement.at[1]]);
    for(const row of rows) if(row.id!==editedId)assert.deepEqual(output.get(row.id),row,"unchanged native CAD row "+row.id);
    const major=M.parse(bytes("3.0",{compatibleWith:"2.0"}));
    assert.equal(major.readOnly,true);
    assert.throws(()=>F.edit(major,{remove:[editedId]}),e=>e.code==="read-only-format");
    return output;
  }
  const futureText=editedFuture("source-metadata",rows=>{
    rows.find(r=>r.id==="metadata-placement").boardLabels[0].sourceTextBox.sourceJustify=anchor;
  },"metadata-placement");
  assert.equal(futureText.get("metadata-placement").boardLabels[0].sourceTextBox.sourceJustify,anchor);
  const futureGeometry=editedFuture("source-geometry",rows=>{
    rows.find(r=>r.id==="copper-region").regionShape=region;
    rows.find(r=>r.kind==="documentSettings").value.boardShape.cutoutRegions[0]=region;
  },"sample-placement");
  assert.deepEqual(futureGeometry.get("copper-region").regionShape,region);

  // Raw Altium layer mappings and project drill plot options belong to the retained source index.
  for(const name of ["translator-provenance","import-sidecars"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const combined=fixture(), board=pcb(combined);
  board.sourceRuleLayers=remappedBoard.sourceRuleLayers;
  combined.sourceDrillPlots=drills.sourceDrillPlots;
  const raw=new TextEncoder().encode("RECORD=DrillDrawing|TOOL=4|DIAMETER=0.6");
  const provenance={version:1,files:[{name:"Drill legend.txt",bytes:raw,sha256:F.sha256(raw)}]};
  AtriumTranslatorProvenance.separate(combined,provenance);
  assert.equal(board.sourceRuleLayers,undefined); assert.equal(combined.sourceDrillPlots,undefined);
  const store=AtriumImportSidecars.prepareSync([{scopeId:"synthetic-drill",documents:[board.id],names:[board.name],
    report:{translator:"altium",kinds:["pcb"]},provenance}]);
  const ref=store.refs[0], binding=AtriumImportSidecars.parse(store.files.get(ref.path),ref);
  const restored=AtriumImportSidecars.restore(binding), projected=AtriumTranslatorProvenance.toLegacy(round(combined),restored.provenance);
  assert.deepEqual(pcb(projected).sourceRuleLayers,remappedBoard.sourceRuleLayers);
  assert.deepEqual(projected.sourceDrillPlots,drills.sourceDrillPlots);
}
console.log("Native working and frozen boards retain exact geometry, STEP models, labels and foreign drill records.");
