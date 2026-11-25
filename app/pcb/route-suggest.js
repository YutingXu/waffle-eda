"use strict";
// Route Suggestions: autocomplete for copper (lazy module AtriumRouteSuggest; engine in
// route-suggest-engine.js, search off the main thread in route-suggest-worker.js, learned habits
// in route-habits.js). With the Route tool on a board:
//   - hover a connection line (or a pad's) to see a translucent ghost of the best completion;
//     after starting a route from a pad, the ghost completes it from the last anchor to the target;
//   - Tab accepts it as one undo step (when a ghost is visible; otherwise Tab keeps Altium's routing
//     properties: Preferences › Route Suggestions › Tab key), Shift+Tab / Alt+] cycles the
//     alternatives (Alt+[ back), Ctrl/⌘+→ accepts up to the next bend or via, Esc dismisses;
//   - after an accept the next unrouted connection nearby is suggested.
// The ghost is legal by construction (exact checks in the engine) and checked again on accept.
// The chip text ("1/3 · 2 vias · 14.2 mm") and the reason line live in route-feel.js's head tip.
globalThis.AtriumRouteSuggest = (() => {
  const E = () => globalThis.AtriumRouteSuggestEngine, HB = () => globalThis.AtriumRouteHabits, host = () => globalThis.AtriumNavHost;
  const now = () => (globalThis.performance?.now?.() ?? Date.now());
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const pref = (k, d) => { try { const v = (globalThis.AtriumPref || globalThis.AtriumPrefs)?.get?.(k); return v === undefined ? d : v; } catch { return d; } };
  const PREFS = {on: "routing.suggest", tab: "routing.suggestTab", trigger: "routing.suggestOn", next: "routing.suggestNext"};
  const DEBOUNCE = 12, HOVER_PX = 7, IDLE_STOP = 300000;
  // State: the current query key, the result (alternatives), the chosen one, the remaining part
  // after partial accepts, and the accept flash.
  const S = {key: "", dismissed: "", query: null, result: null, index: 0, pinned: false, seq: 0, wantSeq: 0, timer: 0, trigger: 0,
    lat: [], firstPaint: new Map(), flash: null, lastPointer: null, aw: null,
    worker: null, workerState: "none", sentDefs: new Map(), sentStamp: null, pendingSince: 0, installed: false, mainMs: []};
  const enabled = () => pref(PREFS.on, true) !== false;
  const efficient = () => !!globalThis.AtriumPower?.efficient?.();
  const onscreen = () => globalThis.AtriumPower?.visible?.() !== false;
  const boardStamp = () => ({doc: host()?.doc?.(), rev: host()?.revision?.() ?? 0});
  const sameBoard = stamp => stamp?.doc === host()?.doc?.() && stamp?.rev === (host()?.revision?.() ?? 0);

  // ------------------------------------------------------------------ worker client
  function base() {
    try { const s = globalThis.document?.querySelector?.('script[src$="pcb/route-suggest.js"]'); if (s) return new URL("../workers/", s.src).href; } catch { /* no DOM */ }
    try { return new URL("workers/", globalThis.document.baseURI).href; } catch { return ""; }
  }
  function startWorker() {
    if (S.worker || S.workerState === "broken" || typeof Worker !== "function") return null;
    const make = () => {
      // WKWebView and WebKitGTK never start a file:// URL worker (no exception: an error event later),
      // so the shared Blob bootstrap (worker-pool.js, a lazy dependency) comes first.
      try { if (globalThis.AtriumWorkerPool?.script) return globalThis.AtriumWorkerPool.script(base() + "route-suggest-worker.js"); } catch { /* below */ }
      try { return new Worker(base() + "route-suggest-worker.js"); } catch { /* file:// may refuse */ }
      try {
        const b = base(), src = "self.importScripts=(o=>(...a)=>o(...a.map(f=>new URL(f," + JSON.stringify(b) + ").href)))(self.importScripts);importScripts(\"route-suggest-worker.js\");";
        const url = URL.createObjectURL(new Blob([src], {type: "text/javascript"}));
        try { return new Worker(url); } finally { setTimeout(() => URL.revokeObjectURL(url), 30000); }
      } catch { return null; }
    };
    const w = make();
    if (!w) { S.workerState = "broken"; return null; }
    S.worker = w; S.workerState = "starting"; S.sentDefs = new Map();
    w.onmessage = e => { if (S.worker === w) onWorker(e.data || {}); };
    w.onerror = e => {
      e.preventDefault?.(); if (S.worker !== w) return;
      stopWorker(); S.workerState = "broken";
      if (S.query) schedule(true);
    };
    w.postMessage({type: "ping"});
    return w;
  }
  function stopWorker() {
    const worker = S.worker; S.worker = null;
    clearTimeout(S.idleStop); S.pendingSince = 0; S.sentDefs = new Map(); S.sentStamp = null;
    if (S.workerState !== "broken") S.workerState = "none";
    try { worker?.terminate(); } catch { /* gone */ }
  }
  function onWorker(m) {
    S.lastWorker = {type: m.type, id: m.id, want: S.wantSeq, partial: !!m.partial, stale: !!m.stale, ok: m.result?.ok, reason: m.result?.reason || m.message || null};
    if (m.type === "ready") { S.workerState = "ready"; return; }
    if (m.type === "error") { if (m.id === S.wantSeq) { S.pendingSince = 0; globalThis.console?.warn?.("Route suggestion failed: " + m.message); } return; }
    if (m.type !== "result" || m.id !== S.wantSeq || m.stale) { if (m.id === S.wantSeq && m.stale) S.pendingSince = 0; return; }
    if (!m.partial) S.pendingSince = 0;
    show(m.result, m.id, !!m.partial);
  }

  // ------------------------------------------------------------------ board window
  // Use the editor's journal-backed spatial index to send only copper near the requested route.
  const fpRadius = new WeakMap();
  function radiusOf(def) {
    if (!def?.footprint) return 0;
    const rev = host()?.revision?.() ?? 0, cached = fpRadius.get(def);
    if (cached?.rev === rev) return cached.r;
    let r = 0;
    for (const p of def.footprint.pads || []) r = Math.max(r, Math.hypot(p.x || 0, p.y || 0) + Math.max(p.w || 0, p.h || 0, p.diameter || 0));
    for (const s of def.footprint.shapes || []) for (const q of s.points || []) r = Math.max(r, Math.hypot(q[0], q[1]) + (s.width || 0));
    fpRadius.set(def, {rev, r}); return r;
  }
  function boxOf(it, defs) {
    if (it.kind === "part") { const r = radiusOf(defs.get(it.def)); return r ? [it.x - r, it.y - r, it.x + r, it.y + r] : null; }
    if (it.kind === "track" || it.kind === "graphic") {
      if (!Array.isArray(it.points) || !it.points.length) return null;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of it.points) { if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
      const w = (it.width || 0) / 2; return [x0 - w, y0 - w, x1 + w, y1 + w];
    }
    if (it.kind === "via" || it.kind === "pad") { const r = Math.max(it.diameter || 0, it.w || 0, it.h || 0) / 2 + 0.01; return [it.x - r, it.y - r, it.x + r, it.y + r]; }
    return null;
  }
  const CELL = 4;
  function windowOf(doc, defs, box) {
    const candidates = host()?.view?.()?.query?.(doc, defs, box) ?? doc.items;
    return candidates.filter(it => {
      const b = boxOf(it, defs);
      return b && b[0] <= box[2] && b[2] >= box[0] && b[1] <= box[3] && b[3] >= box[1];
    });
  }

  // ------------------------------------------------------------------ connections
  function airwires() {
    const H = host(), stamp = boardStamp();
    if (sameBoard(S.aw)) return S.aw;
    let res = null;
    try { res = H.view?.()?.boardConnectivity?.(stamp.doc, H.defs(), globalThis.AtriumUndoStore) || H.connections?.(); }
    catch { /* connectivity might not be available yet */ }
    const list = res?.airwires || [];
    if (S.aw?.list === list) return Object.assign(S.aw, stamp);
    const grid = new Map();
    list.forEach((w, k) => {
      const x0 = Math.floor(Math.min(w.from[0], w.to[0]) / CELL), x1 = Math.floor(Math.max(w.from[0], w.to[0]) / CELL), y0 = Math.floor(Math.min(w.from[1], w.to[1]) / CELL), y1 = Math.floor(Math.max(w.from[1], w.to[1]) / CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4000) { (grid.get("big") || grid.set("big", []).get("big")).push(k); return; }
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) { const key = x * 100003 + y; let l = grid.get(key); if (!l) grid.set(key, l = []); l.push(k); }
    });
    S.aw = {...stamp, list, grid}; return S.aw;
  }
  function segD(p, a, b) { const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy; let t = L ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(a[0] + dx * t - p[0], a[1] + dy * t - p[1]); }
  function airwireAt(p, tol) {
    const {list, grid} = airwires(); let best = null, bd = tol;
    const look = k => { const w = list[k], d = segD(p, w.from, w.to); if (d < bd) { bd = d; best = w; } };
    for (let x = Math.floor((p[0] - tol) / CELL); x <= Math.floor((p[0] + tol) / CELL); x++) for (let y = Math.floor((p[1] - tol) / CELL); y <= Math.floor((p[1] + tol) / CELL); y++) for (const k of grid.get(x * 100003 + y) || []) look(k);
    for (const k of grid.get("big") || []) look(k);
    return best;
  }
  // The target of a connection starting at p on net: topology order first, else the nearest
  // unrouted connection end of the net.
  function targetFrom(net, p) {
    const {list} = airwires();
    let best = null, bd = Infinity;
    for (const w of list) {
      if (w.net !== net) continue;
      const a = dist(p, w.from), b = dist(p, w.to), other = a <= b ? w.to : w.from, near = Math.min(a, b);
      const d = near + 0.05 * dist(p, other);
      if (d < bd) { bd = d; best = {from: p, to: other, net, wire: w}; }
    }
    const T = globalThis.AtriumTopology, H = host();
    try {
      const spec = T?.specFor?.(H.doc(), net), seq = spec ? [spec.source, ...(spec.order || [])].filter(Boolean) : [];
      if (best && seq.length > 1) {
        const ref = l => String(l || "").split(".")[0], wire = best.wire, startRef = ref(dist(p, wire.from) <= dist(p, wire.to) ? wire.fromLabel : wire.toLabel), i = seq.indexOf(startRef);
        if (i >= 0) {
          const want = seq[i + 1] ?? seq[i - 1];
          const w2 = list.find(w => w.net === net && (ref(w.fromLabel) === want || ref(w.toLabel) === want));
          if (w2) best = {from: p, to: ref(w2.fromLabel) === want ? w2.from : w2.to, net, wire: w2, topology: true};
        }
      }
    } catch { /* topology optional */ }
    return best;
  }

  // ------------------------------------------------------------------ triggers
  function routeTool() { const H = host(); return !!H && H.doc?.()?.kind === "pcb" && H.tool?.() === "route"; }
  function sessionAnchor() {
    const s = host()?.routeSessionNow?.(); if (!s || typeof s.anchor !== "function") return null;
    try { const a = s.anchor(); return a ? {...a, session: s, net: s.state?.net || ""} : null; } catch { return null; }
  }
  // Called on pointer moves and editor changes: works out what to suggest; requests only when it changed.
  function probe(p) {
    S.lastPointer = p;
    if (!enabled() || !routeTool() || !onscreen() || efficient()) { if (S.result || S.key) clear(); return; }
    const H = host(), v = H.view?.();
    let want = null;
    const an = sessionAnchor();
    if (an) {
      if (!an.net) { if (!S.pinned) clear(); return; }
      const t = targetFrom(an.net, an.point);
      if (t) want = {key: "s|" + an.net + "|" + an.point.map(x => x.toFixed(4)) + "|" + t.to.map(x => x.toFixed(4)) + "|" + an.layer + "|" + an.anchors + "|" + an.width, net: an.net, from: an.point, to: t.to, fromLayer: an.layer, fromFree: an.anchors > 0, session: true, width: an.width};
    } else if (p && !efficient() && pref(PREFS.trigger, "hover") !== "start") {
      const tol = HOVER_PX / Math.max(1e-6, v?.scale?.() || 10);
      const w = airwireAt(p, tol);
      if (w) {
        const near = dist(p, w.from) <= dist(p, w.to);
        const from = near ? w.from : w.to, to = near ? w.to : w.from, layer = H.activeLayer?.();
        want = {key: "a|" + w.net + "|" + from.map(x => x.toFixed(4)) + "|" + to.map(x => x.toFixed(4)) + "|" + layer, net: w.net, from, to, fromLayer: layer};
      }
    }
    if (S.query && !sameBoard(S.query)) clear();
    if (!want) { if (!S.pinned && S.key) clear(); return; }
    if (want.key === S.key || connKey(want) === S.dismissed) return;
    cancelRequest();
    S.pinned = false; S.key = want.key; S.query = {...want, ...boardStamp()}; S.result = null; S.index = 0; S.trigger = now();
    request();
  }
  // A connection's identity, whatever showed it (hover, live route, next after accept): Esc dismisses that connection.
  const connKey = q => q.net + "|" + [q.from, q.to].map(p => p.map(x => x.toFixed(3)).join(",")).sort().join("|");
  function cancelRequest() {
    clearTimeout(S.timer); clearTimeout(S.nextTimer); S.refreshJob?.cancel(); S.refreshJob = null;
    S.wantSeq = ++S.seq; S.firstPaint.clear();
    if (S.pendingSince || S.workerState === "starting") stopWorker();
  }
  function clear() {
    const redraw = !!S.result;
    cancelRequest(); S.key = ""; S.query = null; S.result = null; S.index = 0; S.pinned = false;
    if (redraw) host()?.redrawOverlay?.();
  }
  function schedule(retry) { clearTimeout(S.timer); S.timer = setTimeout(() => { if (S.query) send(S.query); }, retry ? 0 : DEBOUNCE); }
  function request() { schedule(false); }

  // ------------------------------------------------------------------ queries
  function exitAxisAt(doc, defs, p) {
    const A = globalThis.Atrium, box = [p[0] - 25, p[1] - 25, p[0] + 25, p[1] + 25];
    for (const it of windowOf(doc, defs, box)) {
      if (it.kind !== "part" || Math.hypot(it.x - p[0], it.y - p[1]) > 25) continue;
      const fp = defs.get(it.def)?.footprint; if (!fp) continue;
      for (const pad of fp.pads || []) {
        const c = A.world([pad.x, pad.y], it), w = pad.w || pad.diameter || 0, h = pad.h || pad.diameter || 0;
        if (Math.hypot(c[0] - p[0], c[1] - p[1]) > 1e-3) continue;
        const ang = ((it.angle || 0) + (pad.angle || 0)) * Math.PI / 180;
        return {axis: Math.abs(w - h) < 1e-6 ? null : w > h ? [Math.cos(ang), Math.sin(ang)] : [-Math.sin(ang), Math.cos(ang)], centre: [it.x, it.y], part: it};
      }
    }
    return null;
  }
  // Only a user's accepted routes contribute to their personal preferences.
  function biasFor(doc, defs, net, from, project) {
    const Hb = HB(); if (!Hb?.enabled()) return {};
    const p = Hb.load(project); if (p.routes < 3) return {};
    const rules = globalThis.AtriumRouter.core.rulesFor(doc, {}, project);
    const layers = E().routingLayers(doc, defs, rules, net), at = exitAxisAt(doc, defs, from);
    return Hb.bias(p, Hb.classOf(doc, net, project), layers, {exitAxis: at?.axis || null, fanCentre: at?.centre || null});
  }
  function lengthBand(doc, defs, net, project) {
    const L = globalThis.AtriumLength; if (!L?.targetFor) return null;
    try {
      const t = L.targetFor(doc, defs, net, {project}); if (!t || !finite(t.target)) return null;
      const cur = L.netLength(doc, defs, net).length || 0, tol = finite(t.tolerance) ? t.tolerance : 0;
      const remaining = airwires().list.filter(w => w.net === net).length;
      return {min: t.target - tol, max: t.target + tol, offset: cur, final: remaining <= 1, label: t.xSignal ? "xSignal " + (t.xSignal.name || t.xSignal) : null};
    } catch { return null; }
  }
  function pairFor(doc, net, q, project) {
    try {
      const pairs = globalThis.AtriumRules?.diffPairs?.(doc, {project}) || [];
      const dp = pairs.find(p => p.positive === net || p.negative === net); if (!dp) return null;
      const partner = dp.positive === net ? dp.negative : dp.positive;
      const near = (pt) => { let best = null, bd = Infinity; for (const w of airwires().list) if (w.net === partner) for (const e of [w.from, w.to]) { const d = dist(e, pt); if (d < bd) { bd = d; best = {w, e}; } } return best; };
      const a = near(q.from); if (!a || dist(a.e, q.from) > 3) return null;
      const b = a.w.from === a.e ? a.w.to : a.w.from;
      const r = globalThis.AtriumRouter.core.rulesFor(doc, {}, project).diffPair(dp.positive, dp.negative, dp.name, q.fromLayer || "Top", q.from);
      return {partner, from2: a.e, to2: b, gap: r.gap, width: r.width, maxUncoupled: r.maxUncoupled};
    } catch { return null; }
  }
  // Builds the posted query: the window of copper around the connection and the soft preferences.
  function build(q) {
    const H = host(), doc = H.doc(), defs = H.defs(), project = H.project?.();
    const span = dist(q.from, q.to), margin = Math.max(2.5, Math.min(25, span * 0.45)) + 2;
    const box = [Math.min(q.from[0], q.to[0]) - margin, Math.min(q.from[1], q.to[1]) - margin, Math.max(q.from[0], q.to[0]) + margin, Math.max(q.from[1], q.to[1]) + margin];
    let items = windowOf(doc, defs, box);
    // A live route's shoved copper is where the router has it.
    if (q.session) {
      try {
        const s = H.routeSessionNow?.(), plan = s?.commit?.({gloss: false, removeLoops: false, makeId: () => "rs-live"});
        if (plan?.modify?.length) { const m = new Map(plan.modify.map(x => [x.id, x])); items = items.map(it => m.has(it.id) ? {...it, ...m.get(it.id)} : it); }
        if (plan?.add?.length) items = items.concat(plan.add.filter(i => i.kind === "via"));
      } catch { /* keep the board as is */ }
    }
    const meta = {};
    for (const k of Object.keys(doc)) if (k !== "items") meta[k] = doc[k];
    meta.items = items;
    // The worker reads a board copy outside the project: it carries the board's rules (project-rules.js).
    const rules = globalThis.AtriumRules?.stored?.(doc, project); if (rules) meta.rules = rules;
    const ids = new Set(); for (const it of items) if (it.kind === "part") ids.add(it.def);
    const pair = pairFor(doc, q.net, q, project);
    const query = {net: q.net, from: q.from, to: q.to, fromLayer: q.fromLayer, fromFree: !!q.fromFree, bias: biasFor(doc, defs, q.net, q.from, project), length: pair ? null : lengthBand(doc, defs, q.net, project), pair,
      budgetMs: 90, alternatives: true, shove: !q.session, margin: margin - 2};
    return {meta, defs, ids, query, project};
  }
  function send(q) {
    if (S.query !== q || !sameBoard(q) || !routeTool() || !enabled() || !onscreen() || efficient()) return;
    const t0 = now();
    let b;
    try { b = build(q); } catch (e) { globalThis.console?.warn?.(e); return; }
    S.mainMs.push(["build", now() - t0]);
    const id = S.wantSeq = ++S.seq;
    const w = S.worker || startWorker();
    // A worker with no query for IDLE_STOP ms (a minute in Efficiency mode) is stopped; the next query restarts it.
    clearTimeout(S.idleStop); if (w) S.idleStop = setTimeout(() => { if (!S.pendingSince && S.worker) stopWorker(); }, efficient() ? 60000 : IDLE_STOP);
    const options = {project: b.project ? {name: b.project.name} : null, locked: []};
    if (w) {
      if (!sameBoard(S.sentStamp)) { S.sentDefs.clear(); S.sentStamp = boardStamp(); }
      const fresh = [], defIds = [...b.ids];
      for (const id2 of defIds) { const d = b.defs.get(id2); if (d && S.sentDefs.get(id2) !== d) { fresh.push(d); S.sentDefs.set(id2, d); } }
      if (!S.pendingSince) S.pendingSince = now();
      try { (S.worker || w).postMessage({type: "suggest", id, board: b.meta, defs: fresh, defIds, query: b.query, options}); S.mainMs.push(["post", now() - t0]); return; }
      catch { stopWorker(); S.workerState = "broken"; }
    }
    // No worker (tests, locked-down webviews): run here after the frame, with a small budget.
    setTimeout(() => {
      if (id !== S.wantSeq) return;
      const r = E().suggest(b.meta, b.defs, {...b.query, budgetMs: 40}, options);
      show(r, id, false);
    }, 0);
  }
  function show(result, id, partial) {
    if (id !== S.wantSeq || !S.query || !sameBoard(S.query) || !routeTool() || !enabled() || !onscreen()) return;
    if (!result?.ok) { if (!partial) { S.result = null; host()?.redrawOverlay?.(); } return; }
    const keep = S.result && partial === false ? S.result.alternatives[S.index] : null;
    S.result = {...result, net: S.query.net, partial};
    if (keep) { const i = result.alternatives.findIndex(a => a.kind === keep.kind); S.index = i >= 0 ? i : 0; } else if (partial) S.index = 0;
    if (!S.firstPaint.has(id)) S.firstPaint.set(id, {t0: S.trigger, t1: 0, worker: result.ms});
    host()?.redrawOverlay?.();
  }

  // ------------------------------------------------------------------ drawing
  function current() {
    return S.result && sameBoard(S.query) && routeTool() && onscreen() ? S.result.alternatives?.[S.index] || null : null;
  }
  function paint(g, env) {
    const t = now();
    const alt = current();
    if (alt && S.query) {
      const rec = S.firstPaint.get(S.wantSeq);
      if (rec && !rec.t1) { rec.t1 = t; S.lat.push(t - rec.t0); if (S.lat.length > 400) S.lat.shift(); }
      g.save(); g.lineCap = "round"; g.lineJoin = "round";
      const px = 1 / (env.scale || 1), ink = globalThis.AtriumPCBAppearance?.system?.selection || "#f0f0f0"; // the theme's selection ink: white on dark boards, dark on light ones
      for (const m of alt.modify || []) {
        if (!m.points) continue;
        g.globalAlpha = .28; g.strokeStyle = ink; g.lineWidth = .2; g.setLineDash([4 * px, 3 * px]);
        g.beginPath(); m.points.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke();
      }
      g.setLineDash([]);
      for (const l of alt.legs) {
        const col = env.copper ? env.copper(l.layer) : "#d4a017";
        g.globalAlpha = .34; g.strokeStyle = col; g.lineWidth = l.width;
        g.beginPath(); l.points.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke();
        g.globalAlpha = .9; g.strokeStyle = col; g.lineWidth = 1.2 * px; g.setLineDash([5 * px, 4 * px]);
        g.beginPath(); l.points.forEach((p, k) => k ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); g.setLineDash([]);
      }
      for (const v of alt.vias) {
        g.globalAlpha = .4; g.fillStyle = env.copper ? env.copper("Multi") : "#c0c0c0";
        g.beginPath(); g.arc(v.x, v.y, v.diameter / 2, 0, Math.PI * 2); g.fill();
        g.globalAlpha = .9; g.strokeStyle = ink; g.lineWidth = 1.2 * px; g.beginPath(); g.arc(v.x, v.y, v.drill / 2, 0, Math.PI * 2); g.stroke();
      }
      // The target end.
      const end = S.query.to; g.globalAlpha = .9; g.strokeStyle = ink; g.lineWidth = 1.3 * px;
      g.beginPath(); g.arc(end[0], end[1], 5 * px, 0, Math.PI * 2); g.stroke();
      g.restore();
    }
    // Settle flash of an accepted suggestion (route-feel's settle token; fades only when reduced).
    if (S.flash) {
      const F = globalThis.AtriumRouteFeel, TK = F?.tokens?.() || {settle: 220}, k = (t - S.flash.t0) / (TK.settle || 220);
      if (k >= 1 || F?.fadesOK?.() === false) S.flash = null;
      else {
        g.save(); g.lineCap = "round"; g.lineJoin = "round"; g.globalAlpha = .55 * (1 - k); g.strokeStyle = globalThis.AtriumPCBAppearance?.system?.selection || "#ffffff";
        for (const l of S.flash.legs) { g.lineWidth = l.width * (1 + .6 * (1 - k)); g.beginPath(); l.points.forEach((p, i) => i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1])); g.stroke(); }
        g.restore();
        queueMicrotask(() => host()?.redrawOverlay?.());
      }
    }
  }
  // Reuse the keymap's resolver for the suggestion visible on this canvas. Cache the
  // caption so a pointer redraw does not rebuild the effective binding lists.
  let tipQuery, tipAllowsTab, tipKey = "";
  function suggestionKey() {
    const allowsTab = tabAccepts();
    if (tipQuery === S.query && tipAllowsTab === allowsTab) return tipKey;
    tipQuery = S.query; tipAllowsTab = allowsTab;
    const K = globalThis.AtriumKeymap, H = host(), id = "route-suggest-accept";
    const state = {kind: H?.doc?.()?.kind, tool: H?.tool?.(), canvas: true,
      interactive: true, suggestion: visible(), suggestTab: allowsTab, canProperties: !!H?.routeSessionNow?.()};
    const key = K?.bindingsFor(id).find(binding => K.resolve(binding.key, state) === id)?.key;
    return tipKey = K?.display(key) || "";
  }
  globalThis.AtriumKeymap?.onChange(() => { tipQuery = null; if (visible()) host()?.redrawOverlay?.(); });

  // Rows for route-feel.js's head tip: "1/3 · 2 vias · 14.2 mm" and why it looks that way.
  function tipRows() {
    const alt = current(); if (!alt || !S.query) return [];
    const n = S.result.alternatives.length, H = host(), len = H?.len ? H.len(alt.length) : alt.length.toFixed(1) + " mm";
    const head = (n > 1 ? S.index + 1 + "/" + n + " · " : "") + (alt.viaCount === 1 ? "1 via" : alt.viaCount + " vias") + " · " + len + (alt.kind !== "best" ? " · " + alt.label : "");
    const shortcut = suggestionKey();
    const rows = [{text: (shortcut ? shortcut + " · " : "") + head, a: 1}];
    const why = (alt.reasons || []).find(r => /learned|xSignal|Length|pair|Push/.test(r)) || alt.reasons?.[0];
    if (why) rows.push({text: why, a: .85});
    return rows;
  }

  // ------------------------------------------------------------------ keys
  const visible = () => !!(enabled() && current() && S.query && routeTool());
  const tabAccepts = () => visible() && pref(PREFS.tab, "ghost") !== "altium";
  function accept(mode = "all") {
    const H = host(), alt0 = current(); if (!alt0 || !H) return false;
    const doc = H.doc(), defs = H.defs(), q0 = S.query, result = S.result, net = q0.net, Eg = E();
    let part = alt0, rest = null, atVia = false;
    if (mode === "word") { const st = Eg.steps(alt0); if (st.length > 1) { ({head: part, rest} = Eg.prefix(alt0, 0)); atVia = !!st[0].via; } }
    // Re-check on the full board before it becomes copper (the worker saw a window).
    if (!part.modify?.length) {
      const v = Eg.validate(doc, defs, {...part, net, pairPartner: S.query.pair?.partner}, {revision: H.revision?.(), net, project: H.project?.()});
      if (!v.ok) { H.info?.("Suggestion is out of date (" + v.reason + ") — recomputing."); S.key = ""; probe(S.lastPointer); return true; }
    }
    const plan = Eg.toPlan(part, {net, makeId: () => globalThis.Atrium.id()});
    // A live route ends here: its anchored copper and the suggestion become one undo step.
    let pre = null;
    const s = S.query.session ? H.routeSessionNow?.() : null;
    // A live route moved on (a click, Backspace, a layer change) since this ghost: recompute, never stitch.
    const an = s ? sessionAnchor() : null;
    if (s && (!an || dist(an.point, S.query.from) > 1e-6 || an.layer !== S.query.fromLayer)) { S.key = ""; probe(S.lastPointer); H.info?.("Updating the suggestion…"); return true; }
    if (s) {
      try {
        const sp = s.commit({gloss: false});
        plan.add = [...sp.add, ...plan.add]; plan.modify = [...(sp.modify || []), ...plan.modify]; plan.remove = [...(sp.remove || [])];
      } catch { /* suggestion only */ }
      H.setTool?.("route");   // ends the live route (its copper is in this plan); the tool stays Route
    }
    pre = {preview: part.legs.map(l => ({points: l.points, width: l.width, layer: l.layer}))};
    let placed = false;
    H.edit(() => { globalThis.AtriumRouter.apply(H.doc(), plan); placed = true; }, "Accept route suggestion");
    if (!placed) return true;
    cancelRequest();
    S.accepting = true;
    try { globalThis.AtriumRouteFeel?.committed?.({add: plan.add.filter(i => part.legs.some(l => l.points === i.points || sameLine(l.points, i.points)))}, pre); } catch { /* motion optional */ }
    S.accepting = false;
    S.flash = globalThis.AtriumRouteFeel?.fadesOK?.() === false ? null : {legs: part.legs, t0: now()};
    try { HB()?.observe?.(plan, H.doc(), defs, {source: "accepted", project: H.project?.()}); } catch { /* learning optional */ }
    const accLen = part.legs.reduce((a, l) => a + Eg.pathLength(l.points), 0);
    const K = globalThis.AtriumKeymap;
    const stepKey = K?.bindingsFor?.("route-suggest-word")[0]?.key;
    const finishKey = K?.bindingsFor?.("route-suggest-accept").find(binding => binding.when !== "suggestTab" || pref(PREFS.tab, "ghost") !== "altium")?.key;
    const keys = [stepKey && K.display(stepKey) + " for the next segment", finishKey && K.display(finishKey) + " for the rest"].filter(Boolean);
    H.info?.((rest ? "Accepted up to the " + (atVia ? "via" : "bend") + (keys.length ? " (" + keys.join(", ") + ")" : "") : "Suggestion accepted") + " · " + (H.len ? H.len(accLen) : accLen.toFixed(2) + " mm"));
    if (rest && rest.legs.some(l => l.points.length > 1)) {
      rest.length = rest.legs.reduce((a, l) => a + E().pathLength(l.points), 0); rest.viaCount = rest.vias.length;
      S.result = {...result, alternatives: [rest]}; S.index = 0; S.pinned = true; S.key = "p|" + q0.key;
      S.query = {...q0, ...boardStamp(), session: false};
    } else {
      S.result = null; S.query = null; S.key = ""; S.pinned = false;
      if (!efficient() && pref(PREFS.next, true) !== false) {
        const stamp = boardStamp();
        S.nextTimer = setTimeout(() => {if (sameBoard(stamp)) nextNear(q0.to);}, 40);
      }
    }
    H.redrawOverlay?.();
    return true;
  }
  const sameLine = (a, b) => a.length === b.length && a.every((p, i) => Math.abs(p[0] - b[i][0]) < 1e-6 && Math.abs(p[1] - b[i][1]) < 1e-6);
  // Keep going: the unrouted connection nearest the accepted end.
  function nextNear(p) {
    if (!enabled() || !routeTool() || !onscreen() || efficient()) return;
    const {list} = airwires(); let best = null, bd = 15;
    for (const w of list) for (const [a, b] of [[w.from, w.to], [w.to, w.from]]) { const d = dist(a, p); if (d < bd) { bd = d; best = {w, from: a, to: b}; } }
    if (!best) { host()?.info?.("No unrouted connection nearby."); return; }
    if (connKey({net: best.w.net, from: best.from, to: best.to}) === S.dismissed) return;
    S.key = "n|" + best.w.net + "|" + best.from.map(x => x.toFixed(4)); S.pinned = true; S.trigger = now();
    S.query = {...boardStamp(), key: S.key, net: best.w.net, from: best.from, to: best.to, fromLayer: host().activeLayer?.()};
    S.result = null; S.index = 0; request();
  }
  function cycle(step = 1) {
    if (!current()) return false;
    const n = S.result.alternatives.length; S.index = (S.index + step + n) % n;
    const a = current(); host()?.info?.("Suggestion " + (S.index + 1) + "/" + n + ": " + a.label + " · " + a.viaCount + " via" + (a.viaCount === 1 ? "" : "s") + " · " + (host()?.len ? host().len(a.length) : a.length.toFixed(2) + " mm"));
    host()?.redrawOverlay?.(); return true;
  }
  function dismiss() { if (!S.key) return false; S.dismissed = S.query ? connKey(S.query) : S.key; clear(); return true; }
  function toggle() {
    const v = !enabled();
    try { globalThis.AtriumPrefs?.set?.(PREFS.on, v); } catch { /* prefs optional */ }
    if (!v) clear();
    syncMenu();
    host()?.info?.(v ? "Route suggestions on" : "Route suggestions off"); return v;
  }

  // ------------------------------------------------------------------ install
  function onPointer(e) {
    // Nothing to do (and no layout read) unless the Route tool is on a board.
    const H = host(); if (!routeTool()) { if (S.key) clear(); return; }
    const c = H.canvas?.(); if (!c || e.target !== c || !enabled()) return;
    S.refreshJob?.cancel(); S.refreshJob = null;
    const r = c.getBoundingClientRect(), p = H.view().screenToWorld([e.clientX - r.left, e.clientY - r.top]);
    const t0 = now(); probe(p); const ms = now() - t0; if (ms > 0.05) S.mainMs.push(["probe", ms]);
  }

  function changed() {
    const H = host(); clear();
    if (!enabled() || !routeTool() || !onscreen() || !(sessionAnchor() || !efficient() && S.lastPointer)) return;
    if (H.stageEdit) S.refreshJob = H.stageEdit("idle", "route-suggestions", current => {
      S.refreshJob = null;
      if (current()) probe(S.lastPointer);
    });
    else S.timer = setTimeout(() => probe(S.lastPointer), DEBOUNCE);
  }
  // Commands and default keys (lazy, so eager JS stays small; keymap.js only knows the contexts
  // "suggestion" and "suggestTab"). Users rebind them in Keyboard Shortcuts like any command.
  function registerCommands() {
    const K = globalThis.AtriumKeymap; if (!K?.registerCommand || K.command?.("route-suggest-accept")) return;
    const add = spec => { try { K.registerCommand(spec); } catch { /* already there */ } };
    const tip = {category: "Routing", when: "pcb && canvas && suggestion", priority: true};
    add({id: "route-suggest-accept", title: "Accept route suggestion", ...tip, short: "Accept suggestion", defaultKeys: [{key: "Tab", when: "suggestTab"}, "Alt+Enter"]});
    add({id: "route-suggest-next", title: "Next route suggestion", ...tip, defaultKeys: ["Shift+Tab", "Alt+]"]});
    add({id: "route-suggest-prev", title: "Previous route suggestion", ...tip, defaultKeys: ["Alt+["]});
    add({id: "route-suggest-word", title: "Accept route suggestion to the next bend or via", ...tip, defaultKeys: ["Mod+Right"]});
    add({id: "route-suggest-dismiss", title: "Dismiss route suggestion", ...tip, defaultKeys: ["Escape"]});
    add({id: "route-suggest-toggle", title: "Toggle route suggestions", category: "Routing", when: "pcb"});
    add({id: "route-habits", title: "Routing habits…", category: "Routing", when: "pcb"});
  }
  function syncMenu() { const b = globalThis.document?.querySelector?.('[data-action="route-suggest-toggle"]'); if (b) b.setAttribute("aria-checked", String(enabled())); }
  function install() {
    const H = host(); if (S.installed || !H) return;
    S.installed = true;
    registerCommands();
    const N = globalThis.AtriumNavCommon;
    N?.menuItem?.("route", "route-suggest-toggle", "Route Suggestions", {after: "drag-reroute-toggle", scope: "pcb", checkable: true});
    N?.menuItem?.("route", "route-habits", "Routing Habits…", {after: "route-suggest-toggle", scope: "pcb"});
    syncMenu();
    // Clicks and keys change a live route's anchor without moving the pointer.
    const later = e => {
      if (e.target === host()?.canvas?.()) setTimeout(() => probe(S.lastPointer), 0);
      else if (S.key) setTimeout(() => {if (!routeTool()) clear();}, 0);
    };
    globalThis.document?.addEventListener?.("pointerup", later, {capture: true, passive: true});
    globalThis.addEventListener?.("keyup", later, true);
    H.addRenderer?.(() => (current() && S.query) || S.flash ? {overlay: paint} : null);
    H.registerAction?.("route-suggest-accept", () => accept("all")); H.registerAction?.("route-suggest-next", () => cycle(1));
    H.registerAction?.("route-suggest-prev", () => cycle(-1)); H.registerAction?.("route-suggest-word", () => accept("word"));
    H.registerAction?.("route-suggest-dismiss", () => dismiss()); H.registerAction?.("route-suggest-toggle", () => toggle());
    H.registerAction?.("route-habits", () => globalThis.AtriumPrefs?.open?.("route-suggestions"));
    globalThis.document?.addEventListener?.("pointermove", onPointer, {capture: true, passive: true});
    globalThis.document?.addEventListener?.("pointerleave", e => {
      if (e.target !== host()?.canvas?.()) return;
      S.lastPointer = null;
      if (!S.query?.session && !S.pinned) clear();
    }, true);
    H.on?.("document", () => { S.lastPointer = null; S.dismissed = ""; clear(); });
    H.on?.("change", changed);
    globalThis.AtriumPower?.onChange?.(state => {
      if (!state.visible || state.efficient) {
        S.lastPointer = null; clear(); stopWorker();
      }
    });
  }
  function debug() {
    const lat = S.lat.slice().sort((a, b) => a - b), q = p => lat.length ? +lat[Math.min(lat.length - 1, Math.floor(p * (lat.length - 1)))].toFixed(2) : null;
    return {last: S.lastWorker || null, visible: visible(), key: S.key, alternatives: S.result?.alternatives?.length || 0, index: S.index, worker: S.workerState, latency: {n: lat.length, p50: q(.5), p95: q(.95), max: q(1)},
      main: S.mainMs.slice(-200), query: S.query && {net: S.query.net, from: S.query.from, to: S.query.to}};
  }
  // route-feel.js committed(): a hand-routed track (an accepted suggestion learns in accept()).
  function learned(plan) {
    if (S.accepting) return;
    const H = host(); if (!H) return;
    try { HB()?.observe?.(plan, H.doc(), H.defs(), {source: "hand", project: H.project?.()}); } catch { /* learning optional */ }
  }
  // Headless and MCP: suggestions for a connection on a whole board, no UI.
  function suggestFor(doc, defs, q, o = {}) {
    const project = o.project || null, Hb = HB();
    let bias = q.bias;
    if (!bias && Hb && o.habits !== false && (o.profile || Hb.enabled())) {
      const rules = globalThis.AtriumRouter.core.rulesFor(doc, {}, project), layers = E().routingLayers(doc, defs, rules, q.net);
      const prof = o.profile || Hb.load(project);
      bias = prof.routes >= 3 ? Hb.bias(prof, Hb.classOf(doc, q.net, project), layers) : {};
    }
    return E().suggest(doc, defs, {alternatives: true, shove: true, budgetMs: 400, ...q, bias}, {project, revision: o.revision});
  }
  if (globalThis.document) setTimeout(() => { if (host()) install(); else globalThis.AtriumNavCommon?.ready?.(install); }, 0);
  registerCommands();
  return Object.freeze({visible, tabAccepts, accept, cycle, dismiss, toggle, tipRows, probe, paint, debug, suggestFor, install, learned, registerCommands, current: () => current(),
    stopWorker, _state: S, _build: q => build(q)});
})();
