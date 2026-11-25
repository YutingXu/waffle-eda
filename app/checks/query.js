"use strict";
// @ts-ignore CommonJS entry point. Browser and worker loaders declare these files.
if (typeof module!=="undefined" && typeof require==="function") {
  if (!globalThis.AtriumQueryExchange) require("./query-exchange.js");
  if (!globalThis.AtriumDesignQuery) require("./design-query.js");
}
// Query language and the Filter panel (Panels › Filter, F12), in the spirit of Altium's
// query expressions. A hand-written tokenizer and recursive-descent parser build a small
// AST of the classic spelling. The shared design-query compiler owns all executable predicates.
//
// Grammar (keywords and names are case-insensitive):
//   expr    := or
//   or      := and { ("Or" | "||") and }
//   and     := not { ("And" | "&&") not }
//   not     := ("Not" | "!") not | compare
//   compare := operand [ ("=" | "==" | "<>" | "!=" | "<" | "<=" | ">" | ">=" | "Like") operand ]
//   operand := "(" expr ")" | name [ "(" [ value { "," value } ] ")" ] | value
//   value   := number [unit] | 'text' | "text" | True | False
//   unit    := mm | mil | mils | th | in | inch | cm | um | µm | deg
// Numbers without a unit are millimetres. Like takes * and ? wildcards. 'It''s' escapes a quote.
//
//   Predicates  All IsTrack IsArc IsVia IsPad IsComponent IsPolygon IsRegion IsFill IsText
//               IsKeepout IsWire IsBus IsNetLabel IsPort IsPowerPort IsSheetSymbol IsJunction
//               IsPin IsLocked IsThruHole IsSMD IsSMDPad IsTHPad IsTeardrop IsDiffPair InAnyNet InPolygon
//               OnTop OnBottom OnSignal OnMid OnOutside OnMultiLayer
//   Functions   InNet('x') InNetClass('x') InComponent('U1') InComponentClass('x') OnLayer('Top')
//               InDifferentialPair('x') InDifferentialPairClass('x') HasFootprint('x') OnSheet('x')
//               InxSignal('x') InxSignalClass('x')  (xSignals, xsignals.js: every net the path runs through)
//               InSignal('x') HasTag('x')  (signals.js: every net of signal x, legs, stages and bus members
//               included; a net whose signal, net or bus carries tag x. Without a signals store, signals
//               are the differential pairs and xSignals and tags are the classes of any kind)
//               InNamedPolygon('x') InRoom('x') HasPad('1') HasPad('U1', '1')
//   Built-in classes: InNetClass('All Nets') and InComponentClass('All Components') match every
//   object with a net or a component, unless the design defines a class of that name.
//   Properties  Width HoleSize Diameter Layer Net Designator Comment Footprint Name Text X Y
//               Rotation Length Kind Locked Side PinNumber Signal Polarity ('+', '-' or '')
//   e.g.  IsTrack And OnLayer('Top') And Width < 0.2mm      Comment Like '10k*'
//
// Limits: 2000 characters, 600 tokens, nesting depth 40 and an evaluation step budget, so a
// hostile expression fails fast with a QueryError and never hangs the editor or the server.
//
// Headless API (pure, DOM-free):
//   AtriumQuery.parse(text)                      -> AST (throws QueryError {message, at})
//   AtriumQuery.valid(text)                      -> boolean
//   AtriumQuery.check(text)                      -> {ok, error?, at?, normalized?}
//   AtriumQuery.run(project, doc, text, o)       -> {ids, subs:[{id, part, pin}], count, truncated}
//   AtriumQuery.matcher(text, ctx)               -> object -> boolean (design objects)
//   AtriumQuery.ruleMatcher(text, env)           -> rule object {net, span, layer, component} -> boolean
//   AtriumQuery.fromItem(doc, item)              -> a query that matches objects like this one
//   AtriumQuery.headless(project, args)          -> MCP `query` result
// UI: AtriumQuery.toggle(), apply(text, modes), applyIds(docId, ids, subs, modes), clear().
globalThis.AtriumQuery = (() => {
  const A = () => globalThis.Atrium;
  const D = globalThis.AtriumDesignQueryContext, I = globalThis.AtriumDesignQueryIndex;
  const X = globalThis.AtriumQueryExchange, Q = globalThis.AtriumDesignQuery;
  const {QueryError,tokenize,parse,print,quote,names:NAMES,limits} = globalThis.AtriumQueryExchange.reader;
  const {length:MAX_LENGTH,tokens:MAX_TOKENS,depth:MAX_DEPTH}=limits;
  const MAX_STEPS=4e7, MAX_RESULTS=250000;
  // ------------------------------------------------------------------ xSignals (hs-xsignals)
  // The board's xSignals [{name, from, to, nets?}] and xSignal classes {class: [names]} (signals.js xsView).
  // Index: byName lower(name) -> Set(lower(net)); classes lower(class) -> Set(lower(name)); classNets.
  function xsIndex(doc) {
    const t = doc && globalThis.AtriumSignals?.xsView ? AtriumSignals.xsView(doc) : null, byName = new Map(), classes = new Map(), classNets = new Map();
    if (!t) return {byName, classes, classNets};
    const parts = new Map();
    for (const i of doc.items || []) if (i.kind === "part" && i.ref) parts.set(i.ref, i);
    for (const x of t.xSignals || []) {
      if (!x?.name) continue;
      const nets = Array.isArray(x.nets) && x.nets.length ? x.nets : [parts.get(x.from?.ref)?.pinNets?.[x.from?.pin], parts.get(x.to?.ref)?.pinNets?.[x.to?.pin]];
      byName.set(String(x.name).toLowerCase(), new Set(nets.filter(Boolean).map(n => String(n).toLowerCase())));
      if (x.class) { const k = String(x.class).toLowerCase(); if (!classes.has(k)) classes.set(k, new Set()); classes.get(k).add(String(x.name).toLowerCase()); }
    }
    for (const [k, v] of Object.entries(t.xSignalClasses || {})) { const c = String(k).toLowerCase(); if (!classes.has(c)) classes.set(c, new Set()); for (const n of v || []) classes.get(c).add(String(n).toLowerCase()); }
    for (const [c, names] of classes) { const s = new Set(); for (const n of names) for (const net of byName.get(n) || []) s.add(net); classNets.set(c, s); }
    return {byName, classes, classNets};
  }

  // ------------------------------------------------------------------ names
  // Canonical spellings, keyed by lower case. Aliases map to the same canonical name.
  function check(text,c) {
    try {
      const result=checked(text,queryContext(text,c));
      if (!result.ok) {const d=result.diagnostics[0];return {...result,error:d.message,at:d.span[0]};}
      return {...result,normalized:globalThis.AtriumQueryExchange.nativeInput(text) ? text : print(parse(text))};
    } catch(e) {if (e instanceof QueryError) return {ok:false,error:e.message,at:e.at,diagnostics:[{message:e.message,span:[e.at,e.at]}]};throw e;}
  }
  const valid=text=>check(text).ok;

  // ------------------------------------------------------------------ matching helpers
  const lower = s => String(s ?? "").toLowerCase();
  // Wildcard match (* any run, ? one character), case-insensitive. Linear-time greedy
  // backtracking over one star: O(len(text) * len(pattern)) at worst, no regular expression.
  function glob(pattern, text) {
    const p = lower(pattern), t = lower(text);
    let pi = 0, ti = 0, star = -1, mark = 0;
    while (ti < t.length) {
      if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) {pi++; ti++;}
      else if (pi < p.length && p[pi] === "*") {star = pi++; mark = ti;}
      else if (star >= 0) {pi = star + 1; ti = ++mark;}
      else return false;
    }
    while (pi < p.length && p[pi] === "*") pi++;
    return pi === p.length;
  }
  // Layer names: Waffle keys ("Top", "Inner 2", "Silk") and Altium-style spellings.
  const LAYER_ALIASES = {top:"Top", toplayer:"Top", fcu:"Top", bottom:"Bottom", bottomlayer:"Bottom", bcu:"Bottom",
    topoverlay:"Silk", silk:"Silk", topsilk:"Silk", silkscreen:"Silk", topsilkscreen:"Silk", bottomoverlay:"Bottom silk", bottomsilk:"Bottom silk", bottomsilkscreen:"Bottom silk",
    topsolder:"Top mask", topmask:"Top mask", topsoldermask:"Top mask", bottomsolder:"Bottom mask", bottommask:"Bottom mask", bottomsoldermask:"Bottom mask",
    toppaste:"Top paste", bottompaste:"Bottom paste", multilayer:"Multi", multi:"Multi", mechanical:"Mechanical", keepout:"Keepout", keepoutlayer:"Keepout"};
  function layerKey(name) {
    const raw = String(name ?? "").trim(), k = raw.toLowerCase().replace(/[\s_.\-]+/g, "");
    if (Object.hasOwn(LAYER_ALIASES, k)) return LAYER_ALIASES[k];
    const m = /^(?:midlayer|mid|inner|in|internalplane|plane)(\d{1,3})$/.exec(k);
    if (m && +m[1] >= 1 && +m[1] <= 126) return "Inner " + (+m[1]);
    return raw;
  }
  function copperIndex(name) {
    if (name === "Top") return 0; if (name === "Bottom") return 127;
    const m = /^Inner (\d{1,3})$/.exec(name || ""); return m && +m[1] >= 1 && +m[1] <= 126 ? +m[1] : null;
  }
  const displayName = l => {try {return globalThis.AtriumPCBAppearance?.name?.(l) || l;} catch {return l;}};
  // Does an object on `own` (with an optional copper span) sit on the layer the query names?
  function layerMatches(own, span, want) {
    const key = layerKey(want), wl = lower(want), kl = lower(key);
    if (span) {const idx = copperIndex(key); if (idx != null) return span[0] <= idx && idx <= span[1];}
    if (own == null) return false;
    return lower(own) === kl || lower(own) === wl || lower(displayName(own)) === wl;
  }
  const same = (a, b) => a != null && b != null && lower(a) === lower(b);
  const ALL_NETS = "all nets", ALL_COMPONENTS = "all components";
  function insidePoly(p, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  const roomNamed = (rooms, name) => (Array.isArray(rooms) ? rooms : []).find(r => same(r.name, name) && Array.isArray(r.points) && r.points.length > 2) || null;
  // Altium layer groups: signal (any copper), mid (inner copper), outside (top or bottom), multi-layer.
  function layerGroup(group, layer, span) {
    if (span) {
      const single = span[0] === span[1];
      if (group === "signal") return true;
      if (group === "multi") return span[0] === 0 && span[1] === 127 && !single;
      if (group === "mid") return single && span[0] > 0 && span[0] < 127;
      return single && (span[0] === 0 || span[0] === 127);
    }
    if (layer == null) return false;
    const k = layerKey(layer), idx = copperIndex(k);
    if (group === "multi") return k === "Multi";
    if (group === "signal") return idx != null || k === "Multi";
    if (group === "mid") return idx != null && idx > 0 && idx < 127;
    return idx === 0 || idx === 127;
  }
  const GROUPS = {OnSignal:"signal", OnMid:"mid", OnOutside:"outside", OnMultiLayer:"multi"};

  // ------------------------------------------------------------------ design objects
  // An object is a document item, or a pad / pin of a component ({sub:true, part, pin, net}).
  function kindOf(o, docKind) {
    if (o.sub) return docKind === "pcb" ? "pad" : "pin";
    const i = o;
    if (docKind === "pcb") {
      if (i.keepout || /keep-?out/i.test(i.layer || "")) return "keepout";
      if (i.kind === "graphic") {
        if (i.fill && i.fillRect) return "fill";
        if (i.fill) return "region";
        return i.arc ? "arc" : "line";
      }
      if (i.kind === "track" && i.arc) return "arc";
      return i.kind;
    }
    return i.kind;
  }
  const KIND_TESTS = {
    IsTrack:k => k === "track", IsArc:k => k === "arc", IsVia:k => k === "via", IsPad:k => k === "pad", IsComponent:k => k === "part", IsPolygon:k => k === "polygon",
    IsRegion:k => k === "region", IsFill:k => k === "fill", IsText:k => k === "label" || k === "text" || k === "textframe", IsKeepout:k => k === "keepout",
    IsWire:k => k === "wire", IsBus:k => k === "bus" || k === "busentry", IsNetLabel:k => k === "netlabel", IsPort:k => k === "port" || k === "offsheet",
    IsPowerPort:k => k === "power", IsSheetSymbol:k => k === "sheetsymbol", IsJunction:k => k === "junction", IsPin:k => k === "pin" || k === "pad"
  };
  function trackLength(pts) {let s = 0; for (let k = 1; k < (pts?.length || 0); k++) s += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]); return s;}

  // Context for one document: lazily computed net maps and classes, cached per revision.
  const contexts = new WeakMap();
  function context(project, doc, o = {}) {
    const defs = o.defs || new Map((project?.library || []).map(d => [d.id, d]));
    // No revision given with the editor's defs map (it is kept across item edits): the editor's revision.
    const host = globalThis.AtriumNavHost, key = o.revision ?? (o.defs && o.defs === host?.defs?.() ? "nav:" + host.revision?.() : null);
    let c = contexts.get(doc);
    if (c && c.items === doc.items && c.length === doc.items.length && c.revision === key && c.defs === defs && c.project === project) return c;
    c = {doc, defs, project, items:doc.items, length:doc.items.length, revision:key, kind:doc.kind};
    let netMap, netClasses, pairs, ccMap, sigEnv;
    const boardOf = () => doc.kind === "pcb" ? doc : project?.documents?.find(d => d.kind === "pcb");
    // Signals (signals.js): the scope seam when the project has a signals store, else null (legacy keys).
    c.signals = () => {
      if (sigEnv !== undefined) return sigEnv;
      sigEnv = null;
      const b = boardOf();
      try { if (b && project?.signals) sigEnv = globalThis.AtriumSignals?.scopeEnv?.(b, project, {defs}) || null; } catch { sigEnv = null; }
      return sigEnv;
    };
    c.xs = () => c.signals()?.xs || (c.xsCache ??= xsIndex(boardOf() || doc));
    c.schNets = () => {
      if (netMap !== undefined) return netMap;
      netMap = null;
      if (doc.kind !== "schematic") return netMap;
      try {netMap = globalThis.AtriumHierarchy && project ? AtriumHierarchy.sheetNets(project, doc, defs) : A().connectivity(doc, defs);} catch {netMap = null;}
      return netMap;
    };
    const rulesOf = () => {
      const board = doc.kind === "pcb" ? doc : project?.documents?.find(d => d.kind === "pcb");
      if (!board) return null;
      try {if (globalThis.AtriumRules?.netClasses) return {netClasses:AtriumRules.netClasses(board, {project}), raw:AtriumRules.stored(board, project)};} catch {}
      return {netClasses:{}, raw:null};
    };
    c.netClass = name => {
      if (netClasses === undefined) {
        netClasses = new Map();
        const env = c.signals(), r = env ? null : rulesOf();
        for (const [k, v] of env ? env.classes : Object.entries(r?.netClasses || {})) netClasses.set(lower(k), new Set((v instanceof Set ? [...v] : Array.isArray(v) ? v : []).map(lower)));
      }
      return netClasses.get(lower(name)) || null;
    };
    c.pairs = () => {
      if (pairs) return pairs;
      pairs = {byNet:new Map(), classes:new Map()};
      const env = c.signals();
      if (env) {
        for (const p of env.pairs.values()) {pairs.byNet.set(lower(p.positive), p.name); pairs.byNet.set(lower(p.negative), p.name);}
        for (const [k, v] of env.pairClasses) pairs.classes.set(lower(k), new Set([...v].map(lower)));
        return pairs;
      }
      const raw = rulesOf()?.raw;
      for (const p of Array.isArray(raw?.diffPairs) ? raw.diffPairs : []) {pairs.byNet.set(lower(p.positive), p.name); pairs.byNet.set(lower(p.negative), p.name);}
      for (const [k, v] of Object.entries(raw?.diffPairClasses || {})) pairs.classes.set(lower(k), new Set((Array.isArray(v) ? v : []).map(lower)));
      return pairs;
    };
    c.componentClass = name => {
      if (ccMap === undefined) {
        ccMap = new Map();
        const CC = globalThis.AtriumComponentClasses, board = doc.kind === "pcb" ? doc : null;
        if (CC && board) try {for (const [k, v] of CC.map(board, project)) ccMap.set(lower(k), new Set([...v].map(lower)));} catch {}
        // A schematic has no component classes of its own: use the board's, by designator.
        if (CC && !board) {const b = project?.documents?.find(d => d.kind === "pcb"); if (b) try {for (const [k, v] of CC.map(b, project)) ccMap.set(lower(k), new Set([...v].map(lower)));} catch {}}
      }
      return ccMap.get(lower(name)) || null;
    };
    contexts.set(doc, c);
    return c;
  }
  function netOf(c, o) {
    if (o.sub) return c.kind === "pcb" ? o.net || "" : c.schNets()?.byPin?.get(o.ownerId + "/" + o.pin) || "";
    const i = o;
    if (c.kind === "pcb") return i.net || "";
    if (i.kind === "netlabel" || i.kind === "power" || i.kind === "port" || i.kind === "offsheet") return i.text || i.name || i.net || "";
    if (i.kind === "wire") return c.schNets()?.byWire?.get(i.id) || i.net || "";
    return i.net || "";
  }
  function layerOf(c, o) {
    if (c.kind !== "pcb") return null;
    if (o.sub) return o.layer || "Multi";
    if (o.kind === "part") return o.layer === "Bottom" ? "Bottom" : "Top";
    if (o.kind === "via") return o.layer || "Multi";
    return o.layer || (o.kind === "label" ? "Silk" : o.kind === "track" ? "Top" : null);
  }
  function spanOf(c, o) {
    if (c.kind !== "pcb") return null;
    if (o.kind === "via" && !o.sub) {
      const a = copperIndex(o.fromLayer), b = copperIndex(o.toLayer);
      return a != null && b != null ? [Math.min(a, b), Math.max(a, b)] : [0, 127];
    }
    if (o.sub && (o.drill > 0 || !o.layer || o.layer === "Multi")) return o.drill > 0 || o.layer === "Multi" ? [0, 127] : null;
    if (!o.sub && o.kind === "pad" && (o.drill > 0 || o.layer === "Multi")) return [0, 127];
    return null;
  }
  const refOf = o => o.sub ? o.part.ref : o.kind === "part" ? o.ref : null;
  function itemBinder(c) {
    const kind = o => kindOf(o, c.kind);
    const pred = name => {
      if (name === "All") return () => true;
      if (KIND_TESTS[name]) {const t = KIND_TESTS[name]; return o => t(kind(o));}
      if (name === "IsLocked") return o => (o.sub ? o.part : o).locked === true;
      if (name === "IsThruHole") return o => (kind(o) === "pad" || kind(o) === "via") && (o.drill || 0) > 0;
      if (name === "IsSMD" || name === "IsSMDPad") return o => kind(o) === "pad" && !((o.drill || 0) > 0);
      if (name === "IsTHPad") return o => kind(o) === "pad" && (o.drill || 0) > 0;
      if (name === "IsTeardrop") return o => !o.sub && (o.teardrop === true || typeof o.groupId === "string" && o.groupId.startsWith("teardrop:"));
      if (name === "IsDiffPair") return o => {const n = netOf(c, o); return !!n && c.pairs().byNet.has(lower(n));};
      if (name === "InAnyNet") return o => !!netOf(c, o);
      if (name === "InPolygon") return o=>kind(o)==="polygon" || o.polygonId!=null || o.polygon!=null;
      if (GROUPS[name]) {const g = GROUPS[name]; return o => c.kind === "pcb" && kind(o) !== "part" && layerGroup(g, layerOf(c, o), spanOf(c, o));}
      if (name === "OnTop" || name === "OnBottom") {const l = name === "OnTop" ? "Top" : "Bottom"; return o => layerMatches(layerOf(c, o), spanOf(c, o), l);}
      return () => false;
    };
    // Points that must lie inside a room for InRoom: the outline of lines and areas, the
    // box corners of a component, the centre of a pad or via.
    function pointsOf(o) {
      if (o.sub) return o.at ? [o.at] : [];
      if (Array.isArray(o.points) && o.points.length) return o.points;
      if (o.kind === "part") {const b = globalThis.AtriumNavCommon?.itemBox?.(c.doc, c.defs, o); if (b && b.every(Number.isFinite)) return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];}
      return Number.isFinite(o.x) && Number.isFinite(o.y) ? [[o.x, o.y]] : [];
    }
    const padsOf = part => {const d = c.defs.get(part.def); return (c.kind === "pcb" ? d?.footprint?.pads : d?.symbol?.pins || d?.pins) || [];};
    const fn = (name, arg, args = [arg]) => {
      switch (name) {
        case "InNet": return o => same(netOf(c, o), arg);
        case "InNetClass": return o => {const s = c.netClass(arg), n = netOf(c, o); return s ? !!n && s.has(lower(n)) : lower(arg) === ALL_NETS && !!n;};
        case "InComponent": return o => same(refOf(o), arg);
        case "InComponentClass": return o => {const s = c.componentClass(arg), r = refOf(o); return s ? !!r && s.has(lower(r)) : lower(arg) === ALL_COMPONENTS && !!r;};
        case "InNamedPolygon": return o => kind(o) === "polygon" && same(o.name || "", arg);
        case "InRoom": return o => {const room = roomNamed(c.doc.rooms, arg); if (!room || c.kind !== "pcb") return false; const pts = pointsOf(o); return pts.length > 0 && pts.every(p => insidePoly(p, room.points));};
        case "HasPad": {
          const [a, b] = args.length > 1 ? args : [null, args[0]];
          return o => {
            if (o.sub) return (a == null || same(o.part.ref, a)) && glob(b, o.pin);
            if (o.kind !== "part" || a != null && !same(o.ref, a)) return false;
            return padsOf(o).some(p => glob(b, String(p.number ?? "")));
          };
        }
        case "OnLayer": return o => layerMatches(layerOf(c, o), spanOf(c, o), arg);
        case "InDifferentialPair": return o => {const n = netOf(c, o); if (!n) return false; if (same(c.pairs().byNet.get(lower(n)), arg)) return true; const s = c.signals()?.signalOf(n); return !!s && s.kind === "diff" && same(s.name, arg);};
        case "InDifferentialPairClass": return o => {const n = netOf(c, o), p = n && c.pairs().byNet.get(lower(n)), s = c.pairs().classes.get(lower(arg)); return !!p && (same(arg, "All Differential Pairs") || !!s && s.has(lower(p)));};
        case "HasFootprint": return o => {const part = !o.sub && o.kind === "part" ? o : null; const d = part && c.defs.get(part.def); return !!d && (same(d.name, arg) || same(d.footprint?.name, arg) || same(d.id, arg) || glob(arg, d.footprint?.name || d.name || ""));};
        case "OnSheet": return () => same(c.doc.name, arg) || same(c.doc.id, arg);
        case "InxSignal": {let ix = null; return o => {ix ??= c.xs(); const n = netOf(c, o); return !!n && !!ix.byName.get(lower(arg))?.has(lower(n));};}
        case "InxSignalClass": {let ix = null; return o => {ix ??= c.xs(); const n = netOf(c, o); return !!n && !!ix.classNets.get(lower(arg))?.has(lower(n));};}
        // Signals and tags (signals.js); without a store: pairs and xSignals, classes of any kind.
        case "InSignal": return o => {const n = netOf(c, o); if (!n) return false; const env = c.signals(); if (env) return env.netsOfSignal(arg).has(n);
          return same(c.pairs().byNet.get(lower(n)), arg) || !!c.xs().byName.get(lower(arg))?.has(lower(n));};
        case "HasTag": return o => {const n = netOf(c, o); if (!n) return false; const env = c.signals(); if (env) return env.hasTag(n, arg);
          const p = c.pairs().byNet.get(lower(n)), pc = c.pairs().classes.get(lower(arg));
          return !!c.netClass(arg)?.has(lower(n)) || !!p && !!pc?.has(lower(p)) || !!c.xs().classNets.get(lower(arg))?.has(lower(n));};
      }
      return () => false;
    };
    const prop = name => {
      switch (name) {
        case "Signal": return o => {const n = netOf(c, o); if (!n) return null; const env = c.signals(); return env ? env.signalOf(n)?.name ?? null : c.pairs().byNet.get(lower(n)) ?? null;};
        case "Polarity": return o => {const n = netOf(c, o), s = n && c.signals()?.signalOf(n); return s ? s.polarity === 1 ? "+" : s.polarity === -1 ? "-" : "" : null;};
        case "Width": return o => o.sub ? null : (o.kind === "track" || o.kind === "graphic" || o.kind === "wire") ? o.width ?? (o.kind === "track" ? .25 : null) : null;
        case "PadIsPlated": return o => c.kind === "pcb" && (o.sub || o.kind === "pad") ? o.plated !== false : null;
        case "HoleSize": return o => (o.sub || o.kind === "pad" || o.kind === "via") && o.drill > 0 ? o.drill : (o.kind === "via" || o.sub || o.kind === "pad") ? 0 : null;
        case "Diameter": return o => o.kind === "via" && !o.sub ? o.diameter ?? null : o.sub || o.kind === "pad" ? Math.max(o.w || 0, o.h || 0) || null : null;
        case "Layer": return o => layerOf(c, o);
        case "Net": return o => netOf(c, o) || null;
        case "Designator": return o => refOf(o);
        case "Comment": return o => !o.sub && o.kind === "part" ? o.value ?? null : null;
        case "Footprint": return o => {const part = !o.sub && o.kind === "part" ? o : null; const d = part && c.defs.get(part.def); return d ? d.footprint?.name || d.name || d.id : null;};
        case "Name": return o => o.sub ? o.name ?? o.pin ?? null : o.name ?? o.text ?? null;
        case "Text": return o => o.sub ? null : o.text ?? null;
        case "X": return o => o.sub ? o.at?.[0] ?? null : Number.isFinite(o.x) ? o.x : null;
        case "Y": return o => o.sub ? o.at?.[1] ?? null : Number.isFinite(o.y) ? o.y : null;
        case "Rotation": return o => o.sub ? null : Number.isFinite(o.angle) ? ((o.angle % 360) + 360) % 360 : o.kind === "part" ? 0 : null;
        case "Length": return o => o.sub ? null : o.points ? trackLength(o.points) : null;
        case "Kind": return o => kind(o);
        case "Locked": return o => (o.sub ? o.part : o).locked === true;
        case "Side": return o => {const p = o.sub ? o.part : o; return c.kind === "pcb" && (p.kind === "part") ? (p.layer === "Bottom" ? "Bottom" : "Top") : null;};
        case "PinNumber": return o => o.sub ? o.pin : null;
      }
      return () => null;
    };
    return {pred, fn, prop};
  }
  // Rule objects (rules.js compile): {net, pair?, span?, layer?, component?, kind?, width?, drill?, diameter?,
  // pin?, padKind?, teardrop?, polygon?, box?, at?}. DRC copper carries its kind (track, arc, pad, via, region,
  // fill); polygons carry kind "polygon" and their name.
  // A rule object without a kind satisfies every Is* test (the rule decides what it checks).
  function ruleBinder(env = {}) {
    const classOf = (map, name) => {if (!map) return null; if (map.get(name)) return map.get(name); for (const [k, v] of map) if (lower(k) === lower(name)) return v; return null;};
    const has = (set, v) => !!set && v != null && (set.has(v) || [...set].some(x => lower(x) === lower(v)));
    const pairName = o => env.pairName ? env.pairName(o) : o.pair;
    const pred = name => {
      if (name === "All") return () => true;
      if (KIND_TESTS[name]) {const t = KIND_TESTS[name]; return o => !o.kind || t(o.kind);}
      if (name === "IsSMD" || name === "IsSMDPad") return o => !o.kind || o.kind === "pad" && !(o.drill > 0);
      if (name === "IsTHPad" || name === "IsThruHole") return o => !o.kind || (o.kind === "pad" || name === "IsThruHole" && o.kind === "via") && o.drill > 0;
      if (name === "IsTeardrop") return o => o.teardrop === true;
      if (name === "IsDiffPair") return o => !!pairName(o);
      if (name === "InAnyNet") return o => !!o.net;
      if (name === "InPolygon") return o=>o.kind==="polygon" || o.polygonId!=null || o.item?.polygon!=null;
      if (GROUPS[name]) {const g = GROUPS[name]; return o => o.kind !== "part" && layerGroup(g, o.layer, o.span);}
      if (name === "OnTop" || name === "OnBottom") {const l = name === "OnTop" ? "Top" : "Bottom"; return o => layerMatches(o.layer, o.span, l);}
      return o => !o.kind;
    };
    const boxIn = (o, poly) => o.box ? [[o.box[0], o.box[1]], [o.box[2], o.box[1]], [o.box[2], o.box[3]], [o.box[0], o.box[3]]].every(p => insidePoly(p, poly)) : !!o.at && insidePoly(o.at, poly);
    const fn = (name, arg, args = [arg]) => {
      switch (name) {
        case "InNet": return o => same(o.net, arg);
        case "InNetClass": {const builtin = lower(arg) === ALL_NETS; return o => {const s = classOf(env.classes, arg); return !!o.net && (s ? has(s, o.net) : builtin);};}
        case "InComponent": return o => same(o.component, arg);
        case "InComponentClass": {const builtin = lower(arg) === ALL_COMPONENTS; return o => {if (!o.component) return false; const s = classOf(env.ccMap?.(), arg); return s ? has(s, o.component) : builtin;};}
        case "InNamedPolygon": return o => o.kind === "polygon" && same(o.polygon || "", arg);
        case "InRoom": return o => {const room = roomNamed(env.rooms?.(), arg); return !!room && boxIn(o, room.points);};
        case "HasPad": {const [a, b] = args.length > 1 ? args : [null, args[0]]; return o => o.pin != null && (a == null || same(o.component, a)) && glob(b, o.pin);}
        case "OnLayer": return o => {const k = layerKey(arg), idx = (env.copperIndex || copperIndex)(k); return idx != null && o.span ? o.span[0] <= idx && idx <= o.span[1] : layerMatches(o.layer, null, arg);};
        // A diff signal's name covers all its stages (signals.js), as the rule scope kind does.
        case "InDifferentialPair": return o => { if (same(pairName(o), arg)) return true; const s = o.net && env.signals?.signalOf(o.net); return !!s && s.kind === "diff" && same(s.name, arg); };
        case "InDifferentialPairClass": return o => same(arg, "All Differential Pairs") ? !!pairName(o) : has(classOf(env.pairClasses, arg), pairName(o));
        // Rule scopes: an object with an xSignal name (xsignals.js DRC) matches by name, any other by its net.
        case "InxSignal": {let ix = null; return o => {ix ??= env.signals?.xs || xsIndex(env.doc?.()); return o.xSignal != null ? same(o.xSignal, arg) : !!o.net && !!ix.byName.get(lower(arg))?.has(lower(o.net));};}
        case "InxSignalClass": {let ix = null; return o => {ix ??= env.signals?.xs || xsIndex(env.doc?.()); return o.xSignal != null ? !!ix.classes.get(lower(arg))?.has(lower(o.xSignal)) : !!o.net && !!ix.classNets.get(lower(arg))?.has(lower(o.net));};}
        // Signals and tags (signals.js scopeEnv as env.signals); without a store: pairs and xSignals, classes of any kind.
        case "InSignal": {let ix = null; return o => {const S = env.signals; if (o.xSignal != null && S) { const p = S.model.paths().find(x => same(x.name, o.xSignal)); if (p) return same(p.signal, arg); }
          if (!o.net) return false; if (S) return S.netsOfSignal(arg).has(o.net); ix ??= xsIndex(env.doc?.()); return same(pairName(o), arg) || !!ix.byName.get(lower(arg))?.has(lower(o.net));};}
        case "HasTag": {let ix = null; return o => {const S = env.signals; if (S) return o.xSignal != null ? S.pathTags(o.xSignal).has(lower(arg)) : S.hasTag(o.net, arg);
          ix ??= xsIndex(env.doc?.()); if (o.xSignal != null) return !!ix.classes.get(lower(arg))?.has(lower(o.xSignal));
          return !!o.net && (has(classOf(env.classes, arg), o.net) || has(classOf(env.pairClasses, arg), pairName(o)) || !!ix.classNets.get(lower(arg))?.has(lower(o.net)));};}
      }
      return () => false;
    };
    const prop = name => {
      if (name === "Signal") return o => o.net ? env.signals?.signalOf(o.net)?.name ?? pairName(o) ?? null : null;
      if (name === "Polarity") return o => {const s = o.net && env.signals?.signalOf(o.net); return s ? s.polarity === 1 ? "+" : s.polarity === -1 ? "-" : "" : null;};
      if (name === "PadIsPlated") return o => o.kind === "pad" ? o.plated !== false : null;
      const key = {Net:"net", Layer:"layer", Designator:"component", Width:"width", HoleSize:"drill", Diameter:"diameter", Kind:"kind"}[name];
      return key ? o => o[key] ?? null : () => null;
    };
    return {pred, fn, prop};
  }

  // Only the shared native plan evaluates expressions. These callbacks project the editor's
  // component sub-pins, layer spans and membership stores onto its typed subject interface.
  function planContext(c, env) {
    const X=globalThis.AtriumQueryExchange, design=globalThis.AtriumDesignQuery;
    if (!X || !design) throw new QueryError("The design query compiler is unavailable.");
    const binder=c ? itemBinder(c) : ruleBinder(env), getters=new Map(), memberships=new Map();
    for (const [key,field] of Object.entries(X.fields)) {
      if (key!=="CompPinCount") getters.set(field.toLowerCase(),binder.prop(key));
    }
    if (c) getters.set("pincount",row=>{
      if (!row.sub && row.kind==="part") {
        const def=c.defs.get(row.def), pins=c.kind==="pcb" ? def?.footprint?.pads : def?.symbol?.pins || def?.pins;
        if (Array.isArray(pins)) return pins.length;
      }
      return null;
    });
    for (const [key,field] of Object.entries(X.bools)) if (!getters.has(field.toLowerCase())) getters.set(field.toLowerCase(),binder.pred(key));
    const fns=new Map(Object.keys(X.relations).map(key=>[X.relations[key][0],key]));
    fns.set("net","InNet");fns.set("component","InComponent");fns.set("polygon","InNamedPolygon");
    return design.context(c?.project || env?.project,c?.doc || env?.doc?.(),{
      defs:c?.defs, revision:c?.revision,
      fieldValue(row,key) {return getters.get(key.toLowerCase())?.(row.sub ? row : row.item || row);},
      relation(row,family,target) {
        const fn=fns.get(family);if (!fn) return undefined;
        let values=memberships.get(family);if (!values) memberships.set(family,values=new Map());
        if (!values.has(target.name)) values.set(target.name,binder.fn(fn,target.name));
        return values.get(target.name)(row.sub ? row : row.item || row);
      }
    });
  }
  function queryContext(text,c,options) {
    return typeof text==="string" && X.nativeInput(text)
      ? D.context(c?.project,c?.doc,{defs:c?.defs,revision:c?.revision,...options})
      : planContext(c || null);
  }
  function suggestionsOf(text,sourceMap,alternatives) {
    const native = X.nativeInput(text);
    return (alternatives || []).map(a => {
      const span=X.originalSpan(sourceMap,a.span), delimiter=text[span[0]];
      const replacement=native ? JSON.stringify(a.value) : delimiter==='"' ? '"'+a.value.replace(/"/g,'""')+'"' : quote(a.value);
      return {code:"case-alternative",field:a.field,span,replacement,label:"Use "+a.value};
    });
  }
  function planCost(plan) {
    const nodes=[plan.ast];
    let cost=1;
    while(nodes.length) {
      const n=nodes.pop();
      if(!n)continue;
      cost++;
      if(n.arg)nodes.push(n.arg);
      if(n.args)nodes.push(...n.args);
    }
    return cost;
  }
  function checked(text,ctx) {
    const lowered=globalThis.AtriumQueryExchange?.fromClassic(text,{layer:layerKey});
    if (!lowered) throw new QueryError("The Filter expression reader is unavailable.");
    if (!lowered.ok) return lowered;
    const result=globalThis.AtriumDesignQuery.compile(lowered.scope,ctx);
    return {...globalThis.AtriumQueryExchange.translateResult(result,lowered.map),scope:lowered.scope,sourceMap:lowered.map};
  }
  function matcher(text,c,o={}) {
    const ctx=queryContext(text,c), result=checked(text,ctx);
    const problem=result.diagnostics?.[0];
    if (!result.ok || !result.plan) throw new QueryError(problem?.message || "Invalid query.",problem?.span?.[0] ?? 0);
    const native=X.nativeInput(text);
    const budget={steps:0,max:o.maxSteps || MAX_STEPS};
    const cost=planCost(result.plan);
    let unknown=0, missing;
    const subject=item=>D.subject(c.doc,item,c);
    const test=row=>{
      budget.steps+=cost;
      if(budget.steps>budget.max) throw new QueryError("The query is too costly to evaluate on this design.");
      const verdict=result.plan.evaluate(row);
      if (typeof verdict !== "boolean") {
        unknown++;
        missing ||= verdict || undefined;
      }
      return verdict === true;
    };
    const f=item=>test(item.sub ? item : subject(item));
    f.test=test;
    f.net=row=>native ? ctx.netName(row) : netOf(c,row);
    f.missing=()=>missing;f.subject=subject;f.result=result;f.unknown=()=>unknown;f.budget=budget;f.normalized=globalThis.AtriumQueryExchange.nativeInput(text) ? text : print(parse(text));
    f.diagnostics=result.diagnostics;return f;
  }
  function ruleMatcher(text,env={}) {
    let result;
    try {result=checked(text,planContext(null,env));}
    catch(e){if(!(e instanceof QueryError))throw e;result={ok:false,diagnostics:[{message:e.message,span:[0,text.length]}]};}
    const test=result.plan?.test || (()=>null), matches=row=>test(row)===true;
    return Object.assign(matches,{test,complete:result.ok,diagnostics:result.diagnostics});
  }
  function run(project, doc, text, o = {}) {
    const c = context(project, doc, o), f = matcher(text, c, o);
    const ids = [], subs = [];
    const deadline = o.timeLimit ? Date.now() + o.timeLimit : 0;
    let truncated = false, n = 0;
    const withSubs = o.subs !== false;
    function* subjects() {
      if(f.result.plan.kind === "net") {
        const ctx=queryContext(text,c), seen=new Set();
        for(const item of doc.items)for(const name of D.projectOwner(doc,item,ctx,{nets:true})) {
          if(seen.has(name))continue;
          seen.add(name);
          yield D.netSubject(doc,name);
        }
        return;
      }
      for(const item of doc.items)yield* D.projectOwner(doc,item,c,{parent:true,terminals:withSubs});
    }
    for (const row of subjects()) {
      if (deadline && (++n & 1023) === 0 && Date.now() > deadline) {truncated = true; break;}
      if (!f.test(row))continue;
      if(row.sub) {if(subs.length>=MAX_RESULTS){truncated=true;break;}subs.push({...row,net:f.net(row) ?? ""});}
      else {if(ids.length>=MAX_RESULTS){truncated=true;break;}ids.push(row.id);}
    }
    let suggestions=[];
    if (o.suggestions && !truncated && !f.missing() && !ids.length && !subs.length && globalThis.AtriumDesignQuery.caseSuggestions) {
      // Only revisit the same authorized active document after its exact search completes.
      // The common plan verifies alternative spellings against the other conditions.
      function* rows() {
        for (const row of subjects()) {
          if (deadline && Date.now()>deadline) {truncated=true;return;}
          yield row;
        }
      }
      const alternatives=globalThis.AtriumDesignQuery.caseSuggestions(f.result.plan,rows());
      if (!truncated) suggestions=suggestionsOf(text,f.result.sourceMap,alternatives);
    }
    const missing=f.missing();
    const diagnostics=missing ? [...f.diagnostics,{...missing,span:globalThis.AtriumQueryExchange.originalSpan(f.result.sourceMap,missing.span)}] : f.diagnostics;
    return {ids,subs,count:ids.length+subs.length,kind:f.result.plan.kind,truncated,complete:!truncated && !missing,steps:f.budget.steps,
      normalized:f.normalized,diagnostics,unknown:f.unknown(),suggestions};
  }
  async function runIndexed(project,doc,text,o = {}) {
    const c=context(project,doc,o), ctx=queryContext(text,c,{signal:o.signal});
    const lowered=X.fromClassic(text,{layer:layerKey});
    if (!lowered.ok) return lowered;
    const native=X.nativeInput(text);
    const prepared=await Q.prepare(lowered.scope,ctx);
    if (!prepared.ok) return X.translateResult(prepared,lowered.map);
    let index;
    const clock=()=>globalThis.performance?.now?.() ?? Date.now();
    const result=await I.runDocument(prepared.plan,ctx,{...o,project,localFilter:true,
      limit:MAX_RESULTS*2+1,budget:{remaining:Math.floor((o.maxSteps || MAX_STEPS)/planCost(prepared.plan)),
        deadline:o.timeLimit ? clock()+o.timeLimit : Infinity},onIndex:value=>{index=value;}});
    const ids=[], subs=[];
    for (const entry of result.rows || []) {
      const row=index.lookup(I.idOf(entry));
      if (row.sub) {
        const net=native ? ctx.netName(row) : netOf(c,row);
        if(subs.length < MAX_RESULTS)subs.push({...row,net:net ?? ""});
      }
      else if(ids.length < MAX_RESULTS) ids.push(row.id);
    }
    const count=ids.length+subs.length, truncated=result.diagnostic?.code==="budget" || count<(result.count ?? 0);
    const diagnostics=Array.isArray(result.diagnostic?.span)
      ? [{...result.diagnostic,span:X.originalSpan(lowered.map,result.diagnostic.span)}] : [];
    return {ok:true,ids,subs,count,kind:prepared.plan.kind,truncated,source:lowered.scope.source,complete:result.complete && !truncated,
      diagnostics,hints:X.translateResult(prepared,lowered.map).hints, unknown:result.unknown || 0,visited:result.checked,
      suggestions:suggestionsOf(text,lowered.map,result.suggestions)};
  }
  // A query that finds objects like `item` (the query helper's "From selection").
  function fromItem(doc, item, o = {}) {
    if (!item) return "";
    const c = context(o.project || null, doc, o), k = kindOf(item, doc.kind), parts = [];
    const pred = Object.entries(KIND_TESTS).find(([, t]) => t(k))?.[0];
    if (pred) parts.push(pred);
    if (k === "part" && item.ref) parts.push("InComponent(" + quote(item.ref) + ")");
    const net = netOf(c, item);
    if (net) parts.push("InNet(" + quote(net) + ")");
    const layer = layerOf(c, item);
    if (layer && k !== "part" && k !== "via") parts.push("OnLayer(" + quote(layer) + ")");
    if (k === "track" && item.width) parts.push("Width = " + String(item.width) + "mm");
    return parts.join(" And ") || "All";
  }

  // ------------------------------------------------------------------ headless (MCP)
  function headless(project, a = {}) {
    const docs = project?.documents || [];
    const doc = a.document_id != null ? docs.find(d => d.id === a.document_id || d.name === a.document_id) : docs.find(d => d.kind === "pcb") || docs[0];
    if (!doc) throw Error(a.document_id != null ? "The project has no document " + a.document_id + "." : "The project has no documents.");
    if (doc.kind === "panel") throw Error("Choose a schematic or PCB document.");
    const text = String(a.expression ?? "");
    let r;
    try {r = run(project, doc, text, {maxSteps:a.max_steps || MAX_STEPS});}
    catch (e) {if (e instanceof QueryError) throw Error("Query error" + (e.at >= 0 ? " at character " + (e.at + 1) : "") + ": " + e.message); throw e;}
    const limit = 5000, apply = a.apply || "none", truncated=r.truncated || r.ids.length > limit || r.subs.length > limit;
    return {document_id:doc.id, expression:r.normalized, count:r.count, ids:r.ids.slice(0, limit), objects:r.ids.length,
      pins:r.subs.slice(0, limit).map(s => ({id:s.id, part:s.part.id, designator:s.part.ref, pin:s.pin, net:s.net || undefined})),
      complete:r.complete && !truncated,unknown:r.unknown,diagnostics:r.diagnostics,truncated,apply,
      ...(apply !== "none" ? {note:"The headless server returns the matches; " + apply + " is applied by the editor's Filter panel (pass these ids to select or other commands)."} : {})};
  }

  // ------------------------------------------------------------------ geometry for overlays
  function shapesOf(doc, defs, ids, subs, clip) {
    const want = new Set(ids), lines = [], boxes = [];
    const visible = b => b && b.every(Number.isFinite) &&
      (!clip || b[0] <= clip[2] && b[2] >= clip[0] && b[1] <= clip[3] && b[3] >= clip[1]);
    let box = null;
    const grow = b => {box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b.slice();};
    for (const i of doc.items) {
      if (!want.has(i.id)) continue;
      if ((i.kind === "track" || i.kind === "wire" || i.kind === "graphic" && !i.fill || i.kind === "bus") && i.points?.length > 1) {
        const w = Math.max(i.width || (doc.kind === "pcb" ? .25 : .3), .05);
        const [x,y,r,b] = A().bounds(i.points), extent = [x-w/2,y-w/2,r+w/2,b+w/2];
        if (visible(extent)) {lines.push({points:i.points,w}); grow(extent);}
        continue;
      }
      let b;
      try { b = A().bounds(A().itemPoints(i, defs.get(i.def), doc.kind)); }
      catch { /* Objects without direct geometry use their insertion point. */ }
      b ??= Number.isFinite(i.x) ? [i.x-.5,i.y-.5,i.x+.5,i.y+.5] : null;
      if (visible(b)) {boxes.push(b); grow(b);}
    }
    for (const s of subs || []) {
      if (!s.at) continue;
      const r = Math.max(s.w || 0, s.h || 0, doc.kind === "pcb" ? .3 : 1) / 2, b = [s.at[0] - r, s.at[1] - r, s.at[0] + r, s.at[1] + r];
      if (visible(b)) {boxes.push(b); grow(b);}
    }
    return {lines, boxes, box};
  }

  // ------------------------------------------------------------------ UI state and overlay
  // One applied filter at a time: {docId, ids:Set, subs, modes, shapes, text}.
  let host = null, applied = null, maskCanvas = null, maskKey = null, panel = null, ui = null, rerun = 0, applyController;
  function stopApply() {applyController?.abort();applyController=undefined;}
  const MODES_KEY = "atrium.query.modes.v1", HISTORY_KEY = "atrium.query.history.v1", FAV_KEY = "atrium.query.favourites.v1";
  const store = {
    get(k, d) {try {const v = JSON.parse(globalThis.localStorage?.getItem(k) || "null"); return v ?? d;} catch {return d;}},
    set(k, v) {try {globalThis.localStorage?.setItem(k, JSON.stringify(v));} catch {}}
  };
  const modes = Object.assign({select:true, zoom:true, mask:true, highlight:false}, store.get(MODES_KEY, {}));
  const strList = v => Array.isArray(v) ? v.filter(x => typeof x === "string" && x.length <= MAX_LENGTH).slice(0, 50) : [];
  let history = strList(store.get(HISTORY_KEY, [])), favourites = strList(store.get(FAV_KEY, []));

  function paths(shapes) {
    if (typeof Path2D === "undefined") return null;
    const fill = new Path2D(), byWidth = new Map();
    for (const b of shapes.boxes) fill.rect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    for (const l of shapes.lines) {
      const k = Math.round(l.w * 100) / 100;
      if (!byWidth.has(k)) byWidth.set(k, new Path2D());
      const p = byWidth.get(k); p.moveTo(l.points[0][0], l.points[0][1]);
      for (let n = 1; n < l.points.length; n++) p.lineTo(l.points[n][0], l.points[n][1]);
    }
    return {fill, strokes:[...byWidth]};
  }
  function overlay(ctx, info) {
    const st = applied;
    if (!st?.paths) return;
    const scale = info.scale || 1;
    if (st.modes.mask && ctx.getTransform && typeof document !== "undefined") {
      const cv = ctx.canvas;
      if (!maskCanvas) maskCanvas = document.createElement("canvas");
      if (maskCanvas.width !== cv.width || maskCanvas.height !== cv.height) {maskCanvas.width = cv.width; maskCanvas.height = cv.height; maskKey = null;}
      // The mask is rebuilt only when the view, the canvas size or the matches change: frames that
      // redraw the same view (hover, marquee, router preview) reuse it.
      const t = ctx.getTransform(), key = [cv.width, cv.height, t.a, t.b, t.c, t.d, t.e, t.f, st.paths, st.alpha, st.dim, scale];
      if (!maskKey || key.some((v, k) => v !== maskKey[k])) {
        const m = maskCanvas.getContext("2d");
        m.setTransform(1, 0, 0, 1, 0, 0); m.globalCompositeOperation = "source-over"; m.clearRect(0, 0, cv.width, cv.height);
        m.globalAlpha = st.alpha || .65; m.fillStyle = st.dim; m.fillRect(0, 0, cv.width, cv.height);
        m.setTransform(t); m.globalAlpha = 1; m.globalCompositeOperation = "destination-out";
        m.fill(st.paths.fill);
        m.lineCap = "round"; m.lineJoin = "round";
        for (const [w, p] of st.paths.strokes) {m.lineWidth = w + 2 / scale; m.stroke(p);}
        m.globalCompositeOperation = "source-over";
        maskKey = key;
      }
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.drawImage(maskCanvas, 0, 0); ctx.restore();
    }
    if (st.modes.highlight || !st.modes.mask) {
      ctx.save(); ctx.strokeStyle = st.accent; ctx.lineCap = "round"; ctx.lineJoin = "round";
      ctx.globalAlpha = .9; ctx.lineWidth = 2 / scale; ctx.stroke(st.paths.fill);
      ctx.globalAlpha = .45;
      for (const [w, p] of st.paths.strokes) {ctx.lineWidth = w + 4 / scale; ctx.stroke(p);}
      ctx.restore();
    }
  }
  function colours(kind) {
    const PCB = globalThis.AtriumPCBAppearance?.system, SCH = globalThis.AtriumSchAppearance;
    const base = String(kind === "pcb" ? PCB?.workspace || "#1e1e1e" : SCH?.workspace || "#f4f4f2");
    // Dim towards black on dark canvases and towards white on light ones.
    const m = /^#([0-9a-f]{6})$/i.exec(base), v = m ? parseInt(m[1], 16) : 0x1e1e1e;
    const light = (0.2126 * (v >> 16 & 255) + 0.7152 * (v >> 8 & 255) + 0.0722 * (v & 255)) > 140;
    return {dim:light ? "#ffffff" : "#000000", alpha:light ? .7 : .62, accent:PCB?.selection || "#4cc9f0"};
  }
  // Apply a set of matches to the editor (used by the Filter and Navigator panels).
  function applyIds(docId, ids, subs = [], m = modes, o = {}) {
    if (!host) return null;
    const doc = host.docById(docId);
    if (!doc) return null;
    if (docId !== host.currentId() && !o.inOther) host.selectDocument(docId);
    const defs = host.defs(), shapes = shapesOf(doc, defs, ids, subs);
    const c = colours(doc.kind);
    applied = (m.mask || m.highlight) && (ids.length || subs.length || o.scope) ? {docId, ids:new Set(ids), subs, modes:{...m}, shapes,
      paths:ids.length || subs.length ? paths(shapes) : null, text:o.text || "", scope:o.scope && A().clone(o.scope), dim:c.dim, alpha:c.alpha,
      accent:c.accent, revision:host.revision()} : null;
    if (m.select && !o.inOther) {const have = new Set(doc.items.map(i => i.id)); host.select(ids.filter(id => have.has(id)).slice(0, 50000));}
    if (m.zoom && shapes.box && !o.inOther) host.zoomTo(shapes.box);
    host.invalidate();
    return shapes.box;
  }
  function apply(text, m = modes, o = {}) {
    if (!host) return null;
    const doc = host.doc();
    if (doc.kind === "panel") {host.info("The Filter panel works on schematics and boards."); return null;}
    const started = Date.now();
    const r = run(host.project(), doc, text, {defs:host.defs(), revision:host.revision(), timeLimit:o.timeLimit ?? 3000,suggestions:!o.quiet && !!ui && !panel?.hidden});
    stopApply();
    return applyResult(doc,text,r,m,o,started);
  }
  async function applyIndexed(text,m = modes,o = {}) {
    if (!host) return null;
    const doc=host.doc(),project=host.project(),revision=host.revision(),started=Date.now();
    if (doc.kind === "panel") {host.info("The Filter panel works on schematics and boards.");return null;}
    stopApply();
    const controller=applyController=new AbortController();
    const isCurrent=()=>!controller.signal.aborted && project===host.project() && doc===host.doc() &&
      revision===host.revision() && (o.isCurrent?.() ?? true);
    try {
      const r=await runIndexed(project,doc,text,{defs:host.defs(),revision,signal:controller.signal,isCurrent,
        timeLimit:o.timeLimit ?? 3000,suggestions:o.suggestions});
      if(r.kind==="net" && r.count && !globalThis.AtriumCrossProbe && isCurrent())
        await globalThis.AtriumLazy.need("AtriumCrossProbe");
      if(!isCurrent())return null;
      if(r.ok && (r.complete || r.count))applyResult(doc,text,r,m,o,started);
      return r;
    } catch (error) {
      return isCurrent() ? {ok:false,diagnostics:[{message:error.message,span:[0,text.length]}]} : null;
    } finally {
      if(applyController===controller)applyController=undefined;
    }
  }
  function applyResult(doc,text,r,m,o,started) {
    const nets = r.kind==="net" && globalThis.AtriumCrossProbe?.netObjectsBatch(doc,host.defs(),
      r.ids.map(id=>id.slice(4)),{terminals:true});
    const members = nets ? [...nets.values()] : null;
    applyIds(doc.id,members ? [...new Set(members.flatMap(row=>row.ids))] : r.ids,
      members ? members.flatMap(row=>row.subs) : r.subs,m,{text,scope:o.scope});
    if (!o.quiet) {
      remember(text);
      host.info("Filter: " + r.count + " object" + (r.count === 1 ? "" : "s") + (r.subs.length ? " (" + r.subs.length + (doc.kind === "pcb" ? " pads)" : " pins)") : "") + " · " + (Date.now() - started) + " ms" + (r.unknown ? " · "+r.unknown+" unavailable" : "") + (r.truncated ? " · stopped early" : ""));
    }
    return r;
  }
  // Shift+C (and the Clear button) also clears the net highlight, as Altium's Clear Filter
  // does. host.clearHighlight comes from the editor; older hosts fall back to setHighlight("").
  function clear(quiet) {
    stopApply();
    const had = !!applied;
    applied = null;
    // Release the full-canvas mask bitmap and the paths its key holds.
    maskKey = null; if (maskCanvas) maskCanvas.width = maskCanvas.height = 1;
    let lit = false;
    if (host && !quiet) {
      try {
        lit = !!(typeof host.highlight === "function" && host.highlight());
        if (typeof host.clearHighlight === "function") {const r = host.clearHighlight(); if (r === true) lit = true;}
        else if (lit && typeof host.setHighlight === "function") host.setHighlight("");
      } catch {/* the highlight is the editor's; a failing host leaves it as it is */}
    }
    if (host) {host.invalidate(); if (!quiet) host.info(had && lit ? "Filter and net highlight cleared" : had ? "Filter cleared" : lit ? "Net highlight cleared" : "No filter to clear");}
    if (ui) ui.count.textContent = "";
  }
  function remember(text) {
    const t = text.trim(); if (!t) return;
    history = [t, ...history.filter(h => h !== t)].slice(0, 25); store.set(HISTORY_KEY, history); paintLists();
  }
  function toggleFavourite(text) {
    const t = String(text || "").trim(); if (!t) return;
    favourites = favourites.includes(t) ? favourites.filter(f => f !== t) : [t, ...favourites].slice(0, 50);
    store.set(FAV_KEY, favourites); paintLists();
  }

  // ------------------------------------------------------------------ Filter panel
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const button = (text, fn, cls, title) => {const b = el("button", text, cls); b.type = "button"; b.onclick = fn; if (title) b.title = title; return b;};
  function insert(text) {
    const box = ui.input, s = box.selectionStart ?? box.value.length, e = box.selectionEnd ?? s;
    const before = box.value.slice(0, s), after = box.value.slice(e);
    const pad = before && !/[\s(]$/.test(before) ? " " : "", pad2 = after && !/^[\s)]/.test(after) ? " " : "";
    box.value = before + pad + text + pad2 + after;
    const at = (before + pad + text).length; box.focus(); box.setSelectionRange?.(at, at); validate();
  }
  function validate() {
    const t = ui.input.value;
    if (!t.trim()) {ui.error.textContent = ""; ui.input.removeAttribute("aria-invalid"); ui.compilation=null; ui.fieldHints?.update({hints:[],diagnostics:[]}); return false;}
    const current=host?.doc?.(), c=current && context(host.project?.(),current,{defs:host.defs?.(),revision:host.revision?.()});
    const r=check(t,c), published=ui.published;
    if(published && published.source===t && published.project===host.project() && published.doc===current && published.revision===host.revision()){
      r.hints=[...(r.hints || []),...published.hints];
    }
    ui.compilation=r;
    ui.fieldHints?.update(r,{kind:r.plan?.kind || "object"});
    ui.error.textContent = r.ok ? "" : r.error + (r.at >= 0 ? " (at " + (r.at + 1) + ")" : "");
    ui.input.toggleAttribute("aria-invalid", !r.ok);
    return r.ok;
  }
  function namesFor(kind) {
    const d = host.doc(), defs = host.defs(), out = new Set();
    if (kind === "net") {
      if (d.kind === "pcb") {for (const i of d.items) {if (i.net) out.add(i.net); if (i.pinNets) for (const v of Object.values(i.pinNets)) if (v) out.add(v);}}
      else {const c = context(host.project(), d, {defs, revision:host.revision()}); for (const n of c.schNets()?.nets || []) if (n.name) out.add(n.name); for (const i of d.items) if (i.kind === "netlabel" && i.text) out.add(i.text);}
    } else if (kind === "component") {for (const i of d.items) if (i.kind === "part" && i.ref) out.add(i.ref);}
    else if (kind === "layer") {for (const l of host.copperLayers?.() || []) out.add(l); for (const i of d.items) if (i.layer) out.add(i.layer);}
    else if (kind === "netclass") {const board = d.kind === "pcb" ? d : host.project().documents.find(x => x.kind === "pcb"); try {for (const k of Object.keys(globalThis.AtriumRules?.netClasses?.(board, {project:host.project()}) || board?.rules?.netClasses || {})) out.add(k);} catch {}}
    else if (kind === "componentclass") {const board = d.kind === "pcb" ? d : host.project().documents.find(x => x.kind === "pcb"); try {if (board && globalThis.AtriumComponentClasses) for (const k of AtriumComponentClasses.map(board, host.project()).keys()) out.add(k);} catch {}}
    return [...out].sort((a, b) => String(a).localeCompare(String(b), undefined, {numeric:true})).slice(0, 5000);
  }
  function paintLists() {
    if (!ui) return;
    const fill = (sel, list, label) => {sel.replaceChildren(new Option(label + " (" + list.length + ")", "")); for (const t of list) sel.add(new Option(t.length > 80 ? t.slice(0, 77) + "…" : t, t)); sel.value = "";};
    fill(ui.history, history, "History"); fill(ui.favs, favourites, "Favourites");
    ui.star.setAttribute("aria-pressed", String(favourites.includes(ui.input.value.trim())));
  }
  function build() {
    const nav = document.getElementById("navigator");
    if (!nav) return false;
    panel = el("section", null, "panel panel-query"); panel.setAttribute("aria-labelledby", "query-heading"); panel.hidden = true;
    const head = el("header", null, "pane-heading"), h2 = el("h2", "Filter"); h2.id = "query-heading";
    head.append(h2, button("×", () => toggle(false), "ui-close query-close", "Close Filter panel"));
    const input = el("textarea", null, "query-input ui-field"); input.rows = 3; input.spellcheck = false; input.maxLength = MAX_LENGTH;
    input.placeholder = "IsTrack And OnLayer('Top') And Width < 0.2mm"; input.setAttribute("aria-label", "Query expression");
    const error = el("div", null, "query-error"); error.setAttribute("role", "status"); error.id = "query-error"; input.setAttribute("aria-describedby", error.id);
    let t = 0; input.oninput = () => {stopApply();ui.published=null;ui.fieldHints?.update({hints:[],diagnostics:[]});clearTimeout(t); t = setTimeout(validate, 120); ui.star.setAttribute("aria-pressed", String(favourites.includes(input.value.trim())));};
    input.addEventListener("keydown", e => {
      if (e.key === "Enter" && !e.shiftKey) {e.preventDefault(); run_();}
      else if (e.key === "Escape") {e.preventDefault(); clear(); host.canvas()?.focus();}
      e.stopPropagation();
    });
    async function run_() {
      clearTimeout(t);
      const source=input.value, project=host.project(), doc=host.doc();
      if(!source.trim()){validate();host.info("Type a query, for example IsVia And HoleSize > 0.3mm");return;}
      const r=await applyIndexed(source,modes,{suggestions:true,isCurrent:()=>source===input.value && !panel.hidden});
      if(!r)return;
      if(!r.ok){ui.error.textContent=r.diagnostics[0]?.message || Q.unavailable();input.setAttribute("aria-invalid","true");
        ui.fieldHints?.update(r);return;}
      validate();
      if (modes.select && r.complete && !r.subs.length && r.ids.length <= 200)
        globalThis.AtriumMacros?.recordCurrent("butter.query.search",
          {source:r.source, documentId:doc.id, limit:200}, {complete:true, count:r.ids.length}, "read", true);
      ui.count.textContent=r.truncated && !r.count ? "Stopped early" :
        r.count+" matched"+(r.unknown ? " · "+r.unknown+" unavailable" : "")+(r.truncated ? " · stopped early" : "");
      if (r.diagnostics.length) ui.error.textContent=r.diagnostics[0].message;
      ui.published={source,project,doc,revision:host.revision(),hints:r.suggestions || []};
      const compiled={...ui.compilation,hints:[...(r.hints || []),...ui.published.hints]};
      ui.compilation=compiled;
      ui.fieldHints?.update(compiled,{kind:compiled.plan?.kind || "object"});
    }
    const actions = el("div", null, "query-actions");
    const applyBtn = button("Apply", run_, "query-apply primary ui-button");
    applyBtn.dataset.variant = "primary"; applyBtn.dataset.size = "sm";
    const clearBtn = button("Clear", () => clear(), "query-clear-button ui-button");
    clearBtn.dataset.size = "sm";
    const star = button("★", () => toggleFavourite(input.value), "query-star ui-button", "Add to or remove from favourites"); star.dataset.size = "sm"; star.setAttribute("aria-pressed", "false");
    const count = el("span", null, "query-count");
    actions.append(applyBtn, clearBtn, star, count);
    const modeRow = el("fieldset", null, "query-modes"); modeRow.append(el("legend", "On apply"));
    for (const [k, label, tip] of [["select", "Select", "Select the matching objects"], ["zoom", "Zoom", "Zoom to the matching objects"], ["mask", "Mask", "Dim everything else"], ["highlight", "Highlight", "Outline the matching objects"]]) {
      const l = el("label", null, "query-mode"), c = el("input", null, "ui-checkbox"); c.type = "checkbox"; c.checked = !!modes[k]; c.title = tip;
      c.onchange = () => {modes[k] = c.checked; store.set(MODES_KEY, modes); if (applied) {applied.modes[k] = c.checked; if (!applied.modes.mask && !applied.modes.highlight) clear(true); else host.invalidate();}};
      l.append(c, document.createTextNode(" " + label)); modeRow.append(l);
    }
    // Query helper: click to build an expression.
    const helper = el("details", null, "query-helper"); helper.open = true; helper.append(el("summary", "Query helper"));
    const chips = el("div", null, "query-chips");
    const chip = (text, ins = text, title) => {const b = button(text, () => insert(ins), "query-chip ui-button", title || "Insert " + ins); b.dataset.size = "sm"; chips.append(b);};
    for (const k of ["IsTrack", "IsVia", "IsPad", "IsComponent", "IsPolygon", "IsWire", "IsNetLabel", "IsPort"]) chip(k);
    for (const k of ["And", "Or", "Not", "(", ")"]) chip(k);
    for (const [k, ins] of [["Width <", "Width < 0.2mm"], ["HoleSize >", "HoleSize > 0.3mm"], ["Comment Like", "Comment Like '10k*'"]]) chip(k, ins);
    const pickRow = el("div", null, "query-pick");
    const what = el("select", null, "ui-field"); what.dataset.size = "sm"; what.setAttribute("aria-label", "Query helper function");
    for (const [v, label] of [["net", "InNet"], ["netclass", "InNetClass"], ["component", "InComponent"], ["componentclass", "InComponentClass"], ["layer", "OnLayer"]]) what.add(new Option(label, v));
    const which = el("select", null, "ui-field"); which.dataset.size = "sm"; which.setAttribute("aria-label", "Query helper value");
    const fillWhich = () => {which.replaceChildren(); const list = namesFor(what.value); if (!list.length) which.add(new Option("(none)", "")); for (const v of list) which.add(new Option(what.value === "layer" ? displayName(v) : v, v));};
    what.onchange = fillWhich; which.onfocus = () => {if (which.options.length <= 1) fillWhich();};
    const add = button("Insert", () => {if (!which.value) return; insert({net:"InNet", netclass:"InNetClass", component:"InComponent", componentclass:"InComponentClass", layer:"OnLayer"}[what.value] + "(" + quote(which.value) + ")");}, "query-chip ui-button");
    const fromSel = button("From selection", () => {
      const d = host.doc(), id = host.selection()[0], item = id && d.items.find(i => i.id === id);
      if (!item) {host.info("Select an object first."); return;}
      input.value = fromItem(d, item, {project:host.project(), defs:host.defs(), revision:host.revision()}); validate(); input.focus();
    }, "query-chip ui-button", "Build a query from the selected object");
    add.dataset.size = "sm"; fromSel.dataset.size = "sm";
    pickRow.append(what, which, add, fromSel);
    helper.append(chips, pickRow);
    const lists = el("div", null, "query-lists");
    const historySel = el("select", null, "ui-field"); historySel.dataset.size = "sm"; historySel.setAttribute("aria-label", "Query history");
    const favSel = el("select", null, "ui-field"); favSel.dataset.size = "sm"; favSel.setAttribute("aria-label", "Favourite queries");
    for (const s of [historySel, favSel]) s.onchange = () => {if (s.value) {input.value = s.value; validate(); run_();} s.value = "";};
    lists.append(historySel, favSel);
    const help = el("p", null, "query-help"), C = globalThis.AtriumNavCommon, K = globalThis.AtriumKeymap;
    C.shortcutTitle(applyBtn, "Apply the query", "Enter");
    function refreshShortcuts() {
      const key = K?.hintKey("query-clear", host.doc().kind);
      C.shortcutTitle(clearBtn, "Clear the filter", key);
      help.replaceChildren("Examples: IsVia And HoleSize > 0.3mm · InNet('GND') · Comment Like '10k*' · Not OnLayer('Top'). ",
        AtriumShortcut.render("Enter", {variant:"inline"}), " applies, ", AtriumShortcut.render("Escape", {variant:"inline"}));
      if (key) help.append(" or ", AtriumShortcut.render(key, {variant:"inline"}));
      help.append(" clears.");
    }
    refreshShortcuts(); K?.onChange(refreshShortcuts); host.on("document", refreshShortcuts);
    panel.append(head, input, error, actions, modeRow, helper, lists, help);
    nav.append(panel);
    ui = {input, error, count, star, history:historySel, favs:favSel, which, what, fillWhich};
    const attachHints=()=>{
      if (!ui.fieldHints && globalThis.AtriumQueryFieldUI) {
        ui.fieldHints=AtriumQueryFieldUI.attach(input,{project:()=>host.project(),host,changed:validate,
          context:()=>({kind:ui.compilation?.plan?.kind || "object"}),result:()=>ui.compilation});
        if (ui.compilation) ui.fieldHints.update(ui.compilation,{kind:ui.compilation.plan?.kind || "object"});
      }
    };
    if (globalThis.AtriumQueryFieldUI) attachHints();
    else globalThis.AtriumLazy?.need("AtriumQueryFieldUI").then(attachHints).catch(()=>{});
    paintLists();
    return true;
  }
  function toggle(show) {
    if (!panel && !build()) return;
    const on = show ?? panel.hidden;
    if (!on) stopApply();
    panel.hidden = !on;
    document.body.classList.remove("hide-left");
    globalThis.AtriumNavCommon?.setChecked("query-panel", on);
    if (on) {ui.fillWhich(); ui.input.focus({preventScroll:true}); host?.info("Filter panel: type a query and press " + (globalThis.AtriumKeymap?.display("Enter") || "Enter"));}
    else host?.canvas()?.focus();
  }
  function attach(h) {
    host = h;
    host.registerAction("query-panel", () => toggle());
    host.registerAction("query-clear", () => clear());
    host.addRenderer(d => applied && d.id === applied.docId ? {overlay} : null);
    // The filter follows edits: re-run it (debounced) so masks match the changed design.
    host.on("change", () => {
      stopApply();
      if(ui?.published){ui.published=null;if(!panel?.hidden)validate();}
      if (!applied?.text) {if (applied) {const doc = host.docById(applied.docId); if (doc) {const have = new Set(doc.items.map(i => i.id)); applied.shapes = shapesOf(doc, host.defs(), [...applied.ids].filter(id => have.has(id)), applied.subs); applied.paths = paths(applied.shapes);}} return;}
      clearTimeout(rerun);
      rerun = setTimeout(() => {
        const previous=applied;
        if(applyController || !previous?.text || previous.docId!==host.currentId())return;
        void applyIndexed(previous.text,{...previous.modes,select:false,zoom:false},
          {quiet:true,scope:previous.scope,isCurrent:()=>applied===previous});
      }, 300);
    });
    host.on("document", () => {stopApply();if(ui)ui.published=null;if(ui && panel && !panel.hidden){ui.fillWhich();validate();}});
  }
  if (typeof document !== "undefined") globalThis.AtriumNavCommon?.ready(attach);

  return Object.freeze({QueryError, tokenize, parse, print, check, valid, glob, layerKey, run, runIndexed, matcher:(text, ctx) => matcher(text, ctx), context, ruleMatcher, fromItem,
    headless, shapesOf, names:NAMES, limits:{length:MAX_LENGTH, tokens:MAX_TOKENS, depth:MAX_DEPTH, steps:MAX_STEPS},
    // UI
    toggle, apply, applyIndexed, applyIds, clear, attach, applied:() => applied ? {docId:applied.docId, ids:[...applied.ids], modes:{...applied.modes},
      text:applied.text, ...(applied.scope && {scope:applied.scope})} : null,
    snapshotMask:() => applied ? {ids:[...applied.ids], modes:{mask:applied.modes.mask, highlight:applied.modes.highlight},
      subs:applied.subs.map(s => ({id:s.id, at:s.at?.slice(), w:s.w, h:s.h, ownerId:s.ownerId ?? s.part?.id, pin:s.pin, padIndex:s.padIndex}))} : null,
    modes:() => ({...modes}), history:() => history.slice(), favourites:() => favourites.slice(), toggleFavourite,
    isOpen:() => !!panel && !panel.hidden,
    // Rules dialog: a "Custom query" scope kind (rules.js scopeEditor hook).
    scopeField});

  // The rules dialog's scope editor gains a "Custom query" kind with a text box.
  function scopeField({row, kind, value, preview, rule, key, scopeQuery, project, doc, defs}) {
    if (!row || !kind || typeof document === "undefined") return;
    kind.add(new Option("Custom query", "query"));
    const box = document.createElement("input"); box.type = "text"; box.className = "rules-query-input ui-field"; box.maxLength = MAX_LENGTH; box.spellcheck = false;
    box.setAttribute("aria-label", "Scope query"); box.placeholder = "InNetClass('Power') Or InNet('VBUS')";
    const status = document.createElement("small"); status.className = "rules-query-status"; status.setAttribute("role", "status");
    row.append(box, status);
    const native=()=>rule[key]?.languageVersion!=null;
    const custom=()=>native() ? !globalThis.AtriumDesignQueryRecord?.toSelector(rule[key]) : rule[key]?.kind==="query";
    const source=()=>native() ? rule[key].source : rule[key]?.value || "";
    const sync=()=>{const show=kind.value==="query";box.hidden=!show;status.hidden=!show;if(show){value.hidden=true;box.value=source();}};
    if (custom()) kind.value="query";
    const original=kind.onchange;
    kind.onchange=e=>{
      epoch++;box.setCustomValidity("");box.removeAttribute("aria-invalid");
      if(kind.value==="query"){sync();box.value=native()?rule[key].source:custom()?source():scopeQuery(rule[key]);box.focus();return;}
      original?.call(kind,e);sync();
    };
    let epoch=0;
    function validity(message) {status.textContent=message;box.setCustomValidity(message);box.toggleAttribute("aria-invalid",!!message);}
    box.oninput=async()=>{
      const requested=++epoch, original=rule[key], raw=box.value, published=()=>requested===epoch && raw===box.value && kind.value==="query" && box.isConnected;
      const lowered=globalThis.AtriumQueryExchange.fromClassic(raw,{layer:layerKey});
      if(!lowered.ok){validity(lowered.diagnostics[0].message);return;}
      if(lowered.scope.source===original?.source){validity("");return;}
      validity("Checking the rule scope…");
      const ctx=queryContext(raw,doc ? context(project,doc,{defs}) : null), design=globalThis.AtriumDesignQuery;
      const prepared=await design.prepare(lowered.scope,ctx);
      if(!published())return;
      if(!prepared.ok){validity(prepared.diagnostics[0]?.message || Q.unavailable());return;}
      const bound=design.bind?.(lowered.scope,ctx);
      if(!bound?.ok){validity(bound?.diagnostics?.[0]?.message || "The rule scope could not be bound.");return;}
      // Only an accepted text edit may replace its original source and stable target IDs.
      rule[key]=bound.record;preview.textContent=bound.record.source;validity("");
    };
    sync();
  }
})();
