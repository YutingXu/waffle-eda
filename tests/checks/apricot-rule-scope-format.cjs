"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
for (const name of ["source-file", "format-2-codec", "format-2-units", "format-2-values", "design-query-record",
  "format-2-model", "format-2-closure", "folder-project-engine"]) require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const {checkSchema} = require("../../integrations/vscode/lib/validate.js");
const root = path.join(__dirname, "../.."), F = AtriumFormat2, M = AtriumFormat2Model, Q = AtriumDesignQueryRecord;
const json = file => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const ledger = json("tests/fixtures/format-2/apricot-rule-scope-freeze.json");
const schema = json("integrations/vscode/schema/waffle-folder-record.schema.json");
const invalid = e => e?.code === "invalid-rule-scope";
const read = file => new Uint8Array(fs.readFileSync(file));
const text = bytes => new TextDecoder().decode(bytes);
const classic = scope => {
  const {languageVersion,source,...annotations} = scope;
  assert.equal(languageVersion, 1);
  if (source === "object") return {kind:"all", ...annotations};
  assert.equal(source, 'object in class "DDR_BYTE0"');
  return {kind:"netclass", value:"DDR_BYTE0", ...annotations};
};

async function checkHistoricalRoots() {
  let ruleCount = 0, scopeCount = 0;
  for (const [name, receipt] of Object.entries(ledger.files)) {
    const file = path.join(root,name), bytes = read(file), manifest = M.parse(bytes);
    const load = name => read(path.join(path.dirname(file),name));
    assert.equal(F.sha256(bytes), receipt.afterManifest, name);
    assert.equal((await AtriumFormat2Closure.verify(manifest, load)).sha256, receipt.afterClosure);
    M.manifest(manifest);
    const put = [];
    let count = 0;
    for (const row of manifest.records()) if (row.kind === "rule") {
      const value = {...row.value};
      for (const key of ["scope","scope2"]) if (value[key]) {value[key] = classic(value[key]); count++;}
      put.push({...row,value});
    }
    assert.equal(put.length, receipt.rules);
    assert.equal(count, receipt.scopes);
    const old = F.applyDelta(manifest,{put}).file;
    assert.equal(F.sha256(F.serialize(old)), receipt.beforeManifest);
    assert.equal((await AtriumFormat2Closure.verify(old,load)).sha256, receipt.beforeClosure);
    assert.throws(() => M.manifest(old), invalid);
    ruleCount += put.length; scopeCount += count;
  }
  assert.equal(ruleCount,100);
  assert.equal(scopeCount,108);
}

