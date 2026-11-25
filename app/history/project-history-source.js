"use strict";
// Import immutable Git blobs using the same readers and assembly path as File › Open.
// Only the document and library data present in the revision belongs in the comparison.
globalThis.AtriumHistorySource = (() => {
  // Adjacent first-parent comparisons commonly share a complete immutable side.
  // Retain at most two small inputs in this cancellable worker; idle retirement drops both.
  const recent = new Map();
  function project(snapshot) {
    if (!snapshot?.blob) return null;
    if (recent.has(snapshot.blob)) return recent.get(snapshot.blob);
    const valid = Atrium.withRevisionIds(snapshot.blob, () => importSnapshot(snapshot));
    if (snapshot.files.reduce((n, f) => n + f.data.length, 0) <= 4 * 1024 * 1024) {
      recent.set(snapshot.blob, valid);
      if (recent.size > 2) recent.delete(recent.keys().next().value);
    }
    return valid;
  }
  function importSnapshot(snapshot) {
    const missing = snapshot.missing || [];
    const drawings = missing.filter(name => !/\.(schlib|pcblib)$/i.test(name));
    if (drawings.length) throw Error("Incomplete historical project · " + drawings.length + " referenced drawings unavailable.");
    const files = snapshot.files.map(f => ({name: f.name, altiumPath: f.altiumPath,
      bytes: AtriumImportFormats.base64(f.data)}));
    for (const file of files) AtriumObsoleteProject.reject(file.bytes, file.name);
    const first = files[0];
    if (files.length === 1 && !missing.length && /\.prjpcb$/i.test(first.name)) {
      const {manifest} = AtriumIO.read(first.name, first.bytes, {allowEmptyManifest: true});
      if (!manifest.paths.length) return AtriumHistorySummary.empty();
    }
    let results = AtriumImportFormats.readSet(files);
    if (files.some(f => /\.(schlib|pcblib)$/i.test(f.name))) {
      results = AtriumLibraryImportAltium.apply(results, files, {sha256: files.map(f =>
        /\.(schlib|pcblib)$/i.test(f.name) ? AtriumSourceFile.sha256(f.bytes) : null)});
    }
    const starter = Atrium.project(AtriumImportFormats.stem(first.name));
    const hasDrawings = results.some(result => result.documents.length);
    const design = Atrium.validate(AtriumImport.assemble(results, files, starter, null).after);
    const standard = new Set(AtriumParts.catalogue.map(d => d.id));
    design.documents = design.documents.filter(d => !d.importPlaceholder);
    design.library = design.library.filter(d => !standard.has(d.id));
    const project = hasDrawings ? design : {...AtriumHistorySummary.empty(), library: design.library};
    if (missing.length) Object.defineProperty(project, "historyMissingLibraries", {value: missing.length});
    return project;
  }
  return Object.freeze({project});
})();
