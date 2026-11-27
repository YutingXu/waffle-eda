"use strict";
// Exercise the local edit/decision as one step and the actual roving tree from both editors.
const assert = require("node:assert/strict"), path = require("node:path");
const {pathToFileURL} = require("node:url");
const {openProjectZIP,saveFirstProjectZIP,readProjectZIP} = require("../support/browser-native-project.cjs");
const more = page => page.getByRole("button", {name:/^Project actions for /});
async function scopeItem(page) {
  await more(page).press("Enter");
  return page.getByRole("menu", {name:/^Project actions for /}).getByRole("menuitem", {name:/^Connections: /});
}
async function scopeLabel(page) {
  const item = await scopeItem(page);
  const label = await item.textContent();
  await page.keyboard.press("Escape");
  assert.equal(await more(page).getAttribute("aria-expanded"), "false");
  assert.ok(await more(page).evaluate(trigger => trigger === document.activeElement));
  return label;
}
async function openScope(page) {
  await (await scopeItem(page)).press("Enter");
  assert.equal(await more(page).getAttribute("aria-expanded"), "false");
  return page.getByRole("dialog", {name:"Cross-sheet connections", exact:true});
}
module.exports = async function projectConnections(browser) {
  const page = await browser.newPage({viewport:{width:1320, height:840}}), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(10000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
    const notice = page.locator("#project-scope-notice");
    assert.equal(await page.locator(".panel-projects").getByText(/^Connections: /).count(), 0);
    const add = page.getByRole("button", {name:"Add to Sensor interface", exact:true});
    await add.press("Enter");
    const addMenu = page.getByRole("menu", {name:"Add to Sensor interface", exact:true});
    assert.equal(await addMenu.getByRole("menuitem", {name:/^Connections: /}).count(), 0);
    await addMenu.getByRole("menuitem", {name:"Add New Schematic…", exact:true}).press("Enter");
    const newSheet = page.getByRole("dialog", {name:"Add schematic sheet", exact:true});
    await newSheet.locator("input").fill("Projects row test");
    await newSheet.getByRole("button", {name:"Add", exact:true}).click();
    await page.getByRole("treeitem", {name:"Projects row test", exact:true}).waitFor();
    assert.equal(await add.getAttribute("aria-expanded"), "false");
    const documentState = () => page.evaluate(() => {
      const h = AtriumNavHost, compiled = AtriumHierarchy.compileCached(h.project());
      return [compiled.scope, compiled.effective, h.undoSteps().history.length, h.project().documents[0].items.length];
    });
    for (const theme of ["light", "dark"]) {
      const ids = await page.evaluate(async theme => {
        await AtriumLazy.need(["AtriumProjectConnections","AtriumProjectTree","AtriumRules","AtriumUndoStore","AtriumMultichannel","AtriumTheme"]);
        AtriumTheme.setPreset(theme);
        const h = AtriumNavHost, p = Atrium.project("Scope fixture");
        const [top, board] = p.documents, child = Atrium.sheet("schematic", "Filter"); p.documents.push(child);
        AtriumProjectRules.setNetScope(p, "automatic");
        await h.replaceProject(p,{force:true,copy:true,dirty:false});
        return {top:top.id, board:board.id, child:child.id};
      }, theme);
      const baseline = await documentState();
      assert.equal(await scopeLabel(page),"Connections: Automatic → Global");
      assert.equal(await notice.count(),0);
      const dialog = await openScope(page);
      assert.equal(await dialog.getByLabel("Net identifier scope").inputValue(),"automatic");
      assert.equal(await dialog.locator("dt").count(),4); await dialog.getByRole("button",{name:"Cancel"}).focus();
      await page.keyboard.press("Escape"); await dialog.waitFor({state:"detached"});
      async function addPort() {
        await page.evaluate(() => {
          const h = AtriumNavHost, s = h.project().documents[0];
          h.selectDocument(s.id);
          // The same edit path used by Place > Port, with the known-item journal hint.
          const p = AtriumSchObjects.make("port",[10,20],{text:"CLK", io:"output"});
          h.edit(() => s.items.push(p),"Place port",[{doc:s,items:[p]}]);
        });
        assert.equal(await notice.getByRole("button",{name:"Switch"}).count(), 1);
        assert.equal(await dialog.count(),0);
      }
      await addPort();
      assert.deepEqual(await documentState(), ["global","global",baseline[2]+1,1]);
      await notice.getByRole("button",{name:"Undo edit"}).click();
      assert.deepEqual(await documentState(), baseline); assert.equal(await notice.count(),0);
      await addPort(); await notice.getByRole("button",{name:"Switch"}).click();
      assert.equal(await scopeLabel(page),"Connections: Automatic → Flat");
      assert.deepEqual(await documentState(),["automatic","flat",baseline[2]+1,1]);
      await page.evaluate(() => AtriumNavHost.act("undo")); assert.deepEqual(await documentState(),baseline);
      await page.evaluate(() => AtriumNavHost.act("redo")); assert.equal(await notice.count(),0);
      await page.evaluate(ids => {
        const h = AtriumNavHost, top = h.docById(ids.top), child = h.docById(ids.child);
        const op = AtriumSchObjects.make("sheetsymbol",[10,0],{name:"Repeat(CH,3,4)",sheet:child.id,
          entries:[{id:"entry",name:"CLK",offset:2.54,side:"left",io:"input"}]});
        const cp = AtriumSchObjects.make("port",[12,0],{text:"CLK",io:"input"}); cp.id = "branch-port";
        h.edit(() => {top.items.push(op); child.items.push(cp);}, "Add sheet entry", [{doc:top,items:[op]}, {doc:child,items:[cp]}]);
      }, ids);
      await notice.getByRole("button",{name:"Keep Flat"}).click();
      assert.deepEqual(await documentState(),["flat","flat",baseline[2]+2,2]);
      await page.evaluate(() => AtriumNavHost.act("undo")); assert.equal(await scopeLabel(page),"Connections: Automatic → Flat");
      await page.evaluate(() => AtriumNavHost.act("redo"));
      assert.equal(await page.locator("#documents [aria-expanded]").count(),0);
      assert.equal(await page.locator('#documents [aria-level="1"]').count(),3);
      await page.locator('#document-tabs [data-kind="pcb"]').click();
      await openScope(page); await dialog.getByLabel("Net identifier scope").selectOption("hierarchical");
      await dialog.getByRole("button",{name:"Apply"}).click();
      assert.equal(await scopeLabel(page),"Connections: Hierarchical");
      const group = page.locator("#documents .doc-row").filter({has:page.locator(".doc-channels")});
      assert.equal(await group.locator(".doc-channels").textContent(),"×2");
      assert.equal(await group.getAttribute("aria-level"),"2"); assert.equal(await group.getAttribute("aria-expanded"),"false");
      await group.focus(); await page.keyboard.press("ArrowRight"); assert.equal(await group.getAttribute("aria-expanded"),"true");
      await page.keyboard.press("ArrowRight");
      const focus = page.locator("#documents :focus"); assert.equal(await focus.textContent(),"CH3");
      await page.keyboard.press("ArrowDown"); assert.equal(await focus.textContent(),"CH4"); assert.equal(await focus.getAttribute("aria-posinset"),"2");
      await page.keyboard.press("ArrowRight"); await page.keyboard.press("ArrowRight");
      assert.equal(await focus.getAttribute("data-port"),"branch-port"); assert.equal(await focus.getAttribute("aria-level"),"4");
      assert.equal(await focus.getAttribute("aria-label"),"CLK · Input port");
      const portGeometry = await focus.evaluate(port => {
        const channel = port.previousElementSibling, bounds = node => node.getBoundingClientRect();
        return [bounds(port.querySelector(".tree-label")).left - bounds(channel.querySelector(".tree-label")).left,
          bounds(port).height, bounds(port.querySelector(".doc-port-io")).width];
      });
      assert.deepEqual(portGeometry, [14, 24, 16], "a port shares the aligned glyph and text slots of document rows");
      await page.keyboard.press("Enter");
      await page.waitForFunction(id => AtriumNavHost.currentId() === id && AtriumNavHost.selection().includes("branch-port"), ids.child);
      await group.focus(); await page.keyboard.press("ArrowLeft"); assert.equal(await group.getAttribute("aria-expanded"),"false");
      assert.equal(await page.locator('#documents [data-port="branch-port"]').count(),0);
      // Applying the offered conversion is one checkpoint, including the selected scope.
      await openScope(page); await dialog.getByLabel("Net identifier scope").selectOption("flat");
      await dialog.getByRole("button",{name:"Apply"}).click();
      const initial = await documentState();
      const plan = () => page.evaluate(() => {
        const h = AtriumNavHost;
        window.conversionDecision = AtriumProjectConnections.convert(h,{from:"flat",to:"hierarchical",
          apply() {h.project().documents[0].items.push(AtriumSchObjects.make("port",[2,0],{text:"TEST"}));}});
      });
      await plan(); assert.deepEqual(await documentState(),initial);
      await notice.getByRole("button",{name:"Cancel"}).click(); assert.equal(await page.evaluate(() => window.conversionDecision),false);
      assert.deepEqual(await documentState(),initial);
      await plan(); await notice.getByRole("button",{name:"Switch"}).click(); assert.equal(await page.evaluate(() => window.conversionDecision),true);
      assert.deepEqual(await documentState(),["hierarchical","hierarchical",initial[2]+1,initial[3]+1]);
      await page.evaluate(() => AtriumNavHost.act("undo")); assert.deepEqual(await documentState(),initial);
      await plan(); await page.evaluate(() => AtriumNavHost.edit(() => {AtriumNavHost.project().name += " amended";}));
      assert.equal(await page.evaluate(() => window.conversionDecision),false); assert.equal(await notice.count(),0);
    }
    // Foreign Automatic is a source declaration. The native working copy fixes the
    // imported effective mode until a designer explicitly opts back into Automatic.
    const dir = path.join(__dirname, "../fixtures/altium/pidp11-io-expander");
    const source = ["PCB-PiDP11IOExpander.PrjPcb","PiDP11IOExpander.SchDoc","PiDP11IOExpander.PcbDoc"].map(name => path.join(dir,name));
    async function fresh() {
      const p = await browser.newPage();
      p.on("pageerror", e => errors.push(e.message));
      await p.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
      await p.getByRole("button", {name:"Continue to editor", exact:true}).click();
      return p;
    }
    const cold = await fresh();
    try {
      assert.equal(await cold.evaluate(() => !!globalThis.AtriumDesignQueryRecord), false);
      const initial = await cold.evaluate(async () => {
        const h = AtriumNavHost, project = Atrium.project("First schematic edit");
        project.documents = [project.documents[0]];
        project.rules = {format:"atrium-rules",version:3,units:"mm",list:[
          {id:Atrium.id(),type:"ercNetScope",name:"Scoped override",enabled:true,priority:1,where:"schematic",
            scope:{languageVersion:1,source:'object where component.designator = "J1"'},netScope:"hierarchical"},
          {id:Atrium.id(),type:"ercNetScope",name:"Connections",enabled:true,priority:2,where:"schematic",
            scope:{languageVersion:1,source:"object"},netScope:"automatic"}
        ]};
        await h.replaceProject(project, {force:true,copy:true,dirty:false});
        const setting = AtriumHierarchy.scopeSetting(h.project());
        return {setting, effective:AtriumHierarchy.effectiveScope(h.project(), setting), dirty:h.isDirty(),
          history:h.undoSteps().history.length, compiled:!!globalThis.AtriumDesignQuery};
      });
      assert.deepEqual(initial, {setting:"automatic",effective:"global",dirty:false,history:0,compiled:false});
      await cold.waitForFunction(() => !!globalThis.AtriumProjectTree);
      await cold.evaluate(() => {
        const h = AtriumNavHost, sheet = h.doc();
        const port = AtriumSchObjects.make("port", [10,20], {text:"CLK",io:"input"});
        h.edit(() => sheet.items.push(port), "Place first port", [{doc:sheet,items:[port]}]);
      });
      await cold.locator("#project-scope-notice").getByRole("button", {name:"Switch"}).click();
      const scopeState = () => cold.evaluate(() => {
        const h = AtriumNavHost, project = h.project(), setting = AtriumHierarchy.scopeSetting(project);
        return [setting,AtriumHierarchy.effectiveScope(project, setting),h.undoSteps().history.length,h.doc().items.length];
      });
      assert.deepEqual(await scopeState(), ["automatic","flat",1,1]);
      await cold.evaluate(() => AtriumNavHost.act("undo"));
      assert.deepEqual(await scopeState(), ["automatic","global",0,0]);
    } finally {await cold.close();}
    const imported = await fresh();
    let workingCopy, sheetId;
    try {
      await imported.locator("#file-input").setInputFiles(source);
      await imported.waitForFunction(()=>AtriumNavHost.importSession()?.state==="unsaved");
      sheetId = await imported.evaluate(async () => {
        const h = AtriumNavHost;
        const project = h.project(), sheet = project.documents.find(d => d.kind === "schematic"), H = AtriumHierarchy;
        const invariant = () => H.sourceAutomatic(project) && H.scopeSetting(project) === "global" && !document.getElementById("project-scope-notice");
        if (!invariant() || H.effectiveScope(project, "automatic") !== "global") throw Error("Initial source scope lost");
        const x = await AtriumLazy.need("AtriumAltiumExport");
        if (!x.exportProject(project).files[0].content.includes("HierarchyMode=0")) throw Error("Untouched source Automatic lost on export");
        h.selectDocument(sheet.id);
        h.edit(() => sheet.items.push(AtriumSchObjects.make("port",[0,0],{text:"ADDED"})), "Place first port");
        if (!invariant() || H.effectiveScope(project, "automatic") !== "flat") throw Error("First port reinterpreted the imported design");
        const out = x.exportProject(project);
        if (!out.files[0].content.includes("HierarchyMode=3") || !out.diagnostics.some(d => /scope exported/.test(d))) throw Error("Edited source exported with changed connectivity");
        return sheet.id;
      });
      workingCopy = await saveFirstProjectZIP(imported);
      assert.equal((await readProjectZIP(workingCopy.buffer)).manifest.header.entryDocument,sheetId);
    } finally {await imported.close();}
    const restored = await fresh();
    try {
      await openProjectZIP(restored,workingCopy);
      await restored.waitForFunction(id=>AtriumNavHost.currentId()===id && AtriumNavHost.folderProject()?.hasPresented(id),sheetId);
      await restored.evaluate(async () => {
        const h = AtriumNavHost, H = AtriumHierarchy;
        const project = h.project(), sheet = h.doc();
        if (!H.sourceAutomatic(project) || H.scopeSetting(project) !== "global") throw Error("Reopening lost the source scope");
        const child = Atrium.sheet("schematic", "Added child");
        const symbol = AtriumSchObjects.make("sheetsymbol", [18,0], {sheet:child.id, name:"Child",
          entries:[{id:"source-entry",name:"ADDED",side:"left",offset:2.54,io:"unspecified"}]});
        h.edit(() => {project.documents.push(child); sheet.items.push(symbol);}, "Add first sheet entry");
        if (document.getElementById("project-scope-notice") || H.compileCached(project).effective !== "global") throw Error("First entry reinterpreted the reopened design");
      });
      const settings = await openScope(restored);
      await settings.getByLabel("Net identifier scope").selectOption("automatic"); await settings.getByRole("button",{name:"Apply"}).click();
      await restored.evaluate(() => {
        const h = AtriumNavHost, p = h.project(), s = p.documents.find(d => d.kind === "schematic").items.find(i => i.entries?.some(e => e.id === "source-entry"));
        if (AtriumHierarchy.sourceAutomatic(p)) throw Error("Explicit Automatic did not override source mode");
        h.edit(() => {s.entries = [];}, "Remove last sheet entry");
      });
      await restored.locator("#project-scope-notice").getByRole("button",{name:"Keep Hierarchical"}).waitFor();
    } finally {await restored.close();}
    assert.deepEqual(errors,[]);
    console.log("PASS real Projects controls in light/dark and PCB/schematic, repeated channels, keyboard port jump, Switch/Keep/Undo and deferred frame conversion");
  } finally {await page.close();}
};
if (require.main === module) {
  const {chromium} = require("../support/playwright.cjs");
  (async () => {const browser = await chromium.launch({channel:"chrome"});
    try {await module.exports(browser);} finally {await browser.close();}})().catch(e => {console.error(e); process.exitCode = 1;});
}
