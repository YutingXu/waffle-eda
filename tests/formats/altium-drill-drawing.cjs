"use strict";
// Original binary records exercise the reader's explicit pad/via membership.
// The plotted Gerber is decoded independently of the manufacturing writer.
const assert = require("node:assert/strict");
const C = require("./gerber-compare.cjs");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const k of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "pcb-text", "stackup", "rules", "viastack",
    "board-shape", "fab-outputs", "source-file", "altium-ids", "pcb-import", "pcb-patch", "source-copy", "io", "import-link", "import-worker-client"]) require(require("../support/app-source-paths.cjs").appFile(k + ".js"));
const A = Atrium, F = AtriumFabOutputs, unit = .00000254, tick = mm => Math.round(mm / unit);
const word = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n, 0); return b; };
const block = b => Buffer.concat([word(b.length), b]);
const prop = text => block(Buffer.from("|" + text + "\0"));
const list = indices => Buffer.concat([word(indices.length), ...indices.map(word)]);

function primitive(x, via = false, plated = true, slot = 0, transposed = false) {
  const g = Buffer.alloc(160), v = new DataView(g.buffer, g.byteOffset, g.length);
  g[0] = 74;
  for (const k of [3, 5, 7]) v.setUint16(k, 65535, true);
  g.writeInt32LE(tick(x), 13); g.writeInt32LE(tick(5), 17); g.writeInt32LE(tick(1.5), 21);
  if (via) {
    g.writeInt32LE(tick(.5), 25); g[29] = 1; g[30] = 32;
    return Buffer.concat([Buffer.from([3]), block(g)]);
  }
  g.writeInt32LE(tick(1.5), 25); g.writeInt32LE(tick(transposed ? slot : .5), 45); g[49] = 1; g[60] = Number(plated);
  const extra = Buffer.alloc(276);
  if (slot) { extra[262] = 2; extra.writeInt32LE(tick(transposed ? .5 : slot), 263); new DataView(extra.buffer, extra.byteOffset, extra.length).setFloat64(267, transposed ? 0 : 90, true); }
  const empty = block(Buffer.alloc(0));
  return Buffer.concat([Buffer.from([2]), block(Buffer.from([1, 49])), empty, empty, empty, block(g), block(extra)]);
}
const rows = [
  {mark: 4, pads: [3], slot: 1.5, transposed: true}, {mark: 0, pads: [0]}, {mark: 3, pads: [2], slot: 1},
  {mark: 5, pads: [1], npth: true}, {mark: 2, vias: [0]}, {mark: 7, pads: [4]}
];
function manager(tools) {
  return Buffer.concat([word(0xffffffff), word(tools.length), ...tools.flatMap(t => [
    prop("HOLEMARK=" + t.mark + "|LAYERPAIR=0|OBJECTID=" + (t.vias ? "Via" : "Pad") +
      "|TOOLSIZE=" + (t.transposed ? t.slot : .5) + "mm|TOOLLENGTH=" + (t.transposed ? .5 : t.slot || 0) + "mm|HOLETYPE=" + (t.slot ? 2 : 0) + "|PLATED=" + (t.npth ? "FALSE" : "TRUE") + "|DRILLTYPE=0"),
    list(t.pads || []), list(t.vias || [])]), word(0)]);
}
function board(managerBytes) {
  const ole = CFB.utils.cfb_new(), add = (key, value) => CFB.utils.cfb_add(ole, key, value);
  add("Board6/Data", prop("DRILLSYMBOLASENUM=0|DRILLSYMBOLSIZE=123|VX0=0mm|VY0=0mm|VX1=45mm|VY1=0mm|VX2=45mm|VY2=10mm|VX3=0mm|VY3=10mm"));
  add("Pads6/Data", Buffer.concat([primitive(5), primitive(10, false, false), primitive(15, false, true, 1),
    primitive(20, false, true, 1.5, true), primitive(25), primitive(30)]));
  add("Vias6/Data", primitive(35, true));
  if (managerBytes) add("DrillManager/Data", managerBytes);
  return {name: "Board.PcbDoc", bytes: new Uint8Array(CFB.write(ole, {type: "array"}))};
}
const job = (size, board = "Board.PcbDoc", mode = "GraphicsSymbol") => "Configuration3_Item1=Record=GerberView|DrillDrawingSymbol=" + mode +
  "|DrillDrawingSymbolSize=" + size + "|DocumentPath=Example\\" + board;
