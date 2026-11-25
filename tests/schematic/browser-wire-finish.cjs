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
    await page.mouse.click(...end);

    const items = () => page.evaluate(() => AtriumNavHost.doc().items.map(item => item.kind));
    assert.deepEqual(await items(), ["wire","wire","junction"]);
    assert.equal(await page.evaluate(() => AtriumNavHost.tool()), "select", "a finished Ctrl+W wire returns to Select");
    await page.evaluate(() => AtriumNavHost.act("undo"));
    assert.deepEqual(await items(), ["wire"]);
    console.log("PASS Ctrl+W finishes the schematic wire, returns to Select, and undoes as one edit");
  } finally {await page.close();}
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({channel:"chrome"},finish,error=>{console.error(error);process.exitCode=1;});
module.exports = finish;
