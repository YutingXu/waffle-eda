"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
for (const module of ["source-file", "format-2-codec", "format-2-units", "format-2-values", "format-2-model", "folder-project-engine"])
  require(require("../support/app-source-paths.cjs").appFile(module + ".js"));
const F = AtriumFormat2, M = AtriumFormat2Model, Engine = AtriumFolderProjectEngine;
const root = "Forward.waffle", sheet = "Sensor.wsch", library = "libraries/Probe.wlib";
const paths = [root, sheet, library];
const fixtures = new Map(paths.map(file => [file, fs.readFileSync(path.join(__dirname, "../fixtures/format-2/forward-bytes", file), "utf8")]));
const enc = new TextEncoder(), dec = new TextDecoder();
const record = (file, source) => ({path:file, bytes:enc.encode(source), sha256:F.sha256(enc.encode(source))});
const bytes = file => dec.decode(F.serialize(file));
const lines = source => source.split("\n");
const knownGeometryError = error => error?.code === "invalid-format" && /exact safe integer/.test(error.message);

async function exercise() {
  const storage = new Map(fixtures), engine = Engine.create(), refs = new Map();
  const open = async (session, name = root) => {
    const manifest = await session.run({op:"manifest", record:record(name, storage.get(name))});
    const owners = new Map();
    for (const ref of manifest.members) {
      refs.set(ref.path, ref);
      const result = await session.run({op:"owner", ref, record:record(ref.path, storage.get(ref.path))});
      owners.set(ref.path, result.owner);
    }
    return {project:manifest.project, owners};
  };
  const original = await open(engine);
  assert.equal(original.project.atriumCompat, undefined);
  assert.deepEqual((await engine.run({op:"plan", changes:[], attachments:[], manifest:original.project})).plan, []);
  for (const [name, source] of storage) assert.equal(bytes(M.parse(enc.encode(source))), source, name + " has no open-time rewrite");

  const before = original.owners.get(sheet), [sense] = before.items, lib = original.owners.get(library);
  assert.equal(before.items.length, 1, "the unknown sampler has no editor object");
  assert.equal(M.parse(storage.get(sheet)).isOpaque(JSON.parse(lines(storage.get(sheet))[3]).id), true);
  assert.deepEqual(M.dependencies(M.parse(storage.get(sheet))), [], "an unknown path does not become a file read");
  assert.equal(sense.text, "SENSE");
  assert.equal(sense.futureMeter.range, undefined, "the editor has no rounded or unbounded approximation");
  assert.equal(lib.symbol.pins[0].x, 1);
  assert.throws(() => M.parse(storage.get(sheet).replace("[1000000,2000000]", "[1e6,2000000]")), knownGeometryError);
  assert.throws(() => M.parse(storage.get(sheet).replace('"step":1.20', '"step":1.20,"\\u0073tep":1.20')),
    /duplicate key/);

  async function apply(changes, manifest) {
    const packet = await engine.run({op:"plan", changes, attachments:[], ...(manifest ? {manifest} : {})});
    const hashes = {};
    for (const target of packet.plan) {
      const old = record(target.path, storage.get(target.path));
      assert.equal(target.expected, old.sha256);
      assert.ok(target.splice, "editing an existing owner has a scoped byte splice");
      let start = 0, result = "";
      for (const edit of target.splice.edits) {
        result += dec.decode(old.bytes.subarray(start, edit.offset)) + edit.insert;
        start = edit.offset + edit.remove;
      }
      storage.set(target.path, result + dec.decode(old.bytes.subarray(start)));
      hashes[target.path] = record(target.path, storage.get(target.path)).sha256;
    }
    assert.equal(await engine.run({op:"accepted", token:packet.token, hashes}), true);
    return packet;
  }
  const sheetChange = put => ({id:refs.get(sheet).id, kind:"schematic", put, remove:[]});
  await assert.rejects(engine.run({op:"plan", changes:[sheetChange([{...sense, "x-sensor":{w:5}}])], attachments:[]}), /extension value requires/);
  await assert.rejects(engine.run({op:"plan", changes:[{...sheetChange([]),remove:[JSON.parse(lines(storage.get(sheet))[3]).id]}], attachments:[]}),
    error => error?.code === "read-only-format");
  const next = {...sense, text:"CALIBRATED"};
  const change = await apply([sheetChange([next])]);
  assert.deepEqual(change.plan.map(target => target.path), [sheet]);
  assert.equal(change.metrics.rowsEncoded, 1);
  assert.equal(change.metrics.unrelatedVisits, 0);
  assert.equal(storage.get(sheet), fixtures.get(sheet).replace('"text":"SENSE"', '"text":"CALIBRATED"'));
  assert.deepEqual((await open(Engine.create())).owners.get(sheet).items.map(item => item.text), ["CALIBRATED"]);

  // Apply and commit the inverse the same way an editor Undo saves.
  await apply([sheetChange([sense])]);
  assert.equal(storage.get(sheet), fixtures.get(sheet), "the inverse restores the independently authored owner");
  const settings = {...before, grid:2.54, sheet:{...before.sheet,size:"A3"}};
  delete settings.items;
  await apply([{...sheetChange([]), settings}]);
  assert.equal(storage.get(sheet), fixtures.get(sheet).replace('"size":"A4"', '"size":"A3"').replace('"grid":1270000', '"grid":2540000'));

  const draft = structuredClone(lib);
  draft.symbol.pins[0].x = 2;
  await apply([{id:refs.get(library).id,kind:"library",owner:draft,put:[],remove:[]}],
    {...original.project,parameters:{Sensor:"PT1000"}});
  assert.equal(storage.get(library), fixtures.get(library).replace('"x":1000000', '"x":2000000'));
  assert.equal(storage.get(root), fixtures.get(root).replace('"Sensor":"PT100"', '"Sensor":"PT1000"'));
  const copied = await engine.run({op:"copy", original:root, manifest:"Reopened.waffle",
    files:[...storage].map(([name, source]) => record(name, source)), plan:[]});
  for (const target of copied) {
    const sourceName = target.path === "Reopened.waffle" ? root : target.path;
    assert.equal(dec.decode(Engine.bytesOf(target)), storage.get(sourceName), sourceName + " is carried into the new folder");
  }
  storage.set("Reopened.waffle", storage.get(root));
  const reopened = await open(Engine.create(), "Reopened.waffle");
  assert.deepEqual(reopened.project.parameters, {Sensor:"PT1000"});
  assert.equal(reopened.owners.get(library).symbol.pins[0].x, 2);
  console.log("format-2-forward-bytes: physical manifest, sheet and library preserve opaque UTF-8 on scoped edit, inverse and re-open");
}
globalThis.__testDone = exercise().catch(error => { console.error(error); process.exitCode = 1; });
