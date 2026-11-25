"use strict";
// Schematic place objects (sch-objects.js): stored formats and validation, connectivity
// through power ports and ports, buses, No ERC, hop-overs, part parameters, ERC, BOM,
// KiCad export and the placement tool state machine. Needs the sch-integration patches
// (model.js connectivity and validation hooks).
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "sch-object-tools", "hierarchy", "erc", "messages", "bom", "kicad-export", "kicad-schematic"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, S = AtriumSchObjects, E = AtriumERC;
const R = AtriumParts.catalogue.find(d => d.id === "std-r");
const defsFor = p => new Map(p.library.map(d => [d.id, d]));
function blank(name = "SCH") {const p = A.project(name, AtriumParts.catalogue); return {p, sch:p.documents[0], pcb:p.documents[1]};}
function place(doc, ref, x, y) {const part = {id:A.id(), kind:"part", def:R.id, ref, value:"10k", link:A.id(), x, y, angle:0, pinNets:{}}; doc.items.push(part); return part;}
const pin = (part, n) => A.pins(part, R, "schematic").find(p => p.number === String(n)).at;
const add = (doc, item) => {doc.items.push(item); return item;};

// 1. Every new kind validates, round-trips through JSON and keeps old projects valid.
{
  const {p, sch} = blank();
  add(sch, S.make("power", [0, 0], {text:"GND", style:"gnd"}));
  add(sch, S.make("power", [10, 0], {text:"+3V3", style:"bar"}));
  add(sch, S.make("port", [20, 0], {text:"SDA", io:"bidirectional"}));
  add(sch, S.make("offsheet", [30, 0], {text:"CLK"}));
  add(sch, S.make("sheetsymbol", [40, 0], {name:"U_Power", sheet:"", entries:[{id:"e1", name:"VIN", side:"left", offset:2.54, io:"input"}]}));
  add(sch, S.make("bus", [0, 0], {points:[[0, 20], [20, 20]]}));
  add(sch, S.make("busentry", [5, 22.54], {}));
  add(sch, S.make("noerc", [50, 50]));
  add(sch, S.make("textframe", [0, 40], {w:20, h:10, text:"Hello world", note:true}));
  add(sch, S.make("image", [30, 40], {w:10, h:10, src:"data:image/png;base64,iVBORw0KGgo="}));
  sch.hopOvers = true;
  A.validate(A.clone(p));
  const bad = (mutate, why) => {const q = A.clone(p); mutate(q.documents[0]); assert.throws(() => A.validate(q), /Invalid Waffle editor model/, why);};
  bad(d => {d.items[0].style = "lightning";}, "unknown power style");
  bad(d => {d.items[0].direction = 5;}, "power direction");
  bad(d => {d.items[2].io = "sideways";}, "port io");
  bad(d => {d.items[4].entries[0].side = "inside";}, "entry side");
  bad(d => {d.items[5].points = [[0, 0]];}, "bus needs two points");
  bad(d => {d.items[9].src = "javascript:alert(1)";}, "images are data URLs");
  bad(d => {d.hopOvers = "yes";}, "hopOvers is boolean");
  bad(d => {d.items.push({id:"bad", kind:"harness", x:0, y:0});}, "unknown kinds stay invalid");
  // Older projects without any of these fields still validate.
  A.validate(AtriumParts.example());
}

// 2. Power ports are global net names: separate resistors joined only by GND ports.
{
  const {p, sch} = blank();
  const r1 = place(sch, "R1", 0, 0), r2 = place(sch, "R2", 30, 0);
  add(sch, S.make("power", pin(r1, 2), {text:"GND", style:"gnd"}));
  add(sch, S.make("power", pin(r2, 2), {text:"GND", style:"gnd"}));
  add(sch, S.make("port", pin(r1, 1), {text:"IN", io:"input"}));
  const c = A.connectivity(sch, defsFor(p));
  assert.equal(c.byPin.get(r1.id + "/2"), "GND");
  assert.equal(c.byPin.get(r2.id + "/2"), "GND");
  assert.equal(c.byPin.get(r1.id + "/1"), "IN");
  // The ERC graph sees the same nets as Atrium.connectivity.
  const g = E.graph(sch, defsFor(p));
  assert.deepEqual([...g.byPin].sort(), [...c.byPin].sort());
  assert.deepEqual(g.nets.map(n => [n.name, n.pins.length]), c.nets.map(n => [n.name, n.pins]));
  // Across sheets: a power port on another sheet joins the same net in the project compile.
  const other = A.sheet("schematic", "Two"); p.documents.push(other);
  const r3 = place(other, "R3", 0, 0); add(other, S.make("power", pin(r3, 1), {text:"GND", style:"gnd"}));
  const h = AtriumHierarchy.compile(p, {scope:"hierarchical"});
  assert.equal(h.netOf(other.id, r3.id, "1"), "GND");
  assert.equal(h.nets.find(n => n.name === "GND").pins.length, 3, "power ports are global in every scope");
  // BOM and the part list ignore power ports.
  const bom = AtriumBOM.collect(p);
  assert.deepEqual(bom.parts.map(e => e.item.ref).sort(), ["R1", "R2", "R3"]);
}

