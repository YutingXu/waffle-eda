"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

async function consoleLayout(browser) {
  const page = await browser.newPage({viewport:{width:1440,height:900}, reducedMotion:"reduce"});
  try {
    await page.goto(pathToFileURL(path.join(__dirname,"../../app/index.html")).href);
    await page.getByRole("button",{name:"Try the Demo",exact:true}).click();
    await page.evaluate(() => AtriumNavHost.act("scripting-console"));
    const consolePanel = page.locator("#properties #script-console.dock-tabbed");
    await consolePanel.waitFor();
    const layout = await consolePanel.evaluate(panel => {
      const toolbar = panel.querySelector(".script-bar");
      const input = panel.querySelector(".script-editor").getBoundingClientRect();
      const output = panel.querySelector(".script-output").getBoundingClientRect();
      return {overflow: toolbar.scrollWidth - toolbar.clientWidth, stacked: output.top >= input.bottom};
    });
    assert.deepEqual(layout,{overflow:0,stacked:true},"the side dock keeps every control reachable and stacks the editor and output");
    const editor = consolePanel.getByRole("textbox",{name:"Script",exact:true});
    await editor.fill('return "Console fixture result";');
    await consolePanel.getByRole("button",{name:"Run script",exact:true}).click();
    await consolePanel.getByRole("log").getByText("Console fixture result",{exact:false}).waitFor();
    await page.locator('[data-dock-close="scripting"]').click();
    await consolePanel.waitFor({state:"hidden"});
    console.log("PASS narrow Scripting Console keeps its toolbar, editor, and output usable");
  } finally {await page.close();}
}

if (require.main === module)
  require("../support/standalone-chromium.cjs")({channel:"chrome"},consoleLayout,error=>{console.error(error);process.exitCode=1;});
module.exports = consoleLayout;
