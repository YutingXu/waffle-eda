"use strict";
// End-to-end pipeline for one corpus project: import -> model checks against the source ->
// outputs -> comparison with the original tool's own outputs -> native round trip.
//
// The oracles are never Waffle:
//   model checks   the source file read by an independent minimal reader in this folder
//                  (altium-oracle.cjs, kicad-oracle.cjs), never the importer;
//   output checks  fabrication files the source tool generated and the project ships;
//   round trip     Waffle's own first-generation outputs, which must be reproduced exactly.
// A snapshot of Waffle's own output is never used as the reference for correctness.
//
// Every check yields {id, pass, metric, detail}. Gating checks fail the suite unless
// known-failures.json lists them with a bug reference; informational ones never gate.
// The caller loads the app modules (modules.cjs) before requiring this file.

const C = require("../formats/gerber-compare.cjs");
const Films = require("../altium-fidelity/films.cjs");
const AltiumOracle = require("./altium-oracle.cjs");
const KicadOracle = require("./kicad-oracle.cjs");
const {TOL, face, faceRow, segRow, arcRow} = require("./pipeline-rows.cjs");
const Render = require("./render.cjs");

const DATE = new Date("2025-01-01T12:00:00Z");

// ------------------------------------------------------------------ helpers
const round = (v, d = 4) => Math.round(v * 10 ** d) / 10 ** d;
const mod = (a, m) => ((a % m) + m) % m;
function check(id, pass, metric = {}, detail = [], gating = true) {
  return {id, pass:!!pass, gating, metric, detail:detail.slice(0, 6)};
}
function inc(o, k, n = 1) { o[k] = (o[k] || 0) + n; return o; }

// Waffle layer names to the oracle's neutral names.
function neutralLayer(name) {
  if (name === "Top") return "top";
  if (name === "Bottom") return "bottom";
  if (name === "Multi") return "multi";
  const m = /^Inner (\d+)$/.exec(name || "");
  return m ? "mid" + m[1] : String(name || "").toLowerCase();
}
const COPPER = l => l === "top" || l === "bottom" || /^mid\d+$/.test(l);

// Spatial multiset matching. A row is {cat, v:[...], alt?:[...], tol:[...], ref}.
function match(source, output) {
  const cell = 0.05, key = (cat, x, y) => cat + "|" + Math.floor(x / cell) + "," + Math.floor(y / cell);
  const grid = new Map();
  for (const row of output) {
    const k = key(row.cat, row.v[0], row.v[1]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(row);
  }
  const close = (a, b, tol) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol[i]);
  const missing = [], pairs = [];
  for (const row of source) {
    let found = null;
    for (const v of [row.v, row.alt].filter(Boolean)) {
      const cx = Math.floor(v[0] / cell), cy = Math.floor(v[1] / cell);
      for (let dx = -1; dx <= 1 && !found; dx++) for (let dy = -1; dy <= 1 && !found; dy++) {
        for (const cand of grid.get(row.cat + "|" + (cx + dx) + "," + (cy + dy)) || []) {
          if (!cand.used && close(v, cand.v, row.tol)) { found = cand; break; }
        }
      }
      if (found) break;
    }
    if (found) { found.used = true; pairs.push([row, found]); } else missing.push(row);
  }
  const extra = output.filter(r => !r.used);
  for (const r of output) delete r.used;
  return {matched:pairs.length, missing, extra, pairs};
}
const describe = r => r.cat + " " + r.v.map(x => round(x, 4)).join(",") + (r.ref ? " " + r.ref : "");

// ------------------------------------------------------------------ Waffle side
function boardOf(model) { return model.documents.find(d => d.kind === "pcb"); }
function defsOf(model) { return new Map(model.library.map(d => [d.id, d])); }

// Placed copper from the Waffle model, in the Waffle frame (mm, Y down).
function waffleCopper(model) {
  const A = Atrium, board = boardOf(model), defs = defsOf(model);
  const rows = {tracks:[], arcs:[], pads:[], vias:[], slots:[]}, parts = [];
  function path(layer, item, place, net, ref) {
    const arc = item.arc || A.pathArc?.(item);
    if (arc && arc.r > 0) {
      const sweep = A.arcSweep(arc), at = t => place(A.arcPoint(arc, t));
      rows.arcs.push(arcRow(layer, place(arc.c), arc.r, item.width || 0, sweep, at(arc.start), at(arc.start + sweep), at(arc.start + sweep / 2), net, ref));
      return;
    }
    const pts = item.points || [];
    for (let i = 0; i + 1 < pts.length; i++) rows.tracks.push(segRow(layer, place(pts[i]), place(pts[i + 1]), item.width || 0, net, ref));
  }
  function pad(p, at, angle, layer, ref, mirror = false) {
    if (p.drill > 0 && p.slotLength > p.drill) {
      const slotTurn = (p.slotAngle || 0) * (mirror ? -1 : 1);
      const turn = (angle + slotTurn) * Math.PI / 180, half = (p.slotLength - p.drill) / 2;
      const dx = Math.cos(turn) * half, dy = Math.sin(turn) * half;
      rows.slots.push(segRow(p.plated !== false ? "plated" : "non-plated",
        [at[0] - dx, at[1] - dy], [at[0] + dx, at[1] + dy], p.drill, "", ref));
    }
    if (p.holeOnly || !(layer === "multi" || COPPER(layer))) return;
    const faces = layer === "multi" ? ["top", "bottom"] : [layer];
    for (const f of faces) {
      const s = p.padStack ? p.padStack[f === "top" ? "Top" : "Bottom"] : p;
      if (!s) continue;
      const shape = s.shape || p.shape, ratio = s.roundrectRadiusRatio ?? p.roundrectRadiusRatio;
      const radius = shape === "roundrect" ? (ratio ?? 0.25) * Math.min(s.w, s.h) : 0;
      if (p.plated === false && p.drill > 0 && p.drill >= Math.min(s.w, s.h) - 1e-6) continue;  // the hole removes the land
      const g = face(shape, s.w, s.h, angle, radius);
      const poly = shape === "custom" && (s.poly || p.poly);
      const area = poly ? Math.abs(poly.reduce((n, a, i) => { const b = poly[(i + 1) % poly.length]; return n + a[0] * b[1] - b[0] * a[1]; }, 0) / 2) : undefined;
      if (g) rows.pads.push(faceRow(f, g, at[0], at[1], p.drill, ref, area));
    }
  }
  const keep = item => !(item.keepout || item.layer === "Keepout" || item.sourcePour != null || item.fill || item.closed);
  const via = (v, at, net) => rows.vias.push({cat:neutralLayer(v.fromLayer || "Top") + "-" + neutralLayer(v.toLayer || "Bottom"),
    v:[at[0], at[1], v.diameter, v.drill], tol:[TOL.mm, TOL.mm, TOL.mm, TOL.mm], net:net || ""});
  for (const item of board.items) {
    const layer = neutralLayer(item.layer);
    if (item.kind === "track" && COPPER(layer) && keep(item)) path(layer, item, q => q, item.net || "", "track");
    else if (item.kind === "via") via(item, [item.x, item.y], item.net);
    else if (item.kind === "pad") pad(item, [item.x, item.y], item.angle || 0, neutralLayer(item.layer || "Multi"), "free pad " + (item.number || ""));
    else if (item.kind === "part") {
      const def = defs.get(item.def);
      parts.push({ref:item.ref, x:item.x, y:item.y, angle:item.angle || 0, side:item.layer === "Bottom" ? "bottom" : "top"});
      for (const s of def?.footprint?.shapes || []) {
        const l = neutralLayer(AtriumPCBAppearance.shapeLayer(item, s));
        if (COPPER(l) && !s.fill && !s.closed && !s.keepout && (s.kind === "path" || s.kind === "track" || s.points || s.arc))
          path(l, s, q => A.world(q, item), "", item.ref);
      }
      for (const p of A.pins(item, def, "pcb")) {
        // A footprint-owned via (Altium: a via whose component is set) is a via, not a pad.
        if (p.kind === "via") { via(p, p.at, p.net); continue; }
        const angle = (item.mirror ? -(p.angle || 0) : (p.angle || 0)) + (item.angle || 0);
        pad(p, p.at, angle, neutralLayer(AtriumPCBAppearance.padLayer(item, p)), item.ref + "." + p.number, item.mirror);
      }
    }
  }
  return {rows, parts};
}

