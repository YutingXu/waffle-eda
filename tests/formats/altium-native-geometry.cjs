"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["model","parts","board-shape","board-shape-sources","altium-ids","pcb-import","io","altium-export"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const A = Atrium, S = AtriumBoardShape, X = AtriumAltiumExport;
const fixture = path.join(__dirname, "../fixtures/altium/pidp11-io-expander/designer-ascii-geometry.txt");
const source = fs.readFileSync(fixture, "utf8"), read = s => AtriumIO.read("PiDP.PcbDoc", Buffer.from(s));
const ticks = mil => { assert.match(mil, /mil$/); return Math.round(parseFloat(mil) * 10000); };
const toTicks = p => [Math.round(p[0] / .00000254) || 0, Math.round(-p[1] / .00000254) || 0];
const fields = s => s.trim().split(/\r\n|\r|\n/).map(line => Object.fromEntries(line.slice(1).split("|").map(f => f.split("="))));
const vertex = (r, i) => [ticks(r["VX" + i]), ticks(r["VY" + i])];
const nativeCorners = [[0,0],[23500000,0],[23500000,8500000],[0,8500000]];
const nativeArcs = {D1:[18551181,6750000], U1:[5891732,3100000], U2:[10800000,1862205]};

// The expected integer coordinates are readings from Designer's BoardOutline and arc iterator.
function checkModel(result) {
  const doc = result.documents[0], defs = new Map(result.library.map(d => [d.id,d]));
  assert.deepEqual(doc.outline.map(toTicks), nativeCorners);
  const found = {};
  for (const part of doc.items.filter(i => i.kind === "part")) {
    const arcs = defs.get(part.def).footprint.shapes.filter(s => s.arc);
    assert.equal(arcs.length, 1);
    const s = arcs[0];
    found[part.ref] = toTicks(A.world(s.arc.c, part));
    assert.equal(Math.round(s.arc.r / .00000254), 49213);
    assert.equal(Math.round(s.width / .00000254), 98425);
    assert.equal(A.arcSweep(s.arc), 360);
    assert.equal(s.layer, "Silk");
  }
  assert.deepEqual(found, nativeArcs);
}
const result = read(source);
checkModel(result);
// Waffle's earlier exporter used an implicitly closed board and bare or undotted center fields.
const open = source.replace(/\|KIND4=0[^\r\n]*/, "");
for (const schema of [["LOCATIONX","LOCATIONY"],["X","Y"]]) {
  checkModel(read(open.replace(/LOCATION\.X/g, schema[0]).replace(/LOCATION\.Y/g, schema[1])));
}
checkModel(read(source.replace(/\|LOCATION\.X=/g, "|LOCATIONX=0mil|X=0mil|LOCATION.X=")));

const project = A.project("PiDP", result.library), doc = result.documents[0];
const rows = fields(X.exportBoard(project, doc).content);
const board = rows.find(r => r.RECORD === "Board");
assert.equal(Object.keys(board).filter(k => /^VX\d+$/.test(k)).length, 5);
assert.deepEqual([0,1,2,3,4].map(i => vertex(board, i)), [...nativeCorners,nativeCorners[0]]);
assert.equal(board.KIND4, "0");
const arcs = rows.filter(r => r.RECORD === "Arc"), owners = rows.filter(r => r.RECORD === "Component");
assert.equal(arcs.length, 3);
const centers = {};
for (const arc of arcs) {
  const ref = owners[Number(arc.COMPONENT)].SOURCEDESIGNATOR;
  centers[ref] = [ticks(arc["LOCATION.X"]), ticks(arc["LOCATION.Y"])];
  assert.deepEqual([ticks(arc.X),ticks(arc.Y)], centers[ref]);
  assert.deepEqual([ticks(arc.RADIUS),ticks(arc.WIDTH),+arc.STARTANGLE,+arc.ENDANGLE,arc.LAYER],
    [49213,98425,0,360,"TOPOVERLAY"]);
}
assert.deepEqual(centers, nativeArcs);

