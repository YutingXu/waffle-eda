"use strict";
// PCB editing tools: flip to the other side, lock and unions, multi-object Properties,
// Find Similar and the selection filter, object snap, the heads-up display and the
// flipped board view's helpers. Units are mm, Y down.
//
// The model functions are DOM-free and return plans: flipPlan / applyFlip, lockPlan,
// unionPlan, sharedFields / applyField, similarProps / findSimilar, objectSnap, hudLines.
// install(ctx) wires them into the editor (editor.js passes accessors; see the patch).
//
// Bottom-side parts use the representation the Altium importer already produces: the
// part's `layer` is "Bottom" and its definition is a mirrored copy of the footprint
// (pads on Bottom copper, Bottom paste and mask, overlay on Bottom silk, X mirrored about
// the part origin) tagged {mirrorOf: <original def id>}. Every consumer that reads the
// footprint (canvas, Gerber, drill, DRC, connectivity, router, PnP) therefore needs no
// special case. Flipping back returns the part to the original definition.
//
// A mirrored definition carries mirrorSig, the signature of the original it was made from.
// Whenever the original changes (library edit, update from library, swap), the mirror is
// regenerated in place under the same id (refreshMirrors, run after every editor edit by
// settle and before fab output by the editor), so bottom-side parts never plot stale pads.
//
// Pick-and-place rotation of bottom-side parts follows Altium's convention, which the
// importer also produces: the board is viewed from the top, X is the top-view X, and the
// reported rotation θ is counter-clockwise viewed from the top (the model angle negated,
// as Y points down). IPC-7351B instead views bottom parts from the bottom; for a part
// mirrored about its Y axis, as Waffle flips, that is (360° − θ) mod 360. X is the
// top-view X in both. Assemblers must be told which one a file uses.
globalThis.AtriumPCBEdit = (() => {
  const A = () => globalThis.Atrium;
  const norm = a => { const v = ((Math.round((a || 0) * 1e6) / 1e6) % 360 + 360) % 360; return v === 0 ? 0 : v; };
  const mirrorLayer = (layer,inner) => A().pcbMirror.layer(layer,inner);
  const mirrorPad = (pad,inner) => A().pcbMirror.pad(pad,inner);
  const mirrorShape = (shape,inner) => A().pcbMirror.shape(shape,inner);
  const mirrorFootprint = (fp,inner) => A().pcbMirror.footprint(fp,inner);
  const INNER = /^Inner \d+$/;
  const usesInner = fp => [...(fp?.pads || []), ...(fp?.shapes || [])].some(p => INNER.test(p.layer || "") ||
    INNER.test(p.fromLayer || "") || INNER.test(p.toLayer || "") || Object.keys(p.padStack||{}).some(k=>INNER.test(k)));
  // Inner copper layers of a board: its stackup, else the inner layers it uses.
  function innerCount(doc, defs) {
    try { const l = globalThis.AtriumStackup?.copperLayers?.(doc, defs); if (Array.isArray(l) && l.length >= 2) return l.filter(k => INNER.test(typeof k === "string" ? k : k?.name || k?.key || "")).length; } catch {}
    let n = 0;
    const note = l => { const m = /^Inner (\d+)$/.exec(l || ""); if (m) n = Math.max(n, +m[1]); };
    for (const i of doc?.items || []) { note(i.layer); note(i.fromLayer); note(i.toLayer); }
    return n;
  }
  const nm = v => { const r = Math.round(v * 1e6) / 1e6; return Math.abs(r - v) < 1e-9 ? r + 0 : v; };
  const clone = v => v == null ? v : JSON.parse(JSON.stringify(v));
  const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); };
  const isBottom = part => part?.layer === "Bottom";

  // Signature of everything a mirror copies from its original (and the inner layer count
  // when the footprint has inner-layer copper, which the mirror depends on).
  function signature(def, inner = 0) {
    const {id, mirrorOf, mirrorSig, ...rest} = A().definitionGeometry(def) || {};
    const pads=rest.footprint?.pads||[];
    const version=pads.some(A().pcbMirror.rotatedSlot)?"p3:":pads.some(p=>p.poly || p.padStack)?"p2:":"";
    return version+hash(JSON.stringify(rest)) + (usesInner(def?.footprint) ? "/i" + inner : "");
  }
  const sigInner = sig => { const m = /\/i(\d+)$/.exec(sig || ""); return m ? +m[1] : null; };
  const sameMirror = (a, b) => {
    const {mirrorSig: x, ...p} = A().definitionGeometry(a), {mirrorSig: y, ...q} = A().definitionGeometry(b);
    return JSON.stringify(p) === JSON.stringify(q);
  };
  /**
   * The definition a part uses on the other side; created in `project.library` when new.
   * A stale mirror (its original changed) is regenerated in place under the same id, so
   * every part using it follows; o.refreshed collects those. o.inner: the board's inner
   * copper layer count (used only by footprints with inner-layer copper).
   */
  function counterpart(project, def, created, o = {}) {
    const lib = project.library;
    if (def.mirrorOf) {
      const orig = lib.find(d => d.id === def.mirrorOf);
      if (orig) return orig;
    }
    const m = lib.find(d => d.mirrorOf === def.id);
    const inner = o.inner ?? sigInner(m?.mirrorSig) ?? 0, sig = signature(def, inner);
    if (m && m.mirrorSig === sig) return m;
    const fresh = {...clone(def), id: m?.id || A().id(), mirrorOf: def.id, mirrorSig: sig, footprint: mirrorFootprint(def.footprint, inner)};
    if (m) {
      // A signature from an older build with the same content: just restamp it.
      if (sameMirror(m, fresh)) { m.mirrorSig = sig; return m; }
      lib[lib.indexOf(m)] = fresh; o.refreshed?.push(fresh);
    } else { lib.push(fresh); created?.push(fresh); }
    return fresh;
  }
  /**
   * Regenerate every mirrored definition whose original changed since it was made.
   * Returns the regenerated definitions; parts using them keep the same def id.
   */
  function refreshMirrors(project, o = {}) {
    const lib = project?.library || [], refreshed = [];
    for (const m of lib.filter(d => d.mirrorOf)) {
      const orig = lib.find(d => d.id === m.mirrorOf && !d.mirrorOf);
      if (orig) counterpart(project, orig, null, {inner: usesInner(orig.footprint) ? o.inner ?? sigInner(m.mirrorSig) ?? 0 : 0, refreshed});
    }
    return refreshed;
  }
  // Transient mirrored definition for ghosts while placing (never stored).
  const previews = new WeakMap();
  function previewDef(def) {
    if (!def) return def;
    let m = previews.get(def);
    if (!m) { m = {...def, id: "mirror-preview:" + def.id, footprint: mirrorFootprint(def.footprint), mirrorOf: def.id}; previews.set(def, m); }
    return m;
  }
  function mirrorRows(rows) {
    return rows.map(a => ({...a, at: [-a.at[0], a.at[1]], angle: norm(-a.angle), layer: mirrorLayer(a.layer), mirrored: !a.mirrored}));
  }
  /**
   * Plan a flip of the parts among `ids`. opts.about: "each" (each part about its origin,
   * the default for one part) or "center" (mirror positions about the selection centre so
   * relative placement is kept). Returns {parts:[{id, from:{…}, to:{…}}], about, center}.
   */
  function flipPlan(doc, defs, ids, opts = {}) {
    const set = ids instanceof Set ? ids : new Set(ids || []);
    const parts = doc.items.filter(i => i.kind === "part" && set.has(i.id) && defs.get(i.def)?.footprint);
    const about = opts.about || (parts.length > 1 ? "center" : "each");
    let cx = 0;
    if (parts.length) { const xs = parts.map(p => p.x); cx = (Math.min(...xs) + Math.max(...xs)) / 2; }
    // Positions snap back to the nanometre grid, so flipping twice restores them exactly.
    return {about, center: cx, parts: parts.map(p => ({id: p.id, def: p.def, to: {
      side: isBottom(p) ? "Top" : "Bottom", angle: norm(-(p.angle || 0)), x: about === "center" ? nm(2 * cx - p.x) : p.x, y: p.y}}))};
  }
  /**
   * Apply a flip plan in place (call inside the editor's edit()). Returns the parts changed.
   * plan.refreshed lists stale mirrored definitions regenerated on the way (other parts on
   * those definitions change with them: report it).
   */
  function applyFlip(doc, project, plan, defs) {
    const lookup = defs || new Map(project.library.map(d => [d.id, d])), done = [], refreshed = [], inner = innerCount(doc, lookup);
    for (const step of plan.parts) {
      const part = doc.items.find(i => i.id === step.id);
      let def = part && (lookup.get(part.def) || project.library.find(d => d.id === part.def));
      if (!def?.footprint) continue;
      // Use the library's current object (lookup may hold one replaced by a refresh).
      def = project.library.find(d => d.id === def.id) || def;
      const other = counterpart(project, def, null, {inner, refreshed});
      lookup.set?.(other.id, other);
      part.def = other.id; part.angle = step.to.angle; part.x = step.to.x; part.y = step.to.y;
      // Top is the default side: leave `layer` unset there, so flipping twice is exact.
      if (step.to.side === "Top") delete part.layer; else part.layer = step.to.side;
      for (const k of ["refAt", "valueAt"]) if (Array.isArray(part[k])) part[k] = [-part[k][0], part[k][1]];
      if (part.designator && Number.isFinite(part.designator.x)) part.designator = {...part.designator, x: -part.designator.x, angle: norm(-(part.designator.angle || 0))};
      const key = part.sourceRecord, rows = key && doc.pcbDrawing?.annotations?.[key];
      if (Array.isArray(rows)) doc.pcbDrawing.annotations[key] = mirrorRows(rows);
      for (const field of ["boardLabels","hiddenBoardLabels"]) if (Array.isArray(part[field])) part[field] = mirrorRows(part[field]);
      done.push(part);
    }
    for (const d of refreshed) lookup.set?.(d.id, d);
    plan.refreshed = refreshed;
    return done;
  }
  /** One-call helper: flip `ids` in `doc` (headless API). */
  function flip(doc, project, ids, opts) {
    const defs = new Map(project.library.map(d => [d.id, d]));
    return applyFlip(doc, project, flipPlan(doc, defs, ids, opts), defs);
  }

  // ------------------------------------------------------------------ lock and unions
  const isLocked = i => i?.locked === true;
  function lockedIn(doc, ids) { const s = ids instanceof Set ? ids : new Set(ids); return doc.items.filter(i => s.has(i.id) && isLocked(i)); }
  function lockPlan(doc, ids, value) {
    const s = ids instanceof Set ? ids : new Set(ids);
    return {value: !!value, ids: doc.items.filter(i => s.has(i.id) && isLocked(i) !== !!value).map(i => i.id)};
  }
  function applyLock(doc, plan) {
    const s = new Set(plan.ids);
    for (const i of doc.items) if (s.has(i.id)) { if (plan.value) i.locked = true; else delete i.locked; }
    return plan.ids.length;
  }
  // Unions live in their own field, `unionId`, so they never touch the `groupId` of a via
  // fence, a logo or teardrops: breaking a union leaves those groups whole. Documents from
  // earlier builds stored a union as groupId "union:…"; that form is still read and broken.
  const isUnion = g => typeof g === "string" ? g.startsWith("union:") : !!unionOf(g);
  const unionOf = i => i?.unionId || (typeof i?.groupId === "string" && i.groupId.startsWith("union:") ? i.groupId : null);
  /**
   * Everything clicking `item` selects: its group and union, and transitively the groups and
   * unions of those members (a union holding one via of a fence selects the whole fence).
   */
  function closure(doc, seeds) {
    const groups = new Set(), unions = new Set(), ids = new Set(seeds.map(i => i.id));
    const note = i => { let grew = false; if (i.groupId != null && !groups.has(i.groupId)) { groups.add(i.groupId); grew = true; } const u = unionOf(i); if (u && !unions.has(u)) { unions.add(u); grew = true; } return grew; };
    for (const i of seeds) note(i);
    let out = seeds, grew = true;
    while (grew) {
      grew = false; out = doc.items.filter(i => ids.has(i.id) || i.groupId != null && groups.has(i.groupId) || unions.has(unionOf(i)));
      for (const i of out) if (note(i)) grew = true;
    }
    return out;
  }
  const mates = (doc, item) => closure(doc, [item]);
  /** op "create" | "break" | "add". Returns {set:[[id, unionId|null]], unionId, groupId (same), message}. */
  function unionPlan(doc, ids, op, primary) {
    const s = ids instanceof Set ? ids : new Set(ids), chosen = doc.items.filter(i => s.has(i.id));
    if (op === "create") {
      if (chosen.length < 2) return {set: [], message: "Select two or more objects to make a union."};
      // Whole groups and unions join: a union never splits a fence or a logo.
      const unionId = "union:" + A().id(), members = closure(doc, chosen);
      return {unionId, groupId: unionId, set: members.map(i => [i.id, unionId]), message: members.length + " objects joined in a union."};
    }
    if (op === "break") {
      const unions = new Set(chosen.map(unionOf).filter(Boolean));
      const members = doc.items.filter(i => unions.has(unionOf(i)));
      return {set: members.map(i => [i.id, null]), message: members.length ? unions.size + (unions.size === 1 ? " union" : " unions") + " broken." : "The selection has no union."};
    }
    if (op === "add") {
      const first = chosen.find(i => i.id === primary && unionOf(i)) || chosen.find(i => unionOf(i));
      if (!first) return {set: [], message: "Select a union member and the objects to add."};
      const u = unionOf(first), add = closure(doc, chosen.filter(i => unionOf(i) !== u)).filter(i => unionOf(i) !== u);
      return {unionId: u, groupId: u, set: add.map(i => [i.id, u]), message: add.length + " objects added to the union."};
    }
    throw Error("Unknown union operation " + op);
  }
  function applyUnion(doc, plan) {
    const m = new Map(plan.set);
    for (const i of doc.items) if (m.has(i.id)) {
      const u = m.get(i.id);
      if (typeof i.groupId === "string" && i.groupId.startsWith("union:")) delete i.groupId; // earlier builds
      if (u) i.unionId = u; else delete i.unionId;
    }
    return m.size;
  }

  // ------------------------------------------------------------------ kinds and selection filter
  // Selection filter, as Altium's: one set of object kinds per editor, each toggled independently.
  const KINDS = [["parts", "Components"], ["tracks", "Tracks"], ["vias", "Vias"], ["pads", "Pads"], ["polygons", "Polygons"],
    ["regions", "Regions"], ["fills", "Fills"], ["keepouts", "Keepouts"], ["text", "Texts"], ["other", "Other"]];
  const SCH_KINDS = [["parts", "Components"], ["wires", "Wires"], ["buses", "Buses"], ["labels", "Net Labels"], ["ports", "Ports"],
    ["power", "Power Ports"], ["sheets", "Sheet Symbols"], ["text", "Texts"], ["graphics", "Drawing"], ["other", "Other"]];
  const copperName = l => l === "Top" || l === "Bottom" || /^Inner \d+$/.test(l || "");
  function kindOf(i, docKind = "pcb") {
    if (docKind === "schematic") switch (i?.kind) {
      case "part": return "parts"; case "wire": return "wires"; case "bus": case "busentry": return "buses";
      case "netlabel": return "labels"; case "port": case "offsheet": return "ports"; case "power": return "power";
      case "sheetsymbol": case "sheetentry": return "sheets"; case "text": case "note": case "label": return "text";
      case "graphic": case "line": case "rect": case "arc": case "polygon": case "image": return "graphics";
      default: return "other";
    }
    if (i?.keepout || /keep-?out/i.test(i?.layer || "")) return "keepouts";
    switch (i?.kind) {
      case "track": return "tracks"; case "via": return "vias"; case "pad": return "pads"; case "part": return "parts";
      case "polygon": return "polygons"; case "label": return "text";
      case "graphic": return i.fill && copperName(i.layer) ? (i.fillRect ? "fills" : "regions") : "other";
      default: return "other";
    }
  }
  const FILTER_KEY = "atrium.selectionFilter.v2";
  const filters = {pcb: Object.fromEntries(KINDS.map(([k]) => [k, true])), schematic: Object.fromEntries(SCH_KINDS.map(([k]) => [k, true]))};
  const filter = filters.pcb;
  try {
    const saved = JSON.parse(globalThis.localStorage?.getItem(FILTER_KEY) || "null") || {pcb: JSON.parse(globalThis.localStorage?.getItem("atrium.selectionFilter.v1") || "null")};
    for (const kind of ["pcb", "schematic"]) for (const k in filters[kind]) if (typeof saved?.[kind]?.[k] === "boolean") filters[kind][k] = saved[kind][k];
  } catch {}
  function setFilter(k, v, docKind = "pcb") { const f = filters[docKind]; if (!f || !Object.hasOwn(f, k)) return; f[k] = !!v; try { globalThis.localStorage?.setItem(FILTER_KEY, JSON.stringify(filters)); } catch {} }
  const allows = (i, f = filter, docKind = "pcb") => f[kindOf(i, docKind)] !== false && (docKind !== "pcb" || globalThis.AtriumComponentClasses?.allows?.(i) !== false);

  // ------------------------------------------------------------------ multi-object Properties
  const VARIES = Symbol("varies");
  const LABELS = {track: "Tracks", via: "Vias", pad: "Pads", part: "Components", label: "Text", graphic: "Graphics", polygon: "Polygons"};
  // [key, label, type] per item kind. Types: length, number, layer, text, side, bool.
  const FIELDS = {
    track: [["width", "Width", "length"], ["layer", "Layer", "layer"], ["net", "Net", "text"], ["locked", "Locked", "bool"]],
    via: [["diameter", "Diameter", "length"], ["drill", "Drill", "length"], ["net", "Net", "text"], ["locked", "Locked", "bool"]],
    pad: [["net", "Net", "text"], ["locked", "Locked", "bool"]],
    part: [["value", "Comment", "text"], ["angle", "Rotation (°)", "number"], ["side", "Side", "side"], ["locked", "Locked", "bool"]],
    label: [["size", "Text height", "length"], ["layer", "Layer", "anylayer"], ["locked", "Locked", "bool"]],
    graphic: [["layer", "Layer", "anylayer"], ["width", "Width", "length"], ["net", "Net", "text"], ["locked", "Locked", "bool"]],
    polygon: [["layer", "Layer", "layer"], ["net", "Net", "text"], ["locked", "Locked", "bool"]]
  };
  function read(i, key) {
    if (key === "side") return isBottom(i) ? "Bottom" : "Top";
    if (key === "locked") return isLocked(i);
    if (key === "angle") return norm(i.angle || 0);
    if (key === "net") return i.net || "";
    if (key === "layer") return i.layer || (i.kind === "label" ? "Silk" : "Top");
    if (key === "size") return i.size ?? .75;
    return i[key];
  }
  /** Kinds in the selection and, when they share one kind, the shared fields (VARIES when mixed). */
  function sharedFields(doc, ids) {
    const s = ids instanceof Set ? ids : new Set(ids), items = doc.items.filter(i => s.has(i.id)), kinds = new Map();
    for (const i of items) kinds.set(i.kind, (kinds.get(i.kind) || 0) + 1);
    if (kinds.size !== 1) return {kinds, kind: null, items, fields: []};
    const kind = items[0].kind, fields = (FIELDS[kind] || [["locked", "Locked", "bool"]]).map(([key, label, type]) => {
      const first = read(items[0], key), same = items.every(i => { const v = read(i, key); return v === first || typeof v === "number" && Math.abs(v - first) < 1e-9; });
      return {key, label, type, value: same ? first : VARIES};
    });
    return {kinds, kind, items, fields};
  }
  /**
   * Design rules a multi-edit would break (AtriumRules.resolver): track width against the
   * Width rule, via diameter and drill against Routing Via Style and Minimum Annular Ring.
   * Returns {issues:[{id, what, actual, required, limit, rule}], values: Map(id → the nearest
   * value within the rules)} for applyField's o.values ("clamp").
   */
  function ruleCheck(doc, project, ids, key, value) {
    const s = ids instanceof Set ? ids : new Set(ids), out = {issues: [], values: new Map()};
    const Rr = globalThis.AtriumRules;
    if (!Rr?.resolver || !Number.isFinite(value) || !["width", "diameter", "drill"].includes(key)) return out;
    let q; try { q = Rr.resolver(doc, {project}); } catch { return out; }
    const EPS = 1e-9, flag = (i, what, required, limit, rule, fix) => { out.issues.push({id: i.id, what, actual: value, required, limit, rule}); out.values.set(i.id, fix); };
    for (const i of doc.items) {
      if (!s.has(i.id)) continue;
      const net = i.net || "";
      if (key === "width" && i.kind === "track") {
        const r = q("width", {net, layer: i.layer || "Top"}); if (!r) continue;
        if (r.min != null && value < r.min - EPS) flag(i, "Width", r.min, "min", r.ruleName, r.min);
        else if (r.max != null && value > r.max + EPS) flag(i, "Width", r.max, "max", r.ruleName, r.max);
      } else if (i.kind === "via" && key !== "width") {
        const st = q("viaStyle", {net}), ring = q("annularRing", {net})?.min || 0, RING = "Minimum Annular Ring";
        const limits = key === "diameter"
          ? [[st?.diameterMin, "min", "Via diameter", st?.ruleName], [(i.drill || 0) + 2 * ring, "min", "Annular ring", RING], [st?.diameterMax, "max", "Via diameter", st?.ruleName]]
          : [[st?.holeMin, "min", "Via hole", st?.ruleName], [st?.holeMax, "max", "Via hole", st?.ruleName], [(i.diameter || 0) - 2 * ring, "max", "Annular ring", RING]];
        let fix = value, first = null;
        for (const [lim, kind, what, rule] of limits) {
          if (lim == null || !Number.isFinite(lim) || (kind === "min" ? fix >= lim - EPS : fix <= lim + EPS)) continue;
          fix = lim; first = first || {what, lim, kind, rule};
        }
        if (first) flag(i, first.what, first.lim, first.kind, first.rule, fix);
      }
    }
    return out;
  }
  /**
   * Set `key` to `value` on every selected object of the shared kind (call inside edit()).
   * o.values: per-object values (from ruleCheck) that replace `value`.
   */
  function applyField(doc, project, ids, key, value, defs, o = {}) {
    const s = ids instanceof Set ? ids : new Set(ids), items = doc.items.filter(i => s.has(i.id));
    defs = defs || new Map(project.library.map(d => [d.id, d]));
    let n = 0;
    const base = value;
    if (key === "side") {
      const flipIds = items.filter(i => i.kind === "part" && (isBottom(i) ? "Bottom" : "Top") !== value).map(i => i.id);
      return applyFlip(doc, project, flipPlan(doc, defs, flipIds, {about: "each"}), defs).length;
    }
    for (const i of items) {
      value = o.values?.has(i.id) ? o.values.get(i.id) : base;
      if (key === "locked") { if (value) i.locked = true; else delete i.locked; n++; continue; }
      if (key === "angle" && i.kind === "part") { const moved = A().transformPart(doc, i, defs.get(i.def), {angle: norm(value)}, undefined, {defs}); if (o.touched) for (const obj of moved) o.touched.add(obj); n++; continue; }
      if ((key === "diameter" && !(value > (i.drill || 0))) || (key === "drill" && !(value < i.diameter))) continue;
      if (key === "net" && !value) { delete i.net; n++; continue; }
      i[key] = value; n++;
    }
    return n;
  }

  // ------------------------------------------------------------------ Find Similar
  let ccMemo = null; // component classes of one Find Similar run (component-classes.js)
  function ccText(doc, i) { const C = globalThis.AtriumComponentClasses; if (!C || i.kind !== "part") return undefined; if (!ccMemo || ccMemo.doc !== doc) ccMemo = {doc, m: C.map(doc, globalThis.AtriumNavHost?.project?.() || null)}; const out = []; for (const [n, s] of ccMemo.m) if (s.has(i.ref)) out.push(n); return out.sort().join(", "); }
  const field = (key, label, get = (item, _doc, _defs) => read(item, key)) => ({key, label, get});
  const layerField = field("layer", "Layer", item => globalThis.AtriumPCBAppearance.boardLayer(item));
  const netField = field("net", "Net");
  const lockedField = field("locked", "Locked");
  const otherFields = [layerField, field("width", "Width", item => item.width ?? undefined), netField];
  const similarFields = {
    track: [layerField, field("width", "Width"), netField],
    via: [field("diameter", "Diameter"), field("drill", "Drill"), netField],
    pad: [layerField, field("w", "Width"), field("h", "Height"), field("shape", "Shape", item => item.shape || "round"),
      field("drill", "Drill", item => item.drill ?? ""), netField],
    part: [
      field("footprint", "Footprint", (item, doc, defs) => defs.get(item.def)?.footprint?.name || ""),
      field("value", "Comment", item => item.value || ""), field("side", "Side"), field("angle", "Rotation"),
      field("prefix", "Designator prefix", item => (item.ref || "").replace(/\d.*$/, "")),
      field("componentClass", "Component class", (item, doc) => ccText(doc, item)),
    ],
    label: [layerField, field("size", "Text height"), field("text", "Text")],
  };
  const fieldsFor = kind => [...(Object.hasOwn(similarFields, kind) ? similarFields[kind] : otherFields), lockedField];
  function projectSimilar(doc, defs, item, fields) {
    ccMemo = null;
    const out = [];
    for (const {key, label, get} of fields) {
      const value = get(item, doc, defs);
      if (value !== undefined) out.push({key, label, value});
    }
    return out;
  }
  function similarProps(doc, defs, item) {
    return [{key: "kind", label: "Object", value: item.kind}, ...projectSimilar(doc, defs, item, fieldsFor(item.kind))];
  }
  /** criteria: {key: "same"|"different"|"any"}. The object kind is always matched. Returns ids. */
  function findSimilar(doc, defs, item, criteria = {}, o = {}) {
    const fields = fieldsFor(item.kind);
    const getters = new Map(fields.map(({key, get}) => [key, get]));
    const match = A().similarProperties(projectSimilar(doc, defs, item, fields), criteria);
    const scope = o.within ? new Set(o.within) : null, ok = o.selectable || (() => true);
    const out = [];
    for (const i of doc.items) {
      if (i.kind !== item.kind || scope && !scope.has(i.id) || !ok(i)) continue;
      if (match(key => getters.get(key)(i, doc, defs))) out.push(i.id);
    }
    return out;
  }

  // ------------------------------------------------------------------ object snap
  const SNAP_KEY = "atrium.snap.v1";
  const SNAP_PREFERENCES = {grid:"pcb.snapGrid", objects:"pcb.snapObjects", radius:"pcb.snapRadius"};
  const snapPrefs = {grid: true, objects: true, radius: 8, pads: true, vias: true, tracks: true, outline: true};
  try { const s = JSON.parse(globalThis.localStorage?.getItem(SNAP_KEY) || "null"); if (s) for (const k of Object.keys(snapPrefs)) if (typeof s[k] === typeof snapPrefs[k]) snapPrefs[k] = s[k]; } catch {}
  // Read saved overrides even when the Preferences page has not loaded yet.
  const preferences = globalThis.AtriumPrefs?.changed?.();
  for (const [key, setting] of Object.entries(SNAP_PREFERENCES)) {
    const value = preferences ? preferences[setting] : globalThis.AtriumPref?.get(setting);
    if (typeof value === typeof snapPrefs[key]) snapPrefs[key] = snapValue(key, value);
  }
  let snapChanged;
  function snapValue(key, value) {
    return key === "radius" ? Math.max(2, Math.min(40, +value || 8)) : !!value;
  }
  function setSnap(key, value) {
    if (!Object.hasOwn(snapPrefs, key)) return;
    const next = snapValue(key, value);
    if (snapPrefs[key] === next) return;
    snapPrefs[key] = next;
    try { globalThis.localStorage?.setItem(SNAP_KEY, JSON.stringify(snapPrefs)); } catch {}
    snapChanged?.(key);
  }
  function changeSnap(key, value) {
    const next = snapValue(key, value), setting = SNAP_PREFERENCES[key];
    if (setting) globalThis.AtriumPref?.set(setting, next);
    // A loaded Preferences module applies the value synchronously. Otherwise apply it here.
    setSnap(key, next);
  }
  /**
   * Nearest hotspot to p within o.radius (mm): pad centres, via centres, track vertices and
   * board-outline vertices. o.query(box) returns candidate items (the canvas spatial index);
   * o.exclude is a Set of ids; o.kinds overrides the preference toggles; o.visible(item) and
   * o.padVisible(part, pad) drop objects on hidden layers or outside the selection filter.
   * Returns {point, kind, id} or null.
   */
  function objectSnap(doc, defs, p, o = {}) {
    const k = o.kinds || snapPrefs, r = o.radius, x = p[0], y = p[1];
    let best = null, d2 = r * r;
    const consider = (q, kind, id) => { const dx = q[0] - x, dy = q[1] - y, d = dx * dx + dy * dy; if (d < d2) { d2 = d; best = {point: [q[0], q[1]], kind, id}; } };
    const items = o.query ? o.query([x - r, y - r, x + r, y + r]) : doc.items, ex = o.exclude, Aw = A().world;
    for (const i of items) {
      if (ex && ex.has(i.id) || o.visible && !o.visible(i)) continue;
      if (i.kind === "via") { if (k.vias) consider([i.x, i.y], "via", i.id); }
      else if (i.kind === "pad") { if (k.pads) consider([i.x, i.y], "pad", i.id); }
      else if (i.kind === "track") { if (k.tracks) for (const q of i.points) consider(q, "track", i.id); }
      else if (i.kind === "part" && k.pads) {
        const fp = defs.get(i.def)?.footprint; if (!fp) continue;
        if (Math.abs(i.x - x) > r + 60 || Math.abs(i.y - y) > r + 60) continue;
        for (const pad of fp.pads || []) if (!o.padVisible || o.padVisible(i, pad)) consider(Aw([pad.x, pad.y], i), "pad", i.id);
      }
    }
    if (k.outline && Array.isArray(doc.outline)) for (const q of doc.outline) consider(q, "outline", null);
    return best;
  }

  // ------------------------------------------------------------------ heads-up display
  /** Text lines for the HUD. s: {pointer, origin, hit, layerName, len, violation}. */
  function hudLines(s) {
    const lines = [], len = s.len || (v => (+v).toFixed(3) + "mm");
    if (s.origin && s.pointer) lines.push("Δx " + len(s.pointer[0] - s.origin[0]) + "   Δy " + len(s.origin[1] - s.pointer[1]) + "   d " + len(Math.hypot(s.pointer[0] - s.origin[0], s.pointer[1] - s.origin[1])));
    const h = s.hit;
    if (h) {
      const name = s.layerName || (x => x);
      const layer = h.kind === "part" ? (isBottom(h) ? "Bottom Layer" : "Top Layer") : h.layer ? name(h.layer) : h.kind === "via" ? "Multi-Layer" : "";
      const what = h.kind === "part" ? h.ref + " · " + (h.value || "") : h.kind === "track" ? "Track " + len(h.width || 0) : h.kind === "via" ? "Via " + len(h.diameter || 0) + " / " + len(h.drill || 0) : h.kind[0].toUpperCase() + h.kind.slice(1);
      lines.push(what + (isLocked(h) ? " · locked" : ""));
      const net = h.net || s.net || "";
      lines.push((net ? "Net " + net : "No net") + (layer ? " · " + layer : ""));
    }
    if (s.violation) lines.push("⚠ " + (s.violation.ruleName || s.violation.type || "Violation") + ": " + String(s.violation.title || "").slice(0, 80));
    return lines;
  }
  function nearestViolation(list, p, tol) {
    let best = null, d = tol;
    for (const v of list || []) { const at = v.at; if (!at) continue; const e = Math.hypot(at[0] - p[0], at[1] - p[1]); if (e <= d) { d = e; best = v; } }
    return best;
  }

  // ------------------------------------------------------------------ after an edit
  /**
   * Run after an edit, inside the same undo step: regenerate mirrored definitions whose
   * original changed, and remove unlocked teardrops left stale by the edit (their track,
   * pad or via was deleted, moved, flipped or changed net or layer). DRC reports locked
   * stale teardrops. Returns {mirrors:[defs], teardrops:[ids]}.
   */
  function settle(doc, project, defs) {
    const out = {mirrors: [], teardrops: []};
    if (!project?.library) return out;
    const pcb = doc?.kind === "pcb";
    out.mirrors = refreshMirrors(project, pcb ? {inner: innerCount(doc, defs)} : {});
    if (pcb && globalThis.AtriumRules?.staleTeardrops) {
      const lookup = out.mirrors.length || !defs ? new Map(project.library.map(d => [d.id, d])) : defs;
      const gone = new Set(AtriumRules.staleTeardrops(doc, lookup).filter(t => !t.locked).map(t => t.id));
      if (gone.size) { doc.items = doc.items.filter(i => !gone.has(i.id)); out.teardrops = [...gone]; }
    }
    return out;
  }
  const plural = (n, w, p = w + "s") => globalThis.AtriumI18n?.plural?.(n, w, p) ?? n + " " + (n === 1 ? w : p);
  function settleText(r) {
    const notes = [];
    if (r.mirrors.length) notes.push(plural(r.mirrors.length, "bottom-side footprint") + " updated to match the library (" + [...new Set(r.mirrors.map(d => d.footprint?.name || d.name))].slice(0, 4).join(", ") + ")");
    if (r.teardrops.length) notes.push(plural(r.teardrops.length, "stale teardrop") + " removed");
    return notes.join("; ");
  }
  // A stand-in drag re-route session that leaves every track where it is.
  function idleReroute() {
    const out = {preview: [], pushed: [], hidden: [], vias: [], status: "ok", mode: "drag", modeName: "Drag re-route", statusName: "Off", statusText: "", routed: 0, rubber: 0, rigid: 0, locked: [], connections: 0, plan: {add: [], remove: [], modify: []}};
    return {move: () => out, commit: () => ({add: [], remove: [], modify: [], routed: 0, rubber: 0, rigid: 0, status: "ok"}), cancel() {}, setEnabled: () => false, setMaxConnections: n => n, get state() { return {enabled: false}; }};
  }

  // ------------------------------------------------------------------ editor integration (DOM)
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, click, cls) {
    const b = el("button", text, cls); b.type = "button"; b.onclick = click;
    return /chip/.test(cls) ? b : (globalThis.AtriumUI?.button(b) ?? b);
  }

  function install(ctx) {
    // ctx: doc, defs, project, pcb, view, canvas, stage, selection, primary, select(ids,primary),
    // edit, info, draw, inspect, refreshDefs, unit, len, parseLength, layers, layerName, mode, drag, revision, hit(p), netAt(p)
    let ghostFlip = false, hud = globalThis.AtriumPref?.get("pcb.hud", false) === true, lastPointer = null, origin = null, snapMark = null, overlay = null, overlayCanvas = null;
    let drc = {revision: -1, list: [], timer: 0}, lockBypass = -1, modHeld = false;
    // Ctrl (Cmd on macOS) held suspends object snap everywhere, as it does while dragging.
    const modifiers = e => { modHeld = !!(e.ctrlKey || e.metaKey); };
    for (const type of ["keydown", "keyup", "pointermove", "pointerdown"]) globalThis.addEventListener?.(type, modifiers, true);
    globalThis.addEventListener?.("blur", () => { modHeld = false; });
    const st = {get ghostFlip() { return ghostFlip; }, get hud() { return hud; }};

    // ---------- overlay canvas (HUD + snap mark); redrawn alone, never the board
    function ensureOverlay() {
      const stage = ctx.stage(); if (!stage) return null;
      if (!overlayCanvas || overlayCanvas.parentNode !== stage) {
        overlayCanvas?.remove();
        overlayCanvas = el("canvas", null, "pcb-edit-overlay"); overlayCanvas.setAttribute("aria-hidden", "true");
        stage.append(overlayCanvas); overlay = overlayCanvas.getContext("2d");
      }
      return overlay;
    }
    function paintOverlay() {
      if (!hud && !snapMark && !overlayCanvas) return;
      const g = ensureOverlay(); if (!g) return;
      const c = ctx.canvas(), w = c.clientWidth, h = c.clientHeight, dpr = Math.max(1, Math.min(4, globalThis.devicePixelRatio || 1));
      if (overlayCanvas.width !== Math.round(w * dpr) || overlayCanvas.height !== Math.round(h * dpr)) { overlayCanvas.width = Math.round(w * dpr); overlayCanvas.height = Math.round(h * dpr); overlayCanvas.style.width = w + "px"; overlayCanvas.style.height = h + "px"; }
      overlayCanvas.style.left = c.offsetLeft + "px"; overlayCanvas.style.top = c.offsetTop + "px";
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
      const view = ctx.view();
      if (snapMark) {
        const [x, y] = view.worldToScreen(snapMark.point);
        g.strokeStyle = "#ffd400"; g.lineWidth = 1.5; g.beginPath();
        if (snapMark.kind === "track" || snapMark.kind === "outline") g.rect(x - 5, y - 5, 10, 10); else g.arc(x, y, 6, 0, Math.PI * 2);
        g.moveTo(x - 9, y); g.lineTo(x + 9, y); g.moveTo(x, y - 9); g.lineTo(x, y + 9); g.stroke();
      }
      if (hud && lastPointer && ctx.pcb()) {
        const p = lastPointer, hit = ctx.hit(p), tol = 8 / view.scale();
        const lines = hudLines({pointer: p, origin, hit, len: ctx.len, layerName: ctx.layerName, net: hit?.kind === "part" ? "" : undefined, violation: nearestViolation(violations(), p, tol)});
        if (lines.length) {
          const [sx, sy] = view.worldToScreen(p);
          g.font = "500 11px ui-monospace, Menlo, monospace"; g.textBaseline = "top";
          let bw = 0; for (const l of lines) bw = Math.max(bw, g.measureText(l).width);
          bw += 12; const bh = lines.length * 15 + 8;
          let bx = sx + 18, by = sy + 18; if (bx + bw > w) bx = sx - 18 - bw; if (by + bh > h) by = sy - 18 - bh;
          g.fillStyle = "rgba(20,24,28,.72)"; g.fillRect(bx, by, bw, bh);
          lines.forEach((l, n) => { g.fillStyle = l.startsWith("⚠") ? "#ff8c7a" : n === 0 && origin ? "#9fe6ff" : "#e8eef0"; g.fillText(l, bx + 6, by + 5 + n * 15); });
        }
      }
    }
    // DRC results for the HUD, refreshed lazily once per design revision when idle.
    function violations() {
      if (!hud || !globalThis.AtriumRules?.drc) return [];
      const rev = ctx.revision();
      if (drc.revision !== rev && !drc.timer) drc.timer = setTimeout(() => {
        drc.timer = 0;
        try { const d = ctx.doc(); drc.list = d.kind === "pcb" ? AtriumRules.drc(d, ctx.defs(), AtriumRules.stored(d, ctx.project()) || AtriumRules.defaults(), {limit: 500}).violations : []; } catch { drc.list = []; }
        drc.revision = ctx.revision(); paintOverlay();
      }, 400);
      return drc.list;
    }

    // ---------- snapping (editor snapAt hook)
    function snap(p, o = {}) {
      snapMark = null;
      if (!ctx.pcb() || !snapPrefs.objects || modHeld && !o.force) return null;
      const view = ctx.view(), d = ctx.doc(), defs = ctx.defs(), hidden = ctx.hiddenLayers?.();
      // Only what the user can see and select attracts the cursor.
      const visible = i => (!ctx.selectable || ctx.selectable(i)) && (!hidden || i.kind === "part" || !i.layer || i.layer === "Multi" || !hidden.has(i.layer));
      const padVisible = hidden?.size ? (part, pad) => { const l = pad.layer || (pad.drill > 0 ? "Multi" : part.layer || "Top"); return l === "Multi" || !hidden.has(l); } : null;
      const hit = objectSnap(d, defs, p, {radius: snapPrefs.radius / view.scale(), exclude: o.exclude, query: b => view.query(d, defs, b), visible, padVisible});
      snapMark = hit; return hit ? hit.point : null;
    }

    // ---------- pointer
    function pointerMove(p) {
      lastPointer = p;
      if (hud || snapMark || overlayCanvas) paintOverlay();
    }
    function pointerDown(p) { origin = p; }

    // ---------- locks
    function guardLocked(ids, label, proceed) {
      const d = ctx.doc(), locked = lockedIn(d, ids);
      if (!locked.length || lockBypass === ctx.selectionVersion()) return true;
      const dlg = el("dialog", null, "ui-dialog message-dialog pcb-edit-lock"); dlg.setAttribute("aria-label", "Locked objects");
      const title = el("h2", "Locked objects", "ui-dialog-title");
      const body = el("p", locked.length + (locked.length === 1 ? " selected object is" : " selected objects are") + " locked. " + label + " anyway?", "ui-dialog-body");
      const cancel = button("Cancel", () => dlg.close());
      const go = button(label + " anyway", () => { lockBypass = ctx.selectionVersion(); dlg.close(); proceed?.(); });
      const unlock = button("Unlock all in selection", () => { dlg.close(); ctx.edit(() => applyLock(ctx.doc(), lockPlan(ctx.doc(), ids, false)), undefined, locked); ctx.info(locked.length + " objects unlocked."); proceed?.(); });
      const actions = el("div", null, "ui-dialog-actions");
      for (const action of [cancel, go, unlock]) action.classList.add("ui-button");
      go.dataset.variant = label === "Delete" ? "danger" : "primary";
      go.dataset.uiDefault = "false";
      actions.append(cancel, go, unlock);
      dlg.append(title, body, actions);
      document.body.append(dlg);
      dlg.addEventListener("close", () => dlg.remove(), {once: true});
      globalThis.AtriumShell?.adoptDialog?.(dlg, {initialFocus: cancel});
      dlg.showModal(); cancel.focus();
      return false;
    }

    // ---------- flip
    function flipSelection() {
      const d = ctx.doc(), ids = ctx.selection(), mode = ctx.mode();
      if (mode === "place" || mode === "move-object") { ghostFlip = !ghostFlip; ctx.info(ghostFlip ? "Placing on the bottom side. L flips back." : "Placing on the top side."); ctx.draw(); return; }
      const plan = flipPlan(d, ctx.defs(), ids, {about: mode === "drag" ? "each" : undefined});
      if (!plan.parts.length) { ctx.info("Select components to flip."); return; }
      if (mode === "drag") {
        // Mid-drag: change the model now; the drag commits it as one undo step.
        const parts = applyFlip(d, ctx.project(), plan, ctx.defs()), dr = ctx.drag();
        if (dr) {
          dr.flipLibrary = true;
          dr.mirrorItems ??= new Set();
          for (const part of parts) dr.mirrorItems.add(part);
        }
        ctx.refreshDefs();
        // Drag re-route was planned for the old pads: restart it on the flipped pads, or
        // (without the restart hook) leave the tracks alone for the rest of this drag.
        if (dr?.reroute) {
          let restarted = false;
          try { if (typeof dr.reroute.restart === "function") { dr.reroute.restart(ctx.doc(), ctx.defs()); restarted = true; } } catch { restarted = false; }
          if (!restarted) { try { dr.reroute.cancel(); } catch {} dr.reroute = idleReroute(); ctx.info("Drag re-route is off for the rest of this drag: the part changed side."); }
        }
        ctx.view().invalidate(); ctx.draw(); return;
      }
      if (!guardLocked(plan.parts.map(p => p.id), "Flip", () => run())) return;
      run();
      function run() {
        let refreshed = [], changed = [];
        ctx.edit(() => {
          const p = flipPlan(d, ctx.defs(), ids), parts = applyFlip(d, ctx.project(), p, ctx.defs());
          refreshed = p.refreshed || [];
          changed = parts.concat(ctx.afterFlip?.(parts.map(part => part.id)) || []);
        }, undefined, () => [{doc:d, items:changed, library:true}]);
        ctx.info(plan.parts.length + (plan.parts.length === 1 ? " component" : " components") + " flipped to the " + plan.parts[0].to.side.toLowerCase() + " side." + (refreshed.length ? " " + settleText({mirrors: refreshed, teardrops: []}) + "." : ""));
      }
    }
    // Ghost while placing or moving with move-object: defs to render with, and the ghost item.
    let ghostDefs = null;
    function renderDefs(defs, ghost) {
      if (!ghostFlip || !ghost || ghost.kind !== "part") return defs;
      const def = defs.get(ghost.def); if (!def?.footprint) return defs;
      const m = def.mirrorOf && defs.get(def.mirrorOf) || previewDef(def);
      if (!ghostDefs || ghostDefs.base !== defs || ghostDefs.id !== m.id) { const map = new Map(defs); map.set(m.id, m); ghostDefs = {base: defs, id: m.id, map}; }
      ghost.def = m.id; ghost.layer = isBottom(ghost) ? "Top" : "Bottom"; ghost.angle = norm(-(ghost.angle || 0));
      return ghostDefs.map;
    }
    // After a placed or moved part commits (inside the same undo step).
    function commitGhost(part) {
      if (!ghostFlip || part?.kind !== "part") return false;
      applyFlip(ctx.doc(), ctx.project(), flipPlan(ctx.doc(), ctx.defs(), [part.id], {about: "each"}), ctx.defs());
      ghostFlip = false; return true;
    }
    const reset = () => { ghostFlip = false; snapMark = null; paintOverlay(); };

    let properties;
    const installProperties = ui => properties ??= ui.install(ctx, {el, button, isBottom, LABELS, plural, guardLocked, changeSnap});
    let requestedDialog = 0;
    function openPropertiesDialog(show) {
      const request = ++requestedDialog, owner = ctx.doc(), selected = ctx.selectionVersion();
      if (globalThis.AtriumPCBSelectionInspector) return show(installProperties(globalThis.AtriumPCBSelectionInspector));
      return globalThis.AtriumLazy?.need("AtriumPCBSelectionInspector").then(ui => {
        if (request === requestedDialog && ctx.doc() === owner && ctx.selectionVersion() === selected) show(installProperties(ui));
      }, e => ctx.info(e.message));
    }
    function addProperties(parent, fill) {
      const render = (ui, target) => {
        fill(installProperties(ui), target);
      };
      if (globalThis.AtriumPCBSelectionInspector) render(globalThis.AtriumPCBSelectionInspector, parent);
      else globalThis.AtriumLazy?.appendOnLoad("AtriumPCBSelectionInspector", parent, render, ctx.info);
    }
    function inspectItem(section, item) {
      addProperties(section, (ui, target) => ui.inspectItem(target, item));
    }
    function inspectMulti(panel, section) {
      addProperties(panel, (ui, target) => ui.inspectMulti(target, section));
      return true;
    }
    function filterBar(panel) {
      const docKind = ctx.pcb() ? "pcb" : "schematic", kinds = docKind === "pcb" ? KINDS : SCH_KINDS, f = filters[docKind];
      const changed = () => {
        ctx.pruneSelection?.();
        ctx.inspect();
      };
      const section = el("section", null, "inspect-section pcb-edit-filter-section");
      section.dataset.collapseKey = "Selection Filter";
      const header = el("div", null, "inspect-section-heading");
      const head = el("h3", "Selection Filter"), count = kinds.filter(([k]) => f[k]).length;
      if (count < kinds.length) head.append(el("span", " " + count + "/" + kinds.length, "pcb-edit-filter-count"));
      const bar = el("div", null, "pcb-edit-filter"); bar.setAttribute("role", "group"); bar.setAttribute("aria-label", "Selection filter");
      bar.id = "selection-filter";
      for (const [k, label] of kinds) {
        // Click toggles one kind; Alt/Option-click selects only that kind (Altium's "solo").
        const b = button(label, e => {
          if (e?.altKey) for (const [o] of kinds) setFilter(o, o === k, docKind); else setFilter(k, !f[k], docKind);
          changed();
        }, "ui-chip");
        b.dataset.selectionKind = k;
        b.setAttribute("aria-pressed", String(f[k])); b.title = (f[k] ? "Exclude " : "Include ") + label.toLowerCase() + " (Alt-click: only " + label.toLowerCase() + ")";
        bar.append(b);
      }
      const all = el("a", "Select all", "selection-filter-all");
      all.href = "#selection-filter";
      all.dataset.selectionKind = "all";
      all.onclick = e => {
        e.preventDefault();
        if (count === kinds.length) return;
        for (const [k] of kinds) if (!f[k]) setFilter(k, true, docKind);
        changed();
      };
      header.append(head, all);
      section.append(header, bar);
      if (docKind === "pcb") globalThis.AtriumComponentClasses?.filterControl?.(ctx, section, changed);
      panel.append(section);
    }

    // After every editor edit (editor.js calls this inside the same undo step).
    function settleNow(doc = ctx.doc()) {
      let r; try { r = settle(doc, ctx.project(), ctx.defs()); } catch { return null; }
      const text = settleText(r);
      // Shown after the edit's own message (which follows the edit synchronously).
      if (text) setTimeout(() => { const prev = document.getElementById("status")?.textContent || ""; ctx.info((/[.!?]$/.test(prev) && !prev.includes(text) ? prev + " " : "") + text + "."); }, 0);
      return r;
    }
    // Before fab outputs, DRC, BOM or 3D export: a mirrored footprint must not be stale.
    function beforeOutput(a) {
      if (!/^(fab|fab-outputs|drc|bom|step|export|connectivity)$/.test(a || "")) return;
      const project = ctx.project(), lib = project?.library || [];
      const stale = lib.filter(m => m.mirrorOf).some(m => { const o = lib.find(d => d.id === m.mirrorOf && !d.mirrorOf); return o && signature(o, sigInner(m.mirrorSig) ?? 0) !== m.mirrorSig; });
      if (!stale) return;
      let r = [];
      ctx.edit(() => { const d = ctx.doc(); r = refreshMirrors(project, d?.kind === "pcb" ? {inner: innerCount(d, ctx.defs())} : {}); }, undefined, [{library:true}]);
      if (r.length) ctx.info(settleText({mirrors: r, teardrops: []}) + ".");
    }

    // Schematic Find Similar lives in sch-similar.js (lazy; the editor's gate normally loads it first).
    function schSimilar() {
      const host = {...ctx, selectDocument: id => globalThis.AtriumNavHost?.selectDocument?.(id)};
      const S = globalThis.AtriumSchSimilar;
      if (S) { S.open(host); return; }
      const L = globalThis.AtriumLazy;
      if (!L?.need) { ctx.info("Find Similar Objects is unavailable in this build."); return; }
      L.need("AtriumSchSimilar").then(m => m.open(host), e => ctx.info(e.message));
    }

    function syncSnapButton() {
      const K = globalThis.AtriumKeymap, C = globalThis.AtriumNavCommon;
      const b = document.querySelector('[data-action="snap-options"]');
      if (b) {
        b.setAttribute("aria-pressed", String(snapPrefs.objects));
        C?.shortcutTitle(b, "Snap options · object snap " + (snapPrefs.objects ? "on" : "off"), K?.hintKey("snap-object", "pcb"));
      }
      document.body?.classList?.toggle?.("pcb-flipped", !!ctx.view()?.flipped?.());
      let badge = document.getElementById("pcb-flip-badge");
      const flipped = ctx.pcb() && !!ctx.view()?.flipped?.();
      if (flipped && !badge) { badge = el("span", "Bottom view", "pcb-flip-badge"); badge.id = "pcb-flip-badge"; document.getElementById("status")?.before(badge); }
      if (badge) {
        badge.hidden = !flipped;
        if (flipped) C?.shortcutTitle(badge, "Board flipped", K?.hintKey("flip-board", "pcb"));
      }
    }

    function act(a) {
      const d = ctx.doc();
      switch (a) {
        case "flip-side": if (ctx.pcb()) flipSelection(); return true;
        case "flip-board": {
          if (!ctx.pcb()) return true;
          const v = ctx.view(); if (!v.setFlipped) { ctx.info("This build cannot flip the board."); return true; }
          v.setFlipped(!v.flipped()); ctx.onFlipBoard?.(v.flipped()); syncSnapButton(); ctx.draw();
          const hint = globalThis.AtriumKeymap?.hintFor("flip-board", "pcb");
          ctx.info(v.flipped() ? "Viewing from the bottom (mirrored)." + (hint ? " " + hint + " flips back." : "") : "Viewing from the top.");
          return true;
        }
        case "lock": case "unlock": {
          const plan = lockPlan(d, ctx.selection(), a === "lock");
          if (plan.ids.length) ctx.edit(() => applyLock(ctx.doc(), plan));
          ctx.info(plan.ids.length + (a === "lock" ? " objects locked." : " objects unlocked.")); return true;
        }
        case "union-create": case "union-break": case "union-add": {
          const plan = unionPlan(d, ctx.selection(), a.slice(6), ctx.primary());
          if (plan.set.length) { ctx.edit(() => applyUnion(ctx.doc(), plan)); if (plan.unionId) ctx.select(ctx.doc().items.filter(i => unionOf(i) === plan.unionId).map(i => i.id)); }
          ctx.info(plan.message); return true;
        }
        case "find-similar": if (ctx.pcb()) openPropertiesDialog(ui => ui.findSimilarDialog()); else if (d?.kind === "schematic") schSimilar(); return true;
        case "snap-object": changeSnap("objects", !snapPrefs.objects); ctx.info("Object snap " + (snapPrefs.objects ? "on" : "off") + "."); return true;
        case "snap-options": openPropertiesDialog(ui => ui.snapPopover(document.querySelector('[data-action="snap-options"]'))); return true;
        case "hud": hud = !hud; if (!hud) { overlay && overlayCanvas && overlay.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height); } else paintOverlay(); ctx.info("Heads-up display " + (hud ? "on" : "off") + " (Shift+H)."); return true;
        case "teardrops": if (globalThis.AtriumTeardrops) AtriumTeardrops.open({doc: ctx.doc(), defs: ctx.defs(), project: ctx.project(), selection: [...ctx.selection()], edit: ctx.edit, info: ctx.info}); else ctx.info("This feature is unavailable in this build."); return true;
      }
      return false;
    }
    snapChanged = key => {
      if (key === "objects") {syncSnapButton(); ctx.syncChecks?.();}
    };
    syncSnapButton();
    return {act, snap, pointerMove, pointerDown, guardLocked, renderDefs, commitGhost, reset, inspectItem, inspectMulti, filterBar, settle: settleNow, beforeOutput, mates,
      selectable: i => ctx.pcb() ? allows(i, filters.pcb, "pcb") : allows(i, filters.schematic, "schematic"), sync: syncSnapButton, paint: paintOverlay, state: st, snapPrefs};
  }

  return Object.freeze({mirrorLayer, mirrorFootprint, mirrorPad, mirrorShape, counterpart, refreshMirrors, innerCount, previewDef, flipPlan, applyFlip, flip, settle,
    isLocked, lockedIn, lockPlan, applyLock, unionPlan, applyUnion, isUnion, unionOf, mates,
    KINDS, SCH_KINDS, kindOf, filter, filters, setFilter, allows, VARIES, FIELDS, sharedFields, applyField, ruleCheck,
    similarProps, findSimilar, snapPrefs, setSnap, objectSnap, hudLines, nearestViolation, install});
})();
