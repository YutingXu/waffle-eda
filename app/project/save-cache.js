"use strict";
// AtriumSaveCache: incremental encoding of private editor snapshots.
//
// The snapshot text follows AtriumECO.serialize(p) (eco.js, "layout 2"): keys sorted at every level;
// the project and its containers down to depth 3 one entry per line (two-space indent); each
// deeper value one minified line unless longer than LINE; non-integer numbers below 1e9 to 12
// significant digits. This module produces exactly that text as a list of segments,
// re-serialising only what changed:
//
//   * Containers above FRONTIER (the project, its documents, each document's fields and arrays)
//     are laid out here, the way JSON.stringify(…, null, 2) lays them out.
//   * Nodes at depth FRONTIER (each board item, each library pad, …) are cached. A node is
//     re-serialised only when its compact JSON.stringify differs from the cached one; the check
//     costs one native stringify per node, the canonical text is reused. Undo (undo-store.js)
//     patches the project in place, so unchanged nodes keep their identity; the second index,
//     keyed by the compact text, covers paths that replace objects (a reload, the editor's
//     whole-project snapshot fallback).
//
// A state is {segs, bytes, total, ents}: segs.join("") is the canonical text, bytes[i] is the
// UTF-8 length of segs[i] and total their sum. diff(a, b) turns two states into byte-range hunks
// (prefix/suffix trim, then index-aligned or Myers alignment of the segments), so a one-object
// edit on a 25k-object board becomes a patch of a few hundred bytes.
//
//   AtriumSaveCache.state(p)            -> state (urgent, one go)
//   AtriumSaveCache.job(p, {journal})   -> {step(ms) -> done, result()} (sliced, for autosave)
//   AtriumSaveCache.text(state)         -> canonical text;  serialize(p) -> text
//   AtriumSaveCache.diff(a, b)          -> {size, length, hunks: [[at, del, text]], bytes}
//   AtriumSaveCache.create()            -> an independent instance (tests)
globalThis.AtriumSaveCache = (() => {
  const FRONTIER = 4, LINE = 1024, MAX_D = 64, MERGE_GAP = 256, BIG_KEY = 8192;
  const NONASCII = /[^\x00-\x7f]/;
  const NEEDS_QUOTING = /["\\\x00-\x1f\ud800-\udfff]/;
  const PADS = [];
  const pad = n => PADS[n] ??= " ".repeat(n);
  const skip = x => x === undefined || typeof x === "function" || typeof x === "symbol";
  // The same transforms AtriumECO.serialize uses (eco.js num(), sorted(), layout()).
  const num = Atrium.projectNumber;
  const prim = v => JSON.stringify(typeof v === "number" ? num(v) : v);
  function sorted(v) {
    if (typeof v === "number") return num(v);
    if (Array.isArray(v)) return v.map(sorted);
    if (v === null || typeof v !== "object") return v;
    const o = Object.create(null);
    for (const k of Object.keys(v).sort()) o[k] = sorted(v[k]);
    return o;
  }
  // v is sorted(); d its depth (the project is 0). Values at depth >= FRONTIER fit on one line
  // when their minified text is at most LINE characters.
  function layoutValue(v, d) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (d >= FRONTIER) { const m = JSON.stringify(v); if (m.length <= LINE) return m; }
    const inner = pad(2 * d + 2), outer = pad(2 * d);
    if (Array.isArray(v)) return v.length ? "[\n" + inner + v.map(x => skip(x) ? "null" : layoutValue(x, d + 1)).join(",\n" + inner) + "\n" + outer + "]" : "[]";
    const keys = Object.keys(v).filter(k => !skip(v[k]));
    return keys.length ? "{\n" + inner + keys.map(k => JSON.stringify(k) + ": " + layoutValue(v[k], d + 1)).join(",\n" + inner) + "\n" + outer + "}" : "{}";
  }
  // UTF-8 length of a JSON text (JSON.stringify escapes lone surrogates, so pairs are whole).
  function utf8(s) {
    if (!NONASCII.test(s)) return s.length;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1; else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { n += 4; i++; }
      else n += 3;
    }
    return n;
  }
  // A small string hash for chunk boundaries (stable for an item across edits: its id).
  function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0; }

  function create(env = {}) {
    const G = globalThis;
    let ids = new WeakMap(), byText = new Map(), held = 0;
    // Journal-certified documents (AtriumUndoStore.documentVersions): the item versions of each
    // document when a whole pass last read it. While the undo journal reports the same versions,
    // none of that document's items changed (the store compares every item's JSON itself), so a
    // later pass takes each item's cached entry by identity without stringifying it again. A
    // project the store does not track, or an edit it has not recorded yet, reads every item.
    let certified = new WeakMap();
    const journal = () => G.AtriumUndoStore?.documentVersions ? G.AtriumUndoStore : null;
    const sameVersion = (a, b) => !!a && !!b && a.floor === b.floor && a.items === b.items;
    const largeEntries = new Set();
    const stats = {passes: 0, nodes: 0, made: 0, reused: 0, ms: 0};
    const perf = () => G.performance?.now?.() ?? Date.now();

    // ---- serialisation -------------------------------------------------------------------
    // A node's compact text is its key; a long one (poured copper) is keyed by its length and a
    // 64-bit digest instead, so the cache does not hold a second copy of it.
    function keyOf(c) {
      if (c.length <= BIG_KEY) return c;
      let a = 0x811c9dc5, b = 0x9747b28c;
      for (let i = 0; i < c.length; i++) { const x = c.charCodeAt(i); a = Math.imul(a ^ x, 0x01000193); b = Math.imul(b ^ x, 0x5bd1e995); }
      return "\u0000" + c.length + ":" + (a >>> 0).toString(36) + "." + (b >>> 0).toString(36);
    }
    function make(v, c, depth, raw = c) {
      const t = layoutValue(sorted(v), depth);
      const id = v && typeof v.id === "string" ? v.id : null;
      const e = {c, t, b: utf8(t), d: depth, h: hash(id ?? (raw.length > 64 ? raw.slice(0, 32) + raw.slice(-32) : raw))};
      const previous = byText.get(c);
      if (previous) held -= c.length + previous.t.length;
      byText.set(c, e); held += c.length + t.length;
      if (t.length > BIG_KEY) largeEntries.add(e);
      stats.made++;
      return e;
    }
    function node(v, depth) {
      const raw = JSON.stringify(v), c = keyOf(raw);
      let e = ids.get(v);
      if (e && e.c === c && e.d === depth) { stats.reused++; return e; }
      e = byText.get(c);
      if (!e || e.d !== depth) e = make(v, c, depth, raw); else stats.reused++;
      // A long node (poured copper) is found by its digest: the identity index would keep its text
      // (megabytes) alive for as long as an old copy of the object is (undo, motion), and saves it
      // nothing, since the digest is computed first either way. The content index is pruned.
      if (c === raw && e.t.length <= BIG_KEY) ids.set(v, e);
      return e;
    }
    // Lays out containers above FRONTIER; frontier nodes become placeholders (filled by fill()).
    function layout(root) {
      const segs = [], nodes = [], owners = [];
      const itemsOf = new Map();
      if (Array.isArray(root?.documents)) for (const d of root.documents) if (d && Array.isArray(d.items)) itemsOf.set(d.items, d);
      let s = "", owner = null;
      const largeRegion = r => r && !Array.isArray(r) && typeof r.data === "string" && r.data.length > LINE && Object.prototype.propertyIsEnumerable.call(r, "data");
      function walk(v, depth, expanded = false) {
        if (v === null || typeof v !== "object") { s += prim(v); return; }
        if (depth >= FRONTIER && !expanded) { segs.push(s); s = ""; nodes.push(v, depth, segs.length); owners.push(owner); segs.push(null); return; }
        const inner = pad(2 * depth + 2);
        if (Array.isArray(v)) {
          if (!v.length) { s += "[]"; return; }
          s += "[\n" + inner;
          // The elements of a document's items list carry that document (journal certification).
          const was = owner; owner = depth + 1 === FRONTIER ? itemsOf.get(v) || null : null;
          for (let i = 0; i < v.length; i++) {
            if (i) s += ",\n" + inner;
            const x = v[i];
            if (skip(x)) s += "null"; else walk(x, depth + 1, expanded && largeRegion(x));
          }
          owner = was;
          s += "\n" + pad(2 * depth) + "]";
          return;
        }
        let first = true;
        // Expanded frontier objects use the canonical sorted object's enumeration order, including integer keys.
        let keys = Object.keys(v).sort();
        if (expanded) {
          const order = Object.create(null);
          for (const k of keys) order[k] = true;
          keys = Object.keys(order);
        }
        for (const k of keys) {
          const x = v[k];
          if (skip(x)) continue;
          s += (first ? "{\n" : ",\n") + inner + JSON.stringify(k) + ": ";
          first = false;
          // A long data string guarantees both this region and its pours array exceed LINE.
          // Keep the immutable encoded copper as a segment shared with the model. An edit to one
          // region then leaves the other regions' storage chunks and native patch ranges intact.
          if (expanded && k === "data") {
            if (NEEDS_QUOTING.test(x)) { segs.push(s, JSON.stringify(x)); s = ""; }
            else { segs.push(s + '"', x); s = '"'; }
          } else {
            const pours = depth + 1 === FRONTIER && k === "pours" && Array.isArray(x) && x.some(largeRegion);
            walk(x, depth + 1, pours);
          }
        }
        s += first ? "{}" : "\n" + pad(2 * depth) + "}";
      }
      walk(root, 0);
      segs.push(s + "\n");
      return {segs, nodes, owners};
    }
    // Sliced pass: step(ms) works for about ms and returns true when done.
    // o.journal: certify unchanged documents through the undo journal (autosave). Explicit saves and
    // serialize() read every item.
    function job(p, o = {}) {
      const t0 = perf(), {segs, nodes, owners} = layout(p), ents = new Array(segs.length), liveLarge = new Set();
      let i = 0, spent = perf() - t0, done = null;
      stats.made = stats.reused = 0; stats.certified = 0;
      // Versions now, per document; a document whose versions are unchanged since the last pass
      // that read it is certified, and is certified again at the end only if they still hold.
      const U = o.journal ? journal() : null, at0 = new Map();
      const versions = o.documentVersions || (U && (d => U.documentVersions(d, p)));
      if (versions && Array.isArray(p?.documents)) for (const d of p.documents) at0.set(d, versions(d));
      const trusted = new Map();
      const certifiedNow = d => {
        if (!d || !versions) return false;
        let t = trusted.get(d);
        if (t === undefined) { t = sameVersion(at0.get(d), certified.get(d)); trusted.set(d, t); }
        return t && sameVersion(versions(d), at0.get(d));
      };
      return {
        step(ms = Infinity) {
          if (done) return true;
          const t = perf();
          while (i < nodes.length) {
            const v = nodes[i], depth = nodes[i + 1], c = ids.get(v);
            const e = c && c.d === depth && certifiedNow(owners[i / 3]) ? (stats.reused++, stats.certified++, c) : node(v, depth), at = nodes[i + 2];
            segs[at] = e.t; ents[at] = e;
            if (e.t.length > BIG_KEY) liveLarge.add(e);
            i += 3;
            if ((i & 63) === 0 && perf() - t >= ms) { spent += perf() - t; return false; }
          }
          const bytes = new Array(segs.length);
          let total = 0;
          for (let j = 0; j < segs.length; j++) { const n = ents[j] ? ents[j].b : utf8(segs[j]); bytes[j] = n; total += n; }
          done = {segs, bytes, total, ents};
          spent += perf() - t;
          prune(ents, nodes.length / 3, liveLarge);
          // Every item of each document was read (or certified) in this pass at these versions.
          for (const [d, v0] of at0) { if (v0 && sameVersion(versions(d), v0)) certified.set(d, v0); else certified.delete(d); }
          Object.assign(stats, {passes: stats.passes + 1, nodes: nodes.length / 3, ms: spent});
          return true;
        },
        result() { if (!done) this.step(); return done; },
        get ms() { return spent; }
      };
    }
    // Drop content-index entries no live node uses once the index outgrows the live set by a
    // quarter, in entries or in text (after an undo, priming from the opened file or repours, whose
    // few regions are large, most old entries are dead).
    function prune(ents, live, liveLarge) {
      // A superseded copper link array can be megabytes. Only a recovery snapshot or native
      // journal baseline that actually uses its old bytes needs to retain them after this pass.
      for (const e of largeEntries) if (!liveLarge.has(e)) {
        if (byText.get(e.c) === e) { byText.delete(e.c); held -= e.c.length + e.t.length; }
        largeEntries.delete(e);
      }
      let size = 0;
      if (byText.size <= live * 1.25 + 1024) { for (const e of ents) if (e) size += e.c.length + e.t.length; if (held <= size * 1.25 + 1048576) return; }
      const keep = new Map();
      held = 0; largeEntries.clear();
      for (const e of ents) if (e && !keep.has(e.c)) {
        keep.set(e.c, e); held += e.c.length + e.t.length;
        if (e.t.length > BIG_KEY) largeEntries.add(e);
      }
      byText = keep;
    }
    const state = p => job(p).result();
    const text = st => st.segs.join("");
    const serialize = p => text(state(p));

    // ---- diff ------------------------------------------------------------------------------
    function offsets(st) {
      if (st.offsets) return st.offsets;
      const o = new Float64Array(st.segs.length + 1);
      for (let i = 0; i < st.segs.length; i++) o[i + 1] = o[i] + st.bytes[i];
      return st.offsets = o;
    }
    // Myers' O(ND) alignment of A[a0,a1) and B[b0,b1) by ===, at most MAX_D edits; hunks
    // [aStart, aEnd, bStart, bEnd] in order, or null when the sequences differ more than that.
    function myers(A, a0, a1, B, b0, b1) {
      const N = a1 - a0, M = b1 - b0, max = Math.min(MAX_D, N + M), off = max + 1, V = new Int32Array(2 * max + 3), trace = [];
      for (let d = 0; d <= max; d++) {
        trace.push(V.slice());
        for (let k = -d; k <= d; k += 2) {
          let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1, y = x - k;
          while (x < N && y < M && A[a0 + x] === B[b0 + y]) { x++; y++; }
          V[off + k] = x;
          if (x >= N && y >= M) {
            const out = [];
            let cx = N, cy = M;
            for (let e = d; e > 0; e--) {
              const W = trace[e], ck = cx - cy;
              const pk = ck === -e || (ck !== e && W[off + ck - 1] < W[off + ck + 1]) ? ck + 1 : ck - 1;
              const px = W[off + pk], py = px - pk;
              while (cx > px && cy > py) { cx--; cy--; }
              out.push(cx === px ? [px, px, py, py + 1] : [px, px + 1, py, py]);
              cx = px; cy = py;
            }
            out.reverse();
            const merged = [];
            for (const h of out) {
              const prev = merged[merged.length - 1];
              if (prev && prev[1] === h[0] && prev[3] === h[2]) { prev[1] = h[1]; prev[3] = h[3]; } else merged.push(h);
            }
            return merged.map(h => [h[0] + a0, h[1] + a0, h[2] + b0, h[3] + b0]);
          }
        }
      }
      return null;
    }
    function diff(a, b) {
      const A = a.segs, B = b.segs, n = A.length, m = B.length;
      let p = 0, s = 0;
      while (p < n && p < m && A[p] === B[p]) p++;
      while (s < n - p && s < m - p && A[n - 1 - s] === B[m - 1 - s]) s++;
      let spans = [];
      if (n - s - p === m - s - p) {
        for (let i = p; i < n - s; i++) if (A[i] !== B[i]) {
          const prev = spans[spans.length - 1];
          if (prev && prev[1] === i) { prev[1] = prev[3] = i + 1; } else spans.push([i, i + 1, i, i + 1]);
        }
      } else if (p < n - s || p < m - s) spans = myers(A, p, n - s, B, p, m - s) || [[p, n - s, p, m - s]];
      // Merge hunks separated by little unchanged text: fewer, slightly larger hunks.
      const ao = offsets(a), bo = offsets(b), merged = [];
      for (const h of spans) {
        const prev = merged[merged.length - 1];
        if (prev && ao[h[0]] - ao[prev[1]] < MERGE_GAP && h[0] - prev[1] === h[2] - prev[3]) { prev[1] = h[1]; prev[3] = h[3]; } else merged.push(h.slice());
      }
      let bytes = 0;
      const hunks = merged.map(([a0, a1, b0, b1]) => { bytes += bo[b1] - bo[b0]; return [ao[a0], ao[a1] - ao[a0], B.slice(b0, b1).join("")]; });
      return {size: a.total, length: b.total, hunks, bytes};
    }
    // Content-defined chunks of a state for recovery storage: boundaries after nodes whose hash
    // has its low bits clear, so an insertion moves one boundary at most. Each chunk is
    // {segs: [first, end), key}; a chunk whose segments are the same as in `prev` keeps its key.
    function chunks(st, prev, {mask = 63, maxBytes = 262144} = {}) {
      const out = [], before = new Map(), probe = (x, c) => (c.first + 1 < c.end && x.ents[c.first + 1]) || x.ents[c.first] || x.segs[c.first];
      if (prev) for (const c of prev.list) before.set(probe(prev.state, c), c);
      let first = 0, size = 0;
      const close = end => {
        const c = {first, end, key: null, bytes: size}, old = before.get(probe(st, c));
        if (old && old.end - old.first === end - first) {
          c.key = old.key;
          for (let i = 0; i < end - first; i++) if (prev.state.segs[old.first + i] !== st.segs[first + i]) { c.key = null; break; }
        }
        out.push(c);
        first = end; size = 0;
      };
      for (let i = 0; i < st.segs.length; i++) {
        // A single large payload gets its own key. Changing adjacent metadata needn't join or
        // rewrite a megabyte string in recovery storage.
        if (st.bytes[i] >= maxBytes && i > first) close(i);
        size += st.bytes[i];
        const e = st.ents[i];
        if ((e && (e.h & mask) === 0) || size >= maxBytes) close(i + 1);
      }
      if (first < st.segs.length || !out.length) close(st.segs.length);
      return {state: st, list: out};
    }
    const chunkText = (st, c) => c.end === c.first + 1 ? st.segs[c.first] : st.segs.slice(c.first, c.end).join("");

    return {state, job, text, serialize, diff, chunks, chunkText, utf8, sorted,
      stats: () => {
        let cacheChars = 0;
        for (const e of byText.values()) cacheChars += e.c.length + e.t.length;
        return {...stats,byText:byText.size,cacheChars};
      },
      reset() { ids=new WeakMap(); byText=new Map(); certified=new WeakMap(); largeEntries.clear(); held=0; }};
  }
  const api = create();
  return Object.freeze({...api, create, constants: {FRONTIER, MAX_D}});
})();
