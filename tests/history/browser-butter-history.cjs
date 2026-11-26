"use strict";
// Unified History on a real Git repository with branches, merges, tags and several authors:\n// entry points (quick access, status bar, shortcut, palette and compatibility commands), visible retry, graph lanes; selection -> details -> Compare; Restore as copy; filters
// (text, author, object); keyboard; and performance budgets on a large history.
// Run: node tests/history/browser-butter-history.cjs  (Playwright + Chrome, as browser-project-history.js).
// ATRIUM_HISTORY_SHOTS=<dir> writes the design screenshots (light, dark, touch).
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {createHash} = require("node:crypto");
const {execFile} = require("node:child_process");
const exec = require("node:util").promisify(execFile);
const {appServer} = require("./browser-project-history.js");
const {sampleHistoryScroll, historyScrollP95} = require("../support/history-scroll.cjs");
const ROOT = path.resolve(__dirname, "../..");
const SHOTS = process.env.ATRIUM_HISTORY_SHOTS || "";

async function gitIn(dir, args, env = {}, input) {
  const child = execFile("git", args, {cwd: dir, env: {...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir, ...env}, maxBuffer: 16 * 1024 * 1024});
  if (input != null) { child.stdin.end(input); }
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    child.stdout.on("data", d => { out += d; }); child.stderr.on("data", d => { err += d; });
    child.on("close", code => code ? reject(Error(args.join(" ") + ": " + err)) : resolve(out.trim()));
  });
}
// The project fixture (tests/history/project-history.py) plus a review branch by other authors merged into main,
// a release tag and a remote-looking branch. Plumbing only: the working tree stays at HEAD's tree.
async function fixture(dir, count) {
  const {stdout} = await exec("python3", ["-B", path.join(__dirname, "project-history.py"), "--fixture", dir, String(count)], {maxBuffer: 8 * 1024 * 1024});
  const design = stdout.trim();
  const at = n => ({GIT_AUTHOR_DATE: String(1700000000 + count + n) + " +0000", GIT_COMMITTER_DATE: String(1700000000 + count + n) + " +0000"});
  const who = (name, n) => ({GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: name.split(" ")[0].toLowerCase() + "@example.invalid",
    GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: "c@example.invalid", ...at(n)});
  const head = await gitIn(dir, ["rev-parse", "HEAD"]), tree = await gitIn(dir, ["rev-parse", "HEAD^{tree}"]);
  const merge = await gitIn(dir, ["log", "--format=%H", "--grep=Merge supply routing", "-n", "1"]);
  await gitIn(dir, ["tag", "-a", "v1.0", "-m", "Release 1.0", merge], who("Release Bot", 0));
  const r1 = await gitIn(dir, ["commit-tree", tree, "-p", head, "-m", "Review sensor footprints"], who("Ada Lovelace", 1));
  const r2 = await gitIn(dir, ["commit-tree", tree, "-p", r1, "-m", "Check creepage on the supply"], who("Grace Hopper", 2));
  const m1 = await gitIn(dir, ["commit-tree", tree, "-p", head, "-m", "Fab notes for the panel"], who("Linus Pauling", 3));
  const m2 = await gitIn(dir, ["commit-tree", tree, "-p", m1, "-p", r2, "-m", "Merge review/ada"], who("Linus Pauling", 4));
  await gitIn(dir, ["update-ref", "refs/heads/review/ada", r2]);
  await gitIn(dir, ["update-ref", "refs/heads/main", m2]);
  await gitIn(dir, ["update-ref", "refs/remotes/origin/main", m1]);
  return {design, merge, head: m2, review: r2};
}

