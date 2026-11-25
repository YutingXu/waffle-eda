"use strict";
// Folder libraries (docs/design/library-management.md §4, §8, phase 1): a folder you choose, holding
// Waffle library files (components/*.json, *.atrlib), Altium SchLib/PcbLib pairs or KiCad libraries
// (*.kicad_sym, *.kicad_symdir/, *.pretty/*.kicad_mod), shown in the Library panel next to the project
// library. DOM-free; loads with the Library panel and in MCP.
//
// The index is lazy and incremental. Each file is remembered by size and modification time (or a
// provider's own content tag, such as a ZIP entry's CRC); a file whose stamp changed is read and
// hashed, and parsed again only when its SHA-256 changed. The index keeps compact rows (names, pins,
// pads, footprint names), never geometry; a component's symbol and footprint are read from its files
// only when it is selected, added or compared (materialise).
//
// Waffle never writes into the folder unless you save there (save()).
//
//   classify(path)                      -> file kind or null (ignored)
//   plan(index, listing)                -> {read: [path], removed: [path], unchanged}   listing: [{path, size, mtime, tag?}]
//   ingest(index, entry, bytes)         -> "parsed" | "same" | "error"   (one file; SHA-256 decides)
//   assemble(folder, index)             -> library {id, name, kind: "folder", defs: [stub], report}
//   needs(stub)                         -> [path] the files materialise reads
//   materialise(stub, files: Map(path -> bytes)) -> a complete definition with the stub's id
//   refresh(folder, provider, {cache, progress, signal}) -> library (async driver over the above)
//   providers: memory(map), archiveProvider(blobs), fileList(File[]), directoryHandle(handle), nativeFolder(grant)
//   registry: folders(), addFolder(rec), removeFolder(id), library(id), libraries(), load(lib, id)
globalThis.AtriumLibrarySources = (() => {
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const Store = () => globalThis.AtriumLibraryStore, Lib = () => globalThis.AtriumLibrary;
  const KI = () => globalThis.AtriumLibraryImportKiCad, SX = () => globalThis.AtriumSexpr;
  const INDEX_VERSION = 3;
  const LIMITS = Object.freeze({files: 200000, depth: 24, component: 4 << 20, atrlib: 64 << 20, schlib: 64 << 20, pcblib: 64 << 20, "kicad-sym": 64 << 20, "kicad-mod": 8 << 20, "kicad-table": 4 << 20, "library-notice": 64 << 10, pins: 4096, pads: 8192});
  const sha = s => Store().sha256(s);
  const hid = (...parts) => "lib-" + sha(parts.join("\u0001")).slice(0, 24);
  const base = p => String(p).split("/").pop();
  const dirOf = p => { const i = String(p).lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
  const str = (v, n = 512) => String(v ?? "").slice(0, n);
  function heightFields(height, key = "height") {
    const value = Number(height);
    return Number.isFinite(value) && value !== 0 ? {[key]: value} : {};
  }

  // ------------------------------------------------------------------ files
  // Hidden folders (.git), dependency and generated folders are never walked.
  const SKIP_DIR = /^(\.|node_modules$|__pycache__$|.*\.3dshapes$)/;
  function classify(path) {
    const p = String(path), name = base(p), lower = name.toLowerCase(), parts = p.split("/");
    if (parts.length > LIMITS.depth || parts.slice(0, -1).some(d => SKIP_DIR.test(d)) || name.startsWith(".")) return null;
    if (/^licen[cs]e(?:\.md|\.txt)?$/.test(lower)) return "library-notice";
    if (/^(sym|fp)-lib-table$/.test(lower)) return "kicad-table";
    if (lower.endsWith(".kicad_sym")) return "kicad-sym";
    if (lower.endsWith(".kicad_mod")) return "kicad-mod";
    if (lower.endsWith(".schlib")) return "schlib";
    if (lower.endsWith(".pcblib")) return "pcblib";
    if (lower.endsWith(".atrlib")) return "atrlib";
    if (lower === "library.json" && parts.length === 1) return "atrium-library";
    if (lower.endsWith(".json") && parts.length >= 2 && parts[parts.length - 2] === "components") return "component";
    return null;
  }
  const decode = bytes => typeof bytes === "string" ? bytes : new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
  const asBytes = v => typeof v === "string" ? new TextEncoder().encode(v) : v instanceof Uint8Array ? v : new Uint8Array(v);

  // ------------------------------------------------------------------ rows (parse once per file)
  const pinRows = pins => (pins || []).slice(0, LIMITS.pins).map(p => [str(p.number, 32), str(p.name, 64)]);
  const padRows = pads => (pads || []).filter(p => !p.thermalVia).slice(0, LIMITS.pads).map(p => [str(p.number ?? "", 32), p.drill > 0 && p.plated !== false ? 1 : 0]);
  function defRow(def) {
    const L = Lib(), params = obj(def.parameters) ? Object.fromEntries(Object.entries(def.parameters).filter(([, v]) => typeof v !== "object").slice(0, 40).map(([k, v]) => [str(k, 64), str(v)])) : {};
    return {t: "def", id: str(def.id, 128), n: str(def.name), rev: Number.isInteger(def.rev) ? def.rev : 1, hash: L ? L.defHash(def) : null,
      ref: str(def.prefix, 16), val: str(def.value), cat: str(def.category, 128), d: str(def.description, 1024), params,
      ...(def.package ? {pkg: str(def.package)} : {}), ...heightFields(def.height), ...heightFields(def.footprint?.height, "fpHeight"),
      ...(def.symbol ? {pins: pinRows(def.symbol.pins), parts: def.symbol.parts || 1} : {}), ...(def.footprint ? {pads: padRows(def.footprint.pads), fpn: str(def.footprint.name)} : {}),
      ...(def.model3d || def.footprint?.model3d || def.footprint?.bodies3d?.length ? {m3: 1} : {})};
  }
  // KiCad: pins straight from the tree (no geometry), so a library of 20,000 symbols indexes quickly.
  function kicadSymbolRows(text, path) {
    const S = SX(), r = KI().parseSymbols(text, {file: path, path});
    return r.entries.map(e => {
      const props = KI().properties(e.node);
      const pins = [], seen = new Set();
      let parts = 1;
      for (const sub of S.all(e.node, "symbol")) {
        const m = /_(\d+)_(\d+)$/.exec(String(sub[1] ?? "")), unit = m ? +m[1] : 0, style = m ? +m[2] : 0;
        if (unit > parts) parts = Math.min(64, unit);
        if (style === 2) continue;
        for (const pin of S.all(sub, "pin")) {
          const number = str(S.val(pin, "number"), 32), name = str(S.val(pin, "name"), 64);
          const k = number + "|" + unit;
          if (seen.has(k) || pins.length >= LIMITS.pins) continue;
          seen.add(k); pins.push([number, name === "~" ? "" : name]);
        }
      }
      return {t: "sym", n: e.name, asset: sha(JSON.stringify(e.node)), x: e.extends, lib: r.library, props, power: !!S.one(e.node, "power"), ref: props.Reference || "", val: props.Value || "",
        fp: props.Footprint || "", d: props.Description || props.ki_description || "", kw: props.ki_keywords || "", ds: props.Datasheet && props.Datasheet !== "~" ? props.Datasheet : "",
        ...(e.extends ? {} : {pins, parts})};
    });
  }
  function kicadFootprintRows(text, path) {
    const S = SX(), t = S.parse(decode(text));
    if (t[0] !== "footprint" && t[0] !== "module") throw Error(base(path) + " is not a KiCad footprint.");
    const pads = [], sourcePads = S.all(t, "pad");
    for (const p of sourcePads) if (pads.length < LIMITS.pads) pads.push([p[2] === "np_thru_hole" ? "" : str(p[1], 32), p[2] === "thru_hole" ? 1 : 0]);
    // Only keep a signature in the index. Source IDs and net names do not change a land.
    const padSignatures = sourcePads.map(p => JSON.stringify(p.filter(value =>
      !Array.isArray(value) || !["uuid", "tstamp", "net"].includes(value[0])))).sort();
    const defaults = ["version", "layer", "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "solder_paste_ratio"].map(k => S.one(t, k));
    const geo = sha(JSON.stringify([defaults,padSignatures]));
    return [{t: "fp", n: str(t[1]).split(":").pop() || base(path).replace(/\.kicad_mod$/i, ""), lib: KI().footprintLibrary(path), d: str(S.val(t, "descr"), 1024), kw: str(S.val(t, "tags")), pads, geo, ...(S.one(t, "model") ? {m3: 1} : {})}];
  }
  // A KiCad table assigns the nickname used by the symbol's Footprint field. References
  // resolve against the source's own listing, including the standard KiCad and project variables.
  function tableRows(text, path) {
    const S = SX(), root = S.parse(text), symbol = base(path).toLowerCase() === "sym-lib-table";
    if (root[0] !== (symbol ? "sym_lib_table" : "fp_lib_table")) throw Error("Invalid KiCad library table.");
    return S.all(root, "lib").filter(r => /^kicad(?:legacy)?$/i.test(S.val(r, "type")) && !S.one(r, "disabled"))
      .map(r => ({t: "table", symbol, nickname: str(S.val(r, "name"), 256), uri: str(S.val(r, "uri"), 4096)}))
      .filter(r => r.nickname && !r.nickname.includes(":") && r.uri);
  }
  function tableAliases(files, root, report) {
    const paths = new Set(), aliases = new Map();
    const libraryPath = p => /\.(?:pretty|kicad_symdir)$/i.test(dirOf(p)) ? dirOf(p) : p;
    for (const [p, file] of Object.entries(files)) if (file.kind === "kicad-sym" || file.kind === "kicad-mod") paths.add(libraryPath(p));
    for (const [p, file] of Object.entries(files)) {
      if (file.kind !== "kicad-table") continue;
      const dir = dirOf(p);
      for (const row of file.rows) {
        const {symbol, nickname} = row;
        const uri = row.uri.replace(/\\/g, "/"), varPrefix = /^\$\{([^}]+)\}\//.exec(uri), rest = varPrefix ? uri.slice(varPrefix[0].length) : uri;
        const kind = symbol ? "SYMBOL" : "FOOTPRINT", sub = symbol ? "symbols" : "footprints";
        const accepted = !varPrefix || /^(KIPRJMOD|KIPROJMOD)$/.test(varPrefix[1]) || new RegExp("^KICAD[0-9]*_" + kind + "_DIR$").test(varPrefix[1]);
        const local = root && rest.startsWith(root + "/") ? rest.slice(root.length + 1) : rest;
        let resolved;
        if (accepted && !local.startsWith("/") && !/[:$]/.test(local) && !local.split("/").includes("..") &&
            (symbol ? /\.kicad_sym(?:dir)?$/i : /\.pretty$/i).test(local)) {
          const rel = local.split("/").filter(s => s && s !== ".").join("/");
          const candidates = dir ? [dir + "/" + rel, rel] : [rel];
          if (varPrefix && varPrefix[1].startsWith("KICAD")) candidates.push(sub + "/" + rel);
          resolved = candidates.find(p => paths.has(p));
        }
        if (resolved) { if (!aliases.has(resolved)) aliases.set(resolved, nickname); }
        else if (report.tableMissing.length < 50) report.tableMissing.push({table: p, nickname});
      }
    }
    return p => aliases.get(libraryPath(p));
  }
  function altiumRows(kind, bytes, path) {
    const IO = globalThis.AtriumIO;
    if (!IO?.read) throw Error("Altium library reading is not loaded.");
    const lib = IO.read(base(path), bytes).library || [];
    if (kind === "schlib") return lib.filter(d => d.symbol).map(d => ({t: "sym", n: str(d.name), asset: Lib().defHash(d), params: d.parameters, fpn: str(d.footprintName), ref: str(d.prefix, 16), val: str(d.value), cat: str(d.category, 128), d: str(d.description, 1024),
      pins: pinRows(d.symbol.pins), parts: d.symbol.parts || 1}));
    const geo = globalThis.AtriumLibraryImportAltium?.geometry;
    return lib.filter(d => d.footprint).map(d => {
      const fp = d.footprint;
      // Two libraries can expose the same pad pattern and different bodies. Hash large payloads
      // individually so the comparison never retains a second concatenated STEP or zlib string.
      const models = (fp.bodyModels || []).map(m => ({...m, zlib: m.zlib && sha(m.zlib), stepText: m.stepText && sha(m.stepText)}));
      const padKey = geo ? sha(geo(fp)).slice(0, 16) : "";
      const physical = fp.bodies3d?.length || models.length ? sha(JSON.stringify([padKey, fp.bodies3d || [],
        models.map(m => [m.id, m.file, m.assetId, m.zlib, m.stepText]).sort()])) : padKey;
      const asset = Lib().defHash(models.length ? {...d, footprint: {...fp, bodyModels: models}} : d);
      return {t: "fp", n: str(fp.name || d.name), asset, pads: padRows(fp.pads), geo: physical, ...heightFields(fp.height),
        ...(fp.model3d || fp.bodies3d?.length ? {m3: 1} : {})};
    });
  }
  function atriumRows(kind, bytes, path) {
    const text = decode(bytes);
    if (kind === "atrium-library") {
      const data = JSON.parse(text);
      if (!obj(data) || data.format !== "atrium-library-dir") throw Error("library.json is not a Waffle library folder description.");
      return [{t: "meta", id: str(data.id, 128), n: str(data.name), d: str(data.description, 1024), licence: str(data.licence || data.license, 64)}];
    }
    if (kind === "atrlib") {
      const lib = Lib().readLibraryFile(text, base(path));
      return [{t: "library-file", scope: lib.id || path, families: lib.componentFamilies || []}, ...lib.defs.map(defRow)];
    }
    const raw = JSON.parse(text);
    const def = Lib().scrub(raw);
    if (!obj(def) || typeof def.id !== "string" || !def.id) throw Error(base(path) + " has no component id.");
    const v = Lib().validateDef(def, {footprintWarnings: false});
    if (!v.ok) throw Error(base(path) + ": " + v.errors[0]);
    return [defRow(def)];
  }
  function rowsOf(kind, bytes, path) {
    if (bytes.length > (LIMITS[kind] || LIMITS.component)) throw Error(base(path) + " is too large for a library file.");
    globalThis.AtriumImportFormats?.resetBudget?.();
    if (kind === "library-notice") {
      const notice = decode(bytes);
      const official = /KiCad librar(?:y|ies)/i.test(notice) && /CC-BY-SA 4\.0|creativecommons\.org\/licenses\/by-sa\/4\.0/i.test(notice) &&
        /waives article 3|KiCad[- ]libraries[- ]exception/i.test(notice);
      return [{t: "notice", text: official ? notice : null}];
    }
    if (kind === "kicad-sym") return kicadSymbolRows(decode(bytes), path);
    if (kind === "kicad-mod") return kicadFootprintRows(bytes, path);
    if (kind === "kicad-table") return tableRows(decode(bytes), path);
    if (kind === "schlib" || kind === "pcblib") return altiumRows(kind, bytes, path);
    return atriumRows(kind, bytes, path);
  }

  // ------------------------------------------------------------------ index
  const emptyIndex = () => ({version: INDEX_VERSION, files: {}});
  const indexGeneration = index => index?.sessionGeneration || index?.generation;
  const legacyIndex = index => index?.version === 1 || index?.version === 2;
  function usable(index, allowLegacy = false) {
    if (index?.version > INDEX_VERSION) throw Error("This library folder index was saved by a newer version of Waffle.");
    return obj(index) && obj(index.files) && (index.version === INDEX_VERSION || allowLegacy && legacyIndex(index)) ? index : emptyIndex();
  }
  // New or changed files and rows rejected by the older scan worker's missing pairing dependency.
  function plan(index, listing) {
    const files = usable(index).files, read = [], seen = new Set();
    let unchanged = 0;
    if (listing.length > LIMITS.files) throw Error("The folder has more than " + LIMITS.files.toLocaleString("en") + " library files.");
    for (const f of listing) {
      if (!classify(f.path) || seen.has(f.path)) continue;
      seen.add(f.path);
      const old = Object.hasOwn(files, f.path) ? files[f.path] : null;
      const same = old && !old.temporary && old.size === f.size && (f.tag != null && old.tag != null ? old.tag === f.tag : old.mtime === f.mtime) &&
        (!old.error || !/^(?:Cannot read properties of undefined \(reading 'difference'\)|undefined is not an object \(evaluating 'globalThis\.AtriumLibraryPairing\.difference'\)|(?:can't access property "difference", )?globalThis\.AtriumLibraryPairing is undefined)$/.test(old.error));
      if (same) unchanged++; else read.push(f.path);
    }
    const removed = Object.keys(files).filter(p => !seen.has(p));
    return {read, removed, unchanged};
  }
  // One file read: hashed; parsed only when the content changed. Returns what happened.
  function ingest(index, entry, bytes) {
    const files = index.files, kind = classify(entry.path);
    if (!kind) return "skip";
    const b = asBytes(bytes), digest = sha(b), old = Object.hasOwn(files, entry.path) ? files[entry.path] : null;
    const stamp = {size: entry.size ?? b.length, mtime: entry.mtime ?? 0, ...(entry.tag != null ? {tag: entry.tag} : {})};
    if (old && old.sha256 === digest && !old.error) { files[entry.path] = {...old, ...stamp}; return "same"; }
    try {
      const rows = rowsOf(kind, b, entry.path);
      files[entry.path] = {...stamp, sha256: digest, kind, rows, rowsHash: sha(JSON.stringify(rows))};
      return "parsed";
    }
    catch (e) { files[entry.path] = {...stamp, sha256: digest, kind, rows: [], error: str(e?.message || e, 300)}; return "error"; }
  }
  function removeFiles(files, removed) {
    for (const path of removed) delete files[path];
    return files;
  }
  const mergeFiles = (base, patch, removed) => removeFiles({...base, ...patch}, removed);

  // ------------------------------------------------------------------ assembly (rows -> stub definitions)
  const stubSymbol = (pins, parts) => ({pins: (pins || []).map(([number, name]) => ({number, name, x: 0, y: 0})), shapes: [], ...(parts > 1 ? {parts} : {})});
  const stubFootprint = (name, pads, m3, height) => ({name, pads: (pads || []).map(([number, th]) => ({number, x: 0, y: 0, w: 1, h: 1, drill: th ? .5 : 0})),
    shapes: [], ...(m3 ? {model3d: {}} : {}), ...heightFields(height)});
  const kicadPrefix = ref => String(ref || "U").replace(/[?\d]+$/, "").replace(/[^A-Za-z#_]/g, "") || "U";
  const categoryOf = lib => String(lib || "").replace(/_/g, " ").trim();
  function folderCredit(library, path, kind) {
    if (!path) return null;
    for (let dir = dirOf(path); ; dir = dirOf(dir)) {
      if (library?.notices?.has(dir)) {
        const notice = library.notices.get(dir);
        return notice ? Lib().kiCadCredit(kind, notice) : null;
      }
      if (!dir) break;
    }
    const root = library?.installation;
    if (root == null) return null;
    const relative = root ? root + "/" + path : path;
    // Packaged symbol/footprint trees have fixed layouts. A project, user library or
    // third-party subdirectory with KiCad extensions does not establish official provenance.
    const installed = kind === "symbols" ? /^symbols\/(?:[^/]+\.kicad_symdir\/)?[^/]+\.kicad_sym$/i :
      /^footprints\/[^/]+\.pretty\/[^/]+\.kicad_mod$/i;
    return installed.test(relative) ? Lib().kiCadCredit(kind) : null;
  }
  function installationRoot(root) {
    const path = String(root || "").replace(/\\/g, "/").replace(/\/$/, "");
    const distribution = /^(?:\/(?:usr(?:\/local)?|app)\/share\/kicad|\/Applications\/(?:KiCad\/)?KiCad\.app\/Contents\/SharedSupport|[A-Z]:\/Program Files\/KiCad\/[0-9.]+\/share\/kicad)(?:\/((?:symbols|footprints)(?:\/[^/]+\.(?:pretty|kicad_symdir))?))?$/i;
    const match = distribution.exec(path);
    return match ? match[1] || "" : null;
  }
  const installationCredit = (dir, name, kind) => folderCredit({installation: installationRoot(dir)}, name, kind);
  function assemble(folder, index, root) {
    const files = usable(index, true).files, defs = [], report = {files: 0, errors: [], components: 0, paired: 0, symbolOnly: 0, footprintOnly: 0, ambiguous: [], unmatched: [], tableMissing: [], power: 0};
    const alias = tableAliases(files, root, report);
    const notices = new Map();
    let meta = null;
    const nestedFamilies = [], nested = new Map(), nestedRefs = [];
    const kicadSyms = new Map(), kicadFps = new Map(), kicadFpsByName = new Map(), altSyms = [], altFps = new Map();
    for (const [path, f] of Object.entries(files)) {
      report.files++;
      if (f.error) report.errors.push({file: path, message: f.error});
      if (f.kind === "library-notice") {
        const dir = dirOf(path), notice = f.rows?.[0]?.text;
        // Conflicting or unreadable notices in a directory take precedence over inherited credit.
        notices.set(dir, notices.has(dir) && notices.get(dir) !== notice ? null : notice || null);
      }
      for (const r of f.rows || []) {
        if (r.t === "meta") meta = r;
        else if (r.t === "library-file") nested.set(path, r);
        else if (r.t === "def") {
          const def = atriumStub(r, path); defs.push(def);
          if (nested.has(path)) nestedRefs.push([def, path, nested.get(path).scope]);
        }
        else if (f.kind === "kicad-sym") {
          const lib = alias(path) || r.lib;
          if (!kicadSyms.has(lib)) kicadSyms.set(lib, new Map());
          const m = kicadSyms.get(lib); if (!m.has(r.n)) m.set(r.n, {...r, path});
        } else if (f.kind === "kicad-mod") {
          const fp = {...r, lib: alias(path) || r.lib, path, digest:f.sha256};
          const full = (fp.lib + ":" + r.n).toUpperCase();
          if (!kicadFps.has(full)) kicadFps.set(full, []);
          kicadFps.get(full).push(fp);
          const n = r.n.toUpperCase();
          if (!kicadFpsByName.has(n)) kicadFpsByName.set(n, []);
          kicadFpsByName.get(n).push(fp);
        }
        else if (f.kind === "schlib") altSyms.push({...r, path});
        else if (f.kind === "pcblib") { const k = r.n.toUpperCase(); altFps.set(k, [...(altFps.get(k) || []), {...r, path}]); }
      }
    }
    const libId = meta?.id || folder.libraryId || folder.id;
    // A nested library may reuse an entry ID from another library in this folder.
    for (const [def, path, scope] of nestedRefs) def.id = hid(libId, "atrlib", path, scope, def.id);
    for (const [path, file] of nested) {
      const scoped = id => hid(libId, "atrlib", path, file.scope, id);
      for (const family of file.families) nestedFamilies.push({...family, id: scoped(family.id),
        members: family.members.map(m => ({...m, defId: scoped(m.defId)}))});
    }
    const used = new Set();
    // KiCad: derived symbols take their parent's pins; the Footprint field "Lib:Name" pairs inside this folder.
    for (const [lib, symbols] of kicadSyms) for (const r of symbols.values()) {
      const chain = KI().chainOf({name: r.n, extends: r.x, row: r}, n => { const p = symbols.get(n); return p ? {name: p.n, extends: p.x, row: p} : null; });
      if (!chain) { report.errors.push({file: r.path, message: lib + ":" + r.n + " extends a missing symbol."}); continue; }
      const root = chain[chain.length - 1].row;
      if (chain.some(c => c.row.power)) { report.power++; continue; }
      const want = String(r.fp || chain.find(c => c.row.fp)?.row.fp || "");
      const colon = want.lastIndexOf(":"), fpLib = colon >= 0 ? want.slice(0, colon) : "", fpName = colon >= 0 ? want.slice(colon + 1) : want;
      const hits = !want ? [] : fpLib ? (kicadFps.get((fpLib + ":" + fpName).toUpperCase()) || []) :
        (kicadFpsByName.get(fpName.toUpperCase()) || []);
      const preferred = hits.at(-1);
      const same = key => preferred?.[key] && hits.every(hit => hit[key] === preferred[key]);
      const fp = hits.length === 1 || same("geo") || same("digest") ? preferred : null;
      if (fp) {
        hits.forEach(hit => used.add(hit));
        report.paired++;
      } else {
        report.symbolOnly++;
        if (hits.length > 1) report.ambiguous.push({symbol:lib + ":" + r.n,footprint:want,files:hits.map(hit => hit.path)});
        else if (want) report.unmatched.push({symbol: lib + ":" + r.n, footprint: want});
      }
      const pick = k => r[k] || chain.find(c => c.row[k])?.row[k] || "";
      const props = Object.assign(Object.create(null), ...chain.slice().reverse().map(c => c.row.props));
      const params = KI().searchParameters(props);
      defs.push({id: hid(libId, "kicad", lib + ":" + r.n), name: r.n, prefix: kicadPrefix(pick("ref")), value: props.Value || r.n, category: categoryOf(lib), description: pick("d"), parameters: params,
        state: "draft", symbol: stubSymbol(root.pins, root.parts), ...(fp ? {footprint: stubFootprint(fp.n, fp.pads, fp.m3), footprintName: fp.n} : want ? {footprintName: fpName} : {}),
        stub: {kind: "kicad", entry: lib + ":" + r.n, assets: chain.map(c => c.row.asset), files: [...new Set(chain.map(c => c.row.path))], ...(fp ? {footprint: fp.path, footprintLibrary: fp.lib} : {})}});
    }
    for (const group of kicadFps.values()) for (const fp of group) {
      if (used.has(fp)) continue;
      report.footprintOnly++;
      // The previous index used the last matching file for the unsuffixed ID.
      const id = fp === group.at(-1) ? hid(libId, "kicad-fp", fp.lib + ":" + fp.n) : hid(libId, "kicad-fp", fp.lib + ":" + fp.n, fp.path);
      defs.push({id, name: fp.n, prefix: "U", value: fp.n, category: categoryOf(fp.lib) || "KiCad footprints", description: fp.d,
        parameters: fp.kw ? {Keywords: fp.kw} : {}, state: "draft", footprint: stubFootprint(fp.n, fp.pads, fp.m3), stub: {kind: "kicad", entry: fp.lib + ":" + fp.n, files: [], footprint: fp.path, footprintLibrary: fp.lib}});
    }
    // Altium: a SchLib symbol joins the PcbLib footprint of the name its model gives, inside this folder only.
    const altUsed = new Set();
    for (const r of altSyms) {
      const hits = r.fpn ? altFps.get(r.fpn.toUpperCase()) || [] : [];
      let fp = null;
      if (hits.length === 1 || hits.length > 1 && new Set(hits.map(h => h.geo)).size === 1) fp = hits[0];
      else if (hits.length > 1) report.ambiguous.push({symbol: r.n, footprint: r.fpn, files: hits.map(h => h.path)});
      else if (r.fpn) report.unmatched.push({symbol: r.n, footprint: r.fpn});
      if (fp) { hits.forEach(h => altUsed.add(h)); report.paired++; } else report.symbolOnly++;
      defs.push({id: hid(libId, "altium", r.path + ":" + r.n), name: r.n, prefix: r.ref || "U", value: r.val || r.n, category: r.cat === "Imported symbols" ? "Imported components" : r.cat || "Imported components",
        description: r.d, parameters: r.params || {}, state: "draft", symbol: stubSymbol(r.pins, r.parts), ...(fp ? {footprint: stubFootprint(fp.n, fp.pads, fp.m3, fp.height)} : {}), ...(r.fpn ? {footprintName: r.fpn} : {}),
        stub: {kind: "altium", entry: r.n, assets: [r.asset, fp?.asset], files: [r.path], ...(fp ? {footprint: fp.path, footprintEntry: fp.n} : {})}});
    }
    for (const list of altFps.values()) for (const fp of list) {
      if (altUsed.has(fp)) continue;
      report.footprintOnly++;
      defs.push({id: hid(libId, "altium-fp", fp.path + ":" + fp.n), name: fp.n, prefix: "U", value: fp.n, category: "Imported components", description: "", parameters: {}, state: "draft",
        footprint: stubFootprint(fp.n, fp.pads, fp.m3, fp.height), stub: {kind: "altium", entry: "", assets: [fp.asset], files: [], footprint: fp.path, footprintEntry: fp.n}});
    }
    report.components = defs.length;
    const digests = Object.fromEntries(Object.entries(files).map(([path, f]) => [path, f.sha256]));
    return {digests, ...(nestedFamilies.length ? {componentFamilies: nestedFamilies} : {}), id: libId, name: folder.name || meta?.n || "Library folder", description: meta?.d || "", path: folder.root || "", kind: "folder", folder: folder.id, readOnly: !folder.writable,
      defs, report, notices, installation: installationRoot(root)};
  }
  function atriumStub(r, path) {
    return {id: r.id, rev: r.rev, name: r.n, prefix: r.ref || "U", value: r.val, category: r.cat, description: r.d, parameters: r.params || {},
      ...(r.pkg ? {package: r.pkg} : {}), ...heightFields(r.height),
      ...(r.pins ? {symbol: stubSymbol(r.pins, r.parts)} : {}), ...(r.pads ? {footprint: stubFootprint(r.fpn, r.pads, r.m3, r.fpHeight)} : {}),
      stub: {kind: "atrium", entry: r.id, files: [path], hash: r.hash}};
  }

  // ------------------------------------------------------------------ materialise (stub -> complete definition)
  const needs = stub => [...new Set([...(stub?.stub?.files || []), ...(stub?.stub?.footprint ? [stub.stub.footprint] : [])])];
  function parseFile(path, bytes, expected) {
    const digest = sha(bytes);
    if (expected && expected !== digest) throw Error(base(path) + " changed after indexing. Rescan the library folder.");
    const kind = classify(path);
    let data;
    if (kind === "schlib" || kind === "pcblib") {
      const defs = globalThis.AtriumIO.read(base(path), bytes).library || [];
      data = new Map(defs.map(d => [kind === "pcblib" ? d.footprint?.name || d.name : d.name, d]));
    } else if (kind === "atrlib") {
      data = new Map(Lib().readLibraryFile(decode(bytes), base(path)).defs.map(d => [d.id, d]));
    } else if (kind === "component") {
      const def = Lib().scrub(JSON.parse(decode(bytes)));
      data = new Map([[def.id, def]]);
    } else if (kind === "kicad-sym") {
      data = KI().parseSymbols(bytes, {file: path, path}).entries;
    } else data = bytes;
    return {data, digest, size: bytes.length};
  }
  const origins = new WeakMap();
  function descriptor(lib, def) {
    return def.stub || origins.get(def) || findEntry(lib, def.id)?.stub;
  }
  function revision(lib, def) {
    const s = descriptor(lib, def);
    if (!s || !lib?.digests) return null;
    if (s.hash) return s.hash;
    const memo = session(lib).revisions ||= new WeakMap();
    if (memo.has(s)) return memo.get(s);
    const paths = needs({stub: s});
    const assets = s.assets?.[0] ? [...s.assets, ...(s.kind === "kicad" && s.footprint ? [lib.digests[s.footprint]] : [])] :
      paths.map(p => lib.digests[p]);
    const credits = s.kind === "kicad" ? [
      lib.attribution?.symbols || folderCredit(lib, s.files[0], "symbols"),
      lib.attribution?.footprints || folderCredit(lib, s.footprint, "footprints")
    ] : [];
    const hash = sha(JSON.stringify([s, assets, credits]));
    memo.set(s, hash); return hash;
  }
  function matchesProvenance(lib, def, row) {
    const s = row.stub, src = def.source;
    if (!src || !lib.digests || !["altium", "kicad"].includes(s.kind) || s.files.length > 1) return false;
    const sym = s.files[0], fp = s.footprint, primary = sym || fp;
    const symKind = s.kind === "altium" ? "altium-schlib" : "kicad-symbol";
    const fpKind = s.kind === "altium" ? "altium-pcblib" : "kicad-footprint";
    if (!primary || src.kind !== (sym ? symKind : fpKind) || src.entry !== (s.entry || s.footprintEntry) ||
        src.file !== base(primary) || src.sha256 !== lib.digests[primary]) return false;
    if (sym && (!!fp !== !!src.footprint || fp && (src.footprint.file !== base(fp) ||
        src.footprint.sha256 !== lib.digests[fp] || src.footprint.entry !== (s.footprintEntry || s.footprintLibrary + ":" + row.footprint?.name)))) return false;
    // Old copies do not carry the source generation; prove attribution as well as bytes.
    if (s.kind === "kicad") {
      const credit = (path, side, recorded) => {
        const notice = lib.attribution?.[side] || folderCredit(lib, path, side);
        return Store().canonical(recorded || null) === Store().canonical(notice ? {...notice, modified: true} : null);
      };
      if (sym && !credit(sym, "symbols", src.attribution) ||
          fp && !credit(fp, "footprints", (sym ? src.footprint : src).attribution)) return false;
    }
    return true;
  }
  function materialise(stub, files, attribution = {}, library) {
    const parsed = new Map();
    for (const path of needs(stub)) {
      if (!files.has(path)) throw Error("The library file " + path + " is not available.");
      parsed.set(path, parseFile(path, asBytes(files.get(path)), library?.digests?.[path]));
    }
    return buildDefinition(stub, parsed, attribution, library);
  }
  function buildDefinition(stub, files, attribution = {}, library) {
    const s = stub.stub, get = p => files.get(p).data, sha256 = p => files.get(p).digest;
    let def;
    if (s.kind === "atrium") {
      const [path] = s.files;
      def = get(path).get(s.entry);
      if (!def || def.id !== s.entry) throw Error("The component " + stub.name + " is no longer in " + path + ".");
    } else if (s.kind === "kicad") {
      const K = KI(), fp = s.footprint ? K.readFootprint(get(s.footprint), {file: s.footprint, path: s.footprint, library: s.footprintLibrary, sha256: sha256(s.footprint)}).def : null;
      if (!s.files.length) def = fp;
      else {
        const entries = [], [lib, name] = [s.entry.slice(0, s.entry.lastIndexOf(":")), s.entry.slice(s.entry.lastIndexOf(":") + 1)];
        for (const p of s.files) for (const e of get(p)) entries.push({entry: e, file: {name: p, sha256: sha256(p)}, parentOnly: e.name !== name});
        const built = K.buildLibraries(new Map([[lib, entries]])).symbols.find(x => x.name === name);
        if (!built) throw Error("The symbol " + s.entry + " could not be read.");
        const fpLib = built.footprint.includes(":") ? built.footprint.slice(0, built.footprint.lastIndexOf(":")) : "";
        if (fp && fpLib) fp.source.entry = fpLib + ":" + fp.name;
        def = fp ? K.join([built], [{def: fp, library: fpLib, file: {name: s.footprint}}], {footprints: false}).library[0] : built.def;
      }
      def.source = Lib().portableSource(def, {
        symbols: attribution.symbols || folderCredit(library, s.files[0], "symbols"),
        footprints: attribution.footprints || folderCredit(library, s.footprint, "footprints")
      });
    } else if (s.kind === "altium") {
      const P = globalThis.AtriumLibraryImportAltium, IO = globalThis.AtriumIO;
      if (!P || !IO) throw Error("Altium library reading is not loaded.");
      const input = needs(stub).map(p => {
        const entry = get(p).get(p === s.footprint ? s.footprintEntry : s.entry);
        return {name: base(p), sha256: sha256(p), library: entry ? [entry] : []};
      });
      const {library} = P.pair(input);
      def = s.entry ? library.find(d => d.source?.entry === s.entry && d.symbol) : library.find(d => d.footprint && !d.symbol && (d.footprint.name || d.name) === s.footprintEntry);
      if (!def) throw Error("The component " + stub.name + " could not be read.");
    }
    if (!def) throw Error("The component " + stub.name + " could not be read.");
    def = JSON.parse(JSON.stringify(def));
    def.id = stub.id;
    if (Number.isInteger(stub.rev)) def.rev = stub.rev;
    origins.set(def, s);
    return def;
  }

  // ------------------------------------------------------------------ providers
  // A provider lists [{path, size, mtime, tag?}] (paths with "/") and reads one file's bytes.
  function memory(map) {
    return {kind: "memory", reads: 0,
      async list() { return [...map].map(([path, f]) => ({path, size: asBytes(f.data).length, mtime: f.mtime || 0})); },
      async read(path) { this.reads++; const f = map.get(path); if (!f) throw Error("Missing " + path); return asBytes(f.data); }};
  }
  // ZIP archives (the downloaded KiCad libraries): the central directory is the listing; an entry is
  // inflated only when read. The leading "repo-<sha>/" folder is dropped.
  function zipEnd(bytes, prefix) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (v.getUint32(i, true) === 0x06054b50)
      return {count: v.getUint16(i + 10, true), size: v.getUint32(i + 12, true), offset: v.getUint32(i + 16, true)};
    throw Error(prefix + " is not a ZIP archive.");
  }
  function zipDirectory(prefix, bytes, count, source, entries, notices) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), dec = new TextDecoder("utf-8");
    let p = 0;
    for (let k = 0; k < count && entries.size <= LIMITS.files; k++) {
      if (p + 46 > bytes.length || v.getUint32(p, true) !== 0x02014b50) throw Error(prefix + ": the ZIP directory is damaged.");
      const method = v.getUint16(p + 10, true), time = v.getUint16(p + 12, true), date = v.getUint16(p + 14, true), crc = v.getUint32(p + 16, true);
      const csize = v.getUint32(p + 20, true), size = v.getUint32(p + 24, true), nl = v.getUint16(p + 28, true), el = v.getUint16(p + 30, true), cl = v.getUint16(p + 32, true), local = v.getUint32(p + 42, true);
      const raw = dec.decode(bytes.subarray(p + 46, p + 46 + nl));
      p += 46 + nl + el + cl;
      if (raw.endsWith("/") || /(^|\/)\.\.(\/|$)/.test(raw) || raw.startsWith("/")) continue;
      const rel = raw.includes("/") ? raw.slice(raw.indexOf("/") + 1) : raw, path = prefix + "/" + rel;
      const mtime = Date.UTC(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2);
      const entry = {source, method, csize, size, local, path, mtime, tag: crc.toString(16) + ":" + size};
      if (rel === "LICENSE.md") notices.set(prefix, {...entry, ref: /-([a-f0-9]{40})$/.exec(raw.split("/")[0])?.[1] || "master"});
      if (classify(path)) entries.set(path, entry);
    }
  }
  // Persisted archive Blobs support random access. A preview reads a central directory once
  // per source and just the selected compressed members, without copying both archives to a worker.
  function archiveProvider(blobs) {
    let opened;
    const slice = async (source, start, end) => new Uint8Array(await source.slice(start, end).arrayBuffer());
    const open = () => opened ||= (async () => {
      const entries = new Map(), notices = new Map();
      for (const [prefix, blob] of Object.entries(blobs)) {
        const tail = await slice(blob, Math.max(0, blob.size - 65557), blob.size);
        const {count, size, offset} = zipEnd(tail, prefix);
        if (offset + size > blob.size || size > (64 << 20)) throw Error(prefix + ": the ZIP directory is damaged.");
        zipDirectory(prefix, await slice(blob, offset, offset + size), count, blob, entries, notices);
      }
      return {entries, notices};
    })().catch(e => { opened = null; throw e; });
    async function read(e, path, cap) {
      if (!e) throw Error("Missing " + path);
      if (e.size > cap || e.csize > cap + (64 << 10)) throw Error(base(path) + " is too large for a library file.");
      const header = await slice(e.source, e.local, e.local + 30), v = new DataView(header.buffer, header.byteOffset, header.byteLength);
      if (header.length !== 30 || v.getUint32(0, true) !== 0x04034b50) throw Error("The ZIP entry " + path + " is damaged.");
      const start = e.local + 30 + v.getUint16(26, true) + v.getUint16(28, true);
      const raw = await slice(e.source, start, start + e.csize);
      if (raw.length !== e.csize) throw Error("The ZIP entry " + path + " is damaged.");
      if (e.method === 0 && e.csize === e.size) return raw;
      if (e.method === 8) return globalThis.AtriumImportFormats.inflate(raw, e.size, e.size);
      throw Error("Unsupported ZIP compression in " + path + ".");
    }
    return {kind: "zip", workerData: {kind: "zip", blobs},
      async list() {
        return Array.from((await open()).entries, ([path, e]) => ({path, size: e.size, mtime: e.mtime, tag: e.tag}));
      },
      async read(path) { return read((await open()).entries.get(path), path, LIMITS[classify(path)] || LIMITS.component); },
      async notices() {
        const {notices} = await open(), credits = {};
        for (const kind of ["symbols", "footprints"]) {
          const e = notices.get(kind);
          if (!e) throw Error("The KiCad " + kind + " archive is missing its licence notice.");
          const bytes = await read(e, e.path, 64 << 10);
          credits[kind] = Lib().kiCadCredit(kind, new TextDecoder("utf-8", {fatal: true}).decode(bytes), e.ref);
        }
        return credits;
      }};
  }
  // <input type=file webkitdirectory>: a snapshot of the folder; Rescan picks it again.
  async function readBrowserFile(path, file) {
    const cap = LIMITS[classify(path)] || LIMITS.component;
    if (file.size > cap) throw Error(base(path) + " is too large for a library file.");
    return new Uint8Array(await file.arrayBuffer());
  }
  function fileList(files, paths) {
    const byPath = new Map(paths || []);
    for (const f of files) { const rel = String(f.webkitRelativePath || f.name), path = rel.includes("/") ? rel.slice(rel.indexOf("/") + 1) : rel; if (classify(path)) byPath.set(path, f); }
    return {kind: "files", reads: 0, workerData: {kind: "files", files: [...byPath]},
      async list() { return [...byPath].map(([path, f]) => ({path, size: f.size, mtime: f.lastModified || 0})); },
      async read(path) { this.reads++; return readBrowserFile(path, byPath.get(path)); }};
  }
  // File System Access API (Chromium): a folder handle the user granted; stays readable across sessions.
  function directoryHandle(root) {
    const handles = new Map();
    async function walk(dir, prefix, depth, out) {
      if (depth > LIMITS.depth || out.length > LIMITS.files) return;
      for await (const [name, h] of dir.entries()) {
        const path = prefix ? prefix + "/" + name : name;
        if (h.kind === "directory") { if (!SKIP_DIR.test(name)) await walk(h, path, depth + 1, out); }
        else if (classify(path)) { const f = await h.getFile(); handles.set(path, h); out.push({path, size: f.size, mtime: f.lastModified || 0}); }
      }
    }
    return {kind: "directory", reads: 0, handle: root, writable: true,
      async list() { const out = []; handles.clear(); await walk(root, "", 0, out); return out; },
      async read(path) {
        this.reads++;
        let handle = handles.get(path);
        if (!handle) {
          if (!classify(path) || path.split("/").some(p => !p || p === "." || p === ".." || p.includes("\\"))) throw Error("Invalid library path.");
          const parts = path.split("/"); let dir = root;
          for (const name of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(name);
          handle = await dir.getFileHandle(parts.at(-1));
        }
        return readBrowserFile(path, await handle.getFile());
      },
      async write(path, text) {
        const parts = path.split("/"); let dir = root;
        for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d, {create: true});
        const w = await (await dir.getFileHandle(parts[parts.length - 1], {create: true})).createWritable();
        await w.write(text); await w.close();
      }};
  }
  function nativeFolder(grant, writable) {
    const host = globalThis.AtriumHost;
    const readBatch = paths => host.libraryFolderRead(grant, paths);
    return {kind: "native", writable, async list() {
      const {root, entries} = await host.libraryFolderList(grant);
      this.rootPath = root; return entries;
    }, readBatch,
      async read(path) {
        const [file] = await readBatch([path]);
        if (!file?.data) { if (file?.data === "") return new Uint8Array(); throw Error(file?.error || "File could not be read."); }
        return b64(file.data);
      },
      ...(writable ? {write: (path, text) => host.libraryFolderWrite(grant, path, text)} : {})};
  }
  // ------------------------------------------------------------------ scan driver (worker and headless)
  const now = () => (globalThis.performance?.now ? performance.now() : Date.now());
  const pause = () => new Promise(r => setTimeout(r, 0));
  const stopped = () => Object.assign(Error("The library scan was stopped."), {name: "AbortError"});
  const check = signal => { if (signal?.aborted) throw stopped(); };
  const prepare = lib => {
    if (globalThis.AtriumCatalogue) lib.search = AtriumCatalogue.prepare(lib.defs, globalThis.AtriumComponentFamilies?.memberships(lib));
    return lib;
  };
  async function refresh(folder, provider, o = {}) {
    const t0 = now(), checkAbort = () => check(o.signal);
    let saved = o.index === undefined ? await o.cache?.get(folder.id, provider && o.reuse || undefined) : o.index;
    checkAbort();
    const listing = provider ? (await provider.list()).filter(f => classify(f.path)) : null;
    const attribution = provider && folder.kind === "zip" && folder.id === "kicad-official" && provider.notices ? await provider.notices() : undefined;
    if (saved?.stampsOnly && saved.generation === o.reuse && listing) {
      const {read, removed, unchanged} = plan(saved, listing);
      if (!read.length && !removed.length && saved.root === provider.rootPath && JSON.stringify(saved.attribution) === JSON.stringify(attribution)) {
        checkAbort();
        const stats = {listed: listing.length, read: 0, parsed: 0, same: 0, errors: 0, removed: 0, unchanged, ms: Math.round(now() - t0)};
        return {library: null, reuse: true, stats, cachedOK: true};
      }
      saved = await o.cache.get(folder.id);
    }
    // A previous derived index can still supply offline names and pins. A real rescan upgrades
    // its search projection from the source files before persisting the new schema.
    const upgrading = legacyIndex(saved) && obj(saved.files);
    const cached = usable(saved, !provider);
    // Never mutate the committed cache. A cancelled or superseded scan can stop at any read.
    const index = {...cached, files: {...cached.files}};
    checkAbort();
    if (!provider) {
      const lib = prepare(assemble(folder, index, index.root));
      if (index.attribution) lib.attribution = index.attribution;
      lib.indexGeneration = indexGeneration(index);
      lib.offline = true;
      return {library: lib, index, stats: null, cachedOK: true};
    }
    index.root = provider.rootPath;
    if (attribution) index.attribution = attribution;
    const p = plan(index, listing), stats = {listed: listing.length, read: 0, parsed: 0, same: 0, errors: 0, removed: p.removed.length, unchanged: p.unchanged, ms: 0};
    removeFiles(index.files, p.removed);
    // Table nicknames are available before rendering any partial results.
    const tables = p.read.filter(x => ["kicad-table", "library-notice"].includes(classify(x)));
    if (tables.length) {
      const first = new Set(tables);
      p.read = tables.concat(p.read.filter(x => !first.has(x)));
    }
    if (p.read.some(x => /\.(schlib|pcblib)$/i.test(x))) {
      if (o.loadAltium) o.loadAltium();
      else if (!globalThis.AtriumLibraryImportAltium && globalThis.AtriumLazy) await AtriumLazy.need("AtriumImport");
    }
    const total = p.read.length;
    o.progress?.({phase: "read", done: 0, total});
    const byPath = new Map(listing.map(f => [f.path, f]));
    const snapshot = () => {
      const lib = prepare(assemble(folder, index, provider.rootPath));
      if (attribution) lib.attribution = attribution;
      return lib;
    };
    let lastProgress = now(), nextPartial = Math.min(400, Math.max(1, Math.floor(total / 2)));
    for (let i = 0; i < total;) {
      checkAbort();
      const start = i;
      let chunk;
      if (provider.readBatch) {
        let size = 0;
        do { size += byPath.get(p.read[i++]).size || 0; }
        while (i < total && i - start < 64 && size + (byPath.get(p.read[i]).size || 0) <= (2 << 20));
        chunk = await provider.readBatch(p.read.slice(start, i));
      } else {
        const path = p.read[i++];
        try { chunk = [await provider.read(path)]; } catch (e) { chunk = [{error: e?.message || String(e)}]; }
      }
      checkAbort();
      for (let j = start; j < i; j++) {
        const path = p.read[j], bytes = chunk[j - start], entry = byPath.get(path);
        if (!bytes || bytes.error) {
          index.files[path] = {...entry, kind: classify(path), rows: [], temporary: true, error: str(bytes?.error || "File could not be read.", 300)};
          stats.errors++;
          continue;
        }
        stats.read++;
        const r = ingest(index, entry, typeof bytes.data === "string" ? b64(bytes.data) : bytes);
        stats[r === "parsed" ? "parsed" : r === "same" ? "same" : "errors"]++;
      }
      const elapsed = now() - lastProgress;
      if (elapsed > (o.worker ? 150 : 12)) {
        o.progress?.({phase: "read", done: i, total});
        lastProgress = now();
        if (!o.worker) await pause();
      }
      if (o.partial && i < total && i >= nextPartial) {
        // Use of the current index is optional, so a partial scan need not rebuild it at every update.
        o.partial(snapshot());
        nextPartial = Math.max(i * 6, nextPartial * 6);
      }
    }
    checkAbort();
    o.progress?.({phase: "prepare", done: total, total});
    const reuse = !!o.reuse && o.reuse === indexGeneration(cached) && provider && !stats.read && !stats.removed && !stats.errors &&
      cached.root === index.root && JSON.stringify(cached.attribution) === JSON.stringify(index.attribution);
    const lib = reuse ? null : snapshot();
    checkAbort();
    stats.ms = Math.round(now() - t0);
    if (lib) lib.stats = stats;
    const metadataChanged = cached.root !== index.root || JSON.stringify(cached.attribution) !== JSON.stringify(index.attribution);
    const cachedOK = o.cache && (upgrading || stats.read || stats.removed || stats.errors || metadataChanged)
      ? await o.cache.set(folder.id, index, upgrading ? saved : cached, p.read, p.removed, o.signal) : true;
    checkAbort();
    if (cachedOK === false && index.sessionGeneration === cached.sessionGeneration) index.sessionGeneration = globalThis.Atrium.id();
    if (lib) lib.indexGeneration = indexGeneration(index);
    return {library: lib, index, stats, reuse, cachedOK};
  }

  // ------------------------------------------------------------------ registry (browser and desktop)
  // Kept in this browser profile: only {id, name, kind, root, writable}, never component data.
  const KEY = "atrium.library-folders.v1";
  const state = {libraries: new Map(), providers: new Map(), indexes: new Map(), listeners: new Set(), jobs: new Map()};
  const liveLibraries = new WeakMap();
  function folders() {
    try { const v = JSON.parse(globalThis.localStorage?.getItem(KEY) || "[]"); return Array.isArray(v) ? v.filter(f => obj(f) && typeof f.id === "string" && typeof f.name === "string") : []; } catch { return []; }
  }
  const saveFolders = list => { try { globalThis.localStorage?.setItem(KEY, JSON.stringify(list.map(f => ({id: f.id, name: str(f.name, 200), kind: f.kind, root: str(f.root, 1024), libraryId: f.libraryId, grant: f.grant, writable: !!f.writable, added: f.added})))); return true; } catch { return false; } };
  function addFolder(rec) {
    const list = folders().filter(f => f.id !== rec.id);
    list.push({added: new Date().toISOString(), ...rec});
    saveFolders(list);
    emit();
    return rec;
  }
  async function removeFolder(id) {
    cancelScan(id);
    state.jobs.delete(id);
    const all = folders(), record = all.find(f => f.id === id);
    saveFolders(all.filter(f => f.id !== id));
    const source = state.libraries.get(id);
    if (source) session(source).removed = true;
    for (const [reader, lib] of resident) if (lib.folder === id) {
      reader.removed = true; evictReader(reader, lib);
    }
    state.libraries.delete(id); state.providers.delete(id); state.indexes.delete(id);
    emit();
    await Promise.all([db.deleteIndex(id), db.del("handles", id), db.del("archives", id)]);
    if (record?.grant) await globalThis.AtriumHost?.forgetLibraryFolder?.(record.grant);
  }
  const libraries = () => folders().map(f => {
    if (!state.libraries.has(f.id)) state.libraries.set(f.id, {...placeholder(f), unopened: true});
    return state.libraries.get(f.id);
  });
  const library = id => state.libraries.get(id) || [...state.libraries.values()].find(l => l.id === id) || null;
  const onChange = fn => { state.listeners.add(fn); return () => state.listeners.delete(fn); };
  function emit(kind, id) { for (const fn of state.listeners) { try { fn(kind, id); } catch { /* listener */ } } }
  // IndexedDB: the index cache, granted folder handles and downloaded archives (outside every repository).
  const db = (() => {
    let open = null;
    const connect = () => open ||= new Promise((resolve, reject) => {
      if (!globalThis.indexedDB) { reject(Error("IndexedDB is unavailable.")); return; }
      const r = indexedDB.open("atrium-library-sources", 1);
      r.onupgradeneeded = () => { for (const s of ["index", "handles", "archives"]) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s); };
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); open = null; };
        resolve(db);
      };
      r.onerror = () => reject(r.error);
    });
    const run = (store, mode, fn) => connect().then(d => new Promise((resolve, reject) => { const tx = d.transaction(store, mode), q = fn(tx.objectStore(store)); tx.oncomplete = () => resolve(q?.result); tx.onabort = () => reject(tx.error); }));
    // A single transaction publishes the new head and only the changed file rows. The old
    // single-value index remains readable and is replaced on the next successful scan.
    const range = id => IDBKeyRange.bound([id], [id, []]);
    async function readIndex(id, currentGeneration, local) {
      let db;
      try { db = await connect(); } catch { return local; }
      return new Promise((resolve, reject) => {
        const tx = db.transaction("index"), st = tx.objectStore("index"), head = st.get(id);
        let index;
        head.onsuccess = () => {
          const meta = head.result;
          if (local && (!meta || meta.generation === local.generation && meta.version === local.version)) { index = local; return; }
          if (local && state.indexes.get(id) === local) state.indexes.delete(id);
          if (!meta?.generation || (meta.version !== 2 && meta.version !== INDEX_VERSION)) { index = meta; return; }
          const files = {}, stampsOnly = currentGeneration === meta.generation;
          index = {...meta, files, ...(stampsOnly ? {stampsOnly: true} : {})};
          const blocks = new Map();
          // Numeric second keys hold immutable row blocks. String keys hold file stamps.
          const paths = st.openCursor(IDBKeyRange.bound([id, stampsOnly ? "" : 0], [id, []]));
          paths.onsuccess = () => {
            const cursor = paths.result;
            if (!cursor) return;
            const [, key, hash] = cursor.key, file = cursor.value;
            if (key === 0) blocks.set(hash, file);
            else {
              if (!stampsOnly && file.rowsHash && !file.rows) {
                file.rows = blocks.get(file.rowsHash);
                if (!Array.isArray(file.rows)) { tx.abort(); return; }
              }
              files[key] = file;
            }
            cursor.continue();
          };
        };
        tx.oncomplete = () => resolve(index);
        tx.onabort = () => reject(tx.error || Error("Reading the library index was interrupted."));
      });
    }
    async function writeIndex(id, index, old, changed, removed, signal) {
      let db;
      try { db = await connect(); } catch { return false; }
      check(signal);
      return new Promise((resolve, reject) => {
        const tx = db.transaction("index", "readwrite"), st = tx.objectStore("index"), head = st.get(id);
        const cancel = () => { try { tx.abort(); } catch { /* transaction already finished */ } };
        signal?.addEventListener("abort", cancel, {once: true});
        const release = () => signal?.removeEventListener("abort", cancel);
        let conflict = false;
        const generation = globalThis.Atrium.id();
        head.onsuccess = () => {
          if (head.result?.version > INDEX_VERSION || head.result?.generation !== old.generation) { conflict = true; tx.abort(); return; }
          // A previous commit may have stayed in memory when disk space was full. Its
          // incoming delta is based on those session rows, so republish every row on recovery.
          const {files: patch, sessionGeneration, ...meta} = index;
          const full = !old.generation || old.version !== meta.version || !!sessionGeneration;
          const files = full && old.version === meta.version ? mergeFiles(old.files, patch, removed) : patch;
          if (full) st.delete(range(id));
          const previous = new Set(full ? [] : Object.values(old.files).map(f => f.rowsHash).filter(Boolean));
          const live = new Set(Object.values(files).map(f => f.rowsHash).filter(Boolean));
          if (!full) {
            const replaced = new Set([...changed, ...removed]);
            for (const [path, file] of Object.entries(old.files)) if (!replaced.has(path) && file.rowsHash) live.add(file.rowsHash);
          }
          for (const hash of previous) if (!live.has(hash)) st.delete([id, 0, hash]);
          for (const path of full ? [] : removed) st.delete([id, path]);
          for (const path of full ? Object.keys(files) : changed) {
            const {rows, ...file} = files[path];
            if (file.rowsHash && !previous.has(file.rowsHash)) {
              st.put(rows, [id, 0, file.rowsHash]); previous.add(file.rowsHash);
            }
            // A transient/unreadable file has no reusable projection.
            st.put(file.rowsHash ? file : {...file, rows}, [id, path]);
          }
          st.put({...meta, generation}, id);
        };
        tx.oncomplete = () => { release(); delete index.sessionGeneration; index.generation = generation; resolve(true); };
        tx.onabort = () => {
          release();
          if (signal?.aborted) reject(stopped());
          else if (conflict) reject(Error("Another window changed this library index. Rescan to use the newer revision."));
          else resolve(false); // A full store still allows the scanned folder to be used in this session.
        };
      });
    }
    async function deleteIndex(id) {
      try { await connect(); } catch { return; }
      return run("index", "readwrite", st => { st.delete(id); return st.delete(range(id)); });
    }
    return {readIndex, writeIndex, deleteIndex, get: (s, k) => run(s, "readonly", st => st.get(k)).catch(() => undefined),
      set: (s, k, v) => run(s, "readwrite", st => st.put(v, k)).then(() => true, () => false),
      del: (s, k) => run(s, "readwrite", st => st.delete(k)).catch(() => undefined)};
  })();
  const cache = {get: (id, generation) => db.readIndex(id, generation, state.indexes.get(id)),
    async set(id, index, old, changed, removed, signal) {
      const saved = await db.writeIndex(id, index, old, changed, removed, signal);
      check(signal);
      if (saved) state.indexes.delete(id);
      else {
        if (old.version === index.version) index.files = mergeFiles(old.files, index.files, removed);
        index.sessionGeneration = globalThis.Atrium.id();
        state.indexes.set(id, index);
      }
      return saved;
    }};
  // The provider for a registered folder, restored from what this browser kept.
  async function providerFor(folder) {
    if (state.providers.has(folder.id)) return state.providers.get(folder.id);
    let p = null;
    if (folder.kind === "directory") {
      const h = await db.get("handles", folder.id);
      if (h && (await h.queryPermission?.({mode: "read"})) === "granted") p = directoryHandle(h);
    } else if (folder.kind === "zip") {
      const saved = await db.get("archives", folder.id);
      if (obj(saved)) p = archiveProvider(saved.blobs || saved);
    } else if (folder.kind === "native" && folder.grant && globalThis.AtriumHost?.libraryFolderList) {
      p = nativeFolder(folder.grant, folder.writable);
    }
    return p;
  }
  // A worker owns ZIP decompression, hashing, parsing, assembly and the search preparation. A
  // directory provider that cannot travel to the worker supplies listings and batches on request.
  let workerStartFailed = false;
  function inWorker(folder, provider, o) {
    const W = globalThis.AtriumWorkerPool;
    if (workerStartFailed || !W?.script || typeof globalThis.Worker !== "function") return null;
    return new Promise((resolve, reject) => {
      let w;
      try { w = W.script("workers/library-scan-worker.js"); } catch { workerStartFailed = true; resolve(null); return; }
      let library, base = o.index, started = false;
      const files = {};
      // The editor owns the durable index even when a file-origin Blob worker has separate storage.
      const requests = {
        index: async generation => base = await cache.get(folder.id, generation),
        async commit(metadata, removed) {
          const index = {...metadata, files};
          await cache.set(folder.id, index, usable(base, true), Object.keys(files), removed, o.signal);
          const {generation, sessionGeneration} = index;
          return {generation, sessionGeneration};
        },
        list: async () => ({entries: await provider.list(), rootPath: provider.rootPath}),
        read: paths => provider.readBatch ? provider.readBatch(paths) : Promise.all(paths.map(async path => {
          try { return asBytes(await provider.read(path)).slice(); }
          catch (e) { return {error: e?.message || String(e)}; }
        }))
      };
      const end = (error, result) => {
        w.terminate();
        o.signal.removeEventListener("abort", cancel);
        if (error) reject(error); else resolve(result);
      };
      const cancel = () => end(stopped());
      o.signal.addEventListener("abort", cancel, {once: true});
      w.onerror = e => {
        if (started) { end(Error(e.message || "The library indexing worker stopped.")); return; }
        // A local file page may open a Blob worker but refuse its first importScripts.
        // It has issued no reads or writes. Resume the same scan on the page.
        e.preventDefault?.(); workerStartFailed = true; end(null, null);
      };
      w.onmessageerror = () => end(Error("The library indexing worker returned an unreadable result."));
      w.onmessage = async ({data: m}) => {
        started = true;
        if (o.signal.aborted) return;
        switch (m.type) {
          case "progress": o.progress(m.value); break;
          case "snapshot":
            library = {...m.library, defs: [], search: {...m.search, rows: []}};
            break;
          case "rows":
            library.defs.push(...m.defs);
            library.search.rows.push(...m.rows);
            break;
          case "indexFiles":
            for (const [path, stamp, rows] of m.files) {
              if (stamp) files[path] = {...stamp, rows};
              else files[path].rows.push(...rows);
            }
            break;
          case "partial": o.partial(library); break;
          case "done": end(null, {library: m.hasLibrary ? library : null, stats: m.stats, reuse: m.reuse, cachedOK: m.cachedOK}); break;
          case "error": end(Error(m.message)); break;
          default:
            if (!Object.hasOwn(requests, m.type)) return;
            try {
              const value = await requests[m.type](...m.args);
              if (!o.signal.aborted) w.postMessage({type: "reply", request: m.request, value},
                Array.isArray(value) ? value.filter(x => x instanceof Uint8Array).map(x => x.buffer) : []);
            } catch (e) {
              if (!o.signal.aborted) w.postMessage({type: "reply", request: m.request, error: e?.message || String(e)});
            }
            break;
        }
      };
      try { w.postMessage({type: "scan", folder, provider: provider?.workerData || (provider ? {kind: "bridge"} : null), reuse: o.reuse, index: base}); }
      catch (e) { end(e); }
    });
  }
  const placeholder = folder => ({id: folder.libraryId || folder.id, name: folder.name, path: folder.root || "",
    kind: "folder", folder: folder.id, readOnly: !folder.writable, defs: [], report: {errors: []}});
  function cancelScan(id) {
    const job = state.jobs.get(id);
    if (job) { job.abort.abort(); return true; }
    return false;
  }
  async function scan(folder, o = {}) {
    const priorJob = state.jobs.get(folder.id);
    cancelScan(folder.id);
    const previous = priorJob ? priorJob.previous : state.libraries.get(folder.id);
    const abort = new AbortController(), job = {abort, previous};
    const signal = abort.signal, cancelled = () => abort.abort();
    o.signal?.addEventListener("abort", cancelled, {once: true});
    if (o.signal?.aborted) cancelled();
    state.jobs.set(folder.id, job);
    const owns = () => state.jobs.get(folder.id) === job;
    let live = {...(previous || placeholder(folder)), scan: {phase: "list", done: 0, total: 0}};
    const update = () => { if (owns() && !signal.aborted) { state.libraries.set(folder.id, live); emit(); } };
    if (previous) liveLibraries.set(live, liveLibraries.get(previous) || {});
    update();
    try {
      check(signal);
      const provider = o.metadataOnly ? null : o.provider || await providerFor(folder);
      check(signal);
      const reuse = previous?.search && !previous.offline && !o.provider && previous.indexGeneration;
      const index = await cache.get(folder.id, provider && reuse || undefined) ?? null;
      check(signal);
      const scanning = {cache, signal, reuse, index,
        progress(p) { if (owns() && !signal.aborted) { live.scan = p; emit("progress", folder.id); o.progress?.(p); } },
        partial(lib) {
          live = {...lib, scan: live.scan};
          liveLibraries.set(live, {provider}); update();
        }
      };
      const r = await inWorker(folder, provider, scanning) || await refresh(folder, provider, scanning);
      check(signal);
      if (r?.reuse && previous) {
        r.library = {...previous, stats: r.stats}; delete r.library.scan;
        liveLibraries.set(r.library, liveLibraries.get(previous) || {provider});
      }
      if (r?.library) {
        if (!liveLibraries.has(r.library)) liveLibraries.set(r.library, {provider});
        if (provider) state.providers.set(folder.id, provider);
        if (!o.metadataOnly && r.library.id !== folder.id && folder.libraryId !== r.library.id) {
          const records = folders(), rec = records.find(f => f.id === folder.id);
          if (rec) { rec.libraryId = r.library.id; saveFolders(records); }
        }
        live = r.library;
        update();
      }
      return r;
    } catch (e) {
      if (owns()) {
        if (previous) state.libraries.set(folder.id, previous);
        else state.libraries.set(folder.id, {...placeholder(folder), offline: true, scanError: signal.aborted ? null : e.message});
        emit();
      }
      throw e;
    } finally {
      if (owns()) state.jobs.delete(folder.id);
      o.signal?.removeEventListener("abort", cancelled);
    }
  }
  async function scanAll(o = {}) { const out = []; for (const f of folders()) {
    if (o.signal?.aborted) break;
    if (state.jobs.has(f.id) || o.restoring && state.libraries.get(f.id)?.stats) continue;
    try { out.push(await scan(f, o)); } catch (e) { out.push({error: e?.message || String(e), folder: f.id}); }
  } return out; }
  // Open the persisted catalogue on demand, without listing a folder or opening an archive.
  function openMetadata(id) {
    const rec = folders().find(f => f.id === id || f.libraryId === id);
    if (rec && state.libraries.get(rec.id)?.unopened && !state.jobs.has(rec.id)) return scan(rec, {metadataOnly: true});
  }
  function session(lib) {
    let entry = liveLibraries.get(lib);
    if (!entry) liveLibraries.set(lib, entry = {});
    return entry;
  }
  function findEntry(lib, id, legacyHash) {
    const entry = session(lib);
    if (!entry.positions) {
      entry.positions = new Map();
      entry.aliases = new Map();
      lib.defs.forEach((d, i) => {
        entry.positions.set(d.id, i);
        const s = d.stub || origins.get(d);
        if (s?.kind === "atrium" && s.entry !== d.id) {
          const key = s.entry + "|" + s.hash;
          entry.aliases.set(key, entry.aliases.has(key) ? -1 : i);
        }
      });
    }
    const i = entry.positions.get(id) ?? entry.aliases.get(id + "|" + legacyHash);
    return lib.defs[i];
  }
  // Metadata remains searchable when a source's parsed files and component bodies leave memory.
  // Keep a process-wide working set, including when users move through many registered folders.
  const resident = new Map();
  function evictReader(reader, lib) {
    resident.delete(reader);
    for (const [at, stored] of reader.bodies || []) lib.defs[at] = stored.stub;
    reader.bodies?.clear(); reader.files?.clear(); reader.bytes = 0; reader.bodyBytes = 0;
  }
  function retainReader(reader, lib) {
    resident.delete(reader); resident.set(reader, lib);
    let bytes = 0;
    for (const entry of resident.keys()) bytes += (entry.bytes || 0) + (entry.bodyBytes || 0);
    for (const [entry, source] of resident) {
      if (resident.size <= 4 && bytes <= (48 << 20)) break;
      bytes -= (entry.bytes || 0) + (entry.bodyBytes || 0);
      evictReader(entry, source);
    }
  }
  function fileFor(entry, lib, provider, path) {
    if (entry.removed) throw Error("The library folder was removed.");
    const files = entry.files ||= new Map(), pending = entry.reads ||= new Map();
    const hit = files.get(path);
    if (hit) { files.delete(path); files.set(path, hit); retainReader(entry, lib); return Promise.resolve(hit); }
    if (!pending.has(path)) pending.set(path, (async () => {
      const bytes = asBytes(await provider.read(path));
      if (entry.removed) throw Error("The library folder was removed.");
      const file = parseFile(path, bytes, lib.digests?.[path]);
      // Bound parsed input by count and source bytes. Large files live only for the active requests.
      if (file.size <= (24 << 20)) {
        entry.bytes = (entry.bytes || 0) + file.size;
        files.set(path, file);
        while (entry.bytes > (24 << 20) || files.size > 32) {
          const first = files.keys().next().value;
          entry.bytes -= files.get(first).size; files.delete(first);
        }
        retainReader(entry, lib);
      }
      return file;
    })().finally(() => pending.delete(path)));
    return pending.get(path);
  }
  // One promise per immutable row in a source generation. Eviction restores its searchable row.
  function load(lib, id) {
    const stub = findEntry(lib, id), entry = session(lib);
    if (entry.removed) return Promise.reject(Error("The library folder was removed."));
    if (!stub?.stub) {
      if (stub && resident.has(entry)) retainReader(entry, lib);
      return Promise.resolve(stub || null);
    }
    const pending = entry.loaded ||= new Map();
    if (!pending.has(id)) pending.set(id, (async () => {
      const provider = entry.provider || state.providers.get(lib.folder) || await providerFor(folders().find(f => f.id === lib.folder) || {});
      if (!provider) throw Error("Rescan " + lib.name + " to read its files again.");
      entry.provider = provider;
      if (stub.stub.kind === "altium" && !globalThis.AtriumLibraryImportAltium && globalThis.AtriumLazy) await AtriumLazy.need("AtriumImport");
      const parsed = new Map();
      for (const path of needs(stub)) parsed.set(path, await fileFor(entry, lib, provider, path));
      const def = buildDefinition(stub, parsed, lib.attribution, lib);
      const slots = entry.bodies ||= new Map(), at = entry.positions.get(id);
      const size = JSON.stringify(def).length * 2;
      // A body larger than the cache is returned to its caller but does not pin a file.
      if (size <= (8 << 20)) {
        slots.set(at, {stub, size});
        entry.bodyBytes = (entry.bodyBytes || 0) + size;
        lib.defs[at] = def;
        while (slots.size > 32 || entry.bodyBytes > (8 << 20)) {
          const first = slots.keys().next().value, old = slots.get(first);
          lib.defs[first] = old.stub; entry.bodyBytes -= old.size; slots.delete(first);
        }
        retainReader(entry, lib);
      }
      return def;
    })().finally(() => pending.delete(id)));
    return pending.get(id);
  }
  // Save one component into a writable folder as components/<slug>-<id>.json (only on an explicit Save).
  let writeQueue = Promise.resolve();
  function save(lib, def, project, current) {
    const write = () => saveReviewed(lib, def, project, current);
    if (globalThis.navigator?.locks?.request) return navigator.locks.request("waffle-library-folder-writes", write);
    const result = writeQueue.then(write); writeQueue = result.catch(() => {}); return result;
  }
  async function saveReviewed(lib, def, project, current) {
    const folder = folders().find(f => f.id === lib.folder), provider = folder && await providerFor(folder) || state.providers.get(lib.folder);
    if (!provider?.write) throw Error(lib.name + " cannot be written from here. Choose a folder you allowed Waffle to change.");
    const slug = String(def.name || "component").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "component";
    const libraryRef = def.libraryRef;
    const entry = Lib().portableDefinition(project, def);
    if (Lib().sameLibrary(lib, libraryRef)) entry.id = libraryRef.id;
    let old = findEntry(lib, entry.id, libraryRef?.hash);
    // A portable archive or foreign library is read-only. Saving that project component
    // to the folder creates/updates its loose Waffle definition under the project ID.
    if (old && !/^components\/[^/]+\.json$/i.test(descriptor(lib, old)?.files?.[0] || "")) {
      entry.id = def.id; old = findEntry(lib, entry.id);
      if (old && !/^components\/[^/]+\.json$/i.test(descriptor(lib, old)?.files?.[0] || "")) throw Error("Choose a different library folder for this component.");
    }
    const check = Lib().validateDef(entry, {footprintWarnings: false});
    if (!check.ok) throw Error(check.errors[0]);
    const was = Number.isInteger(old?.rev) ? old.rev : 0, oldHash = old ? old.stub?.hash || Lib().defHash(old) : null;
    entry.rev = !old ? 1 : oldHash === Lib().defHash(entry) ? was || 1 : (was || 1) + 1;
    const previousPath = (old && descriptor(lib, old))?.files?.[0];
    const id = /^[A-Za-z0-9_-]{1,64}$/.test(entry.id) ? entry.id : hid(entry.id);
    const path = /^components\/[^/]+\.json$/i.test(previousPath || "") ? previousPath : "components/" + slug + "-" + id + ".json";
    const stillCurrent = () => (!current || current()) && state.libraries.get(lib.folder) === lib && !lib.scan;
    const stale = () => Error("The component or library changed. Reopen Save to folder to review the current revision.");
    if (!stillCurrent()) throw stale();
    const expected = lib.digests?.[path];
    if (expected) {
      const actual = await provider.read(path);
      if (sha(asBytes(actual)) !== expected) throw stale();
    } else if ((await provider.list()).some(f => f.path === path)) throw stale();
    if (!stillCurrent()) throw stale();
    if (expected && entry.rev === was) return {path, rev: was, unchanged: true};
    await provider.write(path, Store().serialise(entry));
    await scan(folder || {id: lib.folder, name: lib.name}, {provider});
    return {path, rev: entry.rev};
  }
  // ------------------------------------------------------------------ MCP (mcp/library_sources.py)
  // library_folder_update: body {folder, index, listing, reads: {path: base64}, query?, limit?} -> [summary, index JSON]
  //   (the server lists the folder and reads only the files whose size or time changed; the index stays on its disk).
  // library_import: body [{name, path, data}] (KiCad and Altium library files) -> draft components added to the
  //   project, paired inside these files only.
  const b64 = s => globalThis.AtriumImportFormats?.base64 ? AtriumImportFormats.base64(s) : Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const rowOut = d => ({id: d.id, name: d.name, category: d.category || "", prefix: d.prefix || "", pins: d.symbol?.pins?.length || 0, pads: d.footprint?.pads?.length || 0,
    footprint: d.footprint?.name || d.footprintName || ""});
  function headless(op, a, body, host) {
    if (op === "library_folder_update") {
      const req = JSON.parse(body || "{}"), folder = obj(req.folder) ? req.folder : {id: "folder", name: "Library folder"}, listing = Array.isArray(req.listing) ? req.listing : [];
      const index = usable(req.index), stats = {listed: listing.length, read: 0, parsed: 0, same: 0, errors: 0, removed: 0}, byPath = new Map(listing.map(f => [f.path, f]));
      for (const [path, data] of Object.entries(obj(req.reads) ? req.reads : {})) {
        if (!byPath.has(path)) continue;
        stats.read++;
        const r = ingest(index, byPath.get(path), b64(data));
        stats[r === "parsed" ? "parsed" : r === "same" ? "same" : "errors"]++;
      }
      const removed = Object.keys(index.files).filter(p => !byPath.has(p));
      stats.removed = removed.length;
      removeFiles(index.files, removed);
      const lib = assemble(folder, index, folder.root), r = lib.report, q = String(a.query || "").trim();
      const matches = q ? globalThis.AtriumCatalogue.query(lib.defs, q, {members: globalThis.AtriumComponentFamilies?.memberships(lib)}).items : [];
      const head = {id: lib.id, name: lib.name, components: lib.defs.length, paired: r.paired, symbol_only: r.symbolOnly, footprint_only: r.footprintOnly,
        files: r.files, unreadable_files: r.errors.length, unmatched_footprints: r.unmatched.length, power_symbols_skipped: r.power, scan: stats,
        ...(q ? {query: q, matches_total: matches.length, untrusted_design_text: {matches: matches.slice(0, a.limit || 50).map(rowOut), errors: r.errors.slice(0, 20)}} : {untrusted_design_text: {errors: r.errors.slice(0, 20)}})};
      return [head, stats.read || stats.removed ? JSON.stringify(index) : null];
    }
    if (op === "library_import") {
      const files = JSON.parse(body || "[]");
      if (!Array.isArray(files) || !files.length) throw Error("Pass the library files to import.");
      const p = host.mutable(), kicad = [], altium = [], credits = new Map();
      for (const f of files) {
        const name = String(f.name), bytes = b64(f.data);
        if (/\.kicad_(sym|mod)$/i.test(name)) {
          const digest = sha(bytes), kind = /\.kicad_sym$/i.test(name) ? "symbols" : "footprints";
          const credit = installationCredit(f.directory, name, kind);
          if (credit) credits.set(digest, credit);
          kicad.push({name, path: String(f.path || name), sha256: digest, text: decode(bytes)});
        }
        else if (/\.(schlib|pcblib)$/i.test(name)) {
          if (!globalThis.AtriumIO?.read) throw Error("Altium library reading is unavailable in this build.");
          altium.push({name, sha256: sha(bytes), library: AtriumIO.read(name, bytes).library || []});
        }
      }
      const reports = [], added = [];
      const want = Array.isArray(a.components) && a.components.length ? new Set(a.components.map(String)) : null;
      for (const r of [kicad.length && KI().pair(kicad, {existing: p.library}), altium.length && globalThis.AtriumLibraryImportAltium.pair(altium, {existing: p.library})].filter(Boolean)) {
        reports.push(r.report);
        for (const def of r.library) if (!want || want.has(def.name)) {
          const src = def.source, fp = src?.kind === "kicad-footprint" ? src : src?.footprint;
          if (src?.kind.startsWith("kicad-")) def.source = Lib().portableSource(def, {
            symbols: credits.get(src.sha256), footprints: credits.get(fp?.sha256)
          });
          p.library.push(def); Store()?.hoist(p, def); added.push(def);
        }
      }
      host.touched();
      const sum = k => reports.reduce((n, r) => n + (Array.isArray(r[k]) ? r[k].length : r[k] || 0), 0);
      return {added: added.length, paired: sum("paired"), symbol_only: sum("symbolOnly"), footprint_only: sum("footprintOnly"), already_in_project: sum("skipped"),
        pin_pad_mismatches: sum("mismatches"), unmatched_footprints: sum("unmatched"), ambiguous_footprints: sum("ambiguous"),
        untrusted_design_text: {components: added.slice(0, 500).map(rowOut), notes: reports.flatMap(r => r.notes).slice(0, 50)}};
    }
    throw Error("Unknown library operation " + op + ".");
  }
  return Object.freeze({LIMITS, classify, installationCredit, plan, ingest, assemble, needs, materialise, refresh, providers: {memory, archiveProvider, fileList, directoryHandle, nativeFolder},
    folders, addFolder, removeFolder, library, libraries, scan, scanAll, cancelScan, openMetadata, findEntry, revision, matchesProvenance, load, save, onChange, emptyIndex, rowsOf, cache, db, hid, headless});
})();