// Pin -> net groups recorded on the Waffle board.
function waffleBoardNets(model) {
  const board = boardOf(model), defs = defsOf(model), groups = new Map();
  for (const item of board.items) {
    if (item.kind !== "part") continue;
    for (const p of Atrium.pins(item, defs.get(item.def), "pcb")) {
      if (p.kind === "via") continue;  // footprint-owned vias are not pins
      const net = item.pinNets?.[p.number] ?? p.net ?? "";
      if (!net) continue;
      if (!groups.has(net)) groups.set(net, new Set());
      groups.get(net).add(item.ref + "." + p.number);
    }
  }
  return groups;
}

// Compare two pin->net group maps by membership (the partition) and by name.
// Single-pin nets carry no connectivity and some tools omit them, so they are not compared.
function compareNets(source, actual) {
  // Designators compare case-insensitively (Altium's are; a board can spell one differently from its schematic).
  const sig = groups => new Map([...groups].filter(([, m]) => m.size > 1).map(([n, m]) => [[...m].map(p => p.toUpperCase()).sort().join(" "), n]));
  const a = sig(source), b = sig(actual);
  const missing = [...a.keys()].filter(k => !b.has(k)), extra = [...b.keys()].filter(k => !a.has(k));
  const renamed = [...a].filter(([k, n]) => b.has(k) && b.get(k) !== n).map(([k, n]) => n + " -> " + b.get(k));
  // Describe each missing group by its closest extra group: the pins it lost and gained.
  const diff = missing.map(k => {
    const want = new Set(k.split(" ")), best = extra.map(e => e.split(" ")).sort((x, y) => y.filter(p => want.has(p)).length - x.filter(p => want.has(p)).length)[0] || [];
    const have = new Set(best), lost = [...want].filter(p => !have.has(p)), gained = best.filter(p => !want.has(p));
    return "net " + a.get(k) + ": " + want.size + " pins" + (best.length ? ", closest has " + best.length : "") +
      (lost.length ? "; lost " + lost.slice(0, 8).join(" ") : "") + (gained.length ? "; gained " + gained.slice(0, 8).join(" ") : "");
  });
  return {groups:a.size, missing, extra, renamed, diff};
}

// ------------------------------------------------------------------ source side (Altium)
// Source copper in the Waffle frame. Polygon-owned primitives are the stored pour (counted
// separately, compared through the plots); keep-outs are not copper.
function altiumCopper(src) {
  const flip = (x, y) => [x, -y], rows = {tracks:[], arcs:[], pads:[], vias:[], slots:[]}, owned = {polygonTracks:0, polygonArcs:0, keepouts:0};
  for (const t of src.tracks) {
    if (!COPPER(t.layer)) continue;
    if (t.keepout) { owned.keepouts++; continue; }
    if (t.polygon !== 0xffff) { owned.polygonTracks++; continue; }
    rows.tracks.push(segRow(t.layer, flip(t.x1, t.y1), flip(t.x2, t.y2), t.width, t.component ? "" : t.net, t.component || "track"));
  }
  for (const a of src.arcs) {
    if (!COPPER(a.layer)) continue;
    if (a.keepout) { owned.keepouts++; continue; }
    if (a.polygon !== 0xffff) { owned.polygonArcs++; continue; }
    const sweep = mod(a.end - a.start, 360) || 360, rad = d => d * Math.PI / 180;
    const pt = d => flip(a.cx + a.r * Math.cos(rad(d)), a.cy + a.r * Math.sin(rad(d)));
    rows.arcs.push(arcRow(a.layer, flip(a.cx, a.cy), a.r, a.width, sweep, pt(a.start), pt(a.start + sweep), pt(a.start + sweep / 2), a.component ? "" : a.net, a.component || "arc"));
  }
  for (const p of src.pads) {
    const ref = (p.component || "free pad") + "." + p.name;
    if (p.slot) {
      const [a, b] = p.slot.ends.map(([x, y]) => flip(x, y));
      rows.slots.push(segRow(p.plated ? "plated" : "non-plated", a, b, p.slot.width, "", ref));
    }
    const faces = p.layer === "multi" ? ["top", "bottom"] : COPPER(p.layer) ? [p.layer] : [];
    for (const f of faces) {
      const s = p.stack[f];
      if (!(s.w > 0 && s.h > 0)) continue;
      if (!p.plated && p.drill > 0 && p.drill >= Math.min(s.w, s.h) - 1e-6) continue;  // the hole removes the land
      const radius = s.shape === "roundrect" ? (s.cornerPct ?? 50) / 100 * Math.min(s.w, s.h) / 2 : 0;
      const g = face(s.shape, s.w, s.h, -p.rotation, radius);
      if (g) rows.pads.push(faceRow(f, g, p.x, -p.y, p.drill, ref));
    }
  }
  for (const v of src.vias) rows.vias.push({cat:v.from + "-" + v.to, v:[v.x, -v.y, v.diameter, v.drill], tol:[TOL.mm, TOL.mm, TOL.mm, TOL.mm], net:v.net});
  const parts = src.components.map(c => ({ref:c.designator, x:c.x, y:-c.y, angle:-c.rotation, side:c.layer}));
  return {rows, parts, owned};
}

