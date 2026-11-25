"use strict";
// Schematic ergonomics and import fidelity: bus syntax (D[0..7], KiCad groups USB{DP DM}),
// bus aliasing across sheets, bus-width ERC, sheet symbol drag-to-size with entry reflow,
// bus entries that meet the bus, Altium COMPONENTKIND / No ERC / harness notes (ERC and
// BOM), and Eagle normally closed solder jumpers as net ties. Synthetic data, plus snapshot
// assertions on the real designs cached by the importer validation when they are present
// (optional ATRIUM_TEST_FIXTURES directory; skipped when missing).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const m of ["model", "parts", "sch-objects", "sch-object-tools", "hierarchy", "multichannel", "messages", "erc", "net-ties", "bom", "board-shape", "board-shape-sources", "stackup", "polygon-pour",
  "sexpr", "import-kicad", "import-eagle", "import-easyeda", "import-link", "source-file", "sch-import", "altium-rules", "pcb-pours", "pcb-import", "io", "connectivity"])
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, S = AtriumSchObjects, H = AtriumHierarchy, E = AtriumERC;
const R = AtriumParts.catalogue.find(d => d.id === "std-r");
const add = (doc, item) => {doc.items.push(item); return item;};
const place = (doc, ref, x, y) => add(doc, {id:A.id(), kind:"part", def:R.id, ref, value:"10k", link:A.id(), x, y, angle:0, pinNets:{}});
const pin = (part, n) => A.pins(part, R, "schematic").find(p => p.number === String(n)).at;
const label = (doc, text, at) => add(doc, {id:A.id(), kind:"netlabel", x:at[0], y:at[1], text});

// 1. Bus syntax: vectors, KiCad groups (spaces or commas, vector members), widths, aliases.
{
  assert.deepEqual(S.busMembers("D[0..3]"), ["D0", "D1", "D2", "D3"]);
  assert.deepEqual(S.busMembers("D[3..1]"), ["D3", "D2", "D1"]);
  assert.deepEqual(S.busMembers("USB{DP DM}"), ["USB.DP", "USB.DM"]);
  assert.deepEqual(S.busMembers("I2C{SCL, SDA}"), ["I2C.SCL", "I2C.SDA"]);
  assert.deepEqual(S.busMembers("{TX RX}"), ["TX", "RX"]);
  assert.deepEqual(S.busMembers("M{A[0..1] CLK}"), ["M.A0", "M.A1", "M.CLK"]);
  assert.deepEqual(S.busMembers("NET1"), ["NET1"]);
  assert.ok(S.isBus("U{TX RX}") && S.isBus("D[0..7]") && !S.isBus("D7") && !S.isBus("{}"));
  assert.deepEqual([S.busWidth("D[0..7]"), S.busWidth("U{TX RX}"), S.busWidth("D0")], [8, 2, 1]);
  assert.deepEqual(S.busAlias("DQ[0..3]", "DPC[2..5]"), [["DQ2", "DPC2"], ["DQ3", "DPC3"]], "vectors alias by index");
  assert.deepEqual(S.busAlias("UART{TX RX}", "UART_TRG{RX TX}"), [["UART.TX", "UART_TRG.TX"], ["UART.RX", "UART_TRG.RX"]], "groups alias by member name");
  assert.deepEqual(S.busAlias("D[0..1]", "U{TX RX}"), [], "a vector and a group do not alias");
}

