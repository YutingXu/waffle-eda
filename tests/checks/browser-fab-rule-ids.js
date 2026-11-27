"use strict";
// Apply fabrication rules through the editor, publish through the native writer, and reopen.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const {pathToFileURL} = require("node:url");
const {hostEnv, folderFiles} = require("../support/native-folder-fixture.cjs");
const {chromium} = require("../support/playwright.cjs");
const root = path.resolve(__dirname, "../..");
for (const name of ["model", "source-file", "format-2-codec", "format-2-units", "format-2-values", "format-2-model"])
  require(require("../support/app-source-paths.cjs").appFile(name + ".js"));

function fixture(dir) {
  const project = Atrium.project("Fab identity", []), board = project.documents[1];
  board.outline = [[0, 0], [80, 0], [80, 60], [0, 60]];
  const data = AtriumFormat2Model.fromEditor(project, {entryDocument: board.id});
  for (const {path: name, file} of data.files) fs.writeFileSync(path.join(dir, name), AtriumFormat2.serialize(file));
  return {dir, manifest: data.manifestPath, boardId: board.id};
}

function nativeFolder(dir, manifest) {
  const env = hostEnv(path.join(dir, "folder-host"), root);
  return folderFiles(env, "python3", path.join(root, "mcp"), path.join(dir, manifest));
}

async function menu(page, group, action) {
  const menu = page.locator('.menubar [data-menu="' + group + '"]');
  await menu.locator(":scope > summary").click();
  await menu.locator('[data-action="' + action + '"]').click();
}
const current = page => page.evaluate(() => (AtriumNavHost.project().rules?.list ?? [])
  .map(({id, presetKey}) => [id, presetKey ?? null]));

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "waffle-fab-rule-ids-"));
  let browser;
  try {
    const {manifest, boardId} = fixture(dir), request = nativeFolder(dir, manifest);
    const commits = [], errors = [];
    browser = await chromium.launch({args: ["--allow-file-access-from-files"], ...(process.env.CHROME ?
      {executablePath: process.env.CHROME} : {channel: "chrome"})});
    async function open() {
      const page = await browser.newPage({viewport: {width: 1400, height: 950}, reducedMotion: "reduce"});
      page.on("pageerror", error => errors.push(error.message));
      page.setDefaultTimeout(10000);
      await page.exposeFunction("fabRead", q => request(q));
      await page.exposeFunction("fabCommit", q => {
        const result = request(q);
        assert.ok(result.saved && result.transaction);
        commits.push(Object.keys(result.hashes));
        return result;
      });
      await page.addInitScript(manifest => {
        const entry = {grant: "fab-identity", manifest, name: "Fab identity"};
        window.AtriumHost = {platform: "mac", open: async () => [{name: manifest, folderProject: entry}],
          finishedOpening() {}, markOpened() {}, clearProjectPath() {}, setDirty() {},
          folderReadLease: async () => ({lease: "project-files"}), folderAdopt: async () => true,
          folderRelease: async () => {}, folderClose: async () => {}, folderLocalState: async () => ({}),
          folderRead: q => fabRead(q), folderCommit: q => fabCommit(q)};
      }, manifest);
      await page.goto(pathToFileURL(path.join(root, "app/index.html")).href);
      await page.getByRole("button", {name: "Continue to editor", exact: true}).click();
      await menu(page, "file", "open");
      await page.waitForFunction(id => AtriumNavHost.currentId() === id && AtriumNavHost.folderProject()?.hasPresented(id), boardId);
      return page;
    }

    const assertIds = rules => {
      assert.ok(rules.length > 10);
      assert.equal(new Set(rules.map(([id]) => id)).size, rules.length);
      assert.ok(rules.every(([id]) => AtriumUUID.isV7(id)), JSON.stringify(rules));
    };
    const save = async (page, rules) => {
      const before = commits.length;
      await menu(page, "file", "save-all");
      await page.waitForFunction(() => !AtriumNavHost.folderProject().dirty);
      assert.equal(commits.length, before + 1);
      assert.ok(commits.at(-1).includes(manifest));
      const rows = fs.readFileSync(path.join(dir, manifest), "utf8").trimEnd().split("\n")
        .map(line => JSON.parse(line)).filter(row => row.kind === "rule");
      assert.ok(rows.every(row => row.id === row.value.id), "row IDs and editable rule IDs agree");
      assert.deepEqual(rows.map(row => [row.id, row.value.presetKey ?? null]).sort(), rules.slice().sort());
    };

    let page = await open();
    const selectPreset = async () => {
      await menu(page, "design", "fab-preset");
      const dialog = page.locator("dialog.fps-dialog[open]");
      await dialog.getByRole("option").filter({hasText: /JLCPCB 4-layer \(/}).first().click();
      return dialog;
    };
    const dialog = await selectPreset();
    await dialog.getByRole("button", {name: "Apply", exact: true}).click();
    await dialog.waitFor({state: "hidden"});
    const preset = await current(page);
    assertIds(preset);
    assert.ok(preset.some(([, key]) => key?.startsWith("fp-jlcpcb-4l-")));
    await menu(page, "edit", "undo");
    assert.deepEqual(await current(page), []);
    await menu(page, "edit", "redo");
    assert.deepEqual(await current(page), preset);
    const again = await selectPreset();
    assert.equal(await again.getByRole("button", {name: "Applied", exact: true}).isDisabled(), true);
    await again.getByRole("button", {name: "Cancel", exact: true}).click();
    await save(page, preset);
    await page.close();

    page = await open();
    assert.deepEqual(await current(page), preset);
    const profile = async () => {
      await menu(page, "design", "fabProfiles");
      const dialog = page.locator("dialog.fp-dialog[open]");
      await dialog.getByRole("option").filter({hasText: "OSH Park 2-layer"}).click();
      await dialog.getByRole("button", {name: "Apply profile", exact: true}).click();
      await dialog.getByRole("status").filter({hasText: /Applied\./}).waitFor();
      await page.keyboard.press("Escape");
      await dialog.waitFor({state: "hidden"});
    };
    await profile();
    const profiled = await current(page);
    assertIds(profiled);
    assert.ok(profiled.some(([, key]) => key?.startsWith("fab-oshpark-2l-")));
    await profile();
    assert.deepEqual(await current(page), profiled);
    await save(page, profiled);

    const ruleSet = async () => {
      await menu(page, "design", "rule-sets");
      const dialog = page.locator("dialog.rset-dialog[open]");
      await dialog.getByRole("option").filter({hasText: /^JLC 2-layer/}).click();
      await dialog.getByRole("button", {name: "Make active", exact: true}).click();
      await dialog.getByRole("status").filter({hasText: "JLC 2-layer is now the active rule set"}).waitFor();
      await dialog.getByRole("button", {name: "Close", exact: true}).click();
    };
    await ruleSet();
    const active = await current(page);
    assertIds(active);
    assert.ok(active.some(([, key]) => key?.startsWith("ruleset-jlcpcb-2l-")));
    await ruleSet();
    assert.deepEqual(await current(page), active);
    await save(page, active);
    await page.close();
    page = await open();
    assert.deepEqual(await current(page), active);
    assert.deepEqual(errors, []);
    console.log("PASS fabrication presets, profiles and rule sets preserve canonical rule IDs through undo, apply, save and reopen");
  } finally {
    await browser?.close();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
run().catch(error => {console.error(error); process.exitCode = 1;});
