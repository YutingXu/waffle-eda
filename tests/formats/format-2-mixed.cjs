"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const name of ["model","source-file","sexpr","revisions","zip","vendor/zipjs-deflate",
  "format-2-codec","format-2-units","format-2-values","format-2-model","format-2-models","format-2-closure",
  "folder-project-engine","import-sidecars","obsolete-project","project-archive","step-import"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const F = AtriumFormat2, M = AtriumFormat2Model, Z = AtriumProjectArchive, I = AtriumImportSidecars;
const fixture = path.join(__dirname, "../fixtures/format-2/instrument"), manifest = "Instrument.waffle";
const version = "6079a174015d0392a30cfb55e0dbb8d6f17e33eab740ba5850c5857998febf87";
const read = name => new Uint8Array(fs.readFileSync(path.join(fixture,name)));
const record = name => ({path:name, bytes:read(name), sha256:F.sha256(read(name))});
const utf8 = new TextDecoder("utf-8",{fatal:true});

async function main() {
  const root = M.parse(read(manifest)), engine = AtriumFolderProjectEngine.create();
  const project = await engine.run({op:"manifest",record:record(manifest)});
  const sheet = project.members.find(r => r.kind === "schematic"), board = project.members.find(r => r.kind === "pcb");
  const scoped = ref => engine.run({op:"owner",record:record(ref.path),ref});
  const schematic = await scoped(sheet), pcb = await scoped(board);
  assert.equal(project.entry, sheet.id);
  assert.deepEqual((await engine.run({op:"plan",changes:[],attachments:[]})).plan, []);
  const image = schematic.owner.items.find(i => i.id === "inspection").asset;
  assert.equal(image.byteLength,82);
  assert.equal(F.sha256(read(M.assetPath(image))),image.sha256);
  const [original,alias,missing] = pcb.owner.bodyModels;
  assert.deepEqual(alias.model,original.model);
  assert.equal(missing.file,"optional-cover.step");
  assert.equal(Object.hasOwn(missing,"model"),false);
  const raw = AtriumFormat2Models.decode(read(M.modelPath(original.model)),original.model);
  assert.deepEqual(Array.from(raw), Array.from(fs.readFileSync(path.join(__dirname,"../fixtures/mcad/tray.step"))));
  const mesh = AtriumSTEPImport.tessellate(utf8.decode(raw));
  assert.ok(mesh.parts.reduce((n,part) => n+part.indices.length,0)>0);
  const [{snapshot, value:release}] = M.manifest(root).releases;
  assert.equal(release.letter,"A"); assert.equal(project.project.revision.letter,"B");
  const frozen = M.snapshot(M.parse(read(M.assetPath(snapshot))));
  const archived = kind => M.parse(read(frozen.members.find(m => m.fileKind === kind).path));
  const frozenPcb = M.document(archived("pcb"));
  assert.equal(frozenPcb.items.find(i => i.kind === "part").value,"Meter");
  assert.equal(pcb.owner.items.find(i => i.kind === "part").value,"Calibrated");
  const library = project.members.find(r => r.kind === "library");
  assert.equal(M.library(archived("library")).footprint.pads[0].w,1);
  assert.equal((await scoped(library)).owner.footprint.pads[0].w,1.25);
  assert.deepEqual(frozenPcb.bodyModels,pcb.owner.bodyModels);
  assert.deepEqual(M.document(archived("schematic")).items.find(i => i.id === "inspection").asset,image);

  const ref = project.members.find(r => r.kind === "import-index");
  const binding = I.parse(read(ref.path),ref), [proof] = I.exportProvenance(I.restore(binding)).precision.rows;
  const saved = M.parse(read(board.path)).get(proof.id);
  const key = {owner:board.id,id:saved.id,recordKind:saved.kind,property:"/angle",unit:"nanodeg",value:saved.angle};
  assert.deepEqual(M.restoreResidual(key,proof),{unit:"nanodeg",numerator:"60617283947",denominator:"5"});
  assert.equal(M.restoreResidual({...key,value:saved.angle+1},proof),null);
  const [input] = binding.inputs;
  assert.ok(utf8.decode(await I.verified(read(I.logical(input.sha256)),input)).includes("12.1234567894"));

  const closure = await Z.verifyClosure({manifestPath:manifest,read});
  assert.equal(closure.version,version); assert.equal(closure.members.length,12);
  const archive = await Z.archive({...closure,read}), zip = Z.zipDirectory(archive.bytes), [entry] = await zip.projects();
  const unpacked = await Z.extract(zip,entry,Z.verifyClosure);
  assert.equal(unpacked.version,version);
  const names = [manifest,I.IGNORE,...closure.members.map(m => m.path)].sort();
  assert.deepEqual([...unpacked.files.keys()].sort(),names);
  for (const name of names) assert.equal(F.sha256(unpacked.files.get(name)),F.sha256(read(name)),name);
  console.log("format-2-mixed: 14 exact ZIP members, original image and STEP, two aliases, frozen A and verified source precision");
}
globalThis.__testDone = main().catch(error => {console.error(error); process.exitCode=1;});
