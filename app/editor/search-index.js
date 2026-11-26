"use strict";
// Search index for the command palette's "search everything" box (lazy: palette.js loads it on
// the editor's idle prefetch and builds it in idle slices, so first paint never waits for it).
//
// One inverted index over every source: commands (titles, keywords, menu paths), components
// (designator, value, comment, footprint, library ref), nets and net classes, documents, ports
// and labels, library parts, recent files, preferences and help headings. A query is split into
// tokens; each token matches index tokens exactly, by prefix, or within one or two edits
// (Damerau / optimal string alignment, scaled by length; none for tokens with digits, so R12
// never matches R13). Short sources (commands, settings, documents, help) also match as
// subsequences and acronyms ("ucb" → Update PCB, "tdr" → Teardrops). Text is normalised
// (NFKC, U+2212 minus, Ω → ohm, µ → u, ± → +-, accents dropped), so "10kΩ", "10 kohm" and "10k"
// meet. Ranking blends match quality, kind (exact designator > command > library part), the
// current document, and local frequency and recency of use.
//
// Records are maintained incrementally: sync(project, defs) is a generator that diffs each
// document's searchable items against fingerprints from the last pass and re-indexes only the
// items that changed (an O(items) scan with no allocation for unchanged items). Removed records
// leave stale postings that searches skip; the index compacts itself when they outnumber live ones.
//
// Pure API (no DOM): create() -> index {put, remove, has, get, setGroup, search, byLabel, sync,
//   stats, size}; norm(text); tokens(text); osa(a, b, k, prefix); runIdle(gen, done); runNow(gen).
globalThis.AtriumSearchIndex = (() => {
  // ------------------------------------------------------------------ text
  const ASCII = /^[\x00-\x7f]*$/;
  const SUBST = [[/[−‐-―﹣－]/g, "-"], [/[ΩΩω]/g, "ohm"], [/[µμ]/g, "u"],
    [/±|\+\/-/g, "+-"], [/×/g, "x"], [/°/g, "deg"], [/[‘’]/g, "'"], [/…/g, "..."]];
  // Lower case, compatibility-normalised, with EDA symbols spelt the way people type them.
  function norm(text) {
    let s = String(text ?? "");
    if (!ASCII.test(s)) {
      s = s.normalize("NFKC");
      for (const [re, to] of SUBST) s = s.replace(re, to);
      s = s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
    } else if (s.includes("+/-")) s = s.replace(/\+\/-/g, "+-");
    return s.toLowerCase();
  }
  // Words: letters and digits, with decimal points kept inside numbers ("4.7uf", "0.1").
  const WORD = /[a-z0-9]+(?:\.[0-9][a-z0-9]*)*/g;
  function tokens(text) {
    const raw = String(text ?? "");
    const out = norm(raw).match(WORD) || [];
    // camelCase and PascalCase parts too ("netClass" → net, class), alongside the whole word.
    if (/[a-z][A-Z]/.test(raw)) for (const t of norm(raw.replace(/([a-z])([A-Z])/g, "$1 $2")).match(WORD) || []) if (!out.includes(t)) out.push(t);
    return out;
  }
  // Initials of the words ("Update PCB Document" → "upd").
  function initials(n) {
    let s = "";
    for (const w of n.match(WORD) || []) s += w[0];
    return s;
  }
  const isBoundary = c => c === 32 || c === 45 || c === 46 || c === 47 || c === 95 || c === 58 || c === 40 || c === 41 || c === 8250 /* › */;

  // ------------------------------------------------------------------ edit distance
  // Optimal string alignment distance (transpositions count as one edit) between a and b, or
  // k + 1 as soon as it must exceed k. prefix: the distance from a to the closest prefix of b.
  let R0 = new Int32Array(66), R1 = new Int32Array(66), R2 = new Int32Array(66);
  function osa(a, b, k, prefix = false) {
    const n = a.length, m = prefix ? Math.min(b.length, n + k) : b.length;
    if (!prefix && Math.abs(n - m) > k) return k + 1;
    if (n > 64 || m > 64) return k + 1;
    let pp = R0, p = R1, c = R2;
    for (let j = 0; j <= m; j++) p[j] = j;
    for (let i = 1; i <= n; i++) {
      c[0] = i;
      let rowMin = i;
      const ai = a.charCodeAt(i - 1), ap = i > 1 ? a.charCodeAt(i - 2) : -1;
      for (let j = 1; j <= m; j++) {
        const bj = b.charCodeAt(j - 1);
        let v = p[j - 1] + (ai === bj ? 0 : 1);
        if (p[j] + 1 < v) v = p[j] + 1;
        if (c[j - 1] + 1 < v) v = c[j - 1] + 1;
        if (j > 1 && ai === b.charCodeAt(j - 2) && ap === bj && pp[j - 2] + 1 < v) v = pp[j - 2] + 1;
        c[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > k) return k + 1;
      const t = pp; pp = p; p = c; c = t;
    }
    if (!prefix) return p[m];
    let best = k + 1;
    for (let j = Math.max(0, n - k); j <= m; j++) if (p[j] < best) best = p[j];
    return best;
  }
  // Letters-present mask: one edit changes at most two bits, so popcount(a ^ b) > 2k rules a token out.
  function mask(s) {
    let m = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      m |= c >= 97 && c <= 122 ? 1 << (c - 97) : c >= 48 && c <= 57 ? 1 << (26 + (c - 48) % 6) : 0;
    }
    return m;
  }
  function popcount(x) {x -= (x >>> 1) & 0x55555555; x = (x & 0x33333333) + ((x >>> 2) & 0x33333333); return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;}
  // Edits a query word may have: none for words with digits (designators, values), a swap for
  // three letters, one edit up to seven letters, two from eight.
  const allowed = w => /\d/.test(w) || w.length < 3 ? 0 : w.length < 8 ? 1 : 2;
  const swapped = (a, b) => {
    if (a.length !== b.length) return false;
    let i = 0;
    while (i < a.length && a[i] === b[i]) i++;
    return i < a.length - 1 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
  };

  // ------------------------------------------------------------------ subsequence (short sources)
  // fzf-style: the first letter must start a word; word starts and runs score high. Tries a
  // word-start-preferring walk and a plain greedy walk and keeps the better. Returns points per
  // query letter (0 when no match).
  function subsequence(q, t) {
    let best = 0;
    for (let mode = 0; mode < 2; mode++) {
      let ti = 0, score = 0, prev = -2, ok = true, words = 1;
      for (let qi = 0; qi < q.length; qi++) {
        const ch = q.charCodeAt(qi);
        let at = -1;
        if (mode === 0 || qi === 0) {
          // The next occurrence at a word start, unless the letter continues the current run.
          if (qi > 0 && t.charCodeAt(prev + 1) === ch) at = prev + 1;
          else for (let k = ti; k < t.length; k++) if (t.charCodeAt(k) === ch && (k === 0 || isBoundary(t.charCodeAt(k - 1)))) {at = k; break;}
          if (at < 0 && qi > 0) at = t.indexOf(q[qi], ti);
        } else at = t.indexOf(q[qi], ti);
        if (at < 0) {ok = false; break;}
        const start = at === 0 || isBoundary(t.charCodeAt(at - 1));
        score += start ? 10 : at === prev + 1 ? 6 : 1;
        // Whole words jumped over between two letters cost: "tdr" is Teardrops, not T… Re-Route… Drag.
        if (qi > 0) {
          let skipped = 0;
          for (let k = prev + 2; k < at; k++) if (isBoundary(t.charCodeAt(k - 1)) && !isBoundary(t.charCodeAt(k))) skipped++;
          if (skipped && !start) skipped--; // the word this letter is in
          if (skipped || start) words++;
          score -= 3 * skipped;
        }
        prev = at; ti = at + 1;
      }
      // All letters inside one word ("tdr" in teardrops) reads as an abbreviation of that word.
      const per = ok ? score / q.length + (words === 1 ? 2 : 0) : 0;
      if (per > best) best = per;
    }
    return best;
  }

  // ------------------------------------------------------------------ index
  const FAMILY = 3, FIELD = [1, .9, .5, .5]; // label, keywords, detail, family names
  // Kind weights: an exact designator outranks a command, a command outranks a library part.
  const KIND = {pin: 60, component: 30, command: 60, document: 35, net: 28, netclass: 22, port: 22, file: 25, setting: 12, library: -10, help: -5, insert: 45, notebook: 22, answer: 90, location: 0};
  const PREFIX_LIMIT = 160, BROAD = 4000, WIDE_TERMS = 24;
  const prefixQuality = (length, wordLength) => length === wordLength ? 100 : 62 + 30 * length / wordLength;
  const SMALL = new Set(["command", "setting", "document", "help", "file", "netclass", "insert", "notebook", "answer"]);

  function create() {
    const recs = [];              // id -> record or null (removed)
    const byKey = new Map();      // key -> id
    const tokId = new Map();      // token -> token id
    const tokStr = [], tokPost = [], libraryPost = [], tokMask = [];
    const byFirst = new Map();    // first char code -> token ids
    const byLen = [];             // length -> token ids
    const groups = new Map();     // source -> {src, keys}
    const byKind = new Map();     // empty-query suggestions and short-source acronym candidates
    const smallIds = new Set();
    const labels = new Map();     // normalised label -> Set of ids (designators, nets)
    let live = 0, dead = 0, version = 0, cache = new Map();
    let libraryVersion = 0, preparedLibrary = null, wideLibrary = null;
    const state = {docs: new Map(), titles:new Map(), netDocs: new Map(), lib: new Map()};

    // Grow workspaces in the idle indexing pass. A first broad keystroke should
    // never allocate buffers proportional to the size of the user's part library.
    let seenWord = new Float64Array(0), sums = new Float64Array(0), matched = new Uint16Array(0);
    let candidates = new Uint32Array(0), touched = new Uint32Array(0), labelMasks = new Uint32Array(0);
    function capacity(id) {
      if (id < sums.length) return;
      const size = Math.max(256,sums.length * 2);
      seenWord = new Float64Array(size); sums = new Float64Array(size); matched = new Uint16Array(size);
      candidates = new Uint32Array(size); touched = new Uint32Array(size);
      const previous = labelMasks;
      labelMasks = new Uint32Array(size); labelMasks.set(previous);
    }
    function tokenOf(t) {
      let id = tokId.get(t);
      if (id !== undefined) return id;
      id = tokStr.length;
      tokId.set(t, id); tokStr.push(t); tokPost.push([]); libraryPost.push(null); tokMask.push(mask(t));
      const f = t.charCodeAt(0);
      let b = byFirst.get(f); if (!b) byFirst.set(f, b = []); b.push(id);
      // Whole-word fuzzy queries contain no digits and allow at most two edits.
      // Longer numeric designators still participate in exact and fuzzy prefixes.
      let digits = 0;
      for (let j = 0; j < t.length && digits < 3; j++) {
        const c = t.charCodeAt(j);
        if (c >= 48 && c <= 57) digits++;
      }
      if (digits < 3) (byLen[t.length] ||= []).push(id);
      return id;
    }
    // rec: {key, kind, label, detail?, keywords?, compact?, ...anything the caller needs back}
    function put(rec) {
      if (byKey.has(rec.key)) remove(rec.key);
      const id = recs.length; capacity(id);
      rec.ln = norm(rec.label);
      rec.lt = null; // label token ids, filled below
      rec.kw ||= "";
      if (SMALL.has(rec.kind)) {rec.ini = initials(rec.ln); rec.kn = norm(rec.kw); rec.k0 = (norm(rec.syn ?? rec.kw).match(WORD) || [""])[0];}
      recs.push(rec); byKey.set(rec.key, id); live++;
      const seen = new Map();
      const field = (text, f) => {for (const t of tokens(text)) if (!seen.has(t)) seen.set(t, f);};
      field(rec.label, 0);
      // Short titles also as joined word pairs, so "netlabel" finds Net Label and "fitall" Fit All.
      if (rec.ini) {const w = rec.ln.match(WORD) || []; if (w.length <= 6) for (let j = 1; j < w.length; j++) {const t = w[j - 1] + w[j]; if (!seen.has(t)) seen.set(t, 0);}}
      field(rec.kw, 1); field(rec.detail, 2);
      // Values without their spaces too: "10 kΩ" also as "10kohm", so "10k" finds it.
      if (rec.compact) {const c = norm(rec.compact).replace(/[^a-z0-9.]+/g, ""); if (c && !seen.has(c)) seen.set(c, 1);}
      if (rec.kind === "library" && rec.def) {
        if (rec.family) field(rec.family, FAMILY);
        libraryVersion++;
        rec.libraryMask = (rec.def.symbol || rec.def.stub?.symbol ? 1 : 0) | (rec.def.footprint || rec.def.stub?.footprint ? 2 : 0);
        rec.terms = [];
        labelMasks[id] = mask(rec.ln);
        for (const [t,f] of seen) {
          const token = tokenOf(t);
          rec.terms.push(token * 4 + f);
          (libraryPost[token] ||= []).push(id * 4 + f);
        }
        if (preparedLibrary) prepareRecord(preparedLibrary,rec);
      } else for (const [t,f] of seen) tokPost[tokenOf(t)].push(id * 4 + f);
      rec.lt = tokens(rec.label).map(t => tokId.get(t));
      if (rec.byLabel) {let s = labels.get(rec.ln); if (!s) labels.set(rec.ln, s = new Set()); s.add(id);}
      let ids = byKind.get(rec.kind);
      if (!ids) byKind.set(rec.kind, ids = new Set());
      ids.add(id);
      if (rec.ini) smallIds.add(id);
      version++;
      return rec;
    }
    function remove(key) {
      const id = byKey.get(key);
      if (id === undefined) return false;
      const rec = recs[id];
      if (rec.terms) {libraryVersion++; preparedLibrary = wideLibrary = null;}
      if (rec.byLabel) {const s = labels.get(rec.ln); s?.delete(id); if (s && !s.size) labels.delete(rec.ln);}
      recs[id] = null; byKey.delete(key); byKind.get(rec.kind)?.delete(id); smallIds.delete(id); live--; dead++; version++;
      if (dead > 2000 && dead > live) compact();
      return true;
    }
    // Rebuild postings from the live records (stale postings and empty tokens go).
    function compact() {
      const keep = recs.filter(Boolean);
      recs.length = 0; byKey.clear(); tokId.clear(); tokStr.length = 0; tokPost.length = 0; libraryPost.length = 0; tokMask.length = 0;
      byFirst.clear(); byLen.length = 0; labels.clear(); byKind.clear(); smallIds.clear(); live = 0; dead = 0;
      for (const r of keep) put(r);
    }
    // Replace a whole small source (commands, files, settings…) by key; unchanged entries stay.
    function setGroup(name, list) {
      const g = groups.get(name);
      if (g && g.src === list) return;
      const keys = new Set();
      for (const e of list) {
        keys.add(e.key);
        const id = byKey.get(e.key), old = id === undefined ? null : recs[id];
        const kw = [e.keywords, e.alias].filter(Boolean).join(" ");
        if (old && old.kind === e.kind && old.label === e.label && old.detail === (e.detail || "") && old.kw === kw) {old.e = e; old.boost = e.boost || 0; old.docId = e.target?.docId; continue;}
        put({key: e.key, kind: e.kind, label: e.label, detail: e.detail || "", kw, syn: e.keywords || "", e, docId: e.target?.docId, boost: e.boost || 0});
      }
      if (g) for (const k of g.keys) if (!keys.has(k)) remove(k);
      if (keys.size) groups.set(name, {src: list, keys});
      else groups.delete(name);
    }

    // Token ids matching one query word, with a quality 0..100.
    function matchWord(w, last, localOnly = false) {
      const cacheKey = (localOnly ? "!" : "") + (last ? w : w + " ");
      const hit = cache.get(cacheKey);
      if (hit) return hit;
      const out = new Map(), wl = w.length;
      const add = (id, q) => {if (!(out.get(id) >= q)) out.set(id, q);};
      const exact = tokId.get(w);
      if (exact !== undefined && (!localOnly || tokPost[exact].length)) add(exact, 100);
      // Prefixes (every word: "upd pcb" and "pcb upd" both work).
      for (const id of byFirst.get(w.charCodeAt(0)) || []) {
        if (localOnly && !tokPost[id].length) continue;
        const t = tokStr[id];
        if (t.length > wl && t.startsWith(w)) add(id, prefixQuality(wl,t.length));
      }
      const k = allowed(w);
      if (k > 0) {
        const mw = mask(w);
        for (let len = Math.max(1, wl - k); len <= wl + k; len++) for (const id of byLen[len] || []) {
          if ((localOnly && !tokPost[id].length) || out.has(id) || popcount(tokMask[id] ^ mw) > 2 * k) continue;
          const t = tokStr[id];
          if (wl === 3) {if (swapped(w, t)) add(id, 50); continue;}
          const d = osa(w, t, k);
          if (d <= k) add(id, 70 - 20 * d - (t.charCodeAt(0) !== w.charCodeAt(0) ? 6 : 0));
        }
        // The word being typed, with a typo, as the start of a longer word ("updt" → update).
        const first = w.charCodeAt(0), second = w.charCodeAt(1);
        if (last && wl >= 4) for (const f of first === second ? [first] : [first,second]) for (const id of byFirst.get(f) || []) {
          const t = tokStr[id];
          if ((localOnly && !tokPost[id].length) || t.length <= wl || out.has(id)) continue;
          const d = osa(w, t, k, true);
          if (d <= k) add(id, 45 - 15 * (d - 1));
        }
      }
      if (cache.size > 200) cache.clear();
      cache.set(cacheKey, out);
      return out;
    }

    // Cache bounded results for common one- and two-character library queries. These
    // prefixes have no typo allowance. Use the same indexed fields, scores and stable
    // comparator as search(). Partition by available geometry so each editor reads
    // precisely its own candidates. New or changed library postings invalidate the cache.
    function addPrepared(bins, record, score) {
      const bucket = bins[record.libraryMask] ||= {total:0,hits:[]};
      const hits = bucket.hits;
      bucket.total++;
      if (hits.length < PREFIX_LIMIT || compareHit(score,record,hits[0]) < 0)
        heapPut(hits,PREFIX_LIMIT,{rec:record,score});
    }
    function prepareRecord(cache,r) {
      for (const code of r.terms) {
        const tid = code >> 2, t = tokStr[tid], field = code & 3;
        for (let n=0; n<2 && n<t.length; n++) {
          let slot = cache.tokens[n][tid];
          if (!slot) {
            const q = t.slice(0,n+1);
            slot = cache.heads.get(q);
            if (!slot) cache.heads.set(q,slot = {q,best:0,ordinary:0,bins:[]});
            cache.tokens[n][tid] = slot;
          }
          if (!slot.best) cache.touched.push(slot);
          const score = prefixQuality(n+1,t.length) * FIELD[field];
          slot.best = Math.max(slot.best,score);
          if (field !== FAMILY) slot.ordinary = Math.max(slot.ordinary,score);
        }
      }
      for (const slot of cache.touched) {
        // Only prefixes whose results change for a family need an enhanced
        // head. Both profiles reuse the same pass over live library postings.
        if (slot.best !== slot.ordinary && !slot.enhanced)
          slot.enhanced = slot.bins.map(b=>b && {total:b.total,hits:b.hits.slice()});
        const bonus = titleBonus(r.ln,slot.q);
        if (slot.enhanced) addPrepared(slot.enhanced,r,slot.best + bonus);
        if (slot.ordinary) addPrepared(slot.bins,r,slot.ordinary + bonus);
        slot.best = slot.ordinary = 0;
      }
      cache.touched.length = 0;
    }
    function* prepareLibrary(large = (byKind.get("library")?.size || 0) > BROAD) {
      if (!large || preparedLibrary) return;
      const cache = {heads:new Map(),tokens:[[],[]],touched:[]}, revision = libraryVersion;
      let count = 0;
      for (const id of byKind.get("library") || []) {
        if (++count % 64 === 0) yield;
        if (recs[id]?.terms) prepareRecord(cache,recs[id]);
      }
      if (revision === libraryVersion) preparedLibrary = cache;
    }
    // The largest library postings get bounded, stable heads and membership bits.
    // Each field has a constant score for a given token match. Geometry is fixed
    // by the completed index, and family terms are only eligible for prefixes.
    function* prepareWideLibrary() {
      if (wideLibrary?.version === libraryVersion || (byKind.get("library")?.size || 0) <= BROAD) return;
      const version = libraryVersion, size = Math.ceil(recs.length / 32), terms = new Map();
      const widest = [];
      for (let id=0; id<libraryPost.length; id++) {
        if (libraryPost[id]?.length > BROAD) widest.push(id);
        if (id % 4096 === 4095) yield;
      }
      widest.sort((a,b) => libraryPost[b].length-libraryPost[a].length || a-b);
      for (const token of widest.slice(0,WIDE_TERMS)) {
        const profile = () => ({
          ordinary:new Uint32Array(size), family:new Uint32Array(size),
          ordinaryCount:0, familyCount:0, heads:[[],[],[],[]]
        });
        const profiles = [null,profile(),profile()];
        const posts = libraryPost[token];
        for (let i=0; i<posts.length; i++) {
          if (i % 192 === 191) yield;
          const code = posts[i], id = code >> 2, field = code & 3, r = recs[id];
          if (!r) continue;
          for (const view of [1,2]) {
            if (!(view & r.libraryMask)) continue;
            const p = profiles[view], family = field === FAMILY;
            const bits = family ? p.family : p.ordinary;
            bits[id >>> 5] |= 1 << (id & 31);
            if (family) p.familyCount++; else p.ordinaryCount++;
            const h = p.heads[field];
            if (h.length < PREFIX_LIMIT || compareHit(0,r,h[0]) < 0) heapPut(h,PREFIX_LIMIT,{rec:r,score:0});
          }
        }
        terms.set(token,profiles);
      }
      if (version === libraryVersion) wideLibrary = {version,terms,bits:new Uint32Array(size)};
    }

    // A record's score uses the best of its matched postings. For one word,
    // the top K of each field/posting covers the combined top K, plus records
    // with a title or usage boost. Membership bits count the entire union,
    // including records outside those heads.
    function wideHits(q, matches, view, library, allowFamilies, limit) {
      const wide = wideLibrary;
      if (!library || wide?.version !== libraryVersion || (view !== 1 && view !== 2) || limit > PREFIX_LIMIT) return null;
      let broad = false, narrow = 0;
      for (const id of matches.keys()) {
        const p = wide.terms.get(id)?.[view];
        if (!p) narrow += libraryPost[id]?.length || 0;
        else if (p.ordinaryCount + (allowFamilies && tokStr[id].startsWith(q) ? p.familyCount : 0) > BROAD) broad = true;
      }
      if (!broad || narrow > BROAD || [...library.usage.values()].some(value => value < 0)) return null;

      const bits = wide.bits, found = new Set();
      bits.fill(0);
      for (const token of matches.keys()) {
        const useFamily = allowFamilies && tokStr[token].startsWith(q);
        const p = wide.terms.get(token)?.[view];
        if (p) {
          for (let i=0; i<bits.length; i++) bits[i] |= p.ordinary[i] | (useFamily ? p.family[i] : 0);
          for (let f=0; f<(useFamily ? 4 : 3); f++) for (const h of p.heads[f]) found.add(h.rec);
        } else for (const code of libraryPost[token] || []) {
          const id = code >> 2, r = recs[id];
          if (!r || !(r.libraryMask & view) || ((code & 3) === FAMILY && !useFamily)) continue;
          bits[id >>> 5] |= 1 << (id & 31);
          found.add(r);
        }
      }
      const includes = id => !!(bits[id >>> 5] & (1 << (id & 31)));
      const keyMask = mask(q);
      let titleExceptions = 0;
      for (let id=0, end=Math.min(recs.length,bits.length*32); id<end; id++) {
        if ((labelMasks[id] & keyMask) !== keyMask || !includes(id)) continue;
        const r = recs[id];
        if (!r.ln.includes(q) || found.has(r)) continue;
        // Common literal MPNs already rank quickly through their ordinary posting.
        if (++titleExceptions > PREFIX_LIMIT * 2) return null;
        found.add(r);
      }
      for (const key of library.usage.keys()) {
        const id = byKey.get(key);
        if (id !== undefined && includes(id)) found.add(recs[id]);
      }
      const hits = [];
      for (const r of found) {
        let best = 0;
        for (const code of r.terms) {
          const token = code >> 2, field = code & 3;
          if (field === FAMILY && (!allowFamilies || !tokStr[token].startsWith(q))) continue;
          best = Math.max(best,(matches.get(token) || 0) * FIELD[field]);
        }
        let score = best + ((r.ln === library.exact ? 35 : 0) + KIND.library + (library.usage.get(r.key) || 0));
        score += titleBonus(r.ln,q);
        if (hits.length < limit || compareHit(score,r,hits[0]) < 0) heapPut(hits,limit,{rec:r,score});
      }
      let total = 0;
      for (const word of bits) total += popcount(word);
      return {hits,total};
    }

    function libraryScore(rec, q, allowFamilies) {
      let best = 0;
      for (const code of rec.terms) {
        const t = tokStr[code >> 2];
        const field = code & 3;
        if ((allowFamilies || field !== FAMILY) && t.startsWith(q)) best = Math.max(best,prefixQuality(q.length,t.length) * FIELD[field]);
      }
      return best && best + titleBonus(rec.ln,q);
    }

    // Reuse dense score buffers across keystrokes. Zero means "not a candidate"; every
    // posting is positive. Only touched slots are cleared, even on sparse MPN queries.
    function search(query, opts = {}) {
      const t0 = now(), qn = norm(query).trim(), words = tokens(query);
      const kinds = opts.kinds, allowedRecord = r => (!kinds || kinds.has(r.kind)) && (!opts.filter || opts.filter(r));
      const buckets = new Map(), limit = opts.limit || 120;
      let nCandidates = 0, nTouched = 0, total = 0;
      function accept(r, score) {
        const group = opts.group?.(r) || "";
        let bucket = buckets.get(group);
        if (!bucket) buckets.set(group,bucket = {total:0,hits:[]});
        total++; bucket.total++;
        const h = bucket.hits;
        if (h.length === limit && compareHit(score,r,h[0]) >= 0) return;
        heapPut(h,limit,{rec:r,score});
      }
      const use = opts.usage, cur = opts.currentDoc;
      const extras = r => (opts.bonus?.(r) || 0) + (KIND[r.kind] || 0) + (r.boost || 0) + (cur && r.docId === cur ? 15 : 0) + (use?.(r.key) || 0);
      function finish() {
        const top = [], totalByGroup = new Map();
        for (const [name,bucket] of buckets) {top.push(...bucket.hits); totalByGroup.set(name,bucket.total);}
        return Object.assign(top.sort(byScore),{ms:now()-t0,total,totalByGroup});
      }
      if (!words.length) {
        if (qn || !opts.browse) return finish();
        // Recently used library keys can lie anywhere in a 50k library. Look those
        // up directly; scan the small sources and only the initial library suggestions.
        const seen = new Set();
        for (const key of opts.recent || []) {
          const id = byKey.get(key), r = recs[id];
          if (r && allowedRecord(r)) {seen.add(id); accept(r, extras(r));}
        }
        for (const [kind, ids] of byKind) {
          if (kinds && !kinds.has(kind)) continue;
          let n = 0;
          for (const id of ids) {
            const r = recs[id];
            if (!seen.has(id) && allowedRecord(r)) {accept(r, extras(r)); n++;}
            if (kind === "library" && n >= limit) break;
          }
        }
        return finish();
      }
      const globalRanking = !opts.filter && !opts.bonus && !opts.group && !opts.usage;
      const view = opts.libraryView ?? (globalRanking ? 3 : 0);
      const allowLibrary = !kinds || kinds.has("library"), allowFamilies = opts.families !== false;
      const head = allowLibrary && view && words.length === 1 && qn === words[0] && limit <= PREFIX_LIMIT && preparedLibrary?.heads.get(qn);
      const profile = head && (allowFamilies && head.enhanced || head.bins);
      const bins = profile ? profile.filter((b,i) => b && (view === 3 || (view & i))) : [];
      const libraryCount = bins.reduce((sum,b) => sum+b.total,0), fast = libraryCount > BROAD;
      const localOnly = fast || !allowLibrary;
      const maps = words.map((w, i) => matchWord(w,i === words.length - 1,localOnly));
      const wide = !localOnly && words.length === 1 && qn === words[0] && qn.length >= 3 &&
        wideHits(qn,maps[0],view,opts.libraryRanking,allowFamilies,limit);
      for (let w = 0; w < maps.length; w++) {
        for (const [tid,quality] of maps[w]) {
          const parts = localOnly || wide ? null : libraryPost[tid];
          const local = tokPost[tid], count = local.length + (parts?.length || 0);
          for (let j=0; j<count; j++) {
            const code = j < local.length ? local[j] : parts[j-local.length];
            const id = code >> 2, r = recs[id], field = code & 3;
            if (!r || matched[id] !== w || (!w && !seenWord[id] && !allowedRecord(r))) continue;
            // Family names support completion. A typo in an unrelated query
            // must not add a family member to its previous result set.
            if (field === FAMILY && (!allowFamilies || !tokStr[tid].startsWith(words[w]))) continue;
            const score = quality * FIELD[field];
            if (!seenWord[id]) touched[nTouched++] = id;
            if (score > seenWord[id]) seenWord[id] = score;
          }
        }
        for (let j=0; j<nTouched; j++) {
          const id=touched[j];
          if (!w) candidates[nCandidates++] = id;
          sums[id] += seenWord[id]; seenWord[id] = 0; matched[id]++;
        }
        nTouched = 0;
      }
      const abbreviation = words[0];
      if (words.length === 1 && abbreviation.length >= 2 && !/\d/.test(abbreviation)) {
        const token = tokId.get(abbreviation);
        const exact = token !== undefined && (allowFamilies || tokPost[token].length || libraryPost[token]?.some(code=>(code & 3) !== FAMILY));
        for (const id of smallIds) {
          const r = recs[id];
          if (!allowedRecord(r)) continue;
          let score = r.ini === abbreviation ? 160 : abbreviation.length >= 3 && r.ini.includes(abbreviation) ? 120 : r.ini.startsWith(abbreviation) ? 70 : 0;
          if (!score && !exact) {
            const best = Math.max(subsequence(abbreviation, r.ln), r.kn ? subsequence(abbreviation, r.kn) * .5 : 0);
            if (best >= 5) score = 25 + best * 4.5;
          }
          if (score > sums[id]) {
            if (!matched[id]) {matched[id] = 1; candidates[nCandidates++] = id;}
            sums[id] = score;
          }
        }
      }
      if (fast) {
        const added = new Set();
        function addPart(r,score) {
          if (!added.has(r.key)) {added.add(r.key); accept(r,score + extras(r));}
        }
        for (const b of bins) for (const hit of b.hits) addPart(hit.rec,hit.score);
        // History can promote a result beyond the cached head. Score each such
        // library key directly against the same indexed terms before taking top K.
        for (const key of opts.recent || []) {
          const r = recs[byKey.get(key)];
          if (!r?.terms || added.has(key) || (view !== 3 && !(view & r.libraryMask))) continue;
          const score = libraryScore(r,qn,allowFamilies);
          if (score) addPart(r,score);
        }
        const rest = libraryCount - added.size;
        const bucket = buckets.get(opts.group?.(bins[0].hits[0].rec) || "");
        bucket.total += rest; total += rest;
      }
      if (wide) {
        for (const hit of wide.hits) accept(hit.rec,hit.score);
        const bucket = buckets.get(opts.libraryRanking.group);
        const remaining = wide.total - wide.hits.length;
        bucket.total += remaining; total += remaining;
      }
      let complete = nCandidates + (fast ? libraryCount : wide ? wide.total : 0);
      if (maps.length > 1) {complete = 0; for (let j=0; j<nCandidates; j++) if (matched[candidates[j]] === maps.length) complete++;}
      for (let j=0; j<nCandidates; j++) {
        const id = candidates[j];
        if (matched[id] === maps.length) {
          const r = recs[id];
          let score = sums[id] + extras(r);
          if (r.e?.aliases?.some(alias => norm(alias) === qn)) score += 450;
          if (words.length === 1 && r.k0 === abbreviation) score += 100;
          score += titleBonus(r.ln,qn);
          if (complete <= BROAD && r.lt?.length) score += order(r.lt, maps);
          accept(r, score);
        }
        sums[id] = 0; matched[id] = 0;
      }
      return finish();
    }
    // Every record whose label is exactly this text (designators: "u1").
    function byLabel(text) {return [...labels.get(norm(text)) || []].map(id => recs[id]).filter(Boolean);}
    function stats() {
      let postings = 0, chars = 0;
      for (let i=0; i<tokPost.length; i++) postings += tokPost[i].length + (libraryPost[i]?.length || 0);
      for (const t of tokStr) chars += t.length;
      const kinds = {};
      for (const r of recs) if (r) kinds[r.kind] = (kinds[r.kind] || 0) + 1;
      return {records: live, stale: dead, tokens: tokStr.length, postings, tokenChars: chars, kinds, version};
    }
    const ix = {put, remove, setGroup, prepareLibrary, prepareWideLibrary, source:name => groups.get(name)?.src || [], search, byLabel, stats, has: k => byKey.has(k), get: k => recs[byKey.get(k)] || null,
      size: () => live, version: () => version, state, matchWord, invalidate: () => cache.clear()};
    const clearCache = f => (...a) => {const previous = version, result = f(...a); if (previous !== version) cache.clear(); return result;};
    ix.put = clearCache(put); ix.remove = clearCache(remove); ix.setGroup = clearCache(setGroup);
    ix.sync = (project, defs, o) => sync(ix, project, defs, o);
    return ix;
  }
  function titleBonus(label, q) {
    if (label === q) return 300;
    if (label.startsWith(q)) return 80;
    return q.length > 2 && label.includes(q) ? 30 : 0;
  }
  // Stable key tie-breaks survive heap boundaries, a provider changing order, or an index rebuild.
  const compareHit = (score, rec, b) => b.score - score || rec.ln.length - b.rec.ln.length || (rec.key < b.rec.key ? -1 : rec.key > b.rec.key ? 1 : 0);
  const byScore = (a, b) => compareHit(a.score, a.rec, b);
  // Bonus for query words found in the title in order (and adjacent), starting at its first word.
  function order(lt, maps) {
    let pos = -1, adjacent = true, bonus = 0;
    for (let w = 0; w < maps.length; w++) {
      let at = -1;
      for (let j = pos + 1; j < lt.length; j++) if (maps[w].has(lt[j])) {at = j; break;}
      if (at < 0) return w === 0 ? 0 : bonus;
      if (w === 0 && at === 0) bonus += 20;
      if (w > 0) adjacent = adjacent && at === pos + 1;
      pos = at;
    }
    return bonus + (maps.length > 1 ? (adjacent ? 40 : 15) : 0);
  }
  // Worst selected hit at the root. Rejecting a broad match needs no per-result allocation.
  function heapPut(h, limit, hit) {
    if (h.length < limit) {
      let i = h.length; h.push(hit);
      while (i) {
        const parent = (i - 1) >> 1;
        if (byScore(h[parent], hit) >= 0) break;
        h[i] = h[parent]; i = parent;
      }
      h[i] = hit;
      return;
    }
    let i = 0;
    while (i * 2 + 1 < h.length) {
      let child = i * 2 + 1;
      if (child + 1 < h.length && byScore(h[child + 1], h[child]) > 0) child++;
      if (byScore(h[child], hit) <= 0) break;
      h[i] = h[child]; i = child;
    }
    h[i] = hit;
  }
  const now = () => globalThis.performance?.now?.() ?? Date.now();

  // ------------------------------------------------------------------ project sources
  // A pin name, number or qualified reference in the same inverted index as every
  // other source. Geometry is read once per definition/gate during an incremental pass.
  const NO_PINS = Object.freeze([]);
  function* syncPins(ix, ds, doc, item, def, partKey, geoCache) {
    const A = globalThis.Atrium;
    const geo = A?.gate?.(A.geometries(def,doc.kind),item);
    const source = Array.isArray(geo?.pins) ? geo.pins : Array.isArray(geo?.pads) ? geo.pads : NO_PINS;
    if (!source.length && !ds.pinRows.has(partKey)) return;
    let info = geoCache.get(source);
    if (!info) {
      const numbers = new Set(), lines = [];
      for (const p of source) {
        const number = String(p.number ?? "");
        if (!number || numbers.has(number)) continue;
        numbers.add(number); lines.push([number,String(p.name || ""),String(p.net || "")]);
      }
      info = {lines,signature:JSON.stringify(lines)}; geoCache.set(source,info);
    }
    const signature = [item.ref,doc.name,info.signature,JSON.stringify(item.pinNets || null)].join(SEP);
    const last = ds.pinRows.get(partKey);
    if (last?.signature === signature) return;
    if (last) for (const key of last.keys) ix.remove(key);
    const keys = new Set(), pcb = doc.kind === "pcb", ref = norm(item.ref);
    ds.pinRows.set(partKey,{signature:null,keys});
    for (const [number,name,originalNet] of info.lines) {
      const net = item.pinNets?.[number] || originalNet, type = pcb ? "pad" : "pin";
      const key = type + ":" + doc.id + ":" + item.id + ":" + number;
      ix.put({key,kind:"pin",label:item.ref + "." + number + (name && name !== number ? " " + name : ""),
        kw:[item.ref,number,name,net].join(" "),detail:(pcb ? "Pad" : "Pin") + " · " + (net || "no net") + " · " + doc.name,
        pinRef:ref,pinNumber:norm(number),pinName:norm(name),docId:doc.id,target:{type,docId:doc.id,id:item.id,pad:number}});
      keys.add(key);
      if (keys.size % 72 === 0) yield;
    }
    ds.pinRows.get(partKey).signature = signature;
  }
  const LABEL_KINDS = {port: "Port", netlabel: "Net label", power: "Power port", offsheet: "Off sheet connector", sheetsymbol: "Sheet symbol", text: "Text"};
  function notebookText(item) {
    const widget=item.widget;
    if (widget?.type==="todo" && Array.isArray(widget.state?.rows)) {
      // The saved display fallback may still contain edited or deleted tasks.
      const rows=widget.state.rows, first=rows.find(row=>typeof row?.text==="string" && row.text.trim())?.text;
      const label=String(item.title || first || "To-do list").split(/[\r\n]/,1)[0].slice(0,140);
      const body=rows.map(row=>[row?.text,row?.assignee,row?.due].filter(Boolean).join(" ")).join("\n");
      return {label,kw:"todo checklist to-do list " + body};
    }
    const blocks=Array.isArray(item.richText?.blocks) ? item.richText.blocks : [];
    const runs=blocks.map(block=>Array.isArray(block?.runs) ? block.runs.map(run=>run?.text || run?.expression || run?.tex || "").join("") : "").join("\n").trim();
    const text=String(globalThis.AtriumNotebook?.searchText?.(item) ?? (runs || item.text || item.source || widget?.fallback?.text || widget?.fallback?.alt || "")).trim();
    if (!text) return null;
    const calculation=item.kind==="calculation" ? item : item.calculation;
    const label=String(calculation?.name || item.title || text.split(/[\r\n]/,1)[0]).slice(0,140);
    const kw=[text,blocks.some(block=>block?.style==="check") ? "todo checklist" : "",
      calculation ? "calculation " + (calculation.assertions || []).map(a=>a.source).join(" ") : ""].filter(Boolean).join(" ");
    return {label,kw};
  }
  const SEP = "\u0001";
  const documentKind = kind => ({pcb:"Board",schematic:"Schematic",drawing:"Drawing",panel:"Panel"})[kind] || kind;
  function* syncTitles(ix, refs) {
    const titles = ix.state.titles, seen = new Set();
    for (const ref of refs) {
      if (!ref?.id || !ref.name) continue;
      seen.add(ref.id);
      const detail = (ref.kind === "pcb" ? "Board layout" : documentKind(ref.kind)) + (ref.sourceName ? " · " + ref.sourceName : "");
      const value = [ref.name,ref.kind,detail].join(SEP);
      if (titles.get(ref.id) !== value) {
        titles.set(ref.id,value);
        ix.put({key:"doc:" + ref.id,kind:"document",label:ref.name,detail,
          kw:ref.kind === "pcb" ? "board pcb layout" : ref.kind === "schematic" ? "schematic sheet" : ref.kind,
          target:{type:"doc",docId:ref.id},docId:ref.id});
      }
      if (seen.size % 96 === 0) yield;
    }
    for (const id of titles.keys()) if (!seen.has(id)) {titles.delete(id); ix.remove("doc:" + id);}
  }
  function familyMemberships(state, owner, revision) {
    const records = owner?.componentFamilies, families = globalThis.AtriumComponentFamilies;
    if (!records?.length || !families) return null;
    state.memberships ??= new WeakMap();
    const prior = state.memberships.get(owner);
    if (revision !== null && prior?.records === records && prior.revision === revision) return prior.members;
    const members = families.memberships(owner);
    state.memberships.set(owner, {records, revision, members});
    return members;
  }
  // Diff the project against the last pass and re-index what changed. A generator: yields every
  // ~1,000 items (400 library parts) so runIdle() can spread a first build over idle slices.
  // o.journal (AtriumUndoStore): a document whose items the change journal shows unchanged since the
  // last pass is not re-scanned (the same project, defs map and outer() count; else every document is).
  function* sync(ix, project, defs, o = {}) {
    const st = ix.state, docsNow = new Set(), geoCache = new WeakMap(), stats = {added: 0, removed: 0, scanned: 0};
    const getDef = id => defs?.get?.(id);
    const U = o.journal?.changed ? o.journal : null, J = U ? U.changed(null, null) : null, outer = U?.outer?.();
    const quick = !!J && st.seq != null && st.project === project && st.defs === defs && st.outer === outer && st.notebook === o.notebook;
    const unchanged = d => {const r = U.changed(d, st.seq); return !!r.ids && !r.ids.size;};
    // Folder refs supply titles for cold owners without touching their sheet, board or assets.
    const loaded = project?.documents || [];
    yield* syncTitles(ix, o.documentRefs?.() || loaded);
    for (const d of loaded) {
      docsNow.add(d.id);
      let ds = st.docs.get(d.id);
      if (!ds) st.docs.set(d.id, ds = {fp: new Map(), pinRows:new Map(), nets: new Set(), classes: new Set(), name: null});
      const kindName = documentKind(d.kind);
      let same = quick && ds.items === d.items && ds.length === d.items?.length;
      if (ds.name !== d.name + SEP + d.kind) {
        // Refresh the sheet name in the detail text of its loaded objects.
        same = false;
        for (const k of ds.fp.keys()) ds.fp.set(k, null);
        ds.name = d.name + SEP + d.kind;
      }
      if (!(same && unchanged(d))) {
        const seen = new Set(), nets = new Set(), items = d.items || [];
        for (let n = 0; n < items.length; n++) {
          const i = items[n];
          if (n % 1000 === 999) {stats.scanned += 1000; yield;}
          if (i.net) nets.add(i.net);
          let key = null, fp = null;
          if (i.kind === "part") {
            if (i.pinNets) for (const k in i.pinNets) {const v = i.pinNets[k]; if (v) nets.add(v);}
            if (!i.ref) continue;
            key = "obj:" + d.id + ":" + i.id;
            // The record reads the definition's name and footprint name too (a renamed library part).
            const def = getDef(i.def), foot = i.footprint || def?.footprint?.name || "";
            yield* syncPins(ix,ds,d,i,def,key,geoCache);
            fp = i.ref + SEP + (i.value ?? "") + SEP + (i.comment ?? "") + SEP + (i.def ?? "") + SEP + foot + SEP + (def?.name ?? "");
            seen.add(key);
            if (ds.fp.get(key) === fp) continue;
            const value = i.value ?? "", comment = i.comment && i.comment !== i.value ? i.comment : "";
            ix.put({key, kind: "component", label: i.ref, byLabel: true, compact: value,
              kw: [value, comment, foot, def?.name, i.def].filter(Boolean).join(" "),
              detail: [value, comment, foot, kindName + " · " + d.name].filter(Boolean).join(" · "),
              target: {type: "part", docId: d.id, id: i.id}, docId: d.id});
          } else if (o.notebook !== false && (i.kind === "textframe" || i.kind === "calculation" || globalThis.AtriumNotebook?.isNote?.(i))) {
            const content=notebookText(i);
            if (!content) continue;
            const {label,kw}=content;
            key = "note:" + d.id + ":" + i.id; fp = label + SEP + kw;
            seen.add(key);
            if (ds.fp.get(key) === fp) continue;
            ix.put({key,kind:"notebook",label,kw,detail:"Notebook · " + d.name,docId:d.id,target:{type:"item",docId:d.id,id:i.id}});
          } else if (LABEL_KINDS[i.kind] && (i.text || i.name)) {
            const text = i.text || i.name;
            if (i.kind === "netlabel" || i.kind === "power" || i.kind === "port" || i.kind === "offsheet") nets.add(text);
            key = "lbl:" + d.id + ":" + i.id; fp = i.kind + SEP + text;
            seen.add(key);
            if (ds.fp.get(key) === fp) continue;
            ix.put({key, kind: "port", label: text, kw: i.kind, detail: LABEL_KINDS[i.kind] + " · " + d.name, target: {type: "item", docId: d.id, id: i.id}, docId: d.id});
          } else continue;
          ds.fp.set(key, fp); stats.added++;
        }
        stats.scanned += items.length % 1000;
        for (const key of ds.fp.keys()) if (!seen.has(key)) {ds.fp.delete(key); ix.remove(key); stats.removed++;}
        for (const [key,pins] of ds.pinRows) if (!seen.has(key)) {
          for (const pk of pins.keys) ix.remove(pk);
          ds.pinRows.delete(key);
        }
        // Schematic nets come from connectivity (wired nets with no label get their generated names).
        if (d.kind === "schematic" && globalThis.Atrium?.connectivity) {
          yield;
          try {for (const n of Atrium.connectivity(d, defs).nets) if (n.name) nets.add(n.name);} catch { /* partial document */ }
        }
        syncNets(ix, d.id, ds, nets);
      }
      ds.items = d.items; ds.length = d.items?.length;
      // Each board owns its net classes, including names shared with another board.
      const classKeys = new Set();
      if (d.kind === "pcb" && globalThis.AtriumRules?.netClasses) {
        let classes = {};
        try {classes = AtriumRules.netClasses(d, {project}) || {};} catch { /* no rules */ }
        for (const [name, members] of Object.entries(classes)) {
          const key = "ncls:" + d.id + SEP + name, detail = "Net class · " + members.length + " nets · " + d.name;
          classKeys.add(key);
          const old = ix.get(key), oldNets = old?.target?.nets;
          if (old?.detail === detail && oldNets?.length === members.length && oldNets.every((net, i) => net === members[i])) continue;
          ix.put({key, kind: "netclass", label: name, kw: members.join(" "), detail,
            target: {type: "netclass", docId: d.id, nets: [...members]}, docId: d.id});
        }
      }
      for (const key of ds.classes) if (!classKeys.has(key)) ix.remove(key);
      ds.classes = classKeys;
    }
    for (const [id, ds] of st.docs) if (!docsNow.has(id)) {
      for (const key of ds.fp.keys()) ix.remove(key);
      for (const pins of ds.pinRows.values()) for (const key of pins.keys) ix.remove(key);
      for (const key of ds.classes) ix.remove(key);
      syncNets(ix, id, ds, new Set());
      st.docs.delete(id);
    }
    // Library parts: the project's library, the starter library and the built-in catalogue.
    yield;
    const sources = o.library ? [[null,o.library]] : librarySources(project);
    yield* ix.prepareLibrary(sources.reduce((n,src) => n + src[1].length,0) > BROAD);
    const libNow = new Set();
    let n = 0;
    for (const [library,defs] of sources) {
      const owner = library || (defs === project?.library ? project : null);
      const revision = owner === project ? U?.familyVersion?.() ?? null : undefined;
      const members = o.notebook ? familyMemberships(st, owner, revision) : null;
      for (const def of defs) {
        if (++n % 96 === 0) yield;
        if (!def?.id || def.mirrorOf) continue;
        const key = library?.id ? "lib:" + encodeURIComponent(library.id) + ":" + encodeURIComponent(def.id) : "lib:" + def.id;
        if (libNow.has(key)) continue;
        libNow.add(key);
        const fp = def.footprint?.name || "", value = def.value || def.fields?.value || "";
        const label = def.name || def.id, member = members?.get(def.id);
        const family = member ? member.name + " " + member.part : "";
        const kw = [def.id, value, fp, def.prefix, def.category, def.mpn, def.manufacturer, def.keywords].filter(Boolean).join(" ");
        const detail = [def.description, fp, defs === project?.library ? "Project library" : library?.name || "Library"].filter(Boolean).join(" · ");
        const signature = [label,kw,detail,value,!!(def.symbol || def.stub?.symbol),!!(def.footprint || def.stub?.footprint),family].join(SEP);
        const previous = st.lib.get(key);
        if (previous?.def === def && previous.signature === signature) continue;
        st.lib.set(key, {def, signature});
        ix.put({key, kind: "library", label, kw, detail, family,
          compact: value, target: {type:"library",id:def.id,...(library ? {libraryId:library.id} : {})}, def, library});
      }
    }
    for (const key of st.lib.keys()) if (!libNow.has(key)) {st.lib.delete(key); ix.remove(key);}
    yield* ix.prepareLibrary();
    yield* ix.prepareWideLibrary();
    st.seq = J ? J.seq : null; st.notebook = o.notebook; st.project = project; st.defs = defs; st.outer = outer;
    return stats;
  }
  function syncNets(ix, docId, ds, nets) {
    const st = ix.state;
    for (const n of ds.nets) if (!nets.has(n)) {
      const set = st.netDocs.get(n);
      set?.delete(docId);
      if (set && !set.size) {st.netDocs.delete(n); ix.remove("net:" + n);}
    }
    for (const n of nets) if (!ds.nets.has(n)) {
      let set = st.netDocs.get(n);
      if (!set) {
        st.netDocs.set(n, set = new Set());
        ix.put({key: "net:" + n, kind: "net", label: n, byLabel: true, detail: "Net", target: {type: "net", net: n}});
      }
      set.add(docId);
    }
    ds.nets = nets;
  }
  // Every library definition the user could place, project first, de-duplicated by id.
  function librarySources(project) {
    const sources = [[null,project?.library || []]];
    try {if (globalThis.AtriumStarterLibrary) sources.push([null,AtriumStarterLibrary.templates()]);} catch { /* not loaded */ }
    sources.push([null,globalThis.AtriumParts?.catalogue || []]);
    for (const lib of [...globalThis.AtriumLibrary?.sourceStore?.sources?.() || [], ...globalThis.AtriumLibrarySources?.libraries?.() || [], ...globalThis.AtriumGroupLocal?.libraries?.() || []]) {
      if (Array.isArray(lib.defs)) sources.push([lib,lib.defs]);
    }
    return sources;
  }
  function libraryPool(project) {return librarySources(project).flatMap(source => source[1]);}

  // ------------------------------------------------------------------ scheduling
  // Run a generator in idle slices (idle.js; requestIdleCallback or setTimeout where it is not loaded).
  function runIdle(gen, done, progress) {
    const ric = globalThis.AtriumIdle?.idle || globalThis.requestIdleCallback || (f => setTimeout(() => f({timeRemaining: () => 8, didTimeout: false}), 1));
    const cancel = globalThis.AtriumIdle?.cancel || globalThis.cancelIdleCallback || clearTimeout;
    const timing = globalThis.AtriumDiagnostics?.performance?.queue("search", "build");
    let stopped = false, handle;
    const step = (deadline, finishing = false) => {
      if (stopped && !finishing) return;
      timing?.start();
      const t0 = deadline && now();
      try {
        for (;;) {
          const r = gen.next();
          if (r.done) {stopped = true; timing?.end("completed"); done?.(r.value); return;}
          if (deadline && ((deadline.timeRemaining ? deadline.timeRemaining() < 2 : false) || now() - t0 > 3)) break;
        }
        progress?.();
        handle = ric(step, {timeout: 1000});
      } catch (error) {
        timing?.end("failed");
        throw error;
      }
    };
    handle = ric(step, {timeout: 1000});
    // finish(): complete the rest now (the user opened the search before the build ended).
    return {
      finish() {if (stopped) return; stopped = true; cancel(handle); step(null, true);},
      cancel() {if (!stopped) {stopped = true; cancel(handle); timing?.end("cancelled"); gen.return?.();}},
      get done() {return stopped;}
    };
  }
  function runNow(gen) {let r; do r = gen.next(); while (!r.done); return r.value;}

  return {create, norm, tokens, osa, subsequence, initials, runIdle, runNow, libraryPool, KIND};
})();
