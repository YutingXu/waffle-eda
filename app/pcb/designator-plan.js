"use strict";
// Designator placement optimiser (AtriumDesignatorPlan), loaded on first use: the engine
// behind AtriumDesignators.plan() and relayout() in designator-place.js, which keeps the
// model, label geometry and drawing.
//
// Optimiser: candidate boxes around (and for large parts inside) each body; static cost
// from a uniform spatial grid of hard obstacles (mask openings + clearance, board edge)
// and soft ones (other bodies, vias, board silk, ambiguity, orientation, preference);
// greedy by difficulty, then local-improvement rounds, one-level ejection for the
// leftovers and an optional smaller-text pass.
globalThis.AtriumDesignatorPlan = (() => {
  const A = globalThis.Atrium, D = globalThis.AtriumDesignators;
  const now = () => globalThis.performance?.now?.() ?? Date.now();
  const HARD = Infinity;
  const DEFAULTS = D.defaults, metrics = D.metrics, label = D.label, isBottom = D.isBottom;
  const norm = a => ((Math.round(a) % 360) + 360) % 360;

  // ------------------------------------------------------------ geometry helpers
  const localBoxes = new WeakMap();
  function bodyLocal(fp) {
    let b = localBoxes.get(fp);
    if (b !== undefined) return b;
    const yard = (fp.shapes || []).filter(s => /courtyard/i.test(s.layer || "") || s.style === "courtyard");
    b = (yard.length ? A.bounds(A.symbolPoints({shapes: yard})) : null) || A.bounds(A.symbolPoints(fp)) || [-.5, -.5, .5, .5];
    localBoxes.set(fp, b);
    return b;
  }
  function worldBox(frame, b) {
    const a = frame.angle || 0, x = frame.x, y = frame.y;
    if (!a) return [x + b[0], y + b[1], x + b[2], y + b[3]];
    const c = Math.cos(a * Math.PI / 180), s = Math.sin(a * Math.PI / 180);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < 4; k++) {
      const px = k & 1 ? b[2] : b[0], py = k & 2 ? b[3] : b[1];
      const wx = x + px * c - py * s, wy = y + px * s + py * c;
      if (wx < x0) x0 = wx; if (wx > x1) x1 = wx; if (wy < y0) y0 = wy; if (wy > y1) y1 = wy;
    }
    return [x0, y0, x1, y1];
  }
  const sideOfLayer = layer => /^bottom/i.test(layer || "") ? 2 : /^(top|silk$)/i.test(layer || "") ? 1 : 0;
  function padSides(part, p) {
    if (p.drill > 0 || p.layer === "Multi" || p.kind === "via") return 3;
    return sideOfLayer(p.layer || part?.layer || "Top");
  }
  function boxDist(a, b) {
    const dx = Math.max(0, a[0] - b[2], b[0] - a[2]), dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
    return Math.hypot(dx, dy);
  }
  function pointBoxDist(x, y, b) {
    const dx = Math.max(0, b[0] - x, x - b[2]), dy = Math.max(0, b[1] - y, y - b[3]);
    return Math.hypot(dx, dy);
  }
  function overlapArea(a0, a1, a2, a3, B, k) {
    const w = Math.min(a2, B[k + 2]) - Math.max(a0, B[k]), h = Math.min(a3, B[k + 3]) - Math.max(a1, B[k + 1]);
    return w > 0 && h > 0 ? w * h : 0;
  }
  function segHitsBox(ax, ay, bx, by, b) {
    // Liang–Barsky clip of the segment against the box.
    let t0 = 0, t1 = 1;
    const dx = bx - ax, dy = by - ay;
    const clip = (p, q) => {
      if (Math.abs(p) < 1e-15) return q >= 0;
      const r = q / p;
      if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
      else { if (r < t0) return false; if (r < t1) t1 = r; }
      return true;
    };
    return clip(-dx, ax - b[0]) && clip(dx, b[2] - ax) && clip(-dy, ay - b[1]) && clip(dy, b[3] - ay) && t0 <= t1;
  }
  function insidePolygon(x, y, poly) {
    let r = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) r = !r;
    }
    return r;
  }

  // ------------------------------------------------------------ uniform grid
  function grid(bounds, cell, capacity) {
    const x0 = bounds[0], y0 = bounds[1];
    const nx = Math.max(1, Math.min(2048, Math.ceil((bounds[2] - x0) / cell) || 1)), ny = Math.max(1, Math.min(2048, Math.ceil((bounds[3] - y0) / cell) || 1));
    const cells = new Array(nx * ny);
    let marks = new Uint32Array(capacity + 1), stamp = 0;
    let out = new Int32Array(Math.max(64, capacity));
    const cx = v => { const i = Math.floor((v - x0) / cell); return i < 0 ? 0 : i >= nx ? nx - 1 : i; };
    const cy = v => { const i = Math.floor((v - y0) / cell); return i < 0 ? 0 : i >= ny ? ny - 1 : i; };
    function insert(id, b) {
      for (let j = cy(b[1]), j1 = cy(b[3]); j <= j1; j++) for (let i = cx(b[0]), i1 = cx(b[2]); i <= i1; i++) {
        const k = j * nx + i; (cells[k] || (cells[k] = [])).push(id);
      }
    }
    function remove(id, b) {
      for (let j = cy(b[1]), j1 = cy(b[3]); j <= j1; j++) for (let i = cx(b[0]), i1 = cx(b[2]); i <= i1; i++) {
        const c = cells[j * nx + i]; if (!c) continue;
        const at = c.lastIndexOf(id); if (at >= 0) { c[at] = c[c.length - 1]; c.pop(); }
      }
    }
    // Ids whose cells overlap the box, deduplicated, in the shared `out` buffer.
    function query(b0, b1, b2, b3) {
      if (++stamp === 0xffffffff) { marks.fill(0); stamp = 1; }
      let n = 0;
      for (let j = cy(b1), j1 = cy(b3); j <= j1; j++) for (let i = cx(b0), i1 = cx(b2); i <= i1; i++) {
        const c = cells[j * nx + i]; if (!c) continue;
        for (let k = 0; k < c.length; k++) {
          const id = c[k]; if (marks[id] === stamp) continue; marks[id] = stamp;
          if (n === out.length) { const g = new Int32Array(n * 2); g.set(out); out = g; api.out = out; }
          out[n++] = id;
        }
      }
      return n;
    }
    const api = {insert, remove, query, out, nx, ny, cell, x0, y0, cells};
    return api;
  }

  // ------------------------------------------------------------ rules
  function ruleDefaults(doc, o) {
    const R = globalThis.AtriumRules;
    let clearance = o.clearance, silkGap = o.silkGap, expansion = null;
    try { if (clearance == null && R?.query) clearance = R.query(doc, "silkToMask", {layer: "Silk"}, {project: o.project})?.gap; } catch {}
    try { if (silkGap == null && R?.query) silkGap = R.query(doc, "silkToSilk", {layer: "Silk"}, {project: o.project})?.gap; } catch {}
    try { if (o.maskExpansion == null && R?.expansionResolver) expansion = R.expansionResolver(doc, "solder", {project: o.project}); } catch {}
    return {clearance: clearance ?? .1, silkGap: silkGap ?? .1, expansion: o.maskExpansion != null ? () => o.maskExpansion : expansion || (() => .1016)};
  }

  // ------------------------------------------------------------ engine
  // Obstacle types in the static grid.
  const PAD = 1, BODY = 2, VIA = 3, SILK = 4, EDGE = 5;
  function engine(doc, defs, o) {
    const t0 = now();
    const rules = ruleDefaults(doc, o);
    const parts = [], byId = new Map();
    for (const item of doc.items) {
      if (item.kind !== "part") continue;
      const def = defs.get(item.def), fp = def?.footprint;
      if (!fp) continue;
      const rec = {item, def, fp, index: parts.length, side: isBottom(item) ? 2 : 1, body: worldBox(item, bodyLocal(fp)), target: false, fixed: null};
      parts.push(rec); byId.set(item.id, rec);
    }
    // Static obstacles.
    const T = [], S = [], OWN = [], BX = [], W = [];
    const add = (type, side, owner, b, weight = 0) => {
      if (type === PAD && owner >= 0) (parts[owner].pads ||= []).push(b, side);
      T.push(type); S.push(side); OWN.push(owner); BX.push(b[0], b[1], b[2], b[3]); W.push(weight);
    };
    let maxPadMargin = 0;
    for (const r of parts) {
      add(BODY, r.side, r.index, r.body);
      for (const p of r.fp.pads || []) {
        const side = padSides(r.item, p); if (!side) continue;
        let e = 0; try { e = rules.expansion(p, r.item, p.layer) || 0; } catch { e = .1016; }
        const m = Math.max(0, e) + rules.clearance; if (m > maxPadMargin) maxPadMargin = m;
        const hw = (p.w || 0) / 2 + m, hh = (p.h || 0) / 2 + m, at = A.world([p.x, p.y], r.item);
        const b = worldBox({x: at[0], y: at[1], angle: (r.item.angle || 0) + (p.angle || 0)}, [-hw, -hh, hw, hh]);
        add(PAD, side, r.index, b);
        // Drilled holes: the drill itself is also a keep-out.
        if (p.drill > 0) { const d = p.drill / 2 + rules.clearance; add(PAD, 3, r.index, [at[0] - d, at[1] - d, at[0] + d, at[1] + d]); }
      }
    }
    for (const i of doc.items) {
      if (i.kind === "pad") {
        const side = padSides(null, i); if (!side) continue;
        let e = 0; try { e = rules.expansion(i, null, i.layer) || 0; } catch { e = .1016; }
        const m = Math.max(0, e) + rules.clearance, hw = (i.w || i.diameter || 0) / 2 + m, hh = (i.h || i.diameter || 0) / 2 + m;
        add(PAD, side, -1, worldBox(i, [-hw, -hh, hw, hh]));
        if (i.drill > 0) { const d = i.drill / 2 + rules.clearance; add(PAD, 3, -1, [i.x - d, i.y - d, i.x + d, i.y + d]); }
      } else if (i.kind === "via") {
        const r = (i.diameter || 0) / 2 + (o.vias === "hard" ? rules.clearance : 0);
        if (o.vias !== "ignore") add(o.vias === "hard" ? PAD : VIA, 3, -1, [i.x - r, i.y - r, i.x + r, i.y + r], 1);
      } else if (i.kind === "label" && /silk/i.test(i.layer || "Silk")) {
        const size = i.size || .75, m = metrics(i.text, size);
        add(SILK, sideOfLayer(i.layer || "Silk") || 1, -1, worldBox(i, [-m.stroke / 2, -size - m.stroke / 2, m.w, m.stroke / 2 + m.desc]), 6);
      }
    }
    // Board outline, inset by the edge clearance.
    const outline = doc.outline?.length >= 3 ? doc.outline : null;
    let extent = outline ? A.bounds(outline) : null;
    if (!extent) {
      extent = [Infinity, Infinity, -Infinity, -Infinity];
      for (let k = 0; k < BX.length; k += 4) {
        if (BX[k] < extent[0]) extent[0] = BX[k]; if (BX[k + 1] < extent[1]) extent[1] = BX[k + 1];
        if (BX[k + 2] > extent[2]) extent[2] = BX[k + 2]; if (BX[k + 3] > extent[3]) extent[3] = BX[k + 3];
      }
      if (!(extent[0] <= extent[2])) extent = [-10, -10, 10, 10];
    }
    const segs = [];
    if (outline) for (let i = 0; i < outline.length; i++) {
      const a = outline[i], b = outline[(i + 1) % outline.length], e = o.edgeClearance;
      segs.push(a[0], a[1], b[0], b[1]);
      add(EDGE, 3, segs.length / 4 - 1, [Math.min(a[0], b[0]) - e, Math.min(a[1], b[1]) - e, Math.max(a[0], b[0]) + e, Math.max(a[1], b[1]) + e]);
    }
    const n = T.length, B = Float64Array.from(BX), type = Uint8Array.from(T), side = Uint8Array.from(S), owner = Int32Array.from(OWN), weight = Float64Array.from(W);
    const area = Math.max(1, (extent[2] - extent[0]) * (extent[3] - extent[1]));
    const cell = Math.max(1, Math.min(8, Math.sqrt(area / Math.max(1, n)) * 2.5));
    const pad = 6;
    const bounds = [extent[0] - pad, extent[1] - pad, extent[2] + pad, extent[3] + pad];
    const G = grid(bounds, cell, n);
    for (let k = 0; k < n; k++) G.insert(k, [B[4 * k], B[4 * k + 1], B[4 * k + 2], B[4 * k + 3]]);
    // Inside/outside per grid cell without an outline edge: one point-in-polygon per cell.
    let cellState = null;
    if (outline) {
      cellState = new Uint8Array(G.nx * G.ny);
      for (let j = 0; j < G.ny; j++) for (let i = 0; i < G.nx; i++) {
        const c = G.cells[j * G.nx + i];
        if (c && c.some(k => type[k] === EDGE)) continue;
        cellState[j * G.nx + i] = insidePolygon(G.x0 + (i + .5) * cell, G.y0 + (j + .5) * cell, outline) ? 1 : 2;
      }
    }
    const labelGrid = grid(bounds, Math.max(1, cell), parts.length);
    const placed = new Float64Array(parts.length * 4), isPlaced = new Uint8Array(parts.length), orient = new Uint8Array(parts.length);
    const silkGap = rules.silkGap;
    return {doc, defs, o, parts, byId, B, type, side, owner, weight, segs, G, outline, cellState, labelGrid, placed, isPlaced, orient,
      silkGap, maxPadMargin, clearance: rules.clearance, setupMs: now() - t0, evaluated: 0};
  }

  // Static cost of a text box for part r, or HARD. kindCost: position preference etc.
  function staticCost(E, r, b0, b1, b2, b3, ownInside) {
    E.evaluated++;
    const {B, type, side, owner, weight, G, segs, outline, cellState, o} = E;
    const mySide = r.side;
    const n = G.query(b0, b1, b2, b3), out = G.out;
    let cost = 0;
    const e = o.edgeClearance;
    for (let q = 0; q < n; q++) {
      const k = out[q], t = type[k];
      if (t === EDGE) {
        const s = owner[k] * 4;
        if (segHitsBox(segs[s], segs[s + 1], segs[s + 2], segs[s + 3], [b0 - e, b1 - e, b2 + e, b3 + e])) return HARD;
        continue;
      }
      if (!(side[k] & mySide)) continue;
      const j = 4 * k;
      if (b0 >= B[j + 2] || b2 <= B[j] || b1 >= B[j + 3] || b3 <= B[j + 1]) continue;
      if (t === PAD) return HARD;
      if (t === BODY) {
        if (owner[k] === r.index) { if (!ownInside) cost += 4; continue; }
        const frac = overlapArea(b0, b1, b2, b3, B, j) / ((b2 - b0) * (b3 - b1));
        cost += 3 + 12 * frac;
      } else cost += weight[k] + (t === SILK ? 4 * overlapArea(b0, b1, b2, b3, B, j) / ((b2 - b0) * (b3 - b1)) : 0);
    }
    if (outline) {
      // No edge crosses the (inset) box, so it is wholly inside or outside the board.
      const cx = (b0 + b2) / 2, cy = (b1 + b3) / 2;
      const i = Math.min(G.nx - 1, Math.max(0, Math.floor((cx - G.x0) / G.cell))), j = Math.min(G.ny - 1, Math.max(0, Math.floor((cy - G.y0) / G.cell)));
      const s = cellState[j * G.nx + i];
      if (s === 2 || (s === 0 && !insidePolygon(cx, cy, outline))) return HARD;
    }
    // Ambiguity: the label should read as belonging to its own part.
    const lab = [b0, b1, b2, b3], cx = (b0 + b2) / 2, cy = (b1 + b3) / 2;
    const own = ownInside ? 0 : boxDist(lab, r.body) + .3 * pointBoxDist(cx, cy, r.body);
    const reach = own + .3;
    const m = G.query(b0 - reach, b1 - reach, b2 + reach, b3 + reach);
    let worst = 0;
    for (let q = 0; q < m; q++) {
      const k = G.out[q];
      if (type[k] !== BODY || owner[k] === r.index || !(side[k] & mySide)) continue;
      const j = 4 * k, ob = [B[j], B[j + 1], B[j + 2], B[j + 3]];
      const other = boxDist(lab, ob) + .3 * pointBoxDist(cx, cy, ob);
      const d = own + .15 - other;
      if (d > worst) worst = d;
    }
    if (worst > 0) cost += worst > .15 ? 2 + 3 * (worst - .15) : 3 * worst;
    return cost;
  }

  // Candidate centres for one part at one height, appended to `list` as
  // [cx, cy, boardAngle, b0, b1, b2, b3, cost, ring, posCode].
  function candidates(E, r, height, ringFrom, ringTo, list) {
    const o = E.o, item = r.item, bottom = r.side === 2;
    const m = metrics(item.ref, height);
    const [x0, y0, x1, y1] = r.body, bw = x1 - x0, bh = y1 - y0, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const prefer = o.prefer || "top";
    const order = {top: ["top", "left", "right", "bottom"], left: ["left", "top", "bottom", "right"], bottom: ["bottom", "left", "right", "top"], right: ["right", "top", "bottom", "left"]}[prefer] || ["top", "left", "right", "bottom"];
    const hw = {}, vw = {};
    order.forEach((s, i) => { hw[s] = [0, .25, .32, .4][i]; });
    order.filter(s => s === "left" || s === "right").concat(order.filter(s => s === "top" || s === "bottom")).forEach((s, i) => { vw[s] = [0, .1, .5, .6][i]; });
    const partVertical = bh > bw * 1.1, square = !partVertical && bw <= bh * 1.1;
    const g0 = Math.max(o.gap, E.maxPadMargin + .02);
    const angles = o.orientation === "horizontal" ? [0] : o.orientation === "vertical" ? [bottom ? 90 : 270] : [0, bottom ? 90 : 270];
    for (const angle of angles) {
      const vertical = angle !== 0;
      const w = vertical ? m.h : m.w, h = vertical ? m.w : m.h;
      const weights = vertical ? vw : hw;
      let orientCost = 0;
      if (o.orientation === "auto") orientCost = square ? (vertical ? .5 : 0) : (vertical !== partVertical ? .8 : 0);
      for (let ring = ringFrom; ring <= ringTo; ring++) {
        const g = g0 + [0, .5, 1.2][ring], ringCost = [0, .9, 2.2][ring];
        const put = (cx, cy, pos, posCost) => {
          const b0 = cx - w / 2, b1 = cy - h / 2, b2 = cx + w / 2, b3 = cy + h / 2;
          const s = staticCost(E, r, b0, b1, b2, b3, pos === 16);
          if (s === HARD) return;
          list.push(cx, cy, angle, b0, b1, b2, b3, s + posCost + ringCost + orientCost, ring, pos);
        };
        const ty = y0 - g - h / 2, by = y1 + g + h / 2, lx = x0 - g - w / 2, rx = x1 + g + w / 2;
        put(mx, ty, 0, weights.top); put(mx, by, 1, weights.bottom); put(lx, my, 2, weights.left); put(rx, my, 3, weights.right);
        if (Math.abs(w - bw) > .05) {
          put(x0 + w / 2, ty, 4, weights.top + .15); put(x1 - w / 2, ty, 5, weights.top + .15);
          put(x0 + w / 2, by, 6, weights.bottom + .15); put(x1 - w / 2, by, 7, weights.bottom + .15);
        }
        if (Math.abs(h - bh) > .05) {
          put(lx, y0 + h / 2, 8, weights.left + .15); put(lx, y1 - h / 2, 9, weights.left + .15);
          put(rx, y0 + h / 2, 10, weights.right + .15); put(rx, y1 - h / 2, 11, weights.right + .15);
        }
        const gc = g * .7;
        put(x0 - gc - w / 2, y0 - gc - h / 2, 12, .6 + weights.top); put(x1 + gc + w / 2, y0 - gc - h / 2, 13, .6 + weights.top);
        put(x0 - gc - w / 2, y1 + gc + h / 2, 14, .6 + weights.bottom); put(x1 + gc + w / 2, y1 + gc + h / 2, 15, .6 + weights.bottom);
        if (ring === 0 && o.inside !== false && w <= bw - 1 && h <= bh - 1) put(mx, my, 16, .2);
      }
    }
  }
  const STRIDE = 10;
  function buildCandidates(E, r, height) {
    const list = [];
    candidates(E, r, height, 0, 0, list);
    let best = Infinity;
    for (let i = 7; i < list.length; i += STRIDE) best = Math.min(best, list[i]);
    if (best > 1) candidates(E, r, height, 1, 2, list);
    const k = list.length / STRIDE, order = Array.from({length: k}, (_, i) => i).sort((a, b) => list[a * STRIDE + 7] - list[b * STRIDE + 7]);
    const out = new Float64Array(list.length);
    order.forEach((src, i) => { for (let f = 0; f < STRIDE; f++) out[i * STRIDE + f] = list[src * STRIDE + f]; });
    r.cands = out; r.count = k; r.height = height;
  }
  // Dynamic part of the cost: other designators (hard) and orientation consistency.
  function dynamicCost(E, r, c) {
    const C = r.cands, j = c * STRIDE, gap = E.silkGap;
    const b0 = C[j + 3] - gap, b1 = C[j + 4] - gap, b2 = C[j + 5] + gap, b3 = C[j + 6] + gap;
    const L = E.labelGrid, P = E.placed;
    const n = L.query(b0, b1, b2, b3);
    for (let q = 0; q < n; q++) {
      const k = L.out[q]; if (k === r.index || !(E.parts[k].side & r.side)) continue;
      const i = 4 * k;
      if (b0 < P[i + 2] && b2 > P[i] && b1 < P[i + 3] && b3 > P[i + 1]) return HARD;
    }
    const R = 2.5, vertical = C[j + 2] !== 0 ? 1 : 0;
    const m = L.query(C[j + 3] - R, C[j + 4] - R, C[j + 5] + R, C[j + 6] + R);
    let cost = 0;
    for (let q = 0; q < m; q++) {
      const k = L.out[q]; if (k === r.index || !E.isPlaced[k]) continue;
      if (E.orient[k] !== vertical) cost += .12;
    }
    return Math.min(cost, .6);
  }
  function blockers(E, r, c) {
    const C = r.cands, j = c * STRIDE, gap = E.silkGap, out = [];
    const b0 = C[j + 3] - gap, b1 = C[j + 4] - gap, b2 = C[j + 5] + gap, b3 = C[j + 6] + gap;
    const n = E.labelGrid.query(b0, b1, b2, b3), P = E.placed;
    for (let q = 0; q < n; q++) {
      const k = E.labelGrid.out[q]; if (k === r.index || !(E.parts[k].side & r.side)) continue;
      const i = 4 * k;
      if (b0 < P[i + 2] && b2 > P[i] && b1 < P[i + 3] && b3 > P[i + 1]) out.push(k);
    }
    return out;
  }
  function place(E, r, box, vertical, cand) {
    const i = r.index * 4;
    E.placed[i] = box[0]; E.placed[i + 1] = box[1]; E.placed[i + 2] = box[2]; E.placed[i + 3] = box[3];
    E.isPlaced[r.index] = 1; E.orient[r.index] = vertical ? 1 : 0; r.choice = cand;
    E.labelGrid.insert(r.index, box);
  }
  function unplace(E, r) {
    if (!E.isPlaced[r.index]) return;
    const i = r.index * 4;
    E.labelGrid.remove(r.index, [E.placed[i], E.placed[i + 1], E.placed[i + 2], E.placed[i + 3]]);
    E.isPlaced[r.index] = 0; r.choice = -1;
  }
  const candBox = (r, c) => { const j = c * STRIDE; return [r.cands[j + 3], r.cands[j + 4], r.cands[j + 5], r.cands[j + 6]]; };
  function placeCand(E, r, c) { place(E, r, candBox(r, c), r.cands[c * STRIDE + 2] !== 0, c); }
  function bestFor(E, r) {
    let best = -1, bestCost = Infinity;
    for (let c = 0; c < r.count; c++) {
      const s = r.cands[c * STRIDE + 7];
      if (s >= bestCost) break; // sorted by static cost; dynamic cost is never negative
      const d = dynamicCost(E, r, c);
      if (d === HARD) continue;
      if (s + d < bestCost) { bestCost = s + d; best = c; }
    }
    return {best, cost: bestCost};
  }

  // Current label box of a part not being placed (an obstacle), or null.
  function currentBox(doc, part, def) {
    if (part.showRef === false || !part.ref) return null;
    const l = label(part, def);
    if (l) return {box: l.box, vertical: l.angle % 180 !== 0};
    const rows = part.boardLabels || doc.pcbDrawing?.annotations?.[part.sourceRecord];
    if (Array.isArray(rows)) {
      const a = rows.find(x => x && x.field === "ref" && Array.isArray(x.at));
      if (a) {
        const m = metrics(part.ref, a.size || .68), at = A.world(a.at, part), x0 = a.mirrored ? -m.w : 0;
        const b = worldBox({x: at[0], y: at[1], angle: (part.angle || 0) + (a.angle || 0)}, [x0, -m.height - m.stroke / 2, x0 + m.w, m.stroke / 2 + m.desc]);
        return {box: b, vertical: Math.round(((part.angle || 0) + (a.angle || 0)) / 90) % 2 !== 0};
      }
      if (rows.length === 0) return null;
    }
    const m = metrics(part.ref, .68);
    if (part.refAt) {
      const at = A.world(part.refAt, part);
      return {box: [at[0] - m.stroke / 2, at[1] - m.height - m.stroke / 2, at[0] + m.w - m.stroke / 2, at[1] + m.stroke / 2 + m.desc], vertical: false};
    }
    const fp = def?.footprint, b = fp ? worldBox(part, A.bounds(A.symbolPoints(fp)) || [-.5, -.5, .5, .5]) : [part.x, part.y, part.x, part.y];
    const cx = (b[0] + b[2]) / 2, base = b[1] - .39;
    return {box: [cx - m.w / 2, base - m.height - m.stroke / 2, cx + m.w / 2, base + m.stroke / 2 + m.desc], vertical: false};
  }

  function run(doc, defs, options, relayoutIds) {
    const t0 = now();
    const o = {...DEFAULTS, ...options};
    if (doc.kind !== "pcb") return {moves: [], unplaced: [], issues: [], stats: {parts: 0, ms: 0, note: "Designator placement works on board layouts."}};
    const E = engine(doc, defs, o);
    const wanted = relayoutIds ? new Set(relayoutIds) : options.ids ? new Set(options.ids) : null;
    const eligible = r => r.item.showRef !== false && !!r.item.ref;
    for (const r of E.parts) r.target = eligible(r) && (!wanted || wanted.has(r.item.id));
    // Fixed labels of every other part are obstacles.
    const fixedBox = new Map();
    for (const r of E.parts) {
      if (r.target) continue;
      const cur = currentBox(doc, r.item, r.def);
      if (cur) fixedBox.set(r, cur);
    }
    let kept = 0;
    if (relayoutIds) {
      // Labels of other parts that the moved parts now cover are re-placed too.
      const moved = E.parts.filter(r => r.target);
      for (const [r, cur] of fixedBox) {
        if (!eligible(r)) continue;
        const b = cur.box;
        const hit = (q, side) => side & r.side && b[0] < q[2] && b[2] > q[0] && b[1] < q[3] && b[3] > q[1];
        for (const m of moved) {
          if (hit(m.body, m.side)) { r.target = true; break; }
          // Through-hole pads reach the other side too.
          const pads = m.pads || [];
          for (let k = 0; k < pads.length && !r.target; k += 2) if (hit(pads[k], pads[k + 1])) r.target = true;
          if (r.target) break;
        }
        if (r.target) fixedBox.delete(r);
      }
    }
    for (const [r, cur] of fixedBox) place(E, r, cur.box, cur.vertical, -1);
    const targets = E.parts.filter(r => r.target);
    // Keep a moved part's managed designator where it still fits cleanly.
    if (relayoutIds && o.keep !== false) {
      for (const r of targets) {
        const l = label(r.item, r.def);
        if (!l) continue;
        const b = l.box, s = staticCost(E, r, b[0], b[1], b[2], b[3], false);
        r.cands = new Float64Array([l.center[0], l.center[1], l.angle, b[0], b[1], b[2], b[3], s, 0, -1]); r.count = 1;
        if (s <= (o.keepCost ?? 1.2) && dynamicCost(E, r, 0) !== HARD) { placeCand(E, r, 0); r.kept = true; kept++; }
      }
    }
    const todo = targets.filter(r => !r.kept);
    for (const r of todo) buildCandidates(E, r, o.height);
    // Greedy, hardest first: fewest feasible candidates, then the most expensive best.
    todo.sort((a, b) => a.count - b.count || (b.count ? b.cands[7] : 0) - (a.count ? a.cands[7] : 0));
    const unplaced = [];
    for (const r of todo) {
      const {best} = bestFor(E, r);
      if (best >= 0) placeCand(E, r, best); else unplaced.push(r);
    }
    // Local improvement.
    let rounds = 0;
    for (; rounds < o.rounds; rounds++) {
      let changed = 0;
      for (const r of todo) {
        if (!E.isPlaced[r.index]) continue;
        const was = r.choice;
        unplace(E, r);
        const {best} = bestFor(E, r);
        placeCand(E, r, best >= 0 ? best : was);
        if (best !== was) changed++;
      }
      if (!changed) break;
    }
    // One-level ejection: move a single blocking designator elsewhere.
    function eject(list) {
      const still = [];
      for (const u of list) {
        let done = false;
        for (let c = 0; c < Math.min(u.count, 24) && !done; c++) {
          const bl = blockers(E, u, c);
          if (bl.length !== 1) continue;
          const v = E.parts[bl[0]];
          if (!v.target || v.kept || !v.cands) continue;
          const was = v.choice;
          unplace(E, v); placeCand(E, u, c);
          const {best} = bestFor(E, v);
          if (best >= 0) { placeCand(E, v, best); done = true; }
          else { unplace(E, u); placeCand(E, v, was); }
        }
        if (!done) still.push(u);
      }
      return still;
    }
    let left = eject(unplaced);
    // Smaller text for what is left.
    const shrunk = [];
    if (left.length && o.minHeight > 0 && o.minHeight < o.height) {
      const again = [];
      for (const u of left) {
        buildCandidates(E, u, o.minHeight);
        const {best} = bestFor(E, u);
        if (best >= 0) { placeCand(E, u, best); shrunk.push(u.item.ref); } else again.push(u);
      }
      left = eject(again);
      for (const u of again) if (!left.includes(u)) shrunk.push(u.item.ref);
    }
    // Plan.
    const moves = [], round = v => Math.round(v * 1e4) / 1e4 + 0;
    for (const r of targets) {
      if (!E.isPlaced[r.index] || r.kept) continue;
      const j = r.choice * STRIDE, C = r.cands, item = r.item;
      const local = A.rotate([C[j] - item.x, C[j + 1] - item.y], -(item.angle || 0));
      const boardAngle = C[j + 2], rel = norm(boardAngle - (item.angle || 0));
      moves.push({id: item.id, ref: item.ref, designator: {x: round(local[0]), y: round(local[1]), angle: rel, height: r.height}, cost: Math.round(C[j + 7] * 100) / 100});
    }
    const issues = left.map(u => ({id: u.item.id, ref: u.item.ref, reason: u.count ? "Every free position collides with another designator." : "No position clears the pads, solder-mask openings and board edge.",
      suggestion: "Hide the designator (showRef off) or show it only on the assembly drawing layer."}));
    const stats = {parts: E.parts.length, targets: targets.length, placed: targets.length - left.length, kept, unplaced: left.length, shrunk: shrunk.length,
      rounds, evaluated: E.evaluated, obstacles: E.type.length, setupMs: Math.round(E.setupMs * 100) / 100, ms: Math.round((now() - t0) * 100) / 100};
    return {moves, unplaced: left.map(u => u.item.ref), shrunk, issues, stats};
  }

  return {run};
})();
