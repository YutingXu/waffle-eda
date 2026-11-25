"use strict";
// Negation overlines (docs/getting-started.md, "Active-low names"): single "\" negation (on by default,
// Preferences › Schematic › General) and Altium's per-character R\E\S\E\T\, in both modes. Display only:
// the drawing loses the backslashes and gains a bar; nets, netlists and the net-intent classifier read the
// raw name. Covers the rendering geometry (schematic labels, ports, power ports, pin names, sheet entries,
// off-sheet connectors, PCB stroke text on silk and the PDF recorder), connectivity and netlists, and the
// classifier's "\" prefix evidence. Run: node tests/core/negation.cjs
const assert = require("node:assert/strict");
for (const m of ["model", "parts", "sch-objects", "hierarchy", "sch-appearance", "pcb-text", "net-intent", "altium-rules", "query", "signals", "rules",
  "net-intent-index", "pcb-appearance", "pcb-edit", "eco", "library-panel", "footprint-wizard", "starter-library", "netlist", "canvas", "path-record", "pdf", "print"])
  require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, S = AtriumSchAppearance, O = AtriumSchObjects, T = AtriumPCBText, NI = AtriumNetIntent, X = AtriumNetIntentIndex, NL = AtriumNetlist;
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log("ok - " + name); };
const mode = (on, fn) => { const was = S.singleNegation(); S.singleNegation(on); try { return fn(); } finally { S.singleNegation(was); } };

// A recording context: fillText strings and fillRect bars (x, width) in local text units (1 per character).
function recorder() {
  const r = {text: [], bars: []};
  r.ctx = {save() {}, restore() {}, translate() {}, rotate() {}, scale() {}, getTransform() { return {a: 10, b: 0, c: 0, d: 10, e: 0, f: 0}; },
    measureText(s) { return {width: s.length, actualBoundingBoxAscent: 1.5}; }, fillText(t) { r.text.push(t); }, fillRect(x, y, w) { r.bars.push([x, w]); },
    beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, closePath() {}, arc() {}, fill() {}, rect() {}, setLineDash() {}, drawImage() {}};
  return r;
}

test("the parser: whole-name and per-character negation in both modes, and the \\\\ escape", () => {
  const n = (t, on) => { const r = S.negation(t, on); return [r.text, r.all ? "all" : (r.bars || []).join(",")]; };
  assert.deepEqual(n("\\RESET", true), ["RESET", "all"]);
  assert.deepEqual(n("\\RESET", false), ["\\RESET", ""], "off: a leading backslash is literal (Altium's default)");
  for (const on of [true, false]) {
    assert.deepEqual(n("R\\E\\S\\E\\T\\", on), ["RESET", "0,1,2,3,4"], "per-character works with the option " + on);
    assert.deepEqual(n("C\\S\\_EN", on), ["CS_EN", "0,1"]);
    assert.deepEqual(n("RESET", on), ["RESET", ""]);
    assert.deepEqual(n("\\", on), ["\\", ""], "a lone backslash is literal");
  }
  assert.deepEqual(n("\\R\\E\\S\\E\\T\\", true), ["RESET", "all"], "a leading \\ bars the whole name; inner marks are dropped");
  assert.deepEqual(n("\\\\RESET", true), ["\\RESET", ""], "\\\\ at the start writes one literal backslash");
  assert.deepEqual(n("\\\\C\\S\\", true), ["\\CS", "1,2"], "after the escape the per-character rule applies");
  assert.equal(S.singleNegation(), true, "on by default");
});

test("schematic text: one bar over the whole name, or one per character, at the text's justification", () => {
  const r = recorder();
  mode(true, () => S.glyph(r.ctx, "\\RESET", 0, 0, {size: 2, family: "Arial", align: "center"}, 10));
  assert.deepEqual(r.text, ["RESET"]); assert.deepEqual(r.bars, [[-2.5, 5]]);
  const off = recorder(); mode(false, () => S.glyph(off.ctx, "\\RESET", 0, 0, {size: 2, family: "Arial"}, 10));
  assert.deepEqual(off.text, ["\\RESET"]); assert.deepEqual(off.bars, []);
  // Pin names (imported Altium symbols draw them with pinText).
  const def = {schDrawing: {pins: [{start: [0, 0], end: [2.54, 0], direction: [1, 0], name: "\\RESET", number: "1"}]}};
  for (const on of [true, false]) {
    const p = recorder(); mode(on, () => S.pinText(p.ctx, {x: 0, y: 0, angle: 0}, def, 10, false));
    assert.ok(p.text.includes(on ? "RESET" : "\\RESET"), "pin name with the option " + on); assert.equal(p.bars.length, on ? 1 : 0);
  }
});

