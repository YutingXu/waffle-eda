"use strict";
// Census of Eagle XML designs (.brd boards, .sch schematics) for tests/e2e/census.cjs.
//
// census() lists every object and every field an Eagle 6-9 file holds. It reads the bytes with
// its own small XML tokenizer and requires no app code (census-report.cjs only unpacks the Import Report), so it cannot share a blind spot with
// app/formats/import-eagle.js. A kind is the element's path below <drawing> (board/elements/element,
// schematic/sheets/sheet/nets/net/segment/wire); a field is an XML attribute, "#text" for the
// element's text, or, for <designrules> and an autorouter <pass>, the name of one of its <param>s.
// Pure grouping elements (<plain>, <signals>, <segment>...) hold nothing of their own and are not
// listed; what they group is.
//
// account() then looks for each object and field in the imported model. Eagle works in millimetres
// with Y up and counter-clockwise angles; Waffle is Y down with angles clockwise on screen, so a
// point (x, y) is compared as (x, -y) and placements are composed here from the source values (an
// element turns by its angle, then mirrors when "M" is set). Board design rules that Eagle applies
// to pads and vias (restring, elongation) are applied here as Eagle applies them, so a pad compares
// at the size Eagle manufactures. A field the census cannot find with its value is lost unless the
// Import Report says it was dropped or approximated: the element's own report row (by its character
// offset), or a reason or note that names the property. A few fields are declared outside a design's
// meaning in OUTSIDE below, each with its reason.
const {references} = require("./census-report.cjs");
const SKIP = new Set(("drawing settings layers libraries packages symbols devicesets gates devices connects technologies " +
  "parts sheets instances plain nets busses elements signals classes attributes variantdefs packages3d " +
  "package3dinstances packageinstances autorouter errors segment compatibility filters").split(" "));
const FOLD = new Set(["board/designrules/param", "board/autorouter/pass/param"]);

// ------------------------------------------------------------ XML
const ENTITIES = {amp: "&", lt: "<", gt: ">", quot: '"', apos: "'"};
const decode = s => s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? m);
function parse(text) {
  const root = {name: "#document", attrs: {}, kids: [], text: "", at: -1, parent: null};
  let node = root, i = 0;
  const attr = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
  while (i < text.length) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    if (lt > i) node.text += decode(text.slice(i, lt));
    if (text.startsWith("<!--", lt)) { i = text.indexOf("-->", lt) + 3; if (i < 3) throw Error("unterminated comment"); continue; }
    if (text.startsWith("<![CDATA[", lt)) { const e = text.indexOf("]]>", lt); node.text += text.slice(lt + 9, e); i = e + 3; continue; }
    if (text[lt + 1] === "?") { i = text.indexOf("?>", lt) + 2; continue; }
    if (text[lt + 1] === "!") {
      let depth = 0, j = lt + 2;
      for (; j < text.length; j++) { const c = text[j]; if (c === "[") depth++; else if (c === "]") depth--; else if (c === ">" && depth <= 0) break; }
      i = j + 1; continue;
    }
    if (text[lt + 1] === "/") {
      const e = text.indexOf(">", lt), name = text.slice(lt + 2, e).trim();
      if (name !== node.name) throw Error("XML: </" + name + "> closes <" + node.name + ">");
      node = node.parent; i = e + 1; continue;
    }
    let j = lt + 1;
    while (j < text.length && !/[\s/>]/.test(text[j])) j++;
    const el = {name: text.slice(lt + 1, j), attrs: {}, kids: [], text: "", at: lt, parent: node};
    attr.lastIndex = j;
    for (let m; (m = attr.exec(text));) { el.attrs[m[1]] = decode(m[2] ?? m[3]); j = attr.lastIndex; }
    while (/\s/.test(text[j])) j++;
    node.kids.push(el);
    if (text[j] === "/" && text[j + 1] === ">") i = j + 2;
    else if (text[j] === ">") { node = el; i = j + 1; }
    else throw Error("XML: malformed tag at character " + lt);
  }
  if (node !== root) throw Error("XML: <" + node.name + "> is not closed");
  return root;
}
const kids = (el, name) => el ? el.kids.filter(k => k.name === name) : [];
const kid = (el, name) => el?.kids.find(k => k.name === name);
const up = (el, name) => { for (let e = el?.parent; e; e = e.parent) if (e.name === name) return e; return null; };
const textOf = el => el.kids.length ? el.text.trim() : el.text.replace(/^\s*\n|\n\s*$/g, "").trim();

// ------------------------------------------------------------ census
function census(files) {
  const entries = [];
  for (const f of files) {
    const text = new TextDecoder("utf-8").decode(f.bytes).replace(/^﻿/, "");
    const root = parse(text);
    const walk = (el, at) => {
      const kind = at.replace(/^eagle\/drawing\//, "").replace(/^eagle\//, "");
      const own = Object.keys(el.attrs).length || textOf(el);
      if (FOLD.has(kind)) {
        const host = el.parent.entry;
        host.fields[el.attrs.name] = el.attrs.value ?? "";
        host.fieldAt[el.attrs.name] = el.at;
        Object.defineProperty(el, "entry", {value: host});
        return;
      }
      if (!(SKIP.has(el.name) && !own)) {
        const label = el.attrs.name ?? el.attrs.element ?? el.attrs.part ?? el.attrs.number ?? "";
        const entry = {kind, id: f.name + ":" + el.at + " <" + el.name + (label ? " " + label : "") + ">", fields: {}};
        for (const [k, v] of Object.entries(el.attrs)) entry.fields[k] = v;
        const t = textOf(el);
        if (t) entry.fields["#text"] = t;
        Object.defineProperties(entry, {node: {value: el}, file: {value: f.name}, fieldAt: {value: {}}});
        el.entry = entry;
        entries.push(entry);
      }
      for (const k of el.kids) walk(k, at + "/" + k.name);
    };
    for (const k of root.kids) walk(k, k.name);
  }
  return entries;
}

// ------------------------------------------------------------ units and frames
const TOL = 2e-3;
function mm(v) {
  const m = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)\s*(mm|mil|in|mic)?\s*$/i.exec(String(v ?? ""));
  return m ? +m[1] * ({mil: .0254, in: 25.4, mic: .001}[(m[2] || "mm").toLowerCase()] || 1) : NaN;
}
const n = (v, d = 0) => { const x = mm(v); return Number.isFinite(x) ? x : d; };
const close = (a, b, tol = TOL) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const closeP = (p, q, tol = TOL) => !!p && !!q && close(p[0], q[0], tol) && close(p[1], q[1], tol);
const angleDiff = (a, b, period = 360) => { const d = ((a - b) % period + period) % period; return Math.min(d, period - d); };
function rot(v) {
  const m = /^(S?)(M?)R(-?\d+(?:\.\d+)?)$/.exec(String(v || "R0"));
  return m ? {spin: !!m[1], mirror: !!m[2], angle: +m[3]} : {spin: false, mirror: false, angle: 0, bad: true};
}
const rad = a => a * Math.PI / 180;
const turn = (p, a) => { const c = Math.cos(rad(a)), s = Math.sin(rad(a)); return [p[0] * c - p[1] * s, p[0] * s + p[1] * c]; };
// Eagle: an object at `at` turned by r.angle (counter-clockwise, Y up), then mirrored in X.
function eaglePlace(at, r, p) { const q = turn(p, r.angle); return [at[0] + (r.mirror ? -q[0] : q[0]), at[1] + q[1]]; }
const W = p => [p[0], -p[1]];
// Waffle: model.js world(): mirror local X (schematic parts), turn by angle, then offset.
const placeW = (item, p) => { const q = turn(item.mirror ? [-p[0], p[1]] : p, item.angle || 0); return [q[0] + item.x, q[1] + item.y]; };

// ------------------------------------------------------------ results
const HELD = {held: true};
const lost = why => ({lost: why});
const outside = why => ({outside: why});
const fmt = v => typeof v === "number" ? String(Math.round(v * 1e4) / 1e4) : JSON.stringify(v);
const same = (v, model, what) => v === model ? HELD : lost(what + " is " + fmt(model) + ", source " + fmt(v));
const sameMm = (v, model, what) => close(n(v, NaN), model) ? HELD : lost(what + " is " + fmt(model) + ", source " + fmt(v) + " (" + fmt(n(v, NaN)) + " mm)");
const dflt = (v, d, why) => v === d ? HELD : lost(why);
const yes = v => v === "yes";

// ------------------------------------------------------------ the imported model, per source file
function view(imported, files) {
  const model = imported.model, docs = model.documents || [], lib = model.library || [];
  const defs = new Map(lib.map(d => [d.id, d]));
  const report = new Map(), reportNotes = [...(imported.report?.notes || []), ...(model.importNotes || [])];
  for (const row of imported.report?.kinds || []) for (const ref of references(row)) {
    const m = /^<([^>]*)> at character (\d+)$/.exec(ref.object || "");
    if (m) report.set(ref.file + "\0" + m[2], {status: ref.status, reason: ref.reason || "", kind: row.kind});
  }
  const byFile = new Map();
  for (const f of files) {
    const brd = /\.brd$/i.test(f.name), stem = f.name.replace(/\.[^.]+$/, "");
    const mine = docs.filter(d => d.kind === (brd ? "pcb" : "schematic") && (d.name === stem || d.name.startsWith(stem + " ")));
    const parts = new Map();
    for (const d of mine) for (const it of d.items) if (it.kind === "part") { if (!parts.has(it.ref)) parts.set(it.ref, []); parts.get(it.ref).push({doc: d, item: it}); }
    // Notes that speak for this file: the report's, prefixed with the file name, and its documents' own.
    const notes = [...new Set([...reportNotes.filter(t => t.startsWith(f.name + " — ")).map(t => t.slice(f.name.length + 3)), ...mine.flatMap(d => d.notes || [])])];
    byFile.set(f.name, {brd, docs: mine, pcb: brd ? mine[0] : null, parts, notes, items: mine.flatMap(d => d.items.map(it => ({doc: d, item: it})))});
  }
  return {model, defs, report, byFile, rules: model.rules?.list || [], cache: new Map()};
}

// ------------------------------------------------------------ board: layers, rules, placements
function boardFacts(ctx, e) {
  const root = rootOf(e.node), key = "board\0" + e.file;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const brd = kid(kid(kid(root, "eagle"), "drawing"), "board");
  const dr = {};
  for (const p of kids(kid(brd, "designrules"), "param")) dr[p.attrs.name] = p.attrs.value;
  // Copper stack order: the layer setup when it names the layers, else the copper layers in use.
  let stack = (String(dr.layerSetup || "").match(/\d+/g) || []).map(Number).filter(l => l >= 1 && l <= 16);
  if (!stack.length) {
    const used = new Set([1, 16]);
    const all = []; const visit = el => { all.push(el); el.kids.forEach(visit); }; visit(brd);
    for (const el of all) { const l = +el.attrs.layer; if (l >= 2 && l <= 15) used.add(l); }
    stack = [...used].sort((a, b) => a - b);
  }
  const inner = stack.filter(l => l > 1 && l < 16);
  const copper = l => l === 1 ? "Top" : l === 16 ? "Bottom" : inner.includes(l) ? "Inner " + (inner.indexOf(l) + 1) : null;
  // Restring and elongation, as Eagle applies them (DRC Restring and Shapes tabs).
  const ratio = (k, d) => { const v = parseFloat(dr[k]); return Number.isFinite(v) ? v : d; };
  const len = (k, d) => { const v = mm(dr[k]); return Number.isFinite(v) ? v : d; };
  const ring = (drill, k) => Math.min(len("rlMax" + k, .508), Math.max(len("rlMin" + k, .254), drill * ratio("rv" + k, .25)));
  const elongation = {long: ratio("psElongationLong", 100), offset: ratio("psElongationOffset", 100)};
  const packages = new Map();
  for (const lib of kids(kid(brd, "libraries"), "library")) for (const p of kids(kid(lib, "packages"), "package")) packages.set(lib.attrs.name + "\0" + p.attrs.name, p);
  const placements = new Map();
  for (const el of kids(kid(brd, "elements"), "element")) {
    const k = el.attrs.library + "\0" + el.attrs.package;
    if (!placements.has(k)) placements.set(k, []);
    placements.get(k).push(el);
  }
  const signals = kids(kid(brd, "signals"), "signal");
  const facts = {brd, dr, copper, ring, elongation, packages, placements, signals};
  ctx.cache.set(key, facts);
  return facts;
}
const rootOf = el => { while (el.parent) el = el.parent; return el; };
const SWAP = {1: 16, 21: 22, 25: 26, 27: 28, 29: 30, 31: 32, 35: 36, 39: 40, 41: 42, 51: 52};
for (const [a, b] of Object.entries(SWAP)) SWAP[b] = +a;
// What a non-copper Eagle layer means, and which model layers say the same.
function layerRole(l) {
  if (l === 21 || l === 25) return {is: m => /^(Silk|Top Overlay|Top Silk)$/i.test(m), name: "top silkscreen"};
  if (l === 22 || l === 26) return {is: m => /^(Bottom silk|Bottom Overlay)$/i.test(m), name: "bottom silkscreen"};
  if (l === 29) return {is: m => /^Top (mask|solder)/i.test(m), name: "top solder mask"};
  if (l === 30) return {is: m => /^Bottom (mask|solder)/i.test(m), name: "bottom solder mask"};
  if (l === 31) return {is: m => /^Top paste/i.test(m), name: "top paste"};
  if (l === 32) return {is: m => /^Bottom paste/i.test(m), name: "bottom paste"};
  if ([27, 28, 35, 36, 39, 40, 47, 48, 49, 51, 52].includes(l)) return {is: m => !!m && !/^(Top|Bottom|Inner \d+|Multi|Keepout)$|silk|mask|paste|overlay/i.test(m), name: "a documentation layer"};
  return null;
}
// Does a model object on `layer` (with its keepout flags) say what Eagle layer `l` says?
function layerHeld(facts, l, it, mirror = false) {
  const el = mirror && SWAP[l] ? SWAP[l] : l;
  const cu = facts.copper(el);
  if (el >= 1 && el <= 16) return cu && it.layer === cu ? HELD : lost("on " + fmt(it.layer) + ", source layer " + l + (cu ? " (" + cu + ")" : " is outside the layer setup"));
  if (el === 41 || el === 42) {
    const side = el === 41 ? "Top" : "Bottom";
    return it.keepout && it.layer === side ? HELD : lost("restrict layer " + l + " keeps copper off " + side + " only; the model has " + fmt(it.layer) + (it.keepout ? " keepout" : ""));
  }
  if (el === 43) return it.keepout && Number.isFinite(it.keepoutRestrictions) ? HELD : lost("vRestrict keeps out vias only; the model has " + fmt(it.layer));
  const role = layerRole(el);
  if (!role) return lost("Eagle layer " + l + " has no counterpart; the model has " + fmt(it.layer));
  return role.is(it.layer) ? HELD : lost("on " + fmt(it.layer) + ", source layer " + l + " is " + role.name);
}

