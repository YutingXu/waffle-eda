"use strict";
// Live ERC (app/checks/erc.js steps with options.cache, checks.js): each sheet's graph and findings, the
// project compile (kept while no sheet's connectivity changed) and each project net's findings are reused
// while unchanged. Random edits on a synthetic hierarchy-free 8-sheet project and on every corpus project
// with sheets: the live (cached) result always equals a fresh run. Prints the time per edit.
// Run: scripts/test-jsc.sh erc-live   (or node tests/checks/erc-live.cjs)
const assert = require("node:assert/strict");
const {nativeCADCases}=require("../support/native-cad.cjs");
const {publicPiDP}=require("../support/public-pidp.cjs");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "sch-objects", "hierarchy", "net-ties", "multichannel", "messages", "erc", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
const A = Atrium, E = AtriumERC, U = AtriumUndoStore, now = () => performance.now();
let seed = 7;
const rnd = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
function synthetic(n = 8, parts = 24) {
  const p = A.project("Live"), lib = {id: "ic", name: "IC", prefix: "U", symbol: {shapes: [], pins: Array.from({length: 8}, (_, i) => ({number: String(i + 1), name: "P" + (i + 1), x: i < 4 ? -10 : 10, y: (i % 4) * 2.54, electrical: [0, 2, 4, 1][i % 4]}))}};
  p.library = [lib]; p.documents = [];
  for (let s = 0; s < n; s++) {
    const d = A.sheet("schematic", "Sheet " + (s + 1)); d.items = [];
    for (let k = 0; k < parts; k++) {
      const x = (k % 6) * 40, y = Math.floor(k / 6) * 30;
      d.items.push({id: "u" + s + "_" + k, kind: "part", def: "ic", ref: "U" + (s * 100 + k), x, y, angle: 0});
      for (let pin = 0; pin < 8; pin++) {
        const px = x + (pin < 4 ? -10 : 10), py = y + (pin % 4) * 2.54, ex = px + (pin < 4 ? -5 : 5);
        d.items.push({id: "w" + s + "_" + k + "_" + pin, kind: "wire", points: [[px, py], [ex, py]]});
        if (pin % 2 === 0) d.items.push({id: "l" + s + "_" + k + "_" + pin, kind: pin === 4 && k % 5 === 0 ? "power" : "netlabel", x: ex, y: py, text: pin === 4 && k % 5 === 0 ? "VCC" : "N" + ((s * 7 + k * 3 + pin) % 60)});
      }
    }
    p.documents.push(d);
  }
  return p;
}
const key = m => [m.class, m.check, m.text, m.objectId, m.documentId, (m.point || []).join(",")].join("|");
function liveRunner(p) {
  const cache = new WeakMap(), ver = s => { const v = U.documentVersions(s, p); return v ? v.floor + "/" + v.items + "/" + v.outer + "/" + v.library : null; };
  return () => {
    const v0 = U.documentVersions(p.documents[0], p), it = E.steps(p, {cache, stamp: v0 ? v0.floor + "/" + v0.library + "/" + v0.project : "", sheetVersion: ver});
    let r = it.next(); while (!r.done) r = it.next(); return r.value;
  };
}
function same(p, live, label) {
  const a = live().messages.map(key).sort(), b = E.run(p).messages.map(key).sort();
  assert.deepEqual(a, b, label + ": the live result equals a fresh run");
}
function edits(p, rounds, label) {
  U.reset(); U.touch(p); U.sync(p);
  const live = liveRunner(p); live();
  const times = [];
  for (let k = 0; k < rounds; k++) {
    const sheets = p.documents.filter(d => d.kind === "schematic"), d = sheets[rnd(sheets.length)], items = d.items;
    if (!items.length) continue;
    const i = items[rnd(items.length)], op = rnd(6);
    if (op === 0 && (i.kind === "netlabel" || i.kind === "power") && i.text) i.text = i.text.endsWith("_X") ? i.text.slice(0, -2) : i.text + "_X";
    else if (op === 1 && i.points) i.points[0] = [i.points[0][0] + (rnd(2) ? .1 : -.1), i.points[0][1]];
    else if (op === 2 && i.kind === "part") { i.x += rnd(2) ? 2.54 : -2.54; }
    else if (op === 3) d.items = items.filter(x => x !== i);
    else if (op === 4 && i.kind === "part") i.ref = i.ref.endsWith("A") ? i.ref.slice(0, -1) : i.ref + "A";
    else if (op === 5) items.push({id: "nerc" + k, kind: "noerc", x: i.x ?? i.points?.[0]?.[0] ?? 0, y: i.y ?? i.points?.[0]?.[1] ?? 0});
    U.touch(p); U.sync(p);
    const t = now(); live(); times.push(now() - t);
    if (k % 7 === 6) same(p, live, label + " after edit " + (k + 1));
  }
  same(p, live, label);
  times.sort((a, b) => a - b);
  return times;
}
const t = edits(synthetic(), 40, "synthetic 8 sheets");
console.log("ok - synthetic 8 sheets: the live result equals a fresh run after 40 random edits (median " + t[t.length >> 1].toFixed(1) + " ms per edit)");
let files=0;
for (const [label,design] of [...nativeCADCases(),["PiDP-11",publicPiDP()]]) {
  const p=A.validate(design);
  if (!p.documents.some(d => d.kind === "schematic")) continue;
  edits(p, 12, label); files++;
}
console.log("ok - " + files + " corpus projects: the live result equals a fresh run after random edits");
U.reset();
