"use strict";
// Eagle 6–9 XML import (app/formats/import-eagle.js). Fixtures in tests/fixtures/import are
// synthetic designs written for this test (MIT, like the rest of the repository).
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const f of ["model", "sch-objects", "board-shape", "board-shape-sources", "stackup", "polygon-pour", "kicad-export", "sexpr", "import-eagle", "net-intent", "signals", "rules", "import-link"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
const A = Atrium, I = AtriumImportFormats, enc = new TextEncoder();
const fixture = n => fs.readFileSync(path.join(__dirname, "../fixtures/import", n), "utf8");
const near = (a, b, tol = 1e-3) => Math.abs(a - b) <= tol;
const nearP = (p, q, tol = 1e-3) => !!p && near(p[0], q[0], tol) && near(p[1], q[1], tol);

// ------------------------------------------------------------------ XML reader
{
  const x = AtriumEagleImport.parseXML('<?xml version="1.0"?><!DOCTYPE eagle [<!ENTITY x "y">]><!-- c --><a k="1 &amp; 2" j=\'q\'><b/><t>&gt;NAME</t><![CDATA[<raw>]]></a>');
  const a = x.children[0];
  assert.deepEqual([a.name, a.attrs.k, a.attrs.j, a.children.length, a.children[1].text, a.text], ["a", "1 & 2", "q", 2, ">NAME", "<raw>"]);
  assert.throws(() => AtriumEagleImport.parseXML("<a><b></a>"), /Malformed/);
}

// ------------------------------------------------------------------ board
{
  const [r] = I.readSet([{name: "demo-eagle.brd", bytes: enc.encode(fixture("demo-eagle.brd"))}]);
  const board = r.documents[0], defs = new Map(r.library.map(d => [d.id, d]));
  const p = A.project("Eagle"); p.documents = [board]; p.library = r.library; AtriumImportLink.reconcile(p, p.documents); A.validate(p);
  const R1 = board.items.find(i => i.ref === "R1"), J1 = board.items.find(i => i.ref === "J1");
  const pad = (part, n) => A.pins(part, defs.get(part.def), "pcb").find(q => q.number === n);
  assert.deepEqual([R1.angle, R1.layer, R1.value], [-90, "Top", "10k"]);
  assert.ok(nearP(pad(R1, "1").at, [20, -9.2]) && nearP(pad(R1, "2").at, [20, -10.8]));
  assert.equal(pad(R1, "1").shape, "roundrect");
  assert.equal(J1.layer, "Bottom");
  assert.ok(nearP(pad(J1, "1").at, [35, -10]) && nearP(pad(J1, "2").at, [32.46, -10]), "mirrored element");
  assert.deepEqual([pad(J1, "1").shape, pad(J1, "1").w, pad(J1, "1").drill, pad(J1, "1").layer], ["rect", 1.508, 1, "Multi"]);
  assert.deepEqual(R1.pinNets, {1: "SIG", 2: "GND"});
  assert.deepEqual(J1.pinNets, {1: "SIG", 2: "GND"});
  assert.ok(defs.get(R1.def).footprint.shapes.some(s => s.layer === "Silk") && defs.get(R1.def).footprint.shapes.some(s => s.style === "package"));
  assert.ok(nearP(R1.refAt, [-1, -1]));
  assert.ok(defs.get(J1.def).footprint.shapes.some(s => s.layer === "Bottom silk"), "mirrored silk swaps sides");
  const tracks = board.items.filter(i => i.kind === "track");
  assert.deepEqual(tracks.map(t => t.layer).sort(), ["Bottom", "Inner 1", "Top"]);
  assert.ok(tracks.every(t => t.net === "SIG" && t.width === .254));
  const vias = board.items.filter(i => i.kind === "via");
  assert.ok(near(vias.find(v => !v.fromLayer).diameter, .8064));
  assert.deepEqual([vias.find(v => v.fromLayer).fromLayer, vias.find(v => v.fromLayer).toLayer], ["Top", "Inner 1"]);
  const pour = board.items.find(i => i.kind === "polygon");
  assert.deepEqual([pour.layer, pour.net, pour.clearance, pour.pourIndex, pour.removeDeadCopper], ["Bottom", "GND", .4, 1, true]);
  AtriumPolygonPour.validate(pour);
  assert.ok(board.items.some(i => i.kind === "pad" && i.plated === false && i.drill === 3.2));
  assert.ok(board.items.some(i => i.kind === "label" && i.text === "ATRIUM" && i.layer === "Silk"));
  assert.ok(AtriumBoardShape.fresh(board));
  assert.equal(board.boardShape.cutouts.length, 1);
  assert.ok(board.boardShape.contour.some(s => s.kind === "arc"));
  for (const q of board.outline) if (q[0] < 10 && q[1] < -20) assert.ok(near(Math.hypot(q[0] - 10, q[1] + 20), 10, 2e-3), "rounded corner radius");
  const box = A.bounds(board.outline);
  assert.ok(nearP(box.slice(0, 2), [0, -30]) && nearP(box.slice(2), [50, 0]));
  const rules = AtriumRules.stored(board, p); // the board's rules in the project rule book
  assert.deepEqual(rules.defaults, {clearance: .2032, trackWidth: .254, viaDrill: .35});
  assert.deepEqual(rules.nets, {GND: {clearance: .3, trackWidth: .5, viaDrill: .4}});
  // The import exports to KiCad without losing copper.
  const k = AtriumKiCad.exportBoard(p, board);
  assert.deepEqual([k.counts.components, k.counts.pads, k.counts.vias, k.counts.segments], [2, 5, 2, 3]);
  console.log("PASS Eagle board: elements, mirrored parts, pads, vias, polygons, outline arcs and cutouts, classes and rules");
}

// ------------------------------------------------------------------ schematic
{
  const [r] = I.readSet([{name: "demo-eagle.sch", bytes: enc.encode(fixture("demo-eagle.sch"))}]);
  assert.equal(r.documents.length, 2);
  const p = A.project("Eagle"); p.documents = r.documents; p.library = r.library; AtriumImportLink.reconcile(p, p.documents); A.validate(p);
  const [s1, s2] = r.documents, defs = new Map(r.library.map(d => [d.id, d]));
  const pin = (doc, ref, n) => {
    for (const part of doc.items.filter(i => i.kind === "part" && i.ref === ref)) {
      const hit = A.pins(part, defs.get(part.def), "schematic").find(q => q.number === n);
      if (hit) return hit.at;
    }
    return null;
  };
  assert.ok(nearP(pin(s1, "R1", "2"), [25.4, -50.8]));
  assert.ok(nearP(pin(s1, "R2", "1"), [40.64, -40.64]) && nearP(pin(s1, "R2", "2"), [40.64, -50.8]), "rotated");
  assert.ok(nearP(pin(s1, "IC1", "3"), [53.34, -53.34]), "gate A +IN is pad 3");
  assert.ok(nearP(pin(s1, "IC1", "7"), [53.34, -25.4]) && nearP(pin(s1, "IC1", "5"), [68.58, -27.94]), "mirrored gate B");
  const ics = s1.items.filter(i => i.kind === "part" && i.ref === "IC1");
  assert.equal(ics.length, 2); assert.equal(ics[0].def, ics[1].def, "one gated definition");
  assert.deepEqual([defs.get(ics[0].def).symbol.parts, ics.map(i => [i.unit, !!i.mirror])], [2, [[1, false], [2, true]]]);
  assert.equal(A.gateLabel(ics[1], defs.get(ics[1].def)).ref, "IC1B");
  const gnd = s1.items.find(i => i.kind === "power");
  assert.deepEqual([gnd.text, gnd.style, gnd.direction, gnd.x, gnd.y], ["GND", "gnd", 3, 40.64, -38.1]);
  const label = s1.items.find(i => i.kind === "netlabel");
  assert.deepEqual([label.text, label.x, label.y], ["SIG", 45.72, -53.34]);
  assert.ok(s1.items.some(i => i.kind === "junction"));
  assert.ok(s1.items.some(i => i.kind === "label" && /fixture/.test(i.text)));
  const c = A.connectivity(s1, defs), net = (ref, n) => {
    for (const part of s1.items.filter(i => i.kind === "part" && i.ref === ref)) { const v = c.byPin.get(part.id + "/" + n); if (v) return v; }
    return null;
  };
  assert.equal(net("R1", "2"), "SIG"); assert.equal(net("R2", "2"), "SIG"); assert.equal(net("IC1", "3"), "SIG");
  assert.equal(net("R2", "1"), "GND");
  assert.equal(net("IC1", "1"), net("IC1", "7"));
  assert.ok(nearP(pin(s2, "R3", "2"), [25.4, -20.32]));
  assert.ok(s2.items.some(i => i.kind === "wire" && i.net === "SIG"), "cross-sheet net names");
  const R1 = s1.items.find(i => i.ref === "R1");
  assert.deepEqual([R1.value, defs.get(R1.def).footprintName, R1.link], ["10k", "R0603", "eagle-R1"]);
  assert.ok(nearP(R1.refAt, [-3.81, -1.4986]));
  console.log("PASS Eagle schematic: sheets, gates, mirrored and rotated symbols, supplies, labels and nets");
}
// Bad Eagle wire coordinates are skipped without replacing them with zero.
{
  const brd = `<?xml version="1.0"?><eagle version="9.6.2"><drawing><board>
    <plain><wire x1="oops" y1="10" x2="20" y2="10" width="0.2" layer="1"/></plain>
    <signals><signal name="SIG">
      <wire x1="5" y1="oops" x2="20" y2="10" width="0.2" layer="1"/>
      <wire x1="0" y1="8" x2="20" y2="8" width="0.2" layer="1"/>
    </signal></signals>
    </board></drawing></eagle>`;
  const [result] = I.readSet([{name: "bad-wires.brd", bytes: enc.encode(brd)}]);
  const tracks = result.documents[0].items.filter(i => i.kind === "track");
  assert.deepEqual(tracks.map(t => t.points), [[[0,-8],[20,-8]]]);
  assert.ok(result.notes.some(note => /malformed required values/.test(note)));
}

{
  const original = fixture("demo-eagle.sch");
  const bad = '<wire x1="oops" y1="10" x2="20" y2="10" width=".2" layer="94"/>';
  const good = '<wire x1="2" y1="10" x2="20" y2="10" width=".2" layer="94"/>';
  const sch = original.replace('<symbol name="R">', '<symbol name="R">' + bad)
    .replace('<plain>', '<plain>' + bad + good)
    .replace('<busses>', '<busses><bus name="A[1..2]"><segment>' + bad + good + '</segment></bus>')
    .replace('<net name="SIG" class="0">', '<net name="SIG" class="0"><segment>' + bad + good + '</segment>');
  const r = I.read("bad-wires.sch", enc.encode(sch));
  const items = r.documents[0].items;
  assert.ok(items.some(i => i.ref === "R1"), "a bad symbol stroke keeps its component");
  const part = items.find(i => i.ref === "R1"), def = r.library.find(d => d.id === part.def);
  assert.ok(def.symbol.pins.length && def.symbol.shapes.some(s => s.width === .254));
  for (const kind of ["bus", "graphic", "wire"]) {
    assert.ok(items.some(i => i.kind === kind && nearP(i.points[0],[2,-10]) && nearP(i.points[1],[20,-10])),
      kind + " keeps the valid wire");
    assert.ok(!items.some(i => i.kind === kind && nearP(i.points[0],[0,-10])),
      kind + " skips the bad wire");
  }
  assert.ok(r.notes.some(note => /malformed required values/.test(note)));
}

assert.throws(() => I.read("lib.sch", enc.encode('<?xml version="1.0"?><eagle><drawing><library/></drawing></eagle>')), /libraries/);
