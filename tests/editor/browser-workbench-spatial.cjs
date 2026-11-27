"use strict";
let chromium;
try { ({chromium} = require("playwright-core")); }
catch { console.log("SKIP workbench spatial motion: Playwright Core is unavailable."); process.exit(0); }
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const efficiencyOff = require("../support/efficiency-off.cjs");
(async () => {
  const executablePath = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  const browser = await chromium.launch({headless:true, executablePath});
  const page = await browser.newPage({viewport:{width:1400,height:900}});
  await efficiencyOff(page);
  const errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(7000);
  try {
    await page.goto(pathToFileURL(path.resolve(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name",{hasText:"Sensor board"}).waitFor();
    await page.evaluate(async () => {
      await AtriumLazy.need(["AtriumSpatialMotion", "AtriumMessages", "AtriumDocTabs", "AtriumProjectTree"]);
      window.motionCalls = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function(frames, options) {
        motionCalls.push({key:this.dataset.tab || this.dataset.motionKey || this.dataset.doc || "",
          projectRow:this.classList.contains("doc-row"), ghost:this.classList.contains("ui-spatial-ghost"),
          ms:options.duration,delay:options.delay ?? 0,easing:options.easing,frames});
        return animate.call(this,frames,options);
      };
    });
    const strip = page.locator("#document-tabs");
    await strip.hover();
    const tabs = strip.locator(":scope>.document-tab[data-tab]:visible");
    const ids = await tabs.evaluateAll(all => all.map(t => t.dataset.tab));
    assert.ok(ids.length >= 2, JSON.stringify(ids));
    const get = () => tabs.evaluateAll(all => all.map(t => t.dataset.tab));
    const first = tabs.nth(0), second = tabs.nth(1), x2 = (await second.boundingBox()).width - 5;
    // A trusted drop can run microtasks between capture and the strip handler.
    await first.dragTo(second, {targetPosition:{x:x2,y:10}});
    assert.deepEqual((await get()).slice(0,2), [ids[1],ids[0]], "trusted drop reordered tabs");
    const trace = await page.evaluate(() => motionCalls.splice(0));
    assert.ok(trace.some(r => r.key === ids[0] && r.ms === 120), JSON.stringify(trace));
    assert.ok(trace.some(r => r.key === ids[1] && r.ms === 180), JSON.stringify(trace));
    await tabs.nth(0).click();
    await tabs.nth(1).click();
    assert.deepEqual((await get()).slice(0,2), [ids[1],ids[0]], "reorder survives document switch");
    await page.evaluate(() => { motionCalls.length=0; });
    await tabs.nth(1).press("ArrowLeft");
    assert.equal(await page.evaluate(() => document.activeElement.dataset.tab), ids[1]);
    const keyboardTrace = await page.evaluate(() => motionCalls.splice(0));
    assert.equal(keyboardTrace.filter(r => r.key).length,0);
    await tabs.nth(1).click();
    const cancellation = await page.evaluate(() => {
      const strip = document.getElementById("document-tabs"), [source,target] = strip.querySelectorAll(":scope>.document-tab[data-tab]");
      const id = source.dataset.tab, dt = new DataTransfer();
      const send = (node,type,options = {}) => node.dispatchEvent(new DragEvent(type,{bubbles:true,cancelable:true,dataTransfer:dt,...options}));
      send(source,"dragstart");
      const after = target.getBoundingClientRect();
      send(target,"dragover",{clientX:after.right - 4,clientY:after.top + 8});
      const moved = strip.querySelector(":scope>.document-tab[data-tab]").dataset.tab !== id;
      send(source,"dragend");
      const restored = strip.querySelector(":scope>.document-tab[data-tab]").dataset.tab === id;
      return {moved,restored,spring:motionCalls.some(r => r.ms === 200),ring:getComputedStyle(strip,"::after").transitionDuration};
    });
    assert.deepEqual(cancellation,{moved:true,restored:true,spring:true,ring:"0.1s"});
    await tabs.nth(0).click();
    await page.evaluate(() => { motionCalls.length = 0; });
    const closeShortcut = await page.evaluate(() => /Mac/.test(navigator.platform) ? "Meta+F4" : "Control+F4");
    await page.keyboard.press(closeShortcut);
    const closedTab = strip.locator(`[data-tab="${ids[1]}"]:visible`);
    await closedTab.waitFor({state:"hidden"});
    assert.equal(await page.evaluate(() => motionCalls.filter(r => r.key || r.ghost).length),0,
      "keyboard close changes the tab strip without motion");

    await tabs.nth(0).click();
    await page.evaluate(id => AtriumVSKeys.show(id),ids[1]);
    await page.waitForFunction(id => getComputedStyle(document.querySelector(`#document-tabs>[data-tab="${id}"]`)).opacity === "1",ids[1]);
    const remove = await page.evaluate(async id => {
      motionCalls.length = 0;
      const changed = await AtriumDocTabs.run(AtriumNavHost,"close",{id,pane:null});
      const ghost = document.querySelector(`body>.ui-spatial-ghost[data-tab="${id}"][inert][aria-hidden=true]`);
      if (!ghost) return {changed,trace:motionCalls};
      ghost.getAnimations()[0].currentTime = 60;
      const before = Number(getComputedStyle(ghost).opacity);
      AtriumVSKeys.show(id);
      const reopen = motionCalls.find(r => r.key === id && !r.ghost && r.ms === 150);
      return {changed,trace:motionCalls,before,after:Number(reopen?.frames[0].opacity),removed:!ghost.isConnected};
    },ids[1]);
    assert.equal(remove.changed,true);
    assert.ok(remove.removed && remove.trace.some(r => r.ghost && r.ms === 150),JSON.stringify(remove));
    assert.ok(remove.before > 0 && remove.before < 1 && Math.abs(remove.before - remove.after) < .002,JSON.stringify(remove));
    const added = await page.evaluate(() => {
      const host = AtriumNavHost, doc = Atrium.sheet("drawing", "Spatial test drawing");
      motionCalls.length = 0;
      host.edit(() => host.project().documents.unshift(doc), "Add drawing");
      return {id:doc.id, trace:motionCalls.slice()};
    });
    assert.ok(added.trace.some(r => r.key === added.id && !r.projectRow && r.ms === 150), JSON.stringify(added));
    assert.ok(added.trace.some(r => r.key === added.id && r.projectRow && r.ms === 180), JSON.stringify(added));
    assert.ok(added.trace.some(r => r.key !== added.id && r.projectRow && r.ms === 180 && r.frames[0].transform), JSON.stringify(added));

    await page.evaluate(async id => {
      await AtriumLazy.need("AtriumSplitTabs");
      AtriumNavHost.openSplit("right",id);
    },ids[1]);
    const paneTabs = page.locator('.pane-tabs[data-pane="0"] > .pane-tab');
    await paneTabs.nth(1).waitFor();
    const paneOrder = await paneTabs.evaluateAll(all => all.map(t => t.dataset.tab));
    const paneEdge = (await paneTabs.nth(1).boundingBox()).width - 5;
    await paneTabs.nth(0).dragTo(paneTabs.nth(1), {targetPosition:{x:paneEdge,y:10}});
    const paneGroups = await page.evaluate(() => AtriumSplitTabs.groups);
    assert.deepEqual(paneGroups[0].slice(0,2), [paneOrder[1],paneOrder[0]], "trusted split drop saved the new tab order");
    await page.evaluate(() => AtriumNavHost.act("split-close"));

    const msg = name => ({class:"Warning",document:"Nested board",text:name});
    await page.evaluate(async entries => {
      AtriumMessages.show(null,{group:"Workbench test",messages:entries});
      AtriumMessages.show(null,{group:"Other test",messages:[{class:"Info",text:"Stable row"}]});
      // The table's sortable header (a narrow side dock shows Messages as a list, sorted from its ⋯ menu).
      (await AtriumLazy.need("AtriumDock")).moveTo("messages",{area:"bottom",mode:"end"});
      await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done)));
      motionCalls.length=0;
    },["Beta","Alpha"].map(msg));
    const sortMessages = page.locator(".msg-grid thead .msg-col-text > button");
    await sortMessages.click();
    const reordered = await page.evaluate(() => motionCalls.splice(0));
    const movedRows = reordered.filter(r => r.key.startsWith("entry-") && r.ms === 180 && r.frames[0].transform);
    assert.deepEqual(movedRows.map(r => r.delay),[0,30],JSON.stringify(reordered));
    assert.ok(movedRows.every(r => r.easing.replace(/\s/g,"") === "cubic-bezier(.23,1,.32,1)"),JSON.stringify(movedRows));
    assert.ok(reordered.every(r => r.ms + (r.delay || 0) < 300),JSON.stringify(reordered));
    const changed = await page.evaluate(entries => {
      const stable = [...document.querySelectorAll(".msg-grid tbody tr[data-motion-key]")]
        .find(row => row.textContent.includes("Beta")).dataset.motionKey;
      AtriumMessages.update("Workbench test",entries);
      const rows = [...document.querySelectorAll(".msg-grid table:not(.ui-spatial-ghost) tbody tr[data-motion-key]")];
      return {trace:motionCalls.splice(0), stable:rows.find(row => row.textContent.includes("Beta")).dataset.motionKey === stable};
    },["Beta","Gamma"].map(msg));
    assert.equal(changed.stable,true);
    assert.ok(changed.trace.some(r => r.ghost && r.ms === 180) && changed.trace.some(r => r.key && r.ms === 180),JSON.stringify(changed));
    const backgroundCalls = await page.evaluate(entry => {
      AtriumMessages.update("Workbench test",[entry],{animate:false});
      return motionCalls.filter(r => r.key || r.ghost).length;
    },msg("Live DRC update"));
    assert.equal(backgroundCalls,0);
    const filter = page.getByRole("searchbox",{name:"Filter messages"});
    await filter.fill("stable");
    assert.equal(await page.evaluate(() => motionCalls.filter(r => r.key || r.ghost).length),0);
    await filter.clear();
    await sortMessages.click();
    for (const mode of ["off","reduce"]) {
      if (mode === "reduce") await page.emulateMedia({reducedMotion:"reduce"});
      const reduced = await page.evaluate(mode => {
        if (mode === "off") document.documentElement.dataset.motion = mode;
        else delete document.documentElement.dataset.motion;
        const motion = AtriumSpatialMotion;
        const t = document.querySelector("#document-tabs>.document-tab[data-tab]:not([hidden])");
        motionCalls.length=0;
        motion.lift(t);
        AtriumMessages.update("Other test", [{class:"Info",text:mode}]);
        return {enabled:AtriumMotionUI.enabled(),moves:AtriumMotionUI.moves(),
          calls:motionCalls.filter(r => r.key || r.ghost).map(r => r.frames),
          lift:t.classList.contains("ui-drag-lift")};
      },mode);
      assert.equal(reduced.lift,false);
      assert.equal(reduced.moves,false);
      assert.equal(reduced.enabled,mode === "reduce");
      if (mode === "off") assert.deepEqual(reduced.calls,[]);
      else {
        assert.ok(reduced.calls.length > 0);
        assert.ok(reduced.calls.flat().every(frame => !("transform" in frame)));
      }
    }
    assert.deepEqual(errors,[]);
    console.log("PASS workbench spatial motion: trusted drag, tab enter/exit, project tree, virtual lists, typing/arrow, and Off/reduced.");
  } finally { await browser.close(); }
})().catch(e => {console.error(e); process.exitCode=1;});
