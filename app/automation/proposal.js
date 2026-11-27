"use strict";
// Waffle AI proposals (.waffle-ai) computed from a before/after pair of
// projects. Headless tools edit a private copy of the saved project; the
// difference becomes a proposal that the editor reviews and applies.
//
// Version 1 (unchanged): component value/ref edits, {changes:[{document,id,ref,field,before,after}]}.
// Version 2: generic edit operations, each guarded by the value it replaces.
//   {format:"atrium-ai", version:2, project, source_sha256, document_ids, tool, summary, ops:[
//     {op:"set", target:"project"|"document"|"item"|"library", document?, id?, path:[key,...], before?, after?},
//     {op:"add", target:"item", document, value, after_id},        after_id: insert after this item (null = first)
//     {op:"add", target:"document"|"library", value, after_id},
//     {op:"remove", target:"item"|"document"|"library", document?, id, before}]}
// An absent `before` means the key did not exist. An absent `after` deletes it.
// Item order changes without additions or removals are not represented.
// No DOM access: the editor and the headless engine share this file.
globalThis.AtriumProposal = (() => {
  const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
  const TARGETS = new Set(["project", "document", "item", "library"]);
  // Fields that carry code the editor runs (project extensions, saved console scripts).
  // Proposals never write them: only the editor's own UI does, after the user asks.
  const CODE_FIELDS = new Set(["extensions", "scripts", "macros", "plugins", "hooks"]);
  // Version 1 fields: component text and placement. mcp/server.py EDIT_FIELDS mirrors this list
  // (tests/security-proposals.py checks they match). build() emits version 1 only for the text fields.
  const V1_FIELDS = Object.freeze(["value", "ref", "x", "y", "angle"]);
  const V1_TEXT = new Set(["value", "ref"]);
  const MAX_OPS = 500000, DEPTH = 3;
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const fail = m => { throw Error(m); };

  function equal(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
      return true;
    }
    if (Array.isArray(b)) return false;
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    for (const k of keys) if (!own(b, k) || !equal(a[k], b[k])) return false;
    return true;
  }

  // ------------------------------------------------------------------ diff
  function fields(ops, base, x, y, path, depth, skip) {
    const keys = new Set(Object.keys(x));
    for (const k of Object.keys(y)) keys.add(k);
    for (const k of keys) {
      if (skip && skip.has(k)) continue;
      const hx = own(x, k), hy = own(y, k);
      if (hx && hy && equal(x[k], y[k])) continue;
      if (hx && hy && plain(x[k]) && plain(y[k]) && depth < DEPTH) { fields(ops, base, x[k], y[k], [...path, k], depth + 1); continue; }
      const op = {op: "set", ...base, path: [...path, k]};
      if (hx) op.before = clone(x[k]);
      if (hy) op.after = clone(y[k]);
      ops.push(op);
    }
  }
  function keyed(ops, target, base, a, b, skip, inner) {
    const old = new Map(a.map(v => [v.id, v])), next = new Set(b.map(v => v.id));
    for (const v of a) if (!next.has(v.id)) ops.push({op: "remove", target, ...base, id: v.id, before: clone(v)});
    let previous = null;
    for (const v of b) {
      const was = old.get(v.id);
      if (!was) ops.push({op: "add", target, ...base, after_id: previous, value: clone(v)});
      else if (was !== v) { fields(ops, {target, ...base, id: v.id}, was, v, [], 0, skip); if (inner) inner(was, v); }
      previous = v.id;
    }
  }
  // Operations that turn project `a` into project `b`.
  function diff(a, b) {
    const ops = [];
    fields(ops, {target: "project"}, a, b, [], 0, new Set(["documents", "library", "atriumCompat"]));
    keyed(ops, "library", {}, a.library || [], b.library || []);
    keyed(ops, "document", {}, a.documents, b.documents, new Set(["items"]),
      (da, db) => keyed(ops, "item", {document: db.id}, da.items || [], db.items || []));
    return ops;
  }

  function diffItemPairs(itemPairs, ops = []) {
    for (const [old, {d, item}] of itemPairs)
      fields(ops, {target:"item", document:d.id, id:old.id}, old, item, [], 0);
    return ops;
  }

  // ---------------------------------------------------------------- summary
  function summarize(ops) {
    const out = {operations: ops.length, project_fields: 0, library: {added: 0, removed: 0, changed: 0}, documents: {}};
    const changedLib = new Set(), changedItems = new Map();
    const doc = id => out.documents[id] || (out.documents[id] = {items_added: 0, items_removed: 0, items_changed: 0, fields_changed: 0});
    for (const o of ops) {
      if (o.target === "project") out.project_fields++;
      else if (o.target === "library") {
        if (o.op === "add") out.library.added++; else if (o.op === "remove") out.library.removed++; else changedLib.add(o.id);
      } else if (o.target === "document") {
        if (o.op === "set") doc(o.id).fields_changed++; else doc(o.op === "add" ? o.value.id : o.id)[o.op === "add" ? "added" : "removed"] = true;
      } else if (o.op === "add") doc(o.document).items_added++;
      else if (o.op === "remove") doc(o.document).items_removed++;
      else {
        if (!changedItems.has(o.document)) changedItems.set(o.document, new Set());
        changedItems.get(o.document).add(o.id);
      }
    }
    out.library.changed = changedLib.size;
    for (const [d, ids] of changedItems) doc(d).items_changed = ids.size;
    return out;
  }

  // Version 1 when every edit is a component value or designator change the
  // current review dialog already understands; version 2 otherwise.
  function build(before, after, meta = {}) {
    const ops = meta.ops ?? (meta.itemPairs ? [] : diff(before, after));
    if (meta.itemPairs) diffItemPairs(meta.itemPairs, ops);
    const head = {format: "atrium-ai", project: before.name, source_sha256: meta.source_sha256 || null,
      document_ids: before.documents.map(d => d.id).sort()};
    if (!ops.length) return {proposal: null, ops: 0, summary: summarize(ops)};
    const items = new Map();
    if (meta.allowV1 !== false && ops.length <= 100) for (const d of before.documents) for (const i of d.items) items.set(i.id, i);
    const v1 = meta.allowV1 !== false && ops.length <= 100 && ops.every(o => o.op === "set" && o.target === "item" &&
      o.path.length === 1 && V1_TEXT.has(o.path[0]) && items.get(o.id)?.kind === "part" && typeof o.after === "string" &&
      (o.path[0] !== "ref" || o.after.trim()) && o.after.length <= 512);
    const summary = summarize(ops);
    if (v1) {
      const changes = ops.map(o => ({document: o.document, id: o.id, ref: items.get(o.id).ref, field: o.path[0], before: o.before ?? 0, after: o.after}));
      return {proposal: {...head, version: 1, tool: meta.tool, changes}, ops: ops.length, summary};
    }
    return {proposal: {...head, version: 2, tool: meta.tool, summary: meta.summary ?? null, ops}, ops: ops.length, summary};
  }

  // ------------------------------------------------------------- apply
  function index(p, proposal) {
    const docs = new Map(), items = new Map(), lib = new Map();
    const needed = new Map(), library = new Set();
    const scoped = Array.isArray(proposal?.ops) && proposal.ops.every(o => o?.op === "set" || o?.op === "remove");
    if (scoped) for (const o of proposal.ops) {
      if (o.target === "library") library.add(o.id);
      if (o.target === "item") {
        if (!needed.has(o.document)) needed.set(o.document, new Set());
        needed.get(o.document).add(o.id);
      }
    }
    for (const d of p.documents) {
      docs.set(d.id, d);
      const ids = needed.get(d.id);
      if (scoped && !ids) continue;
      for (let at = 0; at < d.items.length; at++) {
        const i = d.items[at];
        if (!scoped || ids.delete(i.id)) items.set(i.id, {d, i, at});
        if (scoped && !ids.size) break;
      }
    }
    if (!scoped || library.size) for (const def of p.library) {
      if (!scoped || library.delete(def.id)) lib.set(def.id, def);
      if (scoped && !library.size) break;
    }
    return {docs, items, lib};
  }
  function checkPath(path) {
    if (!Array.isArray(path) || !path.length || path.length > 16) fail("The proposal has an invalid field path.");
    for (const k of path) if (typeof k !== "string" || !k || FORBIDDEN.has(k) || k === "length") fail("The proposal has an invalid field path.");
  }
  function read(o, path) {
    for (const k of path.slice(0, -1)) {
      if (!own(o, k)) return {has: false};
      o = o[k];
      if (!plain(o)) fail("The proposal edits inside a list, which is not allowed.");
    }
    const k = path[path.length - 1];
    return plain(o) && own(o, k) ? {has: true, value: o[k]} : {has: false};
  }
  function write(o, path, op) {
    for (const k of path.slice(0, -1)) {
      if (!own(o, k)) { if (!own(op, "after")) return; o[k] = {}; }
      // Guards only cover plain-object paths, so never write through a list.
      if (!plain(o[k])) fail("The proposal edits inside a list, which is not allowed.");
      o = o[k];
    }
    const k = path[path.length - 1];
    if (own(op, "after")) o[k] = clone(op.after); else delete o[k];
  }
  // Component field rules shared by both versions: text is at most 512 characters, a designator
  // that is set is never blank and geometry is finite.
  function checkPartField(field, after) {
    if (V1_TEXT.has(field)) {
      if (typeof after !== "string" || after.length > 512 || (field === "ref" && !after.trim())) fail("Invalid proposed text.");
    } else if (!Number.isFinite(after) || Math.abs(after) > 1e7) fail("Invalid proposed geometry.");
  }
  // An added part may be unannotated (importers leave designators blank), but its designator is text.
  function checkAddedPart(v) {
    if (typeof v.ref !== "string" || v.ref.length > 512) fail("Invalid proposed text.");
  }
  // Fields that decide a part's designator and gate, per target, as the designator check reads them.
  const PART_KEYS = new Set(["kind", "ref", "unit", "part", "def", "link"]), GATE_KEYS = new Set(["kind", "unit", "part", "def"]);
  const DOC_KEYS = new Set(["kind"]), LIB_KEYS = new Set(["symbol"]);
  // `owner` as the chosen set operations leave it, for the fields in `keys` (a shallow view).
  function finalView(owner, ops, keys) {
    if (!owner || !ops?.some(op => keys.has(op.path[0]))) return owner;
    const view = {...owner}, copied = new Set();
    for (const op of ops) {
      const k = op.path[0];
      if (!keys.has(k)) continue;
      if (op.path.length > 1 && !copied.has(k)) { copied.add(k); view[k] = clone(view[k]); }
      write(view, op.path, op);
    }
    return view;
  }
  const unannotated = ref => typeof ref !== "string" || !ref.trim() || ref.includes("?");
  const gateCount = def => Number.isInteger(def?.symbol?.parts) && def.symbol.parts > 1 ? def.symbol.parts : 1;
  const gateOf = i => i.unit || i.part || 1; // as Atrium.gate reads it
  const inRange = (u, n) => Number.isInteger(u) && u >= 1 && u <= n;
  // Designators as ERC and the schematic author judge them, on the project the proposal leaves:
  // every schematic sheet shares one set of designators and each other document has its own,
  // compared without case or surrounding space. Unannotated designators (blank or with "?") are
  // never compared. Gates of one multi-gate symbol share a designator when they are different
  // gates in its range and resolve to the same footprint (equal links when both are set).
  // Only parts the proposal adds, or whose designator, gate or kind it changes, are checked
  // against the others, so a proposal is never refused for a duplicate it does not touch.
  // f: {edits: Map(owner, [set op]), items: Map(document, [added item]), docs: [added document],
  //     lib: [added library entry], gone: Set("target\0id" removed)}
  function checkDesignators(p, f) {
    const edits = f.edits || new Map(), gone = f.gone || new Set();
    const relevant = op => op.target === "item" ? PART_KEYS.has(op.path[0]) : op.target === "document" && DOC_KEYS.has(op.path[0]);
    if (!f.items?.size && !f.docs?.length && ![...edits.values()].some(ops => ops.some(relevant))) return;
    const added = new Map((f.lib || []).map(def => [def.id, def])), defs = new Map(), live = new Map((p.library || []).map(def => [def.id, def]));
    const defOf = id => {
      if (!defs.has(id)) defs.set(id, added.get(id) || (gone.has("library\0" + id) ? null : finalView(live.get(id), edits.get(live.get(id)), LIB_KEYS)));
      return defs.get(id);
    };
    const parts = [], byKey = new Map();
    const take = (i, d, sch, group, isNew, moved) => {
      if (!isNew && gone.has("item\0" + i?.id)) return;
      const ops = isNew ? null : edits.get(i), iv = finalView(i, ops, PART_KEYS);
      if (iv?.kind !== "part") return;
      const entry = {i: iv, d, sch, touched: isNew || moved || !!ops?.some(op => PART_KEYS.has(op.path[0])),
        gate: isNew || moved || !!ops?.some(op => GATE_KEYS.has(op.path[0])), key: null};
      if (entry.touched) parts.push(entry);
      if (unannotated(iv.ref)) return;
      entry.key = group + "\0" + iv.ref.trim().toUpperCase();
      const same = byKey.get(entry.key);
      if (same) same.push(entry); else byKey.set(entry.key, [entry]);
    };
    const visit = (d, isNew) => {
      const kind = isNew ? d.kind : finalView(d, edits.get(d), DOC_KEYS).kind, sch = kind === "schematic";
      const group = sch ? "\0schematic" : "\0" + d.id, moved = !isNew && kind !== d.kind;
      for (const i of d.items) take(i, d, sch, group, isNew, moved);
      for (const i of f.items?.get(d) || []) take(i, d, sch, group, true, false);
    };
    for (const d of p.documents) if (!gone.has("document\0" + d.id)) visit(d, false);
    for (const d of f.docs || []) visit(d, true);
    const share = (a, b) => {
      if (!a.sch || !b.sch || a.i.def !== b.i.def) return false;
      const n = gateCount(defOf(a.i.def)), ua = gateOf(a.i), ub = gateOf(b.i);
      return n > 1 && inRange(ua, n) && inRange(ub, n) && ua !== ub && (!a.i.link || !b.i.link || a.i.link === b.i.link);
    };
    for (const a of parts) {
      if (a.sch && a.gate) {
        const n = gateCount(defOf(a.i.def)), u = gateOf(a.i);
        if (!inRange(u, n)) fail((unannotated(a.i.ref) ? "A part" : a.i.ref.trim()) + " is gate " + u + ", but its symbol has " + n + " gate" + (n === 1 ? "" : "s") + ".");
      }
      const clash = a.key && byKey.get(a.key).find(b => b !== a && !share(a, b));
      if (clash) fail("Designator " + a.i.ref.trim() + " is already used on " + clash.d.name + ".");
    }
  }
  const clone = v => v == null || typeof v !== "object" ? v : JSON.parse(JSON.stringify(v));
  const short = v => { const s = v === undefined ? "(none)" : JSON.stringify(v); return s.length > 80 ? s.slice(0, 77) + "…" : s; };
  const nameOf = i => i.ref || i.name || i.text || i.net || i.id;

  // Check the proposal's structure and project binding. Preview checks all live
  // guards. Apply checks live field guards for the chosen edits. `designators` false skips only
  // the designator rules, for callers that replay the user's own editor edits (a detached tab,
  // a reviewed Git merge), which the editor allowed and which never came from automation.
  function check(proposal, p, limit, lookup, offset = 0, chosen = null, designators = true) {
    if (proposal?.format !== "atrium-ai" || proposal.version !== 2 || !Array.isArray(proposal.ops) || !proposal.ops.length || proposal.ops.length > MAX_OPS)
      fail("Choose a valid Waffle AI proposal.");
    if (proposal.project !== p.name) fail("This proposal belongs to another project.");
    if (proposal.document_ids && (!Array.isArray(proposal.document_ids) || proposal.document_ids.some(id => !lookup.docs.has(id))))
      fail("This proposal belongs to another document set.");
    const {docs, items, lib} = lookup, added = new Set(), seen = new Set(), removed = new Set(), parents = new Set(), rows = [];
    // What the chosen operations change, for the designator check at the end.
    const final = {edits: new Map(), items: new Map(), docs: [], lib: [], gone: new Set()};
    const listIn = (m, k) => m.get(k) || (m.set(k, []), m.get(k));
    for (const o of proposal.ops) if (o?.op === "remove") {
      const key = o.target + "\0" + o.id;
      if (removed.has(key)) fail("The proposal removes the same object twice.");
      removed.add(key);
    }
    // Check the actual insert order before publishing any selected edit.
    const orderChanges = new Map();
    function checkOrder(o, n, list, has) {
      if (chosen && !chosen.has(n)) return;
      let changes = orderChanges.get(list);
      if (!changes) { changes = new Map(); orderChanges.set(list, changes); }
      if (o.op === "remove") changes.set(o.id, false);
      else {
        const after = o.after_id;
        if (after != null && !(changes.get(after) ?? has(after)))
          fail("Operation " + (n + 1) + " has an insertion predecessor missing from its destination.");
        changes.set(o.value.id, true);
      }
    }
    proposal.ops.forEach((o, n) => {
      const show = n >= offset && n < offset + limit;
      if (!plain(o) || !TARGETS.has(o.target) || !["set", "add", "remove"].includes(o.op)) fail("Operation " + (n + 1) + " is not supported.");
      const stale = what => fail(what + " has changed since this proposal was drafted. Generate a fresh proposal.");
      if (o.target === "project" && o.op !== "set") fail("Operation " + (n + 1) + " cannot add or remove the project.");
      if (o.target === "item" && removed.has("document\0" + o.document) ||
          o.op === "set" && removed.has(o.target + "\0" + o.id)) fail("The proposal edits an object that it also removes.");
      if (o.op === "set") {
        checkPath(o.path);
        const checkCurrent = !chosen || chosen.has(n);
        let owner, label;
        if (o.target === "project") { owner = p; label = "Project"; }
        else if (o.target === "document") { owner = docs.get(o.id); label = owner?.name; }
        else if (o.target === "library") { owner = lib.get(o.id); label = owner && "Library " + (owner.name || owner.id); }
        else { const hit = items.get(o.id); owner = hit?.d.id === o.document ? hit.i : null; label = owner && nameOf(owner); }
        if (checkCurrent && !owner) fail("Operation " + (n + 1) + " refers to an object that is not in this project.");
        if ((o.target === "project" || o.target === "document") && CODE_FIELDS.has(o.path[0]))
          fail("Operation " + (n + 1) + " edits " + o.path[0] + ", which holds code. Proposals cannot change it.");
        if (o.target === "project" && ["documents", "library", "atriumCompat"].includes(o.path[0]) || o.target === "document" && o.path[0] === "items" ||
            (o.target === "item" || o.target === "document" || o.target === "library") && o.path[0] === "id")
          fail("Operation " + (n + 1) + " edits a protected field.");
        const key = o.target + "\0" + (o.id || "") + "\0" + o.path.join("\0");
        if (seen.has(key)) fail("The proposal repeats a field.");
        if (parents.has(key)) fail("The proposal contains overlapping fields.");
        for (let i = 1; i < o.path.length; i++) {
          const parent = o.target + "\0" + (o.id || "") + "\0" + o.path.slice(0, i).join("\0");
          if (seen.has(parent)) fail("The proposal contains overlapping fields.");
          parents.add(parent);
        }
        seen.add(key);
        if (checkCurrent) {
          const now = read(owner, o.path);
          if (now.has !== own(o, "before") || now.has && !equal(now.value, o.before)) stale(label + " · " + o.path.join("."));
          if (o.target === "item" && owner.kind === "part" && o.path.length === 1 && V1_FIELDS.includes(o.path[0])) {
            // The project validator judges other deleted fields (a missing angle is 0). A designator is never deleted.
            if (own(o, "after") || o.path[0] === "ref") checkPartField(o.path[0], o.after);
          }
          if (o.target !== "project") listIn(final.edits, owner).push(o);
        }
        if (show) rows.push({index: n, op: o, label: label + " · " + o.path.join("."), detail: short(o.before) + " → " + short(o.after)});
        return;
      }
      const v = o.op === "add" ? o.value : o.before;
      if (!plain(v) || typeof v.id !== "string" || !v.id || o.op === "remove" && o.id !== v.id) fail("Operation " + (n + 1) + " is malformed.");
      if (o.target === "item") {
        const d = docs.get(o.document);
        if (!d) fail("Operation " + (n + 1) + " refers to a document that is not in this project.");
        checkOrder(o, n, d.items, id => items.get(id)?.d === d);
        if (o.op === "add") {
          if (items.has(v.id) || added.has(v.id)) fail("Item " + v.id + " already exists.");
          added.add(v.id);
          if (v.kind === "part" && (!chosen || chosen.has(n))) {
            checkAddedPart(v);
            listIn(final.items, d).push(v);
          }
          if (show) rows.push({index: n, op: o, label: "Add " + v.kind + " " + nameOf(v), detail: d.name});
          return;
        }
        const hit = items.get(o.id);
        if (!hit || hit.d !== d || !equal(hit.i, v)) stale(d.name + " · " + nameOf(v));
        if (!chosen || chosen.has(n)) final.gone.add("item\0" + o.id);
        if (show) rows.push({index: n, op: o, label: "Remove " + v.kind + " " + nameOf(v), detail: d.name});
        return;
      }
      const map = o.target === "document" ? docs : lib, what = o.target === "document" ? "document" : "library entry";
      checkOrder(o, n, map, id => map.has(id));
      if (o.op === "add") {
        if (map.has(v.id) || added.has(v.id)) fail("The " + what + " " + v.id + " already exists.");
        if (o.target === "document" && (!Array.isArray(v.items) || v.items.some(i => items.has(i.id)))) fail("Operation " + (n + 1) + " is malformed.");
        if (o.target === "document" && Object.keys(v).some(k => CODE_FIELDS.has(k))) fail("Operation " + (n + 1) + " adds code to a document. Proposals cannot do that.");
        added.add(v.id);
        if (!chosen || chosen.has(n)) {
          if (o.target === "document") {
            const parts = v.items.filter(i => i?.kind === "part");
            for (const i of parts) checkAddedPart(i);
            if (parts.length) final.docs.push(v);
          }
          else final.lib.push(v);
        }
        if (show) rows.push({index: n, op: o, label: "Add " + what + " " + (v.name || v.id), detail: ""});
        return;
      }
      if (!map.has(o.id) || !equal(map.get(o.id), v)) stale("The " + what + " " + (v.name || v.id));
      if (!chosen || chosen.has(n)) final.gone.add(o.target + "\0" + o.id);
      if (show) rows.push({index: n, op: o, label: "Remove " + what + " " + (v.name || v.id), detail: ""});
    });
    if (designators) checkDesignators(p, final);
    return rows;
  }
  // Every operation is checked. Only the requested preview rows are formatted.
  function inspect(proposal, p, limit = MAX_OPS, offset = 0, options = {}) {
    return check(proposal, p, limit, index(p, proposal), offset, null, options.designators !== false);
  }

  function memberOwner(op) {
    if (op.target === "item") return op.document;
    if (op.target === "document" || op.target === "library") return op.op === "add" ? op.value.id : op.id;
  }

  // Saved-project permission checks need the same member identity for either wire format.
  function memberOwners(proposal) {
    const ids = proposal.version === 1 ? proposal.changes.map(row => row.document) : proposal.ops.map(memberOwner);
    return [...new Set(ids.filter(id => id !== undefined))];
  }

  // Scope is derived from the selected, guarded operations inside the host.
  function footprint(proposal, select) {
    const documents = new Set(), items = new Set(), chosen = select && new Set(select);
    let project = false, library = false, unknownItems = false;
    if (proposal.version === 1) {
      for (const r of proposal.changes) {
        documents.add(r.document); items.add(r.id);
        if (!V1_TEXT.has(r.field)) unknownItems = true; // connected wires are transformed with the part
      }
    } else for (const [n, o] of proposal.ops.entries()) {
      if (chosen && !chosen.has(n)) continue;
      if (o.target === "item") { documents.add(o.document); items.add(o.op === "add" ? o.value.id : o.id); }
      else if (o.target === "document") {
        documents.add(o.op === "add" ? o.value.id : o.id);
        for (const i of (o.op === "add" ? o.value : o.before)?.items || []) items.add(i.id);
      } else if (o.target === "library") library = true;
      else project = true;
    }
    return {documents: [...documents], items: unknownItems ? null : [...items], project, library};
  }

  // Apply a version 2 proposal, or the operations whose indexes are in
  // `options.select`. Structural and chosen field guards are checked before any write.
  function apply(p, proposal, options = {}) {
    const lookup = index(p, proposal), chosen = options.select ? new Set(options.select) : null;
    check(proposal, p, 0, lookup, 0, chosen, options.designators !== false);
    const {docs, items, lib} = lookup;
    const after = (list, id, value) => {
      const at = id == null ? 0 : list.findIndex(x => x.id === id) + 1;
      list.splice(at > 0 || id == null ? at : list.length, 0, value);
    };
    let count = 0;
    for (const [n, o] of proposal.ops.entries()) {
      if (chosen && !chosen.has(n)) continue;
      count++;
      if (o.op === "set") {
        const owner = o.target === "project" ? p : o.target === "document" ? docs.get(o.id) : o.target === "library" ? lib.get(o.id) : items.get(o.id).i;
        write(owner, o.path, o);
        if (o.target === "item") options.touch?.(items.get(o.id).d, [owner]);
        if (o.target === "library") options.touch?.(null);
      } else if (o.target === "item") {
        const d = docs.get(o.document);
        if (o.op === "add") after(d.items, o.after_id, clone(o.value));
        else d.items.splice(d.items.findIndex(i => i.id === o.id), 1);
      } else {
        const list = o.target === "document" ? p.documents : p.library;
        if (o.op === "add") { const v = clone(o.value); after(list, o.after_id, v); (o.target === "document" ? docs : lib).set(v.id, v); }
        else list.splice(list.findIndex(x => x.id === o.id), 1);
      }
    }
    return count;
  }

  // Scalar/record sets keep document, item and library identities. Resolve their
  // guarded owners once, stage only those paths, then reserve the normal edit
  // transaction with the same checked footprint before publishing in the editor.
  function stageSets(p, proposal) {
    const independentItemFields = new Set(["x","y","angle","width","value","ref","locked"]);
    if (!proposal.ops.every(o => o?.op === "set" && o.target !== "library" &&
        (o.target !== "item" || o.path?.length === 1 && independentItemFields.has(o.path[0])))) return null;
    const lookup = index(p, proposal);
    check(proposal, p, 0, lookup);
    const documents = p.documents;
    const draft = {...p}, docs = new Map(), items = new Map(), copies = new WeakSet(), validate = new Map();
    const ownerOf = op => op.target === "project" ? p : op.target === "document" ? lookup.docs.get(op.id) : lookup.items.get(op.id).i;
    for (const op of proposal.ops) {
      let owner = draft;
      if (op.target !== "project") {
        const hit = op.target === "item" ? lookup.items.get(op.id) : null;
        const source = hit?.d ?? lookup.docs.get(op.id);
        let document = docs.get(source);
        if (!document) {
          document = {...source};
          docs.set(source, document);
          validate.set(document, []);
        }
        owner = document;
        if (hit) {
          if (!items.has(hit.i)) {
            const copy = {...hit.i};
            if (document.items === source.items) document.items = source.items.slice();
            document.items[hit.at] = copy;
            items.set(hit.i, copy);
            validate.get(document)?.push(copy);
          }
          owner = items.get(hit.i);
        } else validate.set(document, null);
      }
      let parent = owner;
      for (const key of op.path.slice(0, -1)) {
        if (!own(parent, key) || !plain(parent[key])) break;
        if (!copies.has(parent[key])) {parent[key] = {...parent[key]}; copies.add(parent[key]);}
        parent = parent[key];
      }
      write(owner, op.path, op);
    }
    if (docs.size) draft.documents = p.documents.map(d => docs.get(d) ?? d);
    const itemPositions = new Map(Array.from(lookup.items, ([id,{at}]) => [id,at]));
    return {project:draft, validate, itemPositions, apply(edit) {
      if (p.documents !== documents || [...docs.keys()].some(d => !p.documents.includes(d)) ||
          [...lookup.items.values()].some(({d,i,at}) => d.items[at] !== i))
        fail("This project changed since the edit was prepared.");
      check(proposal, p, 0, lookup);
      const byDoc = new Map();
      for (const {d,i} of lookup.items.values()) {
        if (!byDoc.has(d)) byDoc.set(d, []);
        byDoc.get(d).push(i);
      }
      // Undo tracks document fields separately. Keep the exact item changes
      // even when validation had to check the whole document.
      for (const doc of docs.keys()) if (!byDoc.has(doc)) byDoc.set(doc, []);
      return edit(() => {
        for (const op of proposal.ops) write(ownerOf(op), op.path, op);
      }, [...byDoc].map(([doc,items]) => ({doc,items})), footprint(proposal));
    }};
  }

  // Apply the checked proposal to a scratch root. Copy only its touched lists,
  // keyed records and ancestor paths. Existing proposal guards run before forking.
  function fork(p, plan) {
    inspect(plan, p, 0);
    const root = {...p}, docs = new Map(), libs = new Map(), items = new Map(), copies = new WeakSet();
    function forkAt(list, cache, id) {
      if (!cache.has(id)) {
        const i = list.findIndex(record => record.id === id);
        if (i < 0) return undefined;
        list[i] = {...list[i]};
        cache.set(id, list[i]);
      }
      return cache.get(id);
    }
    for (const op of plan.ops) {
      let owner = root;
      if (op.target === "library") {
        if (root.library === p.library) root.library = [...p.library];
        if (op.op === "set") owner = forkAt(root.library, libs, op.id);
      } else if (op.target !== "project") {
        if (root.documents === p.documents) root.documents = [...p.documents];
        if (op.target === "item" || op.op === "set") owner = forkAt(root.documents, docs, op.target === "item" ? op.document : op.id);
        if (op.target === "item") {
          if (!copies.has(owner.items)) {owner.items = [...owner.items]; copies.add(owner.items);}
          if (op.op === "set") owner = forkAt(owner.items, items, op.id);
        }
      }
      if (op.op !== "set") continue;
      for (const key of op.path.slice(0, -1)) {
        if (!own(owner, key) || !plain(owner[key])) break;
        if (!copies.has(owner[key])) {owner[key] = {...owner[key]}; copies.add(owner[key]);}
        owner = owner[key];
      }
    }
    return root;
  }

  function guarded(p, command, ops) {
    return {format:"atrium-ai", version:2, project:p.name, source_sha256:null,
      document_ids:p.documents.map(d => d.id).sort(), tool:command, ops};
  }

  // Prepare the exact reviewed operations against a scratch project before
  // any editor transaction or native publication can run.
  function prepare(p, proposal, validate) {
    if (proposal?.version !== 2 || !Array.isArray(proposal.ops)) fail("Choose a valid Waffle AI proposal.");
    const stage = stageSets(p, proposal);
    if (stage) {
      validate(stage.project, {normalize:false, scoped:stage.validate});
      return stage;
    }
    const project = fork(p, proposal);
    applyChecked(project, proposal, {validate:q => validate(q, {normalize:false}), trial:false});
    return {project, apply:edit => applyChecked(p, proposal, {
      edit:(change, _, touched, scope) => edit(change, touched, scope)})};
  }

  // ------------------------------------------------------------ version 1
  // Check a version 1 proposal ({changes:[{document,id,ref,field,before,after}]}) against the project.
  function inspectV1(proposal, p) {
    if (proposal?.format !== "atrium-ai" || proposal.version !== 1 || !Array.isArray(proposal.changes) || !proposal.changes.length || proposal.changes.length > 100)
      fail("Choose a valid Waffle AI proposal.");
    if (proposal.project !== p.name) fail("This proposal belongs to another project.");
    if (proposal.document_ids && (!Array.isArray(proposal.document_ids) || proposal.document_ids.some(id => !p.documents.some(d => d.id === id))))
      fail("This proposal belongs to another document set.");
    const parts = new Map();
    for (const d of p.documents) for (const i of d.items) if (i.kind === "part") parts.set(i.id, [d, i]);
    const seen = new Set();
    const checked = proposal.changes.map(row => {
      if (!plain(row)) fail("The proposal refers to an unknown or repeated field.");
      const [d, i] = parts.get(row.id) || [], {field, after} = row, key = row.id + "/" + field;
      if (!i || d.id !== row.document || !V1_FIELDS.includes(field) || seen.has(key)) fail("The proposal refers to an unknown or repeated field.");
      seen.add(key);
      checkPartField(field, after);
      if ((i[field] ?? 0) !== row.before) fail(i.ref + " has changed since this proposal was drafted. Generate a fresh proposal.");
      return {d, i, row};
    });
    const edits = new Map(), refs = new Map();
    for (const {d, i, row} of checked) if (row.field === "ref") {
      edits.set(i, [{target: "item", path: ["ref"], after: row.after}]);
      if (!refs.has(d)) refs.set(d, new Map());
      refs.get(d).set(i, row.after);
    }
    checkDesignators(p, {edits});
    // Version 1 also keeps its original rule: no other part on the document has the exact new
    // designator, which still refuses a repeated unannotated designator such as "R?".
    for (const [d, changed] of refs) for (const [i, ref] of changed)
      if (unannotated(ref) && d.items.some(j => j.kind === "part" && j !== i && (changed.has(j) ? changed.get(j) : j.ref) === ref))
        fail("Designator " + ref + " is already used on " + d.name + ".");
    return checked;
  }
  function applyV1(p, proposal, transform, touch) {
    const checked = inspectV1(proposal, p);
    // Group geometry updates so a single proposed transform moves wire endpoints once.
    const updates = new Map();
    for (const {d, i, row} of checked) { if (!updates.has(i)) updates.set(i, {d, props: {}}); updates.get(i).props[row.field] = row.after; }
    for (const [i, {d, props}] of updates) {
      if (["x", "y", "angle"].some(k => k in props)) {
        if (!transform) fail("This host cannot apply proposed geometry.");
        const moved = transform(d, i, props);
        touch?.(d, moved); // An older host's transform may not identify its connected wires.
      } else { Object.assign(i, props); touch?.(d, [i]); }
    }
    return checked.length;
  }

  // The one checked apply path for proposals from AI tools, agents and extensions. Structure,
  // project binding and the applicable live guards are rechecked against the live project,
  // the proposal is first applied to a copy that must pass `validate`, then applied to `p`
  // inside `edit` (one undo step) and validated again.
  // options: {select, validate(project), edit(fn), transform(doc, item, props), trial: false | copy(p), designators: false (see check)}
  function applyChecked(p, proposal, options = {}) {
    const {select, validate, edit = fn => fn(), transform} = options;
    const v1 = proposal?.version === 1;
    if (!v1) for (const o of Array.isArray(proposal?.ops) ? proposal.ops : [])
      if ((o?.target === "project" || o?.target === "document") && Array.isArray(o.path) && CODE_FIELDS.has(String(o.path[0])))
        fail("Proposals cannot change " + o.path[0] + ": it holds code the editor runs.");
    const once = (q, touch) => v1 ? applyV1(q, proposal, transform, touch) : apply(q, proposal, {select, touch, designators: options.designators});
    let trialItems;
    if (validate && options.trial !== false) {
      const trial = typeof options.trial === "function" ? options.trial(p) : JSON.parse(JSON.stringify(p));
      if (v1) {
        trialItems = new Set(); let known = true;
        once(trial, (_, items) => { if (items) for (const i of items) trialItems.add(i.id); else known = false; });
        if (!known) trialItems = null;
      } else once(trial, undefined);
      try { validate(trial); } catch (e) { fail("The proposal would leave the project invalid: " + e.message); }
    }
    if (options.validateOnly) return 0;
    let count = 0;
    const byDoc = new Map();
    let library = false, unknown = false;
    function touch(doc, items) {
      if (!doc) { library = true; return; }
      if (!items) { unknown = true; return; }
      if (!byDoc.has(doc)) byDoc.set(doc, new Set());
      for (const item of items) byDoc.get(doc).add(item);
    }
    // Structural writes are recorded by identity. Collect only live, selected in-place changes.
    const scope = footprint(proposal, select);
    if (trialItems) scope.items = [...trialItems];
    const accepted = edit(() => { count = once(p, touch); if (validate) validate(p); }, undefined,
      () => unknown ? undefined : [...[...byDoc].map(([doc, items]) => ({doc, items})), ...(library ? [{library:true}] : [])],
      scope);
    return accepted === false ? 0 : count;
  }

  return Object.freeze({diff, diffItemPairs, build, summarize, memberOwner, memberOwners, footprint, inspect, apply, inspectV1, applyChecked, guarded, prepare, stageSets, equal, CODE_FIELDS, V1_FIELDS});
})();
