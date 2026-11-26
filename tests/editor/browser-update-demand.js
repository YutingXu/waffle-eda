"use strict";

// Test actual script requests, persisted update state, and the launch and Help dialogs.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const index = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const updateState = fields => ({format: "atrium-update", version: 1, ...fields});
const noHome = {"general.startPage": "never"};

async function scenario(browser, {state, values = {}, covered = false}, fn) {
  const page = await browser.newPage({locale: "en-US"}), requests = [], remote = [], errors = [];
  page.setDefaultTimeout(6000);
  page.on("request", request => {
    if (/\/update-check\.js$/.test(request.url())) requests.push(request.url());
  });
  page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route(/^https?:/i, route => { remote.push(route.request().url()); return route.abort(); });
    await page.addInitScript(({state, values, covered}) => {
      if (self !== top) return;
      if (state && !localStorage.getItem("atrium.update")) localStorage.setItem("atrium.update", JSON.stringify(state));
      localStorage.setItem("atrium.prefs", JSON.stringify({format: "atrium-prefs", version: 1, values}));
      if (covered) globalThis.__atriumPowerState = {occluded: true};
    }, {state, values, covered});
    const ready = async () => {
      await page.waitForFunction(() => !!globalThis.AtriumNavHost && !!globalThis.AtriumLazy);
      await page.evaluate(() => new Promise(resolve => AtriumIdle.idle(() => resolve(), {timeout: 2000})));
    };
    const cold = async label => {
      await ready();
      const flags = await page.evaluate(() => [AtriumLazy.has("AtriumUpdate"), AtriumLazy.pending("AtriumUpdate")]);
      assert.deepEqual(flags, [false, false], label);
      assert.deepEqual(requests, [], label);
      assert.deepEqual(remote, [], label);
    };
    const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem("atrium.update")));
    const report = await fn({page, requests, remote, ready, cold, stored});
    assert.deepEqual(errors, []);
    return report;
  } finally { await page.close(); }
}

