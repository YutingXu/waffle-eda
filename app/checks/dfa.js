"use strict";
// DFA spacing matrix (Allegro 26.1 component-level DFA): the required gap between two
// components depends on their package types, e.g. 0402–0402 0.2 mm, BGA–any 1.0 mm.
//
// Rule (rules.js type "dfaSpacing", category Placement):
//   {matrix:[{a, b, gap}], defaultGap, measure:"body"|"courtyard", sides:"same"|"both"}
//   a and b are package types (TYPES below) or "any". Lookup for a pair of types: the
//   exact pair (either order), else the larger of the "type–any" entries, else "any–any",
//   else defaultGap.
//
// Package type of a part, first match wins:
//   1. a part or library parameter "DFA Package" / "Package Type" / "DFA" naming a type,
//   2. the IPC footprint wizard family and preset (footprint.wizard),
//   3. the footprint or part name (R_0402, QFN-32, BGA-256, SOIC-8 …),
//   4. plated holes → tht, else "other".
//
// Measured outline: the body (assembly / package shapes, else the pads) or the courtyard
// (footprint.courtyard, courtyard / Mechanical 15 shapes, else the body grown by 0.25 mm),
// as an oriented rectangle. Sides: "same" skips a top part against a bottom part unless one
// of them is through-hole; "both" checks every pair.
//
// API (pure, DOM-free):
//   AtriumDFA.TYPES, DEFAULT_MATRIX, defaultRule()
//   AtriumDFA.packageType(item, def)          -> type id
//   AtriumDFA.gapFor(rule, ta, tb)            -> mm
//   AtriumDFA.check(doc, defs, rule, {ids, limit, parts}) -> {violations, parts, ms}
//   AtriumDFA.drc(doc, defs, {rules, flag, notes, stats}) (rules.js drc hook)
//   AtriumDFA.activeRule(doc, project)        -> the first enabled dfaSpacing rule or null
// Live: once loaded in the editor it draws a halo around moving, placed or selected parts
// and marks every neighbour closer than the matrix allows (editor addRenderer overlay).
globalThis.AtriumDFA = (() => {
  const EPS = 1e-6;
  const TYPES = [["0201", "0201"], ["0402", "0402"], ["0603", "0603"], ["0805", "0805"], ["1206", "1206 and larger chips"],
    ["melf", "MELF"], ["sod", "SOD"], ["sot", "SOT"], ["soic", "SOIC / SSOP / TSSOP"], ["qfp", "QFP"], ["qfn", "QFN / DFN"],
    ["bga", "BGA"], ["tht", "Through-hole"], ["connector", "Connector"], ["other", "Other"]];
  const IDS = new Set(TYPES.map(([k]) => k));
  const label = t => t === "any" ? "Any" : (TYPES.find(([k]) => k === t)?.[1] || t);
  const DEFAULT_MATRIX = [
    {a: "0201", b: "0201", gap: .15}, {a: "0402", b: "0402", gap: .2}, {a: "0603", b: "0603", gap: .25}, {a: "0805", b: "0805", gap: .3},
    {a: "0402", b: "0603", gap: .25}, {a: "soic", b: "any", gap: .4}, {a: "qfp", b: "any", gap: .5}, {a: "qfn", b: "any", gap: .5},
    {a: "bga", b: "any", gap: 1}, {a: "tht", b: "any", gap: .8}, {a: "connector", b: "any", gap: 1}];
  const DEFAULT_GAP = .25;
  function defaultRule(props = {}) {
    return {id: "dfaSpacing-1", type: "dfaSpacing", name: "DFASpacing", comment: "Starter assembly spacing matrix (package type pairs).", enabled: true, priority: 1,
      scope: globalThis.AtriumDesignQueryRecord.selector("all"), matrix: DEFAULT_MATRIX.map(e => ({...e})), defaultGap: DEFAULT_GAP, measure: "body", sides: "same", ...props};
  }

  // ------------------------------------------------------------------ package types
  const CHIP = {"01005": "0201", "0201": "0201", "0402": "0402", "0603": "0603", "0805": "0805", "1005": "0402", "1608": "0603", "2012": "0805"};
  function fromText(s) {
    s = String(s || "").toUpperCase();
    if (!s) return null;
    if (/BGA|CSP\b|WLCSP/.test(s)) return "bga";
    if (/QFN|DFN|SON\b|MLF|LGA/.test(s)) return "qfn";
    if (/QFP|LQFP|TQFP/.test(s)) return "qfp";
    if (/SOIC|SSOP|TSSOP|MSOP|\bSO-?\d|SOP/.test(s)) return "soic";
    if (/SOT|TO-?252|DPAK|SC-?70/.test(s)) return "sot";
    if (/SOD/.test(s)) return "sod";
    if (/MELF/.test(s)) return "melf";
    if (/DIP|TO-?92|TO-?220|THT|AXIAL|RADIAL/.test(s)) return "tht";
    if (/CONN|HEADER|USB|JST|MOLEX|RJ\d|PINHEADER/.test(s)) return "connector";
    const m = /(?:^|[^0-9])(01005|0201|0402|0603|0805|1206|1210|1812|2010|2512|1005|1608|2012|3216)(?:[^0-9]|$)/.exec(s);
    if (m) return CHIP[m[1]] || "1206";
    return null;
  }
  const PARAMS = ["DFA PACKAGE", "DFAPACKAGE", "DFA", "PACKAGE TYPE", "PACKAGETYPE", "PACKAGE"];
  function fromParams(...sources) {
    for (const src of sources) {
      if (!src || typeof src !== "object") continue;
      for (const [k, v] of Object.entries(src)) {
        if (!PARAMS.includes(String(k).trim().toUpperCase()) || typeof v === "object") continue;
        const s = String(v).trim().toLowerCase();
        if (IDS.has(s)) return s;
        const t = fromText(v);
        if (t) return t;
      }
    }
    return null;
  }
  function fromWizard(w) {
    if (!w || typeof w !== "object") return null;
    switch (w.family) {
      case "chip": return CHIP[w.preset] || fromText(w.preset) || "1206";
      case "melf": return "melf";
      case "sod": return "sod";
      case "sot23": case "sot223": return "sot";
      case "gullwing": return /QFP/i.test(w.preset || "") ? "qfp" : "soic";
      case "nolead": return "qfn";
      case "bga": return "bga";
      case "header": case "dip": return "tht";
      case "smdheader": return "connector";
      default: return null;
    }
  }
  const typeCache = new WeakMap();
  function packageType(item, def) {
    const fromPart = fromParams(item?.parameters);
    if (fromPart) return fromPart;
    if (def && typeCache.has(def)) return typeCache.get(def);
    const fp = def?.footprint;
    const t = fromParams(def?.parameters) || fromWizard(fp?.wizard) || fromText(fp?.name) || fromText(def?.name)
      || ((fp?.pads || []).some(p => p.drill > 0) ? "tht" : "other");
    if (def) typeCache.set(def, t);
    return t;
  }

  // ------------------------------------------------------------------ matrix lookup
  function gapFor(rule, ta, tb) {
    let exact = null, anyA = null, anyB = null, anyAny = null;
    for (const e of rule?.matrix || []) {
      if (e.a === ta && e.b === tb || e.a === tb && e.b === ta) { exact = Math.max(exact ?? 0, e.gap); continue; }
      if (e.a === "any" && e.b === "any") anyAny = e.gap;
      else if (e.a === ta && e.b === "any" || e.b === ta && e.a === "any") anyA = Math.max(anyA ?? 0, e.gap);
      else if (e.a === tb && e.b === "any" || e.b === tb && e.a === "any") anyB = Math.max(anyB ?? 0, e.gap);
    }
    if (exact != null) return exact;
    if (anyA != null || anyB != null) return Math.max(anyA ?? 0, anyB ?? 0);
    if (anyAny != null) return anyAny;
    return rule?.defaultGap ?? DEFAULT_GAP;
  }
  // Largest gap the rule can ask for (search reach).
  const maxGap = rule => Math.max(rule?.defaultGap ?? DEFAULT_GAP, ...(rule?.matrix || []).map(e => e.gap));
  function setGap(rule, a, b, gap) {
    const m = (rule.matrix ||= []), i = m.findIndex(e => e.a === a && e.b === b || e.a === b && e.b === a);
    if (gap == null) { if (i >= 0) m.splice(i, 1); return rule; }
    if (i >= 0) m[i] = {a: m[i].a, b: m[i].b, gap}; else m.push({a, b, gap});
    return rule;
  }

  // ------------------------------------------------------------------ geometry
  const BODY = new Set(["package", "assembly", "body"]);
  function boxOfPoints(pts, box) {
    for (const p of pts) { if (p[0] < box[0]) box[0] = p[0]; if (p[1] < box[1]) box[1] = p[1]; if (p[0] > box[2]) box[2] = p[0]; if (p[1] > box[3]) box[3] = p[1]; }
    return box;
  }
  const empty = () => [Infinity, Infinity, -Infinity, -Infinity];
  const valid = b => b && b[2] > b[0] && b[3] > b[1];
  function padBox(p, box) {
    const a = (p.angle || 0) * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
    const w = p.w || p.diameter || 0, h = p.h || p.diameter || 0, hx = (w * c + h * s) / 2, hy = (w * s + h * c) / 2;
    return boxOfPoints([[p.x - hx, p.y - hy], [p.x + hx, p.y + hy]], box);
  }
  function shapeBox(s, box) {
    if (Array.isArray(s.points)) return boxOfPoints(s.points, box);
    if (s.kind === "circle" && Number.isFinite(s.r)) return boxOfPoints([[s.x - s.r, s.y - s.r], [s.x + s.r, s.y + s.r]], box);
    return box;
  }
  const geoCache = new WeakMap();
  // Local outlines of a definition: {body, courtyard} boxes [x0, y0, x1, y1] in mm.
  function outlineEvidence(def) {
    if (def && geoCache.has(def)) return geoCache.get(def);
    const fp = def?.footprint || {}, shapes = fp.shapes || [];
    let body = empty(), court = empty();
    for (const s of shapes) {
      if (BODY.has(s.style) || s.layer === "Mechanical 13") shapeBox(s, body);
      if (s.style === "courtyard" || s.layer === "Mechanical 15") shapeBox(s, court);
    }
    let bodySource = "body", courtyardSource = "courtyard-shapes";
    if (!valid(body)) { body = empty(); for (const p of fp.pads || []) padBox(p, body); bodySource = "pad-bounds"; }
    if (!valid(body)) { body = [-.5, -.5, .5, .5]; bodySource = null; }
    if (Array.isArray(fp.courtyard) && fp.courtyard.length === 4) { court = fp.courtyard.slice(); courtyardSource = "courtyard"; }
    if (!valid(court)) {
      court = empty(); for (const p of fp.pads || []) padBox(p, court);
      boxOfPoints([[body[0], body[1]], [body[2], body[3]]], court);
      court = [court[0] - .25, court[1] - .25, court[2] + .25, court[3] + .25];
      courtyardSource = bodySource ? "expanded-body" : null;
    }
    const out = {boxes: {body, courtyard: court}, bodySource, courtyardSource};
    if (def) geoCache.set(def, out);
    return out;
  }
  const outlines = def => outlineEvidence(def).boxes;
  const rad = a => (a || 0) * Math.PI / 180;
  // World polygon (4 corners) of a local box on a part.
  function polyOf(item, box) {
    const c = Math.cos(rad(item.angle)), s = Math.sin(rad(item.angle)), m = item.mirror ? -1 : 1;
    return [[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]]].map(([x, y]) => [x * m * c - y * s + item.x, x * m * s + y * c + item.y]);
  }
  function aabb(poly) { return boxOfPoints(poly, empty()); }
  const sideOf = item => item.layer === "Bottom" ? "Bottom" : "Top";
  function segPoint(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l = dx * dx + dy * dy;
    let t = l ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const q = [a[0] + t * dx, a[1] + t * dy];
    return {d: Math.hypot(p[0] - q[0], p[1] - q[1]), q};
  }
  function inside(p, poly) {
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length], c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
      if (Math.abs(c) < 1e-12) continue;
      if (!sign) sign = Math.sign(c); else if (Math.sign(c) !== sign) return false;
    }
    return true;
  }
  // Edge-to-edge distance of two convex polygons (0 when they overlap) and the closest points.
  function polyGap(P, Q) {
    if (P.some(p => inside(p, Q)) || Q.some(q => inside(q, P))) { const c = centre(P), d = centre(Q); return {d: 0, a: c, b: d}; }
    let best = {d: Infinity, a: null, b: null};
    for (const [X, Y, flip] of [[P, Q, false], [Q, P, true]]) for (const p of X) for (let i = 0; i < Y.length; i++) {
      const r = segPoint(p, Y[i], Y[(i + 1) % Y.length]);
      if (r.d < best.d) best = flip ? {d: r.d, a: r.q, b: p} : {d: r.d, a: p, b: r.q};
    }
    // Crossing edges (no vertex inside) overlap too.
    for (let i = 0; i < P.length; i++) for (let j = 0; j < Q.length; j++) if (cross(P[i], P[(i + 1) % P.length], Q[j], Q[(j + 1) % Q.length])) return {d: 0, a: centre(P), b: centre(Q)};
    return best;
  }
  function cross(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    return (o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) && (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0);
  }
  const centre = P => [P.reduce((s, p) => s + p[0], 0) / P.length, P.reduce((s, p) => s + p[1], 0) / P.length];
  const defOf = (defs, id) => defs?.get ? defs.get(id) : defs?.[id];

  // Part records for a rule: {id, ref, type, side, tht, poly, box}.
  function record(item, defs, rule) {
    const def = defOf(defs, item.def);
    if (!def?.footprint) return null;
    const o = outlines(def), poly = polyOf(item, rule?.measure === "courtyard" ? o.courtyard : o.body), type = packageType(item, def);
    return {id: item.id, ref: item.ref || item.id, type, side: sideOf(item), tht: type === "tht" || (def.footprint.pads || []).some(p => p.drill > 0), poly, box: aabb(poly), item};
  }
  const conflicts = (rule, a, b) => a.side === b.side || rule?.sides === "both" || a.tht || b.tht;
  function pairCheck(rule, a, b) {
    if (!conflicts(rule, a, b)) return null;
    const gap = gapFor(rule, a.type, b.type);
    if (a.box[0] - b.box[2] >= gap || b.box[0] - a.box[2] >= gap || a.box[1] - b.box[3] >= gap || b.box[1] - a.box[3] >= gap) return null;
    const g = polyGap(a.poly, b.poly);
    if (g.d + EPS >= gap) return null;
    return {id: a.id, otherId: b.id, refs: [a.ref, b.ref], types: [a.type, b.type], actual: Math.max(0, g.d), required: gap, at: g.a, otherAt: g.b};
  }
  // Sweep on x over the part boxes; options.ids limits the check to pairs with one of them.
  function check(doc, defs, rule, options = {}) {
    const t0 = globalThis.performance?.now?.() ?? Date.now();
    const parts = options.parts || (doc?.items || []).filter(i => i.kind === "part").map(i => record(i, defs, rule)).filter(Boolean);
    const reach = maxGap(rule), only = options.ids ? new Set(options.ids) : null, limit = options.limit ?? 5000, out = [];
    const order = parts.slice().sort((a, b) => a.box[0] - b.box[0]);
    for (let i = 0; i < order.length && out.length < limit; i++) {
      const a = order[i];
      for (let j = i + 1; j < order.length; j++) {
        const b = order[j];
        if (b.box[0] > a.box[2] + reach) break;
        if (only && !only.has(a.id) && !only.has(b.id)) continue;
        const v = pairCheck(rule, a, b);
        if (v) { out.push(v); if (out.length >= limit) break; }
      }
    }
    return {violations: out, parts: parts.length, ms: Math.round((globalThis.performance?.now?.() ?? Date.now()) - t0)};
  }
  // rules.js hook: R.byType.dfaSpacing rules carry scope matchers (m1). A pair uses the first
  // rule (by priority) whose scope matches either part.
  function drc(doc, defs, {rules, flag, notes, stats}) {
    if (!rules?.length) return;
    const parts = (doc.items || []).filter(i => i.kind === "part");
    const ruleOf = item => rules.find(r => r.m1({net: "", component: item.ref})) || null;
    // Group by rule so each rule measures its own outline.
    const byRule = new Map();
    for (const i of parts) { const r = ruleOf(i); if (r) { if (!byRule.has(r)) byRule.set(r, []); byRule.get(r).push(i); } }
    let n = 0;
    const all = new Map();
    for (const [r, items] of byRule) for (const i of items) { const rec = record(i, defs, r); if (rec) { rec.rule = r; all.set(i.id, rec); } }
    const recs = [...all.values()].sort((a, b) => a.box[0] - b.box[0]), reach = Math.max(...rules.map(maxGap));
    for (let i = 0; i < recs.length; i++) {
      const a = recs[i];
      for (let j = i + 1; j < recs.length; j++) {
        const b = recs[j];
        if (b.box[0] > a.box[2] + reach) break;
        n++;
        const r = rules.indexOf(a.rule) <= rules.indexOf(b.rule) ? a.rule : b.rule;
        const v = pairCheck(r, a, b);
        if (v) flag(r, {id: v.id, otherId: v.otherId, title: v.refs[0] + " (" + label(v.types[0]) + ") ↔ " + v.refs[1] + " (" + label(v.types[1]) + ")",
          what: r.measure === "courtyard" ? "Courtyard gap" : "Body gap", actual: v.actual, required: v.required, limit: "min", at: v.at, otherAt: v.otherAt});
      }
    }
    if (stats) stats.candidates += n;
    if (!parts.length) notes?.push?.("DFA spacing: the board has no components.");
  }
  function activeRule(doc, project) {
    const R = globalThis.AtriumRules;
    const set = globalThis.AtriumRules?.stored?.(doc, project);
    if (!set || !R) return null;
    const list = set.version === 2 ? set.list : [];
    return list.filter(r => r.type === "dfaSpacing" && r.enabled).sort((a, b) => a.priority - b.priority)[0] || null;
  }
  // Every package type on a board, with counts (for the matrix editor).
  function boardTypes(doc, defs) {
    const counts = new Map();
    for (const i of doc?.items || []) if (i.kind === "part") { const t = packageType(i, defOf(defs, i.def)); counts.set(t, (counts.get(t) || 0) + 1); }
    return counts;
  }
  function validateMatrix(m) {
    if (!Array.isArray(m) || m.length > 400) throw Error("The DFA matrix must be a list of up to 400 package pairs.");
    for (const e of m) {
      if (!e || typeof e !== "object" || Object.keys(e).some(k => !["a", "b", "gap"].includes(k))) throw Error("Each DFA matrix entry needs a, b and gap.");
      for (const t of [e.a, e.b]) if (t !== "any" && !IDS.has(t)) throw Error("Unknown package type " + t + ".");
      if (typeof e.gap !== "number" || !(e.gap >= 0) || e.gap > 100) throw Error("DFA gaps must be between 0 and 100 mm.");
    }
    return m;
  }

  // ------------------------------------------------------------------ live overlay
  let H = null, grid = null;
  function staticIndex(doc, defs, rule, rev) {
    const key = doc.id + "|" + rev + "|" + JSON.stringify(rule);
    if (grid?.key === key && grid.doc === doc) return grid;
    const parts = [], cell = 4, cells = new Map();
    for (const i of doc.items) if (i.kind === "part") { const r = record(i, defs, rule); if (r) parts.push(r); }
    for (const r of parts) for (let x = Math.floor(r.box[0] / cell); x <= Math.floor(r.box[2] / cell); x++) for (let y = Math.floor(r.box[1] / cell); y <= Math.floor(r.box[3] / cell); y++) {
      const k = x + "," + y; let l = cells.get(k); if (!l) cells.set(k, l = []); l.push(r);
    }
    grid = {key, doc, parts, cells, cell};
    return grid;
  }
  function near(g, box, reach) {
    const out = new Set(), c = g.cell;
    for (let x = Math.floor((box[0] - reach) / c); x <= Math.floor((box[2] + reach) / c); x++) for (let y = Math.floor((box[1] - reach) / c); y <= Math.floor((box[3] + reach) / c); y++)
      for (const r of g.cells.get(x + "," + y) || []) out.add(r);
    return out;
  }
  // Moving parts: the placement ghost, else the selected parts (they follow the cursor while dragged).
  function liveCheck(doc, defs, rule, moving, rev) {
    const g = staticIndex(doc, defs, rule, rev), reach = maxGap(rule), skip = new Set(moving.map(m => m.id)), out = [], recs = [];
    for (const m of moving) {
      const a = record(m, defs, rule);
      if (!a) continue;
      recs.push(a);
      for (const b of near(g, a.box, reach)) {
        if (skip.has(b.id)) continue;
        const v = pairCheck(rule, a, b);
        if (v) out.push({...v, poly: b.poly});
      }
    }
    for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) { const v = pairCheck(rule, recs[i], recs[j]); if (v) out.push({...v, poly: recs[j].poly}); }
    return {recs, violations: out};
  }
  const COLORS = {ok: "rgba(46,160,90,.9)", bad: "rgba(230,40,40,.95)", fill: "rgba(230,40,40,.18)", halo: "rgba(46,160,90,.45)"};
  function drawPoly(ctx, P) { ctx.beginPath(); ctx.moveTo(P[0][0], P[0][1]); for (let k = 1; k < P.length; k++) ctx.lineTo(P[k][0], P[k][1]); ctx.closePath(); }
  function grown(rec, d) {
    // Each edge moves out by d along its own normal; corners are the mitred intersections.
    const P = rec.poly, n = P.length;
    let area = 0; for (let i = 0; i < n; i++) { const a = P[i], b = P[(i + 1) % n]; area += a[0] * b[1] - b[0] * a[1]; }
    const s = area >= 0 ? 1 : -1, normal = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1; return [s * dy / l, -s * dx / l]; };
    return P.map((p, i) => {
      const n1 = normal(P[(i - 1 + n) % n], p), n2 = normal(p, P[(i + 1) % n]), k = Math.max(.25, 1 + n1[0] * n2[0] + n1[1] * n2[1]);
      return [p[0] + d * (n1[0] + n2[0]) / k, p[1] + d * (n1[1] + n2[1]) / k];
    });
  }
  function paint(result, rule) {
    return (ctx, {scale}) => {
      const px = 1 / scale, bad = new Set(result.violations.flatMap(v => [v.id]));
      ctx.save(); ctx.lineJoin = "round";
      for (const r of result.recs) {
        const worst = Math.max(...result.violations.filter(v => v.id === r.id).map(v => v.required), 0) || gapFor(rule, r.type, r.type);
        ctx.setLineDash([5 * px, 4 * px]); ctx.lineWidth = 1.2 * px; ctx.strokeStyle = bad.has(r.id) ? COLORS.bad : COLORS.halo;
        drawPoly(ctx, grown(r, worst)); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.font = 11 * px + "px system-ui, sans-serif"; ctx.textBaseline = "bottom";
      for (const v of result.violations) {
        ctx.fillStyle = COLORS.fill; ctx.strokeStyle = COLORS.bad; ctx.lineWidth = 1.6 * px;
        drawPoly(ctx, v.poly); ctx.fill(); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(v.at[0], v.at[1]); ctx.lineTo(v.otherAt[0], v.otherAt[1]); ctx.stroke();
        const m = [(v.at[0] + v.otherAt[0]) / 2, (v.at[1] + v.otherAt[1]) / 2], text = "DFA " + v.actual.toFixed(2) + " < " + v.required.toFixed(2) + " mm";
        const w = ctx.measureText(text).width;
        ctx.fillStyle = "rgba(20,20,20,.78)"; ctx.fillRect(m[0] + 4 * px, m[1] - 15 * px, w + 6 * px, 14 * px);
        ctx.fillStyle = "#fff"; ctx.fillText(text, m[0] + 7 * px, m[1] - 2 * px);
      }
      ctx.restore();
    };
  }
  let live = true;
  function render(d, info) {
    if (!live || !info?.active || d?.kind !== "pcb" || !H) return null;
    const rule = activeRule(d, H.project());
    if (!rule) return null;
    const g = info.ghost;
    let moving;
    if (g && g.kind === "part") moving = [g];
    else {
      const sel = new Set(H.selection());
      if (!sel.size || sel.size > 200) return null;
      moving = d.items.filter(i => i.kind === "part" && sel.has(i.id));
    }
    if (!moving.length) return null;
    const result = liveCheck(d, H.defs(), rule, moving, H.revision());
    return {overlay: paint(result, rule)};
  }
  function install(host) {
    if (H) return;
    H = host;
    host.addRenderer(render);
    host.registerAction?.("dfa-live", () => { live = !live; globalThis.AtriumNavCommon?.setChecked?.("dfa-live", live); host.info?.(live ? "Live DFA spacing check on." : "Live DFA spacing check off."); host.redraw?.(); });
    globalThis.AtriumNavCommon?.menuItem?.("tools", "dfa-live", "Live DFA Spacing Check", {after: "drc", scope: "pcb", checkable: true});
    globalThis.AtriumNavCommon?.setChecked?.("dfa-live", live);
  }
  if (globalThis.AtriumNavCommon?.ready && typeof document !== "undefined") AtriumNavCommon.ready(install);

  return Object.freeze({TYPES, DEFAULT_MATRIX, DEFAULT_GAP, defaultRule, label, packageType, fromText, gapFor, maxGap, setGap, outlines, outlineEvidence, polyGap,
    check, drc, activeRule, boardTypes, validateMatrix, liveCheck, record});
})();
