"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {projectZIP,openProjectZIP} = require("../support/browser-native-project.cjs");
const {showPanel} = require("../support/window-panels.cjs");

async function firstCanvas(browser, replace) {
  const page = await browser.newPage({viewport:{width:1400,height:960}}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.addInitScript(() => {
      const Native = window.ResizeObserver;
      window.firstCanvas = {fits:[], paints:[]};
      window.ResizeObserver = class extends Native {
        constructor(cb) {
          const editor = new Error().stack.includes("/editor.js");
          super((entries, observer) => {
            if (!editor || !entries.some(e => e.target.id === "canvas") || firstCanvas.released) return cb(entries, observer);
            firstCanvas.notify = zero => cb(entries.map(e => zero ? {target:e.target, contentRect:{width:0,height:0}} : e), observer);
          });
        }
      };
      Object.defineProperty(window,"AtriumCanvas",{configurable:true,set(C) {
        Object.defineProperty(window,"AtriumCanvas",{configurable:true,writable:true,value:C});
        const create=C.create;
        C.create=(canvas,...args)=>{
          const view=create(canvas,...args);
          if(canvas.id==="canvas") for(const [key,log] of [["fit","fits"],["render","paints"]]){
            const original=view[key];view[key]=function(doc,...rest){
              const result=original.call(this,doc,...rest), {width,height}=canvas.getBoundingClientRect();
              firstCanvas[log].push({doc:doc.id,camera:view.camera(),covered:canvas.inert,viewport:{width,height}});
              return result;
            };
          }
          return view;
        };
      }});
    });
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.waitForFunction(()=>!!firstCanvas.notify&&globalThis.AtriumStartPage?.isOpen());
    await page.evaluate(()=>{AtriumStartPage.close();firstCanvas.notify(true);});
    assert.deepEqual(await page.evaluate(()=>[firstCanvas.fits.length,firstCanvas.paints.length]),[0,0],"a zero-size starter canvas waits for a usable fit");
    if(replace){
      const name="Before first resize.kicad_pcb", buffer=await fs.readFile(path.join(__dirname,"../fixtures/import/demo.kicad_pcb"));
      await page.locator("#file-input").setInputFiles({name,mimeType:"application/octet-stream",buffer});
      await page.waitForFunction(name=>AtriumNavHost.importSession()?.sourceLabel===name && AtriumNavHost.canvas().inert,name);
    }else await page.evaluate(()=>AtriumPower.host({occluded:true}));
    const before=await page.evaluate(()=>AtriumNavHost.view().camera());
    await page.evaluate(()=>{firstCanvas.released=true;firstCanvas.notify(false);});
    if(!replace){
      assert.equal(await page.evaluate(()=>firstCanvas.paints.length),0,"the covered canvas does not paint");
      await page.evaluate(()=>AtriumPower.host({occluded:false}));
    }
    await page.waitForFunction(()=>firstCanvas.paints.length>0);
    const result=await page.evaluate(replace=>{
      const h=AtriumNavHost, view=h.view(), d=h.doc(), first=firstCanvas.paints[0], actual=view.camera();
      const backing=[h.canvas().width,h.canvas().height], canvas=h.canvas();
      // The first-Save hint can resize the canvas while the import report still covers it.
      // A revealed canvas must independently fit that viewport before it paints.
      const viewport=replace ? firstCanvas.fits.find(f=>f.doc===d.id && f.covered).viewport : first.viewport;
      const reference=AtriumCanvas.create(document.createElement("canvas"));
      reference.fit(d,h.defs(),d.items.length?undefined:"document",viewport);
      return {doc:d.id,first,actual,expected:reference.camera(),backing};
    },replace);
    assert.equal(result.first.doc,result.doc);
    assert.deepEqual(result.first.camera,result.actual,"the first paint is already fitted");
    assert.deepEqual(result.actual,result.expected,"camera matches an explicit fit to the opened viewport");
    if(replace){
      assert.deepEqual(result.actual,before,"the deferred starter fit cannot change an opened project");
      const paints=await page.evaluate(()=>firstCanvas.paints.length);
      await page.locator('#document-tabs [data-tab="'+result.doc+'"]').click();
      await page.waitForFunction(n=>firstCanvas.paints.slice(n).some(p=>!p.covered),paints);
      const revealed=await page.evaluate(n=>{
        const h=AtriumNavHost, v=h.view(), d=h.doc(), actual=v.camera(), first=firstCanvas.paints.slice(n).find(p=>!p.covered);
        const reference=AtriumCanvas.create(document.createElement("canvas"));
        reference.fit(d,h.defs(),d.items.length?undefined:"document",h.canvas().getBoundingClientRect());
        return {actual,first:first.camera,expected:reference.camera(),covered:h.canvas().inert};
      },paints);
      assert.equal(revealed.covered,false,"the design tab reveals its canvas");
      assert.deepEqual(revealed.first,revealed.expected,"the revealed design first paints at its own layout's fit");
      assert.deepEqual(revealed.actual,revealed.expected,"the report cannot leave its wider camera on the design");
    }
    assert.ok(result.backing.every(n=>n>0));assert.deepEqual(errors,[]);
  } finally {await page.close();}
}

