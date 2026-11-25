"use strict";
// Repeat placement, auto-increment and mirror X/Y on schematics (sch-place.js). Needs the
// schplace integration patches (model.js world() honours part.mirror; sch-objects.js keeps
// the tool armed without a dialog and exposes the floating object).
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "sch-object-tools", "hierarchy", "kicad-export", "kicad-schematic", "sch-place"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, S = AtriumSchObjects, P = AtriumSchPlace;
const R = AtriumParts.catalogue.find(d => d.id === "std-r"), C = AtriumParts.catalogue.find(d => d.id === "std-c");
const defsFor = p => new Map(p.library.map(d => [d.id, d]));
function blank() {const p = A.project("SCH", AtriumParts.catalogue); return {p, sch:p.documents[0]};}
const pinAt = (part, def, n) => A.pins(part, def, "schematic").find(q => q.number === String(n)).at.map(v => +v.toFixed(4));
const near = (a, b, msg) => assert.ok(Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6, msg + ": " + JSON.stringify(a) + " vs " + JSON.stringify(b));

// 1. Names step on their trailing number; buses and plain names stay.
{
  assert.equal(P.increment("R1"), "R2"); assert.equal(P.increment("D0"), "D1"); assert.equal(P.increment("NET_A1"), "NET_A2");
  assert.equal(P.increment("D09"), "D10"); assert.equal(P.increment("C7", 3), "C10"); assert.equal(P.increment("A0", -5), "A0");
  assert.equal(P.increment("GND"), "GND"); assert.equal(P.increment("D[0..7]"), "D[0..7]");
  assert.equal(P.nextFree("R1", new Set(["R1", "R2"])), "R3"); assert.equal(P.nextFree("TP", new Set()), "TP1");
}

// 2. Parts: designators auto-increment from the next free one, or from a typed designator.
{
  const {p, sch} = blank();
  P.setPrefs({autoIncrement:true, step:1});
  P.beginPart(C);
  const placed = [];
  for (let n = 0; n < 3; n++) {
    assert.equal(P.ghostPart(C, p).ref, "C" + (n + 1), "ghost shows the next designator");
    const part = P.decorate(A.instantiate(p, C, [n * 10, 0]), C, p); sch.items.push(part); placed.push(part.ref);
  }
  assert.deepEqual(placed, ["C1", "C2", "C3"], "three clicks place C1-C3");
  // Tab: a typed designator continues from itself (R10, R11) and the comment applies to every copy.
  P.beginPart(R); P.setTemplate({ref:"R10", value:"4k7"});
  assert.equal(P.ghostPart(R, p).ref, "R10");
  for (let n = 0; n < 2; n++) sch.items.push(P.decorate(A.instantiate(p, R, [n * 10, 20]), R, p));
  assert.deepEqual(sch.items.filter(i => i.def === R.id).map(i => i.ref + "=" + i.value), ["R10=4k7", "R11=4k7"]);
  // A typed designator already in use moves on to the next free one.
  P.beginPart(R); P.setTemplate({ref:"R10"});
  assert.equal(P.ghostPart(R, p).ref, "R12");
  // Choosing another component starts afresh from its next free designator.
  assert.equal(P.ghostPart(C, p).ref, "C4");
  P.setPrefs({autoIncrement:false});
  P.beginPart(R);
  assert.equal(P.ghostPart(R, p).ref, "R?", "auto-increment off leaves parts unannotated");
  P.setPrefs({autoIncrement:true});
  A.validate(A.clone(p));
}

// 3. Net labels, ports and off sheet connectors step; power ports keep the net.
{
  const {p, sch} = blank();
  const log = [];
  const ctx = {edit:fn => fn(), doc:() => sch, info:t => log.push(t)};
  P.setLabel("D0");
  for (let n = 0; n < 3; n++) P.placeLabel([n * 5, 0], ctx);
  assert.deepEqual(sch.items.filter(i => i.kind === "netlabel").map(i => i.text), ["D0", "D1", "D2"], "label D0 repeats as D1, D2");
  assert.equal(P.labelGhost([0, 0]).text, "D3");
  P.setLabel("NET_A1"); P.placeLabel([0, 5], ctx); assert.equal(P.label(), "NET_A2");
  // The schematic object tool: no dialog, stays armed, increments ports, remembers power.
  let tool = "select";
  const sctx = {project:() => p, doc:() => sch, edit:fn => fn(), info() {}, draw() {}, setTool:t => {S.cancel(); tool = t;}, choose() {}, selectDocument() {}};
  S.command("sch-port", sctx);
  assert.equal(tool, "sch-place", "port placement starts at once (no modal dialog)");
  S.click([0, 20]); S.click([0, 25]); S.click([0, 30]);
  assert.deepEqual(sch.items.filter(i => i.kind === "port").map(i => i.text), ["PORT1", "PORT2", "PORT3"]);
  S.command("sch-power", sctx);
  S.floating().opts.text = "+3V3"; S.floating().opts.style = "bar"; // Tab popover preset
  S.click([20, 0]); S.click([30, 0]);
  assert.deepEqual(sch.items.filter(i => i.kind === "power").map(i => i.text), ["+3V3", "+3V3"], "power ports keep their net");
  S.command("sch-power", sctx);
  assert.equal(S.floating().opts.text, "+3V3", "the next power port session starts with the last net");
  S.cancel();
  A.validate(p);
}

