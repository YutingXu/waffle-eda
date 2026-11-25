"use strict";
// Importer regressions found by importing real open-source designs.
// Every document here is a small synthetic reproduction of a pattern seen in those designs, written
// for this test; no third-party design content is copied.
const assert = require("node:assert/strict");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "board-shape-sources", "stackup", "polygon-pour", "kicad-export", "sexpr", "import-kicad", "import-eagle", "import-easyeda", "net-intent", "signals", "rules", "import-link"])
  require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, I = AtriumImportFormats, enc = new TextEncoder();
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const nearP = (p, q, tol = 1e-3) => !!p && near(p[0], q[0], tol) && near(p[1], q[1], tol);
const file = (name, text) => ({name, bytes: typeof text === "string" ? enc.encode(text) : text});
const valid = rs => { const p = A.project("Real"); p.documents = rs.flatMap(r => r.documents); p.library = rs.flatMap(r => r.library); AtriumImportLink.reconcile(p, p.documents); A.validate(p); return p; };
const defsOf = rs => new Map(rs.flatMap(r => r.library).map(d => [d.id, d]));
const pin = (doc, defs, ref, n, kind = "schematic") => {
  for (const part of doc.items.filter(i => i.kind === "part" && i.ref === ref)) {
    const hit = A.pins(part, defs.get(part.def), kind).find(q => q.number === n);
    if (hit) return hit;
  }
  return null;
};

