"use strict";

if (!globalThis.AtriumSHA256 && typeof require === "function") require("../core/sha256.js");
// Board revisions: named, frozen snapshots of the design (A, B, C… with date, notes and status)
// stored content-addressed inside the project, and the read-only lock on a released revision.
// DOM-free: the editor (revisions-ui.js), the MCP run_command commands and tests use it.
//
// Data (all optional; format 1.2, app/compat.js; validated by model.js through validate()):
//   project.revision      = {letter, status: "draft"|"released"|"obsolete", date?, notes?, from?}
//                           the revision the working design is. output-jobs.js and release.js
//                           already read project.revision.letter for {rev} and package names;
//                           title blocks read =Revision, =RevisionStatus, =RevisionDate, =RevisionNotes.
//   project.revisions     = [{id, letter, status: "released"|"obsolete", date, notes?, from?, root,
//                             released (ISO time), stored: {chunks, bytes}, checks?, overrides?, outputs?, release?}]
//   project.revisionStore = {"<hash>": "<chunk text>"}   content-addressed chunks, shared by every revision
//
// Storage (efficient, not full copies). A snapshot is a Merkle tree. Small fields of an object are
// one chunk; big arrays (document items, the library, pours) are cut into content-defined chunks
// (a cut after an element whose id hashes to 15 mod 16: about 16 elements, at most 64 or 16 KB),
// so an edit moves the cut points only locally. Every node is itself a chunk, and a chunk is
// stored once under the first 128 bits of its SHA-256. Revision B costs the chunks it changed
// since A plus the few node chunks above them. The canonical file writes one chunk per line, so
// releasing a revision only adds lines to the file (diff-friendly). Reading a revision checks
// every chunk against its hash: a damaged store is reported, never shown as the design.
//
//   working(p) / list(p) / find(p, ref) / locked(p) / nextLetter(p)
//   start(p, {letter, notes})            begin revision tracking: Rev A (or letter) as a draft
//   freeze(p, {date, notes, checks, overrides, outputs, release, encoded}) -> entry   release the working draft
//   newFrom(p, ref?, {letter, notes, replaceDraft}) -> working   the next revision as a draft, from the
//                                        working (released) design or from an older revision's snapshot
//   setStatus(p, ref, "released"|"obsolete") / setNotes(p, notes)   (notes: the working draft only)
//   encode(design) -> {root, chunks: Map}   designOf(p, ref) -> design   ("working" or a revision)
//   compare(p, a, b) -> {before, after, from, to}   pairs for AtriumDiff / the visual diff
//   bom(p, {variant, revision}) -> lines        guard(p) / allow(fn)   the editor's read-only gate
//   fields(p) -> {Revision, RevisionStatus, RevisionDate, RevisionNotes}
//   validate(p) / gc(p) / storeStats(p) / summary(p) / headless(name, p, args)
globalThis.AtriumRevisions = (() => {
  const G = globalThis;
  const LIMIT = {revisions: 500, notes: 4000, letter: 8, chunks: 2000000, chunk: 4 * 1048576};
  const STATUS = ["draft", "released", "obsolete"], LABEL = {draft: "Draft", released: "Released", obsolete: "Obsolete"};
  // ASME Y14.35 revision letters: I, O, Q, S, X and Z are skipped (they read as digits).
  const ALPHABET = "ABCDEFGHJKLMNPRTUVWY";
  // Project fields that are history or session state, not design: never in a snapshot, kept as
  // they are when an older revision's design is restored.
  const META = new Set(["revisions", "revisionStore", "releases", "activeVariant", "review", "atriumCompat", "ui", "view", "history", "variantApplied"]);
  const MIN_ARRAY = 16, MAX_ELEMS = 64, MAX_CHUNK = 16384;
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = v => typeof v === "string";
  const fail = m => { throw Error(m); };
  const clean = v => String(v ?? "").replace(/\s+/g, " ").trim();
  const today = d => (d instanceof Date ? d : d ? new Date(d) : new Date()).toISOString().slice(0, 10);
  const newId = () => G.Atrium?.id?.() || "rev-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const plural = (n, w) => globalThis.AtriumI18n?.plural?.(n, w) ?? n + " " + w + (n === 1 ? "" : "s");

  // ------------------------------------------------------------ hashing
  const sha256 = text => G.AtriumSHA256.text(text);
  const chunkHash = text => sha256(text).slice(0, 32);
  // Canonical JSON: sorted keys, undefined dropped, as the saved file orders them.
  function canon(v) {
    if (v === null || typeof v !== "object") return v === undefined || typeof v === "function" ? "null" : JSON.stringify(v);
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== "function").sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  function cut(e, s) {
    const key = plain(e) && str(e.id) ? e.id : s.length > 48 ? s.slice(0, 48) : s;
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return ((h >>> 0) & 15) === 15;
  }

  // ------------------------------------------------------------ Merkle encode / decode
  // Chunk texts: "v<json>" a value; "a[<hash>…]" an array cut into "v[…]" chunks; "l[<hash>…]" a
  // list of encoded elements; "o{"r":<hash of the small fields>,"k":{key:<hash>}}" an object.
  const bigObject = v => Object.keys(v).some(k => Array.isArray(v[k]) ? v[k].length >= MIN_ARRAY || plain(v[k][0]) : plain(v[k]) && Object.keys(v[k]).length > 8);
  function encode(design, have) {
    const chunks = new Map(), seen = have || null;
    const put = text => { const h = chunkHash(text); if (!chunks.has(h) && !(seen && Object.prototype.hasOwnProperty.call(seen, h))) chunks.set(h, text); return h; };
    function arr(v) {
      const out = []; let parts = [], bytes = 0;
      const flush = () => { if (parts.length) out.push(put("v[" + parts.join(",") + "]")); parts = []; bytes = 0; };
      for (const e of v) { const s = canon(e); parts.push(s); bytes += s.length; if (parts.length >= MAX_ELEMS || bytes >= MAX_CHUNK || cut(e, s)) flush(); }
      flush();
      return put("a" + JSON.stringify(out));
    }
    function node(v, depth) {
      if (Array.isArray(v)) {
        if (v.length >= MIN_ARRAY) return arr(v);
        if (depth < 3 && v.length && v.every(plain) && v.some(bigObject)) return put("l" + JSON.stringify(v.map(e => node(e, depth + 1))));
        return put("v" + canon(v));
      }
      if (plain(v) && depth < 4 && bigObject(v)) {
        const rest = {}, kids = {};
        for (const k of Object.keys(v).sort()) {
          const x = v[k];
          if (x === undefined || typeof x === "function") continue;
          if (Array.isArray(x) ? x.length >= MIN_ARRAY || plain(x[0]) : plain(x) && bigObject(x)) kids[k] = node(x, depth + 1);
          else rest[k] = x;
        }
        return put("o" + canon({r: put("v" + canon(rest)), k: kids}));
      }
      return put("v" + canon(v));
    }
    const root = node(design, 0);
    return {root, chunks};
  }
  function decode(store, root, {verify = true} = {}) {
    const get = h => {
      const t = str(h) && Object.prototype.hasOwnProperty.call(store || {}, h) ? store[h] : null;
      if (!str(t)) fail("The revision store is missing a chunk (" + String(h).slice(0, 12) + "). This revision can't be read.");
      if (verify && chunkHash(t) !== h) fail("The revision store is damaged (chunk " + h.slice(0, 12) + " does not match its hash). This revision can't be read.");
      return t;
    };
    function node(h) {
      const t = get(h), tag = t[0], body = t.slice(1);
      if (tag === "v") return JSON.parse(body);
      if (tag === "a") { const out = []; for (const c of JSON.parse(body)) { const t2 = get(c); if (t2[0] !== "v") fail("The revision store is damaged."); for (const e of JSON.parse(t2.slice(1))) out.push(e); } return out; }
      if (tag === "l") return JSON.parse(body).map(node);
      if (tag === "o") { const o = JSON.parse(body), out = node(o.r); for (const k of Object.keys(o.k)) out[k] = node(o.k[k]); return out; }
      fail("The revision store is damaged (unknown chunk).");
    }
    return node(root);
  }
  // Every chunk reachable from a root (gc, size accounting).
  function reach(store, root, into = new Set()) {
    const stack = [root];
    while (stack.length) {
      const h = stack.pop();
      if (into.has(h) || !str(store?.[h])) continue;
      into.add(h);
      const t = store[h], tag = t[0];
      if (tag === "a" || tag === "l") stack.push(...JSON.parse(t.slice(1)));
      else if (tag === "o") { const o = JSON.parse(t.slice(1)); stack.push(o.r, ...Object.values(o.k)); }
    }
    return into;
  }

  // ------------------------------------------------------------ the model
  const designPart = p => { const out = {}; for (const k of Object.keys(p || {})) if (!META.has(k) && p[k] !== undefined) out[k] = p[k]; return out; };
  function working(p) {
    const w = p?.revision;
    if (str(w) && w.trim()) return {letter: w.trim(), status: "draft", legacy: true};
    return plain(w) && str(w.letter) && w.letter.trim() ? w : null;
  }
  const list = p => Array.isArray(p?.revisions) ? p.revisions.filter(r => plain(r) && str(r.id) && str(r.letter)) : [];
  function find(p, ref) {
    if (ref == null || ref === "") return null;
    if (plain(ref)) ref = ref.id || ref.letter;
    const all = list(p), key = String(ref).trim().toUpperCase().replace(/^REV(ISION)?\s*/, "");
    return all.find(r => r.id === ref) || all.slice().reverse().find(r => r.letter.toUpperCase() === key) || null;
  }
  // A status from a newer Waffle is kept as written and treated as frozen (this build can't tell what it allows).
  const locked = p => { const w = working(p); return !!w && w.status != null && w.status !== "draft"; };
  const statusLabel = s => LABEL[s] || (typeof s === "string" && s ? s : "Draft");
  function letterIndex(l) {
    if (!/^[A-Z]{1,3}$/.test(l)) return -1;
    let n = 0;
    for (const c of l) { const i = ALPHABET.indexOf(c); if (i < 0) return -1; n = n * ALPHABET.length + i + 1; }
    return n - 1;
  }
  function letterAt(i) {
    let s = "", n = i + 1;
    while (n > 0) { const r = (n - 1) % ALPHABET.length; s = ALPHABET[r] + s; n = Math.floor((n - 1) / ALPHABET.length); }
    return s;
  }
  function nextLetter(p) {
    let max = -1;
    for (const l of [...list(p).map(r => r.letter), working(p)?.letter]) if (l) max = Math.max(max, letterIndex(String(l).toUpperCase()));
    if (max < 0 && (list(p).length || working(p))) {
      const n = /^(\d+)$/.exec(String(working(p)?.letter || list(p).at(-1)?.letter || ""));
      if (n) return String(+n[1] + 1);
    }
    return letterAt(max + 1);
  }
  function checkLetter(p, letter, except) {
    const l = clean(letter).toUpperCase();
    if (!l || l.length > LIMIT.letter || !/^[A-Z0-9][A-Z0-9.\-]*$/.test(l)) fail("A revision is a short label such as A, B or 2 (letters, digits, '.' or '-').");
    if (list(p).some(r => r.letter.toUpperCase() === l && r !== except)) fail("Rev " + l + " already exists. Revisions are never reused; choose the next one (" + nextLetter(p) + ").");
    return l;
  }

  function validate(p) {
    const bad = m => fail("Board revisions: " + m), newer = !!(p?.atriumCompat?.newer || p?.atriumCompat?.readOnly);
    if (p?.revision != null && !str(p.revision)) {
      const w = p.revision;
      if (!plain(w) || !str(w.letter) || !w.letter.trim() || w.letter.length > LIMIT.letter + 32) bad("project.revision needs a letter.");
      if (w.status != null && !STATUS.includes(w.status) && !(newer && str(w.status) && w.status.length <= 40)) bad("the working revision status must be draft, released or obsolete.");
      if (w.notes != null && (!str(w.notes) || w.notes.length > LIMIT.notes)) bad("revision notes must be text of at most " + LIMIT.notes + " characters.");
      for (const k of ["date", "from"]) if (w[k] != null && (!str(w[k]) || w[k].length > 40)) bad("revision " + k + " must be short text.");
    }
    if (p?.revisions != null) {
      if (!Array.isArray(p.revisions) || p.revisions.length > LIMIT.revisions) bad("project.revisions must be a list of at most " + LIMIT.revisions + ".");
      const ids = new Set();
      for (const r of p.revisions) {
        if (!plain(r) || !str(r.id) || !r.id || r.id.length > 300 || ids.has(r.id)) bad("each revision needs a unique id.");
        ids.add(r.id);
        if (!str(r.letter) || !r.letter.trim() || r.letter.length > 40) bad("each revision needs a letter.");
        if (!["released", "obsolete", "draft"].includes(r.status) && !(newer && str(r.status) && r.status.length <= 40)) bad("Rev " + r.letter + " has an unknown status.");
        if (!str(r.root) || !/^[0-9a-f]{32}$/.test(r.root)) bad("Rev " + r.letter + " has no snapshot.");
        if (r.notes != null && (!str(r.notes) || r.notes.length > LIMIT.notes)) bad("Rev " + r.letter + " notes are too long.");
      }
    }
    if (p?.revisionStore != null) {
      if (!plain(p.revisionStore)) bad("project.revisionStore must be an object.");
      const keys = Object.keys(p.revisionStore);
      if (keys.length > LIMIT.chunks) bad("the revision store is too large.");
      for (const k of keys) if (!/^[0-9a-f]{32}$/.test(k) || !str(p.revisionStore[k]) || p.revisionStore[k].length > LIMIT.chunk) bad("the revision store has an invalid chunk.");
      for (const r of p.revisions || []) if (plain(r) && str(r.root) && !Object.prototype.hasOwnProperty.call(p.revisionStore, r.root)) bad("Rev " + r.letter + "'s snapshot is missing from the store.");
    } else if (Array.isArray(p?.revisions) && p.revisions.length) bad("the revision store is missing.");
    return p;
  }

  // ------------------------------------------------------------ editing (in place; callers wrap in one undo step)
  function start(p, {letter, notes, date} = {}) {
    if (working(p) && !working(p).legacy) fail("Revision tracking has started already: this is Rev " + working(p).letter + ".");
    const l = checkLetter(p, letter || (working(p)?.legacy ? working(p).letter : null) || nextLetter(p));
    p.revision = {letter: l, status: "draft", date: today(date)};
    if (clean(notes)) p.revision.notes = String(notes).slice(0, LIMIT.notes);
    return p.revision;
  }
  function setNotes(p, notes) {
    const w = working(p);
    if (!w || w.legacy) fail("Start revision tracking first.");
    if (locked(p)) fail("Rev " + w.letter + " is " + statusLabel(w.status).toLowerCase() + ": its notes are frozen. Start the next revision to write new notes.");
    const text = String(notes ?? "").slice(0, LIMIT.notes);
    if (text.trim()) p.revision.notes = text; else delete p.revision.notes;
    return p.revision;
  }
  // The frozen design of the working draft, as stored (without writing the store yet).
  function frozenDesign(p, date) {
    const w = working(p);
    return designPart({...p, revision: {...(w.legacy ? {letter: w.letter} : w), status: "released", date: today(date)}});
  }
  // Release the working draft: snapshot it, mark it released (read-only from now on).
  // opts.encoded: the encode() of frozenDesign() made before outputs ran (the root must match).
  function freeze(p, opts = {}) {
    let w = working(p);
    if (!w || w.legacy) w = start(p, {letter: opts.letter || (w?.legacy ? w.letter : undefined), date: opts.date});
    if (w.status !== "draft") fail("Rev " + w.letter + " is already " + statusLabel(w.status).toLowerCase() + ". Start the next revision first.");
    checkLetter(p, w.letter);
    if (opts.notes != null) setNotes(p, opts.notes);
    const date = today(opts.date);
    const design = frozenDesign(p, date);
    const store = plain(p.revisionStore) ? p.revisionStore : {};
    const enc = encode(design, store);
    if (opts.encoded && opts.encoded.root !== enc.root) fail("The design changed while the release was being made. Release again.");
    let bytes = 0;
    for (const [h, t] of enc.chunks) { store[h] = t; bytes += t.length; }
    p.revisionStore = sortStore(store);
    p.revision = {...design.revision};
    const entry = {id: newId(), letter: w.letter, status: "released", date, released: new Date(opts.time || Date.now()).toISOString(), root: enc.root,
      stored: {chunks: enc.chunks.size, bytes}};
    if (p.revision.notes) entry.notes = p.revision.notes;
    if (w.from) entry.from = w.from;
    if (Array.isArray(opts.checks) && opts.checks.length) entry.checks = opts.checks.map(c => ({id: String(c.id), status: String(c.status), summary: String(c.summary || "").slice(0, 300)}));
    if (Array.isArray(opts.overrides) && opts.overrides.length) entry.overrides = opts.overrides.map(o => ({check: String(o.check), reason: String(o.reason).slice(0, 500)}));
    if (str(opts.outputs)) entry.outputs = opts.outputs;
    if (str(opts.release)) entry.release = opts.release;
    if (!Array.isArray(p.revisions)) p.revisions = [];
    p.revisions.push(entry);
    return entry;
  }
  const sortStore = s => { const out = {}; for (const k of Object.keys(s).sort()) out[k] = s[k]; return out; };
  // The next revision as a draft. ref: a revision (id or letter) to start from; omitted, the working design.
  function newFrom(p, ref, opts = {}) {
    const w = working(p), src = ref == null || ref === "" || ref === "working" ? null : find(p, ref) || fail("There is no revision " + ref + ".");
    if (!w && !src) return start(p, opts);
    if (w && w.status === "draft" && !w.legacy && !opts.replaceDraft) {
      fail(src ? "Rev " + w.letter + " is a draft with unreleased edits. Starting from Rev " + src.letter + " replaces them (confirm to continue)."
        : "Rev " + w.letter + " is still a draft: keep editing it, or release it first.");
    }
    const letter = checkLetter(p, opts.letter || (w?.status === "draft" && !w.legacy && opts.replaceDraft ? w.letter : nextLetter(p)));
    if (src) {
      const design = decode(p.revisionStore, src.root);
      for (const k of Object.keys(p)) if (!META.has(k)) delete p[k];
      for (const k of Object.keys(design)) if (!META.has(k)) p[k] = design[k];
      if (p.activeVariant != null && !(p.variants || []).some(v => v?.id === p.activeVariant)) delete p.activeVariant;
    }
    const from = src ? src.letter : w && !w.legacy ? w.letter : undefined;
    p.revision = {letter, status: "draft", date: today(opts.date)};
    if (from) p.revision.from = from;
    if (clean(opts.notes)) p.revision.notes = String(opts.notes).slice(0, LIMIT.notes);
    return p.revision;
  }
  // Released <-> Obsolete. A released snapshot never changes; only its status label does.
  function setStatus(p, ref, status) {
    if (!["released", "obsolete"].includes(status)) fail("A frozen revision is released or obsolete.");
    const r = find(p, ref) || fail("There is no revision " + ref + ".");
    r.status = status;
    const w = working(p);
    if (w && !w.legacy && w.letter === r.letter && w.status !== "draft") p.revision = {...w, status};
    return r;
  }
  // Drop chunks no revision uses (after an undo or a hand edit). Returns the count removed.
  function gc(p) {
    if (!plain(p.revisionStore)) return 0;
    const keep = new Set();
    for (const r of list(p)) reach(p.revisionStore, r.root, keep);
    let n = 0;
    for (const k of Object.keys(p.revisionStore)) if (!keep.has(k)) { delete p.revisionStore[k]; n++; }
    if (!list(p).length && !Object.keys(p.revisionStore).length) delete p.revisionStore;
    return n;
  }
  function storeStats(p) {
    const s = plain(p?.revisionStore) ? p.revisionStore : {};
    let bytes = 0; for (const k in s) bytes += s[k].length + 40;
    return {chunks: Object.keys(s).length, bytes};
  }

  // ------------------------------------------------------------ reading
  function designOf(p, ref = "working") {
    if (ref === "working" || ref == null) return JSON.parse(JSON.stringify(designPart(p)));
    const r = find(p, ref) || fail("There is no revision " + ref + ".");
    return decode(p.revisionStore, r.root);
  }
  const labelOf = (p, ref) => {
    if (ref === "working" || ref == null) { const w = working(p); return w ? "Rev " + w.letter + (w.status === "draft" ? " (working draft)" : " (working)") : "Working design"; }
    const r = find(p, ref); return r ? "Rev " + r.letter + " · " + statusLabel(r.status) + " " + r.date : String(ref);
  };
  // Two sides for AtriumDiff.compare / AtriumDiffView.start: older first unless told otherwise.
  function compare(p, a, b = "working") {
    const before = designOf(p, a), after = designOf(p, b);
    return {before, after, from: labelOf(p, a), to: labelOf(p, b)};
  }
  function fields(p) {
    const w = working(p);
    if (!w) return {};
    return {Revision: w.letter, RevisionStatus: statusLabel(w.status), RevisionDate: w.date || "", RevisionNotes: w.notes || "", RevisionFrom: w.from || ""};
  }
  // Bill of materials for a variant (and optionally a frozen revision): grouped lines.
  function bom(p, {variant, revision} = {}) {
    let design = revision ? designOf(p, revision) : p;
    if (revision) design = {...design, variants: design.variants, activeVariant: p.activeVariant};
    const V = G.AtriumVariants, B = G.AtriumBOM;
    let v = null;
    if (V) v = V.current(design, variant);
    const lines = new Map(), notFitted = [];
    const add = (ref, comment, footprint, mpn, manufacturer) => {
      const k = [comment, footprint, mpn].join("\u0001");
      let l = lines.get(k);
      if (!l) { l = {comment, footprint, mpn, manufacturer, designators: []}; lines.set(k, l); }
      l.designators.push(ref);
    };
    if (B?.collect) {
      const c = B.collect(design, {variant: v ? v.id : variant === undefined ? undefined : null});
      for (const e of c.parts) add(e.ref, clean(e.comment), clean(e.footprint), clean(e.mpn), clean(e.manufacturer));
      for (const e of c.dnp || []) notFitted.push(e.ref);
    } else if (V) {
      const res = V.resolve(design, v ? v.id : null);
      for (const row of V.rows(design)) {
        const r = res[row.keys[0]];
        if (!r) continue;
        if (!r.fitted) { notFitted.push(row.ref); continue; }
        const mpn = Object.entries(r.params).find(([k]) => /^(mpn|manufacturer part number|part number)$/i.test(k))?.[1] || "";
        const man = Object.entries(r.params).find(([k]) => /^manufacturer$/i.test(k))?.[1] || "";
        add(row.ref, clean(r.value), row.footprint, clean(mpn), clean(man));
      }
    } else fail("The bill of materials needs variants.js.");
    const natural = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: "base"});
    const out = [...lines.values()].map(l => ({...l, designators: l.designators.sort(natural), quantity: l.designators.length}))
      .sort((a, b) => natural(a.designators[0], b.designators[0]));
    return {variant: v ? {id: v.id, name: v.name} : null, revision: revision ? labelOf(p, revision) : labelOf(p, "working"),
      lines: out, parts: out.reduce((n, l) => n + l.quantity, 0), notFitted: notFitted.sort(natural)};
  }
  function summary(p) {
    const w = working(p), s = storeStats(p);
    return {working: w ? {letter: w.letter, status: w.status, date: w.date || null, from: w.from || null, notes: w.notes || "", locked: locked(p)} : null,
      next: nextLetter(p), store: s,
      revisions: list(p).map(r => ({id: r.id, letter: r.letter, status: r.status, date: r.date, released: r.released || null, from: r.from || null, notes: r.notes || "",
        stored: r.stored || null, outputs: r.outputs || null, checks: (r.checks || []).map(c => ({id: c.id, status: c.status})), overrides: (r.overrides || []).length}))};
  }
  // "<project>-outputs/<rev>": the project file's stem when known (the MCP server and the desktop app use it), else the project name.
  const fileStem = () => { const f = G.AtriumHost?.projectPath; return f ? String(f).split(/[\\/]/).pop().replace(/\.(?:waffle|atrium)$/i, "") : null; };
  const outputsFolder = (p, letter, stem = fileStem()) => String(stem || p?.name || "Project").replace(/[^\w.-]+/g, "_") + "-outputs/" + String(letter).replace(/[^\w.-]+/g, "_");

  // ------------------------------------------------------------ the read-only gate (editor.js)
  let allowing = 0, noticeAt = 0;
  function allow(fn) { allowing++; try { return fn(); } finally { allowing--; } }
  function message(p) {
    const w = working(p);
    return "Rev " + w.letter + " is " + statusLabel(w.status).toLowerCase() + " and read-only. Project › New Revision From… starts Rev " + nextLetter(p) + ".";
  }
  // true: refuse this edit (the working revision is frozen). Notifies at most every 1.5 s (quiet: never).
  function guard(p, quiet) {
    if (allowing || !locked(p)) return false;
    if (quiet) return true;
    const now = Date.now();
    if (now - noticeAt > 1500) {
      noticeAt = now;
      try { if (G.AtriumRevisionsUI?.blocked) G.AtriumRevisionsUI.blocked(p); else G.AtriumNavHost?.info?.(message(p)); } catch { /* notice only */ }
    }
    return true;
  }

  // ------------------------------------------------------------ headless (mcp/commands.py run_command)
  const checksOf = (p, a) => {
    const R = G.AtriumRelease, J = G.AtriumOutputJobs;
    if (!R || !J) return {checks: [], ran: false};
    const job = a.job || J.list(p)[0]?.name || "Generic fab + assembly";
    const pre = R.preflight(p, job, {variants: a.variants, unsaved: false, git: {available: false}});
    return {checks: pre.checks.filter(c => c.id !== "git"), ran: true, job};
  };
  function headless(name, p, a = {}) {
    switch (name) {
      case "list_revisions": return summary(p);
      case "variant_bom": {
        const r = bom(p, {variant: a.variant, revision: a.revision});
        return {variant: r.variant?.name || "base design", revision: r.revision, total: r.parts, count: r.lines.length,
          lines: r.lines.slice(a.offset || 0, (a.offset || 0) + (a.limit || 200)), not_fitted: r.notFitted};
      }
      case "compare_revisions": {
        const D = G.AtriumDiff || fail("Comparing revisions needs diff.js.");
        const c = compare(p, a.before, a.after || "working");
        const res = D.compare(c.before, c.after, {validate: false, geometry: false});
        return {from: c.from, to: c.to, identical: res.summary.identical, total: res.summary.total, text: res.summary.text,
          headline: res.summary.headline, bySeverity: res.summary.bySeverity, ...(a.format === "markdown" ? {markdown: D.toMarkdown(res, {title: "Revision comparison", from: c.from, to: c.to, limit: 200})} : {})};
      }
      case "new_revision": {
        const before = working(p);
        const w = newFrom(p, a.from, {letter: a.letter, notes: a.notes, replaceDraft: a.replace_draft === true});
        return {before: before ? before.letter + " (" + before.status + ")" : null, working: w.letter, status: w.status, from: w.from || null};
      }
      case "release_revision": {
        const pre = checksOf(p, a);
        const R = G.AtriumRelease;
        const blocked = R && pre.ran ? R.blocking(pre.checks, a.overrides || []) : [];
        if (blocked.length) fail("Release blocked by failed checks: " + blocked.map(c => c.label + " (" + c.summary + ")").join("; ") + ". Fix them or pass overrides with a reason.");
        const w = working(p), letter = w && !w.legacy ? w.letter : a.letter || nextLetter(p);
        const entry = freeze(p, {notes: a.notes, letter, checks: pre.checks, overrides: a.overrides, outputs: outputsFolder(p, letter) + "/"});
        return {revision: entry.letter, status: entry.status, date: entry.date, stored: entry.stored, checks: pre.checks.map(c => ({id: c.id, status: c.status, summary: c.summary})),
          checks_ran: pre.ran, outputs: {tool: "release", args: {job: pre.job || "Generic fab + assembly", revision: entry.letter, output_dir: String(entry.letter).replace(/[^\w.-]+/g, "_"), mode: "write"},
            note: "output_dir is relative to <project>-outputs/, so the files land in <project>-outputs/" + entry.letter + "/."}};
      }
      case "set_revision_status": { const r = setStatus(p, a.revision, a.status); return {revision: r.letter, status: r.status}; }
      case "variant_edit": {
        const V = G.AtriumVariants || fail("Variants need variants.js.");
        if (locked(p)) fail(message(p));
        if (a.op === "create") { const v = V.create(p, {name: a.name, description: a.description, from: a.from}); return {variant: v.name, id: v.id}; }
        const v = V.find(p, a.variant) || fail("The project has no variant " + a.variant + ".");
        if (a.op === "rename") { V.rename(p, v.id, {name: a.name ?? v.name, description: a.description ?? v.description}); return {variant: v.name, id: v.id}; }
        if (a.op === "delete") { V.remove(p, v.id); return {deleted: v.name}; }
        if (a.op === "set_parts") {
          const keys = [];
          for (const ref of a.designators || []) {
            const row = V.rows(p).find(r => r.ref.toUpperCase() === String(ref).toUpperCase()) || fail("The project has no component " + ref + ".");
            keys.push(...row.keys);
          }
          const change = a.reset ? {reset: true} : a.fitted != null ? {fitted: a.fitted} : a.alternate !== undefined ? {alternate: a.alternate} : a.params !== undefined ? {params: a.params} : fail("Say what to set: fitted, alternate, params or reset.");
          V.setParts(p, v.id, keys, change);
          return {variant: v.name, designators: a.designators, set: Object.keys(change)[0]};
        }
        fail("Unknown variant operation " + a.op + ".");
      }
    }
    fail("Unknown revisions command " + name + ".");
  }

  // ------------------------------------------------------------ editor wiring
  // The UI module (revisions-ui.js) adds the panel, the status-bar chip and the banner.
  function install(h) {
    const L = G.AtriumLazy, want = () => { const p = h.project?.(); if (p && (p.revision != null || p.revisions != null)) L?.need?.("AtriumRevisionsUI").catch(() => {}); };
    want();
    h.on?.("change", want);
  }
  if (typeof document !== "undefined") G.AtriumNavCommon?.ready?.(install);

  return Object.freeze({LIMIT, ALPHABET, META, STATUS, sha256, canon, encode, decode, reach, working, list, find, locked, statusLabel, nextLetter, letterAt,
    validate, start, setNotes, frozenDesign, freeze, newFrom, setStatus, gc, storeStats, designOf, labelOf, compare, fields, bom, summary, outputsFolder,
    allow, guard, message, headless});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumRevisions;
