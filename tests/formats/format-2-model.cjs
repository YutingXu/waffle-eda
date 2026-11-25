"use strict";
const assert = require("node:assert/strict");
for (const name of ["model", "source-file", "sexpr", "revisions", "translator-provenance", "format-2-codec", "format-2-units",
  "format-2-values", "format-2-model", "format-2-closure", "format-2-worker",
  "zip", "vendor/zipjs-deflate", "format-2-models", "folder-project-engine", "import-sidecars"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const F = AtriumFormat2, M = AtriumFormat2Model, C = AtriumFormat2Closure;
const utf8 = value => new TextEncoder().encode(value);
const text = file => new TextDecoder().decode(F.serialize(file));

{
  const {F5}=require("../support/a1-geometry.cjs");
  const names=[...F5.aliases,"ellipse","roundrect","roundedrectangle"];
  const pads=names.map((shape,n)=>({x:2*n,y:0,w:F5.w,h:F5.h,number:String(n+1),shape,roundrectRadiusRatio:F5.radiusRatio}));
  const model=Atrium.project("Authored pad aliases",[{id:"library",name:"Alias witness",footprint:{pads,shapes:[]}}]);
  const library=M.fromEditor(model).files.find(row=>row.file.header.kind==="library").file;
  const before=F.serialize(library), reopened=M.parse(before);
  assert.deepEqual(F.serialize(reopened),before,"F5 native member bytes");
  assert.deepEqual(M.library(reopened).footprint.pads.map(p=>[p.shape,p.roundrectRadiusRatio]),names.map(name=>[name,F5.radiusRatio]));
}

function authoredDesign() {
  const credit = {credit: "Example library authors", licence: "OFL-1.1",
    sourceUrl: "https://example.invalid/source", licenceUrl: "https://example.invalid/license", modified: false,
    attribution: {credit: "Distributed authors", licence: "MIT", licenceText: "Distributed licence notice.\n"}};
  const definition = {id: "def1", name: "Simple",
    source: {...credit, path: "/opaque/host-only", attribution: {...credit.attribution, path: "/opaque/host-only"}},
    footprint: {name: "Pad", shapes: [], pads: [{x: 1.4, y: -0.2, w: 0.25, h: 0.5, number: "1", shape: "rect"}]}};
  const project = Atrium.project("Print", [definition]);
  const [sheet, pcb] = project.documents;
  sheet.id = "sheet";
  pcb.id = "board";
  sheet.items.push(
    {kind: "netlabel", id: "label", x: 1.27, y: 2.54, text: "SENSE"},
    {kind: "textframe", id: "formula", x: 0, y: 0, w: 10, h: 4, text: "\\frac12", math: true, size: 1.1},
    {kind: "textframe", id: "frame", x: 0, y: 0, w: 12, h: 5, text: "Group", role: "frame"},
    ...["one", "two"].map(id => ({kind: "image", id, x: 4, y: 6, w: 12, h: 9,
      src: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jSioAAAAASUVORK5CYII="})),
  );
  pcb.items.push({kind: "part", id: "p1", def: "def1", x: 1.25, y: 7.5, angle: 90, ref: "R1", value: "3k"},
    {kind: "track", id: "track", points: [[1, 2], [3, 4]], width: 0.15, layer: "Top", net: "A"});
  pcb.bodyModelVersion = 1;
  pcb.bodyModels = [{id: "model1", file: "first.step", stepText: "ISO-10303-21;\nEND-ISO-10303-21;\n"},
    {id: "model2", file: "alias.stp", assetId: "model1"}, {id: "model3", file: "unresolved.step"}];
  project.library[0].footprint.bodyModelVersion = 1;
  project.library[0].footprint.bodyModels = [{...pcb.bodyModels[0]}];
  const drawing = {...Atrium.sheet("drawing", "Drawing"), id: "drawing",
    drawing: {views: [{id: "view1", at: [1.25, 2.5]}], dimensions: [{id: "dim1", width: 1.2}]}};
  const panel = {...Atrium.sheet("panel", "Panel"), id: "panel", panel: {cells: [{id: "cell1", x: 1, y: 2}]}};
  project.documents.push(drawing, panel);
  project.layoutBlocks = [{format: "atrium-block", version: 1, name: "Block", size: [12, 4],
    items: [pcb.items[0]], library: [definition]}];
  AtriumRevisions.freeze(project, {letter: "A", date: "2026-01-01", time: 1});
  return {project, credit};
}
function nativeSchematicFields() {
  for (const name of ["sch-objects", "hierarchy", "multichannel", "board-shape"])
    require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const normalized = value => JSON.parse(JSON.stringify(value));
  function roundTrip(model) {
    const storage = M.fromEditor(model);
    const recovered = M.manifest(storage.manifest).project;
    for (const {file} of storage.files) {
      const read = M.parse(F.serialize(file));
      if (read.header.kind === "library") recovered.library.push(M.library(read));
      if (["pcb","schematic"].includes(read.header.kind)) recovered.documents.push(M.document(read));
    }
    return {storage,recovered};
  }
  const design = Atrium.project("Schematic pages", []);
  const wide = Atrium.sheet("schematic","Analogue"), fixed = Atrium.sheet("schematic","Controller");
  design.documents = [wide,fixed];
  wide.sheet = {infinite:true,params:{Title:"Analogue inputs"},size:"A3",titleBlock:"ansi"};
  fixed.sheet = {size:"A4",infinite:false};
  wide.items.push({id:"wide-frame",kind:"textframe",role:"frame",text:"Analogue inputs",x:-75,y:-40,w:90,h:65});
  const offsheet = {id:"fixed-offsheet",kind:"offsheet",io:"unspecified",text:"AUX",x:5,y:5};
  fixed.items.push(offsheet, {id:"fixed-frame",kind:"textframe",role:"frame",text:"Diagnostics",x:60,y:20,w:35,h:24});
  design.outputJobs = [{version:2,name:"Schematic pages",folder:"{project}-{rev}",package:{mode:"folder"},outputs:[
    {id:"whole",kind:"pdf",enabled:true,options:{infiniteScale:1,infiniteLayout:"fit"}},
    {id:"scaled",kind:"pdf",enabled:true,options:{infiniteScale:.75,infiniteLayout:"tile"}},
  ]}];
  const {storage,recovered} = roundTrip(design);
  const sheets = storage.files.filter(r=>r.file.header.kind==="schematic").map(r=>r.file);
  const [wideFile,fixedFile] = [wide,fixed].map(d=>sheets.find(file=>file.header.id===d.id));
  assert.deepEqual(normalized(wideFile.header.sheet),wide.sheet);
  assert.deepEqual(normalized(fixedFile.header.sheet),{size:"A4"});
  assert.equal(fixedFile.get(offsheet.id).io,undefined);
  for (const doc of design.documents) {
    const orig=doc.items.find(i=>i.role==="frame"), stored=sheets.find(f=>f.header.id===doc.id).get(orig.id);
    const frame=recovered.documents.find(d=>d.id===doc.id).items.find(i=>i.id===orig.id);
    assert.equal(stored.kind,"frame"); assert.equal(stored.name,orig.text);
    assert.deepEqual(stored.at,[orig.x,orig.y].map(n=>n*1e6));
    assert.equal(stored.w,orig.w*1e6); assert.equal(stored.h,orig.h*1e6);
    assert.equal(frame.kind,"textframe"); assert.equal(frame.role,"frame"); assert.equal(frame.text,orig.text);
    assert.equal(frame.name,undefined);
  }
  const job=[...storage.manifest.records()].find(r=>r.kind==="outputJob");
  assert.deepEqual(normalized(job.value.outputs[0].options),{});
  assert.ok(job.value.outputs.some(o=>o.options?.infiniteScale==="0.75"));
  assert.ok(recovered.outputJobs[0].outputs.some(o=>o.options?.infiniteScale===0.75));
  const options={...recovered.documents.find(d=>d.id===wide.id),sheet:{...wide.sheet,infinite:false}};
  const edit=M.documentEdits(wideFile,options,{settings:true});
  const patched=F.applyDelta(wideFile,edit).file;
  assert.equal(patched.header.sheet.infinite,undefined);
  assert.equal(patched.header.sheet.size,"A3");

  const pins = p => AtriumHierarchy.compile(p).nets.filter(n=>n.pins.length)
    .map(n=>[n.name,n.pins.map(c=>c.ref+"."+c.pin.number).sort()]).sort();
  const definition = {id:"net-part",name:"Signal part",prefix:"R",footprint:{shapes:[],pads:[]},
    symbol:{shapes:[],pins:[{x:0,y:0,number:"1",name:"Signal",electrical:0}]}};
  const rule = netScope => ({id:"scope",type:"ercNetScope",name:"NetIdentifierScope",where:"schematic",
    priority:1,scope:{languageVersion:1,source:"object"},enabled:true,netScope});
  const expectedNames = {
    hyphen:["Net-R1_CH1-1","Net-R1_CH2-1"],
    underscore:["NetR1_CH1_1","NetR1_CH2_1"],
    "future-channel":["SIGNAL_CH1","SIGNAL_CH2"],
  };
  for (const [style, names] of Object.entries(expectedNames)) {
    const input = Atrium.project("Repeated channels",[definition]);
    const top = input.documents[0], child = Atrium.sheet("schematic","Channel");
    input.documents.push(child);
    input.rules = {version:3,list:[rule("hierarchical")]};
    top.items.push({id:"repeat",kind:"sheetsymbol",name:"Repeat(CH,1,2)",sheet:child.id,x:25,y:0,w:20,h:10,entries:[]});
    const autoName = {part:"source",pin:"1",style};
    if (style==="future-channel") autoName.qualifier={scope:"bank",format:2};
    const label = {id:"net-name",kind:"netlabel",autoName,text:"SIGNAL",x:5.08,y:0};
    child.items.push(
      {id:"source",kind:"part",def:definition.id,ref:"R1",x:0,y:0,angle:0},
      {id:"signal-wire",kind:"wire",points:[[0,0],[5.08,0]]},
      label,
    );
    const {storage,recovered}=roundTrip(input);
    const expected = names.map((name, index)=>[name,["R1_CH"+(index+1)+".1"]]);
    assert.deepEqual(pins(input),expected,style);
    assert.deepEqual(pins(recovered),expected,style);
    const original=storage.files.find(r=>r.file.get(label.id))?.file;
    const future=M.parse(F.serialize(F.create({...original.header,formatVersion:"2.1"},[...original.records()])));
    const doc=M.document(future), neighbour=doc.items.find(i=>i.id!==label.id && Number.isFinite(i.x));
    const edited=F.applyDelta(future,M.documentEdits(future,doc,{put:[{...neighbour,x:neighbour.x+1}]})).file;
    assert.deepEqual(normalized(edited.get(label.id).autoName),label.autoName);
  }

  const imported=Atrium.project("Imported geometry",[]), [schematic,board]=imported.documents;
  schematic.netScope="automatic";
  imported.rules={version:3,list:[{...rule("flat"),origin:{kind:"import",tool:"Altium"}}]};
  const shape = AtriumBoardShape;
  const outline = shape.fromPolygon([[0,0],[30,0],[30,20],[0,20]]);
  const opening = shape.fromPolygon([[23,11],[28,11],[28,16],[23,16]]).contour;
  shape.apply(board,{...outline,cutouts:[opening]},"altium");
  const contour = shape.fromPolygon([[12,2],[18,2],[18,8],[12,8]]).contour;
  const cutouts = [[shape.arc([15,5],1,0,0,false)]];
  const points = shape.flattenContour(contour);
  const region = {id:"copper-region",kind:"graphic",layer:"Top",net:"GND",fill:true,closed:true,width:0,points,
    regionShape:{version:1,contour,cutouts,sig:shape.signature(points)}};
  board.items.push(region);
  const back=roundTrip(imported).recovered;
  assert.equal(AtriumHierarchy.scopeSetting(back),"flat");
  assert.equal(AtriumHierarchy.sourceAutomatic(back),true);
  const reopened=back.documents.find(d=>d.id===board.id);
  assert.deepEqual(reopened.boardShape.cutouts,board.boardShape.cutouts);
  assert.deepEqual(reopened.items.find(i=>i.id===region.id).regionShape.cutouts,region.regionShape.cutouts);
}

async function main() {
  nativeSchematicFields();
  const unkeyed = {format: "atrium", version: 1, name: "Unkeyed", library: [], documents: [{
    kind: "schematic", name: "Sheet", grid: 1.2700004, outline: [], notes: [],
    items: [{kind: "netlabel", x: 0.00000254, y: 0, text: "NET"},
      {kind: "textframe", x: 0.00000254, y: 0, text: "x^2", math: true, w: 2, h: 1}],
  }]};
  const first = M.fromEditor(unkeyed), second = M.fromEditor(unkeyed);
  const firstDoc = M.document(first.files[1].file), secondDoc = M.document(second.files[1].file);
  const assigned = [first.manifest.header.id, firstDoc.id, ...firstDoc.items.map(i => i.id)];
  assert.ok(assigned.every(AtriumUUID.isV7));
  assert.notEqual(first.manifest.header.id, second.manifest.header.id);
  assert.notEqual(firstDoc.id, secondDoc.id, "independently adopted objects have their own native IDs");
  assert.equal(unkeyed.documents[0].id, undefined);
  const canonicalSheet = M.parse(F.serialize(first.files[1].file));
  const reopened = M.document(canonicalSheet);
  assert.deepEqual([reopened.id, ...reopened.items.map(i => i.id)], assigned.slice(1));
  assert.deepEqual(first.residuals.map(proof => proof.recordKind), ["documentSettings", "netlabel", "math"]);
  const [settingsProof, ...itemProofs] = first.residuals;
  const settings = canonicalSheet.records().find(record => record.kind === "documentSettings");
  assert.equal(settingsProof.id, canonicalSheet.header.id);
  assert.equal(settingsProof.property, "/grid");
  assert.equal(settingsProof.nativeValue, settings.value.grid);
  assert.notEqual(settings.id, settingsProof.id, "the singleton field proof is independent of the settings row UUID");
  for (const proof of itemProofs) assert.equal(proof.recordKind, canonicalSheet.get(proof.id).kind);
  const precision = first.residuals[1];
  assert.equal(precision.nativeValue, 3);
  assert.equal(precision.fingerprint, F.sha256(utf8(F.canonical({
    owner: precision.owner, id: precision.id, property: precision.property, value: precision.nativeValue,
  }))));
  const precisionField = (file, index = 0) => {
    const record = file.get(precision.id);
    return {owner: file.header.id, id: record.id, recordKind: record.kind, property: "/at/" + index,
      value: record.at[index], unit: "nm"};
  };
  const exactLength = {unit: "nm", numerator: "127", denominator: "50"};
  assert.deepEqual(M.restoreResidual(precisionField(canonicalSheet), precision), exactLength);
  const {nativeValue, recordKind, ...oldProof} = precision;
  assert.deepEqual(M.restoreResidual(precisionField(canonicalSheet), oldProof), exactLength);
  assert.equal(M.restoreResidual({...precisionField(canonicalSheet), recordKind: undefined}, precision), null);
  const changedKind = F.edit(canonicalSheet, {put: [{...canonicalSheet.get(precision.id), kind: "offsheet"}]});
  assert.notEqual(changedKind.get(precision.id).kind, recordKind);
  assert.equal(changedKind.get(precision.id).at[0], nativeValue);
  assert.equal(M.restoreResidual(precisionField(changedKind), precision), null);
  assert.equal(M.restoreResidual(precisionField(canonicalSheet, 1), precision), null);
  assert.equal(M.restoreResidual({...precisionField(canonicalSheet), unit: "nanodeg"}, precision), null);
  assert.equal(M.restoreResidual({...precisionField(canonicalSheet), owner: "another-canvas"}, precision), null);
  assert.equal(M.restoreResidual({...precisionField(canonicalSheet), id: "generated-image-bounds"}, precision), null);
  const editedSheet = F.edit(canonicalSheet, {put: [{...canonicalSheet.get(precision.id), at: [4, 0]}]});
  assert.equal(M.restoreResidual(precisionField(editedSheet), oldProof), null);
  assert.deepEqual(editedSheet.get(precision.id).at, [4, 0]);
  for (const malformed of [
    {...precision, denominator: "0"}, {...precision, nativeValue: nativeValue + 1},
    {...precision, recordKind: ""}, {...precision, recordKind: null},
    {...precision, numerator: "-1", denominator: "2"}, {...precision, numerator: "1", denominator: "1"},
  ]) assert.equal(M.restoreResidual(precisionField(canonicalSheet), malformed), null);
  const evenTie = {...precisionField(canonicalSheet), value: 2};
  assert.deepEqual(M.restoreResidual(evenTie, {...precision, nativeValue: 2, numerator: "1", denominator: "2",
    fingerprint: F.sha256(utf8(F.canonical({owner: evenTie.owner, id: evenTie.id, property: evenTie.property, value: 2}))),
  }), {unit: "nm", numerator: "5", denominator: "2"});
  const {project, credit} = authoredDesign();
  const root = M.fromEditor(project);
  const fileOf = kind => root.files.find(member => member.file.header.kind === kind).file;
  const board = fileOf("pcb"), sheet = fileOf("schematic");
  assert.deepEqual(board.get("p1").at, [1250000, 7500000]);
  assert.equal(board.get("p1").angle, 270000000000);
  assert.deepEqual(M.document(board).items[0], project.documents[1].items[0]);
  assert.equal(sheet.get("label").at[0], 1270000);
  assert.equal(sheet.get("formula").kind, "math");
  assert.equal(sheet.get("formula").em, 1100000);
  assert.equal(M.document(sheet).items.find(item => item.id === "formula").text, "\\frac12");
  assert.equal(M.document(sheet).items.find(item => item.id === "frame").role, "frame");
  assert.equal(sheet.get("one").x, 4000000);
  assert.equal(sheet.get("one").name, "Image.png");
  assert.deepEqual(sheet.get("one").asset, sheet.get("two").asset);
  assert.ok(!text(sheet).includes("base64,"));
  assert.deepEqual(M.documentDependencies(sheet, {itemIds: ["one"]}).assets.map(ref => ref.ownerId), ["one"]);
  assert.deepEqual(M.documentDependencies(sheet, {itemIds: ["label"]}), {libraries: [], assets: []});
  assert.deepEqual(M.document(fileOf("drawing")).drawing, project.documents[2].drawing);
  assert.deepEqual(M.document(fileOf("panel")).panel, project.documents[3].panel);
  const panel = fileOf("panel"), panelEdit = M.document(panel);
  panelEdit.panel.cells[0].x += 1;
  const editedPanel = F.applyDelta(panel, M.documentEdits(panel, panelEdit, {settings: true}));
  assert.equal(editedPanel.changedRows, 1);
  assert.equal(M.document(editedPanel.file).panel.cells[0].x, 2);
  assert.deepEqual(M.block(fileOf("block")).size, [12, 4]);
  assert.deepEqual(M.library(fileOf("library")).source, credit);
  assert.ok(!text(fileOf("library")).includes("/opaque/host-only"));
  assert.deepEqual(M.library(M.createLibrary({...M.library(fileOf("library")), name: "Edited"})).source, credit);
  assert.equal(root.models.length, 1);
  assert.ok(root.models[0].path.endsWith(".step.gz"));
  assert.match(root.modelDiagnostics[0].name, /unresolved/);
  assert.ok(!text(board).includes("ISO-10303-21"));
  assert.equal(M.document(board).bodyModels[0].model.sha256, M.document(board).bodyModels[1].model.sha256);
  assert.equal(M.document(board, {modelText: () => "STEP"}).bodyModels[1].stepText, "STEP");

  const png = sheet.get("one").asset;
  const pdf = {sha256: F.sha256(utf8("%PDF clip origin")), mediaType: "application/pdf", byteLength: 16};
  const placed = {kind: "image", id: "clip", asset: png, name: "Clip.png", extent: [1, 1], x: 1, y: 2, w: 3, h: 4,
    clip: {source: pdf, name: "Spec.pdf", page: 2, region: [0, 0, 1000000, 1000000]}};
  const mark = {kind: "imageMarkup", id: "mark", imageId: "clip", at: [500000, 370000], to: [800000, 880000], width: 3000};
  const stroke = {kind: "inkStroke", id: "stroke", points: [[0.5, -0.25, 128], [1.5, 0.75, 220]], width: 0.2};
  const widget = {kind: "textframe", id: "widget", text: "Fallback", x: 1, y: 2, w: 3, h: 4,
    widget: {type: "sample", state: {at: [5000, 6000], width: 8000}, fallback: {type: "image", assetRef: png, alt: "Fallback"}}};
  assert.deepEqual(new Set(M.ownerDependencies(placed).map(member => member.sha256)), new Set([png.sha256, pdf.sha256]));
  assert.deepEqual(M.ownerDependencies(placed, {purpose: "display"}).map(member => member.sha256), [png.sha256]);
  assert.deepEqual(M.ownerDependencies(widget).map(member => member.sha256), [png.sha256]);
  const attached = F.applyDelta(sheet, M.documentEdits(sheet, undefined, {put: [placed, mark, stroke, widget]})).file;
  assert.equal(sheet.get("clip"), undefined);
  assert.deepEqual(attached.get("mark").at, mark.at);
  assert.equal(attached.get("mark").width, mark.width);
  assert.deepEqual(attached.get("stroke").points[0], [500000, -250000, 128]);
  assert.deepEqual(attached.get("widget").widget.state, widget.widget.state);
  const opened = M.document(M.parse(F.serialize(attached)), {nativeAssets: true});
  assert.deepEqual(opened.items.find(item => item.id === "mark"), mark);
  assert.deepEqual(opened.items.find(item => item.id === "stroke"), stroke);
  assert.equal(opened.items.find(item => item.id === "clip").src, undefined);
  assert.deepEqual(M.documentDependencies(attached, {itemIds: ["clip"]}).assets.map(asset => asset.sha256), [png.sha256]);
  assert.ok(M.dependencies(attached).some(ref => ref.sha256 === pdf.sha256));

  // A folder open reads each canonical row once for its editable projection and visible dependencies.
  for (const file of [board, attached, fileOf("drawing"), fileOf("panel")]) {
    let traversals = 0;
    const counted = {...file, projectedRecords() { traversals++; return file.projectedRecords(); }};
    const combined = M.documentWithDependencies(counted, {nativeAssets:true});
    assert.equal(traversals, 1);
    assert.deepEqual(combined.owner, M.document(file, {nativeAssets:true}));
    assert.deepEqual(combined.dependencies, M.documentDependencies(file));
  }
  const native = M.readOptions("pcb", "future-board");
  const future = F.create({kind:"pcb", id:"future-board", formatVersion:"2.2"}, [
    {kind:"futureGeometry", id:"hidden", def:"unknown-part", asset:png},
    {kind:"track", id:"path", order:"A", points:[[1000000,-2000000],[3000000,4000000]],
      extra:JSON.parse('{"__proto__":{"futureField":"retained"},"constructor":"data","nested":{"$literal":{"$number":"2.5"}}}')},
  ], native);
  const combined = M.documentWithDependencies(future);
  assert.deepEqual(combined.dependencies, {libraries:[], assets:[]});
  assert.deepEqual(combined.owner.items.map(item => item.id), ["path"]);
  assert.deepEqual(combined.owner.items[0].points, [[1,-2],[3,4]]);
  assert.ok(!Object.hasOwn(combined.owner.items[0], "order"));
  const {extra} = combined.owner.items[0];
  assert.equal(Object.getPrototypeOf(extra), Object.prototype);
  assert.ok(Object.hasOwn(extra, "__proto__"));
  assert.deepEqual(extra.__proto__, {futureField:"retained"});
  assert.deepEqual(extra.nested, {$number:"2.5"});
  assert.equal(extra.constructor, "data");
  assert.equal(future.get("hidden").asset.sha256, png.sha256);

  let current = board;
  const live = M.document(board);
  for (const movement of [0.127, 0.127]) {
    live.items[0].x += movement;
    const changed = F.applyDelta(current, M.documentEdits(current, live, {put: [live.items[0]]}));
    assert.equal(changed.changedRows, 1);
    assert.equal(changed.splices.length, 1);
    assert.strictEqual(changed.file.get("track"), board.get("track"));
    assert.equal(changed.headerChanged, false);
    current = changed.file;
  }
  const added = F.applyDelta(current, M.documentEdits(current, live, {put: [{kind: "track", id: "t2", points: [[1, 2], [2, 2]], width: 0.15}]}));
  assert.equal(added.changedRows, 1);
  assert.equal(added.splices[0].remove, 0);
  assert.equal(M.document(added.file).items.at(-1).id, "t2");

  const files = new Map(root.files.map(member => [member.path, F.serialize(member.file)]));
  for (const asset of root.assets) files.set(asset.path, asset.bytes);
  // The production compression module verifies its own gzip goldens. Here the injected identity
  // decoder exercises the separate raw identity and graph checks without a host-specific library.
  for (const model of root.models) files.set(model.path, model.raw);
  const read = path => files.get(path);
  const verified = await C.verify(root.manifest, read, {verifyModel: bytes => bytes});
  {
    const gzipFiles = new Map(files);
    for (const model of root.models) gzipFiles.set(model.path, AtriumFormat2Models.encode(model.raw));
    const record = {path:"Print.waffle",bytes:F.serialize(root.manifest)}, boot = () => AtriumFolderProjectEngine.create();
    const readFile = path => ({path,bytes:gzipFiles.get(path)});
    const calls = [];
    const readBatch = paths => {
      calls.push(paths);
      return paths.map(readFile);
    };
    const saved = await boot().run({op:"closure",record,full:true,read:readFile,readBatch});
    const oracle = await C.verify(root.manifest, path => gzipFiles.get(path), {verifyModel:AtriumFormat2Models.decode});
    assert.equal(saved.sha256,oracle.sha256);
    assert.deepEqual(saved.members,oracle.members);
    const manifest = M.manifest(root.manifest);
    for (const ref of manifest.members) {
      const bytes = gzipFiles.get(ref.path);
      if (ref.kind === "library") {
        assert.deepEqual(saved.project.library.find(d => d.id === ref.id),M.library(M.parse(bytes)));
      } else if (F.documentSuffix[ref.kind]) {
        assert.deepEqual(saved.project.documents.find(d => d.id === ref.id),M.document(M.parse(bytes),{name:ref.name}));
      }
    }
    assert.ok(calls.some(paths => paths.length>1) && calls.every(paths => paths.length<=8));
    const modelPath = root.models[0].path;
    const corrupt = gzipFiles.get(modelPath).slice(); corrupt[corrupt.length-8] ^= 1;
    gzipFiles.set(modelPath, corrupt);
    await assert.rejects(boot().run({op:"closure",record,full:true,read:readFile,readBatch}), /CRC32/);
  }
  {
    const sheetPath = M.manifest(root.manifest).members.find(ref => ref.id === "sheet").path;
    const members = new Map(files), bytes = members.get(sheetPath), sheet = M.parse(bytes);
    const longFrame = {...sheet.get("frame"), text:"independent member".repeat(8192)};
    const expanded = F.serialize(F.edit(sheet,{put:[longFrame]}));
    // The digest must use this member's byte range, excluding its backing buffer's guards.
    const guarded = new Uint8Array(expanded.length + 8);
    guarded.fill(127); guarded.set(expanded,4);
    members.set(sheetPath,guarded.subarray(4,-4));
    const read = path => members.get(path), readBatch = paths => paths.map(read);
    const verifyModel = bytes => bytes;
    const expected = await C.verify(root.manifest,read,{readBatch,verifyModel});
    const sidecars = globalThis.AtriumImportSidecars;
    const descriptor = Object.getOwnPropertyDescriptor(globalThis,"crypto");
    if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis,"crypto",{value:{subtle:{}},configurable:true});
    const sha = globalThis.crypto.subtle.digest ? sidecars.sha : async value => F.sha256(value);
    try {
      let calls = 0;
      globalThis.AtriumImportSidecars = {...sidecars, async sha(value) {
        calls++; return sha(value);
      }};
      const options = {readBatch,verifyModel,accelerateDigests:true};
      assert.deepEqual(await C.verify(root.manifest,read,options),expected);
      assert.equal(calls,1);
      const verifiedModels = (paths, refs) => paths.map((path,index) => {
        const raw = read(path);
        if (refs[index].kind !== "model") return raw;
        const sha256 = F.sha256(raw);
        return {path,sha256,length:raw.length,model:{sha256,byteLength:raw.length}};
      });
      assert.deepEqual(await C.verify(root.manifest,read,{...options,readBatch:verifiedModels,proveModels:true,
        verifyModel(){throw Error("Native model proof should leave the model payload in the host");}}),expected);
      assert.equal(calls,2);
      globalThis.AtriumImportSidecars = {...sidecars, async sha() {
        calls++; throw Error("Web Crypto unavailable");
      }};
      assert.deepEqual(await C.verify(root.manifest,read,options),expected);
      assert.equal(calls,3);
      const controller = new AbortController();
      globalThis.AtriumImportSidecars = {...sidecars, async sha(value) {
        controller.abort(Error("Cancelled during digest")); return sha(value);
      }};
      await assert.rejects(C.verify(root.manifest,read,{...options,signal:controller.signal}), /Cancelled during digest/);
    } finally {
      globalThis.AtriumImportSidecars = sidecars;
      if (descriptor) Object.defineProperty(globalThis,"crypto",descriptor);
      else delete globalThis.crypto;
    }
  }

  const release = M.manifest(root.manifest).releases[0];
  const frozenRoot = M.parse(read(M.assetPath(release.snapshot)), {kind: "snapshot"});
  const frozen = M.snapshot(frozenRoot);
  assert.ok(frozen.members.some(member => member.fileKind === "pcb"));
  assert.ok(verified.members.some(member => member.kind === "snapshot"));
  const working = root.files.find(member => member.file === board);
  {
    const library = root.files.find(member => member.file.header.kind === "library");
    const schematic = root.files.find(member => member.file === sheet);
    const toEarlierAlias = ({file}) => {
      const alias = [...file.records()].find(row => row.kind === "modelAlias" && row.value.id === "model1");
      assert.ok(AtriumUUID.isV7(alias?.id));
      return F.edit(file, {remove: [alias.id], put: [{...alias, id: alias.value.id}]});
    };
    const earlierBoard = toEarlierAlias(working), earlierLibrary = toEarlierAlias(library);
    files.set(working.path, F.serialize(earlierBoard));
    files.set(library.path, F.serialize(earlierLibrary));
    const earlier = await C.verify(root.manifest, read, {verifyModel: bytes => bytes});
    assert.equal(earlier.members.length, verified.members.length);
    assert.equal(earlier.members.find(member => member.path === working.path).sha256, F.sha256(read(working.path)));
    assert.equal(earlier.members.find(member => member.path === library.path).sha256, F.sha256(read(library.path)));
    assert.equal(M.document(earlierBoard).bodyModels[0].id, "model1");
    assert.deepEqual(M.library(earlierLibrary).footprint.bodyModels[0].model, M.document(earlierBoard).bodyModels[0].model);

    for (const id of ["model1", "p1"]) {
      files.set(schematic.path, F.serialize(F.edit(sheet, {put: [{...sheet.get("label"), id}]})));
      await assert.rejects(C.verify(root.manifest, read, {verifyModel: bytes => bytes}), /Duplicate live object ID/);
    }
    files.set(schematic.path, F.serialize(sheet));
    const duplicateAlias = {...earlierBoard.get("model1"), id: "board/modelAlias/model1"};
    files.set(working.path, F.serialize(F.edit(earlierBoard, {put: [duplicateAlias]})));
    await assert.rejects(C.verify(root.manifest, read, {verifyModel: bytes => bytes}), /Duplicate model alias/);
    files.set(library.path, F.serialize(library.file));
  }
  files.set(working.path, F.serialize(current));
  const moved = await C.verify(root.manifest, read, {verifyModel: bytes => bytes});
  assert.notEqual(moved.sha256, verified.sha256);
  for (const member of frozen.members) assert.equal(F.sha256(read(member.path)), member.sha256);
  const futureRef = {kind: "document", id: "wave", docKind: "waveform", name: "Scope", path: "Scope.wwave"};
  const futureManifest = F.create({...root.manifest.header, formatVersion: "2.1"}, [...root.manifest.records(), futureRef]);
  const opaqueBytes = utf8('{"kind":"waveform","formatVersion":"2.1","id":"wave"}\n{"kind":"trace","id":"future"}\n');
  files.set(futureRef.path, opaqueBytes);
  const futureClosure = await C.verify(futureManifest, read, {verifyModel: bytes => bytes});
  assert.equal(futureClosure.members.find(member => member.path === futureRef.path).sha256, F.sha256(opaqueBytes));
  const missing = M.assetPath(sheet.get("one").asset);
  const input = files.get(missing);
  files.delete(missing);
  await assert.rejects(C.verify(root.manifest, read, {verifyModel: bytes => bytes}), /Missing project member/);
  files.set(missing, input);
  await assert.rejects(C.verify(root.manifest, read, {verifyModel: () => utf8("wrong model")}), /failed verification/);
  const withoutIndex = M.detachImports(F.edit(root.manifest, {put: [{kind: "importIndex", id: "imports",
    path: ".waffle/imports/" + "a".repeat(64) + "/bindings-imports.json"}]}), ["imports"]);
  assert.equal(text(withoutIndex), text(root.manifest));

  const worker = AtriumFormat2Worker.create();
  const load = worker.dispatch({op: "load", key: "board", bytes: F.serialize(board)});
  const delta = worker.dispatch({op: "editDocument", key: "board", cursor: load.cursor,
    put: [{...live.items[0], x: 2}]});
  assert.equal(delta.changedRows, 1);
  assert.equal(worker.dispatch({op: "serialize", key: "board", cursor: load.cursor}).sha256, load.physicalSha256);
  assert.notEqual(worker.dispatch({op: "serialize", key: "board", cursor: delta.cursor}).sha256, load.physicalSha256);
  worker.dispatch({op: "release", key: "board", cursor: load.cursor});
  assert.throws(() => worker.dispatch({op: "serialize", key: "board", cursor: load.cursor}), /expired/);
  console.log("format-2-model: owner, asset, release, closure and worker cursor checks passed");
}
globalThis.__testDone=main().catch(error => { console.error(error); process.exitCode = 1; });
