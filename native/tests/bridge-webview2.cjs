"use strict";
// The WebView2 (Windows) branch of native/bridge.js: chrome.webview carries requests,
// host messages carry replies and commands, and subframes never get AtriumHost.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = fs.readFileSync(path.join(__dirname, "../bridge.js"), "utf8");
const appSource = name => fs.readFileSync(path.join(__dirname,"../../app",name),"utf8");

function load({top = true, mac = false, gtk = false, launch = false, workspace = false} = {}) {
  const calls = [], events = [], listeners = [];
  const webview = {postMessage(s) { calls.push(JSON.parse(s)); }, addEventListener(type, fn) { if (type === "message") listeners.push(fn); }};
  const windowEvents = new EventTarget(), document = new EventTarget();
  document.hasFocus = () => true;
  const native = mac || gtk ? {webkit:{messageHandlers:{atriumHost:webview}}} : {chrome:{webview}};
  const window = {...native, dispatchEvent(e) { events.push(e); },
    addEventListener: windowEvents.addEventListener.bind(windowEvents), removeEventListener: windowEvents.removeEventListener.bind(windowEvents)};
  window.top = top ? window : {};
  const CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
  const context = {window, document, innerWidth:800, innerHeight:600, AbortController, DOMException, File, atob, btoa,
    Uint8Array, TextEncoder, TextDecoder, CustomEvent};
  if (gtk) context.__waffleTopFramePost = text => webview.postMessage(text);
  let notify, dialog = false;
  const frames = [], timers = [];
  if (launch) {
    window.__waffleLaunchSettle = true;
    window.__waffleWorkspaceLaunch = workspace;
    window.document = document;
    document.readyState = "loading";
    document.querySelector = selector => selector === "dialog[open]" && dialog;
    context.MutationObserver = class {
      constructor(handler) { notify = handler; }
      observe() {}
      disconnect() { notify = null; }
    };
    context.requestAnimationFrame = callback => frames.push(callback);
    context.setTimeout = (callback, delay) => timers.push({callback, delay});
  }
  vm.runInNewContext(source, context);
  const host = message => mac ? window.__atriumReceive(message.id,message.result,message.error) : listeners.forEach(fn => fn({data:message}));
  return {window, windowEvents, calls, events, host, listeners, context, frames, timers,
    openDialog() { dialog = true; notify?.(); }};
}

async function launchSettle() {
  const gtk = load({gtk:true, launch:true});
  assert.deepEqual(gtk.calls, [], "GTK stays transparent during page load");
  gtk.context.document.readyState = "interactive";
  gtk.openDialog();
  gtk.frames.shift()();
  assert.deepEqual(gtk.calls, [], "Welcome paints before GTK is asked to reveal");
  gtk.frames.shift()();
  gtk.timers.find(timer => timer.delay === 100).callback();
  assert.deepEqual(gtk.calls, [{action:"launchReady"}], "the frame and timer paths only reveal once");

  const windows = load({launch:true});
  windows.context.document.readyState = "complete";
  windows.context.AtriumPref = {get: () => "never"};
  let restore;
  let starter = true, preparations = 0;
  windows.context.AtriumNavHost = {isStarter: () => starter, prepareLaunch: () => ++preparations};
  windows.context.AtriumAutosave = {boot: () => new Promise(resolve => {
    restore = () => { starter = false; resolve(); };
  })};
  windows.timers.shift().callback();
  assert.deepEqual(windows.calls, [], "disabling Welcome still waits for recovery");
  assert.equal(windows.frames.length, 0);
  assert.equal(preparations, 0);
  restore();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(preparations, 1, "the recovered project prepares Properties before the host reveals");
  windows.timers.find(timer => timer.delay === 100).callback();
  assert.deepEqual(windows.calls, [{action:"launchReady"}], "an occluded WebView2 can reveal without animation frames");

  const detached = load({launch:true, workspace:true});
  detached.window.__atriumOpeningProject = true;
  detached.context.document.readyState = "complete";
  detached.context.AtriumPref = {get: () => "never"};
  let finishArrival;
  let displayed = false;
  detached.context.AtriumNavHost = {isStarter: () => !displayed};
  detached.context.AtriumLazy = {need: async () => ({receive: () => new Promise(resolve => {
    finishArrival = () => { displayed = true; resolve(); };
  })})};
  const arrival = detached.window.__waffleWorkspaceEvent({type:"arrival"});
  await new Promise(resolve => setImmediate(resolve));
  detached.openDialog();
  assert.deepEqual(detached.calls, []);
  assert.equal(detached.timers.length, 0, "a detached window does not use the ordinary reveal timer");
  assert.equal(detached.window.__atriumOpeningProject, true);
  finishArrival();
  await arrival;
  assert.equal(detached.window.__atriumOpeningProject, false);
  detached.frames.shift()();
  detached.frames.shift()();
  assert.deepEqual(detached.calls, [{action:"launchReady"}], "a detached window reveals after its own document loads");

  const missing = load({gtk:true, launch:true, workspace:true});
  missing.window.__atriumOpeningProject = true;
  missing.context.AtriumNavHost = {isStarter: () => true};
  await missing.window.__waffleWorkspaceEvent({type:"arrival"});
  assert.deepEqual(missing.calls, [{action:"workspaceLaunchFailed"}], "an unavailable detached project requests a native failure dialog");
}