// Exercise a circular edge in the final position, where its second vertex is the closing row.
const design = A.project("Rounded", []), drawing = design.documents[1];
const shape = S.rect({x:3, y:-23, width:30, height:20, corners:{bl:{style:"radius",size:3}}});
const arcIndex = shape.contour.findIndex(g => g.kind === "arc");
shape.contour = [...shape.contour.slice(arcIndex + 1), ...shape.contour.slice(0,arcIndex + 1)];
S.apply(drawing, shape);
const curved = X.exportBoard(design, drawing), form = fields(curved.content)[0], n = shape.contour.length;
assert.equal(form["KIND" + (n - 1)], "1");
assert.deepEqual(vertex(form,n), vertex(form,0));
assert.equal(form["KIND" + n], "0");
const last = read(curved.content).documents[0].boardShape.contour.at(-1), edge = shape.contour.at(-1);
assert.equal(last.kind, "arc");
assert.deepEqual(toTicks(last.c), toTicks(edge.c));
assert.equal(Math.round(last.r / .00000254), Math.round(edge.r / .00000254));
assert.equal(A.arcSweep(last), A.arcSweep(edge));

// Board6 retains its explicit terminal point in the original binary geometry. Its zero-length
// edge must not become a second terminal row when that saved contour is written as native ASCII.
const boardData = Buffer.from(curved.content.split("\r\n")[0] + "\0"), header = Buffer.alloc(4);
header.writeUInt32LE(boardData.length);
const compoundBoard = AtriumPCB.read("Edges.PcbDoc", new Map([["board6/data", Buffer.concat([header,boardData])]]), null).documents[0];
assert.equal(compoundBoard.boardShape.contour.length,n+1);
const recovered = fields(X.exportBoard(design,compoundBoard).content)[0];
assert.equal(Object.keys(recovered).filter(k => /^VX\d+$/.test(k)).length,n+1);
for (let k=0;k<=n;k++) assert.deepEqual(vertex(recovered,k),vertex(form,k));
assert.equal(recovered["KIND" + (n - 1)], "1");

// An actual 2-tick final edge must survive the editor's coarser interactive snapping tolerance.
delete drawing.boardShape;
drawing.outline = [[0,0],[10,0],[10,-5],[0,-5],[0,-.00000508]];
const small = fields(X.exportBoard(design,drawing).content)[0];
assert.deepEqual([vertex(small,4),vertex(small,5)], [[0,2],[0,0]]);
// Designer 26 reopened these four tracks. Its native arc iterator reported the centers,
// radii and CCW sweeps below and normalized both full turns to 0..360 degrees.
const directed = A.project("Directed-Arc-Probe", []), probe = directed.documents[1];
S.apply(probe, S.rect({x:2,y:-25,width:40,height:22,corners:{bl:{style:"radius",size:3}}}));
const cases = [
  {c:[12,-12],r:3,  start:0,    end:90,   ccw:false,layer:"Top",    native:[4724409,4724409,1181102,90,360]},
  {c:[23,-13],r:4,  start:25,   end:190,  ccw:true, layer:"Bottom", native:[9055118,5118110,1574803,25,190]},
  {c:[31,-11],r:2.5,start:39.5, end:39.5, ccw:true, layer:"Top",    native:[12204724,4330709,984252,0,360]},
  {c:[33,-21],r:1,  start:271.5,end:271.5,ccw:false,layer:"Bottom", native:[12992126,8267717,393701,0,360]}
];
for (const {c,r,start,end,ccw,layer} of cases) {
  const arc = {kind:"arc",c,r,start,end,ccw};
  probe.items.push({id:A.id(),kind:"track",net:"",layer,width:.25,points:A.arcProjection(arc),arc});
}
const emitted = X.exportBoard(directed,probe), records = fields(emitted.content);
const physical = records.filter(r => r.RECORD === "Arc"), imported = read(emitted.content).documents[0].items;
assert.equal(physical.length,4);
for (const [n, g] of cases.entries()) {
  const row = physical[n], [x,y,r,start,end] = g.native, a = +row.STARTANGLE, b = +row.ENDANGLE;
  assert.deepEqual([ticks(row["LOCATION.X"]),ticks(row["LOCATION.Y"]),ticks(row.RADIUS),row.LAYER],[x,y,r,g.layer.toUpperCase()]);
  const sweep = ((b-a)%360+360)%360 || 360;
  assert.equal(sweep,end-start);
  if (sweep < 360) assert.equal(a,start);
  const saved = imported[n].arc;
  assert.deepEqual([saved.start%360,saved.end%360,saved.ccw],[g.start,g.end,g.ccw]);
}
const rounded = records[0];
assert.equal(rounded.KIND0,"1");
assert.deepEqual([ticks(rounded.CX0),ticks(rounded.CY0),ticks(rounded.R0),+rounded.SA0,+rounded.EA0],
  [1968504,11023622,1181102,180,270]);

console.log("PASS native Designer outline vertices, owned and directed arcs, earlier ASCII conventions and curved closing edges.");
