"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const efficiencyOff = require("../support/efficiency-off.cjs");

const url = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const evidence = process.env.ATRIUM_RARE_MOTION_EVIDENCE;

async function shot(page, name) {
  if (evidence) await page.screenshot({path:path.join(evidence, name + ".png")});
}

async function noMotion(node, input = "keyboard") {
  const result = await node.evaluate(element => ({
    input:document.documentElement.dataset.motionInput || "pointer",
    effects:element.getAnimations({subtree:true}).length,
    opacity:getComputedStyle(element).opacity
  }));
  assert.deepEqual(result, {input, effects:0, opacity:"1"});
}

async function status(page, text, input) {
  const visible = page.locator("#status");
  await visible.filter({hasText:text}).waitFor();
  await noMotion(visible, input);
}

async function fresh(browser, run) {
  const page = await browser.newPage({viewport:{width:1440,height:920}, reducedMotion:"no-preference", acceptDownloads:true});
  await efficiencyOff(page);
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  try {
    await page.addInitScript(() => Object.defineProperty(navigator, "platform", {value:"MacIntel"}));
    await page.goto(url);
    await page.evaluate(() => AtriumTheme.set({preset:"light",followSystem:false,motion:"full"},{persist:false}));
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function fileMenu(page) {
  const menu = page.locator(".work-menu[data-menu=file]");
  await menu.locator("summary").press("Enter");
  return menu;
}

async function firstProjectAndExport(page) {
  await page.getByRole("button", {name:"Continue to editor", exact:true}).press("Enter");
  await page.locator("dialog.sp-dialog[open]").waitFor({state:"hidden"});
  const file = await fileMenu(page);
  await file.getByRole("menuitem", {name:"New Project…", exact:true}).press("Enter");
  const prompt = page.getByRole("dialog", {name:"New project", exact:true});
  await prompt.waitFor();
  await noMotion(prompt);
  await shot(page, "first-project-prompt");
  const name = prompt.getByRole("textbox", {name:"New project", exact:true});
  assert.ok(await name.evaluate(input => input === document.activeElement), "the name is ready for keyboard entry");
  await name.fill("Keyboard first project");
  await name.press("Enter");
  await prompt.waitFor({state:"hidden"});
  await status(page, /^Project created$/);
  assert.equal(await page.evaluate(() => AtriumNavHost.project().name), "Keyboard first project");
  await shot(page, "first-project-created");

  await fileMenu(page);
  await file.getByRole("menuitem", {name:"Export", exact:true}).press("ArrowRight");
  await file.getByRole("menuitem", {name:"Export Design…", exact:true}).press("Enter");
  const dialog = page.getByRole("dialog", {name:"Export Design", exact:true});
  await dialog.waitFor();
  await noMotion(dialog);
  const exportButton = dialog.getByRole("button", {name:"Export", exact:true});
  await page.waitForFunction(() => {
    const buttons = document.querySelectorAll('dialog[open] [data-variant=primary]');
    return [...buttons].some(button => button.textContent === "Export" && !button.disabled);
  });
  await shot(page, "first-export-preview");
  const downloading = page.waitForEvent("download");
  await exportButton.press("Enter");
  const download = await downloading;
  assert.equal(await download.failure(), null);
  assert.match(download.suggestedFilename(), /\.kicad_sch$/);
  assert.match(await fs.readFile(await download.path(), "utf8"), /^\(kicad_sch\b/);
  await dialog.waitFor({state:"hidden"});
  await status(page, /Exported .+\.kicad_sch/);
  await shot(page, "first-export-written");

  // Make the first-save setup an in-memory native project so the subsequent user Save
  // keystroke updates real storage without opening a destination picker or download.
  await page.evaluate(async() => {
    const host = AtriumNavHost;
    if (!await host.saveAll({download:false}) || !host.folderProject()) throw Error("Could not save the scratch project");
    host.edit(() => { host.doc().name += " edited"; });
    host.canvas().focus();
  });
  await page.keyboard.press("Meta+s");
  await page.waitForFunction(() => !AtriumNavHost.isDirty());
  await status(page, /^Saved\b/);
  await shot(page, "keyboard-save-status");
  await page.evaluate(() => AtriumNavHost.edit(() => { AtriumNavHost.doc().name += " again"; }));
  await page.locator('.quick-access [data-action="save"]').click();
  await page.waitForFunction(() => !AtriumNavHost.isDirty());
  await status(page, /^Saved\b/, "pointer");
}

async function undoAndRedo(page) {
  await page.getByRole("button", {name:"Try the Demo", exact:true}).press("Enter");
  await page.waitForFunction(() => AtriumNavHost.doc().items.some(item => item.kind === "part"));
  await page.evaluate(async () => {
    await AtriumLazy.need(["AtriumMotion", "AtriumUndoStore"]);
    const host = AtriumNavHost, item = host.doc().items.find(item => item.kind === "part" && !item.locked);
    host.select([item.id]);
    host.canvas().focus();
    const position = () => host.doc().items.find(candidate => candidate.id === item.id).x;
    window.historyMotion = {position, before:position(), grid:host.doc().grid, sameEvent:[]};
    document.addEventListener("keydown", event => {
      if (!event.isTrusted || !event.metaKey || !["ArrowRight", "KeyZ"].includes(event.code)) return;
      const pulse = AtriumMotion._fx.pulse;
      historyMotion.sameEvent.push({x:position(), status:document.getElementById("status").textContent,
        pulse:pulse ? [pulse.ms, !!pulse.move, pulse.count] : null, camera:AtriumMotion._fx.fade !== null});
    });
  });
  for (const motion of ["full","reduce","off"]) {
    await page.evaluate(motion => {
      AtriumTheme.set({motion},{persist:false});
      historyMotion.before = historyMotion.position();
      historyMotion.sameEvent.length = 0;
    },motion);
    await page.keyboard.press("Meta+ArrowRight");
    await page.keyboard.press("Meta+z");
    await status(page, /^Undone$/);
    if (motion === "full") await shot(page, "keyboard-undo");
    await page.keyboard.press("Meta+Shift+z");
    await status(page, /^Redone$/);
    if (motion === "full") await shot(page, "keyboard-redo");
    const state = await page.evaluate(() => historyMotion);
    const [nudge, undo, redo] = state.sameEvent;
    assert.ok(Math.abs(nudge.x - state.before - state.grid) < 1e-8, "the real keyboard nudge moved the selected object");
    assert.equal(undo.x, state.before, "the undo model applied in the trusted keydown event");
    assert.equal(redo.x, nudge.x, "the redo model applied in the trusted keydown event");
    assert.equal(undo.status, "Undone");
    assert.equal(redo.status, "Redone");
    for (const step of [undo, redo]) {
      assert.equal(step.camera, false, "editing the history position does not crossfade the canvas");
      assert.deepEqual(step.pulse,motion === "off" ? null : [200,false,1], motion + " only highlights the changed object");
    }
    await page.waitForFunction(() => !AtriumMotion._fx.pulse && !AtriumMotion._fx.gone);
  }
}

async function tutorial(page) {
  await page.locator('.sp-dialog [data-start-action="customise"]').press("Enter");
  await page.getByRole("button", {name:"Finish setup", exact:true}).press("Enter");
  const launch = page.getByRole("button", {name:"Your first board · 10 min", exact:true});
  await launch.waitFor();
  await launch.press("Enter");
  const card = page.locator(".tut-card"), start = card.locator('[data-tut="start"]');
  await start.waitFor();
  assert.ok(await start.evaluate(button => document.activeElement === button), "keyboard launch focuses the tutorial action");
  await noMotion(card);
  await shot(page, "tutorial-introduction");
  await start.press("Enter");
  const progress = card.getByRole("progressbar");
  await progress.waitFor();
  await noMotion(card);
  const initial = await progress.getAttribute("aria-valuenow");
  const skip = card.locator('[data-tut="skip"]');
  assert.ok(await skip.evaluate(button => document.activeElement === button), "the first step is ready for keyboard use");
  await skip.press("Enter");
  await page.waitForFunction(value => {
    const next = document.querySelector('.tut-card [role="progressbar"]');
    const skip = document.querySelector('.tut-card [data-tut="skip"]');
    return next && next.getAttribute("aria-valuenow") !== value && skip && !skip.disabled;
  }, initial);
  assert.ok(await skip.evaluate(button => document.activeElement === button), "the next step keeps working keyboard focus");
  await noMotion(card);
  await shot(page, "tutorial-next-step");

  // The coach must also react to the real Compile result without watching unrelated DOM.
  for (const step of ["connector", "wire", "power", "annotate", "erc"]) {
    await skip.press("Enter");
    await page.waitForFunction(expected => AtriumTutorial.controller().state().step === expected &&
      !document.querySelector('.tut-card [data-tut="skip"]').disabled, step);
  }
  await card.locator('[data-tut="run"]').press("Enter");
  await page.waitForFunction(() => AtriumTutorial.controller().state().step === "eco");
  assert.ok(await page.getByRole("region", {name:"Messages", exact:true}).isVisible());
  await noMotion(card);
  await card.locator('[data-tut="close"]').press("Enter");
  await card.waitFor({state:"hidden"});
  const ticks = await page.evaluate(async () => {
    let count = 0;
    const off = AtriumTutorial.controller().on(event => { if (event === "tick") count++; });
    try {
      AtriumNavHost.info("Unrelated editor status");
      const marker = document.createElement("span");
      document.body.append(marker);
      marker.remove();
      for (let frame = 0; frame < 5; frame++) await new Promise(requestAnimationFrame);
      return count;
    } finally { off(); }
  });
  assert.equal(ticks, 0, "the closed coach does no work in response to ordinary editor updates");
}

module.exports = async function rareMotion(browser) {
  if (evidence) await fs.mkdir(evidence, {recursive:true});
  await fresh(browser, firstProjectAndExport);
  await fresh(browser, undoAndRedo);
  await fresh(browser, tutorial);
  console.log("PASS keyboard first project, first KiCad export and ordinary Save status, synchronous Undo/Redo, and tutorial progress and Compile");
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"},
    browser => module.exports(browser),
    error => { console.error(error); process.exitCode = 1; });
}
