"use strict";
// Dynamic symbols (dynamic-symbol.js): a placeholder connector gains a pin where a wire meets
// its body edge, pins take net-label names, rename and reorder in place, the header footprint
// follows the pin count, and freeze() turns it into a normal library symbol.
// Fixture: synthetic, built in the test.
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "library-panel", "footprint-wizard", "dynamic-symbol"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, DS = AtriumDynamicSymbol;
const near = (a, b) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;

const p = A.project("Dynamic", []), sch = p.documents[0];
const {def, part} = DS.place(p, sch, [20.3, 20.4]);
assert.ok(DS.isDynamic(def) && def.dynamic.pins.length === 0);
assert.deepEqual([part.x, part.y], [20.32, 20.32], "placed on the 2.54 mm grid");
assert.equal(part.ref, "J1");
assert.equal(def.footprint.pads.length, 1, "a one-pin header until pins exist");
A.validate(p);
const wire = (...pts) => { const w = {id: A.id(), kind: "wire", points: pts}; sch.items.push(w); return w; };
const defs = () => new Map(p.library.map(d => [d.id, d]));

// 1. A wire ending on the left edge adds pin 1 there; its net label names it.
const [x0, y0, x1, y1] = def.dynamic.body;
assert.ok(x0 < 0 && y0 < 0 && x1 > 0 && y1 > 0);
const leftX = part.x + x0, rightX = part.x + x1;
wire([5.08, 17.78], [leftX, 17.78]);
sch.items.push({id: A.id(), kind: "netlabel", text: "SDA", x: 7.62, y: 17.78});
assert.equal(DS.settle(p, sch) > 0, true);
assert.equal(def.dynamic.pins.length, 1);
let pin = def.symbol.pins[0];
assert.equal(pin.number, "1"); assert.equal(pin.name, "SDA", "named from the net label");
assert.equal(pin.orientation, "left");
assert.ok(near(A.pins(part, def, "schematic")[0].at, [leftX, 17.78]), "the pin tip sits on the wire end");
assert.equal(A.connectivity(sch, defs()).byPin.get(part.id + "/1"), "SDA", "the wire connects to the new pin");
assert.equal(DS.settle(p, sch), 0, "settling again changes nothing");

// 2. An unlabeled wire on the right edge: sequential name; the footprint tracks the count.
const w2 = wire([rightX, 22.86], [35.56, 22.86]);
DS.settle(p, sch);
assert.deepEqual(def.dynamic.pins.map(x => [x.number, x.name, x.orientation]), [["1", "SDA", "left"], ["2", "2", "right"]]);
assert.equal(def.footprint.pads.length, 2, "1×2 header");
assert.match(def.footprint.name, /^HDRV2/, "IPC wizard header family");
// A label added later renames the auto-named pin.
sch.items.push({id: A.id(), kind: "netlabel", text: "SCL", x: 30.48, y: 22.86});
DS.settle(p, sch);
assert.equal(def.dynamic.pins[1].name, "SCL");
// Wire ends inside the body, at a corner or away from it add nothing.
wire([leftX, part.y + y0], [leftX - 5, part.y + y0]);   // corner
wire([part.x, part.y], [part.x + 1.27, part.y]);       // inside
DS.settle(p, sch);
assert.equal(def.dynamic.pins.length, 2);

// 3. Rename and reorder in place (wires stay where they are).
DS.rename(p, def.id, "2", "CLK");
assert.equal(def.dynamic.pins.find(x => x.number === "2").name, "CLK");
assert.ok(!def.dynamic.pins.find(x => x.number === "2").auto, "a renamed pin keeps its name");
DS.reorder(p, def.id, ["2", "1"]);
assert.deepEqual(def.dynamic.pins.map(x => [x.number, x.name]), [["1", "CLK"], ["2", "SDA"]]);
assert.ok(near([def.dynamic.pins[0].x, def.dynamic.pins[0].y], [x1, 22.86 - part.y]), "the renumbered pin keeps its position");
assert.equal(A.connectivity(sch, defs()).byWire.get(w2.id), "SCL", "the wire is still connected");
DS.setRows(p, def.id, 2);
assert.equal(def.footprint.pads.length, 2); assert.match(def.footprint.name, /2X1/);
A.validate(p);

