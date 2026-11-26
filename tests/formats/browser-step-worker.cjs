"use strict";

// STEP models are read in a Blob worker. Its script URL must outlive the Worker constructor: WebKit
// may still be fetching the script then, so the shared pool keeps it for 30 s (worker-pool.js).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function stepWorker(browser) {
  const page = await browser.newPage(), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.waitForFunction(() => globalThis.AtriumLazy);
    const text = fs.readFileSync(path.join(__dirname, "../fixtures/mcad/tray.step"), "utf8");
    const seen = await page.evaluate(async text => {
      await AtriumLazy.need("AtriumSTEPImport");
      const revoked = [], started = [], revoke = URL.revokeObjectURL, Native = Worker;
      URL.revokeObjectURL = url => { revoked.push(url); return revoke.call(URL, url); };
      globalThis.Worker = class extends Native { constructor(url, o) { super(url, o); started.push(String(url)); } };
      try {
        const pending = AtriumSTEPImport.load(text);
        const early = started.filter(url => revoked.includes(url)).length;
        const result = await pending;
        return {started: started.length, early, ok: !result.error, parts: result.parts?.length || 0};
      } finally { URL.revokeObjectURL = revoke; globalThis.Worker = Native; }
    }, text);
    assert.equal(seen.started, 1, "the model is read in a worker");
    assert.equal(seen.early, 0, "the worker's script URL is not revoked while the worker may still be loading it");
    assert.ok(seen.ok && seen.parts > 0, "the worker returns the tessellated model");
    assert.deepEqual(errors, []);
    console.log("PASS STEP worker keeps its script URL while it loads and returns the model");
  } finally { await page.close(); }
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({channel: "chrome"}, stepWorker, error => { console.error(error); process.exitCode = 1; });
module.exports = stepWorker;
