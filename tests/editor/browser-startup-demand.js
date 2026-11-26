"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {showPanel} = require("../support/window-panels.cjs");

const app = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
async function fresh(browser, run, settings) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}});
  const errors = [];
  const legacyContractRequests = [], graphRequests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    if (request.url().endsWith("/automation/legacy-command-contract.js")) legacyContractRequests.push(request.url());
    if (request.url().endsWith("/ui/commit-graph.js")) graphRequests.push(request.url());
  });
  page.setDefaultTimeout(8000);
  try {
    if (settings) await page.addInitScript(values => {
      localStorage.setItem("atrium.prefs", JSON.stringify({format:"atrium-prefs",version:1,values}));
    },settings);
    if (settings) await page.clock.install();
    await page.goto(app);
    await run(page, graphRequests);
    assert.deepEqual(errors, []);
    assert.deepEqual(legacyContractRequests, [], "the legacy worker catalogue stays out of the editor and its workers");
  } finally {
    await page.close();
  }
}

async function demo(page) {
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => AtriumNavHost.doc()?.name === "Sensor board");
}

async function historyDemand(browser) {
  await fresh(browser, async (page, graphRequests) => {
    await page.locator("dialog.sp-dialog[open]").waitFor();
    // Wait for the real idle registration, including History's toolbar and status markup.
    await page.waitForFunction(() => globalThis.AtriumHistoryEntry?.status().installed);
    assert.equal(await page.locator(".hv-entry use").getAttribute("href"), "#i-history");
    for (const id of ["history", "branch", "more"])
      assert.equal(await page.locator(`.icon-bank symbol#i-${id}[data-proposed]`).count(), 1);
    assert.deepEqual(graphRequests, [], "Home needs no commit graph script");
    await demo(page);
    await page.evaluate(() => new Promise(resolve => AtriumIdle.idle(() => resolve(), {timeout:2000})));
    assert.deepEqual(graphRequests, [], "an idle editor still needs no commit graph script");
    await page.getByRole("button", {name:"History", exact:true}).click();
    await page.locator(".hv-view canvas.hv-graph").waitFor();
    assert.equal(graphRequests.length, 1, "first History use loads its graph");
    assert.ok(await page.evaluate(() => AtriumCommitGraph.lanes([{revision:"one"}]).length === 1));
  });
}

