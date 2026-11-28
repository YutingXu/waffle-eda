"use strict";
// Leaving a project (app/project/leave-project.js): one ordered transaction asks an editor tab, an unfinished review
// note, an unapplied table entry and the project's save prompt, in that order. A cancel at any step keeps the project
// and every piece of work; work changed while the destination loads asks again; and a foreign import's Discard deletes
// its recovery copy only when the switch commits, so a cancel after it keeps the copy.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), {pathToFileURL} = require("node:url");
const url = pathToFileURL(path.join(__dirname, "../../app/index.html")).href;
const kicad = fs.readFileSync(path.join(__dirname, "../fixtures/import/review/proto/p.kicad_pcb"), "utf8");
const PROMPTS = {tab: "Discard the probe tab?", note: "Discard the unfinished review note?", table: "Discard the table entry you have not applied?"};

async function boot(browser) {
  const page = await browser.newPage({viewport: {width: 1400, height: 900}, reducedMotion: "reduce"});
  page.errors = []; page.on("pageerror", e => page.errors.push(e.message)); page.setDefaultTimeout(10000);
  await require("../fixtures/notebook-labs.cjs").profile(page);
  await page.goto(url);
  await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
  await page.locator("#doc-name", {hasText: "Sensor board"}).waitFor();
  // confirm() answers come from __answers (true: discard, false: keep); every question is logged.
  await page.evaluate(PROMPTS => {
    globalThis.__asked = []; globalThis.__answers = [];
    globalThis.confirm = text => { __asked.push(text); return __answers.length ? __answers.shift() : false; };
    globalThis.__other = () => Atrium.project("Other project", AtriumParts.catalogue);
    globalThis.__PROMPTS = PROMPTS;
  }, PROMPTS);
  return page;
}

// An editor tab, a sticky note being edited, a table with a typed entry, and an unsaved project.
async function arrange(page) {
  await page.evaluate(async () => {
    const h = AtriumNavHost; h.selectDocument(h.project().documents.find(d => d.kind === "schematic").id);
    await AtriumLazy.need(["AtriumDocViews", "AtriumSheetWidgetEditor", "AtriumRichText"]);
    // A tab that remembers a Discard for its current draft, as the symbol and footprint editors do.
    const tab = globalThis.__tab = {draft: "first", discarded: null};
    AtriumDocViews.open("probe-tab", {title: "Probe", mount() {},
      mayDiscard: () => { if (tab.discarded === tab.draft) return true; if (!confirm(__PROMPTS.tab)) return false; tab.discarded = tab.draft; return true; },
      keep: () => { tab.discarded = null; }});
    AtriumDocViews.showCanvas();
  });
  // A sticky note, placed from the / palette and finished once.
  await page.locator("#canvas").focus(); await page.keyboard.press("/");
  const palette = page.locator("dialog[open]").last();
  await palette.locator("input").first().fill("Sticky note");
  await palette.getByRole("option", {name: /Sticky note/i}).first().click(); await palette.waitFor({state: "hidden"});
  await page.getByRole("textbox", {name: "Engineering note"}).fill("Reviewed");
  await page.getByRole("button", {name: "Finish editing"}).click();
  await page.evaluate(async () => {
    const h = AtriumNavHost, table = AtriumSheetWidgets.make("table", [12, 20]);
    globalThis.__note = h.selection()[0];
    h.edit(() => { h.doc().items.push(table); }, "Place table", [table]);
    await AtriumPrefs.set("butter.tables", true);
    h.select([table.id], table.id); AtriumSheetWidgetEditor.open(table.id, h);
  });
  await page.getByRole("button", {name: "Upgrade to full table"}).click();
  const dialog = page.getByRole("dialog", {name: "Edit table", exact: true});
  await dialog.getByRole("grid").waitFor();
  await dialog.getByRole("textbox", {name: "Cell contents or formula"}).fill("Typed, not applied");
  await page.evaluate(async () => {
    const h = AtriumNavHost; await AtriumRichTextEditor.open(h, h.doc().items.find(i => i.id === __note));
    const root = document.querySelector(".rn-editor"); root.firstElementChild.append(" with an unfinished comment");
  });
}

