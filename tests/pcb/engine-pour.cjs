"use strict";
// The Rust/WebAssembly polygon pour core (engine/src/pour.rs, AtriumEngine.pourSolve) against the
// JS core (polygon-pour.js PourCore().solve), which stays the fallback:
//   * fuzz: random integer tasks full of crossings, T-junctions, coincident and collinear edges,
//     arc tags, anchors and earlier-pour classes give identical islands and stats;
//   * boards: the Eagle and KiCad demo fixtures, the Altium fixture and a dense board with ten
//     pours give identical pours, so identical fill area, and identical connectivity;
//   * refusals (bad input, coordinates past the core's range) return null, never a wrong answer.
// Run: scripts/test-jsc.sh engine-pour        (ATRIUM_ENGINE=wasm requires the module)
//      node tests/pcb/engine-pour.cjs [--fixtures PATH...]   (real .brd, .kicad_pcb, .PcbDoc boards or folders)
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const mode = globalThis.ATRIUM_ENGINE ?? process.env.ATRIUM_ENGINE;
require("../../app/engine-core.js");
const engine = AtriumEngine;
if (mode === "wasm") assert.ok(engine.available, "Rust/WebAssembly kernels: " + engine.failure);
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const f of ["model", "parts", "sch-objects", "hierarchy", "board-shape", "board-shape-sources", "stackup", "viastack", "pcb-appearance", "pcb-pours", "polygon-pour",
  "component-classes", "query", "net-ties", "connectivity", "altium-rules", "rules", "signals", "import-link", "source-file", "sch-import", "pcb-import", "io",
  "sexpr", "import-kicad", "import-eagle", "import-easyeda"]) require(require("../support/app-source-paths.cjs").appFile(f + ".js"));
require("./dense-board.js");
const PP = AtriumPolygonPour, enc = new TextEncoder();

