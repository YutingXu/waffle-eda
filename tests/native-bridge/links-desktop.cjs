"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
for (const name of ["uuid-v7","model","link-record","design-query-record","calculation-records","links","links-desktop","source-file","format-2-units","format-2-codec","format-2-values","format-2-model",
  "format-2-closure","folder-project-engine","folder-project","undo-store","proposal","butter","butter-links",
  "camera","saved-views","slides","butter-slides"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));
const {Atrium:A,AtriumLinks:L,AtriumLinksDesktop:D,AtriumFormat2Model:M} = globalThis;
const data = name => fs.readFileSync(__dirname + "/../fixtures/butter-acceptance/links/" + name);
const saved = data("Link Board.waffle");
const project = M.manifest(M.parse(saved)).project;
project.documents.push(M.document(M.parse(data("Power.wpcb")), {name:"Power"}));
const board = project.documents[0], [track] = board.items;
const uri = L.format({projectId:project.id,objectId:track.id});
const unrelated = A.project("Other project", []);
let current = unrelated, selected = [], opened = 0, picked = 0, recents = [], candidate = null, granted = null;
let enabled = true, copy = null, focused = 0, savedLookup = 0;
const closed = [], released = [], status = [];
const windowProject = {grant:"chosen",manifest:"Link Board.waffle"};
const recentPath = {path:"/registered/Link Board.waffle"};
globalThis.AtriumPrefs = {get:key => key === "butter.links" && enabled};
globalThis.AtriumHost = {
  linkRecentProjects: id => {
    assert.equal(id,project.id);
    savedLookup++;
    return recents;
  },
  openRecent: entry => {
    assert.equal(entry,recentPath);
    return [{name:windowProject.manifest,folderProject:{...windowProject,grant:"recent"}}];
  },
  chooseProjectFolder: ({mode}) => {
    assert.equal(mode,"open");
    picked++;
    return candidate;
  },
  folderReadLease: ({grant}) => ({lease:"pinned:" + grant}),
  folderRead: ({grant,lease,paths}) => {
    assert.equal(lease,"pinned:" + grant);
    assert.deepEqual(paths,[windowProject.manifest]);
    const bytes = granted ?? saved;
    return {files:[{path:windowProject.manifest,bytes}]};
  },
  folderRelease: async ({grant,lease}) => {assert.equal(lease,"pinned:" + grant); released.push(grant);},
  folderClose: async ({grant}) => {closed.push(grant);}
};
globalThis.AtriumNavHost = {
  project:() => current,
  folderProject:()=>null,
  currentId:() => board.id,
  selectDocument: id => {assert.equal(id,board.id);},
  selection:() => selected,
  select: ids => {selected = ids;},
  doc:() => board,
  defs:() => new Map(),
  setHighlight:net => assert.equal(net,"Rail"),
  canvas:() => ({focus(){focused++;}}),
  zoomTo: box => assert.ok(box[0] < box[2]),
  info: text => status.push(text),
  openFiles: async ([file], options) => {
    assert.ok(["chosen","recent"].includes(file.folderProject.grant));
    assert.equal(options.expectedProjectId,project.id);
    current = project; opened++; return true;
  }
};
Object.defineProperty(globalThis,"navigator",{configurable:true,value:{clipboard:{writeText:async value => {copy = value;}}}});

(async () => {
  enabled = false;
  assert.equal(await D.receive(uri),false);
  assert.equal(picked,0);
  assert.equal(savedLookup,0);
  enabled = true;
  assert.equal(await D.receive(uri+"?path=/etc/passwd"),false);
  assert.equal(savedLookup,0);
  assert.equal((await D.follow(L.parse(uri))).status,"missing-project");
  assert.equal(picked,1);
  candidate = windowProject;
  const changed = M.createManifest(unrelated);
  granted = AtriumFormat2.serialize(changed);
  assert.equal((await D.follow(L.parse(uri))).status,"project-mismatch");
  assert.deepEqual(released,["chosen"]);
  assert.deepEqual(closed,["chosen"]);
  assert.equal(opened,0);
  granted = null;
  assert.equal((await D.follow(L.parse(uri))).status,"found");
  assert.equal(opened,1);
  assert.deepEqual(selected,[track.id]);
  assert.equal(focused,1);
  assert.equal(await D.copyLink(),true);
  assert.equal(copy,uri);
  assert.match(status.at(-1),/Rail/);
  assert.equal((await D.follow(L.parse(uri))).status,"found");
  assert.equal(opened,1);
  current = unrelated;
  recents = [recentPath,{path:"/other/Link Board.waffle"}];
  assert.equal((await D.follow(L.parse(uri))).status,"ambiguous-project");
  assert.equal(opened,1);
  recents = [recentPath];
  assert.equal((await D.follow(L.parse(uri))).status,"found");
  assert.equal(opened,2);
  assert.equal(released.at(-1),"recent");
  assert.equal(picked,3);
  await lazyFolderLinks();
  await graphLifecycle();
  console.log("Desktop links passed: picker consent, recents, clipboard, partial hydration, duplicate identity, part zoom, disk conflict, Git refresh and missing slide source.");
})().catch(error => {console.error(error); process.exitCode = 1;});

