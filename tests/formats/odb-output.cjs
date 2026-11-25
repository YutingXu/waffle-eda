"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const {parseGerber,parseExcellon,holeShapes,bboxOf,compareDrills,rasterize} = require("./gerber-compare.cjs");
const R = require("../support/odb-read.cjs");
const date = new Date("2026-11-22T12:00:00Z");
const fixtures = process.argv.includes("--public") || process.argv.includes("--ipc356") ? JSON.parse(fs.readFileSync(0,"utf8")) : null;
const names = ["uuid-v7","model","parts","source-file","spatial","connectivity","pcb-pours","pcb-appearance","zip",
  "vectorize","pcb-text-rich","pcb-text","stackup","impedance","rigid-flex","rules","viastack","board-shape",
  "board-shape-editing","board-shape-sources","polygon-pour","bom","netlist","variants","fab-outputs","panel","vendor/zipjs-deflate","odb-eda","odb"];

if (fixtures) for (const [name, file] of fixtures.modules) {
  if (name === "cfb") globalThis.CFB = require(file);
  else require(file);
}
for (const name of names) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const G = globalThis, F = G.AtriumFabOutputs, A = G.Atrium;
const sorted = (values) => values.map(value => JSON.stringify(value)).sort();
const matrixName = name => name.toLowerCase().replace(/[^a-z0-9_+.-]+/g, "_").replace(/^[^a-z0-9]+|[._-]+$/g, "");
const byRole = {"outline":"profile_rout","Top mask":"solder_mask_top","Bottom mask":"solder_mask_bottom",
  "Top paste":"paste_top","Bottom paste":"paste_bottom","Silk":"silk_top","Bottom silk":"silk_bottom"};
const toArray = view => Buffer.from(view.buffer,view.byteOffset,view.byteLength);

function bitmapDiff(output, known, name) {
  const diff = R.layerXor(output, known);
  if (diff.differ && process.env.WAFFLE_ODB_TRACE) {
    const [x,y] = diff.first;
    const nearby = plot => plot.shapes.map(shape => [bboxOf([{...shape,dark:true}]),shape]).filter(([b]) => b && b[0] < x + .001 && b[2] > x - .001 &&
      b[1] < y + .001 && b[3] > y - .001).map(([b,shape]) => shape.k === "poly" ? {b,k:shape.k,dark:shape.dark} : shape);
    console.error(JSON.stringify({name,diff,odb:nearby(output),gerber:nearby(known)}));
  }
  assert.equal(diff.differ, 0, name + " XOR mismatch " + JSON.stringify(diff));
}

function drillsFromExcellon(plan, model) {
  const groups = new Map();
  for (const file of plan.files.filter(row => row.kind === "drill")) {
    const {content} = F.generate(model,plan,file), data = parseExcellon(content);
    assert.ok(data.units && !data.warnings.length, [file.name,data.warnings].join(": "));
    const span = /;LAYER_PAIR=(.+) - (.+)\n/.exec(content);
    assert.ok(span, "The Excellon output needs its actual layer pair");
    const backdrill = /;BACKDRILL=from (top|bottom); keep ([^;]+);/.exec(content);
    const back = backdrill?.[1] ?? "", laser = /;LASER=microvia/.test(content);
    const plated = /;TYPE=PLATED/.test(content);
    const first = back === "bottom" ? backdrill[2] : span[1];
    const last = back === "top" ? backdrill[2] : span[2];
    const key = JSON.stringify([matrixName(first),matrixName(last),back,laser,plated]);
    const old = groups.get(key) ?? {hits:[],slots:[]};
    old.hits.push(...data.hits);
    old.slots.push(...data.slots);
    groups.set(key,old);
  }
  return groups;
}

function drillsFromOdb(assembly, step) {
  const groups = new Map();
  for (const [name,layer] of assembly.matrix.layers) {
    if (!layer.start || !step.layers.has(name)) continue;
    const plot = step.layers.get(name);
    if (!plot.features.length) continue;
    assert.ok(plot.drill, "Missing tool inventory for " + name);
    const back = layer.subtype === "BACKDRILL" ? (plot.drillDirection === "bottom2top" ? "bottom" : "top") : "";
    for (const [kind, list] of Object.entries(plot.drill)) for (const feature of list) {
      const key = JSON.stringify([layer.start,layer.end,back,feature.subtype === "LASER",feature.plated]);
      if (!groups.has(key)) groups.set(key,{hits:[],slots:[]});
      groups.get(key)[kind].push(feature);
    }
  }
  return groups;
}

function nativeConnectivity(project, board, pcbStep) {
  const reference = G.AtriumNetlist.extract(project,{source:"pcb",board:board.id});
  // Compare pin identity and logical partitioning even when a native net label must
  // be encoded to a restricted ODB++ identifier. Check its CAD testpoint as well.
  const names = reference.nets.filter(net => net.nodes.length).map(net => sorted(net.nodes.map(node => [node.ref,node.pin])).join("|")).sort();
  const actual = new Map(), physical = new Set(pcbStep.electrical.points.map(p => [p.net,p.x.toFixed(5),p.y.toFixed(5)].join("|")));
  for (const component of [...pcbStep.components.T,...pcbStep.components.B]) for (const pin of component.pins.values()) {
    if (pin.net === "$NONE$") continue;
    const identity = [decodeURIComponent(component.ref),decodeURIComponent(pin.name)];
    assert.ok(physical.has([pin.net,pin.x.toFixed(5),pin.y.toFixed(5)].join("|")), "Missing CADNET test point " + JSON.stringify(identity));
    if (!actual.has(pin.net)) actual.set(pin.net,new Map());
    actual.get(pin.net).set(JSON.stringify(identity),identity);
  }
  assert.deepEqual([...actual.values()].map(net => sorted([...net.values()]).join("|")).sort(),names,
    "ODB++ connectivity differs from the native board");
  return {componentNets:names.length,cadPoints:physical.size};
}