if (!engine.available) {
  console.log("engine-pour: the Rust/WebAssembly kernels are not loaded (ATRIUM_ENGINE=" + (mode || "auto") + "); nothing to compare");
  return;
}
// A real Wasm RuntimeError carries a stack for an instance that imports the
// solver's memory. Keep the public bridge alive across garbage-collection jobs.
async function testTrappedEngineMemory(root) {
  const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const file = part => path.join(root, part);
  let payload;
  vm.runInNewContext(fs.readFileSync(file("app/engine-mvp.js"), "utf8"), {
    AtriumEngine: {install(kind, bytes) { assert.equal(kind, "mvp"); payload = bytes; }}
  });
  const trap = new WebAssembly.Module(Uint8Array.of(
    0,97,115,109,1,0,0,0,1,4,1,96,0,0,2,13,1,1,101,6,109,101,109,111,114,121,2,0,0,
    3,2,1,0,7,8,1,4,116,114,97,112,0,0,10,5,1,3,0,0,11
  ));
  require(file("app/pcb/polygon-pour.js"));
  const core = AtriumPolygonPour._internal.core;
  const task = {shapes:[{cls:0,ring:Int32Array.of(0,0,20,0,20,20,0,20),sign:1,tags:null}],
    K:6,hasBoard:false,anchors:[],removeDead:false,minArea:0,minSize:0};
  const exact = core.solve(task).islands;
  assert(exact.length);
  let trapNext = false, calls = 0, memory, buffer;
  const source = fs.readFileSync(file("engine/bridge.js"), "utf8");
  function factory(tap, fail = () => false) {
    const wrap = (instance, module) => ({exports:tap(instance.exports, module)});
    const wasm = Object.create(WebAssembly);
    Object.defineProperties(wasm, {
      Instance:{value:function(module, imports) {
        if (fail()) throw new WebAssembly.LinkError("injected restart failure");
        return wrap(new WebAssembly.Instance(module, imports), module);
      }},
      instantiate:{value:async function(bytes, imports) {
        const {instance,module} = await WebAssembly.instantiate(bytes, imports);
        return {instance:wrap(instance,module), module};
      }}
    });
    return new Function("WebAssembly", source + "\nreturn createAtriumEngine;")(wasm);
  }
  async function collect() {
    for (let i = 0; i < 12; i++) {
      await new Promise(resolve => setImmediate(resolve));
      global.gc();
    }
  }
  const bridge = factory(exports => {
    const own = exports.memory;
    own.grow(4); // Four logical pages and no large fixture.
    memory = new WeakRef(own);
    return {...exports, pour_solve() {
      calls++;
      if (trapNext) new WebAssembly.Instance(trap, {e:{memory:own}}).exports.trap();
      return exports.pour_solve();
    }};
  })("mvp", payload, "wasm");
  assert(bridge.available);
  assert.deepEqual(bridge.pourSolve(task).islands, exact);
  buffer = new WeakRef(memory.deref().buffer);
  trapNext = true;
  globalThis.AtriumEngine = bridge;
  assert.deepEqual(core.solve(task).islands, exact);
  assert.deepEqual(core.solve(task).islands, exact);
  assert.equal(calls, 2);
  assert.equal(bridge.available, false);
  assert.equal(bridge.workerSource(), "");
  assert.equal(bridge.stats.fallbacks, 1);
  assert.match(bridge.failure, /unreachable/);
  await collect();
  assert.equal(globalThis.AtriumEngine, bridge);
  assert.equal(memory.deref(), undefined, "the trapped engine must release its linear memory");
  assert.equal(buffer.deref(), undefined, "the trapped engine must release its ArrayBuffer");
  assert.match(bridge.failure, /unreachable/);
  let action = "solve", shouldFailRestart = false;
  const instances = [];
  const retry = factory((exports, module) => {
    const own = exports.memory;
    instances.push({module, memory:new WeakRef(own), initial:own.buffer.byteLength});
    return {...exports, pour_solve() {
      if (action === "grow" || action === "grow-refuse") own.grow(4096); // Logical pages without writing the backing.
      if (action === "refuse" || action === "grow-refuse") return -2;
      if (action === "invalid") return -1;
      return exports.pour_solve();
    }};
  }, () => shouldFailRestart)("mvp", payload, "wasm", true);
  await retry.ready;
  assert(retry.available);
  globalThis.AtriumEngine = retry;
  action = "refuse";
  assert.deepEqual(core.solve(task).islands, exact);
  assert.equal(instances.length, 1, "small status -2 reuses its instance");
  action = "grow";
  assert.deepEqual(retry.pourSolve(task).islands, exact);
  assert.equal(instances.length, 1, "a successful grown solve remains available");
  action = "invalid";
  assert.equal(retry.pourSolve(task), null);
  assert.equal(instances.length, 1, "status -1 reuses even a grown instance");
  action = "refuse"; // Reuse an already-grown backing without growing again.
  assert.deepEqual(core.solve(task).islands, exact);
  assert.equal(instances.length, 2, "status -2 retires the already-grown instance");
  assert.equal(instances[0].module, instances[1].module);
  assert.equal(instances[0].initial, instances[1].initial);
  await collect();
  assert.equal(instances[0].memory.deref(), undefined);
  action = "solve";
  assert.deepEqual(retry.pourSolve(task).islands, exact);
  action = "grow-refuse";
  shouldFailRestart = true;
  assert.deepEqual(core.solve(task).islands, exact);
  assert.equal(retry.available, false);
  assert.equal(retry.workerSource(), "");
  assert.match(retry.failure, /injected restart failure/);
  await collect();
  assert.equal(instances[1].memory.deref(), undefined);
  assert.deepEqual(core.solve(task).islands, exact);
}
if (process.versions?.node) {
  const {spawnSync} = require("node:child_process");
  const child = spawnSync(process.execPath, ["--expose-gc", "--eval",
    "(" + testTrappedEngineMemory + ")(process.argv[1]).catch(e=>{console.error(e);process.exitCode=1;})",
    path.resolve(__dirname, "../..")], {encoding:"utf8", timeout:10000});
  assert.equal(child.status, 0, child.stderr || child.error?.message);
}

const withEngine = (on, f) => { globalThis.AtriumEngine = on ? engine : undefined; try { return f(); } finally { globalThis.AtriumEngine = engine; } };
const timing = s => Object.fromEntries(Object.entries(s).filter(([k]) => !/^t[A-Z]/.test(k)));
const clean = r => ({islands: r.islands.map(i => ({ring: Array.from(i.ring), tags: Array.from(i.tags), links: i.links,
  holes: i.holes.map(h => ({ring: Array.from(h.ring), tags: Array.from(h.tags)}))})), stats: timing(r.stats)});

