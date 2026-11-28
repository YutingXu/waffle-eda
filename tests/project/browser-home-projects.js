"use strict";

// Home, Get set up and the Projects panel in a real browser (preview feedback, 20 November 2026):
//  1. Right-click anywhere opens the app's menu or none; the browser's own menu (Reload, Back…) is
//     left only to text fields. The Projects panel, the empty left pane and the tabs open project and
//     document menus as Altium's Projects panel does.
//  2. Close Project asks about unsaved edits (Cancel keeps them), then returns to Home and an empty
//     workspace. Add Existing to Project adds a document beside the open ones, once.
//  3. An Altium .PrjPcb chosen alone asks for its folder and opens every document it lists.
//  4. Welcome and Get set up: first-run choices apply a preset. The returning Home filters
//     genuine recents, and the advanced steps retain their keyboard and touch behavior.
// Fixture: tests/fixtures/altium/pidp11-io-expander (see its NOTICE). Run from integration-browser.cjs.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const ALTIUM = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
const INDEX = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;

async function checkWelcomeGeometry(home) {
  const measure = await home.evaluate(async dialog => {
    // Visibility starts before the opening transform returns to its resting geometry.
    await new Promise(resolve => requestAnimationFrame(resolve));
    await Promise.allSettled(dialog.getAnimations().map(animation => animation.finished));
    const node = selector => dialog.querySelector(selector);
    const rect = selector => node(selector).getBoundingClientRect();
    const inGrid = (grid, child) => [...node(grid).querySelectorAll(child)];
    const widths = nodes => nodes.map(el => el.getBoundingClientRect().width);
    const middle = b => b.top + b.height / 2;
    const head = rect(".sp-right-head"), title = rect(".sp-page-title"), close = rect(".sp-skip");
    const coming = rect(".sp-coming"), templates = rect(".sp-template-section"), learn = rect(".sp-docs");
    return {
      shell:dialog.getBoundingClientRect().width, content:head.width,
      origins:widths(inGrid(".sp-origins", ".sp-origin")), cards:widths(inGrid(".sp-templates", ".sp-card")),
      titleY:inGrid(".sp-origins", "strong").map(el => el.getBoundingClientRect().top),
      subtitles:inGrid(".sp-origins", "span").map(el => [el.textContent,el.getBoundingClientRect().height]),
      itemWeights:[getComputedStyle(node(".sp-origin strong")).fontWeight,getComputedStyle(node(".sp-card strong")).fontWeight],
      headingWeights:[getComputedStyle(node(".sp-coming h2")).fontWeight,getComputedStyle(node(".sp-template-head h2")).fontWeight],
      close:[close.width,close.height,close.right-head.right,middle(close)-middle(title)],
      gap:[coming.top-head.bottom,templates.top-coming.bottom,learn.top-templates.bottom],
      leftBottom:getComputedStyle(node(".sp-left")).paddingBottom
    };
  });
  assert.equal(measure.shell,1048);
  assert.equal(measure.content,702);
  assert.deepEqual(measure.origins,Array(5).fill(134));
  assert.deepEqual(measure.cards,Array(6).fill(226));
  assert.equal(new Set(measure.titleY).size,1,"every origin title starts on the same baseline");
  assert.deepEqual(measure.subtitles,[["Altium keys",15],["KiCad keys",15],["Function keys",15],["One-letter tools",15],["Waffle defaults",15]]);
  assert.deepEqual(measure.itemWeights,["500","500"]);
  assert.deepEqual(measure.headingWeights,["600","600"]);
  assert.deepEqual(measure.close,[28,24,0,0],"Close uses the shared icon box and aligns with the title and content edge");
  assert.deepEqual(measure.gap,[24,24,24]);
  assert.equal(measure.leftBottom,"24px");
}

