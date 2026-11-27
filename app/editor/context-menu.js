"use strict";
// Object context menus, Altium style: right-click on the canvas, Shift+F10 or the Menu key.
// crossprobe.js owns the trigger (it ends any live tool, selects what was clicked, and keeps
// Cross Probe / Cross Select); once this module has loaded (lazy, on the first right-click) it
// delegates the menu to open() here, which builds the entries for the object under the pointer:
//
//   part          Properties, Find Similar, Cross Probe, Edit Footprint / Symbol, Lock, Flip, Swap ▸
//   wire / label  Select Net, Highlight Net, Split Wire, Find Similar, Cross Probe (schematic)
//   track / net   Select Net, Highlight Net, Length Tune, Net Properties, Delete Net Copper, Constraints
//   via / pad     Properties, Via Stack, Select Net, Highlight Net, Via Fence
//   pour          Repour (this pour), Repour All, Edit Outline, Pour Properties, Polygon Manager, Live Pours
//   room          Move Room, Fit Rooms, Lock Rooms, Copy Room Formats
//   DRC marker    Fix, Explain, Ignore Until Next Check, Waive… (saved with the board), Show in Messages, Rules
//   empty canvas  Paste, Place ▸, View ▸ (with the overlay toggles checked), Select All
//   every object and the canvas end with Add Comment (Annotate mode's composer on what was clicked)
//
// Every entry names an action id, the same one the menus, palette and keymap use, so the menu
// shows the key hint and scripts/reachability.py can list it. A few net and DRC actions are
// registered here (select-net, highlight-net, net-properties, delete-net-copper, drc-fix,
// drc-explain, drc-ignore, drc-waive); the rest dispatch through the editor (host.act).
// Repour runs repour-selected (polygon-pour.js) on the pour under the pointer, which the
// trigger has selected.
globalThis.AtriumContextMenu = (() => {
  const NC = () => globalThis.AtriumNavCommon;
  const XP = () => globalThis.AtriumCrossProbe;
  // i18n (docs/translating.md): fixed labels match by text inside .nav-menu ("menu" namespace, extracted by
  // scripts/i18n-extract.py); labels and messages built from parts use t(). tx() shows one English string
  // as the current locale has it.
  globalThis.AtriumI18n?.scope?.(".nav-menu", ["menu"]);
  const t = globalThis.AtriumI18n?.define?.({
    "ctx.select_net": "Select Net {net}",
    "ctx.net_history": "Show History of Net {net}",
    "ctx.net_label": "Net {net}",
    "ctx.repour": "Repour {name}",
    "ctx.head_drc": "DRC · {rule}",
    "ctx.filter": "Filter: {query}",
    "ctx.net_selected": "Net {net}: {count} objects selected.",
    "ctx.net_highlight": "Highlighting net {net}.",
    "ctx.net_no_copper": "Net {net} has no unlocked tracks or vias.",
    "ctx.net_deleted_one": "Deleted 1 track and via object on net {net}. Undo restores them.",
    "ctx.net_deleted": "Deleted {count} track and via objects on net {net}. Undo restores them.",
    "ctx.location": "Location {where}",
    "ctx.signal_show": "Show Signal {name}",
    "ctx.signal_declare": "Declare Signal from {net}",
    "ctx.pair_declare": "Declare Differential Pair {name} ({positive}, {negative})"
  }) || ((k, a) => k + " " + Object.values(a || {}).join(" "));
  const tx = s => globalThis.AtriumI18n?.text?.(s, "menu") ?? s;
  const sub = (label, items, o = {}) => ({sub: label, items, ...o});
  const SEP = "-";
  // Entries: [label, action, {when, enabled, check, label, run, kind}]. `kind` limits an entry
  // to the schematic or the board; `when(ctx)` hides it, `enabled(ctx)` greys it out.
  const has = ctx => ctx.sel.length > 0;
  const net = ctx => !!ctx.net;
  const EDIT = [SEP, ["Cut", "cut", {enabled:has}], ["Copy", "copy", {enabled:has}], ["Duplicate", "duplicate", {enabled:has}], ["Delete", "delete", {enabled:has}]];
  // Git (blame.js): who changed the object under the pointer, every change listed.
  const TAIL = [SEP, ["Show History of This Object", "object-history", {when:ctx => !!ctx.item, run:objectHistory}], ["Add Comment", "comment-add", {run:addComment}], ["Cross Select Mode", "cross-select", {check:() => !!XP()?.crossSelect?.()}], ["Rules for This…", "rules", {when:ctx => !!(ctx.item || ctx.net), run:rulesForThis}], ["Properties", "toggle-right", {run:showProperties}]];
  // Filter panel (query.js): the query that matches this object and objects like it.
  const FILTER = ["Filter by This", "query-panel", {run:filterByThis, enabled:ctx => ctx.item !== null}];
  const NET = [
    ["Select Net", "select-net", {when:net, label:ctx => t("ctx.select_net", {net:ctx.net}),
      run:ctx => {if (ctx.host.doc() === ctx.doc) selectNet(ctx.host, ctx.net);}}],
    ["Highlight Net", "highlight-net", {when:net, check:ctx => ctx.host.highlight() === ctx.net}],
    ["Net Properties", "net-properties", {when:net}],
    ["Show Net History", "object-history", {when:net, label:ctx => t("ctx.net_history", {net:ctx.net}), run:ctx => objectHistory(ctx, {net:ctx.net, label:t("ctx.net_label", {net:ctx.net})})}],
    // Signals (signals.js, signals-panel.js): the net's signal, or declaring one; a name-matched pair is offered, never applied.
    ["Show Signal", "signals-panel", {kind:"pcb", when:ctx => !!signalOf(ctx), label:ctx => t("ctx.signal_show", {name:signalOf(ctx).name}), run:ctx => signalsPanel(ctx, P => P.show(ctx.host, signalOf(ctx).name))}],
    ["Declare Signal from Net", "signals-panel", {kind:"pcb", when:ctx => net(ctx) && !!globalThis.AtriumSignals && !signalOf(ctx) && !pairOffer(ctx), label:ctx => t("ctx.signal_declare", {net:ctx.net}),
      run:ctx => signalsPanel(ctx, P => edit(ctx, () => P.actions.newSignal(ctx.host.project(), ctx.doc, {nets:[ctx.net]})))}],
    ["Declare Differential Pair", "signals-panel", {kind:"pcb", when:ctx => !signalOf(ctx) && !!pairOffer(ctx), label:ctx => { const g = pairOffer(ctx); return t("ctx.pair_declare", {name:g.name, positive:g.positive, negative:g.negative}); },
      run:ctx => { const g = pairOffer(ctx); signalsPanel(ctx, P => edit(ctx, () => P.actions.accept(ctx.host.project(), ctx.doc, {suggestion:g}))); }}],
  ];
  const TYPES = {
    part: [
      ["Properties", "toggle-right", {run:showProperties}],
      ["Find Similar Objects…", "find-similar"],
      FILTER,
      ["Cross Probe", "cross-probe", {label:ctx => ctx.kind === "pcb" ? "Show in Schematic" : "Show on Board", run:ctx => XP()?.probe(ctx.target)}],
      SEP,
      ["Edit Footprint…", "edit-footprint", {kind:"pcb"}],
      ["Edit Symbol…", "edit-symbol", {kind:"schematic"}],
      ["Dynamic Connector Pins…", "dynamic-connector-pins", {kind:"schematic", when:ctx => !!ctx.def?.dynamic || /conn/i.test(ctx.def?.name || "")}],
      SEP,
      ["Lock", "lock", {kind:"pcb", when:ctx => !ctx.item.locked}],
      ["Unlock", "unlock", {kind:"pcb", when:ctx => !!ctx.item.locked}],
      ["Flip to Other Side", "flip-side", {kind:"pcb"}],
      ["Rotate Selection", "rotate"],
      ["Mirror Horizontally", "mirror-x", {kind:"schematic"}],
      sub("Swap", [["Swap Components", "swap-components"], ["Next Footprint Size", "swap-variant", {kind:"pcb"}], ["Change Footprint…", "swap-variant-pick"],
        ["Replace Component…", "swap-library"], ["Pin Swap", "pin-swap", {when:hasAction}], ["Gate Swap", "gate-swap", {when:hasAction}]]),
      SEP,
      ["Component Classes…", "component-classes", {kind:"pcb"}],
      ["Component Stress…", "component-stress"],
      ...NET,
      ...EDIT, ...TAIL
    ],
    track: [
      ...NET,
      ["Find Similar Objects…", "find-similar", {kind:"pcb"}],
      FILTER,
      ["Interactive Length Tuning", "length-tune", {kind:"pcb"}],
      ["Interactive Bus Routing", "route-bus", {kind:"pcb"}],
      ["Tune Bus Group", "bus-tune-group", {kind:"pcb", when:ctx => ctx.sel.length > 1}],
      ["Re-route Bus", "bus-reroute", {kind:"pcb", when:ctx => !!globalThis.AtriumBusRoute?.owns?.(ctx.item?.id)}],
      ["Retrace Differential Pair…", "diffpair-retrace", {kind:"pcb", when:ctx => /[_-]?[PN]$|\+$|-$/.test(ctx.net || "")}],
      ["Delete Net Copper", "delete-net-copper", {kind:"pcb", when:net}],
      SEP,
      ["Constraint Manager…", "constraints", {kind:"pcb"}],
      ["Signal Integrity Analysis…", "si-analysis", {kind:"pcb"}],
      ["Timing Vision", "timing-vision", {kind:"pcb", check:checked}],
      ["Fence Selected…", "fence-selected", {kind:"pcb"}],
      ["Teardrops…", "teardrops", {kind:"pcb"}],
      ...EDIT, ...TAIL
    ],
    via: [
      ["Properties", "toggle-right", {run:showProperties}],
      ["Edit Via Stack…", "viaStack", {kind:"pcb", when:ctx => ctx.item.kind === "via"}],
      ["Interactive Bus Routing", "route-bus", {kind:"pcb", when:ctx => ctx.item.kind === "via" || ctx.sel.length > 1}],
      ["Via Templates…", "viaTemplates", {kind:"pcb", when:ctx => ctx.item.kind === "via"}],
      SEP,
      ...NET,
      ["Find Similar Objects…", "find-similar", {kind:"pcb"}],
      FILTER,
      ["Delete Net Copper", "delete-net-copper", {kind:"pcb", when:net}],
      ["Fence Selected…", "fence-selected", {kind:"pcb"}],
      ...EDIT, ...TAIL
    ],
    pour: [
      ["Repour", "repour-selected", {kind:"pcb", label:ctx => ctx.item?.name ? t("ctx.repour", {name:ctx.item.name}) : tx("Repour This Pour"), run:repourThis}],
      ["Repour All", "repour", {kind:"pcb"}],
      ["Edit Outline", "board-edit-vertices", {kind:"pcb", label:() => "Edit Outline", run:editOutline}],
      ["Pour Properties…", "polygon-pour", {kind:"pcb", run:pourProperties}],
      SEP,
      ["Polygon Pour Manager", "pour-manager", {kind:"pcb"}],
      ["Live Pours", "pour-live", {kind:"pcb", check:checked, when:hasAction}],
      ...NET, FILTER,
      ...EDIT, ...TAIL
    ],
    frame: [
      ["Convert Frame to Sheet", "sch-convert-frame", {kind:"schematic", run:convertFrame}],
      ...EDIT, ...TAIL
    ],
    room: [
      ["Move Room", "room-move", {kind:"pcb"}], ["Fit Rooms to Components", "rooms-fit", {kind:"pcb"}], ["Lock / Unlock Rooms", "rooms-lock", {kind:"pcb"}],
      ["Copy Room Formats…", "room-replicate", {kind:"pcb"}], ["Component Classes…", "component-classes", {kind:"pcb"}],
      ...EDIT, ...TAIL
    ],
    wire: [
      ...NET,
      ["Split Wire", "split-wire", {kind:"schematic", when:ctx => ctx.item.kind === "wire"}],
      ["Find Similar Objects…", "find-similar", {kind:"schematic"}],
      FILTER,
      ["Cross Probe", "cross-probe", {label:() => "Show on Board", run:ctx => XP()?.probe(ctx.target), enabled:ctx => !!ctx.target}],
      ...EDIT, ...TAIL
    ],
    marker: [
      ["Fix", "drc-fix", {enabled:ctx => fixable(ctx.marker), label:ctx => fixable(ctx.marker) ? "Fix…" : "Fix (No Automatic Fix)"}],
      ["Explain", "drc-explain"],
      ["Ignore Until Next Check", "drc-ignore"],
      ["Waive…", "drc-waive", {enabled:ctx => waivable(ctx.marker)}],
      SEP,
      ["Show in Messages", "messages", {run:ctx => {
        const show = () => {if (!globalThis.AtriumMessages?.revealProblem?.(ctx.marker, ctx.host.messageContext?.())) ctx.host.act("messages");};
        const L = globalThis.AtriumLazy;
        if (globalThis.AtriumMessages || !L?.need) show(); else L.need("AtriumMessages").then(show, e => ctx.host.info?.(e.message));
      }}],
      ["Rules…", "rules"], ["Run Design Rule Check", "drc"], ["Clear DRC Markers", "drc-clear"],
      ["DRC Markers", "drc-markers", {check:checked}]
    ],
    object: [...NET, FILTER, ["Rotate Selection", "rotate"], ...EDIT, ...TAIL],
    canvas: [
      ["Paste", "paste"],
      sub("Place", [
        ["Component", "library"], ["Wire", "route", {kind:"schematic"}], ["Net Label", "label", {kind:"schematic"}], ["Power Port", "sch-power", {kind:"schematic"}],
        ["Port", "sch-port", {kind:"schematic"}], ["Junction", "junction", {kind:"schematic"}], ["Dynamic Connector", "dynamic-connector", {kind:"schematic"}],
        ["Text String…", "sch-text", {kind:"schematic"}],
        ["Track", "route", {kind:"pcb"}], ["Differential Pair", "route-diffpair", {kind:"pcb"}], ["Via", "via", {kind:"pcb"}],
        ["Polygon Pour", "polygon-pour", {kind:"pcb"}], ["Fill", "pcb-fill", {kind:"pcb"}], ["String", "label", {kind:"pcb"}], ["Linear Dimension", "pcb-dim-linear", {kind:"pcb"}]]),
      sub("View", [
        AtriumKeymap.documentFitEntry(), ["Fit All Objects", "fit-objects"], SEP,
        ["Board Planning Mode", "view-planning", {kind:"pcb"}], ["2D Layout Mode", "view-2d", {kind:"pcb"}], ["3D Layout Mode", "view-3d", {kind:"pcb"}],
        ["View Configuration…", "view-config", {kind:"pcb"}], ["Layer Sets…", "layer-sets", {kind:"pcb", when:hasAction}], SEP,
        ["Show Grid", "grid", {check:checked}], ["Hop-Over Wire Crossings", "sch-hop-overs", {kind:"schematic", check:checked}],
        ["Unrouted Connections", "unrouted", {kind:"pcb", check:checked}], ["DRC Markers", "drc-markers", {kind:"pcb", check:checked}],
        ["Timing Vision", "timing-vision", {kind:"pcb", check:checked}], ["Rooms", "rooms-show", {kind:"pcb", check:checked, when:hasAction}]]),
      SEP,
      ["Select All", "select-all"], ["Filter Panel", "query-panel", {check:checked, when:hasAction}], ["Navigator", "navigator-panel", {check:checked, when:hasAction}],
      ["Update PCB Document…", "eco", {kind:"schematic"}], ["Annotate Schematics…", "annotate", {kind:"schematic"}],
      ["Run Design Rule Check", "drc", {kind:"pcb"}], ["Board Shape…", "board-dimensions", {kind:"pcb"}],
      ["Compare With…", "diff-compare-with"],
      ...TAIL
    ]
  };
  TYPES.pad = TYPES.via;
  TYPES.region = TYPES.pour;

  // ------------------------------------------------------------------ helpers
  // A toggle's state is the one the menu bar shows (the editor and modules keep those in sync).
  function checked(ctx, action) {
    const b = document.querySelector('.menubar [data-action="' + action + '"]');
    return !!b && (b.getAttribute("aria-checked") === "true" || b.dataset.checked === "true" || b.getAttribute("aria-pressed") === "true");
  }
  function hasAction(ctx, action) {
    return !!document.querySelector('[data-action="' + action + '"]') || !!globalThis.AtriumKeymap?.command?.(action) || !!globalThis.AtriumLazy?.forAction?.(action, ctx.kind);
  }
  function showProperties(ctx) {if (document.body.classList.contains("hide-right")) ctx.host.act("toggle-right"); document.getElementById("inspector")?.focus?.();}
  function editOutline(ctx) {ctx.host.select([ctx.item.id], ctx.item.id); ctx.host.info("Drag a vertex handle to move it, or a midpoint to add a vertex. Escape ends.");}
  function pourProperties(ctx) {
    const P = globalThis.AtriumPolygonPour, h = ctx.host;
    if (!P?.open) {h.act("polygon-pour"); return;}
    P.open({doc:h.doc(), defs:h.defs(), unit:h.units(), edit:h.edit, info:h.info, layer:ctx.item.layer || h.activeLayer?.() || "Top", options:{project:h.project()}, polygon:ctx.item});
  }
  // The signal the net under the pointer belongs to, and a name-matched pair it could declare (signals.js).
  function signalOf(ctx) {
    const S = globalThis.AtriumSignals;
    if (!ctx.net || !S?.model || ctx.doc?.kind !== "pcb") return null;
    try { return S.model(ctx.host.project(), ctx.doc).signalOf(ctx.net); } catch { return null; }
  }
  function pairOffer(ctx) {
    const P = globalThis.AtriumSignalsPanel, N = globalThis.AtriumNetIntent, S = globalThis.AtriumSignals;
    if (!ctx.net || ctx.doc?.kind !== "pcb") return null;
    try {
      if (P?.suggestionFor) return P.suggestionFor(ctx.host.project(), ctx.doc, ctx.net);
      // The panel not loaded yet: the same name-based suggestion from net-intent.js (declined ones stay hidden).
      if (!N?.pairs || !S?.model) return null;
      const p = ctx.host.project(), M = S.model(p, ctx.doc), nets = new Set();
      for (const i of ctx.doc.items || []) { if (i.net) nets.add(i.net); for (const n of Object.values(i.pinNets || {})) if (n) nets.add(n); }
      const g = N.pairs([...nets].filter(n => !M.signalOf(n))).find(x => x.positive === ctx.net || x.negative === ctx.net);
      if (!g || p.signals?.declined?.["diff:" + S.hash([g.positive, g.negative].sort()).slice(3)]) return null;
      return {key: "diff:" + S.hash([g.positive, g.negative].sort()).slice(3), kind: "diff", name: g.name, positive: g.positive, negative: g.negative};
    } catch { return null; }
  }
  async function signalsPanel(ctx, fn) {
    const L = globalThis.AtriumLazy;
    if (!globalThis.AtriumSignalsPanel && L?.modules?.().includes("AtriumSignalsPanel")) await L.need("AtriumSignalsPanel");
    const P = globalThis.AtriumSignalsPanel;
    if (!P) { ctx.host.act("signals-panel"); return; }
    fn(P);
  }
  function edit(ctx, fn) { let msg = ""; try { ctx.host.edit(() => { msg = fn(); }); } catch (e) { ctx.host.info(e.message); return; } if (msg) ctx.host.info(msg); }
  // Rules and Constraints Editor (rules.js) opened on the rules that apply to the object under the pointer.
  async function rulesForThis(ctx) {
    const L = globalThis.AtriumLazy, i = ctx.item;
    if (!globalThis.AtriumRules?.rulesFor && L?.modules?.().includes("AtriumRules")) await L.need("AtriumRules");
    const component = i?.kind === "part" ? i.ref || undefined : undefined;
    globalThis.AtriumRules?.rulesFor?.({net:ctx.net || undefined, component, layer:ctx.kind === "pcb" ? i?.layer || undefined : undefined});
    ctx.host.act("rules");
  }
  async function filterByThis(ctx) {
    const L = globalThis.AtriumLazy;
    if (!globalThis.AtriumQuery && L?.modules?.().includes("AtriumQuery")) await L.need("AtriumQuery");
    const Q = globalThis.AtriumQuery;
    if (!Q?.fromItem) {ctx.host.act("query-panel"); return;}
    const project=ctx.host.project();
    if (ctx.doc!==ctx.host.doc()) return;
    const text = Q.fromItem(ctx.doc, ctx.item, {project, defs:ctx.defs});
    Q.toggle(true);
    if (!text) return;
    const r=await Q.applyIndexed(text);
    if (r?.ok) ctx.host.info(t("ctx.filter", {query:text}));
    else if(r) ctx.host.info(r.diagnostics[0]?.message || globalThis.AtriumDesignQuery.unavailable());
  }
  async function objectHistory(ctx, target) {
    const project = ctx.host.project(), session = ctx.host.fileSession?.();
    try {
      const history = await globalThis.AtriumLazy.need("AtriumHistoryEntry");
      if (ctx.host.project() !== project || ctx.host.fileSession?.() !== session) return;
      if (!target && ctx.item) {
        if (ctx.host.doc() === ctx.doc) ctx.host.select([ctx.item.id], ctx.item.id);
        target = history.targetFor(ctx.doc, ctx.item);
      }
      await history.open({target});
    } catch (error) { ctx.host.info(error.message); }
  }
  // Add Comment: Annotate mode (review-annotate.js, lazy) opens its composer beside the clicked object or point.
  async function addComment(ctx) {
    const L = globalThis.AtriumLazy;
    if (!globalThis.AtriumReviewAnnotate && L?.modules?.().includes("AtriumReviewAnnotate")) await L.need("AtriumReviewAnnotate");
    const M = globalThis.AtriumReviewAnnotate;
    if (M?.commentOn) M.commentOn(ctx.item, ctx.point); else ctx.host.act("comment-add");
  }
  function fixes() {return globalThis.AtriumDRCFixes || null;}
  // A violation can be waived when it names an object (drc-waivers.js keeps rule + object IDs).
  function waivable(v) {return !!v && !!v.type && !!(v.id || v.otherId);}
  // Repour this pour: select it (the trigger usually has) and run repour-selected.
  function repourThis(ctx) {
    if (ctx.item?.id && !ctx.sel.includes(ctx.item.id)) ctx.host.select([ctx.item.id], ctx.item.id);
    ctx.host.act("repour-selected");
  }
  function fixable(v) {
    const F = fixes();
    if (F) return F.canFix ? !!F.canFix(v) : !!(F.fix || F.apply || F.open);
    return !!globalThis.AtriumLazy?.modules?.().includes("AtriumDRCFixes");
  }
  async function convertFrame(ctx) {
    const project = ctx.host.project();
    try {
      const module = await AtriumLazy.need("AtriumFrameConversion");
      if (ctx.host.project() === project && ctx.host.doc() === ctx.doc) await module.run(ctx.host, ctx.doc.id, ctx.item.id);
    } catch (error) {ctx.host.info(error.message);}
  }
  function kindOfItem(item) {
    if (!item) return "";
    const k = item.kind;
    if (globalThis.AtriumSchObjects?.isFrame?.(item)) return "frame";
    if (k === "part") return "part";
    if (k === "track" || k === "arc") return "track";
    if (k === "via" || k === "pad") return "via";
    if (k === "polygon") return "pour";
    if (k === "region" || k === "fill" || k === "keepout") return "region";
    if (k === "room") return "room";
    if (k === "wire" || k === "bus" || k === "netlabel" || k === "power" || k === "port") return "wire";
    return "object";
  }
  function context(host, opts = {}) {
    const doc = host.doc(), defs = host.defs(), sel = host.selection(), hit = opts.hit || null;
    let item = hit?.item && hit.doc?.id === doc.id ? hit.item : null;
    if (!item && !opts.hit && sel.length) item = doc.items.find(i => i.id === sel[0]) || null;
    const target = opts.target || (item ? XP()?.targetAt?.(doc, defs, item, hit?.point || null) : XP()?.targetForSelection?.(doc, defs, sel, ""));
    const marker = doc.kind === "pcb" && hit?.pane && opts.clientX != null ? globalThis.AtriumDRCView?.markerAt(hit.pane, opts.clientX, opts.clientY) : null;
    const netName = target?.net || (item ? XP()?.netOf?.(doc, defs, item) : "") || "";
    const type = marker ? "marker" : item ? kindOfItem(item) : sel.length ? "object" : "canvas";
    return {host, doc, defs, kind:doc.kind, sel, item, def:item?.def ? defs.get(item.def) : null, target, marker, net:netName, type, point:hit?.point || null};
  }
  function headOf(ctx) {
    const R = globalThis.AtriumRules;
    if (ctx.type === "marker") {const v = ctx.marker; return t("ctx.head_drc", {rule:v.ruleName || R?.types?.[v.type]?.title || v.type});}
    if (ctx.type === "canvas") return tx(ctx.kind === "pcb" ? "Board" : "Sheet");
    const i = ctx.item, names = {frame:"Frame", part:ctx.kind === "pcb" ? "Component" : "Part", track:"Track", via:i?.kind === "pad" ? "Pad" : "Via", pour:"Polygon Pour", region:"Region", room:"Room", wire:i?.kind === "netlabel" ? "Net Label" : "Wire", object:ctx.sel.length + (ctx.sel.length === 1 ? " Object" : " Objects")};
    return tx(names[ctx.type] || "Object") + (ctx.type === "frame" ? " " + i.text : i?.ref ? " " + i.ref : i?.name ? " " + i.name : "") + (ctx.net ? " · " + ctx.net : "");
  }

  // ------------------------------------------------------------------ table (reachability)
  function resolve(list, ctx) {
    const out = [];
    for (const e of list) {
      if (e === SEP) {if (out.length && out.at(-1) !== SEP) out.push(SEP); continue;}
      if (e.sub) {const items = resolve(e.items, ctx); if (items.some(x => x !== SEP)) out.push({sub:e.sub, items:trim(items)}); continue;}
      const [label, action, o = {}] = e;
      if (o.kind && o.kind !== ctx.kind) continue;
      if (o.when && ctx.item !== undefined && !o.when(ctx, action)) continue;
      out.push({label:o.label && ctx.item !== undefined ? o.label(ctx) : label, action, run:o.run, enabled:!o.enabled || ctx.item === undefined || o.enabled(ctx),
        checked:o.check && ctx.item !== undefined ? !!o.check(ctx, action) : null});
    }
    return trim(out);
  }
  // One entry per action and level (the shared tails repeat Properties and the edit commands).
  function dedupe(list) {const seen = new Set(); return list.filter(e => e === SEP || e.sub || (seen.has(e.action + e.label) ? false : (seen.add(e.action + e.label), true)));}
  function trim(list) {list = dedupe(list); list.splice(0, list.length, ...list.filter((e, i) => !(e === SEP && list[i - 1] === SEP)));while (list[0] === SEP) list.shift(); while (list.at(-1) === SEP) list.pop(); return list;}
  // Static view for scripts/reachability.py: {type: [action ids]} for one editor kind.
  function table(kind) {
    const ctx = {kind, sel:[], item:undefined}, out = {};
    const flat = l => l.flatMap(e => e === SEP ? [] : e.sub ? flat(e.items) : [e.action]);
    for (const [t, list] of Object.entries(TYPES)) {const a = [...new Set(flat(resolve(list, ctx)))]; if (a.length) out[t] = a;}
    return out;
  }
  // Labels for the "…" audit (scripts/reachability.py): [{type, action, label, custom}] for one
  // editor kind. `custom` marks entries that run their own function instead of the action.
  function labels(kind) {
    const ctx = {kind, sel:[], item:undefined}, out = [];
    const walk = (t, l) => {for (const e of l) if (e !== SEP) {if (e.sub) walk(t, e.items); else out.push({type:t, action:e.action, label:e.label, custom:!!e.run});}};
    for (const [t, list] of Object.entries(TYPES)) walk(t, resolve(list, ctx));
    return out;
  }

  // ------------------------------------------------------------------ menu UI
  // menu-fit: keep a menu inside the window (also used by the menu bar, workbench.js). A submenu (`row`
  // = its trigger) is fixed beside its parent menu: after it, else before it, else on the roomier side;
  // level with the row, shifted up to fit. A menu taller than the window scrolls (.menu-scroll shadows).
  // The top edge stays below the macOS title bar (--window-caption-height, docs/ui-library.md).
  const captionTop = () => (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0);
  function fitMenu(menu, row) {
    const s = menu.style, M = 4, W = innerWidth, H = innerHeight, T = M + captionTop();
    s.maxHeight = "";
    if (row) {
      // A parent still running its open animation (translate/scale) would hold the fixed submenu. A finished
      // shared-motion effect still fills its transform and stays the containing block until its promise
      // settles, so end those at once (ui/motion.js) and the submenu is measured against the window.
      for (let n = menu.parentElement; n && n !== document.body; n = n.parentElement) {
        globalThis.AtriumMotionUI?.cancel(n, {finish:true});
        for (const a of n.getAnimations?.() || []) a.finish();
      }
      s.position = "fixed"; s.left = s.top = "0px"; s.right = s.bottom = "auto";
    } else if (menu.dataset.fitX) s.left = s.right = menu.dataset.fitX = "";
    // Use the menu's settled dimensions to fit it even while its entrance scales the box.
    const box = menu.getBoundingClientRect(), r = {left:box.left, top:box.top, width:menu.offsetWidth || box.width, height:menu.offsetHeight || box.height};
    r.right = r.left + r.width; r.bottom = r.top + r.height;
    const w = r.width, h = Math.min(r.height, H - T - M);
    if (row) {
      const p = row.parentElement.parentElement.getBoundingClientRect(), a = p.right - 2, b = p.left + 2 - w;
      s.left = (a + w <= W - M ? a : b >= M ? b : Math.max(M, Math.min(W - p.right > p.left ? a : b, W - M - w))) - r.left + "px";
      s.top = Math.max(T, Math.min(row.getBoundingClientRect().top - 5, H - M - h)) - r.top + "px";
      if (r.height > h) s.maxHeight = h + "px";
    } else {
      // An app-bar menu hangs from a title-bar row and may start in the caption band; it only stops at
      // the bottom. A menu that opens upward past the band keeps its bottom and ends at the band.
      const top = menu.closest(".appbar") ? M : T;
      if (r.top < top || r.bottom > H - M) s.maxHeight = (r.top < top ? r.bottom - top : H - r.top - M) + "px";
      const dx = Math.max(M - r.left, Math.min(0, W - M - r.right));
      if (dx) {s.left = menu.offsetLeft + dx + "px"; s.right = "auto"; menu.dataset.fitX = "1";}
    }
    menu.classList.toggle("menu-scroll", menu.scrollHeight > menu.clientHeight + 1);
  }
  // `marked`: the row a context menu was opened on (Projects panel, document tabs). It keeps a ring for
  // as long as its menu is open, as in Finder: the menu covers the pointer and takes focus, so neither
  // :hover nor :focus can carry it, and the selection (aria-current) is not changed by a right-click.
  // `trigger`: the button a dropdown hangs from. Its menu toggles: a second press on it closes the menu
  // and it stays closed. `pressing` is that button while a press on it is under way: WebKit (the Mac app)
  // does not focus a pressed button, so focus leaves the menu for the body before the click arrives, and
  // closing on that focusout would let the click open the menu again (a flash, not a close).
  let root = null, back = null, portal = null, marked = null, trigger = null, pressing = null;
  function close(refocus = true, instant = false) {
    if (!root) return;
    const r = root, parent = portal;
    root = portal = null;
    const done = () => { r.remove(); parent?.remove(); };
    const surface = globalThis.AtriumSurfaceMotion;
    if (surface) surface.popover(r, false, {done, instant});
    else done();
    trigger?.setAttribute("aria-expanded", "false");
    marked?.removeAttribute("data-context-target"); marked = null;
    if (refocus) back?.focus?.();
    back = trigger = null;
  }
  function build(list, ctx, level) {
    const menu = NC().el("div", null, "nav-menu" + (level ? " nav-submenu" : ""));
    globalThis.AtriumWorkbench?.wholePixels(menu);
    menu.setAttribute("role", "menu");
    const K = globalThis.AtriumKeymap, kind = ctx.kind || ctx.doc?.kind;
    for (const e of list) {
      if (e === SEP) {menu.append(NC().el("hr")); continue;}
      if (e.sub) {
        const wrap = NC().el("div", null, "nav-sub"); wrap.setAttribute("role", "none");
        const t = NC().el("button", null, "nav-menu-item"); t.type = "button"; t.tabIndex = -1; t.setAttribute("role", "menuitem"); t.setAttribute("aria-haspopup", "menu"); t.setAttribute("aria-expanded", "false");
        t.append(NC().el("span", e.sub));
        const inner = build(e.items, ctx, level + 1); inner.setAttribute("aria-label", e.sub);
        t.onclick = () => openSub(wrap, true);
        wrap.addEventListener("pointerenter", ev => {if (ev.pointerType !== "touch") openSub(wrap, false);});
        wrap.addEventListener("pointerleave", ev => {
          if (ev.pointerType === "touch") return;
          if (inner.contains(document.activeElement)) t.focus({preventScroll:true});
          closeSub(wrap);
        });
        wrap.append(t, inner); menu.append(wrap); continue;
      }
      const b = NC().el("button", null, "nav-menu-item"); b.type = "button"; b.tabIndex = -1; if (e.action) b.dataset.menuAction = e.action;
      b.setAttribute("role", e.checked == null ? "menuitem" : e.radio ? "menuitemradio" : "menuitemcheckbox");
      if (e.checked != null) b.setAttribute("aria-checked", String(e.checked));
      b.disabled = !e.enabled;
      b.append(NC().el("span", e.label));
      if (e.action) NC().shortcutBadge(b, K?.hintKey(e.action, kind));
      b.onclick = () => {
        close();
        const run = () => {
          if (ctx.project && ctx.host.project() !== ctx.project) return;
          try {e.run ? e.run(ctx, e.action) : ctx.host.act(e.action);} catch (err) {ctx.host.info(err.message);}
        };
        const L = globalThis.AtriumLazy, modules = ctx.project && !e.run && L?.forAction(e.action, kind);
        if (modules && !L.has(modules)) L.need(modules).then(run, err => ctx.host.info(err.message));
        else run();
      };
      menu.append(b);
    }
    return menu;
  }
  function items(menu) {return [...menu.children].map(n => n.classList.contains("nav-sub") ? n.firstChild : n).filter(n => n.tagName === "BUTTON" && !n.disabled);}
  function openSub(wrap, focus) {
    for (const s of wrap.parentElement.querySelectorAll(":scope > .nav-sub.open")) if (s !== wrap) closeSub(s);
    wrap.classList.add("open"); wrap.firstChild.setAttribute("aria-expanded", "true");
    const inner = wrap.lastChild;
    fitMenu(inner, wrap.firstChild); // menu-fit: replaces the right-edge flip and bottom nudge
    if (focus) items(inner)[0]?.focus();
  }
  function closeSub(wrap) {wrap.classList.remove("open"); wrap.firstChild.setAttribute("aria-expanded", "false"); for (const s of wrap.querySelectorAll(".nav-sub.open")) closeSub(s);}
  function keys(ev) {
    const at = document.activeElement, level = at?.closest?.(".nav-menu"), list = level ? items(level) : [], i = list.indexOf(at), k = ev.key;
    const wrap = at?.parentElement?.classList.contains("nav-sub") ? at.parentElement : null, parent = level?.parentElement?.classList.contains("nav-sub") ? level.parentElement : null;
    const stop = () => {ev.preventDefault(); ev.stopPropagation();};
    if (k === "Escape") {stop(); if (parent) {closeSub(parent); parent.firstChild.focus();} else close(); return;}
    if (k === "Tab") {ev.stopPropagation(); close(); return;}
    if (k === "ArrowRight" && wrap) {stop(); openSub(wrap, true); return;}
    if (k === "ArrowLeft" && parent) {stop(); closeSub(parent); parent.firstChild.focus(); return;}
    const step = {ArrowDown:1, ArrowUp:-1}[k];
    if (step && list.length) {stop(); list[(i + step + list.length) % list.length].focus(); return;}
    if ((k === "Home" || k === "End") && list.length) {stop(); (k === "Home" ? list[0] : list.at(-1)).focus(); return;}
    ev.stopPropagation();
  }
  // opts: {hit, target, clientX, clientY, returnFocus} from crossprobe.js.
  function open(host, x, y, opts = {}) {
    const doc=host.doc();
    if(doc.kind==="drawing"||doc.kind==="panel"){
      const input=globalThis.AtriumCanvasInput,canvas=host.canvas(),view=host.view();
      const local=opts.hit?.pick?opts.hit:input?.documentHit(doc,opts.hit?.point,view.scale());
      if(local?.pick){
        local.pick();
        const list=[{label:tx("Properties"),enabled:true,run:()=>showProperties({host})},
          {label:tx("Zoom to selected object"),enabled:!!local.box,run:()=>input.zoomBox({canvas,view},local.box,()=>host.redraw())}];
        return popup({host},list,tx(local.label),x,y,opts.returnFocus||canvas);
      }
    }
    const ctx = context(host, opts), list = resolve(TYPES[ctx.type] || TYPES.object, ctx);
    return popup(ctx, list, headOf(ctx), x, y, opts.returnFocus || host.canvas());
  }

  // The Projects panel and the document tabs (workbench.js), as Altium's Projects
  // panel: the project (validate, add new or existing documents, save, reveal, close, options) or one
  // document (open, rename, save, reveal, compare, check). Nothing is listed that cannot run here.
  // opts.returnFocus: where Escape or a command returns focus (default the target). A pointer menu passes
  // what was focused before the right-click, so dismissing it does not move focus or ring the row.
  // Project windows (butter.windows): a main-window tab can leave for its own native window.
  function detach(id, strip) {
    const W = globalThis.AtriumProjectWindowClient;
    if (globalThis.AtriumPrefs?.get("butter.windows") !== true || !W || !globalThis.AtriumHost?.workspaceWindow || strip?.id !== "document-tabs") return [];
    return [["Move to New Window", "butter.windows.move-tab-to-new-window", {run:() => globalThis.AtriumLazy.need("AtriumWindowsUI")
      .then(ui => ui.liveSource().run("move-tab-to-new-window", {tab:id})).catch(e => globalThis.AtriumNavHost?.info(e.message))}], SEP];
  }
  function explorer(host, target, x, y, opts = {}) {
    const project = opts.project ?? host.project();
    if (!target.isConnected || host.project() !== project) return;
    const id = target.dataset.doc || target.dataset.tab;
    const doc = id && host.docById(id), H = globalThis.AtriumHost, starter = !!host.isStarter?.();
    const grant = host.folderProject?.()?.grant;
    const onDocument = action => () => { host.selectDocument(id); host.act(action); };
    const compare = fn => () => globalThis.AtriumLazy.need("AtriumDiffView").then(fn, e => host.info(e.message));
    const reveal = revealable(host) ? [["Reveal in Finder", "reveal-project"]] : [];
    const save = [["Save Project", "save"], ["Save Project As…", "save-as"]];
    // A document tab (the document strip or a split pane's strip, split-tabs.js): Altium's Close commands
    // first (doc-tabs.js, lazy), counted in the strip the tab is in.
    const strip = doc && target.dataset.tab ? target.closest?.(".pane-tabs, #document-tabs") : null;
    const tabs = strip ? [...strip.querySelectorAll("[data-tab]")].filter(n => !n.hidden).map(n => n.dataset.tab) : [], at = tabs.indexOf(id);
    const pane = strip?.classList.contains("pane-tabs") ? +strip.dataset.pane : null, kinds = tabs.map(x => host.docById(x)?.kind);
    const close = cmd => () => globalThis.AtriumLazy.need("AtriumDocTabs").then(T => T.run(host, cmd, {id, pane}), e => host.info(e.message));
    const ofKind = {schematic:"Close All Schematic Documents", pcb:"Close All PCB Documents", drawing:"Close All Draftsman Documents",
      panel:"Close All Panel Documents"}[doc?.kind] || "Close All " + (doc?.kind ? doc.kind[0].toUpperCase() + doc.kind.slice(1) : "") + " Documents";
    const closing = strip ? [
      ["Close", "close-document", {run:close("close")}],
      ["Close Others", "close-others", {run:close("others"), enabled:() => tabs.length > 1}],
      ["Close Documents to the Right", "close-right", {run:close("right"), enabled:() => at >= 0 && at < tabs.length - 1}],
      ["Close Documents to the Left", "close-left", {run:close("left"), enabled:() => at > 0}],
      ["Close All", "close-all", {run:close("all")}],
      [ofKind, "close-kind", {run:close("kind"), enabled:() => kinds.includes(doc.kind)}],
      ["Close Saved Documents", "close-saved", {run:close("saved")}],
      SEP, ...detach(id, strip)] : [];
    const actions = doc ? [...closing,
      ["Open Document", "select", {run:() => host.selectDocument(id)}],
      ["Rename Document…", "rename-document", {run:onDocument("rename-document")}],
      SEP, ...save, ...reveal,
      SEP,
      ["Compare With…", "diff-compare", {run:compare(v => v.open({doc:id}))}],
      ...(grant && grant === H?.folderGitGrant && H.gitHead
        ? [["Compare With HEAD", "diff-compare", {run:compare(v => v.quick({type:"head"}, {type:"working"}, id))}]] : []),
      ...(doc.kind === "pcb" ? [["Run Design Rule Check", "drc", {run:onDocument("drc")}]]
        : doc.kind === "schematic" ? [["Validate Project (ERC)", "compile", {run:onDocument("compile")}]] : [])
    ] : [
      ["Validate Project", "compile"],
      SEP,
      sub("Add New to Project", [["Schematic Sheet…", "add-schematic"], ["PCB Layout…", "add-pcb"], ["Drawing…", "add-drawing"]]),
      ["Add Existing to Project…", "add-existing"],
      SEP, ...save, ...reveal,
      SEP, ...projectControl(starter),
      SEP,
      ["Compare Revisions…", "diff-compare"],
      SEP,
      ["Project Options…", "erc"]
    ];
    const ctx = {host, project, doc:doc || host.doc(), item:null};
    const menu = popup(ctx, resolve(actions, ctx), doc?.name || (starter ? "Untitled" : project.name), x, y, opts.returnFocus === undefined ? target : opts.returnFocus);
    if (target.matches?.("[data-doc], [data-tab], summary")) {marked = target; target.setAttribute("data-context-target", "");}
    return menu;
  }
  // The File menu's project commands (same actions, so the same shortcuts and handlers).
  function projectControl(starter) {
    return [["New Project…", "new"], ["Open Project…", "open"], SEP, ["Close Project", "close-project", {enabled:() => !starter}]];
  }
  function projectActions(host, trigger, project) {
    if (host.project() !== project || !trigger.isConnected || !trigger.getClientRects().length) return;
    if (root && back === trigger) {close(); return;}
    const ctx = {host, project, doc:host.doc(), item:null};
    const add = trigger.dataset.projectMenu === "add";
    const actions = add ? [
      ["Add New Schematic…", "add-schematic"], ["Add New PCB…", "add-pcb"], ["Add New Drawing…", "add-drawing"],
      SEP, ["Add Existing to Project…", "add-existing"],
      SEP, ...projectControl(!!host.isStarter?.()),
    ] : [
      ["Validate Project", "compile"], ["Project Options…", "erc"],
      ...(importable(host) ? [["Import Report", "import-report"]] : []),
      ...(revealable(host) ? [["Reveal in Finder", "reveal-project"]] : []),
    ];
    const list = resolve(actions, ctx);
    if (!add) {
      const label = globalThis.AtriumProjectTree?.connectionLabel(project) ?? t("project.connection_scope", {value:"Global"});
      list.unshift({label, action:"project-connection-scope", enabled:true, run:() => globalThis.AtriumLazy.need(["AtriumProjectConnections", "AtriumRules"])
        .then(() => host.project() === project && globalThis.AtriumProjectConnections.open(host)).catch(error => host.info(error.message))}, SEP);
    }
    const box = trigger.getBoundingClientRect();
    popup(ctx, list, trigger.getAttribute("aria-label"), box.left, box.bottom, trigger, true);
    hang(trigger);
  }
  // An imported design keeps its import report here and in Reports, not in Properties.
  function importable(host) {
    const R = globalThis.AtriumImportReports, project = host.project?.();
    return R ? R.available() : !!(project?.importNotes?.length || project?.documents?.some(d => d.sourceName || d.sourceRules?.length || d.notes?.length));
  }
  function revealable(host) {
    const H = globalThis.AtriumHost, grant = host.folderProject?.()?.grant;
    return !!(H?.canRevealProject && H.revealProject && grant && grant === H.folderGitGrant);
  }

  // ------------------------------------------------------------------ project actions
  // Close Project: unsaved edits are saved, discarded or kept (Cancel) first, then the window returns
  // to the empty starter and Home. The closed project is no longer reopened at the next launch.
  async function closeProject(host) {
    if (host.isStarter?.()) return true;
    const project = host.project(), current = () => host.project() === project;
    const name = project.name || "Untitled";
    const pending=host.importSession?.();
    if (globalThis.AtriumForeignDrafts?.needsReview(host)) { if (!await globalThis.AtriumForeignDrafts.review(host)) return false; }
    else if (host.isDirty?.()) {
      const S = globalThis.AtriumShell, p = document.createElement("p");
      p.textContent = "Your changes to “" + name + "” are lost if you close it without saving.";
      const choice = S?.dialog ? await S.dialog({title:"Save changes to “" + name + "” before closing?", body:[p], className:"close-project-dialog",
        actions:[{label:"Cancel"}, {label:"Don’t Save"}, {label:"Save", primary:true}]}).done : (globalThis.confirm?.("Close " + name + " without saving?") ? "Don’t Save" : null);
      if (!current()) return false;
      if (choice === "Save") { if (await host.saveProject?.() === false || !current() || host.isDirty()) return false; }
      else if (choice !== "Don’t Save") return false;
    }
    const empty = globalThis.Atrium.project("Untitled", globalThis.AtriumParts?.catalogue || []);
    if (!current() || !await host.replaceProject(empty, {copy:true, force:true, starter:true, current})) return false;
    if (pending) await globalThis.AtriumForeignDrafts.release(pending);
    globalThis.AtriumAutosave?.closed?.();
    host.info?.("Closed " + name);
    host.act("start-page");
    return true;
  }
  // Add Existing to Project…: a schematic, board or library document joins the open project.
  async function addExisting(host) {
    const project = host.project(), H = globalThis.AtriumHost;
    const isCurrent = () => host.project() === project;
    const current = () => { if (!isCurrent()) throw new DOMException("The project changed.", "AbortError"); };
    const add = files => files?.length && isCurrent() ? host.openFiles(files, {into:true, current}) : null;
    const [registry,files] = await AtriumLazy.need(["AtriumTranslatorRegistry","AtriumEditorFiles"]);
    if (!isCurrent()) return;
    const kinds = [...files.nativeMemberSuffixes,...registry.list("import").filter(row => row.group === "design")
      .flatMap(row => row.extensions.filter(ext => !row.projectExtensions?.includes(ext)))];
    if (H?.open) { H.open(kinds, {into: true}).then(add, e => host.info(e.message)); return; }
    const input = document.createElement("input");
    input.type = "file"; input.multiple = true; input.accept = kinds.join(",");
    input.onchange = () => add(Array.from(input.files || []));
    input.click();
  }
  function revealProject(host) {
    if (!revealable(host)) return;
    globalThis.AtriumHost.revealProject().catch(e => { if (e.name !== "AbortError") host.info(e.message); });
  }

  // A menu opened at the pointer starts this far up and left of it, so the pointer lands inside the
  // menu's rounded corner instead of falling through to the row or object under it (which would show
  // its hover fill beside the context ring).
  const POINTER_INSET = 2;
  function popup(ctx, list, heading, x, y, focus, dropdown = false, above = false, pointer = !dropdown) {
    const switching = !!root;
    close(false, true);
    root = build(list, ctx, 0);
    root.setAttribute("aria-label", heading);
    if (!dropdown) {
      const head = NC().el("div", heading, "nav-menu-head"); head.setAttribute("role", "presentation"); root.prepend(head);
    } else root.classList.add("action-menu");
    root.addEventListener("keydown", keys);
    root.addEventListener("pointermove", ev => {
      if (ev.pointerType === "touch") return;
      const row = ev.target.closest(".nav-menu-item:not(:disabled)");
      if (row && row !== document.activeElement) row.focus({preventScroll:true});
    });
    root.addEventListener("focusout", ev => {
      const menu = ev.currentTarget;
      if (root !== menu || menu.contains(ev.relatedTarget) ||
          (trigger && (trigger === ev.relatedTarget || pressing === trigger))) return;
      if (focus?.tagName === "CANVAS" && !ev.relatedTarget) {
        // A secondary click can leave focus on the body in WebKit. An outside press or
        // window blur already dismisses the menu, so keep keyboard focus for this case.
        queueMicrotask(() => {
          if (root === menu && document.activeElement === document.body) ev.target.focus({preventScroll:true});
        });
        return;
      }
      close(false);
    });
    // WebKit (the Mac app) does not focus a button on click: the press would move focus to the body,
    // the focusout above would close the menu, and the click would never reach the item.
    root.addEventListener("mousedown", ev => ev.preventDefault());
    const dialog = focus?.closest?.("dialog[open]");
    if (dialog) dialog.append(root);
    else {
      portal = NC().el("nav", null, "nav-menu-portal");
      portal.setAttribute("aria-label", tx("Context commands"));
      portal.append(root);
      document.body.append(portal);
    }
    // Fit the menu to the pointer before the entrance starts.
    const r = {width:root.offsetWidth, height:root.offsetHeight};
    if (pointer) {x -= POINTER_INSET; y -= POINTER_INSET;}
    root.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 4)) + "px";
    root.style.top = Math.max(4 + captionTop(), Math.min(above ? y - r.height : y, innerHeight - r.height - 4)) + "px";
    fitMenu(root); // menu-fit: a menu taller than the window scrolls
    root.addEventListener("scroll", ev => {for (const s of ev.target.querySelectorAll?.(":scope > .nav-sub.open") || []) fitMenu(s.lastChild, s.firstChild);}, true);
    back = focus;
    lastCtx = ctx;
    items(root)[0]?.focus();
    globalThis.AtriumSurfaceMotion?.popover(root, true, {instant:switching});
    return root;
  }
  // A press outside the menu closes it, except a press on its trigger: that press's click closes it.
  if (typeof document !== "undefined") {
    document.addEventListener("pointerdown", e => {
      pressing = trigger?.contains(e.target) ? trigger : null;
      if (root && !root.contains(e.target) && !pressing) close(false);
    }, true);
    // A touch press focuses (or, in WebKit, blurs) only after pointerup: the press ends with its click.
    document.addEventListener("click", () => { pressing = null; }, true);
    addEventListener("blur", () => { if (back?.tagName === "CANVAS") close(false); });
    // A menu bar menu keeps Escape when WebKit left focus on the body after its title was clicked.
    // (The menu bar loads this module when its first menu opens.)
    addEventListener("keydown", e => {
      const menu = e.key === "Escape" && !root && document.querySelector(".work-menu[open] > .menu-items:not([inert])")?.parentElement;
      if (!menu || menu.contains(e.target) || e.target.closest?.("dialog[open]")) return;
      e.preventDefault(); e.stopPropagation();
      globalThis.AtriumWorkbench?.dismiss?.();
      menu.querySelector(":scope > summary")?.focus();
    }, true);
  }
  // A menu that hangs from a button: the button shows it as expanded and a second press closes it.
  function hang(button) {
    trigger = button;
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "true");
  }

  // ------------------------------------------------------------------ actions
  let lastCtx = null;
  globalThis.AtriumKeymap?.onChange(() => {
    if (!root || !lastCtx) return;
    const kind = lastCtx.kind || lastCtx.doc?.kind;
    for (const b of root.querySelectorAll("[data-menu-action]")) {
      NC().shortcutBadge(b, AtriumKeymap.hintKey(b.dataset.menuAction, kind));
    }
    fitMenu(root);
  });
  // The net of the selection (or the highlight) when an action runs from the palette or a key.
  function netNow(host) {
    if (lastCtx?.net && lastCtx.doc === host.doc()) return lastCtx.net;
    const t = XP()?.targetForSelection?.(host.doc(), host.defs(), host.selection(), "");
    return t?.net || host.highlight() || "";
  }
  function markerNow(host) {
    if (lastCtx?.marker) return lastCtx.marker;
    return globalThis.AtriumDRCView?.violations?.(host.currentId())?.[0] || null;
  }
  function selectNet(host, n = netNow(host)) {
    if (!n) {host.info("Select an object on a net first."); return;}
    const doc = host.doc(), found = XP()?.netObjects?.(doc, host.defs(), n), ids = found?.ids || [];
    const selectable = host.selectable ? new Set(doc.items.filter(item => host.selectable(item)).map(item => item.id)) : null;
    const selected = selectable ? ids.filter(id => selectable.has(id)) : ids;
    host.select(selected); host.info(t("ctx.net_selected", {net:n, count:selected.length}));
  }
  function highlightNet(host) {
    const n = netNow(host); if (!n) {host.info("Select an object on a net first."); return;}
    const on = host.highlight() !== n; host.setHighlight(on ? n : ""); host.info(on ? t("ctx.net_highlight", {net:n}) : tx("Net highlight cleared."));
  }
  function netProperties(host) {
    const n = netNow(host); if (!n) {host.info("Select an object on a net first."); return;}
    const N = globalThis.AtriumNetsPanel;
    if (N?.reveal) N.reveal(n); else host.act("nets-panel");
  }
  function deleteNetCopper(host) {
    const n = netNow(host), d = host.doc();
    if (!n || d.kind !== "pcb") {host.info("Select a track or via on a net first."); return;}
    const copper = new Set(["track", "arc", "via"]), gone = d.items.filter(i => copper.has(i.kind) && i.net === n && !i.locked);
    if (!gone.length) {host.info(t("ctx.net_no_copper", {net:n})); return;}
    const ids = new Set(gone.map(i => i.id));
    host.edit(() => {d.items = d.items.filter(i => !ids.has(i.id));});
    host.select([]); host.info(gone.length === 1 ? t("ctx.net_deleted_one", {net:n}) : t("ctx.net_deleted", {count:gone.length, net:n}));
  }
  async function drcFix(host) {
    const v = markerNow(host); if (!v) {host.info("Right-click a DRC marker to fix it."); return;}
    if (!fixes() && globalThis.AtriumLazy?.modules?.().includes("AtriumDRCFixes")) await AtriumLazy.need("AtriumDRCFixes");
    const F = fixes(), fn = F && (F.fix || F.apply || F.open);
    if (!fn) {host.info("No automatic fix for this violation. Explain shows the rule and the measured value."); return;}
    return fn.call(F, host, v);
  }
  function drcExplain(host) {
    const v = markerNow(host); if (!v) {host.info("Right-click a DRC marker to explain it."); return;}
    const M = globalThis.AtriumDRCMarkers, d = M?.describe ? M.describe(v, host.units()) : {title:v.ruleName || v.type, measured:v.detail || "", objects:[], where:""};
    const el = NC().el, body = [el("p", d.measured || "No measurement recorded."), ...(d.detail ? [el("p", d.detail)] : [])];
    if (d.objects?.length) {const ul = el("ul"); for (const o of d.objects) ul.append(el("li", o)); body.push(ul);}
    if (d.where) body.push(el("p", t("ctx.location", {where:d.where.replace(/^at /, "")})));
    body.push(el("p", "The rule comes from Design › Rules. Fix applies a suggested change when one exists; Ignore hides this marker until the next check.", "side-note"));
    const S = globalThis.AtriumShell;
    if (!S?.dialog) {host.info(d.title + ": " + d.measured); return;}
    S.dialog({title:d.title, body, actions:[{label:"Rules…", run:() => {host.act("rules");}}, {label:"Close", primary:true}]});
  }
  function drcIgnore(host) {
    const v = markerNow(host), list = globalThis.AtriumDRCView?.violations?.(host.currentId());
    const i = list ? list.indexOf(v) : -1;
    if (i < 0) {host.info("Right-click a DRC marker to ignore it."); return;}
    list.splice(i, 1); lastCtx = null; host.invalidate();
    host.info("Marker hidden until the next design rule check.");
  }
  // Waive…: a persistent waiver (drc-waivers.js, lazy) with an optional note.
  async function drcWaive(host) {
    const v = markerNow(host);
    if (!v || !(globalThis.AtriumDRCView?.violations?.(host.currentId()) || []).includes(v)) {host.info("Right-click a DRC marker to waive it."); return;}
    if (!waivable(v)) {host.info("This violation names no object, so it cannot be waived. Ignore Until Next Check hides it for this session."); return;}
    if (!globalThis.AtriumDRCWaivers && globalThis.AtriumLazy?.modules?.().includes("AtriumDRCWaivers")) await AtriumLazy.need("AtriumDRCWaivers");
    const W = globalThis.AtriumDRCWaivers;
    if (!W) {host.info("Waivers are unavailable in this build."); return;}
    lastCtx = null;
    W.waiveDialog(host, v, () => globalThis.AtriumDRCView?.refresh?.());
  }
  function attach(host) {
    host.registerAction("drc-waive", () => drcWaive(host));
    host.registerAction("select-net", () => selectNet(host));
    host.registerAction("highlight-net", () => highlightNet(host));
    host.registerAction("net-properties", () => netProperties(host));
    host.registerAction("delete-net-copper", () => deleteNetCopper(host));
    host.registerAction("drc-fix", () => drcFix(host));
    host.registerAction("drc-explain", () => drcExplain(host));
    host.registerAction("drc-ignore", () => drcIgnore(host));
    host.registerAction("close-project", () => closeProject(host));
    host.registerAction("add-existing", () => addExisting(host));
    host.registerAction("reveal-project", () => revealProject(host));
    host.on?.("document", () => {lastCtx = null;});
    host.on?.("selection", () => {if (lastCtx && !root) lastCtx = null;});
  }
  // The browser's editing menu also contains page navigation or inspection commands.
  // Snapshot the user's selection before focusing the menu. Let the editing engine
  // perform text mutations so input events and the field's native undo stack survive.
  function editing(target, field, x, y) {
    const host = globalThis.AtriumNavHost, doc = target.ownerDocument;
    const selection = doc.getSelection(), range = selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    const input = field && (field.tagName === "INPUT" || field.tagName === "TEXTAREA");
    const start = input ? field.selectionStart : null, end = input ? field.selectionEnd : null;
    const text = start != null ? field.value.slice(start, end) : selection?.toString() || "";
    const writable = !!field && !field.readOnly && !field.disabled;
    const readable = !!text && field?.type !== "password";
    function restore() {
      field?.focus({preventScroll:true});
      if (start != null) field.setSelectionRange(start, end);
      else if (range) { selection.removeAllRanges(); selection.addRange(range); }
    }
    const shortcut = name => host?.info("Use " + (NC().isMac() ? "⌘" : "Ctrl+") + name + " to use the system clipboard.");
    async function transfer(op) {
      restore();
      try { if (doc.execCommand(op)) return; } catch { /* Try the system clipboard. */ }
      const unchanged = () => field?.isConnected && doc.activeElement === field &&
        (!input || (field.selectionStart === start && field.selectionEnd === end && field.value.slice(start, end) === text));
      const clipboard = globalThis.navigator?.clipboard;
      try {
        if (op === "paste") {
          const value = await clipboard.readText();
          if (unchanged()) doc.execCommand("insertText", false, value);
        } else {
          await clipboard.writeText(text);
          if (op === "cut" && unchanged()) doc.execCommand("delete");
        }
      } catch { shortcut({copy:"C", cut:"X", paste:"V"}[op]); }
    }
    const list = [];
    const add = (label, enabled, run) => list.push({label:tx(label), enabled, run});
    if (writable) add("Cut", readable, () => transfer("cut"));
    add("Copy", readable, () => transfer("copy"));
    if (writable) add("Paste", true, () => transfer("paste"));
    if (field) add("Select All", true, () => {
      restore(); if (input) field.select(); else doc.execCommand("selectAll");
    });
    popup({host}, list, tx("Text"), x, y, target, true, false, true);
  }
  function dropdown(trigger, entries, {host = globalThis.AtriumNavHost, above = false} = {}) {
    if (root && back === trigger) {close(); return;}
    const box = trigger.getBoundingClientRect(), label = trigger.getAttribute("aria-label") || trigger.textContent.trim();
    const commands = entries.map(entry => entry instanceof HTMLElement
      ? {label:entry.textContent, enabled:!entry.disabled, run:() => entry.click()} : entry);
    popup({host, doc:host?.doc?.()}, commands, label, box.left, above ? box.top : box.bottom, trigger, true, above);
    hang(trigger);
  }
  function statusItems(statusMore) {
    const bar = statusMore.closest(".statusbar"), items = [];
    for (const control of bar.querySelectorAll(":is(.status-sync,.hv-status,.variant-switch,.revision-chip):not([hidden])")) {
      if (control.matches(".variant-switch")) {
        const select = control.querySelector("select");
        items.push({sub:"Assembly variant", items:[...select.options].filter(option => !option.disabled).map(option => ({
          label:option.textContent, enabled:!select.disabled, checked:option.value === "@manage" ? null : option.selected, radio:true,
          run:() => {
            if (option.parentElement !== select) return;
            select.value = option.value;
            select.dispatchEvent(new Event("change", {bubbles:true}));
          }
        }))});
      } else {
        const label = control.textContent.trim();
        if (!label) continue;
        items.push({label, enabled:!control.disabled, run:() => {
          if (control.isConnected && !control.hidden) control.click();
        }});
      }
    }
    return items;
  }
  NC()?.ready?.(attach);

  return Object.freeze({open, explorer, projectActions, editing, dropdown, statusItems, close, isOpen:() => !!root, table, labels, context, TYPES, attach, fitMenu});
})();
