"use strict";
// Altium rounded-rectangle pads (app/formats/pcb-import.js binaryObject): a Pads6 record keeps a compatibility
// shape (round, sometimes rectangle) in its main block; the extended size-and-shape block holds the real
// shape per layer (alternate shape 9) and its corner radius in percent of half the shorter side. A QFN's
// 0.85 x 0.3 mm pads must stay rounded rectangles with that radius (never obrounds), in a PcbDoc and a
// PcbLib, per layer in a top-middle-bottom stack, and in DFM geometry and Gerber.
// Synthetic records only.
const assert = require("node:assert/strict");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const m of ["model", "source-file", "pcb-import", "altium-rules", "io", "spatial", "connectivity", "pcb-appearance", "dfm", "zip", "fab-outputs"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium;
const block = b => { const n = Buffer.alloc(4); n.writeUInt32LE(b.length, 0); return Buffer.concat([n, b]); };
const props = s => block(Buffer.from(s + "\0", "latin1"));
const MM = n => Math.round(n / .00000254);
// One Pads6 record. alt: {layer index (0 top, 1-30 mid, 31 bottom): corner %}; mode: 0 simple, 1 top-mid-bottom, 2 full stack.
function pad({name = "1", x = 0, y = 0, w = .85, h = .3, base = 1, alt = {}, mode = 0, stack = null, extended = 596}) {
  const b = Buffer.alloc(202), dim = (off, n) => b.writeInt32LE(MM(n), off);
  b[0] = 1; b.writeUInt16LE(65535, 3); b.writeUInt16LE(65535, 5); b.writeUInt16LE(65535, 7);
  dim(13, x); dim(17, -y); dim(21, w); dim(25, h); b[49] = base; b[62] = mode;
  if (stack) { b[50] = stack.midShape ?? base; b[51] = stack.bottomShape ?? base; dim(29, stack.mid[0]); dim(33, stack.mid[1]); dim(37, stack.bottom[0]); dim(41, stack.bottom[1]); }
  const e = Buffer.alloc(extended);
  for (const [k, r] of Object.entries(alt)) { e[532 + +k] = 9; e[564 + +k] = r; }
  const nm = Buffer.concat([Buffer.from([name.length]), Buffer.from(name)]);
  return Buffer.concat([Buffer.from([2]), block(nm), ...Array.from({length: 3}, () => block(Buffer.alloc(0))), block(b), block(e)]);
}
const records = [
  pad({name: "1", x: 0, alt: {0: 50}}),                                         // QFN pad: round compatibility shape, 50 %
  pad({name: "2", x: 1, base: 2, alt: {0: 30}}),                                // rectangle compatibility shape
  pad({name: "3", x: 2, base: 9}),                                              // shape 9 with no extended block entry
  pad({name: "4", x: 3, w: 1, h: 1}),                                           // a real round pad stays round
  pad({name: "5", x: 4, extended: 0}),                                          // no extended block: obround as stored
  pad({name: "6", x: 5, w: 1.2, h: .6, mode: 1, alt: {0: 40, 31: 20}, stack: {mid: [1, .5], bottom: [1.1, .55]}}),
  pad({name: "7", x: 6, mode: 2, alt: {0: 60}})                                 // full stack: top shape kept
];
const doc = AtriumPCB.read("Pads.PcbDoc", new Map([["board6/data", props("|RECORD=Board")], ["pads6/data", Buffer.concat(records)]]), null).documents[0];
const byName = n => doc.items.find(i => i.kind === "pad" && i.number === n);
{
  const p1 = byName("1"), p2 = byName("2"), p3 = byName("3"), p4 = byName("4"), p5 = byName("5"), p6 = byName("6"), p7 = byName("7");
  assert.deepEqual([p1.shape, p1.roundrectRadiusRatio], ["roundrect", .25], "a QFN pad keeps its 50 % corner");
  assert.deepEqual([p2.shape, p2.roundrectRadiusRatio], ["roundrect", .15]);
  assert.equal(p3.shape, "roundrect");
  assert.equal(p4.shape, "round");
  assert.equal(p5.shape, "round", "without the extended block the stored compatibility shape is all there is");
  assert.equal(p6.stackMode, "tmb");
  assert.deepEqual([p6.shape, p6.roundrectRadiusRatio], ["roundrect", .2]);
  assert.deepEqual([p6.padStack.Top.shape, p6.padStack.Top.roundrectRadiusRatio], ["roundrect", .2]);
  assert.equal(p6.padStack.Mid.shape, "round", "a layer with no alternate shape keeps its own");
  assert.deepEqual([p6.padStack.Bottom.shape, p6.padStack.Bottom.roundrectRadiusRatio], ["roundrect", .1]);
  assert.deepEqual([p7.shape, p7.roundrectRadiusRatio], ["roundrect", .3]);
  // The displayed land on each layer takes that layer's radius.
  assert.equal(AtriumPCBAppearance.displayPad(p6, "Bottom").roundrectRadiusRatio, .1);
  assert.equal(AtriumPCBAppearance.displayPad(p6, "Top").roundrectRadiusRatio, .2);
}
{
  // The same record in a PcbLib footprint.
  const lib = new Map([["library/data", props("|HEADER=PCB 6.0 Binary Library File")], ["QFN/header", Buffer.alloc(4)],
    ["QFN/parameters", props("|PATTERN=QFN")], ["QFN/data", Buffer.concat([block(Buffer.from([3, ...Buffer.from("QFN")])), pad({name: "1", alt: {0: 50}})])]]);
  const out = AtriumPCB.read("Lab.PcbLib", lib, null);
  const fp = (out.library || []).map(x => x.footprint).find(f => f?.pads?.length);
  assert.ok(fp, "the footprint was read");
  assert.deepEqual([fp.pads[0].shape, fp.pads[0].roundrectRadiusRatio], ["roundrect", .25]);
}
{
  // Gerber: the copper flash is a rounded rectangle with the imported radius (0.25 x 0.3 mm = 0.075 mm).
  const p = byName("1"), project = A.project("Pads", []);
  doc.outline = [[-1, -1], [8, -1], [8, 1], [-1, 1]]; project.documents = [doc];
  const built = AtriumFabOutputs.build(project, doc.id, {origin: "absolute"});
  const g = require("./gerber-compare.cjs").parseGerber(built.files.find(f => f.name.endsWith(".GTL")).content);
  const flash = g.flashes.find(f => Math.abs(f.x - p.x) < 1e-5 && Math.abs(f.y - p.y) < 1e-5);
  assert.ok(flash, "pad 1 is flashed");
  const r = flash.shapes?.find(s => s.k === "circle")?.r;
  assert.ok(r != null && Math.abs(r - .075) < 1e-5, "corner radius " + r);
}
console.log("PASS Altium rounded-rectangle pads: per-layer shapes and radii from the extended pad block, PcbDoc and PcbLib, Gerber");