async function checkAuthoredRecord() {
  const full = path.join(root,"tests/fixtures/format-2/workshop/Reference.waffle");
  const original = M.parse(read(full)), originalRule = original.get("clear");
  const source = 'pad near "U🌿" within 2 mm', start = source.indexOf('"'), end = source.indexOf('"',start+1)+1;
  const bindings = [{id:"occurrence-A",name:"U🌿",span:[start,end],target:{scope:"item",docId:"board",itemId:"probe",instanceId:"active"}}];
  const rule = {...originalRule.value, scope:Q.create(source,bindings), scope2:Q.selector("net",'GND "A"')};
  const row = {...originalRule,value:rule};
  assert.deepEqual(checkSchema(row,schema),[]);
  const file = F.applyDelta(original,{put:[row]}).file, p = M.manifest(file).project;
  assert.deepEqual(p.rules.list[0].scope, rule.scope);
  assert.deepEqual(p.rules.list[0].scope2, rule.scope2);
  assert.equal(p.rules.list[0].gap, .2);
  const references = [...original.records()].filter(r => ["document","library","layoutBlock","importIndex"].includes(r.kind));
  const native = M.createManifest(p, {references, previous:file});
  assert.deepEqual(native.get("clear").value,rule);
  assert.equal(native.header.formatVersion,"2.0");
  assert.equal(native.header.requires,undefined);
  assert.equal(globalThis.AtriumDesignQuery,undefined);
  for (const scope of [{kind:"all"}, {kind:"query",value:"IsPad"}, {languageVersion:1,source:"legacy.caseFold = true"},
    {languageVersion:1,source:"waffle-filter/1"}, {languageVersion:1,source,bindings:[{...bindings[0],span:[1,source.length+1]}]}]) {
    const bad = {...rule,scope};
    assert.throws(() => M.manifest(F.applyDelta(file,{put:[{...row,value:bad}]}).file),invalid);
    assert.throws(() => M.createManifest({...p,rules:{...p.rules,list:[bad]}}),invalid);
    assert.throws(() => M.createManifest({...p,ruleSets:{version:1,sets:[{name:"Imported",rules:{list:[bad]}}]}}),invalid);
  }
  for (const value of [{...rule,scope2:undefined}, {...rule,type:"width"}]) {
    const bad = JSON.parse(JSON.stringify({...row,value}));
    assert.ok(checkSchema(bad,schema).length);
    assert.throws(() => M.manifest(F.applyDelta(file,{put:[bad]}).file),invalid);
  }
  const unknown = {languageVersion:3,source:"future test",opaque:{width:17,$number:"exact text"}};
  const futureRow = {...row,value:{...rule,scope:unknown}};
  const withFuture = F.applyDelta(original,{put:[futureRow]}).file;
  const carried = M.manifest(withFuture).project;
  assert.deepEqual(carried.rules.list[0].scope, unknown);
  assert.deepEqual(M.createManifest(carried,{previous:withFuture}).get("clear").value.scope,unknown);
  assert.throws(() => M.createManifest(carried),invalid);
  assert.throws(() => M.createManifest({...carried,rules:{...carried.rules,list:[{...carried.rules.list[0],scope:{...unknown,source:"edited"}}]}},{previous:withFuture}),invalid);
  const e = AtriumFolderProjectEngine.create(), bytes = F.serialize(original);
  const attachment = await e.run({op:"manifest",record:{path:"Reference.waffle",bytes,sha256:F.sha256(bytes)}});
  const copy = attachment.project;
  copy.rules.list[0].scope = Q.copy(rule.scope);
  const {plan} = await e.run({op:"plan",manifest:copy,changes:[],attachments:[]});
  assert.deepEqual(plan.map(t => t.path),["Reference.waffle"]);
  assert.equal(plan[0].splice.edits.length,1);
  const splice = plan[0].splice.edits[0], editedRow = {...originalRule,value:{...originalRule.value,scope:rule.scope}};
  assert.equal(text(bytes.slice(splice.offset,splice.offset + splice.remove)),F.canonical(originalRule)+"\n");
  assert.equal(splice.insert,F.canonical(editedRow)+"\n");
  assert.equal(await e.run({op:"validateMerged",path:"Reference.waffle",text:text(F.serialize(file))}),true);
  const invalidMerge = F.applyDelta(file,{put:[{...row,value:{...rule,scope2:{kind:"all"}}}]}).file;
  await assert.rejects(() => e.run({op:"validateMerged",path:"Reference.waffle",text:text(F.serialize(invalidMerge))}),invalid);
}

function checkParameterBinding() {
  require("../../app/checks/design-query.js");
  const dir = path.join(root,"tests/fixtures/format-2/query-parameter");
  const file = M.parse(read(path.join(dir,"Parameters.waffle"))), row = file.get("minimum");
  const {project,members} = M.manifest(file), ref = members.find(r => r.kind==="pcb");
  const board = M.document(M.parse(read(path.join(dir,ref.path))),{name:ref.name});
  project.documents = [board];
  const scope = project.rules.list[0].scope, binding = scope.bindings[0];
  assert.deepEqual(binding,{id:"read-min",name:"project.MinTrace",span:[20,36],
    target:{scope:"project",parameterId:"p-min",field:"mintrace"}});
  assert.deepEqual(checkSchema(row,schema),[]);
  for (const parameterId of ["",7]) {
    const invalid = {...scope,bindings:[{...binding,target:{...binding.target,parameterId}}]};
    assert.equal(Q.valid(invalid),false);
    assert.ok(checkSchema({...row,value:{...row.value,scope:invalid}},schema).length);
  }
  const refs = [...file.records()].filter(r=>r.kind==="document");
  assert.deepEqual(F.serialize(M.createManifest(project,{previous:file,references:refs,entryDocument:ref.id})),F.serialize(file));
  const selected = () => {
    const D = AtriumDesignQuery, compiled = D.compile(scope,D.context(project,board));
    assert.equal(compiled.ok,true,JSON.stringify(compiled.diagnostics));
    return board.items.filter(compiled.plan.matches).map(t=>t.id);
  };
  assert.deepEqual(selected(),["thin"]);
  project.parameters.Renamed = project.parameters.MinTrace; delete project.parameters.MinTrace;
  assert.deepEqual(selected(),["thin"],"the renamed .20 mm parameter retains the .12 mm track by stable ID");
}

(async () => {
  await checkHistoricalRoots();
  await checkAuthoredRecord();
  checkParameterBinding();
  console.log("Apricot native rule scope freeze passed across 100 rules, 108 scope sides, six physical closures and a one-line edit.");
})().catch(error => {console.error(error);process.exitCode=1;});
