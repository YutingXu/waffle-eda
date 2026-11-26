"use strict";

// Crash safety in a real browser: a command that throws halfway leaves no half-applied change and no
// undo step; an uncaught error in Waffle's own code is logged without project data and told once in
// the status bar (no dialog); Help › Crash Diagnostics shows a report that can be copied or saved;
// a hung pool worker is stopped and the editor stays responsive.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function crashSafety(browser) {
  const page = await browser.newPage({viewport: {width: 1280, height: 860}}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
    await page.addInitScript(() => {
      let undo;
      const traffic = window.__diagnosticUndoTraffic = {marks: 0, commands: 0};
      Object.defineProperty(window, "AtriumUndoStore", {
        configurable: true,
        get: () => undo,
        set(store) {
          undo = Object.freeze({...store,
            mark(...args) { traffic.marks++; return store.mark(...args); },
            action(...args) { traffic.commands++; return store.action(...args); }});
        }
      });
    });
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !!globalThis.AtriumNavHost && !!globalThis.AtriumUndoStore && AtriumNavHost.doc().kind === "pcb");

    await page.evaluate(() => { const H = AtriumNavHost, o = H.info; window.__infos = []; H.info = m => { window.__infos.push(String(m)); return o.call(H, m); }; });
    // 1. A command that mutates the design in place and then throws is rolled back.
    const rolled = await page.evaluate(() => {
      const H = AtriumNavHost, before = JSON.stringify(H.project()), steps = H.undoSteps().history.length;
      H.registerAction("test-half-applied", () => {
        const part = H.doc().items.find(i => i.kind === "part");
        part.x += 25; part.ref = "HALF";
        H.doc().items.push({id: "half-track", kind: "track", layer: "Top", width: .3, net: "", points: [[0, 0], [9, 9]]});
        throw new TypeError("command failed halfway");
      });
      let threw = false;
      try { H.act("test-half-applied"); } catch { threw = true; }
      return {threw, same: JSON.stringify(H.project()) === before, steps: H.undoSteps().history.length - steps,
        half: H.doc().items.some(i => i.id === "half-track" || i.ref === "HALF")};
    });
    assert.deepEqual(rolled, {threw: true, same: true, steps: 0, half: false}, "a failing command rolls back what it changed in place");
    // A failing edit() inside a command rolls back too, and later edits still record undo steps.
    const after = await page.evaluate(() => {
      const H = AtriumNavHost, before = JSON.stringify(H.project());
      try { H.edit(() => { H.doc().items.find(i => i.kind === "part").x += 3; throw new RangeError("index was outside the bounds of the array"); }); } catch { /* expected */ }
      const same = JSON.stringify(H.project()) === before, n = H.undoSteps().history.length;
      H.edit(() => { H.doc().items.find(i => i.kind === "part").x += 1; });
      return {same, recorded: H.undoSteps().history.length === n + 1};
    });
    assert.deepEqual(after, {same: true, recorded: true}, "a failed edit leaves the design and the undo history usable");

    // Wait until both deliberate uncaught errors have reached Chromium.
    const reported = page.waitForEvent("pageerror", () => errors.filter(message => message === "Secret Project Name").length === 2);
    await page.evaluate(() => {
      const fail = () => AtriumNavHost.edit(() => { throw new TypeError("Secret Project Name"); });
      setTimeout(fail, 0); setTimeout(fail, 5);
    });
    await reported;
    const told = await page.evaluate(() => ({infos: window.__infos.filter(m => /Internal error/.test(m)), counts: AtriumDiagnostics.failures()}));
    assert.equal(told.infos.length, 1, "repeated failures are told once: " + JSON.stringify(told.infos));
    assert.match(told.infos[0], /Internal error\. See Help › Troubleshooting › Crash Diagnostics/);
    assert.equal(told.counts.javascriptErrors, 4, "two handled and two uncaught failures count once each");
    assert.ok(!JSON.stringify(told).includes("Secret"), "notice and counters contain no message");
    errors.length = 0; // the two deliberate uncaught errors

    const marker = "SYNTHETIC_PRIVATE_Q50";
    await page.evaluate(async secret => {
      await AtriumLazy.need("AtriumPerformanceDiagnostics");
      window.__diagnosticProbe = {native: 0, input: [], copies: [], exports: []};
      Object.defineProperty(navigator, "clipboard", {configurable: true, value: {
        writeText: async text => window.__diagnosticProbe.copies.push(text)
      }});
      const save = AtriumIO.exportFile;
      AtriumIO.exportFile = (name, text, options) => {
        window.__diagnosticProbe.exports.push({name, text, diagnostics: options?.diagnostics});
        return save(name, text, options);
      };
      window.AtriumHost = {
        supportDiagnostics: async () => {
          window.__diagnosticProbe.native++;
          return {platform: "macos", architecture: "arm64", displayCount: "two",
            rendererTerminations: {terminated: 1, address: secret}, path: "/Users/" + secret, date: 1795665432100};
        },
        inputDiagnostics: async operation => {
          window.__diagnosticProbe.input.push(operation);
          return {screens: [{name: secret}], rows: [{event: "NSTouch began", source: "touch (direct)",
            route: "touch scheme", count: 1, detail: secret}]};
        }
      };
      const D = AtriumDiagnostics, lease = D.startPerformance();
      if (D.performance.begin(secret, "retry") !== null) throw Error("Accepted a private operation component");
      const span = D.performance.begin("analysis", "retry", {note: secret});
      if (span.end(secret)) throw Error("Accepted a private operation outcome");
      span.end();
      lease.stop();
    }, marker);
    const openHelp = async action => {
      await page.locator('details[data-menu="help"] > summary').click();
      await page.locator("#sub-help-troubleshooting > button").press("ArrowRight");
      const traffic = await page.locator(`#sub-help-troubleshooting [data-action="${action}"]`).evaluate(button => {
        const counts = window.__diagnosticUndoTraffic, {marks, commands} = counts;
        button.click();
        return {marks: counts.marks - marks, commands: counts.commands - commands};
      });
      assert.deepEqual(traffic, {marks: 0, commands: 0}, action + " leaves Undo bookkeeping untouched");
    };
    // 3. Help › Troubleshooting › Crash Diagnostics: one exact preview, then explicit Copy and Save.
    await openHelp("crash-diagnostics");
    const dialog = page.locator("dialog.diagnostics-dialog[open]");
    await dialog.waitFor();
    await page.waitForFunction(() => /waffle-diagnostics/.test(document.querySelector("dialog.diagnostics-dialog[open] textarea")?.value || ""));
    const text = await dialog.locator("textarea").inputValue();
    const report = JSON.parse(text);
    const version = await fs.readFile(path.join(__dirname, "../../app/VERSION"), "utf8");
    assert.deepEqual(report.applicationVersion, version.trim().split(".").map(Number));
    assert.equal(report.recordedEditorFailures.javascriptErrors, "two-to-four");
    assert.equal(report.rendererTerminations.terminated, "one");
    assert.equal(report.host.availableDisplays, "two");
    assert.equal(report.viewport.presentation, "foreground");
    const activity = report.performance.activity;
    assert.equal(activity.version, 1);
    assert.equal(activity.recording, false);
    assert.equal(await page.evaluate(() => AtriumDiagnostics.performance), null, "opening the report does not start a capture");
    const retry = activity.rows.find(row => row.component === "analysis" && row.operation === "retry");
    assert.equal(retry.counts.completed, "1-to-4");
    assert.equal(retry.queueP95, "not-measured");
    assert.match(retry.runP95, /ms/);
    assert.match(retry.endToEndP95, /ms/);
    assert.ok(!/Secret|file:\/\/|\/Users\/|SYNTHETIC_PRIVATE|1795665432100/.test(text));
    assert.deepEqual(await page.evaluate(() => window.__diagnosticProbe),
      {native: 1, input: [], copies: [], exports: []}, "opening only takes the requested bounded snapshot");
    for (const name of ["Copy report", "Save report…"]) assert.equal(await dialog.getByRole("button", {name}).isEnabled(), true, name);
    await dialog.getByRole("button", {name: "Copy report"}).click();
    await page.waitForFunction(() => window.__diagnosticProbe.copies.length === 1);
    assert.deepEqual(await page.evaluate(() => window.__diagnosticProbe.copies), [text]);
    await page.evaluate(secret => {
      navigator.clipboard.writeText = async () => { throw new Error(secret); };
      document.execCommand = command => {
        if (command !== "copy") return false;
        const preview = document.activeElement;
        window.__diagnosticProbe.copies.push(preview.value.slice(preview.selectionStart, preview.selectionEnd));
        return true;
      };
      document.querySelector("dialog.diagnostics-dialog[open] textarea").value = secret;
    }, marker);
    await dialog.getByRole("button", {name: "Copy report"}).click();
    await page.waitForFunction(() => window.__diagnosticProbe.copies.length === 2);
    assert.deepEqual(await page.evaluate(() => window.__diagnosticProbe.copies), [text, text], "fallback copies the immutable snapshot");
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", {name: "Save report…"}).click()]);
    assert.equal(download.suggestedFilename(), "waffle-diagnostics.json");
    assert.equal(await fs.readFile(await download.path(), "utf8"), text, "saved file is byte-identical to the preview and copy");
    assert.deepEqual(await page.evaluate(() => window.__diagnosticProbe.exports),
      [{name: "waffle-diagnostics.json", text, diagnostics: true}]);
    await dialog.getByRole("button", {name: "Close"}).click();

    // Input inspection has no raw share path and shuts down its native poll before previewing.
    await openHelp("input-diagnostics");
    const input = page.locator("dialog.input-diagnostics-dialog[open]");
    await input.waitFor();
    await page.waitForFunction(() => window.__diagnosticProbe.input.includes("read"));
    const localText = await input.getByRole("textbox", {name: "Input events"}).inputValue();
    assert.match(localText, /NSTouch began.*touch scheme/);
    assert.ok(!localText.includes(marker));
    assert.equal(await input.getByRole("button", {name: "Copy", exact: true}).count(), 0);
    await page.evaluate(async secret => {
      const views = await AtriumLazy.need("AtriumDocViews");
      views.open("diagnostics-coverage-fixture", {title: secret});
    }, marker);
    await input.getByRole("button", {name: "Preview shareable report…"}).click();
    await input.waitFor({state: "detached"});
    await dialog.waitFor();
    await page.waitForFunction(() => window.__diagnosticProbe.native === 2);
    const coveredText = await dialog.locator("textarea").inputValue(), covered = JSON.parse(coveredText);
    assert.equal(covered.viewport.windowVisible, true);
    assert.equal(covered.viewport.presentation, "covered");
    assert.equal(covered.boardRenderer.renderState, "covered");
    assert.ok(!coveredText.includes(marker), "the covering document's title is private");
    const polled = await page.evaluate(() => window.__diagnosticProbe.input);
    assert.equal(polled[0], "start", "local recording starts on open");
    assert.equal(polled.at(-1), "stop", "local recording stops before previewing");
    assert.equal(polled.filter(operation => operation === "stop").length, 1);
    await page.waitForTimeout(600);
    assert.deepEqual(await page.evaluate(() => window.__diagnosticProbe.input), polled, "the live inspector stopped polling");
    assert.equal(await page.evaluate(() => window.__diagnosticProbe.native), 2, "the preview never polls diagnostics");
    assert.deepEqual(await page.evaluate(() => window.__diagnosticProbe.copies), [text, text], "previewing through Input never copies");
    await dialog.getByRole("button", {name: "Close"}).click();
    await page.evaluate(() => AtriumDocViews.close("diagnostics-coverage-fixture"));

    // 4. A pool worker that never answers is stopped by the watchdog; the page stays responsive.
    const hang = await page.evaluate(async () => {
      const W = AtriumWorkerPool || await AtriumLazy.need("AtriumWorkerPool");
      const pool = W.create("soak-hang", () => "onmessage = () => { for (;;) {} };", {size: 1, watchdogMs: 300});
      const t0 = performance.now();
      let ticks = 0; const tick = setInterval(() => ticks++, 20);
      const error = await pool.run({}).then(() => null, e => e);
      clearInterval(tick); pool.close();
      return {hung: !!error?.hung, ms: performance.now() - t0, ticks, timeouts: AtriumDiagnostics.failures().workerTimeouts};
    });
    assert.equal(hang.hung, true, "the hung job rejects");
    assert.ok(hang.ms < 3000 && hang.ticks >= 5, "the editor kept running while the worker hung " + JSON.stringify(hang));
    assert.equal(hang.timeouts, 1);
    assert.deepEqual(errors, []);
    console.log("PASS crash safety: failing commands roll back, errors are logged privately and told once, diagnostics report, worker watchdog");
  } finally { await page.close(); }
};
