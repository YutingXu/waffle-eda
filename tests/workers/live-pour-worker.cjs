"use strict";
if (!globalThis.process?.versions?.node) return; // Worker threads are unavailable in the JSC test shim.
const assert = require("node:assert/strict");
const {Worker} = require("node:worker_threads");
const {readFileSync} = require("node:fs");
const {resolve} = require("node:path");
const app = process.argv[2] ? resolve(process.argv[2],"app") : resolve(__dirname,"../../app");
const {appFileFrom} = require("../support/app-source-paths.cjs");
const {nativeRoundTrip} = require(resolve(app,"../tests/support/native-cad.cjs"));
const source = readFileSync(resolve(app,"translator-worker-modules.js"),"utf8");
new Function(source)();
for (const file of [...AtriumTranslatorWorkerModules["polygon-pour"], "viastack.js", "rooms.js", "dfa.js", "undo-store.js", "live-pour-client.js",
  "zip.js", "fab-outputs.js"])
  require(appFileFrom(app,file));

const bootstrap = `
  const {parentPort, workerData:app} = require("node:worker_threads");
  const {readFileSync} = require("node:fs");
  const {resolve} = require("node:path");
  globalThis.importScripts = (...files) => {
    for (const file of files) new Function("require", "module", readFileSync(resolve(app,"workers",file),"utf8"))();
  };
  globalThis.postMessage = data => parentPort.postMessage(data);
  importScripts("live-pour-worker.js");
  parentPort.on("message", data => globalThis.onmessage({data}));
`;
const G = globalThis, P = AtriumPolygonPour, U = AtriumUndoStore;
G.document = {baseURI:"https://waffle.test/app/index.html"};
G.Worker = Worker;
let workers = 0, holdResult = false, held = null, releaseHeld = null, requests = 0, crashNext = false;
G.AtriumWorkerPool = {script(name) {
  assert.equal(name, "workers/live-pour-worker.js");
  workers++;
  const w = new Worker(bootstrap, {eval:true, workerData:app});
  const client = {
    postMessage(data) {
      if (data.type === "refill") {
        requests++;
        if (crashNext) {
          crashNext = false;
          setImmediate(() => client.onerror?.({message:"deliberate worker crash"}));
          return;
        }
      }
      w.postMessage(data);
    },
    terminate() {return w.terminate();}
  };
  w.on("message", data => {
    if (data.type === "result" && holdResult && !held) {
      held = () => client.onmessage?.({data});
      return;
    }
    if (data.type === "regions" && held && releaseHeld) {
      const release = held; held = null; releaseHeld = null; release();
    }
    client.onmessage?.({data});
  });
  w.on("error", e => client.onerror?.(e));
  return client;
}};

const wait = (ms = 2) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  for (let i = 0; i < 2500 && !predicate(); i++) await wait();
  assert.ok(predicate(), label);
}
const rect = (x, y, X, Y) => [[x,y],[X,y],[X,Y],[x,Y]];
const project = Atrium.project("Live pour worker");
const board = project.documents.find(d => d.kind === "pcb");
const defs = new Map(project.library.map(d => [d.id, d]));
const track = {id:"track",kind:"track",layer:"Top",net:"SIG",width:.2,points:[[3,5],[30,5]]};
board.outline = rect(0,0,40,30);
board.items.push(track, {id:"anchor",kind:"via",layer:"Multi",net:"GND",x:5,y:10,diameter:.65,drill:.3});
board.items.push(P.make(rect(1,1,39,29), {id:"top",net:"GND",layer:"Top"}));
board.items.push(P.make(rect(3,2,36,24), {id:"second",net:"SIG",layer:"Top",pourIndex:1}));
board.items.push(P.make(rect(1,1,39,29), {id:"bottom",net:"GND",layer:"Bottom"}));
AtriumSignals.attach(project);
P.apply(board, defs, {project,reuse:false});