// ------------------------------------------------------------------ 1. Eagle
// SparkFun/Adafruit boards: wires end on pins of MR90/MR270 instances only under "rotate, then
// mirror X"; pins that touch pins name a net with no wire; a pin can connect several pads; a
// radius-0 circle is a dot; clearances differ per object pair.
{
  const lib = `<library name="L"><packages><package name="P"><smd name="1" x="-1" y="0" dx="0.6" dy="1" layer="1"/><smd name="2" x="1" y="0" dx="0.6" dy="1" layer="1"/>
<smd name="3" x="0" y="1.5" dx="0.6" dy="0.6" layer="1"/><circle x="-2" y="1" radius="0" width="0.4" layer="21"/></package></packages>
<symbols><symbol name="R"><pin name="1" x="-5.08" y="0" length="short"/><pin name="2" x="5.08" y="0" length="short" rot="R180"/><circle x="0" y="2" radius="0" width="0.5" layer="94"/></symbol></symbols>
<devicesets><deviceset name="R" prefix="R"><gates><gate name="G$1" symbol="R" x="0" y="0"/></gates><devices><device name="" package="P">
<connects><connect gate="G$1" pin="1" pad="1 3"/><connect gate="G$1" pin="2" pad="2"/></connects></device></devices></deviceset></devicesets></library>`;
  const part = n => `<part name="${n}" library="L" deviceset="R" device="" value="1k"/>`;
  const inst = (n, x, y, rot) => `<instance part="${n}" gate="G$1" x="${x}" y="${y}"${rot ? ` rot="${rot}"` : ""}/>`;
  const sch = `<?xml version="1.0"?><eagle version="9.6.2"><drawing><schematic><libraries>${lib}</libraries>
<parts>${["R1", "R2", "R3", "R4"].map(part).join("")}</parts><sheets><sheet><instances>
${inst("R1", 50.8, 50.8, "MR90")}${inst("R2", 101.6, 50.8, "MR270")}${inst("R3", 0, 0)}${inst("R4", 10.16, 0)}</instances><nets>
<net name="A" class="0"><segment><wire x1="50.8" y1="45.72" x2="40.64" y2="45.72" width="0.1524" layer="91"/><pinref part="R1" gate="G$1" pin="1"/></segment></net>
<net name="B" class="0"><segment><wire x1="101.6" y1="55.88" x2="111.76" y2="55.88" width="0.1524" layer="91"/><pinref part="R2" gate="G$1" pin="1"/></segment></net>
<net name="N$9" class="0"><segment><pinref part="R3" gate="G$1" pin="2"/><pinref part="R4" gate="G$1" pin="1"/></segment></net>
</nets></sheet></sheets></schematic></drawing></eagle>`;
  const rs = I.readSet([file("real.sch", sch)]), doc = rs[0].documents[0], defs = defsOf(rs);
  valid(rs);
  // Rotate by θ, then mirror X: MR90 takes (-5.08, 0) to (0, -5.08); MR270 takes it to (0, 5.08). Waffle Y is down.
  assert.ok(nearP(pin(doc, defs, "R1", "1").at, [50.8, -45.72]), "MR90 pin on its wire end");
  assert.ok(nearP(pin(doc, defs, "R2", "1").at, [101.6, -55.88]), "MR270 pin on its wire end");
  const cn = A.connectivity(doc, defs), net = (ref, n) => cn.byPin.get(doc.items.find(i => i.ref === ref).id + "/" + n);
  assert.equal(net("R1", "1"), "A");
  assert.equal(net("R2", "1"), "B");
  assert.equal(net("R3", "2"), "N$9", "pin-to-pin segment keeps the Eagle net name");
  assert.equal(net("R4", "1"), "N$9");
  const def = defs.get(doc.items.find(i => i.ref === "R1").def);
  assert.deepEqual(def.symbol.pins.map(p => p.number).sort(), ["1", "2", "3"], "pin 1 connects pads 1 and 3");
  assert.ok(nearP(pin(doc, defs, "R1", "3").at, pin(doc, defs, "R1", "1").at), "stacked pin for the extra pad");
  assert.ok(def.symbol.shapes.some(s => s.kind === "circle" && near(s.r, .25) && s.fill), "radius-0 circle is a dot of its width");

  const brd = `<?xml version="1.0"?><eagle version="9.6.2"><drawing><board><plain/><libraries>${lib}</libraries>
<designrules name="d"><param name="mdWireWire" value="8mil"/><param name="mdWirePad" value="6mil"/><param name="mdSmdSmd" value="7mil"/></designrules>
<elements><element name="R1" library="L" package="P" value="1k" x="10" y="10" rot="MR90"/></elements><signals/></board></drawing></eagle>`;
  const rb = I.readSet([file("real.brd", brd)]), board = rb[0].documents[0], bdefs = defsOf(rb);
  const rp = valid(rb);
  // Pad 1 (-1, 0) of an MR90 element: rotate to (0, -1), mirror X: (0, -1) → (10, 9) Eagle, (10, -9) Waffle.
  assert.ok(nearP(pin(board, bdefs, "R1", "1", "pcb").at, [10, -9]));
  assert.ok(near(AtriumRules.stored(board, rp).defaults.clearance, .1524), "smallest Eagle clearance (6 mil wire-pad)");
  assert.ok(bdefs.get(board.items.find(i => i.ref === "R1").def).footprint.shapes.some(s => s.kind === "circle" && near(s.r, .2) && s.fill));
  console.log("PASS Eagle real-file patterns: MR90/MR270 pins, pin-to-pin nets, multi-pad pins, dots, clearances");
}

