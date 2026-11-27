"use strict";
// IDX (EDMD) exchange (mcad-xml.js, mcad.js, mcad-idx.js): the baseline golden and its structural
// validation, the safe XML reader (no DTD, no entities, caps), a round trip where an MCAD edit is
// simulated by editing the XML (component moved, rotated and flipped, outline changed, a new hole
// and a new keep-out) and accepted, so the board then matches MCAD; the reject flow and the IDX
// response; incremental SendChanges; the identity map surviving save and load.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const m of ["model", "parts", "pcb-appearance", "pcb-pours", "stackup", "board-shape", "rigid-flex", "zip", "fab-outputs", "step-export", "pcb-edit", "mcad-xml", "mcad", "mcad-idx"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("./mcad-board.js");
const X = AtriumXML, MC = AtriumMCAD, I = AtriumIDX, A = Atrium;
// An instant, not local wall time: the header writes UTC, so a zone-less string would move with the host's TZ.
const DATE = "2026-11-19T12:00:00Z";
const near = (a, b, e, m) => assert.ok(Math.abs(a - b) <= e, (m ? m + ": " : "") + a + " vs " + b);

// ---- the baseline: golden, structure, determinism -------------------------------------------
{
  const p = mcadBoard(), d = p.documents[0];
  const r = I.baseline(p, d, {date: DATE});
  assert.deepEqual(r.problems, [], "the written baseline passes the structural check");
  assert.deepEqual(I.validate(r.text), [], "and so does the parsed text");
  const golden = fs.readFileSync(path.join(__dirname, "../fixtures/mcad/baseline.idx"), "utf8");
  assert.equal(r.text, golden, "IDX baseline golden (tests/fixtures/mcad/baseline.idx)");
  assert.equal(I.baseline(mcadBoard(), mcadBoard().documents[0], {date: DATE}).text, r.text, "byte-stable for the same design");
  assert.equal(r.stats.parts, 3); assert.equal(r.stats.holes, 3, "two free holes and the connector's non-plated peg"); assert.equal(r.stats.keepouts, 2);
  for (const t of ["BOARD_OUTLINE", "COMPONENT", "HOLE_PLATED", "HOLE_NON_PLATED", "KEEPOUT_AREA_COMPONENT", "KEEPOUT_AREA_ROUTE", "EDMDProcessInstructionSendInformation", "EDMDArc", "UNIT_MM", "REFDES", "LOCKED"])
    assert.ok(r.text.includes(t), t);
  assert.equal(d.mcad.baseline.seq, 1, "the baseline is recorded on the board");
  // Reading our own file proposes nothing.
  assert.deepEqual(MC.compare(p, d, I.read(r.text)), []);
}

// ---- the safe reader -----------------------------------------------------------------------------
{
  assert.throws(() => X.parse('<?xml version="1.0"?><!DOCTYPE a [<!ENTITY x SYSTEM "file:///etc/passwd">]><a>&x;</a>'), /document type declaration/);
  assert.throws(() => X.parse('<a>&lol;</a>'), /Undeclared entity/);
  assert.throws(() => X.parse('<a>AT&T</a>'), /bare &/);
  assert.equal(X.parse('<a b="&lt;&#65;&#x42;">x &amp; y<![CDATA[<z>]]></a>').text, "x & y<z>");
  assert.equal(X.parse('<a b="&lt;&#65;&#x42;"/>').attrs.b, "<AB");
  assert.throws(() => X.parse("<a>" + "x".repeat(2000) + "</a>", {limits: {bytes: 1000}}), /larger than/);
  assert.throws(() => X.parse("<a>".repeat(200) + "</a>".repeat(200)), /deeper than/);
  assert.throws(() => X.parse("<a><b></a>"), /Mismatched/);
  assert.throws(() => X.parse('<f:a xmlns:g="u"/>'), /Undeclared namespace/);
  // Other prefixes for the same namespaces read the same.
  const p = mcadBoard(), d = p.documents[0], text = I.baseline(p, d, {date: DATE}).text.replace(/foundation:/g, "fnd:").replace("xmlns:foundation=", "xmlns:fnd=");
  assert.deepEqual(MC.compare(p, d, I.read(text)), [], "prefix fnd: instead of foundation:");
  assert.throws(() => I.read("<html/>"), /not an IDX file/);
}

