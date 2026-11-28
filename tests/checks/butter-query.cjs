"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
for (const mod of ["uuid-v7","model","source-file","format-2-codec","format-2-units","format-2-values","format-2-model",
  "parts","pcb-draw","altium-rules","component-classes","stackup","board-shape","net-intent","signals","rules","project-rules",
  "dfa","length-tuning","sch-objects","hierarchy","multichannel","net-ties","messages","erc","design-query","undo-store",
  "proposal","butter-query-service","viastack","z-clearance"]) require(require("../support/app-source-paths.cjs").appFile(mod+".js"));
const {AtriumFormat2:F,AtriumFormat2Model:M,AtriumQueryService:Q,AtriumRules:R,AtriumUndoStore:U} = globalThis;
const root = path.join(__dirname,"../fixtures/design-query/query-proof");
const read = file => fs.readFileSync(path.join(root,file));
const manifest = M.parse(read("Query proof.waffle"));
const {project,members} = M.manifest(manifest);
for (const member of members) {
  const file = M.parse(read(member.path));
  if (member.kind === "library") project.library.push(M.library(file));
  else project.documents.push(M.document(file,{name:member.name}));
}
const board = project.documents.find(d => d.id === "analog"), power = project.documents.find(d => d.id === "power");
const scope = {project,documentId:board.id,enabled:true,store:U};
const local = 'track where width <= 0.2 and net.name = "Rail"';
const copper = 'pad on layer Top near U3 within 1 mm';
const rows = r => r.rows.map(x => x.id);
const rc = u => ({languageVersion:1,source:u});
const sha = r => F.sha256(F.serialize(r));
const get = doc => U.recordedChanges(doc).seq;
const wait = () => new Promise(resolve => setTimeout(resolve,0));

