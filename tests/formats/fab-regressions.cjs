"use strict";
// Regression tests for the fabrication-output review:
// H1-H3, M1-M6, L1/F12 and L2, with every module loaded as in the app.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "impedance", "rigid-flex", "rules", "viastack", "board-shape", "board-shape-editing", "polygon-pour", "drc-pours", "bom", "fab-outputs", "output-jobs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const {check} = require("./gerber-check.cjs");
const {compareLayer, compareOutlines, parseExcellon, parseGerber} = require("./gerber-compare.cjs");
const A = Atrium, F = AtriumFabOutputs, PP = AtriumPolygonPour, date = new Date(2026, 10, 18, 10, 30, 0);
function board(name) {
  const p = A.project(name, AtriumParts.catalogue), pcb = p.documents.find(d => d.kind === "pcb");
  pcb.name = name; pcb.outline = [[0, 0], [50, 0], [50, 40], [0, 40]];
  return {p, pcb, defs: () => new Map(p.library.map(d => [d.id, d]))};
}
const file = (out, suffix) => out.files.find(f => f.name.endsWith(suffix))?.content;
const ff = text => /%TF\.FileFunction,([^*]*)\*%/.exec(text)?.[1] ?? /TF\.FileFunction,(.*)/.exec(text)?.[1];

// ---- H1: the copper stack comes from the layer stack ------------------------
{
  const {p, pcb} = board("H1");
  pcb.stackup = {version: 1, layers: AtriumStackup.preset("4").layers};
  pcb.items.push({id: "v", kind: "via", x: 5, y: 5, diameter: .6, drill: .3, layer: "Multi", net: "GND"}, {id: "t", kind: "track", layer: "Top", width: .2, points: [[1, 1], [4, 4]]});
  const out = F.build(p, pcb, {date});
  assert.deepEqual(out.files.filter(f => f.kind === "gerber" && /\.(G\w\w|G\d)$/.test(f.name) && /Copper/.test(ff(f.content))).map(f => [f.name.split(".").pop(), ff(f.content)]),
    [["GTL", "Copper,L1,Top,Signal"], ["G1", "Copper,L2,Inr,Plane"], ["G2", "Copper,L3,Inr,Plane"], ["GBL", "Copper,L4,Bot,Signal"]], "empty plane layers are plotted");
  assert.equal(check(file(out, ".G1")).issues.length, 0);
  assert.equal(check(file(out, ".G1")).fs[1], 6);
  assert.equal(ff(file(out, "-Plated.TXT")), "Plated,1,4,PTH");
  assert.equal(out.model.stack.length, 4);
  // 6-layer stack with only Inner 3 used: Inner 3 is L4, every layer plotted.
  pcb.stackup = {version: 1, layers: AtriumStackup.preset("6").layers};
  pcb.items.push({id: "t3", kind: "track", layer: "Inner 3", width: .2, points: [[10, 10], [20, 10]]},
    {id: "b", kind: "via", x: 10, y: 10, diameter: .6, drill: .3, net: "A", fromLayer: "Top", toLayer: "Inner 3"});
  const six = F.build(p, pcb, {date});
  assert.equal(ff(file(six, ".G3")), "Copper,L4,Inr,Signal");
  assert.ok(["G1", "G2", "G3", "G4"].every(e => file(six, "." + e)));
  assert.equal(ff(file(six, "-Plated.TXT")), "Plated,1,6,PTH");
  assert.equal(ff(file(six, "-Plated-TOP-IN3.TXT")), "Plated,1,4,Blind");
  // Objects on a layer the stack lacks are reported.
  pcb.stackup = {version: 1, layers: AtriumStackup.preset("4").layers};
  const lost = F.build(p, pcb, {date});
  assert.ok(lost.warnings.some(w => /missing from the layer stack \(Inner 3\)/.test(w)));
  // No stored stack: Top, Inner 1 .. deepest used, Bottom; the type is omitted.
  delete pcb.stackup;
  const derived = F.build(p, pcb, {date});
  assert.deepEqual(derived.model.stack, ["Top", "Inner 1", "Inner 2", "Inner 3", "Bottom"]);
  assert.equal(ff(file(derived, ".G3")), "Copper,L4,Inr");
}

