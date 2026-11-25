"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {appFile} = require("../support/app-source-paths.cjs");
for (const name of ["uuid-v7","model","source-file","format-2-codec","format-2-units","format-2-values",
  "format-2-model","parts","pcb-draw","altium-rules","component-classes","stackup","board-shape","net-intent",
  "signals","rules","project-rules","dfa","length-tuning","sch-objects","hierarchy","multichannel","net-ties",
  "messages","erc","design-query","undo-store","proposal","query","butter-query-service","viastack","z-clearance",
  "search-index","pcb-edit","pcb-appearance","nav-common","crossprobe"])
  require(appFile(name + ".js"));

const M = AtriumFormat2Model, S = AtriumQueryService, F = AtriumQuery;
const fixture = path.join(__dirname,"../fixtures/design-query/query-proof");
const read = file => M.parse(fs.readFileSync(path.join(fixture,file)));
const {project,members} = M.manifest(read("Query proof.waffle"));
for (const member of members) {
  const file = read(member.path);
  if (member.kind === "library") project.library.push(M.library(file));
  else project.documents.push(M.document(file,{name:member.name}));
}
const definitions = p => new Map(p.library.map(d => [d.id,d]));
const ids = rows => rows.map(row => row.id).sort();
const board = project.documents.find(d => d.id === "analog");
const options = {project,documentId:board.id,enabled:true,revision:"fixture"};
const exact = 'track in net "Rail"';
const railIds = ["rail-at-limit","rail-thin","rail-wide"];

async function matching() {
  assert.deepEqual(F.run(project,board,exact).ids.sort(),railIds,"native Filter matches exact net spelling");
  const exactResult = await S.search(exact,options);
  assert.equal(exactResult.complete,true);
  assert.deepEqual(ids(exactResult.rows),railIds);
  const filter = await F.runIndexed(project,board,exact,options);
  assert.equal(filter.complete,true);
  assert.deepEqual(filter.ids.sort(),railIds);
  const classic = "IsTrack And InNet('Rail')";
  const cases = ["lowercase-rail",...railIds];
  assert.deepEqual(F.run(project,board,classic).ids.sort(),cases,"Classic InNet preserves its case folding");
  assert.deepEqual((await F.runIndexed(project,board,classic,options)).ids.sort(),cases);

  const fuzzy = AtriumSearchIndex.create();
  AtriumSearchIndex.runNow(fuzzy.sync(project,definitions(project)));
  const found = fuzzy.search("RIAL",{kinds:new Set(["net"]),limit:20}).map(hit=>hit.rec.key).sort();
  assert.deepEqual(found.filter(key => /^net:rail$/i.test(key)),["net:Rail","net:rail"]);
  const zero = await S.search('track where width <= 0.2 and net.name = "RAIL"',{...options,suggestions:true});
  assert.equal(zero.count,0);
  assert.deepEqual(zero.summaries.flatMap(s=>s.suggestions.map(r=>r.value)).sort(),["Rail","rail"]);
  const local = 'track where width <= 0.2 and net.name = "Rail"';
  const indexed = await S.search(local,options);
  const repeated = await F.runIndexed(project,board,local,options);
  assert.deepEqual(repeated.ids.sort(),ids(indexed.rows));
  assert.equal(repeated.visited,0,"an identical native Filter reuses the warm Query membership");
}

async function schematicNets() {
  const doc = {id:"labels",kind:"schematic",items:[
    {id:"capital",kind:"wire",points:[[0,0],[10,0]]},{id:"capital-label",kind:"netlabel",x:10,y:0,text:"Rail"},
    {id:"lower",kind:"wire",points:[[0,20],[10,20]]},{id:"lower-label",kind:"netlabel",x:10,y:20,text:"rail"},
    {id:"annotation",kind:"label",x:30,y:10,text:"Assembly only"}
  ]};
  const project = {id:"schematic-nets",documents:[doc],library:[]};
  const opts = {project,documentId:doc.id,enabled:true,revision:1};
  const relation = 'wire in net "Rail"', field = 'wire where net.name = "Rail"';
  for(const source of [relation,field]) {
    assert.deepEqual(F.run(project,doc,source).ids,["capital"]);
    assert.deepEqual((await F.runIndexed(project,doc,source,opts)).ids,["capital"]);
    assert.deepEqual(ids((await S.search(source,opts)).rows),["capital"]);
  }
  assert.deepEqual(F.run(project,doc,"IsWire And InNet('Rail')").ids,["capital","lower"]);
  assert.deepEqual(ids((await S.search('net where name = "Rail"',opts)).rows),["net/Rail"]);
  assert.deepEqual(ids((await S.search("net",opts)).rows),["net/Rail","net/rail"]);
  const authority = {documentIds:new Set([doc.id]),canReadItem:id=>id==="capital"};
  for(const source of [relation,field]) {
    const restricted = await S.search(source,{...opts,authority});
    assert.equal(restricted.status,"denied");
    assert.equal(restricted.rows,undefined);
  }
}

