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

    // Actual editor work wakes the monitor and updates its rows.
    const canvas = page.locator("#canvas"), box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .45);
    await page.mouse.wheel(0, -120);
    await page.waitForFunction(parked => {
      const row = [...document.querySelectorAll("#frame-monitor .ui-prop-row")].find(node => node.firstElementChild.textContent === "Canvas draw CPU");
      const {draws, callbacks} = window.__frameMonitorWork;
      return /ms p95/.test(row?.textContent) && draws > parked.draws && callbacks > parked.callbacks;
    }, parked);
    if (screenshot) await page.screenshot({path: screenshot});
    await page.evaluate(() => AtriumPower.host({occluded: true}));
    await page.waitForFunction(() => document.querySelector("#frame-monitor").dataset.state === "paused");
    const hidden = await work();
    assert.equal(hidden.pending, 0);
    assert.equal(hidden.traced, false);
    await page.clock.runFor(300);
    assert.deepEqual(await work(), hidden, "a hidden window schedules no sampler callbacks or redraws");

    await page.evaluate(() => AtriumPower.host({occluded: false}));
    await page.waitForFunction(() => document.querySelector("#frame-monitor").dataset.state === "measuring");
    await hud.getByRole("button", {name: "Close", exact: true}).press("Escape");
    await hud.waitFor({state: "detached"});
    assert.equal(await toggle.getAttribute("aria-checked"), "false");
    const closed = await work();
    assert.equal(closed.pending, 0);
    assert.equal(closed.traced, false);

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
