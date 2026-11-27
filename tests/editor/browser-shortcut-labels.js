"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function assertCaps(shortcut, binding, height = 20, variant = "keycap") {
  await shortcut.waitFor();
  const badge = await shortcut.evaluate((node, binding) => {
    const rect = item => item.getBoundingClientRect();
    const gap = (left, right) => rect(right).left - rect(left).right;
    const steps = [...node.querySelectorAll(":scope > .ui-shortcut-step")];
    const groups = steps.map(step => [...step.querySelectorAll(":scope > .ui-shortcut-cap")]);
    return {
      variant:node.dataset.variant,
      order:groups.map(caps=>caps.map(cap=>cap.querySelector(".ui-shortcut-visual").textContent)),
      visual:AtriumKeymap.displayKeys(binding),
      stepGaps:steps.slice(1).map((step, i)=>gap(steps[i],step)),
      chordGaps:groups.flatMap(caps=>caps.slice(1).map((cap, i)=>gap(caps[i],cap))),
      sizes:groups.flatMap(caps=>caps.map(cap=>rect(cap).height)),
      raw:[...node.childNodes].filter(child=>child.nodeType===Node.TEXT_NODE).map(child=>child.textContent).join("").trim(),
      spoken:node.querySelector(".shortcut-spoken")?.textContent,
      expectedSpoken:AtriumKeymap.display(binding,true),
    };
  },binding);
  assert.equal(badge.variant,variant,"the real surface draws shared outlined keycaps");
  assert.deepEqual(badge.order,badge.visual,"each physical key keeps the platform order");
  assert.ok(badge.sizes.length >= 1 && badge.sizes.every(size=>size===height), "every cap has the specified height");
  assert.ok(badge.stepGaps.every(gap=>gap===8), "steps are 8 px apart");
  assert.ok(badge.chordGaps.every(gap=>gap===4), "chord caps are 4 px apart");
  assert.equal(badge.raw,"","no handwritten shortcut appears next to the caps");
  assert.equal(badge.spoken,badge.expectedSpoken);
}

async function assertReferenceColumns(reference, expectedColumns) {
  const layout = await reference.evaluate(dialog => {
    const body = dialog.querySelector(".kcs-body");
    const rows = [...body.querySelectorAll(".kcs-row")].filter(row => row.getClientRects().length);
    const columns = new Map(), descriptions = [], keys = [];
    for (const row of rows) {
      const {left, right} = row.getBoundingClientRect();
      const edge = columns.get(left) ?? right;
      columns.set(left, edge);
      const label = row.querySelector("dt");
      const shortcut = [...row.querySelectorAll("dd .ui-shortcut")].at(-1);
      if (Math.abs(label.getBoundingClientRect().left - left) > 0.5) descriptions.push(label.textContent);
      if (!shortcut || Math.abs(shortcut.getBoundingClientRect().right - edge) > 0.5) keys.push(label.textContent);
    }
    const overflow = Math.max(dialog.scrollWidth - dialog.clientWidth, body.scrollWidth - body.clientWidth);
    return {rows:rows.length, columns:columns.size, descriptions, keys, overflow};
  });
  assert.ok(layout.rows > 0, "the reference displays shortcut rows");
  if (expectedColumns != null) assert.equal(layout.columns, expectedColumns, "the reference uses the viewport's column count");
  assert.deepEqual(layout.descriptions, [], "shortcut descriptions align at the start of each visual column");
  assert.deepEqual(layout.keys, [], "shortcut keycaps align at the end of each visual column");
  assert.ok(layout.overflow <= 1, "shortcut groups wrap without horizontal scrolling");
}

