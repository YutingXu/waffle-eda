"use strict";
// IDF 3.0 (Intermediate Data Format) board (.emn) and library (.emp) files: the fallback for MCAD
// tools without IDX. DOM-free; needs AtriumMCAD (and AtriumIDX for component body outlines).
//
//   AtriumIDF.write(project, doc, {date, pinHoles}) -> {emn: {name, text}, emp: {name, text}, stats}
//   AtriumIDF.read(emn, emp?)                       -> design for AtriumMCAD.compare (full data set)
//
// The .emn has HEADER, BOARD_OUTLINE (thickness; loop 0 counter-clockwise, cutouts clockwise, each
// loop closed by repeating its first point; an arc is the included angle on its end point, a
// circle a centre then a point with 360), DRILLED_HOLES, PLACE_KEEPOUT / ROUTE_KEEPOUT /
// VIA_KEEPOUT / PLACE_REGION and PLACEMENT. Slotted holes are cutout loops (IDF 3.0 holes are round). Units are MM. Y is up (Waffle's Y negated). IDF has
// no object identifiers: components match by designator, holes by position and diameter.
// Imported text is untrusted: size, line and loop caps; nothing is evaluated or fetched.
globalThis.AtriumIDF = (() => {
  const G = globalThis, M = () => G.AtriumMCAD;
  const LIMITS = Object.freeze({bytes: 32 * 1048576, lines: 2000000, points: 500000});
  const n6 = v => { const r = Math.round(v * 1e6) / 1e6; return Object.is(r, -0) ? "0" : String(r); };
  const q = s => "\"" + String(s ?? "").replace(/"/g, "'").replace(/[\r\n]/g, " ") + "\"";
  const idfDate = d => { const t = d ? new Date(d) : new Date(), v = Number.isFinite(t.getTime()) ? t : new Date(), p = k => String(k).padStart(2, "0");
    return v.getUTCFullYear() + "/" + p(v.getUTCMonth() + 1) + "/" + p(v.getUTCDate()) + "." + p(v.getUTCHours()) + ":" + p(v.getUTCMinutes()) + ":" + p(v.getUTCSeconds()); };
  const area = P => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], r = P[(i + 1) % P.length]; a += p[0] * r[1] - r[0] * p[1]; } return a / 2; };

  // ---------------------------------------------------------------- writer
  // A loop as IDF point records (Y up). contour: Waffle segments (lines, arcs) or null; pts: polygon (Y down).
  function loopRecords(label, contour, pts, ccw) {
    const B = G.AtriumBoardShape, out = [];
    if (contour?.length && B) {
      if (contour.length === 1 && contour[0].kind === "arc" && Math.abs(B.sweep(contour[0])) >= 359.999) {
        const s = contour[0];
        return [label + " " + n6(s.c[0]) + " " + n6(-s.c[1]) + " 0", label + " " + n6(s.c[0] + s.r) + " " + n6(-s.c[1]) + " 360"];
      }
      const flat = B.flattenContour(contour, 0.01).map(p => [p[0], -p[1]]);
      let segs = contour;
      if ((area(flat) > 0) !== ccw) segs = contour.slice().reverse().map(B.reverse);
      const [a0] = B.ends(segs[0]);
      out.push(label + " " + n6(a0[0]) + " " + n6(-a0[1]) + " 0");
      for (const s of segs) { const [, b] = B.ends(s); out.push(label + " " + n6(b[0]) + " " + n6(-b[1]) + " " + (s.kind === "arc" ? n6(B.sweep(s)) : "0")); }
      return out;
    }
    let P = pts.map(p => [p[0], -p[1]]);
    if ((area(P) > 0) !== ccw) P = P.slice().reverse();
    for (const p of [...P, P[0]]) out.push(label + " " + n6(p[0]) + " " + n6(p[1]) + " 0");
    return out;
  }
  function write(project, doc, o = {}) {
    const MC = M(), snap = MC.exportSnapshot(project, doc, o), b = snap.board, defs = new Map((project.library || []).map(d => [d.id, d]));
    o.snapshotResult?.(snap);
    const name = String(doc.name && doc.name !== "Board layout" ? doc.name : project.name || "Board").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "Board";
    const L = [".HEADER", "BOARD_FILE 3.0 \"Waffle\" " + idfDate(o.date) + " 1", q(b.name) + " MM", ".END_HEADER", ".BOARD_OUTLINE ECAD", n6(b.thickness)];
    L.push(...loopRecords(0, b.contour, b.outline, true));
    const cuts = b.cutoutContours?.length ? b.cutoutContours : b.cutouts;
    cuts.forEach((c, i) => L.push(...loopRecords(i + 1, b.cutoutContours?.length ? c : null, b.cutoutContours?.length ? null : c, false)));
    // IDF 3.0 drilled holes are round: a slot is a cutout loop on its outline (AtriumMCAD.compare reads it back as the hole).
    const slots = snap.holes.filter(h => h.slot);
    slots.forEach((h, i) => L.push(...loopRecords(cuts.length + i + 1, MC.slotContour(h.slot[0], h.slot[1], h.d), null, false)));
    L.push(".END_BOARD_OUTLINE", ".DRILLED_HOLES");
    for (const h of snap.holes) {
      if (h.slot) continue;
      const owner = h.owner ? snap.index.get(h.owner) : null;
      L.push(n6(h.d) + " " + n6(h.x) + " " + n6(-h.y) + " " + (h.plated ? "PTH" : "NPTH") + " " + (owner ? q(owner.ref) : "BOARD") + " " + (owner ? (h.plated ? "PIN" : "MTG") : h.via ? "VIA" : "MTG") + " ECAD");
    }
    L.push(".END_DRILLED_HOLES");
    const SECTION = {component: "PLACE_KEEPOUT", route: "ROUTE_KEEPOUT", via: "VIA_KEEPOUT", keepin: "PLACE_REGION", other: "PLACE_KEEPOUT"};
    for (const k of snap.keepouts) {
      const sec = SECTION[k.kind] || "PLACE_KEEPOUT", side = /^bottom$/i.test(k.layer || "") ? "BOTTOM" : /^top$/i.test(k.layer || "") ? "TOP" : "BOTH";
      L.push("." + sec + " ECAD");
      if (sec === "ROUTE_KEEPOUT") L.push(side === "BOTH" ? "ALL" : side);
      else if (sec === "VIA_KEEPOUT") { /* no layer record */ }
      else if (sec === "PLACE_REGION") L.push(side + " " + q("") + " " + n6(k.z1 ?? 0));
      else L.push(side + " " + n6(k.z1 ?? 0));
      L.push(...loopRecords(0, null, k.points, true));
      L.push(".END_" + sec);
    }
    L.push(".PLACEMENT");
    const packages = new Map();
    for (const p of snap.parts) {
      // A mirrored part (pcb-appearance.js) has its own, reflected package outline.
      const geom = p.package, part = p.def + (p.height ? "_" + n6(p.height) : "") + (p.mirror ? "_mirrored" : "");
      L.push(q(geom) + " " + q(part) + " " + q(p.ref), n6(p.x) + " " + n6(-p.y) + " 0 " + n6(MC.norm(-p.angle)) + " " + (p.side === "Bottom" ? "BOTTOM" : "TOP") + " " + (p.locked ? "ECAD" : "PLACED"));
      if (!packages.has(geom + "|" + part)) packages.set(geom + "|" + part, {geom, part, p});
    }
    L.push(".END_PLACEMENT");
    const E = [".HEADER", "LIBRARY_FILE 3.0 \"Waffle\" " + idfDate(o.date) + " 1", ".END_HEADER"];
    for (const {geom, part, p} of packages.values()) {
      const fp = G.AtriumIDX?.footprintOutline ? G.AtriumIDX.footprintOutline({defs}, p) : [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]];
      E.push(".ELECTRICAL", q(geom) + " " + q(part) + " MM " + n6(p.height), ...loopRecords(0, null, fp, true), ".END_ELECTRICAL");
    }
    return {emn: {name: name + ".emn", text: L.join("\n") + "\n"}, emp: {name: name + ".emp", text: E.join("\n") + "\n"},
      stats: {parts: snap.parts.length, holes: snap.holes.length, keepouts: snap.keepouts.length, packages: packages.size}};
  }

  // ---------------------------------------------------------------- reader
  // Tokens of one record: quoted strings keep their spaces.
  function tokens(line) {
    const out = [], re = /"([^"]*)"|(\S+)/g;
    let m;
    while ((m = re.exec(line))) out.push(m[1] != null ? m[1] : m[2]);
    return out;
  }
  function sections(text) {
    if (typeof text !== "string") throw Error("The IDF file is not text.");
    if (text.length > LIMITS.bytes) throw Error("The IDF file is larger than 32 MB.");
    const lines = text.split(/\r?\n/);
    if (lines.length > LIMITS.lines) throw Error("The IDF file has too many lines.");
    const out = [];
    let cur = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line[0] === "#") continue;
      if (line[0] === ".") {
        const t = tokens(line), tag = t[0].slice(1).toUpperCase();
        if (tag.startsWith("END_")) { cur = null; continue; }
        cur = {tag, args: t.slice(1), rows: []}; out.push(cur); continue;
      }
      if (cur) cur.rows.push(tokens(line));
    }
    return out;
  }
  const num = (v, what) => { const x = +v; if (!Number.isFinite(x)) throw Error("IDF: " + what + " is not a number (" + String(v).slice(0, 20) + ")."); return x; };
  // Point records -> loops by label, arcs flattened (Y up).
  function loops(rows, scale, budget = {points: LIMITS.points * 8}) {
    const by = new Map();
    let count = 0;
    for (const r of rows) {
      if (r.length < 4) continue;
      if (++count > LIMITS.points) throw Error("The IDF file has more than " + LIMITS.points + " outline points.");
      const label = r[0], p = [num(r[1], "x") * scale, num(r[2], "y") * scale], ang = num(r[3], "angle");
      let l = by.get(label);
      if (!l) by.set(label, l = []);
      l.push({p, ang});
    }
    const out = [];
    function project(c, r, start, sweep, min, max) {
      const points = M().projectArc(c, r, start, sweep, min, max);
      if ((budget.points -= points.length - 1) < 0) throw Error("The IDF file's arcs expand to more than " + LIMITS.points * 8 + " outline points.");
      return points.slice(1, -1);
    }
    for (const [label, recs] of by) {
      if (recs.length === 2 && Math.abs(Math.abs(recs[1].ang) - 360) < 1e-6) {
        const c = recs[0].p, end = recs[1].p, r = Math.hypot(end[0] - c[0], end[1] - c[1]);
        const pts = r ? [[c[0] + r, c[1]], ...project(c, r, 0, 360, 64, 64)] : [c];
        out.push({label, pts, circle: {c, d: 2 * r}}); continue;
      }
      const pts = [recs[0].p];
      for (let i = 1; i < recs.length; i++) {
        const a = recs[i - 1].p, b = recs[i].p, th = recs[i].ang;
        const ch = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (Math.abs(th) > 1e-9 && ch) {
          const t = th * Math.PI / 180, r = ch / (2 * Math.sin(Math.abs(t) / 2));
          const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, h = Math.sqrt(Math.max(0, r * r - ch * ch / 4)) * (Math.abs(t) > Math.PI ? -1 : 1) * Math.sign(t);
          const ux = -(b[1] - a[1]) / ch, uy = (b[0] - a[0]) / ch, c = [mx + ux * h, my + uy * h];
          const start = Math.atan2(a[1] - c[1], a[0] - c[0]) * 180 / Math.PI;
          if (Number.isFinite(r)) pts.push(...project(c, Math.abs(r), start + (r < 0 ? 180 : 0), th, 2, 1024));
        }
        pts.push(b);
      }
      if (pts.length > 2 && Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]) < 1e-6) pts.pop();
      out.push({label, pts});
    }
    return out;
  }
  const down = P => P.map(p => [p[0], -p[1]]);
  function read(emn, emp, trace) {
    const S = sections(emn), head = S.find(s => s.tag === "HEADER");
    if (!head || !/^BOARD_FILE$/i.test(head.rows[0]?.[0] || "")) throw Error("This is not an IDF board (.emn) file.");
    const units = (head.rows[1]?.[1] || "MM").toUpperCase(), scale = units === "THOU" || units === "MIL" ? 0.0254 : units === "TNM" ? 1e-5 : 1;
    const design = {source: "idf", kind: "baseline", full: true, parts: [], holes: [], keepouts: [], removed: [], responses: [], notes: [],
      board: null, header: {system: head.rows[0]?.[2] || "", creator: "", transaction: head.rows[1]?.[0] || ""}};
    if (head.rows[0]?.[1] && !/^3/.test(head.rows[0][1])) design.notes.push("IDF version " + head.rows[0][1] + " was read as IDF 3.0.");
    const heights = new Map(), budget = {points: LIMITS.points * 8};
    if (emp) for (const s of sections(emp)) if (s.tag === "ELECTRICAL" || s.tag === "MECHANICAL") {
      const h = s.rows[0];
      if (h?.length >= 4) heights.set(h[0] + "|" + h[1], num(h[3], "height") * (/THOU|MIL/i.test(h[2]) ? 0.0254 : 1));
      if (s.rows.length > 1) trace?.omitted("IDF package contour", s.tag + "/" + h[0] + "/" + h[1], "The change reviewer reads package height only.", "library");
    }
    for (const s of S) {
      if (s.tag === "BOARD_OUTLINE") {
        const th = num(s.rows[0]?.[0], "board thickness") * scale, L = loops(s.rows.slice(1), scale, budget);
        const outer = L.find(l => l.label === "0") || L[0];
        if (!outer || outer.pts.length < 3) { trace?.omitted("Mechanical board profile", s.tag, "No closed outline could be read."); design.notes.push("The IDF board outline has no closed loop."); continue; }
        design.board = {ident: null, outline: down(outer.pts), cutouts: L.filter(l => l !== outer && l.pts.length >= 3).map(l => down(l.pts)), thickness: th};
        if (trace && s.rows.slice(1).some(r => Math.abs(Number(r[3])) > 1e-9))
          trace.approximate(design.board, "Curved edges were sampled into the proposal outline.");
      } else if (s.tag === "DRILLED_HOLES") {
        for (let i = 0; i < s.rows.length; i++) {
          const r = s.rows[i];
          if (r.length < 6) { trace?.omitted("Drilled hole", s.tag + "/" + (i + 1), "The hole record is incomplete."); continue; }
          const assoc = r[4], type = (r[5] || "").toUpperCase();
          if (type === "VIA" || (type === "PIN" && !/^(BOARD|NOREFDES|PANEL)$/i.test(assoc))) {
            trace?.omitted("Drilled hole", s.tag + "/" + (i + 1), "Pin and via holes do not become mechanical change proposals."); continue;
          }
          design.holes.push({ident: null, x: num(r[1], "x") * scale, y: -num(r[2], "y") * scale, d: num(r[0], "diameter") * scale, plated: /^PTH$/i.test(r[3])});
        }
      } else if (/^(PLACE_KEEPOUT|ROUTE_KEEPOUT|VIA_KEEPOUT|PLACE_REGION)$/.test(s.tag)) {
        const kind = s.tag === "ROUTE_KEEPOUT" ? "route" : s.tag === "VIA_KEEPOUT" ? "via" : s.tag === "PLACE_REGION" ? "keepin" : "component";
        const first = s.rows[0] || [], hasLayer = s.tag !== "VIA_KEEPOUT" && first.length && first.length < 4 && !/^-?\d/.test(first[0]);
        const layerRow = hasLayer ? first : null;
        const height = s.tag === "PLACE_KEEPOUT" && layerRow?.[1] != null ? num(layerRow[1], "height") * scale : s.tag === "PLACE_REGION" && layerRow?.[2] != null ? num(layerRow[2], "height") * scale : null;
        const side = layerRow?.[0]?.toUpperCase();
        const L = loops(s.rows.slice(hasLayer ? 1 : 0), scale, budget);
        const curved = trace && new Set(s.rows.filter(r => Math.abs(Number(r[3])) > 1e-9).map(r => r[0]));
        for (const l of L) if (l.pts.length >= 3) {
          const item = {ident:null, kind, points:down(l.pts), z0:0, z1:height && height > 0 ? height : null,
            layer:kind === "route" && (side === "TOP" || side === "BOTTOM") ? (side === "TOP" ? "Top" : "Bottom") : null};
          design.keepouts.push(item);
          if (curved?.has(l.label)) trace.approximate(item, "The keep-out's curved edges were sampled into a polygon.");
        }
      } else if (s.tag === "PLACEMENT") {
        // Each component is a name record followed by a placement record (x y z rotation side ...).
        // A line that does not start such a pair is skipped alone, so it cannot shift the pairing.
        let stray = 0;
        for (let i = 0; i < s.rows.length; i++) {
          const a = s.rows[i], b = s.rows[i + 1];
          if (a.length < 3 || !(b?.length >= 5)) { stray++; trace?.omitted("Component placement", s.tag + "/" + (i + 1), "The placement record is incomplete."); continue; }
          i++;
          design.parts.push({ident: null, ref: a[2], x: num(b[0], "x") * scale, y: -num(b[1], "y") * scale, angle: M().norm(-num(b[3], "rotation")),
            side: /^BOTTOM$/i.test(b[4]) ? "Bottom" : "Top", height: heights.get(a[0] + "|" + a[1]) ?? null});
        }
        if (stray) design.notes.push(stray + " incomplete .PLACEMENT line(s) were skipped.");
      } else if (s.tag !== "HEADER") trace?.omitted("IDF section", s.tag, "This section has no mechanical change proposal.");
    }
    // Footprint holes of placed parts are part of the footprint, not proposals: only free holes compare.
    return design;
  }
  return Object.freeze({LIMITS, write, read});
})();