async function currentFolderActions(mac) {
  const {window, calls, host} = load({mac}), H = window.AtriumHost;
  const reply = result => host({id:calls.at(-1).id, result});
  assert.equal(H.canRevealProject,false);
  assert.equal(await H.revealProject(),false);
  await assert.rejects(H.collabLocks(),{name:"AbortError"});
  assert.equal(calls.length,0,"transient and foreign views have no folder actions");
  const adopt = H.folderAdopt({grant:"file-backed"});
  reply(true); await adopt;
  assert.equal(H.canRevealProject,mac);
  if (mac) {
    const reveal = H.revealProject();
    assert.deepEqual([calls.at(-1).action,calls.at(-1).grant],["revealProject","file-backed"]);
    reply(true); await reveal;
  }
  const status = H.gitQuery("lfsStatus");
  assert.deepEqual([calls.at(-1).op,calls.at(-1).token],["lfsStatus","file-backed"]);
  reply({git:true}); await status;
  const write = H.collabLockWrite("file-backed","d-sheet",{doc:"sheet"},"create");
  const earlier = calls.at(-1);
  assert.equal(earlier.grant,"file-backed");
  const close = H.folderClose({grant:"file-backed"});
  reply(true); await close;
  host({id:earlier.id,result:{written:true}});
  await assert.rejects(write,{name:"AbortError"});
  assert.equal(H.canRevealProject,false);
  const cancelled = H.folderAdopt({grant:"cancelled"});
  const pending = calls.at(-1);
  const closing = H.folderClose({grant:"cancelled"});
  reply(true); await closing;
  host({id:pending.id,result:true});
  assert.equal(await cancelled,false);
  assert.equal(H.folderGitGrant,null);
  await assert.rejects(H.collabLockRemove("file-backed","d-sheet"),{name:"AbortError"});
}

