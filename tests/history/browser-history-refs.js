"use strict";

// One synthetic project, one authored move, one ordinary Save. Only the temporary
// fixture uses Git writes, to create a baseline before the editor opens.
const assert = require("node:assert/strict");
const {execFileSync} = require("node:child_process");
const {createHash} = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const checkout = require.main === module ? process.argv[2] : undefined;
const root = path.resolve(checkout || path.join(__dirname,"../.."));
const {appServer} = require(path.join(root, "tests/history/browser-project-history.js"));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "waffle-history-probe-"));
const dir = path.join(temp, "project");
const manifest = "Board.waffle";
const ref = "s-R1";
const server = appServer();
const queries = [];
const writes = [];
const git = (...args) => execFileSync("git", [
  "-C", dir, "-c", "user.name=Fixture", "-c", "user.email=history@example.invalid",
  "-c", "commit.gpgSign=false", "-c", "core.hooksPath=" + os.devNull, ...args
], {encoding:"utf8", env:{...process.env, GIT_AUTHOR_DATE:"2025-01-02T03:04:05Z", GIT_COMMITTER_DATE:"2025-01-02T03:04:05Z"}});
const member = name => {
  const file = path.resolve(dir,name);
  assert.ok(file.startsWith(dir + path.sep) && !path.relative(dir,file).split(path.sep).includes(".git"));
  return file;
};
const read = name => fs.existsSync(member(name)) ? fs.readFileSync(member(name)) : null;
function gitState() {
  const base = path.join(dir,".git");
  return Object.fromEntries(fs.readdirSync(base,{recursive:true})
    .filter(name => fs.statSync(path.join(base,name)).isFile())
    .sort().map(name => [name,sha(fs.readFileSync(path.join(base,name)))]));
}
function writePlan({plan}) {
  const hashes = {};
  const files = plan.map(item => {
    const old = read(item.path);
    assert.equal(item.expected, old ? sha(old) : null);
    assert.equal(!!item.remove,false);
    let bytes;
    if (item.text != null) bytes = Buffer.from(item.text);
    else if (item.data != null) bytes = Buffer.from(item.data,"base64");
    else {
      const parts = [];
      let at = 0;
      for (const edit of item.splice.edits) {
        parts.push(old.subarray(at,edit.offset),Buffer.from(edit.insert));
        at = edit.offset + edit.remove;
      }
      bytes = Buffer.concat([...parts,old.subarray(at)]);
    }
    hashes[item.path] = sha(bytes);
    return {name:item.path,bytes};
  });
  for (const file of files) {
    fs.mkdirSync(path.dirname(member(file.name)),{recursive:true});
    fs.writeFileSync(member(file.name),file.bytes);
  }
  writes.push(files.map(file => file.name));
  return {saved:true,hashes,transaction:"fixture-"+writes.length};
}
async function demoHistoryDirty(browser) {
  const page = await browser.newPage({viewport:{width:1320,height:875}});
  try {
    await page.goto("http://127.0.0.1:" + server.address().port + "/app/index.html");
    const start = page.locator("dialog.sp-dialog[open]");
    await start.getByRole("button", {name:"Try the Demo",exact:true}).click();
    await start.waitFor({state:"hidden"});
    await page.waitForFunction(() => globalThis.AtriumHistoryEntry?.status().installed && !AtriumNavHost.isDirty());
    return await page.evaluate(() => {
      const host = AtriumNavHost, transitions = [];
      const unsubscribe = host.on("dirty", dirty => transitions.push(dirty));
      try { host.derive(() => {}, {source:"pours",touched:[]}); }
      finally { unsubscribe(); }
      const badge = document.querySelector(".hv-status");
      const dot = badge.querySelector(".ui-dot");
      return {transitions, modelDirty:host.isDirty(), dotVisible:!dot.hidden && !!dot.getClientRects().length,
        announcedDirty:/unsaved changes/i.test(badge.getAttribute("aria-label"))};
    });
  } finally { await page.close(); }
}

