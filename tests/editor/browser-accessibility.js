"use strict";

// Run standalone with the pinned CI node_modules or as part of integration-browser.cjs.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

function axeScript() {
  try {
    return require.resolve("axe-core/axe.min.js", {paths:[__dirname, path.join(__dirname, "../../scripts/ci")]});
  } catch (error) {
    throw new Error("Chromium accessibility tests need axe-core from scripts/ci/package-lock.json. Run npm ci --prefix scripts/ci or use the locked CI NODE_PATH.", {cause:error});
  }
}

async function axeFindings(page, state) {
  if (!await page.evaluate(() => !!globalThis.axe?.run)) await page.addScriptTag({path:axeScript()});
  const findings = await page.evaluate(async () => {
    const finite = document.getAnimations().filter(a => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime));
    await Promise.race([
      Promise.allSettled(finite.map(a => a.finished)),
      new Promise(resolve => setTimeout(resolve, 400))
    ]);
    const result = await axe.run({runOnly:["wcag2a","wcag2aa","wcag21a","wcag21aa","best-practice"]});
    return result.violations.map(rule => ({
      id:rule.id,
      standard:rule.tags.includes("best-practice") ? "best practice" : "WCAG",
      nodes:rule.nodes.map(node => node.target.join(" > ") + " " + node.failureSummary)
    }));
  });
  return findings.map(rule => `${state} / ${rule.standard} ${rule.id}\n  ${rule.nodes.join("\n  ")}`);
}

async function focused(locator) {
  return locator.evaluate(node => node === document.activeElement);
}

async function focusRing(locator, label, fieldWrapper = null) {
  const state = await locator.evaluate((node, wrapper) => {
    const css = getComputedStyle(wrapper ? node.closest(wrapper) : node);
    return {
      focused: node === document.activeElement && node.matches(":focus-visible"),
      indicator: css.outlineStyle !== "none" && parseFloat(css.outlineWidth) >= 1 || css.boxShadow !== "none"
    };
  }, fieldWrapper);
  assert.deepEqual(state, {focused:true, indicator:true}, label);
}

function menuOf(page, name) {
  return page.locator(`.work-menu[data-menu="${name}"]`).first();
}

async function chooseMenu(page, name, ...path) {
  const menu = menuOf(page, name), press = key => page.keyboard.press(key);
  await menu.locator(":scope > summary").focus();
  await press("ArrowDown");
  for (const [i, nameOrAction] of path.entries()) {
    const target = menu.locator(`[data-action="${nameOrAction}"]:visible,[data-dock-target="${nameOrAction}"]:visible`)
      .or(menu.getByRole("menuitem", {name:nameOrAction, exact:true})).first();
    for (let j = 0; j < 90 && !(await focused(target)); j++) await press("ArrowDown");
    assert.ok(await focused(target), `${name}: keyboard reaches ${path.slice(0, i + 1).join(" / ")}`);
    await press(i === path.length - 1 ? "Enter" : "ArrowRight");
  }
}

async function walkMenus(page) {
  const press = key => page.keyboard.press(key), counts = {menus:0, submenus:0, commands:0};
  async function walk(list, name) {
    const entries = await list.evaluate(container => [...container.children].flatMap((node, i) => {
      const sub = node.classList.contains("submenu");
      const item = sub ? node.querySelector(":scope > .submenu-trigger") : node;
      return item?.matches('[role^="menuitem"]') && !item.disabled && item.getClientRects().length
        ? [{i, sub, label:item.dataset.action || item.textContent.trim()}] : [];
    }));
    for (const {i, sub, label} of entries) {
      const entry = list.locator(":scope > *").nth(i), button = sub ? entry.locator(":scope > .submenu-trigger") : entry;
      const actual = await button.evaluate(n => n === document.activeElement ? null : document.activeElement.outerHTML.slice(0,140));
      assert.equal(actual, null, `${name} / ${label} lies on the arrow-key path`);
      if (sub) {
        counts.submenus++;
        await press("ArrowRight");
        assert.equal(await button.getAttribute("aria-expanded"), "true");
        await walk(entry.locator(":scope > [role=menu]"), name + " / " + label);
        await press("Escape");
        assert.ok(await focused(button), "Escape returns to the submenu trigger");
        assert.equal(await button.getAttribute("aria-expanded"), "false");
      } else counts.commands++;
      await press("ArrowDown");
    }
  }
  const tops = await page.locator(".work-menu:visible").all();
  for (const top of tops) {
    const trigger = top.locator(":scope > summary"), name = await trigger.innerText();
    await trigger.focus();
    await press("Enter");
    assert.equal(await trigger.getAttribute("aria-expanded"), "true");
    counts.menus++;
    await walk(top.locator(":scope > [role=menu]"), name);
    await press("Escape");
    assert.ok(await focused(trigger), name + " returns focus to its trigger");
  }
  return counts;
}