async function terminals() {
  const flipped = structuredClone(project), doc = flipped.documents.find(d => d.id === board.id);
  const point = doc.items.find(item => item.ref === "TP1");
  assert.deepEqual(AtriumPCBEdit.flip(doc,flipped,[point.id]),[point]);
  const defs = definitions(flipped), geometry = Atrium.pins(point,defs.get(point.def),"pcb");
  assert.deepEqual(geometry.map(pad=>AtriumPCBAppearance.padLayer(point,pad)),["Top","Multi"]);
  for (const [layer,slots] of [["Top",[0,1]],["Bottom",[1]]]) {
    const source = 'pad where on layer ' + layer + ' and component.designator = "TP1"';
    const opts = {...options,project:flipped,revision:"flipped"};
    assert.deepEqual(F.run(flipped,doc,source).subs.map(row => row.padIndex),slots,"Filter uses physical layers after Flip");
    const filter = await F.runIndexed(flipped,doc,source,opts), query = await S.search(source,opts);
    assert.equal(filter.complete && query.complete,true);
    assert.deepEqual(filter.subs.map(r=>[r.id,r.padIndex,r.ownerId]),query.rows.map(r=>[r.id,r.padIndex,r.ownerId]));
    const row = query.rows.find(entry=>entry.padIndex===1), hit = AtriumCrossProbe.resolveLocal(doc,defs,row);
    const [x,y]=geometry[1].at;
    assert.deepEqual([(hit.box[0]+hit.box[2])/2,(hit.box[1]+hit.box[3])/2],[x,y]);
  }

  const sheet = {id:"s",kind:"schematic",items:[{kind:"part",id:"symbol",def:"dup",ref:"J1",x:10,y:10,angle:0}]},
    duplicated = {id:"dup",symbol:{pins:[{number:"1",x:0,y:0},{number:"1",x:30,y:0}]}},
    schematic = {id:"repeated",documents:[sheet],library:[duplicated]};
  const [first,second] = (await S.search("pin",{project:schematic,enabled:true,revision:1,documentId:sheet.id})).rows;
  assert.equal(first.pin,second.pin);
  assert.notEqual(first.id,second.id);
  const local = AtriumCrossProbe.resolveLocal(sheet,definitions(schematic),second);
  assert.equal((local.box[0]+local.box[2])/2,40,"exact repeated schematic pin frames its own geometry");
}

async function netNavigation() {
  const def = definitions(project), net = (await S.search('net where name = "Rail"',options)).rows[0];
  // Exercise the Query panel's actual result activation with an in-memory editor host.
  globalThis.AtriumLazy = {register() {}};
  require(appFile("butter-intel-ui.js"));
  const actions = [];
  globalThis.AtriumNavHost = {project:()=>project, currentId:()=>board.id, doc:()=>board, defs:()=>def,
    info:message=>actions.push(["info",message]), select:ids=>actions.push(["select",ids.sort()]),
    setHighlight:net=>actions.push(["highlight",net]),zoomTo:()=>actions.push(["zoom"])};
  assert.deepEqual(await AtriumIntelUI.probe(net),{status:"found",label:"Rail"});
  assert.deepEqual(actions,[["select",railIds],["highlight","Rail"],["zoom"]],"net probe uses exact member IDs, highlight and camera");

  const unwired = structuredClone(project);
  const unwiredBoard = unwired.documents.find(d=>d.id===board.id);
  unwired.library.push({id:"unassigned",footprint:{pads:[{number:"1",x:0,y:0,w:1,h:1,net:"Library fallback"}]}});
  unwiredBoard.items.push({id:"unassigned-1",kind:"part",def:"unassigned",ref:"TP9",x:100,y:0});
  const found = await S.search('net where name = "Library fallback"',{...options,project:unwired});
  assert.equal(found.count,0,"unassigned placement library defaults are outside the board net scope");
}

async function cancelled() {
  const controller = new AbortController(), pages = [];
  const result = await S.search("track",{...options,limit:1,signal:controller.signal,onPage(page) {
    pages.push(page);
    controller.abort();
  }});
  assert.equal(pages.length,1);
  assert.equal(pages[0].status,"counting");
  assert.equal(pages[0].lowerBound,1);
  assert.equal(result.status,"cancelled");
  assert.equal(result.rows,undefined);
  const firstPage = await S.search(exact,{...options,limit:1});
  assert.equal(firstPage.count,3);
  assert.equal(firstPage.rows.length,1);
  assert.ok(firstPage.cursor);
  assert.equal((await S.search(exact,{...options,revision:"next",limit:1,cursor:firstPage.cursor})).status,"stale");
  const budget = await F.runIndexed(project,board,exact,{...options,maxSteps:1});
  assert.equal(budget.complete,false);
  assert.equal(budget.truncated,true);
}

(async () => {
  const cases = {matching,schematicNets,terminals,netNavigation,cancelled};
  if (process.argv[2]) await cases[process.argv[2]]();
  else for (const test of Object.values(cases)) await test();
  console.log("PASS shared search projection, exact and fuzzy matching, physical terminals, net navigation and bounded execution");
})().catch(error=>{console.error(error);process.exitCode=1;});