function host(page, design, beforeRead = () => {}) {
  const projectFolder = path.dirname(design), manifest = path.basename(design);
  const stats = {reads: 0};
  async function git(op, args = {}) {
    const result = await exec("python3", ["-I", "-B", path.join(ROOT, "native/git_head.py"), "--project", design, "--query", op, "--args=" + JSON.stringify(args)],
      {maxBuffer: 32 * 1024 * 1024});
    return JSON.parse(result.stdout);
  }
  return {git, stats, async install() {
    await page.exposeFunction("historyMembers", async names => ({files: await Promise.all(names.map(async name => {
      const member = path.resolve(projectFolder, name);
      assert.ok(member.startsWith(projectFolder + path.sep) && !name.split("/").includes(".git"), name);
      const bytes = await fs.readFile(member);
      return {path: name, data: bytes.toString("base64"), length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
    }))}));
    await page.exposeFunction("historyGit", async (op, args) => { stats.reads++; await beforeRead(op, args); return git(op, args); });
    await page.addInitScript(manifest => {
      const entry = {grant: "bench-folder", manifest, name: "Bench"};
      window.AtriumHost = {
        projectGeneration: 0, folderGitGrant: null,
        open: async () => [{name: manifest, folderProject: entry}], finishedOpening() {}, clearProjectPath() {},
        async folderAdopt({grant}) { if (grant !== entry.grant) throw Error("Unknown project folder."); this.folderGitGrant = grant; this.projectGeneration++; return true; },
        async folderClose() { this.folderGitGrant = null; this.projectGeneration++; },
        async folderReadLease({grant}) { if (grant !== entry.grant) throw Error("Unknown project folder."); return {lease: "bench-read"}; },
        folderRead({grant, lease, paths}) { if (grant !== entry.grant || lease !== "bench-read") throw Error("The folder read expired."); return historyMembers(paths); },
        async folderRelease() {}, async folderLocalState() { return {}; },
        async gitQuery(op, args = {}) { if (this.folderGitGrant !== entry.grant) throw Error("The folder Git grant expired."); return historyGit(op, args); }
      };
    }, manifest);
  }};
}

async function openProject(page) {
  const start = page.locator("dialog.sp-dialog[open]").getByRole("button", {name: "Open…", exact: true});
  if (await start.isVisible()) await start.click();
  else await page.evaluate(() => AtriumNavHost.act("open"));
  await page.waitForFunction(() => AtriumNavHost.folderProject() && !!AtriumHost.folderGitGrant);
}
const setFlag = (page, on) => page.evaluate(async on => { (await AtriumLazy.need("AtriumPrefs")).set("butter.history", on); }, on);
const rowByText = (view, text) => view.locator(".hv-row", {hasText: text}).first();
// Scroll a commit into view by its subject (rows outside the viewport are not mounted).
async function reveal(page, view, subject) {
  await page.evaluate(subject => {
    const s = AtriumHistoryView.state(), v = AtriumHistoryView.instance();
    for (let i = 0; i < s.items; i++) {
      const key = v.keyOf(i);
      if (document.querySelector('.hv-row[data-key="' + key + '"]')?.textContent.includes(subject)) return;
    }
    const scroll = document.querySelector(".hv-scroll");
    for (let y = 0; y <= scroll.scrollHeight; y += scroll.clientHeight / 2) {
      scroll.scrollTop = y; scroll.dispatchEvent(new Event("scroll"));
      AtriumHistoryView.instance().paint();
      if ([...document.querySelectorAll(".hv-row")].some(r => r.textContent.includes(subject))) return;
    }
  }, subject);
  return rowByText(view, subject);
}
async function shot(page, view, theme, name) {
  if (!SHOTS) return;
  const dir = path.join(SHOTS, theme);
  await fs.mkdir(dir, {recursive: true});
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await (view || page).screenshot({path: path.join(dir, name + ".png")});
}
async function graphInk(page) {
  return page.evaluate(() => {
    const c = document.querySelector(".hv-graph"), d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++; return n;
  });
}

async function splitHistory(browser, server) {
  const page = await browser.newPage({viewport:{width:1440,height:900}, reducedMotion:"reduce"});
  try {
    await page.goto(server + "/app/index.html");
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !AtriumNavHost.isStarter());
    await page.evaluate(() => AtriumNavHost.act("split-down"));
    await page.locator(".pane-tabs").nth(1).waitFor();
    await page.locator(".quick-access .hv-entry").click();
    const panel = page.locator("#doc-view-history");
    await panel.waitFor();
    const gap = await panel.evaluate(node => node.getBoundingClientRect().top -
      node.parentElement.querySelector(".pane-tabs").getBoundingClientRect().bottom);
    assert.equal(gap, 0, "History starts immediately below the split tab strip");
    const historyTab=page.getByRole("tab",{name:"History",exact:true});
    const strip=historyTab.locator("..");
    const widths=()=>strip.evaluate(node=>[node.getBoundingClientRect().width,
      ...Array.from(node.querySelectorAll(":scope > [role=tab]"), tab=>tab.getBoundingClientRect().width)]);
    const historyWidths=await widths();
    await strip.locator(":scope > .pane-tab").first().click();
    await panel.waitFor({state:"hidden"});
    assert.deepEqual(await widths(), historyWidths, "switching between History and a design preserves the split tab widths");
    await historyTab.click();
    await panel.waitFor();
    const firstDoc=strip.locator(":scope > .pane-tab").first();
    await historyTab.dragTo(firstDoc,{targetPosition:{x:2,y:12}});
    const first=()=>strip.locator(":scope > [role=tab]").first().getAttribute("id");
    assert.equal(await first(),"doc-view-tab-history","History can be reordered with a document tab");
    await firstDoc.click();
    await historyTab.click();
    assert.equal(await first(),"doc-view-tab-history","switching documents preserves the tab order");
    const target=page.locator('.pane-tabs[data-pane="' + (1 - Number(await strip.getAttribute("data-pane"))) + '"]');
    await historyTab.dragTo(target.locator(":scope > .pane-tab").first());
    assert.equal(await target.locator("#doc-view-tab-history").count(),1,"History moves to the other pane");
    await panel.waitFor();

    await page.evaluate(() => AtriumNavHost.act("split-close"));
    await page.locator("#document-tabs #doc-view-tab-history").waitFor();
    const editor = page.locator("#editor-panes"), bounds = await editor.boundingBox();
    await historyTab.dragTo(editor,{targetPosition:{x:bounds.width - 20,y:bounds.height / 2}});
    await page.locator("#editor-panes.is-split #canvas-stage-2 #doc-view-history").waitFor({timeout:3000});
    assert.equal(await page.locator('.pane-tabs[data-pane="1"] #doc-view-tab-history').count(),1,
      "dragging History to the editor edge creates a pane for the tab");
    const splitBounds = await editor.boundingBox();
    await historyTab.dragTo(editor,{targetPosition:{x:splitBounds.width / 2,y:54}});
    await page.locator("#editor-panes.split-down #canvas-stage #doc-view-history").waitFor({timeout:3000});
  } finally { await page.close(); }
}

