"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const directory = path.join(__dirname, "../fixtures/format-2/notebook");
const manifest = "Notebook.waffle";
const sheet = "notebook-sheet";

async function openNotebook(page) {
  const assets = (await fs.readdir(path.join(directory, "assets"))).map(name => "assets/" + name);
  const members = await Promise.all([manifest, "Notebook.wsch", ...assets].map(async name => [
    name, (await fs.readFile(path.join(directory, name))).toString("base64"),
  ]));
  await page.evaluate(async ({manifest, sheet, members}) => {
    const host = AtriumNavHost;
    const [browser, prefs] = await AtriumLazy.need(["AtriumBrowserProject", "AtriumPrefs"]);
    prefs.set("labs.notebook", true);
    if (!AtriumLabs.notebookEnabled()) throw Error("The notebook fixture requires the Labs preference.");
    const files = new Map(members.map(([name, data]) => [name, Uint8Array.from(atob(data), char => char.charCodeAt(0))]));
    const folder = browser.create(manifest, files, {temporary:false});
    if (!await host.openFiles([{name:manifest, folderProject:folder}])) throw Error("The saved notebook did not open.");
    await host.selectDocument(sheet);
    if (host.doc()?.id !== sheet || !host.folderProject()?.canEdit(sheet)) throw Error("The saved schematic is unavailable.");
  }, {manifest, sheet, members});
}

function cases(page) {
  const select = async id => page.evaluate(id => {
    const host = AtriumNavHost;
    if (!host.doc().items.some(item => item.id === id)) throw Error("No saved schematic item named " + id);
    host.select([id], id);
  }, id);
  const itemEditor = async (id, control, title) => {
    await select(id);
    await page.getByRole("button", {name:control, exact:true}).click();
    return page.getByRole("dialog", {name:title, exact:true});
  };
  const run = async action => page.evaluate(async action => {
    const host = AtriumNavHost, scripts = AtriumLazy.forAction(action, host.doc()?.kind);
    if (scripts) await AtriumLazy.need(scripts);
    void host.act(action);
  }, action);

  return [
    {name:"Edit a saved calculation with a bound assertion", async open() {
      await openNotebook(page);
      const dialog = await itemEditor("rail-calc", "Edit calculation", "Edit calculation");
      await dialog.getByRole("button", {name:"Save calculation", exact:true}).waitFor();
      assert.match(await dialog.getByLabel("Expression", {exact:true}).inputValue(), /Vout/);
    }},
    {name:"Edit the saved schematic equation", async open() {
      const dialog = await itemEditor("math-note", "Edit equation", "Edit equation");
      assert.equal(await dialog.getByRole("textbox", {name:"TeX source", exact:true}).inputValue(), "\\frac{V}{R}=I");
    }},
    {name:"Edit a saved linked checklist", async open() {
      const dialog = await itemEditor("review-todo", "Edit checklist", "To-do list");
      const row = dialog.getByRole("group").filter({has:page.getByRole("checkbox", {name:"Confirm the rail", exact:true})});
      assert.equal(await row.getByRole("textbox", {name:"Assignee", exact:true}).inputValue(), "Reviewer");
    }},
    {name:"Edit an image attachment and its crop", async open() {
      const dialog = await itemEditor("photo", "Edit image…", "Edit image");
      assert.equal(await dialog.getByRole("textbox", {name:"Caption", exact:true}).inputValue(), "Reference photograph");
      assert.equal(await dialog.getByRole("spinbutton", {name:"Right %", exact:true}).inputValue(), "95");
      await page.waitForFunction(() => {
        const canvas = document.querySelector(".notebook-image-dialog[open] .notebook-image-preview canvas");
        return canvas?.getContext("2d").getImageData(0, 0, 1, 1).data[3] === 255;
      });
    }},
    {name:"Review the original page of a saved clipping", async open() {
      const editor = await itemEditor("pdf-clip", "Edit image…", "Edit image");
      await editor.getByRole("button", {name:"Open source page 1", exact:true}).click();
      const dialog = page.getByRole("dialog", {name:"Datasheet.pdf", exact:true});
      await dialog.locator("button:enabled").filter({hasText:/^Done$/}).waitFor();
      assert.equal(await dialog.getByRole("spinbutton", {name:"Page", exact:true}).inputValue(), "1");
    }},
    {name:"Configure a sheet symbol for placement on the saved schematic", async open() {
      await run("sch-sheet-symbol");
      const dialog = page.getByRole("dialog", {name:"Place sheet symbol", exact:true});
      assert.equal(await dialog.getByRole("combobox", {name:"Child sheet", exact:true}).inputValue(), "*new");
      assert.equal(await dialog.getByRole("textbox", {name:"New sheet name", exact:true}).inputValue(), "Sheet 2");
    }},
    {name:"Edit a full table from the notebook", async open() {
      await page.evaluate(async () => {
        const host = AtriumNavHost, editor = await AtriumLazy.need("AtriumSheetWidgetEditor");
        AtriumPrefs.set("butter.tables",true);
        const table = AtriumSheetWidgets.make("table",[12,20]);
        host.edit(() => host.doc().items.push(table),"Place table",[table]);
        host.select([table.id],table.id);
        editor.open(table.id,host);
      });
      await page.getByRole("button",{name:"Upgrade to full table",exact:true}).click();
      const dialog = page.getByRole("dialog",{name:"Edit table",exact:true});
      await dialog.getByRole("textbox",{name:"Cell contents or formula",exact:true}).waitFor();
    }, async finish() {
      await page.evaluate(() => AtriumPrefs.set("butter.tables",false));
    }},
    {name:"Manage the pins of a connector saved on the schematic", async open() {
      await run("dynamic-connector");
      await page.evaluate(async () => {
        const host = AtriumNavHost, doc = host.doc(), project = host.project();
        const connector = doc.items.find(item => host.selection().includes(item.id) && item.kind === "part");
        const definition = project.library.find(def => def.id === connector?.def);
        if (!AtriumDynamicSymbol.isDynamic(definition)) throw Error("The editor did not place a dynamic connector.");
        const [left] = definition.dynamic.body;
        const tip = [connector.x + left, connector.y];
        host.edit(() => {
          doc.items.push({id:Atrium.id(), kind:"wire", points:[[tip[0] - 5.08, tip[1]], tip]});
        }, "Wire the dynamic connector");
        if (definition.dynamic.pins.length !== 1) throw Error("The wire did not create a connector pin.");
        if (!await host.saveProject({all:true})) throw Error("The connector and wire were not saved.");
        host.select([connector.id], connector.id);
      });
      await run("dynamic-connector-pins");
      const dialog = page.getByRole("dialog", {name:"Dynamic Connector Pins", exact:true});
      await dialog.getByRole("textbox", {name:"Name of pin 1", exact:true}).waitFor();
      await dialog.getByRole("checkbox", {name:"Two-row header footprint", exact:true}).waitFor();
    }},
  ];
}

module.exports = {cases};
