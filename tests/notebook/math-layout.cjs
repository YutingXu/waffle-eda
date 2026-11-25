"use strict";
const assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path");
const {nativeRoundTrip} = require("../support/native-cad.cjs");
const app = name => require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
for (const name of [
  "model",
  "parts",
  "sch-objects",
  "hierarchy",
  "altium-rules",
  "rules",
  "pcb-appearance",
  "pcb-edit",
  "eco",
  "netlist",
  "erc",
  "messages",
  "kicad-export",
  "kicad-schematic",
  "altium-export",
  "vendor/stix-two-math",
  "math-font",
  "math-tex",
  "math",
  "lazy"
])
  app(name);
const M = AtriumMath;
const formula = String.raw`Z=\sqrt[3]{\frac{1}{j\omega C}}\,\mathrm{k\Omega}`;
const l = M.layout(formula, { display: true });
assert.ok(l.commands.length > 10 && l.errors.length === 0 && l.commands.some(c => c.kind === "rule"));
assert.equal(l, M.layout(formula, { display: true }));
assert.notEqual(l, M.layout(formula));
assert.ok(Object.isFrozen(l.commands) && Object.isFrozen(l.commands[0]));
assert.match(M.svg(l), /viewBox=/);
assert.doesNotMatch(M.svg(M.layout(String.raw`\text{</svg><script>}`)), /<script>/);
for (const c of l.commands.filter(c => c.kind === "glyph"))
  assert.ok(c.gid > 0 && c.start >= 0 && c.end <= formula.length && c.scale > 0);
const tall = String.raw`\left(\begin{matrix}` + Array(18).fill("z").join("\\\\") + String.raw`\end{matrix}\right)`;
const assembled = M.layout(tall, { display: true });
assert.deepEqual(assembled.errors, []);
assert.ok(assembled.commands.filter(c => c.kind === "glyph" && c.text === "").length >= 8);
const nested = "\\sqrt{".repeat(200) + "x" + "}".repeat(200);
for (const invalid of [nested, "x".repeat(10000), "\\unknown", "x^2^3", "\\left["])
  assert.ok(M.layout(invalid).errors.length, invalid.slice(0, 24));
assert.equal(M.layout("𝑥+\\bad").errors[0].start, 3);
assert.equal(M.layout("\\left( x").errors[0].start, 8);
const p = AtriumParts.example(),
  doc = p.documents.find(d => d.kind === "schematic");
const electrical = () =>
  JSON.stringify([
    AtriumNetlist.extract(p, { source: "schematic" }),
    AtriumERC.run(p).messages.map(({ time, ...row }) => row)
  ]);
const before = electrical(),
  size = 3.5,
  dimensions = M.noteDimensions(l, size);
const note = {
  id: "math-r6-test",
  kind: "textframe",
  math: true,
  x: -127,
  y: 95,
  w: dimensions.w,
  h: dimensions.h,
  size,
  text: formula
};
doc.items.push(note);
Atrium.validate(p);
const wrong = Atrium.project("Wrong document", []);
wrong.documents.find(d => d.kind === "pcb").items.push({ ...note });
assert.throws(() => Atrium.validate(wrong));
assert.deepEqual(electrical(), before);
assert.deepEqual(AtriumSchObjects.hotspots(note), []);
assert.deepEqual(AtriumSchObjects.grips(note), []);
for (const patch of [
  { math: null },
  { math: "true" },
  { role: "frame" },
  { w: -1 },
  { h: 0 },
  { size: null },
  { text: " " },
  { text: "x".repeat(8193) }
])
  assert.throws(
    () =>
      AtriumSchObjects.validateItem({ ...note, ...patch }, () => {
        throw Error("invalid");
      }),
    /invalid/
  );
assert.ok(AtriumLazy.validatorsFor(p).includes("AtriumMath"));
assert.ok(!AtriumLazy.validatorsFor(AtriumParts.example()).includes("AtriumMath"));
for (const result of [AtriumKiCadSchematic.exportSheet(p, doc), AtriumAltiumExport.exportSchematic(p, doc)]) {
  assert.ok(
    result.diagnostics.some(d => JSON.stringify(d).includes(note.id) && JSON.stringify(d).includes("static text"))
  );
  assert.ok(result.content.includes(l.plain) || result.content.includes("root[3]"), l.plain);
}
{
  const formula = Atrium.project("Native equations");
  formula.documents[0].items.push(note);
  const reopened = nativeRoundTrip(formula).documents[0].items[0];
  const U = AtriumFormat2Units, inNativeUnits = value => U.mm(U.length(value).value);
  assert.deepEqual(reopened, {...note, w:inNativeUnits(note.w), h:inNativeUnits(note.h)},
    "source and font size stay exact, and the displayed extents return on the native nanometre grid");
  assert.deepEqual(AtriumMath.layout(reopened.text,{display:true}), AtriumMath.layout(note.text,{display:true}));
}
const fixture = path.join(__dirname, "../fixtures/math");
const refs = JSON.parse(fs.readFileSync(path.join(fixture, "reference/layout.json"), "utf8")).cases;
const katex = JSON.parse(fs.readFileSync(path.join(fixture, "katex-expressions.json"), "utf8")).cases;
const entries = new Map(
  fs
    .readFileSync(path.join(fixture, "electronics.tsv"), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map(r => {
      const [id, , , , tex] = r.split("\t");
      return [id, tex];
    })
);
assert.equal(entries.size, 100);
assert.equal(katex.length, 42);
let invalid = 0;
for (const e of katex) {
  if ("errorAt" in e) {
    invalid++;
    assert.ok(
      M.layout(e.tex).errors.some(i => i.start === e.errorAt),
      e.tex
    );
    continue;
  }
  entries.set("katex-" + e.id, e.tex);
}
assert.equal(invalid, 10);
assert.equal(entries.size, 132);
assert.equal(refs.length, 132);
assert.deepEqual(new Set(refs.map(ref => ref.id)), new Set(entries.keys()));
for (const ref of refs) {
  const v = M.layout(entries.get(ref.id), { display: ref.mode === "display" });
  assert.deepEqual(v.errors, [], ref.id);
  for (const k of ["advance", "ascent", "descent"])
    assert.ok(
      Math.abs(ref[k] - v[k]) <= Math.max(0.1, ref[k] * (k === "advance" ? 0.08 : 0.14)),
      ref.id + " " + k
    );
}
console.log(
  "PASS 132 reference equation boxes, 10 exact error positions, glyph assemblies, electrical isolation and foreign exports"
);