function verify(project, board, extra = {}) {
  const model = F.analyse(project,board.id), layers = F.gerberLayers(model);
  const options = {date,origin:"absolute",drillOrigin:"shared",drillDrawing:false,drillReport:false,
    pnp:false,assemblyTop:false,assemblyBottom:false,readme:false,layers:Object.fromEntries(layers.map(l => [l.ext,true])),...extra};
  const plan = F.plan(model,options), started = performance.now();
  const built = G.AtriumODB.build(project,board.id,options), ms = performance.now() - started, result = R.read(built.bytes);
  if (process.env.WAFFLE_ODB_ARTIFACTS) {
    const folder = path.join(process.env.WAFFLE_ODB_ARTIFACTS,matrixName(board.name));
    fs.mkdirSync(folder,{recursive:true});
    fs.writeFileSync(path.join(folder,built.name),built.bytes);
    for (const file of plan.files) fs.writeFileSync(path.join(folder,file.name),F.generate(model,plan,file).content);
  }
  assert.ok(built.name.endsWith(".tgz"));
  assert.ok(result.entries.has("matrix/stackup.xml"), "Missing manufacturing stackup");
  const pcb = result.steps.get("pcb"), checked = new Set();
  for (const file of plan.files.filter(row => row.kind === "gerber")) {
    const {content} = F.generate(model,plan,file);
    const parsed = parseGerber(content), name = byRole[file.layer.key] ??
      (model.stack.includes(file.layer.key) ? "" : "document_") + matrixName(file.layer.key);
    assert.ok(pcb.layers.has(name) && !parsed.warnings.length, "Missing or unreadable geometry: " + name);
    // These features represent copper, paste, legend, or the mask openings.
    // ODB++ layer polarity is independent of the Gerber artwork polarity.
    assert.equal(result.matrix.layers.get(name).polarity,"POSITIVE",name + " ODB++ feature polarity");
    bitmapDiff(pcb.layers.get(name),parsed,board.name + " " + file.name);
    checked.add(name);
  }
  const gerberDrill = drillsFromExcellon(plan,model), odbDrill = drillsFromOdb(result,pcb);
  assert.deepEqual([...odbDrill.keys()].sort(),[...gerberDrill.keys()].sort(),"Plating, laser and entry/exit spans");
  for (const [group,expected] of gerberDrill) {
    const actual = odbDrill.get(group);
    const result = compareDrills(expected,actual,.001);
    assert.equal(result.missing.length + result.extra.length + result.wrong.length,0,group + " drill dimensions");
    assert.equal(actual.slots.length,expected.slots.length,group + " slot inventory");
    const plot = drill => {const shapes = holeShapes([drill]);return {shapes,bbox:bboxOf(shapes)};};
    bitmapDiff(plot(actual),plot(expected),group + " drill/rout");
  }
  const electrical = nativeConnectivity(project,board,pcb);
  const same = G.AtriumODB.build(project,board.id,options);
  assert.ok(toArray(same.bytes).equals(toArray(built.bytes)), "Identical input and creation date must be byte deterministic");
  const revisited = R.unpack(G.AtriumODB.build(project,board.id,{...options,date:new Date(+date+1000)}).bytes);
  const withoutTimestamps = items => [...items].map(([name,value]) => [name,name === "misc/info" ?
    value.replace(/^(CREATION_DATE|SAVE_DATE)=\d{8}\.\d{6}$/gm,"$1=TIME") : value]);
  assert.notEqual(revisited.entries.get("misc/info"),result.entries.get("misc/info"),"Writer must accept the explicit creation date");
  assert.deepEqual(withoutTimestamps(revisited.entries),withoutTimestamps(result.entries),"Creation date changed fabrication data");
  return {result,model,checked:checked.size,drillGroups:odbDrill.size,ms:+ms.toFixed(2),bytes:built.bytes.length,...electrical};
}

function synthetic() {
  const project = A.project("ODB verification",G.AtriumParts.catalogue), board = project.documents.find(doc => doc.kind === "pcb");
  board.outline = [[0,0],[18,0],[18,12],[0,12]];
  board.stackup = {version:1,layers:G.AtriumStackup.preset("4").layers};
  board.items.push(
    {id:"arc",kind:"track",layer:"Top",net:"ARC",width:.25,maskExpansion:.15,pasteExpansion:.05,
      points:[[5,4],[4,3]],arc:{kind:"arc",c:[4,4],r:1,start:0,end:90,ccw:true}},
    {id:"slot",kind:"pad",layer:"Multi",x:14,y:6,w:2,h:1,angle:27,shape:"rect",drill:.6,slotLength:1.1,plated:false},
    {id:"plated-slot",kind:"pad",layer:"Multi",x:14,y:4,w:2,h:1,angle:31,shape:"rect",drill:.55,slotLength:1.1,plated:true,net:"PLATED_SLOT"},
    {id:"through",kind:"via",layer:"Multi",x:6.5,y:8,diameter:.6,drill:.3,net:"ARC"},
    {id:"blind",kind:"via",layer:"Multi",x:7,y:9,diameter:.6,drill:.3,fromLayer:"Top",toLayer:"Inner 1",net:"BLIND"},
    {id:"buried",kind:"via",layer:"Multi",x:9,y:9,diameter:.6,drill:.3,fromLayer:"Inner 1",toLayer:"Inner 2",net:"BURIED"},
    {id:"laser",kind:"via",layer:"Multi",x:11,y:9,diameter:.27,drill:.12,fromLayer:"Top",toLayer:"Inner 1",microvia:true,net:"LASER"},
    {id:"bottom-blind",kind:"via",layer:"Multi",x:14,y:9,diameter:.6,drill:.3,fromLayer:"Inner 2",toLayer:"Bottom",net:"BLIND"},
    {id:"bottom-bd",kind:"via",layer:"Multi",x:6,y:3,diameter:.6,drill:.3,net:"BOTTOM_BD",backdrill:{from:"bottom",toLayer:"Inner 2",diameter:.42,stubMax:.14}},
    {id:"top-bd",kind:"via",layer:"Multi",x:8,y:3,diameter:.6,drill:.3,net:"TOP_BD",backdrill:{from:"top",toLayer:"Inner 1",diameter:.43,stubMax:.18}},
    {id:"top-bd-2",kind:"via",layer:"Multi",x:8,y:5,diameter:.6,drill:.3,net:"TOP_BD",backdrill:{from:"top",toLayer:"Inner 1",diameter:.43,stubMax:.11}},
    {id:"part",kind:"part",def:"std-r",ref:"R1",value:"1k",x:5,y:7,angle:31,layer:"Bottom",pinNets:{"1":"ARC","2":"OTHER"}},
    {id:"custom",kind:"pad",layer:"Top",x:10,y:4,w:1.2,h:.7,angle:27,shape:"roundrect",round:.2,net:"ARC"});
  return {project,board};
}

function routedFilms(project, board, model, pcb) {
  require(require("../support/app-source-paths.cjs").appFile("ipc2581.js"));
  const settings = {date, origin:"absolute"};
  const xml = G.AtriumIPC2581.build(project, board, {...settings, model}).content;
  for (const [layer, odbLayer, ipcLayer, width] of [
    ["Top", "top", "TOP", .25], ["Top mask", "solder_mask_top", "SOLDERMASK_TOP", .55],
    ["Top paste", "paste_top", "SOLDERPASTE_TOP", .35]
  ]) {
    const catalogue = F.gerberLayers(model).find(row => row.key === layer);
    const gerber = parseGerber(F.gerber(model, catalogue, F.settle(settings)).content);
    const draw = gerber.draws.find(row => row.arc && row.points[0][0] === 5);
    assert.ok(draw, layer + " preserves the routed arc in Gerber");
    assert.deepEqual([draw.points[0], draw.points.at(-1)], [[5,-4],[4,-3]], layer);
    assert.ok(Math.abs(draw.width - width) < 1e-9, layer + " Gerber width");
    const arc = pcb.layers.get(odbLayer).features.find(row => row.op === "A" && row.first[0] === 5);
    assert.ok(arc, layer + " preserves the routed arc in ODB++");
    assert.deepEqual([arc.first, arc.end], [[5,-4],[4,-3]], layer);
    assert.ok(Math.abs(arc.tool.round * 2 - width) < 1e-9, layer + " ODB++ width");
    const ipc = new RegExp('<LayerFeature layerRef="' + ipcLayer + '">([\\s\\S]*?)</LayerFeature>').exec(xml)?.[1];
    assert.match(ipc, /<Arc startX="5" startY="-4" endX="4" endY="-3" centerX="4" centerY="-4" clockwise="false"/);
  }
}

