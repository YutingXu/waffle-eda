"use strict";

// The connectivity solver is lazy (lazy.js). Opening a project preloads it for its boards, but a board added
// to an open project can draw before the solver is here: the canvas must not throw, and the board's
// connectivity (airwires, shorts) is there once the solver has loaded.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function lazyConnectivity(browser) {
  const page = await browser.newPage({viewport: {width: 1200, height: 800}, reducedMotion: "reduce"}), errors = [];
  page.on("pageerror", e => errors.push(e.message));
  page.setDefaultTimeout(15000);
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.waitForFunction(() => globalThis.AtriumNavHost && globalThis.AtriumLazy);
    await page.addScriptTag({path: path.join(__dirname, "dense-board.js")});
    assert.equal(await page.evaluate(() => !!globalThis.AtriumConnectivity), false, "the solver is not loaded before a board is used");
    // The board's connectivity is asked for in the same task the board arrives, before any load can finish
    // (as the deferred airwire draw on a dense board does).
    const first = await page.evaluate(() => {
      for (const d of document.querySelectorAll("dialog[open]")) d.close();
      const H = AtriumNavHost, {d} = makeAtriumBenchmarkBoard(24);
      H.edit(() => { H.project().documents.push(d); });
      H.selectDocument(d.id);
      try { return {loaded: !!globalThis.AtriumConnectivity, result: H.connections?.() ?? null}; } catch (e) { return {error: e.message}; }
    });
    assert.equal(first.error, undefined, "asking for a board's connectivity before the solver has loaded does not throw");
    await page.waitForFunction(() => !!globalThis.AtriumConnectivity, null, {timeout: 15000});
    await page.waitForFunction(() => Array.isArray(AtriumNavHost.connections?.()?.airwires), null, {timeout: 15000});
    assert.deepEqual(errors, [], "drawing a board before the solver has loaded throws nothing");
    console.log("PASS lazy connectivity: a board added to an open project draws, loads the solver and then has its connectivity");
  } finally { await page.close(); }
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({channel: "chrome"}, lazyConnectivity, error => { console.error(error); process.exitCode = 1; });
module.exports = lazyConnectivity;