async function main() {
  U.reset(project);
  const h = [], f = [], edit = (fn,items) => {
    const before = U.mark(project);
    fn(); U.checkpoint(h,f,before);
    U.record(project,{doc:board,items});
  };
  const live = () => ({...scope,revision:get(board),getRevision:() => get(board)});
  assert.deepEqual(Object.keys(await Q.search(local,{project})),["status","complete","diagnostic"]);
  assert.equal((await Q.search(local,{project})).status,"disabled");
  let preparedHints;
  const result = await Q.search(local,{...live(),limit:1,onPrepared:hints => { preparedHints = hints; }});
  assert.equal(result.complete,true); assert.equal(result.count,2);
  assert.ok(preparedHints.some(hint => hint.code === "inferred-unit" && hint.unit === "mm"));
  assert.deepEqual(rows(result),["rail-at-limit"]);
  assert.ok(result.cursor);
  assert.deepEqual(rows(await Q.search(local,{...live(),limit:1,cursor:result.cursor})),["rail-thin"]);
  assert.equal((await Q.search("track",{...live(),cursor:result.cursor})).status,"stale");
  const warm = await Q.search(local,live());
  assert.equal(warm.visited,0);
  assert.deepEqual(rows(warm),["rail-at-limit","rail-thin"]);
  const table = await Q.materialize(local,{...live(),fields:["width"]});
  assert.deepEqual(rows(table),rows(warm));
  assert.equal(table.rows[0].fields.width.unit,"mm");
  assert.equal(table.rows[0].fields.width.value,.0002);
  assert.equal(table.rows[0].fields.width.magnitude,.2);
  assert.equal((await Q.materialize(local,{...live(),limit:1})).status,"partial");
  const track = board.items.find(r => r.id === "rail-at-limit");
  edit(() => {track.width = .25;},[track]);
  const changed = await Q.search(local,live());
  assert.equal(changed.visited,1);
  assert.deepEqual(rows(changed),["rail-thin"]);
  assert.equal((await Q.search(local,{...live(),cursor:result.cursor})).status,"stale");
  const note = {id:Atrium.id(),kind:"graphic",layer:"Top Silk",shape:"text",x:0,y:0,text:"Unelectrical note"};
  edit(() => {board.items.push(note);},[note]);
  const untouched = await Q.search(local,live());
  assert.equal(untouched.visited,0);
  assert.deepEqual(rows(untouched),rows(changed));
  assert.ok(U.jump(h,f,U.mark(project),-2));
  const undone = await Q.search(local,live());
  assert.deepEqual(rows(undone),rows(warm));
  assert.equal(undone.visited,1);
  assert.ok(U.jump(h,f,U.mark(project),2));
  assert.deepEqual(rows(await Q.search(local,live())),rows(changed));
  const fresh = structuredClone(project);
  assert.deepEqual(rows(await Q.search(local,{...live(),project:fresh,store:null})),rows(changed));
  track.width = .19;
  U.reset(project);
  U.mark(project);
  const fallback = await Q.search(local,live());
  assert.deepEqual(rows(fallback),rows(warm));
  assert.ok(fallback.visited > 1,"The unknown edit cursor rebuilds the affected partition.");

  const a = {id:"read-job",version:1,readProject:true,readable:true,
    documentIds:new Set([board.id]),canReadItem:id => a.readable && id !== "rail-at-limit"};
  const allowed = await Q.search(local,{...live(),authority:a});
  assert.deepEqual(rows(allowed),["rail-thin"]);
  assert.equal(allowed.count,1);
  for (const denied of [
    await Q.search(local,{...live(),authority:a,documentId:power.id}),
    await Q.search('track where width < 1 mm',{...live(),authority:{...a,fields:new Set(["kind"])}}),
    await Q.search(local,{...live(),authority:{...a,readProject:false}}),
    await Q.search("net",{...live(),authority:a}),
    await Q.search("part where locked",{...live(),authority:a,fields:["width"],limit:201,documentId:"secret"}),
  ]) {
    assert.equal(denied.status,"denied");
    assert.deepEqual(Object.keys(denied),["status","complete","diagnostic"]);
    assert.doesNotMatch(JSON.stringify(denied),/secret|rail-at-limit|count/);
  }
  const abort = new AbortController();
  const cancelled = await Q.search("track",{...live(),limit:1,signal:abort.signal,onPage(r) {
    assert.equal(r.status,"counting"); assert.equal(r.lowerBound,1); assert.equal(r.count,undefined);
    abort.abort();
  }});
  assert.equal(cancelled.status,"cancelled");
  assert.equal(cancelled.rows,undefined);
  const stale = await Q.search("via",{...live(),getRevision:() => -1});
  assert.equal(stale.status,"stale");
  const invalid = await Q.search("track where width > 1 V",live());
  assert.equal(invalid.status,"error");
  assert.equal(invalid.diagnostic.code,"dimension");
  assert.ok(invalid.diagnostic.span[1] > invalid.diagnostic.span[0]);
  assert.equal((await Q.count('track where net.name = "Nothing"',live())).count,0);
  const partial = await Q.search("track where width < rule(MinWidth)",live());
  assert.equal(partial.status,"partial",JSON.stringify(partial)); assert.equal(partial.count,undefined);
  assert.ok(partial.lowerBound > 0,JSON.stringify(partial));
  const docs = [...project.documents,{id:"unloaded",kind:"pcb",name:"Unloaded"}];
  assert.equal((await Q.search(local,{enabled:true,project:{...project,documents:docs},revision:1})).status,"partial");
  const withoutAnchor = {id:"zz-no-anchor",kind:"pcb",name:"No anchor",items:[]};
  const previewScope = {...live(),project:{...project,documents:[board,withoutAnchor]},documentId:undefined};
  const brokenPlan = await Q.plan(copper,previewScope);
  assert.equal(brokenPlan.diagnostic.code,"broken-reference");
  const brokenSearch = await Q.search(copper,{...previewScope,
    onPrepared:() => assert.fail("The project query did not compile on every document."),
    onProjection:() => assert.fail("A preview must check all plans before scanning the design.")});
  assert.deepEqual(brokenSearch,brokenPlan);

  const preview = Q.applicability("two-nets",live());
  assert.equal(preview.complete,true,JSON.stringify(preview));
  assert.deepEqual(rows(preview.scope),["pair-plus"]);
  assert.deepEqual(rows(preview.scope2),["pair-minus"]);
  assert.deepEqual(preview.pairs.rows.map(pair => pair.map(r => r.id)),[["pair-minus","pair-plus"]]);
  const direct = R.drc(board,new Map(project.library.map(d=>[d.id,d])),R.stored(board,project),{project,types:["clearance"]});
  assert.deepEqual(preview.violations.map(v=>[v.id,v.otherId]),direct.violations.filter(v=>v.ruleId==="two-nets").map(v=>[v.id,v.otherId]));
  const erc = Q.applicability("low-ohms",{...live(),documentId:power.id});
  assert.equal(erc.complete,true,JSON.stringify(erc)); assert.equal(erc.domain,"erc");
  assert.deepEqual(rows(erc.winners),["r-small"]);
  assert.equal(erc.violations.length,2);
  assert.ok(erc.violations.every(v => v.id === "r-small" && v.type === "unconnectedPins" && v.severity === "Fatal"));
  assert.equal(new Set(erc.violations.map(v => v.signature)).size,2);

  const save = await Q.save({name:"Board probe",query:copper,scope:{documentId:board.id}},live());
  assert.equal(save.result.complete,true,JSON.stringify(save.result));
  assert.ok(AtriumDesignQueryRecord.savedId(save.result.record.id));
  assert.ok(save.result.record.query.bindings?.length);
  assert.equal(project.savedQueries,undefined);
  const p2 = {...project,savedQueries:save.ops[0].after};
  const out = F.applyDelta(manifest,M.manifestEdits(manifest,p2));
  const id = save.result.record.id;
  assert.equal(out.file.header.formatVersion,"2.1");
  assert.equal(out.file.header.requires,undefined);
  assert.equal(out.changedRows,1);
  assert.equal(out.file.get(id).kind,"savedQuery");
  const opened = M.manifest(M.parse(F.serialize(out.file))).project;
  assert.deepEqual(opened.savedQueries[0],save.result.record);
  assert.equal(Q.references(p2,{enabled:true}).references.length,2);
  const oldKinds = [...manifest.records()].map(r => r.kind);
  const legacy = F.parse(F.serialize(out.file),{knownKinds:oldKinds});
  assert.equal(legacy.isOpaque(id),true);
  const renamed = F.edit(legacy,{header:{...legacy.header,name:"Older reader edit"}});
  assert.equal(renamed.rawRecord(id),out.file.rawRecord(id));
  assert.equal(sha(manifest),F.sha256(read("Query proof.waffle")));
  const readopts = {...live(),project:p2,revision:1,getRevision:undefined};
  assert.equal(Q.list(readopts).count,1);
  assert.equal(Q.get(id,readopts).record.id,id);
  assert.deepEqual((await Q.save({id,query:copper},readopts)).ops,[]);
  assert.deepEqual(rows(await Q.search({savedQueryId:id},readopts)),["probe-edge/1/1"]);
  assert.equal((await Q.search({savedQueryId:id},{...readopts,documentId:power.id})).diagnostic.code,"scope");
  assert.equal(Q.remove(id,{...readopts,authority:{readProject:true,writeProject:false}}).result.status,"denied");
  assert.equal(Q.remove(id,readopts).ops[0].after.length,0);
  assert.equal(AtriumDesignQueryRecord.validSaved({...save.result.record,plan:{}}),false);
  await wait();
  await editedParity();
  ruleParity();
  await narrowPartitions();
  console.log("Butter query plan, streaming, authorization, Undo journal, applicability and native records passed");
}

