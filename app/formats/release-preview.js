"use strict";

// Card thumbnails for the Release page (release-ui.js): each shows the real output, not an icon.
//   gerberSVG(text, {outline})  -> SVG markup of one Gerber layer (DOM-free; numbers and fixed tags only)
//   csvRows(text, max)          -> [[cells]] of a CSV file (DOM-free)
//   storedZip(bytes)            -> [{name, data}] of a store-only ZIP (AtriumZip writes those)
//   thumb(kind, files, row, env) -> an element for the card: a Gerber render, a BOM table snippet,
//                                  a placement plot, the assembly drawing, the first PDF page, a count
// env: {project, out (the output definition), date}. Never throws: a thumbnail that cannot be drawn
// becomes a short text.
globalThis.AtriumReleasePreview = (() => {
  const str = v => typeof v === "string";
  const text = d => str(d) ? d : d instanceof Uint8Array ? new TextDecoder().decode(d) : String(d ?? "");
  const num = v => Math.round(v * 1000) / 1000;

  // ---------------------------------------------------------------- Gerber
  // Enough RS-274X for a thumbnail: FS/MO, C/R/O apertures and macros with primitives 1, 4, 20 and
  // 21 (no variables), D01/D02/D03, G01/G02/G03 (multi-quadrant), G36/G37 regions and LP polarity.
  const MAX_OPS = 120000;
  function gerberSVG(source, opts = {}) {
    const src = text(source);
    if (!/%FS[LT][AI]X(\d)(\d)Y(\d)(\d)\*%/.test(src)) return "";
    const layers = [parse(src)];
    if (opts.outline) { const o = parse(text(opts.outline)); if (o) { o.outline = true; layers.push(o); } }
    if (!layers[0]) return "";
    let box = null;
    for (const l of layers) if (l.box) box = box ? [Math.min(box[0], l.box[0]), Math.min(box[1], l.box[1]), Math.max(box[2], l.box[2]), Math.max(box[3], l.box[3])] : l.box.slice();
    if (!box) return "";
    const pad = Math.max(box[2] - box[0], box[3] - box[1]) * .03 || 1, w = box[2] - box[0] + 2 * pad, h = box[3] - box[1] + 2 * pad;
    const body = layers.map(l => l.outline ? "<g class=\"rp-outline\" fill=\"none\" stroke=\"currentColor\" stroke-linecap=\"round\">" + l.svg.replace(/fill="currentColor"/g, "fill=\"none\"") + "</g>"
      : "<g class=\"rp-copper\" fill=\"currentColor\" stroke=\"currentColor\" stroke-linecap=\"round\" stroke-linejoin=\"round\">" + l.svg + "</g>").join("");
    return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"" + [num(box[0] - pad), num(-box[3] - pad), num(w), num(h)].join(" ") + "\" preserveAspectRatio=\"xMidYMid meet\">" +
      "<g transform=\"scale(1,-1)\">" + body + "</g></svg>";
  }
  function parse(src) {
    const fs = src.match(/%FS[LT][AI]X(\d)(\d)Y(\d)(\d)\*%/);
    if (!fs) return null;
    const dx = 10 ** +fs[2], dy = 10 ** +fs[4], aps = new Map(), macros = new Map(), out = [];
    for (const m of src.matchAll(/%AM([A-Za-z_.$][\w.$]*)\*([\s\S]*?)%/g)) macros.set(m[1], m[2].split("*").map(s => s.trim()).filter(s => s && !s.startsWith("0 ")).map(s => s.split(",").map(Number)));
    for (const m of src.matchAll(/%ADD(\d+)([A-Za-z_.$][\w.$]*)(?:,([^*]*))?\*%/g)) aps.set(+m[1], {type: m[2], p: (m[3] || "").split("X").map(Number)});
    let x = 0, y = 0, ap = null, mode = 1, region = false, dark = true, ops = 0, box = null, path = "";
    const grow = (px, py, r = 0) => { box = box ? [Math.min(box[0], px - r), Math.min(box[1], py - r), Math.max(box[2], px + r), Math.max(box[3], py + r)] : [px - r, py - r, px + r, py + r]; };
    const fill = () => dark ? "currentColor" : "none\" class=\"rp-c";
    const strokes = new Map(); // width -> path data of draws, so one element draws them all
    const flushRegion = () => { if (path) { out.push("<path fill=\"" + fill() + "\" stroke=\"none\" d=\"" + path + "Z\"/>"); path = ""; } };
    function flash(px, py) {
      const a = aps.get(ap);
      if (!a) return;
      const [p0 = 0, p1 = p0] = a.p;
      if (a.type === "C") { out.push("<circle cx=\"" + num(px) + "\" cy=\"" + num(py) + "\" r=\"" + num(p0 / 2) + "\" fill=\"" + fill() + "\" stroke=\"none\"/>"); grow(px, py, p0 / 2); return; }
      if (a.type === "R" || a.type === "O") {
        out.push("<rect x=\"" + num(px - p0 / 2) + "\" y=\"" + num(py - p1 / 2) + "\" width=\"" + num(p0) + "\" height=\"" + num(p1) + "\"" + (a.type === "O" ? " rx=\"" + num(Math.min(p0, p1) / 2) + "\"" : "") + " fill=\"" + fill() + "\" stroke=\"none\"/>");
        grow(px, py, Math.max(p0, p1) / 2); return;
      }
      const prims = macros.get(a.type);
      if (!prims) return;
      const parts = [];
      for (const q of prims) {
        if (q.some(v => !Number.isFinite(v))) continue;
        const rot = (deg, u, v) => { const r = deg * Math.PI / 180, c = Math.cos(r), s = Math.sin(r); return [px + u * c - v * s, py + u * s + v * c]; };
        if (q[0] === 1 && q[1] === 1) { const [cx, cy] = rot(q[5] || 0, q[3], q[4]); parts.push("M" + num(cx - q[2] / 2) + " " + num(cy) + "a" + num(q[2] / 2) + " " + num(q[2] / 2) + " 0 1 0 " + num(q[2]) + " 0a" + num(q[2] / 2) + " " + num(q[2] / 2) + " 0 1 0 " + num(-q[2]) + " 0Z"); grow(cx, cy, q[2] / 2); }
        else if (q[0] === 21 && q[1] === 1) { const [, , w, h, cx, cy, deg = 0] = q; const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]].map(([u, v]) => rot(deg, cx + u, cy + v)); parts.push("M" + pts.map(p => num(p[0]) + " " + num(p[1])).join("L") + "Z"); pts.forEach(p => grow(p[0], p[1])); }
        else if (q[0] === 20 && q[1] === 1) { const [, , w, sx, sy, ex, ey, deg = 0] = q, a1 = rot(deg, sx, sy), a2 = rot(deg, ex, ey), l = Math.hypot(a2[0] - a1[0], a2[1] - a1[1]) || 1, nx = -(a2[1] - a1[1]) / l * w / 2, ny = (a2[0] - a1[0]) / l * w / 2;
          parts.push("M" + [[a1[0] + nx, a1[1] + ny], [a2[0] + nx, a2[1] + ny], [a2[0] - nx, a2[1] - ny], [a1[0] - nx, a1[1] - ny]].map(p => num(p[0]) + " " + num(p[1])).join("L") + "Z"); grow(a1[0], a1[1], w / 2); grow(a2[0], a2[1], w / 2); }
        else if (q[0] === 4 && q[1] === 1) { const n = q[2], deg = q[3 + 2 * (n + 1)] || 0, pts = []; for (let i = 0; i <= n; i++) pts.push(rot(deg, q[3 + 2 * i], q[4 + 2 * i])); parts.push("M" + pts.map(p => num(p[0]) + " " + num(p[1])).join("L") + "Z"); pts.forEach(p => grow(p[0], p[1])); }
      }
      if (parts.length) out.push("<path fill=\"" + fill() + "\" stroke=\"none\" d=\"" + parts.join("") + "\"/>");
    }
    // Extended commands pair up from the start of the file; keep only the polarity ones.
    const body = src.replace(/%([^%]*)%/g, (m, inner) => /^LP[DC]\*$/.test(inner) ? m : "").replace(/G04[^*]*\*/g, "");
    for (const m of body.matchAll(/%LP([DC])\*%|G0?([123])\*?|G(36|37)\*|D(\d+)\*|((?:X[+-]?\d+)?(?:Y[+-]?\d+)?(?:I[+-]?\d+)?(?:J[+-]?\d+)?)(?:D0?([123]))?\*/g)) {
      if (++ops > MAX_OPS) return null;
      if (m[1]) { flushRegion(); dark = m[1] === "D"; continue; }
      if (m[3]) { if (m[3] === "36") { region = true; path = ""; } else { flushRegion(); region = false; } continue; }
      if (m[2] && !m[5] && !m[6]) { mode = +m[2]; continue; }
      if (m[4] && +m[4] >= 10) { ap = +m[4]; continue; }
      const c = m[5] || "";
      if (m[2]) mode = +m[2];
      const g = k => { const t = c.match(new RegExp(k + "([+-]?\\d+)")); return t ? +t[1] : null; };
      const nx = g("X") != null ? g("X") / dx : x, ny = g("Y") != null ? g("Y") / dy : y, i = (g("I") || 0) / dx, j = (g("J") || 0) / dy;
      const d = m[6] ? +m[6] : null;
      if (!c && d == null) continue;
      if (d === 2 || (d == null && !c)) { if (region && path) path += "Z"; if (region) path += "M" + num(nx) + " " + num(ny); x = nx; y = ny; continue; }
      if (d === 3) { flash(nx, ny); x = nx; y = ny; continue; }
      if (d === 1 || (d == null && c)) {
        let seg;
        if (mode === 1) seg = "L" + num(nx) + " " + num(ny);
        else {
          const cx = x + i, cy = y + j, r = Math.hypot(i, j) || 1e-9;
          let a0 = Math.atan2(y - cy, x - cx), a1 = Math.atan2(ny - cy, nx - cx), sweep = mode === 3 ? 1 : 0;
          let span = sweep ? a1 - a0 : a0 - a1;
          while (span <= 1e-9) span += 2 * Math.PI;
          if (Math.abs(nx - x) < 1e-9 && Math.abs(ny - y) < 1e-9) seg = "A" + num(r) + " " + num(r) + " 0 1 " + sweep + " " + num(2 * cx - x) + " " + num(2 * cy - y) + "A" + num(r) + " " + num(r) + " 0 1 " + sweep + " " + num(nx) + " " + num(ny);
          else seg = "A" + num(r) + " " + num(r) + " 0 " + (span > Math.PI ? 1 : 0) + " " + sweep + " " + num(nx) + " " + num(ny);
          grow(cx, cy, r);
        }
        if (region) path += (path ? "" : "M" + num(x) + " " + num(y)) + seg;
        else {
          const a = aps.get(ap), wd = a ? (a.type === "C" ? a.p[0] : Math.min(a.p[0], a.p[1] ?? a.p[0])) : 0.1, k = num(wd) + (dark ? "" : "c");
          strokes.set(k, (strokes.get(k) || "") + "M" + num(x) + " " + num(y) + seg);
          grow(x, y, wd / 2); grow(nx, ny, wd / 2);
        }
        if (region) grow(nx, ny);
        x = nx; y = ny;
      }
    }
    flushRegion();
    for (const [k, dd] of strokes) out.push("<path fill=\"none\" " + (k.endsWith("c") ? "class=\"rp-cs\"" : "stroke=\"currentColor\"") + " stroke-width=\"" + parseFloat(k) + "\" d=\"" + dd + "\"/>");
    return {svg: out.join(""), box};
  }

  // ---------------------------------------------------------------- CSV and ZIP
  function csvRows(source, max = 8) {
    const s = text(source).replace(/^﻿/, ""), rows = [];
    let row = [], cell = "", q = false;
    for (let i = 0; i < s.length && rows.length < max; i++) {
      const ch = s[i];
      if (q) { if (ch === "\"") { if (s[i + 1] === "\"") { cell += "\""; i++; } else q = false; } else cell += ch; continue; }
      if (ch === "\"") q = true;
      else if (ch === ",") { row.push(cell); cell = ""; }
      else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
      else cell += ch;
    }
    if ((cell || row.length) && rows.length < max) { row.push(cell); rows.push(row); }
    return rows;
  }
  // Stored entries only. ZIP limits as AtriumSexpr.unzip (sexpr.js): at most 10000 entries and
  // 512 MB in all, each inside the file; a damaged or oversized archive previews nothing more.
  function storedZip(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(0), v = new DataView(b.buffer, b.byteOffset, b.byteLength), out = [], floor = Math.max(0, b.length - 65557);
    let end = b.length - 22, total = 0;
    while (end >= floor && v.getUint32(end, true) !== 0x06054b50) end--;
    if (end < floor || v.getUint16(end + 10, true) > 10000) return out;
    let cd = v.getUint32(end + 16, true);
    for (let i = 0, n = v.getUint16(end + 10, true); i < n && cd + 46 <= b.length; i++) {
      const method = v.getUint16(cd + 10, true), size = v.getUint32(cd + 20, true), nl = v.getUint16(cd + 28, true), local = v.getUint32(cd + 42, true);
      if (local + 30 > b.length) break;
      const name = new TextDecoder().decode(b.subarray(cd + 46, cd + 46 + nl)), start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      if (method === 0 && (start + size > b.length || (total += size) > 512 * 1024 * 1024)) break;
      if (method === 0) out.push({name, data: b.subarray(start, start + size)});
      cd += 46 + nl + v.getUint16(cd + 30, true) + v.getUint16(cd + 32, true);
    }
    return out;
  }

  // ---------------------------------------------------------------- thumbnails (DOM)
  function el(tag, txt, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, txt, cls, attrs); }
  const svgNode = (markup, cls, label) => {
    const box = el("div", null, "rp-svg " + (cls || ""), {role: "img", "aria-label": label});
    // The markup is built above from numbers and fixed tags only (gerberSVG / plot): no design text.
    box.innerHTML = markup;
    return box;
  };
  const urls = new Set();
  function imgOf(markup, label, cls) {
    const url = URL.createObjectURL(new Blob([markup], {type: "image/svg+xml"}));
    urls.add(url);
    const img = el("img", null, cls || "rp-img", {alt: label, src: url, decoding: "async"});
    return img;
  }
  function revokeAll() { for (const u of urls) URL.revokeObjectURL(u); urls.clear(); }
  const note = t => el("div", t, "rp-note");
  function expand(files) {
    const out = [];
    for (const f of files || []) { if (/\.zip$/i.test(f.name) && f.data instanceof Uint8Array) out.push(...storedZip(f.data)); else out.push(f); }
    return out;
  }
  function table(rows, label) {
    const width = Math.max(...rows.map(r => r.length)), body = rows.filter(r => r.length === width && r.some(Boolean));
    if (body.length < 2) return note("No rows.");
    const t = el("table", null, "rp-table", {"aria-label": label}), head = el("thead"), tb = el("tbody"), cols = Math.min(width, 4);
    const tr = el("tr"); body[0].slice(0, cols).forEach(c => tr.append(el("th", c))); head.append(tr);
    for (const r of body.slice(1, 6)) { const x = el("tr"); r.slice(0, cols).forEach(c => x.append(el("td", c))); tb.append(x); }
    t.append(head, tb);
    return t;
  }
  function plot(rows) {
    const width = Math.max(...rows.map(r => r.length)), body = rows.filter(r => r.length === width);
    const head = body[0] || [], xi = head.findIndex(h => /^(mid ?x|center-?x|pos ?x|x)/i.test(h.trim())), yi = head.findIndex(h => /^(mid ?y|center-?y|pos ?y|y)/i.test(h.trim())), li = head.findIndex(h => /layer|side/i.test(h));
    if (xi < 0 || yi < 0) return null;
    const pts = body.slice(1).map(r => [parseFloat(r[xi]), parseFloat(r[yi]), /bot/i.test(r[li] || "")]).filter(p => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (!pts.length) return null;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const s = Math.max(x1 - x0, y1 - y0, 1), pad = s * .08, r = s * .018;
    return "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"" + [num(x0 - pad), num(-y1 - pad), num(x1 - x0 + 2 * pad), num(y1 - y0 + 2 * pad)].join(" ") + "\">" +
      pts.map(p => "<circle class=\"" + (p[2] ? "rp-bot" : "rp-top") + "\" cx=\"" + num(p[0]) + "\" cy=\"" + num(-p[1]) + "\" r=\"" + num(r) + "\"/>").join("") + "</svg>";
  }
  function stat(n, label, tone) {
    const box = el("div", null, "rp-stat" + (tone ? " is-" + tone : ""));
    box.append(el("strong", n), el("span", label));
    return box;
  }
  function snippet(files) {
    const f = files.find(x => /\.(txt|xml|csv|kicad_pcb|json|md)$/i.test(x.name) || x.name === "SHA256SUMS") || files[0];
    if (!f) return note("No file.");
    let t = text(f.data);
    if (/\.html?$/i.test(f.name)) t = t.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
    return el("pre", t.split(/\r?\n/).slice(0, 9).map(l => l.slice(0, 90)).join("\n"), "rp-text");
  }
  // The first page of a PDF output, drawn again through the print/drawing modules' page lists.
  function pdfPage(kind, env) {
    const P = globalThis.AtriumPDF;
    if (!P?.svg) return null;
    try {
      let page = null;
      if (kind === "drawing" && globalThis.AtriumDrawing) {
        const d = env.project.documents.find(x => x.kind === "drawing");
        if (d) page = AtriumDrawing.build(env.project, {documents: [d.id]}).pages[0];
      } else if (kind === "pdf" && globalThis.AtriumPrint) {
        const d = env.project.documents.find(x => x.kind === "schematic") || env.project.documents.find(x => x.kind === "pcb");
        if (d) page = AtriumPrint.build(env.project, {...(env.out?.options || {}), documents: [d.id], title: env.project.name}).pages[0];
      }
      return page ? P.svg(page.w, page.h, page.list) : null;
    } catch { return null; }
  }
  function thumb(kind, files, row, env = {}) {
    try {
      if (!row) return note("Not generated yet.");
      if (row.status === "skipped") return note(row.message || "Skipped.");
      if (row.status === "error") return note(row.message || "Failed.");
      const all = expand(files);
      if (kind === "gerber") {
        const top = all.find(f => /\.GTL$/i.test(f.name)) || all.find(f => /\.G[TB][LO]$/i.test(f.name)) || all.find(f => /\.G[A-Z0-9]+$/i.test(f.name) && !/\.GD1$/i.test(f.name));
        const edge = all.find(f => /\.(GM1|GKO)$/i.test(f.name));
        const svg = top ? gerberSVG(top.data, {outline: edge?.data}) : "";
        return svg ? svgNode(svg, "rp-gerber", "Top copper, rendered from " + top.name) : note(row.summary || "No layer to draw.");
      }
      if (kind === "bom" || kind === "bomcost") {
        const f = all.find(x => /\.csv$/i.test(x.name));
        if (f) return table(csvRows(f.data, 40), "First BOM lines");
        if (kind === "bom" && globalThis.AtriumBOM && env.project) {
          const r = AtriumBOM.report(env.project, env.out?.options?.view ? {view: env.out.options.view} : {});
          return table([r.columns.map(c => c.label), ...r.rows.map(x => x.map(String))], "First BOM lines");
        }
        return snippet(all);
      }
      if (kind === "pnp") {
        const f = all.find(x => /\.csv$/i.test(x.name)), svg = f && plot(csvRows(f.data, 5000));
        return svg ? svgNode(svg, "rp-plot", "Placements: top dots filled, bottom outlined") : snippet(all);
      }
      if (kind === "assembly") {
        const f = all.find(x => /\.svg$/i.test(x.name));
        return f ? imgOf(text(f.data), "Assembly drawing " + f.name, "rp-img rp-paper") : snippet(all);
      }
      if (kind === "pdf" || kind === "drawing") {
        const svg = pdfPage(kind, env);
        if (svg) return imgOf(svg, "First page", "rp-img rp-paper");
        return stat((row.summary.match(/^(\d+)/) || [, String(all.length)])[1], kind === "drawing" ? "pages" : "PDF files");
      }
      if (kind === "drc" || kind === "erc") {
        const n = (row.summary.match(/^(\d+)/) || [, "?"])[1];
        return stat(n, kind === "drc" ? "violations" : row.summary.replace(/^\d+\s*/, "").split(",")[0], row.status === "failed" ? "bad" : n === "0" ? "ok" : "warn");
      }
      if (kind === "step") return stat((row.summary.match(/(\d+) components/) || [, "0"])[1], "components in " + (row.summary.split(",")[0] || "3D"));
      return snippet(all);
    } catch (e) { return note("Preview unavailable: " + e.message); }
  }

  return Object.freeze({gerberSVG, csvRows, storedZip, thumb, revokeAll});
})();
