"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const {appFile} = require("../support/app-source-paths.cjs");
for (const name of ["model", "pcb-appearance", "board-shape", "panel", "pcb-edit", "fab-outputs", "step-export", "view3d",
  "source-file", "format-2-codec", "format-2-units", "format-2-values", "format-2-model"]) require(appFile(name + ".js"));

require("../support/3d-geometry.cjs");
const A = Atrium, S = AtriumSTEP, F = AtriumFabOutputs, Native = AtriumFormat2Model;
function design() {
  const project = A.project("Physical bores", []), doc = project.documents.find(d => d.kind === "pcb");
  doc.outline = [[0,0],[22,0],[22,10],[0,10]];
  doc.stackup = AtriumStackup.build(Array(4).fill("Signal"));
  const dielectrics = doc.stackup.layers.filter(l => l.type === "Dielectric");
  dielectrics.forEach((row, i) => { row.thickness = i === 1 ? .73 : .4; });
  const place = (x, y, values) => ({id: A.id(), kind: "pad", x, y, layer: "Multi", w: 2, h: 2, shape: "round", ...values});
  const annulus = place(3, 4, {drill: 1, plated: true, stackMode: "full", padStack: {Top: {w: 2, h: 2}}});
  const slot = place(8, 4, {w: 0, h: 0, drill: .5, plated: false, slotLength: 2, angle: 30, slotAngle: 60});
  const via = (x, fields) => ({id: A.id(), kind: "via", layer: "Multi", x, y: 4, diameter: 1.4, drill: .4, ...fields});
  const blind = via(12, {fromLayer: "Inner 1", toLayer: "Top", microvia: false});
  const back = via(16, {backdrill: {from: "top", toLayer: "Inner 2", stubMax: .1, diameter: .9}});
  const noDepth = via(20, {fromLayer: "Top", toLayer: "Inner 5"});
  doc.items = [annulus, slot, blind, back, noDepth, ...[8, 12, 16, 20].flatMap(x =>
    ["Top", "Bottom"].map(layer => place(x, 4, {layer, w: 3, h: 3, shape: "rect"})))];
  return {project, doc, annulus, slot, blind, back, noDepth};
}

function occupied(mesh, [x, y], z) {
  const p = mesh.positions, indices = mesh.indices;
  const edge = (a, b) => (p[b] - p[a]) * (-y - p[a+1]) - (p[b+1] - p[a+1]) * (x - p[a]);
  for (let i = 0; i < indices.length; i += 3) {
    const a = 3 * indices[i], b = 3 * indices[i+1], c = 3 * indices[i+2];
    if (Math.abs(p[a+2] - z) > 1e-6 || Math.abs(p[b+2] - z) > 1e-6 || Math.abs(p[c+2] - z) > 1e-6) continue;
    const signs = [edge(a,b), edge(b,c), edge(c,a)];
    if (signs.every(n => n >= -1e-7) || signs.every(n => n <= 1e-7)) return true;
  }
  return false;
}
function capFaces(step, suffix) {
  const E = S.parse(step).entities, get = ref => E.get(ref.ref);
  return [...E.values()].filter(e => e.type === "MANIFOLD_SOLID_BREP" && e.args[0].str.replace(/ \d+$/, "").endsWith(suffix)).map(e =>
    get(e.args[1]).args[1].map(get).filter(f => {
      const p = get(f.args[2]);
      return p.type === "PLANE" && Math.abs(get(get(p.args[1]).args[2]).args[1][2]) === 1;
    }).map(f => f.args[1].map(get).filter(b => b.type === "FACE_BOUND").length));
}
function films(project, doc) {
  const output = F.analyse(project, doc, {pourFill:"stored", pourCheck:false});
  const plan = F.plan(output, {date:new Date("2026-01-01T00:00:00Z"), origin:"absolute"});
  const copper = side => F.generate(output, plan, plan.files.find(file => file.layer?.key === side)).content;
  const drill = plan.files.filter(file => file.kind === "drill").map(file => F.generate(output, plan, file).content).join("\n");
  return {copper, drill};
}
const sceneOf = (project, doc) => S.model(project, doc, {copper:true, components:false, fab:{pourFill:"stored", pourCheck:false}});
const {project, doc, annulus, slot, blind, back, noDepth} = design();
const authored = films(project, doc);
const originFlash = /X3000000Y-4000000D03\*/;
assert.match(authored.copper("Top"), originFlash);
assert.match(authored.copper("Bottom"), originFlash);
assert.match(authored.drill, /X3\.0Y-4\.0/);
assert.match(authored.drill, /X8\.0Y-3\.25G85X8\.0Y-4\.75/);

