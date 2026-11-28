"use strict";
// Query panel walk: flag off, empty input, completions, a located unit error, matches that cross-probe,
// document scope, exact zero, paging, an edit that refreshes without obsolete rows, saving, duplicate
// names, rename and delete, a missing saved group, read-only, rule applicability with full and partial
// coverage, and the palette's row into the panel.
// node tests/checks/browser-butter-query-ui.cjs [--shots OUTPUT_DIRECTORY]
const assert = require("node:assert/strict");
const path = require("node:path");
const H = require("../automation/butter-intel-ui-shared.cjs");

async function walk(browser, profile, shots) {
  const shot = (page, name, locator = ".panel-design-query") => H.shot(page, shots && path.join(shots, profile.name), name, locator);
  const {page, errors} = await H.openDemo(browser, profile, []);
  const panel = page.locator(".panel-design-query");
  const status = () => panel.locator(".ui-status-line").first().textContent();
  try {
    assert.equal(await page.evaluate(() => !!globalThis.AtriumIntelUI || !!AtriumKeymap.command("assist.design-query")), false);
    await page.evaluate(async () => { AtriumPrefs.set("butter.query", true); await AtriumLazy.need("AtriumButterEditor"); });
    await page.waitForFunction(() => AtriumKeymap.command("assist.design-query"));
    await page.evaluate(() => AtriumKeymap.command("assist.design-query").run());
    await panel.locator(".ui-empty").waitFor();
    await shot(page, "1-empty");

    // Completion: kinds first, accepted with Tab.
    const input = panel.locator(".intel-query-source");
    await input.click();
    await page.keyboard.type("capa");
    await panel.locator(".ui-select-option", {hasText:"capacitor"}).waitFor();
    await shot(page, "2-completion");
    await page.keyboard.press("Tab");
    assert.equal(await input.inputValue(), "capacitor ");

    // A located unit error.
    await input.fill("resistor where value < 1 V");
    await panel.locator(".ui-error-span").waitFor();
    await shot(page, "3-unit-error");

    // Matches; a row cross-probes to the canvas; scope narrows to the document.
    await input.fill("resistor where value < 100 kΩ");
    await panel.locator(".ui-status-line", {hasText:"4 matches"}).waitFor();
    await shot(page, "4-matches");
    const probed = await page.evaluate(() => {
      const row = AtriumQueryUI.rows()[2];
      document.querySelectorAll(".panel-design-query .ui-list .ui-row")[2].click();
      return {want:row.id, doc:row.documentId};
    });
    await page.waitForFunction(({want,doc}) => AtriumNavHost.currentId() === doc &&
      AtriumNavHost.selection().length === 1 && AtriumNavHost.selection()[0] === want, probed);
    await panel.getByRole("button", {name:"Document"}).click();
    await panel.locator(".ui-status-line", {hasText:"2 matches"}).waitFor();
    await panel.getByRole("button", {name:"Project"}).click();

    // A named net is a query result with a synthetic row ID. Activating it uses
    // the net's model members on the scoped board.
    await page.evaluate(() => {
      const h=AtriumNavHost;
      h.selectDocument(h.project().documents.find(d=>d.kind==="pcb").id);
    });
    await panel.getByRole("button",{name:"Document"}).click();
    await input.fill('net where name = "GND"');
    await panel.getByRole("option",{name:/GND/}).click();
    await page.waitForFunction(()=>AtriumNavHost.highlight()==="GND" && AtriumNavHost.selection().length>0);
    await panel.getByRole("button",{name:"Project"}).click();

    // Exact zero is its own state.
    await input.fill("resistor where value > 1 GΩ");
    await panel.locator(".ui-status-line", {hasText:"No matches"}).waitFor();
    await panel.locator(".ui-empty", {hasText:"Nothing in"}).waitFor();
    await shot(page, "5-no-matches");

    // Paging a larger result.
    await page.evaluate(() => {
      AtriumQueryUI.pageSize = 5;
      const service = AtriumQueryService;
      globalThis.AtriumQueryService = {...service,async search(query, options) {
        const result = await service.search(query, options);
        await new Promise(resolve => { window.finishQueryFixture = resolve; });
        globalThis.AtriumQueryService = service;
        return result;
      }};
    });
    await input.fill("track where width > 0 mm");
    const firstMatch = await panel.locator(".ui-list .ui-row").first().elementHandle();
    await firstMatch.evaluate(row => row.parentElement.focus());
    await page.waitForFunction(() => window.finishQueryFixture);
    await page.evaluate(() => window.finishQueryFixture());
    await panel.locator(".ui-status-line", {hasText:/Showing 5 of \d+/}).waitFor();
    assert.equal(await firstMatch.evaluate(row => row.isConnected && document.activeElement === row.parentElement), true,
      "The final count keeps streamed rows and list focus.");
    await shot(page, "6-paged");
    await panel.getByRole("button", {name:/^Show \d+ more$/}).click();
    await panel.locator(".ui-status-line", {hasText:/Showing 10 of \d+/}).waitFor();
    assert.equal(await firstMatch.evaluate(row => row.isConnected), true, "Paging keeps the first page's rows.");
    await firstMatch.dispose();
    await page.evaluate(() => { AtriumQueryUI.pageSize = 50; });

    // A click on the old cursor in the same frame cannot cancel the new query.
    await input.evaluate(box => {
      const more = [...box.closest(".panel-design-query").querySelectorAll("button")].find(button => /^Show \d+ more$/.test(button.textContent));
      box.value = "resistor where value < 100 kΩ";
      box.dispatchEvent(new Event("input", {bubbles:true}));
      more.click();
    });
    await panel.locator(".ui-status-line", {hasText:"4 matches"}).waitFor();

    // An edit refreshes the preview; rows from the old revision never replace current ones.
    await page.evaluate(() => {
      const h = AtriumNavHost, part = h.doc().items.find(i => i.kind === "part" && i.ref === "R1");
      h.edit(() => { part.value = "220k"; }, "Change R1");
    });
    await panel.locator(".ui-status-line", {hasText:"3 matches"}).waitFor();

    // Closing aborts an owner read, then reopening restarts the query.
    await page.evaluate(() => {
      const h = AtriumNavHost, {folderProject,requireProjectClosure} = h;
      const folder = {completeFor:() => false};
      h.folderProject = () => folder;
      window.heldFolderReads = 0;
      h.requireProjectClosure = ({signal}) => new Promise(resolve => {
        window.heldFolderReads++;
        window.heldQuerySignal = signal;
        signal.addEventListener("abort", resolve, {once:true});
      });
      window.restoreQueryFixture = () => Object.assign(h, {folderProject,requireProjectClosure});
      void AtriumQueryUI.run();
    });
    await page.waitForFunction(() => window.heldQuerySignal);
    const updatedQuery = "resistor where value < 100000 Ω";
    for (const source of ["resistor where", "resistor where value <", updatedQuery]) {
      await input.fill(source);
      await page.waitForFunction(source => AtriumQueryUI.state().source === source && AtriumQueryUI.state().hydrating, source);
    }
    assert.equal(await page.evaluate(() => window.heldFolderReads), 1, "Typing reuses the open folder's owner read.");
    await panel.getByRole("button", {name:"Document", exact:true}).click();
    assert.equal(await page.evaluate(() => window.heldQuerySignal.aborted), true, "Document scope cancels the folder read.");
    await panel.getByRole("button", {name:"Project", exact:true}).click();
    await page.waitForFunction(() => window.heldFolderReads === 2 && !window.heldQuerySignal.aborted);
    await page.evaluate(() => AtriumDock.toggle("design-query"));
    await panel.waitFor({state:"hidden"});
    assert.equal(await page.evaluate(() => window.heldQuerySignal.aborted), true);
    await page.evaluate(() => { window.restoreQueryFixture(); return AtriumQueryUI.open(); });
    await panel.locator(".ui-status-line", {hasText:"3 matches"}).waitFor();

    // A completed result reopened without another search also owns a Select cancellation signal.
    await page.evaluate(async () => {
      AtriumDock.toggle("design-query");
      await AtriumQueryUI.open();
      const service = AtriumQueryService;
      window.heldQuerySignal = null;
      globalThis.AtriumQueryService = {...service,selection:(_query, {signal}) => new Promise(resolve => {
        window.heldQuerySignal = signal;
        signal?.addEventListener("abort", () => resolve({complete:false}), {once:true});
      })};
      window.restoreQueryFixture = () => { globalThis.AtriumQueryService = service; };
    });
    await panel.getByRole("button", {name:"Select", exact:true}).click();
    await page.waitForFunction(() => window.heldQuerySignal);
    await page.evaluate(() => AtriumDock.toggle("design-query"));
    await panel.waitFor({state:"hidden"});
    assert.equal(await page.evaluate(() => window.heldQuerySignal.aborted), true);
    await page.evaluate(() => { window.restoreQueryFixture(); return AtriumQueryUI.open(); });

    // Save, then a duplicate name, rename and delete; a deleted group reads as missing.
    await panel.getByRole("button", {name:"Save…"}).click();
    let dialog = page.locator("dialog[open]");
    await dialog.getByLabel("Name").fill("Low resistors");
    await shot(page, "7-save", "dialog[open]");
    await dialog.getByRole("button", {name:"Save", exact:true}).click();
    await dialog.waitFor({state:"detached"}).catch(() => {});
    await panel.getByRole("button", {name:"Save…"}).click();
    dialog = page.locator("dialog[open]");
    await dialog.getByLabel("Name").fill("Low resistors");
    await dialog.getByRole("button", {name:"Save", exact:true}).click();
    await page.evaluate(() => AtriumQueryUI.setTab("saved"));
    await panel.locator(".ui-badge", {hasText:"Duplicate name"}).first().waitFor();
    await shot(page, "8-saved");
    await panel.locator(".ui-row").first().hover();
    await panel.getByRole("button", {name:"More actions for Low resistors"}).first().click();
    await page.getByRole("menuitem", {name:"Rename…"}).click();
    dialog = page.locator("dialog[open]");
    await dialog.getByLabel("Name").fill("Small resistors");
    await dialog.getByRole("button", {name:"Rename"}).click();
    await panel.locator(".ui-row", {hasText:"Small resistors"}).waitFor();
    await panel.locator(".ui-row", {hasText:"Small resistors"}).hover();
    await panel.locator(".ui-row", {hasText:"Small resistors"}).getByRole("button", {name:"Run"}).click();
    await panel.locator(".ui-status-line", {hasText:"3 matches"}).waitFor();
    await page.evaluate(async () => {
      const id = AtriumNavHost.project().savedQueries.find(q => q.name === "Small resistors").id;
      await AtriumButterEditor.apply("butter.query.delete-saved", {id});
      await AtriumQueryUI.run();
    });
    await panel.locator(".ui-notice", {hasText:"Saved query missing"}).waitFor();
    await shot(page, "9-missing");
    await page.evaluate(() => { AtriumNavHost.project().atriumCompat = {readOnly:true}; AtriumQueryUI.setTab("saved"); });
    await panel.locator(".ui-notice", {hasText:"Read-only project"}).waitFor();
    await page.evaluate(() => { delete AtriumNavHost.project().atriumCompat; });
    await page.evaluate(async () => {
      for (const q of AtriumNavHost.project().savedQueries ?? []) await AtriumButterEditor.apply("butter.query.delete-saved", {id:q.id});
      AtriumQueryUI.setTab("saved");
    });
    await panel.locator(".ui-empty", {hasText:"No saved groups"}).waitFor();
    await shot(page, "10-saved-empty");

    // Rule applicability: full coverage, then a kernel that exposes its scope only.
    await page.evaluate(() => AtriumQueryUI.setTab("rules"));
    await panel.locator(".ui-badge", {hasText:"Every check candidate"}).waitFor();
    await panel.locator(".ui-section", {hasText:"Checked pairs"}).waitFor();
    await shot(page, "11-rule");
    await panel.getByLabel("Rule").selectOption({label:"ShortCircuit"});
    await panel.locator(".ui-badge", {hasText:"Scope only"}).waitFor();
    await shot(page, "12-rule-partial");

    // The palette's design-query results end with a row into this panel.
    const row = await page.evaluate(() => AtriumIntelUI.queryRows("resistor where value < 1 kΩ", {complete:true, count:40, rows:[{}, {}]}).map(r => r.label));
    assert.deepEqual(row, ["Show all 40 in Query"]);

    await page.evaluate(() => AtriumPrefs.set("butter.query", false));
    await page.waitForFunction(() => !document.querySelector(".panel-design-query") && !AtriumKeymap.command("assist.design-query"));
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

H.runWalk(walk, "SKIP Query panel walk: Playwright Core unavailable.", "PASS Query panel: off, empty, completion, located unit error, cross-probing matches, scope, exact zero, paging, refresh on edit, save, duplicate, rename, delete, missing, read-only, rule coverage.");
