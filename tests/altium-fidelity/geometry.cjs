"use strict";

const assert = require("node:assert/strict");
const inc = (counts, key) => counts[key] = (counts[key] || 0) + 1;
const order = counts => Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, "en")));
const arcs = contours => contours.flat().filter(g => g.kind === "arc").length;

function source(streams) {
  function count(name) {
    const data = streams.get(name + "/data");
    if (!data?.length) return 0;
    const header = streams.get(name + "/header");
    assert.equal(header?.length, 4, "missing source count for " + name);
    return new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(0, true);
  }
  return {arcs:count("arcs6"), regions:count("regions6"), shapeBasedRegions:count("shapebasedregions6"),
    bodies:count("componentbodies6"), models:count("models")};
}

// Count placed geometry by effective layer. Preserve the difference between a
// footprint definition and a placed copy of its artwork, pads, vias or bodies.
function board(doc, defs) {
  const itemArcs = {}, footprintArcs = {}, artwork = {}, keepouts = {}, polygonCutouts = {};
  const shape = doc.boardShape, bodyModels = doc.bodyModels || [];
  const stored = new Set(bodyModels.filter(m => m.zlib || m.stepText).map(m => m.id));
  const models = new Set(bodyModels.filter(m => stored.has(m.id) || stored.has(m.assetId)).map(m => m.id));
  const bodies = {extruded:0, step:0, unresolvedReferences:0, models:bodyModels.length,
    embeddedOrSuppliedModels:models.size, storedModelPayloads:stored.size};
  let pourArcs = 0, regionArcs = 0, regionHoles = 0, footprintVias = 0, padSlots = 0, storedIslands = 0, storedIslandHoles = 0;
  function contour(o, layer, arcCounts) {
    if (o.arc?.kind === "arc") {
      const {c, r, start, end} = o.arc;
      assert(c?.length === 2 && [...c, r, start, end].every(Number.isFinite) && r > 0, "invalid model arc");
      inc(arcCounts, layer);
      if (o.sourcePour) pourArcs++;
    }
    if (o.cutout) inc(polygonCutouts, layer);
    else if (o.fill && (o.keepout || layer === "Keepout")) inc(keepouts, layer);
    else if (o.fill) inc(artwork, layer);
    if (o.regionShape) {
      const holes = o.regionShape.cutouts || [];
      regionArcs += arcs([o.regionShape.contour, ...holes]);
      regionHoles += holes.length;
    }
  }
  function physical(records) {
    for (const b of records || []) {
      if (b.type === "extruded") bodies.extruded++;
      if (b.type === "step") {
        bodies.step++;
        if (!models.has(b.modelId)) bodies.unresolvedReferences++;
      }
    }
  }
  physical(doc.bodies3d);
  for (const item of doc.items) {
    if (item.kind === "part") {
      const fp = defs.get(item.def)?.footprint;
      for (const s of fp?.shapes || []) {
        const layer = AtriumPCBAppearance.shapeLayer(item, s);
        contour(s, layer, footprintArcs);
      }
      footprintVias += (fp?.pads || []).filter(p => p.kind === "via").length;
      padSlots += (fp?.pads || []).filter(p => p.drill > 0 && p.slotLength > p.drill).length;
      physical(item.bodies3d);
    } else {
      if (item.kind === "pad" && item.drill > 0 && item.slotLength > item.drill) padSlots++;
      contour(item, item.layer || "Top", itemArcs);
    }
  }
  for (const region of doc.pcbDrawing?.pours || []) {
    if (region.source !== "altium") continue;
    storedIslands++;
    storedIslandHoles += region.count - 1;
  }
  return {
    itemArcs:order(itemArcs), footprintArcs:order(footprintArcs), sourcePourArcs:pourArcs,
    profileArcs:arcs(shape?.contour ? [shape.contour] : []),
    boardCutouts:shape?.cutouts?.length || 0,
    cutoutArcs:arcs(shape?.cutouts || []),
    regionArcs, regionHoles,
    filledArtwork:order(artwork), keepouts:order(keepouts), polygonCutouts:order(polygonCutouts),
    storedIslands, storedIslandHoles, footprintVias, padSlots, bodies
  };
}

function pdfCurves(pages) {
  // The display list encodes move and line as 2 operands, cubic as 6,
  // close as none. PDF serializes these cubic paths without flattening them.
  const nArgs = [2, 2, 6, 0];
  let curves = 0;
  for (const p of pages) {
    if (p.kind !== "pcb") continue;
    for (const op of p.list) {
      if (op.k !== "p") continue;
      for (let k = 0; k < op.d.length;) {
        const code = op.d[k++];
        assert(nArgs[code] !== undefined, "unknown PDF path operator");
        if (code === 2) curves++;
        k += nArgs[code];
      }
    }
  }
  return curves;
}

function formats(project, doc, defs, fab, pdf) {
  const layers = AtriumDXF.layersOf(doc, defs).map(l => l.name);
  const dxf = AtriumDXF.exportBoard(doc, defs, {layers, mode:"primitives"});
  const curves = AtriumDXF.read(dxf.text).entities.flatMap(e => e.segs).filter(g => g.kind === "arc").length;
  const ipc = AtriumIPC2581.build(project, doc, {...fab.options, model:fab.model});
  const ipcArcs = (ipc.content.match(/<(?:Arc|PolyStepCurve)\b/g) || []).length;
  const sourceBodies = (doc.bodies3d?.length || 0) + doc.items.reduce((count, item) => count + (item.bodies3d?.length || 0), 0);
  const defaultScene = AtriumSTEP.model(project, doc, {generated:false});
  const defaultStepBodies = defaultScene.parts.filter(p => p.bodyRecord).length;
  const scene = defaultStepBodies < sourceBodies ?
    AtriumSTEP.model(project, doc, {generated:false, include:() => true}) : defaultScene;
  const authored = scene.parts.filter(p => p.bodyRecord);
  const stepModels = authored.filter(p => p.source === "model").length;
  const stepExtrusions = authored.filter(p => p.source === "extruded").length;
  let stepAssemblyInstances = 0;
  if (authored.length) {
    const step = AtriumSTEP.step(scene);
    stepAssemblyInstances = (step.match(/=\s*NEXT_ASSEMBLY_USAGE_OCCURRENCE\(/g) || []).length;
    assert(stepAssemblyInstances >= authored.length, "authored bodies missing from STEP assembly");
  }
  return {dxfArcs:curves, ipc2581Arcs:ipcArcs, pcbPdfCubicSegments:pdfCurves(pdf.pages),
    stepModels, stepExtrusions, stepAssemblyInstances, defaultStepBodies, stepBodiesMissing:sourceBodies - authored.length};
}

module.exports = {source, board, formats};
