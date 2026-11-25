"use strict";
// Save an imported editor model and its retained original through the same typed
// records, gzip model store and checked import index used by a Waffle folder.
require("./native-cad.cjs");
for (const name of ["sexpr","zip","vendor/zipjs-deflate","format-2-models","signals","translator-provenance","import-sidecars"]) {
  require(require("./app-source-paths.cjs").appFile(name + ".js"));
}
require("../../app/translator-worker-modules.js");
for (const file of AtriumTranslatorWorkerModules["polygon-pour"]) require(require("./app-source-paths.cjs").appFile(file));
const M = AtriumFormat2Model, F = AtriumFormat2, P = AtriumTranslatorProvenance, S = AtriumImportSidecars;

const modelStores = new WeakMap();
function reopenAltium(project, original, previous, {loadModels=true}={}) {
  const editor = project.model || project;
  const documents = editor.documents.map(d => d.id), library = editor.library.map(d => d.id);
  const input = {name:original.name, bytes:original.bytes, sha256:AtriumSourceFile.sha256(original.bytes), documents, library};
  const provenance = project.provenance || {version:1, files:[input]};
  const model = project.model || P.separate(structuredClone(project), provenance);
  const imported = {model, provenance};
  const native = M.fromEditor(imported);
  const entry = previous || {scopeId:"altium-fixture", documents, names:provenance.files.map(f=>f.name), adopted:true,
    report:project.report || {translator:"altium",version:1,kinds:[]}, provenance, residuals:native.residuals};
  const index = S.prepareSync([entry]);
  const root = F.edit(native.manifest,{put:index.refs});
  const manifest = M.parse(F.serialize(root));
  const ref = [...manifest.records()].find(row=>row.kind === "importIndex");
  const restored = S.restore(S.parse(index.files.get(ref.path),ref));
  const retained = S.exportProvenance(restored);
  const files = new Map(native.files.map(row=>[row.path,F.serialize(row.file)]));
  const models = new Map(modelStores.get(entry));
  for (const row of native.models) models.set(row.path,row.bytes);
  modelStores.set(entry,models);
  let modelReads = 0;
  const modelText = ref => {
    modelReads++;
    return new TextDecoder().decode(AtriumFormat2Models.decode(models.get(M.modelPath(ref)),ref));
  };
  function readDesign(withModels) {
    const {project:design,members} = M.manifest(manifest);
    const options = {nativeAssets:true,...(withModels ? {modelText} : {})};
    for (const ref of members) {
      if (ref.kind === "import-index") continue;
      const file = M.parse(files.get(ref.path),{kind:ref.kind,id:ref.id});
      F.checkMemberVersion(manifest,file,ref);
      if (ref.kind === "library") design.library.push(M.library(file,options));
      else design.documents.push(M.document(file,{...options,name:ref.name}));
    }
    return design;
  }
  const design=readDesign(loadModels);
  return {model:design,project:P.toLegacy(design,retained),retained,entry,models,files,
    get modelReads(){return modelReads;},withModels:()=>P.toLegacy(readDesign(true),retained)};
}
module.exports = {reopenAltium};