async function narrowPartitions() {
  const p=structuredClone(project), pcb=p.documents.find(d => d.id==="analog"), IQ=AtriumDesignQueryIndex;
  const edge=pcb.items.find(row => row.id==="rail-at-limit");
  edge.width=.2032;
  const scalarOrder=["\uE000","\u{10000}"];
  pcb.items.push(...scalarOrder.slice().reverse().map(id=>({...edge,id,net:"Ordering"})));
  U.reset(p);
  U.mark(p);
  const undo=[],redo=[],seq=()=>U.recordedChanges(pcb).seq;
  const options=()=>({project:p,documentId:pcb.id,enabled:true,store:U,revision:seq(),getRevision:seq});
  const source='track where width <= 8 mil and net.name = "Rail" and (layer = "Top" or width < 4 mil)';
  const fields=["width","net.name","layer"];
  const comparable=result => result.rows.map(row=>[row.id,{...row.fields}]);
  async function full() {
    const snap=structuredClone(p), doc=snap.documents.find(d=>d.id===pcb.id), ctx=AtriumDesignQuery.context(snap,doc);
    const {plan}=AtriumDesignQuery.compile(source,ctx);
    const all=doc.items.map(item=>({id:item.id,docId:doc.id,item,kind:ctx.kindOf(item)}));
    const result=await plan.run({rows:all},{fields});
    assert.equal(result.complete,true);
    return result;
  }
  let ctx=AtriumDesignQuery.context(p,pcb,{store:U,revision:seq()});
  const {plan}=AtriumDesignQuery.compile('part where designator = "TP1"',ctx);
  const parts=await IQ.documentIndex(p,pcb,ctx,plan,options());
  assert.equal(parts.lookup(IQ.idOf({docId:pcb.id,id:edge.id})),undefined,"Part searches leave track rows unprojected.");
  assert.equal((await plan.run(parts)).checked,1);
  assert.equal((await plan.run(parts)).checked,0);
  const pad=await Q.search('pad where component.designator = "TP1"',options());
  assert.ok(pad.rows.some(row=>row.id==="probe-edge/1/1"),JSON.stringify(pad));
  const all=await Q.search("object",{...options(),limit:100});
  assert.ok(all.rows.some(row=>row.id===edge.id) && all.rows.some(row=>row.id==="probe-edge/1/1"));

  const progress=[];
  const first=await Q.search(source,{...options(),fields,limit:1,onPage:page=>progress.push(page)});
  assert.equal(first.count,2);
  assert.equal(first.rows[0].fields.width.magnitude,.2032);
  assert.ok(progress.length>=2);
  assert.equal(progress[0].status,"counting");
  assert.equal(progress[0].lowerBound,1);
  for(const page of progress)assert.deepEqual(comparable(page),comparable(first));
  const next=await Q.search(source,{...options(),fields,limit:1,cursor:first.cursor});
  assert.deepEqual([...comparable(first),...comparable(next)],comparable(await full()));
  assert.equal(next.visited,0);
  const ordered=await Q.search('track where net.name = "Ordering"',{...options(),limit:1});
  const peer=await Q.search('track where net.name = "Ordering"',{...options(),limit:1,cursor:ordered.cursor});
  assert.deepEqual([...rows(ordered),...rows(peer)],scalarOrder,"Qualified IDs retain scalar-value order across the BMP boundary.");
  assert.equal(peer.cursor,null);

  const beforeWidth=U.mark(p);
  edge.width=.2;
  U.checkpoint(undo,redo,beforeWidth);
  U.record(p,{doc:pcb,items:[edge]});
  const expired=await Q.search(source,{...options(),fields,budget:{remaining:0,deadline:Infinity}});
  assert.equal(expired.status,"budget");
  const stopPatch=new AbortController();
  const cancelled=await Q.search(source,{...options(),fields,signal:stopPatch.signal,onProjection(){stopPatch.abort();}});
  assert.equal(cancelled.status,"cancelled");
  const patched=await Q.search(source,{...options(),fields,limit:1});
  assert.equal(patched.visited,1,"An interrupted delta must leave the known result available for retry.");
  assert.equal(patched.count,first.count);
  assert.equal(patched.rows[0].fields.width.magnitude,.2,"A retained match projects its changed fields.");
  const patchedNext=await Q.search(source,{...options(),fields,limit:1,cursor:patched.cursor});
  assert.equal(patchedNext.visited,0);
  assert.deepEqual([...comparable(patched),...comparable(patchedNext)],comparable(await full()));

  let prior=U.mark(p);
  edge.net="Renamed";
  U.checkpoint(undo,redo,prior);
  U.record(p,{doc:pcb,items:[edge]});
  const changed=await Q.search(source,{...options(),fields});
  assert.equal(changed.visited,1);
  assert.deepEqual(comparable(changed),comparable(await full()));
  assert.equal((await Q.search('track where net.name = "Renamed"',options())).count,1);
  assert.ok(U.jump(undo,redo,U.mark(p),-1));
  const undone=await Q.search(source,{...options(),fields,limit:1});
  assert.equal(undone.visited,1);
  const restoredNext=await Q.search(source,{...options(),fields,limit:1,cursor:undone.cursor});
  const restored=[...comparable(undone),...comparable(restoredNext)];
  assert.deepEqual(restored,comparable(await full()));
  prior=U.mark(p);
  const note={id:"new-note",kind:"graphic",layer:"Top Silk",shape:"text",x:0,y:0,text:"Review"};
  pcb.items.push(note);
  U.checkpoint(undo,redo,prior);
  U.record(p,{doc:pcb,items:[note]});
  const unrelated=await Q.search(source,{...options(),fields});
  assert.equal(unrelated.visited,0);
  assert.deepEqual(comparable(unrelated),restored);

  prior=U.mark(p);
  const thin=pcb.items.find(row=>row.id==="rail-thin");
  edge.width=thin.width=.25;
  U.checkpoint(undo,redo,prior);
  U.record(p,{doc:pcb,items:[edge,thin]});
  const bulk=await Q.search(source,{...options(),fields});
  assert.equal(bulk.visited,2);
  assert.equal(bulk.count,0);
  assert.deepEqual(comparable(bulk),comparable(await full()));
  assert.ok(U.jump(undo,redo,U.mark(p),-1));
  const bulkUndo=await Q.search(source,{...options(),fields});
  assert.equal(bulkUndo.visited,2);
  assert.deepEqual(comparable(bulkUndo),restored);

  let built=false;
  const stopped=await Q.search("track",{...options(),project:structuredClone(p),budget:{remaining:1000,deadline:-1},onProjection(){built=true;}});
  assert.equal(stopped.status,"budget");
  assert.equal(built,false);

  const abort=new AbortController();
  let inspected=0;
  ctx=AtriumDesignQuery.context(p,pcb,{authority:{canReadItem() {
    if(++inspected===128)abort.abort();
    return false;
  }}});
  const denied=AtriumDesignQuery.compile("track",ctx).plan;
  const deferred=await denied.run({rows:function*() {
    for(let i=0;i<5000;i++)yield {id:String(i),kind:"track",docId:pcb.id};
  }},{signal:abort.signal});
  assert.equal(deferred.diagnostic.code,"cancelled");
  assert.ok(inspected<256,"An all-denied projection must yield or cancel before visiting the remaining candidates.");
}