// ------------------------------------------------------------ board: finders
// An element's placement: Eagle point (package frame) -> Waffle world.
function elementPlacement(ctx, elNode) {
  const facts = boardFacts(ctx, elNode.entry), part = ctx.byFile.get(elNode.entry.file).parts.get(elNode.attrs.name)?.[0]?.item;
  const r = rot(elNode.attrs.rot), at = [n(elNode.attrs.x), n(elNode.attrs.y)];
  return {facts, part, def: part && ctx.defs.get(part.def), r, at, world: p => W(eaglePlace(at, r, p)), model: q => placeW(part, q)};
}
// A package child is checked where its first element places it.
function packageHost(ctx, e) {
  const pkg = up(e.node, "package"), lib = up(e.node, "library");
  const facts = boardFacts(ctx, e), els = facts.placements.get(lib.attrs.name + "\0" + pkg.attrs.name) || [];
  if (!els.length) return {missing: "no element places package " + pkg.attrs.name};
  const pl = elementPlacement(ctx, els[0]);
  if (!pl.part) return {missing: "element " + els[0].attrs.name + " is not in the model"};
  if (!pl.def?.footprint) return {missing: "element " + els[0].attrs.name + " has no footprint"};
  return pl;
}
function outlineSegments(doc) {
  const s = doc?.boardShape;
  return s ? [...(s.contour || []), ...(s.cutouts || []).flat()] : [];
}
const arcEnd = (a, ang) => [a.c[0] + a.r * Math.cos(rad(ang)), a.c[1] - a.r * Math.sin(rad(ang))];
const arcSweep = a => { const d = ((a.end - a.start) % 360 + 360) % 360; return a.ccw ? (d || 360) : -(((a.start - a.end) % 360 + 360) % 360 || 360); };
// An Eagle wire on the outline: a line or arc segment of the board shape with the same ends.
function outlineWire(doc, p1, p2, curve) {
  for (const s of outlineSegments(doc)) {
    if (s.kind === "line" && (closeP(s.a, p1) && closeP(s.b, p2) || closeP(s.a, p2) && closeP(s.b, p1))) return {seg: s};
    if (s.kind === "arc") {
      const a = arcEnd(s, s.start), b = arcEnd(s, s.end), sw = arcSweep(s);
      if (closeP(a, p1) && closeP(b, p2)) return {seg: s, curve: sw};
      if (closeP(a, p2) && closeP(b, p1)) return {seg: s, curve: -sw};
    }
  }
  return null;
}
const endsMatch = (pts, p1, p2) => pts?.length >= 2 && (closeP(pts[0], p1) && closeP(pts.at(-1), p2) || closeP(pts[0], p2) && closeP(pts.at(-1), p1));
const ringMatch = (pts, ring) => pts && ring.every(q => pts.some(p => closeP(p, q)));
function rectCorners(a, angle = rot(a.rot).angle) {
  const x1 = n(a.x1), y1 = n(a.y1), x2 = n(a.x2), y2 = n(a.y2), c = [(x1 + x2) / 2, (y1 + y2) / 2];
  return [[x1, y1], [x2, y1], [x2, y2], [x1, y2]].map(p => { const q = turn([p[0] - c[0], p[1] - c[1]], angle); return [c[0] + q[0], c[1] + q[1]]; });
}
// A turned rectangle found only unturned: its layer and other properties can still be compared,
// its corners and rotation cannot.
const UNTURNED = new WeakSet();
function findRect(a, place, test) {
  const hit = test(rectCorners(a).map(place));
  if (hit || !rot(a.rot).angle) return hit;
  const flat = test(rectCorners(a, 0).map(place));
  if (flat) UNTURNED.add(flat);
  return flat;
}
const corners = t => !t ? lost("not found at its source position") : UNTURNED.has(t) ? lost("drawn unturned; the corners differ") : HELD;

// The model object a board <plain> primitive became.
function plainTarget(ctx, e) {
  const v = ctx.byFile.get(e.file), doc = v.pcb, a = e.node.attrs, name = e.node.name, l = +a.layer;
  if (!doc) return null;
  const items = doc.items;
  if (name === "wire") {
    const p1 = W([n(a.x1), n(a.y1)]), p2 = W([n(a.x2), n(a.y2)]);
    if (l === 20 || l === 46) { const o = outlineWire(doc, p1, p2); return o && {outline: o}; }
    return items.find(it => (it.kind === "graphic" || it.kind === "track") && !it.net && endsMatch(it.points, p1, p2));
  }
  if (name === "circle") {
    const c = W([n(a.x), n(a.y)]), r = n(a.radius);
    if (l === 20 || l === 46) { const s = outlineSegments(doc).find(s => s.kind === "arc" && closeP(s.c, c) && close(s.r, r) && arcSweep(s) % 360 === 0); return s && {outline: {seg: s}}; }
    return items.find(it => it.kind === "graphic" && it.points?.length > 8 && it.points.every(p => close(Math.hypot(p[0] - c[0], p[1] - c[1]), r, .01)));
  }
  if (name === "rectangle") return findRect(a, W, ring => items.find(it => it.kind === "graphic" && ringMatch(it.points, ring)));
  if (name === "polygon") {
    const ring = kids(e.node, "vertex").map(v => W([n(v.attrs.x), n(v.attrs.y)]));
    return items.find(it => (it.kind === "polygon" || it.kind === "graphic") && !it.net && ringMatch(it.points, ring));
  }
  if (name === "hole") return items.find(it => it.kind === "pad" && closeP([it.x, it.y], W([n(a.x), n(a.y)])));
  if (name === "text") return items.find(it => it.kind === "label" && it.text === textOf(e.node));
  if (name === "dimension") return items.find(it => it.kind === "graphic" && it.dimension && endsMatch(it.points, W([n(a.x1), n(a.y1)]), W([n(a.x2), n(a.y2)])));
  if (name === "frame") return items.find(it => it.kind === "graphic" && ringMatch(it.points, rectCorners(a).map(W)));
  return null;
}
// The model shape or pad a package primitive became, in world coordinates of its first element.
function packageTarget(ctx, e) {
  const pl = packageHost(ctx, e);
  if (pl.missing) return pl;
  const a = e.node.attrs, name = e.node.name, fp = pl.def.footprint, l = +a.layer;
  const world = p => pl.world([n(p[0]), n(p[1])]), mw = q => pl.model(q);
  let hit = null;
  if (name === "smd" || name === "pad") hit = fp.pads.find(p => String(p.number) === a.name && closeP(mw([p.x, p.y]), world([a.x, a.y])));
  else if (name === "hole") hit = fp.pads.find(p => !p.number && p.plated === false && closeP(mw([p.x, p.y]), world([a.x, a.y])));
  else if (l === 20 || l === 46) {
    if (name === "wire") { const o = outlineWire(pl.facts && ctx.byFile.get(e.file).pcb, world([a.x1, a.y1]), world([a.x2, a.y2])); hit = o && {outline: o}; }
  } else if (name === "wire") hit = fp.shapes.find(s => s.kind === "path" && !s.closed && endsMatch(s.points?.map(mw), world([a.x1, a.y1]), world([a.x2, a.y2])));
  else if (name === "circle") hit = fp.shapes.find(s => s.kind === "circle" && closeP(mw([s.x, s.y]), world([a.x, a.y])));
  else if (name === "rectangle") hit = findRect(a, p => pl.world(p), ring => fp.shapes.find(s => s.kind === "path" && s.closed && ringMatch(s.points?.map(mw), ring)));
  else if (name === "polygon") { const ring = kids(e.node, "vertex").map(v => world([v.attrs.x, v.attrs.y])); hit = fp.shapes.find(s => s.kind === "path" && s.closed && ringMatch(s.points?.map(mw), ring)); }
  else if (name === "text") {
    const t = textOf(e.node), at = world([a.x, a.y]);
    if (/^>NAME$/i.test(t)) hit = pl.part.refAt ? {field: "ref", at: pl.part.refAt} : null;
    else if (/^>VALUE$/i.test(t)) hit = pl.part.valueAt ? {field: "value", at: pl.part.valueAt} : null;
    else hit = fp.shapes.find(s => s.kind === "text" && s.text === t && closeP(mw([s.x, s.y]), at));
  }
  return hit ? Object.assign({pl}, {hit}) : {missing: "no " + name + " in footprint " + pl.def.footprint.name + " at the place element " + pl.part.ref + " puts it"};
}

// ------------------------------------------------------------ board field checks
const lineStyle = (v, it) => v === "continuous" || it?.dash === v || it?.lineStyle === v ? HELD : lost("line style " + v + " has no counterpart (the model line is solid)");
const capStyle = (v, it) => v === "round" || it?.cap === v ? HELD : lost("flat line ends are drawn round");
// Text: Waffle's label fields (pcb-text.js) against Eagle's text attributes.
// With the drawing setting alwaysvectorfont, Eagle draws and plots every text in its vector font.
const vectorAlways = e => kids(kid(kid(kid(rootOf(e.node), "eagle"), "drawing"), "settings"), "setting").some(s => s.attrs.alwaysvectorfont === "yes");
const fontOf = (e, v = e.fields.font) => vectorAlways(e) ? "vector" : v || "proportional";
function textFields(get) {
  return {
    "#text": (v, e, ctx, t) => { const it = get(t); return it ? same(v, it.text, "text") : lost("text not found"); },
    size: (v, e, ctx, t) => { const it = get(t); return it ? sameMm(v, it.size, "size") : lost("no text size in the model"); },
    // The stroke ratio shapes only the vector font; for another font the font row carries the loss.
    ratio: (v, e, ctx, t) => { const it = get(t), want = n(e.fields.size, 1.27) * n(v) / 100; return fontOf(e) !== "vector" || it && close(it.width, want) ? HELD : lost("stroke " + fmt(want) + " mm (" + v + "% of the size); the model stroke is " + fmt(it?.width ?? "the default")); },
    font: (v, e, ctx, t) => { const it = get(t), f = fontOf(e, v); return f === "vector" && (!it?.font || it.font === "stroke") || it?.font === f ? HELD : lost(f + " font; the model draws " + fmt(it?.font || "stroke")); },
    align: (v, e, ctx, t) => {
      const it = get(t), want = v === "center-left" ? "middle-left" : v === "center-right" ? "middle-right" : v;
      const have = it ? (it.justify || (it.align === "center" ? "bottom-center" : it.align === "right" ? "bottom-right" : "bottom-left")) : null;
      return have === want ? HELD : lost("anchor " + v + "; the model anchors " + fmt(have));
    },
    distance: (v, e, ctx, t) => { const it = get(t), want = 1 + n(v) / 100; return close(it?.lineSpacing, want) ? HELD : lost("line pitch " + fmt(want) + " x size; the model has " + fmt(it?.lineSpacing ?? 5 / 3)); },
    rot: (v, e, ctx, t) => {
      const it = get(t), r = rot(v);
      if (!it) return lost("text not found");
      const errs = [];
      if (angleDiff(it.angle || 0, -r.angle) > .01) errs.push("angle " + fmt(it.angle || 0) + " for " + v);
      const mirrored = typeof it.mirrored === "boolean" ? it.mirrored : /^Bottom/.test(it.layer || "");
      if (mirrored !== r.mirror) errs.push(r.mirror ? "not mirrored" : "mirrored");
      if (r.spin && it.upright !== false) errs.push("spin (no upright turn) is not kept");
      return errs.length ? lost(errs.join("; ")) : HELD;
    }
  };
}

