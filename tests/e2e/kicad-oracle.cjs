"use strict";
// Independent minimal reader for KiCad 6+ boards (.kicad_pcb): the test oracle.
//
// It shares no code with app/formats/import-kicad.js or app/sexpr.js. It reads only the copper the
// end-to-end suite compares (pads with shape and corner ratio, segments, arcs, vias, zones),
// footprint placement, pad nets and the Edge.Cuts outline. KiCad's frame is millimetres with
// Y down; angles in the file are counter-clockwise as seen on screen. The rows it returns use
// the suite's neutral frame (Y down, angles clockwise-positive, which is the negative of KiCad's).

function parse(text) {
  let i = 0;
  function skip() { while (i < text.length && /\s/.test(text[i])) i++; }
  function atom() {
    if (text[i] === '"') {
      let s = ""; i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; s += text[i++]; }
      i++; return s;
    }
    const start = i;
    while (i < text.length && !/[\s()]/.test(text[i])) i++;
    return text.slice(start, i);
  }
  function list() {
    i++; const out = [];
    for (;;) {
      skip();
      if (i >= text.length) throw Error("unterminated s-expression");
      if (text[i] === ")") { i++; return out; }
      out.push(text[i] === "(" ? list() : atom());
    }
  }
  skip();
  if (text[i] !== "(") throw Error("not an s-expression");
  return list();
}
const children = (node, name) => node.filter(n => Array.isArray(n) && n[0] === name);
const child = (node, name) => children(node, name)[0];
const nums = (node, name) => (child(node, name) || []).slice(1).map(Number);

const COPPER = l => l === "top" || l === "bottom" || /^mid\d+$/.test(l);
function layerName(l) {
  if (l === "F.Cu") return "top";
  if (l === "B.Cu") return "bottom";
  const m = /^In(\d+)\.Cu$/.exec(l);
  return m ? "mid" + m[1] : l;
}
const rad = d => d * Math.PI / 180;
// Rotate a footprint-local point by KiCad's on-screen counter-clockwise angle (Y down).
function place([x, y], at) {
  const a = rad(at[2] || 0), c = Math.cos(a), s = Math.sin(a);
  return [at[0] + x * c + y * s, at[1] - x * s + y * c];
}