// Hold the native acknowledgement and the first image-tool load independently. The
// same real bridge handles delayed host messages and the final single-use placement.
async function notebookDrops() {
  const {window, windowEvents, calls, host, context} = load();
  context.document.documentElement = {dataset:{release:"apricot-preview"},toggleAttribute(){}};
  vm.runInNewContext(appSource("editor/labs.js"),context);
  let enabled=false, sync;
  context.AtriumLabs.bind({get:()=>enabled,on(_key,listener){sync=listener;}});
  const setLabs = next => {enabled=next; sync();};
  const sheets = [{kind:"schematic", id:"cover"}, {kind:"schematic", id:"gallery"}], session = {grant:"folder"};
  let doc = sheets[0], currentSession = session, inputLoads = 0, imageLoads = 0, resumeLoad;
  const events = new EventTarget(), placed = [];
  const editor = context.AtriumNavHost = {doc:()=>doc, folderProject:()=>currentSession,
    on(type, fn) { events.addEventListener(type, fn); return () => events.removeEventListener(type, fn); }, info:assert.fail};
  context.AtriumNotebookImageDrop = {capture() {
    const first = doc, folder = currentSession, stop = new AbortController();
    const current = () => !stop.signal.aborted && first === doc && folder === currentSession;
    const offDoc = editor.on("document", () => { if (!current()) stop.abort(); });
    const offProject = editor.on("replace", () => stop.abort());
    return {doc:first, session:folder, signal:stop.signal, current, close() { offDoc(); offProject(); }};
  }};
  const ui = {dropCaptured(grant, token, x, y, {signal}) { placed.push({grant, token, x, y, signal}); }};
  context.AtriumLazy = {need(name) {
    if (name === "AtriumNotebookNativeInput") {
      inputLoads++; vm.runInNewContext(appSource("notebook/notebook-native-input.js"),context);
      return Promise.resolve(context.AtriumNotebookNativeInput);
    }
    assert.equal(name,"AtriumNotebookImageUI");
    imageLoads++; return new Promise(resolve => { resumeLoad = () => resolve(ui); });
  }};
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const last = action => calls.findLast(c => c.action === action);
  const reply = (request, result) => host({id:request.id, result});
  const go = n => { doc = sheets[n]; events.dispatchEvent(new Event("document")); };
  function offer(token, target = last("notebookDropTarget")) {
    host({type:"notebookDropOffer", grant:target.grant, ownerId:target.ownerId, epoch:target.epoch, dropToken:token, x:.25, y:.5});
  }
  const adopted = window.AtriumHost.folderAdopt({grant:session.grant});
  reply(last("folderAdopt"), true); await adopted;
  assert.equal(inputLoads,0,"cold Labs-off folder never loads the typed drop implementation");
  assert.equal(last("notebookDropTarget"),undefined);
  offer("off",{grant:session.grant,ownerId:"cover",epoch:0});
  assert.equal(last("notebookDropCancel").dropToken,"off");
  setLabs(true); await tick();
  assert.equal(inputLoads,1);
  const first = last("notebookDropTarget");
  go(1); go(0); offer("delayed", first);
  assert.equal(last("notebookDropCancel").dropToken, "delayed");
  assert.equal(last("notebookDropAccept"), undefined, "a queued offer cannot bind a sheet after leaving and returning");

  offer("reading"); const inspection = last("notebookDropAccept");
  go(1); go(0); reply(inspection, true); await tick();
  assert.equal(imageLoads, 0, "a cancelled inspection cannot begin a lazy tool load");
  offer("loading"); reply(last("notebookDropAccept"), true); await tick();
  assert.equal(imageLoads, 1);
  go(1); go(0); resumeLoad(); await tick();
  assert.equal(placed.length, 0, "returning to the same sheet while the tool loads cannot revive a drop");
  offer("unfocused"); reply(last("notebookDropAccept"), true); await tick();
  windowEvents.dispatchEvent(new Event("blur")); resumeLoad(); await tick();
  assert.equal(placed.length, 0, "leaving the editor window revokes a classified offer");

  offer("old"); const earlier = last("notebookDropAccept");
  offer("new"); const fresh = last("notebookDropAccept");
  host({type:"notebookDropCancelled", grant:session.grant, dropToken:"old"});
  reply(earlier, false); reply(fresh, true); await tick(); resumeLoad(); await tick();
  assert.deepEqual(placed.map(({grant, token, x, y}) => [grant, token, x, y]), [["folder","new",200,300]],
    "a later gesture lands once at its own point despite a late revocation of an earlier one");
  offer("navigating"); const leaving = last("notebookDropAccept");
  windowEvents.dispatchEvent(new Event("pagehide")); reply(leaving, true); await tick();
  assert.equal(last("notebookDropTarget").ownerId, null, "a hidden or navigating page withdraws its receiving sheet");
  windowEvents.dispatchEvent(new Event("pageshow"));
  assert.equal(last("notebookDropTarget").ownerId, "cover");
  offer("disabling"); reply(last("notebookDropAccept"),true); await tick();
  setLabs(false); resumeLoad(); await tick();
  assert.equal(last("notebookDropTarget").ownerId,null);
  assert.equal(last("notebookDropCancel").dropToken,"disabling");
  assert.equal(placed.length,1,"disabling cannot commit an in-flight drop");
  setLabs(true); await tick();
  assert.equal(last("notebookDropTarget").ownerId,"cover");
  offer("closing"); const closing = last("notebookDropAccept");
  currentSession = {grant:"replacement"}; events.dispatchEvent(new Event("replace")); reply(closing, true); await tick();
  assert.equal(last("notebookDropTarget").ownerId, null);
  assert.equal(placed.length, 1, "a replacement project with the same sheet ID cannot consume the old grant");
}

