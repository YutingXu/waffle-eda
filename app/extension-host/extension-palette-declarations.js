"use strict";
// Validate optional manifest data before admitting it to the Notebook runtime.
globalThis.AtriumExtensionPaletteDeclarations = (() => {
  const idPattern = /^[a-z][a-z0-9_.-]{0,79}$/i;
  const id = value => typeof value === "string" && idPattern.test(value) && !["constructor", "prototype", "__proto__"].includes(value) ? value : "";
  const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);
  const bounded = (value, limit) => typeof value === "string" && value.length > 0 && value.length <= limit;
  const unique = (rows, field) => new Set(rows.map(x => x[field])).size === rows.length;
  const many = (v, n) => Array.isArray(v) && v.length <= n;
  const semver = value => typeof value === "string" && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value);
  const keys = ["insertItems", "paletteCommands", "searchProviders", "mathFunctions"];
  const declared = c => keys.some(k => c?.[k] !== undefined);
  function validate(manifest, files, fail) {
    const c = manifest.contributes, perms = manifest.permissions || [];
    for (const key of keys) {
      if (c[key] === undefined) continue;
      const rows = c[key], max = key === "searchProviders" ? 4 : 48;
      if (!many(rows, max) || rows.some(x => !plain(x) || !id(x.id)) || !unique(rows, "id")) fail(key + " needs distinct IDs and at most " + max + " entries.");
      for (const item of rows) {
        if (key === "mathFunctions") {
          if (!(item.id.startsWith(manifest.id + ".") && /^[a-z_][a-z0-9_-]*$/i.test(item.id.slice(manifest.id.length + 1)) && /^[a-z_][a-z0-9_-]*(\.[a-z_][a-z0-9_-]*)+$/i.test(item.id)) || !semver(item.version) || !many(item.arguments, 16) || item.arguments.some(a => !plain(a) || !id(a.name) || !id(a.dimension)) || !unique(item.arguments, "name") || !id(item.returns) || !bounded(item.expression, 2048) || !(bounded(item.domain, 512) || many(item.domain, 8) && item.domain.every(p => bounded(p, 256)))) fail("mathFunctions needs a package-qualified ID, version, typed arguments, return dimension, domain and pure expression.");
          if (item.dependencies !== undefined && (!many(item.dependencies, 16) || item.dependencies.some(d => !id(d?.id) || !semver(d.version)) || !unique(item.dependencies, "id"))) fail("mathFunctions dependencies need distinct IDs and exact versions.");
          continue;
        }
        if (!perms.includes("ui:command")) fail(key + " needs ui:command.");
        if (!bounded(item.name, 120) || !id(item.command) || /^(waffle|atrium)\./i.test(item.command)) fail(key + " entries need a name and an extension-owned command.");
        if (item.keywords !== undefined && (!many(item.keywords, 20) || item.keywords.some(x => !bounded(x, 80)))) fail("palette keywords must be a bounded list of words.");
        if (item.contexts !== undefined && (!many(item.contexts, 16) || item.contexts.some(x => !id(x)))) fail("palette contexts must be editor kind IDs.");
        if (item.actions !== undefined && (!many(item.actions, 12) || item.actions.some(a => !id(a?.id) || !bounded(a.label, 100)) || !unique(item.actions, "id"))) fail("palette actions need distinct IDs and labels.");
        if (key === "searchProviders") {
          if (!many(item.hosts, 8) || item.hosts.some(h => typeof h !== "string" || !perms.includes("network:" + h)) || new Set(item.hosts).size !== item.hosts.length) fail("searchProviders hosts must be distinct network:<host> permissions declared by this extension.");
          if (typeof item.module !== "string" || !/^(?:[\w-]+\/)*[\w-]+\.js$/.test(item.module) || (files && (!bounded(files[item.module], 65536)))) fail("searchProviders needs a packaged JavaScript module under 64 KiB.");
          if (item.data !== undefined && (typeof item.data !== "string" || !/^(?:[\w-]+\/)*[\w-]+\.json$/.test(item.data) || files && !bounded(files[item.data], 65536))) fail("searchProviders data must name a packaged JSON file under 64 KiB.");
        }
      }
    }
  }

  return Object.freeze({id,plain,bounded,keys,declared,validate});
})();