let activeDoc = board;
let revision = 0, commits = 0, messages = [], previous = [], future = [], firstAcceptedCopper;
const emit = source => {revision++;for (const fn of listeners) fn({source});};
const listeners = new Set();
const host = {
  project:() => project, doc:() => activeDoc, defs:() => defs, revision:() => revision,
  on(name, fn) {if (name === "change") listeners.add(fn);},
  info(message) {messages.push(message);},
  edit(fn) {
    U.checkpoint(previous,future,U.mark(project));fn();U.record(project);emit();
  },
  derive(fn) {
    fn();
    firstAcceptedCopper ??= structuredClone(board.pcbDrawing.pours);
    U.record(project);commits++;emit("pours");
  },
  undo() {
    assert.ok(U.jump(previous,future,U.mark(project),-1));
    assert.equal(U.root(),project);
    emit("undo");
  },
  redo() {
    assert.ok(U.jump(previous,future,U.mark(project),1));
    assert.equal(U.root(),project);
    emit("undo");
  }
};
const height = () => board.items.find(row => row.id === "track").points[0][1];
const move = y => host.edit(() => {
  const row = board.items.find(row => row.id === "track");
  row.points[0][1] = row.points[1][1] = y;
});
function covers(rings, x, y) {
  return rings.reduce((inside, ring) =>
    P._internal.core.pointInRing(x, y, ring) === 1 ? !inside : inside, false);
}
function previewCopper(regions, polygon, x, y) {
  const onPour = regions.filter(r => r.polygon === polygon);
  const patch = onPour.find(r => r.patch)?.patch;
  if (patch?.rects.some(([l, t, r, b]) => x > l && x < r && y > t && y < b))
    return covers([...patch.tiles.values()].flat(), x, y);
  return onPour.some(r => !r.patch && covers(P.rings(r), x, y));
}
function exact(label, fabrication) {
  const copy = JSON.parse(JSON.stringify(project)), expected = copy.documents.find(d => d.kind === "pcb");
  AtriumSignals.attach(copy);
  P.apply(expected, defs, {project:copy,reuse:false});
  assert.deepEqual(board.pcbDrawing.pours, expected.pcbDrawing.pours, label);
  assert.deepEqual(board.pcbDrawing.pourSignatures, expected.pcbDrawing.pourSignatures, label + " signatures");
  assert.deepEqual(P.stale(board,defs,{project}), [], label + " freshness");
  if (fabrication) {
    assert.equal(board.sourcePourSignature, expected.sourcePourSignature, label + " saved board stamp");
    const copper = (p, d) => AtriumFabOutputs.build(p, d, {date:new Date("2025-01-01T00:00:00Z")}).files
      .filter(file => /\.(GTL|GBL)$/.test(file.name)).map(file => file.content);
    const reference = copper(copy, expected);
    assert.equal(reference.length, 2, label + " plots both outer layers");
    assert.deepEqual(copper(project, board), reference, label + " plotted copper");
  }
}
async function settle(label, fabrication) {
  const out = await P.settle(board, defs, {project});
  assert.equal(out.state, "current", label);
  assert.ok(!P.live.busy,label);
  exact(label, fabrication);
}

