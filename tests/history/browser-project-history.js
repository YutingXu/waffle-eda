"use strict";
// Real Git reads and a real comparison worker while scrolling 500 branched design revisions.
// Run with: node tests/history/browser-project-history.js (Playwright + Chrome, as for integration-browser.cjs).
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const {createStaticServer} = require("../support/browser-app-server.cjs");
const os = require("node:os");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {execFile} = require("node:child_process");
const exec = require("node:util").promisify(execFile);
const {sampleHistoryScroll, historyScrollP95} = require("../support/history-scroll.cjs");
const ROOT = path.resolve(__dirname, "../..");

function appServer() {
  return createStaticServer({
    base: ROOT,
    roots: [path.join(ROOT, "app"), path.join(ROOT, "extensions")],
    body: "buffer",
    mime: {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm"},
  });
}
async function run(browser) {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "atrium-history-"));
  const server=appServer();
  const page = await browser.newPage({viewport: {width: 1440, height: 950}});
  const errors = [], reads = [];
  page.on("pageerror", e => errors.push(e.message));
  const start = performance.now();
  try {
    const {stdout} = await exec("python3", ["-B", path.join(__dirname, "project-history.py"), "--fixture", fixture, "500"]);
    const design = stdout.trim();
    const projectFolder = path.dirname(design), manifest = path.basename(design);
    async function git(op, args = {}) {
      const result = await exec("python3", ["-I", "-B", path.join(ROOT, "native/git_head.py"), "--project", design, "--query", op, "--args=" + JSON.stringify(args)],
        {maxBuffer: 5 * 1024 * 1024});
      return JSON.parse(result.stdout);
    }
    const metaAt = performance.now(), log = await git("projectLog", {limit: 500}), metadataMs = performance.now() - metaAt;
    assert.equal(log.commits.length, 500);
    const named = name => log.commits.find(c => c.subject === name);
    const merge = named("Merge supply routing");
    assert.equal(merge.parents.length, 2);
    await page.exposeFunction("historyMembers", async names => ({files:await Promise.all(names.map(async name => {
      const member = path.resolve(projectFolder,name);
      assert.ok(member.startsWith(projectFolder + path.sep) && !name.split("/").includes(".git"), name);
      const bytes = await fs.readFile(member);
      return {path:name,data:bytes.toString("base64"),length:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};
    }))}));
    await page.exposeFunction("historyGit", async (op, args) => {
      if (op === "folderRevisions") reads.push(...args.revisions);
      return git(op, args);
    });
    await page.addInitScript(manifest => {
      const entry = {grant:"bench-folder", manifest, name:"Bench"};
      window.AtriumHost = {
        projectGeneration:0, folderGitGrant:null,
        open:async () => [{name:manifest, folderProject:entry}], finishedOpening() {},
        clearProjectPath() {},
        async folderAdopt({grant}) {
          if (grant !== entry.grant) throw Error("Unknown project folder.");
          this.folderGitGrant=grant;
          this.projectGeneration++;
          return true;
        },
        async folderClose() { this.folderGitGrant=null; this.projectGeneration++; },
        async folderReadLease({grant}) {
          if (grant !== entry.grant) throw Error("Unknown project folder.");
          return {lease:"bench-read"};
        },
        folderRead({grant,lease,paths}) {
          if (grant !== entry.grant || lease !== "bench-read") throw Error("The folder read expired.");
          return historyMembers(paths);
        },
        async folderRelease() {}, async folderLocalState() { return {}; },
        async gitQuery(op, args = {}) {
          if (this.folderGitGrant !== entry.grant) throw Error("The folder Git grant expired.");
          return historyGit(op,args);
        },
      };
    }, manifest);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await page.goto("http://127.0.0.1:" + server.address().port + "/app/index.html");
    async function openProject() {
      const start = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Open…", exact:true});
      if (await start.isVisible()) await start.click();
      else await page.evaluate(() => AtriumNavHost.act("open"));
      await page.waitForFunction(() => AtriumNavHost.folderProject() && !!AtriumHost.folderGitGrant);
    }
    await openProject();
    assert.deepEqual(reads,[], "opening the project reads no historical designs");
    const docTab = kind => page.locator('#document-tabs [data-kind="' + kind + '"]:visible').first();
    await docTab("schematic").click();
    await page.evaluate(() => {
      const stats = window.historyPerf = {jobs:0, pending:0, cancels:0, hold:false};
      const Worker = window.Worker;
      window.Worker = class extends Worker {
        postMessage(data, ...rest) {
          if (data.history) {
            stats.jobs++;
            if (stats.hold) { this.held = true; stats.pending++; return; }
          }
          return super.postMessage(data, ...rest);
        }
        terminate() { if (this.held) { stats.pending--; stats.cancels++; } super.terminate(); }
      };
    });
    const view = page.locator(".hv-view"), details = view.locator(".hv-details");
    const row = hex => view.locator('[data-key="' + hex + '"]');
    const open = () => page.locator('#sub-project-git [data-action="project-history"]').evaluate(b => b.click());
    const compare = page.locator(".dv-close");
    async function go(index) {
      const revision = log.commits[index].revision;
      await page.waitForFunction(rev => {
        const v = globalThis.AtriumHistoryView?.instance(), s = v?.state();
        if (!s) return false;
        for (let i = 0; i < s.items; i++) if (v.keyOf(i) === rev) {
          document.querySelector(".hv-scroll").scrollTop = i * s.rowHeight;
          return true;
        }
        return false;
      }, revision);
      await row(revision).waitFor();
    }
    const first = row(log.commits[0].revision), firstAt = performance.now();
    await open();
    await first.click();
    await details.locator(".hv-tile .hv-changed").first().waitFor();
    const firstMs = performance.now() - firstAt;
    assert.ok(await view.locator(".hv-row").count() < 65);
    assert.match(await view.evaluate(v => getComputedStyle(v).backgroundColor), /^rgb\(/);
    const visible = new Set(await view.locator(".hv-row").evaluateAll(rs => rs.map(r => r.dataset.key)));
    assert.ok(reads.length > 0, "real history records were acquired through the native folder grant");
    assert.ok(reads.every(r => visible.has(r) || log.commits.some(c => visible.has(c.revision) && c.parents[0] === r)));
    await details.getByRole("button", {name:"Compare", exact:true}).click();
    await compare.waitFor();
    assert.deepEqual(await page.evaluate(() => [AtriumDiffView.session().b.label.slice(0, 7), AtriumDiffView.session().a.label.slice(0, 7)]),
      [log.commits[0].parents[0].slice(0, 7), log.commits[0].revision.slice(0, 7)]);
    await compare.click(); await compare.waitFor({state:"detached"});
    await first.click();
    await row(log.commits[1].revision).click({modifiers:["Shift"]});
    await details.getByRole("button", {name:/^Compare .* → /}).click();
    await compare.waitFor();
    assert.deepEqual(await page.evaluate(() => [AtriumDiffView.session().b.label.slice(0, 7), AtriumDiffView.session().a.label.slice(0, 7)]),
      log.commits.slice(0, 2).reverse().map(c => c.revision.slice(0, 7)), "two marked commits compare older → newer");
    await compare.click();
    const frames = await page.evaluate(sampleHistoryScroll, {selector: ".hv-scroll", steps: 110, clearPaint: true});
    const paintMax = await page.evaluate(() => AtriumHistoryView.perf().longest);
    await go(log.commits.indexOf(merge));
    const mergeRow = row(merge.revision);
    await mergeRow.click();
    await details.locator(".hv-headline", {hasText:/6 tracks rerouted/}).waitFor();
    assert.equal(await details.getByText("Merge", {exact:true}).count(), 1);
    assert.ok(await details.locator(".hv-tile .hv-changed").count() >= 2);
    assert.ok(await view.locator(".hv-row").count() < 65);
    const frameP95 = historyScrollP95(frames);
    assert.ok(paintMax < 32, "500-row paint max " + paintMax);
    assert.ok(frameP95 < 50, "500-row display interval p95 " + frameP95);
    if (process.env.ATRIUM_HISTORY_SHOTS) {
      await fs.mkdir(process.env.ATRIUM_HISTORY_SHOTS, {recursive: true});
      for (const theme of ["dark", "light"]) {
        await page.evaluate(theme => AtriumTheme.setPreset(theme), theme);
        await view.screenshot({path: path.join(process.env.ATRIUM_HISTORY_SHOTS, "history-" + theme + ".png")});
      }
    }
    const added = named("Add sensor interface"), addedRow = row(added.revision);
    await go(log.commits.indexOf(added));
    await addedRow.click();
    await details.locator(".hv-region").waitFor();
    const nextRegion = details.getByRole("button", {name:"Next region"});
    if (await nextRegion.count() && await nextRegion.isEnabled()) await nextRegion.click();
    await details.locator(".hv-tile .hv-changed").first().waitFor();
    assert.match(await details.locator(".hv-region").textContent(), /Sensor board/);
    await details.getByRole("button", {name:"Compare",exact:true}).click();
    await compare.waitFor();
    await page.waitForFunction(() => AtriumDiffView.session()?.metrics.diffDone !== undefined);
    assert.ok(await page.evaluate(() => AtriumDiffView.session().b.missing && AtriumDiffView.session().model.changes.length > 0));
    await compare.click();
    // A pending worker is terminated as soon as its view is hidden, also in Efficiency mode.
    await page.evaluate(() => { AtriumPower.setMode("always"); historyPerf.hold = true; });
    await go(50);
    await row(log.commits[50].revision).click();
    await page.waitForFunction(() => historyPerf.pending > 0);
    const board = await page.evaluate(()=>AtriumNavHost.documentRefs().find(doc=>doc.kind==="pcb").id);
    await page.locator('#documents [data-doc="'+board+'"]').click();
    await page.waitForFunction(id=>AtriumNavHost.currentId()===id,board);
    await page.waitForFunction(() => historyPerf.cancels > 0 && historyPerf.pending === 0);
    const beforeReads = reads.length;
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    assert.equal(reads.length, beforeReads);
    await page.evaluate(() => { historyPerf.hold = false; AtriumTheme.setPreset("light"); });
    await open(); await view.waitFor();
    await row(log.commits[50].revision).waitFor();
    await details.locator(".hv-changes").waitFor();
    assert.match(await view.evaluate(v => getComputedStyle(v).backgroundColor), /^rgb\(/);
    // Close the tab and evict in-memory state by reloading. The pair is served from IndexedDB.
    await page.reload(); await page.locator("#canvas").waitFor();
    await openProject();
    const reloadReads = reads.length; await open();
    await first.click();
    await details.locator(".hv-changes .hv-headline").waitFor();
    assert.ok(!reads.slice(reloadReads).includes(log.commits[0].revision), "persistent pair cache avoids rereading HEAD");
    await docTab("schematic").click();
    await page.evaluate(async()=>{
      (await AtriumLazy.need("AtriumPrefs")).set("butter.visualHistory",true);
      AtriumNavHost.act("history-panel");
    });
    const panel=page.locator(".panel-history"),scrubber=panel.getByRole("slider",{name:"Session and Git history"});
    await page.waitForFunction(()=>+(document.querySelector(".hist-scrub input")?.max||0)>=499);
    const position=log.commits.length-1-log.commits.findIndex(c=>c.revision===merge.revision);
    await scrubber.evaluate((slider,i)=>{slider.value=String(i);slider.dispatchEvent(new Event("input",{bubbles:true}));},position);
    await panel.locator(".hist-design-preview[data-ready=true]").waitFor();
    assert.match(await panel.locator(".hist-position").textContent(),/Merge supply routing/);
    await panel.getByRole("button",{name:"Compare with now"}).click();await compare.waitFor();
    assert.deepEqual(await page.evaluate(()=>{const s=AtriumDiffView.session();return [s.b.label,s.a.label];}),["Merge supply routing · "+merge.revision.slice(0,7),"Working design"]);
    await compare.click();await compare.waitFor({state:"detached"});
    await panel.getByRole("button",{name:"Create Git branch…"}).click();
    const branch=page.getByRole("dialog").filter({hasText:"Create Git branch"});
    await branch.getByRole("textbox",{name:"Branch name"}).fill("session-review");
    await branch.getByRole("button",{name:"Create branch",exact:true}).click();
    await branch.waitFor({state:"detached"});
    const refs=await git("refs");
    assert.equal(refs.head,log.head);assert.ok(refs.refs.some(r=>r.name==="refs/heads/session-review"&&r.revision===merge.revision));
    await panel.getByRole("button",{name:"Close History"}).click();
    assert.deepEqual(errors, []);
    console.log("Project History: 500 commits, metadata " + metadataMs.toFixed(1) + " ms, first summary " + firstMs.toFixed(1) +
      " ms, row update max " + paintMax.toFixed(1) + " ms, frame interval p95 " + frameP95 + " ms across " + frames.length +
      " frames. Root/merge, both editors, ordered Compare, worker cancellation and reload cache passed (" + Math.round(performance.now() - start) + " ms).");
  } finally {
    await page.close();
    if (server.listening) await new Promise(done => server.close(done));
    await fs.rm(fixture, {recursive: true, force: true});
  }
}
module.exports = run;
module.exports.appServer = appServer;
if (require.main === module) (async () => {
  const {chromium} = require("../support/playwright.cjs");
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"})});
  try { await run(browser); } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