function nativeFilmNoop() {
  const {nativeCAD} = require("../support/native-cad.cjs");
  const project = nativeCAD("source-geometry"), board = project.documents.find(doc => doc.kind === "pcb");
  // Use the polygon outline because ODB++ rejects the fixture's independent nested profile island.
  delete board.boardShape;
  const nativeBytes = () => {
    let next = 0;
    return G.AtriumFormat2.serialize(G.AtriumFormat2Model.createDocument(board, {allocate: () => "film-noop-" + (++next)}));
  };
  const before = nativeBytes(), resolver = require("../../app/pcb/resolved-geometry.js");
  let views = 0;
  G.AtriumResolvedGeometry = {...resolver, read(...args) { views++; return resolver.read(...args); }};
  try {
    const model = F.analyse(project, board), settings = {date, origin:"absolute", model};
    const layer = F.gerberLayers(model).find(row => row.key === "Bottom");
    assert.equal(parseGerber(F.gerber(model, layer, F.settle(settings)).content).arcDrawCount, 0,
      "a legacy Boolean arc annotation is plotted with its authored chords");
    G.AtriumODB.build(project, board, settings);
    G.AtriumIPC2581.build(project, board, settings);
    assert.equal(views, 1, "Gerber, ODB++ and IPC-2581 reuse the manufacturing snapshot");
    assert.deepEqual(nativeBytes(), before, "plotting preserves the native serialized board");
  } finally { G.AtriumResolvedGeometry = resolver; }
}

function signedFilms() {
  const project = A.project("Signed film"), board = project.documents.find(doc => doc.kind === "pcb");
  const face = (id, x0, y0, x1, y1, polarity) => ({id, kind:"graphic", layer:"Top", fill:true, polarity,
    points:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]});
  board.outline = [[0,0],[25,0],[25,15],[0,15]];
  board.items.push(face("sheet", 3, 3, 22, 12), face("knockout", 17, 6, 21, 10, "clear"), face("island", 19, 7, 20, 9),
    {id:"bore", kind:"pad", layer:"Multi", x:16.5, y:8.5, w:1, h:1, drill:1, plated:false});
  const model = F.analyse(project, board), settings = {date, origin:"absolute", model};
  const layer = F.gerberLayers(model).find(row => row.key === "Top");
  const gerber = parseGerber(F.gerber(model, layer, F.settle(settings)).content);
  const odb = R.read(G.AtriumODB.build(project, board, settings).bytes).steps.get("pcb");
  for (const {shapes} of [gerber, odb.layers.get("top")]) {
    const lit = (x, y) => rasterize(shapes, {x0:x-.05, y0:-y-.05, w:1, h:1, s:.1})[0];
    assert.deepEqual([lit(16.5,8.5), lit(18.5,8.5), lit(19.5,8.5)], [1,0,1], "authored clear removes copper until a later feature adds it again");
  }
  const ipc = G.AtriumIPC2581.build(project, board, settings).content;
  const layerXml = /<LayerFeature layerRef="TOP">([\s\S]*?)<\/LayerFeature>/.exec(ipc)[1];
  const sets = [...layerXml.matchAll(/<Set([^>]*)>\s*([\s\S]*?)<\/Set>/g)].map(([,attrs, body]) =>
    [attrs.includes('polarity="NEGATIVE"'), /<PolyBegin x="(\d+)"/.exec(body)?.[1]]);
  assert.deepEqual(sets, [[false,"3"],[true,"17"],[false,"19"]], "IPC sets retain authored add/clear/add order");
  const plan = F.plan(model, settings), drill = F.generate(model, plan, plan.files.find(file => file.kind === "drill"));
  const at = ({x,y}) => x === 16.5 && y === -8.5;
  assert.ok(parseExcellon(drill.content).hits.some(at), "Excellon carries the separate bore through positive film");
  assert.ok([...odb.layers.values()].some(layer => layer.drill?.hits.some(at)), "ODB++ carries the separate bore through positive film");
  assert.match(ipc, /<Hole name="H1" diameter="1" platingStatus="NONPLATED"[^>]* x="16.5" y="-8.5"/);
}

