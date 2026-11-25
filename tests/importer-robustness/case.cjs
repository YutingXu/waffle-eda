"use strict";

const assert = require("node:assert/strict");
const {Worker} = require("node:worker_threads");
const {resolveObjectURL} = require("node:buffer");
const {build, bytes} = require("./corpus.cjs");
const {snapshot, unchanged} = require("./prototypes.cjs");
const cam = require("../formats/gerber-compare.cjs");
const threads = [];
let threadError;

// Supply a browser transport only. All parsing, dispatch, error messages,
// project assembly and model validation are the production entry points.
class BrowserWorker {
  constructor(url) {
    const blob = url.startsWith("blob:") ? resolveObjectURL(url) : null;
    if (!blob) assert.equal(new URL(url).pathname, "/application/workers/import-worker.js");
    this.started = Promise.resolve(blob ? blob.text() : null).then(source => {
      const thread = new Worker(require.resolve("./browser-worker.cjs"), {workerData: source});
      thread.on("message", data => this.onmessage?.({data}));
      thread.on("error", err => { threadError = err; this.onerror?.(err); });
      return thread;
    });
    threads.push(this);
  }
  postMessage(msg, transfers) { this.started.then(w => w.postMessage(msg, transfers)); }
  terminate() { return this.started.then(w => w.terminate()); }
}
globalThis.Worker = BrowserWorker;
globalThis.location = {href: "file:///application/index.html"};
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const mod of ["model", "parts", "altium-ids", "source-file", "altium-rules", "pcb-pours", "sch-import", "pcb-import",
  "io", "obsolete-project", "translator-table", "translator-registry", "import-worker-client", "board-shape", "board-shape-sources", "sexpr", "import-kicad", "import-eagle", "import-easyeda", "library-import-kicad",
  "library-import-altium", "import-link", "rules", "design-reader", "zip", "kicad-models", "step-import"]) require(require("../support/app-source-paths.cjs").appFile(mod + ".js"));

