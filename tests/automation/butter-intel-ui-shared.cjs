"use strict";
// Shared setup for the Ask AI, Query, Macros and Links browser walks (tests/browser-butter-*-ui.cjs).
// Each walk opens the demo in light, dark and touch, turns its flag on, drives the real surface and,
// with --shots <dir>, writes screenshots to that directory.
const fs = require("node:fs");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const ROOT = path.resolve(__dirname, "../..");
const PROFILES = [
  {name:"light", theme:"light", touch:false, viewport:{width:1280, height:820}},
  {name:"dark", theme:"dark", touch:false, viewport:{width:1280, height:820}},
  {name:"touch", theme:"light", touch:true, viewport:{width:1180, height:820}}
];

function args() {
  const at = process.argv.indexOf("--shots");
  return {shots:at > 0 ? path.resolve(process.argv[at + 1]) : null, quick:process.argv.includes("--quick")};
}

async function launch() {
  let chromium;
  try { ({chromium} = require("playwright-core")); } catch { return null; }
  return chromium.launch({headless:true, args:["--allow-file-access-from-files"], executablePath:process.env.CHROME ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"});
}

function runWalk(walk, skip, pass) {
  return (async () => {
    const browser = await launch();
    if (!browser) { console.log(skip); return; }
    const {shots} = args();
    try {
      for (const profile of shots ? PROFILES : PROFILES.slice(0, 1)) await walk(browser, profile, shots);
      console.log(pass);
    } finally { await browser.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
}

// The demo project, a fixed clock, the profile's theme and the given Butter flags.
async function openDemo(browser, profile, flags = []) {
  const page = await browser.newPage({viewport:profile.viewport, hasTouch:profile.touch, reducedMotion:"reduce", deviceScaleFactor:1});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    const t0 = Date.UTC(2026, 10, 20, 12, 0, 0), Real = Date;
    globalThis.Date = class extends Real { constructor(...a) { super(...(a.length ? a : [t0])); } static now() { return t0; } };
  });
  await page.goto(pathToFileURL(path.join(ROOT, "app/index.html")).href);
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, profile.theme);
  await page.getByRole("button", {name:"Try the Demo", exact:true}).click();
  await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
  await page.evaluate(async flags => {
    for (const flag of flags) AtriumPrefs.set("butter." + flag, true);
    await AtriumLazy.need("AtriumButterEditor");
  }, flags);
  await page.waitForFunction(flags => flags.every(f => globalThis.AtriumIntelUI && AtriumKeymap.command?.({
    ai:"assist.ask-ai", query:"assist.design-query", macros:"assist.macros", links:"assist.open-link"
  }[f])), flags, {timeout:5000});
  return {page, errors};
}

// The example provider, with a few deterministic replies for the walk.
function providerPackage() {
  const base = path.join(ROOT, "extensions/examples/ai-provider");
  const pkg = Object.fromEntries(["waffle-extension.json", "provider.js"].map(file => [file, fs.readFileSync(path.join(base, file), "utf8")]));
  const manifest = JSON.parse(pkg["waffle-extension.json"]);
  manifest.permissions.push("propose:edits");
  pkg["waffle-extension.json"] = JSON.stringify(manifest);
  pkg["provider.js"] += `
const answer = module.exports.respond;
module.exports.respond = async input => {
  if (input.question.startsWith("Hold")) { await new Promise(resolve => setTimeout(resolve, 10000)); return {type:"answer", text:"Late."}; }
  if (input.question.startsWith("Rename")) return {type:"answer", text:"R1 could carry its tolerance in the value.",
    suggestion:{componentId:input.context.selection[0], field:"value", value:"10k 1%"}};
  if (input.question.startsWith("Fail")) return {type:"nonsense"};
  const reply = await answer(input);
  if (reply.type === "answer" && reply.citations?.length) reply.text = "The board has " + reply.citations.length +
    " parts in the approved rows, for example [" + reply.citations[0] + "] and [" + reply.citations[1] + "].";
  return reply;
};
`;
  return pkg;
}
async function installProvider(page, {consent = true} = {}) {
  await page.evaluate(async ({pkg, consent}) => {
    const host = AtriumNavHost;
    await AtriumLazy.need("AtriumExtensions");
    const X = AtriumExtensions;
    X.attach({project:host.project, documentId:host.currentId, revision:host.revision, selection:() => new Set(host.selection()), info:host.info},
      {consent:request => request.kind === "install" ? (consent ? {"ai:provider":true, "propose:edits":true} : {}) : true});
    await X.install(pkg);
  }, {pkg:providerPackage(), consent});
}

// Settle fonts and the frame, then capture the panel (or the whole window) for the design note.
async function shot(page, dir, name, locator) {
  if (!dir) return;
  fs.mkdirSync(dir, {recursive:true});
  await page.evaluate(() => document.fonts?.ready);
  const target = locator ? page.locator(locator).first() : page;
  await target.screenshot({path:path.join(dir, name + ".png"), animations:"disabled", caret:"hide"});
}

module.exports = {ROOT, PROFILES, args, launch, runWalk, openDemo, installProvider, providerPackage, shot};