// ------------------------------------------------------------------ model checks
// Approximations: geometry the model holds in a different, equivalent form. A source arc drawn
// as chords that stay on its circle, or a parametric pad replaced by an outline of the same
// extent and area, passes the geometry check and is counted by the "-parametric" check.
function approximatePads(m) {
  const found = [];
  for (const s of [...m.missing]) {
    const face = s.cat.split("|")[0];
    const c = m.extra.find(e => e.cat === face + "|custom" && Math.abs(e.v[0] - s.v[0]) <= TOL.mm && Math.abs(e.v[1] - s.v[1]) <= TOL.mm &&
      Math.abs(e.v[2] - s.v[2]) <= TOL.mm && Math.abs(e.v[3] - s.v[3]) <= TOL.mm && Math.abs(e.area - s.area) <= Math.max(0.01 * s.area, 1e-4));
    if (!c) continue;
    m.missing.splice(m.missing.indexOf(s), 1); m.extra.splice(m.extra.indexOf(c), 1); found.push(s.cat + " as custom outline " + s.ref);
  }
  return found;
}
function approximateArcs(arcs, tracks) {
  const found = [], mod2 = a => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  for (const s of [...arcs.missing]) {
    const {c, r, width, p0, p1, mid, full} = s.geom, ang = q => Math.atan2(q[1] - c[1], q[0] - c[0]);
    const t0 = ang(p0), span = full ? 2 * Math.PI : mod2(ang(p1) - t0), forward = full || mod2(ang(mid) - t0) <= span;
    const inside = q => { const d = forward ? mod2(ang(q) - t0) : mod2(t0 - ang(q)); return d <= (forward ? span : 2 * Math.PI - span) + 1e-6; };
    const on = q => Math.abs(Math.hypot(q[0] - c[0], q[1] - c[1]) - r) <= 0.005 && inside(q);
    const chords = tracks.extra.filter(t => t.cat === s.cat && Math.abs(t.v[4] - width) <= TOL.mm && on([t.v[0], t.v[1]]) && on([t.v[2], t.v[3]]));
    const length = chords.reduce((n, t) => n + Math.hypot(t.v[2] - t.v[0], t.v[3] - t.v[1]), 0), want = r * (full ? 2 * Math.PI : Math.abs(s.v[4]) * Math.PI / 180);
    if (!chords.length || Math.abs(length - want) > Math.max(0.02 * want, 0.01)) continue;
    arcs.missing.splice(arcs.missing.indexOf(s), 1);
    for (const t of chords) tracks.extra.splice(tracks.extra.indexOf(t), 1);
    found.push(s.cat + " arc r=" + round(r, 3) + " as " + chords.length + " chords");
  }
  return found;
}
function primitiveChecks(source, actual, label) {
  const out = [], kinds = ["tracks", "arcs", "pads", "vias"], m = {};
  if (source.rows.slots) kinds.push("slots");
  for (const kind of kinds) m[kind] = match(source.rows[kind], actual.rows[kind]);
  const approximated = {arcs:approximateArcs(m.arcs, m.tracks), pads:approximatePads(m.pads)};
  for (const kind of kinds) {
    const {missing, extra, pairs} = m[kind], byCat = {};
    for (const r of missing) inc(byCat, "missing " + r.cat);
    for (const r of extra) inc(byCat, "extra " + r.cat);
    let nets = 0;
    const netDetail = [];
    for (const [s, w] of pairs) if (s.net && w.net !== undefined && w.net !== "" && s.net !== w.net) { nets++; netDetail.push(describe(s) + " net " + s.net + " -> " + w.net); }
    out.push(check("model." + kind, !missing.length && !extra.length && !nets,
      {source:source.rows[kind].length, waffle:actual.rows[kind].length, matched:pairs.length, approximated:(approximated[kind] || []).length,
        missing:missing.length, extra:extra.length, netMismatch:nets, byCategory:byCat},
      [...missing.map(r => "missing " + describe(r)), ...extra.map(r => "extra " + describe(r)), ...netDetail]));
    if (approximated[kind]) out.push(check("model." + kind + "-parametric", !approximated[kind].length, {approximated:approximated[kind].length}, approximated[kind]));
  }
  // Placement of every component origin.
  const want = new Map(source.parts.map(p => [p.ref.toUpperCase(), p])), placement = [];
  let bad = 0;
  for (const p of actual.parts) {
    const s = want.get(p.ref.toUpperCase());
    if (!s) { bad++; placement.push("extra " + p.ref); continue; }
    want.delete(p.ref.toUpperCase());
    const d = Math.hypot(p.x - s.x, p.y - s.y), r = Math.abs(mod(p.angle - s.angle + 180, 360) - 180);
    if (d > TOL.mm || r > TOL.deg || p.side !== s.side) { bad++; placement.push(p.ref + " moved " + round(d) + " mm, " + round(r, 2) + " deg, " + s.side + " -> " + p.side); }
  }
  for (const ref of want.keys()) { bad++; placement.push("missing " + ref); }
  out.push(check("model.placement", !bad, {source:source.parts.length, waffle:actual.parts.length, wrong:bad}, placement));
  return out;
}

