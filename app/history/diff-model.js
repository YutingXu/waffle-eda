"use strict";
// AtriumDiffModel: the visual diff's session model (DOM-free; tests load it under JSC).
//
//   const m = AtriumDiffModel.create(before, after, {from, to})   // two project JSON objects and labels
//   await m.run({onPartial, onProgress, active})                    // fills m.changes progressively
//   m.filter({severities, statuses, kinds, nets, layers, docs, hideCosmetic, query}) -> changes
//   m.groups(list)  -> [{severity, label, count, kinds:[{kind, label, items}]}]   electrical first
//   m.geometry(c)   -> {before, after, box, centre}   shapes in world units (cached on the change)
//   m.linked(c)     -> changes on other documents for the same designator (cross-probe in diff)
//   m.summary()     -> {electrical, layout, cosmetic, total, text}
//   m.layerCounts(docId), m.docCounts(), m.link(c), m.speak(c), m.drcDelta()
//
// The comparison is the one engine, AtriumDiff.compareAsync (diff.js: a worker on
// large designs, 8 ms slices otherwise, cancellable), read through fromEngine().
globalThis.AtriumDiffModel = (() => {
  const A = () => globalThis.Atrium;
  const SEVERITIES = ["electrical", "layout", "cosmetic"];
  const SEVERITY_LABEL = {electrical: "Electrical", layout: "Layout", cosmetic: "Cosmetic"};
  const STATUSES = ["added", "removed", "moved", "modified", "properties"];
  const STATUS_LABEL = {added: "Added", removed: "Removed", moved: "Moved", modified: "Modified", properties: "Properties"};
  const KIND_LABEL = {part: "Components", pin: "Pin nets", net: "Nets", track: "Tracks", via: "Vias", pad: "Pads", polygon: "Pours", pour: "Pours", region: "Regions", fill: "Fills",
    wire: "Wires", netlabel: "Net labels", power: "Power ports", port: "Ports", junction: "Junctions", label: "Text", document: "Documents", library: "Library", rules: "Rules",
    routing: "Routing", drc: "DRC", board: "Board", project: "Project", sheetsymbol: "Sheet symbols", order: "Drawing order", comments: "Comments",
    // Rules, signals (format 1.4), waivers and the other non-geometric kinds the engine reports.
    rule: "Rules", ruleSet: "Rule sets", netClass: "Net classes", diffPair: "Differential pairs", diffPairClass: "Differential pair classes", componentClass: "Component classes",
    signal: "Signals", tag: "Tags", netTag: "Net tags", waiver: "Waivers", variant: "Variants", room: "Rooms", block: "Layout blocks", arc: "Arcs", bus: "Buses",
    busentry: "Bus entries", offsheet: "Off-sheet connectors", graphic: "Graphics", text: "Text"};
  const KIND_ORDER = ["document", "net", "pin", "drc", "part", "wire", "netlabel", "power", "port", "junction", "track", "via", "pad", "polygon", "pour", "region", "fill", "label", "library",
    "signal", "netTag", "tag", "netClass", "diffPair", "diffPairClass", "componentClass", "rule", "ruleSet", "rules", "variant", "waiver"];
  const num = v => typeof v === "number" && Number.isFinite(v);
  const isPoint = p => Array.isArray(p) && p.length === 2 && p.every(num);
  const union = (a, b) => !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const centre = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  // Unknown kinds: "fooBar" → "Foo bars", "class" → "Classes".
  const kindLabel = k => KIND_LABEL[k] || (k ? (w => w[0].toUpperCase() + w.slice(1) + (/(s|x|ch|sh)$/.test(w) ? "es" : "s"))(String(k).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()) : "Other");

  // ------------------------------------------------------------ engine adapter
  // AtriumDiff (diff.js): {summary, changes[], byObject, byNet, stats}; each change
  // {id, kind:"<type>.<verb>", category, severity:"electrical"|"mechanical"|"cosmetic", target, before, after,
  // text, geometry:{doc, box, before, after}, match, fields:[names]}. The view's vocabulary is
  // added / removed / moved / modified / properties and electrical / layout / cosmetic.
  const VERB_STATUS = {added: "added", connected: "added", new: "added", removed: "removed", disconnected: "removed", fixed: "removed", moved: "moved",
    rotated: "modified", mirrored: "modified", flipped: "modified", reshaped: "modified", layer: "modified", outline: "modified", shape: "modified",
    merged: "modified", split: "modified", changed: "modified", geometry: "modified", stackup: "modified"};
  const SEV_MAP = {electrical: "electrical", mechanical: "layout", layout: "layout", cosmetic: "cosmetic"};
  function fromEngine(r, P0, P1, defs = {}) {
    const out = [];
    let n = 0;
    const pins = sideNets(P0, P1), byNet = r?.byNet && typeof r.byNet === "object" ? r.byNet : {};
    const lib = side => defs[side] || new Map(((side === "before" ? P0 : P1)?.library || []).map(d => [d.id, d]));
    const ctx = {before: lib("before"), after: lib("after")};
    for (const c of Array.isArray(r?.changes) ? r.changes : []) {
      if (!c || typeof c !== "object") continue;
      const t = c.target && typeof c.target === "object" ? c.target : {}, kind = String(c.kind || ""), dot = kind.indexOf(".");
      // The kind's prefix is the most specific type (pin, net, routing, part…); target.type when there is no kind.
      const type = String((dot > 0 ? kind.slice(0, dot) : kind) || t.type || "object"), verb = dot > 0 ? kind.slice(dot + 1) : "changed";
      // The engine gives the coarse class itself; the verb table only covers rows without one.
      const status = STATUSES.includes(c.status) ? c.status : type === "pin" ? "properties" : VERB_STATUS[verb] || "properties";
      const g = c.geometry && typeof c.geometry === "object" ? c.geometry : null;
      const objectKind = type === "pin" ? "pin" : type === "net" ? "net" : type === "routing" ? "routing" : type === "drc" ? "drc" : type;
      const nets = [...new Set([t.net, t.beforeNet, t.afterNet, ...(Array.isArray(t.beforeNets) ? t.beforeNets : []), ...(Array.isArray(t.afterNets) ? t.afterNets : []),
        typeof c.before?.net === "string" ? c.before.net : null, typeof c.after?.net === "string" ? c.after.net : null].filter(x => typeof x === "string" && x))];
      const ch = {id: "e" + (++n), engineId: c.id, key: String(c.id || kind + "/" + (t.doc || "") + "/" + (t.id ?? n)), status, severity: SEV_MAP[c.severity] || "layout",
        doc: t.doc ?? g?.doc ?? null, docName: t.docName || "", docKind: "", item: t.afterId ?? t.id ?? t.part ?? null, beforeItem: t.beforeId ?? t.id ?? t.part ?? null,
        objectKind, kind, category: c.category || "", name: String(t.label || t.ref || t.pin || t.net || t.name || t.rule || TYPE_NAME[type] || type), ref: t.ref || "", pin: t.pin ?? null,
        layer: t.layer || (typeof c.after?.layer === "string" ? c.after.layer : "") || (typeof c.before?.layer === "string" ? c.before.layer : "") || "",
        nets, text: String(c.text || ""), sentence: plainSentence(String(c.text || "")), fields: engineFields(c, ctx), confidence: c.match?.confidence ?? null, matchReasons: c.match?.reasons || [], matchReview: !!c.match?.review, engineGeometry: g};
      if (type === "pin" && t.part != null) { ch.item = t.part; ch.beforeItem = t.part; }
      if (c.translation) ch.translation = c.translation;
      if (type === "net" && (verb === "merged" || verb === "split" || verb === "renamed")) ch.topology = topologyOf(verb, c, pins, byNet, t);
      // Schematic net rows are project-wide: put them on the sheet that holds their pins.
      if (ch.doc == null && type === "net" || ch.doc == null && type === "pin") {
        const e = byNet[t.net] || byNet[t.afterNet] || byNet[t.beforeNet], x = [...(e?.schematic?.after || []), ...(e?.schematic?.before || [])].find(y => y && y.doc);
        if (x) ch.doc = x.doc;
      }
      if (kind === "routing.changed") ch.routing = {lengthBefore: c.before?.length ?? 0, lengthAfter: c.after?.length ?? 0, viasBefore: c.before?.vias ?? 0, viasAfter: c.after?.vias ?? 0};
      if (status === "moved" && g?.before?.box && g?.after?.box) { const a = centre(g.before.box), b = centre(g.after.box); ch.move = {dx: b[0] - a[0], dy: b[1] - a[1]}; }
      out.push(ch);
    }
    return out;
  }
  const TYPE_NAME = {part: "Component", track: "Track", via: "Via", pad: "Pad", polygon: "Pour", wire: "Wire", netlabel: "Net label", label: "Text", library: "Library", rules: "Rules",
    document: "Document", board: "Board", project: "Project", order: "Drawing order", comments: "Comments"};
  const LENGTH = new Set(["width", "diameter", "drill", "w", "h", "r", "radius", "size", "x", "y"]);
  const fmt = v => { const r = Math.round(v * 1000) / 1000; return String(Object.is(r, -0) ? 0 : r); };
  function same(a, b) {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-9;
    if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => same(x, b[i]));
    if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
    const ka = Object.keys(a), kb = Object.keys(b);
    return ka.length === kb.length && ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && same(a[k], b[k]));
  }
  // A field value as table text (design text stays text: the view sets it with textContent).
  function show(v, key) {
    const cut = s => s.length > 80 ? s.slice(0, 79) + "…" : s;
    if (v === undefined) return "—";
    if (v === null) return "none";
    if (v === "") return "empty";
    if (typeof v === "boolean") return v ? "yes" : "no";
    if (typeof v === "number") return fmt(v) + (LENGTH.has(key) ? " mm" : key === "angle" ? "°" : "");
    if (Array.isArray(v) && key === "points") return v.length + " points";
    if (Array.isArray(v) && v.length === 2 && v.every(num)) return "(" + fmt(v[0]) + ", " + fmt(v[1]) + ")";
    if (Array.isArray(v) && v.every(x => typeof x === "string" || num(x))) return cut(v.join(", ")) || "none";
    if (typeof v === "string") return cut(v);
    let t; try { t = JSON.stringify(v); } catch { t = String(v); }
    return cut(t);
  }
  // Human labels for model fields, as Compare Revisions shows them; internal keys go behind "More fields".
  const FIELD = {ref: "Designator", value: "Value", comment: "Comment", def: "Library part", x: "X", y: "Y", angle: "Rotation", layer: "Layer", mirror: "Mirrored",
    mirrored: "Mirrored", net: "Net", width: "Width", diameter: "Diameter", drill: "Drill", text: "Text", points: "Shape", number: "Pad number", shape: "Pad shape",
    w: "Width", h: "Height", dnp: "Do not populate", locked: "Locked", parameters: "Parameters", name: "Name", fromLayer: "Start layer", toLayer: "End layer",
    size: "Text height", own: "Own-net copper", foreign: "Other nets touching"};
  const INTERNAL = new Set(["id", "kind", "link", "refAt", "valueAt", "schPaint", "showRef", "showValue", "font", "family", "ink", "unit", "gate", "at", "align",
    "sourceId", "sourceName", "altiumSourceId", "kicadSourceId", "uid", "uuid", "style", "hidden", "order", "z"]);
  const label = k => FIELD[k] || String(k).replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, ch => ch.toUpperCase());
  function engineFields(c, ctx = {}) {
    const names = Array.isArray(c.fields) ? c.fields.filter(f => typeof f === "string") : [];
    const plain = v => v !== null && typeof v === "object" && !Array.isArray(v);
    const libName = (side, id) => { const d = ctx[side]?.get?.(id); return d ? String(d.name || id) : id; };
    const value = (side, v, k) => k === "def" && typeof v === "string" ? libName(side, v) : show(v, k);
    if (plain(c.before) || plain(c.after)) {
      const keys = names.length && !(c.before && c.after && !names.some(k => k in (c.after || {}) || k in (c.before || {}))) ? names
        : [...new Set([...Object.keys(c.before || {}), ...Object.keys(c.after || {})])];
      const rows = [];
      for (const k of keys) {
        if (k === "pinNets") {
          // One row per pin: "Pin 2 net".
          const a = plain(c.before?.pinNets) ? c.before.pinNets : {}, b = plain(c.after?.pinNets) ? c.after.pinNets : {};
          for (const pin of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort((x, y) => x.localeCompare(y, undefined, {numeric: true})))
            rows.push({key: "pin:" + pin, label: "Pin " + pin + " net", before: c.before ? show(a[pin] ?? "", "net") : "", after: c.after ? show(b[pin] ?? "", "net") : "", changed: (a[pin] ?? "") !== (b[pin] ?? "")});
          continue;
        }
        rows.push({key: k, label: label(k), before: c.before ? value("before", c.before[k], k) : "", after: c.after ? value("after", c.after[k], k) : "",
          changed: !same(c.before?.[k], c.after?.[k]), hidden: INTERNAL.has(k)});
      }
      return rows.sort((p, q) => Number(!!p.hidden) - Number(!!q.hidden) || Number(q.changed) - Number(p.changed)).slice(0, 60);
    }
    if (c.before == null && c.after == null) return [];
    const kind = String(c.kind || ""), name = names[0];
    const lab = name ? label(name) : kind.startsWith("net.") ? (/^net\.(added|removed)$/.test(kind) ? "Pins" : Array.isArray(c.before) || Array.isArray(c.after) ? "Nets" : "Net")
      : kind.startsWith("pin.") ? "Net" : kind.startsWith("drc.") ? "Violation" : label(kind.split(".").pop());
    return [{key: name || "value", label: lab, before: value("before", c.before, name), after: value("after", c.after, name), changed: true}];
  }
  // The row text: the engine's sentence without its "PCB Sensor board: " / "Schematic: " prefix (the
  // row's second line names the document).
  const plainSentence = t => t.replace(/^(?:PCB [^:]{1,80}|Schematic): /, "");
  // Pin membership per net name on each side (pinNets of parts on every document), for the diagram.
  function sideNets(P0, P1) {
    const of = P => { const m = new Map(); for (const d of P?.documents || []) for (const i of d?.items || []) if (i?.kind === "part" && i.pinNets && typeof i.pinNets === "object")
      for (const pin of Object.keys(i.pinNets)) { const net = i.pinNets[pin]; if (!net) continue; if (!m.has(net)) m.set(net, new Set()); m.get(net).add((i.ref || i.id) + "." + pin); } return m; };
    return {before: of(P0), after: of(P1)};
  }
  // Net merge / split / rename diagram from the engine's byNet (pin labels per side, gained and lost);
  // pinNets only when the engine has no entry (an older engine).
  function topologyOf(verb, c, pins, byNet = {}, t = {}) {
    const list = v => Array.isArray(v) ? v : v != null ? [v] : [];
    const domain = String(t.domain || ""), board = domain.startsWith("pcb:") ? domain.slice(4) : null;
    const labels = v => list(v).map(x => typeof x === "string" ? x : x?.label).filter(Boolean);
    const sideOf = (net, side) => {
      const e = byNet[net], d = board ? e?.boards?.[board] : e?.schematic;
      if (d && Array.isArray(d[side])) return {nodes: labels(d[side]).sort().slice(0, 12), gained: labels(d.gained), lost: labels(d.lost)};
      return {nodes: [...(pins[side].get(net) || [])].sort().slice(0, 12), gained: [], lost: []};
    };
    const where = board ? "Board" : "Schematic";
    const col = (side, net) => { const x = sideOf(net, side); return {net, nodes: x.nodes, gained: side === "after" ? x.gained : [], lost: side === "before" ? x.lost : []}; };
    return {type: verb === "merged" ? "merge" : verb === "split" ? "split" : "rename", where,
      before: list(c.before).filter(x => typeof x === "string").map(net => col("before", net)),
      after: list(c.after).filter(x => typeof x === "string").map(net => col("after", net))};
  }
  // ------------------------------------------------------------ geometry
  function shapeOf(item, doc, defs) {
    if (!item || !doc) return null;
    let pts = null;
    try { pts = A().itemPoints(item, defs.get(item.def), doc.kind); } catch { pts = null; }
    let box = pts?.length ? A().bounds(pts) : null;
    if (box && !box.every(Number.isFinite)) box = null;
    if (!box && num(item.x) && num(item.y)) box = [item.x - 1, item.y - 1, item.x + 1, item.y + 1];
    if (!box) return null;
    const w = num(item.width) ? item.width : 0;
    if (w) box = [box[0] - w / 2, box[1] - w / 2, box[2] + w / 2, box[3] + w / 2];
    const path = Array.isArray(item.points) && item.points.length > 1 && item.points.every(isPoint) ? item.points : null;
    return {box, path, closed: item.kind === "polygon" || item.kind === "region" || item.kind === "fill", width: w,
      round: item.kind === "via" || item.kind === "junction" || item.kind === "pad" && /round|circle/i.test(item.shape || "")};
  }
  function pinShape(part, pin, doc, defs) {
    if (!part) return null;
    try {
      const p = A().pins(part, defs.get(part.def), doc.kind).find(q => String(q.number) === String(pin));
      if (!p?.at) return null;
      const r = doc.kind === "pcb" ? Math.max(.4, Math.min(1.2, (p.w || p.diameter || .8) / 2 + .15)) : 1.0;
      return {box: [p.at[0] - r, p.at[1] - r, p.at[0] + r, p.at[1] + r], path: null, round: true, width: 0, dot: p.at};
    } catch { return null; }
  }

  // ------------------------------------------------------------ session
  function create(P0, P1, o = {}) {
    const defs0 = new Map((P0?.library || []).map(d => [d.id, d])), defs1 = new Map((P1?.library || []).map(d => [d.id, d]));
    const docs0 = new Map((P0?.documents || []).map(d => [d.id, d])), docs1 = new Map((P1?.documents || []).map(d => [d.id, d]));
    const index = new Map();    // doc id -> {before: Map(id->item), after: Map}
    const m = {P0, P1, defs0, defs1, from: String(o.from || "Before"), to: String(o.to || "After"), changes: [], docs: [], routing: [], drc: null, done: false,
      engine: false, stats: null, version: 0};
    // Lookups the view makes on every step (J/K, click, cross-probe): by row id and by designator.
    const byId = new Map(), byRef = new Map();
    m.byId = id => byId.get(id) || null;
    function itemsOf(d) {
      if (!d) return new Map();
      return new Map(d.items.filter(Boolean).map(i => [i.id, i]));
    }
    function idx(doc) {
      let e = index.get(doc.id);
      if (!e) {
        const d0 = docs0.get(doc.before ?? doc.id) || null, d1 = docs1.get(doc.after ?? doc.id) || null;
        e = {d0, d1, before: null, after: null};
        index.set(doc.id, e);
      }
      return e;
    }
    m.sides = docId => {
      const d = m.docs.find(x => x.id === docId);
      if (d) { const e = idx(d); return {before: e.d0, after: e.d1}; }
      return {before: docs0.get(docId) || null, after: docs1.get(docId) || null};
    };
    m.item = (side, docId, id) => {
      const d = m.docs.find(x => x.id === docId) || {id: docId};
      const e = idx(d);
      if (side === "before") { e.before ??= itemsOf(e.d0); return e.before.get(id) || null; }
      e.after ??= itemsOf(e.d1); return e.after.get(id) || null;
    };
    m.geometry = c => {
      if (c.geo) return c.geo;
      const s = m.sides(c.doc), g = {before: null, after: null, box: null, centre: null, dots: null};
      const eg = c.engineGeometry;
      if (eg && (eg.box || eg.before || eg.after) && !(c.objectKind === "net" && c.topology)) {
        const norm = x => x && Array.isArray(x.box) ? {box: x.box, path: x.path || x.points || null, closed: !!x.closed, width: x.width || 0, round: !!x.round} : null;
        g.before = norm(eg.before);
        // The change's box stands in for a missing shape, but a removed object has no after side.
        g.after = norm(eg.after) || (Array.isArray(eg.box) && c.status !== "removed" ? {box: eg.box, path: null, width: 0} : null);
        if (!g.before && !g.after && Array.isArray(eg.box)) g.before = {box: eg.box, path: null, width: 0};
      } else if (c.objectKind === "pin") {
        g.before = s.before ? pinShape(m.item("before", c.doc, c.beforeItem ?? c.item), c.pin, s.before, defs0) : null;
        g.after = s.after ? pinShape(m.item("after", c.doc, c.item), c.pin, s.after, defs1) : null;
      } else if (c.objectKind === "net" && c.topology) {
        const dots = [];
        const sideOf = (doc, defs, which, groups) => {
          if (!doc) return;
          const byRef = new Map(doc.items.filter(i => i?.kind === "part").map(i => [i.ref || i.id, i]));
          for (const grp of groups || []) for (const node of grp.nodes || []) {
            const at = node.lastIndexOf("."), sh = pinShape(byRef.get(node.slice(0, at)), node.slice(at + 1), doc, defs);
            if (sh) dots.push({at: sh.dot, net: grp.net, side: which});
          }
        };
        sideOf(s.after, defs1, "after", c.topology.after);
        if (!dots.length) sideOf(s.before, defs0, "before", c.topology.before);
        let b = null;
        for (const d of dots) b = union(b, [d.at[0] - 1, d.at[1] - 1, d.at[0] + 1, d.at[1] + 1]);
        g.dots = dots; if (b) g.after = {box: b, path: null, width: 0, dotted: true};
        else if (eg?.box) { g.dots = null; g.after = {box: eg.box, path: null, width: 0}; }
      } else if (c.item != null || c.beforeItem != null) {
        if (c.status !== "added" && s.before) g.before = shapeOf(m.item("before", c.doc, c.beforeItem ?? c.item), s.before, defs0);
        if (c.status !== "removed" && s.after) g.after = shapeOf(m.item("after", c.doc, c.item), s.after, defs1);
      } else if (c.objectKind === "document") {
        const d = s.after || s.before;
        try { const b = d && A().docBounds(d, s.after ? defs1 : defs0); if (b) g[s.after ? "after" : "before"] = {box: b, path: null, width: 0}; } catch {}
      }
      g.box = union(g.after?.box || null, c.status === "moved" ? null : g.before?.box || null) || g.before?.box || null;
      if (c.status === "moved" && g.before && g.after) g.span = union(g.before.box, g.after.box);
      g.centre = g.box ? centre(g.box) : null;
      c.geo = g;
      return g;
    };
    function add(list, doc) {
      if (doc && !m.docs.some(d => d.id === doc.id)) m.docs.push(doc);
      // A footprint with no layer sits on Top (the canvas draws it there): count it on Top's layer tab.
      for (const c of list || []) {
        if (c.docKind === "pcb" && c.objectKind === "part" && !c.layer) c.layer = "Top";
        m.changes.push(c); byId.set(c.id, c);
        if (c.ref) { let l = byRef.get(c.ref); if (!l) byRef.set(c.ref, l = []); l.push(c); }
      }
      m.version++;
    }
    m.add = add;
    m.run = async (r = {}) => {
      const D = globalThis.AtriumDiff;
      const t0 = Date.now();
      if (typeof D?.compareAsync !== "function") throw Error("The design comparison engine (diff.js) is not loaded.");
      // A missing Git file is an empty comparison side. The Git reader already validated each present file.
      const res = await D.compareAsync(P0, P1, {geometry: true, validate: !o.missingSide}, r.active || (() => true));
      if (!res || (r.active && !r.active())) return null;
      m.engine = true; m.components = res.components || [];
      m.translatedItems = c => {
        const row = res.changes.findIndex(change => change.id === c.engineId);
        return row < 0 ? [] : (docs1.get(c.doc)?.items || []).filter(i => res.byObject[i.id]?.includes(row));
      };
      // Documents as the engine paired them (re-imported or undo states pair by content, not id):
      // summary.documents [{id, beforeId, status}] with id the after side's id.
      const docs = new Map(), sum = res.summary || {};
      for (const d of Array.isArray(sum.documents) ? sum.documents : []) {
        const removed = d.status === "removed", added = d.status === "added";
        const after = removed ? null : docs1.has(d.id) ? d.id : null, before = added ? null : d.beforeId ?? (removed ? d.id : null);
        const id = after ?? before ?? d.id;
        docs.set(id, {id, name: d.name || (docs1.get(after) || docs0.get(before))?.name || "", kind: d.kind || (docs1.get(after) || docs0.get(before))?.kind,
          side: added ? "added" : removed ? "removed" : "both", before: docs0.has(before) ? before : null, after, status: d.status});
      }
      const pairedBefore = new Set([...docs.values()].map(d => d.before).filter(Boolean));
      for (const d of P1?.documents || []) if (!docs.has(d.id)) docs.set(d.id, {id: d.id, name: d.name, kind: d.kind, side: docs0.has(d.id) && !pairedBefore.has(d.id) ? "both" : "added", before: docs0.has(d.id) && !pairedBefore.has(d.id) ? d.id : null, after: d.id});
      const used = new Set([...docs.values()].map(d => d.before).filter(Boolean));
      for (const d of P0?.documents || []) if (!used.has(d.id) && !docs.has(d.id)) docs.set(d.id, {id: d.id, name: d.name, kind: d.kind, side: "removed", before: d.id, after: null});
      index.clear();
      const list = fromEngine(res, P0, P1, {before: defs0, after: defs1});
      // A change names the after-side document; a removed document's rows name the before side.
      const byBefore = new Map([...docs.values()].filter(d => d.before).map(d => [d.before, d]));
      for (const c of list) if (c.doc != null && !docs.has(c.doc) && byBefore.has(c.doc)) c.doc = byBefore.get(c.doc).id;
      for (const c of list) {
        const d = docs.get(c.doc);
        if (d) { c.docName ||= d.name; c.docKind ||= d.kind; }
        else if (c.objectKind === "library") c.docKind = "library";
        if (c.category === "schematic" && !c.docKind) c.docKind = "schematic";
      }
      m.docs = [...docs.values()];
      // Progressive display: the first 400 rows paint at once, the rest follow in one batch a frame later
      // (every batch costs the view a full list refresh, so more batches only delay the last row).
      for (let k = 0; k < list.length;) { const n = k ? list.length - k : 400, part = list.slice(k, k + n); k += n; add(part, null); r.onPartial?.(part, null); if (k < list.length) await idle(); if (r.active && !r.active()) return null; }
      const nameOf = id => docs.get(id)?.name || "";
      m.routing = (Array.isArray(res.routing) ? res.routing.map(x => ({...x, docName: x.docName || nameOf(x.doc)}))
        : list.filter(c => c.routing).map(c => ({doc: c.doc, docName: c.docName, net: c.nets[0] || c.name, ...c.routing})))
        .sort((x, y) => Math.abs(y.lengthAfter - y.lengthBefore) - Math.abs(x.lengthAfter - x.lengthBefore));
      m.stats = {ms: Date.now() - t0, engine: true, ...(res.stats || {})};
      m.byNet = res.byNet || {};
      m.warnings = Array.isArray(res.stats?.warnings) ? res.stats.warnings.map(String) : [];
      m.headline = Array.isArray(sum.headline) ? sum.headline.map(x => plainSentence(String(x))) : [];
      m.suppressed = sum.suppressed || null;
      m.identical = !!sum.identical;
      for (const d of m.docs) d.counts = countOf(m.changes.filter(c => c.doc === d.id));
      m.done = true; m.version++;
      return m;
    };
    m.filter = (f = {}) => {
      const q = String(f.query || "").trim().toLowerCase();
      const words = q ? q.split(/\s+/) : [];
      return m.changes.filter(c => {
        if (f.hideCosmetic && c.severity === "cosmetic") return false;
        // A whole added or removed document is one row; its objects show only when expanded.
        if (c.objectKind !== "document" && c.doc != null && !(f.expanded && f.expanded.has(c.doc))) { const d = docOf(c.doc); if (d && d.side !== "both") return false; }
        if (f.severities && !f.severities.has(c.severity)) return false;
        if (f.statuses && !f.statuses.has(c.status)) return false;
        if (f.kinds && !f.kinds.has(c.objectKind)) return false;
        if (f.docs && !f.docs.has(c.doc)) return false;
        if (f.layers && c.docKind === "pcb" && c.layer && !f.layers.has(c.layer)) return false;
        if (f.nets && f.nets.size && !(c.nets || []).some(n => f.nets.has(n))) return false;
        if (words.length) {
          const hay = (c.sentence + " " + c.name + " " + (c.nets || []).join(" ") + " " + c.layer + " " + c.docName + " " + c.status + " " + c.severity).toLowerCase();
          if (!words.every(w => hay.includes(w))) return false;
        }
        return true;
      });
    };
    const docOf = id => m.docs.find(d => d.id === id) || null;
    m.wholeCount = docId => m.changes.filter(c => c.doc === docId && c.objectKind !== "document").length;
    // Grouped by document (the default: J/K stays on one document), then severity and kind; or by severity.
    m.groups = (list = m.changes, by = "severity") => {
      const notes=list.filter(c=>c.category==="notes");
      const ordinary=notes.length?list.filter(c=>c.category!=="notes"):list;
      const groups=by==="document"?byDocument(ordinary):bySeverity(ordinary);
      if(notes.length) groups.push({severity:"cosmetic",label:"Notes",count:notes.length,kinds:[{kind:"note",label:"Notes",items:notes}]});
      return groups;
    };
    const order = k => { const i = KIND_ORDER.indexOf(k); return i < 0 ? 99 : i; };
    function byDocument(list) {
      const out = [], keys = [...new Set(list.map(c => c.doc ?? "~project"))];
      const rank = k => { const i = m.docs.findIndex(d => d.id === k); return i < 0 ? 999 : i; };
      for (const k of keys.sort((a, b) => rank(a) - rank(b))) {
        const rows = list.filter(c => (c.doc ?? "~project") === k), d = docOf(k), kinds = [];
        for (const sev of SEVERITIES) {
          const byKind = new Map();
          for (const c of rows) if (c.severity === sev) { if (!byKind.has(c.objectKind)) byKind.set(c.objectKind, []); byKind.get(c.objectKind).push(c); }
          for (const [kind, items] of [...byKind].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0]))) kinds.push({kind, severity: sev, label: SEVERITY_LABEL[sev] + " · " + kindLabel(kind), items});
        }
        const sev = SEVERITIES.find(x => rows.some(c => c.severity === x)) || "layout";
        out.push({severity: sev, doc: k, label: d ? d.name : rows[0]?.docName || "Project and library", count: rows.length, kinds});
      }
      return out;
    }
    const bySeverity = list => SEVERITIES.map(sev => {
      const rows = list.filter(c => c.severity === sev), kinds = new Map();
      for (const c of rows) { if (!kinds.has(c.objectKind)) kinds.set(c.objectKind, []); kinds.get(c.objectKind).push(c); }
      return {severity: sev, label: SEVERITY_LABEL[sev], count: rows.length,
        kinds: [...kinds].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0])).map(([kind, items]) => ({kind, label: kindLabel(kind), items}))};
    }).filter(g => g.count);
    // Document order for J/K: severity groups first, then kinds, as listed.
    m.ordered = (list = m.changes, by = "severity") => m.groups(list, by).flatMap(g => g.kinds.flatMap(k => k.items));
    m.summary = (list = m.changes) => {
      const s = countOf(list);
      const parts = SEVERITIES.filter(k => s[k]).map(k => s[k] + " " + k);
      return {...s, text: parts.length ? parts.join(" · ") + (parts.length ? " change" + (s.total === 1 ? "" : "s") : "") : "No changes"};
    };
    m.docCounts = () => new Map(m.docs.map(d => [d.id, countOf(m.changes.filter(c => c.doc === d.id))]));
    m.layerCounts = docId => {
      const out = new Map();
      for (const c of m.changes) if (c.doc === docId && c.layer) out.set(c.layer, (out.get(c.layer) || 0) + 1);
      return out;
    };
    m.linked = c => {
      if (!c?.ref || c.docKind === "library") return [];
      return (byRef.get(c.ref) || m.changes.filter(x => x.ref === c.ref)).filter(x => x !== c && x.doc !== c.doc && x.docKind !== c.docKind);
    };
    m.link = c => "waffle-diff:" + encodeURIComponent(m.from) + ".." + encodeURIComponent(m.to) + "#" + encodeURIComponent(c.docName || "project") + "/" + encodeURIComponent(c.key);
    m.find = link => {
      const k = /#[^/]*\/(.+)$/.exec(String(link || ""));
      return k ? m.changes.find(c => c.key === decodeURIComponent(k[1])) || null : null;
    };
    m.speak = (c, i = null, n = null) => {
      const pos = i != null && n != null ? "Change " + (i + 1) + " of " + n + ". " : "";
      return pos + SEVERITY_LABEL[c.severity] + ", " + STATUS_LABEL[c.status].toLowerCase() + ". " + (c.sentence || c.name) + (c.docName ? ". On " + c.docName : "") + (c.layer ? ", layer " + c.layer : "") + ".";
    };
    // DRC delta: violations new in "after" and fixed since "before", per board both sides have.
    m.drcDelta = async ({active = () => true, limit = 9000} = {}) => {
      const R = globalThis.AtriumRules;
      if (typeof R?.drc !== "function") return null;
      const out = {added: [], fixed: [], boards: 0, skipped: []};
      for (const d of m.docs) {
        if (d.kind !== "pcb" || d.side !== "both") continue;
        const s = m.sides(d.id);
        if (s.before.items.length + s.after.items.length > limit) { out.skipped.push(d.name); continue; }
        const run = (doc, defs, P) => { try { return R.drc(doc, defs, R.stored?.(doc, P) || R.defaults?.(), {}); } catch { return null; } };
        const r0 = run(s.before, defs0, P0); await idle(); if (!active()) return null;
        const r1 = run(s.after, defs1, P1); await idle(); if (!active()) return null;
        if (!r0 || !r1) continue;
        out.boards++;
        const key = v => [v.type, v.ruleId || "", v.title || "", ...(Array.isArray(v.at) ? v.at.map(x => Math.round(x * 100)) : [])].join("|");
        const k0 = new Set((r0.violations || []).map(key)), k1 = new Set((r1.violations || []).map(key));
        for (const v of r1.violations || []) if (!k0.has(key(v))) out.added.push({doc: d.id, docName: d.name, title: String(v.title || v.type), type: v.type, at: v.at || null});
        for (const v of r0.violations || []) if (!k1.has(key(v))) out.fixed.push({doc: d.id, docName: d.name, title: String(v.title || v.type), type: v.type, at: v.at || null});
      }
      m.drc = out; m.version++;
      return out;
    };
    return m;
  }
  const idle = () => new Promise(r => (globalThis.requestIdleCallback || setTimeout)(() => r(), {timeout: 200}));
  function countOf(list) {
    const s = {total: list.length, electrical: 0, layout: 0, cosmetic: 0, added: 0, removed: 0, moved: 0, modified: 0, properties: 0};
    for (const c of list) { s[c.severity] = (s[c.severity] || 0) + 1; s[c.status] = (s[c.status] || 0) + 1; }
    return s;
  }
  return Object.freeze({create, fromEngine, show, same, shapeOf, pinShape, countOf, SEVERITIES, SEVERITY_LABEL, STATUSES, STATUS_LABEL, KIND_LABEL, kindLabel});
})();
