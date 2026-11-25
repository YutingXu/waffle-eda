"use strict";
if (!globalThis.process?.versions?.node) return;
const assert = require("node:assert/strict");
const path = require("node:path");
const app = path.join(__dirname,"../../app");
require("../support/native-cad.cjs");
require(path.join(app,"translator-worker-modules.js"));
for (const name of AtriumTranslatorWorkerModules["polygon-pour"]) require(require("../support/app-source-paths.cjs").appFileFrom(app, name));
for (const name of ["format-2-closure","import-sidecars","project-archive","browser-project","folder-project-engine","folder-project"])
  require(require("../support/app-source-paths.cjs").appFileFrom(app, name+".js"));
const F = AtriumFormat2, M = AtriumFormat2Model, P = AtriumPolygonPour, defs = new Map();
const rect = (x,y,X,Y) => [[x,y],[X,y],[X,Y],[x,Y]];

function board(doc, name) {
  doc.name = name;
  doc.outline = rect(0,0,92,40);
  const pour = (suffix, net, pourIndex, ...bounds) => P.make(rect(...bounds),{
    id:name+"-"+suffix,net,layer:"Top",pourIndex,removeDeadCopper:false,connectStyle:"relief",reliefAirGap:.12,clearance:.23
  });
  doc.items = [{id:name+"-pad",kind:"pad",net:"GND",layer:"Top",shape:"rect",x:41.7,y:19,w:2.6,h:2.6},
    pour("early","GND",0,2,2,42,34),pour("direct","SIG",1,15,8,58,31),
    pour("independent","ISOLATED",2,75,4,89,33)];
}
const packed = regions => regions.map(row=>[row.polygon,row.layer,row.net,row.data,row.count,row.arcs||null]);

