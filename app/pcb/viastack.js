"use strict";
if (typeof require === "function") {
  if (!globalThis.AtriumPCBAppearance) require("./pcb-appearance.js");
  if (!globalThis.AtriumStackup) require("./stackup.js");
}
// Via stacks (padstacks) and via templates.
//
// A via keeps its legacy fields {kind:"via", x, y, diameter, drill, fromLayer?,
// toLayer?, net, layer:"Multi"}. Every field below is optional, so a via with
// none of them behaves exactly as before:
//   stackMode  "simple" | "tmb" | "full"   (Altium: Simple / Top-Middle-Bottom / Full Stack)
//   padStack   tmb:  {Top:{diameter,shape?}, Mid:{...}, Bottom:{...}}  Top/Bottom are the
//                    first and last copper layers of the via's span, Mid every layer between.
//              full: {"<copper key>":{diameter,shape?}, ...}           keyed by Top, Inner n, Bottom.
//              A missing row falls back to via.diameter. Editors keep via.diameter equal
//              to the largest pad, so readers that ignore the stack stay conservative.
//   shape      "round" (default) | "rect" | "octagon" for the simple stack.
//   tent       {top:boolean|null, bottom:boolean|null}  true covers the via with solder mask,
//              false opens it, null follows the fabrication output's "Tent vias" setting.
//   maskExpansion  number (mm), overrides the Solder Mask Expansion rule (as for pads).
//   ipc4761    "none" | "I" | "II" | "III" | "IV" | "V" | "VI" | "VII"
//   ipcSides   "top" | "bottom" | "both" for the one/two-sided types (I-a / I-b ...).
//   viaInPad   boolean
//   microvia   boolean (laser-drilled single-dielectric via); undefined = auto-detect.
//   backdrill  {from:"top"|"bottom", toLayer:"<copper key>", stubMax:mm, diameter:mm}
//              toLayer is the deepest layer that must stay connected; the copper
//              layers beyond it on the drilled side are cut off the barrel.
//   template   id of the via template the via was made from.
//
// HDI build-up (optional): doc.hdi = {version:1, top, bottom, anyLayer?, skip?, stacking?, microvia?}
// drives AtriumViaStack.hdi: lamination stages, span validity, the build-up's drill pairs, the
// router's via choice (stacked microvia chains), the Layer Pairs / HDI Vias DRC and fab notes.
//
// Templates live on the board (doc.viaTemplates) or the project (project.viaTemplates):
//   {version:1, list:[template...], defaults:{via:id|null, diffPair:id|null, netClasses:{Class:id}}}
// A template holds the stack fields above plus {id, name, comment?}.
globalThis.AtriumViaStack = (() => {
  const EPS = 1e-9, MICRO_DRILL = 0.15, BACKDRILL_OVERSIZE = 0.2;
  const plain = o => o !== null && typeof o === "object" && !Array.isArray(o);
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const round = v => Math.round(v * 1e6) / 1e6 + 0;
  const MODES = [["simple", "Simple"], ["tmb", "Top-Middle-Bottom"], ["full", "Full Stack"]];
  const SHAPES = [["round", "Round"], ["rect", "Square"], ["octagon", "Octagonal"]];
  // IPC-4761 via protection types. covered: solder mask (or dry film) over the
  // hole on the applied side(s); sided: has -a (one side) and -b (both) forms.
  const IPC = {
    none: {id:"none", label:"None", sided:false},
    I:   {id:"I",   label:"Type I · Tented",               sided:true, covered:true},
    II:  {id:"II",  label:"Type II · Tented and covered",  sided:true, covered:true, coating:true},
    III: {id:"III", label:"Type III · Plugged",            sided:true, plugged:true},
    IV:  {id:"IV",  label:"Type IV · Plugged and covered", sided:true, plugged:true, covered:true},
    V:   {id:"V",   label:"Type V · Filled",               sided:false, filled:true},
    VI:  {id:"VI",  label:"Type VI · Filled and covered",  sided:true, filled:true, covered:true},
    VII: {id:"VII", label:"Type VII · Filled and capped",  sided:false, filled:true, capped:true, viaInPad:true}
  };
  const IPC_IDS = Object.keys(IPC);
  const ipcOf = v => IPC[v?.ipc4761] || IPC.none;

  // ---------------------------------------------------------------- layers
  const copperIndex = key => globalThis.AtriumPCBAppearance.index(key);
  const isCopper = k => copperIndex(k) >= 0;
  const byIndex = (a, b) => copperIndex(a) - copperIndex(b);
  // Keep the legacy default for incomplete via edits. Physical consumers use
  // the strict span against the actual layer stack.
  function spanOf(via) {
    const indices = globalThis.AtriumPCBAppearance.copperSpan(via);
    if (!indices || via?.fromLayer == null && via?.toLayer == null) return ["Top", "Bottom"];
    return indices[0] === copperIndex(via.fromLayer) ? [via.fromLayer, via.toLayer] : [via.toLayer, via.fromLayer];
  }
  const inSpan = (via, layer) => {
    const i = copperIndex(layer), [a,b] = globalThis.AtriumPCBAppearance.copperSpan(via) || [0,127];
    return a <= i && i <= b;
  };
  // Copper keys of a board: AtriumStackup when available, else what the via names.
  function keysOf(source, via, defs) {
    if (Array.isArray(source)) return source.filter(isCopper).sort(byIndex);
    if (source?.kind === "pcb" && globalThis.AtriumStackup) {
      try {return AtriumStackup.copperLayers(source, defs);} catch {/* fall through */}
    }
    if (source?.layers && Array.isArray(source.layers)) {
      const keys = source.layers.filter(l => l.key && isCopper(l.key)).map(l => l.key);
      if (keys.length >= 2) return keys;
    }
    const set = new Set(["Top", "Bottom"]);
    for (const k of [via?.fromLayer, via?.toLayer, via?.backdrill?.toLayer, ...Object.keys(via?.padStack || {})]) if (isCopper(k)) set.add(k);
    return [...set].sort(byIndex);
  }
  const layersIn = (via, keys) => keys.filter(k => inSpan(via, k));

  // ---------------------------------------------------------------- pads per layer
  const modeOf = via => via?.stackMode === "tmb" || via?.stackMode === "full" ? via.stackMode : "simple";
  function rowKey(via, layer) {
    const mode = modeOf(via);
    if (mode === "simple") return null;
    if (mode === "full") return layer;
    const [a, b] = spanOf(via);
    return layer === a ? "Top" : layer === b ? "Bottom" : "Mid";
  }
  // Layers cut off the barrel by a back-drill: the copper beyond toLayer on the drilled side.
  function backdrilled(via, layer) {
    const bd = via?.backdrill;
    if (!plain(bd) || !isCopper(bd.toLayer) || !inSpan(via, layer)) return false;
    const i = copperIndex(layer), stop = copperIndex(bd.toLayer);
    return bd.from === "bottom" ? i > stop : i < stop;
  }
  // {diameter, shape} of the via land on a copper layer; diameter 0 when the
  // layer is outside the span or cut off by a back-drill.
  function padOn(via, layer) {
    if (!inSpan(via, layer) || backdrilled(via, layer)) return {diameter:0, shape:"round"};
    const key = rowKey(via, layer), row = key ? via.padStack?.[key] : null;
    const diameter = finite(row?.diameter) && row.diameter >= 0 ? row.diameter : via.diameter || 0;
    return {diameter, shape:row?.shape || via.shape || "round"};
  }
  const diameterOn = (via, layer) => padOn(via, layer).diameter;
  // Smallest and largest land across the span (for ring checks and extents).
  function extremes(via, keys) {
    const list = layersIn(via, keys || keysOf(null, via)).map(k => diameterOn(via, k)).filter(d => d > 0);
    if (!list.length) return {min:via.diameter || 0, max:via.diameter || 0};
    return {min:Math.min(...list), max:Math.max(...list)};
  }
  const minDiameter = (via, keys) => extremes(via, keys).min;
  // A display copy of a via for one active layer (canvas). Simple vias are returned as is.
  function display(via, layer) {
    if (modeOf(via) === "simple" || !isCopper(layer)) return via;
    const p = padOn(via, layer);
    return p.diameter > 0 ? {...via, diameter:p.diameter, shape:p.shape} : {...via, diameter:Math.max(via.drill || 0, 1e-6) + 1e-6};
  }
  // Rewrites via.diameter as the largest land and drops rows outside the mode.
  function sync(via, keys) {
    const mode = modeOf(via);
    if (mode === "simple") {delete via.padStack; if (via.stackMode) delete via.stackMode; return via;}
    const allowed = mode === "tmb" ? ["Top", "Mid", "Bottom"] : layersIn(via, keys || keysOf(null, via));
    const out = {};
    for (const k of allowed) {
      const row = via.padStack?.[k];
      out[k] = {diameter:finite(row?.diameter) && row.diameter > 0 ? round(row.diameter) : via.diameter};
      if (row?.shape && row.shape !== "round") out[k].shape = row.shape;
    }
    via.padStack = out;
    const ds = Object.values(out).map(r => r.diameter).filter(d => d > 0);
    if (ds.length) via.diameter = round(Math.max(...ds));
    return via;
  }
  // Switch stack mode, seeding new rows from the current lands.
  function setMode(via, mode, keys) {
    keys = keys || keysOf(null, via);
    const before = {...via, padStack:via.padStack ? JSON.parse(JSON.stringify(via.padStack)) : undefined};
    via.stackMode = mode;
    if (mode === "simple") {via.diameter = extremes(before, keys).max || via.diameter; return sync(via, keys);}
    const span = layersIn(via, keys), rows = {};
    const seed = k => ({diameter:diameterOn(before, k) || via.diameter, ...(padOn(before, k).shape !== "round" ? {shape:padOn(before, k).shape} : {})});
    if (mode === "tmb") {
      rows.Top = seed(span[0]); rows.Bottom = seed(span.at(-1));
      const mid = span.slice(1, -1);
      rows.Mid = mid.length ? seed(mid[0]) : {diameter:via.diameter};
    } else for (const k of span) rows[k] = seed(k);
    via.padStack = rows;
    return sync(via, keys);
  }

  // ---------------------------------------------------------------- solder mask
  function ipcCode(via) {
    const t = ipcOf(via);
    if (t.id === "none") return "None";
    if (!t.sided) return t.id;
    return t.id + ((via.ipcSides || "both") === "both" ? "b" : "a");
  }
  function ipcApplies(via, side) {
    const t = ipcOf(via);
    if (!t.sided) return t.id !== "none";
    const s = via.ipcSides || "both";
    return s === "both" || s === side;
  }
  // Whether the via is covered on one side: true, false or null (follow the
  // output's default tenting).
  function covered(via, side) {
    const t = ipcOf(via), explicit = via?.tent?.[side];
    if (t.covered && ipcApplies(via, side)) return true;
    if (t.id !== "none") return explicit === true ? true : false;
    return typeof explicit === "boolean" ? explicit : null;
  }
  // maskOpening(via, "top"|"bottom", rulesOrOptions) ->
  //   {side, open:true|false|null, diameter, expansion, source}
  // The third argument is a number (expansion in mm), a rule set, or
  // {expansion?, rules?, board?, project?, tentDefault?}. open:null means the
  // via follows the output default; tentDefault resolves it.
  function maskOpening(via, side, opt) {
    side = side === "bottom" ? "bottom" : "top";
    const o = finite(opt) ? {expansion:opt} : plain(opt) && opt.format === "atrium-rules" ? {rules:opt} : opt || {};
    const [a, b] = spanOf(via), outer = side === "top" ? a : b, reaches = outer === (side === "top" ? "Top" : "Bottom");
    // A back-drilled side has no land; the mask clears the back-drill hole instead.
    const back = reaches && backdrilled(via, outer) ? drillSpans(via).find(s => s.role === "backdrill") : null;
    const land = !reaches ? 0 : back ? back.drill : diameterOn(via, outer);
    if (!land) return {side, open:false, diameter:0, land:0, expansion:0, source:"inner"};
    let c = covered(via, side), source = back ? "backdrill" : ipcOf(via).id !== "none" ? "ipc" : typeof via?.tent?.[side] === "boolean" ? "tent" : "default";
    if (back && c !== true) c = false;
    if (c === null && typeof o.tentDefault === "boolean") c = o.tentDefault;
    let expansion = finite(via.maskExpansion) ? via.maskExpansion : finite(o.expansion) ? o.expansion : null;
    if (expansion == null && (o.rules || o.board) && globalThis.AtriumRules) {
      try {expansion = AtriumRules.expansion(o.board || {kind:"pcb", items:[]}, "solder", via, {rules:o.rules, project:o.project, layer:side === "top" ? "Top" : "Bottom"});}
      catch {expansion = null;}
    }
    if (expansion == null) expansion = 0.1016;
    const open = c === null ? null : !c;
    return {side, open, diameter:open === false ? 0 : round(Math.max(0, land + 2 * expansion)), land, expansion, source};
  }
  // What a via's construction means downstream.
  function implications(via) {
    const t = ipcOf(via), top = maskOpening(via, "top", 0), bottom = maskOpening(via, "bottom", 0);
    const mask = o => o.open === null ? "output default" : o.open ? "open" : "covered";
    return {ipc:t.id, code:ipcCode(via), label:t.label, maskTop:mask(top), maskBottom:mask(bottom),
      paste:"none (via-in-pad lands take paste from the pad)", fill:t.filled ? "filled" : t.plugged ? "plugged" : "open",
      capped:!!t.capped, viaInPadOk:!!t.viaInPad, fillFile:!!(t.filled || t.plugged),
      x2:"ViaDrill" + (t.id === "none" ? "" : "," + ipcCode(via))};
  }

  // ---------------------------------------------------------------- drilling
  function spanKind(a, b, keys) {
    const top = keys[0] || "Top", bottom = keys.at(-1) || "Bottom";
    return a === top && b === bottom ? "through" : a === top || b === bottom ? "blind" : "buried";
  }
  function isMicrovia(via, keys) {
    if (via?.microvia === false) return false;
    const [a, b] = spanOf(via), i = keys.indexOf(a), j = keys.indexOf(b);
    const kind = spanKind(a, b, keys);
    if (via?.microvia === true) return kind !== "through";
    return kind !== "through" && i >= 0 && j === i + 1 && via.drill > 0 && via.drill <= MICRO_DRILL + EPS;
  }
  // Drill operations for one via, top to bottom:
  //   {role:"plated", from, to, kind:"through"|"blind"|"buried"|"microvia", drill, laser}
  //   {role:"backdrill", side, from, to, stopLayer, drill, stubMax}  (from/to: copper layers removed)
  function drillSpans(via, source, defs) {
    const keys = keysOf(source, via, defs), [a, b] = spanOf(via), micro = isMicrovia(via, keys);
    const out = [{role:"plated", from:a, to:b, kind:micro ? "microvia" : spanKind(a, b, keys), drill:via.drill || 0, laser:micro, plated:true}];
    const bd = via.backdrill;
    if (plain(bd) && isCopper(bd.toLayer) && inSpan(via, bd.toLayer)) {
      const removed = layersIn(via, keys).filter(k => backdrilled(via, k));
      if (removed.length) out.push({role:"backdrill", side:bd.from === "bottom" ? "bottom" : "top", from:removed[0], to:removed.at(-1),
        stopLayer:bd.toLayer, drill:finite(bd.diameter) && bd.diameter > 0 ? bd.diameter : round((via.drill || 0) + BACKDRILL_OVERSIZE),
        stubMax:finite(bd.stubMax) ? bd.stubMax : 0.2, plated:false});
    }
    return out;
  }

  // ---------------------------------------------------------------- physical geometry
  // Z positions from AtriumStackup, top surface = 0.
  function physical(source, defs) {
    const S = globalThis.AtriumStackup;
    let stack = null;
    try {stack = source?.kind === "pcb" && S ? S.get(source, defs) : source?.layers ? source : null;} catch {stack = null;}
    if (!stack) stack = S.build(["Signal", "Signal"]);
    const depths = S.layerDepths(stack);
    const layers = depths.map(({row, z}) => ({...row, z, t:row.thickness, copper:S.isCopper(row)}));
    const copper = new Map(layers.filter(l => l.copper && l.key).map(l => [l.key, l]));
    return {layers, copper, total:round(depths.at(-1)?.end || 0), keys:[...copper.keys()]};
  }
  // Stop position in bottom-up Z, offset from the near side of the retained copper.
  const backdrillStop = (bd, stop) => bd.side === "top" ? stop[1] + bd.stubMax : stop[0] - bd.stubMax;
  // Barrel length, aspect ratio and back-drill depth of a via on a board.
  function measure(via, source, defs) {
    const P = physical(source, defs), [a, b] = spanOf(via), A = P.copper.get(a), B = P.copper.get(b);
    const top = A ? A.z : 0, bottom = B ? B.z + B.t : P.total, depth = round(bottom - top);
    // Microvia aspect ratio is dielectric thickness over hole diameter; others use the plated barrel.
    const micro = isMicrovia(via, P.keys), dielectric = A && B ? round(B.z - (A.z + A.t)) : depth;
    const out = {depth, top, bottom, dielectric, aspect:via.drill > 0 ? round((micro ? dielectric : depth) / via.drill) : Infinity, physical:P, backdrill:null};
    const bd = drillSpans(via, P.keys).find(s => s.role === "backdrill"), stop = bd && P.copper.get(bd.stopLayer);
    if (bd && stop) {
      // The tool stops stubMax short of the stop layer's far face, measured from the drilled side.
      const end = -backdrillStop(bd, [-stop.z - stop.t, -stop.z]);
      const start = bd.side === "top" ? top : bottom;
      const last = P.copper.get(bd.side === "top" ? bd.to : bd.from);
      // The layer next to the stop layer must be cut through.
      const cut = last ? (bd.side === "top" ? last.z + last.t <= end + EPS : last.z >= end - EPS) : true;
      out.backdrill = {...bd, start, end:round(end), depth:round(Math.abs(end - start)), stub:bd.stubMax, severs:cut};
    }
    return out;
  }

  // ---------------------------------------------------------------- validation
  // validate(via, boardOrStack, {rules?, board?, project?, defs?, profile?, annularRing?, maxAspect?})
  //  -> {ok, messages:[{level:"error"|"warning"|"info", code, text, layer?}], rings, aspect, depth}
  function validate(via, source, opt = {}) {
    const board = opt.board || (source?.kind === "pcb" ? source : null), msgs = [];
    const say = (level, code, text, layer) => msgs.push({level, code, text, ...(layer ? {layer} : {})});
    const mm = v => round(v) + " mm";
    const M = measure(via, source, opt.defs), keys = M.physical.keys, span = layersIn(via, keys), [a, b] = spanOf(via);
    const profile = opt.profile || board?.fabProfile || null, drill = via.drill || 0;
    if (!(drill > 0)) say("error", "drill", "The via has no drill size.");
    const missing = [via.fromLayer, via.toLayer].filter(k => k != null && !keys.includes(k));
    for (const k of missing) say("error", "span", "Layer " + k + " is not in the layer stack.");
    let ringMin = finite(opt.annularRing) ? opt.annularRing : null;
    if (ringMin == null && globalThis.AtriumRules && (opt.rules || board)) {
      try {ringMin = AtriumRules.query(board || {kind:"pcb", items:[]}, "annularRing", {net:via.net || "", layer:"Multi"}, {rules:opt.rules, project:opt.project})?.min ?? null;} catch {ringMin = null;}
    }
    if (ringMin == null && finite(profile?.annularRing)) ringMin = profile.annularRing;
    const rings = [];
    for (const k of span) {
      const d = diameterOn(via, k);
      if (!d) {if (backdrilled(via, k)) rings.push({layer:k, ring:null, removed:true}); continue;}
      const ring = round((d - drill) / 2);
      rings.push({layer:k, ring, diameter:d});
      if (d <= drill + EPS) say("error", "land", "The land on " + k + " (" + mm(d) + ") is not larger than the drill (" + mm(drill) + ").", k);
      else if (ringMin != null && ring + EPS < ringMin) say("error", "ring", "Annular ring on " + k + " is " + mm(ring) + ", below the " + mm(ringMin) + " minimum.", k);
    }
    const micro = isMicrovia(via, keys), kind = spanKind(a, b, keys);
    const maxAspect = micro ? (finite(opt.microviaAspect) ? opt.microviaAspect : finite(profile?.microviaAspect) ? profile.microviaAspect : 1)
      : finite(opt.maxAspect) ? opt.maxAspect : finite(profile?.maxAspect) ? profile.maxAspect : 10;
    if (drill > 0 && !missing.length && M.aspect > maxAspect + EPS) say("error", "aspect", "Aspect ratio " + M.aspect.toFixed(2) + ":1 (" + mm(M.depth) + " / " + mm(drill) + ") exceeds " + maxAspect + ":1" + (micro ? " for a microvia." : "."));
    if (micro) {
      const i = keys.indexOf(a), j = keys.indexOf(b);
      if (!missing.length && j !== i + 1) say("error", "microvia-span", "A microvia must span one dielectric (adjacent copper layers); this one spans " + (j - i) + ".");
      if (drill > MICRO_DRILL + EPS) say("warning", "microvia-drill", "Laser microvias are usually " + MICRO_DRILL + " mm or smaller; this drill is " + mm(drill) + ".");
      if (profile && !profile.microvia) say("error", "capability", (profile.name || "The fab profile") + " does not offer microvias.");
    } else if (kind !== "through" && profile && !profile[kind]) say("error", "capability", (profile.name || "The fab profile") + " does not offer " + kind + " vias.");
    if (profile) {
      if (finite(profile.viaDrill) && drill + EPS < profile.viaDrill && !micro) say("error", "capability", "Drill " + mm(drill) + " is below the profile minimum " + mm(profile.viaDrill) + ".");
      if (finite(profile.microviaDrill) && micro && drill + EPS < profile.microviaDrill) say("error", "capability", "Microvia drill " + mm(drill) + " is below the profile minimum " + mm(profile.microviaDrill) + ".");
    }
    const t = ipcOf(via);
    if (t.covered && ipcApplies(via, "top") && via.tent?.top === false || t.covered && ipcApplies(via, "bottom") && via.tent?.bottom === false)
      say("warning", "tent", t.label + " covers the via; the open-mask setting is ignored on the covered side.");
    if (via.viaInPad) {
      if (!t.viaInPad) say("warning", "via-in-pad", "Via-in-pad should be filled and capped (IPC-4761 Type VII) so solder does not wick into the hole.");
      if (profile && !profile.viaInPad) say("error", "capability", (profile.name || "The fab profile") + " does not offer via-in-pad.");
    }
    if (t.sided && t.covered && drill > 0.5 + EPS) say("warning", "tent-size", "Tenting holes above 0.5 mm is unreliable; consider plugging or filling.");
    const bd = via.backdrill;
    if (plain(bd)) {
      const outerOk = bd.from === "bottom" ? b === keys.at(-1) : a === keys[0];
      if (!outerOk) say("error", "backdrill", "Back-drilling starts from an outer layer the via reaches; this via does not reach the " + (bd.from === "bottom" ? "bottom" : "top") + ".");
      else if (!isCopper(bd.toLayer) || !span.includes(bd.toLayer)) say("error", "backdrill", "Choose a stop layer inside the via span.");
      else if (!M.backdrill) say("warning", "backdrill", "The stop layer leaves no copper layer to remove.");
      else {
        if (M.backdrill.drill + EPS < drill + 0.15) say("warning", "backdrill", "Back-drill " + mm(M.backdrill.drill) + " should be at least 0.15–0.25 mm larger than the via drill (" + mm(drill) + ").");
        if (!M.backdrill.severs) say("error", "backdrill", "A stub limit of " + mm(M.backdrill.stubMax) + " leaves layer " + (bd.from === "bottom" ? M.backdrill.from : M.backdrill.to) + " connected; reduce the stub or move the stop layer.");
        if (profile && profile.backdrill === false) say("error", "capability", (profile.name || "The fab profile") + " does not offer back-drilling.");
        say("info", "backdrill", "Back-drill from the " + M.backdrill.side + " " + mm(M.backdrill.depth) + " deep, removing " + M.backdrill.from + (M.backdrill.to !== M.backdrill.from ? "–" + M.backdrill.to : "") + "; stub ≤ " + mm(M.backdrill.stubMax) + ".");
      }
    }
    return {ok:!msgs.some(m => m.level === "error"), messages:msgs, rings, aspect:M.aspect, depth:M.depth, maxAspect, microvia:micro, kind:micro ? "microvia" : kind};
  }
  // Board-wide check: validation messages for every via with a stack, a template
  // or a span the profile constrains. Returns DRC-like rows.
  function check(board, defs, opt = {}) {
    const out = [];
    for (const v of board?.items || []) {
      if (v.kind !== "via") continue;
      const r = validate(v, board, {...opt, board, defs});
      for (const m of r.messages) if (m.level === "error") out.push({id:v.id, at:[v.x, v.y], code:m.code, text:m.text, layer:m.layer, mode:modeOf(v)});
    }
    return out;
  }

  // ---------------------------------------------------------------- HDI build-up
  // A board may describe its sequential build-up (optional; older readers ignore it):
  //   doc.hdi = {version:1, top, bottom, anyLayer?, skip?, stacking?, microvia?:{diameter, drill, ipc4761}}
  //   top / bottom  build-up layers laminated onto each side of the core, so "2+4+2" on an
  //                 8-layer stack is top 2, bottom 2 (core L3–L6). anyLayer makes every layer
  //                 pair a build-up step (any-layer / ELIC). skip:false refuses skip vias
  //                 (laser vias over two dielectrics). microvia: the laser via the router places.
  // Lamination stage s (0 = core) spans copper L(top−s)…L(core end+s). A plated hole can be
  // drilled at a stage when one of its ends is an outer layer of that stage and the other
  // end lies inside it: both ends outer is a mechanical (through, buried or stage) hole,
  // one dielectric deeper is a laser microvia, two is a skip via, anything deeper needs a
  // controlled-depth drill. A span no stage exposes cannot be built.
  const HDI_IPC = new Set(["V", "VI", "VII"]);
  const int0 = v => Number.isInteger(v) && v >= 0 ? v : 0;
  function cleanHdi(raw) {
    if (!plain(raw)) return null;
    const out = {version:1, top:Math.min(int0(raw.top), 63), bottom:Math.min(int0(raw.bottom), 63)};
    if (raw.anyLayer) out.anyLayer = true;
    if (raw.skip === false) out.skip = false;
    if (raw.stacking === "staggered") out.stacking = "staggered";
    const mv = plain(raw.microvia) ? raw.microvia : null;
    if (mv) {
      const m = {};
      if (finite(mv.diameter) && mv.diameter > 0 && mv.diameter < 10) m.diameter = round(mv.diameter);
      if (finite(mv.drill) && mv.drill > 0 && mv.drill < 10) m.drill = round(mv.drill);
      if (IPC[mv.ipc4761]) m.ipc4761 = mv.ipc4761;
      if (Object.keys(m).length) out.microvia = m;
    }
    return out.top || out.bottom || out.anyLayer ? out : null;
  }
  // The build-up of a board, resolved against its copper layers (null: no build-up).
  function hdiConfig(doc, defs, keys) {
    const raw = cleanHdi(doc?.hdi);
    if (!raw) return null;
    keys = keys || keysOf(doc, null, defs);
    const n = keys.length, room = Math.max(0, n - 2);
    let top = raw.top, bottom = raw.bottom;
    if (raw.anyLayer) {top = Math.floor(room / 2); bottom = room - top;}
    top = Math.min(top, room); bottom = Math.min(bottom, room - top);
    if (!top && !bottom) return null;
    const mv = raw.microvia || {};
    const drill = mv.drill || .1, diameter = mv.diameter > drill ? mv.diameter : round(Math.max(.25, drill + .15));
    return {top, bottom, anyLayer:!!raw.anyLayer, skip:raw.skip !== false, stacking:raw.stacking || "stacked", keys, n,
      core:[top, n - 1 - bottom], microvia:{diameter, drill, ipc4761:mv.ipc4761 || "VII"}};
  }
  function setHdi(doc, raw) {
    const c = cleanHdi(raw);
    if (c) doc.hdi = c; else delete doc.hdi;
    return c;
  }
  // "2+4+2", "Any-layer (8)" or "" without a build-up.
  function hdiName(c) {return !c ? "" : c.anyLayer ? "Any-layer (" + c.n + " layers)" : c.top + "+" + (c.core[1] - c.core[0] + 1) + "+" + c.bottom;}
  // Lamination stages, core first: [{index, lo, hi, from, to, kind:"core"|"build-up", layers, added:[keys]}].
  function stages(doc, defs, c = hdiConfig(doc, defs)) {
    const keys = c?.keys || keysOf(doc, null, defs), n = keys.length;
    if (!c) return [{index:0, lo:0, hi:n - 1, from:keys[0], to:keys[n - 1], kind:"core", layers:n, added:[]}];
    const out = [];
    for (let s = 0; s <= Math.max(c.top, c.bottom); s++) {
      const lo = Math.max(0, c.core[0] - s), hi = Math.min(n - 1, c.core[1] + s);
      const added = s ? [...(s <= c.top ? [keys[lo]] : []), ...(s <= c.bottom ? [keys[hi]] : [])] : keys.slice(lo, hi + 1);
      out.push({index:s, lo, hi, from:keys[lo], to:keys[hi], kind:s ? "build-up" : "core", layers:hi - lo + 1, added});
    }
    return out;
  }
  // Presses: one for a multilayer core (more than two copper layers), one per build-up step.
  const laminations = (c, list) => !c ? 1 : (list[0].layers > 2 ? 1 : 0) + Math.max(c.top, c.bottom);
  function definedPairs(doc, defs) {
    const S = globalThis.AtriumStackup, set = new Set();
    let stack = null;
    try {stack = S?.stored ? S.stored(doc) : null;} catch {stack = null;}
    for (const p of stack?.drillPairs || []) set.add(p.from + "|" + p.to);
    return {stored:!!stack, set};
  }
  // spanStatus(board, fromKey, toKey, defs?) ->
  //   {ok, from, to, lo, hi, kind:"through"|"blind"|"buried"|"microvia", method:"mechanical"|"laser"|"controlled-depth",
  //    laser, skip?, stage, defined, stored, code?, reason?}
  // defined: the span is the through span or a drill pair of the stored layer stack.
  function spanStatus(doc, from, to, defs, c = hdiConfig(doc, defs), pairs = definedPairs(doc, defs)) {
    const keys = c?.keys || keysOf(doc, null, defs), n = keys.length;
    let i = keys.indexOf(from), j = keys.indexOf(to);
    if (i < 0 || j < 0 || i === j) return {ok:false, from, to, code:"layer", reason:(i < 0 ? from : j < 0 ? to : from) + (i === j && i >= 0 ? " is both ends of the span." : " is not a copper layer of the layer stack."), defined:false, stored:pairs.stored};
    if (i > j) [i, j] = [j, i];
    const kind = spanKind(keys[i], keys[j], keys);
    const base = {from:keys[i], to:keys[j], lo:i, hi:j, kind, laser:false, stage:null, stored:pairs.stored,
      defined:kind === "through" || pairs.set.has(keys[i] + "|" + keys[j])};
    if (!c) return {...base, ok:true, method:"mechanical"};
    for (const st of stages(doc, defs, c)) {
      if (i < st.lo || j > st.hi) continue;
      const top = i === st.lo, bottom = j === st.hi;
      if (!top && !bottom) continue;
      const r = {...base, ok:true, stage:st.index};
      if (top && bottom) return {...r, method:"mechanical"};
      const depth = j - i;
      if (st.index > 0 && depth === 1) return {...r, kind:"microvia", method:"laser", laser:true};
      if (st.index > 0 && depth === 2 && c.skip) return {...r, kind:"microvia", method:"laser", laser:true, skip:true};
      return {...r, method:"controlled-depth"};
    }
    const name = k => "L" + (keys.indexOf(k) + 1);
    return {...base, ok:false, code:"lamination", reason:"No lamination step of the " + hdiName(c) + " build-up exposes " + name(keys[i]) + " or " + name(keys[j]) +
      " as an outer layer with the other inside; connect " + name(keys[i]) + "–" + name(keys[j]) + " with stacked or staggered vias."};
  }
  // Drill pairs a build-up offers: through, the core, each stage's mechanical span and
  // one laser microvia pair per build-up layer. [{from, to, kind, method, stage}]
  function recommendedPairs(doc, defs, c = hdiConfig(doc, defs)) {
    const keys = c?.keys || keysOf(doc, null, defs), n = keys.length, out = [], seen = new Set();
    const add = (i, j, method, stage) => {
      const id = keys[i] + "|" + keys[j];
      if (i < 0 || j >= n || i >= j || seen.has(id)) return;
      seen.add(id); out.push({from:keys[i], to:keys[j], kind:method === "laser" ? "microvia" : spanKind(keys[i], keys[j], keys), method, stage});
    };
    add(0, n - 1, "mechanical", c ? Math.max(c.top, c.bottom) : 0);
    if (!c) return out;
    for (const st of stages(doc, defs, c)) {
      if (st.lo > 0 || st.hi < n - 1) add(st.lo, st.hi, "mechanical", st.index);
      if (!st.index) continue;
      if (st.index <= c.top) add(st.lo, st.lo + 1, "laser", st.index);
      if (st.index <= c.bottom) add(st.hi - 1, st.hi, "laser", st.index);
    }
    return out;
  }
  // Stores the recommended pairs as the layer stack's drill pairs (keeps other defined pairs
  // the build-up allows). Call inside an undo step. Returns the stored list.
  function applyPairs(doc, defs, o = {}) {
    const S = globalThis.AtriumStackup;
    if (!S) throw Error("The layer stack module is not loaded.");
    S.guard?.(doc);
    const c = hdiConfig(doc, defs), stack = JSON.parse(JSON.stringify(S.get(doc, defs))), pairs = definedPairs(doc, defs);
    const keep = o.replace ? [] : (stack.drillPairs || []).filter(p => spanStatus(doc, p.from, p.to, defs, c, pairs).ok);
    const list = [...keep];
    for (const p of recommendedPairs(doc, defs, c)) if (p.kind !== "through" && !list.some(q => q.from === p.from && q.to === p.to)) list.push({from:p.from, to:p.to});
    stack.drillPairs = list;
    doc.stackup = S.normalize ? S.normalize(stack) : stack;
    return doc.stackup.drillPairs;
  }
  // Spans the router may use: the stack's defined pairs when it stores any beyond through,
  // else the build-up's recommended pairs; never controlled-depth unless allowed.
  function usableSpans(doc, defs, c, o = {}) {
    const keys = c.keys, pairs = definedPairs(doc, defs);
    const list = pairs.set.size ? [[keys[0], keys.at(-1)], ...[...pairs.set].map(k => k.split("|"))] : recommendedPairs(doc, defs, c).map(p => [p.from, p.to]);
    const out = [];
    for (const [a, b] of list) {
      const st = spanStatus(doc, a, b, defs, c, pairs);
      if (st.ok && (o.allowDepth || st.method !== "controlled-depth") && !out.some(s => s.lo === st.lo && s.hi === st.hi)) out.push(st);
    }
    return out;
  }
  // Vias that join copper layers `from` and `to`: the cheapest chain of usable spans, each
  // via overlapping the next (stacked at one point). Cost = layers each via blocks + 1 per via.
  // -> [{from, to, lo, hi, laser, kind, method}] or null.
  function chain(doc, from, to, defs, o = {}) {
    const c = o.config || hdiConfig(doc, defs);
    if (!c) return null;
    const keys = c.keys, a = keys.indexOf(from), b = keys.indexOf(to);
    if (a < 0 || b < 0 || a === b) return null;
    const spans = o.spans || usableSpans(doc, defs, c, o), n = keys.length;
    // Dijkstra over layers: a via containing layer x reaches every layer of its span.
    const cost = new Array(n).fill(Infinity), prev = new Array(n).fill(null), done = new Array(n).fill(false);
    cost[a] = 0;
    for (;;) {
      let x = -1;
      for (let k = 0; k < n; k++) if (!done[k] && cost[k] < Infinity && (x < 0 || cost[k] < cost[x])) x = k;
      if (x < 0 || x === b) break;
      done[x] = true;
      for (const s of spans) {
        if (x < s.lo || x > s.hi) continue;
        const w = cost[x] + (s.hi - s.lo + 1) + 1;
        for (let y = s.lo; y <= s.hi; y++) if (w < cost[y] - EPS) {cost[y] = w; prev[y] = {x, s};}
      }
    }
    if (cost[b] === Infinity) return null;
    const out = [];
    for (let y = b; y !== a; y = prev[y].x) out.unshift(prev[y].s);
    return out;
  }
  // The router's via for a layer change: null without a build-up (the router keeps its own
  // drill-pair choice), else {lo, hi, fromLayer?, toLayer?, extra?, parts?} with router
  // layer indices (Top 0 … Bottom 127). parts: the vias of a stacked chain, top to bottom.
  function routeSpan(doc, from, to, defs, o = {}) {
    const c = hdiConfig(doc, defs);
    if (!c) return null;
    const list = chain(doc, from, to, defs, {...o, config:c});
    if (!list?.length) return null;
    const keys = c.keys, last = keys.length - 1;
    const fields = s => {
      const out = {};
      if (s.lo > 0 || s.hi < last) {out.fromLayer = keys[s.lo]; out.toLayer = keys[s.hi];}
      if (s.laser) out.extra = {diameter:c.microvia.diameter, drill:c.microvia.drill, microvia:true, ...(c.microvia.ipc4761 !== "none" ? {ipc4761:c.microvia.ipc4761} : {})};
      return out;
    };
    const lo = Math.min(...list.map(s => s.lo)), hi = Math.max(...list.map(s => s.hi));
    const span = {lo:copperIndex(keys[lo]), hi:copperIndex(keys[hi]), ...fields({lo, hi, laser:list.length === 1 && list[0].laser})};
    if (list.length > 1) span.parts = list.map(fields);
    return span;
  }
  // SMD pads on the outer layers: [{id, ref, number, at, w, h, angle, shape, layer, net}].
  function smdPads(doc, defs) {
    const A = globalThis.Atrium, out = [];
    const layerOf = (parent, p) => p.layer || (p.drill > 0 ? "Multi" : parent?.layer || "Top");
    const push = (p, parent) => {
      if (p.drill > 0 || !(p.w > 0 && p.h > 0)) return;
      const layer = layerOf(parent, p);
      if (layer !== "Top" && layer !== "Bottom") return;
      const at = parent && A ? A.world([p.x, p.y], parent) : [p.x, p.y];
      out.push({id:parent?.id || p.id, ref:parent?.ref, number:p.number, at, w:p.w, h:p.h, angle:(p.angle || 0) + (parent?.angle || 0), shape:p.shape || "rect", layer,
        net:parent ? parent.pinNets?.[p.number] ?? p.net ?? "" : p.net || ""});
    };
    for (const it of doc?.items || []) {
      if (it.kind === "pad") push(it, null);
      else if (it.kind === "part") for (const p of defs?.get?.(it.def)?.footprint?.pads || []) push(p, it);
    }
    return out;
  }
  // The SMD pad a via's hole lands in (the via's span must reach that pad's side), or null.
  function padUnder(via, pads, keys) {
    const [a, b] = spanOf(via), r = (via.drill || 0) / 2;
    for (const p of pads) {
      if (p.layer === "Top" ? a !== keys[0] : b !== keys.at(-1)) continue;
      const t = -(p.angle || 0) * Math.PI / 180, dx = via.x - p.at[0], dy = via.y - p.at[1];
      const x = dx * Math.cos(t) - dy * Math.sin(t), y = dx * Math.sin(t) + dy * Math.cos(t);
      const round = /^(round|circle|oval|ellipse)$/i.test(p.shape) && Math.abs(p.w - p.h) < EPS;
      if (round ? Math.hypot(x, y) < p.w / 2 + r - EPS : Math.abs(x) < p.w / 2 + r - EPS && Math.abs(y) < p.h / 2 + r - EPS) return p;
    }
    return null;
  }
  // Vias in SMD pads: [{via, pad, filled}] (filled: IPC-4761 Type V, VI or VII).
  function viasInPads(doc, defs, keys = keysOf(doc, null, defs)) {
    const pads = smdPads(doc, defs), out = [];
    if (!pads.length) return out;
    for (const v of doc?.items || []) {
      if (v.kind !== "via") continue;
      const pad = padUnder(v, pads, keys);
      if (pad) out.push({via:v, pad, filled:HDI_IPC.has(ipcOf(v).id)});
    }
    return out;
  }
  // Vias stacked at one point whose spans join end to end (or overlap):
  // [{at, ids, vias, count, microvias, from, to}] for groups of two or more.
  function viaStacks(doc, defs, keys = keysOf(doc, null, defs), c = hdiConfig(doc, defs, keys), tol = 1e-3) {
    const groups = new Map();
    for (const v of doc?.items || []) {
      if (v.kind !== "via") continue;
      const k = Math.round(v.x / tol) + "," + Math.round(v.y / tol);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v);
    }
    const out = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const rows = list.map(v => {const [a, b] = spanOf(v); return {v, lo:keys.indexOf(a), hi:keys.indexOf(b)};}).filter(r => r.lo >= 0 && r.hi >= 0).sort((p, q) => p.lo - q.lo || p.hi - q.hi);
      let cur = null;
      const flush = () => {if (cur && cur.length > 1) out.push(stackRow(cur, keys, c));};
      for (const r of rows) {
        if (cur && r.lo <= cur.at(-1).hi && r.v.net === cur[0].v.net) cur.push(r); else {flush(); cur = [r];}
      }
      flush();
    }
    return out;
  }
  function stackRow(rows, keys, c) {
    // microvias: the longest run of laser vias one on another (a mechanical via between breaks the run).
    let run = 0, most = 0;
    for (const r of rows) {run = laserLike(r.v, keys, c) ? run + 1 : 0; most = Math.max(most, run);}
    return {at:[rows[0].v.x, rows[0].v.y], ids:rows.map(r => r.v.id), vias:rows.map(r => r.v), count:rows.length, microvias:most,
      from:keys[Math.min(...rows.map(r => r.lo))], to:keys[Math.max(...rows.map(r => r.hi))]};
  }
  // A microvia: flagged, auto-detected (viastack isMicrovia), or a small blind/buried hole in a build-up.
  function laserLike(v, keys, c) {
    if (v.microvia === false) return false;
    if (v.microvia === true || isMicrovia(v, keys)) return true;
    const [a, b] = spanOf(v);
    return !!c && (v.drill || 0) > 0 && v.drill <= MICRO_DRILL + EPS && !(a === keys[0] && b === keys.at(-1));
  }
  const isLaser = (v, keys, st) => v.microvia === true || isMicrovia(v, keys) || !!st?.laser && v.microvia !== false && (v.drill || 0) <= MICRO_DRILL + EPS;
  // DRC for the Layer Pairs and HDI Vias rules (rules.js): called with the rule engine's
  // first(type, object), flag(rule, violation), notes and active(type).
  function hdiDrc(doc, defs, {first, flag, notes = [], active = () => true} = {}) {
    const keys = keysOf(doc, null, defs), c = hdiConfig(doc, defs, keys), pairs = definedPairs(doc, defs), last = keys.length - 1;
    const lp = active("layerPairs"), hv = active("hdiVias");
    const L = k => "L" + (keys.indexOf(k) + 1);
    const label = (v, a, b) => "Via " + (v.net || "(no net)") + " (" + (a === keys[0] && b === keys[last] ? "through" : L(a) + "–" + L(b) + " " + a + "–" + b) + ")";
    const target = v => {const [a, b] = spanOf(v); return {net:v.net || "", layer:"Multi", kind:"via", span:[copperIndex(a), copperIndex(b)]};};
    const vip = hv ? new Map(viasInPads(doc, defs, keys).map(e => [e.via, e])) : new Map();
    for (const v of doc?.items || []) {
      if (v.kind !== "via") continue;
      const [a, b] = spanOf(v), o = target(v), at = [v.x, v.y], title = label(v, a, b);
      const st = spanStatus(doc, a, b, defs, c, pairs);
      if (lp) {
        const r = first("layerPairs", o);
        if (r && r.enforce !== false) {
          if (!st.ok) flag(r, {id:v.id, title, what:"Layer pair", detail:st.reason, at});
          else if (st.kind !== "through" && st.stored && !st.defined) flag(r, {id:v.id, title, what:"Layer pair", detail:L(a) + "–" + L(b) + " is not a drill pair of the layer stack (Layer Stack Manager › Via Types)", at});
        }
      }
      if (!hv) continue;
      const r = first("hdiVias", o);
      if (!r) continue;
      const micro = isLaser(v, keys, st);
      if (v.drill > 0 && st.code !== "layer") {
        let M = null;
        try {M = measure(v, doc, defs);} catch {M = null;}
        const limit = micro ? Number(r.microviaAspect) || 1 : Number(r.maxAspect) || 10;
        if (M && M.aspect > limit + EPS) flag(r, {id:v.id, title, what:"Aspect ratio", detail:"Aspect ratio " + M.aspect.toFixed(2) + ":1 (" + round(micro ? M.dielectric : M.depth) + " mm / " + round(v.drill) + " mm) exceeds " + limit + ":1" + (micro ? " for a microvia" : ""), at});
      }
      if (c && st.ok && st.method === "controlled-depth" && !r.allowDepth) flag(r, {id:v.id, title, what:"Drill depth", detail:L(a) + "–" + L(b) + " needs a controlled-depth drill in the " + hdiName(c) + " build-up; use stacked microvias or a drill pair the build-up offers", at});
      if (st.skip && micro && r.allowSkip === false) flag(r, {id:v.id, title, what:"Skip via", detail:"A laser via over two dielectrics (skip via) is not allowed by the rule", at});
      if (micro && st.code !== "layer" && st.hi - st.lo > (r.allowSkip === false ? 1 : 2)) flag(r, {id:v.id, title, what:"Microvia span", detail:"A microvia spans " + (st.hi - st.lo) + " dielectrics; laser vias reach one" + (r.allowSkip === false ? "" : " or two (skip via)"), at});
      const e = vip.get(v) || (v.viaInPad ? {via:v, pad:null, filled:HDI_IPC.has(ipcOf(v).id)} : null);
      if (e && r.requireFill !== false && !e.filled) flag(r, {id:v.id, title, what:"Via in pad", detail:"Via in pad" + (e.pad ? " " + (e.pad.ref ? e.pad.ref + "-" : "") + (e.pad.number ?? "") : "") + " is not filled (IPC-4761 Type " + ipcCode(v) + "); fill it, ideally Type VII filled and capped, so solder does not wick into the hole", at});
    }
    if (hv) {
      for (const s of viaStacks(doc, defs, keys, c)) {
        const r = first("hdiVias", target(s.vias[0]));
        if (!r) continue;
        const max = Number.isInteger(r.maxStacked) ? r.maxStacked : 2;
        if (s.microvias > max) flag(r, {id:s.ids[0], otherId:s.ids.at(-1), title:"Stacked vias " + (s.vias[0].net || "(no net)") + " (" + L(s.from) + "–" + L(s.to) + ")", what:"Stacked microvias",
          detail:s.microvias + " microvias stacked at one point exceed the limit of " + max + "; stagger them", at:s.at});
        if (c?.stacking === "staggered" && s.microvias > 1) flag(r, {id:s.ids[0], title:"Stacked vias " + (s.vias[0].net || "(no net)"), what:"Stacked microvias", detail:"The " + hdiName(c) + " build-up is set to staggered microvias", at:s.at});
      }
      staggerCheck(doc, keys, c, first, flag, target, L);
    }
    if (hv && !c) notes.push("The board has no HDI build-up (Design › HDI Via Setup…): drill-pair lamination and controlled-depth checks were skipped.");
  }
  // Staggered microvias of one net on adjacent pairs that share a layer must sit at least
  // minStagger apart (centre to centre) so neither lands on the other's dimple.
  function staggerCheck(doc, keys, c, first, flag, target, L) {
    const micro = (doc?.items || []).filter(v => v.kind === "via" && laserLike(v, keys, c));
    if (micro.length < 2) return;
    const cell = 1, grid = new Map(), keyOf = (x, y) => Math.floor(x / cell) + "," + Math.floor(y / cell);
    for (const v of micro) {const k = keyOf(v.x, v.y); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(v);}
    const seen = new Set();
    for (const v of micro) {
      const r = first("hdiVias", target(v)), min = r?.minStagger;
      if (!(min > 0)) continue;
      const [a, b] = spanOf(v), cx = Math.floor(v.x / cell), cy = Math.floor(v.y / cell), reach = Math.ceil(min / cell);
      for (let i = cx - reach; i <= cx + reach; i++) for (let j = cy - reach; j <= cy + reach; j++) for (const w of grid.get(i + "," + j) || []) {
        if (w === v || w.net !== v.net) continue;
        const pair = v.id < w.id ? v.id + "|" + w.id : w.id + "|" + v.id;
        if (seen.has(pair)) continue;
        const [c2, d2] = spanOf(w), shared = b === c2 || d2 === a;
        const d = Math.hypot(v.x - w.x, v.y - w.y);
        if (!shared || d < 1e-3 || d + EPS >= min) continue;
        seen.add(pair);
        flag(r, {id:v.id, otherId:w.id, title:"Staggered microvias " + (v.net || "(no net)") + " (" + L(a) + "–" + L(b) + ", " + L(c2) + "–" + L(d2) + ")", what:"Microvia stagger", actual:round(d), required:min, limit:"min", at:[v.x, v.y], otherAt:[w.x, w.y]});
      }
    }
  }
  // Fabrication notes for HDI construction (fab-outputs.js Readme and drill report).
  // [] for a board without a build-up, blind, buried, micro or back-drilled vias.
  function hdiNotes(doc, defs, o = {}) {
    const keys = keysOf(doc, null, defs), c = hdiConfig(doc, defs, keys), last = keys.length - 1, out = [];
    const vias = (doc?.items || []).filter(v => v.kind === "via");
    const special = vias.filter(v => {const [a, b] = spanOf(v); return a !== keys[0] || b !== keys[last] || v.backdrill || v.microvia === true || isMicrovia(v, keys);});
    if (!c && !special.length) return out;
    const L = k => "L" + (keys.indexOf(k) + 1);
    if (c) {
      const list = stages(doc, defs, c), n = laminations(c, list);
      out.push("Construction: " + hdiName(c) + " sequential build-up, " + keys.length + " copper layers, " + n + " lamination" + (n === 1 ? "" : "s") + ": " +
        list.map(s => (s.kind === "core" ? "core " : "") + L(s.from) + "-" + L(s.to)).join(", then ") + ".");
      out.push("Microvias: laser drilled, " + (c.stacking === "staggered" ? "staggered" : "stacked microvias copper filled") + "; skip vias " + (c.skip ? "allowed" : "not used") + ".");
    }
    const pairs = definedPairs(doc, defs), spans = new Map();
    for (const v of special) {
      const [a, b] = spanOf(v), st = spanStatus(doc, a, b, defs, c, pairs), k = a + "|" + b;
      if (a === keys[0] && b === keys[last]) continue;
      if (!spans.has(k)) spans.set(k, {a, b, st, vias:[], laser:0, drills:new Set(), ipc:new Map()});
      const e = spans.get(k);
      e.vias.push(v); if (isLaser(v, keys, st)) e.laser++;
      e.drills.add(round(v.drill || 0));
      const t = ipcCode(v); if (t !== "None") e.ipc.set(t, (e.ipc.get(t) || 0) + 1);
    }
    for (const e of [...spans.values()].sort((p, q) => keys.indexOf(p.a) - keys.indexOf(q.a) || keys.indexOf(p.b) - keys.indexOf(q.b))) {
      const s = e.vias.length === 1 ? "" : "s";
      const kind = e.laser === e.vias.length ? (e.st.skip ? "laser skip via" : "laser microvia") + s : e.laser ? "via" + s + " (" + e.laser + " laser)" : e.st.kind + " via" + s + (e.st.method === "controlled-depth" ? ", controlled-depth drilled" : "");
      out.push("Drill span " + L(e.a) + "-" + L(e.b) + " (" + e.a + " - " + e.b + "): " + e.vias.length + " " + kind + ", drill " + [...e.drills].sort((x, y) => x - y).join(", ") + " mm" +
        (e.ipc.size ? ", IPC-4761 " + [...e.ipc].map(([t, n]) => "Type " + t + " x" + n).join(", ") : "") + (e.st.stage != null && c ? e.st.stage ? ", drilled after build-up step " + e.st.stage : ", drilled in the core" : "") +
        (!e.st.ok ? " - not buildable in this build-up" : e.st.stored && !e.st.defined ? " - not a drill pair of the layer stack" : "") + ".");
    }
    const stacks = viaStacks(doc, defs, keys, c).filter(s => s.microvias > 1);
    if (stacks.length) out.push("Stacked microvias: " + stacks.length + " site" + (stacks.length === 1 ? "" : "s") + ", up to " + Math.max(...stacks.map(s => s.microvias)) + " high; fill every microvia below another with copper.");
    const vip = viasInPads(doc, defs, keys);
    if (vip.length) {
      const open = vip.filter(e => !e.filled).length;
      out.push("Via-in-pad: " + vip.length + " via" + (vip.length === 1 ? "" : "s") + " in SMD pads; fill (IPC-4761 Type VII: filled, planarised and plated over) before final plating." + (open ? " " + open + (open === 1 ? " is" : " are") + " not filled." : ""));
    }
    const ipc = new Map();
    for (const v of vias) {const t = ipcCode(v); if (t !== "None") ipc.set(t, (ipc.get(t) || 0) + 1);}
    if (ipc.size) out.push("Via protection (IPC-4761): " + [...ipc].sort().map(([t, n]) => "Type " + t + " (" + (IPC[t.replace(/[ab]$/, "")]?.label.split(" · ")[1] || t) + ") x" + n).join(", ") + ".");
    const bd = vias.filter(v => plain(v.backdrill));
    if (bd.length) {
      const rows = new Map();
      for (const v of bd) {const k = (v.backdrill.from === "bottom" ? "bottom" : "top") + "|" + v.backdrill.toLayer; if (!rows.has(k)) rows.set(k, []); rows.get(k).push(v);}
      for (const [k, list] of rows) {
        const [side, stop] = k.split("|"), stub = Math.max(...list.map(v => finite(v.backdrill.stubMax) ? v.backdrill.stubMax : .2));
        out.push("Back-drill: " + list.length + " via" + (list.length === 1 ? "" : "s") + " from the " + side + ", keep " + L(stop) + " " + stop + " connected, max stub " + round(stub) + " mm.");
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- templates
  const FIELDS = ["diameter", "drill", "stackMode", "padStack", "shape", "fromLayer", "toLayer", "microvia", "tent", "maskExpansion", "ipc4761", "ipcSides", "viaInPad", "backdrill"];
  const copy = v => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
  const newId = () => globalThis.Atrium.id();
  const BUILTIN = Object.freeze([
    {id:"stock-030-015-tented", name:"0.3/0.15 Tented", diameter:.3, drill:.15, ipc4761:"I", ipcSides:"both", tent:{top:true, bottom:true}, comment:"Small signal via, mask over both sides."},
    {id:"stock-045-020-through", name:"0.45/0.2 Through", diameter:.45, drill:.2, comment:"General through via; mask follows the output setting."},
    {id:"stock-blind-12-uvia", name:"Blind 1-2 µvia 0.25/0.1", diameter:.25, drill:.1, fromLayer:"Top", toLayer:"Inner 1", microvia:true, ipc4761:"VII", comment:"Laser microvia, Top to the first inner layer, copper filled."},
    {id:"stock-vip-035-020", name:"VIP 0.35/0.2 Filled+Capped", diameter:.35, drill:.2, ipc4761:"VII", viaInPad:true, comment:"Via-in-pad, IPC-4761 Type VII (filled and capped)."}
  ].map(t => Object.freeze({...t, builtin:true})));
  function cleanTemplate(raw) {
    if (!plain(raw)) throw Error("A via template must be an object.");
    const name = String(raw.name ?? "").trim();
    if (!name || name.length > 128) throw Error("Each via template needs a name of up to 128 characters.");
    const t = {id:typeof raw.id === "string" && raw.id && raw.id.length <= 128 ? raw.id : newId(), name};
    const len = (k, min = 0, max = 50) => {const v = raw[k]; if (v == null) return; if (!finite(v) || v < min || v > max) throw Error(name + ": " + k + " must be between " + min + " and " + max + " mm."); t[k] = round(v);};
    len("diameter", 0.01); len("drill", 0.01);
    if (!(t.diameter > 0 && t.drill > 0)) throw Error(name + ": a template needs a diameter and a drill.");
    if (t.drill >= t.diameter) throw Error(name + ": the drill must be smaller than the diameter.");
    if (raw.stackMode != null) {if (!MODES.some(([m]) => m === raw.stackMode)) throw Error(name + ": unknown stack mode."); if (raw.stackMode !== "simple") t.stackMode = raw.stackMode;}
    if (raw.padStack != null && t.stackMode) {
      if (!plain(raw.padStack) || Object.keys(raw.padStack).length > 40) throw Error(name + ": invalid pad stack.");
      t.padStack = {};
      for (const [k, row] of Object.entries(raw.padStack)) {
        if (!(isCopper(k) || k === "Mid") || !plain(row) || !finite(row.diameter) || row.diameter <= 0 || row.diameter > 50) throw Error(name + ": invalid pad stack row " + k + ".");
        t.padStack[k] = {diameter:round(row.diameter), ...(SHAPES.some(([s]) => s === row.shape) && row.shape !== "round" ? {shape:row.shape} : {})};
      }
    }
    if (SHAPES.some(([s]) => s === raw.shape) && raw.shape !== "round") t.shape = raw.shape;
    for (const k of ["fromLayer", "toLayer"]) if (raw[k] != null) {if (!isCopper(raw[k])) throw Error(name + ": " + k + " must be a copper layer."); t[k] = raw[k];}
    if ((t.fromLayer == null) !== (t.toLayer == null) || t.fromLayer && t.fromLayer === t.toLayer) throw Error(name + ": give both span layers or neither.");
    if (typeof raw.microvia === "boolean") t.microvia = raw.microvia;
    if (raw.tent != null) {
      if (!plain(raw.tent)) throw Error(name + ": invalid tenting.");
      const tent = {};
      for (const s of ["top", "bottom"]) if (typeof raw.tent[s] === "boolean") tent[s] = raw.tent[s];
      if (Object.keys(tent).length) t.tent = tent;
    }
    len("maskExpansion", -1, 1);
    if (raw.ipc4761 != null) {if (!IPC[raw.ipc4761]) throw Error(name + ": unknown IPC-4761 type."); if (raw.ipc4761 !== "none") t.ipc4761 = raw.ipc4761;}
    if (raw.ipcSides != null && t.ipc4761) {if (!["top", "bottom", "both"].includes(raw.ipcSides)) throw Error(name + ": IPC sides must be top, bottom or both."); t.ipcSides = raw.ipcSides;}
    if (raw.viaInPad === true) t.viaInPad = true;
    if (raw.backdrill != null) {
      const b = raw.backdrill;
      if (!plain(b) || !["top", "bottom"].includes(b.from) || !isCopper(b.toLayer)) throw Error(name + ": back-drill needs a side and a stop layer.");
      t.backdrill = {from:b.from, toLayer:b.toLayer};
      for (const k of ["stubMax", "diameter"]) if (b[k] != null) {if (!finite(b[k]) || b[k] < 0 || b[k] > 10) throw Error(name + ": invalid back-drill " + k + "."); t.backdrill[k] = round(b[k]);}
    }
    if (raw.comment != null) t.comment = String(raw.comment).slice(0, 2000);
    if (raw.profile != null) t.profile = String(raw.profile).slice(0, 128);
    return t;
  }
  // Copies a template's construction onto a via (keeps id, position, net).
  function applyTemplate(via, template) {
    const t = template.builtin ? template : cleanTemplate(template);
    for (const k of FIELDS) {
      if (k === "diameter" || k === "drill") {via[k] = t[k]; continue;}
      if (t[k] === undefined) delete via[k]; else via[k] = copy(t[k]);
    }
    via.template = t.id;
    return via;
  }
  function fromVia(via, meta = {}) {
    const raw = {id:meta.id, name:meta.name || "Via " + round(via.diameter) + "/" + round(via.drill), comment:meta.comment};
    for (const k of FIELDS) if (via[k] !== undefined) raw[k] = copy(via[k]);
    return cleanTemplate(raw);
  }
  function emptyLibrary() {return {version:1, list:[], defaults:{via:null, diffPair:null, netClasses:{}}};}
  function cleanLibrary(raw) {
    if (raw == null) return emptyLibrary();
    if (!plain(raw) || !Array.isArray(raw.list) || raw.list.length > 1000) throw Error("Choose a Waffle via template library.");
    const lib = emptyLibrary(), ids = new Set();
    for (const t of raw.list) {const c = cleanTemplate(t); if (ids.has(c.id)) c.id = newId(); ids.add(c.id); lib.list.push(c);}
    const d = plain(raw.defaults) ? raw.defaults : {};
    for (const k of ["via", "diffPair"]) if (typeof d[k] === "string") lib.defaults[k] = d[k];
    if (plain(d.netClasses)) for (const [c, id] of Object.entries(d.netClasses)) if (typeof id === "string" && c) lib.defaults.netClasses[c] = id;
    return lib;
  }
  // The board's library; created on demand when `create` is set.
  function library(doc, create) {
    if (!doc) return emptyLibrary();
    if (!plain(doc.viaTemplates)) {if (!create) return emptyLibrary(); doc.viaTemplates = emptyLibrary();}
    const lib = doc.viaTemplates;
    if (!Array.isArray(lib.list)) lib.list = [];
    if (!plain(lib.defaults)) lib.defaults = {via:null, diffPair:null, netClasses:{}};
    if (!plain(lib.defaults.netClasses)) lib.defaults.netClasses = {};
    return lib;
  }
  // Board templates, then project templates, then the stock list. Each entry
  // carries a non-enumerable `source` ("board" | "project" | "builtin").
  function templates(doc, project) {
    const out = [], seen = new Set();
    const push = (t, source) => {if (seen.has(t.id)) return; seen.add(t.id); const c = {...t}; Object.defineProperty(c, "source", {value:source, enumerable:false}); out.push(c);};
    for (const t of library(doc).list) push(t, "board");
    for (const t of plain(project?.viaTemplates) && Array.isArray(project.viaTemplates.list) ? project.viaTemplates.list : []) push(t, "project");
    for (const t of BUILTIN) push(t, "builtin");
    return out;
  }
  const find = (doc, id, project) => id ? templates(doc, project).find(t => t.id === id) || null : null;
  function addTemplate(doc, raw) {const t = cleanTemplate({...raw, id:raw.id && !find(doc, raw.id) ? raw.id : undefined}); library(doc, true).list.push(t); return t;}
  function updateTemplate(doc, id, patch) {
    const lib = library(doc, true), i = lib.list.findIndex(t => t.id === id);
    if (i < 0) throw Error("That template is not stored on this board.");
    const next = cleanTemplate({...lib.list[i], ...patch, id});
    lib.list[i] = next;
    return next;
  }
  function duplicateTemplate(doc, id, project) {
    const t = find(doc, id, project);
    if (!t) throw Error("Template not found.");
    const names = new Set(templates(doc, project).map(x => x.name.toLowerCase()));
    let name = t.name + " copy", n = 2;
    while (names.has(name.toLowerCase())) name = t.name + " copy " + n++;
    const {builtin, ...rest} = t;
    return addTemplate(doc, {...rest, id:undefined, name});
  }
  function removeTemplate(doc, id) {
    const lib = library(doc, true), before = lib.list.length;
    lib.list = lib.list.filter(t => t.id !== id);
    if (lib.defaults.via === id) lib.defaults.via = null;
    if (lib.defaults.diffPair === id) lib.defaults.diffPair = null;
    for (const [c, v] of Object.entries(lib.defaults.netClasses)) if (v === id) delete lib.defaults.netClasses[c];
    return before !== lib.list.length;
  }
  // role: "via" | "diffPair" | "netClass" (with key = class name).
  function setDefault(doc, role, id, key) {
    const lib = library(doc, true);
    if (id != null && !find(doc, id)) throw Error("Template not found.");
    if (role === "netClass") {if (id) lib.defaults.netClasses[key] = id; else delete lib.defaults.netClasses[key];}
    else if (role === "via" || role === "diffPair") lib.defaults[role] = id || null;
    else throw Error("Unknown default " + role + ".");
  }
  // The template a new via on `net` should use: diff pair, then net class, then board default.
  function defaultFor(doc, o = {}) {
    const lib = library(doc), project = o.project, pick = id => id ? find(doc, id, project) : null;
    const net = o.net || "";
    if (net && globalThis.AtriumRules) {
      try {
        if (lib.defaults.diffPair && (o.role === "diffPair" || AtriumRules.diffPairs(doc, {project}).some(p => p.positive === net || p.negative === net))) return pick(lib.defaults.diffPair);
        const classes = AtriumRules.netClasses(doc, {project});
        for (const [cls, members] of Object.entries(classes)) if (lib.defaults.netClasses[cls] && members.includes(net)) return pick(lib.defaults.netClasses[cls]);
      } catch {/* rules unavailable: fall back to the board default */}
    } else if (o.role === "diffPair" && lib.defaults.diffPair) return pick(lib.defaults.diffPair);
    return pick(lib.defaults.via);
  }
  // A new via at x,y for the via tool: the default template, else the
  // preferred Routing Via Style values, else Waffle's 0.84/0.4.
  function place(doc, o, opt = {}) {
    const via = {id:o.id, kind:"via", x:o.x, y:o.y, diameter:.84, drill:.4, layer:"Multi", net:o.net || ""};
    const t = defaultFor(doc, {net:via.net, project:opt.project, role:opt.role});
    if (t) applyTemplate(via,t);
    const resolver=globalThis.AtriumRules?.resolver?.(doc,{project:opt.project,defs:opt.defs});
    if (!resolver) return via;
    const at = [via.x,via.y], span = spanOf(via).map(copperIndex).sort((a,b) => a-b);
    const limits = resolver.viaLimits(via.net,via,at,span);
    if (!opt.obeyRules) {
      if (!t) {
        if(limits.diameter>0)via.diameter=limits.diameter;
        if(limits.drill>0&&limits.drill<via.diameter)via.drill=limits.drill;
      }
      return via;
    }
    const size=AtriumRules.sizeVia([limits],via,t?via:null);
    if (!size.legal) throw Error("The selected via diameter and drill do not meet the board's design rules.");
    via.diameter = size.diameter; via.drill = size.drill;
    const final = resolver.viaLimits(via.net,via,at,span);
    const land = via.stackMode ? minDiameter(via,keysOf(doc,via,opt.defs)) : via.diameter;
    if (!globalThis.Atrium.viaSize([final],via,true).legal || (land-via.drill)/2 < final.ring-EPS)
      throw Error("The selected via does not meet the design rules on every layer of its span.");
    return via;
  }
  function exportLibrary(doc) {return JSON.stringify({format:"atrium-via-templates", version:1, ...cleanLibrary(library(doc))}, null, 2);}
  function importLibrary(doc, text, mode = "merge") {
    const raw = typeof text === "string" ? JSON.parse(text) : text;
    if (raw?.format !== "atrium-via-templates") throw Error("Choose a Waffle via template file.");
    const lib = cleanLibrary(raw), target = library(doc, true);
    if (mode === "replace") {target.list = lib.list; target.defaults = lib.defaults; return lib.list.length;}
    for (const t of lib.list) {target.list = target.list.filter(x => x.id !== t.id); target.list.push(t);}
    return lib.list.length;
  }
  function describe(t, fmt = v => round(v) + " mm") {
    const parts = [fmt(t.diameter) + " / " + fmt(t.drill)];
    if (t.fromLayer) parts.push(t.fromLayer + "–" + t.toLayer);
    if (t.microvia) parts.push("µvia");
    if (modeOf(t) !== "simple") parts.push(modeOf(t) === "tmb" ? "T-M-B" : "Full stack");
    if (t.ipc4761 && t.ipc4761 !== "none") parts.push("IPC " + ipcCode(t));
    else if (t.tent) parts.push(t.tent.top && t.tent.bottom ? "tented" : t.tent.top === false && t.tent.bottom === false ? "open" : "tent " + (t.tent.top ? "top" : "bottom"));
    if (t.viaInPad) parts.push("via-in-pad");
    if (t.backdrill) parts.push("back-drill " + t.backdrill.from);
    return parts.join(" · ");
  }

  // ---------------------------------------------------------------- canvas marks
  // A via on the board is its copper ring and one dark drill (canvas.js drawPad). Once the drill is
  // 6 px across, a filled or plugged via shows its drill closed (a lighter, filled disc; copper-toned
  // when capped) and a back-drilled via a thin ring at the drill's edge. Tenting draws nothing: it is
  // the common case, and the inspector, the hover line and the cross-section show it.
  function hasMark(via) {
    const t = ipcOf(via);
    return !!(t.filled || t.plugged || via.backdrill);
  }
  const MARK_DRILL_PX = 6;
  function markGeometry(via) {
    const t = ipcOf(via), diameter = via.drill || 0;
    const fill = t.filled || t.plugged ? (t.capped ? "#b58a4c" : "#6e737a") : null;
    const ring = via.backdrill ? "#e06c75" : null;
    if (!diameter || (!fill && !ring)) return null;
    return {diameter, fill, ring, ringWidth: diameter * .08, minRingPx: 1, minDrillPx: MARK_DRILL_PX};
  }
  function paintMarks(ctx, via, scale, record) {
    const shown = (via.drill || 0) * scale >= MARK_DRILL_PX;
    if (!shown && !record) return;
    const mark = markGeometry(via);
    if (!mark) return;
    record?.(via, mark);
    if (!shown) return;
    const r = mark.diameter / 2;
    ctx.save();
    if (mark.fill) {
      ctx.beginPath(); ctx.arc(via.x, via.y, r, 0, Math.PI * 2);
      ctx.fillStyle = mark.fill; ctx.fill();
    }
    if (mark.ring) {
      ctx.lineWidth = Math.max(mark.minRingPx / scale, mark.ringWidth);
      ctx.strokeStyle = mark.ring; ctx.beginPath(); ctx.arc(via.x, via.y, Math.max(0, r - ctx.lineWidth / 2), 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------- cross-section SVG
  const COLORS = {copper:"#c8893a", copperCut:"#6b4a26", core:"#55613f", prepreg:"#6b7a4c", mask:"#2f7a45", hole:"#1b1c1e", fill:"#9aa0a6", cap:"#e0a458", stub:"#e06c75", back:"#2a1c1f"};
  // XML text and double-quoted attributes; control characters are not allowed in XML 1.0.
  const esc = s => String(s).replace(/[&<>"]/g, c => ({"&":"&amp;", "<":"&lt;", ">":"&gt;", "\"":"&quot;"}[c])).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  // section(via, board, defs, {format, expansion}) -> SVG markup (string). Layer
  // heights are scaled from the stack with a floor so thin copper stays visible.
  function section(via, source, defs, o = {}) {
    const fmt = o.format || (v => round(v) + ""), P = physical(source, defs), M = measure(via, source, defs);
    const rows = P.layers.filter(l => l.t > 0 && l.type !== "Overlay" && l.type !== "Surface Finish");
    const W = 480, X0 = 66, X1 = 300, cx = (X0 + X1) / 2, RX = 308;
    const hOf = l => l.copper ? 12 : l.type === "Solder Mask" ? 7 : Math.max(14, Math.min(56, l.t * 110));
    let y = 8;
    const Y = new Map();
    for (const l of rows) {Y.set(l, {y, h:hOf(l)}); y += hOf(l);}
    const bodyEnd = y, spanD = Math.max(via.diameter || .5, ...Object.values(via.padStack || {}).map(r => r.diameter || 0), via.backdrill?.diameter || 0, (via.drill || 0) + BACKDRILL_OVERSIZE);
    const k = 200 / spanD, half = d => d * k / 2, n = v => Math.round(v * 10) / 10;
    const [a, b] = spanOf(via), A = P.copper.get(a), B = P.copper.get(b);
    const zy = z => {for (const l of rows) {const r = Y.get(l); if (z <= l.z + l.t + 1e-9) return r.y + r.h * Math.max(0, Math.min(1, (z - l.z) / (l.t || 1)));} return bodyEnd;};
    const yTop = A && Y.get(A) ? Y.get(A).y : zy(M.top), yBot = B && Y.get(B) ? Y.get(B).y + Y.get(B).h : zy(M.bottom);
    const parts = [], drill = half(via.drill || 0), wall = Math.max(1.5, Math.min(3, drill * .18)), t = ipcOf(via);
    const rect = (x, y0, w, h, attrs) => parts.push("<rect x=\"" + n(x) + "\" y=\"" + n(y0) + "\" width=\"" + n(Math.max(0, w)) + "\" height=\"" + n(Math.max(0, h)) + "\" " + attrs + "/>");
    const text = (x, y0, str, cls, anchor) => parts.push("<text x=\"" + n(x) + "\" y=\"" + n(y0) + "\" class=\"" + cls + "\"" + (anchor ? " text-anchor=\"" + anchor + "\"" : "") + ">" + esc(str) + "</text>");
    // Board layers with their names on the right.
    for (const l of rows) {
      const r = Y.get(l), mid = r.y + r.h / 2 + 3.5;
      if (l.copper) {
        rect(X0, r.y, X1 - X0, r.h, "fill=\"" + COLORS.copper + "\" opacity=\".22\"");
        const named = l.name && !new RegExp("^" + l.key + "( layer)?$", "i").test(l.name) ? " · " + l.name : "";
        text(RX, mid, (l.key + named).slice(0, 26), "vs-lbl vs-cu");
      } else if (l.type === "Solder Mask") rect(X0, r.y, X1 - X0, r.h, "fill=\"" + COLORS.mask + "\"");
      else {
        rect(X0, r.y, X1 - X0, r.h, "fill=\"" + (l.dielectric === "Prepreg" ? COLORS.prepreg : COLORS.core) + "\" opacity=\".55\"");
        if (r.h >= 14) text(RX, mid, (l.dielectric || "Dielectric") + " " + fmt(l.t), "vs-lbl");
      }
    }
    // Drill hole, fill or plug, plating walls and caps.
    if (drill > 0) {
      rect(cx - drill, yTop, 2 * drill, yBot - yTop, "fill=\"" + COLORS.hole + "\"");
      if (t.filled) rect(cx - drill + wall, yTop, 2 * drill - 2 * wall, yBot - yTop, "fill=\"url(#vs-hatch)\"");
      else if (t.plugged) {
        const sides = via.ipcSides || "both", depth = (yBot - yTop) * .3;
        if (sides !== "bottom") rect(cx - drill + wall, yTop, 2 * drill - 2 * wall, depth, "fill=\"url(#vs-hatch)\"");
        if (sides !== "top") rect(cx - drill + wall, yBot - depth, 2 * drill - 2 * wall, depth, "fill=\"url(#vs-hatch)\"");
      }
      rect(cx - drill, yTop, wall, yBot - yTop, "fill=\"" + COLORS.copper + "\"");
      rect(cx + drill - wall, yTop, wall, yBot - yTop, "fill=\"" + COLORS.copper + "\"");
    }
    // Lands per copper layer; diameters on the left.
    for (const l of rows) {
      if (!l.copper) continue;
      const r = Y.get(l), d = diameterOn(via, l.key), mid = r.y + r.h / 2 + 3.5;
      if (d > 0) {
        rect(cx - half(d), r.y, half(d) - drill, r.h, "fill=\"" + COLORS.copper + "\"");
        rect(cx + drill, r.y, half(d) - drill, r.h, "fill=\"" + COLORS.copper + "\"");
        text(X0 - 6, mid, "⌀" + fmt(d), "vs-dim", "end");
      } else if (backdrilled(via, l.key)) text(X0 - 6, mid, "cut", "vs-dim vs-warn", "end");
    }
    // Back-drill: the oversize tool path and the remaining stub.
    const bd = M.backdrill;
    if (bd) {
      const r = half(bd.drill), y0 = zy(Math.min(bd.start, bd.end)), y1 = zy(Math.max(bd.start, bd.end));
      rect(cx - r, y0, 2 * r, Math.max(1, y1 - y0), "fill=\"" + COLORS.back + "\" stroke=\"" + COLORS.stub + "\" stroke-dasharray=\"3 2\"");
      const stop = P.copper.get(bd.stopLayer), sr = stop && Y.get(stop);
      if (sr) {
        const sy = bd.side === "top" ? sr.y : sr.y + sr.h, ey = bd.side === "top" ? y1 : y0;
        rect(cx - drill, Math.min(sy, ey), 2 * drill, Math.max(1.5, Math.abs(ey - sy)), "fill=\"" + COLORS.stub + "\" opacity=\".85\"");
      }
    }
    // Solder mask over or around the via on each outer side.
    for (const side of ["top", "bottom"]) {
      if (!(side === "top" ? a === P.keys[0] : b === P.keys.at(-1))) continue;
      const m = maskOpening(via, side, finite(o.expansion) ? o.expansion : 0.1016);
      const maskRow = side === "top" ? rows.find(l => l.type === "Solder Mask" && l.z < (A?.z ?? 0) + 1e-9) : [...rows].reverse().find(l => l.type === "Solder Mask" && l.z >= (B ? B.z + B.t : M.bottom) - 1e-9);
      if (!maskRow || m.open === false) continue;
      const r = Y.get(maskRow), w = half(m.diameter || m.land || via.diameter);
      rect(cx - w, r.y, 2 * w, r.h, "class=\"vs-open\"" + (m.open === null ? " stroke=\"" + COLORS.mask + "\" stroke-dasharray=\"2 2\"" : ""));
    }
    // Copper caps over filled holes (Type VII) sit on top of the mask opening.
    if (drill > 0 && t.capped) {
      if (a === P.keys[0]) rect(cx - drill, yTop - 3, 2 * drill, 3.5, "fill=\"" + COLORS.cap + "\" stroke=\"#fff3\"");
      if (b === P.keys.at(-1)) rect(cx - drill, yBot - .5, 2 * drill, 3.5, "fill=\"" + COLORS.cap + "\" stroke=\"#fff3\"");
    }
    // Legend.
    const lines = [
      (t.id === "none" ? "No IPC-4761 type" : "IPC-4761 " + ipcCode(via) + " · " + t.label.replace(/^Type \S+ · /, "")) + (via.viaInPad ? " · via-in-pad" : ""),
      (isMicrovia(via, P.keys) ? "Microvia · " : "") + "Aspect " + (Number.isFinite(M.aspect) ? M.aspect.toFixed(2) + ":1" : "—") + " · barrel " + fmt(M.depth) + " · board " + fmt(P.total),
      "Mask: " + maskWord(maskOpening(via, "top", 0)) + " top, " + maskWord(maskOpening(via, "bottom", 0)) + " bottom"
    ];
    if (bd) lines.push("Back-drill ⌀" + fmt(bd.drill) + " from " + bd.side + ", " + fmt(bd.depth) + " deep, stub ≤ " + fmt(bd.stubMax));
    let ly = bodyEnd + 18;
    for (const line of lines) {text(8, ly, line, "vs-legend"); ly += 15;}
    const H = ly - 4;
    parts.unshift("<svg xmlns=\"http://www.w3.org/2000/svg\" class=\"vs-svg\" viewBox=\"0 0 " + W + " " + H + "\" role=\"img\" aria-label=\"Via cross-section\">",
      "<defs><pattern id=\"vs-hatch\" width=\"5\" height=\"5\" patternUnits=\"userSpaceOnUse\" patternTransform=\"rotate(45)\"><rect width=\"5\" height=\"5\" fill=\"" + COLORS.fill + "\"/><line x1=\"0\" y1=\"0\" x2=\"0\" y2=\"5\" stroke=\"#6c7177\" stroke-width=\"2\"/></pattern></defs>");
    parts.push("</svg>");
    return parts.join("");
  }
  const maskWord = m => m.diameter === 0 && m.source === "inner" ? "no mask" : m.open === null ? "mask per output" : m.open ? "mask open" : "tented";

  // ---------------------------------------------------------------- dialogs
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  function button(text, act, cls, title) {const b = el("button", text, cls); if (!b.classList.contains("ui-segment")) b.classList.add("ui-button"); b.type = "button"; b.onclick = act; if (title) b.title = title; return b;}
  function selectOf(options, value, label) {
    const s = el("select", null, "ui-field", {"aria-label":label});
    for (const [v, t] of options) s.add(new Option(t, v));
    s.value = value; return s;
  }
  function unitsFor(ctx) {
    const U = globalThis.Atrium?.units, unit = U ? U.normal(ctx.project?.units) : "mm";
    return {unit, show:mm => U ? String(U.value(mm, unit)) : String(round(mm)), parse:t => U ? U.parse(t, unit) : Number(t),
      fmt:mm => U ? U.format(mm, unit, unit === "mil" ? 1 : 3) : round(mm) + "mm"};
  }
  // The editor panel shared by the Via Stack dialog and the template library.
  // state: a via-like object edited in place. Returns {node, paint}.
  function stackEditor(state, ctx, onChange, opt = {}) {
    const doc = ctx.doc, defs = ctx.defs, u = unitsFor(ctx), keys = keysOf(doc, state, defs);
    const root = el("div", null, "vs-editor"), form = el("div", null, "vs-form"), side = el("div", null, "vs-side");
    const pic = el("div", null, "vs-section"), msgs = el("ul", null, "vs-msgs", {"aria-live":"polite"});
    side.append(pic, msgs); root.append(form, side);
    const changed = () => {onChange?.(); paint();};
    const num = (label, get, set, o = {}) => {
      const w = el("label", null, "vs-field vs-measure"), i = el("input", null, "vs-num ui-field ui-field-number", {type:"text", inputmode:"decimal", "aria-label":label});
      i.dataset.unit = u.unit;
      i.value = get() == null ? "" : u.show(get());
      i.onchange = () => {
        const t = i.value.trim();
        if (!t && o.optional) {set(null); changed(); return;}
        const v = u.parse(t);
        if (!Number.isFinite(v) || v < (o.min ?? 0)) {i.value = get() == null ? "" : u.show(get()); i.setCustomValidity?.("Enter a length"); return;}
        i.setCustomValidity?.(""); set(round(v)); changed(); i.value = u.show(get());
      };
      const measurement = el("span", null, "ui-field-measure");
      measurement.append(i, el("span", u.unit, "ui-field-unit"));
      w.append(el("span", label, "vs-k"), measurement);
      return w;
    };
    function paint() {
      const r = validate(state, doc, {defs, project:ctx.project, rules:opt.rules});
      pic.innerHTML = section(state, doc, defs, {format:u.fmt});
      msgs.replaceChildren();
      for (const m of r.messages) msgs.append(el("li", m.text, "vs-msg vs-" + m.level));
      if (!r.messages.some(m => m.level !== "info")) msgs.prepend(el("li", "No problems: rings " + (r.rings.filter(x => x.ring != null).map(x => u.fmt(x.ring)).join(", ") || "—") + "; aspect " + (Number.isFinite(r.aspect) ? r.aspect.toFixed(2) : "—") + ":1 (limit " + r.maxAspect + ":1).", "vs-msg vs-ok"));
      table();
    }
    // Span and drill.
    const spanRow = el("div", null, "vs-row");
    const spanOpts = [...keys.map(k => [k, k]), ...spanOf(state).filter(k => !keys.includes(k)).map(k => [k, k + " (not in stack)"])];
    const from = selectOf(spanOpts, spanOf(state)[0], "Start layer"), to = selectOf(spanOpts, spanOf(state)[1], "End layer");
    const setSpan = () => {
      const a = from.value, b = to.value;
      if (a === b) {to.value = spanOf(state)[1]; from.value = spanOf(state)[0]; return;}
      if (a === keys[0] && b === keys.at(-1)) {delete state.fromLayer; delete state.toLayer;} else {state.fromLayer = a; state.toLayer = b;}
      if (modeOf(state) !== "simple") setMode(state, modeOf(state), keys);
      changed();
    };
    from.onchange = to.onchange = setSpan;
    const micro = el("input", null, "ui-checkbox", {type:"checkbox", "aria-label":"Microvia"});
    micro.checked = isMicrovia(state, keys);
    micro.onchange = () => {state.microvia = micro.checked; changed();};
    const ml = el("label", null, "vs-check"); ml.append(micro, el("span", "Laser µvia"));
    spanRow.append(el("span", "Span", "vs-k"), from, el("span", "→"), to, ml);
    form.append(spanRow);
    const sizes = el("div", null, "vs-row");
    sizes.append(num("Drill", () => state.drill, v => {state.drill = v;}, {min:.01}));
    const diaField = num("Diameter", () => state.diameter, v => {state.diameter = v; if (modeOf(state) !== "simple") {for (const r of Object.values(state.padStack || {})) r.diameter = v;}}, {min:.01});
    sizes.append(diaField);
    form.append(sizes);
    // Mode and per-layer table.
    const modeRow = el("div", null, "vs-row vs-modes ui-segmented", {role:"radiogroup", "aria-label":"Pad stack mode"});
    const modeBtns = MODES.map(([m, label]) => {
      const b = button(m === "tmb" ? "Top-Mid-Bottom" : m === "full" ? "Full Stack" : label, () => {setMode(state, m, keys); changed(); syncModes();}, "vs-mode ui-segment", label);
      b.setAttribute("role", "radio"); return [m, b];
    });
    const syncModes = () => {
      const mode = modeOf(state);
      for (const [m, b] of modeBtns) {
        b.setAttribute("aria-checked", String(mode === m));
        b.tabIndex = mode === m ? 0 : -1;
      }
      diaField.hidden = mode !== "simple";
    };
    modeRow.append(el("span", "Stack", "vs-k"), ...modeBtns.map(x => x[1]));
    form.append(modeRow);
    const tableWrap = el("div", null, "vs-table-wrap"), tbl = el("table", null, "vs-table", {"aria-label":"Pad per layer"});
    tableWrap.append(tbl); form.append(tableWrap);
    function table() {
      const mode = modeOf(state), span = layersIn(state, keys);
      const rows = mode === "simple" ? [["All layers", null]] : mode === "tmb" ? [["Top" + (span[0] !== "Top" ? " · " + span[0] : ""), "Top"], ["Middle", "Mid"], ["Bottom" + (span.at(-1) !== "Bottom" ? " · " + span.at(-1) : ""), "Bottom"]] : span.map(k => [k, k]);
      tbl.replaceChildren();
      const h = el("tr");
      for (const t of ["Layer", "Diameter (" + u.unit + ")", "Shape", "Ring"]) h.append(el("th", t, null, {scope:"col"}));
      const thead = el("thead"); thead.append(h); const body = el("tbody"); tbl.append(thead, body);
      for (const [label, key] of rows) {
        if (mode === "tmb" && key === "Mid" && span.length < 3) continue;
        const tr = el("tr"), row = key ? state.padStack?.[key] : null, d = row?.diameter ?? state.diameter;
        const layerFor = key === "Top" && mode === "tmb" ? span[0] : key === "Bottom" && mode === "tmb" ? span.at(-1) : key === "Mid" ? span[1] : key;
        const cut = layerFor && backdrilled(state, layerFor);
        const inp = el("input", null, "vs-num ui-field ui-field-number", {type:"text", inputmode:"decimal", "aria-label":"Diameter on " + label});
        inp.dataset.unit = u.unit; inp.value = u.show(d);
        inp.onchange = () => {
          const v = u.parse(inp.value);
          if (!(v > 0)) {inp.value = u.show(d); return;}
          if (!key) state.diameter = round(v); else {state.padStack[key] = {...state.padStack[key], diameter:round(v)}; sync(state, keys);}
          changed();
        };
        const shape = selectOf(SHAPES, (key ? row?.shape : state.shape) || "round", "Shape on " + label);
        shape.onchange = () => {
          if (!key) {if (shape.value === "round") delete state.shape; else state.shape = shape.value;}
          else {const r = state.padStack[key]; if (shape.value === "round") delete r.shape; else r.shape = shape.value;}
          changed();
        };
        const ring = round((d - (state.drill || 0)) / 2);
        tr.append(el("td", label + (cut ? " · cut" : ""), cut ? "vs-cut" : ""), wrapTd(inp), wrapTd(shape), el("td", cut ? "—" : u.fmt(ring), ring <= 0 ? "vs-bad" : ""));
        body.append(tr);
      }
    }
    const wrapTd = n => {const td = el("td"); td.append(n); return td;};
    // IPC-4761, tenting and via-in-pad.
    const prot = el("fieldset", null, "vs-group"); prot.append(el("legend", "Protection (IPC-4761)"));
    const ipc = selectOf(IPC_IDS.map(id => [id, IPC[id].label]), ipcOf(state).id, "IPC-4761 type");
    const sidesSel = selectOf([["both", "Both sides (-b)"], ["top", "Top only (-a)"], ["bottom", "Bottom only (-a)"]], state.ipcSides || "both", "Sides the type applies to");
    const tents = {};
    const tentRow = el("div", null, "vs-row");
    for (const s of ["top", "bottom"]) {
      const sel = selectOf([["", "Output default"], ["tented", "Tented"], ["open", "Open"]], typeof state.tent?.[s] === "boolean" ? (state.tent[s] ? "tented" : "open") : "", "Mask on " + s);
      sel.onchange = () => {
        state.tent = {...(state.tent || {})};
        if (!sel.value) delete state.tent[s]; else state.tent[s] = sel.value === "tented";
        if (!Object.keys(state.tent).length) delete state.tent;
        changed();
      };
      tents[s] = sel;
      const l = el("label", null, "vs-field"); l.append(el("span", s === "top" ? "Top mask" : "Bottom mask"), sel); tentRow.append(l);
    }
    const syncIpc = () => {
      const t = ipcOf(state);
      sidesSel.hidden = !t.sided;
      for (const s of ["top", "bottom"]) tents[s].disabled = t.covered && ipcApplies(state, s);
    };
    ipc.onchange = () => {if (ipc.value === "none") {delete state.ipc4761; delete state.ipcSides;} else state.ipc4761 = ipc.value; syncIpc(); changed();};
    sidesSel.onchange = () => {state.ipcSides = sidesSel.value; syncIpc(); changed();};
    const vip = el("input", null, "ui-checkbox", {type:"checkbox"}); vip.checked = !!state.viaInPad;
    vip.onchange = () => {if (vip.checked) state.viaInPad = true; else delete state.viaInPad; changed();};
    const vipL = el("label", null, "vs-check"); vipL.append(vip, el("span", "Via-in-pad"));
    const ipcRow = el("div", null, "vs-row"); ipcRow.append(ipc, sidesSel);
    prot.append(ipcRow, tentRow, vipL);
    form.append(prot);
    // Back-drill.
    const bdBox = el("fieldset", null, "vs-group"); bdBox.append(el("legend", "Back-drill"));
    const bdOn = el("input", null, "ui-checkbox", {type:"checkbox"}); bdOn.checked = !!state.backdrill;
    const bdFrom = selectOf([["bottom", "From bottom"], ["top", "From top"]], state.backdrill?.from || "bottom", "Back-drill side");
    const bdStop = selectOf(keys.map(k => [k, "Keep " + k]), state.backdrill?.toLayer || keys[Math.max(0, keys.length - 3)] || keys[0], "Stop layer (stays connected)");
    const bdFields = el("div", null, "vs-row");
    const setBd = patch => {state.backdrill = {from:bdFrom.value, toLayer:bdStop.value, stubMax:state.backdrill?.stubMax ?? .2, ...(state.backdrill?.diameter ? {diameter:state.backdrill.diameter} : {}), ...patch}; changed();};
    bdOn.onchange = () => {if (bdOn.checked) setBd({}); else {delete state.backdrill; changed();} bdFields.hidden = !bdOn.checked;};
    bdFrom.onchange = bdStop.onchange = () => setBd({});
    bdFields.append(bdFrom, bdStop,
      num("Max stub", () => state.backdrill?.stubMax ?? .2, v => {state.backdrill = {...state.backdrill, stubMax:v};}),
      num("Tool ⌀", () => state.backdrill?.diameter ?? null, v => {state.backdrill = {...state.backdrill}; if (v == null) delete state.backdrill.diameter; else state.backdrill.diameter = v;}, {optional:true}));
    bdFields.hidden = !state.backdrill;
    const bdL = el("label", null, "vs-check"); bdL.append(bdOn, el("span", "Back-drill this via (remove the unused barrel stub)"));
    bdBox.append(bdL, bdFields);
    form.append(bdBox);
    syncModes(); syncIpc(); paint();
    return {node:root, paint};
  }

  // Via Stack dialog for the selected vias (Altium's via Properties panel).
  function open(ctx) {
    const doc = ctx.doc;
    if (doc?.kind !== "pcb") {ctx.info?.("Open a board layout to edit via stacks."); return null;}
    const ids = new Set(ctx.via ? [ctx.via.id] : ctx.selection?.() || []);
    const vias = doc.items.filter(i => i.kind === "via" && ids.has(i.id));
    if (!vias.length) return templatesDialog(ctx);
    const state = JSON.parse(JSON.stringify(vias[0]));
    const d = el("dialog", null, "ui-dialog work-dialog vs-dialog", {"aria-label":"Via stack"});
    const head = el("div", null, "vs-head");
    head.append(el("h2", "Via Stack", "ui-dialog-title"), el("span", vias.length === 1 ? "Via " + (vias[0].net || "(no net)") : vias.length + " vias · edits apply to all", "vs-sub"));
    const tplRow = el("div", null, "vs-row vs-tpl");
    const list = templates(doc, ctx.project), tplSel = selectOf([["", "— No template —"], ...list.map(t => [t.id, t.name + (t.source === "builtin" ? " (stock)" : t.source === "project" ? " (project)" : "")])], state.template && find(doc, state.template, ctx.project) ? state.template : "", "Via template");
    let editor;
    const body = el("div", null, "vs-body");
    // Editing the construction detaches the via from its template.
    const mount = () => {editor = stackEditor(state, ctx, () => {delete state.template; tplSel.value = "";}); body.replaceChildren(editor.node);};
    tplSel.onchange = () => {
      const t = find(doc, tplSel.value, ctx.project);
      if (t) applyTemplate(state, t); else delete state.template;
      mount(); tplSel.value = t ? t.id : "";
    };
    tplRow.append(el("span", "Template", "vs-k"), tplSel,
      button("Save as template…", () => {
        const name = prompt?.("Template name", "Via " + round(state.diameter) + "/" + round(state.drill));
        if (!name) return;
        try {let t; ctx.edit(() => {t = addTemplate(doc, fromVia(state, {name}));}); state.template = t.id; tplSel.add(new Option(t.name, t.id)); tplSel.value = t.id; ctx.info?.("Template " + t.name + " saved on the board");}
        catch (e) {ctx.info?.(e.message);}
      }, "", "Store this construction as a board via template"),
      button("Templates…", () => {d.close(); templatesDialog(ctx);}, "", "Open the via template library"));
    mount();
    const actions = el("div", null, "work-actions ui-dialog-actions");
    const save = button("Apply", () => {
      if (!(state.drill > 0) || !(state.diameter > state.drill)) {ctx.info?.("The diameter must exceed the drill."); return;}
      try {
        ctx.edit(() => {
          for (const v of vias) {
            for (const k of [...FIELDS, "template"]) {if (k === "diameter" || k === "drill") {v[k] = state[k]; continue;} if (state[k] === undefined) delete v[k]; else v[k] = copy(state[k]);}
            if (modeOf(v) !== "simple") sync(v, keysOf(doc, v, ctx.defs));
          }
        });
        ctx.info?.("Via stack applied to " + vias.length + " via" + (vias.length === 1 ? "" : "s"));
        d.close();
      } catch (e) {ctx.info?.(e.message);}
    });
    save.dataset.variant = "primary";
    actions.append(button("Cancel", () => d.close()), save);
    body.classList.add("ui-dialog-body");
    d.append(head, tplRow, body, actions);
    d.addEventListener("close", () => d.remove(), {once:true});
    document.body.append(d); globalThis.AtriumShell?.adoptDialog?.(d, {defaultAction: false}); d.showModal();
    return d;
  }

  // Via template library (Design › Via Templates…).
  function templatesDialog(ctx) {
    const doc = ctx.doc;
    if (doc?.kind !== "pcb") {ctx.info?.("Open a board layout to manage via templates."); return null;}
    const u = unitsFor(ctx);
    let lib = cleanLibrary(plain(doc.viaTemplates) ? doc.viaTemplates : null), dirty = false;
    const all = () => [...lib.list.map(t => Object.defineProperty({...t}, "source", {value:"board"})), ...templates(null, ctx.project).filter(t => !lib.list.some(x => x.id === t.id))];
    let current = lib.list[0]?.id || BUILTIN[0].id;
    const d = el("dialog", null, "ui-dialog work-dialog vs-dialog vs-lib", {"aria-label":"Via templates"});
    const head = el("div", null, "vs-head"); head.append(el("h2", "Via Templates", "ui-dialog-title"), el("span", doc.name || "Board", "vs-sub"));
    const left = el("div", null, "vs-list"), listBox = el("div", null, "ui-list vs-templates", {role:"listbox", "aria-label":"Via templates"});
    const right = el("div", null, "vs-detail");
    const tools = el("div", null, "vs-row vs-tools");
    tools.append(button("New", () => {const t = cleanTemplate({name:uniqueName("New via"), diameter:.6, drill:.3}); lib.list.push(t); current = t.id; touch();}),
      button("Duplicate", () => {const t = all().find(x => x.id === current); if (!t) return; const {builtin, ...rest} = t; const c = cleanTemplate({...rest, id:undefined, name:uniqueName(t.name + " copy")}); lib.list.push(c); current = c.id; touch();}),
      button("Delete", () => {const before = lib.list.length; lib.list = lib.list.filter(t => t.id !== current); if (before === lib.list.length) {ctx.info?.("Stock templates cannot be deleted; duplicate them to change them."); return;}
        for (const k of ["via", "diffPair"]) if (lib.defaults[k] === current) lib.defaults[k] = null;
        for (const [c, id] of Object.entries(lib.defaults.netClasses)) if (id === current) delete lib.defaults.netClasses[c];
        current = lib.list[0]?.id || BUILTIN[0].id; touch();}, "vs-danger"));
    left.append(tools, listBox);
    const defaultsBox = el("fieldset", null, "vs-group vs-defaults"); defaultsBox.append(el("legend", "Defaults"));
    left.append(defaultsBox);
    function uniqueName(base) {const names = new Set(all().map(t => t.name.toLowerCase())); let n = base, i = 2; while (names.has(n.toLowerCase())) n = base + " " + i++; return n;}
    function touch() {dirty = true; paintList(); paintDetail(); paintDefaults();}
    function paintList() {
      listBox.replaceChildren();
      let group = null;
      for (const t of all()) {
        if (t.source !== group) {group = t.source; listBox.append(el("div", {board:"On this board", project:"Project", builtin:"Stock"}[group], "vs-group-title"));}
        // A library list row: the template, its geometry as the detail and any default it serves as a badge.
        const item = el("div", null, "ui-row vs-template", {role:"option", tabindex:"0", "aria-selected":String(t.id === current)}), text = el("span", null, "ui-row-text");
        text.append(el("span", t.name, "ui-row-title"), el("span", describe(t, u.fmt), "ui-row-detail")); item.append(text);
        const marks = [lib.defaults.via === t.id ? "via tool" : "", lib.defaults.diffPair === t.id ? "diff pairs" : "", ...Object.entries(lib.defaults.netClasses).filter(([, id]) => id === t.id).map(([c]) => c)].filter(Boolean);
        if (marks.length) item.append(el("span", "Default: " + marks.join(", "), "ui-badge vs-default", {"data-tone": "accent"}));
        item.onclick = () => {current = t.id; paintList(); paintDetail();};
        item.onkeydown = e => {if (e.key === "Enter" || e.key === " ") {current = t.id; paintList(); paintDetail(); e.preventDefault();}};
        listBox.append(item);
      }
    }
    function paintDetail() {
      const t = all().find(x => x.id === current);
      right.replaceChildren();
      if (!t) return;
      const editable = t.source === "board";
      const nameRow = el("div", null, "vs-row");
      const name = el("input", null, "vs-name", {type:"text", "aria-label":"Template name"}); name.value = t.name; name.disabled = !editable;
      name.onchange = () => {const v = name.value.trim(); if (!v) {name.value = t.name; return;} const tt = lib.list.find(x => x.id === t.id); tt.name = v; dirty = true; paintList();};
      nameRow.append(el("span", "Name", "vs-k"), name);
      if (!editable) nameRow.append(el("span", t.source === "builtin" ? "Stock template · duplicate it to edit" : "Project template · duplicate it to edit", "vs-note"));
      right.append(nameRow);
      const state = {kind:"via", x:0, y:0, layer:"Multi", ...JSON.parse(JSON.stringify(t))};
      const ed = stackEditor(state, ctx, () => {
        if (!editable) return;
        try {const i = lib.list.findIndex(x => x.id === t.id); const raw = {id:t.id, name:lib.list[i].name}; for (const k of FIELDS) if (state[k] !== undefined) raw[k] = copy(state[k]); lib.list[i] = cleanTemplate(raw); dirty = true; paintList();}
        catch (e) {ctx.info?.(e.message);}
      });
      if (!editable) ed.node.classList.add("vs-readonly");
      right.append(ed.node);
      const sel = (ctx.selection?.() || []).map(id => doc.items.find(i => i.id === id)).filter(i => i?.kind === "via");
      const applyRow = el("div", null, "vs-row");
      const applyBtn = button("Apply to " + sel.length + " selected via" + (sel.length === 1 ? "" : "s"), () => {
        try {const tt = all().find(x => x.id === current); commit(); ctx.edit(() => {for (const v of sel) {applyTemplate(v, tt); if (modeOf(v) !== "simple") sync(v, keysOf(doc, v, ctx.defs));}}); ctx.info?.("Template " + tt.name + " applied to " + sel.length + " via" + (sel.length === 1 ? "" : "s"));}
        catch (e) {ctx.info?.(e.message);}
      });
      applyBtn.disabled = !sel.length;
      applyRow.append(applyBtn);
      right.append(applyRow);
    }
    function paintDefaults() {
      defaultsBox.replaceChildren(el("legend", "Defaults"));
      const opts = [["", "— None (rules / stock size) —"], ...all().map(t => [t.id, t.name])];
      const row = (label, value, set) => {const l = el("label", null, "vs-field vs-wide"); const s = selectOf(opts, value || "", label); s.onchange = () => {set(s.value || null); dirty = true; paintList();}; l.append(el("span", label), s); defaultsBox.append(l);};
      row("Via tool", lib.defaults.via, v => {lib.defaults.via = v;});
      row("Differential pairs", lib.defaults.diffPair, v => {lib.defaults.diffPair = v;});
      let classes = [];
      try {classes = Object.keys(globalThis.AtriumRules?.netClasses(doc, {project:ctx.project}) || {});} catch {classes = [];}
      for (const c of classes) row("Net class " + c, lib.defaults.netClasses[c], v => {if (v) lib.defaults.netClasses[c] = v; else delete lib.defaults.netClasses[c];});
      if (!classes.length) defaultsBox.append(el("small", "Net classes defined in Design › Rules get their own default here."));
    }
    function commit() {
      if (!dirty) return;
      const next = cleanLibrary(lib);
      ctx.edit(() => {doc.viaTemplates = next;});
      dirty = false;
    }
    const io = el("div", null, "vs-row vs-io");
    io.append(button("Export…", () => {
      saveText(ctx, (doc.name || "board").replace(/[\\/:*?"<>|]/g, "-") + ".waffle-vias", JSON.stringify({format:"atrium-via-templates", version:1, ...cleanLibrary(lib)}, null, 2)).catch(e => ctx.info?.(e.message));
    }), button("Import…", async () => {
      try {
        const text = await loadText(ctx, [".waffle-vias", ".json"]); if (text == null) return;
        const raw = JSON.parse(text); if (raw?.format !== "atrium-via-templates") throw Error("Choose a Waffle via template file.");
        const inc = cleanLibrary(raw);
        for (const t of inc.list) {lib.list = lib.list.filter(x => x.id !== t.id); lib.list.push(t);}
        touch(); ctx.info?.(inc.list.length + " via templates imported");
      } catch (e) {ctx.info?.(e.message);}
    }));
    left.append(io);
    const body = el("div", null, "vs-lib-body ui-dialog-body"); body.append(left, right);
    const actions = el("div", null, "work-actions ui-dialog-actions");
    const save = button("Save", () => {try {commit(); ctx.info?.("Via templates saved"); d.close();} catch (e) {ctx.info?.(e.message);}});
    save.dataset.variant = "primary";
    actions.append(button("Close", () => {if (dirty && typeof confirm === "function" && !confirm("Discard template changes?")) return; d.close();}), save);
    d.append(head, body, actions);
    d.addEventListener("close", () => d.remove(), {once:true});
    document.body.append(d);
    paintList(); paintDetail(); paintDefaults(); globalThis.AtriumShell?.adoptDialog?.(d, {defaultAction: false}); d.showModal();
    return d;
  }
  // File helpers: the host's exportFile / pickFile when the editor passes them.
  async function saveText(ctx, name, text) {
    if (ctx.exportFile) return ctx.exportFile(name, text);
    const a = document.createElement("a"), url = URL.createObjectURL(new Blob([text], {type:"application/json"}));
    a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }
  async function loadText(ctx, exts) {
    let f = null;
    if (ctx.pickFile) f = await ctx.pickFile(exts);
    else f = await new Promise(resolve => {const i = document.createElement("input"); i.type = "file"; i.accept = exts.join(","); i.onchange = () => resolve(i.files?.[0] || null); i.click();});
    if (!f) return null;
    return f.text ? f.text() : new TextDecoder().decode(await f.arrayBuffer());
  }

  return Object.freeze({MODES, SHAPES, IPC, BUILTIN, MICRO_DRILL, copperIndex, spanOf, inSpan, keysOf, modeOf, padOn, diameterOn, minDiameter, extremes,
    display, sync, setMode, backdrilled, covered, ipcCode, maskOpening, implications, isMicrovia, drillSpans, backdrillStop, physical, measure, validate, check,
    cleanTemplate, applyTemplate, fromVia, cleanLibrary, library, templates, find, addTemplate, updateTemplate, duplicateTemplate, removeTemplate,
    setDefault, defaultFor, place, exportLibrary, importLibrary, describe, hasMark, markGeometry, paintMarks, section, stackEditor, open, templatesDialog,
    hdi:Object.freeze({cleanConfig:cleanHdi, config:hdiConfig, set:setHdi, name:hdiName, stages, laminations, spanStatus, recommendedPairs, applyPairs,
      usableSpans, chain, routeSpan, smdPads, viasInPads, stacks:viaStacks, drc:hdiDrc, notes:hdiNotes, laserLike}),
    ui:{el, button, selectOf, unitsFor, saveText, loadText}});
})();
