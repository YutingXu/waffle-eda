"use strict";

// File filters and capability discovery work offline in the browser and the desktop hosts.
// translator-table.js is the generated script form of translators.json.
globalThis.AtriumTranslatorRegistry = (() => {
  const limits = Object.freeze({sniffBytes: 8192, files: 500, fileBytes: 256 * 1048576, totalBytes: 1024 * 1048576});
  const directions = ["import", "export"];
  const rows = globalThis.AtriumTranslatorTable;
  const suffix = name => /\.[^./\\]+$/.exec(String(name || "").toLowerCase())?.[0] || "";
  const byId = new Map(), byExtension = new Map(), libraries = new Set(), projects = new Set([".waffle",".zip"]);
  for (const row of rows) {
    for (const value of Object.values(row.modules)) Object.freeze(value);
    for (const value of Object.values(row)) if (value && typeof value === "object") Object.freeze(value);
    Object.freeze(row);
    byId.set(row.id, row);
    for (const ext of row.extensions) {
      if (!byExtension.has(ext)) byExtension.set(ext, []);
      byExtension.get(ext).push(row);
    }
    if (row.import) {
      for (const ext of row.libraryExtensions || []) libraries.add(ext);
      for (const ext of row.projectExtensions || []) projects.add(ext);
    }
  }
  Object.freeze(rows);
  const list = direction => direction == null ? rows.slice() : directions.includes(direction) ? rows.filter(row => row[direction]) : [];
  const get = id => byId.get(id) || null;
  const forName = (name, direction = "import") =>
    (byExtension.get(suffix(name)) || []).find(row => direction == null || directions.includes(direction) && row[direction]) || null;
  const extensions = (direction = "import") => [...new Set(list(direction).flatMap(row => row.extensions))];
  const accept = direction => extensions(direction).join(",");

  // A detector looks only at a bounded header.
  // It selects a parser. That parser still validates the complete file inside the worker.
  function detect(name, input) {
    const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) :
      input instanceof ArrayBuffer ? new Uint8Array(input) : null;
    if (!bytes) return null;
    const obsolete = globalThis.AtriumObsoleteProject, ext = suffix(name);
    obsolete.reject(bytes,name);
    const head = obsolete.prefix(bytes,limits.sniffBytes);
    const named = forName(name);
    if (head.startsWith("{")) {
      if (/^\{[^\r\n]*\}\s*[\r\n]\s*\{/.test(head)) return null;
      const header = obsolete.header(head);
      if (header.format === "atrium-library") return get("waffle-library");
      if (header.kind && header.version && !header.design) return null;
    }
    if (/^\(kicad_(?:pcb|sch)\b/.test(head)) return get("kicad");
    if (head.startsWith("<") && /<eagle[\s>]/i.test(head)) return get("eagle");
    if (/^ISO-10303-21\s*;/i.test(head)) return get("step");
    if (/^\.HEADER\b[\s\S]*?\b(?:BOARD|LIBRARY)_FILE\b/im.test(head)) return get("idf");
    if (head.startsWith("<") && /<(?:[\w.-]+:)?EDMDDataSet\b/i.test(head)) return get("idx");
    if (/^\(export\b/i.test(head)) return get("netlist-kicad");
    if (ext === ".net" || ext === ".frp" || ext === ".txt") {
      if (head.startsWith("[") || /^\(\s*[\r\n]/.test(head)) return get("netlist-protel");
      if (ext !== ".txt") return null;
    }
    if (ext === ".csv" || ext === ".txt") {
      const header = head.split(/[\r\n]/, 1)[0].split(",").map(c => c.trim().replace(/^"|"$/g, "").toLowerCase());
      return header.includes("net") && header.some(c => ["designator", "ref", "reference", "component"].includes(c)) ? get("netlist-csv") : null;
    }
    if (ext === ".xml") return null;
    return named;
  }

  // Expand only the references the document view displays. Numeric record ranges preserve
  // zero padding. An adapter that reports a whole source section retains that section's count.
  function* unpack(values, skip) {
    for (const v of values) {
      if (v && typeof v === "object" && "first" in v) {
        const length = v.last - v.first + 1;
        if (skip >= length) { skip -= length; continue; }
        for (let n = v.first + skip; n <= v.last; n++) yield {object: v.prefix + String(n).padStart(v.width, "0"), count: 1};
        skip = 0;
      } else if (skip) skip--;
      else yield v && typeof v === "object" ? v : {object: v, count: 1};
    }
  }
  function* references(row, offset = 0) {
    for (const ref of row?.references || []) {
      if (!ref.grouped) { if (offset) offset--; else yield ref; continue; }
      if (offset >= ref.referenceCount) { offset -= ref.referenceCount; continue; }
      const ids = ref.ids && unpack(ref.ids, offset);
      for (const {object, count} of unpack(ref.objects, offset)) {
        const id = ids?.next().value?.object;
        yield {source: {file: ref.source.file, ...(object != null ? {object} : {})}, count,
          ...(ref.status ? {status: ref.status} : {}), ...(ref.reason ? {reason: ref.reason} : {}), ...(id != null ? {id} : {})};
      }
      offset = 0;
    }
  }
  function referencePage(report, {kind, offset = 0, limit = 100} = {}) {
    if (!kind || typeof kind !== "string" || !Number.isSafeInteger(offset) || offset < 0 ||
        !Number.isInteger(limit) || limit < 1 || limit > 200) throw Error("Choose a report kind, a nonnegative offset and a page size from 1 to 200.");
    const row = report.kinds.find(row => row.kind === kind);
    const total = row?.referenceCount || 0, items = [];
    if (offset < total) for (const ref of references(row, offset)) {
      items.push(ref);
      if (items.length === limit) break;
    }
    return {kind, offset, total, items, nextOffset: offset + items.length < total ? offset + items.length : null};
  }

  return Object.freeze({limits, references, referencePage, get, list, forName, detect, extensions, accept,
    isLibrary: name => libraries.has(suffix(name)), isProject: name => projects.has(suffix(name))});
})();
