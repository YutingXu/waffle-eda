"use strict";
// Dispatcher can also be embedded in the offline worker bootstrap.
globalThis.AtriumFormat2Worker = (() => {
  const G = globalThis;
  function create() {
    const owners = new Map();
    let sequence = 0;
    function owner(key, missing = false) {
      if (typeof key !== "string" || !key) throw Error("A native worker request needs an owner key.");
      let files = owners.get(key);
      if (!files && missing) {
        files = new Map();
        owners.set(key, files);
      }
      if (!files) throw Error("The native worker owner has closed.");
      return files;
    }
    function fileAt(key, cursor) {
      const file = owner(key).get(cursor);
      if (!file) throw Error("The native worker cursor has expired.");
      return file;
    }
    function capture(key, file) {
      const cursor = ++sequence;
      owner(key, true).set(cursor, file);
      return {key, cursor, header: file.header, readOnly: file.readOnly, newer: file.newer,
        transport: file.transport, size: file.size, length: file.byteLength};
    }
    function models() {
      if (!G.AtriumFormat2Models && typeof importScripts === "function") {
        importScripts("../core/zip.js", "../formats/sexpr.js", "../vendor/zipjs-deflate.js", "../formats/format-2-models.js");
      }
      if (!G.AtriumFormat2Models) throw Error("The model compression codec is unavailable.");
      return G.AtriumFormat2Models;
    }
    function dispatch(request) {
      const F = G.AtriumFormat2, M = G.AtriumFormat2Model;
      const {key, cursor, options, op} = request;
      switch (op) {
        case "load": {
          const file = M?.parse(request.bytes, options) ?? F.parse(request.bytes, options);
          const view = typeof request.bytes === "string" ? new TextEncoder().encode(request.bytes) : request.bytes;
          return {...capture(key, file), physicalSha256: F.sha256(view)};
        }
        case "create": return capture(key, F.create(request.header, request.records, options));
        case "fromEditor": {
          const project = M.fromEditor(request.project, options);
          const files = project.files.map(({path, file}) => ({path, ...capture(key + "/" + path, file)}));
          const stored = project.models.map(({path, ref, bytes, raw}) => ({path, ref, bytes: bytes ?? models().encode(raw)}));
          return {manifestPath: project.manifestPath, files, assets: project.assets, models: stored,
            report: project.report, provenance: project.provenance, residuals: project.residuals,
            modelDiagnostics: project.modelDiagnostics};
        }
        case "edit":
        case "editDocument": {
          const base = fileAt(key, cursor);
          const delta = op === "editDocument" ?
            M.documentEdits(base, request.document, {put: request.put, remove: request.remove, settings: request.settings}) :
            {put: request.put, remove: request.remove, header: request.header};
          const {file, splices, changedRows, headerChanged} = F.applyDelta(base, delta);
          return {...(file === base ? {key, cursor, header: file.header} : capture(key, file)), splices, changedRows, headerChanged};
        }
        case "serialize": {
          const bytes = F.serialize(fileAt(key, cursor));
          return {bytes, sha256: F.sha256(bytes), length: bytes.length};
        }
        case "manifest": return M.manifest(fileAt(key, cursor));
        case "document": return M.document(fileAt(key, cursor), options);
        case "library": return M.library(fileAt(key, cursor), options);
        case "dependencies": return options?.mode === "full" ? M.dependencies(fileAt(key, cursor), options) :
          M.documentDependencies(fileAt(key, cursor), options);
        case "snapshot": return M.snapshot(fileAt(key, cursor));
        case "projectDigest": return F.projectDigest(fileAt(key, cursor), request.members);
        case "encodeModel": return {bytes: models().encode(request.bytes)};
        case "decodeModel": return {bytes: models().decode(request.bytes, options)};
        case "release":
          if (cursor === undefined) return owners.delete(key);
          return owner(key).delete(cursor);
        default: throw Error("Unknown native worker operation.");
      }
    }
    return {dispatch};
  }
  function listen(worker = G) {
    const state = create();
    worker.addEventListener("message", ({data}) => {
      const id = data?.id;
      try {
        const result = state.dispatch(data);
        const transfers = new Set();
        const add = bytes => {
          if (bytes instanceof ArrayBuffer) transfers.add(bytes);
          else if (ArrayBuffer.isView(bytes) && bytes.buffer instanceof ArrayBuffer) transfers.add(bytes.buffer);
        };
        add(result?.bytes);
        if (data.op === "fromEditor") {
          for (const member of [...result.assets, ...result.models, ...(result.provenance?.files || [])]) add(member.bytes);
        }
        worker.postMessage({id, ok: true, result}, [...transfers]);
      } catch (error) {
        worker.postMessage({id, ok: false, code: error?.code || "format-worker", error: String(error?.message || error)});
      }
    });
  }
  return Object.freeze({create, listen});
})();

if (typeof importScripts === "function" && typeof document === "undefined") {
  if (!globalThis.AtriumFormat2) {
    importScripts("../core/sha256.js", "../project/source-file.js", "../core/uuid-v7.js", "../formats/format-2-codec.js", "../formats/format-2-units.js", "../formats/format-2-values.js", "../project/link-record.js", "../formats/format-2-model.js");
  }
  globalThis.AtriumFormat2Worker.listen();
}
