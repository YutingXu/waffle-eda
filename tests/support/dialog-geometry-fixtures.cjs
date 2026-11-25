"use strict";

// The cases exercise real state-dependent editor forms, layered dialogs and an
// actual native fixture. Only their input files and editor selection are seeded.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const {existsSync} = require("node:fs");
const path = require("node:path");

const workshop = path.join(__dirname, "../fixtures/format-2/workshop");
const manifest = "Reference.waffle";

async function memberBytes(root, prefix = "") {
  const files = [];
  for (const member of await fs.readdir(path.join(root, prefix), {withFileTypes:true})) {
    const name = path.posix.join(prefix, member.name);
    if (member.isDirectory()) files.push(...await memberBytes(root, name));
    else if (member.isFile()) files.push({name, data:(await fs.readFile(path.join(root, name))).toString("base64")});
  }
  return files;
}

function cases(page) {
  const dialog = name => page.getByRole("dialog", {name, exact:typeof name === "string"});
  const button = (scope, name) => scope.getByRole("button", {name, exact:true});
  const run = async action => page.evaluate(action => { AtriumNavHost.act(action); }, action);
  const select = async (kind, item = null) => {
    const changed = await page.evaluate(async ({kind, item}) => {
      const host = AtriumNavHost, ref = host.documentRefs().find(doc => doc.kind === kind);
      if (!ref) return false;
      await host.selectDocument(ref.id);
      const doc = host.doc();
      if (doc.id !== ref.id) return false;
      const choice = item && doc.items.find(candidate => candidate.kind === item);
      if (item && !choice) return false;
      host.select(choice ? [choice.id] : []);
      return true;
    }, {kind, item});
    assert.ok(changed, `The fixture needs an available ${kind} ${item ?? "document"}.`);
  };
  const openFor = async (kind, item, action, title) => {
    await select(kind, item);
    await run(action);
    const target = dialog(title);
    await target.waitFor();
    return target;
  };
  const assertMeasures = async target => {
    const layouts = await target.locator(".ui-field-measure:visible:has(input.ui-field-number)").evaluateAll(nodes => nodes.map(node => {
      const input = node.querySelector("input"), unit = node.querySelector(".ui-field-unit");
      const field = input.getBoundingClientRect(), marker = unit.getBoundingClientRect();
      return {
        name:input.getAttribute("aria-label"), width:field.width, height:field.height,
        gap:marker.left - field.right, targetHeight:input.closest("label").getBoundingClientRect().height,
        touch:matchMedia("(any-pointer:coarse)").matches,
      };
    }));
    assert.ok(layouts.length, "The form has a numeric Field with an external unit.");
    for (const layout of layouts) {
      assert.equal(layout.width, 80, `${layout.name} numeric width`);
      assert.equal(layout.height, 28, `${layout.name} Field height`);
      assert.equal(layout.gap, 4, `${layout.name} external unit gap`);
      if (layout.touch) assert.ok(layout.targetHeight >= 44, `${layout.name} touch label height`);
    }
  };
  const hasReportPrint = existsSync(path.join(__dirname,"../../app/formats/print-report.js"));
  const reportPrint = {
    name:"Print a Bill of Materials using the shared report dialog",
    async open() {
      const bom = await openFor("pcb",null,"bom",/^Bill of Materials/);
      await button(bom,"Print…").click();
      const target = page.locator("dialog.print-report-dialog[open]");
      await target.getByRole("combobox",{name:"Paper",exact:true}).waitFor();
      await target.locator(".print-thumb img").first().waitFor();
    },
  };
  return [
    ...(hasReportPrint ? [reportPrint] : []),
    {
      name:"Export a PCB from the File menu",
      async open() {
        await select("pcb");
        const file = page.locator('.work-menu[data-menu="file"]');
        await file.locator(":scope > summary").click();
        await file.getByRole("menuitem", {name:"Export", exact:true}).click();
        await file.getByRole("menuitem", {name:"PDF…", exact:true}).click();
        const target = dialog("Export PDF");
        await target.getByRole("combobox", {name:"Paper", exact:true}).waitFor();
        await button(target, "Current document").click();
        const documents = target.getByRole("group", {name:"Documents", exact:true});
        assert.equal(await documents.getByRole("checkbox", {checked:true}).count(), 1);
        assert.ok(await documents.getByRole("checkbox", {name:/ \(board\)$/}).isChecked(), "Current document includes the PCB.");
        await target.getByRole("img", {name:/^Sensor board — /}).first().waitFor();
        assert.equal(await target.locator('.ui-dialog-actions [data-variant="primary"]').textContent(), "Export PDF…");
      },
    },
    {
      name:"PCB Find Similar with a selected track",
      async open() {
        const target = await openFor("pcb", "track", "find-similar", "Find Similar Objects");
        await target.locator("select").first().waitFor();
      },
    },
    {
      name:"Schematic Find Similar with a selected component",
      async open() {
        const target = await openFor("schematic", "part", "find-similar", "Find Similar Objects");
        await target.locator("select").first().waitFor();
      },
    },
    {
      name:"Via Stack in Full Stack mode",
      async open() {
        const target = await openFor("pcb", "via", "viaStack", "Via stack");
        await target.getByRole("radio", {name:"Full Stack", exact:true}).click();
        await target.locator(".vs-table input").first().waitFor();
        await assertMeasures(target);
      },
    },
    {
      name:"Via Templates reached from a selected via",
      async open() {
        const target = await openFor("pcb", "via", "viaStack", "Via stack");
        await button(target, "Templates…").click();
        await dialog(/via templates/i).waitFor();
      },
    },
    {
      name:"Board Shape dimension controls",
      async open() {
        const target = await openFor("pcb", null, "board-shape", "Board Shape");
        await target.getByRole("tab", {name:"Dimensions & Corners", exact:true}).click();
        await target.locator(".bsh-num:visible").first().waitFor();
        await assertMeasures(target);
      },
    },
    {
      name:"Board perimeter text editor",
      async open() {
        await select("pcb");
        const inspector = page.locator("#inspector");
        if (!await inspector.isVisible()) {
          const windowMenu = page.locator('.work-menu[data-menu="window"]');
          const panels = windowMenu.locator("#sub-window-panels");
          await windowMenu.locator(":scope > summary").click();
          await panels.locator(":scope > button.submenu-trigger").click();
          await panels.locator('[data-action="toggle-right"]').click();
          await inspector.waitFor();
        }
        const settings = inspector.locator("summary", {hasText:/^Document settings$/});
        const open = await settings.evaluate(node => node.closest("details").open);
        if (!open) await settings.click();
        await inspector.getByRole("button", {name:"Edit perimeter", exact:true}).click();
        await dialog("Board perimeter").getByRole("textbox").waitFor();
      },
    },
    {
      name:"Symbol Editor pin table for a placed component",
      async open() {
        const target = await openFor("schematic", "part", "edit-symbol", /^Symbol Editor/);
        await button(target, "Pin table").click();
        await target.locator(".se-table input").first().waitFor();
      },
    },
    {
      name:"Footprint Editor for a placed component",
      async open() {
        const target = await openFor("pcb", "part", "edit-footprint", /^Footprint Editor/);
        await target.locator(".fe-props input").first().waitFor();
        await assertMeasures(target);
      },
    },
    {
      name:"IPC Footprint Wizard package family choices",
      async open() {
        const target = await openFor("pcb", null, "footprint-wizard", "IPC-7351B Footprint Wizard");
        const family = target.getByRole("combobox", {name:"Package family", exact:true});
        await family.press("ArrowDown");
        await target.getByRole("option").first().waitFor();
        await assertMeasures(target);
        const widths = await target.locator(".fw-row input.ui-field-number:visible").evaluateAll(inputs => inputs.map(input => input.getBoundingClientRect().width));
        assert.ok(widths.length > 3 && widths.every(width => width === 80), "the IPC dimension table keeps its 80px numeric fields");
      },
    },
    {
      name:"Nested Batch Footprints",
      async open() {
        const target = await openFor("pcb", null, "footprint-wizard", "IPC-7351B Footprint Wizard");
        await button(target, "Batch…").click();
        await dialog("Batch Footprints").getByRole("textbox", {name:"Footprint specs (CSV)"}).waitFor();
      },
    },
    {
      name:"Paste Array with a copied PCB track",
      async open() {
        await select("pcb", "track");
        await run("copy");
        await run("paste-array");
        await dialog("Paste Array").getByRole("textbox").first().waitFor();
      },
    },
    {
      name:"Align two placed components",
      async open() {
        await select("pcb");
        await page.evaluate(() => {
          const parts = AtriumNavHost.doc().items.filter(item => item.kind === "part").slice(0,2);
          if (parts.length !== 2) throw Error("Align Objects needs two placed PCB parts.");
          AtriumNavHost.select(parts.map(part => part.id));
          AtriumNavHost.act("align-dialog");
        });
        await dialog("Align Objects").getByRole("textbox", {name:/Horizontal spacing/}).waitFor();
      },
    },
    {
      name:"Replace a schematic component with a pin-compatible library part",
      async open() {
        await select("schematic", "part");
        await page.evaluate(async () => {
          const swap = await AtriumLazy.need("AtriumSwap"), host = AtriumNavHost, id = host.selection()[0];
          const part = host.doc().items.find(item => item.id === id);
          if (!swap.libraryCandidates(host.doc(),host.defs(),id).length) {
            const replacement = structuredClone(host.defs().get(part.def));
            replacement.id = Atrium.id(); replacement.name = "Compatible demo library part";
            host.edit(() => host.project().library.push(replacement), "Add a compatible library part");
          }
          host.select([id]);
          host.act("swap-library");
        });
        await dialog(/^Replace .+ with$/).getByRole("option").first().waitFor();
      },
    },
    {
      name:"Waive a measured PCB width violation",
      async open() {
        await select("pcb");
        await page.evaluate(async () => {
          const [rules, waiver] = await AtriumLazy.need(["AtriumRules", "AtriumDRCWaivers"]), host = AtriumNavHost;
          const doc = host.doc(), id = Atrium.id();
          host.edit(() => doc.items.push({id,kind:"track",layer:"Top",net:"QA WIDTH",width:.025,points:[[4,2],[8,2]]}), "Add narrow test trace");
          const result = rules.drc(doc, host.defs(), rules.effective(doc,host.project()), {types:["width"],limit:100});
          const violation = result.violations.find(item => (item.id === id || item.otherId === id) && waiver.canWaive(item));
          if (!violation) throw Error("The DRC fixture did not produce a waivable violation.");
          waiver.waiveDialog(host, violation);
        });
        await dialog("Waive Violation").getByRole("textbox", {name:"Note (optional)"}).waitFor();
      },
    },
    {
      name:"Waive a measured schematic rule problem",
      async open() {
        await select("schematic", "part");
        await page.evaluate(async () => {
          const [inspector, checks, erc] = await AtriumLazy.need(["AtriumDRCInspector", "AtriumChecks", "AtriumERC"]), host = AtriumNavHost;
          const doc = host.doc(), part = doc.items.find(item => host.selection().includes(item.id) && item.kind === "part");
          const duplicate = {...structuredClone(part),id:Atrium.id(),link:Atrium.id(),x:part.x+2*doc.grid,y:part.y+2*doc.grid};
          host.edit(() => doc.items.push(duplicate), "Add repeated reference for a schematic check");
          const result = await erc.runAsync(host.project());
          const problems = result.messages.filter(item => item.documentId === doc.id).map(item => checks.fromERC(item));
          const problem = problems.find(item => item?.objects?.includes(duplicate.id)) || problems.find(item => item?.objects?.length);
          if (!problem) throw Error("The ERC fixture did not produce a named schematic problem.");
          inspector.open(host,problem);
        });
        await page.getByRole("button", {name:"Waive…", exact:true}).filter({visible:true}).first().click();
        await dialog("Waive Problem").getByRole("textbox", {name:"Note (optional)"}).waitFor();
      },
    },
    {
      name:"Simulate while extensions are paused",
      async open() {
        await select("schematic");
        await page.evaluate(async () => {
          const extensions = await AtriumLazy.need("AtriumExtensions");
          await AtriumLazy.need("AtriumSimMenu");
          extensions.setSafeMode(true);
          AtriumNavHost.act("simulate");
        });
        await dialog("Simulate").getByRole("button", {name:"Resume Extensions", exact:true}).waitFor();
      },
    },
    {
      name:"What’s New with live keyboard hints",
      async open() {
        await page.evaluate(async () => {
          await AtriumLazy.need("AtriumWhatsNew");
          AtriumNavHost.act("whats-new");
        });
        await dialog("What’s New").getByRole("button", {name:"Close", exact:true}).waitFor();
      },
    },
    {
      name:"Getting started guide from the Welcome page",
      async open() {
        await page.evaluate(async () => {
          const start = await AtriumLazy.need("AtriumStartPage");
          start.open();
        });
        const start = page.locator("dialog.sp-dialog[open]");
        await button(start,"Getting started").click();
        await dialog("Getting started").getByRole("heading",{name:"Welcome and recent projects",exact:true}).waitFor();
      },
    },
    {
      name:"Appearance preferences",
      async open() {
        await page.evaluate(() => AtriumNavHost.act("theme-preferences"));
        await page.locator("dialog.prf-dialog[open]").getByRole("radiogroup", {name:"Color theme", exact:true}).waitFor();
      },
    },
    {
      name:"Single Altium manifest asks for its project folder",
      async open() {
        const name = "PCB-PiDP11IOExpander.PrjPcb";
        const data = (await fs.readFile(path.join(__dirname,"../fixtures/altium/pidp11-io-expander",name))).toString("base64");
        await page.evaluate(async ({name,data}) => {
          const translator = await AtriumLazy.need("AtriumTranslatorClient");
          const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
          globalThis.geometryAltiumOpening = translator.projectFiles([new File([bytes],name)]);
        }, {name,data});
        await dialog("Open Altium project").getByRole("button", {name:/^Choose (folder|documents)…$/}).waitFor();
      },
    },
    {
      name:"Single native manifest asks for its containing folder",
      async open() {
        const files = await memberBytes(workshop);
        const file = files.find(file => file.name === manifest);
        assert.ok(file, "The actual Workshop fixture has a manifest.");
        await page.evaluate(async ({name,data}) => {
          await globalThis.geometryAltiumOpening;
          const bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
          globalThis.geometryManifestOpening = AtriumNavHost.openFiles([new File([bytes], name)]);
        }, file);
        await dialog("Open project folder").getByRole("button", {name:"Choose folder…", exact:true}).waitFor();
      },
    },
    {
      name:"Native project ZIP selection",
      async open() {
        const files = await memberBytes(workshop);
        await page.evaluate(async files => {
          await globalThis.geometryManifestOpening;
          const zip = await AtriumLazy.need("AtriumZip");
          const bytes = zip.create(files.map(file => ({
            name:"Workshop/" + file.name, data:Uint8Array.from(atob(file.data), char => char.charCodeAt(0)),
          })));
          globalThis.geometryZipResult = null;
          AtriumNavHost.openFiles([new File([bytes], "Workshop.zip")]).then(result => {
            globalThis.geometryZipResult = {result};
          }, error => { globalThis.geometryZipResult = {error:error.message}; });
        }, files);
        const picker = dialog("Open project ZIP");
        await picker.getByRole("combobox").getByRole("option", {name:`Workshop/${manifest}`}).waitFor({state:"attached"});
      },
      async finish() {
        const picker = dialog("Open project ZIP");
        await button(picker,"Cancel").click();
        await picker.waitFor({state:"hidden"});
        await page.waitForFunction(() => globalThis.geometryZipResult !== null, null, {timeout:5000});
        assert.deepEqual(await page.evaluate(() => globalThis.geometryZipResult), {result:false}, "Cancel settles the archive chooser.");
      },
    },
    {
      name:"Assembly drawing view from the saved Workshop fixture",
      async open() {
        const files = await memberBytes(workshop);
        await page.evaluate(async ({name, files}) => {
          const browser = await AtriumLazy.need("AtriumBrowserProject");
          const host = AtriumNavHost;
          await host.replaceProject(structuredClone(globalThis.geometryDemoProject), {force:true, dirty:false});
          const members = new Map(files.map(file => [file.name, Uint8Array.from(atob(file.data), char => char.charCodeAt(0))]));
          const folder = browser.create(name, members);
          globalThis.geometryWorkshopOpen = null;
          host.openFiles([{name, folderProject:folder}]).then(result => {
            globalThis.geometryWorkshopOpen = {result};
          }, error => { globalThis.geometryWorkshopOpen = {error:error.message}; });
        }, {name:manifest, files});
        await page.waitForFunction(() => globalThis.geometryWorkshopOpen !== null, null, {timeout:5000});
        assert.deepEqual(await page.evaluate(() => globalThis.geometryWorkshopOpen), {result:true},
          "The Workshop native folder opens through the ordinary project intake.");
        const target = await openFor("drawing", null, "drawing-view", "Add Drawing View");
        await target.getByRole("combobox", {name:"View", exact:true}).selectOption("assembly");
        await target.getByRole("combobox", {name:"Side", exact:true}).waitFor();
      },
    },
    {
      name:"Report print dialog from the Bill of Materials",
      async open() {
        const bom = await openFor("schematic", null, "bom", "Bill of Materials");
        await button(bom, "Print…").click();
        await dialog("Print").locator(".print-pages").waitFor({state:"attached"});
      },
    },
    {
      name:"Input Diagnostics from Help",
      async open() {
        const target = await openFor("pcb", null, "input-diagnostics", "Input Diagnostics");
        await target.getByRole("textbox", {name:"Input events", exact:true}).waitFor();
      },
    },
  ];
}

module.exports = {cases};