// ---- helpers that edit the XML like an MCAD tool would ----------------------------------------
function itemBlock(text, name, type) {
  const re = new RegExp('<foundation:Item id="(IT_\\d+)" geometryType="' + type + '">\\s*<foundation:Name>' + name + "</foundation:Name>[\\s\\S]*?</foundation:Item>");
  const m = re.exec(text); assert.ok(m, type + " " + name); return m;
}
function setValue(block, q, v) { return block.replace(new RegExp("(<" + q + ">\\s*<property:Value>)[^<]*"), "$1" + v); }
function setText(block, q, v) { return block.replace(new RegExp("(<" + q + ">)[^<]*"), "$1" + v); }
function mcadEdit(text) {
  // R1: moved to (12.5, 11) and rotated 90 degrees (Y up: ty = -11; theta = -90).
  let m = itemBlock(text, "R1", "COMPONENT"), b = m[0];
  b = setValue(setValue(b, "pdm:tx", 12.5), "pdm:ty", -11);
  b = setText(setText(setText(setText(b, "pdm:xx", 0), "pdm:xy", 1), "pdm:yx", -1), "pdm:yy", 0);
  text = text.replace(m[0], b);
  // U1: flipped back to the top at angle 0.
  m = itemBlock(text, "U1", "COMPONENT"); b = m[0];
  b = setText(setText(setText(setText(b, "pdm:xx", 1), "pdm:xy", 0), "pdm:yx", 0), "pdm:yy", 1);
  b = b.replace(/<property:Value>BOTTOM<\/property:Value>/, "<property:Value>TOP</property:Value>");
  text = text.replace(m[0], b);
  // The board grows to 65 mm wide at the bottom-right corner (the point (60, -40) Y up).
  const cp = /<foundation:CartesianPoint id="(CP_\d+)" xsi:type="d2:EDMDCartesianPoint">\s*<d2:X>\s*<property:Value>60<\/property:Value>\s*<\/d2:X>\s*<d2:Y>\s*<property:Value>-40<\/property:Value>/.exec(text);
  text = text.replace(cp[0], cp[0].replace("<property:Value>60</property:Value>", "<property:Value>65</property:Value>"));
  // A new non-plated hole from MCAD, using the existing 3.2 mm hole body.
  const npth = /<foundation:Item id="(IT_\d+)">\s*<foundation:Name>NPTH 3.2<\/foundation:Name>/.exec(text)[1];
  const hole = `<foundation:Item id="SW_1" geometryType="HOLE_NON_PLATED"><foundation:Name>MH</foundation:Name><pdm:ItemType>assembly</pdm:ItemType>
<pdm:Identifier><foundation:SystemScope>SOLIDWORKS</foundation:SystemScope><foundation:Number>HOLE-77</foundation:Number><foundation:Version>1</foundation:Version><foundation:Revision>0</foundation:Revision><foundation:Sequence>0</foundation:Sequence></pdm:Identifier>
<pdm:ItemInstance id="SW_2"><pdm:Item>${npth}</pdm:Item><pdm:InstanceName><foundation:SystemScope>SOLIDWORKS</foundation:SystemScope><foundation:ObjectName>MH-77</foundation:ObjectName></pdm:InstanceName>
<pdm:Transformation><pdm:TransformationType>d2</pdm:TransformationType><pdm:xx>1</pdm:xx><pdm:xy>0</pdm:xy><pdm:yx>0</pdm:yx><pdm:yy>1</pdm:yy><pdm:tx><property:Value>30</property:Value></pdm:tx><pdm:ty><property:Value>-36</property:Value></pdm:ty></pdm:Transformation></pdm:ItemInstance></foundation:Item>`;
  // A new component keep-out 3 mm high (an enclosure rib).
  const keep = `<foundation:CartesianPoint id="SW_P1" xsi:type="d2:EDMDCartesianPoint"><d2:X><property:Value>45</property:Value></d2:X><d2:Y><property:Value>-2</property:Value></d2:Y></foundation:CartesianPoint>
<foundation:CartesianPoint id="SW_P2" xsi:type="d2:EDMDCartesianPoint"><d2:X><property:Value>50</property:Value></d2:X><d2:Y><property:Value>-2</property:Value></d2:Y></foundation:CartesianPoint>
<foundation:CartesianPoint id="SW_P3" xsi:type="d2:EDMDCartesianPoint"><d2:X><property:Value>50</property:Value></d2:X><d2:Y><property:Value>-8</property:Value></d2:Y></foundation:CartesianPoint>
<foundation:PolyLine id="SW_L" xsi:type="d2:EDMDPolyLine"><d2:Point>SW_P1</d2:Point><d2:Point>SW_P2</d2:Point><d2:Point>SW_P3</d2:Point><d2:Point>SW_P1</d2:Point></foundation:PolyLine>
<foundation:CurveSet2d id="SW_C" xsi:type="d2:EDMDCurveSet2d"><pdm:ShapeDescriptionType>GeometricModel</pdm:ShapeDescriptionType><d2:LowerBound><property:Value>0</property:Value></d2:LowerBound><d2:UpperBound><property:Value>3</property:Value></d2:UpperBound><d2:DetailedGeometricModelElement>SW_L</d2:DetailedGeometricModelElement></foundation:CurveSet2d>
<foundation:ShapeElement id="SW_S"><pdm:ShapeElementType>FeatureShapeElement</pdm:ShapeElementType><pdm:Inverted>false</pdm:Inverted><pdm:DefiningShape>SW_C</pdm:DefiningShape></foundation:ShapeElement>
<foundation:Item id="SW_I"><foundation:Name>Rib</foundation:Name><pdm:ItemType>single</pdm:ItemType><pdm:Shape>SW_S</pdm:Shape></foundation:Item>
<foundation:Item id="SW_K" geometryType="KEEPOUT_AREA_COMPONENT"><foundation:Name>Rib keep-out</foundation:Name><pdm:ItemType>assembly</pdm:ItemType>
<pdm:Identifier><foundation:SystemScope>SOLIDWORKS</foundation:SystemScope><foundation:Number>RIB-1</foundation:Number></pdm:Identifier>
<pdm:ItemInstance id="SW_KI"><pdm:Item>SW_I</pdm:Item></pdm:ItemInstance></foundation:Item>`;
  return text.replace("</foundation:Body>", hole + "\n" + keep + "\n</foundation:Body>").replace("CreatorSystem>Waffle<", "CreatorSystem>SOLIDWORKS<");
}

