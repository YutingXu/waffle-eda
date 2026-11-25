"use strict";
// Historical revisions use the native canonical model. The host only supplies Git-tree bytes
// belonging to the selected manifest. Cache entries live for one comparison worker.
globalThis.AtriumFormat2Git = (() => {
  const G = globalThis, F = G.AtriumFormat2, M = G.AtriumFormat2Model;
  const C = G.AtriumFormat2Closure, S = G.AtriumHistorySummary;
  const documents = new Set(Object.keys(F.documentSuffix));
  const snapshots = new Map(), summaries = new Map(), projected = new WeakMap();
  function bounded(length) {
    const entries = new Map();
    let bytes = 0;
    return {
      keys: () => [...entries.keys()],
      get(key) {
        const value = entries.get(key);
        if (value) { entries.delete(key); entries.set(key, value); }
        return value;
      },
      set(key, value) {
        if (entries.has(key) || length(value) > (32 << 20)) return;
        entries.set(key, value);
        bytes += length(value);
        while (bytes > (32 << 20) || entries.size > 256) {
          const first = entries.keys().next().value;
          bytes -= length(entries.get(first)); entries.delete(first);
        }
      },
    };
  }
  const verifiedBytes = bounded(raw => raw.length), nativeCache = bounded(file => file.byteLength);
  const rootId = side => side?.blob || null;

  async function read(side, objects) {
    if (side?.text != null) {
      G.AtriumObsoleteProject.reject(side.text, side.path || "Project.waffle");
      throw Error("Git returned project text without a native folder.");
    }
    const blob = rootId(side);
    if (!blob) return {blob: null, version: null, project: null};
    if (!side.manifest) throw Error("Git returned a project revision without its native manifest.");
    const manifestObject = side.files?.[side.manifest], cached = snapshots.get(blob);
    if (cached && cached.manifest === side.manifest && cached.manifestObject === manifestObject) return cached.value;
    function bytes(path) {
      const digest = side.files?.[path];
      const cached = digest && verifiedBytes.get(digest);
      if (cached) return cached;
      if (!digest || !Object.hasOwn(objects, digest)) throw Error("Missing required project member: " + path);
      let data = objects[digest];
      if (typeof data === "string") data = objects[digest] = G.AtriumFolderProjectEngine.bytesOf({data, path});
      return data;
    }
    const raw = bytes(side.manifest);
    G.AtriumObsoleteProject.reject(raw, side.manifest);
    const manifest = M.parse(raw, {kind: "project"}), root = M.manifest(manifest);
    const files = new Map();
    const {sha256: version} = await C.verify(manifest, bytes, {
      onNative(file, ref) { files.set(ref.path, file); }, nativeCache,
    });
    for (const digest of Object.values(side.files)) {
      if (/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(digest) && objects[digest] instanceof Uint8Array) verifiedBytes.set(digest, objects[digest]);
    }
    const project = {...root.project, documents: [], library: []};
    for (const ref of root.members) {
      const file = files.get(ref.path);
      if (!file) continue;
      if (!documents.has(ref.kind) && ref.kind !== "library" && ref.kind !== "block") continue;
      let model = projected.get(file);
      if (!model) {
        model = documents.has(ref.kind) ? M.document(file, {name: ref.name}) : ref.kind === "library" ? M.library(file) : M.block(file);
        projected.set(file, model);
      }
      if (documents.has(ref.kind)) project.documents.push(model.name === ref.name ? model : {...model, name: ref.name});
      else if (ref.kind === "library") project.library.push(model);
      else (project.layoutBlocks ||= []).push(model);
    }
    const value = {blob, version, project};
    snapshots.set(blob, {manifest:side.manifest, manifestObject, value});
    if (snapshots.size > 3) snapshots.delete(snapshots.keys().next().value);
    return value;
  }

  async function run({bundle, before, after, region, project: revision, reviewStages, resolveOwner}) {
    if (resolveOwner) return {value:prepareOwnerResolution(resolveOwner)};
    const {revisions, objects} = bundle;
    for (const digest of verifiedBytes.keys()) {
      if (!Object.hasOwn(objects, digest)) objects[digest] = verifiedBytes.get(digest);
    }
    function lookup(rev) {
      if (rev == null) return null;
      const found = revisions.find(side => side.revision === rev);
      if (!found) throw Error("Git returned an incomplete project revision.");
      return found;
    }
    if (reviewStages) {
      const stages = ["base", "ours", "theirs"].map(lookup);
      const review = !bundle.removedOwners && stages.every(stage => stage.blob) ?
        reviewConflicts(objects, stages, reviewStages) : {exact: true};
      if (!review.exact) {
        review.stages = [];
        for (const stage of stages) review.stages.push(await read(stage, objects));
      }
      return {value:review, known:verifiedBytes.keys()};
    }
    if (revision) return {value: await read(lookup(revision), objects), known: verifiedBytes.keys()};
    const left = await read(lookup(before), objects), right = await read(lookup(after), objects);
    const key = S.key(left.version, right.version, "native-folder", region);
    let value = summaries.get(key);
    if (!value) {
      value = left.version === right.version ? S.unchanged() : S.fromProjects(left.project, right.project, region);
      if (left.version !== right.version && !value.total) value.text = "Saved files changed · no modeled design changes";
      summaries.set(key, value);
      if (summaries.size > 80) summaries.delete(summaries.keys().next().value);
    }
    return {value, known: verifiedBytes.keys()};
  }

  // A Git merge operates on one verified owner at a time. Work from its native records, which
  // contain fields and record kinds that an older editor might not project into the canvas.
  const geometry = new Set([
    "at", "x", "y", "z", "a", "b", "c", "start", "end", "points", "outline", "poly", "rings",
    "controlPoints", "position", "origin", "centre", "center", "offset", "bounds", "box", "courtyard",
    "path", "refAt", "valueAt", "angle", "rotation", "sweep", "ccw", "flipped", "mirror", "layer",
    "r", "w", "h", "radius", "width", "height", "size", "diameter", "drill", "drillX", "drillY", "slot",
  ]);
  // These PCB part fields are independently authored. Each field's token is still atomic.
  // Keep the conservative geometry group when a change also touches other geometry fields.
  const pcbPartPlacement = new Set(["at", "angle", "layer", "refAt", "valueAt"]);
  const headerPolicy = new Set(["requires", "compatibleWith", "readerRequires"]);
  const documentPath = new Set(["docKind", "name", "path"]);
  const fieldPriority = key => key === "kind" ? 0 : key === "formatVersion" ? 1 : key === "id" ? 2 : 3;

  function *nativeRows(file, source) {
    const records = file.records();
    let start = 0, record = file.header;
    for (const line of F.lines(file)) {
      const end = start + line.length + Number(source[start + line.length - 1] === "\r");
      yield {file, record, line, bytes: source.slice(start, end)};
      start = end;
      record = records.next().value;
    }
  }

  function fieldsFor(row) {
    const {text, entries} = F.rowTokens(row.file, row.record.id);
    return new Map(entries.map(({key, begin, end}) => [key, text.slice(begin, end)]));
  }

  function combineRecord(b, o, t, coupled, independent) {
    const [base, ours, theirs] = [b, o, t].map(fieldsFor);
    const fields = [], conflicts = [];
    const keys = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
    const ordered = [...keys].sort((a, b) => fieldPriority(a) - fieldPriority(b) || F.compare(a, b));
    let oursCoupled = false, theirsCoupled = false, keepCoupled = !independent;
    const divergentCoupled = [], overlappingCoupled = [];
    for (const key of ordered) {
      const before = base.get(key), left = ours.get(key), right = theirs.get(key);
      const oursChanged = left !== before, theirsChanged = right !== before, disagree = left !== right;
      if (coupled.has(key)) {
        oursCoupled ||= oursChanged;
        theirsCoupled ||= theirsChanged;
        if (!keepCoupled && (oursChanged || theirsChanged) && !independent.has(key)) keepCoupled = true;
        if (disagree) {
          divergentCoupled.push(key);
          if (oursChanged && theirsChanged) overlappingCoupled.push(key);
        }
      } else if (oursChanged && theirsChanged && disagree) conflicts.push(key);
      const selected = oursChanged ? left : right;
      if (selected !== undefined) fields.push(selected);
    }
    if (oursCoupled && theirsCoupled) conflicts.push(...(keepCoupled ? divergentCoupled : overlappingCoupled));
    return {fields, conflicts};
  }

  function mergeOwners(sources, files) {
    const owner = files.find(Boolean)?.header;
    if (!owner) throw Error("The merge has no native Waffle file.");
    const report = (record, reason, fields = []) => ({
      id: record.id, kind: record.kind, reason, fields,
      label: (owner.kind === "project" ? "project manifest: " : "") + record.kind + " " + record.id +
        " (" + (fields.length ? fields.join(", ") : reason) + ")",
    });
    const conflict = (record, reason) => ({text: null, conflicts: [report(record, reason)]});
    if (files.some(file => file && (file.header.id !== owner.id || file.header.kind !== owner.kind ||
        file.header.formatVersion !== owner.formatVersion))) return conflict(owner, "different owner identity or format version");
    for (const file of files) if (file?.header.kind === "project") F.manifestMembers(file);

    const matches = (a, b) => a === b || !!a && !!b && a.replace(/\r\n/g, "\n") === b.replace(/\r\n/g, "\n");
    if (matches(sources[1], sources[2]) || matches(sources[0], sources[2])) return {text: sources[1], conflicts: []};
    if (matches(sources[0], sources[1])) return {text: sources[2], conflicts: []};
    if (!files.every(Boolean)) return conflict(owner, files[0] ? "deleted and changed" : "added differently");
    if (files.some(file => file.readOnly)) return conflict(owner, "format or required feature needs a newer reader");

    const known = M.readOptions(owner.kind).knownKinds;
    const iterators = files.map((file, i) => nativeRows(file, sources[i]));
    const next = iterators.map(it => it.next().value);
    const lines = [], conflicts = [];
    function mergeRow([b, o, t], header = false) {
      if (o?.line === t?.line || b?.line === t?.line) return o?.bytes;
      if (b?.line === o?.line) return t?.bytes;
      const record = (o || t || b).record;
      if (!b || !o || !t || o.record.kind !== b.record.kind || t.record.kind !== b.record.kind || !header && !known?.has(record.kind)) {
        const reason = !b ? "added differently" : !o || !t ? "deleted and changed" : "record changed on both sides";
        conflicts.push(report(record, reason));
        return undefined;
      }
      const coupled = header ? headerPolicy : record.kind === "document" ? documentPath : geometry;
      const independent = owner.kind === "pcb" && record.kind === "part" ? pcbPartPlacement : null;
      const result = combineRecord(b, o, t, coupled, independent);
      if (result.conflicts.length) {
        conflicts.push(report(record, "different values", result.conflicts));
        return undefined;
      }
      return "{" + result.fields.join(",") + "}" + (o.bytes.endsWith("\r\n") ? "\r\n" : "\n");
    }
    const take = id => next.map((row, i) => {
      if (row?.record.id !== id) return null;
      next[i] = iterators[i].next().value;
      return row;
    });
    lines.push(mergeRow(take(owner.id), true));
    while (next.some(Boolean)) {
      const id = next.reduce((lowest, row) => row && (lowest === null || F.compare(row.record.id, lowest) < 0) ? row.record.id : lowest, null);
      const merged = mergeRow(take(id));
      if (merged !== undefined) lines.push(merged);
    }
    if (conflicts.length) return {text: null, conflicts};
    const text = lines.join("");
    // Validate combined structural relations before replacing Git's input. Cross-file references
    // are checked by the folder reader, since a file driver has no view of the merged tree.
    try {
      const merged = M.parse(text, {kind: owner.kind});
      if (owner.kind === "project") F.manifestMembers(merged);
    }
    catch (error) { return conflict(owner, error.message); }
    return {text, conflicts};
  }

  function mergeRecords(base, ours, theirs, kind) {
    const sources = [base, ours, theirs].map(raw => raw == null ? "" : F.decodeText(raw));
    return mergeOwners(sources, sources.map(source => source ? M.parse(source, {kind}) : null));
  }

  function prepareOwnerResolution({path, owner, edited, manifest, current, chooseEdit}) {
    const E = globalThis.AtriumFolderProjectEngine;
    F.memberPath(path);
    const text = record => F.decodeText(E.bytesOf(record));
    const root = text(manifest), file = M.parse(root, {kind:"project"});
    const ref = JSON.parse(owner.reference);
    if (file.readOnly || ref.id !== owner.id || ref.path !== path || ref.docKind !== owner.kind ||
        F.manifestMembers(file).some(row => row.id === owner.id || F.pathKey(row.path) === F.pathKey(path))) {
      throw Error("The project membership changed. Reopen merge review.");
    }
    const authored = text({path,data:edited});
    const member = M.parse(authored, {kind:owner.kind,id:owner.id});
    const normalized = value => value.replace(/\r\n/g, "\n");
    if (current && normalized(text(current)) !== normalized(authored)) {
      throw Error("The conflicted document changed on disk. Reopen merge review.");
    }
    // The chosen deletion is already present in the manifest. Git owns the
    // remaining worktree conflict copy until its deletion is explicitly staged.
    if (!chooseEdit) return [];
    F.checkMemberVersion(file, member);
    const parts = [];
    let inserted = false;
    for (const row of nativeRows(file, root)) {
      if (!inserted && row.record !== file.header && F.compare(owner.id, row.record.id) < 0) {
        parts.push(owner.reference);
        inserted = true;
      }
      parts.push(row.bytes);
    }
    if (!inserted) parts.push(owner.reference);
    const merged = parts.join("");
    if (!F.manifestMembers(M.parse(merged, {kind:"project",id:file.header.id}))
      .some(row => row.id === owner.id && row.kind === owner.kind && row.path === path)) {
      throw Error("The edited version has an invalid project reference.");
    }
    const plan = current ? [] : [{path,expected:null,data:edited}];
    plan.push({path:manifest.path,expected:manifest.sha256,data:E.dataOf(new TextEncoder().encode(merged))});
    return plan;
  }

  function extensionFields(value) {
    return value !== null && typeof value === "object" &&
      Object.keys(value).some(key => key.startsWith("x-") || extensionFields(value[key]));
  }

  function reviewConflicts(objects, stages, conflicts) {
    const atomic = [];
    const supported = [".waffle", ...Object.values(F.documentSuffix), ".wlib", ".wblock"];
    for (const {path, stages: names} of conflicts) {
      if (!supported.some(suffix => path.endsWith(suffix))) return {exact: true};
      const sources = stages.map(stage => {
        const digest = names.includes(stage.revision) && stage.files?.[path];
        if (!digest || !Object.hasOwn(objects, digest)) return "";
        const data = objects[digest];
        return F.decodeText(typeof data === "string" ? G.AtriumFolderProjectEngine.bytesOf({data, path}) : data);
      });
      if (sources.filter(Boolean).length !== names.length) return {exact: true};
      const files = sources.map(source => source ? M.parse(source) : null);
      if (files.some(file => file && (file.newer || file.readOnly || file.retainsSyntax || extensionFields(file.header) ||
          Array.from(file.records()).some(extensionFields)))) return {exact: true};
      const owner = files.find(Boolean).header;
      for (const conflict of mergeOwners(sources, files).conflicts) {
        // The canvas can show native item conflicts. Other record types have transformed or
        // hidden fields, which require choosing among the original stages.
        if (!documents.has(owner.kind) || conflict.id === owner.id ||
            ["documentSettings", "panelCell", "drawingView", "drawingDimension", "boardBody",
              "modelAlias", "layer", "copperRegion"].includes(conflict.kind)) return {exact: true};
        atomic.push({...conflict, owner:owner.id});
      }
    }
    return {exact:false, atomic};
  }

  return Object.freeze({run, mergeRecords});
})();

// The native driver passes the three UTF-8 inputs separately, without a worktree read or Git query.
globalThis.AtriumFormat2MergeDriver = (options, input) => {
  const [base, ours, theirs] = input.split("\u001e");
  const {text, conflicts} = globalThis.AtriumFormat2Git.mergeRecords(base, ours, theirs, JSON.parse(options).kind);
  return JSON.stringify({conflicts}) + "\n" + (text ?? "");
};