// ------------------------------------------------------------ the table
// rule: {find(e, ctx) -> model target | null | {missing}, fields: {name: (value, e, ctx, target) -> result},
//        told: {field: RegExp} (a report reason or note that names the property), outside: {field: reason}}
const RULES = {};
const rule = (kinds, spec) => { for (const k of kinds) RULES[k] = spec; };
const OUTSIDE = {
  version: "the file format version selects how the file is read; it describes no design",
  airwireshidden: "whether the editor draws this signal's ratsnest; display only",
  "compatibility/note": "messages Eagle wrote when it converted an older file; not design content"
};
const BRD_LIB = "board/libraries/library", PKG = BRD_LIB + "/packages/package";
const SCH_LIB = "schematic/libraries/library", SYM = SCH_LIB + "/symbols/symbol", DS = SCH_LIB + "/devicesets/deviceset", SHEET = "schematic/sheets/sheet";

rule(["eagle"], {find: () => HELD, outside: {version: OUTSIDE.version}});
rule(["compatibility/note"], {find: () => null, outsideKind: OUTSIDE["compatibility/note"]});
rule(["settings/setting", "layers/layer"], {find: () => null});
rule(["grid"], {find: () => null, fields: {distance: (v, e, ctx) => {
  const docs = ctx.byFile.get(e.file).docs, want = n(v) * ({inch: 25.4, mil: .0254, mic: .001}[e.fields.unitdist] || 1);
  return docs.length && docs.every(d => close(d.grid, want)) ? HELD : lost("grid " + fmt(want) + " mm; the model grid is " + fmt(docs.map(d => d.grid).join(", ")));
}}});
// Descriptions: user-typed rich text on boards, schematics, sheets, libraries and their parts.
const descriptionTarget = (e, ctx) => {
  const t = e.fields["#text"], hits = [ctx.model, ...ctx.model.documents, ...ctx.model.library].filter(o => o?.description === t || o?.sheet?.description === t);
  return hits[0] || null;
};
rule(["board/description", "schematic/description", SHEET + "/description", BRD_LIB + "/description", SCH_LIB + "/description",
  PKG + "/description", SYM + "/description", DS + "/description", "board/designrules/description", BRD_LIB + "/packages3d/package3d/description"],
{find: descriptionTarget, fields: {"#text": (v, e, ctx, t) => t ? HELD : lost("description text not in the model"), language: (v, e, ctx, t) => t ? HELD : lost("its description is not in the model")}});

// ---- board
rule(["board"], {find: (e, ctx) => ctx.byFile.get(e.file).pcb || null});
const plainBoard = kind => ({
  find: (e, ctx) => plainTarget(ctx, e),
  fields: {
    ...Object.fromEntries(["x", "y", "x1", "y1", "x2", "y2", "x3", "y3", "radius", "drill"].map(k => [k, (v, e, ctx, t) => corners(t)])),
    layer: (v, e, ctx, t) => {
      if (!t) return lost("not found");
      if (t.outline) return +v === 20 || +v === 46 ? HELD : lost("on the outline");
      return layerHeld(boardFacts(ctx, e), +v, t);
    },
    width: (v, e, ctx, t) => {
      if (!t) return lost("not found");
      const w = n(v), name = e.node.name;
      if (t.outline) return +e.fields.layer === 20 ? HELD : w === 0 ? HELD : lost("a " + fmt(w) + " mm milling path becomes a zero-width board edge");
      if (name === "circle" && w === 0) return t.fill ? HELD : lost("width 0 is a filled disc; the model draws an outline");
      if (name === "polygon" && t.kind === "polygon") return close(t.width, w) ? HELD : lost("copper reaches " + fmt(w / 2) + " mm past the vertices (the pen width); the model pour has no width");
      return close(t.width, w) ? HELD : lost("width " + fmt(t.width) + ", source " + fmt(w));
    },
    curve: (v, e, ctx, t) => t?.outline ? (close(t.outline.curve, n(v), .01) ? HELD : lost("arc sweep " + fmt(t.outline.curve) + ", source " + v)) : t?.arc ? HELD : lost("the curve is not a true arc in the model"),
    style: (v, e, ctx, t) => lineStyle(v, t), cap: (v, e, ctx, t) => capStyle(v, t),
    rot: (v, e, ctx, t) => corners(t),
    pour: (v, e, ctx, t) => !t ? lost("not found") : v === "cutout" ? (t.cutout ? HELD : lost("a cutout polygon (a hole in pours) is a " + (t.kind === "polygon" ? "copper pour" : t.kind))) :
      v === "hatch" ? same("hatched", t.fillMode, "fill") : (t.kind !== "polygon" || (t.fillMode || "solid") === "solid") ? HELD : lost("fill " + t.fillMode),
    isolate: (v, e, ctx, t) => t?.kind === "polygon" && close(t.clearance, n(v)) ? HELD : lost("isolate " + v + "; the pour clearance is " + fmt(t?.clearance)),
    thermals: (v, e, ctx, t) => t?.kind === "polygon" ? same(v === "no" ? "direct" : "relief", t.connectStyle, "pad connection") : lost("no pour to hold thermals"),
    orphans: (v, e, ctx, t) => t?.kind === "polygon" ? (t.removeDeadCopper === !yes(v) ? HELD : lost("removeDeadCopper " + t.removeDeadCopper)) : lost("no pour to hold orphans"),
    rank: (v, e, ctx, t) => t?.kind === "polygon" ? (t.pourIndex === +v ? HELD : lost("pourIndex " + t.pourIndex + ", source " + v)) : lost("no pour to hold rank"),
    spacing: (v, e, ctx, t) => t?.kind === "polygon" && close(t.hatchPitch, n(v)) ? HELD : lost("hatch spacing " + v + "; the model pitch is " + fmt(t?.hatchPitch)),
    ...textFields(t => t)
  },
  told: {curve: /Curves were converted/, rot: /rectangle rotation was omitted/, x1: /rectangle rotation was omitted/, y1: /rectangle rotation was omitted/,
    x2: /rectangle rotation was omitted/, y2: /rectangle rotation was omitted/}
});
for (const k of ["wire", "circle", "rectangle", "polygon", "hole", "text", "dimension", "frame"]) rule(["board/plain/" + k], plainBoard(k));
// Unsupported layer notes name a layer; they count for that layer's objects only.
const vertexRule = (finder) => ({
  find: (e, ctx) => finder(ctx, e.node.parent.entry ? e.node.parent.entry : null),
  fields: {x: (v, e, ctx, t) => t ? HELD : lost("its polygon is not in the model"), y: (v, e, ctx, t) => t ? HELD : lost("its polygon is not in the model"),
    curve: (v, e, ctx, t) => t?.arc ? HELD : lost("the curved edge is not a true arc in the model")},
  told: {curve: /Curves were converted|Curved polygon edge|Curve sampled/}, parentTold: true
});
rule(["board/plain/polygon/vertex"], vertexRule((ctx, pe) => pe && plainTarget(ctx, pe)));

// Library identity: which library and which managed revision a footprint or symbol came from.
const libField = (what) => (v, e, ctx) => {
  const hit = ctx.model.library.some(d => [d.library, d.sourceLibrary, d.source?.library, d.urn, d.libraryVersion].includes(v));
  return hit ? HELD : lost(what + " " + fmt(v) + " is not recorded on any definition");
};
rule([BRD_LIB, SCH_LIB], {find: (e, ctx) => ctx.model.library.length ? ctx.model.library : null, fields: {name: libField("library name"), urn: libField("library URN")}});
rule([PKG], {
  find: (e, ctx) => ctx.model.library.find(d => d.footprint?.name === e.fields.name) || null,
  fields: {name: (v, e, ctx, t) => t ? HELD : lost("no footprint named " + v), urn: libField("package URN"), library_version: libField("library version"),
    locally_modified: (v, e, ctx, t) => t?.locallyModified === yes(v) ? HELD : lost("locally modified flag is not recorded")}
});
rule([BRD_LIB + "/packages3d/package3d", BRD_LIB + "/packages3d/package3d/packageinstances/packageinstance"], {
  find: (e, ctx) => ctx.model.library.find(d => d.footprint?.bodyModels?.length) || null,
  fields: {name: (v, e, ctx, t) => t ? HELD : lost("no 3D body"), urn: libField("3D package URN"), type: (v, e, ctx, t) => t ? HELD : lost("no 3D body"), library_version: libField("library version")}
});

// Pads and SMDs, compared at the size Eagle manufactures.
function padExpect(facts, a, smd) {
  if (smd) return {w: n(a.dx), h: n(a.dy)};
  const drill = n(a.drill, .8), d = n(a.diameter, 0), top = Math.max(d, drill + 2 * facts.ring(drill, "PadTop")), bottom = Math.max(d, drill + 2 * facts.ring(drill, "PadBottom"));
  const shape = a.shape || "round", long = shape === "long" || shape === "offset";
  const grow = d0 => long ? d0 * (1 + facts.elongation[shape] / 100) : d0;
  return {w: grow(top), h: top, bottom: {w: grow(bottom), h: bottom}, drill};
}
function padTurn(pl, a) {
  // The pad's long axis in Eagle's world, then in Waffle's (Y down: the angle changes sign).
  const r = rot(a.rot).angle, eagle = pl.r.mirror ? 180 - (pl.r.angle + r) : pl.r.angle + r;
  return -eagle;
}
const padFields = smd => ({
  name: (v, e, ctx, t) => t?.hit ? HELD : lost(t?.missing || "pad not found"),
  x: (v, e, ctx, t) => t?.hit ? HELD : lost(t?.missing || "pad not found"),
  y: (v, e, ctx, t) => t?.hit ? HELD : lost(t?.missing || "pad not found"),
  ...Object.fromEntries((smd ? ["dx", "dy", "rot"] : ["diameter", "rot", "drill"]).map(k => [k, (v, e, ctx, t) => {
    if (!t?.hit) return lost(t?.missing || "pad not found");
    const p = t.hit, want = padExpect(t.pl.facts, e.fields, smd), turnW = padTurn(t.pl, e.fields), have = (p.angle || 0) + (t.pl.part.angle || 0);
    if (k === "drill") return close(p.drill, want.drill) ? HELD : lost("drill " + fmt(p.drill) + ", source " + fmt(want.drill));
    const straight = angleDiff(have, turnW, 180) < .01, across = angleDiff(have, turnW + 90, 180) < .01;
    if (k === "rot") return straight || across || close(p.w, p.h) && angleDiff(have, turnW, 90) < .01 ? HELD : lost("pad turned " + fmt(have) + " deg; Eagle turns it " + fmt(turnW) + " deg");
    const fits = close(p.w, want.w) && close(p.h, want.h) && (straight || close(p.w, p.h)) || close(p.w, want.h) && close(p.h, want.w) && across;
    if (!fits) return lost("pad " + fmt(p.w) + " x " + fmt(p.h) + " at " + fmt(have) + " deg; Eagle makes " + fmt(want.w) + " x " + fmt(want.h) + " at " + fmt(turnW) + " deg");
    if (!smd && k === "diameter" && !(close(want.bottom.w, want.w) && close(want.bottom.h, want.h))) {
      const b = p.padStack?.Bottom || p.padStack?.bottom;
      if (!(b && close(b.w, want.bottom.w) && close(b.h, want.bottom.h))) return lost("bottom land " + fmt(want.bottom.w) + " x " + fmt(want.bottom.h) + " (bottom restring); the model has one land size");
    }
    return HELD;
  }])),
  layer: (v, e, ctx, t) => t?.hit ? layerHeld(t.pl.facts, +v, t.hit, t.pl.r.mirror) : lost(t?.missing || "pad not found"),
  roundness: (v, e, ctx, t) => {
    if (!t?.hit) return lost(t?.missing || "pad not found");
    const p = t.hit, r = n(v);
    if (r >= 100) return p.shape === (close(p.w, p.h) ? "round" : "oval") ? HELD : lost("fully rounded; the model shape is " + p.shape);
    if (r <= 0) return p.shape === "rect" ? HELD : lost("square corners; the model shape is " + p.shape);
    const ratio = Number.isFinite(p.roundrectRadiusRatio) ? p.roundrectRadiusRatio : .18;
    return p.shape === "roundrect" && close(ratio, r / 200, 1e-3) ? HELD : lost("corner radius " + fmt(r / 200) + " of the short side; the model uses " + fmt(ratio) + (Number.isFinite(p.roundrectRadiusRatio) ? "" : " (the default)"));
  },
  shape: (v, e, ctx, t) => {
    if (!t?.hit) return lost(t?.missing || "pad not found");
    const p = t.hit, want = {square: "rect", round: "round", octagon: "octagon", long: "oval", offset: "oval"}[v];
    if (p.shape !== want) return lost("shape " + p.shape + ", source " + v);
    if (v === "long" || v === "offset") {
      const ex = padExpect(t.pl.facts, e.fields, false);
      if (!close(Math.max(p.w, p.h), ex.w)) return lost(v + " pad length " + fmt(Math.max(p.w, p.h)) + "; Eagle's elongation " + t.pl.facts.elongation[v] + "% makes " + fmt(ex.w));
      if (v === "offset") return lost("offset pads extend to one side of the drill; the model centres the land on it");
    }
    return HELD;
  },
  stop: (v, e, ctx, t) => {
    if (!t?.hit) return lost(t?.missing || "pad not found");
    const tent = t.hit.tent || {};
    return yes(v) ? (tent.top || tent.bottom ? lost("tented") : HELD) : (smd ? (tent.top || tent.bottom) : (tent.top && tent.bottom)) ? HELD : lost("stop=no (no solder-mask opening); the model pad has an opening");
  },
  cream: (v, e, ctx, t) => !t?.hit ? lost(t?.missing || "pad not found") : yes(v) === !t.hit.noPaste ? HELD : lost("cream=no (no paste); the model pad gets paste"),
  thermals: (v, e, ctx, t) => {
    if (!t?.hit) return lost(t?.missing || "pad not found");
    if (yes(v)) return HELD;
    const ref = t.pl.part.ref, pad = String(t.hit.number), direct = ctx.rules.some(r => r.type === "polygonConnect" && r.style === "direct" && (r.scope?.source || "").includes(ref)) ||
      ctx.byFile.get(e.file).pcb.items.some(it => it.kind === "polygon" && Object.entries(it.connectOverrides || {}).some(([k, s]) => s === "direct" && k.includes(ref)));
    return direct || t.hit.connectStyle === "direct" ? HELD : lost("thermals=no (solid connection to pours) for " + ref + "." + pad + "; pours connect it with reliefs");
  },
  first: (v, e, ctx, t) => {
    const ps = parseFloat(t?.pl?.facts.dr.psFirst ?? "0");
    return !yes(v) || !(ps > 0) ? HELD : lost("first-pad shape rule psFirst " + ps + " is not applied");
  }
});
rule([PKG + "/smd"], {find: (e, ctx) => packageTarget(ctx, e), fields: padFields(true), told: {roundness: /Roundness mapped/}});
rule([PKG + "/pad"], {find: (e, ctx) => packageTarget(ctx, e), fields: padFields(false), told: (e, name) => name === "shape" && e.fields.shape === "offset" ? /Offset pad/ : null});
rule([PKG + "/hole"], {find: (e, ctx) => packageTarget(ctx, e), fields: {
  x: (v, e, ctx, t) => t?.hit ? HELD : lost(t?.missing), y: (v, e, ctx, t) => t?.hit ? HELD : lost(t?.missing),
  drill: (v, e, ctx, t) => t?.hit ? (close(t.hit.drill, n(v)) ? HELD : lost("drill " + fmt(t.hit.drill))) : lost(t?.missing)}});