function open(bytes, plot = job(200000)) {
  const files = [{name: "Board.PrjPcb", bytes: new TextEncoder().encode("[Document1]\nDocumentPath=Board.PcbDoc\n[OutputGroup2]\n" + plot)}, board(bytes)];
  const all = files.map(f => AtriumIO.read(f.name, f.bytes));
  return A.validate(JSON.parse(JSON.stringify(AtriumImport.assemble(all, files, A.project("Test", AtriumParts.catalogue), null).after)));
}
const date = new Date(2025, 0, 1), options = {date, origin: "absolute"};
const pcb = p => p.documents.find(d => d.kind === "pcb");
const sortedPads = p => pcb(p).items.filter(i => i.kind === "pad").sort((a, b) => a.x - b.x);
const file = (out, k) => out.files.find(f => f.kind === k).content;
const emit = p => F.build(p, pcb(p), options);
const close = (x, y) => Math.abs(x - y) < .00001;
const packet = manager(rows), p = open(packet);
const pads = sortedPads(p);
assert.deepEqual(pcb(p).sourceDrillDrawing.tools.map(t => t.mark), [4, 0, 3, 5, 2, 7, null]);
assert.deepEqual(pads.map(item => pcb(p).sourceDrillDrawing.tools[item.sourceDrillTool].mark), [0, 5, 3, 4, 7, null]);
assert.deepEqual(p.sourceDrillPlots, [{board: "board.pcbdoc", size: .508}]);
assert.equal(pads[1].plated, false);
for (const [pad, length] of [[pads[2], 1], [pads[3], 1.5]]) {
  assert.ok(close(pad.drill, .5) && close(pad.slotLength, length));
  assert.equal(Math.abs(pad.slotAngle), 90);
}
// A previous save without drill metadata keeps its content IDs and binary-copy
// compatibility when reopened with the new reader.
{
  const original = board(packet), current = AtriumIO.read(original.name, original.bytes);
  const legacy = JSON.parse(JSON.stringify(current.documents[0]));
  delete legacy.sourceDrillDrawing;
  for (const item of legacy.items) delete item.sourceDrillTool;
  for (const d of [current.documents[0], legacy]) {
    const copy = AtriumSourceCopy.prepare(d, current.library, original.bytes);
    assert.deepEqual(Array.from(copy.bytes), Array.from(original.bytes));
  }
  const owner = AtriumAltiumIds.scope("board").content("via", {x:1, sourceDrillTool:2});
  assert.equal(owner, AtriumAltiumIds.scope("board").content("via", {x:1}));
}
const result = emit(p), map = C.parseGerber(file(result, "drillmap"));
assert.equal(map.attributes.file[".FileFunction"], "Drillmap");
assert.equal(result.files.find(f => f.kind === "drillmap").stats.tools, 6);
assert.deepEqual(map.warnings, []);
assert.equal(map.flashes.length + map.regionCount, 0);
assert.equal(map.drawCount, 4 + 12 + 12 + 8 + 4 + 3);
const symbols = [4, 12, 12, 8, 4, 0, 3];
for (let i = 0; i < symbols.length; i++) {
  const x = 5 + i * 5, symbol = map.draws.filter(d => d.points.every(q => Math.abs(q[0] - x) < .4 && Math.abs(q[1] - 5) < .4));
  assert.equal(symbol.length, symbols[i], "symbol at " + x + " mm");
  assert.ok(symbol.every(d => close(d.width, .0508)));
}
assert.ok(close(map.bbox[0], 5 - .508 * .4 - .0508 / 2));
assert.match(file(result, "drillreport"), /Altium symbol 3/);
assert.match(file(result, "drillreport"), /Altium symbol 4/);
const clone = p => JSON.parse(JSON.stringify(p));
const native = clone(p); delete pcb(native).sourceDrillDrawing;
const baseline = emit(native);
const machineFiles = r => r.files.filter(f => f.kind === "drill").map(f => [f.name, f.content]);
assert.deepEqual(machineFiles(result), machineFiles(baseline), "every physical drill stays at its native position, including the unmarked pad");
assert.deepEqual(result.files.filter(f => f.kind === "gerber"), baseline.files.filter(f => f.kind === "gerber"));
assert.match(baseline.files.find(f => f.kind === "drillmap").title, /drill table/);
assert.ok(C.parseGerber(file(baseline, "drillmap")).drawCount > 100);
const edited = clone(p);
sortedPads(edited)[2].slotLength = 1.2;
assert.match(emit(edited).files.find(f => f.kind === "drillmap").title, /drill table/, "editing a source tool cannot leave a stale mark");
const added = clone(p);
pcb(added).items.push({...sortedPads(added)[5], id: "newPad", x: 40});
assert.match(emit(added).files.find(f => f.kind === "drillmap").title, /drill table/, "copying an unlisted pad cannot hide a new physical hole");
const artwork = clone(p);
pcb(artwork).items.push({id: "annotation", kind: "track", layer: "Drill drawing", width: .1, net: "", points: [[1,-2],[3,-2]]});
assert.equal(C.parseGerber(file(emit(artwork), "drillmap")).drawCount, map.drawCount + 1);
const alternative = clone(p);
alternative.sourceDrillPlots = [{board: "another.pcbdoc", size: .2}];
assert.ok(close(C.parseGerber(file(emit(alternative), "drillmap")).draws[0].width, .127), "other jobs do not override the Gerber default");
alternative.sourceDrillPlots = [{board: "board.pcbdoc", size: .2}, {board: "board.pcbdoc", size: .4}];
assert.match(emit(alternative).files.find(f => f.kind === "drillmap").title, /drill table/);
const unsupported = clone(p);
pcb(unsupported).sourceDrillDrawing.tools[0].mark = 13;
assert.match(emit(unsupported).files.find(f => f.kind === "drillmap").title, /drill table/);
assert.equal(AtriumPCB.drillPlots("[OutputGroup1]\n" + job(200000) + "|PlotUsedDrillDrawingLayerPairs=False|PlotDrillDrawingLayerPair0_Checked=False")[0].size, null);
assert.equal(AtriumPCB.drillPlots("[OutputGroup1]\n" + job(200000) + "|MirrorDrillDrawingPlots=TRUE")[0].size, null);
assert.equal(pcb(open(packet.subarray(0, packet.length - 1))).sourceDrillDrawing, undefined);
assert.equal(pcb(open(manager([...rows, {mark: 1, pads: [0]}]))).sourceDrillDrawing, undefined);
assert.equal(pcb(open(manager([{mark: 0, pads: [99]}]))).sourceDrillDrawing, undefined);
assert.equal(pcb(open(null)).sourceDrillDrawing, undefined);
console.log("altium-drill-drawing: source tool ownership, actual Gerber symbols, job selection and native fallback verified");