// ---- round trip: export, MCAD edit, import, accept, the board matches ---------------------------
let saved;
{
  const p = mcadBoard(), d = p.documents[0];
  const base = I.baseline(p, d, {date: DATE});
  const edited = mcadEdit(base.text);
  assert.deepEqual(I.validate(edited), [], "the edited file is still structurally valid");
  const design = I.read(edited);
  assert.equal(design.header.system, "SOLIDWORKS");
  const {batch, proposals} = MC.receive(p, d, design, {file: "from-mcad.idx", at: DATE});
  const kinds = proposals.map(x => x.kind + ":" + (x.ref || x.ident?.number || "")).sort();
  assert.deepEqual(kinds, ["hole-add:HOLE-77", "keepout-add:RIB-1", "outline:board", "place:R1", "place:U1"], JSON.stringify(kinds));
  const r1 = proposals.find(x => x.ref === "R1");
  assert.deepEqual(r1.after, {x: 12.5, y: 11, angle: 90, side: "Top"});
  assert.match(r1.label, /R1 moved, rotated/);
  assert.equal(proposals.find(x => x.ref === "U1").after.side, "Top");
  // The preview applies everything to a copy; the board itself is untouched.
  const pv = MC.preview(p, d);
  assert.deepEqual(pv.errors, []);
  assert.equal(pv.doc.items.find(i => i.id === "pR1").x, 12.5); assert.equal(d.items.find(i => i.id === "pR1").x, 10);
  // Accept each one (in the editor, each is one undo step).
  for (const x of proposals) MC.accept(p, d, x.id);
  const R1 = d.items.find(i => i.id === "pR1"), U1 = d.items.find(i => i.id === "pU1");
  assert.equal(R1.x, 12.5); assert.equal(R1.y, 11); assert.equal(R1.angle, 90);
  assert.equal(U1.layer, undefined, "U1 is on the top again"); assert.equal(U1.angle, 0); assert.equal(U1.x, 40);
  assert.ok(d.outline.some(q => Math.abs(q[0] - 65) < 1e-6 && Math.abs(q[1] - 40) < 1e-6), "outline corner moved");
  assert.equal(d.boardShape.cutouts.length, 1, "the cutout stays");
  const hole = d.items.find(i => i.kind === "pad" && i.x === 30 && i.y === 36);
  assert.ok(hole && hole.drill === 3.2 && hole.plated === false, "the MCAD hole is on the board");
  const rib = d.items.find(i => i.mcadKind === "component" && i.id !== "k1");
  assert.deepEqual(rib.mcadZ, [0, 3]); assert.equal(rib.layer, "Keepout");
  assert.deepEqual(d.mcad.ids[hole.id], {s: "SOLIDWORKS", n: "HOLE-77"}, "identity: MCAD's id maps to the new Waffle hole");
  // The board now matches MCAD: reading the edited file again proposes nothing.
  assert.deepEqual(MC.compare(p, d, I.read(edited)).map(x => x.label), []);
  // And the changes since the baseline are not echoed back: everything accepted is MCAD's state already.
  const ch = MC.changesSince(d, MC.snapshot(p, d));
  assert.deepEqual([ch.added.length, ch.changed.length, ch.removed.length], [0, 0, 0], JSON.stringify(ch));
  // A new baseline names the MCAD hole by MCAD's identifier.
  const again = I.baseline(p, d, {date: DATE, record: false}).text;
  assert.ok(again.includes("<foundation:Number>HOLE-77</foundation:Number>") && again.includes("<foundation:SystemScope>SOLIDWORKS</foundation:SystemScope>"));
  // The response: all accepted.
  const resp = I.response(p, d, {date: DATE, batch});
  assert.deepEqual(resp.problems, []); assert.equal(resp.stats.accepted, 5); assert.equal(resp.stats.rejected, 0);
  assert.equal((resp.text.match(/<computational:Accepted>true</g) || []).length, 5);
  const back = I.read(resp.text);
  assert.equal(back.kind, "response"); assert.equal(back.responses.length, 5);
  saved = require("../support/native-cad.cjs").nativeRoundTrip(p);
}

