"use strict";

const assert = require("node:assert/strict");
const {appFile} = require("../support/app-source-paths.cjs");
for (const m of ["model","spatial","pcb-appearance","pcb-text","path-record","canvas","stackup","fab-outputs","pdf","print",
  "format-2-codec","format-2-units","format-2-values","format-2-model","step-export","kicad-export"])
  require(appFile(m + ".js"));

// F3 (Batch 8, B8-08). The Bottom silk value stays fixed as the Silk reference turns.
const A = Atrium, PCB = AtriumPCBAppearance, T = AtriumPCBText, F = AtriumFabOutputs;
const partId = "12121212-1212-7212-8212-121212121212", defId = "13131313-1313-7313-8313-131313131313";
const sourceRecord = "components6/data#1";
const ref = {field:"ref", at:[-1,2], angle:90, size:1.1, width:.11, layer:"Silk", upright:true, mirrored:false};
const value = {field:"value", at:[2,-1], angle:0, size:.9, width:.29, layer:"Bottom silk", mirrored:false};
const fixed = x => Math.round(x * 1e6) / 1e6 || 0;
const layers = ["Silk","Bottom silk"];
const date = new Date(Date.UTC(2026,10,24));
const files = {date, layerSets:["top","bottom"], viewerLayers:true, footer:false};
const fab = {pourFill:"stored", pourCheck:false};

function documentFixture(anchor, useSource = false, localAngle = 90) {
  const project = A.project("Q4 PCB annotation", []);
  const doc = project.documents.find(d => d.kind === "pcb");
  doc.id = "14141414-1414-7414-8414-141414141414";
  doc.outline = [[-22,-18],[22,-18],[22,18],[-22,18]];
  const definition = {id:defId, name:"sample", footprint:{shapes:[], pads:[
    {id:"contact-a", number:"1", x:1.4, y:.7, w:2.2, h:1.4, shape:"rect", layer:"Top", angle:17}
  ]}};
  const defs = new Map([[defId,definition]]);
  project.library = [definition];
  const row = {...ref, angle:localAngle, ...anchor};
  const part = {kind:"part", id:partId, ref:"Q4", def:defId, x:4, y:-3, angle:30, value:"7K5", sourceRecord};
  if (useSource) doc.pcbDrawing = {annotations:{[sourceRecord]:[row,value]}};
  else part.boardLabels = [row,value];
  doc.items = [part];
  A.validate(project);
  return {project,doc,part,defs,definition};
}

function roundTrip(fixture) {
  const {project,doc} = fixture, M = AtriumFormat2Model;
  const reopened = M.document(M.parse(AtriumFormat2.serialize(M.createDocument(doc))));
  project.documents[project.documents.indexOf(doc)] = reopened;
  A.validate(project);
  return {...fixture,doc:reopened,part:reopened.items[0]};
}

function filmRuns(list, layer) {
  return list.filter(op => !op.fill && op.k === "p" && op.cap === "round" && op.layer?.name === layer);
}
function canvasRuns({project,doc,defs}) {
  const rec = AtriumPDF.recorder(800,600), view = AtriumCanvas.create(rec.canvas);
  view.restoreCamera({cx:0,cy:0,scale:20,referenceScale:20});
  view.render(doc,defs,{project,grid:false,origin:false,netNames:false,recordLayer:name => rec.setLayer(name?{id:name,name}:null)});
  return layers.map(layer => filmRuns(rec.list,layer));
}
function printRuns({project,doc}) {
  const result = AtriumPrint.build(project,{...files,documents:[doc.id]});
  assert.equal(result.pages.length,2);
  return [result.pages.map((p,n) => filmRuns(p.list,doc.name + " · " + layers[n])),
    result.pages.map(p => AtriumPDF.svg(p.w,p.h,p.list)),result.bytes({compress:false})];
}
function fabrication({project,doc}) {
  const model = F.analyse(project,doc,fab);
  const films = F.gerberLayers(model);
  return layers.map(layer => {
    const sheet = films.find(row => row.ext === (layer === "Silk" ? "GTO" : "GBO"));
    assert.ok(sheet);
    return [model.layers.get(layer), F.gerber(model,sheet,F.settle({date})).content];
  });
}
function physicalModel({project,doc}) {
  const model = AtriumSTEP.model(project,doc,{components:false,silk:true,fab});
  return model.layers.filter(layer => layer.kind === "silk").map(layer => layer.prisms);
}