function analyticFilms(outlineOrder, positiveOutline = false) {
  const S = G.AtriumBoardShape, project = A.project("Placed circular artwork"), board = project.documents.find(doc => doc.kind === "pcb");
  board.outline = [[0,0],[30,0],[30,20],[0,20]];
  const region = (id, shape, polarity) => {
    const points = S.flattenContour(shape.contour);
    return {id,kind:"graphic",layer:"Top",fill:true,closed:true,points,polarity,regionShape:{...shape,sig:S.signature(points)}};
  };
  const disk = {version:1,contour:[S.arc([22,10],3,0,180,true),S.line([19,10],[25,10])],
    cutouts:[[S.arc([22,9],.5,0,-180,false),S.arc([22,9],.5,-180,-360,false)]]};
  if (outlineOrder === "line-first") disk.contour.reverse();
  const restored = S.circle(positiveOutline ? .6 : .3,[24,9]);
  if (positiveOutline) restored.cutouts = [[S.arc([24,9],.1,0,0,false)]];
  board.items.push(region("sheet",S.fromPolygon([[17,5],[28,5],[28,15],[17,15]])),region("clear",disk,"clear"),
    region("restore",restored));
  if (outlineOrder) Object.assign(board.items[1],{width:.6,strokeOutline:true});
  if (positiveOutline) Object.assign(board.items[2],{width:.2,strokeOutline:true});
  const arc = {kind:"arc",c:[1,4],r:1,start:0,end:90,ccw:true};
  project.library.push({id:"placed",name:"Placed artwork",footprint:{pads:[],shapes:[
    {kind:"circle",layer:"Bottom",x:1,y:1,r:1,fill:true,width:.4},
    {kind:"circle",layer:"Bottom",x:4,y:1,r:.8,width:.2},
    {kind:"path",layer:"Bottom",arc,points:[[2,4],[1,3]],r:9,width:.15}
  ]}});
  board.items.push({id:"part",kind:"part",def:"placed",ref:"A1",value:"",layer:"Bottom",x:20,y:11,angle:90,mirror:true},
    {id:"two-point-fill",kind:"graphic",layer:"Bottom",fill:true,width:.2,points:[[10,7],[7,4]],
      arc:{kind:"arc",c:[7,7],r:3,start:0,end:90,ccw:true}},
    {id:"half-tick",kind:"graphic",layer:"Bottom",width:.2,points:[[4,1.0000005],[5,.0000005]],
      arc:{kind:"arc",c:[4,.0000005],r:1,start:270,end:0,ccw:true}});
  const saved = A.validate(A.clone(project)).documents.find(doc => doc.id === board.id).items.find(item => item.id === "two-point-fill");
  assert.ok(saved.fill && A.pathArc(saved),"two-point filled graphic with arc metadata survives project validation");
  const model = F.analyse(project,board), options = {date,origin:"absolute",model};
  const artwork = name => {
    const layer = F.gerberLayers(model).find(row => row.key === name);
    return F.gerber(model,layer,F.settle(options)).content;
  };
  const bottomGerber = artwork("Bottom");
  const top = parseGerber(artwork("Top")), bottom = parseGerber(bottomGerber), odb = R.read(G.AtriumODB.build(project,board,options).bytes);
  const step = odb.steps.get("pcb"), topODB = step.layers.get("top"), bottomODB = step.layers.get("bottom");
  const sample = (shapes, points) => points.map(([x,y]) => rasterize(shapes,{x0:x-.025,y0:-y-.025,w:1,h:1,s:.05})[0]);
  for (const {shapes} of [top,topODB])
    assert.deepEqual(sample(shapes,[[18,9],[20,9],[22,9],[24,9],[24.6,9],[23,10.2],[23,10.4],[24.35,9],[24.45,9]]),
      [1,0,1,positiveOutline ? 0 : 1,0,outlineOrder ? 0 : 1,1,positiveOutline ? 1 : 0,0],
      "curved clear preserves its hole, restored copper and every authored outline edge");
  for (const {shapes} of [bottom,bottomODB])
    assert.deepEqual(sample(shapes,[[19,10],[19,8.85],[19,7],[19.8,7],[16.707,9.293],[17,11],[8.5,5.5],[9.121,4.879]]),
      [1,1,0,1,1,0,1,0],"rotated mirrored disk, ring and quarter arc with the straight two-point fill fallback");
  assert.ok(top.arcRegionCount >= 3 && top.warnings.length === 0,"Gerber retains circular signed boundaries");
  assert.equal(top.arcDrawCount, (outlineOrder ? 1 : 0) + (positiveOutline ? 2 : 0),"curved outlines stay analytic");
  assert.equal(topODB.features.some(f => f.op === "A" && !f.dark),Boolean(outlineOrder));
  assert.equal(topODB.features.filter(f => f.op === "A" && f.dark).length,positiveOutline ? 2 : 0);
  assert.deepEqual([bottom.flashCount,bottom.arcDrawCount,bottom.warnings.length],[1,3,0],"Gerber retains a circular flash and three native circular strokes");
  assert.match(bottomGerber, /G03X5000000Y0I0J\d+D01\*/, "authored zero-degree endpoint keeps its native Gerber half-tick");
  assert.ok(bottomODB.features.some(f => f.op === "A" && f.first[0] === 16 && f.first[1] === -9 && f.end[0] === 17 && f.end[1] === -10));
  assert.ok(bottomODB.features.some(f => f.op === "A" && f.first[0] === 4 && f.end[0] === 5 && f.end[1] === 0));
  assert.match(odb.entries.get("steps/pcb/layers/top/features"), /\nOC /,"ODB encodes native region arcs");
  const ipc = G.AtriumIPC2581.build(project,board,options).content;
  const layer = name => new RegExp('<LayerFeature layerRef="'+name+'">([\\s\\S]*?)</LayerFeature>').exec(ipc)[1];
  assert.match(layer("TOP"), /polarity="NEGATIVE"[\s\S]*?<PolyStepCurve[\s\S]*?<Cutout>[\s\S]*?<PolyStepCurve/);
  if (outlineOrder) {
    assert.match(layer("TOP"), /polarity="NEGATIVE"[\s\S]*?<Line startX="19" startY="-10" endX="25" endY="-10"/);
    assert.match(layer("TOP"), /polarity="NEGATIVE"[\s\S]*?<Arc [^>]*centerX="22" centerY="-10"/);
  }
  if (positiveOutline) assert.match(layer("TOP"), /<Arc [^>]*centerX="24" centerY="-9"/);
  assert.match(layer("BOTTOM"), /<Arc startX="16" startY="-9" endX="17" endY="-10" centerX="16" centerY="-10" clockwise="true"/);
  assert.match(layer("BOTTOM"), /<Arc startX="4"[^>]* endX="5" endY="0"/);
  const view = G.AtriumResolvedGeometry.read({kind:"snapshot",project,root:board,
    revision:{kind:"snapshot",projectId:project.id,rootId:board.id,generation:"placed-artwork"}});
  const {features} = view.owner({kind:"item",id:"part",documentId:board.id,instancePath:[]});
  const placedArc = features.find(f => f.key.member[1] === "2").ink.centerline[0];
  assert.deepEqual(placedArc,{kind:"arc",center:[16,10],radius:1,start:90,sweep:-90},"resolved footprint uses the exact placed film arc");
}

function signedFootprints() {
  const S = G.AtriumBoardShape, project = A.project("Signed footprint"), board = project.documents.find(doc => doc.kind === "pcb");
  board.outline = [[0,0],[34,0],[34,20],[0,20]];
  const box = (x0,y0,x1,y1) => ({kind:"path",fill:true,closed:true,points:[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]});
  const disk = S.circle(3,[0,0]), points = S.flattenContour(disk.contour);
  disk.cutouts = [[S.arc([0,0],.35,0,0,false)]];
  const shapes = [box(-4,-3,4,3),
    {kind:"path",fill:true,closed:true,points,polarity:"clear",regionShape:{...disk,sig:S.signature(points)}},
    {kind:"circle",fill:true,x:2.8,y:1.8,r:.45,polarity:"clear"},
    {kind:"path",width:.2,points:[[2,0],[0,-2]],arc:{kind:"arc",c:[0,0],r:2,start:0,end:90,ccw:true},
      polarity:"clear",net:"NON_CONDUCTIVE",maskExpansion:.08,pasteExpansion:.08},
    box(.85,-.175,1.15,.175)];
  project.library.push({id:"cut",name:"Signed aperture",footprint:{shapes,pads:[]}});
  board.items.push({kind:"part",id:"upper",ref:"A1",value:"",def:"cut",layer:"Top",x:10,y:10},
    {kind:"part",id:"lower",ref:"A2",value:"",def:"cut",layer:"Bottom",x:25,y:10,angle:90,mirror:true},
    {...box(23.7,9.7,24.1,10.3),kind:"graphic",id:"restore",layer:"Bottom"});
  assert.equal(A.validate(A.clone(project)).library[0].footprint.shapes[3].polarity,"clear","the authored source polarity survives project validation");
  const attribution = [];
  const model = F.analyse(project,board,{featureSource:(f,owner,member,layer) => {
    if (layer === "Top" || layer === "Bottom")
      attribution.push([owner.id,layer,shapes.indexOf(member),f.polarity === "clear",f.net ?? null]);
  }});
  const options = {model,date,origin:"absolute"};
  const gerber = name => {
    const layer = F.gerberLayers(model).find(row => row.key === name);
    return parseGerber(F.gerber(model,layer,F.settle(options)).content);
  };
  const odb = R.read(G.AtriumODB.build(project,board,options).bytes).steps.get("pcb");
  const sample = ({shapes}, points) => points.map(([x,y]) => rasterize(shapes,{x0:x-.025,y0:-y-.025,w:1,h:1,s:.05})[0]);
  const local = [[3,0],[0,1.1],[0,0],[1,0],[1.3,0],[2.8,1.8],[Math.SQRT2,-Math.SQRT2]];
  for (const [face,projectPoint,expected] of [
    ["Top",([x,y]) => [10+x,10+y],[1,0,1,1,0,0,0]],
    ["Bottom",([x,y]) => [25-y,10-x],[1,1,1,1,0,0,0]]
  ]) {
    for (const film of [gerber(face),odb.layers.get(face.toLowerCase())])
      assert.deepEqual(sample(film,local.map(projectPoint)),expected,"signed footprint preserves mask-out order, holes and later restore on " + face);
    assert.equal(gerber(face).arcDrawCount,1,"the negative quarter is a native draw");
    assert.equal(odb.layers.get(face.toLowerCase()).features.filter(f => f.op === "A" && !f.dark).length,1);
  }
  assert.deepEqual(attribution,[
    ...["upper","lower"].flatMap((owner,index) => [false,true,true,true,false].map((clear,member) =>
      [owner,index === 0 ? "Top" : "Bottom",member,clear,null])),
    ["restore","Bottom",-1,false,null]
  ],"output source attribution retains shape order, owner and resolved face without a conductive clear net");
  for (const name of ["Top mask","Top paste"])
    assert.deepEqual(sample(gerber(name),[[10+Math.SQRT2,10-Math.SQRT2]]),[1],"derived openings keep their native positive default");
  const xml = G.AtriumIPC2581.build(project,board,options).content;
  for (const [name,expected] of [["TOP",[false,true,true,true,false]],["BOTTOM",[false,true,true,true,false,false]]]) {
    const layer = new RegExp('<LayerFeature layerRef="'+name+'">([\\s\\S]*?)</LayerFeature>').exec(xml)[1];
    assert.deepEqual([...layer.matchAll(/<Set([^>]*)>/g)].map(([,attrs]) => attrs.includes('polarity="NEGATIVE"')),expected);
    assert.match(layer,/polarity="NEGATIVE"[\s\S]*?<Arc /);
  }
}