// ------------------------------------------------------------------ 2. KiCad
// KiCad demos (StickHub, RoyalBlue54L): a two-pin symbol at 270° with (mirror x) is rotated, then
// mirrored; board pad nets fix which pin is which. Escaped names ({slash}) are the same net as
// the plain text, and "unconnected-(…)" pad nets are no net.
{
  const sym = `(symbol "Device:D" (in_bom yes) (on_board yes)
    (property "Reference" "D" (at 0 2 0) (effects (font (size 1.27 1.27))))
    (property "Value" "D" (at 0 -2 0) (effects (font (size 1.27 1.27))))
    (symbol "D_1_1"
      (pin passive line (at -3.81 0 0) (length 2.54) (name "K" (effects (font (size 1.27 1.27)))) (number "1" (effects (font (size 1.27 1.27)))))
      (pin passive line (at 3.81 0 180) (length 2.54) (name "A" (effects (font (size 1.27 1.27)))) (number "2" (effects (font (size 1.27 1.27)))))))`;
  const place = (ref, x, y, a, mirror) => `(symbol (lib_id "Device:D") (at ${x} ${y} ${a})${mirror ? ` (mirror ${mirror})` : ""} (unit 1) (in_bom yes) (on_board yes)
    (uuid "00000000-0000-4000-8000-0000000000${ref.slice(1).padStart(2, "0")}")
    (property "Reference" "${ref}" (at ${x} ${y} 0) (effects (font (size 1.27 1.27))))
    (property "Value" "D" (at ${x} ${y} 0) (effects (font (size 1.27 1.27)))))`;
  const sch = `(kicad_sch (version 20231120) (generator "eeschema") (uuid "00000000-0000-4000-8000-000000000000") (paper "A4")
  (lib_symbols ${sym})
  ${place("D1", 100, 50, 270, "x")} ${place("D2", 120, 50, 90, "x")} ${place("D3", 140, 50, 90, "y")} ${place("D4", 160, 50, 0, "x")}
  (wire (pts (xy 20 20) (xy 30 20)) (stroke (width 0) (type default)) (uuid "00000000-0000-4000-8000-0000000000a1"))
  (wire (pts (xy 20 40) (xy 30 40)) (stroke (width 0) (type default)) (uuid "00000000-0000-4000-8000-0000000000a2"))
  (label "VPP{slash}MCLR" (at 20 20 0) (effects (font (size 1.27 1.27))) (uuid "00000000-0000-4000-8000-0000000000b1"))
  (label "VPP/MCLR" (at 20 40 0) (effects (font (size 1.27 1.27))) (uuid "00000000-0000-4000-8000-0000000000b2")))`;
  const rs = I.readSet([file("real.kicad_sch", sch)]), doc = rs[0].documents[0], defs = defsOf(rs);
  valid(rs);
  // Library (-3.81, 0) Y-up is (-3.81, 0) on screen. 270°: (0, -3.81)… KiCad turns counter-clockwise on
  // screen, so 270° takes it to (0, -3.81); mirror x then flips Y: (0, 3.81).
  assert.ok(nearP(pin(doc, defs, "D1", "1").at, [100, 53.81]), "270° + mirror x: rotate, then mirror");
  assert.ok(nearP(pin(doc, defs, "D2", "1").at, [120, 46.19]), "90° + mirror x");
  assert.ok(nearP(pin(doc, defs, "D3", "1").at, [140, 53.81]), "90° + mirror y");
  assert.ok(nearP(pin(doc, defs, "D4", "1").at, [156.19, 50]), "0° + mirror x leaves X alone");
  assert.deepEqual(doc.items.filter(i => i.kind === "netlabel").map(i => i.text), ["VPP/MCLR", "VPP/MCLR"], "{slash} is unescaped");

  const pcb = `(kicad_pcb (version 20240108) (generator "pcbnew") (layers (0 "F.Cu" signal) (31 "B.Cu" signal) (44 "Edge.Cuts" user))
  (net 0 "") (net 1 "/VPP{slash}MCLR") (net 2 "unconnected-(U1-Pad3)")
  (footprint "T:U" (layer "F.Cu") (at 10 10 0) (property "Reference" "U1" (at 0 0 0) (layer "F.SilkS"))
    (pad "1" smd rect (at -1 0) (size 0.5 0.5) (layers "F.Cu") (net 1 "/VPP{slash}MCLR"))
    (pad "3" smd rect (at 1 0) (size 0.5 0.5) (layers "F.Cu") (net 2 "unconnected-(U1-Pad3)")))
  (segment (start 9 10) (end 5 10) (width 0.25) (layer "F.Cu") (net 1)))`;
  const rp = I.readSet([file("real.kicad_pcb", pcb)]), board = rp[0].documents[0];
  valid(rp);
  const u1 = board.items.find(i => i.ref === "U1");
  assert.equal(u1.pinNets["1"], "/VPP/MCLR");
  assert.ok(!u1.pinNets["3"], "unconnected-(…) pad has no net");
  assert.equal(board.items.find(i => i.kind === "track").net, "/VPP/MCLR");
  console.log("PASS KiCad real-file patterns: mirrored rotations, escaped names, unconnected pads");
}

