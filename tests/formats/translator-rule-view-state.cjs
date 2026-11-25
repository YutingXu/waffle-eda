"use strict";
const assert=require("node:assert/strict"), fs=require("node:fs"), path=require("node:path");
globalThis.CFB=require("../../app/vendor/cfb.min.js");
for(const m of ["model","board-shape","board-shape-sources","stackup","query","altium-rules","net-intent","signals","rules","project-rules","pcb-pours","pcb-import","io","import-rules","translator-provenance","import-reports"])require(require("../support/app-source-paths.cjs").appFile(m+".js"));

(async()=>{
  const name="PiDP11IOExpander.PcbDoc",dir=path.join(__dirname,"../fixtures/altium/pidp11-io-expander");
  const parsed=AtriumIO.read(name,fs.readFileSync(path.join(dir,name))),raw=parsed.documents[0];
  const source=raw.sourceRules,expected=AtriumRules.sourceReport(source,raw);
  const clean=()=>{const p=Atrium.project("PiDP");p.documents=[{...raw}];p.library=parsed.library;
    delete p.documents[0].sourceRules;delete p.documents[0].sourceClasses;delete p.documents[0].sourceRuleLayers;return p;};
  const projectA=clean(),projectB=clean(),sessionA={},sessionB={};
  let project=projectA,session=sessionA,messages=[];
  const host={project:()=>project,fileSession:()=>session,currentId:()=>raw.id,doc:()=>project.documents[0],on(){},registerAction(){},
    edit(fn){fn();},info(){},defs:()=>null,messageContext:()=>({})};
  const reports=AtriumImportReports,I=AtriumImportRules;
  reports.attach(host);
  const register=(text,layerNames)=>reports.remember(session,{report:{},provenance:{fields:[
    {type:"document",id:raw.id,values:{sourceRules:text,...(layerNames?{sourceRuleLayers:layerNames}:{})}}]}},[raw.id],[name]);
  register(source,raw.sourceRuleLayers);
  globalThis.AtriumPrefs={get:()=>"ask"};globalThis.AtriumMessages={show:(_ctx,group)=>{messages.push(group);}};
  assert.deepEqual(I.pending(projectA,[raw.id]).map(x=>x.count),[41]);assert.deepEqual(I.pending(projectA,[]),[]);
  await Promise.all([I.offer(host,[raw.id]),I.offer(host,[raw.id])]);
  assert.equal(messages.length,1,"concurrent registration offers the same source only once");
  const oldAction=messages[0].actions.find(x=>x.label==="Use the board's rules");
  project=projectB;session=sessionB;
  const bRows=source.filter(line=>AtriumAltiumRules.describe(line).name==="Width_1A");
  register(bRows,raw.sourceRuleLayers);oldAction.run();
  assert.equal(projectB.rules,undefined,"a stale action cannot apply an old file's board with the same ID");
  await I.offer(host,[raw.id]);const replacedAction=messages.at(-1).actions[0];
  reports.setSourceRules(projectB.documents[0],source.slice(0,2));replacedAction.run();
  assert.equal(projectB.rules,undefined,"replacing the original rules invalidates a pending action");
  project=projectA;session=sessionA;
  const ordinary=projectA.documents[0],converted=I.apply(ordinary,projectA);
  assert.deepEqual(converted.report,expected);assert.equal(converted.converted,28);
  assert.equal(ordinary.appliedSourceRuleRecords.length,28);assert.ok(!("sourceRules" in ordinary));
  assert.deepEqual(I.pending(projectA),[]);
  AtriumProjectRules.edit(projectA,b=>{b.list=b.list.filter(r=>!r.origin?.record);});
  assert.equal(ordinary.appliedSourceRuleRecords.length,28,"an accepted source can be deleted without resurrecting it");
  assert.deepEqual(I.pending(projectA),[]);
  assert.equal(reports.sourceDocument(ordinary).sourceRules,source);
  const replacement=source.map(line=>line.replace("COMMENT=","COMMENT=External revision "));
  const state=reports.capture();reports.setSourceRules(ordinary,replacement);assert.deepEqual(reports.sourceDocument(ordinary).sourceRules,replacement);
  const save=AtriumTranslatorProvenance.toLegacy(projectA,reports.provenance());
  assert.deepEqual(save.documents[0].sourceRules,replacement,"the native-compatible save uses the latest explicit source rows");
  reports.restore(sessionA,state);assert.equal(reports.sourceDocument(ordinary).sourceRules,source);
  assert.ok(!("sourceRules" in ordinary));
  // Default (no preference stored): the board's own rules are applied on import, with a Review… action.
  const projectC=clean(),sessionC={};project=projectC;session=sessionC;register(source,raw.sourceRuleLayers);
  globalThis.AtriumPrefs={get:()=>undefined};messages=[];
  assert.equal(await I.offer(host,[raw.id]),"use");
  assert.equal(I.pending(projectC).length,0,"the default converts the board's rules without asking");
  assert.ok(messages.at(-1).actions.some(x=>x.label==="Review…"));
  console.log("PASS file-scoped source rule reports, stale offers, native adoption and detached original text, default use");
})().catch(error=>{console.error(error);process.exitCode=1;});
