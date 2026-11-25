"use strict";
// Fanout: escape tracks from surface-mount pads to vias, as Altium's
// Auto Route » Fanout and its Fanout Control rule. BGA parts get dog-bone
// fanout with an escape analysis that leaves the outer rings that can escape on
// the top layer without vias and assigns the inner rings to escape layers.
// The result is an edit plan {add, remove, report} for one ctx.edit.
globalThis.AtriumFanout = (() => {
  const A = () => globalThis.Atrium, AR = () => globalThis.AtriumAutorouter;
  const STYLES = [["auto", "Auto"], ["inline", "Inline Rows"], ["staggeredIn", "Staggered In"], ["staggeredOut", "Staggered Out"], ["bga", "BGA (dog-bone)"], ["underPads", "Under Pads"]];
  const DIRECTIONS = [["disable", "Disable"], ["in", "In Only"], ["out", "Out Only"], ["inThenOut", "In Then Out"], ["outThenIn", "Out Then In"], ["alternating", "Alternating In and Out"]];
  const PLACEMENTS = [["close", "Close To Pad (Follow Rules)"], ["centered", "Centered Between Pads"]];
  const EPS = 1e-7;

  // ---------------------------------------------------------------- classification
  // Pads of a part in its own frame and in world coordinates.
  function partPads(part, def) {
    const out = [];
    const AU = AR();
    (def?.footprint?.pads || []).forEach((p, i) => {
      const layer = AU.copperIndex(p.layer || "") >= 0 ? p.layer : p.layer === "Multi" || p.drill > 0 ? "Multi" : part.layer || "Top";
      const net = Object.hasOwn(part.pinNets || {}, p.number) ? part.pinNets[p.number] : p.net || "";
      const shape = AU.padShape(p, part), at = A().world([p.x, p.y], part);
      out.push({i, pad: p, number: String(p.number), layer, smd: !(p.drill > 0) && layer !== "Multi", net, shape, at, lx: p.x, ly: p.y});
    });
    return out;
  }
  const uniq = (vals, tol) => {
    const s = [...vals].sort((a, b) => a - b), out = [];
    for (const v of s) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
    return out;
  };
  const minStep = list => { let m = Infinity; for (let i = 1; i < list.length; i++) m = Math.min(m, list[i] - list[i - 1]); return m; };
  // {kind:"bga"|"qfp"|"soic"|"small"|"other", pitch, sides?, grid?}
  function classify(pads) {
    const smd = pads.filter(p => p.smd);
    if (smd.length < 2) return {kind: "none", pitch: Infinity};
    const xs = uniq(smd.map(p => p.lx), 0.01), ys = uniq(smd.map(p => p.ly), 0.01);
    const x0 = xs[0], x1 = xs[xs.length - 1], y0 = ys[0], y1 = ys[ys.length - 1], cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const interior = smd.filter(p => p.lx > x0 + 0.01 && p.lx < x1 - 0.01 && p.ly > y0 + 0.01 && p.ly < y1 - 0.01).length;
    if (xs.length >= 3 && ys.length >= 3 && interior > 0 && smd.length >= 0.4 * xs.length * ys.length) {
      const pitch = Math.min(minStep(xs), minStep(ys));
      return {kind: "bga", pitch, cx, cy, xs, ys, cols: xs.length, rows: ys.length};
    }
    // perimeter: assign each pad to the nearest side of the pad cloud
    const sides = {left: [], right: [], top: [], bottom: []};
    for (const p of smd) {
      const d = {left: p.lx - x0, right: x1 - p.lx, top: p.ly - y0, bottom: y1 - p.ly};
      // a pad on a vertical side has its long axis along x
      const along = Math.abs(p.pad.w * Math.cos((p.pad.angle || 0) * Math.PI / 180)) >= Math.abs(p.pad.h * Math.cos((p.pad.angle || 0) * Math.PI / 180));
      let side = Object.keys(d).reduce((a, b) => d[a] <= d[b] ? a : b);
      if (x1 - x0 < 0.01) side = p.ly < cy ? "top" : "bottom";
      else if (y1 - y0 < 0.01) side = p.lx < cx ? "left" : "right";
      else if (Math.abs(d.left - d.top) < 0.01 || Math.abs(d.right - d.bottom) < 0.01) side = along ? (p.lx < cx ? "left" : "right") : (p.ly < cy ? "top" : "bottom");
      sides[side].push(p);
    }
    const used = Object.entries(sides).filter(([, v]) => v.length);
    let pitch = Infinity;
    for (const [side, list] of used) {
      const key = side === "left" || side === "right" ? "ly" : "lx";
      list.sort((a, b) => a[key] - b[key]);
      for (let i = 1; i < list.length; i++) pitch = Math.min(pitch, list[i][key] - list[i - 1][key]);
    }
    const kind = smd.length < 6 ? "small" : used.length === 4 ? "qfp" : used.length === 2 && (sides.left.length && sides.right.length || sides.top.length && sides.bottom.length) ? "soic" : "other";
    return {kind, pitch, cx, cy, sides, x0, x1, y0, y1};
  }
  const PACKAGE = {bga: "bga", qfp: "lcc", soic: "soic", small: "small", other: "default"};

  // ---------------------------------------------------------------- legality
  function context(doc, defs, options) {
    const AU = AR(), G = AU.core.geometry;
    // The board's copper layers, plus routing layers the caller names (a board may not use them yet).
    const layers = [...new Set([...AU.boardLayers(doc, defs), ...(options.layers || []).filter(l => AU.copperIndex(l) >= 0)])].sort((a, b) => AU.copperIndex(a) - AU.copperIndex(b));
    const bit = new Map(layers.map((l, i) => [l, 1 << i])), all = (1 << layers.length) - 1;
    const rules = AU.rulesFor(doc, options.project);
    const names = new Set();
    for (const i of doc.items) { if (i.net) names.add(i.net); if (i.kind === "part") for (const n of Object.values(i.pinNets || {})) if (n) names.add(n); }
    const style = AU.netStyle(rules, layers, options, [...names]);
    const cache = new Map();
    const clr = (a, b) => {
      const k = a < b ? a + "\u0000" + b : b + "\u0000" + a;
      if (!cache.has(k)) cache.set(k, Math.max((r => r ? r.routeGap ?? r.gap : undefined)(rules.query("clearance", {net: a, net2: b})) ?? style.baseClr, 0));
      return cache.get(k);
    };
    const b = A().docBounds(doc, defs);
    const index = G.bucketIndex(b[0] - 10, b[1] - 10, b[2] + 10, b[3] + 10, 2);
    AU.eachCopper(doc, defs, o => {
      const lm = AU.copperMask(o.layers, layers, bit, all);
      if (!lm) return;
      index.add({k: o.shape.k, c: o.shape.c, r: o.shape.r, lm, net: o.kind === "keepout" || o.kind === "hole" ? "" : o.net, kind: o.kind, keepout: o.kind === "keepout"});
    });
    const outline = AU.outlineOf(doc, defs);
    const edge = Number.isFinite(options.edgeClearance) ? options.edgeClearance : Math.max(style.baseClr, 0.25);
    const edges = outline ? outline.map((p, i) => ({k: 1, c: [...p, ...outline[(i + 1) % outline.length]], r: 0})) : [];
    const cuts = (globalThis.AtriumBoardShape?.holes?.(doc) || []).filter(h => h.length >= 3).map(h => h.flat());
    for (const f of cuts) for (let i = 0, n = f.length >> 1; i < n; i++) { const j = (i + 1) % n; edges.push({k: 1, c: [f[2 * i], f[2 * i + 1], f[2 * j], f[2 * j + 1]], r: 0}); }
    const flat = outline ? outline.flat() : null;
    // Does a new shape of `net` on layers `lm` keep clearance from everything?
    function clear(S, net, lm) {
      S.bb = G.box(S);
      if (flat) {
        for (let i = 0; i < S.c.length; i += 2) if (!G.inside(S.c[i], S.c[i + 1], flat)) return false;
        for (const e of edges) if (G.shapeDist(S, e) < edge - EPS) return false;
        for (const f of cuts) for (let i = 0; i < S.c.length; i += 2) if (G.inside(S.c[i], S.c[i + 1], f)) return false;
      }
      return !index.query(S.bb, 2, o => {
        if (!(o.lm & lm)) return false;
        if (net && o.net === net && !o.keepout) return false;
        return G.shapeDist(S, o) < clr(net, o.net) - EPS;
      });
    }
    function add(S, net, lm) { index.add({...S, lm, net}); }
    // Same-net track or via already touching this pad: the pad is fanned or routed.
    function touched(shape, net, lm) {
      return index.query(G.box(shape), 0.01, o => (o.kind === "track" || o.kind === "via") && o.net === net && (o.lm & lm) && G.shapeDist(shape, o) <= 1e-6);
    }
    return {layers, bit, all, rules, style, clear, add, touched, clr};
  }

  // ---------------------------------------------------------------- plan
  // options: {components?:[ids], style?, direction?, viaPlacement?, connectedOnly=true,
  //  powerNets=false, minPads=4, escapeOuter=true, auto?:"bga"|"fine", finePitch=0.65, project}
  function plan(doc, defs, options = {}) {
    const At = A(), AU = AR();
    if (!AU) throw Error("Fanout needs the autorouter module.");
    if (doc.kind !== "pcb") throw Error("Choose a PCB layout to fan out.");
    const ctx = context(doc, defs, options);
    const add = [], report = {fanned: 0, vias: 0, tracks: 0, skipped: [], components: []};
    const padCount = new Map();
    for (const i of doc.items) {
      if (i.kind === "part") for (const p of defs.get(i.def)?.footprint?.pads || []) { const n = i.pinNets?.[p.number] ?? p.net ?? ""; if (n) padCount.set(n, (padCount.get(n) || 0) + 1); }
      else if (i.kind === "pad" && i.net) padCount.set(i.net, (padCount.get(i.net) || 0) + 1);
    }
    const classes = ctx.rules.netClasses() || {};
    const powerClass = new Set(Object.entries(classes).filter(([k]) => /power|pwr|supply|gnd|ground/i.test(k)).flatMap(([, v]) => v));
    const isPower = n => AU.POWER.test(n) || powerClass.has(n);
    const wanted = options.components ? new Set(options.components) : null;
    const parts = doc.items.filter(i => i.kind === "part" && (!wanted || wanted.has(i.id)));
    const minPads = options.minPads ?? 4;

    for (const part of parts) {
      const def = defs.get(part.def);
      const pads = partPads(part, def), cl = classify(pads);
      if (cl.kind === "none") continue;
      const smd = pads.filter(p => p.smd);
      if (!wanted && smd.length < minPads) continue;
      if (options.auto && !(cl.kind === "bga" || (options.auto === "fine" && cl.pitch <= (options.finePitch ?? 0.65) && smd.length >= 16))) continue;
      const rule = ctx.rules.query("fanoutControl", {package: PACKAGE[cl.kind], net: smd[0]?.net || ""}) || {};
      let style = options.style || rule.style || "auto", direction = options.direction || rule.direction || "alternating";
      const placement = options.viaPlacement || rule.viaPlacement || "close";
      if (cl.kind === "bga" && (style === "auto" || style === "bga")) style = "bga";
      else if (style === "bga") style = "auto";
      const comp = {ref: part.ref, id: part.id, kind: cl.kind, pitch: cl.pitch, style, direction, placement, fanned: 0, skipped: 0};
      report.components.push(comp);
      if (direction === "disable" && style !== "bga") { comp.note = "Fanout direction is disabled by the rule."; continue; }
      const ang = (part.angle || 0) * Math.PI / 180, cs = Math.cos(ang), sn = Math.sin(ang);
      const toWorld = (vx, vy) => [vx * cs - vy * sn, vx * sn + vy * cs];
      const skip = (p, reason) => { report.skipped.push({ref: part.ref, pad: p.number, net: p.net, reason, at: p.at, id: part.id}); comp.skipped++; };
      // pads in scope
      const eligible = p => {
        if (!p.smd) return false;
        if (options.connectedOnly !== false && (!p.net || (padCount.get(p.net) || 0) < 2)) { if (p.net) skip(p, "Net has no other connections"); return false; }
        if (!p.net) return false;
        if (!options.powerNets && isPower(p.net)) { skip(p, "Power net (enable power nets to fan out to planes)"); return false; }
        const lm = ctx.bit.get(p.layer) || 0;
        if (!lm) { skip(p, "Pad layer is not a routing layer"); return false; }
        if (ctx.touched(p.shape, p.net, lm)) { skip(p, "Already connected"); return false; }
        return true;
      };
      function place(p, via, track) {
        const st = ctx.style(p.net), lm = ctx.bit.get(p.layer);
        if (!st.vias || !ctx.rules.permitsVia(p.net,{diameter:st.vd,drill:st.vh},via)) return false;
        const V = {k: 0, c: via, r: st.vd / 2};
        if (!ctx.clear(V, p.net, ctx.all)) return false;
        let T = null;
        if (track) { T = {k: 1, c: [...p.at, ...via], r: st.w / 2}; if (!ctx.clear(T, p.net, lm)) return false; }
        ctx.add(V, p.net, ctx.all);
        const r = v => Math.round(v * 1e7) / 1e7;
        add.push({id: At.id(), kind: "via", x: r(via[0]), y: r(via[1]), diameter: st.vd, drill: st.vh, layer: "Multi", net: p.net});
        report.vias++;
        if (T) { ctx.add(T, p.net, lm); add.push({id: At.id(), kind: "track", points: [[r(p.at[0]), r(p.at[1])], [r(via[0]), r(via[1])]], width: st.w, layer: p.layer, net: p.net}); report.tracks++; }
        report.fanned++; comp.fanned++;
        return true;
      }

      if (style === "bga") {
        const pitch = cl.pitch, st0 = ctx.style(smd.find(p => p.net)?.net || "");
        const ball = Math.max(...smd.map(p => Math.max(p.pad.w, p.pad.h)));
        const c = ctx.style.baseClr;
        // Escape analysis: tracks that fit between two balls on the top layer and between two vias inside.
        const tTop = Math.max(0, Math.floor((pitch - ball - c + 1e-9) / (st0.w + c)));
        const tVia = Math.max(0, Math.floor((pitch - st0.vd - c + 1e-9) / (st0.w + c)));
        const ringOf = p => {
          const col = cl.xs.findIndex(x => Math.abs(x - p.lx) < 0.01), row = cl.ys.findIndex(y => Math.abs(y - p.ly) < 0.01);
          return Math.min(col, row, cl.cols - 1 - col, cl.rows - 1 - row);
        };
        const rings = Math.ceil(Math.min(cl.cols, cl.rows) / 2);
        const signal = ctx.layers.slice(1);
        const layerFor = k => {
          if (k <= tTop) return ctx.layers[0];
          const idx = Math.floor((k - tTop - 1) / (1 + tVia));
          return signal[idx] || null;
        };
        const escape = {tracksPerChannelTop: tTop, tracksPerChannelInner: tVia, rings: [], fits: true};
        for (let k = 0; k < rings; k++) {
          const members = smd.filter(p => ringOf(p) === k), layer = layerFor(k);
          escape.rings.push({ring: k + 1, balls: members.length, layer: layer || "needs another signal layer", via: k > tTop || options.escapeOuter === false});
          if (!layer) escape.fits = false;
        }
        comp.escape = escape;
        const diag = pitch * Math.SQRT1_2;
        if (diag < st0.vd / 2 + ball / 2 + c - EPS) { comp.note = "The via does not fit between the balls at this pitch."; for (const p of smd) skip(p, "Via too large for the ball pitch"); continue; }
        for (const p of smd) {
          if (!eligible(p)) continue;
          const k = ringOf(p);
          p.escapeLayer = layerFor(k);
          if (options.escapeOuter !== false && k <= tTop) { comp.topEscape = (comp.topEscape || 0) + 1; continue; }
          const st = ctx.style(p.net);
          const dx = p.lx - cl.cx, dy = p.ly - cl.cy;
          const sx = Math.abs(dx) < 1e-6 ? (cl.xs.findIndex(x => Math.abs(x - p.lx) < 0.01) % 2 ? 1 : -1) : Math.sign(dx);
          const sy = Math.abs(dy) < 1e-6 ? (cl.ys.findIndex(y => Math.abs(y - p.ly) < 0.01) % 2 ? 1 : -1) : Math.sign(dy);
          const close = Math.min(diag, p.pad.w / 2 + c + st.vd / 2 + 1e-4);
          const dist = placement === "centered" ? diag : close;
          const quads = [[sx, sy], [sx, -sy], [-sx, sy], [-sx, -sy]];
          let ok = false;
          for (const [qx, qy] of quads) {
            for (const d of dist === diag ? [diag] : [dist, diag]) {
              const v = toWorld(qx * d * Math.SQRT1_2, qy * d * Math.SQRT1_2), via = [p.at[0] + v[0], p.at[1] + v[1]];
              if (place(p, via, true)) { ok = true; break; }
            }
            if (ok) break;
          }
          if (!ok) skip(p, "No legal via position around the ball");
        }
        continue;
      }

      // perimeter parts
      const order = [];
      for (const side of ["left", "bottom", "right", "top"]) for (const [i, p] of (cl.sides?.[side] || []).entries()) order.push({p, side, i});
      if (!order.length) for (const [i, p] of smd.entries()) {
        const dx = p.lx - cl.cx, dy = p.ly - cl.cy;
        order.push({p, side: Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "top" : "bottom"), i});
      }
      const normals = {left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1]};
      for (const {p, side, i} of order) {
        if (!eligible(p)) continue;
        const st = ctx.style(p.net), c = ctx.clr(p.net, "");
        const ln = normals[side], n = toWorld(ln[0], ln[1]);
        // extent of the pad along the local normal
        const pa = (p.pad.angle || 0) * Math.PI / 180, ux = Math.cos(pa), uy = Math.sin(pa);
        const half = Math.abs(p.pad.w / 2 * (ux * ln[0] + uy * ln[1])) + Math.abs(p.pad.h / 2 * (-uy * ln[0] + ux * ln[1]));
        if (style === "underPads") {
          if (!place(p, [...p.at], false)) skip(p, "Via does not fit in the pad");
          continue;
        }
        const pitch = cl.pitch, cvv = c;
        const d1 = half + c + st.vd / 2;
        const rowStep = Math.max(st.vd / 2 + c + st.w / 2, Math.sqrt(Math.max(0, (st.vd + cvv) ** 2 - pitch * pitch)) + 1e-4);
        let dirs;
        if (style === "staggeredIn") dirs = [-1];
        else if (style === "staggeredOut") dirs = [1];
        else dirs = {in: [-1], out: [1], inThenOut: [-1, 1], outThenIn: [1, -1], alternating: i % 2 ? [-1, 1] : [1, -1]}[direction] || [1, -1];
        const effPitch = direction === "alternating" && style !== "staggeredIn" && style !== "staggeredOut" ? 2 * pitch : pitch;
        const stagger = style === "staggeredIn" || style === "staggeredOut" || (style === "auto" && effPitch < st.vd + cvv);
        const rowIndex = direction === "alternating" ? (i >> 1) : i;
        const rows = stagger ? (rowIndex % 2 ? [d1 + rowStep, d1] : [d1, d1 + rowStep]) : [d1];
        let ok = false;
        for (const dir of dirs) {
          for (const r0 of rows) {
            for (let k = 0; k < 6 && !ok; k++) {
              const r = r0 + k * st.vd / 2;
              const via = [p.at[0] + n[0] * dir * r, p.at[1] + n[1] * dir * r];
              if (place(p, via, true)) ok = true;
            }
            if (ok) break;
          }
          if (ok) break;
        }
        if (!ok) skip(p, "No legal via position in the fanout direction");
      }
    }
    return {add, remove: [], report};
  }

  // ---------------------------------------------------------------- fanout v2
  // planV2(doc, defs, options) -> {add, remove:[], report}. The autorouter's engine v2 and the
  // Fanout dialog (engine v2) use it. Differences from plan():
  //   BGA      ring-by-ring escape: the rings that fit through the top-layer channels stay without
  //            vias; deeper rings get a via and an escape layer, two rings per inner layer when one
  //            track fits between vias (report.escape, report.prefLayers net -> layer, which the
  //            router prefers for that net). Dog-bones point outward by quadrant; balls of a
  //            differential pair get mirrored, symmetric dog-bones. Via-in-pad when the board has an
  //            HDI build-up (doc.hdi) or options.viaInPad, as a laser microvia Top -> Inner 1 when the
  //            build-up offers one (filled, IPC-4761 type from doc.hdi). Rings assigned to Inner 1
  //            on an HDI board use microvia dog-bones.
  //   Power    power and ground balls and pads (net classes named power/ground, or POWER names) fan
  //            out to plane vias by default (options.powerNets === false turns that off); an exposed
  //            pad of a QFN/QFP on a power net gets a thermal via array.
  //   Rules    every via and track is checked against the clearance rules, the board edge, cutouts
  //            and hole-to-hole clearance; locked copper is never touched (fanout only adds).
  // options: as plan(), plus {layers?:[names] routing layers, viaInPad?, microvia?, thermal?:true}
  function planV2(doc, defs, options = {}) {
    const At = A(), AU = AR();
    if (!AU) throw Error("Fanout needs the autorouter module.");
    if (doc.kind !== "pcb") throw Error("Choose a PCB layout to fan out.");
    const ctx = context(doc, defs, options);
    const add = [], report = {engine: "v2", fanned: 0, vias: 0, tracks: 0, microvias: 0, viaInPad: 0, powerVias: 0, thermal: 0, skipped: [], components: [], prefLayers: {}};
    const padCount = new Map();
    for (const i of doc.items) {
      if (i.kind === "part") for (const p of defs.get(i.def)?.footprint?.pads || []) { const n = i.pinNets?.[p.number] ?? p.net ?? ""; if (n) padCount.set(n, (padCount.get(n) || 0) + 1); }
      else if (i.kind === "pad" && i.net) padCount.set(i.net, (padCount.get(i.net) || 0) + 1);
    }
    const classes = ctx.rules.netClasses() || {};
    const powerClass = new Set(Object.entries(classes).filter(([k]) => /power|pwr|supply|gnd|ground/i.test(k)).flatMap(([, v]) => v));
    const isPower = n => AU.POWER.test(n) || powerClass.has(n) || (options.power || []).includes(n);
    const powerOn = options.powerNets !== false;
    const routing = (options.layers?.length ? options.layers : ctx.layers).filter(l => ctx.bit.has(l));
    // HDI: via-in-pad and microvias from the board's build-up.
    let hdi = null;
    try { hdi = globalThis.AtriumViaStack?.hdi?.config?.(doc, defs) || null; } catch { hdi = null; }
    const viaInPad = options.viaInPad ?? !!hdi;
    const micro = options.microvia !== false && hdi && hdi.top >= 1 && ctx.layers.length > 2 ? {diameter: hdi.microvia.diameter, drill: hdi.microvia.drill, from: ctx.layers[0], to: ctx.layers[1], ipc: hdi.microvia.ipc4761} : null;
    // Hole-to-hole gap between drilled holes (any net).
    const h2h = (r => r?.gap)(ctx.rules.query("holeToHole", {})) ?? (ctx.rules.available ? 0.254 : 0);
    const holes = [];
    for (const i of doc.items) {
      if (i.kind === "via" && i.drill > 0) holes.push([i.x, i.y, i.drill / 2]);
      else if (i.kind === "part") for (const p of defs.get(i.def)?.footprint?.pads || []) if (p.drill > 0) { const c = At.world([p.x, p.y], i); holes.push([c[0], c[1], p.drill / 2]); }
    }
    const holeOK = (x, y, drill) => !h2h || holes.every(h => Math.hypot(h[0] - x, h[1] - y) >= h[2] + drill / 2 + h2h - EPS);
    const pairs = new Map();
    for (const dp of ctx.rules.diffPairs() || []) { pairs.set(dp.positive, dp.negative); pairs.set(dp.negative, dp.positive); }
    const wanted = options.components ? new Set(options.components) : null;
    const parts = doc.items.filter(i => i.kind === "part" && (!wanted || wanted.has(i.id)));
    const minPads = options.minPads ?? 4;
    const r7 = v => Math.round(v * 1e7) / 1e7;
    const spanMaskOf = (from, to) => {
      const a = AU.copperIndex(from), b = AU.copperIndex(to), lo = Math.min(a, b), hi = Math.max(a, b);
      return ctx.layers.reduce((m, l, i) => { const c = AU.copperIndex(l); return c >= lo && c <= hi ? m | (1 << i) : m; }, 0);
    };
    // HDI microvia chains (AtriumViaStack.hdi.chain): Top to `layer` through laser spans only.
    const HH = globalThis.AtriumViaStack?.hdi;
    const hdiRule = ctx.rules.query("hdiVias", {}) || {};
    const maxStacked = Number.isInteger(hdiRule.maxStacked) ? hdiRule.maxStacked : 2, stagger = Number.isFinite(hdiRule.minStagger) && hdiRule.minStagger > 0 ? hdiRule.minStagger : 0.25;
    const stackingOK = n => hdi?.stacking !== "staggered" && n <= maxStacked;
    function microChain(layer) {
      if (!hdi || !micro || !HH?.chain || layer === ctx.layers[0]) return null;
      try { const list = HH.chain(doc, ctx.layers[0], layer, defs, {config: hdi}); return list?.length && list.every(sp => sp.laser) ? list : null; } catch { return null; }
    }
    // Places a microvia chain from pad p: vias at `at` (stacked) or stepping `dir` by the stagger
    // pitch, joined by short tracks on the shared layers; all or nothing.
    function placeChain(p, list, at, dir, {inPad, stacked, comp}) {
      const st = ctx.style(p.net), keys = hdi.keys, items = [], checks = [];
      const pts = list.map((_, i) => stacked ? at : [at[0] + dir[0] * stagger * i, at[1] + dir[1] * stagger * i]);
      if (!inPad) { const T = {k: 1, c: [...p.at, ...pts[0]], r: st.w / 2}; checks.push([T, ctx.bit.get(p.layer)]); items.push({kind: "track", points: [p.at, pts[0]], width: st.w, layer: p.layer}); }
      list.forEach((sp, i) => {
        const from = keys[sp.lo], to = keys[sp.hi], vlm = spanMaskOf(from, to);
        checks.push([{k: 0, c: pts[i], r: micro.diameter / 2}, vlm, true]);
        items.push({kind: "via", x: pts[i][0], y: pts[i][1], diameter: micro.diameter, drill: micro.drill, fromLayer: from, toLayer: to, microvia: true, ...(micro.ipc && micro.ipc !== "none" ? {ipc4761: micro.ipc} : {}), ...(inPad && i === 0 ? {viaInPad: true} : {})});
        if (i > 0 && !stacked) { const lay = keys[list[i - 1].hi], T = {k: 1, c: [...pts[i - 1], ...pts[i]], r: st.w / 2}; checks.push([T, ctx.bit.get(lay)]); items.push({kind: "track", points: [pts[i - 1], pts[i]], width: st.w, layer: lay}); }
      });
      for (const [S, lm, via] of checks) { if (!lm || !ctx.clear(S, p.net, lm)) return false; if (via && !holeOK(S.c[0], S.c[1], micro.drill)) return false; }
      if (items.some(it => it.kind === "via" && !ctx.rules.permitsVia(p.net,it,[it.x,it.y],[AU.copperIndex(it.fromLayer),AU.copperIndex(it.toLayer)].sort((a,b)=>a-b)))) return false;
      checks.forEach(([S, lm]) => ctx.add(S, p.net, lm));
      for (const it of items) {
        const item = {id: At.id(), ...it, net: p.net};
        if (it.kind === "via") { item.x = r7(it.x); item.y = r7(it.y); holes.push([it.x, it.y, micro.drill / 2]); report.vias++; report.microvias++; if (item.viaInPad) report.viaInPad++; }
        else { item.points = it.points.map(q => [r7(q[0]), r7(q[1])]); report.tracks++; }
        add.push(item);
      }
      report.stacks = (report.stacks || 0) + (stacked ? 1 : 0); report.staggered = (report.staggered || 0) + (stacked ? 0 : 1);
      report.fanned++; if (comp) comp.fanned++;
      return true;
    }
    // Places a via (and its escape track) after exact checks. kind: "through" | "micro"; inPad: via in the pad.
    function place(p, via, {track = true, kind = "through", inPad = false, comp, power = false} = {}) {
      const st = ctx.style(p.net), lm = ctx.bit.get(p.layer);
      const vd = kind === "micro" ? micro.diameter : st.vd, vh = kind === "micro" ? micro.drill : st.vh;
      const span = kind === "micro" ? [AU.copperIndex(micro.from),AU.copperIndex(micro.to)].sort((a,b)=>a-b) : [0,127];
      if (kind !== "micro" && !st.vias || !ctx.rules.permitsVia(p.net,{diameter:vd,drill:vh},via,span)) return false;
      const vlm = kind === "micro" ? spanMaskOf(micro.from, micro.to) : ctx.all;
      if (!holeOK(via[0], via[1], vh)) return false;
      const V = {k: 0, c: via, r: vd / 2};
      if (!ctx.clear(V, p.net, vlm)) return false;
      let T = null;
      if (track && !inPad) { T = {k: 1, c: [...p.at, ...via], r: st.w / 2}; if (!ctx.clear(T, p.net, lm)) return false; }
      ctx.add(V, p.net, vlm);
      holes.push([via[0], via[1], vh / 2]);
      const item = {id: At.id(), kind: "via", x: r7(via[0]), y: r7(via[1]), diameter: vd, drill: vh, layer: "Multi", net: p.net};
      if (kind === "micro") { item.fromLayer = micro.from; item.toLayer = micro.to; item.microvia = true; report.microvias++; }
      if (inPad) { item.viaInPad = true; if (hdi || kind === "micro") item.ipc4761 = micro?.ipc || "VII"; report.viaInPad++; }
      add.push(item);
      report.vias++;
      if (power) report.powerVias++;
      if (T) { ctx.add(T, p.net, lm); add.push({id: At.id(), kind: "track", points: [[r7(p.at[0]), r7(p.at[1])], [r7(via[0]), r7(via[1])]], width: st.w, layer: p.layer, net: p.net}); report.tracks++; }
      report.fanned++; if (comp) comp.fanned++;
      return true;
    }

    for (const part of parts) {
      const def = defs.get(part.def);
      const pads = partPads(part, def), cl = classify(pads);
      if (cl.kind === "none") continue;
      const smd = pads.filter(p => p.smd);
      if (!wanted && smd.length < minPads) continue;
      if (options.auto && !(cl.kind === "bga" || (options.auto === "fine" && cl.pitch <= (options.finePitch ?? 0.65) && smd.length >= 16) || (powerOn && smd.some(p => isPower(p.net) && p.pad.w * p.pad.h > 4)))) continue;
      const rule = ctx.rules.query("fanoutControl", {package: PACKAGE[cl.kind], net: smd[0]?.net || ""}) || {};
      const comp = {ref: part.ref, id: part.id, kind: cl.kind, pitch: cl.pitch, style: cl.kind === "bga" ? "bga" : options.style || rule.style || "auto", fanned: 0, skipped: 0};
      report.components.push(comp);
      const ang = (part.angle || 0) * Math.PI / 180, cs = Math.cos(ang), sn = Math.sin(ang);
      const toWorld = (vx, vy) => [vx * cs - vy * sn, vx * sn + vy * cs];
      const skip = (p, reason) => { report.skipped.push({ref: part.ref, pad: p.number, net: p.net, reason, at: p.at, id: part.id}); comp.skipped++; };
      const eligible = p => {
        if (!p.smd || !p.net) return false;
        if (options.connectedOnly !== false && (padCount.get(p.net) || 0) < 2 && !isPower(p.net)) { skip(p, "Net has no other connections"); return false; }
        if (isPower(p.net) && !powerOn) { skip(p, "Power net (enable power nets to fan out to planes)"); return false; }
        const lm = ctx.bit.get(p.layer) || 0;
        if (!lm) { skip(p, "Pad layer is not a routing layer"); return false; }
        if (ctx.touched(p.shape, p.net, lm)) { skip(p, "Already connected"); return false; }
        return true;
      };
      // Thermal via array in a large exposed pad on a power net.
      const thermal = p => {
        const st = ctx.style(p.net), w = p.pad.w, h = p.pad.h;
        const pitch = Math.max(st.vd + (h2h || ctx.clr(p.net, p.net)) , 1.0), nx = Math.max(1, Math.floor((w - st.vd) / pitch) + 1), ny = Math.max(1, Math.floor((h - st.vd) / pitch) + 1);
        let n = 0;
        for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
          const v = toWorld((i - (nx - 1) / 2) * pitch, (j - (ny - 1) / 2) * pitch);
          if (place(p, [p.at[0] + v[0], p.at[1] + v[1]], {track: false, inPad: true, comp, power: true})) n++;
        }
        report.thermal += n;
        return n > 0;
      };

      if (cl.kind === "bga") {
        const pitch = cl.pitch, st0 = ctx.style(smd.find(p => p.net && !isPower(p.net))?.net || smd.find(p => p.net)?.net || "");
        const ball = Math.max(...smd.map(p => Math.max(p.pad.w, p.pad.h)));
        const c = ctx.style.baseClr;
        const tTop = Math.max(0, Math.floor((pitch - ball - c + 1e-9) / (st0.w + c)));
        const vdEsc = micro ? micro.diameter : st0.vd;
        const tVia = Math.max(0, Math.floor((pitch - st0.vd - c + 1e-9) / (st0.w + c)));
        const tMicro = micro ? Math.max(0, Math.floor((pitch - micro.diameter - c + 1e-9) / (st0.w + c))) : tVia;
        const colOf = p => cl.xs.findIndex(x => Math.abs(x - p.lx) < 0.01), rowOf = p => cl.ys.findIndex(y => Math.abs(y - p.ly) < 0.01);
        const ringOf = p => { const col = colOf(p), row = rowOf(p); return Math.min(col, row, cl.cols - 1 - col, cl.rows - 1 - row); };
        const rings = Math.ceil(Math.min(cl.cols, cl.rows) / 2);
        // Escape layers: Top for the outer tTop + 1 rings, then (1 + tracks between vias) rings per inner layer.
        const inner = routing.slice(1);
        const plan = [];
        let k = 0;
        for (let r = 0; r <= tTop && k < rings; r++, k++) plan[k] = routing[0];
        for (let li = 0; li < inner.length && k < rings; li++) {
          const per = 1 + (li === 0 && micro ? tMicro : tVia);
          for (let r = 0; r < per && k < rings; r++, k++) plan[k] = inner[li];
        }
        const escape = {tracksPerChannelTop: tTop, tracksPerChannelInner: tVia, viaInPad, microvia: !!micro, rings: [], fits: k >= rings};
        for (let r = 0; r < rings; r++) escape.rings.push({ring: r + 1, balls: smd.filter(p => ringOf(p) === r).length, layer: plan[r] || "needs another signal layer", via: r > tTop || options.escapeOuter === false});
        comp.escape = escape;
        const diag = pitch * Math.SQRT1_2;
        const dogboneFits = diag >= vdEsc / 2 + ball / 2 + c - EPS;
        // Outward quadrant of a ball; centre lines split by column/row parity.
        const quadrant = p => {
          const dx = p.lx - cl.cx, dy = p.ly - cl.cy;
          return [Math.abs(dx) < 1e-6 ? (colOf(p) % 2 ? 1 : -1) : Math.sign(dx), Math.abs(dy) < 1e-6 ? (rowOf(p) % 2 ? 1 : -1) : Math.sign(dy)];
        };
        const byNet = new Map(smd.map(p => [p.net, p]));
        // Outer rings first, so deeper vias see the escape tracks' channels already taken.
        const order = smd.slice().sort((a, b) => ringOf(a) - ringOf(b));
        for (const p of order) {
          if (!eligible(p)) continue;
          const r = ringOf(p), power = isPower(p.net), layer = plan[r] || null;
          if (!power && options.escapeOuter !== false && r <= tTop) { comp.topEscape = (comp.topEscape || 0) + 1; continue; }
          if (!power && layer) report.prefLayers[p.net] = layer;
          // HDI: an escape layer deeper than Inner 1 inside the build-up is reached by a chain of laser
          // microvias, stacked at one point while the HDI Vias rule's stack limit allows, else staggered.
          const chain = !power && layer ? microChain(layer) : null;
          if (chain && chain.length > 1) {
            const [qx, qy] = quadrant(p), stacked = stackingOK(chain.length);
            const dv = toWorld(qx * Math.SQRT1_2, qy * Math.SQRT1_2), dogd = Math.min(diag, p.pad.w / 2 + c + micro.diameter / 2 + 1e-4);
            const starts = viaInPad ? [[[...p.at], true]] : [];
            starts.push([[p.at[0] + dv[0] * diag, p.at[1] + dv[1] * diag], false], [[p.at[0] + dv[0] * dogd, p.at[1] + dv[1] * dogd], false]);
            let done = false;
            for (const [at, inPad] of starts) if (placeChain(p, chain, at, dv, {inPad, stacked, comp})) { done = true; break; }
            if (done) continue;
          }
          const useMicro = !!micro && !power && layer === routing[1] && micro.from === routing[0];
          const kind = useMicro ? "micro" : "through";
          if (viaInPad && place(p, [...p.at], {track: false, kind, inPad: true, comp, power})) continue;
          if (!dogboneFits && !useMicro) { skip(p, "Via too large for the ball pitch"); continue; }
          let [sx, sy] = quadrant(p);
          // Differential pair: mirror the partner's dog-bone across the axis between the two balls.
          const mate = pairs.has(p.net) ? byNet.get(pairs.get(p.net)) : null;
          if (mate && !isPower(mate.net)) {
            const ddx = mate.lx - p.lx, ddy = mate.ly - p.ly;
            if (Math.abs(ddy) < 0.01 && Math.abs(Math.abs(ddx) - pitch) < 0.01) sx = -Math.sign(ddx);
            else if (Math.abs(ddx) < 0.01 && Math.abs(Math.abs(ddy) - pitch) < 0.01) sy = -Math.sign(ddy);
          }
          const st = ctx.style(p.net), vdP = useMicro ? micro.diameter : st.vd;
          const close = Math.min(diag, p.pad.w / 2 + c + vdP / 2 + 1e-4);
          const placement = options.viaPlacement || rule.viaPlacement || "centered";
          const dists = placement === "close" ? [close, diag] : [diag, close];
          let ok = false;
          for (const [qx, qy] of [[sx, sy], [sx, -sy], [-sx, sy], [-sx, -sy]]) {
            for (const d of dists) {
              const v = toWorld(qx * d * Math.SQRT1_2, qy * d * Math.SQRT1_2), via = [p.at[0] + v[0], p.at[1] + v[1]];
              if (place(p, via, {kind, comp, power}) || (useMicro && place(p, via, {kind: "through", comp, power}))) { ok = true; break; }
            }
            if (ok) break;
          }
          if (!ok) skip(p, "No legal via position around the ball");
        }
        continue;
      }

      // Perimeter parts (QFN, QFP, SOIC): power pads to plane vias (thermal array in an exposed
      // pad); signal pads only on fine-pitch parts (options.auto "fine" or an explicit component).
      const big = smd.filter(p => p.pad.w * p.pad.h > 4 * Math.max(1e-6, cl.pitch * cl.pitch) && p.pad.w > 1 && p.pad.h > 1);
      for (const p of big) { if (eligible(p)) { if (!isPower(p.net) || options.thermal === false || !thermal(p)) skip(p, isPower(p.net) ? "No room for thermal vias" : "Exposed pad on a signal net"); } }
      const fine = wanted || options.auto === "fine" || !options.auto;
      const normals = {left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1]};
      const order = [];
      for (const side of ["left", "bottom", "right", "top"]) for (const [i, p] of (cl.sides?.[side] || []).entries()) if (!big.includes(p)) order.push({p, side, i});
      for (const {p, side, i} of order) {
        const power = isPower(p.net);
        if (!power && !fine) continue;
        if (!eligible(p)) continue;
        const st = ctx.style(p.net), c = ctx.clr(p.net, "");
        const ln = normals[side], n = toWorld(ln[0], ln[1]);
        const pa = (p.pad.angle || 0) * Math.PI / 180, ux = Math.cos(pa), uy = Math.sin(pa);
        const half = Math.abs(p.pad.w / 2 * (ux * ln[0] + uy * ln[1])) + Math.abs(p.pad.h / 2 * (-uy * ln[0] + ux * ln[1]));
        const d1 = half + c + st.vd / 2;
        const rowStep = Math.max(st.vd / 2 + c + st.w / 2, Math.sqrt(Math.max(0, (st.vd + c) ** 2 - cl.pitch * cl.pitch)) + 1e-4, h2h ? Math.sqrt(Math.max(0, (st.vh + h2h) ** 2 - cl.pitch * cl.pitch)) + 1e-4 : 0);
        // Power pads fan inward when there is room under the part, signals outward (staggered rows).
        const dirs = power ? [-1, 1] : [1, -1], rows = i % 2 ? [d1 + rowStep, d1] : [d1, d1 + rowStep];
        let ok = false;
        for (const dir of dirs) {
          for (const r0 of rows) {
            for (let k = 0; k < 6 && !ok; k++) {
              const r = r0 + k * st.vd / 2;
              if (place(p, [p.at[0] + n[0] * dir * r, p.at[1] + n[1] * dir * r], {comp, power})) ok = true;
            }
            if (ok) break;
          }
          if (ok) break;
        }
        if (!ok) skip(p, "No legal via position in the fanout direction");
      }
    }
    return {add, remove: [], report};
  }

  // ---------------------------------------------------------------- dialog
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function select(options, value) { const s = el("select", null, "ui-field"); for (const [v, t] of options) s.add(new Option(t, v)); s.value = value; return s; }
  function check(label, on) { const l = el("label", null, "ar-check"), c = el("input", null, "ui-checkbox"); c.type = "checkbox"; c.checked = on; l.append(c, el("span", label)); return [l, c]; }
  function selectedIds(ctx) {
    try { const s = typeof ctx.selection === "function" ? ctx.selection() : ctx.selectedIds; return [...(s || [])]; } catch { return []; }
  }
  function open(ctx) {
    const doc = ctx.doc, defs = ctx.defs;
    if (doc?.kind !== "pcb") { ctx.info?.("Open a PCB layout to fan out components."); return; }
    const dlg = el("dialog", null, "ui-dialog work-dialog ar-dialog ar-fanout");
    dlg.setAttribute("aria-label", "Fanout");
    dlg.append(el("h2", "Fanout Options", "ui-dialog-title"));
    const parts = doc.items.filter(i => i.kind === "part" && (defs.get(i.def)?.footprint?.pads || []).some(p => !(p.drill > 0)));
    const sel = new Set(selectedIds(ctx));
    const selectedParts = parts.filter(p => sel.has(p.id));
    const scope = select([["all", "All components"], ["selected", "Selected components (" + selectedParts.length + ")"], ["one", "Component…"]], selectedParts.length ? "selected" : "all");
    const comp = select(parts.map(p => [p.id, p.ref + " · " + (defs.get(p.def)?.footprint?.name || p.value)]), selectedParts[0]?.id || parts[0]?.id || "");
    comp.hidden = scope.value !== "one";
    scope.onchange = () => { comp.hidden = scope.value !== "one"; };
    const style = select([["rule", "From Fanout Control rule"], ...STYLES], "rule");
    const direction = select([["rule", "From Fanout Control rule"], ...DIRECTIONS], "rule");
    const placement = select([["rule", "From Fanout Control rule"], ...PLACEMENTS], "rule");
    const grid = el("div", null, "ar-form");
    const row = (label, ...control) => { grid.append(el("span", label), (() => { const d = el("div"); d.append(...control); return d; })()); };
    row("Scope", scope, comp);
    row("Fanout style", style);
    row("Fanout direction", direction);
    row("BGA via placement", placement);
    // Engine v2: escape layers per ring, HDI microvias / via-in-pad, plane vias, symmetric pairs.
    const engine = select([["v2", "v2 (escape layers, HDI, plane vias)"], ["v1", "v1 (classic)"]], AR()?.engineDefault?.() === "v2" ? "v2" : "v1");
    row("Engine", engine);
    const [l1, connected] = check("Fanout only pads with connections", true);
    const [l2, power] = check("Include power nets (fan out to planes)", false);
    const [l3, outer] = check("BGA: leave balls that can escape on the top layer", true);
    const [l4, small] = check("Include two- and three-pad parts", false);
    const opts = el("div", null, "ar-checks");
    opts.append(l1, l2, l3, l4);
    const rules = AR().rulesFor(doc, ctx.project);
    const fr = rules.query("fanoutControl", {});
    const summary = el("p", null, "ar-note");
    summary.textContent = rules.available
      ? "Fanout Control: " + (fr ? (fr.ruleName || "rule") + " · " + (STYLES.find(s => s[0] === fr.style)?.[1] || fr.style) + " · " + (DIRECTIONS.find(s => s[0] === fr.direction)?.[1] || fr.direction) : "no rule, Auto and Alternating are used") + ". Vias follow the Routing Via Style rule; clearances follow the Clearance rules."
      : "Design rules are unavailable; built-in defaults are used (0.2 mm clearance, 0.6/0.3 mm vias).";
    if (!rules.available || !fr) summary.classList.add("ar-warn");
    const out = el("div", null, "ar-log");
    const actions = el("div", null, "work-actions ui-dialog-actions");
    const close = el("button", "Close", "ui-button"), previewBtn = el("button", "Preview", "ui-button"), run = el("button", "Fanout", "ui-button");
    run.dataset.variant = "primary";
    close.type = run.type = previewBtn.type = "button";
    previewBtn.title = "Show the fanout on the board without changing it.";
    actions.append(close, previewBtn, run);
    const body = el("div", null, "ui-dialog-body");
    body.append(summary, grid, opts, out);
    dlg.append(body, actions);
    const PV = () => globalThis.AtriumAutorouterV2?.preview;
    if (!globalThis.AtriumAutorouterV2) globalThis.AtriumLazy?.need?.("AtriumAutorouterV2")?.catch?.(() => {});
    close.onclick = () => dlg.close();
    dlg.onclose = () => { PV()?.clear(); dlg.remove(); };
    let last = null;
    function compute() {
      const pick = v => v === "rule" ? undefined : v;
      const components = scope.value === "all" ? undefined : scope.value === "selected" ? selectedParts.map(p => p.id) : [comp.value];
      const o = {components, style: pick(style.value), direction: pick(direction.value), viaPlacement: pick(placement.value),
        connectedOnly: connected.checked, powerNets: power.checked, escapeOuter: outer.checked, minPads: small.checked ? 2 : 4, project: ctx.project};
      return engine.value === "v2" ? planV2(doc, defs, o) : plan(doc, defs, o);
    }
    for (const c of [scope, comp, style, direction, placement, engine, connected, power, outer, small]) c.addEventListener("change", () => { last = null; PV()?.clear(); dlg.classList.remove("ar-reviewing"); });
    previewBtn.onclick = () => {
      try {
        last = {result: compute(), revision: ctx.revision?.()};
        const r = last.result.report;
        out.replaceChildren(el("p", "Preview: " + r.vias + " via" + (r.vias === 1 ? "" : "s") + (r.microvias ? " (" + r.microvias + " microvias)" : "") + (r.viaInPad ? ", " + r.viaInPad + " in pads" : "") + ". Fanout applies it as one undo step."));
        if (PV()) { PV().show(doc, last.result); dlg.classList.add("ar-reviewing"); }
      } catch (error) { out.replaceChildren(el("p", error.message, "ar-warn")); }
    };
    run.onclick = () => {
      try {
        const result = last && last.revision === ctx.revision?.() ? last.result : compute();
        last = null; PV()?.clear(); dlg.classList.remove("ar-reviewing");
        out.replaceChildren();
        const r = result.report;
        out.append(el("p", r.fanned + " pad" + (r.fanned === 1 ? "" : "s") + " fanned out with " + r.vias + " via" + (r.vias === 1 ? "" : "s") + " · " + r.skipped.length + " skipped."));
        for (const c of r.components.filter(c => c.fanned || c.escape || c.note)) {
          const line = el("div", null, "ar-line");
          line.append(el("strong", c.ref), el("span", " " + c.kind.toUpperCase() + " · pitch " + (Number.isFinite(c.pitch) ? c.pitch.toFixed(3) + " mm" : "–") + " · " + c.fanned + " fanned" + (c.topEscape ? " · " + c.topEscape + " escape on " + "Top" : "") + (c.note ? " · " + c.note : "")));
          out.append(line);
          if (c.escape) for (const ring of c.escape.rings) out.append(el("div", "Ring " + ring.ring + ": " + ring.balls + " balls → " + ring.layer + (ring.via ? " (via)" : " (no via)"), "ar-sub"));
        }
        const skipped = r.skipped.filter(s => !/Already connected|no other connections/.test(s.reason));
        for (const s of skipped.slice(0, 200)) {
          const b = el("button", s.ref + "." + s.pad + " " + s.net + " — " + s.reason, "ar-locate ui-button");
          b.type = "button";
          b.onclick = () => { dlg.close(); ctx.locate?.(s.id, s.at); };
          out.append(b);
        }
        if (result.add.length) {
          ctx.edit(() => { for (const item of result.add) ctx.doc.items.push(item); }); // one undo step
          ctx.info?.("Fanout added " + r.vias + " vias.");
        }
      } catch (error) { out.replaceChildren(el("p", error.message, "ar-warn")); }
    };
    document.body.append(dlg);
    globalThis.AtriumShell?.adoptDialog?.(dlg, {initialFocus: scope, defaultAction: false}); dlg.showModal();
    return dlg;
  }
  return {plan, planV2, open, classify, partPads, STYLES, DIRECTIONS, PLACEMENTS};
})();
