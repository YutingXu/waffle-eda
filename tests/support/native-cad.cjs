"use strict";
const fs = require("node:fs"), path = require("node:path");
for (const name of ["model", "source-file", "format-2-codec", "format-2-units", "format-2-values", "format-2-model"]) {
  require(require("./app-source-paths.cjs").appFile(name + ".js"));
}
const F = AtriumFormat2, M = AtriumFormat2Model;

function projectFromRecords(manifest, read, options = {}) {
  const {project, members} = M.manifest(manifest);
  for (const member of members) {
    const record = M.parse(read(member.path));
    if (member.kind === "library") project.library.push(M.library(record, options));
    else if (member.kind === "block") (project.layoutBlocks ||= []).push(M.block(record));
    else if (Object.hasOwn(F.documentSuffix, member.kind)) project.documents.push(M.document(record, {...options, name: member.name}));
    else throw Error("Unexpected CAD fixture member " + member.kind);
  }
  globalThis.AtriumSignals?.attach(project); // The normal editor attaches board-to-project rule lookup after loading.
  return project;
}
function storedProject(read) {
  const modelText = ref => {
    for (const name of ["sexpr", "zip", "vendor/zipjs-deflate", "format-2-models"]) require(require("./app-source-paths.cjs").appFile(name + ".js"));
    return new TextDecoder().decode(AtriumFormat2Models.decode(read(M.modelPath(ref)), ref));
  };
  return {nativeAssets:true, modelText};
}
function nativeRecords(name) {
  const directory = path.join(__dirname, "..", "fixtures", "cad-native", name);
  const read = file => new Uint8Array(fs.readFileSync(path.join(directory, file)));
  return {read, manifest:M.parse(read("Project.waffle"))};
}
function encodeEditor(input) {
  for(const name of ["sexpr","zip","vendor/zipjs-deflate","format-2-models"]) require(require("./app-source-paths.cjs").appFile(name+".js"));
  const project=input.model ?? input;
  if(!globalThis.AtriumPolygonPour && project.documents.some(d=>d.pcbDrawing?.sourceFill || d.pcbDrawing?.pourSignatures)) {
    require("../../app/translator-worker-modules.js");
    for(const file of AtriumTranslatorWorkerModules["polygon-pour"]) require(require("./app-source-paths.cjs").appFile(file));
  }
  return M.fromEditor(input);
}
function nativeRoundTrip(project, revision, readRetained) {
  return storedRoundTrip(encodeEditor(project),revision,readRetained);
}
function storedRoundTrip(storage,revision,readRetained) {
  const files = new Map(storage.files.map(row => [row.path, F.serialize(row.file)]));
  for (const asset of [...storage.models, ...storage.assets]) files.set(asset.path, asset.bytes);
  const read = file => files.get(file) ?? readRetained?.(file);
  return readDesign(M.parse(read(storage.manifestPath)), read, revision);
}
function readDesign(root, read, revision) {
  if (!revision) return projectFromRecords(root, read, storedProject(read));
  const release = M.manifest(root).releases.find(r => r.value.notes === revision || r.value.letter === revision);
  if (!release) throw Error("No such CAD test revision: " + revision);
  const readVerified = ref => {
    const bytes = read(ref.path || M.assetPath(ref));
    if (bytes.length !== ref.byteLength || F.sha256(bytes) !== ref.sha256) throw Error("Invalid frozen CAD fixture member.");
    return bytes;
  };
  const archived = M.snapshot(M.parse(readVerified(release.snapshot)));
  const members = new Map(archived.members.map(r => [r.logicalPath, r]));
  return projectFromRecords(M.parse(readVerified(archived.root)), file => readVerified(members.get(file)), storedProject(read));
}
function nativeCAD(name, revision) {
  const {read,manifest} = nativeRecords(name);
  const project = readDesign(manifest,read,revision);
  if (name === "design-diff" && revision) delete project.revision; // Fixture labels are outside the comparison.
  return project;
}
function nativeImported(project, originals, priorProvenance) {
  for(const module of ["sexpr","zip","vendor/zipjs-deflate","format-2-models","translator-provenance","import-sidecars"]) require(require("./app-source-paths.cjs").appFile(module+".js"));
  const documents=project.documents.map(d=>d.id), names=project.documents.map(d=>d.name);
  const provenance={version:1,...priorProvenance,files:originals.map(f=>({...f,sha256:F.sha256(f.bytes)}))};
  const model=priorProvenance ? project : AtriumTranslatorProvenance.separate(Atrium.clone(project),provenance);
  const storage=encodeEditor({model,provenance});
  const retained=AtriumImportSidecars.prepareSync([{scopeId:"fixture-source",documents,names,
    report:{translator:"altium",kinds:["source"]},provenance,residuals:storage.residuals}]);
  const ref=retained.refs[0], index=AtriumImportSidecars.parse(retained.files.get(ref.path),ref);
  return {project:storedRoundTrip(storage),provenance:AtriumImportSidecars.exportProvenance(AtriumImportSidecars.restore(index))};
}
function nativeImportRoundTrip(project,originals,priorProvenance) {
  const saved=nativeImported(project,originals,priorProvenance);
  return AtriumTranslatorProvenance.toLegacy(saved.project,saved.provenance);
}
function* nativeCADCases() {
  for(const name of ["sample-sensor","signal-board","eco-benchmark","design-diff","families","calculation",
    "frame-channel-hyphen","frame-channel-underscore","imported-captions","infinite-canvas","source-geometry","source-metadata"]) {
    yield [name,nativeCAD(name)];
  }
  for(const release of M.manifest(nativeRecords("design-diff").manifest).releases) {
    const label=release.value.notes;
    yield ["design-diff/"+label,nativeCAD("design-diff",label)];
  }
}
module.exports = {nativeCAD, nativeRecords, nativeRoundTrip, projectFromRecords, nativeCADCases, nativeImported, nativeImportRoundTrip};