const state = page => page.evaluate(() => ({
  project: AtriumNavHost.project().name, tab: AtriumDocViews.isOpen("probe-tab"), dirty: AtriumNavHost.isDirty(),
  note: document.querySelector(".rn-editor")?.textContent.includes("unfinished comment") || false,
  table: document.querySelector("dialog.table-editor[open] textarea")?.value || null
}));

async function switchWith(page, answers, projectChoice) {
  await page.evaluate(answers => { __asked.length = 0; __answers = answers; globalThis.__switch = AtriumNavHost.replaceProject(__other()); }, answers);
  if (projectChoice) {
    const prompt = page.locator("dialog[open]").filter({has: page.getByRole("button", {name: "Don’t Save", exact: true})});
    // The keyboard: a click outside the open note would finish it (rich-text-editor.js), which is not under test here.
    await prompt.getByRole("button", {name: projectChoice, exact: true}).press("Space");
  }
  // A switch still waiting reports "waiting" (a prompt that should not be there) instead of hanging the suite.
  return page.evaluate(async () => ({switched: await Promise.race([__switch, new Promise(r => setTimeout(() => r("waiting"), 4000))]), asked: [...__asked]}));
}

module.exports = async function leaveProject(browser) {
  let page = await boot(browser);
  try {
    await arrange(page);
    const kept = {project: "Sensor interface", tab: true, dirty: true, note: true, table: "Typed, not applied"};
    assert.deepEqual(await state(page), kept, "every participant holds unsaved work");
    const order = [PROMPTS.tab, PROMPTS.note, PROMPTS.table];
    // Cancel at each step: the earlier answers are forgotten, the later participants are never asked.
    for (let step = 0; step < order.length; step++) {
      const answers = [...Array(step).fill(true), false];
      const r = await switchWith(page, answers);
      assert.deepEqual(r, {switched: false, asked: order.slice(0, step + 1)}, "cancel at step " + (step + 1));
      assert.deepEqual(await state(page), kept, "cancel at step " + (step + 1) + " keeps the project and all its work");
    }
    // The project's save prompt comes last; its Cancel keeps everything too.
    let r = await switchWith(page, [true, true, true], "Cancel");
    assert.deepEqual(r, {switched: false, asked: order}, "the project's save prompt asks after every other participant");
    assert.deepEqual(await state(page), kept, "Cancel in the save prompt keeps the project and all its work");

    // Edits made while the destination loads ask again, before the commit.
    r = await page.evaluate(async () => {
      __asked.length = 0; __answers = [true, true, true];
      const loading = AtriumNavHost.replaceProject(__other(), {force: true});
      // The note changes after its Discard: that answer no longer holds.
      document.querySelector(".rn-editor").firstElementChild.append(" and more");
      __answers = [false];
      return {switched: await loading, asked: [...__asked]};
    });
    assert.deepEqual(r, {switched: false, asked: [...order, PROMPTS.note]},
      "a note edited during the load asks again; the unchanged tab and table keep their answers");
    // force settles only the project's own prompt: the tab, the note and the table still ask.
    r = await page.evaluate(async () => {
      __asked.length = 0; __answers = [true, true, false];
      return {switched: await AtriumNavHost.replaceProject(__other(), {force: true}), asked: [...__asked]};
    });
    assert.deepEqual(r, {switched: false, asked: order}, "a forced switch still asks every holder of unsaved input");
    // An edit to the project during the load makes the save prompt ask again (it was clean when asked).
    r = await page.evaluate(async () => {
      for (const id of ["probe-tab"]) AtriumDocViews.close(id);
      AtriumRichTextEditor.close(false); document.querySelector("dialog.table-editor[open]")?.close();
      const h = AtriumNavHost, p = JSON.parse(JSON.stringify(h.project()));
      await h.replaceProject(p, {force: true, dirty: false});
      __asked.length = 0;
      globalThis.__switch = h.replaceProject(__other());
      h.edit(() => { h.doc().name += " (edited while loading)"; }, "Rename sheet");
      return {dirty: h.isDirty()};
    });
    assert.deepEqual(r, {dirty: true});
    await page.locator("dialog[open]").getByRole("button", {name: "Cancel", exact: true}).press("Space");
    r = await page.evaluate(async () => ({switched: await __switch, name: AtriumNavHost.doc().name, project: AtriumNavHost.project().name}));
    assert.equal(r.switched, false, "a project edited while the destination loaded asks to save before it goes");
    assert.ok(r.name.endsWith("(edited while loading)") && r.project === "Sensor interface");
    // Accepting every prompt switches, and the tab and the editors close with the old project.
    r = await switchWith(page, [], "Don’t Save");
    assert.deepEqual(r, {switched: true, asked: []});
    assert.equal(await page.evaluate(() => AtriumNavHost.project().name), "Other project");
    assert.deepEqual(page.errors, []);
    await page.close();

    // A foreign import's Discard deletes its recovery copy only at the commit: a cancel after it keeps the copy.
    page = await boot(browser);
    await page.evaluate(text => { globalThis.__opening = AtriumNavHost.openFiles([new File([text], "Leave.kicad_pcb")]); }, kicad);
    await page.getByRole("button", {name: "Open here", exact: true}).click();
    const recovery = await page.evaluate(async () => {
      const h = AtriumNavHost;
      if (!await __opening) throw Error("The KiCad fixture did not open");
      const id = h.importSession()?.id, heads = async () => (await AtriumFolderDrafts.storage.list("foreign-import-v1")).map(r => r.writer);
      await AtriumLazy.need("AtriumDocViews");
      // A tab that lets the close go once, then has new work when the close re-checks before its commit.
      let calls = 0;
      AtriumDocViews.open("probe-late", {title: "Late", mount() {}, mayDiscard: () => ++calls === 1});
      AtriumDocViews.showCanvas();
      const before = await heads();
      globalThis.__closing = h.act("close-project");
      return {id, before, needsReview: AtriumForeignDrafts.needsReview(h)};
    });
    assert.ok(recovery.id && recovery.needsReview && recovery.before.includes(recovery.id), "the import has a recovery copy");
    await page.locator("dialog.foreign-import-close [data-choice=discard]").click();
    const cancelled = await page.evaluate(async id => {
      await new Promise(r => setTimeout(r, 300));
      const heads = (await AtriumFolderDrafts.storage.list("foreign-import-v1")).map(r => r.writer);
      return {starter: AtriumNavHost.isStarter(), session: AtriumNavHost.importSession()?.id, kept: heads.includes(id)};
    }, recovery.id);
    assert.deepEqual(cancelled, {starter: false, session: recovery.id, kept: true}, "Discard then a cancel keeps the project and its recovery copy");
    // Discard with nothing else holding the close: the copy goes once the project has left.
    await page.evaluate(() => { AtriumDocViews.close("probe-late"); globalThis.__closing = AtriumNavHost.act("close-project"); });
    await page.locator("dialog.foreign-import-close [data-choice=discard]").click();
    await page.waitForFunction(() => AtriumNavHost.isStarter());
    await page.waitForFunction(async id => !(await AtriumFolderDrafts.storage.list("foreign-import-v1")).some(r => r.writer === id), recovery.id);
    assert.deepEqual(page.errors, []);
    console.log("PASS leave project: ordered prompts, cancel at each step, edits during load, force asks the work holders, recovery copy kept on cancel");
  } finally { await page.close(); }
};

if (require.main === module) (async () => {
  const browser = await require("../support/playwright.cjs").chromium.launch(process.env.CHROME ?
    {executablePath: process.env.CHROME} : {channel: "chrome"});
  try { await module.exports(browser); } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
