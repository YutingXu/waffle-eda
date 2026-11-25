"use strict";
// Exercise the actual PCB controls, command palette, keyboard and snap results in Chrome.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
const {chromium} = require("playwright-core");

const root = path.resolve(__dirname, "../..");
const appArg = process.argv.indexOf("--app");
const app = appArg >= 0 ? path.resolve(process.argv[appArg + 1]) : path.join(root, "app");
const editor = pathToFileURL(path.join(app, "index.html")).href;
const via = [10.14, 10.14], pad = [15.14, 15.14];

async function openBoard(page) {
  await page.goto(editor);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.waitForFunction(() => globalThis.AtriumNavHost?.doc()?.kind === "pcb");
  await page.evaluate(async ({via, pad}) => {
    const host = AtriumNavHost, project = Atrium.project("Object Snap test"), board = project.documents.find(d => d.kind === "pcb");
    board.outline = [[0, 0], [25, 0], [25, 25], [0, 25]];
    board.items = [
      {id:Atrium.id(), kind:"via", x:via[0], y:via[1], diameter:.6, drill:.3, layer:"Multi"},
      {id:Atrium.id(), kind:"pad", x:pad[0], y:pad[1], w:1, h:1, shape:"round", layer:"Top", number:"1"}
    ];
    await host.replaceProject(project, {force:true, dirty:false});
    host.view().restoreCamera({...host.view().camera(), scale:20});
  }, {via, pad});
}

async function state(page, label) {
  return page.evaluate(({via, pad, label}) => {
    const host = AtriumNavHost, menu = document.querySelector('.menubar [data-action="snap-object"]'),
      status = document.querySelector('.statusbar [data-action="snap-options"]'), prefs = AtriumPCBEdit.snapPrefs;
    // The canvas independently finds contacts within nine pixels. Sample beyond that distance.
    const sample = ([x, y], pixels) => host.snapAt([x + pixels / host.view().scale(), y]);
    return {label, objects:prefs.objects, grid:prefs.grid, radius:prefs.radius, pads:prefs.pads,
      preference:AtriumPref.get("pcb.snapObjects", true), gridPreference:AtriumPref.get("pcb.snapGrid", true),
      distancePreference:AtriumPref.get("pcb.snapRadius", 8),
      menu:menu.getAttribute("aria-checked"), status:status.getAttribute("aria-pressed"),
      checkmark:getComputedStyle(menu, "::before").content.includes("✓"), dot:getComputedStyle(status, "::before").backgroundColor,
      viaSnap:sample(via, 9.5), padSnap:sample(pad, 9.5), farViaSnap:sample(via, 11)};
  }, {via, pad, label});
}

async function control(page, menu, action) {
  const group = page.locator('.work-menu[data-menu="' + menu + '"]');
  await group.locator(":scope > summary").click();
  await group.locator('[data-action="' + action + '"]').click();
}

async function preferences(page) {
  await control(page, "file", "preferences");
  const dialog = page.getByRole("dialog", {name:"Preferences", exact:true});
  await dialog.getByRole("button", {name:"PCB", exact:true}).click();
  return dialog;
}

async function popup(page) {
  await page.locator('.statusbar [data-action="snap-options"]:visible').click();
  const dialog = page.getByRole("dialog", {name:"Snap options", exact:true});
  await dialog.waitFor();
  return dialog;
}

async function close(page, dialog) {
  await page.keyboard.press("Escape");
  await dialog.waitFor({state:"hidden"});
}

