"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {execFile} = require("node:child_process");
const {pathToFileURL} = require("node:url");
const exec = require("node:util").promisify(execFile);
const serveApp = require("../support/browser-app-server.cjs");

const root = path.resolve(__dirname, "../..");
const partId = "15a74096-22a5-4f23-9d9b-14f2cb390881";
const trackId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const boardFile = "Identity.kicad_pcb";
const boardText = `(kicad_pcb (version 20240108) (net 1 "GND")
  (footprint "Test:R" (layer "F.Cu") (at 5 5) (uuid "${partId}") (path "/${partId}")
    (property "Reference" "R5") (property "Value" "10k")
    (pad "1" smd rect (at 0 0) (size 1 1) (layers "F.Cu") (net 1 "GND")))
  (segment (start 5 5) (end 6 5) (width 0.25) (layer "F.Cu") (net 1) (uuid "${trackId}")))`;

async function openFile(page, button, name, contents) {
  const [picker] = await Promise.all([page.waitForEvent("filechooser"), button.click()]);
  await picker.setFiles({name, mimeType: "application/octet-stream", buffer: Buffer.from(contents)});
}

async function clickBoard(page, point) {
  const screen = await page.evaluate(point => {
    const host = AtriumNavHost, canvas = host.canvas(), rect = canvas.getBoundingClientRect();
    const [x, y] = host.view().worldToScreen(point);
    const screen = [rect.left + x, rect.top + y];
    if (document.elementFromPoint(...screen) !== canvas) throw Error("The placement point is covered.");
    return screen;
  }, point);
  await page.mouse.click(...screen);
}

async function activateBoard(page) {
  await page.locator(".import-report:visible").waitFor();
  const boardName = await page.evaluate(() => AtriumNavHost.project().documents.find(doc => doc.kind === "pcb").name);
  await page.getByRole("tab", {name: boardName, exact: true}).click();
  await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumBlame", "AtriumTranslatorProvenance"]);
    const host = AtriumNavHost;
    host.view().restoreCamera({...host.view().camera(), cx: 8, cy: 5, scale: 25});
    host.redraw(true);
  });
}

async function openBlocks(page) {
  const menu = page.locator('.work-menu[data-menu="project"]');
  await menu.locator("summary").click();
  await menu.getByRole("menuitem", {name: "Layout Blocks…", exact: true}).click();
  return page.getByRole("dialog", {name: "Layout blocks", exact: true});
}

async function placeAt(page, name, point) {
  const dialog = page.getByRole("dialog", {name: "Place " + name, exact: true});
  await dialog.getByRole("button", {name: "Choose position", exact: true}).click();
  await clickBoard(page, point);
}

function snapshot(page) {
  return page.evaluate(() => {
    const host = AtriumNavHost;
    // Home's translation puts imported IDs in session provenance. Materialize them on a copy
    // before checking the original against the placed items.
    const joined = AtriumTranslatorProvenance.toLegacy(host.project(), AtriumImportReports.provenance());
    const board = joined.documents.find(doc => doc.id === host.doc().id);
    const source = item => AtriumBlame.engine.sourceValue(joined, {item, docId: board.id}, true, board.kind);
    const parts = board.items.filter(item => item.kind === "part");
    const tracks = board.items.filter(item => item.kind === "track");
    const describe = (item, net) => ({id: item.id, sourceId: item.kicadSourceId, sourcePath: item.kicadPath, net});
    let original;
    try { original = {ref: source(parts[0])?.ref, net: source(tracks[0])?.net}; }
    catch (error) {
      if (!error.message.includes("Object history is ambiguous")) throw error;
      original = {error: error.message};
    }
    return {
      parts: parts.map(part => ({...describe(part, part.pinNets["1"]), ref: part.ref, link: part.link})),
      tracks: tracks.map(track => describe(track, track.net)),
      history: host.undoSteps().history.length,
      original,
    };
  });
}

