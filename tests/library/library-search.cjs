"use strict";
// Exact parity of the prepared folder index and the independent catalogue query. The optional
// cached official KiCad archives exercise the production 36k-component search budget.
const assert = require("node:assert/strict"), fs = require("node:fs");
for (const m of ["model", "parts", "component-families", "library-store", "library-panel", "sexpr", "import-kicad", "library-import-kicad", "catalogue", "library-sources", "kicad-models"]) require(require("../support/app-source-paths.cjs").appFile(m));
const C = AtriumCatalogue, S = AtriumLibrarySources;
const cmp = (defs, index, text, options = {}) => {
  const expected = C.query(options.accept ? defs.filter(options.accept) : defs, text, options);
  const {matching, ...actual} = C.queryPrepared(defs, index, text, options);
  assert.deepEqual(actual, expected, JSON.stringify(text));
  assert.equal(matching, expected.items.length);
};

async function scanRace() {
  const rec = {id: "library-race-test", name: "Test library", kind: "memory"};
  const make = names => new Map(names.map((name, i) => [
    "components/" + i + ".json", {mtime: i + 1, data: JSON.stringify({...AtriumParts.catalogue[0], id: "part-" + name, name})}]));
  const initial = S.providers.memory(make(["stable-R", "stable-C"]));
  S.addFolder(rec);
  const first = await S.scan(rec, {provider: initial});
  assert.equal(first.stats.read, 2);
  const again = await S.scan(rec);
  assert.equal(again.stats.read, 0);
  assert.equal(again.library.search, first.library.search, "an unchanged rescan reuses its prepared results");

  const delayed = S.providers.memory(make(["partial-X", "stale-Y"]));
  const read = delayed.read.bind(delayed);
  let release, blocked;
  const entered = new Promise(resolve => { blocked = resolve; });
  delayed.read = async p => {
    if (p.endsWith("1.json")) { blocked(); await new Promise(resolve => { release = resolve; }); }
    return read(p);
  };
  const listing = delayed.list.bind(delayed);
  delayed.list = async () => (await listing()).map(e => ({...e, mtime: 100 + e.mtime}));
  const stale = S.scan(rec, {provider: delayed}).then(() => null, e => e);
  await entered;
  const partial = S.library(rec.id);
  assert.ok(partial.scan);
  assert.deepEqual(C.queryPrepared(partial.defs, partial.search, "partial").items.map(d => d.name), ["partial-X"]);
  const next = await S.scan(rec, {provider: S.providers.memory(make(["replacement", "replacement second"]))});
  release();
  assert.equal((await stale).name, "AbortError");
  assert.equal(S.library(rec.id), next.library);
  assert.deepEqual(next.library.defs.map(d => d.name), ["replacement", "replacement second"]);
  assert.deepEqual(first.library.defs.map(d => d.name), ["stable-R", "stable-C"]);

  const less = S.providers.memory(make(["replacement"]));
  const removed = await S.scan(rec, {provider: less});
  assert.equal(removed.stats.removed, 1);
  assert.equal(C.queryPrepared(removed.library.defs, removed.library.search, "second").items.length, 0);

  const abort = new AbortController();
  const stuck = {async list() { abort.abort(); return []; }};
  await assert.rejects(S.scan(rec, {provider: stuck, signal: abort.signal}), {name: "AbortError"});
  assert.equal(S.library(rec.id), removed.library, "cancelling restores the committed library");
  await S.removeFolder(rec.id);
}

async function tables() {
  const fixture = path => fs.readFileSync(__dirname + "/../fixtures/kicad/" + path, "utf8");
  const library = fixture("Lab_Amp.kicad_sym").replace(/Lab_Package:/g, "PackageAlias:");
  const providers = S.providers.memory(new Map([
    ["sym-lib-table", {data: '(sym_lib_table (lib (name "AmpAlias")(type "KiCad")(uri "${KIPRJMOD}/symbols/Lab_Amp.kicad_sym")) (lib (name "Outside")(type "KiCad")(uri "../secret.kicad_sym")))'}],
    ["fp-lib-table", {data: '(fp_lib_table (lib (name "PackageAlias")(type "KiCad")(uri "${KICAD10_FOOTPRINT_DIR}/Lab_Package.pretty")))'}],
    ["symbols/Lab_Amp.kicad_sym", {data: library}],
    ["footprints/Lab_Package.pretty/SOIC-8_Test.kicad_mod", {data: fixture("Lab_Package.pretty/SOIC-8_Test.kicad_mod")}]
  ]));
  const {library: source} = await S.refresh({id: "ki-table", name: "KiCad tables"}, providers);
  const stub = source.defs.find(d => d.name === "OPA_DUAL"), files = new Map();
  assert.equal(stub.stub.entry, "AmpAlias:OPA_DUAL");
  assert.equal(stub.footprint.name, "SOIC-8_Test");
  for (const p of S.needs(stub)) files.set(p, await providers.read(p));
  const full = S.materialise(stub, files);
  assert.equal(full.source.entry, "AmpAlias:OPA_DUAL");
  assert.equal(full.source.footprint.entry, "PackageAlias:SOIC-8_Test");
  assert.equal(full.footprint.pads.length, 8);
  assert.deepEqual(source.report.tableMissing, [{table: "sym-lib-table", nickname: "Outside"}]);
  assert.deepEqual(AtriumKiCadModels.resolve(full.footprint.model3d.file), {variable: "KICAD8_3DMODEL_DIR", path: "Package_SO.3dshapes/SOIC-8_Test.step"});
  for (const path of ["../escape.step", "/abs.step", "Package/.hidden.step", "bad.wrl", "http://host/file.step"]) assert.equal(AtriumKiCadModels.resolve("${KICAD10_3DMODEL_DIR}/" + path), null);
  const original = globalThis.AtriumHost, read = [];
  globalThis.AtriumHost = {
    async chooseLibraryFolder(purpose) { assert.equal(purpose, "models"); return {grant: "test-models", name: "Models"}; },
    async libraryFolderRead(grant, paths) { read.push([grant, paths]); return [{data: "SVNPLTEwMzAzLTIxOw=="}]; }
  };
  try {
    await AtriumKiCadModels.choose();
    const ref = full.footprint.model3d.file;
    assert.equal(await AtriumKiCadModels.load(ref), "ISO-10303-21;");
    assert.equal(await AtriumKiCadModels.load(ref), "ISO-10303-21;");
    assert.deepEqual(read, [["test-models", ["Package_SO.3dshapes/SOIC-8_Test.step"]]]);
    await AtriumKiCadModels.remove("*");
    assert.equal(await AtriumKiCadModels.load(ref), null);
  } finally { globalThis.AtriumHost = original; }
}

