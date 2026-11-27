"use strict";
// The Active Bar's GND and VDD faces (#i-power-gnd, #i-power-bar in app/index.html) are the power-port
// glyphs the schematic paints (AtriumSchAppearance.label), recorded and fitted into the 24-unit icon
// box. If the schematic geometry changes, this test prints the new path data for the sprite.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {appFile} = require("../support/app-source-paths.cjs");
globalThis.CFB = require(appFile("vendor/cfb.min.js"));
for (const file of ["model", "parts", "sch-import", "io", "source-file", "spatial", "pcb-appearance", "sch-appearance", "canvas", "sch-objects"]) require(appFile(file + ".js"));

// A context that keeps every stroked polyline in sheet millimetres.
function recorder() {
  const lines = [], stack = [];
  let m = {a: 0, t: [0, 0]}, path = [], current = null;
  const world = (x, y) => [m.t[0] + x * Math.cos(m.a) - y * Math.sin(m.a), m.t[1] + x * Math.sin(m.a) + y * Math.cos(m.a)];
  const ctx = {
    save() { stack.push({...m, t: [...m.t]}); }, restore() { m = stack.pop(); },
    translate(x, y) { m.t = world(x, y); }, rotate(a) { m.a += a; },
    beginPath() { path = []; current = null; }, moveTo(x, y) { current = [world(x, y)]; path.push(current); },
    lineTo(x, y) { current?.push(world(x, y)); }, closePath() { if (current) current.push(current[0]); },
    arc() { throw Error("power faces use line glyphs"); },
    stroke() { lines.push(...path.map(p => p.map(q => q.slice()))); }, fill() {}, fillText() {}, measureText: t => ({width: t.length}), setLineDash() {}
  };
  return {ctx, lines};
}
// Fit the glyph into the icon box (24 units, 2 units of margin), centred, rounded to 0.01.
function face(style, direction) {
  const {ctx, lines} = recorder();
  AtriumSchAppearance.label(ctx, {kind: "power", x: 0, y: 0, text: "", schPaint: {type: "power", style: AtriumSchObjects.POWER[style], direction, showName: false}}, 1, false);
  const pts = lines.flat(), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  const s = 20 / Math.max(box[2] - box[0], box[3] - box[1]), cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const n = v => String(Math.round(v * 100) / 100);
  return lines.map(l => l.map((p, i) => (i ? "L" : "M") + n(12 + (p[0] - cx) * s) + " " + n(12 + (p[1] - cy) * s)).join("")).join("");
}
const html = fs.readFileSync(appFile("index.html"), "utf8");
for (const [id, style, direction] of [["i-power-gnd", "gnd", 3], ["i-power-bar", "bar", 1]]) {
  const d = face(style, direction), m = html.match(new RegExp('<symbol id="' + id + '" viewBox="0 0 24 24"><path d="([^"]*)"/></symbol>'));
  assert.ok(m, id + " is in the icon bank");
  assert.equal(m[1], d, id + " follows the schematic power-port glyph (" + style + "): " + d);
}
console.log("active bar power faces: ok");