// 4. Mirror X keeps wires on the pins, and connectivity follows the mirrored pins.
{
  const {p, sch} = blank(), defs = defsFor(p);
  const r = A.instantiate(p, R, [10, 10]); sch.items.push(r);
  const p1 = pinAt(r, R, 1), p2 = pinAt(r, R, 2);
  const w1 = {id:A.id(), kind:"wire", points:[p1, [p1[0], p1[1] + 10]]};
  const w2 = {id:A.id(), kind:"wire", points:[p2, [p2[0], p2[1] - 10]]};
  sch.items.push(w1, w2,
    {id:A.id(), kind:"netlabel", x:w1.points[1][0], y:w1.points[1][1], text:"LEFT"},
    {id:A.id(), kind:"netlabel", x:w2.points[1][0], y:w2.points[1][1], text:"RIGHT"});
  const before = A.connectivity(sch, defs);
  assert.equal(before.byPin.get(r.id + "/1"), "LEFT");
  assert.equal(P.mirrorItems(sch, defs, new Set([r.id]), "x"), 1);
  assert.equal(r.mirror, true); assert.equal(r.x, 10); assert.equal(r.y, 10);
  near(pinAt(r, R, 1), [2 * 10 - p1[0], p1[1]], "pin 1 mirrored about the origin");
  near(w1.points[0], pinAt(r, R, 1), "wire 1 still ends on pin 1");
  near(w2.points[0], pinAt(r, R, 2), "wire 2 still ends on pin 2");
  const after = A.connectivity(sch, defs);
  assert.equal(after.byPin.get(r.id + "/1"), "LEFT", "pin 1 keeps its net through the re-routed wire");
  assert.equal(after.byPin.get(r.id + "/2"), "RIGHT");
  // Mirroring twice restores the part exactly (no mirror flag stored).
  P.mirrorItems(sch, defs, new Set([r.id]), "x");
  assert.equal(r.mirror, undefined); near(pinAt(r, R, 1), p1, "double mirror restores pin 1");
  A.validate(A.clone(p));
}

// 4b. In-line wires: the pins swap sides, so the wires loop around instead of shorting.
{
  const {p, sch} = blank(), defs = defsFor(p);
  const r = A.instantiate(p, R, [10, 10]); sch.items.push(r);
  const p1 = pinAt(r, R, 1), p2 = pinAt(r, R, 2);
  sch.items.push({id:A.id(), kind:"wire", points:[p1, [p1[0] - 10, p1[1]]]}, {id:A.id(), kind:"wire", points:[p2, [p2[0] + 10, p2[1]]]},
    {id:A.id(), kind:"netlabel", x:p1[0] - 10, y:p1[1], text:"IN"}, {id:A.id(), kind:"netlabel", x:p2[0] + 10, y:p2[1], text:"OUT"});
  P.mirrorItems(sch, defs, [r.id], "x");
  const c = A.connectivity(sch, defs);
  assert.equal(c.byPin.get(r.id + "/1"), "IN"); assert.equal(c.byPin.get(r.id + "/2"), "OUT", "no short after mirroring an in-line part");
  assert.ok(!c.nets.some(n => n.conflict), "no net joins IN and OUT");
}

{
  const {p, sch} = blank(), defs = defsFor(p);
  const r = A.instantiate(p, R, [0, 0]);
  const p1 = pinAt(r, R, 1), p2 = pinAt(r, R, 2), tail = [p1[0] - 10, p1[1]];
  const w = {id:A.id(), kind:"wire", points:[p1, tail]};
  const power = S.make("power", p2, {text:"GND", style:"gnd"});
  sch.items.push(r, w, power, {id:A.id(), kind:"netlabel", x:tail[0], y:tail[1], text:"IN"});
  const pinNets = () => {
    const c = A.connectivity(sch, defs);
    assert.ok(c.nets.every(n => !n.conflict), "no net joins IN and GND");
    return [1, 2].map(n => c.byPin.get(r.id + "/" + n));
  };
  assert.deepEqual(pinNets(), ["IN", "GND"]);
  const scripted = A.clone(sch);
  P.mirrorItems(scripted, defs, [r.id], "x");
  const originalPower = scripted.items.find(i => i.id === power.id);
  assert.deepEqual([originalPower.x, originalPower.y], p2, "a programmatic mirror leaves an unselected port in place");
  const touched = new Set(), options = {avoidPinShorts:true};
  assert.equal(P.mirrorItems(sch, defs, [r.id], "x", undefined, touched, options), 1);
  assert.equal(r.mirror, true);
  assert.deepEqual(pinNets(), ["IN", "GND"]);
  assert.deepEqual([power.x, power.y], pinAt(r, R, 2));
  assert.deepEqual(w.points.at(-1), tail);
  assert.deepEqual(touched, new Set([r, w, power]));
  P.mirrorItems(sch, defs, [r.id], "x", undefined, undefined, options);
  assert.deepEqual(pinNets(), ["IN", "GND"]);
  assert.deepEqual(w.points, [p1, tail]);
  assert.deepEqual([power.x, power.y], p2);
}

