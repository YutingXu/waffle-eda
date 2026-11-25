"use strict";
// Waivers (docs/design/unified-rules-and-checks.md §2.5): one model for the problems a reviewer has
// accepted, in both editors. Lazy (app/lazy.js "AtriumWaivers"); drc-waivers.js keeps its API as an
// alias over this one.
//
// Identity. A waiver is keyed by the violation key (checks.js keyOf: check, rule name, object IDs and
// a meaning signature, never a position), so it survives moves. How it holds:
//   while-not-worse  (default for a measured violation) holds while the measured value is no worse
//                    than the waived one (plus a small tolerance): a 0.186 mm clearance waived against
//                    0.2 mm still holds at 0.19 mm after a nudge, and turns stale at 0.15 mm.
//   until-changed    (default for an unmeasured one) holds while its objects keep their signature (what
//                    the check reads of them).
//   always           an accepted design decision: holds while its objects exist.
// A waiver whose objects were deleted, changed (until-changed) or got worse (while-not-worse) is never
// deleted behind the user's back: it is "stale", the violation shows again, and Problems lists it under
// "Waivers to review" with Keep (re-baseline at today's value), Re-waive and Remove. Only the user, or
// the explicit Remove Stale Waivers, removes one. A waiver whose violation is gone is "unused".
//
// Storage is where the objects live (docs/format-versioning.md):
//   board waivers   doc.drcWaivers = [{id, key, check, holds, objects: [id], geometry, note, created, title,
//                   rule?, ruleId?, at?, measure?: {actual, required, limit, unit}, author?}]
//   schematic       project.waivers = {version: 1, list: [{id, key, check, holds, objects: [{doc, id}],
//                   geometry, note, created, title?, author?, measure?}]} (ERC, cross-domain)
//   hints           project.insights (insights.js dismissals and muted checks), read through records().
// Readers take well-formed records only.
//
// API (pure; no DOM):
//   records(project, doc?)                   every waiver as {id, store, doc, key, check, holds, note, ...}
//   waive(project, violation, {note, holds, author, date})   one record (call inside edit() for undo)
//   remove(project, ids)  keep(project, id, violation?)  removeStale(project, violations?)
//   match(project, violations)               {active, waived: [{violation, waiver}], stale: [record], states}
//   state(record, project, violation?)       "holds" | "stale" | "unused"
//   holdsFor(violation)  canWaive(violation)  signature(item)  diff(before, after)
globalThis.AtriumWaivers = (() => {
  const G = globalThis, K = () => G.AtriumChecks;
  const HOLDS = Object.freeze(["while-not-worse", "until-changed", "always"]), STORE_VERSION = 1, MAX = 5000, NOTE = 500;
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const str = v => typeof v === "string";
  const stamp = () => new Date().toISOString().slice(0, 19) + "Z";
  const newId = () => G.Atrium.id();
  // What DRC reads of a board object (drc-waivers.js FIELDS), and what ERC reads of a schematic one
  // (not its position: a moved symbol keeps its waiver).
  const PCB_FIELDS = ["kind", "x", "y", "angle", "points", "width", "diameter", "drill", "w", "h", "shape", "layer", "fromLayer", "toLayer", "net", "pinNets", "def",
    "side", "mirror", "closed", "fill", "keepout", "plated", "stackMode", "padStack", "template", "backdrill", "text", "size"];
  const SCH_FIELDS = ["kind", "def", "ref", "unit", "part", "text", "net", "pinNets", "noConnect", "hidden"];
  function hash(s) {
    let h1 = 2166136261, h2 = 5381;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2, 33) ^ c; }
    return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
  }
  function signature(item, kind = "pcb") { return item ? hash(JSON.stringify((kind === "schematic" ? SCH_FIELDS : PCB_FIELDS).map(k => item[k] ?? null))) : null; }
  // checks.js keyOf, for a DRC violation when checks.js is not loaded (headless runners).
  const keyOf = (check, rule, ids, sig) => K()?.keyOf ? K().keyOf(check, rule, ids, sig) : check + ":" + hash(String(rule ?? "") + "|" + [...new Set(ids)].sort().join(",") + "|" + String(sig ?? ""));
  // A violation in the unified shape (checks.js), from a DRC violation when given one.
  function unified(v, doc) {
    if (!v) return null;
    if (v.key && v.check && Array.isArray(v.objects)) return v;
    if (K()?.fromDRC) return K().fromDRC(v, doc);
    // Without checks.js (headless runners that load only this and drc-waivers.js): the same key and fields.
    if (!v.type) return null;
    const d = typeof doc === "string" ? doc : doc?.id ?? null, ids = [...new Set([v.id, v.otherId].filter(x => str(x) && x))].sort(), check = "layout." + v.type;
    // As checks.js fromDRC: net-wide checks are keyed on their net.
    const net = /^(?:length|matchedLengths|delay|matchedDelays|unrouted)$/.test(v.type) ? v.net || /^Net (\S+)/.exec(v.title || "")?.[1] : null;
    const pad = v.type === "annularRing" ? v.subject?.padKey : null;
    const primitive = v.subject?.legendPrimitive, sig = pad ?? (primitive ? "legend:" + primitive : "");
    const out = {key: net ? keyOf(check, v.ruleName || "", [], "net:" + net) : keyOf(check, v.ruleName || "", ids, sig), check, source: "drc", domain: "layout", doc: d, objects: ids.map(id => ({doc: d, id})), text: String(v.title || ""),
      measure: v.actual != null ? {actual: v.actual, required: v.required ?? null, limit: v.limit || "min", unit: "mm"} : null};
    if (pad) {
      const rule = v.ruleName || "", fallback = v.subject.padFallback;
      Object.defineProperty(out, "keys", {value: [...(fallback ? [keyOf(check, rule, ids, fallback)] : []), keyOf(check, rule, ids)], enumerable: false});
    }
    Object.defineProperty(out, "raw", {value: v, enumerable: false});
    return out;
  }
  const idsOf = v => [...new Set((v.objects || []).map(o => o.id).filter(str))].sort();
  function canWaive(v) { const u = unified(v); return !!u && idsOf(u).length > 0 && u.source !== "insights" ? true : !!u && u.source === "insights"; }
  const holdsFor = v => v?.measure && Number.isFinite(v.measure.actual) && Number.isFinite(v.measure.required) ? "while-not-worse" : "until-changed";

  // ---------------------------------------------------------------- stores
  const validBoard = w => plain(w) && str(w.id) && str(w.key) && str(w.check) && Array.isArray(w.objects) && w.objects.length > 0 && w.objects.every(str) && plain(w.geometry);
  const validProject = w => plain(w) && str(w.id) && str(w.key) && str(w.check) && Array.isArray(w.objects) && w.objects.every(o => plain(o) && str(o.id));
  function projectStore(project) {
    const s = project?.waivers;
    if (!plain(s) || !Array.isArray(s.list)) return [];
    return s.list.filter(validProject);
  }
  function writableProject(project) {
    if (!plain(project)) throw Error("No project to keep the waiver in.");
    let s = project.waivers;
    if (s == null) s = project.waivers = {version: STORE_VERSION, list: []};
    if (!plain(s) || (s.list != null && !Array.isArray(s.list))) throw Error("The project's waivers are not readable by this version; nothing was changed.");
    if (!Number.isInteger(s.version)) s.version = STORE_VERSION;
    if (!s.list) s.list = [];
    return s;
  }
  const boards = (project, doc) => doc ? [doc] : (project?.documents || []).filter(d => d.kind === "pcb");
  const holdsOf = w => HOLDS.includes(w.holds) ? w.holds : holdsFor(w);
  // Every waiver, one shape: {id, store: board|project|insights, doc, key, check, holds, objects, note, created, author?, measure?, record}.
  function records(project, doc = null) {
    const out = [];
    for (const d of boards(project, doc?.kind === "pcb" ? doc : doc ? null : null)) {
      if (doc && d !== doc) continue;
      for (const w of Array.isArray(d.drcWaivers) ? d.drcWaivers : []) if (validBoard(w))
        out.push({id: w.id, store: "board", doc: d.id, key: w.key, check: w.check, rule: w.rule, holds: holdsOf(w), objects: w.objects.map(id => ({doc: d.id, id})),
          note: str(w.note) ? w.note : "", created: w.created || null, author: w.author || null, title: w.title || "", measure: plain(w.measure) ? w.measure : null, record: w});
    }
    if (!doc || doc.kind === "schematic") for (const w of projectStore(project)) {
      if (doc && !w.objects.some(o => o.doc === doc.id)) continue;
      out.push({id: w.id, store: "project", doc: w.objects[0]?.doc ?? null, key: w.key, check: w.check, holds: holdsOf(w), objects: w.objects.map(o => ({doc: o.doc ?? null, id: o.id})),
        note: str(w.note) ? w.note : "", created: w.created || null, author: w.author || null, title: w.title || "", measure: plain(w.measure) ? w.measure : null, record: w});
    }
    const ins = project?.insights;
    if (plain(ins) && plain(ins.dismissed)) for (const [k, r] of Object.entries(ins.dismissed)) {
      if (!plain(r) || (doc && r.doc !== doc.id)) continue;
      const domain = (project?.documents || []).find(d => d.id === r.doc)?.kind === "pcb" ? "layout" : "schematic";
      out.push({id: k, store: "insights", doc: r.doc || null, key: domain + ".hint." + k.replace(/:/, ":"), insightKey: k, check: domain + ".hint." + String(r.check || k.split(":")[0]), holds: "always",
        objects: (Array.isArray(r.objects) ? r.objects : []).map(id => ({doc: r.doc || null, id})), note: str(r.note) ? r.note : "", created: r.date || null, title: r.title || "", record: r});
    }
    return out;
  }

  // ---------------------------------------------------------------- holding
  const itemIndex = new WeakMap();
  function byId(d) {
    let m = itemIndex.get(d);
    if (!m || m.items !== d.items || m.n !== d.items.length) { m = {items: d.items, n: d.items.length, map: new Map(d.items.map(i => [i.id, i]))}; itemIndex.set(d, m); }
    return m.map;
  }
  const docOf = (project, id) => (project?.documents || []).find(d => d.id === id) || null;
  // Every object of the waiver still exists (and, for until-changed, keeps its signature).
  function objectsHold(rec, project, exact) {
    for (const o of rec.objects) {
      const d = docOf(project, o.doc), item = d && byId(d).get(o.id);
      if (!item) return false;
      if (exact) {
        const g = rec.record?.geometry;
        if (plain(g) && g[o.id] != null && g[o.id] !== signature(item, d.kind === "schematic" ? "schematic" : "pcb")) return false;
      }
    }
    return true;
  }
  // No worse than waived: for a minimum, the actual may not fall below the waived actual; for a maximum,
  // it may not rise above it. The tolerance is 0.5 µm or 0.1 %, whichever is larger.
  // No worse: the shortfall (how far the value misses the requirement) is no larger than when waived, and
  // the requirement itself has not tightened (a stricter rule or a longer match target needs a new look).
  function noWorse(rec, v) {
    const was = rec.measure, now = v?.measure;
    if (!was || !Number.isFinite(was.actual) || !now || !Number.isFinite(now.actual)) return true;
    const max = (now.limit || was.limit) === "max", tol = Math.max(0.0005, Math.abs(was.actual) * 0.001);
    const req = Number.isFinite(now.required) ? now.required : was.required, wreq = Number.isFinite(was.required) ? was.required : req;
    if (Number.isFinite(req) && Number.isFinite(wreq) && (max ? req < wreq - tol : req > wreq + tol)) return false;
    const short = x => max ? x.actual - (x.required ?? wreq) : (x.required ?? wreq) - x.actual;
    return Number.isFinite(wreq) ? short(now) <= short(was) + tol : max ? now.actual <= was.actual + tol : now.actual >= was.actual - tol;
  }
  // A measure DRC clipped at zero (an annular ring or an edge distance that is already gone) cannot show
  // that it got worse: such a waiver also needs its objects unchanged.
  const clipped = m => !!m && m.limit !== "max" && Number.isFinite(m.actual) && m.actual <= 0;
  const meaningOf = v => v?.origin?.kind === "calculation" ? v.raw?.meaning : null;
  // holds | stale | unused, for one record and the violation with its key (if any).
  // gone: the caller checked every problem of the waiver's document and found none with its key while its
  // objects are still there (a fixed problem, or one whose identity changed): stale, to review.
  function state(rec, project, v, gone = false) {
    if (rec.store === "insights") return v ? "holds" : "unused";
    const holds = rec.holds;
    if (!objectsHold(rec, project, holds === "until-changed" || (holds === "while-not-worse" && clipped(rec.measure)))) return "stale";
    if (!v) return gone ? "stale" : "unused";
    const meaning = meaningOf(v);
    if (meaning && meaning !== rec.record?.meaning) return "stale";
    if (holds === "while-not-worse" && !noWorse(rec, v)) return "stale";
    return "holds";
  }
  // Waivers applied to violations (unified shape, or DRC violations of one board with o.doc).
  function match(project, violations, o = {}) {
    const recs = o.records || records(project, o.doc || null), byKey = new Map();
    for (const r of recs) if (r.store !== "insights" && !byKey.has(r.key)) byKey.set(r.key, r);
    const muted = plain(project?.insights?.muted) ? project.insights.muted : {};
    const insightKeys = new Map(recs.filter(r => r.store === "insights").map(r => [r.insightKey, r]));
    const active = [], waived = [], seen = new Map();
    for (const x of violations) {
      const v = unified(x, o.doc);
      let rec = v ? byKey.get(v.key) : null;
      if (!rec && v?.keys) for (const k of v.keys) if ((rec = byKey.get(k))) break;
      if (!rec && v?.source === "insights") {
        const raw = v.raw, fallback = raw?.dismissalKeys?.find(key => insightKeys.has(key));
        rec = insightKeys.get(raw?.key) || insightKeys.get(fallback) ||
          (Object.hasOwn(muted, raw?.check) ? {id: "muted:" + raw.check, store: "insights", holds: "always", check: v.check, note: "", muted: true} : null);
      }
      const st = rec ? (rec.muted ? "holds" : state(rec, project, v)) : null;
      // A saved component-wide waiver can cover several drills. Any stale match takes precedence.
      if (rec && seen.get(rec.id) !== "stale") seen.set(rec.id, st);
      if (st === "holds") waived.push({violation: x, waiver: rec.record || rec, record: rec});
      else active.push(x);
    }
    // o.complete(docId): true when `violations` holds every problem of that document (Problems, MCP check).
    const states = new Map();
    for (const r of recs) states.set(r.id, seen.get(r.id) || state(r, project, null, !!o.complete && r.store !== "insights" && !!r.doc && !!o.complete(r.doc, r)));
    return {active, waived, stale: recs.filter(r => states.get(r.id) === "stale"), states, records: recs};
  }

  // ---------------------------------------------------------------- editing (inside edit() for undo)
  function waive(project, x, o = {}) {
    // A merged problem (checks.js merge) is waived as the engine's own finding: its check, type and key.
    const u = unified(x, o.doc), v = u?.member && u.member !== u ? u.member : u;
    if (!v) throw Error("This problem cannot be waived.");
    const holds = HOLDS.includes(o.holds) ? o.holds : holdsFor(v), note = String(o.note || "").slice(0, NOTE), date = o.date || stamp();
    if (v.source === "insights") {
      const I = G.AtriumInsights;
      if (!I?.dismiss) throw Error("Design Insights are not loaded.");
      return {id: I.dismiss(project, v.raw, {note, date: date.slice(0, 10)}), store: "insights"};
    }
    const ids = idsOf(v);
    if (!ids.length) throw Error("This violation names no object, so it cannot be waived. Ignore Until Next Check hides it for this session.");
    const measure = v.measure && Number.isFinite(v.measure.actual) ? {actual: v.measure.actual, required: v.measure.required ?? null, limit: v.measure.limit || "min", unit: v.measure.unit || "mm"} : null;
    if (v.domain === "layout" && v.objects.every(ob => ob.doc === v.doc)) {
      const d = docOf(project, v.doc) || (o.doc?.id === v.doc ? o.doc : null);
      if (!d || d.kind !== "pcb") throw Error("Waivers belong to a PCB layout.");
      const items = byId(d);
      for (const id of ids) if (!items.has(id)) throw Error("The violation's objects are no longer on the board. Run the design rule check again.");
      const list = Array.isArray(d.drcWaivers) ? d.drcWaivers : (d.drcWaivers = []);
      const raw = v.raw || {}, rule = String(raw.ruleName ?? v.ruleName ?? "");
      const geometry = Object.fromEntries(ids.map(id => [id, signature(items.get(id))]));
      const old = list.find(w => validBoard(w) && w.key === v.key);
      if (old) {
        // Waiving again re-baselines it; how it holds changes only when asked.
        old.note = note; old.geometry = geometry;
        old.holds = HOLDS.includes(o.holds) ? o.holds : holdsOf(old);
        if (measure) old.measure = measure;
        if (o.author) old.author = String(o.author).slice(0, 80);
        return old;
      }
      if (list.length >= MAX) throw Error("This board already has " + MAX + " waivers.");
      const at = v.at?.[0]?.point;
      const w = {id: newId(), key: v.key, check: v.check, holds, ...(rule ? {rule} : {}), objects: ids, geometry, note, created: date, title: String(raw.title || v.text || "").slice(0, 300), ...(at ? {at: [+at[0], +at[1]]} : {}),
        ...(measure ? {measure} : {}), ...(o.author ? {author: String(o.author).slice(0, 80)} : {})};
      if (raw.ruleId || v.ruleId) w.ruleId = String(raw.ruleId || v.ruleId);
      list.push(w);
      return w;
    }
    // Schematic and cross-document waivers: project.waivers.
    const s = writableProject(project), objects = v.objects.filter(ob => str(ob.id)).map(ob => ({doc: ob.doc ?? v.doc ?? null, id: ob.id}));
    const geometry = {};
    for (const ob of objects) { const d = docOf(project, ob.doc), item = d && byId(d).get(ob.id); if (item) geometry[ob.id] = signature(item, d.kind === "schematic" ? "schematic" : "pcb"); }
    const old = s.list.find(w => validProject(w) && w.key === v.key), meaning = meaningOf(v);
    if (old) { old.note = note; old.geometry = geometry; old.holds = holds; if (meaning) old.meaning = meaning; if (measure) old.measure = measure; if (o.author) old.author = String(o.author).slice(0, 80); return old; }
    if (s.list.length >= MAX) throw Error("This project already has " + MAX + " waivers.");
    const w = {id: newId(), key: v.key, check: v.check, objects, geometry, note, created: date, holds, title: String(v.text || "").slice(0, 300),
      ...(meaning ? {meaning} : {}), ...(measure ? {measure} : {}), ...(o.author ? {author: String(o.author).slice(0, 80)} : {})};
    s.list.push(w);
    return w;
  }
  // Remove waivers by id (any store). Returns the number removed.
  function remove(project, which) {
    const set = new Set([].concat(which).filter(str));
    let n = 0;
    for (const d of boards(project)) {
      if (!Array.isArray(d.drcWaivers)) continue;
      const before = d.drcWaivers.length;
      d.drcWaivers = d.drcWaivers.filter(w => !set.has(w?.id));
      n += before - d.drcWaivers.length;
      if (!d.drcWaivers.length) delete d.drcWaivers;
    }
    if (plain(project?.waivers) && Array.isArray(project.waivers.list)) {
      const before = project.waivers.list.length;
      project.waivers.list = project.waivers.list.filter(w => !set.has(w?.id));
      n += before - project.waivers.list.length;
    }
    if (plain(project?.insights?.dismissed)) for (const k of Object.keys(project.insights.dismissed)) if (set.has(k)) { delete project.insights.dismissed[k]; n++; }
    return n;
  }
  // Keep a stale waiver: re-baseline it at today's objects (and today's value when the violation is given).
  function keep(project, id, x) {
    const rec = records(project).find(r => r.id === id);
    if (!rec || rec.store === "insights") return null;
    const w = rec.record, v = x ? unified(x, rec.doc) : null;
    const geometry = {};
    for (const o of rec.objects) { const d = docOf(project, o.doc), item = d && byId(d).get(o.id); if (item) geometry[o.id] = signature(item, d.kind === "schematic" ? "schematic" : "pcb"); }
    if (rec.objects.some(o => geometry[o.id] == null)) throw Error("Some of this waiver's objects were deleted. Remove the waiver, or waive the problem again.");
    w.geometry = geometry;
    const meaning = meaningOf(v);
    if (meaning) w.meaning = meaning;
    if (v?.measure && Number.isFinite(v.measure.actual)) w.measure = {actual: v.measure.actual, required: v.measure.required ?? null, limit: v.measure.limit || "min", unit: v.measure.unit || "mm"};
    w.kept = stamp();
    return w;
  }
  function removeStale(project, violations = []) { const m = match(project, violations); return m.stale.length ? remove(project, m.stale.map(r => r.id)) : 0; }

  // ---------------------------------------------------------------- diffs (diff.js "waivers" category)
  // Waivers added, removed, changed (note, holds) and stale (their objects changed since they were waived:
  // until-changed signatures or deleted objects; while-not-worse needs a check run and is not decided here).
  function diff(before, after) {
    const a = new Map(records(before).map(r => [r.store + ":" + r.id, r])), b = new Map(records(after).map(r => [r.store + ":" + r.id, r])), out = [];
    for (const [k, r] of b) {
      const p = a.get(k);
      if (!p) { out.push({kind: "added", waiver: r}); continue; }
      const fields = ["note", "holds", "author"].filter(f => (p[f] ?? null) !== (r[f] ?? null));
      if (JSON.stringify(p.measure ?? null) !== JSON.stringify(r.measure ?? null) || JSON.stringify(p.record?.geometry ?? null) !== JSON.stringify(r.record?.geometry ?? null)) fields.push("baseline");
      if (fields.length) out.push({kind: "changed", waiver: r, before: p, fields});
    }
    for (const [k, r] of a) if (!b.has(k)) out.push({kind: "removed", waiver: r});
    // Muted hint checks (Dismiss all of this kind): a waiver of a whole check.
    const mutedOf = p => plain(p?.insights?.muted) ? p.insights.muted : {}, ma = mutedOf(before), mb = mutedOf(after);
    const mutedRec = (c, r) => ({id: "muted:" + c, store: "insights", doc: null, key: "muted:" + c, check: c, holds: "always", objects: [], note: "", created: r?.date || null, title: "All “" + c + "” hints"});
    for (const c of Object.keys(mb)) if (!Object.hasOwn(ma, c)) out.push({kind: "added", waiver: mutedRec(c, mb[c])});
    for (const c of Object.keys(ma)) if (!Object.hasOwn(mb, c)) out.push({kind: "removed", waiver: mutedRec(c, ma[c])});
    for (const r of b.values()) if (r.store !== "insights" && !objectsHold(r, after, r.holds === "until-changed") && (!a.has(r.store + ":" + r.id) || objectsHold(a.get(r.store + ":" + r.id), before, r.holds === "until-changed")))
      out.push({kind: "stale", waiver: r});
    return out;
  }

  return Object.freeze({HOLDS, STORE_VERSION, records, waive, remove, keep, removeStale, match, state, holdsFor, canWaive, signature, diff, validBoard, validProject, noWorse});
})();
