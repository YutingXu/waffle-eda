"use strict";
// AtriumPourAnim: the display side of Repour All (lazy; polygon-pour.js fetches it with the worker pool).
// Nothing here touches the document: the copper the pipeline commits is the copper it computed, and once a
// run ends every frame is the frame the board draws without this module.
//
//   Run. The pipeline calls begin({doc, ids, estimateMs, token}) when Repour All starts in the editor, then
//     solving(token, id) as each pour's solve is dispatched, optionally preview(token, id, regions) with
//     approximate copper, done(token, id, regions) with each pour's exact copper (not yet committed) and
//     end(token, {committed}). A run animates only when it is expected to take over ANIMATE_MS, the
//     Animations preference allows it (AtriumMotion.level(): <html data-motion>, prefers-reduced-motion,
//     Efficiency mode) and AtriumPower.efficient() is false; begin() returns whether it does.
//   Effects. While a pour solves, a highlight travels along its outline (Reduced motion: the outline
//     breathes); a solved pour waiting for its turn keeps a steady faint outline. Pours reveal in pour
//     order (one that finishes early waits for the earlier ones): the new copper sweeps in from the left
//     over the old copper, with a soft leading edge (Reduced motion: a cross-fade). Until a pour reveals,
//     its old stored copper stays on screen; a pour that had none shows its preview copper, if any, faintly.
//   Rendering. display(doc, list) (polygon-pour.js displayPours, which both renderers use) substitutes what
//     is shown; of(region) gives the alpha and sweep clip a region paints with (pcb-pours.js applies it on
//     the 2D path, gpu(region, cam, H) gives the GPU renderer the same as a scissor box). Regions keep their
//     identity, so the GPU's per-region buffers and canvas-fast.js's indexes and LOD paths are reused, and
//     the committed regions are the objects the reveal already showed. The outline effects are an editor
//     overlay (2D canvas, above both renderers). `version` changes whenever the board layer would draw
//     differently (canvas-fast.js keys its board copy on it), so frames that only move the outline
//     highlight reuse the board copy.
//   Cost. Frames come from AtriumPower.frame only while something moves (outline-only frames at 30 fps,
//     2-3 ms in WKWebView on the 25.6k board: the board layer comes from canvas-fast.js's copy); waiting
//     for solves with nothing to show costs nothing. A sweep frame repaints the board layer (7-8 ms there
//     with the pour LOD, pcb-pours.js; the GPU renderer redraws cached buffers). Where the last whole 2D
//     board frame took over 8 ms (canvas-fast.js lastBoardMs), the pours ready in order are revealed
//     together in one board repaint instead (at most one per 120 ms), and their outlines glow and fade on
//     the overlay. (A cross-fade from a copy of the frame, AtriumMotion.reveal, costs about 10 ms a frame
//     in WKWebView: no cheaper.)
globalThis.AtriumPourAnim = (() => {
  const G = globalThis;
  const ANIMATE_MS = 250, SLOW_BOARD_MS = 8, STAGGER = .35, OUTLINE_FPS_MS = 33;
  const WAIT = 0, SOLVING = 1, READY = 2, REVEALING = 3, REVEALED = 4, PASS = 5;
  const now = () => G.performance?.now?.() ?? Date.now();
  const M = () => G.AtriumMotion || null;
  const level = () => { try { return M()?.level?.() || "off"; } catch { return "off"; } };
  const efficient = () => { try { return !!G.AtriumPower?.efficient?.(); } catch { return false; } };
  const allowed = () => level() !== "off" && !efficient() && G.AtriumPower?.visible?.() !== false;
  const ease = name => { try { return M()?.ease?.(name) || (t => t); } catch { return t => t; } };
  const dur = (name, fallback) => { try { const v = M()?.duration?.(name); return Number.isFinite(v) ? v : fallback; } catch { return fallback; } };
  const host = () => G.AtriumNavHost || null;

  let run = null, version = 0, anims = new WeakMap(), raf = 0, timer = 0, overlayAt = 0, attached = false;
  const stats = {runs: 0, animated: 0, frames: 0, boardFrames: 0, overlayFrames: 0, reveals: 0, cheapReveals: 0, maxTickMs: 0, lastTickMs: 0, slowTicks: 0};

  // ---------------------------------------------------------------- run lifecycle
  const sameDoc = (R, doc) => !!doc && (doc === R.doc || (R.docId != null && doc.id === R.docId));
  function boundsOf(regions, into) {
    for (const r of regions || []) {
      const b = r?.bounds;
      if (!Array.isArray(b) || b.length !== 4) continue;
      if (b[0] < into[0]) into[0] = b[0]; if (b[1] < into[1]) into[1] = b[1];
      if (b[2] > into[2]) into[2] = b[2]; if (b[3] > into[3]) into[3] = b[3];
    }
    return into;
  }
  function outlineOf(item) {
    let pts = null;
    try { pts = G.AtriumPolygonPour?.outline?.(item) || item?.points || item?.outline; } catch { pts = item?.points; }
    if (!Array.isArray(pts) || pts.length < 3) return null;
    const xy = new Float64Array(pts.length * 2);
    let n = 0;
    for (const p of pts) { if (!Array.isArray(p) || !Number.isFinite(+p[0]) || !Number.isFinite(+p[1])) return null; xy[n++] = +p[0]; xy[n++] = +p[1]; }
    return xy;
  }
  // Is the stored copper shown now (pourState "source")? A stale board hides it, so a pour waiting for its
  // reveal shows nothing rather than stale copper.
  function shownNow(doc) {
    try {
      const H = host(), v = H?.view?.(), defs = H?.defs?.();
      if (v?.pourState && defs) return v.pourState(doc, defs) === "source";
    } catch { /* no editor */ }
    return true;
  }
  function begin(o) {
    const doc = o?.doc, ids = Array.isArray(o?.ids) ? o.ids : null;
    if (run) stop();
    stats.runs++;
    if (!doc || !ids?.length || !(+o.estimateMs > ANIMATE_MS) || !allowed() || !host()) return false;
    const pours = Array.isArray(doc.pcbDrawing?.pours) ? doc.pcbDrawing.pours : [];
    const order = new Map(), byPolygon = new Map(), items = new Map();
    ids.forEach((id, k) => { if (!order.has(id)) order.set(id, k); });
    for (const r of pours) if (r?.polygon != null && order.has(r.polygon)) { let l = byPolygon.get(r.polygon); if (!l) byPolygon.set(r.polygon, l = []); l.push(r); }
    for (const i of doc.items || []) if (i?.kind === "polygon" && order.has(i.id)) items.set(i.id, i);
    const showOld = shownNow(doc);
    const list = [...order.keys()].map((id, k) => ({
      id, k, phase: WAIT, solveAt: 0, old: showOld ? byPolygon.get(id) || [] : [], preview: null, regions: null,
      outline: outlineOf(items.get(id)), path: null, start: -1, ms: 0, p: 0, x0: 0, x1: 0, y0: 0, y1: 0, edge: 0, flash: 0, flashMs: 0,
      aNew: {alpha: 1, clip: null}, aOld: {alpha: 1, clip: null}, aPrev: {alpha: .45, clip: null},
    }));
    run = {token: o.token, doc, docId: doc.id ?? null, list, byId: new Map(list.map(s => [s.id, s])), next: 0, struct: 0,
      committed: null, ended: false, cached: null, cachedKey: null, cachedStruct: -1, lastStart: null, level: level(), cheapAt: -Infinity};
    stats.animated++;
    attach();
    version++;
    return true;
  }
  const live = token => run && run.token === token && !run.ended ? run : null;
  function solving(token, id) {
    const R = live(token), s = R?.byId.get(id);
    if (!s || s.phase >= READY) return;
    if (s.phase === WAIT) { s.phase = SOLVING; s.solveAt = now(); }
    pump();
  }
  function preview(token, id, regions) {
    const R = live(token), s = R?.byId.get(id);
    if (!s || s.phase >= REVEALING || !Array.isArray(regions)) return;
    s.preview = regions.length ? regions : null;
    for (const r of regions) anims.set(r, s.aPrev);
    R.struct++; version++;
    if (!s.old.length) repaint();
    pump();
  }
  // A restarted solve (an edit meanwhile) may hand a pour's copper over again: the newer copper shows.
  function done(token, id, regions) {
    const R = live(token), s = R?.byId.get(id);
    if (!s || !Array.isArray(regions) || s.regions === regions) return;
    if (s.phase >= REVEALING) {
      s.regions = regions;
      if (s.phase === REVEALING) for (const r of regions) anims.set(r, s.aNew);
      R.struct++; version++; repaint();
    } else { s.phase = READY; s.regions = regions; }
    pump();
  }
  function end(token, o) {
    const R = run && run.token === token ? run : null;
    // A committed run finishes its reveals; a later end (the pipeline's finally) changes nothing.
    if (!R || R.ended) return;
    if (!o?.committed || !allowed()) { stop(); return; }
    // The document now holds the new copper: pours still waiting reveal at once in order (shorter), and a pour
    // that never reported its copper shows what the document holds.
    R.ended = true;
    R.committed = R.doc.pcbDrawing?.pours || null;
    const byPolygon = new Map();
    for (const r of R.committed || []) if (r?.polygon != null && R.byId.has(r.polygon)) { let l = byPolygon.get(r.polygon); if (!l) byPolygon.set(r.polygon, l = []); l.push(r); }
    for (const s of R.list) {
      const now$ = byPolygon.get(s.id) || [];
      if (s.phase < READY) { s.phase = PASS; s.regions = now$; continue; }
      // The same copper done() handed over, as the document's objects: the frames show those from now on.
      s.regions = now$;
      if (s.phase === REVEALING) for (const r of now$) anims.set(r, s.aNew);
    }
    R.struct++; version++;
    pump();
  }
  const repaint = () => { try { host()?.redraw?.(); } catch { /* no editor */ } };
  // Abandon the run: the board shows what the document holds from the next frame.
  function stop() {
    if (!run) return;
    run = null; anims = new WeakMap(); version++;
    if (raf || timer) { clearTimeout(timer); timer = 0; raf = 0; }
    repaint();
  }
  function finish() {
    // Every pour revealed after a commit: from now on the board draws the document's copper.
    run = null; anims = new WeakMap(); version++;
    repaint();
  }

  // ---------------------------------------------------------------- what the board shows
  // list: what displayPours would show. Regions of the run's pours are replaced by what each pour shows now.
  function display(doc, list) {
    const R = run;
    if (!R || !sameDoc(R, doc)) return list;
    if (!Array.isArray(list)) list = EMPTY;   // the board's first pour
    if (R.ended && doc.pcbDrawing?.pours !== R.committed) { stop(); return list; }   // undone, edited: show the document
    if (R.cached && R.cachedKey === list && R.cachedStruct === R.struct) return R.cached;
    const out = [];
    for (const r of list) if (r?.polygon == null || !R.byId.has(r.polygon)) out.push(r);
    for (const s of R.list) {
      if (s.phase === REVEALED || s.phase === PASS) { for (const r of s.regions || []) out.push(r); continue; }
      const before = s.old.length ? s.old : s.preview || [];
      for (const r of before) out.push(r);
      if (s.phase === REVEALING) for (const r of s.regions || []) out.push(r);
    }
    R.cached = out; R.cachedKey = list; R.cachedStruct = R.struct;
    return out;
  }
  // How a region paints during the run: {alpha, clip: [x0, x1] in board mm or null}, or null for as stored.
  const of = region => run && region ? anims.get(region) || null : null;
  // The same for the GPU renderer, in its framebuffer's pixels: {alpha, x0, x1} (scissor columns, full
  // height), false to skip the region, null for as stored. cam: canvas.js I.cam().
  function gpu(region, cam, W) {
    const a = of(region);
    if (!a) return null;
    if (!(a.alpha > 0)) return false;
    if (!a.clip) return {alpha: a.alpha, x0: 0, x1: W};
    const [cx, , scale, flipped, width, , dpr] = cam;
    const px = x => Math.max(0, Math.min(W, Math.round(((flipped ? cx - x : x - cx) * scale + width / 2) * dpr)));
    const p = px(a.clip[0]), q = px(a.clip[1]), x0 = Math.min(p, q), x1 = Math.max(p, q);
    return x1 > x0 ? {alpha: a.alpha, x0, x1} : false;
  }
  const active = doc => !!run && (doc == null || sameDoc(run, doc));

  // ---------------------------------------------------------------- the frame loop
  function slowBoard() {
    try { if (G.AtriumCanvasGPU?.status?.()?.renderer === "gpu") return false; } catch { /* no GPU module */ }
    return (G.AtriumCanvasFast?.lastBoardMs?.() || 0) > SLOW_BOARD_MS;
  }
  function startReveal(R, s, t, backlog, cheap) {
    s.phase = REVEALING; s.start = t; s.p = 0;
    s.ms = backlog >= 4 || R.ended ? dur("fast", 140) : backlog >= 2 ? dur("base", 200) : dur("slow", 320);
    const b = boundsOf(s.regions, boundsOf(s.old.length ? s.old : s.preview, [Infinity, Infinity, -Infinity, -Infinity]));
    s.x0 = Number.isFinite(b[0]) ? b[0] : 0; s.x1 = Number.isFinite(b[2]) ? b[2] : 0;
    s.y0 = Number.isFinite(b[1]) ? b[1] : 0; s.y1 = Number.isFinite(b[3]) ? b[3] : 0;
    for (const r of s.regions || []) anims.set(r, s.aNew);
    for (const r of s.old.length ? s.old : s.preview || []) anims.set(r, s.aOld);
    stats.reveals++;
    R.lastStart = s; R.struct++;
    if (cheap) {
      // One board repaint for the batch; the outline flashes and fades on the overlay (no board frames).
      stats.cheapReveals++;
      s.phase = REVEALED; s.p = 1; s.flash = t; s.flashMs = dur("slow", 320); R.cheapAt = t;
    }
    setAnim(R, s);
  }
  function setAnim(R, s) {
    const full = R.level === "full", e = ease("decelerate")(Math.min(1, s.p));
    if (full) {
      const x = s.x0 + (s.x1 - s.x0) * e;
      s.edge = x;
      s.aNew.alpha = .55 + .45 * e; s.aNew.clip = [-1e7, x];
      s.aOld.alpha = 1; s.aOld.clip = [x, 1e7];
    } else {
      s.aNew.alpha = e; s.aNew.clip = null;
      s.aOld.alpha = 1 - e; s.aOld.clip = null;
    }
  }
  function advance(R, t) {
    if (!allowed()) { R.level = "off"; }
    else R.level = level();
    const instant = R.level === "off";
    const n = R.list.length;
    let backlog = 0, cheap = null;
    for (let k = R.next; k < n; k++) if (R.list[k].phase === READY) backlog++;
    while (R.next < n) {
      const s = R.list[R.next];
      if (s.phase === REVEALED || s.phase === PASS) { R.next++; continue; }
      if (s.phase === REVEALING) { R.next++; continue; }
      if (s.phase !== READY) break;
      const last = R.lastStart;
      if (!instant && last && last.phase === REVEALING && last.p < STAGGER) break;
      if (instant) { s.phase = REVEALED; R.struct++; R.next++; continue; }
      // Where a board frame is slow, every pour ready in order goes in one repaint, one per 120 ms at most.
      cheap ??= slowBoard();
      if (cheap && R.cheapAt !== t && t - R.cheapAt < 120) break;
      startReveal(R, s, t, backlog--, cheap);
      R.next++;
    }
    let moving = false;
    for (const s of R.list) {
      if (s.phase !== REVEALING) continue;
      s.p = instant || s.ms <= 0 ? 1 : (t - s.start) / s.ms;
      if (s.p >= 1) { s.p = 1; s.phase = REVEALED; R.struct++; }
      else { setAnim(R, s); moving = true; }
    }
    if (moving) version++;
    return moving;
  }
  function tick() {
    raf = 0; timer = 0;
    const R = run;
    if (!R) return;
    const t0 = now(), struct = R.struct;
    const moving = advance(R, t0);
    stats.frames++;
    const flashing = R.level !== "off" && R.list.some(s => s.flash > 0 && t0 - s.flash < s.flashMs);
    if (R.ended && !flashing && R.list.every(s => s.phase === REVEALED || s.phase === PASS)) { finish(); note(t0); return; }
    if (R.struct !== struct) version++;
    const solving = R.level !== "off" && R.list.some(s => s.phase === SOLVING);
    const board = moving || R.struct !== struct;
    if (board) { stats.boardFrames++; overlayAt = t0; repaint(); }
    else if (flashing || solving && R.level === "full") { stats.overlayFrames++; overlayAt = t0; try { host()?.redrawOverlay?.() ?? host()?.redraw?.(); } catch { /* no editor */ } }
    // The next pour in order is ready but held back (the reveal before it has just started): come back for it.
    const head = R.list[R.next], held = !!head && head.phase === READY;
    note(t0);
    if (moving || flashing) pump();
    else if (held) { timer = setTimeout(() => { timer = 0; pump(); }, 40); }
    else if (solving && R.level === "full") pump(true);
    // Reduced motion: a slow breath on the outlines (4 frames a second is enough).
    else if (solving) { timer = setTimeout(() => { timer = 0; try { host()?.redrawOverlay?.() ?? host()?.redraw?.(); } catch {} pump(true); }, 250); }
  }
  function note(t0) { const ms = now() - t0; stats.lastTickMs = ms; if (ms > stats.maxTickMs) stats.maxTickMs = ms; if (ms > SLOW_BOARD_MS) stats.slowTicks++; }
  function pump(slow = false) {
    if (raf || timer || !run) return;
    const frame = cb => { const P = G.AtriumPower; return P?.frame ? P.frame(cb) : typeof G.requestAnimationFrame === "function" ? G.requestAnimationFrame(cb) : setTimeout(cb, 16); };
    const current = run, draw = () => { if (run === current) tick(); };
    if (slow) { const wait = Math.max(0, OUTLINE_FPS_MS - (now() - overlayAt) - 8); timer = setTimeout(() => { timer = 0; raf = frame(draw) || 1; }, wait); }
    else raf = frame(draw) || 1;
  }

  // ---------------------------------------------------------------- outline overlay
  let accent = "#f0a32e";
  function readAccent() {
    try { const v = G.getComputedStyle?.(G.document.documentElement)?.getPropertyValue("--accent")?.trim(); if (v) accent = v; } catch { /* keep */ }
  }
  const DASH = [0, 0], SOLID = [], EMPTY = Object.freeze([]);
  function outlinePath(s) {
    if (s.path !== null || !s.outline || typeof Path2D !== "function") return s.path;
    const p = new Path2D(), xy = s.outline;
    p.moveTo(xy[0], xy[1]);
    for (let i = 2; i < xy.length; i += 2) p.lineTo(xy[i], xy[i + 1]);
    p.closePath();
    s.path = p;
    return p;
  }
  function overlay(ctx, env) {
    const R = run;
    if (!R) return;
    const t = now(), px = 1 / (env?.scale || 1), full = R.level === "full";
    ctx.save();
    ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = accent;
    for (const s of R.list) {
      const fl = s.flash > 0 && t - s.flash < s.flashMs ? (t - s.flash) / s.flashMs : -1;
      if (s.phase !== SOLVING && s.phase !== READY && s.phase !== REVEALING && fl < 0) continue;
      const p = outlinePath(s);
      if (!p) continue;
      if (fl >= 0) {
        // A reveal without board frames: the new copper is on, its outline glows and fades.
        const e = 1 - ease("decelerate")(fl);
        ctx.fillStyle = accent; ctx.globalAlpha = .16 * e; ctx.fill(p, "evenodd");
        ctx.globalAlpha = .7 * e; ctx.lineWidth = 1.5 * px; ctx.stroke(p);
        continue;
      }
      if (s.phase === REVEALING) {
        if (!full) continue;
        // The sweep's soft leading edge, inside the outline.
        ctx.save(); ctx.clip(p);
        const w = 14 * px, g = ctx.createLinearGradient?.(s.edge - w, 0, s.edge + 2 * px, 0);
        if (g) {
          g.addColorStop(0, "rgba(255,255,255,0)"); g.addColorStop(1, accent);
          ctx.globalAlpha = .35 * (1 - s.p * s.p); ctx.fillStyle = g;
          ctx.fillRect(s.edge - w, s.y0 - 1, w + 2 * px, s.y1 - s.y0 + 2);
        }
        ctx.restore();
        ctx.globalAlpha = .3 * (1 - s.p); ctx.lineWidth = 1.25 * px; ctx.stroke(p);
        continue;
      }
      // Solving or waiting: a faint outline...
      ctx.lineWidth = 1.25 * px;
      if (s.phase === READY) { ctx.globalAlpha = .3; ctx.stroke(p); continue; }
      const age = t - s.solveAt;
      if (!full) { ctx.globalAlpha = .22 + .18 * Math.sin(age / 420); ctx.stroke(p); continue; }
      ctx.globalAlpha = .22; ctx.stroke(p);
      // ...and a highlight travelling along it.
      DASH[0] = 36 * px; DASH[1] = 220 * px;
      ctx.setLineDash(DASH); ctx.lineDashOffset = -age * .16 * px; ctx.lineWidth = 2 * px; ctx.globalAlpha = .75 * Math.min(1, age / 200);
      ctx.stroke(p); ctx.setLineDash(SOLID); ctx.lineDashOffset = 0;
    }
    ctx.restore();
  }
  const OVERLAY = Object.freeze({overlay});
  function attach() {
    readAccent();
    if (attached) return;
    const H = host();
    if (!H?.addRenderer) return;
    attached = true;
    H.addRenderer((d, info) => run && info?.active && sameDoc(run, d) ? OVERLAY : null);
    // Another document on screen: its frames never show the run, so the run ends there (the document keeps
    // whatever the pipeline commits).
    H.on?.("document", () => { if (run && !sameDoc(run, H.doc?.())) stop(); });
    G.AtriumPower?.onChange?.(state => { if (!state.visible || state.efficient) stop(); });
  }

  return Object.freeze({begin, solving, preview, done, end, display, of, gpu, active, stop,
    ANIMATE_MS, get version() { return version; }, get run() { return run; }, stats: () => ({...stats})});
})();