async function historyActions(browser, server) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"waffle-history-actions-"));
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  try {
    const fx=await fixture(dir,40);
    let nextRead;
    const h=host(page,fx.design,async (op,args)=>{
      if (!nextRead?.matches(op,args)) return;
      const read=nextRead;
      nextRead=null;
      read.arrive();
      const failure=await read.resume;
      if (failure) throw Error(failure);
    });
    function hold(name, matches) {
      let release, arrive;
      const entered=new Promise(done=>{arrive=done;});
      const resume=new Promise(done=>{release=done;});
      nextRead={matches, arrive, resume};
      async function waitUntilEntered() {
        let timer;
        try {
          await Promise.race([entered, new Promise((_, reject) => {
            timer=setTimeout(() => reject(Error(name + " did not start its Git read")), 8000);
          })]);
        } finally { clearTimeout(timer); }
      }
      return {waitUntilEntered,release};
    }
    await h.install();
    await page.goto(server+"/app/index.html");
    await openProject(page);
    await page.locator(".quick-access .hv-entry").click();
    const view=page.locator(".hv-view");
    const compare=view.getByRole("button",{name:"Compare with last commit",exact:true});
    await compare.waitFor();
    const read=hold("Compare", (op,args)=>op==="folderRevisions" && args.known===undefined && args.revisions?.[0]===fx.head);
    await compare.click();
    await read.waitUntilEntered();
    const opening=await view.locator(".hv-foot .ui-spinner").count();
    read.release("Could not read the fixture revision.");
    assert.equal(opening,1,"Compare shows progress while reading the Git revision");
    const failure=view.getByRole("alert").filter({hasText:"Could not read the fixture revision."});
    await failure.waitFor({timeout:3000});
    const status = await page.locator("#status").textContent();
    assert.ok(!status.includes("Could not read the fixture revision."),"one failure should produce one message: " + status);
    await failure.getByRole("button",{name:"Try again",exact:true}).click();
    await page.locator(".dv-close").waitFor();
    assert.equal(await page.evaluate(()=>AtriumDiffView.session().a.label),"Working design");
    await page.locator(".dv-close").click();

    const refresh=view.getByRole("button",{name:"Refresh",exact:true});
    const log=hold("Refresh", op=>op==="projectLog");
    await refresh.click();
    await log.waitUntilEntered();
    const refreshing=await refresh.locator(".ui-spinner").count();
    log.release();
    assert.equal(refreshing,1,"Refresh shows a spinner in the button while loading");
    await refresh.locator(".ui-spinner").waitFor({state:"detached"});
  } finally {
    await page.close();
    await fs.rm(dir,{recursive:true,force:true});
  }
}

