"use strict";
// Library catalogue v2 (PARITY-3 task 6). Lazy: registered from parts.js with catalogue.css.
// Used by Place › Component (editor.js renderLibrary), the Library panel (library-panel.js),
// the symbol editor's "Use footprint of" picker and, through find(), by MCP / scripts.
//
//  * One category scheme for built-in (std-*), starter and project parts: a two-level tree
//    (group › category). Unknown categories keep their name and sit under the group their
//    designator prefix implies. Stored categories are never rewritten.
//  * Duplicates: a built-in part whose starter twin is in the same library is hidden from
//    lists and search. Its id still resolves (designs keep working; get() finds it).
//  * Parametric filter: Value, Tolerance, Voltage, Package, Pins and Mounting (SMD/TH), with
//    facet counts that ignore the facet's own selection (so alternatives stay visible).
//  * Search folds Unicode (U+2212 minus -> "-", µ -> u, Ω -> ohm, × -> x) and accepts
//    field terms: value:10k tol:1% v:50 pkg:0603 pins:3 pins>8 mount:smd cat:diode has:footprint.
//  * Index: one record per def, built lazily on first use and cached until the def changes.
//
//   AtriumCatalogue.find(query, {project, defs, limit, all}) -> [{id, name, category, value, package, …}]
//   AtriumCatalogue.get(id, {project, defs})                 -> the def (hidden duplicates included)
//   AtriumCatalogue.query(defs, query, {ids, state, keep, footprints}) -> {items, counts, hidden}
//   AtriumCatalogue.render(list, o)        Place › Component: facets | tree | preview
//   AtriumCatalogue.preview(host, def, o)  symbol + footprint side by side, plus parameters
//   AtriumCatalogue.facetsUI(host, key, counts, onChange, o)
//   AtriumCatalogue.tree(list, defs, row, o)
// v1 names (pick, matches, facets, category, groupOf, hidden, uniqueFootprints, packageOf,
// subtitle, fold, compact, GROUPS, SUPERSEDED) keep working.
globalThis.AtriumCatalogue = (() => {
  // ------------------------------------------------------------------ text
  const fold = text => (globalThis.AtriumParts?.fold || (s => String(s ?? "").normalize("NFKC").toLowerCase().replace(/[‐-―−﹣－]/g, "-")))(text);
  const compact = text => fold(text).replace(/\s+/g, "");
  const collator = new Intl.Collator("en", {numeric: true, sensitivity: "base"});
  const natural = (a, b) => collator.compare(String(a), String(b));

  // ------------------------------------------------------------------ categories
  const GROUPS = [["Passives", ["Resistors", "Capacitors", "Inductors", "Frequency control", "Protection"]],
    ["Semiconductors", ["Diodes", "Transistors", "Optoelectronics"]],
    ["Integrated circuits", ["Regulators", "Amplifiers", "Microcontrollers", "Logic", "Memory", "Interface", "Sensors", "Other ICs"]],
    ["Connectors", ["Connectors"]], ["Electromechanical", ["Switches", "Relays"]],
    ["Board features", ["Test points", "Mounting holes", "Fiducials", "Net ties"]]];
  const LEAVES = GROUPS.flatMap(g => g[1]);
  const GROUP_OF = new Map(GROUPS.flatMap(([g, cats]) => cats.map(c => [fold(c), [g, c]])));
  // Older, imported and singular spellings.
  const ALIAS = {resistor: "Resistors", capacitor: "Capacitors", inductor: "Inductors", "ferrite beads": "Inductors", "ferrite bead": "Inductors",
    diode: "Diodes", transistor: "Transistors", led: "Optoelectronics", leds: "Optoelectronics", optocouplers: "Optoelectronics",
    power: "Regulators", "power management": "Regulators", regulator: "Regulators", "op amps": "Amplifiers", "op amp": "Amplifiers", opamp: "Amplifiers",
    mcu: "Microcontrollers", microcontroller: "Microcontrollers", connector: "Connectors", headers: "Connectors", switch: "Switches",
    crystals: "Frequency control", crystal: "Frequency control", oscillators: "Frequency control", fuse: "Protection", fuses: "Protection",
    tvs: "Protection", esd: "Protection", relay: "Relays", sensor: "Sensors", eeprom: "Memory", flash: "Memory",
    test: "Test points", "test point": "Test points", "net tie": "Net ties", nettie: "Net ties", fiducial: "Fiducials", "mounting hole": "Mounting holes"};
  const BY_PREFIX = {R: "Resistors", RN: "Resistors", C: "Capacitors", L: "Inductors", FB: "Inductors", F: "Protection", D: "Diodes", LED: "Optoelectronics",
    Q: "Transistors", U: "Other ICs", IC: "Other ICs", J: "Connectors", P: "Connectors", CN: "Connectors", SW: "Switches", S: "Switches", K: "Relays",
    Y: "Frequency control", X: "Frequency control", TP: "Test points", H: "Mounting holes", MH: "Mounting holes", FID: "Fiducials", NT: "Net ties"};
  const GENERIC = /^(passives|mechanical|misc|miscellaneous|discrete|components?|device|devices|project components|imported|parts?|general|uncategori[sz]ed)$/;
  const prefixCat = def => BY_PREFIX[String(def?.prefix || "").toUpperCase()] || "";
  function category(def) {
    const raw = String(def?.category || "").trim(), f = fold(raw);
    if (GROUP_OF.has(f)) return GROUP_OF.get(f)[1];
    if (Object.hasOwn(ALIAS, f)) return ALIAS[f];
    if (!raw || GENERIC.test(f)) return prefixCat(def) || raw || "Uncategorised";
    return raw;
  }
  const groupOf = cat => GROUP_OF.get(fold(cat))?.[0] || "Other";
  // A category outside the scheme keeps its name and joins the group of its prefix ("Sensors"
  // with prefix U stays "Sensors", under Integrated circuits).
  const groupFor = (def, cat) => GROUP_OF.get(fold(cat))?.[0] || GROUP_OF.get(fold(prefixCat(def)))?.[0] || "Other";

  // ------------------------------------------------------------------ duplicates
  // Built-in parts (parts.js) that a starter part replaces. Ids stay valid; the built-in entry is
  // only hidden while its twin is in the same library.
  const SUPERSEDED = Object.freeze({"std-r": "starter-r-0603", "std-c": "starter-c-0603", "std-j2": "starter-hdr-1x2", "std-j3": "starter-hdr-1x3",
    "std-tp": "starter-tp-1mm", "std-nettie-2": "starter-nettie-2"});
  const REPLACEMENTS = new Set(Object.values(SUPERSEDED));
  const templateId = def => def?.catalogueId || def?.id;
  const hidden = (def, ids) => !!SUPERSEDED[templateId(def)] && ids.has(SUPERSEDED[templateId(def)]);
  const r4 = v => Math.round((+v || 0) * 1e4) / 1e4;
  // One footprint: its name plus its pad geometry, so two different "SOT-23" land patterns both show.
  const fpKey = def => { const f = def.footprint; return fold(f?.name || def.name) + "|" + (f?.pads || []).map(p => [p.number, r4(p.x), r4(p.y), r4(p.w), r4(p.h), r4(p.drill)].join(",")).sort().join(";"); };
  function uniqueFootprints(defs, members) {
    const seen = new Set();
    return defs.filter(d => { if (!d?.footprint) return false; if (members?.has(d.id)) return true; const r = rec(d), k = r.fpk || (r.fpk = fpKey(d)); if (seen.has(k)) return false; seen.add(k); return true; });
  }

  // ------------------------------------------------------------------ facets
  const METRIC = {"1005": "0402", "1608": "0603", "2012": "0805", "3216": "1206", "3225": "1210", "0603": "0201"};
  const param = (def, re) => { const p = def?.parameters; if (!p || typeof p !== "object") return ""; for (const k of Object.keys(p)) if (re.test(k) && typeof p[k] !== "object" && String(p[k]).trim()) return String(p[k]).trim(); return ""; };
  function packageOf(def) {
    const p = param(def, /^(package|case|package \/ case)$/i);
    if (p) return p;
    if (def?.package) return String(def.package);
    const n = String(def?.footprint?.name || "");
    let m = /^(?:RES|CAP|IND|LED|DIO)C(\d{4})X/i.exec(n);
    if (m && METRIC[m[1]]) return METRIC[m[1]];
    m = /(?:^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|2512)(?![0-9])/.exec(n);
    if (m) return m[1];
    m = /\b(SOT-?23(?:-\d)?|SOT-?223|SOD-?\d+|SOIC-?\d+|TSSOP-?\d+|L?QFP-?\d+|QFN-?\d+|DFN-?\d+|TO-?\d+)\b/i.exec(n);
    return m ? m[1].toUpperCase() : n;
  }
  const voltageOf = def => param(def, /^(voltage|rated voltage|v ?rated|voltage rating|vr|vmax)$/i);
  const toleranceOf = def => param(def, /^(tolerance|tol)$/i);
  const padsOf = def => (def?.footprint?.pads || []).filter(p => !p.thermalVia);
  function pinCount(def) {
    const pads = padsOf(def).filter(p => String(p.number ?? "") !== ""), sym = def?.symbol?.pins || [];
    const n = new Set((pads.length ? pads : sym).map(p => String(p.number))).size;
    return n ? String(n) : "";
  }
  function mounting(def) {
    const pads = padsOf(def);
    const th = pads.some(p => p.drill > 0 && p.plated !== false && (p.w > p.drill || p.h > p.drill)), smd = pads.some(p => !(p.drill > 0));
    return th && smd ? "SMD + TH" : th ? "TH" : smd ? "SMD" : "";
  }
  const FACETS = Object.freeze([["value", "Value"], ["tolerance", "Tolerance"], ["voltage", "Voltage"], ["package", "Package"], ["pins", "Pins"], ["mounting", "Mounting"]]);
  const FACET_KEYS = FACETS.map(([key]) => key);
  const facets = def => ({value: String(def?.value || param(def, /^value$/i) || "").trim(), tolerance: toleranceOf(def), voltage: voltageOf(def),
    package: packageOf(def), pins: pinCount(def), mounting: mounting(def)});

  // ------------------------------------------------------------------ index (lazy, per def)
  const recs = new WeakMap();
  let built = 0; // records built so far (tests and the perf probe read it)
  function rec(def) {
    let r = recs.get(def);
    const version = globalThis.AtriumUndoStore?.definitionVersion?.(def);
    const height = +(def.footprint?.height || def.height || 0);
    if (r && version === r.version && r.descr === def.description && r.rawId === def.id && r.n === def.name && r.v === def.value && r.c === def.category && r.fp === def.footprint && r.sy === def.symbol && r.pa === def.parameters && r.pr === def.prefix && r.pkg === def.package && r.num.height === height) return r;
    built++;
    const f = facets(def), cat = category(def), p = def.parameters && typeof def.parameters === "object" ? def.parameters : {};
    const pins = (def.symbol?.pins || []).map(x => x.name).filter(Boolean);
    r = {version, descr: def.description, n: def.name, v: def.value, c: def.category, fp: def.footprint, sy: def.symbol, pa: def.parameters, pr: def.prefix,
      pkg: def.package,
      f, k: {}, cat, group: groupFor(def, cat), name: compact(def.name), fpk: null, prefix: fold(def.prefix), fpName: compact(def.footprint?.name),
      num: {pins: +f.pins || 0, pads: padsOf(def).length, height},
      has: {symbol: !!def.symbol, footprint: !!def.footprint, model: !!(def.model3d || def.footprint?.model3d || def.footprint?.bodies3d?.length), "3d": !!(def.model3d || def.footprint?.model3d || def.footprint?.bodies3d?.length)},
      params: Object.entries(p).filter(([, v]) => typeof v !== "object").map(([k, v]) => [fold(k), compact(v)]),
      hay: compact([def.name, def.category, cat, def.prefix, def.footprint?.name, ...Object.values(f), def.description,
        ...Object.values(p).filter(v => typeof v !== "object"), ...pins].join(" "))};
    for (const k of FACET_KEYS) r.k[k] = compact(f[k]);
    r.categories = [compact(r.cat), compact(r.group), compact(r.c)];
    r.rawId = def.id;
    r.id = fold(def.id);
    recs.set(def, r);
    return r;
  }

  // ------------------------------------------------------------------ query parsing
  const FIELD = {value: "value", val: "value", tol: "tolerance", tolerance: "tolerance", v: "voltage", volt: "voltage", voltage: "voltage",
    pkg: "package", package: "package", footprint: "package", fp: "package", pins: "pins", mount: "mounting", mounting: "mounting",
    cat: "cat", category: "cat", prefix: "prefix", id: "id"};
  const cmp = (a, op, b) => op === ">" ? a > b : op === ">=" ? a >= b : op === "<" ? a < b : op === "<=" ? a <= b : a === b;
  let lastQ = null, lastP = null;
  function parse(q) {
    q = String(q ?? "");
    if (q === lastQ) return lastP;
    const text = [], tests = [], hints = [];
    let column = null;
    for (const raw of q.trim().split(/\s+/).filter(Boolean)) {
      const t = fold(raw);
      let m;
      if ((m = /^(pins|pads|height)([<>]=?|=)(\d+(?:\.\d+)?)$/.exec(t))) {
        const [, key, op, n] = m, value = +n;
        tests.push(r => cmp(r.num[key], op, value)); column = {key, op, value}; continue;
      }
      if ((m = /^has:(symbol|footprint|model|3d)$/.exec(t))) {
        const k = m[1]; tests.push(r => r.has[k]); column = {key: k === "3d" ? "model" : k, op: "=", value: 1}; continue;
      }
      if ((m = /^([a-z#][a-z# ]*):(.+)$/.exec(t))) {
        const key = m[1], needle = compact(m[2]), field = Object.hasOwn(FIELD, key) ? FIELD[key] : undefined;
        if (field === "pins") tests.push(r => r.k.pins === needle);
        else if (field === "package") { hints.push([field, needle]); tests.push(r => r.k.package.includes(needle) || r.fpName.includes(needle)); }
        else if (field === "cat") { hints.push([field, needle]); tests.push(r => r.categories.some(c => c.includes(needle))); }
        else if (field === "prefix") tests.push(r => r.prefix.includes(needle));
        else if (field === "id") tests.push(r => r.id.includes(needle));
        else if (field) tests.push(r => r.k[field].includes(needle));
        else { const whole = compact(raw); tests.push(r => r.params.some(([k, v]) => k === key && v.includes(needle)) || r.hay.includes(whole)); }
        continue;
      }
      text.push(compact(raw));
    }
    lastQ = q; lastP = {text, tests, hints, column};
    return lastP;
  }
  const familyLabel = member => compact(member.name + " " + member.part);
  function matchesText(terms, record, member) {
    let familyText;
    for (const term of terms) {
      if (record.hay.includes(term)) continue;
      if (!member) return false;
      familyText ??= typeof member === "string" ? member : familyLabel(member);
      if (!familyText.includes(term)) return false;
    }
    return true;
  }
  function matchesFields(tests, record) {
    for (const test of tests) if (!test(record)) return false;
    return true;
  }
  const matches = (def, query) => {
    const p = parse(query), record = rec(def);
    return matchesText(p.text, record) && matchesFields(p.tests, record);
  };
  // 0: the name starts with the first word, 1: the name holds every word, 2: anything else.
  function rank(p, r) {
    if (!p.text.length) return 2;
    if (r.name.startsWith(p.text[0])) return 0;
    for (const term of p.text) if (!r.name.includes(term)) return 2;
    return 1;
  }

  // ------------------------------------------------------------------ query
  // state: {facet: Map(key -> label)}; counts: {facet: Map(key -> {label, n})}. Each facet's counts
  // apply every other facet's selection, so the choices in a facet stay visible once one is picked.
  function query(defs, q, o = {}) {
    const ids = o.ids || new Set(defs.map(d => d?.id)), state = o.state || {}, p = parse(q);
    const base = []; let hiddenN = 0;
    for (const d of defs) {
      if (!d || d.mirrorOf) continue;
      const member = o.members?.get(d.id);
      if (!o.all && !member && hidden(d, ids) && !o.keep?.(d)) { hiddenN++; continue; }
      const record = rec(d);
      if (matchesText(p.text, record, member) && matchesFields(p.tests, record)) base.push(d);
    }
    const list = o.footprints ? uniqueFootprints(base, o.members) : base;
    const active = FACETS.filter(([k]) => state[k]?.size).map(([k]) => k), counts = {};
    for (const [k] of FACETS) counts[k] = new Map();
    const items = [];
    for (const d of list) {
      const r = rec(d); let fails = 0, failed = "";
      for (const k of active) if (!state[k].has(r.k[k])) { failed = k; if (++fails > 1) break; }
      if (fails > 1) continue;
      if (!fails) items.push(d);
      for (const [k] of FACETS) {
        if (fails && failed !== k) continue;
        const key = r.k[k]; if (!key) continue;
        const c = counts[k].get(key); if (c) c.n++; else counts[k].set(key, {label: r.f[k], n: 1});
      }
    }
    for (const k of active) for (const [key, label] of state[k]) if (!counts[k].has(key)) counts[k].set(key, {label, n: 0});
    if (o.sort !== false) {
      const rk = new Map(items.map(d => [d, rank(p, rec(d))]));
      items.sort((a, b) => rk.get(a) - rk.get(b) || natural(a.name, b.name));
    }
    return {items, counts, hidden: hiddenN, total: list.length, active: active.length};
  }
  // Folder snapshots are prebuilt in the indexing worker. Positions below are in natural
  // name order, so ranking a broad search only needs three buckets. Posting lists include
  // one- and two-character grams to keep short searches exact without scanning every row.
  const FAST_ROWS = 400; // The Library panel displays at most this many rows, with the full match count.
  function addGrams(grams, text, row) {
    for (let start = 0; start < text.length; start++) {
      const end = Math.min(start + 3, text.length);
      for (let j = start + 1; j <= end; j++) {
        const gram = text.slice(start, j);
        let posting = grams.get(gram);
        if (!posting) grams.set(gram, posting = []);
        if (posting[posting.length - 1] !== row) posting.push(row);
      }
    }
  }
  function addPosition(positions, id, i) {
    const position = positions.get(id);
    if (position === undefined) positions.set(id, i);
    else if (Array.isArray(position)) position.push(i);
    else positions.set(id, [position, i]);
  }
  function prepare(defs, members) {
    if (!members?.size) members = undefined;
    const order = Uint32Array.from(defs.map((_, i) => i).sort((a, b) => natural(defs[a].name, defs[b].name)));
    const grams = new Map(), fieldGrams = {cat: new Map(), package: new Map()};
    const rows = [], columns = new Uint32Array(defs.length * FACET_KEYS.length);
    const replacements = new Map(), superseded = [];
    let mirrors = false;
    const inverse = new Uint32Array(defs.length);
    const keys = FACET_KEYS.map(() => new Map());
    const numeric = Object.fromEntries(["pins", "pads", "height", "symbol", "footprint", "model"].map(key => [key, new Float64Array(defs.length)]));
    for (const at of order) {
      const d = defs[at], r = rec(d), i = rows.length;
      const {id, rawId, name, prefix, fpName, num, has, params, hay, k, f, categories} = r;
      const search = {id, rawId, name, prefix, fpName, num, has, params, hay, k, f, categories};
      rows.push(search); inverse[at] = i;
      if (REPLACEMENTS.has(d.id)) addPosition(replacements, d.id, i);
      if (Object.hasOwn(SUPERSEDED, templateId(d))) superseded.push(i);
      if (d.mirrorOf) mirrors = true;
      numeric.pins[i] = r.num.pins; numeric.pads[i] = r.num.pads; numeric.height[i] = r.num.height;
      numeric.symbol[i] = Number(r.has.symbol); numeric.footprint[i] = Number(r.has.footprint); numeric.model[i] = Number(r.has.model);
      for (let f = 0; f < FACET_KEYS.length; f++) {
        const value = r.k[FACET_KEYS[f]], values = keys[f];
        if (!value) continue;
        if (!values.has(value)) values.set(value, values.size + 1);
        columns[at * FACET_KEYS.length + f] = values.get(value);
      }
      addGrams(grams, r.hay, i);
      const member = members?.get(d.id);
      if (member) {
        search.familyText = familyLabel(member);
        addGrams(grams, search.familyText, i);
      }
      for (const category of new Set(r.categories)) addGrams(fieldGrams.cat, category, i);
      addGrams(fieldGrams.package, r.k.package, i);
      if (r.fpName !== r.k.package) addGrams(fieldGrams.package, r.fpName, i);
    }
    const indexes = [grams, ...Object.values(fieldGrams)];
    let length = 0;
    for (const map of indexes) for (const list of map.values()) length += list.length;
    const postings = new Uint32Array(length), short = new Map();
    let offset = 0;
    for (const map of indexes) for (const [gram, list] of map) {
      postings.set(list, offset); map.set(gram, [offset, list.length]); offset += list.length;
      // A one-character query can match nearly all 36k rows. Keep the first screen in the same
      // name-prefix, name-substring and other order so returning it costs only the visible rows.
      if (map === grams && gram.length === 1 && list.length > FAST_ROWS) {
        const hits = [[], [], []];
        for (const i of list) {
          const name = rows[i].name, hit = hits[name.startsWith(gram) ? 0 : name.includes(gram) ? 1 : 2];
          if (hit.length < FAST_ROWS) hit.push(order[i]);
        }
        short.set(gram, {count: list.length, items: hits[0].concat(hits[1], hits[2]).slice(0, FAST_ROWS)});
      }
    }
    return {order, inverse, rows, grams, fieldGrams, postings, replacements, superseded, columns, keys, short, numeric, mirrors, ...(members ? {members} : {})};
  }
  function intersectShortTerms(terms, {grams, postings}) {
    const lists = [];
    for (const term of new Set(terms)) {
      if (!term.length) continue;
      const range = grams.get(term);
      if (!range) return [];
      lists.push(postings.subarray(range[0], range[0] + range[1]));
    }
    lists.sort((a, b) => a.length - b.length);
    const seed = lists[0];
    if (lists.length < 2) return seed ?? null;
    const hits = new Uint32Array(seed.length), cursors = new Uint32Array(lists.length);
    let size = 0;
    for (const row of seed) {
      let i = 1;
      for (; i < lists.length; i++) {
        const list = lists[i];
        let pos = cursors[i];
        while (pos < list.length && list[pos] < row) pos++;
        if (pos === list.length) return hits.subarray(0, size);
        cursors[i] = pos;
        if (list[pos] !== row) break;
      }
      if (i === lists.length) hits[size++] = row;
    }
    return hits.subarray(0, size);
  }
  function searchCandidates(p, {grams, fieldGrams, postings}) {
    let best = null;
    function consider(term, map) {
      if (!term.length) return true;
      const width = Math.min(term.length, 3);
      for (let i = width; i <= term.length; i++) {
        const rows = map.get(term.slice(i - width, i));
        if (!rows) return false;
        if (!best || rows[1] < best[1]) best = rows;
      }
      return true;
    }
    for (const term of p.text) if (!consider(term, grams)) return [];
    for (const [field, term] of p.hints) if (!consider(term, fieldGrams[field])) return [];
    return best ? postings.subarray(best[0], best[0] + best[1]) : null;
  }
  const NO_ORDINALS = Object.freeze([]);
  const ordinals = position => position === undefined ? NO_ORDINALS : Array.isArray(position) ? position : [position];
  const explicitPositions = new WeakMap();
  function extraFamilyMatches(terms, index, members) {
    if (!terms.length || !members?.size) return NO_ORDINALS;
    const {rows} = index;
    // Prepared folder memberships already have postings. Only a caller supplying a
    // different membership map needs a lookup for arbitrary definition IDs.
    let positions = explicitPositions.get(index);
    if (!positions) {
      positions = new Map();
      for (let i = 0; i < rows.length; i++) addPosition(positions, rows[i].rawId, i);
      explicitPositions.set(index, positions);
    }
    const extra = [];
    for (const [id, member] of members) {
      for (const i of ordinals(positions.get(id))) {
        if (!matchesText(terms, rows[i]) && matchesText(terms, rows[i], member)) extra.push(i);
      }
    }
    return extra.sort((a, b) => a - b);
  }
  function queryPrepared(defs, index, q, o = {}) {
    const members = Object.hasOwn(o, "members") ? o.members : index.members;
    // Footprint collapsing and unsorted results use file order.
    if (o.footprints || o.sort === false) {
      const res = query(o.accept ? defs.filter(o.accept) : defs, q, {...o, members});
      const matching = res.items.length;
      return {...res, items: res.items.slice(0, o.limit ?? Infinity), matching};
    }
    const p = parse(q), state = o.state || {}, active = FACET_KEYS.filter(key => state[key]?.size);
    const {order, inverse, rows, columns, keys} = index;
    const limit = o.limit ?? Infinity, buckets = [[], [], []], counts = {}, accept = o.accept;
    const sameMembers = members === index.members;
    const overriddenMembers = !sameMembers && !!index.members?.size;
    const exactText = !overriddenMembers && !p.hints.length && p.text.every(term => term.length <= 3);
    const updates = o.updates;
    const skipped = new Set();
    if (!o.all) for (const i of index.superseded) {
      const d = defs[order[i]], replacement = SUPERSEDED[templateId(d)];
      if (d.mirrorOf || members?.get(d.id) || accept && !accept(d)) continue;
      const present = o.ids ? o.ids.has(replacement) :
        index.replacements.has(replacement) && (!accept || ordinals(index.replacements.get(replacement)).some(at => accept(defs[order[at]])));
      if (present && !o.keep?.(d)) skipped.add(i);
    }
    const count = o.counts !== false;
    const familyMatches = sameMembers ? NO_ORDINALS : extraFamilyMatches(p.text, index, members);
    if (!count && !accept && !active.length && !index.mirrors && !skipped.size && !updates?.size && limit <= FAST_ROWS) {
      if (!p.tests.length) {
        const first = !overriddenMembers && p.text.length === 1 ? index.short.get(p.text[0]) : null;
        if (first || !p.text.length) {
          let visible = first?.items ?? order;
          const matching = (first?.count ?? order.length) + familyMatches.length;
          if (familyMatches.length) visible = [...visible, ...familyMatches.map(i => order[i])].sort((a, b) => {
            const left = inverse[a], right = inverse[b];
            return rank(p, rows[left]) - rank(p, rows[right]) || left - right;
          });
          const items = Array.from(visible.slice(0, limit), i => defs[i]);
          return {items, counts, hidden: 0, total: matching, active: 0, matching};
        }
      } else if (!p.text.length && p.tests.length === 1 && p.column) {
        const {key, op, value} = p.column, column = index.numeric[key], items = [];
        let matching = 0;
        for (let i = 0; i < column.length; i++) if (cmp(column[i], op, value)) {
          matching++;
          if (items.length < limit) items.push(defs[order[i]]);
        }
        return {items, counts, hidden: 0, total: matching, active: 0, matching};
      }
    }
    const candidates = exactText && p.text.length > 1 ? intersectShortTerms(p.text, index) : searchCandidates(p, index);
    const width = FACET_KEYS.length, changes = new Map();
    const tally = count ? keys.map(values => {
      const size = values.size + 1 + (updates?.size || 0);
      return {hits: new Uint32Array(size), first: new Uint32Array(size).fill(0xffffffff), extra: new Map()};
    }) : null;
    let total = 0, matching = 0;
    function add(i, changed, familyMatch = false) {
      const at = order[i], indexed = rows[i];
      const d = changed || index.mirrors || accept ? defs[at] : null;
      if (d?.mirrorOf || skipped.size && skipped.has(i) || accept && !accept(d)) return;
      const r = changed ? rec(d) : indexed;
      if ((changed || !exactText) && !familyMatch) {
        const member = sameMembers ? indexed.familyText : members?.get(r.rawId);
        if (!matchesText(p.text, r, member)) return;
      }
      if (!matchesFields(p.tests, r)) return;
      total++;
      let failed = "";
      for (const k of active) if (!state[k].has(r.k[k])) { if (failed) return; failed = k; }
      if (!failed) {
        matching++;
        const bucket = buckets[rank(p, r)];
        if (bucket.length < limit) bucket.push(at);
      }
      if (!count) return;
      const offset = at * width;
      let adjusted;
      if (changed) { adjusted = new Uint32Array(width); changes.set(at, adjusted); }
      for (let f = 0; f < width; f++) {
        const key = FACET_KEYS[f];
        if (failed && failed !== key) continue;
        const col = tally[f];
        let value = columns[offset + f];
        if (changed) {
          const text = r.k[key], dictionary = keys[f];
          if (!text) continue;
          value = dictionary.get(text) || col.extra.get(text);
          if (!value) { value = dictionary.size + col.extra.size + 1; col.extra.set(text, value); }
          adjusted[f] = value;
        }
        if (value) { col.hits[value]++; if (at < col.first[value]) col.first[value] = at; }
      }
    }
    const n = candidates?.length ?? order.length;
    if (!updates?.size && !familyMatches.length) {
      if (candidates) for (const i of candidates) add(i, false);
      else for (let i = 0; i < n; i++) add(i, false);
    } else {
      // A changed row or a family-only match can lie outside the base postings.
      const extra = updates?.size ? [...new Set([...familyMatches, ...updates])].sort((a, b) => a - b) : familyMatches;
      const addExtra = i => {
        const changed = !!updates?.has(i);
        add(i, changed, !changed);
      };
      let cursor = 0;
      for (let j = 0; j < n; j++) {
        const i = candidates ? candidates[j] : j;
        while (cursor < extra.length && extra[cursor] < i) addExtra(extra[cursor++]);
        if (i === extra[cursor]) { addExtra(i); cursor++; }
        else add(i, false);
      }
      while (cursor < extra.length) addExtra(extra[cursor++]);
    }
    if (count) {
      for (const k of FACET_KEYS) counts[k] = new Map();
      // Enumerate facet labels in source order, matching the plain query's first matching label.
      if (total) for (let at = 0; at < defs.length; at++) {
        const offset = at * width, adjusted = changes.size ? changes.get(at) : null;
        for (let f = 0; f < width; f++) {
          const value = adjusted ? adjusted[f] : columns[offset + f], col = tally[f];
          if (value && col.first[value] === at) {
            const key = FACET_KEYS[f], r = adjusted ? rec(defs[at]) : rows[inverse[at]];
            counts[key].set(r.k[key], {label: r.f[key], n: col.hits[value]});
          }
        }
      }
      for (const k of active) for (const [key, label] of state[k]) if (!counts[k].has(key)) counts[k].set(key, {label, n: 0});
    }
    const items = buckets[0].concat(buckets[1], buckets[2]).slice(0, limit).map(at => defs[at]);
    return {items, counts, hidden: skipped.size, total, active: active.length, matching};
  }
  // v1: search + duplicates (+ a facet box before o.host).
  function pick(defs, q, o = {}) {
    if (!o.host) return query(defs, q, {...o, sort: false}).items;
    const key = o.key || "list", st = stateOf(key), res = query(defs, q, {...o, state: st.facets, sort: false});
    let box = st.box;
    if (!box?.isConnected) { box = st.box = el("div", null, "cat-facet-box"); o.host.before(box); }
    facetsUI(box, key, res.counts, o.onChange || (() => {}), {compact: true});
    return res.items;
  }

  // ------------------------------------------------------------------ find / get (MCP, scripts)
  function pool(o = {}) {
    if (o.defs) return o.defs;
    const out = [...(o.project?.library || [])], have = new Set(out.flatMap(d => [d.id, templateId(d)]));
    let starter;
    try { starter = globalThis.AtriumStarterLibrary?.templates(); } catch { /* not loaded */ }
    for (const d of [...(starter || []), ...(globalThis.AtriumParts?.catalogue || [])]) if (!have.has(d.id)) { have.add(d.id); out.push(d); }
    return out;
  }
  function summary(d) {
    const r = rec(d);
    return {id: d.id, name: d.name, category: r.cat, group: r.group, prefix: d.prefix || "", ...r.f, footprint: d.footprint?.name || "",
      symbol: !!d.symbol, source: (typeof d.source === "string" ? d.source : d.source?.kind) || (/^std-/.test(templateId(d)) ? "atrium-builtin" : "project"), description: d.description || "",
      ...(SUPERSEDED[templateId(d)] ? {supersededBy: SUPERSEDED[templateId(d)]} : {})};
  }
  // find("10k 0603"), find("starter-r-0603"), find("cat:diode mount:smd"). Ids are stable; an exact id
  // (hidden duplicates included) comes back alone.
  function find(q, o = {}) {
    const defs = pool(o), id = String(q ?? "").trim(), exact = defs.find(d => d.id === id);
    if (exact) return [summary(exact)];
    const members = o.project ? globalThis.AtriumComponentFamilies?.memberships(o.project) : null;
    return query(defs, q, {all: !!o.all, members}).items.slice(0, Math.max(1, o.limit ?? 25)).map(summary);
  }
  const get = (id, o = {}) => pool(o).find(d => d.id === id || d.catalogueId === id) || null;

  // ------------------------------------------------------------------ UI
  const hasDOM = () => !!globalThis.document?.createElement;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  // "Clear" and "Show more" are small quiet library buttons in the accent ink.
  const quietButton = (text, cls) => { const b = el("button", text, "ui-button " + cls); b.type = "button"; b.dataset.variant = "quiet"; b.dataset.size = "sm"; return b; };
  function rowIcons(def, target) {
    const icons = el("span", null, "cat-row-icons");
    icons.setAttribute("aria-hidden", "true");
    for (const kind of target ? [target] : ["schematic", "pcb"]) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      const use = document.createElementNS(svg.namespaceURI, "use");
      const present = kind === "pcb" ? def.footprint : def.symbol;
      svg.setAttribute("class", present ? "icon" : "icon empty");
      use.setAttribute("href", kind === "pcb" ? "#i-chip" : "#i-schematic");
      svg.append(use); icons.append(svg);
    }
    return icons;
  }
  const states = new Map(), closed = new Set();
  function stateOf(key) {
    let s = states.get(key);
    if (!s) { s = {facets: {}, folded: new Set(["tolerance", "voltage", "@all"]), more: new Set(), selected: null}; states.set(key, s); }
    return s;
  }
  const clearFacets = key => { const s = stateOf(key); for (const k in s.facets) s.facets[k].clear(); };
  // Facet groups with checkable values and counts. Values within a facet are OR'd; facets are AND'd.
  function facetsUI(host, key, counts, onChange, o = {}) {
    const st = stateOf(key), focus = document.activeElement?.closest?.(".cat-facets") === host ? document.activeElement.dataset.ref : null;
    host.replaceChildren(); host.classList.add("cat-facets"); host.setAttribute("role", "group"); host.setAttribute("aria-label", "Filter by parameter");
    const nActive = Object.values(st.facets).reduce((n, m) => n + m.size, 0);
    const head = el("div", null, "cat-facets-head");
    head.append(el("span", o.title || "Filter"));
    if (o.total != null) head.append(el("small", o.total + (o.total === 1 ? " part" : " parts")));
    const clear = el("button", "Clear"); clear.type = "button"; clear.className = "ui-button cat-clear"; clear.dataset.variant = "quiet"; clear.dataset.size = "sm"; clear.hidden = !nActive; clear.title = "Clear every parameter filter";
    clear.dataset.ref = "clear"; clear.onclick = () => { clearFacets(key); onChange(); };
    head.append(clear);
    let body = host;
    if (o.compact) {
      // Library panel: one collapsible "Filter" row so the list keeps its height.
      const d = el("details", null, "cat-filter"); d.open = !st.folded.has("@all");
      d.addEventListener("toggle", () => {
        const wasClosed = st.folded.has("@all");
        if (d.open) st.folded.delete("@all"); else st.folded.add("@all");
        if (d.open && wasClosed && o.deferCounts) onChange();
      });
      const s = el("summary"); s.append(head); d.append(s); host.append(d);
      if (o.deferCounts && !d.open) return nActive;
      body = el("div", null, "cat-filter-body"); d.append(body);
    } else host.append(head);
    let shown = 0;
    for (const [k, label] of FACETS) {
      const m = counts[k]; if (!m?.size) continue;
      shown++;
      const sel = st.facets[k] || (st.facets[k] = new Map());
      const g = el("details", null, "cat-facet"); g.open = sel.size > 0 || !st.folded.has(k); g.dataset.facet = k;
      g.addEventListener("toggle", () => { if (g.open) st.folded.delete(k); else st.folded.add(k); });
      const s = el("summary"); s.append(el("span", label)); if (sel.size) { const n = el("small", String(sel.size), "ui-count cat-badge"); n.dataset.tone = "accent"; s.append(n); } g.append(s);
      // Pins in numeric order; Value and Package by how many parts share them (the short list shows the common
      // ones); the rest in natural order.
      const values = [...m].sort((a, b) => (k === "pins" ? (+a[1].label) - (+b[1].label) : k === "value" || k === "package" ? b[1].n - a[1].n : 0) || natural(a[1].label, b[1].label));
      const cap = st.more.has(k) ? Infinity : 8;
      const opts = el("div", null, "cat-opts");
      values.forEach(([v, c], i) => {
        if (i >= cap && !sel.has(v)) return;
        const row = el("label", null, "cat-opt" + (c.n ? "" : " zero")), box = el("input"); box.type = "checkbox"; box.checked = sel.has(v);
        box.dataset.ref = k + "|" + v; box.setAttribute("aria-label", label + " " + c.label + ", " + c.n + (c.n === 1 ? " part" : " parts"));
        box.onchange = () => { if (box.checked) sel.set(v, c.label); else sel.delete(v); onChange(); };
        const name = el("span", c.label); name.title = c.label;
        row.append(box, name, el("small", String(c.n))); opts.append(row);
      });
      if (values.length > cap) { const more = quietButton("Show all " + values.length, "cat-more"); more.dataset.ref = "more|" + k; more.onclick = () => { st.more.add(k); onChange(); }; opts.append(more); }
      g.append(opts); body.append(g);
    }
    if (!shown) body.append(el("p", "No parameters to filter by.", "cat-none"));
    if (focus) [...host.querySelectorAll("[data-ref]")].find(n => n.dataset.ref === focus)?.focus();
    return nActive;
  }
  // Rows grouped as group › category, each a <details>. Rows of a closed node are built when it
  // first opens; large categories show `cap` rows and a "Show more" button. o.open forces every
  // node open (while searching or filtering). Collapsed nodes are remembered per key.
  function tree(list, defs, row, o = {}) {
    // A broad result (thousands of parts) builds a few rows per category; "Show more" adds the rest.
    const key = o.key || "list", cap = o.cap || (defs.length > 400 ? 24 : 150), byGroup = new Map();
    for (const d of defs) {
      const r = rec(d);
      if (!byGroup.has(r.group)) byGroup.set(r.group, new Map());
      const m = byGroup.get(r.group); if (!m.has(r.cat)) m.set(r.cat, []); m.get(r.cat).push(d);
    }
    const order = [...GROUPS.map(x => x[0]), "Other"], rankCat = c => { const i = LEAVES.indexOf(c); return i < 0 ? 1e3 : i; };
    const node = (name, count, id, cls) => {
      const d = el("details", null, "cat-node " + cls); d.open = !!o.open || !closed.has(key + "|" + id); d.dataset.category = name;
      const s = el("summary", null, "ui-chrome-action ui-chrome-action-compact"); s.append(el("span", name), el("small", String(count))); d.append(s);
      d.addEventListener("toggle", () => { if (o.open) return; if (d.open) closed.delete(key + "|" + id); else closed.add(key + "|" + id); });
      return d;
    };
    const fill = (host, items) => {
      const rows = el("div", null, "cat-rows"); host.append(rows);
      const add = (from, n) => {
        for (const d of items.slice(from, from + n)) rows.append(row(d));
        if (items.length > from + n) { const rest = items.length - from - n, b = quietButton("Show " + Math.min(150, rest) + " more" + (rest > 150 ? " of " + rest : ""), "cat-more");
          b.onclick = e => { e.stopPropagation(); b.remove(); add(from + n, 150); }; rows.append(b); }
      };
      if (host.open) add(0, cap); else host.addEventListener("toggle", () => add(0, cap), {once: true});
    };
    for (const g of [...byGroup.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
      const cats = [...byGroup.get(g)].sort((a, b) => rankCat(a[0]) - rankCat(b[0]) || natural(a[0], b[0])), total = cats.reduce((n, c) => n + c[1].length, 0);
      const gn = node(g, total, g, "cat-group");
      list.append(gn);
      if (cats.length === 1 && cats[0][0] === g) { fill(gn, cats[0][1]); continue; }
      for (const [c, items] of cats) { const cn = node(c, items.length, g + "/" + c, "cat-cat"); gn.append(cn); fill(cn, items); }
    }
  }
  // A family and its chips are disclosures. Only the package rows operate on a definition.
  const familyDisclosures = new WeakMap();
  function componentTree(list, defs, row, o = {}) {
    const members = o.members;
    if (!members?.size) { tree(list, defs, row, o); return; }
    const scope = o.scope || o.owner || list;
    let openFamilies = familyDisclosures.get(scope);
    if (!openFamilies) { openFamilies = new Set(); familyDisclosures.set(scope, openFamilies); }
    const grouped = [], ordinary = [];
    for (const d of defs) (members.has(d.id) ? grouped : ordinary).push(d);
    const families = AtriumComponentFamilies.browse(o.owner, grouped);
    function branch(host, name, count, key, type, reveal, fill) {
      const node = el("details", null, "cat-node " + type);
      const summary = el("summary", null, "ui-chrome-action ui-chrome-action-compact"); summary.append(el("span", name), el("small", count));
      if (type === "cat-family") summary.dataset.fill = "soft";
      summary.onfocus = summary.onclick = o.onGroup || null;
      node.append(summary); host.append(node);
      const id = JSON.stringify([o.key, o.source, key]);
      node.open = !!(o.open || reveal || openFamilies.has(id));
      let built = false;
      function add() { if (node.open && !built) { built = true; fill(node); } }
      node.addEventListener("toggle", () => {
        if (!o.open && !reveal) { if (node.open) openFamilies.add(id); else openFamilies.delete(id); }
        add();
      });
      add();
    }
    for (const family of families) {
      const partCount = family.parts.length;
      const reveals = part => part.options.some(v => v.id === o.reveal);
      branch(list, family.name, partCount + (partCount === 1 ? " chip" : " chips"), family.id, "cat-family", family.parts.some(reveals), node => {
        for (const part of family.parts) {
          const n = part.options.length;
          branch(node, part.name, n + (n === 1 ? " package" : " packages"), [family.id, part.name], "cat-family-chip", reveals(part), chip => {
            const labels = new Map();
            for (const v of part.options) labels.set(v.packageName, (labels.get(v.packageName) || 0) + 1);
            const rows = el("div", null, "cat-family-packages");
            for (const v of part.options) {
              const label = v.packageName || (v.def.symbol ? "Symbol only" : "Footprint");
              const exactName = v.def.name === part.name ? "" : v.def.name;
              const description = labels.get(v.packageName) > 1 ? [exactName, sourced(v.def), v.id].filter(Boolean).join(" · ") : exactName;
              rows.append(row(v.def, {label, description, context: family.name + ", " + part.name}));
            }
            chip.append(rows);
          });
        }
      });
    }
    tree(list, ordinary, row, o);
  }
  // Summaries of closed branches are focusable. Their contents are not.
  const visibleRows = list => [...list.querySelectorAll(".library-row, .lib-row, .cat-more, .cat-family > summary, .cat-family-chip > summary")].filter(node =>
    !(node.matches("summary") ? node.parentElement.parentElement : node.parentElement).closest("details:not([open])"));
  // The second line of a row in Place › Component.
  function subtitle(def, target) {
    const f = rec(def).f;
    if (target === "pcb") return def.footprint?.name || "Footprint";
    const pkg = f.value && f.package.startsWith(f.value) ? "" : f.package; // "1×2" and "1×2 2.54 mm": once
    return [f.package.startsWith(f.value) && f.value ? f.package : f.value, pkg].filter(Boolean).join(" · ") || def.category || "Symbol";
  }
  // Both canvases read their laid-out sizes. A newer selection or a closed
  // surface can discard the entire pending frame before either drawing starts.
  const previewFrames = new WeakMap();
  function cancelPreview(host) {
    const frame = previewFrames.get(host);
    if (frame === undefined) return false;
    cancelAnimationFrame(frame); previewFrames.delete(host);
    return true;
  }
  const sourced = def => param(def, /^(lcsc ?#?|lcsc part|mpn|manufacturer part number|supplier part number|jlc ?#?)$/i);
  // Symbol and footprint side by side (live renders through AtriumCanvas.preview), then the
  // parameters. o.params === false shows the pictures only (the Library panel has its own list).
  function preview(host, def, o = {}) {
    cancelPreview(host);
    const box = el("div", null, "cat-pv"); box.dataset.def = def?.id || "";
    if (!def) { box.append(el("p", o.choosePackage ? "Choose a package." : "Choose a component to preview.", "cat-none")); host.append(box); return box; }
    const r = rec(def);
    if (o.title !== false) {
      const t = el("div", null, "cat-pv-title");
      const location = o.member ? o.member.name + " › " + o.member.part : r.group === r.cat ? r.cat : r.group + " › " + r.cat;
      t.append(el("strong", def.name), el("small", location));
      if (o.onPlace) {
        const head = el("div", null, "cat-pv-head"), place = el("button", "Place", "cat-place ui-button"); place.dataset.variant = "primary";
        place.type = "button"; place.onclick = () => o.onPlace(def);
        globalThis.AtriumNavCommon?.shortcutTitle(place, "Place " + def.name, "Enter", " from the selected row");
        head.append(t, place); box.append(head);
      } else box.append(t);
    }
    const pics = el("div", null, "cat-pv-pics"), drawings = [];
    for (const [kind, label] of [["schematic", "Symbol"], ["pcb", "Footprint"]]) {
      const fig = el("figure"), c = el("canvas"), g = kind === "pcb" ? def.footprint : def.symbol;
      c.dataset.kind = kind;
      fig.append(c, el("figcaption", g ? (kind === "pcb" ? def.footprint.name || label : label + (def.symbol.parts > 1 ? " · " + def.symbol.parts + " gates" : "")) : "No " + label.toLowerCase()));
      if (g) {
        c.setAttribute("role", "img"); c.setAttribute("aria-label", label + " of " + def.name); drawings.push([c, kind]);
      } else {
        c.setAttribute("aria-hidden", "true"); fig.classList.add("empty");
      }
      pics.append(fig);
    }
    box.append(pics);
    const pins = def.symbol?.pins;
    if (o.pins && pins?.length) {
      const disclosure = el("details", null, "cat-pv-pins"), gated = def.symbol.parts > 1;
      disclosure.append(el("summary", "Pins (" + pins.length + ")"));
      disclosure.addEventListener("toggle", () => {
        if (!disclosure.open || disclosure.children.length > 1) return;
        const table = el("table"), head = table.createTHead().insertRow(), body = table.createTBody();
        table.setAttribute("aria-label", "Symbol pins");
        for (const column of gated ? ["Number", "Name", "Gate"] : ["Number", "Name"]) {
          const header = el("th", column); header.scope = "col"; head.append(header);
        }
        for (const pin of pins) {
          const row = body.insertRow();
          row.insertCell().textContent = pin.number ?? "—";
          row.insertCell().textContent = pin.name || "—";
          if (gated) row.insertCell().textContent = pin.part > 0 ? pin.part : "All";
        }
        disclosure.append(table);
      });
      box.append(disclosure);
    }
    if (o.params !== false) {
      const dl = el("dl", null, "cat-pv-params"), add = (k, v) => { if (v !== "" && v != null) dl.append(el("dt", k), el("dd", String(v))); };
      const f = r.f, seen = new Set(["value", "tolerance", "voltage", "package", "case", "lcsc #"]);
      add("Value", f.value); add("Package", f.package); add("Mounting", f.mounting); add("Pins", f.pins); add("Tolerance", f.tolerance); add("Voltage", f.voltage);
      for (const [k, v] of Object.entries(def.parameters || {})) if (!seen.has(fold(k)) && typeof v !== "object" && String(v).trim()) add(k, v);
      const id = el("dd", def.id, "cat-id"); dl.append(el("dt", "Library id"), id);
      box.append(dl);
      const s = sourced(def);
      box.append(el("p", s ? "Supplier part: " + s : "Generic part: needs sourcing before ordering (BOM › Optimise › Suppliers).", "cat-pv-source" + (s ? "" : " warn")));
      if (def.description) box.append(el("p", def.description, "cat-pv-desc"));
    }
    host.append(box);
    if (drawings.length) previewFrames.set(host, requestAnimationFrame(() => {
      previewFrames.delete(host);
      if (!box.isConnected || document.visibilityState === "hidden" || globalThis.AtriumPower?.visible?.() === false ||
          box.closest("[hidden], .dock-inactive, dialog:not([open])") || box.checkVisibility?.() === false) return;
      for (const [canvas, kind] of drawings) try { (o.draw || globalThis.AtriumCanvas?.preview)?.(canvas, def, kind); } catch {}
    }));
    return box;
  }
  // Place › Component: facets | category tree | preview, around the dialog's #library-list.
  function shell(list, key) {
    let sh = list.parentElement;
    if (!sh?.classList.contains("cat-shell")) {
      sh = el("div", null, "cat-shell"); list.before(sh);
      const facetsCol = el("aside", null, "cat-col cat-facet-col"), pv = el("aside", null, "cat-col cat-preview");
      pv.setAttribute("aria-live", "polite"); pv.setAttribute("aria-label", "Component preview");
      sh.append(facetsCol, list, pv);
      const dialog = list.closest("dialog"), search = dialog?.querySelector("#library-search");
      dialog?.classList.add("cat-wide");
      const close = dialog?.querySelector('[data-action="close-dialog"]');
      if (close) globalThis.AtriumNavCommon?.shortcutTitle(close, "Close library", "Escape");
      const closed = () => { cancelPreview(pv); stateOf(key).selected = null; stateOf(key).owner = null; };
      dialog?.addEventListener("beforetoggle", e => { if (e.newState === "closed") closed(); });
      dialog?.addEventListener("cancel", () => cancelPreview(pv));
      dialog?.addEventListener("close", () => { if (!dialog.open) closed(); });
      dialog?.addEventListener("keydown", e => {
        const tab = e.key === "Tab" && !e.metaKey && !e.ctrlKey && !e.altKey;
        if (tab && e.shiftKey && e.target.matches(".cat-place")) {
          const id = e.target.closest(".cat-pv").dataset.def;
          const row = visibleRows(list).find(node => node.dataset.def === id);
          if (row) { e.preventDefault(); row.focus(); }
          return;
        }
        const fromSearch = e.target === search;
        if (!fromSearch && !list.contains(e.target)) return;
        if (tab && !e.shiftKey && e.target.matches(".library-row")) {
          const place = pv.querySelector(".cat-place");
          if (place && place.closest(".cat-pv").dataset.def === e.target.dataset.def) {
            e.preventDefault(); place.focus(); return;
          }
        }
        if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && !(fromSearch && e.key === "Enter")) return;
        const rows = visibleRows(list), first = rows[0], index = rows.indexOf(document.activeElement);
        e.preventDefault();
        if (e.key === "Enter") {
          if (first?.matches(".library-row:not([data-package-choice])")) first.click(); else first?.focus();
        } else if (e.key === "ArrowUp" && index <= 0) search?.focus();
        else rows[Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1))]?.focus();
      });
    }
    return {facets: sh.querySelector(".cat-facet-col"), preview: sh.querySelector(".cat-preview")};
  }
  function render(list, o) {
    const key = o.key || "dialog", st = stateOf(key), target = o.target || "schematic", q = String(o.query || "");
    if (st.owner !== o.owner) { st.owner = o.owner; st.selected = null; }
    const t0 = globalThis.performance?.now?.() || 0;
    const members = globalThis.AtriumComponentFamilies?.memberships(o.owner);
    const res = query(o.pool, q, {ids: o.ids, state: st.facets, footprints: o.footprints, keep: o.keep, members});
    const sh = shell(list, key);
    const dialog = list.closest("dialog"), manage = dialog?.querySelector("#manage-library-families");
    if (manage && o.manage) {
      manage.disabled = false;
      manage.onclick = async () => {
        try {
          if (!globalThis.AtriumLibraryFamiliesUI) await AtriumLazy.need("AtriumLibrary");
          if (dialog.open) AtriumLibraryFamiliesUI.manage(o.manage, {done: o.onChange});
        } catch (e) { o.manage.info?.(e.message); }
      };
    }
    facetsUI(sh.facets, key, res.counts, o.onChange || (() => {}), {total: res.items.length});
    list.replaceChildren();
    let shown, highlighted, choosePackage;
    const show = (def, row, grouped = false) => {
      if (highlighted !== row) {
        highlighted?.classList.remove("selected");
        highlighted = row;
        highlighted?.classList.add("selected");
      }
      if (shown === def && choosePackage === grouped) return;
      shown = def; choosePackage = grouped; st.selected = def?.id || null; sh.preview.replaceChildren();
      preview(sh.preview, def, {member: members?.get(def?.id), onPlace: o.onPick, choosePackage, pins: true});
    };
    const row = (def, variant) => {
      const b = el("button", null, "library-row"); b.type = "button"; b.dataset.def = def.id;
      if (variant) b.dataset.packageChoice = "";
      b.onclick = () => o.onPick?.(def);
      b.onfocus = () => show(def, b);
      // Filtering can put a different row under a stationary pointer.
      b.onpointermove = e => { if (e.pointerType !== "touch") show(def, b); };
      const name = el("span", null, "library-name");
      name.append(el("strong", variant?.label || def.name), el("small", variant ? variant.description : subtitle(def, target)));
      if (variant) name.append(el("span", variant.context, "visually-hidden"));
      name.title = variant ? [variant.label, variant.description].filter(Boolean).join(" · ") : def.name;
      const f = rec(def).f, tags = el("span", null, "cat-tags");
      for (const t of [f.mounting, f.pins && f.pins + "p"]) if (t) tags.append(el("span", t, "ui-badge cat-tag"));
      b.append(rowIcons(def, variant ? null : target), name, tags);
      return b;
    };
    const filtering = !!q.trim() || res.active > 0;
    const previous = st.query === q ? res.items.find(d => d.id === st.selected) : null;
    componentTree(list, res.items, row, {key, owner: o.owner, members, open: filtering, reveal: previous?.id, onGroup: () => show(null, null, true)});
    if (!res.items.length) {
      const p = el("p", "No matching " + (target === "pcb" ? "footprints" : "parts") + "." + (res.hidden ? " " + res.hidden + " built-in duplicate" + (res.hidden === 1 ? " is" : "s are") + " hidden." : ""), "side-note");
      list.append(p);
      if (res.active) { const b = quietButton("Clear the parameter filters", "cat-more"); b.onclick = () => { clearFacets(key); o.onChange?.(); }; list.append(b); }
    }
    const grouped = !!(members?.size && res.items.some(d => members.has(d.id)));
    st.query = q;
    const choice = previous || (!grouped && res.items[0]);
    const selected = choice && visibleRows(list).find(r => r.dataset.def === choice.id);
    show(selected ? choice : null, selected || null, grouped);
    const ms = (globalThis.performance?.now?.() || 0) - t0;
    list.dataset.renderMs = ms.toFixed(1);
    return res;
  }
  return Object.freeze({fold, compact, natural, GROUPS, LEAVES, FACETS, SUPERSEDED, category, groupOf, groupFor, hidden, uniqueFootprints, fpKey,
    packageOf, facets, pinCount, mounting, matches, parse, query, prepare, queryPrepared, pick, find, get, summary, record: rec, built: () => built,
    facetsUI: (...a) => hasDOM() ? facetsUI(...a) : 0, tree, componentTree, visibleRows, rowIcons, subtitle, preview, cancelPreview, render, clearFacets, state: stateOf});
})();
