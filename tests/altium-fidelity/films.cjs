"use strict";

const assert = require("node:assert/strict");
const C = require("../formats/gerber-compare.cjs");
const R = require("./raster.cjs");

const round = n => Math.round(n * 1e6) / 1e6;
const arcCount = film => film.arcDrawCount + film.arcRegionCount;

// The fixtures pin one translation from the original output frame to the
// published datum. Transfer it to the actual output frame, which may now
// use the native PCB origin. The exporter converts its Y-down model to Y up.
function referenceOffset(offset, [legacyX, legacyY], [actualX, actualY]) {
  return offset ? [round(offset[0] + (actualX - legacyX)), round(offset[1] + (legacyY - actualY))] : undefined;
}

// A negative copper film describes voids. Confine its inverse to the shipped
// continuous, closed profile. Solder mask is measured as mask openings.
function filmBoundary(profile) {
  if (!profile || profile.warnings.length) return null;
  const ring = [];
  for (const s of profile.shapes) {
    if (s.k !== "capsule" || !s.dark || ring.length && (s.x1 !== ring.at(-1)[0] || s.y1 !== ring.at(-1)[1])) return null;
    if (!ring.length) ring.push([s.x1, s.y1]);
    ring.push([s.x2, s.y2]);
  }
  return ring.length >= 4 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1]
    ? {k:"poly", dark:true, rings:[ring]} : null;
}

// Profile strokes can represent the identical centreline at different pen
// widths. Measure both the manufactured centreline and a width-only control.
function profileGeometry(reference, out, [dx, dy] = [0, 0]) {
  const widths = plot => [...new Set(plot.draws.map(d => round(d.width)).filter(Boolean))].sort((a, b) => a - b);
  const refWidths = widths(reference), outWidths = widths(out);
  function moved(shape) {
    return {...shape, x1:shape.x1 + dx, x2:shape.x2 + dx, y1:shape.y1 + dy, y2:shape.y2 + dy};
  }
  const refStrokes = reference.shapes.filter(s => s.k === "capsule" && s.dark);
  const outStrokes = out.shapes.filter(s => s.k === "capsule" && s.dark);
  const outline = refStrokes.length && outStrokes.length ?
    C.compareOutlines({shapes:refStrokes}, {shapes:outStrokes.map(moved)}) : null;
  const singleWidth = refWidths.length === 1 && refStrokes.length === reference.shapes.length &&
    outStrokes.length === out.shapes.length && outWidths.length === 1;
  let normalizedXor = null;
  if (singleWidth) {
    const shapes = outStrokes.map(s => ({...s, r:refWidths[0] / 2}));
    normalizedXor = R.xorMm2(reference, {shapes, bbox:C.bboxOf(shapes)}, null, [dx, dy]);
  }
  return {referenceStrokeWidthsMm:refWidths, generatedStrokeWidthsMm:outWidths,
    centrelineDeviationMm:outline ? round(outline.maxDev) : null, uniformWidthXorMm2:normalizedXor};
}

