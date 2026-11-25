"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const serveApp = require("../support/browser-app-server.cjs");

async function standaloneMath(browser) {
  const page=await browser.newPage(), requested=new Set();
  page.on("request",r=>requested.add(new URL(r.url()).pathname.split("/").pop()));
  await require("../fixtures/notebook-labs.cjs").profile(page);
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.getByRole("button",{name:"Continue to editor",exact:true}).click();
    await page.keyboard.press("F1");
    const palette=page.locator("#palette[open]"), box=palette.getByRole("combobox");
    await palette.getByRole("option").first().waitFor();
    await box.press("Backspace");
    for (const [source,display] of [["10k || 4.7k","3.197 k"],["4.7kΩ in E24","4.7 kΩ"]]) {
      await box.fill(source);
      await palette.getByText(display,{exact:true}).first().waitFor();
    }
    for (const file of ["design-query.js","rules.js","calculators.js","calculator-panel.js"]) assert.ok(!requested.has(file),file);
    await box.fill("count(LED)");
    await palette.getByText("0 ea",{exact:true}).first().waitFor();
    assert.ok(requested.has("design-query.js"));
  } finally {await page.close();}
}

module.exports = async function paletteEngine(browser) {
  await standaloneMath(browser);
  await require("./browser-palette-labs.js")(browser);
  const page = await browser.newPage({viewport:{width:1400,height:920}});
  const paletteModule = Promise.withResolvers(), paletteView = Promise.withResolvers();
  const held = new Map([["/editor/palette.js",paletteModule.promise],["/editor/palette-view.js",paletteView.promise]]);
  const server = await serveApp({cacheControl:"no-store",beforeRead:pathname => held.get(pathname)});
  await require("../fixtures/notebook-labs.cjs").profile(page);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  try {
    await page.goto(server.url,{waitUntil:"domcontentloaded"});
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    const dialog = page.locator("dialog#palette");
    const box = dialog.getByRole("combobox");
    const labels = dialog.locator(".nav-palette-label");
    const canvas = page.locator("#canvas");
    await canvas.focus();
    await page.keyboard.press("/");
    assert.equal(await box.evaluate(n => n === document.activeElement),true);
    assert.equal(await dialog.getAttribute("data-mode"),"search","/ opens the one palette unfiltered (insert stays on Place › Insert or Search…)");
    assert.equal(await page.evaluate(() => typeof globalThis.AtriumPalette),"undefined");
    await page.keyboard.type(">teardorps");
    paletteModule.resolve();
    await page.waitForFunction(() => globalThis.AtriumPalette?.index()?.source("commands").length > 0);
    assert.equal(await page.evaluate(() => typeof globalThis.AtriumPaletteView),"undefined");
    assert.equal(await box.inputValue(),">teardorps","typing survives command indexing while the result view is cold");
    paletteView.resolve();
    await labels.filter({hasText:"Teardrops"}).first().waitFor();
    assert.equal(await box.inputValue(),"teardorps");
    const scope = dialog.getByRole("button",{name:"Remove Commands scope",exact:true});
    assert.ok(await scope.isVisible());
    await box.fill("@U1-3");
    assert.equal(await scope.isVisible(),false);
    await labels.filter({hasText:/^U1\.3\b/}).first().waitFor();
    await box.fill(":10,20");
    await labels.filter({hasText:/10.*20/}).first().waitFor();
    await box.fill("/res 10k");
    await labels.filter({hasText:/Resistor.*10 kΩ/i}).first().waitFor();
    await box.press("Control+k");
    await dialog.getByRole("menu", {name:"Actions",exact:true}).getByRole("menuitem").first().waitFor();
    await page.keyboard.press("Escape");
    assert.equal(await box.inputValue(),"/res 10k");
    await box.press("Escape");
    await canvas.focus();
    await page.keyboard.press("F1");
    assert.equal(await dialog.getAttribute("data-mode"),"command");
    await box.fill(">save");
    const rawSections=await page.evaluate(()=>AtriumPalette.searchAll("save",">").map(entry=>entry.detail?.split(" › ",1)[0]));
    const viewRank=rawSections.indexOf("View");
    assert.ok(rawSections.indexOf("File") < viewRank && rawSections.lastIndexOf("File") > viewRank,
      "the underlying rank has a File/View/File interleave");
    const fileGroup=dialog.getByRole("group",{name:"File",exact:true});
    await fileGroup.getByRole("option",{name:/^Save Project/}).waitFor();
    assert.equal(await fileGroup.count(),1);
    assert.deepEqual(await dialog.locator(".nav-palette-group").allTextContents().then(headings=>headings.slice(0,2)),["File","View"]);
    await scope.click();
    assert.equal(await scope.isVisible(),false);
    assert.equal(await box.evaluate(node=>node===document.activeElement),true);
    await box.fill("@U1");
    await labels.filter({hasText:/^U1$/}).first().waitFor();
    await box.press("Escape");
    // View › Search Everything… (the app bar has no Search field since 2026-11-23).
    await page.locator('.work-menu[data-menu="view"] > summary').click(); await page.locator('.work-menu[data-menu="view"] [data-action="search"]').click();
    assert.equal(await dialog.getAttribute("data-mode"),"search");
    await box.fill("resistor");
    await dialog.locator(".nav-palette-group").filter({hasText:/^Library$/}).waitFor();
    assert.equal(await dialog.locator(".nav-palette-group").first().textContent(),"Top hit");
    await box.press("Escape");
    assert.equal(await page.evaluate(() => document.activeElement === AtriumNavHost.canvas()),true);

    // The contact classifier supplies a frozen world point. Further pointer motion and late provider
    // responses must never move the selection or change the target passed to a primary action.
    const claimed = await page.evaluate(() => {
      const canvas = AtriumNavHost.canvas();
      canvas.addEventListener("waffle-insert-request",e => e.preventDefault(),{once:true});
      const accepted = canvas.dispatchEvent(new CustomEvent("waffle-insert-request",{
        bubbles:true,cancelable:true,detail:{source:"hold",pointerType:"touch",world:[31,27],docId:AtriumNavHost.currentId()}
      }));
      return {accepted,open:AtriumPalette.isOpen()};
    });
    assert.deepEqual(claimed,{accepted:false,open:false});
    await page.evaluate(() => {
      window.paletteFixture = {started:{},ran:null};
      AtriumPalette.registerProvider("fixture",{
        entries:() => ["Alpha","Beta"].map((label,n) => ({
          key:"fixture:"+n, kind:"command",label:"Qfederation " + label,
          run:req => {window.paletteFixture.ran = {point:req.context.point,pointerType:req.context.pointerType};}
        })),
        stream(req,emit) {window.paletteFixture.started[req.query] = {signal:req.signal,emit};}
      });
      document.getElementById("canvas").dispatchEvent(new CustomEvent("waffle-insert-request",{
        bubbles:true,cancelable:true,detail:{source:"hold",pointerType:"pen",world:[73,41],docId:AtriumNavHost.currentId()}
      }));
    });
    await box.fill("qfederation");
    const local = await labels.allTextContents();
    assert.equal(local.length,2);
    const hovered = dialog.getByRole("option").nth(1);
    await hovered.hover();
    await page.waitForFunction(() => document.querySelector("#palette input").getAttribute("aria-activedescendant") === document.querySelectorAll("#palette [role=option]")[1]?.id);
    const activeId = await box.getAttribute("aria-activedescendant");
    await page.waitForFunction(() => !!window.paletteFixture.started.qfederation);
    await page.evaluate(() => {
      const first = {key:"fixture:delayed",label:"Qfederation remote",source:"Supplier",kind:"command",run() {}};
      window.paletteFixture.started.qfederation.emit([first,first,{...first,key:"cmd:save",label:"Collision"}]);
    });
    await labels.filter({hasText:"Qfederation remote"}).waitFor();
    assert.deepEqual(await labels.allTextContents(),[...local,"Qfederation remote"]);
    assert.equal(await box.getAttribute("aria-activedescendant"),activeId);
    await box.fill("qreplacement");
    assert.equal(await page.evaluate(() => window.paletteFixture.started.qfederation.signal.aborted),true);
    await page.evaluate(() => window.paletteFixture.started.qfederation.emit([{key:"fixture:late",label:"Expired result",run() {}}]));
    await page.waitForFunction(() => !!window.paletteFixture.started.qreplacement);
    assert.equal(await labels.filter({hasText:"Expired result"}).count(),0);
    await box.fill("qfederation");
    await box.press("Enter");
    await page.waitForFunction(() => !!window.paletteFixture.ran);
    assert.deepEqual(await page.evaluate(() => window.paletteFixture.ran),{point:[73,41],pointerType:"pen"});
    assert.equal(await page.evaluate(() => AtriumPalette.isOpen()),false);

    if (await page.evaluate(() => AtriumLazy.modules().includes("AtriumCalculations"))) {
      await page.locator('#document-tabs [data-kind="schematic"]').click();
      const revision = await page.evaluate(() => {
        const h = AtriumNavHost, part = h.doc().items.find(i => i.ref === "R1");
        h.select([part.id]); h.canvas().focus();
        Object.defineProperty(navigator,"clipboard",{configurable:true,value:{writeText:async value => {window.paletteFixture.copied = value;}}});
        return h.revision();
      });
      await canvas.press("/");
      for (const [source,display] of [["10k || 4.7k","3.197 k"],["10kΩ || 4.7kΩ","3.197 kΩ"],
        ["50 mil in mm","1.27 mm"],["R1.Value · 2","20 kΩ"],["3.3V/10mA","330 Ω"]]) {
        await box.fill(source);
        await page.waitForFunction(text => document.querySelector("#palette .nav-palette-label")?.textContent === text,display);
      }
      await box.press("Control+k");
      const menu = dialog.getByRole("menu",{name:"Actions",exact:true});
      for (const name of ["Copy Result","Insert Calculation","Set Selected Part Value…"]) {
        await menu.getByRole("menuitem",{name,exact:true}).waitFor();
      }
      await page.keyboard.press("Escape");
      assert.equal(await page.evaluate(() => AtriumNavHost.revision()),revision);
      await box.press("Enter");
      assert.equal(await page.evaluate(() => window.paletteFixture.copied),"330 Ω");
      await page.evaluate(() => {
        const h = AtriumNavHost;
        h.canvas().dispatchEvent(new CustomEvent("waffle-insert-request",{bubbles:true,cancelable:true,
          detail:{source:"hold",pointerType:"touch",world:[73,41],docId:h.currentId()}}));
      });
      await box.fill("50 mil in mm");
      await page.waitForFunction(() => document.querySelector("#palette .nav-palette-label")?.textContent === "1.27 mm");
      await box.press("Alt+Enter");
      await page.waitForFunction(() => AtriumNavHost.doc().items.some(i => i.calculation && i.text === "50 mil in mm"));
      const at = await page.evaluate(() => {const i=AtriumNavHost.doc().items.find(i => i.calculation);return [i.x,i.y];});
      assert.deepEqual(at,[73,41]);
      await page.evaluate(() => AtriumNavHost.act("undo"));
      assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.some(i => i.calculation)),false);
      const saved = await page.evaluate(() => {
        const h = AtriumNavHost, part = h.doc().items.find(i => i.ref === "R1");
        h.select([part.id]); h.canvas().focus(); return part.value;
      });
      await canvas.press("/");
      await box.fill("3.37V/10mA");
      await page.waitForFunction(() => document.querySelector("#palette .nav-palette-label")?.textContent === "337 Ω");
      await box.press("Shift+Enter");
      const review = page.getByRole("dialog",{name:"Apply calculation to R1"});
      await review.getByLabel("Preferred value").selectOption("E24");
      await review.getByText("E24 preferred value").waitFor();
      await review.getByRole("button",{name:"Apply value",exact:true}).click();
      assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.find(i => i.ref === "R1").value),"330 Ω");
      await page.evaluate(() => AtriumNavHost.act("undo"));
      assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.find(i => i.ref === "R1").value),saved);
      if (await page.evaluate(() => AtriumLazy.modules().includes("AtriumConnectionPreview"))) await repeatedSheet(page,box);
    }
    assert.deepEqual(errors,[]);
  } finally {paletteModule.resolve(); paletteView.resolve(); await page.close(); await server.close();}
  console.log("PASS cold palette input, shared entrances, stable sources, pointer placement and available calculation actions");
};