function assertPlacement(before, after, ref, net) {
  assert.deepEqual(after.parts.slice(0, -1), before.parts);
  assert.deepEqual(after.tracks.slice(0, -1), before.tracks);
  const part = after.parts.at(-1), track = after.tracks.at(-1);
  assert.deepEqual([part.sourceId, part.sourcePath, track.sourceId], [undefined, undefined, undefined],
    "A placed part and track must not inherit the source IDs");
  assert.deepEqual([part.ref, part.net, track.net], [ref, net, net]);
  assert.ok(part.link && before.parts.every(existing => existing.link !== part.link));
  const ids = [...after.parts, ...after.tracks].map(item => item.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(after.original, {ref: "R5", net: "GND"});
  assert.equal(after.history, before.history + 1);
}

async function placement(browser, portable, blockName) {
  const page = await browser.newPage({viewport: {width: 1280, height: 850}, reducedMotion: "reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(9000);
  try {
    await page.goto(pathToFileURL(path.join(root, "app/index.html")).href);
    const welcome = page.locator("dialog.sp-dialog[open]");
    await openFile(page, welcome.getByRole("button", {name: "Open…", exact: true}), boardFile, boardText);
    await activateBoard(page);

    const undoRedo = async (before, placed) => {
      await page.locator('.quick-access [data-action="undo"]').click();
      assert.deepEqual(await snapshot(page), before);
      await page.locator('.quick-access [data-action="redo"]').click();
      assert.deepEqual(await snapshot(page), placed);
    };

    const capture = await openBlocks(page);
    await capture.getByRole("button", {name: "Capture area", exact: true}).click();
    await clickBoard(page, [2, 2]);
    await clickBoard(page, [9, 8]);
    await page.getByRole("dialog", {name: "Save layout block"}).getByRole("button", {name: "Save block", exact: true}).click();
    const beforeCapture = await snapshot(page);
    assert.deepEqual(beforeCapture.parts.map(part => part.sourceId), [partId]);
    assert.deepEqual(beforeCapture.tracks.map(track => track.sourceId), [trackId]);
    assert.deepEqual(beforeCapture.original, {ref: "R5", net: "GND"});
    const place = await openBlocks(page);
    await place.getByRole("button", {name: "Place", exact: true}).click();
    await placeAt(page, "Layout block", [13, 7]);
    const capturedPlaced = await snapshot(page);
    assertPlacement(beforeCapture, capturedPlaced, "R1", "B1/GND");
    await undoRedo(beforeCapture, capturedPlaced);

    const imported = await openBlocks(page);
    await openFile(page, imported.getByRole("button", {name: "Import block…", exact: true}), "legacy-import.waffle-block", portable);
    await page.getByRole("dialog", {name: "Place " + blockName, exact: true}).waitFor();
    const beforeImport = await snapshot(page);
    assert.deepEqual(beforeImport, {...capturedPlaced, history: capturedPlaced.history + 1});
    await placeAt(page, blockName, [13, 12]);
    const importedPlaced = await snapshot(page);
    assertPlacement(beforeImport, importedPlaced, "R2", "B2/GND");
    await undoRedo(beforeImport, importedPlaced);
    assert.deepEqual(errors, []);
    console.log("PASS KiCad import, captured and portable block placement, original source IDs, isolated nets, Undo and Redo");
  } finally { await page.close(); }
}

async function objectHistory(browser, portable, blockName) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "waffle-placement-history-"));
  const server = await serveApp();
  try {
    const duplicateFile = "Duplicate.kicad_pcb";
    const repeatedFootprint = boardText.slice(boardText.indexOf("  (footprint"), boardText.indexOf("  (segment"))
      .replace('"R5"', '"R6"').replace("(at 5 5)", "(at 8 5)").replace(`(path "/${partId}")`, "");
    const duplicateText = boardText.replace("  (segment", repeatedFootprint + "  (segment");
    const git = (...args) => exec("git", ["-c", "user.name=Placement fixture", "-c", "user.email=placement@example.invalid",
      "-c", "commit.gpgSign=false", ...args], {cwd: directory});
    await git("init", "-q");
    await fs.writeFile(path.join(directory, boardFile), boardText.replace('"10k"', '"22k"'));
    await fs.writeFile(path.join(directory, duplicateFile), duplicateText);
    await git("add", boardFile, duplicateFile);
    await git("commit", "-qm", "Initial resistor 22k");
    await fs.writeFile(path.join(directory, boardFile), boardText);
    await git("commit", "-qam", "Change source resistor to 10k");
    const bridge = await fs.readFile(path.join(root, "native/bridge.js"), "utf8");

    // Keep the native bridge and Git helper. Substitute only the host picker and message transport.
    async function withSource(name, text, check) {
      const page = await browser.newPage({viewport: {width: 1280, height: 850}, reducedMotion: "reduce"});
      const errors = [], queries = [];
      page.on("pageerror", error => errors.push(error.message));
      page.setDefaultTimeout(9000);
      try {
        await page.exposeFunction("nativeCall", async message => {
          const {action, token, extensions, op, args} = JSON.parse(message);
          if (action === "open") return [{name, data: Buffer.from(text).toString("base64"), historyToken: "selected-design"}];
          if (action === "pick") {
            assert.deepEqual(extensions, [".waffle-block"]);
            return [{name: "legacy-import.waffle-block", data: portable.toString("base64")}];
          }
          if (action === "gitQuery") {
            assert.equal(token, "selected-design");
            queries.push(op);
            const {stdout} = await exec("python3", ["-I", "-B", path.join(root, "native/git_head.py"), "--project",
              path.join(directory, name), "--query", op, "--args=" + JSON.stringify(args)]);
            return JSON.parse(stdout);
          }
          return null;
        });
        await page.addInitScript({content: `window.__waffleTopFramePost = raw => {
          const {id} = JSON.parse(raw);
          window.nativeCall(raw).then(value => window.__atriumReceive(id, value), error => window.__atriumReceive(id, null, error.message));
        };\n${bridge}`});
        await page.goto(server.url);
        await page.locator("dialog.sp-dialog[open]").getByRole("button", {name: "Open…", exact: true}).click();
        await activateBoard(page);
        await page.waitForFunction(name => AtriumHost.historyPath === name, name);
        await check(page, queries);
        assert.deepEqual(errors, []);
      } finally { await page.close(); }
    }

    async function history(page, label, queries) {
      const start = queries.length;
      const selected = await page.evaluate(label => {
        const host = AtriumNavHost;
        const item = host.doc().items.find(item => (item.ref || item.kind) === label);
        host.select([item.id], item.id);
        return {id:item.id, doc:host.doc().id};
      }, label);
      const menu = page.locator('.work-menu[data-menu="project"]');
      await menu.locator("summary").click();
      await menu.getByRole("menuitem", {name: "Git", exact: true}).click();
      await menu.getByRole("menuitem", {name: "Show History of This Object", exact: true}).click();
      const view = page.locator('[role="tabpanel"][data-view="history"]:visible');
      const filter = view.getByRole("searchbox", {name:"Filter history"});
      await filter.waitFor();
      assert.equal(await filter.inputValue(), "object:" + JSON.stringify(label));
      assert.ok(await filter.evaluate(input => input === document.activeElement), "Object History starts in its scoped search");
      const statusHandle = await page.waitForFunction(() => {
        const view = document.querySelector('[role="tabpanel"][data-view="history"]:not([hidden])');
        const error = view?.querySelector(".hv-notice")?.textContent;
        if (/no unique source identifier/i.test(error)) return error;
        const status = view?.querySelector(".hv-foot")?.textContent;
        return /changes? in .* first-parent commit/i.test(status) ? status : null;
      });
      const status = await statusHandle.jsonValue();
      await statusHandle.dispose();
      const subjects = await view.locator('.hv-row[data-type="commit"] .ui-row-title').allTextContents();
      assert.deepEqual(await page.evaluate(() => ({id:AtriumNavHost.selection()[0], doc:AtriumNavHost.doc().id})), selected,
        "Showing history retains the exact selected board object");
      await page.getByRole("tab", {name:"History", exact:true}).locator(".view-tab-close").click();
      await view.waitFor({state:"detached"});
      return {status, subjects, queries: queries.slice(start)};
    }

    await withSource(boardFile, boardText, async (page, queries) => {
      const checkOriginals = async () => {
        const part = await history(page, "R5", queries);
        assert.match(part.status, /2 changes in 2 first-parent commits/);
        assert.deepEqual(part.subjects, ["Change source resistor to 10k", "Initial resistor 22k"]);
        assert.ok(part.queries.includes("sourceLog") && part.queries.includes("sourceRevision"),
          "the original part uses the authorized first-parent source history");
        const track = await history(page, "track", queries);
        assert.match(track.status, /1 change in 2 first-parent commits/);
        assert.deepEqual(track.subjects, ["Initial resistor 22k"]);
        assert.ok(track.queries.includes("sourceLog"));
      };
      await checkOriginals();
      const blocks = await openBlocks(page);
      await blocks.getByRole("button", {name: "Import block…", exact: true}).click();
      const pending = page.getByRole("dialog", {name:"Place " + blockName, exact:true});
      await pending.waitFor();
      const before = await snapshot(page);
      await placeAt(page, blockName, [13, 7]);
      const placed = await snapshot(page);
      assertPlacement(before, placed, "R1", "B1/GND");
      const checkCopy = async () => {
        const copy = await history(page, "R1", queries);
        assert.match(copy.status, /no unique source identifier/i);
        assert.deepEqual(copy.subjects, []);
        assert.deepEqual(copy.queries, []);
      };
      await checkOriginals();
      await checkCopy();
      await page.locator('.quick-access [data-action="undo"]').click();
      assert.deepEqual(await snapshot(page), before);
      await checkOriginals();
      await page.locator('.quick-access [data-action="redo"]').click();
      assert.deepEqual(await snapshot(page), placed);
      await checkOriginals();
      await checkCopy();
    });

    await withSource(duplicateFile, duplicateText, async (page, queries) => {
      assert.deepEqual((await snapshot(page)).parts.map(part => part.sourceId), [partId, partId]);
      const duplicate = await history(page, "R5", queries);
      assert.match(duplicate.status, /history is ambiguous/i);
      assert.deepEqual(duplicate.subjects, []);
      assert.deepEqual(duplicate.queries, []);
    });
    console.log("PASS Git object history for original part and track, no copied history, and duplicate source IDs");
  } finally {
    await server.close();
    await fs.rm(directory, {recursive: true, force: true});
  }
}

module.exports = async function placementIdentity(browser) {
  // This portable file was captured before placement stripped inherited source stamps.
  const portable = await fs.readFile(path.join(__dirname, "../fixtures/placement/legacy-import.waffle-block"));
  const block = JSON.parse(portable);
  assert.deepEqual(block.items.map(item => item.kicadSourceId).sort(), [partId, trackId].sort());
  assert.equal(block.items.find(item => item.kind === "part").kicadPath, "/" + partId);
  await placement(browser, portable, block.name);
  await objectHistory(browser, portable, block.name);
};

if (require.main === module) (async () => {
  const {chromium} = require("../support/playwright.cjs");
  const executable = process.env.CHROME;
  const browser = await chromium.launch(executable ? {executablePath: executable} : {channel: "chrome"});
  try { await module.exports(browser); } finally { await browser.close(); }
})().catch(error => {console.error(error); process.exitCode = 1;});