async function main() {
  P.live.setMode("live");P.live.attach(host);
  assert.equal(workers,0,"Attaching does not start the worker");
  move(6);
  await settle("first worker fill");
  assert.equal(workers,1);
  assert.equal(P.live.last.transport.mode,"snapshot");
  assert.equal(P.live.last.transport.rows,board.items.length + 3);
  assert.equal(commits,1);
  assert.deepEqual(firstAcceptedCopper,board.pcbDrawing.pours,"the first accepted reply stores the exact edited copper");

  await until(() => P.tiles.state, "an ordinary exact fill prepares the display tiles in idle time");
  const settledCopper = board.pcbDrawing.pours;
  holdResult = true;
  move(7);
  await until(() => held && P.displayPours(board).some(r => r.patch), "a journal edit shows the new copper before the exact reply");
  const preview = P.displayPours(board);
  assert.equal(board.pcbDrawing.pours, settledCopper, "the preview leaves the exact copper untouched");
  assert.equal(P.outputCopper(board,defs,{project,solve:false}).state,"pending","fabrication waits for exact copper");
  const fresh = P.repourAll(board,defs,{project,reuse:false}).regions;
  let changed = 0;
  for (const polygon of ["top","second"]) {
    const patch = preview.find(r => r.polygon === polygon && r.patch)?.patch;
    assert.ok(patch, `the edit previews ${polygon}`);
    const {gx0, TS, S, ox, cols} = patch.grid;
    const samples = [];
    for (let x = 3.131; x < 29.9; x += .37) samples.push(x);
    for (let col = 1; col < cols; col++) {
      const seam = (gx0 + col * TS) / S + ox;
      if (seam > 4 && seam < 28) samples.push(seam - .013, seam + .013);
    }
    let thisPour = 0;
    for (const y of [5.73, 6.09, 6.89, 7.07, 7.29]) for (const x of samples) {
      const next = previewCopper(fresh,polygon,x,y);
      assert.equal(previewCopper(preview,polygon,x,y),next,`preview at ${x}, ${y}, ${polygon}`);
      if (next !== previewCopper(settledCopper,polygon,x,y)) thisPour++;
    }
    assert.ok(thisPour,`the edit changes ${polygon} across multiple tiles`);
    changed += thisPour;
  }
  assert.ok(changed > 30,"the preview comparison includes changed copper");
  const saving = P.live.pendingSave(board);
  assert.ok(saving,"save waits while a live refill is pending");
  activeDoc = project.documents.find(d => d.kind === "schematic");
  assert.equal(P.live.pendingSave(undefined,[activeDoc.id]),null,"a save of another document does not wait");
  assert.equal(P.live.pendingSave(),saving,"Save All uses the same pending board fill after switching tabs");
  assert.ok(!P.displayPours(board).some(r => r.patch),"the preview is confined to the active board");
  holdResult = false;
  const release = held;
  held = null;
  release();
  await saving;
  assert.equal(commits,2,"switching tabs does not cancel the copper that will be saved");
  activeDoc = board;
  await settle("journal fill", true);
  assert.equal(P.live.last.transport.mode,"journal");
  assert.equal(P.live.last.transport.rows,1,"the in-place point edit sends one row");
  assert.equal(commits,2);
  const good = board.pcbDrawing.pours;

  await P.tiles.rebuild();
  holdResult = true;
  move(8);
  await until(() => held && P.displayPours(board).some(r=>r.patch), "an older edit has a visible preview and a held exact reply");
  const beforeBurst = requests;
  for (const y of [9,10,11]) move(y);
  host.undo();
  assert.equal(height(),10);
  assert.ok(!P.displayPours(board).some(r=>r.patch),"Undo immediately hides the superseded preview");
  assert.equal(board.pcbDrawing.pours,good,"retained last exact copper during edits");
  holdResult = false;releaseHeld = true;
  await settle("undo and delayed reply", true);
  assert.equal(commits,3,"the obsolete reply never committed");
  assert.equal(requests,beforeBurst+1,"burst and undo coalesced");
  assert.equal(future.length,1,"derived copper keeps redo");
  host.redo();
  await settle("redo", true);
  assert.equal(height(),11);

  const scope = AtriumQueryExchange.fromClassic("InRoom('Wide')").scope;
  const normal = AtriumDesignQueryRecord.selector("all");
  const beforeScoped = requests;
  host.edit(() => {
    board.rooms = [{id:"wide",name:"Wide",points:rect(10,8,25,18)}];
    AtriumProjectRules.edit(project, book => {
      const base = book.list.find(r => r.type === "clearance" && AtriumDesignQueryRecord.isAll(r.scope));
      base.priority = 2;
      book.list.push({...base,id:"room-clearance",name:"Wide room",gap:.9,priority:1,scope,scope2:normal});
    });
  });
  move(11.5);
  await settle("typed room rule snapshot");
  assert.equal(requests,beforeScoped+1,"dynamic rules run in the dedicated worker");
  assert.equal(P.live.last.transport.mode,"scoped-snapshot","dynamic rules refresh query anchors and project context");
  move(11.75);
  await settle("room query inputs change on the next edit");
  assert.equal(P.live.last.transport.mode,"scoped-snapshot");
  const scoped = nativeRoundTrip(project), typedBoard = scoped.documents.find(d => d.kind === "pcb");
  assert.deepEqual(P.stale(typedBoard,defs,{project:scoped}),[],"native save keeps typed-rule copper current");
  assert.deepEqual(typedBoard.pcbDrawing.pours.map(r => r.data),board.pcbDrawing.pours.map(r => r.data));

  P.live.useWorker(false);
  const last = commits;
  move(12);
  await settle("worker-disabled fallback");
  assert.equal(workers,1);
  assert.equal(commits,last+1);

  P.live.useWorker(true);
  crashNext = true;
  host.edit(() => AtriumProjectRules.edit(project, book => {
    book.list = book.list.filter(r => r.id !== "room-clearance");
  }));
  move(12.5);
  const crashSave = P.live.pendingSave();
  assert.ok(crashSave,"save waits for the requested work even if the worker stops");
  await crashSave;
  assert.equal(crashNext,false,"the scheduled worker was crashed");
  await settle("fallback after a worker crash");
  const reopened = nativeRoundTrip(project), saved = reopened.documents.find(d => d.kind === "pcb");
  assert.deepEqual(P.stale(saved,defs,{project:reopened}),[],"native round-trip retains fresh copper after recovery");
  assert.deepEqual(saved.pcbDrawing.pours.map(r => r.data),board.pcbDrawing.pours.map(r => r.data));
  assert.deepEqual(messages,[]);
  console.log("live pour mirror: cold and one-row refill, cancelled reply, undo/redo, scoped save, crash recovery, fresh output and native copper");
}
async function dormantScope() {
  P.live.reset();
  U.reset();
  for (const name of ["format-2-closure","import-sidecars","project-archive","browser-project","folder-project-engine","folder-project"])
    require(appFileFrom(app,name+".js"));
  const root = Atrium.project("Hydrate linked copper sources");
  const pcb = root.documents.find(d => d.kind==="pcb"), sheet = root.documents.find(d => d.kind==="schematic");
  const unrelated= Atrium.sheet("pcb","Unrelated Board");
  root.documents.push(unrelated);
  pcb.outline=rect(0,0,40,30);
  pcb.items.push({...track,id:"tagged-track",net:"FOREIGN",points:[[3,5],[30,5]]},
    P.make(rect(1,1,39,29),{id:"checked-fill",removeDeadCopper:false,net:"GND",layer:"Top"}));
  sheet.items.push({id:"tag-author",kind:"netlabel",x:0,y:0,text:"FOREIGN",tags:["Wide"]});
  AtriumProjectRules.edit(root, book => {
    const Q=AtriumDesignQueryRecord, base=book.list.find(r=>r.type==="clearance"&&Q.isAll(r.scope));
    base.priority=2;
    book.list.push({...base,id:"net-tag-clearance",name:"Tagged Clearance",gap:1.5,priority:1,
      scope:Q.create("track in tag Wide"),scope2:Q.selector("all")});
  });
  AtriumSignals.attach(root);
  P.apply(pcb,new Map(),{project:root,reuse:false});
  const codec=AtriumFormat2, records=AtriumFormat2Model.fromEditor(root,{entryDocument:pcb.id});
  const paths=new Map(records.files.map(({path,file})=>[path,codec.serialize(file)]));
  const storage=AtriumBrowserProject.create(records.manifestPath,paths), reads=[];
  const native={...storage.host,folderRead(request) {
    reads.push(...request.paths);
    return storage.host.folderRead(request);
  }};
  const engine=AtriumFolderProjectEngine.create();
  const session=await AtriumFolderProject.open(storage,{host:native,workerFactory:()=>({
    run:(op,message,read,readBatch)=>engine.run({op,...message,read,readBatch}),close(){}
  })});
  try {
    assert.equal(session.ownerReady(sheet.id),false,"opening the PCB leaves the sibling dormant");
    assert.equal(session.ownerReady(unrelated.id),false,"opening the PCB leaves unrelated boards dormant");
    const liveProject=session.project,d=session.loadedDocument(pcb.id), map=new Map(liveProject.library.map(row=>[row.id,row]));
    const fns=new Map();let rev=0, derived=0;
    const H={project:()=>liveProject,doc:()=>d,defs:()=>map,revision:()=>rev,folderProject:()=>session,
      on:(name,fn)=>fns.set(name,fn),derive(fn){fn();U.record(liveProject);rev++;derived++;}};
    P.live.setMode("live");P.live.attach(H);
    U.mark(liveProject);
    d.items[0].points[0][1]+=1;d.items[0].points[1][1]+=1;U.record(liveProject);rev++;fns.get("change")({});
    const beforeRequests=requests, oldCopper=d.pcbDrawing.pours;
    await until(()=>!P.live.busy,"incomplete scope waits for a real folder dependency");
    assert.equal(requests,beforeRequests);
    assert.equal(d.pcbDrawing.pours,oldCopper,"no partial-project copper is committed");
    assert.equal(session.ownerReady(sheet.id),false,"a live request never opens a sibling");
    assert.equal(P.live.pendingSave(d),null,"an ordinary save can persist the edit without waiting for a dormant sheet");
    session.record([{id:d.id,kind:"pcb",put:[JSON.stringify(d.items[0])]}]);
    assert.equal((await session.save({documentId:d.id})).saved,true);
    assert.equal(session.ownerReady(sheet.id),false,"saving leaves the sheet dormant");
    assert.equal(d.pcbDrawing.pours,oldCopper,"saving retains the old physical basis");
    const {lease}=await native.folderReadLease({grant:storage.grant});
    let savedBoard;
    try {
      const path=session.getDocumentRef(d.id).path;
      const {files:[file]}=await native.folderRead({grant:storage.grant,lease,paths:[path]});
      savedBoard=AtriumFormat2Model.document(codec.parse(file.bytes));
    } finally {await native.folderRelease({grant:storage.grant,lease});}
    assert.equal(savedBoard.items[0].points[0][1],6,"the normal save persists the authored track edit");
    assert.deepEqual(savedBoard.pcbDrawing.pours.map(r=>r.data),oldCopper.map(r=>r.data));
    const inspected={...root,documents:root.documents.map(row=>row===pcb?savedBoard:row)};
    AtriumSignals.attach(inspected);
    assert.deepEqual(P.stale(savedBoard,map,{project:inspected}),["checked-fill"],"a reopen cannot certify incomplete copper");
    assert.equal((await P.settle(d,map,{project:liveProject})).state,"current","the explicit output preflight hydrates the relevant source");
    assert.equal(session.ownerReady(sheet.id),true);
    await until(()=>derived===1&&!P.live.busy,"hydrating the dependency wakes the exact worker");
    assert.equal(requests,beforeRequests+1);
    assert.equal(session.ownerReady(unrelated.id),false,"the unrelated board never opens");
    const full=P.repourAll(d,map,{project:liveProject,reuse:false});
    assert.deepEqual(d.pcbDrawing.pours,full.regions,"loaded sibling produces authoritative copper");
    assert.deepEqual(P.stale(d,map,{project:liveProject}),[]);
    assert.ok(reads.length>0,"a real native folder file graph was read");
    console.log("lazy native project: held dependent refill, then exact copper after loading only its source sheet");
  } finally {P.live.reset();await session.close();}
}
async function interruptedRefill(mode) {
  P.live.reset();
  U.reset();
  const project = Atrium.project("Interrupted dependency solve"), doc = project.documents.find(d => d.kind === "pcb");
  const defs = new Map(), wanted = ["early", "direct", "tail"], seen = [], persisted = [];
  const add = (id, net, i, ...bounds) => P.make(rect(...bounds), {
    id, net, layer:"Top", pourIndex:i, removeDeadCopper:false, connectStyle:"relief", reliefAirGap:.12, clearance:.23
  });
  doc.outline = rect(0,0,92,40);
  doc.items = [{id:"land",kind:"pad",net:"GROUND",layer:"Top",shape:"rect",x:41.7,y:19,w:2.6,h:2.6},
    add("early","GROUND",0,2,2,42,34),add("direct","SUPPLY",1,15,8,58,31),
    add("tail","CONTROL",2,43.3,4,69,33),add("independent","ISOLATED",3,75,4,89,33)];
  AtriumSignals.attach(project);
  P.apply(doc,defs,{project,reuse:false});
  const retained = doc.pcbDrawing.pours, listeners = new Map();
  const outline = () => doc.items.find(i => i.id === "early");
  let rev = 0;
  const change = source => {U.record(project);rev++;listeners.get("change")?.({source});};
  const H = {
    project:() => project, doc:() => doc, defs:() => defs, revision:() => rev,
    on:(event,fn) => listeners.set(event,fn),
    derive(fn, options) {
      fn();
      seen.push(globalThis.AtriumPourMarker.read(doc.pcbDrawing));
      if (options?.persistDerived) persisted.push(seen.at(-1));
      change("pours");
    }
  };
  const previousPower = G.AtriumPower;
  let visible = true, onVisibility;
  if (mode === "occluded") G.AtriumPower = {
    visible:() => visible, onChange(fn) { onVisibility = fn; return () => { onVisibility = null; }; }
  };
  U.mark(project);
  P.live.setMode("live");
  P.live.attach(H);
  P.live.useWorker(true);
  const setTimeoutOriginal = globalThis.setTimeout;
  let fireTimeout;
  try {
    // Capture the production watchdog and fire it after retaining the worker reply.
    globalThis.setTimeout = (fn,ms,...args) => {
      if (ms === 120000) fireTimeout = fn;
      return setTimeoutOriginal(fn,ms,...args);
    };
    holdResult = true;
    outline().reliefAirGap = .85;
    change();
    const save = P.live.pendingSave(doc);
    assert.ok(save,"Save waits before the worker interruption is reported");
    await until(() => held,"the worker reply reached the transport hold");
    if (mode === "timeout") {
      assert.ok(fireTimeout,"the real client installed its watchdog");
      fireTimeout();
    } else if (mode === "manual") P.live.setMode("manual");
    else {visible = false;onVisibility({visible});}
    await save;
    assert.deepEqual(seen,[wanted],"the interruption publishes only stale metadata");
    assert.deepEqual(persisted,[wanted],"the interruption opts in to native folder persistence");
    assert.equal(doc.pcbDrawing.pours,retained);
    assert.deepEqual(P.stale(doc,defs,{project}),wanted);
    if (mode === "timeout") assert.match(P.stateOf(doc,defs).failed,/worker stopped responding/);
    else {
      assert.equal(P.stateOf(doc,defs).failed,null);
      assert.deepEqual(P.failures(doc),{});
    }
    const saved = nativeRoundTrip(project), board = saved.documents.find(d => d.id === doc.id);
    assert.deepEqual(P.stale(board,defs,{project:saved}),wanted);
    assert.deepEqual(board.items.filter(i=>i.copperBasis).map(i=>i.id),["independent"]);
    assert.deepEqual(P.outputCopper(board,defs,{project:saved}).filled,wanted);
    const late = held;
    held = null;
    holdResult = false;
    if (mode === "timeout") {
      doc.name = "Same copper inputs";
      change();
      await until(() => !P.live.busy,"the same-input check settles without another publication");
      assert.deepEqual(seen,[wanted]);
      outline().reliefAirGap = .95;
      change();
      const out = await P.settle(doc,defs,{project});
      assert.equal(out.state,"current");
    } else {
      if (mode === "manual") P.live.setMode("live");
      else {visible = true;onVisibility({visible});}
      await until(() => !P.live.busy && !P.stale(doc,defs,{project}).length,"resuming live refill settles the saved revision");
      assert.equal(outline().reliefAirGap,.85,"resume takes no authored edit");
    }
    const beforeLate = rev;
    late();
    assert.equal(rev,beforeLate,"an obsolete reply cannot publish after recovery");
    assert.deepEqual(doc.pcbDrawing.pours,P.repourAll(doc,defs,{project,reuse:false}).regions);
    assert.equal(globalThis.AtriumPourMarker.read(doc.pcbDrawing),undefined);
    assert.deepEqual(persisted,[wanted],"ordinary live copper stays derived");
    console.log("interrupted worker ("+mode+"): pending Save records stale dependencies and recovery refills exactly");
  } finally {
    globalThis.setTimeout = setTimeoutOriginal;
    held = null;
    holdResult = false;
    P.live.reset();
    if (mode === "occluded") G.AtriumPower = previousPower;
  }
}
const cases = [
  [main], [dormantScope],
  ...["timeout","manual","occluded"].map(mode => [interruptedRefill, mode])
];
globalThis.__testDone = (async () => {
  for (const [check, fixture] of cases) await check(fixture);
})().finally(() => P.live.reset());
if (require.main === module) globalThis.__testDone.catch(e => {console.error(e);process.exitCode=1;});
