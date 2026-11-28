"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");

const {fixture:datasheetPdf} = require("./datasheet-pdf.cjs");

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

  const button = (root, name) => root.getByRole("button", {name, exact:true});
  // The datasheet reader (Labs) with a PDF the user chose, referenced by the saved notebook.
  const reader = page.locator(".panel-datasheet");
  const openDatasheet = async () => {
    await page.evaluate(async () => {
      AtriumPrefs.set("butter.datasheets", true);
      await AtriumLazy.need("AtriumButterEditor");
      const deadline = performance.now() + 4000;
      while (!AtriumKeymap.command("butter.datasheets.reader") && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
      // The command toggles the reader.
      if (!document.querySelector(".panel-datasheet")?.getClientRects().length) AtriumKeymap.command("butter.datasheets.reader").run();
    });
    await reader.waitFor();
    if (await reader.locator(".docs-page img").first().isVisible()) return;
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), button(reader, "Open PDF…").first().click()]);
    await chooser.setFiles({name:"LMV321 datasheet.pdf", mimeType:"application/pdf", buffer:datasheetPdf(4)});
    await reader.locator(".docs-page img").first().waitFor();
  };

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
    {name:"Preview a snip of an open datasheet page", async open() {
      await openDatasheet();
      await button(reader, "Snip").click();
      const box = await reader.evaluate(panel => {
        const view = panel.querySelector(".docs-pages").getBoundingClientRect();
        const shown = [...panel.querySelectorAll(".docs-page")].find(node => {
          const rect = node.getBoundingClientRect();
          return rect.top >= view.top - 2 && rect.top < view.bottom - 80 && node.querySelector("img");
        }).getBoundingClientRect();
        return {x:shown.x, y:shown.y, width:shown.width, height:shown.height};
      });
      await page.mouse.move(box.x + 12, box.y + 10);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * .7, box.y + box.height * .3, {steps:5});
      await page.mouse.up();
      await page.getByRole("dialog", {name:"Snip", exact:true}).locator("img").waitFor();
    }, async finish() {
      await button(reader, "Snip").click();
    }},
    {name:"Confirm embedding an open datasheet in the saved project", async open() {
      await openDatasheet();
      // Only the desktop asset transport is substituted; the confirmation comes before any of it is used.
      await page.evaluate(() => {
        if (!AtriumNavHost.folderProject()?.grant) throw Error("The notebook fixture is not an editable folder project.");
        const refuse = async () => { throw Error("The geometry fixture does not embed files."); };
        window.AtriumHost = {...window.AtriumHost, folderPickAsset:async () => null, folderStageAsset:refuse, folderDropAsset:refuse};
      });
      await button(reader, "More…").click();
      await page.getByRole("menuitem", {name:"Embed in project…", exact:true}).click();
      await button(page.getByRole("dialog", {name:"Embed datasheet", exact:true}), "Choose PDF…").waitFor();
    }, async finish() {
      await page.evaluate(() => {
        for (const name of ["folderPickAsset", "folderStageAsset", "folderDropAsset"]) delete window.AtriumHost?.[name];
      });
    }},
    {name:"Confirm downloading a datasheet that is not on this computer", async open() {
      await openDatasheet();
      await page.evaluate(() => {
        const host = AtriumNavHost;
        host.edit(() => {
          (host.project().datasheets ||= []).push({id:"018cc251-f400-7000-8000-0000000000ee", sha256:"0".repeat(63) + "1",
            byteLength:4096, title:"TPS7A20 regulator", version:"C", sourceURL:"https://www.ti.com/lit/ds/symlink/tps7a20.pdf"});
        }, "Reference a missing datasheet");
      });
      await button(reader, "More…").click();
      await page.getByRole("menuitem", {name:"Show all datasheets", exact:true}).click();
      await reader.locator(".ui-row", {hasText:"TPS7A20"}).click();
      await reader.locator(".ui-notice", {hasText:"Not on this computer"}).waitFor();
      await button(reader, "Download").click();
      await button(page.getByRole("dialog", {name:"Download datasheet", exact:true}), "Download").waitFor();
    }},
  ];
}

module.exports = {cases};