// 2. Two differently named buses drawn as one bus join their members across the hierarchy
//    (KiCad bus-to-bus renaming), for vectors and for groups.
function aliasProject() {
  const p = A.project("Bus alias", AtriumParts.catalogue), top = p.documents[0];
  p.documents = [top];
  const childA = A.sheet("schematic", "A"), childB = A.sheet("schematic", "B");
  p.documents.push(childA, childB);
  // Child A: port DQ[0..3] and member labels on resistor pins; child B: DPC[0..3] and a group.
  const ra = place(childA, "RA", 20, 0), rb = place(childB, "RB", 20, 0), rc = place(childB, "RC", 40, 0), rd = place(childA, "RD", 40, 0);
  add(childA, S.make("port", [0, 0], {text:"DQ[0..3]", io:"bidirectional"}));
  label(childA, "DQ1", pin(ra, 1));
  add(childB, S.make("port", [0, 0], {text:"DPC[0..3]", io:"bidirectional"}));
  label(childB, "DPC1", pin(rb, 1));
  add(childA, S.make("port", [0, 10], {text:"UART{TX RX}", io:"bidirectional"}));
  label(childA, "UART.TX", pin(rd, 1));
  add(childB, S.make("port", [0, 10], {text:"U2{TX RX}", io:"bidirectional"}));
  label(childB, "U2.TX", pin(rc, 1));
  const sa = add(top, S.make("sheetsymbol", [0, 0], {name:"A", sheet:childA.id, w:20.32, h:15.24, entries:[
    {id:"a1", name:"DQ[0..3]", side:"right", offset:5.08, io:"bidirectional"}, {id:"a2", name:"UART{TX RX}", side:"right", offset:10.16, io:"bidirectional"}]}));
  const sb = add(top, S.make("sheetsymbol", [60.96, 0], {name:"B", sheet:childB.id, w:20.32, h:15.24, entries:[
    {id:"b1", name:"DPC[0..3]", side:"left", offset:5.08, io:"bidirectional"}, {id:"b2", name:"U2{TX RX}", side:"left", offset:10.16, io:"bidirectional"}]}));
  const bus1 = add(top, S.make("bus", [0, 0], {points:[S.entryPoint(sa, sa.entries[0]), S.entryPoint(sb, sb.entries[0])]}));
  const bus2 = add(top, S.make("bus", [0, 0], {points:[S.entryPoint(sa, sa.entries[1]), [40.64, 10.16]]}));
  add(top, S.make("bus", [0, 0], {points:[[40.64, 10.16], S.entryPoint(sb, sb.entries[1])]})); // two segments meeting at a vertex
  p.erc = {version:1, scope:"hierarchical", checks:{}, matrix:{}};
  return {p, top, childA, childB, ra, rb, rc, rd, sa, sb, bus1, bus2};
}
{
  const t = aliasProject(), c = H.compile(t.p);
  const net = (doc, part, n) => c.netOf(doc.id, part.id, String(n));
  assert.ok(net(t.childA, t.ra, 1), "DQ1 is a net");
  assert.equal(net(t.childA, t.ra, 1), net(t.childB, t.rb, 1), "DQ1 (child A) joins DPC1 (child B) through the drawn bus");
  assert.equal(net(t.childA, t.rd, 1), net(t.childB, t.rc, 1), "UART.TX joins U2.TX through the drawn group bus");
  assert.notEqual(net(t.childA, t.ra, 1), net(t.childA, t.rd, 1));
  // Without the bus wire, they stay apart.
  t.top.items = t.top.items.filter(i => i !== t.bus1);
  const c2 = H.compile(t.p);
  assert.notEqual(c2.netOf(t.childA.id, t.ra.id, "1"), c2.netOf(t.childB.id, t.rb.id, "1"));
  assert.equal(S.busNetworks(t.top).length, 1, "the two group segments are one bus network");
}

// 3. ERC: mismatched bus widths on one bus, and between a sheet entry and its child port.
{
  const t = aliasProject();
  t.sb.entries[0].name = "DPC[0..7]";
  t.childB.items.find(i => i.text === "DPC[0..3]").text = "DPC[0..7]";
  let m = E.run(t.p).messages.filter(x => x.check === "busWidth");
  assert.equal(m.length, 1, "one bus carries DQ[0..3] and DPC[0..7]");
  assert.match(m[0].text, /DQ\[0\.\.3\] \(4\).*DPC\[0\.\.7\] \(8\)/);
  t.childB.items.find(i => i.text === "DPC[0..7]").text = "DPC[0..15]";
  m = E.run(t.p).messages.filter(x => x.check === "busWidth");
  assert.ok(m.some(x => /Sheet entry DPC\[0\.\.7\] on B is 8 wide; port DPC\[0\.\.15\] on B is 16/.test(x.text)), m.map(x => x.text).join("; "));
  assert.equal(E.CHECKS.find(x => x.id === "busWidth").level, "Warning");
  // Matching widths are clean.
  const ok = aliasProject();
  assert.equal(E.run(ok.p).messages.filter(x => x.check === "busWidth").length, 0);
}

