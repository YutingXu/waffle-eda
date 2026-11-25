"use strict";
// Signals (docs/design/signal-model.md): one model for nets, differential pairs, xSignals and classes.
//
//   Net     physical connectivity, derived (pad pinNets and copper). Never declared here.
//   Signal  confirmed intent: {id, name, kind: single|diff|bus, legs:[{polarity?, nets}], tags, ...}.
//           Legs are seeded by nets and, unless `span: false`, spanned across two-pin series parts
//           (R C L FB JP NT Z, resistor networks, SeriesPins maps) between nets that are not rails or
//           grounds. A diff signal derives stages (one net pair per series stage) for routers and DRC.
//   Tag     a label on a signal, on one net (exact legacy class membership) or on a path (xSignal).
//           Tags replace net classes, differential pair classes and xSignal classes.
//
// Store (format 1.4, optional): project.signals = {version:1, signals:[], tags:[], nets:{}, series:{},
//   conventions?, declined?}: the only store of net classes, pairs, pair classes, xSignals and xSignal
//   classes (board rules and lengthTuning never carry them). Without a store the model is derived by
//   fromLegacy (pure) from each board's imported class records (doc.sourceClasses); the first edit through
//   edit() or applyClasses() writes it.
//
//   AtriumSignals.validate(store, invalid?, lenient?)    schema check (throws or calls invalid())
//   AtriumSignals.model(project, board, {defs, revision}) -> M (memoised; see model())
//   AtriumSignals.scopeEnv(board, project)               the rule/query scope seam, or null without a store
//   AtriumSignals.series(part, def, store)               pin pairs a signal may cross ([] if none)
//   AtriumSignals.fromLegacy(project) / toLegacy(project, board)
//   AtriumSignals.edit(project, fn)                      adopt + fn(store) + validate (one undo step)
//   AtriumSignals.applyClasses(project, board, keys)     classes, pairs, pair classes, xSignals, xSignal classes
//                                                        from a class-shaped view (importers, editors, wizards)
//   AtriumSignals.xsView(board, project?)                a board's {xSignals, xSignalClasses} (shared: read only)
//   AtriumSignals.projectOf(board), attach(project)
// DOM-free. Lazy (app/lazy.js "AtriumSignals").
globalThis.AtriumSignals = (() => {
  const G = globalThis, VERSION = 1;
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const fail = m => { throw Error(m); };
  const lower = s => String(s).toLowerCase();
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true, sensitivity: "base"}) || (a < b ? -1 : a > b ? 1 : 0);
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const validName = (s, max = 512) => typeof s === "string" && !!s.trim() && s === s.trim() && s.length <= max && !/[\u0000-\u001f]/.test(s);
  const KINDS = ["single", "diff", "bus"];
  // MAX_FANOUT: a span never enters a net with more pins than this (a rail or bus the name did not reveal).
  const MAX_DEPTH = 3, MAX_LEG = 32, MAX_FANOUT = 8;
  // Two-pin series parts and resistor networks: the union of xsignals.js and length-tuning.js before this module.
  const SERIES2 = /^(R|C|L|FB|JP|NT|Z|RN|RA|RP|RR)\d/i, NETWORK = /^(RN|RA|RP|RR)\d/i;
  const POWER = /^(?:[ADPS]?GND\w*|GND\w*|VSS\w*|VCC\w*|VDD\w*|VEE\w*|VBUS\w*|VBAT\w*|VIN\w*|VREF\w*|VTT\w*|VPP\w*|PWR\w*|[+-]?\d+V\d*\w*|[+-]?\d+(?:\.\d+)?V\w*|P\d+V\d*\w*|\+\w+)$/i;
  const supply = net => { const I = G.AtriumNetIntent; if (I?.isSupply) { try { return !!I.isSupply(net); } catch { /* fallback */ } } return POWER.test(net); };

  // ------------------------------------------------------------------ hashing
  // FNV-1a over the canonical JSON (two lanes): ids and memo keys.
  function hash(v) {
    const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
    let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 13); }
    return "h1:" + (a >>> 0).toString(16).padStart(8, "0") + (b >>> 0).toString(16).padStart(8, "0");
  }

  // ------------------------------------------------------------------ schema
  const STORE_KEYS = new Set(["version", "signals", "tags", "nets", "series", "conventions", "declined"]);
  const SIGNAL_KEYS = new Set(["id", "name", "kind", "boards", "legs", "members", "tags", "exclude", "through", "span", "paths", "stages", "intent", "impedance", "params", "origin", "altium", "comment"]);
  const PATH_KEYS = new Set(["name", "from", "to", "through", "nets", "tags"]);
  const END_KEYS = new Set(["part", "ref", "pin"]);
  const TAG_KEYS = new Set(["name", "color", "comment", "as", "altium", "impedance", "params"]);
  const AS_KEYS = new Set(["net", "pair", "xsignal"]);
  function validate(store, invalid, lenient = false) {
    const bad = typeof invalid === "function" ? m => { invalid(m); throw Error(m || "Invalid signals store."); } : m => fail(m || "Invalid signals store.");
    const keys = (o, allowed, what) => { if (!plain(o)) bad(what + " must be an object."); if (!lenient) for (const k of Object.keys(o)) if (!allowed.has(k)) bad(what + " has the unsupported setting " + k + "."); };
    const names = (a, what, max = 10000) => { if (!Array.isArray(a) || a.length > max || !a.every(x => validName(x))) bad(what + " must be a list of names."); };
    keys(store, STORE_KEYS, "The signals store");
    if (!Number.isInteger(store.version) || store.version < 1 || store.version > VERSION && !lenient) bad("Unsupported signals store version " + store.version + ".");
    const sigs = store.signals ?? [];
    if (!Array.isArray(sigs) || sigs.length > 100000) bad("Signals must be a list.");
    const ids = new Set(), seen = new Set();
    for (const s of sigs) {
      keys(s, SIGNAL_KEYS, "A signal");
      if (!validName(s.id, 128) || ids.has(s.id)) bad("Each signal needs a unique id.");
      ids.add(s.id);
      if (!validName(s.name, 256) || seen.has(lower(s.name))) bad("Signal names must be unique (" + s.name + ").");
      seen.add(lower(s.name));
      if (!KINDS.includes(s.kind) && !lenient) bad("Signal " + s.name + " has an unknown kind.");
      if (s.boards !== undefined) names(s.boards, "Signal boards");
      if (s.kind === "bus") { if (!Array.isArray(s.members) || !s.members.every(x => validName(x, 128))) bad("Bus " + s.name + " needs member signal ids."); if (s.legs !== undefined) bad("Bus " + s.name + " has no legs."); }
      else if (KINDS.includes(s.kind)) {
        if (!Array.isArray(s.legs) || s.legs.length !== (s.kind === "diff" ? 2 : 1)) bad("Signal " + s.name + " needs " + (s.kind === "diff" ? "two legs" : "one leg") + ".");
        for (const l of s.legs) {
          keys(l, new Set(["polarity", "nets"]), "A signal leg");
          names(l.nets, "Leg nets", 64); if (!l.nets.length) bad("Each leg of " + s.name + " needs a net.");
          if (s.kind === "diff" ? l.polarity !== 1 && l.polarity !== -1 : l.polarity !== undefined) bad("Signal " + s.name + ": polarity is 1 or -1 on diff legs only.");
        }
        if (s.kind === "diff" && s.legs[0].polarity === s.legs[1].polarity) bad("The legs of " + s.name + " need opposite polarity.");
        if (s.members !== undefined) bad("Only a bus has members.");
      }
      for (const k of ["tags", "exclude", "through", "stages"]) if (s[k] !== undefined) names(s[k], "Signal " + k);
      if (s.span !== undefined && typeof s.span !== "boolean") bad("span is true or false.");
      if (s.paths !== undefined) {
        if (!Array.isArray(s.paths) || s.paths.length > 10000) bad("Signal paths must be a list.");
        const pn = new Set();
        for (const p of s.paths) {
          keys(p, PATH_KEYS, "A signal path");
          if (!validName(p.name, 256) || pn.has(p.name)) bad("Each path of " + s.name + " needs a unique name.");
          pn.add(p.name);
          for (const e of [p.from, p.to]) { keys(e, END_KEYS, "A path end"); if (!validName(String(e.pin ?? ""), 64) || typeof e.pin !== "string" || !(validName(e.part, 128) || validName(e.ref, 128))) bad("A path end needs a part and a pin."); }
          for (const k of ["through", "nets", "tags"]) if (p[k] !== undefined) names(p[k], "Path " + k);
        }
      }
      for (const k of ["intent", "impedance", "params", "altium"]) if (s[k] !== undefined && !plain(s[k])) bad("Signal " + k + " must be an object.");
      if (s.origin !== undefined && typeof s.origin !== "string" && !plain(s.origin)) bad("Signal origin must be text or an object.");
      if (s.comment !== undefined && (typeof s.comment !== "string" || s.comment.length > 4000)) bad("Signal comments are text up to 4000 characters.");
    }
    for (const s of sigs) if (s.kind === "bus") for (const m of s.members) if (!ids.has(m)) bad("Bus " + s.name + " names a missing signal.");
    const tags = store.tags ?? [];
    if (!Array.isArray(tags) || tags.length > 100000) bad("Tags must be a list.");
    const tn = new Set();
    for (const t of tags) {
      keys(t, TAG_KEYS, "A tag");
      if (!validName(t.name, 256) || tn.has(lower(t.name))) bad("Tag names must be unique.");
      tn.add(lower(t.name));
      if (t.color !== undefined && !/^#[0-9a-f]{6}$/i.test(t.color)) bad("Tag colours are #rrggbb.");
      if (t.comment !== undefined && (typeof t.comment !== "string" || t.comment.length > 4000)) bad("Tag comments are text up to 4000 characters.");
      if (t.as !== undefined) { keys(t.as, AS_KEYS, "Tag classes"); for (const v of Object.values(t.as)) if (v !== null && !validName(v, 256)) bad("Tag class names are text or null."); }
      for (const k of ["altium", "impedance", "params"]) if (t[k] !== undefined && !plain(t[k])) bad("Tag " + k + " must be an object.");
    }
    if (store.nets !== undefined) {
      if (!plain(store.nets)) bad("Net tags must map nets to tags.");
      for (const [n, v] of Object.entries(store.nets)) {
        if (!validName(n)) bad("Net tags need net names.");
        for (const r of Array.isArray(v) ? v : [v]) { keys(r, new Set(["tags", "boards"]), "Net tags"); names(r.tags, "Net tags"); if (r.boards !== undefined) names(r.boards, "Net tag boards"); }
      }
    }
    if (store.series !== undefined) {
      if (!plain(store.series)) bad("Series overrides must map parts to pin pairs.");
      for (const v of Object.values(store.series)) if (v !== false && !(Array.isArray(v) && v.every(p => Array.isArray(p) && p.length === 2 && p.every(x => validName(x, 64))))) bad("A series override is false or pin pairs.");
    }
    for (const k of ["conventions", "declined"]) if (store[k] !== undefined && !plain(store[k])) bad("Signals " + k + " must be an object.");
    return store;
  }

  // ------------------------------------------------------------------ project ↔ board
  const owners = new WeakMap();
  function attach(project) {
    for (const d of project?.documents || []) if (d && typeof d === "object") owners.set(d, project);
    return project;
  }
  function projectOf(board) {
    if (!board) return null;
    const p = owners.get(board);
    if (p && p.documents?.includes(board)) return p;
    try { const h = G.AtriumNavHost?.project?.(); if (h?.documents?.includes(board)) { owners.set(board, h); return h; } } catch { /* no editor */ }
    return null;
  }
  const boardsOf = project => (project?.documents || []).filter(d => d?.kind === "pcb");
  const forBoard = (rec, board) => !rec.boards || !board || rec.boards.includes(board.id);

  // ------------------------------------------------------------------ series parts
  function paramOf(part, def, name) {
    for (const src of [part?.parameters, def?.parameters]) if (plain(src)) for (const [k, v] of Object.entries(src)) if (lower(k).replace(/[\s_-]/g, "") === name && typeof v !== "object") return String(v);
    return null;
  }
  // "1-4,2-3" or "1:4 2:3" -> [["1","4"],["2","3"]]
  function parsePins(text) {
    const out = [];
    for (const m of String(text || "").matchAll(/([A-Za-z0-9]+)\s*[-:]\s*([A-Za-z0-9]+)/g)) out.push([m[1], m[2]]);
    return out;
  }
  // Pin pairs a signal may cross on this part: [[a, b], ...], from the store override, the SeriesPins
  // parameter (part or library), or the designator heuristic.
  function series(part, def, store) {
    if (!part) return [];
    const o = store?.series && own(store.series, part.id) ? store.series[part.id] : undefined;
    if (o === false) return [];
    if (Array.isArray(o)) return o.map(p => [String(p[0]), String(p[1])]);
    const param = paramOf(part, def, "seriespins");
    if (param != null) return parsePins(param);
    const ref = String(part.ref || ""), pins = Object.keys(part.pinNets || {}).filter(k => part.pinNets[k]);
    if (pins.length === 2 && SERIES2.test(ref)) return [[pins[0], pins[1]]];
    if (NETWORK.test(ref)) {
      const all = Object.keys(part.pinNets || {}).map(Number).filter(Number.isFinite), n = all.length ? Math.max(...all) : 0, out = [];
      // A bussed network (one common pin, SIP pull-ups) has no series pairs: pin 1 or pin n is common when it
      // is a rail or ground, or when the pin count is odd.
      const end = k => part.pinNets[String(k)];
      if (n % 2 || [end(1), end(n)].some(x => x && supply(x))) return [];
      if (n >= 4 && n % 2 === 0) for (let i = 1; i <= n / 2; i++) if (part.pinNets[String(i)] && part.pinNets[String(n + 1 - i)]) out.push([String(i), String(n + 1 - i)]);
      return out;
    }
    return [];
  }
  const across = (pairs, pin) => { for (const [a, b] of pairs) { if (a === pin) return b; if (b === pin) return a; } return null; };

  // ------------------------------------------------------------------ netlist index
  // parts: id -> part; pinsOf: net -> [{id, pin}]. Memoised per board on the undo store's item
  // version (or items identity and o.revision without one); patched from the change journal.
  const indexes = new WeakMap();
  function versionKey(board, project, o) {
    const U = G.AtriumUndoStore;
    let v = null;
    try { v = project && U?.documentVersions ? U.documentVersions(board, project) : null; } catch { v = null; }
    return v ? {seq: v.seq, floor: v.floor, library: v.library, key: "u:" + v.items + ":" + v.library} :
      {seq: null, key: o.revision != null ? "r:" + o.revision : null};
  }
  // What a part contributes to the index; a change of any of it is a netlist change for spanning.
  const partSig = part => part.pinNets === undefined ? "" : JSON.stringify([part.ref || "", part.pinNets || null, part.parameters?.SeriesPins ?? part.parameters?.["Series Pins"] ?? null, part.def || ""]);
  function addPart(I, part) {
    if (part?.kind !== "part" || !part.id) return;
    I.parts.set(part.id, part);
    const nets = [];
    for (const [pin, net] of Object.entries(part.pinNets || {})) if (net) { let l = I.pinsOf.get(net); if (!l) I.pinsOf.set(net, l = []); l.push({id: part.id, pin: String(pin)}); nets.push(net); }
    I.netsOf.set(part.id, nets); I.sigOf.set(part.id, partSig(part)); I.idOf.set(part.id, [part, part.pinNets, part.parameters, part.ref, part.def]);
  }
  // Same contribution by identity (no JSON): the part, its pinNets and parameters objects, designator, definition.
  const sameRefs = (I, p) => { const x = I.idOf.get(p.id); return !!x && x[0] === p && x[1] === p.pinNets && x[2] === p.parameters && x[3] === p.ref && x[4] === p.def; };
  function removePart(I, id) {
    if (!I.parts.has(id)) return;
    for (const net of new Set(I.netsOf.get(id) || [])) { const l = I.pinsOf.get(net); if (!l) continue; const k = l.filter(e => e.id !== id); if (k.length) I.pinsOf.set(net, k); else I.pinsOf.delete(net); }
    I.parts.delete(id); I.netsOf.delete(id); I.sigOf.delete(id); I.idOf.delete(id);
  }
  // Re-index one part when what it contributes changed; true when it did (a move does not count).
  function patchPart(I, id, now) {
    const was = I.sigOf.get(id), sig = now?.kind === "part" ? partSig(now) : null;
    if (was === undefined && sig === null) return false;
    if (was === sig) { if (now) { I.parts.set(id, now); I.idOf.set(id, [now, now.pinNets, now.parameters, now.ref, now.def]); } return false; }
    removePart(I, id); if (sig !== null) addPart(I, now);
    return true;
  }
  function index(board, project, o = {}) {
    const vk = versionKey(board, project, o), prev = indexes.get(board);
    if (prev && vk.key && prev.key === vk.key && prev.items === board.items) return prev;
    if (prev && prev.items === board.items) {
      // Journal patch (the editor): only the parts the edits touched, and only when their pins' nets,
      // designator, definition or SeriesPins changed.
      if (vk.seq != null && prev.seq != null && prev.seq >= vk.floor) {
        let ch = null;
        try { ch = G.AtriumUndoStore.changed(board, prev.seq); } catch { ch = null; }
        if (ch?.ids) {
          let changed = false;
          for (const id of ch.ids) if (patchPart(prev, id, ch.items.get(id))) changed = true;
          prev.key = vk.key; prev.seq = ch.seq ?? vk.seq; if (changed) prev.gen++;
          return prev;
        }
      }
      // Without a journal (MCP, workers, tests): compare each part's contribution; patch the ones that differ.
      if (vk.seq == null && !vk.key) {
        let changed = false;
        const seen = new Set();
        for (const p of board.items || []) if (p?.kind === "part" && p.id) { seen.add(p.id); if (!sameRefs(prev, p) && patchPart(prev, p.id, p)) changed = true; }
        if (seen.size !== prev.parts.size) for (const id of [...prev.parts.keys()]) if (!seen.has(id)) { removePart(prev, id); changed = true; }
        if (changed) prev.gen++;
        return prev;
      }
    }
    const I = {items: board.items, key: vk.key, seq: vk.seq, gen: (prev?.gen || 0) + 1, parts: new Map(), pinsOf: new Map(), netsOf: new Map(), sigOf: new Map(), idOf: new Map()};
    for (const p of board.items || []) addPart(I, p);
    indexes.set(board, I);
    return I;
  }

  // ------------------------------------------------------------------ spanning
  // Multi-source breadth-first search from every leg's seeds. Seeds are fixed; a net reached by two
  // signals at once goes to the earlier one (store order) and both get an issue.
  function spanAll(sigs, I, store, defs, issues) {
    const owner = new Map(), queue = [];
    const legs = [];
    for (const s of sigs) s.legs.forEach((l, li) => {
      const L = {sig: s, li, nets: [], depth: new Map(), parts: [], ends: null};
      legs.push(L); s.legs[li] = Object.assign(l, {span: L});
      for (const n of l.seeds) {
        if (owner.has(n)) { const w = owner.get(n); if (w.sig !== s || w.li !== li) issues.push({kind: "seed", signal: s.name, net: n, other: w.sig.name, text: "Net " + n + " is a seed of " + w.sig.name + " and " + s.name + "."}); continue; }
        owner.set(n, L); L.nets.push(n); L.depth.set(n, 0); queue.push([n, L, 0]);
      }
    });
    const reported = new Set(), defOf = id => { const d = I.parts.get(id)?.def; return d == null ? null : defs?.get ? defs.get(d) : defs?.[d]; };
    for (let q = 0; q < queue.length; q++) {
      const [net, L, d] = queue[q], s = L.sig;
      if (s.decl.span === false || d >= MAX_DEPTH || supply(net)) continue;
      for (const {id, pin} of I.pinsOf.get(net) || []) {
        if (s.exclude.has(id)) continue;
        const part = I.parts.get(id); let pairs = series(part, defOf(id), store);
        if (!pairs.length && s.through.has(id)) { const pins = Object.keys(part.pinNets || {}).filter(k => part.pinNets[k]); if (pins.length === 2) pairs = [[pins[0], pins[1]]]; }
        const other = across(pairs, pin); if (other == null) continue;
        const next = part.pinNets?.[other];
        if (!next || next === net || supply(next)) continue;
        const w = owner.get(next);
        if (!w && (I.pinsOf.get(next)?.length || 0) > MAX_FANOUT) { const k = "fan|" + s.id + "|" + next; if (!reported.has(k)) { reported.add(k); issues.push({kind: "fanout", signal: s.name, net: next, ref: part.ref, text: "The span of " + s.name + " stops at " + next + " (" + I.pinsOf.get(next).length + " pins) across " + (part.ref || id) + "."}); } continue; }
        if (w) {
          if (w.sig !== s) { const k = [s.id, w.sig.id, id].sort().join("|"); if (!reported.has(k)) { reported.add(k); issues.push({kind: "conflict", signal: s.name, other: w.sig.name, part: id, ref: part.ref, text: (part.ref || id) + " joins " + w.sig.name + " and " + s.name + ". Exclude it from one of them."}); } }
          else if (w === L && !L.parts.some(x => x.id === id)) L.parts.push({id, ref: part.ref, pins: [pin, other], depth: d});
          continue;
        }
        if (L.nets.length >= MAX_LEG) { if (!reported.has("trunc|" + s.id)) { reported.add("trunc|" + s.id); issues.push({kind: "truncated", signal: s.name, text: "The span of " + s.name + " was cut at " + MAX_LEG + " nets."}); } continue; }
        owner.set(next, L); L.nets.push(next); L.depth.set(next, d + 1); L.parts.push({id, ref: part.ref, pins: [pin, other], depth: d}); queue.push([next, L, d + 1]);
      }
    }
    for (const L of legs) L.nets.sort((a, b) => L.depth.get(a) - L.depth.get(b) || natural(a, b));
    return owner;
  }

  // ------------------------------------------------------------------ class keys (imported records)
  // Without a store the model comes from a board's imported class records (doc.sourceClasses: Altium Classes6 /
  // DifferentialPairs6 / SignalClasses and Board6 pin pairs, KiCad net classes).
  function legacyOf(board) {
    const src = sourceClasses(board);
    return {netClasses: src?.netClasses || {}, diffPairs: src?.diffPairs || [], diffPairClasses: src?.diffPairClasses || {},
      xSignals: src?.xSignals || [], xSignalClasses: src?.xSignalClasses || {}};
  }
  const sourceCache = new WeakMap();
  function sourceClasses(board) {
    const lines = board?.sourceClasses;
    if (!Array.isArray(lines) || !lines.length || !G.AtriumAltiumRules?.classes) return null;
    const hit = sourceCache.get(lines); if (hit) return hit;
    let c = null; try { c = G.AtriumAltiumRules.classes(lines); } catch { c = null; }
    if (c) sourceCache.set(lines, c);
    return c;
  }
  const sortedMap = m => { const o = {}; for (const k of Object.keys(m || {}).sort(cmp)) o[k] = [...new Set((m[k] || []).map(String))].sort(cmp); return o; };
  // The canonical form of class keys: what round trips compare.
  function canonicalLegacy(L) {
    const xc = {};
    for (const [k, v] of Object.entries(L.xSignalClasses || {})) (xc[k] ||= []).push(...(v || []));
    const xs = (L.xSignals || []).map(x => {
      if (x?.class) (xc[x.class] ||= []).push(x.name);
      const e = {name: x.name, from: {ref: x.from?.ref, pin: String(x.from?.pin)}, to: {ref: x.to?.ref, pin: String(x.to?.pin)}};
      if (x.through?.length) e.through = [...x.through]; if (x.nets?.length) e.nets = [...x.nets];
      return e;
    }).sort((a, b) => cmp(a.name, b.name));
    return {netClasses: sortedMap(L.netClasses), diffPairs: (L.diffPairs || []).map(p => ({name: p.name, positive: p.positive, negative: p.negative})).sort((a, b) => cmp(a.name, b.name)),
      diffPairClasses: sortedMap(L.diffPairClasses), xSignals: xs, xSignalClasses: sortedMap(xc)};
  }
  const rulesPart = c => ({netClasses: c.netClasses, diffPairs: c.diffPairs, diffPairClasses: c.diffPairClasses});
  const xsPart = c => ({xSignals: c.xSignals, xSignalClasses: c.xSignalClasses});
  const sameKeys = (a, b) => hash(rulesPart(a)) === hash(rulesPart(b)) && hash(xsPart(a)) === hash(xsPart(b));

  // Stable ids for records made from legacy data (fromLegacy is pure and idempotent).
  const sid = (...k) => "s-" + hash(k.join("\u0001")).slice(3, 15);
  function uniqueName(base, used) { let n = base, i = 2; while (used.has(lower(n))) n = base + "_" + i++; used.add(lower(n)); return n; }
  function refIndex(board) { const m = new Map(); for (const p of board?.items || []) if (p.kind === "part" && p.ref && !m.has(p.ref)) m.set(p.ref, p.id); return m; }
  const endOf = (e, refs) => { const id = refs.get(e?.ref); return id ? {part: id, pin: String(e.pin)} : {ref: String(e?.ref ?? ""), pin: String(e?.pin ?? "")}; };

  // One board's class keys as store records ({signals, tags, nets}); exact (toLegacy inverts it).
  function boardFromLegacy(board, project, keys = legacyOf(board)) {
    const L = canonicalLegacy(keys), refs = refIndex(board), used = new Set(), signals = [], tags = new Map(), nets = {};
    const tagOf = (name, as) => { let t = tags.get(name); if (!t) tags.set(name, t = {name, as: {net: null, pair: null, xsignal: null}}); Object.assign(t.as, as); return t; };
    // Net classes: net-level tags.
    for (const [c, members] of Object.entries(L.netClasses)) { tagOf(c, {net: c}); for (const n of members) (nets[n] ||= []).push(c); }
    // Pairs: diff signals, one stage, no spanning.
    const pairSig = new Map();
    for (const p of L.diffPairs) {
      const s = {id: sid(board.id, "pair", p.name), name: uniqueName(p.name, used), kind: "diff", legs: [{polarity: 1, nets: [p.positive]}, {polarity: -1, nets: [p.negative]}], span: false};
      if (s.name !== p.name) s.stages = [p.name];
      signals.push(s); pairSig.set(p.name, s);
    }
    // Pair classes: signal-level tags when consistent with a same-name net class, else their own tag.
    for (const [c, members] of Object.entries(L.diffPairClasses)) {
      const nc = L.netClasses[c], pn = members.flatMap(m => { const s = pairSig.get(m); return s ? [s.legs[0].nets[0], s.legs[1].nets[0]] : []; });
      const same = nc && pn.every(n => nc.includes(n));
      let tname = c;
      if (!same && tags.has(c)) tname = uniqueName(c + " (pairs)", new Set([...tags.keys()].map(lower)));
      tagOf(tname, {pair: c});
      for (const m of members) { const s = pairSig.get(m); if (s) (s.tags ||= []).push(tname); else (tags.get(tname).missing ||= []).push(m); }
    }
    // xSignals: paths on the signal whose seeds hold one of its nets, else a new single signal.
    const seedSig = new Map(); for (const s of signals) for (const l of s.legs) for (const n of l.nets) seedSig.set(n, s);
    const pathTag = new Map(); for (const [c, members] of Object.entries(L.xSignalClasses)) for (const m of members) { if (!pathTag.has(m)) pathTag.set(m, []); pathTag.get(m).push(c); }
    // xSignal classes share a tag with a same-name class: path-level tags never widen the net or pair view.
    for (const c of Object.keys(L.xSignalClasses)) tagOf(c, {xsignal: c});
    const partByRef = new Map(); for (const p of board.items || []) if (p.kind === "part" && p.ref && !partByRef.has(p.ref)) partByRef.set(p.ref, p);
    for (const x of L.xSignals) {
      const ends = [x.from, x.to].map(e => partByRef.get(e.ref)?.pinNets?.[e.pin]).filter(Boolean);
      const xn = x.nets?.length ? x.nets : [...new Set(ends)];
      let s = xn.map(n => seedSig.get(n)).find(Boolean);
      if (!s) {
        const base = xn[0] || x.name;
        s = {id: sid(board.id, "xs", base), name: uniqueName(base, used), kind: "single", legs: [{nets: xn.length ? [...xn] : [x.name]}], span: false};
        signals.push(s); for (const n of s.legs[0].nets) seedSig.set(n, s);
      }
      const p = {name: x.name, from: endOf(x.from, refs), to: endOf(x.to, refs)};
      if (x.through?.length) p.through = [...x.through]; if (x.nets?.length) p.nets = [...x.nets];
      if (pathTag.has(x.name)) p.tags = [...pathTag.get(x.name)];
      (s.paths ||= []).push(p);
      // A class member that is not stored as an xSignal is kept on its tag (exact export).
    }
    for (const [c, members] of Object.entries(L.xSignalClasses)) { const known = new Set(L.xSignals.map(x => x.name)); for (const m of members) if (!known.has(m)) (tags.get(c).missingPaths ||= []).push(m); }
    // Pair-class members that are not pairs and xSignal-class members that are not xSignals have no
    // record to hang on; they stay on the tag as `altium.members` so the class exports exactly.
    const tagList = [...tags.values()].map(t => {
      const out = {name: t.name, as: t.as};
      if (t.missing || t.missingPaths) out.altium = {...(t.missing ? {pairMembers: t.missing} : {}), ...(t.missingPaths ? {xsignalMembers: t.missingPaths} : {})};
      return out;
    });
    const netTags = {}; for (const n of Object.keys(nets).sort(cmp)) netTags[n] = {tags: [...new Set(nets[n])]};
    return {signals, tags: tagList, nets: netTags};
  }
  // The whole project's legacy data as a store (not written; adoption writes it).
  const legacyMemo = new WeakMap();
  function fromLegacy(project) {
    const ids = boardsOf(project).flatMap(b => [...legacyIdentity({...project, documents: [b]}), b.items, index(b, project).gen]), memo = project && legacyMemo.get(project);
    if (memo && sameList(memo.ids, ids)) return memo.store;
    const store = fromLegacyOf(project);
    if (project) legacyMemo.set(project, {ids, store});
    return store;
  }
  // overrides: {[boardId]: class keys} that board's keys instead of its own (applyClasses on a project without a store).
  function fromLegacyOf(project, overrides = {}) {
    const boards = boardsOf(project), store = {version: VERSION, signals: [], tags: [], nets: {}};
    const multi = boards.length > 1, tags = new Map(), sigKeys = new Map(), netRecs = new Map();
    for (const b of boards) {
      const f = boardFromLegacy(b, project, overrides[b.id] ?? legacyOf(b));
      for (const s of f.signals) {
        const k = JSON.stringify({...s, id: undefined});
        const hit = sigKeys.get(k);
        if (hit) { if (hit.boards) hit.boards.push(b.id); continue; }
        const rec = multi ? {...s, boards: [b.id]} : s;
        if (multi && store.signals.some(x => lower(x.name) === lower(s.name))) rec.name = uniqueName(s.name, new Set(store.signals.map(x => lower(x.name))));
        sigKeys.set(k, rec); store.signals.push(rec);
      }
      for (const t of f.tags) { const was = tags.get(t.name); if (!was) tags.set(t.name, clone(t)); else for (const [k, v] of Object.entries(t.as)) if (v !== null) was.as[k] = v; }
      for (const [n, r] of Object.entries(f.nets)) { if (!netRecs.has(n)) netRecs.set(n, []); netRecs.get(n).push({tags: r.tags, board: b.id}); }
    }
    if (multi) for (const s of store.signals) if (s.boards && s.boards.length === boards.length) delete s.boards;
    store.tags = [...tags.values()];
    for (const [n, recs] of [...netRecs].sort((a, b) => cmp(a[0], b[0]))) {
      if (!multi) { store.nets[n] = {tags: recs[0].tags}; continue; }
      const byTags = new Map(); for (const r of recs) { const k = JSON.stringify(r.tags); if (!byTags.has(k)) byTags.set(k, {tags: r.tags, boards: []}); byTags.get(k).boards.push(r.board); }
      const list = [...byTags.values()].map(r => r.boards.length === boards.length ? {tags: r.tags} : r);
      store.nets[n] = list.length === 1 ? list[0] : list;
    }
    return store;
  }

  // ------------------------------------------------------------------ the store, and class keys folded into it
  const legacyIdentity = project => boardsOf(project).flatMap(b => [b, b.sourceClasses ?? null]);
  const sameList = (a, b) => a && b && a.length === b.length && a.every((x, i) => x === b[i]);
  const effective = project => plain(project?.signals) ? project.signals : null;
  // One dimension at a time (pairs, then pair classes, then net classes, then xSignals): only what changed in
  // that dimension is taken from the legacy keys, and a tag that also plays another role (a net class and a
  // pair class of one name) keeps that role; the changed role moves to a tag of its own.
  function reconcile(project, store, dirty) {
    const out = clone(store);
    out.tags ||= []; out.signals ||= [];
    const changedKeys = (a, b) => new Set(Object.keys({...a, ...b}).filter(k => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)));
    const tagNamed = name => out.tags.find(t => lower(t.name) === lower(name));
    const freeTagName = base => uniqueName(base, new Set(out.tags.map(t => lower(t.name))));
    // A tag's roles as they were (an implicit `as` made explicit, so changing one role leaves the others).
    const pinRoles = (t, was) => { if (!t.as) t.as = {net: was.netClasses[t.name] !== undefined ? t.name : null, pair: was.diffPairClasses[t.name] !== undefined ? t.name : null, xsignal: was.xSignalClasses[t.name] !== undefined ? t.name : null}; return t; };
    const roles = (t, was) => ["net", "pair", "xsignal"].filter(k => { const n = exportName(t, k); return n !== null && was[{net: "netClasses", pair: "diffPairClasses", xsignal: "xSignalClasses"}[k]][n] !== undefined; });
    const stripNetTag = (t, board) => { for (const n of Object.keys(out.nets || {})) { const recs = (Array.isArray(out.nets[n]) ? out.nets[n] : [out.nets[n]]).map(r => forBoard(r, board) ? {...r, tags: r.tags.filter(x => lower(x) !== lower(t))} : r).filter(r => r.tags.length); if (recs.length) out.nets[n] = recs.length === 1 ? recs[0] : recs; else delete out.nets[n]; } };
    const stripSignalTag = (t, board, pred = null) => { for (const s of out.signals) if (forBoard(s, board) && s.tags && (!pred || pred(s))) { s.tags = s.tags.filter(x => lower(x) !== lower(t)); if (!s.tags.length) delete s.tags; } };
    // A record lifted from class keys: its tags come from the class passes, and paths another signal hosts stay there.
    const freshRecord = rec => { const r = clone(rec); delete r.tags; if (r.paths) { r.paths = r.paths.filter(p => !out.signals.some(s => s.paths?.some(q => q.name === p.name))); if (!r.paths.length) delete r.paths; } return r; };
    // A tag another board's net records still use keeps its net role there.
    const usedElsewhere = (t, board) => Object.values(out.nets || {}).some(v => [].concat(v).some(r => r.boards && !r.boards.includes(board.id) && r.tags.some(x => lower(x) === lower(t.name))));
    const dropTagIfUnused = t => { const used = out.signals.some(s => (s.tags || []).includes(t.name) || (s.paths || []).some(p => (p.tags || []).includes(t.name))) || Object.values(out.nets || {}).some(v => [].concat(v).some(r => r.tags.includes(t.name)));
      if (!used && (!t.as || Object.values(t.as).every(v => v === null))) out.tags.splice(out.tags.indexOf(t), 1); };
    for (const {board, c, rulesChanged, xsChanged} of dirty) {
      const was = canonicalLegacy(toLegacyFrom(project, out, board, true)), fresh = boardFromLegacy(board, project, c);
      const boards = boardsOf(project), scoped = rec => boards.length > 1 ? {...rec, boards: [board.id]} : rec;
      const multiBoard = boards.length > 1 ? board : null;
      if (rulesChanged) {
        // ---- pairs, by name. Stages of spanned signals are found in the model (derived names NAME.k).
        const oldModel = build(project, board, withDirectives(project, out, board), index(board, project), null, true);
        const oldStages = new Map(oldModel.stages().map(st => [lower(st.name), st]));
        const now = new Map(c.diffPairs.map(p => [p.name, p])), before = new Map(was.diffPairs.map(p => [p.name, p]));
        for (const name of changedKeys(Object.fromEntries(before), Object.fromEntries(now))) {
          const cur = now.get(name), st = oldStages.get(lower(name)), sig = st && out.signals.find(x => x.id === st.id);
          const rec = cur && fresh.signals.find(x => x.kind === "diff" && (x.stages?.[0] ?? x.name) === name);
          if (sig && st.stage > 0) {
            // A derived or stored later stage: the series parts in front of it stop being crossed.
            const m = oldModel.byId.get(sig.id);
            const parts = (m?.legs || []).flatMap(l => (l.parts || []).filter(q => q.depth === st.stage - 1).map(q => q.id));
            sig.exclude = [...new Set([...(sig.exclude || []), ...parts])];
            if (sig.stages) sig.stages = sig.stages.slice(0, st.stage);
            if (rec) out.signals.push(scoped({...freshRecord(rec), id: sid(board.id, "pair", name, "r")}));
          } else if (sig) {
            if (rec) { sig.legs = clone(rec.legs); continue; }
            // Deleted: a signal that hosts xSignal paths stays, single-ended on the same nets; else it goes.
            if (sig.paths?.length && !multiBoard) { sig.kind = "single"; sig.legs = [{nets: [...new Set(sig.legs.flatMap(l => l.nets))]}]; delete sig.stages; }
            else dropFor(out, sig, board, boards);
          } else if (rec) {
            const same = out.signals.find(x => x.kind === "diff" && x.boards && !x.boards.includes(board.id) && JSON.stringify(x.legs) === JSON.stringify(rec.legs) && lower(x.stages?.[0] ?? x.name) === lower(name));
            if (same) { same.boards.push(board.id); if (same.boards.length === boards.length) delete same.boards; continue; }
            const r = freshRecord(rec);
            if (out.signals.some(x => lower(x.name) === lower(r.name))) r.name = uniqueName(r.name, new Set(out.signals.map(x => lower(x.name))));
            out.signals.push(scoped(r));
          }
        }
        const stageSignal = name => { const ms = build(project, board, withDirectives(project, out, board), index(board, project), null, true).stages().find(x => lower(x.name) === lower(name)); return ms && out.signals.find(x => x.id === ms.id); };
        // ---- pair classes
        for (const n of changedKeys(was.diffPairClasses, c.diffPairClasses)) {
          const owners = out.tags.filter(t => exportName(t, "pair") === n);
          let host = null;
          for (const t of owners) {
            pinRoles(t, was);
            if (roles(t, was).some(r => r !== "pair")) { t.as.pair = null; continue; }   // keeps its net / xSignal role
            stripSignalTag(t.name, board, x => x.kind === "diff");
            if (t.altium?.pairMembers) delete t.altium.pairMembers;
            host = t;
          }
          if (c.diffPairClasses[n] === undefined) { if (host) { host.as.pair = null; dropTagIfUnused(host); } continue; }
          if (!host) { host = {name: tagNamed(n) ? freeTagName(n + " (pairs)") : n, as: {net: null, pair: n, xsignal: null}}; out.tags.push(host); }
          for (const m of c.diffPairClasses[n]) { const x = stageSignal(m); if (x) x.tags = [...new Set([...(x.tags || []), host.name])]; else ((host.altium ||= {}).pairMembers ||= []).push(m); }
        }
        // ---- net classes
        for (const n of changedKeys(was.netClasses, c.netClasses)) {
          const owners = out.tags.filter(t => exportName(t, "net") === n);
          let host = null;
          for (const t of owners) {
            pinRoles(t, was);
            stripNetTag(t.name, multiBoard);
            if (roles(t, was).some(r => r !== "net")) { t.as.net = null; continue; }        // keeps its pair / xSignal role
            stripSignalTag(t.name, board);
            host = t;
          }
          if (c.netClasses[n] === undefined) { if (host && !(multiBoard && usedElsewhere(host, board))) { host.as.net = null; dropTagIfUnused(host); } continue; }
          if (!host) { host = {name: tagNamed(n) ? freeTagName(n + " (nets)") : n, as: {net: n, pair: null, xsignal: null}}; out.tags.push(host); }
          for (const net of c.netClasses[n]) addNetTag(out, net, host.name, multiBoard);
        }
      }
      if (xsChanged) {
        const now = new Map(c.xSignals.map(x => [x.name, x])), before = new Map(was.xSignals.map(x => [x.name, x]));
        const changed = changedKeys(Object.fromEntries(before), Object.fromEntries(now));
        const ccls = changedKeys(was.xSignalClasses, c.xSignalClasses);
        for (const s of out.signals) if (forBoard(s, board) && s.paths) {
          s.paths = s.paths.filter(p => !changed.has(p.name));
          for (const p of s.paths) if (p.tags) { p.tags = p.tags.filter(t => !ccls.has(exportName(tagNamed(t) || {name: t}, "xsignal"))); if (!p.tags.length) delete p.tags; }
          if (!s.paths.length) delete s.paths;
        }
        for (const n of ccls) if (c.xSignalClasses[n] === undefined) for (const t of out.tags.filter(t => exportName(t, "xsignal") === n)) { pinRoles(t, was); t.as.xsignal = null; dropTagIfUnused(t); }
        for (const s of fresh.signals) for (const p of s.paths || []) {
          if (!changed.has(p.name) && !(p.tags || []).some(t => ccls.has(t))) continue;
          let target = s.legs.flatMap(l => l.nets).map(n => signalWithSeed(out, board, n)).find(Boolean);
          if (!target) { target = scoped({...clone(s), paths: []}); if (out.signals.some(x => lower(x.name) === lower(target.name))) target.name = uniqueName(target.name, new Set(out.signals.map(x => lower(x.name)))); out.signals.push(target); }
          target.paths ||= [];
          const i = target.paths.findIndex(x => x.name === p.name);
          if (i >= 0) target.paths[i] = clone(p); else target.paths.push(clone(p));
        }
        for (const t of fresh.tags) if (t.as.xsignal) { const have = tagNamed(t.name); if (!have) out.tags.push(clone(t)); else { pinRoles(have, was); have.as.xsignal = t.as.xsignal; } }
      }
    }
    return out;
  }
  // Removes a record from one board: deleted on a single board, else narrowed to the other boards.
  function dropFor(store, rec, board, boards) {
    if (boards.length > 1) { rec.boards = (rec.boards || boards.map(b => b.id)).filter(id => id !== board.id); if (rec.boards.length) return; }
    store.signals.splice(store.signals.indexOf(rec), 1);
  }
  function addNetTag(store, net, tag, board) {
    store.nets ||= {};
    const recs = store.nets[net] ? (Array.isArray(store.nets[net]) ? store.nets[net] : [store.nets[net]]) : [];
    let r = recs.find(x => board ? x.boards?.length === 1 && x.boards[0] === board.id : !x.boards);
    if (!r) recs.push(r = board ? {tags: [], boards: [board.id]} : {tags: []});
    if (!r.tags.includes(tag)) r.tags.push(tag);
    store.nets[net] = recs.length === 1 ? recs[0] : recs;
  }
  const signalWithSeed = (store, board, net) => store.signals.find(s => forBoard(s, board) && s.legs?.some(l => l.nets.includes(net)));


  // ------------------------------------------------------------------ schematic directives (a live source)
  // Signal and tag intent placed on the schematic: the legacy properties netClass ("A,B") and diffPair on
  // net labels, ports, power ports, off-sheet connectors and wires, the 1.4 fields signal, polarity (1|-1)
  // and tags (["HS"] or "HS,USB"), and the same fields on a directive item (kind "directive", net from its
  // `net`). Collected from the sheets whenever the model is built and never copied into the store: deleting
  // the directive removes the intent; it reaches the board at once, as one undoable schematic edit.
  // docs/design/unified-rules-and-checks.md §1.5: impedance, rules, params and waive pass through for the
  // rule sources. -> {records:[{sheet, item, net, signal?, polarity?, diffPair?, tags, netTags, ...}], issues}
  const DIRECTIVE_KINDS = new Set(["netlabel", "port", "power", "offsheet", "wire", "directive"]);
  const listOf = v => Array.isArray(v) ? v.filter(x => typeof x === "string").map(x => x.trim()).filter(Boolean) : typeof v === "string" ? v.split(",").map(x => x.trim()).filter(Boolean) : [];
  const hasDirective = i => i && DIRECTIVE_KINDS.has(i.kind) && (i.netClass != null || i.diffPair != null || i.signal != null || i.polarity != null || i.tags != null || i.impedance != null || i.rules != null || i.params != null || i.waive != null);
  const directiveCache = new WeakMap();
  const EMPTY_DIRECTIVES = Object.freeze({records: Object.freeze([]), issues: Object.freeze([]), stamp: null});
  const directiveResults = new WeakMap();
  function directives(project, o = {}) {
    const records = [], issues = [];
    if (!project?.documents) return EMPTY_DIRECTIVES;
    let defs = null, hier;
    const hierarchy = G.AtriumHierarchy;
    // A wire's name can come from another sheet. Share the hierarchy's
    // certified electrical graph only when a directive needs its wire map.
    function wireGraph(version) {
      if (hier !== undefined) return hier;
      defs = defsOf(project, version) || new Map();
      try { hier = (hierarchy?.compileCached ?? hierarchy?.compile)?.(project, {defs, publish:false}) || null; }
      catch { hier = null; }
      return hier;
    }
    for (const sheet of project.documents) {
      if (sheet?.kind !== "schematic" || !Array.isArray(sheet.items)) continue;
      const vk = versionKey(sheet, project, o), hit = directiveCache.get(sheet);
      if (hit && vk.key && hit.key === vk.key && hit.items === sheet.items && hit.name === sheet.name &&
          (!hit.wire || hit.graph && hit.graph === wireGraph(vk.library))) {
        records.push(...hit.records); issues.push(...hit.issues); continue;
      }
      const mine = [], bad = [], items = sheet.items.filter(hasDirective);
      const wire = items.some(item => item.kind === "wire"), graph = wire ? wireGraph(vk.library) : null;
      let byWire = null;
      for (const i of items) {
        let net = "";
        if (i.kind === "wire") {
          if (!byWire) {
            let g = graph?.byDoc?.get(sheet.id) || null;
            if (!g) try { g = G.Atrium?.connectivity?.(sheet, defs) || null; } catch { g = null; }
            byWire = g?.byWire || new Map();
          }
          net = byWire.get(i.id) || "";
        } else net = String((i.kind === "directive" ? i.net : i.text) ?? "").trim();
        if (!validName(net)) { bad.push({kind: "directive", sheet: sheet.id, item: i.id, text: sheet.name + ": a signal or tag directive is not on a named net."}); continue; }
        const r = {sheet: sheet.id, sheetName: sheet.name, item: i.id, net, tags: listOf(i.tags), netTags: listOf(i.netClass)};
        const sig = typeof i.signal === "string" && i.signal.trim() ? i.signal.trim() : null, dp = typeof i.diffPair === "string" && i.diffPair.trim() ? i.diffPair.trim() : null;
        if (sig) r.signal = sig; if (dp) r.diffPair = dp;
        if (i.polarity === 1 || i.polarity === -1) r.polarity = i.polarity;
        for (const k of ["impedance", "rules", "params", "waive"]) if (i[k] != null) r[k] = clone(i[k]);
        mine.push(r);
      }
      directiveCache.set(sheet, {key: vk.key, items: sheet.items, name: sheet.name, wire, graph, records: mine, issues: bad});
      records.push(...mine); issues.push(...bad);
    }
    if (!records.length && !issues.length) return EMPTY_DIRECTIVES;
    // The same identity while nothing changed, so models built on it stay memoised.
    const key = JSON.stringify([records, issues]), hit = directiveResults.get(project);
    if (hit && hit.key === key) return hit.result;
    const result = {records, issues};
    result.stamp = result;
    directiveResults.set(project, {key, result});
    return result;
  }
  // Derived declarations from the directives, merged into a store copy for the model (never written).
  // Stored signals win over a directive of the same name (the directive is reported).
  const derivedStores = new WeakMap();
  function withDirectives(project, store, board, dirs = directives(project), base) {
    const {records, issues} = dirs;
    if (!records.length && !issues.length) return store;
    base ??= JSON.stringify(store);
    const memo = derivedStores.get(store);
    if (memo && memo.dirs === dirs.stamp && memo.base === base) return memo.out;
    const out = derive(store, records, issues);
    derivedStores.set(store, {dirs: dirs.stamp, base, out});
    return out;
  }
  function derive(store, records, issues) {
    const out = {...store, signals: [...(store.signals || [])], nets: {...(store.nets || {})}, signalTags: {}, directiveIssues: [...issues]};
    const stored = new Set(out.signals.map(s => lower(s.name))), named = new Map(), seedsOf = new Map(out.signals.map(s => [lower(s.name), (s.legs || []).flatMap(l => l.nets).sort(natural).join("\u0001")]));
    for (const r of records) {
      for (const t of r.netTags) { const was = out.nets[r.net]; const recs = was ? (Array.isArray(was) ? was : [was]).map(x => ({...x, tags: [...x.tags]})) : []; let x = recs.find(q => !q.boards); if (!x) recs.push(x = {tags: []}); if (!x.tags.includes(t)) x.tags.push(t); out.nets[r.net] = recs.length === 1 ? recs[0] : recs; }
      const name = r.signal || r.diffPair;
      if (name) { const k = lower(name); if (!named.has(k)) named.set(k, {name, diff: false, nets: new Map(), tags: new Set(), origin: r}); const g = named.get(k); if (r.diffPair || r.polarity) g.diff = true; if (!g.nets.has(r.net) || r.polarity) g.nets.set(r.net, r.polarity ?? g.nets.get(r.net) ?? null); r.tags.forEach(t => g.tags.add(t)); }
      else if (r.tags.length) { const t = out.signalTags[r.net] ||= []; for (const x of r.tags) if (!t.includes(x)) t.push(x); }
    }
    for (const g of [...named.values()].sort((a, b) => natural(a.name, b.name))) {
      // A stored signal of the same name wins; when it has the same nets (an older ECO copied it) say nothing.
      if (stored.has(lower(g.name))) { if (seedsOf.get(lower(g.name)) === [...g.nets.keys()].sort(natural).join("\u0001")) continue; out.directiveIssues.push({kind: "double", signal: g.name, text: "Signal " + g.name + " is declared in the Signals panel and by a schematic directive; the stored one is used."}); continue; }
      const id = "dir-" + hash(lower(g.name)).slice(3, 15), origin = {kind: "directive", doc: g.origin.sheet, item: g.origin.item}, tags = [...g.tags].sort(natural);
      const nets = [...g.nets.keys()];
      if (!g.diff) { out.signals.push({id, name: g.name, kind: "single", legs: [{nets}], ...(tags.length ? {tags} : {}), origin}); stored.add(lower(g.name)); continue; }
      if (nets.length !== 2) { out.directiveIssues.push({kind: "pair", signal: g.name, text: "Differential pair " + g.name + " needs two nets; its directives name " + (nets.sort(natural).join(", ") || "none") + "."}); continue; }
      let pos = null, neg = null, assumed = false;
      const pol = nets.map(n => g.nets.get(n));
      if (pol[0] === 1 || pol[1] === -1) [pos, neg] = nets; else if (pol[0] === -1 || pol[1] === 1) [neg, pos] = nets;
      else {
        let o = null; try { o = G.AtriumNetIntent?.orient?.(nets) || null; } catch { o = null; }
        if (o) { pos = o.positive; neg = o.negative; assumed = o.known === false; }
        else { [pos, neg] = [...nets].sort(natural); assumed = true; }
      }
      if (assumed) out.directiveIssues.push({kind: "polarity", signal: g.name, text: "Polarity of " + g.name + " was assumed (+ = " + pos + "). Set polarity on its directive, or flip it in Signals, if that is wrong."});
      out.signals.push({id, name: g.name, kind: "diff", legs: [{polarity: 1, nets: [pos]}, {polarity: -1, nets: [neg]}], ...(tags.length ? {tags} : {}), origin});
      stored.add(lower(g.name));
    }
    return out;
  }

  // ------------------------------------------------------------------ the model
  function exportName(t, kind) { if (t.as && own(t.as, kind)) return t.as[kind]; return t.name; }
  const models = new WeakMap(), defsMemo = new WeakMap(), storeInputs = new WeakMap();
  function defsOf(project, version) {
    const lib = project?.library;
    if (!Array.isArray(lib)) return null;
    let d = defsMemo.get(lib);
    if (!d || d.n !== lib.length || (version != null ? d.version !== version : lib.some(x => d.map.get(x.id) !== x))) {
      d = {n: lib.length, version, map: new Map(lib.map(x => [x.id, x]))};
      defsMemo.set(lib, d);
    }
    return d.map;
  }
  function storeInput(store, undo, version) {
    const hit = storeInputs.get(store);
    if (version != null && hit?.undo === undo && hit.version === version) return hit.input;
    const input = JSON.stringify(store);
    if (version != null) storeInputs.set(store, {undo, version, input});
    return input;
  }
  // M: {store, signals, byNet, issues, signalOf(net), tagsOf(net), netsOfTag(tag), netsOfSignal(name),
  //     stages(), pairOf(net), paths(), legacy() -> canonical legacy keys, netClasses(), diffPairs(), ...}
  // A board outside any known project models alone, through one stable wrapper (so the memos hold).
  const solos = new WeakMap(), soloOf = board => { let p = solos.get(board); if (!p) solos.set(board, p = {documents: [board]}); return p; };
  function model(project, board, o = {}) {
    if (!board) fail("Choose a board.");
    project ||= projectOf(board);
    if (project) owners.set(board, project);
    // Replay can keep the store reference. Compare its content when the committed project inputs advance.
    const native = project && effective(project), base = native || fromLegacy(project || soloOf(board));
    const undo = G.AtriumUndoStore, recorded = project && undo?.documentVersions?.(board, project);
    const input = native ? storeInput(base, undo, recorded ? undo.outer() : null) : base;
    const libraryVersion = recorded ? recorded.library : null;
    const dirs = directives(project), I = index(board, project, o), defs = o.defs || defsOf(project, libraryVersion);
    const per = models.get(board);
    if (per && per.base === base && per.input === input && per.dirs === dirs.stamp && per.gen === I.gen &&
        per.I === I && per.defs === defs && per.libraryVersion === libraryVersion) return per.M;
    const M = build(project, board, withDirectives(project, base, board, dirs, input), I, defs, !!project?.signals);
    models.set(board, {base, input, dirs: dirs.stamp, gen: I.gen, I, defs, libraryVersion, M});
    return M;
  }
  function build(project, board, store, I, defs, adopted) {
    const issues = [...(store.directiveIssues || [])], sigs = [], byId = new Map();
    for (const decl of store.signals || []) {
      if (!forBoard(decl, board)) continue;
      const s = {id: decl.id, name: decl.name, kind: decl.kind, decl, tags: [...(decl.tags || [])], exclude: new Set(decl.exclude || []), through: new Set(decl.through || []), legs: [], busses: [], derived: decl.origin?.kind === "directive"};
      byId.set(s.id, s);
      if (decl.kind === "bus") { s.members = [...decl.members]; sigs.push(s); continue; }
      s.legs = (decl.legs || []).map(l => ({polarity: l.polarity, seeds: [...l.nets]}));
      sigs.push(s);
    }
    let leaf = sigs.filter(s => s.kind !== "bus");
    // Signal-level tags placed on a net (schematic directives): they go to the signal whose span holds the
    // net, else to a derived single-ended signal seeded there (one more spanning pass).
    const signalTags = Object.entries(store.signalTags || {});
    if (signalTags.length) {
      const probe = leaf.map(s => ({...s, legs: s.legs.map(l => ({...l}))}));
      const covered = spanAll(probe, I, store, defs, []), used = new Set(sigs.map(s => lower(s.name)));
      for (const [net, tags] of signalTags) if (!covered.has(net)) {
        const id = "dir-net-" + hash(net).slice(3, 15), decl = {id, name: uniqueName(net, used), kind: "single", legs: [{nets: [net]}], tags: [...tags], origin: {kind: "directive", net}};
        const s = {id, name: decl.name, kind: "single", decl, tags: [], exclude: new Set(), through: new Set(), legs: [{polarity: undefined, seeds: [net]}], busses: [], derived: true};
        sigs.push(s); byId.set(id, s);
      }
      leaf = sigs.filter(s => s.kind !== "bus");
    }
    const owner = spanAll(leaf, I, store, defs, issues);
    for (const s of leaf) for (const l of s.legs) { l.nets = l.span.nets; l.parts = l.span.parts; l.depth = l.span.depth; delete l.span; }
    for (const [net, tags] of signalTags) { const w = owner.get(net)?.sig; if (w) for (const t of tags) if (!w.tags.includes(t)) w.tags.push(t); }
    for (const b of sigs) if (b.kind === "bus") for (const m of b.members) byId.get(m)?.busses.push(b);
    const byNet = new Map();
    for (const s of leaf) s.legs.forEach((l, li) => { for (const n of l.nets) byNet.set(n, {sig: s, leg: li, polarity: l.polarity}); });
    // Tags: net-level, then signal-level, then the busses a signal is in.
    const tagMeta = new Map((store.tags || []).map(t => [lower(t.name), t]));
    const netTags = new Map();
    const put = (n, t) => { let x = netTags.get(n); if (!x) netTags.set(n, x = new Set()); x.add(t); };
    for (const [n, v] of Object.entries(store.nets || {})) for (const r of Array.isArray(v) ? v : [v]) if (forBoard(r, board)) for (const t of r.tags) put(n, t);
    const sigTags = s => [...s.tags, ...s.busses.flatMap(b => b.tags)];
    for (const s of leaf) for (const t of sigTags(s)) for (const l of s.legs) for (const n of l.nets) put(n, t);
    const tagsLower = new Map(); for (const [n, set] of netTags) tagsLower.set(n, new Set([...set].map(lower)));
    // Stages of each diff signal: the plus and minus nets at the same depth.
    let stageList = null;
    const stages = () => {
      if (stageList) return stageList;
      stageList = [];
      for (const s of leaf) {
        if (s.kind !== "diff") continue;
        const P = s.legs.find(l => l.polarity === 1), N = s.legs.find(l => l.polarity === -1);
        const depth = Math.max(...[...P.depth.values(), ...N.depth.values()], 0);
        for (let k = 0; k <= depth; k++) {
          const p = P.nets.filter(n => P.depth.get(n) === k), q = N.nets.filter(n => N.depth.get(n) === k);
          if (p.length === 1 && q.length === 1) stageList.push({name: s.decl.stages?.[k] ?? (k ? s.name + "." + k : s.name), positive: p[0], negative: q[0], signal: s.name, id: s.id, stage: k});
          else if (p.length || q.length) issues.push({kind: "stage", signal: s.name, stage: k, text: "Stage " + k + " of " + s.name + " does not pair one net on each leg (" + [...p, ...q].join(", ") + ")."});
        }
      }
      return stageList;
    };
    let pairByNet = null;
    const pairOf = net => { if (!pairByNet) { pairByNet = new Map(); for (const p of stages()) { pairByNet.set(p.positive, p); pairByNet.set(p.negative, p); } } return pairByNet.get(net) || null; };
    const refOf = id => I.parts.get(id)?.ref;
    const legacyEnd = e => ({ref: e.part ? refOf(e.part) ?? e.ref ?? e.part : e.ref, pin: e.pin});
    // Paths: stored ones; else one automatic path per spanned leg (source = the end part with more pins).
    let pathList = null;
    const paths = () => {
      if (pathList) return pathList;
      pathList = [];
      for (const s of leaf) {
        if (s.decl.paths?.length) { for (const p of s.decl.paths) pathList.push({...clone(p), signal: s.name, id: s.id, auto: false, tags: [...(p.tags || [])]}); continue; }
        for (const l of s.legs) {
          if (l.nets.length < 2) continue;
          // Ends: pins of parts the leg does not cross. Pull-ups, shunts and test points (parts with two
          // connected pins or fewer) are not ends when two larger parts are there.
          const crossed = new Set(l.parts.map(x => x.id)), all = [];
          for (const n of l.nets) for (const e of I.pinsOf.get(n) || []) if (!crossed.has(e.id)) all.push(e);
          const big = all.filter(e => Object.values(I.parts.get(e.id)?.pinNets || {}).filter(Boolean).length > 2);
          const ends = big.length === 2 ? big : all;
          if (ends.length !== 2 || ends[0].id === ends[1].id) continue;
          const pc = e => Object.keys(I.parts.get(e.id)?.pinNets || {}).length;
          const [a, b] = pc(ends[0]) !== pc(ends[1]) ? (pc(ends[0]) > pc(ends[1]) ? ends : [ends[1], ends[0]]) : natural(refOf(ends[0].id), refOf(ends[1].id)) <= 0 ? ends : [ends[1], ends[0]];
          const srcNet = I.parts.get(a.id).pinNets[a.pin];
          pathList.push({name: srcNet, from: {part: a.id, pin: a.pin}, to: {part: b.id, pin: b.pin}, through: [...new Set(l.parts.map(x => x.ref))], nets: [...l.nets], signal: s.name, id: s.id, auto: true, tags: []});
        }
      }
      return pathList;
    };
    // Class views (canonical form): what InNetClass & co. mean, and what exporters write.
    let legacyView = null;
    const legacy = () => {
      if (legacyView) return legacyView;
      const netClasses = {}, diffPairClasses = {}, xSignalClasses = {};
      const add = (m, k, v) => { (m[k] ||= new Set()).add(v); };
      // Tags whose net records are all scoped to other boards: their (declared) class is not this board's.
      const away = new Map();
      for (const v of Object.values(store.nets || {})) for (const r of [].concat(v)) for (const tn of r.tags) { const k = lower(tn), here = forBoard(r, board); away.set(k, (away.get(k) ?? true) && !here); }
      for (const t of store.tags || []) {
        const n = exportName(t, "net"), p = exportName(t, "pair"), x = exportName(t, "xsignal"), fixed = !!t.as;
        if (n !== null && (fixed && t.as.net) && away.get(lower(t.name)) !== true) netClasses[n] ||= new Set();
        if (p !== null && (fixed && t.as.pair)) diffPairClasses[p] ||= new Set();
        if (x !== null && (fixed && t.as.xsignal)) xSignalClasses[x] ||= new Set();
        for (const m of t.altium?.pairMembers || []) if (p) add(diffPairClasses, p, m);
        for (const m of t.altium?.xsignalMembers || []) if (x) add(xSignalClasses, x, m);
      }
      for (const [net, set] of netTags) for (const tn of set) { const t = tagMeta.get(lower(tn)) || {name: tn}, n = exportName(t, "net"); if (n !== null) add(netClasses, n, net); }
      for (const p of stages()) { const s = byId.get(p.id); for (const tn of sigTags(s)) { const t = tagMeta.get(lower(tn)) || {name: tn}, n = exportName(t, "pair"); if (n !== null) add(diffPairClasses, n, p.name); } }
      for (const p of paths()) {
        if (p.auto) continue;
        for (const tn of p.tags) { const t = tagMeta.get(lower(tn)) || {name: tn}, n = exportName(t, "xsignal"); if (n !== null) add(xSignalClasses, n, p.name); }
        for (const tn of sigTags(byId.get(p.id))) { const t = tagMeta.get(lower(tn)); if (t && !t.as) add(xSignalClasses, t.name, p.name); }
      }
      const done = m => { const o = {}; for (const k of Object.keys(m).sort(cmp)) o[k] = [...m[k]].sort(cmp); return o; };
      const xs = paths().filter(p => !p.auto).map(p => { const e = {name: p.name, from: legacyEnd(p.from), to: legacyEnd(p.to)}; if (p.through?.length) e.through = [...p.through]; if (p.nets?.length) e.nets = [...p.nets]; return e; }).sort((a, b) => cmp(a.name, b.name));
      legacyView = {netClasses: done(netClasses), diffPairs: stages().map(p => ({name: p.name, positive: p.positive, negative: p.negative})).sort((a, b) => cmp(a.name, b.name)),
        diffPairClasses: done(diffPairClasses), xSignals: xs, xSignalClasses: done(xSignalClasses)};
      return legacyView;
    };
    const signalOf = net => { const e = byNet.get(net); return e ? {id: e.sig.id, name: e.sig.name, kind: e.sig.kind, polarity: e.polarity ?? null, leg: e.leg, stage: pairOf(net)?.stage ?? null} : null; };
    const netsOfSignal = name => {
      const s = sigs.find(x => lower(x.name) === lower(name)); if (!s) { const p = stages().find(x => lower(x.name) === lower(name)); return new Set(p ? [p.positive, p.negative] : []); }
      const out = new Set(), walk = (x, seen = new Set()) => { if (seen.has(x.id)) return; seen.add(x.id); if (x.kind === "bus") x.members.forEach(m => byId.has(m) && walk(byId.get(m), seen)); else for (const l of x.legs) l.nets.forEach(n => out.add(n)); };
      walk(s); return out;
    };
    const netsOfTag = tag => { const t = lower(tag), out = new Set(); for (const [n, set] of tagsLower) if (set.has(t)) out.add(n); return out; };
    const M = {project, board, store, adopted, signals: sigs, byId, byNet, issues, index: I,
      signalOf, tagsOf: net => tagsLower.get(net) || new Set(), tagNames: net => [...(netTags.get(net) || [])], netsOfTag, netsOfSignal, stages, pairOf, paths, legacy,
      netClasses: () => clone(legacy().netClasses), diffPairs: () => legacy().diffPairs.map(p => ({...p})), diffPairClasses: () => clone(legacy().diffPairClasses),
      xSignals: () => clone(legacy().xSignals), xSignalClasses: () => clone(legacy().xSignalClasses)};
    stages(); // its issues (unpaired stages) belong to every reader of M.issues
    return M;
  }

  // The scope seam for rules.js compile() and query.js: maps in the shapes they already use, plus the
  // signal and tag lookups. null when the project has no store (the legacy keys are then exact).
  const envs = new WeakMap();
  function scopeEnv(board, project, o = {}) {
    project ||= projectOf(board);
    if (!board || !plain(project?.signals) && !directives(project).records.length) return null;
    const M = model(project, board, o), hit = envs.get(M);
    if (hit) return hit;
    const L = M.legacy(), lowerSet = a => new Set(a.map(lower));
    const classes = new Map(Object.entries(L.netClasses).map(([k, v]) => [k, new Set(v)]));
    const pairs = new Map(M.stages().map(p => [p.name, {name: p.name, positive: p.positive, negative: p.negative, signal: p.signal}]));
    const pairOfNet = new Map(); for (const p of pairs.values()) { pairOfNet.set(p.positive, p); pairOfNet.set(p.negative, p); }
    const pairClasses = new Map(Object.entries(L.diffPairClasses).map(([k, v]) => [k, new Set(v)]));
    // xSignal index in query.js's shape: byName lower(path) -> Set(lower(net)); classes; classNets.
    const byName = new Map(), xc = new Map(), classNets = new Map();
    // A stored path's nets: its own list, else its end pins' nets (as query.js reads lengthTuning xSignals),
    // never the whole signal.
    const byRef = new Map(); for (const part of M.index.parts.values()) if (part.ref && !byRef.has(part.ref)) byRef.set(part.ref, part);
    const endNet = e => (e?.part ? M.index.parts.get(e.part) : byRef.get(e?.ref))?.pinNets?.[e?.pin];
    for (const p of M.paths()) { const nets = p.nets?.length ? p.nets : [...new Set([endNet(p.from), endNet(p.to)].filter(Boolean))]; byName.set(lower(p.name), lowerSet(nets)); }
    for (const [k, v] of Object.entries(L.xSignalClasses)) xc.set(lower(k), lowerSet(v));
    for (const [c, names] of xc) { const s = new Set(); for (const n of names) for (const net of byName.get(n) || []) s.add(net); classNets.set(c, s); }
    const env = {model: M, classes, pairs, pairOfNet, pairClasses, xs: {byName, classes: xc, classNets},
      signalOf: M.signalOf, tagsOf: M.tagsOf, netsOfTag: M.netsOfTag, netsOfSignal: M.netsOfSignal, pairOf: M.pairOf,
      hasTag: (net, tag) => !!net && M.tagsOf(net).has(lower(tag)), inSignal: (net, name) => !!net && M.netsOfSignal(name).has(net),
      pathTags: name => { const p = M.paths().find(x => lower(x.name) === lower(name)); if (!p) return new Set(); const s = M.byId.get(p.id); return new Set([...p.tags, ...(s ? [...s.tags, ...s.busses.flatMap(b => b.tags)] : [])].map(lower)); }};
    envs.set(M, env);
    return env;
  }

  // ------------------------------------------------------------------ writing
  function toLegacyFrom(project, store, board, direct = false) {
    if (!direct && project && store === project.signals) return model(project, board).legacy();
    return build(project, board, withDirectives(project, store, board), index(board, project), defsOf(project), true).legacy();
  }
  function toLegacy(project, board) { return model(project, board).legacy(); }
  // A board's {xSignals, xSignalClasses} as the model gives them (canonical; shared, never edit it).
  const NO_XS = Object.freeze({xSignals: Object.freeze([]), xSignalClasses: Object.freeze({})});
  function xsView(board, project) {
    project ||= projectOf(board);
    // Cheap answer for the usual board: no stored paths or xSignal classes, and no imported records.
    const st = project && effective(project);
    if (st ? !(st.signals || []).some(x => x.paths?.length) && !(st.tags || []).some(t => t.as?.xsignal || t.altium?.xsignalMembers) : !board?.sourceClasses?.length) return NO_XS;
    try { const L = model(project, board).legacy(); return {xSignals: L.xSignals, xSignalClasses: L.xSignalClasses}; }
    catch { return NO_XS; }
  }
  // A pure legacy view uses reproducible scratch IDs for selection. At the
  // first real edit, keep the selection valid through the callback and persist
  // the adopted UUIDs alongside any references from newly created buses.
  function materializeSignals(store, pending) {
    const ids = new Map();
    for (const signal of store.signals || []) if (pending(signal.id)) {
      const old = signal.id;
      signal.id = globalThis.AtriumUUID.next();
      ids.set(old, signal.id);
    }
    if (ids.size) for (const signal of store.signals || []) if (signal.kind === "bus") {
      signal.members = signal.members.map(id => ids.get(id) ?? id);
    }
  }
  // A board's net classes, pairs, pair classes, xSignals and xSignal classes become `keys` ({netClasses?,
  // diffPairs?, diffPairClasses?, xSignals?, xSignalClasses?}: an importer's, an editor's or a wizard's view);
  // what the keys cannot say (spans, exclusions, intent, buses, ids) is kept. One edit; false when nothing changes.
  function applyClasses(project, board, keys) {
    if (!project) fail("Open a project first.");
    if (project.atriumCompat?.top?.signals) fail("The signals in this file were saved by a newer Waffle. Edit them there; this version keeps them unchanged.");
    attach(project);
    const base = effective(project) || fromLegacy(project), cur = canonicalLegacy(toLegacyFrom(project, base, board, true));
    const c = canonicalLegacy({...cur, ...Object.fromEntries(["netClasses", "diffPairs", "diffPairClasses", "xSignals", "xSignalClasses"].filter(k => keys?.[k] !== undefined).map(k => [k, keys[k]]))});
    if (sameKeys(c, cur)) return false;
    // Without a store the keys are lifted exactly (as every board's own keys are); with one, folded in.
    const rulesChanged = hash(rulesPart(c)) !== hash(rulesPart(cur)), xsChanged = hash(xsPart(c)) !== hash(xsPart(cur));
    const store = plain(project.signals) ? reconcile(project, base, [{board, c, rulesChanged, xsChanged}]) : clone(fromLegacyOf(project, {[board.id]: c}));
    const storedIds = new Set((project.signals?.signals || []).map(signal => signal.id));
    materializeSignals(store, id => !storedIds.has(id));
    store.version = VERSION;
    validate(store);
    project.signals = store;
    return true;
  }
  // Adopts (first edit), applies fn(store) and validates. The caller wraps it in
  // the editor's edit step (or the MCP mutation), so it is one undo step.
  function edit(project, fn) {
    if (!project) fail("Open a project first.");
    if (project.atriumCompat?.top?.signals) fail("The signals in this file were saved by a newer Waffle. Edit them there; this version keeps them unchanged.");
    attach(project);
    const base = effective(project) || fromLegacy(project);
    const store = clone(base);
    const result = fn(store);
    if (!project.signals) {
      const projected = new Set(base.signals.map(signal => signal.id));
      materializeSignals(store, id => projected.has(id));
    }
    store.version = VERSION;
    validate(store);
    project.signals = store;
    return result;
  }
  // A new name for a net in every stored seed, net tag and path cache.
  function renameNet(store, from, to) {
    let n = 0;
    for (const s of store.signals || []) {
      for (const l of s.legs || []) if (l.nets.includes(from)) {
        l.nets = [...new Set(l.nets.map(net => net === from ? to : net))]; n++;
      }
      for (const p of s.paths || []) if (p.nets?.includes(from)) {
        p.nets = p.nets.map(net => net === from ? to : net); n++;
      }
    }
    if (store.nets && own(store.nets, from)) { const v = store.nets[from]; delete store.nets[from]; if (store.nets[to]) { const a = [].concat(store.nets[to], v); store.nets[to] = a.length === 1 ? a[0] : a; } else store.nets[to] = v; n++; }
    return n;
  }

  return Object.freeze({VERSION, KINDS, validate, attach, projectOf, series, parsePins, model, scopeEnv, fromLegacy, toLegacy, canonicalLegacy, legacyOf, effective,
    edit, applyClasses, xsView, renameNet, hash, exportName, supply, directives});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumSignals;