async function editedParity() {
  const p = structuredClone(project), pcb = p.documents.find(d => d.id === "analog"),
    child = p.documents.find(d => d.id === "power"), parent = p.documents.find(d => d.id === "monitor");
  const repeat = {id:"repeat",kind:"sheetsymbol",sheet:child.id,name:"Repeat(CH,1,2)",x:0,y:0,w:20,h:10,entries:[]};
  const plus = {id:"plus",kind:"directive",net:"Pair+",signal:"Data",polarity:1};
  const minus = {id:"minus",kind:"directive",net:"Pair-",signal:"Data",polarity:-1};
  parent.items.push(repeat,plus,minus);
  p.parameters = {Pitch:{value:12,unit:"mil"}};
  U.reset(p);
  const h = [], f = [];
  const edit = (doc,items,fn) => {
    const before = U.mark(p);
    fn(); U.checkpoint(h,f,before);
    U.record(p,{doc,items});
  };
  const run = (source,doc,fields,instanceId) => Q.search(source,{project:p,enabled:true,documentId:doc.id,fields,instanceId,
    revision:U.recordedChanges(pcb).seq});
  const cold = (source,doc,fields,instanceId) => Q.search(source,{project:structuredClone(p),enabled:true,documentId:doc.id,fields,instanceId});
  const probes = ["track where paired", 'track where signal.name = "Data"', 'track where polarity = "+"'];
  const signalCounts = async expected => {
    for (const [i,source] of probes.entries()) {
      const live = await run(source,pcb,["signal.name","polarity","paired"]);
      const fresh = await cold(source,pcb,["signal.name","polarity","paired"]);
      assert.equal(live.count,expected[i],JSON.stringify(live));
      assert.deepEqual(live.rows,fresh.rows);
    }
  };
  await signalCounts([2,2,1]);
  edit(parent,[minus],() => parent.items.splice(parent.items.indexOf(minus),1));
  await signalCounts([0,0,0]);
  assert.ok(U.jump(h,f,U.mark(p),-1));
  await signalCounts([2,2,1]);
  assert.ok(U.jump(h,f,U.mark(p),1));
  await signalCounts([0,0,0]);

  const one = "monitor/repeat#0", two = "monitor/repeat#1", fields = ["designator","value","Pitch"];
  const projected = await run("part",child,fields,one);
  assert.deepEqual(projected.rows, (await cold("part",child,fields,one)).rows);
  assert.equal((await run('part where designator = "R1_CH1"',child,fields,one)).count,1);
  assert.equal((await run('pin where component.designator = "R1_CH2"',child,["designator"],two)).count,2);
  const r = projected.rows.find(item => item.id === "r-small");
  const c = projected.rows.find(item => item.id === "c-small");
  assert.equal(r.instanceId,one);
  assert.equal(r.fields.designator,"R1_CH1");
  assert.equal(r.fields.value.unit,"Ω");
  assert.equal(r.fields.value.magnitude,470);
  assert.equal(c.fields.value.unit,"F");
  assert.ok(Math.abs(c.fields.value.magnitude - 470e-9) < 1e-18);
  assert.equal(r.fields.Pitch.unit,"mil");
  assert.ok(Math.abs(r.fields.Pitch.magnitude - 12) < 1e-12);

  const global = await Q.save({name:"Any track",query:"track"},{project:p,enabled:true});
  const saved = await Q.save({name:"First occurrence",query:"part",scope:{documentId:child.id,instanceId:one}},{project:p,enabled:true});
  assert.equal(saved.result.complete,true,JSON.stringify(saved.result));
  assert.equal(global.result.complete,true,JSON.stringify(global.result));
  p.savedQueries = [global.result.record,saved.result.record];
  const savedQuery = {savedQueryId:saved.result.record.id};
  assert.equal((await Q.search({savedQueryId:global.result.record.id},{project:p,enabled:true,documentId:pcb.id})).count,
    (await run("track",pcb)).count);
  assert.deepEqual((await Q.search(savedQuery,{project:p,enabled:true,fields})).rows,projected.rows);
  assert.equal((await Q.search(savedQuery,{project:p,enabled:true,documentId:child.id,instanceId:two})).diagnostic.code,"scope");

  edit(parent,[repeat],() => {repeat.name = "Repeat(ALT,1,2)";});
  assert.equal((await run('part where designator = "R1_CH1"',child,fields,one)).count,0);
  const renamed = await run('part where designator = "R1_ALT1"',child,fields,one);
  assert.equal(renamed.count,1);
  assert.deepEqual(renamed.rows,(await cold('part where designator = "R1_ALT1"',child,fields,one)).rows);
  assert.ok(U.jump(h,f,U.mark(p),-1));
  assert.equal((await run('part where designator = "R1_CH1"',child,fields,one)).count,1);
  const before = U.mark(p);
  p.multichannel = {naming:"index"};
  U.checkpoint(h,f,before); U.record(p,{project:true});
  assert.equal((await run('part where designator = "R101"',child,fields,one)).count,1);
  assert.equal((await run('part where designator = "R1_CH1"',child,fields,one)).count,0);
}

