"use strict";
if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
if (!globalThis.AtriumBoardShape && typeof require === "function") require("./board-shape-core.js");
// Panelization (Tools › Panelize…): a panel document that places boards in an
// embedded array, in the manner of Altium's embedded board arrays and EasyEDA's
// panel editor. The panel stores references and parameters only; every view,
// check and output reads the referenced boards as they are now, so edits to a
// board flow into its panel.
//
// Panel document: {id, kind:"panel", name, grid, items:[], outline:[], notes:[], panel:{...}}
//   panel = {version:1, board:<pcb id>, rows, cols, spacing (mm between boards),
//     rotation (0|90|180|270, every instance), cells:{"r,c":{board?, rotation?, mirror?, skip?}},
//     separation:"mousebite"|"vscore",
//     rails:{top,bottom,left,right (booleans), width},
//     tabs:{width, perEdge, hole, pitch, offset},       mouse-bite tab routing
//     fiducials:{enabled, diameter, opening}, tooling:{enabled, diameter, inset},
//     text:{enabled, size, revision, date}, fabProfile?:<fab profile id for checks>,
//     Optional (added 2026-11-19; still panel version 1, a minor addition: older Waffle ignores them):
//     spacingY?        mm between rows when it differs from `spacing` (which is then the column gap)
//     alternate?       "rows"|"cols"|"both": every other row / column / checkerboard cell turns 180°
//     tabs.manual?     {"r,c:side": [fraction along the edge, ...]}: dragged tab centres (0..1 from the
//                      left/top end of that board edge); an edge listed here ignores tabs.perEdge
//     thieving?        {enabled, pattern:"dots"|"hatch", size, pitch, clearance}: copper on the rails
//     mill?            {radius}: routing-bit radius; inside corners of the routed profile are filleted
//     preset?          id of the preset the panel started from (PRESETS), informational
//   Keys this build does not know are kept as they are (a newer Waffle's fields round-trip).
// Rows count from the top of the panel, columns from the left (0-based in cells).
//
// Geometry is rectilinear: instances rotate by quarter turns, and tab routing
// separates each board along its bounding box. The routed profile is the
// boundary of rails ∪ boards ∪ tabs (an exact union of rectangles).
//
// Outputs reuse the fabrication writers (fab-outputs.js): each board is
// analysed once and its plotted features are repeated through each instance's
// transform. Mouse bites and tooling holes are NPTH, fiducials are copper with a
// mask opening, rail text is top overlay, and V-score lines go to their own
// layer (Mechanical 2, X2 file function Vcut, *.GM2), the convention JLCPCB and
// PCBWay accept for V-cut lines. Panel pick and place gives each instance's
// parts a suffix: R1 of instance 3 is R1_3.
//
// ALL FAB LIMITS USED BY THE PANEL CHECK ARE APPROXIMATE.
globalThis.AtriumPanel = (() => {
  const VERSION = 1;
  const A = () => globalThis.Atrium;
  const F = () => globalThis.AtriumFabOutputs;
  const APPROX = "Panel checks are approximate. Check the panel against the fab's current panelization rules before ordering.";
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const fail = m => { throw Error(m); };
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const clamp = (v, lo, hi, d) => fin(+v) ? Math.min(hi, Math.max(lo, +v)) : d;
  const quarter = v => ((Math.round((+v || 0) / 90) * 90) % 360 + 360) % 360;

  // Fallback panel limits when the fab profile has none (fab-profiles.js panelRules).
  const GENERIC = Object.freeze({vendor: "Generic", approximate: true, vScoreClearance: .5, vScoreMinPanel: [70, 70], maxPanel: [500, 500],
    routeGap: 1.6, minWeb: .3, biteHole: .6, bitePitch: .95, vScoreLineGap: 2, edgeClearance: .3, tabPartClearance: 1, vScorePartClearance: 1, sources: []});

  const DEFAULTS = Object.freeze({version: VERSION, rows: 2, cols: 2, spacing: 2, rotation: 0, separation: "mousebite",
    rails: Object.freeze({top: true, bottom: true, left: false, right: false, width: 5}),
    tabs: Object.freeze({width: 3, perEdge: 2, hole: .6, pitch: .95, offset: 0}),
    fiducials: Object.freeze({enabled: true, diameter: 1, opening: 2}),
    tooling: Object.freeze({enabled: true, diameter: 2, inset: 4}),
    text: Object.freeze({enabled: true, size: 1.2, revision: "", date: true})});
  const THIEVING = Object.freeze({enabled: false, pattern: "dots", size: 1, pitch: 2, clearance: 1});
  const ALTERNATE = ["none", "rows", "cols", "both"];
  const KNOWN = new Set(["version", "board", "rows", "cols", "spacing", "spacingY", "rotation", "alternate", "separation", "rails", "tabs", "fiducials", "tooling",
    "text", "cells", "fabProfile", "thieving", "mill", "preset"]);

  // Presets: a fab-ready starting point in one click. Each sets the separation, frame and features;
  // rows and columns only where the name says so. Applying one keeps the board, the cells and the name.
  const PRESETS = Object.freeze([
    {id: "jlc-vscore-2x2", name: "JLC 2×2 V-score", hint: "Four boards abutting, V-cut, 5 mm rails top and bottom with fiducials and tooling holes (JLCPCB).",
      params: {rows: 2, cols: 2, separation: "vscore", spacing: 0, rails: {top: true, bottom: true, left: false, right: false, width: 5},
        fiducials: {enabled: true, diameter: 1, opening: 2}, tooling: {enabled: true, diameter: 2, inset: 4}, text: {enabled: true, date: true}, fabProfile: "jlcpcb-2l", mill: {radius: 0}}},
    {id: "mousebite-5mm-rails", name: "Mouse-bite tabs, 5 mm rails", hint: "2 mm routed gaps, 3 mm tabs with 0.5 mm mouse bites, 5 mm rails top and bottom.",
      params: {separation: "mousebite", spacing: 2, rails: {top: true, bottom: true, left: false, right: false, width: 5},
        tabs: {width: 3, perEdge: 2, hole: .5, pitch: .8, offset: 0}, fiducials: {enabled: true, diameter: 1, opening: 2}, tooling: {enabled: true, diameter: 2, inset: 4},
        text: {enabled: true, date: true}, mill: {radius: 1}}},
    {id: "frame-mousebite", name: "Frame with mouse bites", hint: "A 5 mm frame on all four sides holds every board; best for odd shapes and heavy parts.",
      params: {separation: "mousebite", spacing: 2.4, rails: {top: true, bottom: true, left: true, right: true, width: 5},
        tabs: {width: 3, perEdge: 2, hole: .5, pitch: .8, offset: 0}, fiducials: {enabled: true, diameter: 1, opening: 2}, tooling: {enabled: true, diameter: 2, inset: 4},
        text: {enabled: true, date: true}, mill: {radius: 1}}},
    {id: "assembly-frame", name: "Assembly frame, copper thieving", hint: "Frame with fiducials, tooling holes and dotted copper on the rails for even plating.",
      params: {separation: "mousebite", spacing: 2.4, rails: {top: true, bottom: true, left: true, right: true, width: 7},
        tabs: {width: 3, perEdge: 2, hole: .5, pitch: .8, offset: 0}, fiducials: {enabled: true, diameter: 1, opening: 2}, tooling: {enabled: true, diameter: 2.5, inset: 4},
        text: {enabled: true, date: true}, thieving: {enabled: true, pattern: "dots", size: 1, pitch: 2, clearance: 1}, mill: {radius: 1}}},
    {id: "proto-pair", name: "Prototype pair, no rails", hint: "Two boards joined by mouse-bite tabs, no frame: the smallest order.",
      params: {rows: 1, cols: 2, separation: "mousebite", spacing: 2, rails: {top: false, bottom: false, left: false, right: false, width: 5},
        tabs: {width: 3, perEdge: 2, hole: .5, pitch: .8, offset: 0}, fiducials: {enabled: false}, tooling: {enabled: false}, text: {enabled: false}, mill: {radius: 1}}}
  ].map(p => Object.freeze(p)));

  // ------------------------------------------------------------------ data
  const SUB_KEYS = {rails: ["top", "bottom", "left", "right", "width"], tabs: ["width", "perEdge", "hole", "pitch", "offset", "manual"], fiducials: ["enabled", "diameter", "opening"],
    tooling: ["enabled", "diameter", "inset"], text: ["enabled", "size", "revision", "date"], thieving: ["enabled", "pattern", "size", "pitch", "clearance"], mill: ["radius"]};
  function normalize(raw) {
    const p = plain(raw) ? raw : {}, d = DEFAULTS, out = {version: VERSION};
    out.board = typeof p.board === "string" ? p.board : "";
    out.rows = Math.round(clamp(p.rows, 1, 30, d.rows));
    out.cols = Math.round(clamp(p.cols, 1, 30, d.cols));
    // A separation or alternation a newer Waffle wrote is kept as written (drawn as mouse-bites / not alternated).
    const other = v => typeof v === "string" && v.length <= 32 && /^[a-z][\w-]*$/.test(v);
    out.separation = p.separation === "vscore" ? "vscore" : p.separation !== "mousebite" && other(p.separation) ? p.separation : "mousebite";
    out.spacing = r4(clamp(p.spacing, 0, 50, out.separation === "vscore" ? 0 : d.spacing));
    if (p.spacingY != null && fin(+p.spacingY)) { const y = r4(clamp(p.spacingY, 0, 50, out.spacing)); if (y !== out.spacing) out.spacingY = y; }
    out.rotation = quarter(p.rotation);
    if ((ALTERNATE.includes(p.alternate) || other(p.alternate)) && p.alternate !== "none") out.alternate = p.alternate;
    const r = plain(p.rails) ? p.rails : {};
    out.rails = {top: r.top ?? d.rails.top, bottom: r.bottom ?? d.rails.bottom, left: r.left ?? d.rails.left, right: r.right ?? d.rails.right, width: r4(clamp(r.width, 0, 50, d.rails.width))};
    for (const k of ["top", "bottom", "left", "right"]) out.rails[k] = out.rails[k] === true;
    const t = plain(p.tabs) ? p.tabs : {};
    out.tabs = {width: r4(clamp(t.width, .3, 50, d.tabs.width)), perEdge: Math.round(clamp(t.perEdge, 0, 12, d.tabs.perEdge)),
      hole: r4(clamp(t.hole, 0, 3, d.tabs.hole)), pitch: r4(clamp(t.pitch, .1, 10, d.tabs.pitch)), offset: r4(clamp(t.offset, -2, 2, d.tabs.offset))};
    if (plain(t.manual)) {
      const manual = {};
      for (const [k, v] of Object.entries(t.manual)) {
        const m = /^(\d+),(\d+):(left|right|top|bottom)$/.exec(k);
        if (!m || !Array.isArray(v) || +m[1] >= out.rows || +m[2] >= out.cols) continue;
        manual[k] = [...new Set(v.filter(x => fin(+x)).map(x => r4(clamp(x, 0, 1, .5))))].sort((a, b) => a - b).slice(0, 12);
      }
      if (Object.keys(manual).length) out.tabs.manual = manual;
    }
    const f = plain(p.fiducials) ? p.fiducials : {};
    out.fiducials = {enabled: f.enabled ?? d.fiducials.enabled, diameter: r4(clamp(f.diameter, .2, 5, d.fiducials.diameter)), opening: r4(clamp(f.opening, .2, 10, d.fiducials.opening))};
    out.fiducials.enabled = out.fiducials.enabled === true;
    if (out.fiducials.opening < out.fiducials.diameter) out.fiducials.opening = out.fiducials.diameter;
    const g = plain(p.tooling) ? p.tooling : {};
    out.tooling = {enabled: (g.enabled ?? d.tooling.enabled) === true, diameter: r4(clamp(g.diameter, .5, 6.5, d.tooling.diameter)), inset: r4(clamp(g.inset, 1, 50, d.tooling.inset))};
    const x = plain(p.text) ? p.text : {};
    out.text = {enabled: (x.enabled ?? d.text.enabled) === true, size: r4(clamp(x.size, .5, 10, d.text.size)),
      revision: typeof x.revision === "string" ? x.revision.slice(0, 40) : "", date: (x.date ?? d.text.date) === true};
    out.cells = {};
    if (plain(p.cells)) for (const [k, v] of Object.entries(p.cells)) {
      const m = /^(\d+),(\d+)$/.exec(k);
      if (!m || !plain(v) || +m[1] >= out.rows || +m[2] >= out.cols) continue;
      const c = {};
      if (typeof v.board === "string" && v.board) c.board = v.board;
      if (v.rotation != null) c.rotation = quarter(v.rotation);
      if (v.skip === true) c.skip = true;
      if (v.mirror === true) c.mirror = true;
      if (Object.keys(c).length) out.cells[k] = c;
    }
    if (typeof p.fabProfile === "string" && p.fabProfile) out.fabProfile = p.fabProfile.slice(0, 80);
    if (plain(p.thieving)) {
      const h = p.thieving, D = THIEVING;
      out.thieving = {enabled: h.enabled === true, pattern: h.pattern === "hatch" ? "hatch" : "dots", size: r4(clamp(h.size, .2, 5, D.size)),
        pitch: r4(clamp(h.pitch, .5, 20, D.pitch)), clearance: r4(clamp(h.clearance, 0, 10, D.clearance))};
      if (out.thieving.pitch < out.thieving.size * 1.2) out.thieving.pitch = r4(out.thieving.size * 1.2);
      if (!out.thieving.enabled && JSON.stringify({...out.thieving, enabled: false}) === JSON.stringify({...D})) delete out.thieving;
    }
    if (plain(p.mill)) { const r = r4(clamp(p.mill.radius, 0, 5, 0)); if (r > 0) out.mill = {radius: r}; }
    // Fields a newer Waffle wrote inside the sub-objects stay too.
    for (const k of ["rails", "tabs", "fiducials", "tooling", "text", "thieving", "mill"]) if (plain(p[k])) {
      const extra = Object.entries(p[k]).filter(([f]) => !(SUB_KEYS[k] || []).includes(f) && f !== "__proto__");
      if (extra.length) out[k] = {...out[k] || {}, ...Object.fromEntries(extra)};
    }
    if (plain(p.cells)) for (const [k, v] of Object.entries(p.cells)) if (plain(v) && /^\d+,\d+$/.test(k)) {
      const extra = Object.entries(v).filter(([f]) => !["board", "rotation", "skip"].includes(f) && f !== "__proto__");
      if (extra.length && out.cells[k] || extra.length && +k.split(",")[0] < out.rows && +k.split(",")[1] < out.cols) out.cells[k] = {...out.cells[k] || {}, ...Object.fromEntries(extra)};
    }
    if (typeof p.preset === "string" && PRESETS.some(x => x.id === p.preset)) out.preset = p.preset;
    // Forward compatibility: fields a newer Waffle wrote stay as they are.
    for (const [k, v] of Object.entries(p)) if (!KNOWN.has(k) && !(k in out)) out[k] = v;
    return out;
  }
  // The panel with a preset applied: keeps the board, the cells and any field the preset does not set.
  function applyPreset(raw, id) {
    const pr = PRESETS.find(x => x.id === id || x.name === id) || fail("Unknown panel preset " + id + ". Presets: " + PRESETS.map(x => x.id).join(", ") + ".");
    const cur = normalize(raw), q = pr.params, next = {...cur, ...q, preset: pr.id};
    for (const k of ["rails", "tabs", "fiducials", "tooling", "text", "thieving"]) if (q[k]) next[k] = {...(cur[k] || {}), ...q[k]};
    if (next.tabs) delete next.tabs.manual;
    if (!q.thieving && next.thieving) next.thieving = {...next.thieving, enabled: false};
    delete next.spacingY;
    if (!("alternate" in q)) delete next.alternate;
    return normalize(next);
  }
  // Structural check used by model.js validate (minimal: the shape, never the board).
  // lenient: a file from a newer version (model.js): an unknown separation or alternation is kept.
  function validate(raw, lenient) {
    if (!plain(raw)) fail("A panel must be an object.");
    if (raw.version != null && raw.version !== VERSION) fail("Unsupported panel version.");
    if (typeof raw.board !== "string") fail("A panel must name its board.");
    for (const k of ["rows", "cols", "spacing", "rotation"]) if (raw[k] != null && !fin(raw[k])) fail("Panel " + k + " must be a number.");
    if (raw.separation != null && !["mousebite", "vscore"].includes(raw.separation) && !(lenient && typeof raw.separation === "string")) fail("Panel separation must be mousebite or vscore.");
    for (const k of ["rails", "tabs", "fiducials", "tooling", "text", "cells", "thieving", "mill"]) if (raw[k] != null && !plain(raw[k])) fail("Panel " + k + " must be an object.");
    if (raw.spacingY != null && !fin(raw.spacingY)) fail("Panel spacingY must be a number.");
    if (raw.alternate != null && !ALTERNATE.includes(raw.alternate) && !(lenient && typeof raw.alternate === "string")) fail("Panel alternate must be none, rows, cols or both.");
    if (raw.tabs?.manual != null && !plain(raw.tabs.manual)) fail("Panel tabs.manual must be an object.");
    for (const k of ["rails", "tabs", "fiducials", "tooling", "text", "thieving", "mill"]) if (raw[k]) for (const v of Object.values(raw[k])) if (typeof v === "number" && !Number.isFinite(v)) fail("Panel " + k + " has an invalid number.");
    return raw;
  }
  const boardsOf = project => (project?.documents || []).filter(d => d.kind === "pcb");
  const boardById = (project, id) => boardsOf(project).find(d => d.id === id || d.name === id) || null;
  function panelOf(project, ref) {
    if (plain(ref) && ref.kind === "panel") return ref;
    const panels = (project?.documents || []).filter(d => d.kind === "panel");
    const d = ref == null ? panels[0] : panels.find(x => x.id === ref || x.name === ref);
    return d || fail(ref == null ? "The project has no panel. Use Tools › Panelize… or the panelize tool first." : "The project has no panel " + ref + ".");
  }
  // A new panel document (not added to the project).
  function create(project, options = {}) {
    const board = boardById(project, options.board) || (options.board == null ? boardsOf(project)[0] : null);
    if (!board) fail(options.board == null ? "The project has no board layout to panelize." : "The project has no board layout " + options.board + ".");
    const used = new Set(project.documents.map(d => d.name.trim().toLowerCase()));
    let name = String(options.name || board.name + " panel").slice(0, 120), n = 2;
    const base = name;
    while (used.has(name.toLowerCase())) name = base + " " + n++;
    const id = A()?.id ? A().id() : "panel-" + Math.random().toString(36).slice(2, 10);
    const panel = normalize({...options, board: board.id});
    if (!options.fabProfile && board.fabProfile?.id) panel.fabProfile = board.fabProfile.id;
    return {id, kind: "panel", name, grid: 1, items: [], outline: [], notes: [], panel};
  }

  // ------------------------------------------------------------------ boards
  function boardInfo(board, defs) {
    const outline = Array.isArray(board.outline) && board.outline.length >= 3 ? board.outline : null;
    const box = outline ? A().bounds(outline) : A().docBounds(board, defs) || [0, 0, 10, 10];
    const w = box[2] - box[0], h = box[3] - box[1];
    const rect = !!outline && Math.abs(Math.abs(AtriumBoardShape.polyArea(outline)) - w * h) <= Math.max(1e-6, w * h * 1e-4);
    const shape = globalThis.AtriumBoardShape?.fresh?.(board) || null;
    const poly = outline ? outline.filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]) : [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]];
    return {board, box, w, h, rect: !outline || rect, outline: !!outline, poly, cutouts: shape?.cutouts || [], center: [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2]};
  }

  // ------------------------------------------------------------------ rectangles to profile
  // Boundary of a union of axis-aligned rectangles, on the compressed grid of their edges.
  // Outer loops run counter-clockwise on screen (Y down), holes clockwise (AtriumBoardShape convention).
  function trace(rects) {
    const K = v => r6(v);
    const xs = [...new Set(rects.flatMap(r => [K(r[0]), K(r[2])]))].sort((a, b) => a - b);
    const ys = [...new Set(rects.flatMap(r => [K(r[1]), K(r[3])]))].sort((a, b) => a - b);
    const nx = xs.length - 1, ny = ys.length - 1;
    if (nx < 1 || ny < 1) return [];
    const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
    const fill = new Uint8Array(nx * ny);
    for (const r of rects) {
      const i0 = xi.get(K(r[0])), i1 = xi.get(K(r[2])), j0 = yi.get(K(r[1])), j1 = yi.get(K(r[3]));
      for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) fill[j * nx + i] = 1;
    }
    const on = (i, j) => i >= 0 && j >= 0 && i < nx && j < ny && fill[j * nx + i] === 1;
    const out = new Map(), key = (i, j) => i + "," + j;
    const add = (a, b) => { const k = key(a[0], a[1]); if (!out.has(k)) out.set(k, []); out.get(k).push(b); };
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      if (!on(i, j)) continue;
      if (!on(i, j - 1)) add([i + 1, j], [i, j]);
      if (!on(i - 1, j)) add([i, j], [i, j + 1]);
      if (!on(i, j + 1)) add([i, j + 1], [i + 1, j + 1]);
      if (!on(i + 1, j)) add([i + 1, j + 1], [i + 1, j]);
    }
    const loops = [];
    for (;;) {
      let start = null;
      for (const [k, list] of out) if (list.length) { start = k.split(",").map(Number); break; }
      if (!start) break;
      const loop = [start];
      let cur = start, dir = null;
      for (let guard = 0; guard < 4 * nx * ny + 8; guard++) {
        const list = out.get(key(cur[0], cur[1]));
        if (!list?.length) break;
        let pick = 0;
        if (list.length > 1 && dir) {
          // Pinch point: take the left turn (keeps loops apart where rectangles touch at a corner).
          const turn = n => { const d = [n[0] - cur[0], n[1] - cur[1]]; return dir[0] * d[1] - dir[1] * d[0]; };
          pick = list.reduce((best, n, i) => turn(n) < turn(list[best]) ? i : best, 0);
        }
        const next = list.splice(pick, 1)[0];
        dir = [next[0] - cur[0], next[1] - cur[1]];
        cur = next;
        if (cur[0] === start[0] && cur[1] === start[1]) break;
        loop.push(cur);
      }
      // Drop collinear vertices.
      const pts = loop.map(([i, j]) => [xs[i], ys[j]]);
      const clean = pts.filter((p, n) => {
        const a = pts[(n - 1 + pts.length) % pts.length], b = pts[(n + 1) % pts.length];
        return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > 1e-12;
      });
      if (clean.length >= 3) loops.push(clean);
    }
    const {polyArea} = AtriumBoardShape;
    const outer = loops.filter(l => polyArea(l) < 0).sort((a, b) => polyArea(a) - polyArea(b));
    const holes = loops.filter(l => polyArea(l) > 0);
    return {outer, holes};
  }

  // ------------------------------------------------------------------ real outlines
  const TAB_GRIP = .05; // tabs overlap the board by this much, so the union is never tangent
  // Distance from the line `from` (x for vertical edges, y for horizontal ones) into the
  // polygon along `dir` (+1/-1) at position `along`, or null when the ray misses within `limit`.
  function rayDepth(poly, horiz, from, dir, along, limit = Infinity) {
    let best = null;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const pa = horiz ? p[0] : p[1], qa = horiz ? q[0] : q[1], pn = horiz ? p[1] : p[0], qn = horiz ? q[1] : q[0];
      if ((pa - along) * (qa - along) > 0 || pa === qa) { if (pa === qa && pa === along) { for (const n of [pn, qn]) { const t = (n - from) * dir; if (t >= -1e-9 && (best == null || t < best)) best = Math.max(0, t); } } continue; }
      const n = pn + (qn - pn) * (along - pa) / (qa - pa), t = (n - from) * dir;
      if (t >= -1e-9 && (best == null || t < best)) best = Math.max(0, t);
    }
    return best != null && best <= limit ? best : null;
  }
  function depthInto(poly, horiz, from, dir, a, b, limit) {
    let worst = 0;
    for (let k = 0; k <= 6; k++) { const d = rayDepth(poly, horiz, from, dir, a + (b - a) * (.02 + .96 * k / 6), limit); if (d == null) return null; worst = Math.max(worst, d); }
    return worst;
  }
  function segX(a, b, c, d) {
    const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]], den = r[0] * s[1] - r[1] * s[0];
    if (Math.abs(den) < 1e-15) return null;
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / den, u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / den;
    return t > 1e-12 && t < 1 - 1e-12 && u > 1e-12 && u < 1 - 1e-12 ? {t, u, p: [a[0] + t * r[0], a[1] + t * r[1]]} : null;
  }
  // Boundary of (union of axis-aligned rectangles) ∪ (disjoint board polygons): every edge piece of
  // one that lies outside the other, chained into loops. Outer loops counter-clockwise on screen, holes clockwise.
  function routed(rects, polys) {
    const U = rects.length ? trace(rects) : {outer: [], holes: []};
    const inRects = p => rects.some(r => p[0] > r[0] + 1e-9 && p[0] < r[2] - 1e-9 && p[1] > r[1] + 1e-9 && p[1] < r[3] - 1e-9);
    const inPolys = p => polys.some(q => AtriumGeometry.inRing(p, q));
    const edges = [];
    for (const l of [...U.outer, ...U.holes]) for (let i = 0; i < l.length; i++) edges.push({a: l[i], b: l[(i + 1) % l.length], cuts: [], keep: inPolys, own: "r"});
    polys.forEach(q => { for (let i = 0; i < q.length; i++) edges.push({a: q[i], b: q[(i + 1) % q.length], cuts: [], keep: inRects, own: "p"}); });
    const box = e => [Math.min(e.a[0], e.b[0]), Math.min(e.a[1], e.b[1]), Math.max(e.a[0], e.b[0]), Math.max(e.a[1], e.b[1])];
    const R = edges.filter(e => e.own === "r"), Q = edges.filter(e => e.own === "p");
    for (const e of R) { const be = box(e); for (const f of Q) { const bf = box(f); if (bf[0] > be[2] || bf[2] < be[0] || bf[1] > be[3] || bf[3] < be[1]) continue; const x = segX(e.a, e.b, f.a, f.b); if (x) { const p = [r6(x.p[0]), r6(x.p[1])]; e.cuts.push([x.t, p]); f.cuts.push([x.u, p]); } } }
    const pieces = [];
    for (const e of edges) {
      const pts = [e.a, ...e.cuts.sort((x, y) => x[0] - y[0]).map(c => c[1]), e.b];
      for (let i = 1; i < pts.length; i++) {
        const m = [(pts[i - 1][0] + pts[i][0]) / 2, (pts[i - 1][1] + pts[i][1]) / 2];
        if (!e.keep(m) && (pts[i - 1][0] !== pts[i][0] || pts[i - 1][1] !== pts[i][1])) pieces.push([pts[i - 1], pts[i]]);
      }
    }
    const key = p => r6(p[0]) + "," + r6(p[1]), at = new Map();
    pieces.forEach((s, i) => { for (const p of s) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
    const used = new Uint8Array(pieces.length), loops = [];
    for (let i = 0; i < pieces.length; i++) {
      if (used[i]) continue;
      used[i] = 1;
      const loop = [pieces[i][0]];
      let cur = pieces[i][1];
      for (let guard = 0; guard <= pieces.length; guard++) {
        if (key(cur) === key(loop[0])) break;
        loop.push(cur);
        const next = (at.get(key(cur)) || []).find(j => !used[j]);
        if (next == null) break;
        used[next] = 1;
        cur = key(pieces[next][0]) === key(cur) ? pieces[next][1] : pieces[next][0];
      }
      const clean = loop.filter((p, n) => { const a = loop[(n - 1 + loop.length) % loop.length], b = loop[(n + 1) % loop.length]; return Math.abs((p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0])) > 1e-12; });
      if (clean.length >= 3) loops.push(clean);
    }
    // Nesting depth decides outer (even) or hole (odd); then orient.
    const {polyArea} = AtriumBoardShape, outer = [], holes = [];
    for (const l of loops) {
      const mid = [(l[0][0] + l[1][0]) / 2, (l[0][1] + l[1][1]) / 2];
      let depth = 0; for (const o of loops) if (o !== l && AtriumGeometry.inRing(mid, o)) depth++;
      const hole = depth % 2 === 1, a = polyArea(l);
      (hole ? holes : outer).push(hole ? (a > 0 ? l : l.slice().reverse()) : (a < 0 ? l : l.slice().reverse()));
    }
    outer.sort((a, b) => polyArea(a) - polyArea(b));
    return {outer, holes};
  }

  // ------------------------------------------------------------------ layout
  const SIDES = ["left", "right", "top", "bottom"];
  // Every position of the panel: instances with their transforms, rails, tabs, holes,
  // fiducials, V-score lines, rail text and the routed profile. Model coordinates (mm, Y down),
  // panel frame from (0, 0) to (W, H).
  function layout(project, doc, defs, options = {}) {
    const P = normalize(doc.panel), warnings = [];
    defs ||= new Map((project.library || []).map(d => [d.id, d]));
    const infos = new Map(), info = id => {
      if (!infos.has(id)) { const b = boardById(project, id); infos.set(id, b ? boardInfo(b, defs) : null); }
      return infos.get(id);
    };
    if (!info(P.board)) warnings.push("The panel's board is not in the project.");
    const vs = P.separation === "vscore", gx = P.spacing, gy = P.spacingY ?? P.spacing, g = Math.min(gx, gy);
    const rgx = vs ? 0 : Math.max(gx, 0), rgy = vs ? 0 : Math.max(gy, 0), rg = Math.min(rgx, rgy);
    const turn180 = (r, c) => (P.alternate === "rows" && r % 2 === 1) || (P.alternate === "cols" && c % 2 === 1) || (P.alternate === "both" && (r + c) % 2 === 1) ? 180 : 0;
    const cells = [];
    for (let r = 0; r < P.rows; r++) for (let c = 0; c < P.cols; c++) {
      const o = P.cells[r + "," + c] || {};
      if (o.skip) continue;
      const b = info(o.board || P.board);
      if (!b) { if (o.board) warnings.push("Cell " + (r + 1) + "," + (c + 1) + " names a board that is not in the project."); continue; }
      const rot = o.rotation ?? (P.rotation + turn180(r, c)) % 360, turn = rot % 180 !== 0;
      cells.push({r, c, b, rot, mirror:o.mirror === true, w: turn ? b.h : b.w, h: turn ? b.w : b.h});
    }
    const colW = Array(P.cols).fill(0), rowH = Array(P.rows).fill(0);
    for (const x of cells) { colW[x.c] = Math.max(colW[x.c], x.w); rowH[x.r] = Math.max(rowH[x.r], x.h); }
    const R = P.rails, rw = R.width > 0 ? R.width : 0;
    const has = s => R[s] && rw > 0;
    const ox = has("left") ? rw + rgx : 0, oy = has("top") ? rw + rgy : 0;
    const colX = [], rowY = [];
    let acc = ox; for (let c = 0; c < P.cols; c++) { colX[c] = acc; acc += colW[c] + (c < P.cols - 1 ? gx : 0); }
    const boardsRight = acc;
    acc = oy; for (let r = 0; r < P.rows; r++) { rowY[r] = acc; acc += rowH[r] + (r < P.rows - 1 ? gy : 0); }
    const boardsBottom = acc;
    const W = r6(boardsRight + (has("right") ? rgx + rw : 0)), H = r6(boardsBottom + (has("bottom") ? rgy + rw : 0));
    const instances = cells.map((x, k) => {
      const box = [colX[x.c], rowY[x.r], colX[x.c] + x.w, rowY[x.r] + x.h].map(r6);
      const center = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2], bc = x.b.center, rot = x.rot;
      const mirror = x.mirror, sign = mirror ? -1 : 1;
      const at = p => { const q = A().rotate([sign * (p[0] - bc[0]), p[1] - bc[1]], rot); return [r6(q[0] + center[0]), r6(q[1] + center[1])]; };
      const inner = mirror ? Math.max(0, globalThis.AtriumStackup.copperLayers(x.b.board, defs).length - 2) : 0;
      const angle = degrees => ((rot + sign * (degrees || 0)) % 360 + 360) % 360;
      const layer = name => mirror ? A().pcbMirror.layer(name, inner) : name;
      const transform = {at, turn: rot, mirror, layer, angle, inner};
      return {index:k+1, row:x.r, col:x.c, instancePath:[x.r+","+x.c], board:x.b.board, info:x.b, rotation:rot, mirror, box, T:at, transform, poly:x.b.poly.map(at)};
    });
    const errors = [], blocking = (code, message) => errors.push({code, message});
    for (const b of new Set(instances.map(i => i.info))) {
      if (!b.outline) warnings.push(b.board.name + " has no board outline; its extents were used.");
      else if (!b.rect && vs) blocking("vscore-shape", b.board.name + " is not rectangular; V-score cuts straight lines through the whole panel and cannot follow its outline. Use tab routing.");
    }
    const usedCols = new Set(instances.map(i => i.col)), usedRows = new Set(instances.map(i => i.row));
    if (!vs && ((gx <= 0 && usedCols.size > 1) || (gy <= 0 && usedRows.size > 1))) blocking("route-gap-zero", "Tab routing needs space between the boards for the router; set a spacing (1.6 mm or more) or use V-score.");
    const rails = [];
    if (has("top")) rails.push({side: "top", rect: [0, 0, W, rw]});
    if (has("bottom")) rails.push({side: "bottom", rect: [0, r6(H - rw), W, H]});
    if (has("left")) rails.push({side: "left", rect: [0, 0, rw, H]});
    if (has("right")) rails.push({side: "right", rect: [r6(W - rw), 0, W, H]});

    // Tabs and mouse bites (tab routing only).
    const tabs = [], bites = [], skipped = [];
    const manual = P.tabs.manual || {};
    if (!vs && (P.tabs.perEdge > 0 || Object.keys(manual).length) && (gx > 0 || gy > 0)) {
      const targets = [...instances.map(i => ({rect: i.box, inst: i})), ...rails.map(r => ({rect: r.rect, rail: r.side}))];
      const tw = P.tabs.width;
      for (const inst of instances) for (const side of SIDES) {
        const [x0, y0, x1, y1] = inst.box, horiz = side === "top" || side === "bottom";
        const len = horiz ? x1 - x0 : y1 - y0, key = inst.row + "," + inst.col + ":" + side, set = manual[key];
        const gap = horiz ? gy : gx, rgap = horiz ? rgy : rgx;
        if (!(gap > 0) && !(rgap > 0)) continue;
        let fracs;
        if (set) fracs = set.map(f => len > tw ? Math.min(1 - tw / 2 / len, Math.max(tw / 2 / len, f)) : .5);
        else {
          const n = P.tabs.perEdge;
          if (!n) continue;
          if (tw * n > len * .9) { skipped.push({index: inst.index, side, reason: "edge too short for " + n + " tabs of " + tw + " mm"}); continue; }
          fracs = Array.from({length: n}, (_, t) => (t + 1) / (n + 1));
        }
        for (let t = 0; t < fracs.length; t++) {
          const c = (horiz ? x0 : y0) + len * fracs[t], a = c - tw / 2, b = c + tw / 2;
          const edge = side === "left" ? x0 : side === "right" ? x1 : side === "top" ? y0 : y1, sign = side === "left" || side === "top" ? -1 : 1;
          let best = null;
          for (const tg of targets) {
            if (tg.inst === inst) continue;
            const r = tg.rect, lo = horiz ? r[0] : r[1], hi = horiz ? r[2] : r[3];
            if (lo > a + 1e-6 || hi < b - 1e-6) continue;
            const near = sign > 0 ? (horiz ? r[1] : r[0]) : (horiz ? r[3] : r[2]), dist = (near - edge) * sign;
            if (dist > 1e-6 && dist <= (tg.inst ? gap : rgap) + 1e-6 && (!best || dist < best.dist)) best = {tg, dist, near};
          }
          if (!best) continue;
          // A tab between two boards is made once, from the board on its left or above.
          if (best.tg.inst && sign < 0) continue;
          // Tabs reach the real board edge (chamfers, arcs, notches): measure inward from the bounding box.
          const reach = (j, from, dir) => depthInto(j.poly, horiz, from, dir, a, b, (horiz ? j.box[3] - j.box[1] : j.box[2] - j.box[0]) / 2);
          const inA = reach(inst, edge, -sign), inB = best.tg.inst ? reach(best.tg.inst, best.near, sign) : 0;
          if (inA == null || inB == null) { skipped.push({index: inst.index, side, reason: "the board outline does not meet a tab there"}); continue; }
          const e0 = edge - sign * (inA + TAB_GRIP), e1 = best.tg.inst ? best.near + sign * (inB + TAB_GRIP) : best.near;
          const lo = Math.min(e0, e1), hi = Math.max(e0, e1);
          const rect = horiz ? [a, lo, b, hi] : [lo, a, hi, b];
          tabs.push({rect: rect.map(r6), side, instance: inst.index, to: best.tg.inst ? best.tg.inst.index : "rail " + best.tg.rail, key, t, frac: r6(fracs[t]), manual: !!set, len: r6(len)});
          if (P.tabs.hole > 0) {
            const d = P.tabs.hole, count = Math.max(1, Math.floor((tw - d) / P.tabs.pitch + 1e-9) + 1), span = (count - 1) * P.tabs.pitch;
            const ends = [[inst, edge, -sign]];
            if (best.tg.inst) ends.push([best.tg.inst, best.near, sign]);
            for (const [j, from, dir] of ends) for (let h = 0; h < count; h++) {
              const along = c - span / 2 + h * P.tabs.pitch, hit = rayDepth(j.poly, horiz, from, dir, along) ?? 0;
              const line = from + dir * (hit + P.tabs.offset);
              bites.push({at: (horiz ? [along, line] : [line, along]).map(r6), d, instance: j.index});
            }
          }
        }
      }
    }
    // V-score lines across the whole panel at every board edge inside it.
    const vlines = [];
    if (vs) {
      const xs = new Set(), ys = new Set();
      for (const i of instances) { xs.add(i.box[0]); xs.add(i.box[2]); ys.add(i.box[1]); ys.add(i.box[3]); }
      // A line is cut across the whole panel, so it must not cross any board.
      const clear = (k, v) => instances.every(i => !(i.box[k] < v - 1e-6 && i.box[k + 2] > v + 1e-6));
      for (const x of [...xs].sort((a, b) => a - b)) if (x > 1e-6 && x < W - 1e-6 && clear(0, x)) vlines.push({axis: "x", at: x, a: [x, 0], b: [x, H]});
      for (const y of [...ys].sort((a, b) => a - b)) if (y > 1e-6 && y < H - 1e-6 && clear(1, y)) vlines.push({axis: "y", at: y, a: [0, y], b: [W, y]});
      const cut = new Set(vlines.map(l => l.axis + r6(l.at)));
      for (const i of instances) for (const [axis, v, lim] of [["x", i.box[0], W], ["x", i.box[2], W], ["y", i.box[1], H], ["y", i.box[3], H]])
        if (v > 1e-6 && v < lim - 1e-6 && !cut.has(axis + r6(v))) {
          blocking("vscore-misaligned", "Board " + i.index + " (" + i.board.name + ") has an edge that no V-score line can reach without cutting another board. Give every board in a row the same height and every board in a column the same width, or use tab routing.");
          break;
        }
    }
    // Fiducials, tooling holes and text on the rails.
    const fiducials = [], tooling = [], texts = [];
    const horiz = rails.filter(r => r.side === "top" || r.side === "bottom"), vert = rails.filter(r => r.side === "left" || r.side === "right");
    const use = horiz.length ? horiz : vert, along = horiz.length ? W : H;
    const ti = P.tooling.inset, fi = ti + Math.max(P.tooling.diameter, P.fiducials.opening) / 2 + 3;
    const railPoint = (r, s) => { const m = horiz.length ? [(r.rect[1] + r.rect[3]) / 2] : [(r.rect[0] + r.rect[2]) / 2]; return horiz.length ? [s, m[0]] : [m[0], s]; };
    use.forEach((r, n) => {
      if (P.tooling.enabled) for (const s of [ti, along - ti]) tooling.push({at: railPoint(r, s).map(r6), d: P.tooling.diameter});
      if (P.fiducials.enabled) {
        // Asymmetric: two on the first rail, one on the second (or a third, offset, on a single rail).
        const spots = n === 0 ? [fi, along - fi] : [fi];
        if (use.length === 1) spots.push(fi + 10);
        for (const s of spots) fiducials.push({at: railPoint(r, s).map(r6), d: P.fiducials.diameter, opening: P.fiducials.opening});
      }
    });
    if (P.text.enabled && use.length) {
      const r = use[0], names = [...new Set(instances.map(i => i.board.name))];
      const selected = options.date == null ? null : new Date(options.date);
      const useSelected = selected && Number.isFinite(+selected), date = useSelected ? selected : new Date();
      const iso = useSelected ? date.toISOString().slice(0, 10) :
        date.getFullYear() + "-" + String(date.getMonth() + 1).padStart(2, "0") + "-" + String(date.getDate()).padStart(2, "0");
      const value = [names.join(" + ") || doc.name, P.text.revision ? "Rev " + P.text.revision : "", P.text.date ? iso : ""].filter(Boolean).join("  ");
      const size = Math.min(P.text.size, rw * .6), start = P.fiducials.enabled ? fi + P.fiducials.opening / 2 + 2 : ti + P.tooling.diameter / 2 + 2;
      const at = railPoint(r, start);
      // Baseline below the centre line by half the cap height (glyph cap height is 6/6 of size).
      if (size > 0) texts.push({value, size, angle: horiz.length ? 0 : -90, at: horiz.length ? [at[0], at[1] + size / 2] : [at[0] + size / 2, at[1]]});
    }
    const thieving = thief(P, rails, fiducials, tooling, texts, vlines);
    // Routed profile.
    const traced = vs ? trace([[0, 0, W, H]]) : routed([...rails.map(r => r.rect), ...tabs.map(t => t.rect)], instances.map(i => i.poly));
    let segs = null;
    if (!vs && P.mill?.radius > 0) {
      const f = [...traced.outer, ...traced.holes].map(l => fillet(l, P.mill.radius));
      traced.outer = f.slice(0, traced.outer.length).map(x => x.points); traced.holes = f.slice(traced.outer.length).map(x => x.points);
      segs = {outer: f.slice(0, traced.outer.length).map(x => x.segs), holes: f.slice(traced.outer.length).map(x => x.segs)};
    }
    if (traced.outer.length > 1) blocking("pieces", "The panel falls apart into " + traced.outer.length + " pieces: add rails or tabs so every board is held.");
    const cutouts = [];
    for (const i of instances) for (const c of i.info.cutouts)
      cutouts.push(AtriumBoardShape.placeContour(c, i.T, i.rotation, i.mirror));
    return {params: P, W, H, instances, rails, tabs, bites, fiducials, tooling, texts, vlines, skipped, warnings, errors, thieving,
      profile: {outer: traced.outer, holes: traced.holes, cutouts, segs}, vscore: vs, spacing: g, spacingX: gx, spacingY: gy, railGap: rg, colX, rowY, colW, rowH};
  }
  // ------------------------------------------------------------------ routing-bit fillets
  // Inside corners of the routed profile (material corners over 180°: outer-loop concave vertices
  // and routed-channel corners) cannot be cut sharp by a bit of radius r; fillet them so the Gerber
  // profile is the path the router really leaves. {points (polyline, for doc.outline), segs (exact)}.
  const n360 = a => ((a % 360) + 360) % 360;
  function fillet(loop, r) {
    const n = loop.length, cut = [];
    for (let i = 0; i < n; i++) {
      const P = loop[i], A0 = loop[(i - 1 + n) % n], B = loop[(i + 1) % n];
      const e1 = [P[0] - A0[0], P[1] - A0[1]], e2 = [B[0] - P[0], B[1] - P[1]], cr = e1[0] * e2[1] - e1[1] * e2[0];
      const la = Math.hypot(e1[0], e1[1]), lb = Math.hypot(e2[0], e2[1]);
      if (cr <= 1e-12 || la < 1e-9 || lb < 1e-9) { cut.push(null); continue; }
      const u = [-e1[0] / la, -e1[1] / la], v = [e2[0] / lb, e2[1] / lb], th = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])));
      if (th < 1e-3 || th > Math.PI - 1e-3) { cut.push(null); continue; }
      let t = r / Math.tan(th / 2), rr = r;
      const lim = .5 * Math.min(la, lb);
      if (t > lim) { t = lim; rr = t * Math.tan(th / 2); }
      if (rr < 1e-3) { cut.push(null); continue; }
      const T1 = [P[0] + u[0] * t, P[1] + u[1] * t], T2 = [P[0] + v[0] * t, P[1] + v[1] * t];
      const bl = Math.hypot(u[0] + v[0], u[1] + v[1]), k = rr / Math.sin(th / 2), C = [P[0] + (u[0] + v[0]) / bl * k, P[1] + (u[1] + v[1]) / bl * k];
      const ang = p => Math.atan2(C[1] - p[1], p[0] - C[0]) * 180 / Math.PI, start = ang(T1), end = ang(T2), ccw = n360(end - start) <= 180;
      cut.push({T1: T1.map(r6), T2: T2.map(r6), C: C.map(r6), r: r6(rr), start: r6(start), end: r6(end), ccw});
    }
    const points = [], segs = [], entry = i => cut[i] ? cut[i].T1 : loop[i], exit = i => cut[i] ? cut[i].T2 : loop[i];
    for (let i = 0; i < n; i++) {
      const c = cut[i];
      if (c) {
        const sw = c.ccw ? n360(c.end - c.start) : -n360(c.start - c.end), k = Math.max(2, Math.ceil(Math.abs(sw) / 15));
        for (let j = 0; j <= k; j++) { const a = (c.start + sw * j / k) * Math.PI / 180; points.push([r6(c.C[0] + c.r * Math.cos(a)), r6(c.C[1] - c.r * Math.sin(a))]); }
        segs.push({kind: "arc", c: c.C, r: c.r, start: c.start, end: c.end, ccw: c.ccw});
      } else points.push(loop[i]);
      const a = exit(i), b = entry((i + 1) % n);
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) segs.push({kind: "line", a, b});
    }
    return {points: points.filter((p, i, l) => !i || p[0] !== l[i - 1][0] || p[1] !== l[i - 1][1]), segs};
  }

  // ------------------------------------------------------------------ copper thieving on the rails
  // Dots (staggered grid) or 45° hatch inside each rail inset by the clearance, kept clear of the
  // fiducial openings, tooling holes, rail text and V-score lines. Plotted on every copper layer.
  function thief(P, rails, fiducials, tooling, texts, vlines) {
    const T = P.thieving, out = {dots: [], hatch: [], size: T?.size || 0, pattern: T?.pattern || "dots"};
    if (!T?.enabled || !rails.length) return out;
    const c = T.clearance, circles = [], boxes = [];
    for (const f of fiducials) circles.push([f.at, f.opening / 2 + c]);
    for (const t of tooling) circles.push([t.at, t.d / 2 + c]);
    for (const t of texts) {
      // The plotted strokes' bounds when the stroke font is loaded, else a generous estimate.
      let box = null;
      try { const pts = AtriumPCBText.strokeText(t.value, t.at, t.angle, t.size).strokes.flat(); if (pts?.length) box = A().bounds(pts); } catch { box = null; }
      if (!box) { const len = t.value.length * t.size * 1.2; box = t.angle === 0 ? [t.at[0], t.at[1] - t.size, t.at[0] + len, t.at[1]] : [t.at[0] - t.size, t.at[1] - len, t.at[0], t.at[1]]; }
      const w = Math.max(.12, t.size / 7) / 2 + c;
      boxes.push([box[0] - w, box[1] - w, box[2] + w, box[3] + w]);
    }
    for (const l of vlines) boxes.push(l.axis === "x" ? [l.at - c - .5, -1e9, l.at + c + .5, 1e9] : [-1e9, l.at - c - .5, 1e9, l.at + c + .5]);
    const s = T.size, half = s / 2, free = (p, rad) => circles.every(([q, R]) => Math.hypot(p[0] - q[0], p[1] - q[1]) > R + rad) &&
      boxes.every(b => p[0] + rad < b[0] || p[0] - rad > b[2] || p[1] + rad < b[1] || p[1] - rad > b[3]);
    const seen = new Set();
    for (const r of rails) {
      const box = [r.rect[0] + c, r.rect[1] + c, r.rect[2] - c, r.rect[3] - c];
      if (box[2] - box[0] < s || box[3] - box[1] < s) continue;
      if (T.pattern === "dots") {
        const rows = Math.floor((box[3] - box[1] - s) / (T.pitch * .866) + 1e-9) + 1;
        for (let j = 0; j < rows; j++) {
          const y = box[1] + half + j * T.pitch * .866, off = j % 2 ? T.pitch / 2 : 0;
          for (let x = box[0] + half + off; x <= box[2] - half + 1e-9; x += T.pitch) {
            const p = [r6(x), r6(y)], k = p.join();
            if (seen.has(k) || !free(p, half)) continue;
            // Rails overlap at the frame corners: one dot per spot.
            seen.add(k); out.dots.push(p);
          }
        }
      } else {
        // 45° lines x - y = k, clipped to the box, then split around the keep-outs (sampled at s/2).
        const k0 = box[0] - box[3], k1 = box[2] - box[1];
        for (let k = Math.ceil(k0 / T.pitch) * T.pitch; k <= k1; k += T.pitch) {
          const xa = Math.max(box[0] + half, box[1] + half + k), xb = Math.min(box[2] - half, box[3] - half + k);
          if (xb - xa < s) continue;
          const steps = Math.max(1, Math.ceil((xb - xa) / (s / 2)));
          let run = null;
          for (let q = 0; q <= steps; q++) {
            const x = xa + (xb - xa) * q / steps, p = [x, x - k], ok = free(p, half);
            if (ok) { if (!run) run = [p, p]; else run[1] = p; }
            if ((!ok || q === steps) && run) { if (Math.hypot(run[1][0] - run[0][0], run[1][1] - run[0][1]) >= s) out.hatch.push(run.map(v => v.map(r6))); run = null; }
          }
        }
      }
    }
    return out;
  }

  const segsOf = loop => loop.map((p, i) => ({kind: "line", a: p, b: loop[(i + 1) % loop.length]}));
  function shapeOf(G) {
    const outer = G.profile.outer[0];
    if (!outer) return null;
    const S = G.profile.segs;
    if (S) return {version: 1, contour: S.outer[0], cutouts: [...S.holes, ...G.profile.cutouts], source: "panel", sig: globalThis.AtriumBoardShape?.signature?.(outer)};
    const cutouts = [...G.profile.holes.map(segsOf), ...G.profile.cutouts];
    return {version: 1, contour: segsOf(outer), cutouts, source: "panel", sig: globalThis.AtriumBoardShape?.signature?.(outer)};
  }
  function textStrokes(G) {
    const out = [];
    for (const t of G.texts) for (const s of AtriumPCBText.strokeText(t.value, t.at, t.angle, t.size).strokes) out.push(s);
    return out;
  }

  // ------------------------------------------------------------------ fabrication model
  function placedRuns(arcs, at) {
    if (!arcs) return arcs;
    const placed = arcs.slice();
    for (let i = 3; i + 1 < placed.length; i += 5) {
      const p = at([placed[i], placed[i + 1]]);
      placed[i] = p[0]; placed[i + 1] = p[1];
    }
    return placed;
  }
  function xf(f, {at:T, turn, mirror, angle, layer}) {
    const g = {...f};
    if (f.at) g.at = T(f.at);
    if (f.c) g.c = T(f.c);
    if (f.arc) g.arc = A().transformArc(f.arc, T, turn, mirror);
    if (f.points) g.points = f.points.map(T);
    if (f.holes) g.holes = f.holes.map(h => h.map(T));
    if (f.bridged) g.bridged = f.bridged.map(T);
    if (f.contour) g.contour = AtriumBoardShape.placeContour(f.contour,T,turn,mirror);
    if (f.holeContours) g.holeContours = f.holeContours.map(c => AtriumBoardShape.placeContour(c,T,turn,mirror));
    if (f.rings) g.rings = f.rings.map(r => { const o = new Float64Array(r.length); for (let i = 0; i + 1 < r.length; i += 2) { const q = T([r[i], r[i + 1]]); o[i] = q[0]; o[i + 1] = q[1]; } return o; });
    if (f.pad) g.pad = {...f.pad, angle: angle(f.pad.angle),
      ...(mirror && f.pad.poly && {poly:f.pad.poly.map(([x,y]) => [-x,y])})};
    if (f.arcs) g.arcs = placedRuns(f.arcs, T);
    if (f.layer) g.layer = layer(f.layer);
    return g;
  }
  const VCUT = Object.freeze({key: "vcut", ext: "GM2", title: "Mechanical 2 (V-Cut)", group: "Mechanical", fileFunction: "Vcut", polarity: "Positive"});
  // Per-board fab models and the board-level reasons a panel cannot be built (rigid-flex,
  // mixed copper stacks). Geometry reasons are in layout().errors.
  function boardProblems(project, G, options = {}) {
    const Fo = F(), models = new Map(), problems = [];
    const modelOf = b => { if (!models.has(b.id)) models.set(b.id, Fo.analyse(project, b.id, {variant:options.variant, provenance:options.provenance})); return models.get(b.id); };
    if (!G.instances.length) return {modelOf, problems};
    const base = modelOf(G.instances[0].board);
    for (const b of [...new Set(G.instances.map(i => i.board))]) {
      const m = modelOf(b);
      if (m.flex) problems.push({code: "rigid-flex", message: b.name + " is rigid-flex: coverlay, stiffener and region layers are not repeated in panels. Panelize rigid boards only, or let the fab panelize."});
      if (m.stack.join("|") !== base.stack.join("|")) problems.push({code: "stack-mismatch", message: b.name + " (" + m.stack.length + " copper layers) cannot share a panel with " + G.instances[0].board.name + " (" + base.stack.length + "): every board in a panel needs the same copper stack."});
    }
    return {modelOf, problems};
  }
  // Both panel representations need the layout and the source boards in their own coordinates.
  function prepare(project, ref, options = {}) {
    if (!F()) fail("Fabrication outputs (fab-outputs.js) are not loaded.");
    const doc = panelOf(project, ref), defs = new Map((project.library || []).map(d => [d.id, d]));
    const G = layout(project, doc, defs, options);
    if (!G.instances.length) fail("The panel has no boards.");
    const {modelOf, problems} = boardProblems(project, G, options);
    const blockers = [...G.errors, ...problems];
    if (blockers.length) fail("The panel cannot be fabricated: " + blockers.map(e => e.message).join(" "));
    return {doc, layout: G, modelOf};
  }
  // A model AtriumFabOutputs.plan/generate/gerber/drill/pickPlace accept, for the whole panel.
  function analyse(project, ref, options = {}, prepared) {
    const {doc, layout: G, modelOf} = prepared || prepare(project, ref, options), Fo = F();
    const base = modelOf(G.instances[0].board), notes = new Map(), note = (m, n = 1) => notes.set(m, (notes.get(m) || 0) + n);
    if (options.omitUnconnectedMidLayerPads === true)
      note("Panel output retains inner-layer lands. Apply isolated-land omission to an individual board.");
    // Every layer any board plots (a mechanical layer may exist on one board only).
    const layers = new Map(), optInMechanical = new Set();
    for (const m of new Set(G.instances.map(inst => modelOf(inst.board)))) {
      for (const key of m.layers.keys()) {
        if (!layers.has(key)) {
          layers.set(key, []);
          if (m.optInMechanical?.has(key)) optInMechanical.add(key);
        } else if (!m.optInMechanical?.has(key)) {
          // Any constituent board that plots this layer by default enables it for the panel.
          optInMechanical.delete(key);
        }
      }
    }
    const drills = [], parts = [], dnp = new Set();
    let pourRegions = 0;
    for (const inst of G.instances) {
      if (options.odbRepeat && !inst.mirror) continue;
      const m = modelOf(inst.board);
      for (const [msg, n] of m.notes) if (!notes.has(msg)) notes.set(msg, n);
      for (const [key, list] of m.layers) { const target = layers.get(inst.transform.layer(key)); if (!target) continue; for (const f of list) target.push(xf(f, inst.transform)); }
      for (const h of m.drills) drills.push({...h, at: inst.T(h.at),
        ...(inst.mirror && {span: [m.stack.length - 1 - h.span[1], m.stack.length - 1 - h.span[0]],
          ...(h.backdrill && {side: h.side === "top" ? "bottom" : "top", stop: inst.transform.layer(h.stop)})}),
        ...(h.endpoints ? {endpoints: h.endpoints.map(inst.T)} : {}),
        ...(h.ref ? {ref: h.ref + "_" + inst.index} : {})});
      for (const p of m.parts) {
        const at = inst.T([p.item.x, p.item.y]);
        const item = {...p.item, x: at[0], y: at[1], angle: inst.transform.angle(p.item.angle), ref: (p.item.ref || "?") + "_" + inst.index};
        if (inst.mirror) item.layer = inst.transform.layer(p.item.layer || "Top");
        parts.push({...p, item, side: inst.transform.layer(p.side), instance: inst.index});
        if (m.dnp?.has(p.item)) dnp.add(item);
      }
      pourRegions += m.pourRegions || 0;
    }
    // Panel features.
    const last = base.stack.length - 1;
    for (const b of G.bites) drills.push({at: b.at, d: b.d, plated: false, span: [0, last], via: false, use: "mousebite"});
    for (const t of G.tooling) drills.push({at: t.at, d: t.d, plated: false, span: [0, last], via: false, use: "tooling"});
    for (const f of G.fiducials) for (const side of ["Top", "Bottom"]) {
      layers.get(side)?.push({t: "flash", at: f.at, pad: Fo.padGeom("circle", f.d, f.d, 0), fn: "FiducialPad,Global", net: ""});
      layers.get(side + " mask")?.push({t: "flash", at: f.at, pad: Fo.padGeom("circle", f.d, f.d, 0), expand: "mask", expandBy: (f.opening - f.d) / 2});
    }
    // Copper thieving on the rails: every copper layer, no net, under the mask.
    if (G.thieving.dots.length || G.thieving.hatch.length) {
      const th = G.thieving, dot = Fo.padGeom("circle", th.size, th.size, 0);
      for (const key of base.stack) {
        const list = layers.get(key);
        if (!list) continue;
        for (const at of th.dots) list.push({t: "flash", at, pad: dot, fn: "NonConductor", net: ""});
        for (const h of th.hatch) list.push({t: "stroke", points: h, width: th.size, fn: "NonConductor", net: ""});
      }
      note("Panel: copper thieving on the rails (" + (th.dots.length ? th.dots.length + " dots" : th.hatch.length + " hatch lines") + " on every copper layer).");
    }
    const silk = layers.get("Silk");
    if (silk) for (const s of textStrokes(G)) silk.push({t: "stroke", points: s, width: Math.max(.12, G.texts[0].size / 7)});
    const extraLayers = [];
    if (G.vlines.length) {
      // V-cut gets a mechanical layer no board uses, so it never shares a file name with board artwork.
      const taken = new Set(Fo.gerberLayers({stack: base.stack, layers, outline: [], flex: null, doc: base.doc, defs: base.defs,
        stackStored: false, physicalStack:base.physicalStack}).map(l => l.ext));
      let n = 2; while (taken.has("GM" + n) && n < 99) n++;
      const vcut = {...VCUT, ext: "GM" + n, title: "Mechanical " + n + " (V-Cut)"};
      const list = G.vlines.map(l => ({t: "stroke", points: [l.a, l.b], width: .1}));
      for (const l of G.vlines) {
        const at = l.axis === "x" ? [l.at + .4, 2.2] : [.6, l.at - .4];
        for (const s of AtriumPCBText.strokeText("V-CUT", at, l.axis === "x" ? -90 : 0, 1).strokes) list.push({t: "stroke", points: s, width: .12});
      }
      layers.set("vcut", list);
      extraLayers.push(vcut);
      note("V-score lines are on " + vcut.title.replace(" (V-Cut)", "") + " (" + vcut.ext + ", X2 file function Vcut). Tell the fab they are V-cut lines when you order.");
    }
    for (const w of G.warnings) note("Panel: " + w);
    const outer = G.profile.outer[0] || [[0, 0], [G.W, 0], [G.W, G.H], [0, G.H]];
    const shape = globalThis.AtriumBoardShape ? shapeOf(G) : null;
    if (!shape) note("Panel profile: only the outer frame was plotted (board-shape.js is not loaded).");
    const pdoc = {...base.doc, id: doc.id, name: doc.name};
    delete pdoc.origin;
    // Which copper the boards plot (fab-outputs.js copperText): every instance's, combined.
    const cs = G.instances.map(i => modelOf(i.board).copper).filter(Boolean), imp = cs.filter(c => c.imported);
    const copper = cs.length ? {state: cs.some(c => c.state === "filled") ? "filled" : pourRegions ? "current" : "none", regions: [], pending: [],
      filled: [...new Set(cs.flatMap(c => c.filled))], imported: imp.length ? {count: imp.reduce((n, c) => n + c.imported.count, 0), fresh: imp.every(c => c.imported.fresh)} : null} : null;
    return Fo.prepareDrills({doc: pdoc, defs: base.defs, project, stack: base.stack, stackStored: base.stackStored,
      physicalStack:base.physicalStack, getDrillPairs:base.getDrillPairs, expansionRules: base.expansionRules, dnp, layers, optInMechanical, drills, parts,
      outline: outer, boardShape: shape, extents: [0, 0, G.W, G.H], pours: base.pours, copper, pourRegions, notes, flex: null, extraLayers, panel: G,
      ...(options.odbRepeat && {odbBoards:new Map(G.instances.map(i => [i.board.id, modelOf(i.board)]))})});
  }
  const baseName = s => (F()?.baseName ? F().baseName(s) : String(s || "Panel").replace(/[\\/:*?"<>|]/g, "-"));
  // Like AtriumFabOutputs.build, for a panel: {name, files, warnings, model, options}.
  function build(project, ref, options = {}) {
    const Fo = F(), model = analyse(project, ref, options), p = Fo.plan(model, options);
    const files = p.files.map(f => ({name: f.name, kind: f.kind, title: f.title, ...Fo.generate(model, p, f)}));
    files.push({name: baseName(model.doc.name) + "-Panel.txt", kind: "panel", title: "Panel description", content: describe(model.panel, model.doc.name)});
    files.push({name: baseName(model.doc.name) + "-Panel-Drawing.svg", kind: "panel", title: "Panel drawing (V-cuts, tabs, dimensions)", content: drawingOf(model.panel, model.doc.name, options)});
    return {name: baseName(model.doc.name) + "-Fabrication.zip", files, warnings: Fo.warnings(model), model, options: p.options};
  }
  function describe(G, name) {
    const P = G.params, L = ["Panel " + name, "Size: " + r4(G.W) + " x " + r4(G.H) + " mm", "Array: " + P.rows + " rows x " + P.cols + " columns, " + G.instances.length + " boards",
      "Separation: " + (G.vscore ? "V-score (lines on Mechanical 2 / GM2)" : "tab routing with mouse bites (" + G.tabs.length + " tabs, " + G.bites.length + " NPTH holes " + P.tabs.hole + " mm at " + P.tabs.pitch + " mm pitch)"),
      "Board spacing: " + (G.spacingX === G.spacingY ? G.spacingX + " mm" : G.spacingX + " mm between columns, " + G.spacingY + " mm between rows") +
        (P.alternate ? "; every other " + (P.alternate === "both" ? "cell" : P.alternate === "rows" ? "row" : "column") + " turned 180 deg" : ""),
      ...(P.mill ? ["Routing: inside corners filleted for a " + r4(P.mill.radius * 2) + " mm bit"] : []), "Rails: " + (G.rails.map(r => r.side).join(", ") || "none") + (G.rails.length ? " (" + P.rails.width + " mm)" : ""),
      "Fiducials: " + G.fiducials.length + (G.fiducials.length ? " (" + P.fiducials.diameter + " mm copper, " + P.fiducials.opening + " mm mask opening, both sides)" : ""),
      "Tooling holes: " + G.tooling.length + (G.tooling.length ? " (" + P.tooling.diameter + " mm NPTH)" : ""),
      ...(G.thieving.dots.length || G.thieving.hatch.length ? ["Copper thieving on the rails: " + G.thieving.pattern + ", " + P.thieving.size + " mm at " + P.thieving.pitch + " mm pitch, every copper layer"] : []), "", "Instances (designator suffix, position of the board centre from the panel lower-left, rotation):"];
    for (const i of G.instances) L.push("  _" + i.index + "  " + i.board.name + "  row " + (i.row + 1) + " col " + (i.col + 1) + "  X " + r4((i.box[0] + i.box[2]) / 2) + " Y " + r4(G.H - (i.box[1] + i.box[3]) / 2) + "  " + i.rotation + " deg");
    L.push("", APPROX);
    return L.join("\r\n") + "\r\n";
  }

  // ------------------------------------------------------------------ panel drawing (fab drawing, SVG)
  // Outline, boards, tabs, mouse bites, tooling, fiducials, every V-cut labelled with its position,
  // overall and pitch dimensions and the panel description as notes. Millimetres, Y down, black on white.
  // XML text and double-quoted attributes; control characters are not allowed in XML 1.0.
  const esc = t => String(t).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;"})[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  function drawingOf(G, name, options = {}) {
    const n = v => r4(v), M = 22, W = G.W, H = G.H, notes = describe(G, name).trim().split(/\r\n/).filter(l => l !== APPROX);
    const VW = W + 2 * M, VH = H + 2 * M + 6 + notes.length * 3.2 + 8, o = [];
    const path = loop => "M" + loop.map(p => n(p[0]) + " " + n(p[1])).join("L") + "Z";
    o.push('<?xml version="1.0" encoding="UTF-8"?>', '<svg xmlns="http://www.w3.org/2000/svg" width="' + n(VW) + 'mm" height="' + n(VH) + 'mm" viewBox="' + [-M, -M, n(VW), n(VH)].join(" ") + '" font-family="Helvetica, Arial, sans-serif">',
      "<title>" + esc(name) + " panel drawing</title>", '<rect x="' + -M + '" y="' + -M + '" width="' + n(VW) + '" height="' + n(VH) + '" fill="#fff"/>');
    o.push('<g fill="none" stroke="#000" stroke-width="0.2">');
    for (const l of [...G.profile.outer, ...G.profile.holes]) o.push('<path d="' + path(l) + '"/>');
    o.push("</g>", '<g fill="#e6e6e6" stroke="#666" stroke-width="0.08">');
    for (const t of G.tabs) o.push('<rect x="' + n(t.rect[0]) + '" y="' + n(t.rect[1]) + '" width="' + n(t.rect[2] - t.rect[0]) + '" height="' + n(t.rect[3] - t.rect[1]) + '"/>');
    o.push("</g>", '<g fill="none" stroke="#555" stroke-width="0.1" stroke-dasharray="0.8 0.5">');
    for (const i of G.instances) o.push('<path d="' + path(i.poly) + '"/>');
    o.push("</g>", '<g font-size="2.2" text-anchor="middle" fill="#333">');
    for (const i of G.instances) o.push('<text x="' + n((i.box[0] + i.box[2]) / 2) + '" y="' + n((i.box[1] + i.box[3]) / 2 + .8) + '">' + i.index + " · " + esc(i.board.name) + (i.rotation ? " · " + i.rotation + "°" : "") + "</text>");
    o.push("</g>", '<g fill="#fff" stroke="#000" stroke-width="0.06">');
    for (const b of G.bites) o.push('<circle cx="' + n(b.at[0]) + '" cy="' + n(b.at[1]) + '" r="' + n(b.d / 2) + '"/>');
    for (const t of G.tooling) o.push('<circle cx="' + n(t.at[0]) + '" cy="' + n(t.at[1]) + '" r="' + n(t.d / 2) + '"/><path d="M' + n(t.at[0] - t.d) + " " + n(t.at[1]) + "h" + n(2 * t.d) + "M" + n(t.at[0]) + " " + n(t.at[1] - t.d) + "v" + n(2 * t.d) + '"/>');
    for (const f of G.fiducials) o.push('<circle cx="' + n(f.at[0]) + '" cy="' + n(f.at[1]) + '" r="' + n(f.opening / 2) + '" stroke-dasharray="0.3 0.2"/><circle cx="' + n(f.at[0]) + '" cy="' + n(f.at[1]) + '" r="' + n(f.d / 2) + '" fill="#000"/>');
    o.push("</g>");
    if (G.vlines.length) {
      o.push('<g stroke="#c00" stroke-width="0.18" stroke-dasharray="2 0.6 0.4 0.6" fill="#c00" font-size="1.8">');
      for (const l of G.vlines) {
        if (l.axis === "x") o.push('<path d="M' + n(l.at) + " -6V" + n(H + 6) + '"/><text stroke="none" x="' + n(l.at) + '" y="-7" text-anchor="middle">V-CUT X ' + n(l.at) + "</text>");
        else o.push('<path d="M-6 ' + n(l.at) + "H" + n(W + 6) + '"/><text stroke="none" x="' + n(W + 7) + '" y="' + n(l.at + .6) + '">V-CUT Y ' + n(H - l.at) + "</text>");
      }
      o.push("</g>");
    }
    // Dimensions: overall width (below), height (left), first board pitch (above).
    const dim = (x0, y0, x1, y1, label, side) => {
      const horiz = y0 === y1, a = 1.2, t = horiz ? [n((x0 + x1) / 2), n(y0 + (side > 0 ? 3 : -1.2))] : [n(x0 + (side > 0 ? 3 : -1.5)), n((y0 + y1) / 2)];
      o.push('<path d="M' + n(x0) + " " + n(y0) + "L" + n(x1) + " " + n(y1) + (horiz ? "M" + n(x0) + " " + n(y0 - a) + "v" + 2 * a + "M" + n(x1) + " " + n(y1 - a) + "v" + 2 * a : "M" + n(x0 - a) + " " + n(y0) + "h" + 2 * a + "M" + n(x1 - a) + " " + n(y1) + "h" + 2 * a) + '"/>' +
        '<text stroke="none" x="' + t[0] + '" y="' + t[1] + '" text-anchor="middle"' + (horiz ? "" : ' transform="rotate(-90 ' + t[0] + " " + t[1] + ')"') + ">" + label + "</text>");
    };
    o.push('<g stroke="#000" stroke-width="0.12" fill="#000" font-size="2">');
    dim(0, H + 8, W, H + 8, n(W) + " mm", 1); dim(-8, 0, -8, H, n(H) + " mm", -1);
    const cols = [...new Set(G.instances.filter(i => i.row === G.instances[0].row).map(i => i.box[0]))].sort((a, b) => a - b);
    if (cols.length > 1 && !G.vlines.some(l => l.axis === "x")) dim(cols[0], -10, cols[1], -10, "pitch " + n(cols[1] - cols[0]) + " mm", -1);
    o.push("</g>", '<g font-size="2.2" fill="#000">');
    notes.forEach((l, k) => o.push('<text x="0" y="' + n(H + 16 + k * 3.2) + '" xml:space="preserve">' + esc(l) + "</text>"));
    o.push('<text x="0" y="' + n(H + 16 + notes.length * 3.2 + 2) + '" font-size="1.8" fill="#555">' + esc(APPROX) + (options.date instanceof Date ? " Drawn " + options.date.toISOString().slice(0, 10) + "." : "") + "</text>");
    o.push("</g>", "</svg>", "");
    return o.join("\n");
  }
  function drawing(project, ref, options = {}) {
    const doc = panelOf(project, ref);
    return {name: baseName(doc.name) + "-Panel-Drawing.svg", content: drawingOf(layout(project, doc, null, options), doc.name, options)};
  }

  // ------------------------------------------------------------------ fill a panel size
  // Most boards of the panel's board within maxW x maxH mm (e.g. JLCPCB's 100 x 100 price break),
  // trying the current rotation and a quarter turn. Uniform boards (cells with other boards are ignored).
  function fitArray(project, ref, max = [100, 100], options = {}) {
    const doc = panelOf(project, ref), base = normalize(doc.panel), best = {rows: 0, cols: 0, count: 0, rotation: base.rotation, size: null};
    for (const rot of options.rotate === false ? [base.rotation] : [base.rotation, (base.rotation + 90) % 360]) {
      const one = layout(project, {...doc, panel: {...base, rows: 1, cols: 1, cells: {}, rotation: rot, tabs: {...base.tabs, manual: undefined}}}, null);
      const inst = one.instances[0];
      if (!inst) continue;
      const w = inst.box[2] - inst.box[0], h = inst.box[3] - inst.box[1], gx = one.spacingX, gy = one.spacingY;
      for (let rows = 1; rows <= 30; rows++) for (let cols = 1; cols <= 30; cols++) {
        const W = one.W + (cols - 1) * (w + gx), Hh = one.H + (rows - 1) * (h + gy);
        if (W > max[0] + 1e-6 || Hh > max[1] + 1e-6) continue;
        const count = rows * cols;
        if (count > best.count || (count === best.count && best.size && W * Hh < best.size[0] * best.size[1])) Object.assign(best, {rows, cols, count, rotation: rot, size: [r4(W), r4(Hh)]});
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ headless (run_command panel_report / panel_setup)
  // panel_report: read-only summary, check and output list. panel_setup: create or change a panel
  // (preset, params, fill), changing `project` in place; the MCP server turns that into a proposal.
  const PARAM_KEYS = {rows: "rows", cols: "cols", spacing: "spacing", spacing_y: "spacingY", rotation: "rotation", alternate: "alternate", separation: "separation",
    rails: "rails", tabs: "tabs", fiducials: "fiducials", tooling: "tooling", text: "text", thieving: "thieving", mill: "mill", cells: "cells", fab_profile: "fabProfile"};
  function report(project, doc, options = {}) {
    const G = layout(project, doc, null, options), c = check(project, doc, options), pt = p => [r4(p[0]), r4(G.H - p[1])];
    let outputs = null, blocked = null;
    try { const F0 = F(); if (F0) { const m = analyse(project, doc, options); outputs = [...F0.plan(m, options).files.map(f => f.name), baseName(doc.name) + "-Panel.txt", baseName(doc.name) + "-Panel-Drawing.svg"]; } }
    catch (e) { blocked = e.message; }
    return {panel_id: doc.id, name: doc.name, preset: G.params.preset || null, board: boardById(project, G.params.board)?.name || null, boards: G.instances.length,
      board_names: [...new Set(G.instances.map(i => i.board.name))], size: [r4(G.W), r4(G.H)], separation: G.params.separation, spacing: [r4(G.spacingX), r4(G.spacingY)],
      tabs: G.tabs.length, mouse_bites: G.bites.length, vscore_lines: G.vlines.map(l => ({axis: l.axis, at: r4(l.axis === "x" ? l.at : G.H - l.at)})),
      fiducials: G.fiducials.length, tooling_holes: G.tooling.length, thieving: G.thieving.dots.length + G.thieving.hatch.length, mill_radius: G.params.mill?.radius || 0,
      instances: G.instances.map(i => ({index: i.index, board: i.board.name, row: i.row + 1, col: i.col + 1, rotation: i.rotation, ...(i.mirror && {mirror:true}), center: pt([(i.box[0] + i.box[2]) / 2, (i.box[1] + i.box[3]) / 2])})),
      check: c.items, errors: c.items.filter(i => i.level === "error").length, warnings: c.items.filter(i => i.level === "warning").length, fab_profile: c.profile,
      outputs, blocked, panel: G.params, presets: PRESETS.map(x => ({id: x.id, name: x.name, hint: x.hint})), approximate: true, note: APPROX,
      coordinates: "mm from the panel's lower-left corner, Y up"};
  }
  function headless(project, a = {}) {
    const date = a.date ? new Date(a.date) : undefined, opts = date && !Number.isNaN(+date) ? {date} : {};
    if (a.op === "report") {
      const o = {...opts, ...(a.fab_profile ? {fabProfile: a.fab_profile} : {})};
      if (a.panel_id != null || project.documents.some(d => d.kind === "panel")) return {...report(project, panelOf(project, a.panel_id ?? null), o), exists: true};
      // No panel yet: report the panel the default preset would make (nothing is added).
      const board = a.document_id != null ? boardById(project, a.document_id) || fail("The project has no board layout " + a.document_id + ".") : boardsOf(project)[0];
      const doc = create(project, {board: board?.id});
      doc.panel = applyPreset(doc.panel, a.preset || "mousebite-5mm-rails");
      return {...report(project, doc, o), panel_id: null, exists: false, note: "The project has no panel yet; this is what panel_setup with the " + doc.panel.preset + " preset would make. " + APPROX};
    }
    if (a.op !== "setup") fail("Unknown panel operation " + a.op + ".");
    const panels = project.documents.filter(d => d.kind === "panel");
    let doc = a.panel_id != null ? panelOf(project, a.panel_id) : null, created = false;
    if (!doc) {
      const board = a.document_id != null ? boardById(project, a.document_id) || fail("The project has no board layout " + a.document_id + ".") : boardsOf(project)[0];
      doc = a.new === true ? null : panels.find(d => d.panel?.board === board?.id) || null;
      if (!doc) { doc = create(project, {board: board?.id, name: a.name}); project.documents.push(doc); created = true; }
    }
    let next = normalize(doc.panel);
    if (a.document_id != null && !created) next.board = (boardById(project, a.document_id) || fail("The project has no board layout " + a.document_id + ".")).id;
    if (a.preset) next = applyPreset(next, a.preset);
    const q = a.params || {};
    for (const [k, key] of Object.entries(PARAM_KEYS)) if (q[k] !== undefined) next[key] = plain(q[k]) && plain(next[key]) && k !== "cells" ? {...next[key], ...q[k]} : q[k];
    if (q.cells) next.cells = Object.fromEntries(Object.entries(q.cells).map(([k, v]) => { const m = /^(\d+),(\d+)$/.exec(k); return m ? [(+m[1] - 1) + "," + (+m[2] - 1), v] : [k, v]; }));
    doc.panel = normalize(next);
    if (Array.isArray(a.fill)) { const f = fitArray(project, doc, a.fill); if (!f.count) fail("Not even one board fits " + a.fill.join(" x ") + " mm with these rails and spacing."); doc.panel = normalize({...doc.panel, rows: f.rows, cols: f.cols, rotation: f.rotation}); }
    if (a.name && !created) doc.name = String(a.name).slice(0, 120);
    validate(doc.panel);
    return {...report(project, doc, opts), created};
  }

  // ------------------------------------------------------------------ preview / STEP document
  function movePour(r, {at:T, layer}) {
    const P = globalThis.AtriumPCBPours;
    const rings = P.contours(r).map(ring => Array.from({length: ring.length / 2}, (_, i) => T([ring[2 * i], ring[2 * i + 1]])));
    return P.region(rings, layer(r.layer), r.net, r.arcs && {arcs: placedRuns(r.arcs, T)});
  }
  function panelItems(G) {
    const items = [];
    let n = 0;
    const pad = (at, extra) => items.push({id: "panel:" + (++n), kind: "pad", x: at[0], y: at[1], angle: 0, number: "", net: "", ...extra});
    for (const b of G.bites) pad(b.at, {layer: "Multi", shape: "round", w: b.d, h: b.d, drill: b.d, plated: false});
    for (const t of G.tooling) pad(t.at, {layer: "Multi", shape: "round", w: t.d, h: t.d, drill: t.d, plated: false});
    for (const f of G.fiducials) for (const layer of ["Top", "Bottom"]) pad(f.at, {layer, shape: "round", w: f.d, h: f.d, maskExpansion: (f.opening - f.d) / 2});
    for (const l of G.vlines) items.push({id: "panel:" + (++n), kind: "graphic", layer: "Mechanical 2", points: [l.a, l.b], width: .15});
    for (const at of G.thieving.dots) for (const layer of ["Top", "Bottom"]) pad(at, {layer, shape: "round", w: G.thieving.size, h: G.thieving.size});
    for (const h of G.thieving.hatch) for (const layer of ["Top", "Bottom"]) items.push({id: "panel:" + (++n), kind: "track", layer, points: h, width: G.thieving.size, net: ""});
    if (F()) for (const s of textStrokes(G)) items.push({id: "panel:" + (++n), kind: "graphic", layer: "Silk", points: s, width: Math.max(.12, G.texts[0].size / 7)});
    return items;
  }
  // Keep the layout transform and generated tooling shared with the flattened view.
  // Occurrence identity is the authored row/column, independent of skipped cells.
  function resolvedPlacement(project, doc, defs) {
    const layout = AtriumPanel.layout(project, doc, defs);
    const first = layout.instances[0]?.board;
    const board = {id: doc.id, kind: "pcb", name: doc.name, items: panelItems(layout),
      outline: layout.profile.outer[0] || [], stackup: first?.stackup};
    return {board, profile: layout.profile, instances: layout.instances};
  }
  const projections = new WeakMap();
  const projectionOf = doc => projections.get(doc);
  const definitionsFor = (doc, defs) => projectionOf(doc)?.defs || defs;
  const occurrenceId = (inst, id) => "P" + inst.index + ":" + id;
  function occurrenceItem(item, inst, originalDefs, mappedDefs) {
    const {at, layer, angle, inner, mirror, turn} = inst.transform, M = A().pcbMirror;
    const PCB = globalThis.AtriumPCBAppearance, S = globalThis.AtriumBoardShape;
    const pad = item.kind === "pad" || item.kind === "via";
    const out = {...(mirror && pad ? M.pad(item, inner) : item), id: occurrenceId(inst,item.id)};
    if (Array.isArray(item.points)) out.points = item.points.map(at);
    const arc = A().pathArc(item);
    if (arc) out.arc = A().transformArc(arc, at, turn, mirror);
    const shape = item.regionShape && S?.regionOf(item);
    if (shape) {
      const place = loop => S.placeContour(loop, at, turn, mirror);
      out.regionShape = S.mapCutoutRegions(shape, {...shape, contour: place(shape.contour), cutouts: shape.cutouts.map(place),
        sig: S.signature(out.points)}, place);
    }
    if (fin(item.x) && fin(item.y)) {
      [out.x, out.y] = at([item.x, item.y]);
      if ((turn || mirror) && (item.kind !== "via" || mirror)) out.angle = angle(item.angle);
    }
    if (item.groupId) out.groupId = occurrenceId(inst,item.groupId);
    delete out.locked;
    if (mirror) {
      out.layer = layer(PCB.boardLayer(item));
      if (item.kind === "part") {
        const source = PCB.readDefinition(originalDefs, item.def, inst.board);
        if (source?.footprint) {
          out.def = occurrenceId(inst,item.def);
          if (!mappedDefs.has(out.def)) mappedDefs.set(out.def, {...source, id:out.def, footprint:M.footprint(source.footprint, inner)});
        }
        for (const key of ["refAt", "valueAt"])
          if (item[key]) out[key] = [-item[key][0], item[key][1]];
        if (item.designator && fin(item.designator.x))
          out.designator = {...item.designator, x:-item.designator.x, angle:-(item.designator.angle || 0)};
      }
      if (item.kind === "label") out.mirrored = !PCB.textMirrored(item, item.layer);
      if (item.kind === "via") {
        if (item.backdrill) out.backdrill = {...item.backdrill, from:item.backdrill.from === "top" ? "bottom" : "top",
          toLayer:layer(item.backdrill.toLayer)};
        if (item.tent) out.tent = {top:item.tent.bottom, bottom:item.tent.top};
        if (item.ipcSides === "top" || item.ipcSides === "bottom") out.ipcSides = item.ipcSides === "top" ? "bottom" : "top";
      }
    }
    if (item.kind === "part") {
      const placedRows = rows => turn || mirror ? rows.map(row=>{
        const pose=PCB.annotationText(item,row);
        return {...row,at:mirror?[-row.at[0],row.at[1]]:row.at,angle:mirror?-pose.angle:pose.angle,
          justify:pose.justify,upright:false,mirrored:pose.mirrored!==mirror,layer:layer(row.layer)};
      }) : rows;
      const rows=PCB.sourceLabelRows(inst.board,item);
      if(rows)out.boardLabels=placedRows(rows);
      if(Array.isArray(item.hiddenBoardLabels))out.hiddenBoardLabels=placedRows(item.hiddenBoardLabels);
    }
    return out;
  }
  // The panel as an ordinary board document (kind "pcb"): what the canvas draws and STEP exports.
  function flatten(project, doc, defs, options = {}) {
    defs ||= new Map((project.library || []).map(d => [d.id, d]));
    const G = layout(project, doc, defs, options), items = [], pours = [], first = G.instances[0]?.board;
    const currentPours = new Map(), records = options.canvas ? new Map() : null, instances = options.canvas ? new Map() : null;
    const projectedDefs = G.instances.some(inst => inst.mirror) ? new Map(defs) : defs;
    for (const inst of G.instances) {
      instances?.set(inst.instancePath[0], inst);
      for (const source of inst.board.items) {
        const item=occurrenceItem(source,inst,defs,projectedDefs);
        records?.set(item.id,{item,owner:{kind:"item",documentId:inst.board.id,instancePath:inst.instancePath,id:source.id}});
        items.push(item);
      }
      if (!currentPours.has(inst.board)) {
        let current = false;
        try { current = F()?.pourStatus?.(inst.board, defs, project) === "current"; } catch { /* unavailable copper */ }
        currentPours.set(inst.board, current);
      }
      if (currentPours.get(inst.board) && globalThis.AtriumPCBPours) for (const r of inst.board.pcbDrawing.pours) { try { pours.push(movePour(r, inst.transform)); } catch { /* undecodable region */ } }
    }
    items.push(...panelItems(G));
    const outer = G.profile.outer[0] || [[0, 0], [G.W, 0], [G.W, G.H], [0, G.H]];
    const flat = {id: doc.id + ":view", kind: "pcb", name: doc.name, grid: first?.grid || .25, items, outline: outer, notes: [], panelView: doc.id};
    const shape = globalThis.AtriumBoardShape ? shapeOf(G) : null;
    if (shape) flat.boardShape = shape;
    if (first?.stackup) flat.stackup = first.stackup;
    const rules = first && globalThis.AtriumRules?.stored?.(first, project);
    if (rules) flat.rules = rules;  // the flattened panel is a board outside the project: it carries its rules
    if (pours.length) {
      flat.pcbDrawing = {annotations:{},pours};
      flat.sourcePourSignature = globalThis.AtriumPCBPours.signature(flat, projectedDefs);
    }
    const result={doc:flat,layout:G,defs:projectedDefs};
    projections.set(flat,{doc:flat,defs:projectedDefs,root:doc,records,instances,mirrored:projectedDefs!==defs});
    return result;
  }
  function projectedItem(projection, owner) {
    if(owner.kind!=="item")return;
    if(!owner.instancePath.length)return owner.documentId===projection.root.id?owner.id:undefined;
    const inst=projection.instances?.get(owner.instancePath[0]);
    if(inst?.board.id===owner.documentId)return occurrenceId(inst,owner.id);
  }
  function projectedChanges(projection, since) {
    return projection.deltaFrom===since && projection.delta || projection.geometry?.changes(since);
  }
  function updateProjection(projection, delta, defs) {
    if(delta.kind!=="incremental")return false;
    const updates=[], boards=new Map(), nextDefs=new Map();
    for(const owner of delta.owners){
      const id=projectedItem(projection,owner), prior=projection.records.get(id);
      const inst=projection.instances.get(owner.instancePath[0]);
      if(!prior || !inst || !projection.project.documents.includes(inst.board))return false;
      if(!boards.has(inst.board))boards.set(inst.board,globalThis.AtriumUndoStore.documentItems(inst.board,projection.project)?.byId);
      const source=boards.get(inst.board)?.get(owner.id);
      if(!source)return false;
      updates.push([prior.item,occurrenceItem(source,inst,defs,nextDefs)]);
      if(source.kind==="part" && source.def)nextDefs.set(source.def,defs.get(source.def));
    }
    if(projection.mirrored){
      for(const [id,def] of nextDefs)if(def)projection.defs.set(id,def);else projection.defs.delete(id);
    }else projection.defs=defs;
    for(const [before,after] of updates){
      for(const key of Object.keys(before))if(!Object.hasOwn(after,key))delete before[key];
      Object.assign(before,after);
    }
    return true;
  }
  // The editor keeps its projected item identities across a local source edit.
  const views = new WeakMap();
  function bindGeometry(doc,geometry) {
    const projected=views.get(doc);
    if(projected && !projected.geometry && geometry?.revision.rootId===doc.id && projected.rev===globalThis.AtriumNavHost?.revision?.()){
      projected.geometry=geometry;projected.revision=geometry.revision;projected.provider=globalThis.AtriumResolvedGeometry;
    }
  }
  function view(doc, defs, project) {
    const host=globalThis.AtriumNavHost;
    project ||= host?.project?.();
    if(!project)return null;
    const rev=host?.revision?.(), prior=views.get(doc), provider=globalThis.AtriumResolvedGeometry;
    const same=prior?.project===project && prior.parameters===doc.panel;
    defs ||= same ? prior.sourceDefs : new Map((project.library||[]).map(d=>[d.id,d]));
    const unchanged=same && prior.sourceDefs===defs && Number.isFinite(rev) && prior.rev===rev;
    if(unchanged && prior.provider===provider)return prior.doc;
    try{
      const geometry=host?.project?.()===project ? host.boardGeometry?.(doc) : null, revision=geometry?.revision;
      const from=same?prior.revision:null;
      const delta=from && revision!==from ? geometry?.changes(from) : null;
      const reuse=unchanged || same && (from && from===revision || delta && updateProjection(prior,delta,defs));
      const next=reuse?prior:projectionOf(flatten(project,doc,defs,{canvas:true}).doc);
      if(reuse && !next.mirrored)next.defs=defs;
      Object.assign(next,{rev,project,parameters:doc.panel,sourceDefs:defs,provider,geometry,revision,deltaFrom:from,delta});
      views.set(doc,next);
      return next.doc;
    }catch(e){
      return {id:doc.id+":view",kind:"pcb",name:doc.name,grid:1,items:[],outline:[],notes:[String(e.message)]};
    }
  }
  // STEP (or glTF) of the whole panel through step-export.js.
  function step(project, ref, options = {}) {
    const S = globalThis.AtriumSTEP || fail("3D export (step-export.js) is not loaded.");
    const doc = panelOf(project, ref), {doc:flat, defs} = flatten(project, doc, null, options);
    const r = S.build({...project, library:[...defs.values()], documents: [...project.documents.filter(d => d.kind !== "panel"), flat]}, flat, options);
    return {...r, name: r.name.replace(/^[^.]*/, baseName(doc.name))};
  }

  // ------------------------------------------------------------------ fab limits
  function profileFor(project, doc, id) {
    const FP = globalThis.AtriumFabProfiles, P = normalize(doc.panel), b = boardById(project, P.board);
    const pid = id || P.fabProfile || b?.fabProfile?.id || "jlcpcb-2l";
    let prof = null;
    try { prof = FP?.get?.(pid) || null; } catch { prof = null; }
    const rules = {...GENERIC, ...(FP?.panelRules?.(prof || pid) || {})};
    return {profile: prof, id: prof?.id || pid, rules: {...rules, edgeClearance: prof?.edgeClearance ?? rules.edgeClearance, minHole: prof?.minHole ?? .3, silkHeight: prof?.silkHeight ?? .8}};
  }

  // ------------------------------------------------------------------ geometry helpers for checks
  // Panel checks use capsules along the shared centerlines and land outlines.
  function copperShapes(model) {
    const C = AtriumGeometryCurves, L = AtriumResolvedLand, tolerance = .002;
    const out = [], copper = new Set(model.stack);
    let sid = 0;
    for (const [layer, list] of model.layers) {
      if (!copper.has(layer)) continue;
      for (const f of list) {
        sid++;
        const net = f.net || "";
        if (f.t === "stroke") {
          const points = f.arc ? C.flatten([C.arcEdge(f.arc)], tolerance) : f.points;
          for (const {a,b} of C.lineEdges(points)) out.push({a,b,r:f.width/2,net,layer,sid});
        } else if (f.t === "flash" && f.pad) {
          const g = f.pad;
          if (g.shape === "circle" || g.shape === "obround") {
            const {core,r} = L.core(g,f.at), [a,b=a] = core;
            out.push({a,b,r,net,layer,pad:true,sid});
          } else {
            const pts = F().padOutline(g).map(p => A().world(p, {x: f.at[0], y: f.at[1], angle: g.angle || 0}));
            for (let i = 0; i < pts.length; i++) out.push({a: pts[i], b: pts[(i + 1) % pts.length], r: 0, net, layer, pad: true, sid});
          }
        } else if (f.t === "region" || f.t === "pour") {
          const rings = f.t === "pour" ? f.rings.map(r => { const p = []; for (let i = 0; i + 1 < r.length; i += 2) p.push([r[i], r[i + 1]]); return p; }) : [f.points, ...(f.holes || [])];
          for (const ring of rings) for (let i = 0; i < ring.length; i++) out.push({a: ring[i], b: ring[(i + 1) % ring.length], r: 0, net, layer, edge: true, sid});
        }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ components against tabs and V-score
  // Per board (board coordinates): component boxes (courtyard, else the footprint's extent) and
  // edge features (pads within reach of the outline: edge connectors, gold fingers, castellations).
  function features(board, defs) {
    const parts = [], edge = [], poly = boardInfo(board, defs).poly;
    const near = (c, rad) => { for (let i = 0; i < poly.length; i++) if (A().nearSegment(c, poly[i], poly[(i + 1) % poly.length]) <= rad + .3) return true; return false; };
    const padAt = (pad, item, ref) => {
      if (pad.drill > 0 && pad.plated === false) return;
      const c = item ? A().world([pad.x || 0, pad.y || 0], item) : [pad.x, pad.y], rad = Math.max(pad.w || 0, pad.h || 0, pad.drill || 0) / 2;
      if (rad > 0 && near(c, rad)) edge.push({ref, box: [c[0] - rad, c[1] - rad, c[0] + rad, c[1] + rad]});
    };
    for (const i of board.items) {
      if (i.kind === "pad" && fin(i.x) && fin(i.y)) { padAt(i, null, i.number ? "pad " + i.number : "pad"); continue; }
      if (i.kind !== "part") continue;
      const fp = defs.get(i.def)?.footprint;
      if (!fp) continue;
      const court = Array.isArray(fp.courtyard) ? fp.courtyard.filter(q => Array.isArray(q)) : [];
      let local = court.length >= 3 ? court : null;
      if (!local) { try { local = A().symbolPoints(fp); } catch { local = null; } }
      const b = local?.length ? A().bounds(local) : null;
      if (b) parts.push({ref: i.ref || "?", box: A().bounds([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(q => A().world(q, i)))});
      for (const pad of fp.pads || []) padAt(pad, i, (i.ref || "?") + "." + (pad.number ?? ""));
    }
    const fid = board.items.some(i => i.kind === "part" && (/^FID/i.test(i.ref || "") || /fiducial/i.test(defs.get(i.def)?.name || "")));
    return {parts, edge, fiducials: fid};
  }
  const boxXf = (b, inst) => A().bounds([[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(inst.T));
  const boxGap = (a, b) => Math.hypot(Math.max(0, a[0] - b[2], b[0] - a[2]), Math.max(0, a[1] - b[3], b[1] - a[3]));
  const overlaps = (a, b) => a[0] < b[2] - 1e-6 && b[0] < a[2] - 1e-6 && a[1] < b[3] - 1e-6 && b[1] < a[3] - 1e-6;
  function partChecks(project, G, defs, rules, name, add) {
    const per = new Map(), list = [];
    for (const inst of G.instances) {
      if (!per.has(inst.board)) per.set(inst.board, features(inst.board, defs));
      const f = per.get(inst.board);
      list.push({inst, parts: f.parts.map(x => ({ref: x.ref, box: boxXf(x.box, inst)})), edge: f.edge.map(x => ({ref: x.ref, box: boxXf(x.box, inst)}))});
    }
    const byIndex = new Map(list.map(x => [x.inst.index, x]));
    const label = (x, ref) => "board " + x.inst.index + " " + ref;
    // Tabs on edge connectors (error) or next to components (warning).
    let close = 0, first = null;
    for (const t of G.tabs) {
      const sides = [byIndex.get(t.instance), typeof t.to === "number" ? byIndex.get(t.to) : null].filter(Boolean);
      for (const x of sides) {
        const pad = x.edge.find(e => overlaps([e.box[0] - .5, e.box[1] - .5, e.box[2] + .5, e.box[3] + .5], t.rect));
        if (pad) add("error", "tab-edge-connector", "A tab lands on the edge connector or castellation " + label(x, pad.ref) + ": move the tab (drag it on the canvas) so the edge stays clean.", [(t.rect[0] + t.rect[2]) / 2, (t.rect[1] + t.rect[3]) / 2]);
        const part = x.parts.find(p => boxGap(p.box, t.rect) < rules.tabPartClearance - 1e-6);
        if (part) { close++; first ??= {t, x, part}; }
      }
    }
    if (close) add("warning", "tab-component", close + " tab" + (close === 1 ? " is" : "s are") + " within " + rules.tabPartClearance + " mm of a component (first: " + label(first.x, first.part.ref) +
      "); breaking the tab stresses it. Drag the tab along the edge.", [(first.t.rect[0] + first.t.rect[2]) / 2, (first.t.rect[1] + first.t.rect[3]) / 2]);
    // V-score through or near components.
    for (const l of G.vlines) {
      const k = l.axis === "x" ? 0 : 1;
      for (const x of list) for (const p of x.parts) {
        const lo = p.box[k], hi = p.box[k + 2], d = l.at < lo ? lo - l.at : l.at > hi ? l.at - hi : -1;
        const at = l.axis === "x" ? [l.at, (p.box[1] + p.box[3]) / 2] : [(p.box[0] + p.box[2]) / 2, l.at];
        if (d < 0) add("error", "vscore-component", "The V-score line at " + (l.axis === "x" ? "X " + r4(l.at) : "Y " + r4(G.H - l.at)) + " mm runs through " + label(x, p.ref) + ".", at);
        else if (d < rules.vScorePartClearance - 1e-6) add("warning", "vscore-component", label(x, p.ref) + " is " + r4(d) + " mm from the V-score line at " + (l.axis === "x" ? "X " + r4(l.at) : "Y " + r4(G.H - l.at)) + " mm; keep " + rules.vScorePartClearance + " mm (" + name + ").", at);
      }
    }
    // Components overhanging their board into a neighbour or a rail.
    for (const x of list) for (const p of x.parts) {
      const b = x.inst.box;
      if (p.box[0] >= b[0] - .01 && p.box[1] >= b[1] - .01 && p.box[2] <= b[2] + .01 && p.box[3] <= b[3] + .01) continue;
      const hit = G.instances.find(o => o !== x.inst && overlaps(o.box, p.box)) || G.rails.find(r => overlaps(r.rect, p.box));
      const over = r4(Math.max(b[0] - p.box[0], b[1] - p.box[1], p.box[2] - b[2], p.box[3] - b[3]));
      if (hit) add("error", "part-overhang", label(x, p.ref) + " overhangs its board by " + over + " mm into " + (hit.index ? "board " + hit.index : "the " + hit.side + " rail") + ". Increase the spacing or rotate the board.", [(p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2]);
      else add("info", "part-overhang", label(x, p.ref) + " overhangs its board edge by " + over + " mm into the routing gap.", [(p.box[0] + p.box[2]) / 2, (p.box[1] + p.box[3]) / 2]);
    }
    for (const [b, f] of per) if (!f.fiducials && f.parts.length) add("info", "local-fiducials", b.name + " has no fiducials of its own (FID1…); the panel's global fiducials are on the rails. Add 2–3 per board for fine-pitch parts.");
  }

  // ------------------------------------------------------------------ panel check
  function check(project, ref, options = {}) {
    const doc = panelOf(project, ref), defs = new Map((project.library || []).map(d => [d.id, d]));
    const {rules, id: profileId, profile} = profileFor(project, doc, options.fabProfile);
    const G = layout(project, doc, defs, options), P = G.params, out = [];
    const add = (level, code, message, at) => out.push({level, code, message, ...(at ? {at: at.map(r4)} : {})});
    for (const w of G.warnings) add("warning", "board", w);
    if (!G.instances.length) { add("error", "empty", "The panel has no boards."); return {items: out, profile: profileId, approximate: true, note: APPROX, size: [G.W, G.H]}; }
    for (const e of G.errors) add("error", e.code, e.message);
    let blocked = G.errors.length > 0;
    try { const {problems} = boardProblems(project, G, options); for (const e of problems) add("error", e.code, e.message); blocked ||= problems.length > 0; }
    catch (e) { add("warning", "analyse", "The boards could not be analysed: " + e.message); blocked = true; }
    const name = (profile?.short || profileId) + " (approximate)";
    const [mw, mh] = rules.maxPanel || [Infinity, Infinity];
    if (Math.max(G.W, G.H) > Math.max(mw, mh) + 1e-6 || Math.min(G.W, G.H) > Math.min(mw, mh) + 1e-6)
      add("error", "panel-size", "The panel is " + r4(G.W) + " x " + r4(G.H) + " mm, larger than " + mw + " x " + mh + " mm for " + name + ".");
    if (G.vscore) {
      const [vw, vh] = rules.vScoreMinPanel || [0, 0];
      if (Math.min(G.W, G.H) < Math.min(vw, vh) - 1e-6 || Math.max(G.W, G.H) < Math.max(vw, vh) - 1e-6)
        add("error", "vscore-panel-size", "V-score panels need at least " + vw + " x " + vh + " mm (" + name + "); this panel is " + r4(G.W) + " x " + r4(G.H) + " mm. Add rails or boards, or use tab routing.");
      const sorted = {x: G.vlines.filter(l => l.axis === "x").map(l => l.at), y: G.vlines.filter(l => l.axis === "y").map(l => l.at)};
      for (const k of ["x", "y"]) for (let i = 1; i < sorted[k].length; i++) if (sorted[k][i] - sorted[k][i - 1] < rules.vScoreLineGap - 1e-6)
        add("warning", "vscore-gap", "Parallel V-score lines " + r4(sorted[k][i] - sorted[k][i - 1]) + " mm apart; " + name + " wants at least " + rules.vScoreLineGap + " mm. Use 0 spacing or at least " + rules.vScoreLineGap + " mm.");
    } else {
      if (G.spacing < rules.routeGap - 1e-6) add("warning", "route-gap", "Board spacing " + G.spacing + " mm is below the " + rules.routeGap + " mm routing gap for " + name + ".");
      if ((P.tabs.perEdge > 0 || P.tabs.manual) && !G.tabs.length) add("error", "no-tabs", "No tab could be placed: check the spacing and the rails.");
      if (P.tabs.hole > 0) {
        const web = P.tabs.pitch - P.tabs.hole;
        if (web < rules.minWeb - 1e-6) add("error", "bite-web", "Mouse-bite holes " + P.tabs.hole + " mm at " + P.tabs.pitch + " mm pitch leave " + r4(web) + " mm between holes; " + name + " wants at least " + rules.minWeb + " mm.");
        if (P.tabs.hole < rules.minHole - 1e-6) add("error", "bite-hole", "Mouse-bite holes of " + P.tabs.hole + " mm are below the " + rules.minHole + " mm minimum hole for " + name + ".");
        if (P.tabs.hole >= P.tabs.width) add("error", "bite-tab", "Mouse-bite holes are as wide as the tab.");
      } else if (G.tabs.length) add("info", "solid-tabs", "Tabs have no mouse-bite holes: boards must be cut out.");
      for (const s of G.skipped) add("warning", "tab-fit", "Board " + s.index + " " + s.side + " edge: " + s.reason + ".");
    }
    if (P.mill && !G.vscore) {
      const gaps = [G.spacingX, G.spacingY].filter(v => v > 0), min = gaps.length ? Math.min(...gaps) : 0;
      if (min && P.mill.radius * 2 > min + 1e-6) add("error", "mill-gap", "A " + r4(P.mill.radius * 2) + " mm routing bit does not fit the " + r4(min) + " mm gap between boards. Widen the spacing or lower the mill radius.");
    }
    partChecks(project, G, defs, rules, name, add);
    if ((P.fiducials.enabled || P.tooling.enabled || P.text.enabled) && !G.rails.length) add("warning", "no-rails", "Fiducials, tooling holes and text need rails.");
    if (G.rails.length && P.rails.width < Math.max(P.fiducials.enabled ? P.fiducials.opening + 1 : 0, P.tooling.enabled ? P.tooling.diameter + 1.5 : 0, 3))
      add("warning", "rail-width", "Rails of " + P.rails.width + " mm are narrow for the fiducials and tooling holes; 5 mm is usual.");
    if (G.texts.length && G.texts[0].size < rules.silkHeight - 1e-6) add("warning", "text-height", "Rail text " + r4(G.texts[0].size) + " mm is below the " + rules.silkHeight + " mm silkscreen height for " + name + ".");
    // Copper against V-score lines and mouse-bite holes.
    if (!blocked && (G.vlines.length || G.bites.length)) {
      let model = null;
      try { model = analyse(project, doc, options); } catch (e) { add("warning", "analyse", "Copper could not be checked: " + e.message); }
      if (model) {
        const shapes = copperShapes(model);
        for (const l of G.vlines) {
          let min = Infinity, at = null;
          for (const s of shapes) {
            const d = AtriumGeometry.segmentDistance(s.a, s.b, l.a, l.b) - s.r;
            if (d < min) { min = d; at = l.axis === "x" ? [l.at, s.a[1]] : [s.a[0], l.at]; }
          }
          if (min < rules.vScoreClearance - 1e-6) add("error", "vscore-copper", "Copper " + r4(Math.max(0, min)) + " mm from the V-score line at " + (l.axis === "x" ? "X " : "Y ") + r4(l.axis === "x" ? l.at : G.H - l.at) + " mm; keep " + rules.vScoreClearance + " mm (" + name + ").", at);
        }
        let near = 0, worst = Infinity, where = null;
        for (const b of G.bites) {
          for (const s of shapes) {
            const d = A().nearSegment(b.at, s.a, s.b) - s.r - b.d / 2;
            if (d < rules.edgeClearance - 1e-6) { near++; if (d < worst) { worst = d; where = b.at; } break; }
          }
        }
        if (near) add("warning", "bite-copper", near + " mouse-bite hole" + (near === 1 ? " is" : "s are") + " closer than " + rules.edgeClearance + " mm to copper (closest " + r4(Math.max(0, worst)) + " mm). Move the tabs or the copper.", where);
      }
    }
    return {items: out, profile: profileId, approximate: true, note: APPROX, size: [G.W, G.H], boards: G.instances.length, tabs: G.tabs.length, bites: G.bites.length, vlines: G.vlines.length};
  }

  // ------------------------------------------------------------------ order notes
  // Short notes for the fab's order form, derived from the board (and panel). Approximate.
  // Smallest gap between copper of two different nets on one layer (pads, tracks, vias, regions
  // and pours). Objects without a net are left out, as DRC's clearance rule does by default.
  // {min, touching} with min null when nothing qualifies.
  function minSpace(model) {
    const shapes = copperShapes(model).filter(s => s.net), cell = 1, grid = new Map();
    if (shapes.length > 200000) return {min: null, touching: 0};
    shapes.forEach((s, i) => {
      const x0 = Math.floor((Math.min(s.a[0], s.b[0]) - s.r) / cell), x1 = Math.floor((Math.max(s.a[0], s.b[0]) + s.r) / cell);
      const y0 = Math.floor((Math.min(s.a[1], s.b[1]) - s.r) / cell), y1 = Math.floor((Math.max(s.a[1], s.b[1]) + s.r) / cell);
      for (let x = x0 - 1; x <= x1; x++) for (let y = y0 - 1; y <= y1; y++) { const k = s.layer + "|" + x + "," + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); }
    });
    let best = Infinity, touching = 0;
    const seen = new Set();
    for (const list of grid.values()) for (let p = 0; p < list.length; p++) for (let q = p + 1; q < list.length; q++) {
      const i = list[p], j = list[q], a = shapes[i], b = shapes[j];
      if (a.net === b.net || a.sid === b.sid) continue;
      const k = i < j ? i * 4294967296 + j : j * 4294967296 + i;
      if (seen.has(k)) continue; seen.add(k);
      const d = AtriumGeometry.segmentDistance(a.a, a.b, b.a, b.b) - a.r - b.r;
      if (d <= 1e-6) touching++; else if (d < best) best = d;
    }
    return {min: Number.isFinite(best) ? best : null, touching};
  }
  function facts(project, board, model) {
    const defs = model.defs, f = {board: board.name, layers: model.stack.length};
    const ext = model.extents; f.size = [r4(ext[2] - ext[0]), r4(ext[3] - ext[1])];
    let t = null; try { t = globalThis.AtriumStackup?.stored?.(board) ? AtriumStackup.thickness(board, defs) : null; } catch { t = null; }
    f.thickness = t > 0 ? r4(t) : null;
    let copper = null;
    try { const s = globalThis.AtriumStackup?.stored?.(board); const top = s?.layers?.find(l => l.key === "Top"); if (top?.thickness > 0) copper = r4(top.thickness / .035); } catch { copper = null; }
    f.outerCopperOz = copper;
    const widths = board.items.filter(i => i.kind === "track" && i.width > 0 && model.stack.includes(i.layer)).map(i => i.width);
    f.minTrack = widths.length ? r4(Math.min(...widths)) : null;
    const sp = minSpace(model); f.minSpace = sp.min == null ? null : r4(sp.min); f.touching = sp.touching;
    const holes = model.drills.filter(h => !h.backdrill).map(h => h.d);
    f.minHole = holes.length ? r4(Math.min(...holes)) : null;
    const vias = model.drills.filter(h => h.via && !h.backdrill).map(h => h.d);
    f.minViaDrill = vias.length ? r4(Math.min(...vias)) : null;
    // Castellated: plated holes whose centre is on (or within the hole radius of) the board edge.
    const ring = model.outline;
    let cast = 0;
    if (ring?.length >= 3) for (const h of model.drills) if (h.plated && !h.via) {
      let d = Infinity; for (let i = 0; i < ring.length; i++) d = Math.min(d, A().nearSegment(h.at, ring[i], ring[(i + 1) % ring.length]));
      if (d <= h.d / 2 + 1e-3) cast++;
    }
    f.castellated = cast;
    let imp = false, profiles = 0;
    try {
      const rules = globalThis.AtriumRules?.effective?.(board, project);
      imp = !!rules?.list?.some(r => r.enabled !== false && r.impedanceProfile);
      profiles = globalThis.AtriumStackup?.stored?.(board)?.impedanceProfiles?.length || 0;
    } catch { imp = false; }
    f.impedance = imp; f.impedanceProfiles = profiles;
    f.bottomParts = model.parts.some(p => p.side === "Bottom");
    f.parts = model.parts.length;
    return f;
  }
  function orderNotes(project, ref, options = {}) {
    const Fo = F() || fail("Fabrication outputs (fab-outputs.js) are not loaded.");
    const docs = project.documents || [];
    let doc = ref && typeof ref === "object" ? ref : docs.find(d => d.id === ref || d.name === ref) || (ref == null ? boardsOf(project)[0] : null);
    if (!doc) fail("The project has no document " + ref + ".");
    let panel = null, board = doc;
    if (doc.kind === "panel") { panel = doc; board = boardById(project, normalize(doc.panel).board) || fail("The panel's board is not in the project."); }
    if (board.kind !== "pcb") fail("Choose a board layout or a panel.");
    const model = Fo.analyse(project, board.id, options.variant !== undefined ? {variant: options.variant} : undefined), f = facts(project, board, model);
    const FP = globalThis.AtriumFabProfiles, vendor = options.vendor || FP?.get?.(options.fabProfile || board.fabProfile?.id || "")?.vendor || "";
    let prof = null; try { prof = FP?.get?.(options.fabProfile || board.fabProfile?.id || (vendor === "PCBWay" ? "pcbway-standard" : vendor === "JLCPCB" ? (f.layers > 2 ? "jlcpcb-4-6l" : "jlcpcb-2l") : "")) || null; } catch { prof = null; }
    const mm = v => v == null ? "n/a" : r4(v).toFixed(3) + " mm";
    const L = ["Order notes: " + board.name + (vendor ? " (" + vendor + ")" : ""), "Derived from the design by Waffle" + (options.date instanceof Date ? " on " + options.date.toISOString().slice(0, 10) : "") + ". Approximate: check every value against the order form.", ""];
    L.push("Layers:              " + f.layers);
    L.push("Board size:          " + f.size[0] + " x " + f.size[1] + " mm");
    if (panel) {
      const G = layout(project, panel, model.defs, options), P = G.params;
      L.push("Delivery:            panel by customer, " + P.rows + " x " + P.cols + " (" + G.instances.length + " boards), " + r4(G.W) + " x " + r4(G.H) + " mm, " + (G.vscore ? "V-score" : "tab routing with mouse bites") +
        (G.rails.length ? ", " + P.rails.width + " mm rails (" + G.rails.map(r => r.side).join(", ") + ")" : ", no rails") + (G.fiducials.length ? ", fiducials" : "") + (G.tooling.length ? ", tooling holes" : ""));
    } else L.push("Delivery:            single boards");
    L.push("Thickness:           " + (f.thickness ? f.thickness + " mm (stack-up)" : "1.6 mm assumed (no stored stack-up)"));
    L.push("Outer copper:        " + (f.outerCopperOz ? f.outerCopperOz + " oz (stack-up)" : "1 oz assumed (no stored stack-up)"));
    L.push("Min track:           " + mm(f.minTrack));
    L.push("Min space:           " + mm(f.minSpace) + " (copper of different nets: pads, tracks, vias, regions and pours)" + (f.touching ? "; " + f.touching + " pair(s) of different nets touch: run DRC" : ""));
    L.push("Min hole:            " + mm(f.minHole) + (f.minViaDrill != null ? " (min via drill " + mm(f.minViaDrill) + ")" : ""));
    L.push("Castellated holes:   " + (f.castellated ? "yes (" + f.castellated + " plated holes on the board edge)" : "no"));
    L.push("Impedance control:   " + (f.impedance ? "yes (routing rules use impedance profiles; send the stack-up)" : "no" + (f.impedanceProfiles ? " (profiles are defined but no rule uses them)" : "")));
    L.push("Assembly sides:      " + (f.parts ? (f.bottomParts ? "top and bottom" : "top") + ", " + f.parts + " placements" : "none"));
    if (prof) {
      const issues = [];
      if (f.minTrack != null && f.minTrack < prof.track - 1e-6) issues.push("min track below " + prof.track + " mm");
      if (f.minSpace != null && f.minSpace < prof.space - 1e-6) issues.push("min space below " + prof.space + " mm");
      if (f.minHole != null && f.minHole < prof.minHole - 1e-6) issues.push("min hole below " + prof.minHole + " mm");
      if (prof.layers && (f.layers < prof.layers[0] || f.layers > prof.layers[1])) issues.push(f.layers + " layers outside " + prof.layers.join("–"));
      L.push("", "Against " + prof.name + " (approximate): " + (issues.length ? issues.join("; ") + "." : "within the profile's limits."));
    }
    const src = [...(FP?.outputLayout?.(vendor)?.sources || []), ...(FP?.panelRules?.(prof || vendor)?.sources || [])];
    if (src.length) L.push("", "Sources:", ...[...new Set(src)].map(s => "  " + s));
    return {text: L.join("\r\n") + "\r\n", facts: f, vendor, profile: prof?.id || null};
  }

  // ------------------------------------------------------------------ panel BOM
  // Panel assembly orders match BOM designators against the pick and place file. The panel CPL
  // names each instance's parts R1_1, R1_2, ... (unique designators, which is what JLCPCB's
  // assembly upload checks), so the BOM of a panel order lists the same designators: each board
  // designator is expanded to one per instance of that board and quantities are multiplied.
  // We chose this over board designators plus an instance column because no fab we checked
  // documents such a column; unique designators are accepted everywhere. Rewrites `report` (bom.js
  // report shape) in place; returns warnings.
  function expandRefs(text) {
    const out = [];
    for (const tok of String(text ?? "").split(/\s*,\s*/).filter(Boolean)) {
      const m = /^(.*?)(\d+)-(.*?)(\d+)$/.exec(tok);
      if (m && m[1] === m[3] && +m[4] >= +m[2] && +m[4] - +m[2] < 10000) for (let n = +m[2]; n <= +m[4]; n++) out.push(m[1] + n);
      else out.push(tok);
    }
    return out;
  }
  function panelBom(project, ref, report, board) {
    const doc = panelOf(project, ref), G = layout(project, doc), warnings = [];
    const mine = G.instances.filter(i => i.board.id === board.id).map(i => i.index);
    const others = [...new Set(G.instances.filter(i => i.board.id !== board.id).map(i => i.board.name))];
    if (others.length) warnings.push("The BOM covers " + board.name + " only; the panel also holds " + others.join(", ") + ".");
    const dc = report.columns.findIndex(c => c.key === "designator"), qc = report.columns.findIndex(c => c.key === "quantity");
    if (dc < 0) { warnings.push("The BOM has no Designator column, so it cannot be matched to the panel pick and place file."); return warnings; }
    for (const row of report.rows) {
      const refs = expandRefs(row[dc]);
      row[dc] = refs.flatMap(r => mine.map(k => r + "_" + k)).join(", ");
      if (qc >= 0 && Number.isFinite(+row[qc]) && String(row[qc]).trim() !== "") row[qc] = +row[qc] * mine.length;
    }
    report.totalParts = (report.totalParts || 0) * mine.length;
    warnings.push("Panel BOM: designators carry the instance suffix (_1 … _" + Math.max(...mine, 0) + ") to match the panel pick and place file.");
    return warnings;
  }

  // ------------------------------------------------------------------ UI (panel-ui.js, loaded on first use)
  // The dialog, the canvas handles and the Properties panel live in panel-ui.js so headless runners
  // (MCP, output jobs) never load them. AtriumLazy loads it with panel.css.
  const hasDOM = () => typeof document !== "undefined" && !!document.createElement;
  // The UI module's global, read by name so headless loaders (release worker, MCP) see no dependency on it.
  const UI_GLOBAL = "AtriumPanel" + "UI", panelUI = () => globalThis[UI_GLOBAL] || null;
  function ui() {
    if (panelUI()) return Promise.resolve(panelUI());
    const L = globalThis.AtriumLazy;
    if (!L?.need) return Promise.reject(Error("The panel editor (panel-ui.js) did not load."));
    L.register?.(UI_GLOBAL, {scripts: ["pcb/panel-ui.js"], css: ["pcb/panel.css"]});
    return L.need(UI_GLOBAL).then(() => panelUI() || Promise.reject(Error("The panel editor (panel-ui.js) did not load.")));
  }
  function open(host, options = {}) {
    if (panelUI()) return panelUI().open(host, options);
    return ui().then(U => U.open(host, options), e => host.info?.(e.message));
  }
  // Properties panel while a panel is the active document (editor.js calls this synchronously).
  function inspect(node, host) {
    if (panelUI()) { panelUI().inspect(node, host); return; }
    node.append(Object.assign(document.createElement("h2"), {textContent: host.doc().name}));
    ui().then(U => { if (node.isConnected && host.doc()?.kind === "panel") { node.replaceChildren(); U.inspect(node, host); host.redraw?.(); } }, () => {});
  }

  function install() {
    const N = globalThis.AtriumNavCommon;
    N?.menuItem?.("tools", "panelize", "Panelize…", {after: "via-stubs"});
    N?.ready?.(host => {
      host.registerAction("panelize", () => open(host));
      // A panel document shown (opened project, tab switch, undo): its canvas handles need panel-ui.js.
      const want = () => { if (host.doc?.()?.kind === "panel" && !panelUI()) ui().then(() => host.redraw?.(), () => {}); };
      host.on?.("document", want);
      want();
    });
  }
  if (hasDOM()) install();

  return Object.freeze({VERSION, DEFAULTS, GENERIC, APPROX, VCUT, PRESETS, THIEVING, applyPreset, fillet, features, drawing, fitArray, headless, report, normalize, validate, create, layout, trace, prepare, analyse, build, describe, flatten, resolvedPlacement, definitionsFor, projectionOf, projectedItem, projectedChanges, bindGeometry, view, step,
    check, orderNotes, facts, profileFor, open, inspect, panelOf, panelBoards: boardsOf, panelBom, expandRefs, routed, boardProblems});
})();