const pkgShape = {
  find: (e, ctx) => packageTarget(ctx, e),
  fields: {
    ...Object.fromEntries(["x", "y", "x1", "y1", "x2", "y2", "radius"].map(k => [k, (v, e, ctx, t) => t?.hit ? corners(t.hit) : lost(t?.missing || "not found")])),
    layer: (v, e, ctx, t) => {
      if (!t?.hit) return lost(t?.missing || "not found");
      if (t.hit.outline) return HELD;
      if (t.hit.field) return HELD;
      const s = t.hit, l = +v, el = t.pl.r.mirror && SWAP[l] ? SWAP[l] : l;
      // Package graphics on Eagle's tDocu/bDocu layers draw the part's body: Waffle's "package" style.
      if (!s.layer && s.style === "package") return [51, 52].includes(el) ? HELD : lost("drawn as the package body; source layer " + l);
      return layerHeld(t.pl.facts, l, s, t.pl.r.mirror);
    },
    width: (v, e, ctx, t) => {
      if (!t?.hit) return lost(t?.missing || "not found");
      const s = t.hit, w = n(v);
      if (e.node.name === "circle") return (w === 0 ? !!s.fill : close(s.width, w)) || (n(e.fields.radius) === 0 && s.fill && close(s.r * 2, w)) ? HELD : lost("width " + fmt(s.width));
      if (e.node.name === "polygon") return close(s.width, w) ? HELD : lost("width " + fmt(s.width));
      return close(s.width, w) ? HELD : lost("width " + fmt(s.width) + ", source " + fmt(w));
    },
    curve: (v, e, ctx, t) => t?.hit?.arc ? HELD : lost("the curve is not a true arc in the model"),
    style: (v, e, ctx, t) => lineStyle(v, t?.hit), cap: (v, e, ctx, t) => capStyle(v, t?.hit),
    rot: (v, e, ctx, t) => {
      if (!t?.hit) return lost(t?.missing || "not found");
      if (e.node.name === "rectangle") return corners(t.hit);
      if (t.hit.field) return lost("the " + t.hit.field + " placeholder's rotation is not kept");
      return angleDiff((t.hit.angle || 0) + (t.pl.part.angle || 0), padTurn(t.pl, e.fields)) < .01 ? HELD : lost("text angle " + fmt((t.hit.angle || 0) + (t.pl.part.angle || 0)));
    },
    ...textFields(t => t?.hit?.field ? null : t?.hit),
    "#text": (v, e, ctx, t) => t?.hit?.field ? HELD : t?.hit ? same(v, t.hit.text, "text") : lost(t?.missing || "text not found")
  },
  told: {curve: /Curves were converted/, ...Object.fromEntries(["rot", "x1", "y1", "x2", "y2"].map(k => [k, /rectangle rotation was omitted/]))}
};
for (const k of ["wire", "circle", "rectangle", "polygon", "text", "dimension", "frame"]) rule([PKG + "/" + k], pkgShape);
// >NAME and >VALUE in a package place the designator; its font and size are the part's label.
const placeholder = pkgShape.fields;
for (const k of ["size", "ratio", "font", "align"]) {
  const plain = placeholder[k];
  placeholder[k] = (v, e, ctx, t) => t?.hit?.field ? labelField(k, v, e, t.pl.part, t.hit.field) : plain(v, e, ctx, t);
}
function labelField(k, v, e, part, field) {
  const lab = (part.boardLabels || []).find(l => l.field === field);
  // Without a font of its own the label draws in Waffle's stroke font, which is Eagle's vector font.
  if (k === "font" && !lab?.font) return fontOf(e, v) === "vector" ? HELD : lost(fontOf(e, v) + " font");
  if (!lab) return lost("the " + field + " label's " + k + " is not kept (no board label)");
  if (k === "size") return sameMm(v, lab.size, field + " label size");
  if (k === "ratio") return close(lab.width, n(e.fields.size) * n(v) / 100) ? HELD : lost(field + " label stroke " + fmt(lab.width));
  if (k === "font") return fontOf(e, v) === "vector" ? HELD : lost(fontOf(e, v) + " font");
  if (k === "align") return lab.justify === v ? HELD : lost("anchor " + fmt(lab.justify));
  return lost(k);
}
rule([PKG + "/polygon/vertex"], vertexRule((ctx, pe) => pe && packageTarget(ctx, pe)?.hit));

// Global attributes, variants, net classes and design rules.
rule(["board/attributes/attribute", "schematic/attributes/attribute"], {
  find: (e, ctx) => { const p = ctx.model.parameters; const list = Array.isArray(p) ? p : p ? Object.entries(p).map(([name, value]) => ({name, value})) : []; return list.find(q => q.name === e.fields.name) || null; },
  fields: {name: (v, e, ctx, t) => t ? HELD : lost("no project parameter " + v), value: (v, e, ctx, t) => t ? same(v, String(t.value), "value") : lost("no project parameter " + e.fields.name), constant: (v, e, ctx, t) => t ? HELD : lost("no project parameter")}
});
rule(["board/variantdefs/variantdef", "schematic/variantdefs/variantdef"], {
  find: (e, ctx) => (ctx.model.variants || []).find(x => x.name === e.fields.name) || null,
  fields: {name: (v, e, ctx, t) => t ? HELD : lost("no variant " + v), current: (v, e, ctx, t) => t && (ctx.model.activeVariant === t.id) === yes(v) ? HELD : lost("active variant not set")}
});
const variantField = (v, e, ctx) => lost("assembly variant " + (e.fields.name || "") + " is not in the model");
rule(["board/elements/element/variant", "schematic/parts/part/variant"], {find: (e, ctx) => (ctx.model.variants || []).find(x => x.name === e.fields.name) || null,
  fields: {name: variantField, populate: variantField, value: variantField, technology: variantField}});
// A class's nets: the signals (board) that name it.
function classNets(ctx, e, number) {
  const facts = boardFacts(ctx, e);
  return facts.signals.filter(s => (s.attrs.class || "0") === number).map(s => s.attrs.name);
}
const scopeNets = s => [...String(s?.source || "").matchAll(/"([^"]*)"/g)].map(m => m[1]);
const covers = (scope, nets, all) => {
  const src = String(scope?.source || "").trim();
  if (src === "object") return all;
  const named = new Set(scopeNets(scope));
  return nets.length > 0 && nets.every(x => named.has(x)) && named.size === nets.length;
};
function classRule(ctx, e, type, value, pick) {
  const number = e.fields.number ?? e.node.parent.attrs.number, nets = classNets(ctx, e, number), def = number === "0";
  const rules = ctx.rules.filter(r => r.type === type && covers(r.scope, nets, def));
  return rules.find(r => close(pick(r), value)) ? HELD : lost(type + " " + fmt(value) + " for class " + number + " (" + (nets.join(", ") || "no signals") + "); the model has " + fmt(rules.map(pick).join(", ") || "none"));
}
rule(["board/classes/class"], {
  find: (e, ctx) => ctx.rules.length ? ctx.rules : null,
  fields: {
    number: () => outside("an index linking signals to their class; membership is checked through signal.class"),
    name: (v, e, ctx) => {
      const nc = ctx.model.rules?.netClasses || ctx.byFile.get(e.file).pcb?.rules?.netClasses || ctx.model.netClasses;
      return nc && Object.hasOwn(nc, v) ? HELD : lost("net class name " + fmt(v) + " is not in the model (rules are scoped to net names)");
    },
    width: (v, e, ctx) => n(v) > 0 ? classRule(ctx, e, "width", n(v), r => r.min) : HELD,
    drill: (v, e, ctx) => n(v) > 0 ? classRule(ctx, e, "viaStyle", n(v), r => r.holeMin) : HELD
  },
  told: {}
});
rule(["board/classes/class/clearance"], {
  find: (e, ctx) => ctx.rules.length ? ctx.rules : null,
  fields: {
    class: () => HELD,
    value: (v, e, ctx) => {
      const a = e.node.parent.attrs.number, b = e.fields.class, gap = n(v);
      if (!(gap > 0)) return HELD;
      const na = classNets(ctx, e, a), nb = classNets(ctx, e, b);
      const hit = ctx.rules.find(r => r.type === "clearance" && close(r.gap, gap) &&
        (covers(r.scope, na, a === "0") && covers(r.scope2, nb, b === "0") || covers(r.scope, nb, b === "0") && covers(r.scope2, na, a === "0")));
      if (hit) return HELD;
      const near = ctx.rules.filter(r => r.type === "clearance" && close(r.gap, gap)).map(r => (r.scope?.source || "") + " / " + (r.scope2?.source || ""));
      return lost("clearance " + fmt(gap) + " between class " + a + " and class " + b + (near.length ? "; the model applies it to " + near.join(" | ") : "; no such rule"));
    }
  }
});
// Design rules: each <param> is a field of <designrules>.
const DR_MD = ["mdWireWire", "mdWirePad", "mdWireVia", "mdPadPad", "mdPadVia", "mdViaVia", "mdSmdPad", "mdSmdVia", "mdSmdSmd"];
rule(["board/designrules"], {
  find: (e, ctx) => ctx.rules.length ? ctx.rules : null,
  fields: {
    name: (v, e, ctx) => ctx.rules.some(r => String(r.origin?.set || r.comment || "").includes(v)) ? HELD : lost("rule set name " + fmt(v) + " is not recorded"),
    ...Object.fromEntries(DR_MD.map(k => [k, (v, e, ctx) => ctx.rules.some(r => r.type === "clearance" && String(r.scope?.source).trim() === "object" && close(r.gap, n(v))) &&
      DR_MD.every(o => !e.fields[o] || close(n(e.fields[o]), n(v))) ? HELD : lost(k + " " + fmt(n(v)) + " mm is one of " + DR_MD.length + " pair clearances; the model has one board clearance")])),
    msWidth: (v, e, ctx) => ctx.rules.some(r => r.type === "width" && String(r.scope?.source).trim() === "object" && close(r.min, n(v))) ? HELD : lost("minimum width " + fmt(n(v)) + " not in the rules"),
    msDrill: (v, e, ctx) => ctx.rules.some(r => r.type === "viaStyle" && String(r.scope?.source).trim() === "object" && close(r.holeMin, n(v))) ? HELD : lost("minimum drill " + fmt(n(v)) + " not in the rules"),
    mdCopperDimension: (v, e, ctx) => ctx.rules.some(r => /board|edge|outline/i.test(r.type) && close(r.gap ?? r.min, n(v))) ? HELD : lost("copper to board edge " + fmt(n(v)) + " mm not in the rules"),
    mdDrill: (v, e, ctx) => ctx.rules.some(r => r.type === "holeToHole" && r.origin?.kind !== "default" && close(r.gap, n(v))) ? HELD : lost("drill to drill " + fmt(n(v)) + " mm; the model has the default " + fmt(ctx.rules.find(r => r.type === "holeToHole")?.gap)),
    mlMinStopFrame: (v, e, ctx) => ctx.rules.some(r => r.type === "solderMask" && r.origin?.kind !== "default" && close(r.expansion, n(v))) ? HELD : lost("solder-mask expansion " + fmt(n(v)) + " mm; the model has the default " + fmt(ctx.rules.find(r => r.type === "solderMask")?.expansion)),
    mlMinCreamFrame: (v, e, ctx) => ctx.rules.some(r => r.type === "pasteMask" && r.origin?.kind !== "default" && close(-r.expansion, n(v))) ? HELD : lost("paste reduction " + fmt(n(v)) + " mm; the model has the default " + fmt(ctx.rules.find(r => r.type === "pasteMask")?.expansion))
  },
  told: (e, name) => /^md(Wire|Pad|Via|Smd)/.test(name) ? /Pair-specific/ : /^r[vl]/.test(name) ? /rule itself was not retained/ : name === "layerSetup" ? /layer setup/i : null
});
rule(["board/autorouter/pass"], {find: () => null});

