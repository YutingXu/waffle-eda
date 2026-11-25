"use strict";

const assert = require("node:assert/strict");
const {pads6, unitMm} = require("./slots.cjs");

// Pads6 carries the old compatibility shape as well as the newer exact
// rounded rectangle. Only those authored alternate-shape records may vary
// in the historical stock-rule comparison.
function legacyShapes(streams) {
  const shapes = new Map();
  for (const {bytes, view, pad, padSize, extension, extensionSize} of pads6(streams)) {
    if (padSize < 63 || extensionSize < 596 || bytes[pad + 62] || bytes[extension + 532] !== 9) continue;
    const shape = bytes[pad + 49];
    if ((shape !== 1 && shape !== 9) || bytes[extension + 564] > 100) continue;
    const owner = view.getUint16(pad + 7, true);
    const key = [owner, ...[13,17,21,25,45].map(offset => view.getInt32(pad + offset, true))].join("/");
    assert(!shapes.has(key) || shapes.get(key) === shape, "ambiguous compatibility shape in Pads6");
    shapes.set(key, shape);
  }
  return shapes;
}

function sourcePads(board, defs, visit) {
  for (const item of board.items) {
    if (item.kind === "pad") visit(item, 0xffff, [item.x, item.y]);
    if (item.kind !== "part") continue;
    const owner = Number(item.sourceRecord?.match(/^components6?\/data#(\d+)$/)?.[1]);
    for (const pad of defs.get(item.def)?.footprint?.pads || []) visit(pad, owner, Atrium.world([pad.x, pad.y], item));
  }
}

function compare(project, original, streams, findings) {
  const rules = AtriumRules.effective(original, project);
  const sourceRules = rules.list.filter(r => r.type === "silkToMask" && r.enabled && typeof r.exposedCopper === "boolean");
  if (!sourceRules.length) return null;
  const ids = new Set(sourceRules.map(r => r.id));
  const authored = findings.filter(r => r.type === "silkToMask" && ids.has(r.id)).reduce((n,r) => n + r.count, 0);
  const sourceLimits = sourceRules.map(r => ({gapMm:r.gap, surface:r.exposedCopper ? "exposed pad copper" : "mask opening"}));
  const measure = (pcb, defs, project) => AtriumRules.drc(pcb, defs, rules, {types:["silkToMask"], limit:Infinity, project});
  const isText = violation => Array.isArray(violation.textAt);
  const originalResult = measure(original, new Map(project.library.map(d => [d.id, d])), project);
  const authoredRows = originalResult.violations.filter(v => ids.has(v.ruleId));
  assert.equal(authoredRows.length, authored, "authored silk findings must agree with batch counts");
  const stock = AtriumRules.create().list.find(r => r.type === "silkToMask");
  assert(stock && stock.gap === .1, "the historical stock silk rule changed");
  rules.list = rules.list.filter(r => r.type !== "silkToMask").concat(stock);
  const control = structuredClone(project), pcb = control.documents.find(d => d.id === original.id);
  const defs = new Map(control.library.map(d => [d.id, d]));
  const exactStock = measure(pcb, defs, control);
  const shapes = legacyShapes(streams);
  let projectedPads = 0;
  sourcePads(pcb, defs, (pad, owner, [x, y]) => {
    if (!Number.isFinite(pad.roundrectRadiusRatio)) return;
    const key = [owner, ...[x,-y,pad.w,pad.h,pad.drill].map(v => Math.round((v || 0) / unitMm))].join("/");
    const shape = shapes.get(key);
    assert(shape, "missing compatibility shape for authored rounded pad");
    pad.shape = shape === 1 ? "round" : "roundrect";
    delete pad.roundrectRadiusRatio;
    projectedPads++;
  });
  const legacyStock = measure(pcb, defs, control);
  const legendText = {authored:authoredRows.filter(isText).length, exactStock:exactStock.violations.filter(isText).length,
    legacyStock:legacyStock.violations.filter(isText).length};
  return {sourceRules:sourceRules.length, sourceLimits, authored, exactStock:exactStock.total, legacyStock:legacyStock.total, projectedPads, legendText};
}

module.exports = {compare};