async function run(browser, {probe = false} = {}) {
  const page = await browser.newPage({viewport:{width:1400, height:900}, reducedMotion:"reduce"});
  const errors = [], rows = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  const capture = async label => rows.push(await state(page, label));
  try {
    await openBoard(page);
    const prefs = await preferences(page);
    const grid = prefs.locator("#prf-pcb-snapGrid");
    await grid.uncheck();
    const increaseRadius = prefs.getByRole("button", {name:"Increase Object snap distance", exact:true});
    await increaseRadius.click();
    await increaseRadius.click();
    const objectPreference = prefs.locator("#prf-pcb-snapObjects");
    await objectPreference.uncheck();
    await capture("preferences off");
    await objectPreference.check();
    await close(page, prefs);

    await capture("initial");
    await control(page, "view", "snap-object");
    await capture("menu off");

    const snap = await popup(page);
    await capture("opened");
    await snap.getByRole("checkbox", {name:"Snap to objects", exact:true}).check();
    await snap.getByRole("checkbox", {name:"Snap to grid", exact:true}).check();
    const distance = snap.getByRole("spinbutton", {name:"Snap distance in pixels"});
    await distance.fill("12");
    await distance.press("Tab");
    await snap.getByRole("checkbox", {name:"Pad centres", exact:true}).uncheck();
    await capture("popover on");
    await close(page, snap);

    await openBoard(page);
    await capture("reload");
    await page.locator("#canvas").press("Shift+E");
    await capture("shortcut off");

    await control(page, "view", "command-palette");
    const palette = page.locator("dialog.nav-palette[open]");
    const search = palette.getByRole("combobox");
    await search.fill("> Object Snap");
    const entry = palette.getByRole("option").filter({hasText:/^Object Snap/}).first();
    await entry.waitFor();
    assert.equal(await entry.getAttribute("aria-checked"), null);
    await entry.click();
    await palette.waitFor({state:"hidden"});
    await capture("palette on");

    assert.deepEqual(errors, []);
    if (probe) {console.log(JSON.stringify(rows, null, 2)); return;}
    assert.deepEqual(rows.map(({label, objects, menu, status, preference}) => [label, objects, menu, status, preference]), [
      ["preferences off", false, "false", "false", false],
      ["initial", true, "true", "true", true],
      ["menu off", false, "false", "false", false],
      ["opened", false, "false", "false", false],
      ["popover on", true, "true", "true", true],
      ["reload", true, "true", "true", true],
      ["shortcut off", false, "false", "false", false],
      ["palette on", true, "true", "true", true]
    ]);
    const [preferencesOff, initial, menuOff, , popoverOn, reloaded, shortcutOff, paletteOn] = rows;
    assert.notEqual(initial.dot, menuOff.dot, "the status dot responds to Object Snap");
    for (const row of rows) {
      assert.equal(row.checkmark, row.objects, row.label + " paints the View checkmark");
      assert.equal(row.dot, row.objects ? initial.dot : menuOff.dot, row.label + " paints the status dot");
    }
    assert.deepEqual([initial.viaSnap, initial.padSnap], [via, pad]);
    assert.notDeepEqual(initial.farViaSnap, via);
    for (const before of [preferencesOff, initial, menuOff]) assert.deepEqual([before.grid, before.gridPreference, before.radius, before.distancePreference], [false, false, 10, 10]);
    for (const after of [popoverOn, reloaded, shortcutOff, paletteOn]) {
      assert.deepEqual([after.grid, after.gridPreference, after.radius, after.distancePreference], [true, true, 12, 12], after.label);
      assert.equal(after.pads, false, after.label);
    }
    for (const on of [popoverOn, reloaded, paletteOn]) {
      assert.deepEqual([on.viaSnap, on.farViaSnap], [via, via], on.label + " attracts the pointer to the via");
      assert.notDeepEqual(on.padSnap, pad, on.label + " keeps Pad centres off");
    }
    for (const off of [menuOff, shortcutOff, preferencesOff]) assert.notDeepEqual(off.viaSnap, via, off.label + " leaves the pointer off the via");
    console.log("PASS PCB object snap across menu, shortcut, palette, popover, Preferences and reload");
  } finally {await page.close();}
}

module.exports = run;
if (require.main === module) {
  (async () => {
    const browser = await chromium.launch(process.env.CHROME ? {executablePath:process.env.CHROME} : {channel:"chrome"});
    try {await run(browser, {probe:process.argv.includes("--probe")});} finally {await browser.close();}
  })().catch(error => {console.error(error); process.exitCode = 1;});
}
