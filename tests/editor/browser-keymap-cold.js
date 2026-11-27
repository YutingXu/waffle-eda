"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function coldEditorSearch(browser, url) {
  const page = await browser.newPage();
  page.setDefaultTimeout(5000);
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  await page.route("**/ui/kit.js", async route => { await ready; await route.continue(); });
  await page.addInitScript(() => localStorage.setItem("atrium.prefs", JSON.stringify({
    format:"atrium-prefs", version:1, values:{"general.startPage":"never"}
  })));
  try {
    await page.goto(url, {waitUntil:"domcontentloaded"});
    await page.evaluate(() => AtriumNavHost.act("keyboard-shortcuts"));
    const editor = page.getByRole("dialog", {name:"Keyboard shortcuts editor"});
    const search = editor.getByRole("searchbox", {name:"Search shortcuts"});
    await page.waitForFunction(() => AtriumLazy.pending("AtriumKeymapEditor") && AtriumLazy.pending("AtriumUIKit") ||
      document.querySelector(".keymap-dialog[open]"));
    assert.equal(await editor.isVisible(), false, "The cold dialog waits for its search field behaviour");
    release();
    await search.fill("wire");
    assert.equal(await editor.getByRole("button", {name:"Clear search"}).isVisible(), true);
    await search.press("Escape");
    assert.equal(await search.inputValue(), "");
    assert.equal(await editor.isVisible(), true);
    await search.press("Escape");
    await editor.waitFor({state:"hidden"});
    console.log("PASS the cold shortcut editor opens with its shared search field and Escape clears before closing.");
  } finally {
    release();
    await page.close();
  }
}