// Elements: the placed footprints.
const partOf = (e, ctx) => ctx.byFile.get(e.file).parts.get(e.fields.name)?.[0]?.item || null;
rule(["board/elements/element"], {
  find: partOf,
  fields: {
    name: (v, e, ctx, t) => t ? HELD : lost("no part " + v),
    value: (v, e, ctx, t) => t ? same(v, t.value, "value") : lost("no part"),
    package: (v, e, ctx, t) => t ? same(v, ctx.defs.get(t.def)?.footprint?.name, "footprint") : lost("no part"),
    library: libField("library name"), library_urn: libField("library URN"),
    package3d_urn: (v, e, ctx, t) => t?.bodies3d?.length || ctx.defs.get(t?.def)?.footprint?.bodyModels?.length ? HELD : lost("3D package " + v + " is not linked"),
    x: (v, e, ctx, t) => t ? (close(t.x, n(v)) ? HELD : lost("x " + fmt(t.x))) : lost("no part"),
    y: (v, e, ctx, t) => t ? (close(t.y, -n(v)) ? HELD : lost("y " + fmt(t.y))) : lost("no part"),
    rot: (v, e, ctx, t) => {
      if (!t) return lost("no part");
      const r = rot(v), errs = [];
      if (angleDiff(t.angle || 0, r.mirror ? r.angle : -r.angle) > .01) errs.push("angle " + fmt(t.angle));
      if ((t.layer === "Bottom") !== r.mirror) errs.push("side " + t.layer);
      if (r.spin && !(t.boardLabels || []).some(l => l.upright === false)) errs.push("spin (texts not kept upright) is not kept");
      return errs.length ? lost(errs.join("; ")) : HELD;
    },
    locked: (v, e, ctx, t) => t && !!t.locked === yes(v) ? HELD : lost("locked " + v + "; the model part is " + (t?.locked ? "locked" : "not locked")),
    populate: (v, e, ctx, t) => t && !!t.dnp === (v === "no") ? HELD : lost("populate " + v + "; the model part is " + (t?.dnp ? "do-not-populate" : "populated")),
    smashed: (v, e, ctx, t) => !yes(v) || t?.refAt || t?.boardLabels?.length ? HELD : lost("smashed labels have no separate position")
  }
});
// Element attributes: NAME and VALUE place the designator and value; others are the part's properties.
rule(["board/elements/element/attribute"], {
  find: (e, ctx) => ctx.byFile.get(e.file).parts.get(e.node.parent.attrs.name)?.[0]?.item || null,
  fields: attributeFields("board")
});
function attributeFields(where) {
  const role = e => e.fields.name === "NAME" ? "ref" : e.fields.name === "VALUE" ? "value" : null;
  const labelAt = (e, t) => role(e) && t[role(e) + "At"];
  const where2 = (e, t) => {
    const at = labelAt(e, t);
    if (!at) return null;
    if (where === "board") return placeW({x: t.x, y: t.y, angle: t.angle}, at);
    return placeW(t, at);
  };
  const lab = (e, t) => (t.boardLabels || []).find(l => l.field === role(e));
  return {
    name: (v, e, ctx, t) => !t ? lost("part not found") : role(e) ? (labelAt(e, t) || role(e) === "value" && t.value != null ? HELD : lost(v + " position not kept")) :
      t.parameters && Object.hasOwn(t.parameters, v) || ctx.defs.get(t.def)?.parameters && Object.hasOwn(ctx.defs.get(t.def).parameters, v) ? HELD : lost("no parameter " + v + " on " + t.ref),
    value: (v, e, ctx, t) => {
      if (!t) return lost("part not found");
      if (role(e) === "value") return same(v, t.value, "value");
      if (role(e) === "ref") return same(v, t.ref, "designator");
      const p = t.parameters?.[e.fields.name] ?? ctx.defs.get(t.def)?.parameters?.[e.fields.name];
      return p != null ? same(v, String(p), e.fields.name) : lost(e.fields.name + "=" + v + " is not on " + t.ref);
    },
    x: (v, e, ctx, t) => posField(e, t, where2),
    y: (v, e, ctx, t) => posField(e, t, where2),
    display: (v, e, ctx, t) => {
      if (!t) return lost("part not found");
      const r = role(e);
      if (r) {
        const shown = t[r === "ref" ? "showRef" : "showValue"] !== false;
        if (v === "off") return shown ? lost("hidden in Eagle; shown in the model") : HELD;
        if (v === "value") return shown ? HELD : lost("hidden in the model");
        return lost("display " + v + " (\"" + e.fields.name + " = ...\") is not kept");
      }
      const shown = t.paramShow?.[e.fields.name] === true;
      if (v === "off") return shown ? lost("shown") : HELD;
      return shown ? (v === "value" ? HELD : lost("display " + v + " is shown as the value only")) : lost(e.fields.name + " is shown in Eagle; not in the model");
    },
    size: (v, e, ctx, t) => labelProp(e, t, "size", v),
    layer: (v, e, ctx, t) => labelProp(e, t, "layer", v),
    ratio: (v, e, ctx, t) => labelProp(e, t, "ratio", v),
    font: (v, e, ctx, t) => labelProp(e, t, "font", v),
    rot: (v, e, ctx, t) => labelProp(e, t, "rot", v),
    align: (v, e, ctx, t) => labelProp(e, t, "align", v),
    constant: (v) => dflt(v, "no", "constant=" + v + " (the value may not be changed per part) is not kept")
  };
  function posField(e, t, at) {
    if (!t) return lost("part not found");
    const p = at(e, t), src = W([n(e.fields.x), n(e.fields.y)]);
    if (!role(e)) return lost(e.fields.name + " is drawn at a position; the model has no placed property text");
    return p && closeP(p, src) ? HELD : lost(e.fields.name + " drawn at " + fmt(src) + "; the model puts it at " + fmt(p));
  }
  function labelProp(e, t, k, v) {
    if (!t) return lost("part not found");
    if (!role(e)) return lost(e.fields.name + " text " + k + " has nothing to land on");
    if (k === "font") return fontOf(e, v) === "vector" ? HELD : lost(fontOf(e, v) + " font");
    const l = where === "board" ? lab(e, t) : t[role(e) + "Text"];
    if (!l) return lost("the " + e.fields.name + " text " + k + " " + v + " is not kept");
    if (k === "size") return sameMm(v, l.size, "size");
    if (k === "rot") return angleDiff(l.angle || 0, -rot(v).angle) < .01 ? HELD : lost("angle " + fmt(l.angle));
    if (k === "layer") return HELD;
    return lost(k);
  }
}

// Signals.
const signalItems = (e, ctx) => ctx.byFile.get(e.file).pcb?.items.filter(it => it.net === e.fields.name) || [];
rule(["board/signals/signal"], {
  find: (e, ctx) => { const v = ctx.byFile.get(e.file); return signalItems(e, ctx).length || [...v.parts.values()].some(l => Object.values(l[0].item.pinNets || {}).includes(e.fields.name)) ? HELD : null; },
  fields: {
    name: (v, e, ctx, t) => t ? HELD : lost("no object carries net " + v),
    class: (v, e, ctx) => {
      if (v === "0") return HELD;
      const cls = kids(kid(boardFacts(ctx, e).brd, "classes"), "class").find(c => c.attrs.number === v);
      if (!cls) return lost("class " + v + " is not defined");
      const wants = [["width", n(cls.attrs.width), r => r.min], ["viaStyle", n(cls.attrs.drill), r => r.holeMin]].filter(w => w[1] > 0);
      const miss = wants.filter(([type, val, pick]) => !ctx.rules.some(r => r.type === type && scopeNets(r.scope).includes(e.fields.name) && close(pick(r), val)));
      return miss.length ? lost("class " + v + " " + miss.map(m => m[0]).join(", ") + " not applied to " + e.fields.name) : HELD;
    },
    airwireshidden: () => outside(OUTSIDE.airwireshidden)
  }
});
rule(["board/signals/signal/contactref"], {
  find: (e, ctx) => ctx.byFile.get(e.file).parts.get(e.fields.element)?.[0]?.item || null,
  fields: {
    element: (v, e, ctx, t) => t ? HELD : lost("no part " + v),
    pad: (v, e, ctx, t) => t?.pinNets?.[v] === e.node.parent.attrs.name ? HELD : lost(e.fields.element + "." + v + " is on " + fmt(t?.pinNets?.[v]) + ", source " + e.node.parent.attrs.name),
    route: (v) => dflt(v, "all", "route=" + v + " (only one of the pads joined by this contact must be routed) is not kept"),
    routetag: (v) => lost("route tag " + fmt(v) + " is not kept")
  }
});
rule(["board/signals/signal/wire"], {
  find: (e, ctx) => {
    const a = e.fields, p1 = W([n(a.x1), n(a.y1)]), p2 = W([n(a.x2), n(a.y2)]), net = e.node.parent.attrs.name;
    return ctx.byFile.get(e.file).pcb?.items.find(it => it.kind === "track" && it.net === net && endsMatch(it.points, p1, p2)) || null;
  },
  fields: {
    ...Object.fromEntries(["x1", "y1", "x2", "y2"].map(k => [k, (v, e, ctx, t) => t ? HELD : lost("no track between its ends")])),
    width: (v, e, ctx, t) => t ? sameMm(v, t.width, "width") : lost("no track"),
    layer: (v, e, ctx, t) => t ? layerHeld(boardFacts(ctx, e), +v, t) : lost("no track"),
    curve: (v, e, ctx, t) => t?.arc ? HELD : lost("the curve is not a true arc"),
    style: (v, e, ctx, t) => lineStyle(v, t), cap: (v, e, ctx, t) => capStyle(v, t),
    extent: (v) => lost("extent " + v)
  },
  told: {curve: /Curves were converted|Curved tracks/}
});
rule(["board/signals/signal/via"], {
  find: (e, ctx) => ctx.byFile.get(e.file).pcb?.items.find(it => it.kind === "via" && closeP([it.x, it.y], W([n(e.fields.x), n(e.fields.y)]))) || null,
  fields: {
    x: (v, e, ctx, t) => t ? HELD : lost("no via"), y: (v, e, ctx, t) => t ? HELD : lost("no via"),
    drill: (v, e, ctx, t) => t ? sameMm(v, t.drill, "drill") : lost("no via"),
    diameter: (v, e, ctx, t) => {
      if (!t) return lost("no via");
      const f = boardFacts(ctx, e), drill = n(e.fields.drill), d = n(v), outer = Math.max(d, drill + 2 * f.ring(drill, "ViaOuter")), inner = Math.max(d, drill + 2 * f.ring(drill, "ViaInner"));
      if (!close(t.diameter, outer)) return lost("diameter " + fmt(t.diameter) + "; Eagle's restring makes " + fmt(outer));
      if (!close(inner, outer) && !(t.padStack || t.innerDiameter)) return lost("inner-layer diameter " + fmt(inner) + " (via inner restring); the model has one diameter");
      return HELD;
    },
    extent: (v, e, ctx, t) => {
      if (!t) return lost("no via");
      const [a, b] = String(v).split("-").map(Number), f = boardFacts(ctx, e);
      if (a === 1 && b === 16) return t.fromLayer ? lost("span " + t.fromLayer + "-" + t.toLayer) : HELD;
      return t.fromLayer === f.copper(a) && t.toLayer === f.copper(b) ? HELD : lost("span " + fmt(t.fromLayer) + "-" + fmt(t.toLayer) + ", source " + v);
    },
    shape: (v, e, ctx, t) => v === "round" || t?.shape === (v === "square" ? "rect" : v) ? HELD : lost(v + " via land; the model via is round"),
    alwaysstop: (v, e, ctx, t) => !yes(v) || t?.tent && t.tent.top === false && t.tent.bottom === false ? HELD : lost("alwaysstop (a solder-mask opening whatever the drill) is not kept; the model via follows the tenting default")
  },
  told: {extent: /via span/}
});
const pourRule = {
  find: (e, ctx) => {
    const ring = kids(e.node, "vertex").map(v => W([n(v.attrs.x), n(v.attrs.y)])), net = e.node.parent.attrs.name;
    return ctx.byFile.get(e.file).pcb?.items.find(it => it.kind === "polygon" && it.net === net && ringMatch(it.points, ring)) || null;
  },
  fields: {
    layer: (v, e, ctx, t) => t ? layerHeld(boardFacts(ctx, e), +v, t) : lost("no pour"),
    width: (v, e, ctx, t) => {
      if (!t) return lost("no pour");
      if (e.fields.pour === "hatch" && close(t.hatchWidth, n(v)) && close(t.width ?? t.hatchWidth, n(v))) return HELD;
      return close(t.width, n(v)) ? HELD : lost("copper reaches " + fmt(n(v) / 2) + " mm past the vertices (the pen width " + v + ")" + (e.fields.pour === "hatch" ? "; only the hatch width is kept" : "; the model pour has no width"));
    },
    ...Object.fromEntries(["isolate", "thermals", "orphans", "rank", "spacing", "pour"].map(k => [k, (v, e, ctx, t) => plainBoard().fields[k](v, e, ctx, t)]))
  }
};
rule(["board/signals/signal/polygon"], pourRule);
rule(["board/signals/signal/polygon/vertex"], vertexRule((ctx, pe) => pe && pourRule.find(pe, ctx)));
rule(["board/errors/approved"], {find: () => null, fields: {hash: v => lost("approved DRC error " + v + " is not kept")}});

