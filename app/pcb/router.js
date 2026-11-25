"use strict";
if (!globalThis.AtriumLandContours && typeof require === "function") require("./land-contours.js");
if (!globalThis.AtriumResolvedLand && typeof require === "function") require("./pcb-appearance.js");

if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("./resolved-geometry-curves.js");
// Interactive and headless copper router. Pure model code: no DOM, no globals
// other than AtriumRouter. Coordinates are millimetres, as in the model.
//
// Obstacles live in a "world": flat typed arrays of convex features (a capsule
// = segment + radius, or a convex polygon + radius) indexed by a uniform grid
// in CSR form. Routing walks octilinear k-DOP hulls of the obstacles (PNS
// style), shoves other-net tracks and vias with a bounded budget, and smooths
// the result with exact clearance checks. Arcs are emitted as polylines.
globalThis.AtriumRouter = (() => {
  const PAD = 2e-4;   // walk this far (mm) outside the exact clearance boundary
  const TOL = 1e-7;   // a gap this much short of the limit is a violation
  const now = typeof performance !== "undefined" && performance.now ? () => performance.now()
    : typeof preciseTime === "function" ? () => preciseTime() * 1000 : () => Date.now();
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const newId = () => (globalThis.Atrium?.id ? globalThis.Atrium.id() : "r" + Math.random().toString(36).slice(2));
  const MODES = ["walkaround", "push", "hug", "stop", "ignore"];
  const MODE_NAMES = {walkaround:"Walkaround obstacles", push:"Push obstacles", hug:"Hug and push obstacles", stop:"Stop at first obstacle", ignore:"Ignore obstacles"};
  const CORNERS = ["45", "45arc", "90", "90arc", "any"];
  const CORNER_NAMES = {"45":"45°", "45arc":"45° with arc", "90":"90°", "90arc":"90° with arc", any:"Any angle"};
  // Net ids at or above zero are named nets. Special ids are offset by NET0 in clearance tables.
  const HOLE = -4, OUTLINE = -3, KEEPOUT = -2, NONET = -1, NET0 = 4;
  const SIDE_SLACK = 1;     // walkaround side hysteresis, in (track width + clearance)

  // ---------------------------------------------------------------- layers
  const {index: layerIndex, copperInterval, padPlanes} = globalThis.AtriumPCBAppearance;
  const layerName = i => i === 0 ? "Top" : i === 127 ? "Bottom" : "Inner " + i;
  const layerDenial = layer => "Layer " + layer + " is not allowed for routing.";
  function copperLayers(board, defs) {
    const S = globalThis.AtriumStackup;
    if (S && typeof S.copperLayers === "function") {
      try {
        const list = (S.copperLayers(board) || []).map(l => typeof l === "string" ? l : l && (l.name || l.layer)).filter(n => layerIndex(n) >= 0);
        if (list.length) return list;
      } catch { /* fall back to the layers in use */ }
    }
    const names = new Set(["Top", "Bottom"]);
    const note = n => { if (layerIndex(n) >= 0) names.add(n); };
    for (const i of board.items || []) {
      note(i.layer); note(i.fromLayer); note(i.toLayer);
      if (i.kind === "part") for (const p of defs?.get?.(i.def)?.footprint?.pads || []) note(p.layer);
    }
    return [...names].sort((a, b) => layerIndex(a) - layerIndex(b));
  }
  // The smallest drill pair spanning both layers, or a through via.
  function viaSpan(board, from, to) {
    // hdi-route: with an HDI build-up (doc.hdi) viastack.js picks the span or a stacked chain (parts) and microvia fields (extra).
    if (board?.hdi) { try { const h = globalThis.AtriumViaStack?.hdi?.routeSpan(board, from, to); if (h) return h; } catch { /* keep the drill-pair choice */ } }
    const [lo, hi] = copperInterval(from, to);
    const S = globalThis.AtriumStackup;
    if (S && typeof S.drillPairs === "function" && !(lo === 0 && hi === 127)) {
      try {
        let best = null;
        for (const p of S.drillPairs(board) || []) {
          const [l, h] = copperInterval(p.from || p.fromLayer || p[0], p.to || p.toLayer || p[1]);
          if (l < 0) continue;
          if (l <= lo && h >= hi && (!best || h - l < best[1] - best[0])) best = [l, h];
        }
        if (best && !(best[0] === 0 && best[1] === 127)) return {lo:best[0], hi:best[1], fromLayer:layerName(best[0]), toLayer:layerName(best[1])};
      } catch { /* through via */ }
    }
    return {lo:0, hi:127};
  }

  function viaFitsSpan(rules, net, style, at, span) {
    return (span.parts || [span]).every(part => {
      const v = part.extra ? {...style,...part.extra} : style;
      const interval = copperInterval(part.fromLayer, part.toLayer);
      const layers = interval[0] >= 0 ? interval : [span.lo,span.hi];
      return rules.via(net,v,at,layers).legal;
    });
  }

  // Board vias for one routed via record: one per stacked part (hdi-route), with microvia fields.
  function viaItems(v, idOf, net) {
    return (v.parts || [v]).map(p => {
      const via = {id:idOf(), kind:"via", x:round6(v.x), y:round6(v.y), diameter:v.diameter, drill:v.drill, layer:"Multi", net};
      if (p.fromLayer) { via.fromLayer = p.fromLayer; via.toLayer = p.toLayer; }
      if (p.extra) Object.assign(via, p.extra);
      return via;
    });
  }

  // ---------------------------------------------------------------- rules
  // Feature-detects AtriumRules.query(board, type, {net, net2, layer, pairName}),
  // then the version-1 board.rules file, then built-in defaults.
  function pick(v, keys) {
    if (finite(v)) return v;
    if (v && typeof v === "object") {
      for (const k of keys) {
        const x = v[k];
        if (finite(x)) return x;
        if (x && typeof x === "object" && finite(x.value)) return x.value;
      }
    }
    return undefined;
  }
  const ruleCache = new WeakMap();
  function rulesFor(board, user = {}, project = null, defs) {
    if (!user || typeof user !== "object") user = {};
    const custom = Object.keys(user).length > 0, versions = globalThis.AtriumUndoStore?.documentVersions?.(board), stored = (globalThis.AtriumRules?.stored ? AtriumRules.stored(board, project) : board?.rules) || null;
    const stackSig = globalThis.AtriumStackup?.signature ? AtriumStackup.signature(board) : "";
    if (!custom && versions) {
      const c = ruleCache.get(board);
      if (c && c.rules === stored && c.stackSig === stackSig && c.project === project && c.defs === defs &&
          c.versions.seq === versions.seq && c.versions.outer === versions.outer &&
          c.versions.library === versions.library && c.versions.project === versions.project) return c.api;
    }
    const R = globalThis.AtriumRules;
    // A resolver compiles the rule set once; query() would recompile per call.
    let q = null;
    try {
      if (R && typeof R.resolver === "function") q = R.resolver(board, {project,defs});
      else if (R && typeof R.query === "function") q = (t, ctx) => R.query(board, t, ctx);
    } catch { q = null; }
    const known = t => !R || !R.types || Object.hasOwn(R.types, t);
    const legacy = stored && stored.defaults ? stored : null;
    function ask(types, ctx) {
      if (!q) return undefined;
      for (const t of types) {
        if (!known(t)) continue;
        let v; try { v = q(t, ctx); } catch { v = undefined; }
        if (v != null) return v;
      }
      return undefined;
    }
    function legacyValue(key, net) {
      if (!legacy) return undefined;
      const o = net && legacy.nets && Object.hasOwn(legacy.nets, net) ? legacy.nets[net] : null;
      return finite(o?.[key]) ? o[key] : finite(legacy.defaults?.[key]) ? legacy.defaults[key] : undefined;
    }
    const cache = new Map();
    function clearance(a, b, layer) {
      if (typeof user.clearance === "function") return user.clearance(a, b, layer);
      if (finite(user.clearance)) return user.clearance;
      const k = a + "\u0001" + b + "\u0001" + (layer || "");
      let v = cache.get(k); if (v !== undefined) return v;
      v = q?.routingClearance ? q.routingClearance(a,b,layer)
        : pick(ask(["clearance"], {net:a, net2:b, layer}), ["routeGap", "value", "min", "minimum", "clearance", "gap"]);
      // A native rule list owns its enable state. Its serialized summary can contain disabled rules.
      if (v === undefined && !Array.isArray(stored?.list)) {
        const x = legacyValue("clearance", a), y = legacyValue("clearance", b);
        if (x !== undefined || y !== undefined) v = Math.max(x ?? 0, y ?? 0);
      }
      if (!finite(v) || v < 0) v = 0.2;
      cache.set(k, v); return v;
    }
    function trackRule(types, net, layer, at) {
      const item = {kind:"track", net, layer};
      return ask(types, R?.kit?.copperSubject?.(item, null, "track", at) ?? {...item, ck:"track", at});
    }
    function allowsLayer(net, layer, at) {
      return !trackRule(["routingLayers"], net, layer, at)?.excluded?.includes(layer);
    }
    function width(net, layer, at) {
      const w = user.width;
      if (finite(w)) return {min:w, preferred:w, max:w};
      const r = trackRule(["width", "trackWidth", "routingWidth"], net, layer, at);
      let min = pick(r, ["min", "minimum", "minWidth"]), pref = pick(r, ["preferred", "pref", "preferredWidth", "value", "width"]), max = pick(r, ["max", "maximum", "maxWidth"]);
      const ruled = min !== undefined;
      if (min === undefined) min = legacyValue("trackWidth", net);
      if (pref === undefined) pref = Math.max(min ?? 0, globalThis.AtriumPref?.get?.("pcb.trackWidth", 0.25) ?? 0.25);
      if (min === undefined) min = Math.min(pref, 0.1);
      if (max === undefined) max = Math.max(pref, 10);
      // ruled: the minimum comes from a Width rule (neck-down may go down to it). neck: the one neck-down length
      // per end (rules.js neckLength: the rule's, else its impedance profile's, else 2.5 mm), as the impedance checks use.
      const own = r && typeof r === "object" ? pick(r, ["neckLength", "neckMaxLength"]) : undefined;
      const neck = R?.neckLength ? R.neckLength(board, r && typeof r === "object" ? {...r, neckLength:own} : null) : finite(own) && own > 0 ? own : 2.5;
      return {min, preferred:Math.min(Math.max(pref, min), max), max, ruled, neck};
    }
    function via(nets, requested, at, span) {
      const explicit = requested || user.via;
      const limits = q?.viaLimits ? (Array.isArray(nets)?nets:[nets]).map(net=>q.viaLimits(net,explicit,at,span)) : [];
      const drill = globalThis.AtriumPref?.get?.("pcb.viaDrill",.3) ?? .3;
      const diameter = globalThis.AtriumPref?.get?.("pcb.viaDiameter",.6) ?? .6;
      const fallback={diameter,drill,landGap:Math.max(.05,diameter-drill)};
      return R?.sizeVia ? R.sizeVia(limits,fallback,explicit) : globalThis.Atrium.viaSize([],explicit??fallback,!!explicit);
    }
    function diffPair(p, n, pairName, layer, at) {
      const r = ask(["diffPairsRouting", "diffPair", "differentialPair"], {net:p, net2:n, pairName, layer, at});
      const w = width(p, layer, at).preferred;
      let gap = pick(r, ["gapPreferred", "gap", "preferredGap"]) ?? pick(r, ["gapMin"]), wid = pick(r, ["widthPreferred", "width", "preferredWidth"]) ?? pick(r, ["widthMin"]);
      if (finite(user.gap)) gap = user.gap;
      if (finite(user.width)) wid = user.width;
      const ww = width(p, layer, at);
      const g = gap ?? Math.max(clearance(p, n, layer), 0.15), wd = wid ?? w;
      // Minimums (the auto-shrink floor) come from the Diff Pairs Routing rule; with an impedance profile, auto-shrink
      // stops at the profile's warn window (stackup.js warnMinWidth / warnMinGap), inside the tolerance DRC flags.
      const rMinW = pick(r, ["widthMin", "minWidth"]), rMinG = pick(r, ["gapMin", "minGap"]);
      let wFloor = 0, gFloor = 0;
      if (r && typeof r === "object" && r.impedanceProfile && layer) {
        try { const v = globalThis.AtriumStackup?.profileValues?.(board, r.impedanceProfile, layer); if (v?.warnMinWidth > 0) wFloor = v.warnMinWidth; if (v?.warnMinGap > 0) gFloor = v.warnMinGap; } catch { /* no stack-up */ }
      }
      return {gap:g, width:wd,
        minGap:finite(user.gap) ? Math.min(g, rMinG ?? g) : Math.min(g, Math.max(rMinG ?? g, gFloor)), maxGap:pick(r, ["gapMax", "maxGap"]) ?? gap ?? Infinity,
        minWidth:finite(user.width) ? Math.min(wd, rMinW ?? wd) : Math.min(wd, Math.max(rMinW ?? wd, ww.min, wFloor)), maxWidth:pick(r, ["widthMax", "maxWidth"]) ?? Math.max(ww.max, wd),
        maxUncoupled:pick(r, ["maxUncoupled", "maxUncoupledLength", "maxUncoupledLen"]) ?? Infinity};
    }
    function corners(net) {
      const r = ask(["routingCorners", "corners", "cornerStyle"], {net});
      const style = r && typeof r === "object" ? String(r.style || "") : typeof r === "string" ? r : "";
      const map = {"45":"45", "45arc":"45arc", "rounded":"45arc", "arc":"45arc", "90":"90", "90arc":"90arc", "any":"any", "45-degrees":"45", "90-degrees":"90"};
      const setback = pick(r, ["setbackMin", "setback", "radius", "minSetback"]), mapped = map[style.toLowerCase()] || null;
      // The setback sizes arcs only when the rule asks for rounded corners.
      return {style:mapped, radius:finite(user.arcRadius) ? user.arcRadius : hasArc(mapped || "") ? setback : undefined};
    }
    function edgeClearance(net) {
      if (finite(user.edgeClearance)) return user.edgeClearance;
      const v = pick(ask(["boardOutlineClearance", "edgeClearance", "outlineClearance"], {net}), ["value", "min", "clearance", "gap"]);
      return v >= 0 ? v : clearance(net, "", "");
    }
    // Upper bound of every clearance in the rule set (lets contexts resolve per-net values lazily).
    function maxClearance() {
      if (typeof user.clearance === "function") return undefined;
      if (finite(user.clearance)) return user.clearance;
      if (finite(q?.clearanceMax)) return Math.max(q.clearanceMax, .2);
      if (!stored) return 0.2;
      let m = 0, any = false;
      if (Array.isArray(stored.list)) for (const r of stored.list) if (r && r.type === "clearance" && r.enabled !== false && finite(r.gap)) { m = Math.max(m, r.gap); any = true; if (r.objects && typeof r.objects === "object") for (const v of Object.values(r.objects)) if (finite(v)) m = Math.max(m, v); }
      if (stored.version === 2 && !any) return 0.2;
      if (legacy) { if (finite(legacy.defaults?.clearance)) { m = Math.max(m, legacy.defaults.clearance); any = true; } for (const n of Object.values(legacy.nets || {})) if (finite(n?.clearance)) m = Math.max(m, n.clearance); }
      return any ? m : undefined;
    }
    const physical = !finite(user.clearance) && typeof user.clearance !== "function" && q?.typedClearance && q.clearanceReady !== false ? q.clearanceBetween : null;
    const api = {physical, spatial:!!(physical && q.spatialClearance), holes:!!(physical && q.holeClearance), clearance, width, allowsLayer, via, diffPair, corners, edgeClearance, maxClearance, ask};
    if (!custom && versions && board && q && q.clearanceReady !== false) ruleCache.set(board, {rules:stored, stackSig, project, defs, versions, api});
    return api;
  }

  // ---------------------------------------------------------------- geometry
  const {inRingAt, orientAt: orient, pointSegmentDistanceSquared: pt2, segmentDistanceSquared: segSeg2} = globalThis.AtriumGeometry;
  function inConvex(pv, o, m, x, y) {
    let pos = false, neg = false;
    for (let i = 0; i < m; i++) {
      const j = i + 1 === m ? 0 : i + 1;
      const s = orient(pv[o + 2 * i], pv[o + 2 * i + 1], pv[o + 2 * j], pv[o + 2 * j + 1], x, y);
      if (s > 1e-12) pos = true; else if (s < -1e-12) neg = true;
      if (pos && neg) return false;
    }
    return true;
  }
  const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  function pathLength(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
  // Drops repeated and collinear vertices (including back-tracking spikes).
  function simplify(pts) {
    const out = [];
    for (const p of pts) {
      if (out.length && Math.abs(p[0] - out[out.length - 1][0]) < 1e-9 && Math.abs(p[1] - out[out.length - 1][1]) < 1e-9) continue;
      while (out.length >= 2) {
        const a = out[out.length - 2], b = out[out.length - 1];
        const ux = b[0] - a[0], uy = b[1] - a[1], vx = p[0] - b[0], vy = p[1] - b[1];
        const c = ux * vy - uy * vx, s = Math.hypot(ux, uy) * Math.hypot(vx, vy);
        if (Math.abs(c) <= 1e-9 * s + 1e-14) out.pop(); else break;
      }
      out.push(p);
    }
    if (out.length === 1 && pts.length > 1) out.push(pts[pts.length - 1]);
    return out;
  }
  // Cuts out self-intersection loops; the result follows the original geometry. Each pass cuts the
  // loop of the first segment that crosses a later one, at the last segment it crosses. Candidate
  // pairs come from a sweep over the segments' x extents, so a long path costs O(n log n + k).
  function unloop(pts) {
    for (let guard = 0; guard < 32; guard++) {
      const n = pts.length - 1;
      if (n < 3) break;
      const X0 = new Float64Array(n), X1 = new Float64Array(n), Y0 = new Float64Array(n), Y1 = new Float64Array(n), ord = new Array(n);
      for (let s = 0; s < n; s++) {
        const a = pts[s], b = pts[s + 1];
        X0[s] = Math.min(a[0], b[0]) - 1e-9; X1[s] = Math.max(a[0], b[0]) + 1e-9; Y0[s] = Math.min(a[1], b[1]) - 1e-9; Y1[s] = Math.max(a[1], b[1]) + 1e-9; ord[s] = s;
      }
      ord.sort((p, q) => X0[p] - X0[q]);
      let bi = -1, bj = -1, bt = 0;
      for (let m = 0; m < n; m++) {
        const s = ord[m];
        for (let k = m + 1; k < n; k++) {
          const r = ord[k];
          if (X0[r] > X1[s]) break;
          if (Y1[r] < Y0[s] || Y0[r] > Y1[s]) continue;
          const i = s < r ? s : r, j = s < r ? r : s;
          if (j < i + 2 || bi >= 0 && (i > bi || i === bi && j <= bj)) continue;
          const a = pts[i], b = pts[i + 1], c = pts[j], d = pts[j + 1], rx = b[0] - a[0], ry = b[1] - a[1], sx = d[0] - c[0], sy = d[1] - c[1], den = rx * sy - ry * sx;
          if (Math.abs(den) < 1e-14) continue;
          const wx = c[0] - a[0], wy = c[1] - a[1], t = (wx * sy - wy * sx) / den, u = (wx * ry - wy * rx) / den;
          if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) continue;
          bi = i; bj = j; bt = t;
        }
      }
      if (bi < 0) break;
      const a = pts[bi], b = pts[bi + 1];
      pts = [...pts.slice(0, bi + 1), [a[0] + (b[0] - a[0]) * bt, a[1] + (b[1] - a[1]) * bt], ...pts.slice(bj + 1)];
    }
    return simplify(pts);
  }
  // True when a segment in [lo, hi) crosses (or touches) a non-adjacent segment: only then can a
  // detour spliced into a loop-free path have made a loop.
  function crossesNew(pts, lo, hi) {
    const n = pts.length - 1; hi = Math.min(hi, n);
    for (let s = lo; s < hi; s++) {
      const a = pts[s], b = pts[s + 1], xa = Math.min(a[0], b[0]) - 1e-9, xb = Math.max(a[0], b[0]) + 1e-9, ya = Math.min(a[1], b[1]) - 1e-9, yb = Math.max(a[1], b[1]) + 1e-9;
      for (let r = 0; r < n; r++) {
        if (r >= s - 1 && r <= s + 1) continue;
        const c = pts[r], d = pts[r + 1];
        if (Math.max(c[0], d[0]) < xa || Math.min(c[0], d[0]) > xb || Math.max(c[1], d[1]) < ya || Math.min(c[1], d[1]) > yb) continue;
        if (segSeg2(a[0], a[1], b[0], b[1], c[0], c[1], d[0], d[1]) < 1e-18) return true;
      }
    }
    return false;
  }
  const baseCorner = c => c === "90" || c === "90arc" ? "90" : c === "any" ? "any" : "45";
  const hasArc = c => c === "45arc" || c === "90arc";
  // Two-segment connection in the corner style; `bend` swaps which leg comes first.
  function connector(a, b, base, bend) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    if (base === "any" || (Math.abs(dx) < 1e-12 && Math.abs(dy) < 1e-12)) return [a, b];
    let c;
    if (base === "90") c = bend ? [a[0], b[1]] : [b[0], a[1]];
    else {
      const d = Math.min(Math.abs(dx), Math.abs(dy)), sx = Math.sign(dx), sy = Math.sign(dy);
      c = bend ? [b[0] - sx * d, b[1] - sy * d] : [a[0] + sx * d, a[1] + sy * d];
    }
    return simplify([a, c, b]);
  }
  // Rounds every interior corner with radius r (limited by the segment lengths).
  // `ok(points)` may veto an arc, which is then retried at half radius.
  function fillet(pts, R, ok, tol = 0.002) {
    if (!(R > 0) || pts.length < 3) return pts;
    const {project} = AtriumGeometryCurves, limits = {legacyRadians: true, maxStep: 180};
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const P = pts[i], prev = out[out.length - 1], next = pts[i + 1];
      const lin = dist(prev, P), lout = dist(P, next);
      if (lin < 1e-9 || lout < 1e-9) { out.push(P); continue; }
      const ux = (P[0] - prev[0]) / lin, uy = (P[1] - prev[1]) / lin, vx = (next[0] - P[0]) / lout, vy = (next[1] - P[1]) / lout;
      const theta = Math.acos(Math.max(-1, Math.min(1, ux * vx + uy * vy)));
      if (theta < 1e-6 || theta > Math.PI - 1e-6) { out.push(P); continue; }
      const side = ux * vy - uy * vx > 0 ? 1 : -1, tanh = Math.tan(theta / 2);
      const maxIn = i === 1 ? lin : lin / 2, maxOut = i + 1 === pts.length - 1 ? lout : lout / 2;
      let r = R, arc = null;
      for (let attempt = 0; attempt < 4 && r > 1e-3; attempt++, r /= 2) {
        let sb = r * tanh, rr = r;
        if (sb > Math.min(maxIn, maxOut)) { sb = Math.min(maxIn, maxOut); rr = sb / tanh; }
        if (rr < 1e-3) break;
        const t1 = [P[0] - ux * sb, P[1] - uy * sb], t2 = [P[0] + vx * sb, P[1] + vy * sb];
        const nx = side > 0 ? -uy : uy, ny = side > 0 ? ux : -ux, cx = t1[0] + nx * rr, cy = t1[1] + ny * rr;
        const sx = t1[0] - cx, sy = t1[1] - cy;
        const pts2 = project([{kind: "arc", center: [cx, cy], radius: rr, start: 0, sweep: side * theta,
          cosineAxis: [sx, sy], sineAxis: [-sy, sx]}], tol, limits);
        pts2[0] = t1;
        pts2[pts2.length - 1] = t2;
        if (!ok || ok([prev, ...pts2, next])) { arc = pts2; break; }
      }
      if (arc) out.push(...arc); else out.push(P);
    }
    out.push(pts[pts.length - 1]);
    return simplify(out);
  }

  // ---------------------------------------------------------------- world
  const DIRS = {};
  for (const k of [4, 8, 16, 32]) {
    const c = new Float64Array(k), s = new Float64Array(k);
    for (let i = 0; i < k; i++) { c[i] = Math.cos(2 * Math.PI * i / k); s[i] = Math.sin(2 * Math.PI * i / k); }
    DIRS[k] = {c, s, k};
  }
  function convex(pts) {
    let pos = false, neg = false;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], c = pts[(i + 2) % pts.length];
      const s = orient(a[0], a[1], b[0], b[1], c[0], c[1]);
      if (s > 1e-12) pos = true; else if (s < -1e-12) neg = true;
    }
    return !(pos && neg);
  }

  function createWorld() {
    const W = {cap:0, n:0, nBuilt:0, nPersist:0, pcap:0, pn:0, owners:[], ownerById:new Map(), itemOwners:new Map(), retired:0, netIds:new Map(), netNames:[],
      stampV:0, qb:new Int32Array(1024), rb:new Int32Array(768), extra:new Map(), maxR:0, ostamp:new Uint32Array(64), ostampV:0};
    const F64 = ["ax", "ay", "by", "bx", "r", "x0", "y0", "x1", "y1"], I32 = ["net", "own", "poff", "plen"], U8 = ["kind", "lo", "hi", "dead"];
    function alloc(cap) {
      const copy = (k, T) => { const a = new T(cap); if (W[k]) a.set(W[k]); W[k] = a; };
      for (const k of F64) copy(k, Float64Array);
      for (const k of I32) copy(k, Int32Array);
      for (const k of U8) copy(k, Uint8Array);
      copy("stamp", Uint32Array);
      W.cap = cap;
    }
    alloc(1024); W.pv = new Float64Array(4096); W.pcap = 4096;
    W.grow = () => alloc(W.cap * 2);
    // Releases unused capacity after a build, keeping room for transient shoves.
    W.trim = () => {
      const cap = W.n + 1024;
      if (cap >= W.cap) return;
      const cut = (k, T) => { const a = new T(cap); a.set(W[k].subarray(0, W.n)); W[k] = a; };
      for (const k of F64) cut(k, Float64Array);
      for (const k of I32) cut(k, Int32Array);
      for (const k of U8) cut(k, Uint8Array);
      cut("stamp", Uint32Array); W.cap = cap;
      if (W.pcap > W.pn + 4096) { const a = new Float64Array(W.pn + 4096); a.set(W.pv.subarray(0, W.pn)); W.pv = a; W.pcap = W.pn + 4096; }
    };
    W.bytes = () => W.cap * (9 * 8 + 4 * 4 + 4 + 4) + W.pcap * 8 + (W.grid ? W.grid.start.byteLength + W.grid.refs.byteLength : 0);
    W.nid = name => {
      if (!name) return NONET;
      let v = W.netIds.get(name);
      if (v === undefined) { v = W.netNames.length; W.netIds.set(name, v); W.netNames.push(name); }
      return v;
    };
    W.netName = id => id >= 0 ? W.netNames[id] : "";
    return W;
  }
  function featureBox(W, f) {
    let x0, y0, x1, y1;
    if (W.kind[f] === 0) { x0 = Math.min(W.ax[f], W.bx[f]); x1 = Math.max(W.ax[f], W.bx[f]); y0 = Math.min(W.ay[f], W.by[f]); y1 = Math.max(W.ay[f], W.by[f]); }
    else {
      x0 = y0 = Infinity; x1 = y1 = -Infinity;
      for (let i = 0, o = W.poff[f]; i < W.plen[f]; i++) { const x = W.pv[o + 2 * i], y = W.pv[o + 2 * i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const r = W.r[f]; W.x0[f] = x0 - r; W.y0[f] = y0 - r; W.x1[f] = x1 + r; W.y1[f] = y1 + r;
    if (r > W.maxR) W.maxR = r;
  }
  function addCapsule(W, o, ax, ay, bx, by, r, lo, hi, net) {
    if (W.n >= W.cap) W.grow();
    const f = W.n++;
    W.kind[f] = 0; W.ax[f] = ax; W.ay[f] = ay; W.bx[f] = bx; W.by[f] = by; W.r[f] = r; W.lo[f] = lo; W.hi[f] = hi; W.net[f] = net; W.own[f] = o; W.dead[f] = 0; W.stamp[f] = 0;
    featureBox(W, f); return f;
  }
  function addPolygon(W, o, pts, r, lo, hi, net) {
    if (W.n >= W.cap) W.grow();
    while (W.pn + pts.length * 2 > W.pcap) { const a = new Float64Array(W.pcap * 2); a.set(W.pv); W.pv = a; W.pcap *= 2; }
    const f = W.n++, off = W.pn;
    let cx = 0, cy = 0;
    for (const p of pts) { W.pv[W.pn++] = p[0]; W.pv[W.pn++] = p[1]; cx += p[0]; cy += p[1]; }
    W.kind[f] = 1; W.poff[f] = off; W.plen[f] = pts.length; W.ax[f] = W.bx[f] = cx / pts.length; W.ay[f] = W.by[f] = cy / pts.length;
    W.r[f] = r; W.lo[f] = lo; W.hi[f] = hi; W.net[f] = net; W.own[f] = o; W.dead[f] = 0; W.stamp[f] = 0;
    featureBox(W, f); return f;
  }
  function addViaAt(W, o, x, y, diameter, lo, hi, net) {
    const rec = W.owners[o];
    if (rec.viaLands) {
      for (const land of rec.viaLands) {
        const {core, r, lo, hi} = land;
        if (core.length <= 2) {
          const a = core[0], b = core.at(-1);
          addCapsule(W, o, x + a[0], y + a[1], x + b[0], y + b[1], r, lo, hi, net);
        } else addPolygon(W, o, core.map(p => [x + p[0], y + p[1]]), r, lo, hi, net);
      }
    } else addCapsule(W, o, x, y, x, y, diameter / 2, lo, hi, net);
    if (W.holes && rec.item.drill > 0) addCapsule(W, o, x, y, x, y, rec.item.drill / 2, lo, hi, HOLE);
  }
  // Adds the copper (or keep-out) features for one model item. Returns the owner index.
  function addItem(W, it, parent, slot) {
    const o = W.owners.length;
    const rec = {item:it, parent, slot, kind:it.kind, first:W.n, count:0, movable:false, net:NONET, id:parent ? parent.id : it.id};
    W.owners.push(rec);
    const finish = () => { rec.count = W.n - rec.first; if (!rec.count) { W.owners.pop(); return -1; } if (!parent && it.id != null) W.ownerById.set(it.id, o); return o; };
    const netName = parent && it.kind === "pad" && parent.pinNets && Object.hasOwn(parent.pinNets, it.number) ? parent.pinNets[it.number] : it.net || "";
    if (it.kind === "track" || it.kind === "graphic" || it.kind === "path") {
      const layer = it.layer, li = layerIndex(layer), all = layer === "Keepout", keep = all || it.keepout === true && li >= 0;
      if (it.cutout || li < 0 && !keep) return finish();
      if (keep && it.keepoutRestrictions != null && it.keepoutRestrictions !== 31) W.restrictedKeepouts = true;
      if (!Array.isArray(it.points) || it.points.length < 1) return finish();
      const lo = all ? 0 : li, hi = all ? 127 : li, net = keep ? KEEPOUT : W.nid(netName), r = Math.max(0, (it.width || 0) / 2);
      const points = AtriumGeometryCurves.pathPoints(it, .001), pts = parent ? points.map(p => Atrium.world(p, parent)) : points;
      rec.net = net; rec.kind = keep ? "keepout" : it.kind === "track" && !parent ? "track" : "graphic";
      rec.movable = rec.kind === "track" && !it.locked;
      if (it.fill && pts.length >= 3) {
        for (const piece of convex(pts) ? [pts] : globalThis.Atrium.triangulateRing(pts)) addPolygon(W, o, piece, r, lo, hi, net);
      } else if (r > 0 || keep) {
        if (pts.length === 1) addCapsule(W, o, pts[0][0], pts[0][1], pts[0][0], pts[0][1], r, lo, hi, net);
        for (let i = 1; i < pts.length; i++) addCapsule(W, o, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], r, lo, hi, net);
        if (it.closed && pts.length > 2) addCapsule(W, o, pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1], r, lo, hi, net);
      }
      return finish();
    }
    if (it.kind === "via") {
      const physicalSpan = AtriumPCBAppearance.copperSpan(it, layerIndex);
      let span = physicalSpan;
      if (!span) {
        // Collision protection for legacy edits keeps a known single layer or guards the whole stack.
        const from = layerIndex(it.fromLayer);
        span = from >= 0 && from === layerIndex(it.toLayer) ? [from, from] : [0, 127];
      }
      const c = AtriumPCBAppearance.padCenter(it,parent), diameter = finite(it.diameter) ? it.diameter : .6;
      rec.net = W.nid(netName); rec.movable = !parent && !it.locked;
      if (physicalSpan && (it.stackMode === "full" || it.stackMode === "tmb" || it.shape && it.shape !== "round")) {
        const C = AtriumLandContours, L = AtriumResolvedLand;
        const copper = W.contactCopper ??= C.copperLookup(W.board, W.defs);
        rec.viaSpan = span; rec.shoveRadius = diameter / 2;
        rec.viaLands = C.placedCopper(it, parent, copper).map(q => {
          const {core, r} = L.core(q.land, [0,0], q.angle, q.mirror), layer = layerIndex(q.layer);
          rec.shoveRadius = Math.max(rec.shoveRadius, r + Math.max(...core.map(p => Math.hypot(...p))));
          return {core, r, lo:layer < 0 ? span[0] : layer, hi:layer < 0 ? span[1] : layer};
        });
      }
      addViaAt(W, o, ...c, diameter, ...span, rec.net);
      return finish();
    }
    if (it.kind === "pad") {
      const declared = AtriumPCBAppearance.padLayer(parent, it);
      let lo, hi;
      if (declared === "Multi") { lo = 0; hi = 127; } else { const li = layerIndex(declared); if (li < 0) return finish(); lo = hi = li; }
      const L=AtriumResolvedLand, c=AtriumPCBAppearance.padCenter(it,parent), nominal=L.geometry(it);
      const npth=it.drill>0&&(it.plated===false||it.holeOnly||nominal&&nominal.holeOnly);
      rec.net=W.nid(netName);
      if(npth){addCapsule(W,o,...c,...c,it.drill/2,0,127,HOLE);rec.kind="hole";return finish();}
      for(const layer of padPlanes(it,declared,W.padCopper)){
        const land=layer==null?nominal:L.geometry(it,layer);
        if(!land||land.holeOnly)continue;
        const {at,angle,mirror}=L.place(land,parent),{core,r}=L.core(land,at,angle,mirror);
        const first=layer==null?lo:layerIndex(layer),last=layer==null?hi:first;
        if(core.length<=2)addCapsule(W,o,...core[0],...core.at(-1),r,first,last,rec.net);
        else for(const ring of land.shape==="custom"&&!convex(core)?globalThis.Atrium.triangulateRing(core):[core])
          addPolygon(W,o,ring,r,first,last,rec.net);
      }
      if(W.holes&&it.drill>0)addCapsule(W,o,...c,...c,it.drill/2,lo,hi,HOLE);
      if(it.drill>0&&declared!=="Multi")addCapsule(W,o,...c,...c,it.drill/2,0,127,rec.net);
      return finish();
    }
    return finish();
  }
  function addBoardItem(W, it, defs) {
    const first = W.owners.length;
    if (it.kind === "part") {
      const fp = defs?.get?.(it.def)?.footprint;
      (fp?.pads || []).forEach((p, j) => addItem(W, {...p, kind:p.kind === "via" ? "via" : "pad", diameter:p.diameter || p.w}, it, "pad" + j));
      // Only shapes that explicitly name a copper or keep-out layer are routing obstacles.
      (fp?.shapes || []).forEach((s, j) => { if (s.points && (layerIndex(s.layer) >= 0 || s.layer === "Keepout")) addItem(W, {...s, kind:"graphic"}, it, "shape" + j); });
    } else if (it.kind === "track" || it.kind === "via" || it.kind === "pad" || it.kind === "graphic") addItem(W, it, null, 0);
    if (it.id != null) W.itemOwners.set(it.id, [first, W.owners.length]);
  }
  // Uniform grid, compressed rows. Each feature is listed in the cells its
  // swept band touches (not its whole bounding box), so long diagonals stay cheap.
  function band(W, G, ax, ay, bx, by, rad) {
    const cs = G.cs, ox = G.ox, oy = G.oy, nx = G.nx, ny = G.ny;
    let r0 = Math.floor((Math.min(ay, by) - rad - oy) / cs), r1 = Math.floor((Math.max(ay, by) + rad - oy) / cs);
    if (r1 < 0 || r0 >= ny) return 0;
    if (r0 < 0) r0 = 0; if (r1 >= ny) r1 = ny - 1;
    if (W.rb.length < 3 * (r1 - r0 + 1)) W.rb = new Int32Array(3 * (r1 - r0 + 1) * 2);
    const rb = W.rb, dx = bx - ax, dy = by - ay; let k = 0;
    for (let row = r0; row <= r1; row++) {
      const sy0 = oy + row * cs - rad, sy1 = sy0 + cs + 2 * rad;
      let x0, x1;
      if (Math.abs(dy) < 1e-12) { x0 = ax < bx ? ax : bx; x1 = ax < bx ? bx : ax; }
      else {
        let t0 = (sy0 - ay) / dy, t1 = (sy1 - ay) / dy;
        if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
        if (t0 < 0) t0 = 0; if (t1 > 1) t1 = 1; if (t0 > t1) continue;
        const xa = ax + dx * t0, xb = ax + dx * t1; x0 = xa < xb ? xa : xb; x1 = xa < xb ? xb : xa;
      }
      let c0 = Math.floor((x0 - rad - ox) / cs), c1 = Math.floor((x1 + rad - ox) / cs);
      if (c1 < 0 || c0 >= nx) continue;
      if (c0 < 0) c0 = 0; if (c1 >= nx) c1 = nx - 1;
      rb[k++] = row; rb[k++] = c0; rb[k++] = c1;
    }
    return k;
  }
  function featureBand(W, G, f) {
    if (W.kind[f] === 0) return band(W, G, W.ax[f], W.ay[f], W.bx[f], W.by[f], W.r[f]);
    const cx = (W.x0[f] + W.x1[f]) / 2;
    return band(W, G, cx, W.y0[f], cx, W.y1[f], (W.x1[f] - W.x0[f]) / 2);
  }
  function buildGrid(W) {
    const n = W.n;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let f = 0; f < n; f++) { if (W.x0[f] < x0) x0 = W.x0[f]; if (W.y0[f] < y0) y0 = W.y0[f]; if (W.x1[f] > x1) x1 = W.x1[f]; if (W.y1[f] > y1) y1 = W.y1[f]; }
    if (!(x0 < x1)) { x0 = -50; x1 = 50; } if (!(y0 < y1)) { y0 = -50; y1 = 50; }
    x0 -= 5; y0 -= 5; x1 += 5; y1 += 5;
    const area = (x1 - x0) * (y1 - y0);
    let cs = Math.min(20, Math.max(0.5, Math.sqrt(area / Math.max(1, n)) * 1.5));
    while (Math.ceil((x1 - x0) / cs) * Math.ceil((y1 - y0) / cs) > 4e6) cs *= 1.5;
    const G = {ox:x0, oy:y0, cs, nx:Math.max(1, Math.ceil((x1 - x0) / cs)), ny:Math.max(1, Math.ceil((y1 - y0) / cs))};
    const cells = G.nx * G.ny, start = new Int32Array(cells + 1);
    for (let f = 0; f < n; f++) {
      const k = featureBand(W, G, f), rb = W.rb;
      for (let i = 0; i < k; i += 3) for (let c = rb[i + 1], base = rb[i] * G.nx; c <= rb[i + 2]; c++) start[base + c + 1]++;
    }
    for (let i = 0; i < cells; i++) start[i + 1] += start[i];
    const refs = new Int32Array(start[cells]), fill = start.slice(0, cells);
    for (let f = 0; f < n; f++) {
      const k = featureBand(W, G, f), rb = W.rb;
      for (let i = 0; i < k; i += 3) for (let c = rb[i + 1], base = rb[i] * G.nx; c <= rb[i + 2]; c++) refs[fill[base + c]++] = f;
    }
    G.start = start; G.refs = refs; W.grid = G;
  }
  function buildWorld(board, defs, holes) {
    const t0 = now(), W = createWorld();
    W.board = board; W.defs = defs; W.holes = holes;
    W.padCopper = () => W.copperKeys ??= globalThis.AtriumStackup?.copperLayers(W.board,W.defs) || ["Top","Bottom"];
    for (const it of board.items || []) addBoardItem(W, it, defs);
    const ol = board.outline;
    if (Array.isArray(ol) && ol.length >= 3) {
      const o = W.owners.length; W.owners.push({item:null, kind:"outline", first:W.n, count:0, movable:false, net:OUTLINE});
      for (let i = 0; i < ol.length; i++) { const a = ol[i], b = ol[(i + 1) % ol.length]; addCapsule(W, o, a[0], a[1], b[0], b[1], 0, 0, 127, OUTLINE); } // route-suggest: edges on every layer (outline)
      W.owners[o].count = W.n - W.owners[o].first;
      W.outline = ol.map(p => [p[0], p[1]]);
    }
    // Board cutouts: their edges are outline obstacles and their inside is off the board.
    for (const h of globalThis.AtriumBoardShape?.holes?.(board) || []) {
      if (h.length < 3) continue;
      const o = W.owners.length; W.owners.push({item:null, kind:"outline", first:W.n, count:0, movable:false, net:OUTLINE});
      for (let i = 0; i < h.length; i++) { const a = h[i], b = h[(i + 1) % h.length]; addCapsule(W, o, a[0], a[1], b[0], b[1], 0, 0, 127, OUTLINE); } // route-suggest: edges on every layer (cutouts)
      W.owners[o].count = W.n - W.owners[o].first;
      (W.cutouts ||= []).push(h.map(p => [p[0], p[1]]));
    }
    W.nBuilt = W.nPersist = W.n;
    W.trim();
    buildGrid(W);
    W.buildMs = now() - t0;
    W.scene = createScene(W);
    return W;
  }
  // Persistent additions after the build use a hashed overflow grid.
  function persistFeatures(W, from) {
    const G = W.grid;
    for (let f = from; f < W.n; f++) {
      const k = featureBand(W, G, f), rb = W.rb;
      for (let i = 0; i < k; i += 3) for (let c = rb[i + 1], base = rb[i] * G.nx; c <= rb[i + 2]; c++) {
        let list = W.extra.get(base + c); if (!list) W.extra.set(base + c, list = []); list.push(f);
      }
    }
    W.nPersist = W.n;
  }
  function insideOutline(W, x, y) {
    if (W.cutouts) for (const ring of W.cutouts) if (inRingAt(x, y, ring)) return false;
    return !W.outline || inRingAt(x, y, W.outline);
  }

  // Candidate features along a swept segment on layers lo..hi. Fills W.qb; returns the count.
  /** @param {"track"|"via"} [target] Routed object tested against object-specific keepout restrictions. */
  function candidates(W, ax, ay, bx, by, rad, lo, hi, target = "track") {
    if (++W.stampV >= 0xfffffff0) { W.stamp.fill(0); W.stampV = 1; }
    const sv = W.stampV, G = W.grid, start = G.start, refs = G.refs, stamp = W.stamp, dead = W.dead, L = W.lo, H = W.hi;
    let qb = W.qb, m = 0;
    const k = band(W, G, ax, ay, bx, by, rad), rb = W.rb, extra = W.extra.size ? W.extra : null;
    for (let i = 0; i < k; i += 3) {
      const base = rb[i] * G.nx;
      for (let c = rb[i + 1]; c <= rb[i + 2]; c++) {
        const cell = base + c;
        for (let j = start[cell], e = start[cell + 1]; j < e; j++) {
          const f = refs[j];
          if (stamp[f] === sv) continue; stamp[f] = sv;
          if (dead[f] || L[f] > hi || H[f] < lo) continue;
          if (m >= qb.length) { const q = new Int32Array(qb.length * 2); q.set(qb); W.qb = qb = q; }
          qb[m++] = f;
        }
        if (extra) {
          const list = extra.get(cell);
          if (list) for (const f of list) {
            if (stamp[f] === sv) continue; stamp[f] = sv;
            if (dead[f] || L[f] > hi || H[f] < lo) continue;
            if (m >= qb.length) { const q = new Int32Array(qb.length * 2); q.set(qb); W.qb = qb = q; }
            qb[m++] = f;
          }
        }
      }
    }
    if (W.n > W.nPersist) {
      const xa = Math.min(ax, bx) - rad, xb = Math.max(ax, bx) + rad, ya = Math.min(ay, by) - rad, yb = Math.max(ay, by) + rad;
      for (let f = W.nPersist; f < W.n; f++) {
        if (dead[f] || L[f] > hi || H[f] < lo) continue;
        if (W.x0[f] > xb || W.x1[f] < xa || W.y0[f] > yb || W.y1[f] < ya) continue;
        if (m >= qb.length) { const q = new Int32Array(qb.length * 2); q.set(qb); W.qb = qb = q; }
        qb[m++] = f;
      }
    }
    if (W.restrictedKeepouts) {
      let kept = 0;
      for (let i = 0; i < m; i++) {
        const f = qb[i];
        if (W.net[f] !== KEEPOUT || globalThis.Atrium.keepoutBlocks(W.owners[W.own[f]].item, target)) qb[kept++] = f;
      }
      m = kept;
    }
    return m;
  }
  // Exact edge-to-centreline distance from segment a-b to feature f's copper.
  function fdist(W, f, ax, ay, bx, by) {
    if (W.kind[f] === 0) return Math.sqrt(segSeg2(ax, ay, bx, by, W.ax[f], W.ay[f], W.bx[f], W.by[f])) - W.r[f];
    const o = W.poff[f], m = W.plen[f], pv = W.pv;
    if (inConvex(pv, o, m, ax, ay) || inConvex(pv, o, m, bx, by)) return -W.r[f];
    let best = Infinity;
    for (let i = 0; i < m; i++) {
      const j = i + 1 === m ? 0 : i + 1;
      const d = segSeg2(ax, ay, bx, by, pv[o + 2 * i], pv[o + 2 * i + 1], pv[o + 2 * j], pv[o + 2 * j + 1]);
      if (d < best) { best = d; if (d === 0) break; }
    }
    return Math.sqrt(best) - W.r[f];
  }

  // ---------------------------------------------------------------- scene (transient edits)
  function createScene(W) {
    // gen changes with every edit, so a session can tell its cached preview still matches the scene.
    const S = {mods:new Map(), dyn:new Map(), marked:[], dirty:false, gen:0};
    S.reset = () => {
      if (!S.dirty) return;
      S.gen++;
      for (const f of S.marked) W.dead[f] &= 1;
      S.marked.length = 0; W.n = W.nPersist; S.mods.clear(); S.dyn.clear(); S.dirty = false;
    };
    const kill = f => { if (!(W.dead[f] & 2)) { W.dead[f] |= 2; S.marked.push(f); } };
    S.geometry = o => {
      if (S.mods.has(o)) return S.mods.get(o);
      const rec = W.owners[o], it = rec.item;
      if (rec.kind === "track") return {kind:"track", points:AtriumGeometryCurves.pathPoints(it,.001), width:it.width, layer:it.layer, net:rec.net};
      if (rec.kind === "via") return {kind:"via", x:it.x, y:it.y, diameter:finite(it.diameter) ? it.diameter : .6,
        lo:rec.viaSpan?.[0] ?? W.lo[rec.first], hi:rec.viaSpan?.[1] ?? W.hi[rec.first], net:rec.net, shoveRadius:rec.shoveRadius};
      return null;
    };
    // Replaces owner o's copper with new geometry (a track polyline or a via position).
    S.set = (o, g) => {
      S.dirty = true; S.gen++;
      const prior = S.dyn.get(o);
      if (prior) for (const f of prior) kill(f);
      else { const rec = W.owners[o]; for (let f = rec.first; f < rec.first + rec.count; f++) kill(f); }
      const first = W.n;
      if (g.kind === "track") {
        const li = layerIndex(g.layer), r = g.width / 2;
        for (let i = 1; i < g.points.length; i++) addCapsule(W, o, g.points[i - 1][0], g.points[i - 1][1], g.points[i][0], g.points[i][1], r, li, li, g.net);
      } else addViaAt(W, o, g.x, g.y, g.diameter, g.lo, g.hi, g.net);
      const ids = []; for (let f = first; f < W.n; f++) ids.push(f);
      S.dyn.set(o, ids); S.mods.set(o, g);
    };
    // The route itself, as an immovable obstacle for shoved copper.
    S.addLine = (pts, hw, lo, hi, net) => {
      S.dirty = true; S.gen++;
      if (pts.length === 1) addCapsule(W, -1, pts[0][0], pts[0][1], pts[0][0], pts[0][1], hw, lo, hi, net);
      for (let i = 1; i < pts.length; i++) addCapsule(W, -1, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], hw, lo, hi, net);
    };
    return S;
  }

  // ---------------------------------------------------------------- routing context
  // A context fixes the routed copper: layer, half width, net(s) and clearances.
  function makeContext(W, rules, o) {
    const ctx = {W, rules, layer:o.layer, li:layerIndex(o.layer), hw:o.hw, net:o.net, net2:o.net2 ?? -99, netName:o.netName || "", net2Name:o.net2Name,
      dirs:o.dirs || 8, base:o.base || "45", exempt:new Set(), endExempt:new Set(), hulls:new Map(), deadline:Infinity, checks:0};
    const N = W.netNames.length, clr = new Float64Array(N + NET0);
    const pair = (other, layer) => {
      let v = rules.clearance(ctx.netName, other, layer);
      if (ctx.net2Name != null) v = Math.max(v, rules.clearance(ctx.net2Name, other, layer));
      return v;
    };
    let maxC = 0;
    const bound = rules.maxClearance ? rules.maxClearance() : undefined;
    if (finite(bound)) { clr.fill(NaN); maxC = bound; }   // resolved on first contact
    else for (let i = 0; i < N; i++) { clr[i + NET0] = pair(W.netNames[i], o.layer); if (clr[i + NET0] > maxC) maxC = clr[i + NET0]; }
    ctx.pair = pair;
    if (rules.physical) {
      ctx.subject = {kind:"track", ck:"track", net:ctx.netName, layer:o.layer, span:[ctx.li,ctx.li], width:o.hw * 2};
      if (ctx.net2Name != null) ctx.partner = {...ctx.subject, net:ctx.net2Name};
    }
    clr[NONET + NET0] = pair("", o.layer); clr[KEEPOUT + NET0] = 0; clr[HOLE + NET0] = clr[NONET + NET0];
    clr[OUTLINE + NET0] = rules.edgeClearance(ctx.netName);
    ctx.clr = clr; ctx.maxClr = Math.max(maxC, clr[NONET + NET0], clr[OUTLINE + NET0]);
    ctx.reach = ctx.hw + ctx.maxClr;
    return ctx;
  }
  function querySegment(ctx, ax, ay, bx, by) {
    if (!ctx.rules.spatial) return;
    const geometry = globalThis.AtriumRules.kit.feature({},[[ax,ay],[bx,by]],ctx.hw);
    Object.assign(ctx.subject,geometry);
    if (ctx.partner) Object.assign(ctx.partner,geometry);
  }
  function featureSubject(W, f, spatial) {
    const rec = W.owners[W.own[f]], item = rec?.item, hole = W.net[f] === HOLE;
    const s = item ? globalThis.AtriumRules.kit.copperSubject(item,rec.parent) :
      {kind:W.lo[f] === W.hi[f] ? "track" : "via", ck:W.lo[f] === W.hi[f] ? "track" : "via"};
    s.span = [W.lo[f],W.hi[f]]; s.net = W.netName(hole ? rec?.net : W.net[f]);
    s.box = [W.x0[f],W.y0[f],W.x1[f],W.y1[f]];
    if (spatial) {
      const core = W.kind[f] === 0 ? [[W.ax[f],W.ay[f]],[W.bx[f],W.by[f]]] :
        Array.from({length:W.plen[f]},(_,i)=>[W.pv[W.poff[f]+2*i],W.pv[W.poff[f]+2*i+1]]);
      Object.assign(s,globalThis.AtriumRules.kit.feature({},core,W.r[f]));
    }
    if (hole) s.ck = "hole";
    return s;
  }
  const required = (ctx, f) => {
    const W = ctx.W, n = W.net[f];
    if (n >= 0 && (n === ctx.net || n === ctx.net2)) return -1;
    let c = ctx.clr[n + NET0];
    if (ctx.subject && n !== KEEPOUT && n !== OUTLINE && !(c < 0)) {
      const other = featureSubject(W, f, ctx.rules.spatial);
      if (n === HOLE && other.net && (other.net === ctx.netName || other.net === ctx.net2Name)) return -1;
      const fallback = n === HOLE ? (W.owners[W.own[f]]?.kind === "hole" ? c : -Infinity) : 0;
      const gap = ctx.rules.physical(ctx.subject,other) ?? fallback;
      const need = ctx.partner ? Math.max(gap, ctx.rules.physical(ctx.partner,other) ?? fallback) : gap;
      return ctx.hw + need;
    }
    if (c !== c) {
      if (n + NET0 >= ctx.clr.length) { const a = new Float64Array(W.netNames.length + NET0).fill(NaN); a.set(ctx.clr); ctx.clr = a; }
      c = ctx.clr[n + NET0] = ctx.pair(W.netNames[n], ctx.layer);
    }
    return ctx.hw + c;
  };
  // First colliding feature on segment a-b (exact), or -1. Exempt features are skipped unless `all`.
  function segmentHit(ctx, ax, ay, bx, by, all) {
    const W = ctx.W, m = candidates(W, ax, ay, bx, by, ctx.reach, ctx.li, ctx.li), qb = W.qb;
    ctx.checks++; querySegment(ctx, ax, ay, bx, by);
    let best = -1, bestT = Infinity;
    const xa = Math.min(ax, bx), xb = Math.max(ax, bx), ya = Math.min(ay, by), yb = Math.max(ay, by);
    for (let i = 0; i < m; i++) {
      const f = qb[i], req = required(ctx, f);
      if (req < 0) continue;
      if (W.x0[f] - req > xb || W.x1[f] + req < xa || W.y0[f] - req > yb || W.y1[f] + req < ya) continue;
      if (!all && (ctx.exempt.size || ctx.endExempt.size) && (ctx.exempt.has(f) || ctx.endExempt.has(f))) continue;
      if (fdist(W, f, ax, ay, bx, by) >= req - TOL) continue;
      // Earliest contact along the segment, measured at the closest approach to its start.
      const t = W.kind[f] === 0 ? Math.sqrt(pt2(W.ax[f], W.ay[f], ax, ay, ax, ay)) : Math.hypot(W.ax[f] - ax, W.ay[f] - ay);
      if (t < bestT) { bestT = t; best = f; }
    }
    return best;
  }
  function pathHit(ctx, pts, all, from = 0) {
    for (let i = from + 1; i < pts.length; i++) {
      const f = segmentHit(ctx, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1], all);
      if (f >= 0) return {seg:i - 1, f};
    }
    return null;
  }
  const pathClear = (ctx, pts) => !pathHit(ctx, pts, false);
  // k-DOP hull of feature f inflated by its clearance + our half width (+PAD).
  function hullOf(W, f, inflate, K) {
    const D = DIRS[K], h = new Float64Array(K);
    for (let k = 0; k < K; k++) {
      const c = D.c[k], s = D.s[k];
      let m;
      if (W.kind[f] === 0) m = Math.max(W.ax[f] * c + W.ay[f] * s, W.bx[f] * c + W.by[f] * s);
      else { m = -Infinity; for (let i = 0, o = W.poff[f]; i < W.plen[f]; i++) { const v = W.pv[o + 2 * i] * c + W.pv[o + 2 * i + 1] * s; if (v > m) m = v; } }
      h[k] = m + W.r[f] + inflate;
    }
    return hullFromSupports(h, K);
  }
  function hullFromSupports(h, K) {
    const D = DIRS[K], v = [];
    for (let k = 0; k < K; k++) {
      const j = (k + 1) % K, c1 = D.c[k], s1 = D.s[k], c2 = D.c[j], s2 = D.s[j], det = c1 * s2 - s1 * c2;
      const x = (h[k] * s2 - s1 * h[j]) / det, y = (c1 * h[j] - h[k] * c2) / det;
      const last = v[v.length - 1];
      if (!last || Math.abs(last[0] - x) > 1e-9 || Math.abs(last[1] - y) > 1e-9) v.push([x, y]);
    }
    if (v.length > 1 && Math.abs(v[0][0] - v[v.length - 1][0]) < 1e-9 && Math.abs(v[0][1] - v[v.length - 1][1]) < 1e-9) v.pop();
    // Axis-aligned box (the supports along ±x and ±y) for quick rejects.
    return {v, h, K, x0:-h[K / 2] - 1e-9, x1:h[0] + 1e-9, y0:-h[3 * K / 4] - 1e-9, y1:h[K / 4] + 1e-9};
  }
  function capsuleHull(ax, ay, bx, by, inflate, K) {
    const D = DIRS[K], h = new Float64Array(K);
    for (let k = 0; k < K; k++) h[k] = Math.max(ax * D.c[k] + ay * D.s[k], bx * D.c[k] + by * D.s[k]) + inflate;
    return hullFromSupports(h, K);
  }
  function ctxHull(ctx, f) {
    let H = !ctx.rules.spatial && f < ctx.W.nPersist ? ctx.hulls.get(f) : null;
    if (H) return H;
    H = hullOf(ctx.W, f, required(ctx, f) + PAD, ctx.dirs);
    if (!ctx.rules.spatial && f < ctx.W.nPersist) ctx.hulls.set(f, H);
    return H;
  }
  function hullInside(H, p) {
    const D = DIRS[H.K];
    for (let k = 0; k < H.K; k++) if (p[0] * D.c[k] + p[1] * D.s[k] >= H.h[k] - 1e-9) return false;
    return true;
  }
  // First entry into / last exit from the hull boundary along the path.
  function crossings(pts, H) {
    const V = H.v, m = V.length;
    let first = null, last = null;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i], rx = b[0] - a[0], ry = b[1] - a[1];
      if ((a[0] < H.x0 && b[0] < H.x0) || (a[0] > H.x1 && b[0] > H.x1) || (a[1] < H.y0 && b[1] < H.y0) || (a[1] > H.y1 && b[1] > H.y1)) continue;
      for (let e = 0; e < m; e++) {
        const p = V[e], q = V[(e + 1) % m], sx = q[0] - p[0], sy = q[1] - p[1];
        const den = rx * sy - ry * sx; if (Math.abs(den) < 1e-14) continue;
        const wx = p[0] - a[0], wy = p[1] - a[1], t = (wx * sy - wy * sx) / den, u = (wx * ry - wy * rx) / den;
        if (t < -1e-12 || t > 1 + 1e-12 || u < -1e-12 || u > 1 + 1e-12) continue;
        const pos = i - 1 + Math.min(1, Math.max(0, t)), pt = [a[0] + rx * t, a[1] + ry * t];
        if (!first || pos < first.pos) first = {pos, seg:i - 1, edge:e, u, pt};
        if (!last || pos > last.pos) last = {pos, seg:i - 1, edge:e, u, pt};
      }
    }
    return first && last && last.pos > first.pos ? {first, last} : null;
  }
  function boundary(H, X, dir) {
    const V = H.v, m = V.length, ea = X.first.edge, eb = X.last.edge, out = [X.first.pt];
    if (dir > 0) {
      if (!(ea === eb && X.last.u >= X.first.u)) { let k = (ea + 1) % m; out.push(V[k]); let g = 0; while (k !== eb && g++ < m) { k = (k + 1) % m; out.push(V[k]); } }
    } else {
      if (!(ea === eb && X.last.u <= X.first.u)) { let k = ea; out.push(V[k]); const stop = (eb + 1) % m; let g = 0; while (k !== stop && g++ < m) { k = (k - 1 + m) % m; out.push(V[k]); } }
    }
    out.push(X.last.pt);
    return out;
  }
  function cutAt(pts, X) { return simplify([...pts.slice(0, X.first.seg + 1), X.first.pt]); }
  // Largest prefix of the path free of violations (bisection on the first colliding segment).
  function truncate(ctx, pts, all) {
    const hit = pathHit(ctx, pts, all);
    if (!hit) return {path:pts, clipped:false};
    const a = pts[hit.seg], b = pts[hit.seg + 1];
    let lo = 0, hi = 1;
    if (segmentHit(ctx, a[0], a[1], a[0], a[1], all) >= 0) return {path:simplify(pts.slice(0, hit.seg + 1)), clipped:true};
    for (let i = 0; i < 24; i++) {
      const t = (lo + hi) / 2, x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      if (segmentHit(ctx, a[0], a[1], x, y, all) >= 0) hi = t; else lo = t;
    }
    const p = [a[0] + (b[0] - a[0]) * lo, a[1] + (b[1] - a[1]) * lo];
    return {path:simplify([...pts.slice(0, hit.seg + 1), p]), clipped:true};
  }

  // ---------------------------------------------------------------- walkaround
  // A provider supplies collisions and hulls: the board (scene) or a list of pusher segments.
  function sceneProvider(ctx) {
    return {
      seg: 0,
      first(pts, from = 0) { const h = pathHit(ctx, pts, false, from); if (!h) return -1; this.seg = h.seg; return h.f; },
      hull: f => ctxHull(ctx, f),
      onStart: f => { ctx.exempt.add(f); return true; },
      onEnd: (f, p) => {
        // The cursor may sit inside a conservative hull but still be legal (fine-pitch pads).
        if (fdist(ctx.W, f, p[0], p[1], p[0], p[1]) >= required(ctx, f) - TOL) { ctx.endExempt.add(f); return true; }
        return false;
      },
      deadline: () => ctx.deadline
    };
  }
  // Two k-DOPs over the same directions overlap when their extents overlap on every axis.
  function hullsOverlap(P, Q) {
    if (!P || !Q || P.K !== Q.K) return false;
    const K = P.K, half = K / 2;
    for (let k = 0; k < half; k++) if (P.h[k] < -Q.h[k + half] || Q.h[k] < -P.h[k + half]) return false;
    return true;
  }
  function walk(prov, path, policy, maxIter) {
    let pts = simplify(path), blocked = -1, prevH = null, prevDir = 0, from = 0;
    for (let iter = 0; iter < maxIter; iter++) {
      if (now() > prov.deadline()) return {path:pts, ok:false, timeout:true};
      // Segments before the last hit that the detour left untouched are still clear.
      const f = prov.first(pts, from);
      if (f < 0) return {path:pts, ok:true};
      const H = prov.hull(f);
      if (hullInside(H, pts[0])) { if (prov.onStart(f)) continue; return {path:pts, ok:false, blocked:f}; }
      const end = pts[pts.length - 1];
      if (hullInside(H, end)) {
        if (prov.onEnd(f, end)) continue;
        const X = crossings(pts, H);
        return {path:X ? cutAt(pts, X) : pts, ok:false, blocked:f, endInside:true};
      }
      const X = crossings(pts, H);
      if (!X) { if (prov.onEnd(f, end)) continue; return {path:pts, ok:false, blocked:f}; }
      const a = boundary(H, X, 1), b = boundary(H, X, -1);
      // Within a cluster of overlapping hulls keep turning the same way, so the
      // walk follows the cluster's outline instead of oscillating between members.
      let dir = policy === 1 ? 1 : policy === 2 ? -1 : prevDir && hullsOverlap(prevH, H) ? prevDir : pathLength(a) <= pathLength(b) ? 1 : -1;
      const choice = dir > 0 ? a : b;
      prevH = H; prevDir = dir;
      const old = pts, hitSeg = prov.seg;
      pts = simplify([...pts.slice(0, X.first.seg + 1), ...choice, ...pts.slice(X.last.seg + 1)]);
      let k = 0, m = 0; while (k < pts.length && k < old.length && pts[k] === old[k]) k++;
      while (m < pts.length - k && m < old.length && pts[pts.length - 1 - m] === old[old.length - 1 - m]) m++;
      if (iter === 0 || crossesNew(pts, Math.max(0, k - 1), pts.length - m)) pts = unloop(pts);
      let k2 = 0; while (k2 < pts.length && k2 < old.length && pts[k2] === old[k2]) k2++;
      from = Math.max(0, Math.min(hitSeg, k2 - 2));
      blocked = f;
    }
    return {path:pts, ok:false, blocked};
  }
  // Shortcut pairs of vertices with corner-style connectors while the result stays clear.
  function optimize(ctx, pts, base, budget = 80) {
    return shortcut(pts, base, budget, ctx.deadline, v => pathClear(ctx, v));
  }
  // `slide` bounds the area a shortcut may sweep (Infinity: any).
  function shortcut(pts, base, budget, deadline, clear, slide = Infinity) {
    pts = unloop(simplify(pts));
    let tries = 0, changed = true, pass = 0;
    while (changed && pass++ < 6) {
      changed = false;
      // Two parallel runs separated by a step can both be pinned against copper.
      // Slide their common diagonal between them and intersect the neighbouring
      // legs. This gives a three-segment connector even when neither elbow fits.
      if (base === "45") for (let k = 0; k + 3 < pts.length && !changed; k++) {
        const a = pts[k], b = pts[k + 1], c = pts[k + 2], d = pts[k + 3];
        const dx = b[0] - a[0], dy = b[1] - a[1], ex = d[0] - c[0], ey = d[1] - c[1];
        if (dx * ex + dy * ey <= 0 || Math.abs(dx * ey - dy * ex) > 1e-8 * dist(a, b) * dist(c, d)) continue;
        const axis = Math.max(Math.abs(dx), Math.abs(dy)), ux = dx / axis, uy = dy / axis;
        const height = p => ux * (p[1] - a[1]) - uy * (p[0] - a[0]);
        const offset = height(c);
        if (Math.abs(offset) < 1e-8) continue;
        const i = Math.max(0, k - 1), j = Math.min(pts.length - 1, k + 4);
        if (j - i < 4) continue;
        const left = pts[i], right = pts[j];
        // Intersect a forward ray from the fixed end with the chosen parallel.
        const meet = (p, q, h) => {
          if (p === q) return p;
          const hp = height(p), dh = height(q) - hp;
          if (Math.abs(dh) < 1e-9) return null;
          const t = (h - hp) / dh;
          return t < 0 ? null : [p[0] + t * (q[0] - p[0]), p[1] + t * (q[1] - p[1])];
        };
        const levels = left === a ? [0] : right === d ? [1] : [0, 1, .5, .25, .75];
        const orig = pathLength(pts.slice(i, j + 1));
        for (const level of levels) {
          const h = offset * level, p = meet(left, a, h), q = meet(right, d, h);
          if (!p || !q || (q[0] - p[0]) * ux + (q[1] - p[1]) * uy <= 0) continue;
          const v = simplify([left, p, q, right]);
          if (pathLength(v) > orig + 1e-9 || (slide < Infinity && sweptArea(pts, i, j, v) > slide)) continue;
          if (++tries > budget || now() > deadline) return pts;
          if (!clear(v)) continue;
          const next = [...pts.slice(0, i), ...v, ...pts.slice(j + 1)];
          if (crossesNew(next, i, i + v.length - 1)) continue;
          pts = simplify(next); changed = true; break;
        }
      }
      for (let i = 0; i < pts.length - 2 && !changed; i++) {
        for (let j = Math.min(pts.length - 1, i + 12); j >= i + 2 && !changed; j--) {
          let orig = 0; for (let k = i + 1; k <= j; k++) orig += dist(pts[k - 1], pts[k]);
          const variants = base === "any" ? [connector(pts[i], pts[j], base, false)] : [connector(pts[i], pts[j], base, false), connector(pts[i], pts[j], base, true)];
          for (const v of variants) {
            const len = pathLength(v);
            if (len > orig + 1e-9 || (len > orig - 1e-9 && v.length - 1 >= j - i)) continue;
            if (slide < Infinity && sweptArea(pts, i, j, v) > slide) continue;
            if (++tries > budget || now() > deadline) return pts;
            if (clear(v)) { pts = simplify([...pts.slice(0, i), ...v, ...pts.slice(j + 1)]); changed = true; break; }
          }
        }
      }
    }
    return pts;
  }
  // Area between pts[i..j] and the replacement v (same end points).
  function sweptArea(pts, i, j, v) {
    let a = 0;
    const ring = [...pts.slice(i, j + 1), ...v.slice(1, -1).reverse()];
    for (let k = 0; k < ring.length; k++) { const p = ring[k], q = ring[(k + 1) % ring.length]; a += p[0] * q[1] - q[0] * p[1]; }
    return Math.abs(a) / 2;
  }
  // Full walkaround from a to b: three hull-walking policies, then smoothing.
  function walkaround(ctx, a, b, bend, opt = {}) {
    ctx.endExempt.clear();
    const base = ctx.base, initial = connector(a, b, base, bend);
    if (!insideOutline(ctx.W, b[0], b[1])) {
      const t = truncate(ctx, initial, false);
      return {path:t.path, ok:false, status:"blocked"};
    }
    const prov = sceneProvider(ctx), iters = opt.iterations || 48, t0 = now(), spare = (ctx.deadline - t0) * 0.3;
    let best = null, bestLen = Infinity, sticky = null, stickyLen = Infinity;
    // Hull walking is greedy and direction dependent: try each turning policy,
    // forwards and (while time allows) backwards from the cursor, keep the shortest.
    // opt.side (the side the previous head took) is kept unless the other way is
    // shorter by more than opt.slack: the head no longer flips with hand jitter.
    const tries = [[0, false], [1, false], [2, false], [0, true], [1, true], [2, true]];
    for (const [policy, reverse] of tries) {
      if (best && best.ok && now() - t0 > spare) break;
      let r;
      if (reverse) {
        if (!best || !best.ok) break;
        const saved = new Set(ctx.exempt), savedEnd = new Set(ctx.endExempt);
        // Swap the roles of the start and end exemptions for the reversed walk.
        ctx.exempt = savedEnd; ctx.endExempt = saved;
        r = walk(prov, connector(b, a, base, !bend), policy, iters);
        for (const f of ctx.exempt) savedEnd.add(f); for (const f of ctx.endExempt) saved.add(f);
        ctx.exempt = saved; ctx.endExempt = savedEnd;
        if (r.ok) r.path = r.path.slice().reverse();
      } else r = walk(prov, initial, policy, iters);
      const len = r.ok ? pathLength(r.path) : Infinity;
      if (!best || (r.ok && (!best.ok || len < bestLen))) { best = r; bestLen = len; }
      if (r.ok && opt.side && len < stickyLen && sideOf(r.path) === opt.side) { sticky = r; stickyLen = len; }
      if (r.timeout || r.endInside) break;
    }
    if (sticky && stickyLen <= bestLen + (opt.slack || 0)) best = sticky;
    let path = best.path, ok = best.ok;
    if (ok) path = optimize(ctx, path, base, opt.budget);
    else {
      // A head that stops short is tidied too (its clear prefix), not left with hull-corner steps.
      const t = truncate(ctx, path, false);
      path = t.path.length > 2 ? optimize(ctx, t.path, base, opt.budget) : t.path;
    }
    // Exempt features (start / end inside a conservative hull) must still clear exactly.
    let status = ok ? "ok" : "blocked";
    const hit = (ctx.exempt.size || ctx.endExempt.size) ? pathHit(ctx, path, true) : null;
    if (hit) {
      // Leaving a too-tight start cannot be fixed by walking: report it. Otherwise stop short.
      if (hit.seg === 0 && ctx.exempt.has(hit.f)) status = "violation";
      else { path = truncate(ctx, path, true).path; status = "blocked"; ok = false; }
    }
    return {path, ok:ok && status === "ok", status, side:ok ? sideOf(path) : 0};
  }
  // Which side of its chord a path bends to: the sign of the area between them (0: straight).
  function sideOf(pts) {
    const o = pts[0], L = dist(o, pts[pts.length - 1]);
    let a = 0;
    for (let i = 1; i < pts.length; i++) a += (pts[i - 1][0] - o[0]) * (pts[i][1] - o[1]) - (pts[i][0] - o[0]) * (pts[i - 1][1] - o[1]);
    return Math.abs(a) <= 1e-3 * Math.max(L, 1e-3) ? 0 : Math.sign(a);
  }

  // ---------------------------------------------------------------- push and shove
  function segmentProvider(lines, hw, net, clrOf, K, deadline) {
    // Obstacles: capsules of the pusher lines, inflated by the shoved copper's clearance + half width.
    const segs = [];
    for (const L of lines) {
      const inf = L.hw + clrOf(L.net, net) + hw;
      const p = L.pts;
      if (p.length === 1) segs.push([p[0][0], p[0][1], p[0][0], p[0][1], inf]);
      for (let i = 1; i < p.length; i++) segs.push([p[i - 1][0], p[i - 1][1], p[i][0], p[i][1], inf]);
    }
    // Inflated boxes reject most segment pairs before the exact distance.
    const box = new Float64Array(segs.length * 4);
    segs.forEach((g, s) => { box[4 * s] = Math.min(g[0], g[2]) - g[4]; box[4 * s + 1] = Math.min(g[1], g[3]) - g[4]; box[4 * s + 2] = Math.max(g[0], g[2]) + g[4]; box[4 * s + 3] = Math.max(g[1], g[3]) + g[4]; });
    const hulls = new Map();
    return {
      segs,
      seg: 0,
      first(pts, from = 0) {
        for (let i = from + 1; i < pts.length; i++) {
          const a = pts[i - 1], b = pts[i], xa = Math.min(a[0], b[0]), xb = Math.max(a[0], b[0]), ya = Math.min(a[1], b[1]), yb = Math.max(a[1], b[1]);
          let best = -1, bestD = Infinity;
          for (let s = 0; s < segs.length; s++) {
            if (box[4 * s] > xb || box[4 * s + 2] < xa || box[4 * s + 1] > yb || box[4 * s + 3] < ya) continue;
            const g = segs[s];
            if (Math.sqrt(segSeg2(a[0], a[1], b[0], b[1], g[0], g[1], g[2], g[3])) >= g[4] - TOL) continue;
            const d = Math.sqrt(pt2(a[0], a[1], g[0], g[1], g[2], g[3]));
            if (d < bestD) { bestD = d; best = s; }
          }
          if (best >= 0) { this.seg = i - 1; return best; }
        }
        return -1;
      },
      hull: s => { let H = hulls.get(s); if (!H) { const g = segs[s]; H = capsuleHull(g[0], g[1], g[2], g[3], g[4] + PAD, K); hulls.set(s, H); } return H; },
      onStart: () => false, onEnd: () => false, deadline: () => deadline
    };
  }
  // True when p lies inside the region swept between polyline a and polyline b (same end points).
  function sweptContains(a, b, p) {
    const na = a.length, n = na + b.length, at = i => i < na ? a[i] : b[n - 1 - i];
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const u = at(i), v = at(j);
      if ((u[1] > p[1]) !== (v[1] > p[1]) && p[0] < (v[0] - u[0]) * (p[1] - u[1]) / (v[1] - u[1]) + u[0]) inside = !inside;
    }
    return inside;
  }
  // Walks a shoved line around the pushers (the shorter way per hull, else both fixed senses);
  // keeps the shorter result whose swept region holds none of the pins.
  function shoveLine(prov, pts0, pins) {
    const src = pts0.map(q => [q[0], q[1]]);
    let best = null, bestLen = Infinity, timeout = false;
    // The shorter-boundary walk is usually right; both fixed senses only when it is not.
    for (const policy of [0, 1, 2]) {
      if (policy === 1 && best) break;
      const r = walk(prov, src, policy, 64);
      if (r.timeout) { timeout = true; break; }
      if (!r.ok) continue;
      const path = simplify(r.path);
      let bad = false;
      for (const p of pins) if (sweptContains(pts0, path, p)) { bad = true; break; }
      if (bad) continue;
      const len = pathLength(path);
      if (len < bestLen - 1e-9) { best = path; bestLen = len; }
    }
    return best ? {ok:true, path:best} : {ok:false, timeout};
  }
  // Shortcuts a shoved line with 45° (or the line's own angle) connectors: removes the steps the
  // hull corners leave. A shortcut must clear the pushers, fixed copper and copper already shoved
  // (untouched movable copper is shoved next, as the walked line would have done).
  function tidyShoved(W, sc, pts, hw, net, li, self, prov, clrOf, maxClr, deadline, locked) {
    if (pts.length < 4) return pts;
    const reach = hw + maxClr + 0.05;
    const clear = v => {
      if (prov.first(v) >= 0) return false;
      for (let i = 1; i < v.length; i++) {
        const a = v[i - 1], b = v[i], m = candidates(W, a[0], a[1], b[0], b[1], reach, li, li), qb = W.qb;
        for (let j = 0; j < m; j++) {
          const f = qb[j], o = W.own[f], n = W.net[f];
          if (o === self || n >= 0 && n === net) continue;
          if (o >= 0) { const rec = W.owners[o]; if (rec.movable && !sc.mods.has(o) && !locked?.has(rec.id)) continue; }
          if (fdist(W, f, a[0], a[1], b[0], b[1]) < hw + clrOf(net, n) - TOL) return false;
        }
      }
      return true;
    };
    // Small shortcuts only: they remove hull-corner steps but never slide a jog along the line or
    // pull a flank away from the pusher it hugs.
    return shortcut(pts, isOctilinear(pts, 1e-6) ? "45" : "any", 60, deadline, clear, (2 * hw + maxClr) * (2 * hw + maxClr) * 0.5);
  }
  // Differential pairs on the world's board, by net id (AtriumDiffPair, when loaded): net -> partner.
  function pairsOf(W) {
    if (W.pairs !== undefined) return W.pairs;
    let m = null;
    try {
      for (const p of globalThis.AtriumDiffPair?.pairs?.(W.board || {items:[]}) || []) {
        const a = W.netIds.get(p.positive), b = W.netIds.get(p.negative);
        if (a === undefined || b === undefined) continue;
        m ||= new Map();
        m.set(a, {partner:b, P:p.positive, N:p.negative, name:p.name}); m.set(b, {partner:a, P:p.positive, N:p.negative, name:p.name});
      }
    } catch { m = null; }
    return W.pairs = m;
  }
  // Shoves other-net tracks and vias out of the way of `heads`. Mutates the scene.
  function shove(_unused, ctx, heads, budget) {
    const W = ctx.W, sc = W.scene, rules = ctx.rules, deadline = Math.min(ctx.deadline, now() + budget.ms);
    const pairCache = new Map();
    const clrOf = (a, b) => {
      if (a === b && a >= 0) return 0;
      const k = (a + NET0) * 1048576 + (b + NET0); let v = pairCache.get(k);
      if (v === undefined) {
        if (a === OUTLINE || b === OUTLINE) v = rules.edgeClearance(W.netName(a === OUTLINE ? b : a));
        else if (a === KEEPOUT || b === KEEPOUT) v = 0;
        else {
          v = rules.clearance(W.netName(a), W.netName(b), ctx.layer);
          // The two traces of a differential pair keep at least their gap when shoved apart or together.
          const q = a >= 0 && b >= 0 ? pairsOf(W)?.get(a) : null;
          if (q && q.partner === b) { try { const g = rules.diffPair(q.P, q.N, q.name, ctx.layer).gap; if (g > v) v = g; } catch { /* clearance only */ } }
        }
        pairCache.set(k, v);
      }
      return v;
    };
    for (const h of heads) sc.addLine(h.pts, h.hw, h.lo, h.hi, h.net);
    const queue = heads.map(h => ({...h, owner:-1, rank:-Infinity}));
    let shoves = 0;
    const fail = (why, o) => ({ok:false, why, owner:o});
    const attached = new Map();
    // Rank: how close an owner's original copper is to the route. Shoves only go outward: copper
    // never pushes copper that started nearer the route (that copper pushes it instead), so
    // a bus keeps its order and nests around the route rather than piling up.
    // Copper the route crosses wraps around its tip: the crossing farthest from the tip is innermost.
    const ranks = new Map(), pending = new Map(), tipLine = heads[0].pts, tipLen = pathLength(tipLine);
    const rankOf = o => {
      let v = ranks.get(o);
      if (v === undefined) {
        v = Infinity;
        const rec = W.owners[o];
        for (let f = rec.first; f < rec.first + rec.count; f++) for (const h of heads) {
          const p = h.pts;
          let along = 0;
          for (let i = p.length === 1 ? 0 : 1; i < p.length; i++) {
            const a = p[i === 0 ? 0 : i - 1], b = p[i], L = dist(a, b);
            let d = fdist(W, f, a[0], a[1], b[0], b[1]) - h.hw;
            if (W.kind[f] === 0 && L > 0 && segSeg2(a[0], a[1], b[0], b[1], W.ax[f], W.ay[f], W.bx[f], W.by[f]) === 0) {
              const rx = b[0] - a[0], ry = b[1] - a[1], sx = W.bx[f] - W.ax[f], sy = W.by[f] - W.ay[f], den = rx * sy - ry * sx;
              const t = Math.abs(den) > 1e-14 ? Math.max(0, Math.min(1, ((W.ax[f] - a[0]) * sy - (W.ay[f] - a[1]) * sx) / den)) : 0.5;
              d = -1e6 - (p === tipLine ? tipLen - along - t * L : tipLen + 1);
            }
            if (d < v) v = d;
            along += L;
          }
        }
        ranks.set(o, v);
      }
      return v;
    };
    const enqueue = item => { item.rank = rankOf(item.owner); pending.set(item.owner, item); queue.push(item); };
    const later = [];
    for (let qi = 0; ; qi++) {
      if (qi === queue.length) { if (!later.length) break; queue.push(...later); later.length = 0; }
      const P = queue[qi];
      // Copper shoved again since this entry was queued pushes from its newer entry.
      if (P.owner >= 0 && (sc.mods.get(P.owner) || null) !== P.g) continue;
      if (P.owner >= 0 && pending.get(P.owner) === P) pending.delete(P.owner);
      // Distinct colliding owners of this pusher.
      if (++W.ostampV >= 0xfffffff0) { W.ostamp.fill(0); W.ostampV = 1; }
      if (W.ostamp.length < W.owners.length) W.ostamp = new Uint32Array(W.owners.length * 2);
      const hitOwners = [];
      const reach = P.hw + ctx.maxClr + 0.5;
      for (let i = P.pts.length === 1 ? 0 : 1; i < P.pts.length; i++) {
        const a = P.pts[i === 0 ? 0 : i - 1], b = P.pts[i];
        const m = candidates(W, a[0], a[1], b[0], b[1], reach, P.lo, P.hi, P.pts.length === 1 ? "via" : "track"), qb = W.qb;
        for (let j = 0; j < m; j++) {
          const f = qb[j], o = W.own[f], n = W.net[f];
          if (o === P.owner) continue;
          if (n >= 0 && (n === P.net || n === P.net2)) continue;
          if (o >= 0 && W.ostamp[o] === W.ostampV) continue;
          const req = P.hw + clrOf(P.net, n);
          if (fdist(W, f, a[0], a[1], b[0], b[1]) >= req - TOL) continue;
          if (o < 0) { if (P.owner >= 0) return fail("route", -1); continue; }
          W.ostamp[o] = W.ostampV; hitOwners.push(o);
        }
      }
      // Nearest copper first: the cascade from it usually moves the rest (a bus nests in one pass
      // instead of every track piling onto the route); this pusher checks again at the end.
      if (hitOwners.length > 1) hitOwners.sort((x, y) => rankOf(x) - rankOf(y));
      let tier = Infinity, deferred = false;
      for (const o of hitOwners) {
        const rec = W.owners[o];
        if (!rec.movable || budget.locked?.has(rec.id)) return fail("immovable", o);
        if (P.owner >= 0 && rankOf(o) < P.rank - 1e-9) {
          // Nearer the route: it pushes this pusher outward instead (once per geometry).
          const g0 = sc.mods.get(o) || null, q = pending.get(o);
          if (!q || q.g !== g0) {
            const cur = sc.geometry(o), li = cur.kind === "track" ? layerIndex(cur.layer) : 0;
            if (++shoves > budget.shoves || now() > deadline) return fail("budget", o);
            enqueue(cur.kind === "track" ? {pts:cur.points, hw:cur.width / 2, net:rec.net, net2:-99, lo:li, hi:li, owner:o, g:g0}
              : {pts:[[cur.x, cur.y]], hw:cur.shoveRadius ?? cur.diameter / 2, net:rec.net, net2:-99, lo:cur.lo, hi:cur.hi, owner:o, g:g0});
          }
          continue;
        }
        if (tier === Infinity) tier = rankOf(o) + 0.05;
        else if (rankOf(o) > tier) { deferred = true; continue; }
        if (++shoves > budget.shoves || now() > deadline) return fail("budget", o);
        const g = sc.geometry(o);
        if (rec.kind === "via") {
          // The shove proposal accounts for the largest land; the scene keeps individual copper rows.
          let x = g.x, y = g.y; const r = g.shoveRadius ?? g.diameter / 2, need = P.hw + clrOf(P.net, rec.net) + r;
          let moved = false;
          for (let it = 0; it < 8; it++) {
            let worst = 0, qx = 0, qy = 0, sx = 0, sy = 0;
            for (let i = P.pts.length === 1 ? 0 : 1; i < P.pts.length; i++) {
              const a = P.pts[i === 0 ? 0 : i - 1], b = P.pts[i];
              const d = Math.sqrt(pt2(x, y, a[0], a[1], b[0], b[1]));
              if (need - d > worst) {
                worst = need - d;
                const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
                let t = l > 0 ? ((x - a[0]) * dx + (y - a[1]) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
                qx = a[0] + dx * t; qy = a[1] + dy * t; sx = -dy; sy = dx;
              }
            }
            if (worst <= TOL) break;
            let ux = x - qx, uy = y - qy, ul = Math.hypot(ux, uy);
            if (ul < 1e-9) { ul = Math.hypot(sx, sy) || 1; ux = sx; uy = sy; }
            x = qx + ux / ul * (need + PAD); y = qy + uy / ul * (need + PAD); moved = true;
          }
          if (!moved) continue;
          const ng = {...g, x, y};
          // Drag the tracks that end on the via.
          const drags = [];
          const m = candidates(W, g.x, g.y, g.x, g.y, 1e-3, g.lo, g.hi), qb = W.qb;
          for (let j = 0; j < m; j++) {
            const f = qb[j], t = W.own[f];
            if (t < 0 || t === o || W.net[f] !== rec.net || W.owners[t].kind !== "track" || drags.includes(t)) continue;
            if (rec.viaLands && !rec.viaLands.some(q => q.lo <= W.lo[f] && W.lo[f] <= q.hi)) continue;
            const tg = sc.geometry(t); if (!tg) continue;
            const p = tg.points, s0 = Math.hypot(p[0][0] - g.x, p[0][1] - g.y) < 1e-4, s1 = Math.hypot(p[p.length - 1][0] - g.x, p[p.length - 1][1] - g.y) < 1e-4;
            if (s0 || s1) drags.push(t);
          }
          sc.set(o, ng);
          enqueue({pts:[[x, y]], hw:r, net:rec.net, net2:-99, lo:g.lo, hi:g.hi, owner:o, g:ng});
          for (const t of drags) {
            const trec = W.owners[t];
            if (!trec.movable) return fail("immovable", t);
            const tg = sc.geometry(t);
            let p = tg.points.map(q => [q[0], q[1]]);
            const atStart = Math.hypot(p[0][0] - g.x, p[0][1] - g.y) < 1e-4;
            if (!atStart) p.reverse();
            const next = p.length > 1 ? p[1] : p[0];
            const jog = connector([x, y], next, "45", false), alt = connector([x, y], next, "45", true);
            p = simplify([...(jog.length <= alt.length ? jog : alt), ...p.slice(2)]);
            if (!atStart) p.reverse();
            const ntg = {...tg, points:p};
            sc.set(t, ntg); attached.set(t, true);
            const li = layerIndex(ntg.layer);
            enqueue({pts:p, hw:ntg.width / 2, net:trec.net, net2:-99, lo:li, hi:li, owner:t, g:ntg});
          }
          continue;
        }
        // Track: walk its polyline around the pusher (and the route), endpoints fixed. The shoved
        // copper may not wrap around a pusher's fixed ends: the route's start (its tip is free) or
        // either end of a shoved track (KiCad's shove direction check). The result is tidied (no
        // sawtooth from hull corners).
        const lines = P.owner < 0 ? heads : [P, ...heads];
        const prov = segmentProvider(lines, g.width / 2, rec.net, clrOf, ctx.dirs === 4 ? 4 : 8, deadline);
        const pins = [];
        for (const L of lines) if (L.pts.length > 1) { pins.push(L.pts[0]); if (L.owner >= 0) pins.push(L.pts[L.pts.length - 1]); }
        const r = shoveLine(prov, g.points, pins);
        if (!r.ok) return fail(r.timeout ? "budget" : "stuck", o);
        const li = layerIndex(g.layer);
        const pts = tidyShoved(W, sc, r.path, g.width / 2, rec.net, li, o, prov, clrOf, ctx.maxClr, deadline, budget.locked);
        const ng = {...g, points:pts};
        sc.set(o, ng);
        enqueue({pts, hw:g.width / 2, net:rec.net, net2:-99, lo:li, hi:li, owner:o, g:ng});
      }
      if (deferred) later.push(P);
    }
    // The shove cascade proposes displacements with a cheap net-pair cost. Audit the
    // actual displaced objects against scoped rules before exposing a legal preview.
    if (rules.physical) {
      for (const h of [...heads,...[...sc.mods].map(([owner,g]) => g.kind === "track"
        ? {pts:g.points,hw:g.width/2,net:g.net,lo:layerIndex(g.layer),owner}
        : {pts:[[g.x,g.y]],hw:g.shoveRadius??g.diameter/2,net:g.net,lo:g.lo,hi:g.hi,owner})]) {
        const netName = W.netName(h.net);
        const ok = h.pts.length === 1 ? viaClear(W,rules,h.net,netName,h.pts[0],h.hw,h.lo,h.hi,false)
          : check(W,rules,{net:netName,layer:layerName(h.lo),width:h.hw*2,points:h.pts}).ok;
        if (!ok) return fail("clearance",h.owner);
      }
    }
    return {ok:true, shoves};
  }

  // ---------------------------------------------------------------- world cache
  const worlds = new WeakMap();
  function worldFor(board, defs, o = {}) {
    if (o.world) return o.world;
    const journal = globalThis.AtriumUndoStore, host = globalThis.AtriumNavHost, holes = !!rulesFor(board, o.rules, o.project, defs).holes;
    if (host?.doc?.() === board && host.drag?.()?.before) return buildWorld(board, defs, holes);
    const v = journal?.documentVersions?.(board, o.project || undefined, true), c = worlds.get(board);
    if (c && c.defs === defs && c.W.holes === holes && c.items === board.items) {
      if (v && c.v && c.v.floor === v.floor && c.v.library === v.library && c.v.outer === v.outer && c.v.pours === v.pours) {
        let clean = c.v.items === v.items;
        if (!clean && c.W.retired < Math.max(128, c.W.nBuilt / 4)) {
          const ordered = journal.orderedItemChanges(board, c.v.seq, id => c.W.itemOwners.has(id));
          if (ordered) {
            const {change} = ordered;
            updateWorld(c.W, {remove: [...change.ids], add: [...change.items.values()]}, defs);
            clean = true;
          }
        }
        if (clean) { c.v = v; c.count = board.items.length; c.revision = o.revision; c.W.scene.reset(); return c.W; }
      } else if (!v && o.revision != null && c.revision === o.revision && c.count === board.items.length) {
        c.W.scene.reset(); return c.W;
      }
    }
    const W = buildWorld(board, defs, holes);
    worlds.set(board, {W, defs, v, revision:o.revision, items:board.items, count:board.items.length});
    return W;
  }
  function invalidate(board) { worlds.delete(board); }
  // Applies an edit plan to a world without rebuilding it (used by headless batch routing).
  function updateWorld(W, plan, defs) {
    W.scene.reset();
    const from = W.n;
    const kill = id => {
      const range = W.itemOwners.get(id); if (!range) return;
      for (let i = range[0]; i < range[1]; i++) {
        const rec = W.owners[i];
        for (let f = rec.first; f < rec.first + rec.count; f++) W.dead[f] |= 1;
        W.retired += rec.count;
      }
      W.itemOwners.delete(id); W.ownerById.delete(id);
    };
    for (const id of plan.remove || []) kill(id);
    for (const m of plan.modify || []) {
      const o = W.ownerById.get(m.id); if (o == null) continue;
      const it = {...W.owners[o].item, ...m};
      kill(m.id); addBoardItem(W, it, defs);
    }
    for (const it of plan.add || []) addBoardItem(W, it, defs);
    const grid = W.grid;
    let outside = false;
    for (let f = from; f < W.n && !outside; f++) outside = W.x0[f] < grid.ox || W.y0[f] < grid.oy || W.x1[f] > grid.ox + grid.nx * grid.cs || W.y1[f] > grid.oy + grid.ny * grid.cs;
    if (outside) { W.extra.clear(); buildGrid(W); W.nPersist = W.nBuilt = W.n; }
    else persistFeatures(W, from);
    W.hullEpoch = (W.hullEpoch || 0) + 1;
  }
  // Applies an edit plan to the board items (call inside one undoable edit).
  function apply(board, plan) {
    const byId = plan.modify?.length ? new Map(board.items.map((it, i) => [it.id, i])) : null;
    for (const m of plan.modify || []) {
      const i = byId.get(m.id); if (i == null) continue;
      const it = board.items[i];
      for (const k of Object.keys(m)) if (k !== "id") it[k] = Array.isArray(m[k]) ? m[k].map(p => Array.isArray(p) ? [...p] : p) : m[k];
    }
    if (plan.remove?.length) { const gone = new Set(plan.remove); board.items = board.items.filter(it => !gone.has(it.id)); }
    for (const it of plan.add || []) board.items.push(it);
    return board;
  }

  // ---------------------------------------------------------------- presets
  const STD_WIDTHS = [0.1, 0.127, 0.15, 0.2, 0.254, 0.3, 0.381, 0.5, 0.635, 0.8, 1.0, 1.27, 1.5, 2.0];
  const STD_VIAS = [[0.4, 0.2], [0.45, 0.2], [0.5, 0.25], [0.6, 0.3], [0.7, 0.35], [0.8, 0.4], [1.0, 0.5], [1.2, 0.6]];
  function presets(board, net, layer = "Top", opts = {}) {
    const R = rulesFor(board, opts.rules, opts.project, opts.defs), w = R.width(net, layer), v = R.via(opts.nets || net);
    const widths = [...new Set([w.min, w.preferred, w.max, ...STD_WIDTHS].filter(x => finite(x) && x >= w.min - 1e-9 && x <= Math.min(w.max, 10) + 1e-9).map(x => +x.toFixed(4)))].sort((a, b) => a - b);
    const vias = v.legal ? [{diameter:v.diameter, drill:v.drill, preferred:true}] : [];
    for (const [d, h] of STD_VIAS) {
      if (!R.via(opts.nets || net,{diameter:d,drill:h}).legal) continue;
      if (!vias.some(x => Math.abs(x.diameter - d) < 1e-9 && Math.abs(x.drill - h) < 1e-9)) vias.push({diameter:d, drill:h});
    }
    vias.sort((a, b) => a.diameter - b.diameter || a.drill - b.drill);
    return {widths, preferredWidth:w.preferred, minWidth:w.min, maxWidth:w.max, vias, preferredVia:{diameter:v.diameter, drill:v.drill}};
  }

  // ---------------------------------------------------------------- interactive session
  // Copper of the routed net containing p (for auto-termination).
  function sameNetAt(W, net, layerI, p, exclude) {
    if (net < 0) return null;
    const m = candidates(W, p[0], p[1], p[0], p[1], 1e-6, layerI, layerI), qb = W.qb;
    for (let i = 0; i < m; i++) {
      const f = qb[i];
      if (W.net[f] !== net || W.own[f] < 0 || (exclude && exclude.has(W.own[f]))) continue;
      if (fdist(W, f, p[0], p[1], p[0], p[1]) <= 1e-6) return {owner:W.own[f], kind:W.owners[W.own[f]]?.kind || "route", id:W.owners[W.own[f]]?.id};
    }
    return null;
  }
  function begin(board, defs, o = {}) {
    if (!board || board.kind && board.kind !== "pcb") throw Error("Open a PCB layout to route.");
    const W = worldFor(board, defs, o), rules = rulesFor(board, o.rules, o.project, defs);
    W.scene.reset();
    const net = o.net || "";
    let layer = o.layer || "Top";
    if (layerIndex(layer) < 0) throw Error("Choose a copper layer to route on.");
    const start = [o.start[0], o.start[1]];
    if (!rules.allowsLayer(net, layer, start)) throw Error(layerDenial(layer));
    const corner0 = rules.corners(net);
    const widthOverride = finite(o.width), viaOverride = finite(o.viaStyle?.diameter);
    const st = {
      mode:MODES.includes(o.mode) ? o.mode : "walkaround",
      corner:CORNERS.includes(o.corner) ? o.corner : corner0.style || "45",
      bend:!!o.bend,
      widthOverride, width:widthOverride ? o.width : rules.width(net, layer, start).preferred,
      viaOverride, via:viaOverride ? {...o.viaStyle} : (() => { const v = rules.via(net); return {diameter:v.diameter, drill:v.drill}; })(),
      arcRadius:finite(o.arcRadius) ? o.arcRadius : finite(corner0.radius) && corner0.radius > 0 ? corner0.radius : null,
      legs:[{layer, width:0, points:[start]}], vias:[], undo:[], base:new Map(), last:null, cursor:null,
      pushMs:finite(o.pushBudgetMs) ? o.pushBudgetMs : 5, moveMs:finite(o.moveBudgetMs) ? o.moveBudgetMs : 6, maxShoves:o.maxShoves || 48,
      halos:o.halos !== false, locked:new Set(o.locked || []),
      neckDown:o.neckDown !== false, neckWidth:finite(o.neckWidth) && o.neckWidth > 0 ? o.neckWidth : null, necks:new Map()
    };
    st.legs[0].width = st.width;
    const netId = W.netIds.has(net) ? W.netIds.get(net) : net ? 1e9 : NONET;
    let ctx = null;
    function context() {
      const leg = st.legs[st.legs.length - 1];
      if (!ctx || ctx.layer !== leg.layer || ctx.hw !== st.width / 2 || ctx.base !== baseCorner(st.corner) || ctx.epoch !== W.hullEpoch) {
        const keep = ctx && ctx.layer === leg.layer ? ctx.exempt : null;
        ctx = makeContext(W, rules, {layer:leg.layer, hw:st.width / 2, net:netId, netName:net, base:baseCorner(st.corner), dirs:{"45":8, "90":4, any:16}[baseCorner(st.corner)]});
        ctx.epoch = W.hullEpoch;
        if (keep) ctx.exempt = keep;
      }
      return ctx;
    }
    // Rebuilds the scene: committed shoves and the anchored route on every layer.
    function restoreScene() {
      const sc = W.scene; sc.reset();
      for (const [o, g] of st.base) sc.set(o, g);
    }
    const legEnd = () => { const l = st.legs[st.legs.length - 1]; return l.points[l.points.length - 1]; };
    // A layer change or via that does not fit leaves the session exactly as it was.
    const saveState = () => ({legs:st.legs.map(l => ({...l, points:l.points.slice()})), vias:st.vias.length, undo:st.undo.length, base:st.base, last:st.last});
    function restoreState(s) { st.legs = s.legs; st.vias.length = s.vias; st.undo.length = s.undo; st.base = s.base; st.last = s.last; ctx = null; }
    function anchoredLines(layerI) {
      const lines = [];
      for (const l of st.legs) if (layerIndex(l.layer) === layerI && l.points.length > 1) lines.push({pts:l.points, hw:l.width / 2, net:netId, net2:-99, lo:layerI, hi:layerI});
      for (const v of st.vias) if (v.lo <= layerI && v.hi >= layerI) lines.push({pts:[[v.x, v.y]], hw:v.diameter / 2, net:netId, net2:-99, lo:v.lo, hi:v.hi});
      return lines;
    }
    // Neck-down into pads (Altium): a head that stops short of a same-net pad because its width does
    // not fit between the pad's neighbours finishes at the Width rule's minimum, for a short way.
    function neckDown(c, path, p) {
      const e = path[path.length - 1];
      if (!st.neckDown || dist(e, p) < 1e-6) return null;
      const tgt = sameNetAt(W, netId, c.li, p, null);
      if (!tgt || W.owners[tgt.owner]?.kind !== "pad") return null;
      const rw = rules.width(net, c.layer, p);
      let w = st.neckWidth;
      if (w == null) w = rw.ruled ? rw.min : null;
      if (!(w > 0 && w < st.width - 1e-9)) return null;
      const key = c.layer + "|" + w + "|" + c.base;
      let nc = st.necks.get(key);
      if (!nc || nc.epoch !== W.hullEpoch) { nc = makeContext(W, rules, {layer:c.layer, hw:w / 2, net:netId, netName:net, base:c.base, dirs:c.dirs}); nc.epoch = W.hullEpoch; st.necks.set(key, nc); }
      nc.exempt = new Set(); nc.deadline = Math.max(c.deadline, now() + 1); nc.checks = 0;
      const r = walkaround(nc, e, p, st.bend, {budget:24});
      const q = r.path[r.path.length - 1];
      // One neck-down length per end (rules.js neckLength), the impedance checks' budget.
      if (!r.ok || dist(q, p) > 1e-6 || pathLength(r.path) > (rw.neck ?? 2.5)) return null;
      return {path:r.path, width:w};
    }
    // Side hysteresis: the head keeps going round obstacles the way it went last frame (from the
    // same anchor) unless the other way is clearly shorter.
    const slack = finite(o.sideSlack) ? Math.max(0, o.sideSlack) : SIDE_SLACK;
    const sticky = a => slack && st.side && st.sideAt === a ? {side:st.side, slack:slack * (st.width + context().clr[NONET + NET0])} : {};
    const keepSide = (a, r) => { if (r.ok && r.side) { st.side = r.side; st.sideAt = a; } };
    function compute(p) {
      const t0 = now(), c = context(), a = legEnd();
      c.deadline = t0 + st.moveMs; c.checks = 0;
      restoreScene();
      const base = baseCorner(st.corner), direct = connector(a, p, base, st.bend);
      let path = direct, status = "ok", pushed = false, fallback = false;
      const tryPush = () => {
        const li = c.li, heads = [{pts:direct, hw:c.hw, net:netId, net2:-99, lo:li, hi:li}, ...anchoredLines(li)];
        // Fails (and restores the scene) when the head itself hits immovable copper.
        const r = shove(null, c, heads, {ms:st.pushMs, shoves:st.maxShoves, locked:st.locked});
        if (r.ok) return true;
        restoreScene(); return false;
      };
      if (st.mode === "ignore") {
        path = direct;
        if (pathHit(c, direct, true)) status = "violation";
      } else if (st.mode === "stop") {
        const t = truncate(c, direct, true); path = t.path; status = t.clipped ? "blocked" : "ok";
      } else if (st.mode === "push") {
        if (pathHit(c, direct, true)) {
          if (tryPush()) { pushed = true; status = "pushed"; }
          else { const r = walkaround(c, a, p, st.bend, sticky(a)); path = r.path; status = r.status; fallback = true; keepSide(a, r); }
        }
      } else if (st.mode === "hug") {
        const r = walkaround(c, a, p, st.bend, sticky(a));
        path = r.path; status = r.status; keepSide(a, r);
        const detour = pathLength(r.path) > 1.4 * pathLength(direct) + 0.5;
        if ((!r.ok || detour) && pathHit(c, direct, true) && tryPush()) { path = direct; pushed = true; status = "pushed"; }
      } else {
        const r = walkaround(c, a, p, st.bend, sticky(a)); path = r.path; status = r.status; keepSide(a, r);
      }
      // Corner arcs, vetoed per corner where they would cut into a clearance.
      if (hasArc(st.corner) && path.length > 2 && st.mode !== "ignore") {
        const R = st.arcRadius || Math.max(0.25, 2.5 * st.width);
        path = fillet(path, R, pts => pathClear(c, pts));
      } else if (hasArc(st.corner) && path.length > 2) path = fillet(path, st.arcRadius || Math.max(0.25, 2.5 * st.width), null);
      const neck = st.mode !== "ignore" && st.mode !== "stop" ? neckDown(c, path, p) : null;
      if (neck) status = "ok";
      const end = neck ? p : path[path.length - 1];
      const startOwners = new Set(), sAt = sameNetAt(W, netId, c.li, path[0], null); if (sAt) startOwners.add(sAt.owner);
      const reached = (path.length > 1 || neck) && Math.hypot(end[0] - p[0], end[1] - p[1]) < 1e-6 ? sameNetAt(W, netId, c.li, end, startOwners) : null;
      const r = {path, status, pushed, fallback, reached, neck, ms:0, checks:c.checks};
      r.ms = now() - t0;
      return r;
    }
    function result(r) {
      const head = r ? r.path : [legEnd()];
      const preview = [];
      for (let i = 0; i < st.legs.length; i++) {
        const l = st.legs[i];
        if (l.points.length > 1) preview.push({points:l.points, width:l.width, layer:l.layer, net});
      }
      const leg = st.legs[st.legs.length - 1];
      if (head.length > 1) preview.push({points:head, width:st.width, layer:leg.layer, net, head:true});
      if (r && r.neck) preview.push({points:r.neck.path, width:r.neck.width, layer:leg.layer, net, head:true, neck:true});
      const pushedItems = [], hidden = [];
      for (const [o, g] of W.scene.mods) {
        const rec = W.owners[o]; hidden.push(rec.id);
        if (g.kind === "track") pushedItems.push({id:rec.id, kind:"track", points:g.points, width:g.width, layer:g.layer, net:W.netName(g.net)});
        else pushedItems.push({id:rec.id, kind:"via", x:g.x, y:g.y, diameter:g.diameter, drill:rec.item.drill, net:W.netName(g.net)});
      }
      let length = 0; for (const l of st.legs) length += pathLength(l.points);
      const headLength = pathLength(head), neckLength = r && r.neck ? pathLength(r.neck.path) : 0;
      const c = context(), clr = c.clr[NONET + NET0];
      const out = {preview, vias:st.vias.map(v => ({x:v.x, y:v.y, diameter:v.diameter, drill:v.drill, fromLayer:v.fromLayer, toLayer:v.toLayer})),
        pushed:pushedItems, hidden, status:r ? r.status : "ok", reached:!!(r && r.reached), end:r && r.neck ? r.neck.path[r.neck.path.length - 1] : head[head.length - 1],
        length:length + headLength + neckLength, headLength:headLength + neckLength, neck:r && r.neck ? r.neck.width : null, mode:st.mode, modeName:MODE_NAMES[st.mode], corner:st.corner, cornerName:CORNER_NAMES[st.corner],
        layer:leg.layer, width:st.width, via:{...st.via}, ms:r ? r.ms : 0,
        halo:{points:head, width:st.width + 2 * clr, layer:leg.layer}, boundaries:[]};
      if (st.halos && st.cursor) out.boundaries = boundaries(c, head[head.length - 1], Math.max(1.5, 8 * c.hw));
      return out;
    }
    const api = {
      get state() { return {mode:st.mode, corner:st.corner, bend:st.bend, layer:st.legs[st.legs.length - 1].layer, width:st.width, via:{...st.via}, net, arcRadius:st.arcRadius, anchors:st.undo.length}; },
      // route-suggest: anchor — where the next copper starts (last anchored point, its layer) for Route Suggestions.
      anchor() { const l = st.legs[st.legs.length - 1], p = l.points[l.points.length - 1]; return {point:[p[0], p[1]], layer:l.layer, width:st.width, via:{...st.via}, anchors:st.undo.length, start:[st.legs[0].points[0][0], st.legs[0].points[0][1]]}; },
      move(p) {
        // The same point again (pointer moves inside one snap cell) reuses the last result: no work.
        const m = st.memo;
        if (m && m.last === st.last && m.via === st.via && m.gen === W.scene.gen && st.cursor && st.cursor[0] === p[0] && st.cursor[1] === p[1]) return m.out;
        st.cursor = [p[0], p[1]];
        st.last = compute(st.cursor);
        const out = result(st.last);
        st.memo = {last:st.last, via:st.via, gen:W.scene.gen, out};
        return out;
      },
      // Anchors the current head. Returns {done} when it reached same-net copper.
      click() {
        if (!st.last && st.cursor) st.last = compute(st.cursor);
        const r = st.last;
        if (!r || r.status === "violation" && st.mode !== "ignore" || r.path.length < 2 && !r.neck) return {anchored:false, done:false};
        const leg = st.legs[st.legs.length - 1];
        st.undo.push({legs:st.legs.length, points:leg.points.length, vias:st.vias.length, base:new Map(st.base), width:leg.width, layer:leg.layer});
        if (leg.points.length > 1 && Math.abs(leg.width - st.width) > 1e-9) {
          // A width change starts a new track segment on the same layer.
          st.legs.push({layer:leg.layer, width:st.width, points:[leg.points[leg.points.length - 1]]});
        }
        const cur = st.legs[st.legs.length - 1]; cur.width = st.width;
        cur.points = simplify([...cur.points, ...r.path.slice(1)]);
        if (r.neck) st.legs.push({layer:cur.layer, width:r.neck.width, points:r.neck.path.map(q => [q[0], q[1]])});
        st.base = new Map(W.scene.mods);
        st.last = null;
        if (ctx) ctx.exempt = new Set();
        return {anchored:true, done:!!r.reached, reached:r.reached, status:r.status};
      },
      back() {
        const u = st.undo.pop();
        if (!u) return false;
        const layerChanged = st.legs.at(-1).layer !== u.layer;
        st.legs.length = u.legs; const leg = st.legs[st.legs.length - 1];
        leg.points.length = u.points; leg.width = u.width; leg.layer = u.layer;
        if (layerChanged && !st.widthOverride) st.width = u.width;
        st.vias.length = u.vias; st.base = u.base; st.last = null; ctx = null;
        if (st.cursor) st.last = compute(st.cursor);
        return true;
      },
      // Anchors the head and drops a via at its end, then continues on `layer`. Nothing changes when
      // the via does not fit (the head is not anchored). Changing back to the layer just left, with
      // the new via within a via diameter of the last one, takes that via back instead of stacking a
      // second one; a via is never placed within a via diameter of another via of this route.
      switchLayer(next, style) {
        if (layerIndex(next) < 0) return {ok:false, message:"Choose a copper layer."};
        if (next === st.legs[st.legs.length - 1].layer) return {ok:false, message:"Already routing on " + next + "."};
        const saved = saveState();
        if (st.last && st.last.path.length > 1) api.click();
        const leg = st.legs[st.legs.length - 1];
        const at = legEnd(), span = viaSpan(board, leg.layer, next);
        const requested = finite(style?.diameter) ? style : st.viaOverride ? st.via : undefined;
        const {diameter, drill} = rules.via(net, requested, at, [span.lo, span.hi]), v = {diameter, drill};
        // Back off along the anchored leg until the via clears every layer it spans.
        let pos = at, ok = false, legalSize = false, cut = null;
        const pts = leg.points;
        const fits = q => {
          if (!viaFitsSpan(rules, net, v, q, span)) return false;
          legalSize = true;
          return viaClear(W, rules, netId, net, q, v.diameter / 2, span.lo, span.hi, st.mode === "ignore");
        };
        if (fits(pos)) ok = true;
        else if (pts.length > 1) {
          let remain = Math.min(pathLength(pts), 20), seg = pts.length - 1, t = 1, step = Math.max(0.025, v.diameter / 8);
          for (let walked = step; walked <= remain && !ok; walked += step) {
            let d = step;
            while (seg > 0 && d > 0) {
              const a = pts[seg - 1], b = pts[seg], L = dist(a, b) * t;
              if (d <= L) { t -= d / dist(a, b); d = 0; } else { d -= L; seg--; t = 1; }
            }
            if (seg <= 0) break;
            const a = pts[seg - 1], b = pts[seg], q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
            if (fits(q)) { ok = true; pos = q; cut = simplify([...pts.slice(0, seg), q]); }
          }
        }
        const pv = st.vias[st.vias.length - 1], near = o => dist(pos, [o.x, o.y]) < Math.max(o.diameter, v.diameter);
        const back = pv && st.legs.length > 1 && st.legs[st.legs.length - 2].layer === next;
        if (back && (dist(at, [pv.x, pv.y]) < Math.max(pv.diameter, v.diameter) || ok && near(pv))) {
          restoreState(saved);
          const keep = st.vias.length - 1;
          while (st.vias.length > keep && api.back()) {}
          if (st.vias.length > keep) { restoreState(saved); return {ok:false, message:"Can't take the last via back here."}; }
          return {ok:true, layer:st.legs[st.legs.length - 1].layer, removed:true, message:"Via removed; back on " + next + "."};
        }
        if (!ok) {
          restoreState(saved);
          return {ok:false, message:legalSize ? "No room for a via here." : "The via diameter and drill do not meet this span's design rules."};
        }
        if (!rules.allowsLayer(net, next, pos)) { restoreState(saved); return {ok:false, message:layerDenial(next)}; }
        if (st.vias.some(near)) { restoreState(saved); return {ok:false, message:"Too close to another via of this route."}; }
        if (cut) leg.points = cut;
        const moved = dist(at, pos);
        st.undo.push({legs:st.legs.length, points:leg.points.length, vias:st.vias.length, base:new Map(st.base), width:leg.width, layer:leg.layer});
        st.vias.push({x:pos[0], y:pos[1], diameter:v.diameter, drill:v.drill, lo:span.lo, hi:span.hi, fromLayer:span.fromLayer, toLayer:span.toLayer, ...span.parts ? {parts:span.parts} : {}, ...span.extra ? {extra:span.extra} : {}});
        if (!st.widthOverride) st.width = rules.width(net, next, pos).preferred;
        st.legs.push({layer:next, width:st.width, points:[[pos[0], pos[1]]]});
        st.last = null; ctx = null;
        if (st.cursor) st.last = compute(st.cursor);
        return {ok:true, via:{x:pos[0], y:pos[1], diameter:v.diameter, drill:v.drill}, layer:next,
          ...moved > 1e-6 ? {moved, message:"Via moved back " + moved.toFixed(2) + " mm to clear; now on " + next + "."} : {}};
      },
      // Altium "2": anchors the head and drops a via, staying on the current layer. Nothing changes
      // when the via does not fit.
      addVia(style) {
        const saved = saveState();
        if (st.last && st.last.path.length > 1) api.click();
        const leg = st.legs[st.legs.length - 1], at = legEnd(), v = style && finite(style.diameter) ? style : st.via;
        if (!viaClear(W, rules, netId, net, at, v.diameter / 2, 0, 32, st.mode === "ignore")) { restoreState(saved); return {ok:false, message:"No room for a via here."}; }
        if (st.vias.some(o => dist(at, [o.x, o.y]) < Math.max(o.diameter, v.diameter))) { restoreState(saved); return {ok:false, message:"There is already a via here."}; }
        st.undo.push({legs:st.legs.length, points:leg.points.length, vias:st.vias.length, base:new Map(st.base), width:leg.width, layer:leg.layer});
        st.vias.push({x:at[0], y:at[1], diameter:v.diameter, drill:v.drill, lo:0, hi:127});
        st.last = null;
        return {ok:true, via:{x:at[0], y:at[1], diameter:v.diameter, drill:v.drill}};
      },
      // Ctrl+Click auto-complete: routes from the current end to `target` (walkaround
      // with a generous budget, then grid search) and anchors it. Single layer.
      complete(target, opt = {}) {
        if (st.last && st.last.path.length > 1 && st.mode !== "ignore") api.click();
        const leg = st.legs[st.legs.length - 1], from = legEnd(), saveMode = st.mode, saveMs = st.moveMs;
        st.mode = "walkaround"; st.moveMs = opt.budgetMs || 60;
        let r = compute(target);
        st.mode = saveMode; st.moveMs = saveMs;
        let path = r.status === "ok" && Math.hypot(r.path[r.path.length - 1][0] - target[0], r.path[r.path.length - 1][1] - target[1]) < 1e-6 ? r.path : null;
        if (!path || pathLength(path) > 1.25 * dist(from, target) + 2) {
          restoreScene();
          const g = gridRoute(W, rules, {net, from, to:target, layers:[leg.layer], width:st.width, corner:st.corner, keepScene:true, budgetMs:opt.budgetMs || 150});
          if (g.ok && g.legs.length === 1 && (!path || pathLength(g.legs[0].points) < pathLength(path))) path = g.legs[0].points;
        }
        if (!path) { st.last = null; return {ok:false, message:"No route to the target on " + leg.layer + "."}; }
        st.last = {path, status:"ok", reached:sameNetAt(W, netId, layerIndex(leg.layer), target, null)};
        restoreScene();
        return {ok:true, ...api.click()};
      },
      cycleCorner(step = 1) { st.corner = CORNERS[(CORNERS.indexOf(st.corner) + CORNERS.length + step) % CORNERS.length]; st.last = null; return st.corner; },
      toggleBend() { st.bend = !st.bend; st.last = null; return st.bend; },
      cycleMode(step = 1) { st.mode = MODES[(MODES.indexOf(st.mode) + MODES.length + step) % MODES.length]; st.last = null; return st.mode; },
      setMode(m) { if (MODES.includes(m)) { st.mode = m; st.last = null; } return st.mode; },
      setCorner(c) { if (CORNERS.includes(c)) { st.corner = c; st.last = null; } return st.corner; },
      setWidth(w) { if (finite(w) && w > 0) { st.width = w; st.widthOverride = true; st.last = null; } return st.width; },
      setVia(v) { if (v && finite(v.diameter) && v.diameter > 0) { st.via = {diameter:v.diameter, drill:finite(v.drill) ? v.drill : v.diameter / 2}; st.viaOverride = true; } return {...st.via}; },
      setArcRadius(r) { st.arcRadius = finite(r) && r > 0 ? r : null; st.last = null; return st.arcRadius; },
      presets() { return presets(board, net, st.legs[st.legs.length - 1].layer, {rules:o.rules,project:o.project}); },
      // Cycles Shift+W width presets; returns the new width.
      nextWidth(step = 1) { const list = api.presets().widths; let i = list.findIndex(w => w > st.width + 1e-9); if (step < 0) i = list.length - 1 - [...list].reverse().findIndex(w => w < st.width - 1e-9); if (i < 0 || i >= list.length) i = step > 0 ? 0 : list.length - 1; return api.setWidth(list[i]); },
      nextVia(step = 1) { const list = api.presets().vias; if (!list.length) return {...st.via}; let i = list.findIndex(v => Math.abs(v.diameter - st.via.diameter) < 1e-9 && Math.abs(v.drill - st.via.drill) < 1e-9); i = (i + step + list.length) % list.length; return api.setVia(list[i]); },
      // Returns {add, remove, modify}. Pass {head:true} to include the unanchored head.
      commit(opt = {}) {
        if (opt.head && st.last && st.last.path.length > 1) api.click();
        const add = [], idOf = opt.makeId || newId;
        for (const l of st.legs) {
          let pts = simplify(l.points);
          if (pts.length < 2) continue;
          if (opt.gloss !== false && !hasArc(st.corner)) {
            const gctx = makeContext(W, rules, {layer:l.layer, hw:l.width / 2, net:netId, netName:net, base:baseCorner(st.corner), dirs:8});
            gctx.deadline = now() + 20;
            restoreScene();
            pts = optimize(gctx, pts, isOctilinear(pts) ? (baseCorner(st.corner) === "90" && isOrthogonal(pts) ? "90" : "45") : "any", 300);
          }
          add.push({id:idOf(), kind:"track", points:pts.map(p => [round6(p[0]), round6(p[1])]), width:l.width, layer:l.layer, net});
        }
        for (const v of st.vias) add.push(...viaItems(v, idOf, net));
        const modify = [];
        for (const [o, g] of st.base) {
          const rec = W.owners[o];
          if (g.kind === "track") modify.push({id:rec.id, points:g.points.map(p => [round6(p[0]), round6(p[1])])});
          else modify.push({id:rec.id, x:round6(g.x), y:round6(g.y)});
        }
        const remove = opt.removeLoops === false ? [] : loops(W, netId, add.filter(i => i.kind === "track"), new Set(modify.map(m => m.id)));
        W.scene.reset();
        let length = 0; for (const t of add) if (t.points) length += pathLength(t.points);
        return {add, remove, modify, length};
      },
      cancel() { W.scene.reset(); st.last = null; st.legs.length = 1; st.legs[0].points.length = 1; st.vias.length = 0; st.base = new Map(); st.undo.length = 0; },
      world:W
    };
    if (o.cursor) api.move(o.cursor);
    return api;
  }
  const round6 = v => Math.round(v * 1e6) / 1e6;
  // True when every segment is within `tol` radians of a multiple of 45 degrees.
  function isOctilinear(pts, tol = 1e-6) {
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1];
      if (Math.hypot(dx, dy) < 1e-9) continue;
      const a = Math.atan2(dy, dx), q = Math.round(a / (Math.PI / 4)) * (Math.PI / 4);
      if (Math.abs(a - q) > Math.max(tol, 1e-9)) return false;
    }
    return true;
  }
  function isOrthogonal(pts) {
    for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i][0] - pts[i - 1][0]) > 1e-6 && Math.abs(pts[i][1] - pts[i - 1][1]) > 1e-6) return false;
    return true;
  }
  function viaClear(W, rules, netId, net, q, r, lo, hi, ignore) {
    if (ignore) return true;
    if (!insideOutline(W, q[0], q[1])) return false;
    const edge = rules.edgeClearance(net), max = rules.maxClearance?.() ?? Math.max(0,...W.netNames.map(n=>rules.clearance(net,n,layerName(lo))));
    const m = candidates(W, q[0], q[1], q[0], q[1], r + Math.max(edge,max), lo, hi, "via"), qb = W.qb;
    const via = {kind:"via", ck:"via", net, layer:"Multi", span:[lo,hi], diameter:2*r, at:q, box:[q[0]-r,q[1]-r,q[0]+r,q[1]+r]};
    const list = Array.from(qb.subarray(0, m));
    for (const f of list) {
      const n = W.net[f]; if (n >= 0 && n === netId) continue;
      let c;
      if (n === OUTLINE) c = edge;
      else if (n === KEEPOUT) c = 0;
      else if (rules.physical) {
        const other = featureSubject(W,f);
        if (other.net && other.net === net) continue;
        c = rules.physical(via,other) ?? (n === HOLE ? (W.owners[W.own[f]]?.kind === "hole" ? rules.clearance(net,"",layerName(lo)) : -Infinity) : 0);
      } else c = rules.clearance(net, W.netName(n), layerName(Math.max(lo,W.lo[f])));
      if (fdist(W, f, q[0], q[1], q[0], q[1]) < r + c - TOL) return false;
    }
    return true;
  }
  // Same-net tracks made redundant by the new route: both ends touch it, nothing else does.
  function loops(W, netId, added, skip) {
    if (netId < 0 || !added.length) return [];
    const out = [];
    const onRoute = (p, layer) => added.some(t => t.layer === layer && t.points.some((q, i) => i && pt2(p[0], p[1], t.points[i - 1][0], t.points[i - 1][1], q[0], q[1]) < 1e-10));
    const seen = new Set();
    for (const t of added) {
      const li = layerIndex(t.layer);
      for (let i = 1; i < t.points.length; i++) {
        const a = t.points[i - 1], b = t.points[i], m = candidates(W, a[0], a[1], b[0], b[1], 1e-4, li, li), qb = W.qb;
        const list = Array.from(qb.subarray(0, m));
        for (const f of list) {
          const o = W.own[f]; if (o < 0 || seen.has(o) || W.net[f] !== netId) continue; seen.add(o);
          const rec = W.owners[o]; if (rec.kind !== "track" || skip.has(rec.id) || rec.item.locked) continue;
          const p = rec.item.points;
          if (p.length >= 2 && onRoute(p[0], rec.item.layer) && onRoute(p[p.length - 1], rec.item.layer) && Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]) > 1e-6) out.push(rec.id);
        }
      }
    }
    return out;
  }
  // Clearance outlines of copper near p, for the Altium-style boundary display.
  function boundaries(ctx, p, radius) {
    const W = ctx.W, m = candidates(W, p[0], p[1], p[0], p[1], radius, ctx.li, ctx.li), qb = W.qb, out = [];
    for (let i = 0; i < m && out.length < 64; i++) {
      const f = qb[i], req = required(ctx, f);
      if (req < 0 || W.own[f] < 0) continue;
      const grow = req - ctx.hw;
      if (W.kind[f] === 0) out.push({a:[W.ax[f], W.ay[f]], b:[W.bx[f], W.by[f]], r:W.r[f] + grow});
      else { const pts = []; for (let k = 0, o = W.poff[f]; k < W.plen[f]; k++) pts.push([W.pv[o + 2 * k], W.pv[o + 2 * k + 1]]); out.push({points:pts, r:W.r[f] + grow}); }
    }
    return out;
  }

  // ---------------------------------------------------------------- headless routing
  // Point-to-point route on one layer (or several with vias). Walkaround first,
  // then a grid A* fallback; both validated with exact clearance checks.
  function route(board, defs, o = {}) {
    const t0 = now(), W = worldFor(board, defs, o), rules = rulesFor(board, o.rules, o.project, defs);
    const layers = o.layers && o.layers.length ? o.layers : [o.layer || "Top"];
    const net = o.net || "";
    const method = o.method || "auto";
    let r = {status:"skipped", end:o.from};
    let s = null;
    if (method !== "grid") {
      s = begin(board, defs, {...o, world:W, layer:layers[0], start:o.from, mode:o.mode === "ignore" ? "ignore" : "walkaround", corner:o.corner || "45", halos:false, moveBudgetMs:o.walkBudgetMs || 40});
      r = s.move(o.to);
    }
    const arrived = s && Math.hypot(r.end[0] - o.to[0], r.end[1] - o.to[1]) < 1e-6 && (r.status === "ok");
    let walked = null;
    if (arrived) {
      s.click();
      const plan = s.commit({gloss:o.gloss, makeId:o.makeId, removeLoops:o.removeLoops});
      walked = {ok:true, method:"walkaround", plan, points:plan.add[0]?.points || [], length:plan.length, ms:now() - t0};
      // Hull walking is local; a long detour is worth a global grid search.
      const direct = Math.hypot(o.to[0] - o.from[0], o.to[1] - o.from[1]);
      if (method === "walkaround" || o.fallback === false || walked.length <= 1.25 * direct + 2) return walked;
    } else if (s) s.cancel();
    if (!walked && (o.fallback === false || method === "walkaround")) return {ok:false, method:"walkaround", status:r.status, ms:now() - t0};
    const g = gridRoute(W, rules, {...o, layers, net});
    if (!g.ok) return walked ? {...walked, ms:now() - t0} : {ok:false, method:"grid", status:g.status || "blocked", ms:now() - t0};
    if (walked) {
      let gl = 0; for (const leg of g.legs) gl += pathLength(leg.points);
      gl += g.vias.length * 2;
      if (walked.length <= gl) return {...walked, ms:now() - t0};
    }
    const idOf = o.makeId || newId, add = [];
    for (const leg of g.legs) add.push({id:idOf(), kind:"track", points:leg.points.map(p => [round6(p[0]), round6(p[1])]), width:g.width, layer:leg.layer, net});
    for (const v of g.vias) add.push(...viaItems(v, idOf, net));
    let length = 0; for (const t of add) if (t.points) length += pathLength(t.points);
    return {ok:true, method:"grid", plan:{add, remove:[], modify:[]}, points:g.legs.length === 1 ? add[0].points : null, legs:g.legs, vias:g.vias, length, ms:now() - t0};
  }
  // Binary min-heap of numeric priority and nonnegative routing state.
  function routeHeap(capacity = 1024) {
    const initialCapacity = Number.isSafeInteger(capacity) ? Math.max(1, capacity) : 1;
    let priorities = new Float64Array(initialCapacity), states = new Int32Array(initialCapacity);
    let length = 0;

    function push(priority, state) {
      if (length >= priorities.length) {
        const grownPriorities = new Float64Array(priorities.length * 2);
        grownPriorities.set(priorities);
        priorities = grownPriorities;
        const grownStates = new Int32Array(states.length * 2);
        grownStates.set(states);
        states = grownStates;
      }
      let index = length++;
      while (index > 0) {
        const parent = (index - 1) >> 1;
        if (priorities[parent] <= priority) break;
        priorities[index] = priorities[parent];
        states[index] = states[parent];
        index = parent;
      }
      priorities[index] = priority;
      states[index] = state;
    }

    function pop() {
      if (!length) return -1;
      const result = states[0], priority = priorities[--length], state = states[length];
      let index = 0;
      while (true) {
        let child = 2 * index + 1;
        if (child >= length) break;
        if (child + 1 < length && priorities[child + 1] < priorities[child]) child++;
        if (priorities[child] >= priority) break;
        priorities[index] = priorities[child];
        states[index] = states[child];
        index = child;
      }
      priorities[index] = priority;
      states[index] = state;
      return result;
    }

    return {push, pop};
  }

  function gridRoute(W, rules, o) {
    if (!o.keepScene) W.scene.reset();
    const net = o.net || "", netId = W.netIds.has(net) ? W.netIds.get(net) : net ? 1e9 : NONET;
    const layers = o.layers, L = layers.length, width = finite(o.width) ? o.width : rules.width(net, layers[0], o.from).preferred, hw = width / 2;
    const via = rules.via(net,o.viaStyle);
    const ctxs = layers.map(l => makeContext(W, rules, {layer:l, hw, net:netId, netName:net, base:baseCorner(o.corner || "45"), dirs:8}));
    for (const c of ctxs) c.deadline = now() + (o.budgetMs || 250);
    const from = o.from, to = o.to, span = Math.hypot(to[0] - from[0], to[1] - from[1]);
    const margin = finite(o.margin) ? o.margin : Math.max(3, span * 0.5);
    let x0 = Math.min(from[0], to[0]) - margin, y0 = Math.min(from[1], to[1]) - margin, x1 = Math.max(from[0], to[0]) + margin, y1 = Math.max(from[1], to[1]) + margin;
    const maxClr = Math.max(...ctxs.map(c => c.maxClr));
    let pitch = finite(o.pitch) ? o.pitch : Math.min(0.5, Math.max(0.05, (width + maxClr) / 4));
    while (((x1 - x0) / pitch) * ((y1 - y0) / pitch) * L > (o.maxCells || 1.2e6)) pitch *= 1.25;
    const nx = Math.ceil((x1 - x0) / pitch) + 1, ny = Math.ceil((y1 - y0) / pitch) + 1, N = nx * ny;
    const blocked = new Uint8Array(N * L), slack = pitch * Math.SQRT1_2;
    const cellX = i => x0 + (i % nx) * pitch, cellY = i => y0 + Math.floor(i / nx) * pitch;
    function raster(c, li, extra, mask, off) {
      const m = candidates(W, (x0 + x1) / 2, y0, (x0 + x1) / 2, y1, (x1 - x0) / 2 + c.reach + extra, li, li);
      const list = Array.from(W.qb.subarray(0, m));
      for (const f of list) {
        const req = required(c, f); if (req < 0) continue;
        const inf = req + extra + slack - c.hw;
        const cx0 = Math.max(0, Math.floor((W.x0[f] - inf - c.hw - x0) / pitch)), cx1 = Math.min(nx - 1, Math.ceil((W.x1[f] + inf + c.hw - x0) / pitch));
        const cy0 = Math.max(0, Math.floor((W.y0[f] - inf - c.hw - y0) / pitch)), cy1 = Math.min(ny - 1, Math.ceil((W.y1[f] + inf + c.hw - y0) / pitch));
        const lim = req + extra + slack;
        for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
          const k = off + y * nx + x; if (mask[k]) continue;
          const px = x0 + x * pitch, py = y0 + y * pitch;
          if (fdist(W, f, px, py, px, py) < lim) mask[k] = 1;
        }
      }
    }
    for (let l = 0; l < L; l++) raster(ctxs[l], layerIndex(layers[l]), 0, blocked, l * N);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (!insideOutline(W, x0 + x * pitch, y0 + y * pitch)) for (let l = 0; l < L; l++) blocked[l * N + y * nx + x] = 1;
    let viaBlocked = null;
    if (L > 1 && via.legal) {
      viaBlocked = new Uint8Array(N);
      for (let l = 0; l < L; l++) {
        const tmp = new Uint8Array(N);
        raster(ctxs[l], layerIndex(layers[l]), via.diameter / 2 - hw, tmp, 0);
        for (let i = 0; i < N; i++) if (tmp[i]) viaBlocked[i] = 1;
      }
      // No vias in the terminal pads unless asked for.
      if (!o.viaInPad) {
        const rad = via.diameter + Math.max(...ctxs.map(c => c.clr[NONET + NET0]));
        for (const p of [o.from, o.to]) {
          const cx0 = Math.max(0, Math.floor((p[0] - rad - x0) / pitch)), cx1 = Math.min(nx - 1, Math.ceil((p[0] + rad - x0) / pitch));
          const cy0 = Math.max(0, Math.floor((p[1] - rad - y0) / pitch)), cy1 = Math.min(ny - 1, Math.ceil((p[1] + rad - y0) / pitch));
          for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) if (Math.hypot(x0 + x * pitch - p[0], y0 + y * pitch - p[1]) < rad) viaBlocked[y * nx + x] = 1;
        }
      }
    }
    const cellOf = p => Math.max(0, Math.min(ny - 1, Math.round((p[1] - y0) / pitch))) * nx + Math.max(0, Math.min(nx - 1, Math.round((p[0] - x0) / pitch)));
    const sCell = cellOf(from), gCell = cellOf(to);
    // Terminal layers: where the net's copper is at each end (else the requested layers).
    const onCopper = p => [...Array(L).keys()].filter(l => sameNetAt(W, netId, layerIndex(layers[l]), p, null));
    let startLs = o.fromLayer ? [layers.indexOf(o.fromLayer)] : onCopper(from);
    if (!startLs.length || startLs[0] < 0) startLs = [Math.max(0, layers.indexOf(o.layer || layers[0]))];
    let goalLayers = o.toLayer ? [layers.indexOf(o.toLayer)] : onCopper(to);
    if (!goalLayers.length || goalLayers[0] < 0) goalLayers = [...Array(L).keys()];
    // Terminals sit on our own copper, possibly inside a conservative inflation.
    const free = (cell, l) => { blocked[l * N + cell] = 0; };
    for (const l of startLs) free(sCell, l); for (const l of goalLayers) free(gCell, l);
    const S = N * L, g = new Float64Array(S).fill(Infinity), parent = new Int32Array(S).fill(-1), closed = new Uint8Array(S);
    const dirsX = [1, 1, 0, -1, -1, -1, 0, 1], dirsY = [0, 1, 1, 1, 0, -1, -1, -1];
    const ortho = baseCorner(o.corner || "45") === "90";
    const gx = gCell % nx, gy = Math.floor(gCell / nx);
    const h = cell => { const dx = Math.abs(cell % nx - gx), dy = Math.abs(Math.floor(cell / nx) - gy); return pitch * (ortho ? dx + dy : Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy)); };
    const {push, pop} = routeHeap();
    for (const l of startLs) { const s0 = l * N + sCell; g[s0] = 0; push(h(sCell), s0); }
    const viaCost = finite(o.viaCost) ? o.viaCost : 3 + 4 * via.diameter, turn = pitch * 0.4;
    let goal = -1, expanded = 0;
    const deadline = now() + (o.budgetMs || 250) * 4;
    for (let st = pop(); st >= 0; st = pop()) {
      if (closed[st]) continue; closed[st] = 1;
      const l = Math.floor(st / N), cell = st - l * N;
      if (cell === gCell && goalLayers.includes(l)) { goal = st; break; }
      if ((++expanded & 1023) === 0 && now() > deadline) break;
      const cx = cell % nx, cy = (cell - cx) / nx, pst = parent[st];
      let pdir = -1;
      if (pst >= 0) { const pc = pst % N; if (Math.floor(pst / N) === l) { const ddx = cx - pc % nx, ddy = cy - Math.floor(pc / nx); for (let d = 0; d < 8; d++) if (dirsX[d] === Math.sign(ddx) && dirsY[d] === Math.sign(ddy)) pdir = d; } }
      for (let d = 0; d < 8; d++) {
        if (ortho && d % 2) continue;
        const x = cx + dirsX[d], y = cy + dirsY[d]; if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        const nc = y * nx + x, ns = l * N + nc; if (blocked[ns] || closed[ns]) continue;
        if (d % 2 && (blocked[l * N + cy * nx + x] && blocked[l * N + y * nx + cx])) continue;
        const cost = g[st] + pitch * (d % 2 ? Math.SQRT2 : 1) + (pdir >= 0 && pdir !== d ? turn : 0);
        if (cost < g[ns]) { g[ns] = cost; parent[ns] = st; push(cost + h(nc), ns); }
      }
      if (via.legal && viaBlocked && !viaBlocked[cell]) for (let k = 0; k < L; k++) {
        if (k === l) continue; const ns = k * N + cell; if (blocked[ns] || closed[ns]) continue;
        const cost = g[st] + viaCost;
        if (cost < g[ns]) { g[ns] = cost; parent[ns] = st; push(cost + h(cell), ns); }
      }
    }
    if (goal < 0) return {ok:false, status:"no path", expanded};
    const states = []; for (let s = goal; s >= 0; s = parent[s]) states.push(s); states.reverse();
    const legs = [], vias = [];
    let cur = null;
    for (const s of states) {
      const l = Math.floor(s / N), cell = s - l * N, p = [cellX(cell), cellY(cell)];
      if (!cur || cur.l !== l) {
        if (cur) { const q = cur.points[cur.points.length - 1]; const sp = viaSpan(W.board, layers[cur.l], layers[l]); if (!viaFitsSpan(rules,net,via,q,sp)) return {ok:false,status:"No legal via dimensions at this layer change."}; vias.push({x:q[0], y:q[1], diameter:via.diameter, drill:via.drill, ...sp.fromLayer ? {fromLayer:sp.fromLayer, toLayer:sp.toLayer} : {}, ...sp.parts ? {parts:sp.parts} : {}, ...sp.extra ? {extra:sp.extra} : {}}); cur = {l, points:[q]}; legs.push(cur); }
        else { cur = {l, points:[p]}; legs.push(cur); }
        continue;
      }
      cur.points.push(p);
    }
    // Exact terminals replace the snapped cell centres.
    const base = baseCorner(o.corner || "45");
    const first = legs[0], last = legs[legs.length - 1];
    if (first.points.length === 1 && legs.length === 1) first.points = connector([from[0], from[1]], [to[0], to[1]], base, false);
    else {
      first.points = [...connector([from[0], from[1]], first.points[1] || first.points[0], base, false), ...first.points.slice(2)];
      const n = last.points.length;
      last.points = n > 1 ? [...last.points.slice(0, n - 1), ...connector(last.points[n - 2], [to[0], to[1]], base, false).slice(1)] : [...last.points, [to[0], to[1]]];
    }
    const out = [];
    for (const leg of legs) {
      if (simplify(leg.points).length < 2) continue;
      const c = ctxs[leg.l]; c.deadline = now() + 30;
      let pts = simplify(leg.points);
      pts = optimize(c, pts, base, 400);
      out.push({layer:layers[leg.l], points:pts});
    }
    // Validate exactly.
    for (const leg of out) {
      const c = ctxs[layers.indexOf(leg.layer)];
      const hit = pathHit(c, leg.points, true);
      if (hit && !(hit.seg === 0 || hit.seg === leg.points.length - 2)) return {ok:false, status:"violation", legs:out};
    }
    return {ok:true, legs:out, vias, width, expanded, pitch};
  }

  // ---------------------------------------------------------------- gloss / retrace
  // Tidies tracks: merges end-to-end pieces, drops redundant vertices and shortcuts
  // wiggles where the clearance allows. Returns an edit plan.
  function gloss(board, defs, o = {}) {
    const W = worldFor(board, defs, o), rules = rulesFor(board, o.rules, o.project, defs);
    W.scene.reset();
    const ids = o.ids ? new Set(o.ids) : null;
    const tracks = board.items.filter(i => i.kind === "track" && Array.isArray(i.points) && i.points.length >= 2 && !i.locked && (!ids || ids.has(i.id)) && (!o.net || i.net === o.net) && (!o.layer || i.layer === o.layer));
    const modify = [], remove = new Set();
    const key = p => Math.round(p[0] * 1e5) + "," + Math.round(p[1] * 1e5);
    // Merge pairs of tracks that meet end to end where nothing else connects.
    const work = new Map(tracks.map(t => [t.id, {t, points:t.points.map(p => [p[0], p[1]])}]));
    if (o.merge !== false) {
      const ends = new Map();
      const all = board.items.filter(i => i.kind === "track" && i.points?.length >= 2);
      for (const t of all) for (const p of [t.points[0], t.points[t.points.length - 1]]) { const k = t.layer + "|" + key(p); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(t); }
      for (const [k, list] of ends) {
        if (list.length !== 2) continue;
        const [a, b] = list; if (a === b || a.net !== b.net || Math.abs(a.width - b.width) > 1e-9 || !work.has(a.id) || !work.has(b.id) || remove.has(a.id) || remove.has(b.id)) continue;
        const p = k.slice(k.indexOf("|") + 1).split(",").map(n => n / 1e5), li = layerIndex(a.layer);
        // A pad, via or other copper at the junction keeps the pieces separate.
        const m = candidates(W, p[0], p[1], p[0], p[1], 1e-4, li, li), qb = W.qb; let other = false;
        for (let i = 0; i < m; i++) { const rec = W.owners[W.own[qb[i]]]; if (rec && rec.item !== a && rec.item !== b && fdist(W, qb[i], p[0], p[1], p[0], p[1]) <= 1e-6) { other = true; break; } }
        if (other) continue;
        const wa = work.get(a.id), wb = work.get(b.id);
        let pa = wa.points, pb = wb.points;
        if (key(pa[0]) === key(p)) pa = pa.slice().reverse();
        if (key(pb[pb.length - 1]) === key(p)) pb = pb.slice().reverse();
        wa.points = [...pa, ...pb.slice(1)];
        work.delete(b.id); remove.add(b.id);
        // Later merges at b's far end now refer to a.
        for (const l2 of ends.values()) for (let i = 0; i < l2.length; i++) if (l2[i] === b) l2[i] = a;
      }
    }
    for (const {t, points} of work.values()) {
      let pts = simplify(points);
      if (o.shortcut !== false && pts.length > 2) {
        const nid = W.netIds.has(t.net) ? W.netIds.get(t.net) : t.net ? 1e9 : NONET;
        const c = makeContext(W, rules, {layer:t.layer, hw:t.width / 2, net:nid, netName:t.net || "", dirs:8});
        c.deadline = now() + (o.budgetMs || 20);
        const style = o.corner ? baseCorner(o.corner) : isOctilinear(pts, 0.01) ? (isOrthogonal(pts) ? "90" : "45") : "any";
        pts = optimize(c, pts, style, 300);
      }
      const changed = pts.length !== t.points.length || pts.some((p, i) => Math.abs(p[0] - t.points[i][0]) > 1e-9 || Math.abs(p[1] - t.points[i][1]) > 1e-9);
      if (changed) modify.push({id:t.id, points:pts.map(p => [round6(p[0]), round6(p[1])])});
    }
    return {add:[], remove:[...remove], modify};
  }
  // Re-applies the current width and clearance rules to tracks, rerouting each
  // vertex-to-vertex leg around obstacles. Returns an edit plan.
  function retrace(board, defs, o = {}) {
    const W = worldFor(board, defs, o), rules = rulesFor(board, o.rules, o.project, defs);
    const ids = new Set(o.ids || []), modify = [], failed = [];
    for (const t of board.items) {
      if (t.kind !== "track" || !ids.has(t.id) || t.locked) continue;
      const width = finite(o.width) ? o.width : rules.width(t.net || "", t.layer, t.points?.[0]).preferred;
      const nid = W.netIds.has(t.net) ? W.netIds.get(t.net) : t.net ? 1e9 : NONET;
      // Ignore the track's own copper while rerouting it.
      W.scene.reset();
      const own = W.ownerById.get(t.id);
      if (own != null) W.scene.set(own, {kind:"track", points:[t.points[0]], width:0, layer:t.layer, net:W.owners[own].net});
      const c = makeContext(W, rules, {layer:t.layer, hw:width / 2, net:nid, netName:t.net || "", dirs:8, base:isOctilinear(t.points) ? "45" : "any"});
      let pts = [t.points[0]], ok = true;
      for (let i = 1; i < t.points.length; i++) {
        c.deadline = now() + 20;
        const r = walkaround(c, pts[pts.length - 1], t.points[i], false);
        if (!r.ok) { ok = false; break; }
        pts = simplify([...pts, ...r.path.slice(1)]);
      }
      if (!ok) { failed.push(t.id); continue; }
      c.deadline = now() + 20;
      pts = optimize(c, pts, c.base, 200);
      modify.push({id:t.id, points:pts.map(p => [round6(p[0]), round6(p[1])]), width});
    }
    W.scene.reset();
    return {add:[], remove:[], modify, failed};
  }

  // Exact clearance audit of arbitrary polylines (used by tests and the diff-pair engine).
  function check(W, rules, line) {
    const nid = W.netIds.has(line.net) ? W.netIds.get(line.net) : line.net ? 1e9 : NONET;
    const c = makeContext(W, rules, {layer:line.layer, hw:line.width / 2, net:nid, netName:line.net || "", net2:line.net2 != null ? (W.netIds.get(line.net2) ?? 1e9) : -99, net2Name:line.net2});
    let worst = Infinity, at = null;
    for (let i = 1; i < line.points.length; i++) {
      const a = line.points[i - 1], b = line.points[i], m = candidates(W, a[0], a[1], b[0], b[1], c.reach, c.li, c.li);
      const list = Array.from(W.qb.subarray(0, m));
      querySegment(c,a[0],a[1],b[0],b[1]);
      for (const f of list) {
        const req = required(c, f); if (req < 0 || W.own[f] < 0) continue;
        const slackV = fdist(W, f, a[0], a[1], b[0], b[1]) - req;
        if (slackV < worst) { worst = slackV; at = {seg:i - 1, owner:W.owners[W.own[f]]?.id ?? null}; }
      }
    }
    return {ok:worst >= -TOL, slack:worst, at};
  }

  // ---------------------------------------------------------------- drag re-route
  // While parts (or vias, pads, tracks) are dragged, every track that ends on a moving
  // pad is re-routed from the pad's new position to its first fixed anchor (a via, a
  // junction, or the first vertex beyond `reach`) by walkaround, inside a per-move budget.
  // Tracks with both ends on moving copper translate rigidly. Connections over the
  // limit, or whose walkaround fails, rubber-band their pad segment instead.
  const DRAG_STATUS = {routed:"Re-routed", rubber:"Rubber-banded", rigid:"Moved with parts", locked:"Locked (left in place)", violation:"Re-routed with a clearance violation"};
  function dragSession(board, defs, partIds, o = {}) {
    if (!board || board.kind && board.kind !== "pcb") throw Error("Open a PCB layout to drag components.");
    if (o && !Array.isArray(partIds) && !(partIds instanceof Set) && typeof partIds === "object" && partIds) { o = partIds; partIds = o.ids || []; }
    const t0 = now(), W = worldFor(board, defs, o), rules = rulesFor(board, o.rules, o.project, defs);
    const ids = new Set(partIds || []);
    let enabled = o.enabled !== false, maxConn = finite(o.maxConnections) ? Math.max(0, o.maxConnections | 0) : 16;
    const budget = finite(o.budgetMs) ? Math.max(0.5, o.budgetMs) : 4, reach0 = finite(o.reach) ? o.reach : 2;
    W.scene.reset(); W.n = W.nPersist;
    const pn0 = W.pn, killed = [], movingSet = new Set(), moving = [];
    for (let k = 0; k < W.owners.length; k++) {
      const rec = W.owners[k];
      if (!rec || rec.id == null || !ids.has(rec.id) || !rec.count || rec.kind === "outline" || (W.dead[rec.first] & 1)) continue;
      movingSet.add(k); moving.push(k);
    }
    // Tracks touching a moving pad or via of their own net, keyed by owner.
    const touched = new Map(), tol = 1e-4;
    for (const mo of moving) {
      const rec = W.owners[mo];
      if ((rec.kind !== "pad" && rec.kind !== "via") || rec.net < 0) continue;
      for (let f = rec.first; f < rec.first + rec.count; f++) {
        const cx = (W.x0[f] + W.x1[f]) / 2, cy = (W.y0[f] + W.y1[f]) / 2, rad = Math.hypot(W.x1[f] - W.x0[f], W.y1[f] - W.y0[f]) / 2 + 0.01;
        const m = candidates(W, cx, cy, cx, cy, rad, W.lo[f], W.hi[f]), list = Array.from(W.qb.subarray(0, m));
        for (const g of list) {
          const to = W.own[g]; if (to < 0 || movingSet.has(to)) continue;
          const tr = W.owners[to]; if (!tr || tr.kind !== "track" || tr.net !== rec.net || W.net[f] !== rec.net) continue;
          const pts = tr.item.points; if (!pts || pts.length < 2) continue;
          let t = touched.get(to); if (!t) touched.set(to, t = {owner:to, item:tr.item, ends:[false, false], pads:[null, null]});
          for (const e of [0, 1]) { const p = pts[e ? pts.length - 1 : 0]; if (!t.ends[e] && fdist(W, f, p[0], p[1], p[0], p[1]) <= tol) { t.ends[e] = true; if (rec.parent && rec.item) t.pads[e] = {part:rec.parent.id, number:rec.item.number}; } }
        }
      }
    }
    const conns = [], rigid = [], locked = [];
    const fixedAt = (p, li, net, self) => {
      const m = candidates(W, p[0], p[1], p[0], p[1], 1e-3, li, li);
      for (let i = 0; i < m; i++) {
        const g = W.qb[i], to = W.own[g];
        if (to < 0 || to === self || movingSet.has(to) || W.net[g] !== net) continue;
        if (fdist(W, g, p[0], p[1], p[0], p[1]) <= tol) return true;
      }
      return false;
    };
    for (const t of touched.values()) {
      if (!t.ends[0] && !t.ends[1]) continue;
      const it = t.item, rec = W.owners[t.owner];
      if (it.locked) { locked.push(it.id); continue; }
      if (t.ends[0] && t.ends[1]) { rigid.push(t.owner); continue; }
      const pts = (t.ends[0] ? it.points : it.points.slice().reverse()).map(p => [p[0], p[1]]), n = pts.length;
      const cum = new Float64Array(n), li = layerIndex(it.layer), fixed = new Uint8Array(n);
      for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + dist(pts[i - 1], pts[i]);
      for (let i = 1; i < n - 1; i++) fixed[i] = fixedAt(pts[i], li, rec.net, t.owner) ? 1 : 0;
      fixed[n - 1] = 1;
      const base = isOctilinear(pts) ? (isOrthogonal(pts) ? "90" : "45") : "any";
      conns.push({owner:t.owner, item:it, id:it.id, reversed:!t.ends[0], pad:t.pads[t.ends[0] ? 0 : 1], pts, cum, fixed, li, layer:it.layer, hw:(it.width || 0) / 2, width:it.width || 0,
        net:rec.net, netName:it.net || "", base, ctx:null, status:"rubber", now:pts});
    }
    for (const c of conns) for (let f = W.owners[c.owner].first, e = f + W.owners[c.owner].count; f < e; f++) { W.dead[f] |= 4; killed.push(f); }
    const shiftOwners = [...moving, ...rigid];
    for (const k of shiftOwners) for (let f = W.owners[k].first, e = f + W.owners[k].count; f < e; f++) if (!(W.dead[f] & 1)) { W.dead[f] |= 4; killed.push(f); }
    const shiftFeats = killed.filter(f => movingSet.has(W.own[f]) || rigid.includes(W.own[f]));
    function resetTransient() { W.scene.reset(); W.n = W.nPersist; W.pn = pn0; }
    function copyFeature(f, dx, dy) {
      if (W.kind[f] === 0) addCapsule(W, W.own[f], W.ax[f] + dx, W.ay[f] + dy, W.bx[f] + dx, W.by[f] + dy, W.r[f], W.lo[f], W.hi[f], W.net[f]);
      else {
        const pts = []; for (let i = 0, off = W.poff[f]; i < W.plen[f]; i++) pts.push([W.pv[off + 2 * i] + dx, W.pv[off + 2 * i + 1] + dy]);
        addPolygon(W, W.own[f], pts, W.r[f], W.lo[f], W.hi[f], W.net[f]);
      }
    }
    const setupMs = now() - t0;
    let last = null, alive = true;
    function anchorOf(c, reach) {
      for (let i = 1; i < c.pts.length; i++) if (c.fixed[i] || c.cum[i] >= reach) return i;
      return c.pts.length - 1;
    }
    function move(delta) {
      if (!alive) throw Error("This drag session has ended.");
      const dx = finite(delta?.[0]) ? delta[0] : 0, dy = finite(delta?.[1]) ? delta[1] : 0;
      if (last && last.dx === dx && last.dy === dy) return last.out;
      const t1 = now();
      resetTransient();
      for (const f of shiftFeats) copyFeature(f, dx, dy);
      W.scene.dirty = true;
      const reach = Math.max(reach0, 1.5 * Math.hypot(dx, dy)), sc = W.scene;
      // Every connection starts rubber-banded; the nearest ones (up to the limit) are routed.
      const order = conns.map(c => { c.k = anchorOf(c, reach); c.start = [c.pts[0][0] + dx, c.pts[0][1] + dy]; c.status = "rubber"; return c; });
      order.sort((a, b) => dist(a.start, a.pts[a.k]) - dist(b.start, b.pts[b.k]));
      const routeN = enabled ? Math.min(maxConn, order.length) : 0;
      for (let i = 0; i < order.length; i++) {
        const c = order[i];
        if (i < routeN) { const rem = c.pts.slice(c.k); if (rem.length > 1) sc.addLine(rem, c.hw, c.li, c.li, c.net); }
        else { c.now = simplify([c.start, ...c.pts.slice(1)]); sc.addLine(c.now, c.hw, c.li, c.li, c.net); }
      }
      for (let i = 0; i < routeN; i++) {
        const c = order[i], left = budget - (now() - t1);
        if (!c.ctx || c.ctx.epoch !== W.hullEpoch) { c.ctx = makeContext(W, rules, {layer:c.layer, hw:c.hw, net:c.net, netName:c.netName, base:c.base, dirs:{"45":8, "90":4, any:16}[c.base]}); c.ctx.epoch = W.hullEpoch; }
        const ctx = c.ctx;
        ctx.exempt = new Set(); ctx.endExempt.clear(); ctx.checks = 0;
        ctx.deadline = now() + Math.max(0.05, left / (routeN - i));
        const target = c.pts[c.k];
        let path = null;
        if (left > 0.05) {
          const r = walkaround(ctx, c.start, target, false, {iterations:32, budget:24});
          if (r.ok || r.status === "violation") { path = r.path; c.status = r.ok ? "routed" : "violation"; }
        }
        let head;
        if (path && dist(path[path.length - 1], target) < 1e-6) { head = path; c.now = simplify([...path, ...c.pts.slice(c.k + 1)]); }
        else { c.status = "rubber"; head = [c.start, ...c.pts.slice(1, c.k + 1)]; c.now = simplify([c.start, ...c.pts.slice(1)]); }
        if (head.length > 1) sc.addLine(head, c.hw, c.li, c.li, c.net);
      }
      const out = result(dx, dy, t1);
      last = {dx, dy, out};
      return out;
    }
    function result(dx, dy, t1) {
      const pushed = [], hidden = [], modify = [];
      const pts6 = pts => pts.map(p => [round6(p[0]), round6(p[1])]);
      let routed = 0, rubber = 0, bad = 0;
      for (const c of conns) {
        const pts = c.reversed ? c.now.slice().reverse() : c.now;
        pushed.push({id:c.id, kind:"track", points:pts, width:c.width, layer:c.layer, net:c.netName, status:c.status});
        hidden.push(c.id);
        modify.push({id:c.id, points:pts6(pts)});
        if (c.status === "routed") routed++; else if (c.status === "violation") { routed++; bad++; } else rubber++;
      }
      for (const k of rigid) {
        const it = W.owners[k].item, pts = rigidFrom.get(k).map(p => [p[0] + dx, p[1] + dy]);
        pushed.push({id:it.id, kind:"track", points:pts, width:it.width, layer:it.layer, net:it.net || "", status:"rigid"});
        hidden.push(it.id); modify.push({id:it.id, points:pts6(pts)});
      }
      // The moved objects themselves, so the plan also stands on its own (headless use).
      const seen = new Set();
      for (const k of moving) {
        const rec = W.owners[k], it = rec.parent || rec.item;
        if (!it || seen.has(it.id)) continue; seen.add(it.id);
        if (Array.isArray(it.points)) { const from = trackFrom.get(it.id); if (from) modify.push({id:it.id, points:pts6(from.map(p => [p[0] + dx, p[1] + dy]))}); }
        else if (finite(it.x)) modify.push({id:it.id, x:round6(origin.get(it.id)[0] + dx), y:round6(origin.get(it.id)[1] + dy)});
      }
      const ms = now() - t1;
      const status = bad ? "violation" : rubber && enabled && routed < Math.min(maxConn, conns.length) ? "partial" : "ok";
      const parts = [];
      if (!enabled) parts.push("Drag re-route off");
      if (routed) parts.push(routed + " re-routed");
      if (rubber) parts.push(rubber + " rubber-banded" + (enabled && conns.length > maxConn ? " (limit " + maxConn + ")" : ""));
      if (rigid.length) parts.push(rigid.length + " moved with parts");
      if (locked.length) parts.push(locked.length + " locked");
      if (bad) parts.push(bad + " with violations");
      return {preview:[], pushed, hidden, vias:[], status, mode:"drag", modeName:"Drag re-route", statusName:status === "ok" ? "Re-routed" : status === "partial" ? "Partly re-routed" : "Violation",
        statusText:conns.length || rigid.length ? "Drag re-route · " + parts.join(" · ") + " · " + ms.toFixed(1) + " ms" : "",
        routed, rubber, rigid:rigid.length, locked:locked.slice(), connections:conns.length, ms, setupMs,
        plan:{add:[], remove:[], modify}};
    }
    // Original positions of moved point objects (parts, vias, pads) and track points.
    const origin = new Map();
    for (const k of moving) {
      const rec = W.owners[k], it = rec.parent || rec.item;
      if (!it || origin.has(it.id)) continue;
      origin.set(it.id, finite(it.x) ? [it.x, it.y] : null);
    }
    const trackFrom = new Map(moving.map(k => W.owners[k]).filter(r => !r.parent && Array.isArray(r.item?.points)).map(r => [r.item.id, r.item.points.map(p => [p[0], p[1]])]));
    const rigidFrom = new Map(rigid.map(k => [k, W.owners[k].item.points.map(p => [p[0], p[1]])]));
    function finish() {
      if (!alive) return;
      alive = false; resetTransient();
      for (const f of killed) W.dead[f] &= ~4;
    }
    const api = {
      get state() { return {enabled, maxConnections:maxConn, connections:conns.length, rigid:rigid.length, locked:locked.length, budgetMs:budget, reach:reach0}; },
      // delta: [dx, dy] from the drag start. Returns the preview and the edit plan.
      move,
      setEnabled(v) { enabled = !!v; last = null; return enabled; },
      setMaxConnections(n) { if (finite(n) && n >= 0) { maxConn = n | 0; last = null; } return maxConn; },
      // Returns the edit plan for the last move ({add, remove, modify}) and ends the session.
      commit(delta) {
        const out = delta ? api.move(delta) : last ? last.out : api.move([0, 0]);
        finish();
        const plan = out.plan;
        return {add:plan.add, remove:plan.remove, modify:plan.modify, routed:out.routed, rubber:out.rubber, rigid:out.rigid, status:out.status};
      },
      cancel() { finish(); last = null; },
      // The moved parts changed footprint mid-drag (flipped to the other side): rebuild the
      // session from the drag start on the new geometry. Each re-routed track keeps its pin:
      // its pad end goes to the same pin's new pad while that pad is still on the track's
      // layer; otherwise the track stays where it was (an open the ratsnest shows), never on
      // another pin. Returns the preview at the current offset.
      restart(board2 = board, defs2 = defs) {
        if (!alive) throw Error("This drag session has ended.");
        const delta = last ? [last.dx, last.dy] : [0, 0], byId = new Map(board2.items.map(i => [i.id, i])), saved = [];
        const put = (it, k, v) => { saved.push([it, k, it[k]]); it[k] = v; };
        for (const [id, at] of origin) { const it = byId.get(id); if (it && at) { put(it, "x", at[0]); put(it, "y", at[1]); } }
        for (const [id, pts] of trackFrom) { const it = byId.get(id); if (it) put(it, "points", pts.map(p => [p[0], p[1]])); }
        for (const c of conns) {
          const part = c.pad && byId.get(c.pad.part), pad = part && defs2.get(part.def)?.footprint?.pads?.find(p => String(p.number) === String(c.pad.number));
          if (!pad) continue;
          const layer = pad.layer || (pad.drill > 0 ? "Multi" : part.layer || "Top");
          if (layer !== "Multi" && layer !== c.layer) continue;
          const pts = c.item.points.map(p => [p[0], p[1]]);
          pts[c.reversed ? pts.length - 1 : 0] = globalThis.Atrium.world([pad.x, pad.y], part);
          put(c.item, "points", pts);
        }
        finish(); last = null;
        let next;
        try { next = dragSession(board2, defs2, [...ids], {...o, world:undefined, revision:undefined, enabled, maxConnections:maxConn}); }
        finally { for (let k = saved.length - 1; k >= 0; k--) saved[k][0][saved[k][1]] = saved[k][2]; invalidate(board2); }
        for (const k of ["move", "setEnabled", "setMaxConnections", "commit", "cancel", "restart"]) api[k] = next[k];
        api.world = next.world;
        Object.defineProperty(api, "state", {get:() => next.state, configurable:true, enumerable:true});
        return next.move(delta);
      },
      world:W
    };
    return api;
  }

  // ---------------------------------------------------------------- tabbed routing
  // Capacitive tabs along tracks (Intel-style "tabbed routing"): T-shaped or trapezoid
  // stubs of the track's own net, as plain tracks so they plot as Gerber strokes and
  // DRC treats them as same-net copper. Each tab is clearance-checked; a pair's inner
  // tabs are staggered and clamped to keep the pair's minimum gap.
  function tabs(board, defs, o = {}) {
    const t0 = now(), W = worldFor(board, defs, o), rules = rulesFor(board, o.rules, o.project, defs);
    W.scene.reset(); W.n = W.nPersist;
    const ids = new Set(o.ids || []);
    const tracks = (board.items || []).filter(i => i.kind === "track" && ids.has(i.id) && Array.isArray(i.points) && i.points.length >= 2 && layerIndex(i.layer) >= 0 && i.width > 0);
    const shape = o.shape === "trapezoid" ? "trapezoid" : "T", idOf = o.makeId || newId;
    const side0 = ["left", "right", "both", "inner", "outer", "alternate"].includes(o.side) ? o.side : "inner";
    const add = [], skipped = [], group = o.group === false ? null : o.groupId || "tabs-" + idOf();
    let uncoupledAdded = 0, count = 0;
    // A pair partner for inner/outer sides: the nearest other-net selected track on the layer.
    const partnerOf = t => {
      let best = null, bd = Infinity;
      const DP = globalThis.AtriumDiffPair, pr = DP && t.net ? (() => { try { return DP.find(board, t.net); } catch { return null; } })() : null;
      const want = pr ? (pr.positive === t.net ? pr.negative : pr.positive) : null;
      for (const u of (board.items || [])) {
        if (u.kind !== "track" || u === t || u.layer !== t.layer || !u.points || u.net === t.net) continue;
        if (want ? u.net !== want : !ids.has(u.id)) continue;
        for (let i = 1; i < u.points.length; i++) for (const p of t.points) { const d = Math.sqrt(pt2(p[0], p[1], u.points[i - 1][0], u.points[i - 1][1], u.points[i][0], u.points[i][1])); if (d < bd) { bd = d; best = u; } }
      }
      return best;
    };
    const ctxFor = new Map();
    const context = (t, w) => {
      const k = t.layer + "|" + w + "|" + t.net;
      let c = ctxFor.get(k);
      if (!c) { const nid = W.netIds.has(t.net) ? W.netIds.get(t.net) : t.net ? 1e9 : NONET; c = makeContext(W, rules, {layer:t.layer, hw:w / 2, net:nid, netName:t.net || "", dirs:8}); ctxFor.set(k, c); }
      return c;
    };
    const inBox = p => !o.box || (p[0] >= o.box[0] && p[0] <= o.box[2] && p[1] >= o.box[1] && p[1] <= o.box[3]);
    for (const t of tracks) {
      const w = t.width, partner = side0 === "inner" || side0 === "outer" ? partnerOf(t) : null;
      const pitch = o.pitch > 0 ? o.pitch : Math.max(4 * w, 0.6), tabW = o.tabWidth > 0 ? o.tabWidth : 2 * w;
      const neck = o.neckWidth > 0 ? Math.min(o.neckWidth, tabW) : Math.min(w, tabW), headW = o.headWidth > 0 ? Math.min(o.headWidth, tabW) : Math.min(w, tabW);
      const nid = W.netIds.has(t.net) ? W.netIds.get(t.net) : t.net ? 1e9 : NONET, li = layerIndex(t.layer);
      const pts = t.points, cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]));
      const total = cum[cum.length - 1], win = o.window || [0, total];
      // Inner tabs of a pair's second net sit half a pitch along, between the first net's tabs.
      const stagger = partner && side0 === "inner" && String(t.net) > String(partner.net) ? pitch / 2 : 0;
      const margin = tabW / 2 + w;
      let k = 0;
      for (let s = Math.max(win[0], 0) + (o.offset ?? pitch / 2) + stagger; s <= Math.min(win[1], total) + 1e-9; s += pitch, k++) {
        // Arc traces (tessellated arcs, small turns per vertex) take tabs along the curve.
        const fr = tabFrame(pts, cum, s, margin);
        if (!fr) { skipped.push({track:t.id, at:s, reason:"corner"}); continue; }
        const {c, u} = fr, left = [-u[1], u[0]];
        if (!inBox(c)) continue;
        let sides;
        if (side0 === "left") sides = [1]; else if (side0 === "right") sides = [-1]; else if (side0 === "both") sides = [1, -1];
        else if (side0 === "alternate") sides = [k % 2 ? -1 : 1];
        else {
          if (!partner) { skipped.push({track:t.id, at:s, reason:"no partner"}); continue; }
          let bd = Infinity, sd = 1;
          for (let j = 1; j < partner.points.length; j++) {
            const p = partner.points[j - 1], q = partner.points[j], d = pt2(c[0], c[1], p[0], p[1], q[0], q[1]);
            if (d < bd) { bd = d; const dx = q[0] - p[0], dy = q[1] - p[1], l2 = dx * dx + dy * dy || 1, tt = Math.max(0, Math.min(1, ((c[0] - p[0]) * dx + (c[1] - p[1]) * dy) / l2)); const x = p[0] + dx * tt - c[0], y = p[1] + dy * tt - c[1]; sd = x * left[0] + y * left[1] >= 0 ? 1 : -1; }
          }
          sides = [side0 === "inner" ? sd : -sd];
        }
        for (const sd of sides) {
          const n = [left[0] * sd, left[1] * sd];
          let len = o.tabLength > 0 ? o.tabLength : 1.5 * w;
          if (partner && side0 === "inner") {
            // Keep the pair's minimum gap (and clearance) between a tab and the partner trace.
            const dp = rules.diffPair(t.net, partner.net, "", t.layer), edge = Math.sqrt((() => { let m = Infinity; for (let j = 1; j < partner.points.length; j++) { const p = partner.points[j - 1], q = partner.points[j]; m = Math.min(m, pt2(c[0], c[1], p[0], p[1], q[0], q[1])); } return m; })()) - w / 2 - partner.width / 2;
            const keep = Math.max(dp.minGap || 0, finite(o.minGap) ? o.minGap : 0);
            len = Math.min(len, edge - keep - 1e-4);
            if (!(len > Math.max(headW, neck) * 0.5)) { skipped.push({track:t.id, at:s, reason:"gap"}); continue; }
          }
          const tab = shape === "T" ? tShape(c, u, n, w, len, tabW, neck, headW) : trapezoid(c, u, n, w, len, tabW, o.baseWidth > 0 ? o.baseWidth : Math.max(neck, tabW / 2), o.rowWidth > 0 ? o.rowWidth : Math.min(w, len));
          let clear = true;
          for (const piece of tab) { if (pathHit(context(t, piece.width), piece.points, true)) { clear = false; break; } }
          if (!clear) { skipped.push({track:t.id, at:s, reason:"clearance"}); continue; }
          for (const piece of tab) {
            const item = {id:idOf(), kind:"track", points:piece.points.map(p => [round6(p[0]), round6(p[1])]), width:piece.width, layer:t.layer, net:t.net || ""};
            if (group) item.groupId = group;
            add.push(item);
            W.scene.addLine(piece.points, piece.width / 2, li, li, nid);
          }
          count++;
          if (partner && side0 === "outer") uncoupledAdded += len;
        }
      }
    }
    W.scene.reset(); W.n = W.nPersist;
    return {add, remove:[], modify:[], tabs:count, items:add.length, skipped, uncoupledAdded, groupId:group, ms:now() - t0};
  }
  // Position and tangent at arc length s, or null within `margin` of a track end or a corner.
  // Vertices turning less than `bend` (arc tessellation) are smooth: the tangent is the chord
  // across the tab's own width, so tabs follow arcs.
  function tabFrame(pts, cum, s, margin, bend = 0.35) {
    const total = cum[cum.length - 1];
    if (s < margin || total - s < margin) return null;
    const at = q => { let k = 1; while (k < pts.length - 1 && cum[k] < q) k++; const L = cum[k] - cum[k - 1], f = L > 1e-12 ? (q - cum[k - 1]) / L : 0; return [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * f, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * f]; };
    const turn = k => { const ux = pts[k][0] - pts[k - 1][0], uy = pts[k][1] - pts[k - 1][1], vx = pts[k + 1][0] - pts[k][0], vy = pts[k + 1][1] - pts[k][1], lu = Math.hypot(ux, uy), lv = Math.hypot(vx, vy);
      return lu < 1e-12 || lv < 1e-12 ? 0 : Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv)))); };
    for (let k = 1; k < pts.length - 1; k++) if (cum[k] > s - margin && cum[k] < s + margin && turn(k) >= bend) return null;
    const h = Math.min(margin, 0.5 * margin + 1e-3), p0 = at(Math.max(0, s - h)), p1 = at(Math.min(total, s + h)), l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
    if (!(l > 1e-9)) return null;
    return {c: at(s), u: [(p1[0] - p0[0]) / l, (p1[1] - p0[1]) / l]};
  }
  // T tab: a neck from the track centre out to the head, and a head bar along the track.
  function tShape(c, u, n, w, len, tabW, neck, headW) {
    const h = w / 2 + len - headW / 2, tip = [c[0] + n[0] * h, c[1] + n[1] * h], half = Math.max(0, tabW / 2 - headW / 2);
    const bar = [[tip[0] - u[0] * half, tip[1] - u[1] * half], [tip[0] + u[0] * half, tip[1] + u[1] * half]];
    if (Math.abs(neck - headW) < 1e-9) return [{points:[c, tip, bar[0], bar[1]], width:neck}];
    return [{points:[c, tip], width:neck}, {points:bar, width:headW}];
  }
  // Trapezoid tab filled by a serpentine of overlapping strokes, from baseWidth at the
  // track edge to tabW at the tip (one track per tab).
  function trapezoid(c, u, n, w, len, tabW, baseW, rw) {
    rw = Math.max(1e-3, Math.min(rw, len));
    const h0 = w / 2, h1 = Math.max(h0, w / 2 + len - rw / 2);
    const rows = Math.max(1, Math.ceil((h1 - h0) / (0.7 * rw)));
    const pts = [[c[0], c[1]]];
    for (let r = 0; r <= rows; r++) {
      const h = h0 + (h1 - h0) * r / rows, f = (h - w / 2) / Math.max(1e-9, len - rw / 2), W2 = Math.max(rw, baseW + (tabW - baseW) * Math.max(0, Math.min(1, f)));
      const half = Math.max(0, W2 / 2 - rw / 2), dir = r % 2 ? 1 : -1;
      const m = [c[0] + n[0] * h, c[1] + n[1] * h];
      pts.push([m[0] + u[0] * half * dir, m[1] + u[1] * half * dir], [m[0] - u[0] * half * dir, m[1] - u[1] * half * dir]);
    }
    return [{points:pts.filter((p, i) => !i || dist(p, pts[i - 1]) > 1e-9), width:rw}];
  }

  const core = {routeHeap, viaFitsSpan,layerIndex, layerName, rulesFor, worldFor, buildWorld, makeContext, walkaround, optimize, shove, connector, fillet, simplify, pathLength,
    pathHit, pathClear, segmentHit, segSeg2, truncate, candidates, fdist, required, isOrthogonal, makeContextFor:makeContext, baseCorner, hasArc, sameNetAt, viaSpan, viaClear, boundaries, insideOutline, isOctilinear, round6, NONET, MODES, CORNERS, MODE_NAMES, CORNER_NAMES};
  return Object.freeze({begin, route, gloss, retrace, presets, apply, invalidate, updateWorld, world:worldFor, check, copperLayers, dragSession, tabs,
    modes:MODES.slice(), corners:CORNERS.slice(), modeNames:MODE_NAMES, cornerNames:CORNER_NAMES, dragStatusNames:DRAG_STATUS, core});
})();
