"use strict";
// Headless editor commands: the DOM-free model transforms behind menu and key actions.
//
//   AtriumCommandsHeadless.run(project, name, args) -> result (JSON-safe)
//   AtriumCommandsHeadless.kind(name, args)  -> "read" | "edit"
//   AtriumCommandsHeadless.names()     -> command names
//
// The MCP server (mcp/commands.py, run_command) validates `args` against a strict schema
// per command before calling run(), and loads the app modules each command needs. Edit
// commands change `project` in place: the server passes its private working copy and turns
// the difference into a .waffle-ai proposal (or a write with --allow-write). Nothing here
// touches the DOM, storage or the network, and no argument is ever evaluated as code.
//
// Selection: commands that act on objects take `ids` (item IDs) and/or `designators`
// (part references) in one document, `document_id` (default: the document that holds the
// given `id` or first of `ids`, else the first document of the kind the command needs).
// The editor's selection is replaced by these explicit lists; `select` and `find_similar`
// return such lists.
globalThis.AtriumCommandsHeadless = (() => {
  const A = () => globalThis.Atrium;
  const fail = m => { throw Error(m); };
  const need = (name, file) => globalThis[name] || fail(name + " is not available in this build (" + file + ").");
  const {read, allowsLockedRevision} = need("AtriumLegacyCommandContract", "automation/legacy-command-contract.js");
  const round = (v, d = 4) => typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v;
  const defsOf = p => new Map(p.library.map(d => [d.id, d]));

  // Without document_id, the document that holds the given item (`id`, else the first of `ids`).
  function docOf(p, a, kind) {
    const fits = x => !kind || x.kind === kind, item = typeof a.id === "string" ? a.id : Array.isArray(a.ids) ? a.ids[0] : null;
    const d = a.document_id != null
      ? p.documents.find(x => x.id === a.document_id) || p.documents.find(x => x.name === a.document_id)
      : item != null && p.documents.find(x => fits(x) && x.items.some(i => i.id === item)) || p.documents.find(fits) || p.documents[0];
    if (!d) fail(a.document_id != null ? "The project has no document " + a.document_id + "." : "The project has no " + (kind === "pcb" ? "PCB layout." : kind === "schematic" ? "schematic." : "documents."));
    if (kind && d.kind !== kind) fail(kind === "pcb" ? "Choose a PCB document." : "Choose a schematic document.");
    return d;
  }
  // The explicit selection: ids and designators, all of which must exist.
  function targets(doc, a, {required = true, min = 1} = {}) {
    const out = new Set(), byId = new Set(doc.items.map(i => i.id));
    for (const id of a.ids || []) { if (!byId.has(id)) fail("Document " + doc.name + " has no object " + id + "."); out.add(id); }
    for (const ref of a.designators || []) {
      const hit = doc.items.filter(i => i.kind === "part" && String(i.ref).toUpperCase() === String(ref).toUpperCase());
      if (!hit.length) fail("Document " + doc.name + " has no component " + ref + ".");
      for (const i of hit) out.add(i.id);
    }
    if (required && out.size < min) fail(min > 1 ? "Give at least " + min + " objects (ids or designators)." : "Give the objects (ids or designators).");
    return [...out];
  }
  const moved = (doc, plan) => ({document_id: doc.id, moved: plan.moves.length, moves: plan.moves.slice(0, 200).map(m => ({id: m.id, dx: round(m.dx), dy: round(m.dy)})),
    locked_moved: plan.locked || []});
  function guided(fn) {
    return (p, a) => {
      const G = need("AtriumGuides", "pcb/smart-guides.js"), doc = docOf(p, a), defs = defsOf(p);
      const plan = fn(G, doc, defs, a);
      if (plan.locked?.length && !a.include_locked) fail("Locked objects would move: " + plan.locked.slice(0, 10).join(", ") + ". Pass include_locked or unlock them.");
      G.applyPlan(doc, defs, plan);
      return moved(doc, plan);
    };
  }
  const itemRow = i => {
    const r = {id: i.id, kind: i.kind};
    for (const k of ["ref", "value", "net", "layer", "text", "name"]) if (typeof i[k] === "string" && i[k]) r[k] = i[k];
    if (i.locked === true) r.locked = true;
    return r;
  };
  function page(items, a) {
    const offset = a.offset ?? 0, limit = a.limit ?? 50, end = offset + limit;
    return {items: items.slice(offset, end), total: items.length, next_offset: end < items.length ? end : null};
  }
  const pointsOf = (i, defs, kind) => { try { return A().itemPoints(i, defs.get(i.def), kind); } catch { return []; } };

  const COMMANDS = {
    // ---------------------------------------------------------------- selection (read)
    query: {run: (p, a) => need("AtriumQuery", "checks/query.js").headless(p, a)},
    select: {run(p, a) {
      const doc = docOf(p, a), defs = defsOf(p), kinds = a.kinds ? new Set(a.kinds) : null;
      const q = a.query ? String(a.query).toUpperCase() : null, box = a.within;
      const PE = globalThis.AtriumPCBEdit;
      const hits = doc.items.filter(i => {
        if (kinds && !kinds.has(i.kind) && !(PE && kinds.has(PE.kindOf(i, doc.kind)))) return false;
        if (a.layer != null && (i.layer || (i.kind === "part" ? "Top" : "")) !== a.layer) return false;
        if (a.net != null && i.net !== a.net && !Object.values(i.pinNets || {}).includes(a.net)) return false;
        if (a.locked != null && (i.locked === true) !== a.locked) return false;
        if (q && ![i.ref, i.value, i.text, i.name, i.net].some(s => typeof s === "string" && s.toUpperCase().includes(q))) return false;
        if (box) {
          const pts = pointsOf(i, defs, doc.kind);
          if (!pts.length || !pts.every(([x, y]) => x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3])) return false;
        }
        return true;
      });
      return {document_id: doc.id, ids: hits.map(i => i.id).slice(0, 5000), ...page(hits.map(itemRow), a)};
    }},
    find_similar: {run(p, a) {
      const doc = docOf(p, a), defs = defsOf(p);
      const item = doc.items.find(i => i.id === a.id) || fail("Document " + doc.name + " has no object " + a.id + ".");
      if (doc.kind === "schematic") {
        // Schematic Find Similar (sch-similar.js): parts, pins (pin = a part's pin number), wires, labels, ports, power ports.
        const S = need("AtriumSchSimilar", "schematic/sch-similar.js"), o = {pin: a.pin ?? null};
        const props = S.props(p, doc, defs, item, o), keys = new Set(props.map(x => x.key));
        for (const k of Object.keys(a.criteria || {})) if (!keys.has(k)) fail("A " + (o.pin != null ? "pin" : item.kind) + " has no property " + k + " (choose from " + [...keys].join(", ") + ").");
        const hits = S.find(p, doc, defs, item, a.criteria || {}, {pin: o.pin, within: a.within_ids || null});
        const here = hits.filter(h => h.doc === doc.id);
        return {document_id: doc.id, properties: props, ids: [...new Set(here.map(h => h.id))].slice(0, 5000), total: hits.length,
          matches: hits.slice(0, 5000).map(h => ({document_id: h.doc, id: h.id, ...(h.pin != null ? {pin: h.pin} : {})}))};
      }
      if (a.pin != null) fail("pin applies to schematic parts only.");
      const PE = need("AtriumPCBEdit", "pcb/pcb-edit.js");
      const props = PE.similarProps(doc, defs, item), keys = new Set(props.map(x => x.key));
      for (const k of Object.keys(a.criteria || {})) if (!keys.has(k)) fail("A " + item.kind + " has no property " + k + " (choose from " + [...keys].join(", ") + ").");
      const ids = PE.findSimilar(doc, defs, item, a.criteria || {}, {within: a.within_ids || null});
      return {document_id: doc.id, properties: props.map(x => ({key: x.key, label: x.label, value: x.value})), ids: ids.slice(0, 5000), total: ids.length};
    }},
    find_replace: {readWhen: a => a?.replacement == null, run(p, a) {
      const F = need("AtriumFindReplace", "editor/find-replace.js");
      if (a.regex && a.query.length > 200) fail("Regular expressions are limited to 200 characters.");
      const scope = a.scope || "project", doc = scope === "project" ? null : docOf(p, a);
      const o = {query: a.query, scope, docId: doc?.id, selection: a.ids, matchCase: !!a.match_case, wholeWord: !!a.whole_word, regex: !!a.regex, fields: a.fields};
      if (o.scope === "selection" && !a.ids?.length) fail("Give ids for scope selection.");
      if (o.scope === "selection") targets(doc, {ids: a.ids}); // every id must be on the searched document
      const hits = F.search(p, o);
      const out = {hits: hits.length, matches: hits.slice(0, 200).map(h => ({document_id: h.docId, id: h.id, kind: h.kind, field: h.field, key: h.key, text: h.text}))};
      if (a.replacement == null) return out;
      return {...out, replaced: F.replace(p, hits, a.replacement, o)};
    }},

    // ---------------------------------------------------------------- arrange
    align: {run: guided((G, doc, defs, a) => {
      const ids = targets(doc, a, {min: 2});
      return G.align(doc, defs, ids, a.mode, a.primary ? {to: "primary", primary: a.primary} : {});
    })},
    distribute: {run: guided((G, doc, defs, a) => G.distribute(doc, defs, targets(doc, a, {min: a.gap != null ? 2 : 3}), a.axis, a.gap != null ? {gap: a.gap} : {}))},
    align_to_grid: {run: guided((G, doc, defs, a) => G.alignToGrid(doc, defs, targets(doc, a), a.grid ?? doc.grid))},
    make_array: {run: guided((G, doc, defs, a) => G.array(doc, defs, targets(doc, a, {min: 2}), a.axis, a.pitch, {ref: a.ref || "origin", align: a.align !== false}))},
    rotate: {run(p, a) {
      const doc = docOf(p, a), defs = defsOf(p), ids = new Set(targets(doc, a)), step = a.angle ?? 90;
      const PE = globalThis.AtriumPCBEdit, rotated = [], skipped = [];
      for (const i of doc.items) {
        if (!ids.has(i.id)) continue;
        if (i.kind !== "part") { skipped.push(i.id); continue; }
        if (i.locked === true && !a.include_locked) { skipped.push(i.id); continue; }
        A().transformPart(doc, i, defs.get(i.def), {angle: ((((i.angle || 0) + step) % 360) + 360) % 360});
        rotated.push(i.id);
      }
      if (doc.kind === "pcb" && PE?.settle && rotated.length) try { PE.settle(doc, p, defs); } catch { /* teardrops stay for DRC to report */ }
      return {document_id: doc.id, rotated, skipped, angle: step};
    }},
    mirror: {run(p, a) {
      const S = need("AtriumSchPlace", "schematic/sch-place.js"), doc = docOf(p, a, "schematic");
      const n = S.mirrorItems(doc, defsOf(p), new Set(targets(doc, a)), a.axis, a.pivot || undefined);
      return {document_id: doc.id, mirrored: n, axis: a.axis};
    }},
    flip_side: {run(p, a) {
      const PE = need("AtriumPCBEdit", "pcb/pcb-edit.js"), doc = docOf(p, a, "pcb"), ids = targets(doc, a);
      const locked = doc.items.filter(i => ids.includes(i.id) && i.locked === true).map(i => i.id);
      if (locked.length && !a.include_locked) fail("Locked components would flip: " + locked.join(", ") + ".");
      const done = PE.flip(doc, p, ids, {});
      return {document_id: doc.id, flipped: done.map(i => ({id: i.id, ref: i.ref, side: i.layer || "Top"}))};
    }},
    set_locked: {run(p, a) {
      const PE = need("AtriumPCBEdit", "pcb/pcb-edit.js"), doc = docOf(p, a), plan = PE.lockPlan(doc, targets(doc, a), a.locked);
      PE.applyLock(doc, plan);
      return {document_id: doc.id, changed: plan.ids, locked: a.locked};
    }},
    union: {run(p, a) {
      const PE = need("AtriumPCBEdit", "pcb/pcb-edit.js"), doc = docOf(p, a, "pcb");
      const plan = PE.unionPlan(doc, targets(doc, a), a.op, a.primary);
      if (!plan.set.length) fail(plan.message);
      PE.applyUnion(doc, plan);
      return {document_id: doc.id, union_id: plan.unionId || null, objects: plan.set.length, message: plan.message};
    }},
    duplicate: {run(p, a) {
      const E = need("AtriumEditSelection", "editor/edit-selection.js"), doc = docOf(p, a), defs = defsOf(p), ids = new Set(targets(doc, a));
      const count = a.count ?? 1, dx = a.dx ?? doc.grid * 4, dy = a.dy ?? 0, added = [];
      const clip = E.capture(doc, defs, ids, false);
      if (!clip?.items?.length) fail("Nothing to duplicate.");
      for (let n = 1; n <= count; n++) {
        const plan = E.prepare(p, doc, clip, defsOf(p));
        plan.commit([clip.origin[0] + dx * n, clip.origin[1] + dy * n]);
        for (const i of plan.items) added.push(i.kind === "part" ? {id: i.id, ref: i.ref} : {id: i.id});
      }
      return {document_id: doc.id, added: added.length, items: added.slice(0, 500)};
    }},

    // ---------------------------------------------------------------- objects
    add_items: {run(p, a) {
      const doc = docOf(p, a), used = new Set(p.documents.flatMap(d => d.items.map(i => i.id))), added = [];
      for (const raw of a.items) {
        const i = JSON.parse(JSON.stringify(raw));
        if (i.id == null) i.id = A().id(); else if (typeof i.id !== "string" || used.has(i.id)) fail("Item id " + i.id + " is not a new string id.");
        used.add(i.id);
        if (i.kind === "part" && !p.library.some(d => d.id === i.def)) fail("Part " + (i.ref || i.id) + " needs a library def_id (list_library).");
        added.push(i);
      }
      const draft = {...doc, items: doc.items.concat(added)};
      /** @type {(project: unknown, options: {normalize: boolean}) => Project} */
      const validate = A().validate;
      validate({...p, documents: p.documents.map(d => d === doc ? draft : d)}, {normalize: false});
      for (const item of added) doc.items.push(item);
      return {document_id: doc.id, added: added.map(item => item.id)};
    }},
    sync_sheet_entries: {run(p, a) {
      const S = need("AtriumSchObjects", "schematic/sch-objects.js"), doc = docOf(p, a, "schematic");
      const s = doc.items.find(i => i.id === a.id && i.kind === "sheetsymbol") || fail("Choose a sheet symbol ID.");
      const child = p.documents.find(d => d.id === s.sheet) || fail("The child sheet of " + (s.name || s.id) + " is missing.");
      if (typeof S.syncEntries !== "function") fail("Sheet entry sync is not available in this build.");
      return {document_id: doc.id, ...S.syncEntries(s, child, doc, defsOf(p))};
    }},

    // ---------------------------------------------------------------- document settings
    set_grid: {run(p, a) {
      const doc = docOf(p, a), before = doc.grid;
      doc.grid = a.grid;
      return {document_id: doc.id, before, grid: doc.grid};
    }},
    set_units: {run(p, a) {
      const before = p.units === "mil" ? "mil" : "mm";
      if (a.units === "mil") p.units = "mil"; else delete p.units;
      return {before, units: a.units};
    }},
    set_hop_overs: {run(p, a) {
      const doc = docOf(p, a, "schematic");
      if (a.on) doc.hopOvers = true; else delete doc.hopOvers;
      return {document_id: doc.id, hop_overs: !!a.on};
    }},
    add_document: {run(p, a) {
      const name = a.name.trim() || fail("Give the document a name.");
      if (p.documents.some(d => d.name === name)) fail("A document is already named " + name + ".");
      const d = A().sheet ? A().sheet(a.kind, name) : null;
      if (!d) fail("This build cannot create documents.");
      p.documents.push(d);
      return {document_id: d.id, kind: d.kind, name: d.name};
    }},
    rename_document: {run(p, a) {
      const doc = docOf(p, a), name = a.name.trim() || fail("Give the document a name.");
      if (p.documents.some(d => d !== doc && d.name === name)) fail("A document is already named " + name + ".");
      const before = doc.name; doc.name = name;
      return {document_id: doc.id, before, name};
    }},
    list_variants: {run(p) {
      const V = need("AtriumVariants", "project/variants.js");
      return {active: V.find(p, p.activeVariant)?.name || null, variants: V.list(p).map(v => ({id: v.id, name: v.name, description: v.description || ""}))};
    }},
    set_variant: {run(p, a) {
      const V = need("AtriumVariants", "project/variants.js"), before = V.find(p, p.activeVariant)?.name || null;
      if (a.variant != null && a.variant !== "" && !V.find(p, a.variant)) fail("The project has no variant " + a.variant + ".");
      const v = V.setActive(p, a.variant);
      return {before, active: v?.name || null};
    }},
    // Board revisions and variant edits (revisions.js; mcp/commands.py loads it with every command).
    list_revisions: {run(p, a) { return need("AtriumRevisions", "project/revisions.js").headless("list_revisions", p, a); }},
    variant_bom: {run(p, a) { return need("AtriumRevisions", "project/revisions.js").headless("variant_bom", p, a); }},
    compare_revisions: {run(p, a) { return need("AtriumRevisions", "project/revisions.js").headless("compare_revisions", p, a); }},
    new_revision: {run(p, a) { return need("AtriumRevisions", "project/revisions.js").headless("new_revision", p, a); }},
    release_revision: {run(p, a) { return need("AtriumRevisions", "project/revisions.js").headless("release_revision", p, a); }},
    set_revision_status: {run(p, a) { return need("AtriumRevisions", "project/revisions.js").headless("set_revision_status", p, a); }},
    variant_edit: {run(p, a) { return need("AtriumRevisions", "project/revisions.js").headless("variant_edit", p, a); }},
    related_components: {run(p, a) { return need("AtriumRelated", "library/related-parts.js").headless(p, a, docOf); }},
    board_rule_sets: {run(p, a) {
      const G = need("AtriumRuleGroups", "checks/rule-groups.js"), doc = docOf(p, a, "pcb");
      if (a.op === "import" && typeof a.text !== "string") fail("Give the rule set file contents as text.");
      return G.headless(p, doc, a);
    }},
    activate_rule_set: {run(p, a) {
      const RS = need("AtriumRuleSets", "checks/rule-sets.js"), doc = docOf(p, a, "pcb");
      const set = RS.activate(p, doc, a.name);
      return {document_id: doc.id, active: set.name, approximate: !!set.approximate, rules: globalThis.AtriumRules?.stored?.(doc, p)?.list?.length ?? null};
    }},

    // ---------------------------------------------------------------- PCB tools
    teardrops: {run(p, a) {
      const T = need("AtriumTeardrops", "pcb/teardrops.js"), doc = docOf(p, a, "pcb"), defs = defsOf(p);
      const sel = a.ids || a.designators ? targets(doc, a) : null;
      const o = {scope: sel ? "selection" : "all", selection: sel || []};
      for (const k of ["style", "length", "width", "pads", "vias", "tjunctions", "clearance"]) if (a[k] !== undefined) o[k] = a[k];
      const plan = a.action === "remove" ? T.removePlan(doc, o) : T.plan(doc, defs, o);
      const r = T.apply(doc, plan);
      return {document_id: doc.id, action: a.action, added: r.added, removed: r.removed, skipped: (plan.skipped || []).length,
        skipped_reasons: (plan.skipped || []).slice(0, 50).map(s => ({at: s.at ? s.at.map(v => round(v)) : null, reason: s.reason || null}))};
    }},
    via_fence: {readWhen: a => a?.action === "status", run(p, a) {
      const F = need("AtriumViaFence", "pcb/via-fence.js"), doc = docOf(p, a, "pcb"), defs = defsOf(p), opts = {project: p};
      if (a.action === "status") return {document_id: doc.id, fences: F.status(doc, defs, opts)};
      let plan;
      if (a.action === "remove") plan = F.removePlan(doc, a.fence_ids);
      else if (a.action === "regenerate") plan = F.regenerate(doc, defs, a.fence_ids, {...opts, staleOnly: !!a.stale_only});
      else {
        if (!a.kind) fail("Give the fence kind: path, edge, area or return.");
        const source = {...(a.source || {})};
        if (a.kind === "path" && !source.trackIds && !source.net && !source.netClass && !source.pair && (a.ids || a.designators)) source.trackIds = targets(doc, a);
        plan = F.plan(doc, defs, {kind: a.kind, name: a.name, source, params: {...(a.params || {}), ...(a.net ? {net: a.net} : {})}}, opts);
      }
      F.applyPlan(doc, plan, {defs, project: p, repour: a.repour !== false});
      return {document_id: doc.id, action: a.action, added: (plan.add || []).length, removed: (plan.remove || []).length,
        fences: (plan.fences?.set || []).map(f => ({id: f.id, kind: f.kind, name: f.name, net: f.net, count: f.count})), removed_fences: plan.fences?.remove || [],
        stats: plan.stats ? {placed: plan.stats.placed, skipped: plan.stats.skipped, candidates: plan.stats.candidates, coverage: plan.stats.coverage, pitch: round(plan.stats.pitch)} : null};
    }},
    place_designators: {run(p, a) {
      const D = need("AtriumDesignators", "pcb/designator-place.js"), doc = docOf(p, a, "pcb");
      const ids = a.ids || a.designators ? targets(doc, a).filter(id => doc.items.some(i => i.id === id && i.kind === "part")) : undefined;
      const r = D.plan(doc, defsOf(p), {ids, project: p});
      if (r.moves.length) D.apply(doc, r);
      return {document_id: doc.id, placed: r.moves.length, shrunk: r.shrunk.length, unplaced: r.unplaced};
    }},
    length_tune: {run(p, a) {
      const L = need("AtriumLength", "pcb/length-tuning.js"), doc = docOf(p, a, "pcb"), defs = defsOf(p);
      const o = {};
      if (a.groups) o.keys = a.groups;
      if (a.phase) o.phase = {tolerance: a.tolerance ?? .025, distance: a.distance ?? 5};
      if (a.rounding != null) o.rounding = a.rounding;
      const r = L.autoTune(doc, defs, o);
      if (r.plan?.modify?.length || r.plan?.add?.length) L.applyPlan(doc, r.plan);
      return {document_id: doc.id, modified: r.plan?.modify?.length || 0, fixed: (r.fixed || []).length, failed: (r.failed || []).slice(0, 50),
        phase: (r.phase || []).map(x => ({pair: x.pair ?? x.name ?? null, bumps: x.bumps, ok: !!x.ok}))};
    }},
    diffpair_gloss: {run(p, a) {
      const D = need("AtriumDiffPair", "pcb/diffpair.js"), R = need("AtriumRouter", "pcb/router.js"), doc = docOf(p, a, "pcb");
      const plan = D.gloss(doc, defsOf(p), {ids: targets(doc, a), transition: a.transition || "mitered", project: p});
      if (plan.modify.length || plan.add.length) R.apply(doc, plan);
      return {document_id: doc.id, modified: plan.modify.length, added: plan.add.length};
    }},
    diffpair_retrace: {run(p, a) {
      const D = need("AtriumDiffPair", "pcb/diffpair.js"), R = need("AtriumRouter", "pcb/router.js"), doc = docOf(p, a, "pcb");
      if (a.gap_mode === "custom" && !(a.gap > 0)) fail("Give a gap for gap_mode custom.");
      const plan = D.retrace(doc, defsOf(p), {ids: targets(doc, a), gapMode: a.gap_mode || "preferred", gap: a.gap, transition: a.transition || "mitered", project: p});
      if (!plan.ok) fail("Retrace refused: " + (plan.failed?.[0]?.reason || "clearance") + ".");
      if (plan.modify.length || plan.add.length) R.apply(doc, plan);
      return {document_id: doc.id, runs: plan.runs, gap: round(plan.gap), modified: plan.modify.length, added: plan.add.length};
    }},
    route_tabs: {run(p, a) {
      const R = need("AtriumRouter", "pcb/router.js"), doc = docOf(p, a, "pcb");
      if (typeof R.tabs !== "function") fail("Tabbed routing is not available in this build.");
      const o = {ids: targets(doc, a), shape: a.shape || "T", side: a.side, project: p};
      for (const [k, v] of [["pitch", a.pitch], ["tabWidth", a.tab_width], ["tabLength", a.tab_length]]) if (v > 0) o[k] = v;
      const plan = R.tabs(doc, defsOf(p), o);
      if (plan.add.length) R.apply(doc, plan);
      return {document_id: doc.id, tabs: plan.tabs, added: plan.add.length, skipped: plan.skipped.length};
    }},
    rooms_fit: {run(p, a) {
      const Ro = need("AtriumRooms", "pcb/rooms.js"), doc = docOf(p, a, "pcb");
      const plan = Ro.fitPlan(doc, defsOf(p), a.margin ?? 1, a.room_ids || null);
      Ro.applyFit(doc, plan);
      return {document_id: doc.id, fitted: plan.map(f => f.id)};
    }},
    rooms_lock: {run(p, a) {
      const Ro = need("AtriumRooms", "pcb/rooms.js"), doc = docOf(p, a, "pcb"), want = a.room_ids ? new Set(a.room_ids) : null;
      const rooms = Ro.list(doc).filter(r => !want || want.has(r.id) || want.has(r.name));
      if (!rooms.length) fail("This board has no matching rooms.");
      for (const r of rooms) if (a.locked) r.locked = true; else delete r.locked;
      return {document_id: doc.id, rooms: rooms.map(r => r.id), locked: a.locked};
    }},
    swap_components: {run(p, a) {
      const S = need("AtriumSwap", "library/component-swap.js"), doc = docOf(p, a);
      const plan = S.planSwap(doc, defsOf(p), targets(doc, a, {min: 2}), {anchor: a.anchor || "centroid", text: !!a.swap_text});
      if (!plan.ok) fail(plan.message);
      S.apply(p, plan);
      return {document_id: doc.id, message: plan.message, ops: plan.ops.length};
    }},
    swap_footprint: {run(p, a) {
      const S = need("AtriumSwap", "library/component-swap.js"), doc = docOf(p, a, "pcb"), defs = defsOf(p), ids = targets(doc, a);
      const part = doc.items.find(i => i.id === ids[0] && i.kind === "part") || fail("Give a component.");
      const target = a.def_id || S.nextVariant(doc, defs, part.id, a.direction === "previous" ? -1 : 1);
      if (!target) fail("No other sizes of this footprint for " + part.ref + ". Pass def_id.");
      const same = a.all_same ? doc.items.filter(i => i.kind === "part" && i.def === part.def).map(i => i.id) : ids;
      const plan = S.planVariant(doc, defs, part.id, target, {project: p, ids: same});
      if (!plan.ok) fail(plan.message);
      S.apply(p, plan);
      return {document_id: doc.id, message: plan.message, def_id: target, parts: same.length};
    }},

    // component classes and dynamic connectors (component-classes.js, dynamic-symbol.js)
    list_component_classes: {run: (p, a) => need("AtriumComponentClasses", "pcb/component-classes.js").headless(p, {...a, op: "list"})},
    component_classes: {run: (p, a) => need("AtriumComponentClasses", "pcb/component-classes.js").headless(p, a)},
    list_dynamic_connectors: {run: (p, a) => need("AtriumDynamicSymbol", "schematic/dynamic-symbol.js").headless(p, {op: "list"})},
    dynamic_symbol: {run: (p, a) => need("AtriumDynamicSymbol", "schematic/dynamic-symbol.js").headless(p, a)},

    // ---------------------------------------------------------------- HDI build-up (viastack.js, hdi.js); hdi-mcp
    hdi_report: {run(p, a) {
      const H = need("AtriumViaStack", "pcb/viastack.js").hdi, doc = docOf(p, a, "pcb"), defs = defsOf(p), c = H.config(doc, defs);
      return {document_id: doc.id, build_up: H.name(c) || null, laminations: c ? H.laminations(c, H.stages(doc, defs, c)) : 0,
        stages: H.stages(doc, defs, c).map(s => ({stage: s.index, kind: s.kind, from: s.from, to: s.to, added: s.added})),
        drill_pairs: H.recommendedPairs(doc, defs, c), notes: H.notes(doc, defs)};
    }},
    hdi_setup: {run(p, a) {
      const X = need("AtriumHDI", "pcb/hdi.js"), doc = docOf(p, a, "pcb"), defs = defsOf(p), b = a.build_up;
      const config = b === "none" ? null : {top: b === "custom" ? a.top ?? 0 : Number(b) || 0, bottom: b === "custom" ? a.bottom ?? a.top ?? 0 : Number(b) || 0,
        anyLayer: b === "any", skip: a.skip, stacking: a.stacking, microvia: a.microvia};
      const H = globalThis.AtriumViaStack.hdi;
      if (config) {
        const requested = H.cleanConfig(config);
        const resolved = H.config({...doc, hdi: requested}, defs);
        if (!resolved || !requested.anyLayer && (resolved.top !== requested.top || resolved.bottom !== requested.bottom))
          fail("The build-up needs more copper layers.");
      }
      const out = X.apply(doc, defs, {config, pairs: a.pairs !== false, rules: a.rules !== false}, p);
      return {document_id: doc.id, build_up: H.name(H.config(doc, defs)) || null, drill_pairs: out.pairs, rules_added: out.rules};
    }},

    // ---------------------------------------------------------------- panelisation (panel.js headless)
    panel_report: {run: (p, a) => need("AtriumPanel", "pcb/panel.js").headless(p, {...a, op: "report"})},
    panel_setup: {run: (p, a) => need("AtriumPanel", "pcb/panel.js").headless(p, {...a, op: "setup"})},

    // ---------------------------------------------------------------- outputs (text body)
    export_dxf: {run(p, a) {
      const X = need("AtriumDXF", "formats/dxf.js"), doc = docOf(p, a, "pcb");
      need("AtriumBoardShapeAuthoring", "pcb/board-shape.js");
      const r = X.exportBoard(doc, defsOf(p), {layers: a.layers || [], units: a.units || "mm", outline: a.outline !== false, holes: !!a.holes,
        origin: a.origin || "absolute"});
      return [{document_id: doc.id, entities: r.entities, name: (doc.name || "board").replace(/[^\w.-]+/g, "_") + ".dxf"}, r.text];
    }}
  };

  function kind(name, args) {
    if (!Object.hasOwn(COMMANDS, name)) return null;
    const command = COMMANDS[name];
    return command.readWhen?.(args) || read.includes(name) ? "read" : "edit";
  }
  function run(project, name, args) {
    const operation = kind(name, args);
    if (!operation) fail("Unknown command " + name + ".");
    if (!project || !Array.isArray(project.documents)) fail("Load the project first.");
    // A released (or obsolete) working revision is read-only: only the revision operations and the active-variant switch edit it.
    if (operation === "edit" && !allowsLockedRevision.includes(name) && globalThis.AtriumRevisions?.locked(project)) fail(AtriumRevisions.message(project));
    return COMMANDS[name].run(project, args || {});
  }
  return Object.freeze({run, kind, names: () => Object.keys(COMMANDS)});
})();