async function functional(browser, server) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waffle-history-"));
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    const fx = await fixture(dir, 40), h = host(page, fx.design);
    await h.install();
    await page.goto(server + "/app/index.html");
    await openProject(page);
    await setFlag(page, false); // existing profiles can carry this retired preference
    await page.locator(".quick-access .hv-entry").waitFor();
    const status = page.locator(".statusbar .hv-status");
    await page.waitForFunction(() => document.querySelector(".hv-status-label")?.textContent === "main");
    assert.match(await status.getAttribute("aria-label"), /On branch main/);
    assert.equal(await page.locator('.quick-access [data-action="redo"] + .hv-entry').count(), 1, "History sits after Redo");
    if (SHOTS) {
      await fs.mkdir(path.join(SHOTS, "entry"), {recursive: true});
      await page.locator(".appbar").screenshot({path: path.join(SHOTS, "entry", "appbar-after.png")});
      await page.locator(".statusbar").screenshot({path: path.join(SHOTS, "entry", "statusbar-after.png")});
    }

    // Open from the quick access button: shell first, then rows.
    const view = page.locator(".hv-view");
    const clicked = Date.now();
    await page.locator(".quick-access .hv-entry").click();
    await view.locator('.hv-row[data-type="commit"]').first().waitFor();
    const openMs = Date.now() - clicked;
    const perf = await page.evaluate(() => AtriumHistoryView.perf());
    assert.ok(perf.shell < 100, "History shell painted in " + perf.shell.toFixed(1) + " ms");
    await page.waitForFunction(() => !AtriumHistoryView.state().more && !AtriumHistoryView.state().loading);
    const st = await page.evaluate(() => AtriumHistoryView.state());
    assert.equal(st.commits, 44);
    assert.ok(st.mounted < 60, "only rows in view are mounted: " + st.mounted);
    // Graph lanes: two lanes for the review merge, canvas ink, merge and ref badges.
    assert.ok(st.graphWidth >= 30, "graph has more than one lane: " + st.graphWidth);
    assert.ok(await graphInk(page) > 400, "graph canvas painted");
    const headRow = rowByText(view, "Merge review/ada");
    assert.equal(await headRow.locator(".ui-badge", {hasText: "main"}).count(), 1);
    assert.equal(await rowByText(view, "Fab notes for the panel").locator(".ui-badge", {hasText: "origin/main"}).count(), 1);
    assert.equal(await rowByText(view, "Check creepage").locator(".ui-avatar").textContent(), "GH");
    assert.equal(await view.locator('.hv-row[data-type="working"]').count(), 1, "the working design leads the timeline");
    assert.equal(await (await reveal(page, view, "Merge supply routing")).locator(".ui-badge", {hasText: "v1.0"}).count(), 1);

    // Selection -> details -> Compare.
    const merge = await reveal(page, view, "Merge supply routing");
    await merge.click();
    const details = view.locator(".hv-details");
    await details.locator(".hv-detail-title", {hasText: "Merge supply routing"}).waitFor();
    const moreActions=details.getByRole("button",{name:"More actions",exact:true});
    assert.equal(await moreActions.evaluate(button=>getComputedStyle(button,"::after").content),"none",
      "the ellipsis is the only menu indicator");
    await moreActions.click();
    await page.getByRole("menuitem",{name:"Compare with parent",exact:true}).waitFor();
    await page.keyboard.press("Escape");

    await details.locator(".hv-headline").waitFor({timeout: 30000});
    assert.match(await details.locator(".hv-headline").textContent(), /6 tracks rerouted/);
    assert.ok(await details.locator(".hv-group", {hasText: "Tracks"}).count() >= 1, "changed objects grouped by kind");
    await details.locator(".hv-pair .hv-changed").first().waitFor();
    assert.equal(await details.getByRole("button", {name: "Compare", exact: true}).getAttribute("data-variant"), "primary");
    await shot(page, view, "light", "commit-details");
    await details.getByRole("button", {name: "Compare", exact: true}).click();
    const diffClose = page.locator(".dv-close");
    await diffClose.waitFor();
    assert.deepEqual(await page.evaluate(() => [AtriumDiffView.session().b.label.slice(0, 7), AtriumDiffView.session().a.label.slice(0, 7)]),
      [(await h.git("log", {limit: 100})).commits.find(c => c.revision === fx.merge).parents[0].slice(0, 7), fx.merge.slice(0, 7)]);
    await diffClose.click(); await diffClose.waitFor({state: "detached"});

    // Two commits: Mod-click marks a second one; Compare runs older -> newer.
    await page.evaluate(() => AtriumDocViews.show("history"));
    await (await reveal(page, view, "Update regulator")).click();
    await (await reveal(page, view, "Restore design")).click({modifiers: [process.platform === "darwin" ? "Meta" : "Control"]});
    const pairButton = details.getByRole("button", {name: /^Compare [0-9a-f]{7} → [0-9a-f]{7}$/});
    await pairButton.waitFor();
    await shot(page, view, "light", "two-commits");
    await pairButton.click(); await diffClose.waitFor();
    const pair = await page.evaluate(() => [AtriumDiffView.session().b.label, AtriumDiffView.session().a.label]);
    assert.match(pair[0], /Update regulator/); assert.match(pair[1], /Restore design/);
    await diffClose.click(); await diffClose.waitFor({state: "detached"});
    await page.evaluate(() => AtriumDocViews.show("history"));

    // Keyboard: Home is the working design, arrows move, End is the oldest, Enter compares, Esc clears a mark.
    await view.locator(".hv-scroll").focus();
    await page.keyboard.press("Escape");
    await page.keyboard.press("Home");
    assert.equal((await page.evaluate(() => AtriumHistoryView.state())).sel, "working");
    await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowDown");
    const second = await page.evaluate(() => AtriumHistoryView.state().sel);
    assert.notEqual(second, "working");
    await page.keyboard.press("End");
    const last = await page.evaluate(() => AtriumHistoryView.state());
    assert.equal(last.sel, (await h.git("log", {limit: 100})).commits.at(-1).revision, "End selects the first commit");
    assert.equal(await view.locator(".hv-scroll").getAttribute("aria-activedescendant"), "hv-row-" + (last.items - 1));
    await page.keyboard.press("Home");
    if (await view.locator('.hv-row[data-key="local"]').count()) {
      await page.keyboard.press("ArrowDown"); await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => AtriumHistoryView.state().expanded.includes("local"));
      await page.keyboard.press("ArrowLeft");
      await page.waitForFunction(() => !AtriumHistoryView.state().expanded.includes("local"));
    }
    // Edits: an edit appears under the working design; Undo marks it undone; Go to this step redoes it.
    await page.evaluate(() => {
      AtriumNavHost.selectDocument(AtriumNavHost.documentRefs().find(d => d.kind === "schematic").id);
      AtriumNavHost.select(["s-R2"], "s-R2"); AtriumNavHost.act("rotate"); AtriumDocViews.show("history");
    });
    await page.waitForFunction(() => AtriumNavHost.undoSteps().history.length === 1);
    await view.locator('.hv-row[data-key="working"]', {hasText: "1 edit"}).waitFor();
    await view.locator(".hv-scroll").focus();
    await page.keyboard.press("Home"); await page.keyboard.press("ArrowRight");
    const editRow = view.locator('.hv-row[data-type="edit"]');
    await editRow.waitFor();
    await page.waitForFunction(() => /Rotate|R2/.test(document.querySelector('.hv-row[data-type="edit"] .ui-row-title')?.textContent || ""));
    await page.keyboard.press("ArrowDown");
    await details.getByRole("button", {name: "Current step"}).waitFor();
    await shot(page, view, "light", "edits");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    await view.locator('.hv-row[data-type="edit"][data-state="pending"]').waitFor();
    await editRow.click();
    await details.getByRole("button", {name: "Go to this step"}).click();
    await page.waitForFunction(() => AtriumNavHost.undoSteps().history.length === 1 && !AtriumNavHost.undoSteps().future.length);
    // A folder project keeps drafts, not snapshots: no checkpoint action (local history is covered in noGit()).
    await view.locator('.hv-row[data-key="working"]').click();
    assert.equal(await details.getByRole("button", {name: "Save checkpoint"}).count(), 0);

    // Filters: message, author, object.
    const search = view.locator(".hv-search input");
    await search.fill("creepage");
    await page.waitForFunction(() => AtriumHistoryView.state().items === 1);
    assert.equal(await view.locator(".hv-search .ui-search-count").textContent(), "1 of 44");
    await search.fill("author:grace");
    await page.waitForFunction(() => AtriumHistoryView.state().items === 1);
    await search.fill("author:linus");
    await page.waitForFunction(() => AtriumHistoryView.state().items === 2);
    await search.fill("nothing-like-this");
    await view.locator(".hv-empty .ui-empty").waitFor();
    await shot(page, view, "light", "no-match");
    // object: by designator. R1 is the board footprint here (the sheet symbol is still "R?").
    await search.fill("object:R1");
    await page.waitForFunction(() => AtriumHistoryView.state().objectHits > 0 && !document.querySelector(".hv-foot .ui-spinner"), null, {timeout: 60000});
    assert.deepEqual((await view.locator(".hv-row .ui-row-title").allTextContents()).sort(), ["Add sensor interface", "Remove design", "Restore design"]);
    // Show History of This Object (the old command) filters History to the selected sheet symbol.
    await page.evaluate(() => {
      const doc = AtriumNavHost.documentRefs().find(d => d.kind === "schematic").id;
      AtriumNavHost.selectDocument(doc); AtriumNavHost.select(["s-R1"], "s-R1");
    });
    await page.evaluate(() => AtriumNavHost.act("object-history"));
    await view.waitFor();
    await page.waitForFunction(() => AtriumHistoryView.state()?.query.object === "R?" && AtriumHistoryView.state().objectHits > 0 &&
      !document.querySelector(".hv-foot .ui-spinner"), null, {timeout: 60000});
    await rowByText(view, "Update regulator").click();
    await details.locator(".ui-section-title", {hasText: /^R\? · /}).waitFor();
    assert.match(await details.locator(".ui-diff").first().textContent(), /New regulator/);
    await shot(page, view, "light", "object-filter");
    await view.locator(".hv-search .ui-search-clear").click();
    await page.waitForFunction(() => AtriumHistoryView.state().items > 40);

    // Restore as copy opens the revision as a new unsaved project.
    const regulator = (await h.git("log", {limit: 100})).commits.find(c => c.subject === "Update regulator");
    await (await reveal(page, view, "Update regulator")).click();
    await details.getByRole("button", {name: "Restore as copy"}).click();
    // The rotated R2 is unsaved: the usual Replace prompt asks first; the copy never touches the project file.
    await page.getByRole("button", {name: "Don’t Save"}).click();
    await page.waitForFunction(short => AtriumNavHost.project().name.endsWith("(" + short + ")") && AtriumNavHost.isDirty(), regulator.revision.slice(0, 7));

    // Status bar and shortcut open History again; the old commands route to it.
    await page.evaluate(() => AtriumHistoryView.close());
    await page.locator(".hv-view").waitFor({state: "detached"});
    await page.locator("#canvas").click({position: {x: 400, y: 300}});
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Alt+KeyZ" : "Control+Alt+KeyZ");
    await view.waitFor();
    await page.evaluate(() => AtriumHistoryView.close());
    await status.click();
    await view.waitFor();
    await page.waitForFunction(() => AtriumHistoryView.state()?.sel === "working");
    await view.locator(".hv-detail-title", {hasText: "Working design"}).waitFor();
    await page.evaluate(() => AtriumHistoryView.close());
    await page.evaluate(() => AtriumNavHost.act("project-history"));
    await view.waitFor();
    await view.getByText("No Git history.", {exact:true}).waitFor();
    assert.equal(await page.evaluate(() => AtriumHost.folderGitGrant), null, "Restoring a copy detaches Git");
    assert.ok(await page.evaluate(() => AtriumKeymap.command("history") && AtriumKeymap.command("history-object")), "palette commands");
    await page.evaluate(() => AtriumHistoryView.close());
    const reopened = openProject(page);
    await page.getByRole("button", {name:"Don’t Save"}).click();
    await reopened;

    // File History filters to first-parent revisions that changed the tracked project file.
    await page.evaluate(() => AtriumNavHost.act("file-history"));
    try {
      await page.waitForFunction(() => document.querySelector(".hv-branches")?.value === "file");
      await view.locator('.hv-row[data-type="commit"]').first().waitFor();
      await page.waitForFunction(() => !AtriumHistoryView.state()?.loading, null, {timeout:90000});
    } catch (error) {
      const info = await page.evaluate(() => ({mode:document.querySelector(".hv-branches")?.value,
        state:globalThis.AtriumHistoryView?.state(), footer:document.querySelector(".hv-foot")?.textContent,
        notice:document.querySelector(".hv-notice")?.textContent, status:document.getElementById("status")?.textContent}));
      throw Error("File History route failed: " + JSON.stringify(info), {cause:error});
    }
    assert.ok(await view.locator('.hv-row[data-key="' + fx.head + '"]').count() === 0, "merge message with identical design is absent from file history");
    await view.locator(".hv-foot").getByText(/first-parent commits checked/).waitFor();

    await page.evaluate(async () => {
      const host = AtriumNavHost, board = host.documentRefs().find(doc => doc.kind === "pcb");
      await host.selectDocument(board.id);
      const item = host.doc().items.find(i => i.ref === "R1");
      host.select([item.id], item.id);
      host.act("object-history");
    });
    await page.waitForFunction(() => AtriumHistoryView.state()?.query.object === "R1" && AtriumHistoryView.state()?.objectHits > 0);
    await page.evaluate(async () => {
      const history = await AtriumLazy.need("AtriumHistoryEntry");
      await history.open({target:{net:"VIN", label:"Net VIN"}});
    });
    await page.waitForFunction(() => AtriumHistoryView.state()?.query.net === "VIN");
    await page.evaluate(() => AtriumNavHost.act("project-history"));
    await page.waitForFunction(() => AtriumHistoryView.state()?.query.net === "");
    assert.equal(await page.locator(".hv-view").count(), 1);
    assert.deepEqual(errors, []);
    console.log("History walk: " + st.commits + " commits, open " + openMs + " ms (shell " + perf.shell.toFixed(1) + " ms), graph " + st.graphWidth +
      " px, entry, details, Compare, pair Compare, keyboard, filters, object filter, Restore as copy, shortcut, status bar, project, file, object and net routing passed.");
  } finally {
    await page.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
}

