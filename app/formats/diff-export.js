"use strict";
// AtriumDiffExport: the comparison as a review report (diff-view.js › Export…). Lazy.
//
//   AtriumDiffExport.pdf(session, host)   -> file name; vector PDF through AtriumPDF (pdf.js) and the
//        recording context of print.js. Every page has a header (project, date, both revisions).
//        Page 1: summary, legend, documents, DRC delta, routing table. Then per document an overview
//        with numbered markers, the numbered change list, and before/after thumbnails of each object
//        change (highlight 2.5 pt with a 15 % fill and the status glyph) with its changed properties.
//   AtriumDiffExport.print(session, host) -> job name; the same pages, printed (system print panel).
//   AtriumDiffExport.html(session, host)  -> file name; one self-contained HTML page with the same
//        content and PNG thumbnails. Every design-derived string is escaped.
//   AtriumDiffExport.lines(session)       -> the report's text rows (pure; tests).
globalThis.AtriumDiffExport = (() => {
  const G = globalThis;
  const W = 842, H = 595, MARGIN = 36, TOP = 58;      // A4 landscape, points; TOP leaves room for the header
  const LIMIT = 48;                                   // changes with thumbnails
  // i18n (docs/translating.md): the report's text in the reader's language ("diff.report.*").
  // Headless tests run without i18n.js: the stand-in formats the English table itself.
  // "\u0029" is ")": scripts/i18n-extract.py reads the table up to the first "})".
  const AtriumI18n = G.AtriumI18n || {define: o => (k, a) => o[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  const T = AtriumI18n.define({
    "diff.report.title": "Design comparison",
    "diff.report.doc_title": "Design comparison · {range}",
    "diff.report.header": "{project} · design comparison · {range}",
    "diff.report.page": "{date} · page {page}",
    "diff.report.board": "Board",
    "diff.report.sheet": "Sheet",
    "diff.report.added": "Added",
    "diff.report.removed": "Removed",
    "diff.report.moved": "Moved",
    "diff.report.modified": "Modified",
    "diff.report.properties": "Properties",
    "diff.report.moved_ghost": "Moved (dashed ghost at the old place)",
    "diff.report.electrical": "Electrical",
    "diff.report.layout": "Layout",
    "diff.report.cosmetic": "Cosmetic",
    "diff.report.legend": "Legend",
    "diff.report.legend_colon": "Legend:",
    "diff.report.legend_note": "Ghost = old place (dashed) · Electrical changes lead each list",
    "diff.report.warning": "Warning: {text}",
    "diff.report.documents": "Documents",
    "diff.report.doc_counts": "{total} changes: {electrical} electrical · {layout} layout · {cosmetic} cosmetic",
    "diff.report.drc": "DRC delta: {added} new · {fixed} fixed",
    "diff.report.drc_counts": "{added} new · {fixed} fixed",
    "diff.report.skipped": "(skipped: {boards}\u0029",
    "diff.report.new_row": "New · {doc} · {title}",
    "diff.report.fixed_row": "Fixed · {doc} · {title}",
    "diff.report.new": "New",
    "diff.report.fixed": "Fixed",
    "diff.report.drc_delta": "DRC delta",
    "diff.report.routing": "Routing delta per net",
    "diff.report.net": "Net",
    "diff.report.before_mm": "Before (mm)",
    "diff.report.after_mm": "After (mm)",
    "diff.report.delta_mm": "Δ (mm)",
    "diff.report.length_before": "Length before (mm)",
    "diff.report.after_col": "After",
    "diff.report.vias": "Vias",
    "diff.report.overview": "{doc} · overview ({count} changes)",
    "diff.report.doc_changes": "{doc} · changes",
    "diff.report.pairs": "Before and after · changes {first}–{last} of {total}",
    "diff.report.pairs_first": "object changes (first {count}\u0029",
    "diff.report.not_in_revision": "Not in this revision",
    "diff.report.not_in": "Not in {rev}",
    "diff.report.before": "Before · {rev}",
    "diff.report.after": "After · {rev}",
    "diff.report.changes": "Changes",
    "diff.report.document": "Document",
    "diff.report.kind": "Kind",
    "diff.report.side": "Side",
    "diff.report.severity": "Severity",
    "diff.report.change": "Change",
    "diff.report.layer": "Layer",
    "diff.report.before_after": "Before and after",
    "diff.report.footer": "Waffle design comparison · {date}"
  });
  // Status names in the current language (getters, so a report written after a language switch follows it).
  const STATUS = {get added() { return T("diff.report.added"); }, get removed() { return T("diff.report.removed"); }, get moved() { return T("diff.report.moved"); },
    get modified() { return T("diff.report.modified"); }, get properties() { return T("diff.report.properties"); }};
  const SEVERITY = {electrical: () => T("diff.report.electrical"), layout: () => T("diff.report.layout"), cosmetic: () => T("diff.report.cosmetic")};
  const GLYPH = {added: "+", removed: "−", moved: "→", modified: "~", properties: "i"};
  const fixed = {added: "#2f9e5b", removed: "#d0453f", moved: "#c48a12", modified: "#c48a12", properties: "#2f7fc0"};
  const AREA = new Set(["routing", "document", "drc", "board", "rules", "project", "library", "order", "comments"]);
  const safeName = s => String(s || "Waffle").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim().slice(0, 80);
  const fmt = v => (Math.round(v * 100) / 100).toFixed(2);
  // "Removed C2 from …" under a "Removed" tag reads twice: drop the tag word from the sentence's start.
  const caption = c => { const t = c.sentence || c.name, w = STATUS[c.status]; return t.toLowerCase().startsWith(w.toLowerCase() + " ") ? t : w + " · " + t; };
  const changedFields = c => (c.fields || []).filter(f => !f.hidden && (f.changed || c.status === "added" || c.status === "removed")).slice(0, 4);

  function lines(S) {
    const m = S.model, list = m.ordered(m.changes, "document"), sum = m.summary();
    const out = {title: T("diff.report.title"), range: m.from + " → " + m.to, summary: sum.text, docs: [], rows: [], routing: [], drc: null, warnings: m.warnings || []};
    for (const d of m.docs) { const c = m.docCounts().get(d.id); out.docs.push([d.name, d.kind === "pcb" ? T("diff.report.board") : d.kind === "schematic" ? T("diff.report.sheet") : d.kind, d.side, c?.total || 0, c?.electrical || 0, c?.layout || 0, c?.cosmetic || 0]); }
    list.forEach((c, i) => out.rows.push([c.severity, STATUS[c.status] || c.status, c.sentence || c.name, c.docName || "", c.layer || "", i + 1]));
    for (const r of m.routing || []) out.routing.push([r.net, r.docName, fmt(r.lengthBefore), fmt(r.lengthAfter), (r.lengthAfter - r.lengthBefore >= 0 ? "+" : "") + fmt(r.lengthAfter - r.lengthBefore), r.viasBefore + " → " + r.viasAfter]);
    if (m.drc && typeof m.drc === "object") out.drc = {added: m.drc.added.map(v => [v.docName, v.title]), fixed: m.drc.fixed.map(v => [v.docName, v.title]), skipped: m.drc.skipped};
    return out;
  }
  function palette(doc) {
    const V = G.AtriumDiffView, bg = doc.kind === "pcb" ? [30, 30, 30] : [250, 250, 245];
    return V?.paletteFor ? V.paletteFor(bg, doc.kind) : {...fixed, halo: "rgba(0,0,0,.6)", inner: "#ffffff"};
  }
  // World-space highlight of one change for an exported thumbnail: 2.5 pt outline over a halo, a 15 %
  // fill, the same dash cues as the screen and the status glyph in a badge. (The recording context has
  // no compositing, so shapes are stroked plainly.)
  function overlay(c, geo, side, pal, pt) {
    return (ctx, {scale}) => {
      const px = 1 / scale, u = pt * px, col = pal[c.status] || fixed[c.status];
      const s = side === "before" ? geo.before : geo.after || (c.status === "removed" ? null : geo.before);
      if (!s) return;
      ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round";
      const dash = c.status === "removed" ? [6 * u, 4 * u] : c.status === "properties" ? [1.5 * u, 3 * u] : side === "before" && c.status !== "added" ? [4 * u, 3 * u] : [];
      const g = 3 * u, trace = () => {
        ctx.beginPath();
        if (s.path) { ctx.moveTo(s.path[0][0], s.path[0][1]); for (let k = 1; k < s.path.length; k++) ctx.lineTo(s.path[k][0], s.path[k][1]); if (s.closed) ctx.closePath(); }
        else { const b = s.box; if (s.round) ctx.arc((b[0] + b[2]) / 2, (b[1] + b[3]) / 2, Math.max(b[2] - b[0], b[3] - b[1]) / 2 + g, 0, Math.PI * 2); else ctx.rect(b[0] - g, b[1] - g, b[2] - b[0] + 2 * g, b[3] - b[1] + 2 * g); }
      };
      const open = s.path && !s.closed, w = open ? Math.max(s.width + 6 * u, 2.5 * u) : 2.5 * u;
      trace();
      if (!open) { ctx.globalAlpha = .15; ctx.fillStyle = col; ctx.fill(); ctx.globalAlpha = 1; }
      ctx.setLineDash([]); ctx.strokeStyle = pal.halo || "rgba(0,0,0,.6)"; ctx.lineWidth = w + 2 * u; ctx.stroke();
      trace(); ctx.setLineDash(dash); ctx.strokeStyle = col; ctx.lineWidth = w; ctx.globalAlpha = open ? .6 : 1; ctx.stroke();
      ctx.globalAlpha = 1; ctx.setLineDash([]);
      // Badge with the glyph at the top-right corner.
      const b = s.box, x = b[2] + 4 * u, y = b[1] - 4 * u, r = 6 * u;
      ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 1.2 * u; ctx.strokeStyle = pal.halo || "#000"; ctx.stroke();
      ctx.fillStyle = "#ffffff"; ctx.font = "bold " + (8 * u) + "px Helvetica"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(GLYPH[c.status] || "", x, y + .4 * u);
      ctx.restore();
    };
  }
  function cameraBox(geo, min = 4) {
    const b = geo.span || geo.box, cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2;
    const hw = Math.max((b[2] - b[0]) / 2 * 1.8 + 1, min), hh = Math.max((b[3] - b[1]) / 2 * 1.8 + 1, min);
    return [cx - hw, cy - hh, cx + hw, cy + hh];
  }
  function optsFor(doc) {
    return doc.kind === "pcb" ? {grid: false, origin: false, hidden: new Set(), layer: "Top", layerMode: "all", showUnrouted: false, selectedIds: new Set()}
      : {grid: false, hidden: new Set(), selectedIds: new Set()};
  }

  // ------------------------------------------------------------------ PDF
  // The report's pages: {pages: [{w, h, list}], name, bytes()} for Export (pdf) and Print… (print).
  async function build(S, host) {
    if (!G.AtriumPDF?.recorder && G.AtriumLazy) await G.AtriumLazy.need("AtriumPrint");
    const PDF = G.AtriumPDF, m = S.model, L = lines(S), R = 4, dpr = Math.max(1, Math.min(4, G.devicePixelRatio || 1));
    const project = String(host.project()?.name || "Waffle"), date = new Date().toISOString().slice(0, 16).replace("T", " ");
    const doc = PDF.document({title: T("diff.report.doc_title", {range: L.range}), date: new Date()}), pages = [], page0 = doc.page;
    doc.page = (w, h, list) => { pages.push({w, h, list}); return page0(w, h, list); };
    const page = () => PDF.recorder(W, H, {});
    let rec = page(), c = rec.ctx, y = TOP, pageNo = 0;
    const text = (t, x, size = 9, bold = false, colour = "#000", max = W - MARGIN - x) => {
      c.font = (bold ? "bold " : "") + size + "px Helvetica"; c.fillStyle = colour; c.textBaseline = "top"; c.textAlign = "left";
      let s = String(t);
      while (s.length > 4 && c.measureText(s).width > max) s = s.slice(0, -2);
      if (s !== String(t)) s = s.slice(0, -1) + "…";
      c.fillText(s, x, y);
    };
    const header = () => {
      const keep = y; y = MARGIN - 14;
      text(T("diff.report.header", {project, range: L.range}), MARGIN, 8, true, "#333", 600);
      c.font = "8px Helvetica"; c.textAlign = "right"; c.fillStyle = "#555"; c.fillText(T("diff.report.page", {date, page: pageNo + 1}), W - MARGIN, MARGIN - 14);
      c.strokeStyle = "#999"; c.lineWidth = .5; c.beginPath(); c.moveTo(MARGIN, MARGIN); c.lineTo(W - MARGIN, MARGIN); c.stroke();
      y = keep;
    };
    const flush = () => { header(); doc.page(W, H, rec.list); pageNo++; rec = page(); c = rec.ctx; y = TOP; };
    const need = h => { if (y + h > H - MARGIN) flush(); };
    // Legend: colour, line style and glyph for each status.
    const legend = () => {
      need(18);
      let x = MARGIN;
      text(T("diff.report.legend_colon"), x, 8, true); x += 40;
      for (const s of Object.keys(STATUS)) {
        c.strokeStyle = fixed[s]; c.lineWidth = 2.5; c.setLineDash(s === "removed" ? [6, 4] : s === "properties" ? [1.5, 3] : []);
        c.strokeRect(x, y, 16, 9); c.setLineDash([]);
        c.beginPath(); c.arc(x + 20, y + 1, 4, 0, Math.PI * 2); c.fillStyle = fixed[s]; c.fill();
        c.fillStyle = "#fff"; c.font = "bold 6px Helvetica"; c.textAlign = "center"; c.textBaseline = "middle"; c.fillText(GLYPH[s], x + 20, y + 1.3);
        text(STATUS[s], x + 28, 8, false, "#000", 70); x += 90;
      }
      text(T("diff.report.legend_note"), x, 8, false, "#444", W - MARGIN - x);
      y += 18;
    };
    text(L.title, MARGIN, 18, true); y += 26;
    text(L.range, MARGIN, 11); y += 16;
    text(L.summary, MARGIN, 11, true); y += 18;
    for (const w of L.warnings) { need(12); text(T("diff.report.warning", {text: w}), MARGIN, 8.5, false, fixed.moved); y += 12; }
    legend(); y += 4;
    text(T("diff.report.documents"), MARGIN, 10, true); y += 14;
    for (const d of L.docs) { need(12); text(d[0], MARGIN, 9, false, "#000", 250); text(d[1] + (d[2] !== "both" ? " (" + d[2] + ")" : ""), MARGIN + 260, 9, false, "#000", 90); text(T("diff.report.doc_counts", {total: d[3], electrical: d[4], layout: d[5], cosmetic: d[6]}), MARGIN + 360, 9); y += 12; }
    y += 8;
    if (L.drc) {
      need(30); text(T("diff.report.drc", {added: L.drc.added.length, fixed: L.drc.fixed.length}) + (L.drc.skipped.length ? " " + T("diff.report.skipped", {boards: L.drc.skipped.join(", ")}) : ""), MARGIN, 10, true); y += 14;
      for (const [dn, t] of L.drc.added.slice(0, 20)) { need(11); text(T("diff.report.new_row", {doc: dn, title: t}), MARGIN + 8, 8.5, false, fixed.removed); y += 11; }
      for (const [dn, t] of L.drc.fixed.slice(0, 20)) { need(11); text(T("diff.report.fixed_row", {doc: dn, title: t}), MARGIN + 8, 8.5, false, fixed.added); y += 11; }
      y += 6;
    }
    if (L.routing.length) {
      need(30); text(T("diff.report.routing"), MARGIN, 10, true); y += 14;
      const cols = [0, 130, 280, 360, 440, 520], widths = [125, 145, 75, 75, 75, 90];
      [T("diff.report.net"), T("diff.report.board"), T("diff.report.before_mm"), T("diff.report.after_mm"), T("diff.report.delta_mm"), T("diff.report.vias")].forEach((h, i) => text(h, MARGIN + cols[i], 8.5, true, "#000", widths[i]));
      y += 12;
      for (const r of L.routing.slice(0, 40)) { need(11); r.forEach((v, i) => text(v, MARGIN + cols[i], 8.5, false, "#000", widths[i])); y += 11; }
      y += 6;
    }
    flush();
    // Per document: an overview with numbered markers, then its numbered change list.
    const ordered = m.ordered(m.changes, "document"), number = new Map(ordered.map((ch, i) => [ch, i + 1]));
    const render = (d, defs, box, x0, y0, w, h, overlays) => {
      const r2 = PDF.recorder(w * R, h * R, {unit: 1 / (R * dpr)}), v = G.AtriumCanvas.create(r2.canvas);
      const s = Math.min(w / Math.max(1e-3, box[2] - box[0]), h / Math.max(1e-3, box[3] - box[1])) * R;
      v.restoreCamera({cx: (box[0] + box[2]) / 2, cy: (box[1] + box[3]) / 2, scale: s, referenceScale: s, flipped: false});
      const o = optsFor(d); o.overlay = overlays;
      try { v.render(d, defs, o); } catch { /* an empty frame */ }
      for (const op of PDF.shift(r2.list, x0, y0, [x0, y0, x0 + w, y0 + h])) rec.list.push(op);
      c.strokeStyle = "#888"; c.lineWidth = .5; c.strokeRect(x0, y0, w, h);
    };
    for (const d of m.docs) {
      const mine = ordered.filter(ch => ch.doc === d.id);
      if (!mine.length) continue;
      const sides = m.sides(d.id), dd = sides.after || sides.before, defs = sides.after ? m.defs1 : m.defs0;
      let box = null;
      try { box = G.Atrium.docBounds(dd, defs); } catch { box = null; }
      if (dd && box) {
        text(T("diff.report.overview", {doc: d.name, count: mine.length}), MARGIN, 11, true); y += 16;
        const ow = W - 2 * MARGIN, oh = H - y - MARGIN - 6;
        render(dd, defs, box, MARGIN, y, ow, oh, [(ctx, {scale}) => {
          const u = 1 / scale * R;
          for (const ch of mine) {
            if (AREA.has(ch.objectKind)) continue;
            const g = m.geometry(ch), b = g.box; if (!b) continue;
            const x = (b[0] + b[2]) / 2, yy = b[1] - 2 * u, r = 5 * u;
            ctx.beginPath(); ctx.arc(x, yy, r, 0, Math.PI * 2); ctx.fillStyle = fixed[ch.status]; ctx.fill(); ctx.lineWidth = .8 * u; ctx.strokeStyle = "#000"; ctx.stroke();
            ctx.fillStyle = "#fff"; ctx.font = "bold " + (6 * u) + "px Helvetica"; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(String(number.get(ch)), x, yy + .3 * u);
          }
        }]);
        flush();
      }
      text(T("diff.report.doc_changes", {doc: d.name}), MARGIN, 12, true); y += 18;
      let sev = "";
      for (const ch of mine) {
        if (ch.severity !== sev) { need(26); sev = ch.severity; y += 4; text(SEVERITY[sev] ? SEVERITY[sev]() : sev[0].toUpperCase() + sev.slice(1), MARGIN, 10, true, sev === "electrical" ? fixed.removed : "#000"); y += 14; }
        const props = changedFields(ch).filter(f => f.changed && ch.status !== "added" && ch.status !== "removed").slice(0, 2);
        need(11 + props.length * 10);
        text("#" + number.get(ch), MARGIN, 8.5, true, "#333", 26);
        c.fillStyle = fixed[ch.status]; c.fillRect(MARGIN + 28, y + 1.5, 5, 5);
        text(STATUS[ch.status], MARGIN + 38, 8.5, true, "#000", 60); text(ch.sentence || ch.name, MARGIN + 102, 8.5, false, "#000", 560); text(ch.layer || "", MARGIN + 670, 8.5, false, "#444", 100);
        y += 11;
        for (const f of props) { text(f.label + ": " + f.before + " → " + f.after, MARGIN + 102, 7.5, false, "#444", 560); y += 10; }
      }
      flush();
    }
    // Thumbnails of object changes: before | after, with the changed properties under each pair.
    const changes = ordered.filter(x => !AREA.has(x.objectKind) && m.geometry(x).box).slice(0, LIMIT);
    const cellW = (W - 2 * MARGIN - 20) / 2, thumbW = (cellW - 8) / 2, thumbH = 92, rowH = thumbH + 68;
    let k = 0;
    for (const ch of changes) {
      const col = k % 2, row = Math.floor(k / 2) % 3;
      if (k && k % 6 === 0) flush();
      if (k % 6 === 0) { y = TOP - 14; text(T("diff.report.pairs", {first: k + 1, last: Math.min(changes.length, k + 6), total: changes.length}) + (ordered.length > changes.length ? " " + T("diff.report.pairs_first", {count: LIMIT}) : ""), MARGIN, 10, true); y += 14; legend(); }
      const x0 = MARGIN + col * (cellW + 20), y0 = TOP + 26 + row * rowH, geo = m.geometry(ch), sides = m.sides(ch.doc);
      for (const [i, side] of [[0, "before"], [1, "after"]]) {
        const d = sides[side], tx = x0 + i * (thumbW + 8);
        if (!d) { c.strokeStyle = "#999"; c.lineWidth = .5; c.strokeRect(tx, y0, thumbW, thumbH); y = y0 + thumbH / 2 - 4; text(T("diff.report.not_in_revision"), tx + 8, 8, false, "#666", thumbW - 16); continue; }
        render(d, side === "before" ? m.defs0 : m.defs1, cameraBox(geo, d.kind === "pcb" ? 3 : 8), tx, y0, thumbW, thumbH, [overlay(ch, geo, side, palette(d), R)]);
        y = y0 + thumbH + 2; text(side === "before" ? T("diff.report.before", {rev: m.from}) : T("diff.report.after", {rev: m.to}), tx, 7, false, "#555", thumbW);
      }
      y = y0 + thumbH + 12;
      c.fillStyle = fixed[ch.status]; c.fillRect(x0, y + 1.5, 5, 5);
      text("#" + number.get(ch) + " " + caption(ch), x0 + 9, 8.5, true, "#000", cellW - 10); y += 11;
      text([ch.docName, ch.layer, ch.severity].filter(Boolean).join(" · "), x0 + 9, 7.5, false, "#444", cellW - 10); y += 10;
      for (const f of changedFields(ch).slice(0, 3)) {
        const v = ch.status === "added" ? f.after : ch.status === "removed" ? f.before : f.before + " → " + f.after;
        text(f.label + ": " + v, x0 + 9, 7.5, false, "#222", cellW - 10); y += 9.5;
      }
      k++;
    }
    if (k) flush();
    return {pages, name: safeName(project + " compare " + m.from.split(" · ")[0] + " to " + m.to.split(" · ")[0]) + ".pdf", bytes: () => doc.bytes()};
  }
  async function pdf(S, host) {
    const r = await build(S, host), save = G.AtriumIO?.exportFile || host.exportFile;
    return await save(r.name, r.bytes()) === false ? null : r.name;
  }
  // Print…: the same pages through the one print path (print.js AtriumPrint.output).
  async function print(S, host) {
    const r = await build(S, host);
    if (!G.AtriumPrint?.output) throw Error("Printing is unavailable in this build.");
    return await G.AtriumPrint.output(r, r.name) === false ? null : r.name;
  }

  // ------------------------------------------------------------------ HTML
  const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  function thumbnail(S, ch, side) {
    const m = S.model, d = m.sides(ch.doc)[side];
    if (!d) return "";
    const holder = document.createElement("div"), cv = document.createElement("canvas");
    holder.style.cssText = "position:fixed;left:-10000px;top:0;width:280px;height:170px";
    cv.style.cssText = "width:280px;height:170px;display:block";
    holder.append(cv); document.body.append(holder);
    try {
      const v = G.AtriumCanvas.create(cv), geo = m.geometry(ch), cam = cameraBox(geo, d.kind === "pcb" ? 3 : 8), s = Math.min(280 / (cam[2] - cam[0]), 170 / (cam[3] - cam[1]));
      v.restoreCamera({cx: (cam[0] + cam[2]) / 2, cy: (cam[1] + cam[3]) / 2, scale: s, referenceScale: s, flipped: false});
      const o = optsFor(d); o.overlay = [overlay(ch, geo, side, palette(d), 1)];
      v.render(d, side === "before" ? m.defs0 : m.defs1, o);
      return cv.toDataURL("image/png");
    } catch { return ""; } finally { holder.remove(); }
  }
  async function html(S, host) {
    const m = S.model, L = lines(S);
    const ordered = m.ordered(m.changes, "document"), number = new Map(ordered.map((ch, i) => [ch, i + 1]));
    const changes = ordered.filter(x => !AREA.has(x.objectKind) && m.geometry(x).box).slice(0, LIMIT);
    const thumbs = new Map();
    for (const ch of changes) { thumbs.set(ch, [thumbnail(S, ch, "before"), thumbnail(S, ch, "after")]); await new Promise(r => setTimeout(r, 0)); }
    const row = cells => "<tr>" + cells.map(v => "<td>" + esc(v) + "</td>").join("") + "</tr>";
    const img = (src, alt) => src && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(src) ? "<img alt=\"" + esc(alt) + "\" src=\"" + src + "\">" : "<div class=\"none\">" + esc(alt) + "</div>";
    const props = ch => { const f = changedFields(ch); return f.length ? "<table class=\"props\"><tbody>" + f.map(x => "<tr><th>" + esc(x.label) + "</th><td class=\"was\">" + esc(x.before || "—") + "</td><td class=\"now\">" + esc(x.after || "—") + "</td></tr>").join("") + "</tbody></table>" : ""; };
    const project = String(host.project()?.name || "Waffle");
    const out = ["<!doctype html><html lang=\"" + esc(G.AtriumI18n?.locale?.() || "en") + "\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
      "<title>" + esc(L.title + " · " + L.range) + "</title><style>",
      ":root{color-scheme:light dark;--added:#2f9e5b;--removed:#d0453f;--moved:#c48a12;--properties:#2f7fc0}body{font:13px/1.45 system-ui,sans-serif;margin:24px;max-width:1200px}",
      "table{border-collapse:collapse;width:100%;margin:8px 0 20px}th,td{text-align:left;padding:3px 6px;border-bottom:1px solid #8884;vertical-align:top}",
      ".s{display:inline-block;min-width:74px;font-weight:600}.added{color:var(--added)}.removed{color:var(--removed)}.moved,.modified{color:var(--moved)}.properties{color:var(--properties)}",
      ".legend{display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:12px}.legend i{display:inline-block;width:18px;height:10px;border:2.5px solid;margin-right:4px;vertical-align:middle}",
      ".grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(580px,1fr));gap:16px}.card{border:1px solid #8885;border-radius:6px;padding:8px}.pair{display:flex;gap:8px}",
      ".pair figure{margin:0}.pair img,.none{width:280px;height:170px;border:1px solid #8886;display:grid;place-items:center;color:#888}figcaption{font-size:11px;color:#777}",
      ".props{margin:6px 0 0;font-size:12px}.props .was{text-decoration:line-through;color:var(--removed)}.props .now{color:var(--added);font-weight:600}",
      "</style></head><body>",
      "<p><small>" + esc(project + " · " + new Date().toISOString().slice(0, 16).replace("T", " ")) + "</small></p>",
      "<h1>" + esc(L.title) + "</h1><p><b>" + esc(L.range) + "</b></p><p><b>" + esc(L.summary) + "</b></p>",
      ...L.warnings.map(w => "<p class=\"moved\">" + esc(T("diff.report.warning", {text: w})) + "</p>"),
      "<div class=\"legend\"><b>" + esc(T("diff.report.legend")) + "</b>",
      "<span><i style=\"border-color:var(--added)\"></i>+ " + esc(STATUS.added) + "</span><span><i style=\"border-color:var(--removed);border-style:dashed\"></i>− " + esc(STATUS.removed) + "</span>",
      "<span><i style=\"border-color:var(--moved)\"></i>→ " + esc(T("diff.report.moved_ghost")) + "</span><span><i style=\"border-color:var(--moved)\"></i>~ " + esc(STATUS.modified) + "</span>",
      "<span><i style=\"border-color:var(--properties);border-style:dotted\"></i>i " + esc(STATUS.properties) + "</span></div>",
      "<h2>" + esc(T("diff.report.documents")) + "</h2><table><thead><tr>" + [T("diff.report.document"), T("diff.report.kind"), T("diff.report.side"), T("diff.report.changes"),
        T("diff.report.electrical"), T("diff.report.layout"), T("diff.report.cosmetic")].map(h => "<th>" + esc(h) + "</th>").join("") + "</tr></thead><tbody>",
      ...L.docs.map(row), "</tbody></table>"];
    if (L.drc) {
      out.push("<h2>" + esc(T("diff.report.drc_delta")) + "</h2><p>" + esc(T("diff.report.drc_counts", {added: L.drc.added.length, fixed: L.drc.fixed.length})) + "</p><table><tbody>",
        ...L.drc.added.map(([d, t]) => "<tr><td class=\"removed\">" + esc(T("diff.report.new")) + "</td><td>" + esc(d) + "</td><td>" + esc(t) + "</td></tr>"),
        ...L.drc.fixed.map(([d, t]) => "<tr><td class=\"added\">" + esc(T("diff.report.fixed")) + "</td><td>" + esc(d) + "</td><td>" + esc(t) + "</td></tr>"), "</tbody></table>");
    }
    if (L.routing.length) out.push("<h2>" + esc(T("diff.report.routing")) + "</h2><table><thead><tr>" + [T("diff.report.net"), T("diff.report.board"), T("diff.report.length_before"), T("diff.report.after_col"), "Δ", T("diff.report.vias")]
      .map(h => "<th>" + esc(h) + "</th>").join("") + "</tr></thead><tbody>", ...L.routing.map(row), "</tbody></table>");
    out.push("<h2>" + esc(T("diff.report.changes")) + "</h2><table><thead><tr><th>#</th><th>" + esc(T("diff.report.severity")) + "</th><th>" + esc(T("diff.report.change")) + "</th><th></th><th>"
      + esc(T("diff.report.document")) + "</th><th>" + esc(T("diff.report.layer")) + "</th></tr></thead><tbody>",
      ...ordered.map(ch => "<tr><td>" + number.get(ch) + "</td><td>" + esc(ch.severity) + "</td><td><span class=\"s " + esc(ch.status) + "\">" + esc(STATUS[ch.status]) + "</span></td><td>" + esc(ch.sentence || ch.name) + props(ch) + "</td><td>" + esc(ch.docName) + "</td><td>" + esc(ch.layer) + "</td></tr>"),
      "</tbody></table><h2>" + esc(T("diff.report.before_after")) + "</h2><div class=\"grid\">");
    for (const ch of changes) {
      const [b, a] = thumbs.get(ch);
      out.push("<section class=\"card\"><div><b>#" + number.get(ch) + "</b> <span class=\"s " + esc(ch.status) + "\">" + esc(STATUS[ch.status]) + "</span> " + esc(ch.sentence || ch.name) + "</div>",
        "<div class=\"pair\"><figure>" + img(b, T("diff.report.not_in", {rev: m.from})) + "<figcaption>" + esc(T("diff.report.before", {rev: m.from})) + "</figcaption></figure><figure>"
          + img(a, T("diff.report.not_in", {rev: m.to})) + "<figcaption>" + esc(T("diff.report.after", {rev: m.to})) + "</figcaption></figure></div>",
        props(ch), "<small>" + esc([ch.docName, ch.layer, ch.severity].filter(Boolean).join(" · ")) + "</small></section>");
    }
    out.push("</div><p><small>" + esc(T("diff.report.footer", {date: new Date().toISOString().slice(0, 16).replace("T", " ")})) + "</small></p></body></html>");
    const name = safeName(project + " compare " + m.from.split(" · ")[0] + " to " + m.to.split(" · ")[0]) + ".html";
    const save = G.AtriumIO?.exportFile || host.exportFile;
    return await save(name, out.join("\n")) === false ? null : name;
  }
  return Object.freeze({pdf, print, html, lines, esc});
})();
