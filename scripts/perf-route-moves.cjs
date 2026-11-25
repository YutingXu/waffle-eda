"use strict";
// Per-move interactive routing latency (p50/p95/p99/max per mouse move) on the 25.6k-object board of
// tests/pcb/dense-board.js: walkaround, push and hug single tracks and diff pairs along wavy ~120 Hz cursor
// paths (with and without clicks), plus a push sweep through a 16-track bus (the shove worst case).
// Usage: node scripts/perf-route-moves.cjs [trials]     Env: ONLY=track|pair|bus  STATUS=1  JSON=1
//        APP=/path/to/app (A/B against another checkout's app directory)
const nodePath = require("node:path");
const {existsSync} = require("node:fs");
const app = nodePath.resolve(process.env.APP || nodePath.join(__dirname, "../app"));
const trials = +(process.argv[2] || 30);
// An explicit A/B checkout may still use the original flat application layout.
const modules = process.env.APP && !existsSync(nodePath.join(app, "core/model.js"))
  ? ["model.js", "parts.js", "router.js", "diffpair.js"]
  : ["core/model.js", "library/parts.js", "pcb/router.js", "pcb/diffpair.js"];
for (const module of modules) require(nodePath.join(app, module));
require("../tests/pcb/dense-board.js");
const R = globalThis.AtriumRouter, DP = globalThis.AtriumDiffPair;
const timer = () => performance.now();
const {d, defs} = makeAtriumBenchmarkBoard();
let k = 0; for (const i of d.items) if (i.kind === "via" || i.kind === "track") i.net = "N" + (k++ % 400);
// A diff-pair start: clear a small spot and put two pads there.
const pads = [];
for (let n = 0; n < 6; n++) {
  const cx = 40 + n * 37, cy = 40 + (n * 53) % 180;
  d.items = d.items.filter(i => { const x = i.x ?? i.points?.[0]?.[0], y = i.y ?? i.points?.[0]?.[1]; return Math.hypot(x - cx, y - cy) > 2.2; });
  d.items.push({id:"dpP" + n, kind:"pad", x:cx, y:cy - .3, w:.4, h:.4, shape:"round", layer:"Top", net:"DP" + n + "_P"});
  d.items.push({id:"dpN" + n, kind:"pad", x:cx, y:cy + .3, w:.4, h:.4, shape:"round", layer:"Top", net:"DP" + n + "_N"});
  pads.push([cx, cy, n]);
}
const t0 = timer(); R.world(d, defs, {revision:"bench"}); const build = timer() - t0;
const vias = d.items.filter(i => i.kind === "via");
let seed = 12345; const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
const stats = a => { a = a.slice().sort((x, y) => x - y); const q = f => a[Math.min(a.length - 1, Math.floor(a.length * f))]; return {n:a.length, p50:q(.5), p95:q(.95), p99:q(.99), max:a[a.length - 1]}; };
const fmt = s => `p50 ${s.p50.toFixed(3)}  p95 ${s.p95.toFixed(3)}  p99 ${s.p99.toFixed(3)}  max ${s.max.toFixed(3)} ms (n=${s.n})`;
// A wavy cursor path: ~120 Hz at ~25 mm/s = 0.2 mm per event, 15 mm long, with clicks every `every` moves.
function path(x, y, ang) {
  const pts = []; let a = ang;
  for (let i = 0; i < 75; i++) { a += (rnd() - .5) * 0.15; x += Math.cos(a) * .2; y += Math.sin(a) * .2; pts.push([x, y]); }
  return pts;
}
const out = {};
const statusCount = {};
function run(label, mk, every) {
  const times = [];
  seed = 777;
  for (let t = 0; t < trials; t++) {
    const s = mk(t);
    if (!s) continue;
    const {session, start} = s;
    const ang = rnd() * Math.PI * 2;
    const pts = path(start[0], start[1], ang);
    for (let i = 0; i < pts.length; i++) {
      const t1 = timer(); const r = session.move(pts[i]); times.push(timer() - t1);
      const key = label + ":" + r.status; statusCount[key] = (statusCount[key] || 0) + 1;
      if (every && i % every === every - 1) session.click();
    }
    session.cancel();
  }
  out[label] = stats(times);
  console.log(label.padEnd(26) + fmt(out[label]));
}
const ONLY = process.env.ONLY;
for (const mode of ["walkaround", "push", "hug"]) for (const every of [0, 25]) if (!ONLY || ONLY === "track") run(mode + (every ? " +clicks" : ""), () => {
  const v = vias[Math.floor(rnd() * vias.length)];
  return {session:R.begin(d, defs, {net:v.net, layer:"Top", start:[v.x, v.y], mode, revision:"bench"}), start:[v.x, v.y]};
}, every);
for (const mode of ["walkaround", "push"]) for (const every of [0, 25]) if (!ONLY || ONLY === "pair") run("pair " + mode + (every ? " +clicks" : ""), t => {
  const [cx, cy, n] = pads[t % pads.length];
  try { return {session:DP.begin(d, defs, {pair:{name:"DP" + n, positive:"DP" + n + "_P", negative:"DP" + n + "_N"}, layer:"Top", start:[cx, cy - .3], gap:.15, width:.15, mode, revision:"bench"}), start:[cx, cy]}; }
  catch (e) { console.log("pair begin failed", e.message); return null; }
}, every);
// Bus sweep: the tip of a push route goes up through a 16-track bus and back (worst case for shoves).
const bus = {kind:"pcb", items:Array.from({length:16}, (_, k) => ({id:"b" + k, kind:"track", layer:"Top", width:.2, net:"B" + k, points:[[0, k * .45], [40, k * .45]]}))};
bus.items.push({id:"pp", kind:"pad", x:19.7, y:-4, w:.4, h:.4, layer:"Top", net:"D_P"}, {id:"pn", kind:"pad", x:20.3, y:-4, w:.4, h:.4, layer:"Top", net:"D_N"});
if (!ONLY || ONLY === "bus") for (const [label, mk] of [["bus sweep push", () => R.begin(bus, new Map(), {net:"S", layer:"Top", start:[18, -4], mode:"push", rules:{clearance:.2}, width:.2})],
  ["bus sweep hug", () => R.begin(bus, new Map(), {net:"S", layer:"Top", start:[18, -4], mode:"hug", rules:{clearance:.2}, width:.2})],
  ["bus sweep pair push", () => DP.begin(bus, new Map(), {pair:{name:"D", positive:"D_P", negative:"D_N"}, layer:"Top", start:[19.7, -4], gap:.2, width:.2, mode:"push", rules:{clearance:.2}})]]) {
  const times = [], st = {};
  for (let rep = 0; rep < 3; rep++) {
    const s = mk();
    for (let i = 0; i <= 300; i++) { const y = -2 + 9 * (i <= 150 ? i / 150 : (300 - i) / 150), x = 20 + Math.sin(i / 20) * 1.5; const t = timer(); const r = s.move([x, y]); times.push(timer() - t); st[r.status] = (st[r.status] || 0) + 1; }
    s.cancel();
  }
  out[label] = stats(times); console.log(label.padEnd(26) + fmt(out[label]), JSON.stringify(st));
}
console.log("world build " + build.toFixed(1) + " ms");
if (process.env.STATUS) console.log(statusCount);
if (process.env.JSON) console.log(JSON.stringify(out));
