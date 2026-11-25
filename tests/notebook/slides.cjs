"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
for (const mod of ["uuid-v7","model","source-file","format-2-codec","format-2-units","format-2-values",
  "design-query-record","format-2-model","link-record","sch-objects","saved-views","slides","butter","proposal","undo-store"])
  require(require("../support/app-source-paths.cjs").appFile(mod + ".js"));
require("../../app/notebook/slide-commands.js");
const {AtriumFormat2:F,AtriumFormat2Model:M,AtriumSlides:S,AtriumSavedViews:V,AtriumButter:B,AtriumProposal:P,AtriumUndoStore:U} = globalThis;
const fixture = path.join(__dirname, "../fixtures/butter-acceptance/slides");
const spec = Object.fromEntries(require("../../app/automation/descriptors/slides.json").commands.map(value => [value.id, value]));
const id = n => "018cc251-f400-7001-8000-" + String(n).padStart(12, "0");
const manifest = M.parse(fs.readFileSync(path.join(fixture, "Slide study.waffle")));
const {project, members} = M.manifest(manifest);
for (const member of members) project.documents.push(M.document(M.parse(fs.readFileSync(path.join(fixture, member.path))), {name:member.name}));
const [first, second, third] = project.slides;

function referencedViewResolution() {
  const doc = project.documents[1], saved = project.savedViews[0];
  const views = Array.from({length:M.savedViewLimit}, (_, n) => ({...saved, id:id(200 + n)}));
  const record = {...saved, name:"Referenced view", camera:{...saved.camera, flipped:true, rotationRadians:0.5}};
  views[views.length - 1] = record;
  let viewReads = 0, refReads = 0;
  const savedViews = new Proxy(views, {get(array, key, receiver) {
    if (typeof key === "string" && /^\d+$/.test(key)) viewReads++;
    return Reflect.get(array, key, receiver);
  }});
  const refs = new Proxy([doc], {get(array, key, receiver) {
    if (key === "0") refReads++;
    return Reflect.get(array, key, receiver);
  }});
  const synthetic = {...project, documents:[], savedViews};
  const direct = V.resolve(synthetic, record.id, {refs});
  assert.equal(viewReads, views.length);
  assert.equal(refReads, 1);
  viewReads = refReads = 0;
  const plan = S.resolve(synthetic, second.id, {refs});
  assert.equal(viewReads, views.length, "resolving a slide looks up its saved view once");
  assert.equal(refReads, 1, "resolving a slide looks up the saved view's document once");
  assert.equal(plan.status, "partial");
  assert.deepEqual(plan, {...direct, id:second.id, name:second.name, source:second.source, aspect:second.aspect, hasNotes:true});
  const coldRefs = [{id:doc.id}];
  assert.equal(S.resolve(synthetic, second.id, {refs:coldRefs}).status, "loading-document");
  assert.equal(S.resolve(synthetic, second.id, {refs:[{id:doc.id, missing:true}]}).status, "missing-document");
  assert.equal(S.resolve(synthetic, second.id).status, "missing-document");
  assert.deepEqual(S.resolve(synthetic, second.id, {refs:coldRefs, doc}), plan);
  assert.equal(S.resolve({...synthetic, savedViews:undefined}, second.id).documentId, null);
  const legacy = {...second, source:{...second.source, documentId:doc.id}};
  assert.deepEqual(S.resolve({...synthetic, savedViews:[], slides:[legacy]}, legacy.id),
    {id:legacy.id, name:legacy.name, source:legacy.source, aspect:legacy.aspect, documentId:doc.id, status:"missing-view", hasNotes:true});
}