function polygonalFilms() {
  const project = A.project("Polygonal film"), board = project.documents.find(doc => doc.kind === "pcb");
  const graphic = (id, points, extra) => ({id, kind:"graphic", layer:"Top", points, ...extra});
  board.outline = [[0,0],[20,0],[20,10],[0,10]];
  board.items.push(
    graphic("outlined",[[3,2],[6,2],[6,5],[3,5]],{fill:true,strokeOutline:true,width:.22}),
    graphic("default-pen",[[8,2],[10,2]],{width:0}),
    graphic("omitted",[[12,2],[14,2]],{layer:"Mechanical 1",width:.22})
  );
  const native = JSON.stringify(project), settings = {date, origin:"absolute"};
  const {files, warnings} = F.build(project, board, settings);
  assert.ok(warnings.some(note => note.includes("Zero-width lines were plotted at the default width")));
  const film = parseGerber(files.find(file => file.name.endsWith(".GTL")).content);
  const odb = R.read(G.AtriumODB.build(project,board,settings).bytes).steps.get("pcb").layers.get("top");
  for (const {shapes} of [film, odb]) {
    const lit = (x,y) => rasterize(shapes,{x0:x-.005,y0:-y-.005,w:1,h:1,s:.01})[0];
    assert.deepEqual([lit(2.92,3),lit(2.86,3),lit(4,3),lit(9,2.08),lit(13,2)], [1,0,1,1,0]);
  }
  assert.equal(JSON.stringify(project),native);
}

function panelCheck() {
  const {project,board} = synthetic(), P = G.AtriumPanel;
  // Use one rotated instance and one unrotated instance, with panel-local rails
  // and their independent fiducials and unplated tooling holes.
  const panel = P.create(project,{board:board.id,rows:1,cols:2,cells:{"0,1":{rotation:90}}});
  project.documents.push(panel);
  const V = G.AtriumVariants, fitted = V.create(project,{name:"Production"}), unpopulated = V.create(project,{name:"Diagnostics"});
  V.setParts(project,unpopulated.id,[V.keyOf(board.items.find(row => row.kind === "part"))],{fitted:false});
  V.setActive(project,fitted.id);
  const options = {date,origin:"absolute",drillOrigin:"shared",panelId:panel.id};
  const archive = G.AtriumODB.build(project,board.id,options), product = R.read(archive.bytes);
  const result = product.steps.get("panel"), single = product.steps.get("pcb");
  assert.deepEqual(result.repeat.map(row => [row.child,row.angle]),[["pcb",0],["pcb",90]]);
  assert.ok(result.profile.features[0].contours.length > 1,"Routed channels must remain profile cutouts");
  assert.ok(single.components.B.length > 0 && !result.components?.B?.length,"Component placement belongs to the reusable board step");
  const boms = [...product.entries].filter(([name]) => /^steps\/pcb\/boms\/.+\/bom$/.test(name));
  assert.equal(boms.length,2);
  assert.equal(boms.filter(([,text]) => /^REF R1$/m.test(text)).length,1,"The right variant omitted the unfitted component");
  assert.match(product.entries.get("steps/pcb/layers/comp_+_bot/components"),/\.comp_variant_list/);
  const gerbers = P.build(project,panel,{...options,drillDrawing:false,drillReport:false});
  for (const [ext, name] of [["GTL","top"],["GBL","bottom"],["GTS","solder_mask_top"],["GM1","profile_rout"]]) {
    const expected = gerbers.files.find(file => file.name.endsWith("." + ext));
    assert.ok(expected,"Missing reference panel film " + ext);
    bitmapDiff(R.panelLayer(product,name),parseGerber(expected.content),"Panel " + ext);
  }
  const nonPlated = gerbers.files.filter(file => /-NonPlated.*\.TXT$/.test(file.name)).map(file => parseExcellon(file.content));
  const nonPlatedLayers = [...product.matrix.layers.values()].filter(layer => {
    const holes = [result,single].flatMap(step => {
      const drill = step.layers.get(layer.name)?.drill;
      return drill ? [...drill.hits,...drill.slots] : [];
    });
    return layer.subtype !== "BACKDRILL" && holes.length && holes.every(hole => !hole.plated);
  });
  const shapes = nonPlatedLayers.flatMap(layer => R.panelLayer(product,layer.name).shapes), expected = holeShapes(nonPlated);
  bitmapDiff({shapes,bbox:bboxOf(shapes)},{shapes:expected,bbox:bboxOf(expected)},"Panel non-plated tooling and slots");
  console.log("Panel STEP-REPEAT, mixed rotation, rails/cutouts, unplated tooling and four artwork films verified");
}

