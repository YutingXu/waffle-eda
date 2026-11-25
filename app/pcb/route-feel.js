"use strict";
if (!globalThis.AtriumPref && typeof require === "function") require("../editor/theme.js");
if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
// AtriumRouteFeel: the feel of interactive routing. Loads with AtriumRouter (lazy.js), so it
// costs nothing at startup. The router (router.js, diffpair.js) computes geometry; this module
// decides where the head goes (snapping with hysteresis) and how changes look (motion).
//
//   snap(p)                 route-aware snap of a pointer position: pad centre / pad edge (per
//                           Preferences › Routing › Pad entry), track ends and vertices, vias,
//                           a 45° ray from the last anchor ("45° from pad"), then the grid.
//                           Sticky: the current target holds until the pointer leaves 1.6× the
//                           snap radius, and a grid point until the pointer is past half a cell
//                           plus 3 px, so the head never flickers between candidates.
//   frame(preview, routing) called by the editor for every canvas frame. Returns the preview the
//                           canvas draws: shoved copper interpolated toward its new shape
//                           (--motion-push), copper easing back when it is released, the glossed
//                           result after commit easing into place (--motion-gloss). Keeps the
//                           status-bar chip current. Cheap when nothing moves.
//   paint(ctx, opts, env)   called by canvas.js above the router preview: clearance halo and
//                           conflict highlight (faded), settle flash on anchored segments, via
//                           drop and ring, snap marker and label, corner-style glyph at the head.
//   committed(plan, pre)    the editor committed a route (plan) whose last preview was `pre`.
//   spaceAction(action)     key policy: Space and Shift+Space while routing; see below.
//
// Key policy. The default follows Altium: Space flips which end the corner goes on (route-bend)
// and Shift+Space cycles the corner style (route-mode). Preferences › Routing › "Space cycles
// corner style" swaps the two. The first Space while routing offers that swap in a status-bar
// hint (never a modal); the hint is shown once.
//
// Motion follows Preferences › Appearance › Animations (data-motion on <html>; AtriumMotion.level()
// when motion.js is loaded) and the system's prefers-reduced-motion. Full: everything. Reduced:
// fades only (halo, conflict, settle flash, labels), while shoved and glossed copper jumps to its
// final place and vias get no ring. Off: nothing animates.
globalThis.AtriumRouteFeel = (() => {
  const {segmentDistance} = globalThis.AtriumGeometry;
  const clock = () => (globalThis.performance?.now ? performance.now() : Date.now());
  const doc = () => globalThis.document || null;
  const host = () => globalThis.AtriumNavHost || null;
  const CORNER_NAMES = {"45":"45°", "45arc":"45° with arc", "90":"90°", "90arc":"90° with arc", any:"Any angle"};
  const SPACE_HINT_KEY = "atrium.routing.spaceHint";

  // ---------------------------------------------------------------- preferences and motion
  const PREF_DEFAULTS = {"routing.spaceCyclesCorner": false, "routing.padEntry": "centre", "routing.snapLabels": true, "routing.cornerGlyph": true,
    "routing.cornerStyle": "last", "routing.neckDown": true, "routing.jitterTolerance": 100};
  function pref(key) {
    const P = globalThis.AtriumPrefs;
    try { if (P?.get) { const v = P.get(key); if (v !== undefined) return v; } } catch {}
    // AtriumPrefs loads on idle; the eager envelope supplies a stored value until then.
    try { const v = globalThis.AtriumPref?.legacyValue?.(key); if (v !== undefined) return v; } catch {}
    return PREF_DEFAULTS[key];
  }
  function routeOptions(lastCorner) {
    const corner = pref("routing.cornerStyle"), percent = pref("routing.jitterTolerance");
    return {corner: Object.hasOwn(CORNER_NAMES, corner) ? corner : lastCorner, neckDown: pref("routing.neckDown") !== false,
      sideSlack: Number.isFinite(percent) ? Math.min(300, Math.max(0, percent)) / 100 : 1};
  }
  let reduceQuery;
  function level() {
    try { const M = globalThis.AtriumMotion; if (M?.level) return M.level(); } catch {}
    const m = doc()?.documentElement?.getAttribute?.("data-motion");
    if (m === "off") return "off";
    if (m === "reduce") return "reduced";
    if (m === "full") return "full";
    try { reduceQuery ||= globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") || null; return reduceQuery?.matches ? "reduced" : "full"; } catch { return "full"; }
  }
  const motionOK = () => level() === "full";     // geometry travels: shoves, gloss, via ring, glyph pop
  const fadesOK = () => level() !== "off";       // fades: halo, conflict, settle flash, labels
  // Motion tokens (style.css :root); read once, with the documented defaults.
  let T = null;
  function tokens() {
    if (T) return T;
    T = {push: 90, settle: 220, fade: 160, gloss: 140, via: 260, glyph: 1000};
    try {
      const cs = globalThis.getComputedStyle?.(doc().documentElement);
      const ms = (name, d) => { const m = /^\s*([\d.]+)(ms|s)\s*$/.exec(cs?.getPropertyValue(name) || ""); return m && +m[1] ? +m[1] * (m[2] === "s" ? 1000 : 1) : d; };
      T = {push: ms("--motion-push", 90), settle: ms("--motion-settle", 220), fade: ms("--motion-fade", 160), gloss: ms("--motion-gloss", 140), via: ms("--motion-via", 260), glyph: ms("--motion-glyph-hold", 1000)};
    } catch {}
    return T;
  }
  const easeOut = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

  // ---------------------------------------------------------------- redraw loop
  // A microtask, not an rAF: the editor's redrawOverlay() -> drawPointer() asks for the next vsync
  // itself, so an extra rAF here would cost a second frame per animation tick (half rate). The
  // microtask runs after the current render has returned (the editor has reset pointerOnly), so
  // the next frame is still pointer-only and reuses the board layer. Single-flight.
  let queued = false, expiry = 0, expiryAt = 0;
  function kick() {
    if (queued) return; queued = true;
    const run = () => { queued = false; const h = host(); (h?.redrawOverlay || h?.redraw)?.(); };
    if (typeof queueMicrotask === "function") queueMicrotask(run); else Promise.resolve().then(run);
  }
  // Motion Off: nothing animates a transient overlay away, so redraw once when it expires.
  function expireIn(ms) {
    if (typeof setTimeout !== "function") return;
    const when = clock() + Math.max(0, ms);
    if (expiry && expiryAt <= when + 1) return;
    if (expiry) clearTimeout?.(expiry);
    expiryAt = when; expiry = setTimeout(() => { expiry = 0; kick(); }, Math.max(0, ms) + 5);
  }

  // ---------------------------------------------------------------- items by id (current doc)
  let index = null, indexRev = -1, indexDoc = null;
  function itemById(id) {
    const h = host(); if (!h) return null;
    const d = h.doc?.(), rev = h.revision?.();
    if (!index || indexRev !== rev || indexDoc !== d) { index = new Map(); for (const i of d?.items || []) index.set(i.id, i); indexRev = rev; indexDoc = d; }
    return index.get(id) || null;
  }
  const geomOf = it => !it ? null : it.points ? {points: it.points} : Number.isFinite(it.x) ? {x: it.x, y: it.y} : null;

  // ---------------------------------------------------------------- polyline interpolation
  // Each vertex of `to` starts at the point the same fraction along `from`, so shapes with a
  // different number of vertices (a shove adds jogs) still morph without teleporting.
  function cumulative(pts) {
    const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    return c;
  }
  function at(pts, c, s) {
    if (pts.length === 1 || s <= 0) return pts[0];
    const L = c[c.length - 1]; if (s >= L) return pts[pts.length - 1];
    let k = 1; while (k < c.length - 1 && c[k] < s) k++;
    const span = c[k] - c[k - 1] || 1, t = (s - c[k - 1]) / span, a = pts[k - 1], b = pts[k];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  function pairs(from, to) {
    if (!from?.length || !to?.length) return null;
    const cf = cumulative(from), ct = cumulative(to), Lf = cf[cf.length - 1], Lt = ct[ct.length - 1] || 1;
    return to.map((q, i) => { const p = at(from, cf, Lf * ct[i] / Lt); return [p[0], p[1], q[0], q[1]]; });
  }
  const mixPts = (P, k) => P.map(([fx, fy, tx, ty]) => [fx + (tx - fx) * k, fy + (ty - fy) * k]);
  function sameGeom(a, b) {
    if (!a || !b) return false;
    if (a.points || b.points) {
      const p = a.points, q = b.points; if (!p || !q || p.length !== q.length) return false;
      for (let i = 0; i < p.length; i++) if (Math.abs(p[i][0] - q[i][0]) > 1e-6 || Math.abs(p[i][1] - q[i][1]) > 1e-6) return false;
      return true;
    }
    return Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
  }

  function discrete(a, b, w) {
    if (a.points && b.points) {
      if (a.points.length !== b.points.length) return true;
      let m = 0; for (let i = 0; i < a.points.length; i++) m = Math.max(m, Math.hypot(a.points[i][0] - b.points[i][0], a.points[i][1] - b.points[i][1]));
      return m > 2 * w;
    }
    return Math.hypot((a.x ?? 0) - (b.x ?? 0), (a.y ?? 0) - (b.y ?? 0)) > 2 * w;
  }
  // Does displayed shoved copper g (of item q) come within clearance of any head piece?
  function nearHeads(g, q, heads, clr) {
    const pts = g.points || [[g.x, g.y], [g.x, g.y]], w = g.points ? q.width || .25 : q.diameter || .6;
    for (const h of heads || []) {
      const need = (w + (h.width || .25)) / 2 + clr - 1e-6;
      for (let i = 1; i < h.points.length; i++) for (let j = Math.min(1, pts.length - 1); j < pts.length; j++)
        if (segmentDistance(h.points[i - 1], h.points[i], pts[Math.max(0, j - 1)], pts[j]) < need) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- state
  const S = {
    routing: false, hover: false, anims: new Map(),       // id -> {item, from, to, P, t0, dur, release}
    flashes: [], rings: [], gloss: null,     // settle flashes, via rings, post-commit easing
    halo: {a: 0, last: null}, bounds: {a: 0, last: null}, conflict: {a: 0, heads: null},
    glyph: {corner: null, t0: -1e9}, lastT: 0,
    anchoredSig: 0, lastHead: null, viaCount: 0, anchor: null, anchorPad: false, head: null,
    snap: {key: "", point: null, kind: "", label: "", t0: -1e9, grid: null, ray: null},
    chipText: "", timingTarget: false, timingState: "", tip: null, layer: null, nets: null, corner: null, timing: "", spaces: []
  };
  function resetSession() {
    S.flashes.length = 0; S.rings.length = 0; S.anchoredSig = 0; S.lastHead = null; S.viaCount = 0;
    S.anchor = null; S.anchorPad = false; S.head = null; S.snap.key = ""; S.snap.grid = null; S.snap.ray = null;
  }

  // Current displayed geometry of an animation at time t.
  function animNow(a, t) {
    const k = a.dur > 0 ? easeOut((t - a.t0) / a.dur) : 1;
    if (a.to.points) return {points: k >= 1 || !a.P ? a.to.points : mixPts(a.P, k), done: k >= 1};
    return {x: a.from.x + (a.to.x - a.from.x) * k, y: a.from.y + (a.to.y - a.from.y) * k, done: k >= 1};
  }
  function retarget(id, item, to, t, dur, release) {
    const old = S.anims.get(id);
    let from;
    if (old) { const g = animNow(old, t); from = g.points ? {points: g.points} : {x: g.x, y: g.y}; }
    else from = geomOf(itemById(id)) || to;
    const a = {item, from, to, t0: t, dur, release: !!release, P: to.points ? pairs(from.points || [[from.x, from.y]], to.points) : null};
    if (a.P && !from.points) a.P = null;
    S.anims.set(id, a);
    return a;
  }

  // ---------------------------------------------------------------- frame
  const idle = () => !S.routing && !S.hover && !S.anims.size && !S.flashes.length && !S.rings.length && !S.gloss && !S.halo.a && !S.bounds.a && !S.conflict.a;
  function frame(preview, routing, hover) {
    // Most frames on a board are not routing: return at once.
    if (!routing && !hover && idle()) return preview;
    // Route tool before the first click: `hover` is the snapped start point (snap() already ran).
    S.hover = !routing && !!hover;
    if (S.hover) S.anchor = null;
    const t = clock(), motion = motionOK(), fades = fadesOK(), TK = tokens();
    const dt = Math.min(100, Math.max(0, t - (S.lastT || t))); S.lastT = t;
    let busy = false;
    if (routing && !S.routing) { resetSession(); S.glyph = {corner: preview?.corner || null, t0: -1e9};  // the glyph shows on a change, not at the start
      S.halo.a = fades ? 0 : 1; }
    if (!routing && S.routing) sessionEnded(t);
    S.routing = !!routing;
    if (!routing) {
      chip(null); offer(null);
      const r1 = settleRelease(t), r2 = fadeOut(dt, fades);
      busy = r1 || r2 || S.flashes.length > 0 || S.rings.length > 0 || !!S.gloss || S.hover && fades && t - S.snap.t0 < LABEL_MS + TK.fade && !!headLabel();
      if (S.hover && !fades && t - S.snap.t0 < LABEL_MS && headLabel()) expireIn(LABEL_MS - (t - S.snap.t0));
      let out = preview;
      const hide = [];
      for (const [id, a] of S.anims) if (a.release) hide.push(id);
      if (S.gloss) for (const g of S.gloss.items) hide.push(g.id);
      if (hide.length) out = {...(preview || {}), hidden: [...(preview?.hidden || []), ...hide], pushed: [...(preview?.pushed || []), ...releasedItems(t)]};
      if (busy) kick();
      return out;
    }
    if (!preview) return preview;
    S.layer = preview.layer || null; S.corner = preview.corner || null;
    S.nets = preview.pair ? [preview.pair.positive, preview.pair.negative].filter(n => n != null) : null;
    // Corner style changes show the glyph at the head for a second.
    if (preview.corner && preview.corner !== S.glyph.corner) S.glyph = {corner: preview.corner, t0: t};
    chip(preview); offer(preview);
    // Anchored copper grew: the head that was just anchored settles with a short flash.
    let sig = 0; for (const l of preview.preview || []) if (!l.head) sig += l.points.length * 1e3 + (l.points.length > 1 ? l.points[l.points.length - 1][0] : 0);
    if (sig !== S.anchoredSig) {
      if (fades && S.lastHead && sig > S.anchoredSig) for (const h of S.lastHead) S.flashes.push({...h, t0: t, dur: TK.settle});
      S.anchoredSig = sig;
    }
    // Diff pairs have one head piece per net; the pointer follows the pair's centre line.
    const heads = (preview.preview || []).filter(l => l.head && l.points?.length > 1), head = heads[0] || null, pair = !!preview.centre;
    S.lastHead = heads.length ? heads.map(h => ({points: h.points, width: h.width, layer: h.layer})) : null;
    S.head = pair && S.snap.point ? S.snap.point : head ? head.points[head.points.length - 1] : preview.end || null;
    const anchorNow = pair ? null : head ? head.points[0] : preview.end || null;
    if (!anchorNow) S.anchor = null;
    else if (!S.anchor || anchorNow[0] !== S.anchor[0] || anchorNow[1] !== S.anchor[1]) { S.anchor = anchorNow; S.anchorPad = padAt(anchorNow, 0.05) != null; }
    // New vias drop in with a ring.
    const vias = preview.vias || [];
    if (vias.length > S.viaCount && motion) for (const v of vias.slice(S.viaCount)) S.rings.push({x: v.x ?? v.at?.[0], y: v.y ?? v.at?.[1], d: v.diameter || .6, t0: t, dur: TK.via});
    S.viaCount = vias.length;
    // Shoved copper eases only on discrete changes: when it is first shoved, when a jog appears or
    // goes (vertex count), or when a vertex jumps by more than two track widths. Small continuous
    // updates show the router's shape at once (easing them made the copper lag the pointer), and an
    // eased shape that would come within clearance of the head jumps to the router's result.
    const seen = new Set(), pushedOut = [];
    const clr = preview.halo?.width != null && preview.width != null ? Math.max(0, (preview.halo.width - preview.width) / 2) : 0;
    for (const q of preview.pushed || []) {
      seen.add(q.id);
      const to = q.points ? {points: q.points} : {x: q.x, y: q.y};
      let a = S.anims.get(q.id);
      if (!motion) { S.anims.delete(q.id); pushedOut.push(q); continue; }
      if (!a || a.release) a = retarget(q.id, q, to, t, TK.push, false);
      else if (!sameGeom(a.to, to)) {
        if (discrete(a.to, to, q.width || q.diameter || .25)) a = retarget(q.id, q, to, t, TK.push, false);
        else { a = {item: q, from: to, to, t0: t, dur: 0, release: false, P: null}; S.anims.set(q.id, a); }
        a.retarget = true;
      } else a.item = q;
      let g = animNow(a, t);
      if (!g.done && a.retarget && nearHeads(g, q, heads, clr)) { a.dur = 0; g = animNow(a, t); }
      if (!g.done) busy = true;
      pushedOut.push(g.points ? {...q, points: g.points} : {...q, x: g.x, y: g.y});
    }
    const hidden = preview.hidden ? preview.hidden.slice() : [];
    for (const [id, a] of S.anims) {
      if (seen.has(id)) continue;
      if (!a.release) {
        const orig = geomOf(itemById(id));
        if (!orig || !motion) { S.anims.delete(id); continue; }
        retarget(id, a.item, orig, t, TK.push, true);
      }
      const r = S.anims.get(id), g = animNow(r, t);
      if (g.done) { S.anims.delete(id); continue; }
      busy = true; hidden.push(id);
      pushedOut.push(g.points ? {...r.item, points: g.points} : {...r.item, x: g.x, y: g.y});
    }
    // Halo and clearance boundaries fade in and out; a conflict blends to red, never blinks.
    const ease = (o, target, last) => { if (last) o.last = last; const k = fades ? 1 - Math.exp(-dt / Math.max(1, TK.fade / 3)) : 1; o.a += (target - o.a) * k; if (Math.abs(o.a - target) < .01) o.a = target; else busy = true; };
    ease(S.halo, preview.halo?.points ? 1 : 0, preview.halo?.points ? preview.halo : null);
    const bs = preview.boundaries || [];
    ease(S.bounds, bs.length ? 1 : 0, bs.length ? bs : null);
    const bad = preview.status === "violation";
    ease(S.conflict, bad ? 1 : 0, null);
    if (heads.length) S.conflict.heads = heads;
    if (fades && t - S.glyph.t0 < TK.glyph + TK.fade * 2) busy = true;
    else if (!fades && t - S.glyph.t0 < TK.glyph) expireIn(TK.glyph - (t - S.glyph.t0));
    if (fades && t - S.snap.t0 < LABEL_MS + TK.fade && headLabel()) busy = true;
    else if (!fades && t - S.snap.t0 < LABEL_MS && headLabel()) expireIn(LABEL_MS - (t - S.snap.t0));
    if (S.flashes.length || S.rings.length) busy = true;
    if (busy) kick();
    const out = {...preview, pushed: pushedOut, hidden, halo: null, boundaries: [], feel: true};
    if (bad) out.status = "violation-faded";
    return out;
  }
  // The session ended (commit, cancel or Escape): copper that was shoved eases to wherever the
  // document now has it (its committed shape, or back to the original).
  function sessionEnded(t) {
    const motion = motionOK(), TK = tokens();
    for (const [id, a] of [...S.anims]) {
      if (!motion) { S.anims.delete(id); continue; }
      const now = geomOf(itemById(id));
      if (!now) { S.anims.delete(id); continue; }
      const cur = animNow(a, t), shown = cur.points ? {points: cur.points} : {x: cur.x, y: cur.y};
      if (sameGeom(shown, now)) { S.anims.delete(id); continue; }
      retarget(id, a.item, now, t, TK.push, true);
    }
    chip(null); offer(null);
  }
  function settleRelease(t) {
    let busy = false;
    for (const [id, a] of S.anims) { if (!a.release) { S.anims.delete(id); continue; } if (animNow(a, t).done) S.anims.delete(id); else busy = true; }
    if (S.gloss && t - S.gloss.t0 >= S.gloss.dur) S.gloss = null;
    return busy;
  }
  function releasedItems(t) {
    const out = [];
    for (const [, a] of S.anims) if (a.release) { const g = animNow(a, t); out.push(g.points ? {...a.item, points: g.points} : {...a.item, x: g.x, y: g.y}); }
    return out;
  }
  function fadeOut(dt, motion) {
    let busy = false;
    for (const o of [S.halo, S.bounds, S.conflict]) {
      if (!motion) { o.a = 0; continue; }
      o.a *= Math.exp(-dt / Math.max(1, tokens().fade / 3)); if (o.a < .01) o.a = 0; else busy = true;
    }
    return busy;
  }

  // ---------------------------------------------------------------- commit
  // plan: AtriumRouter.commit() output; pre: the last preview before the commit.
  function committed(plan, pre) {
    if (!plan) return;
    try { globalThis.AtriumRouteSuggest?.learned?.(plan); } catch { /* route-suggest: learn from hand-routed tracks */ }
    const t = clock(), TK = tokens();
    if (!fadesOK()) { S.gloss = null; return; }
    const added = (plan.add || []).filter(i => i.kind === "track" && i.points?.length > 1);
    const legs = (pre?.preview || []).filter(l => !l.head && l.points?.length > 1);
    const items = [];
    // Single-ended routes only: a diff pair's pieces do not map one to one onto its committed tracks.
    if (!pre?.centre && legs.length === added.length) added.forEach((tr, k) => {
      const from = legs[k].points;
      if (!sameGeom({points: from}, {points: tr.points})) items.push({id: tr.id, layer: tr.layer, width: tr.width, P: pairs(from, tr.points), to: tr.points});
    });
    S.gloss = items.length && motionOK() ? {items, t0: t, dur: TK.gloss} : null;
    for (const tr of added) S.flashes.push({points: tr.points, width: tr.width, layer: tr.layer, t0: t + (S.gloss ? TK.gloss * .6 : 0), dur: TK.settle});
    kick();
  }

  // ---------------------------------------------------------------- snapping
  // Copper side of a pad: drilled pads are on every layer; SMD pads follow the part's side.
  const flipSide = l => l === "Top" ? "Bottom" : l === "Bottom" ? "Top" : l;
  function padLayer(pad, part) {
    if (pad.drill > 0 || pad.layer === "Multi") return "Multi";
    const l = pad.layer || "Top";
    return part?.layer === "Bottom" || part?.side === "bottom" ? flipSide(l) : l;
  }
  // Pads near p (within r + 6 mm): {at, w, h, angle, id, net, layer, label}.
  function pads(p, r) {
    const h = host(), A = globalThis.Atrium; if (!h || !A) return [];
    const d = h.doc(), defs = h.defs(), view = h.view(), out = [];
    const near = view.query ? view.query(d, defs, [p[0] - r - 6, p[1] - r - 6, p[0] + r + 6, p[1] + r + 6]) : d.items;
    for (const i of near) {
      if (i.kind === "pad") out.push({at: [i.x, i.y], w: i.w || i.diameter || .6, h: i.h || i.diameter || .6, angle: i.angle || 0, id: i.id, net: i.net ?? "", layer: padLayer(i, null), label: "Pad"});
      else if (i.kind === "part") {
        const def = defs.get(i.def); if (!def?.footprint) continue;
        for (const pin of A.pins(i, def, "pcb")) {
          if (pin.hidden) continue;
          const w = +pin.w || +pin.size || +pin.diameter || .6, hh = +pin.h || +pin.size || +pin.diameter || .6;
          out.push({at: pin.at, w, h: hh, angle: (pin.angle || 0) + (i.angle || 0), id: i.id, net: i.pinNets?.[pin.number] ?? pin.net ?? "", layer: padLayer(pin, i),
            label: "Pad " + (i.ref || "") + (pin.number != null ? "." + pin.number : "")});
        }
      }
    }
    return out;
  }
  // While a route is live only its own net (both nets of a diff pair) on the head's layer can be a
  // target: other nets are obstacles, never snap targets (Altium). Before the first click, anything.
  function filter() {
    const live = host()?.liveRoute?.();
    if (!live) return null;
    const nets = new Set(S.nets?.length ? S.nets : [live.net ?? ""]), layer = S.layer || live.preview?.layer || null;
    return c => nets.has(c.net ?? "") && (!layer || !c.layer || c.layer === "Multi" || c.layer === layer);
  }
  // The pad whose copper contains p (within tol), as {pad, local:[u,v]}.
  function padAt(p, tol = 0, ok = null, list = null) {
    let best = null;
    for (const pad of list || pads(p, 3)) {
      if (ok && !ok(pad)) continue;
      const a = -pad.angle * Math.PI / 180, dx = p[0] - pad.at[0], dy = p[1] - pad.at[1];
      const u = dx * Math.cos(a) - dy * Math.sin(a), v = dx * Math.sin(a) + dy * Math.cos(a);
      if (Math.abs(u) <= pad.w / 2 + tol && Math.abs(v) <= pad.h / 2 + tol) {
        const d = Math.hypot(dx, dy); if (!best || d < best.d) best = {pad, local: [u, v], d};
      }
    }
    return best;
  }
  // Pad edge entry: the midpoint of the side nearest the pointer, in board coordinates.
  function padEdge(hit) {
    const {pad, local: [u, v]} = hit, a = pad.angle * Math.PI / 180;
    const su = (pad.w / 2 - Math.abs(u)) / (pad.w || 1), sv = (pad.h / 2 - Math.abs(v)) / (pad.h || 1);
    const lu = su < sv ? Math.sign(u || 1) * pad.w / 2 : 0, lv = su < sv ? 0 : Math.sign(v || 1) * pad.h / 2;
    return [pad.at[0] + lu * Math.cos(a) - lv * Math.sin(a), pad.at[1] + lu * Math.sin(a) + lv * Math.cos(a)];
  }
  // Snap targets within r of p: vias, pad centres, track ends and vertices, with net and layer.
  function objects(p, r, sp, padList) {
    const h = host(), d = h.doc(), defs = h.defs(), view = h.view(), out = [], hidden = h.hiddenLayers?.();
    const visible = i => (!h.selectable || h.selectable(i)) && (!hidden || i.kind === "part" || !i.layer || i.layer === "Multi" || !hidden.has(i.layer));
    const add = (q, kind, id, net, layer, label) => { const e = Math.hypot(q[0] - p[0], q[1] - p[1]); if (e <= r) out.push({point: [q[0], q[1]], kind, id, net: net ?? "", layer, label, dist: e}); };
    const items = view.query ? view.query(d, defs, [p[0] - r, p[1] - r, p[0] + r, p[1] + r]) : d.items;
    for (const i of items) {
      if (!visible(i)) continue;
      if (i.kind === "via") { if (sp.vias !== false) add([i.x, i.y], "via", i.id, i.net, "Multi", "Via"); }
      else if (i.kind === "track") {
        if (sp.tracks === false || !i.points?.length) continue;
        i.points.forEach((q, k) => add(q, k === 0 || k === i.points.length - 1 ? "track-end" : "track", i.id, i.net, i.layer, k === 0 || k === i.points.length - 1 ? "Track end" : "Track vertex"));
      }
    }
    if (sp.pads !== false) for (const pad of padList || pads(p, r)) if (!hidden?.has?.(pad.layer)) add(pad.at, "pad", pad.id, pad.net, pad.layer, pad.label + " · centre");
    return out;
  }
  function snapGrid(p, g, scale) {
    const A = globalThis.Atrium, sn = (v) => A?.snap ? A.snap(v, g) : Math.round(v / g) * g;
    const q = [sn(p[0]), sn(p[1])], cur = S.snap.grid;
    if (cur) {
      // Hysteresis: hold the current grid point until the pointer is past half a cell plus 3 px.
      const hold = g / 2 + Math.min(g / 4, 3 / scale);
      if (Math.abs(p[0] - cur[0]) <= hold && Math.abs(p[1] - cur[1]) <= hold) return cur;
    }
    S.snap.grid = q; return q;
  }
  function setSnap(point, kind, label, key) {
    if (key !== S.snap.key) { S.snap.key = key; S.snap.t0 = clock(); }
    S.snap.point = point; S.snap.kind = kind; S.snap.label = label;
    return point;
  }
  function snap(p) {
    const h = host(), A = globalThis.Atrium; if (!h || !p) return p;
    const view = h.view(), scale = view.scale() || 1, d = h.doc();
    const E = globalThis.AtriumPCBEdit, sp = E?.snapPrefs || {grid: true, objects: true, radius: 8, pads: true, vias: true, tracks: true};
    const R = (sp.radius || 8) / scale, objectsOn = sp.objects !== false, ok = filter();
    const g = sp.grid !== false && d.grid > 0 ? d.grid : 0, sn = v => A?.snap ? A.snap(v, g) : Math.round(v / g) * g;
    // 1. Pad entry: inside a pad's copper the head lands on its centre or its edge, per preference.
    const near = pads(p, Math.max(3, R * 1.6));   // one pad query serves pad entry and object snap
    const hit = objectsOn || sp.pads !== false ? padAt(p, 0, ok, near) : null;
    if (hit) {
      const mode = pref("routing.padEntry");
      if (mode === "edge") return setSnap(padEdge(hit), "pad-edge", hit.pad.label + " · edge", "pe:" + hit.pad.at);
      if (mode !== "any") return setSnap(hit.pad.at.slice(), "pad", hit.pad.label + " · centre", "pad:" + hit.pad.id + ":" + hit.pad.at);
    }
    if (objectsOn) {
      // 2. Objects: the held target stays while it is within 1.6× the snap radius, even when another
      //    candidate is nearer; otherwise the nearest within the radius.
      const cands = objects(p, R * 1.6, sp, near).filter(c => !ok || ok(c));
      const keyOf = c => (c.kind === "pad" ? "pad:" : c.kind + ":") + c.id + ":" + c.point;
      let best = cands.find(c => keyOf(c) === S.snap.key) || null;
      if (!best) for (const c of cands) if (c.dist <= R && (!best || c.dist < best.dist)) best = c;
      if (best) { S.snap.grid = null; S.snap.ray = null; return setSnap(best.point, best.kind, best.label, keyOf(best)); }
      // 3. Straight out of the last anchor (not for any-angle routing): onto the nearest 45° ray,
      //    rounded per axis, so a ray from an on-grid anchor ends on the grid. Near a grid crossing
      //    the crossing wins unless the ray passes through it.
      const a = S.anchor;
      if (a && S.corner !== "any") {
        const dx = p[0] - a[0], dy = p[1] - a[1], L = Math.hypot(dx, dy);
        if (L > 2 * R) {
          const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)), ang = oct * Math.PI / 4, ux = Math.cos(ang), uy = Math.sin(ang);
          const along = dx * ux + dy * uy, off = Math.abs(dx * uy - dy * ux), key = "ray:" + oct + ":" + a;
          if (along > 0 && off <= (key === S.snap.key ? 5 : 3) / scale) {
            const diag = Math.abs(oct) % 2 === 1, sx = Math.sign(Math.round(ux * 1e9)), sy = Math.sign(Math.round(uy * 1e9));
            let q;
            if (diag) { const pr = (dx * sx + dy * sy) / 2, k = g ? Math.round(pr / g) * g : pr; q = k > 0 ? [a[0] + sx * k, a[1] + sy * k] : null; }
            else if (sx) { const x = g ? sn(p[0]) : p[0]; q = (x - a[0]) * sx > 0 ? [x, a[1]] : null; }
            else { const y = g ? sn(p[1]) : p[1]; q = (y - a[1]) * sy > 0 ? [a[0], y] : null; }
            const gc = g ? [sn(p[0]), sn(p[1])] : null;
            if (q && !(gc && Math.hypot(p[0] - gc[0], p[1] - gc[1]) <= 2 / scale && !same(q, gc))) {
              S.snap.grid = null; S.snap.ray = [a, ang];
              return setSnap(q, "ray", (diag ? "45°" : "Straight") + (S.anchorPad ? " from pad" : " from anchor"), key);
            }
          }
        }
      }
    }
    S.snap.ray = null;
    // 4. Grid.
    if (g) { const q = snapGrid(p, g, scale); return setSnap(q, "grid", "Grid " + fmt(g), "grid"); }
    S.snap.grid = null;
    return setSnap(p.slice(), "free", "", "free");
  }
  const same = (a, b) => a && b && Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  const fmt = mm => { try { const u = host()?.units?.(); if (u === "mil") return Math.round(mm / .0254 * 100) / 100 + " mil"; } catch {} return +mm.toFixed(4) + " mm"; };

  // ---------------------------------------------------------------- route start (editor.js routeStart)
  // Altium starts a route from the pad or track under the cursor, not only an exact pad centre: take that
  // object's net and start from the pad centre. c: {netAt(p), pointer, opts (lineOpts), view, doc, defs}.
  function start(p, c) {
    const exact = c.netAt(p); if (exact.hit) return {net: exact.net, point: p};
    const q = c.pointer || p, A = globalThis.Atrium; let best = null;
    for (const i of c.view.query?.(c.doc, c.defs, [q[0] - 3, q[1] - 3, q[0] + 3, q[1] + 3]) || []) {
      if (i.kind !== "part") continue;
      for (const pin of A.pins(i, c.defs.get(i.def), "pcb")) {
        if (pin.hidden || !globalThis.AtriumCanvas.canContact(pin, i, c.opts)) continue;
        const r = Math.max(+pin.w || 0, +pin.h || 0, +pin.size || 0, +pin.diameter || 0) / 2 || .4, d = Math.hypot(pin.at[0] - q[0], pin.at[1] - q[1]);
        if (d <= r && (!best || d < best.d)) best = {d, net: i.pinNets?.[pin.number] ?? pin.net ?? "", point: pin.at};
      }
    }
    if (best) return {net: best.net, point: best.point};
    const hit = c.view.hit(c.doc, c.defs, q, {...c.opts, kinds: ["track", "via"], contactOnly: true});
    return {net: hit ? hit.net || "" : "", point: p};
  }

  // ---------------------------------------------------------------- arc radius (editor.js route-arc: , and .)
  const ARC_MAX = 10;
  function arcRadius(st) {
    st ||= host()?.routeTool?.()?.state?.(); if (!st) return null;
    return Number.isFinite(st.arcRadius) && st.arcRadius > 0 ? st.arcRadius : Math.max(.25, 2.5 * (st.width || .25));
  }
  // dir -1 smaller, +1 larger: steps from the radius in use, bounded to [track width, 10 mm]. Returns the message.
  function arcKey(session, dir) {
    const st = session?.state; if (!st || !session.setArcRadius) return "";
    if (!/arc$/.test(st.corner || "")) return "Arc radius applies to arc corners (Shift+Space to choose one).";
    const r0 = arcRadius(st), lo = Math.max(.05, st.width || .1), want = dir < 0 ? r0 / 1.25 : r0 * 1.25, r = Math.min(ARC_MAX, Math.max(lo, want));
    session.setArcRadius(r);
    S.glyph = {corner: st.corner, t0: clock()};
    return "Arc radius " + fmt(r) + (r <= lo + 1e-9 && want < lo ? " (minimum)" : r >= ARC_MAX - 1e-9 && want > ARC_MAX ? " (maximum)" : "");
  }
  // Timing Vision's live numbers while routing (timing-vision.js hands them over instead of a pop-up).
  function timing(m) {
    const t = !m ? "" : m.bar || !/no target/.test(m.lines?.[1] || "") ? m.lines?.[0] || "" : (m.lines?.[1] || "").replace(/ · no target$/, "");
    const tgt = !!(m && (m.bar || !/no target/.test(m.lines?.[1] || ""))), st = m?.state || "";
    if (t !== S.timing || tgt !== S.timingTarget || st !== S.timingState) { S.timing = t; S.timingTarget = tgt; S.timingState = st; kick(); }
  }

  // ---------------------------------------------------------------- status text (editor.js routeStatus)
  // r: the router or diff-pair preview; len(mm) formats a length in the document's units.
  function status(r, len) {
    const arc = /arc$/.test(r.corner || "") ? arcRadius() : null;
    const parts = [r.modeName, (r.cornerName || "") + (arc != null ? " R" + len(arc) : ""), r.width != null ? len(r.width) : "", r.layer, r.length != null ? "Length " + len(r.length) : ""];
    if (r.skew != null) parts.push("Skew " + len(r.skew) + (r.uncoupledOk === false ? " · uncoupled too long" : ""));
    if (r.status === "blocked") parts.push("Blocked"); else if (r.status === "violation") parts.push("Violation");
    if (r.notes?.length) parts.push(...r.notes);
    if (r.transition && r.transition !== "mitered") parts.push(r.transitionName || r.transition);
    return parts.filter(Boolean).join(" · ");
  }

  // ---------------------------------------------------------------- status-bar chip and hint
  function chip(preview) {
    const D = doc(); if (!D?.getElementById) return;
    let el = D.getElementById("route-feel-chip");
    if (!preview) { if (el && !el.hidden) { el.hidden = true; S.chipText = ""; } return; }
    const arc = /arc$/.test(preview.corner || "") ? arcRadius() : null, sn = S.snap;
    const target = pref("routing.snapLabels") !== false && sn.label && !/^(grid|free|ray)$/.test(sn.kind) ? sn.label : "";
    const text = [(CORNER_NAMES[preview.corner] || preview.cornerName || "") + (arc != null ? " R" + fmt(arc) : ""), preview.modeName ? preview.modeName.replace(/ obstacles$/, "") : "",
      target, S.timing].filter(Boolean).join(" · ");
    if (!el) {
      const anchor = D.getElementById("tool-value") || D.getElementById("status"); if (!anchor) return;
      el = D.createElement("span"); el.id = "route-feel-chip"; el.className = "route-feel-chip";
      el.title = "Corner style (arc radius), conflict mode, snap target and timing. Shift+Space cycles the corner style (Space with Preferences › Routing › Space cycles corner style), , and . change the arc radius, Shift+R cycles the mode.";
      const g = D.createElementNS?.("http://www.w3.org/2000/svg", "svg");
      if (g) { g.setAttribute("viewBox", "0 0 16 12"); g.setAttribute("aria-hidden", "true"); g.classList.add("route-feel-glyph"); const p = D.createElementNS("http://www.w3.org/2000/svg", "path"); g.append(p); el.append(g); }
      const s = D.createElement("span"); s.className = "route-feel-text"; el.append(s);
      anchor.after(el);
    }
    if (el.hidden) el.hidden = false;
    if (text !== S.chipText) {
      S.chipText = text;
      el.querySelector(".route-feel-text").textContent = text;
      el.querySelector("path")?.setAttribute("d", GLYPH_PATH[preview.corner] || GLYPH_PATH["45"]);
      el.dataset.corner = preview.corner || "";
    }
  }
  // A pair routed by name match only (diffpair.js source "names") stays a suggestion until declared: the status
  // bar offers to declare it (one undo step); it is never declared by routing it.
  const AtriumI18n = globalThis.AtriumI18n || {define: m => (k, v) => m[k].replace(/\{(\w+)\}/g, (x, n) => v?.[n] ?? x)};
  const tr = AtriumI18n.define({
    "route.pair_offer": "Declare pair {name}",
    "route.pair_offer_title": "{name}: {positive} and {negative} match by name only. Declare it as a differential signal (one undo step)."
  });
  const declaredPairs = new Set();
  let offered = null;   // the pair the offer button declares
  function offer(preview) {
    const D = doc(); if (!D?.getElementById) return;
    let el = D.getElementById("route-pair-offer");
    const p = preview?.pair, key = p ? p.positive + "\u0001" + p.negative : "";
    if (!p || p.source !== "names" || declaredPairs.has(key)) { if (el && !el.hidden) el.hidden = true; return; }
    if (!el) {
      const anchor = D.getElementById("route-feel-chip") || D.getElementById("tool-value") || D.getElementById("status"); if (!anchor) return;
      el = D.createElement("button"); el.setAttribute("type", "button"); el.id = "route-pair-offer"; el.className = "route-pair-offer status-action";
      el.onclick = () => declarePair(offered);
      anchor.after(el);
    }
    offered = {name: p.name, positive: p.positive, negative: p.negative};
    const text = tr("route.pair_offer", {name: p.name});
    if (el.textContent !== text) { el.textContent = text; el.title = tr("route.pair_offer_title", {name: p.name, positive: p.positive, negative: p.negative}); }
    if (el.hidden) el.hidden = false;
  }
  async function declarePair(p) {
    const h = host(); if (!h || !p) return;
    const L = globalThis.AtriumLazy;
    try { if (!globalThis.AtriumSignalsPanel && L?.modules?.().includes("AtriumSignalsPanel")) await L.need("AtriumSignalsPanel"); } catch { /* reported below */ }
    const P = globalThis.AtriumSignalsPanel;
    if (!P?.actions?.accept) { h.info?.("Signals are unavailable in this build."); return; }
    let msg = "";
    try { h.edit(() => { msg = P.actions.accept(h.project(), h.doc(), {suggestion: p}); }); } catch (e) { h.info?.(e.message); return; }
    declaredPairs.add(p.positive + "\u0001" + p.negative);
    const el = doc()?.getElementById?.("route-pair-offer"); if (el) el.hidden = true;
    if (msg) h.info?.(msg);
  }
  // 16×12 glyphs: the head comes in from the left and turns up to the right.
  const GLYPH_PATH = {"45": "M1 10H8L13 5V1", "45arc": "M1 10H7Q9 10 10.5 8.5L13 6Q14 5 14 3V1", "90": "M1 10H13V1", "90arc": "M1 10H9Q13 10 13 6V1", any: "M1 10L13 1"};

  let hintShown = false;
  // The editor passes every key action dispatched while the PCB router tool is active, with its keydown.
  function spaceAction(action, e) {
    if (action !== "route-bend" && action !== "route-mode" || e && e.code !== "Space" && e.key !== " ") return action;
    const swap = !!pref("routing.spaceCyclesCorner");
    if (!swap && action === "route-bend") {
      const t = clock(); S.spaces = S.spaces.filter(x => t - x < 3000); S.spaces.push(t);
      if (S.spaces.length >= 3) offerHint();
    }
    return swap ? (action === "route-bend" ? "route-mode" : action === "route-mode" ? "route-bend" : action) : action;
  }
  function offerHint() {
    if (hintShown) return; hintShown = true;
    try { if (globalThis.localStorage?.getItem(SPACE_HINT_KEY)) return; globalThis.localStorage?.setItem(SPACE_HINT_KEY, "shown"); } catch {}
    const D = doc(); const anchor = D?.getElementById?.("status"); if (!anchor) return;
    const box = D.createElement("span"); box.className = "route-feel-hint"; box.setAttribute("role", "status");
    const close = () => { box.remove(); };
    const b = (text, fn, variant) => {
      const x = D.createElement("button");
      x.type = "button"; x.textContent = text; x.className = "ui-button"; x.dataset.size = "sm";
      if (variant) x.dataset.variant = variant;
      x.onclick = e => { e.stopPropagation(); fn(); };
      return x;
    };
    const hint = binding => AtriumShortcut.render(binding, {variant:"inline"});
    box.append(hint("Space"), " flips the corner. ", hint("Shift+Space"), " cycles the corner style. Use ", hint("Space"), " to cycle styles instead?",
      b("Use Space", () => { enableSpaceCycles(); close(); host()?.info?.("Space now cycles the corner style; Shift+Space flips the corner. Preferences › Routing changes it."); }, "primary"),
      b("Keep Altium keys", close));
    anchor.after(box);
    setTimeout(close, 12000);
  }
  function enableSpaceCycles() {
    const set = P => { try { P.set("routing.spaceCyclesCorner", true); } catch {} };
    if (globalThis.AtriumPrefs) set(AtriumPrefs);
    else globalThis.AtriumLazy?.need?.("AtriumPrefs").then(set, () => {});
  }

  // ---------------------------------------------------------------- paint
  // canvas.js calls this without a try: never let an overlay break the frame.
  function paint(g, opts, env) {
    g.save();
    try { paintAll(g, opts, env); } catch (e) { globalThis.console?.error?.(e); } finally { g.restore(); }
  }
  function paintAll(g, opts, env) {
    const t = clock(), motion = fadesOK(), TK = tokens(), scale = env.scale || 1, copper = env.copper || (() => "#c8a000");
    const routing = S.routing;
    const line = (pts, w) => { if (!pts?.length) return; g.beginPath(); g.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) g.lineTo(pts[k][0], pts[k][1]); g.lineWidth = w; g.stroke(); };
    g.save(); g.lineCap = "round"; g.lineJoin = "round";
    // Clearance boundaries (behind the head) and the halo, faded.
    if (S.bounds.a > 0 && S.bounds.last) {
      g.globalAlpha = .18 * S.bounds.a; g.strokeStyle = g.fillStyle = "#9a9a9a";
      for (const b of S.bounds.last) {
        if (b.points) { g.beginPath(); b.points.forEach(([x, y], k) => k ? g.lineTo(x, y) : g.moveTo(x, y)); g.closePath(); g.fill(); g.lineWidth = 2 * b.r; g.stroke(); }
        else line([b.a, b.b], 2 * b.r);
      }
    }
    if (S.halo.a > 0 && S.halo.last && routing) { g.globalAlpha = S.halo.a; g.strokeStyle = "rgba(255,255,255,.12)"; line(S.halo.last.points, S.halo.last.width); }
    // Gloss: the committed copper eases from the drawn path to the glossed one.
    if (S.gloss) {
      const k = easeOut((t - S.gloss.t0) / S.gloss.dur);
      g.globalAlpha = 1;
      for (const it of S.gloss.items) { g.strokeStyle = copper(it.layer || "Top"); line(k >= 1 || !it.P ? it.to : mixPts(it.P, k), it.width || .25); }
    }
    // Conflict: the head blends to red.
    if (S.conflict.a > 0 && S.conflict.heads && routing) { g.globalAlpha = .85 * S.conflict.a; g.strokeStyle = "#ff4d4d"; for (const h of S.conflict.heads) line(h.points, h.width || .25); }
    // Settle flash: a light, slightly wider stroke that fades over --motion-settle.
    S.flashes = S.flashes.filter(f => t - f.t0 < f.dur);
    for (const f of S.flashes) {
      const k = (t - f.t0) / f.dur; if (k < 0) continue;
      g.globalAlpha = .32 * (1 - k) * (1 - k); g.strokeStyle = "#ffffff"; line(f.points, (f.width || .25) + 2.5 / scale * (1 - k));
    }
    // Via: a quick drop (scale 1.5 → 1) and a ring that widens and fades.
    S.rings = S.rings.filter(r => t - r.t0 < r.dur);
    for (const r of S.rings) {
      const k = (t - r.t0) / r.dur, drop = Math.min(1, k * 2.2);
      if (drop < 1) { g.globalAlpha = .55 * (1 - drop); g.fillStyle = copper("Multi"); g.beginPath(); g.arc(r.x, r.y, r.d / 2 * (1.5 - .5 * easeOut(drop)), 0, Math.PI * 2); g.fill(); }
      g.globalAlpha = .5 * (1 - k); g.strokeStyle = "#ffffff"; g.lineWidth = 1.2 / scale;
      g.beginPath(); g.arc(r.x, r.y, r.d / 2 * (1 + 1.2 * easeOut(k)), 0, Math.PI * 2); g.stroke();
    }
    g.restore();
    if (S.hover) { paintSnap(g, env, t, motion); paintTip(g, env, t, TK); }
    if (!routing) return;
    paintSnap(g, env, t, motion);
    paintTip(g, env, t, TK);
  }
  function screenCtx(g, env) { const dpr = env.dpr || 1; g.save(); g.setTransform(dpr, 0, 0, dpr, 0, 0); }
  function paintSnap(g, env, t, motion) {
    const s = S.snap; if (!s.point || !env.worldToScreen || s.kind === "free") return;
    const [x, y] = env.worldToScreen(s.point), sel = env.system?.selection || "#ffffff";
    screenCtx(g, env);
    g.strokeStyle = sel; g.lineWidth = 1; g.globalAlpha = .7;
    g.beginPath();
    if (s.kind === "grid") { g.globalAlpha = .45; g.moveTo(x - 4, y); g.lineTo(x + 4, y); g.moveTo(x, y - 4); g.lineTo(x, y + 4); }
    else if (s.kind === "track-end" || s.kind === "track") { g.moveTo(x, y - 5); g.lineTo(x + 5, y); g.lineTo(x, y + 5); g.lineTo(x - 5, y); g.closePath(); }
    else if (s.kind === "via") { g.arc(x, y, 6, 0, Math.PI * 2); g.moveTo(x + 3, y); g.arc(x, y, 3, 0, Math.PI * 2); }
    else if (s.kind === "pad-edge") { g.rect(x - 4, y - 4, 8, 8); }
    else if (s.kind === "ray") {
      const [a] = s.ray || []; if (a) { const p = env.worldToScreen(a); g.setLineDash([2, 4]); g.globalAlpha = .35; g.moveTo(p[0], p[1]); g.lineTo(x, y); g.stroke(); g.setLineDash([]); g.beginPath(); g.globalAlpha = .7; }
      g.arc(x, y, 3.5, 0, Math.PI * 2);
    }
    else { g.arc(x, y, 5.5, 0, Math.PI * 2); g.moveTo(x + 1.5, y); g.arc(x, y, 1.5, 0, Math.PI * 2); }
    g.stroke();
    // No text at the head: the target's name is in the status-bar chip.
    g.restore();
  }
  // ---------------------------------------------------------------- the head tip
  // One compact tip near the head, never a second floating element: the corner glyph and name for a
  // second after a style or arc change, the snap target's name briefly when it changes, and Timing
  // Vision's numbers while the net has a length or delay target. It sits beside the head on the side
  // that covers neither the head, the target nor the copper being routed, and flips (eased) when that
  // side is taken or off the canvas. Full: fades and glides; Reduced: fades; Off: appears and goes.
  const LABEL_MS = 900;
  function headLabel() { const s = S.snap; return pref("routing.snapLabels") !== false && s.label && !/^(grid|free|ray)$/.test(s.kind) ? s.label : ""; }
  function tipRows(t, TK, fades) {
    const rows = [], gAge = t - S.glyph.t0, lAge = t - S.snap.t0, fade = fades ? TK.fade : 0;
    const alpha = (age, hold) => age < 0 ? 0 : age <= hold ? (fades && age < fade ? age / fade : 1) : fades ? Math.max(0, 1 - (age - hold) / fade) : 0;
    if (pref("routing.cornerGlyph") !== false && S.glyph.corner) {
      const a = alpha(gAge, TK.glyph);
      if (a > 0) { const arc = /arc$/.test(S.glyph.corner) ? arcRadius() : null; rows.push({glyph: S.glyph.corner, text: (CORNER_NAMES[S.glyph.corner] || S.glyph.corner) + (arc != null ? " R" + fmt(arc) : ""), a}); }
    }
    const lab = headLabel();
    if (lab) { const a = alpha(lAge, LABEL_MS); if (a > 0) rows.push({text: lab, a}); }
    if (S.timing && S.timingTarget) rows.push({text: S.timing, a: 1, state: S.timingState});
    // route-suggest: tip rows — the suggestion chip ("1/3 · 2 vias · 14.2 mm") and its reason (route-suggest.js).
    try { for (const r of globalThis.AtriumRouteSuggest?.tipRows?.() || []) rows.push(r); } catch { /* optional */ }
    return rows;
  }
  const TIP_STATE = {short: "#7fb2ff", ok: "#7fd18f", long: "#ff8a7a"};
  function paintTip(g, env, t, TK) {
    const head = S.routing ? S.head : S.hover ? S.snap.point : null;
    if (!head || !env.worldToScreen) { S.tip = null; return; }
    const fades = fadesOK(), rows = tipRows(t, TK, fades);
    if (!rows.length) { S.tip = null; return; }
    screenCtx(g, env);
    g.font = "500 10.5px system-ui, -apple-system, sans-serif"; g.textBaseline = "middle"; g.textAlign = "left";
    const RH = 16, PAD = 5, w = Math.ceil(Math.max(...rows.map(r => g.measureText(r.text).width + (r.glyph ? 22 : 0)))) + 2 * PAD, h = rows.length * RH + 4;
    const [hx, hy] = env.worldToScreen(head), dpr = env.dpr || 1, W = g.canvas.width / dpr, H = g.canvas.height / dpr;
    // Keep-out: the head end, the snap target and the head's copper (screen px).
    const keep = [[hx, hy, 10]];
    if (S.snap.point) { const q = env.worldToScreen(S.snap.point); keep.push([q[0], q[1], 14]); }
    const segs = [];
    for (const l of S.lastHead || []) { const half = (l.width || .25) * (env.scale || 1) / 2 + 4; const P = l.points.map(p => env.worldToScreen(p)); for (let k = 1; k < P.length; k++) segs.push([P[k - 1], P[k], half]); }
    const D = 14, spots = [[D, D], [D, -D - h], [-D - w, D], [-D - w, -D - h]];
    const clear = (/** @type {number[]} */ [ox, oy]) => {
      const x0 = hx + ox, y0 = hy + oy, x1 = x0 + w, y1 = y0 + h;
      if (x0 < 2 || y0 < 2 || x1 > W - 2 || y1 > H - 2) return false;
      for (const [cx, cy, r] of keep) if (cx > x0 - r && cx < x1 + r && cy > y0 - r && cy < y1 + r) return false;
      for (const [a, b, half] of segs) if (segRect(a, b, x0 - half, y0 - half, x1 + half, y1 + half)) return false;
      return true;
    };
    // Stay on the current side while it is clear (no flip-flopping), else the first clear side.
    let side = S.tip?.side ?? 0;
    if (!clear(spots[side])) { const k = spots.findIndex(clear); side = k >= 0 ? k : side; }
    const want = spots[side], motion = motionOK();
    let off = want;
    if (S.tip && motion) {
      // Glide to a new side over --motion-fade instead of jumping.
      const k = 1 - Math.exp(-Math.max(0, t - S.tip.t) / Math.max(1, TK.fade / 3));
      off = [S.tip.off[0] + (want[0] - S.tip.off[0]) * k, S.tip.off[1] + (want[1] - S.tip.off[1]) * k];
      if (Math.abs(off[0] - want[0]) > .5 || Math.abs(off[1] - want[1]) > .5) kick();
    }
    S.tip = {side, off, t};
    const x = hx + off[0], y = hy + off[1], a = Math.max(...rows.map(r => r.a));
    g.globalAlpha = .88 * a; g.fillStyle = "rgba(20,20,20,.9)";
    g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, 3); else g.rect(x, y, w, h); g.fill();
    rows.forEach((r, k) => {
      const ry = y + 2 + k * RH + RH / 2; let tx = x + PAD;
      g.globalAlpha = r.a;
      if (r.glyph) {
        const pop = motion ? 1 + .15 * (1 - easeOut((t - S.glyph.t0) / 120)) : 1;
        g.save(); g.strokeStyle = "#f2f2f2"; g.lineWidth = 1.5; g.lineCap = "round"; g.lineJoin = "round";
        g.translate(tx + 8, ry); g.scale(pop, pop); g.translate(-8, -6);
        try { g.stroke(new Path2D(GLYPH_PATH[r.glyph] || GLYPH_PATH["45"])); } catch {}
        g.restore(); tx += 22;
      }
      g.fillStyle = TIP_STATE[r.state] || "#e6e6e6"; g.fillText(r.text, tx, ry);
    });
    g.restore();
  }
  // Does segment a-b touch the rectangle [x0,y0]-[x1,y1]? (Liang-Barsky clip)
  function segRect(a, b, x0, y0, x1, y1) {
    let t0 = 0, t1 = 1; const dx = b[0] - a[0], dy = b[1] - a[1];
    for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dy, a[1] - y0], [dy, y1 - a[1]]]) {
      if (p === 0) { if (q < 0) return false; continue; }
      const r = q / p; if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; } else { if (r < t0) return false; if (r < t1) t1 = r; }
    }
    return true;
  }

  // Tab while routing focuses the width field in Properties (Altium). Enter or Escape there goes back
  // to the route (the blur commits the value); without this the keys stayed in the field.
  try {
    globalThis.document?.addEventListener?.("keydown", e => {
      const H = globalThis.AtriumNavHost;
      if ((e.key !== "Escape" && e.key !== "Enter") || !(/** @type {any} */ (e.target))?.closest?.("#inspector") || !H?.liveRoute?.()) return;
      e.preventDefault(); e.stopPropagation(); H.canvas?.()?.focus();
    }, true);
  } catch { /* no DOM */ }

  // Post-route commands share the same first-use gate as the interactive router.
  function trackOptions(host) {
    return {ids: host.selection(), project: host.project(), revision: host.revision()};
  }

  function retraceTracks(host, ui, text) {
    const input = text.toLowerCase();
    const mode = ["min", "max", "preferred", "current"].find(value => input.startsWith(value));
    const gap = mode ? undefined : Atrium.units.parse(text, host.units());
    if (!mode && !(gap > 0)) {host.info("Enter min, max, preferred, current or a gap."); return;}
    try {
      const doc = host.doc();
      const plan = AtriumDiffPair.retrace(doc, host.defs(), {...trackOptions(host), gapMode: mode || "custom", gap, transition: ui.transition()});
      if (!plan.ok) {host.info("Retrace refused: " + (plan.failed[0]?.reason || "clearance")); return;}
      if (plan.modify.length || plan.add.length) host.edit(() => AtriumRouter.apply(doc, plan));
      host.info(plan.gapModeName + (plan.gap != null ? " " + ui.len(plan.gap) : "") + " · " + plan.runs + " coupled run" + (plan.runs === 1 ? "" : "s"));
    } catch (error) {host.info(error.message);}
  }

  function editTracks(action, host, ui) {
    const retracing = action === "diffpair-retrace", smoothing = action === "diffpair-gloss", doc = host.doc();
    if (doc.kind !== "pcb") {
      host.info(retracing ? "Select tracks of a differential pair to retrace." : smoothing ? "Select tracks of a differential pair." : "Select the tracks to add tabs to.");
      return;
    }
    const selected = new Set(host.selection());
    if (!selected.size || !doc.items.some(item => item.kind === "track" && selected.has(item.id))) {
      // A track can sit inside a footprint's courtyard. Reuse the editor's track-only hit test.
      const label = retracing ? "Click a track of the differential pair to retrace." : smoothing ? "Click a track of the differential pair to smooth." : "Click the track to add tabs to.";
      host.pickPoint(label).then(point => {
        if (!point || doc !== host.doc()) return;
        const track = ui.trackHit(host.pointer() || point);
        if (!track) {host.info("No track there. Click on a track."); return;}
        host.select([track.id], track.id);
        host.act(action);
      });
      return;
    }
    if (retracing) {
      ui.promptValue("Retrace gap: min, max, preferred, current, or a gap such as 0.12mm", "preferred", text => retraceTracks(host, ui, text));
      return;
    }
    try {
      if (smoothing) {
        const transition = ui.transition() === "rounded" ? "rounded" : "mitered";
        const plan = AtriumDiffPair.gloss(doc, host.defs(), {...trackOptions(host), transition});
        const count = plan.modify.length + plan.add.length;
        if (count) host.edit(() => AtriumRouter.apply(doc, plan));
        host.info(count ? "Smoothed " + count + " width or gap step" + (count === 1 ? "" : "s") : "No width or gap steps to smooth.");
      } else {
        const shape = action === "route-tabs" ? "T" : "trapezoid";
        const plan = AtriumRouter.tabs(doc, host.defs(), {...trackOptions(host), shape, side: "inner"});
        if (plan.add.length) host.edit(() => AtriumRouter.apply(doc, plan));
        host.info(plan.tabs + " " + shape + " tab" + (plan.tabs === 1 ? "" : "s") + " added" +
          (plan.skipped.length ? " · " + plan.skipped.length + " positions skipped" : "") +
          (plan.uncoupledAdded > 0 ? " · +" + ui.len(plan.uncoupledAdded) + " uncoupled" : ""));
      }
    } catch (error) {host.info(error.message);}
  }

  // For tests and probes.
  function debug() { return {anims: S.anims.size, flashes: S.flashes.length, rings: S.rings.length, gloss: !!S.gloss, halo: S.halo.a, conflict: S.conflict.a, snap: {...S.snap}, glyph: {...S.glyph}, routing: S.routing, tip: S.tip && {...S.tip}}; }

  return Object.freeze({snap, frame, paint, committed, spaceAction, status, start, routeOptions, editTracks, arcKey, arcRadius, timing, motionOK, fadesOK, level, tokens, debug, pref, pairOffer: offer, declarePair,
    interpolate: (from, to, k) => mixPts(pairs(from, to), easeOut(k)), CORNER_NAMES, GLYPH_PATH});
})();
