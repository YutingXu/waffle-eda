"use strict";
// Ask AI panel walk: flag off, no provider, approval required, opted out, access settings, keychain
// states, working and stopped, answered with citations that cross-probe, suggested change reviewed and
// applied as one Undo step, out of date, failed, activity and its retention, and the "/" palette entry.
// node tests/automation/browser-butter-ai-ui.cjs [--shots OUTPUT_DIRECTORY]
const assert = require("node:assert/strict");
const path = require("node:path");
const H = require("./butter-intel-ui-shared.cjs");

const hosted = {
  "waffle-extension.json":JSON.stringify({id:"waffle.hosted-ai-example", name:"Hosted AI example", version:"1.0.0", apiVersion:1, main:"provider.js",
    permissions:["ai:provider", "network:provider.invalid"],
    contributes:{aiProviders:[{id:"hosted", label:"Hosted provider", entry:"provider.js", hosts:["provider.invalid"], auth:"bearer"}]}}),
  "provider.js":"module.exports.respond = async () => ({type:\"answer\", text:\"Offline.\"});"
};

async function walk(browser, profile, shots) {
  const shot = (page, name, locator = ".panel-ask") => H.shot(page, shots && path.join(shots, profile.name), name, locator);
  const {page, errors} = await H.openDemo(browser, profile, []);
  try {
    // Flag off: nothing loads, no command, no panel.
    const off = await page.evaluate(() => ({ui:!!globalThis.AtriumIntelUI, command:!!AtriumKeymap.command("assist.ask-ai"),
      panel:!!document.querySelector(".intel-panel")}));
    assert.deepEqual(off, {ui:false, command:false, panel:false});
    await page.evaluate(async () => {
      AtriumPrefs.set("butter.query", true);
      AtriumPrefs.set("butter.ai", true);
      await AtriumLazy.need("AtriumButterEditor");
    });
    await page.waitForFunction(() => AtriumKeymap.command("assist.ask-ai"));
    await page.evaluate(() => AtriumKeymap.command("assist.ask-ai").run());
    await page.locator(".panel-ask .ui-empty", {hasText:"No AI provider"}).waitFor();
    await shot(page, "1-no-provider");

    // Approval required: installed, provider permission withheld.
    await page.evaluate(async pkg => {
      await AtriumLazy.need("AtriumExtensions");
      const host = AtriumNavHost;
      AtriumExtensions.attach({project:host.project, documentId:host.currentId, revision:host.revision, selection:() => new Set(host.selection()), info:host.info},
        {consent:request => request.kind === "install" ? {"network:provider.invalid":true} : true});
      await AtriumExtensions.install(pkg);
      await AtriumExtensions.grant("waffle.hosted-ai-example", "ai:provider", false);
      await AtriumAskUI.refresh();
    }, hosted);
    await page.locator(".panel-ask .ui-notice", {hasText:"Approval required"}).waitFor();
    await shot(page, "2-approval-required");
    await page.evaluate(() => AtriumExtensions.uninstall("waffle.hosted-ai-example"));

    // Opted out: an approved provider, but this project has not allowed requests.
    await H.installProvider(page);
    await page.evaluate(() => AtriumAskUI.refresh());
    await page.locator(".panel-ask .ui-notice", {hasText:"Not shared with AI"}).waitFor();
    assert.equal(await page.locator(".intel-composer-input").isDisabled(), true, "the composer waits for consent");
    await shot(page, "3-opted-out");

    // Access: allow this project and the query tool. A hosted provider shows its keychain state.
    await page.locator(".panel-ask .ui-notice").getByRole("button", {name:"Allow…"}).click();
    await page.getByRole("switch", {name:"Allow AI requests for this project"}).check();
    await page.getByRole("checkbox", {name:"Design queries"}).check();
    await page.waitForFunction(async () => (await AtriumButter.run("butter.ai.policy")).result.tools.includes("query"));
    await page.evaluate(async pkg => {
      let saved = false;
      globalThis.AtriumHost = Object.assign(globalThis.AtriumHost ?? {}, {async aiCredential(operation) {
        if (operation === "configure") saved = true;
        if (operation === "forget") saved = false;
        return {available:true, configured:saved, maxBytes:4096};
      }});
      AtriumExtensions.attach({project:AtriumNavHost.project, documentId:AtriumNavHost.currentId, revision:AtriumNavHost.revision,
        selection:() => new Set(AtriumNavHost.selection()), info:AtriumNavHost.info},
        {consent:request => request.kind === "install" ? {"ai:provider":true, "network:provider.invalid":true, "propose:edits":true} : true});
      await AtriumExtensions.install(pkg);
      await AtriumAskUI.refresh(true);
    }, hosted);
    await page.locator(".panel-ask .ui-row", {hasText:"Hosted provider"}).getByText("No key").waitFor();
    await shot(page, "4-access");
    await page.locator(".panel-ask .ui-row", {hasText:"Hosted provider"}).getByRole("button", {name:"Add key…"}).click();
    await page.locator(".panel-ask .ui-row", {hasText:"Hosted provider"}).getByText("Key in keychain").waitFor();
    await page.evaluate(() => AtriumExtensions.uninstall("waffle.hosted-ai-example"));
    await page.evaluate(() => { AtriumAskUI.setTab("ask"); return AtriumAskUI.refresh(); });

    // Working, then stopped.
    const input = page.locator(".intel-composer-input");
    await input.fill("Hold on while you look.");
    await input.press("Enter");
    await page.locator(".panel-ask .ui-status-line", {hasText:"Asking"}).waitFor();
    await shot(page, "5-working");
    await input.press("Escape");
    await page.locator(".panel-ask .ui-notice", {hasText:"Stopped"}).waitFor();

    // Answered with inline citations; a source cross-probes to the canvas.
    await input.fill("Which parts are on the board?");
    await input.press("Enter");
    await page.locator(".panel-ask .intel-answer").last().waitFor();
    await page.locator(".panel-ask .ui-turn[data-role=tool]").last().waitFor();
    await shot(page, "6-answered");
    const probed = await page.evaluate(async () => {
      const turn = AtriumAskUI.turns.at(-1), cited = turn.result.citations[0].evidence.row.id;
      document.querySelector(".panel-ask .intel-answer .ui-cite").click();
      await new Promise(r => setTimeout(r, 300));
      return {cited, selected:AtriumNavHost.selection()};
    });
    assert.deepEqual(probed.selected, [probed.cited], "a citation selects its source");

    // A suggested change: review shows before and after; apply is one Undo step.
    await page.evaluate(() => AtriumButterEditor.apply("butter.ai.set-policy", {allowed:true, tools:["query"], proposeEdits:true}));
    const part = await page.evaluate(() => { const p = AtriumNavHost.doc().items.find(i => i.kind === "part" && i.ref === "R1"); AtriumNavHost.select([p.id]); return {id:p.id, value:p.value}; });
    await page.evaluate(() => AtriumAskUI.refresh());
    await input.fill("Rename the value with its tolerance.");
    await input.press("Enter");
    await page.locator(".panel-ask .ui-section", {hasText:"Suggested change"}).waitFor();
    await shot(page, "7-suggested");
    await page.getByRole("button", {name:"Review…"}).click();
    const dialog = page.locator("dialog[open].intel-review-dialog");
    await dialog.waitFor();
    assert.match(await dialog.textContent(), /10k 1%/);
    await shot(page, "8-review", "dialog[open].intel-review-dialog");
    await dialog.getByRole("button", {name:"Apply change"}).click();
    await page.locator(".panel-ask .ui-notice", {hasText:"applied as one step"}).waitFor();
    assert.equal(await page.evaluate(id => AtriumNavHost.doc().items.find(i => i.id === id).value, part.id), "10k 1%");
    await shot(page, "9-applied");
    await page.locator(".panel-ask .ui-notice", {hasText:"applied as one step"}).getByRole("button", {name:"Undo"}).click();
    await page.locator(".panel-ask .ui-notice", {hasText:"Undone"}).waitFor();
    assert.equal(await page.evaluate(id => AtriumNavHost.doc().items.find(i => i.id === id).value, part.id), part.value);

    // Out of date: the selection changes while the provider works.
    await input.fill("Hold this one too.");
    await input.press("Enter");
    await page.locator(".panel-ask .ui-status-line", {hasText:"Asking"}).waitFor();
    await page.evaluate(() => AtriumNavHost.select([]));
    await page.locator(".panel-ask .ui-notice", {hasText:"changed while asking"}).waitFor({timeout:12000});
    await shot(page, "10-out-of-date");
    // Failed: the provider replies with something unusable.
    await input.fill("Fail please.");
    await input.press("Enter");
    await page.locator(".panel-ask .ui-notice", {hasText:"could not be used"}).waitFor();

    // Activity: redacted rows, failed attempts and the retention note; then full retention.
    await page.evaluate(() => AtriumAskUI.setTab("activity"));
    await page.locator(".panel-ask .ui-section", {hasText:"Recent requests"}).waitFor();
    assert.ok(await page.locator(".panel-ask .ui-badge", {hasText:"Out of date"}).count() > 0);
    await shot(page, "11-activity");
    await page.evaluate(async () => {
      const id = AtriumNavHost.project().id, rows = [];
      for (let i = 0; i < 40; i++) rows.push({provider:"waffle.local-ai-example:local", at:Date.now() - i * 60000, promptExcerpt:"Question " + (40 - i),
        promptCharacters:10, readTools:[{tool:"query", rows:3, fields:["id", "kind"]}], result:i % 7 ? "answered" : "provider_failed"});
      AtriumAIProvidersDesktop.local(id, "activity", rows.reverse());
      AtriumAskUI.setTab("activity");
    });
    await page.locator(".panel-ask .ui-section-note", {hasText:"Full"}).waitFor();
    await shot(page, "12-activity-full");
    await page.getByRole("button", {name:"Clear…"}).click();
    await page.locator("dialog[open]").getByRole("button", {name:"Clear"}).click();
    await page.locator(".panel-ask .ui-empty", {hasText:"No requests yet"}).waitFor();

    // The "/" palette offers Ask AI for free text; choosing it fills the composer without sending.
    const offered = await page.evaluate(() => AtriumIntelUI.paletteRows("How many vias are on the board?").map(r => r.label));
    assert.deepEqual(offered, ["Ask AI: How many vias are on the board?"]);
    await page.evaluate(() => AtriumIntelUI.paletteRows("How many vias are on the board?")[0].run());
    await page.waitForFunction(() => document.querySelector(".intel-composer-input")?.value);
    assert.equal(await input.inputValue(), "How many vias are on the board?");
    assert.equal(await page.evaluate(() => AtriumAskUI.turns.at(-1).prompt), "Fail please.", "opening from the palette sends nothing");

    // Flag off again removes the panel.
    await page.evaluate(() => AtriumPrefs.set("butter.ai", false));
    await page.waitForFunction(() => !document.querySelector(".panel-ask") && !AtriumKeymap.command("assist.ask-ai"));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

H.runWalk(walk, "SKIP Ask AI panel walk: Playwright Core unavailable.", "PASS Ask AI panel: off, no provider, approval, opt-out, access and keychain, working, stopped, answered with cross-probing citations, reviewed suggestion with one Undo, out of date, failed, activity and retention.");
