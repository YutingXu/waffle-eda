"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

module.exports = async function libraryFamilies(browser) {
  const page = await browser.newPage({viewport: {width: 1280, height: 900}}), errors = [];
  const longMPN = "TEST0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const longPin = "TEST_MULTIPLEXED_DATA_CLOCK_AND_CONTROL_PIN_WITH_A_LONG_LABEL";
  const focused = locator => locator.evaluate(node => document.activeElement === node);
  let releasePlacement;
  const awaitPlacement = new Promise(resolve => { releasePlacement = resolve; });
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  try {
    // Hold only the schematic placement module so a real canvas click can race its first load.
    await page.route("**/sch-place.js", async route => { await awaitPlacement; await route.continue(); });
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    await page.waitForFunction(() => !!globalThis.AtriumNavHost && AtriumNavHost.doc().kind === "pcb");
    await page.evaluate(({longMPN, longPin}) => {
      const host = AtriumNavHost, template = AtriumParts.catalogue.find(d => d.id === "std-r");
      const part = (id, name, pkg, spacing) => {
        const def = Atrium.clone(template);
        Object.assign(def, {id, name, value: name, prefix: "U"});
        def.footprint.name = pkg;
        def.footprint.pads.forEach((pad, i) => { pad.x = i ? spacing : -spacing; });
        return def;
      };
      const qfn = part("family-qfn", "MX100-P", "QFN-2", 1), bga = part("family-bga", "MX100-B", "BGA-2", .8);
      qfn.parameters = {"Manufacturer Part Number": longMPN};
      qfn.symbol.pins[0].name = longPin;
      const sibling = part("family-sibling", "MX110-G", "QFN-2", 1.4);
      const loose = part("family-loose", "Loose symbol test", "", 1); delete loose.footprint;
      const good = part("family-land", "Loose land test", "LGA-2", 1.5); delete good.symbol;
      const bad = part("family-bad", "Unmatched land test", "SOIC-2", 1.5); delete bad.symbol; bad.footprint.pads[0].number = "3";
      host.edit(() => host.project().library.push(qfn, bga, sibling, loose, good, bad));
      AtriumPref.set("general.autoIncrement", false);
    }, {longMPN, longPin});
    const canvas = page.locator("#canvas");
    await canvas.focus();
    await page.keyboard.press("t");
    await page.keyboard.press("l");
    const panel = page.locator("#properties .panel-library:visible"), search = panel.getByRole("searchbox");
    await panel.waitFor();
    assert.equal(await focused(search), true, "the keyboard shortcut focuses the Library search");
    const row = id => panel.locator('.lib-row[data-def="' + id + '"]');
    await row("family-qfn").waitFor();
    const closed = await panel.evaluate(async node => {
      const oldDraw = AtriumCanvas.preview, later = window.setTimeout;
      let draws = 0, keyTimers = 0;
      AtriumCanvas.preview = (canvas, ...args) => {
        if (node.hidden && node.contains(canvas)) draws++;
        return oldDraw(canvas, ...args);
      };
      try {
        // Queue the selected package's artwork, then close in the same input task.
        node.querySelector("input[type=search]").dispatchEvent(new Event("input", {bubbles: true}));
        node.querySelector('.lib-row[data-def="family-qfn"]').click();
        node.querySelector(".lib-panel-close").click();
        window.setTimeout = (fn, ...args) => {
          if (/library-(panel|ui)\.js/.test(String(new Error().stack))) keyTimers++;
          return later(fn, ...args);
        };
        for (const type of ["keyup", "pointerup"]) document.body.dispatchEvent(new Event(type, {bubbles: true}));
        window.setTimeout = later;
        AtriumNavHost.edit(() => { AtriumNavHost.project().library.find(d => d.id === "family-sibling").name = "Renamed while closed"; });
        await new Promise(resolve => later(resolve, 100));
        return {draws, keyTimers, hidden: node.hidden};
      } finally { AtriumCanvas.preview = oldDraw; window.setTimeout = later; }
    });
    assert.deepEqual(closed, {draws: 0, keyTimers: 0, hidden: true});
    await canvas.focus(); await page.keyboard.press("t"); await page.keyboard.press("l");
    await row("family-sibling").getByText("Renamed while closed").waitFor();
    assert.equal(await focused(search), true, "reopening focuses search and shows edits made while closed");
    await page.evaluate(() => { AtriumNavHost.edit(() => { AtriumNavHost.project().library.find(d => d.id === "family-sibling").name = "MX110-G"; }); });
    await search.fill("MX"); await search.fill("");
    const manager = page.getByRole("dialog", {name: "Component families", exact: true});
    // The Library's commands are in its "Library commands" menu; a component's in the detail's "More component actions".
    await panel.getByRole("button", {name: "Library commands", exact: true}).click();
    await page.getByRole("menuitem", {name: "Manage families…", exact: true}).click();
    await manager.getByLabel("Family name", {exact: true}).fill("Bench Devices");
    for (const [id, chip] of [["family-qfn", "MX100"], ["family-bga", "MX100"], ["family-sibling", "MX110"]]) {
      await manager.getByRole("searchbox").fill(id);
      await manager.getByLabel("Component to add", {exact: true}).selectOption(id);
      await manager.getByRole("button", {name: "Add component", exact: true}).click();
      await manager.getByLabel(/^Chip model for /).last().fill(chip);
    }
    await manager.getByRole("button", {name: "Save family", exact: true}).click();
    await manager.waitFor({state: "hidden"});
    await search.fill("Bench Devices");
    await panel.locator(".lib-family-head", {hasText: "Bench Devices"}).waitFor();
    assert.equal(await panel.locator(".lib-chip-head").count(), 2);
    assert.equal(await panel.locator(".cat-family-packages .lib-row:visible").count(), 3);
    assert.equal(await panel.getByRole("treeitem", {name: /QFN-2.*Bench Devices, MX100/}).count(), 1);
    assert.equal(await panel.getByRole("treeitem", {name: /QFN-2.*Bench Devices, MX110/}).count(), 1);
    await search.fill("Bench Devices MX100");
    const dockChoice = panel.locator(".cat-family-packages .lib-row").first();
    const dockChip = panel.locator(".lib-chip-head");
    const dockPlace = panel.locator(".lib-detail-actions").getByRole("button", {name: "Place", exact: true});
    await search.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    assert.equal(await focused(dockChoice), true);
    // Tab hops from the selected package to the detail's first action (its Place button), and back.
    await page.keyboard.press("Tab");
    assert.equal(await focused(dockPlace), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(dockChoice), true, "reverse Tab returns to the selected dock package");
    await page.keyboard.press("ArrowUp");
    assert.equal(await focused(dockChip), true);
    assert.equal(await dockPlace.count(), 0, "a chip heading has no placement action");
    await page.keyboard.press("Enter");
    assert.equal(await dockChoice.isVisible(), false);
    // Tree headers are not Tab stops (tabindex -1): one Shift+Tab reaches the list.
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(panel.locator(".lib-list")), true);
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => AtriumNavHost.tool()), "select", "a collapsed package cannot be placed from the result group");
    await search.fill("Bench Devices MX100 dry");
    assert.equal(await panel.locator(".cat-family-packages .lib-row").count(), 0);
    await search.fill("Bench Devices MX100 pkg:BGA");
    await row("family-bga").click();
    const details = panel.locator(".lib-detail");
    const command = async name => {
      await details.getByRole("button", {name: "More component actions", exact: true}).click();
      await page.getByRole("menuitem", {name, exact: true}).click();
    };
    assert.equal(await details.locator('.cat-pv[data-def="family-bga"] canvas').count(), 2, "the exact package has both previews");
    assert.equal(await row("family-qfn").count(), 0, "package search disambiguates the chip's variants");

    // Edit the selected variant without switching the Library's source or filter.
    await command("Edit symbol");
    const symbolEditor = page.locator("dialog.se-dialog[open]");
    await symbolEditor.locator("h2", {hasText: "MX100-B"}).waitFor();
    const pinTool = symbolEditor.getByRole("button", {name: "Pin", exact: true});
    await pinTool.press("Space");
    assert.equal(await pinTool.getAttribute("aria-pressed"), "true", "Space activates the focused symbol tool");
    assert.equal(await pinTool.getAttribute("aria-description"), "P");
    await symbolEditor.locator("canvas").focus();
    await page.keyboard.press("Escape");
    assert.equal(await symbolEditor.getByRole("button", {name: "Select", exact: true}).getAttribute("aria-pressed"), "true");
    await symbolEditor.getByRole("button", {name: "Cancel", exact: true}).press("Enter");
    await symbolEditor.waitFor({state: "hidden"});
    await command("Edit footprint");
    const footprintEditor = page.locator("dialog.fe-dialog[open]");
    await footprintEditor.locator("h2", {hasText: "BGA-2"}).waitFor();
    const padTool = footprintEditor.getByRole("button", {name: "Pad", exact: true});
    await padTool.press("Enter");
    assert.equal(await padTool.getAttribute("aria-pressed"), "true", "Return activates the focused footprint tool");
    const save = footprintEditor.getByRole("button", {name: "Save", exact: true});
    await save.focus();
    const expectedSave = await page.evaluate(() => ({visual: AtriumKeymap.display("Mod+S"), spoken: AtriumKeymap.display("Mod+S", true)}));
    assert.equal(await save.getAttribute("aria-description"), expectedSave.spoken);
    const saveKey = footprintEditor.locator(".fe-keys kbd").first();
    assert.equal(await saveKey.locator('[aria-hidden="true"]').textContent(), expectedSave.visual);
    await footprintEditor.getByRole("button", {name: "Cancel", exact: true}).press("Space");
    await footprintEditor.waitFor({state: "hidden"});

    assert.equal(await page.evaluate(() => !!globalThis.AtriumSchPlace), false, "browsing and editing do not load schematic placement");
    await command("Place symbol on sheet");
    await page.waitForFunction(() => AtriumNavHost.tool() === "place" && AtriumNavHost.doc().kind === "schematic");
    await canvas.click({position: {x: 148, y: 180}});
    await canvas.click({position: {x: 210, y: 220}});
    assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.filter(i => i.def === "family-bga").length), 0, "the cold clicks wait for schematic placement");
    releasePlacement();
    await page.waitForFunction(() => AtriumNavHost.doc().items.filter(i => i.def === "family-bga" && i.ref === "U?").length === 2);
    await page.keyboard.press("Escape");
    assert.equal(await page.evaluate(() => AtriumNavHost.tool()), "select");

    await page.locator('#document-tabs [data-kind="pcb"]:visible').first().click();
    await canvas.focus();
    await page.keyboard.press("p");
    await page.keyboard.press("c");
    // P C brings the Library panel forward with its search focused; the catalogue dialog is Place › Component Catalogue….
    await page.waitForFunction(() => document.activeElement?.matches?.(".panel-library input[type=search]"));
    await page.evaluate(() => AtriumNavHost.act("library-catalogue"));
    const place = page.getByRole("dialog", {name: "Component library", exact: true}), query = place.getByRole("searchbox");
    assert.equal(await focused(query), true, "the catalogue focuses the placement search");
    await query.fill("Bench Devices MX100");
    await page.keyboard.press("Enter");
    assert.equal(await place.count(), 1, "Enter on an ambiguous query keeps the package chooser open");
    const placeButton = place.getByRole("button", {name: "Place", exact: true});
    const heading = place.locator(".cat-family > summary"), chip = place.locator(".cat-family-chip > summary");
    assert.equal(await focused(heading), true);
    assert.equal(await placeButton.count(), 0, "a family heading has no placement action");
    await page.keyboard.press("Enter");
    assert.equal(await heading.evaluate(node => node.parentElement.open), false);
    assert.equal(await page.evaluate(() => AtriumNavHost.tool()), "select");
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    assert.equal(await focused(chip), true);
    assert.equal(await placeButton.count(), 0, "a chip heading has no placement action");
    await page.keyboard.press("Enter");
    assert.equal(await chip.evaluate(node => node.parentElement.open), false);
    await page.keyboard.press("Enter");
    await page.keyboard.press("ArrowDown");
    const first = place.locator(".cat-family-packages .library-row").first();
    assert.equal(await focused(first), true);
    await page.keyboard.press("Tab");
    assert.equal(await focused(placeButton), true);
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(first), true, "reverse Tab keeps the same variant when another package follows it");
    const variant = place.locator('.library-row[data-def="family-qfn"]');
    if (!await focused(variant)) await page.keyboard.press("ArrowDown");
    assert.equal(await focused(variant), true);
    assert.equal(await place.locator('.cat-pv[data-def="family-qfn"] canvas').count(), 2);
    await page.keyboard.press("Tab");
    assert.equal(await focused(placeButton), true);
    await page.setViewportSize({width: 1024, height: 640});
    const preview = place.locator(".cat-preview"), pins = preview.locator(".cat-pv-pins > summary");
    assert.match(await preview.locator(".cat-pv .ui-notice").first().textContent(), new RegExp(longMPN));
    assert.equal(await preview.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, "the full MPN wraps at a smaller window size");
    assert.equal(await preview.getByRole("table", {name: "Symbol pins"}).count(), 0);
    await page.keyboard.press("Tab");
    assert.equal(await focused(pins), true);
    await page.keyboard.press("Enter");
    const pinTable = preview.getByRole("table", {name: "Symbol pins"});
    await pinTable.getByRole("cell", {name: longPin, exact: true}).waitFor();
    assert.equal(await preview.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, "the full pin label wraps at a smaller window size");
    await page.setViewportSize({width: 480, height: 680});
    assert.equal(await preview.isVisible(), true, "the two previews remain reachable in a narrow window");
    await page.setViewportSize({width: 1280, height: 900});
    await page.keyboard.press("Shift+Tab");
    assert.equal(await focused(placeButton), true);
    await page.keyboard.press("Enter");
    assert.equal(await focused(canvas), true);
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => AtriumNavHost.doc().items.filter(i => i.def === "family-qfn").length), 1, "the keyboard places the exact package");
    await page.keyboard.press("Escape");

    await page.evaluate(() => AtriumNavHost.act("library-catalogue"));
    await place.getByRole("button", {name: "Manage families…", exact: true}).click();
    await manager.waitFor();
    await page.keyboard.press("Escape");
    await manager.waitFor({state: "hidden"});
    assert.equal(await place.isVisible(), true, "Escape closes only the nested family manager");
    await page.keyboard.press("Escape");
    await place.waitFor({state: "hidden"});

    // While unpaired, both loose assets are independently browseable. Attach only a compatible footprint.
    await search.fill("Loose symbol test");
    await row("family-loose").click();
    // A symbol-only part offers no board placement: its one Place button places the symbol on a sheet.
    assert.equal(await details.getByRole("button", {name: "Place", exact: true}).getAttribute("data-tooltip"), "Place symbol on sheet");
    await command("Attach footprint…");
    const attach = page.getByRole("dialog", {name: "Attach footprint to Loose symbol test", exact: true});
    await attach.getByLabel("Footprint to use", {exact: true}).selectOption("family-bad");
    assert.equal(await attach.getByRole("button", {name: "Attach footprint", exact: true}).isDisabled(), true);
    assert.match(await attach.getByRole("alert").textContent(), /Missing pads for pins 1/);
    await attach.getByLabel("Footprint to use", {exact: true}).selectOption("family-land");
    await attach.getByRole("button", {name: "Attach footprint", exact: true}).click();
    await attach.waitFor({state: "hidden"});
    assert.deepEqual(await page.evaluate(() => {
      const defs = AtriumNavHost.defs();
      return [defs.get("family-loose").footprint.name, !!defs.get("family-land").footprint];
    }), ["LGA-2", true]);

    // Exact ID search uses the catalogue's id field.
    await search.fill("id:family-qfn");
    await row("family-qfn").click();
    await command("Add package…");
    const add = page.getByRole("dialog", {name: "Add package to MX100-P", exact: true});
    await add.getByLabel("Footprint to use", {exact: true}).selectOption("family-land");
    await add.getByLabel("Component name", {exact: true}).fill("MX100-L");
    await add.getByRole("button", {name: "Add package", exact: true}).click();
    await add.waitFor({state: "hidden"});
    await search.fill("Bench Devices MX100");
    assert.equal(await panel.locator(".cat-family-packages .lib-row").count(), 3);
    const newId = await page.evaluate(() => AtriumNavHost.project().library.find(d => d.name === "MX100-L").id);
    await row(newId).click();
    await command("Edit family…");
    await manager.getByLabel("Family name", {exact: true}).fill("Bench ICs");
    await manager.getByRole("button", {name: "Save family", exact: true}).click();
    await search.fill("Bench ICs");
    await panel.locator(".lib-family-head", {hasText: "Bench ICs"}).waitFor();
    await row("family-qfn").click();
    await command("Edit family…");
    const ungroup = manager.getByRole("button", {name: "Ungroup family", exact: true});
    assert.equal(await ungroup.count(), 1, "the reopened manager has one accessible Ungroup action during the prior exit");
    await ungroup.press("Enter");
    await manager.waitFor({state: "hidden"});
    await search.fill("MX100-P");
    await row("family-qfn").waitFor();
    assert.equal(await panel.locator(".lib-family-head").count(), 0);
    assert.equal(await page.evaluate(() => AtriumNavHost.project().documents.filter(d => d.items.some(i => i.def === "family-qfn")).length), 1);
    await page.evaluate(() => AtriumNavHost.act("undo"));
    await search.fill("Bench ICs");
    await panel.locator(".lib-family-head", {hasText: "Bench ICs"}).waitFor();

    // A source file can reuse a definition ID without selecting or editing the project entry.
    await page.evaluate(() => {
      const def = Atrium.clone(AtriumNavHost.defs().get("family-qfn")); def.name = "File-only MX";
      const lib = {id: "family-file", name: "File source", path: "file.atrlib", defs: [def]};
      AtriumComponentFamilies.create(lib, "File Devices", [{defId: def.id, part: "File chip"}]);
      AtriumLibrary.sourceStore.save([lib]); AtriumLibrary.mountPanel().render();
    });
    await panel.getByLabel("Library source", {exact: true}).selectOption("family-file");
    await search.fill("File Devices");
    const placed = panel.getByRole("button", {name: "Placed", exact: true});
    await placed.click();
    assert.equal(await row("family-qfn").count(), 0, "the same ID in the project does not mark a file component placed");
    await panel.getByRole("button", {name: "Unused", exact: true}).click();
    // Double-click places a file component (joining the project first); it never opens an editor.
    await row("family-qfn").dblclick();
    assert.equal(await page.locator("dialog.se-dialog[open], dialog.fe-dialog[open]").count(), 0);
    await page.waitForFunction(() => AtriumNavHost.placing());
    await page.keyboard.press("Escape");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.equal(await page.evaluate(() => AtriumNavHost.project().library.some(d => d.libraryRef?.library === "family-file")), false,
      "cancelling the placement and undoing leaves the file component out of the project");
    await row("family-qfn").press("Delete");
    await details.getByRole("button", {name: "Add to project", exact: true}).click();
    assert.equal(await page.evaluate(() => {
      const project = AtriumNavHost.project(), source = project.library.find(d => d.libraryRef?.library === "family-file");
      return !!source && source.id !== "family-qfn" && AtriumComponentFamilies.memberships(project).get(source.id).part === "File chip"
        && project.library.some(d => d.name === "MX100-P");
    }), true);
    await details.getByRole("button", {name: "Place", exact: true}).click();
    await canvas.click({position: {x: 264, y: 220}});
    await page.keyboard.press("Escape");
    await placed.click();
    await row("family-qfn").waitFor();
    assert.deepEqual(errors, []);
    console.log("PASS grouped component search, keyboard placement, package previews and long labels, exact editing, cold clicks, loose assets, family edits and external sources");
  } finally { releasePlacement(); await page.close(); }
};