const meshScene = sceneOf(project, doc), meshed = S.mesh(meshScene);
const top = 1.635, bottom = -.035;
assert.equal(meshScene.board.thickness, 1.6, "datum starts at the lowest dielectric's bottom face");
const covered = (parts, side, point) => parts.some(part => part.kind === "copper" && part.side === side &&
  occupied(part, point, side === "Top" ? top : bottom));
const checkCoverage = parts => {
  for (const side of ["Top", "Bottom"]) {
    assert.equal(covered(parts, side, [3,4]), false, side + " annulus has an open bore");
    assert.equal(covered(parts, side, [3.75,4]), true, side + " retains finished copper outside its drill");
    assert.equal(covered(parts, side, [8,4.65]), false, side + " cross-owner plated film has the rotated NPTH slot");
    assert.equal(covered(parts, side, [8.4,4.65]), true, side + " slot preserves adjacent copper");
    assert.equal(covered(parts, side, [12,4]), side === "Bottom", side + " blind span clips its reached exterior only");
    assert.equal(covered(parts, side, [16.33,4]), side === "Bottom", side + " oversize backdrill clips the entry side");
    assert.equal(covered(parts, side, [20,4]), true, side + " keeps copper when authored drill depth is unresolved");
  }
};
checkCoverage(meshed.parts);
checkCoverage(Atrium3D.meshFor(project, doc, 0, true).layers);

{
  const {project, doc, slot} = design();
  const pad = {...slot, x:0, y:0};
  const def = {id:A.id(), name:"Slotted opening", footprint:{pads:[pad], shapes:[]}};
  project.library = [def];
  doc.items = [{kind:"part", id:A.id(), def:def.id, ref:"J1", x:8, y:4, showRef:true}];
  const mark = "X8000000Y-4000000D03*";
  const apertureAtSlot = text => {
    const lines = text.split(/\r?\n/), at = lines.indexOf(mark);
    if (at < 0) return null;
    const tool = lines.slice(0, at).reverse().find(line => /^D\d+\*$/.test(line)).slice(1, -1);
    return Number(lines.find(line => line.startsWith("%ADD" + tool + "C,")).split(",")[1].slice(0, -2));
  };
  for (const [revision, [expansion, radius]] of [[undefined,.1016],[.35,.35],[0,0]].entries()) {
    if (expansion !== undefined) pad.maskExpansion = expansion;
    const layerMesh = Atrium3D.meshFor(project, doc, revision, true).layers;
    const generated = films(project, doc);
    for (const [side,z] of [["Top",top],["Bottom",bottom]]) {
      const covers = point => layerMesh.some(part => part.layerKey === side + " mask" && occupied(part, point, z));
      assert.equal(apertureAtSlot(generated.copper(side + " mask")), radius ? 2 * radius : null);
      assert.equal(covers([8,4]), radius > 0, side + " mask follows the plotted slot opening");
      if (radius) {
        assert.equal(covers([8 + radius * .5,4]), true);
        assert.equal(covers([8 + radius + .05,4]), false);
      }
    }
    assert.match(generated.drill, /X8\.0Y-3\.25G85X8\.0Y-4\.75/);
  }
}
const viaOff = S.mesh(S.model(project, doc, {copper:true, components:false, vias:false}));
assert.equal(covered(viaOff.parts, "Top", [12,4]), false, "substrate display options preserve finished copper");
assert.ok(viaOff.parts.some(p => p.kind === "board" && occupied(p, [12,4], 1.6)),
  "disabling via holes leaves the substrate solid for a blind via");

