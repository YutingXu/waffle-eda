"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function routeNoOp(browser) {
  const page = await browser.newPage({viewport:{width:1280,height:880}, reducedMotion:"reduce"});
  try {
    await page.goto(pathToFileURL(path.join(__dirname, "../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    const point = await page.evaluate(async () => {
      const h = AtriumNavHost, project = Atrium.project("Route edits", []), board = Atrium.sheet("pcb", "Board");
      board.outline = [[0, 0], [20, 0], [20, 14], [0, 14]];
      board.grid = .25;
      board.items.push(
        {id:"start", kind:"pad", number:"1", x:5, y:7, net:"SIG", layer:"Top", shape:"round", w:1, h:1},
        {id:"other", kind:"track", net:"OTHER", layer:"Top", width:.25, points:[[10, 10], [15, 10]]}
      );
      project.documents = [board];
      await h.replaceProject(project, {copy:true, force:true});
      await h.prepareLaunch();
      await AtriumLazy.need(["AtriumUndoStore", "AtriumRouter"]);
      AtriumKeymap.setPreset("altium");
      AtriumPrefs.set("routing.suggest", false);
      h.setLayer("Top");
      h.view().fit(h.doc(), h.defs(), "board");
      h.redraw();
      const rect = h.canvas().getBoundingClientRect(), [x, y] = h.view().worldToScreen([5, 7]);
      return [rect.left + x, rect.top + y];
    });

    await page.locator("#canvas").focus();
    await page.mouse.move(...point);
    await page.keyboard.press("Control+w");
    await page.mouse.click(...point);
    await page.waitForFunction(() => AtriumNavHost.routeSessionNow()?.state.net === "SIG");
    const before = await page.evaluate(() => {
      const h = AtriumNavHost;
      globalThis.firstRouteWorld = h.routeSessionNow().world;
      return {revision:h.authoredRevision(), items:JSON.stringify(h.doc().items)};
    });

    // A second click can arrive while a route is active, including after Escape dismisses a suggestion.
    await page.keyboard.press("Control+w");
    await page.mouse.click(...point);
    await page.keyboard.press("Escape");
    assert.deepEqual(await page.evaluate(() => {
      const h = AtriumNavHost;
      if (h.routeSessionNow()) throw Error("Escape left the route active");
      return {revision:h.authoredRevision(), items:JSON.stringify(h.doc().items)};
    }), before, "finishing a coincident route leaves the model and authored revision alone");

    await page.evaluate(() => {
      const h = AtriumNavHost, track = h.doc().items.find(item => item.id === "other");
      h.edit(() => { track.width = .5; }, undefined, [track]);
    });
    await page.mouse.click(...point);
    await page.waitForFunction(() => AtriumNavHost.routeSessionNow()?.state.net === "SIG");
    assert.equal(await page.evaluate(() => AtriumNavHost.routeSessionNow().world === firstRouteWorld), true,
      "the first copper-only edit updates the journal-backed obstacle index in place");

    await page.keyboard.press("Escape");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.equal(await page.evaluate(() => JSON.stringify(AtriumNavHost.doc().items)), before.items,
      "one Undo reverses the width edit");
    console.log("PASS a coincident Ctrl+W route leaves no undo entry, and the first copper edit reuses the obstacle index");
  } finally {
    await page.close();
  }
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({channel:"chrome"}, routeNoOp, error => { console.error(error); process.exitCode = 1; });
module.exports = routeNoOp;
