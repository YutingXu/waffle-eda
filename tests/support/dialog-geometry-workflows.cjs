"use strict";

// Labs workflow dialogs: Links, drop approval, Windows and the ODB++ fidelity report.
const assert = require("node:assert/strict");
const path = require("node:path");

const dropFixtures = path.join(__dirname, "../fixtures/butter-acceptance/drop");

function cases(page) {
  const modal = name => page.getByRole("dialog", {name, exact:true});
  const button = (root, name) => root.getByRole("button", {name, exact:true});
  const links = page.locator("#inspector .intel-links");
  // Links are a Labs feature (butter.links); their rows live in Properties for the selected object.
  const enableLinks = () => page.evaluate(async () => {
    AtriumPrefs.set("butter.links", true);
    await AtriumLazy.need("AtriumButterEditor");
  });
  const tracks = () => page.evaluate(async () => (await AtriumLazy.need("AtriumLinkRecord"), AtriumNavHost.doc().items)
    .filter(item => item.kind === "track" && AtriumLinkRecord.id(item.id)).slice(0, 4).map(item => item.id));
  const selectInProperties = id => page.evaluate(id => { AtriumDock.reveal("properties"); AtriumNavHost.select([id], id); }, id);
  const storedLink = ([source, target], label) => page.evaluate(async ({source, target, label}) => {
    const url = AtriumLinks.format({projectId:AtriumNavHost.project().id, objectId:target});
    await AtriumButterEditor.apply("butter.links.create", {sourceId:source, url, label});
  }, {source, target, label});
  const restoreDemo = () => page.evaluate(() =>
    AtriumNavHost.replaceProject(structuredClone(globalThis.geometryDemoProject), {force:true, dirty:false}));
  // The Windows list takes a window source with the shape of its live one (window-commands-ui.js).
  // Only that desktop transport is scripted; the dialog, its rows and its actions are production code.
  const windowSource = recovery => page.evaluate(async recovery => {
    await AtriumLazy.need("AtriumProjectWindowClient");
    const host = AtriumNavHost, docs = host.documentRefs().map(row => row.id);
    const id = n => `0000000${n}-0000-4000-8000-00000000000${n}`;
    const listeners = new Set();
    window.geometryWindows = {
      async list() { return {layout:{version:1, project:host.project().id, focused:id(1), windows:[
        {id:id(1), tabs:docs.slice(0, 2), active:docs[0]},
        {id:id(2), tabs:docs.slice(2), active:docs[2], bounds:{display:"Studio Display", left:0, top:0, width:900, height:700}},
      ]}, missing:[]}; },
      status:() => ({writer:"ready", recovery, store:null, loading:[], window:id(1), writerWindow:true}),
      layouts:() => [{name:"Bring-up bench", windows:2, displays:["Studio Display", "Built-in Retina Display"], missing:[], active:true}],
      doc:id => host.docById(id),
      on(listener) { listeners.add(listener); return () => listeners.delete(listener); },
      async discardPending() {}, async returnTabs() {}, async run() { return {}; },
    };
    const ui = await AtriumLazy.need("AtriumWindowsUI");
    ui.open({source:window.geometryWindows});
  }, recovery);

  return [
    {name:"Choose a link target from Properties", async open() {
      await enableLinks();
      const [source] = await tracks();
      await selectInProperties(source);
      await button(links, "Add link from this object…").click();
      const picker = modal("Link to…");
      await picker.getByRole("searchbox", {name:"Find target"}).waitFor();
      await picker.locator(".ui-row").first().waitFor();
    }},
    {name:"Remove a stored link from Properties", async open() {
      await enableLinks();
      const ids = await tracks();
      await storedLink(ids, "Sense return");
      await selectInProperties(ids[0]);
      const row = links.locator(".ui-row", {hasText:"Sense return"});
      await row.hover();
      await button(row, "Link actions").click();
      await page.getByRole("menuitem", {name:"Remove…", exact:true}).click();
      await button(modal("Remove link?"), "Remove").waitFor();
    }, finish:restoreDemo},
    {name:"Inspect a broken link whose target was deleted", async open() {
      await enableLinks();
      const ids = await tracks();
      await storedLink([ids[0], ids[2]], "Old stub");
      await page.evaluate(id => {
        const host = AtriumNavHost;
        host.edit(() => { const doc = host.doc(); doc.items.splice(doc.items.findIndex(item => item.id === id), 1); }, "Delete stub");
      }, ids[2]);
      await selectInProperties(ids[0]);
      const row = links.locator(".ui-row[data-state=broken]", {hasText:"Old stub"});
      await row.hover();
      await button(row, "Inspect…").click();
      const dialog = modal("Broken link");
      await dialog.getByText("The target was deleted", {exact:false}).waitFor();
      await button(dialog, "Choose replacement…").waitFor();
    }, finish:restoreDemo},
    {name:"Open a pasted Waffle link", async open() {
      await enableLinks();
      await page.waitForFunction(() => AtriumKeymap.command("assist.open-link"));
      await page.evaluate(() => AtriumKeymap.command("assist.open-link").run());
      await modal("Open link").getByRole("textbox", {name:"Waffle link", exact:true}).waitFor();
    }, async finish() {
      await page.evaluate(() => AtriumPrefs.set("butter.links", false));
    }},
    {name:"Approve a STEP model dropped on a part with a shared footprint", async open() {
      await page.evaluate(async () => {
        AtriumPrefs.set("butter.drop", true);
        await AtriumLazy.need("AtriumDropEditor"); // it registers and installs the drop UI
        await AtriumLazy.need(["AtriumDropUI", "AtriumUIKit"]);
        const host = AtriumNavHost;
        await host.selectDocument(host.project().documents.find(doc => doc.kind === "pcb").id);
        host.act("fit-document");
      });
      // A part whose footprint other parts share, under the pointer on the canvas.
      const at = await (await page.waitForFunction(() => {
        const host = AtriumNavHost, canvas = host.canvas(), box = canvas.getBoundingClientRect(), doc = host.doc();
        if (globalThis.AtriumMotion?.active()) return;
        const parts = doc.items.filter(item => item.kind === "part" && host.defs().get(item.def)?.footprint &&
          doc.items.filter(other => other.def === item.def).length > 1);
        for (const item of parts) {
          const [x, y] = host.view().worldToScreen([item.x, item.y]).map((pixel, axis) => pixel + (axis ? box.top : box.left));
          if (document.elementFromPoint(x, y) === canvas && host.hit(canvas, x, y)?.item?.id === item.id) return {x, y, name:item.ref};
        }
      })).jsonValue();
      const client = await page.context().newCDPSession(page), step = path.join(dropFixtures, "body.step");
      try {
        for (const type of ["dragEnter", "dragOver", "drop"]) await client.send("Input.dispatchDragEvent",
          {type, x:at.x, y:at.y, data:{items:[], files:[step], dragOperationsMask:1}});
      } finally { await client.detach(); }
      const dialog = modal("Approve drop");
      await dialog.getByText(/^body\.step/).waitFor();
      await dialog.getByText(`${at.name} · footprint shared by`, {exact:false}).waitFor();
    }, async finish() {
      await page.evaluate(() => AtriumPrefs.set("butter.drop", false));
    }},
    {name:"Windows list with a detached window and a saved layout", async open() {
      await page.evaluate(() => AtriumPrefs.set("butter.windows", true));
      await windowSource(null);
      const dialog = modal("Windows");
      await dialog.getByRole("treeitem", {name:/Main window/}).waitFor();
      await dialog.locator('.ui-row[data-layout="Bring-up bench"]').waitFor();
      assert.equal(await button(dialog, "Merge all").isDisabled(), false);
    }, async finish() {
      await page.evaluate(() => { delete window.geometryWindows; AtriumPrefs.set("butter.windows", false); });
    }},
    {name:"Review an edit pending after a window reconnects", async open() {
      await page.evaluate(() => AtriumPrefs.set("butter.windows", true));
      await windowSource({state:"conflict", label:"Move R12"});
      const list = modal("Windows");
      await list.getByText("An edit is waiting for review.").waitFor();
      await button(list, "Review…").click();
      const pending = modal("Pending edit");
      await pending.getByText("Move R12").waitFor();
      await button(pending, "Keep pending").waitFor();
    }, async finish() {
      await page.evaluate(() => { delete window.geometryWindows; AtriumPrefs.set("butter.windows", false); });
    }},
    {name:"ODB++ fidelity report from the Release card", async open() {
      await page.evaluate(() => AtriumPrefs.set("butter.odb", true));
      const file = page.locator('.menubar [data-menu="file"]');
      await file.locator(":scope > summary").click();
      await file.getByRole("menuitem", {name:"Release…", exact:true}).click();
      const release = modal("Release");
      await release.getByRole("combobox", {name:"Job set"}).selectOption({label:"ODB++ fabrication"});
      const card = release.locator('article[data-kind="odb"]');
      await card.locator(".rel-state.is-ok, .rel-state.is-warn").waitFor({timeout:60000});
      await button(card.locator(".odb-lines"), "Fidelity report…").click();
      await page.getByRole("dialog", {name:"ODB++ fidelity report"}).getByRole("row", {name:/Package body outlines/}).waitFor();
    }, async finish() {
      await page.evaluate(() => AtriumPrefs.set("butter.odb", false));
    }},
  ];
}

module.exports = {cases};