// 4. Sheet symbol drag-to-size: 8 grips; far edges keep entries in place; shrinking reflows
//    them on the grid inside the side; the size never drops below what the entries need; cancel.
{
  const s = S.make("sheetsymbol", [0, 0], {name:"U", sheet:"", w:20.32, h:20.32, entries:[
    {id:"e1", name:"A", side:"left", offset:2.54, io:"input"}, {id:"e2", name:"B", side:"left", offset:12.7, io:"input"},
    {id:"e3", name:"C", side:"left", offset:17.78, io:"input"}, {id:"e4", name:"Y", side:"right", offset:5.08, io:"output"}]});
  assert.equal(S.grips(s).length, 8);
  assert.equal(S.resizeAt(s, [10, 10], 1), null, "no grip in the middle");
  let r = S.resizeAt(s, [20.32, 20.32], 1);
  assert.deepEqual([r.grip.u, r.grip.v], [1, 1]);
  r.move([30.48, 25.4]);
  assert.deepEqual([s.w, s.h], [30.48, 25.4]);
  assert.deepEqual(s.entries.map(e => e.offset), [2.54, 12.7, 17.78, 5.08], "growing keeps entries");
  r.move([30.48, 12.7]);
  assert.deepEqual([s.h], [12.7]);
  assert.deepEqual(s.entries.map(e => +e.offset.toFixed(2)), [2.54, 7.62, 10.16, 5.08], "shrinking reflows the left side in order, on the grid");
  r.move([30.48, 0]);
  assert.equal(s.h, 10.16, "never smaller than its entries need (3 left entries + 1 grid)");
  r.cancel();
  assert.deepEqual([s.x, s.y, s.w, s.h, s.entries.map(e => e.offset)], [0, 0, 20.32, 20.32, [2.54, 12.7, 17.78, 5.08]]);
  // The top-left grip moves the origin; entries keep their place on the sheet.
  r = S.resizeAt(s, [0, 0], 1);
  r.move([-5.08, -5.08]);
  assert.deepEqual([s.x, s.y, s.w, s.h], [-5.08, -5.08, 25.4, 25.4]);
  assert.deepEqual(S.entryPoint(s, s.entries[0]), [-5.08, 2.54], "entry A stays at its sheet position on the new left edge");
  // Text frames size too, without entries.
  const f = S.make("textframe", [0, 0], {w:10.16, h:5.08, text:"x"});
  S.resizeAt(f, [10.16, 5.08], .5).move([20.32, 7.62]);
  assert.deepEqual([f.w, f.h], [20.32, 7.62]);
  // Inspector-style height change reflows too.
  const g = S.make("sheetsymbol", [0, 0], {name:"V", w:20.32, h:20.32, entries:[{id:"x", name:"Q", side:"left", offset:17.78, io:"input"}]});
  g.h = 7.62; S.reflow(g);
  assert.equal(g.entries[0].offset, 5.08);
}

// 5. Place › Bus Entry meets the bus: it turns to reach the bus, or a click on the bus puts
//    the bus end there.
{
  const p = A.project("Entry", AtriumParts.catalogue), sch = p.documents[0];
  add(sch, S.make("bus", [0, 0], {points:[[0, 0], [0, 50.8]]}));
  const ctx = {doc:() => sch, project:() => p, edit:fn => fn(), info() {}, redraw() {}, draw() {}, setTool() {}, tool() {}};
  S.command("sch-bus-entry", ctx);
  const ghost = S.preview([2.54, 10.16]);
  assert.ok(A.nearSegment(S.busEntryEnd(ghost), [0, 0], [0, 50.8]) < 1e-6, "the far end lands on the bus: " + JSON.stringify(S.busEntryEnd(ghost)));
  const onBus = S.preview([0, 20.32]);
  assert.deepEqual(S.busEntryEnd(onBus).map(v => +v.toFixed(4)), [0, 20.32], "clicking on the bus keeps the bus end at the click");
  assert.ok(Math.abs(onBus.x) > 1, "the wire end is off the bus");
  S.cancel?.();
}