// ------------------------------------------------------------------ 3. EasyEDA Standard
// Real boards: pad and component rotations turn the other way from Waffle's (45° oval pads lie
// along -rotation); a hidden designator still names the footprint; a surface pad may keep a stray
// hole radius; silk lines may carry "$BOARDOUTLINENET". Schematic pins connect at their dot.
{
  const pcb = {head: {docType: "3", editorVersion: "6.4.14", x: "4000", y: "3000"}, canvas: "CA~1000~1000~#000000~yes~#FFFFFF~10~1000~100~line~0.5~mil~1~45~~0.5~4000~3000~0~yes", shape: [
    // Component rotated 90 in EasyEDA. Pad 1 sits 10 units "left" of the origin when unrotated.
    "LIB~4100~3100~package`R0603`~90~~gg1~1~uuid~0~0~#@$PAD~OVAL~4100~3090~2~6~1~SIG~1~0.5~4100 3088 4100 3092~90~gg2~0~~Y~0~0~0.4~4100,3090#@$" +
      "PAD~RECT~4100~3110~4~4~1~GND~2~0~4098 3108 4102 3108 4102 3112 4098 3112~90~gg3~0~~Y~0~0~0.4~4100,3110#@$" +
      "TEXT~P~4105~3100~0.6~90~0~3~~4.5~R7~M 0 0~none~gg4~~0~pinpart",
    // A 45° oval pad on its own: outline points lie along -45° (from (2,2) up-right to (-2,-2)).
    "PAD~OVAL~4200~3200~2~6~1~SIG~1~0~4202 3198 4198 3202~45~gg5~0~~Y~0~0~0.4~4200,3200",
    "TRACK~1~3~$BOARDOUTLINENET~4000 3000 4050 3000~gg6~0"]};
  const rs = I.readSet([file("real-pcb.json", JSON.stringify(pcb))]), board = rs[0].documents[0], defs = defsOf(rs);
  valid(rs);
  const r7 = board.items.find(i => i.kind === "part" && i.ref === "R7");
  assert.ok(r7, "hidden designator names the footprint");
  assert.equal(r7.showRef, false);
  assert.equal(r7.angle, -90, "EasyEDA 90 is Waffle -90");
  const p1 = pin(board, defs, "R7", "1", "pcb"), p2 = pin(board, defs, "R7", "2", "pcb");
  assert.ok(nearP(p1.at, [25.4, 22.86]) && nearP(p2.at, [25.4, 27.94]), "pads stay where the file puts them");
  assert.deepEqual([p2.layer, p2.drill], ["Top", 0], "a surface pad with a stray hole radius stays a surface pad");
  const free = board.items.find(i => i.kind === "pad");
  assert.equal(free.angle, -45, "45° pad turns to -45° (Y down)");
  const silk = board.items.find(i => i.kind === "graphic" && i.layer === "Silk");
  assert.ok(silk && !("net" in silk), "silk carries no net");
  // Schematic: header x~y is stale (both pins at one point), the dot is right.
  const sch = {head: {docType: "1", editorVersion: "6.4.14"}, canvas: "CA~1000~1000~#FFFFFF~yes~#CCCCCC~10~1000~100~line~10~pixel~5~0~0", shape: [
    "LIB~100~100~package`R0603`~90~0~gge1~~~0~u~yes~yes#@$T~P~106~97~0~#000080~Arial~~~~~comment~R2~1~start~gge2~0~pinpart#@$" +
      "P~show~0~1~80~120~270~gge3~0^^100~120^^M 100 120 v -10~#800^^0~100~124~270~1~start~~~#800^^0~96~116~270~1~end~~~#800^^0~80~123^^0~M 0 0#@$" +
      "P~show~0~2~80~120~90~gge4~0^^100~80^^M 100 80 v 10~#800^^0~100~76~270~2~end~~~#800^^0~96~84~270~2~start~~~#800^^0~80~77^^0~M 0 0"]};
  const ss = I.readSet([file("real-sch.json", JSON.stringify(sch))]), sdoc = ss[0].documents[0], sdefs = defsOf(ss);
  valid(ss);
  assert.ok(nearP(pin(sdoc, sdefs, "R2", "1").at, [25.4, 30.48]) && nearP(pin(sdoc, sdefs, "R2", "2").at, [25.4, 20.32]), "pins at their dots");
  console.log("PASS EasyEDA Standard real-file patterns: rotation sense, hidden designators, stray holes, silk nets, pin dots");
}

