"use strict";
// Shared harness for the Butter design walkthroughs (tests/browser-butter-*-ui.cjs): boots the
// editor in light, dark and touch, and optionally writes state screenshots for the design notes.
const path = require("node:path"), fs = require("node:fs");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");

const PROFILES = [
  {name:"light", theme:"light", touch:false, viewport:{width:1280, height:820}},
  {name:"dark", theme:"dark", touch:false, viewport:{width:1280, height:820}},
  {name:"touch", theme:"light", touch:true, viewport:{width:1024, height:900}},
];

function options() {
  const at = process.argv.indexOf("--shots");
  return {shots:at > 0 ? path.resolve(process.argv[at + 1]) : null, only:process.argv.includes("--light") ? ["light"] : null};
}

async function boot(browser, profile, prefs = {}) {
  const page = await browser.newPage({viewport:profile.viewport, hasTouch:profile.touch, deviceScaleFactor:2, reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(15000);
  await page.addInitScript(values => {
    if (window !== window.top) return;
    localStorage.setItem("atrium.prefs", JSON.stringify({format:"atrium-prefs", version:1, values:{"general.startPage":"never", ...values}}));
  }, prefs);
  await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
  await page.waitForFunction(() => !!globalThis.AtriumNavHost && !!globalThis.AtriumShell);
  await page.evaluate(async ({theme, touch}) => {
    globalThis.AtriumStartPage?.close?.();
    await AtriumNavHost.replaceProject(AtriumParts.example(), {copy:true, dirty:false}); // the Sensor interface demo
    document.documentElement.dataset.theme = theme;
    if (touch) document.documentElement.dataset.pointer = "touch";
  }, profile);
  return {page, errors};
}

async function shoot(locator, shots, feature, state, profile) {
  if (!shots) return;
  const dir = path.join(shots, feature);
  fs.mkdirSync(dir, {recursive:true});
  await locator.screenshot({path:path.join(dir, `${state}-${profile.name}.png`), animations:"disabled"});
}

async function run(feature, scenario, launchArgs = []) {
  const {shots, only} = options();
  const engine = process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"};
  const browser = await chromium.launch({...engine, args:["--allow-file-access-from-files", ...launchArgs]});
  try {
    for (const profile of PROFILES.filter(p => !only || only.includes(p.name))) {
      if (!shots && profile.name === "dark") continue; // the flow runs in light and touch; screenshots need all three
      await scenario({browser, profile, shot:(locator, state) => shoot(locator, shots, feature, state, profile)});
    }
  } finally { await browser.close(); }
}

module.exports = {PROFILES, boot, run};
