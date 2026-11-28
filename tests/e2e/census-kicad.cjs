"use strict";
// Census of KiCad boards (.kicad_pcb) and their project settings (.kicad_pro): see census.cjs.
//
// census() lists every object and every field the files hold, read with the oracle's
// s-expression parser (kicad-oracle.cjs), which shares no code with app/formats/import-kicad.js.
// Nothing here requires or calls app code. An object is a list token (footprint, pad, segment,
// zone...); its kind is the token path ("footprint/pad", "zone/filled_polygon",
// "setup/stackup/layer"). Its fields are its positional atoms (a pad's number, type and shape)
// and its child lists, nested lists flattened with dots ("fill.thermal_gap", "effects.font.size").
// A .kicad_pro is JSON: every object is an entry ("kicad_pro/net_settings/classes"), its scalar
// and list members are fields.
//
// account() looks each one up in the imported model. KiCad and Waffle are both millimetres with
// Y down; KiCad angles turn counter-clockwise on screen and Waffle's the other way, so they are
// negated. Every field is held (the model has it and the value matches), reported (the Import
// Report or an import note says it was approximated or dropped), outside (the OUTSIDE reasons
// below) or lost. A field is held only where this file has a check for it: a field with no check
// cannot pass by default.
//
// Report lookup uses the Import Report's source addresses (import report rows name a record by
// "<token> <uuid> #<position>" below its parent), computed here from the file itself. A dropped
// record reports everything below it. An approximated record reports a field only when its reason
// names that field (a written REASON pattern below, or the field's own name in the reason text).
const {parse, circle} = require("./kicad-oracle.cjs");
const {references} = require("./census-report.cjs");

const FIXTURES = [
  {id:"kicad-demo", files:["tests/fixtures/import/demo.kicad_pcb", "tests/fixtures/import/demo.kicad_pro"]},
  {id:"kicad-census", files:["tests/fixtures/census/kicad/census.kicad_pcb", "tests/fixtures/census/kicad/census.kicad_pro"]}
];

// ------------------------------------------------------------------ census

const isL = Array.isArray;
const text = bytes => new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
// Positional atoms by kind; any further bare word is a flag (KiCad 6–7 "locked", "hide").
const POSITIONAL = {
  footprint:["name"], module:["name"], "footprint/pad":["number", "type", "shape"], "module/pad":["number", "type", "shape"],
  "footprint/property":["name", "value"], "footprint/fp_text":["type", "text"], "footprint/fp_text_box":["text"], "footprint/model":["path"],
  "footprint/group":["name"], gr_text:["text"], gr_text_box:["text"], group:["name"], net:["number", "name"], net_class:["name", "description"],
  "layers/layer":["ordinal", "name", "type", "user_name"], "setup/stackup/layer":["name"], target:["shape"], paper:["size", "width", "height"]
};
// Child tokens that are objects of their own (everything else is a field of its parent).
const OBJECTS = {
  footprint:new Set(["property", "fp_text", "fp_text_box", "fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve", "pad", "zone",
    "model", "group", "dimension", "image", "table"]),
  zone:new Set(["polygon", "filled_polygon", "filled_segments"]),
  setup:new Set(["stackup", "pcbplotparams"]),
  "setup/stackup":new Set(["layer"])
};
OBJECTS.module = OBJECTS.footprint;
OBJECTS["footprint/zone"] = OBJECTS["module/zone"] = OBJECTS.zone;
const HEADER = new Set(["version", "generator", "generator_version", "host"]);
// Lists kept whole as one field value: point lists and custom-pad primitive drawings.
const LEAF = new Set(["pts", "primitives", "data"]);
const raw = n => isL(n) ? n.map(raw) : n;

// Import Report addresses: "<token> <uuid or name> #<position in the parent list>".
function address(prefix, node, i) {
  const head = typeof node[0] === "string" ? node[0].slice(0, 48) : "record";
  const id = (node.find(c => isL(c) && (c[0] === "uuid" || c[0] === "tstamp")) || [])[1];
  const label = typeof id === "string" ? id : ["footprint", "module", "pad", "symbol", "property"].includes(head) && typeof node[1] === "string" ? node[1] : "";
  return (prefix ? prefix + "/" : "") + head + (label ? " " + String(label).slice(0, 72) : "") + " #" + i;
}

function flatten(fields, addr, name, node, at, kind) {
  const atoms = node.slice(1).filter(c => !isL(c)), lists = node.slice(1).filter(isL);
  const put = (key, value) => { let k = key, n = 2; while (Object.hasOwn(fields, k)) k = key + "#" + n++; fields[k] = value; if (at) addr[k] = at; };
  if (kind === "title_block" && name === "comment") return put("comment." + atoms[0], atoms[1]);
  if (LEAF.has(name.split(".").pop())) return put(name, raw(node.slice(1)));
  if (name === "attr" && /^(footprint|module)$/.test(kind)) { for (const a of atoms) put("attr." + a, true); }
  else if (name === "layer" && atoms.length > 1) { put("layer", atoms[0]); for (const a of atoms.slice(1)) put("layer." + a, true); }
  else if (!lists.length) put(name, atoms.length === 0 ? true : atoms.length === 1 ? atoms[0] : atoms);
  else if (atoms.length) put(name, atoms.length === 1 ? atoms[0] : atoms);
  for (const l of lists) {
    const sub = name + "." + l[0];
    flatten(fields, addr, sub, l, at, kind);
  }
}

function boardEntries(file, root) {
  const out = [];
  const head = {kind:"kicad_pcb", id:"header", fields:{}};
  Object.defineProperties(head, {file:{value:file}, address:{value:null}, ancestors:{value:[]}, addr:{value:{}}, node:{value:root}});
  out.push(head);
  function walk(node, kind, i, prefix, parent) {
    // A layer-table row has no token: (0 "F.Cu" signal) starts with its ordinal.
    const addr = {}, fields = {}, pos = POSITIONAL[kind] || [], atoms = (kind === "layers/layer" ? node : node.slice(1)).filter(c => !isL(c));
    const own = prefix === null ? null : address(prefix, node, i);
    atoms.forEach((a, k) => {
      if (k < pos.length) fields[pos[k]] = a;
      else if (kind === "via" && (a === "blind" || a === "micro" || a === "through")) fields.type = a;
      else fields[/^[a-z_]+$/.test(a) ? a : "atom" + k] = /^[a-z_]+$/.test(a) ? true : a;
    });
    const e = {kind, id:"", fields};
    const childPrefix = kind === "setup" || kind === "layers" || kind === "setup/stackup" ? kind : own;
    Object.defineProperties(e, {file:{value:file}, address:{value:own}, addr:{value:addr}, node:{value:node}, parent:{value:parent},
      ancestors:{value:parent ? [...parent.ancestors, parent.address].filter(Boolean) : []}});
    out.push(e);
    const subs = kind === "layers" ? null : OBJECTS[kind];
    node.forEach((c, k) => {
      if (k === 0 || !isL(c)) return;
      if (kind === "layers") walk(c, "layers/layer", k, "layers", e);
      else if (subs && subs.has(c[0])) walk(c, kind + "/" + c[0], k, childPrefix, e);
      else flatten(fields, addr, String(c[0]), c, address(childPrefix, c, k), kind);
    });
    e.id = entryId(e, i);
    return e;
  }
  root.forEach((c, i) => {
    if (i === 0 || !isL(c)) return;
    if (HEADER.has(c[0])) { head.fields[c[0]] = c[1]; head.addr[c[0]] = address("", c, i); return; }
    walk(c, String(c[0]), i, "", null);
  });
  return out;
}
function entryId(e, i) {
  const f = e.fields, uuid = f.uuid || f.tstamp;
  if (/^(footprint|module)$/.test(e.kind)) {
    const ref = e.node.find(c => isL(c) && (c[0] === "property" && c[1] === "Reference" || c[0] === "fp_text" && c[1] === "reference"));
    return ref ? String(ref[2]) : uuid || "#" + i;
  }
  const owner = e.parent && e.parent.id && e.parent.kind !== "setup" && e.parent.kind !== "setup/stackup" ? e.parent.id + "/" : "";
  if (/\/pad$/.test(e.kind)) return owner + "pad " + (f.number || "#" + i);
  if (/\/property$/.test(e.kind)) return owner + f.name;
  if (e.kind === "net") return f.name || "net 0";
  if (e.kind === "layers/layer" || e.kind === "setup/stackup/layer") return f.name;
  return owner + (uuid || e.kind.split("/").pop() + " #" + i);
}