// ---- H2 and H3: pours ---------------------------------------------------------
{
  const {p, pcb, defs} = board("H2");
  pcb.rules = {format: "atrium-rules", version: 1, units: "mm", defaults: {clearance: .2, trackWidth: .15, viaDrill: .3}, nets: {}};
  const poly = PP.make([[0, 0], [50, 0], [50, 40], [0, 40]], {net: "GND", layer: "Top"});
  const v = {id: "v1", kind: "via", x: 25, y: 20, diameter: .6, drill: .3, layer: "Multi", net: "SIG"};
  pcb.items.push(v, poly, {id: "v2", kind: "via", x: 10, y: 30, diameter: .6, drill: .3, layer: "Multi", net: "GND"});
  PP.apply(pcb, defs());
  const plain = F.build(p, pcb, {date});
  assert.ok(!/%LPC\*%\n%ADD|LPC\*%\nX/.test(file(plain, ".GTL")), "no knockouts for plain vias");
  // A via stack with a 1.2 mm top land inside a pour cleared for 0.6 mm.
  v.stackMode = "tmb"; v.padStack = {Top: {diameter: 1.2}, Mid: {diameter: .6}, Bottom: {diameter: .6}};
  PP.apply(pcb, defs());
  const out = F.build(p, pcb, {date}), gtl = file(out, ".GTL");
  // Root fix: the pour itself now clears the 1.2 mm stack land, so no overlap and no safety-net knockout.
  assert.ok(!out.warnings.some(w => /overlapped copper pours of another net/.test(w)), "pour clears the stack land");
  assert.ok(!/%ADD(\d+)C,1\.6\*%/.test(gtl), "no knockout needed");
  const ring = pcb.pcbDrawing?.pours || [];
  void ring;
  assert.deepEqual(check(gtl).issues, []);
  // H3: a polygon setting change makes the stored pours stale.
  delete v.stackMode; delete v.padStack;
  PP.apply(pcb, defs());
  assert.equal(F.pourStatus(pcb, defs()), "current");
  poly.clearance = 1;
  assert.equal(F.pourStatus(pcb, defs()), "stale");
  // Stale copper is never plotted and never left out: the outputs carry the exact fill, made on a copy.
  const before = JSON.stringify(pcb), stale = F.build(p, pcb, {date});
  assert.equal(JSON.stringify(pcb), before, "the design is not changed by making outputs");
  assert.ok(stale.warnings.some(w => /filled again for these outputs/.test(w)), stale.warnings.join("\n"));
  const fixed = JSON.parse(before);
  PP.apply(fixed, defs());
  const strip = t => t.replace(/^%TF\.CreationDate.*$/m, "");
  assert.equal(strip(file(stale, ".GTL")), strip(file(F.build({...p, documents: p.documents.map(d => d === pcb ? fixed : d)}, fixed, {date}), ".GTL")), "the exact fill of the edited board");
  assert.ok(/G36/.test(file(stale, ".GTL")));
}

// ---- M1: mask and paste expansion from rules and pad overrides --------------
{
  const {p, pcb} = board("M1");
  pcb.items.push({id: "p1", kind: "pad", number: "1", x: 10, y: 5, w: 1, h: 1, shape: "rect", layer: "Top", net: "A", maskExpansion: 0, pasteExpansion: -.1},
    {id: "p2", kind: "pad", number: "2", x: 20, y: 5, w: 1, h: 1, shape: "rect", layer: "Top", net: "B"});
  const out = F.build(p, pcb, {date});
  assert.deepEqual(file(out, ".GTS").match(/%ADD\d+[^*]*\*%/g), ["%ADD10R,1X1*%", "%ADD11R,1.2032X1.2032*%"], "own 0, rule default 0.1016");
  assert.deepEqual(file(out, ".GTP").match(/%ADD\d+[^*]*\*%/g), ["%ADD10R,0.8X0.8*%", "%ADD11R,1X1*%"]);
  const over = F.build(p, pcb, {date, overrideExpansions: true, maskExpansion: .05});
  assert.deepEqual(file(over, ".GTS").match(/%ADD\d+[^*]*\*%/g), ["%ADD10R,1X1*%", "%ADD11R,1.1X1.1*%"], "override replaces rules, not pad values");
}