async function boardLayers(browser) {
  const page = await browser.newPage(), requests = [], errors = [];
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", req => { if (req.url().endsWith("/pcb-layer-bar.js")) requests.push(req.url()); });
  try {
    await page.addInitScript(() => localStorage.setItem("atrium.prefs", JSON.stringify({
      format:"atrium-prefs", version:1, values:{"general.startPage":"never","general.efficiency":"always"}
    })));
    await page.route("**/pcb-layer-bar.js", async route => { await ready; await route.continue(); });
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    assert.equal(requests.length, 0, "Home keeps the PCB layer bar cold");
    const [sheet, board] = await page.evaluate(async () => {
      const host = AtriumNavHost, project = AtriumParts.example(), [sheet, board] = project.documents;
      await host.replaceProject({...project, documents:[sheet]}, {force:true,dirty:false});
      if (document.querySelector('script[src="pcb-layer-bar.js"]')) throw Error("a schematic requested the board layer bar");
      for (let n = 1; n <= 18; n++) board.items.push({id:"inner-" + n, kind:"track", net:"TEST",
        layer:"Inner " + n, width:0.25, points:[[n,1],[n,2]]});
      board.layerNames = {"Inner 16":"Clock return"};
      board.layerSets = [{name:"Clock", shown:["Top","Inner 16"]}];
      AtriumPower.host({occluded:true});
      await host.replaceProject(project, {force:true,dirty:false});
      if (document.querySelector('script[src="pcb-layer-bar.js"]')) throw Error("an occluded board requested the layer bar");
      return [sheet.id, board.id];
    });
    const requested = page.waitForRequest("**/pcb-layer-bar.js");
    await page.evaluate(() => AtriumPower.host({occluded:false}));
    await requested;
    await page.evaluate(id => AtriumNavHost.selectDocument(id), sheet);
    release();
    await page.waitForFunction(() => !!globalThis.AtriumPCBLayerBar);
    assert.equal(await page.locator("#layer-tabs button").count(), 0, "a late board load leaves a sheet alone");
    await page.evaluate(id => AtriumNavHost.selectDocument(id), board);
    const bar = page.locator("#layer-tabs"), opener = page.getByRole("button", {name:"All layers",exact:true});
    const menu = page.getByRole("menu", {name:"All layers",exact:true});
    const choose = async (group, item) => {
      await opener.click();
      await menu.getByRole("menuitem", {name:group,exact:true}).click();
      await menu.getByRole("menu", {name:group,exact:true}).getByRole("menuitemradio", {name:item,exact:true}).click();
    };
    assert.equal(await bar.locator(".copper").count(), 16);
    await choose("Copper tabs", "L17–L20");
    const inner = bar.getByRole("button", {name:"Clock return"});
    await inner.focus(); await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => AtriumNavHost.activeLayer()), "Inner 16");
    assert.equal(await inner.getAttribute("aria-pressed"), "true");
    await choose("Copper tabs", "Top and Bottom");
    assert.deepEqual(await bar.locator(".copper").evaluateAll(bs => bs.map(b => b.dataset.layer)), ["Top","Inner 16","Bottom"]);
    await choose("Visibility sets", "Clock");
    await page.waitForFunction(() => AtriumNavHost.hiddenLayers().has("Bottom"));
    assert.equal(await page.evaluate(() => AtriumNavHost.activeLayer()), "Inner 16");
    await opener.press("ArrowDown");
    const single = menu.getByRole("menuitemradio", {name:"Active layer only"});
    await single.focus(); await page.keyboard.press("Enter");
    assert.equal(await page.locator(".layer-bar").getAttribute("data-mode"), "single");
    await opener.click(); await page.keyboard.press("Escape");
    assert.equal(await opener.getAttribute("aria-expanded"), "false");
    assert.equal(await opener.evaluate(node => node === document.activeElement), true);
    await page.evaluate(() => AtriumNavHost.act("layer-controls"));
    await page.waitForFunction(() => document.activeElement?.dataset.t === "Layers");
    assert.equal(requests.length, 1);
    assert.deepEqual(errors, []);
  } finally { release(); await page.close(); }
}

