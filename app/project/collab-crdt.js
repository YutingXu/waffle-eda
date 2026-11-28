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
  // A key strictly between a ("" = start) and b (null = end). Keys never end in "0" (validPos), so
  // one exists whenever a < b; otherwise (a >= b, or b is a followed by zeros) this throws, never loops.
  const validPos = v => typeof v === "string" && /^[0-9A-Za-z]{0,63}[1-9A-Za-z]$/.test(v);
  function between(a, b) {
    a = a || ""; let out = "";
    for (let i = 0; ; i++) {
      if (b != null && i >= a.length && i >= b.length) throw RangeError("No position key lies between " + a + " and " + b + ".");
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
      if (op.a === "pos" && op.rank !== null && !validPos(op.v)) throw Error("op pos");
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
          if (r.at !== null && key === "pos" && !validPos(r.v)) throw Error("op pos");
          if (r.at !== null && key === "p") checkId(r.v, "location");
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
        if (op.pos != null && !validPos(op.pos)) throw Error("op pos");
        break;
      case "rem": checkId(op.o, "object"); if (!Array.isArray(op.tags) || op.tags.length > 64) throw Error("op tags"); op.tags.forEach(t => checkId(t, "tag")); break;
      case "set": checkId(op.o, "object"); checkKey(op.k); if (op.k === "id" || op.k === "items") throw Error("op key"); break;
      case "pos": checkId(op.o, "object"); if (!validPos(op.v)) throw Error("op pos"); break;
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
    const validate = o.validate !== undefined ? o.validate : ((p, options) => globalThis.Atrium?.validate?.(p, options));
    // The materialised view is kept between edits and brought up to date for the objects an
    // edit touched (refresh). Model validation of those objects uses Atrium.validate's scoped
    // mode, so only the default validator (or none) allows it; o.incremental: false always
    // rebuilds the view (the reference path the differential test compares against).
    const incremental = o.incremental !== false && (o.validate === undefined || o.validate === null);
    // o.owner: the replica id allowed to change the format stamp (FORMAT_KEYS). o.ownSeq: how many
    // edits this replica id made before (a rejoin in the same window); a snapshot may show up to that many.
    const owner = typeof o.owner === "string" ? o.owner : undefined, ownSeq = Number.isSafeInteger(o.ownSeq) && o.ownSeq > 0 ? o.ownSeq : 0;
    let clock = 0, seqNo = 0;
    const objs = new Map(), kids = new Map(), meta = new Map();
    const vv = new Map(), extra = new Set(), floor = new Map();
    const cellPatchHints = new WeakMap();
    let log = [], undoStack = [], redoStack = [], view = null, verdicts = new Map();
    // refreshed / rebuilt: views brought up to date for the touched objects / materialised whole.
    // audits / repairs / repairedOps: whole-project comparisons (audit) and the differences they published.
    const stats = {applied: 0, rejected: 0, buffered: 0, filtered: 0, refreshed: 0, rebuilt: 0, audits: 0, repairs: 0, repairedOps: 0};

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
    // Project-level keys: the meta registers and the review records.
    function topLevel() {
      const p = {};
      for (const [k, r] of meta) if (r.v !== undefined) p[k] = clone(r.v);
      const rows = children(REVIEW);
      if (rows.length) {
        p.review ??= {version: 1, records: {}};
        for (const x of rows) { const r = nativeReviewRow(fields(x)); p.review.records[r.id] = r; }
      }
      return p;
    }
    function raw(tableOwner) {
      const p = topLevel();
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
      clean = false;
      if (!validate) { hidden = new Set(); clean = !own(p, COMPAT); return p; }
      try {
        const out = shown(p, validate(validationCopy(p, tableOwner)));
        // The whole project validated: what each object's validity depends on is known (refresh).
        clean = !hidden.size && !own(p, COMPAT) && !own(out, COMPAT);
        return out;
      } catch { /* filter below */ }
      // A verdict holds for the object's version, the library's and the context it was judged in:
      // the format stamp (shell) and, for an item, its document.
      const context = JSON.stringify(shell(p));
      const lib = p.library.filter(d => ok(d.id, () => validate({...shell(p), library: [clone(d)], documents: [{id: "#v", kind: "schematic", name: "v", grid: 1, items: [], outline: [], notes: []}]}), context));
      // Items are judged with the valid definitions: their content (a definition's shown geometry
      // can change with the parts that use it, without an edit of its own).
      const libKey = context + "/" + digest(JSON.stringify(lib));
      const docs = [];
      for (const d of p.documents) {
        const inDoc = libKey + "/" + d.id + "@" + (objs.get(d.id)?.ver ?? 0);
        const items = d.items.filter(i => ok(i.id, () => validate(clone({...shell(p), library: lib, documents: [{...d, items: [i]}]})), inDoc));
        const doc = {...d, items: []};
        if (ok(d.id, () => validate(clone({...shell(p), library: lib, documents: [doc]})), libKey)) { doc.items = items; docs.push(doc); }
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
    function ok(id, test, context) {
      const x = objs.get(id), key = id + "@" + (x?.ver ?? 0) + "/" + context;
      if (verdicts.has(key)) return verdicts.get(key);
      let good = true; try { test(); } catch { good = false; stats.filtered++; }
      if (verdicts.size > 50000) verdicts = new Map();
      verdicts.set(key, good); return good;
    }
    // FNV-1a over a string, as two 32-bit halves (verdict keys).
    function digest(text) {
      let a = 0x811c9dc5, b = 0x9747b28c;
      for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); a = Math.imul(a ^ c, 16777619); b = Math.imul(b ^ c, 0x5bd1e995); }
      return (a >>> 0).toString(36) + (b >>> 0).toString(36) + text.length.toString(36);
    }

    // ---- the view, brought up to date for what an edit touched ---------------------------------
    // The view is internal: project() hands out a copy and patches write copies, so nothing outside
    // can change it. stale: the objects applied operations touched since it was last brought up to
    // date. refresh() replaces exactly those objects and validates exactly those, which is the
    // same verdict as validating the whole project when the previous view validated whole (clean)
    // and nothing the touched objects' validity depends on changed outside them. Atrium.validate's
    // checks that reach beyond one object, and how they are kept:
    //   * unique ids: structural. Every id is one replica object with one parent register.
    //   * a part needs its library definition (geometry for the document's kind), every item is
    //     judged by its document's kind and by the forward-compatibility stamp (atriumCompat):
    //     a touched library definition, a changed document kind or an atriumCompat key rebuilds.
    //   * a panel or drawing has no items; a board with sourceHatchSignature needs a hatched track
    //     (itemDependent): a touched item or field of such a document rebuilds.
    //   * once something does not validate, the file-load fallback judges objects in other
    //     contexts (shell documents, valid definitions only), so only a clean view is refreshed;
    //     a touched object that fails validation rebuilds (and the fallback filters it).
    // A new Atrium.validate rule that reads across objects must be added to this list.
    // tests/project/collab-scoped-equivalence.cjs compares this with the full rebuild and guards it;
    // audit() at save and before leaving publishes and counts anything this path missed.
    let stale = null, clean = false, viewDocs = null, viewItems = null, viewLib = null;
    const itemDependent = d => (d.kind !== "pcb" && d.kind !== "schematic") || d.pcbDrawing?.sourceHatchSignature !== undefined;
    function dirty(ids) {
      if (!stale) { view = null; return; }
      for (const id of ids) if (id) stale.add(id);
    }
    function current(tableOwner) {
      if (view && stale && (!stale.size || refresh(stale, tableOwner))) { if (stale.size) stats.refreshed++; stale.clear(); return view; }
      view = project(tableOwner); viewDocs = viewItems = viewLib = null; stats.rebuilt++;
      stale = incremental ? new Set() : null;
      return view;
    }
    function indexView() {
      viewDocs = new Map(); viewItems = new Map(); viewLib = new Set(view.library.map(d => d.id));
      for (const d of view.documents) { viewDocs.set(d.id, d); for (const i of d.items) viewItems.set(i.id, d); }
    }
    function placeIn(items, x) {
      let lo = 0, hi = items.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (byPos(objs.get(items[mid].id), x) < 0) lo = mid + 1; else hi = mid; }
      return lo;
    }
    function refresh(ids, tableOwner) {
      if (!clean) return false;
      if (!viewDocs) indexView();
      let top = null;
      const docEdits = new Map(), changes = [];
      for (const id of ids) {
        if (id === "#meta") { top = topLevel(); continue; }
        const x = objs.get(id);
        if (viewLib.has(id) || x?.parent === LIB) {
          if (viewLib.has(id) || visible(x)) return false;   // definitions: parts depend on them
          continue;
        }
        if (viewDocs.has(id)) {
          if (!x || x.parent !== DOCS || !visible(x)) return false;
          docEdits.set(id, fields(x)); continue;
        }
        if (x?.parent === DOCS) { if (visible(x)) return false; continue; }   // a new document
        const was = viewItems.get(id), now = x && visible(x) ? viewDocs.get(x.parent) : undefined;
        if (was || now) changes.push({x, id, was, now});
      }
      // Validate everything first; the view changes only when all of it is accepted.
      if (top && own(top, COMPAT)) return false;
      const scoped = new Map(), docOf = new Map();
      for (const [id, f] of docEdits) {
        const old = viewDocs.get(id);
        if (f.kind !== old.kind || itemDependent(f) || itemDependent(old)) return false;
        const copy = clone({...f, items: []});
        scoped.set(copy, null); docOf.set(id, copy);
      }
      const added = new Map();
      for (const c of changes) {
        for (const d of [c.was, c.now]) if (d && (itemDependent(d) || itemDependent(docEdits.get(d.id) || d))) return false;
        if (!c.now) continue;
        c.f = fields(c.x, tableOwner);
        let shell = docOf.get(c.now.id);
        if (!shell) { shell = {id: c.now.id, kind: c.now.kind}; docOf.set(c.now.id, shell); }
        if (scoped.get(shell) === null) shell.items.push(clone(c.f));   // a document validated whole
        else { if (!scoped.has(shell)) scoped.set(shell, []); scoped.get(shell).push(clone(c.f)); }
        if (!added.has(c.now)) added.set(c.now, []);
        added.get(c.now).push(c);
      }
      if (validate) {
        try {
          if (top) validate({...top, library: view.library, documents: view.documents}, {normalize: false, scoped: new Map()});
          if (scoped.size) validate({format: "atrium", version: 1, name: "Project", library: view.library, documents: [...scoped.keys()]}, {normalize: false, scoped});
        } catch { return false; }
      }
      // Accepted: replace the touched objects in the view.
      if (top) view = {...top, library: view.library, documents: view.documents};
      for (const [id, f] of docEdits) {
        const d = viewDocs.get(id);
        for (const k of Object.keys(d)) if (k !== "items" && !own(f, k)) delete d[k];
        for (const [k, v] of Object.entries(f)) d[k] = v;
      }
      if (docEdits.size) view.documents.sort((a, b) => byPos(objs.get(a.id), objs.get(b.id)));
      // An item that stays between its untouched neighbours is replaced where it is.
      for (const c of changes) if (c.was && c.was === c.now) {
        const items = c.was.items, i = items.findIndex(it => it.id === c.id), l = items[i - 1], r = items[i + 1];
        if ((!l || !ids.has(l.id) && byPos(objs.get(l.id), c.x) < 0) && (!r || !ids.has(r.id) && byPos(c.x, objs.get(r.id)) < 0)) {
          items[i] = c.f; c.was = c.now = null;
        }
      }
      // Membership and order: removals, then insertions at the keys' places. Each list's change is
      // logged ({to, removed: [[old index, id]] descending, added: [[new index, id]] ascending}) so
      // an editor list that matched the previous shape can replay it (preparePatch).
      const moves = new Map(), log = d => { if (!moves.has(d)) moves.set(d, {removed: [], added: []}); return moves.get(d); };
      for (const c of changes) if (c.was) { log(c.was).removed.push(c.id); viewItems.delete(c.id); }
      for (const c of changes) if (c.now) { log(c.now).added.push(c); viewItems.set(c.id, c.now); }
      for (const [d, m] of moves) {
        const gone = new Set(m.removed), at = [];
        if (gone.size <= 8) for (const id of gone) at.push([d.items.findIndex(i => i.id === id), id]);
        else d.items.forEach((i, k) => { if (gone.has(i.id)) at.push([k, i.id]); });
        at.sort((a, b) => b[0] - a[0]);
        const list = m.added.sort((a, b) => byPos(a.x, b.x)), small = at.length + list.length <= 32;
        let kept = d.items;
        if (small) for (const [k] of at) kept.splice(k, 1);
        else if (at.length) { const drop = new Set(at.map(r => r[0])); kept = kept.filter((_, n) => !drop.has(n)); }
        // Where each added item goes among the kept ones (non-decreasing, as the list is sorted).
        const places = list.map(c => placeIn(kept, c.x));
        if (small) { list.forEach((c, j) => kept.splice(places[j] + j, 0, c.f)); d.items = kept; }
        else {
          const out = new Array(kept.length + list.length);
          for (let i = 0, j = 0, w = 0; w < out.length;) out[w++] = j < list.length && places[j] === i ? list[j++].f : kept[i++];
          d.items = out;
        }
        shapes.set(d, (shapes.get(d) || 0) + 1);
        changeLog.set(d, {to: shapes.get(d), removed: at, added: list.map((c, j) => [places[j] + j, c.id])});
      }
      return true;
    }
    // Lists whose membership or order changed: shapes counts each change of a view list, synced
    // records the shape an editor list is known to match, changeLog the last change of each view
    // list. An editor list one change behind replays it instead of comparing the whole list.
    const shapes = new WeakMap(), synced = new WeakMap(), changeLog = new WeakMap();

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
      diffMeta(ops, cur, next);
      diffList(ops, LIB, cur.library, next.library || [], false);
      diffList(ops, DOCS, cur.documents, next.documents || [], true);
      return ops;
    }
    function diffMeta(ops, cur, next) {
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
      try {
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
      } catch (e) {
        if (!(e instanceof RangeError)) throw e;
        return spread(after.length); // no key fits between two kept positions: renumber the list
      }
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
    function diffUpdates(next, updates, structure) {
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
      if (structure?.length) return diffStructure(structure, items);
      items.sort((a, b) => a.parent === b.parent ? byPos(a.x, b.x) : byPos(a.parent, b.parent));
      const ops = [];
      for (const item of items) {
        diffWidgetLists(ops, item.after, item.shared);
        diffFields(ops, item.after, item.shared, false);
      }
      return ops;
    }
    // Items added to, removed from or moved within a document, as the Undo journal records them
    // ({doc, items: the live list, added: [item], removed: [id]}), with the items changed in place.
    // The ops are the full diff's (diffList), in its order: per document, rem for each removed
    // item, pos, add (revived) or addOp for each run of added items with the fractional keys
    // keysForOrder gives the run between its two unchanged neighbours, then the field diffs in
    // list order. check() confirms after applying that the replica holds each touched item as the
    // editor does, in order (otherwise the next commit compares the whole project).
    function diffStructure(structure, inPlace) {
      const perDoc = new Map(), checks = [];
      const group = doc => { if (!perDoc.has(doc)) perDoc.set(doc, {rems: [], places: [], jobs: []}); return perDoc.get(doc); };
      for (const item of inPlace) group(item.parent.id).jobs.push({key: item.x.pos.v, id: item.x.id, run() {
        const ops = []; diffWidgetLists(ops, item.after, item.shared); diffFields(ops, item.after, item.shared, false); return ops;
      }});
      for (const {doc, items, added, removed} of structure) {
        const parent = objs.get(doc), inDoc = x => !!x && x.parent === doc && visible(x);
        if (!parent || parent.parent !== DOCS || !visible(parent) || !Array.isArray(items) || !Array.isArray(added) || !Array.isArray(removed)) return null;
        const g = group(doc), present = new Set(added.map(o => o?.id)), gone = [];
        for (const id of removed) {
          if (present.has(id)) continue;   // replaced by another object with the same id
          const x = objs.get(id);
          if (!inDoc(x)) return null;
          gone.push(x);
          checks.push(() => !inDoc(objs.get(id)));
        }
        gone.sort(byPos);
        for (const x of gone) g.rems.push({t: "rem", o: x.id, tags: live(x.id)});
        if (!added.length) continue;
        let at;
        if (added.length > 16) { const m = new Map(); items.forEach((o, i) => m.set(o, i)); at = added.map(o => m.get(o)); }
        else at = added.map(o => items.lastIndexOf(o));
        at.sort((a, b) => a - b);
        if (at.some((i, k) => i === undefined || i < 0 || at[k - 1] === i)) return null;
        for (let k = 0; k < at.length;) {
          let end = k; while (end + 1 < at.length && at[end + 1] === at[end] + 1) end++;
          const from = at[k], to = at[end], run = items.slice(from, to + 1);
          const left = from > 0 ? items[from - 1] : null, right = to + 1 < items.length ? items[to + 1] : null;
          const L = left && objs.get(left.id), R = right && objs.get(right.id);
          if (left && !inDoc(L) || right && !inDoc(R) || L && R && L.pos.v >= R.pos.v) return null;
          if (run.some(o => !isObj(o) || typeof o.id !== "string")) return null;
          // Items of the run that already sit between the neighbours keep their keys when in order.
          const between = run.map(o => objs.get(o.id)).filter(x => inDoc(x) && (!L || byPos(L, x) < 0) && (!R || byPos(x, R) < 0));
          const positions = new Map(between.map(x => [x.id, x.pos.v]));
          const stay = new Set(lis(between, [...between].sort(byPos)));
          const window = [...(left ? [left] : []), ...run, ...(right ? [right] : [])];
          if (left) { stay.add(left.id); positions.set(left.id, L.pos.v); }
          if (right) { stay.add(right.id); positions.set(right.id, R.pos.v); }
          const keys = keysForOrder(window, stay, positions);
          if ((left && keys[0] !== L.pos.v) || (right && keys.at(-1) !== R.pos.v) || keys.some((key, i) => i && !(keys[i - 1] < key))) return null;
          run.forEach((o, i) => {
            const pos = keys[i + (left ? 1 : 0)], x = objs.get(o.id);
            if (inDoc(x)) { if (pos !== x.pos.v) g.places.push({t: "pos", o: o.id, v: pos}); }
            else if (x) g.places.push({t: "add", o: o.id, p: doc, tag: "", pos});
            else g.places.push(addOp(o, doc, pos, false));
            g.jobs.push({key: pos, id: o.id, run() {
              const ops = [];
              if (x) { const was = fields(x); diffWidgetLists(ops, o, was); diffFields(ops, o, was, false); }
              else diffWidgetLists(ops, o, {});
              return ops;
            }});
          });
          checks.push(() => {
            const xs = window.map(o => objs.get(o.id));
            return xs.every((x, i) => inDoc(x) && (!i || byPos(xs[i - 1], x) < 0)) &&
              run.every(o => canon(fields(objs.get(o.id))) === canon(o));
          });
          k = end + 1;
        }
      }
      // Field diffs read the replica before any of this batch applies, as the full diff does.
      const ops = [];
      for (const doc of [...perDoc.keys()].sort((a, b) => byPos(objs.get(a), objs.get(b)))) {
        const g = perDoc.get(doc);
        g.jobs.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
        ops.push(...g.rems, ...g.places);
        for (const job of g.jobs) ops.push(...job.run());
      }
      Object.defineProperty(ops, "check", {value: () => checks.every(f => f())});
      return ops;
    }
    // After a full diff: the replica holds what the diff targeted as the editor does. Only an
    // operation without effect (an owner-only format key, say) leaves them apart.
    function agrees(next, ops) {
      if (hidden.size || next[COMPAT]) return true;   // set-aside objects: every commit is a full diff
      const targets = new Set(ops.map(operationTarget));
      if (targets.has("#meta")) {
        const metaOps = [];
        try { diffMeta(metaOps, topLevel(), next); } catch { return false; }
        if (metaOps.length) return false;
        targets.delete("#meta");
      }
      if (!targets.size) return true;
      const docs = new Map((next.documents || []).map(d => [d.id, d])), library = new Map((next.library || []).map(d => [d.id, d]));
      const lists = new Map();
      const itemOf = (doc, id) => {
        if (!lists.has(doc)) lists.set(doc, new Map((docs.get(doc)?.items || []).map(i => [i.id, i])));
        return lists.get(doc).get(id);
      };
      const without = o => { const {items, ...rest} = o; return rest; };
      for (const id of targets) {
        const x = objs.get(id);
        if (!x) return false;
        const shown = visible(x);
        if (docs.has(id) || x.parent === DOCS) {
          if (!shown || x.parent !== DOCS || !docs.has(id) || canon(fields(x)) !== canon(without(docs.get(id)))) return false;
        } else if (library.has(id) || x.parent === LIB) {
          if (!shown || x.parent !== LIB || !library.has(id) || canon(fields(x)) !== canon(library.get(id))) return false;
        } else {
          const inDoc = shown && objs.get(x.parent)?.parent === DOCS, want = docs.has(x.parent) ? itemOf(x.parent, id) : undefined;
          if (inDoc !== !!want || want && canon(fields(x)) !== canon(want)) return false;
        }
      }
      return true;
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
      // Objects set aside before this edit (only while some are: every commit then diffs the whole
      // project anyway). Those it brings back by making the whole valid again are related, so the
      // editor receives them in this edit's patch; otherwise it would lack them, and the next full
      // diff (the audit at save) would publish their removal.
      const aside = hidden.size ? (current(), new Set(hidden)) : null;
      const group = [], touched = new Set();
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
        touched.add(apply(op));
      }
      for (const op of ops) if (op.t === "ins" && typeof op.after === "object" && op.after) op.after = op.after.e;
      const related = [...new Set([...changedDependencies(dependencies), ...projections])];
      dirty(touched); dirty(related);
      if (aside?.size) {
        current();
        for (const id of aside) if (!hidden.has(id) && objs.has(id) && visible(objs.get(id)) && !related.includes(id)) related.push(id);
      }
      if (record && group.length) { undoStack.push(group); if (undoStack.length > LIMITS.undo) undoStack.shift(); redoStack = []; }
      return related;
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
    // verify: the last commit could not confirm that the replica holds the editor's project, so
    // the next one compares the whole project (diff) before relying on a journal range again.
    let verify = false;
    /** @param {any} next @param {{recordUndo?: boolean, updates?: Array<{doc:string, before:any, after:any, tableEdit?:{id:string, before:any, after:any, beforeJSON:string, afterJSON:string, beforeVersion?:object, afterVersion?:object}}>, structure?: Array<{doc:string, items:any[], added:any[], removed:string[]}>, reconcile?: (ops:any[]) => boolean | Set<string>}} [options] */
    function commit(next, {recordUndo = true, updates, structure, reconcile, full = false} = {}) {
      const tableOps = full || structure?.length ? null : diffTableEdit(next, updates), scoped = full ? null : tableOps ?? diffUpdates(next, updates, structure);
      let ops = scoped && !verify ? scoped : diff(next), shape = ops === scoped && scoped.check ? scoped : null;
      // A precise rollback can reject whole items and their children.
      // Looking at the live editor again could capture a later, unfinished drag.
      // A structural rollback can also change membership, order and dependencies.
      if (ops.length && reconcile) {
        const rejected = reconcile(ops);
        if (rejected instanceof Set && ops === scoped) ops = scoped.filter(op => !rejected.has(operationTarget(op)));
        else if (rejected) { ops = diff(next); shape = null; }
      }
      if (!ops.length) { verify = false; return null; }
      // The editor's lists this commit reshaped and that matched the view before it (see synced).
      const lists = shape && view && stale && !stale.size && viewDocs ? structure.map(e => [e.items, viewDocs.get(e.doc)])
        .filter(([list, d]) => d && synced.get(list) === (shapes.get(d) || 0)) : [];
      const related = local(ops, recordUndo);
      // A structural or legacy edit can be unrepresentable (for example an owner-only format
      // field): confirm on what this commit touched that the replica now holds the editor's
      // project; when it does not, the next commit compares the whole project.
      verify = shape ? !shape.check() : ops === scoped ? false : !agrees(next, ops);
      // The view now holds this edit (refresh, proportional to it): those editor lists match it.
      if (lists.length && !verify && current() && viewDocs) for (const [list, d] of lists) if (viewDocs.get(d.id) === d) synced.set(list, shapes.get(d) || 0);
      if (ops === tableOps && !verify) {
        const edit = updates[0].tableEdit, id = edit.id;
        verifiedTable = {id, ver: objs.get(id).ver, version: edit.afterVersion,
          json: edit.afterVersion === undefined ? edit.afterJSON : undefined};
      }
      if (!recordUndo) { undoStack = []; redoStack = []; }
      return batch(ops, related);
    }
    // The whole-project comparison at the session's natural pauses (save, leaving): a change the
    // journal did not report (an edit without its hint) or a validity rule refresh does not know
    // is published here instead of surviving, and counted, so it is visible rather than silent.
    function audit(next, options) {
      stats.audits++;
      const b = commit(next, {...options, full: true});
      if (b) { stats.repairs++; stats.repairedOps += b.ops.length; }
      return b;
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
        for (const id of changedDependencies(dependencies)) touched.add(id);
        dirty(touched);
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
    // reaches back that far (send a snapshot instead). With `author`, only that replica's ops
    // (a guest catching someone up sends its own edits alone).
    function since(want = {}, author) {
      for (const [r, n] of floor) if ((author === undefined || r === author) && (want[r] || 0) < n) return null;
      return log.filter(op => (author === undefined || op.ts.r === author) && (want[op.ts.r] || 0) < op.n).map(clone);
    }
    // Bounded log: past the limit, the oldest operations are dropped (the newest LIMITS.log / 2
    // stay); peers that far behind get a snapshot. `keep`: this replica's own operations above that
    // sequence number stay however old, because the host has not confirmed them yet (a guest never
    // discards its own edits before the host has them). The caller bounds them (unsent()).
    function trim(keep = Infinity) {
      if (log.length <= LIMITS.log) return false;
      const cut = log.length - (LIMITS.log >> 1), kept = [];
      log.forEach((op, i) => {
        if (i >= cut || op.ts.r === replica && op.n > keep) kept.push(op);
        else floor.set(op.ts.r, Math.max(floor.get(op.ts.r) || 0, op.n));
      });
      if (kept.length === log.length) return false;
      log = kept;
      return true;
    }
    // This replica's own operations above `keep` still in the log: how many, and their size as JSON
    // (measured once per operation).
    const sizes = new WeakMap();
    function unsent(keep = 0) {
      let ops = 0, bytes = 0;
      for (const op of log) if (op.ts.r === replica && op.n > keep) {
        let n = sizes.get(op);
        if (n === undefined) sizes.set(op, n = JSON.stringify(op).length);
        ops++; bytes += n;
      }
      return {ops, bytes};
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
        if (pos && pos.ts?.c !== -1) {
          const r = read(pos);
          for (const w of r.writers || [r]) if (w.at !== null && w.v !== undefined && !validPos(w.v)) throw Error("snapshot pos");
          x.pos = joinReg(x.pos, r); legacyWitness(pos.ts);
        }
        trackContainer(x); if (x.seqs.get("points")?.creations) trackPath(x);
      }
      view = null; stale = null; verifiedTable = undefined; referencedDefs = null; verdicts.clear();
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
      view = null; stale = null;
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
      // Incoming values always go through the complete model/compatibility validator: the whole
      // project, or (current) the touched objects of a view that validated whole. A plan writes
      // copies, so neither the editor nor the view can change the other.
      const hint = cellPatchHints.get(touched), p = current(hint?.item), touch = touched ? new Set(touched) : null;
      const full = {apply: () => patchLists(target, p, touch, observers)};
      if (!touch || !sameIds(target.documents, p.documents) || !sameIds(target.library, p.library)) return full;
      for (let i = 0; i < p.library.length; i++) {
        const def = p.library[i];
        if (touch.has(def.id) && canon(target.library[i]) !== canon(def)) return full;
      }
      // Project keys (callers' touched sets do not name them: compare them all).
      const top = [];
      for (const k of new Set([...Object.keys(target), ...Object.keys(p)])) {
        if (k === "documents" || k === "library") continue;
        if (!own(p, k)) top.push([k]);
        else if (!own(target, k) || canon(target[k]) !== canon(p[k])) top.push([k, p[k]]);
      }
      const where = stale && clean && view === p ? (viewItems || (indexView(), viewItems)) : null;
      const placed = new Set();
      if (where) for (const id of touch) { const d = where.get(id); if (d) placed.add(d.id); }
      const scopes = [], writes = [], docWrites = [], lists = [], syncs = [];
      for (let d = 0; d < p.documents.length; d++) {
        const doc = target.documents[d], want = p.documents[d], items = [];
        let changed = false;
        if (touch.has(doc.id) && !sameFields(doc, want, ["items"])) { docWrites.push([doc, want]); changed = true; }
        const observe = observers?.get(doc.id), list = doc.items, wanted = want.items, shape = shapes.get(want) || 0;
        let reorder = list.length !== wanted.length || !where || synced.get(list) !== shape;
        if (!reorder && placed.has(doc.id)) for (const id of touch) {
          if (where.get(id) !== want) continue;
          const i = list.findIndex(it => it.id === id);
          if (i < 0 || wanted[i]?.id !== id) { reorder = true; break; }
        }
        const replay = reorder && where && replayPlan(list, want, shape, touch, hint, observe, where);
        if (replay) {
          lists.push(replay); changed = true; syncs.push([list, shape]);
          for (const w of replay.writes) { items.push(w.before); writes.push(w); }
        } else if (reorder && (list.length !== wanted.length || (where ? placed.has(doc.id) : wanted.some(w => touch.has(w.id))))) {
          // Membership or order may have changed: one pass over the list, untouched items in order.
          const have = new Map();
          for (const it of list) if (touch.has(it.id)) have.set(it.id, it);
          const out = new Array(wanted.length), added = [];
          let i = 0, same = list.length === wanted.length;
          for (let j = 0; j < wanted.length; j++) {
            const w = wanted[j];
            if (touch.has(w.id)) {
              const cur = have.get(w.id);
              have.delete(w.id);
              if (!cur) { out[j] = clone(w); added.push(out[j]); same = false; continue; }
              out[j] = cur;
              const changedWidget = tableCellDiffers(cur, w, hint);
              if (changedWidget || canon(cur) !== canon(w)) { items.push(cur); writes.push({before: cur, after: w, observe, changedWidget}); }
            } else {
              while (i < list.length && touch.has(list[i].id)) i++;
              if (list[i]?.id !== w.id) return full;
              out[j] = list[i++];
            }
            if (out[j] !== list[j]) same = false;
          }
          while (i < list.length && touch.has(list[i].id)) i++;
          if (i !== list.length) return full;
          if (!same) { lists.push({list, out, added, removed: [...have.values()], observe}); changed = true; }
          if (where) syncs.push([list, shape]);
        } else if (!reorder) {
          // The list matches: only the touched items, where they are.
          if (where) syncs.push([list, shape]);
          if (placed.has(doc.id)) for (const id of touch) {
            if (where.get(id) !== want) continue;
            const i = list.findIndex(it => it.id === id), before = list[i], after = wanted[i];
            const changedWidget = tableCellDiffers(before, after, hint);
            if (!changedWidget && canon(before) === canon(after)) continue;
            items.push(before);
            writes.push({before, after, observe, changedWidget});
          }
        } else for (let i = 0, last = wanted.length - 1; i <= last; i++) {
          const before = list[i], after = wanted[i];
          if (before.id !== after.id) return full;
          if (i === last && where) syncs.push([list, shape]);
          if (!touch.has(after.id)) continue;
          // A changed cell in the validated widget proves this field needs
          // replacement. Unchanged cells and other edits use the complete diff.
          const changedWidget = tableCellDiffers(before, after, hint);
          if (!changedWidget && canon(before) === canon(after)) continue;
          items.push(before);
          writes.push({before, after, observe, changedWidget});
        }
        if (items.length || changed) scopes.push({doc, items});
      }
      if (top.length && !scopes.length) scopes.push({doc: target.documents[0], items: []});
      return {scopes, apply() {
        for (const [k, v] of top) if (v === undefined) delete target[k]; else target[k] = clone(v);
        for (const [doc, want] of docWrites) {
          for (const k of Object.keys(doc)) if (k !== "items" && !own(want, k)) delete doc[k];
          for (const [k, v] of Object.entries(want)) if (k !== "items" && (!own(doc, k) || canon(doc[k]) !== canon(v))) doc[k] = clone(v);
        }
        for (const {before, after, observe, changedWidget} of writes) {
          observe?.(before, after);
          for (const k of Object.keys(before)) if (!own(after, k)) delete before[k];
          for (const [k, v] of Object.entries(after)) {
            if (k === "widget" && changedWidget || !own(before, k) || canon(before[k]) !== canon(v)) before[k] = clone(v);
          }
        }
        // In place, as a local edit changes a list: caches keyed by the list stay valid.
        for (const {list, out, added, removed, observe, at, to} of lists) {
          if (observe) { for (const item of added) observe(null, item); for (const item of removed) observe(item, null); }
          if (at) {   // a replayed change: removals (descending), then insertions (ascending)
            if (at.length + to.length <= 32) { for (const [i] of at) list.splice(i, 1); for (const [i, item] of to) list.splice(i, 0, item); }
            else {
              const gone = new Set(at.map(([i]) => i)), kept = list.filter((_, i) => !gone.has(i));
              list.length = kept.length + to.length;
              for (let i = 0, j = 0, w = 0; w < list.length;) list[w++] = j < to.length && to[j][0] === w - 1 ? to[j++][1] : kept[i++];
            }
            continue;
          }
          for (let j = 0; j < out.length; j++) list[j] = out[j];
          list.length = out.length;
        }
        for (const [list, shape] of syncs) synced.set(list, shape);
        return target;
      }};
    }
    // An editor list that matched the view list one change ago: the plan that replays that change
    // (removals and insertions by index, checked against the ids) and the field writes of the
    // touched items that stay; null when the list cannot be shown to match.
    function replayPlan(list, want, shape, touch, hint, observe, where) {
      const change = changeLog.get(want), wanted = want.items;
      if (!change || change.to !== shape || synced.get(list) !== shape - 1) return null;
      if (list.length - change.removed.length + change.added.length !== wanted.length) return null;
      const before = new Map();
      for (const [i, id] of change.removed) { if (list[i]?.id !== id) return null; before.set(id, list[i]); }
      const writes = [], added = [], removed = [], to = [], placed = new Set();
      for (const [i, id] of change.added) {
        const w = wanted[i];
        if (w?.id !== id) return null;
        placed.add(id);
        const cur = before.get(id);
        before.delete(id);
        if (!cur) { const item = clone(w); added.push(item); to.push([i, item]); continue; }
        to.push([i, cur]);
        const changedWidget = tableCellDiffers(cur, w, hint);
        if (changedWidget || canon(cur) !== canon(w)) writes.push({before: cur, after: w, observe, changedWidget});
      }
      removed.push(...before.values());
      // Touched items of this list that kept their place (a field edit beside the change).
      const left = new Set(change.removed.map(r => r[1]));
      for (const id of touch) {
        if (where.get(id) !== want || placed.has(id) || left.has(id)) continue;
        const i = list.findIndex(it => it.id === id);
        if (i < 0) continue;
        const x = objs.get(id), j = x ? placeIn(wanted, x) : -1, w = wanted[j];
        if (w?.id !== id) return null;
        const cur = list[i], changedWidget = tableCellDiffers(cur, w, hint);
        if (changedWidget || canon(cur) !== canon(w)) writes.push({before: cur, after: w, observe, changedWidget});
      }
      return {list, at: change.removed, to, added, removed, observe, writes};
    }
    function patchLists(target, p, touch, observers) {
      const t = id => !touch || touch.has(id);
      for (const k of Object.keys(target)) if (k !== "documents" && k !== "library" && !own(p, k)) delete target[k];
      for (const [k, v] of Object.entries(p)) if (k !== "documents" && k !== "library" && (!own(target, k) || canon(target[k]) !== canon(v))) target[k] = clone(v);
      const sync = (list, want, inner, docId) => {
        const have = new Map((list || []).map(o => [o.id, o]));
        const observe = touch && observers?.get(docId);
        const removed = observe ? new Map() : null;
        if (observe) for (const id of touch) { if (have.has(id)) removed.set(id, have.get(id)); }
        const result = want.map(w => {
          const cur = have.get(w.id);
          if (observe && touch.has(w.id)) { removed.delete(w.id); observe(cur || null, w); }
          if (!cur) return clone(w);
          if (t(w.id)) { for (const k of Object.keys(cur)) if (!(k in w) && !(inner && k === "items")) delete cur[k]; for (const [k, v] of Object.entries(w)) if (!(inner && k === "items")) cur[k] = clone(v); }
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
      // project(): a copy of the view (the view itself is internal and kept between edits).
      replica, commit, audit, receive, project: () => clone(current()), raw, preparePatch,
      // {full: true}: the complete list synchronisation (the reference the scoped plan is tested against).
      patch: (target, touched, observers, {full = false} = {}) => full ? patchLists(target, current(), touched ? new Set(touched) : null, observers) : preparePatch(target, touched, observers).apply(),
      diff, forgetHistoryThrough,
      // Objects the view leaves out (set aside or invalid): how many, and an edit that removes them.
      hiddenCount: () => { current(); return hidden.size; },
      ownSeq: () => seqNo,   // this replica's edit count (create's o.ownSeq for a rejoin)
      discardHidden() {
        current();
        const ops = [...hidden].filter(id => objs.has(id)).map(id => ({t: "rem", o: id, tags: live(id)})).filter(op => op.tags.length);
        if (!ops.length) return null;
        const related = local(ops, true);
        return batch(ops, related);
      },
      undo: () => step(undoStack, redoStack, false), redo: () => step(redoStack, undoStack, true),
      historyTouches, canUndo: () => undoStack.length > 0, canRedo: () => redoStack.length > 0,
      vv: vector, since, trim, unsent, snapshot, load: snap => load(snap), merge, stats: () => ({...stats, log: log.length, objects: objs.size, clock}),
      // Objects a batch touches (soft locks and activity read these).
      touches: b => new Set([...(b?.related || []), ...(b?.ops || []).map(operationTarget).filter(Boolean)]),
      // Re-stamps nothing: the state of one object (tests, soft locks).
      object: id => { const x = objs.get(id); return x ? {visible: visible(x), parent: x.parent, ...fields(x)} : null; }
    };
  }

  return Object.freeze({create, canon, between, spread, seqEdits, checkOp, cleanValue, reviewOperation, LIMITS, LIB, DOCS});
})();