// Reused sheet definitions share document and item IDs. The opened occurrence supplies
// the missing binding identity and changes independently of selection or project revision.
async function repeatedSheet(page,box) {
  const fixture = await page.evaluate(async () => {
    const h = AtriumNavHost, project = AtriumParts.example(), top = project.documents.find(d => d.kind === "schematic");
    const child = Atrium.sheet("schematic","Amplifier channel"), def = project.library.find(d => d.id === "std-r");
    top.items.push(AtriumSchObjects.make("sheetsymbol",[90,60],{sheet:child.id,name:"Repeat(AMP,1,2)"}));
    const part = Atrium.instantiate(project,def,[20,20]);
    part.ref = "R99"; part.value = "2k"; child.items.push(part); project.documents.push(child);
    await h.replaceProject(project,{force:true,copy:true,dirty:false});
    h.selectDocument(child.id); h.select([part.id]);
    await AtriumLazy.need(["AtriumConnectionPreview","AtriumMultichannel"]);
    const instances = AtriumHierarchy.instances(h.project()).instances.filter(i => i.doc.id === child.id).map(i => i.id);
    AtriumConnectionPreview.activateInstance(child.id,instances[1]); h.canvas().focus();
    return {docId:child.id,topId:top.id,instances};
  });
  assert.equal(fixture.instances.length,2);
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => AtriumPalette.context().instanceId),fixture.instances[1]);
  await box.fill("R99.Value * 2");
  await page.waitForFunction(() => document.querySelector("#palette .nav-palette-label")?.textContent === "4 kΩ");
  await page.evaluate(f => AtriumConnectionPreview.activateInstance(f.docId,f.instances[0]),fixture);
  await box.press("Alt+Enter");
  assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.some(i => i.calculation)),false);
  await page.waitForFunction(id => AtriumPalette.context()?.instanceId === id &&
    document.querySelector("#palette .nav-palette-label")?.textContent === "4 kΩ",fixture.instances[0]);
  await box.press("Alt+Enter");
  await page.waitForFunction(() => AtriumNavHost.doc().items.some(i => i.calculation));
  const bound = await page.evaluate(() => AtriumNavHost.doc().items.find(i => i.calculation).calculation.bindings[0].target.instanceId);
  assert.equal(bound,fixture.instances[0]);
  await page.evaluate(f => {
    const h = AtriumNavHost; h.act("undo"); h.selectDocument(f.topId);
    AtriumConnectionPreview.activateInstance(f.docId,f.instances[1]); h.canvas().focus();
  },fixture);
  await page.keyboard.press("/");
  assert.equal(await page.evaluate(() => AtriumPalette.context().instanceId),undefined);
  await box.press("Escape");
}
