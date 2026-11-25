"use strict";
// AtriumMerge3: the semantic three-way merge of projected Waffle designs for the visual merge view.
// Native Git review also supplies the atomic conflicts detected by format-2-git.js.
//
//   AtriumMerge3.merge(base, ours, theirs, opts) -> {project, conflicts[], changes[], renames, stats}
//   AtriumMerge3.resolve(result, choices)        -> project with each conflict resolved ("ours" | "theirs" | "both")
//   AtriumMerge3.serialize(project)              -> the project file text (keys sorted, one object per line)
//   AtriumMergeDriver(header, "base\x1eours\x1etheirs") -> JSON {text, conflicts[{id,label}], changes}
//
// Objects are matched by id: documents, the items on each document, library entries, review threads
// and any other array whose entries all carry a string id. For each object:
//   changed on one side only            -> that side's version (added, edited or deleted)
//   changed the same way on both sides  -> that version
//   changed differently on both sides   -> merged field by field; a field changed differently on both
//                                          sides (or an edit against a delete) is a conflict
// Other values (names, grids, rules, arrays without ids) merge as whole values. Import bookkeeping
// (where an object sits in its source file, the file's hash) never conflicts: both sides re-importing
// one Altium design move record indexes, so a field both changed keeps ours.
// A conflict keeps our side in `project` until resolve() applies a choice.
//
// Net renames: a net renamed on one side (every object on net A moved to net B, and B is new) is
// carried into objects the other side added or edited, so a part added on a branch that still
// names the old net lands on the renamed net.
//
// Designators: both sides adding a part as R7 (different ids, so no conflict by id) would leave two
// R7s. Their part is renumbered to the next free designator of the same prefix, on every document
// it was added to (schematic and board stay in step), and listed in `renumbered` and `changes`.
// Gates of one part (U5 A and U5 B) and annotations still to do (R?) are left alone.
globalThis.AtriumMerge3 = (() => {
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  function sorted(v) {
    if (Array.isArray(v)) return v.map(sorted);
    if (!isObj(v)) return v;
    const o = {};
    for (const k of Object.keys(v).sort()) o[k] = sorted(v[k]);
    return o;
  }
  const canon = v => v === undefined ? "\u0000undefined" : JSON.stringify(sorted(v));
  const same = (a, b) => a === b || canon(a) === canon(b);
  const clone = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const BOOKKEEPING = new Set(["sourceRecord", "schSource", "sourceSha256", "sourcePourSignature"]);
  const bookkeeping = path => BOOKKEEPING.has(path[path.length - 1]);
  // Arrays whose entries are all objects with distinct string ids merge per entry.
  function keyed(arr) {
    if (arr === undefined) return true;
    if (!Array.isArray(arr)) return false;
    const seen = new Set();
    for (const x of arr) {
      if (!isObj(x) || typeof x.id !== "string" || !x.id || seen.has(x.id)) return false;
      seen.add(x.id);
    }
    return true;
  }
  // Documents and other objects that hold id-keyed lists merge entry by entry, never as one object.
  const container = o => Object.values(o).some(v => Array.isArray(v) && v.length && keyed(v));
  function label(obj, path) {
    if (!isObj(obj)) return path.map(p => typeof p === "object" ? p.id : p).join(" › ");
    const kind = obj.kind ? String(obj.kind) : path.length && typeof path[path.length - 2] === "string" ? String(path[path.length - 2]).replace(/s$/, "") : "object";
    const name = obj.ref || obj.name || obj.text || obj.net || obj.id;
    return kind + " " + String(name).slice(0, 80);
  }

  // ------------------------------------------------------------------ net renames
  function netsOf(item) {
    const out = [];
    if (!isObj(item)) return out;
    if (typeof item.net === "string" && item.net) out.push(item.net);
    if (isObj(item.pinNets)) for (const v of Object.values(item.pinNets)) if (typeof v === "string" && v) out.push(v);
    if ((item.kind === "netlabel" || item.kind === "power" || item.kind === "port") && typeof item.text === "string" && item.text) out.push(item.text);
    return out;
  }
  // {old: new} for nets every base object renamed consistently on this side, to a name the base did not use.
  function renames(base, side) {
    const out = {};
    if (!isObj(base) || !isObj(side)) return out;
    const sideDocs = new Map((side.documents || []).filter(isObj).map(d => [d.id, d]));
    const baseNets = new Set(), sideNets = new Set(), missing = new Set(), pairs = new Map();
    for (const d of base.documents || []) {
      if (!isObj(d)) continue;
      const other = sideDocs.get(d.id), byId = new Map((other?.items || []).filter(isObj).map(i => [i.id, i]));
      for (const i of d.items || []) {
        for (const n of netsOf(i)) baseNets.add(n);
        const a = fieldsOfNets(i), b = fieldsOfNets(byId.get(i?.id));
        for (const [field, from] of a) {
          const to = b.get(field);
          if (to === undefined) { missing.add(from); continue; }
          if (to === from) continue;
          if (!pairs.has(from)) pairs.set(from, new Map());
          pairs.get(from).set(to, (pairs.get(from).get(to) || 0) + 1);
        }
      }
    }
    for (const d of side.documents || []) for (const i of (isObj(d) && d.items) || []) for (const n of netsOf(i)) sideNets.add(n);
    for (const [from, targets] of pairs) {
      if (targets.size !== 1 || sideNets.has(from) || missing.has(from)) continue;
      const [to] = targets.keys();
      if (!baseNets.has(to)) out[from] = to;
    }
    return out;
  }
  function fieldsOfNets(item) {
    const m = new Map();
    if (!isObj(item)) return m;
    if (typeof item.net === "string") m.set("net", item.net);
    if (isObj(item.pinNets)) for (const [k, v] of Object.entries(item.pinNets)) if (typeof v === "string") m.set("pin:" + k, v);
    if ((item.kind === "netlabel" || item.kind === "power" || item.kind === "port") && typeof item.text === "string") m.set("text", item.text);
    return m;
  }
  function applyRenames(item, map) {
    if (!isObj(item) || !Object.keys(map).length) return item;
    let changed = false;
    const out = {...item};
    if (typeof out.net === "string" && map[out.net]) { out.net = map[out.net]; changed = true; }
    if (isObj(out.pinNets)) {
      const pins = {...out.pinNets};
      for (const [k, v] of Object.entries(pins)) if (typeof v === "string" && map[v]) { pins[k] = map[v]; changed = true; }
      out.pinNets = pins;
    }
    if ((out.kind === "netlabel" || out.kind === "power" || out.kind === "port") && typeof out.text === "string" && map[out.text]) { out.text = map[out.text]; changed = true; }
    return changed ? out : item;
  }

  // ------------------------------------------------------------------ the merge
  function visualFields(conflict) {
    const fields = [];
    for (const key of conflict?.fields || []) {
      if (key === "at") fields.push("x", "y");
      else if (conflict.kind === "frame" && key === "name" || conflict.kind === "math" && key === "tex") fields.push("text");
      else if (conflict.kind === "math" && key === "em") fields.push("size");
      else fields.push(key);
    }
    return fields;
  }

  function merge(base, ours, theirs, opts = {}) {
    const conflicts = [], changes = [];
    const atomic = new Map();
    for (const entry of opts.nativeConflicts || []) {
      if (!atomic.has(entry.owner)) atomic.set(entry.owner, new Map());
      atomic.get(entry.owner).set(entry.id, entry);
    }
    const R = {ours: renames(base, ours), theirs: renames(base, theirs)};
    // path: keys and {id} steps from the project root. owner: the nearest id'd object (for labels).
    function value(b, o, t, path, prefer, record) {
      if (same(o, t)) return clone(o);
      if (same(b, o)) { if (record) note(path, "theirs", b, t); return clone(t); }
      if (same(b, t)) { if (record) note(path, "ours", b, o); return clone(o); }
      if (bookkeeping(path)) return clone(prefer === "theirs" ? t : o);
      if (isObj(o) && isObj(t)) return object(isObj(b) ? b : {}, o, t, path, prefer, record);
      if ((Array.isArray(o) || o === undefined) && (Array.isArray(t) || t === undefined) && keyed(b) && keyed(o) && keyed(t) && (o || t))
        return collection(b || [], o || [], t || [], path, prefer, record);
      if (record) conflict(path, b, o, t, null);
      return clone(prefer === "theirs" ? t : o);
    }
    function object(b, o, t, path, prefer, record) {
      const out = {};
      const keys = new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(b)]);
      for (const k of [...keys].sort()) {
        const v = value(b[k], o[k], t[k], path.concat(k), prefer, record);
        if (v !== undefined) out[k] = v;
      }
      return out;
    }
    function collection(b, o, t, path, prefer, record) {
      const B = new Map(b.map(x => [x.id, x])), O = new Map(o.map(x => [x.id, x])), T = new Map(t.map(x => [x.id, x]));
      const merged = new Map();
      const isItems = path[path.length - 1] === "items";
      const decisions = atomic.size && isItems ? atomic.get(owner(path).docId) : null;
      for (const id of new Set([...O.keys(), ...T.keys(), ...B.keys()])) {
        const bv = B.get(id), ov = O.get(id), tv = T.get(id), here = path.concat({id});
        let v;
        const bb = isObj(bv) ? bv : {};
        const native = decisions?.get(id);
        if (same(ov, tv)) v = clone(ov);
        else if (isObj(ov) && isObj(tv) && (native || opts.nativeConflicts && bv === undefined)) {
          const fields = visualFields(native);
          function keep(side) {
            const selected = side === "ours" ? ov : tv;
            if (!fields.length) return clone(selected);
            const updated = object(bb, ov, tv, here, side, false);
            for (const field of fields) {
              if (Object.hasOwn(selected, field)) updated[field] = clone(selected[field]);
              else delete updated[field];
            }
            return updated;
          }
          const left = keep("ours"), right = keep("theirs");
          if (record) conflict(here, bv, ov, tv, fields, left, right);
          v = prefer === "ours" ? left : right;
        } else if (isObj(ov) && isObj(tv) && (container(ov) || container(tv))) v = object(bb, ov, tv, here, prefer, record);
        else if (same(bv, ov)) { v = clone(tv); if (isItems && tv) v = applyRenames(v, R.ours); if (record) note(here, "theirs", bv, tv); }
        else if (same(bv, tv)) { v = clone(ov); if (isItems && ov) v = applyRenames(v, R.theirs); if (record) note(here, "ours", bv, ov); }
        else if (isObj(ov) && isObj(tv)) {
          // Both edited one object: merge its fields; any field changed differently makes it one conflict.
          const fields = fieldConflicts(bb, ov, tv);
          v = object(bb, ov, tv, here, prefer, false);
          if (fields.length) { if (record) conflict(here, bv, ov, tv, fields, object(bb, ov, tv, here, "ours", false), object(bb, ov, tv, here, "theirs", false)); }
          else if (record) note(here, "both", bv, v);
        } else {
          // Edited on one side, deleted on the other (or added differently on both).
          if (record) conflict(here, bv, ov, tv, null);
          v = clone(prefer === "theirs" ? tv : ov);
        }
        if (v !== undefined) merged.set(id, v);
      }
      // Our order; entries only theirs has go after their predecessor in theirs (or at the end).
      const order = o.map(x => x.id).filter(id => merged.has(id));
      const placed = new Set(order);
      t.forEach((x, n) => {
        if (placed.has(x.id) || !merged.has(x.id)) return;
        let at = -1;
        for (let k = n - 1; k >= 0 && at < 0; k--) at = order.indexOf(t[k].id);
        if (at < 0) {
          // No predecessor kept: before the next kept successor, else at the end.
          let next = -1;
          for (let k = n + 1; k < t.length && next < 0; k++) next = order.indexOf(t[k].id);
          at = next < 0 ? order.length - 1 : next - 1;
        }
        order.splice(at + 1, 0, x.id); placed.add(x.id);
      });
      for (const id of merged.keys()) if (!placed.has(id)) order.push(id);
      return order.map(id => merged.get(id));
    }
    function fieldConflicts(b, o, t) {
      const out = [];
      for (const k of new Set([...Object.keys(o), ...Object.keys(t), ...Object.keys(b)])) {
        if (same(o[k], t[k]) || same(b[k], o[k]) || same(b[k], t[k]) || BOOKKEEPING.has(k)) continue;
        if (isObj(o[k]) && isObj(t[k])) { for (const f of fieldConflicts(isObj(b[k]) ? b[k] : {}, o[k], t[k])) out.push(k + "." + f); continue; }
        if (Array.isArray(o[k]) && Array.isArray(t[k]) && keyed(b[k]) && keyed(o[k]) && keyed(t[k])) {
          const sub = merge3Keys(b[k] || [], o[k], t[k]);
          for (const f of sub) out.push(k + "[" + f + "]");
          continue;
        }
        out.push(k);
      }
      return out;
    }
    function merge3Keys(b, o, t) {
      const B = new Map(b.map(x => [x.id, x])), O = new Map(o.map(x => [x.id, x])), T = new Map(t.map(x => [x.id, x])), out = [];
      for (const id of new Set([...O.keys(), ...T.keys()])) {
        const bv = B.get(id), ov = O.get(id), tv = T.get(id);
        if (same(ov, tv) || same(bv, ov) || same(bv, tv)) continue;
        if (isObj(ov) && isObj(tv) && !fieldConflicts(isObj(bv) ? bv : {}, ov, tv).length) continue;
        out.push(id);
      }
      return out;
    }
    function owner(path) {
      let docId = null, doc = null;
      for (let i = 0; i < path.length; i++) if (path[i] === "documents" && isObj(path[i + 1])) docId = path[i + 1].id;
      if (docId) doc = (ours?.documents || []).find(d => d?.id === docId) || (theirs?.documents || []).find(d => d?.id === docId) || null;
      return {docId, docName: doc?.name || null};
    }
    function note(path, side, before, after) {
      if (changes.length >= (opts.maxChanges || 20000)) return;
      const obj = isObj(after) ? after : isObj(before) ? before : null;
      changes.push({path, side, status: before === undefined ? "added" : after === undefined ? "removed" : "modified",
        label: label(obj, path), ...owner(path), objectId: isObj(path[path.length - 1]) ? path[path.length - 1].id : null});
    }
    function conflict(path, b, o, t, fields, oursValue, theirsValue) {
      const obj = isObj(o) ? o : isObj(t) ? t : isObj(b) ? b : null;
      conflicts.push({id: "c" + (conflicts.length + 1), path, fields, label: label(obj, path), ...owner(path),
        objectId: isObj(path[path.length - 1]) ? path[path.length - 1].id : null, kind: obj?.kind || null,
        base: clone(b), ours: clone(oursValue !== undefined ? oursValue : o), theirs: clone(theirsValue !== undefined ? theirsValue : t),
        // As each side wrote it (ours/theirs above also carry the other side's non-conflicting fields).
        sides: {ours: clone(o), theirs: clone(t)},
        status: o === undefined ? "deleted-ours" : t === undefined ? "deleted-theirs" : b === undefined ? "added-both" : "modified-both",
        both: isObj(o) && isObj(t) && isObj(path[path.length - 1])});
    }
    const B = isObj(base) ? base : {}, O = isObj(ours) ? ours : {}, T = isObj(theirs) ? theirs : {};
    const project = object(B, O, T, [], "ours", true);
    const renumbered = opts.renumber === false ? [] : renumber(project, B, O, T);
    for (const r of renumbered) changes.push({path: ["documents", {id: r.docs[0]?.id}, "items", {id: r.ids[0]}], side: "theirs", status: "renumbered",
      label: "part " + r.from + " → " + r.to, docId: r.docs[0]?.id || null, docName: r.docs[0]?.name || null, objectId: r.ids[0], from: r.from, to: r.to});
    return {project, conflicts, changes, renames: R, renumbered, stats: {conflicts: conflicts.length, changes: changes.length, renumbered: renumbered.length,
      ours: changes.filter(c => c.side === "ours").length, theirs: changes.filter(c => c.side === "theirs").length}};
  }

  // Parts both sides added under one designator (see the header). Domains: every schematic sheet
  // together (a design's designators are project-wide), each board on its own.
  function renumber(project, base, ours, theirs) {
    const parts = P => { const m = new Map(); for (const d of (isObj(P) && Array.isArray(P.documents) ? P.documents : [])) for (const i of (isObj(d) && Array.isArray(d.items) ? d.items : [])) if (isObj(i) && i.kind === "part" && typeof i.id === "string") m.set(i.id, i); return m; };
    const PB = parts(base), PO = parts(ours), PT = parts(theirs);
    const added = (id, P, Q) => P.has(id) && !PB.has(id) && !Q.has(id);
    const pending = ref => typeof ref !== "string" || !ref || /\?$/.test(ref);
    const docs = (project.documents || []).filter(isObj);
    const domain = d => d.kind === "pcb" ? "pcb:" + d.id : "schematic";
    // Every designator in the merged project (the new ones must be free everywhere).
    const used = new Set();
    for (const d of docs) for (const i of d.items || []) if (isObj(i) && i.kind === "part" && typeof i.ref === "string") used.add(i.ref);
    const clash = new Map();
    for (const [key, list] of (() => { const g = new Map(); for (const d of docs) for (const i of d.items || []) if (isObj(i) && i.kind === "part" && !pending(i.ref)) { const k = domain(d) + "\u0000" + i.ref; if (!g.has(k)) g.set(k, []); g.get(k).push(i); } return g; })()) {
      const mine = list.filter(i => added(i.id, PO, PT)), theirsNew = list.filter(i => added(i.id, PT, PO));
      if (!mine.length || !theirsNew.length) continue;
      // Gates of one part: only a gate both sides added (or a part without gates) clashes.
      if (!theirsNew.some(t => mine.some(m => !m.gate || !t.gate || m.gate === t.gate))) continue;
      const separator = key.indexOf("\u0000"), from = key.slice(separator + 1);
      if (!clash.has(from)) clash.set(from, {domains: new Set(), links: new Set()});
      const {domains, links} = clash.get(from);
      domains.add(key.slice(0, separator));
      for (const i of theirsNew) if (typeof i.link === "string" && i.link) links.add(i.link);
    }
    const out = [];
    for (const from of [...clash.keys()].sort()) {
      const {domains, links} = clash.get(from);
      const stem = from.replace(/\d+$/, ""), start = +(from.match(/\d+$/)?.[0] || 0);
      let k = Math.max(1, start + 1);
      while (used.has(stem + k)) k++;
      const to = stem + k; used.add(to);
      const ids = [], where = [];
      for (const d of docs) for (const i of d.items || []) {
        if (!isObj(i) || i.kind !== "part" || i.ref !== from || !added(i.id, PT, PO)) continue;
        if (!domains.has(domain(d)) && !links.has(i.link)) continue;
        i.ref = to;
        ids.push(i.id);
        if (!where.some(x => x.id === d.id)) where.push({id: d.id, name: d.name || null});
      }
      if (ids.length) out.push({from, to, ids, docs: where});
    }
    return out;
  }

  // ------------------------------------------------------------------ resolving
  function locate(root, path) {
    let parent = root;
    for (let i = 0; i < path.length - 1; i++) {
      const step = path[i];
      parent = isObj(step) ? (Array.isArray(parent) ? parent.find(x => x?.id === step.id) : undefined) : parent?.[step];
      if (parent === undefined || parent === null) return null;
    }
    return {parent, last: path[path.length - 1]};
  }
  function put(root, path, value, after) {
    const at = locate(root, path);
    if (!at) return false;
    const {parent, last} = at;
    if (isObj(last)) {
      if (!Array.isArray(parent)) return false;
      const i = parent.findIndex(x => x?.id === last.id);
      if (value === undefined) { if (i >= 0) parent.splice(i, 1); }
      else if (i >= 0) parent[i] = value;
      else parent.push(value);
      if (after !== undefined) parent.splice((i >= 0 ? i : parent.length - 1) + 1, 0, after);
    } else if (value === undefined) delete parent[last];
    else parent[last] = value;
    return true;
  }
  // A copy of theirs for "both" keeps a unique part designator.
  function copyOf(obj, siblings, id) {
    const out = {...clone(obj), id};
    if (typeof out.ref === "string") {
      const refs = new Set((siblings || []).map(x => x?.ref));
      const stem = out.ref.replace(/\d+$/, ""), start = +(out.ref.match(/\d+$/)?.[0] || 1);
      let k = start + 1;
      while (refs.has(stem + k)) k++;
      out.ref = stem + k;
    }
    return out;
  }
  // choices: {conflictId: "ours" | "theirs" | "both"}; unlisted conflicts stay "ours".
  function resolve(result, choices = {}, copyIds = new Map()) {
    const project = clone(result.project);
    for (const c of result.conflicts) {
      const choice = choices[c.id] || "ours";
      if (choice === "ours") { put(project, c.path, clone(c.ours)); continue; }
      if (choice === "theirs") { put(project, c.path, clone(c.theirs)); continue; }
      if (choice === "both" && c.both) {
        const at = locate(project, c.path);
        if (!at) continue;
        let id = copyIds.get(c.id);
        if (!id) {
          id = globalThis.Atrium.id();
          copyIds.set(c.id, id);
        }
        put(project, c.path, clone(c.ours), copyOf(c.theirs, Array.isArray(at.parent) ? at.parent : [], id));
      }
    }
    return project;
  }

  // ------------------------------------------------------------------ file text
  // The project file layout (app/eco.js serialize): keys sorted, one entry per line down to the
  // document fields, deeper values minified unless longer than LINE.
  const LINE = 1024, DEPTH = 4;
  const num = n => Number.isInteger(n) || !(Math.abs(n) < 1e9) ? n : Number(n.toPrecision(12));
  function canonical(v) {
    if (typeof v === "number") return num(v);
    if (Array.isArray(v)) return v.map(canonical);
    if (!isObj(v)) return v;
    const o = Object.create(null);
    for (const k of Object.keys(v).sort()) o[k] = canonical(v[k]);
    return o;
  }
  const skip = x => x === undefined || typeof x === "function" || typeof x === "symbol";
  function layout(v, d) {
    if (v === null || typeof v !== "object") return JSON.stringify(v);
    if (d >= DEPTH) { const m = JSON.stringify(v); if (m.length <= LINE) return m; }
    const inner = " ".repeat(2 * d + 2), outer = " ".repeat(2 * d);
    if (Array.isArray(v)) return v.length ? "[\n" + inner + v.map(x => skip(x) ? "null" : layout(x, d + 1)).join(",\n" + inner) + "\n" + outer + "]" : "[]";
    const keys = Object.keys(v).filter(k => !skip(v[k]));
    return keys.length ? "{\n" + inner + keys.map(k => JSON.stringify(k) + ": " + layout(v[k], d + 1)).join(",\n" + inner) + "\n" + outer + "}" : "{}";
  }
  const serialize = p => globalThis.AtriumECO?.serialize ? globalThis.AtriumECO.serialize(p) : layout(canonical(p), 0) + "\n";

  function parse(text, side) {
    let p;
    try { p = JSON.parse(String(text).replace(/^﻿/, "")); } catch { throw Error("The " + side + " version is not valid project JSON."); }
    if (!isObj(p) || p.format !== "atrium" || !Array.isArray(p.documents)) throw Error("The " + side + " version is not a Waffle project.");
    return p;
  }
  return Object.freeze({merge, resolve, serialize, parse, renames, same, canon, keyed});
})();

// Entry point of the Git merge driver (native/git_head.py --merge-driver through mcp/board_runner.py).
// One part: the three files joined by U+001E, which valid JSON text never contains unescaped.
globalThis.AtriumMergeDriver = function(header, joined) {
  const M = globalThis.AtriumMerge3, parts = String(joined).split("\u001e");
  if (parts.length !== 3) throw Error("The merge driver needs the base, ours and theirs files.");
  const [base, ours, theirs] = parts.map((t, i) => M.parse(t, ["base", "ours", "theirs"][i]));
  const r = M.merge(base, ours, theirs);
  return JSON.stringify({text: M.serialize(r.project), conflicts: r.conflicts.map(c => ({id: c.id, label: c.label, document: c.docName, status: c.status, fields: c.fields})),
    changes: r.stats.changes, renames: r.renames, renumbered: r.renumbered.map(x => ({from: x.from, to: x.to}))});
};