module.exports = async function updateDemand(browser) {
  const version = await scenario(browser, {}, async ({page, cold, stored}) => {
    await page.goto(index);
    await cold("a fresh launch keeps the update module unloaded");
    const version = await page.locator('meta[name="application-version"]').getAttribute("content");
    assert.ok(version, "the installed application has a version");
    assert.deepEqual(await stored(), updateState({lastVersion: version}));
    assert.equal(await page.locator("dialog.whats-new[open]").count(), 0);
    await page.reload();
    await cold("a same-version launch keeps the update module unloaded");
    assert.deepEqual(await stored(), updateState({lastVersion: version}));
    return version;
  });

  const previous = version === "0.4.0" ? "0.3.0" : "0.4.0";
  const transition = `Updated from Waffle ${previous} to ${version}.`;
  const old = updateState({lastVersion: previous});
  await scenario(browser, {state: old, values: noHome}, async ({page, requests, remote, stored}) => {
    await page.goto(index);
    await page.locator("dialog.whats-new[open] .update-notes", {hasText: transition}).waitFor();
    assert.equal((await stored()).lastVersion, version, "showing the notice records the upgrade");
    assert.equal(requests.length, 1);
    assert.deepEqual(remote, [], "release notes use local data");
  });

  await scenario(browser, {state: old}, async ({page, remote, ready, stored}) => {
    // Let both modules load but hold Home's first presentation, as when recovery is still starting.
    await page.addInitScript(() => {
      if (self !== top || sessionStorage.getItem("updateDemandHeldHome")) return;
      sessionStorage.setItem("updateDemandHeldHome", "1");
      const released = new Promise(resolve => { globalThis.releaseHomeForUpdateTest = () => resolve(); });
      Object.defineProperty(globalThis, "AtriumStartPage", {configurable: true, set(home) {
        Object.defineProperty(globalThis, "AtriumStartPage", {configurable: true,
          value: {...home, launch: () => released.then(() => home.launch())}});
      }});
    });
    await page.goto(index);
    await page.waitForFunction(() => AtriumLazy.has("AtriumUpdate"));
    await ready();
    assert.equal(await page.locator("dialog[open]").count(), 0, "the upgrade notice yields to pending setup");
    await page.evaluate(() => releaseHomeForUpdateTest());
    const home = page.locator("dialog.sp-dialog[open]");
    await home.waitFor();
    assert.equal(await home.evaluate(d => d.contains(document.activeElement)), true, "Home keeps focus during setup");
    assert.deepEqual(await stored(), old, "the notice remains due while Home is open");
    await page.reload();
    await home.waitFor();
    await ready();
    assert.deepEqual(await stored(), old, "reloading during setup does not discard the unseen notice");
    await page.keyboard.press("Escape");
    await page.locator("dialog.whats-new[open] .update-notes", {hasText: transition}).waitFor();
    assert.equal((await stored()).lastVersion, version);
    assert.deepEqual(remote, []);
    await page.reload();
    // The request trace includes past navigations, so inspect the fresh document here.
    await ready();
    assert.equal(await page.evaluate(() => AtriumLazy.has("AtriumUpdate") || AtriumLazy.pending("AtriumUpdate")), false);
    assert.equal(await page.locator("dialog.whats-new[open]").count(), 0);
  });

  const overdue = updateState({lastVersion: version, lastCheck: Date.now() - 2 * 86400000});
  await scenario(browser, {state: overdue, covered: true, values: {...noHome, "general.updateCheck": true}}, async ({page, cold, stored}) => {
    await page.goto(index);
    assert.equal(await page.evaluate(() => AtriumPower.visible()), false);
    await cold("an old opt-in is ignored even when a check was due");
    await page.evaluate(() => AtriumPower.host({occluded: false}));
    await cold("showing the window makes no request");
    assert.deepEqual(await stored(), overdue);
  });

  for (const canInstall of [true, false]) {
    await scenario(browser, {values: {...noHome, "general.efficiency": "always"}}, async ({page, requests, remote, cold}) => {
      await page.goto(index);
      await cold("the update module stays unloaded until Help is used");
      assert.equal(await page.evaluate(() => AtriumPower.efficient()), true);
      await page.evaluate(canInstall => {
        const sha256 = "a".repeat(64);
        const manifest = {app: "99.0.0", notes: ["A signed release note"], formats: {writes: "2.0"}, apiVersions: [1],
          assets: [{name:"Waffle-99.0.0-macOS.zip", platform:"macos", size: 2 * 1048576, sha256}]};
        const calls = globalThis.updateHostCalls = [];
        let installCount = 0;
        globalThis.AtriumHost = {
          checkForUpdate: async () => { calls.push("check"); return {status:"available", canInstall, manifest}; },
          installUpdate: async (...args) => { calls.push(["install", ...args]); return ++installCount === 1 ? "cancelled" : "download"; },
          downloadUpdate: async (...args) => { calls.push(["download", ...args]); return true; }
        };
      }, canInstall);
      const calls = () => page.evaluate(() => globalThis.updateHostCalls);
      const help = page.locator('.work-menu[data-menu="help"]');
      await help.locator("summary").click();
      await help.getByRole("menuitem", {name: "Check for Updates…"}).click();
      const dialog = page.getByRole("dialog", {name: "Check for Updates", exact: true});
      await dialog.getByText("Waffle 99.0.0 is available.", {exact:true}).waitFor();
      await dialog.getByText("A signed release note", {exact:true}).waitFor();
      assert.deepEqual(await calls(), ["check"], "Help makes the check and waits for a separate install click");
      const install = dialog.getByRole("button", {name:"Install Update (2 MB)", exact:true});
      const download = dialog.getByRole("button", {name:"Download Waffle-99.0.0-macOS.zip (2 MB)", exact:true});
      if (canInstall) {
        assert.equal(await download.count(), 0);
        await install.click();
        await dialog.getByRole("status").filter({hasText:"Installation cancelled"}).waitFor();
        await install.click();
      } else {
        assert.equal(await install.count(), 0);
      }
      await download.click();
      await dialog.getByRole("status").filter({hasText:"Checked and saved"}).waitFor();
      const identity = ["99.0.0", "a".repeat(64)];
      assert.deepEqual(await calls(), canInstall ?
        ["check", ["install", ...identity], ["install", ...identity], ["download", ...identity]] :
        ["check", ["download", ...identity]]);
      assert.equal(requests.length, 1);
      assert.deepEqual(remote, [], "the browser sends no requests for the macOS updater");
    });
  }
  console.log("PASS browser update demand, deferred upgrade notes, Install and verified Download fallback");
};