function diagnostic(message) {
  assert.equal(typeof message, "string");
  assert.ok(message.trim());
  assert.doesNotMatch(message, /Cannot read propert|is not a function|is not defined|offset is outside|Maximum call stack|\n\s+at /i);
}
function cleanError(error) {
  assert.equal(error.constructor, Error, "the editor reports a normal import error");
  diagnostic(error.message);
}
function strings(list) {
  assert.ok(Array.isArray(list));
  for (const s of list) assert.equal(typeof s, "string");
}
function legacyStreams(bytes) {
  // The established reader has a compact native-buffer mode in Node. Compare
  // the importer's public map, including entry order, without duplicating
  // large streams as arrays of JS numbers in the test oracle.
  const c = CFB.read(bytes, {type: "buffer"}), root = c.FullPaths[0];
  const entries = c.FileIndex.flatMap((e, i) => e.type === 2 && e.content ?
    [[c.FullPaths[i].slice(root.length).toLowerCase(), e.content]] : []);
  return new Map(entries);
}
function checkStreams(bytes, expected) {
  const actual = AtriumIO.streams(new Uint8Array(bytes));
  assert.deepEqual([...actual.keys()], [...expected.keys()], "original compound directory order");
  for (const [name, content] of actual) assert.ok(expected.get(name).equals(content), name + " stream bytes");
}
const work = {check() {}, cancelled: false};
async function openDesign(input) {
  const files = input.map(f => new File([f.bytes], f.name));
  return AtriumDesignReader.read(files, work, () => {});
}
async function checkStep(text, good, mesh) {
  const r = mesh || await AtriumSTEPImport.load(text);
  strings(r.notes);
  assert.ok(Array.isArray(r.parts));
  if (r.error) {
    assert.ok(!good, r.error);
    diagnostic(r.error);
    assert.equal(r.parts.length, 0);
    assert.equal(r.bbox, null);
    return "rejected";
  }
  if (good) assert.ok(r.parts.length && r.stats.triangles > 0, "the fixture has a mesh");
  for (const part of r.parts) {
    assert.ok(part.positions.every(Number.isFinite) && part.normals.every(Number.isFinite));
    assert.ok(part.indices.every(i => i < part.positions.length / 3));
  }
  return "accepted";
}
async function stepReference(library, mode) {
  const model = library.find(d => d.footprint?.model3d)?.footprint.model3d;
  assert.ok(model, "a footprint preserves its model reference");
  let reads = 0;
  globalThis.AtriumHost = {
    chooseLibraryFolder: async () => ({name: "Models", grant: "fixture"}),
    libraryFolderRead: async (grant, paths) => {
      reads++;
      assert.equal(grant, "fixture");
      assert.equal(paths.length, 1);
      if (mode === "missing") return [{}];
      return [{data: bytes("mcad/tray.step").toString("base64")}];
    }
  };
  await AtriumKiCadModels.choose();
  const text = await AtriumKiCadModels.load(model.file);
  if (mode === "missing" || mode === "truncated") {
    assert.equal(text, null);
    assert.equal(reads, mode === "missing" ? 1 : 0);
    return "unresolved";
  }
  assert.equal(reads, 1);
  assert.match(model.file, /\.(?:step|stp)$/i);
  return checkStep(text, true);
}
async function design(input, format, mode, publicSource) {
  const good = mode === "original" || mode === "variation";
  let read;
  try { read = await openDesign(input); }
  catch (err) {
    cleanError(err);
    assert.equal(AtriumImport.mode, "worker", "a parse rejection leaves the worker available");
    assert.ok(!good, err.message);
    return "rejected";
  }
  assert.equal(AtriumImport.mode, "worker");
  const {model, files, report, provenance} = read;
  strings(report.notes);
  assert.ok(Array.isArray(model.library) && Array.isArray(model.documents));
  assert.deepEqual(provenance.files.map(f => f.name), files.map(f => f.name));
  for (const row of report.kinds) for (const n of ["kept","approximated","dropped"]) assert.ok(Number.isSafeInteger(row[n]) && row[n] >= 0);
  const current = Atrium.project("Current design", []);
  const before = JSON.stringify(current);
  try {
    const {after} = await AtriumDesignReader.assemble(read, current, current.documents[0].id, {into:false});
    await AtriumDesignReader.prepare(after, files, work, () => {});
  } catch (err) {
    cleanError(err);
    assert.ok(!good, err.message);
    return "rejected";
  } finally {
    assert.equal(JSON.stringify(current), before, "reading leaves the open project untouched");
  }
  const library = model.library;
  if (format === "step-reference") return stepReference(library, mode);
  if (good) {
    const docs = model.documents;
    if (publicSource) {
      const expected = {schdoc: "schematic", pcbdoc: "pcb", schlib: "symbol", pcblib: "footprint"}[publicSource.suffix];
      assert.ok(docs.some(d => d.kind === expected) || library.some(d => d[expected]), "the selected document or library was read");
    } else if (format === "altium-schlib" || format === "kicad-symbol") assert.ok(library.some(d => d.symbol?.pins.length));
    else if (format === "altium-pcblib" || format === "kicad-footprint") assert.ok(library.some(d => d.footprint?.pads.length));
    else assert.ok(docs.some(d => d.items.length), "the fixture imported editable objects");
  }
  return "accepted";
}
async function run({format, mode, seed, round, source}, maxInput) {
  if (format === "ipc2581") {
    for (const mod of ["spatial", "pcb-appearance", "vectorize", "pcb-text-rich", "pcb-text", "stackup", "viastack",
      "rigid-flex", "polygon-pour", "bom", "fab-outputs", "ipc2581"]) require(require("../support/app-source-paths.cjs").appFile(mod + ".js"));
  }
  let files;
  if (source) {
    const fs = require("node:fs");
    assert.equal(fs.statSync(source.path).size, source.size);
    assert.ok(source.size <= maxInput);
    const data = fs.readFileSync(source.path);
    assert.equal(require("node:crypto").createHash("sha256").update(data).digest("hex"), source.sha256);
    files = [{name: source.name, bytes: data}];
  } else files = build(format, mode, seed, round);
  for (const f of files) assert.ok(f.bytes.length <= maxInput, "bounded local case");
  const before = snapshot(), good = mode === "original" || mode === "variation";
  try {
    if (format.startsWith("altium-") && mode === "original") {
      for (const f of files.filter(f => /\.(schdoc|pcbdoc|schlib|pcblib)$/i.test(f.name))) {
        const expected = legacyStreams(f.bytes);
        checkStreams(f.bytes, expected);
        // This generated library ends in sector padding. Match real writers
        // which omit it, while retaining every meaningful stream byte.
        if (!source && format === "altium-schlib") checkStreams(f.bytes.subarray(0, -1), expected);
      }
    }
    if (["odb", "ipc2581", "gerber", "excellon"].includes(format)) {
      await assert.rejects(openDesign(files), err => { cleanError(err); return /has no import translator|Unrecognised input|not supported/.test(err.message); });
      if (format === "odb") return "unsupported";
      const text = files[0].bytes.toString();
      if (format === "ipc2581") {
        const result = AtriumIPC2581.check(text);
        strings(result.errors); strings(result.warnings);
        assert.equal(result.ok, result.errors.length === 0);
        if (good) assert.ok(result.ok && result.counts.components > 0, result.errors.join("\n"));
        if (mode === "missing") assert.ok(!result.ok);
        return result.ok ? "accepted" : "rejected";
      }
      const result = format === "gerber" ? cam.parseGerber(text) : cam.parseExcellon(text);
      strings(result.warnings);
      if (format === "gerber") {
        if (good) assert.ok(result.flashCount && result.drawCount);
        if (result.shapes.length) assert.ok(result.bbox.every(Number.isFinite));
      } else {
        if (good) assert.ok(result.hits.length > 0);
        for (const hit of result.hits) assert.ok([hit.x, hit.y, hit.d].every(Number.isFinite));
      }
      return "accepted";
    }
    if (format === "step") {
      let read;
      try { read = await openDesign(files); }
      catch (err) { cleanError(err); assert.ok(!good, err.message); return "rejected"; }
      assert.equal(read.report.translator, "step");
      assert.equal(read.model.documents.length, 0);
      assert.deepEqual(read.provenance.files.map(f => f.name), files.map(f => f.name));
      return await checkStep(null, good, read.provenance.mechanical.mesh);
    }
    return await design(files, format, mode, source);
  } finally {
    await Promise.all(threads.map(w => w.terminate()));
    if (threadError) throw threadError;
    unchanged(before);
  }
}
module.exports = {run};
