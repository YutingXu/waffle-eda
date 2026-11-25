"use strict";
// Load only the trusted installed SI engine from its built-in extension package.
// The browser still loads the same package through the extension sandbox.
(() => {
  const packages = globalThis.AtriumBuiltinExtensionPackages;
  const files = typeof module === "object" && module.exports
    ? require("../app/extensions/packages/waffle.si.js")
    : packages?.["waffle.si"];
  const members = ["ibis.js", "solver.js", "channel.js", "engine.js"];
  const manifest = JSON.parse(files?.["manifest.json"] || "null");
  if (manifest?.id !== "waffle.si" || manifest.builtin !== true) throw Error("Invalid built-in Signal Integrity package.");
  for (const name of members) {
    if (!Object.hasOwn(files, name) || typeof files[name] !== "string" || !files[name].trim()) {
      throw Error("The built-in Signal Integrity package is missing " + name + ".");
    }
  }
  for (const name of members) (0, eval)(files[name]);
  if (packages) delete packages["waffle.si"];
})();
