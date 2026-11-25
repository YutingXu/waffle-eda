"use strict";
// Run the registered foreign writers and re-import their actual output. Simulated host
// methods expose just the receipt contract exercised independently by the native host tests.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
for (const m of ['model','i18n','i18n-core','obsolete-project','translator-table','translator-registry','import-export','import-link']) require(require("../support/app-source-paths.cjs").appFile(m+'.js'));
const cleanup = require('../support/import-worker.cjs')({client:true});
const E = AtriumImportExport, C = AtriumTranslatorClient;
const root = path.join(__dirname,'../fixtures/import'), bytes = name => new Uint8Array(fs.readFileSync(path.join(root,name)));
const file = {name:'demo.kicad_pcb',bytes:bytes('demo.kicad_pcb')};
async function test() {
  const original = await C.import([file]), p = original.model, board = p.documents[0];
  const placeholder = AtriumImportLink.placeholder('schematic','Schematic'); p.documents.push(placeholder);
  const wire = board.items.find(i => i.kind === 'track'); assert.ok(wire);
  let revision=0, open=true, target=null, cancel=false, duringReview, duringWrite;
  const session = {sourceKey:'verified-demo',name:'Demo',sourceFile:file,sourceFiles:[file],translator:original.report.translator,
    entry:original,current:()=>open,revision:()=>revision};
  p.bomViews = [{id:'bench',name:'Bench purchasing'}];
  const reviewed = [], writes = [], remembers=[];
  globalThis.AtriumImportSaveView = {async report(o) { reviewed.push(o); duringReview?.(); return {proceed:!cancel,remember:true}; }};
  globalThis.AtriumHost = {platform:'test', recalledImportExport:async()=>target,
    async writeImportExport(request){
      assert.strictEqual(request.file,file); assert.strictEqual(request.sources[0],file);
      if (request.destination) assert.equal(request.destination,target.destination);
      writes.push(request); duringWrite?.(); return {destination:'separate-grant',name:request.name};
    },rememberImportExport:async o=>{remembers.push(o);target={destination:o.destination,name:'Demo export'};return true;},
    forgetImportExport:async()=>{target=null;return true;}};
  assert.deepEqual(await E.exportImported({session,project:p}),{status:'unconfigured'});
  const explicit=()=>E.exportImported({session,project:p,choice:'export'});
  cancel=true; assert.equal((await explicit()).status,'cancelled'); assert.equal(writes.length,0);assert.equal(remembers.length,0);
  cancel=false; duringReview=()=>revision++;
  assert.equal((await explicit()).status,'stale'); assert.equal(writes.length,0); duringReview=null;
  const first=await explicit(); assert.equal(first.status,'exported'); assert.equal(first.remembered,true);
  assert.equal(first.revision,revision); assert.equal(writes.length,1);assert.equal(remembers.length,1);
  const before=reviewed.at(-1);
  assert.ok(before.kept.some(row=>row.label==='Track' && row.count>0));
  assert.equal(before.lost.find(row=>row.label==='BOM view').count,1);
  assert.ok(!before.lost.some(row=>row.label==='Output job'));
  assert.ok(!before.kept.some(row=>row.label==='Schematic document'));
  assert.ok(!before.kept.some(row=>row.label.startsWith('KiCad ')));
  assert.ok(writes[0].files.some(f=>f.name.endsWith('.kicad_pro')));
  const primary = write => write.files.find(f=>f.name.endsWith('.kicad_pcb'));
  const savedTrack = async row => (await C.import([{name:row.name,bytes:row.bytes}])).model.documents[0].items.find(i=>i.kind==='track');
  const firstTrack=await savedTrack(primary(writes[0])); assert.equal(firstTrack.width,wire.width);
  wire.width = .729; revision++;
  const previouslyReviewed=reviewed.length, second=await E.exportImported({session,project:p});
  assert.equal(second.status,'exported');assert.equal(writes.length,2);assert.equal(reviewed.length,previouslyReviewed);
  assert.equal(writes[1].destination,'separate-grant');assert.equal((await savedTrack(primary(writes[1]))).width,.729);
  assert.equal(remembers.length,1); assert.equal(new TextDecoder().decode(file.bytes),fs.readFileSync(path.join(root,file.name),'utf8'));
  duringWrite=()=>revision++;
  const third=await E.exportImported({session,project:p});assert.equal(third.revision,revision-1);duringWrite=null;
  const duplicate=await Promise.all([E.exportImported({session,project:p}),E.exportImported({session,project:p})]);
  assert.deepEqual(duplicate[0],duplicate[1]);assert.equal(writes.length,4);
  const committed=AtriumHost.writeImportExport;
  AtriumHost.writeImportExport=async request=>({...await committed(request),preferenceError:'Preference store unavailable'});
  const partial=await E.exportImported({session,project:p});
  assert.equal(partial.status,'exported');assert.equal(partial.remembered,false);assert.match(partial.preferenceError,/Preference store unavailable/);
  AtriumHost.writeImportExport=committed;
  const altered={...session,translator:'altium'};assert.equal((await E.exportImported({session:altered,project:p,choice:'export'})).status,'unavailable');
  open=false;assert.equal((await E.exportImported({session,project:p,choice:'export'})).status,'stale');open=true;
  placeholder.name='User sheet';assert.equal(E.snapshot(p).documents.length,2);
  await E.forget(session);assert.equal(await E.recall(session),null);

  // Altium uses its live ASCII project writer. The real wire is retained while the
  // actual output-only connector direction and project BOM view are counted separately.
  const a=Atrium.project('Lab'), sheet=a.documents[0];a.documents=[sheet];
  sheet.items.push({id:'edge',kind:'offsheet',text:'LINK',x:2,y:3,angle:0,io:'input'},
    {id:'w',kind:'wire',points:[[0,3],[2,3]]},{id:'frame',kind:'textframe',role:'frame',text:'Inputs',x:0,y:0,w:10,h:8});
  a.bomViews=[{id:'v',name:'Inspection'}];
  const plan=await E.prepare({format:'altium',project:a,translate:C.export});
  assert.ok(plan.formatLabel.includes('ASCII'));assert.ok(plan.files.some(f=>f.name.endsWith('.PrjPcb')));
  assert.ok(plan.summary.lost.find(r=>r.label==='Off-sheet connector direction'&&r.count===1));
  assert.ok(plan.summary.converted.find(r=>r.label==='Named frame'&&r.count===1));
  assert.ok(plan.summary.kept.find(r=>r.label==='Wire'&&r.count===1));
  const sheetFile=plan.files.find(f=>f.name.endsWith('.SchDoc'));
  assert.ok(new TextDecoder().decode(sheetFile.bytes).includes('LINK'));
  const placed=board.items.find(item=>item.kind==='part');
  const definition=p.library.find(def=>def.id===placed.def);
  const artworkLayer='Mechanical 17';
  const footprint={...definition.footprint,shapes:[{kind:'path',layer:artworkLayer,points:[[0,0],[1,0]],width:.1}]};
  const artworkProject=Atrium.project('Footprint artwork');
  artworkProject.documents=artworkProject.documents.filter(d=>d.kind==='pcb');
  artworkProject.documents[0].items=[placed];
  artworkProject.library=[{...definition,footprint}];
  const altiumArtwork=await E.prepare({format:'altium',project:artworkProject});
  assert.deepEqual(altiumArtwork.summary.lost,[{label:'Footprint graphic',count:1,
    detail:`Graphics on layers Altium has no equivalent for (${artworkLayer}) omitted.`}]);
  assert.ok(altiumArtwork.summary.kept.some(row=>row.label==='Component' && row.count===1));

  // The ordinary worker's source-format action also handles EAGLE pairs. Its verified
  // originals can contribute otherwise uneditable records while live edits take precedence.
  const pair=await C.import(['demo-eagle.sch','demo-eagle.brd'].map(name=>({name,bytes:bytes(name)})));
  const eb=pair.model.documents.find(d=>d.kind==='pcb'), tr=eb.items.find(i=>i.kind==='track');
  tr.width=.682;
  const eagle=await E.prepare({format:pair.report.translator,project:pair.model,provenance:pair.provenance,translate:C.export});
  assert.equal(eagle.files.length,2);
  assert.ok(eagle.files.some(f=>f.name.endsWith('.sch')) && eagle.files.some(f=>f.name.endsWith('.brd')));
  const again=await C.import(eagle.files.map(f=>({name:f.name,bytes:new TextEncoder().encode(f.text)})));
  assert.ok(again.model.documents.find(d=>d.kind==='pcb').items.some(i=>i.kind==='track' && i.width===.682));

  const rawFile = name=>({name,bytes:bytes(name)}), outputBytes = row=>({name:row.name,bytes:row.bytes || new TextEncoder().encode(row.text)});
  const std=['demo-easyeda-pcb.json','demo-easyeda-sch.json'].map(rawFile), pro=rawFile('demo-easyeda.epro');
  for (const [edition,inputs] of [['standard',std],['pro',[pro]]]) {
    const source=await C.import(inputs), board=source.model.documents.find(d=>d.kind==='pcb');
    board.items.find(i=>i.kind==='track').width=.6813;
    const saved=await E.prepare({format:source.report.translator,project:source.model,provenance:source.provenance});
    assert.equal(saved.formatLabel,edition==='pro'?'EasyEDA Pro':'EasyEDA Standard');
    assert.equal(saved.details.edition,edition);assert.equal(saved.files.length,edition==='pro'?1:2);
    assert.ok(saved.files.every(f=>f.name.endsWith(edition==='pro'?'.epro':'.json')));
    assert.ok(!Object.values(saved.summary).flat().some(r=>/flex|stiffener|bendCrossing/i.test(r.label)));
    const reopened=await C.import(saved.files.map(outputBytes));
    assert.ok(reopened.model.documents.find(d=>d.kind==='pcb').items.some(i=>i.kind==='track' && Math.abs(i.width-.6813)<.0002));
    if (edition==='standard') {
      const flex=source.model.rules.list.find(r=>r.type==='flexVias');
      assert.ok(AtriumUUID.isV7(flex.id));
      assert.equal(flex.origin.kind,'default');assert.equal(flex.origin.key,'flexVias-1');
      flex.name='Checked fabrication rule';
      const changed=await E.prepare({format:source.report.translator,project:source.model,provenance:source.provenance});
      assert.equal(changed.summary.lost.filter(r=>/flex/i.test(r.label)).length,1);
    }
  }
  const files=[std[0],pro], mixed=await C.import(files), originalHost=AtriumHost;
  globalThis.AtriumHost={platform:'test',writeImportExport:async input=>({destination:'chosen-target',name:input.name})};
  for (const [primary,edition,converted] of [[std[0],'Standard',2],[pro,'Pro',1]]) {
    const session={sourceKey:'mixed',sourceFile:primary,sourceFiles:files,entry:mixed,translator:mixed.report.translator};
    assert.equal((await E.exportImported({session,project:mixed.model,choice:'export'})).status,'exported');
    assert.equal(reviewed.at(-1).formatLabel,'EasyEDA '+edition);
    assert.equal(reviewed.at(-1).converted.find(r=>r.label==='EasyEDA document edition').count,converted);
  }
  globalThis.AtriumHost=originalHost;

  // The writers may emit required target defaults even when none were chosen. Source-explicit
  // equal-to-stock values, edited names, disabled rules and newly authored rules do belong here.
  const bare=Atrium.project('Single track');bare.library=[];bare.documents=bare.documents.filter(d=>d.kind==='pcb');
  bare.documents[0].items.push({id:'t',kind:'track',width:.25,points:[[0,0],[5,0]],layer:'Top'});
  const pads=Atrium.project('Standalone pads');pads.library=[];pads.documents=pads.documents.filter(d=>d.kind==='pcb');
  const pad={kind:'pad',w:1,h:1,layer:'Top',shape:'round'};
  pads.documents[0].items.push({...pad,id:'usable',x:0,y:0},{...pad,id:'omitted',x:3,y:0,drill:2});
  const padPlan=await E.prepare({format:'kicad',project:pads});
  assert.deepEqual(padPlan.summary.kept.filter(row=>row.label==='Pad'),[{label:'Pad',count:1}]);
  assert.deepEqual(padPlan.summary.lost,[{label:'Pad',count:1,detail:'Pads with inconsistent copper or drill dimensions omitted.'}]);
  assert.ok(!Object.values(padPlan.summary).flat().some(row=>row.label==='Footprint pad'));
  const boardText=padPlan.files.find(f=>f.name.endsWith('.kicad_pcb')).text;
  assert.equal(boardText.match(/\(footprint\s/g).length,1);
  const artwork=Atrium.project('Two fabrication layers');
  artwork.documents=[{...bare.documents[0],items:Array.from({length:18},(_,i)=>({id:'fab-'+i,kind:'graphic',
    points:[[i,0],[i,1]],width:.1,layer:i===0?'Mechanical 14':'Mechanical 13'}))}];
  artwork.library=[];
  const fab=await E.prepare({format:'kicad',project:artwork});
  const graphics=fab.summary.lost.filter(row=>row.label==='Graphic');
  assert.deepEqual(graphics,[{label:'Graphic',count:18,
    detail:'×17 Graphic on unsupported layer Mechanical 13 omitted. · ×1 Graphic on unsupported layer Mechanical 14 omitted.'}]);
  // The full report can pack many identities into one reference. The review counts
  // represented objects, including any which have no detailed reason of their own.
  const packedReasons=E.summary({kinds:[{kind:'graphic',dropped:5021,references:[
    {status:'dropped',reason:'Layer A',count:4},{status:'dropped',reason:'Layer B',grouped:true,count:5000},
    {status:'dropped',reason:'Layer A',count:8},{status:'dropped',reason:'Layer C',count:7},{status:'dropped',count:2}
  ]}]}).lost;
  assert.deepEqual(packedReasons,[{label:'Graphic',count:5021,detail:'×'+AtriumI18n.number(5000)+' Layer B · ×12 Layer A',additionalDetails:['×7 Layer C']}]);
  const usedRules=plan=>Object.values(plan.summary).flat().filter(r=>r.label==='Design rule').reduce((n,r)=>n+r.count,0);
  for (const format of ['kicad','altium','eagle','easyeda']) assert.equal(usedRules(await E.prepare({format,project:bare})),0,format);
  require('../../app/checks/rules.js');
  const book=AtriumRules.migrate(null);
  bare.rules={format:book.format,version:3,units:book.units,list:book.list};
  const clearance=book.list.find(r=>r.type==='clearance');
  clearance.name='Renamed exact stock value';
  book.list.find(r=>r.type==='width').enabled=false;
  book.list.push({...clearance,id:'authored-rule',name:'Authored clearance',priority:2});
  for (const format of ['kicad','altium']) {
    const actual=await E.prepare({format,project:bare});
    assert.equal(usedRules(actual),3,format+' named or modified rules');
    if (format==='kicad') assert.equal(actual.summary.lost.find(r=>r.label==='Design rule').count,1);
  }
  const classic='(kicad_pcb (version 20211014) (layers (0 "F.Cu" signal) (31 "B.Cu" signal)) (net_class "Default" "" (clearance 0.2)) (segment (start 0 0) (end 5 0) (width 0.2) (layer "F.Cu")))';
  const sourceRule=await C.import([{name:'one.kicad_pcb',bytes:new TextEncoder().encode(classic)}]);
  const owned=sourceRule.provenance.classRuleDefaults[0].rules;
  assert.deepEqual(Array.from(owned).filter(r=>r.explicit).map(r=>r.type),['clearance']);
  for (const format of ['kicad','altium'])
    assert.equal(usedRules(await E.prepare({format,project:sourceRule.model,provenance:sourceRule.provenance})),1,
      'Source provided the stock clearance, while the importer supplied width and pad-only drill defaults.');
  const editedDefault=Atrium.clone(sourceRule.model);
  const padLimit=editedDefault.rules.list.find(rule=>rule.type==='holeSize');
  assert.equal(padLimit.scope.source,'pad');
  padLimit.name='Authored pad drill';
  const explicitWidth=await C.import([{name:'one.kicad_pcb',bytes:new TextEncoder().encode(
    classic.replace('(clearance 0.2)','(clearance 0.2) (trace_width 0.25)'))}]);
  for (const format of ['kicad','altium']) {
    assert.equal(usedRules(await E.prepare({format,project:editedDefault,provenance:sourceRule.provenance})),2,
      'An edited pad fallback becomes an authored rule even while it retains its template identity.');
    assert.equal(usedRules(await E.prepare({format,project:explicitWidth.model,provenance:explicitWidth.provenance})),2,
      'Source width and clearance both count even when they equal the importer defaults.');
  }

  // The actual catalog formatter receives stable feature and diagnostic keys.
  AtriumI18n.add('en-XA',{'import_feature.track':'[Trace]','import_feature.bomView':'[Parts view]',
    'import_export.originalEagle':'[Original {record}]','import_export.missingDefinition':'[Native definition omitted]',
    'import_export.sourceMissing':'[Choose source again]'});
  await AtriumI18n.setLocale('en-XA');
  const localized=E.summary(eagle.report);
  assert.ok(localized.kept.some(row=>row.label==='[Trace]'));
  assert.ok(localized.kept.some(row=>row.label.startsWith('[Original ')) ||
    localized.converted.some(row=>row.label.startsWith('[Original ')) || localized.lost.some(row=>row.label.startsWith('[Original ')));
  assert.equal(E.summary(plan.report).lost.find(row=>row.label==='[Parts view]').detail,'[Native definition omitted]');
  assert.equal((await E.exportImported({session:altered,project:p,choice:'export'})).reason,'[Choose source again]');
}
test().finally(()=>{C.cancel();cleanup();}).catch(e=>{console.error(e);process.exitCode=1;});