function measurements(fixture) {
  const {doc,part,definition} = fixture;
  const [rows, publicInk] = [Array.from(PCB.partText(doc,part,definition)), []];
  T.collect({...fixture,item:part,emit:(member,role,layer,ink,info) => publicInk.push({member,role,layer,ink,...info}),
    diagnose:(_,code) => assert.fail(code)});
  return {rows,publicInk,editor:canvasRuns(fixture),fab: fabrication(fixture),
    print:printRuns(fixture),model:physicalModel(fixture)};
}

const bare = roundTrip(documentFixture({})), explicit = roundTrip(documentFixture({justify:"bottom-left"}));
assert.equal(Object.hasOwn(bare.part.boardLabels[0],"justify"),false,"native source keeps the omitted anchor");
assert.equal(explicit.part.boardLabels[0].justify,"bottom-left");
const first = measurements(bare), second = measurements(explicit);
assert.deepEqual(first.editor,second.editor,"Canvas centerlines agree on both silk films");
assert.equal(first.rows[0].text.justify,"top-right","upright reference inverts the effective default anchor");
const {authoredDegrees,clockwiseDegrees,origin,justification,mirrored} = first.publicInk[0].text;
assert.deepEqual([authoredDegrees,clockwiseDegrees,origin.map(fixed),justification,mirrored],
  [90,-60,[2.133975,-1.767949],"top-right",false]);
assert.deepEqual(first.publicInk,second.publicInk,"resolved text primitives agree");
assert.deepEqual(first.editor.map(film => film.length),[1,1]);
assert.deepEqual(first.fab.map(([film]) => film.map(s => s.width)),[[.11,.11,.11],[.29,.29,.29,.29,.29]]);
assert.deepEqual(first.fab[0][0][0].points[0].map(fixed),[2.261603,.210993],"the original explicit-anchor control stays fixed");
assert.deepEqual(first.fab,second.fab,"fabrication centerlines and Gerber bytes agree");
assert.ok(first.print[0].every(film => film.length > 0));
assert.deepEqual(first.print,second.print,"physical page ink, print SVG and vector PDF bytes agree");
assert.ok(first.model.length===2 && first.model.every(film => film.length > 0));
assert.deepEqual(first.model,second.model,"silk geometry in the physical model agrees");
assert.equal(AtriumKiCad.exportBoard(bare.project,bare.doc).content,
  AtriumKiCad.exportBoard(explicit.project,explicit.doc).content,"KiCad writes the same authored anchor in board space");

for (const [align,justify] of [["center","bottom-center"],["right","bottom-right"]]) {
  const ink = draw => Array.from(PCB.partText(draw.doc,draw.part,draw.definition),
    row => T.toPrimitives(row.text));
  assert.deepEqual(ink(documentFixture({align})),ink(documentFixture({justify})));
}
const source = roundTrip(documentFixture({},true,0));
const explicitReadable = roundTrip(documentFixture({justify:"bottom-left"},true,0));
assert.deepEqual(canvasRuns(source),canvasRuns(explicitReadable),"readable half uses the same default");
assert.equal(source.doc.pcbDrawing.annotations[sourceRecord].length,2);
source.part.boardLabels = [];
assert.equal(Array.from(PCB.partText(source.doc,source.part,source.definition)).length,0,"empty override owns the empty list");
source.part.hiddenBoardLabels = [{...ref,at:[2,3],angle:0,width:.23,layer:"Bottom silk"}];
source.part.showRef = false;
assert.equal(Array.from(PCB.partText(source.doc,source.part,source.definition)).length,0);
source.part.showRef = true;
const [restored] = PCB.partText(source.doc,source.part,source.definition);
assert.deepEqual([restored.text.layer,restored.text.width],["Bottom silk",.23]);
assert.equal(source.doc.pcbDrawing.annotations[sourceRecord].length,2,"local visibility keeps stored source rows");

console.log("F3 upright reference: native round trip, Canvas, Gerber, print SVG/PDF, 3D, KiCad and source ownership passed");
