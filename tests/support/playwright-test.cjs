"use strict";

// Witness for tests/support/playwright.cjs, the pinned Playwright every browser suite requires.
// Injects a fake playwright-core: no Chromium starts. Checks that new contexts and pages get locale
// en-US, time zone UTC and mains power unless the suite sets its own, and that no test file
// requires playwright-core directly, which would bypass the pins.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.resolve(__dirname, "../..");
const helperPath = path.join(__dirname, "playwright.cjs");
// Objects made inside the helper's realm compare by value.
const plain = value => JSON.parse(JSON.stringify(value));

function load() {
  const trace = [];
  const fakeContext = options => ({
    options, scripts: [],
    async addInitScript(script) { this.scripts.push(script); trace.push(["init"]); },
    pages: () => [],
  });
  const chromium = {
    async launch(options) {
      trace.push(["launch", options]);
      return {
        async newContext(options) { trace.push(["context", options]); return fakeContext(options); },
        // Playwright's Browser.newPage calls this.newContext.
        async newPage(options) { const context = await this.newContext(options); return {context}; },
      };
    },
    async launchPersistentContext(dir, options) { trace.push(["persistent", dir, options]); return fakeContext(options); },
  };
  const module = {exports: {}};
  vm.runInNewContext(fs.readFileSync(helperPath, "utf8"), {
    require(name) {
      if (name !== "playwright-core") throw Error("unexpected require " + name);
      return {chromium, devices: {}};
    },
    module, exports: module.exports, Symbol, Object, Promise,
  }, {filename: helperPath});
  return {pw: module.exports, trace};
}

async function pins() {
  const {pw, trace} = load();
  assert.deepEqual(plain({...pw.DEFAULTS}), {locale: "en-US", timezoneId: "UTC"});
  assert.equal(typeof pw.devices, "object", "the rest of playwright-core is passed through");
  const browser = await pw.chromium.launch({headless: true});
  assert.equal(pw.pin(browser), browser, "pinning twice keeps the browser");

  const bare = await browser.newContext();
  assert.deepEqual(plain(bare.options), {locale: "en-US", timezoneId: "UTC"}, "a context without options gets the pins");
  assert.equal(bare.scripts.length, 1, "one init script per context");

  const own = await browser.newContext({locale: "de-DE", timezoneId: "Pacific/Kiritimati", viewport: {width: 10, height: 10}});
  assert.deepEqual(plain(own.options), {locale: "de-DE", timezoneId: "Pacific/Kiritimati", viewport: {width: 10, height: 10}}, "a suite's own values win");

  const page = await browser.newPage({reducedMotion: "reduce"});
  assert.deepEqual(plain(page.context.options), {reducedMotion: "reduce", locale: "en-US", timezoneId: "UTC"}, "pages made directly are pinned");
  assert.equal(page.context.scripts.length, 1);

  const persistent = await pw.chromium.launchPersistentContext("/profile", {headless: true});
  assert.deepEqual(plain(persistent.options), {headless: true, locale: "en-US", timezoneId: "UTC"}, "persistent contexts are pinned");
  assert.equal(persistent.scripts.length, 1);
  assert.deepEqual(plain(trace.filter(row => row[0] === "launch")), [["launch", {headless: true}]], "launch options are unchanged");

  // The init script reports a charging battery, so Automatic Efficiency mode stays off.
  class Navigator {}
  const sandbox = {Navigator, Promise, Infinity};
  vm.runInNewContext("(" + bare.scripts[0].toString() + ")()", sandbox);
  const battery = await new Navigator().getBattery();
  assert.equal(battery.charging, true);
  assert.equal(battery.dischargingTime, Infinity);
  // A suite that covers battery redefines it in a later init script.
  Object.defineProperty(Navigator.prototype, "getBattery", {value: async () => ({charging: false})});
  assert.equal((await new Navigator().getBattery()).charging, false, "the pin can be overridden");
}

function inventory() {
  const direct = /require\((["'])playwright(?:-core)?\1\)/;
  // The standalone envelope's witness names the require only to assert that callers avoid it.
  const exempt = new Set([helperPath, __filename, path.join(__dirname, "standalone-chromium-test.cjs")]);
  const found = [];
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "fixtures") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.c?js$/.test(entry.name) && !exempt.has(full) && direct.test(fs.readFileSync(full, "utf8")))
        found.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, "tests"));
  assert.deepEqual(found, [], "require tests/support/playwright.cjs instead of playwright-core so host state stays pinned");
}

(async () => {
  await pins();
  inventory();
  console.log("pinned Playwright: en-US, UTC and mains power unless a suite sets them; no direct playwright-core requires");
})().catch(error => { console.error(error); process.exitCode = 1; });
