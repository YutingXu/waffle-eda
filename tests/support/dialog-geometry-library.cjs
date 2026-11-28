"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");

function cases(page) {
  const outcomes = [];
  const dialog = name => page.getByRole("dialog", {name, exact:typeof name === "string"});
  const button = (scope, name) => scope.getByRole("button", {name, exact:typeof name === "string"});
  const panel = page.locator(".panel-library:visible");
  const source = panel.getByRole("combobox", {name:"Library source", exact:true});
  const add = (name, open) => outcomes.push({name, open});
  // The Library's menus: its sources ("Add library"), its commands ("Library commands") and the selected
  // component's actions ("More component actions" in the detail).
  async function menu(trigger, name) {
    await trigger.click();
    await page.getByRole("menuitem", {name, exact:typeof name === "string"}).click();
  }
  const addLibrary = name => menu(button(panel, "Add library"), name);
  const libraryCommand = name => menu(button(panel, "Library commands"), name);
  const componentCommand = name => menu(button(panel.locator(".lib-detail"), "More component actions"), name);

  async function action(action) {
    await page.evaluate(async action => {
      const host = AtriumNavHost;
      const dependencies = AtriumLazy.forAction(action, host.doc().kind);
      if (dependencies) await AtriumLazy.need(dependencies);
      host.act(action);
    }, action);
  }

  async function schematic() {
    const selected = await page.evaluate(async () => {
      const host = AtriumNavHost, sheet = host.documentRefs().find(d => d.kind === "schematic");
      await host.selectDocument(sheet.id);
      host.select([]);
      return host.doc().kind;
    });
    assert.equal(selected, "schematic");
  }

  async function placeFixture(kind) {
    await schematic();
    return page.evaluate(async kind => {
      await AtriumLazy.need("AtriumGenericPartsUI");
      const host = AtriumNavHost, project = host.project(), sheet = host.doc(), at = [76.2, 38.1];
      let part;
      host.edit(() => {
        if (kind === "dynamic") part = AtriumDynamicSymbol.place(project, sheet, at).part;
        else {
          const spec = kind === "connector" ? AtriumConnectorGen.defaults("header")
            : kind === "placeholder" ? {family:"opamp"} : {family:"resistor", value:"10k"};
          const placed = AtriumGenericParts.place(project, sheet, at, spec);
          part = placed.part;
          if (kind === "resistor") {
            const exact = Atrium.clone(placed.def);
            delete exact.generic;
            Object.assign(exact, {id:Atrium.id(), name:"Geometry resistor", value:part.value, parameters:{Manufacturer:"Fixture", MPN:"GEOMETRY-R"}});
            project.library.push(exact);
          }
        }
      }, "Place library geometry fixture");
      host.select([part.id], part.id);
      return part.ref;
    }, kind);
  }

  async function library(id = "project") {
    if (!await panel.isVisible()) await action("library-panel");
    await source.waitFor();
    if (await source.inputValue() !== id) await source.selectOption(id);
    return panel;
  }

  async function selectDefinition(id, name) {
    await library();
    await panel.getByLabel("Search the library", {exact:true}).fill(name);
    await panel.locator(`.lib-row[data-def="${id}"]`).click();
    await panel.locator(".lib-detail-title").getByText(name, {exact:true}).waitFor();
  }

  async function linkedComponent() {
    return page.evaluate(async () => {
      await AtriumLazy.need("AtriumLibrary");
      const host = AtriumNavHost, project = host.project();
      const base = {...Atrium.clone(AtriumParts.catalogue.find(d => d.id === "std-r")),
        id:"geometry-source-resistor", name:"Geometry linked resistor", rev:1};
      const existing = project.library.find(def => def.libraryRef?.library === "geometry-source");
      if (existing) return {id:existing.id, name:existing.name};
      const lib = {id:"geometry-source", name:"Geometry library", path:"Geometry.atrlib", defs:[base]};
      let copy;
      host.edit(() => {
        copy = AtriumLibrary.addFromLibrary(lib, base, project);
        const older = AtriumLibrary.fromLibrary(lib, base, project);
        older.name = "Earlier geometry resistor";
        project.library.push(older);
      }, "Add library revision fixtures");
      lib.defs = [{...base, rev:2, value:"22 kΩ", footprint:{...base.footprint,
        pads:base.footprint.pads.map(pad => ({...pad, w:pad.w + .1}))}}];
      const sources = AtriumLibrary.sourceStore.list();
      sources.push(lib);
      if (!AtriumLibrary.sourceStore.save(sources)) throw Error("Could not register the portable library.");
      return {id:copy.id, name:copy.name};
    });
  }

  async function group() {
    await page.evaluate(async () => {
      await AtriumLazy.need("AtriumGroupLibraryUI");
      const id = "geometry-group";
      await AtriumGroupLocal.restore();
      if (AtriumGroupLocal.current(id)) return;
      const host = AtriumNavHost, project = host.project(), author = await AtriumGroupLocal.member("Geometry reviewer");
      const def = project.library.find(d => d.id === "std-r");
      host.edit(() => AtriumNetIntentIndex.setConventions(project, conventions => {
        conventions.stems = {...conventions.stems, rail:["GEOMETRY_RAIL"]};
      }), "Set geometry naming convention");
      await AtriumGroupLocal.edit({id, name:"Geometry group library"}, async group => {
        const revision = await group.propose(def, {author, project, note:"Review the geometry bench component"});
        await group.decide(group.preview(revision.key), "approved", author);
        await group.propose({...def, value:"15 kΩ"}, {author, project, parents:[revision.key], note:"Resistor value revision"});
      });
    });
    await library();
    await addLibrary("Group library…");
    const target = dialog("Group library");
    await target.getByLabel("Your display name", {exact:true}).fill("Geometry reviewer");
    await button(target, "Propose revision…").waitFor();
    return target;
  }

  add("Place Generic Component with resistor fields", async () => {
    await schematic();
    await action("generic-part");
    await dialog("Place Generic Component").getByRole("combobox", {name:"Package", exact:true}).waitFor();
  });
  add("Connector Generator for a new header", async () => {
    await schematic();
    await action("generic-connector");
    await button(dialog("Connector / Header Generator"), "Place").waitFor();
  });
  add("Connector Generator for a placed header", async () => {
    const ref = await placeFixture("connector");
    await button(page.locator("#inspector"), "Edit Connector…").click();
    await dialog("Edit Connector " + ref).getByText("Every pin keeps its connections", {exact:false}).waitFor();
  });
  add("Bind a placed resistor to a manufacturer part", async () => {
    const ref = await placeFixture("resistor");
    await action("generic-bind");
    const list = dialog("Bind " + ref + " to a Manufacturer Part").getByRole("listbox", {name:"Matching parts"});
    await list.getByRole("option", {name:/GEOMETRY-R/}).waitFor();
  });
  add("Finalise a dynamic connector with library destination", async () => {
    const ref = await placeFixture("dynamic");
    await action("dynamic-connector-finalise");
    const target = dialog("Finalise " + ref);
    await target.getByRole("checkbox", {name:/Also save it to a library/}).check();
    await target.getByRole("combobox", {name:"Library", exact:true}).waitFor();
  });
  add("Add another part of a dynamic connector", async () => {
    const ref = await placeFixture("dynamic");
    await action("dynamic-connector-add-part");
    await dialog("Add a Part of " + ref).getByRole("combobox", {name:"Sheet", exact:true}).waitFor();
  });

  add("Group library with a signed revision history", group);
  add("Propose a group component revision", async () => {
    await button(await group(), "Propose revision…").click();
    await dialog("Propose a component revision").getByLabel("Project component", {exact:true}).waitFor();
  });
  add("Propose project naming conventions to a group", async () => {
    await button(await group(), "Propose naming conventions…").click();
    await dialog("Propose naming conventions…").getByText("GEOMETRY_RAIL", {exact:true}).waitFor();
  });
  add("Review a pending group revision", async () => {
    await button(await group(), "Review…").click();
    await dialog(/^Review proposal · /).locator("svg.ld-svg").first().waitFor();
  });
  add("Review a group component revision from history", async () => {
    const row = (await group()).locator(".group-history").filter({hasText:/Approved by/}).first();
    await button(row, "View…").click();
    await dialog(/^Component history · /).locator("svg.ld-svg").first().waitFor();
  });

  outcomes.push({
    name:"Inspect a library revision through the exported diff helper",
    attribution:"direct exported helper, no normal UI caller",
    async open() {
      const {id} = await linkedComponent();
      const changes = await page.evaluate(id => {
        const host = AtriumNavHost, project = host.project(), lib = AtriumLibrary;
        const before = project.library.find(def => def.id === id);
        const source = lib.sourceStore.sources().find(item => item.id === before.libraryRef.library);
        const after = source.defs.find(def => def.id === "geometry-source-resistor");
        const changes = lib.diffDefs(before, after);
        lib.showDiff("Library revision changes", changes, () => host.edit(() => {
          lib.updateFromLibrary(project, before, source, after);
        }, "Update library revision"));
        return changes;
      }, id);
      const change = changes.find(line => line.includes("22 kΩ"));
      assert.ok(change, "the real library differ reports the source value change");
      await dialog("Library revision changes").getByText(change, {exact:true}).waitFor();
    },
  });

  add("Review a library component revision", async () => {
    const {name} = await linkedComponent();
    await library("geometry-source");
    await panel.getByLabel("Search the library", {exact:true}).fill(name);
    await panel.locator('.lib-row[data-def="geometry-source-resistor"]').click();
    await componentCommand(/^Update project \(/);
    await dialog(/^Update Geometry linked resistor from Geometry library /).locator("svg.ld-svg").first().waitFor();
  });
  add("Update placed parts with a linked older library copy", async () => {
    const {id, name} = await linkedComponent();
    await selectDefinition(id, name);
    await componentCommand("Update placed parts");
    await dialog("Update parts from " + name).getByRole("checkbox", {name:/Earlier geometry resistor/}).waitFor();
  });
  add("Check the project library", async () => {
    await library();
    await libraryCommand("Check library…");
    await dialog("Check project library").getByText(/error\(s\), .*warning\(s\)/).waitFor();
  });
  add("Check a registered portable library", async () => {
    await linkedComponent();
    await library("geometry-source");
    await libraryCommand("Check library…");
    await dialog("Check Geometry library").getByText(/error\(s\), .*warning\(s\)/).waitFor();
  });
  add("Check a folder library while its native entries load", async () => {
    const sourceId = await page.evaluate(async () => {
      await AtriumLazy.need("AtriumLibrarySourcesUI");
      const store = AtriumLibrarySources;
      const definition = AtriumParts.catalogue.find(d => d.id === "std-r");
      const record = {id:"geometry-cold-library", name:"Geometry folder library", kind:"files"};
      const provider = store.providers.memory(new Map([["components/geometry.json",
        {data:JSON.stringify(definition), mtime:1}]]));
      const read = provider.read.bind(provider);
      store.addFolder(record);
      const result = await store.scan(record, {provider});
      if (!result.library.defs.some(def => def.stub)) throw Error("The folder library must have an unloaded component.");
      const pending = new Promise(resolve => { window.geometryReleaseLibraryCheck = resolve; });
      provider.read = async name => { await pending; return read(name); };
      return result.library.id;
    });
    await library();
    await panel.getByLabel("Search the library", {exact:true}).fill("Resistor");
    await library(sourceId);
    await libraryCommand("Check library…");
    const target = dialog("Check Geometry folder library");
    await target.getByRole("status").filter({hasText:/Checking 0 of 1 components/}).waitFor();
    await target.evaluate(d => d.addEventListener("close", () => window.geometryReleaseLibraryCheck(), {once:true}));
  });
  add("Manage component family memberships", async () => {
    await selectDefinition("std-r", "Resistor");
    await componentCommand("Group component…");
    const target = dialog("Component families");
    await target.getByRole("combobox", {name:"Component to add", exact:true}).selectOption("std-c");
    await button(target, "Add component").click();
    await target.locator(".lib-family-member input").nth(1).waitFor();
  });
  add("Attach a real footprint to an unpaired symbol", async () => {
    const {id, name} = await page.evaluate(() => {
      const id = Atrium.id(), name = "Geometry unpaired symbol";
      const def = {...Atrium.clone(AtriumParts.catalogue.find(d => d.id === "std-r")), id, name};
      delete def.footprint;
      const host = AtriumNavHost;
      host.edit(() => host.project().library.push(def), "Add geometry loose symbol");
      return {id, name};
    });
    await selectDefinition(id, name);
    await componentCommand("Attach footprint…");
    const target = dialog("Attach footprint to " + name);
    await target.getByRole("combobox", {name:"Footprint to use", exact:true}).selectOption("std-r");
    await target.getByRole("button", {name:"Attach footprint", exact:true}).waitFor();
  });
  add("Add a package to a library component", async () => {
    await selectDefinition("std-r", "Resistor");
    await componentCommand("Add package…");
    await dialog("Add package to Resistor").getByRole("combobox").first().waitFor();
  });
  add("Save a library component to a new portable library", async () => {
    await selectDefinition("std-r", "Resistor");
    await componentCommand("Save to library…");
    const target = dialog("Save Resistor to a library");
    await target.getByRole("combobox", {name:"Target library", exact:true}).selectOption("@new");
    await target.getByRole("textbox", {name:"New library name", exact:true}).waitFor();
  });
  add("Manage registered library sources", async () => {
    await linkedComponent();
    await action("library-sources");
    await dialog("Library sources").getByRole("row").filter({hasText:"Geometry library"}).waitFor();
  });
  add("Save a library component to a folder", async () => {
    await selectDefinition("std-r", "Resistor");
    await componentCommand("Save to folder…");
    await dialog("Save to folder").getByRole("combobox", {name:"Library folder", exact:true}).waitFor();
  });
  add("Manage KiCad 3D model folders", async () => {
    await action("library-sources");
    await button(dialog("Library sources"), "KiCad 3D model folders…").click();
    await dialog("KiCad 3D model folders").waitFor();
  });
  add("Import a real KiCad library symbol", async () => {
    await library();
    const chooser = page.waitForEvent("filechooser");
    await addLibrary("Import library files…");
    await (await chooser).setFiles(path.join(__dirname, "../fixtures/kicad/Lab_Amp.kicad_sym"));
    await dialog("Import library components").locator(".lib-import-table tbody tr").first().waitFor();
  });
  add("Choose whether to download the KiCad libraries", async () => {
    await library();
    await addLibrary("Get KiCad libraries…");
    await button(dialog("Get KiCad libraries"), "Download").waitFor();
  });

  add("Place an op-amp placeholder", async () => {
    await schematic();
    await action("generic-placeholder");
    await dialog("Place Placeholder").getByRole("combobox", {name:"Footprint", exact:true}).waitFor();
  });
  add("Resolve Placeholder before any placeholders are placed", async () => {
    await schematic();
    await action("placeholder-resolve");
    await dialog("Resolve Placeholder").getByText(/no unresolved placeholders/).waitFor();
  });
  add("Review replacement for a placed placeholder", async () => {
    const ref = await placeFixture("placeholder");
    await action("placeholder-resolve");
    await dialog(new RegExp("^Resolve " + ref + " \\(")).getByRole("listbox", {name:"Candidates"}).waitFor();
  });
  add("New component in the pin-mapped library editor", async () => {
    await schematic();
    await page.evaluate(async () => {
      const editor = await AtriumLazy.need("AtriumLibraryEditor"), host = AtriumNavHost;
      editor.open({library:host.project().library, target:"schematic",
        commit:def => host.edit(() => host.project().library.push(def), "Add pin-mapped component")});
    });
    const target = dialog("New component");
    await target.getByRole("combobox", {name:"Start from", exact:true}).selectOption("std-r");
    await target.getByRole("button", {name:"Save component", exact:true}).waitFor();
  });
  add("Symbol Wizard with a parsed pin table", async () => {
    await schematic();
    await action("symbol-wizard");
    const target = dialog("Symbol Wizard");
    await target.getByRole("textbox", {name:"Pin table", exact:true}).fill("1 VDD power\n2 OUT output\n3 GND power");
    await target.locator(".sw-grid tbody tr").first().waitFor();
  });
  // The parameter filters popover, from the docked panel's Filters chip and from a facet chip in the Library tab.
  add("Filter the Library panel by parameter", async () => {
    await library();
    await button(panel, "Filters").click();
    await dialog("Parameter filters").locator("input,button").first().waitFor();
  });
  const workspace = page.locator("#doc-view-library");
  async function libraryTab() {
    await schematic();
    await action("library-workspace");
    await workspace.getByRole("toolbar", {name:"Library tools", exact:true}).waitFor();
    return workspace;
  }
  const closeLibraryTab = () => page.evaluate(() => AtriumLibraryView.close());
  outcomes.push({name:"Filter the Library tab by package", async open() {
    await button(await libraryTab(), "Package").click();
    await dialog("Package").locator("input,button").first().waitFor();
  }, finish:closeLibraryTab});
  // The New menu of the Library tab opens each drawing editor in its own editor tab, not as a modal dialog.
  // "New symbol…" also names its shortcut.
  for (const [command, title] of [[/^New symbol…/, "Symbol Editor"], [/^New footprint…/, "Footprint Editor"]]) {
    outcomes.push({name:`${title} in a Library editor tab`, async open() {
      await menu(button(await libraryTab(), "New"), command);
      const target = page.locator(`.lib-editor-surface[open][aria-label="${title}"]`);
      await target.waitFor();
      assert.equal(await target.evaluate(node => node.matches(":modal")), false, `The ${title} tab is not modal.`);
    }, finish:closeLibraryTab});
  }
  return outcomes;
}

module.exports = {cases};