async function run() {
  const source = AtriumParts.catalogue[0];
  const defs = [source, {...source, id: "starter-r-0603"}, {...source, id: "alias", name: "RÉS 20", value: "10 µF", category: "Capacitor",
    parameters: {"Tolerance": "1 %", Voltage: "50 V", MPN: "MY-RÉS"}}, {...source, id: "next", name: "RÉS 4", value: "10 uF"}, ...AtriumParts.catalogue.slice(1)];
  const index = C.prepare(defs);
  const queries = ["", "r", "é", "fo", "RÉS", "10µf", "r 10", "rés20", "10KΩ", "pins:2", "pins>2", "pads>=2", "has:3d", "has:footprint", "cat:passives",
    "v:50 tol:1%", "mount:SMD", "pkg:0603", "z pkg:0603", "r pkg:0603", "t cat:passives", "prefix:r", "id:alias", "mpn:rés", "constructor:rés", "thiscannotmatch"];
  for (const q of queries) {
    cmp(defs, index, q);
    cmp(defs, index, q, {state: {package: new Map([["0603", "0603"], ["no-such", "no-such"]]), mounting: new Map([["smd", "SMD"]])}});
    cmp(defs, index, q, {ids: new Set(defs.map(d => d.id)), accept: d => d.name !== "Resistor", keep: () => true});
  }
  const members = new Map([[source.id, {name: "Calibration", part: "Bench Model"}],
    ["alias", {name: "Calibration", part: "Surface Model"}]]);
  const grouped = C.prepare(defs, members);
  for (const text of ["", "c", "calibration", "bench model", "calibration pkg:0603", "surface pins:2", "other"]) {
    const ordinary = C.query(defs, text, {members});
    const {matching, ...prepared} = C.queryPrepared(defs, grouped, text);
    assert.deepEqual(prepared, ordinary, text);
    assert.equal(matching, ordinary.items.length);
    cmp(defs, index, text, {members});
    cmp(defs, grouped, text, {members: new Map()});
  }
  const updated = defs.findIndex(d => d.id === "alias");
  defs[updated] = {...defs[updated], description: "A newly visible keyword"};
  cmp(defs, index, "newly", {updates: new Set([index.order.indexOf(updated)])});
  console.log("PASS prepared search exactly matches catalogue item order, facet labels and populations, short and structured queries");
  await scanRace();
  console.log("PASS partial results are searchable, an unchanged rescan skips reads, removals update search, and superseded and cancelled scans cannot publish");
  await tables();
  console.log("PASS KiCad tables pair by nickname, check folder scope, and preserve portable model references");

  const dir = process.env.ATRIUM_KICAD_ARCHIVES;
  if (dir) {
    const archives = Object.fromEntries(["symbols", "footprints"].map(k => [k, new Blob([fs.readFileSync(dir + "/kicad-" + k + ".zip")])]));
    const {library: lib, stats} = await S.refresh({id: "kicad-official", name: "KiCad", kind: "zip"}, S.providers.archiveProvider(archives));
    assert.ok(lib.defs.length >= 36000);
    const queries = [..."abcdefghijklmnopqrstuvwxyz0123456789", "soic", "audio", "connector", "smd r", "pins>8", "has:3d", "cat:amplifier", "pkg:0603", "USB_C", ""];
    for (const q of queries) {
      cmp(lib.defs, lib.search, q);
      const plain = C.query(lib.defs, q), quick = C.queryPrepared(lib.defs, lib.search, q, {limit: 400, counts: false});
      assert.equal(quick.matching, plain.items.length);
      assert.deepEqual(quick.items, plain.items.slice(0, 400));
    }
    globalThis.gc?.();
    // Match the Library panel's input path with the facets disclosure closed. The parity loop
    // above separately exercises the full result and every facet population.
    const samples = queries.map(query => ({query, readings: []}));
    for (let round = 0; round < 22; round++) {
      for (const {query, readings} of samples) {
        const t = performance.now();
        C.queryPrepared(lib.defs, lib.search, query, {limit: 400, counts: false});
        readings.push(performance.now() - t);
      }
    }
    const timings = samples.map(({query, readings}) => [query, readings.slice(2).sort((a, b) => a - b)[18]]).sort((a, b) => b[1] - a[1]);
    console.log(JSON.stringify({components: lib.defs.length, indexMs: stats.ms, worstP95: timings.slice(0, 5)}));
    assert.ok(timings[0][1] <= 16, "every measured query runs within the frame budget at p95");
  }
}
globalThis.__testDone = run().catch(e => { console.error(e); process.exit(1); });
