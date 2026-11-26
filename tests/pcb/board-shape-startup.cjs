"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const app = path.join(__dirname, "../../app");
const read = name => String(fs.readFileSync(require("../support/app-source-paths.cjs").appFileFrom(app, name), "utf8"));
const evaluate = (context, code) => vm.runInContext(code, context);
const load = (context, files) => files.forEach(name => evaluate(context, read(name)));
const eager = [...read("index.html").matchAll(/<script src="((?:pcb\/)?board-shape[^"]*)"><\/script>/g)].map(match => match[1]);
const modules = ["uuid-v7.js", "model.js", "pcb-appearance.js", "spatial.js", "connectivity.js", "canvas.js"];
const makeContext = shapeFiles => {
  const context = vm.createContext({console, performance: {now: () => 0}, setTimeout, clearTimeout, __waffleUUIDSeed: "dafedcafba0123456789"});
  load(context, ["lazy.js", ...shapeFiles, ...modules]);
  return context;
};

const fullContext = makeContext(eager);
load(fullContext, evaluate(fullContext, 'AtriumLazy.files("AtriumBoardShape")'));
const fixture = evaluate(fullContext, `(() => {
  const A = Atrium, S = AtriumBoardShape, p = A.project("Native outline"), d = p.documents.find(d => d.kind === "pcb");
  const shape = S.rect({x: 0, y: 20, width: 40, height: 20, corners: {tl: {style: "radius", size: 5}}});
  const hole = [S.arc([20, 10], 4, 0, 0, false)];
  S.apply(d, {...shape, cutouts: [hole]}, "altium");
  // Native outlines may carry unfamiliar metadata. Validation and painting only read it.
  d.boardShape.retained = {version: 7, value: "untouched"};
  d.origin = [5, 11];
  const track = {id: A.id(), kind: "track", layer: "Top", net: "SIG", width: .2, points: [[6, 10], [35, 10]]};
  const via = {id: A.id(), kind: "via", layer: "Multi", net: "SIG", diameter: .8, drill: .3, x: 20, y: 10};
  const region = S.circle(4, [8, 4]), points = S.flattenContour(region.contour);
  const graphic = {id: A.id(), kind: "graphic", layer: "Top", width: 0, fill: true, closed: true, points,
    regionShape: {...region, sig: S.signature(points)}};
  d.items.push(track, via, graphic);
  return JSON.stringify(p);
})()`);

const inspect = context => JSON.parse(evaluate(context, `(() => {
  const A = Atrium, S = AtriumBoardShape, p = JSON.parse(${JSON.stringify(fixture)}), d = p.documents.find(d => d.kind === "pcb");
  const clone = A.clone(p), invalid = clone.documents.find(d => d.kind === "pcb");
  invalid.boardShape.contour[0].kind = "future segment";
  let rejected = false;
  try { A.validate(clone); } catch { rejected = true; }
  A.validate(p);
  const freeze = value => {
    if (value && typeof value === "object") {Object.values(value).forEach(freeze);Object.freeze(value);}
    return value;
  };
  freeze(p);
  const paint = [];
  const ctx = new Proxy({}, {get: (c, name) => c[name] ?? ((...args) => {
    if (["beginPath", "moveTo", "lineTo", "arc", "closePath", "fill", "stroke"].includes(name)) paint.push([name, ...args]);
  })});
  const canvas = {getContext: () => ctx, getBoundingClientRect: () => ({width: 800, height: 600})};
  const view = AtriumCanvas.create(canvas);
  view.restoreCamera({cx: 20, cy: 10, scale: 12, referenceScale: 12});
  const defs = new Map();
  view.render(d, defs, {grid:false, origin:false});
  const graph = AtriumConnectivity.inspectFull(d, defs);
  const stale = {...d, outline: [[0,0], [0,8], [7,8], [7,0]]};
  const unchecked = {...d, boardShape: {...d.boardShape, sig: undefined}};
  const moved = A.clone(d.items[2]);
  A.moveItem(moved, 3, -4);
  return JSON.stringify({
    rejected, paint, arcs: paint.filter(step => step[0] === "arc"), evenOdd: paint.some(step => step[0] === "fill" && step[1] === "evenodd"),
    exactRegion: !!AtriumPCBAppearance.curvedRegion(d.items[2]), shiftedRegion: S.regionOf(moved)?.contour,
    selected: view.hit(d, defs, [8, 4])?.id, expected: d.items[2].id,
    graph: {nets:graph.nets, airwires:graph.airwires, excluded:graph.excluded},
    stale: S.holes(stale), fresh: S.fresh(unchecked) === unchecked.boardShape,
    roundTrip: S.fromUser(d, S.toUser(d, [9, 14])), retained: d.boardShape.retained
  });
})()`));