async function exportBatch() {
  const [top, sensor] = project.documents, frameId = first.source.frameId, selected = "same-local-id";
  const reads = [0,0], opens = [0,0], privateText = "Speaker notes for this deck";
  const docs = [top,sensor].map((doc,index) => ({...doc, items:[
    ...Array.from({length:500},(_,n) => ({get id() {reads[index]++; return "item-" + n;}})),
    {id:frameId,kind:"textframe",role:"frame",x:index * 10,y:0,w:48,h:27},
    {id:selected}
  ]}));
  const views = docs.map((doc,index) => ({...project.savedViews[0],id:id(192 + index),documentId:doc.id,
    selection:["item-499", "missing-" + index, selected], filter:{scope:{languageVersion:1,source:"object"},mask:index === 0,highlight:index === 1}}));
  const slides = Array.from({length:24},(_,n) => {
    const pair = (n >> 1) % 2, source = n % 2 === 0 ? {kind:"frame",documentId:docs[pair].id,frameId} :
      {kind:"savedView",savedViewId:views[pair].id};
    return {id:id(300 + n),name:"Slide " + n,aspect:n % 2 ? "4:3" : "16:9",notes:privateText + n,source};
  });
  const synthetic = {...project,documents:docs,savedViews:views,slides};
  const ids = slides.map(slide=>slide.id).reverse();
  const invoke = (args, context = {}) => B.invoke("slides", spec["export-pdf"], args, {
    project:synthetic, scope:synthetic, source:"mcp", mode:"write", allowWrite:true, enabled:()=>false, ...context
  }, ({result},{file}) => ({result,file}));
  let jobs, publications = 0, abort = false, queries = 0;
  globalThis.AtriumQuery = {run(_project,doc) {
    queries++;
    return {ids:[doc.id + "-different-query-match"],subs:[],count:1,complete:true,diagnostics:[]};
  }};
  globalThis.AtriumPrint = {prepareDocument(_project, {presentation,links}, _providers, consume) {
    assert.equal(links,true);
    publications++;
    jobs = presentation;
    return consume({pages:jobs.map(job=>({viewId:job.id,title:job.title,doc:job.documentId,w:job.paper[0],h:job.paper[1]})),
      notes:[], links:jobs.length, bytes:() => new Uint8Array([2])});
  }};
  try {
    const receipt = await invoke({ids});
    assert.deepEqual(reads,[500,500],"selection and frame lookup share a single scan of each requested sheet");
    assert.equal(queries,12,"each view retains its native filter resolution");
    assert.deepEqual(receipt.result.pages.map(page=>page.id),ids);
    assert.equal(receipt.result.notes.length,12);
    assert.deepEqual(receipt.result.pages.slice(0,2).map(page=>[page.width,page.height]),[[720,540],[720,405]]);
    assert.ok(!JSON.stringify(jobs).includes(privateText));
    assert.deepEqual(jobs.slice(0,4).map(job=>[job.documentId,job.camera.cx]),[[sensor.id,0],[sensor.id,34],[top.id,0],[top.id,24]]);
    assert.deepEqual(jobs.slice(0,4).map(job=>[job.filter?.mask,job.filter?.rows[0].id]),
      [[false,sensor.id + "-different-query-match"],[undefined,undefined],[true,top.id + "-different-query-match"],[undefined,undefined]]);
    assert.deepEqual(jobs[0].selection,["item-499",selected]);
    assert.deepEqual(jobs[0].missingSelection,["missing-1"]);
    assert.equal(jobs[0].uri,AtriumLinkRecord.format({projectId:project.id,objectId:ids[0]}));

    const hostProject = {...synthetic,documents:docs.map(({items,...doc})=>doc)};
    const folderProject = {ensureDocument(docId) {
      const index = docs.findIndex(doc=>doc.id === docId);
      opens[index]++;
      return Promise.resolve(docs[index]);
    }};
    globalThis.AtriumNavHost = {project:()=>hostProject,documentRefs:()=>hostProject.documents,folderProject:()=>folderProject};
    const planned = await invoke({ids},{source:"editor",project:hostProject,mode:"plan"});
    assert.deepEqual(opens,[1,1],"a planned slide export validates each cold source once");
    assert.deepEqual(planned.result.slideIds,ids);
    assert.equal(planned.file,undefined);
    assert.equal(publications,1);

    const broken = {...synthetic,documents:[{...top,items:[{id:frameId,kind:"wire"}]},sensor]};
    for (const mode of ["plan","write"])
      await assert.rejects(invoke({ids:[slides[0].id,slides[4].id]},{project:broken,mode}), {code:"missing_frame"});
    await assert.rejects(invoke({ids:[slides[1].id]},{project:{...synthetic,savedViews:[]}}), {code:"missing_view"});
    await assert.rejects(invoke({ids},{isCurrent:()=>!abort,enabled:()=>{abort = true;return false;}}), {code:"stale_slide"});
    assert.equal(publications,1,"broken and stale source plans publish nothing");
  } finally {
    delete globalThis.AtriumPrint;
    delete globalThis.AtriumQuery;
    delete globalThis.AtriumNavHost;
  }
}

