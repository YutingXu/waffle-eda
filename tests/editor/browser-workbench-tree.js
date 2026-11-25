"use strict";

// Real DOM focus, context menus and mutation counts. Run standalone with Node and playwright-core.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function editorChrome(browser) {
  for (const [theme,touch] of [["light",false], ["dark",false], ["light",true]]) {
    const page = await browser.newPage({viewport:{width:1400,height:960}, hasTouch:touch});
    try {
      await require("../fixtures/notebook-labs.cjs").profile(page);
      await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.evaluate(theme => AtriumTheme.setPreset(theme), theme);
      const tabs = page.getByRole("tablist", {name:"Design documents", exact:true});
      const active = tabs.getByRole("tab", {name:"Sensor board", exact:true});
      const inactive = tabs.getByRole("tab", {name:"Analog front end", exact:true});
      await active.waitFor();
      const projects = await page.evaluate(() => {
        const header = document.querySelector(".panel-projects > .pane-heading");
        const rect = node => node.getBoundingClientRect(), centre = box => [box.x + box.width / 2, box.y + box.height / 2];
        const title = rect(document.querySelector(".project-tree > summary"));
        return {
          header:rect(header).height, title:title.height, row:rect(document.querySelector("#documents .doc-row")).height,
          headerActions:header.querySelectorAll("[data-project-menu]").length,
          actions:[...document.querySelectorAll(".project-entry [data-project-menu]")].map(button => {
            const at = rect(button), mid = centre(at), icon = centre(rect(button.querySelector(".icon")));
            return {width:at.width, height:at.height, offset:[mid[0] - icon[0], mid[1] - icon[1], mid[1] - centre(title)[1]]};
          }),
          rail:document.querySelectorAll(".panel-rail").length,
          dockMenu:!!document.querySelector("#properties .dock-tab-more[aria-label=Panels]")?.getClientRects().length,
        };
      });
      assert.equal(projects.header,32);
      assert.equal(projects.title,24);
      assert.equal(projects.row,24);
      assert.equal(projects.headerActions,0);
      assert.equal(projects.rail,0,"no icon rail on the right edge");
      assert.equal(projects.dockMenu,true);
      assert.equal(projects.actions.length,2);
      const actionSize = touch ? 44 : 24;
      assert.ok(projects.actions.every(({width, height, offset}) =>
        width === actionSize && height === actionSize && offset.every(value => Math.abs(value) <= .5)));
      const launcher = page.getByRole("button", {name:"Insert at pointer", exact:true});
      const glyph = tab => tab.locator(".document-tab-close").evaluate(node => getComputedStyle(node).opacity);
      assert.equal(await launcher.isVisible(),touch);
      assert.equal(await glyph(active),"1");
      assert.equal(await glyph(inactive),touch ? "1" : "0");
      if (touch) await inactive.locator(".document-tab-close").tap();
      else {
        await inactive.hover();
        assert.equal(await glyph(inactive),"1");
        await inactive.press("Delete");
      }
      await inactive.waitFor({state:"hidden"});
      assert.equal(await active.getAttribute("aria-selected"),"true");
      if (theme === "light" && !touch) {
        const heading = await page.locator("#projects-heading").boundingBox();
        const pane = await page.locator(".panel-projects > .pane-heading").boundingBox();
        const x = (heading.x + heading.width + pane.x + pane.width) / 2, y = heading.y + heading.height / 2;
        await page.mouse.move(x,y);
        await page.mouse.down();
        await page.mouse.move(x + 70,y + 30,{steps:4});
        await page.locator(".dock-ghost").filter({hasText:"Projects"}).waitFor();
        await page.keyboard.press("Escape");
        await page.mouse.up();
        assert.equal(await page.locator("#navigator #projects-heading").isVisible(),true);
      }
    } finally {
      await page.close();
    }
  }
  console.log("PASS cold tab close, project-action alignment, keyboard and touch tab dismissal, and touch-only insertion");
}

