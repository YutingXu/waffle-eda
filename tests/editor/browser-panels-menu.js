"use strict";

// Panels are reached the VS Code way, with no icon rail on the right edge: dock tab headers carry
// the open panels and always end with ⋯ (the tabs that do not fit, then every panel), Window › Panels lists every
// panel with a check on the open ones, and a closed panel comes back from that menu or the command
// palette. The 1480×950 schematic strip is owned here too. Run standalone or with
// integration-browser.cjs --panels-only.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {ITEM, openPanelsMenu, windowPanel, panelChecked} = require("../support/window-panels.cjs");

const APP = path.join(__dirname, "../../app");

const front = (page, id) => page.evaluate(id => {
  const panel = document.querySelector('[data-dock-panel="' + id + '"]');
  return !!panel && panel.getClientRects().length > 0 && !panel.classList.contains("dock-inactive") && !panel.hidden;
}, id);
const open = (page, id) => page.evaluate(id => !!globalThis.AtriumDock.panels().find(p => p.id === id)?.open, id);
const PCB_LIST_MODULE = "pcb-list";

async function insightsMenu(page) {
  const tabs = page.locator('#document-tabs [data-kind="schematic"]');
  await tabs.first().click();
  const tools = page.locator('.menubar details[data-menu="tools"]');
  const action = tools.locator('[data-action="insights-panel"]');
  const messages = page.locator('[data-dock-panel="messages"]');
  const list = messages.locator(".msg-grid");
  const refresh = messages.locator(".msg-head button:not([hidden])").filter({hasText:/^Check again$/});
  const panelTab = page.locator('[data-dock-tab="messages"]');
  const showsInsights = async description => {
    await messages.waitFor();
    await refresh.waitFor({state:"attached"});
    assert.equal(await panelTab.getAttribute("aria-selected"), "true", description + " activates the Messages dock tab");
    assert.equal(await messages.getByRole("tab", {name:"Problems", exact:true}).getAttribute("aria-selected"), "true");
    assert.equal(await list.evaluate(el => el === document.activeElement), true, description + " focuses the visible list");
    assert.ok(await page.evaluate(() => {
      const d = AtriumNavHost.doc();
      return d.kind === "schematic" && AtriumMessages.messages().some(m => m.group === "Insights" && m.documentId === d.id && m.insightSummary);
    }), description + " publishes the active schematic's Insights");
  };

  // Warm the ordinary panel through its Window entry. The Insights command
  // reuses it, replacing the view controls and moving focus from the menu.
  await windowPanel(page, "messages");
  await messages.waitFor();
  await tools.locator(":scope > summary").click();
  await action.click();
  await showsInsights("Tools menu click");

  // Keep Messages open behind Properties, with the right dock collapsed.
  await windowPanel(page, "properties");
  await windowPanel(page, "properties");
  assert.equal(await open(page, "messages"), true);
  assert.equal(await front(page, "messages"), false);
  assert.equal(await page.locator("body").evaluate(el => el.classList.contains("hide-right")), true);
  await tools.locator(":scope > summary").press("ArrowDown");
  await action.focus();
  await page.keyboard.press("Enter");
  await showsInsights("Tools menu keyboard activation");
  assert.equal(await page.locator("body").evaluate(el => el.classList.contains("hide-right")), false);
  await windowPanel(page, "messages");
  await page.waitForFunction(() => !AtriumMessages.isOpen());
  await page.locator('#document-tabs [data-kind="pcb"]').first().click();
}

