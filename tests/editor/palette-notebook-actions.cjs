"use strict";

// Exercise the provider at its lazy-loader and native picker boundaries, including a
// folder/tab switch while either endpoint is still settling.
const assert = require("node:assert/strict");
require("../fixtures/notebook-labs.cjs").enable();
require("../../app/core/model.js");
require("../../app/schematic/sch-objects.js");
require("../../app/editor/palette-actions.js");
const actions = globalThis.AtriumPaletteActions;

async function main() {
  const sheet = {id:"sheet",kind:"schematic",items:[]}, panel = {id:"panel",kind:"panel",items:[]};
  let active = sheet, editable = true, edits = 0;
  const project = {documents:[sheet,panel],library:[]};
  const folder = {canEdit:id => id === sheet.id && editable}, listeners = new Set(), loads = [], calls = [];
  let session = folder, gate = null, release;
  const host = {
    currentId:() => active.id, doc:() => active, folderProject:() => session, project:() => project,
    defs:() => new Map(), view:() => ({scale:() => 1, query:() => []}),
    edit() {edits++;},
    on(type, f) {assert.equal(type,"document"); listeners.add(f); return () => listeners.delete(f);}
  };
  const available = ["AtriumNotebookImageUI","AtriumCalculationSheet"];
  const media = {canCamera:() => true, insert:async request => {calls.push(request); return gate ? gate : request.source;}};
  const calc = {compose:(h, item, context) => {calls.push({h,item,context}); return "composed";}};
  globalThis.AtriumLazy = {modules:() => available, need:async key => {
    loads.push(key); if (release) await new Promise(resolve => {release.waiter = resolve;});
    return key === "AtriumNotebookImageUI" ? media : calc;
  }};
  globalThis.AtriumHost = {folderPickAsset() {}, folderStageAsset() {}, notebookClip() {}, notebookTransfer() {}, notebookPaste() {}};
  const context = () => {
    const c = {point:Object.freeze([17.5,-4]),kind:active.kind,docId:active.id,selection:[],host};
    return Object.freeze({...c,...actions.context(host,c)});
  };
  const entries = (c=context()) => actions.entries(c);
  const rows = () => entries().filter(e => e.key.startsWith("insert:media-")).map(e => e.key.split("-").at(-1));
  const one = (key, c) => entries(c).find(e => e.key === "insert:" + key);
  const request = c => ({context:c, argument:"", signal:new AbortController().signal});
  const change = doc => {active = doc; for (const f of [...listeners]) f();};

  const initial = context();
  assert.deepEqual(rows(), ["image","pdf","clipboard"]);
  assert.deepEqual(loads,[],"listing and filtering never load a media or expression editor");
  for (const source of rows()) {
    const entry = one("media-" + source,initial), req = request(initial);
    assert.equal(entry.preview(req).kind,"text");
    assert.equal(await entry.run(req),source);
    const call = calls.at(-1); assert.equal(call.host,host); assert.equal(call.source,source);
    assert.deepEqual(call.point,[17.5,-4]); assert.equal(call.signal.aborted,false); assert.equal(listeners.size,0);
  }
  const count = calls.length;
  const stale = one("media-image",initial);
  session = null; assert.deepEqual(rows(),[]); await assert.rejects(stale.run(request(initial)),/editable schematic/);
  session = folder; editable = false;
  assert.deepEqual(rows(),[]); await assert.rejects(stale.run(request(initial)),/editable schematic/);
  editable = true; session = {...folder};
  await assert.rejects(stale.run(request(initial)),/editable schematic/);
  session = folder; assert.equal(calls.length,count);
  assert.equal(edits,0,"denied media actions never enter the editor's Undo transaction");
  delete globalThis.AtriumHost.notebookPaste; assert.ok(!rows().includes("clipboard"));
  delete globalThis.AtriumHost.notebookClip; assert.ok(!rows().includes("pdf"));
  globalThis.AtriumHost.notebookPaste = () => {}; globalThis.AtriumHost.notebookClip = () => {};
  globalThis.AtriumNotebookImageUI = media;
  assert.ok(rows().includes("camera"));
  assert.equal(await one("media-camera",initial).run(request(initial)),"camera");
  delete globalThis.AtriumNotebookImageUI;

  release = {};
  const pending = stale.run(request(initial));
  change(panel); change(sheet); release.waiter(); release = null;
  assert.equal(await pending,undefined); assert.equal(calls.length,count+1);
  const c = context(), req = request(c);
  let complete; gate = new Promise(resolve => {complete = resolve;});
  const picked = one("media-clipboard",c).run(req);
  while (calls.length < count+2) await Promise.resolve();
  change(panel); assert.equal(calls.at(-1).signal.aborted,true); assert.deepEqual(rows(),[]);
  complete(false); await picked; assert.equal(listeners.size,0); gate = null;
  change(sheet);

  const calcContext = context(), row = one("calculation",calcContext);
  assert.deepEqual(row.inline,["calc"]);
  assert.equal(await row.run({...request(calcContext),argument:"3 V * 2"}),"composed");
  assert.equal(calls.at(-1).context.source,"3 V * 2"); assert.deepEqual(calls.at(-1).context.point,[17.5,-4]);
  const dead = new AbortController(); dead.abort();
  assert.equal(await row.run({...request(calcContext),signal:dead.signal}),undefined);
  available.length = 0; assert.deepEqual(rows(),[]); assert.equal(one("calculation",context()),undefined);
  console.log("PASS notebook palette source/permission gates, cold discovery, frozen placement, stale cancellation and calculation composer");
}
main().catch(error => {console.error(error); process.exitCode = 1;});