async function touchProjects(browser) {
  const page = await browser.newPage({viewport:{width:520,height:810},hasTouch:true,isMobile:true,reducedMotion:"reduce"});
  page.setDefaultTimeout(6000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").tap();
    await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
    const rail = page.locator(".panel-rail"), panel = page.locator("#navigator");
    assert.equal(await rail.count(),0);
    assert.equal(await panel.isVisible(),false);
    await page.locator('[data-menu="window"] > summary').tap();
    await page.locator("#sub-window-panels > button").tap();
    await page.locator('#sub-window-panels [data-action="toggle-left"]').tap();
    const heading = panel.locator(".panel-projects > .pane-heading");
    await heading.waitFor();
    assert.equal((await heading.boundingBox()).height,32);
    const row = panel.getByRole("treeitem", {name:"Sensor board", exact:true});
    assert.equal((await row.boundingBox()).height,24);
    await panel.getByRole("button", {name:"Project actions for Sensor interface",exact:true}).tap();
    const menu = page.getByRole("menu", {name:"Project actions for Sensor interface",exact:true});
    await menu.getByRole("menuitem", {name:/^Connections: /}).tap();
    const scope = page.getByRole("dialog", {name:"Cross-sheet connections",exact:true});
    await scope.getByRole("button", {name:"Cancel",exact:true}).tap();
    assert.equal(await panel.isVisible(),true);
    assert.equal(await rail.count(),0);
  } finally {
    await page.close();
  }
  console.log("PASS narrow touch hides the side rail and opens Projects and Connections through their menus");
}

