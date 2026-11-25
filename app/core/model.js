"use strict";
globalThis.Atrium = (() => {
  if (!globalThis.AtriumUUID && typeof require === "function") require("./uuid-v7.js");
  let allocateId = globalThis.AtriumUUID.next;
  const id = () => allocateId();
  // An original source file need not identify every object. While reading an immutable
  // revision, fresh Waffle IDs must reproduce within that snapshot and differ across
  // snapshots. Its ordinals therefore cannot establish identity across a source edit.
  function withRevisionIds(digest, read) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw Error("Invalid history snapshot digest.");
    const previous = allocateId, prefix = "history-" + digest + "-";
    let sequence = 0;
    allocateId = () => prefix + (++sequence).toString(36);
    try { return read(); } finally { allocateId = previous; }
  }
  const clone = value => JSON.parse(JSON.stringify(value));
  // Corner radius of a roundrect as a fraction of its shorter side.
  const padCornerRatio = p => Number.isFinite(p?.roundrectRadiusRatio) ? Math.max(0,Math.min(.5,p.roundrectRadiusRatio)) : .18;
  function padNumericSpec(field) {
    if(field==="angle")return {unit:"deg",period:360,positiveWrap:true};
    if(["w","h","drill"].includes(field))return {unit:"mm",storageUnit:"mm",nanometres:true,min:field==="drill"?0:.001,max:1e7,omitZero:field==="drill"};
  }
  function padDimensions(pad,field,value) {
    const next={...pad,[field]:value};
    const drill=next.drill>0 ? Math.min(next.drill,next.w,next.h) : 0;
    if(drill>0) {next.drill=drill;next.layer="Multi";}
    else if(field==="drill") {delete next.drill;if(next.layer==="Multi")next.layer="Top";}
    return next;
  }
  // Whitespace runs as one space, trimmed. Most text is clean already: tested, not rewritten.
  const clean = v => { const s = String(v ?? ""); return /[^\S ]|  |^ | $/.test(s) ? s.replace(/\s+/g, " ").trim() : s; };
  const upper = v => clean(v).toUpperCase();
  const paramKey = k => upper(k).replace(/[_\s]+/g, " ");
  // Procurement fields by the parameter spellings Altium, KiCad and supplier exports use.
  const FIELD_KEYS = {
    mpn: /^(MPN|MFR\.? ?(PART ?(NUMBER|NO\.?|#)|PN|P\/N)|MANUFACTURER ?(PART ?(NUMBER|NO\.?|#)|PN|P\/N)( ?1)?|MFG ?(PART ?(NUMBER|NO\.?|#)|PN))$/,
    manufacturer: /^(MANUFACTURER( ?1)?|MANUFACTURER NAME|MFR\.?|MFG)$/,
    supplier: /^SUPPLIER( ?1)?$/,
    supplierPn: /^(SUPPLIER ?(PART ?(NUMBER|NO\.?|#)|PN|P\/N)( ?1)?|LCSC( ?(PART ?(NUMBER|NO\.?|#)?|PN|#))?|JLC(PCB)?( ?(PART ?(NUMBER|NO\.?|#)?|PN|#))?)$/
  };
  const fieldOf = params => {
    const out = {mpn: "", manufacturer: "", supplier: "", supplierPn: ""};
    for (const [k, v] of Object.entries(params)) for (const f in FIELD_KEYS) if (!out[f] && v && FIELD_KEYS[f].test(k)) out[f] = v;
    return out;
  };
  // Keep the selected placement ahead of its library defaults, including when
  // the two spell the same purchasing field differently.
  function parameters(item, def) {
    const out = Object.create(null);
    for (const source of [item?.parameters, def?.parameters]) {
      if (!source || typeof source !== "object") continue;
      for (const [k, v] of Object.entries(source)) {
        const key = paramKey(k);
        if (key && !(key in out) && typeof v !== "object") out[key] = clean(v);
      }
    }
    return out;
  }
  // The linked side supplies only fields the selected side did not provide.
  function fallbackParameters(params, fallback) {
    if (fallback) for (const k of Object.keys(fallback)) if (!(k in params)) params[k] = fallback[k];
    return params;
  }
  const partParameters = {clean, upper, paramKey, parameters, fieldOf, FIELD_KEYS, fallbackParameters};
  // Project files keep twelve significant digits for noninteger coordinates below 1e9.
  const projectNumber = n => Number.isInteger(n) || !(Math.abs(n) < 1e9) ? n : Number(n.toPrecision(12));
  const pointKey = p => p.map(n => Math.round(n * 10000)).join(",");
  const same = (a, b) => pointKey(a) === pointKey(b);
  // Snap in integer nanometres when the step is a whole number of them (every mil and
  // metric preset is), so a 1 mil grid yields 0.0254, 0.0508, ... without binary drift.
  // One legal land/drill pair within all applicable ranges. Preserve the preferred drill
  // when possible, then the preferred land. An explicit requested pair is checked unchanged.
  function viaLimits({land,hole,diameter,drill}, bore, annulus) {
    return {diameter,drill,minDiameter:land?.diameterMin,maxDiameter:land?.diameterMax,
      minDrill:Math.max(hole?.holeMin??0,bore?.min??0),maxDrill:Math.min(hole?.holeMax??Infinity,bore?.max??Infinity),ring:annulus?.min??0};
  }
  // Stock sizes are caller defaults. Only a preferred rule supplies an authored size.
  function preferredViaSize(limits,fallback,requested) {
    const preferred=limits[0]??{};
    const drill=requested?.drill??(requested?.diameter!=null?requested.diameter/2:preferred.drill??Math.max(fallback.drill,preferred.minDrill??0));
    const diameter=requested?.diameter??preferred.diameter??(fallback.landGap==null?fallback.diameter:drill+fallback.landGap);
    return viaSize(limits,{diameter,drill},!!requested);
  }
  function viaSize(limits, preferred, fixed = false) {
    const minDiameter = Math.max(0,...limits.map(r => r.minDiameter ?? 0));
    const maxDiameter = Math.min(Infinity,...limits.map(r => r.maxDiameter ?? Infinity));
    const minDrill = Math.max(0,...limits.map(r => r.minDrill ?? 0));
    const maxDrill = Math.min(Infinity,...limits.map(r => r.maxDrill ?? Infinity));
    const ring = Math.max(0,...limits.map(r => r.ring ?? 0));
    let drill = preferred.drill, diameter = preferred.diameter;
    if (!fixed) {
      drill = Math.max(minDrill,Math.min(drill,maxDrill,maxDiameter-2*ring));
      diameter = Math.min(maxDiameter,Math.max(minDiameter,diameter,drill+2*ring));
    }
    const e = 1e-8;
    const legal = drill > 0 && diameter > drill && drill >= minDrill-e && drill <= maxDrill+e &&
      diameter >= minDiameter-e && diameter <= maxDiameter+e && diameter-drill >= 2*ring-e;
    return {diameter,drill,minDiameter,maxDiameter,minDrill,maxDrill,ring,legal};
  }
  function snap(v, step) {
    if (!(step > 0)) return v;
    const nm = Math.round(step * 1e6), n = Math.round(v / step);
    if (nm > 0 && Math.abs(step * 1e6 - nm) <= 1e-6 * Math.max(1, nm) && Math.abs(n * nm) < 9e15) return n * nm / 1e6 + 0;
    return n * step;
  }
  // The model is always millimetres. Units only change what is shown and how bare
  // numbers typed by the user are read; explicit suffixes always win.
  const units = (() => {
    const nmPer = {mm:1e6, mil:25400, in:25400000, um:1000, cm:1e7};
    const alias = {mm:"mm", mil:"mil", mils:"mil", th:"mil", thou:"mil", in:"in", inch:"in", inches:"in", '"':"in", um:"um", "µm":"um", "μm":"um", cm:"cm"};
    const MIL = 0.0254;
    const normal = u => u === "mil" ? "mil" : "mm";
    const toMm = (value, unit = "mm") => Math.round(value * nmPer[alias[unit] || "mm"]) / 1e6 + 0;
    const fromMm = (mm, unit) => normal(unit) === "mil" ? mm / MIL : mm;
    const fixedValue = (mm, unit, digits) => fromMm(mm, unit).toFixed(digits ?? (unit === "mil" ? 3 : 4));
    // Numeric value stays trimmed: mm to 0.1 µm, mil to 0.001 mil.
    const value = (mm, unit, digits) => Number(fixedValue(mm, normal(unit), digits)) + 0;
    function format(mm, unit, digits, {fixed = false} = {}) {
      const u = normal(unit);
      let number = fixedValue(mm, u, digits);
      if (!fixed) number = String(Number(number));
      else if (number[0] === "-" && Number(number) === 0) number = number.slice(1);
      return number + " " + u;
    }
    function parse(text, unit = "mm") {
      const m = String(text ?? "").trim().toLowerCase().match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*(mm|mils?|thou|th|inch(?:es)?|in|"|µm|μm|um|cm)?$/);
      if (!m) return NaN;
      const n = Number(m[1]);
      return Number.isFinite(n) ? toMm(n, alias[m[2]] || normal(unit)) : NaN;
    }
    const lists = {
      pcb: {mil:[1,2,5,10,20,25,50,100], mm:[.01,.025,.05,.1,.25,.5,1,2.5]},
      schematic: {mil:[10,25,50,100], mm:[.25,.5,1,1.27,2.5,2.54]}
    };
    // Limits apply only to newly authored grids.
    const gridLimits = kind => ({min:kind === "pcb" ? .001 : MIL,max:1e7});
    function presets(unit,kind) {
      const family = kind === "schematic" ? kind : "pcb", display = normal(unit), {min,max} = gridLimits(family);
      return lists[family][display].map(n => toMm(n,display)).filter(n => n >= min && n <= max);
    }
    return {MIL, MIN_GRID:MIL, normal, toMm, fromMm, value, format, parse, gridLimits, presets};
  })();
  const rad = a => a * Math.PI / 180;
  function rotate(p, a) {
    const c = Math.cos(rad(a)), s = Math.sin(rad(a));
    return [p[0] * c - p[1] * s, p[0] * s + p[1] * c];
  }
  function world(p, item) {
    // A mirrored schematic part (part.mirror, sch-place.js) flips its local X before rotating.
    const q = rotate(item.mirror ? [-p[0], p[1]] : p, item.angle || 0);
    return [q[0] + item.x, q[1] + item.y];
  }
  function placement(item, paint=false) {
    const angle=rad(item.angle||0),c=Math.cos(angle),s=Math.sin(angle);
    const {x:X,y:Y}=item,mirror=!!item.mirror;
    // Preserve the canvas and native coordinate evaluation orders at rounding boundaries.
    const at=paint
      ? mirror?([x,y])=>[X-x*c-y*s,Y-x*s+y*c]:([x,y])=>[X+x*c-y*s,Y+x*s+y*c]
      : ([x,y])=>{const u=mirror?-x:x;return [u*c-y*s+X,u*s+y*c+Y];};
    return {angle,at,mirror};
  }
  function drillCore(pad, center, angle) {
    const half = (pad.slotLength - pad.drill) / 2;
    if (!(half > 0)) return [center];
    const [x, y] = rotate([half, 0], angle + (pad.slotAngle || 0));
    return [[center[0] - x, center[1] - y], [center[0] + x, center[1] + y]];
  }
  // Circular PCB paths use the Board Shape convention: angles increase CCW in Y-up coordinates.
  // The points are a projection for polygon-only tools, including older versions of the editor.
  function arcSweep(s) {
    const d = (s.ccw ? s.end - s.start : s.start - s.end) % 360;
    return (s.ccw ? 1 : -1) * (d === 0 ? 360 : d < 0 ? d + 360 : d);
  }
  function arcPoint(s, angle) {
    const a = rad(angle);
    return [s.c[0] + s.r * Math.cos(a), s.c[1] - s.r * Math.sin(a)];
  }
  function arcProjection(s, step = 6) {
    const sweep = arcSweep(s), n = Math.max(2, Math.ceil(Math.abs(sweep) / step));
    return Array.from({length: n + 1}, (_, i) => arcPoint(s, s.start + sweep * i / n));
  }
  function transformArc(s, place, rotation = 0, mirrorX = false) {
    const angle = a => (mirrorX ? 180 - a : a) - rotation;
    return {...s, c: place(s.c), start: angle(s.start), end: angle(s.end), ccw: mirrorX ? !s.ccw : s.ccw};
  }
  function pathArc(item) {
    // In older files arc:true annotates a polyline whose stored chords are the physical shape.
    const s = item.arc;
    if (!validPathArc(s) || !item.points || item.points.length < 2) return null;
    // A polygon-only editor may have changed a vertex. Never plot stale copper over its edit.
    // Rotate the radius vector once per vertex, without evaluating trig per sample.
    const a = rad(s.start), step = rad(-arcSweep(s) / (item.points.length - 1));
    const co = Math.cos(step), si = Math.sin(step), tol = 2e-6 + Math.max(Math.abs(s.c[0]), Math.abs(s.c[1]), s.r) * 1e-11;
    let x = s.r * Math.cos(a), y = -s.r * Math.sin(a);
    for (const p of item.points) {
      if (Math.abs(s.c[0] + x - p[0]) > tol || Math.abs(s.c[1] + y - p[1]) > tol) return null;
      const nx = co * x - si * y;
      y = si * x + co * y; x = nx;
    }
    return s;
  }
  function pathLength(item) {
    const g = pathArc(item);
    if (g) return g.r * Math.abs(rad(arcSweep(g)));
    const points = item.points || [];
    let length = 0;
    for (let k=1; k<points.length; k++) length += Math.hypot(points[k][0]-points[k-1][0], points[k][1]-points[k-1][1]);
    if (item.closed && points.length > 1) length += Math.hypot(points[0][0]-points.at(-1)[0], points[0][1]-points.at(-1)[1]);
    return length;
  }
  function nearSegment(p, a, b) {
    const dx = b[0]-a[0], dy = b[1]-a[1];
    const t = Math.max(0, Math.min(1, ((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy || 1)));
    return Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
  }
  // Keep input vertices and winding order stable. Electrical checks require
  // full coverage. Paint recovers slit contours, including touching bridges.
  function triangulateRing(points, area, mode) {
    const paint = mode === "paint", requireCoverage = mode === "complete";
    const equalXY = (a,b) => a[0] === b[0] && a[1] === b[1];
    const sameCorner = paint ? equalXY : (a,b) => a === b;
    if (paint && points.length > 3 && equalXY(points[0], points.at(-1))) points = points.slice(0,-1);
    if (points.length < 3) return requireCoverage ? null : [];
    if (area === undefined) {
      area = 0;
      for (let i = 0; i < points.length; i++) {
        const a = points[i], b = points[(i + 1) % points.length];
        area += a[0] * b[1] - b[0] * a[1];
      }
    }
    // Native GPU coverage uses exact zero in its prior edge-relative turn.
    const turn = paint ? (a,b,c) => (b[0]-a[0])*(c[1]-b[1]) - (b[1]-a[1])*(c[0]-b[0])
      : (a,b,c) => (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0]);
    const reverse = paint ? area < 0 : !(area > 0), tolerance = paint ? 0 : 1e-12;
    const indices = points.map((_,i) => reverse ? points.length-1-i : i), triangles = [];
    let covered = 0;
    while (indices.length > 3) {
      let cut = -1, flat = -1, convex = -1, areaOfEar = 0;
      for (let i = 0; i < indices.length; i++) {
        const a = points[indices[(i+indices.length-1)%indices.length]];
        const b = points[indices[i]], c = points[indices[(i+1)%indices.length]], winding = turn(a,b,c);
        if (winding <= tolerance) {
          if (paint && winding === 0 && flat < 0) flat = i;
          continue;
        }
        if (convex < 0) convex = i;
        let occupied = false;
        for (const j of indices) {
          const p = points[j];
          if (!sameCorner(p,a) && !sameCorner(p,b) && !sameCorner(p,c) &&
              turn(a,b,p)>=0 && turn(b,c,p)>=0 && turn(c,a,p)>=0) {
            occupied = true;
            break;
          }
        }
        if (!occupied) { cut = i; areaOfEar = winding; break; }
      }
      // Paint drops a flat corner or cuts the first convex one if every ear is blocked.
      if (cut < 0 && paint) cut = flat >= 0 ? flat : convex;
      if (cut < 0) return requireCoverage ? null : triangles;
      if (cut !== flat) triangles.push([points[indices[(cut+indices.length-1)%indices.length]],
        points[indices[cut]], points[indices[(cut+1)%indices.length]]]);
      if (requireCoverage) covered += areaOfEar;
      indices.splice(cut,1);
    }
    const last = indices.map(i=>points[i]);
    triangles.push(last);
    if (requireCoverage && !(Math.abs(covered+Math.abs(turn(...last))-Math.abs(area)) <= 1e-9+1e-6*Math.abs(area))) return null;
    return triangles;
  }
  // Merge along shared edges, trying the last eight pieces.
  function mergeConvex(triangles,isConvex){
    const pieces=[];
    next:for(const t of triangles){
      for(let k=pieces.length-1;k>=0&&k>=pieces.length-8;k--){
        const piece=pieces[k];
        for(let i=0;i<piece.length;i++){
          const a=piece[i],b=piece[(i+1)%piece.length];
          for(let j=0;j<3;j++)if(t[j]===b&&t[(j+1)%3]===a){
            const merged=[...piece.slice(0,i+1),t[(j+2)%3],...piece.slice(i+1)];
            if(isConvex(merged)){pieces[k]=merged;continue next;}
            break;
          }
        }
      }
      pieces.push(t.slice());
    }
    return pieces;
  }
  function pathBetween(a, b, pcb = false) {
    const dx = b[0]-a[0], dy = b[1]-a[1], length = Math.min(Math.abs(dx), Math.abs(dy));
    const corner = pcb ? [a[0]+Math.sign(dx)*length, a[1]+Math.sign(dy)*length] : [b[0],a[1]];
    return [a,corner,b].filter((p,i,arr) => !i || !same(p,arr[i-1])).map(p=>[...p]);
  }
  function sheet(kind, name) {
    return {id:id(), kind, name, grid:kind === "pcb" ? 0.25 : 1.27, items:[], outline:[], notes:[]};
  }
  // Tabs and the Projects tree snapshot the ordered labels of both loaded documents and folder references.
  const documentMetadata = documents => documents.map(({id,kind,name,sourceName,missing}) => ({id,kind,name,sourceName,missing}));
  function sameDocumentMetadata(documents, previous) {
    return previous?.length === documents.length && documents.every((d,i) => {
      const p = previous[i];
      return d.id === p.id && d.kind === p.kind && d.name === p.name && d.sourceName === p.sourceName && d.missing === p.missing;
    });
  }
  // Older Altium imports retained the off-sheet marker as artwork on a net label.
  const isOffsheet = i => i.kind === "offsheet" || i.kind === "netlabel" && i.schPaint?.offSheet === true;
  const offsheetAngle = i => (i.angle || 0) - (i.schPaint?.offSheet ? (i.schPaint.direction || 0) * 90 : 0);
  function offsheetIO(value) {
    switch (typeof value === "string" ? value.trim().toLowerCase() : "") {
      case "input": case "in": return "input";
      case "output": case "out": return "output";
      case "bidirectional": case "bidi": case "i/o": case "io": return "bidirectional";
      default: return "unspecified";
    }
  }
  function pristineImportPlaceholder(d){
    const mark=d.importPlaceholder;
    if(!mark||d.sourceName||d.items.length||d.outline.length||d.notes.length)return false;
    if(d.name!==mark.name||d.grid!==mark.grid)return false;
    const known=new Set(["id","kind","name","grid","items","outline","notes","importPlaceholder"]);
    return Object.keys(d).every(k=>known.has(k));
  }
  function preferredDocument(project,kind,activeId){
    const choices=project.documents.filter(d=>d.kind===kind);
    const active=choices.find(d=>d.id===activeId);
    if(active&&!pristineImportPlaceholder(active))return active;
    return choices.find(d=>d.sourceName)||choices.find(d=>d.items.length||d.outline.length)||
      choices.find(d=>!pristineImportPlaceholder(d))||active||choices[0]||null;
  }
  function project(name, library = []) {
    return {format:"atrium",version:1,formatVersion:"1.5",name,library:clone(library),documents:[sheet("schematic","Schematic"),sheet("pcb","Board layout")],id:id()};
  }
  const geometries = (def, kind) => kind === "pcb" ? def?.footprint : def?.symbol;
  // Multi-gate symbols (symbol.parts > 1) and De Morgan views (symbol.alternate): a placed
  // part shows gate item.part (default 1) in its normal or alternate (item.alt) drawing.
  // Pins and shapes without a part (or part 0) belong to every gate; shape.alt true/false
  // keeps a shape to one view. Other geometry is returned unchanged.
  let gateViews = new WeakMap(), gateVersion;
  function gate(g, item) {
    if (!g || !(g.parts > 1 || g.alternate)) return g;
    const store = globalThis.AtriumUndoStore, version = store?.libraryVersion?.();
    if (version !== gateVersion) { gateVersion = version; gateViews = new WeakMap(); }
    const part = item?.unit || item?.part || 1, alt = !!item?.alt, key = part + (alt ? "a" : "n");
    let views = store?.unrecorded?.() ? new Map() : gateViews.get(g);
    if (!views) gateViews.set(g, views = new Map());
    let v = views.get(key);
    if (!v) {
      const inGate = x => !(x.part > 0) || x.part === part;
      v = {...g, pins:(g.pins || []).filter(inGate), shapes:(g.shapes || []).filter(s => inGate(s) && (s.alt == null || !!s.alt === alt))};
      views.set(key, v);
    }
    return v;
  }
  // The designator shown on a gate of a multi-gate part: U1A, U1B, ... (the stored ref stays U1).
  function gateLabel(item, def) {
    const sourceUnit = item?.schPaint?.designatorUnit;
    if (!(def?.symbol?.parts > 1 || Number.isInteger(sourceUnit) && sourceUnit > 0) || !item?.ref || String(item.ref).includes("?")) return item;
    const u = item.unit || item.part || sourceUnit || 1;
    return {...item, ref: item.ref + (u <= 26 ? String.fromCharCode(64 + u) : "#" + u)};
  }
  // Library text ".Designator" and ".Comment" shows the placed part's designator and value.
  function special(s, item) {
    if (s?.kind !== "text" || typeof s.text !== "string" || s.text[0] !== ".") return s;
    const field = s.text.toLowerCase();
    const t = field === ".designator" ? item?.ref : field === ".comment" ? item?.value : null;
    return t ? {...s, text: String(t)} : s;
  }
  // A board string can contain project parameters, including tokens inside a sentence.
  function projectText(project, text) {
    const parameters=project?.parameters;
    if(typeof text!=="string"||!text.includes(".")||!parameters||typeof parameters!=="object")return text;
    const entries=Array.isArray(parameters)?parameters.filter(p=>p&&typeof p.name==="string").map(p=>[p.name,p.value??""]):Object.entries(parameters);
    const values=new Map(entries.filter(([,value])=>value!=null).map(([name,value])=>[name.toLowerCase(),String(value)]));
    return text.replace(/(^|[\s'"(\[{,;:=])\.([A-Za-z_][A-Za-z0-9_]*)/g,(token,lead,name)=>values.has(name.toLowerCase())?lead+values.get(name.toLowerCase()):token);
  }
  // Use the owned native ID when available. Guard a legacy slot against reuse by a changed footprint.
  function footprintPadKeys(def, pad, index, count) {
    const nm = value => value == null ? null : Math.round(value * 1e6);
    const stack = pad.padStack && Object.keys(pad.padStack).sort().map(layer => {
      const land = pad.padStack[layer];
      return [layer, nm(land?.w), nm(land?.h), land?.holeOnly || false];
    });
    const fallback = "pad:" + JSON.stringify([def, index, count, pad.id, String(pad.number ?? ""), pad.layer || "Multi",
      nm(pad.x), nm(pad.y), nm(pad.drill), nm(pad.w), nm(pad.h), nm(pad.slotLength), pad.slotAngle || 0, pad.stackMode, stack]);
    return typeof pad.nativeId === "string" && pad.nativeId && (!pad.nativeIdOwner || pad.nativeIdOwner === def)
      ? {padKey: "pad:" + JSON.stringify([def, pad.nativeId]), padFallback: fallback} : {padKey: fallback};
  }
  function terminalGeometry(terminal) {
    if (!terminal || !Object.hasOwn(terminal, "nativeId")) return terminal;
    const {nativeId, nativeIdOwner, ...geometry} = terminal;
    return geometry;
  }
  function definitionGeometry(definition) {
    const symbol = definition?.symbol, footprint = definition?.footprint;
    const pins = symbol?.pins, pads = footprint?.pads;
    const hasIdentity = terminal => terminal && Object.hasOwn(terminal, "nativeId");
    const symbolChanged = pins?.some(hasIdentity), footprintChanged = pads?.some(hasIdentity);
    if (!symbolChanged && !footprintChanged) return definition;
    return {...definition,
      ...(symbolChanged && {symbol:{...symbol, pins:pins.map(terminalGeometry)}}),
      ...(footprintChanged && {footprint:{...footprint, pads:pads.map(terminalGeometry)}})};
  }
  const pcbMirror = (() => {
    const opposite={Top:"Bottom",Bottom:"Top",Silk:"Bottom silk","Bottom silk":"Silk","Top mask":"Bottom mask","Bottom mask":"Top mask",
      "Top paste":"Bottom paste","Bottom paste":"Top paste","Top Overlay":"Bottom Overlay","Bottom Overlay":"Top Overlay"};
    const angle=a=>((Math.round((a||0)*1e6)/1e6)%360+360)%360 || 0;
    const reflect=p=>[-p[0],p[1]];
    function layer(name,inner=0){
      if(name==null)return name;
      if(Object.hasOwn(opposite,name))return opposite[name];
      const match=/^Inner (\d+)$/.exec(name);
      return match && inner>0 && +match[1]<=inner ? "Inner "+(inner+1-+match[1]) : name;
    }
    function padArtwork(p,inner){
      const out={...p};
      if(Array.isArray(p.poly))out.poly=p.poly.map(reflect);
      if(Array.isArray(p.pasteApertures))out.pasteApertures=p.pasteApertures.map(q=>Number.isFinite(q?.x)?{...q,x:-q.x}:q);
      if(p.padStack)out.padStack=Object.fromEntries(Object.entries(p.padStack).map(([k,row])=>[layer(k,inner),row?{
        ...row,...(Number.isFinite(row.x)&&{x:-row.x}),...(Number.isFinite(row.angle)&&{angle:angle(-row.angle)}),
        ...(Array.isArray(row.poly)&&{poly:row.poly.map(reflect)})
      }:row]));
      return out;
    }
    const rotatedSlot=p=>p.slotLength>p.drill && Number.isFinite(p.slotAngle) && p.slotAngle!==0;
    function pad(p,inner=0,legacy=false){
      const out={...p,x:-(p.x||0),angle:angle(-(p.angle||0))};
      if(!legacy && rotatedSlot(p))out.slotAngle=-p.slotAngle;
      for(const k of ["layer","fromLayer","toLayer"])if(p[k]!=null)out[k]=layer(p[k],inner);
      return legacy?out:padArtwork(out,inner);
    }
    function shape(s,inner=0){
      const out={...s};
      if(s.layer!=null)out.layer=layer(s.layer,inner);
      if(Array.isArray(s.points)){
        out.points=s.points.map(reflect);
        if(s.arc?.kind==="arc")out.arc=transformArc(s.arc,reflect,0,true);
      }
      if(s.x!=null)out.x=-s.x;
      if(s.kind==="text"){
        out.angle=angle(-(s.angle||0));
        if(typeof s.mirrored==="boolean")out.mirrored=!s.mirrored;
      }
      return out;
    }
    function footprint(fp,inner=0,legacy=false){
      return fp && {...clone(fp),pads:(fp.pads||[]).map(p=>pad(p,inner,legacy)),shapes:(fp.shapes||[]).map(s=>shape(s,inner))};
    }
    return {layer,pad,padArtwork,rotatedSlot,shape,footprint};
  })();
  function pins(item, def, kind) {
    const g = gate(geometries(def, kind), item);
    return (g?.pins || g?.pads || []).map(p => ({...p,at:world([p.x,p.y],item)}));
  }
  function terminalId(owner, pin, number, occurrence) {
    return owner + "/" + (pin.id || number + (occurrence ? "/" + occurrence : ""));
  }
  function similarProperties(reference, criteria) {
    const tests = reference.filter(({key}) => criteria[key] && criteria[key] !== "any");
    return read => tests.every(({key,value}) => {
      const other = read(key);
      const same = value === other || typeof value === "number" && typeof other === "number" && Math.abs(value - other) < 1e-6;
      return same === (criteria[key] === "same");
    });
  }
  function symbolPoints(g) {
    const pts = [];
    for (const s of g?.shapes || []) {
      if (s.points) pts.push(...s.points);
      else if (s.kind === "circle") pts.push([s.x-s.r,s.y-s.r],[s.x+s.r,s.y+s.r]);
      else pts.push([s.x,s.y]);
    }
    for (const p of g?.pads || []) {
      for (const corner of [[-1,-1],[1,-1],[1,1],[-1,1]]) pts.push(world([corner[0]*p.w/2,corner[1]*p.h/2],p));
    }
    for (const p of g?.pins || []) pts.push([p.x,p.y]);
    return pts;
  }
  function itemPoints(item, def, kind) {
    if (item.dimension && globalThis.AtriumPCBDraw) return AtriumPCBDraw.dimensionPoints(item);
    if (item.points) return item.points;
    if (item.kind === "part") {
      const pts = symbolPoints(gate(geometries(def,kind),item));
      if (pts.length) return pts.map(p=>world(p,item));
    }
    if (item.kind === "pad" || item.kind === "via") return symbolPoints({pads:[{...item,w:item.w||item.diameter,h:item.h||item.diameter}]});
    if (globalThis.AtriumSchObjects?.KINDS.has(item.kind)) {const b=AtriumSchObjects.box(item);return [[b[0],b[1]],[b[2],b[3]]];}
    return [[item.x,item.y]];
  }
  function bounds(points) {
    let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
    for (const [x,y] of points) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      x0=Math.min(x0,x); y0=Math.min(y0,y); x1=Math.max(x1,x); y1=Math.max(y1,y);
    }
    return x0===Infinity ? null : [x0,y0,x1,y1];
  }
  function docBounds(doc, definitions) {
    const extents=[];
    if (doc.outline?.length) extents.push(...doc.outline);
    for (const item of doc.items) {
      const b = bounds(itemPoints(item, definitions.get(item.def), doc.kind));
      if (b) extents.push([b[0],b[1]],[b[2],b[3]]);
    }
    return bounds(extents) || [-24,-16,24,16];
  }
  function nextRef(proj, prefix) {
    const used = new Set(proj.documents.flatMap(d=>d.items.filter(i=>i.kind==="part").map(i=>i.ref)));
    let n = 1;
    while (used.has(prefix+n)) n++;
    return prefix+n;
  }
  function instantiate(proj,def,p,angle=0,other=null) {
    return {id:id(),kind:"part",def:def.id,ref:other?.ref||nextRef(proj,def.prefix||"U"),value:other?.value??def.value??def.name,
      link:other?.link||id(),x:p[0],y:p[1],angle,pinNets:{}};
  }
  // Unnamed nets on Altium sheets get Altium's name, Net<designator>_<pin> of the lowest designator (NetC1_2), as in the PcbDoc.
  function autoNetName(doc,pins){if(doc?.netNaming!=="first-pin"&&!/\.schdoc$/i.test(doc?.sourceName||""))return "";let b=pins[0];for(const p of pins)if(p[0]<b[0]||p[0]===b[0]&&p[1]<b[1])b=p;return "Net"+b[0]+"_"+b[1];}
  const wireContactTolerance = 0.00011;
  // Wires connect at terminals and explicit junctions. A bare crossing joins neither net.
  function connectivity(doc, defs) {
    const parent = new Map(), coords = new Map(), contacts = [], names = [], wires=[];
    function node(p) {const k=pointKey(p); if(!parent.has(k)){parent.set(k,k);coords.set(k,p);} return k;}
    function root(k) {let r=k;while(parent.get(r)!==r)r=parent.get(r);while(k!==r){const next=parent.get(k);parent.set(k,r);k=next;}return r;}
    function join(a,b) {const x=root(a),y=root(b);if(x!==y)parent.set(y,x);}
    for (const i of doc.items) {
      if (i.kind==="part") for (const pin of pins(i,defs.get(i.def),"schematic")) contacts.push({i,pin,key:node(pin.at)});
      if (i.kind==="wire" && i.points.length>1) {
        const keys=i.points.map(node); for(const k of keys.slice(1))join(keys[0],k);
        wires.push([i,keys[0]]); if(i.net)names.push([keys[0],i.net]);
      }
      if (i.kind==="junction") node([i.x,i.y]);
      if (i.kind==="netlabel" && !globalThis.AtriumSchObjects?.isBus(i.text)) names.push([node([i.x,i.y]),i.text]);
      // Power ports, ports and off-sheet connectors name nets; sheet entries are plain nodes (sch-objects.js).
      if (globalThis.AtriumSchObjects?.KINDS.has(i.kind)) for (const [p,name] of AtriumSchObjects.netSources(i)) {const k=node(p);if(name)names.push([k,name]);}
    }
    // Index connection locations by axis for the common orthogonal case.
    const rows=new Map(),cols=new Map();
    const add=(m,k,v)=>{if(!m.has(k))m.set(k,[]);m.get(k).push(v);};
    for(const [k,p] of coords){add(rows,Math.round(p[1]*10000),[k,p]);add(cols,Math.round(p[0]*10000),[k,p]);}
    for(const [w,k] of wires)for(let n=1;n<w.points.length;n++){
      const a=w.points[n-1],b=w.points[n];
      const candidates=a[1]===b[1]?rows.get(Math.round(a[1]*10000)):a[0]===b[0]?cols.get(Math.round(a[0]*10000)):coords;
      for(const [j,p] of candidates||[])if(nearSegment(p,a,b)<wireContactTolerance)join(k,j);
    }
    const labelRoots=new Map();for(const [k,name] of names){if(labelRoots.has(name))join(k,labelRoots.get(name));else labelRoots.set(name,k);}
    const groups=new Map();
    function group(k){const r=root(k);if(!groups.has(r))groups.set(r,{names:new Set(),pins:[],wires:[]});return groups.get(r);}
    for(const [k,name] of names)group(k).names.add(name);
    for(const c of contacts)group(c.key).pins.push(c);
    for(const [w,k] of wires)group(k).wires.push(w);
    const byPin=new Map(),byWire=new Map(),nets=[];
    for(const g of groups.values()){
      if(g.pins.length<2 && !g.wires.length && !g.names.size)continue;
      const first=g.pins[0];
      const name=[...g.names][0] || (first ? autoNetName(doc,g.pins.map(c=>[c.i.ref,c.pin.number]))||"Net-"+first.i.ref+"-"+first.pin.number : "Net-"+(nets.length+1));
      for(const c of g.pins)byPin.set(c.i.id+"/"+c.pin.number,name);
      for(const w of g.wires)byWire.set(w.id,name);
      nets.push({name,pins:g.pins.length,wires:g.wires.length,conflict:g.names.size>1});
    }
    return {byPin,byWire,nets};
  }
  function sheetEntry(project, doc, defs, host) {
    return globalThis.AtriumUndoStore?.sheetEntry?.(project, doc, defs, host);
  }
  function sheetNets(project, doc, defs, host) {
    const entry = sheetEntry(project, doc, defs, host);
    if (entry) return entry.names ??= globalThis.Atrium.connectivity(doc, defs);
    return globalThis.Atrium.connectivity(doc, defs);
  }
  // Altium keepout restrictions in stored order. Older, unscoped keepouts block all five.
  const keepoutBits={via:1,track:2,copper:4,smdPad:8,throughPad:16};
  const keepoutBlocks=(item,kind)=>item.keepoutRestrictions==null||!!(item.keepoutRestrictions&keepoutBits[kind]);
  // An absolute drag reuses the geometry captured at its mark.
  function moveItem(item,dx,dy,src=item) {
    if(src.points){
      const S=globalThis.AtriumBoardShape,region=S?.regionOf?.(src);
      const move=([x,y])=>[x+dx,y+dy];
      const arc=src.arc,hold=src!==item&&!(dx||dy);
      if(arc?.kind==="arc")item.arc=hold?arc:{...arc,c:move(arc.c)};
      item.points=hold?src.points:src.points.map(move);
      if(region)item.regionShape=hold?region:{...S.translate(region,dx,dy),sig:S.signature(item.points)};
    }
    else {item.x=src.x+dx;item.y=src.y+dy;}
  }
  // Component moves stretch from the authored path. Track wire and point-array
  // identity so a copy or manually redrawn path begins with its own geometry.
  const wireStretches = new WeakMap();
  const copyWirePoints = points => points.map(([x, y]) => [x, y]);
  const exactWirePoints = (a, b) => a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);
  function wireStretchState(wire) {
    const known = wireStretches.get(wire);
    if (known?.points === wire.points && exactWirePoints(wire.points, known.state.path)) return known.state;
  }
  function restoreWireStretch(wire, state) {
    if (state && exactWirePoints(wire.points, state.path)) wireStretches.set(wire, {points:wire.points, state});
    else wireStretches.delete(wire);
  }
  function stretchStop(anchors, end, next) {
    let closest = next, distance = Math.hypot(next[0] - end[0], next[1] - end[1]);
    for (const at of anchors) {
      if (same(at, end) || nearSegment(at, end, next) >= .00011) continue;
      const d = Math.hypot(at[0] - end[0], at[1] - end[1]);
      if (d < distance) { closest = at; distance = d; }
    }
    return closest;
  }
  function wirePathAt(base, anchors, start, end) {
    const a = base[0], b = base.at(-1), moveStart = !same(a, start), moveEnd = !same(b, end);
    if (!moveStart && !moveEnd) return base;
    const first = stretchStop(anchors, a, base[1]), last = stretchStop(anchors, b, base.at(-2));
    const points = [], add = p => { if (!points.length || !same(points.at(-1), p)) points.push(p); };
    const elbow = (p, q, target, stop) => Math.abs(p[1] - q[1]) < .0001 ? [stop[0], target[1]] : [target[0], stop[1]];
    add(moveStart ? start : a);
    if (base.length === 2 && moveStart && moveEnd) {
      if (first !== b || last !== a) {
        add(elbow(a, b, start, first));
        add(first);
        add(last);
        add(elbow(b, a, end, last));
      } else if (!same([start[0] - a[0], start[1] - a[1]], [end[0] - b[0], end[1] - b[1]])) {
        const middle = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        add(elbow(a, b, start, middle));
        add(elbow(b, a, end, middle));
      }
    } else {
      if (moveStart) { add(elbow(a, base[1], start, first)); add(first); }
      base.slice(1, -1).forEach(add);
      if (moveEnd) { add(last); add(elbow(b, base.at(-2), end, last)); }
    }
    add(moveEnd ? end : b);
    if (points.length === 1) points.push(points[0]);
    return points;
  }
  function wireStretch(wire, anchors = [], {spur = false} = {}) {
    const points = wire.points, old = wireStretchState(wire);
    const canReuse = old && anchors.every(at => old.base.some((p, i) => i && nearSegment(at, old.base[i - 1], p) < .00011));
    const base = canReuse ? old.base : copyWirePoints(points), stops = copyWirePoints(anchors);
    spur ||= !!(canReuse && old.spur);
    return {points, spur, apply(start, end) {
      start ??= points[0]; end ??= points.at(-1);
      if (same(start, points[0]) && same(end, points.at(-1))) {
        wire.points = points;
        restoreWireStretch(wire, old);
        return points;
      }
      const path = wirePathAt(base, stops, start, end);
      wire.points = copyWirePoints(path);
      restoreWireStretch(wire, path === base ? undefined : {base, path:copyWirePoints(path), spur});
      return wire.points;
    }};
  }
  // Capture the local electrical contacts before moving a symbol. Current vertices, pins,
  // and explicit dots use the same contact rules as connectivity above.
  function onWireSpan(p, a, b) {
    return (a[1] === b[1] ? Math.round(p[1] * 10000) === Math.round(a[1] * 10000)
      : a[0] !== b[0] || Math.round(p[0] * 10000) === Math.round(a[0] * 10000))
      && nearSegment(p, a, b) < wireContactTolerance;
  }
  const onWirePath = (p, points) => points.some((b, n) => n > 0 && onWireSpan(p, points[n - 1], b));
  function wireArms(p, points) {
    let arms = 0;
    for (let n = 1; n < points.length; n++) {
      const a = points[n - 1], b = points[n];
      if (!same(a, b) && onWireSpan(p, a, b)) arms += Number(!same(a, p)) + Number(!same(b, p));
    }
    return arms;
  }
  function terminalContacts(item, defs) {
    if (item.kind === "part") return pins(item, defs.get(item.def), "schematic").map(p => p.at);
    if (item.kind === "junction" || item.kind === "netlabel" && !globalThis.AtriumSchObjects?.isBus(item.text)) return [[item.x, item.y]];
    return globalThis.AtriumSchObjects?.netSources(item).map(([p]) => p) || [];
  }
  /** @param {SchematicAttachmentOptions & {junctionCopies?: Map<string, JunctionItem>}} [options] */
  function schematicAttachments(doc, defs, terminals, selected, options = {}) {
    const {query, existingOnly = false, junctionCopies} = options;
    const routed = new Map(), dots = [], branches = [];
    /** @param {number[]} box */
    const around = ([x0, y0, x1, y1]) => {
      const ε = wireContactTolerance;
      return query ? query([x0 - ε, y0 - ε, x1 + ε, y1 + ε]) : doc.items;
    };
    const stationary = item => !selected.has(item.id);
    const contacts = new Map();
    const of = item => {
      if (!contacts.has(item)) contacts.set(item, terminalContacts(item, defs));
      return contacts.get(item);
    };
    for (const at of new Map(terminals.map(p => [pointKey(p), p])).values()) {
      const [x, y] = at, local = around([x, y, x, y]).filter(stationary);
      const incident = [], junctions = [];
      let arms = 0, stationaryContact = false;
      for (const item of local) {
        if (item.kind === "wire") {
          const n = wireArms(at, item.points);
          if (n) {incident.push(item); arms += n;}
        } else if (of(item).some(p => same(p, at))) {
          if (item.kind === "junction") junctions.push(item);
          else stationaryContact = true;
        }
      }
      if (arms > 1 || stationaryContact) {
        if (!existingOnly) branches.push({at, fixed: junctions.length ? [junctions[0].x, junctions[0].y] : at, incident});
      } else {
        // A dot at the head of a single outgoing wire belongs to the moving terminal.
        for (const dot of junctions) {
          const copy = junctionCopies ? junctionCopies.get(dot.id) : dot;
          if (copy) dots.push({dot:copy, at, original:[dot.x, dot.y]});
        }
        if (!junctionCopies && incident.length) {
          const wire = incident[0];
          if (!routed.has(wire)) routed.set(wire, {wire, ends: [null, null]});
          const end = same(wire.points[0], at) ? 0 : 1;
          routed.get(wire).ends[end] = at;
        }
      }
    }
    for (const r of routed.values()) {
      const points = r.wire.points, stops = new Map();
      const add = p => {
        if (!r.ends.some(end => end && same(p, end)) && onWirePath(p, points)) stops.set(pointKey(p), p);
      };
      for (const item of around(bounds(points))) if (item !== r.wire && stationary(item)) {
        if (item.kind === "wire") {
          item.points.forEach(add);
          for (const p of points) if (onWirePath(p, item.points)) add(p);
        } else of(item).forEach(add);
      }
      r.session = wireStretch(r.wire, [...stops.values()]);
    }
    const affected = [...routed.keys(), ...dots.map(d => d.dot)];
    return {affected, apply(targetFor) {
      let structural = false;
      for (const {session, ends} of routed.values()) {
        session.apply(ends[0] && targetFor(ends[0]), ends[1] && targetFor(ends[1]));
      }
      for (const {dot, at, original} of dots) {
        const p = targetFor(at);
        [dot.x, dot.y] = p && !same(at, p) ? p : original;
      }
      for (const branch of branches) {
        const {at, fixed, incident} = branch;
        const dest = targetFor(at);
        // A terminal landing back on an original arm already has a connection there.
        const needsLead = dest && !same(dest, at) && !incident.some(w => onWirePath(dest, w.points));
        if (needsLead && !branch.wire) {
          const paint = incident[0]?.schPaint;
          const wire = {id:id(), kind:"wire", points:[fixed, fixed], ...(paint && {schPaint:{...paint}})};
          branch.wire = wire;
          branch.session = wireStretch(wire, [], {spur:true});
          doc.items.push(wire); affected.push(wire);
          structural = true;
        }
        branch.session?.apply(null, needsLead ? dest : null);
      }
      return structural ? null : affected;
    }, finish() {
      const collapsed = new Set();
      for (const r of [...routed.values(), ...branches]) if (r.session?.spur && r.wire.points.every(p => same(p, r.wire.points[0]))) collapsed.add(r.wire);
      if (collapsed.size) {
        let next = 0;
        for (const item of doc.items) if (!collapsed.has(item)) doc.items[next++] = item;
        doc.items.length = next;
      }
      return !!collapsed.size;
    }};
  }
  /** @param {{defs?: Map<string, Definition>, query?: (box: Box) => Item[], junctionCopies?: Map<string, JunctionItem>}} [options] */
  function transformPart(doc, item, def, change, wires, options = {}) {
    const {defs = new Map([[item.def, def]]), query, junctionCopies} = options;
    const before = pins(item, def, doc.kind);
    if (doc.kind !== "schematic") {Object.assign(item, change); return [item];}
    const dotted = junctionCopies && new Set([...junctionCopies.values()].map(dot => pointKey([dot.x, dot.y])));
    const terminals = before.map(p => p.at).filter(at => !dotted || dotted.has(pointKey(at)));
    const edges = !wires || dotted?.size
      ? schematicAttachments(doc, defs, terminals, new Set([item.id]), {query, existingOnly:!!wires, junctionCopies})
      : null;
    Object.assign(item, change);
    const after = pins(item, def, doc.kind);
    const moved = new Map(before.map((p, i) => [pointKey(p.at), after[i].at]));
    if (edges) {
      edges.apply(p => moved.get(pointKey(p)));
      edges.finish();
      if (!wires) return [item, ...edges.affected];
    }
    // Some callers supply detached wire copies or an explicit subset, e.g. a mirror
    // operation that transforms the selection's own wires separately.
    const changed = [item, ...(edges?.affected || [])];
    for (const wire of wires) {
      if (wire.kind !== "wire") continue;
      const old = wire.points, first = moved.get(pointKey(old[0])), last = moved.get(pointKey(old.at(-1)));
      const start = first && !same(first, old[0]) ? first : null;
      const end = last && !same(last, old.at(-1)) ? last : null;
      if (start || end) wireStretch(wire).apply(start, end);
      else if (old.some((p, i) => i && same(p, old[i - 1]))) wire.points = old.filter((p, i) => !i || !same(p, old[i - 1]));
      if (wire.points !== old) changed.push(wire);
    }
    return changed;
  }
  function validOutline(pts) {
    if(!Array.isArray(pts)||pts.length<3)return false;
    let sum=0;
    for(let i=0;i<pts.length;i++){const a=pts[i],b=pts[(i+1)%pts.length];sum+=a[0]*b[1]-a[1]*b[0];}
    return Math.abs(sum)>1e-9;
  }
  const allowedItems=new Set(["part","wire","track","graphic","label","netlabel","junction","via","pad","polygon",
    "power","port","offsheet","sheetsymbol","bus","busentry","noerc","textframe","image","imageMarkup"]);
  const pcbTextJustifications=new Set(["top-left","middle-left","bottom-left","top-center","center","bottom-center","top-right","middle-right","bottom-right"]);
  const xy = v => typeof v==="number" && Number.isFinite(v) && Math.abs(v)<1e8;
  const point = p => Array.isArray(p)&&p.length===2&&p.every(xy);
  const str = s => typeof s==="string";
  const obj = v => v!==null && typeof v==="object" && !Array.isArray(v);
  const notebookKinds = new Set(["richtext", "math", "calculation", "widget", "imageMarkup",
    "notesLayer", "sticky", "callout", "reviewItem", "inkStroke"]);
  function notebookItemKind(item) {
    if (notebookKinds.has(item?.kind)) return item.kind;
    if (item?.kind === "image") return item.asset ? "image" : null;
    if (item?.kind !== "textframe") return null;
    if (item.sticky != null) return "sticky";
    if (item.callout != null) return "callout";
    if (item.ink != null) return "inkStroke";
    if (item.widget != null) return "widget";
    if (item.calculation != null) return "calculation";
    if (item.math === true) return "math";
    return item.richText != null ? "richtext" : null;
  }
  // Sheet image records use integer millionths of the full oriented image.
  // Validation is shared by the renderer, the worker and the headless reader.
  const notebookImage = (() => {
    const MEDIA = new Set(["image/heic","image/heif","image/jpeg","image/png","image/webp","image/svg+xml","image/gif"]);
    const PDF = new Set(["application/pdf"]);
    const uv = n => Number.isInteger(n) && n >= 0 && n <= 1000000;
    const pair = p => Array.isArray(p) && p.length === 2 && p.every(uv);
    function validMark(m) {
      return str(m.imageId) && m.imageId.length>0 && m.imageId.length<=1024 &&
        ["arrow","ellipse","box","highlight","text"].includes(m.shape) && pair(m.at) && pair(m.to) &&
        uv(m.width) && m.width>0 && /^#[0-9a-f]{6}$/i.test(m.colour) &&
        (!m.points || m.shape==="highlight" && Array.isArray(m.points) && m.points.length<=100000 &&
          m.points.every(p=>Array.isArray(p)&&p.length===3&&uv(p[0])&&uv(p[1])&&Number.isInteger(p[2])&&p[2]>=0&&p[2]<=255)) &&
        (m.richText==null || m.shape==="text" && (str(m.richText) && m.richText.length<=4096 ||
          obj(m.richText) && JSON.stringify(m.richText).length<=65536));
    }
    const extentOK = e => Array.isArray(e) && e.length===2 && e.every(n=>Number.isInteger(n)&&n>0&&n<=100000) && e[0]*e[1]<=120000000;
    const regionOK = r => Array.isArray(r) && r.length===4 && r.every(uv) && r[0]<r[2] && r[1]<r[3];
    const refOK = (r,allowed) => !!r && /^[a-f0-9]{64}$/.test(r.sha256) && Number.isSafeInteger(r.byteLength) && r.byteLength>0 && r.byteLength<=256*1048576 && allowed.has(r.mediaType);
    const displayName = s => str(s) && s.length>0 && s.length<=255 && !/[\\/\u0000-\u001f]/.test(s);
    function valid(i) {
      return refOK(i.asset,MEDIA) && displayName(i.name) && (i.extent===undefined || extentOK(i.extent)) && (!i.crop || regionOK(i.crop)) &&
        [i.x,i.y,i.w,i.h].every(Number.isFinite) && i.w>0 && i.h>0 && (i.angle==null||Number.isFinite(i.angle)) &&
        [i.caption,i.alt].every(s=>s==null || str(s) && s.length<=4096) &&
        (!i.clip || i.asset.mediaType==="image/png" && refOK(i.clip.source,PDF) && displayName(i.clip.name) &&
          Number.isInteger(i.clip.page) && i.clip.page>=1 && i.clip.page<=100000 && regionOK(i.clip.region));
    }
    return Object.freeze({MEDIA,valid,validMark,extentOK,regionOK,displayName,refOK});
  })();
  const validPathArc = s => s?.kind === "arc" && point(s.c) && xy(s.r) && s.r > 0 && xy(s.start) && xy(s.end) && typeof s.ccw === "boolean";
  function validInfinitePdfOptions(options,lenient=false){
    if(!obj(options))return true;
    const {infiniteLayout:layout,infiniteScale:scale}=options;
    const known=layout===undefined||["fit","frames","tile"].includes(layout);
    return (known||lenient&&str(layout)&&layout.length<=64)&&(scale===undefined||Number.isFinite(scale)&&scale>0);
  }
  function *validationSteps(p, {normalize=true, scoped=null}={}) {
    // Forward compatibility (docs/format-versioning.md): in a file from a newer version, a value a known
    // field may take there (an enum value, a frame shape kind) is accepted and kept; renderers fall back.
    const lenient=!!(p&&typeof p==="object"&&p.atriumCompat&&(p.atriumCompat.newer||p.atriumCompat.readOnly));
    const invalid=()=>{throw Error("Invalid Waffle editor model.");};
    if(!obj(p)||p.format!=="atrium"||p.version!==1||!str(p.name)||!Array.isArray(p.library)||!Array.isArray(p.documents)||!p.documents.length)invalid();
    if(p.importNotes!=null&&(!Array.isArray(p.importNotes)||!p.importNotes.every(str)))invalid();
    if(p.rules!=null){if(!obj(p.rules))invalid();globalThis.AtriumProjectRules?.validate(p.rules,invalid,lenient);}if(p.ruleSets!=null&&globalThis.AtriumRuleSets)AtriumRuleSets.validateStore(p.ruleSets);
    if(p.signals!=null){if(!obj(p.signals))invalid();globalThis.AtriumSignals?.validate(p.signals,invalid,lenient);}if(normalize)globalThis.AtriumSignals?.attach(p);
    if(p.multichannel!=null){if(typeof p.multichannel!=="object"||Array.isArray(p.multichannel))invalid();globalThis.AtriumMultichannel?.validate(p.multichannel,lenient);}
    if(p.layoutBlocks!=null){if(!Array.isArray(p.layoutBlocks))invalid();if(globalThis.AtriumBlocks)p.layoutBlocks.forEach(b=>AtriumBlocks.validate(b));}
    if(p.outputJobs!=null){
      if(!Array.isArray(p.outputJobs)||p.outputJobs.length>100||!p.outputJobs.every(j=>obj(j)&&str(j.name)&&j.name.trim()&&j.name.length<=80&&Array.isArray(j.outputs)&&j.outputs.length<=64))invalid();
      for(const job of p.outputJobs)if(job.outputs.some(o=>o?.kind==="pdf"&&!validInfinitePdfOptions(o.options,lenient)))invalid();
      if(normalize&&globalThis.AtriumOutputJobs)p.outputJobs.forEach(j=>AtriumOutputJobs.normalise(j));
    }
    if(p.bomViews!=null){if(!Array.isArray(p.bomViews)||p.bomViews.length>200||!p.bomViews.every(v=>obj(v)&&str(v.name)&&v.name.length<=80))invalid();if(normalize&&globalThis.AtriumBOM)p.bomViews.forEach(v=>AtriumBOM.normaliseView(v));}
    // Assembly variants (variants.js): parts keyed by schematic/board link; the existing DNP flag is the base design.
    if(p.variants!=null){if(!Array.isArray(p.variants)||p.variants.length>64||!p.variants.every(v=>obj(v)&&str(v.id)&&str(v.name)))invalid();if(globalThis.AtriumVariants)AtriumVariants.validate(p.variants);}
    if(p.activeVariant!=null&&(!str(p.activeVariant)||p.activeVariant.length>300))invalid();
    // Board revisions (revisions.js, format 1.2): the working revision, frozen snapshots and their content-addressed store.
    if(p.revision!=null||p.revisions!=null||p.revisionStore!=null){if(p.revisions!=null&&!Array.isArray(p.revisions)||p.revisionStore!=null&&!obj(p.revisionStore)||p.revision!=null&&!str(p.revision)&&!obj(p.revision))invalid();globalThis.AtriumRevisions?.validate(p);}
    const ids=new Set(),defs=new Map();
    let count=0;
    if(p.sourceDrillPlots!=null){
      if(!Array.isArray(p.sourceDrillPlots))invalid();
      for(const r of p.sourceDrillPlots){
        if(!obj(r)||!str(r.board)||(r.size!==null&&(!Number.isFinite(r.size)||r.size<=0)))invalid();
        if(++count%128===0)yield;
      }
    }
    function identity(v){if(!obj(v)||!str(v.id)||!v.id||ids.has(v.id))invalid();ids.add(v.id);}
    function pos(v){if(!xy(v.x)||!xy(v.y)||(v.angle!=null&&!xy(v.angle)))invalid();}
    function points(v){if(!Array.isArray(v)||!v.every(point))invalid();}
    // Validate saved Altium geometry even when the drawing and 3D modules are still lazy.
    function futureGeometry(){
      if(normalize&&p.atriumCompat?.readOnly)p.atriumCompat.lossless=false;
    }
    function contour(v, future=false){
      if(!Array.isArray(v)||!v.length||v.length>1e6)invalid();
      for(const g of v){
        if(!obj(g))invalid();
        if(g.kind==="line"){if(!point(g.a)||!point(g.b))invalid();}
        else if(g.kind==="arc"){if(!validPathArc(g))invalid();}
        else if(!future||!str(g.kind)||!g.kind)invalid();
        else futureGeometry();
      }
    }
    function region(v){
      if(!obj(v))invalid();
      // In a newer project the shape renderer uses the saved points if the native contour is unknown.
      if(lenient&&Number.isInteger(v.version)&&v.version>1){futureGeometry();return;}
      if(v.version!==1||!Array.isArray(v.cutouts)||(v.sig!=null&&!str(v.sig)))invalid();
      contour(v.contour,lenient);
      for(const ring of v.cutouts)contour(ring,lenient);
    }
    function keepout(v){
      if(v.keepoutRestrictions!=null&&(!Number.isInteger(v.keepoutRestrictions)||v.keepoutRestrictions<0||v.keepoutRestrictions>31))invalid();
      if(v.planeVoid!=null&&typeof v.planeVoid!=="boolean")invalid();
    }
    function sourceText(v){
      const box=v.sourceTextBox,group=box?.letterSet;
      if(group!=null&&(!Number.isSafeInteger(group)||group<0))invalid();
      if(box?.writingOffset!=null&&!point(box.writingOffset))invalid();
      if(box?.sourceJustify!=null&&!pcbTextJustifications.has(box.sourceJustify)){
        if(!lenient||!str(box.sourceJustify)||!box.sourceJustify.length||box.sourceJustify.length>64)invalid();
        futureGeometry();
      }
    }
    function* encoded(v,cap=Infinity){
      if(!str(v)||!v.length||v.length%4)invalid();
      const end=v.length-(v.endsWith("==")?2:v.endsWith("=")?1:0),bytes=v.length/4*3-(v.length-end);
      if(bytes>cap)invalid();
      for(let i=0;i<end;i+=65536){
        if(/[^A-Za-z0-9+/]/.test(v.slice(i,Math.min(i+65536,end))))invalid();
        if(end>65536)yield;
      }
      return bytes;
    }
    function* letterSets(v){
      if(!Array.isArray(v))invalid();
      for(const table of v){
        if(!obj(table))invalid();
        for(const [ch,row] of Object.entries(table)){
          // Embedded fonts can supply supplementary characters as well as the native BMP records.
          if(!/^(0|[1-9][0-9]{0,6})$/.test(ch)||+ch>0x10ffff||!Array.isArray(row)||row.length!==2||
            !Number.isInteger(row[0])||row[0]<-2147483648||row[0]>2147483647)invalid();
          yield* encoded(row[1]);
          if(++count%128===0)yield;
        }
        if(++count%128===0)yield;
      }
    }
    function* assets(v){
      if(!Array.isArray(v))invalid();
      const byId=new Map(),one=32*1048576;let bytes=0;
      for(const a of v){
        if(!obj(a)||!str(a.id)||!a.id||byId.has(a.id)||!str(a.file))invalid();
        if(a.checksum!=null&&(!Number.isInteger(a.checksum)||a.checksum<0||a.checksum>0xffffffff))invalid();
        if([a.zlib,a.stepText,a.assetId].filter(x=>x!=null).length>1)invalid();
        if(a.assetId!=null&&(!str(a.assetId)||!a.assetId))invalid();
        byId.set(a.id,a);
        if(a.zlib!=null)bytes+=yield* encoded(a.zlib,one);
        if(a.stepText!=null){
          if(!str(a.stepText)||!a.stepText.length||a.stepText.length>one)invalid();
          bytes+=a.stepText.length;
        }
        if(bytes>2*one)invalid();
        if(++count%128===0)yield;
      }
      for(const a of v)if(a.assetId!=null){
        const target=byId.get(a.assetId);
        if(!target||target.zlib==null&&target.stepText==null)invalid();
      }
    }
    function* bodies(v){
      if(!Array.isArray(v))invalid();
      const side=s=>s==="Top"||s==="Bottom";
      for(const b of v){
        if(!obj(b)||!["step","extruded","unsupported"].includes(b.type)||!str(b.layer)||!side(b.side)||!side(b.ownerSide)||
          ![b.sourceRecord,b.identifier,b.modelId].every(str)||(b.modelType!=null&&!str(b.modelType))||(b.shapeRecord!=null&&!str(b.shapeRecord))||
          !point(b.at)||![b.angle,b.dz,b.minZ,b.maxZ].every(xy)||!Array.isArray(b.rotation)||b.rotation.length!==3||!b.rotation.every(xy)||
          !Array.isArray(b.rings)||b.rings.length>257)invalid();
        if(b.color!=null&&(!Number.isInteger(b.color)||b.color<0||b.color>0xffffff))invalid();
        if(b.opacity!=null&&(!xy(b.opacity)||b.opacity<0||b.opacity>1))invalid();
        for(const ring of b.rings){
          if(!Array.isArray(ring)||ring.length<3||ring.length>20000)invalid();
          points(ring);
          if(++count%128===0)yield;
        }
        if(b.contour!=null)contour(b.contour);
        if(++count%128===0)yield;
      }
    }
    function plane(p){
      if(!obj(p.powerPlane)||typeof p.layer!=="string"||!/^Inner /.test(p.layer)||
        !str(p.powerPlane.sourceLayer)||!/^PLANE(?:[1-9]|1[0-6])$/.test(p.powerPlane.sourceLayer))invalid();
      for(const a of [p.powerPlane.pad,p.powerPlane.via])if(a!=null&&
        (!obj(a)||![a.expansion,a.airGap,a.width].every(n=>xy(n)&&n>=0&&n<=1000)||![2,4].includes(a.entries)))invalid();
    }
    function sourceVersion(v){
      if(v===1)return;
      if(!lenient||!Number.isInteger(v)||v<=1)invalid();
      futureGeometry();
    }
    function* bodyGeometry(v){
      if(v.bodyModelVersion!=null)sourceVersion(v.bodyModelVersion);
      if(v.bodyModels!=null)yield* assets(v.bodyModels);
      if(v.bodies3d!=null)yield* bodies(v.bodies3d);
    }
    const drillIndex=n=>Number.isSafeInteger(n)&&n>=0;
    function* drillDrawing(v){
      if(!obj(v)||!Array.isArray(v.tools)||!v.tools.length)invalid();
      for(const t of v.tools){
        if(!obj(t)||(t.mark!==null&&!drillIndex(t.mark))||!Number.isFinite(t.diameter)||t.diameter<=0||
          !Number.isFinite(t.slot)||t.slot<0||!drillIndex(t.hits)||typeof t.plated!=="boolean"||
          (t.slotted!=null&&typeof t.slotted!=="boolean"))invalid();
        if(++count%128===0)yield;
      }
    }
    function schPaint(v){
      if(!obj(v)||(v.size!=null&&(!xy(v.size)||v.size<=0))||(v.angle!=null&&!xy(v.angle)))invalid();
      if(v.type==="port" && (!point(v.offset)||!xy(v.width)||v.width<0||!xy(v.height)||v.height<=0))invalid();
      if(v.type==="power" && (!xy(v.direction)||!xy(v.style)))invalid();
    }
    function sheetDrawing(s){
      if(!obj(s)||!xy(s.width)||s.width<=0||!xy(s.height)||s.height<=0||!xy(s.grid)||s.grid<=0||!Array.isArray(s.frame))invalid();
      for(const art of s.frame){
        if(!obj(art))invalid();
        if(art.kind==="path")points(art.points);
        else if(art.kind==="text"){pos(art);schPaint(art);if(!str(art.text))invalid();}
        else if(!lenient||!str(art.kind))invalid();
      }
    }
    function pinAnnotations(pins){
      if(!Array.isArray(pins))invalid();
      for(const pin of pins){
        if(!obj(pin)||!point(pin.start)||!point(pin.end)||!point(pin.direction)||!str(pin.name)||!str(pin.number))invalid();
        if(pin.nameFont!=null)schPaint(pin.nameFont);if(pin.numberFont!=null)schPaint(pin.numberFont);
        if(pin.nameMargin!=null&&!xy(pin.nameMargin)||pin.numberMargin!=null&&!xy(pin.numberMargin))invalid();
      }
    }
    function itemPaint(v){
      schPaint(v);if(v.ref!=null)schPaint(v.ref);if(v.value!=null)schPaint(v.value);
      if(v.crossReferences!=null){
        if(!Array.isArray(v.crossReferences))invalid();
        for(const c of v.crossReferences){schPaint(c);if(!point(c.at)||!str(c.text)||c.crossReferences!=null)invalid();}
      }
      if(v.parameters!=null){
        if(!obj(v.parameters))invalid();
        for(const p of Object.values(v.parameters)){schPaint(p);if(!point(p.at)||!str(p.text)||(p.caption!=null&&!str(p.caption)))invalid();}
      }
    }
    function* boardLabels(rows){
      if(!Array.isArray(rows))invalid();
      for(const a of rows){
        if(!obj(a) || !(["ref","value"].includes(a.field)||lenient&&str(a.field)&&a.field.length<=64) || !point(a.at) || !xy(a.angle) || !xy(a.size) ||
            a.size<=0 || !str(a.layer) || !a.layer || typeof a.mirrored!=="boolean" ||
            a.upright!=null && typeof a.upright!=="boolean" ||
            a.fontWidth!=null && (!xy(a.fontWidth) || a.fontWidth<=0 || a.fontWidth>=10000))invalid();
        sourceText(a);
        if(++count%128===0)yield;
      }
    }
    function *boardDrawing(d){
      const drawing=d.pcbDrawing;
      if(d.kind!=="pcb" || !obj(drawing) || !obj(drawing.annotations))invalid();
      if(drawing.nativeText!=null&&drawing.nativeText!==true)invalid();
      for(const key in drawing.annotations){
        if(!/^components(?:6)?\/data#\d+$/.test(key))invalid();
        yield* boardLabels(drawing.annotations[key]);
      }
      if(drawing.letterSets!=null)yield* letterSets(drawing.letterSets);
      const validStamp=s=>str(s)&&/^[0-9a-f]{16}$/.test(s);
      if(drawing.sourceHatchSignature!==undefined){
        if(drawing.sourceFill!==true||drawing.pours!==undefined||d.sourcePourSignature!==undefined||!validStamp(drawing.sourceHatchSignature))invalid();
        const sources=new Set(d.items.filter(i=>i?.kind==="polygon").map(i=>i.id));
        if(!d.items.some(i=>i?.kind==="track"&&sources.has(i.sourcePour)))invalid();
        return;
      }
      if(drawing.pours===undefined && d.sourcePourSignature===undefined)return;
      if(!Array.isArray(drawing.pours)||!drawing.pours.length||!validStamp(d.sourcePourSignature))invalid();
      for(const r of drawing.pours){
        if(!obj(r) || !str(r.layer) || !(/^(Top|Bottom|Inner ([1-9]\d?|1[01]\d|12[0-6]))$/.test(r.layer)||lenient&&r.layer.length&&r.layer.length<=64) || !str(r.net) ||
            !Array.isArray(r.bounds) || r.bounds.length!==4 || !r.bounds.every(xy) || r.bounds[0]>r.bounds[2] || r.bounds[1]>r.bounds[3] ||
            !Number.isInteger(r.count) || r.count<1 || r.count>65536 || !str(r.data) || r.data.length%4!==0)invalid();
        // Native records have a 24-bit frame length and 16-bit hole count.
        // Check the base64 envelope without allocating decoded vertex arrays.
        const padding=r.data.endsWith("==")?2:r.data.endsWith("=")?1:0;
        const bytes=r.data.length/4*3-padding,body=r.data.length-padding;
        if(bytes>0xffffff || bytes<r.count*52 || (bytes-r.count*4)%16)invalid();
        for(let i=0;i<body;i+=65536){
          if(/[^A-Za-z0-9+/]/.test(r.data.slice(i,Math.min(body,i+65536))))invalid();
          if(body>65536)yield;
        }
        if(++count%128===0)yield;
      }
    }
    function restoredDrawing(s){
      if(!obj(s)||!obj(s.items)||!obj(s.definitions))invalid();
      sheetDrawing(s.sheet);
      for(const style of Object.values(s.items)){
        if(!obj(style)||style.symbol!=null&&!str(style.symbol)||style.fill!=null&&typeof style.fill!=="boolean"||style.closed!=null&&typeof style.closed!=="boolean")invalid();
        if(style.paint!=null)itemPaint(style.paint);
      }
      for(const style of Object.values(s.definitions)){
        if(!obj(style)||!str(style.fingerprint)||!/^[0-9a-f]{64}$/.test(style.fingerprint)||!Array.isArray(style.shapes))invalid();
        for(const paint of style.shapes)if(paint!=null)schPaint(paint);
        pinAnnotations(style.pins);if(style.pinFont!=null)schPaint(style.pinFont);
      }
    }
    function padOrVia(v){
      if(v.fabTestpoint!=null&&!["Top","Bottom","Both"].includes(v.fabTestpoint))invalid();
      if(v.sourceDrillTool!=null&&!drillIndex(v.sourceDrillTool))invalid();
    }
    function cornerRatio(v){
      if(v!=null&&(!xy(v)||v<0||v>.5))invalid();
    }
    function pad(v){
      pos(v);if(!xy(v.w)||v.w<=0||!xy(v.h)||v.h<=0)invalid();
      padOrVia(v);
      if(v.holeOnly!=null&&(typeof v.holeOnly!=="boolean"||v.holeOnly&&(!xy(v.drill)||v.drill<=0)))invalid();
      if(v.slotLength!=null&&(!xy(v.slotLength)||!xy(v.drill)||v.drill<=0||v.slotLength<v.drill))invalid();
      if(v.slotAngle!=null&&!xy(v.slotAngle))invalid();
      cornerRatio(v.roundrectRadiusRatio);
      if(obj(v.padStack))for(const land of Object.values(v.padStack))cornerRatio(land?.roundrectRadiusRatio);
      if(v.tent!=null&&(!obj(v.tent)||[v.tent.top,v.tent.bottom].some(x=>x!=null&&typeof x!=="boolean")))invalid();
    }
    function shape(s){if(!obj(s))invalid();if(s.schPaint!=null)schPaint(s.schPaint);if(s.width!=null&&(!xy(s.width)||s.width<0))invalid();if(s.kind==="path"){points(s.points);if(!s.points.length)invalid();}
      else if(s.kind==="circle"){pos(s);if(!xy(s.r)||s.r<=0)invalid();}
      else if(s.kind==="text"){pos(s);if(!str(s.text))invalid();}else invalid();}
    if(scoped){
      const needed=new Set();
      for(const [d,items] of scoped)for(const i of items??d.items)if(i.kind==="part")needed.add(i.def);
      if(needed.size)for(const d of p.library){if(needed.delete(d.id))defs.set(d.id,d);if(!needed.size)break;}
    }
    for(const d of scoped?[]:p.library){identity(d);defs.set(d.id,d);if(!str(d.name)||(!d.symbol&&!d.footprint))invalid();if(d.mirrorOf!=null&&!str(d.mirrorOf))invalid();
      for(const g of [d.symbol,d.footprint].filter(Boolean)){
        if(!Array.isArray(g.shapes))invalid();g.shapes.forEach(shape);
      }
      if(d.schDrawing!=null){if(!obj(d.schDrawing))invalid();pinAnnotations(d.schDrawing.pins);if(d.schDrawing.pinFont!=null)schPaint(d.schDrawing.pinFont);}
      if(d.symbol){if(!Array.isArray(d.symbol.pins))invalid();d.symbol.pins.forEach(v=>{pos(v);if(!str(v.number))invalid();});}
      if(d.footprint){
        yield* bodyGeometry(d.footprint);
        for(const s of d.footprint.shapes){
          if(s.arc?.kind==="arc"&&!validPathArc(s.arc))invalid();
          if(s.regionShape!=null){if(s.kind!=="path")invalid();region(s.regionShape);}
          if(s.kind==="text")sourceText(s);
          keepout(s);
        }
        if(!Array.isArray(d.footprint.pads))invalid();d.footprint.pads.forEach(pad);
      }
      if(++count%128===0)yield;
    }
    for(const d of scoped?scoped.keys():p.documents){identity(d);
      const affected=scoped?.get(d);
      if(!affected){
      if(d.kind!=="pcb"&&d.kind!=="schematic"&&d.kind!=="panel"&&d.kind!=="drawing"||!str(d.name)||!xy(d.grid)||d.grid<=0||!Array.isArray(d.items))invalid();
      if(d.kind==="panel"){if(!obj(d.panel)||d.items.length)invalid();if(globalThis.AtriumPanel)try{AtriumPanel.validate(d.panel,lenient);}catch{invalid();}}
      if(d.kind==="drawing"){if(!obj(d.drawing)||d.items.length)invalid();if(globalThis.AtriumDrawing)try{AtriumDrawing.validate(d.drawing);}catch{invalid();}}
      if(d.schDrawing!=null){if(d.kind!=="schematic")invalid();sheetDrawing(d.schDrawing);}
      if(d.schRestored!=null){if(d.kind!=="schematic")invalid();restoredDrawing(d.schRestored);}
      if(d.hopOvers!=null&&(d.kind!=="schematic"||typeof d.hopOvers!=="boolean"))invalid();
      if(d.sheet!=null){
        if(d.kind!=="schematic"&&d.kind!=="drawing")invalid();
        if(d.sheet.infinite!==undefined&&(d.kind!=="schematic"||typeof d.sheet.infinite!=="boolean"))invalid();
        globalThis.AtriumSchAppearance?.validateSheet?.(d.sheet,lenient);
      }
      if(d.pcbDrawing!==undefined || d.sourcePourSignature!==undefined)yield* boardDrawing(d);
      if(d.sourceSha256!=null && (typeof d.sourceSha256!=="string" || !/^[0-9a-f]{64}$/.test(d.sourceSha256)))invalid();
      if(d.rules!=null)throw Error("Board rules (doc.rules) are a pre-release Waffle format, not supported. Re-import the design.");
      if(d.sourceRules!=null){if(d.kind!=="pcb"||!Array.isArray(d.sourceRules)||!d.sourceRules.every(str))invalid();if(globalThis.AtriumAltiumRules)AtriumAltiumRules.validate(d.sourceRules);}
      if(d.appliedSourceRuleRecords!=null){
        // Rule adoption is native edit history. Its original rows can be held by the import report.
        const limit=d.sourceRules?.length??10000,records=d.appliedSourceRuleRecords;
        if(d.kind!=="pcb"||!Array.isArray(records)||records.length>limit||records.some(n=>!Number.isInteger(n)||n<1||n>limit)||new Set(records).size!==records.length)invalid();
      }
      if(d.ruleCheckSelection!=null){
        const r=d.ruleCheckSelection,types=list=>Array.isArray(list)&&list.length<=1000&&new Set(list).size===list.length&&list.every(t=>str(t)&&/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(t));
        if(d.kind!=="pcb"||!obj(r)||Object.keys(r).length!==2||!types(r.batch)||!types(r.online))invalid();
      }
      if(d.sourceRulesReplaced!=null&&(d.kind!=="pcb"||d.sourceRulesReplaced!==true))invalid();
      if(d.sourceRuleLayers!=null&&(d.kind!=="pcb"||!obj(d.sourceRuleLayers)||!Object.values(d.sourceRuleLayers).every(v=>v===null||str(v))))invalid();
      if(d.sourceDrillDrawing!=null){if(d.kind!=="pcb")invalid();yield* drillDrawing(d.sourceDrillDrawing);}
      points(d.outline);if(!Array.isArray(d.notes)||d.notes.some(n=>!str(n)))invalid();
      if(d.origin!=null&&(d.kind!=="pcb"||!point(d.origin)))invalid();
      if(d.rooms!=null){if(d.kind!=="pcb"||!Array.isArray(d.rooms))invalid();globalThis.AtriumRooms?.validate(d.rooms,invalid);}
      if(d.componentClasses!=null){if(d.kind!=="pcb")invalid();globalThis.AtriumComponentClasses?.validate(d.componentClasses,invalid);}
      if(d.boardShape!=null){if(d.kind!=="pcb")invalid();if(globalThis.AtriumBoardShape)try{AtriumBoardShape.validate(d.boardShape);}catch{invalid();}}
      if(d.boardShape?.cutoutRegions!=null){
        if(!obj(d.boardShape.cutoutRegions)||!Array.isArray(d.boardShape.cutouts))invalid();
        for(const [index,r] of Object.entries(d.boardShape.cutoutRegions)){
          if(!/^(0|[1-9][0-9]*)$/.test(index)||+index>=d.boardShape.cutouts.length)invalid();
          region(r);
        }
      }
      if(d.sourceArcVersion!=null){if(d.kind!=="pcb")invalid();sourceVersion(d.sourceArcVersion);}
      if(d.kind==="pcb")yield* bodyGeometry(d);
      else if(d.bodyModelVersion!=null||d.bodyModels!=null||d.bodies3d!=null)invalid();
      }
      for(const i of affected??d.items){identity(i);if(!allowedItems.has(i.kind))invalid();
        if(i.kind==="textframe"&&i.role==="frame"&&d.kind!=="schematic")invalid();
        if(i.widget!=null && (d.kind!=="schematic"||i.kind!=="textframe"))invalid();
        if(i.kind==="imageMarkup"){if(d.kind!=="schematic"||!notebookImage.validMark(i))invalid();continue;}
        if(i.kind==="image"&&i.asset&&(d.kind!=="schematic"||!notebookImage.valid(i)))invalid();
        if(i.kind==="wire"||i.kind==="track"||i.kind==="graphic"||i.kind==="polygon"||i.kind==="bus"){points(i.points);if(i.points.length<(i.kind==="polygon"?3:2))invalid();}else pos(i);
        if(d.kind==="pcb"&&i.arc!=null&&typeof i.arc!=="boolean"&&!validPathArc(i.arc))invalid();
        if(i.schPaint!=null)itemPaint(i.schPaint);
        if(i.calculation!=null&&(d.kind!=="schematic"||i.kind!=="textframe"||!obj(i.calculation)||i.role!=null||i.math||i.widget!=null||i.richText!=null||
          !str(i.text)||!i.text.trim()||i.text.length>16384||!Number.isSafeInteger(i.calculation.languageVersion)||
          globalThis.AtriumCalculationRecords&&!AtriumCalculationRecords.valid(i,lenient)))invalid();
        if(i.pinNets!=null&&(!obj(i.pinNets)||!Object.values(i.pinNets).every(str)))invalid();
        if(i.width!=null&&(!xy(i.width)||i.width<0))invalid();
        if(i.kind==="part"&&(!geometries(defs.get(i.def),d.kind)||!str(i.ref)||!str(i.value)))invalid();
        if((i.kind==="label"||i.kind==="netlabel")&&!str(i.text))invalid();
        if(i.autoName!==undefined){
          if(d.kind==="schematic"&&i.kind==="netlabel"){
            const a=i.autoName;
            if(!obj(a)||!str(a.part)||!a.part.trim()||!str(a.pin)||!a.pin.trim()||
              !(["hyphen","underscore"].includes(a.style)||lenient&&str(a.style)&&a.style.trim()&&a.style.length<=64))invalid();
          }else if(!lenient)invalid();
        }
        if(i.kind==="label"&&globalThis.AtriumPCBText&&!AtriumPCBText.valid(i,lenient))invalid();
        if(i.groupId!=null&&!str(i.groupId))invalid();
        if(i.kind==="part"&&(i.channel!=null&&!str(i.channel)||i.sourceLink!=null&&!str(i.sourceLink)))invalid();
        if(i.kind==="textframe"&&i.math===true&&d.kind!=="schematic")invalid();
        if(globalThis.AtriumSchObjects)AtriumSchObjects.validateItem(i,invalid,lenient);
        if(i.locked!=null&&typeof i.locked!=="boolean"||i.teardrop!=null&&typeof i.teardrop!=="boolean")invalid();
        if(i.kind==="pad")pad(i);
        if(i.kind==="via"){if(!xy(i.diameter)||i.diameter<=0)invalid();padOrVia(i);}
        if(d.kind==="pcb"){
          if(i.regionShape!=null){if(i.kind!=="graphic"&&i.kind!=="polygon")invalid();region(i.regionShape);}
          if(i.powerPlane!=null){if(i.kind!=="polygon")invalid();plane(i);}
          if(i.bodies3d!=null){if(i.kind!=="part")invalid();yield* bodies(i.bodies3d);}
          if(i.boardLabels!=null||i.hiddenBoardLabels!=null){
            if(i.kind!=="part")invalid();
            if(i.boardLabels!=null)yield* boardLabels(i.boardLabels);
            if(i.hiddenBoardLabels!=null)yield* boardLabels(i.hiddenBoardLabels);
          }
          if(i.kind==="label")sourceText(i);
          keepout(i);
        }
        if(++count%128===0)yield;
      }
    }
    return p;
  }
  function validate(p, options){
    const steps=validationSteps(p,options);let step;
    do{step=steps.next();}while(!step.done);
    return step.value;
  }
  return {gate,gateLabel,special,projectText,id,withRevisionIds,clone,padCornerRatio,padNumericSpec,padDimensions,partParameters,projectNumber,pointKey,same,viaLimits,preferredViaSize,viaSize,snap,units,rad,rotate,world,placement,drillCore,arcPoint,arcSweep,arcProjection,transformArc,pathArc,pathLength,nearSegment,triangulateRing,mergeConvex,pathBetween,sheet,documentMetadata,sameDocumentMetadata,isOffsheet,offsheetAngle,offsheetIO,project,preferredDocument,pristineImportPlaceholder,geometries,pins,terminalId,terminalGeometry,similarProperties,definitionGeometry,pcbMirror,footprintPadKeys,symbolPoints,itemPoints,bounds,docBounds,nextRef,instantiate,connectivity,sheetEntry,sheetNets,autoNetName,keepoutBlocks,moveItem,wireStretch,wireStretchState,restoreWireStretch,transformPart,schematicAttachments,validOutline,validate,validationSteps,validInfinitePdfOptions,notebookImage,notebookItemKind};
})();
