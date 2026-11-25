"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {pathToFileURL} = require("node:url");
require("../../app/core/zip.js");

module.exports = async function extensionThemes(browser, appURL = pathToFileURL(path.join(__dirname, "../../app/index.html")).href) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "waffle-extension-themes-"));
  const context = await browser.newContext(), failures = [];
  await context.route(/^https?:/, route => route.abort());
  try {
    const page = await context.newPage(), errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    const dialog = name => page.getByRole("dialog", {name, exact: true});
    const button = (scope, name) => scope.getByRole("button", {name, exact: true});
    async function openEditor() {
      const welcome = page.getByRole("button", {name: "Continue to editor", exact: true});
      await page.waitForFunction(() => globalThis.AtriumStartPage?.isOpen() || globalThis.AtriumExtensions?.attached);
      if (await welcome.isVisible()) await welcome.click();
      await page.waitForFunction(() => globalThis.AtriumExtensions?.attached);
    }
    async function openManager() {
      await page.evaluate(() => AtriumExtensions.openManager());
      await dialog("Extensions").waitFor();
      return dialog("Extensions");
    }
    async function storedPackage(id) {
      return page.evaluate(id => new Promise((resolve, reject) => {
        const open = indexedDB.open("atrium-extensions", 1);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result, tx = db.transaction("packages");
          const read = tx.objectStore("packages").get(id);
          tx.oncomplete = () => { db.close(); resolve(read.result ?? null); };
          tx.onerror = () => { db.close(); reject(tx.error); };
        };
      }), id);
    }
    await page.goto(appURL);
    await openEditor();

    for (const [format, suffix] of [["folder", "json"], ["folder", "jsonc"], ["zip", "JSONC"], ["bundle", "jsonc"], ["dev", "jsonc"]]) {
      const id = "fixture.theme-" + format + "-" + suffix.toLowerCase(), name = "Fixture " + format + " " + suffix;
      const key = "themes/Dusk." + suffix, themeId = "ext:" + id + "/dusk";
      const manifest = {id, name, version: "1.0.0", main: "./code/main.js", apiVersion: 1, permissions: [],
        contributes: {themes: [{id: "dusk", label: name, path: "./themes\\Dusk." + suffix, uiTheme: "vs-dark"}]}};
      const plain = '"name":"Fixture Dusk","type":"dark","colors":{"editor.background":"#162432"}';
      const theme = suffix === "json" ? "{" + plain + "}" : "{// Fixture theme\n" + plain + ",\n}";
      const files = {"code/main.js": 'throw Error("Declarative themes do not activate the extension");',
        [key]: theme, "themes/unlisted.jsonc": "// Unlisted asset", "ignored.bin": "Unused binary suffix"};
      const packageFiles = {...files, "waffle-extension.json": JSON.stringify(manifest)};
      try {
        let input;
        if (format === "dev") {
          await page.evaluate(async () => (await AtriumLazy.need("AtriumExtensionDev")).setMode(true));
          await page.reload();
          await openEditor();
          await page.evaluate(() => AtriumLazy.need("AtriumExtensionDev").then(() => true));
        }
        if (format === "folder" || format === "dev") {
          input = path.join(root, name);
          await fs.mkdir(path.join(input, "themes"), {recursive: true});
          await fs.mkdir(path.join(input, "code"), {recursive: true});
          for (const [file, data] of Object.entries(packageFiles)) await fs.writeFile(path.join(input, file), data);
        } else if (format === "zip") {
          const entries = Object.entries(packageFiles).map(([name, data]) => ({name: "nested/" + name, data}));
          input = {name: "theme.zip", mimeType: "application/zip", buffer: Buffer.from(AtriumZip.create(entries))};
        } else {
          input = {name: "theme.waffle-extension", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({manifest, files}))};
        }
        const manager = await openManager();
        const trigger = button(manager, {folder: "Install folder…", dev: "Load unpacked…"}[format] || "Install from package…");
        const [chooser] = await Promise.all([page.waitForEvent("filechooser"), trigger.click()]);
        await chooser.setFiles(input);
        const consent = dialog("Install " + name + "?");
        const status = manager.getByRole("status");
        await consent.or(status.filter({hasText: /missing from the package/})).first().waitFor();
        assert.ok(await consent.isVisible(), await status.textContent());
        await button(consent, "Install").click();
        if (format === "dev") {
          await manager.locator(".ext-detail").getByRole("button", {name: "Unload", exact: true}).waitFor();
        } else {
          await manager.getByText(name + " 1.0.0 installed.", {exact: true}).waitFor();
        }
        await page.waitForFunction(({id, themeId}) => globalThis.AtriumThemes?.has(themeId) ||
          AtriumExtensions.logs(id).some(row => row.level === "error"), {id, themeId});
        const registration = await page.evaluate(({id, themeId}) => ({
          registered: globalThis.AtriumThemes?.list().find(theme => theme.id === themeId)?.ext,
          errors: AtriumExtensions.logs(id).filter(row => row.level === "error").map(row => row.text),
          permission: AtriumExtensions.permissions(id),
          started: AtriumExtensions.workers.some(worker => worker.members.includes(id))
        }), {id, themeId});
        assert.equal(registration.registered, id, JSON.stringify(registration));
        assert.deepEqual(registration.errors, []);
        assert.deepEqual(registration.permission, {declared: [], live: {}, network: []});
        assert.equal(registration.started, false);
        const saved = await storedPackage(id);
        if (format === "dev") assert.equal(saved, null);
        else {
          assert.equal(saved[key], theme);
          assert.deepEqual(Object.keys(saved).sort(), ["code/main.js", key, "waffle-extension.json"].sort());
        }
        if (format === "folder" && suffix === "jsonc") {
          await page.reload();
          await openEditor();
          await page.waitForFunction(themeId => globalThis.AtriumThemes?.has(themeId), themeId);
          await openManager();
          await dialog("Extensions").locator(".ext-cards").getByText(name, {exact: true}).click();
        }
        assert.equal(await page.evaluate(themeId => {
          AtriumThemes.select(themeId);
          return AtriumTheme.effectivePreset();
        }, themeId), themeId);
        if (format === "dev") await button(dialog("Extensions"), "Unload").click();
        else {
          await button(dialog("Extensions"), "Uninstall").click();
          await button(dialog("Uninstall " + name), "Uninstall").click();
        }
        await page.waitForFunction(({id, themeId}) => !AtriumExtensions.list().some(e => e.id === id)
          && !AtriumThemes.has(themeId) && AtriumTheme.effectivePreset() !== themeId, {id, themeId});
        assert.equal(await storedPackage(id), null);
        console.log("PASS extension theme " + format + " " + suffix + ": selected, applied and removed without starting code");
      } catch (error) {
        failures.push(new Error(format + " " + suffix + ": " + error.message, {cause: error}));
        await page.reload();
        await openEditor();
      }
    }
    assert.deepEqual(errors, []);
    if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join("\n"));
  } finally {
    await context.close();
    await fs.rm(root, {force: true, recursive: true});
  }
};