// 5. Mirror Y on a rotated part flips on screen; X then Y equals a half turn.
{
  const {p, sch} = blank(), defs = defsFor(p);
  const r = A.instantiate(p, R, [0, 0], 90); sch.items.push(r);
  const p1 = pinAt(r, R, 1);
  P.mirrorItems(sch, defs, [r.id], "y");
  near(pinAt(r, R, 1), [p1[0], -p1[1]], "Y mirrors the screen vertically");
  P.mirrorItems(sch, defs, [r.id], "x");
  assert.equal(!!r.mirror, false); assert.equal(r.angle, 270, "X after Y is a 180° turn");
  near(pinAt(r, R, 1), [-p1[0], -p1[1]], "half turn");
}

// 6. Graphics, power ports, ports, sheet symbols and bus entries mirror about the selection centre.
{
  const {p, sch} = blank(), defs = defsFor(p);
  const line = {id:A.id(), kind:"graphic", points:[[0, 0], [10, 0], [10, 5]]};
  const pw = S.make("power", [0, 10], {text:"VCC", style:"bar", direction:0});
  const port = S.make("port", [10, 10], {text:"IO", io:"input"});
  const be = S.make("busentry", [5, 5], {angle:0});
  sch.items.push(line, pw, port, be);
  P.mirrorItems(sch, defs, new Set([line.id, pw.id, port.id, be.id]), "x", [5, 0]);
  assert.deepEqual(line.points, [[10, 0], [0, 0], [0, 5]]);
  assert.equal(pw.x, 10); assert.equal(pw.direction, 2, "a right-pointing power port now points left");
  assert.equal(port.x, 0); assert.equal(port.angle, 180);
  const end = S.busEntryEnd(be);
  assert.equal(be.angle, 270); near(end, [5 - 2.54, 5 - 2.54], "bus entry end mirrored");
  const ss = S.make("sheetsymbol", [0, 0], {w:20, h:10, name:"U_A", sheet:"", entries:[{id:"e", name:"A", side:"left", offset:2.54, io:"input"}, {id:"t", name:"B", side:"top", offset:5, io:"input"}]});
  sch.items.push(ss);
  P.mirrorItems(sch, defs, [ss.id], "x", [0, 0]);
  assert.equal(ss.x, -20); assert.equal(ss.entries[0].side, "right"); assert.equal(ss.entries[1].offset, 15);
  A.validate(A.clone(p));
}

// 7. Floating objects and the part ghost mirror while placing.
{
  const {p, sch} = blank();
  const sctx = {project:() => p, doc:() => sch, edit:fn => fn(), info() {}, draw() {}, setTool:() => S.cancel(), choose() {}, selectDocument() {}};
  S.command("sch-port", sctx);
  assert.equal(P.mirrorFloating("x"), true); assert.equal(S.preview([0, 0]).angle, 180);
  S.command("sch-power", sctx); S.floating().opts.style = "bar"; S.floating().direction = 1;
  P.mirrorFloating("y"); assert.equal(S.preview([0, 0]).direction, 3, "Y flips an up power port down");
  S.cancel();
  P.beginPart(R);
  assert.equal(P.mirrorGhost("x", 90), 270); assert.equal(P.ghostPart(R, p).mirror, true);
  const part = P.decorate(A.instantiate(p, R, [0, 0], 270), R, p);
  assert.equal(part.mirror, true, "the placed part keeps the ghost's mirror");
}

// 8. KiCad export draws a mirrored symbol with its own embedded library entry.
{
  const {p, sch} = blank();
  const a = A.instantiate(p, R, [0, 0]); sch.items.push(a);
  const b = A.instantiate(p, R, [20, 0]); sch.items.push(b);
  P.mirrorItems(sch, defsFor(p), [b.id], "x");
  const out = AtriumKiCadSchematic.exportSheet(p, sch.id).content;
  const libs = new Set(out.match(/\(symbol "[^"\s]+_[0-9a-f]{8}"/g) || []);
  assert.equal(libs.size, 2, "plain and mirrored resistors get their own embedded symbols");
}
console.log("PASS sch-place: auto-increment, repeat placement, mirror X/Y with connected wires");