// 4. Rotated parts: the edge is found in symbol coordinates.
{
  const q = A.project("Rot", []), s = q.documents[0], r = DS.place(q, s, [0, 0], {height: 4});
  r.part.angle = 90;
  // Left edge (x = x0) of a part turned 90° lies along y = x0 in world coordinates.
  const e = A.world([r.def.dynamic.body[0], 0], r.part);
  s.items.push({id: A.id(), kind: "wire", points: [[e[0], e[1] - 5.08], e]});
  DS.settle(q, s);
  assert.equal(r.def.dynamic.pins.length, 1);
  assert.equal(r.def.dynamic.pins[0].orientation, "left");
}

// 5. Many pins grow the body; the pin limit holds.
{
  const q = A.project("Grow", []), s = q.documents[0], r = DS.place(q, s, [0, 0], {height: 2});
  const b0 = r.def.dynamic.body.slice();
  for (let i = 0; i < 6; i++) {
    const b = r.def.dynamic.body, y = b[1] + 2.54 * (i + 1);
    if (y >= b[3]) break;
    s.items.push({id: A.id(), kind: "wire", points: [[b[0] - 5.08, y], [b[0], y]]});
    DS.settle(q, s);
  }
  assert.ok(r.def.dynamic.body[3] > b0[3], "the body grew downward to keep a free slot");
  assert.ok(r.def.dynamic.pins.length >= 2);
}

// 6. Freeze: a normal library symbol with the same pins, through AtriumLibrary.replaceDef.
const frozen = DS.freeze(p, def.id);
assert.equal(frozen.id, def.id);
const lib = p.library.find(d => d.id === def.id);
assert.equal(lib.dynamic, undefined);
assert.equal(lib.name, "Connector 2 pins");
assert.deepEqual(lib.symbol.pins.map(x => [x.number, x.name]), [["1", "CLK"], ["2", "SDA"]]);
assert.equal(AtriumLibrary.validateDef(lib).ok, true, AtriumLibrary.validateDef(lib).errors.join("; "));
assert.equal(A.connectivity(sch, defs()).byPin.get(part.id + "/2"), "SDA", "connections survive the freeze");
DS.settle(p, sch);
assert.equal(lib.symbol.pins.length, 2, "a frozen symbol no longer grows");
assert.throws(() => DS.rename(p, def.id, "1", "X"), /not a dynamic connector/);
A.validate(p);

// 7. Headless (MCP run_command dynamic_symbol / list_dynamic_connectors).
{
  const q = A.project("Headless", []);
  let r = DS.headless(q, {op: "place", x: 10, y: 10});
  assert.equal(r.designator, "J1"); assert.equal(r.dynamic, true);
  const b = q.library[0].dynamic.body;
  q.documents[0].items.push({id: A.id(), kind: "wire", points: [[10 + b[0] - 5, 10.16], [10.16 + b[0], 10.16]]});
  r = DS.headless(q, {op: "settle"});
  assert.equal(r.connectors[0].pins.length, 1);
  r = DS.headless(q, {op: "rename", designator: "J1", number: "1", name: "TX"});
  assert.equal(r.pins[0].name, "TX");
  r = DS.headless(q, {op: "freeze", designator: "J1"});
  assert.equal(r.dynamic, false);
  assert.deepEqual(DS.headless(q, {op: "list"}).connectors, []);
  assert.throws(() => DS.headless(q, {op: "freeze", def_id: "nope"}), /not a dynamic connector/);
}

// The real editor's active- and background-sheet settle paths run in scripts/test-undo-editor.cjs.
console.log("dynamic symbols ok");