async function checkFreshSystemAppearance(browser) {
  const context = await browser.newContext({viewport:{width:1440,height:900},colorScheme:"light",reducedMotion:"reduce"});
  try {
    const page = await context.newPage();
    await page.goto(INDEX);
    const home = page.locator("dialog.sp-dialog[open]");
    await home.getByRole("heading",{name:"Welcome to Waffle",exact:true}).waitFor();
    assert.deepEqual(await page.evaluate(() => [AtriumTheme.get().followSystem,document.documentElement.dataset.theme]),[true,"light"]);
    assert.ok(await home.evaluate(d => d === document.activeElement),"native modal opened with focus on Welcome");
    await page.emulateMedia({colorScheme:"dark"});
    await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
    await page.keyboard.press("Enter");
    const create = page.getByRole("dialog",{name:"New project",exact:true});
    const field = create.getByRole("textbox",{name:"New project",exact:true});
    await field.waitFor();
    assert.ok(await field.evaluate(input => input === document.activeElement),"Enter opens and focuses the actual New Project field");
    await field.fill("Welcome keyboard test");
    await field.press("Enter");
    await page.waitForFunction(() => AtriumNavHost.project().name === "Welcome keyboard test");
  } finally { await context.close(); }
}

module.exports = async function homeProjects(browser) {
  await checkFreshSystemAppearance(browser);
  const context = await browser.newContext({viewport:{width:1440,height:900},colorScheme:"dark"});
  const page = await context.newPage(), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const menu = () => page.locator(".nav-menu-portal > .nav-menu[role=menu]").last();
  const entries = async () => (await menu().locator(".nav-menu-item").allInnerTexts()).map(t => t.split("\n")[0].trim());
  try {
    await page.clock.install();
    await page.goto(INDEX);
    const home = page.locator("dialog.sp-dialog[open]");
    const openHome=async()=>{
      const help=page.locator('.work-menu[data-menu="help"]');
      await help.locator("summary").click();
      await help.locator('[data-action="start-page"]').click();
    };
    const welcome = home.getByRole("heading",{name:"Welcome to Waffle",exact:true});
    await welcome.waitFor();
    assert.deepEqual(await page.evaluate(() => [AtriumTheme.get().followSystem,document.documentElement.dataset.theme]),[true,"dark"]);
    await checkWelcomeGeometry(home);
    const newProject = home.getByRole("button",{name:"New Project…",exact:true});
    assert.ok(await home.evaluate(d => d === document.activeElement && getComputedStyle(d).outlineStyle === "none"));
    assert.equal(await newProject.evaluate(b => b.matches(":focus-visible")),false);
    await page.keyboard.press("Tab");
    assert.ok(await newProject.evaluate(b => b === document.activeElement && b.matches(":focus-visible") &&
      getComputedStyle(b).outlineStyle !== "none"),"first Tab reveals the New Project focus ring");
    const origins = home.getByRole("radiogroup",{name:"Coming from",exact:true});
    assert.equal(await origins.getByRole("radio").count(),5,"five first-run origins are exposed");
    const altium = origins.getByRole("radio",{name:/^Altium/}), kicad = origins.getByRole("radio",{name:/^KiCad/});
    await altium.focus();
    await altium.press("ArrowRight");
    await page.waitForFunction(()=>AtriumKeymap.preset()==="kicad" && globalThis.AtriumWelcome?.value("from","wheel")==="zoom");
    assert.equal(await kicad.isChecked(),true);
    assert.ok(await welcome.isVisible(),"an origin updates preferences without leaving Welcome");
    await home.locator(".sp-card:visible").nth(5).waitFor();
    assert.equal(await home.locator(".sp-card:visible").count(),6,"six real template actions are featured on first run");
    await home.getByRole("button",{name:"All templates…",exact:true}).click();
    assert.ok(await home.locator(".sp-card:visible").count()>6,"All templates opens the registered template collection");
    await home.getByRole("button",{name:"Featured templates",exact:true}).click();
    assert.equal(await home.locator(".sp-card:visible").count(),6);
    await home.getByRole("button",{name:"Getting started",exact:true}).click();
    const guide = page.getByRole("dialog",{name:"Getting started",exact:true});
    await guide.getByRole("heading",{name:"Welcome and recent projects",exact:true}).waitFor();
    const paletteKeys = await page.evaluate(() => AtriumKeymap.displayKeys("Mod+Shift+P", true)[0].join("+"));
    assert.ok((await guide.locator('kbd.ui-shortcut[data-variant="inline"] .shortcut-spoken').allTextContents()).includes(paletteKeys),
      "the local guide renders the palette keys through the shared platform shortcut control");
    await page.keyboard.press("Escape");
    await guide.waitFor({state:"hidden"});
    await welcome.waitFor();

    // ---- 4. Get set up
    await home.locator('[data-start-action="customise"]').click();
    await home.locator(".wl-panel .wl-step").first().waitFor();
    const from = home.locator('.wl-step[data-step="from"] .wl-head');
    if (await from.getAttribute("aria-expanded") !== "true") await from.click();
    await page.click('.wl-step[data-step="from"] label.wl-option:has(input[value="altium"])');
    await page.waitForFunction(() => AtriumWelcome.state().open === "theme");
    assert.ok(await page.evaluate(() => AtriumWelcome.state().done.from), "Coming from is done");
    await page.click('.wl-step[data-step="theme"] label.wl-option:has(input[value="light"])');
    await page.clock.runFor(700);
    assert.equal(await page.evaluate(() => AtriumWelcome.state().open), "theme", "theme choices stay open to compare");
    await page.click('.wl-step[data-step="units"] .wl-head');
    await page.focus('.wl-step[data-step="units"] input[value="mm"]');
    await page.keyboard.press("ArrowDown");
    await page.clock.runFor(700);
    assert.deepEqual(await page.evaluate(() => [AtriumWelcome.state().open, AtriumPrefs.get("general.units")]), ["units", "mil"], "arrow keys choose without moving on");
    await page.click('.wl-step[data-step="units"] label.wl-option:has(input[value="mm"])');
    await page.waitForFunction(() => AtriumWelcome.state().open === "mouse");
    const inView = await page.evaluate(() => {
      const h = document.querySelector('.wl-step[data-step="mouse"] .wl-head').getBoundingClientRect(), c = document.querySelector(".sp-right").getBoundingClientRect();
      return h.top >= c.top - 1 && h.bottom <= c.bottom + 1;
    });
    assert.ok(inView, "the next step scrolls into view");
    await page.click('.wl-step[data-step="mouse"] label.wl-option:has(input[value="zoom"])');
    await page.waitForFunction(() => AtriumWelcome.state().open === "motion");
    assert.ok(await page.evaluate(() => AtriumWelcome.state().done.mouse), "the wheel choice alone completes Mouse and navigation");
    for (const level of ["full", "reduce", "off"]) {
      await page.click(`.wl-step[data-step="motion"] label.wl-option:has(input[value="${level}"])`);
      const shown = await page.evaluate(() => ({level: document.querySelector(".wl-motion-stage").dataset.level,
        list: [...document.querySelectorAll(".wl-motion-list li")].map(li => li.textContent), theme: AtriumTheme.effectivePreset()}));
      assert.equal(shown.level, level);
      assert.ok(shown.list.length >= 3 && shown.theme === "light", "Animations lists what moves at " + level + " and keeps the theme");
    }
    assert.equal(await page.evaluate(() => AtriumWelcome.state().open), "motion", "Animations stays open to compare");
    await page.getByRole("button", {name: "Finish setup"}).click();
    assert.ok(await page.evaluate(() => AtriumNavHost.isStarter() && AtriumStartPage.isOpen()), "Finish setup stays on Home with an empty workspace");
    await home.locator('[data-start-action="close"]').click();
    await home.waitFor({state:"hidden"});
    const fileMenu = page.locator('.work-menu[data-menu="file"]');
    const fileMenuButton = fileMenu.locator(':scope > summary');
    const fileClose = fileMenu.getByRole("menuitem", {name:"Close Project", exact:true});
    await fileMenuButton.press("Enter");
    await fileClose.waitFor();
    assert.ok(await fileClose.isDisabled(), "File cannot close the empty starter workspace");
    await page.keyboard.press("Escape");
    await openHome();

    // ---- 1. Context menus: right-click on Home and on every editor surface.
    await page.evaluate(() => { window.__menus = []; addEventListener("contextmenu", e => window.__menus.push(e.defaultPrevented)); });
    const rightClick = async (selector, where) => {
      const target = typeof selector==="string" ? page.locator(selector).first() : selector;
      const box = await target.boundingBox();
      assert.ok(box, target + " is shown");
      await page.evaluate(() => { window.__menus.length = 0; });
      const [x, y] = where ? where(box) : [box.x + Math.min(box.width / 2, 12), box.y + box.height / 2];
      await page.mouse.click(x, y, {button: "right"});
      return page.evaluate(() => window.__menus.slice());
    };
    const returning=home.getByRole("heading",{name:"Recent projects",exact:true});
    await returning.waitFor();
    assert.deepEqual(await rightClick(returning), [true], "Home: no browser menu");
    const filter=home.getByRole("searchbox",{name:"Filter recent projects",exact:true});
    const filterIcon = await home.locator(".sp-filter .icon").boundingBox();
    assert.ok(filterIcon, "the recent project filter has a visible search icon");
    await page.mouse.click(filterIcon.x + filterIcon.width / 2, filterIcon.y + filterIcon.height / 2);
    assert.ok(await filter.evaluate(input=>document.activeElement===input),"clicking the search icon focuses the recent project filter");
    assert.deepEqual(await rightClick(filter), [true], "Home text fields use the application editing menu");
    const editing = page.getByRole("menu", {name:"Text", exact:true});
    await editing.getByRole("menuitem", {name:"Select All"}).waitFor();
    await page.keyboard.press("Escape");
    await editing.waitFor({state:"hidden"});
    const openShortcut=await page.evaluate(()=>AtriumKeymap.mac?"Meta+o":"Control+o");
    const [chooser]=await Promise.all([page.waitForEvent("filechooser"),filter.press(openShortcut)]);
    await chooser.setFiles([]);
    // A cancelled chooser leaves Home exactly as it was (browser-welcome-open.js covers Import too).
    assert.equal(await page.evaluate(()=>AtriumStartPage.isOpen()),true,"cancelling Open from Home keeps Home");
    await page.getByRole("button", {name: "Try the Demo", exact: true}).click();
    await page.waitForFunction(() => AtriumNavHost.project().name === "Sensor interface" && !AtriumStartPage.isOpen());
    await page.evaluate(async()=>{
      const host=AtriumNavHost;
      host.edit(()=>{host.doc().name += " QA";});
      await AtriumAutosave.flush();
      await host.replaceProject(AtriumParts.example(),{copy:true,force:true,dirty:false});
    });
    await openHome();
    await home.getByRole("heading",{name:"Recent projects",exact:true}).waitFor();
    const recent=home.locator(".sp-recent-item").filter({hasText:"Sensor interface"});
    await recent.waitFor();
    assert.equal(await home.locator(".sp-card:visible").count(),4,"returning Home keeps four featured templates");
    await filter.fill("there is no such saved project");
    await recent.waitFor({state:"hidden"});
    await filter.fill("sensor interface");
    await recent.waitFor();
    await home.locator('[data-start-action="close"]').click();
    await home.waitFor({state:"hidden"});
    await fileMenuButton.press("Enter");
    await fileClose.waitFor();
    assert.ok(await fileClose.isEnabled(), "opening a real project enables File Close Project");
    await page.keyboard.press("Escape");
    for (const selector of [".appbar .brand", ".quick-access .command-link", "#status", "#inspector", "#tools", ".editor-tabbar"]) {
      assert.deepEqual(await rightClick(selector), [true], selector + ": no browser menu");
      await page.keyboard.press("Escape");
    }
    for (const [selector, where, want] of [
      [".project-tree > summary", null, ["Validate Project", "Add New to Project", "Add Existing to Project…", "Save Project", "Save Project As…", "Close Project", "Open Project…", "Project Options…"]],
      ["#navigator", box => [box.x + box.width / 2, box.y + box.height - 20], ["Add Existing to Project…", "Close Project"]],
      ["#documents [data-doc]", null, ["Open Document", "Rename Document…", "Save Project"]],
      ["#document-tabs [data-tab]", null, ["Open Document", "Rename Document…"]]]) {
      assert.deepEqual(await rightClick(selector, where), [true], selector + ": the app's menu, not the browser's");
      await menu().waitFor();
      const got = await entries();
      for (const w of want) assert.ok(got.includes(w), selector + " menu has " + w + ": " + got.join(", "));
      await page.keyboard.press("Escape");
      await menu().waitFor({state: "detached"});
    }

    // ---- 2. Add Existing to Project, then Close Project.
    assert.deepEqual(await page.evaluate(async () => {
      const H = AtriumNavHost, original = H.project();
      const next = Atrium.project("Undo Open control", []);
      await H.replaceProject(next, {force:true, dirty:false});
      const opened = H.project() === next;
      H.historyGo(-1);
      return [opened, H.project() === original];
    }), [true, true], "ordinary project replacement stays undoable");

    const before = await page.evaluate(() => AtriumNavHost.project().documents.map(d => d.id));
    const addExisting = async () => {
      await rightClick(".project-tree > summary");
      const chooser = page.waitForEvent("filechooser");
      await menu().locator(".nav-menu-item", {hasText: "Add Existing to Project…"}).click();
      await (await chooser).setFiles(path.join(ALTIUM, "PiDP11IOExpander.SchDoc"));
    };
    await addExisting();
    await page.waitForFunction(n => AtriumNavHost.project().documents.length === n + 1, before.length, {timeout: 60000}).catch(async e => {
      throw Error(e.message + " " + JSON.stringify(await page.evaluate(() => ({status: document.getElementById("status")?.textContent,
        docs: AtriumNavHost.project().documents.map(d => d.name), dialogs: [...document.querySelectorAll("dialog[open]")].map(d => d.textContent.slice(0, 160))}))));
    });
    const added = await page.evaluate(() => ({name: AtriumNavHost.project().name, docs: AtriumNavHost.project().documents.map(d => d.id), dirty: AtriumNavHost.isDirty()}));
    assert.equal(added.name, "Sensor interface", "the open project stays");
    assert.ok(before.every(id => added.docs.includes(id)) && added.dirty, "the document joins the open project as an unsaved edit");
    await addExisting();
    await page.waitForFunction(() => /already in the project/.test(document.getElementById("status")?.textContent || "") || !!document.querySelector("dialog[open]"), null, {timeout: 60000});
    await page.evaluate(() => { for (const d of document.querySelectorAll("dialog[open]")) d.close(); });
    assert.equal(await page.evaluate(() => AtriumNavHost.project().documents.length), before.length + 1, "the same document is not added twice");

    await page.evaluate(() => {
      const H = AtriumNavHost;
      return H.selectDocument(H.project().documents.find(d => d.kind === "pcb").id);
    });
    await page.locator("#layer-tabs .layer-tab").first().waitFor({state:"attached"});
    const closeProject = async answer => {
      await rightClick(".project-tree > summary");
      await menu().locator(".nav-menu-item", {hasText: "Close Project"}).click();
      const ask = page.locator("dialog.close-project-dialog[open]");
      await ask.waitFor();
      assert.deepEqual(await ask.locator("button").allInnerTexts(), ["Cancel", "Don’t Save", "Save"]);
      await ask.getByRole("button", {name: answer, exact: true}).click();
    };
    const historySize = () => page.evaluate(() => {
      const {history, future} = AtriumNavHost.undoSteps();
      return [history.length, future.length, AtriumUndoStore.stats().branches];
    });
    const mirrorHistory = () => page.evaluate(() => {
      const old = globalThis.AtriumProjectWindowClient, commands = [];
      globalThis.AtriumProjectWindowClient = {isMirror:() => true, forward:kind => {
        commands.push(kind);
        return Promise.resolve(true);
      }};
      try {
        AtriumNavHost.historyGo(-1);
        AtriumNavHost.historyGo(1);
        return commands;
      } finally {
        globalThis.AtriumProjectWindowClient = old;
      }
    });
    const retained = await historySize();
    assert.ok(retained[0] > 0, "the loaded design has undo history");
    assert.deepEqual(await mirrorHistory(), ["undo", "redo"], "an open mirror still routes history commands to its primary editor");
    await closeProject("Cancel");
    assert.deepEqual(await page.evaluate(() => [AtriumNavHost.isStarter(), AtriumNavHost.isDirty(), AtriumNavHost.project().name]), [false, true, "Sensor interface"], "Cancel keeps the project");
    assert.deepEqual(await historySize(), retained, "Cancel keeps the workspace history");
    await closeProject("Don’t Save");
    await page.waitForFunction(() => AtriumNavHost.isStarter() && AtriumStartPage.isOpen());
    assert.ok(await page.evaluate(() => !AtriumNavHost.isDirty() && AtriumNavHost.project().documents.every(d => !d.items.length) && document.title === "Waffle"),
      "Don't Save returns to Home with an empty workspace");
    assert.deepEqual(await historySize(), [0, 0, 0], "Close Project retires undo, redo and alternate branches");
    assert.equal(await page.locator("#layer-tabs .layer-tab").count(), 0, "Close removes the old PCB tab handlers");
    assert.deepEqual(await page.evaluate(() => {
      const H = AtriumNavHost;
      H.historyGo(-1);
      return [H.isStarter(), H.project().documents.every(d => !d.items.length), AtriumUndoStore.stats().records];
    }), [true, true, 0], "Undo cannot resurrect the discarded project");
    assert.deepEqual(await mirrorHistory(), [], "a mirror at Home cannot forward Undo or Redo to its primary editor");
    await page.clock.runFor(2600);
    assert.equal(await page.evaluate(() => AtriumAutosave.stats().pending), false, "the empty window leaves no autosave behind");

    // ---- 3. An Altium .PrjPcb alone: the browser asks for its folder, then opens the listed documents.
    const pick = page.waitForEvent("filechooser");
    await page.getByRole("button", {name: "Import from Altium or KiCad…"}).click();
    await (await pick).setFiles(path.join(ALTIUM, "PCB-PiDP11IOExpander.PrjPcb"));
    const ask = page.locator("dialog[open]", {hasText: "Open Altium project"});
    await ask.waitFor();
    assert.match(await ask.textContent(), /Choose the folder containing PCB-PiDP11IOExpander\.PrjPcb/);
    const folder = page.waitForEvent("filechooser");
    await ask.getByRole("button", {name: "Choose folder…"}).click();
    await (await folder).setFiles(ALTIUM);
    await page.waitForFunction(() => AtriumNavHost.project().name === "PCB-PiDP11IOExpander", null, {timeout: 60000});
    const kinds = await page.evaluate(() => AtriumNavHost.project().documents.map(d => d.kind + ":" + (d.items.length > 0)));
    assert.deepEqual(kinds.sort(), ["pcb:true", "schematic:true"], "the listed SchDoc and PcbDoc open as one project");

    assert.deepEqual(errors, []);
  } finally { await context.close(); }

  const touch = await browser.newContext({viewport:{width:360,height:550},isMobile:true,hasTouch:true,reducedMotion:"reduce"});
  try {
    const mobile = await touch.newPage();
    mobile.setDefaultTimeout(8000);
    await mobile.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    const home = mobile.locator(".sp-dialog[open]");
    await home.getByRole("heading",{name:"Welcome to Waffle",exact:true}).waitFor();
    const importAction=home.locator('[data-start-action="import"]');
    await importAction.tap({trial:true});
    assert.ok(await importAction.evaluate(node=>{
      const {width,height}=node.getBoundingClientRect();
      return width>=44&&height>=44;
    }),"the stock Import action is reachable by touch");
    await home.locator('[data-start-action="customise"]').tap();
    await home.locator(".wl-panel").waitFor();
    const step = home.locator(".wl-step.wl-open");
    const actions = step.locator(".wl-step-foot");
    const first = await step.getAttribute("data-step");
    await actions.evaluate(footer => footer.scrollIntoView({block:"center",inline:"nearest"}));
    for (const name of ["Skip", "Next"]) {
      const button = actions.getByRole("button",{name,exact:true});
      assert.ok(await button.evaluate(node => {
        const rect = node.getBoundingClientRect(), view = visualViewport;
        return rect.width >= 44 && rect.height >= 44 && rect.left >= view.offsetLeft
          && rect.right <= view.offsetLeft + view.width && rect.top >= view.offsetTop
          && rect.bottom <= view.offsetTop + view.height;
      }), name + " fits the visible touch viewport");
      await button.tap({trial:true});
    }
    await actions.getByRole("button",{name:"Next",exact:true}).tap();
    const second = await step.getAttribute("data-step");
    assert.notEqual(second, first, "Next advances using a real touch event");
    await actions.getByRole("button",{name:"Skip",exact:true}).tap();
    assert.notEqual(await step.getAttribute("data-step"), second, "Skip advances using a real touch event");
    await home.getByRole("button",{name:"Finish setup",exact:true}).tap();
    await home.locator(".sp-card").first().waitFor();
    const close = home.getByRole("button",{name:"Continue to editor",exact:true});
    await close.scrollIntoViewIfNeeded();
    const box = await close.boundingBox();
    assert.deepEqual([box.width,box.height],[28,24]);
    await mobile.touchscreen.tap(box.x+box.width+5,box.y+box.height/2);
    await home.waitFor({state:"hidden"});
  } finally { await touch.close(); }
  console.log("PASS browser Home and Get set up, touch navigation, context menus, Projects actions and Altium .PrjPcb folders");
};
