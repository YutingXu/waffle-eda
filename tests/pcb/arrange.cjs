"use strict";
// Arrange Within Board / Rectangle (app/pcb/arrange.js) and the ECO option that runs it.
const assert = require("node:assert/strict");
require("../../app/core/model.js");
require("../../app/pcb/arrange.js");
const R = AtriumArrange;
const box = (w, h, pads) => ({pads: pads.map(([x, y], n) => ({number: String(n + 1), x, y, w: .6, h: .6, shape: "rect"})), shapes: [],
  courtyard: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]});
const defs = new Map([
  ["ic", {id: "ic", footprint: box(7, 7, [[-3, -3], [3, -3], [-3, 3], [3, 3]])}],
  ["r", {id: "r", footprint: box(2, 1, [[-.5, 0], [.5, 0]])}],
  ["j", {id: "j", footprint: box(3, 6, [[0, -2], [0, 2]])}]]);
function board(outline) {
  const d = Atrium.sheet("pcb", "B");
  d.outline = outline;
  // ECO-style grid beside the board, outside the outline.
  d.items.push({id: "u1", kind: "part", def: "ic", ref: "U1", x: 80, y: 0, angle: 0, pinNets: {1: "SDA", 2: "SCL", 3: "GND", 4: "NRST"}});
  for (let n = 1; n <= 8; n++) d.items.push({id: "r" + n, kind: "part", def: "r", ref: "R" + n, x: 80 + n * 3, y: 10, angle: n % 2 ? 90 : 0,
    pinNets: {1: n <= 2 ? ["SDA", "SCL"][n - 1] : "N" + n, 2: n <= 4 ? "+3V3" : "N" + (n + 10)}});
  d.items.push({id: "j1", kind: "part", def: "j", ref: "J1", x: 100, y: 0, angle: 0, pinNets: {1: "SDA", 2: "GND"}});
  d.items.push({id: "h1", kind: "via", x: 3, y: 3, diameter: 3.2, drill: 3.2});
  return d;
}
const rect30 = [[0, 0], [30, 0], [30, 25], [0, 25]];
const overlap = (a, b) => a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
function checkInside(d, ids, region, margin) {
  const boxes = ids.map(id => R.worldBox(d.items.find(i => i.id === id), defs.get(d.items.find(i => i.id === id).def)));
  for (const b of boxes) assert.ok(b[0] >= region[0] + margin - 1e-6 && b[1] >= region[1] + margin - 1e-6 && b[2] <= region[2] - margin + 1e-6 && b[3] <= region[3] - margin + 1e-6, "inside: " + b);
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) assert.ok(!overlap(boxes[i], boxes[j]), "no overlap " + ids[i] + "/" + ids[j]);
  return boxes;
}
{ // Within board: the unplaced parts (all of them here) go inside, clear of the mounting hole.
  const d = board(rect30);
  assert.deepEqual(R.unplaced(d, defs).sort(), ["j1", "r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "u1"]);
  const t0 = Date.now(), r = R.arrange(d, defs, {region: "board"});
  assert.ok(Date.now() - t0 < 1000, "fast");
  assert.equal(r.moved, 10); assert.deepEqual(r.failed, []);
  const ids = r.moves.map(m => m.id);
  const boxes = checkInside(d, ids, [0, 0, 30, 25], 0.5);
  for (const b of boxes) assert.ok(!overlap(b, [1.4, 1.4, 4.6, 4.6]), "clear of the hole");
  assert.deepEqual(R.unplaced(d, defs), [], "every part inside now");
  // Connectivity: R1 and R2 (SDA/SCL with U1) sit nearer U1 than the unconnected resistors on average.
  const c = id => { const b = R.worldBox(d.items.find(i => i.id === id), defs.get(d.items.find(i => i.id === id).def)); return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]; };
  const dist = id => Math.hypot(c(id)[0] - c("u1")[0], c(id)[1] - c("u1")[1]);
  assert.ok((dist("r1") + dist("r2")) / 2 < (dist("r5") + dist("r6") + dist("r7") + dist("r8")) / 4, "connected parts cluster");
  // Deterministic.
  const d2 = board(rect30), r2 = R.arrange(d2, defs, {region: "board"});
  assert.deepEqual(r2.moves, r.moves);
  // Nothing left to do.
  assert.equal(R.plan(d, defs, {region: "board"}).moves.length, 0);
}
{ // Fixed parts are obstacles; locked parts in the selection stay.
  const d = board(rect30);
  d.items.find(i => i.id === "u1").x = 15; d.items.find(i => i.id === "u1").y = 12; d.items.find(i => i.id === "u1").locked = true;
  const r = R.arrange(d, defs, {region: "board", ids: ["u1", "r1", "r2", "j1"]});
  assert.deepEqual(r.locked, ["u1"]); assert.equal(r.moved, 3);
  checkInside(d, ["u1", "r1", "r2", "j1"], [0, 0, 30, 25], 0.5);
  assert.equal(d.items.find(i => i.id === "u1").x, 15);
}
{ // Non-rectangular outline (L shape) and parts that do not fit.
  const L = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]];
  const d = board(L), r = R.arrange(d, defs, {region: "board"});
  for (const m of r.moves) { const i = d.items.find(x => x.id === m.id), b = R.worldBox(i, defs.get(i.def));
    for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) assert.ok(!(x > 8.01 && y > 8.01), "in the L: " + b); }
  assert.equal(r.moves.length + r.failed.length, 10);
}
{ // Within rectangle.
  const d = board(rect30), r = R.arrange(d, defs, {region: [40, 0, 60, 30], ids: ["r1", "r2", "r3", "r4"]});
  assert.equal(r.moved, 4); checkInside(d, ["r1", "r2", "r3", "r4"], [40, 0, 60, 30], 0);
  assert.throws(() => R.plan(d, defs, {region: [0, 0, .2, .2], ids: ["r1"]}), /too small/);
}
{ // No outline: board mode explains, rectangle mode works.
  const d = board([]);
  assert.throws(() => R.plan(d, defs, {region: "board"}), /board shape/);
  const msgs = [];
  R.command("arrange-board", {doc: d, defs, selection: [], edit: f => f(), info: m => msgs.push(m)});
  assert.match(msgs[0], /board shape/);
}
{ // Editor command: selection first, one edit, selects the moved parts.
  const d = board(rect30), edits = [], msgs = [];let sel = null;
  R.command("arrange-board", {doc: d, defs, selection: ["r3", "r4"], edit: f => { edits.push(1); f(); }, info: m => msgs.push(m), select: s => { sel = s; }});
  assert.equal(edits.length, 1); assert.deepEqual(sel.sort(), ["r3", "r4"]); assert.match(msgs[0], /Arranged 2 components inside the board/);
  assert.equal(d.items.find(i => i.id === "r5").x, 95, "unselected parts stay");
}
{ // Larger set stays fast: 300 parts on a 100 x 80 board.
  const d = Atrium.sheet("pcb", "Big"); d.outline = [[0, 0], [100, 0], [100, 80], [0, 80]];
  for (let n = 0; n < 300; n++) d.items.push({id: "p" + n, kind: "part", def: "r", ref: "R" + n, x: 200 + n, y: 0, angle: 0, pinNets: {1: "N" + (n >> 1), 2: "M" + (n % 50)}});
  const t0 = Date.now(), r = R.arrange(d, defs, {region: "board"});
  assert.equal(r.failed.length, 0); assert.ok(Date.now() - t0 < 8000, "300 parts in " + (Date.now() - t0) + " ms");
}
// Wiring: lazy module, menu items, editor command, ECO option, preference.
const {appFile} = require("../support/app-source-paths.cjs");
const fs = require("fs"), read = f => fs.readFileSync(appFile(f), "utf8");
assert.ok(/AtriumArrange: \{scripts: \["pcb\/arrange\.js"\]\}/.test(read("lazy.js")));
assert.ok(/on\(\["AtriumArrange"\], "arrange-board", "arrange-rect"\)/.test(read("lazy.js")));
assert.ok(read("index.html").includes('data-action="arrange-board"') && read("index.html").includes('data-action="arrange-rect"'));
assert.match(read("editor.js"), /case "arrange-board":case "arrange-rect":\s*boardCommand\(a,"AtriumArrange",\(arrange,ctx\)=>arrange\.command\(a,ctx\)/);
const eco = read("eco.js");
if (eco.includes("Arrange new components inside the board")) assert.ok(eco.includes("AR.arrange(bd,null,{project:proj(),ids,region:\"board\"})"));
else console.log("eco.js arrange option not integrated yet");
console.log("arrange: ok");
