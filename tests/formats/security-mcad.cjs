"use strict";
// Adversarial MCAD inputs. An IDX or IDF file comes
// from a mechanical vendor and is untrusted; reading it must stay bounded in time and memory.
//   scripts/test-jsc.sh security-mcad        or      node tests/formats/security-mcad.cjs
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "pcb-appearance", "pcb-pours", "stackup", "board-shape", "rigid-flex", "zip", "fab-outputs", "step-export", "pcb-edit", "mcad-xml", "mcad", "mcad-idx", "mcad-idf"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const X = AtriumIDX, F = AtriumIDF;
const now = () => Date.now();

// P1 (Medium): an IDX arc through three nearly collinear points has a radius near 1e17 mm, so the
// flattening step count was ceil(sweep / acos(1)) = Infinity and the reader looped until memory ran out.
{
  const n = X.arcPoints([0, 0], [1e6, 1e-6], [2e6, 0]).length;
  assert.ok(n > 2 && n <= 1025, "a near-straight arc flattens to a bounded number of points (" + n + ")");
}

const head = '<?xml version="1.0"?>\n<foundation:EDMDDataSet xmlns:foundation="http://www.prostep.org/EDMD/3.0/foundation" xmlns:pdm="http://www.prostep.org/EDMD/3.0/pdm" ' +
  'xmlns:d2="http://www.prostep.org/EDMD/3.0/geometry.d2" xmlns:property="http://www.prostep.org/EDMD/3.0/property" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  "<foundation:Header><foundation:GlobalUnitLength>UNIT_MM</foundation:GlobalUnitLength></foundation:Header><foundation:Body>";
const pt = (id, x, y) => '<foundation:CartesianPoint id="' + id + '"><d2:X>' + x + "</d2:X><d2:Y>" + y + "</d2:Y></foundation:CartesianPoint>";
const keepout = (curve, shapes) => '<foundation:CurveSet2d id="CS"><d2:LowerBound>0</d2:LowerBound><d2:UpperBound>1</d2:UpperBound><d2:DetailedGeometricModelElement>' + curve +
  '</d2:DetailedGeometricModelElement></foundation:CurveSet2d><foundation:ShapeElement id="SE"><pdm:Inverted>false</pdm:Inverted><pdm:DefiningShape>CS</pdm:DefiningShape></foundation:ShapeElement>' +
  '<foundation:Item id="IT" geometryType="KEEPOUT_AREA_ROUTE"><foundation:Name>k</foundation:Name>' + "<pdm:Shape>SE</pdm:Shape>".repeat(shapes) + "</foundation:Item>";

// The same arc inside a real file: read() finishes.
{
  const t = now();
  const idx = head + pt("A", 0, 0) + pt("M", 1e6, 1e-6) + pt("B", 2e6, 0) + pt("C", 1e6, -5) +
    '<foundation:Arc id="AR"><d2:StartPoint>A</d2:StartPoint><d2:MidPoint>M</d2:MidPoint><d2:EndPoint>B</d2:EndPoint></foundation:Arc>' +
    '<foundation:PolyLine id="PL"><d2:Point>B</d2:Point><d2:Point>C</d2:Point><d2:Point>A</d2:Point></foundation:PolyLine>' +
    '<foundation:CompositeCurve id="CU"><d2:Curve>AR</d2:Curve><d2:Curve>PL</d2:Curve></foundation:CompositeCurve>' + keepout("CU", 1) + "</foundation:Body></foundation:EDMDDataSet>";
  const d = X.read(idx);
  assert.equal(d.keepouts.length, 1);
  assert.ok(d.keepouts[0].points.length <= 1030);
  assert.ok(now() - t < 10000, "bounded time");
}

// P2 (Medium): reference amplification. IDX objects refer to each other by id, so a few kilobytes
// can name one 100000-point curve from every shape of every item; each reference copied the
// points (the IDX analogue of entity expansion). The reader now has a total point budget.
{
  const arcs = '<foundation:Arc id="AR"><d2:StartPoint>A</d2:StartPoint><d2:MidPoint>M</d2:MidPoint><d2:EndPoint>B</d2:EndPoint></foundation:Arc>' +
    '<foundation:Arc id="AR2"><d2:StartPoint>B</d2:StartPoint><d2:MidPoint>N</d2:MidPoint><d2:EndPoint>A</d2:EndPoint></foundation:Arc>';
  const big = '<foundation:CompositeCurve id="CU">' + "<d2:Curve>AR</d2:Curve><d2:Curve>AR2</d2:Curve>".repeat(40) + "</foundation:CompositeCurve>";
  const idx = head + pt("A", -500, 0) + pt("M", 0, 500) + pt("B", 500, 0) + pt("N", 0, -500) + arcs + big + keepout("CU", 200) + "</foundation:Body></foundation:EDMDDataSet>";
  assert.ok(idx.length < 20000, "a small file");
  const t = now();
  assert.throws(() => X.read(idx), /expand to more than|more than 100000 points/);
  assert.ok(now() - t < 10000, "refused quickly");
  // A composite curve that grows past the per-curve cap is refused while it is built.
  const huge = '<foundation:CompositeCurve id="CU">' + "<d2:Curve>AR</d2:Curve><d2:Curve>AR2</d2:Curve>".repeat(5000) + "</foundation:CompositeCurve>";
  assert.throws(() => X.read(head + pt("A", -500, 0) + pt("M", 0, 500) + pt("B", 500, 0) + pt("N", 0, -500) + arcs + huge + keepout("CU", 1) + "</foundation:Body></foundation:EDMDDataSet>"), /more than 100000 points/);
}

// P1 in IDF: an arc record of 360 degrees between two distinct points (or a huge angle) gave
// k = Infinity / 1e13 flattening steps.
{
  const emn = (rows) => ".HEADER\nBOARD_FILE 3.0 \"x\" 2026/11/19.12:00:00 1\n\"B\" MM\n.END_HEADER\n.BOARD_OUTLINE ECAD\n1.6\n" + rows + ".END_BOARD_OUTLINE\n";
  const t = now();
  const d = F.read(emn("0 0 0 0\n0 10 0 360\n0 10 10 0\n0 0 0 1e12\n"));
  assert.ok(d.board && d.board.outline.length <= 2100, "bounded outline");
  assert.ok(now() - t < 10000);
  // Many arcs: the flattened total is capped across the file.
  const rows = [];
  for (let i = 0; i < 6000; i++) rows.push("0 0 0 0\n0 1 0 359.9\n");
  const many = ".HEADER\nBOARD_FILE 3.0 \"x\" 2026/11/19.12:00:00 1\n\"B\" MM\n.END_HEADER\n" + rows.map(r => ".ROUTE_KEEPOUT ECAD\nTOP\n" + r + ".END_ROUTE_KEEPOUT\n").join("");
  assert.throws(() => F.read(many), /expand to more than/);
}
console.log("security-mcad ok");
