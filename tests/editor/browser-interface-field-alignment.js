"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const geometry = require("../support/dialog-geometry.cjs");
const {windowPanel, showPanel} = require("../support/window-panels.cjs");
const {assertPanelCoverage, fieldCoverage} = require("../support/field-coverage.cjs");

const app = pathToFileURL(path.resolve(__dirname, "../../app/index.html")).href;
const profiles = [
  {theme:"light", width:1440, height:900},
  {theme:"dark", width:1280, height:800},
  {theme:"light", width:1280, height:800, touch:true},
];

async function changeDocument(page, kind, items = []) {
  await page.evaluate(({kind,items}) => {
    const host = AtriumNavHost, design = host.project().documents.find(d => d.kind === kind);
    if (!design) throw Error(`The demo has no ${kind}.`);
    host.selectDocument(design.id);
    const ids = items.map((match, index) => {
      const results = design.items.filter(item => typeof match === "string" ? item.kind === match :
        Object.entries(match).every(([key,value]) => item[key] === value));
      const item = results[items.slice(0,index).filter(previous => previous === match).length];
      if (!item) throw Error(`The ${kind} demo lacks a requested item: ${JSON.stringify(match)}.`);
      return item.id;
    });
    host.select(ids);
  }, {kind,items});
}

function openAction(page, action) {
  return page.evaluate(action => AtriumNavHost.act(action), action);
}

async function populateDrawings(page) {
  await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumDrawing","AtriumPanel"]);
    const host = AtriumNavHost, project = structuredClone(host.project());
    const board = project.documents.find(doc => doc.kind === "pcb");
    project.documents.push(AtriumDrawing.create(project,{board:board.id,preset:"fabrication"}),
      AtriumPanel.create(project,{board:board.id}));
    await host.replaceProject(project,{force:true,dirty:false});
  });
}

async function panelCell(page) {
  await changeDocument(page,"panel");
  await page.waitForFunction(() => {
    const host = AtriumNavHost;
    return host.doc().kind === "panel" && host.canvas().getBoundingClientRect().width > 0 &&
      globalThis.AtriumPanelUI?.state.G?.instances?.length > 0;
  });
  const point = await page.evaluate(() => {
    const host = AtriumNavHost, canvas = host.canvas(), view = host.view();
    const box = AtriumPanelUI.state.G.instances[0].box, rect = canvas.getBoundingClientRect();
    const [x,y] = view.worldToScreen([(box[0]+box[2])/2,(box[1]+box[3])/2]);
    return [x+rect.left,y+rect.top];
  });
  // Preview's basic touch canvas pans. Pick the cell with the regular pointer handler
  // on coarse contexts too, while measuring the touch layout of its real Properties.
  await page.mouse.click(...point);
}

