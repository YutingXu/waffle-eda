"use strict";
// Cross-domain checks and projection (docs/design/unified-rules-and-checks.md §2.4). Loaded with checks.js.
//
// Checks (domains schematic and layout, one Problems row with a location in each document):
//   cross.sync           every difference Update PCB would apply (AtriumECO.plan, as the sync status bar):
//                        "Board out of sync: R12 footprint 0603 → 0805"; Fix opens the ECO.
//   cross.pinMatrix      the ERC connection matrix on the board's own nets (pad nets and the symbol pins'
//                        electrical types): a board-only net edit that shorts two outputs. Pins the
//                        schematic already joins are left to ERC.
//   cross.intent         intent the layout cannot meet: a differential or bus signal (AtriumSignals) whose
//                        nets are missing on a board that has its parts, and every finding of the
//                        impedance checks module through the adapter seam below.
//   cross.footprintPins  a footprint pad no symbol pin maps to, and the reverse, per placed component.
//
// Adapter seam for intent checks from other modules (app/impedance-checks.js and later ones):
//   AtriumChecksCross.intentSource({id, run(project, board, env) → findings})
//   or a module global AtriumImpedanceChecks with check(project, board, env) → findings, read when present.
//   A finding: {check?: "cross.intent.<what>", severity?: error|warning|hint, text, signal?, net?, objects?:
//   [{doc, id}], at?: [{doc, point}], measure?: {actual, required, limit, unit}, sig?}. env: {scopeEnv,
//   model, defs}. Keys follow checks.js: check + objects + sig (no positions).
//
// Projection: a problem is shown in the document that owns its objects and, aggregated, in the other
// editor: board problems on a net as one badge at that net's labels on each sheet ("GND: 3
// problems on Board"), board problems on a component at its symbol, schematic problems of a component
// at its footprint. A badge is the severity glyph drawn hollow with an arrow out, and the count when
// there are several (problem-marks.js). PCB overviews group nearby projected components. A click goes
// to a problem of the component whose badge is drawn.
globalThis.AtriumChecksCross = (() => {
  const G = globalThis, K = () => G.AtriumChecks;
  for (const [id, module, tiers] of [["cross.sync", "AtriumECO", ["warning"]], ["cross.pinMatrix", "AtriumERC", ["error", "warning"]],
    ["cross.intent", "AtriumSignals", ["error", "warning", "hint"]], ["cross.footprintPins", "AtriumChecks", ["warning"]]])
    K().register({id, source: "cross", domains: ["schematic", "layout"], tiers, module, incremental: "project", cost: id === "cross.sync" ? "heavy" : "cheap"});
  const r3 = v => Math.round(v * 1000) / 1000 + 0;
  const pt = p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]) ? [r3(p[0]), r3(p[1])] : null;
  const up = s => String(s ?? "").trim().toUpperCase();

  // ---------------------------------------------------------------- findings → violations
  function fromCross(x) {
    if (!x?.check) return null;
    const objects = (x.objects || []).filter(o => o?.id), at = (x.at || []).map(a => ({doc: a.doc ?? null, point: pt(a.point)})).filter(a => a.point);
    const primary = x.doc ?? objects[0]?.doc ?? at[0]?.doc ?? null;
    const v = {key: K().keyOf(x.check, x.rule || "", (x.keyObjects || objects).map(o => (o.doc ?? "") + "/" + o.id), x.sig ?? x.text), check: x.check, source: "cross", severity: x.severity || "warning",
      domain: x.domain || "schematic", doc: primary, objects, at, text: String(x.text || "")};
    if (x.subject) v.subject = x.subject;
    if (x.measure) v.measure = x.measure;
    if (x.origin) v.origin = x.origin;
    Object.defineProperty(v, "raw", {value: x, enumerable: false});
    return v;
  }

  // ---------------------------------------------------------------- the checks
  const defsOf = p => new Map((p.library || []).map(d => [d.id, d]));
  const partsOf = d => d.items.filter(i => i.kind === "part");
  // The ECO plan of a board, kept while nothing it reads changed: the sheets and the library (journal
  // versions) and the board's components (designator, comment, footprint, link, pad nets, parameters),
  // never its copper, so routing on the board does not compare again.
  const plans = new WeakMap();
  function planOf(E, p, b) {
    const U = G.AtriumUndoStore, parts = [];
    let stamp = "";
    for (const d of p.documents) {
      if (d.kind !== "schematic") continue;
      const v = U?.documentVersions?.(d, p);
      if (!v) { stamp = null; break; }
      stamp += d.id + ":" + v.floor + "/" + v.items + "/" + v.outer + ",";
    }
    const v0 = stamp != null && U?.documentVersions?.(b, p);
    if (v0) {
      for (const i of b.items) if (i.kind === "part") parts.push([i.id, i.ref, i.value, i.def, i.link, i.pinNets, i.parameters, i.locked]);
      stamp += "|" + v0.library + "|" + v0.project + "|" + v0.outer + "|" + JSON.stringify(parts);
    } else stamp = null;
    const hit = plans.get(b);
    if (stamp != null && hit && hit.project === p && hit.stamp === stamp) return hit.plan;
    const plan = E.plan(p, {board: b.id, scope: "*", direction: "pcb"});
    if (stamp != null) plans.set(b, {project: p, stamp, plan});
    return plan;
  }
  const NAMES = 8, list = a => a.slice(0, NAMES).join(", ") + (a.length > NAMES ? " and " + (a.length - NAMES) + " more" : "");
  function sync(p, out, notes) {
    const E = G.AtriumECO;
    if (!E?.plan) return;
    const sheets = p.documents.filter(d => d.kind === "schematic");
    for (const b of p.documents.filter(d => d.kind === "pcb")) {
      if (!sheets.some(s => s.items.some(i => i.kind === "part"))) continue;
      let plan;
      try { plan = planOf(E, p, b); } catch (e) { notes.push(b.name + ": " + e.message); continue; }
      const boardRefs = new Map(partsOf(b).map(i => [up(i.ref), i]));
      // Components not on the board yet: one finding per sheet (their pads and nets come with them), not
      // one per component, pad and net. Nets the board lacks: one finding per board.
      const adding = new Map(), added = new Set(), nets = [];
      for (const c of plan.changes) {
        if (!(c.selected || c.conflict) || c.ignored || c.conflict) continue;
        if (c.action === "addComponent") {
          added.add(up(c.component || c.object));
          let g = adding.get(c.sheet);
          if (!g) adding.set(c.sheet, g = {refs: [], ids: [], name: c.sheetName});
          g.refs.push(c.component || c.object); for (const id of c.sourceIds || []) g.ids.push(id);
        } else if (c.action === "addNet") nets.push(c.object);
      }
      for (const [sheet, g] of adding) {
        const s = sheets.find(d => d.id === sheet), first = s && g.ids.length ? s.items.find(i => i.id === g.ids[0]) : null;
        out.push({check: "cross.sync", severity: "warning", doc: sheet, domain: "schematic", objects: g.ids.map(id => ({doc: sheet, id})), keyObjects: [],
          at: first ? [{doc: sheet, point: [first.x, first.y]}] : [], sig: "addComponent|" + sheet + "|" + b.id,
          text: b.name + " out of sync: " + g.refs.length + " component" + (g.refs.length === 1 ? "" : "s") + " on " + (g.name || s?.name || "a sheet") + " not on the board (" + list(g.refs) + ")",
          subject: {board: b.id, sheet}, fix: {eco: b.id}});
      }
      if (nets.length) out.push({check: "cross.sync", severity: "warning", doc: b.id, domain: "layout", objects: [], at: [], sig: "addNet|" + b.id,
        text: b.name + " out of sync: " + nets.length + " net" + (nets.length === 1 ? "" : "s") + " not on the board (" + list(nets) + ")", subject: {board: b.id}, fix: {eco: b.id}});
      for (const c of plan.changes) {
        if (!(c.selected || c.conflict) || c.ignored) continue;
        if (!c.conflict && (c.action === "addComponent" || c.action === "addNet" || added.has(up(c.component || "")))) continue;
        const objects = [], at = [];
        for (const id of c.sourceIds || []) { const s = sheets.find(d => d.id === c.sheet) || sheets.find(d => d.items.some(i => i.id === id)), it = s?.items.find(i => i.id === id); if (it) { objects.push({doc: s.id, id}); at.push({doc: s.id, point: [it.x, it.y]}); } }
        const bp = boardRefs.get(up(c.component || c.object));
        if (bp) { objects.push({doc: b.id, id: bp.id}); at.push({doc: b.id, point: [bp.x, bp.y]}); }
        const what = String(c.action || "change").replace(/([A-Z])/g, " $1").toLowerCase();
        out.push({check: "cross.sync", severity: "warning", doc: bp ? b.id : objects[0]?.doc, domain: bp ? "layout" : "schematic", objects, at, sig: c.action + "|" + c.object + "|" + (c.after ?? ""),
          text: (c.conflict ? "Conflict: " : "") + b.name + " out of sync: " + (c.object || "") + " " + what + (c.before || c.after ? " (" + (c.before || "none") + " → " + (c.after || "none") + ")" : ""),
          subject: {component: c.component || null, board: b.id}, fix: {eco: b.id}});
      }
    }
  }
  // The schematic net of each component pin (ref/pin), from the live ERC compile when there is one.
  function schematicNets(p) {
    const hier = K().live?.().result?.hierarchy, out = new Map();
    for (const n of hier?.nets || []) for (const x of n.pins) out.set(up(x.ref) + "/" + x.pin.number, n.name);
    return out;
  }
  function pinMatrix(p, out) {
    const E = G.AtriumERC;
    if (!E?.settings) return;
    const cfg = E.settings(p), defs = defsOf(p), sch = schematicNets(p), schDefs = new Map();
    for (const s of p.documents.filter(d => d.kind === "schematic")) for (const i of partsOf(s)) if (defs.get(i.def)?.symbol) schDefs.set(up(i.ref), defs.get(i.def));
    const CLASS = {Warning: "warning", Error: "error", Fatal: "error"}, PIN = E.PIN_TYPES;
    for (const b of p.documents.filter(d => d.kind === "pcb")) {
      const nets = new Map();
      for (const part of partsOf(b)) {
        const sd = defs.get(part.def)?.symbol ? defs.get(part.def) : schDefs.get(up(part.ref));
        const pins = new Map((sd?.symbol?.pins || []).map(q => [String(q.number), q]));
        for (const [num, net] of Object.entries(part.pinNets || {})) {
          const q = pins.get(String(num)), t = q ? E.pinType(q) : undefined;
          if (!net || t === undefined) continue;
          if (!nets.has(net)) nets.set(net, new Map());
          const m = nets.get(net); if (!m.has(t)) m.set(t, []); m.get(t).push({part, num: String(num), q});
        }
      }
      for (const [net, typed] of nets) {
        const types = [...typed.keys()].sort((a, b) => a - b);
        for (let x = 0; x < types.length; x++) for (let y = x; y < types.length; y++) {
          const a = types[x], c = types[y], mode = cfg.matrix[Math.min(a, c) + "," + Math.max(a, c)];
          if (!CLASS[mode] || (a === c && typed.get(a).length < 2)) continue;
          const involved = a === c ? typed.get(a) : [...typed.get(a), ...typed.get(c)];
          // Pins the schematic already joins: ERC reports them there.
          const names = new Set(involved.map(v => sch.get(up(v.part.ref) + "/" + v.num)));
          if (names.size === 1 && !names.has(undefined)) continue;
          const pinText = v => PIN[E.pinType(v.q)] + " pin " + v.part.ref + "-" + v.num;
          out.push({check: "cross.pinMatrix", severity: CLASS[mode], doc: b.id, domain: "layout", objects: involved.slice(0, 8).map(v => ({doc: b.id, id: v.part.id})),
            at: [{doc: b.id, point: [involved[0].part.x, involved[0].part.y]}], sig: net + "|" + a + "," + c, subject: {net},
            text: "Board net " + net + " connects " + (a === c ? "multiple " + PIN[a] + " pins" : PIN[a] + " and " + PIN[c] + " pins") + " (" + involved.slice(0, 4).map(pinText).join(", ") +
              (involved.length > 4 ? " and " + (involved.length - 4) + " more" : "") + "), which the schematic keeps apart"});
        }
      }
    }
  }
  function footprintPins(p, out) {
    const defs = defsOf(p), seen = new Set(), sheets = p.documents.filter(d => d.kind === "schematic");
    const schByRef = new Map();
    for (const s of sheets) for (const i of partsOf(s)) if (!schByRef.has(up(i.ref))) schByRef.set(up(i.ref), {i, s});
    for (const b of p.documents.filter(d => d.kind === "pcb")) for (const part of partsOf(b)) {
      const fd = defs.get(part.def), sc = schByRef.get(up(part.ref)), sd = defs.get(sc?.i.def);
      if (!fd?.footprint || !sd?.symbol || G.AtriumSchObjects?.notElectrical?.(sc.i, sd)) continue;
      const k = sd.id + "|" + fd.id;
      if (seen.has(k)) continue;
      seen.add(k);
      const pins = new Set((sd.symbol.pins || []).map(q => String(q.number ?? "")).filter(Boolean)), pads = new Set((fd.footprint.pads || []).filter(q => !q.thermalVia).map(q => String(q.number ?? "")).filter(Boolean));
      const noPad = [...pins].filter(n => !pads.has(n)), noPin = [...pads].filter(n => !pins.has(n));
      if (!noPad.length && !noPin.length) continue;
      const nat = (x, y) => x.localeCompare(y, undefined, {numeric: true}), list = a => a.sort(nat).slice(0, 8).join(", ") + (a.length > 8 ? " and " + (a.length - 8) + " more" : "");
      out.push({check: "cross.footprintPins", severity: "warning", doc: sc.s.id, domain: "schematic", objects: [{doc: sc.s.id, id: sc.i.id}, {doc: b.id, id: part.id}],
        at: [{doc: sc.s.id, point: [sc.i.x, sc.i.y]}, {doc: b.id, point: [part.x, part.y]}], sig: noPad.join(",") + "|" + noPin.join(","), subject: {component: part.ref},
        text: part.ref + " (" + (sd.name || sd.id) + " on " + (fd.footprint.name || fd.name || fd.id) + "): " + [noPad.length ? "symbol pin" + (noPad.length === 1 ? " " : "s ") + list(noPad) + " " + (noPad.length === 1 ? "has" : "have") + " no footprint pad" : "",
          noPin.length ? "pad" + (noPin.length === 1 ? " " : "s ") + list(noPin) + " " + (noPin.length === 1 ? "has" : "have") + " no symbol pin" : ""].filter(Boolean).join("; ")});
    }
  }
  const intentSources = new Map();
  function intentSource(spec) { if (!spec?.id || typeof spec.run !== "function") throw Error("An intent source needs id and run."); intentSources.set(spec.id, spec); }
  function intent(p, out, notes) {
    const S = G.AtriumSignals, defs = defsOf(p);
    for (const b of p.documents.filter(d => d.kind === "pcb")) {
      let M = null, env = null;
      try { M = S?.model?.(p, b, {defs}) || null; env = S?.scopeEnv?.(b, p) || null; } catch (e) { notes.push(b.name + ": signals: " + e.message); }
      const boardNets = new Set();
      for (const i of b.items) { if (i.net) boardNets.add(i.net); if (i.kind === "part") for (const n of Object.values(i.pinNets || {})) if (n) boardNets.add(n); }
      if (M && boardNets.size) for (const s of M.signals || []) {
        if (s.kind !== "diff" && s.kind !== "bus") continue;
        const nets = [...new Set((s.legs || []).flatMap(l => l.nets || []))], missing = nets.filter(n => !boardNets.has(n));
        if (!missing.length || missing.length === nets.length && s.kind === "bus") continue;
        out.push({check: "cross.intent", severity: "warning", doc: b.id, domain: "layout", objects: [], at: [], sig: s.id + "|" + missing.join(","), subject: {signal: s.name},
          text: (s.kind === "diff" ? "Differential" : "Bus") + " signal " + s.name + ": " + missing.slice(0, 4).join(", ") + (missing.length > 4 ? " and " + (missing.length - 4) + " more" : "") + " not on " + b.name});
      }
      // Other modules' intent checks (impedance targets and the like).
      const sources = [...intentSources.values()];
      if (G.AtriumImpedanceChecks?.check && !intentSources.has("impedance")) sources.push({id: "impedance", run: (pp, bb, e) => G.AtriumImpedanceChecks.check(pp, bb, e)});
      for (const src of sources) {
        let got = [];
        try { got = src.run(p, b, {scopeEnv: env, model: M, defs}) || []; } catch (e) { notes.push(b.name + ": " + src.id + ": " + e.message); }
        for (const f of got) out.push({check: /^cross\.intent(\.|$)/.test(f.check || "") ? f.check : "cross.intent", severity: f.severity || "warning", doc: f.doc ?? b.id, domain: "layout",
          objects: f.objects || [], at: f.at || [], sig: f.sig ?? (src.id + "|" + (f.signal || f.net || "") + "|" + (f.text || "")), subject: {signal: f.signal, net: f.net}, measure: f.measure, text: f.text, origin: {kind: "intent", source: src.id}});
      }
    }
  }
  // Every cross-domain finding of a project (headless and live).
  function run(p, o = {}) {
    const out = [], notes = [], want = id => !o.checks?.length || o.checks.some(c => id === c || id.startsWith(c + ".") || c.startsWith(id));
    if (!p.documents.some(d => d.kind === "pcb") || !p.documents.some(d => d.kind === "schematic")) return {list: [], notes};
    if (want("cross.sync")) sync(p, out, notes);
    if (want("cross.pinMatrix")) pinMatrix(p, out);
    if (want("cross.intent")) intent(p, out, notes);
    if (want("cross.footprintPins")) footprintPins(p, out);
    return {list: out.map(fromCross).filter(Boolean), notes};
  }

  // ---------------------------------------------------------------- live
  let state = {project: null, versions: null};
  function versionsOf(p) {
    const U = G.AtriumUndoStore, parts = [];
    for (const d of p?.documents || []) { const v = U?.documentVersions?.(d, p); if (!v) return null; parts.push(d.id + ":" + v.floor + "/" + v.items + "/" + v.outer); }
    const v0 = p?.documents?.[0] && U?.documentVersions?.(p.documents[0], p);
    return v0 ? parts.join(",") + "|" + v0.library + "|" + v0.project : null;
  }
  let loading = null;
  function client(h) {
    const S = K().scheduler;
    S.client({id: "cross", key: () => "cross:live", phase: () => "idle", unrecorded: "sync", efficiency: true,
      delay: () => (G.AtriumPower?.efficient?.() ? 3000 : 800),
      docs: () => { const p = h.project?.(); return p?.documents?.some(d => d.kind === "pcb") && p.documents.some(d => d.kind === "schematic") ? [p] : []; },
      due(p) {
        if (!G.AtriumECO && G.AtriumLazy?.modules?.().includes("AtriumECO")) { loading ||= G.AtriumLazy.need("AtriumECO").then(() => S.plan("cross", {now: true}), () => {}); return false; }
        return state.project !== p || state.versions == null || state.versions !== versionsOf(p);
      },
      start(p) {
        return (function* () {
          yield;
          const r = run(p);
          state = {project: p, versions: versionsOf(p)};
          K().publish("project", "cross", r.list, x => x);
          return r;
        })();
      }});
  }

  // ---------------------------------------------------------------- projection
  let cache = {rev: -1, project: null, byDoc: new Map()};
  // The net(s) a board problem is on: its subject, else its objects' nets.
  function netsOfProblem(v, board, byId = itemsById(board)) {
    if (v.subject?.net) return [v.subject.net];
    const out = new Set();
    for (const o of v.objects) { const it = byId.get(o.id); if (it?.net) out.add(it.net); }
    return [...out];
  }
  // A document's items by id (the first of an id, as items.find), built once per projection pass.
  let byIdOf = new WeakMap();
  function itemsById(d) {
    let m = byIdOf.get(d);
    if (!m) { m = new Map(); for (const i of d?.items || []) if (i && !m.has(i.id)) m.set(i.id, i); byIdOf.set(d, m); }
    return m;
  }
  // A component's badge sits at its top-right corner, off the body a press selects and drags.
  function corner(h, d, it) {
    let b = null;
    try { b = G.AtriumNavCommon?.itemBox?.(d, h.defs?.(), it); } catch { b = null; }
    return b ? [b[2], b[1]] : [it.x, it.y];
  }
  // Badges to draw on document d: {at, count, text, problems, severity}.
  function projected(h, d) {
    const C = K(), p = h.project?.();
    if (!C || !p || !d) return [];
    if (cache.rev !== C.revision() || cache.project !== p) cache = {rev: C.revision(), project: p, byDoc: new Map()};
    if (cache.byDoc.has(d.id)) return cache.byDoc.get(d.id);
    byIdOf = new WeakMap();
    // at: a point, or a function giving it (evaluated once per badge).
    const badges = new Map(), add = (key, at, v, label) => {
      let b = badges.get(key);
      if (!b) {
        if (typeof at === "function") at = at();
        if (!at) return;
        badges.set(key, b = {at, problems: [], label, severity: v.severity});
      } else if (!at) return;
      b.problems.push(v);
      if ((C.SEV_RANK[v.severity] ?? 9) < (C.SEV_RANK[b.severity] ?? 9)) b.severity = v.severity;
    };
    if (d.kind === "schematic") {
      const graph = C.live?.().result?.graphs?.find(g => g.doc === d), byRef = new Map(partsOf(d).map(i => [up(i.ref), i]));
      for (const v of C.violations({domain: "layout"})) {
        if (v.severity === "hint" || v.source === "drc-waived") continue;
        const board = p.documents.find(x => x.id === v.doc);
        if (!board || board.kind !== "pcb") continue;
        // Problems on a component: at its symbol.
        let placed = false;
        for (const o of v.objects) {
          const it = itemsById(board).get(o.id);
          if (it?.kind !== "part") continue;
          const s = byRef.get(up(it.ref));
          if (s) { add("part:" + s.id, () => corner(h, d, s), v, it.ref); placed = true; }
        }
        if (placed || !graph) continue;
        // Problems on a net: at the net's labels on this sheet (else its first pin).
        for (const net of netsOfProblem(v, board)) {
          const g = graph.nets.find(n => n.name === net || n.names?.has?.(net));
          if (!g) continue;
          const src = g.sources?.[0]?.item, at = src && Number.isFinite(src.x) ? [src.x, src.y] : g.pins?.[0]?.pin?.at;
          add("net:" + net, at, v, net);
        }
      }
    } else if (d.kind === "pcb") {
      const byRef = new Map(partsOf(d).map(i => [up(i.ref), i]));
      const sheets = new Map(p.documents.filter(x => x.kind === "schematic").map(x => [x.id, x]));
      for (const v of C.violations({domain: "schematic"})) {
        // Uncompiled hints stay on their source document. ERC can also report board-owned findings.
        if (v.source === "cross" || v.severity === "hint" || !sheets.has(v.doc)) continue;
        for (const o of v.objects) {
          const sheet = sheets.get(o.doc ?? v.doc);
          const it = sheet && itemsById(sheet).get(o.id);
          if (it?.kind !== "part") continue;
          const bp = byRef.get(up(it.ref));
          if (bp) add("part:" + bp.id, () => corner(h, d, bp), v, it.ref);
        }
      }
    }
    const list = [...badges.values()].map(b => {
      const where = d.kind === "schematic" ? "on the board" : "on the schematic";
      return {...b, count: b.problems.length, text: b.label + ": " + b.problems.length + " problem" + (b.problems.length === 1 ? "" : "s") + " " + where + " (" + [...new Set(b.problems.map(v => C.title(v.check)))].slice(0, 3).join(", ") + ")"};
    });
    cache.byDoc.set(d.id, list);
    return list;
  }
  // Board badges (schematic problems of a component); sheets draw theirs in sch-markers.js.
  let planFor;
  const badgeScore = b => -(K().SEV_RANK[b.severity] ?? 9);
  const badgeReaches = ({screen:[x,y], radius}, [left,top,right,bottom]) =>
    x + radius >= left && x - radius <= right && y + radius >= top && y - radius <= bottom;
  function boardBadgePlan(d, frame, list) {
    const P = G.AtriumProblemMarks;
    const cell = P.pcbCell(frame);
    if (!cell || list.length < 2) return null;
    return (planFor ||= P.register())(d, frame, [list], () => {
      const {at: offset, radius: reach} = P.badgeDetail([0,0], frame.scale, "pcb");
      const center = b => [b.at[0] + offset[0], b.at[1] + offset[1]];
      const groups = P.cells(list, b => b.at, 1, cell, badgeScore), marks = [];
      const view = frame.width && frame.height && [0,0,frame.width,frame.height];
      const radius = reach + 5;
      for (const group of groups) {
        const rep = P.visibleWinner(group, frame, center, badgeScore);
        const badge = group.members.length > 1 ? {at:rep.at, severity:rep.severity, count:1} : rep;
        const at = center(rep), screen = frame.worldToScreen(at);
        // The original count on an isolated badge may extend beyond its glyph.
        const mark = {at, screen, reach, radius:badge.count > 1 ? radius + 20 : radius, live:true, group, rep, badge};
        if (!view || badgeReaches(mark, view)) marks.push(mark);
      }
      return {marks, badges:marks.map(m => m.badge), groups, center, radius};
    });
  }
  function groupBadge(mark) {
    const {group, rep} = mark;
    if (group.members.length === 1) return rep;
    if (mark.detail) return mark.detail;
    // Keep the winning component's own most severe problem first for the existing cross-probe.
    const entries = new Map(), first = rep.problems.find(v => v.severity === rep.severity) || rep.problems[0];
    const add = (raw, label) => {
      if (!entries.has(raw)) entries.set(raw, {raw, labels:[]});
      const labels = entries.get(raw).labels;
      if (!labels.includes(label)) labels.push(label);
    };
    if (first) add(first, rep.label);
    for (const b of group.members) for (const v of b.problems) add(v, b.label);
    return mark.detail = {...rep, count:entries.size, problems:[...entries.keys()], entries:[...entries.values()]};
  }
  function render(h, d) {
    if (d?.kind !== "pcb") return null;
    const list = projected(h, d);
    if (!list.length) return null;
    const overlay = (ctx, a) => {
      const plan = boardBadgePlan(d, a, list);
      const areas = a.damageRects?.length ? a.damageRects : a.area ? [a.area] : null;
      const badges = !plan ? list : !areas ? plan.badges : plan.marks.filter(m => areas.some(box => badgeReaches(m,box))).map(m => m.badge);
      const M = G.AtriumProblemMarks;
      M.paintBadges(ctx, a, badges, "pcb", M.BOARD);
    };
    if (list.length > 1) overlay.panDamage = (a, dx, dy) => {
      const plan = boardBadgePlan(d, a, list);
      return plan ? G.AtriumProblemMarks.groupPanDamage(plan.groups, a, plan.center, badgeScore, plan.radius, dx, dy) : [];
    };
    return {overlay};
  }
  function badgeAt(h, pane, cx, cy) {
    const d = h.docById?.(pane.docId);
    if (!d) return null;
    const b = pane.canvas.getBoundingClientRect();
    const list = projected(h, d), x = cx - b.left, y = cy - b.top;
    const P = G.AtriumProblemMarks;
    const plan = d.kind === "pcb" && boardBadgePlan(d, P.paneFrame(pane, b), list);
    if (!plan) return P.badgeUnder(pane, list, d.kind === "pcb" ? "pcb" : "schematic", x, y);
    const hit = P.pick(plan, x, y);
    return hit ? groupBadge(hit) : null;
  }
  let host = null;
  function attach(h) {
    if (host === h) return;
    host = h;
    client(h);
    K().scheduler.plan("cross");
    h.addRenderer?.(d => render(h, d));
    if (typeof document === "undefined") return;
    const paneOf = c => h.panes?.().find(p => p.canvas === c) || null;
    document.addEventListener("pointerdown", e => {
      if (e.target?.tagName !== "CANVAS" || e.button !== 0 || e.altKey || e.shiftKey || e.ctrlKey || e.metaKey || h.tool?.() !== "select") return;
      const pane = paneOf(e.target), b = pane && badgeAt(h, pane, e.clientX, e.clientY);
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      h.info?.(b.text);
      K().focus(h, b.problems[0]); // cross-probe to the problem in its own document
    }, true);
  }
  G.AtriumNavCommon?.ready?.(h => { if (K()) attach(h); });
  return Object.freeze({run, fromCross, intentSource, projected, badgeAt, attach, versionsOf});
})();