async function test() {
  assert.equal(manifest.header.formatVersion, "2.1");
  assert.equal(new TextDecoder().decode(F.serialize(manifest)), fs.readFileSync(path.join(fixture, "Slide study.waffle"), "utf8"));
  assert.equal(M.createManifest({...project, savedViews:[], slides:[]}).header.formatVersion, "2.0");
  assert.equal(M.createManifest({...project, savedViews:[]}).header.formatVersion, "2.1");
  assert.equal(S.resolve(project, first.id).status, "ready");
  assert.deepEqual(S.resolve(project, first.id).camera.center, [24, 13.5]);
  assert.deepEqual(S.resolve(project, first.id).viewport, {pixelWidth:1024,pixelHeight:576});
  assert.deepEqual(S.resolve(project, second.id).missingSelection, [id(90)]);
  assert.equal(S.resolve(project, second.id).status, "partial");
  const onceRemoved = {...project, documents:[{...project.documents[0], items:[]}, project.documents[1]]};
  assert.equal(S.resolve(onceRemoved, first.id).status, "missing-frame");
  assert.equal(S.resolve({...project, documents:[{id:id(2)}]}, first.id).status, "loading-document");
  assert.equal(S.resolve({...project, documents:[]}, first.id).status, "missing-document");
  assert.equal(S.resolve({...project, savedViews:[]}, second.id).status, "missing-view");
  assert.equal(S.resolve(project, id(999)).status, "missing-slide");
  assert.deepEqual(S.paper(first.aspect), [720,405]);
  assert.deepEqual(S.paper(second.aspect), [720,540]);
  referencedViewResolution();

  for (const bad of [
    {...first, id:"provisional-id"},
    {...first, name:"\t  "},
    {...first, notes:"unsafe\u0001"},
    {...first, notes:"x".repeat(16385)},
    {...first, aspect:"1:1"},
    {...first, source:{...first.source, savedViewId:id(10)}}
  ]) assert.throws(() => M.checkSlide(bad));
  assert.equal(M.checkSlide({...first, notes:"Line one.\t🧪\r\nLine two."}).id, first.id);
  assert.throws(() => M.createManifest({...project, slides:Array.from({length:129}, (_, n) => ({...first, id:id(200 + n)}))}), /Too many slides/);
  assert.throws(() => S.reorder(project, [first.id, first.id, third.id]), {code:"invalid_slides"});
  assert.throws(() => S.reorder(project, [first.id, second.id]), {code:"invalid_slides"});
  assert.throws(() => S.add(onceRemoved, first), {code:"missing_frame"});
  assert.equal(S.update(project, {id:first.id}).ops.length, 0);

  const nativePatch = S.update(project, {id:first.id, notes:"Changed."});
  const written = F.applyDelta(manifest, M.manifestEdits(manifest, {...project, slides:nativePatch.ops[0].after})).file;
  assert.equal(M.manifest(written).project.slides[0].notes, "Changed.");
  assert.equal(written.rawRecord(second.id), manifest.rawRecord(second.id));
  assert.equal(written.rawRecord(third.id), manifest.rawRecord(third.id));
  const reversed = S.reorder(project, [third.id,second.id,first.id]);
  const arranged = F.applyDelta(manifest, M.manifestEdits(manifest, {...project, slides:reversed.ops[0].after})).file;
  assert.deepEqual(M.manifest(arranged).project.slides.map(slide => slide.id), [third.id,second.id,first.id]);

  U.reset(project); U.record(project);
  const undo = [], redo = [], before = U.mark(project), proposal = B.proposal(project, "butter.slides.update", nativePatch.ops);
  P.applyChecked(project, proposal, {validate:p => Atrium.validate(p, {normalize:false}), trial:false});
  U.checkpoint(undo,redo,before,"Update Slide");
  U.record(project);
  assert.equal(undo.length, 1);
  assert.equal(project.slides[0].notes, "Changed.");
  assert.ok(U.jump(undo,redo,U.mark(project),-1)); U.record(project);
  assert.equal(project.slides[0].notes, first.notes);

  const startedAt = 200, prior = {documentId:id(2)}, deck = S.start(project, {}, null, prior, startedAt);
  assert.equal(S.presenter(project, deck, startedAt - 1).elapsedMs, 0);
  assert.equal(S.presenter(project, deck, startedAt + 123).elapsedMs, 123);
  assert.equal(S.presenter(project, deck, startedAt + 2 * S.timerLimit).elapsedMs, S.timerLimit);
  assert.equal(S.presenter(project, deck, startedAt).next.id, second.id);
  const ending = S.advance(deck, {index:127});
  assert.equal(S.presenter(project, ending).canGoNext, false);
  assert.equal(S.advance(ending, {direction:1}).index, ending.index);
  assert.equal(S.start(project, {index:1}, deck, null).prior, prior);
  assert.equal(S.start({...project, slides:[]}, {}, null, prior), null);
  assert.equal(S.presenter({...project, slides:[]}, null).status, "empty");
  await exportBatch();

  // Polling presenter metadata never iterates source geometry or arms an active timer.
  const scanned = new Proxy(project.documents[0].items, {get(_, key) {
    if (key === Symbol.iterator || key === "find") throw new Error("Presentation polling scanned design items");
  }});
  const max = {...project, slides:Array.from({length:128}, (_, n) => ({...first, id:id(200 + n)})),
    documents:[{...project.documents[0], items:scanned}, project.documents[1]]};
  const maxDeck = S.start(max, {index:127}, null, null), begin = performance.now();
  for (let n = 0; n < 10000; n++) assert.equal(S.presenter(max, maxDeck).total, 128);
  const ms = performance.now() - begin;
  assert.equal(S.describeMany(max, {offset:120}).slides.length, 8);
  assert.doesNotThrow(() => B.check(spec.apply, {id:first.id}, "mcp", "plan", false));
  for (const command of Object.values(spec)) assert.throws(() => B.check(command, {path:"/unexpected"}, "mcp", "plan", false), {code:"invalid_arguments"});
  console.log("PASS native slide rows, single Undo, source/empty/partial behavior and bounded presentation state");
  console.log("Presenter 128 slides: 10,000 polls in " + ms.toFixed(1) + " ms; no source geometry reads");
}
test().catch(error => { console.error(error); process.exitCode = 1; });
