"use strict";

globalThis.AtriumPlacement = (() => {
  const A = Atrium;

  function newInstance(item, id = A.id()) {
    item.id = id;
    delete item.schSource;
    delete item.sourceRecord;
    delete item.altiumSourceId;
    delete item.kicadSourceId;
    delete item.kicadPath;
    delete item.kicadPaths;
    delete item.kicadUuid;
    if (item.kind === "part") item.link = A.id();
  }

  function refAllocator(project) {
    const used = new Set(), next = new Map();
    for (const doc of project.documents) for (const item of doc.items) {
      if (item.kind === "part") used.add(item.ref.toUpperCase());
    }
    return prefix => {
      const key = prefix.toUpperCase();
      let number = next.get(key) || 1;
      while (used.has(key + number)) number++;
      used.add(key + number);
      next.set(key, number + 1);
      return prefix + number;
    };
  }

  function definitionKey(definition) {
    const {id, ...content} = definition;
    // Definition records use JSON values. Sort object keys at each depth and keep array order.
    return JSON.stringify(content, (_key, value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
    });
  }

  return Object.freeze({newInstance, refAllocator, definitionKey});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumPlacement;
