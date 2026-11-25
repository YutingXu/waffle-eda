"use strict";

// A selected via shows its whole construction in Properties and edits it in place, as Altium's via
// Properties do: template, span, pad stack mode and lands, drill, IPC-4761 protection, the mask on each
// side, via-in-pad and back-drill. Nothing needs the Via Stack dialog, which stays as Cross-section… for
// the drawing. A pad shows its mask and paste openings and its plating in place too. Each change is one
// undo step. Run standalone or with integration-browser.cjs --inline-stack-only.
const assert = require("node:assert/strict");
const path = require("node:path");
const {pathToFileURL} = require("node:url");

const APP = path.join(__dirname, "../../app");

module.exports = async function inlineStack(browser) {
  const page = await browser.newPage({viewport:{width:1400, height:1000}, reducedMotion:"reduce"});
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  try {
    await page.goto(pathToFileURL(path.join(APP, "index.html")).href);
    const demo = page.locator("dialog.sp-dialog[open]").getByRole("button", {name:"Try the Demo", exact:true});
    await demo.waitFor(); await demo.click();
    await page.locator("#doc-name", {hasText:"Sensor board"}).waitFor();
    await page.evaluate(() => AtriumLazy.need(["AtriumViaStack", "AtriumPCBSelectionInspector"]));
    const via = () => page.evaluate(() => JSON.parse(JSON.stringify(AtriumNavHost.doc().items.find(i => i.id === "inline-via"))));
    await page.evaluate(() => {
      const h = AtriumNavHost, d = h.doc();
      h.edit(() => d.items.push({id:"inline-via", kind:"via", x:12, y:6, diameter:.6, drill:.3, net:"GND", layer:"Multi"}));
      h.select(["inline-via"]);
    });
    const ins = page.locator("#inspector");
    const stack = ins.locator(".pcb-via-stack");
    await stack.waitFor();
    const control = label => stack.locator('[aria-label="' + label + '"]');

    // Every part of the construction is a control in Properties, in the compact rows.
    for (const label of ["Via template", "Pad stack", "From layer", "To layer", "Laser µvia", "Diameter (mm)", "Shape", "Drill (mm)", "IPC-4761",
      "Top mask", "Bottom mask", "Via-in-pad", "Back-drill"]) assert.equal(await control(label).count(), 1, label + " is in Properties");
    assert.equal(await ins.getByRole("button", {name:/Edit via stack/}).count(), 0, "no Edit via stack… button");
    assert.equal(await stack.evaluate(s => !s.parentElement.closest(".inspect-section") && [...s.parentElement.children].indexOf(s) > [...s.parentElement.children].findIndex(n => n.querySelector?.(":scope > h3")?.textContent === "Via")), true,
      "Via Stack is its own section after the via's, not a box inside it");

    // Top-Mid-Bottom: a land per layer, edited in place.
    await control("Pad stack").selectOption("tmb");
    await page.waitForFunction(() => AtriumNavHost.doc().items.find(i => i.id === "inline-via").stackMode === "tmb");
    const land = control("Land · Top (mm)");
    await land.fill("0.7"); await land.press("Enter");
    await page.waitForFunction(() => AtriumNavHost.doc().items.find(i => i.id === "inline-via").padStack?.Top?.diameter === .7);
    assert.equal((await via()).diameter, .7, "the via's diameter follows its largest land");
    // Protection, mask and back-drill.
    await control("IPC-4761").selectOption("VII");
    await page.waitForFunction(() => AtriumNavHost.doc().items.find(i => i.id === "inline-via").ipc4761 === "VII");
    await control("Back-drill").check();
    await page.waitForFunction(() => !!AtriumNavHost.doc().items.find(i => i.id === "inline-via").backdrill);
    await control("Drill from").waitFor();
    // One change, one undo step.
    await page.evaluate(() => AtriumNavHost.act("undo"));
    await page.waitForFunction(() => !AtriumNavHost.doc().items.find(i => i.id === "inline-via").backdrill);
    assert.equal((await via()).ipc4761, "VII", "undo takes back only the back-drill");

    // A pad: mask and paste openings and plating in place.
    await page.evaluate(() => {
      const h = AtriumNavHost, d = h.doc();
      h.edit(() => d.items.push({id:"inline-pad", kind:"pad", x:14, y:6, w:1, h:.6, shape:"rect", layer:"Top", net:"GND"}));
      h.select(["inline-pad"]);
    });
    const mask = ins.locator('[aria-label="Mask expand (mm)"]');
    await mask.waitFor();
    assert.equal(await ins.locator('[aria-label="Paste expand (mm)"]').count(), 1, "an SMD pad shows its paste opening");
    await mask.fill("0.05"); await mask.press("Enter");
    await page.waitForFunction(() => AtriumNavHost.doc().items.find(i => i.id === "inline-pad").maskExpansion === .05);
    await ins.locator('[aria-label="Paste"]').uncheck();
    await page.waitForFunction(() => AtriumNavHost.doc().items.find(i => i.id === "inline-pad").noPaste === true);
    assert.deepEqual(errors, [], "no page errors");
    console.log("inline via stack and pad openings: ok");
  } finally {
    await page.close();
  }
};

if (require.main === module) {
  require("../support/standalone-chromium.cjs")(
    () => {
      const at = process.argv.indexOf("--executable");
      return {headless:true, ...(at > 0 ? {executablePath:process.argv[at + 1]} : {channel:"chrome"})};
    },
    browser => module.exports(browser),
    error => { console.error(error); process.exit(1); });
}