// Without Git (a project saved outside a repository): the notice, local snapshots, Compare and Restore as copy.
async function noGit(browser, server) {
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(server + "/app/index.html");
    await page.locator("#canvas").waitFor();
    await page.evaluate(async () => {
      const p = JSON.parse(JSON.stringify(AtriumNavHost.project())); p.name = "Bench without Git";
      await AtriumNavHost.replaceProject(p, {dirty: true});
      document.querySelector("dialog.sp-dialog[open]")?.close();
    });
    await page.locator(".quick-access .hv-entry").waitFor();
    assert.equal(await page.locator(".hv-status-label").textContent(), "History");
    assert.equal(await page.locator(".hv-status .ui-dot:not([hidden])").count(), 1, "unsaved dot");
    await page.locator(".quick-access .hv-entry").click();
    const view = page.locator(".hv-view"), details = view.locator(".hv-details");
    await view.locator(".hv-notice .ui-notice", {hasText: "No Git history"}).waitFor();
    await page.evaluate(async () => {
      const panel=await AtriumLazy.need("AtriumHistoryPanel");
      const ready=new Promise(resolve=>{window.releaseCheckpoint=resolve;});
      globalThis.AtriumHistoryPanel={...panel,async checkpoint(...args) {
        await ready;
        globalThis.AtriumHistoryPanel=panel;
        return panel.checkpoint(...args);
      }};
    });
    await details.getByRole("button", {name: "Save checkpoint"}).click();
    try {
      await view.locator(".hv-foot .ui-spinner").waitFor();
      assert.match(await view.locator(".hv-foot").textContent(),/Saving checkpoint/);
    } finally {
      await page.evaluate(() => window.releaseCheckpoint());
    }
    const localRow = view.locator('.hv-row[data-key="local"]');
    await localRow.waitFor();
    await localRow.locator(".ui-disclosure").click();
    const snap = view.locator('.hv-row[data-type="snapshot"]', {hasText: "Checkpoint"});
    await snap.click();
    await details.getByRole("button", {name: "Compare with working design"}).waitFor();
    await shot(page, view, "light", "no-git-snapshots");
    await details.getByRole("button", {name: "Compare with working design"}).click();
    const diffClose = page.locator(".dv-close");
    await diffClose.waitFor();
    assert.equal(await page.evaluate(() => AtriumDiffView.session().a.label), "Working design");
    await diffClose.click(); await diffClose.waitFor({state: "detached"});
    await page.evaluate(() => AtriumDocViews.show("history"));
    await details.getByRole("button", {name: "Restore as copy"}).click();
    await page.waitForFunction(() => AtriumNavHost.isDirty() && /Bench without Git/.test(AtriumNavHost.project().name));
    assert.deepEqual(errors, []);
    console.log("History without Git: notice, status bar, checkpoint, snapshot Compare and Restore as copy passed.");
  } finally { await page.close(); }
}