const boot = makeContext(eager);
assert.equal(boot.AtriumGeometryCurves, undefined, "Welcome leaves the physical sampler unloaded");
// The editor and native owner reader await boardRenderers before installing
// the document. Resolve just its shape dependency here so both paint runs
// use the same other modules.
const shapeDemand = evaluate(boot, `AtriumLazy.boardRenderers(JSON.parse(${JSON.stringify(fixture)}))
  .filter(name => name === "AtriumGeometryCurves")`);
assert.deepEqual(Array.from(shapeDemand), ["AtriumGeometryCurves"], "the opened cutout requests physical geometry");
load(boot, evaluate(boot, `AtriumLazy.files(${JSON.stringify(shapeDemand)})`));
assert.equal(boot.AtriumBoardShapeAuthoring, undefined, "first paint does not load outline authoring");
const oracle = inspect(fullContext);
const result = inspect(boot);
assert.deepEqual(result, oracle, "the first render and physical graph match the full shape library");
assert.equal(result.rejected, true, "native validation must reject unrecognized geometry");
assert.equal(result.evenOdd, true);
assert.ok(result.arcs.length >= 5, "paint traces the rounded perimeter, circular cutout and curved copper region");
assert.equal(result.graph.excluded, 1, "the via lies in the cutout");
assert.equal(result.selected, result.expected, "the curved copper region is selectable immediately");
assert.equal(result.exactRegion, true);
assert.deepEqual(result.shiftedRegion[0].c, [11, 0]);
assert.deepEqual(result.stale, []);
assert.equal(result.fresh, true);
assert.deepEqual(result.roundTrip, [9, 14]);
assert.deepEqual(result.retained, {version:7, value:"untouched"});
console.log("PASS first board paint, cutout connectivity, hit, and native validation match the full shape library");

async function shapeBeforeItsStyle() {
  const calls = [], api = {
    open: () => { calls.push("open"); return "dialog"; },
    properties: () => { calls.push("properties"); }
  };
  let sheet;
  fullContext.document = {
    createElement: () => ({}),
    head: {append(node) {
      if (node.href === "pcb/board-shape.css") { sheet = node; return; }
      if (node.src === "pcb/board-shape-ui.js") fullContext.AtriumBoardShapeUI = api;
      else load(fullContext, [node.src]);
      node.onload();
    }}
  };
  const loadUI = fullContext.AtriumLazy.need("AtriumBoardShapeUI");
  assert.equal(fullContext.AtriumBoardShapeUI, api);
  assert.ok(sheet && fullContext.AtriumLazy.pending("AtriumBoardShapeUI"));
  const shape = fullContext.AtriumBoardShape;
  const opening = shape.open({});
  shape.properties({replaceChildren() {}}, {});
  shape.properties({isConnected:false, replaceChildren() {}}, {});
  assert.deepEqual(calls, [], "direct dialog and inspector entries wait while the style is in flight");
  sheet.onerror(); // Preserve usable controls if a stylesheet cannot be read.
  await loadUI;
  assert.equal(await opening, "dialog");
  assert.deepEqual(calls, ["open", "properties"]);
  assert.equal(shape.open({}), "dialog", "a settled UI still opens synchronously");
  console.log("PASS direct Board Shape dialog and inspector wait for their shared startup stylesheet");
}
globalThis.__testDone = shapeBeforeItsStyle();
globalThis.__testDone.catch(error => { console.error(error); process.exitCode = 1; });