// ---- M2: Gerber format ------------------------------------------------------
{
  const {p, pcb} = board("M2");
  pcb.items.push({id: "t", kind: "track", layer: "Top", width: .2, points: [[1.234567, 1], [4, 4]]});
  const mm = F.build(p, pcb, {date}), inch = F.build(p, pcb, {date, units: "in"});
  assert.equal(mm.options.format, "4:6"); assert.equal(inch.options.format, "2:6");
  assert.match(file(mm, ".GTL"), /%FSLAX46Y46\*%/); assert.match(file(inch, ".GTL"), /%FSLAX26Y26\*%/);
  assert.match(file(mm, ".GTL"), /X1234567Y39000000D02\*/);
  assert.equal(F.build(p, pcb, {date, format: "9:9"}).options.format, "4:6");
  assert.match(file(F.build(p, pcb, {date, format: "4:4"}), "Readme.txt"), /format 4:4 \(legacy/);
}

// A profile aperture change affects both outline filenames and preserves their centerlines.
for (const [name, units, profileWidth] of [["Rectangular profile", "mm", .254], ["Arc profile", "in", .0254]]) {
  const {p, pcb} = board(name), S = AtriumBoardShape;
  const outline = width => {
    if (units === "mm") pcb.outline = [[0, 0], [width, 0], [width, 10], [0, 10]];
    else S.apply(pcb, S.addCutout(S.circle(width, [8, 8]), S.circle(2, [8, 8]).contour));
  };
  outline(12);
  pcb.items.push({id: "profile-test-via", kind: "via", layer: "Multi", x: 5, y: 5, diameter: .8, drill: .4});
  const opts = {date, units, origin: "absolute", layers: {GKO: true}};
  const plain = F.build(p, pcb, opts);
  pcb.layerNames = {"Mechanical 1": "Board Shape"};
  pcb.items.push({id: "nearby-art", kind: "graphic", layer: "Mechanical 1", width: .381, closed: true,
    points: pcb.outline.map(([x, y]) => [x + .04, y + .04])});
  const before = F.build(p, pcb, opts);
  const wide = F.build(p, pcb, {...opts, profileWidth});
  outline(13);
  const moved = F.build(p, pcb, {...opts, profileWidth});
  for (const ext of [".GM1", ".GKO"]) {
    assert.equal(file(before, ext), file(plain, ext), "a nearby mechanical loop is not a profile aperture setting");
    const changed = compareLayer(file(before, ext), file(wide, ext), {vector: false});
    assert.ok(changed.raw.xorArea > .1, "a changed pen is visible in the raw image");
    assert.ok(compareOutlines(changed.ref, changed.out).maxDev < 1e-9);
    assert.ok(changed.out.draws.every(d => Math.abs(d.width - profileWidth) < 1e-8));
    const movedEdge = compareLayer(file(wide, ext), file(moved, ext), {vector: false});
    assert.ok(movedEdge.raw.xorArea > .1);
    assert.ok(compareOutlines(movedEdge.ref, movedEdge.out).maxDev > .4, "the same pen detects a moved centerline");
    assert.equal(compareOutlines(movedEdge.ref, movedEdge.out).refWidth, compareOutlines(movedEdge.ref, movedEdge.out).outWidth);
    if (units === "in") assert.equal(changed.out.draws.length, 4, "two semicircles each for the edge and cutout");
  }
  const elsewhere = f => !/\.GM1$|\.GKO$|Readme\.txt$/.test(f.name);
  assert.deepEqual(wide.files.filter(elsewhere), before.files.filter(elsewhere));
  assert.ok(file(wide, "Readme.txt").includes("Gerber profile stroke width: " + profileWidth + " mm."));
  assert.equal(before.options.profileWidth, .1);
  for (const invalid of ["0.1", NaN, Infinity, -1, 0, 1e-20, 1e30]) assert.throws(() => F.build(p, pcb, {...opts, profileWidth: invalid}), /profile stroke width/i);
}

// ---- M3: region holes use horizontal cut-ins ------------------------------------
{
  const {p, pcb} = board("M3");
  pcb.items.push({id: "k1", kind: "label", text: "OAB8", x: 5, y: 20, size: 2, inverted: true, margin: .4, layer: "Silk"},
    {id: "k2", kind: "label", text: "PCB 08", x: 5, y: 10, size: 2, inverted: true, margin: .4, angle: 30, layer: "Silk"},
    {id: "k3", kind: "label", text: "B8", x: 30, y: 30, size: 2, inverted: true, margin: .4, angle: 90, layer: "Top"});
  const out = F.build(p, pcb, {date});
  for (const ext of [".GTO", ".GTL"]) {
    const r = check(file(out, ext));
    assert.deepEqual(r.issues, [], ext);
    assert.ok(r.cutIns >= 2, ext + " has cut-ins");
  }
  assert.ok(!/LPC/.test(file(out, ".GTO")), "no clear-polarity fallback needed");
  // Direct: a square hole joins the outer ring through one horizontal cut-in.
  const sq = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const c = F.cutIns(sq(0, 0, 100, 100), [sq(20, 20, 40, 40), sq(60, 50, 80, 70)]);
  assert.deepEqual(c.failed, []);
  const t = "%FSLAX46Y46*%\n%MOMM*%\nG01*\nG36*\n" + [...c.ring, c.ring[0]].map((q, i) => "X" + q[0] + "Y" + q[1] + (i ? "D01*" : "D02*")).join("\n") + "\nG37*\nM02*\n";
  assert.deepEqual(check(t).issues, []); assert.equal(check(t).cutIns, 2);
  // A hole whose ray starts on the outer edge cannot take a cut-in.
  assert.equal(F.cutIns(sq(0, 0, 100, 100), [[[50, 10], [100, 50], [50, 90]]]).failed.length, 1);
}

// ---- M4: board origin ------------------------------------------------------
{
  const {p, pcb} = board("M4");
  pcb.items.push({id: "v", kind: "via", x: 5, y: 5, diameter: .6, drill: .3, layer: "Multi", net: "A"});
  assert.match(file(F.build(p, pcb, {date}), "-Plated.TXT"), /^X5\.0Y35\.0$/m);
  pcb.origin = [10, 30];
  const out = F.build(p, pcb, {date});
  assert.match(file(out, "-Plated.TXT"), /^X-5\.0Y25\.0$/m);
  assert.match(file(out, "-Plated.TXT"), /;ORIGIN=board origin/);
  assert.match(file(out, ".GTL"), /X-5000000Y25000000D03\*/);
  assert.match(file(out, "Readme.txt"), /board origin \(Edit > Origin\)/);
  assert.match(file(F.build(p, pcb, {date, origin: "outline"}), "-Plated.TXT"), /^X5\.0Y35\.0$/m);
  assert.match(file(F.build(p, pcb, {date, origin: "absolute"}), "-Plated.TXT"), /^X5\.0Y-5\.0$/m);
}

// ---- M5 and L2: drill tools --------------------------------------------------
{
  const {p, pcb} = board("M5");
  pcb.items.push({id: "v1", kind: "via", x: 5, y: 5, diameter: .6, drill: .3, layer: "Multi", net: "A", ipc4761: "VII"},
    {id: "v2", kind: "via", x: 6, y: 5, diameter: 1.2, drill: .8, layer: "Multi", net: "A"},
    {id: "p1", kind: "pad", number: "1", x: 10, y: 5, w: 1.6, h: 1.6, drill: .8, layer: "Multi", net: "B"},
    {id: "p3", kind: "pad", number: "3", x: 14, y: 5, w: 1.6, h: 1.6, drill: .8004, layer: "Multi", net: "B"});
  const drill = file(F.build(p, pcb, {date}), "-Plated.TXT"), tools = drill.split("\n").filter(l => /^; #@! TA|^T\d+C/.test(l));
  assert.deepEqual(tools, ["; #@! TA.AperFunction,ViaDrill,VII", "T01C0.300", "; #@! TA.AperFunction,ViaDrill", "T02C0.800", "; #@! TA.AperFunction,ComponentDrill", "T03C0.800"]);
  assert.match(drill, /^T03\nX10\.0Y35\.0\nX14\.0Y35\.0$/m, "0.8 and 0.8004 share the printed tool");
  // Untagged files merge equal printed sizes.
  delete pcb.items[0].ipc4761;
  const plain = file(F.build(p, pcb, {date, drillUnits: "in"}), "-Plated.TXT");
  assert.deepEqual(plain.split("\n").filter(l => /^T\d+C/.test(l)), ["T01C0.0118", "T02C0.0315"]);
  assert.ok(!/AperFunction/.test(plain));
}

// ---- M6, L1 and F12: pick and place ------------------------------------------
{
  const {p, pcb} = board("=HYPERLINK(\"http://x\")");
  p.library.push({id: "fp", name: "T", footprint: {name: "FP", pads: [{number: "1", x: 0, y: 0, w: 1, h: 1, shape: "rect"}], shapes: []}});
  pcb.items.push({id: "u1", kind: "part", def: "fp", ref: "U1", value: "-2+3", x: 10, y: 10, angle: 0, layer: "Top"},
    {id: "u2", kind: "part", def: "fp", ref: "U2", value: "-5", x: 12, y: 10, angle: 0, layer: "Top"},
    {id: "u4", kind: "part", def: "fp", ref: "U4", value: "10k", x: 30, y: 22, angle: 0, layer: "Top", dnp: true},
    {id: "u5", kind: "part", def: "fp", ref: "U5", value: "10k DNP", x: 32, y: 22, angle: 0, layer: "Top"});
  const out = F.build(p, pcb, {date}), lines = file(out, ".csv").split("\r\n");
  assert.equal(lines[1], "\"'=HYPERLINK(\"\"http://x\"\")\"", "board name is a guarded, quoted cell");
  assert.ok(lines.some(l => l.startsWith("\"U1\",\"'-2+3\"")), "leading minus is guarded");
  assert.ok(lines.some(l => l.startsWith("\"U2\",\"-5\"")), "plain numbers are not");
  assert.ok(!lines.some(l => /^"U[45]"/.test(l)), "DNP parts are not placed");
  assert.ok(out.warnings.some(w => /pick and place file: U4, U5\./.test(w)));
  assert.match(file(out, "Readme.txt"), /U4, U5/);
  const bom = AtriumBOM.collect(p, {source: "pcb", board: pcb.id});
  assert.deepEqual(bom.dnp.map(e => e.ref).sort(), ["U4", "U5"], "the BOM marks the same parts DNP");
  // Without bom.js the item flags still apply.
  const keep = globalThis.AtriumBOM; globalThis.AtriumBOM = undefined;
  try { assert.deepEqual([...F.analyse(p, pcb).dnp].map(i => i.ref), ["U4"]); } finally { globalThis.AtriumBOM = keep; }
}
// ---- Rigid-flex: coverlay/stiffener Gerbers and per-substack drill files -----
{
  const S = AtriumStackup, RF = AtriumRigidFlex;
  const p = A.project("Flex", []), doc = p.documents.find(d => d.kind === "pcb");
  doc.name = "Flex"; doc.outline = [[0, 0], [60, 0], [60, 20], [0, 20]];
  const st = S.preset(4); delete st.derived;
  const cu = st.layers.filter(S.isCopper);
  st.substacks = [{id: "flex", name: "Flex 2L", flex: true, layers: S.flexLayers(["Top", "Bottom"], cu)},
    {id: "flex-stiff", name: "Flex + stiffener", flex: true, layers: [...S.flexLayers(["Top", "Bottom"], cu), {type: "Stiffener", name: "Bottom Stiffener", material: "FR-4", thickness: .3}]}];
  doc.stackup = JSON.parse(JSON.stringify(st));
  S.splitRegion(doc, {a: [20, 0], b: [20, 20]}); S.splitRegion(doc, [[40, -1], [40, 21]]);
  const regs = RF.regions(doc);
  S.assignStack(doc, regs.find(g => RF.geometry.inside([30, 10], g.points)).id, "flex");
  S.assignStack(doc, regs.find(g => RF.geometry.inside([50, 10], g.points)).id, "flex-stiff");
  doc.items.push({id: "v1", kind: "via", x: 30, y: 10, diameter: .6, drill: .3, layer: "Multi", net: "S"},
    {id: "v2", kind: "via", x: 10, y: 10, diameter: .6, drill: .3, layer: "Multi", net: "S"});
  const out = F.build(p, doc, {date}), names = out.files.map(f => f.name);
  assert.deepEqual(names.filter(n => /\.TXT$/.test(n) && !/Readme/.test(n)), ["Flex-Plated.TXT", "Flex-Plated-Flex2L.TXT"]);
  assert.match(file(out, "-Plated-Flex2L.TXT"), /^;SUBSTACK=Flex 2L \(copper Top, Bottom\)$/m);
  assert.match(file(out, "-Plated-Flex2L.TXT"), /^X30\.0Y10\.0$/m); assert.doesNotMatch(file(out, "-Plated-Flex2L.TXT"), /^X10\.0/m);
  // A through hole in a flex region is a through drill (PTH) of its substack, not a blind one.
  assert.match(file(out, "-Plated-Flex2L.TXT"), /^;DRILL_PAIR=.* \(through\)$/m);
  assert.equal(ff(file(out, "-Plated-Flex2L.TXT")), "Plated,1,4,PTH");
  assert.match(file(out, "-DrillReport.txt"), /File: Flex-Plated-Flex2L\.TXT\r\n  X2 file function: Plated,1,4,PTH\r\n/);
  // Its non-plated holes are a mechanical drill and sort after the plated files.
  doc.items.push({id: "m1", kind: "pad", number: "", x: 32, y: 10, w: 1, h: 1, shape: "round", drill: 1, layer: "Multi", plated: false},
    {id: "m2", kind: "pad", number: "", x: 12, y: 10, w: 1, h: 1, shape: "round", drill: 1, layer: "Multi", plated: false});
  const mixed = F.build(p, doc, {date});
  assert.deepEqual(mixed.files.map(f => f.name).filter(n => /\.TXT$/.test(n) && !/Readme/.test(n)),
    ["Flex-Plated.TXT", "Flex-Plated-Flex2L.TXT", "Flex-NonPlated.TXT", "Flex-NonPlated-Flex2L.TXT"]);
  assert.equal(ff(file(mixed, "-NonPlated-Flex2L.TXT")), "NonPlated,1,4,NPTH");
  assert.deepEqual(["GCT", "GCB", "GSTB", "GM15"].map(e => ff(file(out, "." + e))), ["Other,CoverlayTop", "Other,CoverlayBot", "Other,StiffenerBot", "OtherDrawing,BoardRegions"]);
  for (const f of out.files.filter(f => f.kind === "gerber")) assert.deepEqual(check(f.content).issues, [], f.name);
}
// ---- The drill report names the origin the NC drill files use (drillOrigin), not the Gerber one.
{
  const {p, pcb} = board("Origins");
  pcb.outline = [[10, 10], [50, 10], [50, 40], [10, 40]];
  pcb.items.push({id: "v", kind: "via", x: 5, y: 5, diameter: .6, drill: .3, layer: "Multi", net: "GND"});
  const out = F.build(p, pcb, {date, origin: "outline", drillOrigin: "absolute"}), report = file(out, "-DrillReport.txt");
  assert.match(file(out, "-Plated.TXT"), /^;ORIGIN=design origin$/m);
  assert.match(file(out, "-Plated.TXT"), /^X5\.0Y-5\.0$/m);
  assert.match(report, /Coordinates: design origin, viewed from the top/);
  assert.doesNotMatch(report, /lower-left/);
  assert.match(file(out, "-Fabrication-Readme.txt"), /NC drill coordinates: design origin/);
  // A shared drill origin follows the Gerber origin in every file.
  const shared = F.build(p, pcb, {date, origin: "outline"});
  assert.match(file(shared, "-Plated.TXT"), /^X-5\.0Y35\.0$/m);
  assert.match(file(shared, "-DrillReport.txt"), /Coordinates: lower-left corner of the board outline/);
}
// ---- A region that bridges its hole along one of its own edges (the PiDP-11 overlay logo):
// the bridge passes an outer vertex and back-tracks over the step to it.
// The writer splits the edge and drops the spike, so the contour is a valid cut-in (§4.10.3).
{
  const {p, pcb} = board("Bridge");
  const pts = [[0, 0], [0, 10], [8, 10], [8, 6], [9, 6], [3, 6], [2, 3], [5, 2], [3, 6], [9, 6], [9, 0]].map(q => [q[0] + 10, 30 - q[1]]);
  pcb.items.push({id: "logo", kind: "graphic", layer: "Silk", closed: true, fill: true, width: 0, points: pts});
  const gto = file(F.build(p, pcb, {date}), ".GTO");
  assert.deepEqual(check(gto).issues, []);
  assert.equal((gto.match(/G36\*/g) || []).length, 1);
  // The same contour without the defect is written vertex for vertex.
  const ok = [[0, 0], [0, 10], [8, 10], [8, 6], [9, 6], [9, 0]].map(q => [q[0] + 10, 30 - q[1]]);
  pcb.items.find(i => i.id === "logo").points = ok;
  const plain = file(F.build(p, pcb, {date}), ".GTO");
  assert.equal(plain.slice(plain.indexOf("G36*"), plain.indexOf("G37*")).split("\n").length, ok.length + 3);
}
// Isolated positive lands can be dropped only by an explicit output option.
{
  const {p,pcb,defs} = board("Inner lands");
  pcb.stackup = {version:1,layers:AtriumStackup.preset("4").layers};
  const via = (id,x,extra) => ({id,kind:"via",x,y:6,diameter:.6,drill:.3,layer:"Multi",net:"SIGNAL",...extra});
  const pad = (id,x,extra) => ({id,kind:"pad",x,y:6,w:1,h:1,shape:"round",drill:.4,layer:"Multi",number:id,plated:true,net:"FILL",...extra});
  const track = (id,x,dy) => ({id,kind:"track",layer:"Inner 1",width:.25,points:[[x-1,6+dy],[x+1,6+dy]]});
  const fill = PP.make([[17,4],[22,4],[22,9],[17,9]],{net:"FILL",layer:"Inner 1",connectStyle:"direct",removeDeadCopper:false});
  pcb.items.push(via("isolated",2),via("track-touch",6),via("uncertain-edge",10),via("clear-track",14),
    pad("filled",20),pad("isolated-pad",25),pad("unplated",29,{plated:false}),pad("slot",32,{slotLength:.8}),
    via("blind",35,{fromLayer:"Top",toLayer:"Inner 1"}),via("complex",38,{stackMode:"full",padStack:{"Inner 1":{diameter:.7}}}),
    via("overlap-a",41),via("overlap-b",41.55,{net:"OTHER"}),
    track("track-a",6,.41),track("track-b",10,.429),track("track-c",14,.44),fill);
  PP.apply(pcb,defs(),{project:p});
  const opts = {date,origin:"absolute"}, selected = {...opts,omitUnconnectedMidLayerPads:true};
  const before = F.build(p,pcb,opts), after = F.build(p,pcb,selected);
  const centres = text => parseGerber(typeof text === "string" ? text : new TextDecoder().decode(text)).flashes.map(row => row.x).sort((a,b) => a-b);
  assert.deepEqual(centres(file(before,".G1")),[2,6,10,14,20,25,29,32,35,38,41,41.55]);
  assert.deepEqual(centres(file(after,".G1")),[6,10,20,29,32,35,38,41,41.55]);
  assert.deepEqual(centres(file(after,".G2")),[29,32,38,41,41.55]);
  assert.ok(after.model.layers.get("Inner 1").some(row => row.t === "pour"));
  for (const ext of [".GTL",".GBL",".GTS",".GBS",".GM1","-Plated.TXT","-NonPlated.TXT"]) {
    assert.ok(file(before,ext));
    assert.equal(file(after,ext),file(before,ext),ext);
  }
  const J = AtriumOutputJobs;
  J.save(p,{name:"Production",outputs:[{kind:"gerber",options:{origin:"absolute",readme:false,omitUnconnectedMidLayerPads:true}}]});
  const saved = J.run(p,"Production",{date});
  assert.deepEqual(centres(saved.files.find(f => f.name.endsWith(".G1")).data),centres(file(after,".G1")));
  assert.equal(J.find(p,"Production").outputs[0].options.omitUnconnectedMidLayerPads,true);

  // A panel can add copper around a child and has a different contact graph.
  require("../../app/pcb/panel.js");
  const P = AtriumPanel, panel = P.create(p,{board:pcb.id,rows:1,cols:2,gapX:4,gapY:4});
  p.documents.push(panel);
  const array = P.build(p,panel,opts), guarded = P.build(p,panel,selected);
  assert.ok(guarded.warnings.some(w => w.includes("Panel output retains inner-layer lands")));
  assert.deepEqual(centres(file(guarded,".G1")),centres(file(array,".G1")));

  // True region arcs may reconstruct differently in the two writers. Keep
  // all candidate lands on that layer, and still analyse the other layer.
  const S = AtriumBoardShape, shape = S.circle(1,[40,15]), points = S.flattenContour(shape.contour);
  pcb.items.push({id:"curved-region",kind:"graphic",layer:"Inner 1",fill:true,closed:true,points,
    regionShape:{...shape,sig:S.signature(points)}});
  const uncertain = F.build(p,pcb,selected);
  assert.deepEqual(centres(file(uncertain,".G1")),centres(file(before,".G1")));
  assert.deepEqual(centres(file(uncertain,".G2")),centres(file(after,".G2")));
  assert.ok(uncertain.warnings.some(w => w.includes("copper contact could not be verified")));
}
// A footprint's slotted drill transforms with its copper when mirrored.
{
  const {p, pcb, defs} = board("Mirrored slot");
  const pad = {number: "1", x: 1, y: .5, w: 4, h: 2, shape: "rect", angle: 15,
    drill: .6, slotLength: 3, slotAngle: 20, layer: "Multi"};
  p.library.push({id: "slot-fp", name: "Slot", footprint: {pads: [pad], shapes: []}});
  const part = {id: "slot-part", kind: "part", def: "slot-fp", ref: "J1", x: 20, y: 20,
    angle: 30, mirror: true, layer: "Top", pinNets: {}};
  pcb.items.push(part);
  const out = F.build(p, pcb, {date, origin: "absolute"});
  const [slot] = parseExcellon(file(out, "-Plated.TXT")).slots;
  assert.ok(slot, "the mirrored footprint produces a plated slot");
  assert.equal(slot.d, pad.drill);
  const half = (pad.slotLength - pad.drill) / 2;
  const expected = [-half, half].map(n => {
    const [dx, dy] = A.rotate([n, 0], pad.angle + pad.slotAngle);
    const [x, y] = A.world([pad.x + dx, pad.y + dy], part);
    return [x, -y];
  });
  for (const [x, y] of expected)
    assert.ok([slot.a, slot.b].some(([u, v]) => Math.hypot(x - u, y - v) < .001),
      "the Excellon slot follows the reflected footprint axis");
  const [hole] = AtriumRules.kit.extract(pcb, defs()).holes;
  assert.ok(hole);
  for (const [x, y] of expected)
    assert.ok(hole.core.some(([u, v]) => Math.hypot(x - u, -y - v) < .000001),
      "DRC checks the same reflected slot as Excellon");
  assert.equal(AtriumPCBAppearance.padTurn(pad, part), part.angle - pad.angle);
}

console.log("fab-regressions: ok");