test("native ports, power ports, off-sheet connectors and sheet entries draw the bar too", () => {
  const items = [{id: "a", kind: "port", x: 0, y: 0, text: "\\RESET", io: "input"}, {id: "b", kind: "offsheet", x: 0, y: 0, text: "\\RESET"},
    {id: "c", kind: "power", x: 0, y: 0, text: "\\RESET", style: "bar"},
    {id: "d", kind: "sheetsymbol", x: 0, y: 0, w: 20, h: 20, name: "\\Sub", file: "sub\\sheet.SchDoc", entries: [{id: "e", name: "\\RESET", side: "left", offset: 5, io: "input"}]}];
  for (const i of items) for (const on of [true, false]) {
    const r = recorder(); mode(on, () => O.draw(r.ctx, i, {scale: 10, selected: false, lit: false}));
    assert.ok(r.text.includes(on ? "RESET" : "\\RESET"), i.kind + " text with the option " + on + ": " + r.text.join("|"));
    assert.equal(r.bars.length, on ? 1 : 0, i.kind + " bars with the option " + on);
    if (i.kind === "sheetsymbol") assert.ok(r.text.includes("\\Sub") && r.text.includes("sub\\sheet.SchDoc"), "sheet names and file names are not negated");
  }
});

test("PDF: the recorder writes the bar as a filled rectangle beside the text", () => {
  const count = t => { const rec = AtriumPDF.recorder(200, 200); S.glyph(rec.ctx, t, 20, 20, {size: 2, family: "Arial"}, 4); return rec.list.length; };
  const plain = count("RESET");
  assert.equal(mode(true, () => count("\\RESET")), plain + 1, "one more fill: the bar");
  assert.equal(mode(false, () => count("\\RESET")), plain, "off: the backslash is text, no bar");
  assert.equal(mode(false, () => count("R\\E\\S\\E\\T\\")), plain + 5, "per character: five bars");
});

test("PCB stroke text (canvas and Gerber silk): the backslashes go, a bar runs over the negated characters", () => {
  T.clearCache();
  const item = text => ({kind: "label", text, x: 0, y: 0, size: 1, layer: "Top Overlay"});
  const prim = (text, on) => mode(on, () => { T.clearCache(); return T.toPrimitives(item(text), {layer: "Top Overlay"}); });
  const plain = prim("RESET", true), whole = prim("\\RESET", true), per = prim("R\\E\\S\\E\\T\\", false), literal = prim("\\RESET", false);
  assert.equal(whole.strokes.length, plain.strokes.length + 1, "one bar over the whole name");
  assert.equal(per.strokes.length, plain.strokes.length + 1, "adjacent negated characters share one bar");
  const right = l => Math.max(...l.strokes.flatMap(s => s.points.map(p => p[0])));
  assert.ok(right(literal) > right(plain) + .5 && Math.abs(right(whole) - right(plain)) < 1e-9, "off: the backslash is drawn as a glyph and the text is wider");
  const bar = whole.strokes.at(-1).points, ys = plain.strokes.flatMap(s => s.points.map(p => p[1]));
  assert.equal(bar.length, 2); assert.equal(bar[0][1], bar[1][1], "the bar is horizontal");
  assert.ok(bar[0][1] < Math.min(...ys), "above the capitals (Y down)");
  const xs = plain.strokes.flatMap(s => s.points.map(p => p[0]));
  assert.ok(Math.abs(bar[0][0] - Math.min(...xs)) < .2 && Math.abs(bar[1][0] - Math.max(...xs)) < .2, "as wide as the name");
  const split = prim("A\\BC\\D", false);
  assert.equal(split.strokes.length, prim("ABCD", false).strokes.length + 2, "separate runs get separate bars");
  T.clearCache();
});

