"use strict";
// Poured copper repaints only where it changed, and nothing visible changes. On the 25,600-object
// benchmark board with ten pours (tests/pcb/dense-board.js, as scripts/perf-sch.sh --board pours), a
// series of edits inside and beside the large islands (move a part, bend, add and delete a track,
// paste, undo, redo, a pour outline and a clearance edit) runs in the editor with live pours. After
// every editor frame the canvas is compared pixel for pixel with a fresh full paint of the same state
// in an independent view: the retained board layer, patched where the pour engine says the copper
// changed (AtriumPCBPours.viewDamage: a refill's changed rings, a live tile patch shown, faded or
// cleared), must equal it. Frames that patched copper are counted, so the partial path is exercised.
// A control run shrinks the damage the engine reports and must be caught.
// Usage: node tests/canvas/browser-pour-damage.cjs [--efficiency off|always] [--gpu] [--quick]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const launch = require("../support/standalone-chromium.cjs");

const argv = process.argv.slice(2), arg = name => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const efficiency = arg("--efficiency") || "off", gpu = argv.includes("--gpu"), quick = argv.includes("--quick");
const executablePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function main(browser) {
  const page = await browser.newPage({viewport: {width: 1280, height: 860}, deviceScaleFactor: 1});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.goto(pathToFileURL(path.resolve(process.env.ATRIUM_APP || path.resolve(__dirname, "../../app"), "index.html")).href);
  await page.waitForFunction(() => !!globalThis.AtriumNavHost && document.readyState === "complete", null, {timeout: 60000});
  await page.addScriptTag({path: path.resolve(__dirname, "../pcb/dense-board.js")});
  const result = await page.evaluate(pourDamage, {efficiency, gpu, quick, debug: !!process.env.ATRIUM_DEBUG_DAMAGE});
  if (process.env.ATRIUM_DEBUG_DAMAGE) fs.writeFileSync(process.env.ATRIUM_DEBUG_DAMAGE, JSON.stringify(result.shots)), fs.writeFileSync(process.env.ATRIUM_DEBUG_DAMAGE + ".frames", JSON.stringify(result.frames, null, 0).replace(/},{/g, "},\n{"));
  assert.deepEqual(errors, [], "page errors");
  return result;
}

