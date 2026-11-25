"use strict";
// File and object History can close their dialogs before the comparison viewer finishes loading.
// Source completeness metadata and the original file's binding must survive that handoff.
const assert = require("node:assert/strict");
require("../../app/history/source-history.js");
async function checkNativeSourceGrant() {
  const calls = [];
  const window = {webkit: {messageHandlers: {atriumHost: {postMessage: text => calls.push(JSON.parse(text))}}}};
  window.top = window;
  const bridge = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../native/bridge.js"), "utf8");
  class File { constructor(parts, name) { this.name = name; } }
  const vm = require("node:vm");
  vm.runInContext(bridge, vm.createContext({window, File, Uint8Array, atob: () => ""}));
  const host = window.AtriumHost;
  const reply = (result, packet=calls.at(-1)) => window.__atriumReceive(packet.id, result);
  const revision = "1".repeat(40);
  const sourceOnly = [["sourceLog", {limit: 2}], ["sourceRevision", {revision}]];
  const deniedSource = /Open an Altium or KiCad design/;

  const native = host.open();
  reply([{name:"board.waffle", folderProject:{grant:"folder-grant", manifest:"board.waffle", name:"Board"}}]);
  const [{folderProject}] = await native;
  assert.equal(host.folderGitGrant, null);
  const adopt = host.folderAdopt({grant:folderProject.grant});
  assert.equal(calls.at(-1).action, "folderAdopt");
  reply(true);
  await adopt;
  assert.equal(host.folderGitGrant, "folder-grant");
  const status = host.gitQuery("status");
  assert.equal(calls.at(-1).token, "folder-grant");
  reply({head:revision});
  assert.equal((await status).head, revision);
  const initial = calls.length;
  for (const [op, args] of sourceOnly) {
    await assert.rejects(host.gitQuery(op, args), /does not run/);
    await assert.rejects(host.historyQuery(op, args), deniedSource);
  }
  assert.equal(calls.length, initial);

  const pick = host.pickFile([".schdoc"]);
  reply([{name:"Sheet.SchDoc", data:"", sourceToken:"altium-copy"}]);
  const copy = await pick;
  host.acceptHistorySource([copy]);
  assert.equal(host.historyPath, null);
  assert.equal(host.folderGitGrant, null);
  const afterPick = calls.length;
  await assert.rejects(host.historyQuery("sourceLog", {limit:2}), deniedSource);
  assert.equal(calls.length, afterPick, "a source copy has no Git history grant");

  const opened = host.open();
  reply([{name:"board.kicad_pcb", data:"", historyToken:"source-grant"}]);
  const [source] = await opened;
  const beforeAccept = calls.length;
  await assert.rejects(host.historyQuery("sourceLog", {limit:2}), deniedSource);
  assert.equal(calls.length, beforeAccept, "picking a file alone does not bind its history");
  host.acceptHistorySource([source]);
  assert.deepEqual(calls.at(-1), {action:"acceptHistorySource",token:"source-grant"});
  assert.equal(host.historyPath, "board.kicad_pcb");
  assert.equal(host.folderGitGrant, null);
  const accepted = calls.length;
  for (const op of ["fileLog","read","folderRevisions","mergeDriverPlan","installMergeDriver"]) {
    await assert.rejects(host.historyQuery(op, {}), deniedSource);
    await assert.rejects(host.gitQuery(op, {}), /Save or open a Waffle project/);
  }
  assert.equal(host.canConvertSibling(source), false);
  await assert.rejects(host.exportBinaryCopy("copy.SchDoc",new Uint8Array(),source), /Select the original Altium document/);
  assert.equal(calls.length, accepted, "the read-only history grant never reaches unrelated native operations");
  for (const [op, args] of [...sourceOnly, ["projectLog",{limit:2}], ["projectBlobs",{revisions:[revision]}]]) {
    const result = host.historyQuery(op, args);
    const packet = calls.at(-1);
    assert.deepEqual([packet.action, packet.token, packet.op, packet.args], ["gitQuery", "source-grant", op, args]);
    reply({ok:true});
    assert.equal((await result).ok, true);
  }
  const pending = host.historyQuery("sourceRevision", {revision}), previous = calls.at(-1);
  const next = host.open();
  reply([{name:"board.kicad_pcb", data:"", historyToken:"next-source"}]);
  host.acceptHistorySource(await next);
  reply({ok:true},previous);
  await assert.rejects(pending, /active project changed/);
  host.clearProjectPath();
  const cleared = calls.length;
  await assert.rejects(host.historyQuery("sourceLog", {}), deniedSource);
  assert.equal(calls.length, cleared);
}
async function run() {
  await checkNativeSourceGrant();
  globalThis.AtriumHost = {historyPath: "review.PrjPcb", projectGeneration: 1};
  const snapshot = {project: {documents: []}, blob: "abc", unavailableLibraries: 2};
  let signal;
  globalThis.AtriumGit = {specLabel: () => "Test revision"};
  globalThis.AtriumProjectHistoryData = {source: () => ({
    async project(revision, owner) { signal = owner; return snapshot; }, close() {}
  })};
  const source = AtriumSourceHistory.open();
  const side = await source.side({type: "commit", rev: "old"});
  assert.equal(side.unavailableLibraries, 2);
  assert.equal(side.blob, snapshot.blob);
  assert.equal(side.project, snapshot.project);
  assert.ok(source.bound());
  source.close();
  assert.ok(signal.aborted, "closing stops pending source reads");
  assert.ok(source.bound(), "dismissal for Compare retains ownership of the same open file");
  AtriumHost.projectGeneration++;
  assert.equal(source.bound(), false, "a newly granted file with the same display name must cancel a cold Compare");
  console.log("PASS native source grants, source comparison warning and file ownership");
}
globalThis.__testDone = run().catch(e => { console.error(e); process.exitCode = 1; });