module.exports = async function componentDemand(browser) {
  await firstCanvas(browser,false); await firstCanvas(browser,true); await boardLayers(browser); await require("../canvas/browser-view3d-open.js")(browser, ["demand"]);
  const page = await browser.newPage({viewport:{width:1400,height:960}}), errors = [], requests = [];
  let releaseList, releaseFlyout;
  const listReady = new Promise(resolve => { releaseList = resolve; });
  const flyoutReady = new Promise(resolve => { releaseFlyout = resolve; });
  page.setDefaultTimeout(7000);
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => requests.push(r.url().split("/").pop()));
  try {
    await page.addInitScript(() => localStorage.setItem("atrium.prefs", JSON.stringify({format:"atrium-prefs", version:1, values:{"general.startPage":"never", "general.efficiency":"always"}})));
    await page.route("**/navigator.js", async route => { await listReady; await route.continue(); });
    await page.route("**/active-bar-menu.js", async route => { await flyoutReady; await route.continue(); });
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.waitForFunction(() => !!globalThis.AtriumDock && !!globalThis.AtriumNavHost);
    const components = {click:() => showPanel(page, "components")}, properties = {click:() => showPanel(page, "properties")};
    const list = page.getByRole("listbox", {name:"Components"}), rows = page.locator("#parts [data-part]");
    await components.click(); await list.getByText("No components placed").waitFor();
    assert.ok(!requests.includes("navigator.js"), "the accessible empty list needs no renderer");
    await properties.click();
    const project = await page.evaluate(() => AtriumParts.example()); project.name = "Delayed components";
    const board = project.documents.find(d => d.kind === "pcb"), sheet = project.documents.find(d => d.kind === "schematic" && d.items.filter(i => i.kind === "part").length >= 2);
    await openProjectZIP(page,await projectZIP(project,{entryDocument:board.id}));
    await page.waitForFunction(name => AtriumNavHost.project().name === name && AtriumNavHost.folderProject()?.hasPresented(AtriumNavHost.currentId()),project.name);
    assert.ok(!requests.includes("navigator.js"), "an opened design keeps its closed Components panel cold");
    const parts = sheet.items.filter(i => i.kind === "part");
    await page.evaluate(id => AtriumNavHost.selectDocument(id), board.id);
    const requested = page.waitForRequest("**/navigator.js");
    await components.click(); await requested;
    await page.evaluate(async ([doc, part]) => {
      await AtriumNavHost.selectDocument(doc);
      AtriumNavHost.select([part]);
    }, [sheet.id, parts[1].id]);
    await properties.click(); releaseList();
    await page.waitForFunction(() => !!globalThis.AtriumNavigator);
    assert.equal(await rows.count(), 0, "a late load does not draw closed rows");
    await components.click();
    const selected = list.locator('[aria-selected="true"]'); await selected.waitFor();
    assert.equal(await selected.getAttribute("data-part"), parts[1].id);
    assert.equal(await page.locator("#part-count").textContent(), String(parts.length));
    await list.locator('[data-part="' + parts[0].id + '"]').click();
    assert.deepEqual(await page.evaluate(() => AtriumNavHost.selection()), [parts[0].id]);

    const tool = page.locator('#tools .tool[data-action="select"]'), fly = page.locator(".nav-flyout");
    await tool.click(); assert.ok(!requests.includes("active-bar-menu.js"), "ordinary tool clicks keep flyouts cold");
    const loading = page.waitForRequest("**/active-bar-menu.js");
    await tool.press("Alt+ArrowDown"); await loading; await page.keyboard.press("Escape");
    releaseFlyout(); await page.waitForFunction(() => !!globalThis.AtriumActiveBarMenu);
    assert.equal(await fly.count(), 0, "Escape cancels the first gesture while its menu is loading");
    await tool.click({button:"right"}); await fly.waitFor();
    await page.keyboard.press("End"); assert.equal(await fly.getByRole("menuitem").last().evaluate(b => b === document.activeElement), true);
    await page.keyboard.press("Escape"); assert.equal(await tool.evaluate(b => b === document.activeElement), true);
    await tool.hover(); await page.mouse.down(); await fly.waitFor(); await page.mouse.up();
    await fly.getByRole("menuitem", {name:/^Pan/}).click();
    assert.equal(await page.evaluate(() => AtriumNavHost.tool()), "pan");
    await page.locator('#tools [data-action="label"]').press("ArrowDown");
    await fly.getByRole("menuitem", {name:"Power Port", exact:true}).waitFor();
    assert.equal(await fly.getByRole("menuitem", {name:"Via", exact:true}).count(), 0);
    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
      const H = AtriumNavHost, D = await AtriumLazy.need("AtriumDrawing");
      const drawing = D.create(H.project(), {preset:"empty"});
      H.edit(() => H.project().documents.push(drawing), "Add drawing");
      await H.selectDocument(drawing.id);
    });
    const line = page.locator('#tools [data-action="drawing-line"]');
    await line.press("ArrowDown");
    await fly.getByRole("menuitem", {name:"Text", exact:true}).waitFor();
    await fly.getByRole("menuitem", {name:"Line", exact:true}).waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await line.evaluate(b => b === document.activeElement), true);
    assert.equal(requests.filter(s => s === "active-bar-menu.js").length, 1);
    assert.deepEqual(errors, []);
  } finally { releaseList(); releaseFlyout(); await page.close(); }
};