function matrixCheck(product) {
  const {layers,uid} = product.matrix, step = product.steps.get("pcb");
  for (const [film,copper] of [["solder_mask_top","top"],["solder_mask_bottom","bottom"]]) {
    const mask = layers.get(film);
    assert.equal(mask.type,"SOLDER_MASK");
    assert.equal(mask.polarity,"POSITIVE");
    assert.equal(uid.get(mask.reference).name,copper);
    assert.ok(step.layers.get(film).features.length,"Uncovered pads must be emitted as mask clearances");
  }
  const backdrills = [...layers.values()].filter(layer => layer.subtype === "BACKDRILL");
  const actual = backdrills.map(row => {
    const plot = step.layers.get(row.name);
    return [row.start,row.end,plot.drillDirection,plot.stop,plot.drill.hits.map(hit => +hit.stub.toFixed(6)).sort()];
  }).sort();
  assert.deepEqual(actual,[
    ["inner_2","bottom","bottom2top","inner_2",[.14]],
    ["top","inner_1","top2bottom","inner_1",[.11,.18]]
  ]);
  assert.ok([...layers.values()].some(row => row.type === "DRILL" && !row.subtype && row.start === "inner_2" &&
    row.end === "bottom" && step.layers.get(row.name).drillDirection === "bottom2top"));
  const route = [...layers.values()].find(row => row.type === "ROUT" &&
    step.layers.get(row.name).drill?.slots.some(slot => slot.plated));
  assert.equal(step.layers.get(route.name).features[0].attributes[".rout_plated"],true);
  const dielectric = [...layers.values()].filter(layer => layer.type === "DIELECTRIC");
  assert.equal(dielectric.length,3);
  assert.equal(step.attributes.get(dielectric[0].name).get(".dielectric_constant"),"4.2");
  assert.equal(product.stack.layers.get(dielectric[0].name).thickness,.2);
}

function flexAndMixedStacks() {
  const {project,board}=synthetic(), O=G.AtriumODB, S=G.AtriumStackup;
  const other = JSON.parse(JSON.stringify(board));
  other.id="different-odb-board";
  other.name="Thicker dielectric";
  other.stackup.layers.find(layer => layer.type==="Dielectric").thickness = .36;
  project.documents.push(other);
  const panel = G.AtriumPanel.create(project,{board:board.id,rows:1,cols:2,cells:{"0,1":{board:other.id}}});
  project.documents.push(panel);
  assert.throws(() => O.build(project,board.id,{date,panelId:panel.id}), /Thicker dielectric have different physical stacks at layer/);
  other.stackup.layers.find(layer => layer.type==="Dielectric").thickness = .2;
  const panelModel = G.AtriumPanel.analyse(project,panel.id,{date,odbRepeat:true});
  assert.equal(panelModel.physicalStack,panelModel.odbBoards.get(board.id).physicalStack,"Panel foils use their base board's stack");
  assert.notEqual(panelModel.physicalStack,panelModel.odbBoards.get(other.id).physicalStack,"Each board resolves its own physical stack");
  const compatible = R.read(O.build(project,board.id,{date,panelId:panel.id}).bytes);
  assert.ok(compatible.steps.has("pcb_2"),"Distinct compatible boards share one panel stack");
  assert.notEqual(compatible.steps.get("pcb").layers.get("top").id,compatible.steps.get("pcb_2").layers.get("top").id);
  const savedStack=board.stackup;
  delete board.stackup;
  delete other.stackup;
  const derivedPanel=G.AtriumPanel.analyse(project,panel.id,{date,odbRepeat:true});
  assert.ok([...derivedPanel.odbBoards.values()].every(model=>model.physicalStack.derived));
  assert.notEqual(derivedPanel.odbBoards.get(board.id).physicalStack,derivedPanel.odbBoards.get(other.id).physicalStack);
  board.stackup=savedStack;

  const flex = S.flexLayers(["Top","Bottom"],S.stored(board).layers);
  board.stackup.substacks = [{id:"tail",name:"Tail",flex:true,layers:flex}];
  board.stackup.regions = [
    {id:"rigid",name:"Body",stack:"main",points:[[0,0],[9,0],[9,12],[0,12]]},
    {id:"flex",name:"Tail",stack:"tail",points:[[9,0],[18,0],[18,12],[9,12]]}
  ];
  assert.throws(() => O.build(project,board.id,{date}), /stack regions, substacks or bends/);

  board.stackup = {version:1,main:{name:"Flex",flex:true},layers:flex};
  board.items = [
    {id:"t",kind:"pad",layer:"Top",x:4,y:3,w:1,h:.6,shape:"rect",net:"T"},
    {id:"b",kind:"pad",layer:"Bottom",x:5,y:7,w:1,h:.6,shape:"rect",net:"B"}
  ];
  const result = R.read(O.build(project,board.id,{date,origin:"absolute"}).bytes);
  assert.equal(result.stack.total,.195,"The polyimide, adhesive, coverlay and copper thicknesses all contribute");
  assert.equal(result.matrix.layers.get("top").subtype,"SIGNAL_FLEX");
  assert.equal(result.matrix.layers.get("bottom").subtype,"SIGNAL_FLEX");
  assert.ok([...result.matrix.layers.values()].filter(layer=>layer.type==="DIELECTRIC").every(layer=>layer.form==="FLEX"));
  for (const [side,opening] of [["top",[3.4,-3.4,4.6,-2.6]],["bottom",[4.4,-7.4,5.6,-6.6]]]) {
    const name = "coverlay_"+side, layer = result.matrix.layers.get(name), plot = result.steps.get("pcb").layers.get(name);
    assert.equal(layer.type,"SOLDER_MASK");
    assert.equal(layer.subtype,"COVERLAY");
    assert.equal(layer.polarity,"POSITIVE");
    assert.equal(plot.features.length,1,"Only the pad opening belongs in the coverlay film");
    assert.deepEqual(plot.bbox,opening);
    assert.equal(result.stack.layers.get(name).thickness,.0125);
    assert.ok(!result.matrix.layers.has("solder_mask_"+side),"No solder resist row in this stack");
  }
  assert.deepEqual(result.steps.get("pcb").electrical.points.map(row=>[row.net,row.exposed]).sort(),[["B","e"],["T","e"]]);
  console.log("ODB++ matrix stack, backdrill spans, plated routs, uniform coverlay and mixed-stack refusal verified");
}

function manufacturingReuse() {
  require("../../app/formats/output-jobs.js");
  const {project,board}=synthetic(), settings={date,odbEnabled:true}, J=G.AtriumOutputJobs;
  const gerber={kind:"gerber",options:{drill:false,readme:false}};
  const odb={kind:"odb",options:{}};
  const calls=[];
  G.AtriumFabOutputs={...F,analyse(project,board,options) {
    const model=F.analyse(project,board,options);
    calls.push(model);
    return model;
  }};
  function run(gerberOptions,odbOptions,context=settings) {
    calls.length=0;
    const job={name:"Combined fabrication",board:board.id,outputs:[
      {...gerber,options:{...gerber.options,...gerberOptions}},{...odb,options:odbOptions}
    ]};
    const result=J.run(project,job,context);
    assert.ok(result.report.ok,result.report.outputs.map(row=>row.message).join(" "));
  }
  try {
    for (const mode of [false,true]) {
      run({omitUnconnectedMidLayerPads:mode},{omitUnconnectedMidLayerPads:mode});
      assert.equal(calls.length,1,"Matching native fabrication outputs share one model");
      assert.equal(calls[0].physicalStack.layers.filter(G.AtriumStackup.isCopper).length,4);
      assert.ok(F.gerberLayers(calls[0]).some(layer=>layer.fileFunction==="Copper,L2,Inr,Plane"));
    }
    run({omitUnconnectedMidLayerPads:true},{omitUnconnectedMidLayerPads:false});
    assert.equal(calls.length,2,"Different isolated-land settings need separate models");
    run({},{},{...settings,provenance:{}});
    assert.equal(calls.length,2,"The retained-source ODB path owns its analysis");
    const variant=G.AtriumVariants.create(project,{name:"Different assembly"});
    const part=board.items.find(row=>row.kind==="part"), V=G.AtriumVariants;
    V.setParts(project,variant.id,[V.keyOf(part)],{fitted:false});
    run({variant:variant.id},{variant:variant.id});
    assert.equal(calls.length,1,"Matching variants may share the model");
    assert.equal(calls[0].dnp.size,1);
    run({variant:variant.id},{variant:""});
    assert.equal(calls.length,2,"Assembly variants use separate models");
    assert.equal(calls[1].dnp.size,0);

    delete board.stackup;
    run({},{});
    assert.equal(calls.length,1);
    assert.equal(calls[0].physicalStack.derived,true);
    const outer=F.gerberLayers(calls[0]).find(layer=>layer.ext==="GTL");
    assert.equal(outer.fileFunction,"Copper,L1,Top","Derived stacks omit the optional copper type in Gerber");
  } finally {
    G.AtriumFabOutputs=F;
  }
}

