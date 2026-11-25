"use strict";

// The checkout owns canonical app paths. Walk it once per process; JavaScriptCore
// receives that same inventory and does not enumerate the directory itself.
// Aliases are historical names whose basename is not the current file.
// butter-catalog.js stays pointed at the generated, untracked command catalog.
const fs = require("node:fs");
const path = require("node:path");

const app = path.resolve(__dirname, "../../app");
const aliases = {
  "butter-ai-ui.js": "automation/ai-ui.js",
  "butter-ai.js": "automation/ai-service.js",
  "butter-ai.json": "automation/descriptors/ai.json",
  "butter-catalog.js": "automation/command-catalog.js",
  "butter-datasheets.js": "notebook/datasheet-commands.js",
  "butter-datasheets.json": "automation/descriptors/datasheets.json",
  "butter-drop.js": "automation/design-drop-service.js",
  "butter-drop.json": "automation/descriptors/drop.json",
  "butter-editor.js": "automation/editor-command-host.js",
  "butter-intel-ui.css": "editor/workspace-tools.css",
  "butter-intel-ui.js": "editor/workspace-tools.js",
  "butter-links-ui.js": "project/links-ui.js",
  "butter-links.js": "project/link-commands.js",
  "butter-links.json": "automation/descriptors/links.json",
  "butter-macros-ui.js": "automation/macros-ui.js",
  "butter-macros.js": "automation/macro-service.js",
  "butter-macros.json": "automation/descriptors/macros.json",
  "butter-motion.js": "editor/motion-service.js",
  "butter-motion.json": "automation/descriptors/motion.json",
  "butter-numericFields.js": "editor/numeric-field-commands.js",
  "butter-numericFields.json": "automation/descriptors/numeric-fields.json",
  "butter-odb.js": "formats/odb-commands.js",
  "butter-odb.json": "automation/descriptors/odb.json",
  "butter-query-service.js": "checks/query-service.js",
  "butter-query-ui.js": "checks/query-ui.js",
  "butter-query.js": "checks/query-commands.js",
  "butter-query.json": "automation/descriptors/query.json",
  "butter-savedViews.js": "project/saved-view-commands.js",
  "butter-savedViews.json": "automation/descriptors/saved-views.json",
  "butter-slides.js": "notebook/slide-commands.js",
  "butter-slides.json": "automation/descriptors/slides.json",
  "butter-tables.js": "notebook/table-commands.js",
  "butter-tables.json": "automation/descriptors/tables.json",
  "butter-visualHistory.js": "history/visual-history-commands.js",
  "butter-visualHistory.json": "automation/descriptors/visual-history.json",
  "butter-windows-ui.js": "native-bridge/window-commands-ui.js",
  "butter-windows.js": "native-bridge/window-commands.js",
  "butter-windows.json": "automation/descriptors/windows.json",
  "butter.js": "automation/command-broker.js",
  "motion.js": "editor/editor-motion.js",
};
const inventories = new Map();

function walk(root) {
  const found = new Map();
  const collisions = new Set();
  const visit = dir => {
    const entries = fs.readdirSync(dir, {withFileTypes: true});
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (found.has(entry.name) || collisions.has(entry.name)) {
        collisions.add(entry.name);
        found.delete(entry.name);
        continue;
      }
      found.set(entry.name, relative);
    }
  };
  visit(root);
  if (collisions.size)
    throw new Error("app source basename collision: " + [...collisions].sort().join(", "));
  return found;
}

function inventoryFrom(root) {
  const resolved = path.resolve(root || app);
  if (inventories.has(resolved)) return inventories.get(resolved);
  const injected = resolved === app && globalThis.ATRIUM_APP_SOURCE_INVENTORY;
  const built = injected ? new Map(globalThis.ATRIUM_APP_SOURCE_INVENTORY) : walk(resolved);
  inventories.set(resolved, built);
  return built;
}

function relativeName(name) {
  if (Object.hasOwn(aliases, name)) return aliases[name];
  const table = inventoryFrom();
  if (table.has(name)) return table.get(name);
  const script = name + ".js";
  if (Object.hasOwn(aliases, script)) return aliases[script];
  if (table.has(script)) return table.get(script);
  return name;
}

function appFileFrom(base, ...parts) {
  return path.join(base, relativeName(parts.join("/")));
}

exports.inventoryFrom = inventoryFrom;
exports.appFileFrom = appFileFrom;
exports.appFile = (...parts) => appFileFrom(app, ...parts);
