"use strict";
// Autorouter benchmark: engine v1 against engine v2 on the same unrouted boards.
//
//   scripts/test-jsc.sh autorouter-bench            quick check (sample + eco-e2e, both engines, DRC 0)
//   jsc tests/jsc-shim.js -- tests/pcb/autorouter-bench.cjs --run [--engines v1,v2] [--boards a,b] [--real DIR] [--svg] [--json]
//   node tests/pcb/autorouter-bench.cjs --run ...       (the same under Node)
//
// Metrics per board and engine (the new copper only):
//   completion  connections routed / connections in scope (from connectivity after applying the plan)
//   length      total length of the new tracks (mm)
//   vias        new vias, fanout vias included
//   drc         clearance violations against an independent checker + shorts + copper outside the
//               outline + new AtriumRules.drc violations (copper rules); must be 0
//   ms          wall time of the engine call
//   bends       interior track vertices per routed connection; 45°: share of segments at a multiple
//               of 45°; acute: corners sharper than 90°   ("human-likeness")
//   spread      for boards with matched-length groups: longest - shortest member (mm) per group
// --svg prints each routed board as an SVG between "SVG-BEGIN name" and "SVG-END" lines.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
globalThis.CFB ??= (() => { try { return require("../../app/vendor/cfb.min.js"); } catch { return undefined; } })();
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "stackup", "viastack", "polygon-pour", "pcb-pours", "import-link", "connectivity", "net-ties", "rules",
  "length-tuning", "router", "diffpair", "teardrops", "autorouter", "fanout", "autorouter-v2"]) { try { require(require("../support/app-source-paths.cjs").appFile(f + ".js")); } catch (e) { if (["model", "parts", "connectivity", "rules", "autorouter", "fanout"].includes(f)) throw e; } }
for (const f of ["sexpr", "kicad-export", "import-kicad", "import-eagle", "altium-rules", "sch-import", "pcb-import", "io", "drc"]) { try { require(require("../support/app-source-paths.cjs").appFile(f + ".js")); } catch { /* importers are optional */ } }
require("./autorouter-bench-boards.js");
const H = require("./autorouter.cjs");
const A = globalThis.Atrium, AR = globalThis.AtriumAutorouter, B = globalThis.AtriumBenchBoards, C = globalThis.AtriumConnectivity;
const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
const argv = typeof process !== "undefined" ? process.argv : [];
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const ROOT = path.join(__dirname, "../..");
const bytesOf = file => new Uint8Array(fs.readFileSync(file));

// ------------------------------------------------------------------ boards
function sample() { const p = AtriumParts.example(), b = p.documents[1]; B.strip(b); return {d: b, defs: new Map(p.library.map(x => [x.id, x])), project: p}; }
function eco() {
  const p = require("../support/native-cad.cjs").nativeCAD("eco-benchmark");
  // The board uses starter-library parts; ECO copied their definitions into the project library.
  const lib = new Map([...(AtriumParts.catalogue || []).map(x => [x.id, x]), ...(p.library || []).map(x => [x.id, x])]);
  const b = p.documents.find(x => x.kind === "pcb");
  B.strip(b);
  return {d: b, defs: lib, project: p};
}
function altium() {
  const dir = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
  const files = ["PCB-PiDP11IOExpander.PrjPcb", "PiDP11IOExpander.SchDoc", "PiDP11IOExpander.PcbDoc"].map(n => [n, bytesOf(path.join(dir, n))]);
  return B.fromProject(B.importFiles(files, "PiDP-11 I/O Expander"), "PiDP-11");
}
function imported(file, name) { return B.fromProject(B.importFiles([[path.basename(file), bytesOf(file)]], name), name); }
const FIX = path.join(__dirname, "../fixtures/import");
const BOARDS = {
  sample: {name: "Sample (sensor board)", make: sample},
  eco: {name: "eco-e2e board", make: eco},
  pidp11: {name: "Altium PiDP-11 I/O", make: altium, heavy: true},
  "kicad-demo": {name: "KiCad demo", make: () => imported(path.join(FIX, "demo.kicad_pcb"), "KiCad demo")},
  "eagle-demo": {name: "Eagle demo", make: () => imported(path.join(FIX, "demo-eagle.brd"), "Eagle demo")},
  "dense-4L": {name: "Dense 4L (seed 11)", make: () => ({...H.routingBoard({seed: 11}), layers: ["Top", "Inner 1", "Inner 2", "Bottom"]}), heavy: true},
  "dense-2L": {name: "Dense 2L (seed 12)", make: () => H.routingBoard({seed: 12}), heavy: true},
  "bga256-4L": {name: "BGA-256 0.8 mm, 4L", make: B.synthetic["bga256-4L"], heavy: true},
  "bga256-6L": {name: "BGA-256 0.8 mm, 6L", make: B.synthetic["bga256-6L"], heavy: true},
  qfn48: {name: "QFN-48, 2L", make: B.synthetic.qfn48},
  membus: {name: "Memory bus (length groups), 4L", make: B.synthetic.membus},
  pairs: {name: "USB + Ethernet pairs, 4L", make: B.synthetic.pairs}
};
// Cached real designs (downloads are not in the repository): --real DIR
const REAL = [["kicad-pic-programmer/pic_programmer.kicad_pcb", "KiCad pic_programmer"], ["kicad-stickhub/StickHub.kicad_pcb", "KiCad StickHub"],
  ["eagle-feather-m0/Adafruit Feather M0 Basic rev C.brd", "Eagle Feather M0"], ["eagle-qtpy/Adafruit QT Py.brd", "Eagle QT Py"]];