function projectEntries(file, json) {
  const out = [];
  function walk(value, path, kind, parent) {
    const fields = {}, addr = {};
    const e = {kind, id:path || "project", fields};
    Object.defineProperties(e, {file:{value:file}, address:{value:path || null}, addr:{value:addr}, node:{value:value}, parent:{value:parent},
      ancestors:{value:path ? path.split("/").slice(0, -1).map((_, k, a) => a.slice(0, k + 1).join("/")) : []}});
    out.push(e);
    for (const [key, v] of Object.entries(value)) {
      const p = (path ? path + "/" : "") + key;
      if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p, kind + "/" + key, e);
      else if (Array.isArray(v) && v.some(x => x && typeof x === "object" && !Array.isArray(x)))
        v.forEach((x, k) => walk(x, p + "/" + k, kind + "/" + key, e));
      else { fields[key] = v; addr[key] = p; }
    }
  }
  walk(json, "", "kicad_pro", null);
  return out;
}

function census(files) {
  const out = [];
  for (const f of files) {
    const name = f.name.toLowerCase();
    if (name.endsWith(".kicad_pcb")) {
      const root = parse(text(f.bytes));
      if (root[0] !== "kicad_pcb") throw Error(f.name + " is not a KiCad board");
      out.push(...boardEntries(f.name, root));
    } else if (name.endsWith(".kicad_pro")) out.push(...projectEntries(f.name, JSON.parse(text(f.bytes))));
  }
  return out;
}

// ------------------------------------------------------------------ the imported model

const ESC = {dblquote:'"', quote:"'", lt:"<", gt:">", backslash:"\\", slash:"/", bar:"|", comma:",", colon:":", space:" ", dollar:"$", tab:"\t", return:"\n", brace:"{"};
const unescape = s => String(s ?? "").replace(/\{(dblquote|quote|lt|gt|backslash|slash|bar|comma|colon|space|dollar|tab|return|brace)\}/g, (_, k) => ESC[k]);
const N = v => Number(Array.isArray(v) ? v[0] : v);
const near = (a, b, tol = 1e-3) => Number.isFinite(+a) && Number.isFinite(+b) && Math.abs(a - b) <= tol;
const same = (p, q, tol = 1e-3) => !!p && !!q && near(p[0], q[0], tol) && near(p[1], q[1], tol);
const angle = (a, b) => { const d = (((a - b) % 360) + 540) % 360 - 180; return Math.abs(d) < 1e-3; };
const xy = v => Array.isArray(v) ? [+v[0], +v[1]] : null;
const yes = v => v === true || v === "yes";
const pointsOf = pts => (pts || []).filter(p => isL(p) && p[0] === "xy").map(p => [+p[1], +p[2]]);
const copperName = l => l === "F.Cu" ? "Top" : l === "B.Cu" ? "Bottom" : /^In(\d+)\.Cu$/.test(l || "") ? "Inner " + /\d+/.exec(l)[0] : null;
// A footprint-local point placed on the board (KiCad's counter-clockwise angle, Y down).
function place(p, at) {
  const a = (+at[2] || 0) * Math.PI / 180, c = Math.cos(a), s = Math.sin(a);
  return [+at[0] + p[0] * c + p[1] * s, +at[1] - p[0] * s + p[1] * c];
}
const onSegment = (p, s) => {
  if (s.kind === "line") {
    const [ax, ay] = s.a, [bx, by] = s.b, l2 = (bx - ax) ** 2 + (by - ay) ** 2;
    const t = l2 ? Math.max(0, Math.min(1, ((p[0] - ax) * (bx - ax) + (p[1] - ay) * (by - ay)) / l2)) : 0;
    return Math.hypot(p[0] - ax - t * (bx - ax), p[1] - ay - t * (by - ay)) < 2e-3;
  }
  return s.kind === "arc" && Math.abs(Math.hypot(p[0] - s.c[0], p[1] - s.c[1]) - s.r) < 2e-3;
};

