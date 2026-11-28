"use strict";

// Popovers and pickers the app places from an anchor or the pointer, opened in a 390 by 844 window. The
// shared viewport measurement then fails any of them that a narrow window pushes past an edge.
const narrow = {width:390, height:844};

function cases(page) {
  const dialog = name => page.getByRole("dialog", {name, exact:typeof name === "string"});
  const action = id => page.evaluate(async id => {
    const host = AtriumNavHost, dependencies = AtriumLazy.forAction(id, host.doc()?.kind);
    if (dependencies) await AtriumLazy.need(dependencies);
    host.act(id);
  }, id);
  const board = async () => {
    await page.setViewportSize(narrow);
    await page.evaluate(async () => {
      const host = AtriumNavHost, ref = host.documentRefs().find(doc => doc.kind === "pcb");
      await host.selectDocument(ref.id);
      host.select([]);
    });
  };
  const canvas = () => page.evaluate(() => {
    const box = AtriumNavHost.canvas().getBoundingClientRect();
    return {left:box.left, top:box.top, right:box.right, bottom:box.bottom};
  });
  // A comparison of the working board with an earlier copy that moved a track and renamed a part.
  const comparison = async () => {
    await board();
    await page.evaluate(async () => {
      const view = await AtriumLazy.need("AtriumDiffView"), host = AtriumNavHost;
      if (view.session()) return;
      const before = structuredClone(host.project()), sheet = host.doc();
      before.documents.find(doc => doc.id === sheet.id).items.find(item => item.kind === "track").points.at(-1)[0] += 2;
      before.documents.find(doc => doc.kind === "schematic").items.find(item => item.kind === "part").ref = "R99";
      await view.start({project:before, label:"Before"}, {project:host.project(), label:"Working design", working:true}, {doc:sheet.id});
    });
  };
  const closeComparison = () => page.evaluate(() => globalThis.AtriumDiffView?.close());
  const clipboard = corner => async () => {
    await board();
    const box = await canvas();
    if (corner) await page.mouse.move(corner === "end" ? box.right - 6 : box.left + 4, corner === "end" ? box.bottom - 6 : box.top + 4);
    await action("clipboard-picker");
    await dialog("Clipboard history").waitFor();
  };
  return [
    {name:"Narrow Clipboard history at the canvas centre", open:clipboard(null)},
    {name:"Narrow Clipboard history at the pointer near the canvas end", open:clipboard("end")},
    {name:"Narrow Clipboard history at the pointer near the canvas start", open:clipboard("start")},
    {name:"Narrow PCB snap options", async open() {
      await board();
      await action("snap-options");
      await dialog("Snap options").waitFor();
    }},
    {name:"Narrow Library parameter filters", async open() {
      await page.setViewportSize(narrow);
      await page.evaluate(async () => {
        const host = AtriumNavHost, ref = host.documentRefs().find(doc => doc.kind === "schematic");
        await host.selectDocument(ref.id);
      });
      const panel = page.locator(".panel-library:visible");
      if (!await panel.isVisible()) await action("library-panel");
      await panel.getByRole("button", {name:"Filters", exact:true}).click();
      await dialog("Parameter filters").locator("input,button").first().waitFor();
    }},
    {name:"Narrow comparison routing delta", async open() {
      await comparison();
      await page.getByRole("button", {name:"Per-net routing delta: length and vias", exact:true}).click();
      await dialog("Routing delta").waitFor();
    }, finish:closeComparison},
    {name:"Narrow comparison export menu", async open() {
      await comparison();
      await page.getByRole("button", {name:"Export the comparison as a PDF or HTML review report", exact:true}).click();
      await dialog("Export review report").waitFor();
    }, finish:closeComparison},
  ];
}

module.exports = {cases};