const glb = S.build(project, doc, {format:"glb", copper:true, components:false}).data;
const binary = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
const jsonBytes = binary.getUint32(12, true), binStart = 28 + jsonBytes;
const gltf = JSON.parse(new TextDecoder().decode(glb.subarray(20, 20 + jsonBytes)));
const readAccessor = (id, read, width) => {
  const a = gltf.accessors[id], v = gltf.bufferViews[a.bufferView], from = binStart + v.byteOffset + (a.byteOffset || 0);
  return Array.from({length:a.count * width}, (_, i) => read.call(binary, from + i * 4, true));
};
const glbLayers = gltf.nodes.filter(node => /^(Top|Bottom) copper$/.test(node.name)).map(node => {
  const p = gltf.meshes[node.mesh].primitives[0];
  return {kind:"copper", side:node.name.split(" ")[0],
    positions:readAccessor(p.attributes.POSITION, binary.getFloat32, 3),
    indices:readAccessor(p.indices, binary.getUint32, 1)};
});
checkCoverage(glbLayers);
const boardHas = (pt, z) => meshed.parts.some(p => p.kind === "board" && occupied(p, pt, z));
assert.equal(boardHas([3,4], 1.6), false);
assert.equal(boardHas([3,4], 0), false);
assert.equal(boardHas([8,4.65], 0), false, "the substrate keeps the slot's axis");
assert.equal(boardHas([12,4], 0), true, "substrate stays solid below a blind bore");
assert.equal(boardHas([16.33,4], 1.6), false, "upper substrate follows the backdrill");
assert.equal(boardHas([16.33,4], 0), true, "lower substrate keeps material outside the primary tool");
assert.ok(meshScene.notes.some(s => s.includes(noDepth.id) && s.includes("unknown-bore-depth")));
{
  const geometryView = AtriumResolvedGeometry.read({kind:"snapshot", project, root:doc,
    revision:{kind:"snapshot", projectId:project.id, rootId:doc.id, generation:"body diagnostics"}});
  const body = S.model(project, doc, {components:false, geometryView});
  const unresolved = [...geometryView.bores()].find(bore => bore.key.owner.id === noDepth.id);
  assert.equal(unresolved.z, null);
  assert.ok(!body.board.bores.includes(unresolved), "an unknown depth cannot cut a board solid");
  assert.deepEqual(body.notes, S.model(project, doc, {components:false}).notes, "body-only diagnostics retain their text and order");
  const blindBore = body.board.bores.find(bore => bore.key.owner.id === blind.id);
  assert.equal(blindBore, geometryView.owner(blindBore.key.owner).bores[0], "full owner and body share the same immutable cutter");
  assert.ok(Object.isFrozen(blindBore));
}

const text = S.step(meshScene);
for (const side of ["Top", "Bottom"]) assert.ok(capFaces(text, side + " copper").some(faces => faces.every(n => n > 0)),
  side + " STEP copper has explicit inner face wires");
for (const [{id, kind}, expected] of [[slot, "slot"], [blind, "round"], [back, "round"]]) {
  assert.ok(meshScene.board.bores.some(bore => bore.operation === "primary" && bore.cutter.kind === expected &&
    (bore.cutter.at?.[0] ?? bore.cutter.centerline[0].a[0]) === doc.items.find(i => i.id === id && i.kind === kind).x));
}

const nativeBefore = Native.fromEditor(project);
const nativeBoards = nativeBefore.files.filter(({file}) => file.header.kind === "pcb");
for (const {file} of nativeBoards) {
  const bytes = AtriumFormat2.serialize(file), read = Native.parse(bytes);
  assert.deepEqual(AtriumFormat2.serialize(read), bytes, "native source retains its bytes after physical projection");
  const reopened = Native.document(read);
  assert.deepEqual(reopened.items.find(i => i.id === annulus.id).padStack, annulus.padStack);
  assert.match(films({...project, documents:[reopened]}, reopened).drill, /X8\.0Y-3\.25G85X8\.0Y-4\.75/);
}

annulus.padStack.Top = {w:0, h:0};
assert.doesNotMatch(films(project, doc).copper("Top"), originFlash);
assert.equal(films(project, doc).drill, authored.drill);
delete annulus.padStack.Top;
assert.match(films(project, doc).copper("Top"), originFlash);
assert.equal(films(project, doc).drill, authored.drill);
annulus.drill = 0;
const undrilled = S.mesh(sceneOf(project, doc));
for (const side of ["Top", "Bottom"]) assert.equal(covered(undrilled.parts, side, [3,4]), true, side + " drill-off control");
assert.doesNotMatch(films(project, doc).drill, /X3\.0Y-4\.0/);
annulus.drill = 1;