// A missing script has a visible retry and reopens the original file scope.
async function retry(browser, server) {
  const page = await browser.newPage();
  try {
    async function failScript(name) {
      let blocked = true, failures = 0, recoveries = 0;
      await page.route("**/history/" + name + ".js", route => {
        if (blocked) { failures++; return route.abort(); }
        recoveries++; return route.continue();
      });
      return {allow:() => { blocked = false; }, failures:() => failures, recoveries:() => recoveries};
    }
    const historyScript = await failScript("history-view");
    const visualScript = await failScript("visual-history");
    await page.goto(server + "/app/index.html");
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !AtriumNavHost.isStarter() && !document.querySelector("dialog.sp-dialog[open]"));
    await page.evaluate(() => {
      const host = AtriumNavHost;
      window.retryHistoryBinding = {project:host.project(), session:host.fileSession(), grant:globalThis.AtriumHost?.folderGitGrant};
    });

    const coldHistory = historyScript.failures();
    const failed = page.waitForEvent("requestfailed", {predicate:request => request.url().endsWith("/history/history-view.js")});
    await page.evaluate(() => AtriumNavHost.act("file-history"));
    await failed;
    assert.equal(historyScript.failures(), coldHistory + 1, "File History demanded the blocked module");
    const dialog = page.getByRole("dialog", {name:"History could not open"});
    await dialog.getByRole("alert").waitFor();
    historyScript.allow();
    await dialog.getByRole("button", {name:"Try again"}).click();
    await page.locator('.hv-branches option[value="file"]:checked').waitFor({state:"attached"});
    await dialog.waitFor({state:"detached"});
    assert.equal(historyScript.recoveries(), 1, "Retry requests the real History module");
    assert.ok(await page.evaluate(() => {
      const host = AtriumNavHost, binding = retryHistoryBinding;
      return host.project() === binding.project && host.fileSession() === binding.session &&
        globalThis.AtriumHost?.folderGitGrant === binding.grant;
    }), "Retry retains the original project and file session");
    await page.locator(".hv-notice").getByRole("button", {name:"Compare two revisions…"}).waitFor();

    const coldVisual = visualScript.failures();
    await page.evaluate(() => AtriumNavHost.act("history-panel"));
    const panel = page.locator(".panel-history");
    const retry = panel.getByRole("button", {name:"Try again"});
    await retry.waitFor();
    assert.equal(visualScript.failures(), coldVisual + 1, "The visible Undo dock demanded the blocked module");
    assert.equal(await panel.locator(".hist-list > .hist-row").count(), 0);
    visualScript.allow();
    await retry.click();
    await panel.locator(".hist-scrub").waitFor();
    assert.equal(visualScript.recoveries(), 1, "Retry requests the real visual Undo module");
    console.log("History retry: original File scope and the visual Undo dock recover after a script request fails.");
  } finally { await page.close(); }
}

