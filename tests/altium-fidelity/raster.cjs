"use strict";
const C = require("../formats/gerber-compare.cjs");
const pixelMm = 0.025;

// A single shared coordinate grid for each pair. Stripe painting preserves draw order and
// clear polarity. The grid is never moved to make the two images look more alike.
function compare(a, b, negativeFilm, [dx, dy] = [0, 0]) {
  const outputBox = b.bbox?.map((v, i) => v + (i % 2 ? dy : dx));
  const grid = C.gridFor([a.bbox, outputBox, negativeFilm && C.bboxOf([negativeFilm])], pixelMm);
  if (grid.w * grid.h > 160_000_000) throw Error("Gerber comparison exceeds the raster budget");
  let missing = 0, added = 0;
  for (let row = 0; row < grid.h; row += 256) {
    const stripe = {...grid, y0:grid.y0 + row * pixelMm, h:Math.min(256, grid.h - row)};
    const ref = C.rasterize(a.shapes, stripe), out = C.rasterize(b.shapes, {...stripe, x0:stripe.x0 - dx, y0:stripe.y0 - dy});
    if (negativeFilm) {
      const inside = C.rasterize([negativeFilm], stripe);
      for (let k = 0; k < ref.length; k++) ref[k] = inside[k] && !ref[k] ? 1 : 0;
    }
    for (let k = 0; k < ref.length; k++) {
      const delta = ref[k] - out[k];
      if (delta > 0) missing++;
      else if (delta < 0) added++;
    }
  }
  const area = n => Math.round(n * pixelMm * pixelMm * 1e6) / 1e6;
  return {xorMm2:area(missing + added), missingMm2:area(missing), addedMm2:area(added)};
}

const xorMm2 = (...args) => compare(...args).xorMm2;
module.exports = {compare, xorMm2, pixelMm};

if (require.main === module) {
  const assert = require("node:assert/strict");
  const square = (x, y) => ({k:"poly", dark:true, rings:[[[x,y], [x+1,y], [x+1,y+1], [x,y+1]]]});
  const image = shapes => ({shapes, bbox:C.bboxOf(shapes)});
  const a = image([square(0,0)]), b = image([square(1,0)]), empty = image([]);
  assert.equal(xorMm2(a,a), 0);
  assert.equal(xorMm2(a,b), 2);
  assert.deepEqual(compare(a,b), {xorMm2:2, missingMm2:1, addedMm2:1});
  assert.equal(xorMm2(a,b,null,[-1,0]), 0);
  assert.equal(xorMm2(empty,empty,square(0,0)), 1, "negative film is confined to the board");
  assert.equal(xorMm2(image([{k:"poly",dark:true,rings:[[[0,0],[1,0],[1,10],[0,10]]]}]), empty), 10, "stripe boundary");
  const arcText = "%FSLAX46Y46*%%MOMM*%%ADD10C,0.2*%G75*D10*X1000000Y0D02*G03X1000000Y0I-1000000J0D01*M02*";
  const circle = C.parseGerber(arcText, {verifyArcs:true});
  assert.equal(circle.arcDrawCount, 1);
  assert.equal(circle.warnings.length, 0);
  assert.ok(xorMm2(circle,empty) > 1.2, "a same-endpoint D01 draws a full circle");
  const region = C.parseGerber(arcText.replace("X1000000Y0D02*", "G36*X1000000Y0D02*").replace("M02*", "G37*M02*"), {verifyArcs:true});
  assert.equal(region.arcRegionCount, 1);
  assert.equal(region.warnings.length, 0);
  assert.ok(xorMm2(region,empty) > 3.1, "a closed circular region is filled");
  assert.equal(C.parseGerber(arcText.replace("G03X1000000", "G03X2000000"), {verifyArcs:true}).warnings.length, 1);
}
