"use strict";
// @ts-ignore CommonJS entry point; native and browser hosts declare this dependency in their loaders.
if (!globalThis.AtriumComponentMatch && typeof require === "function") require("../library/component-match.js");
// @ts-ignore CommonJS consumers use the same perimeter validator as the browser and worker.
if (!globalThis.AtriumBoardShape && typeof require === "function") require("../pcb/board-shape.js");
// AtriumDiff: the one design-diff engine. Compare Revisions (revision-panel.js), Review Changes
// (diff-view.js), the MCP tool diff_designs and the CLI (mcp/diff_designs.py), bin/waffle-diff
// (git difftool) and the VS Code extension (integrations/vscode/lib/diff.js) all call it.
// DOM-free: it runs under JavaScriptCore, Node, a Web Worker (diff-worker.js) and the browser.
//
//   AtriumDiff.compare(before, after, opts)          -> change set (below)
//   AtriumDiff.compareAsync(before, after, opts, active) -> Promise<change set|null> (slices; worker when large)
//   AtriumDiff.session(before, opts).compare(after)  -> incremental: the baseline index is built once
//   AtriumDiff.match(before, after, opts)            -> the object correspondence only
//   AtriumDiff.remap(before, after, opts)            -> before with matched ids rewritten to after's ids
//   AtriumDiff.toMarkdown / toHTML / toJSON(result, opts) -> reports (design text escaped)
//
// Change set: {summary, changes[], byObject, byNet, components[], stats}. Each change is
//   {id, kind, category, severity, target, before, after, text, geometry, match, fields}
// severity "electrical" > "mechanical" > "cosmetic".
//
// Components use the same exact-identity and global evidence matcher as ECO. Other objects
// retain the stable-ID, net/geometry signature and tolerant geometry stages.
// Connectivity is compared as pin membership (R12.2 on GND), never as drawn wires, so a redrawn
// wire with the same topology is cosmetic while a pin that changed nets is electrical.
globalThis.AtriumDiff = (() => {
  const VERSION = 1;
  const SEVERITIES = ["electrical", "mechanical", "cosmetic"];
  const RANK = {electrical: 0, mechanical: 1, cosmetic: 2};
  const CATEGORIES = ["connectivity", "schematic", "pcb", "library", "rules", "drc", "waivers", "project"];
  const DEFAULTS = Object.freeze({
    tolerance: 0.0005,        // mm: position, length and size noise below this is ignored
    copperTolerance: 0.001,   // mm: poured copper boundaries this close are the same copper (re-pour float noise)
    angleTolerance: 0.01,     // degrees
    areaTolerance: 0.01,      // mm²
    lengthTolerance: 0.001,   // mm: per-net routed length noise
    matchTolerance: 0.05,     // mm: geometric-hash matching radius
    match: ["id", "designator", "net-geometry", "geometry"],
    ignoreOrder: true,        // drawing / list order is not a change
    groupBoardMoves: true,    // register PCB placements and routing against a translated board outline
    ignorePourFill: true,     // regenerated pour fill, imported pour artwork and its signature
    ignoreAutoNetNames: true, // Net-R1-1 -> Net-R2-1 with the same pins is not a rename
    ignoreMetadata: true,     // source hashes, import caches, restored sheet appearance, source record positions
    ignoreComments: false,    // project.review threads
    ignoreFields: [],         // extra field names to ignore on every object
    ignoreKinds: [],          // object kinds to skip (e.g. ["graphic", "label"])
    cosmeticParameters: [],   // extra part parameter names treated as cosmetic (documentation)
    schematicNets: "auto",    // "auto" (compiled, pinNets for unwired pins) | "compiled" | "pinNets"
    drc: false,               // run the board rule check on both sides and report new / fixed violations
    geometry: true,           // canvas geometry for highlighting
    worker: true,             // compareAsync may use a worker for large designs
    workerThreshold: 20000    // objects on both sides together
  });
  // Part parameters are BOM data and electrical, except documentation-only ones.
  const COSMETIC_PARAMS = /^(description|desc|notes?|url|help ?url|datasheet( ?url)?|author|created|modified|date|revision|checked ?by|drawn ?by|approved ?by|keywords?|component ?link ?\d* ?(url|description)?|footprint ?path|library ?(path|ref(erence)?)|published|publisher)$/i;
  const AUTO_NET = /^(?:Net-|N\$\d|Net[A-Z]+\d*_\d+$|unconnected-|\$\d|N_\d+$|Net\d+$)/;
  const PART_ELECTRICAL = new Set(["value", "mpn", "MPN", "manufacturer", "partNumber", "dnp", "unit", "part", "alt"]);
  const POUR_DOC = ["pcbDrawing", "sourcePourSignature"];
  const META_DOC = ["schRestored", "sourceSha256", "sourceName", "sourceEncoding", "sourceRules"];
  // Per-object import provenance: the record an object came from in the source file (Altium
  // "tracks6/data#598", the schematic record index; altium-ids.js keeps the id). Re-saving the source renumbers them all.
  const META_ITEM = ["sourceRecord", "schSource", "altiumSourceId", "kicadSourceId"];
  const NAMING = new Set(["netlabel", "power", "port", "offsheet"]);
  const COPPER_KINDS = new Set(["track", "via", "pad", "polygon"]);
  const SCH_DRAWN = new Set(["wire", "bus", "busentry", "junction", "noerc"]);
  const COSMETIC_KINDS = new Set(["label", "graphic", "textframe", "image"]);
  const TYPE_NAMES = {part: "Component", track: "Track", arc: "Arc", via: "Via", pad: "Pad", polygon: "Pour", pour: "Pour", wire: "Wire",
    bus: "Bus", busentry: "Bus entry", junction: "Junction", netlabel: "Net label", power: "Power port", port: "Port", offsheet: "Off-sheet connector",
    sheetsymbol: "Sheet symbol", noerc: "No-ERC marker", label: "Text", graphic: "Graphic", textframe: "Text frame", image: "Image"};

  // ------------------------------------------------------------------ small helpers
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const num = v => typeof v === "number" && Number.isFinite(v);
  const isPoint = p => Array.isArray(p) && p.length === 2 && num(p[0]) && num(p[1]);
  const A = () => globalThis.Atrium;
  const now = () => (globalThis.performance?.now ? performance.now() : Date.now());
  const collator = typeof Intl !== "undefined" ? new Intl.Collator("en", {numeric: true}) : null;
  const natural = (a, b) => collator ? collator.compare(String(a), String(b)) : String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  const round = (v, d = 4) => num(v) ? Math.round(v * 10 ** d) / 10 ** d + 0 : v;
  const fmt = (v, d = 4) => num(v) ? String(round(v, d)) : v == null ? "none" : typeof v === "string" ? (v === "" ? "empty" : v) : short(JSON.stringify(v));
  const signed = (v, d = 4) => (v > 0 ? "+" : v < 0 ? "−" : "") + String(Math.abs(round(v, d)));
  const short = (s, n = 60) => { s = String(s ?? ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  const plural = (n, w, p = w + "s") => globalThis.AtriumI18n?.plural?.(n, w, p) ?? n + " " + (n === 1 ? w : p);
  const list = (names, max = 6) => names.length <= max ? names.join(", ") : names.slice(0, max).join(", ") + " and " + (names.length - max) + " more";
  const angleOf = v => num(v) ? ((v % 360) + 360) % 360 : 0;
  const angleKeys = new Set(["angle", "rotation", "hatchAngle", "reliefAngle"]);
  function rotate(p, a) { const r = a * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; }
  function world(p, item) { const q = rotate(item.mirror ? [-p[0], p[1]] : p, item.angle || 0); return [q[0] + (item.x || 0), q[1] + (item.y || 0)]; }
  function boundsOf(points) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of points) { if (!isPoint(p)) continue; if (p[0] < x0) x0 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[0] > x1) x1 = p[0]; if (p[1] > y1) y1 = p[1]; }
    return x0 === Infinity ? null : [x0, y0, x1, y1];
  }
  const unionBox = (a, b) => !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  function pathLength(pts) { let n = 0; for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); return n; }
  function polyArea(pts) { let s = 0; for (let i = 0; i < pts.length; i++) { const a = pts[i], b = pts[(i + 1) % pts.length]; s += a[0] * b[1] - a[1] * b[0]; } return Math.abs(s) / 2; }
  const layerOf = i => i.layer || (i.kind === "via" ? (i.fromLayer && i.toLayer ? i.fromLayer + "–" + i.toLayer : "Multi") : "");
  const options = o => {
    const out = {...DEFAULTS, ...(o || {})};
    out.ignore = new Set(["id", ...(out.ignoreFields || []), ...(out.ignoreMetadata ? META_ITEM : [])]);
    out.skipKinds = new Set(out.ignoreKinds || []);
    out.stages = new Set(out.match || DEFAULTS.match);
    return out;
  };

  // ------------------------------------------------------------------ tolerant equality
  // Missing, null, "", false, [] and {} are one "unset" value (re-serialisation noise); a missing
  // angle is 0. Numbers compare within the tolerance; angles modulo 360.
  function empty(v, key) {
    return v === undefined || v === null || v === false || v === "" || (Array.isArray(v) && !v.length) || (plain(v) && !Object.keys(v).length) ||
      (v === 0 && angleKeys.has(key));
  }
  function same(a, b, o, key = "") {
    if (a === b) return true;
    if (empty(a, key) && empty(b, key)) return true;
    if (num(a) && num(b)) {
      if (angleKeys.has(key)) { const d = Math.abs(angleOf(a) - angleOf(b)); return Math.min(d, 360 - d) <= o.angleTolerance; }
      return Math.abs(a - b) <= o.tolerance;
    }
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!same(a[i], b[i], o, key)) return false;
      return true;
    }
    if (plain(a) && plain(b)) {
      for (const k in a) if (own(a, k) && !o.ignore.has(k) && !same(a[k], b[k], o, k)) return false;
      for (const k in b) if (own(b, k) && !own(a, k) && !o.ignore.has(k) && !empty(b[k], k)) return false;
      return true;
    }
    return false;
  }
  // Top-level fields that differ, sorted. `skip` adds fields handled elsewhere.
  // Independent additive strokes on the same physical layer commute. Preserve the order
  // of mixed paints, filled/negative artwork, and unknown commands. Cache only inside
  // the immutable revision index, so an edited working-side library is always reread.
  function footprintInk(shapes, ix) {
    if (ix.cache.has(shapes)) return ix.cache.get(shapes);
    ix.prepared.footprints++;
    const paints = new Map(), keys = [];
    for (const s of shapes) {
      const layer = s?.layer || (s?.style === "package" ? "Mechanical 13" : "");
      const paint = s?.style;
      if (!layer || !["body","package","silk","assembly","courtyard"].includes(paint) ||
          !["path","circle","text"].includes(s.kind) || s.fill || s.clear || s.negative || s.ink || s.color ||
          s.opacity != null || s.polarity || paints.has(layer) && paints.get(layer) !== paint) {
        ix.cache.set(shapes, null);
        return null;
      }
      paints.set(layer, paint);
      keys.push(JSON.stringify(s, (_key, v) => plain(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v));
    }
    const result = keys.sort();
    ix.cache.set(shapes, result);
    return result;
  }
  function sameFootprintShapes(a, b, o, IA, IB) {
    if (same(a, b, o)) return true;
    if (!o.ignoreOrder || !Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    const left = footprintInk(a, IA), right = footprintInk(b, IB);
    return !!left && !!right && left.every((value, i) => value === right[i]);
  }
  function fieldDiff(a, b, opts, skip) {
    const o = opts?.ignore ? opts : options(opts), out = [];
    const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
    for (const k of keys) {
      if (o.ignore.has(k) || skip?.has(k)) continue;
      if (!same(a?.[k], b?.[k], o, k)) out.push(k);
    }
    return out.sort();
  }
  // Point lists equal forwards or reversed (a track drawn the other way is the same copper).
  function samePath(a, b, o) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    if (same(a, b, o, "points")) return true;
    const n = a.length;
    for (let i = 0; i < n; i++) if (!same(a[i], b[n - 1 - i], o)) return false;
    return true;
  }
  // A closed outline equal from any start vertex, in either direction.
  function sameRing(a, b, o) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    if (!a.length) return true;
    const n = a.length;
    for (let s = 0; s < n; s++) {
      if (!same(a[0], b[s], o)) continue;
      let fw = true, bw = true;
      for (let i = 1; i < n && (fw || bw); i++) {
        if (fw && !same(a[i], b[(s + i) % n], o)) fw = false;
        if (bw && !same(a[i], b[(s - i + n) % n], o)) bw = false;
      }
      if (fw || bw) return true;
    }
    return false;
  }
  // A whole-path translation: every vertex moved by one offset.
  function translation(a, b, o) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length < 1) return null;
    for (const [p, q] of [[a, b], [a, b.slice().reverse()]]) {
      const dx = q[0][0] - p[0][0], dy = q[0][1] - p[0][1];
      if (Math.abs(dx) <= o.tolerance && Math.abs(dy) <= o.tolerance) continue;
      if (p.every((v, i) => Math.abs(q[i][0] - v[0] - dx) <= o.tolerance && Math.abs(q[i][1] - v[1] - dy) <= o.tolerance)) return [dx, dy];
    }
    return null;
  }
  // A pure move of a positioned object or a path.
  function isMove(a, b, opts) {
    const o = opts?.ignore ? opts : options(opts);
    if (num(a.x) && num(a.y) && num(b.x) && num(b.y)) return Math.abs(a.x - b.x) > o.tolerance || Math.abs(a.y - b.y) > o.tolerance;
    if (Array.isArray(a.points) && Array.isArray(b.points) && a.points.length > 1) return !!translation(a.points, b.points, o);
    return false;
  }

  // ------------------------------------------------------------------ geometry for highlighting
  // {box, path, closed, width, round} in the document's coordinates.
  function shapeOf(item, g, docKind) {
    if (!item) return null;
    let pts = null;
    try {
      if (item.kind === "part" && g) {
        const view = A()?.gate ? A().gate(g, item) : g;
        pts = (A()?.symbolPoints ? A().symbolPoints(view) : [...(view.pins || []), ...(view.pads || [])].map(p => [p.x, p.y])).map(p => world(p, item));
      } else if (item.kind !== "part") {
        pts = A()?.itemPoints ? A().itemPoints(item, null, docKind) : item.points || [[item.x, item.y]];
      }
    } catch { pts = null; }
    let box = pts?.length ? boundsOf(pts) : null;
    if (!box && num(item.x) && num(item.y)) box = [item.x - 1, item.y - 1, item.x + 1, item.y + 1];
    if (!box && Array.isArray(item.points)) box = boundsOf(item.points);
    if (!box) return null;
    const path = Array.isArray(item.points) && item.points.length > 1 && item.points.every(isPoint) ? item.points : null;
    return {box, path, closed: item.kind === "polygon" || item.kind === "region" || item.kind === "fill", width: num(item.width) ? item.width : 0,
      round: item.kind === "via" || item.kind === "junction" || item.kind === "pad" && /round|circle/.test(item.shape || "")};
  }
  const pointShape = (p, r = 0.6) => p ? {box: [p[0] - r, p[1] - r, p[0] + r, p[1] + r], path: null, closed: false, width: 0, round: true} : null;

  // ------------------------------------------------------------------ project index
  const noteOwner=i=>i?.kind==="image" || i?.kind==="imageMarkup" || i?.kind==="calculation" ||
    i?.kind==="textframe" && i.role!=="frame" || globalThis.AtriumNotebook?.isNote(i);
  // Built once per project object; a session keeps the baseline's index between comparisons.
  function indexOf(p) {
    const docs = new Map(), defs = new Map(), items = new Map(), byDoc = new Map(), notes = new Set();
    for (const d of p.documents || []) {
      docs.set(d.id, d);
      const own = [];
      for (const i of d.items || []) { if (i && typeof i.id === "string") { items.set(i.id, {item: i, doc: d}); own.push(i); if (noteOwner(i)) notes.add(i.id); } }
      byDoc.set(d.id, own);
    }
    for (const d of p.library || []) if (d && typeof d.id === "string") defs.set(d.id, d);
    return {p, docs, defs, items, byDoc, notes, cache: new Map(), signatures:new WeakMap(), frames:new Map(), prepared:{signatures:0,footprints:0}};
  }
  const geom = (ix, item, kind) => { const def = ix.defs.get(item.def); return kind === "pcb" ? def?.footprint : def?.symbol; };
  const defName = (ix, id) => { const d = ix.defs.get(id); return d ? d.name || d.footprint?.name || id : id; };
  const fpName = (ix, id) => { const d = ix.defs.get(id); return d?.footprint?.name || d?.name || id; };

  // ------------------------------------------------------------------ matching
  // Signatures. `exact` rounds to 1 µm and includes the net; the tolerant stage uses grid cells.
  const q3 = v => num(v) ? Math.round(v * 1000) : "";
  // Paths read forwards or backwards; closed rings (pours, closed graphics) also from any start
  // vertex: they start at their smallest vertex and run towards its smaller neighbour.
  const lessPt = (p, r) => q3(p[0]) < q3(r[0]) || q3(p[0]) === q3(r[0]) && q3(p[1]) < q3(r[1]);
  function normPoints(pts, closed) {
    if (!Array.isArray(pts) || !pts.length) return [];
    if (closed && pts.length > 2) {
      let ring = pts;
      if (q3(ring[0][0]) === q3(ring[ring.length - 1][0]) && q3(ring[0][1]) === q3(ring[ring.length - 1][1])) ring = ring.slice(0, -1);
      const n = ring.length;
      let k = 0;
      for (let i = 1; i < n; i++) if (lessPt(ring[i], ring[k])) k = i;
      const fw = lessPt(ring[(k + 1) % n], ring[(k - 1 + n) % n]);
      const out = [];
      for (let i = 0; i < n; i++) out.push(ring[((fw ? k + i : k - i) % n + n) % n]);
      return out;
    }
    const f = pts[0], l = pts[pts.length - 1];
    return (f[0] > l[0] || f[0] === l[0] && f[1] > l[1]) ? pts.slice().reverse() : pts;
  }
  const isClosed = i => i.kind === "polygon" || i.kind === "region" || i.kind === "fill" || !!i.closed;
  function anchor(i) {
    if (num(i.x) && num(i.y)) return [i.x, i.y];
    if (Array.isArray(i.points) && i.points.length) { const n = normPoints(i.points, isClosed(i)); return n[0]; }
    return null;
  }
  function signature(ix, i, withNet) {
    if (withNet && ix.signatures.has(i)) return ix.signatures.get(i);
    const parts = [i.kind, i.kind === "part" ? defName(ix, i.def) : "", withNet ? i.net || "" : "", layerOf(i), i.text ?? "", i.number ?? ""];
    if (i.kind === "part") parts.push(q3(i.x), q3(i.y), q3(angleOf(i.angle)), i.mirror ? 1 : 0);
    else if (Array.isArray(i.points)) for (const p of normPoints(i.points, isClosed(i))) parts.push(q3(p[0]), q3(p[1]));
    else parts.push(q3(i.x), q3(i.y));
    if (num(i.width)) parts.push("w" + q3(i.width));
    if (num(i.diameter)) parts.push("d" + q3(i.diameter));
    const key = parts.join("|");
    if (withNet) { ix.signatures.set(i,key); ix.prepared.signatures++; }
    return key;
  }
  function closeGeometry(a, b, tol) {
    if (a.kind !== b.kind) return Infinity;
    if (Array.isArray(a.points) || Array.isArray(b.points)) {
      const p = normPoints(a.points || [], isClosed(a)), r = normPoints(b.points || [], isClosed(b));
      if (p.length !== r.length) return Infinity;
      let worst = 0;
      for (let k = 0; k < p.length; k++) { const d = Math.hypot(p[k][0] - r[k][0], p[k][1] - r[k][1]); if (d > tol) return Infinity; if (d > worst) worst = d; }
      return worst;
    }
    if (!num(a.x) || !num(b.x)) return Infinity;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    return d <= tol ? d : Infinity;
  }
  // Registration needs independent witnesses: named, uniquely placed components across the
  // PCB and the physical perimeter. An array of parts moved inside a stationary board fails.
  function *boardMotion(IA, IB, da, db, o) {
    const a = IA.docs.get(da), b = IB.docs.get(db);
    if (a.kind !== "pcb" || !a.outline?.length || !b.outline?.length || sameRing(a.outline, b.outline, o)) return null;
    let tick = 0;
    function *placements(ix, doc) {
      const parts = new Map();
      let count = 0;
      for (const p of ix.byDoc.get(doc)) {
        if ((++tick & 255) === 0) yield;
        if (p.kind !== "part") continue;
        count++;
        if (!p.ref || /[?*]/.test(p.ref) || !num(p.x) || !num(p.y)) continue;
        const key = JSON.stringify([p.ref, fpName(ix, p.def), p.layer || "Top"]);
        parts.set(key, parts.has(key) ? null : p);
      }
      return {parts, count};
    }
    const left = yield* placements(IA, da), right = yield* placements(IB, db);
    const votes = [];
    for (const [key, p] of left.parts) {
      const q = right.parts.get(key);
      if (p && q) votes.push({p, dx:q.x - p.x, dy:q.y - p.y});
    }
    if (votes.length < 3) return null;
    const median = key => {
      const ns = votes.map(v => v[key]).sort((x,y) => x-y), k = ns.length >> 1;
      return ns.length % 2 ? ns[k] : (ns[k-1] + ns[k])/2;
    };
    const dx = median("dx"), dy = median("dy");
    if (Math.max(Math.abs(dx),Math.abs(dy)) <= o.tolerance) return null;
    const placed = votes.filter(v => Math.abs(dx-v.dx) <= o.tolerance && Math.abs(dy-v.dy) <= o.tolerance);
    if (placed.length < 3 || placed.length * 3 < 2 * Math.max(left.count,right.count)) return null;
    const first = placed[0].p, second = placed.find(v => Math.hypot(v.p.x-first.x,v.p.y-first.y) > o.tolerance)?.p;
    if (!second || !placed.some(({p}) => Math.abs((second.x-first.x)*(p.y-first.y) - (second.y-first.y)*(p.x-first.x)) >
        o.tolerance * Math.hypot(second.x-first.x,second.y-first.y))) return null;
    const point = p => [p[0]+dx,p[1]+dy], outline = a.outline.map(point);
    if (!sameRing(outline,b.outline,o)) return null;
    const project = (i, x, y) => {
      const v = {...i};
      if (num(i.x) && num(i.y)) { v.x += x; v.y += y; }
      if (Array.isArray(i.points)) v.points = i.points.map(p => [p[0]+x,p[1]+y]);
      return v;
    };
    let frame = IA.frames.get(da);
    if (!frame || frame.dx !== dx || frame.dy !== dy) {
      frame = {dx,dy,placed:new WeakMap(),middle:new WeakMap()};
      IA.frames.set(da,frame);
    }
    const projected = (map,i,x,y) => {
      if (!map.has(i)) map.set(i,project(i,x,y));
      return map.get(i);
    };
    // Both directions calculate geometric signatures in the same midpoint frame, including
    // their quantization boundaries. Keep the actual before/after coordinates for inspection.
    return {dx, dy, item:i => projected(frame.placed,i,dx,dy),
      middle:(i,old) => old ? projected(frame.middle,i,dx/2,dy/2) : project(i,-dx/2,-dy/2),
      anchors:placed.length, members:[], kinds:Object.create(null)};
  }
  function translatedShape(a, b, motion) {
    const shape = a.boardShape, B = globalThis.AtriumBoardShape;
    if (!motion || !shape || !B?.fresh(a) || !B.fresh(b)) return shape;
    const out = B.translate(shape, motion.dx, motion.dy);
    const preserve = (original,moved) => original.map((s,i)=>Object.assign({},s,moved[i]));
    out.contour = preserve(shape.contour,out.contour);
    out.cutouts = (shape.cutouts || []).map((ring,i)=>preserve(ring,out.cutouts[i]));
    // Each fingerprint was independently verified against its own flattened outline.
    if (own(shape,"sig") && own(b.boardShape,"sig")) out.sig = b.boardShape.sig;
    return out;
  }
  // Contours can start on a different edge, run the other way, or appear in a different
  // cutout-list order. Keep each complete loop, including arc direction and curvature.
  function sameBoardShape(a, b, motion, o) {
    const left = translatedShape(a,b,motion), right = b.boardShape, B = globalThis.AtriumBoardShape;
    if (same(left,right,o)) return true;
    if (!o.ignoreOrder || !left || !right || !B?.fresh(a) || !B.fresh(b) ||
        fieldDiff(left,right,o,new Set(["contour","cutouts"])).length) return false;
    const near = (p,q) => Math.hypot(p[0]-q[0],p[1]-q[1]) <= o.tolerance;
    const geometry = new Set(["a","b","c","r","start","end","ccw"]);
    const edge = (p,q,reverse) => {
      if (p.kind !== q.kind) return false;
      const from = B.ends(p), to = B.ends(q);
      if (!near(from[0],to[reverse?1:0]) || !near(from[1],to[reverse?0:1]) || fieldDiff(p,q,o,geometry).length) return false;
      if (p.kind === "line") return true;
      const mid = s => B.pointAt(s.c,s.r,s.start+B.sweep(s)/2);
      return near(p.c,q.c) && Math.abs(p.r-q.r) <= o.tolerance && p.ccw === (reverse ? !q.ccw : q.ccw) && near(mid(p),mid(q));
    };
    const loop = (p,q) => {
      if (p.length !== q.length) return false;
      if (!p.length) return true;
      let budget = 8*p.length+8;
      for (let start=0;start<q.length;start++) for (const step of [1,-1]) {
        if (budget <= 0) return false;
        if (p.every((s,i)=>--budget >= 0 && edge(s,q[(start+step*i+q.length)%q.length],step<0))) return true;
      }
      return false;
    };
    if (!loop(left.contour,right.contour)) return false;
    const before = left.cutouts || [], after = right.cutouts || [];
    if (before.length !== after.length) return false;
    const cell = Math.max(.001,4*o.tolerance);
    const address = ring => {
      const box = B.contourBounds(ring);
      return [Math.floor((box[0]+box[2])/(2*cell)),Math.floor((box[1]+box[3])/(2*cell))];
    };
    const buckets = new Map();
    for (const ring of after) {
      const key = [ring.length,...address(ring)].join(",");
      if (!buckets.has(key)) buckets.set(key,new Set());
      buckets.get(key).add(ring);
    }
    for (const ring of before) {
      const [x,y] = address(ring);
      let found = false;
      nearby: for (let i=-1;i<=1;i++) for (let j=-1;j<=1;j++) {
        const set = buckets.get([ring.length,x+i,y+j].join(","));
        for (const candidate of set || []) if (loop(ring,candidate)) {
          set.delete(candidate); found=true; break nearby;
        }
      }
      if (!found) return false;
    }
    return true;
  }
  function rawNets(ix, o) {
    if (ix.rawNets?.mode !== o.schematicNets)
      ix.rawNets = {mode: o.schematicNets, list: schematicNetlist(ix, id => id, o)};
    return ix.rawNets.list;
  }
  function componentRecords(ix, other, docId, defId, o) {
    const C = globalThis.AtriumComponentMatch, out = [];
    // Reimporting can regenerate hierarchy IDs. Sheet symbol names and repeat indices still
    // identify the physical instance; compiled sheet pins include the complete instance path.
    const seats = new Map(), paths = new Map(), instances = new Map();
    const pathKey = path => JSON.stringify(path.map(([id, ch]) => [seats.get(id) || id,ch]));
    if (globalThis.AtriumHierarchy && ix.p.documents.some(d => d.items.some(i => i.kind === "sheetsymbol"))) {
      for (const doc of ix.docs.values()) {
        const siblings = new Map();
        for (const symbol of doc.items) if (symbol.kind === "sheetsymbol") {
          const key = JSON.stringify([docId(doc.id),symbol.name || "",docId(symbol.sheet)]);
          if (!siblings.has(key)) siblings.set(key,[]);
          siblings.get(key).push(symbol);
        }
        for (const [key,group] of siblings) {
          const at = s => JSON.stringify([q3(s.x),q3(s.y)]);
          const counts = new Map();
          for (const s of group) counts.set(at(s),(counts.get(at(s)) || 0)+1);
          for (const s of group) {
            const stable = other.items.get(s.id)?.item.kind === "sheetsymbol";
            seats.set(s.id,stable ? ["id",s.id] : group.length === 1 ? ["site",key] :
              counts.get(at(s)) === 1 ? ["site",key,at(s)] : ["unresolved",s.id]);
          }
        }
      }
      for (const inst of AtriumHierarchy.instances(ix.p).instances) {
        const path = instancePath(inst);
        if (path) {
          const k = pathKey(path);
          paths.set(inst.id,k);
          if (!instances.has(inst.doc.id)) instances.set(inst.doc.id,[]);
          instances.get(inst.doc.id).push(k);
        }
      }
    }
    for (const list of instances.values()) list.sort();
    for (const doc of ix.docs.values()) {
      const scope = docId(doc.id), location = C.boardLocations(doc);
      for (const p of ix.byDoc.get(doc.id)) {
        if (p.kind !== "part") continue;
        const def = ix.defs.get(p.def), loc = doc.kind === "pcb" ? location(p) : {};
        out.push(C.describe(p, def, {scope, domain: doc.kind, plane: scope, sheet: loc.sheet ? docId(loc.sheet) : scope,
          channel: paths.get(loc.channel) || loc.channel || "", instances:instances.get(doc.id), room: loc.room || "", library: defId(def?.mirrorOf || p.def),
          pins() {
            if (doc.kind === "pcb") return C.boardPins(p, def);
            const nl = rawNets(ix, o), map = new Map();
            for (const k of nl.byPart.get(p.id) || []) {
              const n = nl.pins.get(k);
              map.set(n.path ? pathKey(n.path) + "/" + n.number : n.number, n.net);
            }
            return map;
          }}));
      }
    }
    return out;
  }
  function *matchSteps(IA, IB, o) {
    const docs = new Map(), docBy = new Map(), defs = new Map(), items = new Map(), back = new Map();
    let tick = 0;
    const stat = {id: 0, designator: 0, "net-geometry": 0, geometry: 0};
    // Documents: id, then kind + name, then the only remaining document of a kind.
    const freeB = new Map(IB.docs);
    for (const [id, d] of IA.docs) if (freeB.has(id) && freeB.get(id).kind === d.kind) { docs.set(id, id); docBy.set(id, {by: "id", confidence: 1}); freeB.delete(id); }
    for (const [id, d] of IA.docs) {
      if (docs.has(id)) continue;
      const hit = [...freeB.values()].find(x => x.kind === d.kind && x.name === d.name);
      if (hit) { docs.set(id, hit.id); docBy.set(id, {by: "name", confidence: 0.9}); freeB.delete(hit.id); }
    }
    for (const [id, d] of IA.docs) {
      if (docs.has(id)) continue;
      const leftA = [...IA.docs.values()].filter(x => !docs.has(x.id) && x.kind === d.kind), leftB = [...freeB.values()].filter(x => x.kind === d.kind);
      if (leftA.length === 1 && leftB.length === 1) { docs.set(id, leftB[0].id); docBy.set(id, {by: "kind", confidence: 0.7}); freeB.delete(leftB[0].id); }
    }
    // Library: id, then name, then identical geometry.
    const fpKey = d => JSON.stringify([d.symbol?.pins?.map(p => [p.number, q3(p.x), q3(p.y)]) || null, d.footprint?.pads?.map(p => [p.number, q3(p.x), q3(p.y), q3(p.w), q3(p.h)]) || null]);
    const libB = new Map(IB.defs);
    for (const id of IA.defs.keys()) if (libB.has(id)) { defs.set(id, {id, by: "id", confidence: 1}); libB.delete(id); }
    const byName = new Map(); for (const d of libB.values()) { const k = d.name; if (!byName.has(k)) byName.set(k, []); byName.get(k).push(d); }
    for (const [id, d] of IA.defs) {
      if (defs.has(id)) continue;
      const c = byName.get(d.name);
      if (c?.length) { const hit = c.shift(); defs.set(id, {id: hit.id, by: "name", confidence: 0.9}); libB.delete(hit.id); }
    }
    if (libB.size) {
      const byGeo = new Map(); for (const d of libB.values()) { const k = fpKey(d); if (!byGeo.has(k)) byGeo.set(k, []); byGeo.get(k).push(d); }
      for (const [id, d] of IA.defs) { if (defs.has(id)) continue; const c = byGeo.get(fpKey(d)); if (c?.length) { const hit = c.shift(); defs.set(id, {id: hit.id, by: "geometry", confidence: 0.7}); libB.delete(hit.id); } }
      // Another tool's import may carry only the footprint (no symbol): match on the pads alone.
      const padKey = d => d.footprint?.pads?.length ? JSON.stringify(d.footprint.pads.map(p => [p.number, q3(p.x), q3(p.y), q3(p.w), q3(p.h)])) : null;
      const byPads = new Map(); for (const d of libB.values()) { const k = padKey(d); if (k) { if (!byPads.has(k)) byPads.set(k, []); byPads.get(k).push(d); } }
      for (const [id, d] of IA.defs) { if (defs.has(id)) continue; const k = padKey(d), c = k && byPads.get(k); if (c?.length) { const hit = c.shift(); defs.set(id, {id: hit.id, by: "geometry", confidence: 0.6}); libB.delete(hit.id); } }
    }
    // Items, stage 1: the stable id, anywhere in the project (an object may move between sheets).
    const pair = (a, b, by, confidence) => { items.set(a.id, {id: b.id, by, confidence}); back.set(b.id, a.id); stat[by]++; };
    if (o.stages.has("id")) {
      for (const [id, e] of IB.items) {
        const prev = IA.items.get(id);
        if (prev && e.item.kind !== "part" && prev.item.kind === e.item.kind) pair(prev.item, e.item, "id", 1);
        if ((++tick & 1023) === 0) yield;
      }
    }
    // Later stages run per matched document pair on what is left.
    const C = globalThis.AtriumComponentMatch, sameId = id => id;
    const left = componentRecords(IA, IB, id => docs.get(id) ?? "\u0001" + id, id => defs.get(id)?.id ?? id, o);
    const right = componentRecords(IB, IA, sameId, sameId, o);
    const motions = new Map();
    if (o.groupBoardMoves && o.stages.has("geometry")) {
      for (const [da, db] of docs) {
        const motion = yield* boardMotion(IA, IB, da, db, o);
        if (motion) motions.set(da,motion);
      }
      if (motions.size) for (const p of left) {
        const motion = motions.get(IA.items.get(p.key).doc.id);
        if (motion) { p.x += motion.dx; p.y += motion.dy; }
      }
    }
    const matched = yield* C.steps(left, right, {exact: o.stages.has("id"), designator: o.stages.has("designator"),
      geometry: o.stages.has("geometry") || o.stages.has("net-geometry"), tolerance: o.matchTolerance,
      topology: o.stages.has("topology") || o.stages.has("net-geometry"),
      infer: ["designator", "net-geometry", "geometry", "topology"].some(stage => o.stages.has(stage))});
    const componentRows = [], componentStats = {exact: 0, inferred: 0, review: 0, unpairedReview: 0, added: right.length - matched.pairs.size, removed: left.length - matched.pairs.size};
    const alternatives = a => (matched.choices.get(a.key) || []).map(c => {
      const entry = IB.items.get(c.target);
      return {target:c.target,ref:entry.item.ref,doc:entry.doc.id,reasons:c.reasons};
    });
    for (const a of left) {
      const m = matched.pairs.get(a.key);
      if (!m) {
        if (matched.reviewSources.has(a.key)) {
          componentStats.unpairedReview++;
          const prev = IA.items.get(a.key);
          componentRows.push({before: a.key, after: null, beforeRef: prev.item.ref, afterRef: "", doc: docs.get(prev.doc.id) || prev.doc.id,
            by: "unpaired", confidence: null, review: true, alternatives:alternatives(a), reasons: [matched.unpairedReasons?.get(a.key) || "Possible footprints already have competing matches"]});
        }
        continue;
      }
      const {target: id, ...info} = m;
      if (info.by === "net-geometry" && o.stages.has("designator") && a.ref === IB.items.get(id).item.ref &&
          signature(IA, IA.items.get(a.key).item, true) !== signature(IB, IB.items.get(id).item, true)) info.by = "designator";
      items.set(a.key, {id, ...info}); back.set(id, a.key); stat[info.by] = (stat[info.by] || 0) + 1;
      componentStats[info.review ? "review" : info.confidence === 1 ? "exact" : "inferred"]++;
      const b = IB.items.get(id);
      componentRows.push({before: a.key, after: id, beforeRef: IA.items.get(a.key).item.ref, afterRef: b.item.ref, doc: b.doc.id, ...info,
        ...(info.review ? {alternatives:alternatives(a)} : {})});
    }
    for (const [da, db] of docs) {
      const kind = IA.docs.get(da).kind;
      let leftA = IA.byDoc.get(da).filter(i => i.kind !== "part" && !items.has(i.id)), leftB = IB.byDoc.get(db).filter(i => i.kind !== "part" && !back.has(i.id));
      const motion = motions.get(da);
      if (motion) {
        leftA = leftA.map(i => motion.middle(i,true));
        leftB = leftB.map(i => motion.middle(i,false));
      }
      if (!leftA.length || !leftB.length) continue;
      const take = () => { leftA = leftA.filter(i => !items.has(i.id)); leftB = leftB.filter(i => !back.has(i.id)); };
      // The editable copy owns its Waffle IDs, but KiCad retains UUIDs (and older
      // timestamps) on many routes, vias and wires. A unique record in each revision
      // can be matched even when its position or net changed. Duplicate source stamps
      // within the same document and kind carry no individual identity.
      if (o.stages.has("id") && leftA.some(i => i.kicadSourceId) && leftB.some(i => i.kicadSourceId)) {
        function* unique(list) {
          const found = new Map();
          for (const i of list) {
            if (i.kind !== "part" && typeof i.kicadSourceId === "string" && i.kicadSourceId) {
              const key = i.kind + "/" + i.kicadSourceId;
              found.set(key, found.has(key) ? null : i);
            }
            if ((++tick & 1023) === 0) yield;
          }
          return found;
        }
        const from = yield* unique(IA.byDoc.get(da)), to = yield* unique(IB.byDoc.get(db));
        for (const [key, a] of from) {
          const b = to.get(key);
          if (a && b && !items.has(a.id) && !back.has(b.id)) pair(a, b, "id", 1);
          if ((++tick & 1023) === 0) yield;
        }
        take();
      }
      // IDs assigned on import cannot break a geometry tie consistently across independently
      // read revisions. Source order is stable for the same two committed KiCad documents.
      // It is only the last tie breaker for geometrically indistinguishable candidates.
      if (!leftA.length || !leftB.length) continue;
      const imported = /\.kicad_(?:pcb|sch)$/i;
      const sourceOrder = imported.test(IA.docs.get(da).sourceName || "") && imported.test(IB.docs.get(db).sourceName || "") ? new Map() : null;
      if (sourceOrder) for (const list of [leftA, leftB]) for (const item of list) {
        sourceOrder.set(item, sourceOrder.size);
        if ((++tick & 1023) === 0) yield;
      }
      const byId = sourceOrder ? (x, y) => sourceOrder.get(x) - sourceOrder.get(y) :
        (x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
      // An exact signature (same definition, place and net) runs before designators, so physically
      // unchanged parts whose designators were permuted stay paired (the permutation is reported).
      if (o.stages.has("net-geometry") && leftA.length && leftB.length) {
        const bucket = new Map(), tiedPaths = new Map(), pathKeys = new Map();
        const append = (map, key, item) => { if (!map.has(key)) map.set(key, []); map.get(key).push(item); };
        const detail = i => i.kind === "polygon" ? i.pourIndex ?? 0 : JSON.stringify(i.points);
        for (const a of leftA.slice().sort((x, y) => byId(y, x))) {
          const key = signature(IA, a, true); append(bucket, key, a);
          if (bucket.get(key).length === 2 && Array.isArray(a.points)) tiedPaths.set(key, new Map());
          if ((++tick & 1023) === 0) yield;
        }
        // The 1 µm undirected geometry key can merge two real records. For ties, first use the
        // source coordinates in drawing direction, or the priority of stacked coincident zones.
        // The usual geometry fallback still pairs genuine coordinate and priority edits.
        for (const [key, candidates] of tiedPaths)
          for (const a of bucket.get(key)) { append(candidates, detail(a), a); if ((++tick & 1023) === 0) yield; }
        const ordered = leftB.slice().sort(byId);
        if (tiedPaths.size) for (const b of ordered) if (Array.isArray(b.points)) {
          const key = signature(IB, b, true); pathKeys.set(b, key);
          const exact = tiedPaths.get(key)?.get(detail(b));
          if (exact?.length) pair(exact.pop(), b, "net-geometry", 0.9);
          if ((++tick & 1023) === 0) yield;
        }
        for (const b of ordered) {
          if (back.has(b.id)) continue;
          const c = bucket.get(pathKeys.get(b) ?? signature(IB, b, true));
          while (c?.length && items.has(c[c.length - 1].id)) c.pop();
          if (c?.length) pair(c.pop(), b, "net-geometry", 0.9);
          if ((++tick & 1023) === 0) yield;
        }
        take();
      }
      if (o.stages.has("geometry") && leftA.length && leftB.length) {
        // Grid cells of matchTolerance; candidates sorted by id and matched ones skipped from the
        // front of each cell, so stacked objects stay linear and the result ignores file order.
        const cell = Math.max(o.matchTolerance, 1e-6), grid = new Map();
        const cellKey = (k, x, y) => k + "|" + x + "," + y;
        for (const a of leftA.slice().sort(byId)) {
          const p = anchor(a); if (!p) continue;
          const k = cellKey(a.kind + "|" + layerOf(a), Math.floor(p[0] / cell), Math.floor(p[1] / cell));
          if (!grid.has(k)) { const arr = /** @type {any} */ ([]); arr.start = 0; grid.set(k, arr); }
          grid.get(k).push(a);
          if ((++tick & 1023) === 0) yield;
        }
        for (const b of leftB.slice().sort(byId)) {
          const p = anchor(b); if (!p) continue;
          const base = b.kind + "|" + layerOf(b), cx = Math.floor(p[0] / cell), cy = Math.floor(p[1] / cell);
          let best = null, bestD = Infinity;
          scan: for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
            const arr = grid.get(cellKey(base, cx + dx, cy + dy));
            if (!arr) continue;
            while (arr.start < arr.length && items.has(arr[arr.start].id)) arr.start++;
            for (let n = arr.start; n < arr.length; n++) {
              const a = arr[n];
              if (items.has(a.id)) continue;
              const d = closeGeometry(a, b, o.matchTolerance);
              if (d < bestD || d === bestD && best && byId(a, best) < 0) { bestD = d; best = a; }
              if (bestD === 0) break scan;
            }
          }
          if (best) pair(best, b, "geometry", round(0.75 - 0.15 * bestD / o.matchTolerance, 3));
          if ((++tick & 1023) === 0) yield;
        }
      }
      void kind;
    }
    return {docs, docBy, defs, items, back, motions, stats: stat, components: componentRows, componentStats, componentWork:matched.work};
  }

  // ------------------------------------------------------------------ netlists
  // A netlist is {byPin: key -> net, nets: net -> Set(key), pins: key -> info, parts: Set(cpart),
  // byPart: cpart -> [keys]}. A key is the canonical part id (the after side's id) and the pin
  // number joined by NUL, which no id or pin number contains in practice; nothing parses keys:
  // info.cpart holds the part. Hierarchical instances add the path of sheet symbols (canonical
  // ids) and channel indices, so every channel keeps its own pins whatever the naming scheme.
  const SEP = "\u0000";
  function newList() { return {byPin: new Map(), nets: new Map(), pins: new Map(), parts: new Set(), byPart: new Map(), source: ""}; }
  function addPin(nl, canon, info) {
    const net = info.net;
    if (!net) return;
    const cpart = canon(info.part), key = cpart + SEP + info.number + (info.path ? SEP + info.path.map(([sym, ch]) => canon(sym) + "#" + ch).join("/") : "");
    if (nl.byPin.has(key)) return;
    nl.byPin.set(key, net);
    if (!nl.nets.has(net)) nl.nets.set(net, new Set());
    nl.nets.get(net).add(key);
    nl.pins.set(key, {...info, cpart});
    if (!nl.byPart.has(cpart)) nl.byPart.set(cpart, []);
    nl.byPart.get(cpart).push(key);
  }
  // The same netlist under another id mapping (a session's baseline, matched afresh each time).
  function rekey(raw, canon, wrappers) {
    const nl = newList();
    nl.source = raw.source;
    for (const id of raw.rawParts || []) nl.parts.add(canon(id));
    for (const info of raw.pins.values()) {
      const path = wrappers?.size && info.path ? info.path.filter(([id]) => !wrappers.has(id)) : info.path;
      addPin(nl, canon, path === info.path ? info : {...info, path:path.length ? path : null});
    }
    return nl;
  }
  // A stable frame ID can become a new sheet symbol in the same parent. Only that
  // single, non-repeated wrapper is transparent. Ordinary multi-instantiation and
  // every original ancestor/channel still distinguish physical pins, in both directions.
  function extractedFrames(old, next) {
    const result = new Set();
    for (const d of old.docs.values()) {
      if (d.kind !== "schematic") continue;
      for (const f of d.items) {
        if (f.kind !== "textframe" || f.role !== "frame") continue;
        const entry = next.items.get(f.id), s = entry?.item, child = next.docs.get(s?.sheet);
        if (entry?.doc.id !== d.id || s?.kind !== "sheetsymbol" || !child || old.docs.has(child.id) ||
            globalThis.AtriumSchObjects?.repeatOf(s) || !child.items.some(i => old.items.get(i.id)?.doc.id === d.id)) continue;
        const instances = [...next.docs.values()].reduce((n,doc) => n+doc.items.filter(i => i.kind === "sheetsymbol" && i.sheet === child.id).length,0);
        if (instances === 1) result.add(s.id);
      }
    }
    return result;
  }
  function instancePath(inst) {
    const path = [];
    for (let x = inst; x && x.symbol; x = x.parent) path.unshift([x.symbol.id, x.channel ? x.channel.index : 0]);
    return path.length ? path : null;
  }
  function schematicNetlist(ix, canon, o) {
    const nl = newList(), p = ix.p, mode = o.schematicNets;
    const sheets = p.documents.filter(d => d.kind === "schematic");
    nl.rawParts = [];
    for (const d of sheets) for (const i of d.items) if (i.kind === "part") { nl.parts.add(canon(i.id)); nl.rawParts.push(i.id); }
    let compiled = false;
    // "auto": sheets that draw connectivity (wires, labels, ports) are compiled; a sheet with
    // none (an MCP- or netlist-authored design) is read from the parts' pinNets.
    const drawn = d => d.items.some(i => i.kind === "wire" || NAMING.has(i.kind) || i.kind === "sheetsymbol" && i.entries?.length || i.kind === "bus");
    const annotated = new Set(mode === "pinNets" ? sheets.map(d => d.id) : mode === "auto" ? sheets.filter(d => !drawn(d)).map(d => d.id) : []);
    if (mode !== "pinNets" && sheets.length) {
      const H = globalThis.AtriumHierarchy;
      try {
        if (H?.compile) {
          const r = H.compile(p, {defs: ix.defs}), insts = new Map((r.instances || []).map(x => [x.id, x]));
          const names = [...r.nets].sort((x, y) => natural(x.name, y.name));
          for (const n of names) for (const c of n.pins) {
            const inst = insts.get(c.instance);
            addPin(nl, canon, {net: n.name, part: c.part.id, number: String(c.pin.number), path: inst ? instancePath(inst) : null,
              label: (c.ref || c.part.ref) + "." + c.pin.number, ref: c.ref || c.part.ref, pinName: c.pin.name || "", doc: c.doc.id, at: c.pin.at});
          }
          compiled = true; nl.source = "compiled";
        } else if (A()?.connectivity) {
          for (const d of sheets) {
            const r = A().connectivity(d, ix.defs);
            for (const i of d.items) if (i.kind === "part") for (const pin of A().pins(i, ix.defs.get(i.def), "schematic")) {
              const net = r.byPin.get(i.id + "/" + pin.number);
              if (net) addPin(nl, canon, {net, part: i.id, number: String(pin.number), label: i.ref + "." + pin.number, ref: i.ref, pinName: pin.name || "", doc: d.id, at: pin.at});
            }
          }
          compiled = true; nl.source = "sheet";
        }
      } catch { compiled = false; }
    }
    // pinNets: the netlist annotation the editor and ECO keep on each part. It is the whole
    // netlist in "pinNets" mode and covers sheets that draw no connectivity otherwise.
    if (!compiled && mode !== "pinNets") { for (const d of sheets) annotated.add(d.id); if (sheets.length) nl.source = "pinNets (compile failed)"; }
    if (annotated.size) {
      if (!nl.source) nl.source = "pinNets"; else if (compiled) nl.source += "+pinNets";
      for (const d of sheets) if (annotated.has(d.id)) for (const i of d.items) {
        if (i.kind !== "part" || !plain(i.pinNets)) continue;
        for (const n of Object.keys(i.pinNets).sort(natural)) {
          const net = i.pinNets[n];
          if (typeof net !== "string" || !net) continue;
          let at = null;
          try { at = A()?.pins(i, ix.defs.get(i.def), "schematic").find(x => String(x.number) === n)?.at || null; } catch { at = null; }
          addPin(nl, canon, {net, part: i.id, number: n, label: i.ref + "." + n, ref: i.ref, pinName: "", doc: d.id, at});
        }
      }
    }
    return nl;
  }
  // Copper layers a footprint pad occupies: through-hole and Multi pads every layer, SMD pads the
  // part's side.
  function padLayers(pad, part) {
    if (num(pad.drill) && pad.drill > 0 || /multi/i.test(pad.layer || "")) return null;
    const bottom = /bottom/i.test(part.layer || ""), padBottom = /bottom/i.test(pad.layer || "");
    return bottom !== padBottom ? "Bottom" : "Top";
  }
  function boardNetlist(ix, doc, canon) {
    const nl = newList();
    nl.source = "pinNets";
    for (const i of doc.items) {
      if (i.kind === "part") {
        nl.parts.add(canon(i.id));
        const fp = ix.defs.get(i.def)?.footprint, pins = plain(i.pinNets) ? i.pinNets : {};
        const seen = new Set();
        for (const pad of fp?.pads || []) {
          const n = String(pad.number ?? ""); if (!n || seen.has(n)) continue; seen.add(n);
          const net = own(pins, n) ? pins[n] : pad.net || "";
          const w = num(pad.w) ? pad.w : num(pad.diameter) ? pad.diameter : 1, h = num(pad.h) ? pad.h : w;
          addPin(nl, canon, {net, part: i.id, number: n, label: i.ref + "." + n, ref: i.ref, pinName: pad.name || "", doc: doc.id, at: world([pad.x || 0, pad.y || 0], i),
            pad: {w, h, angle: (pad.angle || 0) + (i.angle || 0), layer: padLayers(pad, i)}});
        }
        for (const n of Object.keys(pins).sort(natural)) if (!seen.has(n)) addPin(nl, canon, {net: pins[n], part: i.id, number: n, label: i.ref + "." + n, ref: i.ref, pinName: "", doc: doc.id, at: [i.x, i.y]});
      } else if (i.kind === "pad" && i.net) {
        nl.parts.add(canon(i.id));
        const w = num(i.w) ? i.w : num(i.diameter) ? i.diameter : 1;
        addPin(nl, canon, {net: i.net, part: i.id, number: "pad", label: "Pad " + (i.number || i.name || "(free)"), ref: "", pinName: "", doc: doc.id, at: [i.x, i.y],
          pad: {w, h: num(i.h) ? i.h : w, angle: i.angle || 0, layer: num(i.drill) && i.drill > 0 || /multi/i.test(i.layer || "") ? null : i.layer || "Top"}});
      }
    }
    return nl;
  }
  // Which copper touches a pad: own-net copper (tracks, vias, pours of its net) and the nets of
  // any other copper touching it. Copper is indexed on a grid; only pads near a change are asked.
  function copperIndex(doc) {
    const cell = 2, grid = new Map(), pours = [];
    const put = (x0, y0, x1, y1, e) => {
      for (let x = Math.floor(x0 / cell); x <= Math.floor(x1 / cell); x++) for (let y = Math.floor(y0 / cell); y <= Math.floor(y1 / cell); y++) {
        const k = x + "," + y; if (!grid.has(k)) grid.set(k, []); grid.get(k).push(e);
      }
    };
    for (const i of doc.items) {
      if (i.kind === "track" && Array.isArray(i.points) && i.points.length > 1) {
        const w = num(i.width) ? i.width / 2 : 0.1;
        for (let n = 1; n < i.points.length; n++) {
          const a = i.points[n - 1], b = i.points[n];
          put(Math.min(a[0], b[0]) - w, Math.min(a[1], b[1]) - w, Math.max(a[0], b[0]) + w, Math.max(a[1], b[1]) + w, {seg: [a, b], r: w, net: i.net || "", layer: i.layer || "", id: i.id});
        }
      } else if (i.kind === "via" && num(i.x)) {
        const r = (num(i.diameter) ? i.diameter : 0.6) / 2;
        put(i.x - r, i.y - r, i.x + r, i.y + r, {pt: [i.x, i.y], r, net: i.net || "", layer: null, id: i.id});
      } else if (i.kind === "polygon" && Array.isArray(i.points) && i.points.length > 2 && !i.cutout && !i.keepout) pours.push({ring: i.points, net: i.net || "", layer: i.layer || "", id: i.id});
    }
    return {cell, grid, pours};
  }
  function inRing(p, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1] || 1e-12) + a[0]) inside = !inside;
    }
    return inside;
  }
  function attachment(index, info, o) {
    const pad = info.pad, at = info.at, own = info.net || "", out = {own: false, foreign: new Set(), ids: new Set()};
    if (!pad || !at) return out;
    const hw = pad.w / 2, hh = pad.h / 2, rad = -(pad.angle || 0) * Math.PI / 180, c = Math.cos(rad), sn = Math.sin(rad);
    const local = p => { const dx = p[0] - at[0], dy = p[1] - at[1]; return [dx * c - dy * sn, dx * sn + dy * c]; };
    // Distance from the pad rectangle to a point (0 inside), in the pad's frame.
    const rectDist = p => { const q = local(p), ex = Math.max(Math.abs(q[0]) - hw, 0), ey = Math.max(Math.abs(q[1]) - hh, 0); return Math.hypot(ex, ey); };
    const segDist = (a, b) => {
      let best = Math.min(rectDist(a), rectDist(b));
      for (let t = 1; t < 8 && best > 0; t++) best = Math.min(best, rectDist([a[0] + (b[0] - a[0]) * t / 8, a[1] + (b[1] - a[1]) * t / 8]));
      // The closest point of the segment to the pad centre.
      const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1, u = Math.max(0, Math.min(1, ((at[0] - a[0]) * dx + (at[1] - a[1]) * dy) / L));
      return Math.min(best, rectDist([a[0] + u * dx, a[1] + u * dy]));
    };
    const onLayer = l => pad.layer == null || l == null || l === "" || /multi/i.test(l) || l === pad.layer;
    const touch = e => { if (e.net === own && own) out.own = true; else if (e.net) out.foreign.add(e.net); out.ids.add(e.id); };
    const r = Math.hypot(hw, hh), seen = new Set();
    for (let x = Math.floor((at[0] - r) / index.cell); x <= Math.floor((at[0] + r) / index.cell); x++) for (let y = Math.floor((at[1] - r) / index.cell); y <= Math.floor((at[1] + r) / index.cell); y++) {
      for (const e of index.grid.get(x + "," + y) || []) {
        if (seen.has(e) || !onLayer(e.layer)) continue;
        seen.add(e);
        const d = e.seg ? segDist(e.seg[0], e.seg[1]) : rectDist(e.pt);
        if (d <= e.r + o.tolerance) touch(e);
      }
    }
    // A pour only joins its own net (it keeps clearance from other nets' pads).
    if (own && !out.own) for (const pr of index.pours) if (pr.net === own && onLayer(pr.layer) && inRing(at, pr.ring)) { out.own = true; break; }
    return out;
  }
  // Routed copper per net: track length per layer, arcs, vias and pour area.
  function copperOf(doc, o) {
    const nets = new Map();
    const get = n => { if (!nets.has(n)) nets.set(n, {tracks: 0, arcs: 0, length: 0, vias: 0, pours: 0, area: 0, pads: 0, layers: new Map(), box: null}); return nets.get(n); };
    const layer = (s, l) => { if (!s.layers.has(l)) s.layers.set(l, {length: 0, area: 0, tracks: 0}); return s.layers.get(l); };
    for (const i of doc.items) {
      if (!COPPER_KINDS.has(i.kind) || o.skipKinds.has(i.kind)) continue;
      const s = get(i.net || "");
      if (i.kind === "track" && Array.isArray(i.points)) {
        const len = pathLength(i.points); s.length += len; s.tracks++; if (i.arc) s.arcs++;
        const l = layer(s, i.layer || ""); l.length += len; l.tracks++;
        s.box = unionBox(s.box, boundsOf(i.points));
      } else if (i.kind === "via") { s.vias++; s.box = unionBox(s.box, [i.x, i.y, i.x, i.y]); }
      else if (i.kind === "pad") s.pads++;
      else if (i.kind === "polygon" && Array.isArray(i.points) && !i.cutout) {
        const a = polyArea(i.points); s.pours++; s.area += a; layer(s, i.layer || "").area += a; s.box = unionBox(s.box, boundsOf(i.points));
      }
    }
    return nets;
  }

  // ------------------------------------------------------------------ poured copper, by geometry
  // pcbDrawing.pours holds the poured copper as encoded regions (polygon-pour.js encode: per ring a
  // uint32 vertex count, then float64 x, -y pairs in Altium units; ring 0 the island, then its
  // holes). The same copper can be stored many ways: another ring start, ring / island / hole order,
  // redundant collinear vertices, an island split into other entries, a few nm of float noise
  // after a re-pour. Copper is compared per (layer, net, polygon) as a point set: equal when every
  // boundary of each side lies within copperTolerance of the other side's boundary (vertices,
  // and samples along edges longer than a grid cell, against a grid of edges) and the islands minus
  // holes cover the same area within that band. Stored data, links, arcs and signatures are
  // derived from that copper and never compared on their own.
  const ALTIUM_UNIT = 0.00000254;
  const B64 = (() => { const t = new Int16Array(128).fill(-1), s = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"; for (let i = 0; i < 64; i++) t[s.charCodeAt(i)] = i; return t; })();
  function bytesOf(text) {
    if (typeof Uint8Array.fromBase64 === "function") return Uint8Array.fromBase64(text);
    let n = text.length; while (n && text.charCodeAt(n - 1) === 61) n--;
    const out = new Uint8Array(Math.floor(n * 3 / 4));
    let bits = 0, value = 0, o = 0;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i), v = c < 128 ? B64[c] : -1;
      if (v < 0) throw Error("Invalid region data.");
      value = ((value << 6) | v) & 0xffffff; bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (value >> bits) & 255; }
    }
    return out;
  }
  const regionRings = new WeakMap();
  // Rings of one region as Float64Array [x0, y0, ...] in mm, or null when the data does not decode.
  function ringsOf(region) {
    if (regionRings.has(region)) return regionRings.get(region);
    let out = null;
    // The canvas's decoder caches the rings it paints (pcb-pours.js); the worker has none.
    try { out = globalThis.AtriumPCBPours?.contours ? globalThis.AtriumPCBPours.contours(region) : null; } catch { out = null; }
    if (out) { regionRings.set(region, out); return out; }
    try {
      const bytes = bytesOf(region.data), v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), count = region.count;
      if (!Number.isInteger(count) || count < 1) throw Error("count");
      out = [];
      let at = 0;
      for (let r = 0; r < count; r++) {
        if (at + 4 > bytes.length) throw Error("truncated");
        const n = v.getUint32(at, true); at += 4;
        if (n * 16 > bytes.length - at) throw Error("truncated");
        const ring = new Float64Array(n * 2);
        for (let i = 0; i < n; i++, at += 16) { ring[2 * i] = v.getFloat64(at, true) * ALTIUM_UNIT; ring[2 * i + 1] = -v.getFloat64(at + 8, true) * ALTIUM_UNIT; }
        if (!ring.every(Number.isFinite)) throw Error("vertex");
        out.push(ring);
      }
    } catch { out = null; }
    regionRings.set(region, out);
    return out;
  }
  // Poured copper of a board per "layer \0 net \0 polygon" (the polygon id through `canon`, so a
  // re-imported pour with another id pairs up): {layer, net, polygon, regions, rings, undecoded}.
  function pourGroups(doc, canon) {
    const groups = new Map(), pours = doc?.pcbDrawing?.pours;
    if (!Array.isArray(pours)) return groups;
    for (const r of pours) {
      if (!r || typeof r !== "object") continue;
      const polygon = r.polygon == null ? "" : canon(r.polygon), key = (r.layer || "") + "\u0000" + (r.net || "") + "\u0000" + polygon;
      let g = groups.get(key);
      if (!g) groups.set(key, g = {key, layer: r.layer || "", net: r.net || "", polygon: r.polygon ?? null, regions: [], rings: [], undecoded: []});
      g.regions.push(r);
      const rings = typeof r.data === "string" ? ringsOf(r) : null;
      if (!rings) { g.undecoded.push(r); continue; }
      rings.forEach((xy, k) => { if (xy.length >= 6) g.rings.push({xy, hole: k > 0}); });
    }
    return groups;
  }
  function ringsBox(rings) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const {xy} of rings) for (let i = 0; i < xy.length; i += 2) { const x = xy[i], y = xy[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    return x0 === Infinity ? null : [x0, y0, x1, y1];
  }
  // Boundary edges of a group as [x0, y0, x1, y1, ...], with the islands' area minus the holes' and the perimeter.
  function edgesOf(rings) {
    let n = 0;
    for (const {xy} of rings) n += xy.length >> 1;
    const E = new Float64Array(n * 4);
    let k = 0, area = 0, perimeter = 0;
    for (const {xy, hole} of rings) {
      const m = xy.length >> 1;
      let s = 0;
      for (let i = 0, j = m - 1; i < m; j = i++) {
        const ax = xy[2 * j], ay = xy[2 * j + 1], bx = xy[2 * i], by = xy[2 * i + 1];
        s += ax * by - bx * ay;
        if (ax === bx && ay === by) continue;
        E[k++] = ax; E[k++] = ay; E[k++] = bx; E[k++] = by;
        perimeter += Math.hypot(bx - ax, by - ay);
      }
      area += (hole ? -1 : 1) * Math.abs(s) / 2;
    }
    return {E: k === E.length ? E : E.subarray(0, k), count: k >> 2, area, perimeter};
  }
  // Edges on a uniform grid (CSR: start[cell] .. start[cell + 1] in list). Each edge goes into every
  // cell its tol-widened band crosses, so a point is within tol of an edge only if that edge is
  // listed in a cell the point's tol-box meets. About one cell per edge, at most 2048 x 2048 cells.
  function edgeGrid(S, tol, box) {
    const w = box[2] - box[0], h = box[3] - box[1];
    const cell = Math.max(8 * tol, S.perimeter / Math.max(1, 2 * S.count), Math.sqrt(w * h / Math.max(1, S.count)), Math.max(w, h) / 2048, 1e-6);
    const cols = Math.floor(w / cell) + 1, rows = Math.floor(h / cell) + 1, x0 = box[0], y0 = box[1], E = S.E;
    const start = new Int32Array(cols * rows + 1);
    let list = null;
    // pass 0 counts, pass 1 fills (start[] then holds each cell's next free slot, shifted back after).
    for (let pass = 0; pass < 2; pass++) {
      for (let e = 0; e < S.count; e++) {
        const ax = E[4 * e] - x0, ay = E[4 * e + 1] - y0, bx = E[4 * e + 2] - x0, by = E[4 * e + 3] - y0;
        const r0 = Math.max(0, Math.floor((Math.min(ay, by) - tol) / cell)), r1 = Math.min(rows - 1, Math.floor((Math.max(ay, by) + tol) / cell));
        if (r0 === r1) {
          // One row (most edges): the widened x range of the whole edge.
          const c0 = Math.max(0, Math.floor((Math.min(ax, bx) - tol) / cell)), c1 = Math.min(cols - 1, Math.floor((Math.max(ax, bx) + tol) / cell));
          for (let k = r0 * cols + c0, end = r0 * cols + c1; k <= end; k++) { if (pass) list[start[k]++] = e; else start[k + 1]++; }
          continue;
        }
        for (let r = r0; r <= r1; r++) {
          // The edge's x range inside this row band (widened by tol).
          let xa, xb;
          if (ay === by) { xa = Math.min(ax, bx); xb = Math.max(ax, bx); }
          else {
            const lo = Math.max(r * cell - tol, Math.min(ay, by)), hi = Math.min((r + 1) * cell + tol, Math.max(ay, by));
            const xl = ax + (bx - ax) * (lo - ay) / (by - ay), xh = ax + (bx - ax) * (hi - ay) / (by - ay);
            xa = Math.min(xl, xh); xb = Math.max(xl, xh);
          }
          const c0 = Math.max(0, Math.floor((xa - tol) / cell)), c1 = Math.min(cols - 1, Math.floor((xb + tol) / cell));
          for (let c = c0, k = r * cols + c0; c <= c1; c++, k++) { if (pass) list[start[k]++] = e; else start[k + 1]++; }
        }
      }
      if (!pass) { for (let k = 1; k < start.length; k++) start[k] += start[k - 1]; list = new Int32Array(start[start.length - 1]); }
    }
    for (let k = start.length - 1; k > 0; k--) start[k] = start[k - 1];
    start[0] = 0;
    return {cell, cols, rows, x0, y0, start, list, E};
  }
  function nearEdge(G, px, py, tol) {
    const tt = tol * tol, E = G.E, start = G.start, list = G.list, cell = G.cell;
    const c0 = Math.max(0, Math.floor((px - G.x0 - tol) / cell)), c1 = Math.min(G.cols - 1, Math.floor((px - G.x0 + tol) / cell));
    const r0 = Math.max(0, Math.floor((py - G.y0 - tol) / cell)), r1 = Math.min(G.rows - 1, Math.floor((py - G.y0 + tol) / cell));
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
      const k = r * G.cols + c;
      for (let j = start[k], end = start[k + 1]; j < end; j++) {
        const e = list[j], ax = E[4 * e], ay = E[4 * e + 1], dx = E[4 * e + 2] - ax, dy = E[4 * e + 3] - ay;
        const L = dx * dx + dy * dy, u = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
        const ex = ax + u * dx - px, ey = ay + u * dy - py;
        if (ex * ex + ey * ey <= tt) return true;
      }
    }
    return false;
  }
  // Box of the points of S's boundary farther than tol from G's edges (null: none).
  function strayBox(S, G, tol) {
    const E = S.E, step = G.cell;
    let box = null;
    const test = (x, y) => { if (!nearEdge(G, x, y, tol)) box = box ? [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)] : [x, y, x, y]; };
    for (let e = 0; e < S.count; e++) {
      const ax = E[4 * e], ay = E[4 * e + 1], bx = E[4 * e + 2], by = E[4 * e + 3];
      const parts = Math.max(1, Math.floor(Math.hypot(bx - ax, by - ay) / step));
      test(ax, ay);
      for (let i = 1; i < parts; i++) test(ax + (bx - ax) * i / parts, ay + (by - ay) * i / parts);
    }
    return box;
  }
  // null when two groups' copper is the same within tol, else {box} around where it differs.
  function copperDelta(ga, gb, tol, motion) {
    const ra = ga ? ga.rings : [], rb = gb ? gb.rings : [];
    // Byte-identical storage (the usual unchanged board) needs no geometry.
    if (!motion && ga && gb && ga.regions.length === gb.regions.length && ga.regions.every((r, i) => r.data === gb.regions[i].data && r.count === gb.regions[i].count)) return null;
    const ua = ga ? ga.undecoded : [], ub = gb ? gb.undecoded : [];
    // Regions that do not decode (foreign or damaged data) compare as stored.
    const undecodedSame = ua.length === ub.length && ua.every(r => ub.some(s => s.data === r.data && s.count === r.count));
    const boxA = ringsBox(ra), boxB = ringsBox(rb), all = unionBox(boxA, boxB);
    if (!all) return undecodedSame ? null : {box: null};
    if (!boxA || !boxB) return {box: all};
    const A = edgesOf(ra), B = edgesOf(rb);
    const pad = [all[0] - tol, all[1] - tol, all[2] + tol, all[3] + tol];
    let box = unionBox(strayBox(A, edgeGrid(B, tol, pad), tol), strayBox(B, edgeGrid(A, tol, pad), tol));
    // Same boundaries, other sides of them copper (an island taken for a hole): the area tells.
    if (!box && Math.abs(A.area - B.area) > tol * (A.perimeter + B.perimeter) + 1e-9) box = all;
    if (!box && !undecodedSame) box = all;
    return box ? {box} : null;
  }
  // The copper differences of two boards: [{key, layer, net, polygon, a, b, box}], in key order.
  function pourChanges(da, db, canon, tol, motion) {
    const GA = pourGroups(da, canon), GB = pourGroups(db, id => id), out = [];
    for (const key of [...new Set([...GA.keys(), ...GB.keys()])].sort(natural)) {
      const a = GA.get(key) || null, b = GB.get(key) || null;
      if (motion && a) for (const ring of a.rings) {
        // ringsOf may share an immutable decode cache; registration owns its coordinates.
        const xy = new Float64Array(ring.xy);
        for (let i=0;i<xy.length;i+=2) { xy[i] += motion.dx; xy[i+1] += motion.dy; }
        ring.xy = xy;
      }
      const d = copperDelta(a, b, tol, motion);
      if (d) out.push({key, layer: (b || a).layer, net: (b || a).net, polygon: (b || a).polygon, a, b, box: d.box});
    }
    return out;
  }
  // pcbDrawing apart from the copper and what is derived from it (signatures over that copper).
  const POUR_DERIVED = new Set(["pours", "pourSignatures", "pourSignatureVersion", "importedPourSignature"]);
  function drawingRest(d) {
    if (!plain(d)) return d ?? null;
    const out = {};
    if (!globalThis.AtriumPourMarker && (Object.hasOwn(d,"pourUnverified") || Object.hasOwn(d,"wafflePourUnverified"))) {
      if (typeof require === "function") require("../pcb/pour-marker.js");
      else if (typeof importScripts === "function") importScripts("../pcb/pour-marker.js");
    }
    const marker = globalThis.AtriumPourMarker?.key(d);
    for (const k of Object.keys(d)) if (k !== marker && !POUR_DERIVED.has(k)) out[k] = d[k];
    return out;
  }

  // ------------------------------------------------------------------ the comparison
  function *compareSteps(before, after, opts, cache) {
    const t0 = now(), o = options(opts), phases = {};
    let mark = t0;
    const phase = name => { const t = now(); phases[name] = round(t - mark, 2); mark = t; };
    if (!before || !after || !Array.isArray(before.documents) || !Array.isArray(after.documents)) throw Error("Compare two Waffle projects.");
    const IA = cache?.before === before && cache.index ? cache.index : indexOf(before);
    if (cache && cache.before === before) cache.index = IA;
    const IB = indexOf(after);
    const hasNotes=IA.notes.size || IB.notes.size;
    if(hasNotes && !globalThis.AtriumNotebook) {
      // @ts-ignore The synchronous engine also runs in Node and in a dedicated worker.
      if(typeof require==="function") {require("../notebook/note-fields.js");require("../notebook/notebook.js");}
      else if(typeof importScripts==="function") importScripts("../notebook/note-fields.js","../notebook/notebook.js");
    }
    const notebook=hasNotes && globalThis.AtriumNotebook;
    const noteA=notebook && notebook.prepare(before,opts?.notebookBefore),noteB=notebook && notebook.prepare(after,opts?.notebookAfter);
    const previously = {...IA.prepared};
    phase("index");
    const M = yield* matchSteps(IA, IB, o);
    phase("match");
    const changes = [];
    const proposed = new Map();
    for (const m of M.components) if (m.review && m.after) {
      const evidence = {by:m.by,confidence:m.confidence,reasons:m.reasons,review:true};
      proposed.set(m.before,evidence); proposed.set(m.after,evidence);
    }
    let suppressed = {order: 0, autoNetNames: 0, pourFill: 0, metadata: 0, resegmented: 0};
    let tick = 0;
    const canonA = id => M.items.get(id)?.id ?? "\u0001" + id, canonB = id => id;
    const docName = (side, id) => (side === "a" ? IA : IB).docs.get(id)?.name || "";
    function push(c) {
      if (!c.match && c.target.part) c.match = proposed.get(c.target.part) || null;
      if (c.match?.review) c.text = "Possible change · " + c.text;
      c.severity = c.severity || "cosmetic";
      c.status = statusOf(c.kind);
      if (c.target.label == null) c.target.label = (typeof c.target.pin === "string" ? c.target.pin : "") || c.target.ref || (c.target.net ? "Net " + c.target.net : "") || c.target.name || c.target.docName || "";
      c.id = c.kind + ":" + (c.target.afterId || c.target.beforeId || c.target.net || c.target.name || "") + (c.idSuffix ? ":" + c.idSuffix : "");
      delete c.idSuffix;
      changes.push(c);
      return c;
    }
    const target = (type, a, b, docA, docB, extra) => {
      const i = b || a, d = docB || docA;
      return {type, id: i?.id ?? null, beforeId: a?.id ?? null, afterId: b?.id ?? null, doc: d?.id ?? null, docName: d?.name ?? "",
        ref: i?.ref ?? null, net: i?.net ?? null, layer: i?.layer ?? null, ...(extra || {})};
    };
    const geometry = (docKind, docId, a, b, ga, gb) => {
      const before = a ? shapeOf(a, ga, docKind) : null, after = b ? shapeOf(b, gb, docKind) : null, at = after || before;
      return at ? {doc: docId, box: unionBox(before?.box, after?.box), before, after} : null;
    };
    const matchInfo = a => { const m = a ? M.items.get(a.id) : null; if (!m) return null; const {id, ...info} = m; return info; };
    // Parts by link (built on first use): does another part linked as `la` before pair with one linked as `lb` after?
    let links = null;
    const linkedPair = (la, lb, self) => {
      if (typeof la !== "string" || typeof lb !== "string" || !la || !lb) return false;
      if (!links) {
        links = {a: new Map(), b: new Set()};
        for (const [id, e] of IA.items) if (e.item.kind === "part" && e.item.link) { if (!links.a.has(e.item.link)) links.a.set(e.item.link, []); links.a.get(e.item.link).push(id); }
        for (const [id, e] of IB.items) if (e.item.kind === "part" && e.item.link) links.b.add(id + "\u0000" + e.item.link);
      }
      return (links.a.get(la) || []).some(id => id !== self && links.b.has(M.items.get(id)?.id + "\u0000" + lb));
    };

    // ---------------- connectivity first, so object rows know which nets changed
    const touchedNets = new Set();
    const netLists = {a: {}, b: {}};
    const canonDocA = id => M.docs.get(id) ?? "\u0001" + id;
    // A session keeps the baseline's netlist under the baseline's own ids and re-keys it through
    // this comparison's matching, so a re-matched object never reads a stale key.
    const oldFrames = extractedFrames(IB,IA), newFrames = extractedFrames(IA,IB);
    netLists.a.schematic = (IA.rawNets || cache || oldFrames.size) ? rekey(rawNets(IA, o), canonA, oldFrames) : schematicNetlist(IA, canonA, o);
    const afterNets = rawNets(IB, o);
    netLists.b.schematic = newFrames.size ? rekey(afterNets,canonB,newFrames) : afterNets;
    yield;
    const boardsA = new Map(), boardsB = new Map();
    for (const d of IA.p.documents) if (d.kind === "pcb") boardsA.set(canonDocA(d.id), {doc: d, nl: boardNetlist(IA, d, canonA), copper: copperOf(d, o)});
    for (const d of IB.p.documents) if (d.kind === "pcb") boardsB.set(d.id, {doc: d, nl: boardNetlist(IB, d, canonB), copper: copperOf(d, o)});
    phase("netlists");
    yield;
    const byNet = Object.create(null);
    const netEntry = name => byNet[name] || (byNet[name] = {name, status: "changed", renamedFrom: null, renamedTo: null, schematic: null, boards: {}, changes: []});
    function *netDiff(domain, NA, NB, docKind, docId, docLabel) {
      // Overlap of every before net with every after net, by shared pin keys. Nets are visited in
      // natural name order and ties go to the natural-first name, so file order never matters.
      const namesA = [...NA.nets.keys()].sort(natural), namesB = [...NB.nets.keys()].sort(natural);
      const dest = new Map(), src = new Map(); // net -> Map(other net -> shared pins)
      const confirmed = new Map();
      for (const a of namesA) {
        const c = new Map();
        for (const k of NA.nets.get(a)) {
          const n = NB.byPin.get(k);
          if (n == null) continue;
          c.set(n,(c.get(n) || 0)+1);
          if (proposed.size && !proposed.has(NA.pins.get(k).part)) {
            if (!confirmed.has(a)) confirmed.set(a,new Set());
            confirmed.get(a).add(n);
          }
        }
        dest.set(a, c);
        for (const [b, n] of c) { if (!src.has(b)) src.set(b, new Map()); src.get(b).set(a, n); }
        if ((++tick & 255) === 0) yield;
      }
      for (const b of namesB) if (!src.has(b)) src.set(b, new Map());
      const best = m => { let top = null, n = 0; for (const [k, v] of m) if (v > n || v === n && top != null && natural(k, top) < 0) { top = k; n = v; } return top; };
      const surviving = a => { let n = 0; for (const v of dest.get(a).values()) n += v; return n; };
      const incoming = b => { let n = 0; for (const v of src.get(b).values()) n += v; return n; };
      // A net keeps its identity when its name exists on both sides and shares pins.
      const keeps = new Set(namesA.filter(a => (dest.get(a).get(a) || 0) > 0));
      // Absorbed: every surviving pin of a before net went to one after net. Pieces: every pin of
      // an after net that existed before came from one before net.
      const absorbedInto = new Map(), pieceOf = new Map();
      for (const a of namesA) { const d = dest.get(a); if (d.size === 1) absorbedInto.set(a, [...d.keys()][0]); }
      for (const b of namesB) { const sm = src.get(b); if (sm.size === 1) pieceOf.set(b, [...sm.keys()][0]); }
      const mapTo = new Map(); // before net -> Set(after nets it became); renames also in rename
      const addMap = (a, b) => { if (!mapTo.has(a)) mapTo.set(a, new Set()); mapTo.get(a).add(b); };
      for (const a of keeps) addMap(a, a);
      // Merges: two or more before nets (each with ≥2 pins, or the after net's own) wholly in one after net.
      const merged = new Map();
      for (const b of namesB) {
        const parts = [...src.get(b).keys()].filter(a => absorbedInto.get(a) === b && (a === b && keeps.has(a) || surviving(a) >= 2)).sort(natural);
        if (parts.length >= 2) { merged.set(b, parts); for (const a of parts) addMap(a, b); }
      }
      // Splits: a before net whose pins now form two or more after nets (each ≥2 pins, or its own).
      const splitOf = new Map();
      for (const a of namesA) {
        const pieces = [...dest.get(a).keys()].filter(b => pieceOf.get(b) === a && (b === a && keeps.has(a) || incoming(b) >= 2) && !merged.has(b)).sort(natural);
        if (pieces.length >= 2) for (const b of pieces) { splitOf.set(b, a); addMap(a, b); }
      }
      // Renames: neither name keeps its identity, and the two are each other's main counterpart.
      const renames = [], rename = new Map();
      for (const a of namesA) {
        if (keeps.has(a) || [...(mapTo.get(a) || [])].length) continue;
        const b = best(dest.get(a));
        if (b == null || b === a || NA.nets.has(b) && keeps.has(b) || merged.has(b) || splitOf.has(b) || best(src.get(b)) !== a) continue;
        renames.push([a, b]); rename.set(a, b); addMap(a, b);
      }
      const label = (nl, k) => nl.pins.get(k)?.label || k;
      const at = (nl, k) => nl.pins.get(k)?.at || null;
      const netGeom = (keys, nl) => {
        let box = null;
        for (const k of keys) { const p = at(nl, k); if (p) box = unionBox(box, [p[0] - 0.6, p[1] - 0.6, p[0] + 0.6, p[1] + 0.6]); }
        return box ? {doc: docId ?? nl.pins.get(keys[0])?.doc ?? null, box, before: null, after: {box, path: null, closed: false, width: 0, round: false}} : null;
      };
      const domainName = domain === "schematic" ? "Schematic" : "PCB " + docLabel;
      const base = (kind, name, severity, extra) => {
        let conditional = false;
        if (proposed.size) {
          if (kind === "net.renamed") conditional = !confirmed.get(extra.beforeNet)?.has(name);
          if (kind === "net.merged") conditional = extra.beforeNets.some(n => !confirmed.get(n)?.has(name));
          if (kind === "net.split") conditional = extra.afterNets.some(n => !confirmed.get(name)?.has(n));
        }
        return {kind, category:"connectivity", severity, target:{type:"net",id:null,net:name,domain,doc:docId,docName:docLabel,...extra},
          match:conditional ? {by:"topology",review:true,confidence:null,reasons:["This net correspondence depends on a proposed component match"]} : null,fields:[]};
      };
      // Renames.
      for (const [a, b] of renames) {
        const pa = NA.nets.get(a), pb = NB.nets.get(b);
        const equal = pa.size === pb.size && [...pa].every(k => pb.has(k));
        if (equal && o.ignoreAutoNetNames && AUTO_NET.test(a) && AUTO_NET.test(b)) { suppressed.autoNetNames++; continue; }
        const c = push({...base("net.renamed", b, "electrical", {beforeNet: a}), before: a, after: b, idSuffix: domain,
          text: domainName + ": net " + a + " renamed to " + b, geometry: netGeom([...pb], NB)});
        touchedNets.add(a); touchedNets.add(b);
        const e = netEntry(b); e.renamedFrom = a; e.changes.push(c); netEntry(a).renamedTo = b;
      }
      // Merges.
      for (const [b, from] of merged) {
        const all = from;
        const c = push({...base("net.merged", b, "electrical", {beforeNets: all}), before: all, after: b, idSuffix: domain,
          text: domainName + ": " + (all.filter(n => n !== b).length > 1 ? "nets " : "net ") + list(all.filter(n => n !== b)) + " merged into " + b, geometry: netGeom([...NB.nets.get(b)], NB)});
        for (const n of all) touchedNets.add(n);
        touchedNets.add(b); netEntry(b).changes.push(c);
      }
      // Splits.
      const pieces = new Map();
      for (const [b, a] of [...splitOf].sort((x, y) => natural(x[0], y[0]))) { if (!pieces.has(a)) pieces.set(a, []); pieces.get(a).push(b); }
      for (const [a, all] of pieces) {
        const bs = all.filter(b => b !== a);
        const moved = bs.flatMap(b => [...NB.nets.get(b)].map(k => label(NB, k))).sort(natural);
        const c = push({...base("net.split", a, "electrical", {afterNets: bs}), before: a, after: bs, idSuffix: domain,
          text: domainName + ": net " + a + " split; " + list(moved) + " now on " + list(bs), geometry: netGeom(bs.flatMap(b => [...NB.nets.get(b)]), NB)});
        touchedNets.add(a); for (const b of bs) touchedNets.add(b);
        netEntry(a).changes.push(c);
      }
      // Pin moves, swaps, connections.
      const moves = [];
      const explained = (na, nb) => na === nb || !!mapTo.get(na)?.has(nb);
      const keysB = [...NB.byPin.keys()].sort(), keysA = [...NA.byPin.keys()].sort();
      for (const k of keysB) {
        const nb = NB.byPin.get(k), na = NA.byPin.get(k);
        if (na == null) { if (NA.parts.has(NB.pins.get(k).cpart)) moves.push({k, na: null, nb}); }
        else if (!explained(na, nb)) moves.push({k, na, nb});
        if ((++tick & 1023) === 0) yield;
      }
      for (const k of keysA) {
        if (NB.byPin.has(k)) continue;
        if (NB.parts.has(NA.pins.get(k).cpart)) moves.push({k, na: NA.byPin.get(k), nb: null});
      }
      // Swaps: two pins of one part that exchanged nets.
      const byPart = new Map();
      for (const m of moves) if (m.na && m.nb) { const part = NB.pins.get(m.k).cpart; if (!byPart.has(part)) byPart.set(part, []); byPart.get(part).push(m); }
      const swapped = new Set();
      const eqNet = (x, y) => x === y || !!mapTo.get(x)?.has(y);
      for (const ms of byPart.values()) for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
        const p = ms[i], r = ms[j];
        if (swapped.has(p) || swapped.has(r)) continue;
        if (eqNet(p.na, r.nb) && eqNet(r.na, p.nb)) {
          swapped.add(p); swapped.add(r);
          const lp = label(NB, p.k), lr = label(NB, r.k), pinB = NB.pins.get(p.k), pinR = NB.pins.get(r.k);
          const c = push({...base("pin.swapped", p.nb, "electrical", {pins: [lp, lr], part: pinB?.part ?? null, ref: pinB?.ref ?? null}), before: {[lp]: p.na, [lr]: r.na}, after: {[lp]: p.nb, [lr]: r.nb},
            idSuffix: domain + ":" + p.k + ":" + r.k, text: domainName + ": " + (pinB?.ref || "") + " pins " + pinB?.number + " and " + pinR?.number + " swapped (" + p.na + " ↔ " + r.na + ")",
            geometry: netGeom([p.k, r.k], NB)});
          for (const n of [p.na, p.nb, r.na, r.nb]) { touchedNets.add(n); netEntry(n).changes.push(c); }
        }
      }
      for (const m of moves) {
        if (swapped.has(m)) continue;
        const nl = m.nb ? NB : NA, pin = nl.pins.get(m.k), lab = pin?.label || m.k;
        const kind = m.na && m.nb ? "pin.moved" : m.nb ? "pin.connected" : "pin.disconnected";
        const text = domainName + ": " + lab + (kind === "pin.moved" ? " moved from " + m.na + " to " + m.nb : kind === "pin.connected" ? " connected to " + m.nb : " disconnected from " + m.na);
        const c = push({...base(kind, m.nb || m.na, "electrical", {pin: lab, part: pin?.part ?? null, ref: pin?.ref ?? null, beforeNet: m.na, afterNet: m.nb}), before: m.na, after: m.nb,
          idSuffix: domain + ":" + m.k, text, geometry: netGeom([m.k], nl)});
        for (const n of [m.na, m.nb]) if (n) { touchedNets.add(n); netEntry(n).changes.push(c); }
      }
      // Whole nets added or removed (not renames, merges or splits).
      for (const b of namesB) {
        if (src.get(b).size || splitOf.has(b)) continue;
        const keys = [...NB.nets.get(b)], pins = keys.map(k => label(NB, k)).sort(natural);
        const c = push({...base("net.added", b, "electrical", {pins}), before: null, after: pins, idSuffix: domain, text: domainName + ": net " + b + " added (" + list(pins) + ")", geometry: netGeom(keys, NB)});
        touchedNets.add(b); netEntry(b).status = "added"; netEntry(b).changes.push(c);
      }
      for (const a of namesA) {
        if (dest.get(a).size) continue;
        const keys = [...NA.nets.get(a)], pins = keys.map(k => label(NA, k)).sort(natural);
        const c = push({...base("net.removed", a, "electrical", {pins}), before: pins, after: null, idSuffix: domain, text: domainName + ": net " + a + " removed (was " + list(pins) + ")", geometry: netGeom(keys, NA)});
        touchedNets.add(a); netEntry(a).status = "removed"; netEntry(a).changes.push(c);
      }
      // Membership for byNet (both sides, labels per side).
      const names = new Set([...NA.nets.keys(), ...NB.nets.keys()]);
      for (const n of names) {
        const pa = NA.nets.get(n) || new Set(), pb = NB.nets.get(n) || new Set();
        const gained = [...pb].filter(k => !pa.has(k)), lost = [...pa].filter(k => !pb.has(k));
        if (!gained.length && !lost.length && !touchedNets.has(n)) continue;
        const rec = {before: [...pa].map(k => ({key: k, label: label(NA, k), doc: NA.pins.get(k)?.doc ?? null})), after: [...pb].map(k => ({key: k, label: label(NB, k), doc: NB.pins.get(k)?.doc ?? null})),
          gained: gained.map(k => label(NB, k)).sort(natural), lost: lost.map(k => label(NA, k)).sort(natural)};
        const e = netEntry(n);
        if (domain === "schematic") e.schematic = rec; else e.boards[docId] = {...(e.boards[docId] || {}), ...rec};
        if (!NA.nets.has(n) && e.status !== "added" && !e.renamedFrom) e.status = "added";
        if (!NB.nets.has(n) && e.status !== "removed" && !e.renamedTo) e.status = "removed";
      }
      return {rename, mapTo};
    }
    yield* netDiff("schematic", netLists.a.schematic, netLists.b.schematic, "schematic", null, "");
    const boardMaps = new Map();
    for (const [id, B] of boardsB) {
      const Aa = boardsA.get(id) || {doc: null, nl: newList(), copper: new Map()};
      boardMaps.set(id, yield* netDiff("pcb:" + id, Aa.nl, B.nl, "pcb", id, B.doc.name));
    }
    phase("connectivity");

    // ---------------- documents
    const docPairs = [];
    for (const [da, db] of M.docs) docPairs.push([IA.docs.get(da), IB.docs.get(db)]);
    const matchedB = new Set(M.docs.values());
    for (const d of IA.docs.values()) if (!M.docs.has(d.id)) docPairs.push([d, null]);
    for (const d of IB.docs.values()) if (!matchedB.has(d.id)) docPairs.push([null, d]);
    // Poured copper and what derives from it are compared below by geometry, never field by field.
    const docSkip = new Set(["id", "items", "outline", "rules", "stackup", "rooms", "componentClasses", "boardShape", ...POUR_DOC, ...(o.ignoreMetadata || o.ignorePourFill ? META_DOC : []), ...(globalThis.AtriumWaivers ? ["drcWaivers"] : [])]);
    const copperTol = num(o.copperTolerance) && o.copperTolerance > 0 ? o.copperTolerance : DEFAULTS.copperTolerance;
    for (const [a, b] of docPairs) {
      const d = b || a, area = d.kind === "pcb" ? "pcb" : "schematic", what = d.kind === "pcb" ? "Board" : d.kind === "schematic" ? "Sheet" : "Document";
      if (!a || !b) {
        const parts = (d.items || []).filter(i => i.kind === "part").length;
        push({kind: "document." + (a ? "removed" : "added"), category: area, severity: parts ? "electrical" : "cosmetic", target: {type: "document", id: d.id, beforeId: a?.id ?? null, afterId: b?.id ?? null, doc: d.id, docName: d.name},
          before: a ? {name: a.name, kind: a.kind, items: a.items.length} : null, after: b ? {name: b.name, kind: b.kind, items: b.items.length} : null,
          text: what + " " + d.name + " " + (a ? "removed" : "added") + " (" + plural(d.items.length, "object") + ")", geometry: null, match: null, fields: []});
        continue;
      }
      const m = M.docBy.get(a.id);
      if (a.name !== b.name) push({kind: "document.renamed", category: area, severity: "cosmetic", target: {type: "document", id: b.id, beforeId: a.id, afterId: b.id, doc: b.id, docName: b.name},
        before: a.name, after: b.name, text: what + " " + a.name + " renamed to " + b.name, geometry: null, match: m, fields: ["name"]});
      for (const f of fieldDiff(a, b, o, new Set([...docSkip, "name"]))) {
        const sev = f === "origin" ? "mechanical" : "cosmetic";
        push({kind: "document.setting", category: area, severity: sev, target: {type: "document", id: b.id, beforeId: a.id, afterId: b.id, doc: b.id, docName: b.name, field: f},
          before: a[f] ?? null, after: b[f] ?? null, idSuffix: f, text: what + " " + b.name + ": " + f + " " + fmt(a[f]) + " → " + fmt(b[f]), geometry: null, match: m, fields: [f]});
      }
      for (const f of META_DOC) if ((o.ignoreMetadata || o.ignorePourFill) && !same(a[f], b[f], o, f)) suppressed.metadata++;
      // pcbDrawing apart from the copper (component annotations, the source-fill flag): as stored.
      const ra = drawingRest(a.pcbDrawing), rb = drawingRest(b.pcbDrawing);
      if (!same(ra, rb, o, "pcbDrawing")) {
        if (o.ignoreMetadata || o.ignorePourFill) suppressed.pourFill++;
        else push({kind: "document.setting", category: area, severity: "cosmetic", target: {type: "document", id: b.id, beforeId: a.id, afterId: b.id, doc: b.id, docName: b.name, field: "pcbDrawing"},
          before: ra, after: rb, idSuffix: "pcbDrawing", text: what + " " + b.name + ": pcbDrawing " + fmt(ra) + " → " + fmt(rb), geometry: null, match: m, fields: ["pcbDrawing"]});
      }
      // Poured copper by geometry: a re-encoded or re-poured unchanged board is no change at all.
      // Its signatures (pourSignatures, sourcePourSignature) are derived and never compared.
      const poured = pourChanges(a, b, canonA, copperTol, M.motions.get(a.id));
      if (o.ignorePourFill) suppressed.pourFill += poured.length;
      else for (const pc of poured) {
        const where = (pc.net ? " on " + pc.net : "") + (pc.layer ? " (" + pc.layer + ")" : ""), grow = 0.25;
        const box = pc.box ? [pc.box[0] - grow, pc.box[1] - grow, pc.box[2] + grow, pc.box[3] + grow] : null;
        const shape = box ? {box, path: null, closed: true, width: 0, round: false} : null;
        const islands = g => g ? g.rings.filter(r => !r.hole).length : 0, verb = !pc.a ? ".added" : !pc.b ? ".removed" : "";
        const afterId = pc.b ? pc.polygon : null, beforeId = pc.a ? pc.a.polygon : null;
        push({kind: "pour.copper" + verb, category: "pcb", severity: "mechanical",
          target: {type: "pour", id: afterId ?? beforeId, beforeId, afterId, doc: b.id, docName: b.name, ref: null, net: pc.net, layer: pc.layer, label: "Pour copper" + where},
          before: pc.a ? {islands: islands(pc.a), regions: pc.a.regions.length} : null, after: pc.b ? {islands: islands(pc.b), regions: pc.b.regions.length} : null, idSuffix: pc.layer + "/" + pc.net,
          text: "Poured copper" + where + (verb === ".added" ? " added" : verb === ".removed" ? " removed" : " changed") + " (" + plural(islands(pc.a), "island") + " → " + plural(islands(pc.b), "island") + ")",
          geometry: box ? {doc: b.id, box, before: pc.a ? shape : null, after: pc.b ? shape : null} : null, match: m, fields: ["pcbDrawing"]});
      }
      if (d.kind === "pcb") {
        const motion = M.motions.get(a.id);
        if (!motion && !sameRing(a.outline || [], b.outline || [], o)) {
          const ba = boundsOf(a.outline || []), bb = boundsOf(b.outline || []);
          const size = x => x ? round(x[2] - x[0], 3) + " × " + round(x[3] - x[1], 3) + " mm" : "none";
          const aa = (a.outline || []).length > 2 ? polyArea(a.outline) : 0, ab = (b.outline || []).length > 2 ? polyArea(b.outline) : 0;
          push({kind: "board.outline", category: "pcb", severity: "mechanical", target: {type: "outline", id: b.id, beforeId: a.id, afterId: b.id, doc: b.id, docName: b.name},
            before: a.outline || [], after: b.outline || [], text: "Board outline of " + b.name + " changed: " + size(ba) + " → " + size(bb) + (Math.abs(ab - aa) > o.areaTolerance ? " (area " + signed(ab - aa, 2) + " mm²)" : ""),
            geometry: {doc: b.id, box: unionBox(ba, bb), before: ba ? {box: ba, path: a.outline, closed: true, width: 0, round: false} : null, after: bb ? {box: bb, path: b.outline, closed: true, width: 0, round: false} : null},
            match: m, fields: ["outline"], areaDelta: round(ab - aa, 3)});
        }
        if (!sameBoardShape(a,b,motion,o)) push({kind: "board.shape", category: "pcb", severity: "mechanical", target: {type: "outline", id: b.id, beforeId: a.id, afterId: b.id, doc: b.id, docName: b.name},
          before: a.boardShape ?? null, after: b.boardShape ?? null, text: "Board shape (cutouts, bends) of " + b.name + " changed", geometry: null, match: m, fields: ["boardShape"]});
        stackupDiff(a, b, o, push, m);
        keyedDiff(a.rooms, b.rooms, "room", "Room", "pcb", "mechanical", b, push, o);
        keyedDiff(a.componentClasses, b.componentClasses, "componentClass", "Component class", "rules", "electrical", b, push, o);
      }
      const signalsOn = d.kind === "pcb" && signalsIn(before, after);
      if (!same(a.rules, b.rules, o)) rulesDiff(a.rules, b.rules, b, push, o, signalsOn);
      if (signalsOn) signalsDiff(before, after, a, b, push, o);
      if (!o.ignoreMetadata && !same(a.sourceRules, b.sourceRules, o)) push({kind: "rules.source", category: "rules", severity: "mechanical", target: {type: "rules", id: b.id, doc: b.id, docName: b.name},
        before: (a.sourceRules || []).length, after: (b.sourceRules || []).length, text: "Imported source rules of " + b.name + " changed", geometry: null, match: null, fields: ["sourceRules"]});
      yield;
    }
    phase("documents");

    // ---------------- objects
    const removedB = new Set();
    // A track drawn as one polyline in one file and as separate segments in another (another
    // tool's export, a re-import), or broken at a collinear point, is the same copper. Per
    // document, net, layer and width, the tracks that are unmatched or whose path changed are
    // reduced to maximal collinear segments on each side; equal sets are not a change.
    const resegmented = new Set();
    const lines = segs => {
      const byLine = new Map();
      for (const [a, b] of segs) {
        let dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy); if (len <= o.tolerance) continue;
        dx /= len; dy /= len;
        if (dx < -1e-9 || Math.abs(dx) <= 1e-9 && dy < 0) { dx = -dx; dy = -dy; }
        const off = a[0] * dy - a[1] * dx, t0 = a[0] * dx + a[1] * dy, t1 = b[0] * dx + b[1] * dy;
        const k = Math.round(dx * 1e6) + "," + Math.round(dy * 1e6) + "," + q3(off);
        if (!byLine.has(k)) byLine.set(k, []);
        byLine.get(k).push([Math.min(t0, t1), Math.max(t0, t1)]);
      }
      const out = [];
      for (const [k, spans] of byLine) {
        spans.sort((x, y) => x[0] - y[0]);
        let cur = spans[0].slice();
        for (const sp of spans.slice(1)) { if (sp[0] <= cur[1] + o.tolerance) cur[1] = Math.max(cur[1], sp[1]); else { out.push(k + ":" + q3(cur[0]) + "-" + q3(cur[1])); cur = sp.slice(); } }
        out.push(k + ":" + q3(cur[0]) + "-" + q3(cur[1]));
      }
      return out.sort();
    };
    if (o.stages.has("geometry")) for (const [da, db] of M.docs) {
      const group = (list, side) => {
        const g = new Map();
        for (const i of list) {
          if (i.kind !== "track" || !Array.isArray(i.points)) continue;
          const other = side === "a" ? M.items.get(i.id)?.id : M.back.get(i.id);
          const motion = M.motions.get(da), points = motion && side === "a" ? motion.item(i).points : i.points;
          if (other != null) {
            const j = (side === "a" ? IB : IA).items.get(other)?.item;
            if (!j || j.kind !== "track" || samePath(points, motion && side === "b" ? motion.item(j).points : j.points, o)) continue;
          }
          const k = (i.net || "") + "|" + (i.layer || "") + "|" + q3(i.width);
          if (!g.has(k)) g.set(k, {items: [], segs: []});
          const e = g.get(k); e.items.push(i);
          for (let n = 1; n < points.length; n++) e.segs.push([points[n - 1], points[n]]);
        }
        return g;
      };
      const ga = group(IA.byDoc.get(da), "a"), gb = group(IB.byDoc.get(db), "b");
      for (const [k, ea] of ga) {
        const eb = gb.get(k);
        if (!eb) continue;
        const la = lines(ea.segs), lb = lines(eb.segs);
        if (la.length === lb.length && la.every((v, n) => v === lb[n])) {
          for (const i of ea.items) resegmented.add(i.id);
          for (const i of eb.items) resegmented.add(i.id);
          suppressed.resegmented += ea.items.length + eb.items.length;
        }
      }
    }
    function *objects() {
      const seenA = new Set();
      const docKind = id => IB.docs.get(id)?.kind || IA.docs.get(id)?.kind;
      for (const [idB, eb] of IB.items) {
        const idA = M.back.get(idB);
        if ((++tick & 511) === 0) yield;
        if (idA == null) { if (!resegmented.has(idB)) added(eb); continue; }
        seenA.add(idA);
        const ea = IA.items.get(idA);
        if (notebook && (IA.notes.has(idA) || IB.notes.has(idB))) {noteDiff(ea,eb);continue;}
        if ((ea.item === eb.item && !M.motions.has(ea.doc.id)) || resegmented.has(idA) && resegmented.has(idB)) continue;
        pairDiff(ea, eb);
      }
      for (const [idA, ea] of IA.items) {
        if (seenA.has(idA) || M.items.has(idA) || resegmented.has(idA)) continue;
        removed(ea);
        if ((++tick & 511) === 0) yield;
      }
      void docKind; void removedB;
    }
    const areaOf = d => d.kind === "pcb" ? "pcb" : "schematic";
    const typeOf = i => i.kind === "track" && i.arc ? "arc" : i.kind === "polygon" ? "pour" : i.kind;
    function describe(ix, i, d) {
      const t = TYPE_NAMES[typeOf(i)] || i.kind;
      if (i.kind === "part") {
        const def = ix.defs.get(i.def), name = d.kind === "pcb" ? def?.footprint?.name || def?.name : def?.name;
        return (i.ref || "Component") + " (" + [i.value, name].filter(Boolean).map(v => short(v, 40)).join(", ") + ")";
      }
      if (NAMING.has(i.kind) || i.kind === "label" || i.kind === "textframe") return t + " " + short(i.text ?? i.name ?? "", 40);
      if (i.kind === "sheetsymbol") return t + " " + short(i.name || i.sheet || "", 40);
      const parts = [i.net && "on " + i.net, i.layer && "(" + i.layer + ")"].filter(Boolean).join(" ");
      return t + (parts ? " " + parts : "");
    }
    function severityAdd(i, d) {
      if (o.skipKinds.has(i.kind)) return null;
      if (i.kind === "part" || i.kind === "sheetsymbol") return "electrical";
      if (NAMING.has(i.kind)) return touchedNets.has(i.text) ? "electrical" : "cosmetic";
      if (d.kind === "pcb" && COPPER_KINDS.has(i.kind)) return i.net && touchedNets.has(i.net) ? "electrical" : "mechanical";
      if (d.kind === "pcb" && i.kind === "graphic" && /^(Top|Bottom|Inner)/.test(i.layer || "")) return "mechanical";
      return "cosmetic";
    }
    function extraAdded(i, d) {
      if (i.kind === "track" && Array.isArray(i.points)) return ", " + round(pathLength(i.points), 3) + " mm";
      if (i.kind === "polygon" && Array.isArray(i.points)) return ", " + round(polyArea(i.points), 2) + " mm²";
      if (i.kind === "via" || i.kind === "pad" || i.kind === "junction") return " at (" + fmt(i.x, 3) + ", " + fmt(i.y, 3) + ")";
      return "";
    }
    // The nets of an added or removed part's pins, from that side's netlist (what is really connected).
    function partNets(side, i, d) {
      if (i.kind !== "part") return "";
      const nl = d.kind === "pcb" ? (side === "b" ? boardsB.get(d.id) : boardsA.get(canonDocA(d.id)))?.nl : netLists[side].schematic;
      if (!nl) return "";
      const id = side === "b" ? i.id : canonA(i.id), pins = [];
      for (const k of nl.byPart.get(id) || []) pins.push(nl.pins.get(k).number + ": " + nl.byPin.get(k));
      pins.sort(natural);
      return pins.length ? " — pins " + list(pins, 8) : "";
    }
    function noteDiff(ea,eb) {
      const a=ea?.item,b=eb?.item,d=eb?.doc || ea.doc;
      if(o.skipKinds.has((b||a).kind)) return;
      const beforeNote=ea && IA.notes.has(a.id),afterNote=eb && IB.notes.has(b.id);
      if(ea && !beforeNote) {removed(ea);ea=null;}
      if(eb && !afterNote) {added(eb);eb=null;}
      for(const row of notebook.compare(before,after,ea,eb,noteA,noteB)) {
        push({kind:"note."+row.kind,category:"notes",severity:"cosmetic",target:target("note",a,b,ea?.doc,eb?.doc,{label:row.text}),
          before:row.before,after:row.after,text:row.text,fields:row.fields || [],idSuffix:row.id || (row.fields || []).join(","),
          geometry:geometry(d.kind,d.id,a,b,a&&geom(IA,a,d.kind),b&&geom(IB,b,d.kind)),match:matchInfo(a)});
      }
    }
    function added(eb) {
      if(notebook && IB.notes.has(eb.item.id)) {noteDiff(null,eb);return;}
      const i = eb.item, d = eb.doc, sev = severityAdd(i, d);
      if (!sev) return;
      push({kind: typeOf(i) + ".added", category: areaOf(d), severity: sev, target: {...target(typeOf(i), null, i, null, d), label: i.kind === "part" ? i.ref || "Component" : describe(IB, i, d)}, before: null, after: i,
        text: "Added " + describe(IB, i, d) + extraAdded(i, d) + " on " + d.name + partNets("b", i, d), geometry: geometry(d.kind, d.id, null, i, null, geom(IB, i, d.kind)), match: null, fields: []});
    }
    function removed(ea) {
      if(notebook && IA.notes.has(ea.item.id)) {noteDiff(ea,null);return;}
      const i = ea.item, d = ea.doc, sev = severityAdd(i, d);
      if (!sev) return;
      const docB = IB.docs.get(M.docs.get(d.id));
      push({kind: typeOf(i) + ".removed", category: areaOf(d), severity: sev, target: {...target(typeOf(i), i, null, d, null), label: i.kind === "part" ? i.ref || "Component" : describe(IA, i, d), ...(docB ? {doc: docB.id, docName: docB.name} : {})}, before: i, after: null,
        text: "Removed " + describe(IA, i, d) + extraAdded(i, d) + " from " + d.name + partNets("a", i, d), geometry: (() => { const g = geometry(d.kind, docB?.id ?? d.id, i, null, geom(IA, i, d.kind), null); return g; })(),
        match: null, fields: []});
    }
    function pairDiff(ea, eb) {
      const a = ea.item, b = eb.item, d = eb.doc, kind = d.kind, area = areaOf(d);
      if (o.skipKinds.has(b.kind)) return;
      const motion = M.docs.get(ea.doc.id) === d.id && M.motions.get(ea.doc.id);
      const placed = motion ? motion.item(a) : a;
      if (motion) {
        const onBoard = Array.isArray(placed.points) ? (isClosed(b) ? sameRing : samePath)(placed.points,b.points,o) :
          num(placed.x) && num(placed.y) && same(placed.x,b.x,o) && same(placed.y,b.y,o);
        if (onBoard) {
          motion.members.push([a.id,b.id]);
          motion.kinds[b.kind] = (motion.kinds[b.kind] || 0) + 1;
        }
      }
      if (o.ignoreMetadata) for (const f of META_ITEM) if ((own(a, f) || own(b, f)) && !same(a[f], b[f], o, f)) suppressed.metadata++;
      // Most pairs are unchanged: one tolerant walk, then nothing to describe.
      if (ea.doc.id === d.id || M.docs.get(ea.doc.id) === d.id) { if ((b.kind !== "part" || M.defs.get(a.def)?.id === b.def || a.def === b.def) && same(placed, b, o)) return; }
      const m = matchInfo(a);
      const label = describe(IB, b, d), t = {...target(typeOf(b), a, b, ea.doc, d), label: b.kind === "part" ? b.ref || label : label};
      const g = () => geometry(kind, d.id, a, b, geom(IA, a, ea.doc.kind), geom(IB, b, kind));
      const handled = new Set(["pinNets"]);
      // Objects paired without their id (re-import, copy) also carry regenerated association ids.
      if (m && m.by !== "id") for (const f of ["link", "sourceLink", "uid", "uuid", "groupId"]) handled.add(f);
      // A board part whose schematic counterpart was replaced but still pairs (re-imported Altium
      // designs: the schematic part's new UniqueID gives a new link) changes only that bookkeeping.
      else if (b.kind === "part" && a.link !== b.link && linkedPair(a.link, b.link, a.id)) handled.add("link");
      // Counted once, above (before the unchanged-pair shortcut, so a metadata-only change counts too).
      if (o.ignoreMetadata) for (const f of META_ITEM) handled.add(f);
      // Altium names pours <net>_L<layer>_P<index> and renumbers the index on every save.
      if (o.ignoreMetadata && b.kind === "polygon" && a.name !== b.name && typeof a.name === "string" && typeof b.name === "string") {
        const stem = n => /^(.*_L\d+)_P\d+$/.exec(n)?.[1];
        if (stem(a.name) && stem(a.name) === stem(b.name)) { suppressed.metadata++; handled.add("name"); }
      }
      const emit = (k, sev, text, before, after, fields) => push({kind: k, category: area, severity: sev, target: t, before, after, text, geometry: g(), match: m, fields, idSuffix: k.split(".").pop() === "property" ? fields.join(",") : ""});
      if (ea.doc.id !== d.id && M.docs.get(ea.doc.id) !== d.id) {
        emit(typeOf(b) + ".document", "cosmetic", label + " moved from " + ea.doc.name + " to " + d.name, ea.doc.name, d.name, ["document"]);
      }
      if (b.kind === "part") {
        handled.add("x").add("y").add("angle").add("mirror").add("layer").add("ref").add("def").add("value").add("parameters").add("mirrored").add("refAt").add("valueAt");
        if (!same(a.ref, b.ref, o)) emit("part.reannotated", "cosmetic", (a.ref || "?") + " re-annotated as " + (b.ref || "?"), a.ref, b.ref, ["ref"]);
        const dx = (b.x || 0) - (placed.x || 0), dy = (b.y || 0) - (placed.y || 0);
        const posSev = kind === "pcb" ? "mechanical" : "cosmetic";
        if (Math.abs(dx) > o.tolerance || Math.abs(dy) > o.tolerance) emit("part.moved", posSev, b.ref + " moved by (" + signed(dx) + ", " + signed(dy) + ") mm" + (motion ? " relative to the board" : "") + " to (" + fmt(b.x) + ", " + fmt(b.y) + ")", {x: a.x, y: a.y}, {x: b.x, y: b.y}, ["x", "y"]);
        if (!same(a.angle, b.angle, o, "angle")) emit("part.rotated", posSev, b.ref + " rotated " + fmt(angleOf(a.angle)) + "° → " + fmt(angleOf(b.angle)) + "°", angleOf(a.angle), angleOf(b.angle), ["angle"]);
        if (!same(a.mirror, b.mirror, o) || !same(a.mirrored, b.mirrored, o)) emit("part.mirrored", posSev, b.ref + (b.mirror || b.mirrored ? " mirrored" : " no longer mirrored"), !!(a.mirror || a.mirrored), !!(b.mirror || b.mirrored), ["mirror"]);
        if (kind === "pcb" && !same(a.layer || "Top", b.layer || "Top", o)) emit("part.flipped", "mechanical", b.ref + " flipped to " + (b.layer || "Top"), a.layer || "Top", b.layer || "Top", ["layer"]);
        const mappedDef = M.defs.get(a.def)?.id ?? a.def;
        const gA = geom(IA, a, kind), gB = geom(IB, b, kind);
        const equivalent = kind === "pcb" ? fpName(IA, a.def) === fpName(IB, b.def) && same(gA?.pads, gB?.pads, o)
          : defName(IA, a.def) === defName(IB, b.def) && same(gA?.pins, gB?.pins, o);
        // A placeholder resolved to a real component (generic-parts placeholders, part.resolvedFrom), or put
        // back: one semantic change, not "symbol changed" plus a property change.
        handled.add("resolvedFrom");
        const ra = plain(a.resolvedFrom) ? a.resolvedFrom : null, rb = plain(b.resolvedFrom) ? b.resolvedFrom : null;
        if (mappedDef !== b.def && (ra || rb) && !same(ra, rb, o)) {
          const r = rb || ra, n = plain(r.map) ? Object.keys(r.map).length : 0, from = String(r.family || "placeholder");
          emit("library.resolved", "electrical", rb ? b.ref + " " + from + " placeholder → " + defName(IB, b.def) + (n ? ", " + n + " pin" + (n === 1 ? "" : "s") + " mapped" : "")
            : b.ref + " " + defName(IA, a.def) + " → back to a " + from + " placeholder", ra, rb, ["def", "resolvedFrom"]);
        } else if (mappedDef !== b.def && !equivalent) {
          const what = kind === "pcb" ? "footprint" : "symbol";
          const na = kind === "pcb" ? fpName(IA, a.def) : defName(IA, a.def), nb = kind === "pcb" ? fpName(IB, b.def) : defName(IB, b.def);
          emit("part." + what, "electrical", b.ref + " " + what + " " + na + " → " + nb, na, nb, ["def"]);
        }
        if (!same(a.value, b.value, o)) emit("part.value", "electrical", b.ref + " value " + fmt(a.value) + " → " + fmt(b.value), a.value ?? null, b.value ?? null, ["value"]);
        const pa = plain(a.parameters) ? a.parameters : {}, pb = plain(b.parameters) ? b.parameters : {};
        for (const k of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort(natural)) {
          if (same(pa[k], pb[k], o, k)) continue;
          const sev = COSMETIC_PARAMS.test(k.trim()) || o.cosmeticParameters.includes(k) ? "cosmetic" : "electrical";
          push({kind: "part.parameter", category: area, severity: sev, target: {...t, field: k}, before: pa[k] ?? null, after: pb[k] ?? null, idSuffix: "p:" + k,
            text: b.ref + " " + k + ": " + fmt(pa[k]) + " → " + fmt(pb[k]), geometry: g(), match: m, fields: ["parameters"]});
        }
        if (!same(a.refAt, b.refAt, o) || !same(a.valueAt, b.valueAt, o)) emit("part.property", "cosmetic", b.ref + " label positions changed", {refAt: a.refAt, valueAt: a.valueAt}, {refAt: b.refAt, valueAt: b.valueAt}, ["refAt", "valueAt"]);
        const rest = fieldDiff(a, b, o, handled);
        if (rest.length) {
          const sev = rest.some(f => PART_ELECTRICAL.has(f)) ? "electrical" : "cosmetic";
          emit("part.property", sev, b.ref + " " + rest.map(f => f + " " + fmt(a[f]) + " → " + fmt(b[f])).join("; "), pick(a, rest), pick(b, rest), rest);
        }
        return;
      }
      const type = typeOf(b), name = TYPE_NAMES[type] || b.kind;
      const where = (b.net ? " on " + b.net : "") + (b.layer ? " (" + b.layer + ")" : "");
      const copper = kind === "pcb" && COPPER_KINDS.has(b.kind);
      const geoSev = copper ? "mechanical" : (kind === "pcb" && b.kind === "graphic" && /^(Top|Bottom|Inner)/.test(b.layer || "")) ? "mechanical" : "cosmetic";
      if (!same(a.net, b.net, o)) {
        handled.add("net");
        const follows = kind === "pcb" && !!boardMaps.get(d.id)?.mapTo.get(a.net)?.has(b.net);
        if (!follows) emit(type + ".net", copper ? "electrical" : "cosmetic", name + " net " + fmt(a.net) + " → " + fmt(b.net) + (b.layer ? " (" + b.layer + ")" : ""), a.net ?? null, b.net ?? null, ["net"]);
      }
      if (b.text !== undefined || a.text !== undefined) {
        handled.add("text");
        if (!same(a.text, b.text, o)) emit(type + ".text", NAMING.has(b.kind) ? "electrical" : "cosmetic", name + " text “" + short(a.text ?? "") + "” → “" + short(b.text ?? "") + "”", a.text ?? null, b.text ?? null, ["text"]);
      }
      if (!same(a.layer, b.layer, o)) { handled.add("layer"); emit(type + ".layer", geoSev, name + where + " layer " + fmt(a.layer) + " → " + fmt(b.layer), a.layer ?? null, b.layer ?? null, ["layer"]); }
      if (Array.isArray(a.points) || Array.isArray(b.points)) {
        handled.add("points");
        const closed = b.kind === "polygon";
        const equal = resegmented.has(a.id) && resegmented.has(b.id) ||
          (closed ? sameRing(placed.points || [], b.points || [], o) : samePath(placed.points, b.points, o));
        if (!equal) {
          const tr = translation(placed.points || [], b.points || [], o);
          let text;
          if (tr) text = name + where + " moved by (" + signed(tr[0]) + ", " + signed(tr[1]) + ") mm" + (motion ? " relative to the board" : "");
          else if (b.kind === "polygon") { const da = polyArea(a.points || []), db = polyArea(b.points || []); text = name + where + " outline changed: area " + round(da, 2) + " → " + round(db, 2) + " mm² (" + signed(db - da, 2) + ")"; }
          else if (b.kind === "track" || b.kind === "wire" || b.kind === "bus") { const la = pathLength(a.points || []), lb = pathLength(b.points || []); text = name + where + " re-routed: " + round(la, 3) + " → " + round(lb, 3) + " mm (" + signed(lb - la, 3) + ")"; }
          else text = name + where + " shape changed";
          emit(type + (tr ? ".moved" : ".reshaped"), geoSev, text, a.points ?? null, b.points ?? null, ["points"]);
        }
      } else if (num(a.x) || num(b.x)) {
        handled.add("x").add("y");
        const dx = (b.x || 0) - (placed.x || 0), dy = (b.y || 0) - (placed.y || 0);
        if (Math.abs(dx) > o.tolerance || Math.abs(dy) > o.tolerance) emit(type + ".moved", geoSev, name + where + " moved by (" + signed(dx) + ", " + signed(dy) + ") mm" + (motion ? " relative to the board" : ""), {x: a.x, y: a.y}, {x: b.x, y: b.y}, ["x", "y"]);
      }
      if (b.kind === "polygon" && o.ignorePourFill) for (const f of ["fill", "fills", "islands", "poured", "pourIndex"]) { if (!same(a[f], b[f], o, f)) suppressed.pourFill++; handled.add(f); }
      if (b.kind === "sheetsymbol") {
        for (const f of ["sheet", "entries", "name", "repeat"]) {
          handled.add(f);
          const from = f === "sheet" ? M.docs.get(a.sheet) ?? a.sheet : a[f];
          if (!same(from, b[f], o, f)) emit("sheetsymbol." + f, f === "name" ? "cosmetic" : "electrical", "Sheet symbol " + short(b.name || "") + " " + f + " changed" + (typeof b[f] === "string" ? ": " + fmt(a[f]) + " → " + fmt(b[f]) : ""), a[f] ?? null, b[f] ?? null, [f]);
        }
      }
      const rest = fieldDiff(a, b, o, handled);
      if (rest.length) {
        const sev = copper && rest.some(f => ["width", "diameter", "drill", "w", "h", "shape", "clearance", "fromLayer", "toLayer"].includes(f)) ? "mechanical" : SCH_DRAWN.has(b.kind) || COSMETIC_KINDS.has(b.kind) ? "cosmetic" : geoSev;
        const text = name + where + " " + rest.map(f => (f === "w" ? "width" : f === "h" ? "height" : f) + " " + fmt(a[f]) + " → " + fmt(b[f])).join("; ");
        emit(type + ".property", sev, text, pick(a, rest), pick(b, rest), rest);
      }
    }
    yield* objects();
    for (const [da, motion] of M.motions) {
      const a = IA.docs.get(da), b = IB.docs.get(M.docs.get(da));
      const shape = doc => ({box:boundsOf(doc.outline), path:doc.outline, closed:true, width:0, round:false});
      const oldShape = shape(a), newShape = shape(b);
      motion.change = push({kind:"board.translated", category:"pcb", severity:"mechanical",
        target:{type:"board", id:b.id, beforeId:a.id, afterId:b.id, doc:b.id, docName:b.name},
        before:{x:oldShape.box[0],y:oldShape.box[1]}, after:{x:newShape.box[0],y:newShape.box[1]},
        fields:["x","y"], translation:{dx:round(motion.dx,6),dy:round(motion.dy,6),anchors:motion.anchors,objects:motion.members.length,byKind:motion.kinds},
        text:"Board translated by (" + signed(motion.dx,6) + ", " + signed(motion.dy,6) + ") mm with " + plural(motion.members.length,"object"),
        geometry:{doc:b.id,box:unionBox(oldShape.box,newShape.box),before:oldShape,after:newShape},match:null});
    }
    phase("objects");

    // ---------------- designator permutations (stable ids): R1 <-> R2 is one change, and it is
    // electrical when the two parts differ (value, footprint, parameters) or the designators are
    // referenced by classes, rooms or variants (they now apply to the other part).
    {
      const re = changes.filter(c => c.kind === "part.reannotated");
      const byDoc = new Map();
      for (const c of re) { const k = c.target.doc; if (!byDoc.has(k)) byDoc.set(k, new Map()); byDoc.get(k).set(c.before, c); }
      const drop = new Set();
      const referenced = (doc, refs) => {
        const text = JSON.stringify([IB.docs.get(doc)?.componentClasses, IB.docs.get(doc)?.rooms, after.variants, before.variants]);
        return refs.some(r => text.includes(JSON.stringify(r)));
      };
      const differs = (x, y) => {
        const a = IB.items.get(x)?.item, b = IB.items.get(y)?.item;
        return !a || !b || !same(a.value, b.value, o) || a.def !== b.def || !same(a.parameters, b.parameters, o);
      };
      for (const [doc, m] of byDoc) for (const [from, c] of [...m].sort((x, y) => natural(x[0], y[0]))) {
        if (drop.has(c)) continue;
        const other = m.get(c.after);
        if (other && other !== c && other.after === from && !drop.has(other)) {
          drop.add(c); drop.add(other);
          const pa = IB.items.get(c.target.afterId)?.item, pb = IB.items.get(other.target.afterId)?.item;
          const electrical = differs(c.target.afterId, other.target.afterId) || referenced(doc, [from, c.after]);
          const was = x => [x?.value, fpName(IB, x?.def)].filter(Boolean).join(", ");
          const [r1, r2] = [from, c.after].sort(natural);
          push({kind: "part.designatorsSwapped", category: c.category, severity: electrical ? "electrical" : "cosmetic",
            target: {...c.target, ref: r1, label: r1 + " ↔ " + r2, refs: [r1, r2], ids: [c.target.afterId, other.target.afterId]}, before: {[from]: c.target.afterId, [c.after]: other.target.afterId},
            after: {[c.after]: c.target.afterId, [from]: other.target.afterId}, idSuffix: [c.target.afterId, other.target.afterId].sort().join("+"),
            text: r1 + " and " + r2 + " swapped designators" + (pa && pb && differs(pa.id, pb.id) ? " (" + pa.ref + " is now " + was(pa) + "; " + pb.ref + " is now " + was(pb) + ")" : "") + (c.target.docName ? " on " + c.target.docName : ""),
            geometry: c.geometry && other.geometry ? {doc: c.geometry.doc, box: unionBox(c.geometry.box, other.geometry.box), before: null, after: {box: unionBox(c.geometry.box, other.geometry.box), path: null, closed: false, width: 0, round: false}} : c.geometry,
            match: c.match, fields: ["ref"]});
        } else {
          // A designator reused from another part: the BOM line now means a different part.
          const prev = [...IA.items.values()].find(e => e.item.kind === "part" && e.item.ref === c.after && M.items.get(e.item.id)?.id !== c.target.afterId && M.docs.get(e.doc.id) === doc);
          const now = IB.items.get(c.target.afterId)?.item;
          if (prev && now && (!same(prev.item.value, now.value, o) || (M.defs.get(prev.item.def)?.id ?? prev.item.def) !== now.def)) {
            c.severity = "electrical"; c.text += " (" + c.after + " was " + [prev.item.value, fpName(IA, prev.item.def)].filter(Boolean).join(", ") + ")";
          }
        }
      }
      if (drop.size) for (let n = changes.length - 1; n >= 0; n--) if (drop.has(changes[n])) changes.splice(n, 1);
    }

    // ---------------- board copper attachment: a pad that loses the copper of its net (open) or
    // touches copper of another net (short) after a move, rotation, flip or copper edit.
    for (const [id, B] of boardsB) {
      const Aa = boardsA.get(id);
      if (!Aa?.doc) continue;
      const dirty = [];
      for (const c of changes) if (c.kind !== "board.translated" && c.category === "pcb" && c.geometry?.doc === id) {
        const {before, after, box} = c.geometry;
        if (before?.box) dirty.push(before.box);
        if (after?.box) dirty.push(after.box);
        if (!before?.box && !after?.box && box) dirty.push(box);
      }
      if (!dirty.length) continue;
      const cell = 5, dgrid = new Map();
      for (const b of dirty) for (let x = Math.floor((b[0] - 1) / cell); x <= Math.floor((b[2] + 1) / cell); x++) for (let y = Math.floor((b[1] - 1) / cell); y <= Math.floor((b[3] + 1) / cell); y++) {
        const k = x + "," + y; if (!dgrid.has(k)) dgrid.set(k, []); dgrid.get(k).push(b);
      }
      const near = p => p && (dgrid.get(Math.floor(p[0] / cell) + "," + Math.floor(p[1] / cell)) || []).some(b => p[0] >= b[0] - 1 && p[0] <= b[2] + 1 && p[1] >= b[1] - 1 && p[1] <= b[3] + 1);
      const keys = new Set();
      for (const [k, info] of Aa.nl.pins) if (info.pad && near(info.at)) keys.add(k);
      for (const [k, info] of B.nl.pins) if (info.pad && near(info.at)) keys.add(k);
      if (!keys.size) continue;
      const ia = copperIndex(Aa.doc), ib = copperIndex(B.doc), ren = boardMaps.get(id)?.rename || new Map();
      const escalate = new Map();
      for (const k of [...keys].sort()) {
        const pa = Aa.nl.pins.get(k), pb = B.nl.pins.get(k);
        if (!pa || !pb) continue;
        const sameNet = pa.net === pb.net || ren.get(pa.net) === pb.net;
        const xa = attachment(ia, pa, o), xb = attachment(ib, pb, o);
        const foreignA = new Set([...xa.foreign].map(n => ren.get(n) ?? n));
        const shorts = [...xb.foreign].filter(n => !foreignA.has(n)).sort(natural);
        const cleared = [...foreignA].filter(n => !xb.foreign.has(n)).sort(natural);
        const opened = sameNet && xa.own && !xb.own;
        const restored = sameNet && !xa.own && xb.own;
        if (!shorts.length && !cleared.length && !opened && !restored) continue;
        const kind = shorts.length ? (cleared.length ? "pad.shortsChanged" : "pad.shorted") :
          cleared.length ? "pad.shortCleared" : opened ? "pad.opened" : "pad.reconnected";
        const details = [];
        if (shorts.length) details.push("now touches " + list(shorts) + " copper" + (opened ? " and lost its own" : ""));
        if (cleared.length) details.push("cleared contact with " + list(cleared) + " copper");
        if (opened && !shorts.length) details.push("lost its " + pb.net + " copper (open)");
        if (restored) details.push("reconnected to " + pb.net + " copper");
        const text = "PCB " + B.doc.name + ": " + pb.label + " (" + pb.net + ") " + details.join(", ");
        const padShape = p => ({box:[p.at[0]-p.pad.w/2-.3,p.at[1]-p.pad.h/2-.3,p.at[0]+p.pad.w/2+.3,p.at[1]+p.pad.h/2+.3],path:null,closed:false,width:0,round:true});
        const before = padShape(pa), after = padShape(pb);
        const c = push({kind, category: "connectivity", severity: "electrical", target: {type: "pin", id: null, net: pb.net, domain: "pcb:" + id, doc: id, docName: B.doc.name, pin: pb.label, part: pb.part, ref: pb.ref, shorts, cleared},
          before: {own: xa.own, foreign: [...xa.foreign].sort(natural)}, after: {own: xb.own, foreign: [...xb.foreign].sort(natural)}, idSuffix: id + ":" + k, text,
          geometry: {doc:id,box:unionBox(before.box,after.box),before,after}, match: null, fields: []});
        touchedNets.add(pb.net); netEntry(pb.net).changes.push(c);
        for (const n of [...shorts,...cleared]) { touchedNets.add(n); netEntry(n).changes.push(c); }
        escalate.set(pb.part, pb.at);
        for (const cid of [...xa.ids, ...xb.ids]) escalate.set(cid, pb.at);
      }
      // The edits behind an open or short are electrical too.
      for (const c of changes) {
        if (c.severity === "electrical" || c.category !== "pcb" || c.geometry?.doc !== id) continue;
        if (escalate.has(c.target.afterId) || escalate.has(c.target.beforeId)) { c.severity = "electrical"; continue; }
        if (/^(track|arc|via|pour)\./.test(c.kind)) for (const p of escalate.values()) {
          if ([c.geometry.before?.box, c.geometry.after?.box].some(b => b && p[0] >= b[0] - 0.5 && p[0] <= b[2] + 0.5 && p[1] >= b[1] - 0.5 && p[1] <= b[3] + 0.5)) { c.severity = "electrical"; break; }
        }
      }
      yield;
    }
    phase("attachment");

    // ---------------- routing per net
    for (const [id, B] of boardsB) {
      const Aa = boardsA.get(id); if (!Aa) continue;
      const mapTo = boardMaps.get(id)?.rename || new Map(), from = new Map();
      for (const [x, y] of mapTo) from.set(y, x);
      const names = new Set([...B.copper.keys(), ...[...Aa.copper.keys()].map(n => mapTo.get(n) ?? n)]);
      for (const n of names) {
        if (!n) continue;
        const sa = Aa.copper.get(from.get(n) ?? n) || null, sb = B.copper.get(n) || null;
        const z = {tracks: 0, arcs: 0, length: 0, vias: 0, pours: 0, area: 0, layers: new Map()};
        const x = sa || z, y = sb || z;
        const dl = y.length - x.length, dv = y.vias - x.vias, da = y.area - x.area, dt = y.tracks - x.tracks;
        if (Math.abs(dl) <= o.lengthTolerance && !dv && Math.abs(da) <= o.areaTolerance) { if (dt) suppressed.resegmented++; continue; }
        const layers = new Set([...x.layers.keys(), ...y.layers.keys()]), per = [];
        const perLayer = {};
        for (const l of [...layers].sort(natural)) {
          const la = x.layers.get(l) || {length: 0, area: 0, tracks: 0}, lb = y.layers.get(l) || {length: 0, area: 0, tracks: 0};
          const d1 = lb.length - la.length, d2 = lb.area - la.area;
          perLayer[l] = {lengthBefore: round(la.length, 4), lengthAfter: round(lb.length, 4), areaBefore: round(la.area, 3), areaAfter: round(lb.area, 3)};
          if (Math.abs(d1) > o.lengthTolerance) per.push(l + " " + signed(d1, 3));
        }
        const bits = [];
        if (Math.abs(dl) > o.lengthTolerance || dt) bits.push("track " + signed(dl, 3) + " mm" + (per.length ? " (" + per.join(", ") + ")" : "") + (dt ? ", segments " + x.tracks + " → " + y.tracks : ""));
        if (dv) bits.push("vias " + x.vias + " → " + y.vias);
        if (Math.abs(da) > o.areaTolerance) bits.push("pour area " + signed(da, 2) + " mm²");
        const box = unionBox(x.box, y.box);
        const c = push({kind: "routing.changed", category: "pcb", severity: "mechanical", target: {type: "net", id: null, net: n, domain: "pcb:" + id, doc: id, docName: B.doc.name},
          before: {length: round(x.length, 4), tracks: x.tracks, arcs: x.arcs, vias: x.vias, pours: x.pours, area: round(x.area, 3)},
          after: {length: round(y.length, 4), tracks: y.tracks, arcs: y.arcs, vias: y.vias, pours: y.pours, area: round(y.area, 3)}, idSuffix: id,
          text: n + " routing on " + B.doc.name + ": " + bits.join(", "), geometry: box ? {doc: id, box, before: null, after: {box, path: null, closed: false, width: 0, round: false}} : null,
          match: null, fields: [], lengthDelta: round(dl, 4), viaDelta: dv, areaDelta: round(da, 3), layers: perLayer});
        const e = netEntry(n);
        e.boards[id] = {...(e.boards[id] || {}), routing: {before: c.before, after: c.after, lengthDelta: c.lengthDelta, viaDelta: dv, areaDelta: c.areaDelta, layers: perLayer}};
        e.changes.push(c);
      }
      // Copper object counts per net for byNet (both sides) when anything changed there.
      for (const [n, s] of B.copper) if (byNet[n]) {
        const sa = Aa.copper.get(from.get(n) ?? n);
        const objs = v => v ? v.tracks + v.vias + v.pours + v.pads : 0;
        byNet[n].boards[id] = {...(byNet[n].boards[id] || {}), copper: [objs(sa), objs(s)]};
      }
      for (const [n, s] of Aa.copper) { const m = mapTo.get(n) ?? n; if (byNet[m] && !byNet[m].boards[id]?.copper) byNet[m].boards[id] = {...(byNet[m].boards[id] || {}), copper: [s.tracks + s.vias + s.pours + s.pads, 0]}; }
      yield;
    }
    phase("routing");

    // ---------------- library
    {
      const users = new Map();
      for (const [, e] of IB.items) if (e.item.kind === "part") { if (!users.has(e.item.def)) users.set(e.item.def, new Set()); users.get(e.item.def).add(e.item.ref); }
      const usersA = new Map();
      for (const [, e] of IA.items) if (e.item.kind === "part") { if (!usersA.has(e.item.def)) usersA.set(e.item.def, new Set()); usersA.get(e.item.def).add(e.item.ref); }
      const seen = new Set();
      for (const [ida, m] of M.defs) {
        const before = IA.defs.get(ida), after = IB.defs.get(m.id); seen.add(m.id);
        if (before === after) continue;
        const a = Atrium.definitionGeometry(before), b = Atrium.definitionGeometry(after);
        if (same(a, b, o)) continue;
        const refs = [...(users.get(b.id) || [])].sort(natural);
        const affects = refs.length ? "; affects " + list(refs, 8) : "; not placed";
        const pinDiff = keyedPins(a.symbol?.pins, b.symbol?.pins, o), padDiff = keyedPins(a.footprint?.pads, b.footprint?.pads, o, "pad");
        // A board-only import carries footprints without symbols: a missing side is noted, not electrical.
        for (const g of ["symbol", "footprint"]) if (!a[g] !== !b[g]) push({kind: "library." + g, category: "library", severity: "cosmetic", target: {type: "definition", id: b.id, beforeId: a.id, afterId: b.id, name: b.name, affected: refs},
          before: a[g] ?? null, after: b[g] ?? null, idSuffix: g, text: (g === "symbol" ? "Symbol" : "Footprint") + " of " + b.name + (a[g] ? " removed" : " added"), geometry: null, match: m, fields: [g]});
        if (a.symbol && b.symbol) {
          if (pinDiff.length || !same(a.symbol?.shapes, b.symbol?.shapes, o) || !same(a.symbol?.parts, b.symbol?.parts, o)) {
            push({kind: "library.symbol", category: "library", severity: pinDiff.length ? "electrical" : "cosmetic", target: {type: "definition", id: b.id, beforeId: a.id, afterId: b.id, name: b.name, affected: refs},
              before: a.symbol ?? null, after: b.symbol ?? null, text: "Symbol " + b.name + " changed" + (pinDiff.length ? " (" + list(pinDiff, 4) + ")" : " (graphics)") + affects, geometry: null, match: m, fields: ["symbol"]});
          }
        }
        if (a.footprint && b.footprint) {
          if (padDiff.length || !sameFootprintShapes(a.footprint?.shapes, b.footprint?.shapes, o, IA, IB) || !same(a.footprint?.name, b.footprint?.name, o)) {
            push({kind: "library.footprint", category: "library", severity: padDiff.length ? "electrical" : "cosmetic", target: {type: "definition", id: b.id, beforeId: a.id, afterId: b.id, name: b.name, affected: refs},
              before: a.footprint ?? null, after: b.footprint ?? null, text: "Footprint " + (b.footprint?.name || b.name) + " changed" + (padDiff.length ? " (" + list(padDiff, 4) + ")" : " (graphics)") + affects, geometry: null, match: m, fields: ["footprint"]});
          }
        }
        const rest = fieldDiff(a, b, o, new Set(["symbol", "footprint", "schDrawing"]));
        if (rest.length) push({kind: "library.changed", category: "library", severity: "cosmetic", target: {type: "definition", id: b.id, beforeId: a.id, afterId: b.id, name: b.name, affected: refs},
          before: pick(a, rest), after: pick(b, rest), text: "Library entry " + b.name + ": " + rest.map(f => f + " " + fmt(a[f]) + " → " + fmt(b[f])).join("; ") + affects, geometry: null, match: m, fields: rest});
      }
      // KiCad stores graphics on each placement. Editing one can split a shared
      // footprint definition while preserving its package name and every pad.
      const split = new Map(), joined = new Map();
      if (M.defs.size !== IA.defs.size || seen.size !== IB.defs.size) for (const [aid, m] of M.items) {
        const left = IA.items.get(aid), right = IB.items.get(m.id);
        if (left?.doc.kind !== "pcb" || right?.doc.kind !== "pcb" || left.item.kind !== "part" || right.item.kind !== "part") continue;
        const a = IA.defs.get(left.item.def), b = IB.defs.get(right.item.def);
        if (!a || !b || (M.defs.has(a.id) && seen.has(b.id)) || !/\.kicad_pcb$/i.test(a.sourceName || "") ||
            !/\.kicad_pcb$/i.test(b.sourceName || "") || !a.footprint || !b.footprint || a.footprint.name !== b.footprint.name ||
            keyedPins(a.footprint.pads, b.footprint.pads, o, "pad").length || sameFootprintShapes(a.footprint.shapes, b.footprint.shapes, o, IA, IB)) continue;
        push({kind: "part.graphics", category: "pcb", severity: "cosmetic",
          target: target("part", left.item, right.item, left.doc, right.doc), before: a.footprint.shapes, after: b.footprint.shapes,
          text: right.item.ref + " footprint graphics changed", geometry: geometry("pcb", right.doc.id, left.item, right.item, a.footprint, b.footprint),
          match: matchInfo(left.item), fields: ["footprint"]});
        if (!seen.has(b.id)) split.set(b.id, (split.get(b.id) || 0) + 1);
        if (!M.defs.has(a.id)) joined.set(a.id, (joined.get(a.id) || 0) + 1);
      }
      for (const [id, b] of IB.defs) if (!seen.has(id) && (!split.has(id) || split.get(id) !== users.get(id)?.size)) push({kind: "library.added", category: "library", severity: "cosmetic", target: {type: "definition", id, beforeId: null, afterId: id, name: b.name, affected: [...(users.get(id) || [])].sort(natural)},
        before: null, after: {name: b.name}, text: "Library entry " + b.name + " added", geometry: null, match: null, fields: []});
      for (const [id, a] of IA.defs) if (!M.defs.has(id) && (!joined.has(id) || joined.get(id) !== usersA.get(id)?.size)) push({kind: "library.removed", category: "library", severity: "cosmetic", target: {type: "definition", id, beforeId: id, afterId: null, name: a.name, affected: [...(usersA.get(id) || [])].sort(natural)},
        before: {name: a.name}, after: null, text: "Library entry " + a.name + " removed", geometry: null, match: null, fields: []});
    }
    phase("library");
    yield;

    // ---------------- project level: rules, variants, blocks, settings, comments
    if (!same(before.rules, after.rules, o)) rulesDiff(before.rules, after.rules, null, push, o, signalsIn(before, after));
    keyedDiff(before.variants, after.variants, "variant", "Variant", "project", "electrical", null, push, o);
    keyedDiff(before.layoutBlocks, after.layoutBlocks, "block", "Layout block", "pcb", "mechanical", null, push, o);
    keyedDiff(before.ruleSets?.sets || (Array.isArray(before.ruleSets) ? before.ruleSets : null), after.ruleSets?.sets || (Array.isArray(after.ruleSets) ? after.ruleSets : null), "ruleSet", "Rule set", "rules", "mechanical", null, push, o);
    // The native reader's compatibility notice describes opaque owners. Git history
    // reports their byte changes independently of the modeled electrical diff.
    const projectSkip = new Set(["documents", "library", "rules", "variants", "layoutBlocks", "ruleSets", ...(globalThis.AtriumSignals ? ["signals"] : []), ...(globalThis.AtriumWaivers ? ["waivers", "insights"] : []), "format", "version", "review", "blobs", "atriumCompat", ...(o.ignoreMetadata ? ["importNotes"] : [])]);
    // 3D models stored once (project.blobs, keyed by SHA-256): one line per model, never the STEP text.
    {
      const ba = plain(before.blobs) ? before.blobs : {}, bb = plain(after.blobs) ? after.blobs : {};
      for (const k of [...new Set([...Object.keys(ba), ...Object.keys(bb)])].sort()) if (!own(ba, k) || !own(bb, k)) {
        const name = String((bb[k] || ba[k])?.name || k.slice(0, 12));
        push({kind: "library.model3d", category: "library", severity: "cosmetic", target: {type: "project", id: null, field: "blobs", name}, before: own(ba, k) ? {sha256: k, name} : null,
          after: own(bb, k) ? {sha256: k, name} : null, idSuffix: "blob:" + k, text: "3D model " + name + (own(bb, k) ? " stored" : " removed"), geometry: null, match: null, fields: ["blobs"]});
      }
    }
    for (const f of fieldDiff(before, after, o, projectSkip)) {
      const sev = /scope|netScope|variant|multichannel/i.test(f) ? "electrical" : "cosmetic";
      push({kind: "project.setting", category: "project", severity: sev, target: {type: "project", id: null, field: f, name: after.name}, before: before[f] ?? null, after: after[f] ?? null, idSuffix: f,
        text: "Project " + f + " changed" + (typeof after[f] !== "object" ? ": " + fmt(before[f]) + " → " + fmt(after[f]) : ""), geometry: null, match: null, fields: [f]});
    }
    // Waivers (waivers.js) are design data: added, removed, changed and stale, each with its note and author.
    if (globalThis.AtriumWaivers) waiversDiff(before, after, push);
    if (!o.ignoreComments && !same(before.review, after.review, o)) {
      const ra = before.review?.records || {}, rb = after.review?.records || {};
      const keys = new Set([...Object.keys(ra), ...Object.keys(rb)]);
      let add = 0, del = 0, chg = 0;
      for (const k of keys) { if (!own(ra, k)) add++; else if (!own(rb, k)) del++; else if (!same(ra[k], rb[k], o)) chg++; }
      if (add + del + chg) push({kind: "comments.changed", category: "project", severity: "cosmetic", target: {type: "comments", id: null}, before: Object.keys(ra).length, after: Object.keys(rb).length,
        text: "Review comments: " + [add && "+" + add, del && "−" + del, chg && "~" + chg].filter(Boolean).join(" "), geometry: null, match: null, fields: ["review"]});
    }
    if (!o.ignoreOrder) {
      for (const [da, db] of M.docs) {
        const a = IA.byDoc.get(da).map(i => M.items.get(i.id)?.id).filter(Boolean), b = IB.byDoc.get(db).map(i => i.id).filter(id => M.back.has(id));
        if (a.length === b.length && a.some((v, k) => v !== b[k])) push({kind: "order.changed", category: IB.docs.get(db).kind === "pcb" ? "pcb" : "schematic", severity: "cosmetic", target: {type: "document", id: db, doc: db, docName: IB.docs.get(db).name},
          before: null, after: null, text: "Drawing order of " + IB.docs.get(db).name + " changed", geometry: null, match: null, fields: ["items"]});
      }
    } else {
      for (const [da, db] of M.docs) {
        const a = IA.byDoc.get(da), b = IB.byDoc.get(db);
        if (a.length && b.length && M.items.get(a[0].id)?.id !== b[0].id) { suppressed.order++; }
      }
    }
    phase("project");

    // ---------------- DRC delta
    if (o.drc && globalThis.AtriumRules?.check) {
      for (const [id, B] of boardsB) {
        const Aa = boardsA.get(id); if (!Aa?.doc) continue;
        const run = (ix, d, p) => { try { return AtriumRules.check(d, ix.defs, AtriumRules.stored(d, p) || AtriumRules.defaults()).issues; } catch { return null; } };
        const ia = run(IA, Aa.doc, before), ib = run(IB, B.doc, after);
        if (!ia || !ib) continue;
        const keyA = v => [v.rule, [canonA(v.id), v.otherId ? canonA(v.otherId) : ""].sort().join("+")].join("|");
        const keyB = v => [v.rule, [v.id, v.otherId || ""].sort().join("+")].join("|");
        const ca = new Map(); for (const v of ia) { const k = keyA(v); ca.set(k, (ca.get(k) || []).concat([v])); }
        const cb = new Map(); for (const v of ib) { const k = keyB(v); cb.set(k, (cb.get(k) || []).concat([v])); }
        const shapeFor = (ix, objId, docKind) => { const e = ix.items.get(objId); return e ? shapeOf(e.item, geom(ix, e.item, docKind), docKind) : null; };
        for (const [k, vs] of cb) for (const v of vs.slice((ca.get(k) || []).length)) {
          const s = shapeFor(IB, v.id, "pcb");
          push({kind: "drc.new", category: "drc", severity: "electrical", target: {type: "violation", id: v.id, afterId: v.id, otherId: v.otherId ?? null, rule: v.rule, doc: id, docName: B.doc.name},
            before: null, after: {actual: v.actual, required: v.required}, idSuffix: k, text: "New DRC violation on " + B.doc.name + ": " + (v.title || v.rule) + " (" + round(v.actual, 4) + " mm, required " + round(v.required, 4) + " mm)",
            geometry: s ? {doc: id, box: s.box, before: null, after: s} : null, match: null, fields: []});
        }
        for (const [k, vs] of ca) for (const v of vs.slice((cb.get(k) || []).length)) {
          const s = shapeFor(IA, v.id, "pcb");
          push({kind: "drc.fixed", category: "drc", severity: "mechanical", target: {type: "violation", id: v.id, beforeId: v.id, otherId: v.otherId ?? null, rule: v.rule, doc: id, docName: B.doc.name},
            before: {actual: v.actual, required: v.required}, after: null, idSuffix: k, text: "Fixed DRC violation on " + B.doc.name + ": " + (v.title || v.rule),
            geometry: s ? {doc: id, box: s.box, before: s, after: null} : null, match: null, fields: []});
        }
        yield;
      }
      phase("drc");
    }

    // ---------------- ordering, indexes, summary
    const catRank = Object.fromEntries(CATEGORIES.map((c, i) => [c, i]));
    // Sort keys once: severity, category, document, designator / net / name, kind, id.
    const keyed = changes.map(c => ({c, s: RANK[c.severity], k: catRank[c.category], d: c.target.docName || "", n: String(c.target.ref || c.target.net || c.target.name || ""), t: c.kind, i: c.id}));
    const cmpStr = (x, y) => x === y ? 0 : natural(x, y);
    keyed.sort((x, y) => x.s - y.s || x.k - y.k || cmpStr(x.d, y.d) || cmpStr(x.n, y.n) || (x.t < y.t ? -1 : x.t > y.t ? 1 : 0) || (x.i < y.i ? -1 : x.i > y.i ? 1 : 0));
    for (let i = 0; i < keyed.length; i++) changes[i] = keyed[i].c;
    yield;
    const seenIds = new Map(), position = new Map();
    changes.forEach((c, i) => { const n = seenIds.get(c.id) || 0; seenIds.set(c.id, n + 1); if (n) c.id += "#" + (n + 1); position.set(c, i); });
    const byObject = Object.create(null);
    changes.forEach((c, i) => {
      const t = c.target;
      if (t.afterId != null) (byObject[t.afterId] || (byObject[t.afterId] = [])).push(i);
      if (t.beforeId != null && t.beforeId !== t.afterId) (byObject[t.beforeId] || (byObject[t.beforeId] = [])).push(i);
      if (t.part != null && t.part !== t.afterId && t.part !== t.beforeId) (byObject[t.part] || (byObject[t.part] = [])).push(i);
    });
    for (const motion of M.motions.values()) {
      const row = position.get(motion.change);
      for (const [a,b] of motion.members) for (const id of a === b ? [a] : [a,b]) (byObject[id] ||= []).push(row);
    }
    const netSets = new Map();
    for (const n of Object.keys(byNet)) netSets.set(n, new Set(byNet[n].changes.map(c => position.get(c)).filter(i => i != null)));
    for (let i = 0; i < changes.length; i++) {
      const c = changes[i], n = c.target.net;
      if (n && netSets.has(n) && c.category !== "connectivity" && c.kind !== "routing.changed") netSets.get(n).add(i);
    }
    for (const [n, set] of netSets) byNet[n].changes = [...set].sort((x, y) => x - y);
    const summary = summarise(changes, IA, IB, M, suppressed, byNet);
    // Geometry is also used to check for newly open/shorted pads. A report that omits
    // canvas geometry must return the same electrical result as an interactive comparison.
    if (!o.geometry) for (const c of changes) c.geometry = null;
    const stats = {version: VERSION, ms: round(now() - t0, 2), phases,
      objects: {before: IA.items.size, after: IB.items.size}, documents: {before: IA.docs.size, after: IB.docs.size},
      matched: {...M.stats, total: M.items.size}, unmatched: {before: IA.items.size - M.items.size, after: IB.items.size - M.back.size},
      components: M.componentStats, componentWork:M.componentWork || {scored:0,largestPool:0},
      prepared:{before:{signatures:IA.prepared.signatures-previously.signatures,footprints:IA.prepared.footprints-previously.footprints},after:IB.prepared},
      confidence: matchConfidence(M), suppressed, options: publicOptions(o),
      netlistSource: {before: netLists.a.schematic.source || "none", after: netLists.b.schematic.source || "none"}, warnings: []};
    if (stats.netlistSource.before !== stats.netlistSource.after) stats.warnings.push("The schematic netlists come from different sources (before: " + stats.netlistSource.before + ", after: " + stats.netlistSource.after + "); connectivity changes may reflect that.");
    const routing = changes.filter(c => c.kind === "routing.changed").map(c => ({net: c.target.net, doc: c.target.doc, docName: c.target.docName,
      lengthBefore: c.before.length, lengthAfter: c.after.length, viasBefore: c.before.vias, viasAfter: c.after.vias, areaBefore: c.before.area, areaAfter: c.after.area, change: c.id}));
    const result = {summary, changes, byObject, byNet, stats, routing, components: M.components};
    Object.defineProperty(result, "matching", {value: M, enumerable: false});
    return result;
  }
  // The view's coarse class of a change: added, removed, moved, modified (geometry, membership)
  // or properties (values, text, names, settings).
  function statusOf(kind) {
    if (/\.added$|^pin\.connected$|^drc\.new$/.test(kind)) return "added";
    if (/\.removed$|^pin\.disconnected$|^drc\.fixed$/.test(kind)) return "removed";
    // A position change is "moved"; rotation, mirroring and flipping change the object in place.
    if (/\.(moved|translated|document)$/.test(kind) && kind !== "pin.moved") return "moved";
    if (/\.(value|parameter|property|reannotated|designatorsSwapped|text|renamed|setting|net|changed|source)$|^comments\./.test(kind) && !/^library\./.test(kind)) return "properties";
    return "modified";
  }
  function pick(o, keys) { const out = {}; for (const k of keys) out[k] = o?.[k] ?? null; return out; }
  function publicOptions(o) { const out = {}; for (const k of Object.keys(DEFAULTS)) out[k] = o[k]; return out; }
  function matchConfidence(M) {
    let min = 1, sum = 0, n = 0;
    for (const m of M.items.values()) { if (m.confidence < min) min = m.confidence; sum += m.confidence; n++; }
    return {min: n ? min : 1, mean: n ? round(sum / n, 4) : 1, documents: Object.fromEntries([...M.docBy].map(([k, v]) => [k, v]))};
  }
  // Pins or pads keyed by number: which numbers were added, removed or changed.
  function keyedPins(a, b, o, word = "pin") {
    const ma = new Map((a || []).map(p => [String(p.number), p])), mb = new Map((b || []).map(p => [String(p.number), p])), out = [];
    // A layer stated on one side only (an import that writes defaults) is not a change.
    const fill = (x, y) => y.layer != null && x.layer == null ? {...x, layer: y.layer} : x;
    for (const [n, p0] of mb) { const q0 = ma.get(n), p = q0 ? fill(p0, q0) : p0, q = q0 && fill(q0, p0); if (!q) out.push(word + " " + n + " added"); else if (!same(q, p, o)) out.push(word + " " + n + " " + fieldDiff(q, p, o).map(f => f === "w" ? "width" : f === "h" ? "height" : f).join("/")); }
    for (const n of ma.keys()) if (!mb.has(n)) out.push(word + " " + n + " removed");
    return out.sort(natural);
  }
  // Records in a list (variants, rooms, classes, blocks) keyed by id, else name.
  // Records stored as a list ([{id|name, …}]) or as an object keyed by name ({Class: [members]}
  // for net, differential-pair and component classes, {name: {…}} otherwise).
  function records(x) {
    if (Array.isArray(x)) return x;
    if (!plain(x)) return [];
    return Object.keys(x).sort(natural).map(k => Array.isArray(x[k]) ? {name: k, members: x[k]} : plain(x[k]) ? {name: k, ...x[k]} : {name: k, value: x[k]});
  }
  function keyedDiff(a, b, type, label, category, severity, doc, push, o) {
    if (same(a, b, o)) return;
    const key = (r, i) => r?.id != null ? "id:" + r.id : r?.name != null ? "name:" + r.name : "#" + i;
    const ma = new Map(records(a).map((r, i) => [key(r, i), r])), mb = new Map(records(b).map((r, i) => [key(r, i), r]));
    const t = (r, x, y) => ({type, id: r?.id ?? r?.name ?? null, beforeId: x?.id ?? null, afterId: y?.id ?? null, name: r?.name ?? null, doc: doc?.id ?? null, docName: doc?.name ?? ""});
    for (const [k, r] of mb) {
      const p = ma.get(k);
      if (!p) push({kind: type + ".added", category, severity, target: t(r, null, r), before: null, after: r, text: label + " " + (r.name || r.id || k) + " added", geometry: null, match: null, fields: [], idSuffix: k});
      else if (!same(p, r, o)) {
        const fields = fieldDiff(p, r, o);
        let detail = fields.map(f => typeof r[f] === "object" && r[f] !== null ? f : f + " " + fmt(p[f]) + " → " + fmt(r[f])).join("; ");
        if (Array.isArray(p.members) && Array.isArray(r.members)) {
          const was = new Set(p.members.map(String)), now = new Set(r.members.map(String));
          const gained = [...now].filter(x => !was.has(x)).sort(natural), lost = [...was].filter(x => !now.has(x)).sort(natural);
          const bits = [...gained.map(x => "+" + x), ...lost.map(x => "−" + x)];
          if (bits.length) detail = list(bits, 8) + (fields.length > 1 ? "; " + fields.filter(f => f !== "members").join(", ") + " changed" : "");
        }
        if (type === "variant" && plain(p.parts) && plain(r.parts)) {
          const keys = [...new Set([...Object.keys(p.parts), ...Object.keys(r.parts)])].filter(x => !same(p.parts[x], r.parts[x], o)).sort(natural);
          if (keys.length) detail = plural(keys.length, "part entry", "part entries") + " changed (" + list(keys, 5) + ")";
        }
        push({kind: type + ".changed", category, severity, target: t(r, p, r), before: p, after: r, text: label + " " + (r.name || r.id || k) + ": " + detail, geometry: null, match: null, fields, idSuffix: k});
      }
    }
    for (const [k, r] of ma) if (!mb.has(k)) push({kind: type + ".removed", category, severity, target: t(r, r, null), before: r, after: null, text: label + " " + (r.name || r.id || k) + " removed", geometry: null, match: null, fields: [], idSuffix: k});
  }
  function rulesDiff(a, b, doc, push, o, signals = false) {
    const where = doc ? " (" + doc.name + ")" : "";
    // With signals (format 1.4) a board without rules reads the defaults, which is what the mirror writes
    // when signals are first edited; the class and pair keys are the signal model's (signalsDiff).
    if (signals && !a !== !b && globalThis.AtriumRules?.migrate) { a ||= AtriumRules.migrate(null); b ||= AtriumRules.migrate(null); }
    const ra = plain(a) ? a : {}, rb = plain(b) ? b : {};
    if (!a !== !b) {
      push({kind: "rules." + (a ? "removed" : "added"), category: "rules", severity: "mechanical", target: {type: "rules", id: doc?.id ?? null, doc: doc?.id ?? null, docName: doc?.name ?? ""},
        before: a ?? null, after: b ?? null, text: (doc ? "Board rules" + where : "Project rules") + (a ? " removed" : " added"), geometry: null, match: null, fields: ["rules"], idSuffix: doc?.id || "project"});
      return;
    }
    keyedDiff(ra.list, rb.list, "rule", "Rule" + where, "rules", "mechanical", doc, (c) => { c.idSuffix = (doc?.id || "p") + ":" + c.idSuffix; c.text = c.text.replace(/^Rule \(([^)]*)\) /, "Rule "); push(c); }, o);
    if (!signals) keyedDiff(ra.netClasses, rb.netClasses, "netClass", "Net class" + where, "rules", "electrical", doc, (c) => { c.idSuffix = (doc?.id || "p") + ":" + c.idSuffix; push(c); }, o);
    if (!signals) keyedDiff(ra.diffPairs, rb.diffPairs, "diffPair", "Differential pair" + where, "rules", "electrical", doc, (c) => { c.idSuffix = (doc?.id || "p") + ":" + c.idSuffix; push(c); }, o);
    if (!signals) keyedDiff(ra.diffPairClasses, rb.diffPairClasses, "diffPairClass", "Differential pair class" + where, "rules", "electrical", doc, (c) => { c.idSuffix = (doc?.id || "p") + ":" + c.idSuffix; push(c); }, o);
    const handled = new Set(["list", "netClasses", "diffPairs", "diffPairClasses", "format", "version", "units"]); // classes: keyedDiff (lists or {Class: [members]})
    const flat = (x, prefix, out) => { for (const [k, v] of Object.entries(x || {})) { if (!prefix && handled.has(k)) continue; if (plain(v)) flat(v, prefix + k + ".", out); else out[prefix + k] = v; } return out; };
    const fa = flat(ra, "", {}), fb = flat(rb, "", {});
    for (const k of [...new Set([...Object.keys(fa), ...Object.keys(fb)])].sort(natural)) {
      if (same(fa[k], fb[k], o, k.split(".").pop())) continue;
      push({kind: "rules.setting", category: "rules", severity: /net|class|pair/i.test(k) ? "electrical" : "mechanical", target: {type: "rules", id: doc?.id ?? null, field: k, doc: doc?.id ?? null, docName: doc?.name ?? ""},
        before: fa[k] ?? null, after: fb[k] ?? null, idSuffix: (doc?.id || "project") + ":" + k, text: (doc ? "Board rule " : "Rule ") + k + where + " " + fmt(fa[k]) + " → " + fmt(fb[k]), geometry: null, match: null, fields: ["rules"]});
    }
  }
  // Signals and tags (signals.js, format 1.4): the two sides' signal models are compared, never the raw
  // stores, so a file adopted into the store diffs as empty against its legacy original. Declarations by
  // id (else name), the derived span of a signal whose declaration did not change ("signal.span"), the
  // tag registry and net-level tags.
  // Signals are compared as models when either side has a signals store or schematic signal directives.
  // A newly waived violation hides a problem from DRC, ERC and Release, so it is shown as electrical.
  function waiversDiff(before, after, push) {
    const SEV = {added: "electrical", stale: "mechanical", removed: "mechanical", changed: "cosmetic"};
    const VERB = {added: "Waiver added", removed: "Waiver removed", changed: "Waiver changed", stale: "Waiver to review (objects changed)"};
    const docName = id => (after.documents || []).find(d => d.id === id)?.name || (before.documents || []).find(d => d.id === id)?.name || "";
    for (const c of globalThis.AtriumWaivers.diff(before, after)) {
      const w = c.waiver, label = w.title || w.rule || w.check;
      push({kind: "waiver." + c.kind, category: "waivers", severity: SEV[c.kind], target: {type: "waiver", id: w.id, beforeId: c.kind === "added" ? null : w.id, afterId: c.kind === "removed" ? null : w.id,
        doc: w.doc, docName: docName(w.doc), name: w.check, rule: w.rule || null, objects: w.objects.map(x => x.id)},
        before: c.before ? {note: c.before.note, holds: c.before.holds} : c.kind === "removed" ? {note: w.note, holds: w.holds} : null, after: c.kind === "removed" ? null : {note: w.note, holds: w.holds, author: w.author || null},
        text: VERB[c.kind] + ": " + label + (w.note ? " · " + w.note : "") + (w.author ? " · " + w.author : "") + (c.fields ? " (" + c.fields.join(", ") + ")" : ""),
        geometry: null, match: null, fields: c.fields || [], idSuffix: c.kind + ":" + w.store + ":" + w.id});
    }
  }
  function signalsIn(a, b) {
    const S = globalThis.AtriumSignals;
    if (!S) return false;
    if (a?.signals || b?.signals) return true;
    try { return !!(S.directives(a).records.length || S.directives(b).records.length); } catch { return false; }
  }
  function signalsDiff(pa, pb, da, db, push, o) {
    const S = globalThis.AtriumSignals, where = " (" + db.name + ")";
    let ma, mb;
    try { ma = S.model(pa, da); mb = S.model(pb, db); } catch { return; }
    const refOf = (M, id) => M.index?.parts.get(id)?.ref || id;
    const decl = (M, s) => ({name: s.name, kind: s.kind, legs: (s.decl.legs || []).map(l => ({polarity: l.polarity ?? null, nets: [...l.nets].sort(natural)})),
      members: s.members ? s.members.map(id => M.byId.get(id)?.name || id) : undefined, tags: [...(s.decl.tags || [])].sort(natural),
      exclude: (s.decl.exclude || []).map(id => refOf(M, id)).sort(natural), through: (s.decl.through || []).map(id => refOf(M, id)).sort(natural), span: s.decl.span !== false,
      paths: (s.decl.paths || []).map(p => p.name + (p.tags?.length ? " [" + p.tags.join(", ") + "]" : "")).sort(natural), stages: s.decl.stages || null,
      intent: s.decl.intent ?? null, impedance: s.decl.impedance ?? null, params: s.decl.params ?? null, comment: s.decl.comment || ""});
    const spanOf = s => s.legs.map(l => l.nets.join(" ")).join(" | ");
    const A = new Map(ma.signals.map(s => [s.id, s])), B = new Map(mb.signals.map(s => [s.id, s]));
    // Ids are stable once stored; across files without them (legacy on one side), match by name.
    for (const [id, s] of [...A]) if (!B.has(id)) { const t = mb.signals.find(x => !A.has(x.id) && x.name.toLowerCase() === s.name.toLowerCase()); if (t) { A.delete(id); A.set(t.id, s); } }
    const target = (s, x, y) => ({type: "signal", id: s.id, beforeId: x?.id ?? null, afterId: y?.id ?? null, name: s.name, doc: db.id, docName: db.name});
    const what = s => s.kind === "diff" ? "differential" : s.kind === "bus" ? "bus" : "single-ended";
    for (const [id, s] of B) {
      const p = A.get(id);
      if (!p) { push({kind: "signal.added", category: "rules", severity: "electrical", target: target(s, null, s), before: null, after: decl(mb, s), idSuffix: db.id + ":" + id, fields: [], geometry: null, match: null,
        text: "Signal " + s.name + where + " added (" + what(s) + (s.kind === "bus" ? ", " + plural(s.members.length, "member") : ", " + plural(new Set(s.legs.flatMap(l => l.nets)).size, "net")) + ")"}); continue; }
      const x = decl(ma, p), y = decl(mb, s), fields = Object.keys(y).filter(k => !same(x[k], y[k], o));
      if (fields.length) {
        const bits = [];
        for (const f of fields) {
          if (f === "legs" && s.kind === "diff" && x.legs.length === 2 && same(x.legs.map(l => l.nets).sort(), y.legs.map(l => l.nets).sort(), o)) bits.push("polarity flipped");
          else if (f === "tags" || f === "exclude" || f === "through" || f === "paths") {
            const was = new Set(x[f]), now = new Set(y[f]), gained = y[f].filter(v => !was.has(v)), lost = x[f].filter(v => !now.has(v));
            const word = {tags: "tags", exclude: "no longer crosses", through: "crosses", paths: "paths"}[f];
            if (f === "exclude") { if (gained.length) bits.push("no longer crosses " + list(gained)); if (lost.length) bits.push("crosses " + list(lost) + " again"); }
            else bits.push(word + " " + list([...gained.map(v => "+" + v), ...lost.map(v => "−" + v)], 8));
          } else if (f === "name") bits.push("renamed from " + x.name);
          else if (f === "span") bits.push(y.span ? "spans series parts" : "no longer spans series parts");
          else bits.push(f + " changed");
        }
        push({kind: "signal.changed", category: "rules", severity: "electrical", target: target(s, p, s), before: x, after: y, idSuffix: db.id + ":" + id, fields, geometry: null, match: null,
          text: "Signal " + s.name + where + ": " + bits.join("; ")});
      } else if (spanOf(p) !== spanOf(s)) {
        const was = new Set(p.legs.flatMap(l => l.nets)), now = new Set(s.legs.flatMap(l => l.nets)), gained = [...now].filter(n => !was.has(n)).sort(natural), lost = [...was].filter(n => !now.has(n)).sort(natural);
        const parts = [...new Set(s.legs.flatMap(l => l.parts.map(q => q.ref)))].filter(r => !p.legs.some(l => l.parts.some(q => q.ref === r))).sort(natural);
        push({kind: "signal.span", category: "rules", severity: "electrical", target: target(s, p, s), before: {nets: [...was].sort(natural)}, after: {nets: [...now].sort(natural)}, idSuffix: db.id + ":" + id + ":span",
          fields: ["span"], geometry: null, match: null, derived: true,
          text: "Signal " + s.name + where + (gained.length ? " now also spans " + list(gained) + (parts.length ? " (" + list(parts) + ")" : "") : "") + (lost.length ? (gained.length ? "; " : " ") + "no longer spans " + list(lost) : "") + " (from the netlist)"});
      }
    }
    for (const [id, p] of A) if (!B.has(id)) push({kind: "signal.removed", category: "rules", severity: "electrical", target: target(p, p, null), before: decl(ma, p), after: null, idSuffix: db.id + ":" + id, fields: [], geometry: null, match: null,
      text: "Signal " + p.name + where + " removed"});
    keyedDiff(ma.store.tags || [], mb.store.tags || [], "tag", "Tag" + where, "rules", "electrical", db, c => { c.idSuffix = db.id + ":" + c.idSuffix; push(c); }, o);
    // Net-level tags (exact class membership), by net.
    const netTags = M => { const out = new Map(); for (const [n, v] of Object.entries(M.store.nets || {})) for (const r of Array.isArray(v) ? v : [v]) if (!r.boards || r.boards.includes(M.board.id)) { if (!out.has(n)) out.set(n, new Set()); r.tags.forEach(t => out.get(n).add(t)); } return out; };
    const na = netTags(ma), nb = netTags(mb);
    for (const n of [...new Set([...na.keys(), ...nb.keys()])].sort(natural)) {
      const x = [...(na.get(n) || [])].sort(natural), y = [...(nb.get(n) || [])].sort(natural);
      if (same(x, y, o)) continue;
      const gained = y.filter(t => !x.includes(t)), lost = x.filter(t => !y.includes(t));
      push({kind: "netTag.changed", category: "rules", severity: "electrical", target: {type: "net", id: n, net: n, doc: db.id, docName: db.name}, before: x, after: y, idSuffix: db.id + ":" + n, fields: ["tags"], geometry: null, match: null,
        text: "Net " + n + where + " tags " + list([...gained.map(t => "+" + t), ...lost.map(t => "−" + t)], 8)});
    }
  }
  function stackupDiff(a, b, o, push, m) {
    const sa = a.stackup, sb = b.stackup;
    if (same(sa, sb, o)) return;
    const la = Array.isArray(sa?.layers) ? sa.layers : [], lb = Array.isArray(sb?.layers) ? sb.layers : [];
    const copper = l => l.filter(x => /copper|signal|plane/i.test(x.type || x.kind || "") || /^(Top|Bottom|Inner)/.test(x.name || "")).length;
    const bits = [];
    if (la.length !== lb.length) bits.push(la.length + " → " + lb.length + " layers");
    if (copper(la) !== copper(lb)) bits.push(copper(la) + " → " + copper(lb) + " copper layers");
    const thick = l => l.reduce((s, x) => s + (num(x.thickness) ? x.thickness : 0), 0);
    if (Math.abs(thick(la) - thick(lb)) > o.tolerance) bits.push("thickness " + round(thick(la), 4) + " → " + round(thick(lb), 4) + " mm");
    if (!bits.length) {
      const n = Math.max(la.length, lb.length);
      for (let i = 0; i < n; i++) if (!same(la[i], lb[i], o)) bits.push((lb[i]?.name || la[i]?.name || "layer " + (i + 1)) + " " + fieldDiff(la[i], lb[i], o).join("/"));
    }
    push({kind: "board.stackup", category: "pcb", severity: "mechanical", target: {type: "stackup", id: b.id, beforeId: a.id, afterId: b.id, doc: b.id, docName: b.name},
      before: sa ?? null, after: sb ?? null, text: "Stack-up of " + b.name + " changed" + (bits.length ? ": " + list(bits, 4) : ""), geometry: null, match: m, fields: ["stackup"]});
  }
  function summarise(changes, IA, IB, M, suppressed, byNet) {
    const bySeverity = {electrical: 0, mechanical: 0, cosmetic: 0}, byCategory = {}, byKind = {};
    for (const c of changes) {
      bySeverity[c.severity]++;
      const k = byCategory[c.category] || (byCategory[c.category] = {total: 0, electrical: 0, mechanical: 0, cosmetic: 0});
      k.total++; k[c.severity]++;
      byKind[c.kind] = (byKind[c.kind] || 0) + 1;
    }
    const docs = [];
    const counts = new Map();
    for (const c of changes) if (c.target.doc) counts.set(c.target.doc, (counts.get(c.target.doc) || 0) + 1);
    for (const [da, db] of M.docs) { const d = IB.docs.get(db); docs.push({id: d.id, beforeId: da, name: d.name, kind: d.kind, status: counts.get(d.id) ? "changed" : "unchanged", changes: counts.get(d.id) || 0}); }
    for (const d of IB.docs.values()) if (![...M.docs.values()].includes(d.id)) docs.push({id: d.id, beforeId: null, name: d.name, kind: d.kind, status: "added", changes: counts.get(d.id) || 0});
    for (const d of IA.docs.values()) if (!M.docs.has(d.id)) docs.push({id: d.id, beforeId: d.id, name: d.name, kind: d.kind, status: "removed", changes: counts.get(d.id) || 0});
    const nets = {renamed: byKind["net.renamed"] || 0, merged: byKind["net.merged"] || 0, split: byKind["net.split"] || 0, added: byKind["net.added"] || 0, removed: byKind["net.removed"] || 0,
      pinsMoved: byKind["pin.moved"] || 0, pinsSwapped: byKind["pin.swapped"] || 0, pinsConnected: byKind["pin.connected"] || 0, pinsDisconnected: byKind["pin.disconnected"] || 0, touched: Object.keys(byNet).length};
    const count = k => Object.entries(byKind).filter(([x]) => x === k || x.startsWith(k + ".")).reduce((s, [, n]) => s + n, 0);
    const parts = {added: byKind["part.added"] || 0, removed: byKind["part.removed"] || 0, moved: (byKind["part.moved"] || 0), rotated: byKind["part.rotated"] || 0, flipped: byKind["part.flipped"] || 0,
      reannotated: byKind["part.reannotated"] || 0, values: byKind["part.value"] || 0, footprints: byKind["part.footprint"] || 0, symbols: byKind["part.symbol"] || 0};
    const headline = [];
    const lines = [];
    if (bySeverity.electrical) lines.push(plural(bySeverity.electrical, "electrical change"));
    if (bySeverity.mechanical) lines.push(plural(bySeverity.mechanical, "mechanical change"));
    if (bySeverity.cosmetic) lines.push(plural(bySeverity.cosmetic, "cosmetic change"));
    for (const c of changes) { if (headline.length >= 12) break; headline.push(c.text); }
    return {identical: !changes.length, total: changes.length, bySeverity, byCategory, byKind, parts, nets, copper: {tracks: count("track") + count("arc"), vias: count("via"), pours: count("pour"), routing: byKind["routing.changed"] || 0},
      documents: docs, headline, text: changes.length ? lines.join(", ") : "No design changes", suppressed: {...suppressed}};
  }

  // ------------------------------------------------------------------ running
  function finish(steps) { let s; do { s = steps.next(); } while (!s.done); return s.value; }
  function check(p) { if (A()?.validate) A().validate(p); return p; }
  function compare(before, after, opts) {
    if (opts?.validate !== false) { check(before); check(after); }
    return finish(compareSteps(before, after, opts, null));
  }
  async function runInSlices(steps, active) {
    while (active()) {
      const deadline = now() + 8;
      do { const s = steps.next(); if (s.done) return s.value; } while (now() < deadline);
      await new Promise(r => setTimeout(r, 0));
    }
    return null;
  }
  const sizeOf = p => (p?.documents || []).reduce((n, d) => n + (d.items?.length || 0), 0);
  // Large designs go to diff-worker.js (beside this file) when the host allows workers; the
  // result is the same object shape. Otherwise the comparison yields to the UI every 8 ms.
  let workerUrl = null;
  const WORKER_MS = 120000;   // silence (no message, not even a heartbeat) before a worker counts as hung
  try { workerUrl = typeof document !== "undefined" && document.currentScript?.src ? new URL("../workers/diff-worker.js", document.currentScript.src).href : null; } catch { workerUrl = null; }
  // One spare worker, started by warm() while the caller paints, so its scripts load in parallel.
  let spare = null;
  const newWorker = () => globalThis.AtriumWorkerPool?.script ? globalThis.AtriumWorkerPool.script(workerUrl) : new Worker(workerUrl);
  const wantsWorker = (before, after, o) => !!(o.worker && workerUrl && typeof Worker === "function" && sizeOf(before) + sizeOf(after) >= o.workerThreshold && !o.cache);
  // warm(before, after, opts?): when compareAsync would use the worker for this pair, start it now
  // (it loads model.js … diff.js) so the comparison posted a frame later starts at once. Returns
  // whether a worker is warming.
  function warm(before, after, opts = {}) {
    if (spare || !wantsWorker(before, after, {...DEFAULTS, ...opts})) return !!spare;
    try { spare = newWorker(); spare.postMessage({warm: true, drc: !!opts.drc}); } catch { spare = null; }
    return !!spare;
  }
  function inWorker(before, after, opts, active) {
    return new Promise((resolve, reject) => {
      let w;
      // AtriumWorkerPool.script (worker-pool.js, a lazy dependency): WKWebView and WebKitGTK never start a file:// URL worker.
      if (spare) { w = spare; spare = null; }
      else try { w = newWorker(); } catch (e) { reject(e); return; }
      let timer = 0, dog = 0;
      // Watchdog: a worker silent for WORKER_MS is stopped and the comparison runs in slices instead.
      // diff-worker.js posts a {progress} heartbeat at least once a second while it compares, and each
      // one re-arms the timer: a long comparison keeps going, only a hung worker is stopped.
      const arm = () => { clearTimeout(dog); dog = setTimeout(() => { done(); globalThis.AtriumDiagnostics?.record?.("hang", "diff"); reject(Error("The diff worker stopped responding.")); }, WORKER_MS); };
      const done = () => { clearTimeout(dog); clearInterval(timer); try { w.terminate(); } catch {} };
      arm();
      // A cancelled comparison (the view closed or another one started) stops the worker instead of
      // letting it finish a result nobody reads.
      if (typeof active === "function" && typeof setInterval === "function") timer = setInterval(() => { if (!active()) { done(); resolve(null); } }, 100);
      w.onmessage = e => { if (e.data?.progress) { arm(); return; } done(); if (e.data?.error) reject(Error(e.data.error)); else resolve(e.data.result); };
      w.onerror = w.onmessageerror = e => { done(); e?.preventDefault?.(); globalThis.AtriumDiagnostics?.record?.("worker", "diff"); reject(Error(e?.message || "The diff worker failed.")); };
      w.postMessage({before, after, opts: {...(opts || {}), worker: false}});
    });
  }
  async function compareInBackground(before, after, opts, active) {
    if(!globalThis.AtriumNotebook && globalThis.AtriumLazy && [before,after].some(p=>p?.documents?.some(d=>d.items?.some(noteOwner)))) await globalThis.AtriumLazy.need("AtriumNotebook");
    if(globalThis.AtriumNotebook) await AtriumNotebook.demand([before,after]);
    const o = {...DEFAULTS, ...opts};
    if (wantsWorker(before, after, o)) {
      try { const r = await inWorker(before, after, opts, active); return active() ? r : null; } catch { /* fall back to slices */ }
    }
    if (opts.validate !== false) {
      if (A()?.validationSteps) { const v1 = await runInSlices(A().validationSteps(before), active); if (!active()) return null; void v1; const v2 = await runInSlices(A().validationSteps(after), active); if (!active()) return null; void v2; }
    }
    return runInSlices(compareSteps(before, after, opts, opts.cache || null), active);
  }
  function compareAsync(before, after, opts = {}, active = () => true) {
    const timing = globalThis.AtriumDiagnostics?.performance?.begin("history", "compute");
    const result = compareInBackground(before, after, opts, active);
    if (!timing) return result;
    return result.then(value => {
      timing.end(value == null ? "cancelled" : "completed");
      return value;
    }, error => {
      timing.end(error?.name === "AbortError" || error?.cancelled ? "cancelled" : "failed");
      throw error;
    });
  }
  // Incremental comparisons against one baseline (Git HEAD, a saved file): its index and netlist
  // are built once, then each compare(after) only indexes the working design.
  function session(before, opts = {}) {
    check(before);
    const cache = {before, index: null, nets: null};
    return {
      before,
      compare: (after, more) => { if ((more || opts).validate !== false) check(after); return finish(compareSteps(before, after, {...opts, ...(more || {})}, cache)); },
      compareAsync: (after, more, active) => compareAsync(before, after, {...opts, ...(more || {}), cache, worker: false}, active)
    };
  }
  function match(before, after, opts) {
    const o = options(opts);
    return finish(matchSteps(indexOf(before), indexOf(after), o));
  }
  // `before` as a new project whose matched documents, objects and library entries carry
  // `after`'s ids (part.def follows), so an id-keyed record view lines both sides up.
  function remap(before, after, opts = {}) {
    const M = opts.matching || match(before, after, opts);
    const defId = id => M.defs.get(id)?.id ?? id;
    const taken = new Set([...indexOf(after).items.keys()]);
    const itemId = id => { const m = M.items.get(id); return m && !m.review ? m.id : taken.has(id) ? id + "~before" : id; };
    return {...before,
      library: (before.library || []).map(d => M.defs.has(d.id) && M.defs.get(d.id).id !== d.id ? {...d, id: M.defs.get(d.id).id} : d),
      documents: before.documents.map(d => ({...d, id: M.docs.get(d.id) ?? d.id, items: d.items.map(i => {
        const id = itemId(i.id), def = i.kind === "part" ? defId(i.def) : i.def;
        const sheet = i.kind === "sheetsymbol" ? M.docs.get(i.sheet) ?? i.sheet : i.sheet;
        return id === i.id && def === i.def && sheet === i.sheet ? i : {...i, id, ...(i.kind === "part" ? {def} : {}), ...(sheet !== i.sheet ? {sheet} : {})};
      })}))};
  }

  // ------------------------------------------------------------------ reports
  // Every design-derived string is escaped for its format: Markdown cannot gain links, images
  // or HTML; HTML gets text only (no attributes from the design, no scripts, no remote loads).
  // Bare URLs are broken with a zero-width space so GFM renderers do not auto-link design text.
  const mdEsc = s => String(s ?? "").replace(/[\\`*_[\]<>|~#]/g, c => "\\" + c).replace(/[\r\n\u2028\u2029]+/g, " ").replace(/:\/\//g, ":\u200b//").replace(/\bwww\./gi, m => m.slice(0, 3) + "\u200b.");
  const htmlEsc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;"}[c]));
  const SEV_TITLE = {electrical: "Electrical", mechanical: "Mechanical", cosmetic: "Cosmetic"};
  const CAT_TITLE = {notes:"Notes", connectivity: "Connectivity", schematic: "Schematic", pcb: "PCB", library: "Library", rules: "Rules and constraints", drc: "DRC", project: "Project"};
  function filterChanges(r, opts = {}) {
    const sev = opts.severity ? RANK[opts.severity] : 2;
    return r.changes.filter(c => RANK[c.severity] <= sev && (!opts.category || c.category === opts.category) && (!opts.net || c.target.net === opts.net));
  }
  function matchNote(m) {
    if (!m || m.by === "id") return "";
    const reason = m.reasons?.length ? ", " + m.reasons.join(", ") : "";
    return (m.review ? "proposed match by " : "matched by ") + m.by + reason;
  }
  function reviewNote(r) {
    const s=r.stats?.components;
    return s && (s.review || s.unpairedReview) ? "Component review covers " + plural(s.review, "proposed pair") + " and " + plural(s.unpairedReview, "unpaired component") + "." : "";
  }
  function toMarkdown(r, opts = {}) {
    const limit = opts.limit ?? 500, s = r.summary, out = ["# " + mdEsc(opts.title || "Design changes"), ""];
    if (opts.from || opts.to) out.push(mdEsc(opts.from || "before") + " → " + mdEsc(opts.to || "after"), "");
    if (reviewNote(r)) out.push(reviewNote(r), "");
    if (s.identical) return out.concat("No design changes.", "").join("\n");
    out.push("**" + s.total + " changes:** " + SEVERITIES.map(k => s.bySeverity[k] + " " + k).join(" · "), "");
    const n = s.nets, nb = [n.renamed && n.renamed + " renamed", n.merged && n.merged + " merged", n.split && n.split + " split", n.added && n.added + " added", n.removed && n.removed + " removed",
      n.pinsMoved && plural(n.pinsMoved, "pin") + " moved", n.pinsSwapped && plural(n.pinsSwapped, "pin swap")].filter(Boolean);
    if (nb.length) out.push("**Nets:** " + nb.join(", "), "");
    const shown = filterChanges(r, opts);
    for (const cat of CATEGORIES) {
      const rows = shown.filter(c => c.category === cat);
      if (!rows.length) continue;
      out.push("## " + CAT_TITLE[cat] + " (" + rows.length + ")", "");
      for (const sev of SEVERITIES) {
        const these = rows.filter(c => c.severity === sev);
        if (!these.length) continue;
        out.push("### " + SEV_TITLE[sev], "");
        for (const c of these.slice(0, limit)) {
          const note = matchNote(c.match);
          out.push("- " + mdEsc(c.text) + (note ? " _(" + mdEsc(note) + ")_" : ""));
        }
        if (these.length > limit) out.push("- … " + (these.length - limit) + " more");
        out.push("");
      }
    }
    const routed = Object.values(r.byNet).filter(e => Object.values(e.boards).some(b => b.routing));
    if (routed.length) {
      out.push("## Routing by net", "", "| Net | Board | Length Δ (mm) | Vias | Pour area Δ (mm²) |", "|---|---|---:|---:|---:|");
      for (const e of routed.sort((x, y) => natural(x.name, y.name)).slice(0, limit)) for (const [id, b] of Object.entries(e.boards)) if (b.routing) {
        out.push("| " + mdEsc(e.name) + " | " + mdEsc(r.summary.documents.find(d => d.id === id)?.name || id) + " | " + signed(b.routing.lengthDelta, 3) + " | " + b.routing.before.vias + " → " + b.routing.after.vias + " | " + signed(b.routing.areaDelta, 2) + " |");
      }
      out.push("");
    }
    const st = r.stats, m = st.matched;
    const methods = Object.entries(m).filter(([name, count]) => name !== "total" && count > 0)
      .map(([name, count]) => count + " by " + (name === "net-geometry" ? "net and geometry" : name));
    out.push("---", "", "Matched " + m.total + " objects" + (methods.length ? " (" + methods.join(", ") + ")" : "") + ". " +
      "Compared in " + st.ms + " ms." + (Object.values(st.suppressed).some(Boolean) ? " Ignored noise: " + Object.entries(st.suppressed).filter(([, v]) => v).map(([k, v]) => k + " " + v).join(", ") + "." : ""), "");
    return out.join("\n");
  }
  function plainChange(c) {
    const strip = v => v && typeof v === "object" && !Array.isArray(v) && v.kind && v.id ? {id: v.id, kind: v.kind, ref: v.ref, net: v.net, layer: v.layer, value: v.value} : v;
    return {id: c.id, kind: c.kind, status: c.status, category: c.category, severity: c.severity, text: c.text, target: c.target, before: strip(c.before), after: strip(c.after), match: c.match, fields: c.fields,
      geometry: c.geometry ? {doc: c.geometry.doc, box: c.geometry.box} : null, ...(c.translation ? {translation:c.translation} : {}),
      ...(c.lengthDelta != null ? {lengthDelta: c.lengthDelta, viaDelta: c.viaDelta, areaDelta: c.areaDelta} : {}), ...(c.areaDelta != null && c.lengthDelta == null ? {areaDelta: c.areaDelta} : {})};
  }
  function toJSON(r, opts = {}) {
    const changes = filterChanges(r, opts), limit = opts.limit ?? Infinity;
    return {format: "atrium-diff", version: VERSION, summary: r.summary, stats: r.stats, components: (r.components || []).slice(0, limit), changes: changes.slice(0, limit).map(plainChange), truncated: changes.length > limit ? changes.length - limit : 0,
      routing: r.routing || [],
      byNet: Object.fromEntries(Object.entries(r.byNet).map(([k, e]) => [k, {...e, schematic: e.schematic && {gained: e.schematic.gained, lost: e.schematic.lost, before: e.schematic.before.map(p => p.label), after: e.schematic.after.map(p => p.label)},
        boards: Object.fromEntries(Object.entries(e.boards).map(([id, b]) => [id, {...b, before: b.before?.map(p => p.label), after: b.after?.map(p => p.label)}]))}]))};
  }
  function toHTML(r, opts = {}) {
    const s = r.summary, limit = opts.limit ?? 2000, title = opts.title || "Design changes";
    const badge = sev => "<span class=\"sev sev-" + sev + "\">" + SEV_TITLE[sev] + "</span>";
    const rows = [];
    const shown = filterChanges(r, opts);
    for (const cat of CATEGORIES) {
      const these = shown.filter(c => c.category === cat);
      if (!these.length) continue;
      rows.push("<section><h2>" + CAT_TITLE[cat] + " <small>" + these.length + "</small></h2><table><thead><tr><th>Severity</th><th>Change</th><th>Where</th></tr></thead><tbody>");
      for (const c of these.slice(0, limit)) {
        const note = matchNote(c.match);
        rows.push("<tr><td>" + badge(c.severity) + "</td><td>" + htmlEsc(c.text) + (note ? " <em>(" + htmlEsc(note) + ")</em>" : "") +
          "</td><td>" + htmlEsc(c.target.docName || c.target.domain || "") + "</td></tr>");
      }
      if (these.length > limit) rows.push("<tr><td></td><td>… " + (these.length - limit) + " more</td><td></td></tr>");
      rows.push("</tbody></table></section>");
    }
    // One overview per document: the board or sheet extent with each change's box.
    const maps = [];
    for (const d of s.documents) {
      const cs = shown.filter(c => c.geometry?.doc === d.id && c.geometry.box);
      if (!cs.length) continue;
      let box = null; for (const c of cs) box = unionBox(box, c.geometry.box);
      const w = Math.max(box[2] - box[0], 1), h = Math.max(box[3] - box[1], 1), pad = Math.max(w, h) * 0.05;
      const vb = [box[0] - pad, box[1] - pad, w + 2 * pad, h + 2 * pad].map(v => round(v, 3)).join(" ");
      const sw = round(Math.max(w, h) / 300, 4);
      const shapes = cs.slice(0, 4000).map(c => { const b = c.geometry.box; return "<rect class=\"m-" + c.severity + "\" x=\"" + round(b[0], 3) + "\" y=\"" + round(b[1], 3) + "\" width=\"" + round(Math.max(b[2] - b[0], sw * 4), 3) + "\" height=\"" + round(Math.max(b[3] - b[1], sw * 4), 3) + "\" stroke-width=\"" + sw + "\"><title>" + htmlEsc(c.text) + "</title></rect>"; }).join("");
      maps.push("<figure><svg viewBox=\"" + vb + "\" role=\"img\" aria-label=\"Changes on " + htmlEsc(d.name) + "\">" + shapes + "</svg><figcaption>" + htmlEsc(d.name) + " · " + plural(cs.length, "highlighted change") + "</figcaption></figure>");
    }
    const css = ":root{--bg:#fff;--fg:#1d2125;--muted:#5b636b;--line:#d8dde2;--e:#b3261e;--m:#8a5a00;--c:#3b6ea5}" +
      "@media (prefers-color-scheme:dark){:root{--bg:#16191c;--fg:#e6e9ec;--muted:#a3abb3;--line:#33393f;--e:#f0857d;--m:#e5b84b;--c:#7fb2e6}}" +
      "body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,sans-serif}main{max-width:1100px;margin:auto}" +
      "h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:28px 0 8px}h2 small{color:var(--muted);font-weight:400}p.meta{color:var(--muted)}" +
      "table{width:100%;border-collapse:collapse}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--muted);font-weight:600}" +
      ".sev{display:inline-block;padding:1px 8px;border-radius:9px;font-size:12px;border:1px solid currentColor}.sev-electrical{color:var(--e)}.sev-mechanical{color:var(--m)}.sev-cosmetic{color:var(--c)}" +
      ".cards{display:flex;gap:12px;flex-wrap:wrap}.card{border:1px solid var(--line);border-radius:8px;padding:10px 14px;min-width:120px}.card b{font-size:22px;display:block}" +
      "figure{margin:16px 0;border:1px solid var(--line);border-radius:8px;padding:8px}svg{width:100%;max-height:420px}rect{fill:none}" +
      ".m-electrical{stroke:var(--e)}.m-mechanical{stroke:var(--m)}.m-cosmetic{stroke:var(--c)}figcaption{color:var(--muted);font-size:12px}em{color:var(--muted)}";
    const cards = SEVERITIES.map(k => "<div class=\"card\"><b>" + s.bySeverity[k] + "</b>" + SEV_TITLE[k] + "</div>").join("");
    return "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">" +
      "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'\"><title>" + htmlEsc(title) + "</title><style>" + css + "</style></head><body><main>" +
      "<h1>" + htmlEsc(title) + "</h1><p class=\"meta\">" + htmlEsc((opts.from || "before") + " → " + (opts.to || "after")) + " · " + htmlEsc(s.text) + "</p>" +
      (reviewNote(r) ? "<p>" + htmlEsc(reviewNote(r)) + "</p>" : "") +
      (s.identical ? "<p>No design changes.</p>" : "<div class=\"cards\">" + cards + "</div>" + maps.join("") + rows.join("")) +
      "<p class=\"meta\">Waffle diff v" + VERSION + " · matched " + r.stats.matched.total + " objects · " + r.stats.ms + " ms</p></main></body></html>\n";
  }

  return Object.freeze({VERSION, DEFAULTS, SEVERITIES, CATEGORIES, AUTO_NET, compare, compareAsync, warm, compareSteps: (a, b, o) => compareSteps(a, b, o, null), session, match, remap,
    toMarkdown, toJSON, toHTML, filter: filterChanges, shapeOf, isMove, fieldDiff, same: (a, b, o) => same(a, b, o?.ignore ? o : options(o)), escapeMarkdown: mdEsc, escapeHTML: htmlEsc});
})();
if (typeof module === "object" && module && module.exports) module.exports = globalThis.AtriumDiff;