// Projects panel menus: a right-click rings its row while the menu is open (Finder) without changing the
// selection or focus, and the + menu, the project row and the tree background carry the File menu's
// project commands (the same actions, so the same handlers and keycaps).
async function projectMenus(browser) {
  const page = await browser.newPage({viewport:{width:1400,height:960}, reducedMotion:"reduce"}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    await page.evaluate(() => AtriumLazy.need("AtriumContextMenu"));
    const menu = page.locator(".nav-menu-portal > .nav-menu[role=menu]:not([inert])");
    const state = () => page.evaluate(() => ({
      current:[...document.querySelectorAll("#documents .doc-row")].map(row => row.getAttribute("aria-current")),
      targets:[...document.querySelectorAll("[data-context-target]")].map(node => node.dataset.doc || node.tagName),
      focus:document.activeElement?.id || "",
    }));
    const ring = locator => locator.evaluate(node => {
      const style = getComputedStyle(node), probe = document.createElement("i");
      probe.style.color = "var(--focus)"; document.body.append(probe);
      const focus = getComputedStyle(probe).color; probe.remove();
      return {style:style.outlineStyle, color:style.outlineColor === focus, fill:style.backgroundColor};
    });
    const other = page.locator("#documents .doc-row[aria-current=false]").first(), board = page.locator("#documents .doc-row[aria-current=true]");
    const otherId = await other.getAttribute("data-doc"), fill = (await ring(other)).fill;
    await page.locator("#canvas").focus();
    const before = await state();
    assert.equal(before.focus, "canvas");
    assert.deepEqual(before.targets, []);

    for (const dismiss of ["Escape", "outside"]) {
      await other.click({button:"right"});
      await menu.waitFor();
      assert.equal(await menu.getAttribute("aria-label"), await other.locator(".tree-label").textContent());
      const open = await state(), shown = await ring(other);
      assert.deepEqual(open.targets, [otherId], "the right-clicked row is the context target while its menu is open");
      assert.deepEqual(open.current, before.current, "a right-click does not change the selected document");
      assert.ok(shown.style === "solid" && shown.color, "the context target shows the focus-colour ring");
      assert.equal(shown.fill, fill, "the ring does not fill the row like the selection");
      assert.equal((await ring(board)).style, "none", "the selected row keeps its fill and no ring");
      if (dismiss === "Escape") await page.keyboard.press("Escape");
      else await page.mouse.click(1300, 900);
      await menu.waitFor({state:"detached"});
      const after = await state();
      assert.deepEqual(after.targets, [], "no context target remains after the menu closes (" + dismiss + ")");
      assert.deepEqual(after.current, before.current);
      if (dismiss === "Escape") assert.equal(after.focus, "canvas", "Escape returns focus to where it was, not to the row");
      assert.equal((await ring(other)).style, "none", "the row shows no ring after the menu closes");
      await page.locator("#canvas").focus();
    }
    // A second right-click moves the target.
    await other.click({button:"right"});
    await board.click({button:"right", position:{x:12, y:12}});
    assert.deepEqual((await state()).targets, [await board.getAttribute("data-doc")]);
    await page.keyboard.press("Escape");

    const file = await page.evaluate(() => Object.fromEntries(["New Project…", "Open…", "Close Project"].map(label =>
      [label, [...document.querySelectorAll("[data-menu=file] [data-action]")].find(node => node.textContent === label)?.dataset.action])));
    assert.deepEqual(file, {"New Project…":"new", "Open…":"open", "Close Project":"close-project"});
    await page.evaluate(() => { const host = AtriumNavHost; globalThis.__acts = []; globalThis.__act = host.act; host.act = action => { __acts.push(action); }; });
    const entries = () => menu.evaluate(root => [...root.querySelectorAll(":scope > hr, :scope > .nav-menu-item, :scope > .nav-sub")].map(node =>
      node.tagName === "HR" ? "-" : node.classList.contains("nav-sub")
        ? [node.firstChild.textContent, [...node.querySelectorAll(".nav-menu-item")].map(item => item.dataset.menuAction)]
        : [node.dataset.menuAction, node.querySelector("kbd")?.dataset.binding || ""]));

    const title = page.locator(".project-tree > summary");
    const add = page.getByRole("button", {name:"Add to Sensor interface", exact:true});
    const more = page.getByRole("button", {name:"Project actions for Sensor interface", exact:true});
    const isFocused = locator => locator.evaluate(node => node === document.activeElement);
    await title.press("Enter");
    assert.equal(await title.evaluate(node => node.parentElement.open), false);
    await page.keyboard.press("Tab");
    assert.equal(await isFocused(add), true);
    await page.keyboard.press("Tab");
    assert.equal(await isFocused(more), true);
    await page.keyboard.press("Enter");
    await menu.getByRole("menuitem", {name:/^Connections: /}).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await isFocused(more), true);
    assert.equal(await title.evaluate(node => node.parentElement.open), false, "the actions never toggle the title disclosure");
    await title.press("Enter");
    await add.click();
    await menu.waitFor();
    assert.deepEqual(await entries(), [["add-schematic",""], ["add-pcb",""], ["add-drawing",""], "-", ["add-existing",""], "-",
      ["new","Mod+N"], ["open","Mod+O"], "-", ["close-project",""]], "the + menu adds documents, then the File menu's project commands");
    for (const action of ["new", "open", "close-project"]) {
      if (!await menu.count()) await page.locator("[data-project-menu=add]").click();
      await menu.locator(`[data-menu-action="${action}"]`).click();
      await menu.waitFor({state:"detached"});
    }
    assert.deepEqual(await page.evaluate(() => __acts.splice(0)), ["new", "open", "close-project"], "the + menu dispatches the File menu actions");

    const projectMenu = ["new", "open", "close-project", "add-existing"];
    const nav = await page.locator("#navigator").boundingBox();
    for (const [where, open] of [
      ["tree background", () => page.mouse.click(nav.x + 60, nav.y + nav.height - 40, {button:"right"})],
      ["empty space below the tree", () => page.mouse.click(nav.x + 60, nav.y + 200, {button:"right"})],
      ["project row", () => page.locator(".project-tree > summary").click({button:"right"})],
    ]) {
      await open();
      await menu.waitFor();
      const list = await entries(), flat = list.flatMap(entry => entry === "-" ? [] : Array.isArray(entry[1]) ? entry[1] : [entry[0]]);
      for (const action of [...projectMenu, "add-schematic", "add-pcb", "add-drawing"]) assert.ok(flat.includes(action), where + " offers " + action);
      const targets = (await state()).targets;
      assert.deepEqual(targets, where === "project row" ? ["SUMMARY"] : [], where + " context target");
      await menu.locator('[data-menu-action="new"]').click();
      assert.deepEqual(await page.evaluate(() => __acts.splice(0)), ["new"], where + " dispatches New Project");
      assert.deepEqual((await state()).targets, []);
    }
    await title.focus();
    await page.keyboard.press("Shift+F10");
    assert.equal(await menu.getAttribute("aria-label"), "Sensor interface");
    await page.keyboard.press("Escape");
    assert.equal(await isFocused(title), true);
    await other.click({button:"right"});
    const documentMenu = (await entries()).map(entry => entry[0]);
    assert.ok(documentMenu.includes("rename-document") && !documentMenu.includes("new"), "a document row offers document actions");
    await page.keyboard.press("Escape");
    await page.evaluate(() => { AtriumNavHost.act = __act; });
    assert.deepEqual(errors, []);
    console.log("PASS project menus: right-click ring without selection or focus change; project commands in + / background / project row");
  } finally {
    await page.close();
  }
}

