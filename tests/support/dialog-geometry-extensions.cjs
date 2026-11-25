"use strict";

const assert = require("node:assert/strict");
const {createHash} = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const sample = path.join(__dirname, "../../extensions/examples/silk-labels");
const sampleManifest = JSON.parse(fs.readFileSync(path.join(sample, "waffle-extension.json"), "utf8"));
const samplePackage = Buffer.from(JSON.stringify({
  manifest:sampleManifest,
  files:{"main.js":fs.readFileSync(path.join(sample, "main.js"), "utf8")}
}));

function cases(page) {
  const dialog = name => page.getByRole("dialog", {name, exact:typeof name === "string"});
  const button = (scope, name) => scope.getByRole("button", {name, exact:typeof name === "string"});
  async function action(name) {
    await page.evaluate(async name => {
      const host = AtriumNavHost, dependencies = AtriumLazy.forAction(name, host.doc().kind);
      if (dependencies) await AtriumLazy.need(dependencies);
      host.act(name);
    }, name);
  }
  async function manager() {
    await page.locator(".ext-manager").waitFor({state:"detached"});
    await action("extensions");
    const target = dialog("Extensions");
    await button(target, "Install from package…").waitFor();
    const pause = target.getByRole("checkbox", {name:"Pause all"});
    if (await pause.isChecked()) await pause.uncheck();
    return target;
  }
  async function clickFile(trigger, file) {
    await trigger.waitFor();
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), trigger.click()]);
    await chooser.setFiles(file);
  }
  function loadPackage(target) {
    return clickFile(button(target, "Install from package…"), {
      name:"silk-labels.waffle-extension", mimeType:"application/json", buffer:samplePackage
    });
  }
  const install = () => dialog("Install Silkscreen Label Generator?");

  return [
    {name:"New Extension scaffold with invalid extension ID", async open() {
      await button(await manager(), "New Extension…").click();
      const target = dialog("New Extension");
      await target.getByRole("textbox", {name:"Extension id (publisher.name)"}).fill("not an id");
      await button(target, "Save scaffold…").click();
      await target.getByText(/Use an id like yourname.my-extension/).waitFor();
    }},
    {name:"Offline extension gallery with local index metadata", async open() {
      await button(await manager(), "Browse…").click();
      const target = dialog("Browse Extensions");
      const index = {format:"atrium-extension-index", version:1, name:"Waffle samples", extensions:[{
        ...sampleManifest, size:samplePackage.length, license:"MIT",
        sha256:createHash("sha256").update(samplePackage).digest("hex"),
        download:"https://example.org/silk-labels.waffle-extension"
      }]};
      await clickFile(button(target, "Open index file…"), {
        name:"waffle-samples.json", mimeType:"application/json", buffer:Buffer.from(JSON.stringify(index))
      });
      await target.getByText("Silkscreen Label Generator", {exact:true}).waitFor();
      await button(target, "Install from file…").waitFor();
      assert.equal(await target.getByRole("textbox", {name:"Registry URL"}).inputValue(), "");
    }},
    {name:"Local extension package permissions before install", async open() {
      await loadPackage(await manager());
      await install().getByRole("checkbox", {name:/read:project/}).waitFor();
      assert.equal(await page.evaluate(id => AtriumExtensions.list().some(extension => extension.id === id), sampleManifest.id), false);
    }},
    {name:"Modeless extension development console after loading an unpacked sample", async open() {
      await page.evaluate(async () => {
        await AtriumLazy.need("AtriumExtensionDev");
        await AtriumExtensionDev.setMode(true);
      });
      const target = await manager();
      await clickFile(button(target, "Load unpacked…"), sample);
      await install().getByText(/Developer mode: loaded unpacked/).waitFor();
      await button(install(), "Install").click();
      await button(target, "Console").click();
      const console = dialog("Extension console");
      await console.getByRole("log").getByText(/Loaded 1.0.0 unpacked/).waitFor();
      assert.equal(await console.getByRole("log").evaluate(log => log === document.activeElement), true);
      await button(console, "Close").click({trial:true});
    }},
    {name:"Extension manager settings for the unpacked generator", async open() {
      const target = await manager();
      await button(target, /Silkscreen Label Generator/).click();
      await target.getByRole("textbox", {name:/Label text/}).waitFor();
      assert.equal(await target.getByRole("spinbutton").count(), 2);
    }},
    {name:"Modeless panel contributed by the local extension starter", async open() {
      const target = await manager();
      const packageFiles = await page.evaluate(async () => {
        const D = await AtriumLazy.need("AtriumExtensionDev");
        const files = D.scaffoldFiles("geometry.inspect-parts").files;
        const manifest = JSON.parse(files["waffle-extension.json"]);
        manifest.contributes.panels[0].location = "dialog";
        return {manifest, files:{"main.js":files["main.js"]}};
      });
      await clickFile(button(target, "Install from package…"), {
        name:"inspect-parts.waffle-extension", mimeType:"application/json", buffer:Buffer.from(JSON.stringify(packageFiles))
      });
      const consent = dialog("Install Inspect Parts?");
      await button(consent, "Install").click();
      await target.getByText("Inspect Parts 0.1.0 installed.").waitFor();
      await button(target, "Close").click();
      await target.waitFor({state:"hidden"});
      await page.evaluate(() => AtriumExtensions.execute("inspectParts.show"));
      await dialog("Inspect Parts").getByRole("table").waitFor();
    }},
    {name:"Save a script in the current project without executing it", async open() {
      await action("scripting-console");
      const console = page.locator("#script-console");
      await console.getByRole("textbox", {name:"Script", exact:true}).fill("// Geometry fixture");
      await button(console, "Save this script").click();
      const target = dialog("Save script");
      await target.getByRole("textbox", {name:"Script name"}).fill("Review board inventory");
      await target.getByRole("combobox", {name:"Save location"}).selectOption("project");
    }},
    {name:"VS Code shortcut sheet filtered by an assigned key", async open() {
      await action("cheatsheet");
      const target = dialog("Keyboard shortcuts");
      await target.getByRole("searchbox", {name:"Filter shortcuts"}).fill("undo");
      await target.getByText("Undo", {exact:true}).first().waitFor();
    }},
    {name:"VS Code shortcut import with conflict and matching-key preview", async open() {
      await action("import-vscode-keybindings");
      const target = dialog("Import VS Code keybindings");
      await target.getByRole("textbox", {name:"VS Code keybindings JSON"}).fill(JSON.stringify([
        {key:"ctrl+shift+p", command:"workbench.action.files.save"},
        {key:"ctrl+s", command:"workbench.action.files.save"},
        {key:"alt+shift+f10", command:"workbench.action.showCommands"}
      ], null, 2));
      const preview = target.getByRole("table");
      await preview.getByText("workbench.action.showCommands", {exact:true}).waitFor();
      await preview.getByText(/^Conflict/).waitFor();
      await preview.getByText("Already set", {exact:true}).waitFor();
      assert.equal(await preview.locator(".ui-shortcut").count(), 3);
      await target.getByRole("checkbox", {name:"Skip bindings that conflict with an existing Waffle key"}).waitFor();
    }},
    {name:"Imported Preferences holds developer mode and update checks for consent", async open() {
      await page.evaluate(() => AtriumExtensionDev.setMode(false));
      await page.evaluate(async () => {
        await AtriumLazy.need("AtriumPrefs");
        AtriumPrefs.open("general");
      });
      const prefs = dialog("Preferences");
      await clickFile(button(prefs, "Import all settings…"), {name:"waffle-settings.json", mimeType:"application/json", buffer:Buffer.from(JSON.stringify({
        format:"atrium-settings", version:1, prefs:{"extensions.developerMode":true, "general.updateCheck":true}
      }))});
      const target = dialog("Imported settings");
      for (const label of [/extensions.developerMode/, /general.updateCheck/])
        assert.equal(await target.getByRole("checkbox", {name:label}).isChecked(), false);
    }},
  ];
}

module.exports = {cases};
