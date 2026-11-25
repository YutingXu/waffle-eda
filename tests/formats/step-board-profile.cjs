"use strict";
const assert = require("node:assert/strict");
const {nativeRoundTrip} = require("../support/native-cad.cjs");
const {parseGerber} = require("./gerber-compare.cjs");
for (const name of ["pcb-appearance", "board-shape", "stackup", "fab-outputs", "sexpr", "step-export", "step-import"]) {
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
}

const S = AtriumBoardShape, STEP = AtriumSTEP;
const center = [29.5, -17.25], radius = 3;
const rectangle = S.rect({x: 10, y: -6, width: 48, height: 24, corners: {bl: {style: "radius", size: 4}}});
const date = new Date("2025-01-01T00:00:00Z");
const yUp = ([x, y]) => [x, -y];

function openProfile(shape, region) {
  const project = Atrium.project("PCB profile");
  const board = project.documents.find(doc => doc.kind === "pcb");
  S.apply(board, shape, "wizard");
  if (region) {
    const [cutout] = board.boardShape.cutouts;
    board.boardShape.cutoutRegions = {0: {...region, sig: S.signature(S.flattenContour(cutout))}};
  }
  board.origin = [7.25, -3.5];
  const native = nativeRoundTrip(Atrium.validate(project));
  const reopened = native.documents.find(doc => doc.id === board.id);
  assert.deepEqual(reopened.boardShape, board.boardShape, "native members retain the authored arcs and profile region");
  return {native, board: reopened};
}

function gerber(native, board, origin = "absolute") {
  const result = AtriumFabOutputs.build(native, board, {date, units: "mm", format: "4:6", origin});
  const text = result.files.find(file => file.name.endsWith(".GM1")).content;
  return {text, film: parseGerber(text)};
}

function step(native, board) {
  const {data} = STEP.build(native, board, {components: false});
  const parsed = STEP.parse(data);
  return {data, entities: Array.from(parsed.entities.values()), imported: AtriumSTEPImport.tessellate(data)};
}

function filmContains(film, [x, y]) {
  let inside = false;
  for (const stroke of film.draws) {
    for (let i = 1; i < stroke.points.length; i++) {
      const [a, b] = [stroke.points[i - 1], stroke.points[i]];
      if ((a[1] > y) !== (b[1] > y) && x < a[0] + (y - a[1]) * (b[0] - a[0]) / (b[1] - a[1])) inside = !inside;
    }
  }
  return inside;
}

function meshContains(mesh, [x, y], z = mesh.bbox[5]) {
  for (const {positions, indices} of mesh.parts) {
    for (let i = 0; i < indices.length; i += 3) {
      const vertices = [indices[i], indices[i + 1], indices[i + 2]];
      if (vertices.some(j => Math.abs(positions[3 * j + 2] - z) > 1e-5)) continue;
      const signs = vertices.map((j, k) => {
        const a = 3 * j, b = 3 * vertices[(k + 1) % 3];
        return (positions[b] - positions[a]) * (y - positions[a + 1]) -
          (positions[b + 1] - positions[a + 1]) * (x - positions[a]);
      });
      if (Math.abs(signs.reduce((a, b) => a + b, 0)) < 1e-12) continue;
      if (signs.every(n => n >= 0) || signs.every(n => n <= 0)) return true;
    }
  }
  return false;
}

function radii(entities) {
  return entities.filter(entity => entity.type === "CYLINDRICAL_SURFACE").map(entity => entity.args[2]).sort((a, b) => a - b);
}

{
  const input = S.arc(center, radius, 0, 1e-9, true);
  const {native, board} = openProfile({...rectangle, cutouts: [[input]]});
  const [arc] = board.boardShape.cutouts[0], witness = yUp([28.5, -17.25]);
  assert.equal(Math.abs(arc.end - arc.start), 1e-9);
  assert.ok(Math.abs(S.sweep(arc)) > 0 && Math.abs(S.sweep(arc)) < 2e-9);
  const plot = gerber(native, board), solid = step(native, board);
  assert.equal(plot.film.arcDrawCount, 1, "only the outer fillet is plotted");
  assert.equal(filmContains(plot.film, witness), true);
  assert.equal(meshContains(solid.imported, witness), true, "a one-nanodegree cutout leaves the witness on the board");
  assert.deepEqual(radii(solid.entities), [4], "the STEP file has no extra full turn");
}