// Each reference has a stable published film key and a fixture-authored target
// layer mapping. Unmapped or unsupported references stay in the report.
function measure(references, generated, offset) {
  const plots = generated.map(({layer, text}) => {
    const film = C.parseGerber(text, {verifyArcs:true});
    assert(!film.warnings.length, layer + " generated an unreadable Gerber");
    return [layer, film];
  });
  const parsed = new Map(plots);
  assert.equal(parsed.size, plots.length, "generated Gerber layers have duplicate keys");
  const refs = references.map(({key, layer, text}) => ({
    key, layer, film:C.parseGerber(text), negative:/TF\.FilePolarity,Negative/.test(text)
  }));
  const keys = new Set(refs.map(r => r.key));
  assert.equal(keys.size, refs.length, "published Gerber layers have duplicate keys");
  const boundary = filmBoundary(refs.find(r => r.layer === "profile")?.film);
  const referenced = new Set();
  const layers = {};
  for (const {key, layer, film, negative} of refs) {
    const outputLayer = layer === "profile" ? "GM1" : layer === "unmapped" ? null : layer;
    if (outputLayer) referenced.add(outputLayer);
    const out = parsed.get(outputLayer);
    const referencePolarity = film.attributes.file[".FilePolarity"] || "unspecified";
    // Some reference tools place X2 metadata in G04 comments.
    const copperNegative = /^G(?:TL|BL|[0-9]+)$/.test(layer) && (negative || referencePolarity === "Negative");
    const detail = {outputLayer, referencePolarity, referenceArcs:arcCount(film)};
    if (!out) {
      Object.assign(detail, {xorMm2:null, reason:outputLayer ? "layer absent from export" : "no equivalent Waffle layer"});
    } else if (film.warnings.length) {
      Object.assign(detail, {xorMm2:null, reason:"reference uses unsupported image commands", parserWarnings:new Set(film.warnings).size});
    } else if (copperNegative && !boundary) {
      Object.assign(detail, {xorMm2:null, reason:"negative copper film without a closed reference profile"});
    } else {
      const invert = copperNegative ? boundary : null;
      Object.assign(detail, R.compare(film, out, invert));
      if (offset) {
        const {xorMm2, missingMm2, addedMm2} = R.compare(film, out, invert, offset);
        Object.assign(detail, {registeredXorMm2:xorMm2, registeredMissingMm2:missingMm2, registeredAddedMm2:addedMm2});
      }
      if (layer === "profile") detail.profile = profileGeometry(film, out, offset);
    }
    if (out) Object.assign(detail, {generatedDrawArcs:out.arcDrawCount, generatedRegionArcs:out.arcRegionCount});
    layers[key] = detail;
  }
  const comparable = Object.values(layers).filter(layer => layer.xorMm2 !== null);
  const sum = metric => comparable.length ? round(comparable.reduce((n, layer) => n + layer[metric], 0)) : null;
  return {
    gerberXorMm2:sum("xorMm2"),
    ...(offset ? {registeredXorMm2:sum("registeredXorMm2")} : {}),
    measuredLayers:comparable.length,
    generatedWithoutReference:[...parsed.keys()].filter(layer => !referenced.has(layer)).sort(),
    generatedArcs:Object.fromEntries(plots.filter(([, film]) => arcCount(film)).map(([layer, film]) => [layer, arcCount(film)]).sort()),
    layers:Object.fromEntries(Object.entries(layers).sort(([a], [b]) => a.localeCompare(b, "en")))
  };
}

module.exports = {measure, referenceOffset};

if (require.main === module) {
  const outlineFrame = [2.54, -4.826], nativeFrame = [0, 0], pinned = [2.54, 4.826];
  assert.deepEqual(referenceOffset(pinned, outlineFrame, outlineFrame), pinned);
  const offset = referenceOffset(pinned, outlineFrame, nativeFrame);
  assert.deepEqual(offset, [0, 0], "the export frame already accounts for the published shift");
  assert.equal(referenceOffset(undefined, outlineFrame, nativeFrame), undefined);

  const flash = x => "%FSLAX46Y46*%%MOMM*%%ADD10C,1*%D10*X" + x + "Y0D03*M02*";
  const reference = [{key:"GTL", layer:"GTL", text:flash(1000000)}];
  const compare = x => measure(reference, [{layer:"GTL", text:flash(x)}], offset);
  assert.equal(compare(1000000).registeredXorMm2, 0);
  assert.ok(compare(1250000).registeredXorMm2 > 0, "a film shifted independently of the exported frame still fails");
  const line = diameter => "%FSLAX46Y46*%%MOMM*%%ADD10C," + diameter + "*%D10*X0Y0D02*X1000000Y0D01*M02*";
  const profile = measure([{key:"GM", layer:"profile", text:line(".2")}], [{layer:"GM1", text:line(".1")}]).layers.GM;
  assert.ok(profile.xorMm2 > 0);
  assert.equal(profile.profile.centrelineDeviationMm, 0);
  assert.equal(profile.profile.uniformWidthXorMm2, 0);
}