function readBoard(text) {
  const root = parse(text);
  if (root[0] !== "kicad_pcb") throw Error("not a KiCad board");
  // KiCad 6+ escapes some characters in names as {slash}, {colon} and so on.
  const ESC = {slash:"/", backslash:"\\", lt:"<", gt:">", colon:":", dblquote:'"', quote:"'", tab:"\t", return:"\n", space:" "};
  const unescape = s => String(s).replace(/\{(slash|backslash|lt|gt|colon|dblquote|quote|tab|return|space)\}/g, (_, k) => ESC[k]);
  const netNames = new Map(children(root, "net").map(n => [n[1], unescape(n[2] || "")]));
  const netOf = node => { const n = child(node, "net"); return n ? unescape(n[2] ?? netNames.get(n[1]) ?? "") : ""; };
  const layersOf = node => (child(node, "layers") || child(node, "layer") || []).slice(1);
  const footprints = [], pads = [], segments = [], arcs = [], vias = [], zones = [], edges = [];
  for (const fp of [...children(root, "footprint"), ...children(root, "module")]) {
    const at = nums(fp, "at"), side = (child(fp, "layer") || [])[1] === "B.Cu" ? "bottom" : "top";
    const ref = (children(fp, "property").find(p => p[1] === "Reference") || [])[2]
      ?? (children(fp, "fp_text").find(t => t[1] === "reference") || [])[2] ?? "";
    footprints.push({ref, x:at[0], y:at[1], rotation:at[2] || 0, side});
    for (const p of children(fp, "pad")) {
      const pa = nums(p, "at"), size = nums(p, "size"), drill = child(p, "drill");
      const layers = layersOf(p);
      pads.push({ref, number:String(p[1]), type:p[2], shape:p[3], at:place([pa[0], pa[1]], at), rotation:pa[2] || 0,
        w:size[0], h:size[1], drill:drill ? Number(drill.find((v, k) => k > 0 && /^[\d.]+$/.test(v)) || 0) : 0,
        rratio:nums(p, "roundrect_rratio")[0] ?? null, layers, net:netOf(p)});
    }
  }
  for (const s of children(root, "segment")) segments.push({a:nums(s, "start"), b:nums(s, "end"), width:nums(s, "width")[0], layer:layerName(child(s, "layer")[1]), net:netOf(s)});
  for (const s of children(root, "arc")) arcs.push({a:nums(s, "start"), m:nums(s, "mid"), b:nums(s, "end"), width:nums(s, "width")[0], layer:layerName(child(s, "layer")[1]), net:netOf(s)});
  for (const v of children(root, "via")) {
    const l = layersOf(v);
    vias.push({at:nums(v, "at"), size:nums(v, "size")[0], drill:nums(v, "drill")[0], from:layerName(l[0]), to:layerName(l[1]), net:netOf(v)});
  }
  // One Waffle pour per copper layer of a zone ("*.Cu" and "F&B.Cu" expand to the board's copper layers).
  const copperLayers = (child(root, "layers") || []).slice(1).map(l => l[1]).filter(n => /\.Cu$/.test(n));
  for (const z of children(root, "zone")) {
    if (child(z, "keepout")) continue;
    const named = layersOf(z).flatMap(l => l === "*.Cu" ? copperLayers : l === "F&B.Cu" ? ["F.Cu", "B.Cu"] : [l]).filter(l => /\.Cu$/.test(l));
    for (const l of new Set(named)) zones.push({net:netOf(z), layer:layerName(l)});
  }
  for (const g of [...children(root, "gr_line"), ...children(root, "gr_arc"), ...children(root, "gr_rect"), ...children(root, "gr_circle"), ...children(root, "gr_poly")])
    if ((child(g, "layer") || [])[1] === "Edge.Cuts") edges.push(g);
  return {footprints, pads, segments, arcs, vias, zones, edges};
}

// Centre, radius and signed sweep (clockwise-positive on screen is negative here) of three points.
function circle(a, m, b) {
  const d = 2 * (a[0] * (m[1] - b[1]) + m[0] * (b[1] - a[1]) + b[0] * (a[1] - m[1]));
  const sq = p => p[0] * p[0] + p[1] * p[1];
  const cx = (sq(a) * (m[1] - b[1]) + sq(m) * (b[1] - a[1]) + sq(b) * (a[1] - m[1])) / d;
  const cy = (sq(a) * (b[0] - m[0]) + sq(m) * (a[0] - b[0]) + sq(b) * (m[0] - a[0])) / d;
  const ang = p => Math.atan2(p[1] - cy, p[0] - cx);
  let t0 = ang(a), tm = ang(m), t1 = ang(b);
  const norm = x => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const ccw = norm(tm - t0) < norm(t1 - t0);
  const sweep = ccw ? norm(t1 - t0) : -norm(t0 - t1);
  return {c:[cx, cy], r:Math.hypot(a[0] - cx, a[1] - cy), sweepDeg:sweep * 180 / Math.PI};
}

