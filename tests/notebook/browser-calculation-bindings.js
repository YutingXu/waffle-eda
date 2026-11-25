"use strict";
// Run with the normal Waffle browser build and the pinned Playwright Chromium.
const assert = require("node:assert/strict");
const {pathToFileURL} = require("node:url");
const path = require("node:path");

module.exports = async function calculationBindings(browser, {theme = "light", capture, appURL} = {}) {
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}, reducedMotion: "reduce"});
  const errors = [], loaded = [], workers = [];
  page.on("pageerror", e => errors.push(e.message));
  page.on("request", r => { if (/\/calculation[^/]*\.js$/.test(r.url())) loaded.push(r.url()); });
  page.on("worker", w => workers.push(w.url()));
  page.setDefaultTimeout(12000);
  try {
    await page.addInitScript(theme => {
      globalThis.ATRIUM_UNDO_VERIFY = "throw";
      localStorage.setItem("atrium.prefs", JSON.stringify({format:"atrium-prefs",version:1,values:{
        "appearance.theme":theme,"appearance.animations":"off","general.startPage":"always"
      }}));
    }, theme);
    await page.goto(appURL || pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !!globalThis.AtriumNavHost?.doc());
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.deepEqual(loaded, [], "the normal non-calculation workspace never requests a calculation script");
    assert.equal(await page.evaluate(() => !!globalThis.AtriumCalculationCore || !!globalThis.AtriumCalculations), false);
    await page.evaluate(async () => {
      const erc = await AtriumLazy.need("AtriumERC"), p = Atrium.project("Formula annotation");
      p.documents[0].items.push({kind:"textframe", id:"formula", x:10, y:10, w:50, h:20, text:"2 V + 2 V",
        calculation:{languageVersion:1, bindings:[], assertions:[]}});
      if (!erc.run(p).passed) throw Error("A plain formula changed the electrical check.");
    });
    assert.deepEqual(loaded, [], "ordinary ERC with a plain formula does not load the calculator");
    const idleWorkers = workers.length;

    const pointer = await page.evaluate(async theme => {
      const h = AtriumNavHost;
      await AtriumLazy.need(["AtriumCalculations","AtriumRules","AtriumERC","AtriumCalculationSheet"]);
      AtriumTheme.setPreset(theme);
      const p = Atrium.project("Calculation assertion review", []), [logic] = p.documents;
      const power = {...logic, id:"power", name:"Power supply", items:[]};
      logic.name = "Logic control";
      p.documents.push(power);
      for (let i = 0; i < 50; i++) {
        const sheet = i < 30 ? logic : power, m = i === 0 ? "assert 3.36 V ± .02 V = 3.3 V ± 2%" : "assert 2 V < 3 V";
        sheet.items.push(AtriumCalculationRecords.backing({id:"review-" + i, x:40, y:i ? 200 + 20 * i : 40, source:i ? "2 V" : "3.36 V",
          assertions:[{id:"review-rule-" + i,source:m,bindings:[]}]}));
      }
      AtriumCalculations.syncRules(p);
      assertNoWorkerYet();
      await h.replaceProject(p, {force:true,dirty:false});
      h.selectDocument(logic.id);
      return {doc:logic.id, clause:logic.items[0].calculation.assertions[0].id};
      function assertNoWorkerYet() {
        if (AtriumCalculations.stats().started !== 0) throw Error("Loading the calculation modules started an idle worker.");
      }
    }, theme);
    await page.evaluate(async () => {
      const h = AtriumNavHost;
      await AtriumERC.compile({currentProject:h.project,doc:h.doc(),info:h.info,edit:h.edit});
    });
    const panel = page.locator(".msg-panel:visible");
    const possible = panel.getByText(/May violate\. Measured/);
    await possible.waitFor();
    assert.equal(await possible.count(), 1);
    const original = await page.evaluate(() => AtriumChecks.violations({}).find(v => v.check === "schematic.calculationAssertion"));
    assert.equal(original.origin.object, "review-0");
    assert.equal(original.origin.assertion, pointer.clause);
    assert.equal(original.detail.status, "may-violate");
    assert.deepEqual(original.detail.span, [0, "assert 3.36 V ± .02 V = 3.3 V ± 2%".length]);
    const beforePeer = await page.evaluate(() => AtriumCalculations.stats().jobs);
    await page.evaluate(async () => {
      const h = AtriumNavHost, ours = Atrium.clone(h.project()), theirs = Atrium.clone(ours);
      theirs.documents[0].items.find(i => i.id === "review-0").calculation.assertions[0].source = "assert 3.3 V = 3.3 V ± 2%";
      const merge = await AtriumLazy.need("AtriumMergeUI");
      merge.open(h, {base:ours, ours, theirs});
    });
    const merge = page.getByRole("dialog", {name:"Resolve merge conflicts"});
    await merge.getByRole("status").getByText(/ERC errors 0 \(-1 vs ours\)/).waitFor();
    assert.ok(await page.evaluate(() => AtriumCalculations.stats().jobs) >= beforePeer + 2);
    await merge.getByRole("button", {name:"Cancel", exact:true}).click();
    await possible.click();
    assert.equal(await page.evaluate(() => AtriumNavHost.selection().includes("review-0")), true);
    if (capture) await capture(page, "problem");

    await page.evaluate(() => AtriumNavHost.act("rules"));
    const rules = page.getByRole("dialog", {name:"Rules and Constraints Editor"});
    await rules.getByRole("treeitem", {name:/Calculations 50/}).click();
    await rules.getByLabel("Resistors (%)", {exact:true}).waitFor();
    const logic = rules.getByRole("treeitem", {name:/Logic control 30/});
    const supply = rules.getByRole("treeitem", {name:/Power supply 20/});
    assert.equal(await logic.count(), 1);
    assert.equal(await supply.count(), 1);
    assert.equal(await rules.getByRole("button", {name:"Edit predicate…", exact:true}).filter({visible:true}).count(), 0);
    await rules.getByLabel("Resistors (%)", {exact:true}).fill("1");
    await rules.getByRole("button", {name:"Apply", exact:true}).click();
    await page.waitForFunction(() => AtriumNavHost.project().rules.calculationTolerances?.resistor === .01);
    if (capture) await capture(page, "rules");
    await logic.click();
    assert.equal(await rules.getByRole("button", {name:"Edit predicate…", exact:true}).count(), 30);
    await rules.getByRole("button", {name:"Close", exact:true}).click();
    await page.evaluate(() => AtriumNavHost.act("undo"));
    await page.waitForFunction(() => AtriumNavHost.project().rules.calculationTolerances == null);

    const perf = await page.evaluate(async () => {
      const h = AtriumNavHost, C = AtriumCalculations, R = AtriumCalculationRecords;
      const def = {id:"r",name:"Resistor",category:"Resistors",prefix:"R",symbol:{shapes:[],pins:[]}};
      const p = Atrium.project("Calculation worker bench", [def]), [a,pcb] = p.documents;
      const b = {...a,id:"cross",name:"Other sheet",items:[]};
      p.documents.push(b);
      const r={id:"sensitivity",kind:"part",def:"r",ref:"R5",value:"10k",x:4,y:4};
      a.items.push(r);
      const ref = (name, span, docId, itemId, field) => [{id:"binding-"+itemId,name,span,target:{scope:"item",docId,itemId,field}}];
      a.items.push(R.backing({id:"leader",x:25,y:10,source:"LEADER = R5 + 0Ω",bindings:ref("R5",[9,11],a.id,r.id,"value")}));
      b.items.push(R.backing({id:"follower",x:30,y:10,source:"LEADER + 1Ω",bindings:ref("LEADER",[0,6],a.id,"leader","result"),
        assertions:[{id:"clause",source:"assert LEADER > 1kΩ",bindings:ref("LEADER",[7,13],a.id,"leader","result")}]}));
      for (let i = 0; i < 497; i++) (i % 2 ? a : b).items.push(R.backing({id:"node-"+i,x:100,y:20*i,source:"2+2"}));
      C.syncRules(p);
      await h.replaceProject(p,{force:true,dirty:false}); h.selectDocument(pcb.id);
      const read = () => C.evaluate(p,{host:h,revision:h.revision()});
      const first = await read();
      const quietFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
      await quietFrame();
      const frameTimes = [];
      let measure = true;
      const frame = t => { frameTimes.push(t); if (measure) requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      const start = performance.now();
      h.edit(() => {r.value = "5k";},"Change bound resistor",[{doc:a,items:[r]}]);
      const afterEdit=performance.now(), pending=read();
      const submitMs=performance.now()-afterEdit;
      const next = await pending, workerMs=performance.now()-afterEdit;
      await quietFrame(); await quietFrame(); measure=false;
      const restored = C.evaluateSnapshot(p);
      const equivalent = JSON.stringify(next.records) === JSON.stringify(restored.records);
      const answer = C.answer({queryId:77,text:"R5 + 0Ω",documentId:pcb.id,projectRevision:h.revision()},{host:h});
      h.act("undo");
      let cancelled=false;
      try { await answer; } catch(e) { cancelled=e.name==="AbortError"; }
      const undone = await read();
      return {cold:first.stats,incremental:next.stats,submitMs,workerMs,editMs:afterEdit-start,
        frames:frameTimes.slice(1).map((t,i)=>t-frameTimes[i]),equivalent,cancelled,
        follower:next.records.find(r=>r.blockId==="follower").result.value,
        restored:undone.records.find(r=>r.blockId==="follower").result.value,worker:C.stats()};
    });
    assert.equal(perf.cold.visited, 500);
    assert.equal(perf.incremental.visited, 3);
    assert.equal(perf.incremental.reads - perf.cold.reads, 1);
    assert.equal(perf.follower, 5001);
    assert.equal(perf.restored, 10001);
    assert.ok(perf.equivalent && perf.cancelled);
    assert.ok(workers.length > idleWorkers && perf.worker.local === 0);
    assert.deepEqual(errors, []);
    console.log("calculation browser " + theme + " " + JSON.stringify(perf));
    return perf;
  } finally { await page.close(); }
};
