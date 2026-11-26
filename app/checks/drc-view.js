"use strict";
// DRC in the docked Messages panel, violation markers on the board, and online DRC.
//
// Tools → Run Design Rule Check runs every rule (AtriumRules.drc) and lists the result in
// Messages (grouped "DRC", one row per violation plus a rule summary) with Run DRC,
// Rules… and Report… buttons. The board shows each violation Altium-style: the
// offending primitives outlined plus a marker glyph at `at` (drc-markers.js). Hovering a
// marker writes one line in the status bar; clicking it opens the Violation inspector
// (drc-inspector.js) in the Properties pane. Nothing pops up over the board.
//
// Online DRC (Tools → Online DRC, on by default) re-checks only the objects an edit
// touched and their neighbourhood, within a time budget. It is a client of the one check
// scheduler (checks.js): the work runs in the edit pipeline's "rules" phase right after the
// edit's first frame (a large edit continues in idle slices), and a newer edit abandons it.
// Every visible board's result is published to the check store (Problems, F8, MCP check).
//
// Headless API (pure):
//   AtriumDRCView.toMessages(result, {doc, unit})     → Messages rows
//   AtriumDRCView.online({budget})                    → {update(doc, defs, rules, hint?) → {violations, mode, ms, dirty}}
//     An editor hint includes the current resolved board view. Standalone callers use the
//     same physical bounds from a detached board snapshot.
//   AtriumDRCView.signature(item)                     → change signature of an object
//
// Waivers (drc-waivers.js, lazy): violations waived with the board (doc.drcWaivers) leave the
// markers and counts; Messages lists them in a collapsible "Waived (N)" group, reports keep them.
globalThis.AtriumDRCView = (() => {
  const C = globalThis.AtriumNavCommon;
  const R = () => globalThis.AtriumRules;
  const A = () => globalThis.Atrium;
  const onlineMode = {checkMode:"online"};
  const nativeExtras = ["netAntennae", "courtyard"];
  const extrasSelected = d => nativeExtras.some(type => R()?.checkSelected(d, type, onlineMode));
  const extrasFor = d => extrasSelected(d) ? globalThis.AtriumDRCFixes : undefined;
  const homeOpen = () => globalThis.AtriumStartPage?.isOpen?.() === true;
  // Net-wide checks stay in batch DRC; unrouted connections show as ratsnest, not markers.
  const NET_WIDE = new Set(["unrouted", "modifiedPolygon", "length", "matchedLengths", "delay", "matchedDelays"]);
  // Checks that read poured copper (pcbDrawing.pours): a refill re-runs only these. Creepage Distance
  // (creepage.js regionFeatures) measures poured regions too, so a pour that refills closer to a mains net
  // shows its marker without another edit.
  const COPPER_TYPES = new Set(["polygonConnect", "returnPath", "creepage"]);
  const rulesOf = (doc, project) => R().stored(doc, project) || R().defaults();

  // ------------------------------------------------------------------ messages
  function measure(v, unit) {
    try {return globalThis.AtriumDRC?.message ? AtriumDRC.message(v, unit) : (R().types[v.type]?.title || v.type) + ": " + v.title;}
    catch {return v.title || v.type;}
  }
  // Plain words first for the most common newcomer message, then the Altium-style detail.
  function plain(v) {
    const m = v.type === "unrouted" && /^Net (.+) between (.+) and (.+)$/.exec(v.title || "");
    return m ? m[2] + " and " + m[3] + " are not connected (net " + m[1] + ") · " : "";
  }
  // Rules that passed collapse into one Info row; choosing it lists them (expanded: true).
  // Waived violations (doc.drcWaivers) collapse into a "Waived (N)" row; waivedOpen lists them.
  function toMessages(result, {doc, unit = "mm", expanded = false, waivedOpen = false} = {}) {
    const rows = [], time = new Date(), split = waivers(doc) ? AtriumDRCWaivers.apply(doc, result) : null, waived = split?.waived || [];
    if (split) result = split.result;
    for (const v of result.violations) rows.push({class:v.type === "unrouted" || v.warning ? "Warning" : "Error", source:(v.ruleSet ? v.ruleSet + " › " : "") + (v.ruleName || v.source || v.type), text:plain(v) + measure(v, unit),
      document:doc?.name || "", documentId:doc?.id, objectId:v.id || v.otherId || null, point:v.at || v.otherAt || null, time, drc:v});
    const passed = result.rules.filter(r => !r.count), rule = r => ({class:"Info", source:"Rule summary", text:(r.description || r.name) + ": " + (r.count ? r.count + " violation" + (r.count === 1 ? "" : "s") : "passed"),
      document:doc?.name || "", documentId:doc?.id, time});
    for (const r of result.rules) if (r.count) rows.push(rule(r));
    if (passed.length) {
      rows.push({class:"Info", source:"Rule summary", text:passed.length + " rule" + (passed.length === 1 ? "" : "s") + " passed" + (expanded ? " (click or Enter to hide the list)" : " (click or Enter to list them)"),
        document:doc?.name || "", documentId:doc?.id, time, ruleSummary:true});
      if (expanded) for (const r of passed) rows.push(rule(r));
    }
    rows.push({class:"Info", source:"DRC", text:"Design rule check: " + result.total + " violation" + (result.total === 1 ? "" : "s") + " · " + result.rules.length + " rules checked · " + result.stats.ms + " ms",
      document:doc?.name || "", documentId:doc?.id, time});
    if (waived.length) {
      rows.push({class:"Info", source:"Waived", text:(waivedOpen ? "▾ " : "▸ ") + "Waived (" + waived.length + ")" + (waivedOpen ? " · click or Enter to hide" : " · click or Enter to list them"),
        document:doc?.name || "", documentId:doc?.id, time, waivedSummary:true});
      if (waivedOpen) for (const {violation:v, waiver:w} of waived) rows.push({class:"Info", source:"Waived · " + (v.ruleName || v.type), text:"Waived · " + measure(v, unit) + (w.note ? " · " + w.note : ""),
        document:doc?.name || "", documentId:doc?.id, objectId:v.id || v.otherId || null, point:v.at || v.otherAt || null, time, drc:v, waiver:w.id});
    }
    for (const n of result.notes || []) rows.push({class:"Info", source:"DRC", text:n, document:doc?.name || "", documentId:doc?.id, time});
    return rows;
  }

  let waiverLoad = null;
  const waivers = doc => !!doc?.drcWaivers?.length && !!globalThis.AtriumDRCWaivers;
  // Length and Matched Lengths rules measure with AtriumLength (lazy): load it when the rules need it,
  // then check again from scratch so those results appear without a batch DRC first.
  let lengthLoad = null;
  function lengthModule(rules, scopeReadsLength, failed) {
    const L = globalThis.AtriumLazy;
    if (globalThis.AtriumLength || !L?.modules?.().includes("AtriumLength") ||
        !scopeReadsLength && !(rules?.list || []).some(r => r.type === "length" || r.type === "matchedLengths")) return false;
    lengthLoad ??= L.need("AtriumLength").then(() => {resetCheckDependencies(); schedule();}, failed).finally(() => {lengthLoad = null;});
    return true;
  }
  const unwaived = (doc, list) => waivers(doc) ? AtriumDRCWaivers.split(doc, list).active : list;
  // Markers for a board: active violations, plus its waived ones (drawn as quiet dashed markers).
  function show(d, list, batch = false) {
    const state = stateFor(d), key = stamp(d), held = holdsBatch(state, key);
    state.published = list;
    state.publishedAt = key;
    if (!batch && needsPourCheck(d) && state.poursAt !== key) {
      if (!held) pending(d);
      return;
    }
    const replacesBatch = held && list !== state.heldBatch;
    if (replacesBatch) state.heldBatch = null;
    state.readyAt = key;
    state.pendingAt = state.errorAt = null;
    // Poured copper verified against the Clearance rules (drc-pours.js), kept until the next verification.
    if (state.pours?.length && R().checkSelected(d,"clearance",onlineMode)) list = list.concat(state.pours);
    const split = waivers(d) ? AtriumDRCWaivers.split(d, list) : null;
    shown.set(d.id, split ? split.active : list);
    if (split?.waived.length) waivedShown.set(d.id, split.waived.map(x => ({...x.violation, waived:x.waiver}))); else waivedShown.delete(d.id);
    const id = d.id, publication = () => markerPublications.get(id) === publication && current(d);
    if (shown.get(id).some(v => v.type !== "unrouted" && (v.at || v.otherAt)) || waivedShown.has(id))
      markerPublications.set(id, publication);
    else markerPublications.delete(id);
    publish(d);
    if (replacesBatch && host.doc() === d) {
      const inspector = globalThis.AtriumDRCInspector, inspected = inspector?.current();
      if (inspected && inspected === focused) {
        const pool = inspected.waived ? waivedShown.get(id) || EMPTY : shown.get(id);
        const replacement = inspector.relocate(inspected, pool);
        if (replacement) inspector.open(host, replacement);
        else inspector.close();
      }
    }
  }
  // The check store (checks.js): this board's active and waived online results, and the net-wide
  // ones from the last batch run. Conversion to the shared violation shape is lazy there.
  const adapters = new Map(), EMPTY = Object.freeze([]), netWide = new WeakMap();
  function clearPublished(id) {
    for (const source of ["drc", "drc-waived", "drc-net"]) globalThis.AtriumChecks?.clear?.(id, source);
  }
  function publish(d, pending = false, unavailable = null) {
    const K = globalThis.AtriumChecks;
    if (!K) return;
    let a = adapters.get(d.id);
    if (!a) adapters.set(d.id, a = v => K.fromDRC(v, d.id));
    K.publish(d.id, "drc", shown.get(d.id) || EMPTY, a, {pending, unavailable});
    K.publish(d.id, "drc-waived", waivedShown.get(d.id) || EMPTY, a);
    // Net-wide results change only with a batch run (or a waiver): keep the published list while they hold.
    const key = !pending && batchCurrent(d) ? last.result : null, held = netWide.get(d);
    if (!held || held.key !== key || held.waivers !== d.drcWaivers) netWide.set(d, {key, waivers:d.drcWaivers, list:key ? netWideOf(d) : EMPTY});
    K.publish(d.id, "drc-net", netWide.get(d).list, a, {batch:!!netWide.get(d).key});
  }

  // ------------------------------------------------------------------ online engine
  // Standalone object signature includes every authored field read by rule scopes.
  function signature(i) {return JSON.stringify(i) ?? "";}
  function reachOf(rules) {
    let gap = 0, maskExpansion = 0;
    const silk = rules?.list?.some(r => r.type === "silkToMask" && r.enabled !== false);
    for (const r of rules?.list || []) if (r.enabled !== false) {
      for (const k of ["gap", "clearance", "distance"]) if (Number.isFinite(r[k])) gap = Math.max(gap, r[k]);
      if (silk && r.type === "solderMask" && Number.isFinite(r.expansion)) maskExpansion = Math.max(maskExpansion, r.expansion);
      // Clearance object-kind matrix cells (rules.js) can exceed the rule's own gap.
      if (r.objects && typeof r.objects === "object") for (const v of Object.values(r.objects)) if (Number.isFinite(v)) gap = Math.max(gap, v);
      // Creepage Distance (creepage.js): the largest distance its voltages ask.
      if (r.type === "creepage") gap = Math.max(gap, globalThis.AtriumCreepage?.reach?.(r) || 0);
    }
    return Math.max(gap, .25) + Math.max(.5, maskExpansion);
  }
  function dependencies(doc, defs, rules, hint) {
    // The undo journal tracks edits outside items. Headless callers without a journal can
    // change the outline, stackup or a footprint in place, so compare their content instead.
    const geometry = hint?.outer ?? JSON.stringify([doc.outline, doc.boardShape, doc.stackup, doc.thickness, doc.layers,
      doc.origin, doc.rooms, doc.hdi, doc.viaTemplates, doc.netClasses, doc.componentClasses, doc.sourceRules, doc.ruleCheckSelection,
      doc.pcbDrawing?.annotations, doc.pcbDrawing?.letterSets, hint?.project?.parameters,
      [...(defs?.values?.() || [])].map(def => [def.id, def.footprint])]);
    const polygons = globalThis.AtriumPolygonPour, paths = globalThis.AtriumReturnPath, creepage = globalThis.AtriumCreepage;
    const readsCopper = rules?.list?.some(r => r.enabled !== false &&
      ((polygons && r.type === "polygonConnect") || (paths && r.type === "returnPath") || (creepage && r.type === "creepage")));
    const copper = readsCopper ? (hint?.pours ?? JSON.stringify(doc.pcbDrawing?.pours)) : undefined;
    return {doc, project:hint?.project, defs:hint?.library ?? defs, geometry, copper, polygons, paths};
  }
  // What DRC reads outside the items and the rules: the board's own fields (outline, stackup, rooms …) and
  // the project's signal model, classes and variants. The journal's outer revision moves with any project
  // edit, a rule edit too; a rule edit that leaves this unchanged keeps the online state (rulesChange).
  const PROJECT_DRC = ["signals", "classes", "viaTemplates", "multichannel", "variants", "activeVariant", "variantApplied", "assignments", "units", "layoutBlocks", "ruleSets", "parameters"];
  function outerPrint(doc, project) {
    const p = {};
    if (project) for (const k of PROJECT_DRC) if (project[k] !== undefined) p[k] = project[k];
    return JSON.stringify([doc.outline, doc.boardShape, doc.stackup, doc.thickness, doc.layers, doc.origin, doc.rooms, doc.hdi, doc.viaTemplates, doc.netClasses,
      doc.componentClasses, doc.sourceRules, doc.ruleCheckSelection, doc.pcbDrawing?.annotations, doc.pcbDrawing?.letterSets, p]); // the board fields dependencies() signs without a journal

  }
  function online({budget = 30, maxDirty = 400} = {}) {
    let state = null, partMs = 8;
    const types = (doc = state?.doc) => (R().checkedTypes || Object.keys(R().types)).filter(t => !NET_WIDE.has(t) && R().checkSelected(doc,t,onlineMode));
    const ownerBounds = (geometry, doc, id) => AtriumGeometryReceipts.ownerBounds(geometry,
      {documentId:doc.id,instancePath:[],kind:"item",id});
    function detachedBoard(doc, defs, project) {
      if (!doc.items.length) return null;
      const resolver = globalThis.AtriumResolvedGeometry;
      if (!resolver || !globalThis.AtriumGeometryMaterial || !globalThis.AtriumMaskOpenings) return null;
      const context = project ?? globalThis.AtriumSignals?.projectOf?.(doc);
      const documents = context?.documents ?? [];
      const source = {...context,id:context?.id ?? "drc",library:[...defs.values()],
        documents:documents.includes(doc) ? documents : [doc,...documents.filter(d => d.id !== doc.id)]};
      try {
        return resolver.read({kind:"snapshot",project:source,root:doc,
          revision:{kind:"snapshot",projectId:source.id,rootId:doc.id,generation:"drc"}});
      } catch (error) {
        if (error.code === "STALE_GEOMETRY") return null;
        throw error;
      }
    }
    function indexBoard(doc, view, tracked) {
      return {
        sigs:tracked ? null : new Map(doc.items.map(i => [i.id,signature(i)])),
        boxes:view ? new Map(doc.items.map(i => [i.id,ownerBounds(view,doc,i.id)])) : null
      };
    }
    // The XY candidate index spans every affected layer, including through-holes.
    function indexedChanges(doc, hint, delta, known, physical) {
      const geometry = hint?.geometry, {sigs, boxes} = state, regions = new Map(), dirty = new Set();
      let items = known ? hint.items : null;
      if (geometry) {
        for (const owner of delta?.owners ?? [])
          if (owner.kind === "item" && owner.documentId === doc.id && !owner.instancePath.length) dirty.add(owner.id);
        if ([...dirty].some(id => !known || !hint.ids.has(id)))
          items = new Map(doc.items.filter(item => dirty.has(item.id)).map(item => [item.id,item]));
      } else {
        // A standalone snapshot has no journal of its own. Detect authored record
        // edits before doing any detached geometry work, including on rule-only updates.
        items ??= new Map(doc.items.map(item => [item.id,item]));
        for (const id of known ? hint.ids : new Set([...sigs.keys(),...items.keys()])) {
          const item = items.get(id), next = item && signature(item);
          if (sigs.get(id) === next) continue;
          dirty.add(id);
          if (item) sigs.set(id,next);
          else sigs.delete(id);
        }
      }
      const view = dirty.size && boxes ? physical() : null;
      if (dirty.size && !view) return null;
      const extents = delta && new Map(delta.bounds.map(box => [box.join(","),box]));
      for (const id of dirty) {
        const old = boxes.get(id), item = items.get(id);
        const current = item && ownerBounds(view,doc,id);
        // Pair the canonical old and new extents with their owner for idle slicing.
        regions.set(id,[old,current].map(box => !box || !extents ? box : extents.get(box.join(","))).filter(Boolean));
        if (item) boxes.set(id,current);
        else boxes.delete(id);
      }
      return {dirty,regions,items};
    }
    // A large edit is re-checked in parts (CHUNK changed objects each, split at the median along the
    // longer side of their spread), so each idle slice runs one or a few parts; the parts not yet
    // re-checked stay pending (state.pending) and the next update takes them up with its own changes.
    // Each part is an incremental re-check of its own neighbourhood, so the result is the same set of
    // violations as one pass over every change (the incremental check's locality).
    const CHUNK = 512;
    function partsOf(regions) {
      const all = [...regions].map(([id, bs], k) => {const b = bs.reduce((u, x) => C.union(u, x), null); return {id, bs, k, x:b ? (b[0] + b[2]) / 2 : 0, y:b ? (b[1] + b[3]) / 2 : 0};});
      const out = [];
      const split = list => {
        if (list.length <= CHUNK) {out.push(list); return;}
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const e of list) {x0 = Math.min(x0, e.x); x1 = Math.max(x1, e.x); y0 = Math.min(y0, e.y); y1 = Math.max(y1, e.y);}
        const key = x1 - x0 >= y1 - y0 ? "x" : "y", sorted = [...list].sort((a, b) => a[key] - b[key] || a.k - b.k), m = sorted.length >> 1;
        split(sorted.slice(0, m)); split(sorted.slice(m));
      };
      split(all);
      return out;
    }
    // Shorts on the whole board: the editor's incremental connectivity (connectivity-live.js) through the
    // undo journal, the cache the ratsnest keeps, so a check after the airwires were drawn reuses it.
    const connections = (doc, defs, hint) => hint?.journal && globalThis.AtriumConnectivityLive && globalThis.AtriumConnectivity ? () => AtriumConnectivity.inspect(doc, defs, hint.journal) : undefined;
    function full(doc, defs, rules, rulesSig, t0, why, at, deps, hint, view) {
      const compiled = hint?.compiled ?? R().compiled(doc,{rules,defs,project:hint?.project});
      const c = hint?.connections ?? connections(doc, defs, hint), r = R().drc(doc, defs, rules, {compiled,project:hint?.project,types:types(doc), limit:5000, ...(c ? {connections:c} : null)});
      const geometry = hint?.geometry;
      state = {rulesSig, rulesObj:rules, lib:defs, ...deps, compiled, ...indexBoard(doc, view, !!geometry), revision:geometry?.revision, floor:hint?.floor,
        violations:r.violations, at, certs:null, print:hint ? outerPrint(doc, hint.project) : null,
        content:hint?.library == null ? (({geometry, copper}) => ({geometry, copper}))(hint?.outer != null ? dependencies(doc, defs, rules, null) : deps) : null};
      return {violations:r.violations, complete:r.complete, mode:"full", why, ms:now() - t0, dirty:doc.items.length};
    }
    // Clearance between copper of different nets from margin certificates (drc-certs.js), when the
    // store is built (idle, after the first check: buildStore): a rule edit is answered by arithmetic on
    // the stored distances and an edit re-measures only the pairs it can have brought too close; the
    // sub-board re-check skips Clearance unless it holds a keep-out or a teardrop (the rest of Clearance).
    const CERTS = () => globalThis.AtriumDRCCerts;
    const isKeepout = i => !!globalThis.AtriumPCBDraw?.isKeepout?.(i);
    // A rule-only change: only the checks whose rules changed run
    // again, Clearance from the store; these per-object checks read no other type's rules. Any other
    // change (rule set fields, other rule types) is a full check.
    const SELF = new Set(["clearance", "width", "routingLayers", "viaStyle", "holeSize", "annularRing"]);
    function rulesChange(doc, defs, rules, project) {
      const X = R().kit;
      if (!X || state.pending?.length) return null;
      let a, b;
      try {a = X.migrate(JSON.parse(state.rulesSig)); b = X.migrate(rules);} catch {return null;}
      // defaults and nets mirror the list (rules.js normalize); every other field counts.
      const rest = s => JSON.stringify({...s, list:null, defaults:null, nets:null});
      if (rest(a) !== rest(b)) return null;
      const group = s => {const m = new Map(); for (const r of s.list || []) m.set(r.type, (m.get(r.type) || "") + JSON.stringify(r) + "\n"); return m;};
      const ga = group(a), gb = group(b), changed = new Set();
      for (const t of new Set([...ga.keys(), ...gb.keys()])) if (ga.get(t) !== gb.get(t)) changed.add(t);
      const compiled = R().compiled(doc,{rules,defs,project});
      // A winning width/stack rule is an input to every rule using rule(MinWidth).
      if (changed.has("width")) for (const view of [compiled,state.compiled].filter(Boolean)) {
        for (const [type,rs] of Object.entries(view.byType)) if (rs.some(r=>[r.scopePlan,r.scope2Plan].some(p=>p?.dependencies.includes("rule:MinWidth")))) changed.add(type);
      }
      for (const t of changed) if (!SELF.has(t)) return null;
      const local = new Set(types()), run = new Set([...changed].filter(t => local.has(t)));
      let list = state.violations, store = state.certs, fromStore = null;
      if (run.has("clearance") && store && !compiled.diagnostics.some(d=>d.type==="clearance")) {
        const s = store.setRules(rules), kept = !s.rebuild && store.relabel(list.filter(v => v.type === "clearance" && !CERTS().isPair(v)));
        if (kept) {fromStore = store.violations().concat(kept); run.delete("clearance");} else state.certs = store = null;
      }
      if (run.size) {
        const r = R().drc(doc, defs, rules, {compiled,project,types:[...run], limit:5000});
        list = list.filter(v => !run.has(v.type)).concat(r.violations);
      }
      if (fromStore) list = list.filter(v => v.type !== "clearance").concat(fromStore);
      state.violations = list; state.rulesObj = rules; state.compiled = compiled;
      if (compiled.diagnostics.some(d=>d.type==="clearance")) state.certs = null;
      return {types:[...changed], store:!!fromStore};
    }
    const now = () => globalThis.performance?.now?.() ?? Date.now();
    // hint (optional): {from, to, ids, items, outer}, the items and outer revision from the journal;
    // used when from is where the last check left off, else every object is re-signed.
    // opts.timeRemaining (optional, an idle deadline's): a large edit is re-checked in parts until it
    // runs low (at least one part); the result is then mode "partial" with `pending` parts left, and the
    // next update continues. Without it every part runs.
    function update(doc, defs, rules, hint, opts) {
      const t0 = now(), rulesSig = JSON.stringify(rules), at = hint?.to;
      const deps = dependencies(doc, defs, rules, hint), geometry = hint?.geometry;
      let view = geometry ?? undefined;
      const physical = () => {
        if (view === undefined) view = detachedBoard(doc, defs, hint?.project);
        return view;
      };
      const rebuild = why => full(doc, defs, rules, rulesSig, t0, why, at, deps, hint, physical());
      const known = !!hint?.ids && hint.from != null && state?.at === hint.from;
      // A first check made before the journal knew the project (a board just opened) signed the board's
      // content; when the content is still the same, the journal's versions take over (the first edit
      // after opening is incremental, not a full check).
      if (state && state.doc === doc && state.content && hint?.library != null && hint.outer != null && (state.geometry !== deps.geometry || state.defs !== deps.defs || state.copper !== deps.copper)) {
        const now = dependencies(doc, defs, rules, null);
        if (now.geometry === state.content.geometry) {
          state.geometry = deps.geometry; state.defs = deps.defs;
          if (now.copper === state.content.copper) state.copper = deps.copper;
        }
        state.content = null;
      }
      // The outer journal counts both relevant changes (outline, rules, etc.)
      // and unrelated metadata. Only the board's check inputs need a rebuild.
      const bridge = state && state.doc === doc && state.geometry !== deps.geometry &&
        (state.rulesSig !== rulesSig || geometry) && state.print != null && hint?.outer != null &&
        outerPrint(doc, hint.project) === state.print;
      if (bridge) state.geometry = deps.geometry;
      if (!state || state.doc !== doc || !!state.revision !== !!geometry ||
          state.geometry !== deps.geometry || state.polygons !== deps.polygons || state.paths !== deps.paths) {
        return rebuild(state ? "board dependencies changed" : "first check");
      }
      const metadataOnly = bridge && known && !hint.ids.size && state.floor === hint.floor &&
        state.defs === deps.defs && state.copper === deps.copper;
      const delta = geometry && !metadataOnly ? geometry.changes(state.revision) : null;
      if (delta?.kind === "cold")
        return rebuild("geometry history unavailable");
      if (state.defs !== deps.defs && (!geometry || delta?.owners.some(o => o.kind === "item")))
        return rebuild("board dependencies changed");
      let rulesRun = null;
      if (state.rulesSig !== rulesSig) {
        rulesRun = rulesChange(doc, defs, rules, hint?.project);
        if (!rulesRun) return rebuild("rules changed");
        state.rulesSig = rulesSig; state.lib = defs;
      }
      // A refill refreshes the board-wide checks that read poured copper.
      // Local edit slices leave those findings to the final whole-board pass.
      const copperChanged = state.copper !== deps.copper;
      const refreshCopper = violations => {
        const T = types().filter(t => COPPER_TYPES.has(t));
        const r = T.length ? R().drc(doc, defs, rules, {compiled:state.compiled,project:hint?.project,types:T, limit:5000}) : {violations:[]};
        return violations.filter(v => !COPPER_TYPES.has(v.type)).concat(r.violations);
      };
      const changes = indexedChanges(doc,hint,delta,known,physical);
      if (!changes) return rebuild("geometry unavailable");
      const {dirty,regions,items:changedItems} = changes, {boxes} = state;
      // An anchor, signal path or broken reference may affect an object outside
      // the edited copper's neighborhood. Rebuild the scope against the full board
      // before reusing geometric certificates or publishing an incremental result.
      if (dirty.size) {
        const prior=state.compiled, dep=prior.recheckBoardItems;
        const changesGeometry=prior.dependencies.has("geometry:body") || prior.dependencies.has("geometry:origin");
        if (prior.diagnostics.length || prior.measurementIssues.size || dep.length)
          return rebuild("rule scope dependencies changed");
        if(dep.bound || dep.usesParts || changesGeometry) {
          for(const id of dirty) {
            const item=changedItems.get(id);
            if(dep.anchors.has(id) || dep.names.has(item?.ref) || dep.names.has(item?.name) ||
                dep.usesParts && (!item || item.kind==="part"))
              return rebuild("referenced object changed");
          }
          // The anchor is unchanged. Bind the current revision for the local
          // candidates; a previous revision's prepared predicate cannot be reused.
          state.compiled=R().compiled(doc,{rules,defs,project:hint?.project});
        }
      }
      const pending = state.pending;
      if (!dirty.size && !pending?.length) {
        if (copperChanged) state.violations = refreshCopper(state.violations);
        Object.assign(state, deps, {at, lib:defs, revision:geometry?.revision, floor:hint?.floor});
        return {violations:state.violations, mode:rulesRun ? "rules" : copperChanged ? "copper" : "none", ms:now()-t0,
          dirty:0, tracked:known, ...(rulesRun ? {rules:rulesRun} : null)};
      }
      if (!known && dirty.size > Math.max(maxDirty, doc.items.length * .25)) return rebuild("large edit");
      // This edit's parts first, then those still pending from earlier ones (kept as they were split, so
      // each stays compact).
      const reach = reachOf(rules), parts = (!dirty.size ? [] : dirty.size > CHUNK ? partsOf(regions) : [[...regions].map(([id, bs]) => ({id, bs}))]).concat(pending || []);
      let violations = state.violations, checked = 0, k = 0;
      const store = state.certs, all = types(), local = copperChanged ? all.filter(t => !COPPER_TYPES.has(t)) : all;
      const noClear = store ? local.filter(t => t !== "clearance") : local;
      if (store && dirty.size) store.update(dirty, changedItems);
      const time = typeof opts?.timeRemaining === "function" ? opts.timeRemaining : null;
      for (; k < parts.length; k++) {
        const tp = now();
        if (k && time && time() < 2 * partMs) break;
        const part = new Set(parts[k].map(e => e.id));
        // Merge many small regions into their union to keep the overlap tests cheap.
        let near = parts[k].flatMap(e => e.bs);
        if (near.length > 16) near = [near.reduce((u, b) => C.union(u, b), null)];
        const drop = near.map(b => C.grow(b, reach)), pick = near.map(b => C.grow(b, 2 * reach));
        const inDrop = p => !!p && drop.some(b => C.inside(p, b));
        // Spatial index over item boxes (drc-markers.js) when loaded; the first part passes the objects whose boxes changed.
        let items = globalThis.AtriumDRCMarkers?.pick ? AtriumDRCMarkers.pick(doc, boxes, pick, k ? new Set() : dirty) :
          doc.items.filter(i => {const b = boxes.get(i.id); return b && pick.some(q => C.overlaps(b, q));});
        // Authored checks (for example component height) also have subjects that
        // emit no physical geometry. Include them by id with no spatial neighbours.
        if ([...part].some(id => boxes.has(id) && !boxes.get(id))) {
          const nearby = new Set(items.map(i => i.id));
          items = doc.items.filter(i => part.has(i.id) || nearby.has(i.id));
        }
        const sub = {...doc, items};
        // With the store, Clearance runs here only for what the store does not cover (keep-outs, teardrops).
        const skip = !!store && !items.some(i => isKeepout(i) || i.kind === "graphic" && i.teardrop === true);
        const r = R().drc(sub, defs, rules, {compiled:state.compiled,scopeDoc:doc,project:hint?.project,types:skip ? noClear : local, limit:5000});
        const touches = v => part.has(v.id) || part.has(v.otherId) || inDrop(v.at) || inDrop(v.otherAt);
        violations = violations.filter(v => !touches(v) || (copperChanged && COPPER_TYPES.has(v.type)) ||
          (skip && v.type === "clearance")).concat(r.violations.filter(touches));
        checked += items.length;
        partMs = Math.max(partMs * .5, now() - tp);
      }
      if (store && all.includes("clearance")) {
        // Copper Clearance from the store: the results of the changed objects' pairs (all of them when net
        // ties changed); everything else the store holds is unchanged.
        const isPair = CERTS().isPair, mine = dirty.size ? store.violationsFor(dirty) : [];
        violations = mine ? violations.filter(v => !isPair(v) || !dirty.has(v.id) && !dirty.has(v.otherId)).concat(mine)
          : violations.filter(v => !isPair(v)).concat(store.violations());
      }
      const left = k < parts.length ? parts.slice(k) : null;
      if (copperChanged && !left) violations = refreshCopper(violations);
      state = {...state, ...deps, rulesSig, rulesObj:rules, lib:defs, violations, at,
        copper:left ? state.copper : deps.copper, pending:left, certs:store, revision:geometry?.revision, floor:hint?.floor};
      const ms = now() - t0;
      return {violations, mode:left ? "partial" : "incremental", ms, dirty:parts.reduce((n, p) => n + p.length, 0),
        checked, layers:delta?.layers, overBudget:ms > budget, tracked:known, ...(left ? {pending:parts.length-k} : null)};
    }
    // Seed from a batch run so online results match it until the next edit.
    function seed(doc, defs, rules, violations, at, outer, library, pours, project, batchOptions, geometry, floor) {
      const keep = new Set(types(doc)), local = violations.filter(v => keep.has(v.type));
      // A batch can omit online-only checks. The next online pass must check the whole board.
      if (geometry === null || [...keep].some(t=>!R().checkSelected(doc,t,batchOptions))) {state = null;return local;}
      const compiled = R().compiled(doc,{rules,defs,project});
      const index = indexBoard(doc, geometry ?? detachedBoard(doc, defs, project), !!geometry);
      state = {rulesSig:JSON.stringify(rules), rulesObj:rules, lib:defs, compiled, ...dependencies(doc, defs, rules, {outer,library,pours,project}),
        ...index, violations:local, at, revision:geometry?.revision, floor, certs:null, print:outerPrint(doc,project)};
      return state.violations;
    }
    // The certificate store: wanted once a board is checked (idle work, buildStore), not for rule sets
    // it does not cover (clearance matrix hole cells) or a board where it disagreed with the check.
    function wantsStore() {
      return !!state && !state.certs && state.noCerts !== state.rulesSig && !!CERTS() && !!R()?.kit && !state.pending?.length && types().includes("clearance");
    }
    // Builds the store in steps (an iterator; each next() one step of drc-certs.js building()). It is
    // dropped when the board, its rules or the engine's state changed meanwhile (stamp(): the board's
    // journal version), and kept only when it gives exactly the copper Clearance results the engine
    // holds (a full check's; more than 5,000 results per rule are capped there, and are not kept).
    function* buildStore(stamp) {
      const st = state, sig = st?.rulesSig, v0 = stamp?.();
      if (!wantsStore()) return null;
      const C = CERTS(), gone = () => state !== st || st.rulesSig !== sig || JSON.stringify(st.rulesObj) !== sig || (stamp && stamp() !== v0);
      if (!C.supports(st.doc, st.rulesObj, st.project, st.lib)) {st.noCerts = sig; return null;}
      const it = C.building(st.doc, st.lib, st.rulesObj, {project:st.project});
      let store = null;
      for (;;) {const r = it.next(); if (r.done) {store = r.value; break;} yield; if (gone()) return null;}
      yield;
      if (gone()) return null;
      const key = v => v.id + "|" + v.otherId + "|" + v.ruleId + "|" + v.title + "|" + v.actual + "|" + v.required;
      const mine = store.violations().map(key).sort(), held = st.violations.filter(C.isPair).map(key).sort();
      if (mine.length !== held.length || mine.some((x, k) => x !== held[k])) {st.noCerts = sig; return null;}
      st.certs = store;
      return store;
    }
    return {update, seed, seeded:()=>state !== null, readsLength:()=>state?.compiled?.dependencies.has("field:length"), reset() {state = null;}, violations:() => state?.violations || [], types, at:() => state?.at, pending:() => (state?.pending || []).reduce((n, p) => n + p.length, 0),
      wantsStore, buildStore, store:() => state?.certs || null};
  }

  // ------------------------------------------------------------------ UI state
  let host = null, enabled = true, budget = 30, last = null, manual = null;
  let checks = new WeakMap(), checkedProject, fixesLoad = null;
  const shown = new Map();      // docId → violations drawn as markers
  const waivedShown = new Map(); // docId → waived violations ({...violation, waived:waiver})
  const markerPublications = new Map(); // Render rows stay stable until the next publication.
  let hover = null;
  try {
    const s = JSON.parse(globalThis.localStorage?.getItem("atrium-online-drc") || "null");
    if (s) {enabled = s.enabled !== false; if (s.budget > 0) budget = s.budget;}
  } catch {}
  function bindProject() {
    const project = host.project();
    if (project !== checkedProject) {
      fixesLoad?.clear(); clearPublished(null);
      checkedProject = project; checks = new WeakMap(); shown.clear(); waivedShown.clear(); markerPublications.clear(); last = manual = null; focused = hover = null; adapters.clear();
    }
  }
  function stateFor(d) {
    bindProject();
    let state = checks.get(d);
    if (!state) {
      state = {engine: online({budget}), extra:null, version:null};
      checks.set(d, state); shown.delete(d.id); waivedShown.delete(d.id); markerPublications.delete(d.id); clearPublished(d.id);
    }
    return state;
  }
  function visibleBoards() {
    const active = host?.doc(), boards = active?.kind === "pcb" ? [active] : [];
    for (const pane of host?.panes?.() || []) {
      const d = host.docById?.(pane.docId);
      if (d?.kind === "pcb" && !boards.includes(d)) boards.push(d);
    }
    return boards;
  }
  function redrawBoard(d) {
    if (host.invalidateDocument) host.invalidateDocument(d.id); else host.invalidate();
  }
  const boardVersion = d => globalThis.AtriumUndoStore?.documentVersions?.(d, host.project(), true);
  const boardOuter = (v, fallback) => v ? [v.floor, v.outer, v.project, v.parameters, v.library].join("/") : fallback;
  function stamp(d) {
    const v = boardVersion(d);
    return v ? [v.floor, v.items, v.outer, v.project, v.parameters, v.library, v.pours].join("/") : host?.revision?.() ?? 0;
  }
  const current = d => !!d && checks.get(d)?.readyAt === stamp(d);
  const holdsBatch = (state, key) => !!state?.heldBatch && state.readyAt === key;
  // Dependency readiness invalidates check caches, but it does not change the authored board.
  function resetCheckDependencies() {
    const previous = checks;
    checks = new WeakMap();
    for (const d of host.project().documents) {
      const state = previous.get(d);
      if (!state?.heldBatch || !holdsBatch(state, stamp(d))) continue;
      state.engine.reset();
      state.version = state.extra = state.errorAt = null;
      state.published = state.heldBatch;
      checks.set(d, state);
    }
  }
  const findCurrent = id => current(host?.docById?.(id) || visibleBoards().find(d => d.id === id));
  const batchCurrent = d => last?.doc === d && last.stamp === stamp(d);
  const needsPourCheck = d => R()?.checkSelected(d,"clearance",onlineMode) &&
    (d.pcbDrawing?.pours?.length || d.items.some(i => i.kind === "polygon"));
  function pending(d) {
    const state = stateFor(d), key = stamp(d);
    if (state.pendingAt === key) return;
    state.readyAt = state.errorAt = state.heldBatch = null;
    state.pendingAt = key;
    const active = shown.get(d.id) || EMPTY, waived = waivedShown.get(d.id) || EMPTY;
    shown.delete(d.id); waivedShown.delete(d.id); markerPublications.delete(d.id);
    if (active.includes(focused) || waived.includes(focused)) focused = null;
    if (active.includes(hover) || waived.includes(hover)) hover = null;
    if (host.doc() === d && (active.length || waived.length)) globalThis.AtriumDRCMarkers?.clickedEmpty?.(host);
    publish(d, true);
    if (active.length || waived.length) redrawBoard(d);
  }
  function status() {
    if (!host || homeOpen()) return null;
    const boards = visibleBoards(), failed = d => checks.get(d)?.errorAt === stamp(d);
    if (boards.some(d => manual?.doc === d || enabled && !current(d) && !failed(d))) return checkingText;
    if (boards.some(failed)) return "DRC unavailable";
    return null;
  }
  function unavailable(d, error) {
    const state = stateFor(d);
    state.errorAt = stamp(d);
    host.info?.(error.message);
    publish(d, true, String(error.message));
  }
  function needsCheck(d) {
    const s = stateFor(d), a = s.version, b = boardVersion(d);
    if (s.errorAt === stamp(d)) return false;
    // A batch that omitted an online check leaves the engine unseeded at the same document version.
    return s.engine.at() == null || !a || !b || a.seq < b.floor || a.seq > b.seq || a.items !== b.items || a.outer !== b.outer ||
      a.project !== b.project || a.parameters !== b.parameters || a.library !== b.library || a.pours !== b.pours || s.engine.pending() ||
      s.extra?.F !== extrasFor(d) || s.waivers !== globalThis.AtriumDRCWaivers ||
      s.polygons !== globalThis.AtriumPolygonPour || s.paths !== globalThis.AtriumReturnPath;
  }
  function save() {try {globalThis.localStorage?.setItem("atrium-online-drc", JSON.stringify({enabled, budget}));} catch {}}

  const checkingText = "Checking…";
  // A manual run can wait for scope data and derived copper. Only the latest
  // run for this authored board revision can seed the live engine or Messages.
  function run(ctx = {}) {
    const owner = host;
    if (!owner) return globalThis.AtriumNavHost ? ctx.info?.("Design Rule Check is unavailable.") :
      globalThis.AtriumEditorWorkflows?.checkDRC(ctx);
    bindProject();
    const project = owner.project();
    let d = owner.doc();
    if (d.kind !== "pcb") {
      const board = A()?.preferredDocument(project, "pcb", owner.currentId());
      if (!board) {owner.info("Open a PCB layout to run the design rule check."); return null;}
      owner.selectDocument(board.id); d = owner.doc();
    }
    const revision = owner.authoredRevision || owner.revision, authored = revision?.();
    const stays = () => host === owner && owner.project() === project && owner.doc() === d && revision?.() === authored;
    const request = manual = {doc:d, stays};
    const active = () => manual === request && stays();
    const panel = () => globalThis.AtriumMessages;
    const showPanel = (messages, status, actions, focus = false, onActivate) => panel()?.show(
      {...owner.messageContext?.(), info:owner.info}, {title:"Design Rule Check · " + d.name +
        ((name) => name ? " · rule set " + name : "")(globalThis.AtriumRuleSets?.label(project, d)),
        group:"DRC", detail:true, messages, status, focus, preserve:!focus,
        rerun:() => run(ctx), rerunLabel:"Run DRC", rerunTitle:"Run the design rule check again",
        options:() => owner.act("rules"), optionsLabel:"Rules…", optionsTitle:"Open the design rules", actions, onActivate});
    const finish = (error = null) => {
      if (manual !== request) return null;
      manual = null;
      if (stays()) {
        const status = error ? "Could not run Design Rule Check. " + error.message : "Run DRC to check this revision.";
        owner.info(status);
        if (error) unavailable(d, error);
        else publish(d, enabled);
        if (panel()?.detail() === "DRC") showPanel([], status);
      } else if (owner.project() === project && panel()?.detail() === "DRC") {
        showPanel([], "Run DRC to check this revision.");
      }
      return null;
    };
    pending(d);
    owner.info(checkingText);
    showPanel([], checkingText, [], true);
    const L = globalThis.AtriumLazy;
    const later = (wait, resume) => Promise.resolve(wait).then(() => active() ? resume() : finish(), finish);
    const options = {checkMode:ctx.checkMode, project};
    function complete() {
      if (!active()) return finish();
      const rules = rulesOf(d, project), api = globalThis.AtriumDRC, prepared = api.prepare(rules);
      if (prepared) return later(prepared, complete);
      const U = globalThis.AtriumUndoStore, entry = U?.changed?.(d), v = boardVersion(d);
      const versionAtStart = stamp(d), state = stateFor(d);
      let result, pours;
      try {
        result = api.batch(d, owner.defs(), rules, {...options, connections:() => owner.connections(), onPours:v => {pours = v;}});
        globalThis.AtriumDRCFixes?.augment?.(result, d, owner.defs(), options);
      } catch (error) {return finish(error);}
      if (!active() || versionAtStart !== stamp(d)) return finish();
      manual = null;
      last = {doc:d, result, stamp:versionAtStart};
      state.pours = pours;
      state.poursAt = R().checkSelected(d,"clearance",options) ? stamp(d) : null;
      const geometry = owner.boardGeometry?.(d);
      const local = state.engine.seed(d, owner.defs(), rules, result.violations, entry?.seq,
        boardOuter(v, entry && U.outer?.()), v?.library, v?.pours, project, options, geometry, v?.floor);
      state.version = v; state.waivers = globalThis.AtriumDRCWaivers;
      state.polygons = globalThis.AtriumPolygonPour; state.paths = globalThis.AtriumReturnPath;
      const list = extraChecks(d, local);
      state.heldBatch = result.complete !== false && !state.engine.seeded() ? list : null;
      show(d, list, true);
      if (result.complete === false) unavailable(d, Error("Design Rule Check is incomplete."));
      if (enabled && state.engine.at()==null) schedule();
      owner.invalidate();
      let expanded = false, unit = owner.units();
      const messages = () => toMessages(result, {doc:d, unit, expanded, waivedOpen});
      const activate = m => {
        if (!batchCurrent(d)) return false;
        if (m?.ruleSummary) expanded = !expanded;
        else if (m?.waivedSummary) waivedOpen = !waivedOpen;
        else return false;
        panel()?.update("DRC", messages(), {animate:false});
        return true;
      };
      const view = () => showPanel(messages(), result.complete === false ? "Design Rule Check is incomplete." : null, [
        {label:"Units: " + unit, run:() => {unit = unit === "mm" ? "mil" : "mm"; R().units.remember(unit); view();}},
        {label:"Locate other object", enabled:m => batchCurrent(d) && !!m?.drc?.id && !!m.drc.otherId && m.drc.id !== m.drc.otherId,
          run:m => {if (batchCurrent(d)) panel()?.locate({...m, objectId:m.drc.otherId, point:m.drc.otherAt}, true);}},
        {label:"Report…", title:"Export an HTML report", run:() => {if (batchCurrent(d)) return report(d, result, unit);}}
      ], false, activate);
      last.view = view;
      if (panel()?.detail() === "DRC") view();
      const total = waivers(d) ? AtriumDRCWaivers.apply(d, result).result.total : result.total;
      if (result.complete === false) owner.info(d.name + ": Design Rule Check is incomplete.");
      else {
        owner.info(d.name + ": " + (total ? total + " rule violation" + (total === 1 ? "" : "s") : "no rule violations") + " · " + result.stats.ms + " ms");
        C.toast(total ? "DRC: " + total + " violation" + (total === 1 ? "" : "s") : "DRC passed · 0 violations", {kind:total ? "warn" : "ok"});
      }
      globalThis.AtriumMacros?.recordCurrent("butter.macros.check-design-rules", {}, {total, complete:result.complete}, "read");
      return result;
    }
    function prepare() {
      const copper = globalThis.AtriumPolygonPour?.live?.prepare?.(d, owner.defs());
      return copper ? later(copper, complete) : complete();
    }
    const missing = ["AtriumMessages", "AtriumDRC", "AtriumViaStubs", "AtriumRuleSets", "AtriumDRCFixes", ...(d.drcWaivers?.length ? ["AtriumDRCWaivers"] : [])]
      .filter(n => !globalThis[n] && L?.modules?.().includes(n));
    return missing.length ? later(L.need(missing), () => {showPanel([], checkingText, [], true); return prepare();}) : prepare();
  }
  async function report(d, result, unit) {
    // Waived violations stay in the report, in their own section marked waived.
    const split = waivers(d) ? AtriumDRCWaivers.apply(d, result) : null;
    let html = AtriumDRC.report(split ? split.result : result, {board:d.name, project:host.project().name, unit, rules:R().effective?.(d, host.project()), ruleSet:globalThis.AtriumRuleSets?.label(host.project(), d) || ""});
    if (split?.waived.length) html = html.replace("</body></html>", AtriumDRCWaivers.reportSection(split.waived, unit) + "</body></html>");
    try {const saved = await host.exportFile((d.name || "Board").replace(/[\\/:*?"<>|]/g, "-") + " DRC.html", html); if (saved !== false) host.info("Design rule check report exported");}
    catch (e) {host.info(e.message);}
  }
  let focused = null, waivedOpen = false;

  // Online DRC after edits: a client of the one check scheduler (checks.js). A large edit's check
  // continues in idle slices (engine.update mode "partial"), and a newer edit abandons it.
  const S = () => globalThis.AtriumChecks?.scheduler;
  function schedule() {S()?.plan?.("drc");}
  function cancelChecks() {fixesLoad?.clear(); S()?.cancel?.("drc");}
  function client(h) {
    globalThis.AtriumChecks?.attach?.(h);
    // The first check of a board records the journal first (unrecorded "sync"): checked against the
    // journal's versions, the first edit after opening is incremental (unrecorded, it was a full check).
    S()?.client?.({id:"drc", key:d => "online-drc:" + d.id, unrecorded:"sync",
      // The first check of a board waits for idle; later ones run right after the edit's frame
      // (Efficiency mode keeps a short debounce).
      phase:d => stateFor(d).engine.at() == null ? "idle" : "rules",
      delay:() => globalThis.AtriumPower?.efficient?.() ? (globalThis.AtriumPower.delay?.(150) ?? 300) : 0,
      enabled:() => enabled, docs:() => visibleBoards(), due:d => needsCheck(d),
      onDocument:bindProject,
      start(d, slice) {
        return (function* () {
          const work = {};
          try {
            for (;;) {
              const r = check(slice, d, true, work);
              if (r?.mode === "connectivity") {yield r.wait ? S().WAIT : undefined; continue;}
              if (r?.mode !== "partial") return r;
              yield;
            }
          } finally {work.connections?.return();}
        })();
      }});
    // Poured copper against the Clearance rules (drc-pours.js), lazily in idle slices after a refill or
    // a rule change, in short steps (drc-pours.js). Outputs verify it again before they are made.
    S()?.client?.({id:"pour-drc", key:d => "pour-drc:" + d.id, phase:() => "idle", unrecorded:"sync",
      delay:() => globalThis.AtriumPower?.efficient?.() ? 2000 : 300,
      enabled:() => enabled, docs:() => visibleBoards(),
      due:d => {
        if (!d.pcbDrawing?.pours?.length && !d.items.some(i => i.kind === "polygon")) return false;
        if (!globalThis.AtriumDRCPours || !R()) {
          const L = globalThis.AtriumLazy;
          if (!poursLoad && L?.modules?.().includes("AtriumRules")) poursLoad = L.need("AtriumRules").then(() => S()?.plan?.("pour-drc", {now:true}), () => {});
          return false;
        }
        return needsPourCheck(d) && stateFor(d).poursAt !== stamp(d);
      },
      start(d) {
        const revision = stamp(d), it = AtriumDRCPours.steps(d, host.defs(), rulesOf(d, host.project()), {project:host.project()});
        return (function* () {
          let r = it.next();
          while (!r.done) {yield; r = it.next();}
          const state = stateFor(d);
          if (revision !== stamp(d)) return r.value;
          if (r.value.pending) {S()?.plan?.("drc"); return r.value;}
          state.poursAt = revision; state.pours = r.value.violations;
          if (state.publishedAt === stamp(d) && manual?.doc !== d) {show(d, state.published); redrawBoard(d); refreshMessages(d);}
          return r.value;
        })();
      }});
    certsClient();
  }
  // The certificate store for Clearance (drc-certs.js), built in idle slices once a board is checked
  // and again after anything that dropped it (a full check, a rule change beyond its band).
  function certsClient() {
    S()?.client?.({id:"drc-certs", key:d => "drc-certs:" + d.id, phase:() => "idle", unrecorded:"sync",
      delay:() => globalThis.AtriumPower?.efficient?.() ? 3000 : 400,
      enabled:() => enabled, docs:() => visibleBoards(), due:d => stateFor(d).engine.wantsStore(),
      start:d => stateFor(d).engine.buildStore(() => certsStamp(d))});
  }
  function certsStamp(d) {
    const v = boardVersion(d);
    return v ? [v.floor, v.items, v.outer, v.project, v.library].join("/") : null;
  }
  let poursLoad = null;
  // Diagnostics are owned by the online check. The marker renderer can remain cold, even if the
  // board has no other findings. Resume only the checks that still belong to the displayed project.
  function waitForNativeExtras(d, lazy) {
    if (globalThis.AtriumDRCFixes || !extrasSelected(d) || !lazy?.modules?.().includes("AtriumDRCFixes")) return false;
    if (!fixesLoad) {
      const waiting = fixesLoad = new Map();
      const finish = error => {
        fixesLoad = null;
        if (!enabled || homeOpen()) return;
        const panes = visibleBoards(), p = host.project();
        for (const [board, owner] of waiting) {
          if (owner.host !== host || owner.project !== p || !panes.includes(board) || !extrasSelected(board)) continue;
          if (error) {if (owner.stamp === stamp(board)) unavailable(board, error); continue;}
          if (needsCheck(board)) S()?.queue?.("drc", board, "idle");
        }
      };
      lazy.need("AtriumDRCFixes").then(() => finish(), finish);
    }
    fixesLoad.set(d, {host, project:host.project(), stamp:stamp(d)});
    return true;
  }
  let rulesLoad = null;
  const geometryLoads = new WeakSet();
  function prepareGeometry(d) {
    const owner=host, project=host.project(), revision=stamp(d);
    if (!owner.prepareBoardGeometry || owner.drag?.()?.before || geometryLoads.has(d)) return;
    const request=owner.prepareBoardGeometry(d);
    geometryLoads.add(d);
    Promise.resolve(request).then(view => {
      geometryLoads.delete(d);
      if (view && host===owner && enabled && !homeOpen() && project===host.project() && visibleBoards().includes(d))
        S()?.queue?.("drc", d, "idle");
    }, error => {
      geometryLoads.delete(d);
      if (host===owner && project===host.project() && visibleBoards().includes(d) && revision===stamp(d)) unavailable(d, error);
    });
  }
  // deadline (optional, an idle deadline): a large edit is re-checked in parts, one idle slice at a
  // time (engine.update: mode "partial"); the markers and counts change once every part is done.
  function check(deadline, d, scheduled = false, work) {
    if (!enabled || homeOpen()) return null;
    const boards = visibleBoards();
    if (d === undefined) d = boards[0];
    if (d?.kind !== "pcb" || !boards.includes(d)) return null;
    const state = stateFor(d), engine = state.engine;
    if (manual?.doc === d && manual.stays()) return null;
    const key = stamp(d), reportFailure = error => {if (key === stamp(d) && visibleBoards().includes(d)) unavailable(d, error);};
    if (!holdsBatch(state, key) && (!current(d) || needsCheck(d))) pending(d);
    if (!R()) {
      if (!rulesLoad && globalThis.AtriumLazy?.need) {
        rulesLoad = AtriumLazy.need("AtriumRules").then(() => { rulesLoad = null; if (R()) schedule(); }, e => {rulesLoad = null; reportFailure(e);});
      }
      return null;
    }
    // A waiver that no longer holds is never removed here: it turns stale and the violation shows again
    // (DRC Waivers… and Problems list it for review).
    const pruned = false;
    let r;
    // The items changed since the last check, from the undo store's journal (else every object is re-signed).
    const U = globalThis.AtriumUndoStore, from = engine.at();
    const ch = deadline && U?.recordedChanges ? U.recordedChanges(d, from, 8192) : U?.changed?.(d, from, 8192);
    const version = boardVersion(d);
    const outer = boardOuter(version, ch?.seq != null ? U.outer?.() : undefined);
    const rules = rulesOf(d, host.project());
    const L=globalThis.AtriumLazy;
    if (!globalThis.AtriumDesignQuery && L?.needsRuleQuery?.(rules,"pcb")) {
      if (!rulesLoad) rulesLoad=L.need("AtriumDesignQuery").then(()=>{rulesLoad=null;schedule();},e=>{rulesLoad=null;reportFailure(e);});
      return null;
    }
    // An empty board still validates its rules and clears previously published findings.
    const readsGeometry = host.hasBoardArtwork?.(d) !== false;
    const wantsLegend = readsGeometry && (!rules.list || rules.list.some(r => r.enabled !== false &&
      (r.type === "silkToMask" || r.type === "boardOutlineClearance" && r.includeOverlay)));
    if (wantsLegend && L?.need) {
      const modules = ["AtriumMaskOpenings", "AtriumPCBTextRich", "AtriumDesignators"].filter(n => !globalThis[n]);
      if (modules.length) {
        if (!rulesLoad) rulesLoad = L.need(modules).then(() => {rulesLoad = null; resetCheckDependencies(); schedule();},
          e => {rulesLoad = null; reportFailure(e);});
        return null;
      }
    }
    if (d.drcWaivers?.length && !globalThis.AtriumDRCWaivers && L?.modules?.().includes("AtriumDRCWaivers")) {
      if (!waiverLoad) waiverLoad = L.need("AtriumDRCWaivers").then(() => {waiverLoad = null; schedule();},
        error => {waiverLoad = null; reportFailure(error);});
      return null;
    }
    if (waitForNativeExtras(d, L)) return null;
    if (lengthModule(rules, engine.readsLength(), reportFailure)) return null;
    try {
      const geometry = readsGeometry ? host.boardGeometry?.(d) : null;
      if (readsGeometry && host.boardGeometry && !geometry) {prepareGeometry(d); return null;}
      const shared={from,to:ch?.seq,ids:ch?.ids,items:ch?.items,outer,library:version?.library,pours:version?.pours,
        floor:version?.floor,project:host.project(),journal:version?U:null,geometry};
      const defs = host.defs(), live = globalThis.AtriumConnectivityLive;
      if (work?.key != null && work.key !== key) return null;
      // A cold board may reach Online DRC before the ratsnest has a finished graph. Let the
      // scheduler advance that graph independently, without drawing it or blocking the rules pass.
      if (work && live?.stages && version && from == null && R().checkSelected(d, "short", onlineMode)) {
        if (work.key == null) {
          work.key = key;
          work.compiled = R().compiled(d, {rules, defs, project:shared.project});
          if (work.compiled.byType.short.length) work.connections = live.stages(d, defs, U);
        }
        if (work.connections) {
          const step = work.connections.next();
          if (!step.done) {
            work.yielded ||= !!step.value || deadline.expired();
            return {mode:"connectivity", wait:!!step.value};
          }
          if (!step.value) {
            // A visible ratsnest may have taken over the shared graph during a yield.
            work.connections = live.stages(d, defs, U, new WeakMap());
            work.yielded = true;
            return {mode:"connectivity", wait:true};
          }
          work.connections = null;
          work.result = step.value;
          if (work.yielded || deadline.expired()) return {mode:"connectivity", wait:true};
        }
        shared.compiled = work.compiled;
        shared.connections = work.result;
      }
      r = engine.update(d,defs,rules,shared,deadline && {timeRemaining:() => deadline.timeRemaining()});
      geometry?.assertCurrent();
    } catch (e) {
      if(e.code!=="STALE_GEOMETRY")reportFailure(e);
      return null;
    }
    if (engine.readsLength() && lengthModule(rules, true, reportFailure)) return null;
    if (r.mode === "partial") {
      if (!scheduled) S()?.queue?.("drc", d, "idle");
      return r;
    }
    if (engine.wantsStore?.()) S()?.plan?.("drc-certs");
    // Pour-only rule results can change while the authored nets and components used by the extras stay current.
    const hint = ch?.ids && ch.seq != null ? {from, to:ch.seq, ids:ch.ids, items:ch.items, outer} : null;
    const x = state.extra, F = extrasFor(d);
    const reuse = !pruned && !hint?.ids.size && outer != null && x?.outer === outer && x.F === F &&
      (r.mode === "copper" || r.mode === "none" && x.list === r.violations);
    let list;
    if (reuse) {
      if (hint) state.extras?.advance?.(hint.from, hint.to);
      list = x.list === r.violations ? x.out : r.violations.concat(x.out.filter(v => nativeExtras.includes(v.type)));
    } else list = extraChecks(d, r.violations, hint);
    state.extra = outer != null ? {list:r.violations, outer, F, out:list} : null;
    state.version = version; state.waivers = globalThis.AtriumDRCWaivers;
    state.polygons = globalThis.AtriumPolygonPour; state.paths = globalThis.AtriumReturnPath;
    if (r.complete !== false || !holdsBatch(state, key)) show(d, list);
    if (r.complete === false) unavailable(d, Error("Online Design Rule Check is incomplete."));
    if (r.mode !== "none" || !reuse) {redrawBoard(d); refreshMessages(d);}
    return r;
  }
  function refreshMessages(d) {
    const M = globalThis.AtriumMessages;
    if (!M?.isOpen() || M.detail() !== "DRC" || last?.doc !== d) return;
    if (batchCurrent(d)) last.view?.();
  }
  function invalidateResults() {
    const visible = new Set(visibleBoards()), boards = new Map([...visible].map(d => [d.id, d]));
    for (const d of host.project().documents) if (adapters.has(d.id)) boards.set(d.id, d);
    for (const id of adapters.keys()) if (!boards.has(id)) {
      adapters.delete(id); shown.delete(id); waivedShown.delete(id); markerPublications.delete(id); clearPublished(id);
    }
    for (const d of boards.values()) if (!current(d) && (shown.has(d.id) || enabled && visible.has(d))) pending(d);
    const superseded = !!manual && !manual.stays(), stale = !!last && !batchCurrent(last.doc);
    if (superseded) manual = null;
    if (stale) last = null;
    const M = globalThis.AtriumMessages;
    if ((superseded || stale) && M?.detail() === "DRC" && !manual) M.show(host.messageContext(), {group:"DRC", detail:true, focus:false, preserve:true,
      status:"Run DRC to check this revision.", rerun:() => host.act("drc"), rerunLabel:"Run DRC"});
  }
  // After a waiver is added or removed: markers, counts and Messages from the current results.
  function refresh() {
    if (!host) return;
    for (const d of visibleBoards()) {
      const state = stateFor(d);
      if (!current(d)) continue;
      show(d, state.published);
      state.waivers = globalThis.AtriumDRCWaivers;
      refreshMessages(d);
    }
    host.invalidate();
  }
  // Net antennae and missing courtyards (drc-fixes.js) are re-checked with every online pass.
  function extraChecks(d, list, hint) {
    const F = extrasFor(d);
    if (!F?.online) return list;
    const state = stateFor(d);
    if (F.extras && state.extrasF !== F) {state.extrasF = F; state.extras = F.extras();}
    return F.online(d, host.defs(), list, state.extras, hint).filter(v=>R().checkSelected(d,v.type,onlineMode));
  }
  function netWideOf(d) {return batchCurrent(d) ? unwaived(d, (last.result.violations || []).filter(x => NET_WIDE.has(x.type))) : [];}
  function setEnabled(on) {
    enabled = !!on; save(); C.setChecked("drc-online", enabled);
    if (enabled) {checks = new WeakMap(); invalidateResults(); schedule();}
    else {
      cancelChecks();
      for (const d of visibleBoards()) {
        if (batchCurrent(d)) continue;
        shown.delete(d.id); waivedShown.delete(d.id); markerPublications.delete(d.id);
        publish(d);
      }
      host?.invalidate();
    }
    host?.info(enabled ? "Online DRC on: edits are re-checked as you work (budget " + budget + " ms)." : "Online DRC off. Tools → Run Design Rule Check still runs the batch checks.");
  }

  // ------------------------------------------------------------------ markers
  let markerLoad = null;
  const markerAttempts = new WeakSet();
  function markerModule(d) {
    if (globalThis.AtriumDRCMarkers) return AtriumDRCMarkers;
    const L = globalThis.AtriumLazy, publication = markerPublications.get(d.id), owner = host;
    if (!homeOpen() && publication && !markerAttempts.has(publication) && !markerLoad && L?.modules?.().includes("AtriumDRCMarkers")) {
      markerAttempts.add(publication);
      markerLoad = L.need("AtriumDRCMarkers").then(() => {
        if (host === owner && !homeOpen()) for (const board of visibleBoards())
          if (current(board) && markerPublications.has(board.id)) redrawBoard(board);
      }, error => {
        if (host === owner && visibleBoards().includes(d) && current(d)) host.info?.(error.message);
      }).finally(() => {markerLoad = null;});
    }
    return null;
  }
  function groupAt(pane, clientX, clientY) {
    const publication = markerPublications.get(pane.docId);
    if (!publication || !globalThis.AtriumDRCMarkers) return null;
    const d = host?.docById?.(pane.docId) || host?.doc();
    if (d?.id !== pane.docId || !current(d)) return null;
    return AtriumDRCMarkers.groupAt(host, pane, shown.get(d.id), clientX, clientY, waivedShown.get(d.id), publication, focused, hover) || null;
  }
  const markerAt = (pane, x, y) => groupAt(pane, x, y)?.v || null;

  function attach(h) {
    host = h;
    host.on?.("change", invalidateResults);
    host.on?.("document", invalidateResults);
    host.on?.("replace", bindProject);
    host.registerAction("drc-online", () => setEnabled(!enabled));
    host.registerAction("drc-clear", () => {
      cancelChecks(); shown.clear(); waivedShown.clear(); markerPublications.clear(); last = manual = focused = hover = null;
      checks = new WeakMap(); host.invalidate(); clearPublished(null); globalThis.AtriumMessages?.clear?.("DRC");
    });
    host.registerAction("drc-waivers", async () => {
      if (!globalThis.AtriumDRCWaivers) {try {await globalThis.AtriumLazy?.need?.("AtriumDRCWaivers");} catch (e) {host.info(e.message); return;}}
      globalThis.AtriumDRCWaivers?.manage(host, refresh);
    });
    host.addRenderer(d => {
      if (d.kind !== "pcb") return null;
      bindProject();
      const publication = markerPublications.get(d.id);
      if (!publication || !current(d) || homeOpen()) return null;
      return markerModule(d)?.renderFor(host, d, shown.get(d.id), {focused, hover, waived:waivedShown.get(d.id), publication}) || null;
    });
    client(host);
    schedule();
    if (typeof document === "undefined") return;
    C.menuItem("tools", "drc-online", "Online DRC", {after:"drc", checkable:true, scope:"pcb"});
    C.menuItem("tools", "drc-clear", "Clear DRC Markers", {after:"drc-online", scope:"pcb"});
    C.menuItem("tools", "drc-waivers", "DRC Waivers…", {after:"drc-clear", scope:"pcb"});
    C.menuItem("tools", "drc-next", "Next Violation", {after:"drc-waivers", scope:"pcb"});
    C.menuItem("tools", "drc-prev", "Previous Violation", {after:"drc-next", scope:"pcb"});
    C.setChecked("drc-online", enabled);
    // Hover and click on markers in any pane: drc-markers.js writes the status-bar line and opens
    // the Violation inspector on a click (or, with the Altium-style preference, the popover).
    const paneOf = c => host.panes().find(p => p.canvas === c), M = () => globalThis.AtriumDRCMarkers;
    document.addEventListener("pointermove", e => {
      const p = e.target?.tagName === "CANVAS" && !e.buttons ? paneOf(e.target) : null, v = p ? markerAt(p, e.clientX, e.clientY) : null;
      if (v !== hover) {hover = v; host.invalidate();}
      M()?.hovered?.(host, v, e);
    }, {passive:true});
    document.addEventListener("pointerleave", () => M()?.hovered?.(host, null), true);
    document.addEventListener("pointerdown", e => {
      if (e.defaultPrevented || e.target?.tagName !== "CANVAS" || e.button !== 0 || e.altKey || e.shiftKey) return;
      const p = paneOf(e.target), v = p && markerAt(p, e.clientX, e.clientY);
      if (!v || host.tool() !== "select") {if (host.tool() === "select") M()?.clickedEmpty?.(host); return;}
      if (p.active === false && !host.activatePane?.(p)) return;
      focused = v; host.invalidate();
      if (M()?.clicked?.(host, v)) {e.preventDefault(); e.stopPropagation();}
    }, true);
  }
  C?.ready(attach);

  return {toMessages, online, signature, reachOf, run, check, refresh, setEnabled, enabled:() => enabled, budget:() => budget,
    setBudget(ms) {budget = Math.max(5, Number(ms) || 30); checks = new WeakMap(); save(); if (host) schedule();},
    violations:docId => findCurrent(docId) ? shown.get(docId) || EMPTY : EMPTY,
    waived:docId => findCurrent(docId) ? waivedShown.get(docId) || EMPTY : EMPTY, focused:() => focused,
    focus(v) {focused = v || null; host?.invalidate();}, markerAt, groupAt, status, NET_WIDE, attach};
})();