module.exports = async function shortcutLabels(browser) {
  for (const [platform, visual, spoken] of [
    ["MacIntel", "⌥⌘F7", "Option+Command+F7"],
    ["Win32", "Ctrl+Alt+F7", "Control+Alt+F7"],
    ["Linux x86_64", "Ctrl+Alt+F7", "Control+Alt+F7"]
  ]) {
    const page = await browser.newPage({viewport: {width: 1400, height: 960}}), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    let releasePalette;
    const paletteReady = new Promise(resolve => {releasePalette = resolve;});
    await page.addInitScript(name => Object.defineProperty(navigator, "platform", {value: name}), platform);
    await page.route("**/palette.js", async route => {await paletteReady; await route.continue();});
    try {
      await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href, {waitUntil: "domcontentloaded"});
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
      const menu = name => page.locator(`.work-menu[data-menu="${name}"]`);
      const summary = name => menu(name).locator(":scope > summary");
      const toolbar = name => page.locator(`#tools [data-action="${name}"]`);
      const action = (menuName, name) => menu(menuName).locator(`[data-action="${name}"]`);
      const hintFor = (name, words) => page.evaluate(([name, words]) => AtriumKeymap.display(AtriumKeymap.hintKey(name, AtriumNavHost.doc().kind), words), [name, words]);
      const assertTitle = async (node, label, name) => {
        const binding = await page.evaluate(id => AtriumKeymap.hintKey(id, AtriumNavHost.doc().kind) || null, name);
        assert.equal(await node.getAttribute("data-tooltip-label"), label);
        assert.equal(await node.getAttribute("data-tooltip-shortcut"), binding);
        assert.equal(await node.getAttribute("aria-description"), await hintFor(name, true) || null);
      };

      await page.evaluate(() => {
        AtriumKeymap.setBindings("save", ["Mod+Alt+F7"]);
        AtriumKeymap.setBindings("split-toggle", ["Mod+F9"]);
        AtriumKeymap.setBindings("measure", ["Mod+F2"]);
        AtriumKeymap.setBindings("command-palette", ["Meta+Shift+F8"]);
      });
      const quickSave = page.locator('.quick-access [data-action="save"]');
      await assertTitle(quickSave, "Save", "save");
      assert.equal(await quickSave.getAttribute("data-tooltip-shortcut"), "Mod+Alt+F7");
      assert.equal(await toolbar("measure").getAttribute("data-tooltip-label"), "Measure distance");
      assert.equal(await toolbar("measure").getAttribute("data-tooltip-shortcut-suffix"), " · hold for more");
      assert.ok((await toolbar("measure").getAttribute("aria-description"))?.startsWith(await hintFor("measure", true)));
      const split = page.locator('.editor-tabbar [data-action="split-toggle"]');
      await assertTitle(split, "Split editor right", "split-toggle");
      await assertTitle(toolbar("route"), "Route track", "route");
      await assertTitle(toolbar("label"), "Place text", "label");
      // Panels are reached from Window › Panels (no icon rail): the Library item shows the panel's shortcut.
      await summary("window").click();
      await menu("window").locator("#sub-window-panels > .submenu-trigger").click();
      const libraryItem = menu("window").locator('#sub-window-panels [data-dock-target="library"]');
      await libraryItem.waitFor();
      const libraryHint = await hintFor("library-panel", false);
      assert.ok(libraryHint, "the Library panel has a default shortcut");
      assert.equal(await libraryItem.getAttribute("data-hint"), libraryHint);
      assert.equal(await libraryItem.getAttribute("aria-description"), await hintFor("library-panel", true));
      await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
      if (await menu("window").evaluate(node => node.open)) await summary("window").click();

      await summary("file").press("ArrowDown");
      const menuSave = menu("file").getByRole("menuitem", {name: "Save Project", exact: true});
      assert.equal(await menuSave.getAttribute("data-hint"), visual);
      assert.equal(await menuSave.getAttribute("aria-description"), spoken);
      const savedShortcut = menuSave.locator('.ui-shortcut[data-variant="inline"]');
      assert.equal(await savedShortcut.locator(".ui-shortcut-visual").textContent(), visual);
      const metrics = await savedShortcut.evaluate(node => {
        const inline = AtriumShortcut.render("Mod+Shift+P", {variant:"inline"});
        const inlineSave = AtriumShortcut.render("Mod+Alt+F7", {variant:"inline"});
        const inlineP = AtriumShortcut.render("P", {variant:"inline"});
        const caps = AtriumShortcut.render("Mod+Shift+P Mod+S");
        const capsInSpan = AtriumShortcut.render("Mod+Shift+P Mod+S", {node:document.createElement("span")});
        const fixture = document.createElement("div");
        fixture.style.position = "fixed";
        fixture.append(inline, inlineSave, inlineP, caps, capsInSpan);
        document.body.append(fixture);
        const rect = element => element.getBoundingClientRect();
        const physicalKeys = [...caps.firstElementChild.children];
        const visualOf = shortcut => shortcut.querySelector(".ui-shortcut-visual");
        const outline = element => [element.offsetWidth, element.offsetHeight].join();
        const font = element => {
          const css = getComputedStyle(element);
          return [css.fontFamily, css.fontSize, css.fontWeight, css.lineHeight].join();
        };
        const glyph = element => {
          const marker = document.createElement("span");
          marker.style.display = "inline-block";
          element.after(marker);
          const {width, height, top} = rect(element), baseline = rect(marker).top - top;
          marker.remove();
          return [font(element), width, height, baseline].join();
        };
        const gap = (left, right) => rect(right).left - rect(left).right;
        const result = {
          sameGlyph: glyph(visualOf(inlineP)) === glyph(visualOf(physicalKeys.at(-1))),
          matchesMenuFont: font(visualOf(node)) === font(visualOf(inline)),
          sameInlineBox: outline(node) === outline(inlineSave),
          sameCapBox: outline(caps) === outline(capsInSpan),
          stepGap: gap(caps.children[0], caps.children[1]),
          keyGaps: physicalKeys.slice(1).map((cap, i) => gap(physicalKeys[i], cap)),
          minCap: [rect(physicalKeys.at(-1)).width, rect(physicalKeys.at(-1)).height],
          fontSize: getComputedStyle(visualOf(inline)).fontSize,
          text: visualOf(inline).textContent,
          keys: physicalKeys.map(key => visualOf(key).textContent)
        };
        fixture.remove();
        return result;
      });
      assert.deepEqual(metrics, {
        sameGlyph:true, matchesMenuFont:true, sameInlineBox:true, sameCapBox:true,
        stepGap:8, keyGaps:[4, 4], minCap:[20, 20], fontSize:"11px",
        text:platform === "MacIntel" ? "⇧⌘P" : "Ctrl+Shift+P",
        keys:platform === "MacIntel" ? ["⇧", "⌘", "P"] : ["Ctrl", "Shift", "P"]
      });
      await page.keyboard.press("Escape");
      await summary("route").press("ArrowDown");
      const route = menu("route").getByRole("menuitem", {name: "Interactive Routing", exact: true});
      assert.equal(await route.getAttribute("data-hint"), await hintFor("route"));
      await page.keyboard.press("Escape");
      await summary("window").press("ArrowDown");
      assert.equal(await action("window", "split-right").getAttribute("data-hint"), null, "a different split command has no phantom hint");
      await page.evaluate(() => AtriumKeymap.setBindings("split-right", ["Ctrl+Alt+F4"]));
      assert.equal(await action("window", "split-right").getAttribute("data-hint"), await hintFor("split-right"));
      await page.keyboard.press("Escape");

      // View › Command Palette… shows the live key before the palette loads (the app bar has no Search field).
      const paletteItem = action("view", "command-palette");
      await summary("view").click();
      await paletteItem.waitFor();
      assert.equal(await paletteItem.getAttribute("data-hint"), await hintFor("command-palette"));
      assert.equal(await paletteItem.getAttribute("aria-description"), await hintFor("command-palette", true));
      assert.equal(await page.evaluate(() => typeof globalThis.AtriumPalette), "undefined", "the cold menu exposes live keys before the palette loads");
      await paletteItem.click();
      releasePalette();
      const palette = page.locator("dialog.nav-palette[open]"), input = palette.locator("input");
      await palette.waitFor();
      await input.fill(">save");
      const saveRow = palette.locator('.nav-palette-item').filter({has: page.locator('.nav-palette-label', {hasText: /^Save Project$/})});
      await assertCaps(saveRow.locator(".ui-shortcut"), "Mod+Alt+F7");
      const run = palette.locator('button[aria-keyshortcuts="Enter"]');
      const actions = palette.locator('button[aria-haspopup="menu"]');
      const escape = palette.locator('button[aria-keyshortcuts="Escape"]');
      const returnBadge = run.locator(".ui-shortcut");
      await assertCaps(returnBadge, "Enter");
      await returnBadge.evaluate(node => {node.dataset.variant = "inline";});
      await assert.rejects(assertCaps(returnBadge,"Enter"), /real surface draws shared outlined keycaps/);
      await returnBadge.evaluate(node => {node.dataset.variant = "keycap";});
      await assertCaps(actions.locator(".ui-shortcut"), "Mod+K");
      assert.equal(await run.locator(".shortcut-spoken").textContent(), platform === "MacIntel" ? "Return" : "Enter");
      assert.equal(await run.locator(".ui-shortcut-visual").textContent(), platform === "MacIntel" ? "⏎" : "Enter");
      for (const control of [run,actions]) {
        const position = await control.evaluate(button => {
          const cap = button.querySelector(".ui-shortcut").getBoundingClientRect(), box = button.getBoundingClientRect();
          return Math.abs(cap.top+cap.height/2-box.top-box.height/2);
        });
        assert.ok(position<=0.5,"the footer cap is centred in its button");
      }
      await page.evaluate(() => AtriumKeymap.setBindings("save", ["Mod+Alt+F7 U U N"]));
      await assertCaps(saveRow.locator(".ui-shortcut"), "Mod+Alt+F7 U U N");
      assert.equal(await saveRow.locator(".ui-shortcut-step").count(),4,"a real palette sequence draws one group for every step");
      assert.equal(await input.inputValue(), "save");
      assert.equal(await palette.getByRole("button", {name:"Remove Commands scope"}).isVisible(), true);
      await input.fill(">qzxqzxqzx");
      await assertCaps(escape.locator(".ui-shortcut"), "Escape");
      await page.keyboard.press("Escape");

      await palette.waitFor({state:"hidden"});
      await page.evaluate(async () => (await AtriumLazy.need("AtriumPrefs")).open("general"));
      const preferences = page.locator("dialog.prf-dialog[open]"), units = preferences.locator("#prf-general-units-help");
      await units.waitFor();
      const shortcut = units.locator(".ui-shortcut");
      const unitBinding = await page.evaluate(() => AtriumKeymap.hintKey("toggle-units",AtriumNavHost.doc().kind));
      assert.equal(unitBinding,"Q","the stock canvas action binds Q");
      await assertCaps(shortcut,unitBinding,16,"inline-keycap");
      assert.deepEqual(await units.evaluate(node=>[...node.childNodes].filter(child=>child.nodeType===Node.TEXT_NODE)
        .map(child=>child.textContent)),["Press "," on the canvas to switch units."]);
      const baseline = await units.evaluate(node => {
        const marker = () => {
          const sentinel = document.createElement("span");
          sentinel.style.cssText = "display:inline-block;inline-size:0;block-size:0;vertical-align:baseline";
          return sentinel;
        };
        const prose = marker(), cap = marker();
        node.prepend(prose);
        node.querySelector(".ui-shortcut-visual").after(cap);
        const difference = Math.abs(prose.getBoundingClientRect().top-cap.getBoundingClientRect().top);
        prose.remove(); cap.remove();
        return difference;
      });
      assert.ok(baseline<=0.5,"the inline cap glyph shares the real Preferences text baseline");
      await page.evaluate(() => AtriumKeymap.setBindings("toggle-units", ["Mod+F8"]));
      await assertCaps(shortcut,"Mod+F8",16,"inline-keycap");
      await page.evaluate(() => AtriumKeymap.setBindings("toggle-units", []));
      assert.equal(await shortcut.count(),0,"an unbound units command has no phantom Q");
      assert.equal(await units.textContent(),"Switch units on the canvas.");
      await page.evaluate(async () => {
        AtriumKeymap.resetCommand("toggle-units");
        await AtriumI18n.setLocale("en-XA");
      });
      await page.waitForFunction(() => document.querySelector("#prf-general-units-help")?.firstChild.textContent !== "Press ");
      await assertCaps(shortcut,"Q",16,"inline-keycap");
      assert.doesNotMatch(await units.textContent(), /\{shortcut\}|\uFFFC/,"the translated placeholder becomes a rendered cap");
      await page.evaluate(() => AtriumI18n.setLocale("en"));
      await page.keyboard.press("Escape");
      console.log(`PASS ${platform} palette caps and inline Preferences help (baseline delta ${baseline} px)`);

      await page.locator(".project-tree > summary").click({button: "right"});
      const context = page.locator('.nav-menu[role="menu"] [data-menu-action="save"]');
      assert.equal(await context.locator(".ui-shortcut .shortcut-spoken").textContent(), await hintFor("save", true));
      await page.evaluate(() => AtriumKeymap.setBindings("save", []));
      assert.equal(await context.locator(".ui-shortcut").count(), 0);
      await page.keyboard.press("Escape");
      await assertTitle(quickSave, "Save", "save");

      await page.evaluate(async () => {
        await AtriumLazy.need("AtriumKeymapPresets");
        AtriumKeymap.setPreset("kicad");
      });
      await assertTitle(toolbar("route"), "Route track", "route");
      await page.locator('#document-tabs [data-kind="schematic"]').click();
      await assertTitle(toolbar("route"), "Draw wire", "route");
      await assertTitle(toolbar("label"), "Place net label", "label");
      await summary("tools").press("ArrowRight");
      assert.equal(await summary("reports").evaluate(node => node === document.activeElement), true, "keyboard traversal skips the hidden PCB Route menu");
      await split.click();
      await assertTitle(split, "Close split", "split-toggle");
      const closeTab = page.locator(".pane-tab-close").first();
      assert.equal(await closeTab.getAttribute("aria-description"), platform === "MacIntel" ? "Forward Delete" : "Delete");
      await page.keyboard.press(platform === "MacIntel" ? "Meta+F9" : "Control+F9");
      await split.waitFor();

      await page.locator('#document-tabs [data-kind="pcb"]').click();
      await page.evaluate(() => {
        AtriumKeymap.setBindings("layer-mode", ["Alt+Shift+F7"]);
        AtriumKeymap.setBindings("snap-object", ["Alt+Shift+F8"]);
        AtriumKeymap.setBindings("query-clear", ["Mod+F10"]);
        AtriumKeymap.setBindings("net-colours", ["Alt+F2"]);
      });
      await assertTitle(page.locator(".layer-menu-button"), "Layer display · All layers", "layer-mode");
      await page.locator('[data-action="snap-options"]').click();
      const snap = page.locator(".pcb-edit-snap-pop").getByRole("checkbox", {name: "Snap to objects", exact: true});
      await assertTitle(snap, "Snap to objects", "snap-object");
      const snapKey = snap.locator("..").locator(".ui-shortcut-visual");
      assert.equal(await snapKey.textContent(), await hintFor("snap-object"));
      await snap.press("Escape");

      await page.evaluate(() => AtriumNavHost.act("query-panel"));
      const filter = page.locator(".panel-query:visible"), clear = filter.getByRole("button", {name:"Clear", exact:true});
      assert.equal(await filter.locator('.query-apply').getAttribute("aria-description"), platform === "MacIntel" ? "Return" : "Enter");
      await assertTitle(clear, "Clear the filter", "query-clear");
      await page.evaluate(() => AtriumKeymap.setBindings("query-clear", []));
      await assertTitle(clear, "Clear the filter", "query-clear");

      await page.evaluate(() => AtriumNavHost.act("nets-panel"));
      const override = page.locator(".panel-nets:visible").getByRole("button", {name:"Net colour override", exact:true});
      assert.equal(await override.locator(".ui-shortcut-visual").textContent(), await hintFor("net-colours"));
      await page.evaluate(() => AtriumKeymap.setBindings("net-colours", []));
      assert.equal(await override.textContent(), "Override");
      await assertTitle(override, "Net colour override on the board", "net-colours");

      await page.evaluate(() => {
        AtriumKeymap.setBindings("clipboard-picker", ["Mod+Alt+F6"]);
        AtriumKeymap.setBindings("copy", ["Mod+F6"]);
        AtriumNavHost.act("clipboard-picker");
      });
      const clipboard = page.getByRole("dialog", {name:"Clipboard history", exact:true});
      const hint = clipboard.locator('.clip-picker-key.ui-shortcut[data-variant="inline"]');
      const empty = clipboard.locator(".ui-dock-empty");
      assert.equal(await hint.locator(".ui-shortcut-visual").textContent(), platform === "MacIntel" ? "⌥⌘F6" : "Ctrl+Alt+F6");
      assert.equal(await hint.locator(".shortcut-spoken").textContent(), await hintFor("clipboard-picker", true));
      const copyHint = empty.locator('.ui-shortcut[data-variant="inline"]');
      assert.equal(await copyHint.locator(".ui-shortcut-visual").textContent(), platform === "MacIntel" ? "⌘F6" : "Ctrl+F6");
      assert.equal(await copyHint.locator(".shortcut-spoken").textContent(), await hintFor("copy", true));
      await page.keyboard.press("Escape");
      await clipboard.waitFor({state:"hidden"});
      await page.evaluate(() => {
        AtriumKeymap.setBindings("copy", []);
        AtriumNavHost.act("clipboard-picker");
      });
      await empty.waitFor();
      assert.equal(await copyHint.count(), 0, "an unbound Copy action does not show a shortcut");
      assert.equal(await empty.textContent(), "Copy something and it appears here.");
      await page.keyboard.press("Escape");

      await page.evaluate(() => AtriumNavHost.act("shortcuts"));
      const reference = page.getByRole("dialog", {name:"Keyboard shortcuts", exact:true});
      await reference.waitFor();
      for (const [width, height, columns] of [[1400, 960, 3], [390, 780, 1]]) {
        await page.setViewportSize({width, height});
        await assertReferenceColumns(reference, columns);
      }
      // A displacement within the real column must still fail either alignment check.
      for (const [cell, property, error] of [
        ["dt", "margin-inline-start", /shortcut descriptions align/],
        ["dd", "margin-inline-end", /shortcut keycaps align/]
      ]) {
        const first = reference.locator(`.kcs-row:visible ${cell}`).first();
        await first.evaluate((node, property) => node.style.setProperty(property, "8px"), property);
        await assert.rejects(assertReferenceColumns(reference, 1), error);
        await first.evaluate((node, property) => node.style.removeProperty(property), property);
      }
      await reference.getByRole("searchbox", {name:"Filter shortcuts"}).fill("Undo");
      assert.ok(await reference.locator(".kcs-row[hidden]").count() > 0, "search hides unrelated rows");
      await assertReferenceColumns(reference, 1);
      await reference.getByRole("button", {name:"Close keyboard shortcuts", exact:true}).press("Enter");
      await reference.waitFor({state:"hidden"});

      await page.setViewportSize({width: 900, height: 620});
      await page.evaluate(() => document.documentElement.style.setProperty("--fs-11", "14px"));
      assert.deepEqual(errors, []);
    } finally {
      releasePalette();
      await page.close();
    }
  }
  console.log("PASS shared shortcuts in palette, Preferences, menus, toolbars, search, inspector, filters, Nets and Clipboard History");
};

if (require.main === module) {
  const {chromium} = require("playwright-core");
  (async () => {
    const browser = await chromium.launch({channel: "chrome"});
    try { await module.exports(browser); } finally { await browser.close(); }
  })().catch(error => {console.error(error); process.exitCode = 1;});
}