test("connectivity and netlists keep the raw name in both modes", () => {
  const nets = on => mode(on, () => {
    const p = AtriumParts.example(), s = p.documents.find(d => d.kind === "schematic");
    for (const l of s.items) if (l.kind === "netlabel" && l.text === "VDD") l.text = "\\VDD";
    const n = NL.extract(p, {source: "schematic"});
    return Object.fromEntries(n.nets.map(x => [x.name, x.nodes.map(y => y.ref + "-" + y.pin).sort().join(" ")]));
  });
  const before = (() => { const n = NL.extract(AtriumParts.example(), {source: "schematic"}); return Object.fromEntries(n.nets.map(x => [x.name, x.nodes.map(y => y.ref + "-" + y.pin).sort().join(" ")])); })();
  const on = nets(true), off = nets(false);
  assert.deepEqual(on, off, "the preference never changes a net");
  assert.equal(on["\\VDD"], before.VDD, "\\VDD joins the same pins VDD did, under its raw name");
  assert.equal(on.VDD, undefined);
  assert.match(NL.kicad(mode(true, () => NL.extract((() => { const p = AtriumParts.example(); for (const l of p.documents[0].items) if (l.text === "VDD") l.text = "\\VDD"; return p; })(), {source: "schematic"})), {name: "N", date: "2026-01-01T00:00:00Z"}), /\(name "\\\\VDD"\)|\(name "\\VDD"\)/, "the KiCad netlist writes the raw name");
  // One label renamed: the backslash is part of the name, so the two halves are separate nets.
  const p = AtriumParts.example(), s = p.documents.find(d => d.kind === "schematic");
  s.items.find(l => l.kind === "netlabel" && l.text === "VDD").text = "\\VDD";
  const split = NL.extract(p, {source: "schematic"}).nets.map(x => x.name);
  assert.ok(split.includes("\\VDD") && split.includes("VDD"), "RESET and \\RESET are different nets, as before");
});

test("net intent: a leading \\ is active-low evidence, stated by its \\ prefix", () => {
  const r = NI.read("\\RESET");
  assert.equal(r.role, "control"); assert.equal(r.activeLow, true); assert.equal(r.core, "RESET");
  assert.ok(r.explain.some(e => /active low by its \\ prefix/.test(e)), r.explain.join("; "));
  const g = NI.read("\\FOO");
  assert.equal(g.activeLow, true); assert.ok(g.explain.includes("active low by its \\ prefix"), g.explain.join("; "));
  assert.equal(NI.read("\\R\\E\\S\\E\\T\\").core, "RESET");
  assert.notEqual(NI.read("\\\\RESET").activeLow, true, "an escaped backslash is not negation");
  // Unchanged decisions: a lone control X_N is active low; Altium per-character and the other prefixes as before.
  assert.equal(NI.read("RESET_N").activeLow, true); assert.equal(NI.read("RESET_N").role, "control");
  assert.equal(NI.read("R\\S\\T\\").activeLow, true); assert.equal(NI.read("/CS").activeLow, true); assert.equal(NI.read("nRST").activeLow, true);
  assert.equal(NI.read("CLK_N").role, "pairMember");
});

test("conventions and completion: a project that writes \\RESET is offered \\CS", () => {
  assert.equal(X.lowStyleOf("\\RESET"), "\\"); assert.equal(X.renderLow("CS", "\\"), "\\CS");
  assert.equal(X.lowStyleOf("\\\\RESET"), null);
  const p = A.project("Low", []), sch = p.documents[0];
  ["\\RESET", "\\CS_FLASH", "\\INT", "\\EN_PWR"].forEach((t, k) => sch.items.push({id: "n" + k, kind: "netlabel", text: t, x: 0, y: k * 5}));
  const low = X.conventions(p).learned.find(c => c.id === "activeLow");
  assert.equal(low.value, "\\"); assert.equal(low.describe, "\\RST, \\CS");
  const names = X.complete(p, "WR").map(c => c.name);
  assert.ok(names.includes("\\WR"), "completion in the project's style: " + names.join(", "));
});

console.log("PASS negation: " + passed + " groups (parser, schematic, native objects, PDF, PCB silk, netlists, net intent, conventions)");