// ---------------------------------------------------------------- 1. core fuzz
let seed = 0x5eed;
const random = () => { seed = (Math.imul(1664525, seed) + 1013904223) >>> 0; return seed / 4294967296; };
const int = n => Math.floor(random() * n);
function shape(grid) {
  const kind = int(4), x = int(grid), y = int(grid), w = 1 + int(grid / 2), h = 1 + int(grid / 2), ring = [];
  if (kind === 0) ring.push(x, y, x + w, y, x + w, y + h, x, y + h);                       // rectangle (shared edges)
  else if (kind === 1) for (let i = 0; i < 3 + int(5); i++) ring.push(int(grid), int(grid)); // random, often self-crossing
  else if (kind === 2) { const n = 6 + int(10), r = 1 + int(grid / 3); for (let i = 0; i < n; i++) ring.push(Math.round(x + r * Math.cos(6.283 * i / n)), Math.round(y + r * Math.sin(6.283 * i / n))); }
  else ring.push(x, y, x + w, y, x + w, y + 1, x + 1, y + 1, x + 1, y + h, x, y + h);       // L shape (reflex vertex)
  return ring;
}
const core = PP._internal.PourCore();
let compared = 0, unresolved = 0, nonEmpty = 0;
for (let trial = 0; trial < 400; trial++) {
  const grid = [8, 40, 3000, 2e6][trial % 4], K = 6 + int(3), shapes = [];
  shapes.push({cls: 0, ring: Int32Array.from([0, 0, grid, 0, grid, grid, 0, grid]), sign: 1, tags: null});
  if (random() < .5) shapes.push({cls: 1, ring: Int32Array.from([-1, -1, grid - 2, -1, grid - 2, grid + 1, -1, grid + 1]), sign: 1, tags: null});
  for (let i = int(14); i > 0; i--) {
    const ring = Int32Array.from(shape(grid)), n = ring.length >> 1;
    const tags = random() < .3 ? Int32Array.from({length: n}, () => random() < .5 ? int(4) : -1) : null;
    shapes.push({cls: [2, 2, 3, 4, 5, 6, 7][int(7)] % K, ring, sign: random() < .8 ? 1 : -1, tags});
  }
  const anchors = Array.from({length: int(4)}, () => Int32Array.from(shape(grid)));
  const task = {shapes, K, hasBoard: shapes[1]?.cls === 1, anchors, removeDead: random() < .5, minArea: random() < .3 ? grid : 0, minSize: random() < .3 ? 2 : 0};
  const js = withEngine(false, () => core.solve(task)), rust = engine.pourSolve(task);
  assert.ok(rust, "trial " + trial + " was refused");
  assert.deepEqual(clean(rust), clean(js), "trial " + trial);
  compared++; if (js.stats.unresolved) unresolved++; if (js.islands.length) nonEmpty++;
}
assert.ok(nonEmpty > 100, "the fuzz produces copper");
// Refusals: malformed tasks and coordinates past the exact range run the JS core instead.
const square = s => Int32Array.from([0, 0, s, 0, s, s, 0, s]);
const ok = {shapes: [{cls: 0, ring: square(10), sign: 1, tags: null}], K: 6, hasBoard: false, anchors: [], removeDead: false, minArea: 0, minSize: 0};
assert.ok(engine.pourSolve(ok));
for (const bad of [{...ok, K: 3}, {...ok, shapes: [{...ok.shapes[0], cls: 9}]}, {...ok, shapes: [{...ok.shapes[0], ring: [0, 0, 1, 0, 1, 1]}]},
  {...ok, shapes: [{...ok.shapes[0], tags: Int32Array.of(1)}]}, {...ok, shapes: [{...ok.shapes[0], sign: 2}]}, {...ok, shapes: [{...ok.shapes[0], ring: square(2e7)}]},
  {...ok, minArea: NaN}]) assert.equal(engine.pourSolve(bad), null);
// The hook: PourCore().solve uses the module when it is there and the JS core otherwise.
assert.deepEqual(clean(core.solve(ok)), clean(withEngine(false, () => core.solve(ok))));

