"use strict";
if (!globalThis.AtriumBase64 && typeof require === "function") require("../app/core/base64.js");

// This engine only receives bytes from the Python host's native read lease.
globalThis.AtriumMCPFolder = (() => {
  const F = globalThis.AtriumFormat2, M = globalThis.AtriumFormat2Model;
  const C = globalThis.AtriumFormat2Closure;
  const DOCS = new Set(Object.keys(F.documentSuffix));
  const utf8 = new TextDecoder("utf-8", {fatal: true});
  const stepUTF8 = new TextDecoder("utf-8", {fatal: true, ignoreBOM: true});
  let opened;

  const {encode: base64, decode: bytes} = globalThis.AtriumBase64;

  function formatDiagnostic(file, owner) {
    const message = F.unsupportedMessage(file);
    return message ? {owner, version:file.header.formatVersion, features:file.unsupportedFeatures, message} : null;
  }

  function start({full, models, sourceRules}, body) {
    const root = M.parse(bytes(body), {kind: "project"});
    const manifest = M.manifest(root), files = new Map();
    opened = {root, manifest, files, models: models ? new Map() : null, bindings: [], version: null};
    const docs = manifest.members.filter(ref => DOCS.has(ref.kind) || ref.kind === "opaque").map(ref =>
      ref.kind === "opaque" ? {...ref, kind: ref.fileKind, read_only: true} : ref);
    if (full) {
      opened.cursor = C.steps(root, {
        onNative(file, ref) { files.set(ref.path, file); },
        onBinding(binding) { opened.bindings.push(binding); },
      });
      return next(opened.cursor.next());
    }
    const format = formatDiagnostic(root, {kind:"project", id:root.header.id});
    return {id: root.header.id, name: manifest.project.name, format: root.header.formatVersion,
      ...(format && {format_diagnostics:[format]}),
      documents: docs, libraries: manifest.members.filter(ref => ref.kind === "library"),
      ...(sourceRules && {imports: manifest.members.filter(ref => ref.kind === "import-index")})};
  }

  function next(state) {
    if (!state.done) return {request: state.value.ref, verify_model: !!state.value.model};
    opened.cursor = null;
    opened.version = state.value.sha256;
    opened.members = state.value.members;
    return {source_sha256: opened.version};
  }

  function feed({model, modelEncoding, path}, body) {
    if (!opened.cursor) throw Error("Start the saved project verification before reading a member.");
    const state = opened.cursor.next(model || (body == null ? null : bytes(body)));
    if (model && opened.models) {
      if (modelEncoding === "utf-8") opened.models.set(path, {stepText: stepUTF8.decode(bytes(body))});
      else if (modelEncoding === "zlib") {
        const message = model.length
          ? "The STEP source contains bytes outside UTF-8. Its original bytes are preserved. Geometry views may replace characters in labels or omit an unreadable body."
          : "The saved STEP body is empty. Its original bytes are preserved.";
        opened.models.set(path, {zlib: body, diagnostic: {code: "model-bytes", path, message}});
      } else if (modelEncoding === "reference") {
        opened.models.set(path, {diagnostic: {code: "model-payload-limit", path,
          message: "The verified STEP source exceeds the embedded reader’s payload limit. The original is available in the saved project."}});
      } else throw Error("Unknown verified model payload encoding.");
    }
    return next(state);
  }

  function owner({path}, body) {
    const ref = opened.manifest.members.find(member => member.path === path);
    if (!ref) throw Error("The manifest does not reference " + path + ".");
    const file = M.parse(bytes(body), {kind: ref.kind, id: ref.id});
    F.checkMemberVersion(opened.root, file);
    opened.files.set(path, file);
    const libraries = DOCS.has(ref.kind) ? M.documentDependencies(file).libraries : [];
    const related = M.dependencies(file);
    return {
      libraries: libraries.map(id => {
        const ref = opened.manifest.members.find(member => member.id === id && member.kind === "library");
        if (!ref) throw Error("Missing library reference " + id + ".");
        return ref.path;
      }),
      assets: related.filter(ref => ref.kind === "asset" && /^(image|font)\//.test(ref.mediaType)),
    };
  }

  function sourceRules(binding, documentId) {
    const data = binding.metadata;
    if (!data.documents.includes(documentId)) return;
    const row = (data.provenance.fields || []).find(row =>
      row.type === "document" && row.id === documentId && Array.isArray(row.values?.sourceRules));
    if (row) return row.values.sourceRules;
  }

  function readRules({path,documentId}, body) {
    const ref = opened.manifest.members.find(member => member.path === path && member.kind === "import-index");
    if (!ref) throw Error("The project does not reference the selected import binding.");
    const binding = globalThis.AtriumImportSidecars.parse(bytes(body),ref);
    return {rules:sourceRules(binding,documentId)};
  }

  function project() {
    const {files, manifest, version, models} = opened;
    const result = {...manifest.project, documents: [], library: []}, blocks = [];
    if (manifest.releases.length) result.releaseDescriptors = M.releaseDescriptors(manifest.releases);
    const counts = Object.create(null);
    const modelDiagnostics = new Set(), formatDiagnostics = [];
    const rootMode = formatDiagnostic(opened.root, {kind:"project", id:opened.root.header.id});
    if (rootMode) formatDiagnostics.push(rootMode);
    const modelPayload = models && (ref => {
      const payload = models.get(M.modelPath(ref));
      if (payload?.diagnostic) modelDiagnostics.add(payload.diagnostic);
      return payload;
    });
    for (const ref of manifest.members) {
      const file = files.get(ref.path);
      if (!file) continue;
      const diagnostic = formatDiagnostic(file, {kind:ref.kind, id:ref.id, path:ref.path});
      if (diagnostic) formatDiagnostics.push(diagnostic);
      if (DOCS.has(ref.kind)) {
        result.documents.push(M.document(file, {name: ref.name, modelPayload}));
        if (ref.kind === "pcb") {
          for (const binding of opened.bindings) {
            const rules = sourceRules(binding,ref.id);
            if (rules) { counts[ref.id] = rules.length; break; }
          }
        }
      }
      else if (ref.kind === "library") result.library.push(M.library(file, {modelPayload}));
      else if (ref.kind === "block") blocks.push(M.block(file, {modelPayload}));
    }
    if (blocks.length) result.layoutBlocks = blocks;
    return [{source_rule_counts: counts, source_sha256: version, project_id: opened.root.header.id, project_format: opened.root.header.formatVersion,
      ...(modelDiagnostics.size && {model_diagnostics: [...modelDiagnostics]}),
      ...(formatDiagnostics.length && {format_diagnostics:formatDiagnostics}),
      opaque_documents: manifest.members.filter(ref => ref.kind === "opaque").map(({id, fileKind, name}) => ({id, kind: fileKind, name, read_only: true})),
      ...(version && {members: opened.members.map(({path, sha256}) => [path, sha256]),
        manifest_sha256: F.sha256(F.serialize(opened.root))})}, JSON.stringify(result)];
  }

  // After the native transaction, only installed bytes with their actual
  // receipt hashes can replace the corresponding verified owner projections.
  function refresh({previous, manifestPath}, body) {
    if (!opened || opened.version !== previous) return [{refresh:false}];
    const rows = JSON.parse(utf8.decode(bytes(body))), P = globalThis.AtriumProposal;
    let root = opened.root, manifest = opened.manifest;
    const files = new Map(), documents = [], changed = new Map();
    const modelPayload = opened.models && (ref => opened.models.get(M.modelPath(ref)));
    for (const row of rows) {
      const raw = bytes(row.data);
      if (F.sha256(raw) !== row.sha256) return [{refresh:false}];
      if (row.path === manifestPath) {
        const next = M.parse(raw, {kind:"project",id:root.header.id}), value = M.manifest(next);
        if (!P.equal(value.members, manifest.members) || !P.equal(M.dependencies(next), M.dependencies(root))) return [{refresh:false}];
        root = next; manifest = value;
        continue;
      }
      const prior = opened.files.get(row.path), ref = manifest.members.find(ref => ref.path === row.path);
      if (!prior || !ref || !DOCS.has(ref.kind)) return [{refresh:false}];
      const next = M.parse(raw, {kind:ref.kind,id:ref.id});
      F.checkMemberVersion(root,next);
      if (!P.equal(M.dependencies(next), M.dependencies(prior)) ||
          !P.equal(M.documentDependencies(next), M.documentDependencies(prior))) return [{refresh:false}];
      files.set(row.path,next); changed.set(row.path,row.sha256);
      documents.push(M.document(next,{name:ref.name,modelPayload}));
    }
    const members = opened.members.map(member => changed.has(member.path) ? {...member,sha256:changed.get(member.path)} : member);
    const version = F.projectDigest(root,members);
    for (const [path,file] of files) opened.files.set(path,file);
    Object.assign(opened,{root,manifest,members,version});
    return [{refresh:true,source_sha256:version,manifest_sha256:F.sha256(F.serialize(root)),
      members:members.map(({path,sha256})=>[path,sha256])}, JSON.stringify({
      name:rows.some(row=>row.path===manifestPath) ? manifest.project.name : undefined, documents})];
  }

  function exportProvenance({documentId, manufacturing, originals}) {
    if (!opened?.version) throw Error("Verify the saved native project before using its import data.");
    const I = globalThis.AtriumImportSidecars;
    const entries = opened.bindings.map(I.restore).filter(entry => !documentId || entry.documents.includes(documentId));
    const groups = entries.map(I.exportProvenance);
    const head = {source_sha256: opened.version};
    if (originals) head.originals = entries.flatMap(({index}) => index.inputs.map(input => ({
      kind: "source", path: I.logical(input.sha256), bindingPath: index.ref.path, inputId: input.id,
      sha256: input.sha256, byteLength: input.byteLength})));
    return [head, JSON.stringify(manufacturing ? I.manufacturingProvenance(groups, documentId) : groups)];
  }

  function initial(a, body) {
    const I = globalThis.AtriumImportSidecars, G = globalThis.AtriumFormat2Models;
    const {project, report, provenance, sources} = JSON.parse(utf8.decode(bytes(body)));
    const inputs = sources.map(source => {
      const reported = (provenance.files || []).find(file => file.name === source.name && (file.path || file.name) === source.path);
      const data = bytes(source.data), sha256 = F.sha256(data);
      if (reported?.sha256 && reported.sha256 !== sha256) throw Error("The isolated translator used different bytes for " + source.name + ".");
      return {...reported, name: source.name, path: source.path, bytes: data, sha256};
    });
    const converted = M.fromEditor({model: project, provenance: {...provenance, files: inputs}}, {encodeModel: G.encode});
    const retained = I.prepareSync([{documents: project.documents.map(d => d.id), names: inputs.map(f => f.name), report,
      provenance: {...converted.provenance, files: inputs}, residuals: converted.residuals, binding: {modelDiagnostics: converted.modelDiagnostics}}]);
    const manifest = F.edit(converted.manifest, {put: retained.refs});
    const members = new Map(converted.files.slice(1).map(({path, file}) => [path, F.serialize(file)]));
    for (const {path, bytes} of [...converted.models, ...converted.assets]) members.set(path, bytes);
    for (const [path, bytes] of retained.files) members.set(path, bytes);
    const version = F.projectDigest(manifest, Array.from(members, ([path, data]) => ({path, sha256: F.sha256(data)})));
    const encoder = new TextEncoder();
    members.set(converted.manifestPath, F.serialize(manifest));
    members.set(I.IGNORE, encoder.encode(I.ignoreText));
    const files = Array.from(members, ([path, data]) => ({path, data: base64(data)}));
    return [{manifest: converted.manifestPath, version, bytes: [...members.values()].reduce((n, data) => n + data.length, 0),
      retained_inputs: inputs.length}, JSON.stringify(files)];
  }

  const actions = {start, feed, owner, project, refresh, version:()=>({source_sha256:opened?.version}),
    read_rules: readRules, export_provenance: exportProvenance, initial};
  function run(args, body) {
    const action = actions[args.action];
    if (!action) throw Error("Unknown native folder reader operation.");
    return action(args, body);
  }
  return Object.freeze({run, saved: () => opened});
})();