// ---- schematic
rule(["schematic"], {
  find: (e, ctx) => ctx.byFile.get(e.file).docs[0] || null,
  fields: {xreflabel: (v, e, ctx, t) => t?.xrefLabel === v ? HELD : lost("cross-reference label format " + fmt(v) + " is not kept"),
    xrefpart: (v, e, ctx, t) => t?.xrefPart === v ? HELD : lost("part cross-reference format " + fmt(v) + " is not kept")}
});
const sheetDoc = (ctx, e) => {
  const sheet = e.node.name === "sheet" ? e.node : up(e.node, "sheet"), i = sheet && sheet.parent.kids.filter(k => k.name === "sheet").indexOf(sheet);
  return sheet ? ctx.byFile.get(e.file).docs[i] || null : null;
};
rule([SHEET], {find: (e, ctx) => sheetDoc(ctx, e)});
// Symbol children: checked where the first instance of a gate that draws the symbol places them.
function symbolHost(ctx, e) {
  const sym = up(e.node, "symbol"), lib = up(e.node, "library"), root = rootOf(e.node), sch = kid(kid(kid(root, "eagle"), "drawing"), "schematic");
  for (const part of kids(kid(sch, "parts"), "part")) {
    if (part.attrs.library !== lib.attrs.name) continue;
    const ds = kids(kid(lib, "devicesets"), "deviceset").find(d => d.attrs.name === part.attrs.deviceset);
    const gates = kids(kid(ds, "gates"), "gate"), gate = gates.find(g => g.attrs.symbol === sym.attrs.name);
    if (!gate) continue;
    for (const sheet of kids(kid(sch, "sheets"), "sheet")) for (const inst of kids(kid(sheet, "instances"), "instance")) {
      if (inst.attrs.part !== part.attrs.name || inst.attrs.gate !== gate.attrs.name) continue;
      const unit = gates.length > 1 ? gates.indexOf(gate) + 1 : 0;
      const list = ctx.byFile.get(e.file).parts.get(part.attrs.name) || [];
      const item = list.find(x => (x.item.unit || 0) === unit)?.item;
      const power = !item && ctx.byFile.get(e.file).items.find(x => x.item.kind === "power" && closeP([x.item.x, x.item.y], W(eaglePlace([n(inst.attrs.x), n(inst.attrs.y)], rot(inst.attrs.rot), [n(kid(sym, "pin")?.attrs.x), n(kid(sym, "pin")?.attrs.y)]))))?.item;
      if (power) return {power, inst};
      if (!item) return {missing: "instance " + part.attrs.name + " " + gate.attrs.name + " is not in the model"};
      const def = ctx.defs.get(item.def), r = rot(inst.attrs.rot), at = [n(inst.attrs.x), n(inst.attrs.y)];
      return {item, def, unit, r, inst, gate, device: kids(kid(ds, "devices"), "device").find(d => (d.attrs.name || "") === (part.attrs.device || "")),
        world: p => W(eaglePlace(at, r, [n(p[0]), n(p[1])])), model: q => placeW(item, q),
        mine: s => !unit || !s.part || s.part === unit};
    }
  }
  return {missing: "no instance draws symbol " + sym.attrs.name};
}
function symbolTarget(ctx, e) {
  const h = symbolHost(ctx, e);
  if (h.missing || h.power) return h;
  const a = e.node.attrs, name = e.node.name, sy = h.def?.symbol;
  if (!sy) return {missing: "definition has no symbol"};
  const shapes = sy.shapes.filter(h.mine), mw = q => h.model(q);
  let hit = null;
  if (name === "pin") {
    const at = h.world([a.x, a.y]);
    hit = sy.pins.filter(h.mine).find(p => closeP(mw([p.x, p.y]), at));
  } else if (name === "wire") hit = shapes.find(s => s.kind === "path" && !s.closed && endsMatch(s.points?.map(mw), h.world([a.x1, a.y1]), h.world([a.x2, a.y2])));
  else if (name === "circle") hit = shapes.find(s => s.kind === "circle" && closeP(mw([s.x, s.y]), h.world([a.x, a.y])));
  else if (name === "rectangle" || name === "frame") hit = findRect(a, p => W(eaglePlace([n(h.inst.attrs.x), n(h.inst.attrs.y)], h.r, p)), ring => shapes.find(s => s.kind === "path" && s.closed && ringMatch(s.points?.map(mw), ring)));
  else if (name === "polygon") { const ring = kids(e.node, "vertex").map(v => h.world([v.attrs.x, v.attrs.y])); hit = shapes.find(s => s.kind === "path" && s.closed && ringMatch(s.points?.map(mw), ring)); }
  else if (name === "text") {
    const t = textOf(e.node), at = h.world([a.x, a.y]);
    if (/^>NAME$/i.test(t)) hit = h.item.refAt && {field: "ref", at: mw(h.item.refAt)};
    else if (/^>VALUE$/i.test(t)) hit = h.item.valueAt && {field: "value", at: mw(h.item.valueAt)};
    else hit = shapes.find(s => s.kind === "text" && s.text === t && closeP(mw([s.x, s.y]), at));
  }
  return hit ? {h, hit} : {missing: "no " + name + " of symbol " + up(e.node, "symbol").attrs.name + " where " + h.item.ref + " places it"};
}
const PIN_LEN = {point: 0, short: 2.54, middle: 5.08, long: 7.62};
const PIN_TYPE = {in: 0, io: 1, out: 2, oc: 3, pas: 4, hiz: 5, pwr: 7};
const symGeom = k => (v, e, ctx, t) => t?.power ? HELD : t?.hit ? corners(t.hit) : lost(t?.missing || "not found");
const pinRule = {
  find: (e, ctx) => symbolTarget(ctx, e),
  fields: {
    x: symGeom(), y: symGeom(),
    name: (v, e, ctx, t) => t?.power ? HELD : t?.hit ? same(v.replace(/@\d+$/, ""), t.hit.name, "pin name") : lost(t?.missing),
    direction: (v, e, ctx, t) => {
      if (t?.power) return v === "sup" ? HELD : lost(v);
      if (!t?.hit) return lost(t?.missing);
      return Object.hasOwn(PIN_TYPE, v) ? same(PIN_TYPE[v], t.hit.electrical, "electrical type") : lost("pin direction " + v + " has no Waffle pin type; the model pin is type " + t.hit.electrical);
    },
    length: (v, e, ctx, t) => pinBody(v, e, t), rot: (v, e, ctx, t) => pinBody(v, e, t),
    visible: (v, e, ctx, t) => {
      if (t?.power) return HELD;
      if (!t?.hit) return lost(t?.missing);
      const nameShown = t.h.def.symbol.shapes.some(s => t.h.mine(s) && s.kind === "text" && s.text === t.hit.name && Math.hypot(...[0, 1].map(i => t.h.model([s.x, s.y])[i] - t.h.model([t.hit.x, t.hit.y])[i])) < 12);
      const wantName = v === "both" || v === "pin", wantNumber = v === "both" || v === "pad";
      const errs = [];
      if (nameShown !== wantName && t.hit.name) errs.push(wantName ? "name hidden" : "name shown");
      if (!wantNumber && !t.hit.numberHidden && !t.hit.hideNumber) errs.push("pad number hidden in Eagle; the model pin has no way to hide it");
      return errs.length ? lost("visible=" + v + ": " + errs.join(", ")) : HELD;
    },
    function: (v, e, ctx, t) => v === "none" || t?.hit && (t.hit.function === v || t.hit.shape === v) ? HELD : lost("pin function " + v + " (" + {dot: "inversion bubble", clk: "clock wedge", dotclk: "bubble and clock"}[v] + ") is not drawn or kept"),
    swaplevel: (v, e, ctx, t) => v === "0" || t?.hit?.swap === v || t?.hit?.swapGroup != null ? HELD : lost("swap level " + v + " (pins that may be swapped) is not kept")
  },
  told: {direction: /[Ss]upply symbol/}
};
function pinBody(v, e, t) {
  if (t?.power) return HELD;
  if (!t?.hit) return lost(t?.missing);
  const a = e.fields, len = PIN_LEN[a.length || "long"] ?? 7.62, ang = rot(a.rot).angle, hot = [n(a.x), n(a.y)];
  if (Number.isFinite(t.hit.length) && Number.isFinite(t.hit.angle)) return close(t.hit.length, len) ? HELD : lost("pin length " + t.hit.length);
  // A point pin draws no line; its direction only places its name, so with the name hidden it has no effect.
  if (len === 0) {
    if (v === a.length) return t.h.def.symbol.shapes.some(s => t.h.mine(s) && s.kind === "path" && closeP(t.h.model(s.points?.[0] || []), t.h.world(hot))) ? lost("a point pin has a pin line") : HELD;
    return a.visible === "off" || a.visible === "pad" ? HELD : lost("a point pin's direction (" + (a.rot || "R0") + ") places its name; the model pin has no direction");
  }
  const body = t.h.world([hot[0] + len * Math.cos(rad(ang)), hot[1] + len * Math.sin(rad(ang))]), start = t.h.world(hot);
  return t.h.def.symbol.shapes.some(s => t.h.mine(s) && s.kind === "path" && endsMatch(s.points?.map(t.h.model), start, body)) ? HELD : lost("no pin line of length " + len + " towards " + (a.rot || "R0"));
}
rule([SYM + "/pin"], pinRule);
const symShape = {
  find: (e, ctx) => symbolTarget(ctx, e),
  fields: {
    ...Object.fromEntries(["x", "y", "x1", "y1", "x2", "y2", "radius"].map(k => [k, symGeom()])),
    layer: (v, e, ctx, t) => {
      if (t?.power) return HELD;
      if (!t?.hit) return lost(t?.missing);
      const natural = e.node.name === "text" ? [94, 95, 96, 97] : [94];
      return natural.includes(+v) ? HELD : lost("layer " + v + " in a symbol");
    },
    width: (v, e, ctx, t) => {
      if (t?.power) return HELD;
      if (!t?.hit) return lost(t?.missing);
      if (e.node.name === "circle") return (n(v) === 0 ? !!t.hit.fill : close(t.hit.width, n(v))) ? HELD : lost("width " + fmt(t.hit.width));
      return close(t.hit.width, n(v)) ? HELD : lost("width " + fmt(t.hit.width) + ", source " + v);
    },
    curve: (v, e, ctx, t) => t?.hit?.arc ? HELD : lost("the curve is not a true arc"),
    style: (v, e, ctx, t) => lineStyle(v, t?.hit), cap: (v, e, ctx, t) => capStyle(v, t?.hit),
    rot: (v, e, ctx, t) => {
      if (t?.power) return HELD;
      if (!t?.hit) return lost(t?.missing);
      if (e.node.name === "rectangle") return corners(t.hit);
      if (t.hit.field) return lost("the " + t.hit.field + " text's rotation is not kept");
      return angleDiff(t.hit.angle || 0, -rot(v).angle) < .01 ? HELD : lost("text angle " + fmt(t.hit.angle || 0) + ", source " + v);
    },
    columns: (v, e, ctx, t) => lost("frame columns " + v + " (the reference grid) are not kept"),
    rows: (v, e, ctx, t) => lost("frame rows " + v + " are not kept"),
    ...Object.fromEntries(["border-left", "border-right", "border-top", "border-bottom"].map(k => [k, (v) => dflt(v, "yes", k + "=" + v + " is not kept")])),
    ...textFields(t => t?.hit?.field ? null : t?.hit),
    "#text": (v, e, ctx, t) => t?.power || t?.hit?.field ? HELD : t?.hit ? same(v, t.hit.text, "text") : lost(t?.missing || "text not found")
  },
  told: {curve: /Curves were converted/, ...Object.fromEntries(["rot", "x1", "y1", "x2", "y2"].map(k => [k, /rectangle rotation was omitted/])), ...Object.fromEntries(["columns", "rows", "border-left", "border-right", "border-top", "border-bottom"].map(k => [k, /rectangular drawing frame/]))}
};
for (const k of ["wire", "circle", "rectangle", "polygon", "text", "frame", "dimension"]) rule([SYM + "/" + k], symShape);
// >NAME and >VALUE in a symbol place the part's labels; their own size and angle have no field.
for (const k of ["size", "ratio", "font", "align", "rot"]) {
  const plain = symShape.fields[k];
  symShape.fields[k] = (v, e, ctx, t) => t?.hit?.field && k === "font" ? (fontOf(e, v) === "vector" ? HELD : lost(fontOf(e, v) + " font")) : t?.hit?.field ? lost("the " + t.hit.field + " text " + k + " " + v + " is not kept") : plain(v, e, ctx, t);
}
rule([SYM + "/polygon/vertex"], vertexRule((ctx, pe) => pe && symbolTarget(ctx, pe)?.hit));
rule([SYM], {
  find: (e, ctx) => { const h = symbolHost(ctx, {node: e.node.kids[0] ? e.node.kids[0] : e.node, file: e.file}); return h.missing ? null : h; },
  fields: {name: (v, e, ctx, t) => t?.def?.symbolName === v ? HELD : lost("symbol name " + fmt(v) + " is not kept (the definition is named after the device)"), urn: libField("symbol URN"),
    library_version: libField("library version"), locally_modified: v => lost("locally modified flag")}
});
// Device sets, gates, devices, connects and technologies: the definition a part is made from.
const dsDefs = (ctx, e) => {
  const ds = e.node.name === "deviceset" ? e.node : up(e.node, "deviceset"), lib = up(e.node, "library"), root = rootOf(e.node);
  const sch = kid(kid(kid(root, "eagle"), "drawing"), "schematic"), out = [];
  for (const part of kids(kid(sch, "parts"), "part")) if (part.attrs.library === lib.attrs.name && part.attrs.deviceset === ds.attrs.name)
    for (const x of ctx.byFile.get(e.file).parts.get(part.attrs.name) || []) { const def = ctx.defs.get(x.item.def); if (def) out.push({part, item: x.item, def}); }
  if (!out.length) for (const x of ctx.byFile.get(e.file).items) if (x.item.kind === "power") out.push({power: x.item});
  return out;
};
rule([DS], {
  find: (e, ctx) => dsDefs(ctx, e)[0] || null,
  fields: {
    name: (v, e, ctx, t) => t?.power || t?.def && t.def.name.startsWith(v.split("*")[0]) ? HELD : lost("device set " + v),
    prefix: (v, e, ctx, t) => t?.power ? lost("supply prefix " + v + "; a power port has no designator") : t?.def ? same(v, t.def.prefix, "prefix") : lost("no definition"),
    uservalue: (v, e, ctx, t) => t?.def && (t.def.userValue ?? t.def.uservalue) === yes(v) ? HELD : lost("uservalue=" + v + " (whether a part must be given its own value) is not kept"),
    urn: libField("device set URN"), library_version: libField("library version"), locally_modified: v => lost("locally modified flag")
  },
  told: {prefix: /[Ss]upply symbol/}
});
rule([DS + "/gates/gate"], {
  find: (e, ctx) => dsDefs(ctx, e)[0] || null,
  fields: {
    // Eagle shows a gate's name after the part name when the device has several gates; Waffle
    // shows the gate's letter (A for the first). A single gate's name is never shown.
    name: (v, e, ctx, t) => {
      const gates = kids(e.node.parent, "gate"), i = gates.indexOf(e.node);
      if (t?.power || gates.length === 1 || (t?.def?.symbol?.gateNames || []).includes(v)) return HELD;
      return v === String.fromCharCode(65 + i) ? HELD : lost("gate name " + fmt(v) + " shows as " + String.fromCharCode(65 + i) + " (gates are numbered)");
    },
    symbol: (v, e, ctx, t) => t ? HELD : lost("no definition"),
    x: (v, e) => n(v) === 0 && n(e.fields.y) === 0 ? HELD : lost("gate offset (" + e.fields.x + ", " + e.fields.y + ") for adding the device is not kept"),
    y: (v, e) => n(v) === 0 && n(e.fields.x) === 0 ? HELD : lost("gate offset is not kept"),
    addlevel: (v) => dflt(v, "next", "addlevel " + v + " (how the gate is added: must, can, request, always) is not kept"),
    swaplevel: (v) => dflt(v, "0", "gate swap level " + v + " is not kept")
  },
  told: {name: /[Ss]upply symbol/, addlevel: /[Ss]upply symbol/}
});
rule([DS + "/devices/device"], {
  find: (e, ctx) => dsDefs(ctx, e).find(x => x.power || (x.part.attrs.device || "") === (e.fields.name || "")) || null,
  fields: {
    name: (v, e, ctx, t) => t?.power || t?.def?.name.includes(v) ? HELD : lost("device name " + v),
    package: (v, e, ctx, t) => t?.def ? same(v, t.def.footprintName, "footprint") : lost("no definition")
  }
});
rule([DS + "/devices/device/connects/connect"], {
  find: (e, ctx) => dsDefs(ctx, e).find(x => x.def && (x.part.attrs.device || "") === (up(e.node, "device").attrs.name || "")) || null,
  fields: {
    gate: (v, e, ctx, t) => t ? HELD : lost("no definition"),
    pin: (v, e, ctx, t) => t ? connectPads(e, t) : lost("no definition"),
    pad: (v, e, ctx, t) => t ? connectPads(e, t) : lost("no definition"),
    route: (v) => dflt(v, "all", "route=" + v + " (any one of the pads may carry the connection) is not kept")
  }
});
function connectPads(e, t) {
  const gates = kids(up(e.node, "deviceset").kids.find(k => k.name === "gates"), "gate"), unit = gates.length > 1 ? gates.findIndex(g => g.attrs.name === e.fields.gate) + 1 : 0;
  const pads = String(e.fields.pad || "").trim().split(/\s+/), name = e.fields.pin.replace(/@\d+$/, "");
  const pins = t.def.symbol.pins.filter(p => (!unit || !p.part || p.part === unit) && p.name === name);
  const missing = pads.filter(pad => !pins.some(p => String(p.number) === pad));
  return missing.length ? lost("pin " + e.fields.gate + "." + e.fields.pin + " has no pad " + missing.join(", ")) : HELD;
}
rule([DS + "/devices/device/technologies/technology"], {
  find: (e, ctx) => dsDefs(ctx, e).find(x => x.def && (x.part.attrs.technology || "") === (e.fields.name || "")) || dsDefs(ctx, e).find(x => x.power) || null,
  fields: {name: (v, e, ctx, t) => t ? HELD : lost("technology " + fmt(v) + " is not in any definition")}
});
rule([DS + "/devices/device/technologies/technology/attribute"], {
  find: (e, ctx) => dsDefs(ctx, e).find(x => x.def && (x.part.attrs.technology || "") === (e.node.parent.attrs.name || "")) || null,
  fields: {
    name: (v, e, ctx, t) => t?.def?.parameters && Object.hasOwn(t.def.parameters, v) ? HELD : lost("no parameter " + v),
    value: (v, e, ctx, t) => t?.def?.parameters ? same(v, t.def.parameters[e.fields.name], e.fields.name) : lost("no parameter " + e.fields.name),
    constant: (v) => dflt(v, "no", "constant=" + v + " (a part may not override the value) is not kept")
  }
});
rule([DS + "/devices/device/package3dinstances/package3dinstance"], {find: () => null, fields: {package3d_urn: v => lost("3D package " + v + " is not linked")}});
rule([SCH_LIB + "/packages/package"], {
  find: (e, ctx) => ctx.model.library.find(d => d.footprintName === e.fields.name) || null,
  fields: {name: (v, e, ctx, t) => t ? HELD : lost("no definition names footprint " + v), urn: libField("package URN"), library_version: libField("library version"), locally_modified: v => lost("locally modified flag")}
});

