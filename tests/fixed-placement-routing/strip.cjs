"use strict";
const assert = require("node:assert/strict");
const {definitions} = require("./runtime.cjs");
const copy = structuredClone;
const pick = (o, keys) => Object.fromEntries(keys.filter(k => Object.hasOwn(o, k)).map(k => [k, copy(o[k])]));
const copper = layer => layer === "Multi" || AtriumAutorouter.copperIndex(layer) >= 0;
const obstacle = it => !!it.keepout || /keep.?out/i.test(it.layer || "") || !!it.cutout;
const padKeys = ["id", "kind", "number", "x", "y", "w", "h", "drill", "slot", "holeShape", "holeLength", "holeAngle", "shape", "slotLength", "slotAngle", "backdrill", "ipc4761",
  "layer", "angle", "plated", "net", "stackMode", "padStack", "roundrectRadiusRatio", "roundRectRatio", "cornerRatio", "plotLand", "holeOnly", "tent", "maskExpansion", "pasteExpansion", "fabTestpoint"];
const partKeys = ["id", "kind", "def", "ref", "value", "x", "y", "angle", "layer", "side", "mirror", "mirrored", "flip", "locked",
  "link", "pinNets", "height", "componentClass", "parameters"];
const boardKeys = ["id", "kind", "name", "grid", "outline", "boardShape", "stackup", "origin", "rooms", "componentClasses", "flex",
  "layerNames", "sourceRuleLayers", "sourceRules", "sourceClasses"];
const projectKeys = ["format", "version", "formatVersion", "name", "rules", "ruleSets", "signals"];

function inventory(p) {
  const d = p.documents.find(x => x.kind === "pcb"), defs = definitions(p), items = d.items;
  const parts = items.filter(i => i.kind === "part"), count = kind => items.filter(i => i.kind === kind).length;
  let pads = count("pad"), embeddedVias = 0, footprintCopper = 0, footprintKeepouts = 0;
  for (const part of parts) {
    const fp = defs.get(part.def).footprint;
    for (const pad of fp.pads) if (pad.kind === "via") embeddedVias++; else pads++;
    for (const s of fp.shapes || []) if (obstacle(s)) footprintKeepouts++; else if (copper(s.layer)) footprintCopper++;
  }
  return {parts: parts.length, bottom: parts.filter(i => i.layer === "Bottom" || i.side === "bottom").length, pads,
    tracks: count("track"), arcs: items.filter(i => i.kind === "arc" || (i.kind === "track" && i.arc)).length,
    vias: count("via"), polygons: count("polygon"), fills: items.filter(i => i.kind === "graphic" && copper(i.layer) && !obstacle(i)).length,
    pouredRegions: d.pcbDrawing?.pours?.length || 0, embeddedVias, footprintCopper,
    keepouts: items.filter(obstacle).length + footprintKeepouts, cutouts: d.boardShape?.cutouts?.length || 0,
    layers: AtriumAutorouter.boardLayers(d, defs), rules: AtriumRules.stored(d, p)?.list.length || 0};
}

// Physical identity of every placed pad (including duplicates, unassigned lands and mechanical holes).
function placements(p) {
  const d = p.documents.find(i => i.kind === "pcb"), defs = definitions(p);
  return d.items.filter(i => i.kind === "part" || i.kind === "pad").map(i => {
    if (i.kind === "pad") return pick(i, padKeys);
    return [pick(i, partKeys), defs.get(i.def).footprint.pads.filter(p => p.kind !== "via").map(p =>
      [pick(p, padKeys), Atrium.world([p.x, p.y], i)])];
  });
}

function strip(original) {
  const source = original.documents.find(d => d.kind === "pcb");
  assert(source && original.documents.filter(d => d.kind === "pcb").length === 1, "one board per public fixture");
  const p = pick(original, projectKeys), d = {...pick(source, boardKeys), notes: [], items: []};
  // Legacy files infer the stack from occupied layers; freeze the supported physical stack before removal.
  if (!d.stackup) d.stackup = copy(AtriumStackup.get(source, definitions(original)));
  const used = new Set();
  for (const i of source.items) {
    if (i.kind === "part") { used.add(i.def); d.items.push(pick(i, partKeys)); }
    else if (i.kind === "pad") d.items.push(pick(i, padKeys));
    else if (obstacle(i)) {
      // Prevent keepout geometry represented as a track or polygon from becoming an electrical conductor.
      const item = copy(i);
      item.kind = "graphic";
      if (!item.cutout) item.keepout = true;
      delete item.net;
      delete item.sourcePour;
      d.items.push(item);
    }
  }
  p.documents = [d];
  p.library = original.library.filter(def => used.has(def.id)).map(def => {
    const fp = def.footprint, clean = pick(def, ["id", "name", "prefix", "value", "category", "netTie", "netTieGroups"]);
    clean.footprint = {...pick(fp, ["name", "height", "netTie", "netTieGroups"]),
      pads: fp.pads.filter(p => p.kind !== "via").map(p => pick(p, padKeys)),
      // The copper bridge of a normally closed solder jumper is a part of the packaged component.
      shapes: (fp.shapes || []).filter(s => !copper(s.layer) || obstacle(s) || (fp.netTie || def.netTie) && !s.net).map(s => copy(s))};
    return clean;
  });
  assert.deepEqual(placements(p), placements(original), "changed a part transform, physical pad or assigned net");
  assert.deepEqual(AtriumRules.stored(d, p), AtriumRules.stored(source, original), "changed applicable rules");
  assert.deepEqual(AtriumAutorouter.boardLayers(d, definitions(p)), AtriumAutorouter.boardLayers(source, definitions(original)), "changed stack");
  return p;
}

module.exports = {strip, inventory, placements, obstacle, copper};
