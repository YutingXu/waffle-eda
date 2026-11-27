"use strict";

const assert = require("node:assert/strict"), path = require("node:path"), {pathToFileURL} = require("node:url");

module.exports = async function uxConsistency(browser) {
  for (const theme of ["light", "dark"]) {
    const page = await browser.newPage({viewport:{width:1200, height:800}, colorScheme:theme, reducedMotion:"reduce"});
    page.setDefaultTimeout(6000);
    try {
      await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
      await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
      await page.locator("#doc-name").filter({hasText:"Sensor board"}).waitFor();
      await page.evaluate(theme => AtriumTheme.set({preset:theme, followSystem:false}, {persist:false}), theme);
      const choose = async (name, action) => {
        const menu = page.locator('details[data-menu="' + name + '"]');
        await menu.locator(":scope > summary").click();
        const group = name === "window" ? menu.locator("#sub-window-panels") : menu;
        if (name === "window") await group.getByRole("menuitem",{name:"Panels",exact:true}).click();
        await group.locator('[data-action="' + action + '"]').click();
      };
      await choose("window", "pour-manager");
      const pours = page.locator(".panel-pours"), bulk = pours.getByRole("toolbar");
      await pours.getByText(/no polygon pours/).waitFor();
      await page.evaluate(() => {
        const h = AtriumNavHost, points = [[3,3],[9,3],[9,9],[3,9]];
        h.edit(() => h.doc().items.push(AtriumPolygonPour.make(points, {name:"Isolated test plane", net:"ISOLATED", layer:"Top", removeDeadCopper:true})));
      });
      await bulk.getByRole("button", {name:"Repour All"}).click();
      const option = pours.getByRole("option", {name:/Isolated test plane/});
      await option.getByText("Empty", {exact:true}).waitFor();
      assert.equal(await page.locator('[aria-label="Close Pours"]:visible').count(), 1);
      const more = bulk.getByRole("button", {name:"More pour actions"});
      await more.click();
      const menu = page.getByRole("menu", {name:"More pour actions"});
      await menu.getByRole("menuitem", {name:"Shelve All"}).click();
      await option.getByText("Shelved", {exact:true}).waitFor();
      await more.click(); await menu.getByRole("menuitem", {name:"Restore All"}).click();
      await option.getByText("Empty", {exact:true}).waitFor();
      await option.click();
      const selected = pours.getByRole("button", {name:/More actions for/});
      await selected.click();
      await page.getByRole("menuitem", {name:/Properties/}).waitFor();
      await page.keyboard.press("Escape");
      assert.ok(await selected.evaluate(b => b === document.activeElement));
      await page.locator('[data-dock-close="pours"]').click();

      // Open the view from the board and the schematic and restore each document's own controls.
      for (const kind of ["pcb", "schematic"]) {
        const tab = page.locator('#document-tabs [data-kind="' + kind + '"]').first();
        await tab.click();
        const stripWidth = () => page.locator("#document-tabs").evaluate(strip => strip.getBoundingClientRect().width);
        const beforeHistory = await stripWidth();
        const project = page.locator("details[data-menu=project]");
        await project.locator(":scope > summary").click();
        const history = project.locator('[data-action="project-history"]');
        await history.locator("xpath=ancestor::div[contains(concat(' ',normalize-space(@class),' '),' submenu ')][1]/button[1]").hover();
        await history.click();
        await page.locator(".hv-view:visible").waitFor();
        assert.equal(await stripWidth(), beforeHistory, "History keeps the design tab strip width");
        assert.equal(await page.locator(".layer-bar:visible").count(), 0);
        await tab.click();
        await page.locator(".panel-properties:visible").waitFor();
        assert.equal(await page.locator(".layer-bar:visible").count(), kind === "pcb" ? 1 : 0);

        await page.evaluate(() => AtriumNavHost.act("rules"));
        const rules = page.getByRole("dialog", {name:"Rules and Constraints Editor",exact:true});
        await rules.waitFor();
        assert.equal(await stripWidth(), beforeHistory, "Rules keeps the design tab strip width");
        assert.equal(await page.locator(".layer-bar:visible").count(), 0);
        await rules.getByRole("button", {name:"Close",exact:true}).click();
        await rules.waitFor({state:"hidden"});
        assert.equal(await stripWidth(), beforeHistory, "closing Rules keeps the same width");
      }
      await choose("file", "preferences");
      const dlg = page.getByRole("dialog", {name:"Preferences"}), search = dlg.getByRole("searchbox");
      await search.fill("Repour polygons after each edit");
      await dlg.getByRole("button", {name:"PCB", exact:true}).click();
      const row = dlg.locator(".prf-row:not([hidden])").first();
      assert.ok(await row.evaluate(n => n.getBoundingClientRect().width > 250));
      await search.focus(); await search.selectText(); await search.click({button:"right"});
      const textMenu = dlg.getByRole("menu", {name:"Text"});
      await textMenu.getByRole("menuitem", {name:"Select All"}).click();
      assert.deepEqual(await search.evaluate(n => [n.selectionStart, n.selectionEnd]), [0,"Repour polygons after each edit".length]);
      // Library search field: the first Escape clears the query, the next closes the dialog.
      await page.keyboard.press("Escape");
      assert.equal(await search.inputValue(), "", "Escape clears the Preferences search first");
      assert.ok(await dlg.isVisible(), "Preferences stays open while its search had text");
      await page.keyboard.press("Escape");
      await dlg.waitFor({state:"hidden"});
      await page.waitForFunction(() => document.activeElement?.matches('details[data-menu="file"] > summary'));

      await choose("window", "library-panel");
      // Import library files… is in the source bar's "Add library" menu.
      const library = page.locator(".panel-library:visible");
      await library.getByRole("combobox", {name:"Library source"}).waitFor();
      const picker = page.waitForEvent("filechooser");
      await library.getByRole("button", {name:"Add library", exact:true}).click();
      await page.getByRole("menuitem", {name:"Import library files…", exact:true}).click();
      await (await picker).setFiles(path.join(__dirname, "../fixtures/kicad/Lab_Amp.kicad_sym"));
      const review = page.getByRole("dialog", {name:"Import library components"});
      await review.getByText(/symbol only/i).first().waitFor();
      assert.ok(await review.locator("tbody tr").count() > 0, "the OS picker supplies actual File bytes");
      await page.keyboard.press("Escape"); await review.waitFor({state:"hidden"});
    } finally { await page.close(); }
  }
};