// ------------------------------------------------------------------ 4. EasyEDA Pro 2.x
// Real .epro projects: PAD rows put the hole at index 9 and the shape at 10, pad nets are
// PAD_NET rows, components name their symbol and footprint through project.json devices,
// symbol types are numbers (18 net flag, 20 frame) and values may be "={Attribute}".
{
  const u16 = n => [n & 255, n >> 8 & 255], u32 = n => [n & 255, n >> 8 & 255, n >> 16 & 255, n >>> 24];
  function zip(entries) {
    const locals = [], central = [];
    let offset = 0;
    for (const [name, text] of entries) {
      const nm = [...enc.encode(name)], data = [...enc.encode(text)];
      const local = [...u32(0x04034b50), 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nm.length), 0, 0, ...nm, ...data];
      central.push(...u32(0x02014b50), 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(nm.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(offset), ...nm);
      locals.push(...local); offset += local.length;
    }
    return Uint8Array.from([...locals, ...central, ...u32(0x06054b50), 0, 0, 0, 0, ...u16(entries.length), ...u16(entries.length), ...u32(central.length), ...u32(offset), 0, 0]);
  }
  const project = {schematics: {s1: {name: "S", sheets: [{name: "P1", id: 1}]}}, pcbs: {b1: "PCB1"}, boards: {Board1: {schematic: "s1", pcb: "b1"}},
    symbols: {sym1: {title: "RES", type: 2}, gnd1: {title: "GND", type: 18}, frame1: {title: "A4", type: 20}},
    footprints: {fp1: {title: "R0402", type: 4}},
    devices: {dev1: {title: "RC0402", attributes: {Symbol: "sym1", Footprint: "fp1", "Manufacturer Part": "RC0402FR-0710KL", Value: "={Manufacturer Part}"}}}};
  const rows = a => a.map(r => JSON.stringify(r)).join("\n");
  const epro = zip([
    ["project.json", JSON.stringify(project)],
    ["SYMBOL/sym1.esym", rows([["DOCTYPE", "SYMBOL", "1.1"], ["HEAD", {symbolType: 2}], ["PART", "RES.1", {}],
      ["PIN", "p1", 1, null, -20, 0, 10, 0, null, 0, 0, 1], ["ATTR", "a1", "p1", "NAME", "1"], ["ATTR", "a2", "p1", "NUMBER", "1"],
      ["PIN", "p2", 1, null, 20, 0, 10, 180, null, 0, 0, 1], ["ATTR", "a3", "p2", "NAME", "2"], ["ATTR", "a4", "p2", "NUMBER", "2"]])],
    ["SYMBOL/gnd1.esym", rows([["DOCTYPE", "SYMBOL", "1.1"], ["HEAD", {symbolType: 18}]])],
    ["SYMBOL/frame1.esym", rows([["DOCTYPE", "SYMBOL", "1.1"], ["HEAD", {symbolType: 20}]])],
    ["FOOTPRINT/fp1.efoo", rows([["DOCTYPE", "FOOTPRINT", "1.8"],
      ["PAD", "e1", 0, "", 1, "1", -20, 0, 0, null, ["RECT", 20, 24, 0], [], 0, 0, null, 0, 0, 2, 2, 0, 0, 0, null, null, null, null, []],
      ["PAD", "e2", 0, "", 12, "2", 20, 0, 0, ["ROUND", 12, 12], ["ELLIPSE", 30, 30], [], 0]])],
    ["SHEET/s1/1.esch", rows([["DOCTYPE", "SCH", "1.1"],
      ["COMPONENT", "c0", "", 0, 0, 0, 0, {}, 0], ["ATTR", "f1", "c0", "Symbol", "frame1"],
      ["COMPONENT", "c1", "RES.1", 100, 100, 0, 0, {}, 0], ["ATTR", "x1", "c1", "Designator", "R1"], ["ATTR", "x2", "c1", "Device", "dev1"],
      ["COMPONENT", "c2", "", 140, 100, 0, 0, {}, 0], ["ATTR", "x3", "c2", "Symbol", "gnd1"], ["ATTR", "x4", "c2", "Name", "GND"]])],
    ["PCB/b1.epcb", rows([["DOCTYPE", "PCB", "1.8"],
      ["COMPONENT", "e9", 0, 1, 1000, -1000, 0, {}, 0], ["ATTR", "t1", 0, "e9", 3, null, null, "Designator", "R1"], ["ATTR", "t2", 0, "e9", 3, null, null, "Device", "dev1"],
      ["ATTR", "t3", 0, "e9", 3, null, null, "Footprint", "fp1"], ["PAD_NET", "e9", "1", "SIG", "e1"], ["PAD_NET", "e9", "2", "GND", "e2"]])]]);
  const rs = I.readSet([file("real.epro", epro)]), defs = defsOf(rs);
  valid(rs);
  const board = rs[0].documents.find(d => d.kind === "pcb"), sheet = rs[0].documents.find(d => d.kind === "schematic");
  const r1 = board.items.find(i => i.ref === "R1"), fp = defs.get(r1.def).footprint;
  assert.deepEqual(r1.pinNets, {1: "SIG", 2: "GND"}, "PAD_NET rows");
  assert.equal(r1.value, "RC0402FR-0710KL", "={Manufacturer Part} resolves");
  const pad1 = fp.pads.find(p => p.number === "1"), pad2 = fp.pads.find(p => p.number === "2");
  assert.deepEqual([pad1.layer, pad1.drill, near(pad1.w, .508), near(pad1.h, .6096)], ["Top", 0, true, true], "shape at index 10");
  assert.deepEqual([pad2.layer, near(pad2.drill, .3048), near(pad2.w, .762)], ["Multi", true, true], "hole at index 9");
  const sr1 = sheet.items.find(i => i.kind === "part" && i.ref === "R1");
  assert.ok(sr1, "symbol found through the device");
  assert.equal(sr1.value, "RC0402FR-0710KL");
  assert.equal(defs.get(sr1.def).footprintName, "R0402");
  assert.deepEqual(defs.get(sr1.def).symbol.pins.map(p => p.number), ["1", "2"]);
  assert.ok(sheet.items.some(i => i.kind === "power" && i.text === "GND"), "type 18 is a net flag");
  assert.equal(sheet.items.filter(i => i.kind === "part").length, 1, "type 20 frame is not a part");
  console.log("PASS EasyEDA Pro 2.x real-file patterns: PAD layout, PAD_NET, devices, symbol types, attribute references");
}
