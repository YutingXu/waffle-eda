"use strict";
// AtriumDrawingViews: geometry and painting for drawing documents (drawing.js). DOM-free:
// the same code paints a sheet on the editor canvas (sheet millimetres in world space) and
// into AtriumPDF's recording context for vector PDF, so the screen and the PDF agree.
//
// Board geometry comes from the fabrication analysis (AtriumFabOutputs.analyse): the outline,
// cutouts and arcs of the board shape, every drill hit (with the same size groups and symbols
// as the drill table), component bodies, pads, designators and values, the layer stack, and the
// mesh of the 3D export for the isometric view. It is read live: views and dimensions follow
// the board whenever it changes.
//
// Sheet coordinates are millimetres from the paper's top-left corner, Y down.
//   geometry(project, boardDoc)          -> board geometry G (cached per board and revision by drawing.js)
//   frame(view, G) / box(view, G, ctx)   -> view transform and its box on the sheet
//   paintSheet(ctx, project, doc, sheet, env)  frame, title block, views, dimensions, callouts
//   resolve(anchor, G) / snaps(G, kind)  dimension anchors, live
//   measure(dim, layout)                 dimension values and drawing geometry (ordinate labels staggered)
//   Linked views: a detail view magnifies a circle of its parent board/assembly view; a section view
//   is the profile along a cutting line A–A of its parent (board, holes, layer stack, components).
//   Break lines (view.options.breaks) squeeze ranges out of a long board or assembly view.
globalThis.AtriumDrawingViews = (() => {
  const A = () => globalThis.Atrium;
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const TAU = Math.PI * 2;
  const FAMILY = "'DejaVu Sans', Verdana, Helvetica, Arial, sans-serif";
  const font = (size, bold) => (bold ? "bold " : "") + r4(size) + "px " + FAMILY;
  // ISO 128 line widths (mm) and lettering (ISO 3098) used throughout.
  const LW = {thin: .18, medium: .25, thick: .35, heavy: .5};
  const TEXT = 2.5, SMALL = 1.8;

  // ------------------------------------------------------------------ sheets
  // Landscape width × height (mm), border margin, zones across × down. Names match the
  // schematic sheet templates (sch-appearance.js), which drawing documents also use.
  const SIZES = Object.freeze({
    "A4": [297, 210, 10, 6, 4], "A3": [420, 297, 10, 8, 6], "A2": [594, 420, 10, 12, 8], "A1": [841, 594, 20, 16, 12], "A0": [1189, 841, 20, 24, 16],
    "ANSI A": [279.4, 215.9, 10, 4, 4], "ANSI B": [431.8, 279.4, 10, 8, 4], "ANSI C": [558.8, 431.8, 10, 8, 6], "ANSI D": [863.6, 558.8, 20, 12, 8], "ANSI E": [1117.6, 863.6, 20, 16, 12]
  });
  function sheetSize(sheet) {
    const s = SIZES[sheet?.size] || SIZES.A3, portrait = sheet?.orientation === "portrait";
    return {w: portrait ? s[1] : s[0], h: portrait ? s[0] : s[1], margin: s[2], zx: portrait ? s[4] : s[3], zy: portrait ? s[3] : s[4], size: SIZES[sheet?.size] ? sheet.size : "A3"};
  }
  const SCALES = [20, 10, 5, 4, 2, 1.5, 1, .75, .5, .4, .25, .2, .1, .05];
  const ratio = s => !(s > 0) ? "" : s >= 1 ? +s.toFixed(3) + ":1" : "1:" + +(1 / s).toFixed(3);
  // The largest standard scale at which w × h fits in avail.
  const fitScale = (w, h, aw, ah) => SCALES.find(s => w * s <= aw && h * s <= ah) || SCALES.at(-1);

  // ------------------------------------------------------------------ text
  // Text width for layout: the PDF writer's metrics (the embedded font when it is loaded),
  // so tables are laid out the same on screen, headless and in the PDF.
  function textWidth(text, size) {
    const P = globalThis.AtriumPDF;
    if (P?.runs) return P.runs(String(text ?? ""), "H").width * size;
    let w = 0;
    for (const ch of String(text ?? "")) w += /[il.,:;'|!1 ]/.test(ch) ? .3 : /[MWmw@%]/.test(ch) ? .85 : /[A-Z]/.test(ch) ? .68 : .56;
    return w * size;
  }
  function wrap(text, size, width) {
    const out = [];
    for (const para of String(text ?? "").split(/\n/)) {
      let line = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = line ? line + " " + word : word;
        if (line && textWidth(next, size) > width) { out.push(line); line = word; } else line = next;
      }
      out.push(line);
    }
    return out;
  }

  // ------------------------------------------------------------------ board geometry
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const keyOfHole = h => (h.plated ? "P" : "N") + h.d.toFixed(3);
  function outlineOf(points) { return (points || []).filter(p => Array.isArray(p) && fin(p[0]) && fin(p[1])).map(p => [p[0], p[1]]); }
  function rotPts(pts, at, angle) {
    const c = Math.cos(angle * Math.PI / 180), s = Math.sin(angle * Math.PI / 180);
    return pts.map(p => [at[0] + p[0] * c - p[1] * s, at[1] + p[0] * s + p[1] * c]);
  }
  // Everything a drawing reads from a board, in board millimetres (Y down).
  function geometry(project, board, options = {}) {
    const F = globalThis.AtriumFabOutputs, Ah = A();
    if (!F) throw Error("Drawings need the fabrication outputs module (fab-outputs.js).");
    const model = F.analyse(project, board.id, options.variant !== undefined ? {variant: options.variant} : undefined);
    const outline = outlineOf(model.outline), BS = globalThis.AtriumBoardShape;
    let cutouts = [], arcs = [];
    const shape = model.boardShape;
    if (shape && BS?.flatten) {
      try { cutouts = BS.flatten(shape).cutouts.map(outlineOf).filter(c => c.length >= 3); } catch { cutouts = []; }
      const seg = (s, where, i) => s.kind === "arc" && fin(s.r) && s.r > 0 && arcs.push({c: [s.c[0], s.c[1]], r: s.r, where, i, full: s.start === s.end});
      (shape.contour || []).forEach((s, i) => seg(s, "contour", i));
      (shape.cutouts || []).forEach((c, k) => c.forEach((s, i) => seg(s, k, i)));
    }
    const extents = model.extents && model.extents.every(fin) ? model.extents.slice() : outline.length ? Ah.bounds(outline) : [0, 0, 50, 40];
    if (!(extents[2] > extents[0])) extents[2] = extents[0] + 1;
    if (!(extents[3] > extents[1])) extents[3] = extents[1] + 1;
    // Drill hits grouped by finished size and plating, smallest first: group n has symbol n.
    const groups = new Map();
    const holes = [];
    // Vias carry their board item ID (when it is a free via) and net, so anchors can follow a via
    // that moved and still find one that was re-imported with a new ID at the same place.
    const viaIds = new Map(), spot = p => p[0].toFixed(3) + "," + p[1].toFixed(3);
    for (const it of board.items || []) if (it?.kind === "via" && fin(it.x) && fin(it.y) && !viaIds.has(spot([it.x, it.y]))) viaIds.set(spot([it.x, it.y]), String(it.id ?? ""));
    const seen = new Map();
    let stacked = 0;
    for (const h of model.drills) {
      if (h.backdrill || !(h.d > 0)) continue;
      const k = keyOfHole(h), at = [h.at[0], h.at[1]], here = k + "@" + spot(at);
      if (!groups.has(k)) groups.set(k, {d: h.d, plated: !!h.plated, count: 0, vias: 0});
      const g = groups.get(k); g.count++; if (h.via) g.vias++;
      if (seen.has(here)) stacked++; else seen.set(here, true);
      holes.push({at, d: h.d, plated: !!h.plated, via: !!h.via, ref: h.ref || null, pin: h.pin ?? null, key: k, net: String(h.net ?? ""), id: h.via && !h.ref ? viaIds.get(spot(at)) || null : null});
    }
    const drill = [...groups.entries()].sort((a, b) => a[1].d - b[1].d || b[1].plated - a[1].plated).map(([k, g], n) => ({...g, key: k, symbol: n}));
    const symbolOf = new Map(drill.map(g => [g.key, g.symbol]));
    for (const h of holes) h.symbol = symbolOf.get(h.key);
    // Components: bodies from mechanical or overlay shapes, pads, designator and value.
    const PCB = globalThis.AtriumPCBAppearance, parts = [];
    for (const {item, fp, side} of model.parts) {
      const body = [], pads = [], circles = [];
      const layerOf = sh => PCB?.shapeLayer ? PCB.shapeLayer(item, sh) : sh.layer || "";
      const overlay = PCB?.overlay ? PCB.overlay(item) : side === "Bottom" ? "Bottom silk" : "Silk";
      const mech = (fp.shapes || []).filter(sh => sh.kind !== "text" && sh.kind !== "label" && /^Mechanical/.test(layerOf(sh)));
      for (const sh of mech.length ? mech : (fp.shapes || []).filter(sh => sh.kind !== "text" && sh.kind !== "label" && layerOf(sh) === overlay)) {
        if (sh.kind === "circle" && sh.r > 0) { circles.push({c: Ah.world([sh.x, sh.y], item), r: sh.r}); continue; }
        const pts = (sh.points || []).map(p => Ah.world(p, item));
        if (pts.length >= 2) body.push({pts, closed: !!(sh.closed || sh.fill)});
      }
      for (const p of fp.pads || []) {
        const w = p.w || p.diameter, h = p.h || p.diameter;
        if (!(w > 0 && h > 0)) continue;
        const at = Ah.world([p.x, p.y], item), shapeName = F.padShape ? F.padShape(p.shape, w, h) || "rect" : "rect";
        const local = F.padGeom && F.padOutline ? F.padOutline(F.padGeom(shapeName, w, h, 0)) : [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]];
        pads.push(rotPts(local, at, (item.angle || 0) + (p.angle || 0)));
      }
      const pts = [...body.flatMap(b => b.pts), ...circles.flatMap(c => [[c.c[0] - c.r, c.c[1] - c.r], [c.c[0] + c.r, c.c[1] + c.r]])];
      const box = Ah.bounds(pts.length ? pts : pads.flat()) || [item.x - .5, item.y - .5, item.x + .5, item.y + .5];
      parts.push({id: item.id, ref: String(item.ref ?? ""), value: String(item.value ?? ""), side, at: [item.x, item.y], angle: item.angle || 0,
        body, circles, pads, box, dnp: !!model.dnp?.has?.(item), outline: !body.length && !circles.length});
    }
    let stack = null;
    try { stack = globalThis.AtriumStackup?.get?.(board, model.defs) || null; } catch { stack = null; }
    return {board, project, model, outline, cutouts, arcs, extents, holes, drill, parts, stack, stacked, thickness: stack ? stack.layers.reduce((s, l) => s + (l.thickness || 0), 0) : null};
  }

  // ------------------------------------------------------------------ isometric
  // A vector isometric of the 3D export's mesh (AtriumSTEP.model/mesh): flat-shaded triangles
  // seen from the front-right-top, painter-sorted, back faces dropped.
  const ISO = (() => {
    const s2 = Math.SQRT1_2, s3 = 1 / Math.sqrt(3), s6 = 1 / Math.sqrt(6);
    return {r: [s2, s2, 0], u: [-s6, s6, 2 * s6], d: [s3, -s3, s3], light: (() => { const v = [.35, -.5, 1], n = Math.hypot(...v); return v.map(x => x / n); })()};
  })();
  function isometric(project, board, options = {}) {
    const S = globalThis.AtriumSTEP;
    if (!S?.model || !S?.mesh) return null;
    const m = S.model(project, board, {copper: false, silk: false, holes: true, deterministic: true, ...(options.variant !== undefined ? {variant: options.variant} : {})});
    const mesh = S.mesh(m, {tolerance: .05}), tris = [];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    for (const part of mesh.parts) {
      const M = part.matrix, P = part.positions, I = part.indices, col = part.color || [.5, .5, .5];
      const at = i => { const x = P[i * 3], y = P[i * 3 + 1], z = P[i * 3 + 2]; return [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]]; };
      for (let t = 0; t + 2 < I.length; t += 3) {
        const a = at(I[t]), b = at(I[t + 1]), c = at(I[t + 2]);
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const len = Math.hypot(...n);
        if (!(len > 1e-12)) continue;
        n = n.map(x => x / len);
        if (dot(n, ISO.d) <= 1e-6) continue;
        const k = .38 + .62 * Math.max(0, dot(n, ISO.light));
        tris.push({p: [a, b, c].map(q => [dot(q, ISO.r), -dot(q, ISO.u)]), z: (dot(a, ISO.d) + dot(b, ISO.d) + dot(c, ISO.d)) / 3,
          c: "rgb(" + col.map(x => Math.round(Math.min(1, Math.max(0, x)) * k * 255)).join(",") + ")"});
      }
    }
    tris.sort((a, b) => a.z - b.z);
    let box = null;
    for (const t of tris) for (const p of t.p) box = box ? [Math.min(box[0], p[0]), Math.min(box[1], p[1]), Math.max(box[2], p[0]), Math.max(box[3], p[1])] : [p[0], p[1], p[0], p[1]];
    return {tris, box: box || [0, 0, 10, 10], parts: mesh.stats.parts, triangles: tris.length};
  }
  // Component heights for section views (mm above the board surface), by part ID: generated bodies
  // from the 3D export carry their height; parts with a 3D model use its bounding box.
  function heights(project, board, options = {}) {
    const S = globalThis.AtriumSTEP, out = new Map();
    if (!S?.model) return out;
    const m = S.model(project, board, {copper: false, silk: false, holes: false, deterministic: true, ...(options.variant !== undefined ? {variant: options.variant} : {})});
    for (const p of m.parts || []) {
      let h = fin(p.height) && p.height > 0 ? p.height : p.body && fin(p.body.z1) && fin(p.body.z0) ? p.body.z1 - p.body.z0 : null;
      if (!(h > 0) && p.model?.data) {
        try {
          const one = S.mesh({...m, parts: [p], board: null}, {tolerance: .2}).parts;
          let lo = Infinity, hi = -Infinity;
          for (const q of one) { const P = q.positions, M = q.matrix; for (let i = 0; i < P.length; i += 3) { const z = M[2] * P[i] + M[6] * P[i + 1] + M[10] * P[i + 2] + M[14]; if (z < lo) lo = z; if (z > hi) hi = z; } }
          if (hi > lo) h = hi - lo;
        } catch { h = null; }
      }
      if (p.id != null && h > 0) out.set(String(p.id), r4(h));
    }
    return out;
  }

  // ------------------------------------------------------------------ view frames
  const BOARD_TYPES = new Set(["board", "assembly"]);
  // Views drawn through a board frame (dimensions and callouts attach to them): board, assembly and
  // detail views. Section views are profiles along a cut, with their own layout.
  const FRAMED = new Set(["board", "assembly", "detail"]);
  const LINKED = new Set(["section", "detail"]);
  // Forward compatibility: views, dimensions and anchors of a kind a newer Waffle wrote are kept as
  // they are (drawing.js normalize) and drawn as a labelled placeholder box, never measured.
  const VIEW_TYPES = new Set(["board", "assembly", "isometric", "drill-table", "layer-stack", "bom", "notes", "revisions", "section", "detail"]);
  const DIM_TYPES = new Set(["linear", "radial", "ordinate"]), ANCHOR_KINDS = new Set(["corner", "vertex", "cutout", "hole", "part", "arc", "point"]);
  const newerView = view => !VIEW_TYPES.has(view?.type);
  const newerAnchor = a => a !== null && typeof a === "object" && !Array.isArray(a) && !ANCHOR_KINDS.has(a.k);
  const newerDimension = m => !DIM_TYPES.has(m?.type) || [m.a, m.b, ...(Array.isArray(m.points) ? m.points : [])].some(newerAnchor);
  const PLACEHOLDER = [70, 24];
  // The board or assembly view a section or detail view is taken from.
  function parentOf(view, ctx) {
    if (!view?.parent || !ctx?.drawing) return null;
    return (ctx.drawing.views || []).find(v => v.id === view.parent && BOARD_TYPES.has(v.type)) || null;
  }
  // Break lines: the removed ranges of a board or assembly view, per axis, in board millimetres,
  // clamped to the board, sorted and merged. Each break leaves a BREAK_GAP (sheet mm) gap.
  const BREAK_GAP = 5;
  function breaksOf(view, e) {
    const out = {x: [], y: []};
    for (const b of Array.isArray(view?.options?.breaks) ? view.options.breaks : []) {
      if (!b || (b.axis !== "x" && b.axis !== "y") || !fin(b.from) || !fin(b.to)) continue;
      const lo = b.axis === "x" ? e[0] : e[1], hi = b.axis === "x" ? e[2] : e[3];
      const f = Math.max(lo, Math.min(b.from, b.to)), t = Math.min(hi, Math.max(b.from, b.to));
      if (t - f > 1e-6) out[b.axis].push([f, t]);
    }
    for (const k of ["x", "y"]) {
      out[k].sort((a, b) => a[0] - b[0]);
      const m = [];
      for (const r of out[k]) { const last = m.at(-1); if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]); else m.push(r.slice()); }
      out[k] = m;
    }
    return out;
  }
  // A monotone 1D squeeze: each removed range [f, t] (in u, from the view's near edge) shrinks to
  // `gap`, linearly, so the mapping stays continuous and invertible.
  function squeezer(list, gap) {
    const fwd = u => { let shift = 0; for (const [f, t] of list) { if (u >= t) { shift += t - f - gap; continue; } if (u > f) return f - shift + gap * (u - f) / (t - f); break; } return u - shift; };
    const inv = w => { let shift = 0; for (const [f, t] of list) { const wf = f - shift; if (w >= wf + gap) { shift += t - f - gap; continue; } if (w > wf) return f + (w - wf) * (t - f) / gap; break; } return w + shift; };
    return {fwd, inv, list};
  }
  // Board point -> sheet point for a board, assembly or detail view; bottom views (and details of
  // them) are mirrored, and break lines squeeze out their ranges. F.pieces are the kept rectangles
  // (u ranges per axis) for painting each piece clipped at its break edges.
  function frame(view, G, ctx) {
    const s = view.scale > 0 ? view.scale : 1, detail = view.type === "detail";
    const src = detail ? parentOf(view, ctx) || {type: "board"} : view, mirror = src.type === "assembly" && src.side === "Bottom";
    const r = detail && view.radius > 0 ? view.radius : 0;
    const e = detail && Array.isArray(view.center) ? [view.center[0] - r, view.center[1] - r, view.center[0] + r, view.center[1] + r] : G.extents;
    const B = detail ? {x: [], y: []} : breaksOf(view, e), gx = BREAK_GAP / s;
    const bx = B.x.map(([f, t]) => mirror ? [e[2] - t, e[2] - f] : [f - e[0], t - e[0]]).sort((a, b) => a[0] - b[0]), by = B.y.map(([f, t]) => [f - e[1], t - e[1]]);
    const SX = squeezer(bx, gx), SY = squeezer(by, gx), W = e[2] - e[0], Hh = e[3] - e[1];
    const ux = x => mirror ? e[2] - x : x - e[0];
    const map = p => [view.x + SX.fwd(ux(p[0])) * s, view.y + SY.fwd(p[1] - e[1]) * s];
    const unmap = q => { const u = SX.inv((q[0] - view.x) / s); return [mirror ? e[2] - u : e[0] + u, e[1] + SY.inv((q[1] - view.y) / s)]; };
    const keep = (list, len) => { const out = []; let a = 0; for (const [f, t] of list) { out.push([a, f]); a = t; } out.push([a, len]); return out; };
    const pieces = [];
    if (bx.length || by.length) for (const px of keep(bx, W)) for (const py of keep(by, Hh)) pieces.push({ux: px, uy: py});
    return {s, mirror, e, map, unmap, pieces, breaks: B, sx: SX, sy: SY, src, w: SX.fwd(W) * s, h: SY.fwd(Hh) * s, gap: BREAK_GAP,
      // An affine frame for one piece (painting) and its clip rectangle on the sheet.
      piece(pc) {
        const ox = view.x + SX.fwd(pc.ux[0]) * s - pc.ux[0] * s, oy = view.y + SY.fwd(pc.uy[0]) * s - pc.uy[0] * s, far = 1e4;
        const x0 = pc.ux[0] > 0 ? view.x + SX.fwd(pc.ux[0]) * s : -far, x1 = pc.ux[1] < W ? view.x + SX.fwd(pc.ux[1]) * s : far;
        const y0 = pc.uy[0] > 0 ? view.y + SY.fwd(pc.uy[0]) * s : -far, y1 = pc.uy[1] < Hh ? view.y + SY.fwd(pc.uy[1]) * s : far;
        return {s, mirror, e, map: p => [ox + ux(p[0]) * s, oy + (p[1] - e[1]) * s], clip: [x0, y0, x1, y1]};
      }};
  }
  const tableText = view => TEXT * (view.scale > 0 ? view.scale : 1);
  // Table content: header row + rows, with column widths fitted to the text.
  function tableOf(view, ctx) {
    const G = ctx.geometry(view), k = view.scale > 0 ? view.scale : 1, out = {title: "", head: [], rows: [], foot: null, symbols: false, note: ""};
    if (view.type === "drill-table") {
      out.title = "DRILL TABLE"; out.symbols = true;
      out.head = ["Symbol", "Finished ⌀ (mm)", "Count", "Plating", "Tolerance (mm)"];
      out.rows = G.drill.map(g => [g.symbol, g.d.toFixed(3), String(g.count), g.plated ? "Plated" : "Non-plated", g.plated ? "±0.08" : "±0.05"]);
      out.foot = ["", "Total", String(G.drill.reduce((n, g) => n + g.count, 0)), "", ""];
      if (!out.rows.length) out.note = "The board has no holes.";
    } else if (view.type === "layer-stack") {
      out.title = "LAYER STACK";
      out.head = ["#", "Layer", "Type", "Material", "Thickness (mm)", "Dk"];
      const layers = G.stack?.layers || [];
      let cu = 0;
      out.rows = layers.filter(l => l.type !== "Overlay" || view.options?.overlay).map(l => [l.type === "Signal" || l.type === "Plane" ? String(++cu) : "", l.name || "", l.type === "Dielectric" ? l.dielectric || "Dielectric" : l.type || "",
        l.material || "", fin(l.thickness) && l.thickness > 0 ? l.thickness.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : "", fin(l.dk) ? String(l.dk) : ""]);
      out.foot = ["", "Total", "", "", G.thickness != null ? G.thickness.toFixed(3) : "", ""];
      if (!layers.length) out.note = "No layer stack.";
    } else if (view.type === "bom") {
      out.title = "BILL OF MATERIALS";
      const B = globalThis.AtriumBOM;
      if (!B?.report) { out.note = "The BOM module is not loaded."; }
      else {
        let r = null;
        try { r = B.report(ctx.project, {columns: ["line", "quantity", "designator", "comment", "footprint"], ...(ctx.date ? {now: ctx.date.toISOString()} : {})}); } catch (e) { out.note = e.message; }
        if (r) {
          const max = Math.max(1, Math.min(200, view.options?.rows || 40));
          out.head = r.columns.map(c => c.label);
          out.rows = r.rows.slice(0, max).map(row => row.map(v => String(v ?? "")));
          if (r.rows.length > max) out.note = "+ " + (r.rows.length - max) + " more lines (see the BOM output)";
          out.foot = null;
        }
      }
    } else if (view.type === "revisions") {
      out.title = "REVISIONS";
      out.head = ["Rev", "Description", "Date", "By"];
      out.rows = (ctx.drawing.revisions || []).map(r => [r.rev || "", r.description || "", r.date || "", r.by || ""]);
      if (!out.rows.length) out.note = "No revisions yet.";
    }
    const size = TEXT * k, pad = 1.2 * k, rowH = size * 1.9;
    const cols = out.head.map((h, i) => Math.max(textWidth(h, size * .85), ...out.rows.map(r => i === 0 && out.symbols ? size * 1.6 : textWidth(r[i], size)), out.foot ? textWidth(out.foot[i], size) : 0) + pad * 2);
    if (view.type === "revisions" && cols[1] != null) cols[1] = Math.max(cols[1], 60 * k);
    const w = Math.max(cols.reduce((a, b) => a + b, 0), textWidth(out.title, size) + pad * 2, out.note ? textWidth(out.note, size * .8) + pad * 2 : 0);
    const h = rowH * (1 + (out.head.length ? 1 : 0) + out.rows.length + (out.foot ? 1 : 0)) + (out.note ? rowH : 0);
    return {...out, cols, w, h, size, rowH, pad};
  }
  // Tables are rebuilt only when the drawing or the board changes (ctx.memo, kept by the editor).
  const tab = (view, ctx) => ctx.memo ? ctx.memo(view, "t|" + view.type + "|" + view.scale + "|" + (view.board || "") + "|" + JSON.stringify(view.options || {}), () => tableOf(view, ctx)) : tableOf(view, ctx);
  function notesOf(view, ctx) {
    const k = view.scale > 0 ? view.scale : 1, size = TEXT * k, width = (view.options?.width > 20 ? view.options.width : 130) * k;
    const lines = [];
    (ctx.drawing.notes || []).forEach((n, i) => wrap(n.text, size, width - size * 2.2).forEach((l, j) => lines.push({num: j ? "" : String(i + 1) + ".", text: l})));
    const rowH = size * 1.6;
    return {title: "NOTES", lines, size, rowH, w: width, h: rowH * (lines.length + 1.4) + (lines.length ? 0 : rowH)};
  }
  const notes = (view, ctx) => ctx.memo ? ctx.memo(view, "n|" + view.scale + "|" + view.options?.width, () => notesOf(view, ctx)) : notesOf(view, ctx);
  // The box a view takes on the sheet.
  function box(view, ctx) {
    const k = view.scale > 0 ? view.scale : 1;
    if (newerView(view)) { const x = fin(view.x) ? view.x : 20, y = fin(view.y) ? view.y : 20; return [x, y, x + PLACEHOLDER[0], y + PLACEHOLDER[1]]; }
    if (BOARD_TYPES.has(view.type)) {
      const G = ctx.geometry(view), F = frame(view, G, ctx), cap = view.options?.caption === false ? 0 : 7;
      return [view.x, view.y, view.x + F.w, view.y + F.h + cap];
    }
    if (view.type === "detail") {
      const d = 2 * (view.radius > 0 ? view.radius : 1) * k, cap = view.options?.caption === false ? 0 : 7;
      return [view.x, view.y, view.x + d, view.y + d + cap];
    }
    if (view.type === "section") {
      const S = sectionOf(view, ctx), cap = view.options?.caption === false ? 0 : 7;
      return [view.x, view.y, view.x + S.w, view.y + S.h + cap];
    }
    if (view.type === "isometric") {
      const I = ctx.iso(view);
      const w = I ? I.box[2] - I.box[0] : 60, h = I ? I.box[3] - I.box[1] : 40, cap = view.options?.caption === false ? 0 : 7;
      return [view.x, view.y, view.x + w * k, view.y + h * k + cap];
    }
    if (view.type === "notes") { const n = notes(view, ctx); return [view.x, view.y, view.x + n.w, view.y + n.h]; }
    const t = tab(view, ctx);
    return [view.x, view.y, view.x + t.w, view.y + t.h];
  }

  // ------------------------------------------------------------------ painting helpers
  function poly(c, pts, closed) {
    c.beginPath();
    pts.forEach((p, i) => i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1]));
    if (closed) c.closePath();
  }
  const lw = (env, w) => Math.max(w, env.px || 0);
  function text(c, env, str, x, y, size, o = {}) {
    if (str == null || str === "") return;
    if (env.px && size / env.px < 1.6) return;   // too small to read on screen
    c.save();
    c.font = font(size, o.bold);
    c.textAlign = o.align || "left"; c.textBaseline = o.baseline || "alphabetic"; c.fillStyle = o.ink || env.ink;
    c.translate(x, y); if (o.angle) c.rotate(o.angle);
    if (o.max > 0) c.fillText(String(str), 0, 0, o.max); else c.fillText(String(str), 0, 0);
    c.restore();
  }
  // Drill symbols: ten shapes, then the shapes again with a letter (as in print.js).
  function symbol(c, n, x, y, r) {
    c.beginPath();
    const polyN = (k, a0) => { for (let i = 0; i < k; i++) { const a = a0 + i * TAU / k; i ? c.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)) : c.moveTo(x + r * Math.cos(a), y + r * Math.sin(a)); } c.closePath(); };
    const cross = (k, a0) => { for (let i = 0; i < k; i++) { const a = a0 + i * TAU / k; c.moveTo(x, y); c.lineTo(x + r * Math.cos(a), y + r * Math.sin(a)); } };
    switch (n % 10) {
      case 0: c.arc(x, y, r, 0, TAU); c.moveTo(x - r, y); c.lineTo(x + r, y); c.moveTo(x, y - r); c.lineTo(x, y + r); break;
      case 1: c.rect(x - r * .8, y - r * .8, r * 1.6, r * 1.6); break;
      case 2: polyN(3, -Math.PI / 2); break;
      case 3: polyN(4, 0); break;
      case 4: cross(4, Math.PI / 4); break;
      case 5: cross(4, 0); break;
      case 6: c.moveTo(x + r, y); c.arc(x, y, r, 0, TAU); break;
      case 7: polyN(6, 0); break;
      case 8: c.rect(x - r * .8, y - r * .8, r * 1.6, r * 1.6); cross(4, Math.PI / 4); break;
      default: polyN(3, Math.PI / 2);
    }
    c.stroke();
    if (n >= 10) { c.save(); c.font = font(r * 1.1, true); c.textAlign = "center"; c.textBaseline = "middle"; c.fillStyle = c.strokeStyle; c.fillText(String.fromCharCode(65 + (n - 10) % 26), x, y); c.restore(); }
  }
  function arrow(c, tip, dir, len, width) {
    const n = Math.hypot(dir[0], dir[1]) || 1, ux = dir[0] / n, uy = dir[1] / n;
    c.beginPath(); c.moveTo(tip[0], tip[1]);
    c.lineTo(tip[0] - ux * len - uy * width / 2, tip[1] - uy * len + ux * width / 2);
    c.lineTo(tip[0] - ux * len + uy * width / 2, tip[1] - uy * len - ux * width / 2);
    c.closePath(); c.fill();
  }

  // ------------------------------------------------------------------ sheet frame and title block
  // Title block: a Waffle layout (company and title, approvals, drawing number, revision,
  // size, scale, sheet, project, board and units), 180 × 36 mm in the lower-right corner.
  const TB = {w: 180, h: 36};
  function titleFields(ctx, sheetIndex) {
    const {project, doc, drawing} = ctx, own = drawing.parameters || {}, P = project.parameters, proj = {};
    if (Array.isArray(P)) { for (const p of P) if (p && typeof p.name === "string") proj[p.name.toLowerCase()] = String(p.value ?? ""); }
    else if (plain(P)) for (const [k, v] of Object.entries(P)) proj[k.toLowerCase()] = String(v ?? "");
    const ownLower = {};
    for (const [k, v] of Object.entries(own)) ownLower[k.toLowerCase()] = String(v ?? "");
    const get = (...names) => { for (const n of names) { const k = n.toLowerCase(); if (ownLower[k]) return ownLower[k]; if (proj[k]) return proj[k]; } return ""; };
    const revs = drawing.revisions || [], last = revs.at(-1);
    const board = ctx.boardDoc?.() || null, sheets = drawing.sheets || [], sheet = sheets[sheetIndex] || sheets[0];
    const main = (drawing.views || []).find(v => v.sheet === sheet?.id && BOARD_TYPES.has(v.type));
    const date = ctx.date instanceof Date ? ctx.date : new Date();
    // Board revisions (revisions.js) and assembly variants (variants.js), when those modules are
    // loaded: the working revision's letter, status and date, and the variant the drawing shows.
    let rv = {}, variant = "";
    try { rv = globalThis.AtriumRevisions?.fields?.(project) || {}; } catch { rv = {}; }
    try {
      const VA = globalThis.AtriumVariants, v = VA?.current?.(project, ctx.variant);
      variant = v ? String(v.name || "") : VA?.list?.(project)?.length ? "Base design" : "";
    } catch { variant = typeof ctx.variant === "string" ? ctx.variant : ""; }
    return {variant, revisionStatus: !last && !ownLower.revision && rv.Revision ? String(rv.RevisionStatus || "") : "",
      company: get("CompanyName", "Company"), title: get("Title") || doc.name, number: get("DocumentNumber", "DrawingNumber"),
      revision: last?.rev || ownLower.revision || rv.Revision || (plain(project.revision) && typeof project.revision.letter === "string" ? project.revision.letter : "") || get("Revision"), drawn: get("DrawnBy", "Author"), checked: get("CheckedBy"), approved: get("ApprovedBy"),
      date: last?.date || get("Date") || rv.RevisionDate || (ctx.dateText ?? date.toISOString().slice(0,10)), size: sheetSize(sheet).size, scale: main ? ratio(main.scale) : "NTS",
      sheet: (sheetIndex + 1) + " of " + Math.max(1, sheets.length), project: project.name || "", board: board?.name || "", units: "mm"};
  }
  function frameAndTitle(c, ctx, sheet, sheetIndex, env) {
    const S = sheetSize(sheet), m = S.margin, w = S.w, h = S.h;
    c.fillStyle = env.paper; c.fillRect(0, 0, w, h);
    c.strokeStyle = env.ink; c.fillStyle = env.ink;
    c.lineWidth = lw(env, LW.heavy); c.strokeRect(m, m, w - 2 * m, h - 2 * m);
    // Zone grid: numbers across, letters down, ticks into the margin; centring marks.
    c.lineWidth = lw(env, LW.thin); c.beginPath();
    for (let i = 1; i < S.zx; i++) { const x = m + (w - 2 * m) * i / S.zx; c.moveTo(x, m * .4); c.lineTo(x, m); c.moveTo(x, h - m); c.lineTo(x, h - m * .4); }
    for (let i = 1; i < S.zy; i++) { const y = m + (h - 2 * m) * i / S.zy; c.moveTo(m * .4, y); c.lineTo(m, y); c.moveTo(w - m, y); c.lineTo(w - m * .4, y); }
    c.stroke();
    c.lineWidth = lw(env, LW.medium); c.beginPath();
    c.moveTo(w / 2, 0); c.lineTo(w / 2, m * .8); c.moveTo(w / 2, h); c.lineTo(w / 2, h - m * .8); c.moveTo(0, h / 2); c.lineTo(m * .8, h / 2); c.moveTo(w, h / 2); c.lineTo(w - m * .8, h / 2);
    c.stroke();
    const zs = Math.min(3, m * .32);
    for (let i = 0; i < S.zx; i++) { const x = m + (w - 2 * m) * (i + .5) / S.zx; text(c, env, String(i + 1), x, m * .62, zs, {align: "center", baseline: "middle"}); text(c, env, String(i + 1), x, h - m * .62, zs, {align: "center", baseline: "middle"}); }
    for (let i = 0; i < S.zy; i++) { const y = m + (h - 2 * m) * (i + .5) / S.zy, L = "ABCDEFGHJKLMNPQRSTUVWXYZ"[i] || "?"; text(c, env, L, m * .62, y, zs, {align: "center", baseline: "middle"}); text(c, env, L, w - m * .62, y, zs, {align: "center", baseline: "middle"}); }
    if (sheet.titleBlock === false) return;
    const f = titleFields(ctx, sheetIndex), x0 = w - m - TB.w, y0 = h - m - TB.h;
    c.fillStyle = env.paper; c.fillRect(x0, y0, TB.w, TB.h);
    c.strokeStyle = env.ink; c.lineWidth = lw(env, LW.thick); c.strokeRect(x0, y0, TB.w, TB.h);
    // Rows (mm from the top): 12 | 8 | 8 | 8.
    const rows = [[0, 12, [[0, 60, "Company", f.company, 3.2, true], [60, 120, "Title", f.title, 4, true]]],
      [12, 8, [[0, 45, "Drawn", f.drawn, TEXT], [45, 45, "Checked", f.checked, TEXT], [90, 45, "Approved", f.approved, TEXT], [135, 45, "Date", f.date, TEXT]]],
      [20, 8, [[0, 70, "Drawing number", f.number, 3, true], [70, 18, f.revisionStatus ? "Rev · " + f.revisionStatus : "Rev", f.revision, 3, true], [88, 22, "Size", f.size, TEXT], [110, 34, "Scale", f.scale, TEXT], [144, 36, "Sheet", f.sheet, TEXT]]],
      [28, 8, [[0, 60, "Project", f.project, TEXT], [60, 50, "Board", f.board, TEXT], [110, 45, "Variant", f.variant, TEXT], [155, 25, "Units", f.units, TEXT]]]];
    c.lineWidth = lw(env, LW.thin); c.beginPath();
    for (const [y, hh, cells] of rows) {
      if (y) { c.moveTo(x0, y0 + y); c.lineTo(x0 + TB.w, y0 + y); }
      for (const [x] of cells) if (x) { c.moveTo(x0 + x, y0 + y); c.lineTo(x0 + x, y0 + y + hh); }
    }
    c.stroke();
    for (const [y, hh, cells] of rows) for (const [x, cw, cap, val, size, bold] of cells) {
      text(c, env, cap, x0 + x + .8, y0 + y + .6, 1.5, {baseline: "top", ink: env.muted || env.ink});
      text(c, env, val, x0 + x + 1.2, y0 + y + hh - 1.3, Math.min(size, hh * .5), {bold, max: cw - 2.4});
    }
  }

  // ------------------------------------------------------------------ views
  function caption(c, env, view, b, label) {
    if (view.options?.caption === false) return;
    const k = Math.min(1.4, Math.max(.8, view.scale > 0 ? 1 : 1));
    text(c, env, label, (b[0] + b[2]) / 2, b[3] - 2.2, 3 * k, {align: "center", bold: true});
    c.lineWidth = lw(env, LW.thin); c.beginPath();
    const w = Math.min(b[2] - b[0], textWidth(label, 3 * k) + 4);
    c.moveTo((b[0] + b[2]) / 2 - w / 2, b[3] - 1.2); c.lineTo((b[0] + b[2]) / 2 + w / 2, b[3] - 1.2); c.stroke();
  }
  // Board and assembly content through a frame F (the whole view, one piece of a broken view, or a
  // detail view's magnified window). `src` is the view whose type, side and options apply.
  function boardContent(c, G, F, o, env) {
    const s = F.s, M = F.map;
    c.strokeStyle = env.ink; c.fillStyle = env.ink; c.lineJoin = "round"; c.lineCap = "round";
    if (G.outline.length >= 3) { c.lineWidth = lw(env, LW.heavy); poly(c, G.outline.map(M), true); c.stroke(); }
    c.lineWidth = lw(env, LW.thick);
    for (const cut of G.cutouts) { poly(c, cut.map(M), true); c.stroke(); }
    if (o.drillSymbols !== false) {
      c.lineWidth = lw(env, LW.thin);
      const r = Math.max(.6, Math.min(1.6, 1.1 * Math.sqrt(s)));
      for (const h of G.holes) { const p = M(h.at); symbol(c, h.symbol, p[0], p[1], r); }
    } else {
      c.lineWidth = lw(env, LW.thin);
      for (const h of G.holes) { const p = M(h.at); c.beginPath(); c.arc(p[0], p[1], Math.max(.15, h.d / 2 * s), 0, TAU); c.stroke(); }
    }
  }
  function assemblyContent(c, G, F, o, env, src) {
    const s = F.s, M = F.map, side = src.side === "Bottom" ? "Bottom" : "Top";
    c.strokeStyle = env.ink; c.fillStyle = env.ink; c.lineJoin = "round"; c.lineCap = "round";
    if (G.outline.length >= 3) { c.lineWidth = lw(env, LW.thick); poly(c, G.outline.map(M), true); c.stroke(); }
    c.lineWidth = lw(env, LW.medium);
    for (const cut of G.cutouts) { poly(c, cut.map(M), true); c.stroke(); }
    const mine = G.parts.filter(p => p.side === side);
    if (o.pads !== false) {
      c.fillStyle = env.faint || "#c8c8c8";
      for (const p of mine) for (const pad of p.pads) { poly(c, pad.map(M), true); c.fill(); }
      c.fillStyle = env.ink;
    }
    c.lineWidth = lw(env, LW.medium);
    for (const p of mine) {
      for (const b of p.body) { poly(c, b.pts.map(M), b.closed); c.stroke(); }
      for (const ci of p.circles) { const q = M(ci.c); c.beginPath(); c.arc(q[0], q[1], ci.r * s, 0, TAU); c.stroke(); }
      if (p.outline) {
        const b = [M([p.box[0], p.box[1]]), M([p.box[2], p.box[3]])];
        c.save(); c.setLineDash([.6, .4]); c.strokeRect(Math.min(b[0][0], b[1][0]), Math.min(b[0][1], b[1][1]), Math.abs(b[1][0] - b[0][0]), Math.abs(b[1][1] - b[0][1])); c.restore();
      }
      if (p.dnp) {
        const a = M([p.box[0], p.box[1]]), b = M([p.box[2], p.box[3]]);
        c.save(); c.strokeStyle = env.dnp || "#c0281e"; c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.moveTo(b[0], a[1]); c.lineTo(a[0], b[1]); c.stroke(); c.restore();
      }
    }
    // Designators (and values) centred on the body, sized to fit it, turned with tall parts.
    const showValues = !!o.values;
    for (const p of mine) {
      if (o.designators === false && !showValues) break;
      const a = M([p.box[0], p.box[1]]), b = M([p.box[2], p.box[3]]), bw = Math.abs(b[0] - a[0]), bh = Math.abs(b[1] - a[1]);
      const tall = bh > bw * 1.3, len = tall ? bh : bw, thick = tall ? bw : bh, cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2;
      const label = o.designators === false ? "" : p.ref, value = showValues ? p.value : "";
      const n = Math.max(1, Math.max(label.length, value.length));
      let size = Math.max(.8, Math.min(2.5 * Math.max(1, Math.sqrt(s)), (len * .9) / (n * .62), thick * (value && label ? .38 : .7)));
      const ang = tall ? -Math.PI / 2 : 0;
      if (label && value) { text(c, env, label, cx + (tall ? -size * .55 : 0), cy - (tall ? 0 : size * .55), size, {align: "center", baseline: "middle", bold: true, angle: ang});
        text(c, env, value, cx + (tall ? size * .55 : 0), cy + (tall ? 0 : size * .6), size * .8, {align: "center", baseline: "middle", angle: ang}); }
      else text(c, env, label || value, cx, cy, size, {align: "center", baseline: "middle", bold: !!label, angle: ang});
    }
  }
  const contentOf = type => type === "assembly" ? assemblyContent : boardContent;
  // A straight break line with one zigzag in the middle (ISO 128 thin freehand/zigzag line).
  function zigzag(c, p, q) {
    const dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1, ux = dx / L, uy = dy / L, nx = -uy, ny = ux, m = L / 2, a = Math.min(1.8, L * .12);
    const at = (t, o) => [p[0] + ux * t + nx * o, p[1] + uy * t + ny * o];
    const pts = [at(0, 0), at(m - a, 0), at(m - a / 3, a * 1.3), at(m + a / 3, -a * 1.3), at(m + a, 0), at(L, 0)];
    c.moveTo(pts[0][0], pts[0][1]); for (const q2 of pts.slice(1)) c.lineTo(q2[0], q2[1]);
  }
  function breakLines(c, view, F, env) {
    const over = 2, s = F.s;
    c.save(); c.strokeStyle = env.ink; c.lineWidth = lw(env, LW.thin); c.lineCap = "butt"; c.beginPath();
    for (const [f] of F.sx.list) { const x = view.x + F.sx.fwd(f) * s; for (const xx of [x, x + F.gap]) zigzag(c, [xx, view.y - over], [xx, view.y + F.h + over]); }
    for (const [f] of F.sy.list) { const y = view.y + F.sy.fwd(f) * s; for (const yy of [y, y + F.gap]) zigzag(c, [view.x - over, yy], [view.x + F.w + over, yy]); }
    c.stroke(); c.restore();
  }
  // A board or assembly view, piece by piece when it has break lines, then the marks of the section
  // and detail views taken from it.
  function paintFramed(c, view, ctx, env, src) {
    const G = ctx.geometry(view), F = frame(view, G, ctx), o = src.options || {}, paint = contentOf(src.type);
    if (!F.pieces.length) paint(c, G, F, o, env, src);
    else {
      for (const pc of F.pieces) {
        const P = F.piece(pc);
        c.save(); c.beginPath(); c.rect(P.clip[0], P.clip[1], P.clip[2] - P.clip[0], P.clip[3] - P.clip[1]); c.clip();
        paint(c, G, P, o, env, src);
        c.restore();
      }
      breakLines(c, view, F, env);
    }
    return F;
  }
  function paintBoard(c, view, ctx, env) {
    const F = paintFramed(c, view, ctx, env, view);
    linkMarks(c, view, ctx, F, env);
    caption(c, env, view, box(view, ctx), view.title || "BOARD — FABRICATION VIEW  " + ratio(F.s));
  }
  function paintAssembly(c, view, ctx, env) {
    const F = paintFramed(c, view, ctx, env, view), side = view.side === "Bottom" ? "Bottom" : "Top";
    linkMarks(c, view, ctx, F, env);
    caption(c, env, view, box(view, ctx), view.title || (side === "Bottom" ? "BOTTOM ASSEMBLY (VIEWED FROM BOTTOM)  " : "TOP ASSEMBLY  ") + ratio(F.s));
  }

  // ------------------------------------------------------------------ detail and section views
  // Letters for section and detail views (ASME Y14.5 / ISO 128: I, O, Q, S, X and Z are skipped).
  const LETTERS = "ABCDEFGHJKLMNPRTUVWY";
  const letterAt = n => (n >= LETTERS.length ? letterAt(Math.floor(n / LETTERS.length) - 1) : "") + LETTERS[n % LETTERS.length];
  // A detail view: the parent's content, magnified, inside a circle.
  function paintDetail(c, view, ctx, env) {
    const P = parentOf(view, ctx), b = box(view, ctx), s = view.scale > 0 ? view.scale : 1, r = (view.radius > 0 ? view.radius : 1) * s;
    if (!P) { text(c, env, "Detail view: its parent view is gone.", view.x, view.y + 4, TEXT, {ink: env.dnp || "#c0281e"}); return; }
    const G = ctx.geometry(view), F = frame(view, G, ctx), cx = view.x + r, cy = view.y + r;
    c.save(); c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.clip();
    contentOf(P.type)(c, G, F, P.options || {}, env, P);
    c.restore();
    c.save(); c.strokeStyle = env.ink; c.lineWidth = lw(env, LW.medium); c.beginPath(); c.arc(cx, cy, r, 0, TAU); c.stroke(); c.restore();
    caption(c, env, view, b, view.title || "DETAIL " + (view.label || "?") + "  " + ratio(s));
  }
  function inside(poly2, p) {
    let hit = false;
    for (let i = 0, j = poly2.length - 1; i < poly2.length; j = i++) {
      const a = poly2[i], b = poly2[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  }
  const COPPER = new Set(["Signal", "Plane"]), HATCHED = new Set(["Dielectric", "Coverlay", "Adhesive", "Core", "Prepreg"]);
  // The profile along a section's cutting line: solid board intervals (outline minus cutouts and
  // drilled holes), plated barrels, the components the line crosses with their heights, and the
  // layer stack. t runs from a to b in board millimetres.
  function sectionBuild(view, ctx) {
    const G = ctx.geometry(view), s = view.scale > 0 ? view.scale : 1, e = G.extents;
    const zs = fin(view.options?.zscale) && view.options.zscale >= 1 ? Math.min(50, view.options.zscale) : 1;
    const a = Array.isArray(view.a) && view.a.every(fin) ? view.a : [e[0], (e[1] + e[3]) / 2], b = Array.isArray(view.b) && view.b.every(fin) ? view.b : [e[2], (e[1] + e[3]) / 2];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, u = [(b[0] - a[0]) / L, (b[1] - a[1]) / L];
    const ts = [0, L];
    for (const pl of [G.outline, ...G.cutouts]) for (let i = 0; i < pl.length; i++) {
      const p = pl[i], q = pl[(i + 1) % pl.length], ex = q[0] - p[0], ey = q[1] - p[1], den = u[0] * ey - u[1] * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((p[0] - a[0]) * ey - (p[1] - a[1]) * ex) / den, w = ((p[0] - a[0]) * u[1] - (p[1] - a[1]) * u[0]) / den;
      if (w >= -1e-9 && w <= 1 + 1e-9 && t > 0 && t < L) ts.push(t);
    }
    ts.sort((x, y) => x - y);
    let solid = [];
    for (let i = 0; i + 1 < ts.length; i++) {
      const t0 = ts[i], t1 = ts[i + 1];
      if (t1 - t0 < 1e-6) continue;
      const m = [a[0] + u[0] * (t0 + t1) / 2, a[1] + u[1] * (t0 + t1) / 2];
      if (G.outline.length >= 3 && inside(G.outline, m) && !G.cutouts.some(cut => inside(cut, m))) { const last = solid.at(-1); if (last && Math.abs(last[1] - t0) < 1e-6) last[1] = t1; else solid.push([t0, t1]); }
    }
    const cuts = [];
    for (const h of G.holes) {
      const rx = h.at[0] - a[0], ry = h.at[1] - a[1], along = rx * u[0] + ry * u[1], perp = Math.abs(rx * u[1] - ry * u[0]), r = h.d / 2;
      if (perp >= r || along < -r || along > L + r) continue;
      const half = Math.sqrt(r * r - perp * perp);
      cuts.push({t0: along - half, t1: along + half, plated: h.plated});
    }
    cuts.sort((x, y) => x.t0 - y.t0);
    for (const k of cuts) solid = solid.flatMap(([t0, t1]) => k.t1 <= t0 || k.t0 >= t1 ? [[t0, t1]] : [[t0, k.t0], [k.t1, t1]].filter(([x, y]) => y - x > 1e-6));
    const H = ctx.heights ? ctx.heights(view) : new Map(), parts = [];
    for (const p of G.parts) {
      // The line's parameter interval inside the part's box (slab clipping).
      let t0 = 0, t1 = L;
      for (const k of [0, 1]) {
        if (Math.abs(u[k]) < 1e-12) { if (a[k] < p.box[k] || a[k] > p.box[k + 2]) { t0 = 1; t1 = 0; } continue; }
        let lo = (p.box[k] - a[k]) / u[k], hi = (p.box[k + 2] - a[k]) / u[k];
        if (lo > hi) [lo, hi] = [hi, lo];
        t0 = Math.max(t0, lo); t1 = Math.min(t1, hi);
      }
      if (t1 - t0 > 1e-6) parts.push({ref: p.ref, side: p.side, t0, t1, h: H.get(String(p.id)) || 1, dnp: p.dnp});
    }
    const T = G.thickness > 0 ? G.thickness : 1.6;
    const layers = (G.stack?.layers || []).filter(l => l.thickness > 0 && l.type !== "Overlay" && l.type !== "Surface Finish");
    const Ht = Math.max(0, ...parts.filter(p => p.side !== "Bottom").map(p => p.h)), Hb = Math.max(0, ...parts.filter(p => p.side === "Bottom").map(p => p.h));
    const k = s * zs, sum = layers.reduce((n, l) => n + l.thickness, 0);
    return {a, b, u, L, s, zs, k, solid, cuts, parts, layers, scaleZ: sum > 0 ? T / sum : 1, T, Ht, Hb, top: Ht * k, w: L * s, h: (Ht + T + Hb) * k};
  }
  function sectionOf(view, ctx) {
    const key = "s|" + JSON.stringify([view.a, view.b, view.scale, view.options || {}, view.board || "", view.parent || ""]);
    return ctx.memo ? ctx.memo(view, key, () => sectionBuild(view, ctx)) : sectionBuild(view, ctx);
  }
  function hatch(c, env, x0, y0, x1, y1, step) {
    if (x1 - x0 <= 0 || y1 - y0 <= 0) return;
    c.save(); c.beginPath(); c.rect(x0, y0, x1 - x0, y1 - y0); c.clip();
    c.lineWidth = lw(env, LW.thin * .7); c.beginPath();
    const hgt = y1 - y0;
    for (let x = x0 - hgt; x < x1; x += step) { c.moveTo(x, y1); c.lineTo(x + hgt, y0); }
    c.stroke(); c.restore();
  }
  function paintSection(c, view, ctx, env) {
    const P = parentOf(view, ctx), b = box(view, ctx);
    if (!P) { text(c, env, "Section view: its parent view is gone.", view.x, view.y + 4, TEXT, {ink: env.dnp || "#c0281e"}); return; }
    const S = sectionOf(view, ctx), x0 = view.x, top = view.y + S.top, k = S.k, s = S.s, bottom = top + S.T * k;
    const X = t => x0 + t * s;
    c.strokeStyle = env.ink; c.fillStyle = env.ink; c.lineJoin = "miter"; c.lineCap = "butt";
    for (const [t0, t1] of S.solid) {
      const xa = X(t0), xb = X(t1);
      if (S.layers.length) {
        let z = top;
        for (const l of S.layers) {
          const th = l.thickness * S.scaleZ * k;
          if (COPPER.has(l.type)) { if (th >= .25) c.fillRect(xa, z, xb - xa, th); else { c.lineWidth = lw(env, LW.thick); c.beginPath(); c.moveTo(xa, z + th / 2); c.lineTo(xb, z + th / 2); c.stroke(); } }
          else if (HATCHED.has(l.type)) hatch(c, env, xa, z, xb, z + th, Math.max(.6, Math.min(1.5, th)));
          else { c.save(); c.fillStyle = env.faint || "#c8c8c8"; c.fillRect(xa, z, xb - xa, th); c.restore(); }
          z += th;
        }
      } else hatch(c, env, xa, top, xb, bottom, 1);
      c.lineWidth = lw(env, LW.thick); c.strokeRect(xa, top, xb - xa, bottom - top);
    }
    // Plated holes: the copper barrel at each side of the cut hole.
    c.lineWidth = lw(env, LW.medium); c.beginPath();
    for (const h of S.cuts) if (h.plated) for (const t of [h.t0, h.t1]) if (t > 0 && t < S.L) { c.moveTo(X(t), top); c.lineTo(X(t), bottom); }
    c.stroke();
    // Components the cut crosses, standing on their side of the board.
    c.lineWidth = lw(env, LW.medium);
    for (const p of S.parts) {
      const h = p.h * k, y = p.side === "Bottom" ? bottom : top - h, xa = X(Math.max(0, p.t0)), xb = X(Math.min(S.L, p.t1));
      c.save(); c.fillStyle = env.faint || "#c8c8c8"; c.globalAlpha = .55; c.fillRect(xa, y, xb - xa, h); c.restore();
      c.strokeRect(xa, y, xb - xa, h);
      const size = Math.min(2.2, (xb - xa) / Math.max(1, p.ref.length * .62), Math.max(h * .8, 1.2));
      if (size >= .8) text(c, env, p.ref, (xa + xb) / 2, p.side === "Bottom" ? y + h / 2 : y + h / 2, size, {align: "center", baseline: "middle"});
    }
    caption(c, env, view, b, view.title || "SECTION " + (view.label || "?") + "–" + (view.label || "?") + "  " + ratio(s) + (S.zs !== 1 ? "  (VERTICAL ×" + +S.zs.toFixed(2) + ")" : ""));
  }
  // On a parent view: the cutting plane of each section (thin chain, thick ends, arrows in the
  // viewing direction, letters) and the circle of each detail, with its letter.
  function linkMarks(c, view, ctx, F, env) {
    const kids = (ctx.drawing.views || []).filter(v => v.parent === view.id && LINKED.has(v.type));
    if (!kids.length) return;
    c.save(); c.strokeStyle = env.ink; c.fillStyle = env.ink; c.lineCap = "butt";
    for (const v of kids) {
      const label = v.label || "?";
      if (v.type === "detail" && Array.isArray(v.center)) {
        const q = F.map(v.center), r = (v.radius > 0 ? v.radius : 1) * F.s;
        c.lineWidth = lw(env, LW.thin); c.beginPath(); c.arc(q[0], q[1], r, 0, TAU); c.stroke();
        text(c, env, label, q[0] + (r + 1.2) * Math.SQRT1_2, q[1] - (r + 1.2) * Math.SQRT1_2, 3.5, {bold: true, align: "left", baseline: "bottom"});
      } else if (v.type === "section") {
        let S; try { S = sectionOf(v, ctx); } catch { continue; }
        const A = F.map(S.a), B = F.map(S.b), L = Math.hypot(B[0] - A[0], B[1] - A[1]) || 1, ux = (B[0] - A[0]) / L, uy = (B[1] - A[1]) / L, end = Math.min(4, L / 3);
        // Viewing direction: to the right of a → b in board coordinates, mirrored with the view.
        const d0 = [S.u[1], -S.u[0]], d = [F.mirror ? -d0[0] : d0[0], d0[1]], dn = Math.hypot(d[0], d[1]) || 1, dx = d[0] / dn, dy = d[1] / dn;
        c.lineWidth = lw(env, LW.thin); c.setLineDash([6, 1, 1, 1]); c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(B[0], B[1]); c.stroke(); c.setLineDash([]);
        c.lineWidth = lw(env, LW.heavy); c.beginPath(); c.moveTo(A[0], A[1]); c.lineTo(A[0] + ux * end, A[1] + uy * end); c.moveTo(B[0], B[1]); c.lineTo(B[0] - ux * end, B[1] - uy * end); c.stroke();
        c.lineWidth = lw(env, LW.medium);
        for (const p of [A, B]) {
          const tail = [p[0] - dx * 7, p[1] - dy * 7], tip = [p[0] - dx * .6, p[1] - dy * .6];
          c.beginPath(); c.moveTo(tail[0], tail[1]); c.lineTo(tip[0], tip[1]); c.stroke();
          arrow(c, tip, [dx, dy], 2.2, 1);
          text(c, env, label, p[0] - dx * 9.6, p[1] - dy * 9.6, 3.5, {bold: true, align: "center", baseline: "middle"});
        }
      }
    }
    c.restore();
  }
  function paintIsometric(c, view, ctx, env) {
    const I = ctx.iso(view), s = view.scale > 0 ? view.scale : 1, b = box(view, ctx);
    if (!I) { text(c, env, "3D view needs the 3D export module.", view.x, view.y + 4, TEXT); return; }
    const M = p => [view.x + (p[0] - I.box[0]) * s, view.y + (p[1] - I.box[1]) * s];
    c.lineJoin = "round"; c.lineWidth = lw(env, .04);
    for (const t of I.tris) {
      const p = t.p.map(M);
      c.fillStyle = t.c; c.strokeStyle = t.c;
      poly(c, p, true); c.fill(); c.stroke();
    }
    caption(c, env, view, b, view.title || "ISOMETRIC VIEW (NOT TO SCALE)");
  }
  function paintTable(c, view, ctx, env) {
    const t = tab(view, ctx), x0 = view.x, y0 = view.y;
    c.strokeStyle = env.ink; c.fillStyle = env.ink;
    let y = y0;
    // Title row spans the table.
    c.lineWidth = lw(env, LW.thick); c.strokeRect(x0, y0, t.w, t.h);
    text(c, env, t.title, x0 + t.w / 2, y + t.rowH * .68, t.size, {align: "center", bold: true});
    y += t.rowH;
    c.lineWidth = lw(env, LW.thin);
    const rowLine = yy => { c.beginPath(); c.moveTo(x0, yy); c.lineTo(x0 + t.w, yy); c.stroke(); };
    rowLine(y);
    const colX = [x0]; for (const w of t.cols) colX.push(colX.at(-1) + w);
    const stretch = t.cols.length ? (t.w - (colX.at(-1) - x0)) : 0;
    if (stretch > 0) colX[colX.length - 1] += stretch;
    const bodyTop = y, bodyBottom = y0 + t.h - (t.note ? t.rowH : 0);
    if (t.head.length) {
      t.head.forEach((h, i) => text(c, env, h, colX[i] + t.pad, y + t.rowH * .66, t.size * .85, {bold: true, max: colX[i + 1] - colX[i] - t.pad * 1.5}));
      y += t.rowH; c.lineWidth = lw(env, LW.medium); rowLine(y); c.lineWidth = lw(env, LW.thin);
    }
    for (const r of t.rows) {
      r.forEach((v, i) => {
        if (i === 0 && t.symbols) { c.lineWidth = lw(env, LW.thin); symbol(c, +v, colX[0] + (colX[1] - colX[0]) / 2, y + t.rowH / 2, t.size * .5); return; }
        const right = /^[\d.±+-]+$/.test(v) && i > 0;
        text(c, env, v, right ? colX[i + 1] - t.pad : colX[i] + t.pad, y + t.rowH * .66, t.size, {align: right ? "right" : "left", max: colX[i + 1] - colX[i] - t.pad * 1.5});
      });
      y += t.rowH; rowLine(y);
    }
    if (t.foot) {
      c.lineWidth = lw(env, LW.medium); rowLine(y); c.lineWidth = lw(env, LW.thin);
      t.foot.forEach((v, i) => { const right = /^[\d.]+$/.test(v); text(c, env, v, right ? colX[i + 1] - t.pad : colX[i] + t.pad, y + t.rowH * .66, t.size, {align: right ? "right" : "left", bold: true}); });
      y += t.rowH;
    }
    c.beginPath();
    for (let i = 1; i < colX.length - 1; i++) { c.moveTo(colX[i], bodyTop); c.lineTo(colX[i], Math.min(y, bodyBottom)); }
    c.stroke();
    if (t.note) text(c, env, t.note, x0 + t.pad, y0 + t.h - t.rowH * .35, t.size * .8, {ink: env.muted || env.ink});
  }
  function paintNotes(c, view, ctx, env) {
    const n = notes(view, ctx);
    c.fillStyle = env.ink;
    text(c, env, n.title, view.x, view.y + n.rowH * .8, n.size * 1.1, {bold: true});
    n.lines.forEach((l, i) => {
      const y = view.y + n.rowH * (i + 1.9);
      text(c, env, l.num, view.x + n.size * 1.6, y, n.size, {align: "right"});
      text(c, env, l.text, view.x + n.size * 2.2, y, n.size);
    });
    if (!n.lines.length) text(c, env, "No notes yet.", view.x, view.y + n.rowH * 1.9, n.size, {ink: env.muted || env.ink});
  }
  function paintNewer(c, view, ctx, env) {
    const b = box(view, ctx), ink = env.muted || env.ink;
    c.strokeStyle = ink; c.lineWidth = LW.thin; c.setLineDash?.([2, 1.2]);
    c.strokeRect(b[0], b[1], b[2] - b[0], b[3] - b[1]);
    c.setLineDash?.([]);
    text(c, env, "View from a newer version", (b[0] + b[2]) / 2, (b[1] + b[3]) / 2 - 1, TEXT, {align: "center", ink});
    text(c, env, String(view.type ?? "").slice(0, 40), (b[0] + b[2]) / 2, (b[1] + b[3]) / 2 + TEXT * 1.4, TEXT * .8, {align: "center", ink});
  }
  function paintView(c, view, ctx, env) {
    c.save();
    try {
      if (newerView(view)) paintNewer(c, view, ctx, env);
      else if (view.type === "board") paintBoard(c, view, ctx, env);
      else if (view.type === "assembly") paintAssembly(c, view, ctx, env);
      else if (view.type === "isometric") paintIsometric(c, view, ctx, env);
      else if (view.type === "detail") paintDetail(c, view, ctx, env);
      else if (view.type === "section") paintSection(c, view, ctx, env);
      else if (view.type === "notes") paintNotes(c, view, ctx, env);
      else paintTable(c, view, ctx, env);
    } catch (e) {
      c.restore(); c.save();
      text(c, env, view.type + ": " + (e.message || e), view.x, view.y + 4, TEXT, {ink: env.dnp || "#c0281e"});
    }
    c.restore();
  }

  // ------------------------------------------------------------------ anchors and dimensions
  const CORNERS = {tl: [0, 1], tr: [2, 1], bl: [0, 3], br: [2, 3]};
  // An anchor names board geometry; it resolves against the board as it is now.
  //   {k:"corner", c:"tl"|"tr"|"bl"|"br"|"c"}  board extents
  //   {k:"vertex", i}                          outline vertex
  //   {k:"cutout", i, j}                       cutout vertex
  //   {k:"hole", ref, pin} | {k:"hole", at, id?, net?, d?}
  //                                            pad hole by designator and pin; a via (or other free hole) by
  //                                            its board item ID, else by position (within 0.25 mm, same size
  //                                            first), else the nearest via of the same net and size within
  //                                            2 mm: a re-imported via (new ID) or a nudged one keeps its anchor
  //   {k:"part", ref}                          component origin
  //   {k:"arc", where, i}                      board-shape arc (centre, radius)
  //   {k:"point", at}                          a fixed board point
  // Every anchor also keeps `at`, its last position, for anchors whose geometry is gone.
  function resolve(a, G) {
    if (!a || typeof a !== "object") return null;
    const e = G.extents, at = Array.isArray(a.at) && a.at.every(fin) ? a.at : null;
    const lost = at ? {p: at, ok: false} : null;
    switch (a.k) {
      case "corner": { if (a.c === "c") return {p: [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2], ok: true}; const c = CORNERS[a.c]; return c ? {p: [e[c[0]], e[c[1]]], ok: true} : lost; }
      case "vertex": { const v = G.outline[a.i]; return v ? {p: v, ok: true} : lost; }
      case "cutout": { const v = G.cutouts[a.i]?.[a.j]; return v ? {p: v, ok: true} : lost; }
      case "hole": {
        let h = null;
        if (a.ref != null) h = G.holes.find(x => x.ref === a.ref && String(x.pin) === String(a.pin));
        else {
          if (a.id) h = G.holes.find(x => x.id != null && x.id === a.id) || null;
          const sized = x => !fin(a.d) || Math.abs(x.d - a.d) <= 1e-3;
          const near = (list, tol, pen) => { let best = Infinity, hit = null; for (const x of list) { const d = Math.hypot(x.at[0] - at[0], x.at[1] - at[1]); if (d < tol && d + pen(x) < best) { best = d + pen(x); hit = x; } } return hit; };
          if (!h && at) h = near(G.holes, .25, x => sized(x) ? 0 : .5);
          if (!h && at && a.net) h = near(G.holes.filter(x => x.via && x.net === a.net && sized(x)), 2, () => 0);
        }
        return h ? {p: h.at, r: h.d / 2, ok: true, hole: h} : lost;
      }
      case "part": { const p = G.parts.find(x => x.ref === a.ref); return p ? {p: p.at, ok: true} : lost; }
      case "arc": { const x = G.arcs.find(q => String(q.where) === String(a.where) && q.i === a.i); return x ? {p: x.c, r: x.r, ok: true} : lost; }
      case "point": return at ? {p: at, ok: true} : null;
      default: return lost;
    }
  }
  // Snap candidates of a view, board coordinates. Radial dimensions snap to circles only.
  function snaps(G, kind, view) {
    const out = [], e = G.extents;
    if (kind !== "circle") {
      for (const c of ["tl", "tr", "bl", "br", "c"]) out.push({a: {k: "corner", c}, p: c === "c" ? [(e[0] + e[2]) / 2, (e[1] + e[3]) / 2] : [e[CORNERS[c][0]], e[CORNERS[c][1]]], label: c === "c" ? "board centre" : "board corner"});
      G.outline.forEach((p, i) => out.push({a: {k: "vertex", i}, p, label: "outline vertex"}));
      G.cutouts.forEach((cut, i) => cut.forEach((p, j) => out.push({a: {k: "cutout", i, j}, p, label: "cutout vertex"})));
      if (view?.type === "assembly") for (const p of G.parts) if (p.side === (view.side === "Bottom" ? "Bottom" : "Top")) out.push({a: {k: "part", ref: p.ref}, p: p.at, label: p.ref});
    }
    for (const h of G.holes) out.push({a: h.ref != null ? {k: "hole", ref: h.ref, pin: h.pin} : {k: "hole", at: h.at, ...(h.id ? {id: h.id} : {}), ...(h.net ? {net: h.net} : {}), d: h.d},
      p: h.at, r: h.d / 2, label: (h.ref ? h.ref + "." + h.pin + " " : h.via ? "via " : "") + "⌀" + h.d.toFixed(2)});
    G.arcs.forEach(x => out.push({a: {k: "arc", where: x.where, i: x.i}, p: x.c, r: x.r, label: "arc R" + x.r.toFixed(2)}));
    return out;
  }
  const fmt = (v, d) => (Math.round(v * 10 ** d) / 10 ** d).toFixed(d);
  // The geometry of one dimension on the sheet: lines, arrows, text, value. null when its view is gone.
  function measure(dim, ctx) {
    const view = (ctx.drawing.views || []).find(v => v.id === dim.view);
    if (!view || !FRAMED.has(view.type) || newerDimension(dim)) return null;
    const G = ctx.geometry(view), F = frame(view, G, ctx), d = fin(dim.precision) ? Math.max(0, Math.min(4, dim.precision)) : 2, out = {lines: [], arrows: [], texts: [], ok: true, value: null};
    const label = v => { const t = typeof dim.text === "string" && dim.text ? dim.text.replace(/<>/g, v) : v; return t; };
    const ext = .9, gap = .7, AL = 2.2, AW = .75, TS = TEXT;
    if (dim.type === "linear") {
      const A1 = resolve(dim.a, G), B1 = resolve(dim.b, G);
      if (!A1 || !B1) return null;
      out.ok = A1.ok && B1.ok;
      const a = F.map(A1.p), b = F.map(B1.p), axis = dim.axis === "y" ? "y" : dim.axis === "aligned" ? "aligned" : "x", off = fin(dim.offset) ? dim.offset : -8;
      let p1, p2, value, dir, nrm;
      if (axis === "x") { const y = Math.min(a[1], b[1]) + off; p1 = [a[0], y]; p2 = [b[0], y]; value = Math.abs(B1.p[0] - A1.p[0]); dir = [1, 0]; nrm = [0, 1]; }
      else if (axis === "y") { const x = Math.min(a[0], b[0]) + off; p1 = [x, a[1]]; p2 = [x, b[1]]; value = Math.abs(B1.p[1] - A1.p[1]); dir = [0, 1]; nrm = [1, 0]; }
      else {
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; dir = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; nrm = [-dir[1], dir[0]];
        p1 = [a[0] + nrm[0] * off, a[1] + nrm[1] * off]; p2 = [b[0] + nrm[0] * off, b[1] + nrm[1] * off]; value = Math.hypot(B1.p[0] - A1.p[0], B1.p[1] - A1.p[1]);
      }
      // Extension lines from the feature (with a gap) to just past the dimension line.
      for (const [f, q] of [[a, p1], [b, p2]]) {
        const vx = q[0] - f[0], vy = q[1] - f[1], L = Math.hypot(vx, vy);
        if (L > gap) out.lines.push([[f[0] + vx / L * gap, f[1] + vy / L * gap], [q[0] + vx / L * ext, q[1] + vy / L * ext]]);
      }
      const span = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]), u = span ? [(p2[0] - p1[0]) / span, (p2[1] - p1[1]) / span] : dir;
      out.lines.push([p1, p2]);
      if (span > AL * 2.4) { out.arrows.push([p1, [-u[0], -u[1]]], [p2, u]); }
      else { out.arrows.push([p1, u], [p2, [-u[0], -u[1]]]); out.lines.push([[p1[0] - u[0] * AL * 2, p1[1] - u[1] * AL * 2], p1], [p2, [p2[0] + u[0] * AL * 2, p2[1] + u[1] * AL * 2]]); }
      out.value = value;
      const mid = [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2], ang = Math.atan2(u[1], u[0]), up = ang > Math.PI / 2 + 1e-6 || ang <= -Math.PI / 2 + 1e-6;
      const rot = up ? ang + Math.PI : ang, side = axis === "y" ? [-1, 0] : [0, -1];
      const tn = axis === "aligned" ? [Math.sin(rot), -Math.cos(rot)] : side;
      out.texts.push({s: label(fmt(value, d)), at: [mid[0] + tn[0] * .8, mid[1] + tn[1] * .8], angle: axis === "y" ? -Math.PI / 2 : axis === "aligned" ? rot : 0, size: TS});
    } else if (dim.type === "radial") {
      const C = resolve(dim.a, G);
      if (!C || !(C.r > 0)) return null;
      out.ok = C.ok;
      const c = F.map(C.p), r = C.r * F.s, ang = (fin(dim.angle) ? dim.angle : 45) * Math.PI / 180, dir = [Math.cos(ang), -Math.sin(ang)], off = fin(dim.offset) ? dim.offset : 6;
      const diameter = dim.kind !== "radius", value = diameter ? C.r * 2 : C.r;
      const edge = [c[0] + dir[0] * r, c[1] + dir[1] * r], far = [c[0] + dir[0] * (r + off), c[1] + dir[1] * (r + off)];
      const shelf = [far[0] + (dir[0] >= 0 ? 4 : -4), far[1]];
      if (diameter) { const opp = [c[0] - dir[0] * r, c[1] - dir[1] * r]; out.lines.push([opp, edge]); out.arrows.push([opp, [-dir[0], -dir[1]]]); }
      else out.lines.push([c, edge]);
      out.lines.push([edge, far], [far, shelf]);
      out.arrows.push([edge, dir]);
      out.value = value;
      out.texts.push({s: label((diameter ? "⌀" : "R") + fmt(value, d)), at: [shelf[0] + (dir[0] >= 0 ? .6 : -.6), shelf[1] - .6], align: dir[0] >= 0 ? "left" : "right", angle: 0, size: TS});
    } else if (dim.type === "ordinate") {
      const O = resolve(dim.a, G);
      if (!O) return null;
      const pts = (Array.isArray(dim.points) ? dim.points : []).map(p => resolve(p, G)).filter(Boolean);
      out.ok = O.ok && pts.every(p => p.ok);
      const axis = dim.axis === "y" ? "y" : "x", b = box(view, ctx), off = fin(dim.offset) ? dim.offset : 6, values = [];
      // Values from the origin feature: X to the right, Y up (board Y runs down).
      const rows = [];
      for (const P1 of [O, ...pts]) {
        const q = F.map(P1.p), v = axis === "x" ? P1.p[0] - O.p[0] : O.p[1] - P1.p[1];
        values.push(v);
        rows.push({q, v, pos: axis === "x" ? q[0] : q[1]});
      }
      // Staggering: labels along the ordinate line keep at least one text height apart. Crowded
      // labels move apart (centred on their cluster) and their leaders jog over a short run, so
      // labels never overlap; features at the same coordinate share one label.
      const pitch = TS * 1.25, lead = axis === "x" ? b[1] - off : b[0] - off, jog = Math.min(3, Math.max(1.5, off * .35));
      const order = rows.map((r, i) => i).sort((i, j) => rows[i].pos - rows[j].pos || i - j), slots = [];
      for (const i of order) {
        const r = rows[i], last = slots.at(-1);
        if (last && Math.abs(last.pos - r.pos) < 1e-6 && fmt(last.v, d) === fmt(r.v, d)) { last.members.push(i); continue; }
        slots.push({pos: r.pos, v: r.v, members: [i], at: r.pos});
      }
      // Clusters: a run of slots closer than the pitch is spread evenly about its mean position.
      for (let i = 0; i < slots.length;) {
        let j = i + 1;
        while (j < slots.length && slots[j].pos - slots[j - 1].pos < pitch - 1e-9) j++;
        if (j - i > 1) {
          const span = (j - i - 1) * pitch, mean = slots.slice(i, j).reduce((n, s) => n + s.pos, 0) / (j - i);
          let start = mean - span / 2;
          if (i > 0) start = Math.max(start, slots[i - 1].at + pitch);
          for (let k = i; k < j; k++) slots[k].at = start + (k - i) * pitch;
        } else if (i > 0) slots[i].at = Math.max(slots[i].pos, slots[i - 1].at + pitch);
        i = j;
      }
      for (let i = 1; i < slots.length; i++) if (slots[i].at < slots[i - 1].at + pitch - 1e-9) slots[i].at = slots[i - 1].at + pitch;
      for (const sl of slots) {
        const moved = Math.abs(sl.at - sl.pos) > 1e-6;
        for (const i of sl.members) {
          const q = rows[i].q;
          if (axis === "x") {
            const knee = lead + (moved ? jog * 2 : 0);
            out.lines.push([[q[0], q[1] - gap], [q[0], moved ? knee + jog : lead]]);
            if (moved && i === sl.members[0]) out.lines.push([[q[0], knee + jog], [sl.at, knee]], [[sl.at, knee], [sl.at, lead]]);
          } else {
            const knee = lead + (moved ? jog * 2 : 0);
            out.lines.push([[q[0] - gap, q[1]], [moved ? knee + jog : lead, q[1]]]);
            if (moved && i === sl.members[0]) out.lines.push([[knee + jog, q[1]], [knee, sl.at]], [[knee, sl.at], [lead, sl.at]]);
          }
        }
        const s = label(fmt(sl.v, d));
        if (axis === "x") out.texts.push({s, at: [sl.at + .9, lead - .8], angle: -Math.PI / 2, size: TS});
        else out.texts.push({s, at: [lead - .8, sl.at - .8], align: "right", angle: 0, size: TS});
      }
      out.stagger = slots.map(sl => r4(sl.at));
      out.value = values;
    } else return null;
    return out;
  }
  function paintDimension(c, dim, ctx, env) {
    const m = measure(dim, ctx);
    if (!m) return null;
    const ink = m.ok ? env.dim || env.ink : env.dnp || "#c0281e";
    c.save(); c.strokeStyle = ink; c.fillStyle = ink; c.lineWidth = lw(env, LW.thin); c.lineCap = "butt";
    c.beginPath(); for (const [p, q] of m.lines) { c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); } c.stroke();
    for (const [tip, dir] of m.arrows) arrow(c, tip, dir, 2.2, .75);
    for (const t of m.texts) text(c, env, m.ok ? t.s : t.s + " ?", t.at[0], t.at[1], t.size, {align: t.align || "center", baseline: "alphabetic", angle: t.angle, ink});
    c.restore();
    return m;
  }
  // Numbered callout balloons: a circle with the note number and a leader to the feature.
  function calloutGeometry(cl, ctx) {
    const n = (ctx.drawing.notes || []).findIndex(x => x.id === cl.note);
    let tip = null, ok = true;
    const view = (ctx.drawing.views || []).find(v => v.id === cl.view);
    if (view && FRAMED.has(view.type) && cl.at && !newerAnchor(cl.at)) {
      const G = ctx.geometry(view), R = resolve(cl.at, G);
      if (R) { tip = frame(view, G, ctx).map(R.p); ok = R.ok; }
    }
    if (!tip && Array.isArray(cl.point)) tip = cl.point;
    return {n, label: n >= 0 ? String(n + 1) : "?", tip, at: [cl.x, cl.y], r: 3, ok: ok && n >= 0};
  }
  function paintCallout(c, cl, ctx, env) {
    const g = calloutGeometry(cl, ctx), ink = g.ok ? env.ink : env.dnp || "#c0281e";
    c.save(); c.strokeStyle = ink; c.fillStyle = ink; c.lineWidth = lw(env, LW.thin);
    if (g.tip) {
      const dx = g.tip[0] - g.at[0], dy = g.tip[1] - g.at[1], L = Math.hypot(dx, dy);
      if (L > g.r) {
        c.beginPath(); c.moveTo(g.at[0] + dx / L * g.r, g.at[1] + dy / L * g.r); c.lineTo(g.tip[0], g.tip[1]); c.stroke();
        c.beginPath(); c.arc(g.tip[0], g.tip[1], .45, 0, TAU); c.fill();
      }
    }
    c.fillStyle = env.paper; c.beginPath(); c.arc(g.at[0], g.at[1], g.r, 0, TAU); c.fill();
    c.fillStyle = ink; c.lineWidth = lw(env, LW.medium); c.stroke();
    text(c, env, g.label, g.at[0], g.at[1] + .05, 3, {align: "center", baseline: "middle", bold: true, ink});
    c.restore();
    return g;
  }

  // ------------------------------------------------------------------ sheet text and lines
  // Free text and lines on the sheet (Place › Text, Line): sheet millimetres, ISO line weights.
  const WEIGHTS = Object.freeze({thin: LW.thin, medium: LW.medium, thick: LW.thick, heavy: LW.heavy});
  const DASHES = Object.freeze({solid: [], dashed: [3, 1.5], chain: [6, 1, 1, 1], dotted: [.4, 1]});
  function textBox(t) {
    const size = t.height > 0 ? t.height : TEXT, lines = String(t.text ?? "").split("\n"), w = Math.max(...lines.map(l => textWidth(l, size)), size * .5), h = size * 1.3 * lines.length;
    const a = -(t.angle || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
    // Local box: x right along the baseline, y up from the first baseline (descenders included).
    const lo = -size * .3 - (h - size * 1.3), hi = size * .95;
    const pts = [[0, lo], [w, lo], [w, hi], [0, hi]].map(([x, y]) => [t.x + x * c + y * s, t.y + x * s - y * c]);
    return bounds4(pts);
  }
  const bounds4 = pts => [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  function paintText(c, t, env) {
    const size = t.height > 0 ? t.height : TEXT, a = -(t.angle || 0) * Math.PI / 180;
    String(t.text ?? "").split("\n").forEach((line, i) => {
      const dy = i * size * 1.3, x = t.x - Math.sin(a) * dy, y = t.y + Math.cos(a) * dy;
      text(c, env, line, x, y, size, {bold: !!t.bold, angle: a || 0});
    });
  }
  function paintLine(c, l, env) {
    const pts = Array.isArray(l.points) ? l.points : [];
    if (pts.length < 2) return;
    c.save(); c.strokeStyle = env.ink; c.lineWidth = lw(env, WEIGHTS[l.weight] || LW.medium); c.lineCap = "round"; c.lineJoin = "round";
    const dash = DASHES[l.style] || [];
    if (dash.length) c.setLineDash(dash);
    poly(c, pts, false); c.stroke();
    c.restore();
  }

  // ------------------------------------------------------------------ a whole sheet
  function paintSheet(c, ctx, sheet, sheetIndex, env) {
    const D = ctx.drawing;
    frameAndTitle(c, ctx, sheet, sheetIndex, env);
    for (const v of D.views || []) if (v.sheet === sheet.id) paintView(c, v, ctx, env);
    for (const d of D.dimensions || []) if (d.sheet === sheet.id) paintDimension(c, d, ctx, env);
    for (const cl of D.callouts || []) if (cl.sheet === sheet.id) paintCallout(c, cl, ctx, env);
    for (const l of D.lines || []) if (l.sheet === sheet.id) paintLine(c, l, env);
    for (const t of D.texts || []) if (t.sheet === sheet.id) paintText(c, t, env);
  }

  return Object.freeze({SIZES, SCALES, LW, TEXT, SMALL, TB, sheetSize, ratio, fitScale, textWidth, wrap, geometry, isometric, frame, box, tableOf, notesOf,
    resolve, snaps, measure, calloutGeometry, paintSheet, paintView, paintDimension, paintCallout, frameAndTitle, titleFields, symbol, BOARD_TYPES, font,
    FRAMED, LINKED, VIEW_TYPES, newerView, newerDimension, newerAnchor, LETTERS, BREAK_GAP, WEIGHTS, DASHES, parentOf, breaksOf, heights, sectionOf, letterAt, textBox, paintText, paintLine, inside});
})();
