"use strict";

if (!globalThis.AtriumSHA256 && typeof require === "function") require("../core/sha256.js");
if (!globalThis.AtriumLibraryPairing && typeof require === "function") require("./library-pairing.js");
// Library store: content hashes, readable revisions, the project's 3D model blob table, library
// health checks and the per-component record layer used by the shared group library.
// DOM-free; loads with the Library panel (app/lazy.js "AtriumLibrary") and in MCP and tests.
//
//   sha256(text), canonical(value)          SHA-256 (UTF-8) and sorted-key JSON
//   contentHash(def, project?)               SHA-256 of a def's canonical content (id, provenance and
//                                            revision left out; a 3D model counts by its SHA-256, so an
//                                            inline model and the same model in project.blobs agree)
//   sideHash(def, "symbol"|"footprint", project?)  the same for one side (16 hex digits)
//
//   3D models stored once per project (format 1.4, docs/format-versioning.md):
//     project.blobs = {<sha256>: {name, stepText}}; a def's model3d is {file, sha256, offset, rotation}
//     instead of {file, stepText, ...}. Both forms are valid; readers call stepTextOf.
//   stepTextOf(project, model3d)             the STEP text, inline or from the blob table
//   hoist(project, def) / hoistAll(project)  move inline STEP text into project.blobs (returns counts)
//   inflate(project, def)                    a copy with STEP text inline again (library files, editors)
//   unusedBlobs(project) / pruneBlobs(project)
//
//   health(defs, {project})                  -> {issues: [{level, code, def, name, message}], counts}
//     missing 3D model, pin/pad count mismatch, pins without pads and pads without pins, duplicate
//     ids and names, a 3D blob that is missing, footprint errors (checkFootprint). Per-def results
//     are cached per object; defs are replaced, not mutated, when edited.
//
//   Records used for group revision fingerprints and three-way component merges:
//     record(def, {rev, project}) -> {id, rev, hash, body}   body = canonical JSON, hash = its SHA-256
//     tombstone(id, rev, date?)   -> {id, rev, deleted: true, date}
//     merge(base, ours, theirs)   -> {records, conflicts}   three-way, per component id
//     serialise(def)              -> deterministic text (sorted keys, two-space indent, final newline)
globalThis.AtriumLibraryStore = (() => {
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const clone = v => JSON.parse(JSON.stringify(v));
  const SHA = /^[0-9a-f]{64}$/;

  // ------------------------------------------------------------------ hashing
  function sha256(input) {
    const digest = globalThis.AtriumSHA256;
    if (typeof input === "string") return digest.text(input);
    if (input instanceof Uint8Array)
      return digest.bytes(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    // Preserve the library API's indexed byte conversion for other views and arrays.
    const length = input.length;
    if (!Number.isSafeInteger(length) || length < 0) throw RangeError("Expected a byte array.");
    const bytes = new Uint8Array(length);
    bytes.set(input);
    return digest.bytes(bytes);
  }
  // Sorted keys, undefined dropped: equal values always give the same text.
  function canonical(v) {
    if (Array.isArray(v)) return "[" + v.map(x => x === undefined ? "null" : canonical(x)).join(",") + "]";
    if (obj(v)) return "{" + Object.keys(v).filter(k => v[k] !== undefined).sort().map(k => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
    return v === undefined ? "null" : JSON.stringify(v);
  }

  // ------------------------------------------------------------------ 3D model blobs
  const blobTable = project => obj(project?.blobs) ? project.blobs : null;
  const usable = b => obj(b) && typeof b.stepText === "string";
  // The model3d slots of a definition: [owner, key] pairs.
  const slots = def => [[def, "model3d"], [def?.footprint, "model3d"]].filter(([o, k]) => obj(o) && obj(o[k]));
  // Same key order, one key renamed and its value replaced (keeps saved files and diffs tidy).
  function rekey(o, from, to, value) {
    const out = {};
    for (const [k, v] of Object.entries(o)) if (k === from || k === to) { if (!(to in out)) out[to] = value; } else out[k] = v;
    return out;
  }
  const shaOf = new WeakMap(); // model3d object -> SHA-256 of its inline STEP text
  function modelSha(m3) {
    if (typeof m3.stepText !== "string") return SHA.test(m3.sha256 || "") ? m3.sha256 : null;
    let s = shaOf.get(m3);
    if (!s) { s = sha256(m3.stepText); shaOf.set(m3, s); }
    return s;
  }
  function stepTextOf(project, m3) {
    if (!obj(m3)) return null;
    if (typeof m3.stepText === "string") return m3.stepText;
    const b = SHA.test(m3.sha256 || "") ? blobTable(project)?.[m3.sha256] : null;
    return usable(b) ? b.stepText : null;
  }
  // Inline STEP text -> project.blobs. Returns the number of models moved.
  function hoist(project, def) {
    let n = 0;
    for (const [owner, key] of slots(def)) {
      const m3 = owner[key];
      if (typeof m3.stepText !== "string") continue;
      const sha = modelSha(m3);
      if (!obj(project.blobs)) project.blobs = {};
      if (!usable(project.blobs[sha])) project.blobs[sha] = {name: String(m3.file || m3.name || "model.step").slice(0, 200), stepText: m3.stepText};
      owner[key] = rekey(m3, "stepText", "sha256", sha);
      n++;
    }
    return n;
  }
  function hoistAll(project) {
    let models = 0, bytes = 0;
    const before = new Set(Object.keys(blobTable(project) || {}));
    for (const def of project.library || []) for (const [owner, key] of slots(def)) if (typeof owner[key].stepText === "string") bytes += owner[key].stepText.length;
    for (const def of project.library || []) models += hoist(project, def);
    const added = Object.keys(blobTable(project) || {}).filter(k => !before.has(k));
    for (const k of added) bytes -= project.blobs[k].stepText.length;
    return {models, blobs: added.length, saved: Math.max(0, bytes)};
  }
  function inlineModels(project, def, portable = false) {
    for (const [owner, key] of slots(def)) {
      const text = stepTextOf(project, owner[key]);
      if (typeof owner[key].stepText !== "string" && text != null) owner[key] = rekey(owner[key], "sha256", "stepText", text);
      const model = owner[key], file = model.file;
      // Once the asset is embedded, the name is for display. External-only paths still locate data.
      if (portable && typeof file === "string" && /^(?:[\\/]|[a-z]:[\\/]|file:\/\/)/i.test(file) && /\S/.test(text || "")) {
        model.file = file.split(/[\\/]/).pop() || "model.step";
      }
    }
    return def;
  }
  // Project-native copies keep their original model paths. Portable output passes a detached def.
  const inflate = (project, def) => inlineModels(project, clone(def));
  const portableModels = (project, detached) => inlineModels(project, detached, true);
  const hoisted = def => slots(def).some(([o, k]) => typeof o[k].stepText !== "string" && SHA.test(o[k].sha256 || ""));
  function usedBlobs(project) {
    const used = new Set();
    const see = m3 => { if (obj(m3) && SHA.test(m3.sha256 || "")) used.add(m3.sha256); };
    for (const def of project.library || []) for (const [o, k] of slots(def)) see(o[k]);
    for (const d of project.documents || []) for (const i of d.items || []) if (i.kind === "part") see(i.model3d);
    return used;
  }
  const unusedBlobs = project => { const used = usedBlobs(project); return Object.keys(blobTable(project) || {}).filter(k => !used.has(k)); };
  function pruneBlobs(project) {
    const gone = unusedBlobs(project);
    for (const k of gone) delete project.blobs[k];
    if (obj(project.blobs) && !Object.keys(project.blobs).length) delete project.blobs;
    return gone.length;
  }

  // ------------------------------------------------------------------ content hashes
  const SKIP = new Set(["id", "libraryRef", "mirrorOf", "mirrorSig", "rev", "sourceName"]);
  // The def as compared: provenance left out, each 3D model as its SHA-256.
  function normalised(def) {
    const out = {};
    for (const [k, v] of Object.entries(def || {})) if (!SKIP.has(k)) out[k] = v;
    const model = m3 => { const s = modelSha(m3); const r = rekey(m3, "stepText", "sha256", s); if (!s) delete r.sha256; return r; };
    if (obj(out.model3d)) out.model3d = model(out.model3d);
    if (obj(out.footprint) && obj(out.footprint.model3d)) out.footprint = {...out.footprint, model3d: model(out.footprint.model3d)};
    return out;
  }
  const hashes = new WeakMap();
  function contentHash(def) {
    let h = hashes.get(def);
    if (!h) { h = sha256(canonical(normalised(def))); if (obj(def)) hashes.set(def, h); }
    return h;
  }
  function sideHash(def, side) {
    const g = normalised(def)[side];
    return g ? sha256(canonical(g)).slice(0, 16) : null;
  }

  // ------------------------------------------------------------------ health checks
  const pinNumbers = def => [...new Set((def?.symbol?.pins || []).map(p => String(p.number ?? "")).filter(Boolean))];
  const padNumbers = def => [...new Set((def?.footprint?.pads || []).filter(p => !p.thermalVia && String(p.number ?? "") !== "").map(p => String(p.number)))];
  const placeholder = def => def?.generic?.role === "placeholder";
  const perDef = new WeakMap();
  function defIssues(def, project) {
    const out = [], add = (level, code, message) => out.push({level, code, def: def.id, name: def.name || def.id, message});
    if (def.stub) {
      add("info", "unread-geometry", "Read the source component to check its geometry.");
      return out;
    }
    const sym = def.symbol, fp = def.footprint, generic = obj(def.generic);
    if (fp && !fp.provisional && !fp.bodies3d?.length) {
      const m3 = def.model3d || fp.model3d;
      if (!m3) add(generic || fp.height > 0 ? "info" : "warning", "no-3d", fp.height > 0 ? "No 3D model; the 3D view extrudes a " + fp.height + " mm body." : "No 3D model and no body height.");
      else if (typeof m3.stepText !== "string" && SHA.test(m3.sha256 || "") && project && !usable(blobTable(project)?.[m3.sha256]))
        add("warning", "missing-3d-data", "The 3D model " + (m3.file || m3.sha256.slice(0, 12)) + " is not stored in this project.");
      else if (typeof m3.stepText !== "string" && !m3.sha256 && !m3.file) add("warning", "no-3d", "The 3D model has no data.");
    }
    if (sym && fp) {
      const pins = pinNumbers(def), pads = padNumbers(def), {noPad, noPin} = globalThis.AtriumLibraryPairing.difference(pins, pads);
      if (pins.length !== pads.length) add("warning", "count", pins.length + " pins but " + pads.length + " pads.");
      if (noPad.length) add("error", "unmapped-pin", "Pins without a pad: " + noPad.slice(0, 12).join(", ") + (noPad.length > 12 ? "…" : "") + ".");
      if (noPin.length) add(noPin.every(n => /^(EP|PAD|TAB|MH|MP|M\d*|0)$/i.test(n)) ? "warning" : "error", "unmapped-pad", "Pads without a pin: " + noPin.slice(0, 12).join(", ") + (noPin.length > 12 ? "…" : "") + ".");
    }
    if (sym) {
      const seen = new Set();
      for (const p of sym.pins || []) { const k = String(p.number) + "|" + (p.part || 0); if (seen.has(k)) { add("error", "duplicate-pin", "Pin number " + p.number + " appears twice" + (p.part ? " in gate " + p.part : "") + "."); break; } seen.add(k); }
    }
    const L = globalThis.AtriumLibrary;
    if (fp && L?.checkFootprint) for (const x of L.checkFootprint(fp)) if (x.level === "error") add("error", "footprint-" + x.code, x.message);
    if (fp?.provisional) add("info", "provisional", "The footprint is provisional (a placeholder package).");
    if (def.state === "released" && !placeholder(def) && !generic) {
      const params = obj(def.parameters) ? def.parameters : {};
      if (!Object.keys(params).some(k => /^(mpn|manufacturer part( number)?|part number)$/i.test(k) && String(params[k]).trim())) add("warning", "no-mpn", "Released without a manufacturer part number.");
      if (!obj(def.verified)) add("warning", "unverified", "Released without a verification record.");
    }
    return out;
  }
  function health(defs, o = {}) {
    const list = (Array.isArray(defs) ? defs : []).filter(d => obj(d) && !d.mirrorOf), issues = [];
    const ids = new Map(), names = new Map();
    for (const d of list) {
      ids.set(d.id, (ids.get(d.id) || 0) + 1);
      const key = String(d.name || "").trim().toLowerCase();
      if (key) { if (!names.has(key)) names.set(key, []); names.get(key).push(d); }
      let mine = o.checked?.get(d.id)?.issues || (o.project ? null : perDef.get(d));
      if (!mine) { mine = defIssues(d, o.project); if (!o.project) perDef.set(d, mine); }
      issues.push(...mine);
    }
    for (const [id, n] of ids) if (n > 1) issues.push({level: "error", code: "duplicate-id", def: id, name: id, message: "The id " + id + " is used by " + n + " components."});
    for (const group of names.values()) {
      if (group.length < 2) continue;
      // The same name for different packages is a family; the same name and the same package is a duplicate.
      const byPkg = new Map();
      for (const d of group) { const k = String(d.footprint?.name || d.package || ""); byPkg.set(k, [...(byPkg.get(k) || []), d]); }
      for (const same of byPkg.values()) if (same.length > 1) {
        const distinct = new Set(same.map(d => o.checked?.get(d.id)?.hash || d.stub?.hash || contentHash(d))).size;
        issues.push({level: distinct > 1 ? "warning" : "info", code: "duplicate-name", def: same[0].id, name: same[0].name,
          message: same.length + " components are called " + same[0].name + (distinct > 1 ? " and differ" : " and are identical") + "."});
      }
    }
    if (o.project) {
      const unused = unusedBlobs(o.project);
      if (unused.length) issues.push({level: "info", code: "unused-3d", def: null, name: "Project", message: unused.length + " stored 3D model" + (unused.length > 1 ? "s are" : " is") + " no longer used."});
      const inline = list.filter(d => slots(d).some(([x, k]) => typeof x[k].stepText === "string")).length;
      if (inline) issues.push({level: "info", code: "inline-3d", def: null, name: "Project", message: inline + " component" + (inline > 1 ? "s keep their" : " keeps its") + " 3D model inline. Store 3D models once to share them."});
    }
    const rank = {error: 0, warning: 1, info: 2};
    issues.sort((a, b) => rank[a.level] - rank[b.level] || String(a.name).localeCompare(String(b.name), "en", {numeric: true}));
    const counts = {error: 0, warning: 0, info: 0};
    for (const x of issues) counts[x.level]++;
    return {issues, counts};
  }

  // ------------------------------------------------------------------ records (sync seam)
  // A library is a set of small records, one per component, each with a stable id, a revision
  // people read ("rev 3") and a content hash Waffle compares. Deletions are tombstones, so a
  // peer that still has the component learns that it was removed instead of adding it back.
  function record(def, o = {}) {
    const body = canonical(normalised(def));
    return {id: def.id, rev: Number.isInteger(o.rev) ? o.rev : Number.isInteger(def.rev) ? def.rev : 1, hash: sha256(body), body};
  }
  const tombstone = (id, rev, date = null) => ({id: String(id), rev: Number.isInteger(rev) ? rev : 1, deleted: true, ...(date ? {date: String(date)} : {})});
  function pretty(v, pad = "") {
    if (Array.isArray(v)) return v.length ? "[\n" + v.map(x => pad + "  " + pretty(x, pad + "  ")).join(",\n") + "\n" + pad + "]" : "[]";
    if (obj(v)) { const keys = Object.keys(v).filter(k => v[k] !== undefined).sort(); return keys.length ? "{\n" + keys.map(k => pad + "  " + JSON.stringify(k) + ": " + pretty(v[k], pad + "  ")).join(",\n") + "\n" + pad + "}" : "{}"; }
    return JSON.stringify(v);
  }
  const serialise = v => pretty(v) + "\n";
  const asMap = v => v instanceof Map ? v : new Map((Array.isArray(v) ? v : Object.values(v || {})).filter(r => obj(r) && r.id != null).map(r => [String(r.id), r]));
  const key = r => (r.deleted ? "-" : "+") + (r.hash || "");
  // Three-way merge per component id. A side that did not change since base yields to the other;
  // two different changes of one component are a conflict (left as ours, listed).
  function merge(base, ours, theirs) {
    const B = asMap(base), O = asMap(ours), T = asMap(theirs), out = new Map(), conflicts = [];
    for (const id of new Set([...O.keys(), ...T.keys()])) {
      const o = O.get(id), t = T.get(id), b = B.get(id);
      if (!o || !t) { out.set(id, o || t); continue; }
      if (key(o) === key(t)) { out.set(id, o.rev >= t.rev ? o : t); continue; }
      if (b && key(o) === key(b)) { out.set(id, t); continue; }
      if (b && key(t) === key(b)) { out.set(id, o); continue; }
      out.set(id, o); conflicts.push({id, base: b || null, ours: o, theirs: t});
    }
    return {records: out, conflicts};
  }

  return Object.freeze({sha256, canonical, contentHash, sideHash, normalised, stepTextOf, hoist, hoistAll, inflate, portableModels, hoisted, usedBlobs, unusedBlobs, pruneBlobs,
    health, pinNumbers, padNumbers, record, tombstone, merge, serialise});
})();
