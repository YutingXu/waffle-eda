"use strict";
const assert=require("node:assert/strict"), path=require("node:path");
const {pathToFileURL}=require("node:url");

function projectState(page) {
  return page.evaluate(() => {
    const host = AtriumNavHost, {history, future} = host.undoSteps();
    return {
      project: JSON.stringify(host.project()),
      revision: host.revision(),
      dirty: host.isDirty(),
      undo: history.length,
      redo: future.length,
    };
  });
}

// The stock demo exercises a real first Filter request, real typed field/layer providers,
// and a deliberate Rule Manager edit. It never opens or writes a user's project.
module.exports=async function queryFilter(browser) {
  const page=await browser.newPage(), errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  try {
    await page.clock.install();
    await page.goto(pathToFileURL(path.resolve(__dirname,"../../app/index.html")).href);
    assert.deepEqual(await page.evaluate(()=>[!!globalThis.AtriumQuery,!!globalThis.AtriumDesignQuery,!!globalThis.AtriumDFA]),[false,false,false]);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    // The starter also has two documents. Demo adoption waits for the PCB renderer.
    await page.waitForFunction(() => globalThis.AtriumNavHost?.project()?.name === "Sensor interface" &&
      !document.querySelector("dialog.sp-dialog[open]"));
    await page.evaluate(()=>AtriumNavHost.selectDocument(AtriumNavHost.project().documents.find(d=>d.kind==="pcb").id));
    const before = await projectState(page);
    assert.equal(before.dirty, false);
    assert.deepEqual(await page.evaluate(()=>[!!globalThis.AtriumQuery,!!globalThis.AtriumDesignQuery]),[false,false]);
    await page.evaluate(()=>AtriumNavHost.act("query-panel"));
    const field=page.getByRole("textbox",{name:"Query expression"}), count=page.locator(".query-count");
    for(const [source,accepted] of [['part where designator = "j1"','part where designator = "J1"'],["IsComponent And Designator = 'j1'","IsComponent And Designator = 'J1'"]]){
      await field.fill(source);await field.press("Enter");
      const suggestion=page.getByRole("button",{name:"Use J1",exact:true});await suggestion.waitFor();
      assert.equal(await count.textContent(),"0 matched");
      // The previous delayed validation removed the button at 120 ms. Leave time for it
      // and for a first-use field-assistance module to mount before accepting the offer.
      await page.clock.runFor(300);assert.equal(await field.inputValue(),source);assert.ok(await suggestion.isVisible());
      await suggestion.click();assert.equal(await field.inputValue(),accepted);
      await field.press("Enter");await page.waitForFunction(()=>document.querySelector(".query-count").textContent==="1 matched");
      assert.equal(await suggestion.count(),0);
      assert.deepEqual(await projectState(page), before, `Filter changed the project or edit history for ${source}`);
    }
    await field.fill("pad near origin of U1 within 10 mm");await field.press("Enter");
    await page.waitForFunction(()=>document.querySelector(".query-count").textContent==="13 matched · 4 unavailable");
    assert.match(await page.locator(".query-error").textContent(),/physical geometry is unavailable/);
    assert.equal(await page.evaluate(()=>!!globalThis.AtriumDFA),true);
    assert.deepEqual(await projectState(page), before, "Geometry filter changed the project or edit history");
    await field.fill('net where name = "GND"');await field.press("Enter");
    await page.waitForFunction(()=>document.querySelector(".query-count").textContent==="1 matched");
    assert.equal(await page.evaluate(() => {
      const h=AtriumNavHost, ids=h.selection();
      return ids.length > 0 && ids.every(id=>h.doc().items.find(item=>item.id===id)?.net==="GND");
    }),true,"Filter selects the real design members of a typed net");

    await page.evaluate(()=>AtriumNavHost.act("rules"));
    const dialog=page.locator("dialog[open]").filter({has:page.locator(".rules-node")});
    await dialog.waitFor();
    const widthId = await page.evaluate(() => {
      const h = AtriumNavHost;
      return AtriumRules.effective(h.doc(), h.project()).list.find(rule => rule.type === "width").id;
    });
    await dialog.locator('[data-key="rule:' + widthId + '"]').click();
    await dialog.getByRole("combobox",{name:"Where the object matches: object kind"}).selectOption("query");
    const scopeInput=dialog.getByRole("textbox",{name:"Scope query"});
    const scopeSource="track near origin of U1 within 1 mm";
    await scopeInput.fill(scopeSource);
    await page.waitForFunction(source=>document.querySelector("dialog[open] .rules-query").textContent===source,scopeSource);
    await dialog.getByRole("button",{name:"Apply",exact:true}).click();
    const saved=await page.evaluate(()=>{
      const h=AtriumNavHost,d=h.doc(),r=AtriumRules.effective(d,h.project()).list.find(x=>x.type==="width");
      return {ruleId:r.id,scope:r.scope,docId:d.id,itemId:d.items.find(x=>x.ref==="U1").id};
    });
    assert.equal(saved.scope.source,scopeSource);assert.equal(saved.scope.bindings.length,1);
    const [bound]=saved.scope.bindings;
    assert.ok(bound.id);assert.equal(bound.name,"U1");
    assert.equal(scopeSource.slice(...bound.span),"U1");assert.equal(bound.target.docId,saved.docId);assert.equal(bound.target.itemId,saved.itemId);
    await scopeInput.fill("track near origin of MissingPart within 1 mm");
    await page.waitForFunction(()=>/Could not find|unavailable/i.test(document.querySelector("dialog[open] .rules-query-status").textContent));
    await dialog.getByRole("button",{name:"Apply",exact:true}).click();
    await dialog.getByRole("button",{name:"Close",exact:true}).click();
    assert.deepEqual(await page.evaluate(id=>AtriumRules.effective(AtriumNavHost.doc(),AtriumNavHost.project()).list.find(x=>x.id===id).scope,saved.ruleId),saved.scope);
    assert.deepEqual(errors,[]);console.log("PASS real Filter case choice after debounce, first-use pad geometry and Rule Manager stable scope binding");
  } finally {await page.close();}
};
