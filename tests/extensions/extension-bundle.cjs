"use strict";
// Shipping uses the same app/extensions tree for all desktop packages.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const payload = __dirname + "/../../app/extensions";
const canonical = __dirname + "/../../extensions";

require("../../app/extensions/manifests.js");
const manifests = globalThis.AtriumBuiltinExtensionManifests;
const bundle = require("../../app/extensions/bundled.js");
assert.deepEqual(bundle.map(entry => entry.path), manifests.map(entry => entry.path));
assert.ok(bundle.length > 0);
const names = ["bundled.js", "manifests.js", ...manifests.map(({manifest}) => "packages/" + manifest.id + ".js")];
if (process.versions.node) {
  assert.deepEqual(fs.readdirSync(payload).sort(), ["bundled.js", "manifests.js", "packages"]);
  assert.deepEqual(fs.readdirSync(payload + "/packages").sort(), names.slice(2).map(name => name.split("/")[1]).sort());
}
const scripts = names.map(name => [name, fs.readFileSync(payload + "/" + name, "utf8")]);
for (const [i, {path: source, manifest}] of manifests.entries()) {
  const packagePath = "packages/" + manifest.id + ".js";
  assert.equal(require.cache[require.resolve("../../app/extensions/" + packagePath)], undefined);
  const files = bundle[i].files;
  assert.deepEqual(JSON.parse(files["manifest.json"]), manifest);
  const directory = canonical + "/" + source.split("/").pop();
  for (const [name, value] of Object.entries(files)) {
    const sourcePath = directory + "/" + name;
    const sourceValue = name.endsWith(".wasm") ? "data:application/wasm;base64," + fs.readFileSync(sourcePath).toString("base64")
      : fs.readFileSync(sourcePath, "utf8").replace(/\r\n/g, "\n");
    assert.equal(value, sourceValue);
  }
  const main = manifest.main.replace(/^\.?\/+/, "");
  const entrySource = JSON.stringify(files[main]).replace(/[\u007f-\uffff]/g, ch => "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0"));
  assert.deepEqual(scripts.filter(([, text]) => text.includes(entrySource)).map(([name]) => name), [packagePath]);
}
console.log("Each built-in has one shipped executable package and a lazy tooling entry.");