async function inspectAX(cdp, role, name) {
  const {nodes} = await cdp.send("Accessibility.getFullAXTree");
  const matches = nodes.filter(n => !n.ignored && n.role.value === role && name.test(n.name?.value || ""));
  assert.ok(matches.length, `Chromium exposes ${role} ${name}`);
  return matches[0];
}

async function screenshot(page, directory, name) {
  if (!directory) return;
  await fs.mkdir(directory, {recursive:true});
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  await page.screenshot({path:path.join(directory, name + ".png"), animations:"disabled"});
}

const commandSearch = page => page.getByRole("dialog",{name:"Command palette",exact:true})
  .getByRole("combobox");

async function preferences(page, audit, detailed) {
  const search = commandSearch(page);
  await search.fill(">Preferences");
  await page.getByRole("option", {name:/^Preferences…/}).first().waitFor();
  await page.keyboard.press("Enter");
  const dlg = page.getByRole("dialog", {name:"Preferences"});
  const field = dlg.getByRole("searchbox", {name:"Search preferences"});
  await field.waitFor();
  assert.ok(await focused(field), "Preferences starts in its search field");
  await audit("Preferences");
  if (detailed) {
    assert.notEqual(await dlg.getAttribute("aria-modal"), "true");
    const close = dlg.getByRole("button", {name:"Close Preferences", exact:true});
    await page.keyboard.press("Shift+Tab");
    await focusRing(close, "reverse Tab reaches the Preferences close button");
    await page.keyboard.press("Tab");
    // The library search field (ui-search) rings the field itself, as every library field does.
    await focusRing(field, "Tab returns to the search field");
    await page.emulateMedia({forcedColors:"active"});
    try {
      await page.keyboard.press("Shift+Tab");
      const restingBorder = await field.evaluate(node => getComputedStyle(node).borderTopColor);
      await page.keyboard.press("Tab");
      const highlight = await field.evaluate(node => {
        const wrapper = getComputedStyle(node);
        return {focused:node === document.activeElement && node.matches(":focus-visible"), style:wrapper.outlineStyle,
          width:parseFloat(wrapper.outlineWidth), outline:wrapper.outlineColor};
      });
      assert.ok(highlight.focused && highlight.style === "solid" && highlight.width >= 2 && highlight.outline !== restingBorder,
        "forced colors distinguish the search focus indicator from the resting border: " + JSON.stringify({highlight,restingBorder}));
    } finally { await page.emulateMedia({forcedColors:"none"}); }
    await field.fill("Keyboard shortcuts");
    await page.keyboard.press("ArrowDown");
    const link = dlg.getByRole("button", {name:"Keyboard shortcuts…", exact:true});
    for (let i = 0; i < 30 && !(await focused(link)); i++) await page.keyboard.press("Tab");
    assert.ok(await focused(link), "the filtered Preferences command is reachable by Tab");
    await page.keyboard.press("Enter");
    const shortcuts = page.getByRole("dialog", {name:"Keyboard shortcuts editor"});
    await shortcuts.waitFor();
    assert.ok(await dlg.evaluate(d => d.open && !d.matches(":modal")), "Preferences stays open behind the shortcuts editor");
    await audit("Keyboard shortcuts editor");
    await page.keyboard.press("Tab");
    assert.ok(await shortcuts.evaluate(d => d.matches(":modal") && d.contains(document.activeElement)),
      "Tab remains in the modal shortcuts editor");
    await page.keyboard.press("Escape");
    await shortcuts.waitFor({state:"hidden"});
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(await focused(link), "closing the modal returns focus to the Preferences button that opened it");
  }
  // The search keeps its text when Preferences opens again; Escape clears a search field's text
  // before it closes the surface (docs/ui-library.md › Search fields).
  if (await focused(field) && await field.inputValue()) {
    await page.keyboard.press("Escape");
    assert.equal(await field.inputValue(), "", "Escape first clears the Preferences search");
    assert.ok(await dlg.isVisible(), "clearing the search leaves Preferences open");
  }
  await page.keyboard.press("Escape");
  await dlg.waitFor({state:"hidden"});
  // The palette was opened with / from the canvas (the app bar has no Search field since 2026-11-23).
  assert.ok(await page.evaluate(() => document.activeElement === AtriumNavHost.canvas()), "closing modeless Preferences restores focus to the canvas the palette was opened from");
}