function addReal(dir) {
  for (const [rel, name] of REAL) {
    const file = path.join(dir, rel);
    try { fs.readFileSync(file); } catch { continue; }
    BOARDS["real:" + name] = {name, make: () => imported(file, name), heavy: true, real: true};
  }
}

// ------------------------------------------------------------------ metrics
const pathLen = pts => { let s = 0; for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return s; };
function shapeMetrics(items) {
  let segs = 0, oct = 0, bends = 0, acute = 0;
  for (const t of items) {
    if (t.kind !== "track") continue;
    const p = t.points;
    for (let i = 1; i < p.length; i++) {
      const dx = p[i][0] - p[i - 1][0], dy = p[i][1] - p[i - 1][1];
      if (Math.hypot(dx, dy) < 1e-6) continue;
      segs++;
      const a = Math.atan2(dy, dx) * 180 / Math.PI, m = ((a % 45) + 45) % 45;
      if (m < 0.5 || m > 44.5) oct++;
      if (i >= 2) {
        const ex = p[i - 1][0] - p[i - 2][0], ey = p[i - 1][1] - p[i - 2][1];
        bends++;
        if (ex * dx + ey * dy < -1e-9) acute++;
      }
    }
  }
  return {segs, oct45: segs ? oct / segs : 1, bends, acute};
}
const COPPER_RULES = new Set(["clearance", "short", "width", "holeToHole", "annularRing", "holeSize", "boardOutline", "layerPairs", "hdiVias", "diffPairsRouting"]);
function drcCounts(d, defs, project) {
  const R = globalThis.AtriumRules;
  if (!R?.drc) return null;
  try {
    const res = R.drc(d, defs, R.stored(d, project) || R.defaults(), {project, limit: 100000});
    const out = {};
    for (const v of res.violations) if (COPPER_RULES.has(v.type)) out[v.type] = (out[v.type] || 0) + 1;
    return out;
  } catch { return null; }
}
function scoped(airwires, scope) { return scope?.nets ? airwires.filter(a => scope.nets.includes(a.net)) : airwires; }

function runEngine(engine, spec, o = {}) {
  const b = spec.make();
  if (!b) return null;
  const {d, defs, project} = b;
  const before = new Set(d.items.map(i => i.id));
  const conn0 = C.inspect(d, defs), total0 = scoped(conn0.airwires, b.scope).length, shorts0 = conn0.shorts.length;
  const drc0 = o.drc === false ? null : drcCounts(d, defs, project);
  const options = {project, layers: b.layers, scope: b.scope, router: {timeLimit: o.timeLimit ?? 120000, ...(o.router || {})}};
  let plan;
  const t = now();
  if (engine === "v1") {
    // v1 as shipped: the multi-layer strategy fans out BGAs first.
    const multi = (b.layers?.length || AR.boardLayers(d, defs).length) > 2;
    plan = AR.routeBoard(d, defs, {...options, fanout: multi && b.fanout !== false, fanoutOptions: {auto: "bga"}, router: {...(multi ? AR.STRATEGIES[1].router : AR.STRATEGIES[0].router), ...options.router}});
  } else {
    const V2 = globalThis.AtriumAutorouterV2;
    if (!V2) throw Error("autorouter-v2.js is not loaded");
    plan = V2.routeBoard(d, defs, {...options, fanout: b.fanout, powerNets: b.power, lengthGroups: b.groups, ...(o.v2 || {})});
  }
  const ms = now() - t;
  AR.apply(d, plan);
  if (plan.modify?.length) { const by = new Map(d.items.map(i => [i.id, i])); for (const m of plan.modify) { const it = by.get(m.id); if (it) Object.assign(it, m.set || m); } }
  const fresh = new Set(d.items.filter(i => !before.has(i.id)).map(i => i.id));
  const newItems = d.items.filter(i => fresh.has(i.id));
  const viol = H.clearanceViolations(d, defs, fresh, project);
  const outside = H.outsideOutline(d, fresh, 0);
  const conn = C.inspect(d, defs);
  const left = scoped(conn.airwires, b.scope).length;
  const drc1 = drc0 ? drcCounts(d, defs, project) : null;
  let drcNew = 0;
  const drcTypes = {};
  if (drc0 && drc1) for (const k of Object.keys(drc1)) { const n = Math.max(0, drc1[k] - (drc0[k] || 0)); if (n) { drcNew += n; drcTypes[k] = n; } }
  const shape = shapeMetrics(newItems);
  const routed = Math.max(0, total0 - left);
  const row = {board: spec.name, engine, connections: total0, routed, completion: total0 ? routed / total0 : 1,
    length: newItems.filter(i => i.kind === "track").reduce((s, i) => s + pathLen(i.points), 0),
    vias: newItems.filter(i => i.kind === "via" && !(b.power || []).includes(i.net)).length, planeVias: newItems.filter(i => i.kind === "via" && (b.power || []).includes(i.net)).length,
    drc: viol.length + Math.max(0, conn.shorts.length - shorts0) + outside.length + drcNew, drcTypes, clearance: viol.length, shorts: Math.max(0, conn.shorts.length - shorts0), outside: outside.length, drcNew, ms,
    bends: routed ? shape.bends / routed : 0, oct45: shape.oct45, acute: shape.acute};
  if (b.groups && globalThis.AtriumLength?.evaluate) {
    row.spread = {};
    for (const g of AtriumLength.evaluate(d, defs)) if (b.groups.includes(g.key)) row.spread[g.name] = +g.spread.toFixed(2);
  }
  if (plan.report?.pairs?.length) row.coupled = plan.report.pairs.reduce((s, p) => s + p.coupled, 0) / plan.report.pairs.length;
  if (o.svg) row.svg = H.render(d, defs, {violations: viol, title: spec.name + " · " + engine + " · " + routed + "/" + total0});
  if (o.keep) row.doc = d;
  return row;
}