async function pickerSearch(page) {
  await page.evaluate(() => {
    const original = AtriumHost, reads = [];
    const revision = (read,index) => (read * 10 + index).toString(16).padStart(40, "0");
    const date = "2025-01-02T03:04:05Z", head = revision(1,0);
    window.pickerFixture = {
      original, reads,
      input(text, isComposing = false) {
        const input = document.querySelector(".gp-search");
        input.value = text;
        input.dispatchEvent(new InputEvent("input", {bubbles:true, isComposing}));
      },
      reply(i, rows, more = false) {
        reads[i].resolve({commits:rows.map(([subject,touches], index) =>
          ({revision:revision(i,index), subject, touches, author:"Fixture", date, parents:[]})), more});
      }
    };
    window.AtriumHost = {...original, folderGitGrant:"picker-fixture", gitQuery(op,args) {
      if (op === "refs") return new Promise(resolve => {
        pickerFixture.replyRefs = () => resolve({head, ref:"refs/heads/feature",
          refs:[{name:"refs/heads/feature", kind:"branch", short:"feature", revision:head, date}]});
      });
      if (op !== "log") throw Error("Unexpected Git query " + op);
      return new Promise((resolve,reject) => reads.push({args, resolve, reject}));
    }};
    void AtriumGitPicker.pickPair().then(result => { pickerFixture.result = result; });
  });
  const reads = () => page.evaluate(() => pickerFixture.reads.map(read => read.args));
  const waitForReads = count => page.waitForFunction(count => pickerFixture.reads.length >= count, count);
  const search = page.locator(".gp-search");
  const rows = page.locator(".gp-subject");
  await waitForReads(1);
  await page.evaluate(() => {
    pickerFixture.input("partial", true);
    pickerFixture.reply(0, [["Obsolete initial history",true]]);
  });
  await page.waitForFunction(() => !document.querySelector(".gp-list").hasAttribute("aria-busy"));
  assert.equal((await reads()).length, 1, "history waits for committed IME input");
  assert.equal(await rows.count(), 0, "obsolete history never appears under the new term");
  await page.evaluate(() => {
    pickerFixture.input("Panel",true);
    document.querySelector(".gp-search").dispatchEvent(new CompositionEvent("compositionend"));
    pickerFixture.input("Panel updates");
  });
  await search.press("Enter");
  await waitForReads(2);
  assert.deepEqual((await reads())[1],{refs:"all",skip:0,limit:150,search:"Panel updates"});
  await search.press("Enter");
  assert.equal((await reads()).length, 2, "Enter reuses the current search request");
  await page.evaluate(() => pickerFixture.reply(1, [["Panel updates project",true],["Panel updates notes",false]], true));
  await rows.filter({hasText:"Panel updates notes"}).waitFor();
  await search.press("ArrowDown");
  await page.evaluate(() => {
    pickerFixture.selected = document.querySelector(".gp-row[aria-selected=true]");
    pickerFixture.replyRefs();
  });
  await page.locator(".gp-chip").filter({hasText:"feature"}).waitFor();
  assert.ok(await page.evaluate(() => pickerFixture.selected === document.querySelector(".gp-row[aria-selected=true]")),
    "late refs add badges without rebuilding or unselecting the results");
  await page.getByRole("checkbox",{name:"Only commits that changed this file"}).check();
  assert.deepEqual(await rows.allTextContents(), ["Panel updates project"]);
  const more = page.getByRole("button",{name:"Load more commits"});
  await more.evaluate(button => { button.click(); button.click(); });
  await waitForReads(3);
  assert.equal((await reads())[2].skip, 2, "the offset counts all native rows");
  await page.evaluate(() => pickerFixture.reply(2, [["Panel updates again",true]],true));
  await rows.filter({hasText:"Panel updates again"}).waitFor();
  await search.press("Enter");
  assert.deepEqual(await rows.allTextContents(), ["Panel updates project","Panel updates again"]);
  assert.equal((await reads()).length, 3, "Enter preserves pages from a completed search");
  await more.click();
  await waitForReads(4);
  await page.locator(".gp-side").getByRole("button",{name:/feature/}).click();
  await page.evaluate(() => {
    pickerFixture.input("New term");
    pickerFixture.reply(3, [["Obsolete additional page",true]]);
  });
  await waitForReads(5);
  assert.deepEqual((await reads())[4],{refs:["refs/heads/feature"],skip:0,limit:150,search:"New term"});
  assert.equal(await rows.count(), 0, "old pages cannot append after the query changes");
  await page.evaluate(() => {
    AtriumHost.projectGeneration++;
    window.dispatchEvent(new CustomEvent("atrium-git-binding"));
    pickerFixture.reply(4, [["Obsolete project",true]]);
  });
  await page.waitForFunction(() => pickerFixture.result === null);
  assert.equal(await search.count(), 0);
  assert.equal((await reads()).length, 5);
  await page.evaluate(() => {
    pickerFixture.reads.length = 0;
    AtriumHost.parallelGitReads = true;
    void AtriumGitPicker.pick();
  });
  await waitForReads(1);
  await page.evaluate(() => pickerFixture.input("Second"));
  await waitForReads(2);
  await page.evaluate(async () => {
    pickerFixture.input("Newest");
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  assert.deepEqual((await reads()).map(q => q.search), [undefined,"Second"], "at most two native reads overlap");
  await page.evaluate(() => pickerFixture.reply(0, [["Obsolete first",true]]));
  await waitForReads(3);
  assert.equal((await reads())[2].search, "Newest");
  await page.evaluate(() => pickerFixture.reply(1, [["Obsolete second",true]]));
  assert.equal(await page.locator(".gp-list").getAttribute("aria-busy"), "true");
  assert.equal(await rows.count(), 0);
  await page.evaluate(() => pickerFixture.reply(2, [["Newest result",true]]));
  await rows.filter({hasText:"Newest result"}).waitFor();
  await page.evaluate(() => pickerFixture.input("Slow obsolete"));
  await waitForReads(4);
  await page.evaluate(() => pickerFixture.input("Failure"));
  await waitForReads(5);
  await page.evaluate(() => pickerFixture.reads[4].reject(Error("Fixture search failed")));
  await page.getByText("Fixture search failed",{exact:true}).waitFor();
  await page.evaluate(async () => {
    pickerFixture.reply(3, [["Obsolete after failure",true]]);
    await new Promise(requestAnimationFrame);
  });
  assert.equal((await reads()).length, 5, "a stale reply cannot retry a query that already failed");
  await search.press("Enter");
  await waitForReads(6);
  await page.evaluate(() => pickerFixture.reply(5, [["Retried result",true]]));
  await rows.filter({hasText:"Retried result"}).waitFor();
  await page.locator("dialog.gp-dialog").getByRole("button",{name:"Cancel",exact:true}).click();
  await search.waitFor({state:"detached"});
  await page.evaluate(() => { window.AtriumHost = pickerFixture.original; delete window.pickerFixture; });
}

async function run(browser) {
  fs.cpSync(path.join(root,"mcp/examples/sensor-interface"),dir,{recursive:true});
  git("init","-q","-b","main");
  git("add","-A");
  git("commit","-qm","Baseline");
  const head = git("rev-parse","HEAD").trim(), gitBefore = gitState();
  const page = await browser.newPage({viewport:{width:1320,height:875}});
  page.setDefaultTimeout(12000);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.exposeFunction("fixtureMembers", names => ({files:names.flatMap(name => {
      const bytes = read(name);
      return bytes ? [{path:name,data:bytes.toString("base64"),length:bytes.length,sha256:sha(bytes)}] : [];
    })}));
    await page.exposeFunction("fixtureSave",writePlan);
    await page.exposeFunction("fixtureGit", (op,args) => {
      queries.push(op);
      return JSON.parse(execFileSync("python3",["-I","-B",path.join(root,"native/git_head.py"),
        "--project",member(manifest),"--query",op,"--args="+JSON.stringify(args)],{encoding:"utf8"}));
    });
    await page.addInitScript(({manifest}) => {
      const grant = "history-probe", entry = {grant,manifest,name:"History probe",draftScope:"history-probe-scope"};
      globalThis.AtriumHost = {
        platform:"mac", projectGeneration:0, folderGitGrant:null,
        open:async () => [{name:manifest,folderProject:entry}], setDirty(){}, finishedOpening(){}, clearProjectPath(){},
        async folderAdopt(q) { if (q.grant !== grant) throw Error("Wrong grant."); this.folderGitGrant = grant; this.projectGeneration++; return true; },
        async folderClose() { this.folderGitGrant = null; this.projectGeneration++; },
        async folderReadLease() { return {lease:"history-probe-lease"}; },
        folderRead:q=>fixtureMembers(q.paths), folderCommit:q=>fixtureSave(q), async folderRelease(){}, async folderLocalState(){return {};},
        gitQuery(op,args={}) { if (this.folderGitGrant !== grant) throw Error("Expired Git grant."); return fixtureGit(op,args); }
      };
    }, {manifest});
    await new Promise(resolve => server.listen(0,"127.0.0.1",resolve));
    await page.goto("http://127.0.0.1:"+server.address().port+"/app/index.html");
    await page.locator("dialog.sp-dialog[open]").getByRole("button",{name:"Open…",exact:true}).click();
    await page.waitForFunction(() => AtriumNavHost.folderProject() && !!AtriumHost.folderGitGrant);
    await page.locator('#document-tabs [data-kind="schematic"]:visible').first().click();
    await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumUndoStore","AtriumHistoryPanel","AtriumHistorySession","AtriumGitPicker",
        "AtriumSourceHistory","AtriumDiffView","AtriumBlame"]);
      AtriumPower.setMode("always");
      await AtriumNavHost.requireProjectClosure({purpose:"comparison"});
    });
    const edit = await page.evaluate(({ref}) => {
      const host = AtriumNavHost, doc = host.doc(), item = doc.items.find(i => i.id === ref);
      const x = item.x;
      const base = host.undoSteps().history.length;
      const accepted = host.edit(() => { item.x += 2; },"Move R1 for history",[item]);
      return {accepted,doc:doc.id,x,delta:item.x-x,checkpoints:host.undoSteps().history.length-base};
    },{ref});
    assert.deepEqual([edit.accepted,edit.delta,edit.checkpoints],[true,2,1]);

    const project = await page.evaluate(async ({ref,head,x}) => {
      const host = AtriumNavHost, U = AtriumUndoStore, G = AtriumGit;
      const doc = host.doc(), from = host.undoSteps().history.at(-1), to = U.live(host.revision());
      const session = AtriumHistorySession.bind(host), list = session.list({}), baseline = String(from.id);
      const capture = model => model.documents.find(d => d.id === doc.id).items.find(i => i.id === ref).x - x;
      const label = AtriumHistoryPanel.label(from, to);
      const itemRows = label.changes.filter(row => row.doc?.id === doc.id && row.path === "items");
      const thumb = session.thumbnail({step:list.current,documentId:doc.id}).scene;
      const preview = session.preview({step:baseline,documentId:doc.id});
      const proposal = session.compare({step:baseline});
      const keep = changes => changes.filter(c => c.target?.id === ref || c.item === ref || c.beforeItem === ref)
        .map(c => c.kind);
      const stats = {doc:doc.id,item:ref,step:label.label,journalRows:itemRows.length,journalPairs:itemRows.flatMap(row=>row.modified)
        .map(([a,b])=>[a.id,a.x-x,b.x-x]),thumbnail:thumb.before.map((a,i)=>[a.id,a.x-x,thumb.after[i].x-x]),
        preview:preview.document.items.find(i=>i.id===ref).x-x,previewOps:preview.changes,
        proposal:proposal.items.map(op=>[op.op,op.target,op.documentId,op.id,op.path]),
        readOnly:host.undoSteps().history.at(-1)===from && host.doc().items.find(i=>i.id===ref).x === x+2 && host.isDirty()};
      const work = await G.readSpec({type:"working"},host);
      const git = await G.readSpec({type:"commit",rev:head},host);
      const reader = AtriumSourceHistory.open();
      try {
        const source = await reader.side({type:"commit",rev:head},host);
        stats.gitBaselineAgreement = JSON.stringify(git.project) === JSON.stringify(source.project);
        const blame = await AtriumBlame.sourceHistory(reader,host,AtriumBlame.targetOf(host,doc.items.find(i=>i.id===ref)),true);
        stats.blameWorkingFields = blame.working.map(row=>row.field);
        stats.blameCommittedStatus = blame.entries.map(row=>row.status);
      } finally { reader.close(); }
      const before = await G.readSpec({type:"undo",mark:from,label:"Undo baseline"},host);
      await G.compare(before,work,{doc:doc.id});
      const model = AtriumDiffView.session().model;
      const change = model.changes.find(c=>c.item===ref || c.beforeItem===ref);
      stats.compare={total:model.changes.length,kinds:keep(model.changes),sameDocument:change?.doc===doc.id,
        sameObject:change?.item===ref && change?.beforeItem===ref};
      AtriumDiffView.close();
      const committed = AtriumHistorySummary.fromProjects(git.project,work.project);
      stats.gitToWorking={delta:[capture(git.project),capture(work.project)],total:committed.total};
      return stats;
    },{ref,head,x:edit.x});
    assert.equal(project.journalRows,1);
    assert.deepEqual(project.journalPairs,[[ref,0,2]]);
    assert.deepEqual(project.thumbnail,[[ref,0,2]]);
    assert.equal(project.preview,0);
    assert.equal(project.previewOps,1);
    assert.deepEqual(project.proposal,[["set","item",project.doc,ref,["x"]]]);
    assert.equal(project.readOnly,true);
    assert.deepEqual(project.compare,{total:2,kinds:["pin.disconnected","part.moved"],sameDocument:true,sameObject:true});
    assert.deepEqual(project.gitToWorking,{delta:[0,2],total:2});
    assert.equal(project.gitBaselineAgreement,true);
    assert.deepEqual(project.blameWorkingFields,["X"]);
    assert.deepEqual(project.blameCommittedStatus,["added"]);

    const beforeSaveQueries = queries.length;
    const saved = await page.evaluate(async ({ref,x}) => {
      const host = AtriumNavHost, folder = host.folderProject(), did = host.doc().id;
      const delta = p => p.documents.find(d=>d.id===did).items.find(i=>i.id===ref).x-x;
      const cursor = async () => (await AtriumGit.readSpec({type:"worktree"},host)).project;
      const beforeSave = delta(await cursor());
      await folder.flushDrafts({required:true});
      const drafts = await AtriumFolderDrafts.storage.list(JSON.stringify(["history-probe-scope",host.project().id]));
      const {history} = host.undoSteps(), stepCount = history.length, stepBeforeSave = history.at(-1);
      const result = await host.saveProject();
      const badge = document.querySelector(".hv-status"), dot = badge.querySelector(".ui-dot");
      const historyAfterSave = {modelDirty:host.isDirty(), dotVisible:!dot.hidden && !!dot.getClientRects().length,
        announcedDirty:/unsaved changes/i.test(badge.getAttribute("aria-label"))};
      const noUndoStepOnSave = stepBeforeSave === host.undoSteps().history.at(-1) && stepCount === host.undoSteps().history.length;
      const savedDelta = delta(await cursor());
      host.historyGo(-1);
      const undone = delta(host.project());
      const undoneSession = AtriumHistorySession.bind(host), list = undoneSession.list({});
      const undoneThumb = undoneSession.thumbnail({step:list.items.at(-1).id,documentId:did}).scene;
      const undoneFromSaved = AtriumHistorySummary.fromProjects(await cursor(),(await AtriumGit.readSpec({type:"working"},host)).project);
      const dirtyAfterUndo = host.isDirty();
      host.historyGo(1);
      const redone = delta(host.project());
      const redoneFromSaved = AtriumHistorySummary.fromProjects(await cursor(),(await AtriumGit.readSpec({type:"working"},host)).project);
      return {beforeSave,result,savedDelta,privateDraftsBeforeSave:drafts.length,
        noUndoStepOnSave,historyAfterSave,undone,undoneThumb:undoneThumb.after[0].x-x,
        undoneFromSaved:undoneFromSaved.total,dirtyAfterUndo,redone,redoneFromSaved:redoneFromSaved.total,finalSaved:delta(await cursor())};
    },{ref,x:edit.x});
    const {historyAfterSave, ...saveResult} = saved;
    assert.deepEqual(saveResult,{beforeSave:0,result:true,savedDelta:2,privateDraftsBeforeSave:1,noUndoStepOnSave:true,
      undone:0,undoneThumb:2,undoneFromSaved:2,dirtyAfterUndo:true,redone:2,redoneFromSaved:0,finalSaved:2});
    assert.equal(queries.slice(0,beforeSaveQueries).filter(op=>op==="folderRevisions").length,1,"the picker, History and blame use one committed revision read");
    assert.equal(queries.length-beforeSaveQueries,0,"Save, draft, cursor reads and undo/redo perform no Git query");
    assert.deepEqual(writes,[["Analog front end.wsch"]]);
    assert.deepEqual(gitState(),gitBefore);
    assert.deepEqual(errors,[]);
    const fork = await page.evaluate(async ({ref,x}) => {
      const host = AtriumNavHost, U = AtriumUndoStore, git = AtriumGit;
      host.historyGo(-1);
      const state = U.timeline(host), obsolete = state.current, priorTip = state.list.at(-1);
      const item = host.doc().items.find(row => row.id===ref);
      host.edit(() => { item.x += 1; },"Alternate R1 move",[item]);
      const after = U.timeline(host);
      const retained = await git.readSpec({type:"undo",mark:priorTip,label:"Original branch"},host);
      const position = retained.project.documents.find(doc=>doc.id===host.doc().id).items.find(row=>row.id===ref).x;
      const staleRejected = await git.readSpec({type:"undo",mark:obsolete},host)
        .then(()=>false,error=>/expired/.test(error.message));
      return {sameLength:state.list.length===after.list.length,retainedDelta:position-x,staleRejected};
    },{ref,x:edit.x});
    assert.deepEqual(fork,{sameLength:true,retainedDelta:2,staleRejected:true});
    const positiveQueries = queries.slice(), saveQueries = queries.length-beforeSaveQueries;
    // Resolve mutable HEAD again, even when its new commit has the same immutable design bytes.
    git("commit","--allow-empty","-qm","Same design, new commit");
    const next = git("rev-parse","HEAD").trim();
    const lifecycle = await page.evaluate(async ({head,next}) => {
      const host = AtriumNavHost, git = AtriumGit, data = AtriumProjectHistoryData;
      const latest = await git.readSpec({type:"head"},host), old = await git.readSpec({type:"commit",rev:head},host);
      const sameDesign = latest.version === old.version && latest.spec.rev === next && old.spec.rev === head;
      latest.project.name = "Local copy changed";
      const separateCopies = (await git.readSpec({type:"commit",rev:next},host)).project.name === old.project.name;
      const pending = () => {
        let release;
        const wait = new Promise(resolve => { release = resolve; });
        return {wait,release};
      };
      const fresh = () => {
        const source = data.source(git);
        source.refresh({commits:true});
        source.close();
      };
      const rejected = p => p.then(()=>false, error=>/cancelled|fixture read failed/.test(error.message));
      fresh();
      const first = pending(), cancel = new AbortController();
      let loads = 0;
      const held = {async q(op,args) { loads++; await first.wait; return git.q(op,args); }};
      const abandoned = rejected(data.readCommit(held,head,{signal:cancel.signal}));
      const kept = data.readCommit(held,head);
      cancel.abort();
      const independentCancellation = await abandoned;
      first.release();
      const oneInFlightRead = !!(await kept).project && loads === 1;

      fresh();
      const failOnce = {async q() { throw Error("fixture read failed"); }};
      const failed = await rejected(data.readCommit(failOnce,head));
      const retry = failed && !!(await data.readCommit(git,head)).project;

      fresh();
      const second = pending();
      const oldBinding = rejected(data.readCommit({async q(op,args) { await second.wait; return git.q(op,args); }}, head));
      AtriumHost.projectGeneration++;
      const rebound = await data.readCommit(git,head);
      const scopeChanged = await oldBinding && !!rebound.project;
      second.release();
      return {sameDesign,separateCopies,independentCancellation,oneInFlightRead,retry,scopeChanged};
    },{head,next});
    assert.deepEqual(lifecycle,{sameDesign:true,separateCopies:true,independentCancellation:true,
      oneInFlightRead:true,retry:true,scopeChanged:true});
    const derivedHistory = await demoHistoryDirty(browser);
    const clean = {modelDirty:false,dotVisible:false,announcedDirty:false};
    assert.deepEqual({save:historyAfterSave, derived:derivedHistory}, {
      save:clean, derived:{...clean,transitions:[true,false]}
    }, "History shows and announces the editor's clean state after Save and a derived refresh");
    await pickerSearch(page);
    assert.deepEqual(errors, []);
    delete edit.x;
    // The receipt names the tested commit when there is one; a source archive has no .git.
    let source = null;
    try { source = execFileSync("git",["-C",root,"rev-parse","--short","HEAD"],{encoding:"utf8",stdio:["ignore","pipe","ignore"]}).trim(); } catch { /* not a checkout */ }
    const receipt = {source,edit,project,saved,fork,lifecycle,derivedHistory,
      git:{positiveControlQueries:positiveQueries,revisionBundleReads:positiveQueries.filter(op=>op==="folderRevisions").length,queriesDuringDraftSaveUndoRedo:saveQueries,
        filesUnderGitUnchanged:Object.keys(gitBefore).length},writtenOwners:writes};
    process.stdout.write(JSON.stringify(receipt,null,2)+"\n");
  } finally {
    await page.close();
    server.close();
    fs.rmSync(temp,{recursive:true,force:true});
  }
}
module.exports = run;
if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => run(browser),
    error => { console.error(error); process.exitCode=1; });
}