function outlineChecks(sourceRing, model) {
  const board = boardOf(model), ring = board.outline || [];
  const area = r => Math.abs(r.reduce((s, p, i) => { const q = r[(i + 1) % r.length]; return s + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  const box = r => r.reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [Infinity, Infinity, -Infinity, -Infinity]);
  if (!sourceRing.length) return check("model.outline", ring.length > 0, {reason:"source has no outline record"}, [], false);
  const sa = area(sourceRing), wa = area(ring), sb = box(sourceRing), wb = box(ring);
  const boxErr = Math.max(...sb.map((v, i) => Math.abs(v - wb[i])));
  return check("model.outline", ring.length >= 3 && Math.abs(sa - wa) <= Math.max(0.05, sa * 1e-4) && boxErr <= TOL.mm * 5,
    {sourceAreaMm2:round(sa, 3), waffleAreaMm2:round(wa, 3), boxErrorMm:round(boxErr, 4)});
}

// The Altium Board6 outline with arcs sampled (Waffle frame).
function altiumOutline(src) {
  const v = src.outline, ring = [];
  for (let i = 0; i < v.length; i++) {
    const a = v[i], b = v[(i + 1) % v.length];
    ring.push([a.x, -a.y]);
    if (a.arc && a.r > 0 && i + 1 < v.length) {
      const ang = p => Math.atan2(p.y - a.cy, p.x - a.cx), t0 = ang(a), t1 = ang(b);
      // Altium arcs run counter-clockwise from SA to EA; walk the direction that matches.
      const ccw = Math.abs(mod(t0 * 180 / Math.PI, 360) - mod(a.sa, 360)) < 1;
      let sweep = ccw ? mod(t1 - t0, 2 * Math.PI) : -mod(t0 - t1, 2 * Math.PI);
      for (let k = 1; k < 64; k++) { const t = t0 + sweep * k / 64; ring.push([a.cx + a.r * Math.cos(t), -(a.cy + a.r * Math.sin(t))]); }
    }
  }
  if (ring.length > 1 && Math.hypot(ring[0][0] - ring.at(-1)[0], ring[0][1] - ring.at(-1)[1]) < 1e-6) ring.pop();
  return ring;
}

function polygonChecks(sourceCount, model) {
  const board = boardOf(model);
  const pours = board.items.filter(i => i.kind === "polygon" && !i.cutout && !i.keepout).length;
  return check("model.pours", pours === sourceCount, {source:sourceCount, waffle:pours});
}

// A board file read by its independent oracle, as neutral rows: {kicad, copper:{rows, parts}, nets, outline, pours}.
// Each part is read when first asked for, so a reader that throws on one loses only that check.
function oracleBoard(file) {
  const kicad = /\.kicad_pcb$/i.test(file.name);
  const src = kicad ? KicadOracle.readBoard(new TextDecoder().decode(file.bytes)) : AltiumOracle.readBoard(file.bytes);
  const once = fn => { let value, done = false; return () => done ? value : (done = true, value = fn()); };
  const copper = once(() => kicad ? KicadOracle.copper(src) : altiumCopper(src));
  const nets = once(() => kicad ? KicadOracle.padNetGroups(src) : AltiumOracle.padNetGroups(src));
  const outline = once(() => kicad ? KicadOracle.outline(src) : altiumOutline(src));
  // Every copper pour record, split planes included (Waffle keeps a split plane as a plane-layer pour).
  const pours = once(() => kicad ? src.zones.length : src.polygons.filter(p => /^(TOP|BOTTOM|MID\d+|PLANE\d+)$/i.test(p.layer.replace(/LAYER$/i, ""))).length);
  return {kicad, get copper() { return copper(); }, get nets() { return nets(); }, get outline() { return outline(); }, get pours() { return pours(); },
    // What the source does not let move on its own (Waffle frame); null when the reader does not know.
    fixed:kicad ? null : {refs:src.components.filter(c => c.fixed).map(c => c.designator), vias:src.vias.filter(v => v.fixed).map(v => [v.x, -v.y]),
      free:src.vias.filter(v => !v.fixed && v.net).map(v => [v.x, -v.y])}};
}
// The Waffle model against a board read by its oracle: primitives, placement, netlist, outline, pours.
// Rows are pushed to `out` as they are made, so the ones before a throw are kept.
function sourceChecks(source, model, label, out = []) {
  out.push(...primitiveChecks(source.copper, waffleCopper(model), label));
  const nets = compareNets(source.nets, waffleBoardNets(model));
  out.push(check("model.netlist", !nets.missing.length && !nets.extra.length && !nets.renamed.length,
    {groups:nets.groups, missing:nets.missing.length, extra:nets.extra.length, renamed:nets.renamed.length}, [...nets.diff, ...nets.renamed]));
  out.push(outlineChecks(source.outline, model));
  out.push(polygonChecks(source.pours, model));
  return out;
}

// ------------------------------------------------------------------ outputs
function generate(model, fixture, layers) {
  const F = AtriumFabOutputs, board = boardOf(model);
  const fab = F.build(model, board.id, {date:DATE, origin:fixture.origin || "auto", layers, pnp:true, drillDrawing:false,
    ...(fixture.drillOrigin && F.drillOriginFor ? {drillOrigin:fixture.drillOrigin} : {})});
  const bom = AtriumBOM.report(model, {titleBlock:false, columns:["designator", "quantity"], now:DATE.toISOString()});
  const netlist = AtriumNetlist.protel(AtriumNetlist.extract(model, {source:"pcb", board:board.id}), {name:model.name, date:DATE.toISOString()});
  return {fab, bom, bomCsv:AtriumBOM.csv(bom), netlist};
}
const ext = name => (/\.([^.]+)$/.exec(name)?.[1] || "").toUpperCase();
// Dates and times are the only legitimate difference between two runs.
const normalise = text => String(text).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?/g, "<date>")
  .replace(/\b\d{4}-\d\d-\d\d\b/g, "<date>").replace(/^(Date:\s*)\S+/gm, "$1<date>").replace(/^(Time:\s*)\S+/gm, "$1<time>");
function outputDigest(gen) {
  const out = {};
  for (const f of gen.fab.files) out[f.name] = normalise(typeof f.content === "string" ? f.content : JSON.stringify(f.content));
  out["bom.csv"] = normalise(gen.bomCsv);
  out["netlist.net"] = normalise(gen.netlist);
  return out;
}

// Protel netlist: "(" NET "REF-PIN"... ")" blocks.
function protelGroups(text) {
  const groups = new Map();
  for (const block of text.split(/\(\s*\r?\n/).slice(1)) {
    const lines = block.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const end = lines.indexOf(")");
    const body = end < 0 ? lines : lines.slice(0, end);
    if (!body.length || body[0].startsWith("[")) continue;
    const [net, ...nodes] = body;
    groups.set(net, new Set(nodes.map(n => { const i = n.lastIndexOf("-"); return n.slice(0, i) + "." + n.slice(i + 1); })));
  }
  return groups;
}

// Shipped plot comparison: per-layer XOR area on the shipped protocol's grid.
function plotChecks(gen, references, fixture) {
  const F = AtriumFabOutputs, fab = gen.fab;
  const legacy = F.originFor(fab.model, {...fab.options, origin:fixture.origin === "auto" ? "outline" : fixture.origin});
  const actual = F.originFor(fab.model, fab.options);
  const offset = Films.referenceOffset(fixture.plotOffsetMm, legacy, actual);
  const plots = fab.files.filter(f => f.kind === "gerber").map(f => ({layer:ext(f.name), text:f.content}));
  const films = Films.measure(references, plots, offset);
  const out = [];
  for (const [key, layer] of Object.entries(films.layers)) {
    const ref = references.find(r => r.key === key), cls = ref.layer === "profile" ? "profile" : /^G(TO|BO)$/.test(ref.layer) ? "legend"
      : /^G(TS|BS|TP|BP)$/.test(ref.layer) ? "mask" : /^G(TL|BL|\d+|P\d+)$/.test(ref.layer) ? "copper" : "other";
    const xor = offset ? layer.registeredXorMm2 : layer.xorMm2;
    const metric = {xorMm2:xor ?? null, missingMm2:offset ? layer.registeredMissingMm2 : layer.missingMm2, addedMm2:offset ? layer.registeredAddedMm2 : layer.addedMm2};
    if (xor == null) { out.push(check("plot." + key, false, {...metric, reason:layer.reason}, [], cls === "copper" || cls === "mask")); continue; }
    if (cls === "profile") {
      const p = layer.profile || {};
      out.push(check("plot." + key, p.centrelineDeviationMm != null && p.centrelineDeviationMm <= TOL.profileMm,
        {...metric, centrelineDeviationMm:p.centrelineDeviationMm, uniformWidthXorMm2:p.uniformWidthXorMm2}));
    } else if (cls === "copper") out.push(check("plot." + key, xor <= TOL.xorCopperMm2, metric));
    else if (cls === "mask") out.push(check("plot." + key, xor <= TOL.xorMaskMm2, metric));
    else out.push(check("plot." + key, true, metric, [], false));  // legend fonts differ by design: reported, not gated
  }
  return out;
}

function drillCheck(gen, referenceTexts, fixture) {
  if (!referenceTexts.length) return check("drill", true, {reason:"no shipped NC drill"}, [], false);
  const F = AtriumFabOutputs, fab = gen.fab;
  const parse = texts => texts.reduce((all, t) => { const p = C.parseExcellon(t); for (const k of ["hits", "slots", "warnings"]) all[k].push(...p[k]); return all; }, {hits:[], slots:[], warnings:[]});
  const out = parse(fab.files.filter(f => f.kind === "drill").map(f => f.content)), ref = parse(referenceTexts);
  const legacy = F.originFor(fab.model, {...fab.options, origin:fixture.origin === "auto" ? "outline" : fixture.origin});
  const frame = F.drillOriginFor?.(fab.model, fab.options) || F.originFor(fab.model, fab.options);
  const offset = Films.referenceOffset(fixture.drillOffsetMm, legacy, frame);
  const hits = offset ? out.hits.map(h => ({...h, x:h.x + offset[0], y:h.y + offset[1]})) : out.hits;
  const d = C.compareDrills(ref, {...out, hits}, TOL.drillMm);
  const metric = {referenceHits:d.ref, missing:d.missing.length, extra:d.extra.length, wrongSize:d.wrong.length, referenceSlots:d.slots.ref, slots:d.slots.out};
  return check("drill", !d.missing.length && !d.extra.length && !d.wrong.length && d.slots.ref === d.slots.out, metric,
    [...d.missing.slice(0, 3).map(h => "missing " + JSON.stringify(h)), ...d.extra.slice(0, 3).map(h => "extra " + JSON.stringify(h))]);
}

// Pick-and-place: Altium "Center-X(mm|mil)", KiCad "PosX". The shipped file's frame is aligned
// by the single translation that best fits all parts; each part must then agree.
function placementTable(text) {
  const lines = String(text).split(/\r?\n/), rows = [];
  let head = null, unit = 1;
  const cells = l => (l.match(/("([^"]*)"|[^,]+|(?<=,)(?=,|$))/g) || []).map(c => c.replace(/^"|"$/g, "").trim());
  for (const line of lines) {
    if (!head) {
      if (/designator|^#?\s*ref\b/i.test(line) && /(x|posx)/i.test(line)) {
        head = (/,/.test(line) ? cells(line) : line.replace(/^#\s*/, "").trim().split(/\s+/)).map(s => s.toLowerCase());
        if (/\(mil\)/i.test(line)) unit = 0.0254;
      }
      continue;
    }
    if (!line.trim() || /^#/.test(line)) continue;
    const c = /,/.test(line) ? cells(line) : line.trim().split(/\s+/), get = re => c[head.findIndex(h => re.test(h))];
    const ref = get(/^(designator|ref)$/);
    if (!ref) continue;
    rows.push({ref, x:+get(/^(center-x|mid x|posx|ref-x|x)/) * unit, y:+get(/^(center-y|mid y|posy|ref-y|y)/) * unit,
      rot:+get(/^rot/), side:/bottom|^b/i.test(get(/^(layer|side|tb)/) || "") ? "bottom" : "top"});
  }
  return rows;
}
function pnpCheck(gen, referenceText) {
  if (!referenceText) return check("pnp", true, {reason:"no shipped pick and place"}, [], false);
  const file = gen.fab.files.find(f => f.kind === "pnp");
  const ref = placementTable(referenceText), out = new Map(placementTable(file.content).map(r => [r.ref, r]));
  const pairs = ref.filter(r => out.has(r.ref)).map(r => [r, out.get(r.ref)]);
  const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 0; };
  const dx = median(pairs.map(([r, o]) => r.x - o.x)), dy = median(pairs.map(([r, o]) => r.y - o.y));
  const bad = [];
  for (const [r, o] of pairs) {
    const d = Math.hypot(o.x + dx - r.x, o.y + dy - r.y), rot = Math.abs(mod(o.rot - r.rot + 180, 360) - 180);
    if (d > TOL.placeMm || rot > TOL.rotDeg || o.side !== r.side) bad.push(r.ref + " " + round(d, 3) + " mm " + round(rot, 2) + " deg " + r.side + "/" + o.side);
  }
  const missing = ref.filter(r => !out.has(r.ref)).map(r => r.ref), extra = [...out.keys()].filter(k => !ref.some(r => r.ref === k));
  return check("pnp", !bad.length && !missing.length && !extra.length,
    {reference:ref.length, generated:out.size, frameOffsetMm:[round(dx, 4), round(dy, 4)], wrong:bad.length, missing:missing.length, extra:extra.length},
    [...bad, ...missing.map(r => "missing " + r), ...extra.map(r => "extra " + r)]);
}

// BOM: every designator the shipped BOM lists, and nothing else.
function expandRefs(text) {
  const out = [];
  for (const part of String(text).split(/\s*[,;]\s*|\s+/)) {
    const m = /^([^\d]*)(\d+)-([^\d]*)(\d+)$/.exec(part);
    if (m && m[1] === m[3] && +m[4] - +m[2] < 10000 && +m[4] >= +m[2]) for (let i = +m[2]; i <= +m[4]; i++) out.push(m[1] + i);
    else if (part) out.push(part);
  }
  return out;
}
function bomCheck(gen, referenceRows) {
  if (!referenceRows) return check("bom", true, {reason:"no shipped BOM"}, [], false);
  const head = referenceRows.findIndex(r => r.some(c => /designator|reference/i.test(c)));
  const col = referenceRows[head]?.findIndex(c => /designator|reference/i.test(c));
  if (head < 0 || col < 0) return check("bom", false, {reason:"the shipped BOM has no designator column"}, [], false);
  const want = new Set(referenceRows.slice(head + 1).flatMap(r => expandRefs(r[col] || "")));
  const col2 = gen.bom.columns.findIndex(c => c.key === "designator");
  const have = new Set(gen.bom.rows.flatMap(r => expandRefs(r[col2] || "")));
  const missing = [...want].filter(r => !have.has(r)), extra = [...have].filter(r => !want.has(r));
  return check("bom", !missing.length && !extra.length, {reference:want.size, generated:have.size, missing:missing.length, extra:extra.length},
    [...missing.map(r => "missing " + r), ...extra.map(r => "extra " + r)]);
}

// ------------------------------------------------------------------ render stage
// The editor's 2D renderer, one copper layer at a time, against the original tool's film for
// that layer (see render.cjs). Inner films are numbered by stack position like Waffle's layers.
function renderChecks(model, gen, references, fixture) {
  const F = AtriumFabOutputs, fab = gen.fab, board = boardOf(model), defs = defsOf(model);
  const legacy = F.originFor(fab.model, {...fab.options, origin:fixture.origin === "auto" ? "outline" : fixture.origin});
  const origin = F.originFor(fab.model, fab.options);
  const offset = Films.referenceOffset(fixture.plotOffsetMm, legacy, origin) || [0, 0];
  const plot = ([x, y]) => [x - origin[0], origin[1] - y];
  // Drilled holes, in the plot frame: copper inside them does not exist.
  const holes = [];
  const hole = (at, d) => { if (d > 0) { const [x, y] = plot(at); holes.push({x, y, r:d / 2}); } };
  for (const i of board.items) {
    if (i.kind === "via" || i.kind === "pad") hole([i.x, i.y], i.drill);
    if (i.kind === "part") for (const p of Atrium.pins(i, defs.get(i.def), "pcb")) hole(p.at, p.drill);
  }
  const out = [];
  for (const ref of references) {
    const m = /^G(TL|BL|(\d+))$/.exec(ref.layer);
    if (!m) continue;
    const layer = m[1] === "TL" ? "Top" : m[1] === "BL" ? "Bottom" : "Inner " + m[2];
    const film = C.parseGerber(ref.text);
    if (film.warnings.length || /TF\.FilePolarity,Negative/.test(ref.text)) {
      out.push(check("render." + ref.key, true, {reason:"negative or unreadable reference film"}, [], false));
      continue;
    }
    const {shapes} = Render.copperShapes(board, defs, layer);
    const toPlot = s => s.k === "poly" ? {...s, rings:s.rings.map(r => r.map(plot))}
      : s.k === "capsule" ? (() => { const a = plot([s.x1, s.y1]), b = plot([s.x2, s.y2]); return {...s, x1:a[0], y1:a[1], x2:b[0], y2:b[1]}; })()
      : (() => { const a = plot([s.x, s.y]); return {...s, x:a[0], y:a[1]}; })();
    const {worst, ...metric} = Render.xorWithMask(C, film, shapes.map(toPlot), holes, offset, 0.025, fixture.dump?.(ref.key));
    out.push(check("render." + ref.key, metric.xorMm2 <= TOL.xorRenderMm2, {...metric, layer, shapes:shapes.length}, worst));
  }
  return out;
}

// ------------------------------------------------------------------ native round trip
// Save through the same native writer the MCP/CLI import uses (mcp/folder-project.js "initial"),
// open through its verified reader ("start"/"feed"/"project"), then save the opened project
// again without edits: no member may change, and the outputs must be reproduced exactly.
// Node's Buffer when present (large STEP payloads), else a chunked fallback for JavaScriptCore.
function base64(bytes) {
  if (typeof Buffer === "function" && !Buffer.prototype.dv)
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
function unbase64(text) {
  if (typeof Buffer === "function" && !Buffer.prototype.dv) return new Uint8Array(Buffer.from(text, "base64"));
  const raw = atob(text), out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
const utf8 = text => new TextEncoder().encode(text);
function nativeSave(model, report, provenance, sources) {
  // As mcp/headless.js hands it to the host: provenance carries file identities, not their bytes.
  provenance = {...provenance, files:(provenance.files || []).map(({bytes, ...identity}) => identity)};
  const body = {project:model, report, provenance, sources:sources.map(s => ({name:s.name, path:s.name, data:base64(s.bytes)}))};
  const [head, files] = AtriumMCPFolder.run({action:"initial"}, base64(utf8(JSON.stringify(body))));
  return {manifest:head.manifest, members:new Map(JSON.parse(files).map(f => [f.path, unbase64(f.data)]))};
}
// A gzip member through the app's own inflater, for hosts without zlib (JavaScriptCore).
function gunzipWithApp(bytes) {
  const size = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0, true);
  return AtriumImportFormats.inflate(bytes.subarray(10, -8), size, size, true);
}
function nativeOpen(saved, gunzip) {
  const run = (args, bytes) => AtriumMCPFolder.run(args, bytes == null ? null : base64(bytes));
  let part = run({action:"start", full:true, models:false}, saved.members.get(saved.manifest)), raw = null;
  while (part.request) {
    const ref = part.request;
    if (part.verify_model) {
      if (!gunzip) throw Error("model verification needs zlib (Node)");
      const data = gunzip(raw);
      part = run({action:"feed", path:ref.path, model:{length:data.length, sha256:AtriumFormat2.sha256(data)}, modelEncoding:null}, null);
    } else {
      raw = saved.members.get(ref.path);
      if (!raw) throw Error("saved project is missing a member it references");
      part = run({action:"feed"}, raw);
    }
  }
  const [, json] = AtriumMCPFolder.run({action:"project"});
  // The import data a host hands its plot worker (mcp/automation.py export_provenance, manufacturing).
  const [, grouped] = AtriumMCPFolder.run({action:"export_provenance", manufacturing:true});
  return Object.defineProperty(JSON.parse(json), "manufacturing", {value:JSON.parse(grouped)});
}
// The editor's copper state of a native project's board (polygon-pour.js state: none, source or stale).
function pourState(project) {
  const board = boardOf(project);
  if (!board) return "none";
  globalThis.AtriumSignals?.attach?.(project);
  const defs = defsOf(project);
  if(board.pcbDrawing?.sourceFill)AtriumPolygonPour.adopt(board,defs,{project},false);
  return AtriumPolygonPour.state(board, defs, {project});
}
function nativeRoundTrip(imported, sources, fixture, layers, first, gunzip, model) {
  const saved = nativeSave(imported.model, imported.report, imported.provenance, sources);
  const reopened = nativeOpen(saved, gunzip);
  // Save the opened project again, unedited, the way the editor saves (folder-project-engine.js):
  // every document item and setting is put back through documentEdits, every library through
  // libraryEdits, the manifest through manifestEdits. No member may change by a byte.
  const M = AtriumFormat2Model, F2 = AtriumFormat2, rewritten = [];
  const manifest = M.manifest(M.parse(saved.members.get(saved.manifest), {kind:"project"}));
  const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
  const resave = (path, base, patch) => {
    const after = (F2.serializePhysical || F2.serialize)(F2.applyDelta(base, patch).file);
    if (!same(saved.members.get(path), after)) rewritten.push(path.replace(/^.*\//, ""));
  };
  for (const ref of manifest.members) {
    const bytes = saved.members.get(ref.path);
    if (!bytes) continue;
    if (ref.kind === "library") {
      const def = reopened.library.find(d => d.id === ref.id);
      if (def) resave(ref.path, M.parse(bytes, {kind:"library", id:ref.id}), M.libraryEdits(M.parse(bytes, {kind:"library", id:ref.id}), def));
    } else {
      const doc = reopened.documents.find(d => d.id === ref.id);
      if (!doc) continue;
      const base = M.parse(bytes, {kind:ref.kind, id:ref.id}), {items, ...settings} = doc;
      resave(ref.path, base, M.documentEdits(base, settings, {put:items, settings:true}));
    }
  }
  const root = M.parse(saved.members.get(saved.manifest), {kind:"project"});
  resave(saved.manifest, root, M.manifestEdits(root, reopened));
  // As the hosts plot a saved project: its legacy view with the retained manufacturing data.
  const second = outputDigest(generate(Atrium.validate(AtriumTranslatorProvenance.toLegacy(reopened, reopened.manufacturing)), fixture, layers));
  const pours = {legacy:pourState(model), imported:pourState(imported.model), reopened:pourState(reopened)};
  // Byte-identical, or geometry-identical: the same text with every number within two units of
  // its last written digit (the native format stores integer nanometres; imported floats round once).
  const near = (a, b) => {
    if (a == null || b == null) return false;
    const num = /-?\d+(?:\.\d+)?/g, sa = a.replace(num, "#"), sb = b.replace(num, "#");
    if (sa !== sb) return false;
    const na = a.match(num) || [], nb = b.match(num) || [];
    return na.every((x, i) => {
      const places = Math.max((x.split(".")[1] || "").length, (nb[i].split(".")[1] || "").length);
      return Math.abs(+x - +nb[i]) <= 2 * 10 ** -places + 1e-12;
    });
  };
  const keys = Object.keys({...first, ...second});
  // A plot whose text changed (draw order, aperture numbering) can still be the same image.
  const R = require("../altium-fidelity/raster.cjs");
  const sameImage = k => {
    if (!/\.(G[A-Z0-9]+|gbr)$/i.test(k) || first[k] == null || second[k] == null) return false;
    try { return R.compare(C.parseGerber(first[k]), C.parseGerber(second[k])).xorMm2 <= 0.05; } catch { return false; }
  };
  const reordered = keys.filter(k => first[k] !== second[k] && !near(first[k], second[k]) && sameImage(k));
  const changed = keys.filter(k => first[k] !== second[k] && !near(first[k], second[k]) && !reordered.includes(k));
  // For the report: how many lines differ, and the largest numeric change on a line of the same shape.
  const describeChange = k => {
    const a = String(first[k] ?? "").split("\n"), b = String(second[k] ?? "").split("\n");
    let lines = 0, worst = 0, shape = 0;
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] === b[i]) continue;
      lines++;
      const na = (a[i] || "").match(/-?\d+(?:\.\d+)?/g) || [], nb = (b[i] || "").match(/-?\d+(?:\.\d+)?/g) || [];
      if ((a[i] || "").replace(/-?\d+(?:\.\d+)?/g, "#") !== (b[i] || "").replace(/-?\d+(?:\.\d+)?/g, "#")) { shape++; continue; }
      na.forEach((x, j) => { worst = Math.max(worst, Math.abs(+x - +nb[j])); });
    }
    return k + ": " + lines + " lines differ" + (shape ? ", " + shape + " change shape" : "") + ", largest numeric change " + worst + " (file units)";
  };
  const rounded = keys.filter(k => first[k] !== second[k] && near(first[k], second[k]));
  return [
    check("roundtrip.reopen-no-rewrite", rewritten.length === 0, {members:saved.members.size, resaved:manifest.members.length + 1, rewritten:rewritten.length}, rewritten),
    // The working copy, its legacy view and the reopened project agree on the stored copper: none
    // of them may judge it stale while another does (a background repour would replace it).
    check("roundtrip.pours-current", pours.reopened === pours.imported && pours.imported === pours.legacy, pours),
    check("roundtrip.outputs-identical", !changed.length, {files:keys.length, byteIdentical:keys.length - changed.length - rounded.length - reordered.length, lastDigitRounding:rounded.length, sameImageReordered:reordered.length, changed:changed.length}, changed.map(k => {
      const xor = /\.(G[A-Z0-9]+|gbr)$/i.test(k) ? (() => { try { return R.compare(C.parseGerber(first[k]), C.parseGerber(second[k])).xorMm2; } catch { return null; } })() : null;
      return describeChange(k) + (xor != null ? ", image XOR " + xor + " mm²" : "");
    })),
  ];
}

// ------------------------------------------------------------------ project runner
// spec: {fixture, translator:"altium"|"kicad", sources:[{name, bytes}], references:{gerbers:[{key, layer, text}],
//        drills:[text], pnp:text, bomRows:[[...]]}, mutate?:fn(model)}
function run(spec) {
  const {fixture} = spec, results = [], t0 = Date.now(), timings = {};
  // A stage that throws is a failing check, so one broken component cannot hide the others.
  const stage = (name, fn) => {
    const t = Date.now();
    if (spec.trace) spec.trace(name);
    try { return fn(); }
    catch (error) { results.push(check("stage." + name, false, {error:String(error?.message || error).slice(0, 240)})); }
    finally { timings[name] = Date.now() - t; }
  };
  // 1. Import exactly as File > Import does.
  const imported = stage("import", () => AtriumTranslators.import(spec.sources, {name:fixture.name || fixture.id, source_rules:"use",
    ...(spec.translator ? {translator:spec.translator} : {})}));
  const accounting = {};
  for (const row of imported?.report?.kinds || []) accounting[row.kind] = {kept:row.kept, approximated:row.approximated, dropped:row.dropped};
  const model = imported && stage("validate", () => Atrium.validate(AtriumTranslatorProvenance.toLegacy(imported.model, imported.provenance)));
  if (!model) return {id:fixture.id, results, accounting, timings, ms:Date.now() - t0};
  if (spec.mutate) spec.mutate(model);
  const board = boardOf(model);
  results.push(check("import", !!board && board.items.length > 0, {documents:model.documents.length, boardItems:board?.items.length || 0}));
  if (!board) return {id:fixture.id, results, accounting, timings, ms:Date.now() - t0};

  // 2. Model against the source read independently.
  stage("model", () => {
    const source = oracleBoard(spec.sources.find(f => /\.(pcbdoc|kicad_pcb)$/i.test(f.name)));
    sourceChecks(source, model, fixture.id, results);
    if (source.copper.owned) results.push(check("model.pour-strokes", true, source.copper.owned, [], false));
  });

  // 2b. ERC and DRC run on the imported design without crashing.
  stage("checks", () => {
    try {
      const command = (op, args, body) => JSON.parse(AtriumHeadless(JSON.stringify({op, args}), body));
      command("load", {digest:fixture.id}, JSON.stringify(model));
      const erc = command("erc", {limit:0}), drc = command("drc", {document_id:board.id, limit:0});
      const drcTotal = drc.rules.reduce((n, r) => n + r.count, 0);
      const metric = {erc:erc.counts, drcFindings:drcTotal, rulesChecked:drc.rules_checked};
      if (spec.sourceDrcViolations != null) metric.sourceDrcViolations = spec.sourceDrcViolations;
      results.push(check("checks.erc-drc", true, metric, [], true));
    } catch (error) {
      results.push(check("checks.erc-drc", false, {error:String(error.message || error).slice(0, 200)}));
    }
  });

  // 3. Outputs, and 4. comparison with the original tool's files.
  const refs = spec.references || {};
  const layers = Object.fromEntries((refs.gerbers || []).map(r => r.layer === "profile" ? "GM1" : r.layer).filter(k => /^[A-Z0-9]+$/.test(k)).map(k => [k, true]));
  let gen;
  stage("outputs", () => {
    gen = generate(model, fixture, layers);
    const ipc = (() => { try { return AtriumIPC2581?.export ? !!AtriumIPC2581.export(model, {documentId:board.id}) : null; } catch (e) { return String(e.message || e); } })();
    results.push(check("outputs.generated", gen.fab.files.some(f => f.kind === "gerber") && gen.fab.files.some(f => f.kind === "drill") && gen.fab.files.some(f => f.kind === "pnp"),
      {files:gen.fab.files.length, gerbers:gen.fab.files.filter(f => f.kind === "gerber").length, bomLines:gen.bom.lineCount, ipc2581:ipc === true ? "ok" : ipc}));
    const ours = protelGroups(gen.netlist), theirs = waffleBoardNets(model);
    const n = compareNets(theirs, ours);
    results.push(check("outputs.netlist", !n.missing.length && !n.extra.length, {groups:n.groups, missing:n.missing.length, extra:n.extra.length},
      n.diff));
  });
  stage("compare", () => {
    if (refs.gerbers?.length) results.push(...plotChecks(gen, refs.gerbers, fixture));
    results.push(drillCheck(gen, refs.drills || [], fixture));
    results.push(pnpCheck(gen, refs.pnp));
    results.push(bomCheck(gen, refs.bomRows));
  });
  if (refs.gerbers?.length && spec.render !== false) stage("render", () => results.push(...renderChecks(model, gen, refs.gerbers, fixture)));

  // 5. Native round trip.
  if (!spec.mutate && spec.roundTrip !== false) stage("roundtrip", () => {
    try { results.push(...nativeRoundTrip(imported, spec.sources, fixture, layers, outputDigest(gen), spec.gunzip || gunzipWithApp, model)); }
    catch (error) { results.push(check("roundtrip.reopen-no-rewrite", false, {error:String(error.message || error).slice(0, 200)})); }
  });
  return {id:fixture.id, results, accounting, notes:(model.importNotes || []).length, timings, ms:Date.now() - t0};
}

// ------------------------------------------------------------------ known failures
// known: [{project, check, bug, reason}]. A listed check that passes is reported as fixed and
// fails, so the list cannot go stale.
function verdict(report, known) {
  const failures = [], expected = [], fixed = [];
  for (const r of report.results) {
    const k = known.find(k => (k.project === report.id || k.project === "*") && (k.check === r.id || r.id.startsWith(k.check + ".")));
    if (!r.gating) continue;
    if (!r.pass && k) expected.push({...r, bug:k.bug});
    else if (!r.pass) failures.push(r);
    else if (k && k.project === report.id && k.check === r.id) fixed.push({...r, bug:k.bug});
  }
  return {failures, expected, fixed};
}

// Mutations: each injects one gross import error into the model before the checks run.
// Mutations target what the checks compare: footprints of placed parts, free copper tracks.
const usedDefs = model => { const b = boardOf(model), ids = new Set(b.items.filter(i => i.kind === "part").map(i => i.def)); return model.library.filter(d => ids.has(d.id)); };
const copperPad = p => /^(Top|Bottom|Multi)$/.test(p.layer || "Multi") && !p.holeOnly;
const freeTrack = i => i.kind === "track" && i.points?.length >= 2 && i.sourcePour == null && !i.keepout && /^(Top|Bottom|Inner \d+)$/.test(i.layer);
const MUTATIONS = {
  "roundrect-to-round"(model) {
    for (const d of usedDefs(model)) for (const p of d.footprint?.pads || []) {
      if (!copperPad(p)) continue;
      if (p.shape === "roundrect" && !p.padStack) { p.shape = "round"; delete p.roundrectRadiusRatio; return true; }
      if (p.padStack) for (const f of Object.values(p.padStack)) if (f.shape === "roundrect") { f.shape = "round"; return true; }
    }
    return false;
  },
  "any-pad-to-round"(model) {
    for (const d of usedDefs(model)) for (const p of d.footprint?.pads || [])
      if (copperPad(p) && !p.padStack && (p.shape === "rect" || p.shape === "roundrect") && Math.abs(p.w - p.h) > 0.05) { p.shape = "round"; return true; }
    return false;
  },
  "track-width"(model) {
    const t = boardOf(model).items.find(freeTrack);
    if (!t) return false;
    t.width += 0.05; return true;
  },
  "track-endpoint"(model) {
    const t = boardOf(model).items.find(freeTrack);
    if (!t) return false;
    t.points = t.points.map((p, i) => i === t.points.length - 1 ? [p[0] + 0.3, p[1] - 0.2] : p); return true;
  },
  "layer-remap"(model) {
    const t = boardOf(model).items.find(i => freeTrack(i) && (i.layer === "Top" || i.layer === "Bottom"));
    if (!t) return false;
    t.layer = t.layer === "Top" ? "Bottom" : "Top"; return true;
  },
  "drop-polygon"(model) {
    const b = boardOf(model), i = b.items.findIndex(i => i.kind === "polygon" && !i.cutout && !i.keepout);
    if (i < 0) return false;
    const [poly] = b.items.splice(i, 1);
    if (b.pcbDrawing?.pours) b.pcbDrawing.pours = b.pcbDrawing.pours.filter(r => r.polygon !== poly.id);
    b.items = b.items.filter(x => x.sourcePour !== poly.id);
    return true;
  },
};
// Checks a mutation made red, or (for a check already failing) measurably worse.
const WORSE = ["xorMm2", "missing", "extra", "wrong", "wrongSize", "netMismatch", "changed", "rewritten", "missingMm2", "addedMm2"];
function newlyRed(clean, mutated) {
  const before = new Map(clean.results.map(r => [r.id, r]));
  return mutated.results.filter(r => {
    if (!r.gating || r.pass) return false;
    const old = before.get(r.id);
    if (!old || old.pass) return true;
    return WORSE.some(k => typeof r.metric[k] === "number" && typeof old.metric[k] === "number" && r.metric[k] > old.metric[k] + (/Mm2$/.test(k) ? 0.05 : 0));
  }).map(r => r.id);
}

// Source mutations: re-evaluate one app module with a known fix reverted, so a renderer or
// exporter regression (not only a model error) is shown to turn the suite red.
const SOURCE_MUTATIONS = {
  // Revert 2d00bf08: pour (and zero-width region) outlines drawn at the 0.18 mm default width in copper colour ("spaghetti").
  "pour-outline-stroke":{file:"app/canvas/canvas.js", find:"PCB.boardStrokeWidth(i)",
    replace:"(PCB.boardStrokeWidth(i) === 0 ? .18 : PCB.boardStrokeWidth(i))"},
};
function applySourceMutation(name, readText) {
  const m = SOURCE_MUTATIONS[name];
  if (!m) return null;
  const text = readText(m.file);
  if (!text.includes(m.find)) return false;
  (0, eval)(text.replace(m.find, m.replace));
  return true;
}

// Model checks only, for a board read from streams (synthetic variants of real boards).
function altiumModelChecks(src, model) { return primitiveChecks(altiumCopper(src), waffleCopper(model)); }

module.exports = {oracleBoard, sourceChecks, waffleCopper, generate, check, match, describe, mod, boardOf,
  newlyRed, altiumModelChecks, SOURCE_MUTATIONS, applySourceMutation, _native:{save:nativeSave, open:nativeOpen}, run, verdict, MUTATIONS, TOL, face, placementTable, protelGroups, expandRefs, compareNets};