// Parts and instances.
rule(["schematic/parts/part"], {
  find: (e, ctx) => ctx.byFile.get(e.file).parts.get(e.fields.name)?.[0]?.item || null,
  fields: {
    name: (v, e, ctx, t) => t ? HELD : lost("no part " + v),
    value: (v, e, ctx, t) => t ? same(v, t.value, "value") : lost("no part"),
    deviceset: (v, e, ctx, t) => t && ctx.defs.get(t.def)?.name.startsWith(v.split("*")[0]) ? HELD : lost("device set " + v),
    device: (v, e, ctx, t) => t && ctx.defs.get(t.def)?.name.includes(v) ? HELD : lost("device " + v),
    technology: (v, e, ctx, t) => t && ctx.defs.get(t.def)?.name.includes(v) ? HELD : lost("technology " + v),
    library: libField("library name"), library_urn: libField("library URN"),
    package3d_urn: v => lost("3D package " + v + " is not linked")
  },
  told: {name: /[Ss]upply symbol/, deviceset: /[Ss]upply symbol/, device: /[Ss]upply symbol/, library: /[Ss]upply symbol/}
});
rule(["schematic/parts/part/attribute"], {
  find: (e, ctx) => ctx.byFile.get(e.file).parts.get(e.node.parent.attrs.name)?.[0]?.item || null,
  fields: attributeFields("schematic")
});
rule([SHEET + "/instances/instance"], {
  find: (e, ctx) => {
    const host = symbolHost(ctx, {node: firstSymbolChild(e) || e.node, file: e.file});
    if (host.inst === e.node) return host;
    const list = ctx.byFile.get(e.file).parts.get(e.fields.part) || [], doc = sheetDoc(ctx, e);
    const at = W([n(e.fields.x), n(e.fields.y)]);
    const item = list.find(x => x.doc === doc && closeP([x.item.x, x.item.y], at))?.item;
    return item ? {item} : host.power && host.inst === e.node ? host : null;
  },
  fields: {
    part: (v, e, ctx, t) => t ? HELD : lost("no instance"),
    gate: (v, e, ctx, t) => t ? HELD : lost("no instance"),
    x: (v, e, ctx, t) => t?.power || t?.item && close(t.item.x, n(v)) ? HELD : lost("x " + fmt(t?.item?.x)),
    y: (v, e, ctx, t) => t?.power || t?.item && close(t.item.y, -n(v)) ? HELD : lost("y " + fmt(t?.item?.y)),
    rot: (v, e, ctx, t) => {
      if (t?.power) return HELD;
      if (!t?.item) return lost("no instance");
      const r = rot(v), errs = [];
      if (angleDiff(t.item.angle || 0, r.mirror ? r.angle : -r.angle) > .01) errs.push("angle " + fmt(t.item.angle));
      if (!!t.item.mirror !== r.mirror) errs.push("mirror " + !!t.item.mirror);
      if (r.spin) errs.push("spin is not kept");
      return errs.length ? lost(errs.join("; ")) : HELD;
    },
    smashed: (v, e, ctx, t) => !yes(v) || t?.item?.refAt || t?.item?.valueAt ? HELD : lost("smashed labels have no separate position")
  }
});
function firstSymbolChild(e) {
  const root = rootOf(e.node), sch = kid(kid(kid(root, "eagle"), "drawing"), "schematic");
  const part = kids(kid(sch, "parts"), "part").find(p => p.attrs.name === e.fields.part);
  const lib = kids(kid(sch, "libraries"), "library").find(l => l.attrs.name === part?.attrs.library);
  const ds = kids(kid(lib, "devicesets"), "deviceset").find(d => d.attrs.name === part?.attrs.deviceset);
  const gate = kids(kid(ds, "gates"), "gate").find(g => g.attrs.name === e.fields.gate);
  const sym = kids(kid(lib, "symbols"), "symbol").find(s => s.attrs.name === gate?.attrs.symbol);
  return sym?.kids.find(k => k.name !== "description") || null;
}
rule([SHEET + "/instances/instance/attribute"], {
  find: (e, ctx) => {
    const inst = e.node.parent, list = ctx.byFile.get(e.file).parts.get(inst.attrs.part) || [], doc = sheetDoc(ctx, e), at = W([n(inst.attrs.x), n(inst.attrs.y)]);
    return list.find(x => x.doc === doc && closeP([x.item.x, x.item.y], at))?.item || null;
  },
  fields: attributeFields("schematic")
});
rule([SHEET + "/busses/bus"], {
  find: (e, ctx) => ctx.byFile.get(e.file).items.find(x => x.item.kind === "bus") || null,
  fields: {name: (v, e, ctx, t) => t?.item?.text === v || t?.item?.name === v ? HELD : lost("bus members " + fmt(v) + " are not declared")},
  told: {name: /member declaration/}
});
const wireItem = kind => (e, ctx) => {
  const a = e.fields, p1 = W([n(a.x1), n(a.y1)]), p2 = W([n(a.x2), n(a.y2)]), doc = sheetDoc(ctx, e);
  return doc?.items.find(it => it.kind === kind && endsMatch(it.points, p1, p2)) || null;
};
const schWire = (kind, layer) => ({
  find: wireItem(kind),
  fields: {
    ...Object.fromEntries(["x1", "y1", "x2", "y2"].map(k => [k, (v, e, ctx, t) => t ? HELD : lost("no " + kind + " between its ends")])),
    width: (v, e, ctx, t) => t && close(t.width, n(v)) ? HELD : lost("drawn " + v + " mm wide in Eagle; the model " + kind + " has " + (t?.width != null ? fmt(t.width) : "no width")),
    layer: (v, e, ctx, t) => t && +v === layer ? HELD : lost("layer " + v),
    curve: (v, e, ctx, t) => t?.arc ? HELD : lost("the curve is not a true arc"),
    style: (v, e, ctx, t) => lineStyle(v, t), cap: (v, e, ctx, t) => capStyle(v, t)
  },
  told: {curve: /Curves were converted/}
});
rule([SHEET + "/busses/bus/segment/wire"], schWire("bus", 92));
rule([SHEET + "/nets/net/segment/wire"], {...schWire("wire", 91), find: (e, ctx) => { const t = wireItem("wire")(e, ctx); return t && t.net === up(e.node, "net").attrs.name ? t : null; }});
rule([SHEET + "/nets/net"], {
  find: (e, ctx) => sheetDoc(ctx, e)?.items.find(it => it.net === e.fields.name || it.kind === "netlabel" && it.text === e.fields.name || it.kind === "power" && it.text === e.fields.name) || null,
  fields: {name: (v, e, ctx, t) => t ? HELD : lost("net " + v + " not on its sheet"), class: (v, e, ctx) => v === "0" ? HELD : lost("net class " + v + " is not kept on the schematic net")}
});
rule([SHEET + "/nets/net/segment/pinref"], {find: () => null, told: {part: /[Pp]in membership/, gate: /[Pp]in membership/, pin: /[Pp]in membership/}});
rule([SHEET + "/nets/net/segment/junction"], {
  find: (e, ctx) => sheetDoc(ctx, e)?.items.find(it => it.kind === "junction" && closeP([it.x, it.y], W([n(e.fields.x), n(e.fields.y)]))) || null,
  fields: {x: (v, e, ctx, t) => t ? HELD : lost("no junction"), y: (v, e, ctx, t) => t ? HELD : lost("no junction")}
});
rule([SHEET + "/nets/net/segment/label"], {
  find: (e, ctx) => {
    const net = up(e.node, "net").attrs.name, at = W([n(e.fields.x), n(e.fields.y)]);
    const all = (sheetDoc(ctx, e)?.items || []).filter(it => (it.kind === "netlabel" || it.kind === "offsheet") && it.text === net);
    return all.sort((p, q) => Math.hypot(p.x - at[0], p.y - at[1]) - Math.hypot(q.x - at[0], q.y - at[1]))[0] || null;
  },
  fields: {
    x: (v, e, ctx, t) => t && closeP([t.x, t.y], W([n(e.fields.x), n(e.fields.y)])) ? HELD : lost("label at " + fmt(W([n(e.fields.x), n(e.fields.y)])) + "; the model has " + fmt(t && [t.x, t.y])),
    y: (v, e, ctx, t) => t && closeP([t.x, t.y], W([n(e.fields.x), n(e.fields.y)])) ? HELD : lost("label position"),
    rot: (v, e, ctx, t) => t && angleDiff(t.angle || 0, -rot(v).angle) < .01 ? HELD : lost("angle " + fmt(t?.angle)),
    size: (v, e, ctx, t) => t && close(t.size, n(v)) ? HELD : lost("label size " + v + "; the model label has " + fmt(t?.size ?? "the default")),
    layer: (v) => +v === 95 ? HELD : lost("layer " + v),
    xref: (v, e, ctx, t) => !yes(v) || t?.kind === "offsheet" ? HELD : lost("a cross-reference label (sheet and frame reference) becomes a plain net label"),
    font: (v, e) => fontOf(e, v) === "vector" ? HELD : lost(fontOf(e, v) + " font"),
    ratio: (v, e, ctx, t) => fontOf(e) !== "vector" || t && close(t.width, n(e.fields.size) * n(v) / 100) ? HELD : lost("stroke ratio " + v + "% is not kept"),
    align: (v, e, ctx, t) => t?.justify === v ? HELD : lost("anchor " + v + " is not kept")
  },
  told: {x: /moved onto the nearest wire/, y: /moved onto the nearest wire/}
});
// Sheet <plain>: free text and drawing.
const schPlain = {
  find: (e, ctx) => {
    const doc = sheetDoc(ctx, e), a = e.fields, name = e.node.name, items = doc?.items || [];
    if (name === "text") return items.find(it => it.kind === "label" && it.text === a["#text"]) || null;
    if (name === "wire") return items.find(it => it.kind === "graphic" && endsMatch(it.points, W([n(a.x1), n(a.y1)]), W([n(a.x2), n(a.y2)]))) || null;
    if (name === "circle") { const c = W([n(a.x), n(a.y)]); return items.find(it => it.kind === "graphic" && it.points?.length > 8 && it.points.every(p => close(Math.hypot(p[0] - c[0], p[1] - c[1]), n(a.radius), .01))) || null; }
    if (name === "rectangle" || name === "frame") return findRect(a, W, ring => items.find(it => it.kind === "graphic" && ringMatch(it.points, ring))) || null;
    if (name === "polygon") { const ring = kids(e.node, "vertex").map(v => W([n(v.attrs.x), n(v.attrs.y)])); return items.find(it => it.kind === "graphic" && ringMatch(it.points, ring)) || null; }
    if (name === "dimension") return items.find(it => it.dimension) || null;
    return null;
  },
  fields: {
    ...Object.fromEntries(["x", "y", "x1", "y1", "x2", "y2", "x3", "y3", "radius"].map(k => [k, (v, e, ctx, t) => corners(t)])),
    layer: (v, e) => [94, 97].includes(+v) ? HELD : lost("layer " + v + (+v === 98 ? " (Guide: not printed)" : "") + " has no counterpart"),
    width: (v, e, ctx, t) => !t ? lost("not found") : e.node.name === "circle" && n(v) === 0 ? (t.fill ? HELD : lost("filled disc drawn as an outline")) : close(t.width, n(v)) ? HELD : lost("width " + fmt(t.width)),
    curve: (v, e, ctx, t) => t?.arc ? HELD : lost("the curve is not a true arc"),
    style: (v, e, ctx, t) => lineStyle(v, t), cap: (v, e, ctx, t) => capStyle(v, t),
    rot: (v, e, ctx, t) => !t ? lost("not found") : e.node.name === "text" ? (angleDiff(t.angle || 0, -rot(v).angle) < .01 ? HELD : lost("angle " + fmt(t.angle))) : corners(t),
    columns: (v) => lost("frame columns " + v + " (the reference grid) are not kept"), rows: (v) => lost("frame rows " + v + " are not kept"),
    ...Object.fromEntries(["border-left", "border-right", "border-top", "border-bottom"].map(k => [k, (v) => dflt(v, "yes", k + "=" + v + " is not kept")])),
    ...textFields(t => t)
  },
  told: {curve: /Curves were converted/, ...Object.fromEntries(["rot", "x1", "y1", "x2", "y2"].map(k => [k, /rectangle rotation was omitted/])),
    ...Object.fromEntries(["columns", "rows", "border-left", "border-right", "border-top", "border-bottom"].map(k => [k, /rectangular drawing frame/]))}
};
for (const k of ["wire", "circle", "rectangle", "polygon", "text", "frame", "dimension"]) rule([SHEET + "/plain/" + k], schPlain);
rule([SHEET + "/plain/polygon/vertex"], vertexRule((ctx, pe) => pe && schPlain.find(pe, ctx)));
rule(["schematic/classes/class", "schematic/classes/class/clearance"], {find: () => null});