async function surfaces(page, sample, profile) {
  const click = control => profile.touch ? control.tap() : control.click();
  const welcome = page.locator("dialog.sp-dialog[open]");
  await click(welcome.getByRole("button",{name:"All templates…",exact:true}));
  await sample("Welcome · template project name",welcome.locator(".sp-template-section"),["Project name"]);
  await click(welcome.locator("[data-start-action=demo]"));
  await page.waitForFunction(() => !!globalThis.AtriumNavHost && AtriumNavHost.doc().kind === "pcb");
  await page.evaluate(() => AtriumLazy.need("AtriumPartInspector"));

  const inspector = page.locator("#inspector");
  await inspector.getByRole("combobox",{name:"Component class filter"}).waitFor();
  await sample("PCB · document Properties",inspector,["Component class filter"],"properties");
  await changeDocument(page,"pcb",["part"]);
  // Side is a segmented control (no text field); Height keeps its name "3D height (mm)".
  await inspector.getByRole("group",{name:"Side",exact:true}).waitFor();
  await sample("PCB · placed component",inspector,["Designator",/^Rotation/,/^3D height/]);
  await changeDocument(page,"pcb",["track"]);
  await sample("PCB · copper track",inspector,[/^Width/,"Layer","Net",/^Solder mask expansion/]);
  await changeDocument(page,"pcb",["track","track"]);
  await sample("PCB · multiple copper tracks",inspector,[/^Width/,"Layer"]);
  await changeDocument(page,"pcb");
  await click(page.locator("#tools [data-action=route]"));
  await inspector.getByLabel("Copper layer").waitFor();
  await sample("PCB · routing tool options",inspector,["Copper layer",/^Width/]);
  await page.keyboard.press("Escape");
  await click(page.locator(".statusbar .status-snap[data-scope=pcb]"));
  const snap = page.locator(".pcb-edit-snap-pop");
  await sample("PCB · Snap options popover",snap,["Snap distance in pixels"]);
  await page.keyboard.press("Escape");
  await snap.waitFor({state:"hidden"});

  await openAction(page,"view-config");
  const view = page.getByRole("dialog",{name:"View Configuration",exact:true});
  await click(view.getByRole("tab",{name:"View Options"}));
  await sample("PCB · View Configuration",view,["Tracks","Pads","Vias","Polygons"]);
  await click(view.getByRole("button",{name:"Close View Configuration"}));
  await view.waitFor({state:"hidden"});

  const appbar = page.locator(".appbar");
  await sample("Workbench · menu bar",appbar,[]);
  await sample("Dock · Projects",page.locator(".panel-projects:visible"),[],"projects");
  await showPanel(page,"components",{touch:profile.touch});
  await sample("Dock · Components",page.locator(".panel-components:visible"),[],"components");
  await showPanel(page,"properties",{touch:profile.touch});
  const editMenu = appbar.locator('details[data-menu="edit"]');
  await click(editMenu.locator("summary"));
  const commands = editMenu.locator(":scope > .menu-items");
  await commands.getByRole("menuitem",{name:/Undo/}).waitFor();
  await sample("Workbench · open Edit menu",commands,[]);
  await page.keyboard.press("Escape");
  await sample("Workbench · PCB Active Bar and layers",page.locator("#editor-area"),[]);

  const library = page.locator(".panel-library:visible");
  await windowPanel(page,"library",{touch:profile.touch});
  await library.getByRole("searchbox").waitFor();
  await sample("Dock · Library search and source",library,[
    {control:"Search the library",mode:"standalone"},{control:"Library source",mode:"standalone"},
  ],"library");
  for (const [editor, trigger, fields] of [
    ["Symbol Editor","New symbol…",["Name","Prefix"]],
    ["Footprint Editor","New footprint…",["Name",{control:"Drawing layer",mode:"stacked"},{control:"Body height",mode:"compound"}]],
  ]) {
    // New symbol… and New footprint… are in the Library's "Library commands" menu.
    await click(library.getByRole("button",{name:"Library commands",exact:true}));
    // New symbol… also names its shortcut, so match the start of the item's name.
    await click(page.getByRole("menuitem",{name:new RegExp("^" + trigger)}));
    const window = page.getByRole("dialog",{name:editor,exact:false});
    await sample(editor + " · Properties and toolbar",window,fields);
    await page.keyboard.press("Escape");
    await window.waitFor({state:"hidden"});
  }
  // A closable dock tab takes over its panel header's Close (dock.css), so close through whichever shows:
  // the dock tab's or the heading's.
  await click(page.locator('button:is([aria-label="Close Library"],[aria-label="Close the Library panel"]):visible').first());
  await library.waitFor({state:"hidden"});

  await windowPanel(page,"nets",{touch:profile.touch});
  const nets = page.locator(".panel-nets:visible");
  await sample("Dock · Nets",nets,[{control:/Filter|Search/,mode:"standalone"}],"nets");
  // A docked panel whose heading holds only its title hides that heading under the dock tab (dock.css),
  // so close through whichever close button shows: the dock tab's or the heading's.
  await click(page.locator('button:is([aria-label="Close Nets"],[aria-label="Close Nets panel"]):visible').first());
  await openAction(page,"signals-panel");
  const signals = page.locator(".panel-signals:visible");
  await sample("Dock · Signals",signals,[
    {control:"Filter signals",mode:"standalone"},{control:"Show",mode:"standalone"},
  ],"signals");
  await click(signals.getByRole("button",{name:"Create from nets…"}));
  await sample("Dock · Signals create from nets",signals,["Name"]);
  await click(page.locator('button[aria-label="Close Signals"]:visible').first());

  for (const {id, action, selector, fields = [], close = /Close/} of [
    {id:"messages", action:"messages", selector:".msg-panel", fields:[{control:"Filter messages",mode:"standalone"}]},
    {id:"pcb-list", action:"pcb-list", selector:".pl-panel", fields:[{control:"Object kind",mode:"standalone"}]},
    {id:"navigator", action:"navigator-panel", selector:".panel-navp", fields:[{control:"Search the Navigator",mode:"standalone"}]},
    {id:"filter", action:"query-panel", selector:".panel-query", fields:[{control:"Query expression",mode:"standalone"}]},
    {id:"comments", action:"comments-panel", selector:'.ui-dock-panel[data-dock="comments"]', fields:[{control:"Show comments",mode:"standalone"}]},
    {id:"calculators", action:"calculators", selector:".panel-calc", fields:[{control:"Calculator",mode:"standalone"}]},
    {id:"clipboard", action:"clipboard-panel", selector:'.ui-dock-panel[data-dock="clipboard"]'},
    {id:"scripting", action:"scripting-console", selector:".script-console", fields:[{control:"Script",mode:"standalone"}]},
    {id:"pours", action:"pour-manager", selector:".panel-pours", close:null},
    {id:"mcad", action:"mcad-panel", selector:".panel-mcad"},
    {id:"history", action:"history-panel", selector:'.ui-dock-panel[data-dock="history"]'},
  ]) {
    await openAction(page,action);
    const scope = page.locator(selector + ":visible");
    if (id === "scripting") await scope.getByRole("textbox",{name:"Script",exact:true}).fill("// Field alignment fixture\n// No execution");
    await sample("Dock · " + id,scope,fields,id);
    const closeButton = close && scope.getByRole("button",{name:close}).first();
    if (closeButton && await closeButton.isVisible()) await click(closeButton);
    else await openAction(page,action);
    await scope.waitFor({state:"hidden"});
  }
  // Documents family Dock panels (Butter, off by default): open each through its palette command.
  await page.evaluate(async () => {
    const prefs = await AtriumLazy.need("AtriumPrefs");
    for (const feature of ["savedViews","slides","datasheets"]) prefs.set("butter." + feature,true);
    await AtriumLazy.need("AtriumButterEditor");
  });
  for (const {id, command, selector} of [
    {id:"views", command:"butter.savedViews.panel", selector:".panel-views"},
    {id:"datasheet", command:"butter.datasheets.reader", selector:".panel-datasheet"},
  ]) {
    // Commands register once the flag's descriptor loads, a turn or more after the preference.
    await page.waitForFunction(name => AtriumKeymap.commands().some(entry => entry.id === name),command);
    await page.evaluate(name => AtriumKeymap.commands().find(entry => entry.id === name).run(),command);
    const scope = page.locator(selector + ":visible");
    await scope.waitFor();
    await sample("Dock · " + id,scope,[],id);
    const closeButton = scope.getByRole("button",{name:/^Close /}).first();
    if (await closeButton.isVisible()) await click(closeButton);
    else await page.evaluate(name => AtriumKeymap.commands().find(entry => entry.id === name).run(),command);
    await scope.waitFor({state:"hidden"});
  }
  await page.evaluate(() => { for (const feature of ["savedViews","slides","datasheets"]) AtriumPrefs.set("butter." + feature,false); });
  // Butter Dock panels (Ask AI, Query, Macros) exist only with their flags. Turn them on, open each
  // through its command, measure it, close it, and turn the flags off again before Properties.
  const butter = {ask:["ai","assist.ask-ai"], "design-query":["query","assist.design-query"], macros:["macros","assist.macros"]};
  await page.evaluate(async flags => {
    for (const [flag] of flags) AtriumPrefs.set("butter." + flag, true);
    await AtriumLazy.need("AtriumButterEditor");
  }, Object.values(butter));
  for (const [id, [, command]] of Object.entries(butter)) {
    await page.waitForFunction(command => !!AtriumKeymap.command(command), command);
    await page.evaluate(command => AtriumKeymap.command(command).run(), command);
    const scope = page.locator(`[data-dock-panel="${id}"]:visible`);
    await scope.locator(".intel-body > *").first().waitFor();
    if (id === "design-query") await scope.getByRole("combobox",{name:"Query"}).fill("resistor where value < 1 kΩ");
    await sample("Dock · " + id,scope,id === "design-query" ? ["Query"] : [],id);
    await scope.evaluate(node => node.querySelector(":scope > .pane-heading .ui-close").click());
    await scope.waitFor({state:"hidden"});
  }
  await page.evaluate(flags => { for (const [flag] of flags) AtriumPrefs.set("butter." + flag, false); }, Object.values(butter));
  await page.evaluate(() => AtriumDock.reveal("properties"));

  await changeDocument(page,"schematic");
  // Properties repaints after the document switch; the board's Class filter must be gone before measuring.
  await page.waitForFunction(() => !document.querySelector('#inspector [data-selection-kind="component-class"]'));
  await sample("Schematic · document Properties",inspector,[]);
  await changeDocument(page,"schematic",["part"]);
  await inspector.getByRole("combobox",{name:"Common parameters"}).waitFor();
  await sample("Schematic · placed component",inspector,["Designator","Comment",/^Rotation/]);
  await changeDocument(page,"schematic",["netlabel"]);
  await sample("Schematic · net label",inspector,["Text",/^X/]);
  // A property row whose value is a four-row textarea: the caption keeps to the textarea's first line.
  await page.evaluate(() => {
    const host = AtriumNavHost, frame = {id:Atrium.id(), kind:"textframe", x:10, y:10, w:40, h:20,
      text:"Field text fixture\nSecond line\nThird line"};
    host.edit(() => host.doc().items.push(frame), "Place text frame", [frame]);
    host.select([frame.id]);
  });
  await inspector.locator(".ui-prop-row > textarea[aria-label=Text]").waitFor();
  await sample("Schematic · text frame",inspector,[{control:"Text",mode:"multiline"}]);
  await sample("Workbench · schematic Active Bar",page.locator("#tools"),[]);

  await populateDrawings(page);
  await changeDocument(page,"drawing");
  await inspector.getByRole("button",{name:"Add Note",exact:true}).waitFor();
  await sample("Drawing · sheet and title block",inspector,[
    "Board","Drawing number",{control:"Sheet 1 size",mode:"standalone"},
  ]);
  const existingNotes = await inspector.locator(".drawing-note").count();
  await click(inspector.getByRole("button",{name:"Add Note",exact:true}));
  await sample("Drawing · added note",inspector.locator(".drawing-note").last(),[
    {control:"Note " + (existingNotes + 1),mode:"standalone"},
  ]);
  await changeDocument(page,"panel");
  await sample("Panel · document summary",inspector,[]);
  await panelCell(page);
  await inspector.getByRole("combobox",{name:"Board in this cell"}).waitFor();
  await sample("Panel · selected board cell",inspector,["Board in this cell","Rotation of this cell"]);
}

