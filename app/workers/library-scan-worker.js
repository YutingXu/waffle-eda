"use strict";
// One short-lived worker per active scan. The page can terminate it without waiting for a large
// file to parse. The editor page owns the index transaction.
(() => {
  importScripts("../core/uuid-v7.js", "../core/model.js", "../library/parts.js", "../library/component-families.js", "../library/library-pairing.js", "../core/sha256.js", "../library/library-store.js", "../library/library-panel.js", "../pcb/resolved-geometry-curves.js", "../pcb/board-shape-core.js", "../pcb/board-shape.js",
    "../formats/sexpr.js", "../formats/import-kicad.js", "../library/library-import-kicad.js", "../library/catalogue.js", "../library/library-sources.js");
  const pending = new Map();
  let next = 0;
  const ask = (type, ...args) => new Promise((resolve, reject) => {
    const request = ++next;
    pending.set(request, {resolve, reject});
    self.postMessage({type, request, args});
  });
  const loadAltium = () => {
    importScripts("../vendor/cfb.min.js", "../formats/altium-ids.js", "../formats/sch-import.js", "../checks/altium-rules.js", "../pcb/pcb-pours.js", "../formats/pcb-import.js",
      "../project/source-file.js", "../formats/io.js", "../library/library-import-altium.js");
  };
  function providerOf(config) {
    if (!config) return null;
    if (config.kind === "zip") return AtriumLibrarySources.providers.archiveProvider(config.blobs);
    if (config.kind === "files") return AtriumLibrarySources.providers.fileList([], config.files);
    return {
      async list() { const {entries, rootPath} = await ask("list"); this.rootPath = rootPath; return entries; },
      readBatch: paths => ask("read", paths)
    };
  }
  function sendIndexFiles(files, paths) {
    const limit = 192;
    const batch = [];
    let count = 0;
    for (const path of paths) {
      const {rows = [], ...stamp} = files[path];
      for (let start = 0; start < Math.max(rows.length, 1); start += limit - 1) {
        const part = rows.slice(start, start + limit - 1), weight = part.length + 1;
        if (count + weight > limit) {
          self.postMessage({type: "indexFiles", files: batch});
          batch.length = 0;
          count = 0;
        }
        batch.push([path, start === 0 ? stamp : null, part]);
        count += weight;
      }
    }
    if (batch.length) self.postMessage({type: "indexFiles", files: batch});
  }
  const cache = {
    get: (_, generation) => ask("index", generation),
    async set(_, index, _old, changed, removed) {
      const {files, ...metadata} = index;
      sendIndexFiles(files, changed);
      Object.assign(index, await ask("commit", metadata, removed));
      return !index.sessionGeneration;
    }
  };
  function send(type, library, stats = null, reuse = false, cachedOK) {
    // Clone the large snapshot in bounded slices so the receiving page can service input
    // in between. Compact typed arrays move by transfer, with no second copy.
    if (library) {
      const {defs, search, ...metadata} = library;
      const {rows, order, inverse, postings, columns, numeric, ...header} = search;
      self.postMessage({type: "snapshot", library: metadata, search: {...header, order, inverse, postings, columns, numeric}},
        [order.buffer, inverse.buffer, postings.buffer, columns.buffer, ...Object.values(numeric).map(a => a.buffer)]);
      for (let at = 0; at < defs.length; at += 192) {
        self.postMessage({type: "rows", defs: defs.slice(at, at + 192), rows: rows.slice(at, at + 192)});
      }
    }
    self.postMessage({type, hasLibrary: !!library, stats, reuse, cachedOK});
  }
  self.onmessage = async ({data: m}) => {
    if (m.type === "reply") {
      const job = pending.get(m.request);
      pending.delete(m.request);
      if (!job) return;
      if (m.error) job.reject(Error(m.error)); else job.resolve(m.value);
    } else if (m.type === "scan") {
      try {
        const r = await AtriumLibrarySources.refresh(m.folder, providerOf(m.provider), {worker: true, loadAltium, reuse: m.reuse, index: m.index, cache,
          progress: value => self.postMessage({type: "progress", value}), partial: lib => send("partial", lib)});
        send("done", r.library, r.stats, r.reuse, r.cachedOK);
      } catch (e) {
        self.postMessage({type: "error", message: e?.message || String(e)});
      }
    }
  };
})();