async function lazyFolderLinks() {
  const F = AtriumFormat2, C = AtriumFolderProject;
  const design = A.project("Hydrated backlinks", []);
  const [sheet, pcb] = design.documents;
  const part = {id:A.id(),kind:"part",ref:"U2",def:A.id(),x:4,y:8,angle:0};
  const wire = {id:A.id(),kind:"wire",points:[[1,2],[3,2]]};
  const frame = {id:A.id(),kind:"textframe",role:"frame",text:"Frame",x:4,y:8,w:20,h:10};
  const target = objectId => ({projectId:design.id,objectId});
  const url = L.format(target(part.id)), absent = L.format(target(A.id()));
  const note = {id:A.id(),kind:"textframe",x:1,y:2,w:20,h:8,text:"Opened later " + url};
  const relation = L.authoredRecord({objectId:wire.id,documentId:sheet.id,kind:"wire"},target(part.id),"See part");
  const slide = {id:A.id(),name:"Frame presentation",aspect:"16:9",notes:"",source:{kind:"frame",documentId:sheet.id,frameId:frame.id}};
  design.library.push({id:part.def,name:"Geometry",symbol:{pins:[],shapes:[{kind:"path",points:[[30,0],[50,10]]}]}});
  design.links = {[relation.id]:relation};
  sheet.items.push(part,wire,frame);
  const anchor = L.anchorPlan(design,{kind:"net",documentId:sheet.id,ownerId:wire.id}).anchor;
  design.linkAnchors = {[anchor.id]:anchor};
  pcb.items.push(note);
  design.slides = [slide];
  const built = M.fromEditor(design);
  const files = new Map(built.files.map(({path,file}) => [path,F.serialize(file)]));
  const boardPath = built.files.find(({file})=>file.header.kind==="pcb").path;
  const boardWith = next => M.createDocument({...pcb,items:[next,{id:wire.id,kind:"track",net:"Rail",layer:"Top",width:.2,points:[[3,4],[7,4]]}]});
  files.set(boardPath,F.serialize(boardWith(note)));

  const engine = AtriumFolderProjectEngine.create(), openedPaths = [];
  const session = await C.open({grant:"links-test",manifest:built.manifestPath},{
    workerFactory:() => ({run:(op,args,read,readBatch)=>engine.run({op,...args,read,readBatch}),close(){}}),
    host:{
      folderReadLease:async () => ({lease:"fixture"}),
      folderRead:async ({paths}) => ({files:paths.map(path => {
        openedPaths.push(path);
        const bytes = files.get(path);
        return {path,bytes,length:bytes.length,sha256:F.sha256(bytes)};
      })}),
      folderRelease:async () => {}
    }
  });
  const U = AtriumUndoStore, B = AtriumButter, live = session.project;
  let active = sheet.id, geometry, focusCount = 0;
  U.reset(live);
  U.mark(live);
  globalThis.AtriumNavHost = {
    project:() => live, folderProject:() => session, documentRefs:() => session.documents(),
    docById:id => session.loadedDocument(id), requireProjectClosure:opts => session.requireClosure(opts),
    editInProgress:() => false, revision:() => 1, currentId:() => active, selectDocument:async id => {await session.ensureDocument(id); active = id;},
    doc:() => session.loadedDocument(active), defs:() => new Map(live.library.map(def=>[def.id,def])),
    select(){}, zoomTo:box => {geometry = box;}, canvas:() => ({focus(){focusCount++;}}), info(){}
  };
  globalThis.AtriumPrefs.get = key => ["butter.links","butter.slides"].includes(key);
  const invoke = (feature, id, args, mode = "read") => {
    const spec = require("../../app/automation/descriptors/" + feature + ".json").commands.find(row=>row.id===id);
    return B.invoke(feature,spec,args,{project:live,scope:live,source:"editor",mode,allowWrite:mode==="write",documentId:active,
      isCurrent:() => globalThis.AtriumNavHost.project() === live},
      receipt => receipt);
  };
  globalThis.AtriumButterEditor = {apply:(command,args) => {
    assert.equal(command,"butter.slides.apply");
    return invoke("slides","apply",args,"write");
  }};
  const query = (id,args) => invoke("links",id,args).result;

  try {
    assert.equal(D.covered(),false);
    assert.equal(openedPaths.includes(boardPath),false);
    assert.equal(query("resolve",{url}).status,"partial");
    assert.equal(query("backlinks",{url}).total,1);
    assert.equal(query("backlinks",{url}).complete,false);
    const commit = {revision:"a".repeat(40),subject:"Review",recordLinks:[url]};
    D.index(live.id).importCommits([commit]);
    assert.equal((await D.follow(target(wire.id))).status,"ambiguous");
    assert.equal(D.covered(),true);
    assert.equal(focusCount,0);
    assert.equal(query("backlinks",{url}).total,3);
    assert.equal(query("backlinks",{url}).complete,true);
    assert.equal((await D.follow(target(part.id))).status,"found");
    assert.deepEqual(geometry,[34,8,54,18]);

    const savedBoard = session.loadedDocument(pcb.id);
    const local = savedBoard.items.find(item=>item.id===note.id);
    local.text = "Unsaved text " + url;
    U.record(live,{doc:savedBoard,items:[local]});
    session.record([{id:pcb.id,kind:"pcb",put:[local],remove:[]}]);
    files.set(boardPath,F.serialize(boardWith({...note,text:"Disk text " + absent})));
    await session.synchronize([boardPath]);
    assert.ok(session.conflicts.has(pcb.id));
    await session.resolveConflict(pcb.id,"disk");
    assert.equal(query("backlinks",{url}).total,2);
    assert.equal(query("backlinks",{url:absent}).total,1);
    D.index(live.id).importCommits([],{replace:true});
    assert.equal(query("backlinks",{url}).total,1);

    files.set(built.manifestPath,F.serialize(F.applyDelta(built.manifest,{remove:[relation.id,anchor.id]}).file));
    await session.synchronize([built.manifestPath]);
    assert.equal(live.links,undefined);
    assert.equal(live.linkAnchors,undefined);
    assert.equal(query("resolve",{url:L.format(target(anchor.id))}).status,"missing-object");
    assert.equal(query("backlinks",{url}).total,0);
    assert.equal(query("backlinks",{url:absent}).total,1);

    const activeSheet = session.loadedDocument(sheet.id);
    const frameIndex = activeSheet.items.findIndex(item=>item.id===frame.id);
    const [removed] = activeSheet.items.splice(frameIndex,1);
    U.record(live,{doc:activeSheet,items:[removed]});
    assert.equal((await D.follow(target(slide.id))).status,"missing-frame");
  } finally {
    await session.close();
  }
}