module.exports = async function coldKeymap(browser, app = path.join(__dirname, "../../app")) {
  const url = pathToFileURL(path.join(app, "index.html")).href;
  const cases = [
    ["altium", ["p", "w"], "P W"],
    ["classic", ["w"], "P W"],
    ["kicad", ["w"], "W"],
    ["vscode", ["w"], "P W"],
    ["allegro", ["F3"], "F3"],
    ["modern", ["r"], "R"],
    ["rts", ["p", "w"], "P W"],
    ["modern", ["Meta+k", "Meta+u"], "R", "continuation"],
    ["modern", ["r"], "R", "new-focus"],
    ["allegro", [], "F3", "menu"]
  ];
  for (const [preset, keys, binding, scenario] of cases) {
    const deferred = !["altium", "rts"].includes(preset);
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    let release;
    const ready = new Promise(resolve => {release = resolve;});
    await page.route("**/keymap-presets.js", async route => {
      if (deferred) await ready;
      await route.continue();
    });
    if (scenario === "continuation") await page.route("**/palette.js", route => route.abort());
    await page.addInitScript(preset => {
      Object.defineProperty(navigator, "platform", {value: "MacIntel"});
      localStorage.setItem("atrium.prefs", JSON.stringify({format:"atrium-prefs",version:1,values:{"general.startPage":"never"}}));
      localStorage.setItem("atrium-keymap-v1", JSON.stringify({format:"atrium-keys",version:1,preset,
        bindings:{save:[{key:"Mod+Alt+F7"}]}}));
    }, preset);
    try {
      const fetching = deferred ? page.waitForRequest("**/keymap-presets.js") : null;
      const boot = page.goto(url, {waitUntil: "domcontentloaded"});
      await Promise.all([fetching, boot]);
      await page.evaluate(() => {
        const host = AtriumNavHost;
        host.selectDocument(host.project().documents.find(doc => doc.kind === "schematic").id);
        host.canvas().focus();
        window.keyRuns = [];
        window.physicalKeys = [];
        document.addEventListener("keydown", event => {
          if (event.isTrusted && AtriumKeymap.eventKey(event) >= 0) physicalKeys.push(event.timeStamp);
        }, {capture:true});
        const invoke = AtriumKeymap.invoke;
        AtriumKeymap.invoke = (record, run) => {
          keyRuns.push({action:record.command.action, at:performance.now()});
          return invoke(record, run);
        };
      });
      for (const key of keys) await page.keyboard.press(key);
      if (deferred) {
        const early = await page.evaluate(() => ({
          preset: AtriumKeymap.preset(),
          unloaded: !globalThis.AtriumKeymapPresets,
          tool: AtriumNavHost.tool(),
          binding: AtriumKeymap.hintKey("route", "schematic"),
          runs: keyRuns
        }));
        assert.deepEqual(early, {preset, unloaded:true, tool:"select", binding:"", runs:[]},
          `${preset}: the first keys cannot run with the fallback map`);
      }
      const place = page.locator('.work-menu[data-menu="place"]');
      const wire = place.locator('[data-action="route"][data-scope="schematic"]');
      if (scenario === "new-focus") {
        await page.evaluate(() => {
          const input = document.createElement("input");
          input.id = "cold-keymap-test-field";
          document.body.append(input);
          input.focus();
        });
        await page.keyboard.type("input");
      }
      if (scenario === "menu") {
        await place.locator(':scope > summary').press("Enter");
        assert.equal(await wire.getAttribute("data-hint"), null);
        await wire.press("Enter");
        await page.waitForFunction(() => AtriumNavHost.tool() === "route");
      }
      const releasedAt = await page.evaluate(() => performance.now());
      release();
      if (scenario === "new-focus") {
        await page.waitForFunction(() => !!globalThis.AtriumKeymapPresets);
        assert.equal(await page.locator("#cold-keymap-test-field").inputValue(), "input");
        const actual = await page.evaluate(() => [AtriumNavHost.tool(), keyRuns.length]);
        assert.deepEqual(actual, ["select", 0]);
        assert.deepEqual(errors, []);
        console.log("PASS changing focus cancels a held canvas shortcut and keeps native text input.");
        continue;
      }
      if (scenario === "continuation") {
        await page.waitForFunction(() => keyRuns.some(run => run.action === "toggle-units"));
        const actions = await page.evaluate(() => keyRuns.map(run => run.action));
        assert.deepEqual(actions, ["command-palette", "toggle-units"]);
        assert.deepEqual(errors, []);
        console.log("PASS saved Modern on macOS: both physical strokes of ⌘K, ⌘U replay before the palette module loads.");
        continue;
      }
      await page.waitForFunction(() => AtriumNavHost.tool() === "route");
      await place.locator(':scope > summary').click();
      await page.waitForFunction(binding => {
        const node = document.querySelector('.work-menu[data-menu="place"] [data-action="route"][data-scope="schematic"]');
        return node.dataset.hint === AtriumKeymap.display(binding);
      }, binding);
      const actual = await page.evaluate(() => {
        const node = document.querySelector('.work-menu[data-menu="place"] [data-action="route"][data-scope="schematic"]');
        return {tool:AtriumNavHost.tool(), actions:keyRuns.map(run => run.action), dispatchAt:keyRuns[0]?.at,
          lastPhysical:physicalKeys.at(-1),
          binding:AtriumKeymap.hintKey("route","schematic"), hint:node?.dataset.hint,
          saved:AtriumKeymap.hintFor("save","schematic"), spoken:AtriumKeymap.display(AtriumKeymap.hintKey("save","schematic"),true)};
      });
      assert.equal(actual.tool,"route",preset);
      assert.equal(actual.binding,binding,preset);
      const visual = await page.evaluate(binding => AtriumKeymap.display(binding), binding);
      assert.equal(actual.hint,visual,preset);
      assert.deepEqual(actual.actions,scenario === "menu" ? [] : ["route"],preset);
      assert.equal(actual.saved,"⌥⌘F7",preset);
      assert.equal(actual.spoken,"Option+Command+F7",preset);
      assert.deepEqual(errors,[],preset);
      if (scenario === "menu") {
        console.log("PASS the first keyboard menu activation draws a wire while the preset file is held and its key refreshes after load.");
        continue;
      }
      const elapsed = (actual.dispatchAt - actual.lastPhysical).toFixed(1);
      const load = deferred ? `, ${(actual.dispatchAt - releasedAt).toFixed(1)} ms from release of held script` : "";
      console.log(`PASS saved ${preset}: first wire tool ${elapsed} ms from the final physical key${load}; menu "${visual}".`);
      if (preset === "modern") {
        await page.keyboard.press("Escape"); // close Place
        const canvas = await page.locator("#canvas").boundingBox();
        const before = await page.evaluate(() => AtriumNavHost.doc().items.filter(item => item.kind === "wire").length);
        const x = canvas.x + canvas.width * .7, y = canvas.y + canvas.height * .7;
        await page.mouse.click(x, y);
        await page.mouse.click(x + 30, y);
        await page.keyboard.press("Escape"); // commit the new wire
        await page.waitForFunction(count => AtriumNavHost.doc().items.filter(item => item.kind === "wire").length === count + 1, before);
        assert.deepEqual(errors, []);
        console.log("PASS the first cold Modern shortcut places a wire on the schematic with real pointer input.");
      }
    } finally {
      release();
      await page.close();
    }
  }
  await coldEditorSearch(browser, url);
};

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  const executablePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  (async () => {
    const browser = await chromium.launch({headless:true, executablePath, args:["--allow-file-access-from-files","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
    try { await module.exports(browser, process.argv[2]); }
    finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
