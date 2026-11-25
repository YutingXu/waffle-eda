"use strict";
// Drawings (Project › Add New Drawing…): fabrication and assembly drawings kept live against
// the board, in the manner of a draftsman document. A drawing is a project document of kind
// "drawing" that holds sheets with placed views. Views store only references and placement;
// every view, table and dimension reads the board as it is now (drawing-views.js), so board
// edits flow into the drawing and its PDF.
//
// Drawing document: {id, kind:"drawing", name, grid, items:[], outline:[], notes:[],
//   sheet:{size, orientation, titleBlock:"none"}  (the editor's sheet underneath sheet 1),
//   drawing:{version:1, board:<pcb id>, parameters:{Title, DocumentNumber, DrawnBy, ...},
//     sheets:[{id, name, size, orientation, titleBlock}],
//     views:[{id, sheet, type, x, y, scale, side?, board?, title?, options:{...}}],
//       type: board | assembly | isometric | drill-table | layer-stack | bom | notes | revisions
//             | section {parent, a:[x,y], b:[x,y], label}   cut along a → b (board mm) of its parent
//             | detail  {parent, center:[x,y], radius, label} magnified circle of its parent
//       x, y: top-left on the sheet (mm); scale: board views paper/board, tables text size
//       options.breaks (board, assembly): [{axis:"x"|"y", from, to}] board ranges cut out by break lines
//     dimensions:[{id, sheet, view, type:"linear"|"radial"|"ordinate", a, b?, points?, axis?,
//       offset?, angle?, kind?, precision?, text?}]   anchors: see drawing-views.js resolve()
//     notes:[{id, text}]   numbered in order
//     callouts:[{id, sheet, note, view?, at?, point?, x, y}]
//     revisions:[{id, rev, date, description, by}]
//     texts:[{id, sheet, x, y, text, height?, angle?, bold?}]          free text, sheet mm
//     lines:[{id, sheet, points:[[x,y],...], weight?, style?}]}}       free lines, sheet mm
//
// API (DOM-free parts run headless for MCP export_drawing / edit_drawing):
//   create(project, {name, board, preset, size, date})  -> new drawing document (not added)
//   apply(project, docOrRef, ops)                       -> results; edits the drawing in place
//   summary(project, docOrRef)                          -> sheets, views (boxes), dimension values
//   pages(project, doc, {date, color}) / build(project, {documents, paper, date}) / exportPDF(...)
//   normalize(raw) / validate(raw)                       the stored form
globalThis.AtriumDrawing = (() => {
  const VERSION = 1;
  const V = () => globalThis.AtriumDrawingViews;
  const A = () => globalThis.Atrium;
  const PDF = () => globalThis.AtriumPDF;
  const MM = 72 / 25.4;
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const fin = v => typeof v === "number" && Number.isFinite(v);
  const str = v => typeof v === "string";
  const fail = m => { throw Error(m); };
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const clamp = (v, lo, hi, d) => fin(+v) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, +v)) : d;
  const newId = () => globalThis.Atrium?.id?.() || "d" + Math.random().toString(36).slice(2, 11);
  const VIEW_TYPES = Object.freeze(["board", "assembly", "isometric", "drill-table", "layer-stack", "bom", "notes", "revisions", "section", "detail"]);
  const VIEW_LABELS = Object.freeze({board: "Board fabrication view", assembly: "Assembly view", isometric: "3D isometric view", "drill-table": "Drill table",
    "layer-stack": "Layer stack table", bom: "Bill of materials", notes: "Notes", revisions: "Revision table", section: "Section view", detail: "Detail view"});
  const TABLE_TYPES = Object.freeze(["drill-table", "layer-stack", "bom", "notes", "revisions"]);
  const OPTION_KEYS = {board: ["drillSymbols", "caption", "breaks"], assembly: ["designators", "values", "pads", "caption", "breaks"], isometric: ["caption"], "layer-stack": ["overlay"], bom: ["rows"], notes: ["width"],
    section: ["zscale", "caption"], detail: ["caption"]};
  const WEIGHTS = ["thin", "medium", "thick", "heavy"], STYLES = ["solid", "dashed", "chain", "dotted"];
  const ANCHOR_KINDS = new Set(["corner", "vertex", "cutout", "hole", "part", "arc", "point"]);
  const DEFAULT_NOTES = ["Board material and thickness: see the layer stack table.", "Dimensions are in millimetres. Hole sizes are finished sizes.",
    "Drill symbols match the drill table. Plated and non-plated holes are listed separately.", "Remove burrs and sharp edges."];

  // ------------------------------------------------------------------ stored form
  const text = (v, n) => str(v) ? v.slice(0, n) : "";
  const point = (q, lim) => Array.isArray(q) && q.length === 2 && q.every(v => fin(v) && Math.abs(v) < lim) ? [r4(q[0]), r4(q[1])] : null;
  // Section and detail letters (I, O, Q, S, X and Z are skipped: they read as digits).
  const LETTERS = "ABCDEFGHJKLMNPRTUVWY";
  const letterAt = n => (n >= LETTERS.length ? letterAt(Math.floor(n / LETTERS.length) - 1) : "") + LETTERS[n % LETTERS.length];
  function anchor(a) {
    if (!plain(a) || !ANCHOR_KINDS.has(a.k)) return null;
    const out = {k: a.k};
    if (a.k === "corner") out.c = ["tl", "tr", "bl", "br", "c"].includes(a.c) ? a.c : "tl";
    if (a.k === "vertex" || a.k === "cutout" || a.k === "arc") out.i = Math.max(0, Math.min(1e6, Math.round(+a.i || 0)));
    if (a.k === "cutout") out.j = Math.max(0, Math.min(1e6, Math.round(+a.j || 0)));
    if (a.k === "arc") out.where = a.where === "contour" ? "contour" : Math.max(0, Math.min(1e4, Math.round(+a.where || 0)));
    if (a.k === "hole" && (str(a.ref) || fin(a.ref))) { out.ref = String(a.ref).slice(0, 64); out.pin = String(a.pin ?? "").slice(0, 32); }
    // Free holes (vias): the via's item ID, net and size, so the anchor survives a move or a re-import.
    if (a.k === "hole" && out.ref == null) {
      if (str(a.id) && a.id) out.id = a.id.slice(0, 64);
      if (str(a.net) && a.net) out.net = a.net.slice(0, 128);
      if (fin(a.d) && a.d > 0 && a.d < 100) out.d = r4(a.d);
    }
    if (a.k === "part") out.ref = text(String(a.ref ?? ""), 64);
    if (Array.isArray(a.at) && a.at.length === 2 && a.at.every(v => fin(v) && Math.abs(v) < 1e6)) out.at = [r4(a.at[0]), r4(a.at[1])];
    if ((a.k === "point" || a.k === "hole" && out.ref == null) && !out.at) return null;
    return out;
  }
  // Forward compatibility: fields, option keys, views, dimensions and anchors a newer Waffle wrote are
  // kept unchanged through normalize (and so through every edit); drawing-views.js draws unknown views
  // as a placeholder box and skips what it can't measure. Keys this build knows are still repaired.
  const clone = v => v === undefined ? v : JSON.parse(JSON.stringify(v));
  const setKey = (o, k, v) => Object.defineProperty(o, k, {value: v, enumerable: true, writable: true, configurable: true});
  const KNOWN = Object.fromEntries(Object.entries({
    top: ["version", "board", "parameters", "sheets", "views", "notes", "dimensions", "callouts", "revisions", "texts", "lines"],
    sheet: ["id", "name", "size", "orientation", "titleBlock"],
    view: ["id", "sheet", "type", "x", "y", "scale", "side", "board", "title", "parent", "label", "a", "b", "center", "radius", "options"],
    option: Object.values(OPTION_KEYS).flat(), note: ["id", "text"],
    dimension: ["id", "sheet", "view", "type", "a", "b", "axis", "kind", "angle", "points", "offset", "precision", "text"],
    callout: ["id", "sheet", "note", "view", "at", "point", "x", "y"], revision: ["id", "rev", "date", "description", "by"],
    text: ["id", "sheet", "x", "y", "text", "height", "angle", "bold"], line: ["id", "sheet", "points", "weight", "style"]
  }).map(([k, v]) => [k, new Set(v)]));
  const keep = (o, raw, known) => { for (const k of Object.keys(raw)) if (!known.has(k) && !Object.hasOwn(o, k)) setKey(o, k, clone(raw[k])); return o; };
  const newerAnchor = a => plain(a) && !ANCHOR_KINDS.has(a.k);
  const newerDimension = m => !["linear", "radial", "ordinate"].includes(m.type) || [m.a, m.b, ...(Array.isArray(m.points) ? m.points : [])].some(newerAnchor);
  function options(type, raw) {
    const o = {}, keys = OPTION_KEYS[type] || [];
    if (!plain(raw)) return o;
    for (const k of keys) {
      if (k === "rows") { if (raw.rows != null) o.rows = Math.round(clamp(raw.rows, 1, 200, 40)); }
      else if (k === "width") { if (raw.width != null) o.width = r4(clamp(raw.width, 20, 800, 130)); }
      else if (k === "zscale") { if (raw.zscale != null) o.zscale = r4(clamp(raw.zscale, 1, 50, 1)); }
      else if (k === "breaks") {
        const list = (Array.isArray(raw.breaks) ? raw.breaks : []).filter(b => plain(b) && (b.axis === "x" || b.axis === "y") && fin(b.from) && fin(b.to) && Math.abs(b.to - b.from) > 1e-3 && Math.abs(b.from) < 1e5 && Math.abs(b.to) < 1e5)
          .slice(0, 8).map(b => ({axis: b.axis, from: r4(Math.min(b.from, b.to)), to: r4(Math.max(b.from, b.to))}));
        if (list.length) o.breaks = list;
      }
      else if (typeof raw[k] === "boolean") o[k] = raw[k];
    }
    return keep(o, raw, KNOWN.option);
  }
  function normalize(raw) {
    const d = plain(raw) ? raw : {}, out = {version: VERSION};
    out.board = text(d.board, 256);
    out.parameters = {};
    if (plain(d.parameters)) for (const [k, v] of Object.entries(d.parameters).slice(0, 32)) if (/^[A-Za-z_][\w]{0,63}$/.test(k) && str(v) && v.trim()) out.parameters[k] = v.slice(0, 256);
    const ids = new Set(), uid = v => { let id = str(v) && v && v.length <= 64 && !ids.has(v) ? v : newId(); while (ids.has(id)) id = newId(); ids.add(id); return id; };
    const list = (v, n) => Array.isArray(v) ? v.slice(0, n).filter(plain) : [];
    out.sheets = list(d.sheets, 50).map((s, i) => keep({id: uid(s.id), name: text(s.name, 80).trim() || "Sheet " + (i + 1), size: V()?.SIZES?.[s.size] ? s.size : "A3",
      orientation: s.orientation === "portrait" ? "portrait" : "landscape", titleBlock: s.titleBlock !== false}, s, KNOWN.sheet));
    if (!out.sheets.length) out.sheets.push({id: uid(null), name: "Sheet 1", size: "A3", orientation: "landscape", titleBlock: true});
    const sheetIds = new Set(out.sheets.map(s => s.id)), first = out.sheets[0].id, sheetOf = v => sheetIds.has(v) ? v : first;
    out.views = list(d.views, 200).map(v => {
      // A view type from a newer Waffle: kept as it is (its own ID and sheet, repaired only when unusable).
      if (!VIEW_TYPES.includes(v.type)) { const o = clone(v); o.id = uid(v.id); if (o.sheet !== sheetOf(o.sheet)) o.sheet = first; return o; }
      const o = {id: uid(v.id), sheet: sheetOf(v.sheet), type: v.type, x: r4(clamp(v.x, -5000, 5000, 20)), y: r4(clamp(v.y, -5000, 5000, 20)), scale: r4(+v.scale > 0 ? clamp(v.scale, .01, 100, 1) : 1)};
      if (v.type === "assembly") o.side = v.side === "Bottom" ? "Bottom" : "Top";
      if (str(v.board) && v.board) o.board = v.board.slice(0, 256);
      if (str(v.title) && v.title.trim()) o.title = v.title.slice(0, 120);
      if (v.type === "section" || v.type === "detail") {
        o.parent = str(v.parent) ? v.parent.slice(0, 64) : "";
        const L = str(v.label) ? v.label.trim().toUpperCase() : "";
        if (/^[A-Z]{1,3}$/.test(L)) o.label = L;
        if (v.type === "section") { o.a = point(v.a, 1e5); o.b = point(v.b, 1e5); }
        else { o.center = point(v.center, 1e5); o.radius = r4(clamp(v.radius, .1, 1000, 5)); }
      }
      o.options = options(v.type, v.options);
      return keep(o, v, KNOWN.view);
    });
    // Section and detail views follow their parent board or assembly view: without one (or without
    // their cut or circle) they are dropped. Each gets a letter no other linked view uses.
    {
      const parents = new Map(out.views.filter(v => v.type === "board" || v.type === "assembly").map(v => [v.id, v]));
      out.views = out.views.filter(v => v.type !== "section" && v.type !== "detail" || parents.has(v.parent) && (v.type === "detail" ? !!v.center : !!v.a && !!v.b && Math.hypot(v.b[0] - v.a[0], v.b[1] - v.a[1]) > 1e-3));
      const linked = out.views.filter(v => v.type === "section" || v.type === "detail"), used = new Set();
      for (const v of linked) { if (v.label && !used.has(v.label)) used.add(v.label); else delete v.label; }
      let n = 0;
      for (const v of linked) if (!v.label) { while (used.has(letterAt(n))) n++; v.label = letterAt(n); used.add(v.label); }
    }
    const viewIds = new Set(out.views.map(v => v.id));
    out.notes = list(d.notes, 100).map(n => keep({id: uid(n.id), text: text(n.text, 2000)}, n, KNOWN.note));
    const noteIds = new Set(out.notes.map(n => n.id)), opaque = new WeakSet();
    out.dimensions = list(d.dimensions, 500).filter(m => viewIds.has(m.view) || m.view == null && newerDimension(m)).map(m => {
      // A dimension type or anchor kind from a newer Waffle: kept as it is, on its view's sheet.
      if (newerDimension(m)) { const o = clone(m); o.id = uid(m.id); o.sheet = m.view != null ? out.views.find(v => v.id === m.view).sheet : sheetOf(m.sheet); opaque.add(o); return o; }
      const o = {id: uid(m.id), sheet: out.views.find(v => v.id === m.view).sheet, view: m.view, type: m.type, a: anchor(m.a)};
      if (m.type === "linear") { o.b = anchor(m.b); o.axis = ["x", "y", "aligned"].includes(m.axis) ? m.axis : "x"; }
      if (m.type === "radial") { o.kind = m.kind === "radius" ? "radius" : "diameter"; o.angle = r4(clamp(m.angle, -360, 360, 45)); }
      if (m.type === "ordinate") { o.axis = m.axis === "y" ? "y" : "x"; o.points = (Array.isArray(m.points) ? m.points.slice(0, 100) : []).map(anchor).filter(Boolean); }
      o.offset = r4(clamp(m.offset, -500, 500, m.type === "radial" ? 6 : m.type === "ordinate" ? 6 : -8));
      if (m.precision != null) o.precision = Math.round(clamp(m.precision, 0, 4, 2));
      if (str(m.text) && m.text) o.text = m.text.slice(0, 120);
      return keep(o, m, KNOWN.dimension);
    }).filter(m => opaque.has(m) || m.a && (m.type !== "linear" || m.b));
    out.callouts = list(d.callouts, 300).filter(c => noteIds.has(c.note)).map(c => {
      const o = {id: uid(c.id), sheet: sheetOf(c.sheet), note: c.note, x: r4(clamp(c.x, -5000, 5000, 20)), y: r4(clamp(c.y, -5000, 5000, 20))};
      if (viewIds.has(c.view)) { o.view = c.view; o.sheet = out.views.find(v => v.id === c.view).sheet; const a = newerAnchor(c.at) ? clone(c.at) : anchor(c.at); if (a) o.at = a; }
      if (Array.isArray(c.point) && c.point.length === 2 && c.point.every(v => fin(v) && Math.abs(v) < 5000)) o.point = [r4(c.point[0]), r4(c.point[1])];
      return keep(o, c, KNOWN.callout);
    });
    out.revisions = list(d.revisions, 100).map(r => keep({id: uid(r.id), rev: text(r.rev, 16), date: text(r.date, 32), description: text(r.description, 300), by: text(r.by, 64)}, r, KNOWN.revision));
    out.texts = list(d.texts, 500).map(x => {
      const o = {id: uid(x.id), sheet: sheetOf(x.sheet), x: r4(clamp(x.x, -5000, 5000, 20)), y: r4(clamp(x.y, -5000, 5000, 20)), text: text(x.text, 2000)};
      if (fin(x.height) && x.height > 0) o.height = r4(clamp(x.height, .5, 50, 2.5));
      if (fin(x.angle) && x.angle % 360) o.angle = r4((x.angle % 360 + 360) % 360);
      if (x.bold === true) o.bold = true;
      return keep(o, x, KNOWN.text);
    }).filter(x => x.text.trim());
    out.lines = list(d.lines, 500).map(l => keep({id: uid(l.id), sheet: sheetOf(l.sheet), points: (Array.isArray(l.points) ? l.points.slice(0, 200) : []).map(q => point(q, 5000)).filter(Boolean),
      weight: WEIGHTS.includes(l.weight) ? l.weight : "medium", style: STYLES.includes(l.style) ? l.style : "solid"}, l, KNOWN.line)).filter(l => l.points.length >= 2);
    return keep(out, d, KNOWN.top);
  }
  const collections = ["sheets", "views", "dimensions", "notes", "callouts", "revisions", "texts", "lines"];
  const defaultSheets = new WeakMap();
  // Older drawings and native projections omit collections with no records.
  // Keep a stable sheet identity for a blank document until it is first edited.
  function drawingData(doc) {
    const raw = doc.drawing;
    if (raw?.sheets?.length && plain(raw.parameters) && collections.every(key => Array.isArray(raw[key]))) return raw;
    const data = {version:VERSION,board:"",...raw,parameters:plain(raw?.parameters) ? raw.parameters : {}};
    for (const key of collections) if (!Array.isArray(data[key])) data[key] = [];
    if (!data.sheets.length) {
      let sheet = defaultSheets.get(doc);
      if (!sheet) {
        sheet = normalize({sheets:[doc.sheet || {}]}).sheets[0];
        defaultSheets.set(doc,sheet);
      }
      data.sheets = [sheet];
    }
    return data;
  }
  // Loading: the structure must be readable; normalize() repairs values within it.
  function validate(raw) {
    if (!plain(raw)) fail("This file is not a supported Waffle project.");
    if (raw.version != null && raw.version !== VERSION) fail("This drawing was saved by a newer version of Waffle.");
    for (const k of collections) if (raw[k] != null && !Array.isArray(raw[k])) fail("This file is not a supported Waffle project.");
    if (raw.parameters != null && !plain(raw.parameters)) fail("This file is not a supported Waffle project.");
    normalize(raw);
    return true;
  }
  // The editor's own sheet under sheet 1 (sch-appearance.js draws it before the overlay).
  function syncSheet(doc) {
    const s = doc.drawing.sheets[0];
    doc.sheet = {size: s.size, orientation: s.orientation, titleBlock: "none"};
  }

  // ------------------------------------------------------------------ lookups
  const drawingsOf = project => project.documents.filter(d => d.kind === "drawing");
  const boardsOf = project => project.documents.filter(d => d.kind === "pcb");
  function drawingOf(project, ref) {
    if (plain(ref) && ref.kind === "drawing") return ref;
    const all = drawingsOf(project);
    if (ref == null || ref === "") return all[0] || fail("The project has no drawing. Create one with create.");
    return all.find(d => d.id === ref || d.name === ref) || fail("The project has no drawing " + ref + ".");
  }
  function boardOf(project, drawing, view) {
    // Section and detail views show their parent's board.
    if (view?.parent && !view.board) { const up = (drawing.views || []).find(v => v.id === view.parent); if (up && up !== view) view = up; }
    const want = view?.board || drawing.board;
    const boards = boardsOf(project);
    return (want ? boards.find(d => d.id === want || d.name === want) : boards[0]) || null;
  }

  // ------------------------------------------------------------------ context (geometry, cache)
  // Board signature: views are rebuilt only when the board or the library changed.
  function hashText(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193); return (h >>> 0).toString(36) + ":" + s.length; }
  function boardSig(project, board) {
    return hashText(JSON.stringify([board.items, board.outline, board.boardShape || null, board.stackup || null, board.pcbDrawing?.pours?.length || 0, project.activeVariant || null, project.library.length]));
  }
  // cache: {rev, sigs: Map, geo: Map, iso: Map, memo: Map} kept by the editor between frames.
  function contextFor(project, doc, o = {}) {
    const D = drawingData(doc), cache = o.cache || {sigs: new Map(), geo: new Map(), iso: new Map(), memo: new Map()};
    cache.heights ||= new Map();
    if (o.cache && o.revision !== undefined && cache.rev !== o.revision) { cache.rev = o.revision; cache.sigs.clear(); cache.memo.clear(); }
    const sig = b => { if (!cache.sigs.has(b.id)) cache.sigs.set(b.id, boardSig(project, b)); return cache.sigs.get(b.id); };
    const ctx = {project, doc, drawing: D, date: o.date instanceof Date ? o.date : null, dateText:o.dateText, variant: o.variant,
      boardDoc: () => boardOf(project, D, null),
      geometry(view) {
        const b = boardOf(project, D, view);
        if (!b) fail("The drawing has no board. Add a PCB layout to the project.");
        const s = sig(b), hit = cache.geo.get(b.id);
        if (hit && hit.sig === s && hit.project === project) return hit.G;
        const G = V().geometry(project, b, {variant: o.variant});
        cache.geo.set(b.id, {sig: s, G, project});
        return G;
      },
      iso(view) {
        const b = boardOf(project, D, view);
        if (!b) return null;
        const s = sig(b), hit = cache.iso.get(b.id);
        if (hit && hit.sig === s && hit.project === project) return hit.I;
        let I = null;
        try { I = V().isometric(project, b, {variant: o.variant}); } catch (e) { I = null; ctx.problem?.("3D view: " + e.message); }
        cache.iso.set(b.id, {sig: s, I, project});
        return I;
      },
      // Component heights for section views (from the 3D export), per board revision.
      heights(view) {
        const b = boardOf(project, D, view);
        if (!b) return new Map();
        const s = sig(b), hit = cache.heights.get(b.id);
        if (hit && hit.sig === s && hit.project === project) return hit.H;
        let H = new Map();
        try { H = V().heights(project, b, {variant: o.variant}); } catch (e) { ctx.problem?.("Section view: component heights: " + e.message); }
        cache.heights.set(b.id, {sig: s, H, project});
        return H;
      },
      memo(key, fn) { if (!cache.memo.has(key)) cache.memo.set(key, fn()); return cache.memo.get(key); }};
    return ctx;
  }

  // ------------------------------------------------------------------ creating
  function uniqueName(project, base) {
    const names = new Set(project.documents.map(d => d.name.trim().toLowerCase()));
    if (!names.has(base.toLowerCase())) return base;
    let n = 2; while (names.has((base + " " + n).toLowerCase())) n++;
    return base + " " + n;
  }
  function extentsOf(project, board) {
    const Ah = A(), defs = new Map(project.library.map(d => [d.id, d]));
    const b = board?.outline?.length >= 3 ? Ah.bounds(board.outline) : board ? Ah.docBounds(board, defs) : null;
    return b && b[2] > b[0] && b[3] > b[1] ? b : [0, 0, 50, 40];
  }
  // Starting layout: a fabrication sheet (board view with overall and hole dimensions, drill
  // and layer stack tables, notes, revisions) and an assembly sheet (top and bottom assembly,
  // 3D view, BOM). Every position stays editable.
  function populate(project, doc, preset, date) {
    const D = doc.drawing, board = boardOf(project, D, null), e = extentsOf(project, board), bw = e[2] - e[0], bh = e[3] - e[1];
    const ctx = contextFor(project, doc, {date});
    const S = s => V().sheetSize(s), fit = V().fitScale;
    const boxOf = v => { try { return V().box(v, ctx); } catch { return [v.x, v.y, v.x + 60, v.y + 30]; } };
    const sheets = [];
    const want = preset === "fabrication" ? ["fab"] : preset === "assembly" ? ["asm"] : ["fab", "asm"];
    D.sheets = want.map((k, i) => ({id: newId(), name: k === "fab" ? "Fabrication" : "Assembly", size: D.sheets[i]?.size || D.sheets[0]?.size || "A3", orientation: "landscape", titleBlock: true}));
    if (!D.notes.length) D.notes = DEFAULT_NOTES.map(t => ({id: newId(), text: t}));
    if (!D.revisions.length) D.revisions = [{id: newId(), rev: "A", date: (date instanceof Date ? date : new Date()).toISOString().slice(0, 10), description: "Initial release", by: ""}];
    for (const [i, k] of want.entries()) {
      const sh = D.sheets[i], z = S(sh), m = z.margin, aw = z.w - 2 * m, ah = z.h - 2 * m;
      sheets.push(sh);
      if (k === "fab") {
        const scale = fit(bw, bh, aw * .56, ah * .55);
        const view = {id: newId(), sheet: sh.id, type: "board", x: m + 22, y: m + 24, scale, options: {}};
        D.views.push(view);
        D.dimensions.push({id: newId(), sheet: sh.id, view: view.id, type: "linear", a: {k: "corner", c: "tl"}, b: {k: "corner", c: "tr"}, axis: "x", offset: -9},
          {id: newId(), sheet: sh.id, view: view.id, type: "linear", a: {k: "corner", c: "tl"}, b: {k: "corner", c: "bl"}, axis: "y", offset: -9});
        // A radial dimension on the largest hole (mounting holes first), when there is one.
        try {
          const G = ctx.geometry(view), big = [...G.holes].sort((a, b) => b.d - a.d || a.plated - b.plated)[0];
          if (big) D.dimensions.push({id: newId(), sheet: sh.id, view: view.id, type: "radial", kind: "diameter", angle: 45, offset: 7,
            a: big.ref != null ? {k: "hole", ref: big.ref, pin: String(big.pin), at: big.at} : {k: "hole", at: big.at, ...(big.id ? {id: big.id} : {}), ...(big.net ? {net: big.net} : {}), d: big.d}});
        } catch { /* no geometry yet */ }
        const vb = boxOf(view), right = vb[2] + 18;
        const drill = {id: newId(), sheet: sh.id, type: "drill-table", x: right, y: m + 12, scale: 1, options: {}};
        D.views.push(drill);
        const db = boxOf(drill);
        D.views.push({id: newId(), sheet: sh.id, type: "layer-stack", x: right, y: db[3] + 8, scale: 1, options: {}});
        const notes = {id: newId(), sheet: sh.id, type: "notes", x: m + 8, y: vb[3] + 12, scale: 1, options: {width: Math.min(150, aw * .45)}};
        D.views.push(notes);
        const rev = {id: newId(), sheet: sh.id, type: "revisions", x: z.w - m - V().TB.w, y: 0, scale: 1, options: {}};
        rev.y = z.h - m - V().TB.h - 6 - (boxOf(rev)[3] - boxOf(rev)[1]);
        D.views.push(rev);
        // A callout from the last note to the board's upper-right corner.
        const note = D.notes.at(-1);
        D.callouts.push({id: newId(), sheet: sh.id, note: note.id, view: view.id, at: {k: "corner", c: "tr"}, x: r4(vb[2] + 8), y: r4(view.y - 4)});
      } else {
        const bottom = (() => { try { return ctx.geometry({}).parts.some(p => p.side === "Bottom"); } catch { return false; } })();
        const scale = fit(bw, bh, bottom ? aw * .36 : aw * .5, ah * .5);
        const top = {id: newId(), sheet: sh.id, type: "assembly", side: "Top", x: m + 12, y: m + 14, scale, options: {designators: true, values: false, pads: true}};
        D.views.push(top);
        let tb = boxOf(top);
        if (bottom) { const bv = {id: newId(), sheet: sh.id, type: "assembly", side: "Bottom", x: tb[2] + 14, y: m + 14, scale, options: {designators: true, pads: true}}; D.views.push(bv); tb = [tb[0], tb[1], boxOf(bv)[2], Math.max(tb[3], boxOf(bv)[3])]; }
        const bom = {id: newId(), sheet: sh.id, type: "bom", x: tb[2] + 14, y: m + 12, scale: .8, options: {rows: 30}};
        D.views.push(bom);
        if (globalThis.AtriumSTEP) {
          const iso = {id: newId(), sheet: sh.id, type: "isometric", x: m + 12, y: tb[3] + 10, scale: 1, options: {}};
          const ib = boxOf(iso), room = [aw * .45, z.h - m - (tb[3] + 10) - 12];
          const k = Math.max(.1, Math.min(4, room[0] / Math.max(1, ib[2] - ib[0]), room[1] / Math.max(1, ib[3] - ib[1] - 7)));
          iso.scale = r4(Math.floor(k * 20) / 20 || .1);
          D.views.push(iso);
        }
      }
    }
    return sheets;
  }
  function create(project, o = {}) {
    const board = o.board ? boardsOf(project).find(d => d.id === o.board || d.name === o.board) || fail("The project has no PCB layout " + o.board + ".") : boardsOf(project)[0] || null;
    const size = V()?.SIZES?.[o.size] ? o.size : "A3";
    const D = normalize({board: board?.id || "", sheets: [{name: "Sheet 1", size, orientation: o.orientation === "portrait" ? "portrait" : "landscape"}], parameters: o.parameters});
    const doc = {id: newId(), kind: "drawing", name: uniqueName(project, text(o.name, 120).trim() || "Drawing"), grid: 1, items: [], outline: [], notes: [], drawing: D};
    if (board && o.preset !== "empty") {
      populate(project, doc, o.preset || "full", o.date);
      D.sheets.forEach(s => { s.size = size; });
    }
    doc.drawing = normalize(D);
    syncSheet(doc);
    return doc;
  }

  // ------------------------------------------------------------------ operations
  // Anchors in operations: an anchor object, a short string ("corner:tl", "vertex:3",
  // "cutout:0:2", "hole:J1.1", "part:U1", "arc:contour:2"), or a board point [x, y] / {x, y}
  // that snaps to the nearest feature within 0.5 mm (else stays a fixed point).
  function parseAnchor(a, G, circle) {
    if (str(a)) {
      const m = /^(corner|vertex|cutout|hole|part|arc):(.+)$/.exec(a.trim()) || fail("Unknown anchor " + a + ".");
      const [k, rest] = [m[1], m[2]];
      if (k === "corner") return {k, c: rest};
      if (k === "vertex") return {k, i: +rest};
      if (k === "cutout") { const [i, j] = rest.split(":").map(Number); return {k, i, j}; }
      if (k === "part") return {k, ref: rest};
      if (k === "arc") { const [w, i] = rest.split(":"); return {k, where: w === "contour" ? "contour" : +w, i: +i}; }
      const dot = rest.lastIndexOf(".");
      return dot > 0 ? {k: "hole", ref: rest.slice(0, dot), pin: rest.slice(dot + 1)} : fail("A hole anchor reads hole:<designator>.<pin>.");
    }
    const p = Array.isArray(a) ? a : plain(a) && fin(a.x) && fin(a.y) && a.k == null ? [a.x, a.y] : null;
    if (p && p.every(fin)) {
      let best = null, dist = .5;
      for (const s of V().snaps(G, circle ? "circle" : "point")) { const d = Math.hypot(s.p[0] - p[0], s.p[1] - p[1]); if (d < dist) { dist = d; best = s; } }
      return best ? {...best.a, at: best.p} : {k: "point", at: p};
    }
    return plain(a) ? a : fail("Each dimension needs its anchors.");
  }
  const kindOf = (D, id) => D.views.some(v => v.id === id) ? "view" : D.dimensions.some(v => v.id === id) ? "dimension" : D.callouts.some(v => v.id === id) ? "callout"
    : D.notes.some(v => v.id === id) ? "note" : D.revisions.some(v => v.id === id) ? "revision" : D.sheets.some(v => v.id === id) ? "sheet"
    : (D.texts || []).some(v => v.id === id) ? "text" : (D.lines || []).some(v => v.id === id) ? "line" : null;
  // A board point for a section cut or a detail centre: [x, y], {x, y}, or an anchor string.
  function boardPoint(a, G, what) {
    if (str(a)) { const r = V().resolve(parseAnchor(a, G, false), G); return r ? r.p.slice() : fail("The " + what + " anchor " + a + " does not resolve."); }
    const p = Array.isArray(a) ? a : plain(a) ? [a.x, a.y] : null;
    return p && p.length === 2 && p.every(fin) ? [p[0], p[1]] : fail("The " + what + " needs a board point [x, y] in mm.");
  }
  // A sensible view scale for a detail: 2.5× its parent's, on the standard list.
  const detailScale = parent => V().SCALES.slice().reverse().find(s => s >= (parent.scale || 1) * 2.5 - 1e-9) || V().SCALES[0];
  // Vertical exaggeration so the board in a section reads at least 3 mm thick on paper.
  const zscaleFor = (G, s) => { const T = G.thickness > 0 ? G.thickness : 1.6; return T * s >= 3 ? 1 : Math.min(10, Math.ceil(3 / (T * s))); };
  function sheetRef(D, ref) {
    if (ref == null || ref === "") return D.sheets[0];
    if (fin(ref)) return D.sheets[ref - 1] || fail("The drawing has no sheet " + ref + ".");
    return D.sheets.find(s => s.id === ref || s.name === ref) || fail("The drawing has no sheet " + ref + ".");
  }
  // A free spot for a new view: below everything else on the sheet, else at the top left.
  function freeSpot(project, doc, sheet, skip) {
    const ctx = contextFor(project, doc), z = V().sheetSize(sheet);
    let y = z.margin + 12;
    for (const v of doc.drawing.views) if (v.sheet === sheet.id && v.id !== skip) { try { y = Math.max(y, V().box(v, ctx)[3] + 10); } catch { /* skip */ } }
    return [z.margin + 12, Math.min(y, z.h - z.margin - 20)];
  }
  function apply(project, ref, ops) {
    const doc = drawingOf(project, ref), results = [];
    if (!Array.isArray(ops)) fail("ops must be a list of operations.");
    if (ops.length > 200) fail("At most 200 operations per call.");
    // All or nothing: a failing operation leaves the drawing as it was.
    const before = {drawing: doc.drawing, name: doc.name, sheet: doc.sheet};
    try { return applyAll(project, doc, ops, results); }
    catch (e) { Object.assign(doc, before); throw e; }
  }
  function applyAll(project, doc, ops, results) {
    let D = normalize(drawingData(doc));
    doc.drawing = D;
    const ctx = () => contextFor(project, doc);
    for (const raw of ops) {
      const op = plain(raw) ? raw : fail("Each operation must be an object.");
      const done = (o = {}) => results.push({op: op.op, ...o});
      switch (op.op) {
        case "rename": doc.name = text(op.name, 120).trim() || doc.name; done({name: doc.name}); break;
        case "set_board": { const b = boardsOf(project).find(d => d.id === op.board || d.name === op.board) || fail("The project has no PCB layout " + op.board + "."); D.board = b.id; done({board: b.id}); break; }
        case "set_parameters": {
          if (!plain(op.parameters)) fail("parameters must be an object of strings.");
          for (const [k, v] of Object.entries(op.parameters)) { if (!str(v) || !v.trim()) delete D.parameters[k]; else D.parameters[k] = v; }
          done({parameters: Object.keys(D.parameters).length}); break;
        }
        case "add_sheet": {
          if (D.sheets.length >= 50) fail("A drawing holds at most 50 sheets.");
          const s = {id: newId(), name: text(op.name, 80).trim() || "Sheet " + (D.sheets.length + 1), size: V().SIZES[op.size] ? op.size : D.sheets.at(-1)?.size || "A3",
            orientation: op.orientation === "portrait" ? "portrait" : "landscape", titleBlock: op.title_block !== false};
          D.sheets.push(s); done({id: s.id}); break;
        }
        case "set_sheet": {
          const s = sheetRef(D, op.sheet);
          if (op.name != null) s.name = text(op.name, 80).trim() || s.name;
          if (op.size != null) s.size = V().SIZES[op.size] ? op.size : fail("Unknown sheet size " + op.size + ".");
          if (op.orientation != null) s.orientation = op.orientation === "portrait" ? "portrait" : "landscape";
          if (op.title_block != null) s.titleBlock = op.title_block !== false;
          done({id: s.id}); break;
        }
        case "add_view": {
          if (!VIEW_TYPES.includes(op.type)) fail("Unknown view type " + op.type + ". Use one of " + VIEW_TYPES.join(", ") + ".");
          const s = sheetRef(D, op.sheet), at = fin(op.x) && fin(op.y) ? [op.x, op.y] : freeSpot(project, doc, s);
          const v = {id: newId(), sheet: s.id, type: op.type, x: at[0], y: at[1], scale: 1, options: options(op.type, op.options)};
          if (op.type === "assembly") v.side = op.side === "Bottom" ? "Bottom" : "Top";
          if (op.type === "section" || op.type === "detail") {
            const up = D.views.find(x => x.id === op.parent) || fail("A " + op.type + " view needs parent: the ID of a board or assembly view.");
            if (!V().BOARD_TYPES.has(up.type)) fail("A " + op.type + " view is taken from a board or assembly view.");
            const G = ctx().geometry(up);
            v.parent = up.id;
            if (str(op.label) && op.label.trim()) v.label = op.label.trim().toUpperCase();
            if (op.type === "section") {
              v.a = boardPoint(op.a ?? fail("A section view needs its cutting line a and b."), G, "section"); v.b = boardPoint(op.b ?? fail("A section view needs its cutting line a and b."), G, "section");
              if (Math.hypot(v.b[0] - v.a[0], v.b[1] - v.a[1]) < .01) fail("The section's cutting line needs two different points.");
              v.scale = fin(op.scale) && op.scale > 0 ? op.scale : up.scale;
              v.options = options("section", {zscale: zscaleFor(G, v.scale), ...(plain(op.options) ? op.options : {})});
            } else {
              v.center = boardPoint(op.center ?? fail("A detail view needs its centre."), G, "detail");
              v.radius = fin(op.radius) && op.radius > 0 ? op.radius : 5;
              v.scale = fin(op.scale) && op.scale > 0 ? op.scale : detailScale(up);
            }
            D.views.push(v);
            done({id: v.id, scale: v.scale, label: normalize(D).views.find(x => x.id === v.id)?.label || null}); break;
          }
          if (op.board) v.board = (boardsOf(project).find(d => d.id === op.board || d.name === op.board) || fail("The project has no PCB layout " + op.board + ".")).id;
          if (str(op.title) && op.title.trim()) v.title = op.title.slice(0, 120);
          if (fin(op.scale) && op.scale > 0) v.scale = op.scale;
          else if (V().BOARD_TYPES.has(op.type)) { const e = extentsOf(project, boardOf(project, D, v)), z = V().sheetSize(s); v.scale = V().fitScale(e[2] - e[0], e[3] - e[1], (z.w - 2 * z.margin) * .45, (z.h - 2 * z.margin) * .45); }
          D.views.push(v); done({id: v.id, scale: v.scale}); break;
        }
        case "set_view": {
          const v = D.views.find(x => x.id === op.id) || fail("The drawing has no view " + op.id + ".");
          if (!VIEW_TYPES.includes(v.type) && [op.scale, op.side, op.title, op.options, op.label, op.a, op.b, op.center, op.radius].some(x => x != null)) fail("View " + op.id + " is from a newer version of Waffle: only its position and sheet can change here.");
          if (fin(op.x)) v.x = op.x; if (fin(op.y)) v.y = op.y;
          if (op.scale != null) v.scale = fin(op.scale) && op.scale > 0 ? op.scale : fail("scale must be a positive number.");
          if (op.sheet != null) { v.sheet = sheetRef(D, op.sheet).id; for (const m of D.dimensions) if (m.view === v.id) m.sheet = v.sheet; for (const c of D.callouts) if (c.view === v.id) c.sheet = v.sheet; }
          if (op.side != null && v.type === "assembly") v.side = op.side === "Bottom" ? "Bottom" : "Top";
          if (op.title != null) { if (str(op.title) && op.title.trim()) v.title = op.title.slice(0, 120); else delete v.title; }
          if (plain(op.options)) v.options = options(v.type, {...v.options, ...op.options});
          if (v.type === "section" || v.type === "detail") {
            const up = D.views.find(x => x.id === v.parent), G = up ? ctx().geometry(up) : null;
            if (op.label != null) { if (str(op.label) && op.label.trim()) v.label = op.label.trim().toUpperCase(); else delete v.label; }
            if (G && v.type === "section") { if (op.a != null) v.a = boardPoint(op.a, G, "section"); if (op.b != null) v.b = boardPoint(op.b, G, "section"); }
            if (G && v.type === "detail") { if (op.center != null) v.center = boardPoint(op.center, G, "detail"); if (op.radius != null) v.radius = fin(op.radius) && op.radius > 0 ? op.radius : fail("radius must be a positive number."); }
          }
          done({id: v.id}); break;
        }
        case "add_break": {
          const v = D.views.find(x => x.id === op.view) || fail("The drawing has no view " + op.view + ".");
          if (!V().BOARD_TYPES.has(v.type)) fail("Break lines go on a board or assembly view.");
          if (op.axis !== "x" && op.axis !== "y") fail("A break needs axis x (a vertical break across a wide board) or y.");
          if (!fin(op.from) || !fin(op.to) || Math.abs(op.to - op.from) < .01) fail("A break needs from and to: the board range (mm) it removes.");
          const e = ctx().geometry(v).extents, lo = op.axis === "x" ? e[0] : e[1], hi = op.axis === "x" ? e[2] : e[3];
          const f = Math.max(lo, Math.min(op.from, op.to)), to = Math.min(hi, Math.max(op.from, op.to));
          if (!(to - f > .01)) fail("The break lies outside the board.");
          v.options = options(v.type, {...v.options, breaks: [...(v.options?.breaks || []), {axis: op.axis, from: f, to}]});
          done({id: v.id, breaks: v.options.breaks?.length || 0}); break;
        }
        case "add_text": {
          const s = sheetRef(D, op.sheet), x = {id: newId(), sheet: s.id, x: +op.x, y: +op.y, text: text(op.text, 2000)};
          if (!fin(x.x) || !fin(x.y)) fail("Text needs its position x, y on the sheet (mm).");
          if (!x.text.trim()) fail("Text needs text.");
          if (fin(op.height)) x.height = op.height; if (fin(op.angle)) x.angle = op.angle; if (op.bold === true) x.bold = true;
          D.texts.push(x); done({id: x.id}); break;
        }
        case "set_text": {
          const x = D.texts.find(q => q.id === op.id) || fail("The drawing has no text " + op.id + ".");
          if (op.text != null) { const v = text(op.text, 2000); if (!v.trim()) fail("Text needs text."); x.text = v; }
          for (const k of ["x", "y", "height", "angle"]) if (fin(op[k])) x[k] = op[k];
          if (typeof op.bold === "boolean") { if (op.bold) x.bold = true; else delete x.bold; }
          done({id: x.id}); break;
        }
        case "add_line": {
          const s = sheetRef(D, op.sheet), pts = (Array.isArray(op.points) ? op.points : []).map(q => point(Array.isArray(q) ? q : plain(q) ? [q.x, q.y] : null, 5000));
          if (pts.length < 2 || pts.some(q => !q)) fail("A line needs points: at least two [x, y] sheet positions (mm).");
          const l = {id: newId(), sheet: s.id, points: pts, weight: WEIGHTS.includes(op.weight) ? op.weight : "medium", style: STYLES.includes(op.style) ? op.style : "solid"};
          D.lines.push(l); done({id: l.id}); break;
        }
        case "set_line": {
          const l = D.lines.find(q => q.id === op.id) || fail("The drawing has no line " + op.id + ".");
          if (op.points != null) { const pts = (Array.isArray(op.points) ? op.points : []).map(q => point(q, 5000)); if (pts.length < 2 || pts.some(q => !q)) fail("A line needs at least two points."); l.points = pts; }
          if (op.weight != null) l.weight = WEIGHTS.includes(op.weight) ? op.weight : fail("weight is one of " + WEIGHTS.join(", ") + ".");
          if (op.style != null) l.style = STYLES.includes(op.style) ? op.style : fail("style is one of " + STYLES.join(", ") + ".");
          done({id: l.id}); break;
        }
        case "add_dimension": {
          const v = D.views.find(x => x.id === op.view) || fail("The drawing has no view " + op.view + ".");
          if (!V().FRAMED.has(v.type)) fail("Dimensions go on a board, assembly or detail view.");
          if (!["linear", "radial", "ordinate"].includes(op.type)) fail("A dimension is linear, radial or ordinate.");
          const G = ctx().geometry(v), m = {id: newId(), sheet: v.sheet, view: v.id, type: op.type, a: parseAnchor(op.a, G, op.type === "radial")};
          if (op.type === "linear") { m.b = parseAnchor(op.b ?? fail("A linear dimension needs anchors a and b."), G, false); m.axis = op.axis || "x"; }
          if (op.type === "radial") { m.kind = op.kind; if (fin(op.angle)) m.angle = op.angle; }
          if (op.type === "ordinate") { m.axis = op.axis || "x"; m.points = (Array.isArray(op.points) ? op.points : []).map(p => parseAnchor(p, G, false)); }
          for (const k of ["offset", "precision"]) if (fin(op[k])) m[k] = op[k];
          if (str(op.text)) m.text = op.text;
          const value = V().measure(normalize({...D, dimensions: [m]}).dimensions[0] || fail("The dimension's anchors are not valid."), ctx());
          if (!value) fail("The dimension does not resolve: " + (op.type === "radial" ? "radial dimensions need a hole or an arc." : "check its anchors."));
          D.dimensions.push(m); D = doc.drawing = normalize(D);
          done({id: m.id, value: value.value, resolved: value.ok}); break;
        }
        case "set_dimension": {
          const m = D.dimensions.find(x => x.id === op.id) || fail("The drawing has no dimension " + op.id + ".");
          if (newerDimension(m)) fail("Dimension " + op.id + " is from a newer version of Waffle and can't be edited here.");
          for (const k of ["offset", "angle", "precision"]) if (fin(op[k])) m[k] = op[k];
          if (op.text != null) { if (str(op.text) && op.text) m.text = op.text; else delete m.text; }
          if (op.axis != null) m.axis = op.axis;
          if (op.kind != null) m.kind = op.kind;
          done({id: m.id}); break;
        }
        case "add_note": { const n = {id: newId(), text: text(op.text, 2000)}; if (!n.text.trim()) fail("A note needs text."); D.notes.push(n); done({id: n.id, number: D.notes.length}); break; }
        case "set_note": { const n = D.notes.find(x => x.id === op.id || fin(op.id) && D.notes.indexOf(x) === op.id - 1) || fail("The drawing has no note " + op.id + "."); n.text = text(op.text, 2000); done({id: n.id}); break; }
        case "add_callout": {
          const n = (fin(op.note) ? D.notes[op.note - 1] : D.notes.find(x => x.id === op.note)) || fail("The drawing has no note " + op.note + ".");
          const c = {id: newId(), note: n.id, x: +op.x, y: +op.y, sheet: sheetRef(D, op.sheet).id};
          if (!fin(c.x) || !fin(c.y)) fail("A callout needs its balloon position x, y on the sheet.");
          if (op.view != null) {
            const v = D.views.find(x => x.id === op.view) || fail("The drawing has no view " + op.view + ".");
            c.view = v.id; c.sheet = v.sheet;
            if (op.at != null) c.at = parseAnchor(op.at, ctx().geometry(v), false);
          } else if (Array.isArray(op.point)) c.point = op.point;
          D.callouts.push(c); done({id: c.id, number: D.notes.indexOf(n) + 1}); break;
        }
        case "add_revision": { const r = {id: newId(), rev: text(op.rev, 16), date: text(op.date, 32), description: text(op.description, 300), by: text(op.by, 64)}; if (!r.rev) fail("A revision needs rev."); D.revisions.push(r); done({id: r.id}); break; }
        case "remove": {
          const k = kindOf(D, op.id) || fail("The drawing has nothing with ID " + op.id + ".");
          if (k === "sheet") { if (D.sheets.length < 2) fail("A drawing keeps at least one sheet."); const gone = new Set(D.views.filter(v => v.sheet === op.id).map(v => v.id)); D.sheets = D.sheets.filter(s => s.id !== op.id); D.views = D.views.filter(v => !gone.has(v.id)); D.callouts = D.callouts.filter(c => c.sheet !== op.id); D.texts = D.texts.filter(x => x.sheet !== op.id); D.lines = D.lines.filter(x => x.sheet !== op.id); }
          if (k === "view") D.views = D.views.filter(v => v.id !== op.id);
          if (k === "dimension") D.dimensions = D.dimensions.filter(v => v.id !== op.id);
          if (k === "callout") D.callouts = D.callouts.filter(v => v.id !== op.id);
          if (k === "note") D.notes = D.notes.filter(v => v.id !== op.id);
          if (k === "revision") D.revisions = D.revisions.filter(v => v.id !== op.id);
          if (k === "text") D.texts = D.texts.filter(v => v.id !== op.id);
          if (k === "line") D.lines = D.lines.filter(v => v.id !== op.id);
          done({id: op.id, kind: k}); break;
        }
        default: fail("Unknown drawing operation " + op.op + ".");
      }
      D = doc.drawing = normalize(D);
    }
    syncSheet(doc);
    return results;
  }

  // ------------------------------------------------------------------ summary
  function summary(project, ref, o = {}) {
    const doc = drawingOf(project, ref), ctx = contextFor(project, doc, o), D = ctx.drawing, problems = [];
    ctx.problem = m => problems.push(m);
    const board = boardOf(project, D, null);
    if (board) {
      try { const G = ctx.geometry({}); if (G.stacked) problems.push(G.stacked + " drill hit" + (G.stacked === 1 ? " is" : "s are") + " stacked on another of the same size (a re-import may have duplicated vias); the drill table counts every hit."); } catch { /* reported per view */ }
    }
    const sheets = D.sheets.map((s, i) => {
      const z = V().sheetSize(s);
      const views = D.views.filter(v => v.sheet === s.id).map(v => {
        let b = null;
        try { b = V().box(v, ctx).map(r4); } catch (e) { problems.push(VIEW_LABELS[v.type] + ": " + e.message); }
        return {id: v.id, type: v.type, ...(VIEW_TYPES.includes(v.type) ? {} : {newer: true}), ...(v.side ? {side: v.side} : {}), ...(v.parent ? {parent: v.parent, label: v.label || null} : {}),
          ...(v.options?.breaks?.length ? {breaks: v.options.breaks.length} : {}), x: v.x, y: v.y, scale: v.scale,
          scale_text: V().BOARD_TYPES.has(v.type) || V().LINKED.has(v.type) ? V().ratio(v.scale) : null, box: b,
          off_sheet: !!b && (b[0] < 0 || b[1] < 0 || b[2] > z.w || b[3] > z.h)};
      });
      const dims = D.dimensions.filter(m => m.sheet === s.id).map(m => {
        let r = null;
        try { r = V().measure(m, ctx); } catch (e) { problems.push("Dimension: " + e.message); }
        if (newerDimension(m)) { /* from a newer version: kept, not measured */ } else if (!r) problems.push("A " + m.type + " dimension lost its view or anchors.");
        else if (!r.ok) problems.push("A " + m.type + " dimension's board feature is gone; it shows its last position.");
        return {id: m.id, type: m.type, view: m.view, value: r ? (Array.isArray(r.value) ? r.value.map(v => r4(v)) : r4(r.value)) : null, resolved: !!r?.ok};
      });
      return {id: s.id, number: i + 1, size: z.size, orientation: s.orientation, width_mm: z.w, height_mm: z.h, views, dimensions: dims,
        texts: (D.texts || []).filter(x => x.sheet === s.id).length, lines: (D.lines || []).filter(x => x.sheet === s.id).length,
        callouts: D.callouts.filter(c => c.sheet === s.id).map(c => ({id: c.id, note: D.notes.findIndex(n => n.id === c.note) + 1}))};
    });
    return {id: doc.id, board: board?.id || null, sheets, notes: D.notes.length, revisions: D.revisions.map(r => r.rev), problems: [...new Set(problems)],
      untrusted_design_text: {name: doc.name, board_name: board?.name || "", sheet_names: D.sheets.map(s => s.name), notes: D.notes.map(n => n.text), texts: (D.texts || []).map(x => x.text),
        revisions: D.revisions.map(r => ({rev: r.rev, description: r.description, by: r.by, date: r.date})), parameters: {...D.parameters}}};
  }

  // ------------------------------------------------------------------ PDF
  const PRINT = {paper: "#ffffff", ink: "#000000", muted: "#4a4a4a", faint: "#cfcfcf", dim: "#000000", dnp: "#c0281e", px: 0};
  function paintPresentation(c, project, doc, o = {}) {
    const D = normalize(drawingData(doc)), origins = sheetOrigins(D), notes = [];
    const ctx = contextFor(project, {...doc, drawing:D}, {date:o.date,variant:o.variant});
    ctx.problem = message => notes.push(message);
    const env = o.color === "mono" ? {...PRINT, faint:"#ffffff",dnp:"#000000"} : PRINT;
    D.sheets.forEach((sheet, i) => {
      c.save();
      try {
        c.translate(origins[i][0], origins[i][1]);
        V().paintSheet(c, ctx, sheet, i, env);
        c.strokeStyle = "#1453a3"; c.lineWidth = .5;
        for (const {id,kind} of selectionEntries(D, o.selection ?? [])) {
          if (sheetOfObject(D,kind,id) !== sheet.id) continue;
          const box = objectBox(ctx,kind,id);
          if (box) c.strokeRect(box[0],box[1],box[2]-box[0],box[3]-box[1]);
        }
      }
      finally { c.restore(); }
    });
    return notes;
  }
  // One page per sheet, at the sheet's own size (1:1).
  function pages(project, ref, o = {}) {
    const P = PDF() || fail("PDF output needs pdf.js."), doc = drawingOf(project, ref), D = normalize(drawingData(doc));
    const ctx = contextFor(project, {...doc,drawing:D}, {date:o.date,dateText:o.dateText,variant:o.variant,cache:o.cache});
    const notes = [];
    ctx.problem = m => notes.push(m);
    const env = o.color === "mono" ? {...PRINT, faint: "#ffffff", dnp: "#000000"} : PRINT;
    return {notes, list: D.sheets.map((s, i) => {
      const z = V().sheetSize(s), W = z.w * MM, H = z.h * MM;
      const rec = P.recorder(W, H, {}), c = rec.ctx;
      c.scale(MM, MM);
      V().paintSheet(c, ctx, s, i, env);
      return {w: W, h: H, list: rec.list, title: doc.name + " — " + s.name, doc: doc.id, kind: "drawing", sheet: s.id, sheetSize: z.size, area: [0, 0, W, H]};
    })};
  }
  // Paper smaller than the sheet: tile each sheet over pages of that paper at 1:1.
  const PAPER = {A4: [210, 297], A3: [297, 420], A2: [420, 594], Letter: [215.9, 279.4], Tabloid: [279.4, 431.8]};
  // paper: a name (A4, A3, A2, Letter, Tabloid, or any AtriumPrint paper) or [width, height] in mm.
  // o.orientation: "landscape" | "portrait" | "auto" (follow the sheet); o.margin in mm (default 8).
  // The Print dialog (print.js) tiles drawing sheets through this too, so print and export agree.
  function tile(page, paper, notes, o = {}) {
    const P = PDF(), dims = Array.isArray(paper) ? paper : PAPER[paper] || globalThis.AtriumPrint?.PAPER?.[paper] || fail("Unknown paper " + paper + ".");
    const [a, b] = dims, land = o.orientation === "landscape" ? true : o.orientation === "portrait" ? false : page.w >= page.h;
    const W = (land ? Math.max(a, b) : Math.min(a, b)) * MM, H = (land ? Math.min(a, b) : Math.max(a, b)) * MM, m = (fin(o.margin) ? Math.max(0, Math.min(50, o.margin)) : 8) * MM, ar = [m, m, W - m, H - m];
    if (page.w <= W + .5 && page.h <= H + .5) return [page];
    const grid = P.tiles(page.w, page.h, ar, 6 * MM);
    notes.push(page.title + " was tiled at 1:1 over " + grid.length + " " + (Array.isArray(paper) ? +a.toFixed(1) + " × " + +b.toFixed(1) + " mm" : paper) + " pages.");
    return grid.map(t => {
      const marks = P.recorder(W, H, {}), c = marks.ctx;
      c.fillStyle = "#000"; c.font = "6.5px Helvetica"; c.textBaseline = "bottom";
      c.fillText(page.title + " · tile " + (t.index + 1) + " of " + t.count + " (row " + (t.row + 1) + ", column " + (t.col + 1) + ") · 1:1, 6 mm overlap", ar[0], ar[1] - 2);
      c.strokeStyle = "#000"; c.lineWidth = .3; c.setLineDash([3, 2]); c.beginPath();
      if (t.col < t.cols - 1) { c.moveTo(ar[2] - 6 * MM, ar[1]); c.lineTo(ar[2] - 6 * MM, ar[3]); }
      if (t.row < t.rows - 1) { c.moveTo(ar[0], ar[3] - 6 * MM); c.lineTo(ar[2], ar[3] - 6 * MM); }
      c.stroke();
      return {...page, w: W, h: H, list: [...P.shift(page.list, t.dx, t.dy, ar), ...marks.list], title: page.title + " — tile " + (t.index + 1) + " of " + t.count, tile: t, area: ar};
    });
  }
  function build(project, o = {}) {
    const all = drawingsOf(project), want = Array.isArray(o.documents) && o.documents.length ? o.documents : null;
    const docs = want ? want.map(r => all.find(d => d.id === r || d.name === r) || fail("The project has no drawing " + r + ".")) : all;
    if (!docs.length) fail("The project has no drawings. Add one with Project › Add New Drawing….");
    const out = [], notes = [], started = Date.now();
    for (const d of docs) {
      const r = pages(project, d, o);
      notes.push(...r.notes);
      for (const p of r.list) out.push(...(o.paper ? tile(p, o.paper, notes) : [p]));
    }
    return {pages: out, notes: [...new Set(notes)], elapsed: Date.now() - started,
      bytes(extra = {}) {
        const pdf = PDF().document({title: o.title || (docs.length === 1 ? docs[0].name : project.name), subject: "Waffle drawing", date: o.date instanceof Date ? o.date : null, compress: o.compress});
        for (const p of out) pdf.page(p.w, p.h, p.list);
        pdf.outline(docs.map(d => ({title: d.name, page: out.findIndex(p => p.doc === d.id), x: 0, y: 0, open: true,
          children: out.map((p, k) => [p, k]).filter(([p]) => p.doc === d.id).map(([p, k]) => ({title: p.title.slice(d.name.length + 3) || p.title, page: k, x: 0, y: 0}))})));
        return pdf.bytes(extra);
      }};
  }
  const exportPDF = (project, o) => build(project, o).bytes();
  const fileName = (name) => String(name || "Drawing").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() + ".pdf";

  // ================================================================== editor UI
  const hasDOM = () => typeof document !== "undefined" && !!document.createElement;
  let H = null;                       // AtriumNavHost
  const cache = {sigs: new Map(), geo: new Map(), iso: new Map(), memo: new Map(), heights: new Map(), rev: undefined};
  const state = {sel: null, tool: null, pending: null, hover: null, drag: null, docId: null, flash: null};
  const GAP = 24, ORIGIN = -12.7;     // sheets side by side; sheet 1 sits where the editor draws its sheet
  function sheetOrigins(D) {
    let x = ORIGIN;
    return D.sheets.map(s => { const z = V().sheetSize(s), o = [x, ORIGIN, z.w, z.h]; x += z.w + GAP; return o; });
  }
  // The sheet under a world point, and the point in that sheet's millimetres.
  function locate(D, w) {
    const os = sheetOrigins(D);
    for (let i = 0; i < os.length; i++) { const [x, y, ww, hh] = os[i]; if (w[0] >= x - 4 && w[0] <= x + ww + 4 && w[1] >= y - 4 && w[1] <= y + hh + 4) return {i, sheet: D.sheets[i], p: [w[0] - x, w[1] - y]}; }
    return null;
  }
  function fitBox(doc) {
    if (!V()) return null;
    const os = sheetOrigins(normalize(drawingData(doc))), last = os.at(-1);
    return [ORIGIN, ORIGIN, last[0] + last[2], ORIGIN + Math.max(...os.map(o => o[3]))];
  }
  const ctxNow = () => { const p = H.project(), d = state.drag?.previewDoc || H.doc(); return contextFor(p, d, {cache, revision: H.revision?.()}); };
  const liveDoc = () => {
    const doc = H?.doc?.();
    if (doc?.kind !== "drawing") return null;
    const drawing = drawingData(doc);
    return drawing === doc.drawing ? doc : {...doc,drawing};
  };
  // Selection and tool feedback use the theme's accent token (re-read when the theme changes).
  let accent = null;
  function accentColor() {
    if (accent) return accent;
    try { accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#00a000"; } catch { accent = "#00a000"; }
    return accent;
  }
  function screenEnv(scale) {
    const S = globalThis.AtriumSchAppearance;
    return {paper: S?.paper || "#ffffff", ink: "#000000", muted: "#4a4a4a", faint: "#c9c9c4", dim: "#000000", dnp: "#c0281e", px: 1 / (scale || 1), sel: accentColor()};
  }
  function paintScreen(c, doc, env0) {
    if (!V()) return;
    const D = drawingData(doc);
    let ctx;
    try { ctx = ctxNow(); } catch { return; }
    const env = screenEnv(env0.scale), os = sheetOrigins(D);
    D.sheets.forEach((s, i) => {
      c.save(); c.translate(os[i][0], os[i][1]);
      try { V().paintSheet(c, ctx, s, i, env); } catch (e) { globalThis.console?.error?.(e); }
      paintSelection(c, ctx, s, env);
      // Sheet name above the paper.
      c.fillStyle = env.ink; c.font = V().font(Math.max(2.5, 12 / env0.scale)); c.textBaseline = "bottom";
      c.globalAlpha = .7; c.fillText((i + 1) + ". " + s.name + " · " + V().sheetSize(s).size + " " + s.orientation, 0, -1.5); c.globalAlpha = 1;
      c.restore();
    });
  }
  // The sheet box of any selectable object (views, dimensions, callouts, text, lines).
  function objectBox(ctx, kind, id) {
    const D = ctx.drawing;
    try {
      if (kind === "view") { const v = D.views.find(x => x.id === id); return v ? V().box(v, ctx) : null; }
      if (kind === "dimension") { const m = D.dimensions.find(x => x.id === id), r = m && V().measure(m, ctx); return r ? bboxOf([...r.lines.flat(), ...r.texts.map(t => t.at)]) : null; }
      if (kind === "callout") { const cl = D.callouts.find(x => x.id === id); return cl ? [cl.x - 3.4, cl.y - 3.4, cl.x + 3.4, cl.y + 3.4] : null; }
      if (kind === "text") { const t = D.texts.find(x => x.id === id); return t ? V().textBox(t) : null; }
      if (kind === "line") { const l = D.lines.find(x => x.id === id); return l ? bboxOf(l.points) : null; }
    } catch { return null; }
    return null;
  }
  const bboxOf = pts => pts.length ? [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))] : null;
  const sheetOfObject = (D, kind, id) => (kind === "view" ? D.views : kind === "dimension" ? D.dimensions : kind === "callout" ? D.callouts : kind === "text" ? D.texts : kind === "line" ? D.lines : []).find(x => x.id === id)?.sheet;
  function paintSelection(c, ctx, sheet, env) {
    const D = ctx.drawing, sel = state.sel, px = env.px;
    c.save(); c.strokeStyle = env.sel; c.fillStyle = env.sel; c.lineWidth = 1.5 * px; c.setLineDash([4 * px, 3 * px]);
    if (sel?.kind === "view") {
      const v = D.views.find(x => x.id === sel.id);
      if (v && v.sheet === sheet.id) {
        const b = V().box(v, ctx); c.strokeRect(b[0] - 1, b[1] - 1, b[2] - b[0] + 2, b[3] - b[1] + 2); c.setLineDash([]);
        const h = 7 * px; c.fillRect(b[2] + 1 - h / 2, b[3] + 1 - h / 2, h, h);
      }
    } else if (sel?.kind === "dimension") {
      const m = D.dimensions.find(x => x.id === sel.id), r = m && m.sheet === sheet.id ? V().measure(m, ctx) : null;
      if (r) { c.setLineDash([]); c.lineWidth = 3 * px; c.globalAlpha = .45; c.beginPath(); for (const [p, q] of r.lines) { c.moveTo(p[0], p[1]); c.lineTo(q[0], q[1]); } c.stroke(); }
    } else if (sel?.kind === "callout") {
      const cl = D.callouts.find(x => x.id === sel.id);
      if (cl && cl.sheet === sheet.id) { c.setLineDash([]); c.lineWidth = 2 * px; c.beginPath(); c.arc(cl.x, cl.y, 3.8, 0, Math.PI * 2); c.stroke(); }
    } else if (sel?.kind === "text" || sel?.kind === "line") {
      const b = sheetOfObject(D, sel.kind, sel.id) === sheet.id ? objectBox(ctx, sel.kind, sel.id) : null;
      if (b) c.strokeRect(b[0] - .8, b[1] - .8, b[2] - b[0] + 1.6, b[3] - b[1] + 1.6);
      const l = sel.kind === "line" && D.lines.find(x => x.id === sel.id);
      if (l && l.sheet === sheet.id) { c.setLineDash([]); const h = 6 * px; for (const q of l.points) c.fillRect(q[0] - h / 2, q[1] - h / 2, h, h); }
    }
    c.setLineDash([]);
    // A placed object settles in: a ring that fades (AtriumMotion; nothing under Animations: Off).
    const f = state.flash;
    if (f && sheetOfObject(D, f.kind, f.id) === sheet.id) {
      const b = objectBox(ctx, f.kind, f.id), grow = (1 - f.a) * 2.5;
      if (b) { c.save(); c.globalAlpha = Math.max(0, f.a) * .8; c.lineWidth = 2.5 * px; c.strokeRect(b[0] - 1.5 - grow, b[1] - 1.5 - grow, b[2] - b[0] + 3 + grow * 2, b[3] - b[1] + 3 + grow * 2); c.restore(); }
    }
    // Tool feedback: the snap under the pointer and the pending object.
    if (state.tool && state.hover?.sheet === sheet.id) {
      const h = state.hover, P = state.pending;
      if (h.snap) { c.lineWidth = 1.5 * px; c.beginPath(); c.arc(h.snap.q[0], h.snap.q[1], 6 * px, 0, Math.PI * 2); c.stroke(); c.font = V().font(11 * px); c.fillText(h.snap.label, h.snap.q[0] + 8 * px, h.snap.q[1] - 8 * px); }
      if (P?.preview) { try { V().paintDimension(c, P.preview, ctx, {...env, ink: env.sel, dim: env.sel}); } catch { /* incomplete */ } }
      try { paintToolPreview(c, ctx, sheet, env, h, P); } catch { /* incomplete */ }
    }
    c.restore();
  }
  // Previews of the pointer tools: section cutting line, detail circle, break range, line, text spot.
  function paintToolPreview(c, ctx, sheet, env, h, P) {
    const px = env.px, T = state.tool;
    c.lineWidth = 1.5 * px;
    const v = P?.view && ctx.drawing.views.find(x => x.id === P.view), F = v && v.sheet === sheet.id ? V().frame(v, ctx.geometry(v), ctx) : null;
    if (T === "section" && F && P.points.length === 1) {
      const a = F.map(P.points[0]), b = F.map(P.ready ? P.points[1] : sectionEnd(P.points[0], F.unmap(h.p), h.alt));
      c.setLineDash([8 * px, 3 * px, 2 * px, 3 * px]); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
    }
    if (T === "section" && P?.ready && F) {
      const a = F.map(P.points[0]), b = F.map(P.points[1]);
      c.setLineDash([8 * px, 3 * px, 2 * px, 3 * px]); c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(b[0], b[1]); c.stroke(); c.setLineDash([]);
    }
    if (T === "section" && P?.ready) { c.setLineDash([4 * px, 3 * px]); c.strokeRect(h.p[0], h.p[1], 30, 10); c.setLineDash([]); }
    if (T === "detail" && F && P.points.length) {
      const q = F.map(P.points[0]), r = P.radius ? P.radius * F.s : Math.hypot(h.p[0] - q[0], h.p[1] - q[1]);
      c.beginPath(); c.arc(q[0], q[1], Math.max(px * 4, r), 0, Math.PI * 2); c.stroke();
      if (P.radius) { const k = detailScale(v) / F.s; c.setLineDash([4 * px, 3 * px]); c.beginPath(); c.arc(h.p[0], h.p[1], r * k, 0, Math.PI * 2); c.stroke(); c.setLineDash([]); }
    }
    if (T === "break" && F && P.points.length === 1) {
      const a = F.map(P.points[0]), b = h.p, vert = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]), bx = V().box(v, ctx);
      c.save(); c.globalAlpha = .18; c.fillStyle = env.sel;
      if (vert) c.fillRect(Math.min(a[0], b[0]), bx[1], Math.abs(b[0] - a[0]), bx[3] - bx[1]); else c.fillRect(bx[0], Math.min(a[1], b[1]), bx[2] - bx[0], Math.abs(b[1] - a[1]));
      c.restore();
    }
    if (T === "line" && P?.points.length && P.sheet === sheet.id) {
      const end = lineEnd(P.points.at(-1), h.p, h.shift, h.alt);
      c.beginPath(); P.points.forEach((q, i) => i ? c.lineTo(q[0], q[1]) : c.moveTo(q[0], q[1])); c.lineTo(end[0], end[1]); c.stroke();
    }
    if (T === "text") { c.beginPath(); c.moveTo(h.p[0] - 2, h.p[1]); c.lineTo(h.p[0] + 2, h.p[1]); c.moveTo(h.p[0], h.p[1] - 2); c.lineTo(h.p[0], h.p[1] + 2); c.stroke(); }
  }
  // Section lines are horizontal or vertical on the board unless Alt is held.
  function sectionEnd(a, b, free) {
    if (free) return b;
    return Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? [b[0], a[1]] : [a[0], b[1]];
  }
  // Line points snap to 0.5 mm on the sheet (Alt: free); Shift keeps 45° steps.
  function lineEnd(prev, p, shift, alt) {
    let q = alt ? p.slice() : [Math.round(p[0] * 2) / 2, Math.round(p[1] * 2) / 2];
    if (shift && prev) {
      const dx = q[0] - prev[0], dy = q[1] - prev[1], L = Math.hypot(dx, dy), a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
      q = [r4(prev[0] + Math.cos(a) * L), r4(prev[1] + Math.sin(a) * L)];
    }
    return q;
  }
  function flash(kind, id) {
    const M = globalThis.AtriumMotion;
    state.flash = null;
    if (!M?.animate || !M.enabled?.() || !id) return;
    const f = state.flash = {kind, id, a: 1};
    M.animate({duration: "slow", ease: "decelerate", step: e => { f.a = 1 - e; H?.redraw?.(); }, done: () => { if (state.flash === f) state.flash = null; H?.redraw?.(); }});
  }

  // ---------------------------------------------------------------- hit testing
  function segDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  }
  function hitTest(ctx, sheet, p, tol) {
    const D = ctx.drawing;
    for (const t of [...D.texts].reverse()) { if (t.sheet !== sheet.id) continue; const b = V().textBox(t); if (p[0] >= b[0] - tol && p[0] <= b[2] + tol && p[1] >= b[1] - tol && p[1] <= b[3] + tol) return {kind: "text", id: t.id}; }
    for (const l of [...D.lines].reverse()) { if (l.sheet !== sheet.id) continue; for (let i = 0; i + 1 < l.points.length; i++) if (segDist(p, l.points[i], l.points[i + 1]) <= tol) return {kind: "line", id: l.id}; }
    for (const cl of [...D.callouts].reverse()) if (cl.sheet === sheet.id && Math.hypot(p[0] - cl.x, p[1] - cl.y) <= 3.4 + tol) return {kind: "callout", id: cl.id};
    for (const m of [...D.dimensions].reverse()) {
      if (m.sheet !== sheet.id) continue;
      let r = null; try { r = V().measure(m, ctx); } catch { r = null; }
      if (!r) continue;
      if (r.lines.some(([a, b]) => segDist(p, a, b) <= tol) || r.texts.some(t => Math.hypot(p[0] - t.at[0], p[1] - t.at[1]) <= t.size * 1.6)) return {kind: "dimension", id: m.id};
    }
    for (const v of [...D.views].reverse()) {
      if (v.sheet !== sheet.id) continue;
      let b; try { b = V().box(v, ctx); } catch { continue; }
      if (state.sel?.id === v.id && Math.abs(p[0] - b[2] - 1) <= tol * 1.5 && Math.abs(p[1] - b[3] - 1) <= tol * 1.5) return {kind: "view", id: v.id, handle: true};
      if (p[0] >= b[0] - tol && p[0] <= b[2] + tol && p[1] >= b[1] - tol && p[1] <= b[3] + tol) return {kind: "view", id: v.id};
    }
    return null;
  }
  // Snap for the dimension and callout tools: features of the board, assembly or detail view
  // under the pointer (a detail snaps only inside its circle).
  function snapAt(ctx, sheet, p, tol, circle) {
    let best = null;
    for (const v of ctx.drawing.views) {
      if (v.sheet !== sheet.id || !V().FRAMED.has(v.type)) continue;
      let b; try { b = V().box(v, ctx); } catch { continue; }
      if (p[0] < b[0] - 10 || p[0] > b[2] + 10 || p[1] < b[1] - 10 || p[1] > b[3] + 10) continue;
      const G = ctx.geometry(v), F = V().frame(v, G, ctx), round = v.type === "detail" ? [v.x + v.radius * F.s, v.y + v.radius * F.s, v.radius * F.s] : null;
      for (const s of V().snaps(G, circle ? "circle" : "point", F.src)) {
        const q = F.map(s.p);
        if (round && Math.hypot(q[0] - round[0], q[1] - round[1]) > round[2]) continue;
        const d = Math.hypot(q[0] - p[0], q[1] - p[1]) - (circle && s.r ? Math.min(s.r * F.s, tol) : 0);
        if (d <= tol && (!best || d < best.d)) best = {d, view: v.id, a: {...s.a, at: s.p}, q, label: s.label};
      }
    }
    return best;
  }
  // The board or assembly view under a sheet point (section, detail and break tools).
  function boardViewAt(ctx, sheet, p) {
    for (const v of [...ctx.drawing.views].reverse()) {
      if (v.sheet !== sheet.id || !V().BOARD_TYPES.has(v.type)) continue;
      const G = ctx.geometry(v), F = V().frame(v, G, ctx);
      if (p[0] >= v.x - 2 && p[0] <= v.x + F.w + 2 && p[1] >= v.y - 2 && p[1] <= v.y + F.h + 2) return {v, F};
    }
    return null;
  }

  // ---------------------------------------------------------------- editing
  function edit(fn, message) {
    const id = liveDoc()?.id;
    if (!id) return;
    try {
      H.edit(() => {
        const d = H.project().documents.find(x => x.id === id);
        d.drawing = drawingData(d);
        fn(d);
        d.drawing = normalize(d.drawing);
        syncSheet(d);
      });
      if (message) H.info(message);
    } catch (e) { H.info(e.message || String(e)); }
    refreshInspector();
  }
  // Runs operations as one undo step; returns their results (null when refused).
  function run(ops, message) {
    let out = null;
    edit(d => { out = apply(H.project(), d, ops); }, message);
    return out;
  }
  // Placing something: run, select it, let it settle in.
  function place(kind, ops, message) {
    const r = run(ops, message), id = r?.at(-1)?.id;
    if (id) { state.sel = {kind, id}; flash(kind, id); refreshInspector(); }
    return id;
  }
  function refreshInspector() { try { H?.select?.([]); } catch { /* host gone */ } H?.redraw?.(); }
  const TOOLS = {
    "drawing-dim-linear": ["linear", "Linear dimension: click the first feature, then the second, then where the dimension line goes. Escape cancels.", "Linear dimension"],
    "drawing-dim-radial": ["radial", "Radial dimension: click a hole or an arc, then where the label goes.", "Radial dimension"],
    "drawing-dim-ordinate": ["ordinate", "Ordinate dimensions: click the origin feature, then each feature; press Enter (or double-click) to place them.", "Ordinate dimensions"],
    "drawing-callout": ["callout", "Note callout: click the feature to point at, then where the balloon goes.", "Note callout"],
    "drawing-section": ["section", "Section view: click the start of the cutting line on a board or assembly view, then its end (Alt: any angle), then where the section goes.", "Section view"],
    "drawing-detail": ["detail", "Detail view: click the centre of the area to magnify, then its edge, then where the detail goes.", "Detail view"],
    "drawing-break": ["break", "Break lines: click where the part of a board view to leave out starts, then where it ends.", "Break lines"],
    "drawing-text": ["text", "Text: click where the text goes.", "Text"],
    "drawing-line": ["line", "Line: click each point; double-click or press Enter to finish (Shift: 45° steps, Alt: off the 0.5 mm grid). Escape cancels.", "Line"]
  };
  const ACTION_OF = Object.fromEntries(Object.entries(TOOLS).map(([a, t]) => [t[0], a]));
  function setTool(tool, message) {
    state.tool = tool; state.pending = tool ? {points: []} : null; state.hover = null;
    if (message) H.info(message);
    shell();
    H.redraw?.();
  }
  function startTool(action) {
    const d = liveDoc();
    if (!d) { H.info("Open a drawing first: Project › Add New Drawing…"); return; }
    const t = TOOLS[action];
    if (t[0] === "callout" && !d.drawing.notes.length) { H.info("Add a note first (Properties › Notes)."); return; }
    if (["section", "detail", "break"].includes(t[0]) && !d.drawing.views.some(v => V().BOARD_TYPES.has(v.type))) { H.info("Add a board or assembly view first (Place › Drawing View…)."); return; }
    setTool(t[0], t[1]);
  }
  function pointerSheet(e) {
    const c = H.canvas(), v = H.view(), r = c.getBoundingClientRect(), w = v.screenToWorld([e.clientX - r.left, e.clientY - r.top]);
    const d = liveDoc(), at = d && locate(d.drawing, w);
    return at ? {...at, tol: Math.max(.8, 6 / (v.scale() || 1))} : null;
  }
  function toolClick(at, e) {
    const ctx = ctxNow(), T = state.tool, P = state.pending;
    const snap = ["linear", "radial", "ordinate", "callout"].includes(T) ? snapAt(ctx, at.sheet, at.p, at.tol * 1.5, T === "radial" && !P.points.length) : null;
    const sheetId = at.sheet.id;
    if (T === "linear") {
      if (P.points.length < 2) {
        if (!snap) { H.info("Click a board feature: a corner, vertex, hole or arc centre."); return; }
        if (P.points.length && P.view !== snap.view) { H.info("Both ends of a dimension must be in the same view."); return; }
        P.view = snap.view; P.points.push(snap.a);
        if (P.points.length === 2) H.info("Click where the dimension line goes. Hold Shift for a vertical dimension, Alt for aligned.");
        return;
      }
      commitLinear(at, e); return;
    }
    if (T === "radial") {
      if (!P.points.length) { if (!snap) { H.info("Click a hole or an arc."); return; } P.view = snap.view; P.points.push(snap.a); H.info("Click where the label goes."); return; }
      const m = previewRadial(ctx, at.p);
      place("dimension", [{op: "add_dimension", view: P.view, type: "radial", a: P.points[0], angle: m.angle, offset: m.offset}], "Radial dimension placed.");
      setTool(null); return;
    }
    if (T === "ordinate") {
      if (P.ready) { commitOrdinate(at); return; }
      if (!snap) { H.info("Click a board feature."); return; }
      if (P.points.length && P.view !== snap.view) { H.info("Ordinate points must be in the same view."); return; }
      P.view = snap.view; P.points.push(snap.a);
      H.info(P.points.length === 1 ? "Origin set. Click each feature, then press Enter." : P.points.length - 1 + " point(s). Press Enter to place them.");
      if (e.detail >= 2 && P.points.length > 1) { P.ready = true; H.info("Click where the ordinate line goes (above the view for X, left of it for Y; Shift for Y)."); }
      return;
    }
    if (T === "callout") {
      if (!P.points.length) { P.points.push(snap ? {view: snap.view, at: snap.a} : {point: at.p}); P.sheet = sheetId; H.info("Click where the balloon goes."); return; }
      const t = P.points[0], notes = liveDoc().drawing.notes, n = P.note || notes.length;
      place("callout", [{op: "add_callout", note: n, sheet: P.sheet, ...(t.view ? {view: t.view, at: t.at} : {point: t.point}), x: at.p[0], y: at.p[1]}], "Callout for note " + n + " placed.");
      setTool(null); return;
    }
    if (T === "section" || T === "detail" || T === "break") {
      const hit = P.view ? null : boardViewAt(ctx, at.sheet, at.p);
      const v = P.view ? ctx.drawing.views.find(x => x.id === P.view) : hit?.v;
      if (!v) { H.info("Click inside a board or assembly view."); return; }
      const F = V().frame(v, ctx.geometry(v), ctx);
      if (!P.view) { P.view = v.id; P.sheet = v.sheet; }
      const bp = F.unmap(at.p).map(r4);
      if (T === "section") {
        if (!P.points.length) { P.points.push(bp); H.info("Click the end of the cutting line (Alt: any angle)."); return; }
        if (!P.ready) { const b = sectionEnd(P.points[0], bp, e.altKey).map(r4); if (Math.hypot(b[0] - P.points[0][0], b[1] - P.points[0][1]) < .2) { H.info("Click farther from the start."); return; } P.points.push(b); P.ready = true; H.info("Click where the section view goes (its top-left corner)."); return; }
        place("view", [{op: "add_view", type: "section", parent: P.view, a: P.points[0], b: P.points[1], sheet: sheetId, x: r4(at.p[0]), y: r4(at.p[1])}], "Section view placed.");
        setTool(null); return;
      }
      if (T === "detail") {
        if (!P.points.length) { P.points.push(bp); H.info("Click the edge of the area to magnify."); return; }
        if (!P.radius) { const c0 = F.map(P.points[0]), r = Math.hypot(at.p[0] - c0[0], at.p[1] - c0[1]) / F.s; if (r < .2) { H.info("Click farther from the centre."); return; } P.radius = r4(r); H.info("Click where the detail view goes (its centre)."); return; }
        const s = detailScale(v), R = P.radius * s;
        place("view", [{op: "add_view", type: "detail", parent: P.view, center: P.points[0], radius: P.radius, scale: s, sheet: sheetId, x: r4(at.p[0] - R), y: r4(at.p[1] - R)}], "Detail view placed.");
        setTool(null); return;
      }
      if (!P.points.length) { P.points.push(bp); H.info("Click where the left-out part ends."); return; }
      const a = P.points[0], dx = Math.abs(at.p[0] - F.map(a)[0]), dy = Math.abs(at.p[1] - F.map(a)[1]), axis = dx >= dy ? "x" : "y", k = axis === "x" ? 0 : 1;
      run([{op: "add_break", view: P.view, axis, from: Math.min(a[k], bp[k]), to: Math.max(a[k], bp[k])}], "Break lines added: dimensions across them keep the true length.");
      state.sel = {kind: "view", id: P.view}; flash("view", P.view);
      setTool(null); return;
    }
    if (T === "text") { const p = at.p.map(v => Math.round(v * 2) / 2); setTool(null); textDialog(H, {sheet: sheetId, x: p[0], y: p[1]}); return; }
    if (T === "line") {
      const q = lineEnd(P.points.at(-1), at.p, e.shiftKey, e.altKey);
      if (P.points.length && P.sheet !== sheetId) { H.info("A line stays on one sheet."); return; }
      P.sheet = sheetId;
      const last = P.points.at(-1);
      if (!last || Math.hypot(q[0] - last[0], q[1] - last[1]) > 1e-6) P.points.push(q);
      if (e.detail >= 2 && P.points.length >= 2) { commitLine(); return; }
      H.info(P.points.length < 2 ? "Click the next point." : P.points.length + " points. Double-click or press Enter to finish.");
    }
  }
  function commitLine() {
    const P = state.pending;
    if (P?.points.length >= 2) place("line", [{op: "add_line", sheet: P.sheet, points: P.points, weight: P.weight || "medium"}], "Line placed.");
    setTool(null);
  }
  function previewRadial(ctx, p) {
    const P = state.pending, v = ctx.drawing.views.find(x => x.id === P.view), G = ctx.geometry(v), R = V().resolve(P.points[0], G), c = V().frame(v, G, ctx).map(R.p);
    const ang = Math.atan2(-(p[1] - c[1]), p[0] - c[0]) * 180 / Math.PI, off = Math.max(2, Math.hypot(p[0] - c[0], p[1] - c[1]) - (R.r || 0) * v.scale);
    return {angle: r4(ang), offset: r4(off)};
  }
  function linearOf(ctx, at, e) {
    const P = state.pending, v = ctx.drawing.views.find(x => x.id === P.view), G = ctx.geometry(v), F = V().frame(v, G, ctx);
    const a = F.map(V().resolve(P.points[0], G).p), b = F.map(V().resolve(P.points[1], G).p);
    const axis = e?.altKey ? "aligned" : e?.shiftKey || Math.abs(b[0] - a[0]) < 1e-6 ? "y" : "x";
    let offset;
    if (axis === "x") offset = at.p[1] - Math.min(a[1], b[1]);
    else if (axis === "y") offset = at.p[0] - Math.min(a[0], b[0]);
    else { const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1, n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L]; offset = (at.p[0] - a[0]) * n[0] + (at.p[1] - a[1]) * n[1]; }
    return {axis, offset: r4(offset)};
  }
  function commitLinear(at, e) {
    const P = state.pending, m = linearOf(ctxNow(), at, e);
    place("dimension", [{op: "add_dimension", view: P.view, type: "linear", a: P.points[0], b: P.points[1], axis: m.axis, offset: m.offset}], "Linear dimension placed.");
    setTool(null);
  }
  function commitOrdinate(at) {
    const P = state.pending, ctx = ctxNow(), v = ctx.drawing.views.find(x => x.id === P.view), b = V().box(v, ctx);
    const axis = at.p[1] < b[1] ? "x" : at.p[0] < b[0] ? "y" : "x", offset = axis === "x" ? b[1] - at.p[1] : b[0] - at.p[0];
    place("dimension", [{op: "add_dimension", view: P.view, type: "ordinate", a: P.points[0], points: P.points.slice(1), axis, offset: r4(Math.max(2, offset))}], "Ordinate dimensions placed.");
    setTool(null);
  }
  function hover(at, e) {
    if (!state.tool || !at) { state.hover = null; return; }
    const ctx = ctxNow(), P = state.pending;
    const snap = ["linear", "radial", "ordinate", "callout"].includes(state.tool) ? snapAt(ctx, at.sheet, at.p, at.tol * 1.5, state.tool === "radial" && !P.points.length) : null;
    state.hover = {sheet: at.sheet.id, snap, p: at.p, shift: !!e?.shiftKey, alt: !!e?.altKey};
    P.preview = null;
    try {
      if (state.tool === "linear" && P.points.length === 2) { const m = linearOf(ctx, at, e); P.preview = {id: "_", sheet: at.sheet.id, view: P.view, type: "linear", a: P.points[0], b: P.points[1], ...m}; }
      if (state.tool === "radial" && P.points.length === 1) P.preview = {id: "_", sheet: at.sheet.id, view: P.view, type: "radial", kind: "diameter", a: P.points[0], ...previewRadial(ctx, at.p)};
    } catch { P.preview = null; }
  }
  const drawingLists={view:"views",dimension:"dimensions",callout:"callouts",text:"texts",line:"lines"};
  const listOf=(D,kind)=>D[drawingLists[kind]]||[];
  function selectionEntries(D, ids) {
    if (!ids.length) return [];
    const wanted = new Set(ids), byId = new Map();
    for (const kind of Object.keys(drawingLists)) for (const item of listOf(D,kind))
      if (wanted.has(item.id)) byId.set(item.id,{id:item.id,kind});
    return ids.map(id => byId.get(id)).filter(Boolean);
  }
  function retainSelection(doc, ids) {
    const selection = selectionEntries(drawingData(doc),ids).map(item => item.id), selected = new Set(selection);
    return {selection, missingSelection:ids.filter(id => !selected.has(id))};
  }
  function selectIds(doc, ids) {
    if (liveDoc()?.id !== doc.id) return;
    state.sel = selectionEntries(drawingData(doc),ids)[0] ?? null;
    refreshInspector();
  }
  function inputAt(point,scale) {
    const d=liveDoc();if(!d)return null;
    const D=d.drawing,ctx=ctxNow(),at=point&&locate(D,point);
    const item=point?(at&&hitTest(ctx,at.sheet,at.p,Math.max(.8,6/scale))):state.sel;
    const tool=state.tool&&"drawing-"+state.tool;
    if(!item)return {tool};
    const sheetId=sheetOfObject(D,item.kind,item.id);
    const origin=sheetOrigins(D)[D.sheets.findIndex(s=>s.id===sheetId)];
    const box=origin&&objectBox(ctx,item.kind,item.id)?.map((n,i)=>n+origin[i%2]);
    return {tool,item,box,label:"Drawing "+item.kind,pick(){state.sel={id:item.id,kind:item.kind};refreshInspector();}};
  }
  function onDown(e) {
    if (!H || e.button !== 0 || !liveDoc() || e.target !== H.canvas?.()) return;
    const at = pointerSheet(e);
    if (state.tool) { e.preventDefault(); e.stopPropagation(); if (at) toolClick(at, e); H.redraw(); return; }
    if (!at) { if (state.sel) { state.sel = null; refreshInspector(); } return; }
    const ctx = ctxNow(), hit = hitTest(ctx, at.sheet, at.p, at.tol);
    if (!hit) { if (state.sel) { state.sel = null; refreshInspector(); } return; }
    e.preventDefault(); e.stopPropagation();
    state.sel = {kind: hit.kind, id: hit.id};
    const D = ctx.drawing, obj = listOf(D, hit.kind).find(v => v.id === hit.id);
    state.drag = {hit, pointerId:e.pointerId, start: at.p, sheet: at.sheet.id, orig:obj, box: hit.kind === "view" ? V().box(obj, ctx) : null};
    try { H.canvas().setPointerCapture(e.pointerId); } catch { /* synthetic */ }
    refreshInspector();
  }
  function dragTo(at, e) {
    const g = state.drag, d = liveDoc();
    if (!g || !d || !at || at.sheet.id !== g.sheet) return;
    const dx = at.p[0] - g.start[0], dy = at.p[1] - g.start[1];
    if (!g.preview) {
      if(Math.hypot(dx,dy)<at.tol*.5)return;
      // Drawing views read this transient document. Only release changes the authored geometry.
      const list=drawingLists[g.hit.kind];
      g.preview={...g.orig};
      g.previewDoc={...d,drawing:{...d.drawing,[list]:d.drawing[list].map(o=>o.id===g.hit.id?g.preview:o)}};
    }
    const snap = v => e.altKey ? r4(v) : Math.round(v);
    if (g.hit.kind === "view") {
      const v = g.preview;
      if (g.hit.handle) {
        const b = g.box, w0 = b[2] - b[0], h0 = b[3] - b[1], k = Math.max(.05, Math.max((w0 + dx) / w0, (h0 + dy) / h0));
        const raw = g.orig.scale * k;
        v.scale = (V().BOARD_TYPES.has(v.type) || V().LINKED.has(v.type)) && !e.altKey ? V().SCALES.reduce((a, s) => Math.abs(Math.log(s / raw)) < Math.abs(Math.log(a / raw)) ? s : a) : r4(Math.round(raw * 20) / 20 || .05);
      } else { v.x = snap(g.orig.x + dx); v.y = snap(g.orig.y + dy); }
    } else if (g.hit.kind === "callout") {
      g.preview.x=snap(g.orig.x+dx);g.preview.y=snap(g.orig.y+dy);
    } else if (g.hit.kind === "text") {
      const half=v=>e.altKey?r4(v):Math.round(v*2)/2;
      g.preview.x=half(g.orig.x+dx);g.preview.y=half(g.orig.y+dy);
    } else if (g.hit.kind === "line") {
      const ox=e.altKey?dx:Math.round(dx*2)/2,oy=e.altKey?dy:Math.round(dy*2)/2;
      g.preview.points=g.orig.points.map(q=>[r4(q[0]+ox),r4(q[1]+oy)]);
    } else {
      const m=g.preview;
      if (m.type === "radial") { m.angle = r4(g.orig.angle + 0); const ctx = ctxNow(); state.pending = {view: m.view, points: [m.a]}; Object.assign(m, previewRadial(ctx, at.p)); state.pending = null; }
      else if (m.type === "linear" && m.axis === "y") m.offset = r4(g.orig.offset + dx);
      else if (m.type === "ordinate") m.offset = r4(g.orig.offset - (m.axis === "y" ? dx : dy));
      else m.offset = r4(g.orig.offset + (m.axis === "aligned" ? Math.hypot(dx, dy) * Math.sign(dy || dx) : dy));
    }
    cache.memo.clear();
    H.redraw();
  }
  function endDrag(cancelled=false) {
    const g = state.drag; state.drag = null;
    if (!g?.preview) return;
    cache.memo.clear();
    if(cancelled){H.redraw();return;}
    const doc=liveDoc(),list=drawingLists[g.hit.kind];
    if(doc?.drawing[list].some(o=>o.id===g.hit.id))edit(d=>{
      d.drawing={...d.drawing,[list]:d.drawing[list].map(o=>o.id===g.hit.id?g.preview:o)};
    });
  }
  function removeSelection() {
    const s = state.sel; if (!s) return false;
    state.sel = null;
    run([{op: "remove", id: s.id}], "Removed the " + s.kind + ".");
    return true;
  }
  function onKey(e) {
    if (!H || !liveDoc() || e.target !== H.canvas?.()) return;
    if (e.key === "Escape" && (state.tool || state.sel)) { e.preventDefault(); e.stopPropagation(); if (state.tool) setTool(null, "Ready"); else { state.sel = null; refreshInspector(); } return; }
    if (e.key === "Enter" && state.tool === "ordinate" && state.pending?.points.length > 1) { e.preventDefault(); e.stopPropagation(); state.pending.ready = true; H.info("Click where the ordinate line goes (above the view for X, left of it for Y)."); return; }
    if (e.key === "Enter" && state.tool === "line" && state.pending?.points.length >= 2) { e.preventDefault(); e.stopPropagation(); commitLine(); return; }
    if (e.key === "Backspace" && state.tool === "line" && state.pending?.points.length) { e.preventDefault(); e.stopPropagation(); state.pending.points.pop(); H.redraw(); return; }
    if ((e.key === "Delete" || e.key === "Backspace") && state.sel && !state.tool) { e.preventDefault(); e.stopPropagation(); removeSelection(); }
  }

  // ---------------------------------------------------------------- dialogs
  function el(tag, txt, cls) { return AtriumNavCommon.el(tag, txt, cls); }
  function button(txt, fn, cls) {
    const b = el("button", txt, cls); b.type = "button"; b.onclick = fn;
    return globalThis.AtriumUI?.button(b, cls === "drawing-remove" ? "danger" : "secondary") ?? b;
  }
  // A library warning notice (.ui-notice): a status dot and the message, on the warning tint.
  function notice(text) { const n = el("div", null, "ui-notice drawing-warning"), body = el("div", text, "ui-notice-text"), dot = el("span", null, "ui-dot"); n.dataset.tone = dot.dataset.tone = "warning"; n.append(dot, body); return n; }
  function selectOf(values, value, label) { const s = el("select", null, "ui-field"); for (const [v, t] of values) s.add(new Option(t, v)); s.value = value; if (label) s.setAttribute("aria-label", label); return s; }
  function labelled(label, control, cls = "drawing-row") { const l = el("label", null, cls); l.append(el("span", label), control); return l; }
  function modal(title, build, onOk, okText = "Add") {
    const d = el("dialog", null, "work-dialog drawing-dialog"); d.setAttribute("aria-label", title);
    const form = el("form", null, "work-form drawing-form"); form.method = "dialog";
    const status = el("p", null, "drawing-status"); status.setAttribute("role", "status");
    const ok = el("button", okText, "is-primary"); ok.type = "submit";
    const cancel = button("Cancel", () => d.close(), "");
    const actions = el("div", null, "work-actions"); actions.append(cancel, ok);
    const get = build(form);
    form.append(status, actions);
    d.append(el("h2", title), form);
    form.onsubmit = ev => { ev.preventDefault(); try { onOk(get()); d.close(); } catch (e) { status.textContent = e.message || String(e); } };
    d.addEventListener("close", () => d.remove());
    const initialFocus = form.querySelector("textarea, input, select");
    globalThis.AtriumShell?.adoptDialog?.(d, {title:d.firstElementChild, body:form, actions, initialFocus});
    document.body.append(d); d.showModal(); initialFocus?.focus();
    return d;
  }
  function addDrawing(host) {
    const p = host.project(), boards = boardsOf(p);
    modal("Add New Drawing", form => {
      const name = el("input"); name.value = uniqueName(p, "Drawing"); name.required = true;
      const board = selectOf(boards.length ? boards.map(b => [b.id, b.name]) : [["", "No board yet"]], boards[0]?.id || "", "Board");
      const preset = selectOf([["full", "Fabrication and assembly sheets"], ["fabrication", "Fabrication sheet"], ["assembly", "Assembly sheet"], ["empty", "Empty sheet"]], boards.length ? "full" : "empty", "Contents");
      const size = selectOf(Object.keys(V().SIZES).map(k => [k, k]), "A3", "Sheet size");
      form.append(labelled("Name", name), labelled("Board", board), labelled("Contents", preset), labelled("Sheet size", size),
        el("p", "Views, tables and dimensions read the board live: board edits flow into the drawing.", "drawing-hint"));
      return () => ({name: name.value, board: board.value || undefined, preset: preset.value, size: size.value});
    }, o => {
      if (host.project() !== p) return;
      const doc = create(p, {...o, date: new Date()});
      host.edit(() => { p.documents.push(doc); });
      host.selectDocument(doc.id);
      fitTo(doc);
      host.info(doc.name + " added: " + doc.drawing.sheets.length + " sheet" + (doc.drawing.sheets.length === 1 ? "" : "s") + ", " + doc.drawing.views.length + " views.");
    });
  }
  function fitTo(doc) {
    const b = fitBox(doc), N = globalThis.AtriumNavCommon, c = H?.canvas?.(), v = H?.view?.();
    if (!b || !N?.cameraFor || !c || !v) return;
    v.restoreCamera(N.cameraFor(b, c.clientWidth || 800, c.clientHeight || 600, v.camera(), {margin: .06}));
    H.redraw();
  }
  // Place › Drawing View… (every placed view type) and Place › Table… (tables only). Section and
  // detail views are drawn with their own tools: the dialog starts those.
  function addView(host, preset, tables) {
    const d = liveDoc();
    if (!d) { host.info("Open a drawing first: Project › Add New Drawing…"); return; }
    const types = tables ? TABLE_TYPES : VIEW_TYPES;
    modal(tables ? "Add Table" : "Add Drawing View", form => {
      const type = selectOf(types.map(t => [t, VIEW_LABELS[t] + (t === "section" || t === "detail" ? " (draw it on a board view)" : "")]), preset || types[0], tables ? "Table" : "View");
      const side = selectOf([["Top", "Top"], ["Bottom", "Bottom (mirrored)"]], "Top", "Side");
      const sheet = selectOf(d.drawing.sheets.map((s, i) => [s.id, (i + 1) + ". " + s.name]), currentSheetId(d), "Sheet");
      const sideRow = labelled("Side", side), sheetRow = labelled("Sheet", sheet);
      const sync = () => { sideRow.hidden = type.value !== "assembly"; sheetRow.hidden = type.value === "section" || type.value === "detail"; };
      type.onchange = sync; sync();
      form.append(labelled(tables ? "Table" : "View", type), sideRow, sheetRow, el("p", tables ? "The table is placed in a free spot and reads the board and the drawing live; drag it into place." :
        "The view is placed in a free spot; drag it into place and drag its corner handle to scale it.", "drawing-hint"));
      return () => ({type: type.value, side: side.value, sheet: sheet.value});
    }, o => {
      if (o.type === "section") { startTool("drawing-section"); return; }
      if (o.type === "detail") { startTool("drawing-detail"); return; }
      let id = null;
      edit(dd => { id = apply(H.project(), dd, [{op: "add_view", type: o.type, side: o.side, sheet: o.sheet}])[0].id; }, VIEW_LABELS[o.type] + " added.");
      if (id) { state.sel = {kind: "view", id}; flash("view", id); refreshInspector(); }
    });
  }
  // Text: the dialog after the click (or to edit a selected text).
  function textDialog(host, at, existing) {
    modal(existing ? "Edit Text" : "Place Text", form => {
      const t = el("textarea"); t.rows = 3; t.value = existing?.text || ""; t.required = true; t.setAttribute("aria-label", "Text");
      const size = selectOf([[1.8, "1.8 mm"], [2.5, "2.5 mm"], [3.5, "3.5 mm"], [5, "5 mm"], [7, "7 mm"], [10, "10 mm"]].map(([v, l]) => [String(v), l]), String(existing?.height || 2.5), "Height");
      const ang = selectOf([0, 90, 180, 270].map(v => [String(v), v + "°"]), String(existing?.angle || 0), "Angle");
      const bold = el("input"); bold.type = "checkbox"; bold.checked = !!existing?.bold; bold.setAttribute("aria-label", "Bold");
      const bl = el("label", null, "drawing-check"); bl.append(bold, el("span", "Bold"));
      form.append(labelled("Text", t), labelled("Height", size), labelled("Angle", ang), bl, el("p", "ISO 3098 lettering heights; Enter starts a new line.", "drawing-hint"));
      return () => ({text: t.value, height: +size.value, angle: +ang.value, bold: bold.checked});
    }, o => {
      if (!o.text.trim()) throw Error("Type the text first.");
      if (existing) run([{op: "set_text", id: existing.id, ...o}], "Text changed.");
      else place("text", [{op: "add_text", sheet: at.sheet, x: at.x, y: at.y, ...o}], "Text placed.");
    }, existing ? "Apply" : "Place");
  }
  function currentSheetId(d) {
    const sel = state.sel, D = d.drawing;
    const v = sel && listOf(D, sel.kind).find(x => x.id === sel.id);
    if (v?.sheet) return v.sheet;
    if (sel?.kind === "sheet") return sel.id;
    return D.sheets[0].id;
  }

  // ---------------------------------------------------------------- shell: Active Bar, tab, status
  // Drawings get their own Active Bar tools (index.html, data-scope="drawing"; style.css hides the
  // schematic and board ones), flyout groups, the drawing tab icon and the status-bar kind. All of
  // it is set here, from this lazy module, so nothing eager grows.
  const GROUPS = {
    "drawing-view": [["drawing-view", "Drawing View…"], ["drawing-section", "Section View"], ["drawing-detail", "Detail View"], ["drawing-break", "Break Lines"]],
    "drawing-dim-linear": [["drawing-dim-linear", "Linear Dimension"], ["drawing-dim-radial", "Radial Dimension"], ["drawing-dim-ordinate", "Ordinate Dimension"]],
    "drawing-text": [["drawing-text", "Text"], ["drawing-line", "Line"]]
  };
  const tr = globalThis.AtriumI18n?.define?.({"drawing.kind": "Drawing"});
  const kindWord = () => { try { return tr ? tr("drawing.kind") : "Drawing"; } catch { return "Drawing"; } };
  let shellBusy = false, lastKind = [0, 0];
  function shell() {
    if (!hasDOM() || shellBusy) return;
    shellBusy = true;
    try {
      const d = liveDoc();
      for (const tab of document.querySelectorAll('[data-kind="drawing"] use[href="#i-schematic"]')) tab.setAttribute("href", "#i-drawing");
      if (d) {
        // At most 8 rewrites a second, so another pass over the text (translation) can never ping-pong with it.
        const k = document.getElementById("doc-kind"), word = kindWord(), now = Date.now();
        if (now - lastKind[0] > 1000) lastKind = [now, 0];
        if (k && k.textContent !== word && lastKind[1]++ < 8) k.textContent = word;
        const tv = document.getElementById("tool-value"), label = state.tool ? TOOLS[ACTION_OF[state.tool]]?.[2] || "" : "";
        if (tv && label && tv.textContent !== label) { tv.textContent = label; tv.title = "Active tool · Escape returns to Select"; }
      }
      for (const b of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll('#tools .tool[data-scope="drawing"]'))) {
        const a = b.dataset.action, on = !!d && !!state.tool && ACTION_OF[state.tool] === a || (GROUPS[a] || []).some(([x]) => state.tool && ACTION_OF[state.tool] === x);
        if (b.getAttribute("aria-pressed") !== String(on)) b.setAttribute("aria-pressed", String(on));
      }
    } finally { shellBusy = false; }
  }

  // ---------------------------------------------------------------- inspector
  function inspect(panel, host) {
    H = H || host;
    const d = host.doc();
    if (d?.kind !== "drawing") return;
    const p = host.project(), D = normalize(drawingData(d)), ui = host.ui;
    const section = t => ui?.section ? ui.section(panel, t) : (() => { const s = el("section", null, "inspect-section"); s.append(el("h3", t)); panel.append(s); return s; })();
    panel.append(el("h2", d.name));
    let ctx = null;
    try { ctx = ctxNow(); } catch { ctx = null; }
    const sel = state.sel && kindOf(D, state.sel.id) ? state.sel : null;
    if (sel?.kind === "view") inspectView(section, D.views.find(v => v.id === sel.id), ctx);
    else if (sel?.kind === "dimension") inspectDimension(section, D.dimensions.find(v => v.id === sel.id), ctx);
    else if (sel?.kind === "callout") inspectCallout(section, D.callouts.find(v => v.id === sel.id), D);
    else if (sel?.kind === "text") inspectText(section, D.texts.find(v => v.id === sel.id));
    else if (sel?.kind === "line") inspectLine(section, D.lines.find(v => v.id === sel.id));
    // Drawing: board, sheets, add actions.
    const s1 = section("Drawing");
    const boards = boardsOf(p), board = selectOf(boards.length ? boards.map(b => [b.id, b.name]) : [["", "No board"]], boardOf(p, D, null)?.id || "", "Board");
    board.onchange = () => run([{op: "set_board", board: board.value}], "The drawing now shows " + boards.find(b => b.id === board.value)?.name + ".");
    s1.append(labelled("Board", board, "field-row"));
    const add = el("div", null, "drawing-actions");
    add.append(button("Add View…", () => addView(host)), button("Section", () => startTool("drawing-section")), button("Detail", () => startTool("drawing-detail")),
      button("Break", () => startTool("drawing-break")), button("Linear", () => startTool("drawing-dim-linear")), button("Radial", () => startTool("drawing-dim-radial")),
      button("Ordinate", () => startTool("drawing-dim-ordinate")), button("Callout", () => startTool("drawing-callout")), button("Table…", () => addView(host, null, true)),
      button("Text", () => startTool("drawing-text")), button("Line", () => startTool("drawing-line")),
      button("Export PDF…", () => host.act ? host.act("export-pdf") : null));
    s1.append(add);
    const s2 = section("Sheets");
    D.sheets.forEach((s, i) => {
      const row = el("div", null, "drawing-sheet");
      const name = el("input", null, "ui-field"); name.value = s.name; name.setAttribute("aria-label", "Sheet " + (i + 1) + " name");
      name.onchange = () => run([{op: "set_sheet", sheet: s.id, name: name.value}]);
      const size = selectOf(Object.keys(V().SIZES).map(k => [k, k]), s.size, "Sheet " + (i + 1) + " size");
      size.onchange = () => run([{op: "set_sheet", sheet: s.id, size: size.value}], "Sheet " + (i + 1) + " is now " + size.value + ".");
      const ori = selectOf([["landscape", "Landscape"], ["portrait", "Portrait"]], s.orientation, "Sheet " + (i + 1) + " orientation");
      ori.onchange = () => run([{op: "set_sheet", sheet: s.id, orientation: ori.value}]);
      const tb = el("input"); tb.type = "checkbox"; tb.checked = s.titleBlock; tb.setAttribute("aria-label", "Sheet " + (i + 1) + " title block");
      tb.onchange = () => run([{op: "set_sheet", sheet: s.id, title_block: tb.checked}]);
      const tbl = el("label", null, "drawing-check"); tbl.append(tb, el("span", "Title block"));
      row.append(el("strong", String(i + 1)), name, size, ori, tbl);
      if (D.sheets.length > 1) row.append(button("Remove", () => run([{op: "remove", id: s.id}], "Sheet removed."), "drawing-remove"));
      s2.append(row);
    });
    s2.append(button("Add Sheet", () => run([{op: "add_sheet"}], "Sheet added.")));
    // Notes (numbered; callouts point at them).
    const s3 = section("Notes");
    D.notes.forEach((n, i) => {
      const row = el("div", null, "drawing-note"), t = el("textarea", null, "ui-field"); t.value = n.text; t.rows = 2; t.setAttribute("aria-label", "Note " + (i + 1));
      t.onchange = () => run([{op: "set_note", id: n.id, text: t.value}]);
      row.append(el("strong", (i + 1) + "."), t, button("Callout", () => { startTool("drawing-callout"); if (state.pending) state.pending.note = i + 1; }), button("Remove", () => run([{op: "remove", id: n.id}], "Note removed."), "drawing-remove"));
      s3.append(row);
    });
    s3.append(button("Add Note", () => run([{op: "add_note", text: "New note."}], "Note added.")));
    // Revisions.
    const s4 = section("Revisions");
    D.revisions.forEach(r => {
      const row = el("div", null, "drawing-rev");
      const f = (k, w, label) => { const i = el("input", null, "ui-field"); i.value = r[k]; i.size = w; i.setAttribute("aria-label", label); i.onchange = () => edit(dd => { const x = dd.drawing.revisions.find(q => q.id === r.id); if (x) x[k] = i.value; }); return i; };
      row.append(f("rev", 3, "Revision"), f("date", 10, "Date"), f("description", 18, "Description"), f("by", 6, "By"), button("Remove", () => run([{op: "remove", id: r.id}]), "drawing-remove"));
      s4.append(row);
    });
    s4.append(button("Add Revision", () => {
      const last = D.revisions.at(-1)?.rev || "", next = /^[A-Y]$/.test(last) ? String.fromCharCode(last.charCodeAt(0) + 1) : /^\d+$/.test(last) ? String(+last + 1) : last ? last + "1" : "A";
      run([{op: "add_revision", rev: next, date: new Date().toISOString().slice(0, 10), description: "", by: ""}], "Revision " + next + " added.");
    }));
    // Title block values (drawing parameters win over project parameters).
    const s5 = section("Title Block");
    for (const [k, label] of [["Title", "Title"], ["DocumentNumber", "Drawing number"], ["DrawnBy", "Drawn by"], ["CheckedBy", "Checked by"], ["ApprovedBy", "Approved by"], ["CompanyName", "Company"]]) {
      const i = el("input"); i.value = D.parameters[k] || ""; i.placeholder = "From the project"; i.setAttribute("aria-label", label);
      i.onchange = () => run([{op: "set_parameters", parameters: {[k]: i.value}}]);
      s5.append(labelled(label, i, "field-row"));
    }
    if (ctx) {
      // Variant and board revision (from the variants and revisions modules) shown in the title block.
      try {
        const f = V().titleFields(ctx, 0), info = [f.variant ? "Variant: " + f.variant : "", f.revision ? "Revision: " + f.revision + (f.revisionStatus ? " (" + f.revisionStatus + ")" : "") : ""].filter(Boolean).join(" · ");
        if (info) s5.append(el("p", info, "drawing-hint"));
      } catch { /* no board */ }
      const probs = summary(p, d, {cache, revision: H.revision?.()}).problems;
      if (probs.length) { const s6 = section("Check"); for (const m of probs) s6.append(notice(m)); }
    }
  }
  function inspectView(section, v, ctx) {
    if (!v) return;
    const newer = !!V().newerView?.(v);
    const s = section(newer ? "View from a newer version" : VIEW_LABELS[v.type] + (v.side ? " · " + v.side : "") + (v.label ? " " + v.label : ""));
    if (newer) s.append(el("p", "A newer Waffle made this view. This version can't draw or edit it, and keeps it unchanged when you save. You can move it.", "drawing-hint"));
    const num = (label,value,step,set,unit="mm")=>{const i=el("input");i.type="number";i.dataset.numericUnit=unit; i.step = String(step); i.value = String(value); i.setAttribute("aria-label", label); i.onchange = () => { if (fin(+i.value)) set(+i.value); }; s.append(labelled(label, i, "field-row")); return i; };
    if (newer) { /* its scale means what the newer version says */ } else if (V().BOARD_TYPES.has(v.type) || V().LINKED.has(v.type)) {
      const sc = selectOf(V().SCALES.map(k => [String(k), V().ratio(k)]), String(V().SCALES.includes(v.scale) ? v.scale : 1), "Scale");
      if (!V().SCALES.includes(v.scale)) sc.add(new Option(V().ratio(v.scale), String(v.scale)), 0), sc.value = String(v.scale);
      sc.onchange = () => run([{op: "set_view", id: v.id, scale: +sc.value}], "Scale " + V().ratio(+sc.value) + ".");
      s.append(labelled("Scale", sc, "field-row"));
    } else num("Scale", v.scale, .05, k => run([{op: "set_view", id: v.id, scale: Math.max(.05, k)}]),"");
    num("X (mm)", v.x, 1, x => run([{op: "set_view", id: v.id, x}]));
    num("Y (mm)", v.y, 1, y => run([{op: "set_view", id: v.id, y}]));
    const D = ctx?.drawing;
    if (D && D.sheets.length > 1) {
      const sh = selectOf(D.sheets.map((x, i) => [x.id, (i + 1) + ". " + x.name]), v.sheet, "Sheet");
      sh.onchange = () => run([{op: "set_view", id: v.id, sheet: sh.value}]);
      s.append(labelled("Sheet", sh, "field-row"));
    }
    if (newer) { s.append(button("Remove View", () => removeSelection(), "drawing-remove")); return; }
    if (v.type === "assembly") {
      const side = selectOf([["Top", "Top"], ["Bottom", "Bottom (mirrored)"]], v.side, "Side");
      side.onchange = () => run([{op: "set_view", id: v.id, side: side.value}]);
      s.append(labelled("Side", side, "field-row"));
    }
    if (V().LINKED.has(v.type)) {
      const lab = el("input"); lab.value = v.label || ""; lab.maxLength = 3; lab.setAttribute("aria-label", "Letter");
      lab.onchange = () => run([{op: "set_view", id: v.id, label: lab.value}]);
      s.append(labelled("Letter", lab, "field-row"));
      const up = D?.views.find(x => x.id === v.parent);
      if (up) s.append(el("p", "Taken from the " + VIEW_LABELS[up.type].toLowerCase() + (up.side ? " (" + up.side.toLowerCase() + ")" : "") + "; it follows the board.", "drawing-hint"));
      if (v.type === "detail") num("Radius (mm)", v.radius, .5, r => run([{op: "set_view", id: v.id, radius: Math.max(.1, r)}]));
      if (v.type === "section") {
        const z = selectOf([1, 2, 3, 4, 5, 8, 10].map(k => [String(k), k === 1 ? "True scale" : "×" + k]), String(v.options?.zscale || 1), "Vertical scale");
        if (![1, 2, 3, 4, 5, 8, 10].includes(v.options?.zscale || 1)) z.add(new Option("×" + v.options.zscale, String(v.options.zscale)), 0), z.value = String(v.options.zscale);
        z.onchange = () => run([{op: "set_view", id: v.id, options: {zscale: +z.value}}]);
        s.append(labelled("Vertical scale", z, "field-row"));
      }
    }
    if (V().BOARD_TYPES.has(v.type)) {
      const br = v.options?.breaks || [];
      if (br.length) {
        s.append(el("p", br.length + " break" + (br.length === 1 ? "" : "s") + ": " + br.map(b => b.axis.toUpperCase() + " " + b.from.toFixed(1) + "–" + b.to.toFixed(1) + " mm").join(", "), "drawing-hint"));
        s.append(button("Remove Breaks", () => run([{op: "set_view", id: v.id, options: {breaks: []}}], "Break lines removed.")));
      }
      s.append(button("Add Break…", () => { state.sel = {kind: "view", id: v.id}; startTool("drawing-break"); if (state.pending) { state.pending.view = v.id; state.pending.sheet = v.sheet; } }));
    }
    const checks = {board: [["drillSymbols", "Drill symbols", true], ["caption", "Caption", true]], assembly: [["designators", "Designators", true], ["values", "Values", false], ["pads", "Pads", true], ["caption", "Caption", true]],
      isometric: [["caption", "Caption", true]], "layer-stack": [["overlay", "Overlay layers", false]], section: [["caption", "Caption", true]], detail: [["caption", "Caption", true]]}[v.type] || [];
    for (const [k, label, def] of checks) {
      const c = el("input"); c.type = "checkbox"; c.checked = v.options?.[k] ?? def; c.setAttribute("aria-label", label);
      c.onchange = () => run([{op: "set_view", id: v.id, options: {[k]: c.checked}}]);
      const l = el("label", null, "drawing-check"); l.append(c, el("span", label)); s.append(l);
    }
    if (v.type === "bom") num("Rows", v.options?.rows || 40, 1, n => run([{op: "set_view", id: v.id, options: {rows: n}}]),"ea");
    if (v.type === "notes") num("Width (mm)", v.options?.width || 130, 5, n => run([{op: "set_view", id: v.id, options: {width: n}}]));
    s.append(button("Remove View", () => removeSelection(), "drawing-remove"));
  }
  function inspectDimension(section, m, ctx) {
    if (!m) return;
    if (V().newerDimension?.(m)) { section("Dimension from a newer version").append(el("p", "A newer Waffle made this dimension. This version can't draw or edit it, and keeps it unchanged when you save.", "drawing-hint")); return; }
    const s = section(m.type[0].toUpperCase() + m.type.slice(1) + " dimension");
    let r = null; try { r = V().measure(m, ctx); } catch { r = null; }
    s.append(el("p", r ? "Value: " + (Array.isArray(r.value) ? r.value.map(v => v.toFixed(m.precision ?? 2)).join(", ") : (r.value ?? 0).toFixed(m.precision ?? 2)) + " mm" + (r.ok ? "" : " (feature gone: last position)") : "Its view or features are gone.", "drawing-hint"));
    const prec = selectOf([0, 1, 2, 3, 4].map(n => [String(n), n + " decimals"]), String(m.precision ?? 2), "Precision");
    prec.onchange = () => run([{op: "set_dimension", id: m.id, precision: +prec.value}]);
    s.append(labelled("Precision", prec, "field-row"));
    const t = el("input"); t.value = m.text || ""; t.placeholder = "<> is the value, e.g. <> ±0.1"; t.setAttribute("aria-label", "Text");
    t.onchange = () => run([{op: "set_dimension", id: m.id, text: t.value}]);
    s.append(labelled("Text", t, "field-row"));
    if (m.type === "radial") {
      const k = selectOf([["diameter", "Diameter (⌀)"], ["radius", "Radius (R)"]], m.kind, "Kind");
      k.onchange = () => run([{op: "set_dimension", id: m.id, kind: k.value}]);
      s.append(labelled("Kind", k, "field-row"));
    }
    s.append(button("Remove Dimension", () => removeSelection(), "drawing-remove"));
  }
  function inspectCallout(section, c, D) {
    if (!c) return;
    const s = section("Callout"), n = D.notes.findIndex(x => x.id === c.note);
    const note = selectOf(D.notes.map((x, i) => [x.id, (i + 1) + ". " + x.text.slice(0, 40)]), c.note, "Note");
    note.onchange = () => edit(dd => { const x = dd.drawing.callouts.find(q => q.id === c.id); if (x) x.note = note.value; });
    s.append(labelled("Note", note, "field-row"), el("p", n >= 0 ? D.notes[n].text : "", "drawing-hint"));
    s.append(button("Remove Callout", () => removeSelection(), "drawing-remove"));
  }
  function inspectText(section, t) {
    if (!t) return;
    const s = section("Text");
    const area = el("textarea"); area.value = t.text; area.rows = 3; area.setAttribute("aria-label", "Text");
    area.onchange = () => { if (area.value.trim()) run([{op: "set_text", id: t.id, text: area.value}]); };
    s.append(labelled("Text", area, "field-row"));
    const size = selectOf([1.8, 2.5, 3.5, 5, 7, 10].map(v => [String(v), v + " mm"]), String(t.height || 2.5), "Height");
    if (![1.8, 2.5, 3.5, 5, 7, 10].includes(t.height || 2.5)) size.add(new Option(t.height + " mm", String(t.height)), 0), size.value = String(t.height);
    size.onchange = () => run([{op: "set_text", id: t.id, height: +size.value}]);
    const ang = selectOf([0, 90, 180, 270].map(v => [String(v), v + "°"]), String(t.angle || 0), "Angle");
    if (![0, 90, 180, 270].includes(t.angle || 0)) ang.add(new Option(t.angle + "°", String(t.angle)), 0), ang.value = String(t.angle);
    ang.onchange = () => run([{op: "set_text", id: t.id, angle: +ang.value}]);
    const bold = el("input"); bold.type = "checkbox"; bold.checked = !!t.bold; bold.setAttribute("aria-label", "Bold");
    bold.onchange = () => run([{op: "set_text", id: t.id, bold: bold.checked}]);
    const bl = el("label", null, "drawing-check"); bl.append(bold, el("span", "Bold"));
    s.append(labelled("Height", size, "field-row"), labelled("Angle", ang, "field-row"), bl, button("Remove Text", () => removeSelection(), "drawing-remove"));
  }
  function inspectLine(section, l) {
    if (!l) return;
    const s = section("Line");
    const w = selectOf(WEIGHTS.map(k => [k, k[0].toUpperCase() + k.slice(1) + " (" + V().WEIGHTS[k] + " mm)"]), l.weight, "Weight");
    w.onchange = () => run([{op: "set_line", id: l.id, weight: w.value}]);
    const st = selectOf(STYLES.map(k => [k, k[0].toUpperCase() + k.slice(1)]), l.style, "Style");
    st.onchange = () => run([{op: "set_line", id: l.id, style: st.value}]);
    s.append(labelled("Weight", w, "field-row"), labelled("Style", st, "field-row"), el("p", l.points.length + " points", "drawing-hint"), button("Remove Line", () => removeSelection(), "drawing-remove"));
  }

  // ---------------------------------------------------------------- install
  function install() {
    const N = globalThis.AtriumNavCommon;
    N?.menuItem?.("place", "drawing-view", "Drawing View…", {scope: "drawing"});
    N?.menuItem?.("place", "drawing-section", "Section View", {scope: "drawing", after: "drawing-view"});
    N?.menuItem?.("place", "drawing-detail", "Detail View", {scope: "drawing", after: "drawing-section"});
    N?.menuItem?.("place", "drawing-break", "Break Lines", {scope: "drawing", after: "drawing-detail"});
    N?.menuItem?.("place", "drawing-dim-linear", "Linear Dimension", {scope: "drawing", after: "drawing-break"});
    N?.menuItem?.("place", "drawing-dim-radial", "Radial Dimension", {scope: "drawing", after: "drawing-dim-linear"});
    N?.menuItem?.("place", "drawing-dim-ordinate", "Ordinate Dimension", {scope: "drawing", after: "drawing-dim-radial"});
    N?.menuItem?.("place", "drawing-callout", "Note Callout", {scope: "drawing", after: "drawing-dim-ordinate"});
    N?.menuItem?.("place", "drawing-table", "Table…", {scope: "drawing", after: "drawing-callout"});
    N?.menuItem?.("place", "drawing-text", "Text", {scope: "drawing", after: "drawing-table"});
    N?.menuItem?.("place", "drawing-line", "Line", {scope: "drawing", after: "drawing-text"});
    N?.menuItem?.("place", "drawing-sheet", "Drawing Sheet", {scope: "drawing", after: "drawing-line"});
    N?.ready?.(host => {
      H = host;
      host.registerAction("add-drawing", () => addDrawing(host));
      host.registerAction("drawing-view", () => addView(host));
      host.registerAction("drawing-table", () => addView(host, null, true));
      for (const a of Object.keys(TOOLS)) host.registerAction(a, () => startTool(a));
      host.registerAction("drawing-sheet", () => { if (!liveDoc()) { host.info("Open a drawing first: Project › Add New Drawing…"); return; } run([{op: "add_sheet"}], "Sheet added."); });
      host.addRenderer?.((d, info) => d?.kind === "drawing" && info?.active ? {overlay: (c, env) => paintScreen(c, d, env)} : null);
      host.on?.("document", () => { endDrag(true);state.sel = null; state.tool = null; state.pending = null; state.flash = null; shell(); });
      host.on?.("change", shell);
      // The editor rewrites the status-bar kind, the tool readout and tab icons on refresh: keep the
      // drawing's own (a microtask after each rewrite, only while a drawing is open).
      const watch = new MutationObserver(() => { if (!shellBusy) queueMicrotask(shell); });
      for (const id of ["doc-kind", "tool-value"]) { const n = document.getElementById(id); if (n) watch.observe(n, {childList: true, characterData: true, subtree: true}); }
      const tabs = document.querySelector('[role="tablist"]');
      if (tabs) watch.observe(tabs, {subtree: true, attributes: true, attributeFilter: ["href", "data-kind"], childList: true});
      new MutationObserver(() => { accent = null; }).observe(document.documentElement, {attributes: true, attributeFilter: ["data-theme", "style", "class", "data-motion"]});
      // A drawing open before this module loaded: show it now.
      if (liveDoc()) { refreshInspector(); host.redraw?.(); }
      shell();
    });
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("pointermove", e => {
      if (!H || !liveDoc()) return;
      if (state.drag) { if(state.drag.pointerId===e.pointerId)dragTo(pointerSheet(e), e); return; }
      if (state.tool && e.target === H.canvas?.()) { hover(pointerSheet(e), e); H.redraw(); }
    }, true);
    document.addEventListener("pointerup", e => { if (state.drag?.pointerId===e.pointerId) { e.stopPropagation(); endDrag(); } }, true);
    const cancelPointer=e=>{if(state.drag?.pointerId===e.pointerId)endDrag(true);};
    document.addEventListener("pointercancel",cancelPointer,true);
    document.addEventListener("lostpointercapture",cancelPointer,true);
    document.addEventListener("dblclick", e => {
      if (e.target !== H?.canvas?.()) return;
      if (state.tool === "ordinate" && state.pending?.points.length > 1) { e.preventDefault(); e.stopPropagation(); state.pending.ready = true; H.info("Click where the ordinate line goes."); }
      else if (state.tool === "line") { e.preventDefault(); e.stopPropagation(); if (state.pending?.points.length >= 2) { commitLine(); H.redraw(); } }
      else if (!state.tool && state.sel?.kind === "text") { const t = liveDoc()?.drawing.texts.find(x => x.id === state.sel.id); if (t) { e.preventDefault(); e.stopPropagation(); textDialog(H, null, t); } }
    }, true);
    document.addEventListener("keydown", onKey, true);
  }
  if (hasDOM()) install();

  return Object.freeze({VERSION, VIEW_TYPES, VIEW_LABELS, normalize, validate, create, populate, apply, summary, pages, build, exportPDF, fileName, contextFor, inputAt, paintPresentation,
    drawingOf, inspect, fitBox, sheetOrigins, locate, retainSelection, selectIds, selection:() => state.sel ? [state.sel.id] : [], placeAt(kind, op, point) {
      const doc = liveDoc(), at = doc && locate(doc.drawing, point);
      if (!at) { H?.info("Choose a point on a drawing sheet."); return; }
      if (TOOLS[op]) {
        startTool(op);
        if (state.tool === TOOLS[op][0]) toolClick({...at, tol: Math.max(.8, 6 / H.view().scale())}, {});
        H.redraw();
      } else {
        return place(kind, [{...op, sheet: at.sheet.id, x: at.p[0], y: at.p[1]}]);
      }
    }, parseAnchor, syncSheet, tile, TABLE_TYPES, toolGroups: GROUPS, open: host => addDrawing(host || H)});
})();
