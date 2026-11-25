"use strict";
const assert = require("node:assert/strict");
for (const name of ["design-query-record","calculation-intent","calculation-core","note-fields","query-fields","design-query-parser",
  "design-query-geometry","design-query-context","design-query-index","design-query"]) require(require("../support/app-source-paths.cjs").appFile(name+".js"));
const Q = AtriumDesignQuery, R = AtriumDesignQueryRecord;
const board = {id:"b",kind:"pcb",name:"Power",items:[
  {id:"r1",kind:"part",ref:"R1",generic:{family:"resistor"},value:"680"},
  {id:"c1",kind:"part",ref:"C1",generic:{family:"capacitor"},value:"680"},
  {id:"a",kind:"track",net:"GND",layer:"Top",width:.1999995},
  {id:"b",kind:"track",net:"gnd",layer:"Bottom",width:.3},
  {id:"u3",kind:"part",ref:"U3",x:10,y:4}
]};
const project = {id:"p",documents:[board],library:[]};
const context = Q.context(project,board);
function ok(source,ctx=context) {
  const result=Q.compile(source,ctx);
  assert.ok(result.ok,source+" "+JSON.stringify(result.diagnostics));
  return result;
}
function ids(source) { return board.items.filter(ok(source).plan.matches).map(i=>i.id); }
assert.deepEqual(ids('object where net.name = "GND"'),["a"]);
assert.deepEqual(ids('object where net.name like "GND"'),["a","b"]);
assert.deepEqual(ids('object where net.name like case "GND"'),["a"]);
assert.deepEqual(ids("resistor where value < 1k and sheet = Power"),["r1"]);
assert.deepEqual(ids("part where value < 1 kΩ"),["r1"]);
assert.deepEqual(ids("track where width < 0.2 mm"),["a"]);
const inferred=ok("track where width < 0.2");
assert.equal(inferred.hints[0].unit,"mm");
assert.strictEqual(Q.compile("part where value < 1k",context).diagnostics[0].code,"unit-required");
assert.strictEqual(Q.compile("track where width < 3 V",context).diagnostics[0].code,"dimension");
assert.deepEqual(ids('track where (width < 0.2 mm or net.name = "gnd") and not on layer Bottom'),["a"]);
assert.deepEqual(ok('track where net.name = "GND" or width < 0.4 mm').plan.indexTerms.map(t=>t.type),["kind"]);
assert.strictEqual(ok('part where not name like "*"').plan.test(board.items[0]),null);
const special='A"\\β';
for (const k of ["net","component","netclass","componentclass","diffpair","diffpairclass","signal","tag","layer","xsignal","xsignalclass"])
  assert.deepEqual(R.toSelector(R.selector(k,special)),{kind:k,value:special});