function ruleParity() {
  const p = structuredClone(project), pcb = p.documents.find(d => d.id === "analog");
  const {AtriumERC:E,AtriumStackup:S} = globalThis;
  const local = p.rules.list.find(r => r.id === "low-ohms");
  local.priority = 2;
  p.rules.list.unshift({...local,id:"fallback",name:"All disconnects",priority:1,scope:rc("object"),severity:"warning",sheets:undefined});
  const full = E.run(p,{calculationSnapshot:null}).messages.filter(i => i.check === "unconnectedPins" && i.documentId === "power");
  for (const [rule,severity] of [["low-ohms","Fatal"],["fallback","Warning"]]) {
    const preview = Q.applicability(rule,{project:p,documentId:"power",enabled:true});
    assert.equal(preview.complete,true,JSON.stringify(preview));
    assert.deepEqual(preview.violations.map(i => [i.id,i.signature,i.severity]),
      full.filter(i => i.class === severity).map(i => [i.objectId,i.sig,i.class]));
  }
  assert.equal(Q.applicability("local-rail",{project:p,documentId:"control",enabled:true}).status,"missing");

  pcb.stackup = S.preset("4");
  const copper = pcb.stackup.layers.map((layer,i) => S.isCopper(layer) ? i : null).filter(i => i != null);
  const dielectric = pcb.stackup.layers.slice(copper[0]+1,copper[1]);
  for (const layer of dielectric) layer.thickness = .05 / dielectric.length;
  pcb.items.push(
    {id:"z-a",kind:"track",net:"Z1",layer:"Top",width:.2,points:[[21,10],[29,10]]},
    {id:"z-b",kind:"track",net:"Z2",layer:"Inner 1",width:.2,points:[[25,8],[25,12]]},
    ...["a","b"].map((name,i) => ({id:"via-"+name,kind:"via",x:50,y:45+i*.3,diameter:.4,drill:.2,net:"Via"+name})));
  p.rules.list.push(
    {id:"z",type:"zClearance",name:"Z gap",enabled:true,priority:1,scope:rc("track"),gap:.1,adjacentOnly:true},
    {id:"holes",type:"holeToHole",name:"Hole gap",enabled:true,priority:1,scope:rc("via"),gap:.2});
  const defs = new Map(p.library.map(d => [d.id,d]));
  for (const [id,type,pair] of [["z","zClearance",["z-a","z-b"]],["holes","holeToHole",["via-a","via-b"]]]) {
    const opts = {project:p,documentId:pcb.id,enabled:true};
    const preview = Q.applicability(id,opts);
    assert.equal(preview.complete,true,JSON.stringify(preview));
    assert.ok(preview.pairs.rows.some(objects => objects.map(row => row.id).join() === pair.join()),JSON.stringify(preview.pairs));
    const direct = R.drc(pcb,defs,R.stored(pcb,p),{project:p,types:[type]});
    const simplify = v => [v.id,v.otherId,v.actual,v.required];
    assert.deepEqual(preview.violations.map(simplify),direct.violations.filter(i => i.ruleId === id).map(simplify));
    assert.ok(preview.violations.length > 0);
  }
  const have = globalThis.AtriumZClearance;
  delete globalThis.AtriumZClearance;
  try {
    const partial = Q.applicability("z",{project:p,documentId:pcb.id,enabled:true});
    assert.equal(partial.status,"partial");
    assert.equal(partial.coverage,"scope-only");
  } finally { globalThis.AtriumZClearance = have; }
}
main().catch(error => {console.error(error);process.exitCode = 1;});
