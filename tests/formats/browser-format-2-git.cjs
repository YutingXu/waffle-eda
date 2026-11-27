"use strict";
// Run with NODE_PATH for Playwright Core and CHROME for a local Chrome executable.
// Pass --consent-only to exercise opening and merge setup without the history flow.
const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const {execFile} = require("node:child_process");
const fs = require("node:fs/promises"), os = require("node:os"), path = require("node:path");
const {createStaticServer} = require("../support/browser-app-server.cjs");
const {promisify} = require("node:util");
const {chromium} = require("../support/playwright.cjs");
const exec = promisify(execFile), root = path.resolve(__dirname, "../..");

async function run() {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "waffle-folder-history-ui-"));
  const server = createStaticServer({
    base: root,
    roots: [path.join(root, "app")],
    body: "buffer",
    missing: "end",
    mime: {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".wasm": "application/wasm"},
  });
  let browser;
  try {
    const {stdout} = await exec("python3", ["-B", path.join(__dirname, "format-2-git.py"), "--fixture", fixture]);
    const info = JSON.parse(stdout), manifest = path.basename(info.manifest), reads = [];
    const configPath = path.join(fixture, ".git", "config"), attrsPath = path.join(fixture, ".gitattributes");
    await fs.writeFile(attrsPath, "# Existing team settings\r\n*.wsch text eol=lf\r\n", {flag: "wx"});
    const readSettings = () => Promise.all([fs.readFile(configPath), fs.readFile(attrsPath)]);
    const initialSettings = await readSettings();
    browser = await chromium.launch({headless: true, executablePath: process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
    const page = await browser.newPage({viewport: {width: 1440, height: 950}});
    const errors = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.exposeFunction("gitFolderRecords", async names => ({files: await Promise.all(names.map(async name => {
      assert.match(name, /^(?:Sensor Board\.waffle|Power\.wsch|Support\.wsch)$/);
      const bytes = await fs.readFile(path.join(path.dirname(info.manifest), name));
      return {path: name, data: bytes.toString("base64"), length: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex")};
    }))}));
    await page.exposeFunction("gitFolderQuery", async (op, args) => {
      reads.push({op, args});
      try {
        const result = await exec("python3", ["-I", "-B", path.join(root, "native/git_head.py"), "--project", info.manifest,
          "--query", op, "--args=" + JSON.stringify(args)]);
        return {value: JSON.parse(result.stdout)};
      } catch (e) { return {error: e.stderr.trim()}; }
    });
    await page.addInitScript(name => {
      const entry = {grant: "opened-folder", manifest: name, name: "Sensor Board"};
      window.AtriumHost = {
        projectGeneration: 0, projectPath: null, folderGitGrant: null,
        open: async () => [{name, folderProject: entry}], finishedOpening() {},
        clearProjectPath() {},
        async folderAdopt({grant}) { this.folderGitGrant = grant; this.projectGeneration++; return true; },
        async folderClose() { this.folderGitGrant = null; this.projectGeneration++; },
        async folderReadLease() { return {lease: "saved"}; },
        folderRead({paths}) { return gitFolderRecords(paths); },
        async folderRelease() {}, async folderLocalState() { return {}; },
        async gitQuery(op, args = {}) {
          if (this.folderGitGrant !== entry.grant) throw Error("Folder grant expired.");
          const {value, error} = await gitFolderQuery(op, args);
          if (error) throw Error(error);
          return value;
        },
        gitHead() {},
      };
    }, manifest);
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    await page.goto("http://127.0.0.1:" + server.address().port + "/app/index.html");
    const action = name => page.locator('[data-action="' + name + '"]').first().evaluate(b => b.click());
    await page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Open…", exact:true}).click();
    await page.waitForFunction(() => AtriumNavHost.project().id === "p1" && AtriumNavHost.folderProject());
    assert.ok(reads.every(r => r.op === "refs" || r.op === "projectLog"), "opening a folder reads only Git history metadata");
    assert.deepEqual(await readSettings(), initialSettings, "opening leaves native Git settings byte-identical");

    const setup = page.getByRole("dialog", {name: /set up.*merge driver/i});
    const configure = setup.getByRole("button", {name: "Set Up", exact: true});
    const showPlan = async () => {
      await action("git-merge-driver");
      await setup.getByText(configPath, {exact: false}).waitFor();
      await setup.getByText(attrsPath, {exact: false}).waitFor();
      assert.equal(await configure.isEnabled(), true);
      assert.deepEqual(await readSettings(), initialSettings, "showing the setup plan writes nothing");
    };
    // Branch status and idle history metadata can run alongside the independent consent flow.
    const workflowReads = start => reads.slice(start).map(({op}) => op).filter(op => op !== "refs" && op !== "projectLog");
    const beforeCancel = reads.length;
    await showPlan();
    await setup.getByRole("button", {name: "Cancel", exact: true}).click();
    await setup.waitFor({state: "detached"});
    assert.deepEqual(workflowReads(beforeCancel), ["mergeDriverPlan"]);
    assert.deepEqual(await readSettings(), initialSettings, "cancel leaves native Git settings byte-identical");

    const beforeConfirm = reads.length;
    await showPlan();
    await configure.click();
    await setup.getByText(/^Done\./).waitFor();
    assert.deepEqual(workflowReads(beforeConfirm), ["mergeDriverPlan", "installMergeDriver"]);
    const install = reads.findLast(request => request.op === "installMergeDriver");
    assert.equal(install.args.confirm, true);
    assert.equal(typeof install.args.plan, "string");
    const [installedConfig, installedAttrs] = await readSettings();
    assert.match(installedConfig.toString(), /\[merge "waffle"\]/);
    assert.deepEqual(installedAttrs.subarray(0, initialSettings[1].length), initialSettings[1]);
    assert.match(installedAttrs.toString(), /^\*\.wpcb merge=waffle$/m);
    await setup.getByRole("button", {name: "Close", exact: true}).click();
    await setup.waitFor({state: "detached"});
    if (process.argv.includes("--consent-only")) {
      assert.deepEqual(errors, []);
      console.log("Folder open and explicit merge driver consent passed in Chrome.");
      return;
    }

    await action("project-history");
    const row = rev => page.locator('.hv-row[data-key="' + rev + '"]');
    const details = page.locator(".hv-details");
    await row(info.merge).click();
    await details.locator(".hv-headline", {hasText:/power|label|signal/i}).waitFor();
    assert.equal(await details.getByText("Merge", {exact:true}).count(), 1);
    await row(info.incomplete).click();
    await details.getByText(/Summary unavailable.*Missing required project member: Power\.wsch/).waitFor();
    await row(info.unsupported).click();
    await details.getByText(/Summary unavailable.*unsupported Waffle project format/).waitFor();
    const openRows = new Set(await page.locator('.hv-row[data-type="commit"]').evaluateAll(rows => rows.map(row => row.dataset.key)));
    const log = await page.evaluate(() => AtriumGit.q("projectLog", {limit: 20}));
    for (const request of reads.filter(r => r.op === "folderRevisions")) {
      assert.ok(request.args.revisions.every(id => openRows.has(id) || log.commits.some(row => openRows.has(row.revision) && row.parents[0] === id)));
    }
    const viewerScript = "**/history/diff-view.js";
    await page.route(viewerScript, route => route.abort(), {times: 1});
    await row(info.merge).click();
    await details.getByRole("button", {name:"Compare", exact:true}).click();
    const retry = page.getByRole("dialog", {name: "Could not open comparison"});
    await retry.waitFor();
    assert.equal(await page.locator(".dv-close").count(), 0, "a failed viewer load leaves the comparison pending");
    await retry.getByRole("button", {name: "Retry", exact: true}).click();
    await retry.waitFor({state: "detached"});
    const close = page.locator(".dv-close");
    await close.waitFor();
    await page.waitForFunction(() => AtriumDiffView.session()?.model?.changes?.length > 0);
    assert.deepEqual(await page.evaluate(() => [AtriumDiffView.session().b.project.documents[0].items[0].text,
      AtriumDiffView.session().a.project.documents[0].items[0].text]), ["SENSE", "SIGNAL"]);
    await close.click();
    await close.waitFor({state: "detached"});

    const projectMenu = page.locator('details[data-menu="project"]');
    await projectMenu.locator(":scope > summary").click();
    await projectMenu.getByRole("menuitem", {name:"Compare", exact:true}).click();
    await projectMenu.locator('[data-action="review-changes"]').click();
    await close.waitFor();
    await page.waitForFunction(() => AtriumDiffView.session()?.model?.changes?.length > 0);
    assert.deepEqual(await page.evaluate(() => [AtriumDiffView.session().b.project.documents[0].items[0].text,
      AtriumDiffView.session().a.project.documents[0].items[0].text]), ["SIGNAL", "WORKING"]);
    const stale = await page.evaluate(async revision => {
      const host = AtriumHost, original = host.gitQuery;
      const source = AtriumProjectHistoryData.source(AtriumGit);
      source.refresh({commits:true}); // Compare above deliberately warms this real revision.
      let release, intercepted, timeout;
      const held = new Promise(resolve => { release = resolve; });
      const requested = new Promise(resolve => { intercepted = resolve; });
      host.gitQuery = async (op, args, ...rest) => {
        const result = await original.call(host, op, args, ...rest);
        if (op === "projectBlobs" && args.revisions.includes(revision)) {
          intercepted(result.blobs?.[revision]);
          await held;
        }
        return result;
      };
      try {
        const read = source.resolve(null, revision, new AbortController().signal)
          .then(() => "resolved", error => error.message);
        const digest = await Promise.race([
          requested,
          read.then(result => { throw Error("The historical digest did not reach the native query: " + result); }),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(Error("The native historical digest was not returned.")), 10000); })
        ]);
        if (!/^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(digest)) throw Error("The native query did not return the requested digest.");
        host.projectGeneration++;
        release();
        return await read;
      } finally { clearTimeout(timeout); release(); host.gitQuery = original; source.close(); }
    }, info.merge);
    assert.match(stale, /cancelled/, "a native reply from the previous folder cannot appear after its grant changes");
    assert.deepEqual(await readSettings(), [installedConfig, installedAttrs], "reading and revoking history writes no Git settings");
    await close.click();
    await close.waitFor({state: "detached"});

    const repo = await fs.realpath(fixture);
    const git = (...args) => exec("git", ["-C", repo, ...args]).then(result => result.stdout);
    await git("config", "user.name", "Fixture");
    await git("config", "user.email", "fixture@example.invalid");
    const sheet = path.join(path.dirname(info.manifest), "Power.wsch"), ownerPath = path.relative(repo, sheet);
    const unrelatedPath = path.join(path.dirname(ownerPath), "team-notes.txt");
    await fs.writeFile(path.join(repo, unrelatedPath), "An independent staged change\n");
    await git("add", "--", ownerPath, unrelatedPath);
    const staged = await fs.readFile(sheet, "utf8"), working = staged.replace("WORKING", "UNSTAGED");
    assert.notEqual(staged, working);
    await fs.writeFile(sheet, working);
    const indexPath = path.join(repo, ".git", "index"), index = await fs.readFile(indexPath);
    const dialog = page.getByRole("dialog", {name: "Commit staged project files", exact: true});
    const openCommit = async () => {
      const menu = page.locator('details[data-menu="project"]');
      await menu.locator(":scope > summary").click();
      await menu.getByRole("menuitem", {name: "Git", exact: true}).click();
      await page.getByRole("menuitem", {name: "Commit…", exact: true}).click();
      await dialog.waitFor();
    };
    const beforeCommit = reads.filter(({op}) => op.startsWith("commit")).length;
    await openCommit();
    assert.equal(await dialog.getByRole("checkbox").count(), 1);
    assert.equal(await dialog.getByRole("button", {name: "Commit", exact: true}).isEnabled(), false);
    await dialog.getByRole("button", {name: "Cancel", exact: true}).click();
    await dialog.waitFor({state: "detached"});
    assert.equal((await git("rev-parse", "HEAD")).trim(), info.merge);
    assert.deepEqual(await fs.readFile(indexPath), index);
    await openCommit();
    await dialog.getByRole("checkbox", {name: /Power\.wsch.*modified/}).check();
    await dialog.getByRole("textbox", {name: "Commit message"}).fill("Publish just the power diagram");
    await dialog.getByRole("button", {name: "Commit", exact: true}).click();
    await dialog.waitFor({state: "detached"});
    assert.deepEqual(reads.filter(({op}) => op.startsWith("commit")).slice(beforeCommit).map(({op}) => op),
      ["commitPlan", "commitPlan", "commitStaged"]);
    assert.equal((await git("rev-parse", "HEAD^")).trim(), info.merge);
    assert.equal(await git("show", "HEAD:" + ownerPath), staged);
    assert.equal(await fs.readFile(sheet, "utf8"), working);
    assert.deepEqual(await fs.readFile(indexPath), index);
    assert.equal(await git("diff", "--cached", "--name-only", "-z"), unrelatedPath + "\0");
    assert.deepEqual(errors, []);
    console.log("Folder Open, merge driver consent, Project History, merge Compare, Changes Since Last Save and explicit staged Commit passed in Chrome.");
  } finally {
    if (browser) await browser.close();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await fs.rm(fixture, {recursive: true, force: true});
  }
}
run().catch(e => { console.error(e); process.exitCode = 1; });
