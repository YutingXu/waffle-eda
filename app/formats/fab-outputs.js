"use strict";
if (!globalThis.AtriumPCBText && typeof require === "function") require("../pcb/pcb-text.js");
if (!globalThis.AtriumGeometryMaterial && typeof require === "function") require("../pcb/geometry-material.js");
if (!globalThis.AtriumMaskOpenings && typeof require === "function") require("../pcb/mask-openings.js");

// Fabrication and assembly outputs modelled on Altium's Output Job: Gerber
// RS-274X with X2 attributes, Excellon NC drill, pick and place CSV and
// assembly drawings.
//
// Coordinates: the document model is in millimetres with Y pointing down
// (the canvas convention; Altium Y-up coordinates are negated on import).
// CAM coordinates are Y-up with the board or drill origin. The default "auto" origin is the board
// origin (doc.origin) when set, else "outline": the lower-left corner of the
// board outline as viewed from the top. "user" is doc.origin. With
// the "absolute" origin it is (0, 0), which reproduces Altium's absolute
// coordinates for an imported PcbDoc. NC drill follows this origin unless
// drillOrigin overrides it. A model angle a (clockwise on screen) becomes
// the counter-clockwise output angle -a.
globalThis.AtriumFabOutputs = (() => {
  const A = Atrium, PCB = AtriumPCBAppearance, M = AtriumMaskOpenings, L = AtriumResolvedLand;
  const VERSION = "1.0";
  const DEFAULT_PROFILE_WIDTH = .1;

  const {glyphs} = globalThis.AtriumStrokeFont;
  const {strokeText} = globalThis.AtriumPCBText;

  // ---------------------------------------------------------------------------
  // Small helpers
  // fixed: toFixed without a negative zero ("-0.000" -> "0.000"); trim: and without trailing zeros
  // or point. Character loops, no regular expressions: these run for every coordinate written.
  const fixed = (v, d) => {
    const s = (+v).toFixed(d);
    if (s.charCodeAt(0) !== 45 || s.charCodeAt(1) !== 48) return s;
    for (let i = 2; i < s.length; i++) { const c = s.charCodeAt(i); if (c !== 48 && !(i === 2 && c === 46)) return s; }
    return s.slice(1);
  };
  const trim = (v, d = 6) => {
    let s = fixed(v, d);
    if (s.indexOf(".") >= 0) { let e = s.length; while (s.charCodeAt(e - 1) === 48) e--; if (s.charCodeAt(e - 1) === 46) e--; s = s.slice(0, e); }
    return s === "-0" ? "0" : s;
  };
  const norm360 = a => { const r = ((a % 360) + 360) % 360; return Math.abs(r - 360) < 1e-9 ? 0 : r; };
  const xml = s => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&apos;"})[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  const comment = s => String(s).replace(/[^\x20-\x7e]/g, "?").replace(/[*%]/g, "_");
  // Gerber X2 attribute field (Ucamco Gerber Layer Format Specification,
  // revision 2024.05, §3.4.3 "String" and §5.1 "Attributes overview"): fields
  // are printable ASCII separated by commas; %, *, the comma and the
  // backslash itself, and every character outside printable ASCII, are
  // written as \uXXXX (\UXXXXXXXX above the BMP). Control characters are
  // dropped. Equal input always gives equal output.
  function x2Field(v) {
    let out = "";
    for (const ch of String(v ?? "")) {
      const c = ch.codePointAt(0);
      if (c < 0x20 || c === 0x7f) continue;
      if (c <= 0x7e && !"%*,\\".includes(ch)) out += ch;
      else out += c > 0xffff ? "\\U" + c.toString(16).toUpperCase().padStart(8, "0") : "\\u" + c.toString(16).toUpperCase().padStart(4, "0");
    }
    return out;
  }
  const baseName = s => String(s || "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "-").trim() || "Board";
  // File names: options.fileStem when given (the dialog defaults it to the project name), else the board's name.
  const stemOf = (model, o) => o?.fileStem ? baseName(o.fileStem) : baseName(model.doc.name);
  // "My sensor board" -> "My-sensor-board": no spaces or characters fab houses' tools trip over.
  const slug = s => String(s || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\w.+-]+/g, "-").replace(/-+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  function defaultStem(project, doc) {
    const boards = project.documents.filter(d => d.kind === "pcb").length;
    return [slug(project.name) || "Board", boards > 1 ? slug(doc.name) : ""].filter(Boolean).join("-");
  }
  const copper = l => PCB.index(l) >= 0;
  const sameXY = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  function isoDate(date) {
    const pad = n => String(n).padStart(2, "0"), off = -date.getTimezoneOffset();
    return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" +
      pad(date.getMinutes()) + ":" + pad(date.getSeconds()) + (off >= 0 ? "+" : "-") + pad(Math.floor(Math.abs(off) / 60)) + ":" + pad(Math.abs(off) % 60);
  }

  // ---------------------------------------------------------------------------
  const {padShape, padGeom, expandPad} = M;
  // Polygon writers retain their established angular sampling and starting
  // edge. The exact land and the tessellator are shared with the physical view.
  function padOutline(g) {
    const area=AtriumLandContours.aperture(g);
    if(!area.length)return [];
    let {outer}=area[0];
    if(outer.every(edge=>edge.kind==="line"))return outer.map(edge=>edge.a);
    const full=g.shape==="circle"||g.shape==="ellipse", stadium=g.shape==="obround";
    const samples=g.shape==="circle"?48:g.shape==="ellipse"?64:stadium?8:6;
    if(full)outer=[{...outer[0],start:0}];
    else if(stadium&&g.h>g.w){
      const start=outer.findIndex(edge=>edge.kind==="arc"&&edge.start===0);
      outer=[...outer.slice(start),...outer.slice(0,start)];
    }
    const radius=g.shape==="ellipse"?Math.hypot(g.w,g.h)/2:g.r;
    const step=(full?2*Math.PI:Math.PI/2)/samples;
    // Supply the corresponding sagitta to the common error-bounded sampler.
    const tolerance=2*radius*Math.sin(step/4)**2*(1+1e-12);
    const points=AtriumGeometryCurves.flatten(outer,tolerance).slice(0,-1);
    return points.filter((p,i)=>!sameXY(p,points[(i+points.length-1)%points.length]));
  }
  const placeOutline = (g, at) => padOutline(g).map(p => A.world(p, {x: at[0], y: at[1], angle: g.angle}));

  // A land can be omitted only when no other plotted copper could contact its
  // entire disk. The margin covers rounding at the coarsest supported film grid.
  const LAND_MARGIN = .005;
  const finitePoint = p => Number.isFinite(p?.[0]) && Number.isFinite(p?.[1]);
  const inflate = (box, r) => [box[0]-r,box[1]-r,box[2]+r,box[3]+r];
  const diskBounds = ([x,y],r) => [x-r,y-r,x+r,y+r];
  function copperObstacles(f) {
    if (f.t === "flash") {
      const p = f.pad;
      const r = p.shape === "circle" ? p.w / 2 : L.radius(p);
      if (!finitePoint(f.at) || !Number.isFinite(r) || r <= 0) return null;
      return [{box:diskBounds(f.at,r), touches:([x,y],d) => Math.hypot(f.at[0]-x,f.at[1]-y) <= r+d}];
    }
    if (f.t === "circle" || f.t === "stroke") {
      const half = f.width/2, arc = f.arc, c = f.c || arc?.c, r = f.r || arc?.r;
      const points = f.points || [], curves = f.t === "circle" || !!arc;
      if (!(half > 0) || !Number.isFinite(half) || !points.every(finitePoint) ||
          (curves && (!finitePoint(c) || !(r > 0) || !Number.isFinite(r)))) return null;
      // The complete ring and the polyline fallback bound both writers' arc plots.
      const segments = curves ? [{box:diskBounds(c,r+half), touches:(at,d) =>
        Math.abs(Math.hypot(c[0]-at[0],c[1]-at[1])-r) <= half+d}] : [];
      for (const [i,p] of points.entries()) {
        const q = points[i-1] || p;
        segments.push({box:inflate(A.bounds([p,q]),half), touches:(at,d) => A.nearSegment(at,p,q) <= half+d});
      }
      return segments.length ? segments : null;
    }
    if (f.t === "region" || f.t === "pour") {
      // Preserve lands on a layer when the outline depends on writer-specific
      // arc reconstruction. A chord-only contact check could miss real copper.
      if (f.contour || f.arcs?.length) return null;
      const rings = f.t === "pour" ? f.rings : [f.points,...(f.holes || [])].map(p => p.flat());
      if (!rings?.length || rings.some(r => r.length < 6 || r.length%2 || !r.every(Number.isFinite))) return null;
      let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
      for (const ring of rings) for (let i=0;i<ring.length;i+=2) {
        x0=Math.min(x0,ring[i]); y0=Math.min(y0,ring[i+1]);
        x1=Math.max(x1,ring[i]); y1=Math.max(y1,ring[i+1]);
      }
      const grid = globalThis.AtriumDRCPours?.edgeGrid;
      if (!grid) return null;
      const box = [x0,y0,x1,y1];
      let edges;
      return [{box, touches:(at,d) => {
        // Scale the index for very large coordinates rather than allocating a
        // submillimetre grid over an arbitrarily long boundary segment.
        const index = edges ||= grid(rings,Math.max(1,(x1-x0)/256,(y1-y0)/256));
        if (index.inside(...at)) return true;
        let contact = false;
        index.query(diskBounds(at,d),(j,i) => {
          const ring = rings[j], n = (2*i+2)%ring.length;
          if (A.nearSegment(at,[ring[2*i],ring[2*i+1]],[ring[n],ring[n+1]]) <= d) contact = true;
        });
        return contact;
      }}];
    }
    return null;
  }
  function omitIsolatedLands(layers, stack, candidates, note) {
    const spatial = globalThis.AtriumSpatial;
    if (!spatial) {
      if (candidates.size) note("Inner-layer lands were retained because copper contact analysis is unavailable.");
      return;
    }
    let removed = 0;
    const unchecked = [];
    for (const layer of stack.slice(1,-1)) {
      const features = layers.get(layer);
      if (!features.some(f => candidates.has(f))) continue;
      const copper = features.map(copperObstacles);
      if (copper.some(f => !f || f.some(g => !g.box.every(Number.isFinite)))) { unchecked.push(layer); continue; }
      const index = spatial.create(copper.flat(),f => f.box);
      layers.set(layer,features.filter((f,i) => {
        if (!candidates.has(f)) return true;
        const d = f.pad.w/2+LAND_MARGIN;
        if (index.query(diskBounds(f.at,d)).some(g => g !== copper[i][0] && g.touches(f.at,d))) return true;
        removed++;
        return false;
      }));
    }
    if (removed) note("Omitted " + removed + " isolated inner-layer pad and via lands from the copper films.");
    if (unchecked.length) note("Inner-layer lands were retained on " + unchecked.map(PCB.name).join(", ") + " because copper contact could not be verified.");
  }

  // ---------------------------------------------------------------------------
  // Board analysis. Produces plot features per layer, drill hits and
  // component placement data. Independent of output units and expansions.
  const PLOT_ORDER = ["Top", "Bottom", "Silk", "Bottom silk", "Top mask", "Bottom mask", "Top paste", "Bottom paste"];
  function pourStatus(doc, defs, project) {
    const pours = doc.pcbDrawing?.pours;
    // The pour engine checks its own regions per polygon and imported ones by the board signature.
    if (globalThis.AtriumPolygonPour?.inspectCopper) return AtriumPolygonPour.inspectCopper(doc, defs, {project}).state;
    if (!pours?.length) return "none";
    if (!globalThis.AtriumPCBPours || pours.some(r => r.polygon != null)) return "unknown";
    return AtriumPCBPours.matchesSignature(doc, defs, project) ? "current" : "stale";
  }
  // The copper pours the outputs plot (polygon-pour.js outputCopper): the stored copper when it is
  // the exact fill for the board, else the exact fill made for these outputs (the document is not
  // changed). Never stale copper and never none in its place. Regions imported without an editable
  // pour (noneditable artwork) are plotted as stored and reported. defer: report the pours that need
  // the fill ("pending", no regions) instead of solving here (the dialog settles them in the editor).
  function copperFor(doc, defs, project, defer) {
    const P = globalThis.AtriumPolygonPour, stored = doc.pcbDrawing?.pours || [];
    // "stored": the poured copper the design holds, as the editor draws it (the 3D view). Never fills.
    if (defer === "stored") return {state: stored.length ? "current" : "none", regions: stored, filled: [], pending: [], imported: null};
    if (P?.outputCopper) return P.outputCopper(doc, defs, {project, solve: !defer});
    const imported = n => n ? {count: n, fresh: !!globalThis.AtriumPCBPours?.matchesSignature?.(doc, defs, project)} : null;
    const engine = stored.some(r => r.polygon != null) || (doc.items || []).some(i => i.kind === "polygon" && !i.shelved && !i.cutout);
    if (!stored.length && !engine) return {state: "none", regions: [], filled: [], pending: [], imported: null};
    if (!globalThis.AtriumPCBPours || engine)
      throw Error("The copper pours cannot be checked or filled because the pour engine (polygon-pour.js) is not loaded. No outputs were made.");
    return {state: stored.length ? "current" : "none", regions: stored, filled: [], pending: [], imported: imported(stored.filter(r => r.polygon == null).length)};
  }
  const pourName = (doc, id) => { const p = (doc.items || []).find(i => i.id === id); return p?.name || ((p?.net || "No Net") + " on " + (p?.layer || "?")); };
  // Which copper data the outputs use, for the readme and the dialog.
  function copperText(model) {
    const c = model.copper, n = model.pourRegions, out = [];
    if (!c) return [];
    if (c.state === "none") return ["Copper pours: none."];
    if (c.state === "pending") return ["Copper pours: waiting for the exact fill of " + c.pending.length + " pour" + (c.pending.length === 1 ? "" : "s") + "."];
    const engine = n - (c.imported?.count || 0);
    if (c.state === "filled") out.push("Copper pours: exact fill made for these outputs (" + engine + " region" + (engine === 1 ? "" : "s") + "); " + c.filled.length + " pour" + (c.filled.length === 1 ? " was" : "s were") + " out of date or not yet poured in the design file.");
    else if (engine > 0) out.push("Copper pours: the exact fill stored in the design (" + engine + " region" + (engine === 1 ? "" : "s") + "), current with the board.");
    if (c.imported) out.push("Imported copper: " + c.imported.count + " region" + (c.imported.count === 1 ? "" : "s") + " without an editable pour, plotted as stored in the imported design" +
      (c.imported.fresh ? " (the board is unchanged since import)." : " (the board has changed since import)."));
    return out;
  }
  // Physical copper stack, top to bottom. The stored layer stack lists every
  // copper layer, used or not; without one the stack is Top, Inner 1 to the
  // deepest inner layer used, and Bottom (AtriumStackup.derive).
  function copperStack(doc, defs, used) {
    const S = globalThis.AtriumStackup;
    if (S?.copperLayers) {
      try {
        const saved = S.stored(doc), resolved = saved || S.derive(doc, defs);
        const keys = resolved.layers.filter(S.isCopper).map(l => l.key);
        if (keys.length >= 2 && keys.every(copper)) return {keys, stored: !!saved, resolved};
      } catch { /* fall through to the derived stack */ }
    }
    const deepest = Math.max(0, ...[...used].map(l => /^Inner (\d+)$/.exec(l)).filter(Boolean).map(m => +m[1]));
    return {keys: ["Top", ...Array.from({length: deepest}, (_, i) => "Inner " + (i + 1)), "Bottom"], stored: false};
  }
  function drillPairsFor(doc, defs, stack) {
    const pairs = new Map();
    try {
      for (const pair of globalThis.AtriumStackup?.drillPairs?.(doc, defs, stack) || [])
        pairs.set(pair.from + "|" + pair.to, pair);
    } catch { pairs.clear(); }
    return pairs;
  }
  // Board parts marked do-not-populate, with the BOM's rules (item flags,
  // DNP/fitted parameters and comment marks, schematic mates) when loaded.
  function dnpParts(project, doc, parts, collect = globalThis.AtriumBOM?.collect) {
    const out = new Set();
    if (collect) {
      try {
        const c = collect(project, {source: "pcb", board: doc.id}), ids = new Set();
        for (const e of c.dnp || []) for (const x of e.instances || [e]) ids.add(x.id ?? x.item?.id);
        for (const p of parts) if (ids.has(p.item.id)) out.add(p.item);
        return out;
      } catch { out.clear(); }
    }
    for (const {item} of parts) {
      if (item.dnp === false) continue;
      if (item.dnp === true || item.doNotPopulate === true || item.populate === false || item.fitted === false) out.add(item);
    }
    return out;
  }
  // Altium special strings on board text (".ProjectTitle", "Revision .ProjectRev"): a ".Name"
  // token resolves from the project's parameters (the PrjPcb's [ParameterN], project.parameters),
  // ignoring case, as Altium plots it. Names without a parameter are plotted as written.
  const specialText=A.projectText;
  function boardFor(project, requested) {
    const doc = typeof requested === "string" ? project.documents.find(d => d.id === requested) : requested;
    if (doc?.kind !== "pcb") throw Error("Choose a PCB layout to generate fabrication outputs.");
    return doc;
  }
  const plotArc = (edge, end = edge.start + edge.sweep) =>
    ({kind:"arc", c:edge.center, r:edge.radius, start:edge.start, end, ccw:edge.sweep > 0});
  function trackPlot({ink: {centerline, width}, key, net}, item, precise) {
    const first = centerline[0], copperTrack = key.role === "track";
    const attrs = copperTrack ? {fn: "Conductor", net: net || ""} : {fn: undefined};
    if (first.kind === "arc") {
      // Gerber and ODB can fall back to the authored samples if the arc collapses at their output precision.
      return {t: "stroke", points: item.points, arc: plotArc(first), width, ...attrs};
    }
    const points = [], source = copperTrack && precise?.points;
    let previous;
    for (let index = 0; index <= centerline.length; index++) {
      let point = index ? centerline[index - 1].b : first.a;
      // Provenance restores an exact source ordinate only while the native point still matches its proof.
      if (source?.[index] && sameXY(point, item.points[index])) point = source[index];
      if (!previous || !sameXY(point, previous)) points.push(point);
      previous = point;
    }
    return {t: "stroke", points, width, ...attrs};
  }
  function regionPlot({outer, holes}, placement, signed = false) {
    const S = globalThis.AtriumBoardShape, C = globalThis.AtriumGeometryCurves;
    const path = loop => loop.map(edge => {
      const placed = C.placeEdge(edge, placement);
      return placed.kind === "arc" ? plotArc(placed, signed ? undefined : C.arcEndAngle(placed)) : placed;
    });
    const contour = path(outer), holeContours = holes.map(path);
    const exact = signed || [contour, ...holeContours].some(loop => loop.some(edge => edge.kind === "arc"));
    return {t:"region", points:S.flattenContour(contour), holes:holeContours.map(loop => S.flattenContour(loop)),
      ...(exact ? {contour, holeContours} : {})};
  }
  function* outlineStrokes({centerline, width}, placement, preservePhase = false) {
    // Round pens join adjacent native line and arc operations on the contour.
    const C = AtriumGeometryCurves;
    for (const edge of centerline) {
      const placed = C.placeEdge(edge, placement);
      if (placed.kind === "arc") {
        const arc = plotArc(placed, preservePhase ? C.arcEndAngle(placed) : undefined);
        yield {t:"stroke", arc, points:[A.arcPoint(arc, arc.start), A.arcPoint(arc, arc.end)], width};
      } else yield {t:"stroke", points:[placed.a, placed.b], width};
    }
  }
  function* graphicPlot(feature, item) {
    const {ink, polarity} = feature;
    if (ink.kind === "stroke") {
      if (ink.centerline.length === 1 && ink.centerline[0].sweep === 360) {
        const {center: c, radius: r} = ink.centerline[0];
        yield {t:"circle", c, r, width:ink.width, polarity};
      } else if (ink.centerline.length > 1 && ink.centerline.some(edge => edge.kind === "arc")) {
        for (const stroke of outlineStrokes(ink)) yield {...stroke, polarity};
      } else yield {...trackPlot(feature, item), polarity};
    } else if (ink.kind === "region") {
      for (const island of ink.islands) yield {...regionPlot(island, null, true), polarity};
    }
  }
  const outputCopper = (project, doc, defs, options) =>
    copperFor(doc, defs, project, options?.pourFill === "stored" ? "stored" : options?.pourFill === "defer");
  function admitCopper(doc, defs, cu) {
    // Copper layers referenced by the design (checked against the stack below).
    const names = new Set(["Top", "Bottom"]);
    const refs = new Map(), mark = o => { for (const l of [o?.layer, o?.fromLayer, o?.toLayer]) if (copper(l)) { names.add(l); refs.set(l, (refs.get(l) || 0) + 1); } };
    const seen = new Set();
    for (const i of doc.items) {
      mark(i);
      if (i.kind === "part" && !seen.has(i.def)) { seen.add(i.def); const fp = PCB.readDefinition(defs,i.def,doc)?.footprint; fp?.pads?.forEach(mark); fp?.shapes?.forEach(mark); }
    }
    const pours = cu.state === "pending" ? "pending" : cu.regions.length ? "current" : "none";
    if (pours === "current") for (const r of cu.regions) mark(r);
    const physical = copperStack(doc, defs, names), stack = physical.keys;
    const missing = [...names].filter(l => !stack.includes(l));
    return {physical, stack, pours, missing, layerIssues:missing.map(l => ({kind:"layer", layer:l, count:refs.get(l) || 0, action:"omitted"}))};
  }
  function enforceLayers(layerIssues) {
    if (layerIssues.length) {
      throw Error("The layer stack does not allow " + layerIssues.map(i => i.kind === "layer" ? i.count + " object" + (i.count === 1 ? "" : "s") + " on " + PCB.name(i.layer)
        : i.count + " hole" + (i.count === 1 ? "" : "s") + " from " + PCB.name(i.from) + " to " + PCB.name(i.to)).join(", ") + ".");
    }
  }
  function stepArtwork(project, requested, options) {
    const policy = settle(options), source = globalThis.AtriumVariants?.forOutput(project, options?.variant) || project;
    const doc = boardFor(source, source === project ? requested : requested.id);
    const defs = new Map(source.library.map(d => [d.id, d]));
    const copper = outputCopper(source, doc, defs, options);
    if (options?.strictLayers) enforceLayers(admitCopper(doc, defs, copper).layerIssues);
    const filled = new Set(copper.filled);
    const board = filled.size ? {...doc, items:doc.items.filter(item => !filled.has(item.sourcePour))} : doc;
    const exact = source.documents.includes(board) ? source :
      {...source, documents:[...source.documents.filter(d => d.id !== board.id), board]};
    return {view:globalThis.AtriumGeometryReceipts.outputSnapshot(exact, board, policy, copper.regions || []), copper};
  }
  function analyse(project, requested, options) {
    // Assembly variants: the active variant, or options.variant (id or name; null or "" for the base
    // design). Not-fitted parts leave the pick and place file and are crossed out on assembly drawings.
    if (globalThis.AtriumVariants) {
      const v = AtriumVariants.forOutput(project, options?.variant);
      if (v !== project) { project = v; if (requested && typeof requested === "object") requested = requested.id; }
    }
    const doc = boardFor(project, requested), defs = new Map(project.library.map(d => [d.id, d]));
    const film = options?.provenance && globalThis.AtriumTranslatorPrecision?.forExport(project, options.provenance, "gerber");
    const retainedDrill = doc.sourceDrillDrawing && options?.provenance && globalThis.AtriumTranslatorProvenance?.drillDrawing(options.provenance,doc.id);
    const notes = new Map(), note = (m, n = 1) => notes.set(m, (notes.get(m) || 0) + n);
    const cu = outputCopper(project, doc, defs, options);
    const {physical, stack, pours, missing, layerIssues} = admitCopper(doc, defs, cu);
    const material = globalThis.AtriumGeometryMaterial, stackIndex = new Map(stack.map((l, i) => [l, i]));
    let boreCopper;
    let pairInfo;
    const getDrillPairs = () => pairInfo ??= drillPairsFor(doc, defs, physical.resolved);
    if (missing.length) note("Objects on copper layers missing from the layer stack (" + missing.sort((a, b) => PCB.index(a) - PCB.index(b)).join(", ") + ") were omitted. Check the layer stack.");
    const layers = new Map(stack.map(l => [l, []]));
    for (const l of PLOT_ORDER) if (!layers.has(l)) layers.set(l, []);
    const isMechanicalFilm = l => /^Mechanical \d+$/.test(l || "") && +l.slice(11) >= 2;
    for (const i of doc.items) if (isMechanicalFilm(i.layer) && !layers.has(i.layer)) layers.set(i.layer, []);
    const optInMechanical = new Set();
    const append = (layer, f) => { const list = layers.get(layer); if (list) { list.push(f); return true; } return false; };
    const drills = [], parts = [], outline = [];
    // Optional attribution during translation. Normal analysis retains the original append path.
    const trace = options?.featureSource;
    let owner, member;
    const add = trace ? (layer, feature) => {
      const added = append(layer, feature);
      if (added) trace(feature, owner, member, layer);
      return added;
    } : append;
    const addDrill = trace ? hit => { drills.push(hit); trace(hit, owner, member, "drill"); } : hit => drills.push(hit);
    let placedDrillTable = false;
    if (doc.sourceDrillDrawing) layers.set("Drill drawing", []);

    function drawingTool(o,parent) {
      if (!doc.sourceDrillDrawing) return;
      const tool=retainedDrill ? retainedDrill.tool(o,parent) : o.sourceDrillTool;
      if (Number.isInteger(tool)) return {sourceDrillTool:tool,slotLength:o.slotLength ?? 0};
    }
    function span(o) {
      const keys = material.spanOf(o, stack);
      if (keys) return keys.map(k => stackIndex.get(k));
      note("Drilled objects with an unresolved layer span were treated as through holes.");
      return [0, stack.length - 1];
    }
    function drillOperations(pad, parent, span, meta) {
      if (options?.collectDrills === false || !(pad.drill > 0)) return;
      boreCopper ??= material.datum(doc, defs).copper;
      let laser;
      material.visitPad(pad, parent, stack, boreCopper, [], null, (_, bore, operation) => {
        const {at,endpoints,via} = operation, d = bore.cutter.diameter;
        if (bore.operation === "primary") {
          laser = operation.laser;
          addDrill({at,d,...(endpoints && {endpoints}),plated:bore.plated,span,via,...(via && {laser}),...meta,...drawingTool(pad,parent)});
          return;
        }
        const a = stackIndex.get(bore.from), b = stackIndex.get(bore.to);
        if (a != null && b != null) addDrill({at,d,plated:bore.plated,span:[a,b],via:true,
          backdrill:operation.side,stop:operation.stop,stub:operation.stub});
        else note("Back-drills that reach layers without copper were omitted. Check the layer stack.");
        note("Back-drilled vias are listed in separate -BackDrill files with their stop layer and maximum stub.");
      }, () => {});
      return laser;
    }
    const spanLayers = s => stack.slice(s[0], s[1] + 1);
    // Footprint shapes (frame = part) and board graphics (frame = null).
    function authoredGraphic(layer, s, frame, fallbackWidth) {
      if (layer === "Drill drawing" && /^\.(?:legend|drilltable)$/i.test(String(s.text || "").trim())) { placedDrillTable = true; return; }
      if (s.keepout === true || s.cutout) return;  // keepouts and polygon cutouts never add film artwork
      // Expansion openings are independently positive operations on mask and paste.
      const C = AtriumGeometryCurves, placement = frame && C.artworkFrame(frame);
      for (const opening of PCB.traceOpenings(s,layer))
        graphic(opening.layer,opening,frame,fallbackWidth,placement,false);
      graphic(layer,s,frame,fallbackWidth,placement,frame && C.artworkPolarity(s) === "clear");
    }
    function graphic(layer, s, frame, fallbackWidth, placement, clear) {
      if (!layers.has(layer)) {
        if (!isMechanicalFilm(layer)) return;
        layers.set(layer, []);
        // Artwork on a new footprint-only layer is available by explicit selection.
        optInMechanical.add(layer);
      }
      const cu = copper(layer), fn = cu ? (s.net ? "Conductor" : "NonConductor") : undefined, net = cu && s.net ? {net: s.net} : null;
      if (s.kind === "text" || s.kind === "label") {
        const ink = AtriumPCBText.physicalInk(s, doc, project, {frame,layer});
        if (ink.unsupported) note("Characters missing from the stroke font were plotted as \"?\".", ink.unsupported);
        if (ink.fallback) note(ink.fallback);
        for (const st of ink.strokes) add(layer, {t:"stroke",points:st.points,width:st.width,fn});
        for (const {outer,holes} of ink.polygons)
          add(layer, holes.length ? {t:"region",points:outer,holes,fn} : {t:"region",points:outer,fn});
        return;
      }
      const attributes = clear ? {polarity:"clear"} : {fn, ...net};
      const C = AtriumGeometryCurves;
      const place = placement ? placement.at : point => point;
      const width = s.width > 0 ? s.width : fallbackWidth;
      C.artworkInk(s, width, (ink, kind, analytic) => {
        if (kind === "disk") {
          const {center, radius} = ink.islands[0].outer[0], d = 2 * radius;
          add(layer, {t:"flash", at:place(center), pad:padGeom("circle",d,d,0), ...attributes});
        } else if (kind === "ring") {
          const {center, radius} = ink.centerline[0];
          add(layer, {t:"circle", c:place(center), r:radius, width:ink.width, ...attributes});
        } else if (kind === "arc") {
          const placed = C.placeEdge(ink.centerline[0], placement);
          const arc = plotArc(placed, C.arcEndAngle(placed));
          add(layer, {t:"stroke", points:s.points.map(place), arc, width:ink.width, ...attributes});
        } else if (kind === "region") {
          const island = ink.islands[0];
          const region = analytic ? regionPlot(island, placement) : {t:"region", points:island.outer.map(edge => edge.a)};
          add(layer, {...region, ...attributes});
        } else if (kind === "outline" && analytic) {
          for (const stroke of outlineStrokes(ink, placement, true)) add(layer, {...stroke, ...attributes});
        } else if (ink.kind === "stroke") {
          const edges = ink.centerline, first = edges[0];
          const points = edges.length === 1 && first.a === first.b ? [first.a] : [first.a, ...edges.map(edge => edge.b)];
          add(layer, {t:"stroke", points, width:ink.width, ...attributes});
        }
      }, shape => {
        let points = shape.points.map(place).filter((p, i, a) => !i || !sameXY(p, a[i - 1]));
        if (!points.length) return null;
        const loop = points.length > 2 && sameXY(points[0], points.at(-1));
        if (loop) points = points.slice(0, -1);
        if (shape.width === 0 && !shape.fill) note("Zero-width lines were plotted at the default width.");
        return {...shape, points, closed:shape.closed || loop};
      });
    }
    // Via stacks (viastack.js): per-layer lands, tenting and IPC-4761 mask
    // rules, microvia (laser) and back-drill spans. Plain vias are unchanged.
    // Per-pad mask and paste expansion from the design rules (as DRC and
    // designator placement read them); the dialog values are the fallback
    // or, with "override", replace the rules.
    let maskRules = null, pasteRule = null;
    try {
      ({mask:maskRules,paste:pasteRule}=M.rulesForView(doc,project));
    } catch { maskRules = pasteRule = null; note("Design rules could not be read. Mask and paste use the dialog expansions."); }
    const VS = globalThis.AtriumViaStack, bigLands = [];
    const optionalLands = options?.omitUnconnectedMidLayerPads === true && stack.length > 2 ? new Set() : null;
    const isPlainThrough = (p, sp) => sp[0] === 0 && sp[1] === stack.length-1 &&
      ((!p.fromLayer && !p.toLayer) || p.fromLayer === "Top" && p.toLayer === "Bottom" ||
        p.fromLayer === "Bottom" && p.toLayer === "Top") &&
      (!p.stackMode || p.stackMode === "simple") && !p.padStack && !p.backdrill && !p.microvia && !p.slotLength;
    function landOn(l,f,d,plain) {
      if (add(l,f) && plain && l !== "Top" && l !== "Bottom" && f.pad.shape === "circle" && f.pad.w > d && finitePoint(f.at))
        optionalLands.add(f);
    }
    // Split-plane artwork includes direct connections and thermal lands. Other
    // drilled objects appear as antipads. A separate flash would fill each void.
    const planeLayers = new Set(doc.items.filter(i => i.kind === "polygon" && i.powerPlane).map(i => i.layer));
    const pinNames = new Map();
    function pinNameOf(defId, number) {
      if (!pinNames.has(defId)) pinNames.set(defId, new Map((defs.get(defId)?.symbol?.pins || []).map(q => [String(q.number), String(q.name ?? "")])));
      const name = pinNames.get(defId).get(number) || "";
      return name && name !== number ? name : "";
    }
    function via(v, at, parent) {
      const D = v.diameter || v.w, d = v.drill || 0;
      if (!(D > 0)) { note("Vias without a diameter were omitted."); return; }
      const sp = span(v);
      const plain = optionalLands && d > 0 && isPlainThrough(v,sp) && (!v.ipc4761 || v.ipc4761 === "none");
      for (const l of spanLayers(sp)) {
        const land = VS.padOn(v, l);
        if (land.diameter > 0 && !planeLayers.has(l)) {
          const shape = padShape(land.shape,land.diameter,land.diameter);
          landOn(l,{t:"flash",at,pad:padGeom(shape || "circle",land.diameter,land.diameter,0),fn:"ViaPad",net:v.net || "",use:"via"},d,plain && !!shape);
        }
        if (!planeLayers.has(l) && (land.diameter > D + 1e-6 || land.diameter > 0 && land.shape !== "round")) bigLands.push({v, parent, at, layer: l, land});
      }
      const maskSpan = sp.map(i => stack[i]);
      for (const {mask,land} of M.maskSeeds(v,parent,M.FACES,maskRules,maskSpan))
        add(mask.face + " mask", {t: "flash", at, pad:land, mask, ruleDefault:maskRules?.defaultExpansion});
      const ipc = v.ipc4761 && v.ipc4761 !== "none" ? VS.ipcCode(v) : undefined;
      if (!(d > 0)) note("Vias without a drill size have no drill hit.");
      const laser = drillOperations(v,parent,sp,{ipc,net:v.net || ""});
      if (laser) note("Microvias are listed in separate laser-drill (-Microvia) files.");
      else if (sp[0] !== 0 || sp[1] !== stack.length - 1) note("Blind or buried vias are drilled from separate layer-pair files.");
      if (ipc && /^(III|IV|V|VI|VII)/.test(ipc)) note("Plugged or filled vias (IPC-4761) are tagged with their type in the drill files.");
    }
    function pad(p, parent) {
      const at = PCB.padCenter(p,parent);
      if (p.kind === "via") { via(p, at, parent); return; }
      const w = p.w, h = p.h, d = p.drill || 0;
      if (!(w > 0 && h > 0) && !(d > 0)) { note("Pads without a size were omitted."); return; }
      if (w > 0 && h > 0 && !padShape(p.shape, w, h)) note("Pads with an unsupported shape were plotted as rectangles.");
      const nominal = L.geometry(p);
      const layer = PCB.padLayer(parent,p), net = PCB.padNet(p,parent);
      const npth = d > 0 && !PCB.padPlated(p,parent,layer);
      const sp = layer === "Multi" ? span(p) : null;
      const cu = sp ? spanLayers(sp) : copper(layer) ? (stackIndex.has(layer) ? [layer] : []) : [];
      const plain = optionalLands && d > 0 && !npth && sp && isPlainThrough(p,sp);
      const meta = {net: net || "", ref: parent?.ref, pin: p.number != null ? String(p.number) : undefined, use: "pad"};
      // Pin function for the X2 .P attribute: the schematic pin name when it says more than the number.
      const pinName = parent && meta.pin != null ? pinNameOf(parent.def, meta.pin) : "";
      if (pinName) meta.pinName = pinName;
      // A land no larger than its hole is drilled away. It is plotted only when the source tool
      // plots it (pad.plotLand: Altium imports), so the copper films match that tool's.
      for (const l of cu) {
        if (d > 0 && planeLayers.has(l)) continue;
        const land=AtriumLandContours.film(p,l,stack);
        if (land)
          landOn(l,{t:"flash",at:L.place(land,parent).at,pad:M.placedProfile(land,parent),fn:d>0?"ComponentPad":"SMDPad,CuDef",...meta},d,plain);
      }
      // Pads explicitly drawn on artwork films are flashes on that film.
      if (nominal && !d && ["Silk","Bottom silk","Top mask","Bottom mask","Top paste","Bottom paste"].includes(layer))
        add(layer,{t:"flash",at,pad:M.placedProfile(nominal,parent)});
      for (const {mask,land} of M.maskSeeds(p,parent,M.padFaces(layer,d,copper(layer)),maskRules)) {
        if (!land.min && !(d > 0)) continue;
        add(mask.face + " mask", {t: "flash", at:L.place(land,parent).at, pad:M.placedProfile(land,parent), mask, ruleDefault:maskRules?.defaultExpansion});
      }
      for(const paste of M.paste(p,parent,layer,L.geometry(p,layer,stack),pasteRule))
        add(layer + " paste",{t:"flash",...paste});
      if (d > 0) {
        if (d > Math.min(w, h) + 1e-6) note("Pads whose drill exceeds the pad size were drilled at the hole size.");
        drillOperations(p,parent,npth || !sp ? [0,stack.length - 1] : sp,meta);
      }
    }

    // Board outline.
    if (Array.isArray(doc.outline) && doc.outline.length >= 3) {
      let pts = doc.outline.filter((p, i, a) => !i || !sameXY(p, a[i - 1]));
      if (pts.length > 2 && sameXY(pts[0], pts.at(-1))) pts = pts.slice(0, -1);
      if (pts.length >= 3) outline.push(...pts);
      if (A.validOutline && !A.validOutline(pts)) note("The board outline is degenerate. Check the profile before fabrication.");
    }
    if (!outline.length) note("The board has no closed outline. Profile layers (GM1/GKO) are empty and the origin uses the design extents.");
    // Exact profile (arcs and cutouts) when the stored board shape matches the outline.
    const boardShape = outline.length && globalThis.AtriumBoardShape ? AtriumBoardShape.fresh(doc) : null;

    const replacedTracks = new Set(cu.filled);
    let geometry;
    const physicalFeatures = item => {
      if (!geometry) {
        const R = globalThis.AtriumResolvedGeometry || require("../pcb/resolved-geometry.js");
        const revision = {projectId: project.id, rootId: doc.id, kind: "snapshot", generation: "fabrication"};
        const source = project.documents.includes(doc) ? project : {...project, documents: [...project.documents.filter(d => d.id !== doc.id), doc]};
        geometry = R.read({kind: "snapshot", project: source, root: doc, revision});
      }
      return globalThis.AtriumGeometryReceipts.itemArtwork(geometry, item, doc.id);
    };
    for (const i of doc.items) {
      if (trace) { owner = i; member = null; }
      if (i.sourcePour != null && replacedTracks.has(i.sourcePour)) continue;
      if (i.kind === "part") {
        const def = PCB.readDefinition(defs,i.def,doc), fp = def?.footprint;
        if (!fp) { note("Components without a footprint were omitted."); continue; }
        const side = i.layer === "Bottom" ? "Bottom" : "Top";
        for (const s of fp.shapes || []) { if (trace) member = s; authoredGraphic(PCB.shapeLayer(i, s), s, i, .15); }
        for (const p of fp.pads || []) { if (trace) member = p; pad(p, i); }
        if (trace) member = null;
        for(const {text} of PCB.partText(doc,i,def,film?.item(doc,i)||i))
          authoredGraphic(text.layer,text,null,0);
        parts.push({item: i, def, fp, side});
      } else if (i.kind === "pad" || i.kind === "via") {
        if (i.kind === "via") via(i, [i.x, i.y]); else pad({...i, angle: i.angle || 0}, null);
      } else if (i.kind === "track") {
        if (!copper(i.layer)) { authoredGraphic(i.layer || "Top", {...i, kind: "path", fill: false}, null, .18); continue; }
        const {features, ambiguous} = physicalFeatures(i);
        if (!features.length) { note("Tracks with zero width were omitted."); continue; }
        const precise = !ambiguous && film?.item(doc, i);
        for (const feature of features) add(feature.key.layer, trackPlot(feature, i, precise));
      } else if (i.kind === "graphic") {
        if (i.keepout === true || i.cutout || /^keep-?out/i.test(i.layer || "")) continue;
        if (i.dimension) {
          if (i.dimension.export === false) continue;
          if (!layers.has(i.layer)) { note("Dimensions on " + PCB.name(i.layer) + " have no Gerber layer and were not plotted. Use Mechanical 2 or later, or an overlay."); continue; }
          if (globalThis.AtriumPCBDraw) for (const g of AtriumPCBDraw.dimensionPrimitives(i, {units: project.units})) authoredGraphic(g.layer, {...g, kind: "path"}, null, .18);
          continue;
        }
        if (AtriumGeometryCurves.artworkPolarity(i) === "clear") {
          for (const feature of physicalFeatures(i).features) for (const plotted of graphicPlot(feature, i)) add(feature.key.layer, plotted);
        } else authoredGraphic(i.layer || "Top", {...i, kind: "path"}, null, .18);
      } else if (i.kind === "label") {
        const plotted = film?.item(doc, i) || i;
        authoredGraphic(i.layer || "Silk", {...plotted, kind: "label", size: i.size || .75}, null, 0);
      }
    }
    const dnp = dnpParts(project, doc, parts, options?.collectBOM);
    if (dnp.size) note("Do-not-populate components are left out of the pick and place file: " + parts.filter(x => dnp.has(x.item)).map(x => x.item.ref || "?")
      .sort((a, b) => a.localeCompare(b, "en", {numeric: true})).join(", ") + ".");
    if (pours === "current" && bigLands.length && globalThis.AtriumPolygonPour?.protectStoredLands) {
      const safe = AtriumPolygonPour.protectStoredLands(doc, cu.regions, bigLands, {project, defs});
      if (safe !== cu.regions) {
        cu.regions = safe;
        note("Stored artwork was cleared around overlapping via-stack lands. Check the affected pour before fabrication.");
      }
    }
    // Pours: the exact fill (copperFor), largest first.
    let pourRegions = 0;
    if (pours === "current") {
      const ordered = cu.regions.filter(r => stackIndex.has(r.layer))
        .map(r => ({r, area: (r.bounds[2] - r.bounds[0]) * (r.bounds[3] - r.bounds[1])})).sort((a, b) => b.area - a.area);
      for (const {r} of ordered) {
        if (trace) { owner = r; member = null; }
        // arcs: polygon-pour.js true-arc runs [ring, first vertex, last vertex, cx, cy, ...].
        try { add(r.layer, {t: "pour", rings: AtriumPCBPours.contours(r), arcs: Array.isArray(r.arcs) && r.arcs.length ? r.arcs : null, fn: "Conductor", net: r.net || ""}); pourRegions++; }
        catch { throw Error("A copper pour region could not be decoded, so no outputs were made. Repour All and try again."); }
      }
    }

    if (optionalLands?.size && cu.state !== "pending") {
      if (doc.stackup?.substacks?.length) note("Inner-layer lands were retained because local layer spans can differ across a rigid-flex board.");
      else omitIsolatedLands(layers,stack,optionalLands,note);
    }
    if (trace) { owner = null; member = null; }
    if (cu.state === "pending") note("Copper pours are being filled. Outputs are made once the exact fill is ready.");
    if (cu.state === "filled") {
      const never = new Set(cu.unpoured || []), names = ids => ids.map(id => pourName(doc, id)).join(", "), old = cu.filled.filter(id => !never.has(id));
      if (old.length) note("Copper pours out of date in the design were filled again for these outputs: " + names(old) + ". The design file still holds the older copper; Repour All and save to update it.");
      if (never.size) note("Copper pours never poured in the design were filled for these outputs: " + names([...never]) + ". Repour All and save to store their copper in the design.");
    }
    if (cu.imported && !cu.imported.fresh) note(cu.imported.count + " imported copper region" + (cu.imported.count === 1 ? "" : "s") + " without an editable pour " + (cu.imported.count === 1 ? "is" : "are") +
      " plotted as stored in the imported design, but the board has changed since import. Check their clearances with DRC, or replace them with polygon pours.");
    // Plated spans that are not a drill pair of a stored layer stack (Altium's
    // Layer Stack Manager › Drill Pairs): written to their own file, but flagged.
    const S = globalThis.AtriumStackup;
    if (physical.stored && S?.drillPairs) {
      const off = new Map();
      for (const h of drills) {
        if (!h.plated || h.backdrill || (h.span[0] === 0 && h.span[1] === stack.length - 1)) continue;
        const k = stack[h.span[0]] + "|" + stack[h.span[1]];
        if (!getDrillPairs().get(k)?.defined) off.set(k, (off.get(k) || 0) + 1);
      }
      for (const [k, n] of off) {
        const [from, to] = k.split("|");
        layerIssues.push({kind: "drillPair", from, to, count: n, action: "flagged"});
        note("Holes from " + PCB.name(from) + " to " + PCB.name(to) + " are not on a drill pair of the layer stack (Layer Stack Manager > Drill Pairs). They have their own drill file; define the pair or change the vias.", n);
      }
    }
    if (options?.strictLayers) enforceLayers(layerIssues);
    const extents = outline.length ? A.bounds(outline) : A.docBounds(doc, defs);
    // Rigid-flex (rigid-flex.js): coverlay and stiffener layers and the region drawing.
    let flex = null;
    try { flex = globalThis.AtriumRigidFlex?.fabLayers?.(doc, defs) || null; } catch (e) { note("Rigid-flex layers were omitted: " + e.message); }
    if (flex) for (const L of flex.layers) {
      const features = [...L.features];
      for (const lb of L.labels || []) for (const pts of strokeText(lb.text, lb.at, lb.angle, lb.size, "center").strokes) features.push({t: "stroke", points: pts, width: lb.size * .12, fn: null});
      layers.set(L.key, features);
    }
    // HDI and via construction notes (viastack.js): [] for boards with through vias only.
    let hdi = [];
    try { hdi = globalThis.AtriumViaStack?.hdi?.notes?.(doc, defs) || []; } catch (e) { note("HDI construction notes were omitted: " + e.message); }
    // Poured copper against the Clearance rules (drc-pours.js), on the fill these outputs plot: outputs never
    // leave with a fill DRC has not seen. The Clearance check does not read poured copper, and the pour engine
    // trusts the polygon's own clearance, so this is the only check of what the fab will etch.
    let pourClearance = null;
    if (pours === "current" && options?.pourCheck !== false && globalThis.AtriumDRCPours && globalThis.AtriumRules) {
      try {
        pourClearance = AtriumDRCPours.verify(doc, defs, null, {project, regions: cu.regions}).violations;
        if (pourClearance.length) note("Poured copper is closer to other copper than the Clearance rules allow (" + pourClearance.length + " place" + (pourClearance.length === 1 ? "" : "s") + ", first: " +
          pourClearance[0].title + ", " + (Math.round(pourClearance[0].actual * 1e4) / 1e4) + " mm where " + pourClearance[0].required + " mm is required). Fix the pour's clearance or the copper, repour and check again.");
      } catch (e) { note("Poured copper could not be checked against the Clearance rules: " + e.message); }
    }
    return prepareDrills({doc, defs, project, stack, stackStored: physical.stored, physicalStack:physical.resolved, getDrillPairs,
      expansionRules: !!maskRules, dnp, layers, optInMechanical, drills, placedDrillTable, ...(retainedDrill && {sourceDrillSize:retainedDrill.size}), parts, outline, boardShape, extents, pours, copper: cu, pourRegions, notes, flex, layerIssues, hdi, pourClearance});
  }

  // ---------------------------------------------------------------------------
  // Output layer catalogue (Altium extensions and X2 file functions).
  // TF.FileFunction (Gerber Layer Format Specification revision 2024.05,
  // §5.6.3) comes from AtriumStackup.layerInfo, the layer stack's own view of
  // each layer. Copper L numbers are physical positions in the master stack,
  // top = L1, so rigid-flex substacks that share master copper keep the
  // master numbering. Fixed values are the fallback without stackup.js.
  const layerInfoOf = (model, key) => { try { return globalThis.AtriumStackup?.layerInfo?.(model.doc, key, model.defs, model.physicalStack) || null; } catch { return null; } };
  function gerberLayers(model) {
    const list = [];
    model.stack.forEach((l, i) => {
      const ext = l === "Top" ? "GTL" : l === "Bottom" ? "GBL" : "G" + PCB.index(l);
      const pos = l === "Top" ? "Top" : l === "Bottom" ? "Bot" : "Inr";
      // Physical layer number. A stored stack adds the Plane/Signal type; a
      // derived stack does not know it, so the optional field is left out.
      let fileFunction = "Copper,L" + (i + 1) + "," + pos;
      if (model.stackStored) {
        const info = layerInfoOf(model, l);
        if (info?.copper && info.number === i + 1 && info.fileFunction.startsWith(fileFunction + ",")) fileFunction = info.fileFunction;
      }
      list.push({key: l, ext, title: PCB.name(l), group: "Copper", fileFunction, polarity: "Positive"});
    });
    list.push({key: "Silk", ext: "GTO", title: "Top Overlay", group: "Overlay", fileFunction: "Legend,Top", polarity: "Positive"},
      {key: "Bottom silk", ext: "GBO", title: "Bottom Overlay", group: "Overlay", fileFunction: "Legend,Bot", polarity: "Positive"},
      {key: "Top mask", ext: "GTS", title: "Top Solder", group: "Solder mask", fileFunction: "Soldermask,Top", polarity: "Negative"},
      {key: "Bottom mask", ext: "GBS", title: "Bottom Solder", group: "Solder mask", fileFunction: "Soldermask,Bot", polarity: "Negative"},
      {key: "Top paste", ext: "GTP", title: "Top Paste", group: "Paste", fileFunction: "Paste,Top", polarity: "Positive"},
      {key: "Bottom paste", ext: "GBP", title: "Bottom Paste", group: "Paste", fileFunction: "Paste,Bot", polarity: "Positive"},
      {key: "outline", ext: "GM1", title: "Mechanical 1 (board outline)", group: "Profile", fileFunction: "Profile,NP", polarity: "Positive"},
      {key: "outline", ext: "GKO", title: "Keep-Out (board outline)", group: "Profile", fileFunction: "Profile,NP", polarity: "Positive"});
    // Gerber spec 2026.05 §5.6.3 has no coverlay or stiffener file function,
    // so both use Other,<description> (e.g. Other,CoverlayTop).
    const x2 = f => /^Coverlay,(Top|Bot)$/.test(f) ? "Other,Coverlay" + f.slice(9) : f;
    for (const L of list) {
      if (L.group === "Copper" || L.key === "outline") continue;
      const info = layerInfoOf(model, L.key);
      if (info?.fileFunction && /^(Legend|Soldermask|Paste),(Top|Bot)$/.test(info.fileFunction)) { L.fileFunction = info.fileFunction; L.polarity = info.filePolarity || L.polarity; }
    }
    for (const L of model.extraLayers || []) list.push({...L});
    for (const k of model.layers.keys()) if (/^Mechanical \d+$/.test(k)) list.push({key: k, ext: "GM" + k.slice(11), title: k, group: "Mechanical",
      fileFunction: "Other,Mechanical" + k.slice(11), polarity: "Positive", optIn: model.optInMechanical?.has(k)});
    for (const L of model.flex?.layers || []) list.push({key: L.key, ext: L.ext, title: L.title, group: L.group, fileFunction: x2(L.fileFunction), polarity: L.polarity});
    for (const l of list) l.count = l.key === "outline" ? (model.outline.length ? 1 : 0) : model.layers.get(l.key)?.length || 0;
    return list;
  }
  const defaults = () => ({
    units: "mm", format: "4:6", origin: "auto",
    layers: {GKO: false}, profileWidth: DEFAULT_PROFILE_WIDTH,
    ...M.DEFAULTS,
    drillUnits: "mm", drillFormat: "decimal", drillOrigin: "shared", drillDrawing: true, drillReport: true,
    pnp: true, pnpUnits: "mm", pnpStyle: "altium", assemblyTop: true, assemblyBottom: true, readme: true
  });
  // Gerber spec 2026.05 §4.2.2: six decimal digits. The first entry of each
  // list is the default; the lower resolutions are kept for legacy CAM only.
  const GERBER_FORMATS = {mm: ["4:6", "3:6", "4:4", "4:3"], in: ["2:6", "3:6", "2:5", "2:4"]};
  const LEGACY_FORMATS = new Set(["4:4", "4:3", "2:5", "2:4"]);
  const DRILL_FORMATS = {mm: ["decimal", "3:3", "4:3"], in: ["decimal", "2:4", "2:5"]};
  const ORIGINS = ["auto", "user", "outline", "absolute"];
  const gerberScale = units => units === "mm" ? 1 : 1 / 25.4;
  function settle(options) {
    const o = {...defaults(), ...(options || {})};
    o.layers = {...defaults().layers, ...(options?.layers || {})};
    if (!GERBER_FORMATS[o.units]) throw Error("Gerber units must be mm or in.");
    if (!GERBER_FORMATS[o.units].includes(o.format)) o.format = GERBER_FORMATS[o.units][0];
    if (!Number.isFinite(o.profileWidth) || o.profileWidth <= 0) throw Error("Enter a positive profile stroke width in mm.");
    const profileDiameter = trim(o.profileWidth * gerberScale(o.units));
    if (profileDiameter === "0" || profileDiameter.includes("e")) throw Error("The profile stroke width cannot be written in the selected Gerber units.");
    if (!DRILL_FORMATS[o.drillUnits]) throw Error("Drill units must be mm or in.");
    if (!DRILL_FORMATS[o.drillUnits].includes(o.drillFormat)) o.drillFormat = "decimal";
    for (const k of ["maskExpansion", "pasteExpansion"]) {
      if (typeof o[k] !== "number" || !Number.isFinite(o[k]) || Math.abs(o[k]) > 2) throw Error("Expansions must be between -2 and 2 mm.");
    }
    if (!ORIGINS.includes(o.origin)) o.origin = "auto";
    if (o.drillOrigin == null || o.drillOrigin === "") o.drillOrigin = "shared";
    if (o.drillOrigin !== "shared" && !ORIGINS.includes(o.drillOrigin)) throw Error("Choose a valid NC drill origin.");
    if (!["altium", "jlc"].includes(o.pnpStyle)) o.pnpStyle = "altium";
    o.date = o.date instanceof Date ? o.date : new Date();
    return o;
  }
  // "auto" is the board origin (doc.origin, Altium Edit > Origin) when the
  // board has one, else the lower-left corner of the outline.
  const userOrigin = doc => Array.isArray(doc?.origin) && Number.isFinite(doc.origin[0]) && Number.isFinite(doc.origin[1]);
  function originMode(model, o) {
    if (o.origin === "absolute") return "absolute";
    if ((o.origin === "auto" || o.origin === "user") && userOrigin(model.doc)) return "user";
    return "outline";
  }
  const ORIGIN_TEXT = {absolute: ["design origin", "Design origin", "design origin"], user: ["board origin", "Board origin", "board origin (Edit > Origin)"],
    outline: ["board lower-left corner", "Board lower-left corner", "lower-left corner of the board outline"]};
  const originText = (model, o, form = 0) => ORIGIN_TEXT[originMode(model, o)][form];
  function originFor(model, o) {
    const mode = originMode(model, o);
    if (mode === "absolute") return [0, 0];
    if (mode === "user") return [model.doc.origin[0], model.doc.origin[1]];
    const b = model.extents || [0, 0, 0, 0];
    return [b[0], b[3]];
  }
  const drillFrame = o => o.drillOrigin && o.drillOrigin !== "shared" ? {origin: o.drillOrigin} : o;
  const drillOriginFor = (model, o) => originFor(model, drillFrame(o));
  // Shift unrounded millimetres into the CAM frame before format-specific encoding.
  function projectCam([datumX, datumY], encode = mm => mm) {
    return point => [encode(point[0] - datumX), encode(datumY - point[1])];
  }

  // ---------------------------------------------------------------------------
  // Region holes as cut-ins (Gerber spec 2026.05 §4.10.3): each hole joins
  // the contour through two fully coincident horizontal segments from its
  // rightmost vertex to the nearest edge to the right, which is split at the
  // hit point. Works on integer output coordinates so the cut-ins stay exactly
  // horizontal. Holes whose ray is degenerate (touching, or ending on another
  // cut-in) are returned in `failed` for clear-polarity plotting.
  function cutIns(outer, holes) {
    const area = r => { let a = 0; for (let i = 0, n = r.length; i < n; i++) { const p = r[i], q = r[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; } return a; };
    const key = p => p[0] + "," + p[1];
    const closed = r => r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1] ? r.slice(0, -1) : r;
    let ring = closed(outer);
    if (area(ring) < 0) ring = ring.slice().reverse();
    const ends = new Set(), failed = [], contained = [];
    const list = holes.map(closed).filter(h => h.length >= 3).map(h => {
      if (area(h) > 0) h = h.slice().reverse();
      let m = 0;
      for (let i = 1; i < h.length; i++) if (h[i][0] > h[m][0] || (h[i][0] === h[m][0] && h[i][1] < h[m][1])) m = i;
      return {h, m, x: h[m][0]};
    }).sort((a, b) => b.x - a.x);
    for (const {h, m} of list) {
      const M = h[m], n = ring.length;
      let best = Infinity, edge = -1, vertex = -1, bad = false;
      for (let i = 0; i < n; i++) {
        const a = ring[i], b = ring[(i + 1) % n];
        if (a[1] === M[1]) {
          if (a[0] === M[0] || (b[1] === M[1] && Math.min(a[0], b[0]) <= M[0] && Math.max(a[0], b[0]) >= M[0])) bad = true;
          else if (a[0] > M[0] && a[0] < best) { best = a[0]; vertex = i; edge = -1; }
        } else if (b[1] !== M[1] && (a[1] - M[1]) * (b[1] - M[1]) < 0) {
          const x = a[0] + (M[1] - a[1]) * (b[0] - a[0]) / (b[1] - a[1]);
          if (x >= M[0] && x < M[0] + 1) bad = true;
          else if (x > M[0] && x < best) { best = x; edge = i; vertex = -1; }
        }
      }
      let H, at;
      if (!bad && edge >= 0) {
        H = [Math.round(best), M[1]];
        const a = ring[edge], b = ring[(edge + 1) % n];
        if (key(H) === key(a)) { vertex = edge; edge = -1; } else if (key(H) === key(b)) { vertex = (edge + 1) % n; edge = -1; }
      }
      if (!bad && vertex >= 0) {
        H = ring[vertex];
        if (ends.has(key(H)) || ring.filter(p => p[0] === H[0] && p[1] === H[1]).length > 1) bad = true;
      }
      if (bad || (edge < 0 && vertex < 0) || ends.has(key(M)) || !(H[0] > M[0])) { failed.push(h); continue; }
      const loop = [];
      for (let k = 0; k <= h.length; k++) loop.push(h[(m + k) % h.length]);
      at = edge >= 0 ? edge : vertex;
      ring = edge >= 0 ? [...ring.slice(0, at + 1), H, ...loop, H, ...ring.slice(at + 1)]
        : [...ring.slice(0, at + 1), ...loop, H, ...ring.slice(at + 1)];
      ends.add(key(M)); ends.add(key(H));
      contained.push(h);
    }
    return {ring, failed, contained};
  }

  // A contour as Gerber §4.10.3 wants it (integer output coordinates, cyclic): a vertex lying inside
  // a horizontal or vertical edge splits that edge, and the zero-width spikes (a -> b -> a) this
  // leaves are dropped. Source regions that bridge a hole along one of their own edges (stair-
  // stepped logos imported from Altium) then plot as a proper cut-in; valid contours are unchanged.
  function tidy(q) {
    const rows = new Map(), cols = new Map(), add = (m, k, v) => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
    for (const p of q) { add(rows, p[1], p[0]); add(cols, p[0], p[1]); }
    const n = q.length, out = [];
    for (let i = 0; i < n; i++) {
      const a = q[i], b = q[(i + 1) % n], k = a[1] === b[1] ? 0 : a[0] === b[0] ? 1 : -1, line = k === 0 ? rows.get(a[1]) : k === 1 ? cols.get(a[0]) : null;
      out.push(a);
      if (!line || line.length < 3) continue;
      const lo = Math.min(a[k], b[k]), hi = Math.max(a[k], b[k]);
      const inside = [...new Set(line.filter(v => v > lo && v < hi))].sort((x, y) => a[k] < b[k] ? x - y : y - x);
      for (const v of inside) out.push(k === 0 ? [v, a[1]] : [a[0], v]);
    }
    const same = (p, r) => p[0] === r[0] && p[1] === r[1], s = [];
    for (const p of out) {
      s.push(p);
      while (s.length >= 3 && same(s.at(-1), s.at(-3))) s.splice(-2, 2);
    }
    // The spikes across the start of the cyclic list.
    for (let changed = true; changed && s.length >= 3;) {
      changed = false;
      if (same(s.at(-2), s[0])) { s.pop(); s.shift(); changed = true; }
      else if (same(s.at(-1), s[1])) { s.shift(); s.shift(); changed = true; }
      else if (same(s.at(-1), s[0])) { s.pop(); changed = true; }
    }
    return s.length === n && out.length === n ? q : s;
  }

  // ---------------------------------------------------------------------------
  const plotPad = M.plotPad;

  // Gerber RS-274X writer.
  function gerber(model, layer, o) {
    const scale = gerberScale(o.units), [ip, dp] = o.format.split(":").map(Number), mult = 10 ** dp, limit = 10 ** (ip + dp);
    const val = v => trim(v * scale, 6);
    function int(v) {
      const n = Math.round(v * scale * mult);
      if (!(Math.abs(n) < limit)) throw Error("A coordinate exceeds the " + o.format + " Gerber format. Choose a format with more integer digits.");
      return n === 0 ? 0 : n;
    }
    const out = projectCam(originFor(model, o), int);
    const xy = q => "X" + q[0] + "Y" + q[1];
    const apertures = new Map(), macros = new Map(), header = [];
    let next = 10;
    function aperture(def, fn, macro) {
      const key = def + "|" + (fn || "");
      if (!apertures.has(key)) apertures.set(key, {code: next++, def, fn, macro});
      return apertures.get(key).code;
    }
    function macroName(body) {
      if (!macros.has(body)) macros.set(body, "ATR" + (macros.size + 1));
      return macros.get(body);
    }
    // Rotation is applied in model space then Y is flipped, which equals a
    // counter-clockwise Gerber rotation of -angle.
    const turn = (p, a) => { const q = A.rotate(p, a); return [q[0], -q[1]]; };
    function padCode(g, fn) {
      const r = norm360(-g.angle), k = Math.round(r / 90), quarter = Math.abs(r - 90 * k) < 1e-7;
      const swap = quarter && k % 2 === 1, w = swap ? g.h : g.w, h = swap ? g.w : g.h;
      if (g.shape === "circle") return aperture("C," + val(g.w), fn);
      if (quarter && g.shape === "rect") return aperture("R," + val(w) + "X" + val(h), fn);
      if (quarter && g.shape === "obround") return aperture("O," + val(w) + "X" + val(h), fn);
      if (quarter && g.shape === "roundrect" && g.r <= 1e-9) return aperture("R," + val(w) + "X" + val(h), fn);
      if (quarter && g.shape === "octagon" && g.t <= 1e-9) return aperture("R," + val(w) + "X" + val(h), fn);
      const prims = [], rot = trim(r, 6);
      const rect = (W, H) => { if (W > 1e-9 && H > 1e-9) prims.push("21,1," + val(W) + "," + val(H) + ",0,0," + rot); };
      const dot = (c, d) => { const q = turn(c, g.angle); prims.push("1,1," + val(d) + "," + val(q[0]) + "," + val(q[1])); };
      if (g.shape === "rect" || (g.shape === "roundrect" && g.r <= 1e-9)) rect(g.w, g.h);
      else if (g.shape === "obround") {
        const d = Math.min(g.w, g.h), off = (Math.max(g.w, g.h) - d) / 2, horizontal = g.w >= g.h;
        rect(horizontal ? g.w - d : g.w, horizontal ? g.h : g.h - d);
        dot(horizontal ? [off, 0] : [0, off], d); dot(horizontal ? [-off, 0] : [0, -off], d);
      } else if (g.shape === "roundrect") {
        const rr = g.r, cx = g.w / 2 - rr, cy = g.h / 2 - rr;
        rect(g.w, g.h - 2 * rr); rect(g.w - 2 * rr, g.h);
        for (const c of [[cx, cy], [-cx, cy], [-cx, -cy], [cx, -cy]]) dot(c, 2 * rr);
      } else {
        const pts = padOutline(g).map(p => turn(p, g.angle));
        prims.push("4,1," + pts.length + "," + [...pts, pts[0]].map(p => val(p[0]) + "," + val(p[1])).join(",") + ",0");
      }
      const body = prims.join("*\n"), name = macroName(body);
      return aperture(name, fn, body);
    }
    const lines = [];
    let currentCode = null, regionFn = null;
    // X2 object attributes (spec revision 2024.05 §5.6.13-§5.6.15) on copper:
    // .N net, .P refdes,pin[,function] and .C refdes. Pads without a net are
    // N/C, other unconnected copper has an empty net; non-conductors carry
    // none. Panels repeat each board's nets and designators, so their files
    // carry no object attributes.
    const x2Objects = layer.group === "Copper" && !model.panel, objAttr = {N: null, P: null, C: null};
    const objects = f => {
      if (!x2Objects) return;
      const pad = f?.use === "pad";
      const want = {N: !f || f.net == null || f.fn === "NonConductor" ? null : f.net === "" ? (pad ? "N/C" : "") : x2Field(f.net),
        P: pad && f.ref && f.pin != null ? x2Field(f.ref) + "," + x2Field(f.pin) + (f.pinName ? "," + x2Field(f.pinName) : "") : null,
        C: pad && f.ref ? x2Field(f.ref) : null};
      for (const k of ["N", "P", "C"]) {
        if (want[k] === objAttr[k]) continue;
        lines.push(want[k] == null ? "%TD." + k + "*%" : "%TO." + k + "," + want[k] + "*%");
        objAttr[k] = want[k];
      }
    };
    const select = code => { if (code !== currentCode) { lines.push("D" + code + "*"); currentCode = code; } };
    // Regions take their X2 aperture function from the attribute dictionary
    // current at G36, so it is set in the body around region objects.
    const regionAttr = fn => {
      if ((fn || null) === regionFn) return;
      lines.push(fn ? "%TA.AperFunction," + fn + "*%" : "%TD.AperFunction*%");
      regionFn = fn || null;
    };
    function contour(points) { return contourOf(points.map(out)); }
    function contourOf(raw) {
      let q = raw.filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
      if (q.length > 1 && q[0][0] === q.at(-1)[0] && q[0][1] === q.at(-1)[1]) q.pop();
      q = tidy(q);
      if (q.length < 3) return false;
      lines.push("G36*", xy(q[0]) + "D02*");
      for (let i = 1; i < q.length; i++) lines.push(xy(q[i]) + "D01*");
      lines.push(xy(q[0]) + "D01*", "G37*");
      return true;
    }
    function arcCommand(g, start, end) {
      const center = out(g.c);
      return (g.ccw ? "G03" : "G02") + xy(end) + "I" + (center[0] - start[0]) + "J" + (center[1] - start[1]) + "D01*";
    }
    function drawArc(g, start, end) {
      // A partial turn whose endpoints share a plot coordinate must never become a full circle.
      if (sameXY(start, end) && Math.abs(A.arcSweep(g)) < 360) {
        const mid = out(A.arcPoint(g, g.start + A.arcSweep(g) / 2));
        lines.push(arcCommand(g, start, mid), arcCommand(g, mid, end));
      } else lines.push(arcCommand(g, start, end));
    }
    function arcStroke(g, points, width, fn) {
      const start = out(A.arcPoint(g, g.start)), end = out(A.arcPoint(g, g.end)), center = out(g.c);
      const sweep = A.arcSweep(g);
      // A zero offset is invalid. Coincident quantised endpoints mean a complete turn in Gerber.
      if (sameXY(start, center) || sameXY(start, end) && Math.abs(sweep) < 180) {
        const C = AtriumGeometryCurves;
        // Keep the six-degree replay used by old Drill Drawing at coarse plot grids.
        stroke(points ?? C.project([C.arcEdge(g, sweep)], 1 / (scale * mult),
          {minSegments: 2, minStep: 6, maxStep: 6, legacyDegrees: true}), width, fn);
        return;
      }
      select(aperture("C," + val(width), fn));
      lines.push(xy(start) + "D02*");
      drawArc(g, start, end);
      lines.push("G01*");
    }
    // One exact contour of a stroked profile or a filled region.
    function drawContour(c) {
      if (!c.length) return;
      const S = AtriumBoardShape;
      let cur = out(S.head(c[0])), linear = true;
      lines.push(xy(cur) + "D02*");
      for (const g of c) {
        const q = out(S.tail(g));
        if (g.kind === "arc" && !sameXY(cur, out(g.c)) && (!sameXY(cur, q) || Math.abs(A.arcSweep(g)) >= 180)) {
          drawArc(g, cur, q); linear = false;
        } else {
          if (!linear) { lines.push("G01*"); linear = true; }
          if (q[0] !== cur[0] || q[1] !== cur[1]) lines.push(xy(q) + "D01*");
        }
        cur = q;
      }
      if (!linear) lines.push("G01*");
    }
    // Board profile with true arcs (G02/G03, G75 is set in the header) and cutouts.
    function profile(shape, width) {
      select(aperture("C," + val(width), "Profile"));
      const contours = AtriumBoardShape.profileContours(shape);
      for (const c of contours) drawContour(c);
      return contours.length;
    }
    function stroke(points, width, fn) {
      const q = points.map(out).filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
      if (!q.length) return;
      select(aperture("C," + val(width), fn));
      if (q.length === 1) { lines.push(xy(q[0]) + "D03*"); return; }
      lines.push(xy(q[0]) + "D02*");
      for (let i = 1; i < q.length; i++) lines.push(xy(q[i]) + "D01*");
    }
    // Own value on the pad or via, then the design rules (unless the dialog
    // overrides them), then the dialog value.
    let flashes = 0, regions = 0, draws = 0, clearHoles = 0;
    if (layer.key === "outline") {
      const width = o.profileWidth ?? DEFAULT_PROFILE_WIDTH;
      if (model.boardShape) draws += profile(model.boardShape, width);
      else if (model.outline.length) { stroke([...model.outline, model.outline[0]], width, "Profile"); draws++; }
    } else {
      const features = layer.features || model.layers.get(layer.key) || [];
      // Pours first: each region is dark with clear holes, largest first so
      // islands inside another region's holes are drawn after the holes.
      let polarity = "D";
      const setPolarity = want => {
        if (want !== polarity) { lines.push("%LP" + want + "*%"); polarity = want; }
      };
      const plotted = o.plottedFeature;
      for (const f of features) {
        if (f.t !== "pour") continue;
        const startRegions = regions;
        const rings = AtriumPCBPours.contourSegments(f, f.rings);
        for (const [r, ring] of rings.entries()) {
          if (ring.length < 2) continue;
          setPolarity(r === 0 ? "D" : "C");
          objects(f);
          regionAttr(f.fn);
          if (ring.some(g => g.kind === "arc")) {
            lines.push("G36*");
            drawContour(ring);
            lines.push("G37*");
            regions++;
          } else if (contour(ring.map(edge => edge.a))) regions++;
        }
        plotted?.(f, regions > startRegions);
      }
      setPolarity("D");
      for (const f of features) {
        if (f.t === "pour") continue;
        const clear = f.polarity === "clear";
        setPolarity(clear ? "C" : "D");
        const startRegions = regions;
        if (f.t === "region" || f.t === "stroke" || f.t === "circle" || f.t === "flash") objects(f);
        if (f.t === "region" && f.contour) {
          const holes = f.holeContours || (f.holes || []).map(r => r.map((a,i) => ({kind:"line",a,b:r[(i+1)%r.length]})));
          const boundary = holes.length ? globalThis.AtriumBoardShapeSources.cutInContours(f.contour,holes) : f.contour;
          if (boundary) { regionAttr(f.fn); lines.push("G36*"); drawContour(boundary); lines.push("G37*"); regions++; plotted?.(f, true); continue; }
        }
        if (f.t === "region" && f.holes?.length) {
          regionAttr(f.fn);
          const ring = r => r.map(out).filter((p, i, a) => !i || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]);
          const c = cutIns(ring(f.points), f.holes.map(ring));
          if (contourOf(c.ring)) regions++;
          // Holes that cannot take a clean horizontal cut-in are cleared
          // with clear polarity instead (spec 2026.05 §4.10.4.6).
          if (c.failed.length) {
            if (clear) throw Error("A clear artwork region has a cutout that cannot be encoded in Gerber.");
            setPolarity("C");
            for (const h of c.failed) if (contourOf(h)) regions++;
            setPolarity("D");
            clearHoles += c.failed.length;
          }
        } else if (f.t === "region") { regionAttr(f.fn); if (contour(f.points)) regions++; }
        else if (f.t === "stroke") {
          if (f.arc) arcStroke(f.arc, f.points, f.width, f.fn);
          else stroke(f.points, f.width, f.fn);
          draws++;
        }
        else if (f.t === "circle") {
          const s = out([f.c[0] + f.r, f.c[1]]), c = out(f.c);
          select(aperture("C," + val(f.width), f.fn));
          lines.push(xy(s) + "D02*", "G03" + xy(s) + "I" + (c[0] - s[0]) + "J" + (c[1] - s[1]) + "D01*", "G01*");
          draws++;
        } else if (f.t === "flash") {
          const g = plotPad(f, o);
          if (!g) { plotted?.(f, false); continue; }
          select(padCode(g, f.fn));
          lines.push(xy(out(f.at)) + "D03*");
          flashes++;
        }
        plotted?.(f, f.t === "region" ? regions > startRegions : f.t !== "stroke" || f.points?.length > 0);
      }
      setPolarity("D");
    }
    regionAttr(null);
    objects(null);
    // File attributes (spec revision 2024.05 §5.6): the creation date is the
    // job date, so equal jobs give byte-identical files.
    header.push("G04 Waffle fabrication output: " + comment(layer.title) + "*",
      "G04 Board: " + comment(model.doc.name) + "*",
      "%TF.GenerationSoftware,Waffle,Waffle," + x2Field(VERSION) + "*%",
      "%TF.CreationDate," + isoDate(o.date) + "*%",
      "%TF.SameCoordinates,Original*%",
      "%TF.FileFunction," + layer.fileFunction + "*%",
      "%TF.FilePolarity," + layer.polarity + "*%",
      "%TF.Part," + (model.panel ? "Array" : "Single") + "*%",
      "%FSLAX" + ip + dp + "Y" + ip + dp + "*%",
      "%MO" + (o.units === "mm" ? "MM" : "IN") + "*%",
      "G04 Origin: " + originText(model, o) + "*",
      "%LPD*%", "G75*", "G01*");
    for (const [body, name] of macros) header.push("%AM" + name + "*\n" + body + "*%");
    let fn = null;
    for (const a of apertures.values()) {
      if ((a.fn || null) !== fn) { header.push(a.fn ? "%TA.AperFunction," + a.fn + "*%" : "%TD.AperFunction*%"); fn = a.fn || null; }
      header.push("%ADD" + a.code + a.def + "*%");
    }
    if (fn) header.push("%TD.AperFunction*%");
    return {content: [...header, ...lines, "M02*", ""].join("\n"), stats: {flashes, regions, draws, apertures: apertures.size, ...(clearHoles ? {clearHoles} : {})}};
  }

  // ---------------------------------------------------------------------------
  // Excellon NC drill writer. One file per drill pair in use (AtriumStackup
  // drillPairs: through, blind and buried spans), with plated and non-plated
  // holes in separate files, microvias and back-drills in their own files.
  // Headers carry the X2 attributes as "; #@! " comments (Gerber Layer Format
  // Specification revision 2024.05 §5.6.3 for the drill file functions, and
  // Ucamco's "X2 attributes in Excellon" convention).
  const preparedDrills = new WeakMap();
  function prepareDrills(model) {
    // A fresh analysis owns its drill hits. The groups live only as long as
    // that analysis, and are read by plans, reports and format-specific writers.
    preparedDrills.set(model, null);
    return model;
  }
  function drillGroups(model) {
    if (!preparedDrills.has(model)) return collectDrillGroups(model);
    const cached = preparedDrills.get(model);
    if (cached) return cached;
    const groups = Object.freeze(collectDrillGroups(model).map(g => Object.freeze({...g,
      hits:Object.freeze(g.hits), span:Object.freeze(g.span.slice()), pair:Object.freeze(g.pair),
      region:g.region && Object.freeze({...g.region})})));
    preparedDrills.set(model,groups);
    return groups;
  }
  function collectDrillGroups(model) {
    const last = model.stack.length - 1, groups = new Map();
    // Holes in a region of another substack (flex) go to their own file: they
    // are drilled through that substack's layers only.
    const regionOf = h => { const g = model.flex?.regionAt?.(h.at); return g && g.stack !== "main" ? g : null; };
    for (const h of model.drills) {
      const through = h.span[0] === 0 && h.span[1] === last, g = regionOf(h);
      const key = (h.backdrill ? "BackDrill-" + h.span.join("-") : h.laser ? "Microvia-" + h.span.join("-") : !h.plated ? "NonPlated" : through ? "Plated" : "Plated-" + h.span.join("-")) + (g ? "@" + g.stack : "");
      if (!groups.has(key)) groups.set(key, {key, plated: h.plated, span: h.plated || h.backdrill ? h.span : [0, last], hits: [], backdrill: h.backdrill, laser: h.laser, region: g ? {stack: g.stack, name: g.stackName, copper: g.copper} : null});
      groups.get(key).hits.push(h);
    }
    // The layer stack's drill pair for each span (name, kind, defined).
    if (!groups.size) return [];
    const pairs = model.getDrillPairs?.() ?? drillPairsFor(model.doc,model.defs,model.physicalStack);
    for (const g of groups.values()) {
      const from = model.stack[g.span[0]], to = model.stack[g.span[1]], e = pairs.get(from + "|" + to);
      const kind = g.span[0] === 0 && g.span[1] === last ? "through" : g.span[0] === 0 || g.span[1] === last ? "blind" : "buried";
      g.pair = {from, to, kind, name: e?.name || PCB.name(from) + " - " + PCB.name(to), defined: e ? !!e.defined : kind === "through"};
    }
    const order = k => k === "Plated" ? 0 : k === "NonPlated" ? 3 : k.startsWith("BackDrill") ? 2 : 1;
    return [...groups.values()].sort((a, b) => order(a.key) - order(b.key) || a.span[0] - b.span[0] || a.span[1] - b.span[1]);
  }
  // Optional via-fill files (options.viaFill): a copy of the plugged or filled vias'
  // holes (IPC-4761 Type III-VII) per drill span, for the fabricator's fill program.
  const FILLED = /^(III|IV|V|VI|VII)/;
  function viaFillGroups(model) {
    const out = [];
    for (const g of drillGroups(model)) {
      if (!g.plated || g.backdrill) continue;
      const hits = g.hits.filter(h => h.via && h.ipc && FILLED.test(h.ipc));
      if (hits.length) out.push({...g, key: "ViaFill-" + g.key, hits, viaFill: true});
    }
    return out;
  }
  const shortLayer = l => l === "Top" ? "TOP" : l === "Bottom" ? "BOT" : "IN" + PCB.index(l);
  // X2 file function of a drill file. Back-drills are non-plated blind drills
  // from the outer layer they start at.
  function drillFunction(model, group) {
    const n = model.stack.length, a = group.span[0] + 1, b = group.span[1] + 1;
    if (group.viaFill) return "Other,ViaFill," + a + "," + b;
    return group.backdrill ? "NonPlated," + (group.backdrill === "top" ? a + "," + b : b + "," + a) + ",Blind,Drill"
      : !group.plated ? "NonPlated,1," + n + ",NPTH" : group.key === "Plated" ? "Plated,1," + n + ",PTH" : "Plated," + a + "," + b + "," + (a === 1 || b === n ? "Blind" : "Buried") + (group.laser ? ",Drill" : "");
  }
  // Tools are keyed on the printed size, so no two tools print alike. Files
  // with X2 drill functions keep vias apart from component holes; filled or
  // plugged vias (IPC-4761) get their own tool.
  function drillTools(group, o) {
    const metric = o.drillUnits === "mm", scale = metric ? 1 : 1 / 25.4;
    const places = metric ? 3 : 4, tools = [], tagged = !!group.backdrill || group.hits.some(h => h.ipc);
    for (const h of group.hits) {
      const label = fixed(h.d * scale, places), via = tagged && !!h.via;
      let tool = tools.find(t => t.label === label && t.ipc === h.ipc && t.via === via);
      if (!tool) { tool = {size: +label, label, hits: [], ipc: h.ipc, via}; tools.push(tool); }
      tool.hits.push(h);
    }
    tools.sort((x, y) => x.size - y.size || Number(y.via) - Number(x.via) || String(x.ipc || "").localeCompare(String(y.ipc || "")));
    tools.forEach((t, i) => {
      t.code = "T" + String(i + 1).padStart(2, "0");
      t.function = group.backdrill ? "BackDrill" : !group.plated ? "MechanicalDrill" : t.via ? "ViaDrill" + (t.ipc ? "," + t.ipc : "") : "ComponentDrill";
      const vias = t.hits.filter(h => h.via).length;
      t.use = group.backdrill ? "Back-drill " + [...new Set(t.hits.map(h => shortLayer(h.stop)))].join("/") + " stub " + trim(Math.max(...t.hits.map(h => h.stub || 0)), 3) : !group.plated ? (t.hits.every(h => h.use === "mousebite") ? "Mouse bite" : t.hits.every(h => h.use === "tooling") ? "Tooling" : "Mechanical")
        : vias === t.hits.length ? (group.laser ? "Microvia" : "Via") + (t.ipc ? " (IPC-4761 " + t.ipc + ")" : "") : vias ? "Via + component" : "Component";
    });
    return {tools, tagged, metric, scale};
  }
  function drill(model, group, o, prepared) {
    const origin = drillOriginFor(model, o);
    const {tools, tagged, metric, scale} = prepared?.tools(group, o) ?? drillTools(group, o);
    const fnAttr = drillFunction(model, group), pair = group.pair;
    let coord;
    if (o.drillFormat === "decimal") {
      const places = metric ? 4 : 5;
      coord = v => { const s = trim(v * scale, places); return s.includes(".") ? s : s + ".0"; };
    } else {
      const [ip, dp] = o.drillFormat.split(":").map(Number), limit = 10 ** (ip + dp);
      coord = v => {
        const k = Math.round(v * scale * 10 ** dp);
        if (!(Math.abs(k) < limit)) throw Error("A drill coordinate exceeds the " + o.drillFormat + " format.");
        return (k < 0 ? "-" : "") + String(Math.abs(k)).padStart(ip + dp, "0");
      };
    }
    const locate = projectCam(origin, coord);
    const point = p => { const [x, y] = locate(p); return "X" + x + "Y" + y; };
    const lines = ["M48",
      ";DRILL file {Waffle " + VERSION + "} date " + isoDate(o.date),
      ";Board: " + comment(model.doc.name),
      ";FORMAT={" + (o.drillFormat === "decimal" ? "-:-" : o.drillFormat) + "/ absolute / " + (metric ? "metric" : "inch") + " / " + (o.drillFormat === "decimal" ? "decimal" : "keep zeros") + "}",
      "; #@! TF.CreationDate," + isoDate(o.date),
      "; #@! TF.GenerationSoftware,Waffle,Waffle," + x2Field(VERSION),
      "; #@! TF.FileFunction," + fnAttr,
      "; #@! TF.FilePolarity,Positive",
      ...(group.region ? [";SUBSTACK=" + comment(group.region.name) + " (copper " + group.region.copper.join(", ") + ")"] : []),
      ";TYPE=" + (group.plated ? "PLATED" : "NON_PLATED"),
      ";LAYER_PAIR=" + model.stack[group.span[0]] + " - " + model.stack[group.span[1]],
      ...(pair && group.plated ? [";DRILL_PAIR=" + comment(pair.name) + " (" + pair.kind + (model.stackStored && !pair.defined ? ", not a drill pair of the layer stack" : "") + ")"] : []),
      ...(group.backdrill ? [";BACKDRILL=from " + group.backdrill + "; keep " + [...new Set(group.hits.map(h => h.stop))].join(", ") + "; max stub " + trim(Math.max(...group.hits.map(h => h.stub || 0)), 4) + " mm"] : []),
      ...(group.laser ? [";LASER=microvia"] : []),
      ...(group.viaFill ? [";VIA_FILL=plug or fill these holes (IPC-4761 " + [...new Set(group.hits.map(h => h.ipc))].sort().join(", ") + "); they are also in the drill file of their span"] : []),
      ";ORIGIN=" + originText(model, drillFrame(o))];
    if (o.drillFormat === "decimal") lines.push(metric ? "METRIC" : "INCH");
    else {
      const [ip, dp] = o.drillFormat.split(":").map(Number);
      lines.push(";FILE_FORMAT=" + o.drillFormat, (metric ? "METRIC" : "INCH") + ",LZ," + "0".repeat(ip) + "." + "0".repeat(dp));
    }
    for (const t of tools) {
      if (tagged) lines.push("; #@! TA.AperFunction," + t.function);
      lines.push(t.code + "C" + t.label);
    }
    lines.push("%", "G90", "G05");
    for (const t of tools) {
      lines.push(t.code);
      const hits = t.hits.slice().sort((a, b) => b.at[1] - a.at[1] || a.at[0] - b.at[0]);
      for (const h of hits) lines.push(h.endpoints ? point(h.endpoints[0]) + "G85" + point(h.endpoints[1]) : point(h.at));
    }
    lines.push("T0", "M30", "");
    return {content: lines.join("\n"), stats: {tools: tools.length, hits: group.hits.length}, tools: tools.map(t => ({code: t.code, size: t.size, hits: t.hits.length}))};
  }
  // Drill files in plan order with their names, as plan() lists them.
  function drillFileName(model, g, o) {
    const board = stemOf(model, o), pair = shortLayer(model.stack[g.span[0]]) + "-" + shortLayer(model.stack[g.span[1]]);
    const base = g.key.split("@")[0], kind = g.viaFill ? "ViaFill" : g.backdrill ? "BackDrill" : g.laser ? "Microvia" : base === "Plated" || base === "NonPlated" ? base : "Plated";
    const suffix = (kind === base ? kind : kind + "-" + pair) + (g.region ? "-" + baseName(g.region.name).replace(/\s+/g, "") : "");
    return {name: board + "-" + suffix + ".TXT", kind, base};
  }

  // ---------------------------------------------------------------------------
  // Drill drawing (Gerber, X2 file function Drillmap): a symbol per tool at
  // every hit, the board profile and a drill table under the board. Symbols
  // are geometric shapes, then letters, in tool order across all drill files.
  const SYMBOL_NAMES = ["cross", "x", "circle", "square", "triangle", "diamond", "hexagon", "circle with cross", "square with x",
    "inverted triangle", "diamond with cross", "circle with x", "star", "square with cross", "hexagon with x"];
  const symbolName = i => i < SYMBOL_NAMES.length ? SYMBOL_NAMES[i] : "letter " + symbolLetter(i);
  const symbolLetter = i => { let k = i - SYMBOL_NAMES.length, s = ""; do { s = String.fromCharCode(65 + k % 26) + s; k = Math.floor(k / 26) - 1; } while (k >= 0); return s; };
  function symbolFeatures(i, at, r, width) {
    const [x, y] = at, out = [], line = pts => out.push({t: "stroke", points: pts.map(p => [x + p[0] * r, y + p[1] * r]), width});
    const ngon = (n, start) => { const pts = []; for (let k = 0; k <= n; k++) { const a = (start + 360 * k / n) * Math.PI / 180; pts.push([Math.cos(a), -Math.sin(a)]); } return pts; };
    const cross = () => { line([[-1, 0], [1, 0]]); line([[0, -1], [0, 1]]); };
    const ex = (k = .72) => { line([[-k, -k], [k, k]]); line([[-k, k], [k, -k]]); };
    const circle = () => out.push({t: "circle", c: [x, y], r, width});
    const square = (k = .8) => line([[-k, -k], [k, -k], [k, k], [-k, k], [-k, -k]]);
    switch (i) {
      case 0: cross(); break;
      case 1: ex(); break;
      case 2: circle(); break;
      case 3: square(); break;
      case 4: line(ngon(3, 90)); break;
      case 5: line(ngon(4, 90)); break;
      case 6: line(ngon(6, 0)); break;
      case 7: circle(); cross(); break;
      case 8: square(); ex(.8); break;
      case 9: line(ngon(3, 270)); break;
      case 10: line(ngon(4, 90)); cross(); break;
      case 11: circle(); ex(); break;
      case 12: cross(); ex(); break;
      case 13: square(); cross(); break;
      case 14: line(ngon(6, 0)); ex(.7); break;
      default: {
        const t = strokeText(symbolLetter(i), [x, y + r * .6], 0, r * 1.2, "center", false);
        for (const s of t.strokes) out.push({t: "stroke", points: s, width});
      }
    }
    return out;
  }
  function drillTable(model, o, prepared) {
    const rows = [];
    let n = 0;
    for (const g of drillGroups(model)) {
      const file = drillFileName(model, g, o).name, {tools} = prepared?.tools(g, o) ?? drillTools(g, o);
      for (const t of tools) rows.push({symbol: n++, group: g, tool: t, file});
    }
    return rows;
  }
  // Altium plot symbols use a common quarter-grid. The radius is 40% of the
  // Gerber symbol size and the pen is 10%, except for the round symbol.
  const drillGlyphs = [
    [[-2,-2],[-2,2],[2,2],[2,-2]], null, [[0,-2],[-2,2],[2,2]],
    [[0,-2],[1,-1],[2,-1],[1,0],[2,1],[1,1],[0,2],[-1,1],[-2,1],[-1,0],[-2,-1],[-1,-1]],
    [[-2,-2],[-1,0],[-2,2],[0,1],[2,2],[1,0],[2,-2],[0,-1]],
    [[-1,-1],[-1,-2],[1,-2],[1,-1],[2,-1],[2,1],[1,1],[1,2],[-1,2],[-1,1],[-2,1],[-2,-1]],
    [[-2,-2],[-1,-2],[0,-1],[1,-2],[2,-2],[2,-1],[1,0],[2,1],[2,2],[1,2],[0,1],[-1,2],[-2,2],[-2,1],[-1,0],[-2,-1]],
    [[-2,0],[0,2],[2,0],[0,-2]]
  ];
  function sourceDrillLayout(model) {
    const tools = model.doc.sourceDrillDrawing?.tools;
    if (!Array.isArray(tools) || !tools.length || model.placedDrillTable) return null;
    const base = d => (d.sourceName || "").split(/[\\/]/).pop().toLowerCase();
    const name = base(model.doc), boards = model.project.documents.filter(d => d.kind === "pcb");
    const plots = (Array.isArray(model.project.sourceDrillPlots) ? model.project.sourceDrillPlots : [])
      .filter(p => p && (p.board ? p.board === name : boards.length === 1));
    if (plots.length && boards.filter(b => base(b) === name).length !== 1) return null;
    // Altium's default Gerber mark is 50 mil. DRILLSYMBOLSIZE in Board6 is a
    // PCB display preference and can differ from both the default and the job.
    const size = Object.hasOwn(model,"sourceDrillSize") ? model.sourceDrillSize : plots.length ? plots[0].size : 1.27;
    if (!(Number.isFinite(size) && size > 0 && size <= 0x7fffffff * .00000254) || plots.some(p => p.size !== size)) return null;
    const counts = new Map();
    let plottedTools = 0;
    for (const h of model.drills) {
      const t = Number.isInteger(h.sourceDrillTool) && tools[h.sourceDrillTool];
      // Tool dimensions in the manager are rounded to thousandths of a mil.
      // A reassigned, newly added or changed hole uses the native drawing.
      if (!t || !Number.isFinite(t.diameter) || !(t.diameter > 0) || !Number.isFinite(t.slot) || !Number.isFinite(h.slotLength) ||
          Math.abs(t.diameter - h.d) > .0000254 || Math.abs(t.slot - h.slotLength) > .0000254 ||
          (t.slotted && !(t.slot > t.diameter)) || t.plated !== h.plated || h.backdrill || h.span[0] !== 0 || h.span[1] !== model.stack.length-1) return null;
      const n = (counts.get(t) || 0) + 1;
      if (!Number.isSafeInteger(t.hits) || n > t.hits) return null;  // copies retained the old tool reference
      counts.set(t, n);
      if (t.mark === null) continue;
      if (!Number.isInteger(t.mark) || !(t.mark >= 0 && t.mark < drillGlyphs.length || t.mark >= 15 && t.mark < 41)) return null;
      if (n === 1) plottedTools++;
    }
    return plottedTools ? {size, tools, count: plottedTools} : null;
  }
  function importedDrillGlyph(mark, at, size) {
    const width = size / 10;
    if (mark === 1) return [{t: "circle", c: at, r: size * .4, width: size * 2 / 15}];
    if (mark >= 15) {
      const letter = String.fromCharCode(65 + mark - 15);
      return strokeText(letter, at, 0, size, "left").strokes.map(points => ({t: "stroke", points, width}));
    }
    const vertices = drillGlyphs[mark], scale = size / 5;
    const points = vertices.map(([x,y]) => [at[0] + x * scale, at[1] - y * scale]);
    return [{t: "stroke", points: [...points, points[0]], width}];
  }
  function drillMapLayer(model, o, source = sourceDrillLayout(model), prepared) {
    if (source) {
      const features = [...(model.layers.get("Drill drawing") || [])];
      for (const h of model.drills) {
        const mark = source.tools[h.sourceDrillTool].mark;
        if (mark !== null) features.push(...importedDrillGlyph(mark, h.at, source.size));
      }
      return {key: "drillmap", ext: "GD1", title: "Drill Drawing", group: "Drill drawing", fileFunction: "Drillmap", polarity: "Positive", features, count: source.count};
    }
    const rows = drillTable(model, o, prepared), features = [], unit = o.drillUnits === "mm" ? "mm" : "in";
    const b = model.extents || [0, 0, 0, 0], R = .5, W = .1;
    for (const row of rows) for (const h of row.tool.hits) features.push(...symbolFeatures(row.symbol, h.at, R, W));
    if (model.boardShape) {
      for (const c of AtriumBoardShape.profileContours(model.boardShape)) for (const g of c) {
        features.push(g.kind === "arc" ? {t:"stroke", width:.1, arc:g} : {t:"stroke", width:.1, points:[g.a,g.b]});
      }
    } else if (model.outline.length) features.push({t: "stroke", points: [...model.outline, model.outline[0]], width: .1});
    // Drill table under the board (the model is Y down).
    const size = 1, pitch = 1.9, gap = 2 * size, x0 = b[0], y0 = b[3] + 5;
    const head = ["SYMBOL", "HITS", "SIZE (" + unit.toUpperCase() + ")", "PLATED", "USE", "LAYER PAIR", "FILE"];
    const cells = rows.map(r => ["", String(r.tool.hits.length), r.tool.label, r.group.plated ? "YES" : "NO", r.tool.use, r.group.pair ? r.group.pair.name : "", r.file]);
    const total = rows.reduce((s, r) => s + r.tool.hits.length, 0);
    const widths = head.map((h, c) => Math.max(c === 0 ? 4 : 0, Array.from(h).length, ...cells.map(r => Array.from(r[c]).length)) * size);
    const xs = []; let x = x0;
    for (const w of widths) { xs.push(x); x += w + gap; }
    const right = x - gap;
    const put = (text, at) => { const t = strokeText(text, at, 0, size, "left", false); for (const s of t.strokes) features.push({t: "stroke", points: s, width: .12}); };
    put("DRILL TABLE - " + model.doc.name, [x0, y0]);
    let y = y0 + pitch * 1.4;
    head.forEach((h, c) => put(h, [xs[c], y]));
    features.push({t: "stroke", points: [[x0, y + .5], [right, y + .5]], width: .1});
    for (let k = 0; k < rows.length; k++) {
      y += pitch;
      features.push(...symbolFeatures(rows[k].symbol, [xs[0] + 2 * size, y - size / 2], R, W));
      cells[k].forEach((v, c) => { if (c) put(v, [xs[c], y]); });
    }
    features.push({t: "stroke", points: [[x0, y + .5], [right, y + .5]], width: .1});
    put("TOTAL " + total + " HOLE" + (total === 1 ? "" : "S") + " IN " + rows.length + " TOOL" + (rows.length === 1 ? "" : "S"), [x0, y + pitch]);
    return {key: "drillmap", ext: "GD1", title: "Drill Drawing", group: "Drill drawing", fileFunction: "Drillmap", polarity: "Positive", features, count: rows.length};
  }

  // Drill report (text): every drill file with its X2 function, layer pair
  // and tools, the smallest hole and the aspect ratio from the layer stack.
  function drillReport(model, p, prepared) {
    const o = p.options, unit = o.drillUnits === "mm" ? "mm" : "in", rows = drillTable(model, o, prepared), last = model.stack.length - 1;
    const S = globalThis.AtriumStackup;
    let thickness = null;
    try { thickness = S?.thickness?.(model.doc, model.defs, model.physicalStack) ?? null; } catch { thickness = null; }
    const depth = g => {
      const a = layerInfoOf(model, model.stack[g.span[0]]), b = layerInfoOf(model, model.stack[g.span[1]]);
      return a && b && Number.isFinite(a.z) && Number.isFinite(b.z) ? b.z + (b.thickness || 0) - a.z : null;
    };
    const dielectric = g => {
      const a = layerInfoOf(model, model.stack[g.span[0]]), b = layerInfoOf(model, model.stack[g.span[1]]);
      return a && b && Number.isFinite(a.z) && Number.isFinite(b.z) ? b.z - a.z - (a.thickness || 0) : depth(g);
    };
    const L = ["Drill report for " + model.doc.name, "Generated by Waffle " + VERSION + " on " + isoDate(o.date), "",
      "Units: " + (unit === "mm" ? "millimetres" : "inches") + ". Coordinates: " + originText(model, o, 2) + ", viewed from the top, Y up.",
      "Copper layers (top to bottom): " + model.stack.map((l, i) => "L" + (i + 1) + " " + PCB.name(l)).join(", ") + ".",
      ...(thickness > 0 ? ["Board thickness: " + trim(thickness, 3) + " mm (layer stack)."] : []), ""];
    const groups = [...new Set(rows.map(r => r.group))];
    const sourceDrill = p.sourceDrill === undefined ? sourceDrillLayout(model) : p.sourceDrill;
    const drawingSymbol = r => {
      if (!sourceDrill) return symbolName(r.symbol);
      return [...new Set(r.tool.hits.map(h => {
        const mark = sourceDrill.tools[h.sourceDrillTool].mark;
        return mark === null ? "unmarked" : mark >= 15 ? "letter " + String.fromCharCode(65 + mark - 15) : "Altium symbol " + mark;
      }))].join(", ");
    };
    for (const g of groups) {
      const mine = rows.filter(r => r.group === g), hits = mine.reduce((s, r) => s + r.tool.hits.length, 0), smallest = Math.min(...mine.map(r => r.tool.size));
      L.push("File: " + mine[0].file, "  X2 file function: " + drillFunction(model, g),
        "  Layer pair: L" + (g.span[0] + 1) + "-L" + (g.span[1] + 1) + " " + (g.pair?.name || "") + " (" + (g.backdrill ? "back-drill from " + g.backdrill : g.laser ? "microvia" : g.pair?.kind || "") + ")" +
          (g.plated && model.stackStored && g.pair && !g.pair.defined ? " - not a drill pair of the layer stack" : "") + (g.region ? " in " + g.region.name : ""),
        "  " + "Tool".padEnd(6) + ("Size (" + unit + ")").padEnd(12) + "Hits".padEnd(7) + "Plated".padEnd(8) + "Use".padEnd(26) + "Symbol");
      for (const r of mine) L.push("  " + r.tool.code.padEnd(6) + r.tool.label.padEnd(12) + String(r.tool.hits.length).padEnd(7) + (g.plated ? "yes" : "no").padEnd(8) + r.tool.use.padEnd(26) + drawingSymbol(r));
      // Laser microvias: IPC-2226 aspect ratio is the dielectric depth over the hole.
      const d = g.laser ? dielectric(g) : g.plated ? (g.span[0] === 0 && g.span[1] === last && thickness > 0 ? thickness : depth(g)) : null, hole = unit === "mm" ? smallest : smallest * 25.4;
      L.push("  " + mine.length + " tool" + (mine.length === 1 ? "" : "s") + ", " + hits + " hit" + (hits === 1 ? "" : "s") + "; smallest " + trim(smallest, 4) + " " + unit +
        (d > 0 && hole > 0 ? "; aspect ratio " + trim(d / hole, 2) + ":1 over " + trim(d, 3) + " mm" + (g.laser ? " of dielectric" : "") : "") + ".", "");
    }
    const total = rows.reduce((s, r) => s + r.tool.hits.length, 0);
    L.push("Total: " + groups.length + " drill file" + (groups.length === 1 ? "" : "s") + ", " + rows.length + " tool" + (rows.length === 1 ? "" : "s") + ", " + total + " hole" + (total === 1 ? "" : "s") + ".");
    if (model.hdi?.length) L.push("", "HDI and via construction:", ...model.hdi.map(n => "  - " + n));
    const issues = (model.layerIssues || []).filter(i => i.kind === "drillPair");
    if (issues.length) { L.push("", "Drill pairs to check:"); for (const i of issues) L.push("  - " + i.count + " hole" + (i.count === 1 ? "" : "s") + " from " + PCB.name(i.from) + " to " + PCB.name(i.to) + " (not a drill pair of the layer stack)"); }
    return L.join("\r\n") + "\r\n";
  }

  // ---------------------------------------------------------------------------
  // Pick and place (Altium CSV layout).
  function csvCell(v) {
    let s = String(v ?? "");
    // Keep spreadsheets from evaluating text as a formula (plain numbers pass).
    if (/^[=+\-@\t\r]/.test(s) && !/^[+-]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return "\"" + s.replace(/"/g, "\"\"") + "\"";
  }
  const fittedPlacements = model => model.parts.filter(p => !model.dnp?.has(p.item))
    .sort((a, b) => a.item.ref.localeCompare(b.item.ref, "en", {numeric: true}));
  function pickPlace(model, o, prepared) {
    const rows = prepared?.placements(model) ?? fittedPlacements(model);
    const jlc = o.pnpStyle === "jlc", mil = !jlc && o.pnpUnits === "mil", unit = mil ? "mil" : "mm";
    const locate = projectCam(originFor(model, o), mm => mil ? fixed(mm * (1 / .0254), 2) : fixed(mm, 4) + (jlc ? "mm" : ""));
    const pad = n => String(n).padStart(2, "0"), d = o.date;
    const alternateDescription = !jlc && globalThis.AtriumVariants?.appliedDescription(model.project, model.defs);
    // The JLC CPL uses the same footprint origin with mm suffixes and a shorter header.
    const lines = jlc ? ["Designator,Mid X,Mid Y,Layer,Rotation"] :
      ["Waffle Pick and Place Locations", csvCell(comment(model.doc.name)), "",
        "=".repeat(120), "File Design Information:", "",
        "Date:       " + pad(d.getDate()) + "/" + pad(d.getMonth() + 1) + "/" + pad(d.getFullYear() % 100),
        "Time:       " + pad(d.getHours()) + ":" + pad(d.getMinutes()),
        "Revision:   " + (typeof model.project?.revision?.letter === "string" && model.project.revision.letter || "Not in VersionControl"), "Variant:    " + (model.project?.variantApplied?.name || "No variations"), "Units used: " + unit,
        "Origin:     " + originText(model, o, 1), "",
        ["Designator", "Comment", "Layer", "Footprint", "Center-X(" + unit + ")", "Center-Y(" + unit + ")", "Rotation", "Description"].map(csvCell).join(",")];
    for (const {item, def, fp, side} of rows) {
      const layer = side === "Bottom" ? "Bottom" : "Top";
      const [x, y] = locate([item.x, item.y]), rotation = trim(norm360(-(item.angle || 0)), 2);
      if (jlc) lines.push([csvCell(item.ref), x, y, layer, rotation].join(","));
      else {
        const p = def.parameters || {};
        const description = alternateDescription?.(item) ?? p.Description ?? p.DESCRIPTION ?? def.description ?? def.name ?? "";
        lines.push([item.ref, item.value ?? "", layer + "Layer", fp.name || def.footprintName || "",
          x, y, rotation, description].map(csvCell).join(","));
      }
    }
    return {content: lines.join("\r\n") + "\r\n", stats: {components: rows.length, dnp: model.parts.length - rows.length}};
  }

  // ---------------------------------------------------------------------------
  // Assembly drawings (SVG, millimetres). The bottom view is mirrored so it
  // shows the board as seen from the bottom side.
  function assembly(model, side, o, exactPaths) {
    const dateText=o.dateText ?? isoDate(o.date).slice(0,10);
    const bottom = side === "Bottom", b = model.extents || [0, 0, 10, 10], margin = 5, title = 9;
    const W = b[2] - b[0] + 2 * margin, H = b[3] - b[1] + 2 * margin + title;
    // Drawings print to fit a landscape page: a whole-number scale keeps
    // dimensions measurable, and the title states it.
    const scale = Math.max(1, Math.min(10, Math.floor(250 / W)));
    const heading = model.doc.name + " — " + (bottom ? "Bottom assembly (viewed from bottom, mirrored)" : "Top assembly") +
      (model.project?.variantApplied ? " · Variant " + model.project.variantApplied.name : "");
    const headingSize = Math.min(2.2, (W - 2 * margin) / (Array.from(heading).length * .6));
    const X = x => bottom ? b[0] + b[2] - x : x;
    const S = globalThis.AtriumBoardShape, place = p => [X(p[0]) - b[0] + margin, p[1] - b[1] + margin];
    const pt = p => place(p).map(v => trim(v, 4)).join(",");
    const poly = (pts, closed) => (closed ? "<polygon" : "<polyline") + " points=\"" + pts.map(pt).join(" ") + "\"";
    function curvePath(contours, closed) {
      const view = contours.map(contour => S.placeContour(contour, place, 0, bottom));
      const d = view.map(contour => S.svgPath(contour) + (closed ? "Z" : "")).join("");
      exactPaths?.set(d, {contours:view, closed});
      return "<path d=\"" + d + "\"";
    }
    const svg = ["<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"" + trim(W * scale, 3) + "mm\" height=\"" + trim(H * scale, 3) + "mm\" viewBox=\"0 0 " + trim(W, 3) + " " + trim(H, 3) + "\">",
      "<title>" + xml(model.doc.name + " — " + side.toLowerCase() + " assembly") + "</title>",
      "<rect width=\"100%\" height=\"100%\" fill=\"#ffffff\"/>"];
    if (model.outline.length) {
      const shape = model.boardShape, outline = shape ? curvePath(S.profileContours(shape), true) + ' fill-rule="evenodd"' : poly(model.outline, true);
      svg.push("<g id=\"board-outline\" fill=\"#f4f4f2\" stroke=\"#000000\" stroke-width=\"0.2\" stroke-linejoin=\"round\">" + outline + "/></g>");
    }
    const pads = [], bodies = [], labels = [];
    let count = 0;
    for (const {item, fp, side: s} of model.parts) {
      if (s !== side) continue;
      count++;
      const shapes = [], {at,turn,mirror} = AtriumGeometryCurves.artworkFrame(item);
      for (const sh of fp.shapes || []) {
        const l = PCB.shapeLayer(item, sh);
        if (sh.kind === "text" || sh.kind === "label") continue;
        if (!/^Mechanical/.test(l) && l !== PCB.overlay(item)) continue;
        const ink = /^Mechanical/.test(l) ? "#000000" : "#6b6b6b", width = /^Mechanical/.test(l) ? .15 : .1;
        if (sh.kind === "circle") {
          const [x,y] = place(at([sh.x, sh.y]));
          shapes.push("<circle cx=\"" + trim(x, 4) + "\" cy=\"" + trim(y, 4) + "\" r=\"" + trim(sh.r, 4) + "\" fill=\"" + (sh.fill ? ink : "none") + "\" stroke=\"" + ink + "\" stroke-width=\"" + width + "\"/>");
          continue;
        }
        const pts = (sh.points || []).map(at);
        if (pts.length < 2) continue;
        const closed = sh.closed || sh.fill;
        const arc = S && A.pathArc(sh), drawing = arc ? curvePath([S.placeContour([arc], at, turn, mirror)], closed) : poly(pts, closed);
        shapes.push(drawing + " fill=\"" + (sh.fill && /^Mechanical/.test(l) ? "#e2e2de" : sh.fill ? ink : "none") + "\" stroke=\"" + ink + "\" stroke-width=\"" + width + "\"/>");
      }
      const padPts = [];
      for (const p of fp.pads || []) {
        const land=L.geometry(p,side);
        if(!land)continue;
        const outline=placeOutline(M.placedProfile(land,item),L.place(land,item).at);
        padPts.push(...outline);
        pads.push(poly(outline, true) + "/>");
      }
      const body = (fp.shapes || []).filter(sh => /^Mechanical/.test(PCB.shapeLayer(item, sh)) && sh.kind !== "text");
      const bodyPts = [];
      for (const sh of body.length ? body : (fp.shapes || []).filter(sh => PCB.shapeLayer(item, sh) === PCB.overlay(item) && sh.kind !== "text")) {
        if (sh.kind === "circle") bodyPts.push(at([sh.x - sh.r, sh.y - sh.r]), at([sh.x + sh.r, sh.y + sh.r]));
        else for (const p of sh.points || []) bodyPts.push(at(p));
      }
      const box = A.bounds(bodyPts.length ? bodyPts : padPts) || [item.x - .5, item.y - .5, item.x + .5, item.y + .5];
      if (!shapes.length) shapes.push(poly([[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]], true) + " fill=\"none\" stroke=\"#000000\" stroke-width=\"0.15\" stroke-dasharray=\"0.5 0.3\"/>");
      bodies.push(...shapes);
      // Not fitted (DNP or the variant): a red cross over the body, as Altium draws it.
      if (model.dnp?.has(item)) bodies.push(poly([[box[0], box[1]], [box[2], box[3]]], false) + " fill=\"none\" stroke=\"#d0281e\" stroke-width=\"0.15\"/>",
        poly([[box[2], box[1]], [box[0], box[3]]], false) + " fill=\"none\" stroke=\"#d0281e\" stroke-width=\"0.15\"/>");
      const bw = box[2] - box[0], bh = box[3] - box[1], vertical = bh > bw * 1.2;
      const along = vertical ? bh : bw, across = vertical ? bw : bh, len = Math.max(1, Array.from(item.ref || "").length);
      const size = Math.max(.35, Math.min(1.6, along / (len * .62), across * .7));
      const cx = trim(X((box[0] + box[2]) / 2) - b[0] + margin, 4), cy = trim((box[1] + box[3]) / 2 - b[1] + margin, 4);
      labels.push("<text x=\"" + cx + "\" y=\"" + cy + "\" font-size=\"" + trim(size, 3) + "\"" + (vertical ? " transform=\"rotate(-90 " + cx + " " + cy + ")\"" : "") + ">" + xml(item.ref || "") + "</text>");
    }
    svg.push("<g id=\"pads\" fill=\"#c9c9c4\" stroke=\"none\">", ...pads, "</g>",
      "<g id=\"components\" stroke-linejoin=\"round\" stroke-linecap=\"round\">", ...bodies, "</g>",
      "<g id=\"designators\" fill=\"#1d4ed8\" font-family=\"Helvetica, Arial, sans-serif\" font-weight=\"600\" text-anchor=\"middle\" dominant-baseline=\"central\">", ...labels, "</g>");
    const ty = H - title + 3.5;
    svg.push("<g id=\"title\" fill=\"#000000\" font-family=\"Helvetica, Arial, sans-serif\">",
      "<text x=\"" + margin + "\" y=\"" + trim(ty, 3) + "\" font-size=\"" + trim(headingSize, 3) + "\" font-weight=\"600\">" + xml(heading) + "</text>",
      "<text x=\"" + margin + "\" y=\"" + trim(ty + 3.2, 3) + "\" font-size=\"" + trim(Math.min(1.6, headingSize * .75), 3) + "\" fill=\"#444444\">" + count + " component" + (count === 1 ? "" : "s") + " · Scale " + scale + ":1" + (dateText ? " · " + xml(dateText) : "") + " · Waffle " + VERSION + "</text>",
      "</g>", "</svg>", "");
    return {content: svg.join("\n"), stats: {components: count}};
  }

  // ---------------------------------------------------------------------------
  // File plan and generation.
  // An output job owns these facts for its captured models. Standalone writers
  // can still build them directly from their caller's current model and options.
  function createPreparation() {
    const catalogues = new WeakMap(), drillLayouts = new WeakMap(), toolTables = new WeakMap(), placements = new WeakMap();
    const boards = new WeakMap();
    let layout, flattened;
    const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
    const variantOf = (project, variant) => globalThis.AtriumVariants ? AtriumVariants.current(project, variant)?.id : variant;
    const provenanceOf = ({provenance}) => Array.isArray(provenance) && !provenance.length ? undefined : provenance;
    const panelKey = (project, selected, {variant, date}) => typeof selected === "string" && (variant == null || typeof variant === "string") ?
      [project, selected, variantOf(project, variant), date.toISOString().slice(0, 10)] : null;
    function panelInputs(project, selected, options) {
      if (provenanceOf(options)) return;
      const key = panelKey(project, selected, options);
      if (!key) return;
      if (!layout || !same(layout.key, key)) layout = {key, value: AtriumPanel.prepare(project, selected, {variant:options.variant,date:options.date})};
      return layout.value;
    }
    return {
      board(project, doc, options, sourceOf) {
        const key = [project, variantOf(project, options.variant), options.strictLayers === true,
          options.omitUnconnectedMidLayerPads === true, provenanceOf(options)];
        let entries = boards.get(doc);
        if (!entries) boards.set(doc, entries = []);
        const found = entries.find(entry => same(entry.key, key));
        if (found) return found.value;
        const trace = sourceOf?.(doc, project.library);
        const fm = AtriumFabOutputs.analyse(project, doc, trace ? {...options,featureSource:trace.featureSource} : options);
        const value = {fm, trace};
        entries.push({key, value});
        return value;
      },
      panelInputs,
      panel(project, selected, options, sourceOf) {
        const inputs = panelKey(project, selected, options), key = inputs && [...inputs, options.omitUnconnectedMidLayerPads === true, provenanceOf(options)];
        if (key && flattened && same(flattened.key, key)) return flattened.value;
        const fm = AtriumPanel.analyse(project, selected, options, panelInputs(project, selected, options));
        const value = {fm, trace:sourceOf?.(fm)};
        if (key) flattened = {key, value};
        return value;
      },
      catalogue(model) {
        if (!catalogues.has(model)) catalogues.set(model, gerberLayers(model));
        return catalogues.get(model);
      },
      drillLayout(model) {
        if (!drillLayouts.has(model)) drillLayouts.set(model, sourceDrillLayout(model));
        return drillLayouts.get(model);
      },
      tools(group, options) {
        let units = toolTables.get(group);
        if (!units) toolTables.set(group, units = new Map());
        const metric = options.drillUnits === "mm";
        if (!units.has(metric)) units.set(metric, drillTools(group, options));
        return units.get(metric);
      },
      placements(model) {
        if (!placements.has(model)) placements.set(model, fittedPlacements(model));
        return placements.get(model);
      }
    };
  }
  function plan(model, options, catalogue, prepared) {
    const o = settle(options), board = stemOf(model, o), files = [];
    for (const l of catalogue ?? prepared?.catalogue(model) ?? gerberLayers(model)) {
      const enabled = o.layers[l.ext] ?? plotByDefault(l);
      if (enabled) files.push({name: board + "." + l.ext, kind: "gerber", layer: l, title: l.title + " (" + l.ext + ")"});
    }
    for (const g of drillGroups(model)) {
      const {name, kind, base} = drillFileName(model, g, o);
      const what = g.backdrill ? "Back-drill from " + g.backdrill : g.laser ? "Microvia laser drill" : (g.plated ? "Plated" : "Non-plated") + " drill";
      files.push({name, kind: "drill", group: g, title: what + (g.region ? " in " + g.region.name : "") + (kind !== base ? " (" + model.stack[g.span[0]] + " – " + model.stack[g.span[1]] + ")" : "") + " · " + g.hits.length + " hit" + (g.hits.length === 1 ? "" : "s")});
    }
    if (o.viaFill) for (const g of viaFillGroups(model)) files.push({name: drillFileName(model, g, o).name, kind: "drill", group: g, title: "Via fill (IPC-4761 plugged or filled vias, " + model.stack[g.span[0]] + " – " + model.stack[g.span[1]] + ") · " + g.hits.length + " hit" + (g.hits.length === 1 ? "" : "s")});
    const sourceDrill = o.drillDrawing || o.drillReport ?
      (prepared ? prepared.drillLayout(model) : sourceDrillLayout(model)) : null;
    if (model.drills.length && o.drillDrawing) files.push({name: board + ".GD1", kind: "drillmap", title: sourceDrill ? "Drill drawing (source tool symbols)" : "Drill drawing (symbols and drill table)"});
    if (model.drills.length && o.drillReport) files.push({name: board + "-DrillReport.txt", kind: "drillreport", title: "Drill report (tools, layer pairs, aspect ratios)"});
    if (o.pnp) files.push(o.pnpStyle === "jlc" ? {name: "CPL-" + board + ".csv", kind: "pnp", title: "Pick and place (JLCPCB CPL, mm)"}
      : {name: "Pick Place for " + board + ".csv", kind: "pnp", title: "Pick and place (" + o.pnpUnits + ")"});
    if (o.assemblyTop) files.push({name: board + "-Assembly-Top.svg", kind: "assembly", side: "Top", title: "Top assembly drawing"});
    if (o.assemblyBottom && model.parts.some(p => p.side === "Bottom")) files.push({name: board + "-Assembly-Bottom.svg", kind: "assembly", side: "Bottom", title: "Bottom assembly drawing"});
    if (o.readme) files.push({name: board + "-Fabrication-Readme.txt", kind: "readme", title: "File list and settings"});
    const seen = new Set();
    for (const f of files) { const k = f.name.toLowerCase(); if (seen.has(k)) throw Error("Two outputs would both be written as " + f.name + "."); seen.add(k); }
    return {options: o, files, sourceDrill};
  }
  const warnings = model => [...model.notes].map(([m, n]) => m + (n > 1 ? " (" + n + " instances)" : ""));
  // Copper and solder mask are always plotted by default: an empty mask file
  // still tells the fabricator that side is fully covered.
  const plotByDefault = l => !l.optIn && (l.count > 0 || l.group === "Copper" || l.group === "Solder mask");
  function readme(model, p) {
    const o = p.options, shared = o.drillOrigin === "shared",
      lines = ["Fabrication outputs for " + model.doc.name, "Generated by Waffle " + VERSION + " on " + isoDate(o.date), "",
      (shared ? "Coordinates: " : "Gerber and pick-and-place coordinates: ") + originText(model, o, 2) + ", viewed from the top, Y up.",
      ...(shared ? [] : ["NC drill coordinates: " + originText(model, drillFrame(o), 2) + ", viewed from the top, Y up."]),
      "Pick and place rotation: degrees counter-clockwise viewed from the top, for both sides (Altium's convention). Bottom-side parts are mirrored about their Y axis; in IPC-7351B's bottom-view convention a bottom part's rotation is (360 - value) mod 360. X is always the top-view X.",
      "Gerber: RS-274X with X2 attributes, " + (o.units === "mm" ? "millimetres" : "inches") + ", format " + o.format + (LEGACY_FORMATS.has(o.format) ? " (legacy low resolution; the Gerber specification asks for 6 decimals)" : "") + ", leading zeros omitted, absolute.",
      ...(o.profileWidth !== DEFAULT_PROFILE_WIDTH && p.files.some(f => f.layer?.key === "outline") ? ["Gerber profile stroke width: " + o.profileWidth + " mm."] : []),
      "Drill: Excellon, " + (o.drillUnits === "mm" ? "metric" : "inch") + ", " + (o.drillFormat === "decimal" ? "decimal-point coordinates" : "format " + o.drillFormat + " with all zeros present") + ".",
      (model.expansionRules && !o.overrideExpansions
        ? "Solder mask and paste expansion: per pad from the design rules and pad overrides. Vias " + (o.tentVias ? "tented" : "opened") + " unless the via sets its own tenting or IPC-4761 type."
        : "Solder mask expansion: " + trim(o.maskExpansion, 4) + " mm" + (model.expansionRules ? " (overrides the design rules)" : "") + ". Vias " + (o.tentVias ? "tented" : "opened") + " unless the via sets its own tenting or IPC-4761 type. Paste expansion: " + trim(o.pasteExpansion, 4) + " mm."),
      "Copper layers (top to bottom): " + model.stack.map(l => PCB.name(l)).join(", ") + ".", ...copperText(model), "", "Files:"];
    for (const f of p.files) if (f.kind !== "readme") lines.push("  " + f.name.padEnd(40) + " " + f.title);
    if (model.flex?.notes?.length) lines.push("", ...model.flex.notes);
    if (model.hdi?.length) lines.push("", "HDI and via construction:", ...model.hdi.map(n => "  - " + n));
    const w = warnings(model);
    if (w.length) { lines.push("", "Notes:"); for (const m of w) lines.push("  - " + m); }
    return lines.join("\r\n") + "\r\n";
  }
  function generate(model, p, file, prepared) {
    if (file.kind === "gerber") return gerber(model, file.layer, p.options);
    if (file.kind === "drill") return drill(model, file.group, p.options, prepared);
    if (file.kind === "drillmap") {
      const layer = drillMapLayer(model, p.options, p.sourceDrill, prepared);
      return {...gerber(model, layer, p.options), stats: {tools: layer.count}};
    }
    if (file.kind === "drillreport") return {content: drillReport(model, p, prepared), stats: {}};
    if (file.kind === "pnp") return pickPlace(model, p.options, prepared);
    if (file.kind === "assembly") return assembly(model, file.side, p.options);
    if (file.kind === "readme") return {content: readme(model, p), stats: {}};
    throw Error("Unknown output " + file.kind);
  }
  // Generate every planned file. Returns {name, files:[{name, content, kind}], warnings, model}.
  // Objects on layers, and holes on drill spans, that the layer stack does not
  // allow: [{kind: "layer", layer, count} | {kind: "drillPair", from, to, count}].
  const layerCheck = (project, requested) => analyse(project, requested).layerIssues;
  function* packageSteps(model, options) {
    const p = plan(model, options), files = [];
    for (const f of p.files) {
      files.push({name: f.name, kind: f.kind, title: f.title, ...generate(model, p, f)});
      yield;
    }
    return {name: stemOf(model, p.options) + "-Fabrication.zip", files, warnings: warnings(model), model, options: p.options};
  }
  function build(project, requested, options) {
    const steps = packageSteps(analyse(project, requested, {strictLayers:options?.strictLayers, provenance:options?.provenance,
      omitUnconnectedMidLayerPads:options?.omitUnconnectedMidLayerPads}), options);
    let r; do { r = steps.next(); } while (!r.done); return r.value;
  }
  function zip(result) {
    if (!globalThis.AtriumZip) throw Error("ZIP support is unavailable in this build.");
    return AtriumZip.create(result.files.map(f => ({name: f.name, data: f.content})), {date: result.options.date});
  }

  // ---------------------------------------------------------------------------
  // Dialog
  const remembered = new WeakMap();
  const originChoices = doc => [["auto", userOrigin(doc) ? "Board origin (Edit > Origin)" : "Board origin, else lower-left corner"],
    ["outline", "Board lower-left corner"], ["absolute", "Design origin (absolute)"]];
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, fn, cls) { const b = el("button", text, cls); b.type = "button"; if (!b.matches(".ui-tab, .ui-segment")) b.classList.add("ui-button"); b.onclick = fn; return b; }
  function select(values, current, label) {
    const s = el("select", null, "ui-field"); s.setAttribute("aria-label", label);
    for (const [v, t] of values) s.add(new Option(t, v));
    s.value = current; return s;
  }
  function row(text, control, hint) {
    const l = el("label", null, "work-row fab-row"); l.append(el("span", text), control);
    if (hint) l.append(el("small", hint));
    return l;
  }
  function number(value, label) {
    const i = el("input", null, "ui-field"); i.type = "number"; i.dataset.numericUnit = "mm"; i.step = "0.0254"; i.min = "-1"; i.max = "1"; i.value = String(value); i.setAttribute("aria-label", label);
    return i;
  }
  function open(ctx) {
    const boards = ctx.project.documents.filter(d => d.kind === "pcb");
    let doc = ctx.doc?.kind === "pcb" ? ctx.doc : boards[0];
    if (!doc) { ctx.info?.("Open a board layout first."); return; }
    const boardOptions = remembered.get(ctx.project) || new Map();
    remembered.set(ctx.project, boardOptions);
    const d = el("dialog", null, "work-dialog ui-dialog fab-dialog"); d.setAttribute("aria-label", "Fabrication outputs");
    // Closing the dialog cancels a fill it is waiting for (a Repour All it started commits nothing) and any download.
    const download = new AbortController();
    d.onclose = () => { choice++; settling?.abort(); download.abort(); d.remove(); }; document.body.append(d);
    const heading = el("h2", "Fabrication outputs"), summary = el("p"), status = el("p", null, "fab-status"), warnList = el("ul", null, "fab-warnings");
    status.setAttribute("role", "status");
    const tabs = el("div", null, "fab-tabs ui-tabs"); tabs.dataset.strip = ""; // the library tab strip
    const panels = el("div", null, "fab-panels");
    tabs.setAttribute("role", "tablist"); tabs.setAttribute("aria-label", "Output settings");
    const foot = el("div", null, "work-actions ui-dialog-actions");
    let model = null, options = null, busy = false, current = "gerber", settling = null, modelVersion = null, choice = 0;
    const panel = {};
    for (const [key, label] of [["gerber", "Gerber"], ["drill", "NC Drill"], ["assembly", "Assembly"], ["files", "Files"]]) {
      const t = button(label, () => show(key), "ui-tab"); t.setAttribute("role", "tab"); t.dataset.tab = key; t.id = "fab-tab-" + key;
      const p = el("section", null, "fab-panel"); p.setAttribute("role", "tabpanel"); p.setAttribute("aria-labelledby", t.id);
      p.id = "fab-panel-" + key; t.setAttribute("aria-controls", p.id);
      tabs.append(t); panels.append(p); panel[key] = {tab: t, body: p};
    }
    function show(key) {
      current = key;
      for (const [k, v] of Object.entries(panel)) {
        const on = k === key;
        v.tab.setAttribute("aria-selected", String(on)); v.tab.tabIndex = on ? 0 : -1;
        v.body.hidden = !on;
      }
      if (key === "files") renderFiles();
    }
    const boardSelect = select(boards.map(b => [b.id, b.name]), doc.id, "Board");
    boardSelect.onchange = () => { choice++; settling?.abort(); settling = null; doc = boards.find(b => b.id === boardSelect.value) || doc; options = null; load(); };
    function version() {
      const v = globalThis.AtriumUndoStore?.documentVersions?.(doc, ctx.project);
      const rev = ctx.revision?.();
      return v || rev != null ? {rev, board: v && [v.floor, v.items, v.outer, v.pours, v.project, v.parameters, v.library, v.assembly].join("/")} : null;
    }
    function sameVersion(a, b) {
      if (!a || !b) return false;
      return a.board != null && b.board != null ? a.board === b.board : a.rev != null && a.rev === b.rev;
    }
    function checkDownload(selected, source) {
      if (!d.open) throw Object.assign(Error("Cancelled."), {name: "AbortError"});
      if (choice !== selected || (ctx.currentProject && ctx.currentProject() !== ctx.project) ||
          !ctx.project.documents.includes(doc) || (source && !sameVersion(source, version()))) {
        throw Error("The design or output settings changed. Download again.");
      }
    }
    // Copper pours out of date or still settling: the analysis leaves them pending (no solve on this
    // thread) while settle() waits for the live repour or runs Repour All with its progress display;
    // the analysis refreshes by itself when the fill lands, and downloads wait for it.
    function load(fill) {
      options ||= {...defaults(), fileStem: defaultStem(ctx.project, doc), ...(boardOptions.get(doc.id) || {})};
      try { model = analyse(ctx.project, doc, {pourFill:fill ? undefined : "defer", omitUnconnectedMidLayerPads:options.omitUnconnectedMidLayerPads}); modelVersion = version(); }
      catch (e) { status.textContent = e.message; model = null; return; }
      render();
      if (model.pours === "pending") ready().catch(() => {});
    }
    function ready() {
      if (model && model.pours !== "pending") return Promise.resolve(model);
      if (settling) return settling.promise;
      const P = globalThis.AtriumPolygonPour, ac = new AbortController(), board = doc;
      status.textContent = "Filling copper pours before making outputs…";
      const progress = p => { if (settling?.ac === ac && p.total) status.textContent = "Filling copper pours: " + p.done + " of " + p.total + "…"; };
      const promise = (P?.settle ? P.settle(board, new Map(ctx.project.library.map(x => [x.id, x])), {project: ctx.project, signal: ac.signal, onProgress: progress}) : Promise.resolve())
        .then(() => {
          if (ac.signal.aborted) throw Object.assign(Error("Cancelled."), {name: "AbortError"});
          settling = null;
          if (board !== doc) return ready();
          status.textContent = "";
          // Whatever is still out of date (a pour Repour All left, another board) is filled on a copy.
          load(true);
          if (!model) throw Error(status.textContent || "The outputs could not be analysed.");
          return model;
        }, e => { if (settling?.ac === ac) { settling = null; if (e?.name !== "AbortError") status.textContent = e.message; } throw e; });
      settling = {ac, promise, abort: () => ac.abort()};
      return promise;
    }
    function remember() { const {date, ...rest} = options; void date; boardOptions.set(doc.id, rest); }
    function render() {
      const holes = model.drills.length, parts = model.parts.length;
      summary.textContent = model.stack.length + " copper layers · " + parts + " component" + (parts === 1 ? "" : "s") + " · " + holes + " drill hit" + (holes === 1 ? "" : "s") +
        (model.pours === "current" ? " · " + model.pourRegions + " pour regions" : model.pours === "pending" ? " · copper pours filling" : "");
      warnList.replaceChildren(...warnings(model).map(m => el("li", m)));
      warnList.hidden = !warnList.childElementCount;
      renderGerber(); renderDrill(); renderAssembly();
      show(current);
    }
    function change(fn) { return e => { choice++; fn(e.target); remember(); status.textContent = ""; }; }
    function renderGerber() {
      const p = panel.gerber.body; p.replaceChildren();
      const units = select([["mm", "Millimetres"], ["in", "Inches"]], options.units, "Gerber units");
      const format = select(GERBER_FORMATS[options.units].map(f => [f, LEGACY_FORMATS.has(f) ? f + " (legacy, low resolution)" : f]), settle({units: options.units, format: options.format}).format, "Gerber format");
      units.onchange = change(t => { options.units = t.value; options.format = GERBER_FORMATS[t.value][0]; renderGerber(); });
      format.onchange = change(t => { options.format = t.value; });
      const origin = select(originChoices(model.doc), options.origin === "user" ? "auto" : options.origin, "Origin");
      origin.onchange = change(t => { options.origin = t.value; });
      const width = el("input", null, "ui-field"); width.type = "number"; width.dataset.numericUnit = "mm"; width.step = "any"; width.min = "0";
      width.setAttribute("aria-label", "Profile stroke width (mm)");
      width.value = Number.isFinite(options.profileWidth) ? String(options.profileWidth) : "";
      width.onchange = change(t => {
        options.profileWidth = t.validity.badInput ? NaN : t.value === "" ? DEFAULT_PROFILE_WIDTH : t.valueAsNumber;
        if (t.value === "" && !t.validity.badInput) t.value = String(DEFAULT_PROFILE_WIDTH);
      });
      const stem = el("input", null, "ui-field"); stem.type = "text"; stem.value = options.fileStem || ""; stem.spellcheck = false; stem.setAttribute("aria-label", "File names");
      stem.placeholder = baseName(model.doc.name);
      stem.onchange = change(t => { options.fileStem = slug(t.value) || defaultStem(ctx.project, doc); t.value = options.fileStem; });
      p.append(row("File names", stem, stem.value ? stem.value + ".GTL, " + stem.value + "-Plated.TXT…" : "Every file starts with this name"),
        row("Units", units), row("Format", format, "Integer:decimal digits"), row("Origin", origin, "Gerber, drill drawing and pick and place. NC Drill follows this by default."),
        row("Profile stroke width (mm)", width, "Width of the line along the board edge and cutouts."));
      if (model.stack.length > 2) {
        const omit = el("input", null, "ui-checkbox"); omit.type = "checkbox"; omit.checked = options.omitUnconnectedMidLayerPads === true;
        omit.onchange = change(t => { options.omitUnconnectedMidLayerPads = t.checked; load(); });
        p.append(row("Omit isolated inner-layer pads", omit, "Applies to verified circular lands of plated through holes and vias."));
      }
      p.append(el("h3", "Layers to plot"));
      const list = el("div", null, "fab-layers");
      for (const l of gerberLayers(model)) {
        const box = el("input", null, "ui-checkbox"); box.type = "checkbox";
        box.checked = options.layers[l.ext] ?? plotByDefault(l);
        box.setAttribute("aria-label", "Plot " + l.title);
        box.onchange = change(t => { options.layers = {...options.layers, [l.ext]: t.checked}; });
        const line = el("label", null, "fab-layer");
        line.append(box, el("span", l.title), el("code", l.ext), el("small", l.count ? l.count + " object" + (l.count === 1 ? "" : "s") : "empty"));
        list.append(line);
      }
      p.append(list, el("h3", "Solder mask and paste"));
      const mask = number(options.maskExpansion, "Solder mask expansion"), paste = number(options.pasteExpansion, "Paste expansion");
      const numeric = (key, input) => change(() => { const v = Number(input.value); if (input.value !== "" && Number.isFinite(v) && Math.abs(v) <= 1) options[key] = v; else status.textContent = "Enter an expansion between -1 and 1 mm."; });
      mask.onchange = numeric("maskExpansion", mask); paste.onchange = numeric("pasteExpansion", paste);
      const tent = el("input", null, "ui-checkbox"); tent.type = "checkbox"; tent.checked = options.tentVias; tent.setAttribute("aria-label", "Tent vias");
      tent.onchange = change(t => { options.tentVias = t.checked; });
      const override = el("input", null, "ui-checkbox"); override.type = "checkbox"; override.checked = !!options.overrideExpansions; override.setAttribute("aria-label", "Override design rule expansions");
      override.onchange = change(t => { options.overrideExpansions = t.checked; });
      if (model.expansionRules) p.append(row("Override rules", override, "Use the values below instead of the Solder Mask and Paste Mask rules. Pad and via overrides still apply."));
      p.append(row("Mask expansion (mm)", mask, model.expansionRules ? "Used where no rule applies, or with Override" : "Common default 0.1016 mm (4 mil)"), row("Tent vias", tent, "No mask openings over vias"), row("Paste expansion (mm)", paste));
      for (const line of copperText(model)) p.append(el("p", line, "fab-hint"));
    }
    function renderDrill() {
      const p = panel.drill.body; p.replaceChildren();
      const units = select([["mm", "Millimetres"], ["in", "Inches"]], options.drillUnits, "Drill units");
      const format = select(DRILL_FORMATS[options.drillUnits].map(f => [f, f === "decimal" ? "Decimal point" : f + ", zeros kept"]), settle(options).drillFormat, "Drill format");
      units.onchange = change(t => { options.drillUnits = t.value; options.drillFormat = "decimal"; renderDrill(); });
      format.onchange = change(t => { options.drillFormat = t.value; });
      const origin = select([["shared", "Use shared origin"], ...originChoices(model.doc)],
        options.drillOrigin === "user" ? "auto" : options.drillOrigin, "NC drill origin");
      origin.onchange = change(t => { options.drillOrigin = t.value; });
      const map = el("input", null, "ui-checkbox"); map.type = "checkbox"; map.checked = options.drillDrawing !== false; map.setAttribute("aria-label", "Drill drawing");
      map.onchange = change(t => { options.drillDrawing = t.checked; });
      const report = el("input", null, "ui-checkbox"); report.type = "checkbox"; report.checked = options.drillReport !== false; report.setAttribute("aria-label", "Drill report");
      report.onchange = change(t => { options.drillReport = t.checked; });
      p.append(row("Units", units), row("Format", format), row("NC drill origin", origin, "Applies to Excellon drill files."),
        row("Drill drawing", map, "Gerber (GD1): a symbol per tool and a drill table"), row("Drill report", report, "Text: tools, layer pairs and aspect ratios"));
      if (viaFillGroups(model).length) {
        const fill = el("input", null, "ui-checkbox"); fill.type = "checkbox"; fill.checked = !!options.viaFill; fill.setAttribute("aria-label", "Via fill files");
        fill.onchange = change(t => { options.viaFill = t.checked; });
        p.append(row("Via fill files", fill, "Extra drill files listing plugged or filled vias (IPC-4761 Type III-VII) for the fill program"));
      }
      const groups = drillGroups(model);
      p.append(el("h3", "Drill files"));
      if (!groups.length) p.append(el("p", "This board has no drilled holes.", "fab-hint"));
      const temp = settle(options);
      for (const g of groups) {
        let r;
        try { r = drill(model, g, temp); } catch (e) { p.append(el("p", e.message, "fab-alert")); break; }
        const box = el("div", null, "fab-drill");
        box.append(el("strong", (g.plated ? "Plated" : "Non-plated") + " · " + model.stack[g.span[0]] + " to " + model.stack[g.span[1]]),
          el("small", r.tools.map(t => t.code + " " + trim(t.size, 4) + (temp.drillUnits === "mm" ? " mm" : " in") + " × " + t.hits).join(" · ")));
        p.append(box);
      }
      p.append(el("p", "Plated and non-plated holes are written to separate files (<board>-Plated.TXT, <board>-NonPlated.TXT). Blind and buried vias get a file per layer pair.", "fab-hint"));
    }
    function renderAssembly() {
      const p = panel.assembly.body; p.replaceChildren();
      const pnp = el("input", null, "ui-checkbox"); pnp.type = "checkbox"; pnp.checked = options.pnp; pnp.setAttribute("aria-label", "Pick and place file");
      pnp.onchange = change(t => { options.pnp = t.checked; });
      const units = select([["mm", "Millimetres"], ["mil", "Mils"]], options.pnpUnits, "Pick and place units");
      units.onchange = change(t => { options.pnpUnits = t.value; });
      const style = select([["altium", "Altium-style CSV"], ["jlc", "JLCPCB CPL format (mm)"]], options.pnpStyle || "altium", "Pick and place layout");
      style.onchange = change(t => { options.pnpStyle = t.value; });
      const top = el("input", null, "ui-checkbox"); top.type = "checkbox"; top.checked = options.assemblyTop; top.setAttribute("aria-label", "Top assembly drawing");
      top.onchange = change(t => { options.assemblyTop = t.checked; });
      const bottom = el("input", null, "ui-checkbox"); bottom.type = "checkbox"; bottom.checked = options.assemblyBottom; bottom.setAttribute("aria-label", "Bottom assembly drawing");
      bottom.onchange = change(t => { options.assemblyBottom = t.checked; });
      const readmeBox = el("input", null, "ui-checkbox"); readmeBox.type = "checkbox"; readmeBox.checked = options.readme; readmeBox.setAttribute("aria-label", "Readme");
      readmeBox.onchange = change(t => { options.readme = t.checked; });
      const bottoms = model.parts.filter(x => x.side === "Bottom").length;
      p.append(row("Pick and place", pnp, "Altium-style CSV columns, rotation counter-clockwise with Y up"), row("Units", units), row("Layout", style),
        row("Top drawing", top, model.parts.length - bottoms + " components"), row("Bottom drawing", bottom, bottoms ? bottoms + " components, mirrored view" : "No bottom-side components"),
        row("Readme", readmeBox, "File list and settings for the fabricator"));
    }
    function renderFiles() {
      const p = panel.files.body; p.replaceChildren();
      let planned;
      try { planned = plan(model, options); } catch (e) { p.append(el("p", e.message, "fab-alert")); return; }
      const list = el("div", null, "work-list fab-files");
      for (const f of planned.files) {
        const line = el("div", null, "review-line"), names = el("div");
        names.append(el("strong", f.name), el("small", f.title));
        line.append(names, button("Download", () => save(f)));
        list.append(line);
      }
      p.append(list);
    }
    async function translated(fileName) {
      const timing = globalThis.AtriumDiagnostics?.performance?.begin("manufacturing", "build");
      let outcome = "failed";
      try {
        const client = await globalThis.AtriumLazy.need("AtriumTranslatorClient");
        const result = await client.export("fabrication", ctx.project, {...options, documentId:doc.id, fileName,
          provenance:globalThis.AtriumImportReports?.provenance(), signal:download.signal});
        outcome = "completed";
        return result;
      } catch (error) {
        if (download.signal.aborted || error?.name === "AbortError") outcome = "cancelled";
        throw error;
      } finally { timing?.end(outcome); }
    }
    async function save(file) {
      if (busy) return;
      busy = true;
      try {
        const selected = choice;
        await ready();
        const source = modelVersion;
        checkDownload(selected, source);
        const {files} = await translated(file.name);
        checkDownload(selected, source);
        if (await ctx.exportFile(files[0].name, files[0].text, {manufacturing:true})) ctx.info?.("Exported " + files[0].name);
      } catch (e) { if (e?.name !== "AbortError") status.textContent = e.message; }
      finally { busy = false; }
    }
    const all = button("Download all (.zip)", async () => {
      if (busy || !model) return;
      busy = true; all.disabled = true;
      try {
        const selected = choice;
        checkDownload(selected);
        // Live edits may arrive while the modal is open. Refresh only a stale analysis; callers
        // without an editor version fall back to the synchronous fresh build.
        if (!settling && modelVersion && !sameVersion(modelVersion, version())) load();
        if (!model) throw Error(status.textContent || "The outputs could not be analysed.");
        await ready();
        const source = modelVersion, check = () => checkDownload(selected, source);
        check();
        status.textContent = "Generating…";
        const {files, details} = await translated();
        check();
        const bytes = globalThis.AtriumZip.create(files.map(f => ({name:f.name, data:f.text})), {date:new Date(details.options.date)});
        status.textContent = "";
        if (await ctx.exportFile(details.packageName, bytes, {manufacturing:true})) { ctx.info?.("Exported " + details.packageName + " (" + files.length + " files)"); d.close(); }
      } catch (e) { if (e?.name !== "AbortError") status.textContent = e.message; }
      finally { busy = false; all.disabled = false; }
    });
    const step3d = globalThis.AtriumSTEP ? [button("3D STEP…", () => { d.close(); AtriumSTEP.open({...ctx, doc}); })] : [];
    all.dataset.variant = "primary"; all.dataset.uiDefault = "false";
    foot.append(button("Close", () => d.close()), ...step3d, all);
    d.append(heading);
    if (boards.length > 1) d.append(row("Board", boardSelect));
    d.append(summary, warnList, tabs, panels, status, foot);
    show(current);
    load();
    globalThis.AtriumShell.adoptDialog(d, {title: heading, body: panels, actions: foot, initialFocus: boards.length > 1 ? boardSelect : panel[current].tab});
    d.showModal();
  }

  return Object.freeze({open, analyse, plan, build, generate, zip, gerber, drill, createPreparation, prepareDrills, drillGroups, drillTools, drillFunction, drillMapLayer, drillReport, x2Field, layerCheck, pickPlace, assembly, gerberLayers,
    strokeText, padShape, padGeom, expandPad, padOutline, pourStatus, copperText, defaults, settle, glyphs, cutIns,
    plotPad, stepArtwork, tidy, originFor, drillOriginFor, projectCam, originText, warnings, baseName, defaultStem, isoDate, csvCell, specialText, VERSION});
})();