// 3. Bus labels do not name nets; bus members connect by name.
{
  const {p, sch} = blank();
  add(sch, S.make("bus", [0, 0], {points:[[0, 0], [20, 0]]}));
  add(sch, {id:A.id(), kind:"netlabel", x:5, y:0, text:"D[0..7]"});
  const r = place(sch, "R1", 40, 40);
  add(sch, {id:A.id(), kind:"netlabel", x:pin(r, 1)[0], y:pin(r, 1)[1], text:"D0"});
  const c = A.connectivity(sch, defsFor(p));
  assert.ok(!c.nets.some(n => n.name === "D[0..7]"));
  assert.equal(c.byPin.get(r.id + "/1"), "D0");
  assert.deepEqual(S.busMembers("D[0..3]"), ["D0", "D1", "D2", "D3"]);
  assert.deepEqual(S.busMembers("A[2..0]"), ["A2", "A1", "A0"]);
  assert.equal(S.isBus("D[0..7]"), true); assert.equal(S.isBus("D0"), false);
  // Bus entries geometry: 45° from the wire end to the bus.
  assert.deepEqual(S.busEntryEnd({x:0, y:0, angle:0}).map(v => +v.toFixed(4)), [2.54, -2.54]);
}

// 4. No ERC suppresses violations at its point; floating power ports are reported.
{
  const {p, sch} = blank();
  const r = place(sch, "R1", 0, 0);
  add(sch, S.make("noerc", pin(r, 1)));
  add(sch, S.make("power", [60, 60], {text:"VCC", style:"bar"}));
  const w = add(sch, {id:A.id(), kind:"wire", points:[pin(r, 2), [pin(r, 2)[0] + 10, pin(r, 2)[1]]]});
  add(sch, S.make("noerc", w.points[1]));
  const result = E.run(p);
  const texts = result.messages.map(m => m.text);
  assert.ok(!texts.some(t => /Unconnected pin R1-1/.test(t)), "No ERC on pin 1");
  assert.ok(!texts.some(t => /Unconnected wire end/.test(t)), "No ERC on the wire end");
  assert.ok(texts.some(t => /Floating power object VCC/.test(t)));
}

// 5. Hop-overs: an unjoined crossing hops; a junction or a shared point does not.
{
  const {sch} = blank();
  const h = add(sch, {id:"h", kind:"wire", points:[[0, 0], [20, 0]]});
  add(sch, {id:"v", kind:"wire", points:[[10, -10], [10, 10]]});
  add(sch, {id:"t", kind:"wire", points:[[15, 0], [15, 10]]});   // a T on h: no hop
  assert.equal(S.hops(sch), null, "off by default");
  sch.hopOvers = true;
  let map = S.hops(sch, true);
  assert.deepEqual([...map].map(([k, xs]) => [k, xs]), [["h/1", [10]]]);
  add(sch, {id:A.id(), kind:"junction", x:10, y:0});
  map = S.hops(sch, true);
  assert.equal(map.size, 0, "a junction joins the crossing");
  void h;
}

// 6. Part parameters: stored on the part, read by the BOM, visibility toggles.
{
  const {p, sch} = blank();
  const r = place(sch, "R1", 0, 0);
  r.parameters = {MPN:"RC0603FR-0710KL", Manufacturer:"Yageo"};
  r.paramShow = {MPN:true};
  A.validate(p);
  const entry = AtriumBOM.collect(p).parts.find(e => e.item === r || e.item?.id === r.id);
  assert.equal(entry.params.MPN, "RC0603FR-0710KL");
  assert.deepEqual(S.shownParams(r), ["MPN"]);
  const q = A.clone(p); q.documents[0].items[0].paramShow = {MPN:"yes"};
  assert.throws(() => A.validate(q), /Invalid Waffle editor model/);
}

// 7. Placement tool state machine (headless editor context).
{
  const {p, sch} = blank();
  let tool = "select";
  const ctx = {project:() => p, doc:() => sch, edit:fn => fn(), info() {}, draw() {}, setTool:t => {S.cancel(); tool = t;}, choose() {}, selectDocument() {}};
  S.command("sch-bus", ctx);
  assert.equal(tool, "sch-place");
  S.click([0, 0]); S.click([10, 5]);
  assert.equal(S.preview([20, 5]).kind, "bus");
  assert.equal(S.finish(), true);
  const bus = sch.items.find(i => i.kind === "bus");
  assert.deepEqual(bus.points, [[0, 0], [10, 0], [10, 5]], "orthogonal corners like wires");
  S.command("sch-noerc", ctx); S.click([3, 3]);
  assert.ok(sch.items.some(i => i.kind === "noerc" && i.x === 3));
  S.command("sch-rect", ctx); S.click([0, 0]); S.click([10, 8]);
  const rect = sch.items.find(i => i.kind === "graphic" && i.closed);
  assert.equal(rect.points.length, 5);
  S.command("sch-arc", ctx); S.click([0, 0]); S.click([5, 0]); S.click([0, -5]);
  const arc = sch.items.filter(i => i.kind === "graphic").at(-1);
  assert.deepEqual(arc.points[0], [5, 0]); assert.deepEqual(arc.points.at(-1).map(v => Math.round(v)), [0, -5]);
  S.command("sch-bus-entry", ctx); S.rotate(1); S.click([2, 2]);
  assert.equal(sch.items.find(i => i.kind === "busentry").angle, 90);
  A.validate(p);
}

