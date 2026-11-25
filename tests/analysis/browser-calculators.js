"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function assertCatalog(picker) {
  const ids = await picker.locator("option").evaluateAll(options => options.map(option => option.value));
  assert.deepEqual(ids, [
    "track_width", "current_capacity", "via_current", "impedance", "track_resistance",
    "eseries", "voltage_divider", "led_resistor", "rclc", "attenuator",
    "divider", "derating", "units", "ohm"
  ], "the native picker includes the engineering catalog and both shared notebook tools exactly once");
}

// The normal Home picker imports the BSD-2 PiDP sources. Menu commands, canvas clicks and
// keyboard input drive the panel. Set CALCULATOR_SCREENSHOTS to record the public views.
module.exports = async function calculators(browser) {
  const dir = path.join(__dirname,"../fixtures/altium/pidp11-io-expander");
  const shots = process.env.CALCULATOR_SCREENSHOTS;
  const page = await browser.newPage({viewport:{width:1440,height:940},reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror",e => errors.push(e.message));
  page.setDefaultTimeout(10000);
  const panel = page.locator(".panel-calc:visible"), picker = panel.getByRole("combobox",{name:"Calculator",exact:true});
  const state = id => page.waitForFunction(id => document.querySelector(".panel-calc .calc-pick")?.value === id,id);
  async function menu(which, action = "calculators") {
    const menu = page.locator("details[data-menu="+which+"]");
    await menu.locator(":scope > summary").click();
    const section = which === "window" ? menu.locator("#sub-window-panels") : menu;
    if (which === "window") await section.getByRole("menuitem",{name:"Panels",exact:true}).click();
    await section.locator('[data-action="'+action+'"]').click();
  }
  async function shot(name,theme) {
    await page.evaluate(theme => AtriumTheme.set({preset:theme,followSystem:false},{persist:false}),theme);
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForFunction(()=>!document.documentElement.hasAttribute("data-theme-fading"));
    if (!await page.evaluate(()=>!!globalThis.axe)) await page.addScriptTag({path:require.resolve("axe-core/axe.min.js")});
    const issues = await page.evaluate(async()=>{
      const report = await axe.run(".panel-calc",{runOnly:["wcag2a","wcag2aa","wcag21a","wcag21aa","best-practice"]});
      return report.violations.map(v=>({rule:v.id,targets:v.nodes.map(n=>n.target)}));
    });
    assert.deepEqual(issues,[],theme+" calculator accessibility");
    if (!shots) return;
    await fs.mkdir(shots,{recursive:true});
    await page.screenshot({path:path.join(shots,name+"-"+theme+".png")});
  }
  async function selectCanvas(query,extend = false) {
    if (query.ref) {
      await page.evaluate(ref => {
        const h = AtriumNavHost, item = h.doc().items.find(i => i.ref === ref);
        const [x,y] = [item.x,item.y]; h.zoomTo([x-45,y-32,x+45,y+32]);
      },query.ref);
    }
    // Let the canvas resize after document switches and zooms before computing the click position.
    await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
    const picked = await page.evaluate(({kind,ref,id}) => {
      const h = AtriumNavHost, d = h.doc(), c = h.canvas(), r = c.getBoundingClientRect(), v = h.view();
      for (const i of d.items) {
        if (i.kind !== kind || id && i.id !== id || ref && i.ref !== ref || i.keepout || i.fill || kind === "track" && (!i.net || i.layer !== "Top")) continue;
        const points = kind === "track" ? i.points.slice(1).map(([x,y],n) => [(x+i.points[n][0])/2,(y+i.points[n][1])/2]) : [[i.x,i.y]];
        if (kind === "part") {
          const [x,y,a,b] = AtriumNavCommon.itemBox(d,h.defs(),i);
          for (let n=1;n<10;n++) for (let k=1;k<10;k++) points.push([x+(a-x)*n/10,y+(b-y)*k/10]);
        }
        for (const pt of points) {
          const [px,py] = v.worldToScreen(pt), x = r.left + px, y = r.top + py;
          if (px < 8 || py < 8 || px > r.width-8 || py > r.height-8 || h.hit(c,x,y)?.item?.id !== i.id) continue;
          return {x,y,id:i.id,width:i.width,drill:i.drill};
        }
      }
      return null;
    },query);
    assert.ok(picked,"pickable canvas item "+(query.ref || query.id || query.kind));
    if (extend) await page.keyboard.down("Shift");
    try { await page.mouse.click(picked.x,picked.y); }
    finally { if (extend) await page.keyboard.up("Shift"); }
    await page.waitForFunction(id => AtriumNavHost.selection().includes(id),picked.id);
    return picked;
  }
  async function expectField(id,value) {
    await page.waitForFunction(([id,value]) => document.getElementById("calc-"+id)?.value === value,[id,value]);
  }
  const design = () => page.evaluate(() => AtriumNavHost.project());
  const steps = () => page.evaluate(()=>AtriumNavHost.undoSteps().history.length);
  const action = cmd => page.evaluate(cmd=>AtriumNavHost.act(cmd),cmd);
  try {
    await page.addInitScript(() => {
      globalThis.ATRIUM_UNDO_VERIFY = "throw";
      localStorage.setItem("atrium.prefs",JSON.stringify({format:"atrium-prefs",version:1,values:{"general.efficiency":"always","appearance.animations":"off"}}));
    });
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    const choose = page.waitForEvent("filechooser");
    await page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Import from Altium or KiCad…", exact:true}).click();
    const sources = {schematic:"PiDP11IOExpander.SchDoc", pcb:"PiDP11IOExpander.PcbDoc"};
    const files = ["PCB-PiDP11IOExpander.PrjPcb", sources.schematic, sources.pcb];
    await (await choose).setFiles(files.map(name => path.join(dir, name)));
    await page.getByRole("article", {name:"Import fidelity report"}).waitFor();
    const imported = await page.evaluate(() => AtriumNavHost.project().documents.map(doc => ({
      id:doc.id, kind:doc.kind, source:AtriumImportReports.sourceDocument(doc).sourceName,
      translator:AtriumImportReports.recent(doc.id)?.report.translator
    })));
    assert.deepEqual(Object.fromEntries(imported.map(d => [d.kind, d.source])), sources);
    assert.ok(imported.every(d => d.translator === "altium"));
    const ids = Object.fromEntries(imported.map(d => [d.kind, d.id]));
    async function tab(kind) {
      const el = page.locator('#document-tabs [data-tab="'+ids[kind]+'"]');
      if (await el.count()) await el.click(); else await page.locator('#documents [data-doc="'+ids[kind]+'"]').first().click();
      await page.waitForFunction(id => AtriumNavHost.currentId() === id, ids[kind]);
    }
    await tab("pcb");
    const entry = '[data-action="calculators"]', label = /^Calculators$/;
    assert.equal(await page.locator('details[data-menu=tools] '+entry).filter({hasText:label}).count(),1,"Tools offers one calculator shortcut");
    assert.equal(await page.locator('details[data-menu=window] #sub-window-panels '+entry).filter({hasText:label}).count(),1,"Window › Panels offers one calculator command");
    assert.equal(await page.locator(".menubar "+entry).count(),2,"the two calculator routes do not duplicate menu entries");
    await menu("tools");
    await picker.waitFor();
    await assertCatalog(picker);
    assert.equal(await page.evaluate(() => AtriumExtensions.workers.length),0);
    const t = await selectCanvas({kind:"track"}); await state("track_resistance");
    assert.match(await panel.locator(".calc-out").innerText(),/Resistance[\s\S]*Current capacity/);
    const width = await panel.locator("#calc-track_resistance-width").inputValue();
    assert.ok(Math.abs(await page.evaluate(n=>Atrium.units.parse(n,AtriumNavHost.units()),width)-t.width)<1e-6);
    await shot("track","light");
    await panel.getByRole("button",{name:"Pin calculator"}).click();
    const via = await selectCanvas({kind:"via"});
    assert.equal(await picker.inputValue(),"track_resistance");
    await picker.selectOption("ohm");
    await panel.locator("#calc-ohm-v").fill("12");
    await selectCanvas({kind:"track"});
    assert.equal(await picker.inputValue(),"ohm");
    assert.equal(await panel.locator("#calc-ohm-v").inputValue(),"12");
    await panel.getByRole("button",{name:"Pin calculator"}).click();
    await state("track_resistance");
    await selectCanvas({kind:"via"}); await state("via_current");
    const drill = panel.locator("#calc-via_current-drill");
    assert.ok(Math.abs(await page.evaluate(n=>Atrium.units.parse(n,AtriumNavHost.units()),await drill.inputValue())-via.drill)<1e-6);
    const initial = await page.evaluate(()=>AtriumNavHost.undoSteps().history.length);
    await drill.fill("0.31mm"); await panel.getByRole("button",{name:"Apply",exact:true}).click();
    const viaDrill = id => AtriumNavHost.doc().items.find(i=>i.id===id).drill;
    assert.equal(await page.evaluate(viaDrill,via.id),.31);
    assert.equal(await page.evaluate(()=>AtriumNavHost.undoSteps().history.length),initial+1);
    await page.evaluate(()=>AtriumNavHost.act("undo")); assert.equal(await page.evaluate(viaDrill,via.id),via.drill);
    await page.evaluate(()=>AtriumNavHost.act("redo")); assert.equal(await page.evaluate(viaDrill,via.id),.31);
    await page.evaluate(()=>AtriumNavHost.act("undo"));
    await picker.focus(); await page.keyboard.press("Escape");
    await page.waitForFunction(()=>document.querySelector(".panel-calc")?.hidden && document.activeElement === AtriumNavHost.canvas());
    await tab("schematic");
    await menu("window");
    await selectCanvas({kind:"part",ref:"R4"}); await state("rclc");
    assert.equal(await panel.locator("#calc-rclc-r").inputValue(),"3900");
    assert.equal(await panel.locator("#calc-rclc-c").inputValue(),"0.033");
    assert.match(await panel.locator(".calc-out").innerText(),/128\.7 ns/);
    const publicPair = await selectCanvas({kind:"part",ref:"C2"},true);
    assert.equal(await page.evaluate(()=>AtriumNavHost.selection().length),2);
    assert.ok(publicPair.id);
    await expectField("rclc-c","0.033");
    await shot("rc","dark");
    await picker.focus(); await page.keyboard.press("Escape");
    const backgroundJobs = await page.evaluate(()=>{
      const h=AtriumNavHost, stage=h.stageEdit; let count=0;
      h.stageEdit=(...args)=>{ if (args[1]==="calculators") count++;return stage(...args); };
      try { h.select([]);h.setHighlight("CLK");h.setHighlight(""); }
      finally { h.stageEdit=stage; }
      return count;
    });
    assert.equal(backgroundJobs,0,"closed calculators schedule no selection or highlight work");
    await page.evaluate(()=>AtriumKeymap.importJSON({format:"atrium-keys",version:1,preset:"altium",bindings:{"calculators.show":[{key:"Alt+Shift+7"}]}}));
    await page.keyboard.press("Alt+Shift+7"); await picker.waitFor();
    await page.evaluate(()=>AtriumExtensions.execute("calculators.show"));
    assert.equal(await page.locator(".panel-calc").count(),1);
    assert.equal(await page.locator('[data-extension="waffle.calculators"].ext-panel').count(),0);
    console.log("PASS public Altium board and schematic: canvas track/via and connected RC, both menus, pin, units and undo");

    // The public design has no controlled-impedance profile or adjustable regulator. Exercise
    // those paths using an explicit rule book, pin-level electrical connections and mil display.
    const bench = await page.evaluate(require("./calculator-design.js"));
    await page.evaluate(async p => {
      Atrium.validate(p);
      await AtriumNavHost.replaceProject(p,{force:true,dirty:false});
      AtriumNavHost.selectDocument("board");
    },bench);
    const apply = panel.getByRole("button",{name:"Apply",exact:true});
    await selectCanvas({kind:"track",id:"clock"}); await state("impedance");
    await expectField("impedance-target","50");
    assert.match(await panel.locator(".calc-out").innerText(),/Resistance[\s\S]*Current capacity/);
    const base = await design(), count = await steps();
    await apply.click(); const changed = await design();
    assert.notEqual(changed.documents[1].items[0].width,base.documents[1].items[0].width);
    assert.equal(await steps(),count+1);
    await action("undo"); assert.deepEqual(await design(),base,"Undo restores every design field");
    await action("redo"); assert.deepEqual(await design(),changed);
    await action("undo");

    async function chooseNet(name) {
      const table = page.locator(".nets-table:visible");
      const netsTab = page.locator('[data-dock-tab="nets"]:visible');
      if (!await table.count() && await netsTab.count()) await netsTab.click();
      if (!await table.count()) {
        await menu("window","nets-panel");
      }
      await page.getByRole("searchbox",{name:"Filter nets"}).fill(name);
      await table.locator("td.nets-col-name").filter({hasText:new RegExp("^"+name+"$")}).click();
      if (!await panel.count()) {
        // The Calculators tab, or the dock's ⋯ menu when the tab has no room in the strip.
        const tab = page.locator('[data-dock-tab="calculators"]:visible');
        if (await tab.count()) await tab.click();
        else {
          await page.locator('.dock-tabs:has([data-dock-tab="calculators"]) .dock-tab-more').click();
          await page.locator(".nav-menu").getByRole("menuitem",{name:"Calculators",exact:true}).first().click();
        }
      }
      await page.waitForFunction(name=>AtriumNavHost.highlight()===name && AtriumNavHost.highlightSelected(),name);
    }
    await chooseNet("D_P"); await expectField("impedance-mode","differential"); await expectField("impedance-target","90");
    const dims = await page.evaluate(()=>["width","gap"].map(k=>Atrium.units.parse(document.getElementById("calc-impedance-"+k).value,AtriumNavHost.units())));
    assert.ok(Math.abs(dims[0]-.24)<1e-7 && Math.abs(dims[1]-.18)<1e-7);
    await chooseNet("CLOCK"); await expectField("impedance-mode","single");
    assert.match(await panel.locator(".calc-proposal").innerText(),/Clock 50.*Top/);

    // A reviewed result may be activated after a target changes but before the next animation frame.
    async function freshTrack() {
      await page.evaluate(()=>{const h=AtriumNavHost; h.setHighlight(""); h.select(["clock"]);});
      await page.waitForFunction(()=>document.querySelector(".calc-proposal:not([hidden]) span")?.textContent.startsWith("Track width"));
    }
    await freshTrack();
    const staleMeasures = await page.evaluate(()=>{
      const h=AtriumNavHost, button=document.querySelector(".calc-proposal button"), before=JSON.stringify(h.project()), n=h.undoSteps().history.length;
      h.select(["spare"]);button.click();
      return [before===JSON.stringify(h.project()),n===h.undoSteps().history.length];
    });
    assert.deepEqual(staleMeasures,[true,true],"stale selection leaves the exact design and history alone");
    await freshTrack();
    const lockChecks = await page.evaluate(()=>{
      const h=AtriumNavHost, i=h.doc().items.find(i=>i.id==="clock"), button=document.querySelector(".calc-proposal button");
      h.edit(()=>{i.locked=true;},"Lock track",[i]);
      const before=JSON.stringify(h.project()), n=h.undoSteps().history.length; button.click();
      return [before===JSON.stringify(h.project()),n===h.undoSteps().history.length];
    });
    assert.deepEqual(lockChecks,[true,true],"an intervening lock prevents Apply"); await action("undo");
    await freshTrack();
    const oldInputs = await page.evaluate(()=>{
      const h=AtriumNavHost, old=document.querySelector(".calc-proposal button").onclick, input=document.getElementById("calc-impedance-target");
      const before=JSON.stringify(h.project()), n=h.undoSteps().history.length;
      input.value="55"; input.dispatchEvent(new Event("input",{bubbles:true})); old();
      const hidden=document.querySelector(".calc-proposal").hidden;
      input.value="50"; input.dispatchEvent(new Event("input",{bubbles:true}));
      // A just-autofilled control whose input event has not been delivered also invalidates the review.
      input.value="56"; document.querySelector(".calc-proposal button").click();
      return [hidden,before===JSON.stringify(h.project()),n===h.undoSteps().history.length];
    });
    assert.deepEqual(oldInputs,[true,true,true],"edited inputs cannot activate a previous calculation");
    await page.evaluate(()=>{const h=AtriumNavHost;h.select(["spare"]);});
    await freshTrack();
    const freshProject = await page.evaluate(async()=>{
      const h=AtriumNavHost, p=Atrium.clone(h.project()), old=document.querySelector(".calc-proposal button").onclick;
      await h.replaceProject(p,{force:true,dirty:false}); h.select(["clock"]);
      const before=JSON.stringify(p), n=h.undoSteps().history.length; old();
      return [p===h.project(),before===JSON.stringify(p),n===h.undoSteps().history.length];
    });
    assert.deepEqual(freshProject,[true,true,true],"a replacement with the same project name and IDs invalidates the old edit");

    await page.locator('#document-tabs [data-tab="sheet"],#documents [data-doc="sheet"]').first().click();
    await page.waitForFunction(()=>AtriumNavHost.doc().id==="sheet");
    await selectCanvas({kind:"part",ref:"R90"}); await state("divider");
    await selectCanvas({kind:"part",ref:"R3"},true);
    await page.waitForFunction(()=>JSON.parse(document.getElementById("calc-divider-top").dataset.selection)[0].length===2);
    await expectField("divider-top","30000");
    assert.equal(await page.evaluate(()=>AtriumNavHost.selection().length),2);
    await expectField("divider-bottom","10000"); assert.match(await panel.locator(".calc-out").innerText(),/3\.2 V/);
    await panel.locator("#calc-divider-solve").selectOption("resistors"); await panel.locator("#calc-divider-vout").fill("4.8");
    const dividerBase=await design(), divSteps=await steps();
    assert.ok(await apply.isVisible(),await panel.innerText());
    await apply.click();
    assert.equal(await steps(),divSteps+1);
    assert.notDeepEqual((await design()).documents[0].items,dividerBase.documents[0].items);
    await action("undo"); assert.deepEqual(await design(),dividerBase);
    await selectCanvas({kind:"part",ref:"R5"}); await selectCanvas({kind:"part",ref:"C7"},true);
    await state("rclc"); assert.match(await panel.locator(".calc-out").innerText(),/48\.4 µs/);
    await chooseNet("CLOCK"); await expectField("impedance-target","50"); await apply.waitFor();
    const sheetBase = await design(), sheetSteps = await steps(); await apply.click(); const sheetApplied = await design();
    const profileWidth = p => p.documents[1].stackup.impedanceProfiles[0].layers.Top.width;
    assert.notEqual(profileWidth(sheetApplied),profileWidth(sheetBase));
    assert.deepEqual(sheetApplied.documents[0],sheetBase.documents[0],"profile belongs to the PCB while schematic is active");
    assert.equal(await steps(),sheetSteps+1); await action("undo"); assert.deepEqual(await design(),sheetBase);
    await action("redo"); assert.deepEqual(await design(),sheetApplied);
    assert.deepEqual(errors,[]);
    console.log("PASS Nets-panel pair/profile selection, linked multi-selection, checked one-step edits, stale target/project/inputs/lock, exact undo and redo");
  } finally { await page.close(); }
};
module.exports.assertCatalog = assertCatalog;