async function pourDamage({efficiency, gpu, quick, debug}) {
  const H = AtriumNavHost, wait = ms => new Promise(r => setTimeout(r, ms));
  for (const g of document.querySelectorAll("dialog[open]")) try { g.close(); } catch { /* closed */ }
  AtriumPower.setMode(efficiency);
  try { AtriumPrefs?.set?.("display.renderer", gpu ? "gpu" : "2d"); } catch { /* no preference */ }
  globalThis.AtriumDRCMarkers?.setVisible?.(false, H);
  // Overlay animations (marker fades, undo pulses) run on the clock, which the reference paint a moment
  // later would not match: animations off, so every picture is a function of the state alone.
  document.documentElement.setAttribute("data-motion", "off");
  const {d, defs} = makeAtriumBenchmarkBoard(), p = Atrium.project("Pour damage");
  p.documents = [d]; p.library = [...defs.values()];
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 64), "2": "N" + ((k + 1) % 64)}; else if (i.kind !== "track") i.net = "N" + (k % 64); k++; }
  await AtriumLazy.need("AtriumRules");
  const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]];
  const polys = [["Top", "GND", rect(1, 1, 180, 270)], ["Top", "VCC", rect(180, 1, 367, 270)], ["Bottom", "GND", rect(1, 1, 367, 140)], ["Bottom", "VCC", rect(1, 140, 367, 270)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + j, rect(10 + j * 55, 10, 50 + j * 55, 40)]);
  polys.forEach(([layer, net, o], j) => d.items.push(AtriumPolygonPour.make(o, {layer, net, pourIndex: j, removeDeadCopper: false})));
  await H.replaceProject(p, {force: true}); H.selectDocument(d.id);
  H.edit(() => AtriumPolygonPour.apply(H.doc(), H.defs(), {project: H.project()}));
  const busy = () => AtriumPolygonPour.live.busy || AtriumPolygonPour.tiles.busy || AtriumPolygonPour.tiles.pending;
  const quiet = async (ms = 20000) => { const t = performance.now(); await wait(400); while (performance.now() - t < ms && busy()) await wait(100); await wait(900); };
  await quiet(30000);
  // The live tile preview (Efficiency off) from the first edit on: its patches shown and cleared are damage too.
  if (!AtriumPower.efficient?.()) {
    for (let n = 0; n < 40 && !AtriumPolygonPour.tiles.state; n++) { await AtriumPolygonPour.tiles.rebuild?.(); await quiet(); }
  }
  await wait(2500);

  // After every editor frame: the canvas against a fresh full paint of the same frame in its own view.
  const view = H.view(), I = view.internals(), canvas = I.canvas;
  const ref = document.createElement("canvas");
  ref.style.cssText = `position:fixed;left:0;top:0;width:${canvas.clientWidth}px;height:${canvas.clientHeight}px;visibility:hidden`;
  const pixels = c => c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const frames = [];
  let label = "open", checking = false, pending = false, inexact = false;
  const shots = [], damageLog = [], NOISE = 3;
  const F = AtriumCanvasFast, P = AtriumPCBPours;
  let copperPatches = 0;
  // The reference: the same view's paint of the whole frame, onto a fresh surface, without the
  // retained board layer (the view's own connectivity, pour state and batching decide it, as for any
  // full repaint).
  const arm = I.armIdle;
  I.armIdle = () => { inexact = true; return arm(); };
  function check(reused) {
    pending = false;
    const last = I.frame?.(), frame = inexact; inexact = false;
    if (!last || last[0] !== d) return;
    checking = true;
    const real = I.ctx;
    try {
      ref.width = canvas.width; ref.height = canvas.height;
      globalThis.AtriumCanvasFast = null; I.ctx = ref.getContext("2d");
      I.paint(last[0], last[1], {...last[2], noReuse: true});
      I.ctx = real; globalThis.AtriumCanvasFast = wrapped;
      const a = pixels(canvas), b = pixels(ref);
      let n = 0, max = 0, box = null;
      for (let i = 0; i < a.length; i += 4) {
        const dl = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
        if (!dl) continue;
        n++; max = Math.max(max, dl);
        const x = (i >> 2) % canvas.width, y = Math.floor((i >> 2) / canvas.width);
        box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y];
      }
      const row = {label, reused, inexact: frame, pixels: n, max, box};
      // ATRIUM_DEBUG_DAMAGE: both pictures of the first frames that differ by more than the noise, as data URLs.
      if (debug) { row.damage = damageLog.splice(0); row.tiles = AtriumPolygonPour.tiles.version; }
      if (n && debug && shots.length < 6 && max > NOISE) row.shots = [canvas.toDataURL(), ref.toDataURL()], shots.push(row);
      frames.push(row);
    } finally { I.ctx = real; globalThis.AtriumCanvasFast = wrapped; checking = false; }
  }
  const wrapped = {...F, reuse(J, ...args) {
    const r = F.reuse(J, ...args);
    if (J === I && !checking && !pending) { pending = true; queueMicrotask(() => check(r)); }
    return r;
  }};
  globalThis.AtriumCanvasFast = wrapped;
  const viewDamage = P.viewDamage;
  let shrink = false;
  if (viewDamage) P.viewDamage = function (a, b) {
    const boxes = viewDamage(a, b);
    if (debug) damageLog.push({label, hook: [a?.hook, b?.hook], boxes: boxes && boxes.map(q => q.map(v => +v.toFixed(2)))});
    if (boxes?.length) copperPatches++;
    return shrink && boxes ? Object.assign([], {layers: boxes.layers}) : boxes;
  };

  const near = (kind, x, y, skip) => d.items.filter(i => i.kind === kind && i !== skip).reduce((a, i) => {
    const q = i.points ? i.points[0] : [i.x, i.y], s = Math.hypot(q[0] - x, q[1] - y); return !a || s < a.s ? {i, s} : a; }, null)?.i;
  const part = near("part", 90, 200), bend = near("track", 120, 210), gone = near("track", 130, 190, bend), from = near("track", 100, 220);
  const copy = d.items.filter(i => ["track", "via", "part"].includes(i.kind) && Math.abs((i.x ?? i.points[0][0]) - 60) < 3 && Math.abs((i.y ?? i.points[0][1]) - 230) < 2).slice(0, 4);
  const gnd = d.items.find(i => i.kind === "polygon" && i.net === "GND" && i.layer === "Top");
  let n = 0;
  const series = [
    ["move part", () => H.edit(() => { part.x += .5; part.y += .3; }, "test", [part])],
    ["bend track", () => H.edit(() => { bend.points[1] = [bend.points[1][0], bend.points[1][1] - .2]; }, "test", [bend])],
    ["add track", () => { const t = {id: "dmg-t" + (++n), kind: "track", layer: from.layer, width: .22, net: from.net, points: [from.points[2].slice(), [from.points[2][0] + 1.2, from.points[2][1] + .4]]}; H.edit(() => { d.items.push(t); }, "test", [t]); }],
    ["delete track", () => H.edit(() => { d.items.splice(d.items.indexOf(gone), 1); }, "test", [gone])],
    ["paste 4", () => H.edit(() => { for (const s of copy) { const c = JSON.parse(JSON.stringify(s)); c.id = "dmg-p" + (++n); if (c.points) c.points = c.points.map(q => [q[0] + .4, q[1] + 6]); else { c.x += .4; c.y += 6; } if (c.ref) c.ref += "_" + n; d.items.push(c); } })],
    ["undo", () => H.act("undo")],
    ["redo", () => H.act("redo")],
    ["move part back", () => H.edit(() => { part.x -= .5; part.y -= .3; }, "test", [part])],
    ["pour outline", () => H.edit(() => { gnd.points = gnd.points.map(([x, y]) => [x, y === 270 ? 266 : y]); }, "test", [gnd])],
    ["pour clearance", () => H.edit(() => { gnd.clearance = (gnd.clearance || .3) + .1; }, "test", [gnd])],
    ["undo clearance", () => H.act("undo")]
  ];
  const rows = [];
  for (const [name, run] of quick ? series.slice(0, 3) : series) {
    label = name; const f0 = frames.length, c0 = copperPatches;
    run();
    await quiet();
    const mine = frames.slice(f0);
    rows.push({name, frames: mine.length, copper: copperPatches - c0, reused: mine.filter(f => f.reused).length,
      // Antialiasing noise of at most NOISE levels is allowed: a batched item patch is inexact by design
      // until the exact idle frame (canvas-fast.js), and a big region filled in part (canvas-fast.js
      // pourRings, as gesture frames and item patches have always done) can round an edge pixel
      // differently from its whole path. Copper left stale or missing differs by far more (the control).
      exact: mine.filter(f => !f.pixels).length, noisy: mine.filter(f => f.pixels && f.max <= NOISE).length,
      bad: mine.filter(f => f.pixels && f.max > NOISE).map(f => ({pixels: f.pixels, max: f.max, box: f.box, reused: f.reused, inexact: f.inexact}))});
  }
  // The control: the same kind of edit with the copper damage dropped must leave a stale picture.
  shrink = true; label = "control";
  const c0 = frames.length;
  H.edit(() => { bend.points[1] = [bend.points[1][0], bend.points[1][1] + .35]; }, "test", [bend]);
  await quiet();
  shrink = false;
  const control = frames.slice(c0);
  globalThis.AtriumCanvasFast = F; P.viewDamage = viewDamage;
  I.armIdle = arm;
  return {frames: debug ? frames.slice(0, 40).map(({shots: s, ...f}) => f) : null, shots: shots.map(({shots: s, ...row}) => ({...row, retained: s[0], full: s[1]})), rows, control: {frames: control.length, caught: control.some(f => f.max > NOISE), pixels: Math.max(0, ...control.map(f => f.pixels || 0)), max: Math.max(0, ...control.map(f => f.max || 0))},
    gpu: !!I.gpu, efficiency: AtriumPower.mode(), tiles: AtriumPolygonPour.tiles.history?.length || 0};
}