// 8. Sheet entries follow the child's ports; sync adds new ones and reports orphans.
{
  const {p, sch} = blank();
  const child = A.sheet("schematic", "Power"); p.documents.push(child);
  add(child, S.make("port", [0, 0], {text:"VIN", io:"input"}));
  add(child, S.make("port", [0, 5], {text:"VOUT", io:"output"}));
  const sym = S.make("sheetsymbol", [0, 0], {name:"U_Power", sheet:child.id});
  sym.entries = S.layoutEntries(S.portsOf(child)); S.fitSymbol(sym); add(sch, sym);
  assert.deepEqual(sym.entries.map(e => [e.name, e.side, e.io]), [["VIN", "left", "input"], ["VOUT", "right", "output"]]);
  add(child, S.make("port", [0, 10], {text:"EN", io:"input"}));
  sym.entries.push({id:"x", name:"OLD", side:"left", offset:20, io:"unspecified"});
  const r = S.syncEntries(sym, child);
  assert.deepEqual(r.added, ["EN"]); assert.deepEqual(r.unmatched, ["OLD"]);
  assert.deepEqual(S.entryPoint(sym, sym.entries[0]), [0, sym.entries[0].offset]);
  A.validate(p);
}

// 9. KiCad export maps power ports, ports, sheets, buses, No ERC and text frames.
{
  const {p, sch} = blank();
  const child = A.sheet("schematic", "Power"); p.documents.push(child);
  const r = place(sch, "R1", 0, 0);
  add(sch, S.make("power", pin(r, 2), {text:"GND", style:"gnd"}));
  add(sch, S.make("port", [40, 40], {text:"SDA", io:"bidirectional"}));
  add(sch, S.make("sheetsymbol", [60, 0], {name:"U_Power", sheet:child.id, entries:[{id:"e", name:"VIN", side:"left", offset:2.54, io:"input"}]}));
  add(sch, S.make("bus", [0, 0], {points:[[0, 50], [20, 50]]}));
  add(sch, S.make("busentry", [5, 52.54], {}));
  add(sch, S.make("noerc", pin(r, 1)));
  add(sch, S.make("textframe", [0, 60], {w:20, h:10, text:"Note"}));
  const out = AtriumKiCadSchematic.exportSheet(p, sch);
  const text = out.content;
  for (const needle of ['(lib_id "Atrium_Power:GND_gnd")', '(power)', '(global_label "SDA" (shape bidirectional)', '(sheet (at',
    '(property "Sheetfile" "Power.kicad_sch"', '(pin "VIN" input', '(bus (pts', '(bus_entry (at', '(no_connect (at', '(text_box "Note"'])
    assert.ok(text.includes(needle), "KiCad output has " + needle);
  assert.ok(!out.diagnostics.some(d => /Unsupported sheet item/.test(d)));
  // On the child, ports become hierarchical labels.
  add(child, S.make("port", [0, 0], {text:"VIN", io:"input"}));
  assert.ok(AtriumKiCadSchematic.exportSheet(p, child).content.includes('(hierarchical_label "VIN" (shape input)'));
}
{
  require("../../app/editor/edit-selection.js");
  const {p,sch}=blank("Move sheet symbol"), child=A.sheet("schematic","Child");
  p.documents.push(child);
  const symbol=add(sch,S.make("sheetsymbol",[0,0],{w:20.32,h:15.24,name:"Child",sheet:child.id,
    entries:[{id:"e",name:"VIN",side:"left",offset:5.08,io:"input"}]}));
  const entry=S.entryPoint(symbol,symbol.entries[0]);
  const wire=add(sch,{id:A.id(),kind:"wire",points:[entry,[entry[0]-10,entry[1]]]});
  add(sch,{id:A.id(),kind:"netlabel",x:entry[0]-10,y:entry[1],text:"VIN_PARENT"});
  const part=place(child,"R1",5.08,0);
  add(child,S.make("port",[0,0],{text:"VIN",io:"input"}));
  add(child,{id:A.id(),kind:"wire",points:[[0,0],pin(part,1)]});
  const defs=defsFor(p);
  const net=()=>AtriumHierarchy.compile(p,{defs,scope:"hierarchical"}).netOf(child.id,part.id,"1");
  assert.equal(net(),"VIN_PARENT");
  const drag=AtriumEditSelection.translation(sch,defs,[symbol]);
  drag.apply(10,0);drag.finish();
  assert.equal(net(),"VIN_PARENT","moving a sheet symbol keeps its entry connected");
  assert.ok(wire.points.some(at=>A.same(at,S.entryPoint(symbol,symbol.entries[0]))));
}
console.log("sch-objects: all checks passed");
