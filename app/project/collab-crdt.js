"use strict";
// AtriumCollabCRDT: the operation-based CRDT behind real-time co-editing (docs/collaboration.md).
// DOM-free and transport-free: tests run it under JavaScriptCore, the live session
// (collab-presence.js) feeds it local edits and remote operations.
//
// Model. Every document, library definition and board/schematic item already has a stable,
// unique id (model.js validate() enforces it), so the project maps onto a set of objects:
//
//   * objects      an add-wins set keyed by id. An object is visible while it has an add tag that
//                  no active remove has observed. Personal undo withdraws only its author's tag
//                  or deletion. Other users' changes can keep a withdrawn creation in use.
//   * properties   one last-writer-wins register per top-level property of an object, ordered by
//                  (Lamport clock, replica id). Values are whole JSON values. A personal undo
//                  rewinds one author's contribution without raising the priority of its value.
//   * sequences    "points" (track, wire, polygon, graphic and bus vertices) is a replicated
//                  growable array (RGA): each vertex has its own id, inserts go after a named
//                  vertex, deletes leave tombstones and a vertex's value is its own LWW register.
//   * order        documents, library definitions and the items of a document are ordered by a
//                  fractional index (an LWW "pos" register; ties broken by id).
//   * project      other top-level project keys (name, rules, review, …) are LWW registers.
//
// Every operation is commutative and idempotent once its dependencies are present; an insert
// whose predecessor has not arrived yet waits in a buffer. So any delivery order of the same
// set of operations gives the same project, which tests/collab-crdt.cjs checks with randomised
// edits on three replicas.
//
//   const r = AtriumCollabCRDT.create({replica: "alice", project})   // or {replica, snapshot}
//   const batch = r.commit(editedProject)    // local edit -> {ops} (applied locally); null if none
//   const res = r.receive(batch)             // remote ops, validated as untrusted input
//   r.project()                              // materialised project (model-valid objects only)
//   r.patch(target, res.touched)             // update an editor project in place
//   r.undo() / r.redo()                      // per-user: only this replica's own operations
//   r.snapshot(), r.vv(), r.since(vv)        // sync on (re)connect; bounded log + snapshots
//
// Authorship. A live batch is received with {author}: every operation must carry that replica id,
// which the session has verified against the sending connection (collab-transport.js), so nobody
// can write in someone else's name or withdraw someone else's edits with "undo". Add tags and
// element ids are derived from the stamp, never chosen. Counters are bounded: a Lamport clock may
// run at most LIMITS.skew ahead of ours, a sequence number at most LIMITS.gap past what we hold,
// nothing may claim edits by this replica that it never made, a session admits LIMITS.authors
// replicas and a register keeps the newest LIMITS.writers contributions (a deterministic cut, so
// every replica keeps the same ones).
globalThis.AtriumCollabCRDT = (() => {
  const LIB = "#library", DOCS = "#documents", COMPAT = "atriumCompat", FORMAT_KEYS = new Set(["format", "formatVersion", "version", "compatibleWith"]);
  const maxAuthors = 256;
  const LIMITS = Object.freeze({ops: 20000, value: 1 << 20, depth: 24, id: 128, key: 64, log: 4000, points: 100000, undo: 200,
    authors: maxAuthors, writers: maxAuthors + 1, clock: 2 ** 48, skew: 1e6, gap: 40000, objects: 2e6});
  const DIG = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  const KEY = /^[A-Za-z0-9_$][A-Za-z0-9_$.-]{0,63}$/, BAD_KEYS = new Set(["__proto__", "constructor", "prototype"]);
  const ID = /^[\x21-\x7e]{1,128}$/;
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);

  // ------------------------------------------------------------------ values
  // Canonical JSON (sorted keys): equality of values across replicas.
  function canon(v) {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return "[" + v.map(canon).join(",") + "]";
    const keys = Object.keys(v).filter(k => v[k] !== undefined).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}";
  }
  function clone(v) {
    if (v == null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") return Number.isFinite(v) ? v || 0 : null;
    return JSON.parse(JSON.stringify(v));
  }
  // Table projection values have already entered the ledger as JSON data.
  // Copy them without writing out and reading back each cell's JSON text.
  function copyProjectedJSON(value) {
    if (typeof value === "number") return Number.isFinite(value) ? value || 0 : null;
    if (value == null || typeof value !== "object") return value;
    if (Array.isArray(value)) return Array.from(value, entry => entry === undefined ? null : copyProjectedJSON(entry));
    const out = {...value};
    for (const key of Object.keys(out)) {
      const entry = out[key];
      if (entry === undefined) delete out[key];
      else if (typeof entry === "number" || entry !== null && typeof entry === "object") out[key] = copyProjectedJSON(entry);
    }
    return out;
  }
  // Untrusted JSON values: plain data, finite numbers, bounded depth, no prototype keys.
  function cleanValue(v, depth = 0) {
    if (depth > LIMITS.depth) throw Error("value too deep");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number") { if (!Number.isFinite(v)) throw Error("number"); return v; }
    if (Array.isArray(v)) return v.map(x => cleanValue(x, depth + 1));
    if (isObj(v)) {
      const o = {};
      for (const k of Object.keys(v)) { if (BAD_KEYS.has(k)) throw Error("key"); o[k] = cleanValue(v[k], depth + 1); }
      return o;
    }
    throw Error("value type");
  }

  // ------------------------------------------------------------------ clocks
  // ts = {c: Lamport counter, r: replica id}; total order, replica id breaks ties.
  const cmp = (a, b) => a.c - b.c || (a.r < b.r ? -1 : a.r > b.r ? 1 : 0);
  const newer = (a, b) => !b || cmp(a, b) > 0;
  const seed = {c: 0, r: "~"};

  // Keep the newest contribution per author only on contested or rewound registers.
  // 'at' ranks the original edit; 'c' orders that author's writes and undo commands.
  // Undo rewinds one contribution, so even an edit still in flight can win on arrival.
  function contribution(reg, who) {
    if (reg?.writers) return reg.writers.find(w => w.r === who);
    return reg?.ts?.r === who ? {r: who, c: reg.ts.c, at: reg.ts.c, v: reg.v} : null;
  }
  const newestFirst = (a, b) => b.c - a.c || (a.r < b.r ? 1 : a.r > b.r ? -1 : 0);
  function fromWriters(writers) {
    // Keep every admitted author and the seeded value, even after the other edits are withdrawn.
    writers = [...writers].sort(newestFirst);
    if (writers.length > LIMITS.writers) writers.length = LIMITS.writers;
    let best;
    for (const w of writers) if (w.at !== null && (!best || w.at > best.at || (w.at === best.at && w.r > best.r))) best = w;
    return {v: best?.v, ts: best ? {r: best.r, c: best.at} : seed, writers};
  }
  function writeReg(reg, v, ts, at = ts.c) {
    if (!reg?.writers && at === ts.c && (!reg || reg.ts.r === ts.r)) {
      return !reg || newer(ts, reg.ts) ? {v, ts} : reg;
    }
    const previous = reg?.writers || (reg && reg.ts.c >= 0 ? [contribution(reg, reg.ts.r)] : []);
    const i = previous.findIndex(w => w.r === ts.r);
    if (i >= 0 && previous[i].c >= ts.c) return reg;
    const writers = [...previous];
    const w = {r: ts.r, c: ts.c, at, v};
    if (i < 0) writers.push(w); else writers[i] = w;
    return fromWriters(writers);
  }
  function joinReg(local, other) {
    if (!local) return other;
    if (!other.writers) return writeReg(local, other.v, other.ts);
    const byAuthor = new Map();
    for (const w of local.writers || (local.ts.c >= 0 ? [contribution(local, local.ts.r)] : [])) byAuthor.set(w.r, w);
    for (const w of other.writers) if ((byAuthor.get(w.r)?.c ?? -1) < w.c) byAuthor.set(w.r, w);
    return fromWriters([...byAuthor.values()]);
  }
  // Deletion is the union of independent authors' cuts. Undo removes only one
  // author's cut. 'fixed' preserves a tombstone imported from an older snapshot.
  function markDeletion(map, key, ts, on, fixed) {
    let entry = map.get(key) || {fixed, writers: []};
    const i = entry.writers.findIndex(w => w.r === ts.r);
    if (i < 0 || ts.c > entry.writers[i].c) {
      let writers = [...entry.writers]; writers[i < 0 ? writers.length : i] = {r: ts.r, c: ts.c, on};
      if (writers.length > LIMITS.writers) writers = writers.sort(newestFirst).slice(0, LIMITS.writers);
      entry = {fixed: entry.fixed, writers}; map.set(key, entry);
    }
    return entry.fixed || entry.writers.some(w => w.on);
  }
  function markCreation(map, key, ts, at, on) {
    if (ts.c > (map.get(key)?.c ?? -1)) map.set(key, {r: ts.r, c: ts.c, at, on});
  }

  // ------------------------------------------------------------------ fractional index
  // A key strictly between a ("" = start) and b (null = end). Keys never end in "0".
  function between(a, b) {
    a = a || ""; let out = "";
    for (let i = 0; ; i++) {
      const da = i < a.length ? DIG.indexOf(a[i]) : 0;
      const db = b != null ? (i < b.length ? DIG.indexOf(b[i]) : 0) : 62;
      if (db - da > 1) return out + DIG[(da + db) >> 1];
      out += DIG[da];
      if (db > da) b = null;
    }
  }
  // n evenly spaced keys (the initial order of a loaded project).
  function spread(n) {
    let w = 1; while (Math.pow(62, w) < (n + 2) * 4) w++;
    const step = Math.floor(Math.pow(62, w) / (n + 1)), keys = [];
    for (let i = 1; i <= n; i++) {
      let x = i * step, s = "";
      for (let k = 0; k < w; k++) { s = DIG[x % 62] + s; x = Math.floor(x / 62); }
      keys.push(s.replace(/0+$/, "") || "V");
    }
    return keys;
  }
  const byPos = (a, b) => (a.pos.v < b.pos.v ? -1 : a.pos.v > b.pos.v ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

  // ------------------------------------------------------------------ sequences (RGA)
  // Element ids "c.r.i"; siblings after the same predecessor: newest first.
  function newSeq() { return {elems: new Map(), kids: new Map(), waiting: new Map(), tomb: new Set(), early: new Map()}; }
  function elemKey(id) { const p = id.split("."); return {c: +p[0], r: p.slice(1, -1).join("."), i: +p.at(-1)}; }
  function sibling(a, b) { const x = elemKey(a), y = elemKey(b); return y.c - x.c || (y.r < x.r ? -1 : y.r > x.r ? 1 : 0) || y.i - x.i; }
  function attachVertex(s, parent, id, v, ts, state) {
    const existing = s.elems.get(id);
    if (existing) {
      if (state) {
        const reg = joinReg({v: existing.v, ts: existing.vts, writers: existing.writers}, state);
        existing.v = reg.v; existing.vts = reg.ts; existing.writers = reg.writers;
      }
      return;
    }
    const early = s.early.get(id);
    const reg = early ? joinReg(early, state || {v, ts}) : state || {v, ts};
    const e = {id, after: parent, v: reg.v, vts: reg.ts, del: s.tomb.has(id)};
    if (reg.writers) e.writers = reg.writers;
    s.early.delete(id);
    s.elems.set(id, e);
    const list = s.kids.get(parent) || [];
    let i = 0; while (i < list.length && sibling(list[i], id) < 0) i++;
    list.splice(i, 0, id); s.kids.set(parent, list);
    const waiting = s.waiting.get(id);
    if (waiting) s.waiting.delete(id);
    return waiting;
  }
  function seqInsert(s, after, id, v, ts, state) {
    if (after != null && !s.elems.has(after) && !s.elems.has(id)) {
      if (!s.waiting.has(after)) s.waiting.set(after, new Map());
      const waiting = s.waiting.get(after), existing = waiting.get(id);
      if (!existing) waiting.set(id, state ? [id, v, ts, state] : [id, v, ts]);
      else if (state) waiting.set(id, [id, v, ts, joinReg(existing[3] || {v: existing[1], ts: existing[2]}, state)]);
      return false;
    }
    const waiting = attachVertex(s, after ?? "^", id, v, ts, state);
    if (waiting) {
      const ready = [...waiting.values()].map(w => [id, w]);
      while (ready.length) {
        const [parent, child] = ready.pop(), children = attachVertex(s, parent, ...child);
        if (children) for (const w of children.values()) ready.push([child[0], w]);
      }
    }
    return true;
  }
  function seqDelete(s, id, ts, on = true) {
    const e = s.elems.get(id);
    const deleted = ts ? markDeletion(s.cuts ||= new Map(), id, ts, on, !!e?.del || s.tomb.has(id)) : true;
    if (deleted) s.tomb.add(id); else s.tomb.delete(id);
    if (e) e.del = deleted;
  }
  function seqSet(s, id, v, ts, at = ts.c) {
    const e = s.elems.get(id);
    if (!e) { s.early.set(id, writeReg(s.early.get(id), v, ts, at)); return; }
    const reg = writeReg({v: e.v, ts: e.vts, writers: e.writers}, v, ts, at);
    e.v = reg.v; e.vts = reg.ts; e.writers = reg.writers;
  }
  function vertexVisible(s, e) {
    if (e.del) return false;
    const mask = s.creations?.get(e.id);
    return !mask || mask.on || e.vts.r !== mask.r || !!e.writers?.some(w => w.r !== mask.r && w.at !== null);
  }
  // Visible elements in order: [{id, v}].
  function seqList(s, minimum = 0, retained) {
    const out = [], stack = [...(s.kids.get("^") || [])].reverse();
    const spare = s.creations && minimum ? [] : null;
    while (stack.length) {
      const id = stack.pop(), e = s.elems.get(id);
      if (vertexVisible(s, e)) out.push(e);
      else if (!e.del && spare && spare.length < minimum) spare.push([out.length, e]);
      const k = s.kids.get(id);
      if (k) for (let i = k.length - 1; i >= 0; i--) stack.push(k[i]);
    }
    // Another author may have removed an old corner after this one was added.
    // Keep enough withdrawn corners to avoid hiding that person's entire path.
    if (spare) for (let i = Math.min(spare.length, minimum - out.length) - 1; i >= 0; i--) {
      out.splice(spare[i][0], 0, spare[i][1]);
      if (retained) retained.push(spare[i][1].id);
    }
    return out;
  }
  // Edit script from the visible elements to a new array of values: matched runs by LCS, and
  // a delete next to an insert becomes a value update (a moved vertex keeps its id).
  function seqEdits(list, values) {
    const a = list.map(e => canon(e.v)), b = values.map(canon), n = a.length, m = b.length, edits = [];
    let pre = 0; while (pre < n && pre < m && a[pre] === b[pre]) pre++;
    let suf = 0; while (suf < n - pre && suf < m - pre && a[n - 1 - suf] === b[m - 1 - suf]) suf++;
    const A = a.slice(pre, n - suf), B = b.slice(pre, m - suf), script = [];
    if (A.length * B.length <= 4e6) {
      const W = B.length + 1, L = new Uint32Array((A.length + 1) * W);
      for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--)
        L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      let i = 0, j = 0;
      while (i < A.length || j < B.length) {
        if (i < A.length && j < B.length && A[i] === B[j]) { script.push(["=", i++, j++]); }
        else if (j < B.length && (i >= A.length || L[i * W + j + 1] >= L[(i + 1) * W + j])) script.push(["+", i, j++]);
        else script.push(["-", i++, j]);
      }
    } else { for (let i = 0; i < A.length; i++) script.push(["-", i, 0]); for (let j = 0; j < B.length; j++) script.push(["+", A.length, j]); }
    // Pair deletes and inserts inside each gap as value updates.
    let prev = pre ? list[pre - 1].id : null, k = 0;
    while (k < script.length) {
      if (script[k][0] === "=") { prev = list[pre + script[k][1]].id; k++; continue; }
      const dels = [], ins = [];
      while (k < script.length && script[k][0] !== "=") { (script[k][0] === "-" ? dels : ins).push(script[k]); k++; }
      const pairs = Math.min(dels.length, ins.length);
      for (let p = 0; p < pairs; p++) { const e = list[pre + dels[p][1]]; edits.push({t: "pset", e: e.id, v: values[pre + ins[p][2]]}); prev = e.id; }
      for (let p = pairs; p < dels.length; p++) edits.push({t: "del", e: list[pre + dels[p][1]].id});
      for (let p = pairs; p < ins.length; p++) { const at = {t: "ins", after: prev, v: values[pre + ins[p][2]]}; edits.push(at); prev = at; }
    }
    return edits;
  }

  // ------------------------------------------------------------------ operation checks
  // Remote operations are untrusted: exact shapes, bounded sizes, safe keys and ids.
  function checkTs(ts) { if (!isObj(ts) || !Number.isSafeInteger(ts.c) || ts.c < 0 || ts.c > LIMITS.clock || typeof ts.r !== "string" || !ID.test(ts.r)) throw Error("op clock"); }
  // Review IDs use a different reserved prefix from widget rows and ordinary
  // design objects. The native review.records map and its reply IDs remain portable.
  const REVIEW = "\x1e", reviewId = id => typeof id === "string" && /^[\w-]{1,80}$/.test(id) && !BAD_KEYS.has(id);
  const isReviewRow = id => typeof id === "string" && id[0] === REVIEW && reviewId(id.slice(1));
  const reviewOperation = op => isReviewRow(op?.o) || (op?.t === "meta" || op?.a === "meta") && op.k === "review";
  function reviewRows(review) {
    if (review === undefined) return [];
    if (!isObj(review) || review.version !== 1 || !isObj(review.records)) return null;
    const ids = Object.keys(review.records).sort();
    if (ids.some(id => !reviewId(id) || !isObj(review.records[id]) || review.records[id].id !== id)) return null;
    return ids.map(id => {
      const row = {...review.records[id], id: REVIEW + id};
      if (row.type === "thread") {
        row.status = {value: row.status, ...(own(row, "resolved") && {resolved: row.resolved})};
        delete row.resolved;
      }
      return row;
    });
  }
  const reviewHead = review => review && {...review, records: {}};
  function nativeReviewRow(row) {
    row.id = row.id.slice(1);
    if (row.type === "thread" && isObj(row.status)) {
      const status = row.status; row.status = status.value;
      if (own(status, "resolved")) row.resolved = status.resolved;
    }
    return row;
  }
  // Widget lists use the same observed-remove sets, positions and property registers as sheet items.
  // The unit separator is outside the user-ID alphabet and cannot alias an item, a replica or a tag.
  const sep = "\x1f", propertyPrefix = "$widget.prop.", listPrefix = "$widget.list.";
  const listParent = (owner, key) => sep + owner + sep + key;
  function widgetPath(id) {
    if (typeof id !== "string" || id[0] !== sep) return null;
    const p = id.split(sep);
    return (p.length === 3 || p.length === 4) && ID.test(p[1]) && KEY.test(p[2]) && !BAD_KEYS.has(p[2]) &&
      (p.length === 3 || ID.test(p[3])) ? p : null;
  }
  const operationTarget = op => reviewOperation(op) ? "#meta" : widgetPath(op.o)?.[1] || op.o;
  const fullTable = o => o?.kind === "textframe" && o.widget?.type === "table" && o.widget.state?.tableVersion === 1;
  const cellIdentity = ({id, rowId, columnId}) => ({id, rowId, columnId});
  function checkId(v, what) {
    if (typeof v === "string" && ID.test(v)) return;
    if (what === "object" && isReviewRow(v) || ["parent","location"].includes(what) && v === REVIEW) return;
    const p = widgetPath(v);
    if (p && (what === "object" && p.length === 4 || ["parent","location"].includes(what) && p.length === 3)) return;
    throw Error("op " + what);
  }
  function widgetLists(o) {
    if (o?.kind !== "textframe" || !isObj(o.widget?.state) || widgetPath(o.id)) return [];
    return Object.entries(o.widget.state).filter(([,v])=>Array.isArray(v) && v.every(r=>isObj(r) && typeof r.id==="string" && ID.test(r.id)));
  }
  function widgetRegisters(o) {
    if (o.kind !== "textframe" || !isObj(o.widget?.state) || widgetPath(o.id)) return o;
    const out = {...o,widget:{...o.widget,state:{}}}, lists = new Set(widgetLists(o).map(([k])=>k));
    for (const [k,v] of Object.entries(o.widget.state)) {
      if (lists.has(k)) out[listPrefix+k] = true;
      else out[propertyPrefix+k] = v;
    }
    return out;
  }
  const virtualRows = (parent, rows) => rows.map(r=>({...r,id:parent+sep+r.id}));
  const checkKey = k => { if (typeof k !== "string" || !KEY.test(k) || BAD_KEYS.has(k)) throw Error("op key"); };
  const checkElem = e => { if (typeof e !== "string" || !/^\d{1,15}\.[\x21-\x7e]{1,128}\.\d{1,6}$/.test(e)) throw Error("op element"); };
  const isRank = (n, max) => n === null || (Number.isSafeInteger(n) && n >= 0 && n <= max);
  const registerKinds = new Set(["meta", "set", "pos", "pset"]);
  function checkUndo(op) {
    if (!Number.isSafeInteger(op.at) || op.at < 1 || op.at >= op.ts.c || typeof op.on !== "boolean") throw Error("undo target");
    if (op.a !== "meta") checkId(op.o, "object");
    if (["meta", "set", "pset", "ins", "del"].includes(op.a)) checkKey(op.k);
    if (op.a === "meta" && ["documents", "library"].includes(op.k) || op.a === "set" && ["id", "items"].includes(op.k)) throw Error("op key");
    if (["pset", "ins", "del"].includes(op.a)) checkElem(op.e);
    if (registerKinds.has(op.a)) {
      if (!isRank(op.rank, op.at) || (op.on && op.rank !== op.at)) throw Error("undo rank");
      if (op.a === "pos" && op.rank !== null && (typeof op.v !== "string" || !/^[0-9A-Za-z]{1,64}$/.test(op.v))) throw Error("op pos");
    } else if (op.a === "rem") {
      if (!Array.isArray(op.tags) || op.tags.length > 64) throw Error("op tags");
      op.tags.forEach(t => checkId(t, "tag"));
    } else if (op.a === "ins") {
      if (op.e !== op.at + "." + op.ts.r + ".0") throw Error("undo author");
    } else if (op.a === "add") {
      if (op.move) {
        for (const key of ["p", "pos"]) {
          const r = op.move[key];
          if (!isObj(r) || !isRank(r.at, op.at)) throw Error("undo location");
          if (r.at !== null) checkId(r.v, "location");
        }
      }
    } else if (op.a !== "del") throw Error("undo kind");
  }
  function checkOp(op) {
    if (!isObj(op)) throw Error("op");
    checkTs(op.ts);
    if (!Number.isSafeInteger(op.n) || op.n < 1) throw Error("op sequence");
    switch (op.t) {
      case "undo": checkUndo(op); break;
      case "meta": checkKey(op.k); if (op.k === "documents" || op.k === "library") throw Error("op key"); break;
      case "add":
        checkId(op.o, "object"); checkId(op.tag, "tag");
        if (op.tag !== op.ts.c + "@" + op.ts.r) throw Error("op tag");
        if (op.p != null) {
          checkId(op.p, "parent");
          if (isReviewRow(op.o) !== (op.p === REVIEW)) throw Error("op review parent");
          const row = widgetPath(op.o);
          if (row ? row.slice(0,3).join(sep) !== op.p : widgetPath(op.p)) throw Error("op widget parent");
        }
        if (op.f != null) { if (!isObj(op.f)) throw Error("op fields"); for (const k of Object.keys(op.f)) checkKey(k); }
        if (op.s != null) { if (!isObj(op.s)) throw Error("op sequences"); for (const k of Object.keys(op.s)) { checkKey(k); if (!Array.isArray(op.s[k]) || op.s[k].length > LIMITS.points) throw Error("op points"); } }
        if (op.pos != null && (typeof op.pos !== "string" || !/^[0-9A-Za-z]{1,64}$/.test(op.pos))) throw Error("op pos");
        break;
      case "rem": checkId(op.o, "object"); if (!Array.isArray(op.tags) || op.tags.length > 64) throw Error("op tags"); op.tags.forEach(t => checkId(t, "tag")); break;
      case "set": checkId(op.o, "object"); checkKey(op.k); if (op.k === "id" || op.k === "items") throw Error("op key"); break;
      case "pos": checkId(op.o, "object"); if (typeof op.v !== "string" || !/^[0-9A-Za-z]{1,64}$/.test(op.v)) throw Error("op pos"); break;
      case "ins": checkId(op.o, "object"); checkKey(op.k); checkElem(op.e); if (op.after != null) checkElem(op.after);
        if (op.e !== op.ts.c + "." + op.ts.r + ".0") throw Error("op element"); break;
      case "del": case "pset": checkId(op.o, "object"); checkKey(op.k); checkElem(op.e); break;
      default: throw Error("op type");
    }
    if (own(op, "v")) op.v = cleanValue(op.v);
    if (op.f) op.f = cleanValue(op.f);
    if (op.s) op.s = cleanValue(op.s);
    return op;
  }

  // ------------------------------------------------------------------ replica
  function create(o = {}) {
    const replica = String(o.replica || ("r" + Math.random().toString(36).slice(2, 10)));
    if (!ID.test(replica) || replica.includes(".")) throw Error("A replica id is 1–128 printable characters without dots.");
    const validate = o.validate !== undefined ? o.validate : (p => globalThis.Atrium?.validate?.(p));
    // o.owner: the replica id allowed to change the format stamp (FORMAT_KEYS). o.ownSeq: how many
    // edits this replica id made before (a rejoin in the same window); a snapshot may show up to that many.
    const owner = typeof o.owner === "string" ? o.owner : undefined, ownSeq = Number.isSafeInteger(o.ownSeq) && o.ownSeq > 0 ? o.ownSeq : 0;
    let clock = 0, seqNo = 0;
    const objs = new Map(), kids = new Map(), meta = new Map();
    const vv = new Map(), extra = new Set(), floor = new Map();
    const cellPatchHints = new WeakMap();
    let log = [], undoStack = [], redoStack = [], view = null, verdicts = new Map();
    const stats = {applied: 0, rejected: 0, buffered: 0, filtered: 0};

    function obj(id) {
      let x = objs.get(id);
      if (!x) { x = {id, parent: null, pts: null, tags: new Set(), tomb: new Set(), f: new Map(), seqs: new Map(), pos: {v: "V", ts: {c: -1, r: ""}}, ver: 0}; objs.set(id, x); }
      return x;
    }
    let referencedDefs;
    const conditionalContainers = new Set(), conditionalPaths = new Set(), constrainedTables = new Set();
    // Retain a withdrawn creation when someone else built on it. Two distinct
    // authors' latest edits suffice to answer this for any individual creator.
    function noteEdit(x, ts) {
      const edits = x.edits ||= [];
      const old = edits.find(e => e.r === ts.r);
      if (old && old.c >= ts.c) return;
      if (old) edits.splice(edits.indexOf(old), 1);
      edits.push(ts);
      edits.sort((a, b) => cmp(b, a));
      if (edits.length > 2) edits.pop();
    }
    function directlyVisible(x) {
      for (const t of x.tags) {
        if (x.tomb.has(t)) continue;
        const mask = x.creations?.get(t);
        if (!mask || mask.on || x.edits?.some(e => e.r !== mask.r)) return true;
      }
      return false;
    }
    function references() {
      if (referencedDefs) return referencedDefs;
      referencedDefs = new Map();
      function use(id, kind) {
        if (!id) return;
        if (!referencedDefs.has(id)) referencedDefs.set(id, new Set());
        referencedDefs.get(id).add(kind);
      }
      for (const x of objs.values()) {
        if (!directlyVisible(x)) continue;
        if (x.parent === LIB) use(x.f.get("mirrorOf")?.v, "mirror");
        else if (x.f.get("kind")?.v === "part") use(x.f.get("def")?.v, objs.get(x.parent)?.f.get("kind")?.v);
      }
      // A retained mirror may itself use a mirrored definition.
      for (const id of referencedDefs.keys()) use(objs.get(id)?.f.get("mirrorOf")?.v, "mirror");
      return referencedDefs;
    }
    function visible(x) {
      if (directlyVisible(x)) return true;
      if (!x.creations || ![...x.creations].some(([t, m]) => !m.on && x.tags.has(t) && !x.tomb.has(t))) return false;
      if (x.parent === DOCS) {
        for (const id of kids.get(x.id) || []) if (directlyVisible(objs.get(id))) return true;
      } else if (x.parent === LIB) return references().has(x.id);
      return false;
    }
    const geometryField = k => k === "symbol" || k === "footprint";
    function rememberGeometry(x, k, v, ts) {
      if (!geometryField(k) || !isObj(v) || !newer(ts, x.geometry?.get(k)?.ts)) return;
      (x.geometry ||= new Map()).set(k, {v, ts});
    }
    function fieldValue(x, k, reg) {
      // An added symbol or footprint may now be in use by a collaborator's part.
      if (!reg.v && x.parent === LIB && geometryField(k) && x.geometry?.has(k) &&
          reg.writers?.some(w => w.at !== w.c) && references().get(x.id)?.has(k === "symbol" ? "schematic" : "pcb"))
        return x.geometry.get(k).v;
      return reg.v;
    }
    // Undo can make a document, symbol or corner visible only while other work
    // needs it. Patch that dependency when a later edit changes its projection.
    function trackContainer(x) {
      if (x.parent !== DOCS && x.parent !== LIB && !conditionalContainers.has(x.id)) return;
      const withheld = x.creations && [...x.creations].some(([t, m]) => !m.on && x.tags.has(t) && !x.tomb.has(t));
      const geometry = x.geometry && [...x.geometry.keys()].some(k => !x.f.get(k)?.v && x.f.get(k)?.writers?.some(w => w.at !== w.c));
      if (withheld || geometry) conditionalContainers.add(x.id); else conditionalContainers.delete(x.id);
    }
    function trackPath(x) {
      const masks = x.seqs.get("points")?.creations;
      if (masks && [...masks.values()].some(m => !m.on)) conditionalPaths.add(x.id); else conditionalPaths.delete(x.id);
    }
    function dependencyState(id) {
      const x = objs.get(id), result = [visible(x)];
      if (x.parent === LIB) for (const k of ["symbol", "footprint"]) {
        const r = x.f.get(k); result.push(r && fieldValue(x, k, r));
      }
      if (conditionalPaths.has(id)) seqList(x.seqs.get("points"), minPoints(x, "points"), result);
      return result;
    }
    function dependenciesBefore(ops) {
      if (!conditionalContainers.size && !conditionalPaths.size) return null;
      const ids = new Set();
      let definitions = false;
      for (const op of ops) {
        const x = objs.get(op.o), kind = op.t === "undo" ? op.a : op.t;
        if (conditionalPaths.has(op.o)) ids.add(op.o);
        for (const id of [op.o, x?.parent, op.p, op.move?.p?.v, x?.f.get("def")?.v]) if (conditionalContainers.has(id)) ids.add(id);
        if (kind === "add" || kind === "rem" || kind === "set" && ["kind", "def", "mirrorOf"].includes(op.k)) definitions = true;
      }
      if (definitions) for (const id of conditionalContainers) if (objs.get(id).parent === LIB) ids.add(id);
      return new Map([...ids].map(id => [id, dependencyState(id)]));
    }
    function changedDependencies(before) {
      const ids = [];
      if (before) for (const [id, was] of before) {
        const now = dependencyState(id);
        if (now.length !== was.length || now.some((v, i) => v !== was[i])) ids.push(id);
      }
      return ids;
    }
    // The parent (a document, the library or the document list) is an LWW register too: an
    // object moved to another document is re-added there.
    function link(x, parent, ts, at = ts.c) {
      const location = writeReg(x.pts && {v: x.parent, ts: x.pts, writers: x.locations}, parent, ts, at);
      setLocation(x, location);
    }
    function setLocation(x, location) {
      x.pts = location.ts; x.locations = location.writers;
      if (x.parent === location.v) return;
      if (x.parent) kids.get(x.parent)?.delete(x.id);
      x.parent = location.v;
      if (x.parent) {
        if (!kids.has(x.parent)) kids.set(x.parent, new Set());
        kids.get(x.parent).add(x.id);
      }
    }
    function seqOf(x, k) { let s = x.seqs.get(k); if (!s) { s = newSeq(); x.seqs.set(k, s); } return s; }
    const seen = (r, n) => (vv.get(r) || 0) >= n || extra.has(r + ":" + n);
    function mark(r, n) {
      if ((vv.get(r) || 0) + 1 === n) {
        extra.delete(r + ":" + n);
        let m = n; vv.set(r, m);
        while (extra.has(r + ":" + (m + 1))) { extra.delete(r + ":" + (m + 1)); vv.set(r, ++m); }
      } else extra.add(r + ":" + n);
    }

    // Applies one checked operation (local or remote). Returns the touched object id.
    function apply(op) {
      if (seen(op.ts.r, op.n)) return null;
      mark(op.ts.r, op.n);
      clock = Math.max(clock, op.ts.c);
      log.push(op); stats.applied++;
      const rewind = op.t === "undo", kind = rewind ? op.a : op.t;
      const rank = rewind ? op.rank : op.ts.c;
      if (kind === "meta") {
        // The file's format stamp belongs to the session's owner (the host): anyone else's change of it
        // is counted as seen and has no effect, the same on every replica (security review N4).
        if (FORMAT_KEYS.has(op.k) && owner !== undefined && op.ts.r !== owner) { stats.filtered++; return null; }
        meta.set(op.k, writeReg(meta.get(op.k), op.v, op.ts, rank)); return "#meta";
      }
      const x = obj(op.o); x.ver++;
      referencedDefs = null;
      if (!rewind && kind !== "add" && kind !== "rem") noteEdit(x, op.ts);
      switch (kind) {
        case "add":
          if (rewind) {
            markCreation(x.creations ||= new Map(), op.at + "@" + op.ts.r, op.ts, op.at, op.on);
            if (op.move) {
              link(x, op.move.p.v, op.ts, op.move.p.at);
              x.pos = writeReg(x.pos, op.move.pos.v, op.ts, op.move.pos.at);
            }
            break;
          }
          if (op.p) link(x, op.p, op.ts);
          x.tags.add(op.tag);
          if (op.pos) x.pos = writeReg(x.pos, op.pos, op.ts);
          if (op.f) for (const [k, v] of Object.entries(op.f)) {
            x.f.set(k, writeReg(x.f.get(k), v, op.ts)); rememberGeometry(x, k, v, op.ts);
          }
          if (op.s) for (const [k, list] of Object.entries(op.s)) {
            const s = seqOf(x, k);
            list.forEach((v, i) => seqInsert(s, i ? op.ts.c + "." + op.ts.r + "." + (i - 1) : null, op.ts.c + "." + op.ts.r + "." + i, v, op.ts));
          }
          break;
        case "rem":
          for (const t of op.tags) {
            if (markDeletion(x.cuts ||= new Map(), t, op.ts, rewind ? op.on : true, x.tomb.has(t))) x.tomb.add(t);
            else x.tomb.delete(t);
          }
          break;
        case "set":
          x.f.set(op.k, writeReg(x.f.get(op.k), op.v, op.ts, rank));
          if (!rewind) rememberGeometry(x, op.k, op.v, op.ts);
          break;
        case "pos": x.pos = writeReg(x.pos, op.v, op.ts, rank); break;
        case "ins": {
          const s = seqOf(x, op.k);
          if (rewind) markCreation(s.creations ||= new Map(), op.e, op.ts, op.at, op.on);
          else if (!seqInsert(s, op.after ?? null, op.e, op.v, op.ts)) stats.buffered++;
          break;
        }
        case "del": seqDelete(seqOf(x, op.k), op.e, op.ts, rewind ? op.on : true); break;
        case "pset": seqSet(seqOf(x, op.k), op.e, op.v, op.ts, rank); break;
      }
      if (kind === "add" || kind === "rem" || kind === "set" && geometryField(op.k)) trackContainer(x);
      if (rewind && kind === "ins" && op.k === "points") trackPath(x);
      if (isReviewRow(x.id)) return "#meta";
      const path = widgetPath(x.id);
      if (path) {
        const widget = obj(path[1]); widget.ver++;
        if (!rewind) noteEdit(widget,op.ts);
        return widget.id;
      }
      return x.id;
    }

    // ---- materialise -------------------------------------------------------------------
    const minPoints = (x, k) => k === "points" ? x.f.get("kind")?.v === "polygon" ? 3 : 2 : 0;
    function nodeFields(x, copyValue) {
      const out = {id: x.id};
      for (const [k, r] of x.f) { const v = fieldValue(x, k, r); if (v !== undefined) out[k] = copyValue(v); }
      // The common RGA value is a pair of numbers. Detach its array without
      // encoding an entire JSON string for each vertex of every wire/track.
      for (const [k, s] of x.seqs) out[k] = seqList(s, minPoints(x, k)).map(({v}) =>
        Array.isArray(v) && v.length === 2 && Number.isFinite(v[0]) && Number.isFinite(v[1]) ? [v[0] || 0, v[1] || 0] : clone(v));
      return out;
    }
    function fields(x, tableOwner) {
      const out = nodeFields(x, clone);
      if (out.kind === "textframe" && isObj(out.widget?.state) && !widgetPath(x.id)) {
        for (const k of Object.keys(out)) {
          if (k.startsWith(propertyPrefix)) {out.widget.state[k.slice(propertyPrefix.length)] = out[k]; delete out[k];}
          if (k.startsWith(listPrefix)) {
            const key = k.slice(listPrefix.length), parent = listParent(x.id, key), prefix = parent + sep;
            const copy = tableOwner === out.id && out.widget.type === "table" && key === "cells" ? copyProjectedJSON : clone;
            out.widget.state[key] = children(parent).filter(r => r.id.startsWith(prefix)).map(r => {
              const row = nodeFields(r, copy); row.id = r.id.slice(prefix.length); return row;
            });
            delete out[k];
          }
        }
        if (fullTable(out)) projectTable(out.id, out.widget.state);
      }
      return out;
    }
    function emptyAxis(owner, key, name) {
      const prefix = listParent(owner, key) + sep, base = "table-empty-" + name;
      let id = base;
      for (let n = 1; objs.has(prefix + id); n++) id = base + "-" + n;
      return id;
    }
    function projectTable(owner, state) {
      // Retain records hidden by conflicting axes, overlaps and limits so they
      // can become visible when a concurrent change is undone or removed.
      if (![state.rows, state.columns, state.cells, state.merges].every(Array.isArray)) return;
      const limits = globalThis.AtriumTableData?.limits;
      let constrained = false;
      for (const key of ["rows", "columns"]) {
        if (limits && state[key].length > limits[key]) {
          state[key].length = limits[key]; constrained = true;
        }
      }
      if (!state.rows.length) state.rows.push({id: emptyAxis(owner, "rows", "row")});
      if (!state.columns.length) state.columns.push({id: emptyAxis(owner, "columns", "column"), title: "A"});
      const rows = new Map(state.rows.map((r, i) => [r.id, i])), cols = new Map(state.columns.map((c, i) => [c.id, i]));
      state.headerRows = Math.min(state.rows.length, state.headerRows);
      state.headerColumns = Math.min(state.columns.length, state.headerColumns);
      state.cells = state.cells.filter(c => rows.has(c.rowId) && cols.has(c.columnId) && (c.content !== undefined || c.style !== undefined));
      if (limits && state.cells.length > limits.cells) { state.cells.length = limits.cells; constrained = true; }
      const used = new Map(), surviving = [];
      let spans = 0;
      for (const m of state.merges.slice().sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
        if (!Array.isArray(m.rows) || !Array.isArray(m.columns)) continue;
        const r = m.rows.filter(id => rows.has(id)).sort((a, b) => rows.get(a) - rows.get(b));
        const c = m.columns.filter(id => cols.has(id)).sort((a, b) => cols.get(a) - cols.get(b));
        const area = r.length * c.length;
        if (area < 2 || (limits && area > limits.range) ||
            r.some((id, i) => rows.get(id) !== rows.get(r[0]) + i) || c.some((id, i) => cols.get(id) !== cols.get(c[0]) + i)) continue;
        const first = cols.get(c[0]), last = cols.get(c.at(-1));
        if ((limits && (surviving.length >= limits.merges || spans + r.length > limits.cells * 2)) ||
            r.some(id => used.get(id)?.some(edges => first <= edges[1] && last >= edges[0]))) continue;
        for (const id of r) { if (!used.has(id)) used.set(id, []); used.get(id).push([first, last]); }
        surviving.push({...m, rows: r, columns: c});
        spans += r.length;
      }
      if (constrained || surviving.length !== state.merges.length) constrainedTables.add(owner);
      else constrainedTables.delete(owner);
      state.merges = surviving;
      if (Array.isArray(state.query?.fields)) {
        state.query.fields = state.query.fields.filter(f => cols.has(f.columnId));
        if (!state.query.fields.length) delete state.query;
      }
    }
    const children = p => [...(kids.get(p) || [])].map(id => objs.get(id)).filter(visible).sort(byPos);
    function raw(tableOwner) {
      const p = {};
      for (const [k, r] of meta) if (r.v !== undefined) p[k] = clone(r.v);
      const rows = children(REVIEW);
      if (rows.length) {
        p.review ??= {version: 1, records: {}};
        for (const x of rows) { const r = nativeReviewRow(fields(x)); p.review.records[r.id] = r; }
      }
      p.library = children(LIB).map(fields);
      p.documents = children(DOCS).map(d => { const doc = fields(d); doc.items = children(d.id).map(i => fields(i, tableOwner)); return doc; });
      return p;
    }
    function validationCopy(p, tableOwner) {
      if (tableOwner === undefined) return clone(p);
      const docIndex = p.documents.findIndex(d => d.items.some(item => item.id === tableOwner));
      const doc = p.documents[docIndex], itemIndex = doc?.items.findIndex(item => item.id === tableOwner);
      const item = doc?.items[itemIndex], cells = item?.widget?.state?.cells;
      if (!fullTable(item) || !Array.isArray(cells)) return clone(p);
      // The complete model validator gets a detached copy, including every
      // cell. The existing JSON round trip still covers the rest of the model.
      const items = doc.items.slice(), documents = p.documents.slice();
      items[itemIndex] = {...item, widget: {...item.widget, state: {...item.widget.state, cells: []}}};
      documents[docIndex] = {...doc, items};
      const draft = clone({...p, documents});
      draft.documents[docIndex].items[itemIndex].widget.state.cells = copyProjectedJSON(cells);
      return draft;
    }
    // Model validation, as for a file load. A state that does not validate drops the objects
    // that fail on their own (deterministic: every replica with the same state drops the same).
    // Objects a newer Waffle wrote (unknown kinds in a newer format, AtriumCompat) are set aside
    // the same way a file load sets them aside: not shown, carried in the project's atriumCompat
    // bookkeeping (so Save writes them back) and never deleted by this replica's edits: diff()
    // leaves out every object the view left out.
    let hidden = new Set();
    function shown(p, v) {
      hidden = new Set();
      if (!isObj(v)) return p;
      const ids = list => new Set((Array.isArray(list) ? list : []).map(o => o?.id));
      const libIds = ids(v.library), docIds = new Map((v.documents || []).map(d => [d?.id, ids(d?.items)]));
      const keep = (list, has) => list.filter(o => has(o.id) || (hidden.add(o.id), false));
      const docs = keep(p.documents, id => docIds.has(id)).map(d => {
        const items = keep(d.items, id => docIds.get(d.id).has(id));
        return items.length === d.items.length ? d : {...d, items};
      });
      const out = {...p, library: keep(p.library, id => libIds.has(id)), documents: docs};
      if (isObj(v[COMPAT])) out[COMPAT] = v[COMPAT];
      return out;
    }
    function project(tableOwner) {
      const p = raw(tableOwner);
      if (!validate) { hidden = new Set(); return p; }
      try { return shown(p, validate(validationCopy(p, tableOwner))); } catch { /* filter below */ }
      const lib = p.library.filter(d => ok(d.id, () => validate({...shell(p), library: [clone(d)], documents: [{id: "#v", kind: "schematic", name: "v", grid: 1, items: [], outline: [], notes: []}]})));
      const docs = [];
      for (const d of p.documents) {
        const items = d.items.filter(i => ok(i.id, () => validate(clone({...shell(p), library: lib, documents: [{...d, items: [i]}]}))));
        const doc = {...d, items: []};
        if (ok(d.id, () => validate(clone({...shell(p), library: lib, documents: [doc]})))) { doc.items = items; docs.push(doc); }
      }
      const out = {...p, library: lib, documents: docs};
      try { validate(clone(out)); } catch {
        // Keep every top-level field that validates on its own (rules, variants, formatVersion and the
        // rest); only the ones that fail are left out, so a replica never loses the others.
        const base = {...shell(p), library: lib, documents: docs.length ? docs : [{id: "#empty", kind: "schematic", name: "Schematic", grid: 1.27, items: [], outline: [], notes: []}]};
        for (const k of Object.keys(p)) if (!(k in base)) { try { validate(clone({...base, [k]: p[k]})); base[k] = p[k]; } catch { stats.filtered++; } }
        return shown(p, base);
      }
      return shown(p, out);
    }
    // The format stamp goes with each per-object check, so an object from a newer minor version is
    // judged as a load of that file would judge it (kept), not as this version's (forward compatibility).
    const shell = p => ({format: "atrium", version: 1, ...(typeof p.formatVersion === "string" ? {formatVersion: p.formatVersion} : {}), name: typeof p.name === "string" ? p.name : "Project"});
    function ok(id, test) {
      const x = objs.get(id), key = id + "@" + (x?.ver ?? 0) + "/" + libVer();
      if (verdicts.has(key)) return verdicts.get(key);
      let good = true; try { test(); } catch { good = false; stats.filtered++; }
      if (verdicts.size > 50000) verdicts = new Map();
      verdicts.set(key, good); return good;
    }
    const libVer = () => { let v = 0; for (const id of kids.get(LIB) || []) v += objs.get(id).ver; return v; };

    // ---- local edits ---------------------------------------------------------------------
    function stamp(op) { op.ts = {c: ++clock, r: replica}; op.n = ++seqNo; return op; }
    // Operations that turn the current state into `next` (the editor's project after a local edit).
    function diff(next) {
      const ops = [], cur = raw();
      if (hidden.size) {
        const keep = list => list.filter(o => !hidden.has(o.id));
        cur.library = keep(cur.library);
        cur.documents = keep(cur.documents).map(d => ({...d, items: keep(d.items)}));
      }
      for (const k of new Set([...Object.keys(cur), ...Object.keys(next)])) {
        if (k === "documents" || k === "library" || k === COMPAT) continue;
        if (k === "review") {
          const a = reviewRows(cur.review), b = reviewRows(next.review);
          if (a && b) {
            const before = reviewHead(cur.review), after = reviewHead(next.review);
            if (canon(before) !== canon(after)) ops.push({t:"meta",k,reviewRecords:1,...(after && {v:after})});
            diffList(ops, REVIEW, a, b, false); continue;
          }
          if (canon(cur.review) !== canon(next.review)) throw Error("The review version cannot be edited by this collaboration session.");
        }
        if (canon(cur[k]) !== canon(next[k])) ops.push({t: "meta", k, ...(next[k] === undefined ? {} : {v: clone(next[k])})});
      }
      diffList(ops, LIB, cur.library, next.library || [], false);
      diffList(ops, DOCS, cur.documents, next.documents || [], true);
      return ops;
    }
    function diffWidgetLists(ops, next, cur) {
      if (next.widget === cur.widget) return;
      const beforeLists = new Map(widgetLists(cur)), afterLists = new Map(widgetLists(next));
      const table = fullTable(next) ? next.widget.state : null;
      const equal = table && globalThis.AtriumTableData?.equal;
      for (const k of new Set([...beforeLists.keys(), ...afterLists.keys()])) {
        const container = listParent(next.id, k), after = afterLists.get(k) || [];
        let before = beforeLists.get(k) || [];
        // An empty axis after concurrent deletions is a stand-in. Create the
        // real axis if an edit keeps it and changes the list or uses its cells.
        if (table && (k === "rows" || k === "columns") && before.length === 1 &&
            !objs.has(container + sep + before[0].id)) {
          const id = before[0].id, cellKey = k === "rows" ? "rowId" : "columnId";
          if (after.length === 1 && canon(before[0]) === canon(after[0]) &&
              !table.cells.some(c => c[cellKey] === id) && !table.merges.some(m => m[k].includes(id)) &&
              !(k === "columns" && table.query?.fields.some(f => f.columnId === id))) continue;
          before = [];
        }
        // A value edit need not allocate or order virtual children for the
        // rest of the table. Only membership and order use the list planner.
        if (equal && before.length === after.length && before.every((row, i) => row.id === after[i].id)) {
          for (let i = 0; i < before.length; i++) {
            if (equal(before[i], after[i])) continue;
            const id = container + sep + before[i].id;
            diffFields(ops, {...after[i], id}, {...before[i], id}, false);
          }
          continue;
        }
        diffList(ops, container, virtualRows(container, before), virtualRows(container, after), false, k === "cells" ? table : null);
      }
    }
    function diffList(ops, parent, before, after, isDoc, table = null) {
      const old = new Map(before.map(o => [o.id, o]));
      if (before.length !== after.length || before.some((o, i) => o.id !== after[i].id)) {
        const afterIds = new Set(after.map(o => o.id));
        const rowIds = table && new Set(table.rows.map(r => r.id)), colIds = table && new Set(table.columns.map(c => c.id));
        for (const o of before) if (!afterIds.has(o.id)) {
          // Clearing a sparse cell on surviving axes withdraws its fields.
          // A collaborator can still independently author content or format.
          if (rowIds?.has(o.rowId) && colIds.has(o.columnId)) diffFields(ops, cellIdentity(o), o, false);
          else ops.push({t: "rem", o: o.id, tags: live(o.id)});
        }
        const order = children(parent), positions = new Map(order.map(x => [x.id, x.pos.v]));
        const stay = new Set(lis(after.filter(o => old.has(o.id)), order));
        const keys = keysForOrder(after, stay, positions);
        for (let i = 0; i < after.length; i++) {
          const o = after[i], pos = keys[i];
          if (old.has(o.id) || table && positions.has(o.id)) {
            if (pos !== positions.get(o.id)) ops.push({t: "pos", o: o.id, v: pos});
          } else if (objs.has(o.id)) ops.push({t: "add", o: o.id, p: parent, tag: "", pos}); // revived or moved here
          else ops.push(addOp(table ? cellIdentity(o) : o, parent, pos, isDoc));
        }
      }
      for (const o of after) {
        const previous = old.get(o.id), x = objs.get(o.id);
        if (previous || x) {
          const was = previous || fields(x);
          diffWidgetLists(ops, o, was);
          diffFields(ops, o, was, isDoc);
          if (isDoc) diffList(ops, o.id, previous ? previous.items : children(o.id).map(fields), o.items || [], false);
        } else {
          diffWidgetLists(ops, o, {});
          // Rewind the author's payload even if a collaborator's edit keeps
          // this new cell's creation visible during personal Undo.
          if (table) diffFields(ops, o, cellIdentity(o), false);
          if (isDoc) diffList(ops, o.id, [], o.items || [], false);
        }
      }
    }
    function keysForOrder(after, stay, positions) {
      const keys = new Array(after.length);
      // Divide each gap evenly so pasting a large selection uses short keys throughout.
      function fill(from, to, left, right) {
        if (from >= to) return;
        const mid = Math.floor((from + to) / 2), key = between(left, right);
        keys[mid] = key;
        fill(from, mid, left, key);
        fill(mid + 1, to, key, right);
      }
      let from = 0, left = "";
      for (let i = 0; i < after.length; i++) {
        const id = after[i].id, right = positions.get(id);
        if (!stay.has(id)) continue;
        // Simultaneous insertions can already be ordered by id at the same key.
        // Keep both positions unless an actual edit needs to fit something between them.
        if (left === right && i > from) continue;
        fill(from, i, left, right);
        keys[i] = right; left = right; from = i + 1;
      }
      fill(from, after.length, left, null);
      return keys.some(key => key.length > 64) ? spread(after.length) : keys;
    }
    // Longest increasing subsequence of the surviving objects' current positions.
    function lis(surviving, order) {
      const index = new Map(order.map((x, i) => [x.id, i])), seq = surviving.map(o => index.get(o.id));
      const tails = [], prev = new Array(seq.length), at = [];
      for (let i = 0; i < seq.length; i++) {
        let lo = 0, hi = tails.length;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[i]) lo = mid + 1; else hi = mid; }
        prev[i] = lo ? tails[lo - 1] : -1; tails[lo] = i; at[lo] = i;
      }
      const out = []; for (let i = tails.length ? tails[tails.length - 1] : -1; i >= 0; i = prev[i]) out.push(surviving[i].id);
      return out;
    }
    const live = id => { const x = objs.get(id); return x ? [...x.tags].filter(t => !x.tomb.has(t)) : []; };
    const seqProp = (k, v) => k === "points" && Array.isArray(v);
    function addOp(o, parent, pos, isDoc) {
      const f = {}, s = {};
      for (const [k, v] of Object.entries(widgetRegisters(o))) {
        if (k === "id" || (isDoc && k === "items") || v === undefined) continue;
        if (seqProp(k, v)) s[k] = clone(v); else f[k] = clone(v);
      }
      return {t: "add", o: o.id, p: parent, tag: "", f, s, pos};
    }
    function diffFields(ops, next, cur, isDoc) {
      const x = objs.get(next.id);
      next = widgetRegisters(next); cur = widgetRegisters(cur);
      for (const k of new Set([...Object.keys(cur), ...Object.keys(next)])) {
        if (k === "id" || (isDoc && k === "items")) continue;
        if (x?.seqs.has(k) && seqProp(k, next[k])) {
          const list = seqList(x.seqs.get(k), minPoints(x, k));
          if (canon(list.map(e => e.v)) === canon(next[k])) continue;
          for (const e of seqEdits(list, next[k])) {
            if (e.t === "ins") { e.op = {t: "ins", o: next.id, k, after: typeof e.after === "object" && e.after ? e.after.op : e.after, v: clone(e.v)}; ops.push(e.op); }
            else ops.push({t: e.t, o: next.id, k, e: e.e, ...(e.t === "pset" ? {v: clone(e.v)} : {})});
          }
          continue;
        }
        if (cur[k] !== next[k] && canon(cur[k]) !== canon(next[k]))
          ops.push({t: "set", o: next.id, k, ...(next[k] === undefined ? {} : {v: clone(next[k])})});
      }
    }
    // The Undo journal certifies that the item lists, their order and non-item
    // fields stayed unchanged. Use the same field, child and vertex operation builder
    // as the full diff, including its document/list order (and thus its stamps).
    function diffUpdates(next, updates) {
      if (!updates || hidden.size || next[COMPAT]) return null;
      const items = [];
      for (const {doc, before, after} of updates) {
        if (!before || !after) return null;
        const x = objs.get(before.id), parent = objs.get(doc);
        if (!x || x.parent !== doc || parent?.parent !== DOCS || !visible(x) || !visible(parent) ||
            before.id !== after.id || before.kind !== after.kind ||
            Array.isArray(before.points) !== Array.isArray(after.points)) return null;
        const shared = fields(x);
        const equal = fullTable(shared) ? globalThis.AtriumTableData?.equal : undefined;
        if (!equal?.(shared, before) && canon(shared) !== canon(before)) return null;
        items.push({x, parent, shared, after});
      }
      items.sort((a, b) => a.parent === b.parent ? byPos(a.x, b.x) : byPos(a.parent, b.parent));
      const ops = [];
      for (const item of items) {
        diffWidgetLists(ops, item.after, item.shared);
        diffFields(ops, item.after, item.shared, false);
      }
      return ops;
    }
    // Remember one exact editor projection. The object's existing version
    // invalidates it on any local or peer change to the owner or its children.
    let verifiedTable;
    function diffTableEdit(next, updates) {
      const edit = updates?.length === 1 && updates[0].tableEdit;
      if (!edit || hidden.size || next[COMPAT]) return null;
      const x = objs.get(edit.id), doc = objs.get(updates[0].doc);
      const parent = listParent(edit.id, "cells"), id = parent + sep + edit.before.id, cell = objs.get(id);
      if (!x || x.parent !== doc?.id || doc?.parent !== DOCS || !visible(x) || !visible(doc) || cell?.parent !== parent || !visible(cell)) return null;
      const verified = verifiedTable?.id === edit.id && verifiedTable.ver === x.ver &&
        (edit.beforeVersion === undefined ? verifiedTable.json !== undefined && verifiedTable.json === edit.beforeJSON :
          verifiedTable.version === edit.beforeVersion);
      if (!verified) {
        const before = updates[0].before;
        if (!before) return null;
        const shared = fields(x), equal = globalThis.AtriumTableData?.equal;
        if (!fullTable(shared) || constrainedTables.has(x.id) || !equal?.(shared, before)) return null;
      }
      const ops = [];
      diffFields(ops, {...edit.after, id}, {...edit.before, id}, false);
      return ops;
    }
    // Stamps and applies a group of local ops; inserts chained after other new inserts get the
    // ids the stamps produce. Undo needs just this author's previous contribution.
    function local(ops, record = true) {
      const group = [];
      const dependencies = dependenciesBefore(ops), projections = new Set();
      for (const op of ops) {
        const path = widgetPath(op.o);
        if (path && constrainedTables.has(path[1])) projections.add(path[1]);
        stamp(op);
        if (op.t === "add" && !op.tag) op.tag = op.ts.c + "@" + replica;
        if (op.t === "ins") { op.e = op.ts.c + "." + replica + ".0"; if (op.after && typeof op.after === "object") op.after = op.after.e; }
        if (op.t === "add" && op.s && !Object.keys(op.s).length) delete op.s;
        if (record) {
          // An add is reactivated by its tag; its original geometry already lives in the replica.
          const entry = op.t === "add" ? {t: op.t, o: op.o, n: op.n, ts: op.ts, p: op.p, pos: op.pos} : op;
          group.push({op: entry, prev: before(op)});
        }
        apply(op);
      }
      for (const op of ops) if (op.t === "ins" && typeof op.after === "object" && op.after) op.after = op.after.e;
      view = null;
      if (record && group.length) { undoStack.push(group); if (undoStack.length > LIMITS.undo) undoStack.shift(); redoStack = []; }
      return [...new Set([...changedDependencies(dependencies), ...projections])];
    }
    function ownValue(reg) {
      const w = contribution(reg, replica);
      return w && w.at !== null ? {at: w.at, v: w.v} : {at: null};
    }
    function before(op) {
      if (op.t === "meta") return ownValue(meta.get(op.k));
      const x = objs.get(op.o);
      if (!x) return null;
      if (op.t === "set") return ownValue(x.f.get(op.k));
      if (op.t === "pos") return ownValue(x.pos);
      if (op.t === "pset") {
        const e = x.seqs.get(op.k)?.elems.get(op.e);
        return ownValue(e && {v: e.v, ts: e.vts, writers: e.writers});
      }
      if (op.t === "add" && x.parent && op.p !== x.parent) return {
        p: ownValue({v: x.parent, ts: x.pts, writers: x.locations}), pos: ownValue(x.pos)
      };
      return null;
    }
    let verifyNextDiff = false;
    /** @param {any} next @param {{recordUndo?: boolean, updates?: Array<{doc:string, before:any, after:any, tableEdit?:{id:string, before:any, after:any, beforeJSON:string, afterJSON:string, beforeVersion?:object, afterVersion?:object}}>, reconcile?: (ops:any[]) => boolean | Set<string>}} [options] */
    function commit(next, {recordUndo = true, updates, reconcile} = {}) {
      const tableOps = diffTableEdit(next, updates), scoped = tableOps ?? diffUpdates(next, updates);
      let ops = scoped && !verifyNextDiff ? scoped : diff(next);
      // A structural or legacy edit can be unrepresentable (for example an
      // owner-only format field). Re-establish agreement with the full diff
      // before relying on a subsequent journal range.
      verifyNextDiff = !scoped || (ops !== scoped && (ops.length !== scoped.length ||
        ops.some((op, i) => op.after && typeof op.after === "object" || canon(op) !== canon(scoped[i]))));
      // A precise rollback can reject whole items and their children.
      // Looking at the live editor again could capture a later, unfinished drag.
      // A structural rollback can also change membership, order and dependencies.
      if (ops.length && reconcile) {
        // The working editor may have adopted or subsequently edited a materialised value.
        view = null;
        const rejected = reconcile(ops);
        if (rejected instanceof Set && scoped && !verifyNextDiff) ops = scoped.filter(op => !rejected.has(operationTarget(op)));
        else if (rejected) { ops = diff(next); verifyNextDiff = true; }
      }
      if (!ops.length) return null;
      const related = local(ops, recordUndo);
      if (ops === tableOps && !verifyNextDiff) {
        const edit = updates[0].tableEdit, id = edit.id;
        verifiedTable = {id, ver: objs.get(id).ver, version: edit.afterVersion,
          json: edit.afterVersion === undefined ? edit.afterJSON : undefined};
      }
      if (!recordUndo) { undoStack = []; redoStack = []; }
      return batch(ops, related);
    }
    function batch(ops, related) {
      const result = {from: replica, ops: ops.map(op => clone(op))};
      if (related.length) Object.defineProperty(result, "related", {value: related});
      return result;
    }

    // ---- per-user undo ------------------------------------------------------------------
    // A rewind targets the original author's register, add tag, or deletion mark.
    // A redo reactivates the original edit at its original causal priority.
    function control({op, prev}, on) {
      const change = {t: "undo", a: op.t, at: op.ts.c, on};
      if (op.o) change.o = op.o;
      if (op.k) change.k = op.k;
      if (op.reviewRecords === 1) change.reviewRecords = 1;
      if (op.e) change.e = op.e;
      if (registerKinds.has(op.t)) {
        const value = on ? {at: op.ts.c, v: op.v} : prev;
        change.rank = value?.at ?? null;
        if (value?.v !== undefined) change.v = value.v;
      } else if (op.t === "rem") change.tags = op.tags;
      else if (op.t === "add" && prev) change.move = on ? {
        p: {at: op.ts.c, v: op.p}, pos: {at: op.ts.c, v: op.pos}
      } : prev;
      return change;
    }
    // Consult local edit policy before consuming any history or stamping a message.
    // Removed records retain their fields in the replica and may be restored by Undo.
    function historyTouches(redo, test) {
      const group=(redo?redoStack:undoStack).at(-1) || [];
      for(const {op,prev} of group){
        if(op.t==="meta"){
          if(test(null,op.k,op.v,prev?.v))return true;
          continue;
        }
        const id=widgetPath(op.o)?.[1] || op.o, node=objs.get(id);
        if(!node || reviewOperation(op))continue;
        const obj=fields(node);
        if(test(obj,op.k,op.v,prev?.v))return true;
        if(node.parent===DOCS && (op.t==="rem" || op.t==="add") && children(id).some(child=>test(fields(child))))return true;
      }
      return false;
    }
    function step(from, to, on) {
      const group = from.pop();
      if (!group) return null;
      const ops = (on ? group : [...group].reverse()).map(edit => control(edit, on));
      const related = local(ops, false);
      to.push(group);
      return batch(ops, related);
    }
    function forgetHistoryThrough(n) {
      if (!Number.isSafeInteger(n) || n < 1) return;
      const newerGroups = stack => stack.map(group => group.filter(edit => edit.op.n > n)).filter(group => group.length);
      undoStack = newerGroups(undoStack);
      redoStack = newerGroups(redoStack);
    }

    // ---- remote --------------------------------------------------------------------------
    // A remote batch: every op is checked before any is applied (all or nothing).
    // Bounds every incoming counter: no edits by this replica that it never made, no clock far
    // ahead of ours, no sequence number far past what we hold, a bounded set of authors.
    function checkCounters(entries, maxClock) {
      if (maxClock > clock + LIMITS.skew) throw Error("clock too far ahead");
      const novel = new Set();
      for (const [r, n] of entries) {
        if (r === replica ? n > seqNo : n > (vv.get(r) || 0) + LIMITS.gap) throw Error("sequence out of range");
        if (!vv.has(r) && r !== replica) novel.add(r);
      }
      if (vv.size + novel.size > LIMITS.authors) throw Error("too many authors");
    }
    // A remote batch: every op is checked before any is applied (all or nothing). With {author},
    // a live batch from one peer: each op must be that peer's own.
    /** @param {any} b @param {{author?: string}} [o] */
    function receive(b, {author} = /** @type {{author?: string}} */ ({})) {
      if (!isObj(b) || !Array.isArray(b.ops) || b.ops.length > LIMITS.ops) { stats.rejected++; throw Error("Rejected a malformed collaboration message."); }
      let checked;
      try {
        if (author !== undefined && (b.from !== undefined && b.from !== author || typeof author !== "string")) throw Error("sender");
        checked = b.ops.map(op => checkOp(clone(op)));
        if (checked.some(op => (op.t === "meta" || op.a === "meta") && op.k === "review" &&
            (op.reviewRecords !== 1 || op.v !== undefined && (!isObj(op.v.records) || Object.keys(op.v.records).length))))
          throw Error("Update the older editor before sharing Review changes. Its project still holds the original edits.");
        if (author !== undefined && checked.some(op => op.ts.r !== author)) throw Error("an operation by someone else");
        checkCounters(checked.map(op => [op.ts.r, op.n]), Math.max(0, ...checked.map(op => op.ts.c)));
        const size = JSON.stringify(checked).length;
        if (size > LIMITS.value * 16) throw Error("too large");
        for (const op of checked) if (own(op, "v") && JSON.stringify(op.v).length > LIMITS.value) throw Error("value too large");
      } catch (e) { stats.rejected++; throw Error("Rejected a collaboration message: " + e.message); }
      const touched = new Set(), dependencies = dependenciesBefore(checked);
      for (const op of checked) { const id = apply(op); if (id) touched.add(id); }
      if (touched.size) {
        view = null;
        for (const id of changedDependencies(dependencies)) touched.add(id);
      }
      if (touched.size === 1 && checked.length === 1) {
        const [op] = checked, path = op.t === "set" && widgetPath(op.o);
        if (path && path[2] === "cells" && (op.k === "content" || op.k === "style"))
          cellPatchHints.set(touched, {item: path[1], cell: path[3], field: op.k});
      }
      return {touched, applied: touched.size};
    }

    // ---- sync, log and snapshots ----------------------------------------------------------
    function vector() { return Object.fromEntries(vv); }
    // Ops another replica (at version vector `want`) lacks, or null when the log no longer
    // reaches back that far (send a snapshot instead).
    function since(want = {}) {
      for (const [r, n] of floor) if ((want[r] || 0) < n) return null;
      return log.filter(op => (want[op.ts.r] || 0) < op.n).map(clone);
    }
    // Bounded log: past the limit, the oldest half is dropped; peers that far behind get a snapshot.
    function trim() {
      if (log.length <= LIMITS.log) return false;
      const drop = log.splice(0, log.length - (LIMITS.log >> 1));
      for (const op of drop) floor.set(op.ts.r, Math.max(floor.get(op.ts.r) || 0, op.n));
      return true;
    }
    function snapshot() {
      // Keep the v1 projection readable by earlier editors. Optional metadata
      // retains the contributors behind each winner and each reversible tombstone.
      const ser = (s, minimum) => {
        const shown = s.creations && new Set(seqList(s, minimum).map(e => e.id));
        return {e: [...s.elems.values()].map(e => {
          const row = [e.id, e.after, e.v, e.vts, (shown ? shown.has(e.id) : !e.del) ? 0 : 1];
          if (e.writers) row.push(e.writers);
          return row;
        }),
        w: [...s.waiting].map(([id, pending]) => [id, [...pending.values()]]), t: [...s.tomb], y: [...s.early],
        ...(s.cuts && {cuts: [...s.cuts]}), ...(s.creations && {adds: [...s.creations]})};
      };
      function row(x) {
        const tags = [], hidden = [];
        for (const t of x.tags) (x.creations?.get(t)?.on === false && !visible(x) ? hidden : tags).push(t);
        const fields = x.parent === LIB && x.geometry ? [...x.f].map(([k, r]) => {
          const v = fieldValue(x, k, r);
          return [k, v === r.v ? r : {...r, v}];
        }) : [...x.f];
        const geometry = x.geometry && [...x.geometry].filter(([k, g]) => cmp(g.ts, x.f.get(k).ts) !== 0);
        const result = [x.id, x.parent, tags, [...x.tomb], fields, [...x.seqs].map(([k, s]) => [k, ser(s, minPoints(x, k))]), x.pos, x.pts];
        if (x.creations || x.cuts || x.edits || x.locations || geometry?.length) result.push({
          ...(x.creations && {adds: [...x.creations]}), ...(x.cuts && {cuts: [...x.cuts]}),
          ...(x.edits && {edits: [...x.edits]}), ...(x.locations && {locations: x.locations}),
          ...(hidden.length && {hidden}), ...(geometry?.length && {geometry})
        });
        return result;
      }
      return {v: 1, ...(kids.has(REVIEW) && {reviewRecords:1}), clock, meta: [...meta], vv: [...vv], extra: [...extra], floor: [...floor],
        objs: [...objs.values()].map(row)};
    }
    function readReg(r) {
      checkTs(r.ts);
      const value = v => v === undefined ? undefined : cleanValue(v);
      if (!r.writers) return {v: value(r.v), ts: {...r.ts}};
      if (!Array.isArray(r.writers) || !r.writers.length) throw Error("snapshot writers");
      const authors = new Set(), writers = [];
      for (const w of r.writers) {
        checkTs(w);
        if (!isRank(w.at, w.c) || authors.has(w.r)) throw Error("snapshot rank");
        authors.add(w.r); writers.push({r: w.r, c: w.c, at: w.at, v: value(w.v)});
      }
      return fromWriters(writers);
    }
    function joinMarks(x, adds, cuts, tomb, check, deleted) {
      for (const [id, m] of adds || []) {
        check(id); checkTs(m);
        if (typeof m.on !== "boolean" || !Number.isSafeInteger(m.at) || m.at < 1 || m.at >= m.c) throw Error("snapshot creation");
        if (id !== m.at + "@" + m.r && id !== m.at + "." + m.r + ".0") throw Error("snapshot author");
        markCreation(x.creations ||= new Map(), id, m, m.at, m.on);
      }
      const covered = cuts?.length ? new Set() : null;
      for (const [id, cut] of cuts || []) {
        check(id); covered.add(id);
        if (typeof cut.fixed !== "boolean" || !Array.isArray(cut.writers)) throw Error("snapshot deletion");
        const entries = x.cuts ||= new Map(), old = entries.get(id);
        if (cut.fixed && old && !old.fixed) entries.set(id, {...old, fixed: true});
        for (const w of cut.writers) {
          checkTs(w);
          if (typeof w.on !== "boolean") throw Error("snapshot deletion");
          deleted(id, markDeletion(entries, id, w, w.on, cut.fixed || x.tomb.has(id)));
        }
      }
      for (const id of tomb) {
        check(id);
        if (covered?.has(id)) continue;
        const old = x.cuts?.get(id);
        if (old && !old.fixed) x.cuts.set(id, {...old, fixed: true});
        deleted(id, true); // legacy deletion with unknown authorship
      }
    }
    function load(snap, checked = false, resume = false) {
      if (!isObj(snap) || snap.v !== 1 || !Array.isArray(snap.objs)) throw Error("Not a collaboration snapshot.");
      if (!Number.isSafeInteger(snap.clock) || snap.clock < 0 || snap.clock > LIMITS.clock) throw Error("snapshot clock");
      if (!Array.isArray(snap.vv) || !Array.isArray(snap.extra) || !Array.isArray(snap.meta) || snap.vv.length > LIMITS.authors ||
          snap.extra.length > LIMITS.gap || snap.objs.length > LIMITS.objects) throw Error("snapshot size");
      clock = Math.max(clock, snap.clock);
      const read = checked ? r => r.writers ? fromWriters(r.writers) : r : readReg;
      const value = checked ? v => v : cleanValue;
      for (const [k, r] of snap.meta) {
        checkKey(k); let value = read(r);
        if (k === "review" && !snap.reviewRecords && value.v !== undefined) {
          const rows = reviewRows(value.v);
          if (rows) {
            seedReview(rows, value.ts);
            value = {v: reviewHead(value.v), ts: value.ts};
          }
        }
        meta.set(k, joinReg(meta.get(k), value));
      }
      const importFloor = (r, n) => floor.set(r, Math.max(floor.get(r) || 0, n));
      // A snapshot never raises this replica's own counter: edits "by us" that we never made are forged.
      function sequence(r, n) {
        checkId(r, "replica");
        // Each edit raises its author's sequence and the Lamport clock by one: a count above the
        // clock is inflated (security review: a forged snapshot that silences an author).
        if (!Number.isSafeInteger(n) || n < 0 || n > LIMITS.clock || n > snap.clock) throw Error("snapshot sequence");
        if (r === replica) { if (resume || n <= Math.max(seqNo, ownSeq)) seqNo = Math.max(seqNo, n); else throw Error("snapshot claims edits by this replica"); }
      }
      for (const [r, n] of snap.vv) {
        sequence(r, n);
        if (n > (vv.get(r) || 0)) { vv.set(r, n); importFloor(r, n); }
      }
      // A peer's log retention cannot retire our own available operations. Every
      // imported event missing from our log is already covered by vv or extra.
      for (const e of new Set([...extra, ...snap.extra])) {
        if (typeof e !== "string") throw Error("snapshot sequence");
        const colon = e.lastIndexOf(":"), r = e.slice(0, colon), n = Number(e.slice(colon + 1));
        sequence(r, n);
        if (!seen(r, n)) importFloor(r, n);
        if (n <= (vv.get(r) || 0)) extra.delete(e); else mark(r, n);
      }
      for (const [id, parent, tags, tomb, f, seqs, pos, pts, details = {}] of snap.objs) {
        checkId(id, "object");
        const x = obj(id);
        x.ver++;
        if (parent || details.locations) {
          if (parent) checkId(parent, "parent");
          if (parent && isReviewRow(id) !== (parent === REVIEW)) throw Error("snapshot review parent");
          const location = read({v: parent, ts: pts || seed, writers: details.locations});
          setLocation(x, joinReg(x.pts && {v: x.parent, ts: x.pts, writers: x.locations}, location));
        }
        const tag = t => checkId(t, "tag");
        for (const t of [...tags, ...(details.hidden || [])]) { tag(t); x.tags.add(t); }
        joinMarks(x, details.adds, details.cuts, tomb, tag, (id, on) => on ? x.tomb.add(id) : x.tomb.delete(id));
        for (const edit of details.edits || []) { checkTs(edit); noteEdit(x, {c: edit.c, r: edit.r}); }
        // Older snapshots expose only the winning timestamps. Recover evidence of
        // a contributor when it is still present and distinct from an object's add.
        const legacyWitness = ts => {
          if (!details.edits && ts?.c > 0 && !x.tags.has(ts.c + "@" + ts.r)) noteEdit(x, {c: ts.c, r: ts.r});
        };
        for (const [k, r] of f) {
          checkKey(k);
          const reg = read(r);
          x.f.set(k, joinReg(x.f.get(k), reg)); rememberGeometry(x, k, reg.v, reg.ts); legacyWitness(reg.ts);
        }
        for (const [k, g] of details.geometry || []) {
          if (!geometryField(k) || !x.f.has(k)) throw Error("snapshot geometry");
          checkTs(g.ts); rememberGeometry(x, k, value(g.v), g.ts);
        }
        for (const [k, s] of seqs) {
          checkKey(k);
          const q = seqOf(x, k);
          const masked = new Set((s.adds || []).map(([id]) => id)), dead = new Set(s.t);
          for (const [eid, after, v, vts, del, writers] of s.e) {
            checkElem(eid); if (after !== "^") checkElem(after);
            const r = read({v, ts: vts, writers});
            seqInsert(q, after === "^" ? null : after, eid, r.v, r.ts, r);
            legacyWitness(r.ts);
            if (!details.edits && !eid.startsWith("0.~.")) legacyWitness(elemKey(eid));
            if (del && !masked.has(eid)) dead.add(eid);
          }
          for (const [anchor, waiting] of s.w) for (const [eid, v, ts, state] of waiting) {
            checkElem(anchor); checkElem(eid); checkTs(ts);
            seqInsert(q, anchor, eid, value(v), ts, state && read(state));
          }
          for (const [eid, incoming] of s.y) {
            checkElem(eid);
            const r = read(incoming), e = q.elems.get(eid);
            if (e) {
              const combined = joinReg({v: e.v, ts: e.vts, writers: e.writers}, r);
              e.v = combined.v; e.vts = combined.ts; e.writers = combined.writers;
            } else q.early.set(eid, joinReg(q.early.get(eid), r));
          }
          joinMarks(q, s.adds, s.cuts, dead, checkElem, (eid, on) => {
            if (on) q.tomb.add(eid); else q.tomb.delete(eid);
            const e = q.elems.get(eid); if (e) e.del = on;
          });
        }
        if (pos && pos.ts?.c !== -1) { x.pos = joinReg(x.pos, read(pos)); legacyWitness(pos.ts); }
        trackContainer(x); if (x.seqs.get("points")?.creations) trackPath(x);
      }
      view = null; verifiedTable = undefined; referencedDefs = null; verdicts.clear();
    }
    // Reconnect after either side trimmed its log. Validate in isolation, then
    // join the complete snapshot with local/offline state and personal history.
    // Bounded like live operations: the session accepts it only from its host or the peer it asked.
    function merge(snap) {
      if (!isObj(snap) || !Number.isSafeInteger(snap.clock) || snap.clock > clock + LIMITS.skew) { stats.rejected++; throw Error("Rejected a collaboration snapshot: clock too far ahead"); }
      if (kids.has(REVIEW) && !snap.reviewRecords && snap.meta?.some(([k,r])=>k==="review" && canon(r.v)!==canon(raw().review)))
        throw Error("Update the older editor before reconciling Review changes. Both project copies retain their review records.");
      const checked = create({replica: replica + "~", snapshot: snap, validate: null}).snapshot();
      try {
        const entries = [...checked.vv, ...checked.extra.map(e => { const i = e.lastIndexOf(":"); return [e.slice(0, i), Number(e.slice(i + 1))]; })];
        checkCounters(entries, checked.clock);
      } catch (e) { stats.rejected++; throw Error("Rejected a collaboration snapshot: " + e.message); }
      const changed = checked.vv.some(([r, n]) => n > (vv.get(r) || 0)) || checked.extra.some(e => {
        const i = e.lastIndexOf(":"); return !seen(e.slice(0, i), Number(e.slice(i + 1)));
      });
      if (!changed) return {touched: new Set(), applied: 0};
      load(checked, true);
      const touched = new Set(["#meta", ...objs.keys()]);
      return {touched, applied: touched.size};
    }
    // A project loaded into a fresh state: every replica that loads the same project (or the
    // snapshot made from it) shares ids, tags and positions.
    function seedReview(rows, ts) {
      const keys = spread(rows.length);
      rows.forEach((row,i) => {
        const x = obj(row.id); link(x, REVIEW, ts); x.tags.add("0@~");
        x.pos = joinReg(x.pos, {v:keys[i],ts});
        for (const [k,v] of Object.entries(row)) if (k !== "id") x.f.set(k, joinReg(x.f.get(k), {v:clone(v),ts}));
      });
    }
    function fromProject(p) {
      const ts = {c: 0, r: "~"}, add = (o, parent, pos, isDoc) => {
        const x = obj(o.id); link(x, parent, ts); x.tags.add("0@~"); x.pos = {v: pos, ts};
        for (const [k, rows] of widgetLists(o)) {
          const container = listParent(o.id,k), keys = spread(rows.length);
          virtualRows(container,rows).forEach((r,i)=>add(r,container,keys[i],false));
        }
        for (const [k, v] of Object.entries(widgetRegisters(o))) {
          if (k === "id" || (isDoc && k === "items") || v === undefined) continue;
          if (seqProp(k, v)) { const s = seqOf(x, k); v.forEach((pt, i) => seqInsert(s, i ? "0.~." + (i - 1) : null, "0.~." + i, clone(pt), ts)); }
          else x.f.set(k, {v: clone(v), ts});
        }
      };
      for (const [k, v] of Object.entries(p)) if (k !== "documents" && k !== "library" && v !== undefined) {
        const rows = k === "review" ? reviewRows(v) : null;
        if (rows) { seedReview(rows, ts); meta.set(k, {v:clone(reviewHead(v)),ts}); }
        else meta.set(k, {v: clone(v), ts});
      }
      const lk = spread((p.library || []).length); (p.library || []).forEach((d, i) => add(d, LIB, lk[i], false));
      const dk = spread(p.documents.length);
      p.documents.forEach((d, i) => { add(d, DOCS, dk[i], true); const ik = spread(d.items.length); d.items.forEach((it, j) => add(it, d.id, ik[j], false)); });
      view = null;
    }
    // {resume: true}: this replica's own trusted snapshot (a dry run), which continues its sequence.
    if (o.snapshot) load(o.snapshot, false, o.resume === true); else if (o.project) fromProject(o.project);
    seqNo = Math.max(seqNo, ownSeq);

    // ---- patching an editor project in place -------------------------------------------------
    // Updates `target` to the materialised state for the touched objects only, keeping the
    // identity of untouched objects (selections, caches and inspector rows stay valid).
    // A visible document can observe individual items just before their fields are
    // replaced. Bulk loads and callers without observers take the normal patch path.
    const sameIds = (a, b) => a?.length === b.length && b.every((item, i) => item.id === a[i].id);
    function sameFields(a, b, excluding) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (!excluding.includes(k) && (!own(a, k) || !own(b, k) || canon(a[k]) !== canon(b[k]))) return false;
      }
      return true;
    }
    function tableCellDiffers(before, after, hint) {
      if (hint?.item !== after.id || !fullTable(before) || !fullTable(after)) return false;
      const a = before.widget.state.cells, b = after.widget.state.cells;
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      const cell = rows => rows.find(row => row?.id === hint.cell)?.[hint.field];
      return a.length !== b.length || canon(cell(a)) !== canon(cell(b));
    }
    function preparePatch(target, touched, observers) {
      // Incoming values always go through the complete model/compatibility
      // validator. It can set aside an *untouched* object after a dependency changes.
      const hint = cellPatchHints.get(touched), p = view ??= project(hint?.item), touch = touched ? new Set(touched) : null;
      const full = {apply: () => patchLists(target, p, touch, observers)};
      if (!touch || !sameIds(target.documents, p.documents) || !sameIds(target.library, p.library)) return full;
      if (!sameFields(target, p, ["documents", "library"])) return full;
      for (let i = 0; i < p.library.length; i++) {
        const def = p.library[i];
        if (touch.has(def.id) && canon(target.library[i]) !== canon(def)) return full;
      }
      const scopes = [], writes = [];
      for (let d = 0; d < p.documents.length; d++) {
        const doc = target.documents[d], wanted = p.documents[d].items, items = [];
        if (touch.has(doc.id) && !sameFields(doc, p.documents[d], ["items"])) return full;
        if (doc.items.length !== wanted.length) return full;
        for (let i = 0; i < wanted.length; i++) {
          const before = doc.items[i], after = wanted[i];
          if (before.id !== after.id) return full;
          if (!touch.has(after.id)) continue;
          // A changed cell in the validated widget proves this field needs
          // replacement. Unchanged cells and other edits use the complete diff.
          const changedWidget = tableCellDiffers(before, after, hint);
          if (!changedWidget && canon(before) === canon(after)) continue;
          items.push(before);
          writes.push({before, after, observe: observers?.get(doc.id), changedWidget});
        }
        if (items.length) scopes.push({doc, items});
      }
      return {scopes, apply() {
        for (const {before, after, observe, changedWidget} of writes) {
          observe?.(before, after);
          for (const k of Object.keys(before)) if (!own(after, k)) delete before[k];
          for (const [k, v] of Object.entries(after)) {
            if (k === "widget" && changedWidget || !own(before, k) || canon(before[k]) !== canon(v)) before[k] = v;
          }
        }
        return target;
      }};
    }
    function patchLists(target, p, touch, observers) {
      const t = id => !touch || touch.has(id);
      for (const k of Object.keys(target)) if (k !== "documents" && k !== "library" && !own(p, k)) delete target[k];
      for (const [k, v] of Object.entries(p)) if (k !== "documents" && k !== "library" && (!own(target, k) || canon(target[k]) !== canon(v))) target[k] = v;
      const sync = (list, want, inner, docId) => {
        const have = new Map((list || []).map(o => [o.id, o]));
        const observe = touch && observers?.get(docId);
        const removed = observe ? new Map() : null;
        if (observe) for (const id of touch) { if (have.has(id)) removed.set(id, have.get(id)); }
        const result = want.map(w => {
          const cur = have.get(w.id);
          if (observe && touch.has(w.id)) { removed.delete(w.id); observe(cur || null, w); }
          if (!cur) return w;
          if (t(w.id)) { for (const k of Object.keys(cur)) if (!(k in w) && !(inner && k === "items")) delete cur[k]; for (const [k, v] of Object.entries(w)) if (!(inner && k === "items")) cur[k] = v; }
          if (inner) cur.items = sync(cur.items, w.items, false, w.id);
          return cur;
        });
        if (removed) for (const item of removed.values()) observe(item, null);
        return sameIds(list, result) ? list : result;
      };
      target.documents = sync(target.documents, p.documents, true);
      target.library = sync(target.library, p.library, false);
      return target;
    }

    return {
      replica, commit, receive, project: () => (view ??= project()), raw, preparePatch,
      patch: (target, touched, observers) => preparePatch(target, touched, observers).apply(), diff, forgetHistoryThrough,
      // Objects the view leaves out (set aside or invalid): how many, and an edit that removes them.
      hiddenCount: () => { view ??= project(); return hidden.size; },
      ownSeq: () => seqNo,   // this replica's edit count (create's o.ownSeq for a rejoin)
      discardHidden() {
        view ??= project();
        const ops = [...hidden].filter(id => objs.has(id)).map(id => ({t: "rem", o: id, tags: live(id)})).filter(op => op.tags.length);
        if (!ops.length) return null;
        const related = local(ops, true);
        return batch(ops, related);
      },
      undo: () => step(undoStack, redoStack, false), redo: () => step(redoStack, undoStack, true),
      historyTouches, canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0,
      vv: vector, since, trim, snapshot, load: snap => load(snap), merge, stats: () => ({...stats, log: log.length, objects: objs.size, clock}),
      // Objects a batch touches (soft locks and activity read these).
      touches: b => new Set([...(b?.related || []), ...(b?.ops || []).map(operationTarget).filter(Boolean)]),
      // Re-stamps nothing: the state of one object (tests, soft locks).
      object: id => { const x = objs.get(id); return x ? {visible: visible(x), parent: x.parent, ...fields(x)} : null; }
    };
  }

  return Object.freeze({create, canon, between, spread, seqEdits, checkOp, cleanValue, reviewOperation, LIMITS, LIB, DOCS});
})();