module.exports = async function panelsMenu(browser) {
  const page = await browser.newPage({viewport:{width:1280, height:800}, reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
    await page.goto(pathToFileURL(path.join(APP, "index.html")).href);
    const demo = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Try the Demo", exact:true});
    await demo.waitFor(); await demo.click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    await page.waitForFunction(() => !!globalThis.AtriumDock?.current?.());

    // No rail: nothing on the right edge but the Properties side bar, which reaches the window edge.
    const edge = await page.evaluate(() => {
      const bench = document.getElementById("workbench"), props = document.getElementById("properties").getBoundingClientRect();
      return {rail:document.querySelectorAll(".panel-rail, [class*=panel-rail]").length,
        columns:getComputedStyle(bench).gridTemplateColumns.split(" ").length,
        gap:Math.round(bench.getBoundingClientRect().right - props.right), right:props.right, width:innerWidth};
    });
    assert.equal(edge.rail, 0, "the panel rail is gone");
    assert.equal(edge.columns, 3, "the workbench grid is side bar, editor, properties");
    assert.equal(edge.gap, 0, "Properties reaches the right edge of the workbench");
    assert.equal(edge.right, Math.round(edge.right), "Properties ends on a whole pixel");

    await insightsMenu(page);

    // Every docked panel in Window › Panels opens, shows its check, and closes again.
    const items = await (await openPanelsMenu(page)).locator("[data-dock-target]").evaluateAll(nodes =>
      nodes.filter(n => !n.hidden && !n.disabled).map(n => ({id:n.dataset.dockTarget, label:n.textContent.trim()})));
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    assert.ok(items.length >= 10, "Window › Panels lists the docked panels (" + items.map(i => i.label).join(", ") + ")");
    assert.ok(items.some(item => item.id === PCB_LIST_MODULE), "Window › Panels lists PCB List");
    for (const {id, label} of items) {
      if (id === "properties" || id === "components") continue;
      if (await open(page, id)) await windowPanel(page, id);
      assert.equal(await open(page, id), false, label + " starts closed");
      assert.equal(await panelChecked(page, id), false, label + " is unchecked while closed");
      await windowPanel(page, id);
      await page.waitForFunction(id => globalThis.AtriumDock.panels().find(p => p.id === id)?.open, id);
      if (id === PCB_LIST_MODULE) {
        await page.waitForFunction(() => globalThis.AtriumPCBList?.isOpen() && !!document.querySelector('[data-dock-tab="pcb-list"]'));
        const agrees = await page.evaluate(record => {
          const tab = document.querySelector('[data-dock-tab="' + record + '"]');
          const panelForTab = () => AtriumDock.panels().find(panel => panel.id === tab.dataset.dockTab);
          if (panelForTab()?.id !== record || !AtriumPCBList.isOpen()) return false;
          try {
            tab.dataset.dockTab = "board-list";
            return !panelForTab();
          } finally { tab.dataset.dockTab = record; }
        }, PCB_LIST_MODULE);
        assert.ok(agrees, "PCB List tab key matches its module record and a wrong key fails to resolve");
      }
      assert.ok(await front(page, id), label + " opens in front");
      if (id === "library" || id === "nets")
        assert.equal(await page.locator("dialog[open]").count(), 0, label + " opens without a dialog");
      assert.equal(await panelChecked(page, id), true, label + " is checked while open");
      await windowPanel(page, id);
      await page.waitForFunction(id => !globalThis.AtriumDock.panels().find(p => p.id === id)?.open, id);
      if (id === PCB_LIST_MODULE) await page.waitForFunction(() => !globalThis.AtriumPCBList.isOpen());
      assert.equal(await panelChecked(page, id), false, label + " is unchecked once closed");
    }

    // Core panels: Components comes to the front; Properties in front collapses the side bar and returns.
    await windowPanel(page, "components");
    assert.ok(await front(page, "components"), "Components comes to the front");
    assert.equal(await page.locator("dialog[open]").count(), 0, "Components opens without a dialog");
    assert.equal(await panelChecked(page, "components"), true, "Components is checked in front");
    assert.equal(await panelChecked(page, "properties"), false, "Properties behind a tab is unchecked");
    await windowPanel(page, "properties");
    assert.ok(await front(page, "properties"), "Properties comes back to the front");
    await windowPanel(page, "properties");
    assert.ok(await page.evaluate(() => document.body.classList.contains("hide-right")), "Properties in front collapses the side bar");
    await windowPanel(page, "properties");
    assert.ok(await front(page, "properties"), "Properties reopens the side bar");

    // A narrow dock, VS Code style: tabs keep their full labels, the ones that do not fit leave the strip for
    // the ⋯ menu at its end, and the active tab always shows.
    for (const id of ["nets", "messages", "pcb-list", "library", "scripting"]) if (!await open(page, id)) await windowPanel(page, id);
    const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const stripState = () => page.evaluate(() => {
      const s = document.querySelector('[data-dock-group^="right:"] .dock-tabs'), box = s.getBoundingClientRect();
      const more = s.querySelector(".dock-tab-overflow"), button = s.querySelector(".dock-tab-more"), b = button.getBoundingClientRect();
      const tabs = [...s.querySelectorAll("[data-dock-tab]")], shown = tabs.filter(t => t.getClientRects().length);
      const font = node => parseFloat(getComputedStyle(node).fontSize);
      return {width:Math.round(box.width), more:!more.hidden, size:[b.width, b.height], radius:getComputedStyle(button).borderRadius,
        inside:!more.hidden && b.left >= box.left && b.right <= box.right + .5,
        clipped:shown.filter(t => t.scrollWidth > t.clientWidth || t.parentElement.getBoundingClientRect().right > (more.hidden ? box.right : more.getBoundingClientRect().left) + .5).map(t => t.dataset.dockTab),
        active:tabs.find(t => t.getAttribute("aria-selected") === "true")?.dataset.dockTab,
        shown:shown.map(t => t.dataset.dockTab), hidden:tabs.filter(t => !t.getClientRects().length).map(t => t.dataset.dockTab),
        tabH:shown.length ? Math.min(...shown.map(t => t.getBoundingClientRect().height)) : 0,
        tabFont:shown.length ? Math.min(...shown.map(font)) : 0,
        docFont:font(document.querySelector(".document-tab")),
        rail:document.querySelectorAll(".panel-rail").length,
        edge:Math.round(innerWidth - document.getElementById("properties").getBoundingClientRect().right),
        fits:s.scrollWidth <= s.clientWidth};
    });
    // 1480×950 schematic: three tabs fit beside ⋯, a fourth overflows, and a squeezed long title is clipped.
    await page.locator('#document-tabs [data-kind="schematic"]').first().click();
    await page.setViewportSize({width:1480, height:950});
    if (await page.evaluate(() => document.body.classList.contains("hide-right"))) await windowPanel(page, "properties");
    const wantOpen = async (id, want) => {
      for (let n = 0; n < 3 && (await open(page, id)) !== want; n++) await windowPanel(page, id);
      assert.equal(await open(page, id), want, id + (want ? " opens" : " closes") + " for the schematic strip");
    };
    const rightOpen = await page.evaluate(() => AtriumDock.panels().filter(p => p.open && p.where === "right").map(p => p.id));
    for (const id of rightOpen) if (!["properties", "components", "library"].includes(id)) await wantOpen(id, false);
    for (const id of ["library", "components", "properties"]) await wantOpen(id, true);
    await settle();
    let sch = await stripState();
    assert.ok(sch.tabH >= 28 && sch.tabFont >= sch.docFont && sch.fits && sch.more && !sch.rail && !sch.edge,
      "schematic three-tab strip is usable at 1480×950: " + JSON.stringify(sch));
    assert.deepEqual([sch.clipped,sch.hidden],[[],[]],"all three schematic tabs show full labels");
    await wantOpen("nets", true);
    await settle();
    sch = await stripState();
    assert.ok(sch.more && sch.fits && sch.shown.includes(sch.active) && sch.hidden.length > 0,
      "the fourth schematic tab keeps the active tab and moves overflow into the menu: " + JSON.stringify(sch));
    assert.deepEqual(sch.clipped,[],"no schematic tab label is cut short");
    await page.evaluate(() => {
      const tab = document.querySelector('[data-dock-group^="right:"] .dock-tab[aria-selected="true"]');
      tab.dataset.qt01Label = tab.textContent;
      tab.textContent = "Scripting Console ".repeat(24);
      tab.parentElement.classList.add("dock-tab-squeezed");
      tab.style.inlineSize = "48px";
    });
    sch = await stripState();
    assert.ok(sch.clipped.length > 0, "a long title clips at the schematic breakpoint: " + sch.clipped.join(","));
    await page.evaluate(() => {
      const tab = document.querySelector('[data-dock-group^="right:"] .dock-tab[aria-selected="true"]');
      tab.textContent = tab.dataset.qt01Label;
      delete tab.dataset.qt01Label;
      tab.style.inlineSize = "";
      tab.parentElement.classList.remove("dock-tab-squeezed");
    });
    await settle();
    sch = await stripState();
    assert.deepEqual(sch.clipped, [], "the restored schematic label is not clipped");
    await page.locator('#document-tabs [data-kind="pcb"]').first().click();
    for (const id of ["nets", "messages", "pcb-list", "library", "scripting"]) if (!await open(page, id)) await windowPanel(page, id);
    await settle();
    // Nets in front: at the narrowest dock (176 px) a label as long as "Scripting Console" cannot fit beside ⋯ at all.
    await page.evaluate(() => AtriumDock.reveal("nets"));
    for (const width of [900, 700]) {
      await page.setViewportSize({width, height:800}); await settle();
      const st = await stripState();
      assert.ok(st.more && st.inside, width + " px: the ⋯ button ends the tab header (" + st.width + " px dock)");
      assert.deepEqual(st.size, [24, 24], "the ⋯ button is a 24 px control");
      assert.equal(st.radius, "6px", "the ⋯ button has the control radius");
      assert.deepEqual(st.clipped, [], width + " px: no tab label is cut short or clipped");
      assert.ok(st.hidden.length > 0, width + " px: some tabs leave the strip");
      assert.ok(st.shown.includes(st.active), width + " px: the active tab always shows");
    }
    // The active tab takes the last slot when it would fall off the end.
    await page.setViewportSize({width:900, height:800}); await settle();
    let st = await stripState();
    const last = st.hidden.at(-1);
    await page.evaluate(id => AtriumDock.reveal(id), last); await settle();
    st = await stripState();
    assert.ok(st.shown.includes(last) && st.shown.at(-1) === last, "an active tab past the end shows in the last slot");
    assert.deepEqual(st.clipped, [], "and nothing is cut short");
    const more = page.locator('[data-dock-group^="right:"] .dock-tab-more');
    await more.click();
    const menu = page.locator(".nav-menu[role=menu]").filter({has:page.locator("[role^=menuitem]")}).last();
    await menu.waitFor();
    const rows = () => menu.locator(":scope > :is(hr, [role^=menuitem])").evaluateAll(nodes => nodes.map(n => n.localName === "hr" ? "-" :
      n.textContent.trim() + (n.getAttribute("aria-checked") === "true" ? " ✓" : "")));
    const listed = await rows();
    const titles = await page.evaluate(ids => ids.map(id => globalThis.AtriumDock.panels().find(p => p.id === id).title), st.hidden);
    const panelList = () => page.evaluate(() => {
      const ids = ["projects", ...[...document.querySelectorAll(".menubar [data-dock-target]")].map(b => b.dataset.dockTarget)];
      return ids.map(id => {const p = AtriumDock.panels().find(p => p.id === id); return p.title + (p.open ? " ✓" : "");});
    });
    const everyPanel = await panelList();
    assert.deepEqual(listed.slice(0, titles.length + 1).map(s => s.replace(" ✓", "")), [...titles, "-"], "the ⋯ menu lists the hidden tabs first, then a separator");
    assert.deepEqual(listed.slice(titles.length + 1, titles.length + 1 + everyPanel.length), everyPanel, "then every panel, checked when open");
    const pick = st.hidden[0];
    await menu.getByRole("menuitem", {name:titles[0], exact:true}).first().click();
    await page.waitForFunction(id => document.querySelector('[data-dock-tab="' + id + '"]')?.getAttribute("aria-selected") === "true", pick);
    await settle();
    assert.ok(await front(page, pick), titles[0] + " comes to the front from the ⋯ menu");
    st = await stripState();
    assert.ok(st.shown.includes(pick), "the chosen tab shows in the strip");
    assert.deepEqual(st.clipped, [], "the chosen tab shows its full label");
    await page.setViewportSize({width:1600, height:800});
    // A panel behind a tab comes to the front first; choosing it again closes it.
    for (const id of ["messages", "pcb-list", "library", "scripting"]) for (let n = 0; n < 2 && await open(page, id); n++) await windowPanel(page, id);
    await page.waitForFunction(() => !document.querySelector('[data-dock-group^="right:"] .dock-tab-hidden'));

    // ⋯ is always at the end of a tab strip, overflow or not: the panel list for this dock group.
    const moreFace = await more.evaluate(b => {
      const strip = b.closest(".dock-tabs"), r = b.getBoundingClientRect(), s = strip.getBoundingClientRect();
      return {shown:!!b.getClientRects().length && !b.closest("[hidden]"), label:b.getAttribute("aria-label"), tip:b.dataset.tooltipLabel,
        popup:b.getAttribute("aria-haspopup"), tab:b.tabIndex, end:Math.round(s.right - r.right), whole:[r.left, r.top, r.width, r.height].every(Number.isInteger)};
    });
    assert.deepEqual(moreFace, {shown:true, label:"Panels", tip:"More panels", popup:"menu", tab:0, end:4, whole:true}, "⋯ stays at the strip's end without overflow");
    // A closed panel chosen from ⋯ opens as a tab of this group; an open panel elsewhere comes to the front where it is.
    if (await open(page, "comments")) await windowPanel(page, "comments");
    const groupOf = id => page.evaluate(id => document.querySelector('[data-dock-panel="' + id + '"]')?.closest(".dock-group")?.dataset.dockGroup, id);
    const rightGroup = await more.evaluate(b => b.closest(".dock-group").dataset.dockGroup);
    await more.click();
    await menu.waitFor();
    assert.deepEqual(await rows(), await panelList(), "no hidden tabs: the menu is the panel list alone, with no separator");
    assert.ok(!(await rows()).includes("Comments ✓") && (await rows()).includes("Comments"), "a closed panel is unchecked");
    await menu.getByRole("menuitemcheckbox", {name:"Comments", exact:true}).click();
    await page.waitForFunction(() => AtriumDock.panels().find(p => p.id === "comments")?.open);
    assert.equal(await groupOf("comments"), rightGroup, "a closed panel opens in the ⋯ button's dock group");
    assert.ok(await front(page, "comments"), "and comes to the front there");
    const projectsGroup = await groupOf("projects");
    await more.click();
    await menu.waitFor();
    assert.ok((await rows()).includes("Projects ✓") && (await rows()).includes("Comments ✓"), "open panels are checked");
    await menu.getByRole("menuitemcheckbox", {name:"Projects", exact:true}).click();
    assert.equal(await groupOf("projects"), projectsGroup, "an open panel in another dock stays where it is");
    assert.ok(await front(page, "projects"), "and comes to the front");
    await windowPanel(page, "comments");
    await page.waitForFunction(() => !AtriumDock.panels().find(p => p.id === "comments")?.open);

    // Checkable menus keep a check gutter: labels start at the same x whether or not the row is checked.
    const sub = await openPanelsMenu(page);
    const barRows = await sub.locator("[data-dock-target], [data-action=toggle-left]").evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).map(n => {
      const range = document.createRange(); range.selectNodeContents(n.firstChild?.nodeType === 3 ? n : n.querySelector("span") || n);
      const r = range.getClientRects()[0];
      return {checked:n.getAttribute("aria-checked") === "true" || n.dataset.checked === "true", x:Math.round(r.left - n.getBoundingClientRect().left)};
    }));
    await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
    assert.ok(barRows.some(r => r.checked) && barRows.some(r => !r.checked), "Window › Panels has checked and unchecked rows");
    assert.equal(new Set(barRows.map(r => r.x)).size, 1, "Window › Panels labels share one x: " + JSON.stringify(barRows));
    const dropRows = await page.evaluate(async () => {
      const menu = await AtriumLazy.need("AtriumContextMenu"), trigger = document.querySelector("#collab-share");
      menu.dropdown(trigger, [{label:"Checked", enabled:true, checked:true, run(){}}, {label:"Unchecked", enabled:true, checked:false, run(){}},
        {label:"Radio on", enabled:true, checked:true, radio:true, run(){}}, {label:"Radio off", enabled:true, checked:false, radio:true, run(){}}]);
      await new Promise(r => requestAnimationFrame(r));
      const rows = [...document.querySelectorAll(".nav-menu [role^=menuitem]")].filter(n => n.getClientRects().length);
      const out = rows.map(n => ({label:n.textContent.trim(), checked:n.getAttribute("aria-checked"), x:Math.round(n.querySelector("span").getBoundingClientRect().left - n.getBoundingClientRect().left),
        check:getComputedStyle(n, "::before").left}));
      menu.close(false);
      return out;
    });
    assert.equal(new Set(dropRows.map(r => r.x)).size, 1, "shared dropdown labels share one x: " + JSON.stringify(dropRows));
    assert.equal(dropRows[0].x, barRows[0].x, "the shared dropdown's check gutter matches the menu bar's");
    assert.ok(dropRows.filter(r => r.checked === "true").every(r => r.check === "7px"), "the check sits in the gutter, as in the menu bar");

    // A closed panel comes back: closed from its tab, reopened from Window › Panels and the palette.
    await page.locator('.dock-tab-close[data-dock-close="nets"]').click();
    await page.waitForFunction(() => !globalThis.AtriumDock.panels().find(p => p.id === "nets")?.open);
    assert.equal(await panelChecked(page, "nets"), false, "Nets is unchecked once its tab closes");
    await windowPanel(page, "nets");
    await page.waitForFunction(() => globalThis.AtriumDock.panels().find(p => p.id === "nets")?.open);
    assert.ok(await front(page, "nets"), "Window › Panels reopens a closed panel");
    await page.locator('.dock-tab-close[data-dock-close="nets"]').click();
    await page.waitForFunction(() => !globalThis.AtriumDock.panels().find(p => p.id === "nets")?.open);
    await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click();
    const input = page.locator("#palette").getByRole("combobox");
    await input.fill(">Nets panel");
    await page.locator("#palette").getByRole("option").filter({hasText:"Nets"}).first().click();
    await page.waitForFunction(() => globalThis.AtriumDock.panels().find(p => p.id === "nets")?.open);
    assert.ok(await front(page, "nets"), "the command palette reopens a closed panel");
    await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click();
    await input.fill(">Components panel");
    await page.locator("#palette").getByRole("option").filter({hasText:"Components"}).first().click();
    await page.waitForFunction(() => {const p = document.querySelector('[data-dock-panel="components"]'); return p && !p.classList.contains("dock-inactive");});

    // The menu item for each panel carries the check role (no aria-expanded on a menu item).
    const roles = await page.locator(ITEM("nets")).evaluate(n => [n.getAttribute("role"), n.hasAttribute("aria-expanded")]);
    assert.deepEqual(roles, ["menuitemcheckbox", false], "Panels items are check items");

    assert.deepEqual(errors, [], "no page errors");
    console.log("PASS panels menu: no rail; Window › Panels opens, checks and closes every panel; 1480×950 schematic strip; narrow docks list hidden tabs; closed panels come back");
  } finally { await page.close(); }
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => {
      const executablePath = process.env.CHROME;
      return executablePath ? {executablePath} : {channel:"chrome", args:["--allow-file-access-from-files"]};
    },
    browser => module.exports(browser),
    error => { console.error(error); process.exitCode = 1; });
}
