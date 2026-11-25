"use strict";
const assert = require("node:assert/strict");
globalThis.document = {querySelector:()=>null, baseURI:"https://example.invalid/app/"};
require("../../app/history/project-history-summary.js");
require("../../app/history/project-history-data.js");
require("../../app/history/git-picker.js");
const signal = () => new AbortController();
const pause = () => new Promise(resolve=>setTimeout(resolve,0));

(async()=>{
  const data = AtriumProjectHistoryData;
  const waiting = [];
  const call = (op,args)=>new Promise(yes=>waiting.push(()=>yes({blobs:Object.fromEntries(args.revisions.map(r=>[r,r]))})));
  globalThis.AtriumHost={historyPath:"Board.kicad_pcb",projectGeneration:1,historyQuery:call};
  const source=data.source(AtriumGit), first=signal(), second=signal(), third=signal();
  const a="a".repeat(40), b="b".repeat(40), c="c".repeat(40);
  const p=source.resolve(null,a,first.signal);await pause();
  first.abort();await assert.rejects(p,/cancelled/);
  const q=source.resolve(null,b,second.signal);await pause();
  const r=source.resolve(null,c,third.signal);await pause();
  assert.equal(waiting.length,2,"The cancelled native read and its replacement occupy at most two slots");
  third.abort();await assert.rejects(r,/cancelled/);
  waiting[1]();assert.deepEqual(await q,[null,b]);
  waiting[0]();await pause();
  assert.deepEqual(await source.resolve(null,b,signal().signal),[null,b]);
  source.refresh();
  const stale=source.resolve(null,b,signal().signal);await pause();
  assert.equal(waiting.length,3);
  source.refresh();waiting[2]();await assert.rejects(stale,/history changed/);
  source.close();

  let finish, mounted=0, active=true;
  globalThis.AtriumLazy={modules:()=>["AtriumDiffView"],need:()=>new Promise(yes=>{finish=yes;})};
  const compare=AtriumGit.compare({}, {}, {active:()=>active});
  active=false;globalThis.AtriumDiffView={start:()=>mounted++};finish();
  await assert.rejects(compare,/active project changed/);
  assert.equal(mounted,0,"A cold Compare cannot open its former project after cancellation");
  // A failed visual load keeps the same sides and shared-review action for Retry.
  const before = {project:{}, label:"Shared project now"}, after = {project:{}, label:"Checkpoint"};
  const reviewAction = {label:"Restore for everyone…", run() {}}, calls = [], notices = [];
  globalThis.AtriumNavCommon = {el: (_, text) => text};
  globalThis.AtriumShell = {dialog(spec) {
    let choose;
    const done = new Promise(resolve => { choose = resolve; });
    notices.push({spec, choose});
    return {done, close: () => choose(null)};
  }};
  const viewer = {
    start(...args) { calls.push(args); return args; },
    sinceSave(active) { assert.ok(active()); return "Working design"; }
  };
  let fail = true;
  globalThis.AtriumLazy = {async need(name) {
    assert.equal(name, "AtriumDiffView");
    if (fail) throw Error("Load failed");
    return viewer;
  }};
  const compareShared = AtriumGit.compare(before, after, {reviewAction}); await pause();
  assert.deepEqual(notices[0].spec.actions.map(action => action.label), ["Cancel", "Retry"]);
  assert.equal(calls.length, 0);
  fail = false; notices[0].choose("Retry");
  const [left, right, options] = await compareShared;
  assert.equal(left, before);
  assert.equal(right, after);
  assert.equal(options.reviewAction, reviewAction);

  fail = true;
  const cancel = AtriumGit.compare(before, after); await pause();
  notices[1].choose(null);
  assert.equal(await cancel, null);
  assert.equal(calls.length, 1, "dismissing the notice leaves the viewer closed");

  let revision = 1;
  globalThis.AtriumNavHost = {project: () => before.project, revision: () => revision};
  const expired = AtriumGit.compare(before, after); await pause();
  revision++;
  notices[2].choose("Retry");
  await assert.rejects(expired, /active project changed/);
  assert.equal(calls.length, 1, "a retry cannot open a stale comparison");

  const superseded = AtriumGit.compare(before, after); await pause();
  fail = false;
  assert.equal(await AtriumGit.reviewChanges(globalThis.AtriumNavHost), "Working design");
  assert.equal(await superseded, null, "the new Review Changes request closes an older retry");

  console.log("PASS bounded reads, pending cancellation, refreshed rename aliases and comparison retry ownership");
})().catch(e=>{console.error(e);process.exitCode=1;});
