"use strict";

// Playwright Core for browser suites, with the host state a suite does not set itself pinned, so a
// suite passes or fails the same way on every machine. Require this instead of "playwright-core";
// when Playwright is missing, the require throws the same error, so a suite's SKIP still works.
//
// Pinned for every context and page made from a pinned browser, unless the suite passes its own value:
//  - locale en-US and time zone UTC. Without them Chromium follows the host's language settings
//    (en-GB on one Mac, en-US in CI) and the TZ environment variable.
//  - mains power: navigator.getBattery reports a charging battery. On a laptop running on battery,
//    Automatic Efficiency mode (app/core/power.js) otherwise sets <html data-efficient> and turns
//    motion, coasting and decorative transitions off. A suite that covers battery or Efficiency mode
//    sets general.efficiency, or redefines navigator.getBattery in its own init script (it runs later).
// Playwright already pins the colour scheme (light), reduced motion (no-preference), forced colours
// (none), the viewport (1280 x 720) and the device scale factor (1), whatever the host's settings.
const playwright = require("playwright-core");

const DEFAULTS = Object.freeze({locale: "en-US", timezoneId: "UTC"});
const PINNED = Symbol.for("waffle.tests.pinnedHost");

function mainsPower() {
  try {
    const battery = {charging: true, level: 1, chargingTime: 0, dischargingTime: Infinity,
      onchargingchange: null, onlevelchange: null, onchargingtimechange: null, ondischargingtimechange: null,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }};
    Object.defineProperty(Navigator.prototype, "getBattery", {configurable: true, writable: true, value: function getBattery() { return Promise.resolve(battery); }});
  } catch { /* not a window */ }
}

function contextOptions(options) {
  const result = {...(options || {})};
  for (const [key, value] of Object.entries(DEFAULTS)) if (result[key] === undefined) result[key] = value;
  return result;
}

function pinContext(context) {
  if (!context || context[PINNED]) return context;
  context[PINNED] = context.addInitScript(mainsPower);
  return context;
}

async function pinnedContext(context) {
  pinContext(context);
  await context[PINNED];
  return context;
}

// Make every later browser.newContext and browser.newPage pinned. Returns the browser.
function pin(browser) {
  if (!browser || browser[PINNED]) return browser;
  browser[PINNED] = true;
  const newContext = browser.newContext.bind(browser);
  // Browser.newPage calls this.newContext, so pages made directly are pinned as well.
  browser.newContext = async (options, ...rest) => pinnedContext(await newContext(contextOptions(options), ...rest));
  return browser;
}

function pinType(type) {
  if (!type || type[PINNED]) return type;
  type[PINNED] = true;
  const launch = type.launch.bind(type), persistent = type.launchPersistentContext?.bind(type);
  type.launch = async (...args) => pin(await launch(...args));
  if (persistent) type.launchPersistentContext = async (dir, options, ...rest) =>
    pinnedContext(await persistent(dir, contextOptions(options), ...rest));
  return type;
}

pinType(playwright.chromium);

module.exports = {...playwright, chromium: playwright.chromium, pin, contextOptions, DEFAULTS};
