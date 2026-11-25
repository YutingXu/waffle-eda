"use strict";

const assert = require("node:assert/strict");
for (const name of ["uuid-v7","model","link-record","design-query-record","calculation-records","datasheet-record","links","undo-store","proposal","butter","butter-links"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const A = globalThis.Atrium, L = globalThis.AtriumLinks, B = globalThis.AtriumButter, U = globalThis.AtriumUndoStore;
const descriptors = require("../../app/automation/descriptors/links.json").commands;
const project = A.project("Project links", []);
const [sheet, board] = project.documents;
const part = {id:A.id(),kind:"part",ref:"U1",def:A.id(),x:4,y:8,pinNets:{}};
project.library.push({id:part.def,kind:"library",name:"Probe",symbol:{pins:[{id:A.id(),number:"1",name:"Input",x:0,y:2}],shapes:[]}});
const wire = {id:A.id(),kind:"wire",points:[[2,2],[3,2]]};
const track = {id:A.id(),kind:"track",net:"Rail",layer:"Top",width:.18,points:[[3,4],[6,4]]};
const note = {id:A.id(),kind:"textframe",x:4,y:12,w:20,h:6,size:1.5,text:"Initial note"};
sheet.items.push(part,wire,note);
board.items.push(track);
const url = L.format({projectId:project.id,objectId:part.id});
const address = L.parse(url);
assert.deepEqual(address, {projectId:project.id,objectId:part.id});
assert.equal(L.parse(url + "#datasheet:page=9007199254740991").fragment, "datasheet:page=9007199254740991");
assert.throws(() => L.format({...address,fragment:"datasheet:page=1\n"}),/valid/);
for (const suffix of ["?path=/tmp/project.waffle", "/", "\n", "#datasheet:page=0", "#datasheet:page=9007199254740992", "%00", "#file:///tmp"])
  assert.equal(L.parse(url + suffix), null, suffix);
assert.equal(L.parse(url.replace("waffle://", "waffle:///")), null);
assert.equal(L.parse(url.replace("waffle://", "waffle://user@")), null);
assert.deepEqual(L.extract("Compare [" + url + "] with " + url + "?bad=true"), [address]);

const record = L.authoredRecord({objectId:note.id,documentId:sheet.id,kind:"richtext"}, address, " Input ");
project.links = {[record.id]:record};
let index = L.fromProject(project);
assert.equal(L.resolve(project, address, index).target.label,"U1");
assert.equal(index.backlinks(address).length,1);
assert.equal(L.resolve(A.project("A different folder",[]), address).status,"missing-project");

const base = U.mark(project);
let events = 0;
const off = U.onAuthored((records, dir, live) => {events++; index = L.update(index,live,records,dir);});
note.text = "Read also " + url;
U.record(project,{doc:sheet,items:[note]});
assert.equal(index.backlinks(address).length,2);
part.ref = "U27";
U.record(project,{doc:sheet,items:[part]});
assert.equal(L.resolve(project,address,index).target.label,"U27");
sheet.items.splice(sheet.items.indexOf(part),1);
board.items.push(part);
U.record(project,[{doc:sheet,items:[part]},{doc:board,items:[part]}]);
assert.equal(L.resolve(project,address,index).target.documentId,board.id);
board.items.push({...part});
U.record(project,{doc:board,items:[part]});
// Bad imports can carry repeated IDs in different owners. Resolution must distinguish them.
index.put({owner:sheet.id,objectId:part.id,documentId:sheet.id,kind:"part",label:"Copy"});
assert.equal(L.resolve(project,address,index).status,"ambiguous");
index.remove(sheet.id,part.id);
U.rollback(base);
assert.ok(events >= 4);
assert.equal(L.resolve(project,address,index).target.documentId,sheet.id);
assert.equal(L.resolve(project,address,index).target.label,"U1");
assert.equal(index.backlinks(address).length,1);
off();

const pin = L.anchorPlan(project,{kind:"pin",documentId:sheet.id,ownerId:part.id,terminal:"1"});
const net = L.anchorPlan(project,{kind:"net",documentId:board.id,ownerId:track.id});
const unnamed = L.anchorPlan(project,{kind:"net",documentId:sheet.id,ownerId:wire.id});
assert.ok(pin.created && net.created && unnamed.created);
project.linkAnchors = Object.fromEntries([pin,net,unnamed].map(result => [result.anchor.id,result.anchor]));
assert.equal(L.anchorPlan(project,{kind:"pin",documentId:sheet.id,ownerId:part.id,terminal:"1"}).anchor.id,pin.anchor.id);
track.net = "Power";
const terminal = project.library[0].symbol.pins[0];
terminal.number = "A"; terminal.name = "Signal";
assert.equal(L.resolve(project,pin.url).target.label,"U1 · Signal");
assert.equal(L.resolve(project,net.url).target.label,"Power");
assert.equal(L.resolve(project,unnamed.url).target.kind,"net");
project.library[0].symbol.pins.length = 0;
assert.equal(L.resolve(project,pin.url).status,"missing-object");
const indexed = L.fromProject(project);
L.gitReferences(indexed,[{revision:"d".repeat(40),subject:"Review",message:"Body " + url}]);
assert.ok(indexed.backlinks(address).some(row => row.source.kind === "commit"));
L.gitReferences(indexed,[{revision:"d".repeat(40),message:"Replacement with no link"}]);
assert.ok(indexed.backlinks(address).every(row => row.source.kind !== "commit"));
const run = (id,args,mode) => {
  const spec = descriptors.find(spec => spec.id === id);
  return B.invoke("links",spec,args,{project,source:"mcp",mode,allowWrite:mode === "write",scope:project,
    documentId:sheet.id,selection:[part.id]},(receipt,result) => ({...receipt,...result}));
};
assert.equal(run("resolve",{url},"read").result.status,"found");
assert.deepEqual(run("backlinks",{url},"read").result.rows[0].source,record.source);
assert.equal(run("copy-link",{},"plan").result.url,url);
assert.equal(run("copy-link",{},"write").result.copied,false);
assert.equal(run("open",{url},"write").result.opened,false);
assert.equal(run("list",{},"read").result.total,1);
assert.equal(run("status",{recordId:record.id},"read").result.status,"found");
const proposal = run("create",{sourceId:note.id,url},"proposal");
assert.equal(proposal.ops.length,1);
assert.ok(L.validRecord(proposal.result.record));
const newTarget = L.format({projectId:project.id,objectId:track.id});
assert.equal(run("rebind",{recordId:record.id,url:newTarget},"proposal").ops[0].after.target.objectId,track.id);
assert.equal(run("remove",{recordId:record.id},"proposal").ops[0].after,undefined);
assert.equal(run("anchor",{kind:"net",documentId:board.id,ownerId:track.id},"proposal").ops.length,0);

// Identity-only commands share the full index's owner and duplicate-ID rules.
// They must see live edits and need only the IDs of unrelated rows.
{
  const duplicateName = {id:A.id(),kind:"part",ref:part.ref};
  board.items.push(duplicateName);
  const duplicateText = {id:A.id(),kind:"textframe",text:"Unrelated"};
  board.items.push(duplicateText);
  const probes = [address, L.parse(net.url), {projectId:project.id,objectId:duplicateName.id}];
  const parity = () => {
    const full = L.fromProject(project);
    for (const target of probes) {
      assert.deepEqual(L.resolve(project,target),L.resolve(project,target,full));
      assert.deepEqual(L.resolve(project,target,undefined,{complete:false}),L.resolve(project,target,full,{complete:false}));
    }
  };
  parity();
  assert.equal(L.resolve(project,address).target.label,L.resolve(project,probes.at(-1)).target.label);
  duplicateName.id = part.id;
  parity();
  assert.equal(run("resolve",{url},"read").result.status,"ambiguous");
  duplicateName.id = A.id();
  const oldId = part.id;
  part.id = A.id();
  parity();
  assert.equal(run("resolve",{url},"read").result.status,"missing-object");
  assert.equal(run("status",{recordId:record.id},"read").result.status,"missing-object");
  part.id = oldId;
  Object.defineProperty(duplicateText,"text",{get(){throw Error("Point lookup read an unrelated note");}});
  assert.equal(run("resolve",{url},"read").result.status,"found");
  assert.equal(run("status",{recordId:record.id},"read").result.status,"found");
  assert.equal(run("copy-link",{},"plan").result.url,url);
  assert.equal(run("open",{url},"plan").result.status,"found");
  board.items.splice(-2,2);
}

// Page through the persisted and Git buckets in the existing sort order.
{
  const commits = ["b","a"].map(letter=>({revision:letter.repeat(40),subject:letter,recordLinks:[url]}));
  const fixture = L.fromProject(project), git = L.createIndex(project.id);
  git.importCommits(commits);
  const expected = [...fixture.backlinks(address),...git.backlinks(address)];
  const command = descriptors.find(row=>row.id==="backlinks");
  for (const offset of [0, 1, 2, 3, 12]) {
    const page = B.invoke("links",command,{url,offset,limit:2,includeGit:true},{project,source:"mcp",scope:project,
      native:{status:"ready",commits}},receipt=>receipt.result);
    assert.equal(page.total,expected.length);
    assert.deepEqual(page.rows,expected.slice(offset,offset+2));
  }
}

{
  const datasheet = {id:A.id(),title:"Input ratings",sha256:"a".repeat(64),byteLength:400,pageCount:2};
  project.datasheets = [datasheet];
  const base = {projectId:project.id,objectId:datasheet.id};
  const link = page => ({...base,fragment:"datasheet:page="+page});
  const otherProject = {...project,id:A.id()};
  const [page, missing] = L.resolveTargets(project,[link(2),link(3)]);
  assert.deepEqual(page,L.resolve(project,link(2),L.fromProject(project)));
  assert.equal(page.target.page,2);
  assert.equal(page.target.verification,"known");
  assert.equal(missing.status,"missing-fragment");
  assert.equal(run("resolve",{url:L.format(link(2))},"read").result.target.page,2);
  assert.equal(run("resolve",{url:L.format({...link(2),projectId:otherProject.id})},"read").result.status,"missing-project");
  const source = {projectId:project.id,objectId:part.id};
  const [located] = L.resolveTargets(project,[source]);
  located.target.point[0] = -99;
  assert.equal(L.resolve(project,source).target.point[0],part.x);
  assert.deepEqual(L.resolve(project,source,L.fromProject(otherProject)),L.resolve(project,source));
  delete project.datasheets;

  B.register("linksAuthorityProbe",{inspect(_,context) {
    assert.equal(context.services.resolveLinkTargets,undefined);
    assert.throws(()=>{context.project.documents[0].name="Modified";},/read-only/);
    return {};
  }});
  B.invoke("linksAuthorityProbe",{id:"inspect",kind:"read",properties:{}},{},{project,scope:project,source:"mcp"},receipt=>receipt);
}

// The stored relation plans and the indexed journal must agree in both directions.
{
  const P = AtriumProposal, history = [], future = [];
  let cached = L.fromProject(project);
  const stop = U.onAuthored((rows,dir,live) => {cached = L.update(cached,live,rows,dir);});
  const step = (command,args) => {
    const before = U.mark(project);
    const {ops} = run(command,args,"proposal");
    P.apply(project,P.guarded(project,"butter.links."+command,ops));
    U.checkpoint(history,future,before);
    U.record(project);
  };
  const checked = (oldCount,newCount) => {
    const fresh = L.fromProject(project), target = L.parse(newTarget);
    assert.deepEqual(cached.backlinks(address),fresh.backlinks(address));
    assert.deepEqual(cached.backlinks(target),fresh.backlinks(target));
    assert.equal(cached.backlinks(address).length,oldCount);
    assert.equal(cached.backlinks(target).length,newCount);
  };
  step("rebind",{recordId:record.id,url:newTarget});
  checked(0,1);
  step("remove",{recordId:record.id});
  checked(0,0);
  assert.ok(U.jump(history,future,U.mark(project),-1));
  checked(0,1);
  assert.ok(U.jump(history,future,U.mark(project),-1));
  checked(1,0);
  assert.ok(U.jump(history,future,U.mark(project),2));
  checked(0,0);
  stop();
}

// One unrelated sibling is a trap: an incremental journal update must not read it.
const large = A.project("50,000 backlink sources", []);
const largeDoc = large.documents[0];
for (let i = 0; i < 50000; i++) largeDoc.items.push({id:A.id(),kind:"textframe",text:i % 500 === 0 ? url : "Unrelated"});
const coldStart = performance.now(), largeIndex = L.fromProject(large), buildMs = performance.now() - coldStart;
Object.defineProperty(largeDoc.items.at(-1),"text",{get(){throw Error("An unrelated note was read");}});
const first = largeDoc.items[0], start = performance.now(), before = largeIndex.stats();
L.update(largeIndex,large,[{t:"e",node:{path:"items",doc:{ref:largeDoc}},ref:first,
  before:JSON.stringify(first),after:JSON.stringify({...first,text:"One edited source"})}],1);
const editMs = performance.now()-start, after = largeIndex.stats();
assert.equal(after.records-before.records,1);
assert.equal(largeIndex.backlinks(address).length,99);
console.log(`Links passed: address, edit/Undo/move, ambiguous/missing, pins/nets and 50,000 sources in ${buildMs.toFixed(2)} ms, one touched row in ${editMs.toFixed(3)} ms.`);

async function authoredBacklinkParity() {
  require("../../app/checks/design-query.js");
  require("../../app/checks/query-service.js");
  const Q = globalThis.AtriumQueryService, P = globalThis.AtriumProposal;
  const design = A.project("Query backlink parity", []);
  const doc = design.documents[0], definition = {id:A.id(),name:"Resistor",prefix:"R",symbol:{shapes:[],pins:[]}};
  design.library.push(definition);
  const [r1, r2] = [1,2].map(n => ({id:A.id(),kind:"part",x:n,y:0,def:definition.id,ref:"R"+n,value:(n * 10)+" Ω"}));
  doc.items.push(r1,r2);
  const target = objectId => ({projectId:design.id,objectId});
  const edit = (ops, hint) => {
    const before = U.mark(design);
    P.apply(design,P.guarded(design,"butter.query.save-query",ops));
    U.checkpoint(history,future,before);
    U.record(design,hint);
  };
  const targets = [r1.id,r2.id,doc.id];
  const parity = () => {
    const cold = L.fromProject(design);
    for (const objectId of targets) assert.deepEqual(live.backlinks(target(objectId)),cold.backlinks(target(objectId)));
  };
  const kinds = objectId => live.backlinks(target(objectId)).map(edge => edge.source.kind).sort();
  const history = [], future = [];
  U.reset(design);
  let live = L.fromProject(design);
  const stop = U.onAuthored((rows, direction, project) => {live = L.update(live, project, rows, direction);});
  const opts = {project:design,enabled:true};
  const first = await Q.save({name:"Reference R1",query:"resistor where value < R1.Value",scope:{documentId:doc.id}},opts);
  assert.equal(first.result.status,"complete",JSON.stringify(first.result));
  const savedId = first.result.record.id;
  edit(first.ops);
  parity();
  assert.deepEqual(kinds(r1.id),["savedQuery"]);
  assert.deepEqual(kinds(doc.id),["savedQuery"]);
  assert.equal(Q.references(design,{enabled:false}).status,"disabled");
  assert.equal(L.fromProject(design).backlinks(target(r1.id)).length,1);

  const savedQuery = first.result.record.query;
  const binding = savedQuery.bindings[0];
  const view = {id:A.id(),name:"Inspect R1",documentId:doc.id,selection:[r1.id],filter:{scope:{savedQueryId:savedId}}};
  const inlineView = {id:A.id(),name:"Inline filter",documentId:doc.id,selection:[],filter:{scope:savedQuery}};
  const rule = {id:A.id(),type:"width",name:"Reference",scope:savedQuery};
  const callout = {id:A.id(),kind:"textframe",text:"Callout",callout:{anchor:{docId:doc.id,itemId:r1.id,at:[1,0]}}};
  const calc = {id:A.id(),kind:"textframe",text:"R1.Value",calculation:{languageVersion:1,bindings:[binding],
    assertions:[{id:A.id(),source:"R2.Value > 5 Ω",bindings:[{...binding,target:{...binding.target,itemId:r2.id}}]}]}};
  const note = {id:A.id(),kind:"textframe",text:"Field",richText:{blocks:[{runs:[{type:"field",expression:"R1.Value",binding:binding.target}]}]}};
  doc.items.push(callout,calc,note);
  design.rules = {list:[rule]};
  design.savedViews = [view,inlineView];
  U.record(design);
  parity();
  assert.deepEqual(kinds(r1.id),["calculation","callout","richtext","rule","savedQuery","savedView","savedView"]);
  assert.deepEqual(kinds(r2.id),["calculation"]);
  assert.deepEqual(kinds(savedId),["savedView"]);
  assert.equal(live.backlinks(target(r1.id)).find(row=>row.source.objectId===callout.id).field,"anchor");
  assert.equal(live.backlinks(target(r1.id)).find(row=>row.source.objectId===inlineView.id).field,"filter");
  assert.equal(live.backlinks(target(r2.id))[0].field,"assertion");

  const rebound = await Q.save({id:savedId,query:"resistor where value < R2.Value"},opts);
  assert.equal(rebound.result.status,"complete",JSON.stringify(rebound.result));
  edit(rebound.ops);
  parity();
  assert.equal(kinds(r1.id).includes("savedQuery"),false);
  assert.equal(kinds(r2.id).includes("savedQuery"),true);
  assert.ok(U.jump(history,future,U.mark(design),-1));
  parity();
  assert.equal(kinds(r1.id).includes("savedQuery"),true);
  assert.ok(U.jump(history,future,U.mark(design),1));
  parity();
  assert.equal(kinds(r2.id).includes("savedQuery"),true);

  doc.items.splice(doc.items.indexOf(r2),1);
  U.record(design,{doc,items:[r2]});
  parity();
  assert.equal(L.resolve(design,target(r2.id),live).status,"missing-object");
  assert.equal(kinds(r2.id).includes("savedQuery"),true);
  edit(Q.remove(savedId,opts).ops);
  parity();
  assert.equal(kinds(r2.id).includes("savedQuery"),false);
  assert.ok(U.jump(history,future,U.mark(design),-1));
  parity();
  assert.equal(kinds(r2.id).includes("savedQuery"),true);
  stop();
}

async function nativeTerminalAndRelease() {
  for (const name of ["source-file","format-2-codec","format-2-units","format-2-values","format-2-model","folder-project-engine","revisions","library-panel"])
    require(require("../support/app-source-paths.cjs").appFile(name+".js"));
  const F = AtriumFormat2, M = AtriumFormat2Model;
  const p = A.project("Native links", []);
  const def = {id:A.id(),name:"Terminal",symbol:{shapes:[],pins:[{number:"1",name:"Original",x:0,y:2}]}};
  const instance = {id:A.id(),kind:"part",ref:"U1",def:def.id,x:0,y:0};
  const doc = p.documents[0];
  doc.items.push(instance);
  let stored = M.parse(F.serialize(M.createLibrary(def)));
  p.library.push(M.library(stored));
  const anchor = L.anchorPlan(p,{kind:"pin",documentId:doc.id,ownerId:instance.id,terminal:"1"}).anchor;
  assert.equal(anchor.terminalId,[...stored.records()].find(row=>row.kind==="pin").id);
  p.linkAnchors = {[anchor.id]:anchor};
  const copyDef = {...structuredClone(p.library[0]),id:A.id(),name:"Copied terminal"};
  const copied = M.createLibrary(copyDef);
  assert.notEqual([...copied.records()].find(row=>row.kind==="pin").id,anchor.terminalId);
  assert.equal(L.resolve(p,{projectId:p.id,objectId:anchor.id}).target.label,"U1 · Original");
  const target = {projectId:p.id,objectId:anchor.id};
  const model = AtriumLibrary.symbolModel(p.library[0].symbol);
  model.pins[0].number = "2";
  p.library[0].symbol = AtriumLibrary.buildSymbol(model).symbol;
  p.library[0].symbol.pins.unshift({number:"1",name:"Replacement",x:2,y:3,nativeId:A.id(),nativeIdOwner:def.id});
  stored = M.parse(F.serialize(F.applyDelta(stored,M.libraryEdits(stored,p.library[0])).file));
  p.library[0] = M.library(stored);
  assert.equal(L.resolve(p,target).target.label,"U1 · Original");
  assert.equal(L.anchorPlan(p,{kind:"pin",documentId:doc.id,ownerId:instance.id,terminal:"2"}).anchor.id,anchor.id);
  p.library[0].symbol.pins.pop();
  stored = M.parse(F.serialize(F.applyDelta(stored,M.libraryEdits(stored,p.library[0])).file));
  p.library[0] = M.library(stored);
  assert.equal(L.resolve(p,target).status,"missing-object");
  assert.equal(L.resolve(p,{projectId:p.id,objectId:def.id}).target.kind,"library");

  const legacyTerminal = "native-library/pin/1";
  const legacyRows = [...stored.records()].map(row=>row.kind==="pin" ? {...row,id:legacyTerminal} : row);
  const legacy = F.create(stored.header,legacyRows,M.readOptions("library",def.id));
  p.library[0] = M.library(legacy);
  const legacyAnchor = L.anchorPlan(p,{kind:"pin",documentId:doc.id,ownerId:instance.id,terminal:"1"}).anchor;
  assert.equal(legacyAnchor.terminalId,legacyTerminal);
  p.linkAnchors[legacyAnchor.id] = legacyAnchor;
  p.library[0].symbol.pins[0].number = "3";
  const legacyPatched = F.applyDelta(legacy,M.libraryEdits(legacy,p.library[0])).file;
  assert.equal(legacyPatched.get(legacyTerminal).value.number,"3");
  assert.equal(L.resolve(p,{projectId:p.id,objectId:legacyAnchor.id}).target.label,"U1 · Replacement");

  const revision = AtriumRevisions.freeze(p,{letter:"A",date:"2026-01-01",time:1});
  const snapshot = M.fromEditor(p);
  const bytes = F.serialize(snapshot.manifest);
  const engine = AtriumFolderProjectEngine.create();
  const open = await engine.run({op:"manifest",record:{path:snapshot.manifestPath,sha256:F.sha256(bytes),bytes}});
  assert.deepEqual(open.project.documents,[]);
  const release = {projectId:p.id,objectId:revision.id};
  assert.equal(L.resolve(open.project,release).target.label,"A");
  require("../../mcp/folder-project.js");
  const headless = AtriumMCPFolder.run;
  headless({action:"start"},AtriumFolderProjectEngine.dataOf(bytes));
  const [, raw] = headless({action:"project"});
  assert.equal(L.resolve(JSON.parse(raw),release).target.label,"A");
}

authoredBacklinkParity().then(nativeTerminalAndRelease).then(() =>
  console.log("Link parity passed for real query save, rebind, delete and Undo, and native terminal and release identities."),
  error => {console.error(error); process.exitCode = 1;});