function table(rows) {
  const f = (v, k = 1) => Number.isFinite(v) ? v.toFixed(k) : "–";
  const head = "| Board | Engine | Completion | Length (mm) | Vias | DRC | Time (s) | Bends/conn | 45° | Acute | Extra |";
  const lines = [head, "|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    const extra = [r.spread ? "spread " + Object.entries(r.spread).map(([k, v]) => k + " " + v).join(", ") : "", r.coupled != null ? "coupled " + (100 * r.coupled).toFixed(0) + "%" : ""].filter(Boolean).join("; ");
    lines.push(`| ${r.board} | ${r.engine} | ${r.routed}/${r.connections} (${f(100 * r.completion)}%) | ${f(r.length, 0)} | ${r.vias} | ${r.drc} | ${f(r.ms / 1000, 2)} | ${f(r.bends, 2)} | ${f(100 * r.oct45, 0)}% | ${r.acute} | ${extra} |`);
  }
  return lines.join("\n");
}

// --repeat N: run each board N times and keep the fastest (the results are deterministic).
function repeat(fn) {
  const n = Math.max(1, +arg("--repeat", 1));
  let best = null;
  for (let i = 0; i < n; i++) { const r = fn(); if (!best || (r && r.ms < best.ms)) best = r; }
  return best;
}
function run() {
  if (arg("--real")) addReal(arg("--real"));
  const engines = (arg("--engines", "v1,v2")).split(",");
  const pick = arg("--boards");
  const names = pick ? pick.split(",") : Object.keys(BOARDS);
  const rows = [];
  for (const k of names) {
    const spec = BOARDS[k];
    if (!spec) { console.log("unknown board " + k); continue; }
    for (const e of engines) {
      let row;
      try { row = repeat(() => runEngine(e, spec, {svg: argv.includes("--svg"), timeLimit: +arg("--time", 120000), router: arg("--router") ? JSON.parse(arg("--router")) : undefined, v2: arg("--v2") ? JSON.parse(arg("--v2")) : undefined})); }
      catch (error) { console.log("ERROR " + spec.name + " " + e + ": " + (error && error.message) + "\n" + (error.stack || error)); continue; }
      if (!row) { console.log("skip " + spec.name); continue; }
      if (row.svg) { console.log("SVG-BEGIN " + (spec.name + "-" + e).replace(/[^a-z0-9]+/gi, "-")); console.log(row.svg); console.log("SVG-END"); delete row.svg; }
      rows.push(row);
      console.log("ROW " + JSON.stringify(row));
    }
  }
  console.log(table(rows));
  return rows;
}

// Quick check run by scripts/test-jsc.sh: both engines on the small boards, zero DRC, and v2 no
// worse than v1 on completion and vias.
function quick() {
  const engines = globalThis.AtriumAutorouterV2 ? ["v1", "v2"] : ["v1"];
  const rows = [];
  for (const k of ["sample", "eco"]) for (const e of engines) {
    const r = runEngine(e, BOARDS[k], {timeLimit: 30000});
    rows.push(r);
    assert.equal(r.drc, 0, r.board + " " + e + ": DRC " + JSON.stringify({clearance: r.clearance, shorts: r.shorts, outside: r.outside, drc: r.drcNew}));
    assert.equal(r.routed, r.connections, r.board + " " + e + " completion");
  }
  console.log(table(rows));
  if (engines.length === 2) for (let i = 0; i < rows.length; i += 2) {
    assert.ok(rows[i + 1].vias <= rows[i].vias, rows[i].board + ": v2 uses no more vias than v1");
  }
  console.log("autorouter-bench quick check passed");
}
module.exports = {BOARDS, runEngine, table, shapeMetrics, run};
const direct = require.main === module || (!require.main && /autorouter-bench\.cjs$/.test(String(argv[1] || "")));
if (direct) { if (argv.includes("--run")) run(); else quick(); }