function negativeReader() {
  assert.throws(() => R.profileOrFeatures("F 0\n"), /UNITS/);
  assert.throws(() => R.profileOrFeatures("UNITS=MM\nF 1\nP 0 0 5 P 0 0\n"), /Missing symbol index/);
  assert.throws(() => R.profileOrFeatures("UNITS=MM\n$0 r500\nA 1 0 0 1 0 0 0 P 0 X"), /Invalid arc direction/);
  assert.throws(() => R.profileOrFeatures("UNITS=MM\nF 1\nS P 0\nOB 0 0 I\nOS 2 0\nOS 2 2\nOE\nSE"), /Unclosed feature polygon/);
  assert.throws(() => R.profileOrFeatures("UNITS=MM\nF 2\n$0 r300\nP 0 0 0 P 0 0"), /feature count/);
  const actual = R.profileOrFeatures("UNITS=MM\n$0 r500\nA 1 0 0 1 0 0 0 P 0 N");
  const known = parseGerber("%FSLAX46Y46*%\n%MOMM*%\n%ADD10C,0.5*%\nD10*\nG75*\nX1000000Y0D02*\nG03X0Y1000000I-1000000J0D01*\nM02*");
  bitmapDiff(actual,known,"ODB++ CCW true arc against independent Gerber input");
  const opposite = R.profileOrFeatures("UNITS=MM\n$0 r500\nA 1 0 0 1 0 0 0 P 0 Y");
  assert.ok(R.layerXor(opposite,known).differ > 100,"Changing true arc direction escapes the oracle");
}

function archiveStreaming() {
  const vm = require("node:vm"), {createHash} = require("node:crypto");
  const readApp = name => fs.readFileSync(require("../support/app-source-paths.cjs").appFile(name+".js"),"utf8");
  const zip = readApp("zip"), source = readApp("odb");
  const isolatedArchive = TextEncoder => {
    const sandbox = vm.createContext({TextEncoder,AtriumZipDeflate:G.AtriumZipDeflate});
    vm.runInContext(zip,sandbox);
    vm.runInContext(source.replace("Object.freeze({build})","Object.freeze({build,tgz})"),sandbox);
    return sandbox;
  };
  // Split an astral character across an encoding-window boundary and another
  // across a 1 MiB deflate boundary. Include both kinds of lone surrogate.
  const prefix = "0".repeat(65535)+"🚀\0é中\ud800";
  const aligned = 1024*1024-1024-2-Buffer.byteLength(prefix);
  const data = prefix+"x".repeat(aligned)+"🌐\udc00";
  const longPath = "z/"+"a".repeat(95);
  const files = new Map([[longPath,"µ tall text\n"],["empty",""],["empty-folder",null],["a",data]]);
  const normal = isolatedArchive(TextEncoder);
  const bytes = normal.AtriumODB.tgz("archive",files);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),
    "8fff4a101189cfe76a3e6a261970bb560e17efbab9a245ecf51518bb2ec5e67f","gzip bytes from the buffered 0a34b69c writer");
  const {entries} = R.unpack(bytes);
  assert.deepEqual([...entries],[["a",Buffer.from(data).toString("utf8")],["empty",""],[longPath,"µ tall text\n"]]);
  class EncodeOnly {
    encode(text) {return new TextEncoder().encode(text);}
  }
  for (const Encoder of [undefined,EncodeOnly]) {
    const fallback = isolatedArchive(Encoder).AtriumODB.tgz("archive",files);
    assert.ok(toArray(fallback).equals(toArray(bytes)),"The UTF-8 fallback must produce identical archive bytes");
  }
  assert.throws(() => normal.AtriumODB.tgz("archive",new Map([["x".repeat(101),""]])),/archive member name is too long/);
  const block = "x".repeat(1024*1024), oversized = new Map(Array.from({length:192},(_,i)=>["member-"+i,block]));
  normal.AtriumZipDeflate = class {
    constructor() {throw Error("The size guard must run before allocating the compressor.");}
  };
  assert.throws(() => normal.AtriumODB.tgz("archive",oversized),/exceeds the archive byte limit/);
}

function fontCheck(product) {
  const {metrics,glyphs} = product.font;
  assert.deepEqual(metrics,[.4,.9,.2]);
  assert.equal(glyphs.size,94);
  assert.deepEqual(glyphs.get("\\")[0],{start:[0,.8],end:[.4,.2],polarity:"P",ends:"R",width:.03});
  assert.ok(glyphs.get("A").some(stroke=>stroke.end[0]===.2 && stroke.end[1]===.8));
  assert.ok(glyphs.get("g").some(stroke=>stroke.end[1]===0),"A lowercase descender reaches the font origin");
  for (const character of ["!","\"","#",";","_","~"]) assert.ok(glyphs.get(character).length,character);
  const source = product.entries.get("fonts/standard");
  assert.equal(G.AtriumZip.crc32(G.AtriumZip.utf8(source)),0x2af003b2,"The complete ODB++ font keeps its established bytes");
  assert.throws(() => R.standardFont(source.replace(/CHAR ~\n[\s\S]+$/,"")),/all 94/);
  assert.throws(() => R.standardFont(source.replace(" P R "," P X ")),/Invalid font line/);
  assert.throws(() => R.standardFont(source.trimEnd().replace(/\nECHAR$/,"")),/Invalid font line/);
}

