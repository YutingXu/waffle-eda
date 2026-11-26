"use strict";

if (!globalThis.AtriumPCBAppearance && typeof require === "function") require("../pcb/pcb-appearance.js");
if (!globalThis.AtriumGeometry && typeof require === "function") require("../core/geometry.js");
if (!globalThis.AtriumMaskOpenings && typeof require === "function") require("../pcb/mask-openings.js");
if (!globalThis.AtriumGeometryCurves && typeof require === "function") require("../pcb/resolved-geometry-curves.js");
if (!globalThis.AtriumPCBText && typeof require === "function") require("../pcb/pcb-text.js");
// DFM Check (Tools › DFM Check, and the DFM gate of File › Release…), driven by a fab preset's limits
// (fab-presets.js). Results go to the Messages panel with zoom-to and a suggested fix.
//
//   AtriumDFM.run(doc, defs, limits, {project, checks, cache}) -> {issues, counts, byCheck, ms, notes}
//   AtriumDFM.messages(result, doc)          Messages panel rows
//   AtriumDFM.releaseGate(project, set, check)   a pre-flight check row, or null when no preset applies
//   AtriumDFM.CHECKS                         [{id, title, fix}]
//
// Issues measured against one limit also carry {actual, required, unit?} (the unified checks compare them
// with the DRC rule of the same question and report the stricter one; docs/design/unified-rules-and-checks.md §0.2).
//
// Speed: one pass builds features (copper, holes, mask openings, silk, text) into a uniform-grid
// spatial index; pair checks only visit neighbours within the largest limit. Incremental: features
// and single-object checks are kept per object signature in `cache` (one per board in the app), so a
// re-run after an edit rebuilds only the objects that changed.
//
// Geometry is the board's own: tracks are capsules, pads and vias convex cores grown by a radius
// (as rules.js), text the stroke-text box (pcb-text.js), pours the stored poured regions.
globalThis.AtriumDFM = (() => {
  const EPS = 1e-6, DEG = 180 / Math.PI;
  const CHECKS = Object.freeze([
    {id: "acid", title: "Acid trap", fix: "Open the corner to 90° or more: route with 45° corners, or add a teardrop or fillet where the tracks meet."},
    {id: "sliver", title: "Copper sliver", fix: "Widen the copper or remove it: raise the pour's minimum width or remove necks, and repour."},
    {id: "maskSliver", title: "Solder mask sliver", fix: "Move the opening away from the board edge, or open the mask to the edge."},
    {id: "maskWeb", title: "Solder mask web", fix: "Shrink the mask expansion of these pads, or accept a ganged opening (the fab removes webs below its minimum)."},
    {id: "maskTrace", title: "Trace near mask opening", fix: "Move the track away from the opening, or reduce the pad's mask expansion."},
    {id: "ring", title: "Annular ring", fix: "Enlarge the pad or via land, or use a smaller drill."},
    {id: "silkPad", title: "Silkscreen over exposed copper", fix: "Move the silkscreen away from the pad: the fab clips silkscreen to the mask opening."},
    {id: "drillCopper", title: "Drill to copper", fix: "Move the copper away from the hole, or move the hole."},
    {id: "drillEdge", title: "Drill to board edge", fix: "Move the hole further from the board edge."},
    {id: "holeToHole", title: "Pad hole to hole", fix: "Move the component holes apart."},
    {id: "minHole", title: "Hole size", fix: "Use a drill inside the fab's range (plated and non-plated holes have different minimums)."},
    {id: "slot", title: "Unplated slot", fix: "Widen the cutout or slot to the fab's minimum routed slot width."},
    {id: "thermal", title: "Starved thermal", fix: "Clear the area around the relief, or use more spokes or a direct connection, then repour."},
    {id: "panel", title: "Copper near panel separation", fix: "Keep copper away from V-score lines and mouse-bite tabs, or change the panel separation."},
    {id: "text", title: "Small silkscreen", fix: "Use the fab's minimum text height and stroke width."}
  ]);
  const TITLE = Object.fromEntries(CHECKS.map(c => [c.id, c.title])), FIX = Object.fromEntries(CHECKS.map(c => [c.id, c.fix]));
  const A = () => globalThis.Atrium;
  const M = globalThis.AtriumMaskOpenings, PCB = globalThis.AtriumPCBAppearance;
  const MASK_CHECKS = ["maskWeb", "maskSliver", "maskTrace", "silkPad"];
  const r4 = v => Math.round(v * 1e4) / 1e4;
  const mm = v => r4(v) + " mm";

  // ---------------------------------------------------------------- geometry
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const {orient:cross,inRing:inPolygon,segmentDistance:segSeg,projectPointOnSegment:nearest}=globalThis.AtriumGeometry;
  function inConvex(p, poly) {
    if (poly.length < 3) return false;
    let pos = false, neg = false;
    for (let i = 0; i < poly.length; i++) { const c = cross(poly[i], poly[(i + 1) % poly.length], p); if (c > EPS) pos = true; if (c < -EPS) neg = true; if (pos && neg) return false; }
    return true;
  }
  const edgesOf = core => core.length === 1 ? [[core[0], core[0]]] : core.length === 2 ? [[core[0], core[1]]] : core.map((p, i) => [p, core[(i + 1) % core.length]]);
  // A feature: convex core (point, segment or polygon) grown by r.
  function feat(base, core, r) {
    const [x0,y0,x1,y1] = A().bounds(core)||[Infinity,Infinity,-Infinity,-Infinity];
    const edges = edgesOf(core);
    if (base.holes) for (const hole of base.holes) for (const edge of edgesOf(hole)) edges.push(edge);
    return {...base, core, r, edges, box: [x0 - r, y0 - r, x1 + r, y1 + r]};
  }
  // Edge-to-edge gap (0 when they touch or overlap).
  function gap(a, b) {
    const contains = (f, p) => f.core.length > 2 && (f.nonConvex ? inPolygon(p, f.core) : inConvex(p, f.core)) &&
      !f.holes?.some(hole => inPolygon(p, hole));
    if (contains(a, b.core[0]) || contains(b, a.core[0])) return 0;
    let d = Infinity;
    for (const [p, q] of a.edges) for (const [r, s] of b.edges) { d = Math.min(d, segSeg(p, q, r, s)); if (d <= a.r + b.r) return 0; }
    return Math.max(0, d - a.r - b.r);
  }
  // Build the uniform grid only when a pair check requests its first neighbourhood.
  function grid(features, cell) {
    const key = (x, y) => x + "," + y;
    let map = null;
    function build() {
      map = new Map();
      for (const f of features) {
        const x0 = Math.floor(f.box[0] / cell), y0 = Math.floor(f.box[1] / cell), x1 = Math.floor(f.box[2] / cell), y1 = Math.floor(f.box[3] / cell);
        if ((x1 - x0 + 1) * (y1 - y0 + 1) > 4096) { (map.get("big") || map.set("big", []).get("big")).push(f); continue; }
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = key(x, y); (map.get(k) || map.set(k, []).get(k)).push(f); }
      }
    }
    return {
      near(box, reach) {
        if (!map) build();
        const out = new Set(map.get("big") || []);
        const x0 = Math.floor((box[0] - reach) / cell), y0 = Math.floor((box[1] - reach) / cell), x1 = Math.floor((box[2] + reach) / cell), y1 = Math.floor((box[3] + reach) / cell);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) for (const f of map.get(key(x, y)) || []) out.add(f);
        return out;
      }
    };
  }
  const boxGap = (a, b) => Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3], 0);

  // ---------------------------------------------------------------- layers
  const copperIndex = layer => {
    const i = globalThis.AtriumPCBAppearance.index(layer);
    return i < 0 ? null : i;
  };
  const overlap = (a, b) => a[0] <= b[1] && b[0] <= a[1];
  const SILK = {Silk: "top", "Bottom silk": "bottom"};

  // ---------------------------------------------------------------- features of one object
  // {copper:[], holes:[], openings:[], silk:[], text:[], tracks:[]} for one board item.
  function itemFeatures(item, def, doc, copperKeys) {
    const out = {copper: [], holes: [], openings: [], silk: [], text: [], tracks: []}, id = item.id;
    const cu = (base, core, r) => out.copper.push(feat(base, core, r));
    const PCB = globalThis.AtriumPCBAppearance;
    const pad = (p, parent, padIndex, padCount) => {
      const center = PCB.padCenter(p, parent);
      const layer = PCB.padLayer(parent, p);
      const span = layer === "Multi" ? [0, 127] : [copperIndex(layer) ?? 0, copperIndex(layer) ?? 0];
      const net = parent?.pinNets?.[p.number] ?? p.net ?? "";
      const label = "Pad " + (parent ? (parent.ref || "?") + "-" : "") + (p.number ?? "?");
      const size = Math.min(p.w || 0, p.h || 0), plated = PCB.padPlated(p, parent, layer);
      if (p.drill > 0) out.holes.push({id, label, at: center, core: PCB.padDrillCore(p, parent, center), d: p.drill, plated, via: false, net, span: [0, 127], size,
        ring: plated && p.drill < size ? (size - p.drill) / 2 : null, own: parent ? parent.id + ":" + p.number : id, ...(parent ? {partPad: p, def: parent.def, padIndex, padCount} : null)});
      const base = {id, label, net, span, kind: "pad", own: parent ? parent.id + ":" + p.number : id, component: parent?.ref || null, plated, at: center};
      if (size > 0) {
        const faces = M.padFaces(layer, p.drill, copperIndex(layer) != null);
        if (faces.length) out.openings.push({base, source: p, parent, faces});
      }
      if(p.drill>0&&!plated)return;
      const L=AtriumResolvedLand;
      for(const key of PCB.padPlanes(p,layer,()=>copperKeys)){
        const land=L.geometry(p,key);
        if(!land||land.holeOnly)continue;
        const {at,angle,mirror}=L.place(land,parent),{core,r}=L.core(land,at,angle,mirror);
        const k=key?copperIndex(key):null;
        cu({...base,at,span:k!=null?[k,k]:span,nonConvex:land.shape==="custom"},core,r);
      }
    };
    const track = item.kind === "track", layer = item.layer || (track ? "Top" : null), k = copperIndex(layer);
    if (Array.isArray(item.points) && item.points.length > 1 && (track || item.kind === "graphic" && k != null && item.keepout !== true && !item.fill && item.width > 0)) {
      if (k == null) return out;
      let points;
      try { points = AtriumGeometryCurves.pathPoints(item,.00005); }
      catch (error) {
        if (!(error instanceof RangeError) || error.message !== "Curve point budget exceeded.") throw error;
        return {...out, skippedTrace: "DFM could not measure copper trace " + id + " within its curve point budget."};
      }
      const base = {id, label:track?"Track":"Copper line", net:item.net||"", span:[k,k], kind:"track", width:item.width, layer};
      for (let n=1; n<points.length; n++) cu(base,[points[n-1],points[n]],(item.width||0)/2);
      if (track) out.tracks.push({...base,points,arc:points!==item.points?item.arc:null,closed:points===item.points&&!!item.closed});
    } else if (item.kind === "via") {
      const span = PCB.copperSpan(item) || [0, 127], at = [item.x, item.y];
      const base = {id, label: "Via", net: item.net || "", span, kind: "via", own: id, at};
      cu(base, [at], (item.diameter || 0) / 2);
      if (item.drill > 0) out.holes.push({id, label: "Via", at, d: item.drill, plated: true, via: true, net: item.net || "", span, size: item.diameter || 0, ring: item.diameter > item.drill ? (item.diameter - item.drill) / 2 : null, own: id});
      out.openings.push({base, source: item, faces: M.FACES});
    } else if (item.kind === "pad") pad(item, null);
    else if (item.kind === "graphic" && item.keepout !== true) {
      if (SILK[item.layer]) silkShape(out, item, item.layer, id, "Silkscreen line", null);
    } else if (item.kind === "label" && SILK[item.layer]) text(out, item, SILK[item.layer], null, "Text");
    else if (item.kind === "part" && def?.footprint) {
      const fp=def.footprint, ref=item.ref || "?";
      (fp.pads || []).forEach((p, n, pads) => pad(p, item, n, pads.length));
      for (const s of fp.shapes || []) {
        const layer=PCB.shapeLayer(item,s);
        if (!SILK[layer] || s.keepout || s.cutout) continue;
        if (s.kind === "text") text(out, s, SILK[layer], item, "Text of " + ref);
        else silkShape(out, s, layer, id, "Silkscreen of " + ref, item);
      }
      // The preset checks authored text dimensions. Default references keep the editor's generated size.
      for (const row of PCB.partText(doc,item,def))
        if (row.kind !== "reference" && SILK[row.text.layer]) text(out, {...row.text,id}, SILK[row.text.layer], null, "Text of " + ref);
    }
    return out;
  }
  function silkShape(out, shape, layer, id, label, part) {
    if (shape.keepout || shape.cutout || shape.dimension) return;
    const C=globalThis.AtriumGeometryCurves;
    if (C.artworkPolarity(shape)==="clear") return;
    const transform=part&&C.artworkFrame(part), base={id,label,side:SILK[layer],component:part?.ref || null};
    const project=edge=>{
      const placed=C.placeEdge(edge,transform);
      return placed.kind==="line"?[placed.a,placed.b]:C.flatten([placed],.00005);
    };
    const loop=edges=>edges.flatMap(edge=>project(edge).slice(0,-1));
    const source=shape.layer===layer&&!shape.regionShape?shape:
      {...shape,layer,regionShape:globalThis.AtriumBoardShape?shape.regionShape:null};
    C.artworkInk(source,PCB.shapeStrokeWidth(source), (ink, variant) => {
      if (ink.kind === "stroke") {
        const stroke={...base,width:shape.width||0}, radius=ink.width/2;
        for (const edge of ink.centerline) {
          const points=project(edge);
          for (let i=1;i<points.length;i++) out.silk.push(feat(stroke,[points[i-1],points[i]],radius));
        }
      } else if (variant === "disk") {
        const {center,radius}=ink.islands[0].outer[0];
        out.silk.push(feat(base,[transform?transform.at(center):center],radius));
      } else for (const {outer,holes} of ink.islands) {
        out.silk.push(feat({...base,nonConvex:true,holes:holes.map(loop)},loop(outer),0));
      }
    });
  }
  function text(out, t, side, parent, label) {
    const T = globalThis.AtriumPCBText, {height:size, width:stroke} = T.props(t);
    const corners = T.corners(t, parent ? {frame:parent} : {});
    const f = feat({id: parent?.id || t.id, label: label + (t.text ? " “" + String(t.text).slice(0, 24) + "”" : ""), side, size, stroke, component: parent?.ref || null, text: true}, corners, 0);
    out.text.push(f); out.silk.push(f);
  }
  // Placements can share a footprint. Read its current content once per check, including
  // edits that changed a pad in place and left the definition object's identity intact.
  function footprintFor(id, defs, doc, footprints) {
    const known = footprints.get(id);
    if (known) return known;
    const definition = PCB.readDefinition(defs, id, doc);
    const entry = {definition, signature: definition ? JSON.stringify(definition.footprint || null) : ""};
    footprints.set(id, entry);
    return entry;
  }

  // ---------------------------------------------------------------- the run
  function maskCandidates(board, sources, project) {
    const rules = M.rulesFor(board, project);
    const stack = globalThis.AtriumStackup, saved = stack?.stored(board);
    const layers = saved && new Set(saved.layers.filter(stack.isCopper).map(l => l.key));
    const candidates = [];
    for (const {base, source, parent, faces} of sources) {
      const span = source.kind === "via" && layers && !(layers.has(source.fromLayer) && layers.has(source.toLayer)) ? M.FACES : undefined;
      for (const {mask, land} of M.maskSeeds(source,parent,faces,rules,span)) {
        const {at} = AtriumResolvedLand.place(land,parent);
        candidates.push({base:{...base,at},mask,land:M.placedProfile(land,parent)});
      }
    }
    return {candidates, rules};
  }
  function maskFeatures(candidates, policy, ruleDefault) {
    const openings = [];
    for (const {base, mask, land} of candidates) {
      if (policy.faces?.[mask.face] === false) continue;
      const geom = M.aperture(mask, land, policy, ruleDefault);
      if (!geom || !(geom.w > 0 && geom.h > 0)) continue;
      const {core, r} = M.openingShape(geom, base.at);
      openings.push(feat({...base, side: mask.face.toLowerCase(), via: mask.via, nonConvex: geom.shape === "custom"}, core, r));
    }
    return openings;
  }

  function createCache() { return {items: new Map(), hits: 0, misses: 0}; }
  function run(doc, defs, limits, o) {
    const span = globalThis.AtriumDiagnostics?.performance?.begin("dfm", "check");
    return span ? span.run(inspectBoard, doc, defs, limits, o) : inspectBoard(doc, defs, limits, o);
  }
  function inspectBoard(doc, defs, limits, o = {}) {
    const t0 = Date.now(), L = limits || {}, want = new Set(o.checks || CHECKS.map(c => c.id)), cache = o.cache || createCache();
    const issues = [], notes = [], seen = new Map();
    const skippedTraces=[];
    const add = (check, level, text, id, at, extra = {}) => {
      const where = check === "ring" ? extra.subject.padIndex ?? "" : at ? r4(at[0]) + "," + r4(at[1]) : "";
      const key = check + "|" + id + "|" + where + "|" + (extra.otherId || "") + "|" + (extra.maskSide || "");
      const previous = seen.get(key);
      if (previous) {
        if (extra.outputs) {
          for (const label of extra.outputs) previous.outputs.add(label);
          if (extra.actual < previous.actual) { previous.text = text; previous.actual = extra.actual; }
        }
        return;
      }
      const issue = {check, level, title: TITLE[check], text, fix: FIX[check], id: id || null, at: at || null, ...extra};
      if (extra.outputs) issue.outputs = new Set(extra.outputs);
      seen.set(key, issue);
      issues.push(issue);
    };
    // Features, reusing unchanged objects.
    const F = {copper: [], holes: [], openings: [], silk: [], text: [], tracks: []};
    cache.hits = 0; cache.misses = 0;
    // Slots read the board shape. Thermal reliefs read the stored pours and their connections.
    const needItems = CHECKS.some(c => c.id !== "slot" && c.id !== "thermal" && want.has(c.id));
    const thermal = want.has("thermal") && doc.pcbDrawing?.pours?.some(r => r.polygon != null);
    if ((needItems || thermal) && !(defs instanceof Map)) defs = new Map((o.project?.library || []).map(d => [d.id, d]));
    if (needItems) {
      const live = new Set(), footprints = new Map(), kinds = Object.keys(F);
      const copperKeys=globalThis.AtriumStackup?.copperLayers(doc,defs)||["Top","Bottom"], stackKey=copperKeys.join(",");
      const limKey = want.has("minHole") || want.has("text") || want.has("sliver") ? JSON.stringify(L) : null;
      for (const item of doc.items || []) {
        if (!item?.id) continue;
        live.add(item.id);
        const part = item.kind === "part" ? footprintFor(item.def, defs, doc, footprints) : null;
        const labels = part && PCB.sourceLabelRows(doc,item);
        const sig = JSON.stringify(item) + (part?.signature || "") + (labels ? JSON.stringify(labels) : "") + stackKey;
        let e = cache.items.get(item.id);
        if (!e || e.sig !== sig) { e = {sig, f: itemFeatures(item, part?.definition, doc, copperKeys), single: null, lim: null}; cache.items.set(item.id, e); cache.misses++; } else cache.hits++;
        for (const k of kinds) for (const x of e.f[k]) F[k].push(x);
        if (e.f.skippedTrace && ["acid","sliver","maskTrace","drillCopper","panel"].some(c=>want.has(c))) skippedTraces.push(e.f.skippedTrace);
        if (limKey != null) {
          if (e.lim !== limKey) { e.single = singleChecks(e.f, L); e.lim = limKey; }
          for (const x of e.single) if (want.has(x.check)) add(x.check, x.level, x.text, x.id, x.at, x.extra);
        }
      }
      for (const k of cache.items.keys()) if (!live.has(k)) cache.items.delete(k);
    }
    const outline = Array.isArray(doc.outline) && doc.outline.length >= 3 ? doc.outline : null;
    let cutouts = [];
    const needEdges = want.has("drillEdge") || want.has("maskSliver");
    if (needEdges || want.has("slot")) {
      try { cutouts = (globalThis.AtriumBoardShape?.holes?.(doc) || []).filter(h => h.length >= 3); } catch { cutouts = []; }
    }
    const edges = needEdges && outline ? [outline, ...cutouts].flatMap(ring => ring.map((p, i) => feat({edge: true}, [p, ring[(i + 1) % ring.length]], 0))) : [];
    if (want.has("acid")) acidTraps(F, L, add);
    if (want.has("sliver")) slivers(doc, L, add, notes);
    if (want.has("ring")) ringChecks(F, L, add);
    const copperGrid = grid(F.copper, 2);
    if (want.has("drillCopper") || want.has("drillEdge") || want.has("holeToHole")) drills(F, L, add, copperGrid, edges, want);
    if (o.maskPolicies?.length !== 0 && MASK_CHECKS.some(c => want.has(c)) && F.openings.length) {
      const {candidates, rules} = maskCandidates(doc, F.openings, o.project);
      const boardPolicy = {maskExpansion: L.maskExpansion || 0, tentVias: false};
      for (const policy of o.maskPolicies || [boardPolicy]) {
        const openings = maskFeatures(candidates, policy, policy.outputs ? rules?.defaultExpansion : undefined);
        const openGrid = grid(openings, 2);
        const report = policy.outputs ? (check, level, text, id, at, extra) => add(check, level, text, id, at, {...extra, outputs: policy.outputs}) : add;
        if (want.has("maskWeb") || want.has("maskSliver") || want.has("maskTrace")) mask(openings, L, report, openGrid, copperGrid, edges, want);
        if (want.has("silkPad")) silkOverPads(F.silk, L, report, openGrid, policy.silk);
      }
    }
    if (want.has("slot")) slots(cutouts, L, add);
    if (thermal) thermals(doc, defs, L, add, notes, o);
    if (want.has("panel")) panels(doc, F, L, add, o.project, notes);
    if (!outline) notes.push("The board has no outline: edge, mask sliver and panel checks were skipped.");
    const order = Object.fromEntries(CHECKS.map((c, i) => [c.id, i]));
    issues.sort((a, b) => (a.level === b.level ? 0 : a.level === "error" ? -1 : 1) || order[a.check] - order[b.check]);
    const byCheck = {};
    for (const i of issues) byCheck[i.check] = (byCheck[i.check] || 0) + 1;
    const counts = {error: issues.filter(i => i.level === "error").length, warning: issues.filter(i => i.level === "warning").length};
    return {issues, counts, byCheck, notes:notes.concat(skippedTraces), skippedTraces, ms: Date.now() - t0, reused: cache.hits, rebuilt: cache.misses, preset: L.preset || null, limits: L};
  }

  // Cache every single-object finding under these limits. The caller selects the requested rules.
  function singleChecks(f, L) {
    const out = [], add = (check, level, text, id, at, extra) => out.push({check, level, text, id, at, extra});
    for (const h of f.holes) {
      if (h.plated && h.d + EPS < (L.minHole ?? 0)) add("minHole", "error", h.label + ": plated hole " + mm(h.d) + " is below the " + mm(L.minHole) + " minimum.", h.id, h.at);
      if (!h.plated && h.d + EPS < (L.npthMin ?? 0)) add("minHole", "error", h.label + ": non-plated hole " + mm(h.d) + " is below the " + mm(L.npthMin) + " minimum.", h.id, h.at);
      if (L.maxHole && h.d - EPS > L.maxHole) add("minHole", "error", h.label + ": hole " + mm(h.d) + " is above the " + mm(L.maxHole) + " maximum.", h.id, h.at);
    }
    for (const t of f.text) {
      if (L.silkHeight && t.size + EPS < L.silkHeight) add("text", "warning", t.label + ": height " + mm(t.size) + " is below " + mm(L.silkHeight) + ".", t.id, t.core[0]);
      else if (L.silkWidth && t.stroke + EPS < L.silkWidth) add("text", "warning", t.label + ": stroke " + mm(t.stroke) + " is below " + mm(L.silkWidth) + ".", t.id, t.core[0]);
      else if (L.silkRatio && t.stroke + EPS < t.size / L.silkRatio) add("text", "warning", t.label + ": stroke " + mm(t.stroke) + " is thinner than 1:" + L.silkRatio + " of the height.", t.id, t.core[0]);
    }
    if (L.silkWidth) {
      const thin = f.silk.find(s => !s.text && s.width > 0 && s.width + EPS < L.silkWidth);
      if (thin) add("text", "warning", thin.label + ": line " + mm(thin.width) + " is below " + mm(L.silkWidth) + ".", thin.id, thin.core[0]);
    }
    const sliverMin = Math.min(L.copperSliver ?? Infinity, L.track ?? Infinity);
    for (const c of f.copper) if (c.kind === "track" && c.width > 0 && c.width + EPS < sliverMin) { add("sliver", "error", c.label + ": copper " + mm(c.width) + " wide is below " + mm(sliverMin) + ".", c.id, c.core[0]); break; }
    return out;
  }

  // Acute copper angles where tracks of one layer meet (corners, joins and T-junctions).
  function acidTraps(F, L, add) {
    const limit = L.acidTrapAngle ?? 90, junctions = new Map(), key = p => Math.round(p[0] * 1e4) + "," + Math.round(p[1] * 1e4);
    const tangent = (p, {c}, direction) => Math.atan2(p[1]-c[1],p[0]-c[0])+direction*Math.PI/2;
    const arm = (layer, p, q, id, net, a = Math.atan2(q[1]-p[1],q[0]-p[0])) => {
      const d = dist(p, q);
      if (d < 1e-6) return;
      const k = layer + "|" + key(p);
      let j = junctions.get(k);
      if (!j) junctions.set(k, j = {at: p, arms: [], layer});
      j.arms.push({a, id, net});
    };
    const segs = [];
    for (const t of F.tracks) {
      const pts = t.closed ? [...t.points, t.points[0]] : t.points;
      const {arc} = t, direction = arc?.ccw ? -1 : 1;
      for (let n = 1; n < pts.length; n++) {
        if (!arc||n===1) arm(t.layer,pts[n-1],pts[n],t.id,t.net,arc?tangent(pts[n-1],arc,direction):undefined);
        if (!arc||n===pts.length-1) arm(t.layer,pts[n],pts[n-1],t.id,t.net,arc?tangent(pts[n],arc,-direction):undefined);
        segs.push(feat({id:t.id,layer:t.layer,net:t.net,...(arc?{arc,start:pts[0],end:pts.at(-1)}:null)},[pts[n-1],pts[n]],0));
      }
    }
    // T-junctions: a track end on the inside of another segment.
    const g = grid(segs, 2);
    for (const j of junctions.values()) {
      if (j.arms.length !== 1) continue;
      for (const s of g.near([j.at[0], j.at[1], j.at[0], j.at[1]], 1e-4)) {
        if (s.layer !== j.layer || s.id === j.arms[0].id) continue;
        const [p, q] = s.core;
        if (dist(j.at,nearest(j.at,p,q))>1e-4||dist(j.at,s.start||p)<1e-4||dist(j.at,s.end||q)<1e-4) continue;
        if(s.arc) j.arms.push({a:tangent(j.at,s.arc,1),id:s.id},{a:tangent(j.at,s.arc,-1),id:s.id});
        else j.arms.push({a: Math.atan2(p[1] - j.at[1], p[0] - j.at[0]), id: s.id}, {a: Math.atan2(q[1] - j.at[1], q[0] - j.at[0]), id: s.id});
      }
    }
    for (const j of junctions.values()) {
      if (j.arms.length < 2) continue;
      const as = j.arms.map(x => x.a).sort((a, b) => a - b);
      for (let i = 0; i < as.length; i++) {
        const next = i + 1 < as.length ? as[i + 1] : as[0] + 2 * Math.PI, ang = (next - as[i]) * DEG;
        if (ang > 1 && ang + 1e-6 < limit) {
          add("acid", "warning", "Copper angle of " + Math.round(ang) + "° on " + j.layer + " (below " + limit + "°).", j.arms[0].id, j.at, {actual: ang, required: limit, unit: "°"});
          break;
        }
      }
    }
  }
  // Thin poured copper: the mean width (2 × area / perimeter) of each poured island.
  function slivers(doc, L, add, notes) {
    const P = globalThis.AtriumPCBPours, regs = doc.pcbDrawing?.pours || [], min = Math.min(L.copperSliver ?? Infinity, L.track ?? Infinity);
    if (!regs.length || !Number.isFinite(min)) return;
    if (!P?.contours) { notes.push("Poured copper was not checked for slivers (the pour module is not loaded)."); return; }
    for (const g of regs) {
      let rings;
      try { rings = P.contours(g); } catch { continue; }
      if (!rings?.length) continue;
      let area = 0, per = 0, at = null;
      rings.forEach((r, k) => {
        let a = 0;
        const n = r.length >> 1;
        for (let i = 0, j = n - 1; i < n; j = i++) { a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1]; per += Math.hypot(r[2 * i] - r[2 * j], r[2 * i + 1] - r[2 * j + 1]); }
        area += (k ? -1 : 1) * Math.abs(a) / 2;
        if (!k) at = [r[0], r[1]];
      });
      if (per > 0 && area > 0 && 2 * area / per + EPS < min / 2)
        add("sliver", "warning", "Poured copper on " + (g.layer || "copper") + " averages " + mm(2 * area / per) + " wide (minimum " + mm(min) + ").", g.polygon || null, at);
    }
  }
  // Annular rings: below the fab minimum, and (plated component holes) breaking out at drill tolerance.
  function ringChecks(F, L, add) {
    const tol = (L.drillTolPlus ?? 0) / 2 + (L.holePosition ?? 0);
    for (const h of F.holes) {
      if (!h.plated || h.ring == null) continue;
      const min = h.via ? L.viaRing : L.pthRing;
      const ringError = min != null && h.ring + EPS < min;
      const breakout = !h.via && tol > 0 && h.ring - tol < -EPS;
      if (!ringError && !breakout) continue;
      const subject = {ring: h.ring};
      if (h.partPad) Object.assign(subject, {padIndex: h.padIndex}, A().footprintPadKeys(h.def, h.partPad, h.padIndex, h.padCount));
      if (ringError) add("ring", "error", h.label + ": annular ring " + mm(h.ring) + " is below the " + mm(min) + " " + (h.via ? "via" : "PTH") + " minimum.", h.id, h.at, {actual: h.ring, required: min, subject});
      else add("ring", "warning", h.label + ": the ring " + mm(h.ring) + " breaks out at drill tolerance (+" + mm(L.drillTolPlus) + " oversize, ±" + mm(L.holePosition) + " position).", h.id, h.at, {subject});
    }
  }
  function drills(F, L, add, copperGrid, edges, want) {
    const reach = Math.max(L.viaToTrack || 0, L.pthToTrack || 0, L.npthToTrack || 0, L.innerViaToCopper || 0, L.innerPthToCopper || 0);
    const holeF = h => feat(h, h.core || [h.at], h.d / 2);
    for (const h of F.holes) {
      const hf = holeF(h);
      if (want.has("drillCopper")) {
        let worst = null;
        for (const c of copperGrid.near(hf.box, reach)) {
          if (c.own === h.own || !overlap(c.span, h.span)) continue;
          if (h.plated && h.net && c.net === h.net) continue;
          const inner = c.span[0] > 0 && c.span[1] < 127;
          const need = !h.plated ? L.npthToTrack : h.via ? (inner ? L.innerViaToCopper : L.viaToTrack) : (inner ? L.innerPthToCopper : L.pthToTrack);
          if (!(need > 0) || boxGap(hf.box, c.box) >= need) continue;
          const g = gap(hf, c);
          if (g + EPS < need && (!worst || g < worst.g)) worst = {g, c, need};
        }
        if (worst) add("drillCopper", "error", h.label + " hole to " + worst.c.label + (worst.c.net ? " (" + worst.c.net + ")" : "") + ": " + mm(worst.g) + ", minimum " + mm(worst.need) + ".", h.id, h.at, {otherId: worst.c.id});
      }
      if (want.has("drillEdge") && edges.length && L.holeToEdge > 0) {
        let g = Infinity;
        for (const e of edges) if (boxGap(hf.box, e.box) < L.holeToEdge) g = Math.min(g, gap(hf, e));
        if (g + EPS < L.holeToEdge) add("drillEdge", "warning", h.label + ": hole edge " + mm(g) + " from the board edge (minimum " + mm(L.holeToEdge) + ").", h.id, h.at);
      }
    }
    if (want.has("holeToHole") && L.holeToHolePad > 0) {
      const pads = F.holes.filter(h => !h.via).map((h, i) => ({...holeF(h), n: i})), g = grid(pads, 2);
      for (const a of pads) for (const b of g.near(a.box, L.holeToHolePad)) {
        if (b.n <= a.n || b.own === a.own) continue;
        const d = gap(a, b);
        if (d + EPS < L.holeToHolePad) add("holeToHole", "error", a.label + " ↔ " + b.label + ": holes " + mm(d) + " apart (minimum " + mm(L.holeToHolePad) + ").", a.id, a.at, {otherId: b.id, actual: d, required: L.holeToHolePad});
      }
    }
  }
  function mask(openings, L, add, openGrid, copperGrid, edges, want) {
    if (want.has("maskWeb") && L.maskWeb > 0) {
      const done = new Set();
      for (const o of openings) {
        for (const q of openGrid.near(o.box, L.maskWeb)) {
          if (q === o || q.side !== o.side || q.own === o.own) continue;
          const k = o.side + "|" + (o.own < q.own ? o.own + "|" + q.own : q.own + "|" + o.own);
          if (done.has(k)) continue;
          done.add(k);
          const d = gap(o, q);
          if (d > EPS && d + EPS < L.maskWeb) add("maskWeb", "warning", "Mask web " + mm(d) + " between " + o.label + " and " + q.label + " on the " + o.side + " (minimum " + mm(L.maskWeb) + ").", o.id, o.at, {otherId: q.id, maskSide: o.side, actual: d, required: L.maskWeb});
        }
      }
    }
    if (want.has("maskSliver") && L.maskWeb > 0 && edges.length) for (const o of openings) {
      let d = Infinity;
      for (const e of edges) if (boxGap(o.box, e.box) < L.maskWeb) d = Math.min(d, gap(o, e));
      if (d > EPS && d + EPS < L.maskWeb) add("maskSliver", "warning", "Mask sliver " + mm(d) + " between " + o.label + " and the board edge on the " + o.side + " (minimum " + mm(L.maskWeb) + ").", o.id, o.at, {maskSide: o.side, actual: d, required: L.maskWeb});
    }
    if (want.has("maskTrace") && L.maskToTrace > 0) for (const o of openings) {
      if (o.via) continue;
      const k = o.side === "top" ? 0 : 127;
      for (const c of copperGrid.near(o.box, L.maskToTrace)) {
        if (c.kind !== "track" || c.span[0] !== k || c.net && c.net === o.net) continue;
        const d = gap(o, c);
        if (d + EPS < L.maskToTrace) { add("maskTrace", "warning", c.label + (c.net ? " (" + c.net + ")" : "") + " is " + mm(d) + " from the " + o.side + " mask opening of " + o.label + " (minimum " + mm(L.maskToTrace) + ").", c.id, o.at, {otherId: o.id, maskSide: o.side, actual: d, required: L.maskToTrace}); break; }
      }
    }
  }
  function silkOverPads(silks, L, add, openGrid, sides) {
    const need = L.silkToPad || 0, done = new Set();
    for (const s of silks) {
      if (sides?.[s.side] === false) continue;
      for (const o of openGrid.near(s.box, need)) {
        if (o.side !== s.side) continue;
        const k = s.side + "|" + s.id + "|" + o.own;
        if (done.has(k)) continue;
        const d = gap(s, o);
        if (d + EPS >= need) continue;
        done.add(k);
        add("silkPad", "warning", s.label + (d <= EPS ? " overlaps the mask opening of " + o.label + ": it will be clipped." : " is " + mm(d) + " from the mask opening of " + o.label + " (minimum " + mm(need) + ")."), s.id, s.core[0], {otherId: o.id, actual: d, required: need, maskSide: o.side});
      }
    }
  }
  // Routed cutouts narrower than the minimum non-plated slot.
  function slots(cutouts, L, add) {
    if (!(L.npthSlotMin > 0)) return;
    for (const ring of cutouts) {
      let w = Infinity;
      const n = ring.length;
      for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++) {
        if (i === 0 && j === n - 1) continue;
        const d = segSeg(ring[i], ring[(i + 1) % n], ring[j], ring[(j + 1) % n]);
        if (d < w) w = d;
      }
      if (n === 4) { const a = dist(ring[0], ring[1]), b = dist(ring[1], ring[2]); w = Math.min(w, a, b); }
      if (w + EPS < L.npthSlotMin) add("slot", "error", "Board cutout " + mm(w) + " wide is below the " + mm(L.npthSlotMin) + " minimum unplated slot.", null, ring[0]);
    }
  }
  function thermals(doc, defs, L, add, notes, o) {
    const P = globalThis.AtriumPolygonPour;
    if (!P?.thermals) { notes.push("Thermal reliefs were not checked (the polygon pour module is not loaded)."); return; }
    let list = [];
    try { list = P.thermals(doc, defs, {project: o.project}); } catch (e) { notes.push("Thermal reliefs were not checked: " + e.message); return; }
    const need = L.thermalSpokes || 2;
    for (const t of list) {
      const min = Math.min(Math.max(t.minEntries || 0, need), t.entries || need);
      if (t.connected < min) add("thermal", "warning", t.label + (t.net ? " (" + t.net + ")" : "") + " on " + t.layer + ": " + t.connected + " of " + t.entries + " relief spokes reach the pour.", t.id, t.at);
    }
  }
  // Copper near the panel's V-score lines or mouse-bite tabs (panels that place this board).
  function panels(doc, F, L, add, project, notes) {
    const panelsOf = (project?.documents || []).filter(d => d.kind === "panel" && (d.panel?.board === doc.id || Object.values(d.panel?.cells || {}).some(c => c?.board === doc.id)));
    if (!panelsOf.length) return;
    const ol = Array.isArray(doc.outline) && doc.outline.length >= 3 ? doc.outline : null;
    if (!ol) return;
    const xs = ol.map(p => p[0]), ys = ol.map(p => p[1]), b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const lines = [[[b[0], b[1]], [b[2], b[1]]], [[b[2], b[1]], [b[2], b[3]]], [[b[2], b[3]], [b[0], b[3]]], [[b[0], b[3]], [b[0], b[1]]]].map(c => feat({edge: true}, c, 0));
    for (const pd of panelsOf) {
      const v = pd.panel.separation === "vscore", need = v ? L.vScoreClearance : (L.mouseBiteClearance || 0) + ((pd.panel.tabs?.hole || .5) / 2);
      if (!(need > 0)) continue;
      const hit = new Set();
      for (const c of F.copper) {
        if (hit.has(c.own || c.id)) continue;
        let d = Infinity;
        for (const e of lines) if (boxGap(c.box, e.box) < need) d = Math.min(d, gap(c, e));
        if (d + EPS < need) { hit.add(c.own || c.id); add("panel", v ? "error" : "warning", c.label + (c.net ? " (" + c.net + ")" : "") + " is " + mm(d) + " from the " + (v ? "V-score line" : "mouse-bite edge") + " of panel " + (pd.name || pd.id) + " (minimum " + mm(need) + ").", c.id, c.core[0]); }
      }
      if (!v) notes.push("Mouse-bite clearance is checked along the whole board edge of panel " + (pd.name || pd.id) + "; tabs sit on part of it.");
    }
  }

  // ---------------------------------------------------------------- Messages, gate, action
  function messages(result, doc) {
    const rows = result.issues.map(i => ({class: i.level === "error" ? "Error" : "Warning", source: "DFM · " + i.title, document: doc?.name || "", documentId: doc?.id,
      objectId: i.id || undefined, point: i.at || undefined, text: i.text + " Fix: " + i.fix}));
    rows.push({class: "Info", source: "DFM", document: doc?.name || "", text: (result.limits?.name ? "Limits from " + result.limits.name + ". " : "") + result.counts.error + " error" + (result.counts.error === 1 ? "" : "s") + ", " +
      result.counts.warning + " warning" + (result.counts.warning === 1 ? "" : "s") + " in " + result.ms + " ms." + (result.notes.length ? " " + result.notes.join(" ") : "")});
    return rows;
  }
  // Limits for a board: its recorded preset, else the job set's, else the vendor's preset for its copper count.
  function limitsFor(project, doc, set) {
    const FP = globalThis.AtriumFabPresets;
    if (!FP) return null;
    const id = doc?.fabPreset?.id || set?.fabPreset;
    if (id && FP.get(id)) return FP.limits(id);
    const vendor = set?.package?.mode === "vendor" ? set.package.vendor : null;
    if (!vendor) return null;
    let n = 2;
    try { n = globalThis.AtriumStackup?.copperLayers(doc, new Map((project.library || []).map(d => [d.id, d]))).length || 2; } catch { n = 2; }
    const p = FP.list().filter(x => x.vendor === vendor && !x.variant).sort((a, b) => Math.abs(a.layers - n) - Math.abs(b.layers - n))[0];
    return p ? FP.limits(p.id) : null;
  }
  const caches = new Map();
  const cacheFor = doc => { let c = caches.get(doc.id); if (!c) { c = createCache(); caches.set(doc.id, c); if (caches.size > 16) caches.delete(caches.keys().next().value); } return c; };
  function releaseGate(project, set, check) {
    if (set?.gates?.dfm === false) return null;
    const artwork = set?.outputs && globalThis.AtriumOutputJobs?.gerberMaskContext(project, set);
    const boards = (project.documents || []).filter(d => d.kind === "pcb");
    const doc = artwork?.board || (set?.board ? boards.find(d => d.id === set.board) : boards[0]);
    if (!doc) return null;
    const L = limitsFor(project, doc, set);
    if (!L) return null;
    const policies = artwork?.settle();
    const sources = artwork?.panel && policies?.length ?
      new Set(AtriumPanel.layout(project, artwork.panel).instances.map(inst => inst.board)) : new Set([doc]);
    const counts = {error: 0, warning: 0}, items = [];
    function inspect(board, checks) {
      const r = run(board, null, L, {project, checks, cache: cacheFor(board), maskPolicies: sources.has(board) ? policies : []});
      counts.error += r.counts.error;
      counts.warning += r.counts.warning;
      for (const message of r.skippedTraces) { counts.error++; items.push({text:message,level:"fail",target:{doc:board.id}}); }
      for (const i of r.issues) items.push({text: i.title + ": " + i.text + (artwork?.multiple && i.outputs?.size ? " Gerber outputs: " + [...i.outputs].join(", ") + "." : ""),
        level: i.level === "error" ? "fail" : "warn", target: {doc: board.id, id: i.id, at: i.at}});
    }
    inspect(doc);
    for (const board of sources) if (board !== doc) inspect(board, MASK_CHECKS);
    const summary = counts.error ? counts.error + " DFM error" + (counts.error === 1 ? "" : "s") + (counts.warning ? ", " + counts.warning + " warning" + (counts.warning === 1 ? "" : "s") : "") + " against " + L.name + "."
      : counts.warning ? counts.warning + " DFM warning" + (counts.warning === 1 ? "" : "s") + ", no errors (" + L.name + ")." : "No DFM problems against " + L.name + ".";
    return check("dfm", "Manufacturability (DFM)", counts.error ? "fail" : counts.warning ? "warn" : "pass", summary, items, {action: "dfm-check", label: "Open DFM Check"});
  }
  function attach(host) {
    host.registerAction("dfm-check", async () => {
      const doc = host.doc(), project = host.project();
      if (doc?.kind !== "pcb") { host.info("Open a board layout to check it for manufacturing."); return; }
      const FP = globalThis.AtriumFabPresets;
      if (FP) await FP.loadAll().catch(() => {});
      let L = limitsFor(project, doc, null);
      if (!L && FP) {
        const p = FP.list().filter(x => !x.variant).sort((a, b) => Math.abs(a.layers - (host.copperLayers?.()?.length || 2)) - Math.abs(b.layers - (host.copperLayers?.()?.length || 2)))[0];
        if (p) { L = FP.limits(p.id); host.info("No fab preset on this board: checking against " + p.name + " (Design › Fab Preset… sets one)."); }
      }
      if (!L) { host.info("No fab preset is available to check against."); return; }
      const result = run(doc, host.defs(), L, {project, cache: cacheFor(doc)});
      // Problems (checks.js): the issues join the board's problems, origin fab (the Fab sign-off view).
      globalThis.AtriumChecks?.publishDFM?.(doc, result, L.id || doc.fabPreset?.id || null);
      const M = globalThis.AtriumMessages || await globalThis.AtriumLazy?.need("AtriumMessages");
      M?.show(host.messageContext?.() || {project}, {title: "DFM Check · " + (doc.name || "Board"), group: "DFM", messages: messages(result, doc), rerun: () => host.act("dfm-check"), rerunLabel: "Check again", rerunTitle: "Run the DFM check again", focus: false});
      host.info?.("DFM: " + result.counts.error + " errors, " + result.counts.warning + " warnings (" + result.ms + " ms).");
    });
  }
  globalThis.AtriumNavCommon?.ready?.(attach);
  // MCP dfm_check: {document_id, preset?, checks?, limit?}.
  function headless(a, env) {
    const p = env.project(), doc = (p.documents || []).find(d => d.kind === "pcb" && (!a.document_id || d.id === a.document_id || d.name === a.document_id));
    if (!doc) throw Error("No board layout " + (a.document_id || "") + ".");
    const FP = globalThis.AtriumFabPresets;
    const L = a.preset ? FP?.limits(a.preset) : limitsFor(p, doc, null) || (FP && FP.limits(FP.list().filter(x => !x.variant).sort((x, y) => Math.abs(x.layers - 2) - Math.abs(y.layers - 2))[0]?.id));
    if (!L) throw Error(a.preset ? "Unknown fab preset " + a.preset + "." : "No fab preset is loaded.");
    const r = run(doc, null, L, {project: p, checks: a.checks});
    const limit = Math.max(1, Math.min(a.limit || 200, 5000));
    return {document_id: doc.id, preset: L.preset, errors: r.counts.error, warnings: r.counts.warning, by_check: r.byCheck, notes: r.notes, ms: r.ms,
      issues: r.issues.slice(0, limit).map(i => ({check: i.check, level: i.level, text: i.text, fix: i.fix, id: i.id, at: i.at})), truncated: r.issues.length > limit};
  }
  return Object.freeze({CHECKS, run, messages, releaseGate, limitsFor, createCache, headless, attach, geometry: Object.freeze({gap, feat, segSeg})});
})();
