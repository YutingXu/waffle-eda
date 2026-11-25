"use strict";

const assert = require("node:assert/strict");
require("../../app/native-bridge/window-workspace.js");

const W = globalThis.AtriumWindowWorkspace;
const uuid = n => "01938100-0000-7000-8000-" + String(n).padStart(12, "0");
const [project, primary, secondary, next, board, schematic, library, panel] = Array.from({length:8}, (_, i) => uuid(i));
const documents = [board, schematic, library];
const initial = W.initial(project, documents, primary, schematic);
const detached = W.plan(initial, "move-tab-to-new-window", {newWindow:secondary});

assert.deepEqual(initial.windows[0].tabs, documents);
assert.deepEqual(detached.windows.map(window => window.tabs), [[board, library], [schematic]]);
assert.equal(detached.focused, secondary);
assert.equal(detached.windows[0].active, library);
assert.equal(detached.windows[1].active, schematic);

const viewport = {display:"external", left:-1280, top:20, width:1040, height:740};
const split = {direction:"right", secondary:library, ratio:.4};
const changed = W.plan(detached, "window-view", {window:primary, tab:board, bounds:viewport, split});
const restored = W.restore(JSON.parse(JSON.stringify(changed)), project, [board, library, panel], next, library);
assert.deepEqual(restored.missing, [schematic]);
assert.deepEqual(restored.layout, {version:1, project, focused:primary, windows:[{
  id:primary, tabs:[board, library, panel], active:board, bounds:viewport, split
}]});

const merged = W.plan(changed, "merge-all-windows");
assert.deepEqual(merged.windows.map(window => [window.id, window.active, window.tabs]),
  [[secondary, schematic, [board, library, schematic]]]);
assert.equal(merged.focused, secondary);
const closed = W.plan(changed, "close-window", {window:primary});
assert.deepEqual(closed.windows[0].tabs, [schematic, board, library]);
const replaced = W.plan(detached, "move-tab-to-new-window", {newWindow:next});
assert.deepEqual(replaced.windows.map(window => window.id), [primary, next]);

const onlyDetached = W.restore(changed, project, [schematic], primary, schematic, {preserveWriter:true});
assert.deepEqual(onlyDetached.missing, [board, library]);
assert.deepEqual(onlyDetached.layout, {version:1, project, focused:primary, windows:[{
  id:primary, tabs:[schematic], active:schematic, bounds:viewport
}]});
const newWriterTab = W.restore(changed, project, [schematic, panel], primary, panel, {preserveWriter:true});
assert.equal(newWriterTab.layout.focused, secondary);
assert.deepEqual(newWriterTab.layout.windows.map(row=>row.tabs), [[panel],[schematic]]);

assert.throws(() => W.restore({...initial, project:uuid(99)}, project, documents, primary), {code:"invalid_layout"});
assert.throws(() => W.restore({...initial, version:2}, project, documents, primary), {code:"unsupported_layout"});
assert.throws(() => W.restore({...initial, windows:[initial.windows[0], {...initial.windows[0], id:secondary}]},
  project, documents, primary), {code:"invalid_layout"});
assert.throws(() => W.plan(detached, "move-tab-to-new-window", {tab:board, newWindow:next}), {code:"tab_missing"});
assert.throws(() => W.plan(initial, "window-view", {tab:board, bounds:{...viewport, width:-1}}), {code:"invalid_layout"});

globalThis.__testDone = (async () => {
  let revision = 50, epoch = "first writer", shown, barrier, rejectEdit;
  const commands = [];
  globalThis.AtriumNavHost = {on(){}, currentId:()=>schematic, info:message=>{throw Error(message);},
    async replaceProject(view) { shown = view.name; }};
  globalThis.AtriumHost = {async workspaceWindow(request) {
    if (request.operation === "describe") return {writer:false, project, window:secondary, tab:schematic};
    if (request.operation === "command") {
      commands.push(request.value.kind);
      if (request.value.kind === "edit") return new Promise((_,reject)=>{rejectEdit=reject;});
      return true;
    }
    assert.equal(request.operation,"snapshot");
    const packet = {document:schematic, project:{id:project,name:`${epoch} revision ${revision}`}, epoch, revision};
    if (barrier) {
      const pending = barrier;
      barrier = null;
      pending.read();
      await pending.resume;
    }
    return packet;
  }};
  require("../../app/native-bridge/project-window-client.js");
  const client = AtriumProjectWindowClient;
  await client.receive({type:"arrival",tab:schematic});
  await client.receive({type:"change",revision});
  globalThis.AtriumNavHost.info = () => {};
  await client.receive({type:"writer-unavailable"});
  globalThis.AtriumNavHost.info = message => {throw Error(message);};
  epoch = "recovered writer";
  revision = 1;
  await client.receive({type:"view",tab:schematic});
  let read, resume;
  const started = new Promise(resolve=>{read=resolve;});
  barrier = {read,resume:new Promise(resolve=>{resume=resolve;})};
  const firstRefresh = client.receive({type:"change",revision:++revision});
  await started;
  await client.receive({type:"change",revision:++revision});
  resume();
  await firstRefresh;
  assert.equal(shown,"recovered writer revision 3");
  const edit = client.forward("edit"), save = client.forward("save",{all:true});
  await Promise.resolve();
  rejectEdit(Error("Project changed before the field could be committed."));
  assert.deepEqual((await Promise.allSettled([edit,save])).map(row=>row.status),["rejected","rejected"]);
  assert.deepEqual(commands,["edit"]);
  assert.equal(await client.forward("save",{all:true}),true);
  assert.deepEqual(commands,["edit","save"]);
  console.log("Window workspaces preserve tab ownership, recover removed documents, and refresh after writer replacement");
})().catch(error=>{console.error(error);process.exitCode=1;});