assert.throws(()=>R.create("object",{}));
assert.equal(R.valid({languageVersion:1,source:"object",bindings:[{id:"b",name:"x",span:[0,1],target:{scope:"item",itemId:1}}]}),false);
assert.throws(()=>R.create("object where legacy.query(1)"));
assert.ok(R.valid(R.selector("net","legacy.literal")));
const nearSource="pad on layer Top near origin of U3 within 2 mm";
const stable=R.create(nearSource,[{id:"occ",name:"U3",span:[32,34],target:{scope:"item",docId:"b",itemId:"u3"}}]);
const geoCalls=[];
const geo=Q.context(project,board,{geometry:{prepareNear(o){geoCalls.push(o);return {ok:true,bounds:[0,0,4,4],matches:row=>row.gap<=o.radius,dependencies:["anchor:u3"]};}}});
const near=ok(stable,geo);
assert.equal(geoCalls[0].mode,"origin");
assert.equal(geoCalls[0].anchor.id,"u3");
assert.equal(near.plan.test({kind:"pad",layer:"Top",gap:2}),true);
assert.equal(near.plan.test({kind:"pad",layer:"Top",gap:2.1}),false);
const broken=R.copy(stable);broken.bindings[0].target.itemId="deleted";
assert.equal(Q.compile(broken,geo).diagnostics[0].code,"broken-reference");
const neg=ok("pad where not near U3 within 1 mm",geo);
assert.ok(!neg.plan.indexTerms.some(t=>t.type==="spatial"));
const first=ok("track where width < rule(MinWidth)",Q.context(project,board,{ruleValue:()=>({value:.2,unit:"mm"})}));
assert.ok(first.plan.matches(board.items[2]));
assert.equal(Q.compile("track where width < rule(MinWidth)",Q.context(project,board,{ruleType:"width"})).diagnostics[0].code,"cycle");
const quantityContext=Q.context(project,board);
for(const [key,raw,cond] of [["power","200m","250m"],["voltage","3.3 V","5"],["tolerance","4%","5"],["tcr","20 ppm/K","25"]]) {
  const p=ok("resistor where "+key+" < "+cond,quantityContext);
  assert.ok(p.plan.matches({kind:"part",ref:"R7",generic:{family:"resistor"},[key]:raw}),key);
}
assert.deepEqual(ids("track where width + 0.1 mm < 0.3 mm"),["a"]);
assert.equal(ok('object where comment = "0" and comment = "00"').plan.test({kind:"track",comment:0}),null);
const dim=Q.compile("track where width < 5 V",context).diagnostics[0];
assert.deepEqual(dim.span,[20,23]);
const rs={id:"r",kind:"part",ref:"R4",generic:{family:"resistor"},value:"1k"};
const sd={id:"sheet",kind:"schematic",name:"Power",items:[rs]};
const pp={id:"part-values",library:[],documents:[sd]};
const external="resistor where value < R4.Value * 2";
const linked=R.create(external,[{id:"ref",name:"R4.Value",span:[23,31],target:{scope:"item",docId:"sheet",itemId:"r",field:"value"}}]);
rs.ref="R5";
assert.ok(ok(linked,Q.context(pp,sd)).plan.matches(rs));
const restored=sd.items;
sd.items=[{...rs,id:"different",ref:"R4"}];
assert.equal(Q.compile(linked,Q.context(pp,sd)).diagnostics[0].code,"broken-reference");
sd.items=restored;
assert.ok(ok(linked,Q.context(pp,sd)).plan.matches(rs));
const physicallyUnknown=Q.context(project,board,{geometry:{prepareNear:()=>({ok:true,matches:()=>null})}});
for(const [src,wanted,missing] of [
  ['pad where near U3 within 1 mm and false',false,false],
  ['pad where near U3 within 1 mm or true',true,false],
  ['pad where not near U3 within 1 mm',null,true],
  ['pad where name = "missing"',null,false]
]) {
  const p=ok(src,physicallyUnknown).plan,row={kind:"pad"};
  assert.strictEqual(p.test(row),wanted);
  assert.equal(!!p.requiredMissing(row),missing);
}
assert.equal(ok('pad near U3 within 2 mm on layer Top',geo).plan.ast.args[1].family,"layer");
const frozen=Q.bind(nearSource,geo,{newId:()=>"loc"});
assert.ok(frozen.ok);
assert.deepEqual(frozen.record.bindings,[{id:"loc",name:"U3",span:[32,34],target:{scope:"item",docId:"b",itemId:"u3"}}]);
assert.deepEqual(Q.bind(frozen.record,geo).record,frozen.record);
const minTrace="track where width < project.MinTrace",parameterProject={...project,parameters:{MinTrace:{id:"p-min",unit:"mm",value:"0.20"}}};
const parameter=Q.bind(minTrace,Q.context(parameterProject,board));
assert.ok(parameter.ok);
assert.deepEqual(parameter.record.bindings[0].target,{scope:"project",field:"mintrace",parameterId:"p-min"});
parameterProject.parameters.Renamed=parameterProject.parameters.MinTrace;delete parameterProject.parameters.MinTrace;
assert.ok(ok(parameter.record,Q.context(parameterProject,board)).plan.matches(board.items[2]));
assert.equal(ok("object where inPolygon").plan.matches({kind:"track",polygonId:"pour1"}),true);
assert.equal(ok("object where teardrop").plan.test({kind:"track"}),false);
assert.equal(ok("object where teardrop").plan.matches({kind:"region",groupId:"teardrop:track1"}),true);
assert.equal(ok("object where innerLayer").plan.test({kind:"via",fromLayer:"Top",toLayer:"Inner 2"}),false);
assert.equal(ok("object where multilayer").plan.test({kind:"via",fromLayer:"Top",toLayer:"Inner 2"}),true);
assert.equal(ok('object where polarity = "+"').plan.test({kind:"track"}),null);
const geometryLayers=Q.context(project,board,{geometry:{prepareNear:()=>({ok:true,basis:"courtyard",matches:row=>row.layer!=="Top"})}});
const through={kind:"pad",drill:.3,layer:"Multi"};
assert.ok(ok("pad near U3 within 1 mm",geometryLayers).plan.matches(through));
const topOnly=ok("pad near U3 within 1 mm on layer Top",geometryLayers).plan;
assert.equal(topOnly.matches(through),false);
assert.deepEqual(topOnly.measurements[0].layers,["Top"]);
assert.equal(topOnly.measurements[0].basis,"courtyard");
assert.equal(topOnly.measurements[0].anchor.id,"u3");
const branched=ok("pad where (on layer Top and near U3 within 1 mm) or (on layer Bottom and near origin of U3 within 1 mm)",geometryLayers).plan;
assert.ok(branched.matches(through));assert.deepEqual(branched.measurements.map(r=>r.layers),[["Top"],["Bottom"]]);
async function indexing() {
  const tracks=[{id:"t1",kind:"track",net:"vCc",layer:"Top",width:.2},{id:"t2",kind:"track",layer:"Bottom",width:.1},
    {id:"n",kind:"note",color:"black"}];
  const doc={id:"x",kind:"pcb",items:tracks},pr={id:"px",library:[],documents:[doc]};
  let seq=1,changed=[],gap=false;
  const store={documentVersions:()=>({seq,outer:0,parameters:0,assembly:0}),recordedChanges:()=>gap ? {ids:null} :
    {ids:new Set(changed.map(r=>r.id)),items:new Map(changed.map(r=>[r.id,r]))}};
  const ctx=Q.context(pr,doc,{store}),p=ok("track where width < 0.3 mm",ctx).plan;
  async function run(plan,opts={}) {
    const index=await AtriumDesignQueryIndex.documentIndex(pr,doc,ctx,plan,{project:pr,revision:seq,store});
    return plan.run(index,{...opts,revision:seq});
  }
  assert.deepEqual((await run(p)).rows.map(r=>r.id),["t1","t2"]);
  tracks[0].width=.5;changed=[tracks[0]];seq++;
  const edit=await run(p);
  assert.equal(edit.checked,1);assert.equal(edit.count,tracks.filter(p.matches).length);
  tracks[2].color="red";changed=[tracks[2]];seq++;
  assert.equal((await run(p)).checked,0);
  tracks[0].width=.2;gap=true;seq++;
  const rebuild=await run(p);
  assert.equal(rebuild.count,2);assert.equal(rebuild.checked,2);
  assert.equal((await run(ok("track where width < 0.15 mm",ctx).plan)).checked,1);
  const nets=ok('net where name = "vCc"',ctx).plan;
  assert.equal((await run(nets)).count,1);
  tracks[0].net="RENAMED";changed=[tracks[0]];gap=false;seq++;
  const renamed=await run(nets);
  assert.equal(renamed.count,0);assert.equal(renamed.checked,1);
  tracks[0].net="vCc";seq++;
  assert.equal((await run(nets)).count,1);
  const result=await run(ok('track where net.name = "VCC"',ctx).plan,{suggestions:true});
  assert.equal(result.suggestions[0].value,"vCc");
  assert.deepEqual((await run(ok('track where net.name = "VCC" and width < 0.01 mm',ctx).plan,{suggestions:true})).suggestions,[]);
  assert.equal("item" in rebuild.rows[0],false);
  const auth={readProject:true,documentIds:new Set(["x"]),fields:new Set(["width"])};
  const authorized={project:pr,documentId:"x",revision:"live",authority:auth};
  assert.equal((await Q.count("track where width < 1 mm",authorized)).count,2);
  auth.fields.delete("width");
  assert.equal(Q.countSnapshot("track where width < 1 mm",authorized).diagnostic.code,"denied");
  let calls=0;
  const locked=Q.context(pr,doc,{authority:{readProject:false},describeField:()=>{calls++;},resolveRef:()=>{calls++;}});
  assert.equal(Q.compile("track near secret within 1 mm",locked).diagnostics[0].code,"denied");assert.equal(calls,0);
  const cancel={aborted:false};
  const stopped=await p.run({rows:tracks},{limit:1,signal:cancel,onPage:()=>{cancel.aborted=true;}});
  assert.equal(stopped.diagnostic.code,"cancelled");
  const available=new Set(["x"]);
  const restricted=Q.context(pr,doc,{authority:{documentIds:available}});
  const revoked=await ok("track",restricted).plan.run({rows:tracks},{limit:1,onPage:()=>available.clear()});
  assert.equal(revoked.diagnostic.code,"denied");
  const devices=[{id:"l1",kind:"part",ref:"D1",def:"led"},{id:"l2",kind:"part",ref:"D2",def:"led"},
    {id:"d",kind:"part",ref:"D3",def:"diode"},{id:"res",kind:"part",ref:"R7"}];
  const dd={id:"lights",kind:"schematic",items:devices},catalog={library:[{id:"led",generic:{family:"led"}},{id:"diode",generic:{family:"diode"}}],documents:[dd]};
  assert.equal((await Q.count("LED",{project:catalog,documentId:"lights",revision:1})).count,2);
}
async function repeatedPadNumbers() {
  for(const n of ["model","spatial","board-shape","viastack","rules","dfa","query"]) require(require("../support/app-source-paths.cjs").appFile(n+".js"));
  const anchor={id:"anchor",footprint:{pads:[],courtyard:[0,0,2,2]}};
  const land={number:"1",y:0,w:1,h:1,shape:"rect"};
  const probe={id:"probe",footprint:{pads:[{...land,x:6,layer:"Bottom"},{...land,x:0,layer:"Multi",drill:.3}]}};
  const doc={id:"board",kind:"pcb",items:[
    {id:"u",kind:"part",def:"anchor",ref:"U3",x:10,y:10,angle:0,layer:"Top"},
    {id:"tp",kind:"part",def:"probe",ref:"TP1",x:12.5,y:11,angle:0,layer:"Bottom"}
  ]};
  const project={id:"with-two-lands",documents:[doc],library:[anchor,probe]},defs=new Map(project.library.map(d=>[d.id,d]));
  const options={project,documentId:doc.id,defs,revision:1},ctx=Q.context(project,doc,options);
  const filterPads=AtriumQuery.run(project,doc,"IsPad",options).subs;
  assert.deepEqual(filterPads.map(p=>[p.id,p.padIndex]),[["tp/1",0],["tp/1/1",1]]);
  for(const layer of ["on layer Top ","on layer Bottom ",""]) {
    const source="pad "+layer+"near U3 within 0.1 mm",plan=ok(source,ctx).plan;
    const index=await AtriumDesignQueryIndex.documentIndex(project,doc,ctx,plan,options);
    const rows=(await plan.run(index)).rows.map(r=>r.id);
    assert.deepEqual(rows,["tp/1/1"]);
    assert.equal((await Q.count(source,options)).count,1);
    const filtered=globalThis.AtriumQueryExchange ? AtriumQuery.run(project,doc,source,options).subs :
      filterPads.filter(p=>plan.matches({...p,kind:"pad",ownerId:p.part.id}));
    assert.deepEqual(filtered.map(p=>p.id),rows);
  }
}
async function read() {
  await indexing();
  await repeatedPadNumbers();
  const chunks=[];
  const p=ok("track where width < 1 mm").plan;
  const result=await p.run({rows:board.items},{limit:1,onPage:page=>chunks.push(page)});
  assert.equal(result.count,2);assert.equal(result.rows.length,1);assert.equal(chunks[0].complete,false);assert.equal(chunks.at(-1).complete,true);
  const opts={project,documentId:"b",revision:"r1"};
  const n=await Q.count("resistor where value < 1k",opts);
  assert.equal(n.count,1);assert.equal(Q.countSnapshot("resistor where value < 1k",opts).count,1);
  assert.equal(Q.countSnapshot("resistor where value < 1k",{...opts,revision:"r2"}).complete,false);
  assert.equal((await Q.count("track",{...opts,signal:{aborted:true}})).diagnostic.code,"cancelled");
  assert.equal((await Q.count("track",{...opts,authority:{readProject:false}})).diagnostic.code,"denied");
  console.log("Native query records, field units, Boolean plans, bindings, geometry, read streaming and counts passed.");
}
read().catch(e=>{ console.error(e);process.exitCode=1;});