async function editorPanels(page, audit, kind) {
  await chooseMenu(page, "window", "Panels", "navigator-panel");
  const navigator = page.getByRole("tree", {name:"Compiled design"});
  await navigator.waitFor();
  await navigator.focus();
  await page.keyboard.press("ArrowDown");
  assert.ok(await navigator.getAttribute("aria-activedescendant"), "Navigator arrow selects a tree item");
  await audit("Navigator");
  await chooseMenu(page, "window", "Panels", "navigator-panel");
  await navigator.waitFor({state:"hidden"});
  await chooseMenu(page, "window", "Panels", "nets-panel");
  const nets = page.getByRole("grid", {name:"Nets", exact:true});
  await nets.waitFor();
  await nets.focus();
  await page.keyboard.press("ArrowDown");
  assert.ok(await nets.getAttribute("aria-activedescendant"), "Nets exposes the active grid row");
  await audit("Nets");
  const netsTab = page.getByRole("tab", {name:"Nets", exact:true});
  const closeNets = page.getByRole("button", {name:"Close Nets", exact:true});
  await netsTab.focus();
  await page.keyboard.press("Tab");
  await focusRing(closeNets, "the active dock tab's close button is a distinct control");
  await page.keyboard.press("Enter");
  await nets.waitFor({state:"hidden"});

  await chooseMenu(page, "window", "Panels", "library-panel");
  await page.locator(".panel-library:visible").waitFor();
  await audit("Library");
  await page.locator('.dock-tab[aria-selected=true][aria-keyshortcuts=Delete]').focus();
  await page.keyboard.press("Delete");
  await page.locator(".panel-library:visible").waitFor({state:"hidden"});

  if (kind !== "pcb") return;
  await chooseMenu(page, "window", "Panels", "pour-manager");
  const pours = page.locator(".panel-pours:visible");
  await pours.getByText(/no polygon pours/i).waitFor();
  await audit("Pours with no polygons");
  await page.evaluate(() => {
    const h = AtriumNavHost;
    h.edit(() => h.doc().items.push(AtriumPolygonPour.make([[3,3],[9,3],[9,9],[3,9]], {name:"Accessibility test plane", net:"GND", layer:"Top"})));
  });
  const options = pours.getByRole("listbox");
  await options.waitFor();
  await options.focus();
  await page.keyboard.press("ArrowDown");
  assert.equal(await options.getByRole("option", {selected:true}).count(), 1);
  await audit("Pours with one polygon selected");
  const more = pours.getByRole("button", {name:/More actions for/});
  await more.focus();
  await page.keyboard.press("ArrowDown");
  await page.getByRole("menu", {name:/More actions for/}).waitFor();
  await audit("Pours actions");
  await page.keyboard.press("Escape");
  assert.ok(await focused(more), "Pours action menu restores its trigger");
  await page.getByRole("tab", {name:"Pours", exact:true}).focus();
  await page.keyboard.press("Delete");
  await pours.waitFor({state:"hidden"});
  await page.evaluate(() => {
    const h = AtriumNavHost;
    h.edit(() => {h.doc().items = h.doc().items.filter(item => item.name !== "Accessibility test plane");});
  });
}