async function run(browser) {
  const reports = [];
  for (const profile of profiles) {
    const {theme,width,height,touch = false} = profile;
    const name = theme + (touch ? " touch" : "");
    const page = await browser.newPage({viewport:{width,height},hasTouch:touch});
    const session = await page.context().newCDPSession(page);
    const errors = [], report = [];
    page.on("pageerror",error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    try {
      await page.goto(app);
      // Measure settled text rather than an intermediate animation frame. This is the real
      // user-selectable Off preference, exercised in each theme and pointer profile.
      await page.evaluate(theme => AtriumTheme.set({preset:theme,followSystem:false,motion:"off"}),theme);
      assert.equal(await page.evaluate(() => matchMedia("(any-pointer:coarse)").matches),touch);
      const probes = [], failures = [];
      const read = scope => geometry.measureFieldText(page,session,scope);
      await surfaces(page,async (title, scope, required, panel) => {
        await scope.waitFor();
        const results = await read(scope);
        const {census,metrics} = await fieldCoverage(scope,results);
        for (const expectation of required) {
          const {control,mode} = typeof expectation === "object" && !(expectation instanceof RegExp) ?
            expectation : {control:expectation};
          const matches = result => [result.control,result.label].some(value =>
            control instanceof RegExp ? control.test(value) : value === control);
          assert.ok(results.some(result => matches(result) && (!mode || result.mode === mode) &&
            result.disposition === "measured"),
          `${name} ${title}: expected measured ${String(control)}${mode ? " (" + mode + ")" : ""}; saw ${results.map(row=>row.label + "/" + row.mode).join(", ")}`);
        }
        failures.push(...geometry.failures([...geometry.fieldTextResults(results), ...metrics]).map(item => ({surface:title, ...item})));
        report.push({title,results,panel,census});
        const row = async expected => (await read(scope)).find(item => item.control === expected || item.label === expected);
        if (title === "PCB · document Properties") {
          // Properties rows are library .ui-prop-row grids that centre their cells, so the caption sits on the
          // select's centre. Move the caption's painted text, then the select, to prove the checker rejects
          // a 1px drift either way, in every profile.
          const control = scope.getByRole("combobox",{name:"Component class filter"});
          const caption = control.locator("xpath=preceding-sibling::*[1]");
          probes.push(...await geometry.assertFieldTextPerturbations(caption,() => row("Component class filter"),{move:"caption"}));
          probes.push(...await geometry.assertFieldTextPerturbations(control,() => row("Component class filter"),{move:"field"}));
        }
        if (name === "light" && title === "PCB · copper track") {
          // A number with its unit inside the field's box: the caption centres on the box, and the unit shares
          // the value's baseline. Moving the caption, the box (with its text and unit) or the unit by 1px must each fail.
          const control = scope.locator(".ui-prop-row > .ui-field-measure > input[aria-label^=\"Width\"]").first();
          const read = () => row("Width");
          assert.equal((await read())?.mode,"compound","the track width carries its unit");
          probes.push(...await geometry.assertFieldTextPerturbations(control.locator("xpath=../../span[1]"),read,{move:"caption"}));
          probes.push(...await geometry.assertFieldTextPerturbations(control.locator("xpath=.."),read,{move:"field"}));
          probes.push(...await geometry.assertFieldTextPerturbations(control.locator("xpath=../span[contains(@class,'ui-field-unit')]"),read,{move:"unit"}));
        }
        if (name === "light" && title === "Schematic · text frame") {
          const caption = scope.locator(".ui-prop-row > textarea[aria-label=Text]").locator("xpath=../span[1]");
          probes.push(...await geometry.assertFieldTextPerturbations(caption,() => row("Text"),{move:"caption"}));
        }
        if (name === "light" && title === "PCB · View Configuration") {
          const control = scope.locator('output[aria-labelledby="vc-opacity-track"]');
          probes.push(...await geometry.assertFieldTextPerturbations(control,() => row("Tracks"),{move:"field"}));
        }
        if (name === "light" && title === "Footprint Editor · Properties and toolbar") {
          const caption = scope.getByLabel("Drawing layer",{exact:true}).locator("xpath=../span[1]");
          probes.push(await geometry.assertStackedCaptionPerturbation(caption,() => row("Drawing layer")));
        }
      },profile);
      assert.deepEqual(errors,[],name + " page errors");
      assertPanelCoverage(report,name);
      assert.deepEqual(failures,[],name + " field text and coverage");
      const modes = {}, noValue = {};
      for (const {results,census} of report) {
        for (const row of results) modes[row.mode] = (modes[row.mode] || 0) + 1;
        for (const row of census.unmeasured) noValue[row.family] = (noValue[row.family] || 0) + 1;
      }
      const count = report.filter(entry=>entry.panel).length;
      console.log(`PASS field alignment ${name}: ${report.length} states, ${count} Dock panels, ${JSON.stringify(modes)}; controls without value text ${JSON.stringify(noValue)}; ${probes.length} ±1px caption, field and unit probes rejected`);
      reports.push({profile:name, surfaces:report, probes, modes, noValue});
    } finally {
      await session.detach();
      await page.close();
    }
  }
  return reports;
}

module.exports = run;

if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {
    const browser = await chromium.launch({
      ...(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"}),
      args:["--allow-file-access-from-files"],
    });
    try { await run(browser); } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
