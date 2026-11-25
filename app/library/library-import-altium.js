"use strict";
if (!globalThis.AtriumLibraryPairing && typeof require === "function") require("./library-pairing.js");
// Altium SchLib + PcbLib pairs into complete components (docs/design/library-management.md §11).
// The SchLib and PcbLib parsers (sch-import.js, pcb-import.js) read the files; this module joins each
// symbol to the footprint its PCB model names, looking only inside the files the user chose, never
// along a search path. Each component keeps where both halves came from (file, SHA-256, entry) and
// starts as a draft.
//
//   pair(files, o) -> {library, report}
//     files: [{name, sha256, library}] (library as AtriumIO.read returns it); o.existing: the project
//     library, so a re-import of the same entries is recognised as nothing new
//     report: {components, paired, symbolOnly, footprintOnly, identical: [{footprint, files}],
//              ambiguous: [{symbol, footprint, files}], unmatched: [{symbol, footprint}],
//              unused: [{footprint, file}], mismatches: [{name, noPad, noPin}], skipped, notes}
//   apply(all, files) -> all, with the paired library in place (the File › Open path, design-reader.js)
globalThis.AtriumLibraryImportAltium = (() => {
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const clone = v => JSON.parse(JSON.stringify(v));
  const key = s => String(s ?? "").trim().toUpperCase();
  const isSch = n => /\.schlib$/i.test(n), isPcb = n => /\.pcblib$/i.test(n);
  // Footprints compared by geometry: pads (number, position, size, shape, drill) rounded to 1 µm.
  const r = v => Math.round(Number(v || 0) * 1000);
  const geometry = fp => JSON.stringify((fp?.pads || []).map(p => [String(p.number ?? ""), r(p.x), r(p.y), r(p.w), r(p.h), p.shape || "", r(p.drill), r(p.angle)]).sort());
  const today = () => { try { return new Date().toISOString().slice(0, 10); } catch { return ""; } };
  const sourceOf = (kind, file, entry) => ({kind, file: file.name, ...(file.sha256 ? {sha256: file.sha256} : {}), entry: String(entry || "")});
  const same = (a, b) => !!a && !!b && a.kind === b.kind && a.sha256 === b.sha256 && a.entry === b.entry;

  function sameBodies(left, right) {
    if (JSON.stringify(left.bodies3d || []) !== JSON.stringify(right.bodies3d || [])) return false;
    const other = new Map((right.bodyModels || []).map(a => [a.id, a]));
    const models = left.bodyModels || [];
    return models.length === other.size && models.every(a => {
      const b = other.get(a.id);
      // Compare immutable payloads directly, without building a concatenated
      // signature containing megabytes of STEP data on each library decision.
      return b && a.file === b.file && a.assetId === b.assetId && a.zlib === b.zlib && a.stepText === b.stepText;
    });
  }
  function pair(files, o = {}) {
    const report = {components: 0, paired: 0, symbolOnly: 0, footprintOnly: 0, identical: [], ambiguous: [], unmatched: [], unused: [], mismatches: [], skipped: 0, notes: []};
    const footprints = new Map(), used = new Set(), library = [];
    for (const f of files) if (isPcb(f.name)) for (const d of f.library || []) {
      if (!d.footprint) continue;
      const k = key(d.footprint.name || d.name);
      if (!footprints.has(k)) footprints.set(k, []);
      footprints.get(k).push({def: d, file: f});
    }
    const existing = (o.existing || []).filter(d => obj(d.source));
    const known = src => existing.some(d => same(d.source, src.symbol ? src.symbol : src) && (!src.footprint || same(d.source.footprint, src.footprint)));
    for (const f of files) if (isSch(f.name)) for (const d of f.library || []) {
      if (!d.symbol) continue;
      const want = key(d.footprintName), hits = want ? footprints.get(want) || [] : [];
      const symbolSource = sourceOf("altium-schlib", f, d.name);
      let chosen = null;
      if (hits.length === 1) chosen = hits[0];
      else if (hits.length > 1) {
        // The same name in several selected PcbLibs: identical geometry is one footprint; otherwise ask.
        if (new Set(hits.map(h => geometry(h.def.footprint))).size === 1 && hits.slice(1).every(h => sameBodies(hits[0].def.footprint, h.def.footprint))) { chosen = hits[0]; report.identical.push({footprint: d.footprintName, files: hits.map(h => h.file.name)}); }
        else report.ambiguous.push({symbol: d.name, footprint: d.footprintName, files: hits.map(h => h.file.name)});
      } else if (want) report.unmatched.push({symbol: d.name, footprint: d.footprintName});
      const def = clone(d);
      def.category = d.category === "Imported symbols" ? "Imported components" : d.category;
      def.state = "draft";
      def.source = {...symbolSource, date: today()};
      if (chosen) {
        hits.forEach(h => used.add(h.def));
        def.footprint = clone(chosen.def.footprint);
        def.footprintName = def.footprint.name || d.footprintName;
        def.source.footprint = sourceOf("altium-pcblib", chosen.file, chosen.def.footprint.name || chosen.def.name);
        if (chosen.def.footprint.height && !def.footprint.height) def.footprint.height = chosen.def.footprint.height;
        const {noPad, noPin} = globalThis.AtriumLibraryPairing.difference(globalThis.AtriumLibraryPairing.pinsOf(def), globalThis.AtriumLibraryPairing.padsOf(def.footprint));
        if (noPad.length || noPin.length) report.mismatches.push({name: def.name, noPad, noPin});
        report.paired++;
      } else report.symbolOnly++;
      if (known({symbol: symbolSource, footprint: def.source.footprint || null})) { report.skipped++; continue; }
      library.push(def);
    }
    // Footprints no symbol named stay available on their own (a PcbLib of mechanical parts, test pads).
    for (const [, list] of footprints) for (const h of list) {
      if (used.has(h.def)) continue;
      report.unused.push({footprint: h.def.footprint.name || h.def.name, file: h.file.name});
      const src = sourceOf("altium-pcblib", h.file, h.def.footprint.name || h.def.name);
      if (existing.some(d => same(d.source, src))) { report.skipped++; continue; }
      library.push({...clone(h.def), state: "draft", source: {...src, date: today()}});
      report.footprintOnly++;
    }
    report.components = library.length;
    const n = (k, one, many = one + "s") => k + " " + (k === 1 ? one : many);
    report.notes.push("Paired " + n(report.paired, "symbol") + " with the footprint its PCB model names, inside the selected files only" +
      (report.symbolOnly ? "; " + n(report.symbolOnly, "symbol") + " kept without a footprint" : "") + (report.footprintOnly ? "; " + n(report.footprintOnly, "footprint") + " no symbol uses" : "") + ". Every component starts as a draft.");
    if (report.ambiguous.length) report.notes.push("Ambiguous footprints (same name, different pads in several files): " + report.ambiguous.slice(0, 8).map(a => a.symbol + " → " + a.footprint + " (" + a.files.join(", ") + ")").join("; ") + ". Attach the right one with Attach footprint….");
    if (report.unmatched.length) report.notes.push("Footprints not in the selected PcbLibs: " + report.unmatched.slice(0, 8).map(u => u.symbol + " → " + u.footprint).join("; ") + (report.unmatched.length > 8 ? "…" : "") + ".");
    if (report.identical.length) report.notes.push("Identical footprints in several files were used once: " + report.identical.slice(0, 8).map(x => x.footprint).join(", ") + ".");
    if (report.mismatches.length) report.notes.push("Pins and pads that do not match: " + report.mismatches.slice(0, 8).map(m => m.name + (m.noPad.length ? " (pins without pads " + m.noPad.join(", ") + ")" : "") + (m.noPin.length ? " (pads without pins " + m.noPin.join(", ") + ")" : "")).join("; ") + ".");
    if (report.skipped) report.notes.push(n(report.skipped, "component") + " already in the project from the same files were left as they are.");
    return {library, report};
  }
  // File › Open with SchLib and PcbLib files and nothing else: one paired library, notes on the first file.
  function apply(all, files, o = {}) {
    if (!files.some(f => isSch(f.name)) || !files.some(f => isPcb(f.name)) || all.some(x => x.documents?.length || x.manifest)) return all;
    const input = files.map((f, i) => ({name: f.name, sha256: o.sha256?.[i] || null, library: all[i]?.library || []}));
    const {library, report} = pair(input, o);
    const out = all.map((x, i) => ({...x, library: [], notes: i ? x.notes : [...x.notes, ...report.notes]}));
    out[0].library = library;
    out[0].pairing = report;
    return out;
  }
  return Object.freeze({pair, apply, geometry});
})();
