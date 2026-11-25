"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), os = require("node:os"), path = require("node:path");
globalThis.CFB = require("../../app/vendor/cfb.min.js");
for (const name of ["obsolete-project","model","sch-objects","hierarchy","board-shape","board-shape-sources","stackup",
  "net-intent","signals","altium-rules","pcb-draw","component-classes","query","rules","project-rules","pcb-pours",
  "pcb-appearance","viastack","spatial","polygon-pour","pdf-fonts","altium-typefaces","altium-ids","source-file",
  "sch-import","pcb-import","library-import-altium","sexpr","import-kicad","import-eagle","sch-appearance","import-link",
  "io","import-rules","translator-table","translator-registry","translator-provenance","translator-adapters","translators",
  "format-2-codec","format-2-units","format-2-values","zip","vendor/zipjs-deflate","format-2-models","format-2-model","import-sidecars"])
  require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const F = AtriumFormat2, M = AtriumFormat2Model, S = AtriumImportSidecars, P = AtriumProjectRules;
const names = ["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"];
const fixture = path.join(__dirname,"../fixtures/altium/pidp11-io-expander");
const originals = names.map(name => ({name,bytes:new Uint8Array(fs.readFileSync(path.join(fixture,name)))}));
const imported = AtriumTranslators.import(originals,{source_rules:"use"});
const physical = M.fromEditor(imported,{projectId:"pidp-native-scopes"});
const refs = S.prepareSync([{scopeId:"public-pidp",names,documents:imported.model.documents.map(d=>d.id),
  report:imported.report,provenance:imported.provenance,residuals:physical.residuals}]);
const raw = group => group.fields.find(f => f.values?.sourceRules)?.values.sourceRules;
const originalLines = raw(imported.provenance);
assert.equal(originalLines.length,41);
const originalSides = originalLines.flatMap(line => {
  const row = AtriumAltiumRules.describe(line);
  return [row.first,row.second].map(side => AtriumQueryExchange.fromAltium(side));
});
assert.equal(originalSides.filter(s=>s.ok).length,79);
const actualScopes = p => p.rules.list.map(r=>[r.id,r.scope,r.scope2]);
const root = fs.mkdtempSync(path.join(os.tmpdir(),"waffle-native-pidp-scopes-"));
function write(file, bytes) {
  const target = path.join(root,file);
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,bytes);
}
const read = file => new Uint8Array(fs.readFileSync(path.join(root,file)));
const opened = () => {
  const file = M.parse(read(physical.manifestPath)), {project,members} = M.manifest(file);
  for (const ref of members) {
    if (ref.kind === "library") project.library.push(M.library(M.parse(read(ref.path))));
    else if (Object.hasOwn(F.documentSuffix,ref.kind)) project.documents.push(M.document(M.parse(read(ref.path)),{name:ref.name}));
  }
  return {file,project,board:project.documents.find(d=>d.kind==="pcb")};
};
const selected = (p,doc,scope) => {
  const match = AtriumQuery.run(p,doc,scope.source);
  return [...match.ids,...match.subs.map(sub=>sub.id)].sort();
};
const board = imported.model.documents.find(d=>d.kind==="pcb");
try {
  for (const {path:member,file} of physical.files) write(member,F.serialize(file));
  for (const member of [...physical.assets,...physical.models]) write(member.path,member.bytes);
  for (const [member,bytes] of refs.files) write(member,bytes);
  write(physical.manifestPath,F.serialize(F.edit(physical.manifest,{put:refs.refs})));
  const old = opened(), ref = refs.refs[0], retained = S.parse(read(ref.path),ref), oldIndex = read(ref.path);
  assert.deepEqual(raw(S.restore(retained).provenance),originalLines);
  for (const source of retained.inputs) assert.deepEqual(read(S.logical(source.sha256)),originals.find(f=>f.name===source.name).bytes);
  assert.equal(old.project.rules.list.length,61);
  assert.deepEqual(actualScopes(old.project),actualScopes(imported.model));
  const sources = new Map();
  for (const [,first,second] of actualScopes(old.project)) for (const scope of [first,second].filter(Boolean)) {
    assert.equal(AtriumDesignQueryRecord.valid(scope),true);
    if (!sources.has(scope.source)) sources.set(scope.source,scope);
  }
  for (const scope of sources.values()) {
    const compiled = AtriumDesignQuery.compile(scope,AtriumDesignQuery.context(old.project,old.board));
    assert.equal(compiled.ok,true,JSON.stringify(compiled.diagnostics));
    assert.deepEqual(selected(old.project,old.board,scope),selected(imported.model,board,scope),scope.source);
  }
  const active = AtriumRules.normalize(P.forBoard(old.project,old.board));
  const two = active.list.find(r=>r.type==="clearance");
  two.scope = AtriumDesignQueryRecord.create('object in class "1A"');
  two.scope2 = AtriumDesignQueryRecord.create("via");
  assert.equal(selected(old.project,old.board,two.scope).length,41);
  assert.equal(selected(old.project,old.board,two.scope2).length,59);
  P.store(old.project,old.board,active);
  const references = [...old.file.records()].filter(r=>["document","library","layoutBlock","importIndex"].includes(r.kind));
  const changed = M.createManifest(old.project,{id:old.file.header.id,entryDocument:old.file.header.entryDocument,references,previous:old.file});
  const row = old.file.get(two.id);
  const expected = F.edit(old.file,{put:[{...row,value:{...row.value,scope:two.scope,scope2:two.scope2}}]});
  assert.deepEqual(F.serialize(changed),F.serialize(expected),"both changed sides belong to one existing rule row");
  write(physical.manifestPath,F.serialize(changed));
  const after = opened(), saved = after.project.rules.list.find(r=>r.id===two.id);
  assert.deepEqual([saved.scope,saved.scope2],[two.scope,two.scope2]);
  assert.deepEqual([selected(after.project,after.board,saved.scope).length,selected(after.project,after.board,saved.scope2).length],[41,59]);
  assert.deepEqual(read(ref.path),oldIndex);
  assert.deepEqual(raw(S.restore(S.parse(read(ref.path),ref)).provenance),originalLines);
  console.log("PiDP native disk reopen preserved 61 rule records and all 41 Altium source rows. A two-sided edit changed one physical row and reopened with 41 class members and 59 vias.");
} finally { fs.rmSync(root,{recursive:true,force:true}); }