// ------------------------------------------------------------ accounting
function account(entries, imported, files) {
  const ctx = view(imported, files), rows = new Map();
  const row = id => { if (!rows.has(id)) rows.set(id, {id, pass: true, gating: true, metric: {source: 0, held: 0, reported: 0, outside: 0, lost: 0, unmapped: 0, unplaced: 0}, detail: []}); return rows.get(id); };
  const tally = (id, how, what) => {
    const r = row(id);
    r.metric.source++; r.metric[how]++;
    if (how === "lost" || how === "unmapped") { r.pass = false; if (r.detail.length < 8) r.detail.push(what); }
  };
  const status = (file, at) => ctx.report.get(file + "\0" + at);
  for (const e of entries) {
    const spec = RULES[e.kind] || {}, rep = status(e.file, e.node.at), parentRep = spec.parentTold && status(e.file, e.node.parent.at);
    let target = null, findError = null;
    try { target = spec.find ? spec.find(e, ctx) : null; } catch (error) { findError = String(error?.message || error); }
    if (target?.missing) target = {...target};
    const found = target && !target.missing;
    // The object.
    const objOut = spec.outsideKind || OUTSIDE[e.kind];
    const objLost = !found && !(rep && (rep.status === "dropped" || rep.status === "approximated")) && !objOut;
    if (found) tally(e.kind, "held");
    else if (rep && (rep.status === "dropped" || rep.status === "approximated")) tally(e.kind, "reported");
    else if (objOut) tally(e.kind, "outside");
    else tally(e.kind, "lost", e.id + ": " + (findError || target?.missing || "not in the model, and the Import Report " + (rep ? "says " + rep.status : "has no row for it")));
    // Its fields.
    for (const [name, value] of Object.entries(e.fields)) {
      const id = e.kind + "." + name;
      if (objOut || spec.outside?.[name]) { tally(id, "outside"); continue; }
      let res;
      const fn = spec.fields?.[name];
      try { res = fn ? fn(value, e, ctx, target) : {unmapped: true}; } catch (error) { res = lost("check failed: " + String(error?.message || error)); }
      if (res.held) { tally(id, "held"); continue; }
      if (res.outside) { tally(id, "outside"); continue; }
      const at = e.fieldAt[name], own = at != null ? status(e.file, at) : rep;
      const told = typeof spec.told === "function" ? spec.told(e, name) : spec.told?.[name];
      // Dropped says it for every field; an approximation only for the property its reason or a note names.
      const says = s => s && (s.status === "dropped" || s.status === "approximated" && told && told.test(s.reason));
      if (says(own) || says(parentRep) || told && ctx.byFile.get(e.file).notes.some(t => told.test(t))) { tally(id, "reported"); continue; }
      if (objLost) { tally(id, "unplaced"); continue; }  // its object is the failure; the object row counts it once
      const what = e.id + " " + name + "=" + JSON.stringify(value).slice(0, 60) + ": ";
      if (res.unmapped) tally(id, "unmapped", what + "unmapped: the census has no check for this field" + (own ? " [report: " + own.status + "]" : ""));
      else tally(id, "lost", what + (res.lost || "lost") + (own ? " [report: " + own.status + "]" : ""));
    }
  }
  return [...rows.values()];
}

const FIXTURES = [
  {id: "eagle-demo", files: ["tests/fixtures/import/demo-eagle.brd", "tests/fixtures/import/demo-eagle.sch"]},
  {id: "eagle-census", files: ["tests/fixtures/census/eagle/census.brd", "tests/fixtures/census/eagle/census.sch"]}
];

module.exports = {FIXTURES, census, account, parse};