function context(entries, imported) {
  const model = imported.model, report = imported.report, prov = imported.provenance || {};
  const pcb = model.documents.filter(d => d.kind === "pcb");
  const byId = new Map(pcb.flatMap(d => d.items.map(i => [i.id, i])));
  const source = new Map();
  for (const f of prov.fields || []) if (f.type === "item" && f.values?.kicadSourceId && byId.has(f.id)) source.set(f.values.kicadSourceId, byId.get(f.id));
  const docSource = new Map((prov.fields || []).filter(f => f.type === "document").map(f => [f.id, f.values || {}]));
  const refs = new Map();
  for (const k of report.kinds || []) for (const r of references(k)) {
    const key = r.file + "\0" + r.object;
    if (!refs.has(key)) refs.set(key, []);
    refs.get(key).push({...r, kind:k.kind});
  }
  const notes = new Map();
  for (const n of [...(model.importNotes || [])]) {
    const m = /^(.+?) — (.*)$/.exec(n);
    if (m) (notes.get(m[1]) || notes.set(m[1], []).get(m[1])).push(m[2]);
  }
  for (const d of pcb) (notes.get(d.sourceName) || notes.set(d.sourceName, []).get(d.sourceName)).push(...(d.notes || []));
  const nets = new Map();
  for (const e of entries) if (e.kind === "net") nets.set(e.file + "\0" + e.fields.number, unescape(e.fields.name ?? ""));
  return {model, pcb, source, refs, notes, nets, docSource, defs:new Map(model.library.map(d => [d.id, d])), used:new Set(),
    doc:file => pcb.find(d => d.sourceName === file) || pcb[0], entries, layers:new Map()};
}
const netName = (ctx, e, v) => {
  if (v == null) return "";
  if (Array.isArray(v)) return unescape(v[1] ?? "");
  return ctx.nets.get(e.file + "\0" + v) ?? unescape(v);
};
const boardNet = n => /^unconnected-\(/.test(n) ? "" : n;
// The record each graphic, label and zone landed in has no source identity: match its geometry
// once and claim it, so two source objects cannot both find one model object.
function claim(ctx, list, test) {
  const hit = list.find(x => !ctx.used.has(x) && test(x));
  if (hit) ctx.used.add(hit);
  return hit || null;
}
const footprintOf = e => { let p = e.parent; while (p && !/^(footprint|module)$/.test(p.kind)) p = p.parent; return p; };

// ------------------------------------------------------------------ what each field must become

// Each kind: locate(e, ctx) -> the model object or null; fields: name -> {held(v, t, e, ctx),
// outside: reason, reason: pattern an approximated parent record must match, note: pattern an
// import note must match}. "a.*" covers every field below a. layer(e, t) returns the [scope,
// Waffle layer] that names the source layer in the model, checked for one-to-one use board-wide.
const ID = "Identity token: links this record across file revisions; it carries no design value.";
const HATCH = "Display style of the zone outline in the editor (edge or full hatching of the outline), not the copper fill.";
const EDGE_STROKE = "The board edge is the centre line of the Edge.Cuts drawing; its drawing width, dash style and fill do not change the board shape.";
const FORMAT = "File-format bookkeeping: the format revision and the program that wrote the file.";
const SHEET_CACHE = "Copy of the schematic sheet name and file; KiCad rewrites it from the schematic on every board update.";
const ISLAND = "Marker the fill computation writes on its own output (this ring is an island); it is rebuilt with the fill.";
const LEGACY_TD = "Format-conversion marker saying whether teardrops in this file are legacy track shapes; it holds no design value.";
// Waffle keep-outs block via, track, copper (pour), SMD pad and through pad objects (a 5-bit
// mask; no mask blocks all five). KiCad's footprint restriction has no Waffle counterpart.
const KEEPOUT = {vias:[1], tracks:[2], copperpour:[4], pads:[8, 16]};
function keepoutHeld(t, what, v) {
  if (t.kind !== "graphic" || !KEEPOUT[what]) return false;
  const blocks = bit => t.keepoutRestrictions == null || !!(t.keepoutRestrictions & bit);
  return KEEPOUT[what].every(bit => blocks(bit) === (v === "not_allowed"));
}

const at = (pos, ang) => ({held:(v, t, e) => {
  const p = xy(v);
  return same(p, pos(t, e)) && (ang === undefined || angle(ang(t, e), -(+v[2] || 0) + (ang.base ? ang.base(t, e) : 0)));
}});
const num = get => ({held:(v, t, e, ctx) => near(get(t, e, ctx), N(v))});
const eq = get => ({held:(v, t, e, ctx) => get(t, e, ctx) === v});
const flagHeld = get => ({held:(v, t, e, ctx) => !!get(t, e, ctx) === yes(v)});
const layerField = {held:(v, t, e, ctx) => layerOk(ctx, e, t, v)};
const uuid = {outside:ID};
const LOCK = /lock state/i;
const locked = {held:(v, t) => !!t?.locked === yes(v), reason:LOCK};

// A technical layer is held when no other source layer lands on the same model layer, so the
// model can still tell them apart (one source layer may use several, as F.Fab does).
function layerOk(ctx, e, t, v) {
  const w = layerOf(e, t);
  if (w == null) return false;
  const cu = copperName(v);
  if (cu) return w === cu;
  if (!ctx.layers.get(v)?.has(w)) return false;
  for (const [k, s] of ctx.layers) if (k !== v && s.has(w)) return false;
  return true;
}
// Footprint drawings on a fabrication layer become the package outline, which has no layer.
const layerOf = (e, t) => !t ? null : /^(footprint|module)\//.test(e.kind) && !/\/zone/.test(e.kind) ? t.layer || t.style : t.layer;

// Board graphics: the record the importer wrote for one drawing, by geometry.
function graphicTest(e, list) {
  const f = e.fields, g = e.kind.split("/").pop().replace(/^(fp|gr)_/, "");
  const P = t => t.points || [];
  if (g === "line") return t => P(t).length === 2 && same(P(t)[0], xy(f.start)) && same(P(t)[1], xy(f.end));
  if (g === "rect") { const a = xy(f.start), b = xy(f.end); return t => t.closed && [a, [b[0], a[1]], b, [a[0], b[1]]].every(c => P(t).some(p => same(p, c))); }
  if (g === "circle") {
    const c = xy(f.center), r = Math.hypot(xy(f.end)[0] - c[0], xy(f.end)[1] - c[1]);
    return t => t.kind === "circle" ? same([t.x, t.y], c) && near(t.r, r) : P(t).length > 8 && P(t).every(p => near(Math.hypot(p[0] - c[0], p[1] - c[1]), r, 2e-3));
  }
  if (g === "arc") return t => P(t).length > 2 && same(P(t)[0], xy(f.start)) && same(P(t).at(-1), xy(f.end));
  if (g === "poly") { const pts = pointsOf(f.pts); return t => P(t).length >= pts.length && pts.every((p, k) => same(P(t)[k], p)); }
  if (g === "curve") { const pts = pointsOf(f.pts); return t => P(t).length > 4 && same(P(t)[0], pts[0]) && same(P(t).at(-1), pts.at(-1)); }
  return () => false;
}
function edgeHeld(e, ctx, map = p => p) {
  const shape = ctx.doc(e.file).boardShape;
  if (!shape) return null;
  const segs = [...shape.contour, ...(shape.cutouts || []).flat()], f = e.fields, g = e.kind.split("/").pop().replace(/^(fp|gr)_/, "");
  let pts;
  if (g === "line") pts = [xy(f.start), xy(f.end)];
  else if (g === "rect") { const a = xy(f.start), b = xy(f.end); pts = [a, [b[0], a[1]], b, [a[0], b[1]]]; }
  else if (g === "circle") { const c = xy(f.center), r = Math.hypot(xy(f.end)[0] - c[0], xy(f.end)[1] - c[1]); pts = [0, 1, 2, 3].map(k => [c[0] + r * Math.cos(k * Math.PI / 2), c[1] + r * Math.sin(k * Math.PI / 2)]); }
  else if (g === "arc") pts = [xy(f.start), xy(f.mid), xy(f.end)];
  else if (g === "poly" || g === "curve") pts = pointsOf(f.pts);
  return pts && pts.every(p => segs.some(s => onSegment(map(p), s))) ? shape : null;
}

const GRAPHIC = {
  locate(e, ctx) {
    if (e.fields.layer === "Edge.Cuts") return edgeHeld(e, ctx);
    const d = ctx.doc(e.file);
    return claim(ctx, d.items.filter(i => i.kind === "graphic" || i.kind === "track"), graphicTest(e));
  },
  fields:{
    start:{held:(v, t) => !!t}, end:{held:(v, t) => !!t}, mid:{held:(v, t) => !!t}, center:{held:(v, t) => !!t}, pts:{held:(v, t) => !!t},
    layer:{held:(v, t, e, ctx) => v === "Edge.Cuts" ? !!t?.contour : layerOk(ctx, e, t, v)},
    "stroke.width":{held:(v, t, e) => e.fields.layer !== "Edge.Cuts" && near(t.width, N(v)), outside:e => e.fields.layer === "Edge.Cuts" && EDGE_STROKE},
    "stroke.type":{held:(v, t, e) => (v === "solid" || v === "default") && !t.dash && !t.lineStyle, outside:e => e.fields.layer === "Edge.Cuts" && EDGE_STROKE},
    fill:{held:(v, t, e) => e.fields.layer !== "Edge.Cuts" && !!t.fill === (v === "solid" || v === "yes"), outside:e => e.fields.layer === "Edge.Cuts" && EDGE_STROKE},
    width:{held:(v, t) => near(t.width, N(v))},
    net:{held:(v, t, e, ctx) => (t.net || "") === boardNet(netName(ctx, e, v))},
    locked, uuid
  }
};
const FP_GRAPHIC = {
  locate(e, ctx) {
    const fp = footprintOf(e), part = fp && ctx.target.get(fp);
    if (!part) return null;
    if (e.fields.layer === "Edge.Cuts") return edgeHeld(e, ctx, p => place(p, fp.fields.at));
    const def = ctx.defs.get(part.def);
    return claim(ctx, def?.footprint?.shapes || [], graphicTest(e));
  },
  fields:{...GRAPHIC.fields,
    layer:{held:(v, t, e, ctx) => v === "Edge.Cuts" ? !!t?.contour : layerOk(ctx, e, t, v)}}
};

// Footprint text and fields (Reference, Value and user fields), by placement.
const TEXT = {
  "effects.font.size":{held:(v, t) => near(t.size, +v[0]) && (+v[1] === +v[0] || near(t.fontWidth, +v[1]))},
  "effects.font.thickness":{held:(v, t) => near(t.width, N(v))},
  "effects.font.bold":flagHeld(t => t.bold), "effects.font.italic":flagHeld(t => t.italic),
  "effects.font.face":{held:(v, t) => v === "KiCad Font" ? !t.family : t.family === v},
  "effects.justify":{held:(v, t) => {
    const j = [].concat(v), h = j.includes("left") ? "left" : j.includes("right") ? "right" : "center", vv = j.includes("top") ? "top" : j.includes("bottom") ? "bottom" : "middle";
    return t.justify === (vv === "middle" && h === "center" ? "center" : vv + "-" + h) && !!t.mirrored === j.includes("mirror");
  }},
  "effects.hide":{held:(v, t) => t.hidden === yes(v)}, hide:{held:(v, t) => t.hidden === yes(v)},
  unlocked:{held:(v, t) => t.upright === !yes(v)},
  layer:layerField, uuid:{outside:ID}
};
function fieldLabel(e, ctx) {
  const fp = footprintOf(e), part = fp && ctx.target.get(fp);
  if (!part) return null;
  const f = e.fields, name = e.kind.endsWith("/property") ? f.name : f.type === "reference" ? "Reference" : f.type === "value" ? "Value" : null;
  const ka = +fp.fields.at?.[2] || 0, p = xy(f.at);
  if (name === "Reference" || name === "Value") {
    const field = name === "Reference" ? "ref" : "value";
    const hidden = yes(f.hide) || f["effects.hide"] === true;
    const label = [...(part.boardLabels || []), ...(part.hiddenBoardLabels || [])].find(l => l.field === field);
    return {kind:"field", part, name, value:name === "Reference" ? part.ref : part.value, label, shown:name === "Reference" ? part.showRef !== false : part.showValue !== false,
      ...(label || {}), hidden:!(name === "Reference" ? part.showRef !== false : part.showValue !== false), at:label?.at, ka, hiddenSource:hidden};
  }
  const def = ctx.defs.get(part.def), txt = String(f.value ?? f.text ?? "");
  const want = txt === "${REFERENCE}" ? ".Designator" : txt === "${VALUE}" ? ".Comment" : txt.replace(/\$\{REFERENCE\}/g, part.ref);
  const shape = p && claim(ctx, (def?.footprint?.shapes || []).filter(s => s.kind === "text"), s => s.text === want && same([s.x, s.y], p));
  const param = e.kind.endsWith("/property") ? part.parameters?.[name] : undefined;
  if (!shape && param === undefined) return null;
  return {kind:"text", part, name, param, shape, ...(shape || {}), at:shape ? [shape.x, shape.y] : null, hidden:!shape, ka};
}
const FIELD_TEXT = {
  locate:fieldLabel,
  fields:{...TEXT,
    name:{held:(v, t) => t.kind === "field" || t.param !== undefined},
    value:{held:(v, t) => t.kind === "field" ? t.value === v : t.param === v},
    text:{held:(v, t) => !!t.shape},
    type:{held:(v, t) => !!t},
    at:{held:(v, t) => same(t.at, xy(v)) && angle(t.angle, (t.ka || 0) - (+v[2] || 0))},
    hide:{held:(v, t) => t.hidden === yes(v)},
    "effects.font.size":{held:(v, t) => near(t.size, +v[0]) && (+v[1] === +v[0] || near(t.fontWidth, +v[1]))}
  }
};

// Pads: the footprint definition's pad at the same local position and number.
function padTarget(e, ctx) {
  const fp = footprintOf(e), part = fp && ctx.target.get(fp);
  const def = part && ctx.defs.get(part.def), p = xy(e.fields.at);
  return def && p ? claim(ctx, def.footprint?.pads || [], q => same([q.x, q.y], p) && (q.number ?? "") === (e.fields.type === "np_thru_hole" ? "" : e.fields.number ?? "")) : null;
}
const sizeOf = e => (e.fields.size || []).map(Number);
const margin = (e, own, fpKey, boardKey, ctx) => {
  const fp = footprintOf(e), pick = (o, k) => o && o[k] !== undefined && (+N(o[k]) !== 0 || versionOf(e, ctx) >= 20241229) ? +N(o[k]) : undefined;
  const setup = ctx.entries.find(x => x.kind === "setup" && x.file === e.file);
  for (const k of [].concat(own)) { const v = pick(e.fields, k); if (v !== undefined) return v; }
  for (const k of [].concat(fpKey)) { const v = pick(fp?.fields, k); if (v !== undefined) return v; }
  const b = setup?.fields[boardKey];
  return b === undefined ? undefined : +N(b);
};
const versionOf = (e, ctx) => +(ctx.entries.find(x => x.kind === "kicad_pcb" && x.file === e.file)?.fields.version || 0);
function pasteHeld(t, e, ctx) {
  if (t.noPaste) return false;
  const paste = margin(e, "solder_paste_margin", "solder_paste_margin", "pad_to_paste_clearance", ctx);
  const ratio = margin(e, ["solder_paste_margin_ratio", "solder_paste_ratio"], ["solder_paste_margin_ratio", "solder_paste_ratio"], "pad_to_paste_clearance_ratio", ctx);
  const [w, h] = sizeOf(e);
  return near(t.pasteExpansion, (paste ?? 0) + (ratio ?? 0) * Math.min(w, h), 1e-5);
}
const corners = (w, h) => ({top_left:[-w / 2, -h / 2], top_right:[w / 2, -h / 2], bottom_right:[w / 2, h / 2], bottom_left:[-w / 2, h / 2]});
function chamferHeld(t, e) {
  const [w, h] = sizeOf(e), c = N(e.fields.chamfer_ratio ?? 0.2) * Math.min(w, h), cut = [].concat(e.fields.chamfer || []);
  if (t.shape !== "custom" || !t.poly) return false;
  for (const [name, [x, y]] of Object.entries(corners(w, h))) {
    const sx = -Math.sign(x), sy = -Math.sign(y), hit = q => t.poly.some(p => same(p, q, 1e-4));
    if (cut.includes(name) ? !(hit([x + sx * c, y]) && hit([x, y + sy * c])) : !hit([x, y])) return false;
  }
  return true;
}
function trapezoidHeld(t, e) {
  const [w, h] = sizeOf(e), d = (e.fields.rect_delta || [0, 0]).map(Number), dx = d[0] / 2, dy = d[1] / 2;
  // The documented trapezoid: rect_delta widens one pair of opposite edges and narrows the other.
  const want = [[-w / 2 - dy, h / 2 + dx], [w / 2 + dy, h / 2 - dx], [w / 2 - dy, -h / 2 + dx], [-w / 2 + dy, -h / 2 - dx]];
  return t.shape === "custom" && t.poly?.length === 4 && want.every(q => t.poly.some(p => same(p, q, 1e-4)));
}
function padLayersHeld(v, t, e) {
  const layers = [].concat(v), type = e.fields.type, cu = layers.filter(l => /\.Cu$/.test(l));
  const has = film => side => layers.includes("*." + film) || layers.includes(side + "." + film);
  if (type === "thru_hole" || type === "np_thru_hole") {
    if (t.layer !== "Multi") return false;
    return !!t.tent?.top === !has("Mask")("F") && !!t.tent?.bottom === !has("Mask")("B");
  }
  if (!cu.length) {
    const films = {"F.Paste":"Top paste", "B.Paste":"Bottom paste", "F.Mask":"Top mask", "B.Mask":"Bottom mask"};
    return layers.length === 1 && t.layer === films[layers[0]];
  }
  if (cu.length !== 1 || t.layer !== copperName(cu[0])) return false;
  const side = cu[0] === "B.Cu" ? "B" : "F";
  return !!t.tent?.[side === "F" ? "top" : "bottom"] === !has("Mask")(side) && !!t.noPaste === !has("Paste")(side);
}
const PAD = {
  locate:padTarget,
  fields:{
    number:{held:(v, t, e) => (t.number ?? "") === (e.fields.type === "np_thru_hole" ? "" : v), outside:e => e.fields.type === "np_thru_hole" && e.fields.number === "" && NP_NUMBER},
    type:{held:(v, t) => v === "smd" ? t.layer !== "Multi" : v === "thru_hole" ? t.layer === "Multi" && t.plated !== false : v === "np_thru_hole" ? t.plated === false : false},
    shape:{held:(v, t, e) => {
      const [w, h] = sizeOf(e);
      if (v === "circle") return t.shape === "round";
      if (v === "rect") return t.shape === "rect";
      if (v === "oval") return t.shape === "oval";  // both are a capsule: a rectangle with its short sides rounded
      if (v === "roundrect") return t.shape === "roundrect" || +N(e.fields.roundrect_rratio ?? 0.25) === 0 && t.shape === "rect";
      if (v === "chamfered_rect") return chamferHeld(t, e);
      if (v === "trapezoid") return trapezoidHeld(t, e);
      if (v === "custom") return t.shape === "custom";
      return false;
    }, reason:/capsule|convex hull/i},
    at:{held:(v, t, e) => same([t.x, t.y], xy(v)) && angle(t.angle ?? 0, (+footprintOf(e).fields.at?.[2] || 0) - (+v[2] || 0))},
    size:{held:(v, t, e) => {
      const [w, h] = v.map(Number), s = e.fields.shape;
      if (s === "trapezoid") return trapezoidHeld(t, e);
      if (s === "custom") return t.shape === "custom";
      if (s === "chamfered_rect") return chamferHeld(t, e);
      const drill = t.drill || 0;
      return near(t.w, Math.max(w, drill > Math.min(w, h) ? drill : 0)) && near(t.h, Math.max(h, drill > Math.min(w, h) ? drill : 0));
    }},
    drill:{held:(v, t) => {
      const a = [].concat(v), oval = a[0] === "oval", dx = +(oval ? a[1] : a[0]), dy = oval && a[2] !== undefined ? +a[2] : dx;
      return near(t.drill, Math.min(dx, dy)) && (Math.max(dx, dy) > Math.min(dx, dy) ? near(t.slotLength, Math.max(dx, dy)) && !!t.slotAngle === dy > dx : !t.slotLength);
    }},
    "drill.offset":{held:(v, t) => v.every(x => +x === 0) || same(t.offset, xy(v)), note:/copper offsets were ignored/i, reason:/copper offsets/i},
    layers:{held:padLayersHeld},
    net:{held:(v, t, e, ctx) => {
      const part = ctx.target.get(footprintOf(e)), n = boardNet(netName(ctx, e, v));
      return (part?.pinNets?.[e.fields.number] ?? "") === n || !e.fields.number && !n;
    }},
    roundrect_rratio:{held:(v, t, e) => +v === 0 ? !t.roundrectRadiusRatio : near(t.roundrectRadiusRatio, Math.min(0.5, +v), 1e-6)},
    chamfer_ratio:{held:(v, t, e) => chamferHeld(t, e)}, chamfer:{held:(v, t, e) => chamferHeld(t, e)},
    rect_delta:{held:(v, t, e) => trapezoidHeld(t, e)},
    "options.anchor":{held:(v, t) => t.shape === "custom"},
    primitives:{held:(v, t, e) => {
      if (t.shape !== "custom") return false;
      const polys = v.filter(p => isL(p) && p[0] === "gr_poly");
      if (v.length !== 1 || polys.length !== 1) return false;
      const pts = pointsOf(polys[0].find(c => isL(c) && c[0] === "pts")?.slice(1));
      return pts.length === t.poly.length && pts.every(p => t.poly.some(q => same(p, q, 1e-4)));
    }, reason:/convex hull/i, note:/convex hull/i},
    solder_mask_margin:{held:(v, t) => near(t.maskExpansion, N(v), 1e-6)},
    solder_paste_margin:{held:(v, t, e, ctx) => pasteHeld(t, e, ctx)},
    solder_paste_margin_ratio:{held:(v, t, e, ctx) => pasteHeld(t, e, ctx)},
    solder_paste_ratio:{held:(v, t, e, ctx) => pasteHeld(t, e, ctx)},
    locked:{held:(v, t) => !!t.locked === yes(v)},
    uuid:{outside:ID}
  }
};
const NP_NUMBER = "A non-plated hole has no pad number; KiCad writes an empty one.";

// Zones: one polygon pour (or keep-out area) per copper layer, by outline.
function zoneTargets(e, ctx) {
  const outline = ctx.entries.find(x => x.parent === e && /\/polygon$/.test(x.kind));
  const pts = pointsOf(outline?.fields.pts);
  if (!pts.length) return null;
  const d = ctx.doc(e.file), match = t => (t.points || []).length >= pts.length && pts.every((p, k) => same(t.points[k], p));
  const keep = e.fields["keepout.tracks"] !== undefined || Object.keys(e.fields).some(k => k.startsWith("keepout"));
  const list = d.items.filter(i => keep ? i.kind === "graphic" && (i.keepout || i.layer === "Keepout") : i.kind === "polygon").filter(i => !ctx.used.has(i) && match(i));
  for (const t of list) ctx.used.add(t);
  return list.length ? list : null;
}
const every = test => (v, ts, e, ctx) => ts.every(t => test(v, t, e, ctx));
const zoneLayers = e => [].concat(e.fields.layers ?? e.fields.layer ?? []);
function zoneCopper(e, ctx) {
  const table = ctx.entries.filter(x => x.kind === "layers/layer" && x.file === e.file && /\.Cu$/.test(x.fields.name)).map(x => x.fields.name);
  return [...new Set(zoneLayers(e).flatMap(l => l === "*.Cu" ? table : l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : [l]).filter(l => /\.Cu$/.test(l)))].map(copperName);
}
const RULE_AREA = "A rule area (keep-out) has no copper fill or pad connection; KiCad writes its default fill settings on it anyway.";
const ruleArea = e => Object.keys(e.fields).some(k => k.startsWith("keepout")) && RULE_AREA;
const fillOf = (ts, ctx, e) => (ctx.doc(e.file).pcbDrawing?.pours || []).filter(p => ts.some(t => t.id === p.polygon));
const ZONE = {
  locate:zoneTargets,
  fields:{
    net:{held:every((v, t, e, ctx) => (t.net || "") === boardNet(netName(ctx, e, v)))},
    net_name:{held:every((v, t) => (t.net || "") === boardNet(unescape(v)))},
    layer:{held:(v, ts, e, ctx) => sameSet(ts, e, ctx)}, layers:{held:(v, ts, e, ctx) => sameSet(ts, e, ctx)},
    name:{held:every((v, t) => t.name === v)},
    locked:{held:every((v, t) => !!t.locked === yes(v))},
    hatch:{outside:HATCH},
    priority:{held:every((v, t) => t.pourIndex === -+v)},
    connect_pads:{held:every((v, t) => v === "yes" ? t.connectStyle === "direct" : v === "no" ? t.connectStyle === "none" : false)},
    "connect_pads.clearance":{outside:ruleArea, held:every((v, t) => t.kind === "graphic" ? +N(v) === 0 : near(t.clearance, N(v)))},
    min_thickness:{outside:ruleArea, held:every((v, t) => t.kind === "graphic" || near(t.neckWidth, N(v)))},
    filled_areas_thickness:{outside:ruleArea, held:(v, ts) => v === "no"},
    fill:{held:(v, ts, e, ctx) => yes(v) === fillOf(ts, ctx, e).length > 0},
    "fill.mode":{held:every((v, t) => (v === "hatch" ? "hatched" : "solid") === (t.fillMode || "solid"))},
    "fill.thermal_gap":{outside:ruleArea, held:every((v, t) => t.kind === "graphic" ? false : near(t.reliefAirGap, N(v)))},
    "fill.thermal_bridge_width":{outside:ruleArea, held:every((v, t) => t.kind === "graphic" ? false : near(t.reliefConductorWidth, N(v)))},
    "fill.island_removal_mode":{held:every((v, t) => +v === 0 ? t.removeDeadCopper === true : +v === 1 ? t.removeDeadCopper === false : false)},
    "fill.hatch_thickness":{held:every((v, t) => near(t.hatchWidth, N(v)))},
    "fill.hatch_gap":{held:every((v, t) => near(t.hatchPitch - t.hatchWidth, N(v)))},
    "fill.hatch_orientation":{held:every((v, t) => angle(t.hatchAngle, N(v)) || angle(t.hatchAngle, -N(v))), reason:/hatch orientation/i},
    "keepout.*":{held:(v, ts, e, ctx, name) => ts.every(t => keepoutHeld(t, name.split(".")[1], v)), reason:/keepout restrictions/i},
    "attr.teardrop.type":{held:every((v, t) => t.teardrop === true)},
    uuid:{outside:ID}
  }
};
function sameSet(ts, e, ctx) {
  const want = zoneCopper(e, ctx).sort(), got = ts.map(t => t.layer).sort();
  return JSON.stringify(want) === JSON.stringify(got);
}
const ZONE_POLYGON = {
  locate:(e, ctx) => ctx.target.get(e.parent) && e.parent.node.filter(c => isL(c) && c[0] === "polygon")[0] === e.node ? ctx.target.get(e.parent) : null,
  fields:{pts:{held:(v, ts) => !!ts}}, reason:/only the first source contour/i
};
const ZONE_FILL = {
  locate(e, ctx) {
    const ts = ctx.target.get(e.parent);
    if (!ts) return null;
    const pts = pointsOf(e.fields.pts), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const layer = copperName(e.fields.layer ?? zoneLayers(e.parent)[0]);
    const bounds = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    return claim(ctx, fillOf(ts, ctx, e.parent), r => r.layer === layer && r.bounds.every((b, k) => near(b, bounds[k])));
  },
  fields:{layer:{held:(v, t) => t.layer === copperName(v)}, pts:{held:(v, t) => !!t}, island:{outside:ISLAND}}
};

// Footprints: the placed part, by its KiCad UUID.
const FOOTPRINT = {
  locate:(e, ctx) => ctx.source.get(String(e.fields.uuid || e.fields.tstamp || "").toLowerCase()) || null,
  fields:{
    name:{held:(v, t, e, ctx) => { const d = ctx.defs.get(t.def); return !!d && (d.name === v || d.footprint?.name === v || d.source?.id === v); }},
    layer:{held:(v, t) => t.layer === (v === "B.Cu" ? "Bottom" : "Top")},
    at:{held:(v, t) => same([t.x, t.y], xy(v)) && angle(t.angle, -(+v[2] || 0))},
    locked:{held:(v, t) => !!t.locked === yes(v)},
    placed:{held:(v, t) => !!t.placed === yes(v)},
    descr:{held:(v, t, e, ctx) => { const d = ctx.defs.get(t.def); return d?.description === v || t.description === v; }},
    tags:{held:(v, t, e, ctx) => { const d = ctx.defs.get(t.def); return d?.tags === v || d?.keywords === v; }},
    path:{held:(v, t) => { const s = String(v).split("/").filter(Boolean); return s.length === 1 && t.link === "kicad-" + s[0]; }},
    sheetname:{outside:SHEET_CACHE}, sheetfile:{outside:SHEET_CACHE},
    "attr.smd":{held:(v, t, e, ctx) => { const d = ctx.defs.get(t.def); return !!d && d.footprint.pads.every(p => p.layer !== "Multi" || p.plated === false); }},
    "attr.through_hole":{held:(v, t, e, ctx) => { const d = ctx.defs.get(t.def); return !!d && d.footprint.pads.some(p => p.layer === "Multi" && p.plated !== false); }},
    "attr.dnp":{held:(v, t) => t.dnp === true},
    "attr.exclude_from_bom":{held:(v, t) => t.excludeFromBOM === true || t.bom === false},
    "attr.exclude_from_pos_files":{held:(v, t) => t.excludeFromPlacement === true || t.noPlace === true},
    solder_mask_margin:{held:(v, t, e, ctx) => inherited(e, ctx, "solder_mask_margin", p => near(p.t.maskExpansion, N(v), 1e-6))},
    solder_paste_margin:{held:(v, t, e, ctx) => inherited(e, ctx, "solder_paste_margin", p => pasteHeld(p.t, p.e, ctx))},
    solder_paste_ratio:{held:(v, t, e, ctx) => inherited(e, ctx, "solder_paste_ratio", p => pasteHeld(p.t, p.e, ctx))},
    solder_paste_margin_ratio:{held:(v, t, e, ctx) => inherited(e, ctx, "solder_paste_margin_ratio", p => pasteHeld(p.t, p.e, ctx))},
    uuid, tstamp:uuid
  }
};
// A footprint (or board) margin is held when every copper pad that inherits it carries it.
function inherited(owner, ctx, key, test, board) {
  const film = /mask/.test(key) ? "Mask" : "Paste";
  const pads = ctx.entries.filter(x => /\/pad$/.test(x.kind) && x.file === owner.file && (board ? true : footprintOf(x) === owner))
    .filter(x => { const l = [].concat(x.fields.layers || []); return l.some(n => /\.Cu$/.test(n)) && l.some(n => n.endsWith("." + film)); })
    .filter(x => (board ? !footprintOf(x).fields[board] : true) && x.fields[key] === undefined)
    .map(x => ({e:x, t:ctx.target.get(x)}));
  return pads.length > 0 && pads.every(p => p.t && test(p));
}

function rule(ctx, type, test) { return (ctx.model.rules?.list || []).some(r => r.type === type && test(r)); }
const scopeAll = r => r.scope?.source === "object";

const KINDS = {
  kicad_pcb:{locate:(e, ctx) => ctx.doc(e.file), fields:{version:{outside:FORMAT}, generator:{outside:FORMAT}, generator_version:{outside:FORMAT}, host:{outside:FORMAT}}},
  general:{locate:(e, ctx) => ctx.doc(e.file), fields:{thickness:num(t => t.thickness), legacy_teardrops:{outside:LEGACY_TD}}},
  paper:{locate:() => null}, title_block:{locate:() => null},
  layers:{locate:(e, ctx) => ctx.doc(e.file)},
  "layers/layer":{
    locate:(e, ctx) => ctx.doc(e.file),
    fields:{
      ordinal:{outside:"KiCad's fixed number for this layer name; the name identifies the layer."},
      name:{held:(v, d) => !!copperName(v) && !!d.stackup?.layers.some(l => l.key === copperName(v)), reason:/native layer/i},
      type:{held:(v, d, e) => { const k = copperName(e.fields.name), l = d.stackup?.layers.find(x => x.key === k); return !!l && (v === "signal" ? l.type === "Signal" : v === "power" ? l.type === "Plane" : false); },
        outside:e => !copperName(e.fields.name) && e.fields.type === "user" && "A technical layer's type is always user; the layer name sets its role."},
      user_name:{reason:/custom layer names/i}
    }
  },
  setup:{
    locate:(e, ctx) => ctx.doc(e.file),
    fields:{
      pad_to_mask_clearance:{held:(v, d, e, ctx) => rule(ctx, "solderMask", r => scopeAll(r) && near(r.expansion, N(v), 1e-6))},
      pad_to_paste_clearance:{held:(v, d, e, ctx) => rule(ctx, "pasteMask", r => scopeAll(r) && near(r.expansion, N(v), 1e-6))},
      pad_to_paste_clearance_ratio:{held:(v, d, e, ctx) => inherited(e, ctx, "solder_paste_margin_ratio", p => pasteHeld(p.t, p.e, ctx), "solder_paste_ratio")}
    }
  },
  "setup/stackup":{locate:(e, ctx) => ctx.doc(e.file).stackup || null},
  "setup/pcbplotparams":{locate:() => null},
  "setup/stackup/layer":{
    locate(e, ctx) {
      const s = ctx.doc(e.file).stackup, f = e.fields, type = String(f.type || "").toLowerCase();
      if (!s) return null;
      const side = /^B\./.test(f.name) ? "Bottom" : "Top";
      if (type === "copper") return s.layers.find(l => l.key === copperName(f.name)) || null;
      if (/silk/.test(type)) return s.layers.find(l => l.type === "Overlay" && l.name.startsWith(side)) || null;
      if (/solder mask/.test(type)) return s.layers.find(l => l.type === "Solder Mask" && l.name.startsWith(side)) || null;
      return s.layers.find(l => l.type === "Dielectric" && l.name === f.name) || null;
    },
    fields:{
      name:{held:(v, l) => !!l}, type:{held:(v, l) => !!l},
      thickness:num(l => l.thickness), material:eq(l => l.material),
      epsilon_r:num(l => l.dk), loss_tangent:num(l => l.df), color:eq(l => l.color)
    }
  },
  net:{
    locate(e, ctx) {
      const name = boardNet(unescape(e.fields.name ?? "")), d = ctx.doc(e.file);
      if (!name) return null;
      return d.items.some(i => i.net === name || Object.values(i.pinNets || {}).includes(name)) ? {name} : null;
    },
    outside:e => !e.fields.name && "KiCad's mandatory empty net 0 stands for no net.",
    fields:{number:{outside:"KiCad's per-file net code; objects in the file refer to the net by it, and the name carries the meaning."}, name:{held:(v, t) => !!t}}
  },
  footprint:FOOTPRINT, module:FOOTPRINT,
  "footprint/property":FIELD_TEXT, "footprint/fp_text":FIELD_TEXT,
  "footprint/pad":PAD, "module/pad":PAD,
  segment:{
    locate:(e, ctx) => ctx.source.get(String(e.fields.uuid || e.fields.tstamp || "").toLowerCase()) || null,
    fields:{
      start:{held:(v, t) => same(t.points[0], xy(v))}, end:{held:(v, t) => same(t.points.at(-1), xy(v))},
      width:num(t => t.width), layer:{held:(v, t) => t.layer === copperName(v)},
      net:{held:(v, t, e, ctx) => (t.net || "") === boardNet(netName(ctx, e, v))}, locked, uuid, tstamp:uuid
    }
  },
  via:{
    locate:(e, ctx) => ctx.source.get(String(e.fields.uuid || e.fields.tstamp || "").toLowerCase()) || null,
    fields:{
      at:{held:(v, t) => same([t.x, t.y], xy(v))}, size:num(t => t.diameter), drill:num(t => t.drill),
      layers:{held:(v, t, e) => {
        const [a, b] = v.map(copperName), through = (a === "Top" && b === "Bottom") || (a === "Bottom" && b === "Top");
        return through ? !t.fromLayer : t.fromLayer === a && t.toLayer === b;
      }},
      type:{held:(v, t) => v === "blind" ? !!t.fromLayer : v === "through", reason:/microvia/i, note:/micro vias import as blind/i},
      net:{held:(v, t, e, ctx) => (t.net || "") === boardNet(netName(ctx, e, v))}, locked, uuid, tstamp:uuid,
      free:{held:(v, t) => !!t.free === yes(v)}
    }
  },
  zone:ZONE, "footprint/zone":{...ZONE, fields:{...ZONE.fields}},
  "zone/polygon":ZONE_POLYGON, "footprint/zone/polygon":ZONE_POLYGON,
  "zone/filled_polygon":ZONE_FILL, "footprint/zone/filled_polygon":ZONE_FILL,
  gr_text:{
    locate(e, ctx) {
      const p = xy(e.fields.at);
      return claim(ctx, ctx.doc(e.file).items.filter(i => i.kind === "label"), t => t.text === e.fields.text && same([t.x, t.y], p));
    },
    fields:{...TEXT, text:{held:(v, t) => !!t}, at:{held:(v, t) => same([t.x, t.y], xy(v)) && angle(t.angle || 0, -(+v[2] || 0))},
      "effects.font.size":{held:(v, t) => near(t.size, +v[0]) && (+v[1] === +v[0] || near(t.fontWidth, +v[1]))},
      "layer.knockout":flagHeld(t => t.knockout || t.inverted), locked, uuid}
  }
};
for (const g of ["gr_line", "gr_rect", "gr_circle", "gr_arc", "gr_poly", "gr_curve", "gr_bbox"]) KINDS[g] = GRAPHIC;
for (const g of ["fp_line", "fp_rect", "fp_circle", "fp_arc", "fp_poly", "fp_curve"]) KINDS["footprint/" + g] = KINDS["module/" + g] = FP_GRAPHIC;
KINDS.arc = {...KINDS.segment, fields:{...KINDS.segment.fields,
  mid:{held:(v, t, e) => { const g = circle(xy(e.fields.start), xy(v), xy(e.fields.end)); return !!t.arc && same(t.arc.c, g.c) && near(t.arc.r, g.r); }}}};

// .kicad_pro: net classes become rules and tags; the rest is reported or outside.
const UI = "Editor state: remembered folders, view presets and library-browser favourites.";
const PROJECT = {
  kicad_pro:{fields:{sheets:{outside:"The project's list of schematic sheets, a cache KiCad rebuilds from the sheet files."},
    boards:{outside:"KiCad's list of board files in the project; the selection of files carries it."}}},
  "kicad_pro/meta":{outside:FORMAT}, "kicad_pro/board/design_settings/meta":{outside:FORMAT}, "kicad_pro/net_settings/meta":{outside:FORMAT},
  "kicad_pro/pcbnew/last_paths":{outside:UI}, "kicad_pro/libraries":{outside:UI},
  "kicad_pro/board":{fields:{layer_presets:{outside:UI}, viewports:{outside:UI}}},
  "kicad_pro/net_settings/classes":{
    locate:(e, ctx) => ({members:classMembers(e.fields.name, ctx), name:e.fields.name}),
    fields:{
      name:{held:(v, c, e, ctx) => v === "Default" ? rule(ctx, "clearance", r => scopeAll(r)) : (ctx.model.signals?.tags || []).some(t => t.name === v)},
      clearance:{held:(v, c, e, ctx) => classRule(ctx, c, "clearance", r => near(r.gap, v))},
      // KiCad's class track width is the width new tracks get, not a limit: only a preferred width holds it.
      track_width:{held:(v, c, e, ctx) => classRule(ctx, c, "width", r => near(r.preferred, v))},
      via_diameter:{held:(v, c, e, ctx) => classRule(ctx, c, "viaStyle", r => near(r.diameterPreferred, v))},
      via_drill:{held:(v, c, e, ctx) => classRule(ctx, c, "viaStyle", r => near(r.holePreferred, v))}
    }
  },
  "kicad_pro/net_settings/netclass_assignments":{locate:() => ({}), fields:{"*":{held:(v, t, e, ctx, name) => (ctx.model.signals?.nets?.[name]?.tags || []).includes(v)}}},
  "kicad_pro/net_settings/netclass_patterns":{locate:() => null, fields:{"*":{reason:/expression is applied/i}}},
  "kicad_pro/board/design_settings/rules":{locate:() => ({}), fields:{
    min_via_diameter:{held:(v, t, e, ctx) => rule(ctx, "viaStyle", r => scopeAll(r) && near(r.diameterMin, v))},
    min_copper_edge_clearance:{held:(v, t, e, ctx) => ctx.pcb.every(d => d.items.filter(i => i.kind === "polygon").every(i => near(i.boardClearance, v)))}
  }}
};
function classMembers(name, ctx) {
  const nets = ctx.model.signals?.nets || {};
  return Object.keys(nets).filter(n => (nets[n].tags || []).includes(name));
}
function classRule(ctx, c, type, test) {
  if (c.name === "Default") return rule(ctx, type, r => scopeAll(r) && test(r));
  const inClass = r => r.scope?.source === "object in class " + JSON.stringify(c.name);
  return rule(ctx, type, r => inClass(r) && test(r)) || c.members.length > 0 &&
    c.members.every(n => rule(ctx, type, r => r.scope?.source === "object where net.name = " + JSON.stringify(n) && test(r)));
}

// ------------------------------------------------------------------ accounting

function specOf(kind) { return KINDS[kind] || PROJECT[kind] || {}; }
function fieldSpec(spec, name) {
  const f = spec.fields || {};
  if (Object.hasOwn(f, name)) return f[name];
  const wild = Object.keys(f).filter(k => k.endsWith("*") && name.startsWith(k.slice(0, -1))).sort((a, b) => b.length - a.length)[0];
  if (wild) return f[wild];
  if (name === "uuid" || name === "tstamp") return {outside:ID};
  return {};
}
const reasonOf = (v, e) => typeof v === "function" ? v(e) : v;

function account(entries, imported) {
  const ctx = context(entries, imported);
  ctx.target = new Map();
  const status = new Map(), rows = new Map();
  const row = id => rows.get(id) || rows.set(id, {id, source:0, held:0, reported:0, outside:0, lost:0, unmapped:0, unplaced:0, detail:[]}).get(id);
  const refsAt = (e, a) => a ? ctx.refs.get(e.file + "\0" + a) || [] : [];
  const droppedAbove = e => [...e.ancestors, e.address].some(a => refsAt(e, a).some(r => r.status === "dropped"));
  // Objects, parents before their children.
  for (const e of entries) {
    const spec = specOf(e.kind), r = row(e.kind);
    r.source++;
    const outside = reasonOf(spec.outside, e) || (e.parent && status.get(e.parent) === "outside" ? "Part of an object outside the design." : null);
    let s;
    if (outside) s = "outside";
    else {
      const parentLost = e.parent && !ctx.target.get(e.parent) && status.get(e.parent) !== "held" && e.parent.kind !== "kicad_pro";
      const t = !parentLost && spec.locate ? spec.locate(e, ctx) : null;
      if (t) { ctx.target.set(e, t); s = "held"; }
      else if (droppedAbove(e) || refsAt(e, e.address).some(x => x.status !== "kept")) s = "reported";
      else if (e.kind.startsWith("kicad_pro") && !spec.locate) s = "held";
      else s = "lost";
    }
    status.set(e, s);
    r[s]++;
    if (s === "lost" && r.detail.length < 6) r.detail.push(e.id + ": not found in the imported model and not in the Import Report");
  }
  // Source layer -> model layer, for the one-to-one test of every layer field.
  for (const e of entries) {
    const t = ctx.target.get(e);
    if (!t || e.fields.layer === undefined || Array.isArray(t)) continue;
    const w = layerOf(e, t), key = e.fields.layer;
    if (w == null || copperName(key)) continue;
    (ctx.layers.get(key) || ctx.layers.set(key, new Set()).get(key)).add(w);
  }
  for (const e of entries) {
    const spec = specOf(e.kind), s = status.get(e), t = ctx.target.get(e);
    const own = refsAt(e, e.address);
    for (const [name, value] of Object.entries(e.fields)) {
      const f = fieldSpec(spec, name), r = row(e.kind + "." + name);
      r.source++;
      let how;
      const outside = s === "outside" ? "object" : reasonOf(f.outside, e);
      if (outside) how = "outside";
      else if (t && f.held && safe(() => f.held(value, t, e, ctx, name))) how = "held";
      else if (s === "reported" || droppedAbove(e) ||
        refsAt(e, e.addr[name]).some(x => x.status !== "kept") ||
        own.some(x => x.status === "approximated" && (matches(f.reason, x.reason) || named(name, x.reason))) ||
        (f.note && (ctx.notes.get(e.file) || []).some(n => f.note.test(n)))) how = "reported";
      else if (s === "lost") how = "unplaced";  // its object is the failure; the object row counts it once
      else if (!Object.keys(f).length) how = "unmapped";  // no check, no reason, no note: nothing has looked at it
      else how = "lost";
      r[how]++;
      if ((how === "lost" || how === "unmapped") && r.detail.length < 6) r.detail.push(e.id + " = " + show(value) +
        (how === "unmapped" ? " (unmapped: the census has no check for this field)" : t && f.held ? " (the model differs)" : t ? "" : " (object not imported)"));
    }
  }
  return [...rows.values()].map(r => ({id:r.id, pass:r.lost + r.unmapped === 0, gating:true,
    metric:{source:r.source, held:r.held, reported:r.reported, outside:r.outside, lost:r.lost, unmapped:r.unmapped, unplaced:r.unplaced}, detail:r.detail}));
}
const matches = (re, reason) => !!re && !!reason && re.test(reason);
const named = (name, reason) => !!reason && name.split(".").pop().length > 3 && new RegExp("\\b" + name.split(".").pop().replace(/[^\w]/g, "\\$&") + "\\b").test(reason);
function safe(fn) { try { return !!fn(); } catch { return false; } }
const show = v => { const s = JSON.stringify(v); return s.length > 60 ? s.slice(0, 57) + "..." : s; };

module.exports = {FIXTURES, census, account};