// Large history: 3,000 commits. First paint, long tasks while opening and scrolling, mounted rows.
async function performance_(browser, server) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waffle-history-big-"));
  const page = await browser.newPage({viewport: {width: 1440, height: 900}});
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    const fx = await fixture(dir, 3000), h = host(page, fx.design);
    await h.install();
    await page.goto(server + "/app/index.html");
    await openProject(page);
    await page.locator(".quick-access .hv-entry").waitFor();
    await page.evaluate(() => AtriumLazy.need("AtriumHistoryView"));
    // The entry reads the first page at idle after the project opens; History paints from it at once.
    await page.waitForFunction(() => !!AtriumHistoryEntry.cachedLog(), null, {timeout: 30000});
    await page.evaluate(() => {
      window.historyLong = [];
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.historyLong.push(e.duration); }).observe({type: "longtask", buffered: false});
    });
    const view = page.locator(".hv-view");
    await page.locator(".quick-access .hv-entry").click();
    await view.locator('.hv-row[data-type="commit"]').first().waitFor();
    await page.waitForFunction(() => globalThis.AtriumHistoryView?.state() && !AtriumHistoryView.state().more && !AtriumHistoryView.state().loading, null, {timeout: 60000});
    const perf = await page.evaluate(() => AtriumHistoryView.perf());
    const st = await page.evaluate(() => AtriumHistoryView.state());
    assert.equal(st.commits, 3004);
    const frames = await page.evaluate(sampleHistoryScroll, {selector: ".hv-scroll", steps: 120});
    const mounted = (await page.evaluate(() => AtriumHistoryView.state())).mounted;
    const long = await page.evaluate(() => window.historyLong);
    const frameP95 = historyScrollP95(frames);
    const rebuild = Math.max(...perf.renders);
    assert.ok(perf.shell < 100, "shell " + perf.shell);
    assert.ok(perf.cached && perf.firstRows < 100, "first commit rows painted " + perf.firstRows.toFixed(1) + " ms after the command (cached: " + perf.cached + ")");
    assert.ok(rebuild < 50, "rebuilding 3,000 rows (lanes and layout) took " + rebuild.toFixed(1) + " ms");
    assert.ok(perf.longest < 16, "the longest row paint took " + perf.longest.toFixed(1) + " ms");
    assert.ok(mounted < 80, "rows mounted after scrolling 3,000 commits: " + mounted);
    assert.ok(frameP95 < 34, "scroll frame interval p95 " + frameP95);
    assert.ok(!long.some(d => d > 100), "no long task over 100 ms: " + long.map(d => d.toFixed(0)).join(", "));
    assert.deepEqual(errors, []);
    console.log("History performance: 3,004 commits, shell " + perf.shell.toFixed(1) + " ms, first rows " + perf.firstRows.toFixed(1) +
      " ms (prefetched page; Git reads continue at idle), rows painted in " + perf.rows.toFixed(1) + " ms after the first page, rebuild max " + rebuild.toFixed(1) +
      " ms, row paint max " + perf.longest.toFixed(1) + " ms, scroll frame p95 " + frameP95 + " ms, long tasks " + long.length +
      (long.length ? " (max " + Math.max(...long).toFixed(0) + " ms)" : "") + ", mounted " + mounted + ".");
    return {perf, frames: frameP95, long};
  } finally {
    await page.close();
    await fs.rm(dir, {recursive: true, force: true});
  }
}

