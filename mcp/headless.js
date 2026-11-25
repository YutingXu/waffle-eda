"use strict";
// Headless automation dispatcher for the MCP server and CLI.
//
// One long-lived JavaScript context keeps the parsed saved project (`base`,
// keyed by its SHA-256) and, while a tool or pipeline runs, a private working
// copy (`work`) that editing tools change. The Python host turns the working
// copy into an .waffle-ai proposal or, when writing is allowed, a saved file.
//
// AtriumHeadless(headerJSON, body?) -> headerJSON + ("\n" + body)?
//   header {op, args}. Large text (project files, generated outputs) travels
//   as the raw body so it is never quoted inside JSON.
// AtriumHeadlessScript(headerJSON, projectJSON) runs a user script in a
// separate context with only the app modules loaded; see runScript below.

// ---------------------------------------------------------------- polyfills
// A bare JavaScriptCore context has no TextEncoder, TextDecoder, atob or btoa.
(() => {
  const g = globalThis;
  if (typeof g.TextEncoder !== "function") {
    g.TextEncoder = class TextEncoder {
      get encoding() { return "utf-8"; }
      encode(input = "") {
        const s = String(input), out = new Uint8Array(s.length * 3);
        let n = 0;
        for (let i = 0; i < s.length; i++) {
          let c = s.charCodeAt(i);
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) { c = 0x10000 + ((c - 0xd800) << 10) + (d - 0xdc00); i++; }
          }
          if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
          if (c < 0x80) out[n++] = c;
          else if (c < 0x800) { out[n++] = 0xc0 | c >> 6; out[n++] = 0x80 | c & 63; }
          else if (c < 0x10000) { out[n++] = 0xe0 | c >> 12; out[n++] = 0x80 | c >> 6 & 63; out[n++] = 0x80 | c & 63; }
          else { out[n++] = 0xf0 | c >> 18; out[n++] = 0x80 | c >> 12 & 63; out[n++] = 0x80 | c >> 6 & 63; out[n++] = 0x80 | c & 63; }
        }
        return out.slice(0, n);
      }
    };
  }
  if (typeof g.TextDecoder !== "function") {
    const CP1252 = [0x20ac,0x81,0x201a,0x192,0x201e,0x2026,0x2020,0x2021,0x2c6,0x2030,0x160,0x2039,0x152,0x8d,0x17d,0x8f,
      0x90,0x2018,0x2019,0x201c,0x201d,0x2022,0x2013,0x2014,0x2dc,0x2122,0x161,0x203a,0x153,0x9d,0x17e,0x178];
    const LABELS = {"utf-8":"utf-8", "utf8":"utf-8", "unicode-1-1-utf-8":"utf-8", "utf-16le":"utf-16le", "utf-16":"utf-16le",
      "utf-16be":"utf-16be", "windows-1252":"windows-1252", "latin1":"windows-1252", "iso-8859-1":"windows-1252",
      "ascii":"windows-1252", "us-ascii":"windows-1252", "cp1252":"windows-1252"};
    const bytesOf = v => v instanceof ArrayBuffer ? new Uint8Array(v) :
      ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : new Uint8Array(0);
    g.TextDecoder = class TextDecoder {
      constructor(label = "utf-8", options = {}) {
        const e = LABELS[String(label).trim().toLowerCase()];
        if (!e) throw RangeError("The encoding " + label + " is not supported.");
        this.encoding = e; this.fatal = !!options.fatal; this.ignoreBOM = !!options.ignoreBOM;
      }
      decode(input) {
        const b = bytesOf(input), n = b.length, parts = [];
        let units = [], i = 0;
        const push = c => {
          if (c > 0xffff) { c -= 0x10000; units.push(0xd800 + (c >> 10), 0xdc00 + (c & 1023)); } else units.push(c);
          if (units.length >= 8192) { parts.push(String.fromCharCode.apply(null, units)); units = []; }
        };
        const bad = () => { if (this.fatal) throw TypeError("The encoded data was not valid."); push(0xfffd); };
        if (this.encoding === "utf-8") {
          if (!this.ignoreBOM && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
          const cont = k => k < n && (b[k] & 0xc0) === 0x80;
          while (i < n) {
            const c = b[i];
            if (c < 0x80) { push(c); i++; }
            else if (c >= 0xc2 && c < 0xe0 && cont(i + 1)) { push((c & 31) << 6 | b[i + 1] & 63); i += 2; }
            else if (c >= 0xe0 && c < 0xf0 && cont(i + 1) && cont(i + 2)) {
              const v = (c & 15) << 12 | (b[i + 1] & 63) << 6 | b[i + 2] & 63;
              if (v < 0x800 || v >= 0xd800 && v <= 0xdfff) { bad(); i++; } else { push(v); i += 3; }
            } else if (c >= 0xf0 && c < 0xf5 && cont(i + 1) && cont(i + 2) && cont(i + 3)) {
              const v = (c & 7) << 18 | (b[i + 1] & 63) << 12 | (b[i + 2] & 63) << 6 | b[i + 3] & 63;
              if (v < 0x10000 || v > 0x10ffff) { bad(); i++; } else { push(v); i += 4; }
            } else { bad(); i++; }
          }
        } else if (this.encoding === "windows-1252") {
          for (; i < n; i++) push(b[i] >= 0x80 && b[i] < 0xa0 ? CP1252[b[i] - 0x80] : b[i]);
        } else {
          const le = this.encoding === "utf-16le";
          if (!this.ignoreBOM && n >= 2 && (le ? b[0] === 0xff && b[1] === 0xfe : b[0] === 0xfe && b[1] === 0xff)) i = 2;
          for (; i + 1 < n; i += 2) {
            const c = le ? b[i] | b[i + 1] << 8 : b[i] << 8 | b[i + 1];
            units.push(c);
            if (units.length >= 8192) { parts.push(String.fromCharCode.apply(null, units)); units = []; }
          }
          if (i < n) bad();
        }
        parts.push(String.fromCharCode.apply(null, units));
        return parts.join("");
      }
    };
  }
  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (typeof g.btoa !== "function") {
    g.btoa = input => {
      const s = String(input), out = [];
      for (let i = 0; i < s.length; i += 3) {
        const a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
        if (a > 255 || b > 255 || c > 255) throw Error("btoa accepts Latin-1 text only.");
        const v = a << 16 | (b || 0) << 8 | (c || 0);
        out.push(B64[v >> 18 & 63] + B64[v >> 12 & 63] + (i + 1 < s.length ? B64[v >> 6 & 63] : "=") + (i + 2 < s.length ? B64[v & 63] : "="));
      }
      return out.join("");
    };
  }
  if (typeof g.atob !== "function") {
    const map = new Map([...B64].map((ch, i) => [ch, i]));
    g.atob = input => {
      const s = String(input).replace(/[\t\n\f\r ]+/g, "").replace(/=+$/, ""), units = [], parts = [];
      if (s.length % 4 === 1 || /[^A-Za-z0-9+/]/.test(s)) throw Error("The string to decode is not valid base64.");
      for (let i = 0; i < s.length; i += 4) {
        const v = map.get(s[i]) << 18 | map.get(s[i + 1]) << 12 | (map.get(s[i + 2]) || 0) << 6 | (map.get(s[i + 3]) || 0);
        units.push(v >> 16 & 255);
        if (i + 2 < s.length) units.push(v >> 8 & 255);
        if (i + 3 < s.length) units.push(v & 255);
        if (units.length >= 8190) { parts.push(String.fromCharCode.apply(null, units)); units.length = 0; }
      }
      parts.push(String.fromCharCode.apply(null, units));
      return parts.join("");
    };
  }
  if (!g.performance) g.performance = {now: () => Date.now()};
})();