async function projectMenuTargets(browser) {
  const page = await browser.newPage({viewport:{width:1400,height:960}, reducedMotion:"reduce"});
  page.setDefaultTimeout(8000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.getByRole("button", {name:"Continue to editor", exact:true}).click();
    const addUntitled = page.getByRole("button", {name:"Add to Untitled", exact:true});
    await addUntitled.click();
    const addMenu = page.getByRole("menu", {name:"Add to Untitled", exact:true});
    assert.equal(await addMenu.getByRole("menuitem", {name:"Close Project", exact:true}).isDisabled(), true);
    await addMenu.locator('[data-menu-action="new"]').press("Enter");
    const newProject = page.getByRole("dialog", {name:"New project", exact:true});
    await newProject.getByRole("button", {name:"Cancel", exact:true}).click();

    const first = "First row fixture", secondName = "Second row fixture";
    await page.evaluate(async name => {
      await AtriumLazy.need("AtriumRules");
      const design = Atrium.project(name);
      AtriumProjectRules.setNetScope(design, "flat");
      return AtriumNavHost.replaceProject(design, {force:true, copy:true, dirty:false});
    }, first);
    const source = require("node:fs").readFileSync(path.join(__dirname, "../fixtures/import/demo.kicad_pcb"));
    await page.locator("#file-input").setInputFiles({name:secondName + ".kicad_pcb", mimeType:"application/octet-stream", buffer:source});
    const [second] = await Promise.all([page.waitForEvent("popup"),
      page.getByRole("button", {name:"Open in new window", exact:true}).click()]);
    const state = win => win.evaluate(() => {
      const project = AtriumNavHost.project();
      return {name:project.name, scope:AtriumHierarchy.scopeSetting(project), docs:project.documents.map(d => d.name)};
    });
    const initial = await state(page);
    const addSecond = second.getByRole("button", {name:"Add to " + secondName, exact:true});
    await addSecond.waitFor();

    // Work on the other open project without touching the window that opened it.
    await page.bringToFront();
    await addSecond.press("Enter");
    await second.getByRole("menuitem", {name:"Add New Schematic…", exact:true}).press("Enter");
    const sheet = second.getByRole("dialog", {name:"Add schematic sheet", exact:true});
    await sheet.getByRole("textbox").fill("Second project only");
    await sheet.getByRole("button", {name:"Add", exact:true}).click();
    await second.getByRole("treeitem", {name:"Second project only", exact:true}).waitFor();
    const moreSecond = second.getByRole("button", {name:"Project actions for " + secondName, exact:true});
    await moreSecond.click();
    const scope = second.getByRole("menuitem", {name:"Connections: Global", exact:true});
    await scope.click();
    const connections = second.getByRole("dialog", {name:"Cross-sheet connections", exact:true});
    await connections.getByLabel("Net identifier scope").selectOption("hierarchical");
    await connections.getByRole("button", {name:"Apply", exact:true}).click();
    assert.deepEqual(await state(page), initial);
    const edited = await state(second);
    assert.equal(edited.name, secondName);
    assert.equal(edited.scope, "hierarchical");
    assert.ok(edited.docs.includes("Second project only"));

    await addSecond.click();
    await second.getByRole("menuitem", {name:"Close Project", exact:true}).click();
    const confirm = second.getByRole("dialog", {name:"Close " + secondName + "?", exact:true});
    await confirm.getByRole("button", {name:"Discard", exact:true}).click();
    await second.locator("dialog.sp-dialog[open]").waitFor();
    assert.deepEqual(await state(page), initial);

    const addFirst = page.getByRole("button", {name:"Add to " + first, exact:true});
    await addFirst.click();
    // A native replacement can arrive while a menu is open. Invoking its old command must
    // leave the replacement project alone even though the title row and buttons are reused.
    await page.evaluate(async () => {
      const action = document.querySelector('.nav-menu:not([inert]) [data-menu-action="add-schematic"]');
      await AtriumNavHost.replaceProject(Atrium.project("Replacement fixture"), {force:true, copy:true, dirty:false});
      action.click();
    });
    await page.getByRole("button", {name:"Add to Replacement fixture", exact:true}).waitFor();
    assert.equal(await page.getByRole("dialog", {name:"Add schematic sheet", exact:true}).count(), 0);
  } finally {
    await page.context().close();
  }
  console.log("PASS project row commands in two open windows, including Add, Connections, Close, the empty starter and stale commands");
}

