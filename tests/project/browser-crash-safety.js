"use strict";

// Crash safety in a real browser: a command that throws halfway leaves no half-applied change and no
// undo step; an uncaught error in Waffle's own code is logged without project data and told once in
// the status bar (no dialog); Help › Crash Diagnostics shows a report that can be copied or saved;
// a hung pool worker is stopped and the editor stays responsive.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function crashSafety(browser) {
  const page = await browser.newPage({viewport: {width: 1280, height: 860}}), errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
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
    const told = await page.evaluate(async () => ({infos: window.__infos.filter(m => /Internal error/.test(m)), rows: await AtriumDiagnostics.entries()}));
    assert.equal(told.infos.length, 1, "repeated failures are told once: " + JSON.stringify(told.infos));
    assert.match(told.infos[0], /Internal error \(TypeError, editor\.js\): details in Help › Crash Diagnostics/);
    assert.ok(told.rows.filter(r => r.type === "TypeError" && r.module === "editor.js").length >= 2, "the command's and the timer's failures are logged");
    assert.ok(told.rows.some(r => r.type === "RangeError" && r.module === "editor.js"));
    assert.ok(!told.rows.some(r => r.kind === "error" && !r.module), "the muted copy of a reported error is not logged twice");
    assert.ok(told.rows.some(r => r.kind === "error" && r.module === "editor.js" && r.line > 0), "the log keeps the module and line");
    assert.ok(!JSON.stringify(told).includes("Secret"), "neither the notice nor the log keeps the message");
    errors.length = 0; // the two deliberate uncaught errors

    // 3. Help › Crash Diagnostics: a report with a header, the failures, Copy and Save.
    await page.evaluate(() => AtriumNavHost.act("crash-diagnostics"));
    const dialog = page.locator("dialog.diagnostics-dialog[open]");
    await dialog.waitFor();
    await page.waitForFunction(() => /diagnostics report/.test(document.querySelector("dialog.diagnostics-dialog[open] textarea")?.value || ""));
    const text = await dialog.locator("textarea").inputValue();
    assert.match(text, /^Waffle 0\.\d+\.\d+ diagnostics report/);
    assert.match(text, /JavaScript error · TypeError · editor\.js:\d+/);
    assert.ok(!/Secret|file:\/\/|\/Users\//.test(text), "the report has no messages or paths");
    for (const name of ["Copy report", "Save report…"]) assert.equal(await dialog.getByRole("button", {name}).isEnabled(), true, name);
    const [download] = await Promise.all([page.waitForEvent("download"), dialog.getByRole("button", {name: "Save report…"}).click()]);
    assert.match(download.suggestedFilename(), /^atrium-diagnostics-\d{4}-\d\d-\d\d\.txt$/);
    await dialog.getByRole("button", {name: "Close"}).click();

    // 4. A pool worker that never answers is stopped by the watchdog; the page stays responsive.
    const hang = await page.evaluate(async () => {
      const W = AtriumWorkerPool || await AtriumLazy.need("AtriumWorkerPool");
      const pool = W.create("soak-hang", () => "onmessage = () => { for (;;) {} };", {size: 1, watchdogMs: 300});
      const t0 = performance.now();
      let ticks = 0; const tick = setInterval(() => ticks++, 20);
      const error = await pool.run({}).then(() => null, e => e);
      clearInterval(tick); pool.close();
      return {hung: !!error?.hung, ms: performance.now() - t0, ticks, rows: (await AtriumDiagnostics.entries()).filter(r => r.kind === "hang").map(r => r.type)};
    });
    assert.equal(hang.hung, true, "the hung job rejects");
    assert.ok(hang.ms < 3000 && hang.ticks >= 5, "the editor kept running while the worker hung " + JSON.stringify(hang));
    assert.deepEqual(hang.rows, ["soak-hang"]);
    assert.deepEqual(errors, []);
    console.log("PASS crash safety: failing commands roll back, errors are logged privately and told once, diagnostics report, worker watchdog");
  } finally { await page.close(); }
};