async function main() {
  const project = Atrium.project("Native Save copper"), a = project.documents.find(row=>row.kind==="pcb"), b = Atrium.sheet("pcb","Second");
  project.documents.push(b);
  board(a,"First");board(b,"Second");
  AtriumSignals.attach(project);
  for (const doc of [a,b]) P.apply(doc,defs,{project,reuse:false});
  const initial = M.fromEditor(project,{entryDocument:a.id}), byPath = new Map(initial.files.map(m=>[m.path,m.file]));
  const aPath = M.manifest(initial.manifest).members.find(m=>m.id===a.id).path;
  const initialA = byPath.get(aPath), extension = {text:"Retain this native record field"};
  byPath.set(aPath,F.applyDelta(initialA,{put:[{...initialA.get("First-direct"),"x-qa":extension}]}).file);
  const storage = AtriumBrowserProject.create(initial.manifestPath,new Map([...byPath].map(([name,file])=>[name,F.serialize(file)])));
  const engine = AtriumFolderProjectEngine.create(), commits = [];
  let barrier;
  const host = {...storage.host,async folderCommit(request) {
    commits.push(request.plan.map(row=>row.path));
    if (barrier) {barrier.enter();await barrier.release;}
    return storage.host.folderCommit(request);
  }};
  const session = await AtriumFolderProject.open(storage,{host,workerFactory:()=>({
    run:(op,message,read,readBatch)=>engine.run({op,...message,read,readBatch}),close(){}
  })});
  async function bytes(id) {
    const {lease} = await host.folderReadLease({grant:storage.grant});
    try {
      const ref = session.getDocumentRef(id);
      const {files:[file]} = await host.folderRead({grant:storage.grant,lease,paths:[ref.path]});
      return file.bytes;
    } finally {await host.folderRelease({grant:storage.grant,lease});}
  }
  function edit(doc, gap) {
    const early = doc.items.find(row=>row.id===doc.name+"-early");
    early.reliefAirGap = gap;
    session.record([{id:doc.id,kind:"pcb",put:[JSON.stringify(early)]}]);
    P.apply(doc,defs,{project:session.project,derived:true,reuse:false});
    assert.deepEqual(P.stale(doc,defs,{project:session.project}),[]);
  }
  function checkSaved(data, doc, gap, expected, stale = []) {
    const file = M.parse(data);
    const saved = M.document(file,{name:doc.name});
    assert.equal(saved.items.find(row=>row.id===doc.name+"-early").reliefAirGap,gap);
    assert.deepEqual(packed(saved.pcbDrawing.pours),expected,"the raw disk contour belongs to this save");
    assert.deepEqual(P.stale(saved,defs,{project:session.project}),stale);
    assert.equal(saved.items.filter(row=>row.copperBasis).length,3-stale.length);
    if (doc.id === a.id) assert.deepEqual(file.get("First-direct")["x-qa"],extension);
  }
  try {
    await session.ensureDocument(b.id,{purpose:"test"});
    const one = session.loadedDocument(a.id), two = session.loadedDocument(b.id), oldTwo = await bytes(two.id);
    edit(one,.85);edit(two,.80);
    const first = packed(one.pcbDrawing.pours);
    let enter, release;
    const entered = new Promise(resolve=>{enter=resolve;});
    barrier = {enter,release:new Promise(resolve=>{release=resolve;})};
    const saving = session.save({documentId:one.id});
    await Promise.race([entered,saving.then(()=>{throw Error("Expected an active PCB write.");})]);
    try {edit(one,.95);} finally {release();barrier=null;}
    assert.equal((await saving).saved,true);
    checkSaved(await bytes(one.id),one,.85,first);
    assert.deepEqual(await bytes(two.id),oldTwo,"active Save leaves the sibling's physical bytes alone");
    assert.equal(commits[0].length,1);
    assert.equal((await session.save({all:true})).saved,true);
    const finalOne = await bytes(one.id), finalTwo = await bytes(two.id);
    checkSaved(finalOne,one,.95,packed(one.pcbDrawing.pours));
    checkSaved(finalTwo,two,.80,packed(two.pcbDrawing.pours));
    assert.equal(commits[1].length,2);
    const quiet = await session.save({all:true});
    assert.equal(quiet.clean,true);
    assert.equal(commits.length,2);
    assert.deepEqual(await bytes(one.id),finalOne);
    assert.deepEqual(await bytes(two.id),finalTwo);
    const early = one.items.find(row=>row.id==="First-early");
    const independent = one.items.find(row=>row.id==="First-independent");
    early.reliefAirGap = .28;
    independent.reliefAirGap = .75;
    session.record([{id:one.id,kind:"pcb",put:[JSON.stringify(early),JSON.stringify(independent)]}]);
    P.apply(one,defs,{project:session.project,only:["First-early","First-direct"],derived:true,reuse:false});
    const stale = ["First-independent"];
    assert.deepEqual(P.stale(one,defs,{project:session.project}),stale);
    assert.notDeepEqual(packed(M.document(M.parse(finalOne)).pcbDrawing.pours).find(row=>row[0]==="First-direct"),
      packed(one.pcbDrawing.pours).find(row=>row[0]==="First-direct"),"the healthy dependent changed");
    assert.equal((await session.save({documentId:one.id})).saved,true);
    checkSaved(await bytes(one.id),one,.28,packed(one.pcbDrawing.pours),stale);
    const pad = one.items.find(row=>row.id==="First-pad");
    pad.name = "Display only";
    session.record([{id:one.id,kind:"pcb",put:[JSON.stringify(pad)]}]);
    globalThis.AtriumPolygonPour = {...P,stale(){assert.fail("an unchanged accepted fill needs no rescan");}};
    try {assert.equal((await session.save({documentId:one.id})).saved,true);}
    finally {globalThis.AtriumPolygonPour = P;}
    checkSaved(await bytes(one.id),one,.28,packed(one.pcbDrawing.pours),stale);
    one.grid = .4;
    const {items,...settings} = one; void items;
    session.record([{id:one.id,kind:"pcb",settings}]);
    assert.equal((await session.save({documentId:one.id})).saved,true);
    const afterSettings = await bytes(one.id);
    checkSaved(afterSettings,one,.28,packed(one.pcbDrawing.pours),stale);
    const drawing = M.document(M.parse(afterSettings)).pcbDrawing;
    assert.deepEqual(AtriumPourMarker.read(drawing),stale,"a settings Save retains recorded stale copper");
    console.log("Native pour Save retains a coherent revision, writes only selected boards, and keeps quiet saves byte-identical.");
  } finally {await session.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