// 6. Altium: COMPONENTKIND, No ERC, buses, bus entries, sheet entries and harness notes.
//    Graphical and mechanical parts leave ERC and the BOM; net ties are ties; jumpers kept.
function altiumAscii() {
  const L = [];
  const r = o => L.push("|" + Object.entries(o).map(([k, v]) => k + "=" + v).join("|"));
  r({RECORD:31, FONTIDCOUNT:1, SIZE1:10, FONTNAME1:"Arial", SHEETSTYLE:0});
  const comp = (lib, kind, ref, x, pins) => {
    const at = L.length;
    r({RECORD:1, LIBREFERENCE:lib, ...(kind != null ? {COMPONENTKIND:kind} : {}), "LOCATION.X":x, "LOCATION.Y":500, CURRENTPARTID:1, DISPLAYMODE:0});
    pins.forEach((n, k) => r({RECORD:2, OWNERINDEX:at, OWNERPARTID:1, DESIGNATOR:n, NAME:"P" + n, "LOCATION.X":x + k * 30, "LOCATION.Y":500, PINLENGTH:10, ELECTRICAL:4, PINCONGLOMERATE:0}));
    r({RECORD:34, OWNERINDEX:at, NAME:"Designator", TEXT:ref, "LOCATION.X":x, "LOCATION.Y":520});
  };
  comp("Logo", 2, "LOGO1", 100, ["1"]);
  comp("Heatsink", 1, "HS1", 200, ["1", "2"]);
  comp("Res", null, "R1", 300, ["1", "2"]);
  comp("NetTie", 4, "NT1", 400, ["1", "2"]);
  comp("Jumper", 6, "W1", 500, ["1", "2"]);
  r({RECORD:18, NAME:"UART", HARNESSTYPE:"UART", "LOCATION.X":100, "LOCATION.Y":300, WIDTH:40, STYLE:0, IOTYPE:3});
  r({RECORD:22, "LOCATION.X":310, "LOCATION.Y":500}); // on R1 pin 1 (the pin end: location + length)
  r({RECORD:26, LOCATIONCOUNT:2, X1:100, Y1:200, X2:400, Y2:200});
  r({RECORD:25, TEXT:"D[0..3]", "LOCATION.X":150, "LOCATION.Y":200});
  r({RECORD:37, "LOCATION.X":200, "LOCATION.Y":190, "CORNER.X":210, "CORNER.Y":200});
  const sym = L.length;
  r({RECORD:15, "LOCATION.X":600, "LOCATION.Y":300, XSIZE:80, YSIZE:60});
  r({RECORD:32, OWNERINDEX:sym, TEXT:"Child"});
  r({RECORD:33, OWNERINDEX:sym, TEXT:"Child.SchDoc"});
  r({RECORD:16, OWNERINDEX:sym, NAME:"D[0..3]", SIDE:0, DISTANCEFROMTOP:2, IOTYPE:3});
  r({RECORD:16, OWNERINDEX:sym, NAME:"BUSH", SIDE:1, DISTANCEFROMTOP:3, IOTYPE:0, HARNESSTYPE:"SPI"});
  r({RECORD:215, "LOCATION.X":0, "LOCATION.Y":0});
  return L.join("\r\n");
}
{
  const res = AtriumSCH.read("Kinds.SchDoc", null, altiumAscii());
  const doc = res.documents[0], defs = new Map(res.library.map(d => [d.id, d]));
  const byRef = ref => doc.items.find(i => i.kind === "part" && i.ref === ref), kind = ref => defs.get(byRef(ref).def).componentKind || "standard";
  assert.deepEqual(["LOGO1", "HS1", "R1", "NT1", "W1"].map(kind), ["graphical", "mechanical", "standard", "netTieNoBom", "jumper"]);
  assert.equal(defs.get(byRef("NT1").def).symbol.netTie, true, "net tie kinds are net ties");
  assert.equal(S.componentKind(byRef("HS1"), defs.get(byRef("HS1").def)), "mechanical");
  assert.equal(S.componentKind({componentKind:"Net Tie (No BOM)"}), "netTieNoBom");
  assert.equal(S.componentKind({componentKind:2}), "graphical");
  const kinds = doc.items.reduce((m, i) => (m[i.kind] = (m[i.kind] || 0) + 1, m), {});
  assert.deepEqual([kinds.noerc, kinds.bus, kinds.busentry, kinds.sheetsymbol], [1, 1, 1, 1]);
  const sym = doc.items.find(i => i.kind === "sheetsymbol");
  assert.deepEqual([sym.name, sym.file, sym.entries.map(e => e.name + ":" + e.side)], ["Child", "Child.SchDoc", ["D[0..3]:left", "BUSH:right"]]);
  const notes = res.notes.join(" ");
  assert.match(notes, /Harnesses are not imported: 2 × harness ports and sheet entries \(UART, SPI\)/);
  assert.match(notes, /Omitted 1 × harness connectors/);
  assert.match(notes, /Component types kept for ERC and BOM: 1 × graphical, 1 × mechanical, 1 × net tie \(no BOM\), 1 × jumper/);
  // ERC: no pin messages for graphical or mechanical parts; R1 pin 1 has a No ERC marker.
  const p = A.project("Kinds"); p.documents = [doc]; p.library = res.library; A.validate(p);
  const msgs = E.run(p).messages;
  const pins = msgs.filter(m => /^(Unconnected|Floating input) pin/.test(m.text)).map(m => m.text.split(" ")[2]);
  assert.ok(!pins.some(t => /^(LOGO1|HS1)-/.test(t)), pins.join(","));
  assert.ok(pins.includes("R1-2") && !pins.includes("R1-1"), "R1-2 reported, R1-1 has a No ERC marker: " + pins.join(","));
  assert.ok(!msgs.some(m => /LOGO1/.test(m.text)), "graphical parts are not annotated, footprinted or netlisted");
  assert.ok(msgs.some(m => m.check === "importNotice" && /harness ports/.test(m.text)), "ERC says harnesses were not imported");
  // BOM: graphical, mechanical and net tie (no BOM) parts are left out.
  const c = AtriumBOM.collect(p, {source:"schematic"}), why = Object.fromEntries(c.excluded.map(e => [e.ref, e.reason]));
  assert.deepEqual(["LOGO1", "HS1", "NT1", "R1", "W1"].map(r => why[r] === "Not in BOM"), [true, true, true, false, false], JSON.stringify(why));
}

