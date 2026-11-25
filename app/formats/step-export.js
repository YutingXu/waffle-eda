"use strict";
if (!globalThis.AtriumGeometryMaterial && typeof require === "function") require("../pcb/geometry-material.js");
// 3D export of the PCB assembly: STEP (ISO 10303-21, AP214 AUTOMOTIVE_DESIGN)
// for MCAD, and a triangle mesh for the 3D view. No geometry kernel: the
// board and every generated body is a prism (closed loops of lines and true
// arcs extruded between two heights), which maps exactly onto a B-rep of
// planes and cylinders.
//
// Layers:
//   model(project, doc, opts)  DOM-free geometry: board prisms with true arcs,
//                              drill holes, component bodies with placements,
//                              optional copper and silkscreen prisms.
//   mesh(model, {tolerance})   Typed-array triangle meshes per part (WebGL2).
//   step(model, opts)          STEP text written from the model.
//   export(project, doc, opts) model + step; returns the STEP text.
//
// Coordinates: the editor is mm with Y down. Everything here is mm, Y up,
// Z up: a model point (x, y) becomes (x, -y). The board bottom is z = 0 and
// the top is z = thickness. A part angle a (clockwise on screen) is a
// rotation of -a about +Z.
//
// Embedded component models (optional, documented in README terms here):
//   def.model3d | def.footprint.model3d | part.model3d =
//     {stepText, offset:[x,y,z] mm, rotation:[rx,ry,rz] degrees (applied X, then Y, then Z),
//      flip:"x"|"y" (how a bottom-side part is turned over; default "x", KiCad's convention),
//      scale (only 1 is supported by STEP placement), file (resolved through opts.resolveModel)}
// The model's own product tree is copied into the file with renumbered IDs and
// placed under a product named with the designator.
//
// Rigid-flex fold (opts.fold: 0 flat .. 1 fully folded, or "flat" / "folded"; needs
// AtriumFlexFold): bend lines fold in their fold order as in the 3D view. Board, stiffener,
// copper and silk prisms are cut along the bend zones. Parts outside every zone move rigidly
// (their prisms keep exact lines, arcs and holes, written in the folded position); each zone
// strip becomes a polyhedral solid of planar faces whose chords follow the bend cylinder
// (opts.foldStep degrees per segment, default 7.5). Components ride the fold at their origin.
// Holes, cutouts and copper inside a bend zone are omitted with a note.
if (!globalThis.AtriumBoardShape && typeof require === "function") require("../pcb/board-shape-core.js");
if (!globalThis.AtriumSTEPImport && typeof require === "function") require("./step-import.js");
globalThis.AtriumSTEP = (function createSTEP(coreFactory, {point: xform, direction: xdir, bounds: boxXform}) {
  const VERSION = "1.0";
  const TAU = 2 * Math.PI, D2R = Math.PI / 180;
  const COLORS = {board: [0.05, 0.33, 0.15], copper: [0.83, 0.68, 0.32], silk: [0.94, 0.94, 0.94], dark: [0.13, 0.13, 0.14], grey: [0.55, 0.55, 0.57]};
  const DEFAULTS = {components: true, generated: true, models: true, copper: false, silk: false, holes: true, vias: true,
    minHole: 0, boardColor: null, silkThickness: 0.015, deterministic: true /* byte-stable for an unchanged design: FILE_NAME carries opts.timestamp or a fixed date */};

  // ---------------------------------------------------------------------------
  // 2D segments, Y up. Line {a,b}; arc {a,b,c,r,ccw}. Loops are closed chains.
  const L = (a, b) => ({a, b});
  const ARC = (c, r, a, b, ccw) => ({a, b, c, r, ccw: !!ccw});
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const up = p => [p[0], -p[1]];
  function sweep(s) {
    let d = Math.atan2(s.b[1] - s.c[1], s.b[0] - s.c[0]) - Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
    if (s.ccw) { while (d <= 1e-12) d += TAU; while (d > TAU) d -= TAU; } else { while (d >= -1e-12) d -= TAU; while (d < -TAU) d += TAU; }
    return d;
  }
  function circleLoop(c, r, ccw = true) {
    const e = [c[0] + r, c[1]], w = [c[0] - r, c[1]];
    return [ARC(c, r, e, w, ccw), ARC(c, r, w, e, ccw)];
  }
  function loopArea(loop) {
    let a = 0;
    for (const s of loop) {
      a += (s.a[0] * s.b[1] - s.b[0] * s.a[1]) / 2;
      if (s.c) { const t = sweep(s); a += s.r * s.r / 2 * (t - Math.sin(t)); }
    }
    return a;
  }
  const reverseLoop = loop => loop.slice().reverse().map(s => s.c ? ARC(s.c, s.r, s.b, s.a, !s.ccw) : L(s.b, s.a));
  const orient = (loop, ccw) => (loopArea(loop) > 0) === ccw ? loop : reverseLoop(loop);
  function polyLoop(points) {
    const p = points.filter((q, i, a) => dist(q, a[(i + a.length - 1) % a.length]) > 1e-7);
    if (p.length < 3) return null;
    return p.map((q, i) => L(q, p[(i + 1) % p.length]));
  }
  // Polyline approximation of a loop (end point of each segment omitted).
  function flattenLoop(loop, tol, out = [], info = null) {
    for (const s of loop) {
      out.push(...s.a);
      info?.push(s.c ? s : null);
      if (!s.c) continue;
      const start = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]) / D2R;
      const edge = {kind: "arc", center: up(s.c), radius: s.r, start, sweep: sweep(s) / D2R};
      const points = AtriumGeometryCurves.flatten([edge], tol);
      for (let i = 1; i < points.length - 1; i++) { out.push(points[i][0], -points[i][1]); info?.push(s); }
    }
    return out;
  }
  function loopBounds(loop, b = [Infinity, Infinity, -Infinity, -Infinity]) {
    for (const s of loop) {
      const pts = s.c ? [[s.c[0] - s.r, s.c[1] - s.r], [s.c[0] + s.r, s.c[1] + s.r]] : [s.a, s.b];
      for (const p of pts) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); }
    }
    return b;
  }
  // Weld joints so every segment ends exactly where the next begins; arcs keep
  // the end points computed from their own centre and radius.
  function weld(loop) {
    const out = loop.filter(s => s.c || dist(s.a, s.b) > 1e-7).map(s => ({...s}));
    for (let i = 0; i < out.length; i++) {
      const s = out[i], n = out[(i + 1) % out.length];
      const p = n.c ? n.a : s.b;
      s.b = p; n.a = p;
    }
    return out.length >= 2 ? out : null;
  }

  // ---------------------------------------------------------------------------
  // Board outline, cutouts, flex regions and drill holes.
  function shapeLoop(contour) {
    const S = AtriumBoardShape;
    const segs = [];
    for (const g of contour) {
      if (g.kind === "line") { segs.push(L(up(g.a), up(g.b))); continue; }
      if (g.kind === "ellipseArc") {
        const pts = AtriumGeometryCurves.flatten([g], 0.005).map(up);
        for (let i = 1; i < pts.length; i++) segs.push(L(pts[i - 1], pts[i]));
        continue;
      }
      const center = g.center ?? g.c, c = up(center), r = g.radius ?? g.r, d = g.sweep ?? S.sweep(g), ccw = d > 0;
      const a = up(S.pointAt(center, r, g.start));
      if (Math.abs(d) === 360) {
        const m = up(S.pointAt(center, r, g.start + d / 2));
        segs.push(ARC(c, r, a, m, ccw), ARC(c, r, m, a, ccw));
      } else {
        const b = up(S.pointAt(center, r, g.start + d));
        // A short edge whose vertices coincide at STEP precision has no
        // representable curve. Closing it would make a complete circle.
        if (Math.abs(d) < 180 && dist(a, b) < 1e-6 && a.every((n, i) => real(n) === real(b[i]))) continue;
        segs.push(ARC(c, r, a, b, ccw));
      }
    }
    return weld(segs);
  }
  function resolvedArea(loops) {
    const D = 180 / Math.PI;
    const convert = loop => loop.map(s => s.c ? {kind: "arc", center: up(s.c), radius: s.r,
      start: Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]) * D, sweep: sweep(s) * D}
      : {kind: "line", a: up(s.a), b: up(s.b)});
    return [{outer: convert(loops[0]), holes: loops.slice(1).map(convert)}];
  }
  function areaPrisms(area, index, z, raw, artwork) {
    const bands = index ? globalThis.AtriumGeometryMaterial.slice(area, index, z) : [{area, z}];
    if (raw && bands.length === 1 && bands[0].area === area) return [raw];
    return bands.flatMap(({area, z}) => area.flatMap(({outer, holes}) => {
      const loop = shapeLoop(outer);
      if (!loop) return [];
      const rings = [orient(loop, true), ...holes.map(shapeLoop).filter(Boolean).map(h => orient(h, false))];
      return (artwork ? artworkFaces(rings) : [rings]).map(loops => ({loops, z0:z[0], z1:z[1]}));
    }));
  }
  const resolvedPrisms = (p, index) => areaPrisms(resolvedArea(p.loops), index, [p.z0, p.z1], p);
  function boardShape(doc, notes) {
    const BS = globalThis.AtriumBoardShape;
    let shape = null;
    try { shape = BS?.current ? BS.current(doc, {fitArcs: true}) : BS?.fresh(doc); } catch { shape = null; }
    let outer = null, exact = false;
    const cutouts = [], islands = [];
    if (shape?.contour?.length) {
      outer = shapeLoop(shape.contour); exact = true;
      for (const {contour, cutouts: materialIslands} of BS.profileCutouts(shape)) {
        const hole = shapeLoop(contour);
        if (!hole) continue;
        cutouts.push(orient(hole, false));
        for (const contour of materialIslands) {
          const island = shapeLoop(contour);
          if (island) islands.push({outer: orient(island, true), cutouts: []});
        }
      }
    }
    if (!outer && Array.isArray(doc.outline) && doc.outline.length >= 3) outer = polyLoop(doc.outline.map(up));
    if (!outer) {
      notes.push("The board has no closed outline; a rectangle around the design extents was used.");
      const b = globalThis.Atrium?.docBounds?.(doc, new Map()) || [0, 0, 50, 50];
      outer = polyLoop([[b[0] - 1, -b[1] + 1], [b[2] + 1, -b[1] + 1], [b[2] + 1, -b[3] - 1], [b[0] - 1, -b[3] - 1]]);
    }
    return {shapes: [{outer: orient(outer, true), cutouts}, ...islands], exact};
  }
  function boardBores(project, doc, defs, datum, o, notes) {
    const material = globalThis.AtriumGeometryMaterial, all = [], substrate = [], through = [], shaped = [];
    const report = (pad, parent, hit, reason) => { if (pad) o.holeResult?.(pad, parent, hit, reason); };
    function emit(bore, {at, via, pad, parent}) {
      const hit = {x: at[0], y: -at[1], d: bore.cutter.diameter, plated: bore.plated, via, bore};
      if (bore.z) all.push(bore);
      if (via && o.vias === false || hit.d < (o.minHole || 0) || !bore.z) {
        if (bore.operation === "primary") report(pad, parent, null, !bore.z ? "Physical drill depth is unresolved." :
          via && o.vias === false ? "Via holes are disabled." : "The tool is below the minimum hole size.");
        return;
      }
      substrate.push(bore);
      if (bore.operation !== "primary") return;
      report(pad, parent, hit);
      if (bore.cutter.kind === "round" && datum.substrate && bore.z[0] <= datum.substrate[0] && bore.z[1] >= datum.substrate[1]) {
        through.push(hit);
      } else shaped.push(hit);
    }
    const view = o.geometryView;
    if (view) {
      const items = new Map(), docs = new Map((project.documents || []).map(d => [d.id, d]));
      docs.set(doc.id, doc);
      if (o.holeResult) for (const d of docs.values()) for (const item of d.items || []) items.set(d.id + "\0" + item.id, item);
      for (const bore of view.bores()) {
        const {owner, member} = bore.key;
        const id = owner.documentId, d = docs.get(id), item = items.get(id + "\0" + owner.id);
        const parent = item?.kind === "part" ? item : null;
        const pad = parent ? globalThis.AtriumPCBAppearance.readDefinition(defs, parent.def, d)?.footprint?.pads?.[Number(member[1])] : item;
        const box = bore.cutter.kind === "slot" ? material.cutterBounds(bore) : null;
        const at = box ? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2] : bore.cutter.at;
        emit(bore, {at, via: bore.operation === "backdrill" || !!bore.treatment, pad, parent});
      }
      const diagnostics = globalThis.AtriumGeometryReceipts?.drillDiagnostics?.(view) ?? view.diagnostics();
      for (const diagnostic of diagnostics) if (/^unknown-.*drill-depth$|^unknown-bore-depth$/.test(diagnostic.code)) {
        notes.add("Unresolved physical drill depth on " + (diagnostic.owner.id || diagnostic.owner.documentId) +
          " (" + [...diagnostic.member, diagnostic.code].join("/") + ").");
      }
    } else for (const item of doc.items || []) material.collect({doc, defs, item, layers: datum.layers, copper: datum.copper,
      diagnose: (member, code) => notes.add("Unresolved physical drill depth on " + (item.ref || item.id) + " (" + [...member, code].join("/") + ")."),
      bore: (member, bore, metadata) => emit(bore, metadata)
    });
    return {all, substrateBores: substrate, through, shaped};
  }
  // Keep holes that lie wholly inside the board and touch neither the edge,
  // a cutout nor another hole, so the solid stays valid.
  function screenHoles(holes, rings, bodyOf, notes) {
    const byBody = rings.map(() => []);
    if (!holes.length) return {holes, byBody};
    const edges = [];
    for (const {outline, cutouts} of rings) for (const r of [outline, ...cutouts])
      for (let i = 0; i < r.length; i += 2) { const j = (i + 2) % r.length; edges.push([[r[i],r[i+1]],[r[j],r[j+1]]]); }
    const spatial = globalThis.AtriumSpatial, edgeIndex = spatial.create(edges, Atrium.bounds);
    const kept = [], seenHole = new Set(), hc = 2.5;
    // Keep first-admitted holes in the same coarse neighbourhood as the shell check.
    const admitted = spatial.create([], ({x,y}) => {
      const a = Math.floor(x/hc), b = Math.floor(y/hc);
      return [a,b,a,b];
    }, 1);
    let outside = 0, overlap = 0, edge = 0;
    for (const h of holes) {
      const r = h.d / 2, gap = 0.001;
      const body = bodyOf(h);
      if (body < 0) { outside++; continue; }
      const {x,y} = h;
      if (edgeIndex.query([x-r-gap,y-r-gap,x+r+gap,y+r+gap]).some(([a,b]) => Atrium.nearSegment([x,y],a,b) < r + gap)) {
        edge++; continue;
      }
      const k = Math.round(h.x * 1e4) + "," + Math.round(h.y * 1e4);
      if (seenHole.has(k)) { overlap++; continue; }
      const hx = Math.floor(x/hc), hy = Math.floor(y/hc), span = Math.ceil(r/hc) + 2;
      if (admitted.query([hx-span,hy-span,hx+span,hy+span]).some(o => Math.hypot(o.x-x,o.y-y) < r + o.d/2 + gap)) {
        overlap++; continue;
      }
      admitted.insert(h, kept.length);
      seenHole.add(k); kept.push(h); byBody[body].push(h);
    }
    if (outside) notes.push(outside + " drill hole" + (outside === 1 ? " lies" : "s lie") + " outside the board or in a cutout and " + (outside === 1 ? "was" : "were") + " omitted.");
    if (edge) notes.push(edge + " drill hole" + (edge === 1 ? " crosses" : "s cross") + " the board edge or a cutout and " + (edge === 1 ? "was" : "were") + " omitted.");
    if (overlap) notes.push(overlap + " overlapping or duplicate drill hole" + (overlap === 1 ? " was" : "s were") + " omitted.");
    return {holes: kept, byBody};
  }
  // Rigid-flex regions (AtriumStackup.regionsResolved / rigid-flex.js). Each
  // region becomes its own flat body at its substack's height; stiffeners are
  // extra solids. z in the resolved data is measured down from the top of the
  // master stack, so z_up = t - z.
  function flexRegions(doc, defs, t, notes) {
    const S = globalThis.AtriumStackup;
    if (typeof S?.regionsResolved !== "function" || !globalThis.AtriumRigidFlex) return null;
    let R;
    try { R = S.regionsResolved(doc, defs); } catch (e) { notes.push("Rigid-flex regions could not be resolved: " + e.message); return null; }
    const list = Array.isArray(R) ? R : R?.regions;
    if (!Array.isArray(list) || !(R?.split ?? list.length > 1)) return null;
    const out = [];
    for (const r of list) {
      const loop = Array.isArray(r.points) && r.points.length >= 3 ? polyLoop(r.points.map(up)) : null;
      const th = +r.thickness;
      if (!loop || !(th > 0)) continue;
      const z0 = Number.isFinite(+r.zBottom) ? t - r.zBottom : (t - th) / 2;
      out.push({name: String(r.name || r.id || (r.flex ? "Flex" : "Rigid")), loop: orient(loop, true), z0, z1: z0 + th, flex: !!r.flex,
        stiffeners: (r.stiffeners || []).filter(s => s.thickness > 0).map(s => ({side: s.side, z0: t - s.z1, z1: t - s.z0, material: s.material || ""}))});
    }
    if (!out.length) return null;
    notes.push("Rigid-flex region outlines are exported as polygons" + ((R.bends || []).length ? "; flex regions are exported flat and bends are not folded." : "."));
    return out;
  }

  // ---------------------------------------------------------------------------
  // Components
  const COURTYARD = l => /court|crtyd/i.test(l || "") || /^mechanical\s*15$/i.test(l || "");
  const BODY = (l, s) => /body|3d|assembly|package|fab/i.test(l || "") || /^mechanical\s*13$/i.test(l || "") || s?.style === "package";
  function parseLength(v) {
    if (typeof v === "number") return v > 0 && v < 1000 ? v : null;
    const m = /^\s*([0-9]*\.?[0-9]+)\s*(mm|mil|mils|in|inch|")?\s*$/i.exec(String(v ?? ""));
    if (!m) return null;
    const n = +m[1], u = (m[2] || "mm").toLowerCase(), mm = u === "mm" ? n : u.startsWith("mil") ? n * 0.0254 : n * 25.4;
    return mm > 0 && mm < 1000 ? mm : null;
  }
  const HEIGHT_KEYS = ["HEIGHT", "COMPONENT HEIGHT", "BODY HEIGHT", "MAX HEIGHT", "3D HEIGHT", "PACKAGE HEIGHT"];
  function paramHeight(item, def) {
    for (const v of [item.height, item.model3d?.height, def?.height, def?.footprint?.height]) { const h = parseLength(v); if (h) return h; }
    for (const src of [item.parameters, def?.parameters, def?.footprint?.parameters]) {
      if (!src || typeof src !== "object") continue;
      for (const [k, v] of Object.entries(src)) if (HEIGHT_KEYS.includes(String(k).toUpperCase().replace(/[_\s]+/g, " ").trim())) { const h = parseLength(v); if (h) return h; }
    }
    return null;
  }
  const code = c => new RegExp("(^|[^0-9])" + c + "([^0-9]|$)");
  const PACKAGES = [
    [code("01005"), 0.15], [code("0201"), 0.25], [code("0402"), 0.35], [code("0603"), 0.45], [code("0805"), 0.6], [code("1206"), 0.65],
    [code("1210"), 0.7], [/(^|[^0-9])(1812|2010|2512)([^0-9]|$)/, 0.7], [/sot-?223/i, 1.8], [/sot-?(23|323|363|353|563)|sc-?70|sc-?88/i, 1.1],
    [/sod-?123/i, 1.1], [/sod-?(323|523|923)/i, 0.9], [/do-?214|\bsm[abc]\b/i, 2.3], [/bga/i, 1.2], [/[qd]fn|mlf|wson|\bv?son\b|lga|tdfn/i, 0.9],
    [/tssop|msop|vssop/i, 1.1], [/ssop|soic|\bso-?\d+|\bsop/i, 1.75], [/[lt]qfp/i, 1.6], [/qfp/i, 2.5], [/to-?252|dpak/i, 2.4], [/to-?263|d2pak/i, 4.6],
    [/to-?220/i, 9], [/to-?92/i, 4.8], [/dip/i, 4.5], [/hc-?49/i, 3.5], [/usb/i, 3.3], [/header|pinhead|pin_?header|socket|idc/i, 8.5],
    [/cp_elec|electrolytic/i, 5.4], [/led/i, 0.8], [/connector|conn/i, 5]
  ];
  const PREFIX = {R: 0.6, C: 0.6, L: 1, FB: 0.6, D: 1, F: 0.6, U: 1.5, IC: 1.5, Q: 1.1, Y: 1, X: 1, J: 5, P: 5, CN: 5, SW: 3.5, S: 3.5, BT: 5, TP: 1, LED: 0.8, K: 8};
  function packageHeight(item, def) {
    const text = [def?.footprint?.name, def?.name, def?.value].filter(Boolean).join(" ");
    for (const [re, h] of PACKAGES) if (re.test(text)) return h;
    const prefix = (String(item.ref || def?.prefix || "").match(/^[A-Za-z]+/)?.[0] || "").toUpperCase();
    return PREFIX[prefix] ?? 1;
  }
  function partColor(item, def) {
    const prefix = (String(item.ref || def?.prefix || "").match(/^[A-Za-z]+/)?.[0] || "").toUpperCase();
    return ["R", "C", "L", "FB", "F"].includes(prefix) ? COLORS.grey : COLORS.dark;
  }
  function simple(pts) {
    const n = pts.length;
    if (n > 256) return false;
    const cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = pts[i], b = pts[(i + 1) % n], c = pts[j], d = pts[(j + 1) % n];
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return false;
    }
    return true;
  }
  function hull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]), cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], q) <= 0) hi.pop(); hi.push(q); }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  }
  // Generated body outline in the part's local frame, Y up.
  function bodyLoop(fp) {
    for (const test of [s => BODY(s.layer, s), s => COURTYARD(s.layer)]) {
      let best = null, bestArea = 0;
      for (const s of fp.shapes || []) {
        if (!test(s)) continue;
        let loop = null;
        if (s.kind === "circle" && s.r > 0) loop = circleLoop([s.x, -s.y], s.r);
        else if (s.kind === "path" && Array.isArray(s.points) && s.points.length >= 3) {
          const pts = s.points.map(up), closed = s.closed || s.fill || dist(pts[0], pts.at(-1)) < 1e-6;
          if (!closed) continue;
          if (dist(pts[0], pts.at(-1)) < 1e-6) pts.pop();
          const clean = pts.filter((q, i, a) => dist(q, a[(i + a.length - 1) % a.length]) > 1e-7);
          if (clean.length < 3) continue;
          loop = polyLoop(simple(clean) ? clean : hull(clean));
        }
        if (!loop) continue;
        const a = Math.abs(loopArea(loop));
        if (a > bestArea + 1e-9) { best = loop; bestArea = a; }
      }
      if (best && bestArea > 1e-4) return {loop: orient(best, true), from: "outline"};
    }
    // Fall back to the extents of the pads.
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of fp.pads || []) {
      const h = Math.max(p.w || p.diameter || 0, p.h || p.diameter || 0) / 2;
      b[0] = Math.min(b[0], p.x - h); b[1] = Math.min(b[1], -p.y - h); b[2] = Math.max(b[2], p.x + h); b[3] = Math.max(b[3], -p.y + h);
    }
    if (!(b[2] - b[0] > 1e-3 && b[3] - b[1] > 1e-3)) return null;
    return {loop: polyLoop([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]), from: "pads"};
  }
  function placement(origin, axis, ref) {
    const y = [axis[1] * ref[2] - axis[2] * ref[1], axis[2] * ref[0] - axis[0] * ref[2], axis[0] * ref[1] - axis[1] * ref[0]];
    return {origin, axis, refDir: ref, matrix: [ref[0], ref[1], ref[2], 0, y[0], y[1], y[2], 0, axis[0], axis[1], axis[2], 0, origin[0], origin[1], origin[2], 1]};
  }
  function matrixPlacement(m) {
    return placement(m.slice(12, 15), m.slice(8, 11), m.slice(0, 3));
  }
  function relativePlacement(parent, world) {
    const a = parent.matrix, offset = world.origin.map((v, k) => v - parent.origin[k]);
    const local = v => [0, 4, 8].map(k => v[0] * a[k] + v[1] * a[k + 1] + v[2] * a[k + 2]);
    return placement(local(offset), local(world.axis), local(world.refDir));
  }
  function eulerPlacement(offset = [0, 0, 0], rotation = [0, 0, 0]) {
    const [a, b, c] = rotation.map(v => (+v || 0) * D2R), ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
    // R = Rz(c) Ry(b) Rx(a)
    const R = [[cc * cb, cc * sb * sa - sc * ca, cc * sb * ca + sc * sa], [sc * cb, sc * sb * sa + cc * ca, sc * sb * ca - cc * sa], [-sb, cb * sa, cb * ca]];
    return placement(offset.map(v => +v || 0), [R[0][2], R[1][2], R[2][2]], [R[0][0], R[1][0], R[2][0]]);
  }
  function mulMat(A, B) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += A[k * 4 + r] * B[c * 4 + k];
    return o;
  }

  // ---------------------------------------------------------------------------
  // Exact extrusion helpers for profiles and artwork.
  function artworkFaces(loops) {
    if (loops.some(r => r.some(s => s.c))) return [loops];
    const flat = rs => rs.map(r => r.flatMap(s => s.a));
    const rings = flat(loops);
    try {
      if (touchingVertices(rings)) throw new TriangulationError("The region has coincident boundary vertices.");
      triangulate(rings, true);
      return [loops];
    } catch (e) {
      if (!(e instanceof TriangulationError) || !globalThis.AtriumPolygonPour?.boolean) throw e;
      // A region or a font outline can carry shared hole edges or paths that
      // go out and back between islands. Resolve the filled area before
      // making solid faces. Explicit holes subtract from the entire outer fill.
      const islands = AtriumPolygonPour.boolean([rings.slice(0, 1), rings.slice(1)], ([outer, holes]) => outer !== 0 && holes === 0, 1e7);
      if (!islands.length) throw e;
      return islands.flatMap(({outline, holes}) => {
        const clean = [polyLoop(outline), ...holes.map(polyLoop)];
        if (clean.some(r => !r)) throw e;
        const boundary = flat(clean), tri = triangulate(boundary, true);
        if (!touchingVertices(boundary)) return [clean];
        // A cutout that touches another boundary at one point has no single
        // watertight shell. Extrude the existing cap triangles separately.
        const vertices = clean.flatMap(r => r.map(s => s.a)), pieces = [];
        for (let i = 0; i < tri.length; i += 3) {
          const a = vertices[tri[i]], b = vertices[tri[i + 1]], c = vertices[tri[i + 2]];
          if ((b[0] - a[0]) * (c[1] - a[1]) > (b[1] - a[1]) * (c[0] - a[0]))
            pieces.push([[L(a, b), L(b, c), L(c, a)]]);
        }
        return pieces;
      });
    }
  }
  function touchingVertices(rings) {
    const seen = new Set();
    for (const r of rings) for (let i = 0; i < r.length; i += 2) {
      const key = r[i] + "/" + r[i + 1];
      if (seen.has(key)) return true;
      seen.add(key);
    }
    return false;
  }
  // ---------------------------------------------------------------------------
  // Keep the writer's public shape and output policies around the Part 21 reader.
  const MODEL_LIMITS = Object.freeze({bytes: 32 * 1048576, entities: 400000, depth: 32});
  const PARSE_LIMITS = {...MODEL_LIMITS, bytes: Infinity, entities: Infinity};
  const reader = coreFactory(), {triangulate, TriangulationError} = reader;
  const parseBody = src => reader.readWriter(src, PARSE_LIMITS, true);

  // Full parse: {header, entities: Map(id -> {type|complex, args})}. Checks that
  // IDs are unique and every reference resolves.
  function parse(text, opt = {}) {
    if (!/^\s*ISO-10303-21;/.test(text)) throw Error("Not an ISO 10303-21 file.");
    if (!/END-ISO-10303-21;\s*$/.test(text)) throw Error("The file is not terminated with END-ISO-10303-21;");
    const h = /HEADER;([\s\S]*?)ENDSEC;/.exec(text);
    if (!h) throw Error("The file has no HEADER section.");
    const entities = new Map(), refs = [];
    for (const {id, entity: e} of reader.readWriter(text, PARSE_LIMITS)) {
      if (entities.has(id)) throw Error("Duplicate #" + id);
      entities.set(id, e);
      if (opt.refs !== false) { const walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") { if (v.ref) refs.push(v.ref); if (v.args) walk(v.args); if (v.complex) v.complex.forEach(p => walk(p.args)); } }; walk(e); }
    }
    for (const r of refs) if (!entities.has(r)) throw Error("Unresolved reference #" + r);
    return {header: h[1], entities, schema: /FILE_SCHEMA\s*\(\s*\(\s*'([^']*)'/.exec(h[1])?.[1] || ""};
  }
  // Text-level entity list for a merge: [{id, body}] plus the parsed map.
  function readModel(text) {
    if (text.length > MODEL_LIMITS.bytes) throw Error("the model is larger than " + Math.round(MODEL_LIMITS.bytes / 1048576) + " MB");
    if (!/^\s*ISO-10303-21\s*;/.test(text.slice(0, 256))) throw Error("not an ISO 10303-21 file");
    const records = reader.readWriter(text, MODEL_LIMITS);
    const list = records.map(({id, body}) => ({id, body}));
    const parsed = new Map(records.map(({id, entity}) => [id, entity]));
    const nauoChild = new Set();
    for (const e of parsed.values()) if (e.type === "NEXT_ASSEMBLY_USAGE_OCCURRENCE") nauoChild.add(e.args[4]?.ref);
    const roots = [...parsed].filter(([id, e]) => e.type === "PRODUCT_DEFINITION" && !nauoChild.has(id)).map(([id]) => id);
    if (!roots.length) throw Error("The component model has no PRODUCT_DEFINITION.");
    const root = roots[0];
    let rep = null;
    for (const e of parsed.values()) {
      if (e.type !== "SHAPE_DEFINITION_REPRESENTATION") continue;
      const pds = parsed.get(e.args[0]?.ref);
      if (pds?.type === "PRODUCT_DEFINITION_SHAPE" && pds.args[2]?.ref === root) { rep = e.args[1]?.ref; break; }
    }
    const r = parsed.get(rep);
    if (!r || !r.type || !Array.isArray(r.args[1]) || !r.args[2]?.ref) throw Error("The component model's root shape representation was not found.");
    // Units: mm unless the length unit is an inch conversion.
    const inch = /CONVERSION_BASED_UNIT\s*\(\s*'INCH'/i.test(text);
    let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const e of parsed.values()) if (e.type === "CARTESIAN_POINT" && Array.isArray(e.args[1]) && e.args[1].length === 3)
      for (let k = 0; k < 3; k++) { const v = e.args[1][k] * (inch ? 25.4 : 1); if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
    if (!(lo[0] <= hi[0])) { lo = [-0.5, -0.5, 0]; hi = [0.5, 0.5, 1]; }
    return {list, parsed, root, rep, context: r.args[2].ref, bbox: [...lo, ...hi], maxId: list.reduce((max, e) => Math.max(max, e.id), 0)};
  }

  // ---------------------------------------------------------------------------
  // Geometry model
  const parsedAssets = new Map();
  let cachedBytes = 0;
  function bodyModel(asset, remaining) {
    // Undo/reopen can replace the metadata object; immutable source content is
    // the identity. A catalogue GUID alone can be reused for different geometry.
    const key = asset.zlib || asset.stepText, hit = parsedAssets.get(key);
    if (hit && hit.text.length <= remaining) return hit;
    const text = asset.stepText || globalThis.AtriumImportFormats?.stepText(asset);
    if (!text) throw Error("The STEP decoder is unavailable.");
    if (text.length > Math.min(remaining, MODEL_LIMITS.bytes)) throw Error("The STEP body exceeds the model or board byte limit.");
    const data = readModel(text), size = (key.length + text.length) * 2 + data.list.length * 256;
    while (parsedAssets.size && (cachedBytes + size > 96 * 1048576 || parsedAssets.size >= 64)) {
      const oldest = parsedAssets.keys().next().value;
      cachedBytes -= parsedAssets.get(oldest).size; parsedAssets.delete(oldest);
    }
    const result = {text, data, size};
    if (size <= 96 * 1048576) { parsedAssets.set(key, result); cachedBytes += size; }
    return result;
  }
  function settle(opts) {
    const o = {...DEFAULTS, ...(opts || {})};
    o.boardColor = colorOf(o.boardColor) || COLORS.board;
    return o;
  }
  function colorOf(c) {
    if (Array.isArray(c) && c.length >= 3) return c.slice(0, 3).map(v => Math.max(0, Math.min(1, +v || 0)));
    const m = /^#?([0-9a-f]{6})$/i.exec(String(c || ""));
    return m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16) / 255) : null;
  }
  function boardFor(project, requested) {
    const doc = requested && typeof requested === "object" ? requested : (project.documents || []).find(d => d.id === requested) || (requested == null ? (project.documents || []).find(d => d.kind === "pcb") : null);
    if (doc?.kind !== "pcb") throw Error("Choose a PCB layout to export.");
    return doc;
  }
  function checkedView(doc, view) {
    if (!view) return null;
    const id = view.revision.rootId;
    if (id !== doc.id && id !== doc.panelView) throw Error("The geometry view belongs to a different PCB.");
    view.assertCurrent();
    return view;
  }
  function datumOf(doc, defs, view) {
    const material = globalThis.AtriumGeometryMaterial;
    return view ? material.datumFromLayers(view.layers) : material.datum(doc, defs);
  }
  function model(project, requested, opts) {
    const o = settle(opts), doc = boardFor(project, requested), defs = new Map((project.library || []).map(d => [d.id, d]));
    const notes = [], noteSet = new Set(), note = m => { if (!noteSet.has(m)) { noteSet.add(m); notes.push(m); } };
    notes.add = note;
    const material = globalThis.AtriumGeometryMaterial;
    const view = checkedView(doc, o.geometryView), needsBores = o.holes !== false || o.copper;
    const datum = datumOf(doc, defs, view);
    const regions = flexRegions(doc, defs, datum.nominal, notes), substrate = datum.substrate;
    const t = regions ? datum.nominal : substrate?.[1] ?? 0;
    if (!substrate) note("The physical stack depth is unresolved.");
    const {shapes, exact} = boardShape(doc, notes), [profile, ...islands] = shapes;
    const {all, substrateBores, through, shaped} = needsBores ? boardBores(project, doc, defs, datum, o, notes)
      : {all: [], substrateBores: [], through: [], shaped: []};
    const throughSet = new Set(through.map(h => h.bore)), other = substrateBores.filter(b => !throughSet.has(b));
    const rings = o.holes !== false && (through.length || shaped.length) ?
      shapes.map(({outer, cutouts}) => ({outline: flattenLoop(outer, .002), cutouts: cutouts.map(c => flattenLoop(c, .002))})) : [];
    const bodyOf = ({x,y}) => rings.findIndex(({outline,cutouts}) => AtriumGeometry.inFlatRing(x,y,outline) &&
      !cutouts.some(c => AtriumGeometry.inFlatRing(x,y,c)));
    const {holes, byBody} = rings.length ? screenHoles(through, rings, bodyOf, notes) : {holes: [], byBody: shapes.map(() => [])};
    const bodies = [];
    const drillLoops = hs => hs.map(h => circleLoop([h.x, h.y], h.d / 2, false));
    if (regions) {
      const flat = regions.map(r => flattenLoop(r.loop, 0.005));
      const assign = (x, y) => flat.findIndex(f => AtriumGeometry.inFlatRing(x, y, f));
      function addRegion(r, name, outer, cutouts, hs) {
        const loops = [outer, ...cutouts, ...drillLoops(hs)];
        bodies.push({name, flex: r.flex, prism: {loops, z0: r.z0, z1: r.z1}, holes: hs.length});
        for (const [j, st] of r.stiffeners.entries()) bodies.push({name: name + " stiffener " + (j + 1), stiffener: true, color: COLORS.grey,
          prism: {loops, z0: st.z0, z1: st.z1}, holes: hs.length});
      }
      for (const [k, r] of regions.entries()) {
        const cutouts = profile.cutouts.filter(c => assign(...c[0].a) === k);
        const hs = byBody[0].filter(h => assign(h.x, h.y) === k);
        addRegion(r, r.name, r.loop, cutouts, hs);
      }
      for (const [i, island] of islands.entries()) {
        const r = regions[assign(...island.outer[0].a)];
        if (r) addRegion(r, r.name + " island " + (i + 1), island.outer, island.cutouts, byBody[i + 1]);
      }
    } else if (substrate) {
      const cutDepths = o.holes !== false && other.length ? material.cutterIndex(holes.map(h => h.bore).concat(other)) : null;
      for (const [i, shape] of shapes.entries()) {
        const {outer, cutouts} = shape;
        const name = i ? "PCB island " + i : "PCB";
        const prism = {loops: [outer, ...cutouts], z0: substrate[0], z1: t};
        if (cutDepths) for (const p of resolvedPrisms(prism, cutDepths)) {
          bodies.push({name, flex: false, prism: p, holes: Math.max(0, p.loops.length - prism.loops.length)});
        } else {
          prism.loops.push(...drillLoops(byBody[i]));
          bodies.push({name, flex: false, prism, holes: byBody[i].length});
        }
      }
    }
    const name = String(doc.name || project.name || "Board");
    const materialHoles = o.holes !== false && !regions && shaped.length ? holes.concat(shaped.filter(h => bodyOf(h) >= 0)) : holes;
    const board = {name, color: o.boardColor, thickness: t, z0: 0, z1: t, bodies, holes: materialHoles,
      bores: all, cutouts: profile.cutouts.length, exact};

    const parts = [], models = new Map();
    const PCB = globalThis.AtriumPCBAppearance, land = globalThis.AtriumResolvedLand;
    const copperLayers = [...datum.copper.keys()];
    // Model and standoff offsets are relative to the component's seating face.
    // Flat footprints with a land sit at the outside surface of that foil.
    function seatingZ(side, item, footprint) {
      const bare = side === "Top" ? t : 0, foil = datum.copper.get(side);
      if (!foil || !land || !PCB || regions || doc.stackup?.bends?.length || !footprint?.pads?.some(pad =>
        PCB.onLayer(PCB.padLayer(item, pad), side, pad) && land.film(pad, side, copperLayers))) return bare;
      return side === "Top" ? foil[1] : foil[0];
    }
    const catalogues = new Map(), canonicalAssets = new Map();
    function assetsOf(owner) {
      if (!catalogues.has(owner)) catalogues.set(owner, new Map((owner.bodyModels || []).map(a => [a.id, a])));
      return catalogues.get(owner);
    }
    function canonicalAsset(asset, ownerId) {
      const inline = asset?.zlib || asset?.stepText;
      const ref = o.deferBodyModels && o.deferNativeModels && asset?.model;
      if (!inline && !ref) return null;
      const key = inline || "native model " + ref.sha256 + "/" + ref.byteLength;
      if (!canonicalAssets.has(key)) canonicalAssets.set(key, inline ? asset : {...asset, ownerId});
      return canonicalAssets.get(key);
    }
    let decodedBytes = 0;
    function readBodyAsset(asset, failure) {
      if (!models.has(asset)) {
        try {
          const decoded = bodyModel(asset, 128 * 1048576 - decodedBytes);
          decodedBytes += decoded.text.length;
          models.set(asset, decoded);
        } catch (e) {
          models.set(asset, null);
          note(failure(e));
        }
      }
      return models.get(asset);
    }
    function importedBodies(records, i, base, source = doc, sourceId = doc.id, footprint) {
      const bodyAssets = assetsOf(source);
      const owner = i || {x: 0, y: 0, angle: 0, layer: "Top"};
      const ownerAngle = -(owner.angle || 0) * D2R, ownerBottom = owner.layer === "Bottom";
      const ownerPlacement = placement([owner.x, -owner.y, seatingZ(ownerBottom ? "Bottom" : "Top", i, footprint)], [0, 0, ownerBottom ? -1 : 1], [Math.cos(ownerAngle), Math.sin(ownerAngle), 0]);
      for (const b of records) {
        const flipped = (ownerBottom ? "Bottom" : "Top") !== b.ownerSide, sign = flipped ? -1 : 1;
        const side = flipped ? (b.side === "Bottom" ? "Top" : "Bottom") : b.side;
        const bottom = side === "Bottom", originZ = seatingZ(side, i, footprint), theta = -(owner.angle || 0) * D2R;
        const dir = a => [Math.cos(a), Math.sin(a), 0];
        const color = b.color == null ? COLORS.dark : [b.color & 255, b.color >>> 8 & 255, b.color >>> 16 & 255].map(v => v / 255);
        const common = {...base, side, opacity: b.opacity, ownerPlacement, bodyName: b.identifier || b.sourceRecord, bodyRecord: b.sourceRecord, color, bodyId: b.modelId};
        const envelope = o.bodyEnvelopes && b.type === "step" && bodyAssets.has(b.modelId);
        if (b.type === "extruded" || envelope) {
          const rings = (b.rings || []).map(r => polyLoop(r.map(p => [p[0], -sign * p[1]])));
          if (b.contour?.length && rings.length) {
            const mirror = p => [p[0], sign * p[1]];
            rings[0] = shapeLoop(flipped ? b.contour.map(g => g.kind === "arc" ?
              {...g, c: mirror(g.c), start: -g.start, end: -g.end, ccw: !g.ccw} : {kind: "line", a: mirror(g.a), b: mirror(g.b)}) : b.contour);
          }
          if (!rings.length || rings.some(r => !r) || !(b.maxZ > b.minZ)) { note("A 3D body without a closed outline or positive thickness was omitted."); continue; }
          const pl = placement([owner.x, -owner.y, originZ], [0, 0, 1], dir(theta));
          parts.push({...common, source: envelope ? "envelope" : "extruded", height: b.maxZ - b.minZ, placement: pl, matrix: pl.matrix,
            body: {loops: rings.map((r, j) => orient(r, j === 0)), z0: bottom ? -b.maxZ : b.minZ, z1: bottom ? -b.minZ : b.maxZ}});
          continue;
        }
        if (b.type !== "step" || o.models === false) continue;
        const linked = bodyAssets.get(b.modelId);
        const target = linked?.assetId ? bodyAssets.get(linked.assetId) : linked;
        const a = canonicalAsset(target, sourceId);
        if (!a) { note("Unresolved STEP body " + (target?.file || b.modelId) + " was omitted."); continue; }
        const angle = theta + sign * b.angle * D2R, at = globalThis.Atrium.world([b.at[0], sign * b.at[1]], owner);
        const pl = placement([at[0], -at[1], originZ], [0, 0, bottom ? -1 : 1], dir(angle));
        const inner = eulerPlacement([0, 0, b.dz], b.rotation);
        let decoded = null;
        if (!o.deferBodyModels) {
          decoded = readBodyAsset(a, e => "STEP body " + (a.file || a.id) + " was omitted: " + e.message);
          if (!decoded) continue;
        }
        parts.push({...common, source: "model", placement: pl, matrix: pl.matrix,
          model: {asset: a, text: decoded?.text || null, data: decoded?.data || null, placement: inner}, body: null});
      }
    }
    // Assembly variants: o.variant (id or name; null or "" for the base design; default the active
    // variant) decides which parts are fitted, unless the caller passes its own include hook.
    if (typeof o.include !== "function" && globalThis.AtriumVariants) o.include = AtriumVariants.includer(project, o.variant);
    if (o.components !== false) {
      if (doc.bodies3d?.length) importedBodies(doc.bodies3d, null, {id: doc.id, ref: "Board body", name: "Board body", def: doc.id});
      const rules=globalThis.AtriumRules;
      const heightRule=rules?.stored(doc,project)?.list?.some(r=>r.type==="componentHeight"&&r.enabled)?rules.resolver(doc,{project}):null;
      for (const i of doc.items || []) {
        if (i.kind !== "part") continue;
        const def=PCB ? PCB.readDefinition(defs,i.def,doc) : defs.get(i.def), fp=def?.footprint;
        if (!fp) { note("Components without a footprint were omitted."); continue; }
        if (typeof o.include === "function" && !o.include(i, def)) continue;
        const side = i.layer === "Bottom" ? "Bottom" : "Top", theta = -(i.angle || 0) * D2R, ref = [Math.cos(theta), Math.sin(theta), 0];
        const base = {id: i.id, ref: String(i.ref || def.prefix || "U?"), name: String(fp.name || def.name || ""), value: String(i.value ?? def.value ?? ""), def: def.id, side};
        if (i.bodies3d?.length || fp.bodies3d?.length) {
          const own = !!i.bodies3d?.length;
          importedBodies(own ? i.bodies3d : fp.bodies3d, i, base, own ? doc : fp, own ? doc.id : def.id, fp);
          continue;
        }
        const m3 = i.model3d || def.model3d || fp.model3d;
        let text = null, asset = null, decoded = null;
        if (m3 && o.models !== false) {
          // Inline, or stored once in project.blobs (format 1.4) and referenced by its SHA-256.
          text = typeof m3.stepText === "string" ? m3.stepText : typeof project.blobs?.[m3.sha256]?.stepText === "string" ? project.blobs[m3.sha256].stepText : null;
          if (!text && m3.model) {
            asset = canonicalAsset(m3, i.model3d ? doc.id : def.id);
            // A saved native model with non-UTF-8 bytes is hydrated as zlib.
            if (asset && !o.deferBodyModels) {
              decoded = readBodyAsset(asset, e => "A component model could not be read (" + e.message + "); a generated body was used.");
              if (decoded) text = decoded.text;
              else asset = null;
            }
          }
          if (!text && !asset && m3.file && typeof o.resolveModel === "function") { try { text = o.resolveModel(m3, def, i) || null; } catch { text = null; } }
          if (!text && !asset) note("Some component models could not be loaded; generated bodies were used instead.");
          if (m3.scale != null && [].concat(m3.scale).some(s => Math.abs(+s - 1) > 1e-9)) note("Component model scale is not supported by STEP placement and was ignored.");
        }
        if (text || asset) {
          let m = decoded?.data || models.get(text);
          if (text && m === undefined) { try { m = readModel(text); } catch (e) { m = null; note("A component model could not be read (" + e.message + "); a generated body was used."); } models.set(text, m); }
          if (m || asset) {
            const flip = m3.flip === "y" ? "y" : "x";
            const axis = side === "Top" ? [0, 0, 1] : [0, 0, -1], rd = side === "Top" || flip === "x" ? ref : [-ref[0], -ref[1], 0];
            const pl = placement([i.x, -i.y, seatingZ(side, i, fp)], axis, rd), inner = eulerPlacement(m3.offset, m3.rotation);
            parts.push({...base, source: "model", color: partColor(i, def), placement: pl, matrix: pl.matrix,
              model: {text, data: m, placement: inner, flip, ...(asset && {asset})}, body: null});
            continue;
          }
        }
        if (o.generated === false) continue;
        const b = bodyLoop(fp);
        if (!b) { note("Components without pads or a body outline were omitted."); continue; }
        const h = paramHeight(i, def) ?? heightRule?.("componentHeight",{component:i.ref,layer:i.layer||"Top",at:[i.x,i.y]})?.preferred ?? packageHeight(i, def);
        const pl = placement([i.x, -i.y, seatingZ(side, i, fp)], [0, 0, 1], ref);
        parts.push({...base, source: "generated", height: h, color: colorOf(o.componentColor) || partColor(i, def), placement: pl, matrix: pl.matrix,
          body: {loops: [b.loop], z0: side === "Top" ? 0 : -h, z1: side === "Top" ? h : 0}, outlineFrom: b.from});
      }
    }

    const artwork = prepareArtwork(project, doc, o, note);
    const {layers, layerWarnings} = artworkLayers(datum, all, o, artwork, note).next().value;
    const fold = foldOf(o.fold);
    if (fold > 0) applyFold(doc, defs, fold, board, parts, layers, notes, o);
    delete notes.add;
    const scene = {version: VERSION, units: "mm", up: "Z", name, board, parts, layers, notes, layerWarnings, options: o};
    physicalInputs.set(scene, {project, doc, datum, bores: all, boreView: needsBores ? view : null});
    return scene;
  }

  // Reuse the substrate model's physical inputs in the viewer's asynchronous
  // copper/silkscreen pass. Artwork still comes from the current board.
  const physicalInputs = new WeakMap();
  function layersFor(project, doc, scene, opts) {
    return layerStepsFor(project, doc, scene, opts).next().value;
  }
  function* layerStepsFor(project, doc, scene, opts, pause) {
    const inputs = physicalInputs.get(scene);
    if (inputs?.doc !== doc || inputs.project !== project) throw Error("3D artwork needs a current board model.");
    const o = settle(opts), view = checkedView(doc, o.geometryView);
    const refresh = view && view !== inputs.boreView;
    const datum = refresh ? datumOf(doc, null, view) : inputs.datum;
    const bores = o.copper && refresh ? [...view.bores()] : inputs.bores;
    const artwork = prepareArtwork(project, doc, o, () => {});
    const result = yield* artworkLayers(datum, bores, o, artwork, () => {}, pause);
    artwork?.view.assertCurrent();
    return result;
  }
  function prepareArtwork(project, doc, o, note) {
    if (!o.copper && !o.silk) return null;
    if (o.geometryView) return {view:o.geometryView};
    try {
      if ((!globalThis.AtriumFabOutputs || !globalThis.AtriumResolvedGeometry) && typeof require === "function") {
        if (!globalThis.AtriumLazy) require("../lazy.js");
        const service = globalThis.AtriumFabOutputs ? "AtriumResolvedGeometry" : "AtriumFabOutputs";
        for (const path of globalThis.AtriumLazy.files([service])) require("../" + path);
      }
      if (globalThis.AtriumGeometryReceipts?.requiresRuleQuery(project, doc) && typeof require === "function") {
        for (const path of globalThis.AtriumLazy.files(["AtriumDesignQuery", "AtriumQueryExchange"])) require("../" + path);
      }
      if (globalThis.AtriumFabOutputs && globalThis.AtriumResolvedGeometry)
        return globalThis.AtriumFabOutputs.stepArtwork(project, doc, o.fab);
      note("Copper and silkscreen need the fabrication outputs module.");
    } catch (error) { note("Copper and silkscreen could not be analysed: " + error.message); }
    return null;
  }
  function* artworkLayers(datum, bores, o, artwork, note, pause) {
    const layers = [], layerWarnings = [];
    if (!artwork) return {layers, layerWarnings};
    const {view, copper} = artwork;
    const requested = o.layerKeys ? new Set(o.layerKeys) : null;
    const material = globalThis.AtriumGeometryMaterial;
    const index = o.copper && bores.length ? material.cutterIndex(bores) : null;

    function* add(name, key, kind, side, color, z) {
      if (!z || requested && !requested.has(key)) return;
      const cut = kind === "copper" ? index : null, features = [];
      let signed = false;
      for (const feature of view.features({layer:key})) {
        if (feature.key.role === "keepout") continue;
        features.push(feature);
        signed ||= feature.polarity === "clear";
        if (pause?.()) { yield; view.assertCurrent(); }
      }
      const prisms = [], faces = signed ? [null] : features;
      for (const [i, feature] of faces.entries()) {
        try {
          // Positive stroke solids may overlap in the file. The canonical
          // pieces only need composition when clear film changes their order.
          const kind = feature?.ink.kind;
          if (kind === "stroke") {
            for (const piece of material.filmPieces(feature)) prisms.push(...areaPrisms([piece], cut, z));
          } else {
            const area = signed ? view.layerArea(key, "film") : view.area(feature.key, "film");
            prisms.push(...areaPrisms(area, cut, z, undefined, signed || kind === "region"));
          }
        }
        catch (error) {
          if (error.code === "STALE_GEOMETRY") throw error;
          const message = name + ". Shape " + (i + 1) + " could not form a solid. " + error.message;
          layerWarnings.push(message);
          note(message);
        }
        if (pause?.()) { yield; view.assertCurrent(); }
      }
      if (prisms.length) layers.push({name, key, kind, side, color, prisms});
    }
    const top = datum.copper.get("Top"), bottom = datum.copper.get("Bottom"), ts = o.silkThickness;
    if (o.copper) {
      yield* add("Top copper", "Top", "copper", "Top", COLORS.copper, top);
      yield* add("Bottom copper", "Bottom", "copper", "Bottom", COLORS.copper, bottom);
      // The viewport's mask stencil uses the opening film on the same face.
      if (o.maskOpenings) {
        yield* add("Top mask openings", "Top mask", "opening", "Top", COLORS.copper, top);
        yield* add("Bottom mask openings", "Bottom mask", "opening", "Bottom", COLORS.copper, bottom);
      }
      if (datum.copper.size > 2) note("Inner copper layers are not exported.");
      if (copper?.state === "filled") note("Copper pours out of date in the design were filled again for this export; the design file still holds the older copper.");
      if (copper?.imported && !copper.imported.fresh) note("Imported copper without an editable pour is exported as stored, although the board has changed since import.");
    }
    if (o.silk) {
      if (top) yield* add("Top silkscreen", "Silk", "silk", "Top", COLORS.silk, [top[1], top[1] + ts]);
      if (bottom) yield* add("Bottom silkscreen", "Bottom silk", "silk", "Bottom", COLORS.silk, [bottom[0] - ts, bottom[0]]);
    }
    if (layers.length) note("Copper and silkscreen are separate overlapping solids per track segment, pad and region; they are not merged.");
    return {layers, layerWarnings};
  }

  // ---------------------------------------------------------------------------
  // Rigid-flex fold (see the header). t in (0, 1].
  const foldOf = f => f === "folded" ? 1 : f === "flat" || f == null || f === false ? 0 : Math.max(0, Math.min(1, +f || 0));
  function applyFold(doc, defs, t, board, parts, layers, notes, o) {
    const F = globalThis.AtriumFlexFold, RF = globalThis.AtriumRigidFlex;
    if (!F?.hasBends?.(doc) || !RF) { if (F == null && doc?.stackup?.bends?.length) notes.add("The fold needs the rigid-flex fold module; the board was exported flat."); return; }
    let P;
    try { P = F.plan(doc, defs, {thickness: board.thickness}); } catch (e) { notes.add("The fold could not be planned (" + e.message + "); the board was exported flat."); return; }
    const states = F.stateOf(P, t), active = P.bends.filter(b => states[b.index]);
    for (const n of P.notes) notes.add(n);
    if (!active.length) return;
    const stepDeg = o.foldStep > 0 ? Math.max(1, Math.min(45, +o.foldStep)) : 7.5;
    const zone = b => { const st = states[b.index], n = st.nFlat, K = Math.max(2, Math.ceil(st.theta / D2R / stepDeg)); return {b, st, n, hw: b.width / 2, w: b.width, K}; };
    const zones = active.map(zone), byIndex = new Map(zones.map(z => [z.b.index, z]));
    const sOf = (z, p) => (p[0] - z.b.a[0]) * z.n[0] + (p[1] - z.b.a[1]) * z.n[1];
    const counts = {pieces: 0, zones: 0, holes: 0, layers: 0, triangles: 0}, rot = M => [M[0], M[4], M[8], M[1], M[5], M[9], M[2], M[6], M[10]];
    // A point strictly inside a polygon (board coordinates): the centroid of its largest triangle.
    function inner(poly) {
      const ring = []; for (const p of poly) ring.push(p[0], -p[1]);
      let tri; try { tri = triangulate([loopArea(polyLoop(poly.map(up)) || []) >= 0 ? ring : reverseRing(ring)]); } catch { tri = null; }
      if (!tri?.length) return poly.reduce((a, p) => [a[0] + p[0] / poly.length, a[1] + p[1] / poly.length], [0, 0]);
      const R = loopArea(polyLoop(poly.map(up)) || []) >= 0 ? ring : reverseRing(ring);
      let best = null, ba = -1;
      for (let i = 0; i < tri.length; i += 3) {
        const a = [R[tri[i] * 2], R[tri[i] * 2 + 1]], b = [R[tri[i + 1] * 2], R[tri[i + 1] * 2 + 1]], c = [R[tri[i + 2] * 2], R[tri[i + 2] * 2 + 1]];
        const ar = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
        if (ar > ba) { ba = ar; best = [(a[0] + b[0] + c[0]) / 3, -(a[1] + b[1] + c[1]) / 3]; }
      }
      return best;
    }
    function reverseRing(r) { const o = []; for (let i = r.length - 2; i >= 0; i -= 2) o.push(r[i], r[i + 1]); return o; }
    // Cut a polygon (board coordinates) along every slice line of the zones it meets.
    function cut(poly) {
      let list = [poly];
      for (const z of zones) {
        const d = z.b.axis.direction, E = z.w + 1, a0 = [z.b.a[0] - d[0] * E, z.b.a[1] - d[1] * E], b0 = [z.b.b[0] + d[0] * E, z.b.b[1] + d[1] * E];
        for (let k = 0; k <= z.K; k++) {
          const s = -z.hw + z.w * k / z.K, off = [z.n[0] * s, z.n[1] * s];
          list = list.flatMap(q => RF.splitPolygon(q, [a0[0] + off[0], a0[1] + off[1]], [b0[0] + off[0], b0[1] + off[1]]));
        }
      }
      return list.map(q => q.filter((v, i) => Math.hypot(v[0] - q[(i + 1) % q.length][0], v[1] - q[(i + 1) % q.length][1]) > 1e-7)).filter(q => q.length >= 3 && Math.abs(RF.geometry.area(q)) > 1e-9);
    }
    // The zone whose strip a piece lies in (deepest in its chain), with its slice.
    function zoneOf(q, chain) {
      let hit = null;
      for (const b of chain) {
        const z = byIndex.get(b.index); if (!z) continue;
        let lo = Infinity, hi = -Infinity; for (const p of q) { const s = sOf(z, p); lo = Math.min(lo, s); hi = Math.max(hi, s); }
        if (hi > -z.hw + 1e-6 && lo < z.hw - 1e-6) {
          const k = Math.max(0, Math.min(z.K - 1, Math.floor(((lo + hi) / 2 + z.hw) / z.w * z.K)));
          hit = {z, s0: -z.hw + z.w * k / z.K, s1: -z.hw + z.w * (k + 1) / z.K};
        }
      }
      return hit;
    }
    const inside = (q, l) => { const pts = flattenLoop(l, 0.005), ring = []; for (const p of q) ring.push(p[0], -p[1]);
      for (let i = 0; i < pts.length; i += 2) { if (!AtriumGeometry.inFlatRing(pts[i], pts[i + 1], ring)) return false; for (let j = 0; j < ring.length; j += 2) { const k = (j + 2) % ring.length; if (Atrium.nearSegment([pts[i], pts[i + 1]], [ring[j], ring[j + 1]], [ring[k], ring[k + 1]]) < 1e-4) return false; } }
      return true; };
    // Folded solids of one flat prism body.
    function foldPrism(prism, name, extra) {
      const outer = prism.loops[0], polyB = outer.every(s => !s.c) ? outer.map(s => [s.a[0], -s.a[1]]) : (() => { const f = flattenLoop(outer, 0.005), r = []; for (let i = 0; i < f.length; i += 2) r.push([f[i], -f[i + 1]]); return r; })();
      const innerLoops = prism.loops.slice(1), used = new Set(), out = [];
      for (const q of cut(polyB)) {
        const at = inner(q), chain = F.chainAt(P, at), zh = zoneOf(q, chain);
        if (!zh) {
          const M = F.matrixAt(P, at, t, states), loops = [orient(polyLoop(q.map(up)), true)];
          innerLoops.forEach((l, i) => { if (!used.has(i) && inside(q, l)) { used.add(i); loops.push(l); } });
          out.push({...extra, name: name + (out.length ? " " + (out.length + 1) : ""), prism: {loops, z0: prism.z0, z1: prism.z1, matrix: Array.from(M)}});
          counts.pieces++; continue;
        }
        // Zone strip: chords of the bend between the slice planes s0 and s1, linear in between.
        const {z, s0, s1} = zh;
        let poly = q.map(up); if (loopArea(polyLoop(poly)) < 0) poly = poly.reverse();
        const V = [], at3 = (p, h) => F.pointAt(P, [p[0], p[1], h], t, states, chain).p;
        for (const h of [prism.z0, prism.z1]) for (const p of poly) {
          const pb = [p[0], -p[1]], s = sOf(z, pb), lam = Math.max(0, Math.min(1, (s - s0) / (s1 - s0)));
          const pa = [p[0] - z.n[0] * (s - s0), p[1] + z.n[1] * (s - s0)], pc = [p[0] + z.n[0] * (s1 - s), p[1] - z.n[1] * (s1 - s)];
          const A = at3(pa, h), C = at3(pc, h);
          V.push([A[0] + (C[0] - A[0]) * lam, A[1] + (C[1] - A[1]) * lam, A[2] + (C[2] - A[2]) * lam]);
        }
        const n = poly.length, faces = [[...Array(n).keys()].map(i => n + i), [...Array(n).keys()].reverse()];
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n, quad = [i, j, n + j, n + i];
          if (planar(quad.map(k => V[k]))) faces.push(quad); else faces.push([i, j, n + j], [i, n + j, n + i]);
        }
        const fl = [];
        for (const f of faces) { if (f.length > 4 && !planar(f.map(k => V[k]))) fl.push(...fan(f)); else fl.push(f); }
        out.push({...extra, name: name + (out.length ? " " + (out.length + 1) : ""), flex: true, poly: {verts: V, faces: fl}, zone: z.b.name});
        counts.zones++;
      }
      counts.holes += innerLoops.length - used.size;
      return out;
    }
    const fan = f => { const o = []; for (let i = 1; i + 1 < f.length; i++) o.push([f[0], f[i], f[i + 1]]); return o; };
    const bodies = [];
    for (const b of board.bodies) {
      const {prism, ...rest} = b;
      bodies.push(...foldPrism(prism, b.name, {...rest, holes: 0}));
    }
    board.bodies = bodies;
    board.folded = {t, bends: active.length, step: stepDeg, solids: bodies.length};
    // Components: the fold at the part origin.
    const byId = new Map((doc.items || []).map(i => [i.id, i]));
    for (const p of parts) {
      const item = byId.get(p.id);
      if (!item) continue;
      const fold = F.matrixAt(P, [item.x, item.y], t, states);
      p.placement = matrixPlacement(mulMat(fold, p.matrix)); p.matrix = p.placement.matrix;
      if (p.ownerPlacement) p.ownerPlacement = matrixPlacement(mulMat(fold, p.ownerPlacement.matrix));
    }
    // Copper and silk: whole prisms outside every zone move rigidly; the rest is omitted.
    for (const l of layers) {
      const kept = [];
      for (const pr of l.prisms) {
        const f = flattenLoop(pr.loops[0], 0.01), pts = []; for (let i = 0; i < f.length; i += 2) pts.push([f[i], -f[i + 1]]);
        const c = pts.reduce((a, q) => [a[0] + q[0] / pts.length, a[1] + q[1] / pts.length], [0, 0]), chain = F.chainAt(P, c);
        if (zoneOf(pts, chain)) { counts.layers++; continue; }
        kept.push({...pr, matrix: Array.from(F.matrixAt(P, c, t, states))});
      }
      l.prisms = kept;
    }
    const chord = Math.max(...zones.map(z => (z.w / z.st.theta) * (1 - Math.cos(z.st.theta / z.K / 2))));
    const i = notes.findIndex(n => /flex regions are exported flat/.test(n));
    const msg = "Folded at " + Math.round(t * 100) + " %: " + zones.length + " bend" + (zones.length === 1 ? "" : "s") + " (" + zones.map(z => z.b.name + " " + z.K + " segments").join(", ") +
      "); bend zones are polyhedral solids with planar faces (chord error at most " + chord.toFixed(4) + " mm); rigid parts keep exact geometry.";
    if (i >= 0) notes.splice(i, 1, msg); else notes.push(msg);
    if (counts.holes) notes.push(counts.holes + " hole" + (counts.holes === 1 ? " or cutout" : "s or cutouts") + " crossing a bend zone or a fold cut " + (counts.holes === 1 ? "was" : "were") + " omitted from the folded board.");
    if (counts.layers) notes.push(counts.layers + " copper or silkscreen shape" + (counts.layers === 1 ? " in a bend zone was" : "s in bend zones were") + " omitted from the folded export.");
    void rot;
  }
  // Points within the STEP confusion tolerance of one plane.
  function planar(pts) {
    let n = [0, 0, 0];
    for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; n = [n[0] + (a[1] - b[1]) * (a[2] + b[2]), n[1] + (a[2] - b[2]) * (a[0] + b[0]), n[2] + (a[0] - b[0]) * (a[1] + b[1])]; }
    const l = Math.hypot(n[0], n[1], n[2]); if (!(l > 1e-12)) return false;
    n = n.map(v => v / l);
    const d0 = n[0] * pts[0][0] + n[1] * pts[0][1] + n[2] * pts[0][2];
    return pts.every(p => Math.abs(n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - d0) < 2e-7);
  }

  // ---------------------------------------------------------------------------
  // Mesh
  class Buf {
    constructor() { this.p = []; this.n = []; this.i = []; }
    get count() { return this.p.length / 3; }
  }
  function prismMesh(prism, tol, buf, verify = false, cap = 0) {
    const rings = [], info = [];
    for (const loop of prism.loops) {
      const inf = cap ? null : [];
      rings.push(flattenLoop(loop, tol, [], inf));
      info.push(inf);
    }
    const tri = triangulate(rings, verify);
    if (cap) {
      // The flat viewer only exposes one cap of thin copper or ink. Write
      // those same triangles in first-use vertex order without building the
      // hidden cap and walls or copying the full solid into typed arrays.
      const xy = rings.length === 1 ? rings[0] : rings.flat();
      const vertex = new Int32Array(xy.length / 2).fill(-1), z = cap > 0 ? prism.z1 : prism.z0;
      for (let i = 0; i < tri.length; i += 3) {
        const a = tri[i], b = tri[i + 1], c = tri[i + 2];
        addVertex(a);
        addVertex(cap > 0 ? b : c);
        addVertex(cap > 0 ? c : b);
      }
      return tri.length / 3;

      function addVertex(v) {
        if (vertex[v] < 0) {
          vertex[v] = buf.count;
          buf.p.push(xy[2 * v], xy[2 * v + 1], z);
          buf.n.push(0, 0, cap);
        }
        buf.i.push(vertex[v]);
      }
    }
    const z0 = prism.z0, z1 = prism.z1, P = buf.p, Nn = buf.n, I = buf.i, start = I.length, base = buf.count;
    // Caps
    for (const [z, nz] of [[z1, 1], [z0, -1]]) {
      const b = buf.count;
      for (const r of rings) for (let i = 0; i < r.length; i += 2) { P.push(r[i], r[i + 1], z); Nn.push(0, 0, nz); }
      if (nz > 0) for (let i = 0; i < tri.length; i++) I.push(b + tri[i]);
      else for (let i = 0; i < tri.length; i += 3) I.push(b + tri[i], b + tri[i + 2], b + tri[i + 1]);
    }
    // Walls: outward normal is to the right of the direction of travel.
    for (let k = 0; k < rings.length; k++) {
      const r = rings[k], inf = info[k], n = r.length >> 1;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n, ax = r[2 * i], ay = r[2 * i + 1], bx = r[2 * j], by = r[2 * j + 1], s = inf[i];
        let na, nb;
        if (s) { const sg = s.ccw ? 1 : -1; na = [(ax - s.c[0]) / s.r * sg, (ay - s.c[1]) / s.r * sg]; nb = [(bx - s.c[0]) / s.r * sg, (by - s.c[1]) / s.r * sg]; }
        else { const dx = bx - ax, dy = by - ay, l = Math.hypot(dx, dy) || 1; na = nb = [dy / l, -dx / l]; }
        const b = buf.count;
        P.push(ax, ay, z0, bx, by, z0, bx, by, z1, ax, ay, z1);
        Nn.push(na[0], na[1], 0, nb[0], nb[1], 0, nb[0], nb[1], 0, na[0], na[1], 0);
        I.push(b, b + 1, b + 2, b, b + 2, b + 3);
      }
    }
    if (prism.matrix) { // rigid placement (folded board): move the vertices just written
      const M = prism.matrix, n0 = base;
      for (let v = n0; v < buf.count; v++) {
        const p = xform(M, [P[v * 3], P[v * 3 + 1], P[v * 3 + 2]]), q = xdir(M, [Nn[v * 3], Nn[v * 3 + 1], Nn[v * 3 + 2]]);
        P[v * 3] = p[0]; P[v * 3 + 1] = p[1]; P[v * 3 + 2] = p[2]; Nn[v * 3] = q[0]; Nn[v * 3 + 1] = q[1]; Nn[v * 3 + 2] = q[2];
      }
    }
    return (I.length - start) / 3;
  }
  // Flat-shaded triangles of a polyhedron {verts, faces}.
  function polyMesh(poly, buf) {
    let tris = 0;
    for (const f of poly.faces) {
      const pts = f.map(i => poly.verts[i]);
      let n = [0, 0, 0];
      for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; n = [n[0] + (a[1] - b[1]) * (a[2] + b[2]), n[1] + (a[2] - b[2]) * (a[0] + b[0]), n[2] + (a[0] - b[0]) * (a[1] + b[1])]; }
      const l = Math.hypot(n[0], n[1], n[2]) || 1; n = n.map(v => v / l);
      const ax = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0], u = [ax[1] * n[2] - ax[2] * n[1], ax[2] * n[0] - ax[0] * n[2], ax[0] * n[1] - ax[1] * n[0]], lu = Math.hypot(...u), U = u.map(x => x / lu);
      const W = [n[1] * U[2] - n[2] * U[1], n[2] * U[0] - n[0] * U[2], n[0] * U[1] - n[1] * U[0]];
      const ring = []; for (const p of pts) ring.push(p[0] * U[0] + p[1] * U[1] + p[2] * U[2], p[0] * W[0] + p[1] * W[1] + p[2] * W[2]);
      let tri; try { tri = pts.length === 3 ? [0, 1, 2] : triangulate([ring]); } catch { tri = []; for (let k = 1; k + 1 < pts.length; k++) tri.push(0, k, k + 1); }
      const b = buf.count;
      for (const p of pts) { buf.p.push(p[0], p[1], p[2]); buf.n.push(n[0], n[1], n[2]); }
      for (let k = 0; k < tri.length; k++) buf.i.push(b + tri[k]);
      tris += tri.length / 3;
    }
    return tris;
  }
  function boxPrism(b) {
    return {loops: [polyLoop([[b[0], b[1]], [b[3], b[1]], [b[3], b[4]], [b[0], b[4]]])], z0: b[2], z1: b[5]};
  }
  const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  function finish(buf, extra) {
    return {...extra, positions: new Float32Array(buf.p), normals: new Float32Array(buf.n), indices: new Uint32Array(buf.i)};
  }
  // Triangle meshes for a WebGL2 viewer. Board and layer meshes are in board
  // coordinates (matrix = identity); component meshes are in the part frame
  // with its placement matrix (column-major 4x4), and parts with the same
  // body share their typed arrays. Imported Altium bodies are emitted only when
  // their source mesh is ready.
  function mesh(m, opt = {}) {
    const tol = opt.tolerance > 0 ? opt.tolerance : 0.02, t0 = now();
    const parts = [], layerWarnings = [];
    let triangles = 0;
    for (const b of m.board.bodies) {
      const buf = new Buf(); triangles += b.poly ? polyMesh(b.poly, buf) : prismMesh(b.prism, tol, buf);
      parts.push(finish(buf, {name: b.name, kind: b.stiffener ? "stiffener" : "board", color: b.color || m.board.color, matrix: Float32Array.from(IDENTITY), holes: b.holes}));
    }
    const shared = new Map();
    for (const p of m.parts) {
      let key, prism;
      // A tessellated STEP model (opts.modelMesh(text) -> AtriumSTEPImport result): one part per colour.
      const tm = p.source !== "model" ? null : typeof opt.modelMesh === "function" ? opt.modelMesh(p.model.asset || p.model.text, p.model.text)
        : p.model.asset && p.model.text ? globalThis.AtriumSTEPImport?.ensure(p.model.text) : null;
      if (tm?.parts?.length && p.model.asset) {
        // STEP geometry is shared by every placement. Only its instance matrix
        // changes on a move, board-side flip or fold.
        const matrix = Float32Array.from(mulMat(p.matrix, p.model.placement.matrix));
        tm.parts.forEach((g, j) => {
          triangles += g.indices.length / 3;
          parts.push({...g, name: p.ref, kind: "component", id: p.id, ref: p.ref, side: p.side, source: p.source,
            matrix, bodyRecord: p.bodyRecord, opacity: p.opacity, boundsOnly: false, tessellated: true, sub: j > 0});
        });
        continue;
      }
      if (tm?.parts?.length) {
        const M = p.model.placement.matrix, k = "t" + M.map(v => v.toFixed(6)).join(",");
        let list = shared.get(tm)?.get(k);
        if (!list) {
          list = tm.parts.map(g => {
            const P = new Float32Array(g.positions.length), N = new Float32Array(g.normals.length);
            for (let i = 0; i < P.length; i += 3) {
              const a = xform(M, [g.positions[i], g.positions[i + 1], g.positions[i + 2]]), b = xdir(M, [g.normals[i], g.normals[i + 1], g.normals[i + 2]]);
              P[i] = a[0]; P[i + 1] = a[1]; P[i + 2] = a[2]; N[i] = b[0]; N[i + 1] = b[1]; N[i + 2] = b[2];
            }
            return {positions: P, normals: N, indices: g.indices, color: g.color};
          });
          if (!shared.has(tm)) shared.set(tm, new Map());
          shared.get(tm).set(k, list);
        }
        list.forEach((g, j) => {
          triangles += g.indices.length / 3;
          parts.push({name: p.ref, kind: "component", ref: p.ref, id: p.id, side: p.side, source: p.source, color: g.color, matrix: Float32Array.from(p.matrix),
            positions: g.positions, normals: g.normals, indices: g.indices, boundsOnly: false, tessellated: true, sub: j > 0});
        });
        continue;
      }
      // The projected 2D envelope of an Altium STEP body is not component geometry.
      if (p.model?.asset) continue;
      if (p.source === "model") { const box = boxXform(p.model.placement.matrix,p.model.data.bbox); key = "m" + box.map(v => v.toFixed(4)).join(","); prism = boxPrism(box); }
      else { key = p.bodyRecord ? p.body : p.def + "|" + p.side + "|" + p.height + "|" + (p.outlineFrom || ""); prism = p.body; }
      let g = shared.get(key);
      if (!g) { const buf = new Buf(); prismMesh(prism, tol, buf); g = finish(buf, {}); shared.set(key, g); }
      triangles += g.indices.length / 3;
      const M = p.matrix;
      parts.push({name: p.ref, kind: "component", ref: p.ref, id: p.id, side: p.side, source: p.source, color: p.color, matrix: Float32Array.from(M),
        positions: g.positions, normals: g.normals, indices: g.indices, bodyRecord: p.bodyRecord, opacity: p.opacity, boundsOnly: p.source === "model"});
    }
    for (const l of m.layers) {
      const buf = new Buf();
      for (const [index, pr] of l.prisms.entries()) {
        const cap = opt.flatLayerCaps && !pr.matrix ? (l.side === "Bottom" ? -1 : 1) : 0;
        try { triangles += prismMesh(pr, tol, buf, true, cap); }
        catch (e) {
          if (!(e instanceof TriangulationError)) throw e;
          const message = l.name + ". Shape " + (index + 1) + " could not form a 3D face. " + e.message;
          if (!opt.skipInvalidLayerPrisms) throw new TriangulationError(message);
          layerWarnings.push(message);
        }
      }
      if (buf.i.length) parts.push(finish(buf, {name: l.name, kind: l.kind, side: l.side, layerKey: l.key, color: l.color, matrix: Float32Array.from(IDENTITY)}));
    }
    return {parts, layerWarnings, stats: {parts: parts.length, triangles, shared: shared.size, ms: Math.round((now() - t0) * 10) / 10}, folded: m.board.folded || null};
  }
  const now = () => globalThis.performance?.now ? performance.now() : Date.now();

  // ---------------------------------------------------------------------------
  // STEP writer
  function real(v) {
    if (!(Math.abs(v) >= 5e-7)) return "0.";
    const s = String(Math.round(v * 1e7) / 1e7);
    return s.includes("e") ? (+v).toFixed(7) : s.includes(".") ? s : s + ".";
  }
  function unit(v) {
    if (!(Math.abs(v) >= 5e-13)) return "0.";
    const s = String(Math.round(v * 1e12) / 1e12);
    return s.includes(".") || s.includes("e") ? (s.includes("e") ? (+v).toFixed(12) : s) : s + ".";
  }
  function str(s) {
    let out = "";
    for (const ch of String(s ?? "")) {
      const c = ch.codePointAt(0);
      if (ch === "'") out += "''";
      else if (ch === "\\") out += "\\\\";
      else if (c >= 32 && c < 127) out += ch;
      else if (c < 0x10000) out += "\\X2\\" + c.toString(16).toUpperCase().padStart(4, "0") + "\\X0\\";
      else out += "\\X4\\" + c.toString(16).toUpperCase().padStart(8, "0") + "\\X0\\";
    }
    return "'" + out + "'";
  }
  function timestamp(o) {
    if (o.timestamp) return String(o.timestamp);
    if (o.deterministic) return "2000-01-01T00:00:00";
    const d = new Date(), p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "T" + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }
  function step(m, opts = {}) {
    const o = {...m.options, ...opts}, t0 = now();
    const out = [];
    let n = 0;
    const E = t => { out.push("#" + (++n) + "=" + t + ";"); return n; };
    const reserve = () => { out.push(null); return {id: ++n, at: out.length - 1}; };
    const fill = (r, t) => { out[r.at] = "#" + r.id + "=" + t + ";"; return r.id; };
    const R = id => "#" + id;
    const list = ids => "(" + ids.map(R).join(",") + ")";

    const app = E("APPLICATION_CONTEXT('core data for automotive mechanical design processes')");
    E("APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000," + R(app) + ")");
    const pctx = E("PRODUCT_CONTEXT(''," + R(app) + ",'mechanical')"), dctx = E("PRODUCT_DEFINITION_CONTEXT('part definition'," + R(app) + ",'design')");
    const lu = E("(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))"), au = E("(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))"), su = E("(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())");
    const unc = E("UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06)," + R(lu) + ",'distance_accuracy_value','confusion accuracy')");
    const ctx = E("(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT(" + list([unc]) + ")GLOBAL_UNIT_ASSIGNED_CONTEXT(" + list([lu, au, su]) + ")REPRESENTATION_CONTEXT('Context #1','3D Context with UNIT and UNCERTAINTY'))");

    const dirs = new Map();
    const dir = v => { const k = unit(v[0]) + "," + unit(v[1]) + "," + unit(v[2]); let id = dirs.get(k); if (!id) { id = E("DIRECTION('',(" + k + "))"); dirs.set(k, id); } return id; };
    const pt = (x, y, z) => E("CARTESIAN_POINT('',(" + real(x) + "," + real(y) + "," + real(z) + "))");
    const a2pAt = (p, axis, ref) => E("AXIS2_PLACEMENT_3D(''," + R(p) + "," + R(dir(axis)) + "," + R(dir(ref)) + ")");
    const ptW = pt, dirW = dir, a2pAtW = a2pAt;
    const a2p = (o3, axis = [0, 0, 1], ref = [1, 0, 0]) => a2pAt(pt(o3[0], o3[1], o3[2]), axis, ref);
    const Z = [0, 0, 1], NZ = [0, 0, -1], X = [1, 0, 0];

    // Colour styles, one presentation style per colour.
    const styles = new Map(), styled = [];
    function style(c) {
      const k = c.map(v => v.toFixed(4)).join(",");
      let id = styles.get(k);
      if (!id) {
        const col = E("COLOUR_RGB(''," + c.map(v => real(Math.round(v * 1e4) / 1e4)).join(",") + ")");
        const ssfa = E("SURFACE_STYLE_FILL_AREA(" + R(E("FILL_AREA_STYLE(''," + list([E("FILL_AREA_STYLE_COLOUR(''," + R(col) + ")")]) + ")")) + ")");
        const ssu = E("SURFACE_STYLE_USAGE(.BOTH.," + R(E("SURFACE_SIDE_STYLE(''," + list([ssfa]) + ")")) + ")");
        id = E("PRESENTATION_STYLE_ASSIGNMENT(" + list([ssu]) + ")"); styles.set(k, id);
      }
      return id;
    }
    const paint = (item, c) => styled.push(E("STYLED_ITEM('color'," + list([style(c)]) + "," + R(item) + ")"));

    // B-rep of a prism: planes, cylinders, lines and circles.
    let faceCount = 0;
    function brep(prism, name) {
      if (prism.poly) return polyBrep(prism.poly, name);
      // A prism may carry a rigid placement (column-major 4x4; the folded board): written in place.
      const M = prism.matrix || null, pt = M ? (x, y, z) => ptW(...xform(M, [x, y, z])) : ptW, dir = M ? v => dirW(xdir(M, v)) : dirW;
      const a2pAt = (p, axis, ref) => a2pAtW(p, M ? xdir(M, axis) : axis, M ? xdir(M, ref) : ref), a2p = (o3, axis = [0, 0, 1], ref = [1, 0, 0]) => a2pAt(pt(o3[0], o3[1], o3[2]), axis, ref);
      const {z0, z1} = prism, h = z1 - z0, faces = [], topBounds = [], botBounds = [];
      const vz = E("VECTOR(''," + R(dir(Z)) + "," + real(h) + ")");
      for (const [li, loop] of prism.loops.entries()) {
        const m = loop.length, Pb = [], Pt = [], Vb = [], Vt = [], VE = [], BE = [], TE = [];
        for (const s of loop) {
          const b = pt(s.a[0], s.a[1], z0), t = pt(s.a[0], s.a[1], z1);
          Pb.push(b); Pt.push(t); Vb.push(E("VERTEX_POINT(''," + R(b) + ")")); Vt.push(E("VERTEX_POINT(''," + R(t) + ")"));
        }
        for (let i = 0; i < m; i++) VE.push(E("EDGE_CURVE(''," + R(Vb[i]) + "," + R(Vt[i]) + "," + R(E("LINE(''," + R(Pb[i]) + "," + R(vz) + ")")) + ",.T.)"));
        const circles = new Map(), surfaces = [];
        for (let i = 0; i < m; i++) {
          const s = loop[i], j = (i + 1) % m;
          if (!s.c) {
            const dx = s.b[0] - s.a[0], dy = s.b[1] - s.a[1], l = Math.hypot(dx, dy), u = [dx / l, dy / l, 0];
            const du = dir(u);
            BE.push(E("EDGE_CURVE(''," + R(Vb[i]) + "," + R(Vb[j]) + "," + R(E("LINE(''," + R(Pb[i]) + "," + R(E("VECTOR(''," + R(du) + "," + real(l) + ")")) + ")")) + ",.T.)"));
            TE.push(E("EDGE_CURVE(''," + R(Vt[i]) + "," + R(Vt[j]) + "," + R(E("LINE(''," + R(Pt[i]) + "," + R(E("VECTOR(''," + R(du) + "," + real(l) + ")")) + ")")) + ",.T.)"));
            surfaces.push({id: E("PLANE(''," + R(a2pAt(Pb[i], [u[1], -u[0], 0], u)) + ")"), sense: ".T."});
          } else {
            const k = real(s.c[0]) + "," + real(s.c[1]) + "," + real(s.r);
            let c = circles.get(k);
            if (!c) {
              const ab = a2p([s.c[0], s.c[1], z0], Z, X), at = a2p([s.c[0], s.c[1], z1], Z, X);
              c = {b: E("CIRCLE(''," + R(ab) + "," + real(s.r) + ")"), t: E("CIRCLE(''," + R(at) + "," + real(s.r) + ")"), cyl: E("CYLINDRICAL_SURFACE(''," + R(ab) + "," + real(s.r) + ")")};
              circles.set(k, c);
            }
            const sense = s.ccw ? ".T." : ".F.";
            BE.push(E("EDGE_CURVE(''," + R(Vb[i]) + "," + R(Vb[j]) + "," + R(c.b) + "," + sense + ")"));
            TE.push(E("EDGE_CURVE(''," + R(Vt[i]) + "," + R(Vt[j]) + "," + R(c.t) + "," + sense + ")"));
            surfaces.push({id: c.cyl, sense});
          }
        }
        const OE = (e, f) => E("ORIENTED_EDGE('',*,*," + R(e) + "," + (f ? ".T." : ".F.") + ")");
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % m;
          const loopId = E("EDGE_LOOP(''," + list([OE(BE[i], true), OE(VE[j], true), OE(TE[i], false), OE(VE[i], false)]) + ")");
          faces.push(E("ADVANCED_FACE(''," + list([E("FACE_OUTER_BOUND(''," + R(loopId) + ",.T.)")]) + "," + R(surfaces[i].id) + "," + surfaces[i].sense + ")"));
        }
        const kind = li === 0 ? "FACE_OUTER_BOUND" : "FACE_BOUND";
        topBounds.push(E(kind + "(''," + R(E("EDGE_LOOP(''," + list(TE.map(e => OE(e, true))) + ")")) + ",.T.)"));
        botBounds.push(E(kind + "(''," + R(E("EDGE_LOOP(''," + list(BE.slice().reverse().map(e => OE(e, false))) + ")")) + ",.T.)"));
      }
      faces.push(E("ADVANCED_FACE(''," + list(topBounds) + "," + R(E("PLANE(''," + R(a2p([0, 0, z1], Z, X)) + ")")) + ",.T.)"));
      faces.push(E("ADVANCED_FACE(''," + list(botBounds) + "," + R(E("PLANE(''," + R(a2p([0, 0, z0], NZ, X)) + ")")) + ",.T.)"));
      faceCount += faces.length;
      return E("MANIFOLD_SOLID_BREP(" + str(name) + "," + R(E("CLOSED_SHELL(''," + list(faces) + ")")) + ")");
    }
    // B-rep of a polyhedron {verts, faces}: planar faces (vertex index loops, counter-clockwise
    // seen from outside), straight edges each shared by two faces in opposite directions.
    function polyBrep(poly, name) {
      const V = poly.verts, P = new Map(), VP = new Map(), EC = new Map(), faces = [];
      const vp = i => { let v = VP.get(i); if (!v) { const p = ptW(V[i][0], V[i][1], V[i][2]); P.set(i, p); v = E("VERTEX_POINT(''," + R(p) + ")"); VP.set(i, v); } return v; };
      const edge = (i, j) => {
        const a = Math.min(i, j), b = Math.max(i, j), k = a + "," + b;
        let e = EC.get(k);
        if (!e) {
          const va = vp(a), vb = vp(b), d = [V[b][0] - V[a][0], V[b][1] - V[a][1], V[b][2] - V[a][2]], l = Math.hypot(d[0], d[1], d[2]) || 1;
          e = E("EDGE_CURVE(''," + R(va) + "," + R(vb) + "," + R(E("LINE(''," + R(P.get(a)) + "," + R(E("VECTOR(''," + R(dirW(d.map(x => x / l))) + "," + real(l) + ")")) + ")")) + ",.T.)");
          EC.set(k, e);
        }
        return E("ORIENTED_EDGE('',*,*," + R(e) + "," + (i < j ? ".T." : ".F.") + ")");
      };
      for (const f of poly.faces) {
        const pts = f.map(i => V[i]);
        let n = [0, 0, 0];
        for (let k = 0; k < pts.length; k++) { const a = pts[k], b = pts[(k + 1) % pts.length]; n = [n[0] + (a[1] - b[1]) * (a[2] + b[2]), n[1] + (a[2] - b[2]) * (a[0] + b[0]), n[2] + (a[0] - b[0]) * (a[1] + b[1])]; }
        const ln = Math.hypot(n[0], n[1], n[2]) || 1; n = n.map(v => v / ln);
        let u = [pts[1][0] - pts[0][0], pts[1][1] - pts[0][1], pts[1][2] - pts[0][2]];
        const du = u[0] * n[0] + u[1] * n[1] + u[2] * n[2]; u = [u[0] - n[0] * du, u[1] - n[1] * du, u[2] - n[2] * du];
        const lu = Math.hypot(u[0], u[1], u[2]) || 1; u = u.map(v => v / lu);
        const loop = E("EDGE_LOOP(''," + list(f.map((i, k) => edge(i, f[(k + 1) % f.length]))) + ")");
        vp(f[0]);
        const plane = E("PLANE(''," + R(a2pAtW(P.get(f[0]), n, u)) + ")");
        faces.push(E("ADVANCED_FACE(''," + list([E("FACE_OUTER_BOUND(''," + R(loop) + ",.T.)")]) + "," + R(plane) + ",.T.)"));
      }
      faceCount += faces.length;
      return E("MANIFOLD_SOLID_BREP(" + str(name) + "," + R(E("CLOSED_SHELL(''," + list(faces) + ")")) + ")");
    }
    function product(name, description) {
      const p = E("PRODUCT(" + str(name) + "," + str(name) + "," + str(description || "") + "," + list([pctx]) + ")");
      const pdf = E("PRODUCT_DEFINITION_FORMATION('',''," + R(p) + ")");
      const pd = E("PRODUCT_DEFINITION('design',''," + R(pdf) + "," + R(dctx) + ")");
      const pds = E("PRODUCT_DEFINITION_SHAPE('',''," + R(pd) + ")");
      E("PRODUCT_RELATED_PRODUCT_CATEGORY('part',$," + list([p]) + ")");
      return {p, pd, pds};
    }
    // A product whose shape is solids: {pd, rep, origin}.
    function solidProduct(name, description, prisms, color) {
      const pr = product(name, description), origin = a2p([0, 0, 0]), items = [];
      prisms.forEach((q, k) => { const b = brep(q, prisms.length > 1 ? name + " " + (k + 1) : name); items.push(b); paint(b, color); });
      const rep = E("ADVANCED_BREP_SHAPE_REPRESENTATION(" + str(name) + "," + list([...items, origin]) + "," + R(ctx) + ")");
      E("SHAPE_DEFINITION_REPRESENTATION(" + R(pr.pds) + "," + R(rep) + ")");
      return {pd: pr.pd, rep, origin};
    }
    // An assembly product: children are placed later with place().
    function assembly(name, description) {
      const pr = product(name, description), origin = a2p([0, 0, 0]), rep = reserve(), sdr = E("SHAPE_DEFINITION_REPRESENTATION(" + R(pr.pds) + "," + R(rep.id) + ")");
      return {pd: pr.pd, rep: rep.id, slot: rep, origin, items: [origin], name, sdr, ctx};
    }
    function closeAssembly(a) { fill(a.slot, "SHAPE_REPRESENTATION(" + str(a.name) + "," + list(a.items) + "," + R(a.ctx) + ")"); }
    let instances = 0;
    function place(parent, child, id, name, pl, childOrigin = child.origin, desc = "") {
      const target = pl ? a2p(pl.origin, pl.axis, pl.refDir) : a2p([0, 0, 0]);
      parent.items.push(target);
      const idt = E("ITEM_DEFINED_TRANSFORMATION('',''," + R(childOrigin) + "," + R(target) + ")");
      const rr = E("(REPRESENTATION_RELATIONSHIP(''," + "''," + R(child.rep) + "," + R(parent.rep) + ")REPRESENTATION_RELATIONSHIP_WITH_TRANSFORMATION(" + R(idt) + ")SHAPE_REPRESENTATION_RELATIONSHIP())");
      const nauo = E("NEXT_ASSEMBLY_USAGE_OCCURRENCE(" + str(id) + "," + str(name) + "," + str(desc) + "," + R(parent.pd) + "," + R(child.pd) + ",$)");
      E("CONTEXT_DEPENDENT_SHAPE_REPRESENTATION(" + R(rr) + "," + R(E("PRODUCT_DEFINITION_SHAPE('Placement','Placement of an item'," + R(nauo) + ")")) + ")");
      instances++;
    }
    // Copy an embedded model with renumbered IDs; returns {pd, rep, origin}.
    function merge(data) {
      const off = n, ren = s => s.replace(/('(?:[^']|'')*')|#(\d+)/g, (all, q, d) => q ? q : "#" + (+d + off));
      const origin = data.maxId + off + 1;
      for (const e of data.list) {
        let body = ren(e.body);
        if (e.id === data.rep) { // add an origin placement to the root representation's items
          const p = data.parsed.get(e.id);
          body = p.type + "(" + reprArgs(body, "#" + origin) + ")";
        }
        out.push("#" + (e.id + off) + "=" + body + ";");
      }
      n = origin;
      out.push("#" + origin + "=AXIS2_PLACEMENT_3D(''," + R(pt(0, 0, 0)) + "," + R(dir(Z)) + "," + R(dir(X)) + ");");
      return {pd: data.root + off, rep: data.rep + off, origin};
    }

    const name = m.name;
    const top = assembly(name, "PCB assembly exported by Waffle");
    const boardColor = m.board.color;
    for (const b of m.board.bodies) {
      const bp = solidProduct(m.board.bodies.length > 1 ? name + " " + b.name : name + " PCB", b.stiffener ? "Stiffener" : "Printed circuit board", [b.poly ? {poly: b.poly} : b.prism], b.color || boardColor);
      place(top, bp, b.name, b.name);
    }
    const merged = new Map(), owners = new Map();
    function mergedModel(data) {
      if (!merged.has(data)) merged.set(data, merge(data));
      return merged.get(data);
    }
    for (const p of m.parts) {
      const desc = [p.value, p.name].filter(Boolean).join(" · ");
      if (p.ownerPlacement) {
        // One editable occurrence per placed component, including footprints
        // assembled from several extrusions and STEP models on different sides.
        if (!owners.has(p.id)) {
          const owner = assembly(p.ref, desc);
          owners.set(p.id, owner);
          place(top, owner, p.ref, p.ref, p.ownerPlacement, undefined, "atrium:" + p.id);
        }
        const world = p.model ? matrixPlacement(mulMat(p.matrix, p.model.placement.matrix)) : p.placement;
        const child = p.model ? mergedModel(p.model.data) : solidProduct(p.bodyName, desc, [p.body], p.color);
        place(owners.get(p.id), child, p.bodyRecord, p.bodyName, relativePlacement(p.ownerPlacement, world));
      } else if (p.source === "model") {
        const mm = mergedModel(p.model.data);
        const wrap = assembly(p.ref, desc);
        place(wrap, mm, p.ref + "-model", p.name || p.ref, p.model.placement);
        closeAssembly(wrap);
        place(top, wrap, p.ref, p.ref, p.placement, undefined, "atrium:" + p.id); // stable names: MCAD re-links by designator, or by the Waffle id
      } else {
        const cp = solidProduct(p.ref, desc, [p.body], p.color);
        place(top, cp, p.ref, p.ref, p.placement, undefined, "atrium:" + p.id);
      }
    }
    for (const owner of owners.values()) closeAssembly(owner);
    for (const l of m.layers) {
      const lp = solidProduct(name + " " + l.name, l.kind === "copper" ? "Copper" : "Silkscreen", l.prisms, l.color);
      place(top, lp, l.name, l.name);
    }
    closeAssembly(top);
    if (styled.length) E("MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION(''," + list(styled) + "," + R(ctx) + ")");

    const file = String(o.fileName || name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-") + ".step");
    const head = ["ISO-10303-21;", "HEADER;",
      "FILE_DESCRIPTION(('Waffle PCB assembly'),'2;1');",
      "FILE_NAME(" + str(file) + "," + str(timestamp(o)) + ",(" + str(o.author || "") + "),(" + str(o.organization || "") + "),'Waffle STEP export " + VERSION + "','Waffle','');",
      "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 3 1 1 }'));", "ENDSEC;", "DATA;"];
    const text = head.join("\n") + "\n" + out.join("\n") + "\nENDSEC;\nEND-ISO-10303-21;\n";
    step.last = {entities: n, faces: faceCount, instances, bytes: text.length, ms: Math.round((now() - t0) * 10) / 10};
    return text;
  }
  // Rewrites the argument list of a representation entity body to include an extra item.
  function reprArgs(body, extra) {
    const p = body.indexOf("(");
    let i = p + 1, depth = 0, k = 0, start = -1, end = -1;
    for (; i < body.length; i++) {
      const ch = body[i];
      if (ch === "'") { i++; while (i < body.length && !(body[i] === "'" && body[i + 1] !== "'")) i += body[i] === "'" ? 2 : 1; continue; }
      if (ch === "(") { depth++; if (depth === 1 && k === 1) start = i; }
      else if (ch === ")") { if (depth === 1 && k === 1) end = i; depth--; if (depth < 0) break; }
      else if (ch === "," && depth === 0) k++;
    }
    if (start < 0 || end < 0) throw Error("Unexpected representation layout in the component model.");
    const inner = body.slice(start + 1, end).trim();
    return body.slice(p + 1, start + 1) + (inner ? inner + "," : "") + extra + body.slice(end, body.lastIndexOf(")"));
  }

  // ---------------------------------------------------------------------------
  // glTF 2.0 binary (.glb) from mesh(): one node per part, shared meshes,
  // one material per colour. glTF is metres and Y up, so the root node scales
  // by 0.001 and turns Z up into Y up.
  function glb(meshed, opts = {}) {
    const views = [], accessors = [], meshes = [], materials = [], nodes = [], chunks = [];
    let offset = 0;
    const push = (arr, target) => {
      const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), pad = (4 - (offset % 4)) % 4;
      if (pad) { chunks.push(new Uint8Array(pad)); offset += pad; }
      views.push({buffer: 0, byteOffset: offset, byteLength: bytes.length, target}); chunks.push(bytes); offset += bytes.length;
      return views.length - 1;
    };
    const matIndex = new Map(), meshIndex = new Map();
    const material = (c, kind) => {
      const k = c.join(",") + kind;
      if (!matIndex.has(k)) { matIndex.set(k, materials.length); materials.push({name: kind, pbrMetallicRoughness: {baseColorFactor: [...c, 1], metallicFactor: kind === "copper" ? 0.8 : 0, roughnessFactor: kind === "copper" ? 0.35 : 0.65}}); }
      return matIndex.get(k);
    };
    for (const part of meshed.parts) {
      if (!part.indices.length) continue;
      const mat = material(part.color, part.kind);
      let geo = meshIndex.get(part.positions);
      if (!geo) {
        const P = part.positions, lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < P.length; i += 3) for (let k = 0; k < 3; k++) { const v = P[i + k]; if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
        const pv = push(P, 34962), nv = push(part.normals, 34962), iv = push(part.indices, 34963);
        accessors.push({bufferView: pv, componentType: 5126, count: P.length / 3, type: "VEC3", min: lo, max: hi},
          {bufferView: nv, componentType: 5126, count: P.length / 3, type: "VEC3"}, {bufferView: iv, componentType: 5125, count: part.indices.length, type: "SCALAR"});
        geo = {a: accessors.length - 3, meshes: new Map()}; meshIndex.set(part.positions, geo);
      }
      let mi = geo.meshes.get(mat);
      if (mi == null) { mi = meshes.length; geo.meshes.set(mat, mi); meshes.push({name: part.kind === "component" ? part.name : part.name, primitives: [{attributes: {POSITION: geo.a, NORMAL: geo.a + 1}, indices: geo.a + 2, material: mat}]}); }
      const node = {name: part.name, mesh: mi}, M = Array.from(part.matrix);
      if (M.some((v, i) => Math.abs(v - IDENTITY[i]) > 1e-12)) node.matrix = M;
      nodes.push(node);
    }
    const s = 0.001;
    nodes.push({name: opts.name || "Board", matrix: [s, 0, 0, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, 0, 0, 1], children: nodes.map((_, i) => i)});
    const json = {asset: {version: "2.0", generator: "Waffle " + VERSION}, scene: 0, scenes: [{nodes: [nodes.length - 1]}], nodes, meshes, materials, accessors, bufferViews: views, buffers: [{byteLength: offset}]};
    const enc = new TextEncoder().encode(JSON.stringify(json)), jl = (enc.length + 3) & ~3, bl = (offset + 3) & ~3;
    const out = new Uint8Array(12 + 8 + jl + 8 + bl), dv = new DataView(out.buffer);
    dv.setUint32(0, 0x46546C67, true); dv.setUint32(4, 2, true); dv.setUint32(8, out.length, true);
    dv.setUint32(12, jl, true); dv.setUint32(16, 0x4E4F534A, true); out.set(enc, 20); out.fill(32, 20 + enc.length, 20 + jl);
    const b0 = 20 + jl; dv.setUint32(b0, bl, true); dv.setUint32(b0 + 4, 0x004E4942, true);
    let at = b0 + 8; for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  function exportSTEP(project, requested, opts = {}) { return step(model(project, requested, opts), opts); }
  // {name, data (string for STEP, Uint8Array for glb), notes, stats}. opts.format: "step" (default) or "glb".
  function build(project, requested, opts = {}) {
    return buildModel(model(project, requested, opts), opts);
  }
  function buildModel(m, opts) {
    const t0 = now(), base = m.name.replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim() || "Board";
    const counts = {holes: m.board.holes.length, parts: m.parts.length, layers: m.layers.length};
    if (opts.format === "glb") {
      const modelMesh = opts.modelMesh || ((asset, text) => typeof asset === "object" && text ? globalThis.AtriumSTEPImport?.ensure(text) : null);
      const meshed = mesh(m, {...opts, modelMesh}), data = glb(meshed, {name: m.name});
      opts.meshResult?.(meshed);
      return {name: base + ".glb", data, notes: m.notes, stats: {...meshed.stats, ...counts, bytes: data.length, ms: Math.round((now() - t0) * 10) / 10}};
    }
    const text = step(m, opts);
    return {name: base + ".step", data: text, text, notes: m.notes, stats: {...step.last, ...counts, ms: Math.round((now() - t0) * 10) / 10}};
  }

  // ---------------------------------------------------------------------------
  // Only input-derived body data is sent to the export worker. All live board,
  // variant, stack and fold decisions have already been made by model().
  async function resolveBodyGeometry(m, opts, decode, core, signal) {
    const parsed = new Map(), meshes = new Map();
    let bytes = 0;
    for (const p of m.parts) {
      if (signal?.aborted) throw Object.assign(Error("STEP export cancelled."), {name: "AbortError"});
      const a = p.model?.asset;
      if (!a) continue;
      const key = a.zlib || a.stepText;
      if (!parsed.has(key)) {
        try {
          const text = await decode(a, Math.min(32 * 1048576, 128 * 1048576 - bytes));
          bytes += text.length;
          parsed.set(key, {text, data: readModel(text)});
          if (opts.format === "glb") meshes.set(key, core.tessellate(text));
        } catch (e) { parsed.set(key, null); m.notes.push("STEP body " + (a.file || a.id) + " was omitted. " + e.message); }
      }
      if (parsed.get(key)) Object.assign(p.model, parsed.get(key));
    }
    if (signal?.aborted) throw Object.assign(Error("STEP export cancelled."), {name: "AbortError"});
    m.parts = m.parts.filter(p => !p.model?.asset || p.model.data);
    return buildModel(m, {...opts, modelMesh: a => meshes.get(a?.zlib || a?.stepText)});
  }
  async function buildAsync(project, doc, opts = {}, signal) {
    const checkCancelled = () => {
      if (signal?.aborted) throw Object.assign(Error("STEP export cancelled."), {name: "AbortError"});
    };
    checkCancelled();
    if ((opts.copper || opts.silk) && !opts.geometryView) {
      const L = globalThis.AtriumLazy;
      if (!globalThis.AtriumFabOutputs || !globalThis.AtriumResolvedGeometry)
        await L?.need("AtriumFabOutputs");
      if (globalThis.AtriumGeometryReceipts?.requiresRuleQuery(project, boardFor(project, doc)))
        await L?.need(["AtriumDesignQuery", "AtriumQueryExchange"]);
    }
    checkCancelled();
    const m = model(project, doc, {...opts, deferBodyModels: true});
    if (!m.parts.some(p => p.model?.asset)) return buildModel(m, opts);
    const I = globalThis.AtriumSTEPImport || await globalThis.AtriumLazy?.need("AtriumSTEPImport");
    const serializable = values => Object.fromEntries(Object.entries(values).filter(([key, value]) => key !== "geometryView" && typeof value !== "function"));
    m.options = serializable(m.options);
    const options = serializable(opts);
    let worker, url;
    try {
      if (I && typeof Worker === "function" && typeof DecompressionStream === "function" && globalThis.URL?.createObjectURL) {
        const src = '"use strict";globalThis.AtriumGeometryCurves=' + AtriumGeometryCurves.source() +
          ';const F=(' + I.core.toString() + '),A=(' + AtriumGeometry.createAffine3D.toString() + ')(),S=(' + createSTEP.toString() + ')(F,A),decode=' + I.decodeAsset.toString() +
          (opts.format === "glb" ? ',C=F();' : ',C=null;') +
          'onmessage=async({data})=>{try{const r=await S.resolveBodyGeometry(data.m,data.options,decode,C);delete r.text;postMessage({r},r.data?.buffer?[r.data.buffer]:[])}catch(e){postMessage({error:e.message})}};';
        url = URL.createObjectURL(new Blob([src], {type: "text/javascript"})); worker = new Worker(url);
      }
    } catch { /* no worker on this host */ }
    finally { if (url) URL.revokeObjectURL(url); }
    if (!worker) {
      const decode = async (a, limit) => {
        await new Promise(done => setTimeout(done, 0));
        const text = a.stepText || globalThis.AtriumImportFormats?.stepText(a);
        if (typeof text !== "string" || text.length > limit) throw Error("STEP body exceeds the output limit.");
        return text;
      };
      return resolveBodyGeometry(m, options, decode, I, signal);
    }
    return new Promise((resolve, reject) => {
      function done(error, result) {
        clearTimeout(timer); worker.terminate(); signal?.removeEventListener("abort", cancel);
        if (error) reject(error); else { if (typeof result.data === "string") result.text = result.data; resolve(result); }
      }
      const cancel = () => done(Object.assign(Error("STEP export cancelled."), {name: "AbortError"}));
      const timer = setTimeout(() => done(Error("The STEP export exceeded 90 seconds.")), 90000);
      signal?.addEventListener("abort", cancel, {once: true});
      if (signal?.aborted) { cancel(); return; }
      worker.onmessage = ({data}) => done(data.error ? Error(data.error) : null, data.r);
      worker.onerror = e => { e.preventDefault?.(); done(Error("The STEP export worker stopped.")); };
      worker.onmessageerror = () => done(Error("The STEP export worker returned an unreadable result."));
      try { worker.postMessage({m, options}); } catch (error) { done(error); }
    });
  }

  // Dialog: File → Export 3D STEP…
  const remembered = {};
  function open(ctx) {
    const project = ctx.project, boards = project.documents.filter(d => d.kind === "pcb");
    let doc = ctx.doc?.kind === "pcb" ? ctx.doc : boards[0];
    if (!doc) { ctx.info?.("Open a board layout first."); return; }
    const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
    const d = el("dialog", null, "work-dialog ui-dialog fab-dialog step-dialog"); d.setAttribute("aria-label", "Export 3D model");
    const controller = new AbortController();
    d.onclose = () => { controller.abort(); d.remove(); };
    const o = {components: true, generated: true, copper: false, silk: false, vias: true, boardColor: "#0d5426", ...remembered};
    const rows = el("div");
    const check = (key, label, hint) => {
      const l = el("label", null, "work-row fab-row"), i = el("input", null, "ui-checkbox"); i.type = "checkbox"; i.checked = !!o[key];
      i.onchange = () => { o[key] = i.checked; sync(); };
      l.append(el("span", label), i); if (hint) l.append(el("small", hint)); rows.append(l); return i;
    };
    if (boards.length > 1) {
      const s = el("select", null, "ui-field"); s.setAttribute("aria-label", "Board");
      for (const b of boards) s.add(new Option(b.name, b.id));
      s.value = doc.id; s.onchange = () => { doc = boards.find(b => b.id === s.value); syncFold?.(); };
      const l = el("label", null, "work-row fab-row"); l.append(el("span", "Board"), s); rows.append(l);
    }
    const fmt = el("select", null, "ui-field"); fmt.setAttribute("aria-label", "Format");
    fmt.add(new Option("STEP AP214 (.step)", "step")); fmt.add(new Option("glTF binary (.glb)", "glb"));
    fmt.value = o.format === "glb" ? "glb" : "step"; fmt.onchange = () => { o.format = fmt.value; };
    { const l = el("label", null, "work-row fab-row"); l.append(el("span", "Format"), fmt, el("small", "STEP for MCAD; glTF for viewers and renderers")); rows.append(l); }
    const variantList = globalThis.AtriumVariants?.list(project) || [];
    if (variantList.length) {
      const s = el("select", null, "ui-field"); s.setAttribute("aria-label", "Assembly variant");
      s.add(new Option("Base design", "")); for (const v of variantList) s.add(new Option(v.name, v.id));
      const act = AtriumVariants.find(project, project.activeVariant);
      s.value = act ? act.id : "";
      o.variant = s.value; s.onchange = () => { o.variant = s.value; };
      const l = el("label", null, "work-row fab-row"); l.append(el("span", "Variant"), s, el("small", "Not-fitted parts are left out")); rows.append(l);
    }
    // Rigid-flex: the fold state (flat, folded, or the 3D view's fold slider).
    const foldRow = el("label", null, "work-row fab-row"), foldSel = el("select", null, "ui-field"); foldSel.setAttribute("aria-label", "Fold state");
    const foldHint = el("small", "Bend zones become planar-faced segments; components ride the fold");
    function syncFold() {
      const has = !!globalThis.AtriumFlexFold?.hasBends?.(doc), keep = foldSel.value;
      foldRow.hidden = !has; foldSel.replaceChildren(new Option("Flat", "0"), new Option("Folded", "1"));
      const v3 = [...(globalThis.Atrium3D?.viewers?.values?.() || [])].find(x => !x.closed && x.doc?.() === doc), t = v3?.foldState?.() || 0;
      if (t > 0 && t < 1) foldSel.add(new Option("As in the 3D view (" + Math.round(t * 100) + " %)", String(t)));
      foldSel.value = [...foldSel.options].some(x => x.value === keep) ? keep : t > 0 ? String(t) : "0";
      o.fold = has ? +foldSel.value : 0;
    }
    foldSel.onchange = () => { o.fold = +foldSel.value; };
    foldRow.append(el("span", "Fold"), foldSel, foldHint); rows.append(foldRow); syncFold();
    const comp = check("components", "Components", "One product per designator");
    const gen = check("generated", "Generated bodies", "Extruded from the body or courtyard outline where a part has no 3D model");
    check("vias", "Via holes", "Drill vias through the board body (larger files)");
    check("copper", "Copper", "Top and bottom copper at their layer stack thickness (large files)");
    check("silk", "Silkscreen", "Silkscreen as thin solids");
    const colour = el("input"); colour.type = "color"; colour.value = o.boardColor; colour.setAttribute("aria-label", "Board colour");
    colour.oninput = () => { o.boardColor = colour.value; };
    { const l = el("label", null, "work-row fab-row"); l.append(el("span", "Board colour"), colour); rows.append(l); }
    const status = el("p", null, "fab-status"); status.setAttribute("role", "status");
    function sync() { gen.disabled = !comp.checked; }
    sync();
    const foot = el("div", null, "work-actions ui-dialog-actions");
    const btn = (t, f) => { const b = el("button", t, "ui-button"); b.type = "button"; b.onclick = f; return b; };
    let busy = false;
    const go = btn("Export…", async () => {
      if (busy) return; busy = true; go.disabled = true; status.textContent = "Generating…";
      try {
        Object.assign(remembered, o);
        const client = await globalThis.AtriumLazy.need("AtriumTranslatorClient");
        const {files, details} = await client.export(o.format === "glb" ? "glb" : "step", project,
          {...o, documentId:doc.id, signal:controller.signal, provenance:globalThis.AtriumImportReports?.provenance()});
        if (controller.signal.aborted) return;
        const r = {...details, name:files[0].name, data:files[0].text ?? files[0].bytes};
        status.textContent = "";
        if (r.notes.length) status.textContent = r.notes.join(" ");
        if (await ctx.exportFile(r.name, r.data)) {
          ctx.info?.("Exported " + r.name + " · " + r.stats.parts + " component" + (r.stats.parts === 1 ? "" : "s") + " · " + (r.data.length / 1048576).toFixed(1) + " MB" +
            (r.notes.length ? " · " + r.notes.length + " note" + (r.notes.length === 1 ? "" : "s") + ": " + r.notes[0] : ""));
          d.close();
        }
      } catch (e) { status.textContent = e.message; }
      finally { busy = false; go.disabled = false; }
    });
    go.dataset.variant = "primary";
    foot.append(btn("Cancel", () => d.close()), go);
    const title = el("h2", "Export 3D STEP");
    d.append(title, el("p", "The board with its holes and cutouts, and the components, as a 3D model for MCAD enclosure work.", "fab-hint"), rows, status, foot);
    globalThis.AtriumShell.adoptDialog(d, {title, body: rows, actions: foot, defaultAction: false});
    document.body.append(d);
    d.showModal();
    return d;
  }

  return Object.freeze({VERSION, DEFAULTS, COLORS, model, layersFor, layerStepsFor, mesh, step, glb, export: exportSTEP, build, buildModel, buildAsync, resolveBodyGeometry, open, parse, parseBody, readModel, triangulate,
    loopArea, circleLoop, flattenLoop, packageHeight, paramHeight, parseLength, eulerPlacement});
})(globalThis.AtriumSTEPImport.core, globalThis.AtriumGeometry.affine3D);