// ---- reject flow ------------------------------------------------------------------------------
{
  const p = mcadBoard(), d = p.documents[0];
  const edited = mcadEdit(I.baseline(p, d, {date: DATE}).text);
  const {proposals} = MC.receive(p, d, I.read(edited), {file: "x.idx"});
  const r1 = proposals.find(x => x.ref === "R1"), hole = proposals.find(x => x.kind === "hole-add");
  MC.reject(p, d, r1.id, "R1 must stay by the connector");
  MC.accept(p, d, hole.id);
  assert.throws(() => MC.accept(p, d, r1.id), /already rejected/);
  assert.equal(d.items.find(i => i.id === "pR1").x, 10, "a rejected move is not applied");
  const resp = I.response(p, d, {date: DATE});
  assert.equal(resp.stats.accepted, 1); assert.equal(resp.stats.rejected, 1);
  assert.match(resp.text, /<computational:Accepted>false<\/computational:Accepted>\s*<computational:Comment>R1 must stay by the connector/);
  // Still pending: outline, U1, keep-out.
  assert.equal(MC.pending(d).length, 3);
  assert.equal(MC.status(p, d).inbox.rejected, 1);
  // The rejected move is still a difference, so a new change set does not hide it.
  assert.equal(MC.compare(p, d, I.read(edited)).filter(x => x.ref === "R1").length, 1);
}

// ---- incremental changes (SendChanges) -----------------------------------------------------------
{
  const p = mcadBoard(), d = p.documents[0];
  assert.throws(() => I.changes(p, d, {date: DATE}), /baseline first/);
  I.baseline(p, d, {date: DATE});
  d.items.find(i => i.id === "pR1").x = 14;
  d.items = d.items.filter(i => i.id !== "h2");
  d.items.push({id: "h9", kind: "pad", number: "", x: 30, y: 5, w: 2, h: 2, drill: 2, shape: "round", layer: "Multi", net: "", plated: false});
  const c = I.changes(p, d, {date: DATE});
  assert.deepEqual(c.problems, []);
  assert.deepEqual([c.stats.added, c.stats.changed, c.stats.removed, c.stats.sequence], [1, 1, 1, 2]);
  assert.match(c.text, /EDMDProcessInstructionSendChanges/);
  assert.equal((c.text.match(/<computational:Changes>/g) || []).length, 3);
  assert.match(c.text, /<foundation:Number>pR1<\/foundation:Number>\s*<foundation:Version>2</, "the changed component is version 2");
  // Read as MCAD would: one changed component, one new hole, one deleted hole.
  const des = I.read(c.text);
  assert.equal(des.kind, "changes"); assert.equal(des.parts.length, 1); assert.equal(des.holes.length, 1); assert.deepEqual(des.removed.map(r => r.number), ["h2"]);
  assert.equal(d.mcad.baseline.seq, 2);
  const none = I.changes(p, d, {date: DATE});
  assert.deepEqual([none.stats.added, none.stats.changed, none.stats.removed], [0, 0, 0], "nothing new since the last change set");
  // A change set received from MCAD: only its listed items count, removals are proposed.
  const fromMcad = c.text.replace(/<foundation:Number>pR1<\/foundation:Number>/g, "<foundation:Number>pR1</foundation:Number>");
  d.items.find(i => i.id === "pR1").x = 10; d.items.push({id: "h2", kind: "pad", number: "", x: 56, y: 36, w: 4, h: 4, drill: 3, shape: "round", layer: "Multi", net: "GND"});
  d.items = d.items.filter(i => i.id !== "h9");
  const props = MC.compare(p, d, I.read(fromMcad)).map(x => x.kind).sort();
  assert.deepEqual(props, ["hole-add", "hole-remove", "place"]);
}