globalThis.AtriumHeadless = (() => {
  const S = {base: null, digest: null, work: null, version: 0, cache: new Map(), baseCache: new Map(), fab: null};
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const fail = m => { throw Error(m); };
  const round = (v, d = 4) => typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v;
  const point = p => Array.isArray(p) ? [round(p[0]), round(p[1])] : null;
  const natural = typeof Intl !== "undefined" ? new Intl.Collator("en", {numeric: true}).compare : (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const need = (name, file) => globalThis[name] || fail(name + " is not available in this build (" + file + ").");

  const project = () => S.work || S.base || fail("Load the saved project first.");
  const defsOf = p => new Map(p.library.map(d => [d.id, d]));
  function documentFor(p, id, kind) {
    const d = id != null ? p.documents.find(x => x.id === id) : p.documents.find(x => x.kind === kind) || p.documents[0];
    if (!d) fail(id != null ? "The project has no document " + id + "." : "The project has no " + (kind === "pcb" ? "PCB layout." : "documents."));
    if (kind && d.kind !== kind) fail(kind === "pcb" ? "Choose a PCB document ID." : "Choose a schematic document ID.");
    return d;
  }
  const board = (p, id) => documentFor(p, id, "pcb");
  function mutable() {
    if (!S.base) fail("Load the saved project first.");
    if (!S.work) S.work = JSON.parse(JSON.stringify(S.base));
    return S.work;
  }
  function touched() { S.version++; S.cache.clear(); S.fab = null; S.checkedButter = null; }
  function cached(key, make) {
    const cache = S.work ? S.cache : S.baseCache;
    if (!cache.has(key)) {
      const result = make();
      if (S.baseCache.size + S.cache.size >= 16) {
        const evict = S.cache.size ? S.cache : S.baseCache;
        evict.delete(evict.keys().next().value);
      }
      cache.set(key, result);
    }
    return cache.get(key);
  }
  function page(items, a) {
    const offset = a.offset ?? 0, limit = a.limit ?? 50, end = offset + limit;
    return {items: items.slice(offset, end), total: items.length, next_offset: end < items.length ? end : null};
  }
  const latin1 = bytes => {
    const parts = [];
    for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + 8192)));
    return parts.join("");
  };
  const text = content => content instanceof Uint8Array ? {binary: true, body: latin1(content)} : {binary: false, body: String(content)};

  // ---------------------------------------------------------------- session
  const calculationSheets = p => p.documents.filter(d => d.kind === "schematic" && d.items.some(i => i.kind === "textframe" && i.calculation)).map(d=>d.id);
  function load(a, body) {
    const p = Atrium.validate(JSON.parse(body));
    S.base = p; S.digest = a.digest; S.work = null; S.baseCache.clear(); touched();
    const calculationDocuments=calculationSheets(p);
    return {name: p.name, working_revision: revisionOf(p), documents: p.documents.map(d => ({id: d.id, kind: d.kind, name: d.name, items: d.items.length})),
      hasCalculations:!!calculationDocuments.length,calculationDocuments};
  }
  const revisionOf = p => p.revision ? {letter:p.revision.letter, status:p.revision.status} : null;
  function info() {
    const has = n => !!globalThis[n];
    return {loaded: !!S.base, digest: S.digest, working: !!S.work,
      documents: S.base ? project().documents.map(d => ({id: d.id, kind: d.kind, name: d.name})) : [],
      variants: S.base ? (globalThis.AtriumVariants?.list(project()) || []).map(v => ({id: v.id, name: v.name, description: v.description || ""})) : [],
      active_variant: S.base ? (globalThis.AtriumVariants?.find(project(), project().activeVariant)?.name || null) : null,
      modules: {drc: has("AtriumDRC"), router: has("AtriumRouter"), autorouter: has("AtriumAutorouter"), fanout: has("AtriumFanout"),
        length: has("AtriumLength"), scripting: has("AtriumScripting"), api: has("AtriumAPI")}};
  }

  // ---------------------------------------------------------------- ERC
  function erc(a) {
    const p = project(), documentId = a.document_id;
    if (documentId != null) documentFor(p,documentId);
    const r = need("AtriumERC", "checks/erc.js").run(p);
    const want = new Set(a.classes || ["Fatal", "Error", "Warning", "Info"]), limit = a.limit ?? 50, checks = a.checks ? new Set(a.checks) : null;
    const classes = {}, byCheck = {};
    const counts = documentId == null ? {...r.counts,Info:Math.max(0,r.counts.Info - 1)} :
      {Fatal:0,Error:0,Warning:0,Info:0};
    for (const m of r.messages) {
      if (m.check === "summary" || documentId != null && m.documentId !== documentId) continue;
      if (documentId != null) counts[m.class]++;
      byCheck[m.check] = (byCheck[m.check] || 0) + 1;
      if (!want.has(m.class) || checks && !checks.has(m.check)) continue;
      const g = classes[m.class] || (classes[m.class] = {total: 0, items: []});
      g.total++;
      if (g.items.length < limit) {
        const row = {check: m.check, text: m.text, document_id: m.documentId ?? null};
        if (m.objectId) row.object_id = m.objectId;
        if (m.point) row.at = point(m.point);
        g.items.push(row);
      }
    }
    const passed = r.complete !== false && (documentId == null ? r.passed : counts.Fatal + counts.Error === 0);
    const summary = documentId == null ? r.summary : "Selected document: " +
      [counts.Fatal + " fatal", counts.Error + " errors", counts.Warning + " warnings", counts.Info + " informational"].join(", ");
    return {passed, summary, counts, sheets: r.sheets, by_check: byCheck, classes,
      ...(r.complete === false ? {complete: false, diagnostics: r.diagnostics.slice(0, limit)} : {})};
  }

  // ---------------------------------------------------------------- DRC and rules
  const ruleSource = (doc, p) => p.rules ? "project" : "defaults";
  // run_drc and unified checks share the desktop batch and its revision-scoped cache.
  function drcOf(doc, {types, limit = 2000, ruleSet, checkMode, antennae = false} = {}) {
    const p = project(), R = AtriumRules;
    const mode = R.checkMode({types, checkMode});
    const key = "drc|" + doc.id + "|" + (types?.join(",") ?? "*") + "|" + limit + "|" + (ruleSet || "") + "|" + mode + "|" + antennae;
    return cached(key, () => {
      const defs = defsOf(p);
      // Link imported fill (or pour Eagle polygons that store none) before checking connectivity.
      if (doc.pcbDrawing?.sourceFill) globalThis.AtriumPolygonPour?.adopt(doc, defs, {project:p});
      const rules = ruleSet ? need("AtriumRuleSets", "checks/rule-sets.js").rulesFor(p, doc, ruleSet) : R.stored(doc, p) || R.defaults();
      const connections = () => globalThis.AtriumConnectivity ? cached("conn|" + doc.id, () => AtriumConnectivity.inspect(doc, defs, undefined, {project:p})) : null;
      const result = need("AtriumDRC", "checks/drc.js").batch(doc, defs, rules, {types, limit, connections, project:p, checkMode:mode});
      if (antennae) need("AtriumDRCFixes", "checks/drc-fixes.js").augment(result, doc, defs, {types:["netAntennae"], limit, checkMode:mode});
      return result;
    });
  }
  function drc(a) {
    const p = project(), doc = board(p, a.document_id), filter = a.rules;
    const isAntennaRule = type => /^(?:netantennae|net antennae|atrium-netantennae)$/i.test(type);
    const antennae = !!filter?.some(isAntennaRule);
    const engineTypes = filter?.filter(type => !isAntennaRule(type));
    const onlyTypes = engineTypes?.every(type => Object.hasOwn(AtriumRules.types, type)) ? [...new Set(engineTypes)].sort() : undefined;
    const checkMode = a.all_checks || filter || a.rule_set ? "all" : undefined;
    const out = drcOf(doc, {types:onlyTypes, limit:a.max_per_rule, ruleSet:a.rule_set, antennae, checkMode});
    // Waivers saved with the board (drc-waivers.js): waived violations are listed, marked, and not counted.
    const W = doc.drcWaivers?.length ? globalThis.AtriumDRCWaivers : null, waived = new Map();
    if (W) for (const {violation, waiver} of W.split(doc, out.violations).waived) waived.set(violation, waiver);
    let rows = out.violations, diagnostics = out.diagnostics;
    if (filter && !onlyTypes) {
      const f = new Set(filter.map(s => s.toLowerCase()));
      const match = v => f.has(v.type.toLowerCase()) || v.type === "pourClearance" && f.has("clearance") ||
        f.has(String(v.ruleName).toLowerCase()) || f.has(String(v.ruleId).toLowerCase());
      rows = rows.filter(match);
      diagnostics = diagnostics.filter(v => match(v) || v.type === "clearance" && f.has("pourclearance"));
    }
    const window = page(rows, a);
    window.items = window.items.map(v => {
      const row = {type: v.type, rule: v.ruleName, rule_id: v.ruleId, id: v.id ?? null, title: v.title};
      if (v.ruleSet) row.rule_set = v.ruleSet;
      if (v.otherId) row.other_id = v.otherId;
      if (v.what) row.what = v.what;
      if (v.detail) row.detail = v.detail;
      if (v.type === "netAntennae") row.severity = "warning";
      if (v.actual != null) { row.actual = round(v.actual); row.required = round(v.required); row.limit = v.limit; }
      if (v.at) row.at = point(v.at);
      if (v.otherAt && (v.otherAt[0] !== v.at?.[0] || v.otherAt[1] !== v.at?.[1])) row.other_at = point(v.otherAt);
      const w = waived.get(v);
      if (w) { row.waived = true; row.waiver_id = w.id; if (w.note) row.waiver_note = w.note; }
      return row;
    });
    const less = new Map(); for (const v of waived.keys()) less.set(v.ruleId, (less.get(v.ruleId) || 0) + 1);
    const rules = out.rules.map(r => ({id: r.id, name: r.name, type: r.type, ...(r.ruleSet ? {rule_set: r.ruleSet} : {}), count: r.count - (less.get(r.id) || 0), ...(less.get(r.id) ? {waived: less.get(r.id)} : {})})).filter(r => r.count || r.waived);
    return {document_id: doc.id, rules_source: a.rule_set ? "rule_set" : ruleSource(doc, p), rule_set: a.rule_set ? AtriumRuleSets.get(p, a.rule_set).name : globalThis.AtriumRuleSets?.label(p, doc) || null, units: "mm", total: out.total, waived: waived.size, matching: rows.length,
      rules_checked: out.rules.length, rules, notes: out.notes, stats: {objects: out.stats.objects, ms: out.stats.ms}, ...window,
      ...(waived.size ? {total: rows.reduce((n, v) => n + (waived.has(v) ? 0 : 1), 0)} : {}),
      ...(diagnostics.length ? {complete:false, diagnostics:diagnostics.slice(0, a.limit ?? 50)} : {})};
  }
  // DRC waivers saved with a board: rule, objects, note, and whether they still hold (an object changed: cleared at the next edit).
  function drcWaivers(a) {
    const W = need("AtriumDRCWaivers", "checks/drc-waivers.js"), p = project(), doc = board(p, a.document_id);
    const items = W.list(doc).map(w => ({id: w.id, type: w.type, rule: w.rule, objects: w.objects, note: w.note || "", title: w.title || "", created: w.created || null,
      current: w.current, ...(w.at ? {at: point(w.at)} : {})}));
    return {document_id: doc.id, total: items.length, current: items.filter(w => w.current).length, ...page(items, a)};
  }
  function viaStubs(a) {
    const VS = need("AtriumViaStubs", "pcb/via-stubs.js"), p = project(), doc = board(p, a.document_id);
    const rep = VS.report(doc, defsOf(p), {project: p, max: a.max_stub, defaultMax: a.max_stub});
    let rows = rep.rows;
    if (a.only_flagged) rows = rows.filter(r => r.status === "over" || r.status === "severed");
    if (a.nets) { const s = new Set(a.nets); rows = rows.filter(r => s.has(r.net)); }
    const items = rows.map(r => ({id: r.id, net: r.net, at: point(r.at), span: r.span, used_layers: r.used, depth: round(r.depth), stub_top: round(r.stubTop),
      stub_bottom: round(r.stubBottom), residual: round(r.residual), backdrill: r.backdrill, status: r.status,
      ...(r.recommend ? {recommend_backdrill: r.recommend} : {}), ...(r.max != null ? {rule_max: r.max} : {}), ...(r.note ? {note: r.note} : {})}));
    return {document_id: doc.id, units: "mm", board_thickness: rep.total, estimated_stack: rep.estimated, layers: rep.layers, counts: rep.counts, ...page(items, a)};
  }
  function ruleSets(a) {
    const RS = need("AtriumRuleSets", "checks/rule-sets.js"), p = project(), doc = board(p, a.document_id), act = RS.active(p, doc);
    const sets = RS.list(p).map(s => ({name: s.name, builtin: !!s.builtin, approximate: !!s.approximate, source: s.source || null,
      description: s.description || "", rules: s.rules.list.length, types: [...new Set(s.rules.list.map(r => r.type))]}));
    return {document_id: doc.id, active: act ? act.name : null, active_modified: act ? act.modified : false, ...page(sets, a)};
  }
  function ruleSet(p, doc) { return AtriumRules.effective(doc, p); }
  function fieldsOf(type) {
    return AtriumRules.types[type].fields.map(f => {
      const row = {key: f.key, label: f.label, kind: f.kind};
      if (f.def !== undefined) row.default = f.def;
      if (f.optional) row.optional = true;
      if (f.options) row.options = f.options.map(([k]) => k);
      if (f.kind === "integer") { row.min = f.min; row.max = f.max; }
      return row;
    });
  }
  function rulesList(a) {
    const p = project(), doc = board(p, a.document_id), set = ruleSet(p, doc), q = (a.query || "").toLowerCase();
    const rows = set.list.filter(r => (!a.type || r.type === a.type) && (!q || (r.name + " " + r.type + " " + JSON.stringify(r.scope) + " " + JSON.stringify(r.scope2 || "")).toLowerCase().includes(q)))
      .map(r => ({id: r.id, name: r.name, type: r.type, category: AtriumRules.types[r.type].category, enabled: r.enabled, priority: r.priority,
        scope: r.scope, ...(r.scope2 ? {scope2: r.scope2} : {}), description: AtriumRules.describe(r, "mm")}));
    return {document_id: doc.id, rules_source: ruleSource(doc, p), units: "mm",
      net_classes: Object.keys(set.netClasses || {}).length, diff_pairs: (set.diffPairs || []).length,
      types: Object.keys(AtriumRules.types), ...page(rows, a)};
  }
  function ruleGet(a) {
    const p = project(), doc = board(p, a.document_id), set = ruleSet(p, doc);
    if (a.rule_id == null) return {document_id: doc.id, rules_source: ruleSource(doc, p), net_classes: set.netClasses || {}, diff_pairs: set.diffPairs || [], diff_pair_classes: set.diffPairClasses || {}};
    const r = set.list.find(x => x.id === a.rule_id) || set.list.find(x => x.name === a.rule_id) || fail("No rule has the ID or name " + a.rule_id + ".");
    const t = AtriumRules.types[r.type];
    return {document_id: doc.id, rules_source: ruleSource(doc, p), units: "mm", rule: r, description: AtriumRules.describe(r, "mm"),
      type: {key: r.type, title: t.title, category: t.category, help: t.help, two_scopes: !!t.two, fields: fieldsOf(r.type)}};
  }
  const SCOPE_KEYS = ["name", "comment", "enabled", "priority", "scope", "scope2"];
  function ruleChange(a) {
    const p = mutable(), doc = board(p, a.document_id), R = AtriumRules;
    // The board's rules in the project rule book; net classes and pairs are the signal model's (R.effective).
    if (a.target && a.target !== "board") fail("Rules are the project's: change a board's rules (target \"board\").");
    const target = "board", set = JSON.parse(JSON.stringify(R.effective(doc, p)));
    const find = id => set.list.find(r => r.id === id) || set.list.find(r => r.name === id) || fail("No rule has the ID or name " + id + ".");
    const assign = (r, values) => {
      const keys = new Set([...SCOPE_KEYS, ...R.types[r.type].fields.map(f => f.key)]);
      for (const [k, v] of Object.entries(values || {})) {
        if (!keys.has(k) || k === "scope2" && !R.types[r.type].two) fail("A " + r.type + " rule has no setting " + k + ".");
        r[k] = k === "priority" && Number.isInteger(v) ? v - 0.5 : v;  // Sort before the rule now at that priority.
      }
    };
    const done = [];
    for (const c of a.changes) {
      if (c.action === "update") { const r = find(c.rule_id); assign(r, c.set); done.push("Updated " + r.name); }
      else if (c.action === "remove") { const r = find(c.rule_id); set.list.splice(set.list.indexOf(r), 1); done.push("Removed " + r.name); }
      else if (c.action === "add") {
        const t = R.types[c.type] || fail("Unknown rule type " + c.type + ".");
        let n = 1; while (set.list.some(r => r.id === c.type + "-" + n)) n++;
        const r = {id: c.type + "-" + n, type: c.type, name: c.name || t.altium + (set.list.some(x => x.name === t.altium) ? "_" + n : ""),
          comment: "", enabled: true, priority: 1e5, scope: {kind: "all"}};
        if (t.two) r.scope2 = {kind: "all"};
        for (const f of t.fields) r[f.key] = Array.isArray(f.def) ? [...f.def] : plain(f.def) ? {...f.def} : f.def;
        assign(r, c.set);
        set.list.push(r); done.push("Added " + r.name);
      } else if (c.action === "set_net_class") { set.netClasses = {...(set.netClasses || {}), [c.name]: [...c.nets]}; done.push("Net class " + c.name); }
      else if (c.action === "remove_net_class") {
        if (!set.netClasses?.[c.name]) fail("No net class is named " + c.name + ".");
        delete set.netClasses[c.name]; done.push("Removed net class " + c.name);
      } else if (c.action === "set_diff_pair") {
        set.diffPairs = (set.diffPairs || []).filter(x => x.name !== c.name);
        set.diffPairs.push({name: c.name, positive: c.positive, negative: c.negative}); done.push("Differential pair " + c.name);
      } else if (c.action === "remove_diff_pair") {
        const before = (set.diffPairs || []).length;
        set.diffPairs = (set.diffPairs || []).filter(x => x.name !== c.name);
        if (set.diffPairs.length === before) fail("No differential pair is named " + c.name + ".");
        done.push("Removed differential pair " + c.name);
      } else fail("Unknown rule change " + c.action + ".");
    }
    const next = R.validate(R.normalize(JSON.parse(JSON.stringify(set))));
    R.store(doc, p, set);
    touched();
    return {document_id: doc.id, target, rules: next.list.length, changes: done};
  }

  // ---------------------------------------------------------------- fabrication
  function dateOf(s) {
    if (s == null) return new Date();
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) fail("Use an ISO 8601 date such as 2026-01-31T12:00:00Z.");
    return d;
  }
  // ---------------------------------------------------------------- panelization
  // panel.js: create or update a panel document; plan (default) works on a scratch copy.
  // generate leaves the panel's fabrication plan in S.fab for fab_file.
  function panelOptions(a) {
    const o = {};
    for (const k of ["rows", "cols", "spacing", "rotation", "separation", "cells"]) if (a[k] !== undefined) o[k] = a[k];
    if (a.fab_profile !== undefined) o.fabProfile = a.fab_profile;
    if (a.rails !== undefined) o.rails = a.rails;
    const tabs = {}; for (const [k, v] of [["tab_width", "width"], ["tabs_per_edge", "perEdge"], ["hole", "hole"], ["pitch", "pitch"], ["hole_offset", "offset"]]) if (a[k] !== undefined) tabs[v] = a[k];
    if (Object.keys(tabs).length) o.tabs = tabs;
    if (a.fiducials !== undefined) o.fiducials = {enabled: a.fiducials};
    if (a.tooling !== undefined) o.tooling = {enabled: a.tooling};
    if (a.text !== undefined || a.revision !== undefined) o.text = {...(a.text !== undefined ? {enabled: a.text} : {}), ...(a.revision !== undefined ? {revision: a.revision} : {})};
    return o;
  }
  function panelize(a) {
    const PN = need("AtriumPanel", "pcb/panel.js"), apply = a.mode === "proposal" || a.mode === "write", p = apply ? mutable() : JSON.parse(JSON.stringify(project()));
    const opts = panelOptions(a), date = dateOf(a.date);
    let doc;
    if (a.panel_id != null) {
      doc = PN.panelOf(p, a.panel_id);
      const old = PN.normalize(doc.panel), next = {...old, ...opts};
      for (const k of ["rails", "tabs", "fiducials", "tooling", "text"]) if (opts[k]) next[k] = {...old[k], ...opts[k]};
      if (a.document_id != null) next.board = board(p, a.document_id).id;
      doc.panel = PN.normalize(next);
      if (a.name) doc.name = a.name;
    } else {
      doc = PN.create(p, {...opts, board: board(p, a.document_id).id, name: a.name});
      if (opts.text) doc.panel = PN.normalize({...doc.panel, text: {...PN.DEFAULTS.text, ...opts.text}});
      p.documents.push(doc);
    }
    if (apply) touched();
    const G = PN.layout(p, doc, null, {date}), r = PN.check(p, doc, {date, fabProfile: a.fab_profile});
    let files = null, description = null;
    if (a.generate) {
      const model = PN.analyse(p, doc, {date}), plan = AtriumFabOutputs.plan(model, {date});
      S.fab = {model, plan, files: plan.files};
      files = plan.files.map(f => ({name: f.name, kind: f.kind, title: f.title}));
      const base = AtriumFabOutputs.baseName(doc.name);
      description = {name: base + "-Panel.txt", text: PN.describe(model.panel, doc.name)};
    }
    return {panel_id: doc.id, name: doc.name, boards: G.instances.length, board_names: [...new Set(G.instances.map(i => i.board.name))], size: [round(G.W), round(G.H)],
      separation: G.params.separation, tabs: G.tabs.length, mouse_bites: G.bites.length, vscore_lines: G.vlines.length, fiducials: G.fiducials.length, tooling_holes: G.tooling.length,
      instances: G.instances.map(i => ({index: i.index, board: i.board.name, row: i.row + 1, col: i.col + 1, rotation: i.rotation, center: point([(i.box[0] + i.box[2]) / 2, G.H - (i.box[1] + i.box[3]) / 2])})),
      panel: doc.panel, check: r.items, fab_profile: r.profile, description, approximate: true, note: r.note, files, date: date.toISOString(), mode: apply ? a.mode : "plan"};
  }
  function fabFile(a) {
    const f = S.fab?.files[a.index] || fail("Plan the fabrication outputs first.");
    const r = S.fab.drills?.get(f) || AtriumFabOutputs.generate(S.fab.model, S.fab.plan, f), t = text(r.content);
    return [{name: f.name, kind: f.kind, binary: t.binary}, t.body];
  }

  // ---------------------------------------------------------------- output job sets
  // List saved output job sets and run one in the disposable translation worker.
  function outputJobs(a={}) {
    const J = need("AtriumOutputJobs", "formats/output-jobs.js"), p = project();
    const brief = s => ({name: s.name, description: s.description || "", folder: s.folder, zip: s.zip,
      outputs: s.outputs.map(o => ({id: o.id, kind: o.kind, enabled: o.enabled, label: o.label || J.KINDS[o.kind]?.label || o.kind, options: o.options}))});
    return {job_sets: J.list(p).map(s => brief(J.normalise(s))), presets: J.presets(a).map(brief), legacy_presets: (J.presets({legacy: true}) || []).filter(s => s.legacy).map(brief),
      kinds: Object.fromEntries(J.ORDER.filter(k=>k!=="odb"||a.odbEnabled===true).map(k => [k, {label: J.KINDS[k].label, folder: J.KINDS[k].folder, options: J.KINDS[k].fields.map(f => f[0])}]))};
  }
  function translatedJob(a, body) {
    const J = need("AtriumOutputJobs", "formats/output-jobs.js"), p = JSON.parse(body);
    let ref = a.definition ?? a.job ?? fail("Name a job set (job) or pass a definition.");
    if (a.board != null) { board(p, a.board); ref = {...J.resolve(p, ref, a), board: a.board}; }
    if (a.panel != null) ref = {...J.resolve(p, ref, a), panel: a.panel};
    const r = J.run(p, ref, {date: dateOf(a.date), revision: a.revision, reportHashes: false, provenance:a.provenance,
      odbEnabled:a.odbEnabled===true, translate: AtriumTranslators.exportSession()});
    const files = r.files.map(({name, data}) => data instanceof Uint8Array ? {name, bytes: data} : {name, text: data});
    return translatedSet(files, {report: r.report});
  }

  // ---------------------------------------------------------------- variants
  // a.variant: id or name of an assembly variant; null or "" for the base design; omitted for the
  // project's active variant. Returns the resolved copy the outputs read.
  function variantOf(p, a) {
    const V = globalThis.AtriumVariants;
    if (!V) { if (a.variant != null && a.variant !== "") fail("Assembly variants are not available in this build (variants.js)."); return p; }
    try { return V.forOutput(p, a.variant); } catch (e) { fail(e.message); }
  }
  const variantName = p => p.variantApplied?.name ?? (globalThis.AtriumVariants?.find(p, p.activeVariant)?.name || null);

  // ---------------------------------------------------------------- BOM
  function bom(a) {
    const B = need("AtriumBOM", "formats/bom.js"), base = project();
    const p = variantOf(base, a.variant !== undefined ? a : {variant: B.findView(base, a.view || "")?.variant});
    if (a.board != null) board(p, a.board);
    const view = a.view ? (B.findView(p, a.view) || fail("There is no BOM view called " + a.view + ". Views: " + (B.views(p).map(v => v.name).join(", ") || "none") + ".")) : null;
    const collected = B.collect(p, {source: a.source ?? view?.source, board: a.board});
    const settings = view ? {view: view.name} : {};
    if (a.columns) settings.columns = a.columns;
    if (a.group_by) settings.groupBy = a.group_by;
    if (a.sort) settings.sort = {key: a.sort.key, dir: a.sort.descending ? -1 : 1};
    if (a.title_block !== undefined) settings.titleBlock = a.title_block;
    if (a.min_run) settings.minRun = a.min_run;
    if (a.date) settings.now = dateOf(a.date).toISOString();
    const known = new Set(B.columns(collected).map(c => c.key));
    for (const k of [...(a.columns || []), ...(a.group_by || []), ...(a.sort ? [a.sort.key] : [])])
      if (!known.has(k)) fail("Unknown BOM column " + k + ". Available: " + [...known].join(", ") + ".");
    const r = B.report(p, settings, collected), format = a.format || "csv";
    const head = {name: B.fileName(p.name, format), format, view: view?.name || null, variant: variantName(p), source: r.source, line_count: r.lineCount, total_parts: r.totalParts,
      excluded: r.excluded, columns: r.columns.map(c => c.key), available_columns: [...known]};
    if (a.preview) head.preview = r.rows.slice(0, a.preview);
    if (format === "xlsx") return [{...head, parts: true}, JSON.stringify(B.xlsxFiles(r).map(f => ({name: f.name, data: typeof f.data === "string" ? f.data : latin1(f.data), binary: typeof f.data !== "string"})))];
    return [head, format === "html" ? B.html(r) : B.csv(r)];
  }

  // ---------------------------------------------------------------- annotation
  function bomOptimise(a) {
    const B = need("AtriumBOM", "formats/bom.js"); need("AtriumBOMOptimiser", "formats/bom-optimiser.js");
    const apply = a.mode === "proposal" || a.mode === "write", p = apply ? mutable() : project();
    if (a.board != null) board(p, a.board);
    const r = B.optimise(p, {source: a.source, board: a.board, checks: a.checks !== false});
    let applied = null;
    if (apply) {
      const ids = a.proposals || r.proposals.filter(x => x.selected).map(x => x.id);
      const unknown = ids.find(id => !r.proposals.some(x => x.id === id));
      if (unknown) fail("Unknown proposal " + unknown + ". Run optimise_bom with mode plan to list them.");
      applied = B.applyOptimisation(p, r, ids);
      if (applied.changed) touched();
    }
    return {...AtriumBOMOptimiser.summarise(r, {limit: a.limit ?? 50}), applied};
  }
  function annotate(a) {
    const AN = need("AtriumAnnotate", "notebook/annotate.js"), p = a.apply ? mutable() : project();
    const options = {order: a.order, action: a.action, matching: a.matching, location: a.location};
    for (const k of Object.keys(options)) if (options[k] === undefined) delete options[k];
    const plan = AN.plan(p, options), boards = a.boards === undefined ? "*" : a.boards;
    const rows = plan.changes.map(c => ({id: c.id, sheet: c.sheet, current: c.current, proposed: c.proposed, ...(c.display && c.display !== c.proposed ? {display: c.display, unit: c.unit} : {})}));
    const job = a.apply && plan.changes.length ? AN.prepare(p, plan, {boards}) : null;
    const back = job ? {rows: job.board, issues: job.issues} :
      boards ? AN.backAnnotation(p, plan.changes, boards) : {rows: [], issues: []};
    if (job) { job.execute(); touched(); }
    const boardRows = back.rows, issues = [...plan.issues, ...back.issues];
    return {schematic_changes: rows.length, board_changes: boardRows.length, issues,
      board: boardRows.slice(0, 200).map(r => ({board: r.board, id: r.targetId, before: r.before, after: r.after})), ...page(rows, a)};
  }

  // ---------------------------------------------------------------- layer stack
  function stackupGet(a) {
    const ST = need("AtriumStackup", "pcb/stackup.js"), p = project(), doc = board(p, a.document_id), defs = defsOf(p);
    const stack = ST.get(doc, defs);
    let thickness = null;
    try { thickness = ST.thickness(doc, defs); } catch { /* derived stacks may not report one */ }
    return {document_id: doc.id, stored: !!ST.stored(doc), derived: !!stack.derived, thickness: round(thickness),
      copper_layers: ST.copperLayers(doc, defs), layers: stack.layers, drill_pairs: stack.drillPairs || [],
      problems: ST.problems(stack.layers), presets: ST.PRESETS.map(x => ({id: x.id, label: x.label}))};
  }
  // impedance_plan (docs/design/impedance-directives.md §10): can this stack-up reach an impedance spec, layer
  // by layer and per substack? Read-only. app/analysis/impedance-plan.js is the engine; the spec comes from `spec`
  // (the text grammar "90 diff ±10%", or {target, kind, structure, tolerance, window, layers, overrides, zones}),
  // `profile` (a stack-up impedance profile), or a signal's or tag's impedance (project.signals).
  function impedanceSpec(v) {
    if (v && typeof v === "object" && !Array.isArray(v)) return v;
    const m = /^\s*(\d+(?:\.\d+)?)\s*(?:Ω|ohms?)?\s*(se|single|diff|d)?\s*(cpw)?\s*(?:(?:±|\+\/-)\s*(\d+(?:\.\d+)?)\s*%)?\s*(?:;.*)?$/i.exec(String(v ?? ""));
    if (!m) fail("Read the impedance spec as: number [ohm] [se|diff] [cpw] [±N%], for example \"90 diff ±10%\".");
    return {target: Number(m[1]), kind: /^d/i.test(m[2] || "") ? "diff" : "se", structure: m[3] ? "cpw" : "auto", tolerance: m[4] == null ? 10 : Number(m[4])};
  }
  function impedancePlan(a) {
    const p = project(), store = p.signals && typeof p.signals === "object" ? p.signals : {};
    let spec = null, source = null;
    if (a.spec != null) { spec = impedanceSpec(a.spec); source = {spec: a.spec}; }
    else if (a.signal != null) {
      const sig = (store.signals || []).find(x => x.name === a.signal || x.id === a.signal);
      if (!sig) fail("No signal named " + a.signal + ".");
      const tag = (store.tags || []).find(t => t.impedance && (sig.tags || []).includes(t.name));
      const raw = sig.impedance || tag?.impedance;
      if (!raw) fail("Signal " + sig.name + " has no impedance spec (on itself or a tag). Pass spec.");
      spec = {kind: sig.kind === "diff" ? "diff" : "se", ...impedanceSpec(raw)}; source = {signal: sig.name, from: sig.impedance ? "signal" : "tag " + tag.name};
    } else if (a.tag != null) {
      const tag = (store.tags || []).find(t => t.name === a.tag);
      if (!tag?.impedance) fail("Tag " + a.tag + " has no impedance spec.");
      spec = impedanceSpec(tag.impedance); source = {tag: tag.name};
    }
    const out = need("AtriumImpedancePlan", "analysis/impedance-plan.js").headless({...a, spec}, {project, board, defsOf});
    // Every row names its layer, solved width, Z and reason (null when reachable); the top-level
    // suggestions start with the reachable layers (use_layer), then each unreachable row's ranked fixes.
    for (const r of out.layers) Object.assign(r, {layer: r.key, width: r.width ?? null, z: r.z ?? null, reason: r.reason ?? null});
    const ok = out.layers.filter(r => r.reachable).sort((x, y) => Math.abs(x.width - 0.2) - Math.abs(y.width - 0.2));
    const suggestions = ok.slice(0, 3).map(r => ({action: "use_layer", layer: r.key, substack: r.stack, width: r.width, gap: r.gap ?? null,
      text: "Route on " + r.name + " at " + r.width + " mm" + (r.gap ? " with a " + r.gap + " mm gap" : "") + "."}));
    for (const r of out.layers) for (const s of r.suggestions || []) suggestions.push({action: s.kind, layer: r.key, substack: r.stack, ...s});
    return {...out, ...(source ? {source} : {}), suggestions: suggestions.slice(0, 12)};
  }
  function stackupChange(a) {
    const ST = need("AtriumStackup", "pcb/stackup.js"), p = a.plan_only ? JSON.parse(JSON.stringify(project())) : mutable();
    const doc = board(p, a.document_id), defs = defsOf(p), old = ST.copperLayers(doc, defs);
    let layers;
    if (a.preset != null) {
      layers = JSON.parse(JSON.stringify(ST.preset(a.preset).layers));
      const cu = layers.filter(ST.isCopper);
      cu.forEach((l, i) => { const key = ST.keyAt(i, cu.length), was = i === 0 ? "Top" : i === cu.length - 1 ? "Bottom" : key; if (old.includes(was)) l.source = was; });
    } else {
      layers = JSON.parse(JSON.stringify(a.layers || fail("Pass a preset or the new layer list.")));
      for (const l of layers) if (ST.isCopper(l) && l.source == null && old.includes(l.key)) l.source = l.key;
    }
    const result = ST.plan(doc, defs, layers, {moves: a.moves, drillPairs: a.drill_pairs, project: p});
    if (!result.ok) fail(result.problems.join(" "));
    const renumbered = [...result.map].filter(([x, y]) => x !== y).map(([from, to]) => ({from, to}));
    if (a.plan_only) return {ok: true, renumbered, layers: result.stackup.layers.length, copper_layers: result.stackup.layers.filter(ST.isCopper).length};
    const moved = ST.apply(doc, defs, result);
    touched();
    return {ok: true, renumbered, moved_objects: moved, copper_layers: ST.copperLayers(doc, defsOf(p)), thickness: round(ST.thickness(doc, defsOf(p)))};
  }

  // ---------------------------------------------------------------- lengths
  // The length engine (AtriumLength.netLengths, through AtriumRules.netLengths): the numbers Length DRC and
  // the Length Manager show. match: the xSignal path through series parts, as matched-length DRC measures.
  function lengths(p, doc, a, match) {
    return AtriumRules.netLengths(doc, defsOf(p), {viaHeights: a.via_heights !== false, match});
  }
  function netLengths(a) {
    const p = project(), doc = board(p, a.document_id), m = lengths(p, doc, a), q = (a.query || "").toLowerCase();
    const only = a.nets ? new Set(a.nets) : null;
    const rows = [...m.values()].filter(e => (!only || only.has(e.net)) && (!q || e.net.toLowerCase().includes(q)))
      .sort((x, y) => natural(x.net, y.net))
      .map(e => ({net: e.net, length: round(e.length), track_length: round(e.trackLength), via_length: round(e.viaLength), tracks: e.tracks, vias: e.vias}));
    return {document_id: doc.id, units: "mm", via_heights: a.via_heights !== false, ...page(rows, a)};
  }
  function matchedLengths(a) {
    const p = project(), doc = board(p, a.document_id), m = lengths(p, doc, a, true);
    const len = n => m.get(n)?.length || 0;
    const groups = AtriumRules.matchedGroups(doc, {project: p}).map(g => {
      const longest = Math.max(0, ...g.nets.map(len));
      const nets = g.nets.map(n => ({net: n, length: round(len(n)), delta: round(longest - len(n)), ok: longest - len(n) <= g.tolerance + 1e-9}));
      const pairs = g.withinPair ? g.pairs.map(x => { const skew = Math.abs(len(x.positive) - len(x.negative));
        return {name: x.name, positive: x.positive, negative: x.negative, skew: round(skew), ok: skew <= g.pairTolerance + 1e-9}; }) : [];
      return {rule: g.ruleName, rule_id: g.ruleId, tolerance: g.tolerance, longest: round(longest), ok: nets.every(x => x.ok) && pairs.every(x => x.ok),
        failing: nets.filter(x => !x.ok).length + pairs.filter(x => !x.ok).length, nets, pairs};
    });
    return {document_id: doc.id, units: "mm", groups: groups.length, failing_groups: groups.filter(g => !g.ok).length, ...page(groups, a)};
  }

  // ---------------------------------------------------------------- pours
  // The Pours panel's actions (pour-manager.js): settings first (one pour or several), then the
  // action. repour (default) repours all pours, or the given ones and the pours after them on their
  // layers; repour_stale the stale, unpoured and failed ones; shelve / restore (the given pours, else
  // every pour; a restored pour repours); move_up / move_down the pour order; list changes nothing.
  // Every action returns the panel's rows (state, islands, dead islands, area, refill).
  const POUR_SETTINGS = {name: "name", net: "net", layer: "layer", connect_style: "connectStyle", clearance: "clearance", min_prim_length: "minWidth",
    fill: "fill", remove_dead_copper: "removeIslands", island_area: "islandArea", neck_width: "neckWidth", arc_approximation: "arcApproximation",
    locked: "locked", shelved: "enabled"};
  function pour(a) {
    const PP = need("AtriumPolygonPour", "pcb/polygon-pour.js"), M = need("AtriumPourManager", "pcb/pour-manager.js"), p = mutable(), doc = board(p, a.document_id), defs = defsOf(p);
    const polygons = doc.items.filter(i => i.kind === "polygon"), action = a.action || "repour";
    if (!polygons.length) fail("This board has no polygon pours.");
    if (a.polygon_ids) for (const id of a.polygon_ids) if (!polygons.some(x => x.id === id)) fail("No polygon has the ID " + id + ".");
    const ids = a.polygon_ids || null;
    const summary = () => M.rows(doc, defs, {project: p}).map(r => ({id: r.id, name: r.name, net: r.net, layer: r.layer, pour_order: r.priority, state: r.state === "poured" ? "current" : r.state,
      ...(r.reason ? {reason: r.reason} : {}), fill: r.fill, connect_style: r.connectStyle, clearance: r.clearance, remove_dead_copper: r.removeIslands, island_area: r.islandArea,
      neck_width: r.neckWidth || null, arc_approximation: r.arcApproximation, min_prim_length: r.minWidth, locked: r.locked, shelved: !r.enabled && !r.cutout,
      islands: r.islands, dead_islands: r.dead, area: round(r.area, 4)}));
    let changed = 0;
    if (a.settings && Object.keys(a.settings).length) {
      if (!ids) fail("Name the pours to change (polygon_ids).");
      for (const [k, v] of Object.entries(a.settings)) {
        const key = POUR_SETTINGS[k] || fail("Unknown pour setting " + k + ". Settings: " + Object.keys(POUR_SETTINGS).join(", ") + ".");
        for (const id of ids) { M.setField(doc, id, key, key === "enabled" ? !v : v); changed++; }
      }
    }
    if (action === "list") return {document_id: doc.id, polygons: polygons.length, pours: summary()};
    if (action === "move_up" || action === "move_down") {
      if (!ids) fail("Name the pours to move (polygon_ids).");
      if (M.move(doc, ids, action === "move_up" ? -1 : 1)) changed++;
      if (changed) touched();
      return {document_id: doc.id, polygons: polygons.length, changed, pours: summary()};
    }
    let only = ids;
    if (action === "shelve" || action === "restore") {
      const done = M.shelve(doc, ids, action === "shelve");
      changed += done.length;
      if (action === "shelve" || !done.length) { if (changed) touched(); return {document_id: doc.id, polygons: polygons.length, changed, [action === "shelve" ? "shelved" : "restored"]: done, pours: summary()}; }
      only = done;
    } else if (action === "repour_stale") {
      const f = PP.failures(doc), st = new Set(PP.stale(doc, defs, {project: p}));
      only = polygons.filter(x => !x.cutout && !x.shelved && (st.has(x.id) || f[x.id])).map(x => x.id);
      if (!only.length) return {document_id: doc.id, polygons: polygons.length, regions: (doc.pcbDrawing?.pours || []).length, poured: [], pours: summary(), up_to_date: true};
    } else if (action !== "repour") fail("Unknown pour action " + action + ".");
    // Given IDs: those pours and the poured pours after them on their layers (Repour Selected).
    const r = only ? PP.repourOne(doc, defs, only, {project:p}) : PP.apply(doc, defs, {project:p});
    touched();
    const per = Object.entries(r.stats.polygons || {}).map(([id, s]) => ({id, regions: r.regions.filter(x => x.polygon === id).length, ...Object.fromEntries(Object.entries(s).filter(([, v]) => typeof v === "number").map(([k, v]) => [k, round(v, 1)])),
      ...(s.failed ? {failed: s.failed} : {})}));
    return {document_id: doc.id, polygons: polygons.length, regions: r.regions.length, dropped_imported: r.droppedImported || 0, ms: Math.round(r.stats.ms), poured: per,
      ...(r.repoured ? {repoured: r.repoured} : {}), ...(action === "restore" ? {restored: only} : {}), ...(r.failed?.length ? {failed: r.failed} : {}), pours: summary()};
  }

  // ---------------------------------------------------------------- multichannel
  // Copy Room Formats: a reference room's placement and routing onto the other channel
  // rooms. plan runs on a scratch copy, so sync (adding channel footprints and rooms first)
  // can be previewed too.
  function replicateLayout(a) {
    const M = need("AtriumMultichannel", "schematic/multichannel.js"); need("AtriumRooms", "pcb/rooms.js");
    const apply = a.mode === "proposal" || a.mode === "write", p = apply ? mutable() : JSON.parse(JSON.stringify(project()));
    const doc = board(p, a.document_id), defs = defsOf(p);
    let sync = null;
    if (a.sync) {
      const s = M.syncPlan(p, doc.id, defs);
      M.applySync(p, s);
      sync = {added: s.add.length, updated: s.update.length, rooms: s.rooms.length, issues: s.issues.slice(0, 50)};
    }
    const plan = M.replicatePlan(p, doc.id, defs, {reference: a.reference, targets: a.targets, routing: a.routing, replaceRouting: a.replace_routing,
      skipLocked: a.skip_locked, copyShape: a.copy_shape});
    if (apply) { M.applyReplicate(p, plan, defs); touched(); } else if (sync) touched();
    return {document_id: doc.id, reference: plan.referenceName, summary: M.replicateSummary(plan), totals: plan.totals, issues: M.replicateIssues(plan), sync,
      rooms: plan.rooms.map(r => ({room: r.name, placed: r.placed, tracks: r.tracks, vias: r.vias, polygons: r.polygons, replaced: r.removed,
        unmatched: r.unmatched, locked: r.locked, different_footprint: r.footprints, not_in_reference: r.extra, unmapped_nets: r.unmappedNets,
        net_conflicts: r.conflicts, skipped: r.skipped}))};
  }

  // ---------------------------------------------------------------- routing
  // Each router returns an edit plan {add, remove, modify?} that is applied to
  // the working copy, so the proposal lists exactly the new tracks and vias.
  function endpoint(doc, defs, end, name) {
    if (!end) fail("Give the connection's " + name + " point.");
    if (end.component != null) {
      const part = doc.items.find(i => i.kind === "part" && (i.id === end.component || i.ref === end.component)) || fail("No component " + end.component + " is on this board.");
      const pads = defs.get(part.def)?.footprint?.pads || [];
      const pad = end.pad != null ? pads.find(x => String(x.number) === String(end.pad)) : pads.length === 1 ? pads[0] : null;
      if (!pad) fail(end.pad != null ? part.ref + " has no pad " + end.pad + "." : "Name the pad of " + part.ref + ".");
      const layer = globalThis.AtriumPCBAppearance?.padLayer?.(part, pad);
      return {at: Atrium.world([pad.x, pad.y], part), net: part.pinNets?.[pad.number] || "", layer: end.layer || (/^(Top|Bottom|Inner \d+)$/.test(layer || "") ? layer : null)};
    }
    if (typeof end.x !== "number" || typeof end.y !== "number") fail("Give the " + name + " point as a component pad or x and y in mm.");
    return {at: [end.x, end.y], net: "", layer: end.layer || null};
  }
  function applyPlan(doc, plan) {
    const add = plan.add || [];
    if (globalThis.AtriumRouter?.apply) AtriumRouter.apply(doc, plan);
    else {
      if (plan.remove?.length) { const gone = new Set(plan.remove); doc.items = doc.items.filter(i => !gone.has(i.id)); }
      doc.items.push(...add);
    }
    return {tracks: add.filter(i => i.kind === "track").length, vias: add.filter(i => i.kind === "via").length,
      removed: (plan.remove || []).length, modified: (plan.modify || []).length};
  }
  function route(a) {
    const R = need("AtriumRouter", "pcb/router.js"), p = mutable(), doc = board(p, a.document_id), defs = defsOf(p);
    const from = endpoint(doc, defs, a.from, "start"), to = endpoint(doc, defs, a.to, "end");
    if (from.net && to.net && from.net !== to.net && a.net == null) fail("The two pads are on different nets (" + from.net + ", " + to.net + ").");
    const net = a.net ?? (from.net || to.net), layer = a.layer || from.layer || to.layer || "Top";
    const o = {from: from.at, to: to.at, net, layer, budgetMs: a.time_limit_ms ?? 2000};
    if (a.width != null) o.width = a.width;
    const r = R.route(doc, defs, o);
    if (!r.ok) fail("No route was found (" + (r.status || "blocked") + ").");
    const counts = applyPlan(doc, r.plan);
    touched();
    return {document_id: doc.id, net, layer, method: r.method, length: round(r.length), ...counts, ms: Math.round(r.ms)};
  }
  function autoroute(a) {
    const AR = need("AtriumAutorouter", "pcb/autorouter.js"), p = mutable(), doc = board(p, a.document_id), defs = defsOf(p);
    const strategy = AR.STRATEGIES.find(x => x.id === (a.strategy || (AR.boardLayers(doc, defs).length > 2 ? "multi" : "default2"))) || fail("Unknown strategy " + a.strategy + ".");
    const scope = {};
    if (a.nets) scope.nets = a.nets;
    if (a.components) scope.components = a.components.map(c => doc.items.find(i => i.kind === "part" && (i.id === c || i.ref === c))?.id || fail("No component " + c + " is on this board."));
    /* autorouter-v2 */ const engine = a.engine === "v2" ? "v2" : "v1";
    const plan = engine === "v2"
      ? need("AtriumAutorouterV2", "pcb/autorouter-v2.js").routeBoard(doc, defs, {project: p, scope, layers: a.layers, fanout: strategy.fanout ? undefined : false,
        router: {timeLimit: a.time_limit_ms ?? 30000, ...(strategy.router.gridDiv ? {gridDiv: strategy.router.gridDiv} : {}), ...(strategy.router.vias === false ? {vias: false} : {})}})
      : AR.routeBoard(doc, defs, {project: p, scope, layers: a.layers, fanout: !!strategy.fanout,
        router: {...strategy.router, timeLimit: a.time_limit_ms ?? 30000}});
    const counts = applyPlan(doc, plan);
    touched();
    const r = plan.report || {};
    return {document_id: doc.id, strategy: strategy.id, engine, quality: r.quality ? {bends_per_connection: round(r.quality.bendsPerConnection), oct45: round(r.quality.oct45), acute: r.quality.acute} : undefined,
      routed: r.routed, connections: r.total, length: round(r.length), ...counts,
      failures: (r.failures || []).slice(0, 50).map(f => ({net: f.net, from: f.fromLabel, to: f.toLabel, reason: f.reason})),
      unrouted: (r.failures || []).length, passes: r.passes, notes: r.notes || [], ms: Math.round(r.ms || 0)};
  }
  function fanout(a) {
    const F = need("AtriumFanout", "pcb/fanout.js"), p = mutable(), doc = board(p, a.document_id), defs = defsOf(p);
    const components = a.components && a.components.map(c => doc.items.find(i => i.kind === "part" && (i.id === c || i.ref === c))?.id || fail("No component " + c + " is on this board."));
    const fn = (a.engine === "v2" && F.planV2) /* fanout-v2 */ || F.plan || F.headless || F.run || fail("AtriumFanout has no headless entry point.");
    const options = {project: p, components, auto: !components};
    if (a.style) options.style = a.style;
    if (a.direction) options.direction = a.direction;
    if (a.via_placement) options.viaPlacement = a.via_placement;
    const plan = fn.call(F, doc, defs, options);
    const counts = applyPlan(doc, plan);
    touched();
    return {document_id: doc.id, ...counts, report: plan.report ?? null};
  }

  // ---------------------------------------------------------------- translation worker
  // The host loads these modules in a disposable process. The source paths are labels used
  // for grouping and references; the worker has no project or generated-file handles.
  function translationInput({name, path, data}) {
    const raw = atob(data), bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return {name, path, bytes};
  }
  function translatedImport(translator, options, body) {
    const files = JSON.parse(body).map(translationInput);
    for (const {bytes,name} of files) AtriumObsoleteProject.reject(bytes,name);
    if (options.boundSource) {
      const bound = AtriumTranslators.detect(files[0].name, files[0].bytes);
      if (bound?.group !== "design" || translator != null && translator !== bound.id)
        fail("Select the importer for the bound EDA source. An alternate writer belongs in target_format.");
      translator = bound.id;
    }
    const {model, report, provenance} = AtriumTranslators.import(files, {...options, translator});
    const source = {files: (provenance.files || []).map(({name, path, sha256, documents, library}) => ({name, path, sha256, documents, library}))};
    const head = {name: model.name, documents: [], library: model.library.length,
      notes: provenance.notes || [], report, provenance: source};
    // Transfer source bytes once as binary-safe base64. JSON would expand a typed array
    // to an object with one property per byte and break source-assisted writers.
    head.folder_provenance = {...provenance, files: (provenance.files || []).map(({bytes, ...identity}) => identity)};
    const pairing = provenance.pairing;
    if (pairing) head.library_pairing = {components: pairing.components, paired: pairing.paired,
      symbol_only: pairing.symbolOnly, footprint_only: pairing.footprintOnly,
      ambiguous: pairing.ambiguous.length, unmatched: pairing.unmatched.length, pin_pad_mismatches: pairing.mismatches.length};
    if (provenance.sourceRules?.length) head.source_rules = provenance.sourceRules;
    if (!model.documents.length && !model.library.length) return [head, ""];
    const p = model;
    const placeholder = globalThis.AtriumImportLink?.placeholder || Atrium.sheet;
    if (!p.documents.some(d => d.kind === "schematic")) p.documents.unshift(placeholder("schematic", "Schematic"));
    if (!p.documents.some(d => d.kind === "pcb")) p.documents.push(placeholder("pcb", "Board layout"));
    const count = (d, kind) => d.items.filter(i => i.kind === kind).length;
    head.name = p.name;
    head.notes = p.importNotes || head.notes;
    head.documents = p.documents.map(d => ({id: d.id, kind: d.kind, name: d.name, source: d.sourceName || null,
      items: d.items.length, parts: count(d, "part"),
      ...(d.kind === "pcb" ? {tracks: count(d, "track"), vias: count(d, "via"), pours: count(d, "polygon")} : {wires: count(d, "wire")})}));
    const saved = JSON.stringify(Atrium.validate(p)) + "\n";
    if (saved.length > 256 * 1024 * 1024) fail("The imported project is larger than 256 MB.");
    return [head, saved];
  }
  function translate(a, body, companion) {
    const {translator, options} = a;
    if (a.direction === "import") return translatedImport(translator, options, body);
    if (companion) {
      const selected = JSON.parse(companion);
      if (Array.isArray(selected)) {
        const originals = new Map();
        for (const file of selected) {
          const {bytes} = translationInput(file);
          if (AtriumSourceFile.sha256(bytes) !== file.sha256) fail("An original differs from its verified digest.");
          originals.set(file.sha256, bytes);
        }
        for (const group of Array.isArray(options.provenance) ? options.provenance : [options.provenance]) {
          for (const file of group.files || []) {
            const bytes = originals.get(file.sha256);
            if (!bytes || file.byteLength != null && bytes.length !== file.byteLength) fail("A retained original could not be verified.");
            file.bytes = bytes;
          }
        }
      } else options.original = translationInput(selected);
    }
    const model = JSON.parse(body);
    const r = AtriumTranslators.export(translator, a.imported ? AtriumImportExport.snapshot(model) : model, options);
    return translatedSet(r.files, {details: r.details || {}, report: r.report,
      ...(a.imported ? {summary: AtriumImportExport.summary(r.report), formatLabel: AtriumImportExport.formatName(translator,r.details?.edition)} : {})});
  }
  function translatedSet(files, head) {
    S.translated = files;
    return {...head, files: files.map(f => ({name: f.name, binary: f.bytes != null}))};
  }
  function translatedFile(a) {
    const f = S.translated?.[a.index] || fail("This translated file is unavailable.");
    S.translated[a.index] = null;
    return [{}, f.bytes == null ? f.text.replace(/[\ud800-\udfff]/gu, "\ufffd") : latin1(f.bytes)];
  }

  // The editor's renderer drawing into a recording context (svg-canvas.js).
  // style "assembly" draws the fabrication assembly view instead.
  function notebookOutputModules(request) {
    const p=project(), a=request.args || {};
    let ids=a.document_id ? [a.document_id] : a.documents;
    if (request.op==="render" && !a.document_id) return {modules:[]}; // the default rendering target is the board
    if (["output_job_plan","release_run"].includes(request.op)) {
      const job=AtriumOutputJobs.resolve(p,a.definition ?? a.job ?? fail("Name a job set (job) or pass a definition."),a);
      return {modules:AtriumNotebookOutput.job(p,job.outputs), gerber:job.outputs.some(o => o.enabled !== false &&
        (o.kind === "gerber" || a.odbEnabled === true && o.kind === "odb")),
        odb:job.outputs.some(o=>o.enabled!==false&&o.kind==="odb"),
        ...(request.op === "output_job_plan" ? {translators:AtriumOutputJobs.translatorNeeds(job,a)} : {})};
    }
    if (request.op==="kicad" || request.op==="altium") return {modules:AtriumNotebookOutput.foreign(p,a)};
    const modules=AtriumNotebookOutput.roots(p,ids);
    // The SVG and PDF notebook paths share physical glyph metrics and a recording canvas.
    if (modules.length && request.op==="render") modules.push("print");
    return {modules};
  }

  function render(a) {
    const p = variantOf(project(), a), doc = a.document_id != null ? documentFor(p, a.document_id, null) : board(p), defs = defsOf(p), name = doc.name.replace(/[\\/:*?"<>|]/g, "-");
    if (a.style === "assembly") {
      const F = need("AtriumFabOutputs", "formats/fab-outputs.js"), side = a.side || "Top";
      if (doc.kind !== "pcb") fail("Choose a PCB document ID for an assembly view.");
      const r = F.assembly(F.analyse(p, doc.id), side, F.settle({date: dateOf(a.date)}));
      return [{name: name + "-Assembly-" + side + ".svg", kind: "assembly", stats: r.stats || {}}, r.content];
    }
    const C = need("AtriumCanvas", "canvas/canvas.js"), SVG = need("AtriumSVGCanvas", "svg-canvas.js");
    let b = a.region;
    if (!b) {
      b = doc.kind === "pcb" && doc.outline?.length >= 3 ? Atrium.bounds(doc.outline) : Atrium.docBounds(doc, defs);
      if (!b) fail("This document is empty.");
      const m = Math.max(b[2] - b[0], b[3] - b[1]) * 0.03;
      b = [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
    }
    const w = Math.max(1e-3, b[2] - b[0]), h = Math.max(1e-3, b[3] - b[1]);
    const width = a.width || 1600, height = Math.max(16, Math.min(8000, Math.round(width * h / w)));
    const notebook = doc.kind==="schematic" && globalThis.AtriumNotebookOutput?.roots(p,[doc.id]).length;
    if (notebook) globalThis.AtriumNotebookFonts?.registerPDF?.(AtriumPDF);
    const rec = notebook ? AtriumPDF.recorder(width,height) : SVG.create(width,height);
    const view = C.create(rec.canvas), scale = Math.min(width / w, height / h);
    view.restoreCamera({cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2, scale, referenceScale: scale});
    const hidden = new Set(a.hidden_layers || []);
    const V = globalThis.AtriumVariants, nf = V ? V.notFittedBoxes(p, doc) : [];
    const calculations = notebook && globalThis.AtriumCalculationRecords?.forOutput(p);
    const notebookProjection = notebook ? {purpose:"print",print:true,assets:new Map(),calculationRecords:calculations?.sheet(doc) || new Map(),
      widgetViews:globalThis.AtriumSheetWidgets?.views(p,doc,{defs,purpose:"print",calculation:calculations?.lookup})} : {};
    view.render(doc, defs, {project: p, ...notebookProjection, grid: false, origin: false, hidden, showUnrouted: a.airwires !== false, selectedIds: new Set(a.highlight || []),
      overlay: nf.length ? [(ctx, o) => V.paint(ctx, nf, o.scale, doc.kind)] : undefined});
    return [{name: name + (a.region ? "-region" : "") + ".svg", kind: doc.kind, width, height, region: b.map(v => round(v, 3)), elements: notebook ? rec.list.length : rec.elements}, notebook ? AtriumPDF.svg(width,height,rec.list) : rec.svg()];
  }

  // Printing and PDF (print.js): sheets and board layer sets as one vector PDF with
  // cross-reference links and bookmarks. Without a date the bytes are reproducible.
  function exportPdf(a) {
    const PR = need("AtriumPrint", "formats/print.js"), p = variantOf(project(), a), o = {attachments:true};
    if (a.date != null) o.date = dateOf(a.date);
    for (const [k, v] of [["documents", "documents"], ["layer_sets", "layerSets"], ["paper", "paper"], ["orientation", "orientation"], ["scale", "scale"],
      ["infinite_layout", "infiniteLayout"], ["infinite_scale", "infiniteScale"],
      ["margin", "margin"], ["color", "color"], ["white_background", "whiteBackground"], ["links", "links"], ["bookmarks", "bookmarks"],
      ["footer", "footer"], ["parameters", "parameters"], ["viewer_layers","viewerLayers"], ["properties","properties"],
      ["searchable","searchable"], ["attachments","attachments"]]) if (a[k] !== undefined) o[v] = a[k];
    const r = PR.build(p, o), bytes = r.bytes();
    let body = "";
    for (let i = 0; i < bytes.length; i += 8192) body += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return [{name: String(p.name || "Waffle").replace(/[\\/:*?"<>|]/g, "-") + ".pdf", binary: true, notes: r.notes, links: r.links, variant: variantName(p),
      pages: r.pages.map(x => ({title: x.title, kind: x.kind, document_id: x.doc, layer_set: x.set, width_mm: round(x.w * 25.4 / 72, 1), height_mm: round(x.h * 25.4 / 72, 1)}))}, body];
  }

  // Drawing documents (drawing.js): fabrication and assembly drawings kept live against the board.
  // export_drawing writes their sheets as one vector PDF with an embedded Unicode font; edit_drawing
  // creates a drawing or applies operations (views, dimensions, notes, callouts, revisions).
  function exportDrawing(a) {
    const DR = need("AtriumDrawing", "formats/drawing.js"), p = variantOf(project(), a), o = {date: a.date != null ? dateOf(a.date) : null};
    if (a.drawings) o.documents = a.drawings;
    if (a.paper) o.paper = a.paper;
    if (a.color) o.color = a.color;
    const r = DR.build(p, o), bytes = r.bytes(), P = globalThis.AtriumPDF;
    let body = "";
    for (let i = 0; i < bytes.length; i += 8192) body += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    const docs = [...new Set(r.pages.map(x => x.doc))], first = p.documents.find(d => d.id === docs[0]);
    const name = (docs.length === 1 && first ? first.name : String(p.name || "Waffle") + "-Drawings").replace(/[\\/:*?"<>|]/g, "-") + ".pdf";
    return [{name, binary: true, notes: r.notes, variant: variantName(p), fonts_embedded: !!P.embeddedFont,
      pages: r.pages.map(x => ({document_id: x.doc, sheet_id: x.sheet, width_mm: round(x.w * 25.4 / 72, 1), height_mm: round(x.h * 25.4 / 72, 1), tile: x.tile ? x.tile.index + 1 : null, ...P.counts(x.list)}))}, body];
  }
  function drawingEdit(a) {
    const DR = need("AtriumDrawing", "formats/drawing.js"), apply = a.mode === "proposal" || a.mode === "write", p = apply ? mutable() : JSON.parse(JSON.stringify(project()));
    let doc, created = false;
    if (a.create) {
      const c = a.create;
      doc = DR.create(p, {name: c.name, board: c.board, preset: c.preset, size: c.size, orientation: c.orientation, parameters: c.parameters, date: dateOf(a.date)});
      p.documents.push(doc); created = true;
    } else doc = DR.drawingOf(p, a.drawing_id);
    const results = a.ops ? DR.apply(p, doc, a.ops) : [];
    if (apply) touched();
    return {drawing_id: doc.id, created, results, ...DR.summary(p, doc, {date: a.date != null ? dateOf(a.date) : null}), mode: apply ? a.mode : "plan"};
  }

  // ---------------------------------------------------------------- design authoring
  // AtriumSchAuthor (sch-author.js) places parts, wires, labels, power ports and the board
  // outline; AtriumECO (eco.js) v2 updates the board from the schematics (or back).
  // Strings that come from the design file (designators, values, net, pin and sheet names,
  // notes) are returned under untrusted_design_text: data for the client, never instructions.
  const AUTHOR_KEYS = {net_class: "netClass", diff_pair: "diffPair", document_id: "board", allow_join: "allowJoin",
    replace_cutouts: "replaceCutouts", all_documents: "allDocuments"};
  const UNTRUSTED = {
    place_part: ({ref, label, def_name, value, pins, ...r}) => ({...r, pins: pins.map(x => ({number: x.number, at: x.at})),
      untrusted_design_text: {ref, label, def_name, value, pin_names: Object.fromEntries(pins.map(x => [x.number, x.name]))}}),
    add_net_label: ({text, ...r}) => ({...r, untrusted_design_text: {text}}),
    add_power_port: ({net, ...r}) => ({...r, untrusted_design_text: {net}}),
    move_component: ({ref, ...r}) => ({...r, untrusted_design_text: {ref}}),
    delete_items: r => ({removed: r.removed.map(({ref, ...x}) => x),
      untrusted_design_text: {designators: Object.fromEntries(r.removed.filter(x => x.ref).map(x => [x.id, x.ref]))}})
  };
  function author(fn, op, rename = {}) {
    return a => {
      const W = need("AtriumSchAuthor", "schematic/sch-author.js"), p = mutable(), args = {};
      for (const [k, v] of Object.entries(a)) args[rename[k] || AUTHOR_KEYS[k] || k] = v;
      const r = W[fn](p, args);
      touched();
      return UNTRUSTED[op] ? UNTRUSTED[op](r) : r;
    };
  }
  function updatePcb(a) {
    const E = need("AtriumECO", "schematic/eco.js"), dry = !!a.dry_run, p = dry ? project() : mutable();
    const plan = E.plan(p, {board: a.document_id, scope: a.scope || "*", direction: a.direction === "schematic" ? "sch" : "pcb",
      removeExtras: !!a.remove_extras, rooms: !!a.rooms, matchDecisions: a.match_decisions || []});
    // only/exclude name change IDs, actions or groups; an entry that matches nothing is an error.
    const keys = new Set(plan.changes.flatMap(c => [c.id, c.action, c.group])), known = new Set([...Object.keys(E.ACTIONS), ...E.GROUPS]);
    for (const k of [...(a.only || []), ...(a.exclude || [])]) if (!keys.has(k) && !known.has(k)) fail("update_pcb: " + JSON.stringify(k) + " is not a change ID, action or group of this ECO.");
    let select = null;
    if (a.only || a.exclude) {
      const only = a.only && new Set(a.only), exclude = new Set(a.exclude || []);
      const hit = (s, c) => s.has(c.id) || s.has(c.action) || s.has(c.group);
      select = new Set(plan.changes.filter(c => (only ? hit(only, c) : c.selected) && !hit(exclude, c)).map(c => c.id));
      for (const c of plan.changes) c.selected = select.has(c.id);
    }
    const report = dry || plan.review.pending ? E.validate(p, plan, select) : E.execute(p, plan, select);
    if (!dry && report.applied) touched();
    const state = new Map(report.rows.map(r => [r.id, r])), groups = {};
    for (const c of plan.changes) {
      const g = groups[c.group] || (groups[c.group] = {total: 0, selected: 0, done: 0, failed: 0});
      g.total++; if (c.selected) g.selected++;
      const s = state.get(c.id)?.state; if (s === "done") g.done++; if (s === "failed") g.failed++;
    }
    const rows = plan.changes.filter(c => !a.failed_only || state.get(c.id)?.state === "failed").map(c => {
      const st = state.get(c.id), r = {id: c.id, group: c.group, action: c.action, selected: !!c.selected, state: st?.state || null};
      if (c.origin) r.origin = c.origin; if (c.use) r.use = c.use; if (c.ignored) r.ignored = true;
      if (c.conflict) r.conflict = {untrusted_design_text: {schematic: c.conflict.schematic ?? null, board: c.conflict.board ?? null, base: c.conflict.base ?? null}};
      if (c.action === "addComponent") { r.component_id = c.partId; r.at = c.at; }
      r.untrusted_design_text = {object: c.object, before: c.before ?? null, after: c.after ?? null, ...(st?.message ? {message: st.message} : {})};
      return r;
    });
    return {document_id: plan.board, direction: a.direction || "pcb", dry_run: dry, valid: !report.error && (dry ? !!report.valid : report.failed === 0),
      ...(report.error ? {error: report.error} : {}), changes: plan.changes.length, applied: report.applied, failed: report.failed, skipped: report.skipped,
      held: report.held, groups, clusters: (plan.clusters || []).map(c => ({bounds: c.bounds.map(v => round(v, 3)), components: c.ids.length})),
      untrusted_design_text: {issues: plan.issues, ...(plan.review.sources.length ? {component_review: plan.review} : {}), sheets: (plan.clusters || []).map(c => c.sheetName)}, ...page(rows, {offset: a.offset, limit: a.limit ?? 200})};
  }
  const AUTHOR_OPS = {place_part: author("placePart", "place_part"), add_wire: author("addWire", "add_wire"), add_net_label: author("addNetLabel", "add_net_label"),
    add_power_port: author("addPowerPort", "add_power_port"), set_board_outline: author("setBoardOutline", "set_board_outline"),
    move_component: author("moveComponent", "move_component"), delete_items: author("deleteItems", "delete_items", {document_id: "document"}), update_pcb: updatePcb};

  // ---------------------------------------------------------------- editor commands (headless-parity)
  // AtriumCommandsHeadless (app/automation/commands-headless.js) runs on a copy that replaces the working
  // copy only when the command succeeds; plan runs on a scratch copy and counts the changes.
  function editorCommand(a) {
    const C = need("AtriumCommandsHeadless", "automation/commands-headless.js");
    const kind = C.kind(a.command, a.args);
    if (!kind) fail("Unknown command " + a.command + ".");
    const wrap = (out, extra) => Array.isArray(out) ? [{result: out[0], kind, ...extra}, out[1]] : {result: out, kind, ...extra};
    if (kind === "read") return wrap(C.run(project(), a.command, a.args));
    const copy = JSON.parse(JSON.stringify(project())), out = C.run(copy, a.command, a.args);
    Atrium.validate(copy);
    if (a.plan) return wrap(out, {changes: AtriumProposal.build(S.base, copy, {allowV1: false}).ops || 0});
    S.work = copy; touched();
    return wrap(out);
  }

  const butterJobs = new Map();
  let nextButterJob = 0;
  let butterWorkspace;
  const butterError = error => ({error:String(error?.message || error), code:error?.code || "tool_failed"});
  function butterCommand(a) {
    const B = need("AtriumButter", "automation/command-broker.js"), P = AtriumProposal, p = project(), revision = S.version;
    if (!butterWorkspace || butterWorkspace.id !== p.id) butterWorkspace = {id:p.id, scope:{}};
    const scope = butterWorkspace.scope, enabledFeatures = new Set(a.enabled), enabled = feature => enabledFeatures.has(feature);
    const sourceRevision = S.work ? a.sourceRevision + ":" + revision : a.sourceRevision;
    const signal = {aborted:false}, loads = new Map(), ready = new Set(), media = {};
    const current = () => !signal.aborted && p === project() && revision === S.version;
    const unavailable = () => Object.assign(Error("This command is unavailable to MCP macros."), {code:"unsupported_surface"});
    function printInput(kind, request) {
      if (!current() || media.pending) throw Error("The PDF preparation request is no longer current.");
      return new Promise((resolve,reject) => { media.pending = {kind,request,resolve,reject}; });
    }
    async function planNested(id, args, input = {}) {
      if (!current() || !Object.hasOwn(a.nested, id))
        throw unavailable();
      const [feature, spec] = a.nested[id];
      B.check(spec,args,"mcp-macro","plan",false);
      if (!ready.has(id)) {
        let load = loads.get(id);
        if (!load) {
          load = {};
          load.promise = new Promise((resolve,reject) => Object.assign(load,{resolve,reject}));
          loads.set(id, load);
        }
        await load.promise;
      }
      if (!current()) throw unavailable();
      return B.invoke(feature,spec,args,{source:"macro",surface:"mcp-macro",mode:"plan",scope,sourceRevision,revision,isCurrent:current,signal,enabled,
        project:input.project ?? p,documentId:input.documentId,selection:input.selection}, B.requireSuccess);
    }
    function complete({command, result, mode}, {ops, file, commit, failure}) {
      if (!current()) return {error:"The design revision changed during this Butter command.", code:"stale_source"};
      if (a.pipeline && failure) return {error:failure.message, code:failure.code};
      const head = {result, changes:ops?.length ?? 0};
      if (ops?.length) {
        const plan = P.guarded(p, command, ops), prepared = P.prepare(p, plan, Atrium.validate);
        if (mode !== "plan") {
          S.work = prepared.project; touched();
          if (!a.pipeline && p === S.base)
            S.checkedButter = {ops, itemPositions:prepared.itemPositions,
              incremental:!!prepared.itemPositions && ops.every(op => !P.equal(op.before, op.after) &&
                (op.target === "item" || op.target === "project" && op.path.length === 1 && op.path[0] === "name"))};
        }
      }
      let body;
      if (file) {
        const payload = B.filePayload(file);
        head.name = file.name;
        head.binary = file.binary === true;
        if (head.binary) {
          const parts = [];
          for (let at = 0; at < payload.length; at += 8192) parts.push(String.fromCharCode(...payload.subarray(at, at + 8192)));
          body = parts.join("");
        } else body = payload;
      }
      commit();
      if (mode === "read") B.report(scope,a.spec,a.args,{command,result,mode});
      return body === undefined ? head : [head, body];
    }
    try {
      if (butterJobs.size >= 16) return {error:"Too many pending Butter commands.", code:"resource_limit"};
      const native = a.pdfImages ? {...a.native,prepareImage:request => printInput("image",request),
        loadNotebookModules:names => names.length ? printInput("modules",names) : undefined} : a.native;
      const out = B.invoke(a.feature, a.spec, a.args, {project:p, revision, source:"mcp", mode:a.mode, scope,
        sourceRevision, allowWrite:a.allowWrite === true, signal, isCurrent:current, native, enabled, plan:planNested}, complete);
      if (!out?.then) return out;
      const id = ++nextButterJob, job = {signal,loads,ready,unavailable,media};
      butterJobs.set(id, job);
      out.then(value => {job.result = value;}, error => {job.result = butterError(error);});
      return butterPending(id, job);
    } catch (error) {return butterError(error);}
  }
  function butterRecord({spec, args, receipt}) {
    if (butterWorkspace) globalThis.AtriumButter?.report(butterWorkspace.scope, spec, args, receipt);
    return {};
  }
  function butterPending(id, job) {
    const pending = job.media.pending;
    return {pendingButter:id, commandModule:job.loads.keys().next().value,
      imageRequest:pending?.kind === "image" ? pending.request : undefined,
      printModules:pending?.kind === "modules" ? pending.request : undefined};
  }
  function butterResult({id, cancel, commandModule, unavailable, image, printModules}) {
    const job = butterJobs.get(id);
    if (!job) return {error:"The Butter command request is unavailable.", code:"unsupported_command"};
    if (cancel) {
      job.signal.aborted = true;
      for (const load of job.loads.values()) load.reject(job.unavailable());
      job.media.pending?.reject(Error("Image preparation cancelled."));
      butterJobs.delete(id);
      return {};
    }
    if (commandModule !== undefined && job.loads.has(commandModule)) {
      const load = job.loads.get(commandModule);
      job.loads.delete(commandModule);
      if (unavailable) load.reject(job.unavailable());
      else {job.ready.add(commandModule); load.resolve();}
    }
    if (printModules && job.media.pending?.kind === "modules") {
      const pending = job.media.pending;
      delete job.media.pending;
      pending.resolve();
    }
    if (image && job.media.pending?.kind === "image") {
      const pending = job.media.pending;
      delete job.media.pending;
      if (image.error) pending.reject(Error(image.error));
      else {
        const bytes = data => Uint8Array.from(atob(data), c => c.charCodeAt(0));
        const {width,height,rgb,alpha} = image;
        pending.resolve({bitmap:{width,height,rgb:bytes(rgb),...(alpha && {alpha:bytes(alpha)})}});
      }
    }
    if (!job.result && typeof globalThis.drainMicrotasks === "function") globalThis.drainMicrotasks();
    if (!job.result) return butterPending(id, job);
    butterJobs.delete(id);
    return job.result;
  }

  // ---------------------------------------------------------------- results
  function proposal(a) {
    if (!S.work) return [{ops: 0}];
    if (!S.checkedButter) Atrium.validate(S.work);
    const built = AtriumProposal.build(S.base, S.work, {source_sha256: S.digest, tool: a.tool, summary: a.summary ?? null,
      allowV1:S.checkedButter ? false : a.allow_v1, ops:S.checkedButter?.ops});
    if (!built.proposal) return [{ops: 0}];
    return [{ops: built.ops, version: built.proposal.version, summary: built.summary,
      owners: AtriumProposal.memberOwners(built.proposal)}, JSON.stringify(built.proposal, null, 2) + "\n"];
  }
  function saveFolder(a) {
    if (!S.work) fail("There are no changes to save.");
    const folder = need("AtriumMCPFolder", "project/folder-project.js").saved();
    if (folder.version !== S.digest) fail("The folder snapshot differs from the current edit base.");
    // The saved manifest's header determines validation of this edit, including script edits.
    const mode = folder.manifest.project.atriumCompat;
    if (mode) S.work.atriumCompat = {...mode};
    else delete S.work.atriumCompat;
    if (!S.checkedButter) Atrium.validate(S.work);
    const built = AtriumProposal.build(S.base, S.work, {allowV1:false, ops:S.checkedButter?.ops});
    if (!built.ops) return [{ops: 0}];
    let plan;
    try {plan = need("AtriumMCPFolderSave", "folder-save.js").plan(folder, S.base, S.work, a.manifest, built.proposal.ops, S.checkedButter?.itemPositions);}
    catch (error) {
      if (error.code === "read-only-format") return [{read_only_format:error.message}];
      if (error.code !== "read-only-revision" && error.code !== "read-only") throw error;
      return [{read_only_revision: error.message}];
    }
    return [{ops: built.ops, summary: built.summary, incremental:!!S.checkedButter?.incremental}, JSON.stringify(plan)];
  }
  function commit(a) {
    if (!S.work) fail("There are no changes to keep.");
    S.base = S.work; S.work = null; S.digest = a.digest; S.baseCache.clear(); touched();
    return {digest: S.digest, calculationDocuments:calculationSheets(S.base)};
  }
  function commitButter(a, body) {
    if (!S.checkedButter?.incremental || S.digest !== a.previous || !S.work)
      fail("The Butter saved receipt no longer belongs to the working copy.");
    const installed = JSON.parse(body), documents = new Map(installed.documents.map(d=>[d.id,d]));
    const previous = S.base;
    S.base = {...previous, documents:previous.documents.map(d=>documents.get(d.id) ?? d)};
    if (typeof installed.name === "string") S.base.name = installed.name;
    globalThis.AtriumSignals?.attach(S.base);
    S.work = null; S.digest = a.digest; S.baseCache.clear(); touched();
    return {digest:S.digest};
  }
  function reset() { if (S.work) { S.work = null; touched(); } S.fab = null; return {}; }
  function release() { S.base = S.work = S.digest = null; S.baseCache.clear(); touched(); return {}; }
  function exportProject() { return [{digest: S.digest, working: !!S.work}, JSON.stringify(project())]; }
  function adopt(a, body) {
    const next = Atrium.validate(JSON.parse(body));
    if (!S.base) fail("Load the saved project first.");
    S.work = next; touched();
    return {};
  }
  function applyProposal(a, body) {
    const proposal = JSON.parse(body), P = AtriumProposal, p = project();
    if (proposal.source_sha256 !== S.digest) fail("The saved project changed since this proposal was drafted. Generate a fresh proposal.");
    if (a.write) {
      const copy = JSON.parse(JSON.stringify(p)), defs = defsOf(copy);
      P.applyChecked(copy, proposal, {validate:Atrium.validate, trial:false, transform:(d, i, props) => Atrium.transformPart(d, i, defs.get(i.def), props)});
      S.work = copy; touched(); return {};
    }
    let total, items;
    if (proposal.version === 1) {
      const rows = P.inspectV1(proposal, p); total = rows.length;
      items = rows.slice(a.offset, a.offset + a.limit).map(({row}) => ({document:row.document, id:row.id, field:row.field, before:row.before, after:row.after}));
    } else {
      items = P.inspect(proposal, p, a.limit, a.offset).map(r => ({index:r.index, label:r.label, detail:r.detail}));
      total = proposal.ops.length;
    }
    return {total, next_offset:a.offset + items.length < total ? a.offset + items.length : null, untrusted_design_text:{items}};
  }

  function checkProposal(a, body) {
    const copy = JSON.parse(JSON.stringify(S.base)), proposalData = JSON.parse(body);
    const n = AtriumProposal.apply(copy, proposalData);
    return {applied: n, equal: AtriumProposal.equal(copy, S.work || S.base), serialized_equal: AtriumProposal.equal(copy, S.work || S.base)};
  }

  // ---------------------------------------------------------------- library
  // AtriumLibrary (library-panel.js) and AtriumFootprintWizard do the work; these ops
  // only adapt arguments and results. Editing ops change the working copy.
  const defSummary = d => ({def_id: d.id, name: d.name, prefix: d.prefix || "", value: d.value || "", footprint: d.footprint?.name || null,
    pins: d.symbol?.pins?.length || 0, pads: (d.footprint?.pads || []).filter(p => !p.thermalVia).length, gates: d.symbol?.parts || 1});
  const issueRows = list => list.map(x => ({level: x.level, code: x.code, message: x.message}));
  function libraryCreateFootprint(a) {
    const L = need("AtriumLibrary", "library/library-panel.js"), W = need("AtriumFootprintWizard", "library/footprint-wizard.js");
    if (a.batch != null) {
      // CSV/TSV batch (footprint wizard parseBatch): every good row becomes a library definition; bad rows are reported.
      const p = mutable(), rows = W.parseBatch(String(a.batch)), out = [];
      for (const {row, spec} of rows) {
        const {family, preset, density, name, ...dims} = spec;
        try {
          const r = L.createFootprint(p, {family, ...(preset ? {preset} : {}), density: density || "B", dims: {...(a.round_off != null ? {roundOff: a.round_off} : {}), ...dims}, ...(name ? {footprint_name: name} : {}), add_symbol: a.add_symbol !== false});
          out.push({row, ok: true, def_id: r.def.id, name: r.def.footprint.name, pads: r.def.footprint.pads.filter(x => !x.thermalVia).length, errors: r.issues.filter(x => x.level === "error").length});
        } catch (e) { out.push({row, ok: false, error: e.message}); }
      }
      if (out.some(r => r.ok)) touched();
      return {batch: out, added: out.filter(r => r.ok).length, failed: out.filter(r => !r.ok).length};
    }
    const p = mutable(), r = L.createFootprint(p, a), fp = r.def.footprint, i = fp.ipc || {};
    touched();
    return {...defSummary(r.def), ipc_name: i.name || null, family: i.family || null, density: i.density || null, round_off: i.roundOff ?? null, Z: i.Z ?? null, G: i.G ?? null, X: i.X ?? null,
      land: i.padLength != null ? {length: i.padLength, width: i.X, centre: i.padCentre} : null, courtyard: fp.courtyard || null, height: fp.height ?? null,
      flagged: i.flagged || [], added: r.report.added, parts_updated: r.report.parts, issues: issueRows(r.issues), warnings: r.report.warnings};
  }
  function libraryCreateSymbol(a) {
    const L = need("AtriumLibrary", "library/library-panel.js"), p = mutable(), r = L.createSymbol(p, a);
    touched();
    return {...defSummary(r.def), added: r.report.added, parts_updated: r.report.parts, wires_followed: r.report.rewired, warnings: r.report.warnings,
      pin_list: r.def.symbol.pins.slice(0, 500).map(x => ({number: x.number, name: x.name, type: L.ELECTRICAL[x.electrical ?? 4], side: x.orientation, gate: x.part || 0, hidden: !!x.hidden}))};
  }
  function libraryValidate(a) {
    const L = need("AtriumLibrary", "library/library-panel.js"), p = project();
    if (a.all) {
      // Library health of the whole project library (library-store.js).
      const r = need("AtriumLibraryStore", "library/library-store.js").health(p.library, {project: p});
      return {ok: !r.counts.error, counts: r.counts, components: p.library.filter(d => !d.mirrorOf).length,
        issues: r.issues.slice(0, 500).map(x => ({level: x.level, code: x.code, def_id: x.def})),
        untrusted_design_text: {issues: r.issues.slice(0, 500).map(x => ({def_id: x.def, name: x.name, message: x.message}))}};
    }
    const def = a.def || p.library.find(d => d.id === a.def_id || d.name === a.def_id) || fail("The library has no definition " + a.def_id + ".");
    const v = L.validateDef(def);
    return {ok: v.ok, errors: v.errors, warnings: v.warnings, footprint_checks: def.footprint ? issueRows(L.checkFootprint(def.footprint)) : [],
      ...(def.id ? {def_id: def.id} : {}), name: def.name ?? null};
  }
  function libraryUpdateParts(a) {
    const L = need("AtriumLibrary", "library/library-panel.js"), p = mutable();
    const def = p.library.find(d => d.id === a.def_id || d.name === a.def_id) || fail("The library has no definition " + a.def_id + ".");
    const sources = a.include_copies ? L.similar(p, def).map(d => d.id) : [];
    const r = L.updateParts(p, def, {sources});
    touched();
    return {def_id: def.id, name: def.name, parts: r.parts, retargeted: r.retargeted, wires_followed: r.rewired, stale_pin_nets: r.dropped, values: r.values,
      copies: sources.length};
  }

  const OPS = {load, notebook_output_modules: notebookOutputModules, folder_project: (a, body) => need("AtriumMCPFolder", "project/folder-project.js").run(a, body),
    constraints: a => need("AtriumConstraints", "checks/constraints.js").headless(a, {project, mutable, board, defsOf, touched, page}), via_stubs: viaStubs, drc_waivers: drcWaivers, rule_sets: ruleSets, library_create_footprint: libraryCreateFootprint, library_create_symbol: libraryCreateSymbol,
    library_validate: libraryValidate, library_update_parts: libraryUpdateParts, info, erc, drc, rules_list: rulesList, rule_get: ruleGet, rule_change: ruleChange,
    panelize, fab_file: fabFile, output_jobs: outputJobs, translated_job: translatedJob, fab_done: () => { S.fab = null; return {}; }, bom, bom_optimise: bomOptimise, annotate,
    stackup_get: stackupGet, stackup_change: stackupChange, impedance_plan: impedancePlan, net_lengths: netLengths, matched_lengths: matchedLengths, pour,
    route, autoroute, fanout, replicate_layout: replicateLayout, command: editorCommand,
    butter_command:butterCommand, butter_result:butterResult, butter_record:butterRecord,
    ...AUTHOR_OPS, notebook_modules:a=>({names:AtriumNotebook.required([project()],{docId:a.document_id,itemId:a.item_id}).map(row=>row.name)}),
    list_notebook:a=>AtriumNotebook.read(project(),{docId:a.document_id,itemId:a.item_id,offset:a.offset||0,limit:Math.min(500,a.limit||100)}), translate, translated_file: translatedFile, render, export_pdf: exportPdf, export_drawing: exportDrawing, drawing_edit: drawingEdit, proposal, save_folder: saveFolder, commit, commit_butter:commitButter, reset, release, export: exportProject, adopt, apply_proposal:applyProposal, check_proposal: checkProposal};

  const calculationReads=new Map();
  let nextCalculation=0;
  OPS.calculation_cancel = a=>{
    const job=calculationReads.get(a.id);
    if (job) {job.signal.aborted=true;calculationReads.delete(a.id);}
    return {};
  };
  OPS.calculation_result = a=>{
    const job=calculationReads.get(a.id);
    if (!job) return fail("The calculation request is unavailable.");
    if (!job.current()) {OPS.calculation_cancel(a);return fail("The design revision changed during the calculation.");}
    // The standalone JavaScriptCore shell reads RPC frames synchronously.
    // Its embedding API drains after each call, and the Node transport yields below.
    if (!job.done && typeof globalThis.drainMicrotasks==="function") globalThis.drainMicrotasks();
    if (!job.done) return {pendingCalculation:a.id};
    calculationReads.delete(a.id);
    if (job.error) return fail(job.error);
    return job.result;
  };
  OPS.calculate = a => {
    if (a.calculator != null) return need("AtriumCalc", "analysis/calculators.js").headless(a, {project, board});
    const engine = need("AtriumCalculations", "notebook/calculations.js"), p = project();
    const documents = p.documents.filter(d => d.kind === "schematic" && (!a.document_id || d.id === a.document_id));
    const revision = S.work ? S.digest + ":" + S.version : S.digest;
    const doc=a.block_id==null ? documents[0] : documents.find(d=>d.items.some(i=>i.id===a.block_id && globalThis.AtriumCalculationRecords.isBlock(i)));
    if (!doc) return fail(a.block_id==null ? "Choose a schematic sheet." : "The calculation block does not exist on the requested sheet.");
    const options={documentId:doc.id,instanceId:a.instance_id,revision};
    function evaluate(countSnapshot) {
      if (a.block_id!=null) {
        const result=engine.evaluateSnapshot(p,{...options,blockId:a.block_id,countSnapshot});
        return {revision,records:result.records};
      }
      return {documentId:doc.id,...engine.evaluateExpressionSnapshot(p,{...options,source:a.expression,countSnapshot})};
    }
    const service=globalThis.AtriumDesignQuery, missing=new Map(), receipts=new Map();
    const key=(source,c)=>JSON.stringify([c.documentId,c.instanceId,source]);
    const result=evaluate((source,c)=>{
      const value=service?.countSnapshot(source,c);
      if (!value || value.complete===false && value.diagnostic?.code==="incomplete") missing.set(key(source,c),{source,context:c});
      else receipts.set(key(source,c),value);
      return value;
    });
    if (!missing.size) return result;
    if (!service) return {loadCalculationQuery:true};
    if (calculationReads.size>=16) return fail("Too many calculation reads are pending.");
    const id=++nextCalculation, version=S.version, current=()=>S.version===version && project()===p;
    const job={done:false,current,signal:{aborted:false}};
    calculationReads.set(id,job);
    (async()=>{
      for (const [k,read] of missing) {
        if (job.signal.aborted || !current()) return fail("The design calculation was cancelled.");
        receipts.set(k,await service.count(read.source,{...read.context,isCurrent:current,signal:job.signal,yieldTask:()=>Promise.resolve()}));
      }
      if (!current()) return fail("The design revision changed during the calculation.");
      return evaluate((source,c)=>receipts.get(key(source,c)));
    })().then(value=>{job.result=value;job.done=true;},error=>{job.error=String(error?.message || error);job.done=true;});
    return {pendingCalculation:id};
  };
  OPS.si_analysis = a => need("AtriumSI", "analysis/si.js").headless(a, {project, board, defsOf, page}); // SI-lite
  // High-speed suite: xSignals (wizard, classes, pin delays), routing topology, 2D field solver.
  OPS.xsignals = a => need("AtriumXSignals", "pcb/xsignals.js").headless(a, {project, mutable, board, defsOf, touched, page});
  // Signals and tags (signals.js, signals-panel.js; docs/design/signal-model.md §11).
  OPS.signals = a => need("AtriumSignalsPanel", "editor/signals-panel.js").headless(a, {project, mutable, board, touched, page});
  // Route Suggestions (read-only): the best legal completion of a connection and its alternatives, as a proposal plan.
  OPS.suggest_route = a => {
    const E = need("AtriumRouteSuggestEngine", "pcb/route-suggest-engine.js"), p = project(), doc = board(p, a.document_id), defs = defsOf(p);
    const from = endpoint(doc, defs, a.from, "start"), to = endpoint(doc, defs, a.to, "end");
    if (from.net && to.net && from.net !== to.net && a.net == null) fail("The two pads are on different nets (" + from.net + ", " + to.net + ").");
    const net = a.net ?? (from.net || to.net), Hb = globalThis.AtriumRouteHabits;
    let bias = {};
    if (Hb && a.habits !== false) { const rules = AtriumRouter.core.rulesFor(doc, {}, p), layers = E.routingLayers(doc, defs, rules, net), prof = Hb.fromBoard(doc, defs, {project: p}); if (prof.routes >= 3) bias = Hb.bias(prof, Hb.classOf(doc, net, p), layers); }
    const r = E.suggest(doc, defs, {net, from: from.at, to: to.at, fromLayer: a.layer || from.layer || to.layer || "Top", bias, budgetMs: a.time_limit_ms ?? 1500, alternatives: a.alternatives !== 0, shove: a.shove !== false}, {project: p});
    if (!r.ok) fail("No legal suggestion (" + (r.reason || "blocked") + ").");
    const list = r.alternatives.slice(0, Math.max(1, a.alternatives ?? 4));
    return {document_id: doc.id, net, read_only: true, ms: Math.round(r.ms), alternatives: list.map((x, i) => {
      const plan = E.toPlan(x, {net, makeId: (() => { let n = 0; return () => "suggest-" + i + "-" + (++n); })()});
      return {rank: i + 1, kind: x.kind, label: x.label, length: round(x.length), vias: x.viaCount, bends: x.bends, layers: x.layers, reasons: x.reasons,
        proposal: {add: plan.add, modify: plan.modify, remove: plan.remove}};
    })};
  };
  OPS.topology = a => need("AtriumTopology", "pcb/topology.js").headless(a, {project, mutable, board, defsOf, touched, page});
  OPS.field_solve = a => {
    const FS = need("AtriumFieldSolver", "analysis/field-solver.js"), I = globalThis.AtriumImpedance;
    let geom = {...(a.geometry || {})};
    if (a.layer) {
      const p = project(), doc = board(p, a.document_id), ST = need("AtriumStackup", "pcb/stackup.js");
      const g = need("AtriumImpedance", "analysis/impedance.js").geometry(ST.get(doc, defsOf(p)).layers, a.layer);
      if (!g) fail("Layer " + a.layer + " has no impedance geometry in the stack-up.");
      geom = {...g, ...geom};
    }
    const plainOf = v => JSON.parse(JSON.stringify(v, (k, x) => ArrayBuffer.isView(x) ? Array.from(x) : x));
    const r = a.target ? FS.synthesize(geom, {target: a.target, vary: a.vary || "w"}) : FS.solve(geom, {quality: a.quality, fGHz: a.f_ghz, roughness: a.roughness, dispersion: a.dispersion});
    let cf = null; try { const c = I?.solve?.(r?.geom || geom); if (c?.ok !== false) cf = {z: c.z, eeff: c.eeff, zdiff: c.zdiff ?? null}; } catch { cf = null; }
    return {geometry: geom, units: {length: "mm", z: "ohm", delay: "ps/mm", loss: "dB/mm"}, result: plainOf(r), closed_form: cf};
  };
  // Signal Integrity extension (extensions/si), headless: the same engine and the same read-only
  // simulation.* API reads the extension uses, with the field solver run synchronously. Read-only.
  OPS.si_simulate = a => {
    const E = need("AtriumSIEngine", "extensions/si/engine.js"), IB = need("AtriumIBIS", "extensions/si/ibis.js"), FS = need("AtriumFieldSolver", "analysis/field-solver.js");
    const p = project(), doc = board(p, a.document_id);
    if (typeof a.net !== "string" || !a.net) fail("si_simulate needs a net.");
    const api = need("AtriumAPI", "core/atrium-api.js").headless(p, {documentId: doc.id, extension: {id: "mcp.si", permissions: {"read:project": true}}});
    const call = (m, args) => { const v = api.call(m, args, false); if (v && typeof v.then === "function") fail(m + " needs a module this build did not load."); return v; };
    const crosstalk = a.crosstalk !== false, gap = Math.min(5, Math.max(0.05, Number(a.gap_mm) || 0.5));
    const first = call("simulation.channel", [a.net, {doc: doc.id, neighbours: crosstalk ? gap + 0.3 : 0}]), recs = [first];
    for (let hop = 0, frontier = [first]; hop < 2 && recs.length < 4; hop++) {
      const next = [];
      for (const r of frontier) for (const n of E.seriesNets(r, recs.map(x => x.net))) if (recs.length < 4) { const c = call("simulation.channel", [n, {doc: doc.id}]); recs.push(c); next.push(c); }
      frontier = next;
    }
    const sim = call("simulation.get", []), cache = new Map();
    const library = key => { if (!cache.has(key)) { const m = call("simulation.model", [key]); cache.set(key, m ? IB.parse(m.text, {name: m.name}) : null); } return cache.get(key); };
    const plan = E.plan({nets: recs, library, assign: sim.assign || {}, driver: a.driver || undefined});
    const freq = Number(a.frequency_mhz) > 0 ? Number(a.frequency_mhz) * 1e6 : 100e6;
    const opts = {corners: Array.isArray(a.corners) && a.corners.length ? a.corners : ["typ", "min", "max"], loss: a.loss !== false, crosstalk: crosstalk ? {maxGap: gap, maxVictims: 4} : null,
      stimulus: {type: a.stimulus || "rise", freq}};
    const solved = new Map();
    for (const j of E.solveList(plan, opts)) {
      const r = FS.solve(j.geometry, {quality: j.quality || "normal", fGHz: j.fGHz});
      solved.set(j.key, {ok: r.ok !== false, error: r.error || null, z0: r.z0 ?? r.z, z: r.z, zodd: r.zodd, zeven: r.zeven, eeff: r.eeff, eeffOdd: r.eeffOdd, eeffEven: r.eeffEven, delay: r.delay, alpha_c: r.alpha_c, alpha_d: r.alpha_d});
    }
    const res = E.simulate(plan, solved, opts), out = E.summary(res, {waves: !!a.waves});
    if (a.sweep === "series" || a.sweep === "parallel") out.sweep = E.drain(E.sweep(plan, solved, {kind: a.sweep, sim: {...opts, stimulus: {type: "rise"}}}));
    out.units = {time: "s", voltage: "V", length: "mm", z: "ohm"};
    return out;
  };
  OPS.pdn_analyze = a => need("AtriumPDN", "analysis/pdn.js").headless(a, {project, board, defsOf, page}); // PDN Analyzer (DC drop)
  OPS.thermal_map = a => need("AtriumThermal", "analysis/thermal.js").headless(a, {project, board, defsOf}); // Temperature Rise Map (estimate)
  OPS.current_capacity_check = a => need("AtriumIPC2152", "analysis/ipc2152.js").headless(a, {project, board, defsOf}); // IPC-2152 current capacity
  OPS.stress_check = a => need("AtriumStress", "analysis/stress.js").headless(a, {project, page}); // component stress
  for (const op of ["library_folder_update", "library_import"]) OPS[op] = (a, body) => need("AtriumLibrarySources", "library/library-sources.js").headless(op, a, body, {project, mutable, touched}); // folder libraries, library import
  OPS.symbol_from_table = a => need("AtriumSymbolWizard", "library/symbol-wizard.js").headless(a, {project, mutable, touched}); // Symbol Wizard (create_symbol_from_table)
  OPS.footprint_wizard = a => need("AtriumFootprintWizard", "library/footprint-wizard.js").headless(a); // read-only: list / describe / generate / batch
  OPS.generic_part = a => need("AtriumGenericParts", "library/generic-parts.js").headless(a.op, a.args || {}, {project, mutable, touched}); // generic parts (place/edit/list_generic_parts)
  OPS.support_place = a => need("AtriumSupportPlace", "editor/support-placement.js").headless(a, {project, mutable, board, touched}); // sync-placement
  OPS.review_comments = a => need("AtriumReviewComments", "history/review-comments.js").headless(a, {project, mutable, touched, page}); // review comments (review.py)
  for (const op of ["release_plan", "release_run", "release_file", "release_done", "list_releases"]) OPS[op] = a => need("AtriumRelease", "formats/release.js").headless(op, a, {project, board, dateOf, text, state: S}); // releases (release.js)
  for (const op of ["fab_presets_list", "fab_preset_apply"]) OPS[op] = a => need("AtriumFabPresets", "formats/fab-presets.js").headless(op, a, {project, mutable, touched}); // fab-presets
  OPS.dfm_check = a => need("AtriumDFM", "checks/dfm.js").headless(a, {project}); // fab-presets
  OPS.list_insights = a => need("AtriumInsights", "checks/insights.js").headless(a, {project}); // Design Insights (read-only advice)
  // Unified checks (app/checks/checks.js): view and waive findings from the same batch as run_drc.
  for (const op of ["check", "waive", "waivers"]) OPS[op] = a => need("AtriumChecks", "checks/checks.js").headless(op, a,
    {project, mutable, touched, drcOf:(doc, options) => drcOf(doc, {...options, antennae:true})});
  for (const [op, g, f] of [["autoplace", "AtriumAutoplace", "pcb/autoplace.js"], ["route_plan", "AtriumRoutePlanner", "pcb/route-planner.js"], ["plane_plan", "AtriumPlanePlanner", "pcb/plane-planner.js"]]) OPS[op] = a => need(g, f).headless(a, {project, mutable, board, defsOf, touched, page}); // AI placement, routing, planes
  OPS.read_netlist = a => {
    const d = need("AtriumNetlistText","schematic/netlist-text.js").compile(project(), {board:a.document_id});
    const lines = d.text.split("\n"); lines.pop();
    const start = Math.min(a.line_offset || 0,lines.length), end = Math.min(start+(a.line_limit ?? lines.length),lines.length);
    const raw = start === 0 && end === lines.length ? d.text : start < end ? lines.slice(start,end).join("\n")+"\n" : "";
    return [{source:d.source, document_id:d.board, counts:d.counts, total_lines:lines.length, next_offset:end < lines.length ? end : null,
      untrusted_design_text:{issues:d.issues.slice(0,100)}}, raw];
  };
  OPS.validate_netlist = (a, body) => {
    const {diagnostics,...summary} = need("AtriumNetlistText","schematic/netlist-text.js").validate(body,{matrix:AtriumERC.settings(project()).matrix});
    return {...summary, untrusted_design_text:{diagnostics}};
  };
  // MCP authoring v2, netlists and multi-routing (mcp/authoring.js, app/schematic/netlist.js, app/pcb/multi-route.js).
  for (const op of ["mcad_status", "mcad_import", "mcad_export"]) OPS[op] = (a, body) => need("AtriumMCADHeadless", "formats/mcad.js").headless(op, a, {project, mutable, touched, board, defsOf}, body); // ECAD-MCAD (mcp/mcad.js)
  for (const op of ["find_parts", "place_part_v2", "connect", "import_netlist", "multi_route", "route_bus"]) OPS[op] = (a, body) => need("AtriumAuthorV2", "authoring.js")
    .headless(op.replace(/_v2$/, ""), a, {project, mutable, touched, page, board, defsOf, author: AUTHOR_OPS, endpoint, applyPlan}, body);
  // Materialise affected fields on a detached copy before a working edit can
  // be reported, proposed or saved. Projects without bindings skip this path.
  let numericJob;
  OPS.numeric_settlement = ({cancel}={}) => {
    if(cancel) {
      if(numericJob)numericJob.signal.aborted=true;
      numericJob=null;
      return {};
    }
    if(!numericJob) {
      if(!S.work?.numericExpressions?.length)return {};
      const original=S.work,revision=S.version,signal={aborted:false};
      const ops=S.checkedButter?.ops ?? AtriumProposal.diff(S.base,original);
      const copy=JSON.parse(JSON.stringify(original));
      const job=numericJob={signal};
      const finish=error=>{job.done=true;job.error=error && String(error.message || error);};
      need("AtriumNumericFields","editor/numeric-fields.js").settle(copy,ops,signal).then(changed=>{
        if(signal.aborted || S.work!==original || S.version!==revision)throw Error("The design revision changed during numeric field updates.");
        if(changed) {
          Atrium.validate(copy,{normalize:false});
          S.work=copy;touched();
        } else AtriumNumericFields.copyIssues(copy,original);
      }).then(()=>finish(),finish);
    }
    if(!numericJob.done && typeof globalThis.drainMicrotasks==="function")globalThis.drainMicrotasks();
    if(!numericJob.done)return {pendingNumeric:true};
    const {error}=numericJob;numericJob=null;
    return error ? {error} : {};
  };
  return function AtriumHeadless(headerText, body, companion) {
    const h = JSON.parse(headerText), fn = OPS[h.op] || fail("Unknown headless operation " + h.op + ".");
    const before=S.version, out = fn(h.args || {}, body, companion);
    const [head, raw] = Array.isArray(out) ? out : [out];
    const entries=S.work?.numericExpressions;
    if(h.op!=="numeric_settlement" && before!==S.version && Array.isArray(entries) && entries.length)
      head.updateNumericFields=entries.some(entry=>entry?.target?.path?.[0]==="cells") ? ["numeric-fields","table-data"] : ["numeric-fields"];
    return raw == null ? JSON.stringify(head) : JSON.stringify(head) + "\n" + raw;
  };
})();

// ---------------------------------------------------------------- scripts
// Runs in its own context, created for one script and then discarded.
// With the scripting module, AtriumScripting owns the one job map. This adapter
// starts through headlessStart and projects the raw settled value through finish
// (AtriumHeadlessScriptTake), so a large project is not parsed twice. The promise
// settles between calls because JavaScriptCore drains microtasks when each API
// call returns.
// Without it, the code runs synchronously as a strict function body with
// `project`, `Waffle`, `api` and `console` in scope, editing `project` in place.
(() => {
  const lineOf = l => typeof l === "string" ? l : (l.level === "info" || l.level === "log" ? "" : l.level + ": ") + l.text;
  function finish(v, omitUnchanged) {
    const error = v.ok === false || v.error ? String(v.error?.message || v.error || "The script failed.") : null;
    const head = {log: (v.log || []).map(lineOf), error, result: v.result ?? null};
    if (v.transactions != null) head.transactions = v.transactions;
    if (v.error?.line) head.line = v.error.line;
    // Only the SDK host counts committed transactions. The direct-model fallback always sends its model.
    if (omitUnchanged && v.ok === true && !error && v.project && v.transactions === 0) head.unchanged = true;
    return error || !v.project || head.unchanged ? JSON.stringify(head) :
      JSON.stringify(head) + "\n" + (typeof v.project === "string" ? v.project : JSON.stringify(v.project));
  }
  globalThis.AtriumHeadlessScriptTake = function(id) {
    const project = globalThis.AtriumScripting?.headlessProject;
    if (typeof project !== "function") return JSON.stringify({log: [], error: "Unknown script job.", result: null});
    const raw = project(id);
    if (typeof raw === "string") return raw;
    if (raw?.pending != null) return JSON.stringify({pending: Number(raw.pending)});
    return raw == null ? JSON.stringify({log: [], error: "Unknown script job.", result: null}) : finish(raw, false);
  };
  globalThis.AtriumHeadlessScript = function(headerText, projectText) {
    const h = JSON.parse(headerText), S = globalThis.AtriumScripting;
    if (typeof S?.runHeadless === "function" && typeof S.headlessStart === "function" && typeof S.headlessProject === "function") {
      const omitUnchanged = h.omitUnchanged === true;
      const id = S.headlessStart(JSON.stringify({code: h.code, timeoutMs: h.timeoutMs, args: h.args ?? null}), projectText, value => finish(value, omitUnchanged));
      return globalThis.AtriumHeadlessScriptTake(id);
    }
    const log = [], project = JSON.parse(projectText);
    const write = (level, args) => {
      if (log.length >= 2000) return;
      log.push({level, text: args.map(v => typeof v === "string" ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })()).join(" ").slice(0, 4000)});
    };
    const sink = Object.freeze({log: (...a) => write("info", a), info: (...a) => write("info", a), warn: (...a) => write("warn", a), error: (...a) => write("error", a)});
    try {
      globalThis.console = sink;
      const result = new Function("project", "Waffle", "api", "console", "args", "\"use strict\";\n" + h.code)(project, globalThis.Atrium, globalThis.AtriumAPI, sink, h.args ?? null);
      if (result && typeof result.then === "function") return finish({ok: false, log, error: "Without the scripting module, scripts must finish synchronously."});
      let shown = null;
      try { shown = result === undefined ? null : JSON.parse(JSON.stringify(result)); } catch { shown = String(result); }
      return finish({ok: true, log, result: shown, project});
    } catch (e) {
      return finish({ok: false, log, error: e && e.message ? e.message : String(e)});
    }
  };
})();

// ---------------------------------------------------------------- Node worker
if (typeof module !== "undefined" && typeof require === "function" && require.main === module) {
  const fs = require("node:fs"), crypto = require("node:crypto");
  const {readFrame, writeExact} = require("./pipe-frames.js");
  globalThis.crypto ??= crypto.webcrypto;
  const send = writeExact;
  const frames = () => {
    const frame = readFrame();
    if (!frame) return null;
    const args = [frame.slots[0]];
    // An empty before snapshot still occupies its slot when an after snapshot follows it.
    if (frame.lengths[1] || frame.lengths[2]) args.push(frame.slots[1]);
    if (frame.lengths[2]) args.push(frame.slots[2]);
    return {args, large: frame.large};
  };
  try {
    if (Number(process.versions.node.split(".")[0]) < 18) throw Error("Node.js 18 or later is required.");
    if (process.argv[2] === "--translate") {
      try {
        const {args} = frames(), request = JSON.parse(args[0]);
        for (const file of request.modules) require(file);
        const head = globalThis.AtriumHeadless(...args);
        if (request.streamOutput) {
          const {files} = JSON.parse(head);
          send(head + "\n");
          args.length = 0;
          for (const [index, file] of files.entries()) {
            const part = globalThis.AtriumHeadless(JSON.stringify({op: "translated_file", args: {index}}));
            const bytes = Buffer.from(part.slice(part.indexOf("\n") + 1), file.binary ? "latin1" : "utf8");
            const length = Buffer.allocUnsafe(4);
            length.writeUInt32LE(bytes.length);
            send(length);
            send(bytes);
          }
        } else send(head);
      } catch (error) {
        send(JSON.stringify({error: error.message || String(error)}) + "\n");
        process.exitCode = 1;
      }
    } else if (process.argv[2] === "--sandbox") {
      // One script per process, inside a fresh V8 context with a time limit. node:vm is NOT a
      // security boundary: Python refuses this path unless ATRIUM_ALLOW_NODE_SCRIPTS=1, starts Node
      // with its permission model, and kills the process at a wall-clock deadline. Microtasks run
      // inside each runInContext call ("afterEvaluate"), so `await null; for (;;) {}` meets the timeout.
      const vm = require("node:vm"), frame = frames(), request = JSON.parse(frame.args[0]);
      const context = vm.createContext({__waffleUUIDSeed: crypto.randomBytes(10).toString("hex")}, {microtaskMode: "afterEvaluate"}),
        limit = request.timeoutMs || 10000, started = Date.now();
      for (const file of [__filename, ...request.modules]) vm.runInContext(fs.readFileSync(file, "utf8"), context, {filename: file});
      context.__header = frame.args[0]; context.__project = frame.args[1];
      (async () => {
        let text = vm.runInContext("AtriumHeadlessScript(__header, __project)", context, {timeout: limit});
        while (/^\{"pending":/.test(text) && Date.now() - started < limit) {
          await new Promise(resolve => setImmediate(resolve));
          context.__job = JSON.parse(text.split("\n")[0]).pending;
          text = vm.runInContext("AtriumHeadlessScriptTake(__job)", context, {timeout: Math.max(1, limit - (Date.now() - started))});
        }
        if (/^\{"pending":/.test(text)) text = JSON.stringify({log: [], error: "The script did not finish within its time limit.", result: null});
        return text;
      })().then(text => send(JSON.stringify({text}) + "\n"), error => {
        const message = /timed out/i.test(error?.message) ? "The script exceeded its time limit of " + limit / 1000 + " s." : error?.message || String(error);
        send(JSON.stringify({error: message}) + "\n");
      });
    } else {
      const loaded = new Set();
      // The ordinary reader uses a blocking pipe. Yield between polls so an exact
      // design count can finish its bounded batches in this same read-only session.
      async function serve() {
        let frame;
        while ((frame = frames())) {
          let line, pending=false;
          try {
            const request = JSON.parse(frame.args[0]);
            for (const file of request.modules || []) if (!loaded.has(file)) { require(file); loaded.add(file); }
            const fn = globalThis[request.entry || "AtriumBoardReport"];
            const text = fn(...frame.args);
            pending = request.entry==="AtriumHeadless" && /^\{"pending(?:Calculation|Butter)":/.test(text);
            line = request.entry === "AtriumBoardReport" || !request.entry ? '{"result":' + text + "}" : JSON.stringify({text});
          } catch (error) { line = JSON.stringify({error: error.message || String(error)}); }
          if (frame.large) { frame.args.length = 0; global.gc?.(); }
          send(line + "\n");
          if (pending) await new Promise(resolve=>setImmediate(resolve));
        }
      }
      serve().catch(error=>{process.stderr.write(error?.message || String(error));process.exitCode=1;});
    }
  } catch (error) { process.stderr.write(error?.message || String(error)); process.exitCode = 1; }
}