const panel = AtriumPanel.create(project, {rows:1, cols:2, alternate:"cols"});
project.documents.push(panel);
const {doc: flat, layout} = AtriumPanel.flatten(project, panel);
assert.equal(layout.instances.length, 2);
const repeatedMesh = S.mesh(sceneOf(project, flat)), copies = layout.instances.map(occurrence => occurrence.T([3,4]));
assert.notDeepEqual(copies[0], copies[1]);
for (const center of copies) for (const side of ["Top", "Bottom"])
  assert.equal(covered(repeatedMesh.parts, side, center), false, "a rotated panel copy preserves each exterior bore");
{
  const {project, doc} = design();
  const def = {id:A.id(), name:"Bore footprint", footprint:{shapes:[], pads:[{
    x:1, y:.5, w:3, h:2.5, number:"1", shape:"rect", layer:"Multi", angle:21, slotAngle:27, slotLength:2, drill:.5
  }]}};
  const part = {kind:"part", id:A.id(), def:def.id, x:9, y:5, angle:20, ref:"J1"};
  project.library = [def];
  doc.items = [part];
  const radians = n => n * Math.PI / 180;
  const center = [9 + Math.cos(radians(20)) - .5 * Math.sin(radians(20)),
    5 + Math.sin(radians(20)) + .5 * Math.cos(radians(20))];
  const nearEnd = [center[0] + .65 * Math.cos(radians(68)), center[1] + .65 * Math.sin(radians(68))];
  const preview = () => S.mesh(sceneOf(project, doc)).parts;
  assert.equal(covered(preview(), "Top", nearEnd), false, "original slot axis");
  assert.equal(AtriumPCBEdit.flip(doc, project, [part.id]).length, 1);
  const mirrored = [18 - nearEnd[0], nearEnd[1]];
  assert.equal(covered(preview(), "Bottom", mirrored), false, "physical flip mirrors the slot axis");
  const offAxis = [18 - center[0] + .65 * Math.cos(radians(68)), nearEnd[1]];
  assert.equal(covered(preview(), "Bottom", offAxis), true, "unflipped winding would remove the wrong point");
}
{
  const directory = path.join(__dirname, "../fixtures/mcad/native");
  const native = file => Native.parse(fs.readFileSync(path.join(directory, file), "utf8"));
  const board = Native.document(native("Board.wpcb"));
  const design = A.project("Native QFN receipt", [Native.library(native("libraries/QFN16.wlib"))]);
  design.documents = [board];
  let walks = 0, plotHits = 0, itemArtwork = 0;
  const material = AtriumGeometryMaterial, mask = AtriumMaskOpenings, text = AtriumPCBText;
  globalThis.AtriumGeometryMaterial = {...material,
    collect(ctx) { walks++; return material.collect(ctx); },
    visitPad(...args) { plotHits++; return material.visitPad(...args); }
  };
  globalThis.AtriumMaskOpenings = {...mask, collect(ctx) { if (ctx.item) itemArtwork++; return mask.collect(ctx); }};
  globalThis.AtriumPCBText = {...text, collect(ctx) { if (ctx.item) itemArtwork++; return text.collect(ctx); }};
  try {
    const body = Atrium3D.meshFor(design, board, 0, false), initialWalks = walks;
    assert.equal(itemArtwork, 0, "a cold body build does not materialize item artwork");
    const viewer = Atrium3D.meshFor(design, board, 0, true);
    assert.equal(viewer, body, "copper uses the already prepared 3D body receipt");
    assert.ok(initialWalks > 0 && itemArtwork > 0, "the body asks for drills and the subsequent film asks for artwork");
    assert.equal(walks, initialWalks, "late copper builds no new drill walk");
    assert.equal(plotHits, 0, "viewer asks fabrication for film without rebuilding drill machine data");
    const pad = [39.25, 13.4], moved = [42.25, 13.4];
    assert.equal(covered(viewer.layers, "Bottom", pad), true);
    const part = board.items.find(i => i.id === "pU1");
    part.x += 3;
    const edited = Atrium3D.meshFor(design, board, 1, true);
    assert.notEqual(edited, viewer);
    assert.equal(covered(edited.layers, "Bottom", pad), false);
    assert.equal(covered(edited.layers, "Bottom", moved), true);
    part.x -= 3;
    const restored = Atrium3D.meshFor(design, board, 2, true);
    assert.equal(covered(restored.layers, "Bottom", pad), true);
    assert.equal(covered(restored.layers, "Bottom", moved), false);
  } finally {
    globalThis.AtriumGeometryMaterial = material;
    globalThis.AtriumMaskOpenings = mask;
    globalThis.AtriumPCBText = text;
  }
}
{
  const {project, doc} = design();
  doc.items = [];
  const material = AtriumGeometryMaterial, layers = material.layers(doc, project);
  const owner = {kind:"board", documentId:doc.id, instancePath:[]};
  const disk = (at, r) => [{outer:[{kind:"arc", center:at, radius:r, start:0, sweep:360}], holes:[]}];
  const feature = (layer, member, polarity, islands) => ({key:{owner, member:[member], role:"drawing", layer},
    ink:{kind:"region", islands}, polarity, net:null});
  const features = [
    feature("Top", "annulus", "add", disk([3,4], 1)),
    feature("Top", "clear", "clear", disk([3.7,4], .12)),
    feature("Bottom", "annulus", "add", disk([3,4], 1))
  ];
  const bores = [{key:{owner, member:["test hole"]}, operation:"primary", plated:true, treatment:null,
    cutter:{kind:"round", at:[3,4], diameter:1}, z:[-.035,1.635], from:"Top", to:"Bottom"}];
  let reads = [], boreReads = 0, compositions = 0, stale = false;
  const view = {
    revision:{rootId:doc.id}, layers, bores() { boreReads++; return bores; }, diagnostics:() => [],
    assertCurrent() { if (stale) throw Error("stale test read"); },
    features({layer}) { reads.push(layer); return features.filter(f => f.key.layer === layer); },
    area(key, stage) { assert.equal(stage, "film"); return features.find(f => f.key === key).ink.islands; },
    layerArea(layer, stage) {
      compositions++;
      assert.equal(stage, "film");
      return material.layerArea(features, bores, layer, stage, null, null, {layers});
    }
  };
  const resolved = S.model(project, doc, {copper:true, components:false, geometryView:view});
  const mesh = S.mesh(resolved);
  assert.equal(resolved.board.holes.length, 1, "bore came from the supplied read");
  assert.deepEqual(reads, ["Top", "Bottom"]);
  assert.equal(covered(mesh.parts, "Top", [3,4]), false);
  assert.equal(covered(mesh.parts, "Top", [3.7,4]), false, "the ordered clear film removes a second point");
  assert.equal(covered(mesh.parts, "Bottom", [3.7,4]), true, "that clear belongs to Top only");
  assert.equal(covered(mesh.parts, "Top", [3,4.8]), true);
  reads = [];
  const partial = S.layersFor(project, doc, resolved, {geometryView:view, layerKeys:["Bottom"], copper:true});
  assert.deepEqual(reads, ["Bottom"], "requesting one dirty layer resolves no other film");
  assert.deepEqual(partial.layers.map(l => l.key), ["Bottom"]);
  assert.equal(boreReads, 1, "the same view reuses the body's physical bores");
  S.layersFor(project, doc, resolved, {geometryView:{...view}, layerKeys:["Bottom"], copper:true});
  assert.equal(boreReads, 2, "another view needs its own bores");
  const undrilled = S.model(project, doc, {geometryView:view, holes:false});
  S.layersFor(project, doc, undrilled, {geometryView:view, layerKeys:["Bottom"], copper:true});
  assert.equal(boreReads, 3, "a body built without drilling has no receipt to reuse");
  reads = []; compositions = 0;
  const options = {geometryView:view,copper:true};
  const steps = S.layerStepsFor(project,doc,resolved,options,()=>true);
  assert.equal(steps.next().done,false,"the first physical feature yields before preparing all artwork");
  assert.deepEqual(reads,["Top"],"a paused first face leaves the later face cold");
  assert.equal(compositions,0,"the feature scan yields before starting the signed composition");
  let step;
  while (!(step=steps.next()).done);
  assert.deepEqual(step.value,S.layersFor(project,doc,resolved,options),"the synchronous and sliced encoders return the same geometry");
  const cancelled = S.layerStepsFor(project,doc,resolved,options,()=>true);
  assert.equal(cancelled.next().done,false);
  stale = true;
  assert.throws(() => cancelled.next(), /stale test read/, "a suspended job cannot continue to a stale physical layer");
  assert.throws(() => S.layersFor(project, doc, resolved, {geometryView:view, copper:true}), /stale test read/);
  assert.throws(() => S.model(project, doc, {geometryView:{...view, revision:{rootId:"other"}}}), /different PCB/);
}
{
  const {project, doc}=design();
  doc.items=[
    {id:"elbow",kind:"track",layer:"Top",width:.8,points:[[4,4],[8,4],[8,8]]},
    {id:"tool",kind:"pad",layer:"Multi",x:8,y:4,w:0,h:0,drill:.4,plated:false}
  ];
  const scene=S.model(project,doc,{copper:true,components:false,holes:false});
  const outer=S.mesh(scene).parts.filter(part=>part.kind==="copper"&&part.side==="Top");
  const cap=point=>outer.some(part=>occupied(part,point,1.635));
  assert.ok(cap([7.72,4.2]),"the elbow retains the additive overlap just outside its drill");
  assert.ok(cap([8.3,7]) && cap([5,4.3]),"both legs retain their width");
  assert.equal(cap([8,4]),false,"neither solid can plug the cross-owner hole");
  assert.equal(cap([7.2,4.45]),false,"the fillet cannot spill outside the authored stroke");
  assert.deepEqual(capFaces(S.step(scene),"Top copper"),[[1,1],[1,1]],"both true STEP shells have separate open bores");
}
console.log("Resolved material: authored fabrication, native bytes, independent STEP cap and viewer triangles, slots and physical depth, unknown span, panel repeats");
