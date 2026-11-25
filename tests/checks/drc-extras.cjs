"use strict";
// Incremental DRC extras (app/checks/drc-fixes.js extras()): net antennae
// and missing courtyards re-checked per edit, from the undo journal, for the nets of the changed objects
// (old and new) and the changed components. After random edits (moves, deletes, adds, net changes, pin
// net changes, track reroutes, library edits) the result always equals the full checks() as a set.
// Prints the cost per edit against a full pass on the 25.6k-object perf board.
// Run: scripts/test-jsc.sh drc-extras   (or node tests/checks/drc-extras.cjs)
const assert = require("node:assert/strict");
if (!globalThis.performance) globalThis.performance = {now: () => Date.now()};
for (const m of ["model", "parts", "nav-common", "spatial", "altium-rules", "pcb-draw", "component-classes", "net-intent", "signals", "rules", "drc-fixes", "undo-store"]) require(require("../support/app-source-paths.cjs").appFile(m + ".js"));
require("../pcb/dense-board.js");
const F = AtriumDRCFixes, U = AtriumUndoStore, now = () => performance.now();
let seed = 11;
const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % n; };
const sig = list => list.map(v => JSON.stringify(v)).sort();
function run(doc, defs, project, rounds, label) {
  U.reset(); U.touch(project); U.sync(project);
  const E = F.extras();
  let at = U.changed(doc, null).seq;
  E.update(doc, defs, null);
  E.update(doc, defs, {from: null, to: at, ids: null, items: null});
  const inc = [], fullMs = [];
  const NETS = ["A", "B", "C", "", "GND"];
  for (let k = 0; k < rounds; k++) {
    const items = doc.items, i = items[rnd(items.length)], op = rnd(8);
    if (op === 0 && i.points) i.points = i.points.map(p => [p[0] + (rnd(3) - 1) * .3, p[1] + (rnd(3) - 1) * .3]);
    else if (op === 1 && Number.isFinite(i.x)) { i.x += (rnd(3) - 1) * .5; i.y += (rnd(3) - 1) * .5; }
    else if (op === 2) doc.items = items.filter(x => x !== i);
    else if (op === 3) doc.items.push({id: "n" + k, kind: "track", layer: rnd(2) ? "Top" : "Bottom", width: .2, net: NETS[rnd(NETS.length)], points: [[rnd(300) / 10, rnd(200) / 10], [rnd(300) / 10, rnd(200) / 10]]});
    else if (op === 4 && "net" in i) i.net = NETS[rnd(NETS.length)];
    else if (op === 5 && i.kind === "part") i.pinNets = {...(i.pinNets || {}), "1": NETS[rnd(NETS.length)]};
    else if (op === 6) doc.items.push({id: "v" + k, kind: "via", x: rnd(300) / 10, y: rnd(200) / 10, diameter: .6, drill: .3, layer: "Multi", net: NETS[rnd(NETS.length)]});
    else if (op === 7 && i.kind === "part") i.def = i.def === "std-r" ? "std-c" : "std-r";
    U.touch(project); U.sync(project);
    const ch = U.changed(doc, at), t = now();
    const got = E.update(doc, defs, {from: at, to: ch.seq, ids: ch.ids, items: ch.items});
    inc.push(now() - t); at = ch.seq;
    if (k % 9 === 8 || k === rounds - 1) {
      const t2 = now(), want = F.checks(doc, defs); fullMs.push(now() - t2);
      assert.deepEqual(sig(got), sig(want), label + ": after edit " + (k + 1) + " the incremental extras equal a full pass");
    }
  }
  inc.sort((a, b) => a - b); fullMs.sort((a, b) => a - b);
  return {inc: inc[inc.length >> 1], full: fullMs[fullMs.length >> 1]};
}
{
  const defs = new Map(AtriumParts.catalogue.map(p => [p.id, p]));
  const d = Atrium.sheet("pcb", "Extras");
  d.outline = [[0, 0], [30, 0], [30, 20], [0, 20]];
  for (let k = 0; k < 60; k++) {
    const net = ["A", "B", "C", "", "GND"][k % 5];
    if (k % 4 === 0) d.items.push({id: "p" + k, kind: "part", def: k % 8 ? "std-r" : "std-c", ref: "R" + k, x: (k * 7) % 28 + 1, y: (k * 3) % 18 + 1, angle: 0, pinNets: {"1": net, "2": "GND"}});
    else if (k % 4 === 1) d.items.push({id: "v" + k, kind: "via", x: (k * 5) % 28 + 1, y: (k * 7) % 18 + 1, diameter: .6, drill: .3, layer: "Multi", net});
    else d.items.push({id: "t" + k, kind: "track", layer: k % 3 ? "Top" : "Bottom", width: .25, net, points: [[(k * 5) % 28 + 1, (k * 7) % 18 + 1], [(k * 7) % 28 + 1, (k * 5) % 18 + 1]]});
  }
  const project = {format: "atrium", name: "X", library: AtriumParts.catalogue, documents: [d]};
  run(d, defs, project, 120, "small board");
  console.log("ok - small board: the incremental extras equal a full pass after 120 random edits");
}
{
  // One large net (re-checked locally around the edit) next to small ones (re-checked whole).
  const defs = new Map(AtriumParts.catalogue.map(p => [p.id, p]));
  const d = Atrium.sheet("pcb", "Big net");
  d.outline = [[0, 0], [60, 0], [60, 40], [0, 40]];
  for (let k = 0; k < 420; k++) {
    const x = (k * 13) % 58 + 1, y = (k * 7) % 38 + 1, net = k % 7 ? "" : "A";
    if (k % 9 === 0) d.items.push({id: "v" + k, kind: "via", x, y, diameter: .6, drill: .3, layer: "Multi", net});
    else if (k % 11 === 0) d.items.push({id: "p" + k, kind: "part", def: "std-r", ref: "R" + k, x, y, angle: 0, pinNets: {"1": net, "2": "A"}});
    else d.items.push({id: "t" + k, kind: "track", layer: k % 3 ? "Top" : "Bottom", width: .25, net, points: [[x, y], [x + (k % 5) * .7, y + (k % 3) * .6]]});
  }
  const project = {format: "atrium", name: "Big", library: AtriumParts.catalogue, documents: [d]};
  run(d, defs, project, 200, "large net");
  console.log("ok - a large net: the incremental extras equal a full pass after 200 random edits");
}
{
  const {d, defs} = makeAtriumBenchmarkBoard(160);
  for (const [n, i] of d.items.entries()) if (i.kind === "track" || i.kind === "via") i.net = "N" + (n % 400);
  const project = {format: "atrium", name: "Dense", library: AtriumParts.catalogue, documents: [d]};
  const r = run(d, defs, project, 18, "perf board");
  console.log("ok - perf board (25.6k objects): extras per edit " + r.inc.toFixed(2) + " ms incremental vs " + r.full.toFixed(1) + " ms full (median)");
}