async function typedDrops() {
  const {window, calls, host, context} = load();
  const {document}=context, canvas={}, events=new EventTarget();
  const item={id:"table",widget:{type:"table",state:"initial"}}, doc={id:"sheet",kind:"schematic"}, project={};
  let edits=0, target=canvas, hit=item;
  window.innerWidth=800; window.innerHeight=600;
  document.elementFromPoint=()=>target;
  document.querySelector=()=>null;
  context.AtriumPrefs={get:key=>key==="butter.drop",on:()=>()=>{}};
  context.AtriumNavHost={canvas:()=>canvas,doc:()=>doc,project:()=>project,revision:()=>0,folderProject:()=>null,
    hit:()=>({doc,item:hit,point:[1,2]}),on(type,fn){events.addEventListener(type,fn);return ()=>events.removeEventListener(type,fn);},
    info:assert.fail,edit(change){change();edits++;return true;}};
  let dropUIRegistered=false;
  context.AtriumLazy={
    register(name, spec) {
      assert.equal(name,"AtriumDropUI");
      assert.deepEqual([...spec.scripts],["editor/drop-ui.js"]);
      dropUIRegistered=true;
    },
    async need(name) {
      if (name==="AtriumDropUI") {
        assert.ok(dropUIRegistered);
        return {install(){}};
      }
      assert.equal(name,"AtriumDropEditor");
      return context.AtriumDropEditor;
    }
  };
  context.AtriumDropData={table(_item,bytes){return {state:new TextDecoder().decode(bytes)};}};
  for (const name of ["project/drop-receiver.js","editor/drop-editor.js"]) vm.runInNewContext(appSource(name),context);
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  const last=action=>calls.findLast(row=>row.action===action);
  function offer(token) {
    host({type:"butterDropOffer",token,x:.25,y:.5,file:{name:"drop.csv",mime:"text/csv",size:3}});
  }
  target={};
  offer("toolbar");await tick();
  assert.equal(last("butterDropTake"),undefined);
  assert.deepEqual(last("butterDropFinish"),{action:"butterDropFinish",token:"toolbar",handled:false});
  target=canvas;hit=null;
  offer("blank-sheet");await tick();
  assert.equal(last("butterDropTake"),undefined);
  hit=item;
  offer("cancelled");await tick();
  const pending=last("butterDropTake");
  assert.equal(pending.token,"cancelled");
  const escape=new Event("keydown");Object.defineProperty(escape,"key",{value:"Escape"});
  document.dispatchEvent(escape);
  assert.deepEqual(last("butterDropCancel"),{action:"butterDropCancel",token:"cancelled"});
  host({id:pending.id,result:{name:"drop.csv",mime:"text/csv",data:"YSxi"}});
  await tick();
  assert.equal(edits,0);
  offer("applied");await tick();
  const take=last("butterDropTake");
  assert.equal(take.token,"applied");
  host({id:take.id,result:{name:"drop.csv",mime:"text/csv",data:"YSxi"}});
  await tick();
  assert.equal(edits,1);
  assert.equal(item.widget.state,"a,b");
  assert.deepEqual(last("butterDropFinish"),{action:"butterDropFinish",token:"applied",handled:true});
}

