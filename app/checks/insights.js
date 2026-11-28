"use strict";
if (!globalThis.AtriumLandContours && typeof require === "function") require("../pcb/land-contours.js");

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// Design Insights: advice about choices that are valid but not ideal (a narrow neck in a pour, a
// high-speed track crossing a split in its reference plane, a decoupling capacitor far from its
// pin, a likely typo in a net name ...), the way an IDE hints at code. Insights are not
// violations: they never fail DRC, ERC or Release, have their own quiet look (insights-ui.js) and
// can be dismissed. This file is the DOM-free engine; the checks are insights-pcb.js and
// insights-sch.js, the canvas markers, card, Messages group and Preferences page insights-ui.js.
//
// Checks: register({id, kind:"pcb"|"schematic", severity:"tip"|"advice", title, why, learnMore,
//   scope, heavy?, needs?, dirtyKinds?, reach?, defaults, settings?, run(ctx, scope)}) where run
//   returns (or, as a generator, yields its way to) [{objects, at, line?, box?, message, why?,
//   sig, net?, fix?: {label, apply(doc, project, defs)}}]. Scopes, for incremental runs:
//     net    run(ctx, {nets}) re-checks the nets the edit touched (old and new nets of each object)
//     area   run(ctx, {boxes}) re-checks objects whose boxes meet the edited region grown by reach
//            areaInput(ctx, dirty, kinds) may invalidate the whole area check via its stamp or changed flag
//     doc    re-runs when an object of one of dirtyKinds (default: any) changed
//     pour   re-runs every pass; the check memoises per poured region (regions are replaced on repour)
//   `null` in scope means everything (first run, rules or library changed, large edit).
//
// Engine: engine() → {*update(project, doc, defs, hint, opts), list(docId), reset()}; hint is the
//   undo store's journal (AtriumUndoStore.changed). Each yield is a checkpoint where the caller
//   may pause (idle slices) or abandon the run (a newer edit), so it never blocks input.
// Headless: analyze(project, doc, defs, opts) → {insights, notes, ms} (full run, synchronous);
//   headless(args, {project}) is MCP list_insights.
//
// Dismissals are stored with the project so collaborators share them (docs/format-versioning.md):
//   project.insights = {version:1, dismissed:{<key>: {check, doc, objects, sig, date, title?}},
//                       muted:{<check>: {date}}}
//   key = check + ":" + hash(sorted object ids + "|" + sig). The sig is a coarse geometry signature
//   chosen by the check so the key survives a move (positions relative to the object, distances
//   bucketed) but a meaningful change (a different width, net or layer) raises the insight again.
//   Optional and additive: older builds keep the field unchanged; a store with a newer version is
//   read as far as it matches version 1 and never rewritten here except to add records.
globalThis.AtriumInsights = (() => {
  const G = globalThis, A = () => G.Atrium;
  const STORE_VERSION = 1, MAX_DISMISSED = 20000, KINDS = ["pcb", "schematic"], SEVERITIES = ["tip", "advice"];
  const SENSITIVITY = Object.freeze({low: "low", normal: "normal", high: "high"});
  const now = () => G.performance?.now?.() ?? Date.now();
  const r3 = v => Math.round(v * 1000) / 1000 + 0;
  // i18n (docs/translating.md): headless (MCP, tests) keeps English through the stub.
  // ")" is ")" after a placeholder: scripts/i18n-extract.py ends a define() table at the first "})".
  const I18N = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  const t = I18N.define({
    "insights.group": "Design Insights",
    "insights.source": "Insight · {title}",
    "insights.summary": "{count} design insights · advice only: insights never fail DRC, ERC or Release",
    "insights.summary_none": "No design insights on this document",
    "insights.dismissed_summary": "{count} dismissed (Preferences › Design Insights shows them again)"
  });

  // ---------------------------------------------------------------- geometry helpers (shared by the checks)
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    const u = l ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
    return {d: Math.hypot(a[0] + u * dx - p[0], a[1] + u * dy - p[1]), t: u, at: [a[0] + u * dx, a[1] + u * dy]};
  }
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  function segSeg(p, q, r, s) {
    const o1 = cross(p, q, r), o2 = cross(p, q, s), o3 = cross(r, s, p), o4 = cross(r, s, q);
    if ((o1 > 0) !== (o2 > 0) && (o3 > 0) !== (o4 > 0) && o1 && o2 && o3 && o4) return 0;
    return Math.min(segDist(p, r, s).d, segDist(q, r, s).d, segDist(r, p, q).d, segDist(s, p, q).d);
  }
  const inside = globalThis.AtriumGeometry.inRing;
  const union = (a, b) => !a ? b && b.slice() : !b ? a.slice() : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const grow = (b, m) => b && [b[0] - m, b[1] - m, b[2] + m, b[3] + m];
  const overlaps = (b, q) => !!b && !!q && b[0] <= q[2] && b[2] >= q[0] && b[1] <= q[3] && b[3] >= q[1];
  const inBox = (p, b) => !!p && p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
  // A uniform grid of boxes: insert(box, v), query(box, fn) visits each value once per query.
  function grid(cell = 2) {
    const m = new Map(), k = (x, y) => x * 73856093 ^ y * 19349663;
    let tick = 0;
    return {
      insert(b, v) {
        if (!b || !b.every(Number.isFinite)) return;
        const e = {v, b, t: 0};
        for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++) for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++) {
          const c = k(x, y); let l = m.get(c); if (!l) m.set(c, l = []); l.push(e);
        }
      },
      query(b, fn) {
        const id = ++tick;
        for (let x = Math.floor(b[0] / cell); x <= Math.floor(b[2] / cell); x++) for (let y = Math.floor(b[1] / cell); y <= Math.floor(b[3] / cell); y++)
          for (const e of m.get(k(x, y)) || []) if (e.t !== id) { e.t = id; if (overlaps(e.b, b)) fn(e.v); }
      }
    };
  }
  // Short, stable hash (two FNV-like lanes, as drc-waivers.js).
  function hash(s) {
    let h1 = 2166136261, h2 = 5381;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2, 33) ^ c; }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  }
  // Net name classes (as si.js / return-path.js).
  // net-intent.js (isSupply) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const POWER_RE = /^(?:[ADPS]?GND\w*|GND\w*|VSS\w*|VCC\w*|VDD\w*|VEE\w*|VBUS\w*|VBAT\w*|VIN\w*|PWR\w*|[+-]?\d+V\d*\w*|[+-]?\d+(?:\.\d+)?V\w*|P\d+V\d*\w*|\+\w+)$/i;
  const POWER = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isSupply ? N.isSupply(String(n ?? "")) : POWER_RE.test(n); }};
  // net-intent.js (isGround) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const GROUND_RE = /^(?:[ADPSC]?GND\w*|GND\w*|VSS\w*|EARTH|CHASSIS|PGND|0V)$/i;
  const GROUND = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isGround ? N.isGround(String(n ?? "")) : GROUND_RE.test(n); }};
  const isGround = n => !!n && GROUND.test(n);
  const isPower = n => !!n && POWER.test(n) && !GROUND.test(n);
  // High-speed by name: clocks, USB, DDR, HDMI, PCIe, SATA, LVDS/MIPI, Ethernet, SerDes, RF, fast memories.
  const FAST = /(?:^|[_\-./\s])(?:\w*CLK\w*|\w*CLOCK\w*|XTAL\w*|OSC\w*|USB\w*|D[PM]\d*|[PN]$|DQS?\w*|DDR\w*|HDMI\w*|TMDS\w*|PCIE?\w*|PCI_E\w*|SATA\w*|LVDS\w*|MIPI\w*|CSI\w*|DSI\w*|ETH\w*|RGMII\w*|RMII\w*|MDI\w*|TX[PN]?\d*|RX[PN]?\d*|SERDES\w*|RF\w*|ANT\w*|QSPI\w*|SDIO\w*|EMMC\w*|SCLK|MCLK|BCLK|LRCLK)(?:$|[_\-./\s\d])/i;
  const fastName = n => !!n && !POWER.test(n) && (FAST.test(n) || /^(?:CLK|CLOCK|USB|DDR|HDMI|PCIE|SATA|LVDS|MIPI|ETH|RF)/i.test(n));

  // ---------------------------------------------------------------- registry and settings
  const CHECKS = new Map();
  function register(spec) {
    if (!spec || typeof spec.id !== "string" || !/^[a-z][\w-]{1,40}$/i.test(spec.id)) throw Error("An insight check needs an id.");
    if (!KINDS.includes(spec.kind) || !SEVERITIES.includes(spec.severity || "tip") || typeof spec.run !== "function") throw Error("Insight check " + spec.id + " is incomplete.");
    CHECKS.set(spec.id, Object.freeze({scope: "doc", reach: 1, heavy: false, defaults: {}, settings: [], on: true, ...spec, severity: spec.severity || "tip"}));
    return CHECKS.get(spec.id);
  }
  const checks = kind => [...CHECKS.values()].filter(c => !kind || c.kind === kind);
  const pref = (k, d) => { try { const v = G.AtriumPref?.get?.(k, d); return v ?? d; } catch { return d; } };
  // Thresholds of a check: its defaults, the sensitivity preset (defaults[sensitivity] overrides), then
  // explicit values (opts.settings[check][key] headless, else Preferences insights.<check>.<key>).
  function settingsFor(check, opts = {}) {
    const sens = SENSITIVITY[opts.sensitivity ?? (opts.prefs === false ? "normal" : pref("insights.sensitivity", "normal"))] || "normal";
    const out = {};
    for (const [k, v] of Object.entries(check.defaults || {})) out[k] = v && typeof v === "object" && !Array.isArray(v) ? (v[sens] ?? v.normal) : v;
    const given = opts.settings?.[check.id];
    for (const s of check.settings || []) {
      const v = given && Object.hasOwn(given, s.key) ? given[s.key] : opts.prefs === false ? undefined : pref("insights." + check.id + "." + s.key, undefined);
      if (v != null && v !== "" && Number.isFinite(+v)) out[s.key] = Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, +v));
    }
    out.sensitivity = sens;
    return out;
  }
  function enabledChecks(kind, opts = {}) {
    const only = opts.checks ? new Set(opts.checks) : null;
    return checks(kind).filter(c => only ? only.has(c.id) : opts.prefs === false ? c.on !== false : pref("insights.check." + c.id, c.on !== false) !== false);
  }

  // ---------------------------------------------------------------- dismissals (project.insights)
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const safeKey = k => typeof k === "string" && k.length <= 120 && !["__proto__", "constructor", "prototype"].includes(k);
  function keyOf(checkId, ins, pad = ins.subject?.padKey) {
    const objs = [...new Set((ins.objects || []).map(String))].sort().join(",");
    return checkId + ":" + hash(objs + "|" + String(ins.sig ?? "") + (pad ? "|pad:" + pad : ""));
  }
  // The store as read: well-formed parts only, so a damaged or hand-edited file never breaks anything.
  function store(project) {
    const s = project?.insights;
    if (!plain(s)) return {dismissed: {}, muted: {}, ok: s == null, version: STORE_VERSION};
    const dismissed = plain(s.dismissed) ? s.dismissed : {}, muted = plain(s.muted) ? s.muted : {};
    return {dismissed, muted, ok: true, version: Number.isInteger(s.version) ? s.version : STORE_VERSION};
  }
  function writable(project) {
    if (!project || typeof project !== "object") throw Error("No project to keep the dismissal in.");
    let s = project.insights;
    if (s == null) s = project.insights = {version: STORE_VERSION, dismissed: {}, muted: {}};
    if (!plain(s)) throw Error("The project's Design Insights store is not readable by this version; nothing was changed.");
    if (!Number.isInteger(s.version)) s.version = STORE_VERSION;
    if (s.dismissed == null) s.dismissed = {};
    if (s.muted == null) s.muted = {};
    if (!plain(s.dismissed) || !plain(s.muted)) throw Error("The project's Design Insights store is not readable by this version; nothing was changed.");
    return s;
  }
  const today = () => new Date().toISOString().slice(0, 10);
  // Dismiss one insight (call inside the editor's edit() so it is one undo step).
  function dismiss(project, ins, o = {}) {
    const s = writable(project), key = ins.key || keyOf(ins.check, ins);
    if (!safeKey(key)) throw Error("This insight cannot be dismissed.");
    if (!Object.hasOwn(s.dismissed, key) && Object.keys(s.dismissed).length >= MAX_DISMISSED) throw Error("This project already has " + MAX_DISMISSED + " dismissed insights.");
    s.dismissed[key] = {check: ins.check, doc: ins.doc || "", objects: (ins.objects || []).slice(0, 50).map(String), sig: String(ins.sig ?? "").slice(0, 200),
      date: o.date || today(), ...(ins.title ? {title: String(ins.title).slice(0, 120)} : {}), ...(o.note ? {note: String(o.note).slice(0, 500)} : {})};
    return key;
  }
  // Dismiss every insight of a check for this project ("Dismiss all of this kind").
  function mute(project, checkId, o = {}) {
    if (!CHECKS.has(checkId) && !o.force) throw Error("Unknown insight check " + checkId + ".");
    writable(project).muted[checkId] = {date: o.date || today()};
  }
  // Show dismissed insights again: one key, every key of a check ({check}), or all (no argument).
  function restore(project, key, o = {}) {
    const s = project?.insights;
    if (!plain(s)) return 0;
    let n = 0;
    if (plain(s.dismissed)) for (const k of Object.keys(s.dismissed)) {
      const r = s.dismissed[k];
      if (key != null ? k === key : !o.check || r?.check === o.check) { delete s.dismissed[k]; n++; }
    }
    if (key == null && plain(s.muted)) for (const k of Object.keys(s.muted)) if (!o.check || k === o.check) { delete s.muted[k]; n++; }
    return n;
  }
  const isDismissed = (st, ins) => Object.hasOwn(st.muted, ins.check) || Object.hasOwn(st.dismissed, ins.key) ||
    !!ins.dismissalKeys?.some(key => Object.hasOwn(st.dismissed, key));
  function dismissedCount(project) { const s = store(project); return Object.keys(s.dismissed).length + Object.keys(s.muted).length; }

  // ---------------------------------------------------------------- context (lazy board facts)
  const lazyProp = (o, name, f) => Object.defineProperty(o, name, {configurable: true, enumerable: false, get() { const v = f(); Object.defineProperty(o, name, {value: v}); return v; }});
  const netsOf = i => i?.kind === "part" ? [...new Set(Object.values(i.pinNets || {}).filter(Boolean))] : i?.net ? [i.net] : [];
  function pcbPads(doc, defs, i) {
    if (i.kind === "pad") return [i];
    if (i.kind !== "part") return [];
    return AtriumPCBAppearance.readDefinition(defs, i.def, doc)?.footprint?.pads || [];
  }
  function itemBox(doc, defs, i, copper) {
    let box = null;
    try { const b = G.AtriumNavCommon?.itemBox?.(doc, defs, i); if (b && b.every(Number.isFinite)) box = b; } catch { /* fall back */ }
    if (!box && Array.isArray(i.points) && i.points.length) {
      for (const p of i.points) box = union(box, [p[0], p[1], p[0], p[1]]);
      box = grow(box, (+i.width || 0) / 2);
    }
    if (!box && i.kind === "part") {
      try { for (const p of A().pins(i, defs.get(i.def), doc.kind)) { const r = Math.max(+p.w || 0, +p.h || 0, +p.diameter || 0) / 2 || .3; box = union(box, [p.at[0] - r, p.at[1] - r, p.at[0] + r, p.at[1] + r]); } } catch { box = null; }
    }
    if (doc.kind === "pcb" && (i.kind === "part" || i.kind === "pad")) {
      const C = AtriumLandContours, part = i.kind === "part" ? i : null;
      for (const p of pcbPads(doc, defs, i)) if (p.padStack || p.poly) {
        for (const q of C.placedCopper(p, part, copper)) box = union(box, C.contactBox(q));
      }
    }
    if (box || !Number.isFinite(i.x)) return box;
    const r = i.kind === "part" ? 2 : Math.max(+i.diameter || 0, +i.w || 0, +i.h || 0) / 2 || .5;
    return [i.x - r, i.y - r, i.x + r, i.y + r];
  }
  function context(project, doc, defs, opts = {}) {
    const copper = AtriumLandContours.copperLookup(doc, defs);
    const ctx = {project, doc, defs, kind: doc.kind, opts, notes: [], memo: opts.memo || new Map(), t, I18N,
      dist, segDist, segSeg, inside, union, grow, overlaps, inBox, grid, hash, isGround, isPower, fastName, POWER, GROUND, r3, itemBox: i => itemBox(doc, defs, i, copper)};
    lazyProp(ctx, "byId", () => new Map(doc.items.map(i => [i.id, i])));
    lazyProp(ctx, "rules", () => { try { return G.AtriumRules?.migrate?.(G.AtriumRules.stored(doc, project)) ?? null; } catch { return null; } });
    lazyProp(ctx, "compiledRules", () => { try { return G.AtriumRules?.compiled?.(doc, {project, defs}) || null; } catch { return null; } });
    lazyProp(ctx, "query", () => { try { return G.AtriumRules?.resolver?.(doc, {project, compiled: ctx.compiledRules}) || null; } catch { return null; } });
    // Anchors for net topology, and exact placed contacts for spatial warnings.
    const padsOf = items => {
      const out = [];
      for (const i of items) {
        const part = i.kind === "part" ? i : null;
        for (const pad of pcbPads(doc, defs, i)) {
          const net = part ? part.pinNets?.[pad.number] || "" : pad.net || "";
          out.push({id:i.id, part, pad, net, number:String(pad.number ?? ""), at:AtriumResolvedLand.place(pad,part).at});
        }
      }
      return out;
    };
    const padGridOf = pads => {
      const C = AtriumLandContours, g = grid(2);
      for (const p of pads) for (const q of C.placedCopper(p.pad, p.part, copper)) g.insert(C.contactBox(q), {...p, ...q});
      return g;
    };
    lazyProp(ctx, "pads", () => padsOf(doc.items));
    ctx.boxOf = i => opts.boxOf?.(i.id) ?? itemBox(doc, defs, i, copper);
    ctx.itemsIn = boxes => !boxes ? doc.items : opts.itemsIn ? opts.itemsIn(boxes) : doc.items.filter(i => { const b = ctx.boxOf(i); return b && boxes.some(q => overlaps(b, q)); });
    ctx.padGridIn = boxes => boxes ? padGridOf(padsOf(ctx.itemsIn(boxes))) : ctx.padGrid;
    lazyProp(ctx, "padGrid", () => padGridOf(ctx.pads));
    lazyProp(ctx, "netItems", () => { const m = new Map(); for (const i of doc.items) for (const n of netsOf(i)) { if (!m.has(n)) m.set(n, []); m.get(n).push(i); } return m; });
    ctx.netItemsOf = net => opts.netItems ? opts.netItems(net) : ctx.netItems.get(net) || [];
    ctx.netNames = () => opts.netNames ? opts.netNames() : [...ctx.netItems.keys()];
    ctx.netPads = net => padsOf(ctx.netItemsOf(net).filter(i => i.kind === "part" || i.kind === "pad")).filter(p => p.net === net);
    lazyProp(ctx, "stack", () => { try { return G.AtriumStackup?.get?.(doc, defs) || null; } catch { return null; } });
    lazyProp(ctx, "connect", () => { try { return G.AtriumPolygonPour?.connectContext?.(doc, defs, {project}) || null; } catch { return null; } });
    ctx.currentOf = net => { try { const c = ctx.connect?.currentOf?.(net); return Number.isFinite(c) && c > 0 ? c : 0; } catch { return 0; } };
    ctx.thickness = layer => {
      const l = ctx.stack?.layers?.find?.(x => x.key === layer);
      return Number.isFinite(l?.thickness) && l.thickness > 0 ? l.thickness : .035;
    };
    // IPC-2152 width (mm) for a current at a temperature rise (AtriumPolygonPour.ipcWidth, else IPC-2221).
    ctx.ipcWidth = (amps, layer, rise = 10) => {
      const th = ctx.thickness(layer), external = layer === "Top" || layer === "Bottom";
      try { const w = G.AtriumPolygonPour?.ipcWidth?.(amps, th, external, rise); if (Number.isFinite(w) && w > 0) return w; } catch { /* fall back */ }
      const k = external ? .048 : .024, areaMil2 = Math.pow(amps / (k * Math.pow(rise, .44)), 1 / .725);
      return areaMil2 / (th / .0254) * .0254;
    };
    // Net classes: the rule engine's view (tags when the project has a signals store), else the stored keys.
    lazyProp(ctx, "netClassMap", () => { try { return G.AtriumRules?.netClasses ? G.AtriumRules.netClasses(doc, {project}) : ctx.rules?.netClasses || {}; } catch { return ctx.rules?.netClasses || {}; } });
    ctx.netClassesOf = net => { const out = []; for (const [k, v] of Object.entries(ctx.netClassMap || {})) if (Array.isArray(v) && v.includes(net)) out.push(k); return out; };
    lazyProp(ctx, "pairs", () => { try { return G.AtriumRules?.diffPairs?.(doc, {project}) || []; } catch { return []; } });
    lazyProp(ctx, "pairNets", () => { const s = new Set(); for (const p of ctx.pairs) { if (p.positive) s.add(p.positive); if (p.negative) s.add(p.negative); } return s; });
    // A net routed as high speed: a differential pair member, a high-speed net class, an impedance
    // profile on its width rule, or a high-speed name. opts.allSignals widens it to every signal net.
    ctx.highSpeed = net => {
      if (!net || POWER.test(net)) return false;
      if (ctx.opts.allSignals) return true;
      if (ctx.pairNets.has(net) || fastName(net)) return true;
      if (ctx.netClassesOf(net).some(c => /high.?speed|^hs|usb|ddr|clk|clock|pcie|hdmi|lvds|mipi|eth|rf|serdes|diff|imped|\d+\s*(?:ohm|Ω)/i.test(c))) return true;
      try { if (ctx.query?.("width", {net})?.impedance) return true; } catch { /* no rule */ }
      return false;
    };
    // Enabled DRC rules of a type that scope a net (the insight then stays quiet: DRC already reports it).
    ctx.ruleCovers = (type, o) => { try { return !!ctx.query?.(type, o); } catch { return false; } };
    return ctx;
  }

  // ---------------------------------------------------------------- running
  const isGen = v => v && typeof v.next === "function" && typeof v[Symbol.iterator] === "function";
  // Runs one check, yielding at its checkpoints; returns the finished insight list.
  function* runCheck(check, ctx, scope) {
    const out = check.run(ctx, scope);
    const list = isGen(out) ? yield* out : out;
    return (list || []).filter(x => x && Array.isArray(x.at) && x.at.every(Number.isFinite));
  }
  function finish(check, ctx, raw) {
    const ins = {check: check.id, kind: check.kind, severity: raw.severity || check.severity, title: check.title, message: String(raw.message || check.title),
      why: raw.why || check.why || "", learnMore: check.learnMore || "", objects: (raw.objects || []).filter(Boolean).map(String), at: [r3(raw.at[0]), r3(raw.at[1])],
      doc: ctx.doc.id, sig: String(raw.sig ?? ""), net: raw.net ?? null};
    if (Array.isArray(raw.netPair) && raw.netPair.length === 2 && raw.netPair.every(n => typeof n === "string" && n) && raw.netPair[0] !== raw.netPair[1]) {
      ins.netPair = raw.netPair.slice().sort();
    }
    if (raw.line) ins.line = raw.line.map(p => [r3(p[0]), r3(p[1])]);
    // The radius of the land the insight is about (a via, a hole): its marker sits clear of it.
    if (raw.land > 0) ins.land = r3(raw.land);
    if (raw.box) ins.box = raw.box.map(r3);
    if (raw.layer) ins.layer = raw.layer;
    if (raw.value != null) ins.value = raw.value;
    if (raw.subject) ins.subject = raw.subject;
    if (raw.fix && (typeof raw.fix.apply === "function" || typeof raw.fix.open === "function")) ins.fix = raw.fix; // open: a dialog, no edit of its own
    ins.key = keyOf(check.id, ins);
    if (raw.legacyPartDismissal || ins.subject?.padFallback) {
      ins.dismissalKeys = [];
      if (raw.legacyPartDismissal) ins.dismissalKeys.push(keyOf(check.id, ins, ""));
      if (ins.subject?.padFallback) ins.dismissalKeys.push(keyOf(check.id, ins, ins.subject.padFallback));
    }
    return ins;
  }
  // The incremental engine for one editor (insights-ui.js) or a headless run.
  function engine() {
    const docs = new Map(); // docId → {at, outer, rulesSig, items:Map(id→{nets, box, kind}), cache:Map(checkId→insights[]), memo, opts}
    // Project-wide name groups reference the shared per-sheet results.
    const sheetMemo = new WeakMap();
    // The engine's view of a document between passes: per object its nets, box and kind (so an edit's old
    // nets and region are known), the live object, a net index and a coarse grid of boxes, all updated
    // per changed object, so an incremental pass never walks the whole board.
    const CELL = 8, BIG = 64, ck = (x, y) => x * 73856093 ^ y * 19349663;
    function index(st, id, e, add) {
      if (!e) return;
      for (const n of e.nets) { let s = st.byNet.get(n); if (add) { if (!s) st.byNet.set(n, s = new Set()); s.add(id); } else if (s) { s.delete(id); if (!s.size) st.byNet.delete(n); } }
      const b = e.box;
      if (!b || !b.every(Number.isFinite)) return;
      const x0 = Math.floor(b[0] / CELL), x1 = Math.floor(b[2] / CELL), y0 = Math.floor(b[1] / CELL), y1 = Math.floor(b[3] / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > BIG) { if (add) st.big.add(id); else st.big.delete(id); return; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const key = ck(x, y);
        let occupants = st.grid.get(key);
        if (add) {
          if (!occupants) st.grid.set(key, occupants = new Set());
          occupants.add(id);
        } else if (occupants) {
          occupants.delete(id);
          if (!occupants.size) st.grid.delete(key);
        }
      }
    }
    function snapshot(st, doc, defs) {
      st.items = new Map(); st.live = new Map(); st.byNet = new Map(); st.grid = new Map(); st.big = new Set();
      const copper = AtriumLandContours.copperLookup(doc, defs);
      for (const i of doc.items) { const e = {nets: netsOf(i), box: itemBox(doc, defs, i, copper), kind: i.kind}; st.items.set(i.id, e); st.live.set(i.id, i); index(st, i.id, e, true); }
    }
    function commit(st, updates, live) {
      for (const [id, next] of updates) {
        index(st, id, st.items.get(id), false);
        if (next) { st.items.set(id, next); st.live.set(id, live.get(id)); index(st, id, next, true); } else { st.items.delete(id); st.live.delete(id); }
      }
    }
    // Views of the indexes for one pass, with the pass's pending changes laid over them.
    function views(st, pending, live) {
      const item = id => pending.has(id) ? (pending.get(id) ? live.get(id) : null) : st.live.get(id);
      return {
        boxOf: id => pending.has(id) ? pending.get(id)?.box : st.items.get(id)?.box,
        itemsIn(boxes) {
          const ids = new Set(st.big);
          for (const b of boxes) for (let x = Math.floor(b[0] / CELL); x <= Math.floor(b[2] / CELL); x++) for (let y = Math.floor(b[1] / CELL); y <= Math.floor(b[3] / CELL); y++) for (const id of st.grid.get(ck(x, y)) || []) ids.add(id);
          for (const [id, n] of pending) if (n) ids.add(id);
          const out = [];
          for (const id of ids) { const i = item(id), b = i && (pending.has(id) ? pending.get(id).box : st.items.get(id)?.box); if (i && b && boxes.some(q => overlaps(b, q))) out.push(i); }
          return out;
        },
        netItems(net) {
          const out = [];
          for (const id of st.byNet.get(net) || []) if (!pending.has(id)) { const i = st.live.get(id); if (i) out.push(i); }
          for (const [id, n] of pending) if (n && n.nets.includes(net)) { const i = live.get(id); if (i) out.push(i); }
          return out;
        },
        netNames() { const s = new Set(st.byNet.keys()); for (const n of pending.values()) if (n) for (const x of n.nets) s.add(x); return [...s]; }
      };
    }
    // hint: {from, to, ids, items} from AtriumUndoStore.changed (ids null when unknown); outer: the
    // store's count of changes outside items (library, rules, layer stack) — any change runs everything.
    function* update(project, doc, defs, hint = null, opts = {}) {
      const t0 = now(), kind = doc.kind;
      if (!KINDS.includes(kind)) return {insights: [], mode: "none", ms: 0};
      const active = enabledChecks(kind, opts);
      const rulesSig = kind === "pcb" ? JSON.stringify([G.AtriumRules?.stored?.(doc, project) ?? null, doc.layerStack ?? doc.stackup ?? null]) : "";
      const optsSig = JSON.stringify([opts.sensitivity, opts.settings, opts.checks, opts.allSignals, opts.skipHeavy, active.map(c => c.id).join(","),
        active.map(c => JSON.stringify(settingsFor(c, opts))).join("|")]);
      let st = docs.get(doc.id);
      const known = !!(st && st.project === project && hint?.ids && hint.from != null && st.at === hint.from && st.outer === opts.outer && st.rulesSig === rulesSig && st.optsSig === optsSig && st.items);
      // Why a run starts from scratch (reported with the result; tests and the perf probe read it).
      let why = known ? null : !st ? "first" : !hint?.ids || hint.from == null || st.at !== hint.from ? "journal" : st.outer !== opts.outer ? "outside items" : st.rulesSig !== rulesSig ? "rules" : "options";
      let full = !known, dirty = null, nets = null, boxes = null, kinds = null;
      const updates = []; // applied to st.items only when the run finishes, so an abandoned run leaves no trace
      if (known) {
        dirty = new Set(); nets = new Set(); boxes = []; kinds = new Set();
        const copper = AtriumLandContours.copperLookup(doc, defs);
        for (const id of hint.ids) {
          const was = st.items.get(id), live = hint.items.get(id);
          const next = live ? {nets: netsOf(live), box: itemBox(doc, defs, live, copper), kind: live.kind} : null;
          if (!was && !next) continue;
          dirty.add(id);
          for (const x of [was, next]) if (x) { for (const n of x.nets) nets.add(n); if (x.box) boxes.push(x.box); kinds.add(x.kind); }
          updates.push([id, next]);
        }
        if (dirty.size > Math.max(400, doc.items.length * .25)) { full = true; why = "large edit"; }
      }
      // Sheets whose nets a schematic check reads: the current one when it changed, the others when the
      // caller says so (opts.sheetChanged, from the undo journal; without it every pass re-reads them).
      // A change on another sheet re-runs this sheet's checks (they read every sheet).
      const others = kind === "schematic" && (project?.documents || []).some(s =>
        s !== doc && s.kind === "schematic" && (!opts.sheetChanged || opts.sheetChanged(s) !== false));
      // Some area checks use evidence outside the edited geometry. A changed input invalidates
      // only that check, even when the active document has no item edits.
      const inputStamps = new Map(), changedInputs = new Set();
      for (const check of active) {
        if (typeof check.inputStamp !== "function") continue;
        let stamp;
        try { stamp = check.inputStamp(project, doc, defs); } catch { stamp = null; }
        inputStamps.set(check.id, stamp);
        if (stamp == null || stamp !== st?.inputStamps?.get(check.id)) changedInputs.add(check.id);
      }
      if (!full && !dirty.size && !others && !changedInputs.size && !opts.force) { commit(st, updates, hint.items); st.at = hint.to; return {insights: list(doc.id), mode: "none", ms: now() - t0}; }
      if (others && !full) { full = true; why = "other sheets"; }
      if (full) {
        st = {at: hint?.to ?? null, outer: opts.outer, rulesSig, optsSig, cache: new Map(), memo: st?.project === project && st.rulesSig === rulesSig ? st.memo : new Map(), project};
        snapshot(st, doc, defs);
        yield {phase: "snapshot"};
      }
      // A stopped iterator must not publish partial check results.
      if (!full) st = {...st, cache:new Map(st.cache)};
      const v = views(st, full ? new Map() : new Map(updates), hint?.items || new Map());
      const ctx = context(project, doc, defs, {...opts, memo: st.memo, sheetMemo, ...v});
      if (boxes && boxes.length > 24) boxes = [boxes.reduce((u, b) => union(u, b), null)];
      const ran = [];
      try {
        for (const check of active) {
          if (check.heavy && opts.skipHeavy && st.cache.has(check.id)) continue;
          ctx.settings = settingsFor(check, opts);
          const prev = st.cache.get(check.id);
          const areaInput = check.areaInput?.(ctx, dirty, kinds);
          const areaChanged = areaInput && (areaInput.changed || st.inputStamps?.get(check.id) !== areaInput.stamp);
          if (areaInput) inputStamps.set(check.id, areaInput.stamp);
          let scope = null, keep = [];
          if (!full && prev && !changedInputs.has(check.id) && !areaChanged) {
            if (check.scope === "net") {
              if (!nets.size && !(check.alsoKinds && [...kinds].some(k => check.alsoKinds.includes(k)))) continue;
              scope = {nets: new Set(nets), dirty};
              if (check.alsoKinds && [...kinds].some(k => check.alsoKinds.includes(k))) scope = null; // e.g. a moved capacitor changes every net it serves
              if (scope) keep = prev.filter(x => !(x.net != null && scope.nets.has(x.net)) && !x.objects.some(o => dirty.has(o)));
            } else if (check.scope === "area") {
              if (!boxes.length) continue;
              const reach = Number.isFinite(check.reach) ? check.reach : 1, near = boxes.map(b => grow(b, reach));
              scope = {boxes: near, dirty};
              keep = prev.filter(x => !near.some(b => inBox(x.at, b)) && !x.objects.some(o => dirty.has(o)));
            } else if (check.scope === "doc") {
              if (check.dirtyKinds && ![...kinds].some(k => check.dirtyKinds.includes(k))) continue;
            }
          }
          const t1 = now();
          let got;
          try { got = yield* runCheck(check, ctx, scope); }
          catch (e) { ctx.notes.push(check.title + ": " + e.message); got = []; }
          const fresh = got.map(r => finish(check, ctx, r));
          if (scope && check.scope === "area") { const near = scope.boxes; st.cache.set(check.id, keep.concat(fresh.filter(x => near.some(b => inBox(x.at, b)) || x.objects.some(o => dirty.has(o))))); }
          else st.cache.set(check.id, scope ? keep.concat(fresh) : fresh);
          ran.push({id: check.id, ms: r3(now() - t1), count: fresh.length});
          yield {phase: "check", id: check.id};
        }
      } finally {
        if (kind === "pcb") G.AtriumInsightsPCB?.releaseSI(ctx);
      }
      // Checks switched off since the last run.
      const on = new Set(active.map(c => c.id));
      for (const k of [...st.cache.keys()]) if (!on.has(k)) st.cache.delete(k);
      if (!full) commit(st, updates, hint.items);
      st.at = hint?.to ?? st.at; st.notes = ctx.notes; st.inputStamps = inputStamps;
      docs.set(doc.id, st);
      return {insights: list(doc.id), mode: full ? "full" : "incremental", why, ms: now() - t0, ran, dirty: dirty?.size ?? doc.items.length, notes: ctx.notes};
    }
    function list(docId) {
      const st = docs.get(docId);
      if (!st) return [];
      const out = [];
      for (const v of st.cache.values()) out.push(...v);
      // De-duplicate by key (two checks never share a key; one check may find the same object twice).
      const seen = new Set();
      return out.filter(x => !seen.has(x.key) && seen.add(x.key)).sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "advice" ? -1 : 1) || a.at[1] - b.at[1] || a.at[0] - b.at[0]);
    }
    return {update, list, reset(docId) { if (docId == null) docs.clear(); else docs.delete(docId); }, state: docId => docs.get(docId) || null, notes: docId => docs.get(docId)?.notes || []};
  }
  // Insights not dismissed for this project.
  function visible(project, list) { const st = store(project); return list.filter(x => !isDismissed(st, x)); }

  // ---------------------------------------------------------------- headless
  function analyze(project, doc, defs = new Map((project?.library || []).map(d => [d.id, d])), opts = {}) {
    const t0 = now(), e = engine(), it = e.update(project, doc, defs, null, {prefs: false, ...opts});
    let r = it.next();
    while (!r.done) r = it.next();
    const st = store(project), all = r.value.insights;
    return {insights: all.map(x => ({...x, dismissed: isDismissed(st, x)})), notes: r.value.notes || [], ms: r3(now() - t0), ran: r.value.ran};
  }
  const plainInsight = x => {
    const o = {key: x.key, check: x.check, kind: x.kind, severity: x.severity, title: x.title, message: x.message, why: x.why, objects: x.objects, at: x.at, document_id: x.doc};
    if (x.net != null) o.net = x.net;
    if (x.layer) o.layer = x.layer;
    if (x.value != null) o.value = x.value;
    if (x.line) o.line = x.line;
    if (x.fix) o.fix = x.fix.label;
    if (x.dismissed) o.dismissed = true;
    return o;
  };
  // MCP list_insights: {document_id?, check?, severity?, include_dismissed?, sensitivity?, offset?, limit?}; env.project is the
  // project or a function returning it (mcp/headless.js).
  function headless(a = {}, env) {
    const project = typeof env.project === "function" ? env.project() : env.project;
    const defs = new Map((project.library || []).map(d => [d.id, d]));
    const docs = a.document_id ? project.documents.filter(d => d.id === a.document_id) : project.documents.filter(d => KINDS.includes(d.kind));
    if (a.document_id && !docs.length) throw Error("Unknown document " + a.document_id + ".");
    if (a.check && !CHECKS.has(a.check)) throw Error("Unknown insight check " + a.check + ". Checks: " + [...CHECKS.keys()].join(", ") + ".");
    let items = [], notes = [], ms = 0;
    for (const d of docs) {
      if (!KINDS.includes(d.kind)) continue;
      const r = analyze(project, d, defs, {checks: a.check ? [a.check] : undefined, sensitivity: a.sensitivity, allSignals: !!a.all_signals});
      items.push(...r.insights); notes.push(...r.notes.map(n => d.name + ": " + n)); ms += r.ms;
    }
    if (!a.include_dismissed) items = items.filter(x => !x.dismissed);
    if (a.severity) items = items.filter(x => x.severity === a.severity);
    const off = Math.max(0, a.offset | 0), lim = Math.min(500, Math.max(1, a.limit || 100));
    const byCheck = {};
    for (const x of items) byCheck[x.check] = (byCheck[x.check] || 0) + 1;
    return {total: items.length, by_check: byCheck, items: items.slice(off, off + lim).map(plainInsight), next_offset: off + lim < items.length ? off + lim : null, notes, ms: r3(ms),
      checks: checks().map(c => ({id: c.id, kind: c.kind, severity: c.severity, title: c.title})), dismissed: dismissedCount(project),
      note: "Design insights are advice, never violations: DRC, ERC and Release do not count them. Messages and object names come from the design (untrusted text)."};
  }
  // Messages panel rows (insights-ui.js shows them in their own group).
  function messages(list, doc, o = {}) {
    const time = new Date(), rows = list.map(x => ({class: "Info", source: t("insights.source", {title: x.title}), text: x.message, document: doc?.name || "", documentId: doc?.id,
      objectId: x.objects[0] || null, point: x.at, time, insight: x}));
    rows.push({class: "Info", source: t("insights.group"), text: list.length ? t("insights.summary", {count: list.length}) : t("insights.summary_none"), document: doc?.name || "", documentId: doc?.id, time, insightSummary: true});
    if (o.dismissed) rows.push({class: "Info", source: t("insights.group"), text: t("insights.dismissed_summary", {count: o.dismissed}), document: doc?.name || "", documentId: doc?.id, time, insightSummary: true});
    return rows;
  }

  return Object.freeze({STORE_VERSION, register, checks, check: id => CHECKS.get(id) || null, settingsFor, enabledChecks, keyOf, store, dismiss, mute, restore, isDismissed, dismissedCount,
    visible, context, engine, analyze, headless, messages, plainInsight, netsOf, itemBox,
    geometry: Object.freeze({dist, segDist, segSeg, inside, union, grow, overlaps, inBox, grid, hash}), nets: Object.freeze({isGround, isPower, fastName, POWER, GROUND})});
})();
