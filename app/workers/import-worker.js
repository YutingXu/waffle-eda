"use strict";

// The static Web worker and the embedded desktop worker use the same message handler.
// Every script name below comes from the packaged build. Selected files are always data.
(() => {
  const loaded = new Set();
  function scripts(names) {
    for (const name of names) {
      if (loaded.has(name)) continue;
      if (globalThis.AtriumEmbeddedTranslatorScripts) {
        const script = globalThis.AtriumEmbeddedTranslatorScripts[name];
        if (typeof script !== "function") throw Error("Missing translator module " + name + ".");
        script();
      } else importScripts("../" + name);
      loaded.add(name);
    }
  }
  // Native format modules can demand other packaged scripts from inside a blob worker.
  if (globalThis.AtriumEmbeddedTranslatorScripts) globalThis.importScripts = (...names) => scripts(names.map(name => name.startsWith("../") ? name.slice(3) : name));

  function modules(roots) {
    for (const root of roots) {
      const names = AtriumTranslatorWorkerModules[root];
      if (!names) throw Error("Missing translator dependency " + root + ".");
      scripts(names);
    }
  }
  try {
    scripts(["project/obsolete-project.js", "translator-table.js", "formats/translator-registry.js", "translator-worker-modules.js", "formats/translators.js"]);
  } catch (error) {
    self.postMessage({type: "unavailable", message: error.message});
    return;
  }
  globalThis.AtriumLoadTranslator = (row, direction, adapterScript) => {
    modules(row.modules[direction]);
    scripts(["formats/translator-provenance.js", adapterScript]);
  };

  // Transfer the known binary payloads instead of walking the entire design looking for
  // buffers. Raw selected files can be returned as provenance without making another copy.
  function transfers(value) {
    const buffers = new Set();
    function take(bytes) {
      if (ArrayBuffer.isView(bytes) && bytes.buffer instanceof ArrayBuffer) buffers.add(bytes.buffer);
    }
    take(value?.bytes);
    for (const file of value?.files || []) take(file.bytes);
    for (const file of value?.provenance?.files || []) take(file.bytes);
    for (const part of value?.provenance?.mechanical?.mesh?.parts || []) {
      take(part.positions); take(part.indices); take(part.normals);
    }
    return [...buffers];
  }
  function inputBytes(buffer) {
    const view = ArrayBuffer.isView(buffer) ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength) :
      buffer instanceof ArrayBuffer ? new Uint8Array(buffer) : null;
    if (!view || view.byteLength > AtriumTranslators.limits.fileBytes) throw Error("Invalid translator input or file size.");
    return view;
  }
  const exportSessions = new Map();
  function exportRequest(data) {
    const options = data.options || {};
    if (data.session == null) return AtriumTranslators.export(data.translator,data.model,options);
    if (!Number.isSafeInteger(data.session) || !Number.isSafeInteger(data.snapshot))
      throw Error("Invalid output job snapshot.");
    let scope = exportSessions.get(data.session);
    if (!scope && data.model) {
      exportSessions.set(data.session,scope = {models:new Map(),export:AtriumTranslators.exportSession()});
    }
    if (!scope) throw Error("The output job has closed.");
    if (data.model) scope.models.set(data.snapshot,{model:data.model,provenance:data.provenance});
    const snapshot = scope.models.get(data.snapshot);
    if (!snapshot) throw Error("The output job snapshot is unavailable.");
    return scope.export(data.translator,snapshot.model,{...options,provenance:snapshot.provenance});
  }
  self.onmessage = ({data}) => {
    if (data?.operation === "close-export-session") {
      exportSessions.delete(data.session);
      return;
    }
    const id = data?.id;
    try {
      if (!data || !Number.isSafeInteger(id)) throw Error("Invalid translation request.");
      const progress = message => self.postMessage({type: "progress", id, ...message});
      let value;
      if (data.operation === "detect") {
        value = AtriumTranslators.detect(data.name, inputBytes(data.buffer));
      } else if (data.operation === "translate-import" || data.operation === "foreign-set") {
        if (!Array.isArray(data.files) || data.files.length > AtriumTranslators.limits.files) throw Error("Invalid translator input file list.");
        const files = data.files.map(file => ({name: file.name, ...(file.path ? {path: file.path} : {}), bytes: inputBytes(file.buffer)}));
        if (data.operation === "translate-import") value = AtriumTranslators.import(files, {...data.options, progress});
        else { modules(["import-formats"]); value = AtriumImportFormats.readSet(files, {progress}); }
      } else if (data.operation === "translate-export") {
        if (data.options?.pageMode === "frames" && ["kicad","altium"].includes(data.translator)) modules(["frame-conversion"]);
        if (data.translator === "kicad" || data.translator === "altium") {
          modules(["notebook-output"]);
          modules(globalThis.AtriumNotebookOutput.foreign(data.model, data.options));
        }
        value = exportRequest(data);
      } else if (data.operation === "inspect-manifest" || data.operation === "source-digest") {
        modules(["altium-io"]);
        const bytes = inputBytes(data.buffer), sha256 = AtriumSourceFile.sha256(bytes);
        value = {sha256, size: bytes.byteLength};
        if (data.operation === "inspect-manifest") value.manifest = AtriumIO.read(data.name, bytes).manifest;
      } else if (data.operation === "source-copy") {
        modules(["source-copy"]);
        value = AtriumSourceCopy.prepare(data.doc, data.library, inputBytes(data.buffer));
      } else if (data.operation == null) {
        modules(["altium-io"]);
        value = AtriumIO.read(data.name, inputBytes(data.buffer));
      } else throw Error("Unknown translator operation.");
      self.postMessage({type: "result", id, value}, transfers(value));
    } catch (error) {
      const code = error?.code;
      self.postMessage({type: "parse-error", id, ...(typeof code === "string" && {code}),
        message: String(error?.message || "The file could not be translated.").slice(0, 4096)});
    }
  };
  self.postMessage({type: "ready"});
})();