// Rows in the pipeline's neutral form (see pipeline.cjs: segRow, arcRow, faceRow).
function copper(board) {
  const P = require("./pipeline-rows.cjs");
  const rows = {tracks:[], arcs:[], pads:[], vias:[]};
  for (const s of board.segments) if (COPPER(s.layer)) rows.tracks.push(P.segRow(s.layer, s.a, s.b, s.width, s.net, "segment"));
  for (const s of board.arcs) {
    if (!COPPER(s.layer)) continue;
    const g = circle(s.a, s.m, s.b);
    rows.arcs.push(P.arcRow(s.layer, g.c, g.r, s.width, g.sweepDeg, s.a, s.b, s.m, s.net, "arc"));
  }
  for (const p of board.pads) {
    if (p.type === "np_thru_hole" && !(p.w > p.drill)) continue;
    const faces = [];
    for (const l of p.layers) {
      if (l === "*.Cu") faces.push("top", "bottom");
      else if (l === "F.Cu") faces.push("top");
      else if (l === "B.Cu") faces.push("bottom");
    }
    const shape = p.shape === "circle" ? "round" : p.shape === "oval" ? "round" : p.shape;
    const radius = shape === "roundrect" ? (p.rratio ?? 0.25) * Math.min(p.w, p.h) : 0;
    for (const f of new Set(faces)) {
      const g = P.face(shape, p.w, p.h, -p.rotation, radius);
      if (g) rows.pads.push(P.faceRow(f, g, p.at[0], p.at[1], p.drill, p.ref + "." + p.number));
    }
  }
  for (const v of board.vias) rows.vias.push({cat:v.from + "-" + v.to, v:[v.at[0], v.at[1], v.size, v.drill], tol:[P.TOL.mm, P.TOL.mm, P.TOL.mm, P.TOL.mm], net:v.net});
  const parts = board.footprints.map(f => ({ref:f.ref, x:f.x, y:f.y, angle:-f.rotation, side:f.side}));
  return {rows, parts};
}

function padNetGroups(board) {
  const groups = new Map();
  for (const p of board.pads) {
    if (!p.net || !p.ref || !p.number) continue;
    if (!groups.has(p.net)) groups.set(p.net, new Set());
    groups.get(p.net).add(p.ref + "." + p.number);
  }
  return groups;
}

// Edge.Cuts chained into closed rings (arcs sampled); the outer ring is the largest one.
function outline(board) {
  const pieces = [];
  for (const g of board.edges) {
    if (g[0] === "gr_line") pieces.push([nums(g, "start"), nums(g, "end")]);
    else if (g[0] === "gr_rect") { const a = nums(g, "start"), b = nums(g, "end"); pieces.push([a, [b[0], a[1]], b, [a[0], b[1]], a]); }
    else if (g[0] === "gr_poly") { const pts = children(child(g, "pts") || [], "xy").map(p => [+p[1], +p[2]]); if (pts.length) pieces.push([...pts, pts[0]]); }
    else if (g[0] === "gr_circle") {
      const c = nums(g, "center"), e = nums(g, "end"), r = Math.hypot(e[0] - c[0], e[1] - c[1]);
      pieces.push(Array.from({length:65}, (_, k) => [c[0] + r * Math.cos(2 * Math.PI * k / 64), c[1] + r * Math.sin(2 * Math.PI * k / 64)]));
    } else if (g[0] === "gr_arc" && child(g, "mid")) {
      const a = nums(g, "start"), m = nums(g, "mid"), b = nums(g, "end"), c = circle(a, m, b), t0 = Math.atan2(a[1] - c.c[1], a[0] - c.c[0]);
      const pts = Array.from({length:33}, (_, k) => { const t = t0 + rad(c.sweepDeg) * k / 32; return [c.c[0] + c.r * Math.cos(t), c.c[1] + c.r * Math.sin(t)]; });
      pts[0] = a; pts[32] = b; pieces.push(pts);
    }
  }
  const near = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3, rings = [];
  while (pieces.length) {
    const ring = pieces.shift().slice();
    for (let grown = true; grown && !near(ring[0], ring.at(-1));) {
      grown = false;
      for (let i = 0; i < pieces.length; i++) {
        const p = pieces[i];
        if (near(ring.at(-1), p[0])) ring.push(...p.slice(1));
        else if (near(ring.at(-1), p.at(-1))) ring.push(...p.slice(0, -1).reverse());
        else continue;
        pieces.splice(i, 1); grown = true; break;
      }
    }
    if (near(ring[0], ring.at(-1)) && ring.length > 3) rings.push(ring.slice(0, -1));
  }
  const area = r => Math.abs(r.reduce((n, p, i) => { const q = r[(i + 1) % r.length]; return n + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
  return rings.sort((x, y) => area(y) - area(x))[0] || [];
}

module.exports = {parse, readBoard, copper, padNetGroups, outline, circle};
