"use strict";
// IDF 3.0 (mcad-idf.js): the .emn/.emp written for the test board read back proposes nothing; an
// MCAD edit of the .emn (component moved and flipped, outline changed, a new hole, a keep-out
// height) is proposed, accepted, and then the board matches; arcs and circles; caps.
const assert = require("node:assert/strict");
const {pointSeg} = require("../support/segment-distance.cjs");
for (const m of ["model", "parts", "pcb-appearance", "pcb-pours", "stackup", "board-shape", "rigid-flex", "zip", "fab-outputs", "step-export", "pcb-edit", "mcad-xml", "mcad", "mcad-idx", "mcad-idf"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("./mcad-board.js");
const MC = AtriumMCAD, F = AtriumIDF;
const DATE = "2026-11-19T12:00:00Z";
{
  const p = mcadBoard(), d = p.documents[0], w = F.write(p, d, {date: DATE});
  assert.equal(w.emn.name, "Board.emn"); assert.equal(w.emp.name, "Board.emp");
  assert.match(w.emn.text, /^\.HEADER\nBOARD_FILE 3\.0 "Waffle" 2026\/11\/19\.12:00:00 1\n"Board" MM\n\.END_HEADER\n\.BOARD_OUTLINE ECAD\n1\.6\d*\n/);
  assert.match(w.emn.text, /\n0 55 0 90\n|\n0 60 -5 -90\n|\n0 55 0 -90\n|\n0 60 -5 90\n/, "the rounded corner is an arc record");
  assert.match(w.emn.text, /3\.2 4 -36 NPTH BOARD MTG ECAD/);
  assert.match(w.emn.text, /"R0603" "res_0\.5" "R1"\n10 -10 0 0 TOP PLACED/);
  assert.match(w.emn.text, /"QFN16" "qfn_0\.9" "U1"\n40 -12 0 270 BOTTOM PLACED/);
  assert.match(w.emn.text, /"JST-2" "conn_6" "J1"\n45 -32 0 180 TOP ECAD/, "a locked part is ECAD-owned");
  assert.match(w.emn.text, /\.PLACE_KEEPOUT ECAD\nBOTH 2\.5\n/); assert.match(w.emn.text, /\.ROUTE_KEEPOUT ECAD\nTOP\n/);
  assert.match(w.emp.text, /\.ELECTRICAL\n"QFN16" "qfn_0\.9" MM 0\.9\n0 /);
  assert.deepEqual(F.write(mcadBoard(), mcadBoard().documents[0], {date: DATE}).emn.text, w.emn.text, "deterministic");
  // Round trip: nothing to propose.
  const des = F.read(w.emn.text, w.emp.text);
  assert.equal(des.parts.length, 3); assert.equal(des.board.cutouts.length, 1); assert.ok(Math.abs(des.board.thickness - 1.6) < 0.01);
  assert.deepEqual(MC.compare(p, d, des).map(x => x.label), []);
  // An MCAD edit: R1 moved and turned, U1 flipped to the top, a new mounting hole, the board 2 mm taller, the keep-out 4 mm high.
  const edited = w.emn.text
    .replace("10 -10 0 0 TOP PLACED", "11 -9 0 45 TOP PLACED")
    .replace("40 -12 0 270 BOTTOM PLACED", "40 -12 0 0 TOP PLACED")
    .replace(".END_DRILLED_HOLES", "2.5 30 -2 NPTH BOARD MTG MCAD\n.END_DRILLED_HOLES")
    .replace(/\n0 0 -40 0\n/g, "\n0 0 -42 0\n").replace(/\n0 60 -40 0\n/g, "\n0 60 -42 0\n")
    .replace("BOTH 2.5\n", "BOTH 4\n");
  const {proposals} = MC.receive(p, d, F.read(edited, w.emp.text), {file: "x.emn"});
  const kinds = proposals.map(x => x.kind + ":" + (x.ref || "")).sort();
  assert.deepEqual(kinds, ["hole-add:", "keepout-change:", "outline:", "place:R1", "place:U1"], JSON.stringify(kinds));
  assert.deepEqual(proposals.find(x => x.ref === "R1").after, {x: 11, y: 9, angle: 315, side: "Top"});
  for (const x of proposals) MC.accept(p, d, x.id);
  assert.deepEqual(MC.compare(p, d, F.read(edited, w.emp.text)).map(x => x.label), [], "the board matches the edited IDF");
  assert.ok(d.outline.some(q => q[1] === 42));
  assert.deepEqual(d.items.find(i => i.id === "k1").mcadZ, [0, 4]);
  // A hole removed in MCAD is proposed for removal (IDF is a full data set).
  const removed = F.write(p, d, {date: DATE}).emn.text.replace(/\n3\.2 4 -36 NPTH BOARD MTG ECAD/, "");
  assert.deepEqual(MC.compare(p, d, F.read(removed)).map(x => x.kind), ["hole-remove"]);
}
// A stray line in .PLACEMENT is skipped alone: it must not pair with the next component's name record.
{
  const head = ".HEADER\nBOARD_FILE 3.0 \"X\" 2026/01/01.00:00:00 1\n\"B\" MM\n.END_HEADER\n.PLACEMENT\n";
  const omitted = [], trace = {omitted: (...a) => omitted.push(a)};
  for (const stray of ["STRAY", "1 2 3 4 5 6", "\"P\" \"Q\" \"R0\""]) {
    const des = F.read(head + "\"P\" \"Q\" \"R1\"\n1 2 0 0 TOP PLACED\n" + stray + "\n\"P\" \"Q\" \"R2\"\n3 4 0 90 BOTTOM PLACED\n.END_PLACEMENT\n", null, trace);
    assert.deepEqual(des.parts.map(q => [q.ref, q.x, q.y, q.side]), [["R1", 1, -2, "Top"], ["R2", 3, -4, "Bottom"]], stray);
  }
  assert.equal(omitted.length, 3);
  assert.equal(omitted[0][0], "Component placement");
  assert.deepEqual(F.read(head + "STRAY\n\"P\" \"Q\" \"R2\"\n3 4 0 0 TOP PLACED\n").notes, ["1 incomplete .PLACEMENT line(s) were skipped."]);
  // A malformed number in a placement record still rejects the file: dropping the part would propose its removal.
  assert.throws(() => F.read(head + "\"P\" \"Q\" \"R1\"\nabc 2 0 0 TOP PLACED\n"), /x is not a number/);
}
// Circles, THOU units and bad input.
{
  const t = ".HEADER\nBOARD_FILE 3.0 \"X\" 2026/01/01.00:00:00 1\n\"B\" THOU\n.END_HEADER\n.BOARD_OUTLINE MCAD\n62\n0 0 0 0\n0 1000 0 0\n0 1000 1000 0\n0 0 1000 0\n0 0 0 0\n1 500 500 0\n1 600 500 360\n.END_BOARD_OUTLINE\n";
  const des = F.read(t);
  assert.ok(Math.abs(des.board.thickness - 1.5748) < 1e-9);
  assert.equal(des.board.cutouts.length, 1);
  assert.equal(des.board.cutouts[0].length, 64, "IDF closed-circle record keeps its fixed projection size");
  const c = des.board.cutouts[0], r = Math.hypot(c[0][0] - 12.7, c[0][1] + 12.7);
  assert.ok(Math.abs(r - 2.54) < 1e-6, "circle cutout radius " + r);
  assert.throws(() => F.read("hello"), /not an IDF board/);
  assert.throws(() => F.read(t.replace("62", "sixty")), /not a number/);
}
{
  const p = mcadBoard(), doc = p.documents[0];
  const idx = AtriumIDX.read(AtriumIDX.baseline(p, doc, {date: DATE, record: false}).text);
  const idf = F.read(F.write(p, doc, {date: DATE}).emn.text);
  for (const [format, design] of [["IDX", idx], ["IDF", idf]]) {
    const ring = design.board.outline;
    for (let i = 0; i <= 512; i++) {
      const t = i * Math.PI / 1024, at = [55 + 5 * Math.sin(t), 5 - 5 * Math.cos(t)];
      const miss = Math.min(...ring.map((a, j) => pointSeg(at, a, ring[(j + 1) % ring.length])));
      assert.ok(miss <= .005, format + " fillet chord error " + miss);
    }
  }
}
// A slot is not a round hole: IDF 3.0 holes are round, so it is a cutout loop on the slot's outline,
// and reading that loop back matches the slot (no outline change, no removed hole).
{
  const p = mcadBoard(), doc = p.documents[0];
  doc.items.push({id: "s1", kind: "pad", number: "", x: 10, y: 30, w: 4, h: .8, drill: .8, slotLength: 4, shape: "round", layer: "Multi", net: "", plated: false},
    {id: "s2", kind: "pad", number: "", x: 50, y: 20, w: 4, h: .8, drill: .8, slotLength: 4, slotAngle: 30, shape: "round", layer: "Multi", net: "", plated: false});
  const w = F.write(p, doc, {date: DATE}), des = F.read(w.emn.text, w.emp.text);
  assert.doesNotMatch(w.emn.text, /\n0\.8 /, "no 0.8 mm round hole");
  assert.equal(des.board.cutouts.length, 3, "the rectangular cutout and two slot loops");
  const slot = des.board.cutouts.find(c => c.every(q => Math.abs(q[1] - 30) <= .4 + 1e-6));
  const xs = slot.map(q => q[0]);
  assert.ok(Math.abs(Math.min(...xs) - 8) < .01 && Math.abs(Math.max(...xs) - 12) < .01, "the slot loop is 4 mm long");
  assert.deepEqual(MC.compare(p, doc, des).map(x => x.label), []);
  // Without the loop the slot is gone in MCAD.
  const loop = w.emn.text.split("\n").filter(l => /^3 \S+ \S+ \S+$/.test(l)).join("\n");
  assert.deepEqual(MC.compare(p, doc, F.read(w.emn.text.replace(loop + "\n", ""))).map(x => x.kind), ["hole-remove"]);
}
console.log("SHIM-OK");