// Screenshots of each key state in dark and touch (light comes from the walk).
async function themes(browser, server) {
  if (!SHOTS) return;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "waffle-history-shots-"));
  try {
    const fx = await fixture(dir, 40);
    for (const [theme, options] of [["dark", {}], ["touch", {hasTouch: true, isMobile: false}], ["light", {}]]) {
      const page = await browser.newPage({viewport: theme === "touch" ? {width: 1180, height: 820} : {width: 1440, height: 900}, ...options});
      const h = host(page, fx.design);
      await h.install();
      await page.goto(server + "/app/index.html");
      await openProject(page);
      if (theme === "dark") await page.evaluate(() => AtriumTheme.setPreset("dark"));
      if (theme === "light") await page.evaluate(() => AtriumTheme.setPreset("light"));
      if (theme === "touch") {
        // A coarse pointer, as on a tablet: the library's touch density applies (any-pointer:coarse).
        const cdp = await page.context().newCDPSession(page);
        await cdp.send("Emulation.setTouchEmulationEnabled", {enabled: true, maxTouchPoints: 5});
        await cdp.send("Emulation.setEmitTouchEventsForMouse", {enabled: true, configuration: "mobile"});
        await page.evaluate(() => { document.documentElement.dataset.pointer = "touch"; });
      }
      if (theme !== "touch") {
        await fs.mkdir(path.join(SHOTS, "entry"), {recursive: true});
        await page.locator(".appbar").screenshot({path: path.join(SHOTS, "entry", "appbar-before-" + theme + ".png")});
        await page.locator(".statusbar").screenshot({path: path.join(SHOTS, "entry", "statusbar-before-" + theme + ".png")});
      }
        await page.locator(".quick-access .hv-entry").waitFor();
      await page.waitForFunction(() => document.querySelector(".hv-status-label")?.textContent === "main");
      if (theme !== "touch") {
        await page.locator(".appbar").screenshot({path: path.join(SHOTS, "entry", "appbar-after-" + theme + ".png")});
        await page.locator(".statusbar").screenshot({path: path.join(SHOTS, "entry", "statusbar-after-" + theme + ".png")});
      }
      const press = locator => theme === "touch" ? locator.tap() : locator.click();
      await press(page.locator(".quick-access .hv-entry"));
      const view = page.locator(".hv-view");
      await page.waitForFunction(() => globalThis.AtriumHistoryView?.state() && !AtriumHistoryView.state().loading);
      await shot(page, view, theme, "working");
      await press(await reveal(page, view, "Merge supply routing"));
      await view.locator(".hv-details .hv-headline").waitFor({timeout: 30000});
      await view.locator(".hv-details .hv-pair .hv-changed").first().waitFor();
      await page.evaluate(() => new Promise(r => setTimeout(r, 600)));
      await shot(page, view, theme, "commit-details");
      await shot(page, null, theme, "window");
      await page.close();
    }
  } finally { await fs.rm(dir, {recursive: true, force: true}); }
}

async function run(browser) {
  const server = appServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  try {
    if (process.argv.includes("--retry-only")) { await retry(browser, url); return; }
    if (process.argv.includes("--split-only")) { await splitHistory(browser, url); return; }
    if (process.argv.includes("--actions-only")) { await historyActions(browser, url); return; }
    if (process.argv.includes("--snapshots-only")) { await noGit(browser, url); return; }
    await splitHistory(browser, url);
    await historyActions(browser, url);
    await functional(browser, url);
    await noGit(browser, url);
    await retry(browser, url);
    await themes(browser, url);
    if (process.env.ATRIUM_HISTORY_PERF !== "0") await performance_(browser, url);
  } finally { await new Promise(done => server.close(done)); }
}
module.exports = run;
if (require.main === module) (async () => {
  const {chromium} = require("playwright-core");
  const browser = await chromium.launch({headless: true, ...(process.env.CHROME ? {executablePath: process.env.CHROME} : {channel: "chrome"})});
  try { await run(browser); } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