async function main() {
  await launchSettle();
  await currentFolderActions(false);
  await currentFolderActions(true);
  await typedDrops();
  const framed = load({top: false});
  assert.equal(framed.window.AtriumHost, undefined, "a subframe gets no bridge");
  assert.equal(framed.listeners.length, 0);

  const {window, calls, events, host, context} = load();
  const api = window.AtriumHost;
  assert.ok(api, "the top-level document gets AtriumHost");
  const listed = api.refreshRecentFiles();
  assert.equal(calls.at(-1).action, "recentFiles");
  host({id: calls.at(-1).id, result: [{name: "A.waffle", path: "C:\\design\\A.waffle", openedAt: 1}], error: null});
  assert.equal((await listed)[0].path, "C:\\design\\A.waffle");

  const failing = api.folderCommit({grant:"current",plan:[{path:"A.wsch",data:"e30="}]});
  assert.equal(calls.at(-1).action,"folderCommit");
  assert.equal(calls.at(-1).grant,"current");
  host({id: calls.at(-1).id, result: null, error: "The project file changed on disk."});
  await assert.rejects(failing, /changed on disk/);

  // Library reloads accept Windows drive and UNC paths, never relative or device paths.
  for (const ok of ["C:\\libs\\parts.atrlib", "\\\\server\\share\\parts.atrlib", "/libs/parts.atrlib"]) {
    const read = api.readFile(ok);
    assert.equal(calls.at(-1).path, ok);
    host({id: calls.at(-1).id, result: {name: "parts.atrlib", path: ok, text: "{}"}});
    assert.equal((await read).path, ok);
  }
  for (const bad of ["parts.atrlib", "..\\parts.atrlib", "\\\\?\\C:\\x.atrlib", "\\\\.\\pipe\\x", "C:parts.atrlib"])
    await assert.rejects(api.readFile(bad), /library file path/, bad);

  // Host commands: menu actions and the extension kill switch.
  host({command: "open"});
  assert.equal(events.at(-1).type, "atrium-command");
  assert.equal(events.at(-1).detail, "open");
  const before = events.length;
  host({command: "pause-extensions"});
  assert.equal(events.length, before, "pause does not dispatch a page command");
  // Save on the native close prompt: the page's own save, then {action:"saveForClose", saved} for the host.
  const until = async test => { for (let n = 0; n < 50 && !test(); n++) await new Promise(r => setTimeout(r, 0)); };
  let dirty = true, saveResult = true;
  context.AtriumNavHost = {saveProject: async () => { if (saveResult) dirty = false; return saveResult; }, isDirty: () => dirty};
  host({command: "save-for-close"});
  await until(() => calls.at(-1).action === "saveForClose");
  assert.deepEqual(calls.at(-1), {action: "saveForClose", saved: true}, "a finished save reports saved");
  assert.equal(events.at(-1).detail, "open", "save-for-close is not a page command");
  dirty = true; saveResult = false;
  const count = calls.length;
  host({command: "save-for-close"});
  await until(() => calls.length > count);
  assert.deepEqual(calls.at(-1), {action: "saveForClose", saved: false}, "a cancelled save dialog reports not saved");
  context.AtriumNavHost.saveProject = async () => true;
  assert.equal(await window.__atriumSaveForClose(), false, "a save that leaves edits unsaved is not saved");
  assert.equal(calls.length, count + 1, "without report nothing is posted");
  delete context.AtriumNavHost;
  assert.equal(await window.__atriumSaveForClose(), false, "no editor, nothing saved");
  host("not an object"); host(null); host({id: 99999, result: 1});
  await notebookDrops();
  console.log("Passed GTK/WebView2 launch and WebView2 bridge, including ownership of delayed native drops.");
}
main().catch(e => { console.error(e); process.exitCode = 1; });
