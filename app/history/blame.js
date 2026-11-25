"use strict";
// "Who changed this object": semantic blame over the project's Git history (lazy).
//
//   AtriumBlame.engine        DOM-free: scan(lines), reverse(lines, hunks), Walk (the per-object history walk)
//   AtriumBlame.inspector(panel, host, item)   Read the last committed change to a selected object
//
// Native folder history uses verified, immutable Git snapshots, shared with Compare and History.
// The pure line walker also supports synthetic single-file fixtures for semantic comparison tests.
globalThis.AtriumBlame = (() => {
  const G = globalThis;
  const LOG_LIMIT = 400;

  // ------------------------------------------------------------------ engine (DOM-free)
  function indentOf(s) {
    let n = 0;
    while (n < 12 && s.charCodeAt(n) === 32) n++;
    return n;
  }
  const KEY_LINE = /^ *"((?:[^"\\]|\\.)*)": ?(.*)$/;
  const closes = (s, ind) => { const t = s.length - ind; return (t === 1 && s.charCodeAt(ind) === 125) || (t === 2 && s.charCodeAt(ind) === 125 && s.charCodeAt(ind + 1) === 44); };
  const closesArr = (s, ind) => { const t = s.length - ind; return (t === 1 && s.charCodeAt(ind) === 93) || (t === 2 && s.charCodeAt(ind) === 93 && s.charCodeAt(ind + 1) === 44); };
  function unquote(raw) { try { return JSON.parse(raw); } catch { return raw; } }
  // The structure of one version: top-level keys, the id'd objects of top-level arrays (documents,
  // library entries, review threads) and their arrays (items). keyOf(i) names the object line i belongs to.
  function scan(lines) {
    const tops = [], objs = [], arrs = [];
    let top = null, obj = null, arr = null;
    for (let i = 0; i < lines.length; i++) {
      const s = lines[i];
      const c0 = s.charCodeAt(0);
      if (c0 !== 32) { if (top) { top.end = i; top = null; } continue; }
      const ind = indentOf(s), c = s.charCodeAt(ind);
      if (ind === 2 && c === 34) {
        if (top) top.end = i;
        const m = KEY_LINE.exec(s);
        top = {start: i, end: lines.length, key: m ? unquote('"' + m[1] + '"') : "?"};
        tops.push(top); obj = null; arr = null;
      } else if (ind === 4 && c === 123 && top) {
        obj = {start: i, end: lines.length, id: null, section: top.key};
        objs.push(obj); arr = null;
        if (s.length - ind > 2) { obj.end = i + 1; obj.single = true; obj.id = idOfLine(s); obj = null; }
      } else if (ind === 4 && obj && closes(s, ind)) { obj.end = i + 1; obj = null; arr = null; }
      else if (ind === 6 && obj && c === 34) {
        const m = KEY_LINE.exec(s);
        if (!m) continue;
        const key = unquote('"' + m[1] + '"'), rest = m[2];
        if (key === "id") obj.id = unquote(rest.replace(/,$/, ""));
        else if (rest === "[") { arr = {start: i, end: lines.length, name: key, obj}; arrs.push(arr); }
      } else if (ind === 6 && arr && closesArr(s, ind)) { arr.end = i + 1; arr = null; }
    }
    const structured = tops.some(t => t.key === "documents");
    return {lines, tops, objs, arrs, structured, keyOf: i => keyOf(lines, tops, objs, arrs, i)};
  }
  function idOfLine(s) {
    try { const v = JSON.parse(s.trim().replace(/,$/, "")); return v && typeof v.id === "string" ? v.id : null; } catch { return null; }
  }
  function find(list, i) {
    let lo = 0, hi = list.length - 1, best = null;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (list[mid].start <= i) { best = list[mid]; lo = mid + 1; } else hi = mid - 1; }
    return best && i < best.end ? best : null;
  }
  function keyOf(lines, tops, objs, arrs, i) {
    const arr = find(arrs, i);
    if (arr && i > arr.start && i < arr.end - 1) {
      let s = i;
      while (s > arr.start + 1 && !(indentOf(lines[s]) === 8 && lines[s].charCodeAt(8) !== 32 && lines[s].charCodeAt(8) !== 125 && lines[s].charCodeAt(8) !== 93)) s--;
      let id = null;
      const line = lines[s], t = line.trim();
      if (t.endsWith("}") || t.endsWith("},")) id = idOfLine(line);
      else for (let k = s + 1; k < arr.end && k < s + 4000; k++) {
        const ind = indentOf(lines[k]);
        if (ind === 8) break;
        if (ind === 10 && lines[k].startsWith('"id": ', 10)) { id = unquote(lines[k].slice(16).replace(/,$/, "")); break; }
      }
      const owner = arr.obj;
      return owner.section + "/" + owner.id + "/" + arr.name + "/" + (id ?? "#" + (s - arr.start));
    }
    const obj = find(objs, i);
    if (obj) return obj.section + "/" + obj.id;
    const top = find(tops, i);
    return "project/" + (top ? top.key : "");
  }
  // The previous version: each hunk [oldStart, oldCount, newStart, newCount, removed, added] undone.
  function reverse(lines, hunks) {
    const out = [];
    let at = 0;
    for (const [, , c, d, removed] of hunks) {
      const upto = d === 0 ? c : c - 1;
      for (; at < upto; at++) out.push(lines[at]);
      for (const r of removed) out.push(r);
      at += d;
    }
    for (; at < lines.length; at++) out.push(lines[at]);
    return out;
  }
  const bare = s => s.trim().replace(/,$/, "");
  // Keys a commit changed, with the text of each side: Map key -> {added:[], removed:[]}.
  function touched(newS, oldS, hunks) {
    const out = new Map();
    const at = key => { let e = out.get(key); if (!e) out.set(key, e = {added: [], removed: []}); return e; };
    for (const [a, b, c, d, removed, added] of hunks) {
      for (let k = 0; k < d; k++) at(newS.keyOf(c - 1 + k)).added.push(added[k]);
      for (let k = 0; k < b; k++) at(oldS.keyOf(a - 1 + k)).removed.push(removed[k]);
    }
    for (const [key, e] of out) {
      if (e.added.length === e.removed.length && e.added.every((s, k) => bare(s) === bare(e.removed[k]))) { out.delete(key); continue; }
      // A field-only hunk in an expanded item cannot establish whether the item was added or
      // removed. Read both full versions so a new/removed field stays a change to the same item.
      if (key.startsWith("documents/") && key.includes("/items/") &&
          [e.added, e.removed].some(side => side.length && !(side[0].trimStart().startsWith("{") && bare(side.at(-1)).endsWith("}"))))
        return touchedParsed(newS.lines.join("\n"), oldS.lines.join("\n"));
      // Opening/closing lines of an array or object alone (a neighbour was added or removed) are not a change.
      if (e.added.concat(e.removed).every(s => /^[\]})[{,]*$/.test(bare(s)))) out.delete(key);
    }
    return out;
  }
  // Alternative formatting and partial item hunks: compare the parsed versions by ID.
  function touchedParsed(newText, oldText) {
    const out = new Map();
    let a, b;
    try { a = JSON.parse(newText); b = JSON.parse(oldText); } catch { return out; }
    const C = s => JSON.stringify(s);
    const idLists = (x, y) => (Array.isArray(x) || Array.isArray(y)) &&
      [x, y].every(v => v === undefined || Array.isArray(v) && v.every(o => o && typeof o.id === "string"));
    const mark = (key, x, y) => { if (C(x) !== C(y)) out.set(key, {added: x === undefined ? [] : [C(x)], removed: y === undefined ? [] : [C(y)]}); };
    for (const k of new Set([...Object.keys(a || {}), ...Object.keys(b || {})])) {
      const x = a?.[k], y = b?.[k];
      if (idLists(x, y)) {
        const X = new Map((x || []).map(v => [v.id, v])), Y = new Map((y || []).map(v => [v.id, v]));
        for (const id of new Set([...X.keys(), ...Y.keys()])) {
          const xv = X.get(id), yv = Y.get(id), xFields = xv && {...xv}, yFields = yv && {...yv};
          const subs = new Set([...Object.keys(xv || {}), ...Object.keys(yv || {})]);
          for (const f of subs) {
            const xa = xv?.[f], ya = yv?.[f];
            if (idLists(xa, ya)) {
              const XA = new Map((xa || []).map(v => [v.id, v])), YA = new Map((ya || []).map(v => [v.id, v]));
              for (const sid of new Set([...XA.keys(), ...YA.keys()])) mark(k + "/" + id + "/" + f + "/" + sid, XA.get(sid), YA.get(sid));
              if (xFields) delete xFields[f];
              if (yFields) delete yFields[f];
            }
          }
          mark(k + "/" + id, xFields, yFields);
        }
      } else mark("project/" + k, x, y);
    }
    return out;
  }

  // The walk: commits newest first (blameLog), the text at the newest, and a patch source.
  // records: Map key -> [{i, status, added, removed}] (i: commit index), newest first.
  class Walk {
    constructor(commits, headText) {
      this.commits = commits;
      this.lines = headText.split("\n");
      this.S = scan(this.lines);
      this.records = new Map();
      this.next = 0;          // the next commit to undo
      this.created = null;    // index of the commit that added the file
      this.done = false;
      this.ms = 0;
    }
    // Undo commit i with its hunks (null: the commit added the file).
    step(hunks) {
      const t0 = Date.now(), i = this.next, c = this.commits[i];
      if (!c.oldBlob || hunks == null) { this.created = i; this.done = true; this.next++; this.ms += Date.now() - t0; return; }
      const old = reverse(this.lines, hunks), oldS = scan(old);
      const map = this.S.structured && oldS.structured ? touched(this.S, oldS, hunks) : touchedParsed(this.lines.join("\n"), old.join("\n"));
      for (const [key, e] of map) {
        const status = !e.removed.length ? "added" : !e.added.length ? "removed" : "modified";
        let list = this.records.get(key);
        if (!list) this.records.set(key, list = []);
        list.push({i, status, added: e.added, removed: e.removed});
      }
      this.lines = old; this.S = oldS; this.next++;
      if (this.next >= this.commits.length) this.done = true;
      this.ms += Date.now() - t0;
    }
    // The newest change of a key so far, or the creating commit once the walk is complete.
    last(key) {
      for (const r of this.records.get(key) || []) {
        if (r.status === "modified") {
          const a = parseSide(r.added), b = parseSide(r.removed);
          if (a && b && !fields(b, a).length) continue;
        }
        return r;
      }
      return this.done && this.created != null ? {i: this.created, status: "created"} : null;
    }
  }

  // ------------------------------------------------------------------ objects and fields
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  function parseSide(lines) {
    if (!lines?.length) return undefined;
    const text = lines.map(s => s.trim()).join("").replace(/,$/, "");
    try { return JSON.parse(text); } catch { return null; }
  }
  const canon = v => JSON.stringify(sortKeys(v));
  function sortKeys(v) { if (Array.isArray(v)) return v.map(sortKeys); if (!isObj(v)) return v; const o = {}; for (const k of Object.keys(v).sort()) o[k] = sortKeys(v[k]); return o; }
  const LABEL = {x: "X", y: "Y", angle: "Rotation", ref: "Designator", value: "Value", net: "Net", width: "Width", layer: "Layer", points: "Path", pinNets: "Pin nets",
    def: "Library part", locked: "Locked", side: "Side", diameter: "Diameter", drill: "Drill", text: "Text", w: "Width", h: "Height", shape: "Shape"};
  function show(v) {
    if (v === undefined) return "—";
    if (typeof v === "number") return String(Number(v.toPrecision(8)));
    if (typeof v === "string") return v.length > 60 ? v.slice(0, 57) + "…" : v;
    const t = JSON.stringify(v);
    return t.length > 60 ? (Array.isArray(v) ? v.length + " entries" : "{…}") : t;
  }
  // Field rows between two versions of one object; [] when they are the same object.
  function fields(before, after) {
    if (before && after && canon(before) === canon(after)) return [];
    if (!isObj(before) || !isObj(after)) return [];
    const rows = [];
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (k === "id" || k === "kicadSourceId") continue;
      if (canon(before[k]) === canon(after[k])) continue;
      if (k === "pinNets" && isObj(before[k]) && isObj(after[k])) {
        for (const pin of new Set([...Object.keys(before[k]), ...Object.keys(after[k])]))
          if (before[k][pin] !== after[k][pin]) rows.push({field: "Pin " + pin + " net", before: show(before[k][pin]), after: show(after[k][pin])});
        continue;
      }
      rows.push({field: LABEL[k] || k, before: show(before[k]), after: show(after[k])});
    }
    return rows;
  }
  function netsOf(item) {
    const out = new Set();
    if (!isObj(item)) return out;
    if (typeof item.net === "string" && item.net) out.add(item.net);
    if (isObj(item.pinNets)) for (const v of Object.values(item.pinNets)) if (typeof v === "string" && v) out.add(v);
    if ((item.kind === "netlabel" || item.kind === "power" || item.kind === "port") && typeof item.text === "string") out.add(item.text);
    return out;
  }
  // One selected-net transition. Null when the object is off that net or unchanged.
  // History passes "object" for a nameless row. Legacy source identities omit that fallback.
  function netTransition(before, after, net, unnamed) {
    const on = netsOf(after).has(net), was = netsOf(before).has(net);
    if (!on && !was) return null;
    if (on && was && !fields(before, after).length) return null;
    const obj = after || before;
    return (obj?.ref || obj?.kind || unnamed) + (on && !was ? " joined" : was && !on ? " left" : "");
  }
  const itemKey = (docId, itemId) => "documents/" + docId + "/items/" + itemId;
  // The changes of one key (verified field by field), or of every object on a net.
  function history(walk, target) {
    const out = [];
    if (target.net) {
      const byCommit = new Map();
      for (const [key, list] of walk.records) {
        if (!key.startsWith("documents/") || !key.includes("/items/")) continue;
        for (const r of list) {
          const a = parseSide(r.added), b = parseSide(r.removed);
          const label = netTransition(b, a, target.net, "object");
          if (!label) continue;
          let e = byCommit.get(r.i);
          if (!e) byCommit.set(r.i, e = {i: r.i, objects: [], status: "modified"});
          e.objects.push({key, label});
        }
      }
      for (const e of [...byCommit.values()].sort((x, y) => x.i - y.i)) out.push(e);
    } else {
      for (const r of walk.records.get(target.key) || []) {
        const a = parseSide(r.added), b = parseSide(r.removed);
        const rows = r.status === "modified" ? fields(b, a) : [];
        if (r.status === "modified" && a && b && !rows.length) continue; // re-formatted only
        out.push({i: r.i, status: r.status, fields: rows, before: b, after: a});
      }
    }
    if (walk.done && walk.created != null && !target.net && !out.some(e => e.status === "added")) out.push({i: walk.created, status: "created", fields: []});
    return out.map(e => ({...e, commit: walk.commits[e.i]}));
  }

  // ------------------------------------------------------------------ UI
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const btn = (text, fn, cls) => { const b = el("button", text, cls); b.type = "button"; b.onclick = fn; return b; };
  const ago = d => G.AtriumGit?.ago?.(d) || String(d || "").slice(0, 10);
  const short = id => String(id || "").slice(0, 7);
  function targetOf(host, item) {
    const doc = host.doc();
    return {key: itemKey(doc.id, item.id), docId: doc.id, item, label: (item.ref || item.name || item.text || item.kind) + "", net: null};
  }
  const unsure = "Object history is ambiguous. This KiCad import has no unique source identifier for the selected object. Use File History to compare the revisions.";
  function kicadItem(project, item, source) {
    const value = {...item};
    delete value.id; delete value.kicadSourceId;
    // Compare the selected live object's source fields without projecting the board.
    if (source) for (const key of ["kicadPath", "kicadPaths", "kicadUuid"]) {
      if (Object.hasOwn(source, key)) value[key] = source[key];
      else delete value[key];
    }
    // A fresh import allocates local library IDs. The library and footprint names describe
    // the assignment on the instance. Library geometry has its own comparison.
    if (item.kind === "part") {
      const def = project.library.find(d => d.id === item.def);
      value.def = [...new Set([def?.name, def?.footprint?.name].filter(Boolean))].join(" / ");
      if (!String(value.link || "").startsWith("kicad-")) delete value.link;
    }
    return value;
  }
  function sourceValue(project, target, kicad, docKind) {
    if (!project) return target.net ? new Map() : null;
    if (target.net) {
      const members = new Map();
      for (const doc of project.documents) for (const item of doc.items || []) if (netsOf(item).has(target.net)) {
        const key = kicad ? doc.kind + "/" + item.kind + "/" + item.kicadSourceId : itemKey(doc.id, item.id);
        if (kicad && (!item.kicadSourceId || members.has(key))) throw Error(unsure);
        members.set(key, kicad ? kicadItem(project, item) : item);
      }
      return members;
    }
    if (!kicad) return project.documents.find(d => d.id === target.docId)?.items?.find(i => i.id === target.item.id) || null;
    const sourceId = target.sourceId ?? target.item.kicadSourceId;
    if (!sourceId) throw Error(unsure);
    let found, unknown = false;
    // Older filenames and locally generated document IDs can differ. A unique source identifier
    // survives these transitions. Repeated IDs and unidentifiable names are never guessed.
    for (const doc of project.documents) if (doc.kind === docKind) for (const item of doc.items || []) {
      if (target.item.kind !== item.kind) continue;
      if (item.kicadSourceId === sourceId) {
        if (found) throw Error(unsure);
        found = item;
      } else if (!item.kicadSourceId && item.ref && item.ref === target.item.ref) unknown = true;
    }
    if (!found && unknown) throw Error(unsure);
    return found ? kicadItem(project, found) : null;
  }
  function workingKiCadItem(host, target, path) {
    const project = host.project(), doc = project.documents.find(d => d.id === target.docId);
    const item = doc?.items?.find(i => i.id === target.item.id);
    if (!item || item.kind !== target.item.kind) throw Error(unsure);
    const session = host.fileSession?.();
    if (!session?.imported) {
      // Older imports carry their source identifier directly on the object.
      return {value: sourceValue(project, {...target, sourceId: item.kicadSourceId, item}, true, doc.kind),
        sourceId: item.kicadSourceId, kind: doc.kind};
    }
    const scope = G.AtriumImportReports?.kicadHistoryScope(session, path);
    const source = scope?.documents.has(doc.id) && scope.items.get(item.id), sourceId = source?.kicadSourceId;
    if (typeof sourceId !== "string" || !sourceId) throw Error(unsure);
    const repeated = scope.repeated.get(sourceId);
    if (repeated) {
      for (const d of project.documents) if (d.kind === doc.kind && scope.documents.has(d.id)) {
        for (const other of d.items || []) if (other !== item && other.kind === item.kind &&
            repeated.has(other.id)) throw Error(unsure);
      }
    }
    return {value: kicadItem(project, item, source), sourceId, kind: doc.kind};
  }
  // Foreign revisions have no Waffle JSON patch. Retain just the selected object (or net
  // members) from each changed source digest. Metadata-only commits never enter the importer.
  async function sourceHistory(reader, host, target, full, progress) {
    const samples = new Map(), entries = [];
    let working = [], checked = 0, newest = true, more = false;
    const path = G.AtriumHost?.historyPath || "", kicad = /\.kicad_(pcb|sch|pro)$/i.test(path);
    const workingItem = kicad && !target.net ? workingKiCadItem(host, target, path) : null;
    const sourceTarget = workingItem ? {...target, sourceId: workingItem.sourceId} : target;
    const selected = project => sourceValue(project, sourceTarget, kicad, workingItem?.kind);
    const currentItem = workingItem?.value ?? target.item;
    const versusWorking = item => item ? fields(item, currentItem) : [{field: "Object", before: "—", after: "added"}];
    async function sample(revision, blob) {
      if (!blob) return target.net ? new Map() : null;
      if (samples.has(blob)) return samples.get(blob);
      const value = selected(await reader.project(revision));
      samples.set(blob, value);
      if (samples.size > 2) samples.delete(samples.keys().next().value);
      return value;
    }
    do {
      const result = await reader.page(checked, Math.min(40, LOG_LIMIT - checked), async (commit, oldBlob, blob) => {
        const a = await sample(commit.revision, blob);
        if (newest && !target.net) {
          newest = false;
          working = versusWorking(a);
          if (working.length && !full) return false;
        }
        newest = false;
        const b = await sample(commit.parents[0], oldBlob);
        if (target.net) {
          const objects = [];
          for (const key of new Set([...b.keys(), ...a.keys()])) {
            const label = netTransition(b.get(key), a.get(key), target.net);
            if (!label) continue;
            objects.push({key, label});
          }
          if (objects.length) entries.push({commit, status: "modified", objects});
        } else {
          const rows = a && b ? fields(b, a) : [];
          if (rows.length || !!a !== !!b) entries.push({commit, fields: rows, status: !b ? "added" : !a ? "removed" : "modified"});
        }
        if (!full && entries.length) return false;
      });
      checked = result.checked; more = result.more;
      // A full page can contain only documentation changes. Uncommitted edits still compare to HEAD.
      if (newest && !target.net && result.head) {
        working = versusWorking(selected(await reader.project(result.head)));
        newest = false;
      }
      progress?.(checked);
    } while (more && checked < LOG_LIMIT && (full || !working.length && !entries.length));
    return {entries, checked, working, more};
  }
  function credit(line, c, status, open) {
    const verb = status === "created" || status === "added" ? "Added " : "Changed ";
    const link = btn(short(c.revision), open, "blame-link");
    link.title = (c.subject || "") + "\nShow every change to this object";
    line.replaceChildren(el("span", verb + ago(c.date) + " by " + (c.author || "unknown"), "blame-who"), el("span", " · ", "blame-sep"),
      link, el("span", " " + (c.subject || ""), "blame-subject"));
  }
  function pendingCredit(line, pending, open) {
    line.replaceChildren(el("span", "Not committed: " + pending.slice(0, 3).map(f => f.field).join(", ") + " changed since the last commit", "blame-who"),
      el("span", " · ", "blame-sep"), btn("History", open, "blame-link"));
  }
  async function sourceInspector(line, host, target) {
    let reader;
    const cancel = () => { if (!line.isConnected) reader?.close(); };
    const observer = new MutationObserver(cancel);
    observer.observe(line.parentNode, {childList: true});
    try {
      const module = await G.AtriumLazy.need("AtriumSourceHistory");
      if (!line.isConnected) return;
      reader = module.open();
      const r = await sourceHistory(reader, host, target, false);
      if (!line.isConnected) return;
      const open = () => G.AtriumLazy.need("AtriumHistoryEntry")
        .then(entry => { if (line.isConnected) return entry.open({target}); })
        .catch(error => host.info?.(error.message));
      if (r.working.length) pendingCredit(line, r.working, open);
      else if (r.entries.length) credit(line, r.entries[0].commit, r.entries[0].status, open);
      else line.textContent = "No change in the " + r.checked + " first-parent commits checked.";
    } catch (e) { if (line.isConnected) line.textContent = e.message; }
    finally { observer.disconnect(); reader?.close(); }
  }
  function inspector(panel, host, item) {
    if (!item || !G.AtriumHost?.historyPath && !G.AtriumGit?.available?.()) return;
    panel.querySelector(":scope > .blame-line")?.remove();
    const target = targetOf(host, item);
    const line = el("p", null, "blame-line");
    line.setAttribute("role", "status");
    line.title = "The last commit that changed this object";
    line.append(btn("Who changed this?", () => {
      line.textContent = "Reading who changed this…";
      sourceInspector(line, host, target);
    }, "blame-link"));
    panel.append(line);
  }
  return Object.freeze({engine: {scan, reverse, touched, touchedParsed, Walk, history, fields, itemKey, netsOf, netTransition, sourceValue}, inspector, sourceHistory, targetOf});
})();