// Carry only the documentary tool binding through a native folder and its saved import index.
// The plotted files are compared after physical placement and nc-tool grouping have run.
{
  const {nativeRoundTrip}=require("../support/native-cad.cjs");
  for(const name of ["translator-provenance","import-sidecars"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const provenance={version:1,files:[
    board(packet),{name:"Board.PrjPcb",bytes:new TextEncoder().encode("[Document1]\nDocumentPath=Board.PcbDoc\n[OutputGroup2]\n"+job(200000))}
  ].map(source=>({...source,sha256:AtriumFormat2.sha256(source.bytes)}))};
  const model=AtriumTranslatorProvenance.separate(clone(p),provenance), doc=pcb(model);
  const stored=AtriumImportSidecars.prepareSync([{scopeId:"drill-tools",documents:[doc.id],names:[doc.name],
    report:{translator:"altium",kinds:["pcb"]},provenance}]);
  const ref=stored.refs[0], index=AtriumImportSidecars.parse(stored.files.get(ref.path),ref);
  const restored=AtriumImportSidecars.restore(index), native=nativeRoundTrip({model,provenance});
  assert.ok(sortedPads(native).every(pad=>pad.sourceDrillTool===undefined));
  const bindings=AtriumImportSidecars.manufacturingProvenance([restored.provenance],doc.id);
  assert.deepEqual(Object.keys(bindings[0]),["drillDrawings"],"the plotter needs no original files or unrelated source metadata");
  assert.deepEqual(AtriumImportSidecars.manufacturingProvenance([restored.provenance],"other-board"),[]);
  const plot=(project,groups=bindings)=>F.build(project,pcb(project),{...options,provenance:groups});
  const saved=plot(native);
  for(const name of ["translator-table","translator-registry","translator-manufacturing","translators"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const requested={documentId:doc.id,provenance:bindings,date:options.date.toISOString(),origin:options.origin};
  const gerber=AtriumTranslators.export("gerber",native,{...requested,include:["drillmap"]});
  assert.equal(gerber.files[0].text,file(result,"drillmap"),"normal Gerber output uses the retained documentary binding");
  const nc=AtriumTranslators.export("excellon",native,requested);
  assert.deepEqual(nc.files.map(f=>[f.name,f.text]),machineFiles(result));
  assert.equal(file(saved,"drillmap"),file(result,"drillmap"),"all six precise original drill marks, sizes and positions");
  assert.equal(file(saved,"drillreport"),file(result,"drillreport"));
  assert.deepEqual(machineFiles(saved),machineFiles(result));
  native.name="Edits elsewhere";
  assert.equal(file(plot(native),"drillmap"),file(result,"drillmap"),"an unrelated project edit retains all physical marks");
  const detached=plot(native,[]);
  assert.match(detached.files.find(f=>f.kind==="drillmap").title,/drill table/);
  assert.deepEqual(machineFiles(detached),machineFiles(saved),"discarding source bindings cannot remove physical holes");
  const changed=clone(native); sortedPads(changed)[2].slotLength=1.2;
  assert.match(plot(changed).files.find(f=>f.kind==="drillmap").title,/drill table/);
  assert.deepEqual(machineFiles(plot(changed)),machineFiles(plot(changed,[])),"edited slots use current native geometry");
  const copied=clone(native);pcb(copied).items.push({...sortedPads(copied)[5],id:"new",x:40});
  assert.match(plot(copied).files.find(f=>f.kind==="drillmap").title,/drill table/);
  const removed=clone(native);const erased=sortedPads(removed)[1];
  pcb(removed).items=pcb(removed).items.filter(item=>item.id!==erased.id);
  assert.equal(C.parseGerber(file(plot(removed),"drillmap")).drawCount,map.drawCount-symbols[1]);
  assert.deepEqual(machineFiles(plot(removed)),machineFiles(plot(removed,[])));

  const placed=clone(p), land={...sortedPads(placed)[0],x:0,y:0,number:"1"};delete land.id;
  const original=sortedPads(placed)[0], placedBoard=pcb(placed);
  placed.library.push({id:"drilled-footprint",name:"Drilled connector",prefix:"J",footprint:{pads:[land],shapes:[]}});
  placedBoard.items[placedBoard.items.findIndex(i=>i.id===original.id)]={id:"owner",kind:"part",def:"drilled-footprint",ref:"J1",x:original.x,y:original.y};
  const placedSource={version:1}, clean=AtriumTranslatorProvenance.separate(placed,placedSource);
  const current=nativeRoundTrip({model:clean,provenance:placedSource});
  const restoredPlacement=AtriumTranslatorProvenance.toLegacy(current,placedSource), restarted=clone(placedSource);
  AtriumTranslatorProvenance.separate(restoredPlacement,restarted);
  assert.equal(restarted.drillDrawings.length,1,"a repeated source conversion keeps one documentary binding per board");
  const group=AtriumImportSidecars.manufacturingProvenance(placedSource,placedBoard.id);
  assert.equal(file(plot(current,group),"drillmap"),file(result,"drillmap"));
  assert.match(plot(current,[...group,...group]).files.find(f=>f.kind==="drillmap").title,/drill table/,"ambiguous source metadata falls back to current physical holes");
  const placement=pcb(current).items.find(i=>i.id==="owner");
  placement.x+=1;
  assert.match(plot(current,group).files.find(f=>f.kind==="drillmap").title,/source tool symbols/);
  pcb(current).items.push({...placement,id:"new-component",x:45});
  assert.match(plot(current,group).files.find(f=>f.kind==="drillmap").title,/drill table/);
}
console.log("Native drill artwork retains six original marks and independent NC output after edit, copy or detachment.");
