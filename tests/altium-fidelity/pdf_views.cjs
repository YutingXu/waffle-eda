"use strict";

const assert = require("node:assert/strict");
const C = require("../formats/gerber-compare.cjs");
const PT_PER_MM = 72 / 25.4;

// Project the actual CAM films when the publication requests copper with no
// hole or pad adornments. Its internal plane pages expose voids inside the
// board, rather than positive copper. Plot ink is kept neutral on these pages.
function copperView(board, view, plots, origin, [cx, cy]) {
  const [ptW, ptH] = view.mediaPt, factor = 384 / Math.max(ptW, ptH);
  const width = Math.ceil(ptW * factor), height = Math.ceil(ptH * factor);
  const s = 1 / ((view.physicalScale || view.scale) * PT_PER_MM * factor);
  const toPlot = ([x,y]) => [x - origin[0], origin[1] - y];
  const centre = toPlot([cx, cy]);
  const grid = {x0:centre[0] - width*s/2, y0:centre[1] - height*s/2, w:width, h:height, s};
  const films = view.layers.map(layer => {
    if (layer === "Top") return "GTL";
    if (layer === "Bottom") return "GBL";
    if (layer.startsWith("Mechanical ")) return "GM" + layer.slice(11);
    return "G" + layer.slice(6);
  });
  function exposure(film) {
    assert(plots.has(film), "publication view requires film " + film);
    const parsed = C.parseGerber(plots.get(film));
    assert(!parsed.warnings.length, "invalid CAM for publication view " + film);
    return C.rasterize(parsed.shapes, grid);
  }
  const copper = films.map(exposure);
  let dark = i => copper.some(p => p[i]);
  if (view.kind === "negative-plane") {
    const crop = [{k:"poly", dark:true, rings:[board.outline.map(toPlot)]},
      ...(board.boardShape?.cutouts || []).map(ring => ({
        k:"poly", dark:false, rings:[AtriumBoardShape.flattenContour(ring).map(toPlot)]
      }))];
    const material = C.rasterize(crop, grid), outline = exposure("GM1");
    dark = i => outline[i] || material[i] && !copper[0][i];
  }
  const pixels = Buffer.alloc(width * height, 255);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const source = (height - 1 - y) * width + x;
    if (dark(source)) pixels[y*width + x] = 0;
  }
  return {width, height, pixels};
}

// Render the publisher's individual layer list through the editor's normal PCB
// renderer and PDF recorder. This leaves the general Print presets unchanged.
function render(board, defs, project, views, date, plots, origin) {
  const pdf = AtriumPDF.document({date});
  const appearance = AtriumPCBAppearance, original = {...appearance.system};
  const allLayers = new Set([...AtriumDXF.layersOf(board, defs).map(l => l.name),
    "Top", "Bottom", "Multi", "Silk", "Bottom silk", "Top mask", "Bottom mask", "Top paste", "Bottom paste",
    "Keepout", "Drill guide", "Drill drawing", "Board", ...Object.keys(board.layerNames || {})]);
  for (const r of board.pcbDrawing?.pours || []) allLayers.add(r.layer);
  for (const item of board.items) {
    allLayers.add(item.layer);
    if (item.kind !== "part") continue;
    for (const effect of appearance.footprintLayers(item, defs.get(item.def)?.footprint)) allLayers.add(effect.layer);
    for (const label of appearance.sourceLabels(board, item) || []) allLayers.add(label.layer);
  }
  const bounds = Atrium.bounds(board.outline);
  assert(bounds, "publication view needs a fixed board extent");
  const cx = (bounds[0] + bounds[2]) / 2, cy = (bounds[1] + bounds[3]) / 2;
  const ids = [], planes = [];
  Object.assign(appearance.system, {workspace:"#fff", board:"#fff", edge:"#000", hole:"#fff", padHole:"#fff"});
  try {
    for (const [name, pages] of Object.entries(views)) for (const [n, config] of Object.entries(pages)) {
      if (config.kind === "negative-plane" || config.kind === "positive-copper") {
        planes.push({name, n:Number(n), ...copperView(board, config, plots, origin, [cx,cy])});
        continue;
      }
      if (config.kind !== "pcb") continue;
      const [w, h] = config.mediaPt, active = config.layers.find(l => /^(Top|Bottom|Inner \d+)$/.test(l)) || config.layers[0];
      const scale = (config.physicalScale || config.scale) * PT_PER_MM;
      const visible = new Set(config.layers);
      if (config.holes) visible.add("Multi");
      const hidden = new Set([...allLayers].filter(l => !visible.has(l)));
      const pixelRatio = 2;
      const rec = AtriumPDF.recorder(w * pixelRatio, h * pixelRatio, {unit:1 / pixelRatio, ink:AtriumPrint.inkFor({}, true)});
      const view = AtriumCanvas.create(rec.canvas);
      view.restoreCamera({cx, cy, scale:scale * pixelRatio, referenceScale:scale * pixelRatio, flipped:config.flip});
      rec.ctx.save();
      rec.ctx.beginPath();
      rec.ctx.rect(...config.cropPt.map(v => v * pixelRatio));
      rec.ctx.clip();
      view.render(board, defs, {project, layer:active, hidden, grid:false, origin:false, showUnrouted:false});
      rec.ctx.restore();
      pdf.page(w, h, rec.list);
      ids.push({name, n:Number(n)});
    }
  } finally {
    Object.assign(appearance.system, original);
  }
  return {ids, planes, bytes:ids.length ? pdf.bytes() : null};
}

module.exports = {render};
