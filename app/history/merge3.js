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
// Documents: an item's id is unique in the project, so an item a side moved to another sheet or
// board is one object, merged once with its document as one more field. Moved to different
// documents on each side, moved on one side and deleted on the other, or moved onto a document the
// other side deleted, is one conflict (fields include "document"); its `documents` {base, ours, theirs}
// says where each side put it, and `restore` holds a deleted document resolve() brings back for it.
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
  // An item's document while it merges as one object (never a real field name: JSON keys from files are not NUL).
  const DOC = "\u0000document";
  // id -> {doc, item, index} for every document item of one side.
  function locations(P) {
    const m = new Map();
    for (const d of Array.isArray(P.documents) ? P.documents : []) if (isObj(d) && Array.isArray(d.items))
      d.items.forEach((item, index) => { if (isObj(item) && typeof item.id === "string" && !m.has(item.id)) m.set(item.id, {doc: d.id, item, index}); });
    return m;
  }
  // Where an entry at source[index] goes in list: after its nearest predecessor in source, else
  // before its nearest successor, else at the end.
  function slot(list, source, index) {
    const find = k => { const id = source[k]?.id; return typeof id === "string" ? list.findIndex(x => x?.id === id) : -1; };
    for (let k = index - 1; k >= 0; k--) { const i = find(k); if (i >= 0) return i + 1; }
    for (let k = index + 1; k < source.length; k++) { const i = find(k); if (i >= 0) return i; }
    return list.length;
  }
  // Items placed into one merged document ({value, source, index}: where the side that put it there
  // has it), as slot() places each, in one pass: an item may follow another placed with it.
  function insertAll(items, list) {
    const present = new Set(items.map(x => x?.id)), incoming = new Set(list.map(e => e.value.id));
    const after = new Map(), before = new Map(), end = [];
    const add = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    const known = id => typeof id === "string" && (present.has(id) || incoming.has(id));
    for (const {value, source, index} of list) {
      let k = index - 1;
      while (k >= 0 && !(known(source[k]?.id) && source[k].id !== value.id)) k--;
      if (k >= 0) { add(after, source[k].id, value); continue; }
      k = index + 1;
      while (k < source.length && !(known(source[k]?.id) && source[k].id !== value.id)) k++;
      if (k < source.length) add(before, source[k].id, value); else end.push(value);
    }
    const out = [], done = new Set();
    // Depth-first without recursion: a long chain of placed items would overflow the stack.
    const emit = root => {
      const stack = [{x: root, phase: 0}];
      while (stack.length) {
        const f = stack[stack.length - 1], id = f.x?.id;
        if (f.phase === 0) {
          if (typeof id === "string" && incoming.has(id)) { if (done.has(id)) { stack.pop(); continue; } done.add(id); }
          f.phase = 1;
          const b = before.get(id); if (b) for (let i = b.length - 1; i >= 0; i--) stack.push({x: b[i], phase: 0});
        } else if (f.phase === 1) {
          out.push(f.x); f.phase = 2;
          const a = after.get(id); if (a) for (let i = a.length - 1; i >= 0; i--) stack.push({x: a[i], phase: 0});
        } else stack.pop();
      }
    };
    for (const x of items) emit(x);
    for (const x of end) emit(x);
    for (const {value} of list) if (!done.has(value.id)) emit(value);
    return out;
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
      // A document merges field by field even when it holds no items (every one moved away, say).
      const isDocs = path.length === 1 && path[0] === "documents";
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
        } else if (isObj(ov) && isObj(tv) && (container(ov) || container(tv) || isDocs)) v = object(bb, ov, tv, here, prefer, record);
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
    // Items in different documents on different sides (see the header) leave every document and
    // merge once, with their document as a field; then they go where the merge put them.
    const LB = locations(B), LO = locations(O), LT = locations(T), moved = new Map();
    for (const id of new Set([...LO.keys(), ...LT.keys(), ...LB.keys()])) {
      const at = {b: LB.get(id), o: LO.get(id), t: LT.get(id)};
      if (new Set([at.b, at.o, at.t].filter(Boolean).map(e => e.doc)).size > 1) moved.set(id, at);
    }
    const strip = P => !moved.size || !Array.isArray(P.documents) ? P : {...P, documents: P.documents.map(d =>
      isObj(d) && Array.isArray(d.items) && d.items.some(i => moved.has(i?.id)) ? {...d, items: d.items.filter(i => !moved.has(i?.id))} : d)};
    const project = object(strip(B), strip(O), strip(T), [], "ours", true);
    if (moved.size) placeMoved();
    // Moved items: merged once each, then placed. A move onto a document the other side deleted is a
    // conflict (deleted-ours/-theirs, field "document"): the deletion never silently sends the item
    // back. The project holds what each conflict keeps (ours), bringing back a deleted document with
    // only the items placed on it; `restore` carries each side's document for resolve().
    function placeMoved() {
      const docsOf = P => new Map((Array.isArray(P.documents) ? P.documents : []).filter(isObj).map(d => [d.id, d]));
      const DB = docsOf(B), DO = docsOf(O), DT = docsOf(T), merged = docsOf(project);
      // The side that deleted a document the other side still has (null: none did).
      const deletedBy = d => !DB.has(d) ? null : DO.has(d) && !DT.has(d) ? "theirs" : DT.has(d) && !DO.has(d) ? "ours" : null;
      const shell = (D, d) => D.has(d) ? clone({...D.get(d), items: []}) : undefined;
      const tag = e => e && [{...e.item, [DOC]: e.doc}];
      const placed = new Map(); // document id -> [{value, source, index}] for insertAll()
      for (const [id, at] of moved) {
        const home = (at.o || at.t || at.b).doc, firstConflict = conflicts.length, firstChange = changes.length;
        const [v] = collection(tag(at.b) || [], tag(at.o) || [], tag(at.t) || [], ["documents", {id: home}, "items"], "ours", true);
        let c = conflicts[firstConflict];
        if (!c && v && deletedBy(v[DOC])) {
          // Changed on one side only, onto a document the other side deleted.
          changes.length = firstChange;
          conflict(["documents", {id: home}, "items", {id}], tag(at.b)?.[0], at.o && tag(at.o)[0], at.t && tag(at.t)[0], [DOC],
            {...v, [DOC]: at.o?.doc}, {...v, [DOC]: at.t?.doc});
          c = conflicts[firstConflict];
          c.status = "deleted-" + deletedBy(v[DOC]);
        }
        // A conflict keeps ours; otherwise the merged value goes where its side put it.
        const keep = c ? c.ours : v, target = isObj(keep) ? keep[DOC] : null;
        if (target != null) {
          const value = c ? clone(keep) : keep, side = [[at.o, DO], [at.t, DT], [at.b, DB]].find(s => s[0]?.doc === target);
          delete value[DOC];
          if (!placed.has(target)) placed.set(target, []);
          placed.get(target).push(side ? {value, source: side[1].get(target)?.items || [], index: side[0].index} : {value, source: [], index: 0});
        }
        const path = ["documents", {id: target ?? home}, "items", {id}];
        for (const x of changes.slice(firstChange)) Object.assign(x, {path, ...owner(path)});
        if (!c) continue;
        const documents = {base: at.b?.doc, ours: c.ours?.[DOC], theirs: c.theirs?.[DOC]};
        for (const k of ["base", "ours", "theirs"]) if (isObj(c[k])) delete c[k][DOC];
        for (const k of ["ours", "theirs"]) if (isObj(c.sides[k])) delete c.sides[k][DOC];
        if (c.fields) c.fields = c.fields.map(f => f === DOC ? "document" : f);
        const restore = {};
        for (const [k, D] of [["ours", DO], ["theirs", DT]]) if (documents[k] != null && deletedBy(documents[k])) restore[k] = shell(D, documents[k]);
        Object.assign(c, {path, ...owner(path), documents}, Object.keys(restore).length ? {restore} : {});
      }
      for (const [d, list] of placed) {
        let doc = merged.get(d);
        if (!doc) {
          // A document the other side deleted, back for the items a conflict keeps on it.
          const D = DO.has(d) ? DO : DT;
          doc = shell(D, d);
          project.documents ||= [];
          const source = [...D.values()];
          project.documents.splice(slot(project.documents, source, source.indexOf(D.get(d))), 0, doc);
          merged.set(d, doc);
        }
        doc.items = insertAll(Array.isArray(doc.items) ? doc.items : [], list);
      }
    }
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
      if (c.documents) { resolveMoved(project, c, choice, copyIds); continue; }
      const path = c.path;
      if (choice === "ours") { put(project, path, clone(c.ours)); continue; }
      if (choice === "theirs") { put(project, path, clone(c.theirs)); continue; }
      if (choice === "both" && c.both) {
        const at = locate(project, path);
        if (!at) continue;
        let id = copyIds.get(c.id);
        if (!id) {
          id = globalThis.Atrium.id();
          copyIds.set(c.id, id);
        }
        put(project, path, clone(c.ours), copyOf(c.theirs, Array.isArray(at.parent) ? at.parent : [], id));
      }
    }
    // A document brought back only for moved items (see merge) goes again once none is left on it,
    // unless the document is a conflict of its own.
    const own = new Set(result.conflicts.filter(c => c.path.length === 2 && c.path[0] === "documents").map(c => c.path[1]?.id));
    const brought = new Set(result.conflicts.flatMap(c => Object.values(c.restore || {}).map(d => d?.id)).filter(id => id != null && !own.has(id)));
    if (brought.size && Array.isArray(project.documents)) project.documents = project.documents.filter(d => !(isObj(d) && brought.has(d.id) && !d.items?.length));
    return project;
  }
  // An item moved between documents leaves every other one, then sits where the chosen side put it
  // (on that side's document, brought back from `restore` if the merge left it out).
  function resolveMoved(project, c, choice, copyIds) {
    const docs = Array.isArray(project.documents) ? project.documents : (project.documents = []);
    const home = side => {
      const id = c.documents[side];
      if (id == null) return null;
      let d = docs.find(x => isObj(x) && x.id === id);
      if (!d && isObj(c.restore?.[side])) docs.push(d = clone(c.restore[side]));
      if (d && !Array.isArray(d.items)) d.items = [];
      return d || null;
    };
    const side = choice === "theirs" ? "theirs" : "ours", doc = home(side), value = c[side];
    for (const d of docs) if (isObj(d) && Array.isArray(d.items) && (d !== doc || value === undefined) && d.items.some(i => i?.id === c.objectId)) d.items = d.items.filter(i => i?.id !== c.objectId);
    if (!doc || value === undefined) return;
    put(project, ["documents", {id: doc.id}, "items", {id: c.objectId}], clone(value));
    if (choice !== "both" || !c.both) return;
    let id = copyIds.get(c.id);
    if (!id) { id = globalThis.Atrium.id(); copyIds.set(c.id, id); }
    const other = home("theirs");
    if (!other) return;
    const copy = copyOf(c.theirs, other.items, id);
    if (other === doc) put(project, ["documents", {id: doc.id}, "items", {id: c.objectId}], clone(value), copy);
    else other.items.push(copy);
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
