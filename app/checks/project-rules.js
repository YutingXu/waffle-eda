"use strict";
// Project rules (docs/design/unified-rules-and-checks.md §1.2–1.6): the one rule store of a project, for the
// schematic and the layout (format 1.4, docs/format-versioning.md).
//
//   project.rules = {format: "atrium-rules", version: 3, units: "mm", list: [RULE...],
//     keys?: {ruleSets, netCurrents, classCurrents}, boardKeys?: {[boardId]: {...the same keys for one board}}}
//   RULE = a version 2 rule (rules.js) plus, optionally:
//     severity: fatal | error | warning | hint | off   where: schematic | layout | both
//     boards: [docId] (layout: only these boards)    sheets: [docId] (schematic)   origin: {kind, ...}
//   and the schematic rule types (ERC): one per ERC check, erc<Check> (ercFloatingInputs, ...), with a
//   severity; ercPinMatrix {matrix: {"a,b": level}}; ercNetScope {netScope}. AtriumERC.CHECKS names them.
//
// Nothing else stores rules: boards have no rules of their own in a file, and net classes, pairs and their
// classes are the signal model's (signals.js). A project without project.rules has the default book. Rule ids
// are unique per board (two boards may each keep their "clearance-1").
//
//   AtriumProjectRules.validate(book, invalid?, lenient?)
//   AtriumProjectRules.book(project)        the stored book, else the default one (the same object until an edit)
//   AtriumProjectRules.forBoard(project, board, book?)  the version 2 set the rule engine reads for a board
//                                            (memoised until the board's rule inputs change)
//   AtriumProjectRules.erc(project, book?)  the ERC settings the unscoped ERC rules give (AtriumERC.stored shape)
//   AtriumProjectRules.edit(project, fn)    fn(book) on a copy, validated, stored (the caller's edit step)
//   AtriumProjectRules.store(project, board, set, extras?)  a board's rules become `set` (setBoard + edit)
//   AtriumProjectRules.absorb(project, docs) imported boards' rules (doc.rules) and net scope hints join the book
//   AtriumProjectRules.types / ercType(id)  rule type metadata: domains, where, defaultSeverity
// Lazy (loaded with AtriumRules).
globalThis.AtriumProjectRules = (() => {
  const G = globalThis, VERSION = 3;
  const R = () => G.AtriumRules || fail("Design rules are not loaded.");
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const fail = m => { throw Error(m); };
  const SEVERITIES = ["fatal", "error", "warning", "hint", "off"], WHERE = ["schematic", "layout", "both"];
  const V3_FIELDS = ["severity", "where", "boards", "exceptBoards", "sheets", "origin"];
  const KEY_FIELDS = ["ruleSets", "netCurrents", "classCurrents"];
  // Class and pair keys a version 2 set may carry in memory (an importer's set, an editor's working copy):
  // they belong to the signal model, never to the book.
  const CLASS_KEYS = ["netClasses", "diffPairs", "diffPairClasses"];
  const BOOK_KEYS = new Set(["format", "version", "units", "list", "keys", "boardKeys", "calculationTolerances"]);
  const CALCULATION = "ercCalculationAssertion";
  const TOLERANCE_TYPES = new Set(["resistor", "capacitor", "inductor"]);
  const boardsOf = project => (project?.documents || []).filter(d => d?.kind === "pcb");

  // ------------------------------------------------------------------ rule type metadata
  const LEVEL_SEVERITY = {"No Report": "off", Warning: "warning", Error: "error", Fatal: "fatal"};
  const SEVERITY_LEVEL = {off: "No Report", hint: "Warning", warning: "Warning", error: "Error", fatal: "Fatal"};
  const pascal = id => id.charAt(0).toUpperCase() + id.slice(1);
  const ercType = id => "erc" + pascal(id);
  function ercChecks() { return G.AtriumERC?.CHECKS || []; }
  // {type: {title, category, domains, where, defaultSeverity, check?}}; layout types come from rules.js TYPES.
  function types() {
    const out = {};
    for (const [k, t] of Object.entries(R().types)) out[k] = {title: t.title, category: t.category, domains: ["layout"], where: "layout", defaultSeverity: "error"};
    for (const c of ercChecks()) out[ercType(c.id)] = {title: c.name, category: c.authored ? c.group : "Schematic", domains: c.id === "boardMismatch" ? ["schematic", "layout"] : ["schematic"], where: "schematic", defaultSeverity: LEVEL_SEVERITY[c.level] || "warning", check: c.id};
    out[CALCULATION] ||= {title: "Calculation assertion", category: "Calculations", domains: ["schematic"], where: "schematic", defaultSeverity: "error", check: "calculationAssertion"};
    out.ercPinMatrix = {title: "Connection Matrix", category: "Schematic", domains: ["schematic"], where: "schematic", defaultSeverity: "error"};
    out.ercNetScope = {title: "Net Identifier Scope", category: "Schematic", domains: ["schematic"], where: "schematic", defaultSeverity: "error"};
    return out;
  }
  const isErc = type => /^erc[A-Z]/.test(String(type || ""));
  const appliesToBoard = (r, id) => (!r.boards || r.boards.includes(id)) && !r.exceptBoards?.includes(id);
  const layoutRule = board => r => !isErc(r.type) && r.where !== "schematic" && appliesToBoard(r,board.id);
  const boardGroup = r => JSON.stringify([r.boards || null, r.exceptBoards || null]);

  // ------------------------------------------------------------------ validation
  function validate(book, invalid, lenient = false, {allowUnknownScopes = lenient} = {}) {
    const bad = typeof invalid === "function" ? m => { invalid(m); throw Error(m); } : m => fail(m || "Invalid project rules.");
    if (!plain(book) || book.format !== "atrium-rules" || book.units !== "mm") bad("Project rules must be a Waffle rules book in millimetres.");
    if (book.version !== VERSION && !(lenient && book.version > VERSION)) bad("Unsupported project rules version " + book.version + (book.version < VERSION ? " (a pre-release Waffle format, which is not supported: re-import the design)." : "."));
    if (!lenient) for (const k of Object.keys(book)) if (!BOOK_KEYS.has(k)) bad("Project rules contain the unsupported setting " + k + ".");
    if (!Array.isArray(book.list) || book.list.length > 20000) bad("Project rules need a list of rules.");
    if (book.calculationTolerances !== undefined && (!plain(book.calculationTolerances) ||
        Object.entries(book.calculationTolerances).some(([type, fraction]) => !TOLERANCE_TYPES.has(type) || !Number.isFinite(fraction) || fraction < 0))) {
      bad("Default calculation tolerances need a component type and a non-negative fraction.");
    }
    const ercIds = new Set(ercChecks().map(c => ercType(c.id)));
    const layout = [], seen = new Set(), assertionIds = new Set(), assertionTargets = new Set();
    for (const r of book.list) {
      if (!plain(r) || typeof r.type !== "string") bad("A rule needs a type.");
      if (r.severity !== undefined && !SEVERITIES.includes(r.severity)) bad((r.name || r.type) + ": severity is fatal, error, warning, hint or off.");
      if (r.where !== undefined && !WHERE.includes(r.where)) bad((r.name || r.type) + ": where is schematic, layout or both.");
      for (const k of ["boards", "exceptBoards", "sheets"]) if (r[k] !== undefined && !(Array.isArray(r[k]) && r[k].length && r[k].length <= 1000 && r[k].every(x => typeof x === "string" && x.length <= 128))) bad((r.name || r.type) + ": " + k + " lists document ids.");
      if (r.exceptBoards && (r.boards || isErc(r.type))) bad("Excluded boards apply only to project-wide layout rules.");
      if (r.origin !== undefined && !(plain(r.origin) && typeof r.origin.kind === "string")) bad((r.name || r.type) + ": origin needs a kind.");
      const records = G.AtriumDesignQueryRecord;
      if (!records.valid(r.scope, {allowUnknown:allowUnknownScopes}) && !records.isFuture(r.scope)) bad((r.name || r.type) + " has an invalid native scope.");
      if (isErc(r.type)) {
        const okType = r.type === "ercPinMatrix" || r.type === "ercNetScope" || r.type === CALCULATION || ercIds.has(r.type) || !ercIds.size;
        if (!okType && !lenient) bad("Unknown schematic rule type " + r.type + ".");
        const allowed = new Set(["id", "type", "name", "comment", "enabled", "priority", "scope", ...V3_FIELDS, "matrix", "netScope"]);
        if (!lenient) for (const k of Object.keys(r)) if (!allowed.has(k)) bad(r.type + " contains the unsupported setting " + k + ".");
        if (typeof r.id !== "string" || !r.id || r.id.length > 128) bad("Each rule needs an identifier.");
        if (r.type === CALCULATION) {
          const o = r.origin, stableId = id => typeof id === "string" && id.length > 0 && id.length <= 128;
          if (o?.kind !== "calculation" || ![o.sheet, o.object, o.assertion].every(stableId) ||
              r.where !== "schematic" || r.sheets?.length !== 1 || r.sheets[0] !== o.sheet ||
              !(records.isAll(r.scope) || records.isFuture(r.scope)) || r.boards || r.matrix || r.netScope) bad("A calculation rule must point to one schematic assertion.");
          const target = JSON.stringify([o.object, o.assertion]);
          if (assertionIds.has(r.id) || assertionTargets.has(target)) bad("Each calculation assertion needs one rule with a unique ID.");
          assertionIds.add(r.id); assertionTargets.add(target);
        }
        if (r.matrix !== undefined && !(plain(r.matrix) && Object.entries(r.matrix).every(([k, v]) => /^\d,\d$/.test(k) && SEVERITY_LEVEL[v] !== undefined))) bad("ercPinMatrix maps pin type pairs to severities.");
        if (r.netScope !== undefined && typeof r.netScope !== "string") bad("ercNetScope needs a scope.");
        continue;
      }
      layout.push(r);
      const k = r.id + "\u0001" + boardGroup(r);
      if (seen.has(k)) bad("Each rule needs a unique identifier (" + r.id + ").");
      seen.add(k);
    }
    for (const [k, v] of [["keys", book.keys], ...Object.entries(book.boardKeys || {}).map(([id, x]) => ["boardKeys." + id, x])]) {
      if (v === undefined) continue;
      if (!plain(v) || !lenient && Object.keys(v).some(x => !KEY_FIELDS.includes(x))) bad("Project rules " + k + " hold rule sets and currents only.");
    }
    if (book.boardKeys !== undefined && !plain(book.boardKeys)) bad("Project rules boardKeys map boards to keys.");
    // Every layout rule is a valid version 2 rule; ids and names are unique on each board.
    const groups = new Map();
    for (const r of layout) { const g = boardGroup(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r); }
    const Rr = R();
    for (const [, list] of groups) {
      const keys = {...(book.keys || {})};
      for (const x of Object.values(book.boardKeys || {})) if (x.ruleSets) keys.ruleSets = [...(keys.ruleSets || []), ...x.ruleSets.filter(s => !(keys.ruleSets || []).some(y => y.name.toLowerCase() === s.name.toLowerCase()))];
      try { Rr.validate({format: "atrium-rules", version: 2, units: "mm", list: list.map(strip), ...(keys.ruleSets ? {ruleSets: keys.ruleSets} : {})},
        {allowFuture:true, allowUnknown:allowUnknownScopes}); }
      catch (e) { if (!lenient) bad(e.message); }
    }
    return book;
  }
  // Forward compatibility (compat.js, docs/format-versioning.md): in a file of a newer minor format, takes out
  // in place what this build can't read and returns it for AtriumCompat.forSave to put back (the record
  // AtriumRules.setAside returns): unknown book keys {keys, order}; whole rules of an unknown type, or that don't
  // validate here, as [index, rule]; unknown settings of the rules kept, by rule id {keys, order}.
  function setAside(b) {
    if (!plain(b) || b.format !== "atrium-rules" || b.version !== VERSION) return null;
    const rec = {}, split = (o, allowed) => { const keys = {}; let n = 0; for (const k of Object.keys(o)) if (!allowed.has(k)) { keys[k] = o[k]; n++; } if (!n) return null; const order = Object.keys(o); for (const k in keys) delete o[k]; return {keys, order}; };
    const top = split(b, BOOK_KEYS); if (top) Object.assign(rec, top);
    if (Array.isArray(b.keys?.ruleSets)) for (const e of b.keys.ruleSets) { const x = plain(e) && split(e, new Set(["name", "enabled", "description"])); if (x) ((rec.entries ||= {})["keys.ruleSets"] ||= {})[String(e.name).toLowerCase()] = x; }
    const ercIds = new Set([...ercChecks().map(c => ercType(c.id)), "ercPinMatrix", "ercNetScope", CALCULATION]);
    const ercKeys = new Set(["id", "type", "name", "comment", "enabled", "priority", "scope", ...V3_FIELDS, "matrix", "netScope"]);
    if (Array.isArray(b.list)) {
      const kept = [];
      b.list.forEach((r, i) => {
        if (!plain(r) || typeof r.type !== "string") { (rec.rules ||= []).push([i, r]); return; }
        if (isErc(r.type)) {
          if (!ercIds.has(r.type)) { (rec.rules ||= []).push([i, r]); return; }
          const x = split(r, ercKeys); if (x) (rec.fields ||= {})[r.id] = x;
          kept.push(r); return;
        }
        const copy = {...r}; for (const k of V3_FIELDS) delete copy[k];
        const got = R().setAside({format: "atrium-rules", version: 2, units: "mm", list: [copy]});
        if (got?.rules?.length) { (rec.rules ||= []).push([i, r]); return; }
        const x = got?.fields?.[r.id];
        if (x) { for (const k in x.keys) delete r[k]; (rec.fields ||= {})[r.id] = x; }
        kept.push(r);
      });
      if (rec.rules) b.list = kept;
    }
    return Object.keys(rec).length ? rec : null;
  }
  // A version 2 rule: the v3 fields go; severity "off" is a disabled rule.
  function strip(r) {
    const out = {};
    for (const [k, v] of Object.entries(r)) if (!V3_FIELDS.includes(k)) out[k] = clone(v);
    if (r.severity === "off") out.enabled = false;
    return out;
  }
  const pickKeys = set => { const k = {}; for (const f of KEY_FIELDS) if (set?.[f] !== undefined) k[f] = clone(set[f]); return k; };

  // ------------------------------------------------------------------ reading
  // The default book (rules.js defaults()) stands in until the first edit; one object per project, so
  // memos keyed by the book hold.
  const defaultBooks = new WeakMap();
  function book(project) {
    if (plain(project?.rules)) return project.rules;
    if (!project || typeof project !== "object") return fresh();
    let b = defaultBooks.get(project);
    if (!b) defaultBooks.set(project, b = fresh());
    return b;
  }
  function fresh() {
    const d = R().migrate(R().defaults());
    return {format: "atrium-rules", version: VERSION, units: "mm", list: clone(d.list), ...(Object.keys(pickKeys(d)).length ? {keys: pickKeys(d)} : {})};
  }
  // The version 2 set a board reads. Undo can replay an edit into the same book and rule objects.
  const views = new WeakMap();
  function forBoard(project, board, b = book(project)) {
    let per = views.get(b);
    if (!per) views.set(b, per = new Map());
    const hit = per.get(board.id);
    const undo = G.AtriumUndoStore;
    const recorded = b === project?.rules && undo?.documentVersions?.(board, project);
    const version = recorded ? undo.outer() : null;
    if (hit && version != null && hit.undo === undo && hit.version === version) return hit.set;
    const overrides = b.boardKeys?.[board.id];
    const inputs = JSON.stringify([b.list, b.keys, overrides]);
    const set = hit?.inputs === inputs ? hit.set : R().normalize({format: "atrium-rules", version: 2, units: "mm",
      list: b.list.filter(layoutRule(board)).map(strip), ...clone(b.keys || {}), ...clone(overrides || {})});
    per.set(board.id, {set, inputs, undo, version});
    return set;
  }
  function ercFallbacks(project, b = book(project)) {
    const all = b.list.filter(r => isErc(r.type) && r.enabled !== false && G.AtriumDesignQueryRecord.isAll(r.scope) && !r.sheets).sort((x, y) => (x.priority || 1) - (y.priority || 1));
    const first = new Map();
    for (const r of all) if (!first.has(r.type)) first.set(r.type,r);
    return first;
  }
  // The ERC settings in AtriumERC.stored's shape, from the unscoped ERC rules (scoped ones apply per finding).
  function erc(project, b = book(project)) {
    const E = G.AtriumERC; if (!E) return null;
    const cfg = E.defaults();
    for (const r of ercFallbacks(project,b).values()) {
      if (r.type === "ercPinMatrix") for (const [k, v] of Object.entries(r.matrix || {})) cfg.matrix[k] = SEVERITY_LEVEL[v];
      else if (r.type === "ercNetScope") cfg.scope = r.netScope;
      else { const id = types()[r.type]?.check; if (id) cfg.checks[id] = SEVERITY_LEVEL[r.severity || "error"]; }
    }
    return E.stored(cfg);
  }

  // Explicit source-rule reads may receive either an imported 1.x board or a
  // clean editor board whose original fields belong to its import report.
  function sourceDocument(doc) {
    return !doc || doc.sourceRules !== undefined ? doc : G.AtriumImportReports?.sourceDocument(doc) || doc;
  }
  // A board imported before origin.record was introduced can still be linked
  // by its original name and kind when exactly one such source record exists.
  function originRecords(doc, list) {
    const result = new Map(), sources = sourceDocument(doc)?.sourceRules;
    let names;
    for (const r of list) {
      const o = r.origin;
      if (o?.kind !== "import" || o.tool !== "Altium" || o.board !== doc.id) continue;
      let n = o.record;
      if (n == null && sources && G.AtriumAltiumRules) {
        if (!names) {
          names = new Map();
          sources.forEach((line,i) => {
            const {kind,name} = G.AtriumAltiumRules.describe(line), key = kind.toLowerCase()+"\0"+name.toLowerCase();
            names.set(key,names.has(key)?null:i+1);
          });
        }
        n = names.get((R().types[r.type]?.altium || "").toLowerCase()+"\0"+r.name.toLowerCase());
      }
      if (Number.isInteger(n) && n>=1 && n<=(sources?.length??10000)) result.set(r.id,n);
    }
    return result;
  }
  // ------------------------------------------------------------------ writing
  // fn(book) on a copy; the result is validated and becomes project.rules. The caller wraps it in its edit
  // step (editor) or mutation (MCP), so it is one undo step.
  function edit(project, fn) {
    if (!project) fail("Open a project first.");
    if (project.atriumCompat?.top?.rules) fail("The project rules in this file were saved by a newer Waffle. Edit them there; this version keeps them unchanged.");
    const previous = book(project), implicit = project.rules == null, b = clone(previous), result = fn(b);
    b.version = VERSION;
    const records = G.AtriumDesignQueryRecord, newer = !!project.atriumCompat?.newer;
    const prior = new Map(previous.list.map(r => [JSON.stringify([r.id, boardGroup(r)]), r]));
    for (const r of b.list) for (const key of ["scope", "scope2"]) {
      const scope = r[key];
      if (!scope || records.valid(scope)) continue;
      if (scope.kind && scope.languageVersion === undefined) { r[key] = R().scopeCopy(scope); continue; }
      const saved = prior.get(JSON.stringify([r.id, boardGroup(r)]))?.[key];
      if (!(records.isFuture(scope) || newer && records.valid(scope, {allowUnknown:true})) || JSON.stringify(scope) !== JSON.stringify(saved))
        fail((r.name || r.type) + " has an invalid or unsupported native " + key + ".");
    }
    validate(b, undefined, false, {allowUnknownScopes:newer});
    if (implicit) {
      const defaults = new Map(previous.list.map(rule => [rule.id, rule.type])), authored = new Map();
      for (const rule of b.list) if (defaults.has(rule.id)) {
        const id = G.Atrium.id();
        if (!rule.origin && defaults.get(rule.id) === rule.type) rule.origin = {kind:"default", key:rule.id};
        if (!authored.has(rule.id)) authored.set(rule.id, []);
        authored.get(rule.id).push(rule); rule.id = id;
      }
      for (const doc of boardsOf(project)) {
        if (!Array.isArray(doc.drcWaivers)) continue;
        for (const waiver of doc.drcWaivers) {
          const matching = authored.get(waiver?.ruleId)?.filter(rule => appliesToBoard(rule, doc.id) && (!waiver.rule || rule.name === waiver.rule));
          if (matching?.length === 1) waiver.ruleId = matching[0].id;
        }
      }
    }
    views.delete(b); // fn may have read a board's view of the copy before it changed
    project.rules = b;
    // Remember which source rows became editable. A later deletion or board-scope
    // change must survive export even when the final imported rule was removed.
    const boards = new Set([...previous.list,...b.list].filter(r=>r.origin?.kind==="import"&&r.origin.tool==="Altium").map(r=>r.origin.board));
    for (const doc of project.documents || []) {
      if (!boards.has(doc.id) || doc.kind!=="pcb") continue;
      const old=originRecords(doc,previous.list), current=originRecords(doc,b.list);
      for(const r of b.list){
        const n=old.get(r.id)||current.get(r.id);
        if(n&&r.origin?.board===doc.id&&r.origin.record==null)r.origin.record=n;
      }
      const records=new Set([...old.values(),...current.values()]);
      const saved = doc.appliedSourceRuleRecords || [];
      if ([...records].some(n => !saved.includes(n)))
        doc.appliedSourceRuleRecords = [...new Set([...saved,...records])].sort((a,b) => a-b);
    }
    return result;
  }
  // A working view groups types and fills defaults for controls. Keep saved records in their authored
  // slots, including shared or ERC rules between them. New records join at the end; priority is explicit.
  function replaceRules(list, applies, updates) {
    const positions = new Map(), used = new Set(), result = [];
    for (let n = updates.length - 1; n >= 0; n--) {
      const id = updates[n].id;
      if (!positions.has(id)) positions.set(id, []);
      positions.get(id).push(n);
    }
    for (const original of list) {
      if (!applies(original)) { result.push(original); continue; }
      const index = positions.get(original.id)?.pop();
      if (index !== undefined) { result.push(updates[index]); used.add(index); }
    }
    for (const [index, rule] of updates.entries()) if (!used.has(index)) result.push(rule);
    return result;
  }
  // The rules that apply to `board` become `set` (a version 2 set as the editor keeps it); `extras` maps a rule
  // id to its v3 fields {severity, where, boards, origin}. Rules shared with other boards are the project's:
  // editing them here edits them for every board they apply to. Rules of other boards and ERC rules stay.
  function setBoard(b, project, board, set, extras = new Map()) {
    const applies = layoutRule(board);
    const mine = new Map(b.list.filter(applies).map(r => [r.id, r]));
    const kept = [];
    // Replacing a board's imported types must preserve the old rules on sibling boards.
    const addedTypes = new Set(set.list.filter(r => !mine.has(r.id) && extras.get(r.id)?.origin?.board === board.id).map(r => r.type));
    if (addedTypes.size) {
      const incoming = new Set(set.list.map(r => r.id));
      for (const r of mine.values()) if (addedTypes.has(r.type) && !incoming.has(r.id)) {
        if (!r.boards) kept.push({...r, exceptBoards:[...(r.exceptBoards || []), board.id]});
        else {
          const other = r.boards.filter(id => id !== board.id);
          if (other.length) kept.push({...r, boards:other});
        }
      }
    }
    const baseline = forBoard(project, board, b), prior = new Map(baseline.list.map(r => [r.id, r]));
    const edited = R().migrate(set).list;
    const reprioritized = new Set(edited.filter(r => r.priority !== prior.get(r.id)?.priority).map(r => r.type));
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const next = edited.map(r => {
      const was = mine.get(r.id), view = prior.get(r.id), x = extras.get(r.id) || {};
      const rec = was?.type === r.type ? {...was} : clone(r);
      if (view?.type === r.type) {
        for (const k of new Set([...Object.keys(view), ...Object.keys(r)])) {
          if (same(r[k], view[k]) && !(k === "priority" && reprioritized.has(r.type))) continue;
          if (r[k] === undefined) delete rec[k]; else rec[k] = clone(r[k]);
        }
      }
      for (const k of V3_FIELDS) {
        const v = Object.hasOwn(x, k) ? x[k] : was?.[k];
        if (same(rec[k], v)) continue;
        if (v == null || Array.isArray(v) && !v.length) delete rec[k];
        else rec[k] = clone(v);
      }
      if (!rec.origin?.board && rec.boards && !same(rec.boards, was?.boards) && rec.boards.length === boardsOf(project).length) delete rec.boards;
      return rec;
    });
    b.list = replaceRules(b.list, applies, [...kept, ...next]);
    const keys = pickKeys(set);
    if (same(keys, pickKeys(baseline))) return b;
    const multi = boardsOf(project).length > 1;
    if (!multi) { if (Object.keys(keys).length) b.keys = keys; else delete b.keys; delete b.boardKeys; }
    else { b.boardKeys = {...(b.boardKeys || {}), [board.id]: keys}; if (!Object.keys(keys).length) delete b.boardKeys[board.id]; if (!Object.keys(b.boardKeys).length) delete b.boardKeys; }
    return b;
  }
  function setNetScope(project, value, origin = null) {
    const H = G.AtriumHierarchy;
    if (!H?.SCOPES.includes(value)) fail("Unknown net identifier scope.");
    edit(project, b => {
      let current = H.scopeRule(b);
      if (!current) {
        current = {id:G.Atrium.id(), type:"ercNetScope", name:"NetIdentifierScope", enabled:true, priority:1, scope:G.AtriumDesignQueryRecord.selector("all"), where:"schematic"};
        b.list.push(current);
      }
      current.netScope = value;
      if (origin) current.origin = origin;
      else if (current.origin?.kind === "import") delete current.origin;
    });
  }
  // The ERC rules of the book become `rules` (the editor's Schematic view).
  function setErc(b, rules) { b.list = replaceRules(b.list, r => isErc(r.type), clone(rules)); return b; }
  function setCalculationOptions(b, rules, before, defaults, beforeDefaults) {
    const changed = new Map(), was = new Map(before.map(r => [r.id, r]));
    for (const r of rules) {
      const old = was.get(r.id);
      if (!old) continue;
      const options = {};
      if (old.enabled !== r.enabled) options.enabled = r.enabled;
      if (old.severity !== r.severity) options.severity = r.severity;
      if (Object.keys(options).length) changed.set(r.id, options);
    }
    if (changed.size) b.list = b.list.map(r => r.type === CALCULATION && changed.has(r.id) ? {...r, ...changed.get(r.id)} : r);
    const current = {...b.calculationTolerances};
    for (const type of TOLERANCE_TYPES) {
      if (defaults[type] === beforeDefaults[type]) continue;
      if (defaults[type] === undefined) delete current[type];
      else current[type] = defaults[type];
    }
    if (Object.keys(current).length) b.calculationTolerances = current;
    else delete b.calculationTolerances;
  }
  // A board's rules become `set`, as one edit. Class and pair keys the set carries go to the signal model.
  function store(project, board, set, extras) {
    edit(project, b => setBoard(b, project, board, set, extras));
    classes(project, board, set);
  }
  function classes(project, board, set) {
    const S = G.AtriumSignals, keys = {};
    for (const k of CLASS_KEYS) if (set?.[k] !== undefined) keys[k] = set[k];
    if (!Object.keys(keys).length) return;
    if (!S?.applyClasses) fail("Signals are not loaded: net classes and pairs can't be changed.");
    S.applyClasses(project, board, keys);
  }
  // Board `d` reads `set` and nothing else changes: rules it shared with other boards stay theirs.
  function own(b, project, d, set) {
    const ids = boardsOf(project).map(x => x.id), others = ids.filter(id => id !== d.id), mine = layoutRule(d);
    b.list = b.list.flatMap(r => { if (!mine(r)) return [r]; const rest = (r.boards || ids).filter(id => id !== d.id); return rest.length ? [{...r, boards: rest}] : []; });
    b.list.push(...set.list.map(r => others.length ? {...clone(r), boards: [d.id]} : clone(r)));
    const keys = pickKeys(set);
    if (!others.length) { if (Object.keys(keys).length) b.keys = keys; else delete b.keys; delete b.boardKeys; }
    else if (Object.keys(keys).length) b.boardKeys = {...(b.boardKeys || {}), [d.id]: keys};
  }
  // Imported documents (AtriumImportLink.reconcile): each board's rules (an importer writes doc.rules on the
  // documents it returns) become that board's rules in the book, its class keys the signal model's; a source
  // tool's net identifier scope hint (doc.netScope) becomes the ercNetScope rule when the project has none.
  function absorb(project, docs) {
    const boards = docs.filter(d => d?.kind === "pcb" && d.rules != null);
    const rebind = [];
    if (boards.length) edit(project, b => {
      for (const d of boards) {
        const set = R().migrate(d.rules), ids = new Map(), legacyClassRules = d.rules.version === 1;
        const inheritedDefaults = new Set(d.rules.list?.filter(rule => rule.origin?.kind === "default" && rule.origin.key === rule.id).map(rule => rule.id));
        for (const rule of set.list) if (!G.AtriumUUID.isV7(rule.id)) {
          // A foreign class can derive a scoped fallback from a default template.
          if (inheritedDefaults.has(rule.id) || (legacyClassRules && G.AtriumDesignQueryRecord.isAll(rule.scope)))
            rule.origin = {kind:"default",key:rule.id};
          const id = G.Atrium.id();
          ids.set(rule.id, id); rule.id = id;
        }
        if (Array.isArray(d.drcWaivers)) for (const waiver of d.drcWaivers) {
          if (ids.has(waiver?.ruleId)) rebind.push([waiver, ids.get(waiver.ruleId)]);
        }
        own(b, project, d, set);
      }
    });
    for (const [waiver, id] of rebind) waiver.ruleId = id;
    for (const d of boards) { classes(project, d, d.rules); delete d.rules; }
    const hints = docs.filter(d => typeof d?.netScope === "string").map(d => d.netScope);
    if (hints.length && !hints.includes("global") && ["automatic", "flat", "hierarchical"].includes(hints[0]) && !book(project).list.some(r => r.type === "ercNetScope"))
      edit(project, b => { b.list.push({id: G.Atrium.id(), type: "ercNetScope", name: "NetIdentifierScope", enabled: true, priority: 1, scope: G.AtriumDesignQueryRecord.selector("all"), where: "schematic", netScope: hints[0]}); });
    return boards.length;
  }

  return Object.freeze({VERSION, SEVERITIES, WHERE, CLASS_KEYS, CALCULATION, types, ercType, isErc, appliesToBoard, validate, setAside, strip, book, forBoard, erc, ercFallbacks, sourceDocument, originRecords, edit, setBoard, setErc, setNetScope, setCalculationOptions, store, absorb,
    LEVEL_SEVERITY, SEVERITY_LEVEL});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumProjectRules;