{
  const outer = [S.arc([15, -15], 9, 90, 90, true)];
  const hole = [S.arc([16, -14], 3, 90, 90, false)];
  const {native, board} = openProfile({version: 1, contour: outer, cutouts: [hole]});
  assert.equal(S.sweep(board.boardShape.contour[0]), 360);
  assert.equal(S.sweep(board.boardShape.cutouts[0][0]), -360);
  const model = STEP.model(native, board, {components: false}), solid = step(native, board), plot = gerber(native, board);
  const [body] = model.board.bodies;
  assert.deepEqual(body.prism.loops.map(loop => loop.map(segment => segment.ccw)), [[true, true], [false, false]]);
  assert.deepEqual(radii(solid.entities), [3, 9]);
  assert.equal(plot.film.arcDrawCount, 2);
  assert.deepEqual([...plot.text.matchAll(/(G0[23])X[^*]+D01\*/g)].map(m => m[1]).sort(), ["G02", "G03"]);
  assert.equal(filmContains(plot.film, yUp([16, -14])), false);
  assert.equal(meshContains(solid.imported, yUp([16, -14])), false);
}

{
  const almostFull = S.arc(center, radius, 0, 0.0005, false);
  const closure = S.line(S.tail(almostFull), S.head(almostFull));
  const {native, board} = openProfile({...rectangle, cutouts: [[almostFull, closure]]});
  const model = STEP.model(native, board, {components: false});
  const loop = model.board.bodies[0].prism.loops[1];
  assert.equal(loop.filter(segment => segment.c).length, 1, "a near-full arc keeps its closing line");
  assert.equal(loop.length, 2);
  assert.equal(meshContains(step(native, board).imported, yUp(center)), false);
  assert.equal(gerber(native, board).film.arcDrawCount, 2);
}

{
  const hole = [S.arc(center, radius, 0, 0, false)];
  const island = [S.arc(center, 1, 90, 90, true)];
  const proxy = S.fromPolygon(S.flattenContour(hole, 0.5)).contour;
  const {native, board} = openProfile({...rectangle, cutouts: [proxy]}, {version: 1, contour: hole, cutouts: [island]});
  const solid = step(native, board), plot = gerber(native, board);
  const samples = [
    ["island", center, true],
    ["inside the circle but outside the containment chords", [29.5, -20.049038], false],
    ["outer board", [20, -12], true],
  ];
  assert.equal(S.contains(board.boardShape, center), false, "routing keeps the containment ring");
  assert.equal(plot.film.arcDrawCount, 3);
  assert.deepEqual(radii(solid.entities), [1, 3, 4], "STEP writes the exact island and cutout cylinders");
  assert.equal(solid.entities.filter(entity => entity.type === "MANIFOLD_SOLID_BREP").length, 2);
  const model = STEP.model(native, board, {components: false});
  const mesh = STEP.mesh(model);
  for (const [name, point, material] of samples) {
    const xy = yUp(point);
    assert.equal(filmContains(plot.film, xy), material, name + " Gerber");
    assert.equal(meshContains(solid.imported, xy), material, name + " emitted STEP");
    assert.equal(meshContains(mesh, xy, model.board.z1), material, name + " model mesh");
  }

  const originalFilm = gerber(native, board, "user").text;
  board.origin = [1, 2];
  assert.notEqual(gerber(native, board, "user").text, originalFilm);
  assert.equal(STEP.build(native, board, {components: false}).data, solid.data);

  board.items.push({kind: "via", id: "island-via", x: center[0], y: center[1], diameter: 0.8, drill: 0.5});
  const drilled = STEP.model(native, board, {components: false});
  assert.deepEqual(drilled.board.bodies.map(body => body.holes), [0, 1]);
  assert.equal(meshContains(step(native, board).imported, yUp(center)), false, "the drill belongs to the island");

  delete board.boardShape.cutoutRegions;
  board.items.pop();
  assert.equal(meshContains(step(native, board).imported, yUp(center)), false, "without the exact region the containment opening is used");
}