// ---- the identity map survives save and load -------------------------------------------------------
{
  const p = saved;
  A.validate(p);
  const d = p.documents[0];

  MC.validate(d.mcad);
  const hole = d.items.find(i => i.kind === "pad" && i.x === 30 && i.y === 36);
  assert.deepEqual(d.mcad.ids[hole.id], {s: "SOLIDWORKS", n: "HOLE-77"});
  assert.equal(d.mcad.inbox.filter(x => x.status === "accepted").length, 5);
  // MCAD moves its hole: matched by identifier, not position.
  const moved = I.baseline(p, d, {date: DATE, record: false}).text.replace(/(<foundation:Number>HOLE-77<\/foundation:Number>[\s\S]*?<pdm:tx>\s*<property:Value>)30</, "$131<");
  const props = MC.compare(p, d, I.read(moved));
  assert.equal(props.length, 1); assert.equal(props[0].kind, "hole-change"); assert.equal(props[0].key, hole.id);
  const unconfigured = require("../support/native-cad.cjs").nativeRoundTrip(mcadBoard());
  assert.equal(unconfigured.documents[0].mcad, undefined, "reading a board without MCAD state does not manufacture it");
  assert.throws(() => MC.validate({version: 1, inbox: [{id: 3}]}), /Invalid MCAD/);
}
// The import path rejects an ambiguous outline point before building geometry.
{
  const golden = fs.readFileSync(path.join(__dirname, "../fixtures/mcad/baseline.idx"), "utf8");
  const point = /<foundation:CartesianPoint id="CP_1"[^>]*>[\s\S]*?<\/foundation:CartesianPoint>/;
  assert.ok(point.test(golden));
  const duplicate = golden.replace(point, node => node + "\n" + node.replace("<property:Value>0<", "<property:Value>9<"));
  assert.equal(I.read(golden).board.outline[0][0], 0);
  assert.throws(() => I.read(duplicate), /Duplicate IDX id CP_1/);
}
// A slot is its stadium outline (two semicircles), not a circle of its width, and reads back as the slot.
{
  const p = mcadBoard(), d = p.documents[0];
  d.items.push({id: "s1", kind: "pad", number: "", x: 10, y: 30, w: 4, h: .8, drill: .8, slotLength: 4, shape: "round", layer: "Multi", net: "", plated: false},
    {id: "s2", kind: "pad", number: "", x: 50, y: 20, w: 4, h: .8, drill: .8, slotLength: 4, slotAngle: 30, shape: "round", layer: "Multi", net: "", plated: false});
  const r = I.baseline(p, d, {date: DATE, record: false});
  assert.deepEqual(r.problems, []);
  assert.doesNotMatch(r.text, /<d2:Diameter>\s*<property:Value>0\.8</, "no 0.8 mm circle");
  assert.match(r.text, /<foundation:Name>NPTH 0\.8 x 4<\/foundation:Name>/);
  const read = I.read(r.text), holes = read.holes.filter(h => h.slot);
  assert.equal(holes.length, 2); assert.ok(!read.notes.length, read.notes.join("\n"));
  for (const h of holes) {
    near(h.d, .8, 1e-6, "slot width"); near(Math.hypot(h.slot[1][0] - h.slot[0][0], h.slot[1][1] - h.slot[0][1]) + h.d, 4, 1e-4, "slot length");
  }
  const turned = holes.find(h => Math.abs(h.x - 50) < 1e-6), dx = turned.slot[1][0] - turned.slot[0][0], dy = turned.slot[1][1] - turned.slot[0][1];
  near(Math.abs(dy / dx), Math.tan(30 * Math.PI / 180), 1e-4, "slot axis");
  near(turned.y, 20, 1e-6);
  assert.deepEqual(MC.compare(p, d, read), []);
}

console.log("SHIM-OK");