// 7. Eagle: normally closed solder jumpers (package copper joining pads) are net ties on the
//    schematic and the board; open jumpers and ordinary packages are not.
{
  const fx = n => fs.readFileSync(path.join(__dirname, "../fixtures/import", n), "utf8"), enc = new TextEncoder();
  const PKG = `<package name="SMT-JUMPER_2_NC_TRACE">
<smd name="1" x="-0.508" y="0" dx="0.635" dy="1.27" layer="1"/>
<smd name="2" x="0.508" y="0" dx="0.635" dy="1.27" layer="1"/>
<polygon width="0.0127" layer="1"><vertex x="-0.6985" y="0.127"/><vertex x="0.0254" y="0.127"/><vertex x="0.0254" y="-0.127"/><vertex x="-0.6985" y="-0.127"/></polygon>
<polygon width="0.0127" layer="1"><vertex x="-0.0254" y="0.127"/><vertex x="0.6985" y="0.127"/><vertex x="0.6985" y="-0.127"/><vertex x="-0.0254" y="-0.127"/></polygon>
</package>
<package name="SOLDERJUMPER_CLOSEDWIRE">
<smd name="1" x="-0.762" y="0" dx="1.1684" dy="1.6002" layer="1"/>
<smd name="2" x="0.762" y="0" dx="1.1684" dy="1.6002" layer="1"/>
<smd name="WIRE" x="0" y="0" dx="0.635" dy="0.2032" layer="1"/>
</package>
<package name="SMT-JUMPER_2_NO">
<smd name="1" x="-0.508" y="0" dx="0.635" dy="1.27" layer="1"/>
<smd name="2" x="0.508" y="0" dx="0.635" dy="1.27" layer="1"/>
</package>
`;
  const dev = (name, pkg) => `<deviceset name="${name}" prefix="SJ"><gates><gate name="G$1" symbol="R" x="0" y="0"/></gates><devices><device name="" package="${pkg}"><connects><connect gate="G$1" pin="1" pad="1"/><connect gate="G$1" pin="2" pad="2"/></connects><technologies><technology name=""/></technologies></device></devices></deviceset>\n`;
  let sch = fx("demo-eagle.sch").replace("</packages>", PKG + "</packages>").replace("</devicesets>", dev("JUMPER-SMT_2_NC_TRACE", "SMT-JUMPER_2_NC_TRACE") + dev("JUMPER-SMT_2_NO", "SMT-JUMPER_2_NO") + "</devicesets>")
    .replace("<parts>", '<parts>\n<part name="SJ1" library="atrium-test" deviceset="JUMPER-SMT_2_NC_TRACE" device=""/>\n<part name="SJ2" library="atrium-test" deviceset="JUMPER-SMT_2_NO" device=""/>')
    .replace("<instances>", '<instances>\n<instance part="SJ1" gate="G$1" x="80" y="50.8"/>\n<instance part="SJ2" gate="G$1" x="80" y="40.64"/>');
  let brd = fx("demo-eagle.brd").replace("</packages>", PKG + "</packages>")
    .replace("<elements>", '<elements>\n<element name="SJ1" library="atrium-test" package="SMT-JUMPER_2_NC_TRACE" value="" x="50" y="10"/>\n<element name="SJ3" library="atrium-test" package="SOLDERJUMPER_CLOSEDWIRE" value="" x="60" y="10"/>\n<element name="SJ2" library="atrium-test" package="SMT-JUMPER_2_NO" value="" x="70" y="10"/>')
    .replace('<signal name="SIG">', '<signal name="SIG">\n<contactref element="SJ1" pad="1"/><contactref element="SJ3" pad="1"/><contactref element="SJ2" pad="1"/>')
    .replace('<signal name="GND" class="1">', '<signal name="GND" class="1">\n<contactref element="SJ1" pad="2"/><contactref element="SJ3" pad="2"/><contactref element="SJ2" pad="2"/>');
  const [rs, rb] = AtriumImportFormats.readSet([{name:"j.sch", bytes:enc.encode(sch)}, {name:"j.brd", bytes:enc.encode(brd)}]);
  const sdefs = new Map(rs.library.map(d => [d.id, d])), bdefs = new Map(rb.library.map(d => [d.id, d]));
  const part = (r, ref) => r.documents.flatMap(d => d.items).find(i => i.kind === "part" && i.ref === ref);
  assert.deepEqual(sdefs.get(part(rs, "SJ1").def).symbol.netTieGroups, [["1", "2"]], "NC jumper symbol is a net tie");
  assert.ok(!sdefs.get(part(rs, "SJ2").def).symbol.netTie, "NO jumper is not a tie");
  assert.ok(!sdefs.get(part(rs, "R1").def).symbol.netTie, "ordinary parts are not ties");
  const f1 = bdefs.get(part(rb, "SJ1").def).footprint, f3 = bdefs.get(part(rb, "SJ3").def).footprint;
  assert.deepEqual([f1.netTie, f1.netTieGroups], [true, [["1", "2"]]], "two touching trace halves join the pads");
  assert.deepEqual([f3.netTie, f3.pads.map(q => q.number), f3.shapes.some(s => s.layer === "Top" && s.fill)], [true, ["1", "2"], true], "the bridge pad becomes tie copper");
  assert.ok(!bdefs.get(part(rb, "SJ2").def).footprint.netTie);
  assert.ok(rs.notes.some(n => /Normally closed solder jumpers import as net ties/.test(n)));
  // On the board, the closed jumpers' copper is an allowed short between SIG and GND.
  const board = rb.documents[0], shorts = AtriumConnectivity.inspect(board, bdefs).shorts;
  assert.ok(!shorts.some(s => /SJ[13]/.test(s.fromLabel + s.toLabel)), JSON.stringify(shorts.map(s => s.fromLabel + "~" + s.toLabel)));
}

