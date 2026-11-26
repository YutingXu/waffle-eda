"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function frameMonitor(browser, screenshot) {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  const errors = [], requests = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (request.url().endsWith("/frame-monitor.js")) requests.push(request.url()); });
  page.setDefaultTimeout(6000);
  try {
    await page.clock.install();
    // Measure the sampler before AtriumIdle wraps the clock. Canvas draws are
    // counted separately by observing the editor's real view rather than the HUD.
    await page.addInitScript(() => {
      const raf = window.requestAnimationFrame.bind(window), caf = window.cancelAnimationFrame.bind(window);
      const pending = new Set(), work = {callbacks: 0, draws: 0, journalMarks: 0, pending};
      window.__frameMonitorWork = work;
      let undoStore;
      Object.defineProperty(window, "AtriumUndoStore", {
        configurable: true,
        get: () => undoStore,
        set(store) {
          undoStore = Object.freeze({...store, mark(...args) {
            work.journalMarks++;
            return store.mark(...args);
          }});
        }
      });
      window.requestAnimationFrame = callback => {
        const monitor = new Error().stack.includes("frame-monitor.js");
        const id = raf(stamp => {
          if (monitor) { pending.delete(id); work.callbacks++; }
          callback(stamp);
        });
        if (monitor) pending.add(id);
        return id;
      };
      window.cancelAnimationFrame = id => { pending.delete(id); caf(id); };
    });
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
    const work = () => page.evaluate(() => {
      const {callbacks, draws, pending} = window.__frameMonitorWork;
      return {callbacks, draws, pending: pending.size, traced: Boolean(globalThis.__waffleFrameTrace)};
    });
    await page.evaluate(() => {
      const view = AtriumNavHost.view(), render = view.render;
      view.render = (...args) => { window.__frameMonitorWork.draws++; return render(...args); };
    });
    const {callbacks, pending, traced} = await work();
    assert.deepEqual({callbacks, pending, traced}, {callbacks: 0, pending: 0, traced: false});
    assert.equal(await page.evaluate(() => AtriumDiagnostics.performance), null, "starting the editor does not start a performance capture");

    const toggle = page.locator('[data-action="frame-monitor"]');
    const hud = page.locator("#frame-monitor");
    const openMenu = async () => {
      await page.locator('[data-menu="help"] > summary').press("Enter");
      await page.locator("#sub-help-troubleshooting > button").press("ArrowRight");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("ArrowDown");
      assert.equal(await toggle.evaluate(node => node === document.activeElement), true, "keyboard can reach the Help submenu toggle");
    };
    await page.evaluate(() => AtriumLazy.need("AtriumUndoStore").then(() => undefined));
    // Opening the demo initializes its Undo shadow on idle and advances the library version.
    await page.waitForFunction(() => AtriumUndoStore.stats().shadow > 0);
    assert.deepEqual(requests, [], "the monitor stays cold during ordinary startup");
    assert.equal(await page.evaluate(() => !!globalThis.AtriumPerformanceDiagnostics), false, "the recorder also stays cold");
    await openMenu();
    const editState = () => page.evaluate(() => {
      const {history, future} = AtriumNavHost.undoSteps();
      return {marks: window.__frameMonitorWork.journalMarks, version: AtriumUndoStore.libraryVersion(),
        undo: history.length, redo: future.length, revision: AtriumNavHost.revision(), dirty: AtriumNavHost.isDirty()};
    });
    const beforeOpen = await editState();
    await page.keyboard.press("Enter");
    await hud.waitFor();
    assert.deepEqual(await editState(), beforeOpen, "opening the Frame Monitor leaves the edit journal untouched");
    assert.equal(await page.evaluate(() => AtriumDiagnostics.performanceSnapshot().recording), true);
    assert.equal(await toggle.getAttribute("aria-checked"), "true");
    assert.equal(await hud.getByRole("button", {name: "Close", exact: true}).evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator("dialog:modal").count(), 0, "the canvas stays usable");
    assert.equal(requests.length, 1);
    // Initial board follow-up tasks can wake the monitor again. Let those
    // finish and check a quiet spell after both the HUD and editor have parked.
    let parked;
    for (let attempt = 0; attempt < 4; attempt++) {
      await page.waitForFunction(() => document.querySelector("#frame-monitor").dataset.state === "idle");
      parked = await work();
      await page.clock.runFor(350);
      const after = await work();
      if (after.callbacks === parked.callbacks && after.draws === parked.draws) break;
      parked = null;
    }
    assert.ok(parked?.callbacks > 0, "a parked monitor schedules no callbacks and causes zero draws");
    assert.equal(parked.pending, 0);

    // A completed background operation appears through a shared QA lease while the clock is parked.
    const parkedFrame = await page.evaluate(() => {
      const D = AtriumDiagnostics;
      const probe = window.__frameMonitorWork;
      probe.qa = D.startPerformance();
      probe.span = D.performance.queue("routing", "compute");
      return D.performanceSnapshot().frame;
    });
    assert.ok(Number.isFinite(parkedFrame?.callbackIntervalP95), "QA can read the monitor's frame cadence");
    await page.clock.runFor(130);
    await page.evaluate(() => window.__frameMonitorWork.span.start());
    await page.clock.runFor(60);
    await page.evaluate(() => window.__frameMonitorWork.span.end());
    const operation = hud.locator(".ui-prop-row", {hasText: "Routing · Compute"});
    await operation.waitFor();
    const columns = await page.evaluate(() => {
      const row = AtriumDiagnostics.performanceSnapshot().rows.find(row => row.component === "routing" && row.operation === "compute");
      const format = new Intl.NumberFormat(AtriumI18n.locale(), {maximumFractionDigits: 1});
      return [row.queueP95, row.runP95, row.endToEndP95].map(value => format.format(value)).join(" / ");
    });
    await page.waitForFunction(expected => document.querySelector("#frame-monitor .ui-section")
      ?.textContent.includes(expected), columns);
    assert.equal(await operation.locator(".ui-prop-value").textContent(), columns);
    assert.equal(await hud.getAttribute("data-state"), "idle", "operation updates preserve the legacy sampled frame window");
    assert.deepEqual(await page.evaluate(() => AtriumDiagnostics.performanceSnapshot().frame), parkedFrame,
      "a passive activity refresh does not add a frame sample");

    // Actual editor work wakes the monitor and updates its rows.
    const canvas = page.locator("#canvas"), box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .45);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(parked => {
      const row = [...document.querySelectorAll("#frame-monitor .ui-prop-row")].find(node => node.firstElementChild.textContent === "Canvas draw CPU");
      const {draws, callbacks} = window.__frameMonitorWork;
      return /ms p95/.test(row?.textContent) && draws > parked.draws && callbacks > parked.callbacks;
    }, parked);
    const samples = await page.evaluate(async () => {
      const recover = await AtriumLazy.need("AtriumRecover");
      const D = AtriumDiagnostics, exact = D.performanceSnapshot().frame;
      const shared = D.performanceSnapshot({shareable: true});
      const row = [...document.querySelectorAll("#frame-monitor .ui-prop-row")]
        .find(node => node.firstElementChild.textContent === "Canvas draw CPU");
      const format = new Intl.NumberFormat(AtriumI18n.locale(), {maximumFractionDigits: 1});
      const shown = row.lastElementChild.textContent;
      const report = JSON.parse(await recover.report()).performance;
      return {exact, shown, formatted: format.format(exact.drawCpuP95) + " ms p95", shared, report};
    });
    assert.ok(Number.isFinite(samples.exact.drawCpuP95));
    assert.equal(samples.shown, samples.formatted, "the Monitor and QA read the same draw measurement");
    assert.deepEqual(samples.report.activity, samples.shared, "the report contains the same shareable snapshot");
    assert.deepEqual([
      samples.report.canvasMainThreadP95, samples.report.controlWheelToDrawP95, samples.report.editCommitMainThreadP95,
      samples.report.editFollowUpMainThreadP95, samples.report.animationCallbackIntervalP95
    ], Object.values(samples.shared.frame), "the five legacy report aliases come from the shared frame");
    if (screenshot) await page.screenshot({path: screenshot});
    const previousFrame = await page.evaluate(() => {
      const frame = AtriumDiagnostics.performanceSnapshot().frame;
      AtriumPower.host({occluded: true});
      return frame;
    });
    await page.waitForFunction(() => document.querySelector("#frame-monitor").dataset.state === "paused");
    const hidden = await work();
    assert.equal(hidden.pending, 0);
    assert.equal(hidden.traced, false);
    await page.clock.runFor(300);
    assert.deepEqual(await work(), hidden, "a hidden window schedules no sampler callbacks or redraws");
    assert.deepEqual(await page.evaluate(() => AtriumDiagnostics.performanceSnapshot().frame), previousFrame,
      "hiding preserves the last sampled frame while QA is recording");

    const resumed = await page.evaluate(() => {
      AtriumPower.host({occluded: false});
      const D = AtriumDiagnostics, panel = document.querySelector("#frame-monitor");
      return {state: panel.dataset.state, exact: D.performanceSnapshot().frame,
        shared: D.performanceSnapshot({shareable: true}).frame};
    });
    assert.deepEqual(resumed, {state: "measuring", exact: undefined, shared: undefined},
      "a fresh visible sampling window must start without stale metrics in either projection");
    await page.mouse.wheel(0, 120);
    await page.waitForFunction(() => Number.isFinite(AtriumDiagnostics.performanceSnapshot().frame?.drawCpuP95));
    await hud.getByRole("button", {name: "Close", exact: true}).press("Escape");
    await hud.waitFor({state: "detached"});
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    const closed = await work();
    assert.equal(closed.pending, 0);
    assert.equal(closed.traced, false);
    const afterClose = await page.evaluate(() => {
      const D = AtriumDiagnostics, retained = D.performanceSnapshot();
      D.performance.begin("routing", "compute").end();
      window.__frameMonitorWork.qa.stop();
      const stopped = D.performance === null, keptFrame = D.performanceSnapshot().frame;
      const next = D.startPerformance(), nextFrame = D.performanceSnapshot().frame;
      next.stop();
      return {recording: retained.recording, retainedFrame: retained.frame, keptFrame, nextFrame, stopped,
        completed: retained.rows.find(row => row.component === "routing" && row.operation === "compute")?.counts.completed};
    });
    assert.equal(afterClose.recording, true, "closing releases only the monitor lease");
    assert.equal(afterClose.stopped, true);
    assert.equal(afterClose.completed, 1);
    assert.ok(Number.isFinite(afterClose.retainedFrame?.callbackIntervalP95) || Number.isFinite(afterClose.retainedFrame?.drawCpuP95));
    assert.deepEqual(afterClose.keptFrame, afterClose.retainedFrame, "stopping preserves the last sampled frame");
    assert.equal(afterClose.nextFrame, undefined, "a new capture starts without an earlier frame sample");
    await page.clock.runFor(100);
    const quiet = await work();
    assert.equal(quiet.callbacks, closed.callbacks, "an independent capture cannot wake a closed monitor");
    assert.equal(quiet.pending, 0);

    const beforeToggle = await editState();
    await openMenu();
    await page.keyboard.press("Enter");
    await hud.waitFor();
    await openMenu();
    await page.keyboard.press("Enter");
    await hud.waitFor({state: "detached"});
    assert.deepEqual(await editState(), beforeToggle, "reopening and closing the monitor preserve the edit journal");
    assert.equal(requests.length, 1, "reopening reuses the lazily loaded monitor");

    await page.evaluate(() => AtriumI18n.setLocale("en-XA"));
    await openMenu();
    assert.notEqual(await toggle.textContent(), "Frame Monitor", "the Help command is translated");
    await page.keyboard.press("Enter");
    await hud.waitFor();
    assert.notEqual(await hud.locator("h2").textContent(), "Frame Monitor", "the HUD is translated");
    assert.notEqual(await hud.locator(".ui-prop-row").first().locator("span").first().textContent(), "Callback rate");
    await hud.getByRole("button").press("Escape");
    await hud.waitFor({state: "detached"});
    const rollback = await page.evaluate(() => {
      const host = AtriumNavHost, title = host.doc().name;
      const failure = new Error("rollback witness");
      host.registerAction("frame-monitor-test-edit", () => {
        host.doc().name = "Partial board edit";
        throw failure;
      });
      try { host.act("frame-monitor-test-edit"); }
      catch (error) { if (error === failure) return host.doc().name === title; throw error; }
      return false;
    });
    assert.ok(rollback, "editor commands still roll back a failed board edit");
    assert.deepEqual(errors, []);
    console.log("PASS browser frame monitor keyboard menu, opt-in clock, actual draws, hidden and idle suspension, close and reopen");
  } catch (error) {
    if (errors.length) throw new Error(errors.join("\n"), {cause: error});
    throw error;
  } finally {
    await page.close();
  }
};