async function editorViews(page, audit, kind, theme, screenshotDir) {
  if (kind === "pcb") {
    await chooseMenu(page, "design", "rules");
    const rules = page.getByRole("dialog", {name:"Rules and Constraints Editor"});
    const tree = rules.getByRole("tree", {name:"Design rules"});
    await tree.waitFor();
    await audit("Rules and Constraints");
    await page.keyboard.press("ArrowDown");
    const hints = tree.getByRole("treeitem", {name:"Rule Hints", exact:true});
    assert.ok(await focused(hints), "Rules exposes hints through its keyboard tree");
    await audit("Rule Hints");
    await screenshot(page, screenshotDir, "rule-hints-" + theme);
    await page.keyboard.press("Escape");
    await rules.waitFor({state:"hidden"});
    const tab = page.getByRole("tab", {name:"Rules and Constraints", exact:true});
    await tab.focus();
    await page.keyboard.press("Delete");
    await tab.waitFor({state:"hidden"});
  }

  await chooseMenu(page, "design", "netlist-view");
  const view = page.getByRole("tabpanel", {name:"Netlist", exact:true});
  const tab = page.getByRole("tab", {name:"Netlist", exact:true});
  const source = view.locator(".netlist-source");
  await source.waitFor();
  assert.equal(await page.getByRole("tablist", {name:"Design documents"}).getByRole("tab", {selected:true}).count(), 1);
  assert.equal(await tab.getAttribute("aria-selected"), "true");
  assert.equal(await tab.getAttribute("aria-controls"), await view.getAttribute("id"));
  assert.ok(await page.evaluate(() => AtriumNavHost.canvas().inert), "covered canvas is outside the Tab order");
  const link = source.getByRole("link", {name:kind === "pcb" ? "Show net GND" : "Show pin R1.2", exact:true}).first();
  await link.waitFor();
  await audit("Netlist document");
  await page.waitForFunction(() => document.activeElement?.matches(".netlist-source"));
  for (let i = 0; i < 180 && !(await focused(link)); i++) await page.keyboard.press("Tab");
  await focusRing(link, "the netlist reference is reachable and visibly focused");
  await screenshot(page, screenshotDir, `${kind}-netlist-${theme}`);
  await page.keyboard.press("Enter");
  await view.waitFor({state:"hidden"});
  assert.ok(await page.evaluate(() => AtriumNavHost.selection().length > 0 && document.activeElement === AtriumNavHost.canvas()));
  const activeTab = page.getByRole("tablist", {name:"Design documents"}).getByRole("tab", {selected:true});
  await activeTab.focus();
  for (let i = 0; i < 5 && !(await focused(tab)); i++) await page.keyboard.press("ArrowRight");
  assert.ok(await focused(tab), "a retained netlist can be reopened from the document tabs by arrow key");
  await view.waitFor();
  await page.keyboard.press("Delete");
  await tab.waitFor({state:"hidden"});
}

async function virtualNetlist(page, audit) {
  await page.evaluate(() => {
    const host = AtriumNavHost, sheet = host.project().documents.find(d => d.kind === "schematic");
    const original = sheet.items.find(item => item.ref === "J1");
    const parts = Array.from({length:112}, (_, i) => ({
      ...structuredClone(original), id:"accessibility-netlist-" + i, ref:"A11Y" + String(i).padStart(3, "0"), x:120 + 20 * i
    }));
    host.edit(() => sheet.items.push(...parts));
  });
  await chooseMenu(page, "design", "netlist-view");
  const view = page.getByRole("tabpanel", {name:"Netlist", exact:true}), source = view.locator(".netlist-source");
  await source.getByRole("link").first().waitFor();
  const initial = await source.getByRole("link").count();
  await page.waitForFunction(() => document.activeElement?.matches(".netlist-source"));
  await page.keyboard.press("End");
  await page.waitForFunction(initial => {
    const source = document.querySelector(".netlist-source");
    return source.scrollTop >= source.scrollHeight - source.clientHeight - 2 && source.querySelectorAll("[role=link]").length > initial;
  }, initial);
  await page.keyboard.press("Tab");
  assert.ok(await source.evaluate(n => {
    const link = document.activeElement, linkRect = link.getBoundingClientRect(), viewport = n.getBoundingClientRect();
    return n.contains(link) && link.matches("[role=link]") && linkRect.bottom > viewport.top && linkRect.top < viewport.bottom;
  }), "Tab from the scrolled viewport focuses a materialized reference in view");
  await audit("Netlist after keyboard scroll");
  await page.keyboard.press("Enter");
  await view.waitFor({state:"hidden"});
  await page.waitForFunction(() => AtriumNavHost.selection().length > 0 && document.activeElement === AtriumNavHost.canvas());
  const tab = page.getByRole("tab", {name:"Netlist", exact:true});
  await tab.focus();
  await page.keyboard.press("Delete");
  await tab.waitFor({state:"hidden"});
  await page.evaluate(() => {
    const host = AtriumNavHost, sheet = host.project().documents.find(d => d.kind === "schematic");
    host.edit(() => {sheet.items = sheet.items.filter(item => !item.ref?.startsWith("A11Y"));});
  });
}

