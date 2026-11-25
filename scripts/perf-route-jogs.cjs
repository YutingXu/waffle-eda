"use strict";
// Compare the same 900 walkaround heads before and after a router change.
// APP=/other/checkout/app node scripts/perf-route-jogs.cjs
const path = require("node:path");
const {existsSync} = require("node:fs");
const app = path.resolve(process.env.APP || path.join(__dirname, "../app"));
// An explicit A/B checkout may still use the original flat application layout.
const modules = process.env.APP && !existsSync(path.join(app, "core/model.js"))
  ? ["model", "parts", "router"]
  : ["core/model", "library/parts", "pcb/router"];
for (const module of modules) require(path.join(app, module + ".js"));
require("../tests/pcb/dense-board.js");

const {d: board, defs} = makeAtriumBenchmarkBoard(60);
let net = 0;
for (const item of board.items) if (item.kind === "via" || item.kind === "track") item.net = "N" + (net++ % 400);
const vias = board.items.filter(i => i.kind === "via");
let seed = 99;
function random() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; }

function measure(points) {
  const dirs = [], lengths = [];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0], dy = points[i][1] - points[i - 1][1];
    dirs.push((Math.round(Math.atan2(dy, dx) * 4 / Math.PI) + 8) % 8); lengths.push(Math.hypot(dx, dy));
  }
  function turn(a, b) {
    const d = (b - a + 8) % 8;
    return d === 0 || d === 4 ? 0 : d < 4 ? 1 : -1;
  }
  let step = false, parallel = false, diagonal = false;
  for (let i = 1; i + 1 < dirs.length; i++) {
    if (lengths[i] >= .25 || turn(dirs[i - 1], dirs[i]) * turn(dirs[i], dirs[i + 1]) >= 0) continue;
    step = true;
    if (dirs[i - 1] === dirs[i + 1]) { parallel = true; if (dirs[i - 1] % 2) diagonal = true; }
  }
  return {heads: 1, vertices: points.length, withStep: +step, parallel: +parallel, diagonal: +diagonal};
}

const results = {};
for (let trial = 0; trial < 30; trial++) {
  const via = vias[Math.floor(random() * vias.length)], angle = random() * Math.PI * 2;
  const s = AtriumRouter.begin(board, defs, {net: via.net, layer: "Top", start: [via.x, via.y], mode: "walkaround", revision: "gloss", moveBudgetMs: 50});
  for (let move = 0; move < 30; move++) {
    const dist = .5 + move * .25;
    const r = s.move([via.x + Math.cos(angle) * dist, via.y + Math.sin(angle) * dist]);
    const counts = results[r.status] ||= {};
    const head = r.preview.find(p => p.head)?.points || [];
    for (const [key, value] of Object.entries(measure(head))) counts[key] = (counts[key] || 0) + value;
  }
  s.cancel();
}
console.table(results);
