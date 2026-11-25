"use strict";
// KiCad 6–9 importer: .kicad_pcb boards, .kicad_sch sheets and .kicad_pro project
// settings, read from the publicly documented S-expression file format.
// Coordinates are millimetres with Y down in both programs, so points carry over
// unchanged. KiCad angles turn counter-clockwise on screen; Waffle's turn the other
// way, so every angle is negated (the inverse of kicad-export.js).
globalThis.AtriumKiCadImport = (() => {
  const A = Atrium, {all, one, val, num, xy, flag} = AtriumSexpr;
  const F = () => AtriumImportFormats, G = () => AtriumImportFormats.geom;
  const isL = Array.isArray;
  const P = p => G().P(p);
  function requiredPoint(tuple) {
    const axes = [tuple?.[1], tuple?.[2]].map(v => typeof v === "string" && v.trim() ? Number(v) : NaN);
    if (!axes.every(Number.isFinite)) throw Error("A KiCad point needs two numeric coordinates.");
    return axes;
  }
  const n360 = a => ((a % 360) + 360) % 360;
  const norm = a => { const v = n360(a); return v > 180 ? v - 360 : v; };
  const r4 = v => Math.round(v * 1e4) / 1e4 + 0;
  const strokeWidth = n => num(val(n, "width") ?? val(one(n, "stroke"), "width"), 0);
  const fillOn = n => { const f = one(n, "fill"); if (!f) return false; const t = isL(f[1]) ? f[1][1] : f[1]; return ["solid", "yes", "background", "outline", "color"].includes(t) && t !== "none"; };
  const textSize = n => num(one(one(one(n, "effects"), "font"), "size")?.[1], 1.27);
  const hidden = n => flag(n, "hide") || flag(one(n, "effects"), "hide");
  // KiCad 7+ escapes characters in names and label text ({slash}, {colon}, …; string_utils.cpp
  // EscapeString). Text and net names are compared unescaped: "VPP{slash}MCLR" and "VPP/MCLR"
  // are one net in KiCad, so they must be one net here too.
  const ESCAPES = {dblquote: '"', quote: "'", lt: "<", gt: ">", backslash: "\\", slash: "/", bar: "|", comma: ",", colon: ":", space: " ", dollar: "$", tab: "\t", return: "\n", brace: "{"};
  const unescape = s => String(s ?? "").replace(/\{(dblquote|quote|lt|gt|backslash|slash|bar|comma|colon|space|dollar|tab|return|brace)\}/g, (m, k) => ESCAPES[k]);
  const plain = s => unescape(String(s ?? "").replace(/~\{([^}]*)\}/g, "$1"));
  const nameOf = id => String(id || "").split(":").pop();
  const linkOf = uuid => "kicad-" + uuid;
  // KiCad 6+ UUIDs and earlier board timestamps identify source objects across revisions.
  // Generated Waffle IDs still belong to the editable copy and avoid collisions on import.
  function sourceIdentity(node, path) {
    const id = String(val(node, "uuid") || val(node, "tstamp") || "");
    if (/^[0-9a-f-]{1,64}$/i.test(id) && /[1-9a-f]/i.test(id)) return {kicadSourceId: id.toLowerCase()};
    if (typeof path === "string" && /^\/[0-9a-f/-]{1,240}$/i.test(path) && /[1-9a-f]/i.test(path)) return {kicadSourceId: "path:" + path.toLowerCase()};
    return {};
  }
  // The newest file format this reader was written against (KiCad 9 and the 2025 releases).
  const NEWEST = 20251231;
  const newer = v => "This file was written by a newer KiCad (format " + v + ") than this importer knows; objects it does not recognise were skipped. Check the result.";

  // Source addresses are local to this read. Keep the original ID when present and the
  // S-expression sibling position even when two placements carry the same ID or name.
  function observations(sink, file) {
    if (!sink) return null;
    const refs = new WeakMap();
    function children(node, parent = "") {
      for (let i = 1; i < node.length; i++) {
        const child = node[i];
        if (!isL(child)) continue;
        const head = typeof child[0] === "string" ? child[0].slice(0, 48) : "record", id = val(child, "uuid") || val(child, "tstamp");
        const uuid = typeof id === "string" ? id : "";
        const label = uuid || (["footprint", "module", "pad", "symbol", "property"].includes(head) && typeof child[1] === "string" ? child[1] : "");
        refs.set(child, (parent ? parent + "/" : "") + head + (label ? " " + String(label).slice(0, 72) : "") + " #" + i);
      }
    }
    function address(node) { return typeof node === "string" ? node : refs.get(node) || (typeof node[0] === "string" ? node[0].slice(0, 48) : "record"); }
    function record(kind, status, node, target, reason) {
      const source = {file, object: address(node)};
      if (target && sink.track) sink.track(kind, status, source, target, reason);
      else sink.add(kind, status, source, reason);
    }
    function produced(domain, node, items, first) {
      if (!sink.produced) return;
      const source = {file, object: address(node)};
      for (let i = first; i < items.length; i++) sink.produced(domain, source, items[i]);
    }
    return {children, address, record, produced, sink, note: message => sink.note?.(message)};
  }
  // Nested records may have been decoded before their whole definition is rejected, or
  // before library pairing chooses its actual footprint. Commit their outcomes together.
  function pendingObservations(audit) {
    if (!audit) return null;
    const rows = [];
    return {...audit, record: (kind, status, node, target, reason) => rows.push({kind, status, node: audit.address(node), target, reason}),
      finish(status, reason) {
        for (const row of rows) {
          const override = row.status !== "dropped" && status && status !== "kept";
          audit.record(row.kind, override ? status : row.status, row.node, override ? null : row.target, override ? reason : row.reason);
        }
        rows.length = 0;
      }};
  }
  const BOARD_META = new Set(["version", "generator", "generator_version", "host", "general", "layers", "setup", "net", "net_class", "footprint", "module"]);
  const SHEET_META = new Set(["version", "generator", "generator_version", "uuid", "lib_symbols", "symbol_instances", "sheet_instances", "embedded_fonts"]);
  const FP_META = new Set(["version", "generator", "generator_version", "layer", "at", "uuid", "tstamp", "tedit", "path", "sheetname", "sheetfile",
    "property", "fp_text", "tags", "descr", "attr", "placed"]);
  const SCHEMATIC_KINDS = new Map(Object.entries({symbol: "part", wire: "wire", bus: "bus", junction: "junction", no_connect: "noerc", bus_entry: "busentry",
    label: "netlabel", global_label: "offsheet", hierarchical_label: "port", text: "label", text_box: "textframe", polyline: "graphic", rectangle: "graphic",
    circle: "graphic", arc: "graphic", bezier: "graphic", sheet: "sheetsymbol", image: "image", netclass_flag: "directive", directive_label: "directive",
    rule_area: "rule-area", table: "table", bus_alias: "bus-alias", paper: "page-setting", title_block: "title-block"}));
  const BOARD_KINDS = new Map(Object.entries({segment: "track", arc: "track", via: "via", gr_text: "label", zone: "polygon", dimension: "dimension",
    gr_text_box: "textframe", image: "image", target: "target", table: "table", group: "group", generated: "generated", paper: "page-setting", title_block: "title-block"}));
  const malformed = "The source record has missing or invalid geometry.";
  const unsupported = "The KiCad reader does not translate this record.";
  const tessellated = "The curve is represented by straight segments.";
  const curved = n => /(?:^|_)(?:bezier|curve|arc)$/.test(n[0]) || !!one(one(n, "pts"), "arc");
  const PAD_FIELDS = new Set(["at", "size", "drill", "layers", "net", "uuid", "tstamp", "roundrect_rratio", "chamfer_ratio", "chamfer", "rect_delta", "options", "primitives",
    "solder_mask_margin", "solder_paste_margin", "solder_paste_margin_ratio", "solder_paste_ratio"]);
  function padReason(k, pad, issues) {
    const ovalCopper = k[3] === "oval" && pad.w !== pad.h ? "The KiCad copper capsule is drawn as an ellipse in the editor" : null;
    if (issues?.length) return (ovalCopper ? [...issues, ovalCopper] : issues).join(". ");
    if (!Object.hasOwn(PAD_SHAPES, k[3])) return "The unknown pad shape uses a rectangle.";
    if (ovalCopper) return ovalCopper + ".";
    if ((k[3] === "roundrect" || k[3] === "chamfered_rect") && num(val(k, "roundrect_rratio"), 0) > 0 && pad.shape === "custom")
      return "The rounded corners use sampled geometry.";
    if (!["smd", "thru_hole", "np_thru_hole"].includes(k[2])) return "The pad type maps to a native surface pad.";
    if (k.some(n => isL(n) && !PAD_FIELDS.has(n[0]))) return "Additional padstack, fabrication or pin fields have no native pad property.";
    if (k[3] === "custom" && pad.shape !== "custom") return "The source copper primitives were reduced to the pad anchor.";
    if ((k[2] === "thru_hole" || k[2] === "np_thru_hole") && !one(k, "drill")) return "A through-hole pad without a size uses a generated drill.";
  }
  const ioApprox = type => type === "tri_state" || type === "passive" || type && !Object.hasOwn(LABEL_IO, type);

  // A KiCad arc track (start, mid, end) as a native circular path: the arc itself (model.js, the
  // Board Shape convention: degrees counter-clockwise on screen) and the polyline projection that
  // polygon-only tools read. Collinear points are a straight track.
  function trackArc(a, m, b) {
    const k = G().circle3(a, m, b);
    if (!k || !(k.r > 0 && k.r < 1e8) || k.c.some(v => !(Math.abs(v) < 1e8)))
      return {points: [P(a), P(b)]};
    const angle = p => -Math.atan2(p[1] - k.c[1], p[0] - k.c[0]) * 180 / Math.PI;
    const start = angle(a), end = angle(b), ccw = n360(angle(m) - start) < n360(end - start);
    const arc = {kind: /** @type {"arc"} */ ("arc"), c: P(k.c), r: k.r, start, end, ccw};
    const points = A.arcProjection(arc);
    F().spend(points.length);
    points[0] = P(a);
    points[points.length - 1] = P(b);
    return {points, arc};
  }
  // ------------------------------------------------------------ shared geometry
  function bezier(c) {
    if (c.length !== 4) return c;
    return Array.from({length: 17}, (_, i) => {
      const t = i / 16, u = 1 - t;
      return [0, 1].map(k => u * u * u * c[0][k] + 3 * u * u * t * c[1][k] + 3 * u * t * t * c[2][k] + t * t * t * c[3][k]);
    });
  }
  // (pts (xy x y) ... (arc (start) (mid) (end))) -> points.
  function pts(n) {
    const out = [];
    for (const k of one(n, "pts") || []) {
      if (!isL(k)) continue;
      if (k[0] === "xy") out.push([num(k[1]), num(k[2])]);
      else if (k[0] === "arc") {
        const a = G().arc3(xy(k, "start"), xy(k, "mid"), xy(k, "end"));
        if (out.length && A.same(out.at(-1), a[0])) a.shift();
        out.push(...a);
      }
    }
    F().spend(out.length);
    return out;
  }
  // A graphic primitive -> {points, closed, fill} or {circle:{c,r}} or null.
  function primitive(n) {
    const kind = String(n[0]).replace(/^(fp_|gr_)/, "");
    if (kind === "line") return {points: [requiredPoint(one(n, "start")), requiredPoint(one(n, "end"))], closed: false};
    if (kind === "rect") {
      const a = requiredPoint(one(n, "start")), b = requiredPoint(one(n, "end"));
      return {points: [a, [b[0], a[1]], b, [a[0], b[1]]], closed: true, fill: fillOn(n)};
    }
    if (kind === "circle") {
      const c = requiredPoint(one(n, "center")), e = requiredPoint(one(n, "end"));
      return {circle: {c, r: Math.hypot(e[0] - c[0], e[1] - c[1])}, fill: fillOn(n)};
    }
    if (kind === "arc") {
      const s = requiredPoint(one(n, "start")), mid = one(n, "mid"), e = requiredPoint(one(n, "end"));
      if (mid) {
        const m = requiredPoint(mid);
        return {points: G().arc3(s, m, e), closed: false, arc: {a: s, m, b: e}};
      }
      const angle = num(val(n, "angle"));
      if (!angle) return null;
      const r = Math.hypot(e[0] - s[0], e[1] - s[1]), a0 = Math.atan2(e[1] - s[1], e[0] - s[0]) * 180 / Math.PI;
      const points = G().arcPoints(s, r, a0, angle);
      return {points, closed: false, arc: {a: points[0], m: points[Math.floor(points.length / 2)], b: points.at(-1)}};
    }
    if (kind === "poly") { const p = pts(n); return p.length >= 2 ? {points: p, closed: p.length > 2, fill: fillOn(n)} : null; }
    if (kind === "curve" || kind === "bezier") { const p = pts(n); return p.length ? {points: bezier(p), closed: false} : null; }
    return null;
  }

  // ------------------------------------------------------------ boards
  const TECH = {"F.SilkS": "Silk", "B.SilkS": "Bottom silk", "F.Silkscreen": "Silk", "B.Silkscreen": "Bottom silk",
    "F.Mask": "Top mask", "B.Mask": "Bottom mask", "F.Paste": "Top paste", "B.Paste": "Bottom paste",
    "Dwgs.User": "Mechanical", "User.Drawings": "Mechanical", "Cmts.User": "Drill drawing", "User.Comments": "Drill drawing",
    "Eco1.User": "Mechanical 11", "Eco2.User": "Mechanical 12", "User.Eco1": "Mechanical 11", "User.Eco2": "Mechanical 12",
    "F.Fab": "Mechanical 13", "B.Fab": "Mechanical 14", "F.CrtYd": "Mechanical 15", "B.CrtYd": "Mechanical 16",
    "F.Courtyard": "Mechanical 15", "B.Courtyard": "Mechanical 16", "F.Adhes": "Mechanical 17", "B.Adhes": "Mechanical 18",
    "F.Adhesive": "Mechanical 17", "B.Adhesive": "Mechanical 18", "Margin": "Mechanical 19", "User.Margin": "Mechanical 19"};
  // Footprint field anchors are local to the placement. The saved board text
  // angle is absolute even for a rotated footprint.
  function boardField(node, field, layers, partAngle) {
    const at=xy(node,"at"), layer=layers.layer(val(node,"layer"));
    if (!at || !layer) return null;
    const effects=one(node,"effects"), font=one(effects,"font"), size=one(font,"size"), justify=one(effects,"justify");
    const dimension=(token,fallback)=>{
      const value=num(token);
      return value>0 && value<10000 ? value : fallback;
    };
    const height=dimension(size?.[1],1.27), fontWidth=dimension(size?.[2],height);
    const width=dimension(val(font,"thickness"),0), sourceAngle=num(one(node,"at")?.[3]);
    const horizontal=justify?.includes("left")?"left":justify?.includes("right")?"right":"center";
    const vertical=justify?.includes("top")?"top":justify?.includes("bottom")?"bottom":"middle";
    const family=val(font,"face"), spacing=num(val(font,"line_spacing"));
    return {
      field, at:P(at), angle:norm(-sourceAngle-partAngle), layer, size:height,
      justify:vertical==="middle"&&horizontal==="center"?"center":vertical+"-"+horizontal,
      mirrored:!!justify?.includes("mirror"), upright:!flag(node,"unlocked") && !one(node,"at")?.includes("unlocked"),
      ...(fontWidth!==height?{fontWidth}:{}), ...(width?{width}:{}),
      ...(typeof family==="string" && family && family!=="KiCad Font"?{font:"truetype",family}:{strokeFont:"kicad"}),
      ...(flag(font,"italic")?{italic:true}:{}), ...(flag(font,"bold")?{bold:true}:{}),
      ...(spacing>0&&spacing<100?{lineSpacing:spacing*5/3}:{})
    };
  }
  function layerTable(t) {
    const copper = [];
    for (const l of one(t, "layers") || []) if (isL(l) && /\.Cu$/.test(l[1])) copper.push(l);
    const names = copper.map(l => l[1]);
    const inner = names.filter(n => /^In\d+\.Cu$/.test(n)).sort((a, b) => parseInt(a.slice(2)) - parseInt(b.slice(2)));
    const map = new Map([["F.Cu", "Top"], ["B.Cu", "Bottom"]]);
    inner.forEach((n, i) => map.set(n, "Inner " + (i + 1)));
    const planes = new Set(copper.filter(l => l[2] === "power").map(l => map.get(l[1])));
    const layer = name => {
      if (map.has(name)) return map.get(name);
      const m = /^In(\d+)\.Cu$/.exec(name || "");
      if (m) return "Inner " + m[1];
      const u = /^User\.(\d+)$/.exec(name || "");
      if (u) return "Mechanical " + u[1];
      return Object.hasOwn(TECH, name) ? TECH[name] : null;
    };
    return {layer, copperNames: ["F.Cu", ...inner, "B.Cu"], planes};
  }
  const isCopper = l => l === "Top" || l === "Bottom" || /^Inner \d+$/.test(l || "");
  function stackupOf(t, L) {
    const st = one(one(t, "setup"), "stackup");
    if (!st) return null;
    const layers = [];
    for (const l of all(st, "layer")) {
      const name = l[1], type = String(val(l, "type") || "").toLowerCase(), thick = num(val(l, "thickness"), 0);
      const material = String(val(l, "material") || ""), dk = num(val(l, "epsilon_r"), NaN), df = num(val(l, "loss_tangent"), NaN);
      const extra = {...(dk >= 1 && dk <= 20 ? {dk} : {}), ...(df >= 0 && df <= 1 ? {df} : {})};
      if (/silk/.test(type)) layers.push({type: "Overlay", name: /^B/.test(name) ? "Bottom Overlay" : "Top Overlay", material: "", thickness: 0});
      else if (/solder mask/.test(type)) layers.push({type: "Solder Mask", name: /^B/.test(name) ? "Bottom Solder" : "Top Solder", material: material || "Solder Resist", thickness: thick > 0 && thick < 10 ? thick : .01, ...extra});
      else if (type === "copper") {
        const key = L.layer(name);
        if (!isCopper(key)) continue;
        layers.push({type: L.planes.has(key) ? "Plane" : "Signal", name: name, material: "Copper", thickness: thick > 0 && thick < 10 ? thick : .035, key});
      } else if (type === "core" || type === "prepreg") {
        layers.push({type: "Dielectric", name: name, material: material || "FR4", thickness: thick > 0 && thick < 10 ? thick : .1, dielectric: type === "prepreg" ? "Prepreg" : "Core", ...extra});
      }
    }
    const copper = layers.filter(l => l.key);
    if (copper.length < 2) return null;
    return {version: 1, source: "KiCad", layers, drillPairs: []};
  }
  function netTable(t) {
    const byId = new Map();
    // Names are unescaped like label text. KiCad gives each unconnected pad its own
    // "unconnected-(U1-Pad3)" net; those pads have no net in Waffle, as in the schematic.
    const name = v => { const t = unescape(v); return /^unconnected-\(/.test(t) ? "" : t; };
    for (const n of all(t, "net")) byId.set(String(n[1]), name(n[2] ?? ""));
    return n => {
      if (!n) return "";
      if (n.length >= 3) return name(n[2] ?? "");
      const v = n[1];
      if (v == null) return "";
      return byId.has(String(v)) ? byId.get(String(v)) : /^\d+$/.test(v) ? "" : name(v);
    };
  }
  const PAD_SHAPES = {circle: "round", rect: "rect", oval: "oval", roundrect: "roundrect", trapezoid: "rect", chamfered_rect: "rect", custom: "rect"};
  const PAD_FILMS = new Map([["F.Paste", "Top paste"], ["B.Paste", "Bottom paste"], ["F.Mask", "Top mask"], ["B.Mask", "Bottom mask"]]);
  // KiCad ovals are capsules; Waffle's "oval" pad is drawn as an ellipse of the same extents.

  const BOARD_MARGINS = {mask: "pad_to_mask_clearance", paste: "pad_to_paste_clearance", ratio: "pad_to_paste_clearance_ratio"};
  const boardExpansions = new WeakMap();
  function setupMargins(t) {
    const setup = one(t, "setup"), margins = {}, fields = new Set();
    for (const [key, name] of Object.entries(BOARD_MARGINS)) {
      const source = one(setup, name), value = num(source?.[1], NaN);
      if (Math.abs(value) <= 100) { margins[key] = value; fields.add(source); }
    }
    return {margins, fields};
  }
  function restoreRuleOrigins(set, previous = []) {
    const origins = new Map(previous.filter(rule => rule.origin).map(rule => [rule.id, rule.origin]));
    for (const rule of set.list) if (origins.has(rule.id)) rule.origin = origins.get(rule.id);
    return set;
  }
  function applyBoardExpansions(doc, margins) {
    const R = globalThis.AtriumRules;
    if (!R || (margins?.mask === undefined && margins?.paste === undefined)) return false;
    const rules = restoreRuleOrigins(R.migrate(doc.rules), doc.rules?.list);
    for (const rule of rules.list) {
      if (!R.kit.allScope(rule.scope)) continue;
      if (!rule.id.startsWith("KiCadViaClass-")) rule.origin ??= {kind: "default", key: rule.id};
      if (rule.type === "solderMask" && margins.mask !== undefined) rule.expansion = margins.mask;
      if (rule.type === "pasteMask" && margins.paste !== undefined) rule.expansion = margins.paste;
    }
    doc.rules = rules;
    return true;
  }
  const dimension = n => typeof n === "number" && n > 0 && n <= 1000 ? F().geom.r6(n) : null;
  const viaFields = c => ({diameterPreferred:dimension(c?.viaDiameter),holePreferred:dimension(c?.viaDrill)});
  const makeRule = (id,name,type,priority,scope,values) => ({id,name,type,priority,scope,enabled:true,...values});
  function classRuleList(set){
    // Keep Waffle's mechanical pad defaults off vias imported without constraints.
    const pad=globalThis.AtriumDesignQueryRecord.create("pad"), R=globalThis.AtriumRules;
    return set.list.filter(r=>r.type!=="viaStyle"||r.id.startsWith("KiCadViaClass-")).map(r=>
      (r.type==="holeSize"||r.type==="annularRing")&&R.kit.allScope(r.scope) ?
        {...r, scope:pad, origin:{kind:"default",key:r.id}} : r);
  }
  function setClassRules(doc, defaults, overrides, classes, members, audit) {
    const R=globalThis.AtriumRules, set=R.migrate(F().rulesFrom(defaults,overrides));
    set.list=classRuleList(set);
    // A KiCad class describes new routing. Keep the named scope so re-export
    // can recover its sizes without guessing from a member's net rules.
    set.netClasses=members;
    const add=(c,scope)=>{
      const fields=viaFields(c);
      if (fields.diameterPreferred==null && fields.holePreferred==null) return;
      const i=set.list.length+1;
      set.list.push(makeRule("KiCadViaClass-"+i,"KiCad via class "+i,"viaStyle",i,scope,fields));
    };
    for (const name of Object.keys(members)) add(classes[name],{kind:"netclass",value:name});
    add(defaults,{kind:"all"});
    const normalized=restoreRuleOrigins(R.normalize(set),set.list);
    for(const rule of normalized.list)if(R.kit.allScope(rule.scope)&&!rule.id.startsWith("KiCadViaClass-"))
      rule.origin={kind:"default",key:rule.id};
    F().setClassRules(doc,defaults,overrides,audit,normalized);
    applyBoardExpansions(doc,boardExpansions.get(doc));
  }
  const className = s => typeof s === "string" && s.length <= 128 && !!s && s === s.trim() && s !== "__proto__";
  // text: the file, or an already parsed tree (library-import-kicad.js wraps a .kicad_mod footprint).
  function readBoard(name, text, sink, libraryFootprint = false, audit = observations(sink, name)) {
    const t = typeof text === "string" ? AtriumSexpr.parse(text) : text;
    if (t[0] !== "kicad_pcb") throw Error("This is not a KiCad board (kicad_pcb).");
    audit?.children(t);
    const version = num(val(t, "version"), 0), notes = F().notebook(), defs = F().definitions();
    if (version && version < 20211014) notes.add("This board predates KiCad 6 (format " + version + "). It was read with the KiCad 6 rules; check the result.");
    if (version > NEWEST) notes.add(newer(version));
    const doc = A.sheet("pcb", F().stem(name));
    doc.sourceName = name;
    const L = layerTable(t), netOf = netTable(t), edges = [];
    const edgeSources = audit && [], storedFills = audit && new WeakMap();
    const thickness = num(val(one(t, "general"), "thickness"), NaN);
    if (thickness > 0 && thickness < 20) doc.thickness = thickness;
    const stack = stackupOf(t, L);
    if (stack) doc.stackup = stack;
    const nets = new Set(), {margins, fields: marginFields} = setupMargins(t);
    function edge(prim, map = p => p) {
      if (!prim) return;
      if (prim.circle) edges.push({kind: "circle", c: map(prim.circle.c), r: prim.circle.r});
      else if (prim.arc) edges.push({kind: "arc", a: map(prim.arc.a), m: map(prim.arc.m), b: map(prim.arc.b)});
      else if (prim.closed) { const p = prim.points.map(map); edges.push({kind: "path", points: [...p, p[0]]}); }
      else edges.push({kind: "path", points: prim.points.map(map)});
    }

    // Footprints (KiCad 6+ "footprint"; "module" in older files written by KiCad 6 converters).
    for (const fp of [...all(t, "footprint"), ...all(t, "module")]) {
      audit?.children(fp, audit.address(fp));
      const children = audit && [];
      const at = one(fp, "at"), position = at ? F().guard(notes, () => requiredPoint(at)) : [0, 0];
      if (!position) {
        if (!libraryFootprint) audit?.record("part", "dropped", fp, null, malformed);
        continue;
      }
      const [x, y] = position, ka = num(at?.[3]);
      const side = val(fp, "layer") === "B.Cu" ? "Bottom" : "Top", angle = -ka || 0;
      const item = {id: A.id(), kind: "part", def: "", ref: "", value: "", x, y, angle, layer: side, link: "", pinNets: {}};
      const fpName = nameOf(fp[1]) || "Footprint", shapes = [], pads = [], fpMargins = localMargins(fp, version);
      const toLocal = p => A.rotate([p[0] - x, p[1] - y], -angle);
      const pathV = val(fp, "path");
      const identity = sourceIdentity(fp, pathV);
      Object.assign(item, identity);
      item.link = pathV ? linkOf(String(pathV).split("/").filter(Boolean).pop()) : identity.kicadSourceId ? "kicad-footprint-" + identity.kicadSourceId : A.id();
      if (pathV) item.kicadPath = String(pathV);
      const fields = F().dict();
      for (const p of all(fp, "property")) fields[p[1]] = p;
      for (const p of all(fp, "fp_text")) if (p[1] === "reference" || p[1] === "value") fields[p[1] === "reference" ? "Reference" : "Value"] = ["property", p[1], p[2], ...p.slice(3)];
      const refN = fields.Reference, valN = fields.Value;
      item.ref = String(refN?.[2] ?? "");
      item.value = String(valN?.[2] ?? "");
      const sourceFields = [["ref",refN],["value",valN]], fieldLabels = new Map();
      for (const [field,node] of sourceFields) {
        if (!node) continue;
        const isHidden=hidden(node);
        if (isHidden) item[field==="ref"?"showRef":"showValue"]=false;
        const at=xy(node,"at");
        if (at) item[field==="ref"?"refAt":"valueAt"]=P(at);
        const label=boardField(node,field,L,angle);
        if (!label) continue;
        fieldLabels.set(field,label);
        item.boardLabels ||= [];
        if (isHidden) (item.hiddenBoardLabels ||= []).push(label);
        else item.boardLabels.push(label);
      }
      const params = {};
      for (const [k, p] of Object.entries(fields)) if (!["Reference", "Value", "Footprint", "Datasheet", "Description"].includes(k) && typeof p[2] === "string" && p[2]) F().put(params, k, p[2]);
      if (Object.keys(params).length) item.parameters = params;
      function readFootprintItem(k, padNotes) {
        const head = k[0];
        if (head === "pad") {
          const pad = readPad(k, ka, padNotes, netOf, fpMargins, margins, version);
          if (!pad) return;
          pads.push(pad);
          if (pad.number && pad.net) F().put(item.pinNets, pad.number, pad.net);
          if (pad.net) nets.add(pad.net);
        } else if (/^fp_(line|rect|circle|arc|poly|curve)$/.test(head)) {
          const ln = val(k, "layer"), prim = primitive(k);
          if (!prim) return;
          if (ln === "Edge.Cuts") { edge(prim, p => A.world(p, item)); return; }
          const l = L.layer(ln);
          if (!l) { notes.add("Footprint graphics on unsupported layer " + ln + " omitted"); return; }
          const width = strokeWidth(k), style = /^Mechanical 1[34]$/.test(l) ? "package" : l === "Silk" || l === "Bottom silk" ? "silk" : "body";
          const layer = style === "package" ? {} : {layer: l};
          if (prim.circle) shapes.push({kind: "circle", x: r4(prim.circle.c[0]), y: r4(prim.circle.c[1]), r: r4(prim.circle.r), width, style, ...layer, ...(prim.fill ? {fill: true} : {})});
          else shapes.push({kind: "path", points: prim.points.map(P), style, width, ...layer, closed: !!prim.closed, fill: !!prim.fill,
            ...(prim.fill && prim.closed && width > 0 ? {strokeOutline:true} : {})});
        } else if (head === "fp_text" && k[1] === "user" || head === "property" && !["Reference", "Value"].includes(k[1]) && !hidden(k) && one(k, "at") && k[2]) {
          const ln = val(k, "layer"), l = L.layer(ln), p = xy(k, "at");
          if (!l || !p || hidden(k)) return;
          const original = String(k[2] || "");
          const txt = original === "${REFERENCE}" ? ".Designator" : original === "${VALUE}" ? ".Comment" : original.replace(/\$\{REFERENCE\}/g, item.ref);
          if (!txt || /^\$\{.*\}$/.test(txt)) return;
          shapes.push({kind: "text", x: r4(p[0]), y: r4(p[1]), text: txt, size: textSize(k),
            angle: r4(norm(-num(one(k, "at")?.[3]) - angle)), layer: l, style: "silk"});
        } else if (head === "fp_text_box" || head === "dimension") notes.add("Footprint text boxes and dimensions omitted");
        else if (head === "model") notes.add("3D model references were not imported");
        else if (head === "zone") { readZone(k, doc, L, netOf, notes, storedFills); notes.add("Footprint-owned zones became board-level pours or keepouts; they do not move with their footprint"); }
      }
      for (const k of fp) {
        if (!isL(k)) continue;
        const padIndex = audit && pads.length, shapeIndex = audit && shapes.length, first = audit && doc.items.length, beforeEdge = audit && edges.length;
        let padIssues;
        F().guard(notes, () => readFootprintItem(k, audit && k[0] === "pad" ? {add: message => {
          (padIssues ||= []).push(message);
          notes.add(message);
        }} : notes));
        if (audit) {
          if (edges.length > beforeEdge) edgeSources.push(k);
          else if (k[0] === "pad") children.push({k, padIndex: pads.length > padIndex ? padIndex : -1, padIssues});
          else if (shapes.length > shapeIndex) children.push({k, shapeIndex});
          else if (k[0] === "zone") {
            observeZone(audit, k, doc, first, storedFills, true, libraryFootprint);
          } else if (k[0] === "model") {
            if (!libraryFootprint) audit.record("model3d", "dropped", k, null, "Board placements omit KiCad 3D model references.");
          } else if (/^fp_(line|rect|circle|arc|poly|curve|text_box)$/.test(k[0]) || k[0] === "dimension" || k[0] === "fp_text" && k[1] === "user") {
            audit.record(k[0] === "dimension" ? "dimension" : k[0].includes("text") ? "label" : "graphic", "dropped", k, null, "The footprint drawing has no supported geometry, text or layer.");
          } else if (k[0] === "fp_text" || k[0] === "property") {
            const field = k[0] === "property" ? k[1] : k[1] === "reference" ? "Reference" : k[1] === "value" ? "Value" : "";
            if (field === "Reference" || field === "Value") {
              const label=fieldLabels.get(field==="Reference"?"ref":"value");
              const reason=!label?"The field text is retained, but its placement or layer could not be read.":
                one(k,"render_cache")?"Field placement and font settings are retained. The source glyph cache is not imported.":
                label.font==="truetype"?"Field placement and font settings are retained. Glyph outlines depend on the available font.":
                !/^[\t\r\n -}]*$/.test(String(k[2])) || /[_^]\{/.test(String(k[2]))?
                  "Field placement is retained. Characters or formatted text outside the bundled KiCad stroke glyphs use Waffle’s stroke font.":null;
              audit.record("component-field", reason?"approximated":"kept", k, null, reason);
            } else if (field && Object.hasOwn(params, field)) audit.record("component-field", "kept", k, null);
            else audit.record("component-field", "dropped", k, null, "This field has no retained footprint parameter or artwork.");
          } else if (Object.hasOwn(fpMargins, MARGIN_KEY[k[0]] || "")) audit.record("footprint-setting", "kept", k, null);
          else if (!FP_META.has(k[0])) audit.record("footprint-setting", "dropped", k, null, unsupported);
        }
      }
      const def = {id: A.id(), name: fpName, category: "KiCad footprints", prefix: item.ref.match(/^[A-Za-z#]+/)?.[0] || "U",
        value: fpName, footprint: {name: fpName, pads, shapes}, sourceName: name};
      // Pad nets live on the placement; identical footprints share one definition.
      const geometry = {...def.footprint, pads: pads.map(p => { const c = {...p}; if (c.number) delete c.net; return c; })};
      const shared = defs.add({...def, footprint: geometry}, JSON.stringify([fpName, geometry]));
      item.def = shared.id;
      doc.items.push(item);
      if (audit) {
        if (!libraryFootprint) {
          audit.record("part", "kept", fp, item);
          audit.produced("pcb", fp, [item], 0);
        }
        for (const child of children) {
          const {k} = child;
          if (k[0] === "pad") {
            const pad = shared.footprint.pads[child.padIndex];
            const reason = pad ? padReason(k, pad, child.padIssues) : child.padIssues?.join(". ") || malformed;
            audit.record("pad", !pad ? "dropped" : reason ? "approximated" : "kept", k, pad, reason);
            if (pad) {
              const extra = k.filter(n => isL(n) && !PAD_FIELDS.has(n[0]));
              if (extra.length) {
                audit.children(k, audit.address(k));
                for (const field of extra) audit.record("pad-field", "dropped", field, null, "This source field has no native pad property.");
              }
            }
          } else {
            const target = shared.footprint.shapes[child.shapeIndex], reason = curved(k) ? tessellated : undefined;
            audit.record(target.kind === "text" ? "label" : "graphic", reason ? "approximated" : "kept", k, target, reason);
          }
        }
      }
    }

    // Board-level objects.
    function readBoardItem(k) {
      const head = k[0];
      if (head === "segment") {
        const l = L.layer(val(k, "layer")), net = netOf(one(k, "net"));
        if (!isCopper(l)) { notes.add("Tracks on non-copper layers omitted"); return; }
        const a = requiredPoint(one(k, "start")), b = requiredPoint(one(k, "end"));
        doc.items.push({id: A.id(), ...sourceIdentity(k), kind: "track", points: [a, b], layer: l, width: num(val(k, "width"), .25), net});
        if (net) nets.add(net);
      } else if (head === "arc") {
        const l = L.layer(val(k, "layer")), net = netOf(one(k, "net"));
        if (!isCopper(l)) return;
        const a = requiredPoint(one(k, "start")), m = requiredPoint(one(k, "mid")), b = requiredPoint(one(k, "end"));
        doc.items.push({id: A.id(), ...sourceIdentity(k), kind: "track", ...trackArc(a, m, b), layer: l, width: num(val(k, "width"), .25), net});
      } else if (head === "via") {
        const at = requiredPoint(one(k, "at")), ls = one(k, "layers"), net = netOf(one(k, "net"));
        const v = {id: A.id(), kind: "via", x: at[0], y: at[1], diameter: num(val(k, "size"), .6), drill: num(val(k, "drill"), .3), layer: "Multi", net};
        Object.assign(v, sourceIdentity(k));
        const a = L.layer(ls?.[1]), b = L.layer(ls?.[2]);
        if ((k.includes("blind") || k.includes("micro")) && isCopper(a) && isCopper(b) && !(a === "Top" && b === "Bottom")) { v.fromLayer = a; v.toLayer = b; }
        if (k.includes("micro")) notes.add("Micro vias import as blind vias");
        doc.items.push(v);
      } else if (/^gr_(line|rect|circle|arc|poly|curve)$/.test(head)) {
        const ln = val(k, "layer"), prim = primitive(k);
        if (!prim) return;
        if (ln === "Edge.Cuts") { edge(prim); return; }
        const l = L.layer(ln);
        if (!l) { notes.add("Board graphics on unsupported layer " + ln + " omitted"); return; }
        const width = strokeWidth(k), net = netOf(one(k, "net"));
        const points = prim.circle ? G().circlePoints(prim.circle.c, prim.circle.r) : prim.points.map(P);
        const closed = !!prim.closed || !!prim.circle;
        if (isCopper(l) && !prim.fill && !closed) doc.items.push({id: A.id(), kind: "track", points, layer: l, width: width || .2, net});
        else doc.items.push({id: A.id(), kind: "graphic", points: closed && !A.same(points[0], points.at(-1)) ? [...points, points[0]] : points,
          layer: l, width, closed, fill: !!prim.fill, ...(prim.fill && closed && width > 0 ? {strokeOutline:true} : {}), ...(net ? {net} : {})});
      } else if (head === "gr_text") {
        const l = L.layer(val(k, "layer")), p = xy(k, "at");
        if (!l || !p) return;
        doc.items.push({id: A.id(), kind: "label", x: p[0], y: p[1], text: String(k[1]), angle: -num(one(k, "at")?.[3]) || 0, size: textSize(k), layer: l});
      } else if (head === "zone") readZone(k, doc, L, netOf, notes, storedFills);
      else if (["dimension", "gr_text_box", "image", "target", "table", "group", "generated"].includes(head)) notes.add("Board " + head.replace(/^gr_/, "") + " objects omitted");
    }
    for (const k of t) {
      if (!isL(k)) continue;
      const first = audit && doc.items.length, beforeEdge = audit && edges.length;
      F().guard(notes, () => readBoardItem(k));
      if (audit && !BOARD_META.has(k[0])) {
        const head = k[0], item = doc.items[first];
        if (edges.length > beforeEdge) edgeSources.push(k);
        else if (head === "zone") observeZone(audit, k, doc, first, storedFills, false, false);
        else {
          const kind = item?.kind || BOARD_KINDS.get(head) || (/^gr_(line|rect|circle|arc|poly|curve)$/.test(head) ? "graphic" : "unknown");
          let reason;
          if (!item) reason = ["track", "via", "graphic", "label"].includes(kind) ? "The record lacks valid geometry or uses an unsupported layer." : unsupported;
          else if ((curved(k) || head === "gr_circle") && !item.arc) reason = tessellated;
          else if (head === "via" && k.includes("micro")) reason = "The microvia becomes a blind or through via.";
          else if (flag(k, "locked")) reason = "The source lock state is omitted.";
          audit.record(kind, !item ? "dropped" : reason ? "approximated" : "kept", k, item, reason);
          audit.produced("pcb", k, doc.items, first);
        }
      }
    }
    const edgeOutcome = audit && ((index, status, reason) => {
      const source = edgeSources[index];
      if (source) audit.record("board-edge", libraryFootprint ? "dropped" : status, source, null,
        libraryFootprint ? "Footprint-library import omits board Edge.Cuts geometry." : reason);
    });
    for (const w of G().setOutline(doc, edges, edgeOutcome)) notes.add(w);
    // Net classes in KiCad 5-style boards (KiCad 6+ keep them in the .kicad_pro).
    const classes = all(t, "net_class");
    if (classes.length) {
      const overrides=F().dict(), byName=F().dict(), members=F().dict();
      for (const c of classes) {
        if (!className(c[1])) continue;
        const g=byName[c[1]]={clearance:num(val(c,"clearance"),NaN),trackWidth:num(val(c,"trace_width"),NaN),
          viaDiameter:num(val(c,"via_dia"),NaN),viaDrill:num(val(c,"via_drill"),NaN)};
        for (const a of all(c,"add_net")) {
          const net=String(a[1]??"").trim();
          if (!net||net.length>512) continue;
          overrides[net]=g;
          if (c[1]!=="Default") (members[c[1]]||=new Set()).add(net);
        }
      }
      const netClasses=Object.fromEntries(Object.entries(members).map(([name,nets])=>[name,[...nets]]));
      setClassRules(doc,byName.Default,overrides,byName,netClasses,audit);
      classRecords(doc,netClasses);
    }
    if (!libraryFootprint) {
      if (applyBoardExpansions(doc, margins)) boardExpansions.set(doc, margins);
      if (audit) observeBoardSettings(audit, t, L, doc, marginFields);
    }
    const knownPads = doc.items.filter(i => i.kind === "part").length;
    notes.add("Imported " + knownPads + " footprints, " + doc.items.filter(i => i.kind === "track").length + " tracks, " +
      doc.items.filter(i => i.kind === "via").length + " vias and " + doc.items.filter(i => i.kind === "polygon").length + " zones");
    if (doc.pcbDrawing?.pours?.length) doc.sourcePourSignature = AtriumPCBPours.signature(doc, new Map(defs.list.map(d => [d.id, d])));
    doc.notes = notes.list();
    if (audit && !libraryFootprint) for (const n of doc.notes) if (!/^Imported \d+ footprints/.test(n)) audit.note(n);
    return {documents: [doc], library: defs.list, notes: doc.notes.slice()};
  }
  function observeBoardSettings(audit, t, L, doc, marginFields) {
    const nets = new Set();
    for (const item of doc.items) {
      if (item.net) nets.add(item.net);
      for (const net of Object.values(item.pinNets || {})) nets.add(net);
    }
    for (const n of all(t, "net")) {
      if (!n[2]) continue; // KiCad's mandatory empty net is a sentinel.
      const used = nets.has(unescape(n[2]));
      audit.record("net", used ? "kept" : "dropped", n, null, used ? undefined : "No imported object uses this net declaration.");
    }
    const table = one(t, "layers"), setup = one(t, "setup"), stack = one(setup, "stackup");
    if (table) {
      audit.children(table, "layers");
      for (const l of table.filter(isL)) {
        const mapped = L.layer(l[1]) || l[1] === "Edge.Cuts";
        audit.record("layer", mapped ? "approximated" : "dropped", l, null, mapped ? "Objects use a native layer. Custom layer names and display settings are omitted." : "This KiCad layer has no native mapping.");
      }
    }
    if (setup) {
      audit.children(setup, "setup");
      for (const field of setup.filter(isL)) if (field !== stack) {
        const kept = marginFields.has(field);
        audit.record("board-setting", kept ? "kept" : "dropped", field, null, kept ? undefined : unsupported);
      }
    }
    if (stack) {
      audit.children(stack, "setup/stackup");
      for (const l of all(stack, "layer")) {
        const type = String(val(l, "type") || "").toLowerCase();
        const kept = !!doc.stackup && (/silk|solder mask/.test(type) || ["core", "prepreg"].includes(type) || type === "copper" && isCopper(L.layer(l[1])));
        audit.record("stackup-layer", kept ? "kept" : "dropped", l, null, kept ? undefined : "This layer was omitted from the imported stackup.");
      }
      for (const field of stack.filter(isL)) if (field[0] !== "layer") audit.record("stackup-setting", "dropped", field, null, unsupported);
    }
    const classFields=new Set(["clearance","trace_width","via_dia","via_drill","add_net"]);
    for(const c of all(t,"net_class")){
      const extra=c.slice(3).find(field=>isL(field)&&!classFields.has(field[0]));
      audit.record("netclass",!className(c[1])?"dropped":extra?"approximated":"kept",c,null,
        !className(c[1])?"The net class name cannot be represented.":extra?"Unsupported net class field: "+extra[0]+".":undefined);
    }
  }
  function observeZone(audit, k, doc, first, storedFills, footprintOwned, libraryFootprint) {
    const item = doc.items[first], keepout = !!one(k, "keepout");
    const kind = keepout ? "keepout" : "polygon";
    const reason = libraryFootprint ? "A library footprint cannot retain a board-level pour or keepout." :
      !item ? "The zone has no usable contour on a supported copper layer." :
      footprintOwned ? "The zone becomes a board object and no longer moves with the footprint." :
      keepout ? "Individual KiCad keepout restrictions are combined into a native keepout area." :
      one(one(k, "fill"), "hatch_orientation") && num(val(one(k, "fill"), "hatch_orientation")) !== item.hatchAngle ? "Hatch orientation is mapped to an available native angle." :
      all(k, "polygon").length > 1 ? "Only the first source contour becomes the editable polygon." :
      curved(one(k, "polygon") || []) ? tessellated : undefined;
    audit.record(kind, !item || libraryFootprint ? "dropped" : reason ? "approximated" : "kept", k, libraryFootprint ? null : item, reason);
    if (!libraryFootprint) audit.produced("pcb", k, doc.items, first);
    audit.children(k, audit.address(k));
    for (const f of all(k, "filled_polygon")) {
      const target = !libraryFootprint && storedFills.get(f);
      const reason = !target ? "The stored fill has no usable ring on an imported polygon layer." : curved(f) ? tessellated : undefined;
      audit.record("pour-fill", !target ? "dropped" : reason ? "approximated" : "kept", f, target, reason);
    }
  }
  // KiCad's solder mask and paste margins resolve pad, then footprint, then board (setup). Before
  // KiCad 9 a local 0 means "inherit"; from KiCad 9 (format 20241229) a written local value overrides.
  const MARGINS = {mask: ["solder_mask_margin"], paste: ["solder_paste_margin"], ratio: ["solder_paste_margin_ratio", "solder_paste_ratio"]};
  const MARGIN_KEY = Object.assign(Object.create(null), ...Object.entries(MARGINS).flatMap(([key, names]) => names.map(n => ({[n]: key}))));
  function localMargins(node, version) {
    const out = {};
    for (const [key, names] of Object.entries(MARGINS)) for (const n of names) {
      const v = num(val(node, n), NaN);
      if (Math.abs(v) <= 100 && (v !== 0 || version >= 20241229)) { out[key] = v; break; }
    }
    return out;
  }
  function readPad(k, fpAngle, notes, netOf, fpMargins, boardMargins, version) {
    const number = String(k[1] ?? ""), type = k[2], shape = k[3], at = one(k, "at"), size = one(k, "size");
    if (!at || !size) return null;
    let w = num(size[1]), h = num(size[2], w);
    const layers = (one(k, "layers") || []).slice(1).map(String);
    const [x, y] = requiredPoint(at);
    const pad = {number, x, y, w, h, drill: 0, shape: Object.hasOwn(PAD_SHAPES, shape) ? PAD_SHAPES[shape] : "rect", angle: r4(norm(fpAngle - num(at[3])))};
    // Shapes Waffle draws natively stay native; the rest become exact custom outlines
    // (pad.poly, pad-local and unrotated) with w and h as their centred extents.
    const custom = poly => {
      const m = poly.reduce((e, q) => [Math.max(e[0], Math.abs(q[0])), Math.max(e[1], Math.abs(q[1]))], [0, 0]);
      pad.shape = "custom"; pad.poly = poly.map(P); pad.w = r4(2 * m[0]); pad.h = r4(2 * m[1]);
    };
    if (shape === "roundrect" || shape === "chamfered_rect") {
      const rr = num(val(k, "roundrect_rratio"), shape === "roundrect" ? .25 : 0), cr = shape === "chamfered_rect" ? num(val(k, "chamfer_ratio"), .2) : 0;
      const names = {top_left: "tl", top_right: "tr", bottom_right: "br", bottom_left: "bl"};
      const corners = (one(k, "chamfer") || []).slice(1).filter(c => Object.hasOwn(names, c)).map(c => names[c]);
      // KiCad's corner ratio is Waffle's roundrectRadiusRatio: radius over the short side, at most one half.
      if (!(cr > 0 && corners.length) && rr > 0) { pad.shape = "roundrect"; pad.roundrectRadiusRatio = G().r6(Math.min(.5, rr)); }
      else if (!(cr > 0 && corners.length)) pad.shape = "rect";
      else custom(G().padOutline(w, h, rr * Math.min(w, h), cr * Math.min(w, h), corners));
    } else if (shape === "trapezoid") {
      const d = xy(k, "rect_delta") || [0, 0], dx = d[0] / 2, dy = d[1] / 2, x = w / 2, y = h / 2;
      if (dx || dy) custom([[-x - dy, y + dx], [x + dy, y - dx], [x - dy, -y + dx], [-x + dy, -y - dx]]);
      else pad.shape = "rect";
    } else if (shape === "custom") {
      // The anchor plus every primitive: one polygon primitive enclosing the anchor is
      // used as drawn; anything else becomes the convex hull of all of them.
      const anchor = val(one(k, "options"), "anchor") === "circle" ? G().circlePoints([0, 0], Math.min(w, h) / 2) : G().padOutline(w, h);
      const prims = (one(k, "primitives") || []).filter(isL), outlines = [];
      for (const p of prims) {
        const g = primitive(p);
        if (!g) continue;
        const pw = strokeWidth(p) / 2;
        if (g.circle) outlines.push(G().circlePoints(g.circle.c, g.circle.r + pw));
        else if (g.points?.length) outlines.push(pw > 0 && !g.closed ? g.points.flatMap(q => [[q[0] - pw, q[1] - pw], [q[0] + pw, q[1] + pw], [q[0] - pw, q[1] + pw], [q[0] + pw, q[1] - pw]]) : g.points);
      }
      const inside = (q, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > q[1]) !== (yj > q[1]) && q[0] < (xj - xi) * (q[1] - yi) / (yj - yi) + xi) c = !c; } return c; };
      if (outlines.length === 1 && prims.length === 1 && prims[0][0] === "gr_poly" && anchor.every(q => inside([q[0] * .999, q[1] * .999], outlines[0]))) custom(outlines[0]);
      else if (outlines.length) { custom(G().hull([...anchor, ...outlines.flat()])); notes.add("Custom pads with several primitives import as the convex hull of their copper"); }
      else pad.shape = val(one(k, "options"), "anchor") === "circle" ? "round" : "rect";
    }
    const drill = one(k, "drill"), throughHole = type === "thru_hole" || type === "np_thru_hole";
    const copper = layers.some(l => /\.Cu$/.test(l));
    if (drill && (throughHole || copper)) {
      const oval = drill[1] === "oval", dx = num(oval ? drill[2] : drill[1]);
      const dy = oval && typeof drill[3] === "string" ? num(drill[3]) : dx;
      const width = Math.min(dx, dy), length = Math.max(dx, dy);
      if (width > 0 && length < 1e6) {
        pad.drill = width;
        // Drill sizes are along the pad's local axes. The pad rotation is applied separately.
        if (oval && length > width) {
          pad.slotLength = length;
          if (dy > dx) pad.slotAngle = 90;
        }
      } else if (throughHole) notes.add("A through-hole pad with invalid drill dimensions uses a generated drill");
      // KiCad stores the copper offset inside the drill record. The hole stays at the pad anchor.
      if (xy(drill, "offset")?.some(value => value !== 0)) notes.add("Pad copper offsets were ignored");
    }
    if (throughHole) {
      pad.layer = "Multi";
      if (!(pad.drill > 0)) pad.drill = r4(Math.min(w, h) / 2);
      if (type === "np_thru_hole") { pad.plated = false; pad.number = ""; }
      else if (pad.slotLength) pad.plated = true;
    } else if (copper) {
      const cu = layers.find(l => /\.Cu$/.test(l) && !l.startsWith("*"));
      pad.layer = cu === "B.Cu" ? "Bottom" : /^In(\d+)\.Cu$/.test(cu || "") ? "Inner " + /\d+/.exec(cu)[0] : "Top";
      if (type === "connect") notes.add("Connector pads import as surface pads");
    } else {
      // A pad on a paste or mask film is an aperture with its own geometry and no net.
      const films = [...PAD_FILMS.keys()].filter(film => layers.includes(film) || layers.includes("*" + film.slice(1)));
      if (!films.length) { notes.add("Pads without copper, paste or mask layers were omitted"); return null; }
      if (films.length > 1) notes.add("Pads without copper on several paste or mask films import on one film");
      return {...pad, layer: PAD_FILMS.get(films[0]), number: ""};
    }
    const on = (side, film) => layers.includes("*." + film) || layers.includes((side === "top" ? "F." : "B.") + film);
    if (["Top", "Bottom", "Multi"].includes(pad.layer)) {
      const top = pad.layer !== "Bottom" && !on("top", "Mask");
      const bottom = pad.layer !== "Top" && !on("bottom", "Mask");
      if (top || bottom) pad.tent = {...(top ? {top: true} : {}), ...(bottom ? {bottom: true} : {})};
      if (!throughHole && !on(pad.layer === "Bottom" ? "bottom" : "top", "Paste")) {
        pad.noPaste = true;
        pad.pasteExpansion = G().r6(-Math.min(pad.w, pad.h) / 2);
      }
    }
    if (copper) {
      const own = localMargins(k, version);
      const pick = key => own[key] ?? fpMargins[key] ?? boardMargins[key];
      const mask = pick("mask"), paste = pick("paste"), ratio = pick("ratio");
      if (mask !== undefined) pad.maskExpansion = G().r6(mask);
      if (!pad.noPaste && (paste !== undefined || ratio !== undefined)) pad.pasteExpansion = G().r6((paste ?? 0) + (ratio ?? 0) * Math.min(w, h));
    }
    if (pad.drill > Math.min(pad.w, pad.h)) { pad.w = Math.max(pad.w, pad.drill); pad.h = Math.max(pad.h, pad.drill); }
    const net = netOf(one(k, "net"));
    if (net) pad.net = net;
    return pad;
  }
  function readZone(k, doc, L, netOf, notes, storedFills) {
    const outline = one(k, "polygon"), points = outline ? pts(outline).map(P) : [];
    if (points.length < 3) return;
    const layers = [val(k, "layer"), ...(one(k, "layers") || []).slice(1)].filter(Boolean)
      .flatMap(l => l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : l === "*.Cu" ? L.copperNames : [l]);
    const net = unescape(val(k, "net_name") ?? "") || netOf(one(k, "net"));
    const keep = one(k, "keepout");
    if (keep) {
      // A rule area is an area: a filled keep-out on its one copper layer, or on the Keep-Out layer
      // (every copper layer) when it spans several, so a re-export writes it back as a rule area.
      const cu = [...new Set(layers.map(L.layer).filter(isCopper))];
      if (cu.length) doc.items.push({id: A.id(), kind: "graphic", points: [...points, points[0]], ...(cu.length === 1 ? {layer: cu[0], keepout: true} : {layer: "Keepout"}), width: 0, closed: true, fill: true});
      notes.add("Rule areas (keepouts) import as keep-out areas");
      return;
    }
    const connect = one(k, "connect_pads"), fill = one(k, "fill"), hatch = val(fill, "mode") === "hatch";
    const style = connect?.[1] === "yes" ? "direct" : connect?.[1] === "no" ? "none" : "relief";
    const clearance = num(val(connect, "clearance"), NaN), priority = num(val(k, "priority"), 0);
    // Stored fill (filled_polygon, one fractured ring each; a single-layer zone
    // of KiCad 5 omits the layer): kept as the zone's current copper, linked
    // to the copper it touches when the board is first inspected
    // (AtriumPolygonPour.adopt). Refilling (Repour) regenerates it.
    const fills = all(k, "filled_polygon").map(f => ({layer: L.layer(val(f, "layer") ?? layers[0]), ring: pts(f).map(P), ...(storedFills ? {source: f} : {})})).filter(f => f.ring.length >= 3);
    for (const ln of layers) {
      const l = L.layer(ln);
      if (!isCopper(l)) continue;
      // KiCad fills higher priorities first; Waffle pours lower pour indices first.
      const item = {id: A.id(), kind: "polygon", points, closed: true, layer: l, net, name: String(val(k, "name") || ""),
        pourIndex: priority ? -priority : 0, connectStyle: style, viaConnectStyle: style === "none" ? "none" : "direct", pourOverSameNet: true,
        removeDeadCopper: num(val(fill, "island_removal_mode") ?? val(k, "island_removal_mode"), 0) !== 1, fillMode: hatch ? "hatched" : "solid"};
      if (clearance >= 0) item.clearance = clearance;
      const gap = num(val(fill, "thermal_gap"), NaN), bridge = num(val(fill, "thermal_bridge_width"), NaN);
      if (gap > 0) item.reliefAirGap = gap;
      if (bridge > 0) item.reliefConductorWidth = bridge;
      if (hatch) {
        const hw = num(val(fill, "hatch_thickness"), .15), hg = num(val(fill, "hatch_gap"), .5), ho = num(val(fill, "hatch_orientation"), 0);
        item.hatchWidth = hw > 0 ? hw : .15; item.hatchPitch = Math.max(item.hatchWidth * 1.01, (hg > 0 ? hg : .5) + item.hatchWidth);
        item.hatchAngle = [0, 45, 90].reduce((b, a) => Math.abs(n360(ho) % 180 - a) < Math.abs(n360(ho) % 180 - b) ? a : b, 45);
      }
      doc.items.push(item);
      const own = fills.filter(f => f.layer === l);
      if (own.length && globalThis.AtriumPCBPours?.region) {
        const drawing = doc.pcbDrawing ||= {annotations: {}};
        (drawing.pours ||= []).push(...own.map(f => {
          const region = AtriumPCBPours.region([f.ring], l, net, {polygon: item.id, links: []});
          storedFills?.set(f.source, region);
          return region;
        }));
        drawing.sourceFill = true;
      }
    }
    notes.add(fills.length ? "Zones import as polygon pours with their stored fill, which counts for connectivity until you repour" : "Zones import as unpoured polygon pours. Repour them before fabrication");
  }

  // ------------------------------------------------------------ schematics
  const ELECTRICAL = {input: 0, bidirectional: 1, output: 2, open_collector: 3, passive: 4, tri_state: 5, open_emitter: 6,
    power_in: 7, power_out: 7, unspecified: 7, free: 4, no_connect: 4};
  const LABEL_IO = {input: "input", output: "output", bidirectional: "bidirectional", tri_state: "bidirectional", passive: "unspecified"};
  function globalShapeLoss(shape) {
    if (shape === "tri_state") return "Tri-state global labels use bidirectional off-sheet connectors.";
    if (shape === "passive") return "Passive global labels keep an unspecified direction and use the native untyped connector outline.";
    if (shape && !Object.hasOwn(LABEL_IO, shape)) return "An unknown global-label shape uses an unspecified off-sheet connector.";
  }
  // A library symbol as one Waffle definition with gates: KiCad unit u becomes part u
  // (unit 0, shared by every unit, becomes part 0) and De Morgan body style 2 becomes
  // alt:true art (style 1 alt:false, style 0 shared). Coordinates go to Waffle's Y-down
  // part frame (library symbols are drawn Y up). Hidden power-input pins are listed in
  // `implicit`: each names a global net.
  function symbolGeometry(lib, audit) {
    if (!audit) return readSymbolGeometry(lib);
    const pending = pendingObservations(audit);
    let result;
    try { result = readSymbolGeometry(lib, pending); }
    catch (error) {
      pending.finish("dropped", "The containing symbol geometry could not be read.");
      throw error;
    }
    pending.finish();
    return result;
  }
  function readSymbolGeometry(lib, audit) {
    if (audit) {
      audit.children(lib, audit.address(lib));
      const properties = new Set(["symbol", "extends", "property", "power", "pin_names", "pin_numbers", "in_bom", "on_board", "exclude_from_sim", "embedded_fonts"]);
      for (const node of lib) if (isL(node) && !properties.has(node[0])) audit.record("symbol-setting", "dropped", node, null, unsupported);
    }
    const map = p => [r4(p[0]), r4(-p[1])];
    const shapes = [], pins = [], implicit = [];
    const namesHidden = flag(one(lib, "pin_names"), "hide"), offset = num(val(one(lib, "pin_names"), "offset"), .508);
    const sections = all(lib, "symbol").map(s => { const m = /_(\d+)_(\d+)$/.exec(s[1] || ""); return {s, unit: m ? +m[1] : 0, style: m ? +m[2] : 0}; });
    const parts = Math.max(1, ...sections.map(x => x.unit)), alternate = sections.some(x => x.style === 2);
    if (parts > 64) throw Error("A symbol declares more than 64 units.");
    if (audit) for (const {s} of sections) audit.children(s, audit.address(s));
    for (const {s: u, unit, style} of sections) for (const k of u) {
      if (!isL(k)) continue;
      const shapeIndex = audit && shapes.length;
      const tag = {...(parts > 1 && unit > 0 ? {part: unit} : {}), ...(alternate && style > 0 ? {alt: style === 2} : {})};
      const head = k[0], width = strokeWidth(k), fill = fillOn(k);
      if (head === "polyline" || head === "bezier") {
        let p = pts(k);
        if (head === "bezier") p = bezier(p);
        if (p.length >= 2) shapes.push({kind: "path", style: "body", points: p.map(map), closed: false, fill, width, ...tag});
      } else if (head === "rectangle") {
        const a = xy(k, "start"), b = xy(k, "end");
        if (a && b) shapes.push({kind: "path", style: "body", points: [a, [b[0], a[1]], b, [a[0], b[1]], a].map(map), closed: true, fill, width, ...tag});
      } else if (head === "circle") {
        const c = xy(k, "center");
        if (c) shapes.push({kind: "circle", style: "body", ...pointXY(map(c)), r: num(val(k, "radius"), 1), width, ...(fill ? {fill: true} : {}), ...tag});
      } else if (head === "arc") {
        const s = xy(k, "start"), m = xy(k, "mid"), e = xy(k, "end");
        let p = null;
        if (s && m && e) p = G().arc3(s, m, e);
        else {
          const rad = one(k, "radius"), c = xy(rad, "at"), r = num(val(rad, "length")), ang = one(rad, "angles");
          if (c && r && ang) { const a0 = num(ang[1]), a1 = num(ang[2]); p = G().arcPoints(c, r, a0, ((a1 - a0) % 360 + 360) % 360 || 360); }
        }
        if (p) shapes.push({kind: "path", style: "body", points: p.map(map), closed: false, fill, width, ...tag});
      } else if (head === "text") {
        const at = one(k, "at");
        if (!at || hidden(k)) { audit?.record("label", "dropped", k, null, "Hidden or unpositioned symbol text is omitted."); continue; }
        const a = num(at[3]) / 10;
        shapes.push({kind: "text", ...pointXY(map([num(at[1]), num(at[2])])), text: plain(k[1]), size: textSize(k), style: "body", ...(a ? {angle: r4(-a)} : {}), ...tag});
      } else if (head === "pin") {
        const at = one(k, "at"), len = num(val(k, "length"), 2.54), ang = num(at?.[3]) * Math.PI / 180;
        const c = [num(at?.[1]), num(at?.[2])], body = [c[0] + len * Math.cos(ang), c[1] + len * Math.sin(ang)];
        const number = String(val(k, "number") ?? ""), pinName = plain(val(k, "name") ?? ""), isHidden = flag(k, "hide");
        const [hx, hy] = map(c), inner = map(body);
        // Pins drawn in both De Morgan styles are one electrical pin: keep the normal one.
        if (tag.alt === true && sections.some(x => x.style === 1)) {
          audit?.record("pin", "dropped", k, null, "The normal-body pin represents both body styles. The alternate pin record is omitted.");
          continue;
        }
        const pinTag = parts > 1 && unit > 0 ? {part: unit} : {};
        pins.push({x: hx, y: hy, number, name: pinName === "~" ? "" : pinName, hidden: isHidden, electrical: Object.hasOwn(ELECTRICAL, k[1]) ? ELECTRICAL[k[1]] : 7, ...pinTag});
        if (audit) {
          const reason = !Object.hasOwn(ELECTRICAL, k[1]) || ["power_in", "power_out", "free", "no_connect"].includes(k[1]) || k[2] !== "line" ?
            "KiCad pin type or pin-end artwork is simplified in the native symbol." : undefined;
          audit.record("pin", reason ? "approximated" : "kept", k, pins.at(-1), reason);
        }
        if (isHidden) { if (k[1] === "power_in" && pinName && pinName !== "~") implicit.push({index: pins.length - 1, name: pinName}); continue; }
        if (len > 0) shapes.push({kind: "path", style: "body", points: [[hx, hy], inner], closed: false, fill: false, width: 0, ...pinTag});
        const dx = Math.sign(r4(inner[0] - hx));
        if (!namesHidden && pinName && pinName !== "~" && dx) {
          const size = textSize(one(k, "name")), w = pinName.length * size * .6, gap = offset > 0 ? offset : .4;
          shapes.push({kind: "text", x: r4(dx > 0 ? inner[0] + gap : inner[0] - gap - w), y: r4(inner[1] + size * .35), text: pinName, size, style: "body", ...pinTag});
        }
      }
      if (audit && head !== "pin") {
        const shape = shapes[shapeIndex], kind = head === "text" ? "label" : ["polyline", "bezier", "rectangle", "circle", "arc"].includes(head) ? "graphic" : "unknown";
        const reason = !shape ? kind === "unknown" ? unsupported : malformed : curved(k) ? tessellated : undefined;
        audit.record(kind, !shape ? "dropped" : reason ? "approximated" : "kept", k, shape, reason);
      }
    }
    const symbol = {shapes, pins};
    if (parts > 1) symbol.parts = parts;
    if (alternate) symbol.alternate = true;
    return {symbol, implicit, parts};
  }
  const pointXY = p => ({x: p[0], y: p[1]});
  function libProps(lib) {
    const out = F().dict();
    for (const p of all(lib, "property")) out[p[1]] = String(p[2] ?? "");
    return out;
  }
  function powerStyle(name, value) {
    const s = (name + " " + value).toLowerCase();
    if (/earth|chassis/.test(s)) return "earth";
    if (/gnd|vss|ground|^0v|\b0v\b/.test(s)) return "gnd";
    return "bar";
  }

  // KiCad paper coordinates start at the top left. Keep named sheets editable and retain
  // the physical dimensions for formats outside the template catalogue.
  function readPaper(doc, paper, notes) {
    if (!paper) return;
    const name = String(paper[1]), portrait = paper.includes("portrait");
    const size = /^[ABCDE]$/.test(name) ? "ANSI " + name : /^A[0-4]$/.test(name) ? name :
      ({USLetter:"Letter", USLegal:"Legal", USLedger:"Tabloid"})[name];
    if (size) { doc.sheet = {size, orientation: portrait ? "portrait" : "landscape"}; return; }
    let w, h;
    if (name === "User") {
      w = Number(paper[2]); h = Number(paper[3]);
      if (![w,h].every(v => Number.isFinite(v) && v > 0)) { notes.add("Invalid custom paper dimensions."); return; }
      // Eeschema clamps custom page dimensions between one and 120 inches.
      const clamp = v => Math.max(25.4, Math.min(3048,v));
      if (clamp(w) !== w || clamp(h) !== h) notes.add("Custom paper dimensions were limited to KiCad’s schematic paper range.");
      w = clamp(w); h = clamp(h);
    } else if (name === "A5") { w = 210; h = 148; }
    else if (name === "GERBER") { w = h = 812.8; }
    else { notes.add("Unrecognised schematic paper " + name + "."); return; }
    if (portrait && w > h) [w,h] = [h,w];
    doc.schDrawing = {width:w, height:h, grid:2.54, border:true, zones:false, frame:[]};
  }

  function readSheet(name, text, sink) {
    const t = AtriumSexpr.parse(text);
    if (t[0] !== "kicad_sch") throw Error("This is not a KiCad schematic (kicad_sch).");
    const audit = observations(sink, name);
    audit?.children(t);
    const seenLibs = audit && new Set(), usedPower = audit && new Set();
    const libNodes = one(t, "lib_symbols");
    if (audit && libNodes) audit.children(libNodes, "lib_symbols");
    const version = num(val(t, "version"), 0), notes = F().notebook(), defs = F().definitions();
    if (version && version < 20211123) notes.add("This sheet predates KiCad 6 (format " + version + "). It was read with the KiCad 6 rules; check the result.");
    if (version > NEWEST) notes.add(newer(version));
    const doc = A.sheet("schematic", F().stem(name));
    doc.sourceName = name;
    const paper=one(t,"paper"), paperNotes=[];
    readPaper(doc,paper,{add:msg=>{notes.add(msg);paperNotes.push(msg);}});
    const hasPaper = !!(doc.sheet?.size || doc.schDrawing);
    if (hasPaper) doc.sheetOrigin = "top-left";
    if (paper) audit?.record("page-setting", hasPaper ? (paperNotes.length ? "approximated" : "kept") : "dropped",paper,null,paperNotes.join(" ") || undefined);
    const libs = new Map();
    for (const s of all(one(t, "lib_symbols"), "symbol")) libs.set(String(s[1]), s);
    const instances = new Map(), instanceList = [];
    for (const p of all(one(t, "symbol_instances"), "path")) {
      const uuid = String(p[1]).split("/").filter(Boolean).pop(), v = {reference: String(val(p, "reference") ?? ""), unit: num(val(p, "unit"), 1)};
      if (!instances.has(uuid)) instances.set(uuid, v);
      instanceList.push({path: String(p[1]), ...v});
    }
    const sheetUuid = String(val(t, "uuid") || ""), symbols = new Map();
    let multiUnit = false;
    function readSheetItem(k, loss) {
      const head = k[0];
      if (head === "symbol") {
        const libId = String(val(k, "lib_name") ?? val(k, "lib_id") ?? ""), lib = libs.get(libId) || libs.get(String(val(k, "lib_id")));
        if (!lib) { loss?.("part", "The placed symbol has no embedded library geometry."); notes.add("Symbols without embedded library geometry omitted"); return; }
        const at = one(k, "at"), x = num(at?.[1]), y = num(at?.[2]), ka = num(at?.[3]);
        // KiCad turns a symbol by its angle and then mirrors it on screen ("mirror x" flips Y,
        // "mirror y" flips X): rotate-then-mirror, the order eeschema's SetOrientation composes.
        // Waffle mirrors local X and then rotates, so a mirrored symbol turns the other way:
        // flipX∘R(-a) = R(a)∘flipX, and flipY = R(180)∘flipX. Checked against real designs whose
        // board pad nets fix the pin order of two-pin parts at 90°/270° with a mirror.
        const mirror = val(k, "mirror"), my = mirror === "x" ? -1 : 1;
        const angle = r4(norm(mirror === "x" ? ka + 180 : mirror === "y" ? ka : -ka)), mirrored = mirror === "x" || mirror === "y";
        const unit = Math.max(1, Math.round(num(val(k, "unit"), 1))), style = num(val(k, "convert") ?? val(k, "body_style"), 1);
        const uuid = String(val(k, "uuid") || val(k, "tstamp") || A.id());
        const fields = F().dict();
        for (const p of all(k, "property")) fields[p[1]] = p;
        const lp = libProps(lib);
        let ref = String(fields.Reference?.[2] ?? lp.Reference ?? "U?");
        const instance = instances.get(uuid) || firstInstance(k, sheetUuid);
        if (instance?.reference) ref = instance.reference;
        const value = String(fields.Value?.[2] ?? lp.Value ?? "");
        const frame = {x, y, angle, ...(mirrored ? {mirror: true} : {})};
        if (one(lib, "power") || ref.startsWith("#PWR")) {
          const geo = symbolGeometry(lib), first = geo.symbol.pins[0];
          const pin = first ? A.world([first.x, first.y], frame) : [x, y];
          if (/^PWR_FLAG$/i.test(value) || ref.startsWith("#FLG")) { loss?.("power", "PWR_FLAG electrical markers are omitted."); notes.add("PWR_FLAG markers omitted"); return; }
          usedPower?.add(lib);
          loss?.("power", "The source symbol is drawn with a native power-port style.");
          const pstyle = powerStyle(libId, value), base = pstyle === "bar" ? 1 : 3;
          // Rotate the symbol's direction, then mirror it (x: up and down swap, y: left and right).
          const turned = ((base + Math.round(ka / 90)) % 4 + 4) % 4;
          doc.items.push({id: A.id(), kind: "power", x: P(pin)[0], y: P(pin)[1], text: plain(value), style: pstyle,
            direction: my < 0 ? (4 - turned) % 4 : mirror === "y" ? (6 - turned) % 4 : turned, showName: !hidden(fields.Value || [])});
          return;
        }
        const footprint = String(fields.Footprint?.[2] ?? lp.Footprint ?? "");
        const key = JSON.stringify([libId, nameOf(footprint)]);
        let entry = symbols.get(key);
        if (!entry) {
          const observeLib = audit && !seenLibs.has(lib) ? audit : null;
          const geo = symbolGeometry(lib, observeLib), libName = nameOf(String(val(k, "lib_id") || libId));
          const def = defs.add({id: A.id(), name: libName, description: lp.Description || lp.ki_description || "",
            category: "KiCad symbols", prefix: (lp.Reference || ref).replace(/[?\d]+$/, "") || "U", value: lp.Value || value,
            symbol: geo.symbol, footprintName: nameOf(footprint), parameters: lp.Datasheet && lp.Datasheet !== "~" ? {DATASHEET: lp.Datasheet} : {}, sourceName: name}, key);
          symbols.set(key, entry = {def, implicit: geo.implicit, parts: geo.parts});
          if (observeLib) { seenLibs.add(lib); audit.record("symbol-definition", "kept", lib, def); }
        }
        const def = entry.def, parameters = {};
        for (const key of Object.keys(fields)) if (!["Reference", "Value", "Footprint"].includes(key) && fields[key][2]) F().put(parameters, key === "Datasheet" ? "DATASHEET" : key, String(fields[key][2]));
        const item = {id: A.id(), kind: "part", def: def.id, ref, value, link: linkOf(uuid), pinNets: {}, x, y, angle};
        Object.assign(item, sourceIdentity(k));
        // Every sheet path this symbol is placed under (a sheet used several times); link() maps them to channels.
        const paths = all(one(k, "instances"), "project").flatMap(project => all(project, "path").map(p => ({
          project: String(project[1]), path: String(p[1]), reference: String(val(p, "reference") ?? ""), unit: num(val(p, "unit"), 1)
        })));
        if (paths.length > 1) item.kicadPaths = paths;
        if (mirrored) item.mirror = true;
        if (entry.parts > 1) { item.unit = Math.min(unit, entry.parts); multiUnit = true; }
        if (style === 2 && def.symbol.alternate) item.alt = true;
        const local = p => { const q = A.rotate([p[0] - x, p[1] - y], -angle); return (mirrored ? [-q[0], q[1]] : q).map(r4); };
        if (fields.Reference) { const p = xy(fields.Reference, "at"); if (p) item.refAt = local(p); if (hidden(fields.Reference)) item.showRef = false; }
        if (fields.Value) { const p = xy(fields.Value, "at"); if (p) item.valueAt = local(p); item.showValue = !hidden(fields.Value); }
        if (Object.keys(parameters).length) item.parameters = parameters;
        if (flag(k, "dnp")) item.dnp = true;
        doc.items.push(item);
        // KiCad joins a hidden power-input pin to the global net of its name. A
        // zero-length named wire on the pin makes that connection explicit.
        for (const {index, name: net} of entry.implicit) {
          const pin = def.symbol.pins[index];
          if (pin.part > 0 && pin.part !== (item.unit || 1)) continue;
          const at = A.world([pin.x, pin.y], item).map(r4);
          doc.items.push({id: A.id(), kind: "wire", points: [at, at.slice()], net, implicitNet: true});
          notes.add("Hidden power pins joined their implicit global nets through zero-length named wires");
        }
      } else if (head === "wire" || head === "bus") {
        const p = pts(k).map(P);
        if (p.length >= 2) doc.items.push({id: A.id(), ...sourceIdentity(k), kind: head, points: p});
      } else if (head === "junction") { const p = xy(k, "at"); doc.items.push({id: A.id(), kind: "junction", x: p[0], y: p[1]}); }
      else if (head === "no_connect") { const p = xy(k, "at"); doc.items.push({id: A.id(), kind: "noerc", x: p[0], y: p[1]}); }
      else if (head === "bus_entry") {
        const p = xy(k, "at"), s = xy(k, "size") || [2.54, 2.54], size = Math.hypot(s[0], s[1]) / Math.SQRT2;
        if (size > 0) doc.items.push({id: A.id(), kind: "busentry", x: p[0], y: p[1], size: r4(size), angle: r4(Math.atan2(s[1], s[0]) * 180 / Math.PI + 45)});
      } else if (head === "label" || head === "global_label" || head === "hierarchical_label") {
        const at = one(k, "at"), x = num(at?.[1]), y = num(at?.[2]), angle = r4(norm(-num(at?.[3]))), textV = plain(k[1]);
        if (!textV) return;
        if (head === "label") doc.items.push({id: A.id(), kind: "netlabel", x, y, text: textV, angle});
        else {
          const shape = val(k, "shape"), io = Object.hasOwn(LABEL_IO, shape) ? LABEL_IO[shape] : "unspecified";
          if (head === "global_label") {
            doc.items.push({id: A.id(), kind: "offsheet", x, y, text: textV, angle, ...(io === "unspecified" ? {} : {io})});
            const loss = globalShapeLoss(shape);
            if (loss) notes.add(loss);
          } else doc.items.push({id: A.id(), kind: "port", x, y, text: textV, io, angle});
        }
      } else if (head === "text") {
        const at = one(k, "at");
        if (!at || !k[1]) return;
        doc.items.push({id: A.id(), kind: "label", x: num(at[1]), y: num(at[2]), text: plain(k[1]), angle: -num(at[3]) || 0, size: textSize(k)});
      } else if (head === "text_box") {
        const at = xy(k, "at") || xy(k, "start"), size = xy(k, "size");
        if (at && size && size[0] > 0 && size[1] > 0) doc.items.push({id: A.id(), kind: "textframe", x: at[0], y: at[1], w: size[0], h: size[1], text: plain(k[1])});
      } else if (["polyline", "rectangle", "circle", "arc", "bezier"].includes(head)) {
        let p;
        if (head === "polyline") p = pts(k);
        else if (head === "bezier") p = bezier(pts(k));
        else if (head === "rectangle") { const a = xy(k, "start"), b = xy(k, "end"); p = [a, [b[0], a[1]], b, [a[0], b[1]], a]; }
        else if (head === "circle") p = G().circlePoints(xy(k, "center"), num(val(k, "radius"), 1));
        else p = G().arc3(xy(k, "start"), xy(k, "mid"), xy(k, "end"));
        if (p?.length >= 2) doc.items.push({id: A.id(), kind: "graphic", points: p.map(P), width: strokeWidth(k)});
      } else if (head === "sheet") {
        const at = xy(k, "at"), size = xy(k, "size");
        if (!at || !size) return;
        const props = F().dict();
        for (const p of all(k, "property")) props[p[1]] = String(p[2] ?? "");
        const sheetName = props.Sheetname ?? props["Sheet name"] ?? "Sheet", file = props.Sheetfile ?? props["Sheet file"] ?? "";
        const entries = [];
        audit?.children(k, audit.address(k));
        for (const p of all(k, "pin")) {
          const q = xy(p, "at"), e = 0.01;
          if (!q) { audit?.record("sheet-entry", "dropped", p, null, malformed); continue; }
          const side = Math.abs(q[0] - at[0]) < e ? "left" : Math.abs(q[0] - at[0] - size[0]) < e ? "right" : Math.abs(q[1] - at[1]) < e ? "top" : "bottom";
          entries.push({id: A.id(), name: plain(p[1]), side, offset: r4(side === "left" || side === "right" ? q[1] - at[1] : q[0] - at[0]), io: Object.hasOwn(LABEL_IO, p[2]) ? LABEL_IO[p[2]] : "unspecified"});
          if (audit) {
            const reason = ioApprox(p[2]) ? "The source I/O type is mapped to a native direction." : undefined;
            audit.record("sheet-entry", reason ? "approximated" : "kept", p, entries.at(-1), reason);
          }
        }
        doc.items.push({id: A.id(), kind: "sheetsymbol", x: at[0], y: at[1], w: size[0], h: size[1], name: sheetName, sheet: "", ...(file ? {file} : {}), entries, kicadUuid: String(val(k, "uuid") || "")});
      } else if (head === "image") {
        const data=one(k,"data"),center=xy(k,"at"),scale=num(val(k,"scale"),1);
        const encoded=data?.slice(1).join("")||"";
        if(!center || !(scale>0) || !encoded || encoded.length>7999900 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)){
          notes.add("Unsupported embedded image data or dimensions.");return;
        }
        const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0)),meta=AtriumSexpr.pngInfo(bytes);
        if(!meta){notes.add("Unsupported embedded image encoding.");return;}
        const w=meta.width*25.4/meta.ppi*scale,h=meta.height*25.4/meta.ppi*scale;
        doc.items.push({id:A.id(),kind:"image",x:r4(center[0]-w/2),y:r4(center[1]-h/2),w:r4(w),h:r4(h),
          src:"data:image/png;base64,"+encoded,extent:[meta.width,meta.height],name:"KiCad image.png"});
      }
      else if (head === "netclass_flag" || head === "directive_label") notes.add("Net class directives omitted");
      else if (head === "rule_area" || head === "table") notes.add("Rule areas and tables omitted");
    }
    for (const k of t) {
      if (!isL(k)) continue;
      const first = audit && doc.items.length;
      let reason, kind;
      F().guard(notes, () => readSheetItem(k, audit && ((k, message) => { kind = k; reason = message; })));
      if (audit && k[0]!=="paper" && !SHEET_META.has(k[0])) {
        const item = doc.items[first], head = k[0];
        kind ||= item?.kind || SCHEMATIC_KINDS.get(head) || "unknown";
        if (!reason && item) {
          if (curved(k) || head === "circle") reason = tessellated;
          else if (head === "global_label") reason = globalShapeLoss(val(k, "shape"));
          else if (head === "hierarchical_label" && ioApprox(val(k, "shape"))) reason = "The source label's electrical shape is simplified.";
          else if (head === "symbol" && doc.items.length > first + 1) reason = "Hidden power pins use generated named wires to retain their connectivity.";
        } else if (!reason) {
          reason = head === "bus_alias" ? "Named bus aliases are not expanded." : ["part", "wire", "bus", "busentry", "sheetsymbol", "junction", "graphic", "label", "netlabel"].includes(kind) ? malformed : unsupported;
        }
        audit.record(kind, !item ? "dropped" : reason ? "approximated" : "kept", k, item, reason);
        if (item?.kind === "sheetsymbol" && item.file) {
          let links = sheetLinks.get(doc);
          if (!links) sheetLinks.set(doc, links = []);
          links.push({item, audit, ref: audit.address(k)});
        }
        audit.produced("schematic", k, doc.items, first);
      }
    }
    if (audit) for (const lib of all(libNodes, "symbol")) if (!seenLibs.has(lib)) {
      const power = usedPower.has(lib);
      audit.record("symbol-definition", power ? "approximated" : "dropped", lib, null,
        power ? "The embedded artwork was replaced by native power ports." : "No imported placement used this embedded definition.");
    }
    if (multiUnit) notes.add("Multi-unit symbols import as one gated part; each placed unit is a gate (U1A, U1B)");
    // KiCad nets: local labels belong to their sheet, hierarchical labels meet sheet pins, global
    // labels and power symbols are global, i.e. Waffle's "hierarchical" net identifier scope
    // (import-link.js applies the hint to a new project). Bus groups ("UART{TX RX}") and vectors
    // expand to their members (sch-objects.js), and differently named buses drawn as one bus
    // alias their members (hierarchy.js), as in KiCad.
    doc.netScope = "hierarchical";
    const aliasCount = all(t, "bus_alias").length;
    if (aliasCount) notes.add("Bus aliases (" + aliasCount + ") are not expanded: buses that use one connect only through their member labels");
    doc.notes = notes.list();
    if (audit) for (const n of doc.notes) audit.note(n);
    const result = {documents: [doc], library: defs.list, notes: doc.notes.slice()};
    if (instances.size) result.kicadInstances = instances;
    if (instanceList.length) result.kicadInstanceList = instanceList;
    doc.kicadUuid = sheetUuid;
    return result;
  }
  function firstInstance(k, sheetUuid) {
    const paths = all(one(k, "instances"), "project").flatMap(p => all(p, "path"));
    if (!paths.length) return null;
    const own = paths.find(p => String(p[1]) === "/" + sheetUuid) || paths[0];
    return {reference: String(val(own, "reference") ?? ""), unit: num(val(own, "unit"), 1)};
  }

  // KiCad net classes by name (the rules above only keep their limits per net): class records in the
  // form signals.js and rules.js read (doc.sourceClasses; altium-rules.js classes()), so the classes
  // become tags and rules can scope to them.
  function classRecords(doc, members) {
    const clean = s => String(s).replace(/[|\r\n]/g, " ");
    const lines = Object.keys(members).sort().map(c => ["RECORD=Class", "NAME=" + clean(c), "KIND=0", "SUPERCLASS=FALSE", ...[...new Set(members[c])].sort().map((m, i) => "M" + i + "=" + clean(m))].join("|"));
    if (lines.length) doc.sourceClasses = lines;
    else delete doc.sourceClasses;
  }

  // ------------------------------------------------------------ projects
  // Cross-file outcomes exist only until the selected project has been linked.
  const projectReports = new WeakMap(), sheetLinks = new WeakMap();
  function readProject(name, text, sink) {
    let j;
    try { j = JSON.parse(text); } catch { throw Error("The project file is not valid JSON."); }
    const ns = j?.net_settings || {}, classes = Array.isArray(ns.classes) ? ns.classes : [];
    const project={name:F().stem(name),classes:F().dict(),assignments:F().dict(),patterns:[],
      minimumDiameter:dimension(j?.board?.design_settings?.rules?.min_via_diameter)};
    for (const c of classes) {
      if (!className(c?.name)) continue;
      project.classes[c.name]={clearance:+c.clearance,trackWidth:+c.track_width,viaDiameter:+c.via_diameter,viaDrill:+c.via_drill};
      for (const n of Array.isArray(c.nets) ? c.nets : []) project.assignments[n] = c.name;
    }
    if (ns.netclass_assignments && typeof ns.netclass_assignments === "object")
      for (const [n, c] of Object.entries(ns.netclass_assignments)) project.assignments[n] = Array.isArray(c) ? c[0] : c;
    for (const p of Array.isArray(ns.netclass_patterns) ? ns.netclass_patterns : [])
      if (p && typeof p.pattern === "string" && typeof p.netclass === "string") project.patterns.push(p);
    if (sink) projectReports.set(project, {audit: observations(sink, name), json: j, classes: new Set(), assignments: new Set(), patterns: new Set()});
    const notes = [];
    if (classes.length) notes.push(classes.length + " net class(es) read from the project settings");
    return {documents: [], library: [], notes, kicadProject: project};
  }


  function finishProjectReport(project, selectedBoards) {
    const evidence = projectReports.get(project);
    if (!evidence) return;
    projectReports.delete(project);
    const {audit, json, classes, assignments, patterns} = evidence;
    const object = v => v !== null && typeof v === "object" && !Array.isArray(v) ? v : {};
    const settings = object(json?.net_settings), sourceClasses = Array.isArray(settings.classes) ? settings.classes : [];
    const last = new Map(sourceClasses.map((c, i) => [c?.name, i]));
    const validRule = v => dimension(+v)!=null;
    const ruleFields=["clearance","track_width","via_diameter","via_drill"], knownFields=new Set(["name","nets",...ruleFields]);
    sourceClasses.forEach((c, i) => {
      const ref = "net_settings/classes/" + i;
      const hasRule=c&&ruleFields.some(k=>validRule(c[k]));
      const used=c&&last.get(c.name)===i&&classes.has(c.name)&&(hasRule||c.name!=="Default");
      const dropped=used&&Object.keys(c).filter(k=>!knownFields.has(k)||ruleFields.includes(k)&&!validRule(c[k]));
      const reason=!used?"No supported value from this class was used by the selected board." :
        dropped.length?"Net class settings omitted: "+dropped.join(", ")+".":undefined;
      audit.record("netclass", !used ? "dropped" : reason ? "approximated" : "kept", ref, null, reason);
      for (const [n, net] of (Array.isArray(c?.nets) ? c.nets : []).entries()) {
        const kept = used && assignments.has(net) && project.assignments[net] === c.name;
        audit.record("netclass-assignment", kept ? "kept" : "dropped", ref + "/nets/" + n, null, kept ? undefined : "No selected board net uses this assignment.");
      }
    });
    for (const [net, membership] of Object.entries(object(settings.netclass_assignments))) {
      const used = assignments.has(net), multiple = Array.isArray(membership) && membership.length > 1;
      const reason = !used ? "No selected board net uses this assignment." : multiple ? "Only the first assigned class is used." : undefined;
      audit.record("netclass-assignment", !used ? "dropped" : reason ? "approximated" : "kept", "net_settings/netclass_assignments/" + net, null, reason);
    }
    if (Array.isArray(settings.netclass_patterns)) settings.netclass_patterns.forEach((p, i) => {
      const used = patterns.has(p);
      audit.record("netclass-pattern", used ? "approximated" : "dropped", "net_settings/netclass_patterns/" + i, null, used ?
        "The expression is applied to matching board nets at import time." : "The pattern applied to no selected board net.");
    });
    for (const key of Object.keys(settings)) if (!["classes", "netclass_assignments", "netclass_patterns", "meta"].includes(key))
      audit.record("project-setting", "dropped", "net_settings/" + key, null, unsupported);
    for (const key of Object.keys(object(json))) if (!["net_settings", "meta", "board"].includes(key))
      audit.record("project-setting", "dropped", key, null, unsupported);
    const board = object(json?.board);
    for (const key of Object.keys(board)) if (key !== "design_settings") audit.record("board-setting", "dropped", "board/" + key, null, unsupported);
    for (const [key, v] of Object.entries(object(board.design_settings))) {
      if (key === "meta") continue;
      if(key==="rules"&&v&&typeof v==="object")for(const [rule,value] of Object.entries(object(v))){
        const kept=selectedBoards&&rule==="min_via_diameter"&&(value===0||project.minimumDiameter!=null);
        audit.record("board-rule",kept?"kept":"dropped","board/design_settings/rules/"+rule,null,kept?undefined:
          rule==="min_via_diameter"?"The minimum via diameter needs a selected board and a valid millimetre length.":
          rule==="min_through_hole_diameter"?"The board minimum excludes laser microvias, which this import cannot distinguish.":"This KiCad project constraint has no imported native rule.");
      }
      else audit.record("board-setting", "dropped", "board/design_settings/" + key, null, unsupported);
    }
    if (!selectedBoards) audit.note("The selected files contain no linked board to receive these project rules.");
  }

  // KiCad applies later custom rules first. Translate exact class, net and
  // via-type predicates; diagnose any other conditions at the constraint.
  function customScope(condition) {
    if (condition==null) return {scope:{kind:"all"},via:false};
    if (typeof condition!=="string") return null;
    const predicates=condition.split(/\s*&&\s*/).map(part=>part.trim()), type=/^A\.Type\s*==\s*'Via'$/i;
    const via=predicates.some(part=>type.test(part)), filter=predicates.filter(part=>!type.test(part));
    if(!filter.length&&via)return {scope:{kind:"all"},via};
    if(filter.length!==1)return null;
    const field=/^A\.(NetClass|NetName|Net)\s*==\s*'([^'\\]+)'$/i.exec(filter[0]);
    const method=/^A\.hasNetclass\(\s*'([^'\\]+)'\s*\)$/i.exec(filter[0]);
    if(!field&&!method)return null;
    const value=field?.[2]??method[1],kind=method||field[1].toLowerCase()==="netclass"?"netclass":"net";
    if(value!==value.trim()||value.length>(kind==="netclass"?128:512)||value==="__proto__"||
       kind==="netclass"&&value==="Default"||/[*?]/.test(value))return null;
    return {scope:{kind,value},via};
  }
  function readCustomRules(name,text,sink) {
    const tree=AtriumSexpr.parse("(custom-rules\n"+text+"\n)",{comments:true});
    if(val(tree,"version")!=="1")throw Error("Choose a KiCad version 1 custom rules file.");
    const audit=observations(sink,name), entries=all(tree,"rule");
    audit?.children(tree);
    return {documents:[],library:[],notes:[],kicadRules:{entries,audit}};
  }
  function applyCustomRules(board,source,minimumDiameter) {
    const R=globalThis.AtriumRules, set=board&&R.migrate(board.rules), list=[], notes=F().notebook();
    let priority=1;
    function add(type,scope,fields){
      const id="KiCadConstraint-"+priority;
      list.push(makeRule(id,"KiCad custom constraint "+priority,type,priority++,scope,fields));
    }
    for(const entry of [...source?.entries||[]].reverse()){
      const audit=source.audit, scope=customScope(val(entry,"condition")), layer=one(entry,"layer"), severity=val(entry,"severity");
      const unsupportedScope=layer?"layer":severity&&severity!=="error"?"severity":!scope||all(entry,"condition").length>1?"condition":null;
      audit?.children(entry,audit.address(entry));
      for(const c of all(entry,"constraint")){
        let reason, approximation;
        const kind=c[1], isDiameter=kind==="via_diameter", isHole=kind==="hole_size";
        if(!board)reason="No uniquely matching selected .kicad_pcb board.";
        else if(!isDiameter&&!isHole)reason="Unsupported custom constraint: "+kind+".";
        else if(unsupportedScope)reason="Unsupported custom rule "+unsupportedScope+".";
        else if(list.length+set.list.length>=4998)reason="The native rule book limit was reached.";
        else{
          const lengths=F().dict();
          for(const f of c.slice(2)){
            const length=isL(f)&&f.length===2?R.units.parse(f[1]):NaN;
            if(!Number.isFinite(length)||length<0||length>1000||f[0]==="opt"&&length===0||!["min","opt","max"].includes(f[0])||Object.hasOwn(lengths,f[0])){
              reason="Unsupported or invalid "+kind+" range.";break;
            }
            lengths[f[0]]=length;
          }
          const {min,opt,max}=lengths;
          const floor=isDiameter&&minimumDiameter!=null&&(min!=null||max!=null)?Math.max(minimumDiameter,min??0):min;
          if(Object.keys(lengths).length===0||max!=null&&floor!=null&&floor>max)reason="Invalid or conflicting "+kind+" bounds.";
          if(!reason){
            if(isDiameter){
              if(floor!=null||max!=null)add("viaStyle",scope.scope,{diameterMin:floor,diameterMax:max});
              if(opt>0)add("viaStyle",scope.scope,{diameterPreferred:opt});
            }else{
              const Q=globalThis.AtriumDesignQueryRecord;
              const holes=scope.via?Q.create(Q.fromSelector(scope.scope).source.replace(/^object/,"via")):scope.scope;
              if(min!=null||max!=null)add("holeSize",holes,{min:min??0,max:max??null});
              if(opt>0)add("viaStyle",scope.scope,{holePreferred:opt});
              if(!scope.via&&max!=null)approximation="Native hole maximums use the minor diameter for slots.";
            }
          }
        }
        audit?.record("custom constraint",reason?"dropped":approximation?"approximated":"kept",c,null,reason??approximation);
        if(reason)notes.add(reason);
      }
    }
    if(!board)return;
    board.notes.push(...notes.list());
    if(!list.length&&minimumDiameter==null)return;
    if(minimumDiameter!=null)list.push(makeRule("KiCadBoardViaMinimum","KiCad board via diameter minimum","viaStyle",priority,
      {kind:"all"},{diameterMin:minimumDiameter}));
    // The source owns via limits. A stock drill minimum supplied while opening
    // board artwork is unrelated to the selected KiCad constraint.
    const previous=board.rules?.list??[];
    const existing=classRuleList(set);
    for(const rule of existing)if(rule.type==="viaStyle"||rule.type==="holeSize")rule.priority+=priority+1;
    board.rules=restoreRuleOrigins(R.normalize({...set,list:[...list,...existing]}),[...existing,...previous]);
  }

  // ------------------------------------------------------------ entry points
  function read(name, bytes, io) {
    const text = io.utf8(bytes), e = name.toLowerCase();
    if (e.endsWith(".kicad_pro")) return readProject(name, text, io.fidelity);
    if (e.endsWith(".kicad_dru")) return readCustomRules(name,text,io.fidelity);
    if (e.endsWith(".kicad_pcb") || /^\s*\(kicad_pcb/.test(text)) return readBoard(name, text, io.fidelity);
    return readSheet(name, text, io.fidelity);
  }
  function sheetGraph(docs) {
    const sch = docs.filter(d => d.kind === "schematic"), base = n => String(n || "").split(/[\\/]/).pop().toUpperCase();
    const byId = new Map(sch.map(d => [d.id, d])), byFile = new Map(), bySheet = new Map(), uses = new Map();
    for (const d of sch) {
      const name = base(d.sourceName);
      byFile.set(name, byFile.has(name) ? null : d);
    }
    for (const d of sch) for (const s of d.items) if (s.kind === "sheetsymbol") {
      const child = s.file && byFile.get(base(s.file));
      if (!s.sheet && child && child !== d) s.sheet = child.id;
      if (s.kicadUuid) bySheet.set(s.kicadUuid, bySheet.has(s.kicadUuid) ? null : {sym: s, doc: d});
      if (s.sheet) uses.set(s.sheet, (uses.get(s.sheet) || 0) + 1);
    }
    return {sch, byId, bySheet, uses};
  }

  // A child file can retain references for itself, other projects and old sheet placements.
  // In a single-placement hierarchy, only the complete root/sheet-symbol UUID path names
  // the selected instance. Repeated children keep their per-channel references below.
  function projectReferences(tree, projectName) {
    let roots = tree.sch.filter(d => d.kicadUuid && !tree.uses.has(d.id));
    if (roots.length > 1 && projectName) roots = roots.filter(d => F().stem(d.sourceName) === projectName);
    if (roots.length !== 1) return;
    const root = roots[0], queue = [root], paths = new Map([[root.id, "/" + root.kicadUuid]]);
    for (let n = 0; n < queue.length; n++) {
      const doc = queue[n], path = paths.get(doc.id);
      for (const item of doc.items) {
        if (item.kind === "part" && item.kicadPaths) {
          const matches = item.kicadPaths.filter(p => p.path === path && (!projectName || p.project === projectName));
          const first = matches[0];
          if (first?.reference && matches.every(p => p.reference === first.reference && p.unit === first.unit)) item.ref = first.reference;
        } else if (item.kind === "sheetsymbol" && tree.bySheet.get(item.kicadUuid)?.sym === item && tree.uses.get(item.sheet) === 1 && !paths.has(item.sheet)) {
          const child = tree.byId.get(item.sheet);
          if (child) { paths.set(child.id, path + "/" + item.kicadUuid); queue.push(child); }
        }
      }
    }
  }
  // Sheets used more than once (review finding 4). Every sheet symbol links to the one child
  // document, so Waffle's hierarchy instantiates it once per symbol: a multichannel design
  // (multichannel.js). Board footprints placed under a channel link to that channel's
  // instance (link@instanceId, sourceLink, channel), and each schematic part records the
  // reference KiCad gave it in every channel (instanceRefs, keyed by sheet-symbol id).
  function channels(docs, results, tree) {
    const {sch, bySheet, uses} = tree, roots = new Set(sch.filter(d => !uses.has(d.id)).map(d => d.kicadUuid).filter(Boolean));
    if (![...uses.values()].some(n => n > 1)) return;
    // A KiCad sheet path (sheet uuids below the root) -> {id, scope} of Waffle's instance.
    function instance(uuids) {
      let id = null, scope = "";
      for (const u of uuids) {
        const e = bySheet.get(u);
        if (!e) return null;
        id = (id ?? e.doc.id) + "/" + e.sym.id;
        if ((uses.get(e.sym.sheet) || 0) > 1) scope = id;
      }
      return id && scope ? {id, scope, sym: bySheet.get(uuids.at(-1)).sym} : null;
    }
    const sheetPath = path => { const segs = String(path).split("/").filter(Boolean); return roots.has(segs[0]) ? segs.slice(1) : segs; };
    const v6 = results.flatMap(r => r.kicadInstanceList || []);
    let channelParts = 0;
    for (const d of sch) {
      if (!((uses.get(d.id) || 0) > 1)) continue;
      for (const part of d.items.filter(i => i.kind === "part")) {
        const uuid = String(part.link).replace(/^kicad-/, ""), refs = {};
        const paths = part.kicadPaths || v6.filter(v => String(v.path).split("/").pop() === uuid).map(v => ({...v, path: String(v.path).split("/").slice(0, -1).join("/")}));
        for (const p of paths) { const inst = instance(sheetPath(p.path)); if (inst && p.reference) F().put(refs, inst.sym.id, p.reference); }
        if (Object.keys(refs).length) { part.instanceRefs = refs; channelParts++; }
      }
    }
    let linked = 0;
    for (const board of docs.filter(d => d.kind === "pcb")) for (const part of board.items.filter(i => i.kind === "part" && i.kicadPath)) {
      const inst = instance(String(part.kicadPath).split("/").filter(Boolean).slice(0, -1));
      if (!inst) continue;
      part.sourceLink = part.link; part.link = part.link + "@" + inst.id; part.channel = inst.scope; linked++;
    }
    const files = sch.filter(d => (uses.get(d.id) || 0) > 1).map(d => d.sourceName + " (" + uses.get(d.id) + " times)");
    const note = "Sheets used more than once import as channels (multichannel): " + files.join(", ") + ". " + channelParts + " part(s) keep KiCad's per-channel references in instanceRefs; " +
      linked + " footprint(s) link to their channel. Waffle names channel parts with the project's channel naming.";
    for (const d of docs) d.notes.push(note);
  }
  // Cross-file fixes once every file of a selection is read.
  function link(results, files = []) {
    const project = results.find(r => r.kicadProject)?.kicadProject;
    const evidence = project && projectReports.get(project);
    const docs = results.flatMap(r => (r.documents || []).filter(d => /\.kicad_(sch|pcb)$/i.test(d.sourceName || "")));
    const stamp=i=>(files[i]?.path??files[i]?.name??"").replace(/\.[^.]+$/,"");
    const boardsByName=new Map(), customByName=new Map();
    for(const [i,result] of results.entries()){
      const board=result.documents?.find(d=>d.kind==="pcb"&&docs.includes(d)), key=stamp(i);
      if(board&&key)boardsByName.set(key,boardsByName.has(key)?null:board);
      if(result.kicadRules){
        const sources=customByName.get(key)??[];
        sources.push(result.kicadRules);
        customByName.set(key,sources);
        delete result.kicadRules;
      }
    }
    // KiCad 6 keeps every sheet's references in the root sheet's symbol_instances.
    const refs = new Map();
    for (const r of results) for (const [uuid, v] of r.kicadInstances || []) refs.set(uuid, v);
    const schParts = docs.filter(d => d.kind === "schematic").flatMap(d => d.items.filter(i => i.kind === "part"));
    for (const p of schParts) {
      const v = refs.get(String(p.link).replace(/^kicad-/, ""));
      if (v?.reference && (/\?/.test(p.ref) || !p.ref)) p.ref = v.reference;
    }
    const tree = sheetGraph(docs);
    projectReferences(tree, project?.name);
    for (const doc of tree.sch) {
      const links = sheetLinks.get(doc);
      if (!links) continue;
      for (const {item, audit, ref} of links) audit.record("sheet-link", item.sheet ? "kept" : "dropped", ref, null,
        item.sheet ? undefined : "The selected files contain no unique child sheet matching the source reference.");
      sheetLinks.delete(doc);
    }
    // Units of one multi-unit symbol share the link of their footprint.
    const boardLinks = new Set(docs.filter(d => d.kind === "pcb").flatMap(d => d.items.filter(i => i.kind === "part").map(i => i.link)));
    const byRef = new Map();
    for (const p of schParts) { if (!byRef.has(p.ref)) byRef.set(p.ref, []); byRef.get(p.ref).push(p); }
    for (const [ref, group] of byRef) {
      if (group.length < 2 || /\?/.test(ref) || ref.startsWith("#")) continue;
      if (group.some(p => !p.unit) || new Set(group.map(p => p.unit)).size !== group.length) continue;
      const shared = group.find(p => boardLinks.has(p.link))?.link || group[0].link;
      for (const p of group) p.link = shared;
    }
    const pours = globalThis.AtriumPCBPours;
    const checkedFills = new Set(), verifiedFills = new Map();
    let definitions;
    // The board parser signs the source fill before the selected rule files are linked.
    function checkFillBeforeRules(board) {
      if (!pours || !board?.sourcePourSignature || board.pcbDrawing?.sourceFill !== true || checkedFills.has(board)) return;
      checkedFills.add(board);
      definitions ??= new Map(results.flatMap(r => r.library || []).map(def => [def.id, def]));
      if (board.sourcePourSignature === pours.signature(board, definitions)) verifiedFills.set(board, board.rules);
    }
    if (project) {
      for (const d of docs) d.sourceProject = project.name;
      const defaults = project.classes.Default || null;
      for (const board of docs.filter(d => d.kind === "pcb")) {
        const nets = new Set();
        for (const i of board.items) { if (i.net) nets.add(i.net); for (const n of Object.values(i.pinNets || {})) if (n) nets.add(n); }
        const overrides = F().dict(), members = F().dict(), patterns = project.patterns.slice(0, 1000), cost = {steps: 0, max: 5e7};
        let costly = false;
        if (defaults && evidence) evidence.classes.add("Default");
        for (const n of nets) {
          let cls = project.assignments[n], pattern;
          if (!cls && !costly) {
            try { pattern = patterns.find(p => F().wildcard(p.pattern, n, cost)); cls = pattern?.netclass; }
            catch (error) { if (!error.fatal) throw error; costly = true; board.notes.push(error.message + " Remaining nets use the Default class."); }
          }
          if (evidence && cls && project.classes[cls]) {
            evidence.classes.add(cls);
            if (pattern) evidence.patterns.add(pattern); else evidence.assignments.add(n);
          }
          if (cls && cls !== "Default" && project.classes[cls]) { overrides[n] = project.classes[cls]; (members[cls] ||= []).push(n); }
        }
        if (defaults || Object.keys(overrides).length) {
          checkFillBeforeRules(board);
          setClassRules(board,defaults,overrides,project.classes,members,evidence);
          classRecords(board, members);
          board.notes.push("Net classes became design rules: defaults from the Default class and " + Object.keys(overrides).length + " net override(s).");
        }
      }
    }
    const handled=new Set(), minimumDiameter=project?.minimumDiameter;
    for(const [key,sources] of customByName){
      const board=sources.length===1?boardsByName.get(key):null;
      checkFillBeforeRules(board);
      for(const source of sources)applyCustomRules(board,source,minimumDiameter);
      if(board)handled.add(board);
    }
    if(minimumDiameter!=null)for(const board of docs)if(board.kind==="pcb"&&!handled.has(board)){
      checkFillBeforeRules(board);
      applyCustomRules(board,null,minimumDiameter);
    }
    for (const [board, originalRules] of verifiedFills) if (board.rules !== originalRules)
      board.sourcePourSignature = pours.signature(board, definitions);
    for (const r of results) if (r.kicadProject) finishProjectReport(r.kicadProject, r.kicadProject === project && docs.some(d => d.kind === "pcb"));
    channels(docs, results, tree);
    for (const r of results) { delete r.kicadInstances; delete r.kicadInstanceList; }
    for (const d of docs) { delete d.kicadUuid; for (const i of d.items) { delete i.kicadPaths; delete i.kicadPath; delete i.kicadUuid; } }
  }
  return {read, link, readBoard, readSheet, readProject, sourceClassDefaults:doc=>F().sourceClassDefaults(doc), symbolGeometry, libProps, plain, observations, pendingObservations};
})();
