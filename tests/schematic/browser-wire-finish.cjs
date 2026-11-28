"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function finish(browser) {
  const page = await browser.newPage({viewport:{width:1280,height:880}});
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.locator("dialog.sp-dialog[open] [data-start-action=demo]").click();
    const [start, end] = await page.evaluate(async () => {
      const host = AtriumNavHost, project = Atrium.project("Wire finish", []), sheet = Atrium.sheet("schematic", "Circuit");
      sheet.grid = 1;
      sheet.items.push({id:Atrium.id(),kind:"wire",points:[[20,-25],[20,-40]]});
      project.documents = [sheet];
      await host.replaceProject(project, {copy:true,force:true});
      await host.prepareLaunch();
      AtriumKeymap.setPreset("altium");
      const rect = host.canvas().getBoundingClientRect();
      return [[15,-30],[20,-30]].map(p => {
        const [x,y] = host.view().worldToScreen(p);
        return [rect.left+x,rect.top+y];
      });
    });
    await page.locator("#canvas").focus();
    await page.mouse.move(...start);
    await page.keyboard.press("Control+w");
    await page.waitForFunction(() => AtriumNavHost.tool() === "route");
    // Count requests for the full sheet's net names that the finishing click makes before the wire
    // edit reaches the model. Only calls made while the click's pointer events are dispatched count:
    // background work (an idle Insights pass, the inspector refreshing after a lazy module loads)
    // reads the sheet's nets on its own schedule, which is not the completion path.
    await page.evaluate(() => {
      const sheet = AtriumNavHost.doc(), original = Atrium.sheetNets;
      let beforeCommit = 0;
      Atrium.sheetNets = (...args) => {
        const input = /^(pointer|mouse|click)/.test(globalThis.event?.type || "");
        if (input && args[1] === sheet && sheet.items.length === 1) beforeCommit++;
        return original(...args);
      };
      globalThis.finishNetProbe = () => { Atrium.sheetNets = original; return beforeCommit; };
    });
    await page.mouse.click(...end);
    const netLookups = await page.evaluate(() => globalThis.finishNetProbe());

    const items = () => page.evaluate(() => AtriumNavHost.doc().items.map(item => item.kind));
    assert.deepEqual(await items(), ["wire","wire","junction"]);
    assert.equal(await page.evaluate(() => AtriumNavHost.tool()), "select", "a finished Ctrl+W wire returns to Select");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.deepEqual(await items(), ["wire"]);
    assert.equal(netLookups, 0, "schematic wire completion only needs to know whether the endpoint touches a wire");
    console.log("PASS Ctrl+W finishes the schematic wire, returns to Select, and undoes as one edit");
  } finally {await page.close();}
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({channel:"chrome"},finish,error=>{console.error(error);process.exitCode=1;});
module.exports = finish;
