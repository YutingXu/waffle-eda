"use strict";
// Drill output from the layer stack's drill pairs (fab-outputs.js): one Excellon
// file per pair in use (through, blind, buried, microvia, back-drill), PTH and
// NPTH apart, X2 headers, pairs the stack does not define flagged (and refused
// with strictLayers), the drill drawing (Gerber Drillmap, symbol per tool and a
// table) and the drill report.
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "spatial", "pcb-pours", "pcb-appearance", "zip", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "rules", "viastack", "board-shape", "polygon-pour", "bom", "fab-outputs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const {check} = require("../formats/gerber-check.cjs");
const A = Atrium, F = AtriumFabOutputs, S = AtriumStackup, date = new Date(2026, 10, 18, 10, 30, 0);
const file = (out, suffix) => out.files.find(f => f.name.endsWith(suffix))?.content;
const header = (text, name) => (new RegExp("^; #@! " + name.replace(".", "\\.") + ",(.*)$", "m").exec(text) || [])[1];
const hits = text => text.split("\n").filter(l => /^X-?[\d.]+Y-?[\d.]+$/.test(l));

const p = A.project("Pairs", AtriumParts.catalogue), pcb = p.documents.find(d => d.kind === "pcb");
pcb.name = "Pairs"; pcb.outline = [[0, 0], [60, 0], [60, 30], [0, 30]];
// Six copper layers; Top–Inner 2 and the Top–Inner 1 microvia pair are defined, Inner 1–Inner 4 is not.
pcb.stackup = {version: 1, layers: S.preset("6").layers, drillPairs: [{from: "Top", to: "Inner 2"}, {from: "Top", to: "Inner 1"}]};
const via = (id, x, extra = {}) => ({kind: "via", id, x, y: 10, diameter: .6, drill: .3, layer: "Multi", net: "N", ...extra});
for (const [i, l] of ["Inner 1", "Inner 2", "Inner 3", "Inner 4"].entries()) pcb.items.push({kind: "track", id: "t" + i, net: "N", layer: l, width: .2, points: [[1, 2 + i], [3, 2 + i]]});
pcb.items.push(via("through", 5), via("through2", 7, {drill: .4, diameter: .8}),
  via("blind", 10, {fromLayer: "Top", toLayer: "Inner 2"}),
  via("buried", 13, {fromLayer: "Inner 1", toLayer: "Inner 4"}), via("buried2", 15, {fromLayer: "Inner 1", toLayer: "Inner 4"}),
  via("micro", 18, {diameter: .25, drill: .1, fromLayer: "Top", toLayer: "Inner 1"}),
  via("bd", 21, {backdrill: {from: "bottom", toLayer: "Inner 2", stubMax: .15, diameter: .55}}),
  {kind: "pad", id: "h1", number: "", x: 30, y: 20, w: 3, h: 3, drill: 3, shape: "round", layer: "Multi", plated: false},
  {kind: "pad", id: "p1", number: "1", x: 34, y: 20, w: 1.6, h: 1.6, drill: .9, shape: "round", layer: "Multi", net: "N"});
const defs = new Map(p.library.map(d => [d.id, d]));
const pairs = S.drillPairs(pcb, defs);
const out = F.build(p, pcb, {date}), names = out.files.map(f => f.name);