function ipc356(project, board, source, pcbSource) {
  const result = R.read(G.AtriumODB.build(project,board.id,{date,origin:"absolute"}).bytes), step = result.steps.get("pcb");
  const unit = /^P\s+UNITS CUST ([01])$/m.exec(source)?.[1];
  assert.equal(unit,"0","The pinned external netlist uses 0.0001-inch coordinate increments");
  assert.ok(/^999$/m.test(source),"The external IPC-D-356 payload is complete");
  const [ox,oy] = [40.9,173.1]; // aux_axis_origin in the independently published PCB fixture.
  const records = source.split(/\r?\n/).filter(row => /^(317|327|367)/.test(row)).map(row => {
    const coord = /X([+-]\d{6})Y([+-]\d{6})/.exec(row);
    assert.ok(coord,"IPC-D-356 missing a fixed-width coordinate pair");
    const tool = /D(\d{4})([PU])/.exec(row.slice(31,41));
    return {net:row.slice(3,17).trim(),ref:row.slice(20,26).trim(),pin:row.slice(27,31).trim(),
      x:ox + Number(coord[1]) * .00254,y:-oy + Number(coord[2]) * .00254,
      tool:tool && {diameter:Number(tool[1]) * .00254,plated:tool[2] === "P"}};
  });
  assert.ok(records.length > 1000,"The exported reference must contain real fabrication test points");
  const actual = new Map();
  for (const part of [...step.components.T,...step.components.B]) for (const pin of part.pins.values()) {
    const key = decodeURIComponent(part.ref)+"/"+decodeURIComponent(pin.name);
    if (!actual.has(key)) actual.set(key,[]);
    actual.get(key).push(pin);
  }
  const noConnect = new Set(Array.from(pcbSource.matchAll(/\(net \d+ "unconnected-\(([^-]+)-[^"]*-Pad([^)"\s]+)\)"\)/g),
    ([_,ref,pin]) => ref+"/"+pin));
  const names = new Map(), inverse = new Map(), vias = [];
  let checks = 0, unassigned = 0, unassignedCad = 0, mechanical = 0, maxError = 0;
  const drilled = [...step.layers.values()].flatMap(layer => layer.drill?.hits ?? []);
  const error = (a,b) => Math.hypot(a.x-b.x,a.y-b.y);
  for (const test of records) {
    if (test.ref === "VIA") { vias.push(test); continue; }
    if (!test.ref || !test.pin) {
      assert.ok(test.net === "N/C" && test.tool && drilled.some(row => error(row,test) < .0037 &&
        row.plated === test.tool.plated && Math.abs(row.d-test.tool.diameter) < .002),
      "Unnumbered IPC-D-356 drill was not preserved: " + JSON.stringify(test));
      mechanical++;
      continue;
    }
    const key = test.ref+"/"+test.pin, hits = actual.get(key) ?? [];
    const point = hits.find(row => error(row,test) < .0037);
    assert.ok(point, "IPC-D-356 endpoint missing from ODB++: " + JSON.stringify({test,hits}));
    maxError = Math.max(maxError,error(point,test));
    if (test.net === "N/C" || noConnect.has(key)) {
      assert.equal(point.net,"$NONE$","Unconnected source contact acquired a real net: " + key);
      if (!test.tool || test.tool.plated) {
        const contact = step.electrical.points.find(row => row.net === "$NONE$" && error(row,test) < .0037 &&
          !row.flags.includes("v") && (!test.tool || Math.abs(row.r * 2 - test.tool.diameter) < .002));
        assert.ok(contact,"Unassigned IPC-D-356 contact missing from CADNET: " + JSON.stringify(test));
        unassignedCad++;
      }
      unassigned++;
      continue;
    }
    assert.notEqual(point.net,"$NONE$","Assigned IPC-D-356 contact lost its net: " + key);
    assert.ok(!names.has(test.net) || names.get(test.net) === point.net, "IPC-D-356 net was split: " + test.net);
    assert.ok(!inverse.has(point.net) || inverse.get(point.net) === test.net, "Two IPC-D-356 nets were shorted");
    names.set(test.net,point.net);
    inverse.set(point.net,test.net);
    checks++;
  }
  let viaChecks = 0;
  for (const test of vias) {
    const net = names.get(test.net);
    if (!net || test.net === "N/C") continue;
    const point = step.electrical.points.find(row => row.net === net && row.flags.includes("v") && error(row,test) < .0037);
    assert.ok(point,"IPC-D-356 plated via missing from ODB++: " + JSON.stringify(test));
    maxError = Math.max(maxError,error(point,test));
    viaChecks++;
  }
  assert.ok(checks > 100 && viaChecks > 100);
  assert.equal(checks+unassigned+viaChecks+mechanical, records.length, "Unclassified IPC-D-356 contact");
  console.log(JSON.stringify({reference:"KiCad 9.0.9 video.d356",records:records.length,componentPins:checks,
    vias:viaChecks,unassigned,unassignedCad,mechanical,netGroups:names.size,maxPositionErrorMm:maxError}));
}

function main() {
  negativeReader();
  if (!fixtures) archiveStreaming();
  if (process.argv.includes("--ipc356")) {
    const boardSource = path.join(fixtures.directory,"video.kicad_pcb");
    const bytes = fs.readFileSync(boardSource);
    const initial = G.AtriumTranslators.import([{name:"video.kicad_pcb",bytes}],{name:"Video"});
    const project = A.validate(G.AtriumTranslatorProvenance.toLegacy(initial.model,initial.provenance));
    ipc356(project,project.documents.find(doc => doc.kind === "pcb"),fs.readFileSync(path.join(fixtures.directory,"video.d356"),"ascii"),bytes.toString("utf8"));
    return;
  }
  const designs = fixtures ? fixtures.projects.map(({fixture,directory,resources}) => {
    const files = resources.filter(file => file.role === "source").map(file => ({name:file.name,bytes:fs.readFileSync(path.join(directory,file.name))}));
    const opened = G.AtriumTranslators.import(files,{name:fixture.name,source_rules:"use"});
    const project = A.validate(G.AtriumTranslatorProvenance.toLegacy(opened.model,opened.provenance));
    return {project,board:project.documents.find(doc => doc.kind === "pcb")};
  }) : [synthetic()];
  let metricFont;
  for (const {project,board} of designs) {
    const {result,model,...metrics} = verify(project,board);
    assert.ok(metrics.checked >= 9);
    if (!fixtures) {
      const pcb = result.steps.get("pcb"), drills = [...pcb.layers.values()].flatMap(row => row.drill ? [...row.drill.hits,...row.drill.slots] : []);
      routedFilms(project, board, model, pcb);
      assert.ok(drills.some(row => row.subtype === "LASER") && drills.some(row => row.a && !row.plated),"Laser span and NPTH slot");
      matrixCheck(result);
      fontCheck(result);
      metricFont = result.entries.get("fonts/standard");
    }
    console.log(JSON.stringify({project:project.name,items:board.items.length,...metrics}));
  }
  if (!fixtures) {
    nativeFilmNoop();
    signedFilms();
    analyticFilms();
    analyticFilms("arc-first");
    analyticFilms("line-first");
    analyticFilms(undefined, true);
    signedFootprints();
    polygonalFilms();
    const {project,board} = synthetic();
    const imperial = verify(project,board,{units:"in",drillUnits:"in"});
    assert.equal(imperial.result.steps.get("pcb").profile.unit,"INCH");
    assert.equal(imperial.result.entries.get("fonts/standard"),metricFont);
    matrixCheck(imperial.result);
    panelCheck();
    flexAndMixedStacks();
    manufacturingReuse();
  }
}

if (require.main === module) main();
module.exports = {verify, synthetic, negativeReader};