async function graphLifecycle() {
  const U = AtriumUndoStore, B = AtriumButter;
  const original = A.project("Backlink cache lifecycle", []), [sheet, board] = original.documents;
  const target = objectId => ({projectId:original.id,objectId});
  const address = target(sheet.id), url = L.format(address);
  const other = target(board.id), otherUrl = L.format(other);
  const note = {id:A.id(),kind:"textframe",text:url};
  const neighbour = {id:A.id(),kind:"textframe",text:"Another owner"};
  sheet.items.push(note);
  board.items.push(neighbour);
  const listeners = new Map();
  let project = original, revision = 0;
  globalThis.AtriumNavHost = {
    project:() => project, folderProject:() => null, revision:() => revision,
    currentId:() => sheet.id, selectDocument() {}, doc:() => sheet, info() {},
    on(event, fn) {listeners.set(event,fn); return () => listeners.delete(event);}
  };
  const tell = (event, detail) => listeners.get(event)?.(detail);
  const commands = require("../../app/automation/descriptors/links.json").commands;
  const command = (id, args, {captured = project, stale = false, mode = "read"} = {}) => B.invoke("links",
    commands.find(spec => spec.id === id),args,{project:captured,scope:captured,source:"editor",
      mode,allowWrite:mode==="write",isCurrent:() => !stale},receipt=>receipt.result);
  Object.defineProperty(note,"text",{configurable:true,get(){throw Error("Copy or open built a backlink graph");}});
  assert.equal((await command("copy-link",{objectId:sheet.id},{mode:"write"})).copied,true);
  assert.equal((await D.follow(address)).status,"found");
  assert.equal(listeners.size,0);
  Object.defineProperty(note,"text",{configurable:true,writable:true,value:url});

  U.reset(original);
  const before = U.mark(original), history = [], future = [];
  const graph = D.index(project.id);
  function parity(index) {
    const full = L.fromProject(project);
    for (const target of [address,other]) {
      assert.deepEqual(index.backlinks(target),full.backlinks(target));
      assert.deepEqual(L.resolve(project,target,index),L.resolve(project,target,full));
    }
  }
  parity(graph);
  const neighbourId = neighbour.id;
  Object.defineProperty(neighbour,"id",{configurable:true,get(){throw Error("Warm lookup scanned another owner");}});
  assert.equal(command("resolve",{url:L.format(target(note.id))}).target.label,url);
  assert.equal((await command("copy-link",{objectId:sheet.id},{mode:"write"})).copied,true);
  Object.defineProperty(neighbour,"id",{configurable:true,writable:true,value:neighbourId});

  const noteId = note.id;
  note.id = A.id();
  assert.equal(command("resolve",{url:L.format(target(noteId))}).status,"missing-object");
  assert.equal(command("resolve",{url:L.format(target(note.id))}).status,"found");
  note.id = noteId;
  board.items.push({...note});
  assert.deepEqual(command("resolve",{url:L.format(target(noteId))}),L.resolve(project,target(noteId),L.fromProject(project)));
  assert.equal(command("resolve",{url:L.format(target(noteId))}).status,"ambiguous");
  board.items.pop();
  note.text = otherUrl;
  U.checkpoint(history,future,before);
  ++revision;
  U.touch(original,{doc:sheet,items:[note]});
  tell("change",{});
  assert.equal(D.index(project.id),graph,"a pending journal sync keeps the existing graph");
  parity(graph);
  assert.equal(graph.backlinks(other).length,1);

  assert.ok(U.jump(history,future,U.mark(original),-1));
  ++revision;
  tell("change",{source:"undo"});
  assert.equal(D.index(project.id),graph,"restored records precede the editor's revision change");
  parity(graph);
  assert.equal(graph.backlinks(address).length,1);

  note.text = otherUrl;
  assert.equal(command("resolve",{url:L.format(target(note.id))}).target.label,otherUrl,
    "a point lookup sees unsignalled in-place changes even when a graph exists");
  ++revision;
  tell("change",{});
  const unrelated = {id:A.id(),kind:"textframe",text:"Another owner"};
  board.items.push(unrelated);
  ++revision;
  U.record(original,{doc:board,items:[unrelated]});
  tell("change",{});
  const rebuilt = D.index(project.id);
  assert.notEqual(rebuilt,graph,"a later journal update cannot conceal an unjournalled revision");
  parity(rebuilt);
  assert.equal(rebuilt.backlinks(other).length,1);

  const duplicate = {...note};
  board.items.push(duplicate);
  ++revision;
  U.touch(original,{doc:board,items:[duplicate]});
  tell("change",{});
  assert.equal(command("resolve",{url:L.format(target(note.id))}).status,"ambiguous");
  parity(D.index(project.id));
  board.items.pop();
  ++revision;
  U.record(original,{doc:board,items:[duplicate]});
  tell("change",{});

  project = {...original,documents:[{...sheet,name:"Replacement",items:[]},board]};
  tell("replace");
  assert.equal(listeners.size,0);
  assert.notEqual(D.index(project.id),rebuilt,"the project UUID alone cannot identify a cache owner");
  parity(D.index(project.id));
  assert.equal(command("resolve",{url}).target.label,"Replacement");
  assert.equal(command("resolve",{url},{captured:original,stale:true}).target.label,sheet.name);
  assert.equal(command("copy-link",{objectId:sheet.id},{captured:original,stale:true,mode:"write"}).copied,false);
  tell("replace");
  U.reset();
}