// ---------------------------------------------------------------- 2. boards
function area(doc) {
  let total = 0;
  for (const r of doc.pcbDrawing?.pours || []) for (const ring of AtriumPCBPours.contours(r)) {
    let s = 0; const n = ring.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) s += ring[2 * j] * ring[2 * i + 1] - ring[2 * i] * ring[2 * j + 1];
    total += s / 2;
  }
  return total;
}
function compare(name, load) {
  const source = withEngine(false, load);
  const run = on => withEngine(on, () => {
    // Both engine runs start with the same authored IDs, rules and signals.
    const project = source.project && AtriumSignals.attach(Atrium.clone(source.project));
    const doc = project ? project.documents.find(d => d.id === source.doc.id) : Atrium.clone(source.doc);
    const defs = project ? new Map(project.library.map(d => [d.id, d])) : source.defs;
    const t = Date.now();
    if (doc.pcbDrawing?.sourceFill) PP.adopt(doc, defs);
    PP.apply(doc, defs, {});
    return {pours: JSON.stringify(doc.pcbDrawing?.pours || []), area: area(doc), ms: Date.now() - t, conn: AtriumConnectivity.inspect(doc, defs), n: (doc.pcbDrawing?.pours || []).length};
  });
  const before = engine.stats.fallbacks, js = run(false), rust = run(true);
  assert.equal(engine.stats.fallbacks, before, name + ": no pour task was refused");
  assert.ok(Math.abs(rust.area - js.area) <= 1e-6 * Math.max(1, Math.abs(js.area)), name + ": fill area");
  assert.equal(rust.pours, js.pours, name + ": identical pours");
  assert.deepEqual(rust.conn, js.conn, name + ": identical connectivity");
  console.log("  " + name + ": " + js.n + " regions, identical (JS " + js.ms + " ms, Rust/WebAssembly " + rust.ms + " ms)");
}
const fromFile = (file, bytes) => () => {
  if (/\.pcbdoc$/i.test(file)) {
    const r = AtriumIO.read(path.basename(file), new Uint8Array(bytes)), p = Atrium.project("Board");
    p.documents = r.documents || []; p.library = r.library || []; AtriumImportLink.reconcile(p, p.documents); Atrium.validate(p);
    return {project: p, doc: p.documents.find(d => d.kind === "pcb")};
  }
  const [r] = AtriumImportFormats.readSet([{name: path.basename(file), bytes: new Uint8Array(bytes)}]);
  const p = Atrium.project("Board"); p.documents = r.documents; p.library = r.library; AtriumImportLink.reconcile(p, p.documents); Atrium.validate(p);
  return {project: p, doc: p.documents.find(d => d.kind === "pcb")};
};
const FIX = path.join(__dirname, "../fixtures");
console.log("engine-pour: " + compared + " fuzzed tasks identical (" + unresolved + " unresolved snapping)");
compare("Eagle demo", fromFile("demo-eagle.brd", fs.readFileSync(path.join(FIX, "import", "demo-eagle.brd"))));
compare("KiCad demo", fromFile("demo.kicad_pcb", fs.readFileSync(path.join(FIX, "import", "demo.kicad_pcb"))));
compare("Altium fixture", fromFile("PiDP11IOExpander.PcbDoc", fs.readFileSync(path.join(FIX, "altium", "pidp11-io-expander", "PiDP11IOExpander.PcbDoc"))));
compare("dense board, ten pours", () => {
  const {d, defs} = makeAtriumBenchmarkBoard(48);
  let k = 0;
  for (const i of d.items) { if (i.kind === "part") i.pinNets = {"1": "N" + (k % 16), "2": "N" + ((k + 1) % 16)}; else if (i.kind !== "track") i.net = "N" + (k % 16); k++; }
  const rect = (a, b, c, e) => [[a, b], [c, b], [c, e], [a, e]], W = 48 * 2.3, H = 48 * 1.72;
  const polys = [["Top", "N0", rect(1, 1, W / 2, H - 1)], ["Top", "N1", rect(W / 2, 1, W - 1, H - 1)], ["Bottom", "N0", rect(1, 1, W - 1, H / 2)], ["Bottom", "N1", rect(1, H / 2, W - 1, H - 1)]];
  for (let j = 0; j < 6; j++) polys.push([j % 2 ? "Top" : "Bottom", "N" + (j + 2), rect(3 + j * 15, 3, 14 + j * 15, 20)]);
  polys.forEach(([layer, net, o], j) => d.items.push(PP.make(o, {layer, net, pourIndex: j, removeDeadCopper: j % 3 === 0, connectStyle: j % 2 ? "relief" : "direct"})));
  return {doc: d, defs};
});
// --fixtures PATH...: boards, or folders of boards (folders need Node: the JSC shim cannot list them).
const at = process.argv.indexOf("--fixtures"), given = at < 0 ? [] : process.argv.slice(at + 1);
const walk = f => { try { return fs.readdirSync(f).flatMap(n => walk(path.join(f, n))); } catch { return [f]; } };
for (const f of given.flatMap(walk).filter(f => /\.(brd|kicad_pcb|pcbdoc)$/i.test(f)).sort()) {
  let load;
  try { load = fromFile(f, fs.readFileSync(f)); load(); } catch (e) { console.log("  skip " + path.basename(f) + ": " + e.message); continue; }
  compare(path.basename(f), load);
}
console.log("engine-pour: Rust/WebAssembly pour core matches the JS core");
