"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const {appFile} = require("../support/app-source-paths.cjs");
for (const name of ["model", "parts", "sch-objects", "sch-import", "source-file", "io", "spatial", "edit-selection"]) require(appFile(name + ".js"));

const A = Atrium, name = "Terminal drag.SchDoc";
const bytes = fs.readFileSync(path.join(__dirname, "../fixtures/altium/terminal-drag", name));
const position = i => [i.x, i.y];
function fixture() {
  const {documents: [doc], library} = AtriumIO.read(name, bytes);
  const defs = new Map(library.map(d => [d.id, d])), part = doc.items.find(i => i.ref === "R1");
  const def = defs.get(part.def), [leaf, branch] = doc.items.filter(i => i.kind === "wire");
  const [leafDot, branchDot] = doc.items.filter(i => i.kind === "junction");
  const pin = n => A.pins(part, def, doc.kind).find(p => p.number === String(n)).at;
  const nets = () => [1, 2].map(n => A.connectivity(doc, defs).byPin.get(part.id + "/" + n));
  const transform = props => A.transformPart(doc, part, def, props, undefined, {defs});
  return {doc, library, part, leaf, branch, leafDot, branchDot, pin, nets, transform};
}
const expected = ["LEAF", "BRANCH"];
{
  const {doc, library, part, leaf, branch, leafDot, branchDot, pin, nets, transform} = fixture();
  const original = A.clone(doc.items), origin = position(part), bend = position(branchDot);
  const unchanged = branch.points;
  assert.deepEqual(nets(), expected);
  // Off-grid translation and turning share the same attachment semantics as pointer drags.
  const touched = transform({x: origin[0] - 1.043, y: origin[1] + 2.364, angle: 90});
  assert.deepEqual(nets(), expected, "the moved terminal keeps both original nets");
  assert.equal(branch.points, unchanged, "both stationary arms retain their authored array");
  assert.deepEqual(position(branchDot), bend);
  assert.deepEqual(position(leafDot), pin(1), "a junction on a single outgoing arm follows the pin");
  assert.ok(A.same(leaf.points.at(-1), pin(1)));
  const leads = doc.items.filter(i => i.kind === "wire" && i !== leaf && i !== branch);
  assert.equal(leads.length, 1, "one lead stretches from the stationary junction");
  assert.deepEqual(leads[0].points[0], bend);
  assert.deepEqual(leads[0].points.at(-1), pin(2));
  assert.deepEqual(leads[0].schPaint, branch.schPaint, "the lead uses the imported wire pen");
  assert.deepEqual(new Set(touched), new Set([part, leaf, leafDot, ...leads]));
  assert.doesNotThrow(() => A.validate({...A.project("Terminal drag", library), documents: [doc]}));
  transform({x: origin[0], y: origin[1], angle: 0});
  assert.deepEqual(doc.items, original, "a later reverse move restores the complete imported geometry");
}
{
  const {doc, part, branch, branchDot, nets, transform} = fixture();
  const [a, b, c] = branch.points;
  branch.points = [a, b];
  const other = {id: A.id(), kind: "wire", points: [b, c]};
  doc.items.push(other);
  const at = position(branchDot);
  transform({x: part.x + 1.27, y: part.y + 3.81});
  assert.deepEqual(nets(), expected, "separate wire records at a junction also stay joined");
  assert.deepEqual(position(branchDot), at);
  assert.deepEqual(branch.points, [a, b]);
  assert.deepEqual(other.points, [b, c]);
  assert.equal(doc.items.filter(i => i.kind === "wire").length, 4);
}
{
  const {doc, part, branch, branchDot, nets, transform} = fixture();
  const [a, b] = branch.points;
  // The junction stays rooted if a named terminal is also parked there.
  branch.points = [a, b];
  doc.items.push({id: A.id(), kind: "power", x: b[0], y: b[1], text: "BRANCH"});
  transform({y: part.y + 5.08});
  assert.deepEqual(nets(), expected);
  assert.deepEqual(position(branchDot), b);
  assert.deepEqual(branch.points, [a, b]);
}
{
  const {doc, part, branch, nets, transform} = fixture();
  const before = doc.items.length, authored = branch.points;
  transform({x: part.x + 1.27});
  assert.deepEqual(nets(), expected);
  assert.equal(branch.points, authored);
  assert.equal(doc.items.length, before, "landing on a stationary arm adds no redundant lead");
}
{
  const def = AtriumParts.catalogue.find(d => d.id === "std-r");
  const project = A.project("Rotation", [def]), doc = project.documents[0], defs = new Map([[def.id, def]]);
  const part = A.instantiate(project, def, [0, 0]);
  const [a, b] = A.pins(part, def, doc.kind).map(pin => pin.at);
  const left = [a[0] - 10, a[1]], right = [b[0] + 10, b[1]];
  const first = {id: "input", kind: "wire", points: [a, left]};
  const second = {id: "output", kind: "wire", points: [b, right]};
  doc.items.push(part, first, second, {id: "IN", kind: "netlabel", x: left[0], y: left[1], text: "IN"},
    {id: "OUT", kind: "netlabel", x: right[0], y: right[1], text: "OUT"});
  const authored = A.clone([first.points, second.points]);
  const scripted=A.clone(doc), scriptedPart=scripted.items[0];
  for(const angle of [90,180]) A.transformPart(scripted,scriptedPart,def,{angle},undefined,{defs,avoidPinShorts:false});
  const scriptedRoute=scripted.items[1].points;
  assert.equal(scriptedRoute.length,2,"avoidPinShorts:false keeps the original straight route");
  assert.ok(A.same(scriptedRoute[0],A.pins(scriptedPart,def,doc.kind)[0].at));
  assert.ok(A.same(scriptedRoute[1],left));
  for (const angle of [90, 180, 270, 0]) {
    A.transformPart(doc, part, def, {angle}, undefined, {defs});
    assert.equal(part.angle, angle);
    const nets = A.connectivity(doc, defs);
    assert.deepEqual([1, 2].map(n => nets.byPin.get(part.id + "/" + n)), ["IN", "OUT"], `turn to ${angle}° preserves pin nets`);
    assert.ok(nets.nets.every(n => !n.conflict));
  }
  assert.deepEqual([first.points, second.points], authored, "a full turn restores the original routes");
}
{
  // A power port placed on a pin turns with it: a half turn puts pin 1 where GND sat.
  const def = AtriumParts.catalogue.find(d => d.id === "std-r");
  for (const lead of [[-10, 0], [0, -10]]) for (const angle of [90, 180, 270]) {
    const project = A.project("Rotation", [def]), doc = project.documents[0], defs = new Map([[def.id, def]]);
    const part = A.instantiate(project, def, [0, 0]);
    const [a, b] = A.pins(part, def, doc.kind).map(pin => pin.at), tail = [a[0] + lead[0], a[1] + lead[1]];
    const gnd = AtriumSchObjects.make("power", b, {text: "GND"});
    doc.items.push(part, {id: "input", kind: "wire", points: [a, tail]}, gnd, {id: "IN", kind: "netlabel", x: tail[0], y: tail[1], text: "IN"});
    const moved = A.transformPart(doc, part, def, {angle}, undefined, {defs});
    const nets = A.connectivity(doc, defs), where = `${angle}° with the lead ${lead}`;
    assert.deepEqual([1, 2].map(n => nets.byPin.get(part.id + "/" + n)), ["IN", "GND"], `turn to ${where} keeps both pin nets`);
    assert.ok(nets.nets.every(n => !n.conflict), `turn to ${where} joins no nets`);
    assert.deepEqual([gnd.x, gnd.y], A.pins(part, def, doc.kind)[1].at, "GND stays on pin 2");
    assert.ok(moved.includes(gnd), "the transform reports the moved port");
  }
  // A port that also meets a wire stays, and a lead joins it to the moved pin.
  const project = A.project("Rotation", [def]), doc = project.documents[0], defs = new Map([[def.id, def]]);
  const part = A.instantiate(project, def, [0, 0]), b = A.pins(part, def, doc.kind)[1].at;
  const gnd = AtriumSchObjects.make("power", b, {text: "GND"});
  doc.items.push(part, gnd, {id: "spur", kind: "wire", points: [b, [b[0], b[1] + 10]]});
  A.transformPart(doc, part, def, {angle: 90}, undefined, {defs});
  assert.deepEqual([gnd.x, gnd.y], b, "a shared port stays");
  assert.equal(A.connectivity(doc, defs).byPin.get(part.id + "/2"), "GND");
}
{
  // Detached wire copies (Properties rotation, AI drafts) keep the taps along them through a
  // turn, as attached wires do: no turn of R1 or R2 in the example joins or splits a net.
  const groups = (items, defs) => {
    const c = A.connectivity({kind: "schematic", items}, defs), nets = new Map();
    for (const [pin, net] of c.byPin) {if (!nets.has(net)) nets.set(net, []); nets.get(net).push(pin);}
    return [...nets.values()].map(pins => pins.sort().join(" ")).sort();
  };
  for (const ref of ["R1", "R2"]) for (const angle of [90, 180, 270]) {
    const project = AtriumParts.example(), doc = project.documents.find(d => d.kind === "schematic");
    const defs = new Map(project.library.map(d => [d.id, d])), part = doc.items.find(i => i.ref === ref), def = defs.get(part.def);
    const pins = new Set(A.pins(part, def, doc.kind).map(p => A.pointKey(p.at)));
    const copies = doc.items.filter(i => i.kind === "wire" && [i.points[0], i.points.at(-1)].some(p => pins.has(A.pointKey(p)))).map(i => ({...i}));
    const authored = JSON.stringify(doc.items), before = groups(doc.items, defs);
    const changed = A.transformPart(doc, {...part}, def, {angle}, copies, {defs});
    assert.equal(JSON.stringify(doc.items), authored, "the transform writes only to the copies");
    const byId = new Map(changed.map(i => [i.id, i]));
    assert.deepEqual(groups(doc.items.map(i => byId.get(i.id) || i), defs), before, `${ref} turned to ${angle}° keeps every net`);
  }
}
{
  // A group gesture on a dense sheet keeps its captured contacts through every pointer frame.
  const {library, part} = fixture(), doc = A.sheet("schematic", "Dense sheet"), selected = [];
  const defs = new Map(library.map(d => [d.id, d])), def = defs.get(part.def);
  const wire = points => ({id: A.id(), kind: "wire", points});
  const count = 32;
  for (let n = 0; n < count; n++) {
    const item = {...part, id: A.id(), x: 40 * n, y: 0};
    selected.push(item);
    const [a, b] = A.pins(item, def, doc.kind).map(p => p.at);
    doc.items.push(item, wire([[a[0] - 8, a[1]], a]), wire([[b[0] + 8, b[1]], b, [b[0], b[1] - 6]]),
      {id: A.id(), kind: "junction", x: b[0], y: b[1]});
  }
  const farWires = Array.from({length: 6000}, (_, n) => wire([[n, 160], [n, 165]]));
  doc.items.push(...farWires);
  const index = AtriumSpatial.create(doc.items, i => A.bounds(A.itemPoints(i, defs.get(i.def), doc.kind)));
  const before = doc.items.length;
  let queries = 0, scanned = 0;
  doc.items = new Proxy(doc.items, {get(items, key) {
    if (typeof key === "string" && /^\d+$/.test(key)) scanned++;
    return items[key];
  }});
  const drag = AtriumEditSelection.translation(doc, defs, selected, {query(box) {queries++; return index.query(box);}});
  const captureQueries = queries;
  assert.ok(captureQueries > 0 && captureQueries <= count * 4, "capture uses a bounded number of spatial queries per pin and wire");
  assert.equal(scanned, 0, "spatial capture reads no objects by scanning the sheet");
  for (let n = 1; n <= 80; n++) drag.apply(.2, .25 + n / 20);
  assert.equal(queries, captureQueries, "the 80 preview moves reuse their captured contacts");
  assert.equal(scanned, 0, "preview never scans the sheet");
  assert.equal(doc.items.length, before + count, "each stationary branch gets a lead exactly once");
  assert.equal(drag.affected.length, count * 3);
  drag.apply(0, 0);
  assert.equal(drag.finish(), true);
  assert.equal(doc.items.length, before);
  assert.equal(scanned, before + count, "removing all collapsed leads requires at most one pass");
}
console.log("PASS imported schematic drag keeps terminal dots, stationary branches and named nets through off-grid translation, rotation and return");
console.log("PASS 32-component drag on a 6,128-object sheet reuses spatial capture through 80 preview moves");