{
  const hole = [S.arc(center, radius, 0, 0, false)];
  const proxy = S.fromPolygon(S.flattenContour(hole, 0.5)).contour;
  const {native, board} = openProfile({...rectangle, cutouts: [proxy]}, {version: 1, contour: hole, cutouts: []});
  const region = board.boardShape.cutoutRegions[0];
  delete region.cutouts;
  assert.deepEqual(S.profileContours(S.screenProfile(board)), [board.boardShape.contour, region.contour],
    "a valid exact void without material islands replaces the routing approximation on screen");
  const solid = step(native, board);
  assert.equal(meshContains(solid.imported, yUp(center)), false);
  assert.deepEqual(radii(solid.entities), [3, 4], "the exact curved void remains in STEP");
}

const {F2, F6, C1, assertFlatten} = require("../support/a1-geometry.cjs");
const {pointSeg} = require("../support/segment-distance.cjs");
const curves = AtriumGeometryCurves;
assertFlatten(curves.flatten);
assert.throws(() => curves.flatten([C1.arc], 1e-15), /point budget/);

{
  const {native, board} = openProfile(S.rect({x:-18, y:12, width:36, height:24}));
  const layers = AtriumStackup.build(["Signal","Signal","Signal","Signal"]).layers;
  layers.filter(row => row.type === "Dielectric").forEach((row, i) => { row.thickness = [.53,.5,.5][i]; });
  layers.filter(AtriumStackup.isCopper).forEach(row => { row.thickness = F6.externalCopper; });
  board.stackup = {version:1, layers};
  const pad = (id,x,delta) => ({id,kind:"pad",x,y:0,w:F6.diameter,h:F6.diameter,shape:"round",layer:"Multi",drill:F6.drill,plated:true,...delta});
  const points = [[1.8,-1.3],[12.4,-1.3],[12.4,1.3],[1.8,1.3]];
  board.items.push(pad("slot",3,{holeOnly:true,drill:.6,slotLength:2,slotAngle:90}), pad("npth",7,{plated:false,drill:.65}),
    {id:"blind",kind:"via",x:11,y:0,diameter:1,drill:.5,fromLayer:"Top",toLayer:"Inner 1"},
    ...["Top","Inner 2","Bottom"].map(layer => ({id:"stock "+layer,kind:"graphic",layer,fill:true,closed:true,points})));
  const output = STEP.build(native, board, {components:false,copper:true,holes:true}).data;
  const mesh = AtriumSTEPImport.tessellate(output);
  for (const z of [F6.dielectric+F6.externalCopper,-F6.externalCopper])
    assert.deepEqual([[3,-.65],[3,-1.1],[7,0],[7,-.7],[11,0]].map(p => meshContains(mesh,p,z)), [false,true,false,true,z<0]);
  assert.equal(mesh.stats.skipped,0);
}

function strokeHit(film, width, point) {
  return film.draws.some(draw => Math.abs(draw.width - width) < 1e-6 &&
    draw.points.some((b, i, points) => i > 0 && pointSeg(point, points[i - 1], b) < width / 2));
}

