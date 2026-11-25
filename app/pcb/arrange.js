"use strict";
// Arrange Within Board / Arrange Within Rectangle (Tools › Component Placement), as in Altium.
// A simple, fast packer: it puts the chosen footprints inside the board outline (or a picked
// rectangle) without overlapping each other or the footprints already there. It is not the
// placement optimiser (autoplace.js); with {optimise:true} and AtriumAutoplace loaded, the
// packed result is handed to autoplace as the start for one short proposal.
//
//   AtriumArrange.plan(doc, defs, {ids, region:"board"|[x0,y0,x1,y1], gap, margin, project})
//       -> {moves:[{id, ref, from:[x,y], to:[x,y]}], failed:[id], region:[x0,y0,x1,y1], clusters, ms}
//   AtriumArrange.arrange(doc, defs, opts)   plan + apply in place; returns the plan plus {moved}
//   AtriumArrange.unplaced(doc, defs)        ids of unlocked parts whose courtyard is not inside the outline
//   AtriumArrange.command(action, ctx)       editor entry: "arrange-board" | "arrange-rect"
//
// Method.
//   1. Boxes: each footprint's courtyard (or pads and shapes when it has none) rotated to its
//      angle, mirrored for the bottom side, grown by half the gap.
//   2. Clusters: parts joined by signal nets (power and ground nets, and nets with more than 12
//      pins, are ignored) form clusters; a cluster is ordered from its largest part outwards,
//      strongest connection first, so each part has placed neighbours to sit next to.
//   3. Packing on a grid (at most 400 × 400 cells, at least 0.25 mm): cells outside the outline,
//      within the margin of its edge, in a cutout or under a fixed footprint are blocked. A
//      summed-area table answers "is this box free" in O(1). The first part of a cluster goes
//      to the free spot nearest the top-left, reading order; each other part to the free spot
//      nearest the centre of its already placed neighbours (weighted by shared nets).
// Deterministic: no randomness, fixed iteration order. DOM-free except command().
globalThis.AtriumArrange = (() => {
  const A = () => globalThis.Atrium;
  const EPS = 1e-9, MAX_CELLS = 400, MIN_STEP = 0.25;
  // net-intent.js (isSupply) when loaded; this regex is the fallback for one release (docs/design/net-intent.md §15).
  const POWER_RE = /^(GND|AGND|DGND|PGND|SGND|EARTH|VSS|VDD|VCC|VEE|VBAT|VBUS|VIN|VREF|\+?\d+V\d*|\+?\d+V|V\d+V\d*|-\d+V\d*)\b/i;
  const POWER = {test: n => { const N = globalThis.AtriumNetIntent; return N?.isSupply ? N.isSupply(String(n ?? "")) : POWER_RE.test(n); }};
  const now = () => (globalThis.performance?.now ? performance.now() : Date.now());
  const r2 = v => Math.round(v * 20) / 20 + 0; // 0.05 mm, as ECO places

  function bbox(pts) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts || []) { if (!Array.isArray(p)) continue; x0 = Math.min(x0, +p[0]); y0 = Math.min(y0, +p[1]); x1 = Math.max(x1, +p[0]); y1 = Math.max(y1, +p[1]); }
    return x0 <= x1 && y0 <= y1 ? [x0, y0, x1, y1] : null;
  }
  function insidePoly(x, y, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
    return c;
  }
  function edgeDist(p, poly) { let d = Infinity; for (let i = 0; i < poly.length; i++) d = Math.min(d, A().nearSegment(p, poly[i], poly[(i + 1) % poly.length])); return d; }
  const defsOf = (defs, project) => defs instanceof Map ? defs : new Map((project?.library || []).map(d => [d.id, d]));

  // The footprint's local box: courtyard when it has one, else pads, pins and shapes.
  function localBox(fp) {
    const court = Array.isArray(fp?.courtyard) ? fp.courtyard.filter(p => Array.isArray(p)) : [];
    const shapes = (fp?.shapes || []).filter(s => /courtyard/i.test(String(s.layer || "")));
    const pts = court.length ? court : shapes.length ? shapes.flatMap(s => s.points || (s.kind === "circle" ? [[s.x - s.r, s.y - s.r], [s.x + s.r, s.y + s.r]] : [[s.x, s.y]])) : (A()?.symbolPoints?.(fp) || []);
    return bbox(pts) || bbox(A()?.symbolPoints?.(fp) || []) || [-0.5, -0.5, 0.5, 0.5];
  }
  // The box relative to the part origin at its angle and side.
  function partBox(item, def) {
    const [x0, y0, x1, y1] = localBox(def?.footprint), origin = {x: 0, y: 0, angle: item.angle, mirror: item.mirror};
    const pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => A().world(p, origin));
    return bbox(pts);
  }
  const worldBox = (item, def) => { const b = partBox(item, def); return [b[0] + item.x, b[1] + item.y, b[2] + item.x, b[3] + item.y]; };

  function outlineOf(doc) { return Array.isArray(doc?.outline) && doc.outline.length >= 3 ? doc.outline.map(p => [+p[0], +p[1]]) : null; }
  function cutoutsOf(doc) {
    try { if (doc.boardShape && globalThis.AtriumBoardShape?.flatten) return AtriumBoardShape.flatten(doc.boardShape).cutouts || []; } catch { /* no shape */ }
    return [];
  }
  function within(b, outline, margin) {
    const q = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]];
    if (!q.every(([x, y]) => insidePoly(x, y, outline))) return false;
    for (const [x, y] of outline) if (x > b[0] + EPS && x < b[2] - EPS && y > b[1] + EPS && y < b[3] - EPS) return false;
    return !margin || q.every(p => edgeDist(p, outline) >= margin - 1e-6);
  }
  /** Unlocked parts whose courtyard is not inside the board outline (all parts when there is none). */
  function unplaced(doc, defs, project) {
    const D = defsOf(defs, project), outline = outlineOf(doc);
    return (doc?.items || []).filter(i => i.kind === "part" && i.locked !== true && D.get(i.def)?.footprint && (!outline || !within(worldBox(i, D.get(i.def)), outline, 0))).map(i => i.id);
  }

  // Nets per part (pad number -> net), signal nets only.
  function netsOf(item, def) {
    const out = new Set();
    for (const p of def?.footprint?.pads || []) {
      const n = item.pinNets && Object.prototype.hasOwnProperty.call(item.pinNets, String(p.number)) ? item.pinNets[String(p.number)] : p.net;
      if (n) out.add(String(n));
    }
    return out;
  }

  function plan(doc, defs, o = {}) {
    const t0 = now();
    if (!doc || doc.kind !== "pcb") throw Error("Open a board layout to arrange components.");
    const D = defsOf(defs, o.project), gap = Number.isFinite(o.gap) ? Math.max(0, o.gap) : 0.5;
    const outline = outlineOf(doc), rect = Array.isArray(o.region) ? [Math.min(o.region[0], o.region[2]), Math.min(o.region[1], o.region[3]), Math.max(o.region[0], o.region[2]), Math.max(o.region[1], o.region[3])] : null;
    if (!rect && !outline) throw Error("Set the board shape first (Design › Board Shape), or use Arrange Within Rectangle.");
    if (rect && (rect[2] - rect[0] < 0.5 || rect[3] - rect[1] < 0.5)) throw Error("The rectangle is too small.");
    const margin = Number.isFinite(o.margin) ? Math.max(0, o.margin) : rect ? 0 : 0.5;
    const region = rect || bbox(outline);
    const want = new Set(o.ids || unplaced(doc, D));
    const parts = doc.items.filter(i => i.kind === "part" && want.has(i.id) && i.locked !== true && D.get(i.def)?.footprint);
    const locked = doc.items.filter(i => i.kind === "part" && want.has(i.id) && i.locked === true).map(i => i.id);
    if (!parts.length) return {moves: [], failed: [], locked, region, clusters: 0, ms: Math.round(now() - t0)};

    // Grid.
    const W = region[2] - region[0], H = region[3] - region[1];
    const step = Math.max(MIN_STEP, W / MAX_CELLS, H / MAX_CELLS), nx = Math.max(1, Math.floor(W / step)), ny = Math.max(1, Math.floor(H / step));
    const blocked = new Uint8Array(nx * ny), cx = i => region[0] + (i + 0.5) * step, cy = j => region[1] + (j + 0.5) * step;
    // Board mode: cells outside the board, too near its edge, or in a cutout. A rectangle may lie
    // anywhere (a staging area beside the board, as in Altium), so only footprints block it.
    const cuts = rect ? [] : cutoutsOf(doc), edge = margin + step * 0.71;
    // Scanline fill (even-odd) per row: O(rows × edges), then a band along each edge.
    const scan = (poly, inside) => {
      for (let j = 0; j < ny; j++) {
        const y = cy(j), xs = [];
        for (let k = 0, m = poly.length - 1; k < poly.length; m = k++) {
          const [x0, y0] = poly[m], [x1, y1] = poly[k];
          if ((y0 > y) !== (y1 > y)) xs.push(x0 + (y - y0) * (x1 - x0) / (y1 - y0));
        }
        xs.sort((a, b) => a - b);
        let k = 0;
        for (let i = 0; i < nx; i++) {
          const x = cx(i);
          while (k < xs.length && xs[k] <= x) k++;
          if ((k % 2 === 1) !== inside) blocked[j * nx + i] = 1;
        }
      }
    };
    const band = (poly, d) => {
      const {nearSegment} = A();
      for (let k = 0; k < poly.length; k++) {
        const a = poly[k], b = poly[(k + 1) % poly.length];
        const i0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - d - region[0]) / step)), i1 = Math.min(nx - 1, Math.ceil((Math.max(a[0], b[0]) + d - region[0]) / step));
        const j0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - d - region[1]) / step)), j1 = Math.min(ny - 1, Math.ceil((Math.max(a[1], b[1]) + d - region[1]) / step));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (nearSegment([cx(i), cy(j)], a, b) < d) blocked[j * nx + i] = 1;
      }
    };
    if (outline && !rect) { scan(outline, true); band(outline, edge); }
    for (const c of cuts) if (Array.isArray(c) && c.length >= 3) { scan(c, false); band(c, step * 0.71); }
    const mark = (b, grow) => {
      const i0 = Math.max(0, Math.floor((b[0] - grow - region[0]) / step)), i1 = Math.min(nx - 1, Math.ceil((b[2] + grow - region[0]) / step) - 1);
      const j0 = Math.max(0, Math.floor((b[1] - grow - region[1]) / step)), j1 = Math.min(ny - 1, Math.ceil((b[3] + grow - region[1]) / step) - 1);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) blocked[j * nx + i] = 1;
    };
    // Fixed footprints, free pads and vias (mounting holes) are obstacles.
    for (const i of doc.items) {
      if (want.has(i.id) && i.locked !== true) continue;
      if (i.kind === "part" && D.get(i.def)?.footprint) mark(worldBox(i, D.get(i.def)), gap);
      else if ((i.kind === "pad" || i.kind === "via") && Number.isFinite(i.x)) { const r = Math.max(+i.w || 0, +i.h || 0, +i.diameter || 0, +i.size || 0, 0.3) / 2; mark([i.x - r, i.y - r, i.x + r, i.y + r], gap); }
    }
    // Summed-area table of blocked cells; rebuilt after each placement.
    const sat = new Int32Array((nx + 1) * (ny + 1));
    const build = () => {
      for (let j = 0; j < ny; j++) { let row = 0; for (let i = 0; i < nx; i++) { row += blocked[j * nx + i]; sat[(j + 1) * (nx + 1) + i + 1] = sat[j * (nx + 1) + i + 1] + row; } }
    };
    const busy = (i, j, w, h) => sat[(j + h) * (nx + 1) + i + w] - sat[j * (nx + 1) + i + w] - sat[(j + h) * (nx + 1) + i] + sat[j * (nx + 1) + i];

    // Parts, nets and clusters.
    const rec = parts.map((item, n) => {
      const def = D.get(item.def), b = partBox(item, def), w = b[2] - b[0] + gap, h = b[3] - b[1] + gap;
      return {n, item, def, b, w, h, cw: Math.max(1, Math.ceil(w / step - 1e-6)), ch: Math.max(1, Math.ceil(h / step - 1e-6)), nets: netsOf(item, def), at: null};
    });
    const netPins = new Map();
    for (const r of rec) for (const net of r.nets) { if (!netPins.has(net)) netPins.set(net, []); netPins.get(net).push(r.n); }
    // Fixed parts on the same nets pull too (their centres).
    const fixedNet = new Map();
    for (const i of doc.items) if (i.kind === "part" && !(want.has(i.id) && i.locked !== true) && D.get(i.def)?.footprint) {
      const wb = worldBox(i, D.get(i.def)), c = [(wb[0] + wb[2]) / 2, (wb[1] + wb[3]) / 2];
      for (const net of netsOf(i, D.get(i.def))) { if (!fixedNet.has(net)) fixedNet.set(net, []); fixedNet.get(net).push(c); }
    }
    const signal = net => !POWER.test(net) && (netPins.get(net)?.length || 0) + (fixedNet.get(net)?.length || 0) <= 12;
    const link = rec.map(() => new Map());
    for (const [net, list] of netPins) {
      if (!signal(net) || list.length < 2) continue;
      const w = 1 / (list.length - 1);
      for (const a of list) for (const b of list) if (a !== b) link[a].set(b, (link[a].get(b) || 0) + w);
    }
    // Order: clusters by size of their largest part; inside one, grow from the largest part.
    const area = r => r.w * r.h, seen = new Set(), order = [];
    const byArea = [...rec].sort((a, b) => area(b) - area(a) || String(a.item.ref || "").localeCompare(String(b.item.ref || ""), "en", {numeric: true}) || a.n - b.n);
    let clusters = 0;
    for (const seed of byArea) {
      if (seen.has(seed.n)) continue;
      clusters++; seen.add(seed.n); order.push({r: seed, seed: true});
      const gain = new Map();
      const add = r => { for (const [m, w] of link[r.n]) if (!seen.has(m)) gain.set(m, (gain.get(m) || 0) + w); };
      add(seed);
      while (gain.size) {
        let best = -1, bw = -1;
        for (const [m, w] of gain) if (w > bw + 1e-12 || (Math.abs(w - bw) <= 1e-12 && area(rec[m]) > area(rec[best]))) { best = m; bw = w; }
        gain.delete(best); seen.add(best); order.push({r: rec[best], seed: false}); add(rec[best]);
      }
    }

    // Pack.
    const moves = [], failed = [];
    let cursor = [region[0], region[1]];
    build();
    for (const {r, seed} of order) {
      // Target: neighbours' weighted centre (placed parts and fixed parts on shared nets).
      let tx = 0, ty = 0, tw = 0;
      for (const [m, w] of link[r.n]) { const q = rec[m]; if (q.at) { tx += (q.at[0] + q.w / 2) * w; ty += (q.at[1] + q.h / 2) * w; tw += w; } }
      for (const net of r.nets) if (signal(net)) for (const c of fixedNet.get(net) || []) { tx += c[0] * 0.5; ty += c[1] * 0.5; tw += 0.5; }
      const target = tw > 0 && !seed ? [tx / tw, ty / tw] : null;
      let best = null, bs = Infinity;
      for (let j = 0; j + r.ch <= ny; j++) {
        for (let i = 0; i + r.cw <= nx; i++) {
          if (busy(i, j, r.cw, r.ch)) continue;
          const x = region[0] + i * step, y = region[1] + j * step;
          // Seeds fill in reading order from the last seed; members hug their neighbours.
          const s = target ? Math.hypot(x + r.w / 2 - target[0], y + r.h / 2 - target[1]) : (y - region[1]) * W * 4 + (x - region[0]);
          if (s < bs - 1e-9) { bs = s; best = [i, j]; }
        }
      }
      if (!best) { failed.push(r.item.id); continue; }
      const [i, j] = best, x = region[0] + i * step, y = region[1] + j * step;
      r.at = [x, y];
      for (let jj = j; jj < j + r.ch; jj++) for (let ii = i; ii < i + r.cw; ii++) blocked[jj * nx + ii] = 1;
      build();
      if (seed) cursor = [x, y];
      const to = [r2(x + gap / 2 - r.b[0]), r2(y + gap / 2 - r.b[1])];
      moves.push({id: r.item.id, ref: r.item.ref || "", from: [+r.item.x || 0, +r.item.y || 0], to, angle: +r.item.angle || 0});
    }
    return {moves, failed, locked, region, clusters, grid: step, ms: Math.round(now() - t0)};
  }

  function apply(doc, defs, moves, project) {
    const D = defsOf(defs, project), byId = new Map(doc.items.map(i => [i.id, i]));
    let n = 0;
    for (const m of moves) {
      const item = byId.get(m.id);
      if (!item || item.kind !== "part") continue;
      if (A()?.transformPart) A().transformPart(doc, item, D.get(item.def), {x: m.to[0], y: m.to[1]}); else { item.x = m.to[0]; item.y = m.to[1]; }
      n++;
    }
    return n;
  }
  /** Plan and apply in place (the caller wraps it in one undo step). */
  function arrange(doc, defs, o = {}) {
    const D = defsOf(defs, o.project), p = plan(doc, D, o);
    let moved = apply(doc, D, p.moves, o.project), optimised = false;
    // Optional: autoplace refines the packed result (one short proposal, scope selected).
    const P = globalThis.AtriumAutoplace;
    if (o.optimise && P?.propose && outlineOf(doc) && p.moves.length) {
      try {
        const res = P.propose(o.project, doc, D, {scope: "selected", components: p.moves.map(m => m.id), alternatives: 1, timeLimitMs: o.timeLimitMs || 800,
          constraints: Array.isArray(o.region) ? {region: p.region} : {}});
        const alt = res.alternatives?.[0];
        if (alt?.moves?.length) { P.applyMoves(doc, D, alt.moves); optimised = true; }
      } catch { /* the packed result stands */ }
    }
    return {...p, moved, optimised};
  }
  const plural = (n, w) => globalThis.AtriumI18n?.plural?.(n, w) ?? n + " " + w + (n === 1 ? "" : "s");
  function summary(r, where) {
    if (!r.moves.length && !r.failed.length) return r.locked?.length ? "Locked components are not moved." : "Nothing to arrange: every component is already inside the board. Select components to rearrange them.";
    return "Arranged " + plural(r.moved ?? r.moves.length, "component") + " " + where + (r.failed.length ? " · " + r.failed.length + " did not fit" : "") + (r.locked?.length ? " · " + r.locked.length + " locked" : "") + (r.optimised ? " · refined by Auto Place" : "") + ".";
  }

  // Editor entry. ctx: {doc, defs, project, selection:[ids], edit, info, pickPoint, select}.
  async function command(action, ctx) {
    const doc = ctx.doc, D = defsOf(ctx.defs, ctx.project);
    const chosen = (ctx.selection || []).filter(id => doc.items.some(i => i.id === id && i.kind === "part"));
    const ids = chosen.length ? chosen : unplaced(doc, D);
    const run = (o, where) => {
      let r = null;
      // Both packing and its optional refinement move only the chosen board footprints.
      const selected = new Set(ids);
      try { ctx.edit(() => { r = arrange(doc, D, {...o, ids, project: ctx.project}); }, undefined, doc.items.filter(i => selected.has(i.id))); }
      catch (e) { ctx.info(e.message); return null; }
      ctx.info(summary(r, where));
      if (r.moves.length) ctx.select?.(r.moves.map(m => m.id));
      return r;
    };
    if (action === "arrange-board") {
      if (!outlineOf(doc)) { ctx.info("Set the board shape first (Design › Board Shape), or use Arrange Within Rectangle."); return null; }
      if (!ids.length) { ctx.info("Nothing to arrange: every component is already inside the board. Select components to rearrange them."); return null; }
      return run({region: "board"}, "inside the board");
    }
    if (action === "arrange-rect") {
      if (!ids.length) { ctx.info("Select the components to arrange."); return null; }
      if (!ctx.pickPoint) { ctx.info("Arrange Within Rectangle needs the board canvas."); return null; }
      const a = await ctx.pickPoint("Arrange Within Rectangle: click the first corner (" + plural(ids.length, "component") + ").");
      if (!a) return null;
      const b = await ctx.pickPoint("Click the opposite corner.");
      if (!b) return null;
      return run({region: [a[0], a[1], b[0], b[1]]}, "inside the rectangle");
    }
    return null;
  }
  return Object.freeze({plan, apply, arrange, unplaced, command, summary, partBox, worldBox});
})();
