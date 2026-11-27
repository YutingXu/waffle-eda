"use strict";
// Links walk: on by default, the Links disclosure in Properties, the target picker, a stored link created
// and removed in one Undo step, a broken link inspected and rebound, references grouped with what would
// break, paging, a Git commit reference, project links with a missing source, a net anchor, Open link
// feedback, objects without an identity, multiple selection, the palette's Open link row and the off switch.
// node tests/project/browser-butter-links-ui.cjs [--shots OUTPUT_DIRECTORY]
const assert = require("node:assert/strict");
const path = require("node:path");
const H = require("../automation/butter-intel-ui-shared.cjs");

async function walk(browser, profile, shots) {
  const shot = (page, name, locator = ".intel-links") => H.shot(page, shots && path.join(shots, profile.name), name, locator);
  const {page, errors} = await H.openDemo(browser, profile, []);
  const links = page.locator("#inspector .intel-links");
  const select = ids => page.evaluate(ids => { AtriumDock.reveal("properties"); AtriumNavHost.select(ids, ids[0]); }, ids);
  const count = () => page.evaluate(() => Object.keys(AtriumNavHost.project().links ?? {}).length);
  const pickFirst = async text => {
    const dialog = page.locator("dialog[open]");
    await dialog.getByRole("searchbox").fill(text);
    await dialog.locator(".ui-row").first().click();
    await dialog.getByRole("button", {name:"Choose"}).click();
  };
  try {
    const ids = await page.evaluate(() => AtriumNavHost.doc().items.filter(i => i.kind === "track").slice(0, 6).map(i => i.id));
    // Links has graduated: a fresh profile shows the section without setting butter.links.
    assert.equal(await page.evaluate(() => AtriumPrefs.changed()["butter.links"]), undefined);
    await page.evaluate(() => AtriumLazy.need("AtriumButterEditor"));
    await select([ids[0]]);
    await links.waitFor();
    await links.locator(".ui-empty", {hasText:"No stored links start here"}).waitFor();
    await shot(page, "1-empty");

    // Add a link through the picker; one Undo removes it.
    await links.getByRole("button", {name:"Add link from this object…"}).click();
    await page.locator("dialog[open] .intel-picker").waitFor();
    await page.locator("dialog[open]").getByRole("searchbox").fill("VDD");
    await shot(page, "2-picker", "dialog[open]");
    await page.locator("dialog[open]").getByRole("searchbox").fill("");
    await pickFirst(await page.evaluate(id => { const i = AtriumNavHost.doc().items.find(x => x.id === id); return "Track · " + i.net; }, ids[1]));
    await page.waitForFunction(() => Object.keys(AtriumNavHost.project().links ?? {}).length === 1);
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.equal(await count(), 0, "one Undo removes the new link");
    await page.evaluate(() => AtriumNavHost.act("redo"));
    assert.equal(await count(), 1);

    // A broken link: its target is deleted. Inspect, then rebind in one Undo step.
    await page.evaluate(async ids => {
      const h = AtriumNavHost, p = h.project(), f = o => AtriumLinks.format({projectId:p.id, objectId:o});
      await AtriumButterEditor.apply("butter.links.create", {sourceId:ids[0], url:f(ids[2]), label:"Old stub"});
      h.edit(() => { const d = h.doc(); d.items.splice(d.items.findIndex(i => i.id === ids[2]), 1); }, "Delete stub");
      h.select([ids[0]], ids[0]);
    }, ids);
    await links.locator(".ui-row[data-state=broken]", {hasText:"Old stub"}).waitFor();
    await shot(page, "3-broken");
    await links.locator(".ui-row[data-state=broken]").hover();
    await links.getByRole("button", {name:"Inspect…"}).click();
    await page.locator("dialog[open]").getByText("The target was deleted").waitFor();
    await shot(page, "4-broken-dialog", "dialog[open]");
    await page.locator("dialog[open]").getByRole("button", {name:"Choose replacement…"}).click();
    await page.locator("dialog[open] .intel-picker").waitFor();
    await pickFirst(await page.evaluate(id => "Track · " + AtriumNavHost.doc().items.find(x => x.id === id).net, ids[3]));
    await links.locator(".ui-row[data-state=broken]").waitFor({state:"detached"});
    await page.evaluate(() => AtriumNavHost.act("undo"));
    await links.locator(".ui-row[data-state=broken]").waitFor();
    await page.evaluate(() => AtriumNavHost.act("redo"));

    // References to the selected object, with what a deletion would break; a row cross-probes.
    await select([ids[1]]);
    await links.locator(".ui-section", {hasText:"Referenced by"}).locator(".ui-section-note", {hasText:"Deleting this object"}).waitFor();
    await shot(page, "5-backlinks");
    await links.locator(".ui-section", {hasText:"Referenced by"}).locator(".ui-row").first().click();
    await page.waitForFunction(id => AtriumNavHost.selection()[0] === id, ids[0]);

    // Paging a larger set of references.
    await page.evaluate(async target => {
      const h = AtriumNavHost, p = h.project(), url = AtriumLinks.format({projectId:p.id, objectId:target});
      const sources = h.doc().items.filter(i => AtriumLinkRecord.id(i.id) && i.id !== target).slice(0, 24);
      for (const s of sources) await AtriumButterEditor.apply("butter.links.create", {sourceId:s.id, url});
    }, ids[1]);
    await select([ids[1]]);
    await links.getByRole("button", {name:/^Show \d+ more$/}).waitFor();
    await shot(page, "6-paged");

    // A Git commit that names the object (imported by History) is listed by its subject.
    await page.evaluate(async id => {
      const p = AtriumNavHost.project(), url = AtriumLinks.format({projectId:p.id, objectId:id});
      (await AtriumLazy.need("AtriumLinksDesktop")).index(p.id).importCommits([{revision:"c".repeat(40), subject:"Widen the filter track", recordLinks:[url]}]);
      AtriumLinksUI.refresh();
    }, ids[1]);
    await links.locator(".ui-section", {hasText:"Referenced by"}).locator(".ui-row", {hasText:"Widen the filter track"}).waitFor();
    await page.evaluate(() => AtriumLinksDesktop.index(AtriumNavHost.project().id).importCommits([], {replace:true}));

    // Nothing selected: every stored link with its health, including a missing source.
    await page.evaluate(id => { const h = AtriumNavHost; h.edit(() => { const d = h.doc(); d.items.splice(d.items.findIndex(i => i.id === id), 1); }, "Delete source"); h.select([]); }, ids[4]);
    await links.locator(".ui-section", {hasText:"Links in this project"}).waitFor();
    await links.locator(".ui-row[data-state=broken]").first().waitFor();
    await shot(page, "7-project");

    // A net through an explicit anchor.
    await select([ids[5]]);
    await links.getByRole("button", {name:"Add link from this object…"}).click();
    const net = await page.evaluate(() => AtriumNavHost.doc().items.find(i => i.kind === "track" && i.net).net);
    await page.locator("dialog[open]").getByRole("searchbox").fill(net);
    await page.locator("dialog[open] .ui-row", {hasText:"Creates anchor"}).first().click();
    await page.locator("dialog[open]").getByRole("button", {name:"Choose"}).click();
    await page.waitForFunction(() => Object.keys(AtriumNavHost.project().linkAnchors ?? {}).length === 1);

    // Open link: not a link, a missing object, and a found object.
    await page.evaluate(() => AtriumKeymap.command("assist.open-link").run());
    let dialog = page.locator("dialog[open]");
    await dialog.getByLabel("Waffle link").fill("https://example.invalid");
    await dialog.getByRole("button", {name:"Open"}).click();
    await dialog.locator(".ui-notice", {hasText:"not a Waffle link"}).waitFor();
    const missing = await page.evaluate(id => AtriumLinks.format({projectId:AtriumNavHost.project().id, objectId:id}), ids[2]);
    await dialog.getByLabel("Waffle link").fill(missing);
    await dialog.getByRole("button", {name:"Open"}).click();
    await dialog.locator(".ui-notice", {hasText:"object for this link is missing"}).waitFor();
    await shot(page, "8-open-missing", "dialog[open]");
    const found = await page.evaluate(id => AtriumLinks.format({projectId:AtriumNavHost.project().id, objectId:id}), ids[3]);
    await dialog.getByLabel("Waffle link").fill(found);
    await dialog.getByRole("button", {name:"Open"}).click();
    await page.waitForFunction(id => AtriumNavHost.selection()[0] === id, ids[3]);

    // No identity yet, and several objects selected.
    const part = await page.evaluate(() => AtriumNavHost.doc().items.find(i => i.kind === "part").id);
    await select([part]);
    await links.locator(".ui-empty", {hasText:"no saved identity"}).waitFor();
    await shot(page, "9-no-identity");
    await select([ids[0], ids[1]]);
    await links.locator(".ui-empty", {hasText:"Select one object"}).waitFor();

    assert.deepEqual(await page.evaluate(url => AtriumIntelUI.paletteRows(url).map(r => r.label), found), ["Open link"]);
    await page.evaluate(() => AtriumPrefs.set("butter.links", false));
    await page.waitForFunction(() => !document.querySelector("#inspector .intel-links") && !AtriumKeymap.command("assist.open-link"));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

H.runWalk(walk, "SKIP Links walk: Playwright Core unavailable.", "PASS Links in Properties: on by default, empty, picker, create and one Undo, broken and rebind, references, paging, Git commit, project links, net anchor, open feedback, no identity, multiple selection, off switch.");
