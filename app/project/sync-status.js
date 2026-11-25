"use strict";
// Schematic <-> PCB sync status (status bar), the labels of newly imported part groups on the
// board, and the first-import hint. The status checks run while the editor is visible.
//
// Status: "Board out of sync: 3 changes" in the status bar while the schematic and the board
// differ; a click opens Update PCB (or Update Schematics when only the board changed). It is
// cheap and incremental: fingerprints cover the board's components, which nets have copper,
// and the schematic sheets. The comparison runs at idle when those inputs change. Committed PCB
// geometry changes that leave the inputs alone do not queue a check.
//
// Groups: Update PCB records the clusters new parts arrived in (board.sync.clusters). While a
// cluster's parts wait outside the board outline, its sheet name is drawn above it; dragging the
// label moves the whole group (one undo step).
//
//   AtriumSyncStatus.state()     -> {board, count, forward, reverse, conflicts, ignored, checked}
//   AtriumSyncStatus.refresh(force) -> Promise<state>
//   AtriumSyncStatus.hint({board, added, clusters})  the first-import coach card (non-modal)
//   AtriumSyncStatus.clusters(doc, defs) -> [{name, ids, box}] groups still outside the outline
globalThis.AtriumSyncStatus = (() => {
  const A = () => globalThis.Atrium;
  const HINT_KEY = "atrium.hint.ecoClusters";
  let H = null, btn = null, last = null, checked = null, busy = false, pending = false, state = {board: null, count: 0, forward: 0, reverse: 0, conflicts: 0, ignored: 0, checked: false};
  let generation = 0, timer = 0, cancelIdle = null, cancelSlice = null;
  let labels = [], drag = null, card = null;
  const hasDOM = () => typeof document !== "undefined" && !!document.createElement;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  // FNV-1a over a string: a fingerprint, not a security hash.
  function hash(s, h = 2166136261) { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  // A committed document version lets an unchanged sheet keep its print without rereading items.
  // Its local graph also depends on the definitions it references, which can change in place.
  const keptBoards = new WeakMap(), keptSheets = new WeakMap();
  const versions = (doc, project) => globalThis.AtriumUndoStore?.documentVersions?.(doc, project) || null;
  function unchanged(d, c, v) {
    return c?.version && v && c.items === d.items && c.length === d.items.length &&
      c.version.seq >= v.floor && c.version.seq <= v.seq && c.version.items === v.items;
  }
  function sameBoardItems(board, old, version) {
    if (unchanged(board, old, version)) return true;
    if (!old?.version || !version || old.items !== board.items || old.length !== board.items.length ||
        old.version.floor !== version.floor) return false;
    // The ECO reads component evidence and the presence of routed copper on each net.
    // Geometry-only in-place edits leave both alone. Splices and unknown journal ranges rebuild.
    return globalThis.AtriumUndoStore?.onlyRecordedItemUpdates?.(board, old.version.seq, (before, after) =>
      before.id === after.id && before.kind === after.kind && before.kind !== "part" && before.net === after.net &&
      !before.pinNets && !after.pinNets);
  }
  function partsPrint(board, version) {
    const old = keptBoards.get(board);
    if (sameBoardItems(board, old, version)) { old.version = version; return old; }
    let h = 2166136261, hasParts = false;
    const copper = new Set();
    for (const i of board.items) {
      if (i.kind !== "part") { if (typeof i.net === "string" && i.net) copper.add(i.net); continue; }
      hasParts = true;
      h = hash(JSON.stringify([i.id, i.ref, i.value, i.def, i.link, !!i.locked, i.channel, i.altiumSourceId,
        i.kicadSourceId, !!i.schSource, !!i.sourceRecord, i.pinNets, i.parameters]), h);
    }
    const c = {print: h, copper: JSON.stringify([...copper].sort()), hasParts, version, items: board.items, length: board.items.length};
    if (version) keptBoards.set(board, c);
    return c;
  }
  const syncPrint = board => hash(JSON.stringify(board.sync?.ignore || null) + JSON.stringify(board.sync?.base || null));
  // The public diagnostic prints the component projection and its reconciliation settings.
  function boardPrint(board) { return partsPrint(board, null).print + ":" + syncPrint(board); }
  // A sheet's print is what the comparison reads from it: every item without its position (x, y,
  // points) and the sheet's connectivity (AtriumHierarchy.local: which pins, labels, sheet entries and
  // wires share a net). Only a plan using historical schematic positions needs the separate
  // position fingerprint. A sheet the journal certifies unchanged keeps both fingerprints.
  function connPrint(d, defs, used) {
    let h = 2166136261, positions = 2166136261;
    for (const i of d.items) {
      if (i.kind === "part") { used.add(i.def); positions = hash(JSON.stringify([i.id, i.x, i.y]), positions); }
      const o = {}; for (const k of Object.keys(i)) if (k !== "x" && k !== "y" && k !== "points") o[k] = i[k]; h = hash(JSON.stringify(o), h);
    }
    const L = globalThis.AtriumHierarchy?.local, out = [];
    if (L) {
      const loc = L(d, defs);
      for (const g of loc.nets) out.push(g.index + ":" + g.pins.map(c => c.i.id + "/" + c.pin.number + "/" + c.order).join(",") + "|" + g.sources.map(x => x.type + "/" + x.name + "/" + (x.item?.id ?? "") + "/" + (x.io ?? "") + "/" + x.order).join(",") +
        "|" + g.entries.map(e => e.symbol.id + "/" + e.entry.name).join(",") + "|" + g.wires.map(w => w.id).join(","));
      for (const b of loc.buses) out.push("B" + b.type + "/" + b.name + "/" + (b.item?.id ?? "") + "/" + (b.symbol?.id ?? "") + "/" + (b.entry?.name ?? ""));
      for (const [x, y] of loc.aliases) out.push("A" + x + "=" + y);
    } else {
      const c = A().connectivity(d, defs);
      for (const [k, v] of c.byPin) out.push(k + "=" + v);
      for (const [k, v] of c.byWire || []) out.push(k + "~" + v);
    }
    return {conn: h + "/" + hash(out.join(";")), positions};
  }
  function pinMarks(ids, defs, marks) {
    return [...ids].map(id => {
      if (!marks.has(id)) {
        const symbol = defs.get(id)?.symbol;
        marks.set(id, symbol ? JSON.stringify([symbol.parts, symbol.alternate, (symbol.pins || symbol.pads)?.map(A().terminalGeometry)]) : "");
      }
      return marks.get(id);
    });
  }
  // Until the journal records a definition edit, a multi-gate view may hold an old pin list.
  const freshSymbol = def => def?.symbol?.parts > 1 || def?.symbol?.alternate ? {...def, symbol: {...def.symbol}} : def;
  // Yields after each sheet it had to read, so refresh() can spread a first pass over idle slices.
  function* sheetsSteps(project, defs, tracked) {
    const marks = new Map();
    let h = 2166136261, positions = 2166136261, hasParts = false;
    for (const d of project.documents) if (d.kind === "schematic") {
      const v = tracked ? versions(d, project) : null, old = keptSheets.get(d);
      let c = unchanged(d, old, v) && old.version.outer === v.outer ? old : null;
      if (c && c.version.library !== v.library) {
        const next = pinMarks(c.used, defs, marks);
        if (next.some((m, i) => m !== c.pins[i])) c = null;
      }
      if (!c) {
        const used = new Set(), fingerprints = connPrint(d, defs, used);
        c = {...fingerprints, used, version: v, items: d.items, length: d.items.length, pins: v ? pinMarks(used, defs, marks) : []};
        if (v) keptSheets.set(d, c);
        yield;
      } else c.version = v;
      hasParts ||= c.used.size > 0;
      h = hash(d.id + ":" + d.name + ":" + c.conn, h);
      positions = hash(d.id + ":" + c.positions, positions);
    }
    return {positions, print: h + ":" + project.library.length + ":" + JSON.stringify(project.rules?.list?.find(r => r.type === "ercNetScope")?.netScope ?? null), hasParts};
  }
  const defsOf = project => H?.project?.() === project && H.defs?.() || new Map(project.library.map(d => [d.id, d]));
  function sheetsPrint(project, defs, quick = false) {
    const live = defsOf(project);
    defs ||= live;
    const tracked = quick && defs === live && project.documents.some(d => d.kind === "schematic" && versions(d, project));
    const source = tracked ? defs : new Map([...defs].map(([id, def]) => [id, freshSymbol(def)]));
    const steps = sheetsSteps(project, source, tracked);
    let r; do r = steps.next(); while (!r.done); return r.value.print;
  }
  const visible = () => globalThis.AtriumPower?.visible?.() !== false && globalThis.document?.visibilityState !== "hidden";
  function onIdle(run) {
    const idle = globalThis.AtriumIdle;
    if (idle) { const id = idle.idle(run, {timeout: 2000}); return () => idle.cancel(id); }
    if (globalThis.requestIdleCallback) {
      const id = requestIdleCallback(run, {timeout: 2000}); return () => globalThis.cancelIdleCallback?.(id);
    }
    const id = setTimeout(run, 0); return () => clearTimeout(id);
  }
  function slice() {
    const request = generation;
    return new Promise(resolve => {
      const stop = onIdle(() => { if (request === generation) cancelSlice = null; resolve(); });
      cancelSlice = () => { stop(); resolve(); };
    });
  }
  function boardOf(project) {
    const cur = H.doc?.();
    if (cur?.kind === "pcb") return cur;
    return globalThis.Atrium?.preferredDocument?.(project, "pcb", H.currentId?.()) || project.documents.find(d => d.kind === "pcb") || null;
  }
  const itemState = (doc, version) => ({doc, version, items: doc.items, length: doc.items.length});
  function rememberInputs(project, board, version, sheets) {
    checked = version ? {project, board: itemState(board, version), sheets: sheets.map(d => itemState(d, versions(d, project)))} : null;
  }
  function stillChecked() {
    if (!checked || !state.checked || checked.project !== H.project()) return false;
    const project = checked.project, board = boardOf(project), prior = checked.board;
    if (prior.doc !== board) return false;
    const v = versions(board, project), old = prior.version;
    if (!v || old.floor !== v.floor || old.outer !== v.outer || old.library !== v.library ||
        old.project !== v.project || old.parameters !== v.parameters) return false;
    const sheets = project.documents.filter(d => d.kind === "schematic");
    if (checked.sheets.length !== sheets.length || !sheets.every((d, index) => {
      const saved = checked.sheets[index], current = versions(d, project);
      return saved.doc === d && unchanged(d, saved, current) && saved.version.outer === current.outer;
    }) || !sameBoardItems(board, prior, v)) return false;
    prior.version = v;
    return true;
  }
  function cancel() {
    generation++; clearTimeout(timer); timer = 0;
    cancelIdle?.(); cancelIdle = null;
    cancelSlice?.(); cancelSlice = null;
  }
  function queue(delay) {
    if (!H || !pending || busy || timer || cancelIdle || !visible()) return;
    const request = generation;
    timer = setTimeout(() => {
      if (request !== generation) return;
      timer = 0;
      if (!visible()) return;
      const run = () => {
        if (request !== generation) return;
        cancelIdle = null;
        refresh().catch(() => {});
      };
      const job = H.stageEdit?.("idle", "sync-status", run);
      cancelIdle = job ? () => job.cancel() : onIdle(run);
    }, globalThis.AtriumPower?.delay?.(delay) ?? delay);
  }
  function schedule(delay = 900) {
    pending = true; cancel(); queue(delay);
  }
  function clear(board) {
    state = {board: board?.id || null, count: 0, forward: 0, reverse: 0, conflicts: 0, ignored: 0, checked: true};
    last = checked = null; paint(); return state;
  }
  async function refresh(force = false) {
    if (!H) return state;
    if (busy || !visible()) { pending = true; return state; }
    cancel(); pending = false;
    const project = H.project(), board = boardOf(project), sheets = project.documents.filter(d => d.kind === "schematic");
    if (!board || !sheets.length) return clear(board);
    const request = generation;
    const revision = H.revision?.(), version = versions(board, project);
    const current = () => {
      if (request !== generation || !visible() || H.project() !== project || H.revision?.() !== revision || boardOf(project) !== board) return false;
      if (!version) return true;
      const now = versions(board, project);
      return now && now.seq === version.seq && now.outer === version.outer && now.library === version.library && now.project === version.project;
    };
    busy = true;
    try {
      let print = null, positions = null;
      if (version) {
        const parts = partsPrint(board, version), steps = sheetsSteps(project, defsOf(project), true);
        let t0 = Date.now(), r;
        while (!(r = steps.next()).done) if (Date.now() - t0 > 8) {
          await slice(); t0 = Date.now();
          if (!current()) { pending = true; return state; }
        }
        if (!parts.hasParts && !r.value.hasParts) {
          clear(board);
          rememberInputs(project, board, version, sheets);
          return state;
        }
        positions = r.value.positions;
        // Footprint-only edits still affect the comparison even when the sheet graphs stay the same.
        print = JSON.stringify([board.id, parts.print, parts.copper, syncPrint(board), r.value.print,
          version.floor, version.library, version.project, version.parameters, version.outer]);
      } else if (!board.items.some(i => i.kind === "part") && !sheets.some(s => s.items.some(i => i.kind === "part"))) return clear(board);
      if (!force && print !== null && last?.project === project && print === last.print && (!last.usesPositions || positions === last.positions)) {
        rememberInputs(project, board, version, sheets);
        return state;
      }
      const E = globalThis.AtriumECO || await globalThis.AtriumLazy?.need?.("AtriumECO");
      if (!E) return state;
      if (!current()) { pending = true; return state; }
      // Unknown or deferred journal state calls for a fresh plan, without forcing an undo-recording pass.
      const source = version ? project : {...project, library: project.library.map(freshSymbol)};
      // layout false: the status counts the changes; where new parts would go is not needed.
      const started = Date.now(), opts = {board: board.id, scope: "*", direction: "pcb", layout: false};
      const p = E.planAsync ? await E.planAsync(source, opts, current) : E.plan(source, opts);
      if (!p || !current()) { pending = true; return state; }
      const reviews = p.review?.pending || 0;
      const sel = p.changes.filter(c => c.selected || c.conflict);
      state = {board: board.id, boardName: board.name, count: sel.length + reviews, reviews, forward: sel.filter(c => c.use !== "reverse" && !c.conflict).length,
        reverse: sel.filter(c => c.use === "reverse").length, conflicts: sel.filter(c => c.conflict).length, ignored: p.changes.filter(c => c.ignored).length,
        extras: p.issues.filter(i => /has no schematic component/.test(i)).length, checked: true, ms: Date.now() - started};
      const usesPositions = !!board.sync?.locations && (reviews > 0 || p.matches?.some(m => m.confidence < 1) || p.changes.some(c => c.action === "addComponent"));
      last = print === null ? null : {project, print, positions, usesPositions};
      rememberInputs(project, board, version, sheets);
    } catch {
      if (current()) { last = checked = null; state = {...state, checked: false}; }
      else { pending = true; return state; }
    } finally { busy = false; queue(300); }
    paint();
    return state;
  }
  function paint() {
    if (!btn) return;
    const s = state;
    btn.hidden = !s.count;
    if (!s.count) return;
    const only = s.reverse && !s.forward && !s.conflicts && !s.reviews;
    btn.querySelector(".sync-text").textContent = (only ? "Schematic out of sync: " : "Board out of sync: ") + s.count + " change" + (s.count === 1 ? "" : "s") +
      (s.conflicts ? " · " + s.conflicts + " conflict" + (s.conflicts === 1 ? "" : "s") : "");
    btn.classList.toggle("has-conflict", !!s.conflicts);
    const parts = [];
    if (s.forward) parts.push(s.forward + " from the schematic");
    if (s.reverse) parts.push(s.reverse + " made on the board");
    if (s.conflicts) parts.push(s.conflicts + " changed on both sides");
    if (s.reviews) parts.push(s.reviews + " component matches to review");
    if (s.ignored) parts.push(s.ignored + " set to never sync");
    btn.title = (s.boardName || "The board") + " and the schematic differ: " + parts.join(", ") + ". Click to review (" + (only ? "Update Schematics from PCB" : "Update PCB from Schematics") + ").";
    btn.setAttribute("aria-label", btn.querySelector(".sync-text").textContent + ". Review changes");
  }
  function install(host) {
    H = host;
    if (install.done) return;
    install.done = true;
    const bar = document.querySelector(".statusbar");
    if (bar && !bar.querySelector(".status-sync")) {
      btn = el("button", null, "status-sync status-action"); btn.type = "button"; btn.hidden = true;
      btn.append(el("span", null, "sync-dot"), el("span", "", "sync-text"));
      btn.onclick = () => { const only = state.reverse && !state.forward && !state.conflicts; if (state.board && H.currentId() !== state.board && H.doc()?.kind === "pcb") H.selectDocument(state.board); H.act(only ? "eco-reverse" : "eco"); };
      bar.insertBefore(btn, bar.querySelector(".status-right"));
    }
    const changed = delay => { if (!visible() || pending || busy || !stillChecked()) schedule(delay); };
    host.on("change", () => changed(900));
    host.on("document", () => changed(300));
    host.on("replace", () => { last = checked = groupCache = labelDoc = drag = null; labels = []; schedule(300); });
    let wasVisible = visible();
    const visibility = () => {
      const next = visible();
      if (next === wasVisible) return;
      wasVisible = next;
      if (!next) { pending ||= busy; cancel(); }
      else {
        if (pending && !busy && stillChecked()) pending = false;
        queue(300);
      }
    };
    if (globalThis.AtriumPower?.onChange) AtriumPower.onChange(visibility);
    else document.addEventListener?.("visibilitychange", visibility);
    host.addRenderer((d, info) => {
      if (info?.active === false) return null;
      if (d?.kind === "pcb" && Array.isArray(d.sync?.clusters) && d.sync.clusters.length) return {overlay: paintGroups};
      if (labelDoc) { labels.length = 0; labelDoc = null; }
      return null;
    });
    if (typeof window !== "undefined") {
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("pointercancel", e => { if (drag && drag.pointerId === e.pointerId) { drag = null; H.redraw(); } }, true);
      window.addEventListener("keydown", e => { if (e.key === "Escape" && drag) { drag = null; H.redraw(); e.stopPropagation(); } }, true);
    }
    schedule(1500);
  }

  // ------------------------------------------------------------------ part groups on the board
  function partBox(item, def) {
    const g = def?.footprint; if (!g) return null;
    const pts = A().symbolPoints(g).map(p => A().world(p, item));
    return A().bounds(pts.length ? pts : [[item.x, item.y]]);
  }
  const inside = (poly, p) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
  // Groups whose parts are still (mostly) outside the outline, with their current boxes.
  function groupBoxes(doc, defs, byId) {
    const out = [], outline = doc.outline?.length >= 3 ? doc.outline : null;
    for (const c of doc.sync?.clusters || []) {
      const items = (c.ids || []).map(id => byId.get(id)).filter(i => i?.kind === "part");
      const waiting = items.filter(i => !outline || !inside(outline, [i.x, i.y]));
      if (!waiting.length || outline && waiting.length < items.length / 2) continue;
      const boxes = waiting.map(i => partBox(i, defs.get(i.def))).filter(Boolean);
      if (!boxes.length) continue;
      const box = [Math.min(...boxes.map(b => b[0])), Math.min(...boxes.map(b => b[1])), Math.max(...boxes.map(b => b[2])), Math.max(...boxes.map(b => b[3]))];
      out.push({name: c.name || "Sheet", ids: waiting.map(i => i.id), box, boxes});
    }
    return out;
  }
  function clusters(doc, defs) {
    return groupBoxes(doc, defs, new Map(doc.items.map(i => [i.id, i]))).map(({name,ids,box}) => ({name,ids,box}));
  }
  let groupCache = null, labelDoc = null;
  function groupArtwork(doc, defs) {
    const project = H.project(), revision = H.revision?.(), groups = doc.sync.clusters, old = groupCache;
    const store = globalThis.AtriumUndoStore, version = store?.documentVersions?.(doc, project, true);
    const transient = H.drag?.()?.before;
    const sameOwner = old?.project === project && old.doc === doc && old.groups === groups && old.outline === doc.outline &&
      old.defs === defs && old.items === doc.items && old.length === doc.items.length;
    const sameInputs = sameOwner && (version && old.version ?
      version.floor === old.version.floor && version.outer === old.version.outer && version.library === old.version.library :
      !version && !old.version && revision === old.revision);
    if (sameInputs) {
      const delta = version && old.version.items !== version.items ? store.recordedChanges(doc, old.version.seq) : null;
      if (!delta || delta.ids && [...delta.ids].every(id => !old.members.has(id))) {
        old.version = version;
        old.revision = revision;
        return transient ? groupBoxes(doc, defs, old.byId) : old.artwork;
      }
    }
    const members = new Set(groups.flatMap(group => group.ids || []));
    const projected = store?.documentItems?.(doc, project, version);
    const byId = new Map();
    if (projected) {
      for (const id of members) if (projected.byId.has(id)) byId.set(id, projected.byId.get(id));
    } else {
      for (const item of doc.items) if (members.has(item.id)) byId.set(item.id, item);
    }
    const artwork = groupBoxes(doc, defs, byId);
    if (!transient) groupCache = {project, doc, defs, groups, outline: doc.outline, items: doc.items, length: doc.items.length, version, revision, members, byId, artwork};
    return artwork;
  }
  const css = (k, f) => { try { return getComputedStyle(document.documentElement).getPropertyValue(k).trim() || f; } catch { return f; } };
  function paintGroups(ctx, info) {
    const doc = H.doc(); if (!doc || doc.kind !== "pcb") { labels = []; return; }
    const list = groupArtwork(doc, H.defs()), px = 1 / info.scale, accent = css("--accent", "#2f81f7"), ink = css("--on-accent", "#fff");
    labelDoc = doc;
    labels = [];
    ctx.save(); ctx.lineWidth = px; ctx.setLineDash([5 * px, 4 * px]); ctx.strokeStyle = accent;
    for (const g of list) {
      const off = drag?.group === g.name ? drag.delta : [0, 0], b = g.box, m = 1.2;
      ctx.globalAlpha = drag?.group === g.name ? 0.9 : 0.55;
      ctx.strokeRect(b[0] - m + off[0], b[1] - m + off[1], b[2] - b[0] + 2 * m, b[3] - b[1] + 2 * m);
      if (drag?.group === g.name) {
        ctx.globalAlpha = 0.5;
        for (const pb of g.boxes) ctx.strokeRect(pb[0] + off[0], pb[1] + off[1], pb[2] - pb[0], pb[3] - pb[1]);
      }
    }
    // Name tabs in screen space, above each group's top-left corner.
    ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0); ctx.globalAlpha = 1; ctx.setLineDash([]);
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    for (const g of list) {
      const off = drag?.group === g.name ? drag.delta : [0, 0], s = info.worldToScreen([g.box[0] - 1.2 + off[0], g.box[1] - 1.2 + off[1]]);
      const text = g.name + " · " + g.ids.length, w = Math.ceil(ctx.measureText(text).width) + 22, h = 18, x = s[0], y = s[1] - h - 2;
      if (x > info.width || y > info.height || x + w < 0 || y + h < 0) continue;
      ctx.fillStyle = accent; ctx.globalAlpha = 0.92; ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1; ctx.fillStyle = ink;
      // A grip (three dots) says the tab can be dragged.
      for (let k = 0; k < 3; k++) ctx.fillRect(x + 6, y + 5 + k * 3.2, 2, 2);
      ctx.fillText(text, x + 13, y + h / 2 + 0.5);
      labels.push({name: g.name, ids: g.ids, rect: [x, y, w, h]});
    }
    ctx.restore();
  }
  function screenPoint(e) {
    const c = H.canvas?.(); if (!c) return null;
    const b = c.getBoundingClientRect(); if (e.clientX < b.left || e.clientY < b.top || e.clientX > b.right || e.clientY > b.bottom) return null;
    return {s: [e.clientX - b.left, e.clientY - b.top], c};
  }
  function onDown(e) {
    if (e.button !== 0 || !labels.length || H.doc() !== labelDoc || document.querySelector("dialog[open]")) return;
    const p = screenPoint(e); if (!p) return;
    const hit = labels.find(l => p.s[0] >= l.rect[0] && p.s[0] <= l.rect[0] + l.rect[2] && p.s[1] >= l.rect[1] && p.s[1] <= l.rect[1] + l.rect[3]);
    if (!hit) return;
    e.preventDefault(); e.stopPropagation();
    const w = H.view().screenToWorld(p.s);
    drag = {doc: labelDoc, pointerId: e.pointerId, group: hit.name, ids: hit.ids, start: w, delta: [0, 0], moved: false};
    H.select(hit.ids, hit.ids[0]);
    H.info("Drag the " + hit.name + " group onto the board. Esc cancels.");
  }
  function onMove(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (H.doc() !== drag.doc) { drag = null; return; }
    const p = screenPoint(e) || {s: (() => { const c = H.canvas(), b = c.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; })()};
    const w = H.view().screenToWorld(p.s), g = 0.5;
    drag.delta = [Math.round((w[0] - drag.start[0]) / g) * g, Math.round((w[1] - drag.start[1]) / g) * g];
    drag.moved = drag.moved || Math.hypot(drag.delta[0], drag.delta[1]) > 0.2;
    e.stopPropagation(); H.redraw();
  }
  function onUp(e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (H.doc() !== drag.doc) { drag = null; return; }
    const d = drag; drag = null; e.stopPropagation();
    if (!d.moved) { H.redraw(); return; }
    const doc = H.doc(), defs = H.defs(), set = new Set(d.ids), touched = new Set();
    let n = 0, locked = 0;
    H.edit(() => {
      for (const it of doc.items) {
        if (!set.has(it.id)) continue;
        if (it.locked) { locked++; continue; }
        const moved = A().transformPart(doc, it, defs.get(it.def), {x: +(it.x + d.delta[0]).toFixed(4), y: +(it.y + d.delta[1]).toFixed(4)});
        for (const item of moved) touched.add(item);
        n++;
      }
    }, undefined, touched);
    H.info(n + " part" + (n === 1 ? "" : "s") + " of " + d.group + " moved" + (locked ? " (" + locked + " locked part" + (locked === 1 ? "" : "s") + " stayed)" : "") + ". Undo moves them back.");
  }

  // ------------------------------------------------------------------ first-import hint
  function hintOff() { try { return localStorage.getItem(HINT_KEY) === "off"; } catch { return false; } }
  function closeHint() {
    if (!card) return;
    const c = card; card = null;
    c.classList.add("is-leaving");
    setTimeout(() => c.remove(), globalThis.AtriumMotion?.duration?.("fast") ?? 140);
  }
  function hint(o = {}) {
    if (!hasDOM() || hintOff() || !H) return false;
    closeHint();
    const host = document.querySelector("#editor-panes") || document.body;
    card = el("section", null, "sync-hint"); card.setAttribute("role", "status"); card.setAttribute("aria-label", "Placement hint");
    const head = el("div", null, "sync-hint-head");
    head.append(el("h2", "New parts are grouped by sheet", "sync-hint-title"));
    const x = el("button", "×", "ui-close sync-hint-close"); x.type = "button"; x.title = "Close"; x.setAttribute("aria-label", "Close hint"); x.onclick = closeHint;
    head.append(x);
    const text = el("p", null, "sync-hint-text");
    text.append("Parts are grouped by their schematic sheet, beside the board. Drag a group by its label to place it, or use ");
    const link = el("button", "Tools › Component Placement › Arrange Within Board", "sync-hint-link"); link.type = "button";
    link.onclick = () => { closeHint(); H.act("arrange-board"); };
    text.append(link, ". Then Place Support Components puts decoupling capacitors, crystals and terminations next to their pins.");
    const foot = el("div", null, "sync-hint-actions"), never = el("label", null, "sync-hint-never"), box = el("input", null, "ui-checkbox");
    box.type = "checkbox"; never.append(box, el("span", "Don't show again"));
    const ok = el("button", "Got It", "sync-hint-ok ui-button"); ok.type = "button"; ok.dataset.variant = "primary";
    ok.onclick = () => { if (box.checked) try { localStorage.setItem(HINT_KEY, "off"); } catch {} closeHint(); };
    box.onchange = () => { try { if (box.checked) localStorage.setItem(HINT_KEY, "off"); else localStorage.removeItem(HINT_KEY); } catch {} };
    foot.append(never, ok);
    card.append(head, text, foot);
    card.addEventListener("keydown", e => { if (e.key === "Escape") { e.stopPropagation(); closeHint(); } });
    host.append(card);
    H.redraw?.();
    return true;
  }
  if (hasDOM() && globalThis.AtriumNavCommon?.ready) AtriumNavCommon.ready(install);
  return {state: () => ({...state}), refresh, schedule, hint, closeHint, clusters, boardPrint, sheetsPrint, install};
})();