module.exports = async function workbenchTree(browser) {
  await editorChrome(browser);
  await touchProjects(browser);
  await projectMenus(browser);
  await projectMenuTargets(browser);
  const page = await browser.newPage({viewport: {width: 1400, height: 960}, reducedMotion:"reduce"}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
    const {childId, boardId, fallbackMs, cachedMs, samples} = await page.evaluate(async () => {
      const host = AtriumNavHost, H = AtriumHierarchy;
      await AtriumLazy.need(["AtriumUndoStore", "AtriumContextMenu", "AtriumProjectTree", "AtriumRules"]);
      const project = Atrium.project("Hierarchy fixture"), [root, board] = project.documents;
      const child = Atrium.sheet("schematic", "Amplifier"), spare = Atrium.sheet("schematic", "Analog spare");
      const drawing = Atrium.sheet("drawing", "Assembly drawing");
      project.documents = [drawing, board, child, root, spare];
      board.items.push({id: "track-nudge", kind: "track", points: [[0, 0], [5, 0]], width: .25, layer: "Top", net: "SIGNAL"});
      const symbol = (sheet, name, x) => AtriumSchObjects.make("sheetsymbol", [x, 0], {sheet: sheet.id, name});
      const link = symbol(child, "Repeat(CH,1,3)", 0), other = symbol(spare, "Spare module", 30);
      root.items.push(link, other);
      AtriumProjectRules.setNetScope(project, "hierarchical");
      await host.replaceProject(project, {force: true, copy: true, dirty: false});
      AtriumUndoStore.sync(project);
      host.moduleLoaded();

      const explorer = document.getElementById("documents"), tabs = document.getElementById("document-tabs");
      const row = id => explorer.querySelector(`[data-doc="${id}"]`);
      const tab = id => tabs.querySelector(`[data-tab="${id}"]`);
      const get = selector => document.querySelector(selector);
      const check = (condition, text) => { if (!condition) throw Error(text); };
      const tree = H.instancesCached, syncExplorer = AtriumWorkbench.syncExplorer;
      const iconName = (doc, isTab) => "#i-" + (doc.kind === "pcb" ? "board" : doc.kind === "drawing" && !isTab ? "drawing" : "schematic");
      const tooltip = b => b.getAttribute("title") || b.getAttribute("data-tooltip-label") || b.getAttribute("data-tooltip");
      const present = b => [b.dataset.doc, b.dataset.kind, b.querySelector(".tree-label").textContent, b.getAttribute("aria-current"),
        b.querySelector(".tree-icon use").getAttribute("href"), b.classList.contains("doc-child"), b.dataset.depth ?? null,
        b.getAttribute("aria-level"), tooltip(b), b.querySelector(".doc-channels")?.textContent ?? null];

      // The original fresh rendering order puts the depth-first sheets before the first board,
      // or after the other documents when the project contains no board.
      function freshRows(p, active) {
        const container = document.createElement("div"), rows = [], first = new Set();
        const append = (doc, depth = 0, title = "", channels = 0) => {
          const b = document.createElement("button"), label = document.createElement("span");
          b.dataset.doc = doc.id; b.dataset.kind = doc.kind; b.dataset.depth = String(depth);
          b.setAttribute("aria-level", String(depth + 1));
          b.setAttribute("aria-current", String(doc.id === active && !first.has(doc.id))); first.add(doc.id);
          const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg"), use = document.createElementNS(svg.namespaceURI, "use");
          svg.classList.add("tree-icon"); label.className = "tree-label";
          use.setAttribute("href", iconName(doc, false)); svg.append(use);
          label.textContent = doc.name; b.append(svg, label);
          b.classList.toggle("doc-child", depth > 0);
          if (title) b.title = doc.name + " · " + title;
          if (channels) {const badge = document.createElement("small"); badge.className = "doc-channels"; badge.textContent = "×" + channels; b.append(badge);}
          container.append(b);
        };
        function branch(instance) {
          append(instance.doc, instance.depth, instance.symbol?.name);
          const groups = new Map();
          for (const c of instance.children) {
            if (!groups.has(c.doc)) groups.set(c.doc, []);
            groups.get(c.doc).push(c);
          }
          for (const group of groups.values()) {
            const c = group[0];
            if (group.length > 1) append(c.doc, c.depth, c.symbol.name, group.length);
            else branch(c);
          }
        }
        const roots = H.instances(p).roots, other = p.documents.filter(d => d.kind !== "schematic");
        const index = other.findIndex(d => d.kind === "pcb");
        rows.push(...other); rows.splice(index < 0 ? rows.length : index, 0, ...roots);
        for (const item of rows) {if (item.doc) branch(item); else append(item);}
        return container;
      }
      function verify(label) {
        const p = host.project(), id = host.currentId();
        const expected = [...freshRows(p, id).children].map(present);
        check(JSON.stringify([...explorer.querySelectorAll(".doc-row[role=treeitem]")].map(present)) === JSON.stringify(expected), label + " explorer differs from a fresh render");
        const tabView = [...tabs.children].map(b => [b.dataset.tab, b.dataset.kind, b.querySelector("span").textContent,
          tooltip(b), b.getAttribute("aria-selected"), b.tabIndex, b.querySelector("use").getAttribute("href"), b.draggable]);
        const expectedTabs = p.documents.map(d => [d.id, d.kind, d.name, d.sourceName || d.name,
          String(d.id === id), d.id === id ? 0 : -1, iconName(d, true), true]);
        check(JSON.stringify(tabView) === JSON.stringify(expectedTabs), label + " tabs differ from current documents");
        check(get("#current-document-tab") === tab(id) && get("#doc-name").textContent === host.doc().name, label + " active tab label");
        check(get("#project-name").textContent === p.name, label + " project label");
      }
      verify("initial");
      const rect = node => node.getBoundingClientRect();
      const textStart = node => {
        const range = document.createRange();
        range.selectNodeContents(node.querySelector(".tree-label"));
        return range.getBoundingClientRect().left;
      };
      const rootRow = get(".project-tree > summary"), folderRow = get(".tree-folder > summary");
      check(textStart(folderRow) - textStart(rootRow) === 14, "folder labels indent 14px from the project");
      for (const r of [rootRow, folderRow, ...explorer.querySelectorAll(".doc-row")]) {
        const depth = r === rootRow ? 0 : r === folderRow ? 1 : Number(r.dataset.depth) + 2;
        check(textStart(r) - textStart(rootRow) === 14 * depth, "mixed labels align on the same rendered text start at each depth");
        check(rect(r).height === 24 && rect(r.querySelector(".tree-icon")).width === 16, "project rows and their icons use the fixed chrome sizes");
        const chevron = r.querySelector(".tree-chevron");
        if (chevron) check(rect(chevron).width === 12 && rect(chevron).height === 12, "disclosure glyphs are 12px");
      }
      const active = explorer.querySelector("[aria-current=true]"), selected = getComputedStyle(active);
      check(rect(active).left - rect(explorer).left === 6 && rect(explorer).right - rect(active).right === 6 &&
        selected.borderStartStartRadius === "6px", "the active document fill has a 6px inset and radius");
      const header = get(".panel-projects > .pane-heading"), heading = getComputedStyle(header.querySelector("h2"));
      check(rect(header).height === 32 && heading.fontSize === "12px" && heading.fontWeight === "600", "the Projects header is 32px with a 12px semibold title");
      check(get("#unsaved").hidden, "the opened project is clean");

      let treeReads = 0, cachedMs = 0;
      H.instancesCached = p => { treeReads++; return tree(p); };
      AtriumWorkbench.syncExplorer = (...args) => {
        const start = performance.now();
        syncExplorer(...args);
        cachedMs += performance.now() - start;
      };
      const liveRow = row(child.id), liveTab = tab(board.id), liveLabel = get("#doc-name").firstChild;
      const badge = document.createElement("span");
      badge.className = "collab-badges";
      liveRow.append(badge);
      host.select(["track-nudge"]);
      liveRow.focus();
      check(document.activeElement === liveRow, "test explorer row can receive focus");
      const watch = new MutationObserver(() => {});
      for (const area of [explorer, tabs, get("#project-name")]) watch.observe(area, {childList: true, attributes: true, subtree: true});
      const startX = board.items[0].points[0][0];
      const samples = 20;
      for (let i = 0; i < samples; i++) {
        host.executeKey("nudge", [1, 0]);
        check(board.items[0].points[0][0] === startX + board.grid, "nudge moves the board track");
        check(!get("#unsaved").hidden, "the nudge reveals the unsaved marker");
        host.act("undo");
        check(board.items[0].points[0][0] === startX, "undo restores the track");
      }
      check(treeReads === 0, "nudge and undo never read or rebuild the hierarchy");
      check(watch.takeRecords().length === 0, "nudge and undo leave the explorer and tabs alone");
      watch.disconnect();
      check(document.activeElement === liveRow && row(child.id) === liveRow && liveRow.contains(badge), "nudge and undo retain the focused tree row and collaboration badge");
      check(tab(board.id) === liveTab && get("#doc-name").firstChild === liveLabel, "nudge and undo retain the live tab and its label node");
      const incrementalMs = cachedMs;

      const start = performance.now();
      for (let i = 0; i < 2 * samples; i++) freshRows(project, board.id);
      const fallbackMs = performance.now() - start;

      // A symbol move is immaterial. Real changes to the order, name, target and repeat count
      // go through both the committed and pending paths.
      host.edit(() => { link.x += 1; });
      check(treeReads === 0, "moving a sheet symbol leaves its tree row alone");
      host.edit(() => { root.items.reverse(); link.name = "Channels"; link.repeat = {from: 2, to: 5}; });
      verify("repeat metadata and symbol order");
      check(row(child.id) === liveRow && document.activeElement === liveRow && liveRow.contains(badge), "reordering a tree row keeps its focus and badges");
      host.act("undo");
      verify("undo repeat metadata");
      host.act("redo");
      verify("redo repeat metadata");
      host.edit(() => { link.sheet = spare.id; });
      verify("sheet link moves to another document");

      const folder = get(".tree-folder"), branch = get(".project-tree");
      branch.open = folder.open = false;
      AtriumPower.host({occluded: true});
      host.edit(() => { link.sheet = other.sheet = ""; });
      verify("pending unlink with the explorer collapsed and window occluded");
      host.edit(() => {
        child.name = "Output stage";
        child.sourceName = "Output.stage.SchDoc";
        project.name = "Renamed fixture";
      });
      check(!branch.open && !folder.open, "pending hidden edit preserves collapsed disclosures");
      verify("pending rename with the explorer collapsed and window occluded");
      AtriumPower.host({occluded: false});
      branch.open = folder.open = true;
      verify("explorer reopened");
      row(child.id).click();
      check(document.activeElement === liveRow && host.doc() === child, "row activation changes the document and focuses it");
      verify("switch to schematic");
      liveTab.click();
      verify("switch to PCB tab");

      const added = Atrium.sheet("schematic", "Controls");
      host.edit(() => { project.documents.unshift(added); });
      verify("add document");
      host.edit(() => { project.documents.push(project.documents.shift()); });
      verify("reorder documents");
      host.edit(() => { project.documents.pop(); });
      verify("remove document");
      host.act("undo");
      verify("undo document removal");
      host.act("redo");
      verify("redo document removal");

      const replacement = structuredClone(project);
      replacement.documents.find(d => d.id === root.id).items[0].sheet = child.id;
      await host.replaceProject(replacement, {force: true, copy: true, dirty: false});
      verify("replace project with matching IDs");
      check(get("#unsaved").hidden, "a clean replacement clears the unsaved marker");
      check(row(child.id) === liveRow && tab(board.id) === liveTab, "replacement reuses rows with matching IDs");
      const current = host.project(), activeDocument = host.doc();
      const reference = {id:"unloaded-document",kind:"drawing",name:"Pending drawing",sourceName:"Assembly.Dwg",missing:true};
      const refs = [...current.documents, reference];
      function syncReferences(documents) {
        AtriumWorkbench.sync(documents, activeDocument.id, id => host.selectDocument(id), activeDocument.grid, "mm");
        AtriumWorkbench.syncExplorer(current, activeDocument.id, id => host.selectDocument(id), host.revision(), {documents});
      }
      syncReferences(refs);
      const refRow = row(reference.id), refTab = tab(reference.id);
      check(refRow.dataset.missing === "true" && refRow.dataset.tooltip === "Document unavailable", "unloaded folder reference carries missing state");
      check(refTab.title === reference.sourceName && !("items" in reference), "tab title comes from the ref without loading its body");
      refRow.focus();
      watch.observe(explorer, {childList:true,subtree:true,attributes:true});
      watch.observe(tabs, {childList:true,subtree:true,attributes:true});
      syncReferences(refs.map(doc => ({...doc})));
      check(watch.takeRecords().length === 0, "equivalent ref wrappers leave the tab and tree untouched");
      watch.disconnect();
      Object.assign(reference, {kind:"pcb",name:"Recovered layout",sourceName:"Recovered.PcbDoc",missing:false});
      refs.unshift(refs.pop());
      syncReferences(refs);
      check(row(reference.id) === refRow && tab(reference.id) === refTab && document.activeElement === refRow,
        "in-place ref edits and reordered tabs keep their live nodes and keyboard focus");
      check(refRow.dataset.missing === undefined && refRow.dataset.kind === reference.kind && refRow.textContent === reference.name,
        "updated ref clears missing state and updates tree metadata");
      check(refTab.title === reference.sourceName && refTab.dataset.kind === reference.kind && tabs.firstElementChild === refTab,
        "updated ref updates tab metadata in the supplied order");
      host.moduleLoaded();
      check(!row(reference.id) && !tab(reference.id), "sync restores the loaded project's references");
      H.instancesCached = tree;
      AtriumWorkbench.syncExplorer = syncExplorer;
      return {childId: child.id, boardId: board.id, fallbackMs, cachedMs: incrementalMs, samples};
    });

    const row = page.locator(`[data-doc="${childId}"]`), tab = page.locator(`[data-tab="${boardId}"]`);
    const menu = page.locator(".nav-menu[role=menu]:not([inert])");
    await row.focus();
    await page.keyboard.press("Shift+F10");
    assert.equal(await menu.getAttribute("aria-label"), "Output stage");
    await page.evaluate(() => AtriumNavHost.edit(() => { AtriumNavHost.doc().items[0].width = .4; }));
    await page.keyboard.press("Escape");
    assert.equal(await row.evaluate(node => node === document.activeElement), true, "an open keyboard context menu returns focus to the live edited explorer");
    await tab.click({button: "right"});
    assert.equal(await menu.getAttribute("aria-label"), "Board layout");
    assert.deepEqual(errors, []);
    console.log(`PASS explorer and tabs: unchanged rows, focus, menu, hierarchy, undo/redo and hidden edits. ` +
      `${2 * samples} nudge/undo operations with zero hierarchy traversals or DOM writes. ` +
      `Explorer sync ${cachedMs.toFixed(2)} ms, fresh detached renders ${fallbackMs.toFixed(2)} ms.`);
  } finally {
    await page.close();
  }
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => ({channel: "chrome"}),
    browser => (process.argv.includes("--chrome-only") ? editorChrome : process.argv.includes("--menus-only") ? projectMenus : module.exports)(browser),
    error => { console.error(error); process.exitCode = 1; });
}