module.exports = async browser => {
  await historyDemand(browser);
  for (const efficiency of ["off", "always"]) {
    await fresh(browser, async page => {
      await page.locator("dialog.sp-dialog[open]").waitFor();
      // Deliver any accidental idle task scheduled in the original 2.2 s window.
      await page.clock.runFor(2200);
      const cold = await page.evaluate(() => {
        const names = ["AtriumPCBEdit", "AtriumPCBPours", "AtriumNetsPanel", "AtriumWireEdit", "AtriumDock",
          "AtriumExtensions", "AtriumSurfaceMotion", "AtriumSchFields", "AtriumTabDrop", "AtriumTooltip", "AtriumRevisionsUI"];
        return {loaded:names.filter(name => globalThis[name]), efficiency:AtriumPower.mode()};
      });
      assert.deepEqual(cold, {loaded:[],efficiency});
      // Escape is the first workbench action. It waits for the workbench's editing
      // services, including the saved selection filter and snap state.
      await page.keyboard.press("Escape");
      await page.locator("dialog.sp-dialog[open]").waitFor({state:"hidden"});
      assert.equal(await page.evaluate(() => typeof AtriumPCBEdit.install), "function");
      assert.equal(await page.evaluate(() => typeof AtriumWireEdit.begin), "function");
      assert.equal(await page.evaluate(() => typeof AtriumTooltip.dismiss), "function", "the visible workbench has canvas hover and managed tooltips");
      await page.getByRole("tab", {name:"Board layout"}).click();
      assert.equal(await page.evaluate(() => !!globalThis.AtriumNetsPanel), false);
      await page.locator("#canvas").focus();
      await page.keyboard.press("F5");
      await page.waitForFunction(() => globalThis.AtriumNetsPanel?.override() === false);
      await showPanel(page, "nets");
      await page.getByRole("grid", {name:"Nets", exact:true}).waitFor();
    }, {"general.efficiency":efficiency});
  }

  await fresh(browser, async page => {
    await page.evaluate(() => {
      const editor = AtriumNavHost, prepare = editor.prepareWorkbench;
      const ready = new Promise(resolve => {window.releaseWorkbench = resolve;});
      editor.prepareWorkbench = (...args) => ready.then(() => prepare(...args));
    });
    await page.getByRole("button", {name:"Continue to editor",exact:true}).click();
    await page.keyboard.press("F1");
    assert.equal(await page.evaluate(() => !!globalThis.AtriumPCBEdit), false);
    await page.evaluate(() => window.releaseWorkbench());
    await page.locator("#palette[open] [role=option]").first().waitFor();
  });

  await fresh(browser, async page => {
    await demo(page);
    const position = await page.evaluate(() => {
      if (globalThis.AtriumCrossProbe) throw Error("Cross Probe is already loaded");
      const h = AtriumNavHost;
      const board = h.doc(), sheet = h.project().documents.find(d => d.kind === "schematic");
      const rect = h.canvas().getBoundingClientRect();
      for (const part of board.items.filter(i => i.kind === "part" && i.link)) {
        const other = sheet.items.find(i => i.kind === "part" && part.link === i.link);
        const [x, y] = h.view().worldToScreen([part.x, part.y]);
        const px = rect.left + x, py = rect.top + y;
        if (other && h.hit(h.canvas(), px, py)?.item?.id === part.id) return {px, py, item: other.id, document: sheet.id};
      }
      throw Error("No visible sample component has a matching schematic symbol");
    });
    const modifier = await page.evaluate(() => AtriumKeymap.mac ? "Meta" : "Control");
    await page.keyboard.down(modifier);
    try {
      await page.mouse.dblclick(position.px, position.py);
    } finally {
      await page.keyboard.up(modifier);
    }
    await page.waitForFunction(({item, document}) => AtriumNavHost.doc().id === document && AtriumNavHost.selection().includes(item), position);
  });

  await fresh(browser, async page => {
    await demo(page);
    const tools = page.locator('.work-menu[data-menu="tools"]');
    await tools.locator("summary").click();
    const crossSelect = tools.locator('[data-action="cross-select"]');
    assert.equal(await crossSelect.getAttribute("data-checked"), "false");
    assert.equal(await page.evaluate(() => !!globalThis.AtriumCrossProbe), false);
    await crossSelect.click();
    await page.waitForFunction(() => globalThis.AtriumCrossProbe?.crossSelect());
    assert.equal(await crossSelect.getAttribute("data-checked"), "true");
    assert.equal(await page.evaluate(() => !!globalThis.AtriumWindowedTable), false);
    await showPanel(page, "nets");
    await page.getByRole("grid", {name: "Nets", exact: true}).waitFor();
    await page.waitForFunction(() => !!document.querySelector(".nets-table tbody tr[data-r]"));

    await page.reload();
    await page.waitForFunction(() => globalThis.AtriumCrossProbe?.crossSelect());
    assert.equal(await crossSelect.getAttribute("data-checked"), "true", "startup restores the saved Cross Select mode");
  });

  await fresh(browser, async page => {
    const open = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Open…", exact:true});
    await open.waitFor();
    assert.deepEqual(await page.evaluate(() => [typeof AtriumIO.pickFile, typeof AtriumIO.read]), ["function", "undefined"]);
    const picker = page.waitForEvent("filechooser");
    await open.click();
    await (await picker).setFiles(path.join(__dirname, "../fixtures/altium/pidp11-io-expander/PiDP11IOExpander.SchDoc"));
    await page.waitForFunction(() => {
      const project = AtriumNavHost.project();
      return project.name === "PiDP11IOExpander" && project.documents.some(d => d.kind === "schematic" && d.items.length > 10);
    });
    assert.deepEqual(await page.evaluate(() => [typeof AtriumIO.pickFile, typeof AtriumIO.read]), ["function", "function"]);
  });
  for (const enabled of [false, true]) {
    await fresh(browser, async page => {
      await page.getByRole("button", {name: "Continue to editor", exact: true}).click();
      await page.evaluate(async enabled => {
        const prefs = await AtriumLazy.need("AtriumPrefs");
        prefs.set("butter.numericFields", enabled);
        prefs.open("pcb");
      }, enabled);
      const grid = page.locator("dialog.prf-dialog[open] .prf-stepper #prf-pcb-grid");
      await grid.waitFor();
      assert.equal(await grid.getAttribute("type"), "number");
      assert.equal(await grid.inputValue(), "0.25");
      const next = await grid.evaluate(input => {
        const native = input.cloneNode();
        native.value = input.value;
        native.stepUp();
        return native.valueAsNumber;
      });
      assert.equal(await page.evaluate(() => !!globalThis.AtriumNumericFields), false, "the first Preferences numeric focus starts cold");
      await grid.evaluate(input => input.addEventListener("focusin", event => {
        window.firstGridFocus = {
          trusted: event.isTrusted, type: input.type, start: input.selectionStart, end: input.selectionEnd
        };
      }, {once: true}));
      await grid.click();
      await page.waitForFunction(() => !!globalThis.AtriumNumericFields);
      const focused = await page.evaluate(() => window.firstGridFocus);
      assert.equal(focused.trusted, true);
      assert.equal(focused.type, "text");
      if (enabled) {
        assert.deepEqual([focused.start, focused.end], [0, 4], "opt-in selects the existing value for expression entry");
        await grid.pressSequentially("0.1 mm + 0.2 mm");
        assert.equal(await grid.inputValue(), "0.1 mm + 0.2 mm");
        await grid.press("Enter");
        await page.waitForFunction(() => AtriumPrefs.get("pcb.grid") === .3);
        assert.equal(await grid.getAttribute("type"), "number", "expression commit restores the native number control");
      } else {
        assert.equal(focused.start, focused.end, "the default stepper has a text caret after its first click");
        await grid.press("ArrowUp");
        await page.waitForFunction(next => AtriumPrefs.get("pcb.grid") === next, next);
      }
    });
  }
  console.log("PASS cold Welcome in both power modes, Escape to editor, F5 net colours, and Nets through Window");
  console.log("PASS default Preferences caret and opted-in numeric entry on the first click");
  console.log("PASS cold Cross Probe gesture, Cross Select menu, Nets table, and Altium file open");
};

module.exports.historyDemand = historyDemand;