if (require.main === module) {
  if (!fs.existsSync(executablePath)) { console.log("SKIP browser-pour-damage: Chromium is unavailable."); process.exit(0); }
  try { require.resolve("playwright-core"); } catch { console.log("SKIP browser-pour-damage: Playwright Core is unavailable."); process.exit(0); }
  const args = ["--allow-file-access-from-files", "--force-device-scale-factor=1"];
  if (!gpu) args.push("--disable-gpu");
  launch({headless: true, executablePath, args}, async browser => {
    const r = await main(browser);
    for (const row of r.rows) console.log((row.bad.length ? "FAIL " : "ok   ") + JSON.stringify(row));
    console.log("control " + JSON.stringify(r.control));
    const bad = r.rows.filter(row => row.bad.length);
    assert.equal(bad.length, 0, "frames differ from a full paint: " + JSON.stringify(bad));
    assert.ok(r.control.caught, "a frame with the copper damage dropped must differ from a full paint");
    const patched = r.rows.reduce((n, row) => n + row.copper, 0);
    assert.ok(patched > 0, "no frame repainted changed copper in part");
    console.log(`PASS browser-pour-damage (${r.efficiency}${r.gpu ? ", GPU" : ""}): ${r.rows.length} edits, ${r.rows.reduce((n, row) => n + row.frames, 0)} frames equal to a full paint, ${patched} copper patches; tile passes ${r.tiles}`);
  }, error => { console.error(error); process.exit(1); });
}
module.exports = {main, pourDamage};