// ---- One file per drill pair in use --------------------------------------------
const drills = out.files.filter(f => f.kind === "drill").map(f => f.name);
assert.deepEqual(drills, ["Pairs-Plated.TXT", "Pairs-Microvia-TOP-IN1.TXT", "Pairs-Plated-TOP-IN2.TXT", "Pairs-Plated-IN1-IN4.TXT", "Pairs-BackDrill-IN3-BOT.TXT", "Pairs-NonPlated.TXT"]);
for (const pr of pairs.filter(q => q.used && q.vias)) assert.ok(out.model.drills.some(h => out.model.stack[h.span[0]] === pr.from && out.model.stack[h.span[1]] === pr.to), pr.name);
const fn = suffix => header(file(out, suffix), "TF.FileFunction");
assert.equal(fn("-Plated.TXT"), "Plated,1,6,PTH");
assert.equal(fn("-Plated-TOP-IN2.TXT"), "Plated,1,3,Blind");
assert.equal(fn("-Plated-TOP-IN2.TXT"), pairs.find(q => q.from === "Top" && q.to === "Inner 2").fileFunction, "the stack's drill pair function");
assert.equal(fn("-Plated-IN1-IN4.TXT"), "Plated,2,5,Buried");
assert.equal(fn("-Microvia-TOP-IN1.TXT"), "Plated,1,2,Blind,Drill");
assert.equal(fn("-BackDrill-IN3-BOT.TXT"), "NonPlated,6,4,Blind,Drill");
assert.equal(fn("-NonPlated.TXT"), "NonPlated,1,6,NPTH");
for (const f of drills) {
  const t = file(out, f);
  assert.equal(header(t, "TF.FilePolarity"), "Positive", f);
  assert.equal(header(t, "TF.CreationDate"), F.isoDate(date), f);
  assert.equal(header(t, "TF.GenerationSoftware"), "Waffle,Waffle," + F.VERSION, f);
  assert.equal(t.trim().split("\n").at(-1), "M30", f);
}
// PTH and NPTH never share a file; hit counts per file.
assert.equal(hits(file(out, "-Plated.TXT")).length, 4, "two through vias, the plated pad, the back-drilled via barrel");
assert.equal(hits(file(out, "-NonPlated.TXT")).length, 1);
assert.equal(hits(file(out, "-Plated-IN1-IN4.TXT")).length, 2);
assert.match(file(out, "-NonPlated.TXT"), /^;TYPE=NON_PLATED$/m);
assert.match(file(out, "-Plated-TOP-IN2.TXT"), /^;DRILL_PAIR=Top Layer - Layer 3 \(blind\)$|^;DRILL_PAIR=.* \(blind\)$/m);
assert.match(file(out, "-Plated-IN1-IN4.TXT"), /^;DRILL_PAIR=.* \(buried, not a drill pair of the layer stack\)$/m);
assert.match(file(out, "-BackDrill-IN3-BOT.TXT"), /^;BACKDRILL=from bottom; keep Inner 2; max stub 0\.15 mm$/m);
assert.match(file(out, "-BackDrill-IN3-BOT.TXT"), /^; #@! TA\.AperFunction,BackDrill$/m);

// ---- Pairs the stack does not define: flagged, or refused when strict ----------
assert.deepEqual(out.model.layerIssues, [{kind: "drillPair", from: "Inner 1", to: "Inner 4", count: 2, action: "flagged"}]);
assert.ok(out.warnings.some(w => /^Holes from .* are not on a drill pair of the layer stack/.test(w) && /\(2 instances\)/.test(w)), out.warnings.join("; "));
assert.deepEqual(F.layerCheck(p, pcb), out.model.layerIssues);
assert.throws(() => F.build(p, pcb, {date, strictLayers: true}), /does not allow 2 holes from/);
// A derived stack (no stored stack) has no drill pairs to check.
{
  const q = JSON.parse(JSON.stringify(p)), b = q.documents.find(d => d.kind === "pcb");
  delete b.stackup;
  assert.deepEqual(F.layerCheck(q, b), []);
}

// ---- Drill drawing: Gerber Drillmap, a symbol per tool, a drill table ----------
const map = file(out, ".GD1");
assert.ok(map && names.includes("Pairs.GD1"));
assert.deepEqual(check(map, {x2: true}).issues, []);
assert.match(map, /^%TF\.FileFunction,Drillmap\*%$/m);
assert.doesNotMatch(map, /%TO\./);
const table = F.drillMapLayer(out.model, F.settle({date}));
const tools = out.files.filter(f => f.kind === "drill").reduce((n, f) => n + f.tools.length, 0);
assert.equal(table.count, tools, "one table row and symbol per tool across all drill files");
// Every hole is marked: the drawing has at least one stroke or circle per hit.
const marks = (map.match(/D01\*/g) || []).length;
assert.ok(marks > out.model.drills.length * 2, "symbols drawn at hits: " + marks);
// ---- Drill report ---------------------------------------------------------------
const report = file(out, "-DrillReport.txt");
for (const f of drills) assert.match(report, new RegExp("^File: " + f.replace(/[.]/g, "\\.") + "\\r?$", "m"));
assert.match(report, /X2 file function: Plated,2,5,Buried/);
assert.match(report, /not a drill pair of the layer stack/);
assert.match(report, /aspect ratio [\d.]+:1 over [\d.]+ mm/);
assert.match(report, /^Total: 6 drill files, \d+ tools, 10 holes\.\r$/m);
assert.match(report, /^Drill pairs to check:\r$/m);
assert.ok(report.includes("\r\n") && !/\r(?!\n)/.test(report));
// Deterministic and optional.
assert.equal(F.build(p, pcb, {date}).files.map(f => f.content).join("\u0000"), out.files.map(f => f.content).join("\u0000"));
const bare = F.build(p, pcb, {date, drillDrawing: false, drillReport: false});
assert.ok(!bare.files.some(f => f.kind === "drillmap" || f.kind === "drillreport"));
// Inch drill units: sizes in the table and the report follow.
const inch = F.build(p, pcb, {date, drillUnits: "in"});
assert.match(file(inch, "-DrillReport.txt"), /Size \(in\)/);
assert.deepEqual(check(file(inch, ".GD1"), {x2: true}).issues, []);
// Many tools: symbols run out of shapes and continue with letters.
{
  const q = A.project("Many", AtriumParts.catalogue), b = q.documents.find(d => d.kind === "pcb");
  b.name = "Many"; b.outline = [[0, 0], [80, 0], [80, 20], [0, 20]];
  for (let i = 0; i < 20; i++) b.items.push({kind: "via", id: "v" + i, x: 2 + i * 3.5, y: 10, diameter: 1.2, drill: .2 + i * .05, layer: "Multi", net: "N"});
  const r = F.build(q, b, {date});
  assert.deepEqual(check(file(r, ".GD1"), {x2: true}).issues, []);
  const rep = file(r, "-DrillReport.txt");
  assert.match(rep, /hexagon with x/); assert.match(rep, /letter A\r$/m); assert.match(rep, /letter E\r$/m);
}
// The sample board's drill drawing passes too.
{
  const s = AtriumParts.example(), r = F.build(s, s.documents[1], {date});
  assert.deepEqual(check(file(r, ".GD1"), {x2: true}).issues, []);
  assert.match(file(r, "-DrillReport.txt"), /^File: Sensor board-NonPlated\.TXT\r$/m);
}
console.log("drill-pairs: ok");
