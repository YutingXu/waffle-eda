"use strict";
// Macros walk: flag off, empty catalogue, recording in the status bar (and at capacity), the recorded
// draft in the editor, a step's arguments, invalid argument, missing parameter and alias conflict,
// an unavailable command, replay previewed in the shared review and applied as one Undo step, a
// stopped replay, stepwise cancellation, a stale preview, export and import.
// node tests/automation/browser-butter-macros-ui.cjs [--shots OUTPUT_DIRECTORY]
const assert = require("node:assert/strict");
const path = require("node:path");
const H = require("./butter-intel-ui-shared.cjs");

async function walk(browser, profile, shots) {
  const shot = (page, name, locator = ".panel-macros") => H.shot(page, shots && path.join(shots, profile.name), name, locator);
  const {page, errors} = await H.openDemo(browser, profile, []);
  const panel = page.locator(".panel-macros");
  const widths = ids => page.evaluate(ids => ids.map(id => AtriumNavHost.doc().items.find(i => i.id === id).width), ids);
  try {
    assert.equal(await page.evaluate(() => !!document.querySelector(".intel-recording") || !!globalThis.AtriumIntelUI), false);
    await page.evaluate(async () => { AtriumPrefs.set("butter.macros", true); await AtriumLazy.need("AtriumButterEditor"); });
    await page.waitForFunction(() => AtriumKeymap.command("assist.macros"));
    await page.evaluate(() => AtriumKeymap.command("assist.macros").run());
    await panel.locator(".ui-empty", {hasText:"No macros yet"}).waitFor();
    await shot(page, "1-empty");

    // Record a width change; the status bar shows the count, then capacity.
    await panel.locator(".pane-heading").getByRole("button", {name:"Record"}).click();
    await page.locator(".intel-recording", {hasText:"Recording · 0 steps"}).waitFor();
    const tracks = await page.evaluate(() => AtriumNavHost.doc().items.filter(i => i.kind === "track" && !i.locked).slice(0, 2).map(i => ({id:i.id, width:i.width})));
    const ids = tracks.map(t => t.id);
    await page.evaluate(id => { AtriumDock.reveal("properties"); AtriumNavHost.select([id], id); }, ids[0]);
    const width = page.locator("#inspector").getByLabel(/^Width \(/).first();
    await width.fill("0.63 mm");
    await width.press("Enter");
    await page.locator(".intel-recording", {hasText:"Recording · 1 step"}).waitFor();
    await shot(page, "2-recording", ".statusbar");
    await page.evaluate(() => AtriumIntelUI.showRecording({status:"recording", count:64, full:true}));
    await shot(page, "3-recording-full", ".statusbar");
    await page.locator(".intel-recording").getByRole("button", {name:"Stop"}).click();
    await panel.locator(".ui-section", {hasText:"New macro"}).waitFor();
    assert.equal(await page.locator(".intel-recording").count(), 0, "the indicator leaves the status bar");
    await shot(page, "4-editor");

    // A step's arguments; an invalid value; a missing parameter.
    await panel.locator(".ui-tree-row").first().click();
    await panel.getByLabel("width", {exact:true}).waitFor();
    await shot(page, "5-step");
    await panel.getByLabel("width", {exact:true}).fill("-1");
    await panel.getByLabel("width", {exact:true}).press("Tab");
    await panel.locator(".ui-prop-error", {hasText:"out of range"}).waitFor();
    await panel.getByRole("button", {name:"Add parameter"}).click();
    await panel.getByLabel("width source").selectOption({label:"Parameter value-1"});
    await panel.getByRole("button", {name:"Remove", exact:true}).first().click();
    await panel.locator(".ui-prop-error", {hasText:"Add parameter value-1"}).waitFor();
    await shot(page, "6-invalid");
    await panel.getByLabel("width source").selectOption({label:"Value"});
    await panel.getByLabel("width", {exact:true}).fill("0.5");
    await panel.getByLabel("Name").fill("Widen tracks");
    await panel.getByLabel("Alias").fill("widen");
    await panel.getByRole("button", {name:"Save macro"}).click();
    await panel.locator(".ui-row", {hasText:"Widen tracks"}).waitFor();

    // An alias conflict on a second macro, and a macro whose command is off.
    await page.evaluate(() => AtriumMacrosUI.edit({format:"waffle-macro", version:1, name:"Also widen", alias:"widen", parameters:[],
      steps:[{command:"butter.macros.set-track-width", args:{width:0.4}}]}, {draft:true}));
    await panel.getByRole("button", {name:"Save macro"}).click();
    await panel.locator(".ui-notice", {hasText:"Alias in use"}).waitFor();
    await shot(page, "7-alias-conflict");
    await panel.getByRole("button", {name:"Cancel"}).click();
    await page.evaluate(() => AtriumButterEditor.apply("butter.macros.save", {macro:{format:"waffle-macro", version:1, name:"Select thin tracks",
      alias:"thin", steps:[{command:"butter.query.search", args:{source:"track where width < 0.2 mm"}, select:true}]}}));
    await page.evaluate(() => AtriumMacrosUI.render());
    await panel.locator(".ui-row[data-state=broken]", {hasText:"Select thin tracks"}).waitFor();
    await shot(page, "8-catalogue");

    // Replay: steps and before/after in the shared review, applied as one Undo step.
    await page.evaluate(ids => AtriumNavHost.select(ids, ids[0]), ids);
    await panel.locator(".ui-row", {hasText:"Widen tracks"}).hover();
    await panel.locator(".ui-row", {hasText:"Widen tracks"}).getByRole("button", {name:"Run…"}).click();
    let dialog = page.locator("dialog[open].intel-review-dialog");
    await dialog.waitFor();
    await shot(page, "9-replay", "dialog[open].intel-review-dialog");
    await dialog.getByRole("button", {name:/^Apply/}).click();
    await panel.locator(".ui-notice", {hasText:"applied as one step"}).waitFor();
    assert.deepEqual(await widths(ids), [0.5, 0.5]);
    await shot(page, "10-applied");
    await panel.locator(".ui-notice").getByRole("button", {name:"Undo"}).click();
    await panel.locator(".ui-notice", {hasText:"Undone"}).waitFor();
    assert.deepEqual(await widths(ids), [0.63, tracks[1].width]);

    // Stopped: nothing selected, so the step fails and nothing changes.
    await page.evaluate(() => AtriumNavHost.select([]));
    await panel.locator(".ui-row", {hasText:"Widen tracks"}).hover();
    await panel.locator(".ui-row", {hasText:"Widen tracks"}).getByRole("button", {name:"Run…"}).click();
    dialog = page.locator("dialog[open].intel-review-dialog");
    await dialog.locator(".ui-notice", {hasText:"Stopped"}).waitFor();
    await shot(page, "11-replay-stopped", "dialog[open].intel-review-dialog");
    await dialog.getByRole("button", {name:"Cancel"}).click();

    // A stale preview: the design changes before Apply.
    await page.evaluate(ids => AtriumNavHost.select(ids, ids[0]), ids);
    await panel.locator(".ui-row", {hasText:"Widen tracks"}).hover();
    await panel.locator(".ui-row", {hasText:"Widen tracks"}).getByRole("button", {name:"Run…"}).click();
    dialog = page.locator("dialog[open].intel-review-dialog");
    await dialog.waitFor();
    await page.evaluate(id => { const h = AtriumNavHost; h.edit(() => { h.doc().items.find(i => i.id === id).width = 0.7; }, "Nudge"); }, ids[1]);
    await dialog.getByRole("button", {name:/^Apply/}).click();
    await dialog.locator(".ui-notice", {hasText:"Out of date"}).waitFor();
    await shot(page, "12-stale", "dialog[open].intel-review-dialog");
    await dialog.getByRole("button", {name:"Cancel"}).click();

    // Step by step, cancelled at the first step.
    await panel.locator(".ui-row", {hasText:"Widen tracks"}).hover();
    await panel.getByRole("button", {name:"More actions for Widen tracks"}).click();
    await page.getByRole("menuitem", {name:"Step through…"}).click();
    dialog = page.locator("dialog[open].intel-review-dialog");
    await dialog.waitFor();
    await dialog.getByRole("button", {name:"Cancel"}).click();
    await panel.locator(".ui-notice", {hasText:"Stopped at step 1"}).waitFor();
    await shot(page, "13-stepwise-stopped");

    // Export shows the package and its permissions.
    await panel.locator(".ui-row", {hasText:"Widen tracks"}).hover();
    await panel.getByRole("button", {name:"More actions for Widen tracks"}).click();
    await page.getByRole("menuitem", {name:"Export…"}).click();
    dialog = page.locator("dialog[open]");
    await dialog.getByText("widen.waffle-extension").waitFor();
    await shot(page, "14-export", "dialog[open]");
    await dialog.getByRole("button", {name:"Cancel"}).click();

    // Import opens a portable record in the editor before anything is saved.
    await panel.getByRole("button", {name:"Import…"}).first().click();
    dialog = page.locator("dialog[open]");
    await dialog.getByLabel("Macro record").fill(JSON.stringify({format:"waffle-macro", version:1, name:"Shared widen", alias:"shared-widen",
      steps:[{command:"butter.macros.set-track-width", args:{width:{$parameter:"width"}}}], parameters:[{name:"width", type:"number", default:0.3}]}));
    await dialog.getByRole("button", {name:"Open in editor"}).click();
    await panel.locator(".ui-badge", {hasText:"Imported"}).waitFor();
    await shot(page, "15-imported");

    await page.evaluate(() => AtriumPrefs.set("butter.macros", false));
    await page.waitForFunction(() => !document.querySelector(".panel-macros") && !AtriumKeymap.command("assist.macros"));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

H.runWalk(walk, "SKIP Macros panel walk: Playwright Core unavailable.", "PASS Macros panel: off, empty, recording and capacity, draft editor, invalid argument, missing parameter, alias conflict, unavailable command, reviewed replay with one Undo, stopped, stale, stepwise cancel, export, import.");
