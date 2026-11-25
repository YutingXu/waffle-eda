"use strict";
if (!globalThis.AtriumLibraryPairing && typeof require === "function") require("./library-pairing.js");
// KiCad libraries into complete components (docs/design/library-management.md §11): .kicad_sym symbol
// libraries and .pretty/*.kicad_mod footprints, read from the publicly documented S-expression format
// (no KiCad source used). A symbol names its footprint as "Library:Name" in its Footprint field; this
// module joins the two only inside the files the user chose (a Name.kicad_mod inside Library.pretty,
// else a footprint of that name when exactly one was chosen), never along a search path. Each
// component records both halves' provenance (file, SHA-256, entry), keeps 3D model references and
// starts as a draft. Mirrors library-import-altium.js, with the same report shape.
//
//   parseSymbols(text, {file}) -> {library, entries: [{name, node, extends}]}; buildLibraries(Map(lib -> [{entry, file}]))
//   readSymbols(text, {file, sha256, parents}) -> {library, symbols: [{name, def, footprint, derived}], notes}
//   readFootprint(text, {file, sha256, library}) -> {def, notes}
//   pair(files, o) -> {library, report}
//     files: [{name, path?, sha256?, text}] (.kicad_sym and .kicad_mod); o.existing: the project library
//     report: as AtriumLibraryImportAltium.pair, plus models: {referenced, components}, power, derived
//   read(name, bytes, io) / link(results, files): the File › Open hooks (sexpr.js importerFor)
//   footprintLibrary(path) -> "Package_SO" for ".../Package_SO.pretty/SOIC-8.kicad_mod"
//
// Downloaded and user files are untrusted: size limits per file, a bounded `extends` chain, the
// S-expression parser's depth and object limits, and the importers' geometry budget, reset per file.
globalThis.AtriumLibraryImportKiCad = (() => {
  const S = () => globalThis.AtriumSexpr, K = () => globalThis.AtriumKiCadImport, F = () => globalThis.AtriumImportFormats;
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const isL = Array.isArray;
  const clone = v => JSON.parse(JSON.stringify(v));
  const LIMITS = Object.freeze({symbolFile: 64 * 1024 * 1024, footprintFile: 8 * 1024 * 1024, symbols: 50000, extendsDepth: 8, properties: 200, text: 4096});
  const isSym = n => /\.kicad_sym$/i.test(n), isMod = n => /\.kicad_mod$/i.test(n);
  const handles = n => isSym(n) || isMod(n);
  const baseName = p => String(p || "").split(/[\\/]/).pop();
  const footprintLibrary = p => { const parts = String(p || "").split(/[\\/]/); const dir = parts.length > 1 ? parts[parts.length - 2] : ""; return /\.pretty$/i.test(dir) ? dir.slice(0, -7) : ""; };
  const libraryOf = name => baseName(name).replace(/\.kicad_sym$/i, "");
  const today = () => { try { return new Date().toISOString().slice(0, 10); } catch { return ""; } };
  const str = v => String(v ?? "").slice(0, LIMITS.text);
  const plain = s => (K()?.plain || (x => String(x ?? "")))(str(s));
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const sourceOf = (kind, file, entry) => ({kind, file: baseName(file.path || file.name), ...(file.sha256 ? {sha256: file.sha256} : {}), entry: String(entry || "")});
  const same = (a, b) => !!a && !!b && a.kind === b.kind && !!a.sha256 && a.sha256 === b.sha256 && a.entry === b.entry;
  const id = () => globalThis.Atrium?.id ? Atrium.id() : "k" + Math.random().toString(36).slice(2, 12);
  const text = (t, limit, name) => {
    const s = typeof t === "string" ? t : t instanceof Uint8Array ? new TextDecoder("utf-8").decode(t) : String(t ?? "");
    if (s.length > limit) throw Error(baseName(name) + " is larger than " + (limit >> 20) + " MB.");
    return s.replace(/^﻿/, "");
  };
  // Pretty category from a KiCad library nickname: "Amplifier_Operational" -> "Amplifier Operational".
  const categoryOf = lib => String(lib || "").replace(/_/g, " ").trim() || "KiCad components";

  // ------------------------------------------------------------------ symbols
  function properties(node) {
    const out = Object.create(null);
    let n = 0;
    for (const p of S().all(node, "property")) { if (++n > LIMITS.properties) break; const k = str(p[1]); if (k && k !== "__proto__") out[k] = plain(p[2]); }
    return out;
  }
  // One .kicad_sym file -> its symbols, unresolved: [{name, node, extends}]. KiCad 10 libraries are a
  // Library.kicad_symdir folder with one file per symbol; a derived symbol's parent may be another file there.
  function parseSymbols(input, o = {}) {
    const name = o.file || o.name || "library.kicad_sym";
    const t = S().parse(text(input, LIMITS.symbolFile, name));
    if (t[0] !== "kicad_symbol_lib") throw Error(baseName(name) + " is not a KiCad symbol library (kicad_symbol_lib).");
    const audit = o.audit, top = S().all(t, "symbol"), entries = [], seen = new Set();
    if (audit) {
      audit.children(t);
      for (const n of t.filter(isL)) if (!["version", "generator", "generator_version", "symbol", "embedded_fonts"].includes(n[0]))
        audit.record("unknown", "dropped", n, null, "The symbol library reader does not translate this record.");
    }
    if (top.length > LIMITS.symbols) throw Error(baseName(name) + " has more than " + LIMITS.symbols + " symbols.");
    for (const s of top) {
      const n = str(s[1]);
      if (!n || seen.has(n)) {
        audit?.record("symbol-definition", "dropped", s, null, n ? "An earlier entry has the same symbol name." : "The symbol has no name.");
        continue;
      }
      seen.add(n);
      const ext = S().val(s, "extends");
      entries.push({name: n, node: s, extends: ext == null ? null : str(ext)});
    }
    return {library: o.library || symbolLibrary(o.path || name), entries, version: S().num(S().val(t, "version"), 0)};
  }
  // "Lib" for ".../Lib.kicad_sym" and for ".../Lib.kicad_symdir/Part.kicad_sym".
  function symbolLibrary(p) {
    const parts = String(p || "").split(/[\\/]/), dir = parts.length > 1 ? parts[parts.length - 2] : "";
    return /\.kicad_symdir$/i.test(dir) ? dir.slice(0, -13) : libraryOf(parts[parts.length - 1]);
  }
  // A derived symbol (extends "Parent") draws its parent's body and pins with its own fields.
  // resolve(name) -> an entry of the same library, or null. Returns the chain [self, parent, ...] or null.
  function chainOf(entry, resolve) {
    const chain = [entry];
    for (let p = entry.extends; p != null; p = chain[chain.length - 1].extends) {
      if (chain.length > LIMITS.extendsDepth) return null;
      const parent = resolve(p);
      if (!parent || chain.includes(parent)) return null;
      chain.push(parent);
    }
    return chain;
  }
  // One entry with its chain -> a component definition. file: {name, sha256} of the entry's own file.
  function buildSymbol(entry, chain, file, library, bodyAudit) {
    const props = Object.assign(Object.create(null), ...chain.slice().reverse().map(e => properties(e.node)));
    if (chain.some(e => S().one(e.node, "power"))) return {power: true};
    F()?.resetBudget?.();
    const geo = K().symbolGeometry(chain[chain.length - 1].node, bodyAudit);
    const footprint = str(props.Footprint).trim(), parameters = searchParameters(props);
    const def = {id: id(), name: entry.name, description: str(props.Description || props.ki_description), category: categoryOf(library),
      prefix: str(props.Reference || "U").replace(/[?\d]+$/, "").replace(/[^A-Za-z#_]/g, "") || "U", value: str(props.Value || entry.name), symbol: geo.symbol,
      ...(footprint ? {footprintName: footprint.split(":").pop()} : {}), parameters,
      state: "draft", source: {...sourceOf("kicad-symbol", file, library + ":" + entry.name), date: today()}};
    F()?.scrub?.({library: [def], notes: []}, bodyAudit?.sink);
    return {def, footprint, derived: chain.length > 1};
  }
  function searchParameters(props) {
    const parameters = {};
    const ds = str(props.Datasheet).trim();
    if (ds && ds !== "~") parameters.DATASHEET = ds;
    const keywords = str(props.ki_keywords).trim();
    if (keywords) parameters.Keywords = keywords;
    const filters = str(props.ki_fp_filters).trim();
    if (filters) parameters["Footprint filters"] = filters;
    for (const [k, v] of Object.entries(props)) if (!/^(Reference|Value|Footprint|Datasheet|Description|ki_.*)$/.test(k) && v && v !== "~") parameters[k] = v;
    return parameters;
  }
  // libraries: Map(library -> [{entry, file}]) -> {symbols: [{def, footprint, file, derived}], notes, power, derived}
  function buildLibraries(libraries, observers) {
    const symbols = [], notes = [], seenBodies = observers && new WeakSet();
    let power = 0, derived = 0, failed = 0;
    for (const [library, list] of libraries) {
      const byName = new Map();
      for (const x of list) {
        if (!byName.has(x.entry.name)) byName.set(x.entry.name, x);
        else if (!x.parentOnly) observers?.get(x.entry.node)?.record("symbol-definition", "dropped", x.entry.node, null, "An earlier selected file defines the same library symbol.");
      }
      const resolve = n => byName.get(n)?.entry || null;
      for (const {entry, file, parentOnly} of byName.values()) {
        if (parentOnly) continue;
        const audit = observers?.get(entry.node), chain = chainOf(entry, resolve);
        if (!chain) { audit?.record("symbol-definition", "dropped", entry.node, null, "The parent is missing, circular or too deeply nested."); failed++; notes.push(library + ":" + entry.name + " — its parent symbol " + entry.extends + " is missing, circular or nested too deeply; skipped."); continue; }
        let r;
        const base = chain.at(-1).node, bodyAudit = observers && !seenBodies.has(base) ? observers.get(base) : null;
        try { r = buildSymbol(entry, chain, file, library, bodyAudit); }
        catch (e) { if (e?.fatal) throw e; audit?.record("symbol-definition", "dropped", entry.node, null, "The symbol geometry could not be read."); failed++; notes.push(library + ":" + entry.name + " — " + (e?.message || "malformed symbol") + " Skipped."); continue; }
        if (r.power) { audit?.record("symbol-definition", "dropped", entry.node, null, "Standalone power symbols are omitted from the component library."); power++; continue; }
        if (bodyAudit) seenBodies.add(base);
        if (audit) {
          const reason = r.derived ? "The inherited symbol is flattened to an independent native definition." : undefined;
          audit.record("symbol-definition", reason ? "approximated" : "kept", entry.node, r.def, reason);
          if (r.footprint) observers.set(r.def, {audit, entry, chain});
        }
        if (r.derived) derived++;
        symbols.push({...r, name: entry.name, library, file});
      }
    }
    if (power) notes.push(power + " power symbol" + (power === 1 ? " was" : "s were") + " skipped: Waffle draws power ports with Place › Power Port.");
    if (failed) notes.push(failed + " symbol" + (failed === 1 ? "" : "s") + " could not be read.");
    return {symbols, notes, power, derived};
  }
  // One library file on its own. o.parents: entries of sibling files a derived symbol may extend.
  function readSymbols(input, o = {}) {
    const file = {name: o.file || o.name || "library.kicad_sym", sha256: o.sha256};
    const audit = K().observations(o.fidelity, file.name), observers = audit && new WeakMap();
    const parsed = parseSymbols(input, {...o, audit});
    if (audit) for (const e of parsed.entries) observers.set(e.node, audit);
    const list = parsed.entries.map(entry => ({entry, file}));
    for (const e of o.parents || []) list.push({entry: e, file: {name: "", sha256: null}, parentOnly: true});
    const r = buildLibraries(new Map([[parsed.library, list]]), observers);
    return {...r, library: parsed.library, version: parsed.version};
  }

  // ------------------------------------------------------------------ footprints
  // KiCad 3D model reference -> Waffle model3d {file, offset, rotation, scale?}. The STEP twin of a VRML
  // file is preferred (Waffle reads STEP); the path keeps KiCad's ${KICAD*_3DMODEL_DIR} variable, which
  // the 3D view resolves through the model folder the user set (resolveModel).
  function model3d(node) {
    const m = S().one(node, "model");
    if (!m || typeof m[1] !== "string" || !m[1].trim()) return null;
    const xyz = (head, f = 1) => { const k = S().one(S().one(m, head), "xyz"); return k ? [1, 2, 3].map(i => r4(S().num(k[i]) * f)) : null; };
    const file = str(m[1]).trim().replace(/\.wrl$/i, ".step");
    const offset = xyz("offset") || xyz("at", 25.4) || [0, 0, 0], rotation = xyz("rotate") || [0, 0, 0], scale = xyz("scale");
    const out = {file, offset, rotation, source: "kicad"};
    if (scale && scale.some(v => Math.abs(v - 1) > 1e-6)) out.scale = scale;
    if (S().flag(m, "hide")) out.hidden = true;
    return out;
  }
  const PREFIX = [[/^(R|RES)[_-]/i, "R"], [/^(C|CP|CAP)[_-]/i, "C"], [/^(L|IND)[_-]/i, "L"], [/^(D|LED)[_-]/i, "D"], [/^(Crystal|Oscillator|Resonator)/i, "Y"],
    [/^(Fuse)/i, "F"], [/^(TestPoint)/i, "TP"], [/^(MountingHole|Fiducial)/i, "H"], [/^(Pin|Conn|USB|JST|Molex|TE)/i, "J"], [/^(SW|Button)/i, "SW"], [/^(TO-|SOT-|Q[_-])/i, "Q"]];
  function readFootprint(input, o = {}) {
    const name = o.file || o.name || "footprint.kicad_mod";
    const t = S().parse(text(input, LIMITS.footprintFile, name));
    if (t[0] !== "footprint" && t[0] !== "module") throw Error(baseName(name) + " is not a KiCad footprint (footprint).");
    const entry = str(t[1]).split(":").pop() || baseName(name).replace(/\.kicad_mod$/i, "");
    const library = o.library ?? footprintLibrary(o.path || name);
    F()?.resetBudget?.();
    // The board reader converts pads, graphics and text; a footprint file is a board with this one footprint at the origin.
    const audit = o.audit || K().observations(o.fidelity, name);
    const board = K().readBoard(baseName(name), ["kicad_pcb", ["version", String(S().val(t, "version") || "20240108")], t], o.fidelity, true, audit);
    const parsed = board.library[0];
    if (!parsed?.footprint) throw Error(baseName(name) + " has no footprint.");
    const fp = parsed.footprint;
    fp.name = entry;
    const m3 = model3d(t);
    if (m3) fp.model3d = m3;
    if (audit) {
      audit.children(t, "footprint " + entry);
      const models = S().all(t, "model");
      models.forEach((m, i) => {
        const reason = i ? "Only the first 3D model reference is retained." : !m3 ? "There is no filename for the model." :
          /\.wrl$/i.test(String(m[1])) ? "The VRML reference points to a STEP file with the same basename." : undefined;
        audit.record("model3d", i || !m3 ? "dropped" : reason ? "approximated" : "kept", m, i ? null : m3, reason);
      });
      if (!o.deferDefinition) audit.record("footprint-definition", "kept", "footprint " + entry, fp);
    }
    const tags = str(S().val(t, "tags")).trim(), descr = str(S().val(t, "descr")).trim();
    const attr = (S().one(t, "attr") || []).slice(1).map(String);
    const prefix = PREFIX.find(([re]) => re.test(entry))?.[1] || "U";
    const def = {id: id(), name: entry, description: descr, category: library ? categoryOf(library) : "KiCad footprints", prefix, value: entry, footprint: fp,
      parameters: tags ? {Keywords: tags} : {}, state: "draft", source: {...sourceOf("kicad-footprint", {name: o.path || name, sha256: o.sha256}, (library ? library + ":" : "") + entry), date: today()}};
    if (attr.includes("virtual") || attr.includes("board_only")) def.parameters["Board only"] = "yes";
    // Hostile numbers (non-finite or absurd coordinates) drop the object, as in design imports.
    F()?.scrub?.({library: [def], notes: []}, o.fidelity);
    const notes = board.notes.filter(n => !/^Imported \d+ footprints/.test(n) && !/3D model references were not imported/.test(n));
    if (audit) for (const message of notes) if (!message.startsWith("No board outline")) audit.note(message);
    return {def, library, notes};
  }

  // ------------------------------------------------------------------ pairing
  const r3 = v => Math.round(Number(v || 0) * 1000);
  const geometry = fp => JSON.stringify((fp?.pads || []).map(p => [String(p.number ?? ""), r3(p.x), r3(p.y), r3(p.w), r3(p.h), p.shape || "",
    r3(p.drill), r3(p.angle), r3(p.slotLength), r3(p.slotAngle), p.plated !== false, p.layer || "", !!p.noPaste, !!p.tent?.top, !!p.tent?.bottom]).sort());
  // Joins parsed symbols to parsed footprints. symbols: [{def, footprint: "Lib:Name", file}], footprints:
  // [{def, library, file}]. Shared by File › Open, the Library panel import and folder libraries.
  function join(symbols, footprints, o = {}) {
    const report = {components: 0, paired: 0, symbolOnly: 0, footprintOnly: 0, identical: [], ambiguous: [], unmatched: [], unused: [], mismatches: [], skipped: 0,
      notes: [], models: {referenced: 0, components: 0}, power: o.power || 0, derived: o.derived || 0};
    const byFull = new Map(), byName = new Map(), used = new Set(), library = [];
    const selected = o.observers && new Set();
    for (const f of footprints) {
      const n = String(f.def.footprint.name || f.def.name).toUpperCase(), full = (f.library || "").toUpperCase() + ":" + n;
      if (f.library) { if (!byFull.has(full)) byFull.set(full, []); byFull.get(full).push(f); }
      if (!byName.has(n)) byName.set(n, []); byName.get(n).push(f);
      if (f.def.footprint.model3d) report.models.referenced++;
    }
    function remember(def, files) {
      o.libraryOrigins?.set(def.id, files.map(f => ({name: f.name, ...(f.path ? {path: f.path} : {}), ...(f.sha256 ? {sha256: f.sha256} : {})})));
    }
    const existing = (o.existing || []).filter(d => obj(d.source));
    const known = (sym, fp) => existing.some(d => same(d.source, sym) && (!fp || same(d.source.footprint, fp)));
    for (const s of symbols) {
      const want = String(s.footprint || "").trim(), [lib, nm] = want.includes(":") ? [want.slice(0, want.lastIndexOf(":")), want.slice(want.lastIndexOf(":") + 1)] : ["", want];
      let hits = want ? byFull.get(lib.toUpperCase() + ":" + nm.toUpperCase()) || [] : [];
      // Footprint files chosen without their .pretty folder carry no library name: match by name alone.
      if (want && !hits.length) hits = (byName.get(nm.toUpperCase()) || []).filter(f => !f.library || !lib);
      let chosen = null;
      if (hits.length === 1) chosen = hits[0];
      else if (hits.length > 1) {
        if (new Set(hits.map(h => geometry(h.def.footprint))).size === 1) { chosen = hits[0]; report.identical.push({footprint: want, files: hits.map(h => baseName(h.file?.path || h.file?.name))}); }
        else report.ambiguous.push({symbol: s.def.name, footprint: want, files: hits.map(h => baseName(h.file?.path || h.file?.name))});
      } else if (want) report.unmatched.push({symbol: s.def.name, footprint: want});
      const origin = o.observers?.get(s.def);
      if (origin && want) {
        const field = S().all(origin.entry.node, "property").find(p => p[1] === "Footprint");
        const reason = !hits.length ? "The referenced footprint was absent from the selection." : !chosen ?
          "Several selected footprints match the name with different pad geometry." : hits.length > 1 ?
          "One of several footprints with the same name and pad geometry was chosen." : undefined;
        origin.audit.record("footprint-link", !chosen ? "dropped" : reason ? "approximated" : "kept", field || origin.entry.node, null, reason);
      }
      const def = clone(s.def);
      if (chosen) {
        selected?.add(chosen);
        hits.forEach(h => used.add(h));
        def.footprint = clone(chosen.def.footprint);
        def.footprintName = def.footprint.name;
        def.source.footprint = {...chosen.def.source};
        delete def.source.footprint.date;
        if (def.footprint.model3d) report.models.components++;
        const {noPad, noPin} = globalThis.AtriumLibraryPairing.difference(globalThis.AtriumLibraryPairing.pinsOf(def), globalThis.AtriumLibraryPairing.padsOf(def.footprint));
        if (noPad.length || noPin.length) report.mismatches.push({name: def.name, noPad, noPin});
        report.paired++;
      } else report.symbolOnly++;
      if (known(def.source, def.source.footprint || null)) { report.skipped++; continue; }
      library.push(def);
      if (o.libraryOrigins) remember(def, chosen ? [s.file, chosen.file] : [s.file]);
    }
    if (o.footprints !== false) for (const f of footprints) {
      if (used.has(f)) continue;
      selected?.add(f);
      report.unused.push({footprint: f.def.footprint.name, file: baseName(f.file?.path || f.file?.name)});
      if (existing.some(d => same(d.source, f.def.source))) { report.skipped++; continue; }
      library.push(clone(f.def));
      if (o.libraryOrigins) remember(f.def, [f.file]);
      report.footprintOnly++;
    }
    if (o.observers) for (const f of footprints) {
      const source = o.observers.get(f.def);
      if (!source) continue;
      const exact = selected.has(f), alias = used.has(f), status = exact ? "kept" : alias ? "approximated" : "dropped";
      const reason = exact ? undefined : alias ? "The join used a matching pad pattern from another selected footprint." : "Unused footprints were excluded from this library import.";
      source.pending.finish(status, reason);
      source.audit.record("footprint-definition", status, "footprint " + f.def.name, exact ? f.def.footprint : null, reason);
    }
    report.components = library.length;
    const n = (k, one, many = one + "s") => k + " " + (k === 1 ? one : many);
    report.notes.push("Paired " + n(report.paired, "symbol") + " with the footprint its Footprint field names, inside the selected files only" +
      (report.symbolOnly ? "; " + n(report.symbolOnly, "symbol") + " kept without a footprint" : "") + (report.footprintOnly ? "; " + n(report.footprintOnly, "footprint") + " no symbol uses" : "") + ". Every component starts as a draft.");
    if (report.derived) report.notes.push(n(report.derived, "derived symbol") + " (extends) drew their parent's body and pins.");
    if (report.ambiguous.length) report.notes.push("Ambiguous footprints (same name, different pads in several files): " + report.ambiguous.slice(0, 8).map(a => a.symbol + " → " + a.footprint + " (" + a.files.join(", ") + ")").join("; ") + ". Attach the right one with Attach footprint….");
    if (report.unmatched.length) report.notes.push("Footprints not in the selected files: " + report.unmatched.slice(0, 8).map(u => u.symbol + " → " + u.footprint).join("; ") + (report.unmatched.length > 8 ? "…" : "") + ".");
    if (report.identical.length) report.notes.push("Identical footprints in several files were used once: " + report.identical.slice(0, 8).map(x => x.footprint).join(", ") + ".");
    if (report.mismatches.length) report.notes.push("Pins and pads that do not match: " + report.mismatches.slice(0, 8).map(m => m.name + (m.noPad.length ? " (pins without pads " + m.noPad.join(", ") + ")" : "") + (m.noPin.length ? " (pads without pins " + m.noPin.join(", ") + ")" : "")).join("; ") + ".");
    if (report.models.components) report.notes.push(n(report.models.components, "component") + " keep their KiCad 3D model reference (${KICAD*_3DMODEL_DIR}); set the 3D model folder to see them in 3D.");
    if (report.skipped) report.notes.push(n(report.skipped, "component") + " already in the project from the same files were left as they are.");
    return {library, report};
  }
  function pair(files, o = {}) {
    const libraries = new Map(), footprints = [], notes = [];
    let observers;
    for (const f of files) {
      const label = f.path || f.name, sink = o.fidelityFor?.(f) || f.fidelity || o.fidelity;
      const relative = typeof f.path === "string" && !/^([A-Za-z]:|[\\/])/.test(f.path) && !f.path.split(/[\\/]/).includes("..") ? f.path : baseName(f.name);
      const audit = K().observations(sink, relative);
      let pending;
      try {
        if (isSym(f.name)) {
          const r = parseSymbols(f.text ?? f.bytes, {file: label, path: label, audit});
          if (!libraries.has(r.library)) libraries.set(r.library, []);
          for (const entry of r.entries) {
            if (audit) (observers ||= new WeakMap()).set(entry.node, audit);
            libraries.get(r.library).push({entry, file: {name: f.name, path: f.path, sha256: f.sha256}});
          }
        } else if (isMod(f.name)) {
          pending = K().pendingObservations(audit);
          const r = readFootprint(f.text ?? f.bytes, {file: label, path: label, sha256: f.sha256, library: f.library, fidelity: sink, audit: pending, deferDefinition: true});
          if (audit) (observers ||= new WeakMap()).set(r.def, {audit, pending});
          footprints.push({def: r.def, library: r.library, file: f});
        }
      } catch (e) {
        if (o.strict) throw e;
        pending?.finish("dropped", "The containing footprint could not be read.");
        audit?.record("library-file", "dropped", "file", null, "The library file could not be parsed.");
        notes.push(baseName(label) + " — " + (e?.message || String(e)));
      }
    }
    const built = buildLibraries(libraries, observers);
    const out = join(built.symbols, footprints, {...o, observers, power: built.power, derived: built.derived});
    out.report.notes.push(...built.notes, ...notes);
    return out;
  }

  // ------------------------------------------------------------------ File › Open (AtriumImportFormats)
  function read(name, bytes, io) {
    const t = io?.utf8 ? io.utf8(bytes) : text(bytes, LIMITS.symbolFile, name);
    return {documents: [], library: [], notes: [], kicadLibrary: {name, text: t}};
  }
  function link(results, files, options = {}) {
    const mine = results.map((r, i) => [r, i]).filter(([r]) => r.kicadLibrary);
    if (!mine.length) return;
    const input = mine.map(([r, i]) => {
      const file = files[i] || {}, bytes = file.bytes;
      const hash = globalThis.AtriumSourceFile?.sha256 || globalThis.AtriumLibraryStore?.sha256;
      const sha = hash && bytes ? hash(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)) : file.sha256;
      return {name: r.kicadLibrary.name, path: file.path || file.name, text: r.kicadLibrary.text, sha256: sha, fidelity: options.fidelityFor?.(file) || options.fidelity};
    });
    const {library, report} = pair(input, {existing: options.existing, libraryOrigins: options.libraryOrigins});
    mine.forEach(([r], k) => { delete r.kicadLibrary; r.library = k ? [] : library; r.notes = k ? [] : report.notes.slice(); if (!k) r.pairing = report; });
  }
  return Object.freeze({LIMITS, handles, properties, searchParameters, footprintLibrary, symbolLibrary, parseSymbols, chainOf, buildSymbol, buildLibraries, readSymbols, readFootprint, model3d, join, pair, read, link, geometry});
})();