module.exports = async function accessibility(browser, {screenshotDir} = {}) {
  const axe = axeScript();
  const page = await browser.newPage({viewport:{width:1320, height:860}, reducedMotion:"reduce"});
  page.setDefaultTimeout(6000);
  const errors = [], violations = [], inventory = {};
  page.on("pageerror", error => errors.push(error.message));
  const cdp = await page.context().newCDPSession(page);
  let context = "Start Page", audits = 0;
  async function audit(state) {
    violations.push(...await axeFindings(page, context + " / " + state));
    audits++;
  }
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    const demo = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Try the Demo", exact:true});
    await demo.waitFor();
    await page.addScriptTag({path:axe});
    await audit("Demo choices");
    await demo.click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    await page.mouse.move(1, 1);
    const themes = await page.evaluate(async () => {
      const library = await AtriumLazy.need("AtriumThemes");
      return [...AtriumTheme.PRESET_IDS, ...library.BUILTIN_IDS];
    });
    assert.equal(new Set(themes).size, 12, "every built-in theme is in the audit");
    const centre = page.locator("#canvas"); // / on the canvas opens the palette with no filter
    for (const theme of themes) for (const kind of ["pcb", "schematic"]) {
      context = theme + " " + kind;
      const detailed = theme === "dark" || theme === "light";
      await page.evaluate(theme => AtriumTheme.set({preset:theme, followSystem:false, motion:"off"}, {persist:false}), theme);
      await page.locator(`#document-tabs [data-kind="${kind}"]`).first().click();
      await page.mouse.move(1, 1);
      const name = kind === "pcb" ? "Sensor board" : "Analog front end";
      await page.waitForFunction(name => AtriumNavHost.canvas().getAttribute("aria-label") === name + " design canvas", name);
      await audit("Workbench");
      if (detailed) {
        await inspectAX(cdp, "tree", /^Project documents$/);
        await inspectAX(cdp, "treeitem", /^Sensor board$/);
        await inspectAX(cdp, "tabpanel", /^Properties$/);
        const trigger = menuOf(page, "file").locator(":scope > summary");
        await trigger.focus();
        await page.keyboard.press("Enter");
        await focusRing(menuOf(page, "file").getByRole("menuitem", {name:"New Project…", exact:true}), "Enter places focus inside File");
        await audit("File menu");
        await page.keyboard.press("Tab");
        assert.ok(await focused(menuOf(page, "edit").locator(":scope > summary")), "Tab leaves File from its trigger");
        assert.equal(await trigger.getAttribute("aria-expanded"), "false");
        const toolbar = page.getByRole("toolbar", {name:"Active Bar", exact:true});
        const select = toolbar.getByRole("button", {name:"Select", exact:true});
        await select.focus();
        await page.keyboard.press("ArrowDown");
        const tools = page.getByRole("menu", {name:"Select tools"});
        await tools.waitFor();
        await focusRing(tools.getByRole("menuitem", {name:"Select", exact:true}), "Active Bar opens its tool group by keyboard");
        await audit("Active Bar tool menu");
        await page.keyboard.press("Escape");
        assert.ok(await focused(select), "Active Bar restores focus to its tool");
        await page.keyboard.press("ArrowRight");
        await focusRing(toolbar.getByRole("button", {name:"Pan", exact:true}), "arrows move inside the Active Bar");
        if (theme === "dark") inventory[kind] = await walkMenus(page);
      }

      await centre.focus();
      await page.keyboard.press("/");
      const search = commandSearch(page);
      await search.fill(">Preferences");
      const preferencesCommand = page.getByRole("option", {name:/^Preferences…/}).first();
      await preferencesCommand.waitFor();
      if (theme === "classic") {
        const id = await preferencesCommand.getAttribute("id");
        for (let i = 0; i < 60 && (await search.getAttribute("aria-activedescendant")) !== id; i++)
          await page.keyboard.press("ArrowDown");
        assert.equal(await search.getAttribute("aria-activedescendant"), id, "the Classic Preferences command is selected");
        const hint = preferencesCommand.locator(".nav-palette-keys .ui-shortcut");
        await hint.locator(".ui-shortcut-visual:visible, .native-shortcut-ink:visible").first().waitFor();
        assert.ok(await hint.evaluate(hint => getComputedStyle(hint).color === getComputedStyle(hint.closest('[role="option"]')).color),
          "the selected shortcut uses the text ink for the actual palette row");
      }
      await audit("Command palette");
      if (detailed) {
        const before = await search.getAttribute("aria-activedescendant");
        await page.keyboard.press("ArrowDown");
        const after = await search.getAttribute("aria-activedescendant");
        assert.notEqual(after, before, "search changes active descendant without leaving the combobox");
        assert.equal(await page.locator(`#${after}`).getAttribute("aria-selected"), "true");
        await search.fill(">waffle-no-result-sample");
        assert.equal(await search.getAttribute("aria-expanded"), "false");
        assert.equal(await search.getAttribute("aria-activedescendant"), null);
        await page.getByRole("status").getByText(/No matching commands/).waitFor();
        await audit("Command palette without matches");
      }
      await preferences(page, audit, detailed);

      if (!detailed) continue;
      await centre.focus();
      await page.keyboard.press("/");
      await search.fill("@J1");
      const found = page.getByRole("option", {name:new RegExp("^J1.*" + name)});
      const target = found.first();
      const targetId = await target.getAttribute("id");
      for (let i = 0; i < 60 && (await search.getAttribute("aria-activedescendant")) !== targetId; i++) await page.keyboard.press("ArrowDown");
      assert.equal(await search.getAttribute("aria-activedescendant"), targetId, "the intended document's object is reachable in search");
      await page.keyboard.press("Enter");
      const selected = kind === "pcb" ? "Footprint J1 selected." : "Symbol J1 selected.";
      const summary = page.locator(".panel-properties #canvas-selection-summary");
      await summary.getByText(selected, {exact:false}).waitFor();
      const canvas = await inspectAX(cdp, "Canvas", new RegExp(name + " design canvas"));
      assert.ok(canvas.description?.value.includes(selected), "Chromium exposes the Properties summary as a canvas description");
      await page.waitForFunction(() => document.activeElement === AtriumNavHost.canvas());
      await audit("Selected object Properties");
      await screenshot(page, screenshotDir, `${kind}-selection-${theme}`);
      await page.keyboard.press("Shift+F10");
      const menu = page.getByRole("menu", {name:(kind === "pcb" ? "Component J1" : "Part J1"), exact:true});
      await menu.waitFor();
      await audit("Selected object context menu");
      await screenshot(page, screenshotDir, `${kind}-context-${theme}`);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.activeElement === AtriumNavHost.canvas());
      await chooseMenu(page, "edit", "Select", "select-all");
      await page.waitForFunction(() => /objects selected\. .*Component count/.test(document.getElementById("canvas-selection-summary").textContent));
      await page.keyboard.press("Escape");
      await editorPanels(page, audit, kind);
      await editorViews(page, audit, kind, theme, screenshotDir);
      if (kind === "pcb") {
        await page.getByRole("button", {name:"Split with Schematic", exact:true}).press("Enter");
        const pane = page.getByRole("tablist", {name:"Pane 2 documents"});
        await pane.waitFor();
        await inspectAX(cdp, "tablist", /^Pane 2 documents$/);
        await inspectAX(cdp, "Canvas", /^Analog front end design canvas$/);
        await audit("Split board and schematic");
        await page.getByRole("button", {name:"Close pane 2", exact:true}).press("Enter");
        await pane.waitFor({state:"hidden"});
      }
      if (kind === "schematic" && theme === "light") await virtualNetlist(page, audit);
    }
    assert.deepEqual(errors, [], "accessibility walkthrough emitted no page errors");
    assert.equal(violations.length, 0, violations.join("\n"));
    console.log(`PASS accessibility: ${audits} axe scans in ${themes.length} themes, plus Chrome accessibility trees and real keyboard interactions. ${JSON.stringify(inventory)}`);
  } catch (error) {
    if (violations.length && !error.message.includes(violations[0])) console.error(violations.join("\n"));
    throw error;
  } finally { await page.close(); }
};

module.exports.check = async function check(page, state) {
  const violations = await axeFindings(page, state);
  if (violations.length) throw new Error(violations.join("\n"));
};

if (require.main === module) {
  const take = flag => process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined;
  require("../support/standalone-chromium.cjs")(
    () => {
      const executablePath = take("--executable") || process.env.CHROME;
      return executablePath ? {executablePath} : {channel:"chrome"};
    },
    browser => module.exports(browser, {screenshotDir:take("--snapshots")}),
    error => { console.error(error); process.exitCode = 1; });
}