// 8. KiCad: sheets always use hierarchical net scope now that bus groups expand.
{
  const enc = new TextEncoder(), fx = n => fs.readFileSync(path.join(__dirname, "../fixtures/import", n), "utf8");
  const [r] = AtriumImportFormats.readSet([{name:"root.kicad_sch", bytes:enc.encode(fx("root.kicad_sch").replace(/\(label "([^"]+)"/, '(label "G{A B}"'))}]);
  assert.equal(r.documents[0].netScope, "hierarchical");
  assert.ok(!r.notes.some(n => /bus groups/.test(n)));
}

// 9. Snapshots on real designs (when the importer validation's downloads are present).
const DL = process.env.ATRIUM_TEST_FIXTURES;
const SETS = {
  "kicad-video": "bus_pci.kicad_sch|esvideo.kicad_sch|graphic.kicad_sch|modul.kicad_sch|muxdata.kicad_sch|pal-ntsc.kicad_sch|rams.kicad_sch|video.kicad_pcb|video.kicad_pro|video.kicad_sch",
  "kicad-royalblue": "Connectors.kicad_sch|Debugger.kicad_sch|nPM1300.kicad_sch|nRF54L15.kicad_sch|RoyalBlue54L-Feather.kicad_pcb|RoyalBlue54L-Feather.kicad_pro|RoyalBlue54L-Feather.kicad_sch",
  "eagle-redboard-artemis": "RedBoard-Artemis.brd|RedBoard-Artemis.sch",
  "eagle-pyportal": "Adafruit PyPortal Pynt.brd|Adafruit PyPortal Pynt.sch",
  "eagle-thingplus-c6": "Thing_Plus_ESP32_C6.brd|Thing_Plus_ESP32_C6.sch",
  "altium-cubesat-eps": "buck_boost.SchDoc|EPS.PcbDoc|EPS.SchDoc|ideal_diode.SchDoc|main_connector.SchDoc|MPPT_charger.SchDoc|peripherals.SchDoc|uC.SchDoc",
};
function realSet(name) {
  if (!DL) return null;
  const files = SETS[name].split("|").map(f => path.join(DL, name, f));
  if (!files.every(f => fs.existsSync(f))) return null;
  const p = A.project(name); p.documents = []; p.library = []; p.importNotes = [];
  const alt = files.filter(f => /\.(schdoc|pcbdoc)$/i.test(f)), other = files.filter(f => !alt.includes(f));
  if (other.length) for (const r of AtriumImportFormats.readSet(other.map(f => ({name:path.basename(f), bytes:new Uint8Array(fs.readFileSync(f))})))) {
    p.documents.push(...r.documents); p.library.push(...r.library); p.importNotes.push(...(r.notes || []));
  }
  for (const f of alt) {const r = AtriumIO.read(path.basename(f), new Uint8Array(fs.readFileSync(f))); p.documents.push(...(r.documents || [])); p.library.push(...(r.library || [])); p.importNotes.push(...(r.notes || []));}
  AtriumImportLink.reconcile(p, p.documents); A.validate(p);
  const defs = new Map(p.library.map(d => [d.id, d])), c = H.compile(p, {defs}), sch = new Map();
  for (const n of c.nets) for (const q of n.pins) sch.set(q.ref + "." + q.pin.number, n.name);
  const board = p.documents.find(d => d.kind === "pcb"), b2s = new Map();
  for (const i of board?.items || []) if (i.kind === "part") for (const [n, net] of Object.entries(i.pinNets || {})) {
    const s = sch.get(i.ref + "." + n); if (!net || !s) continue;
    if (!b2s.has(net)) b2s.set(net, new Set()); b2s.get(net).add(s);
  }
  const ties = p.documents.flatMap(d => d.items.filter(i => i.kind === "part" && (defs.get(i.def)?.symbol?.netTie || defs.get(i.def)?.footprint?.netTie)).map(i => d.kind[0] + ":" + i.ref));
  return {p, defs, board, scope:c.effective, splits:[...b2s.values()].filter(v => v.size > 1).length, ties:ties.sort(),
    shorts:board ? AtriumConnectivity.inspect(board, defs).shorts.length : 0, notes:[...new Set(p.importNotes)]};
}
let real = 0;
{
  const v = realSet("kicad-video");
  if (v) {real++; assert.deepEqual([v.scope, v.splits], ["hierarchical", 0], "video: DQ/DPC bus renaming joins (66 split nets before)");
    assert.equal(E.run(v.p).messages.filter(m => m.check === "busWidth").length, 0, "video: renamed buses agree in width (DQ[0..31] on DPC[0..31], PCA[0..1] on PC_A[0..1])");}
  const r = realSet("kicad-royalblue");
  if (r) {real++; assert.deepEqual([r.scope, r.splits], ["hierarchical", 0], "RoyalBlue: UART{TX RX} on UART_TRG{TX RX} joins (4 split nets before)");}
  const e = realSet("eagle-redboard-artemis");
  if (e) {real++; assert.deepEqual(e.ties, ["p:JP16", "p:JP17", "s:JP16", "s:JP17"]); assert.equal(e.shorts, 2, "only the VDD track over JP17 remains");}
  const pp = realSet("eagle-pyportal");
  if (pp) {real++; assert.deepEqual([pp.ties.length, pp.shorts], [2, 1], "SJ4 (closed wire) is a tie; SJ1 is bridged by a board track");}
  const t = realSet("eagle-thingplus-c6");
  if (t) {real++; assert.equal(t.ties.filter(x => x.startsWith("s:")).length, 8, "every NC jumper on the schematic"); assert.equal(t.shorts, 0);}
  const cs = realSet("altium-cubesat-eps");
  if (cs) {real++; assert.ok(cs.notes.some(n => /Harnesses are not imported: 2 × harness ports and sheet entries \(UART\)/.test(n)), cs.notes.join(" | "));}
}
console.log("sch-bus-import: all checks passed" + (real ? " (" + real + " real designs)" : " (real designs not present; synthetic checks only)"));