{
  const base = {...F2.track, id: Atrium.id(), layer: "Top"};
  const outline = S.rect({x: -22, y: 18, width: 44, height: 36});
  let authoredStep;
  for (const [name, track, curved] of [
    ["authored arc", base, true],
    ["dense projection", {...base, points: Atrium.arcProjection(base.arc, 6)}, true],
    ["stale arc", {...base, arc: {...base.arc, end: F2.staleEnd}}, false],
    ["bare flag", {...base, arc: true}, false],
    ["chord only", {...base, arc: undefined}, false]
  ]) {
    const design = Atrium.project("F2 curved trace"), original = design.documents.find(doc => doc.kind === "pcb");
    S.apply(original, outline, "wizard");
    original.items.push(track);
    const native = nativeRoundTrip(Atrium.validate(design)), board = native.documents.find(doc => doc.id === original.id);
    const reopened = board.items.find(item => item.id === track.id);
    const F = AtriumFormat2, M = AtriumFormat2Model, saved = M.fromEditor(design).files.find(row => row.path.endsWith(".wpcb")).file;
    const resaved = F.edit(saved, M.documentEdits(saved, board, {put: [reopened]}));
    assert.deepEqual(F.serialize(resaved), F.serialize(saved), name + " native board bytes");
    assert.deepEqual(reopened.arc, track.arc, name + " native arc");
    assert.deepEqual(reopened.points, track.points.map(point => point.map(S.roundScalar)), name + " native projection");
    const result = AtriumFabOutputs.build(native, board, {date, units: "mm", format: "4:6", origin: "absolute"});
    const points = [F2.inside, F2.outside].map(yUp), occupied = [curved, !curved];
    for (const [ext, width] of [["GTL", 0.8], ["GTS", 1.2], ["GTP", 0.5]]) {
      const file = result.files.find(file => file.name.endsWith("." + ext));
      const film = parseGerber(file.content);
      assert.equal(film.arcDrawCount, curved ? 1 : 0, name + " " + ext + " native arc counts");
      assert.deepEqual(points.map(point => strokeHit(film, width, point)), occupied, name + " " + ext + " occupancy");
    }
    const options = {components: false, copper: true};
    const stepData = STEP.build(native, board, options).data, exported = AtriumSTEPImport.tessellate(stepData);
    assert.deepEqual(points.map(point => meshContains(exported, point)), occupied, name + " STEP copper cap");
    if (name === "authored arc") authoredStep = stepData;
    if (name === "dense projection") assert.equal(stepData, authoredStep, "stored sampling does not affect exact STEP output");
    original.items.push({kind: "graphic", id: "stock", layer: "Top", fill: true, closed: true,
      points: [[-8, -8], [8, -8], [8, 2], [-8, 2]]});
    for (const enabled of [true, false]) {
      const model = STEP.model(design, original, {...options, maskOpenings: enabled});
      const mesh = STEP.mesh(model, {flatLayerCaps: true});
      assert.deepEqual(mesh.layerWarnings, []);
      const hits = kind => points.map(point => meshContains({parts: mesh.parts.filter(layer => layer.kind === kind)}, point, model.board.z1 + .035));
      assert.deepEqual(hits("copper"), [true, true], name + " stencil copper");
      assert.deepEqual(hits("opening"), enabled ? occupied : [false, false], name + " stencil opening");
    }
  }
}

// Clockwise full turns keep their inner void. A wide half-turn joins the
// two end caps behind the centre, with no inverted inner arc.
for (const [arc, width, points, expected] of [
  [{...F2.track.arc, end: 0, ccw: false}, 1.2, [[0, 0], [0, 6]], [false, true]],
  [F2.track.arc, 13, [[0, 0], [0, 1.5], [0, 3]], [true, true, false]]
]) {
  const design = Atrium.project("Curved stroke"), board = design.documents.find(doc => doc.kind === "pcb");
  S.apply(board, S.rect({x: -22, y: 18, width: 44, height: 36}), "wizard");
  board.items.push({...F2.track, id: "track", layer: "Top", width, arc, points: Atrium.arcProjection(arc)});
  const model = STEP.model(design, board, {components: false, copper: true}), mesh = STEP.mesh(model);
  assert.deepEqual(mesh.layerWarnings, []);
  assert.deepEqual(points.map(point => meshContains(mesh, yUp(point), model.board.z1 + .035)), expected);
}

// A renderer using even-odd parity has to see one occupied join or crossing.
for (const [centerline, witnesses] of [
  [[[-3, 0], [0, 0], [0, 3]], [[0, 0], [.4, -.8], [.8, -.8]]],
  [[[-3, -3], [3, 3], [-3, 3], [3, -3]], [[0, 0], [0, 1.5], [0, 3]]]
]) {
  const width = 2;
  const islands = curves.strokeOutline({kind: "stroke", centerline: curves.lineEdges(centerline), width}, .005);
  const film = {draws: islands.flatMap(({outer, holes}) => [outer, ...holes].map(loop => ({points: curves.flatten(loop, .005)})))};
  for (const point of witnesses) {
    const expected = centerline.slice(1).some((b, i) => pointSeg(point, centerline[i], b) < width / 2);
    assert.equal(filmContains(film, point), expected, "even-odd stroke occupancy at " + point);
  }
}

console.log("Native reopen, exact profile and curved strokes in Gerber and physical surfaces, and bounded curve sampling passed.");
