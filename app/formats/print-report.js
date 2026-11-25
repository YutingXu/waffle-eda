"use strict";
// Printing tabular and text reports (BOM, Messages, design comparison…) through the same path as
// File › Print…: the report is laid out as PDF pages (AtriumPDF, the app's embedded fonts, the
// paper sizes of print.js) and handed to AtriumPrint.output, which prints them with the system
// print panel (AtriumHost.printPDF) or, in a plain browser, window.print. Lazy (AtriumPrintReport).
//
// A report:
//   {title, subtitle?, meta?: [[label, value]…], name?: "File.pdf",
//    sections: [{heading?, columns?: [{label, numeric?}], rows?: [[cell…]…], text?: [paragraph…]}]}
//
//   AtriumPrintReport.layout(report, {paper, orientation, margin, date}) -> {pages, orientation, bytes()}
//       pages: [{w, h, list, title}] in points. Tables repeat their header row on every page, columns
//       are fitted to their content and cells wrap; hairline rules, no zebra; "Waffle EDA" and the
//       page number in the footer. orientation "auto" turns the page when the widest table does not
//       fit portrait.
//   AtriumPrintReport.print(report, options)     -> the system print panel; resolves like printPDF
//   AtriumPrintReport.open(ctx, {report, mode})  -> the Print / Export PDF dialog (paper, orientation,
//       margins, preview); report is the object or a function returning it.
globalThis.AtriumPrintReport = (() => {
  const G = globalThis, MM = 72 / 25.4;
  /** @returns {any} */ const PDF = () => G.AtriumPDF || fail("PDF output is unavailable in this build.");
  /** @returns {Record<string, number[]>} */ const PAPER = () => G.AtriumPrint?.PAPER || fail("Printing is unavailable in this build.");
  /** @returns {never} */ function fail(m) { throw Error(m); }
  const DEFAULTS = Object.freeze({paper: "A4", orientation: "auto", margin: 12});
  const INK = "#1d2321", MUTED = "#5b6562", RULE = "#cfd5d3", HEAD_RULE = "#7d8784";
  const BODY = 8, HEAD = 8, PAD_X = 4, PAD_Y = 2.5, LINE = 10, FOOT = 14;
  const font = (size, bold) => (bold ? "bold " : "") + size + "px Helvetica";

  // ------------------------------------------------------------ measuring and wrapping
  function measurer() {
    const ctx = PDF().recorder(1, 1).ctx, cache = new Map();
    return (text, f) => {
      const key = f + "\u0000" + text;
      let w = cache.get(key);
      if (w === undefined) { ctx.font = f; w = ctx.measureText(text).width; if (cache.size > 20000) cache.clear(); cache.set(key, w); }
      return w;
    };
  }
  const str = v => v == null ? "" : typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : String(v);
  // Lines of `text` no wider than `width`: breaks at spaces (after commas too), then inside words.
  function wrap(text, width, f, measure) {
    const out = [];
    for (const para of str(text).replace(/\r\n?/g, "\n").split("\n")) {
      const words = para.match(/\S+\s*|\s+/g) || [""];
      let line = "";
      for (let word of words) {
        if (measure((line + word).trimEnd(), f) <= width) { line += word; continue; }
        if (line.trim()) { out.push(line.trimEnd()); line = ""; }
        while (measure(word.trimEnd(), f) > width && word.length > 1) {
          let n = word.length - 1;
          while (n > 1 && measure(word.slice(0, n), f) > width) n--;
          out.push(word.slice(0, n)); word = word.slice(n);
        }
        line = word;
      }
      out.push(line.trimEnd());
    }
    return out;
  }
  const longestWord = (text, f, measure) => Math.max(0, ...str(text).split(/\s+/).map(w => measure(w, f)));

  // Column widths: natural = the widest cell (capped), minimum = the longest word. Widths share the
  // room above the minimums in proportion to how much each column wants; spare room goes to text columns.
  function natural(section, measure, room) {
    const cols = section.columns || [], rows = section.rows || [], step = Math.max(1, Math.floor(rows.length / 4000));
    return cols.map((c, i) => {
      let want = 0, word = longestWord(c.label, font(HEAD, true), measure);
      for (const l of str(c.label).split("\n")) want = Math.max(want, measure(l, font(HEAD, true)));
      for (let r = 0; r < rows.length; r += step) {
        const v = str(rows[r]?.[i]);
        if (!v) continue;
        for (const l of v.split("\n")) want = Math.max(want, measure(l, font(BODY)));
        word = Math.max(word, longestWord(v, font(BODY), measure));
      }
      const cap = room * .5;
      want = Math.min(want, cap) + 2 * PAD_X;
      return {want, min: Math.min(want, Math.min(word, room * .28) + 2 * PAD_X), numeric: !!c.numeric};
    });
  }
  function fit(wants, room) {
    const total = wants.reduce((s, c) => s + c.want, 0);
    if (!wants.length) return [];
    if (total <= room) {
      const text = wants.filter(c => !c.numeric), share = text.reduce((s, c) => s + c.want, 0) || total, spare = room - total;
      return wants.map(c => c.want + (text.length ? (c.numeric ? 0 : spare * c.want / share) : spare * c.want / total));
    }
    const min = wants.reduce((s, c) => s + c.min, 0);
    if (min >= room) return wants.map(c => c.min * room / min);
    const flex = total - min;
    return wants.map(c => c.min + (c.want - c.min) * (room - min) / flex);
  }

  // ------------------------------------------------------------ layout
  /** @param {{paper?: string | number[], orientation?: string, margin?: number, date?: Date}} o */
  function settle(o = {}) {
    /** @type {{paper: any, orientation: string, margin: number, date?: Date}} */
    const s = {...DEFAULTS, ...o};
    if (!Array.isArray(s.paper) && !PAPER()[s.paper]) throw Error("Unknown paper size " + s.paper + ".");
    if (!["auto", "portrait", "landscape"].includes(s.orientation)) s.orientation = "auto";
    s.margin = Math.max(5, Math.min(30, +s.margin || DEFAULTS.margin));
    return s;
  }
  function layout(report, options = {}) {
    if (!report || typeof report !== "object") throw Error("Nothing to print.");
    const o = settle(options), measure = measurer(), sections = (report.sections || []).filter(Boolean);
    const [pw, ph] = (Array.isArray(o.paper) ? o.paper : PAPER()[o.paper]).map(v => v * MM).sort((a, b) => a - b);
    const m = o.margin * MM, portraitRoom = pw - 2 * m;
    let orientation = o.orientation;
    if (orientation === "auto") {
      const widest = Math.max(0, ...sections.filter(s => s.columns?.length).map(s => natural(s, measure, ph - 2 * m).reduce((t, c) => t + c.want, 0)));
      orientation = widest > portraitRoom + .5 ? "landscape" : "portrait";
    }
    const W = orientation === "landscape" ? ph : pw, H = orientation === "landscape" ? pw : ph, room = W - 2 * m, bottom = H - m - FOOT;
    const title = str(report.title || "Report"), subtitle = str(report.subtitle);
    const pages = [];
    let rec, c, y;
    const text = (t, x, yy, f, colour = INK, align = "left") => { c.font = f; c.fillStyle = colour; c.textAlign = align; c.textBaseline = "top"; c.fillText(t, x, yy); };
    const rule = (yy, colour, width, x0 = m, x1 = W - m) => { c.strokeStyle = colour; c.lineWidth = width; c.beginPath(); c.moveTo(x0, yy); c.lineTo(x1, yy); c.stroke(); };
    function newPage() {
      rec = PDF().recorder(W, H, {}); c = rec.ctx; y = m;
      pages.push({w: W, h: H, list: rec.list, ctx: c, title: title + " · page " + (pages.length + 1)});
      if (pages.length > 1) {
        text(wrap(title + (subtitle ? " · " + subtitle : ""), room, font(7.5), measure)[0], m, y, font(7.5), MUTED);
        y += 14;
      }
    }
    newPage();
    // Title, subtitle and the title block on the first page.
    for (const l of wrap(title, room, font(16, true), measure)) { text(l, m, y, font(16, true)); y += 20; }
    if (subtitle) for (const l of wrap(subtitle, room, font(9.5), measure)) { text(l, m, y, font(9.5), MUTED); y += 13; }
    const meta = (report.meta || []).filter(p => Array.isArray(p) && str(p[1]) !== "");
    if (meta.length) {
      y += 4;
      const per = room >= 420 && meta.length > 3 ? 2 : 1, colW = room / per, keyW = Math.min(colW * .4, Math.max(...meta.map(p => measure(str(p[0]), font(BODY, true)))) + 10);
      for (let i = 0; i < meta.length; i += per) {
        let h = LINE;
        for (let k = 0; k < per && i + k < meta.length; k++) {
          const [key, value] = meta[i + k], x = m + k * colW, lines = wrap(value, colW - keyW - 8, font(BODY), measure);
          text(str(key), x, y, font(BODY, true));
          lines.forEach((l, n) => text(l, x + keyW, y + n * LINE, font(BODY), INK));
          h = Math.max(h, lines.length * LINE);
        }
        y += h + 1;
      }
    }
    y += 10;
    for (const s of sections) {
      if (s.heading) {
        if (y + 30 > bottom) newPage();
        text(str(s.heading), m, y, font(10.5, true)); y += 15;
      }
      for (const para of s.text || []) {
        for (const l of wrap(para, room, font(BODY + 1), measure)) {
          if (y + LINE + 1 > bottom) newPage();
          text(l, m, y, font(BODY + 1)); y += LINE + 1;
        }
        y += 4;
      }
      if (s.columns?.length) table(s);
      y += 12;
    }
    function table(s) {
      const cols = s.columns, widths = fit(natural(s, measure, room), room);
      const xs = widths.reduce((a, w) => (a.push(a[a.length - 1] + w), a), [m]);
      const cells = (row, f) => cols.map((_, i) => wrap(str(row[i]), Math.max(4, widths[i] - 2 * PAD_X + .01), f, measure));
      const headCells = cells(cols.map(col => col.label), font(HEAD, true));
      const headH = Math.max(...headCells.map(l => l.length)) * LINE + 2 * PAD_Y;
      const drawRow = (lines, f, from, count, colour) => lines.forEach((ls, i) => {
        const right = cols[i].numeric, x = right ? xs[i + 1] - PAD_X : xs[i] + PAD_X;
        for (let n = 0; n < count && from + n < ls.length; n++) text(ls[from + n], x, y + PAD_Y + n * LINE, f, colour || INK, right ? "right" : "left");
      });
      const header = () => { drawRow(headCells, font(HEAD, true), 0, Infinity); y += headH; rule(y, HEAD_RULE, .6, m, xs[xs.length - 1]); };
      if (y + headH + LINE + 2 * PAD_Y > bottom) newPage();
      header();
      const rows = s.rows || [];
      if (!rows.length) { text(str(s.empty || "Nothing to list."), m + PAD_X, y + PAD_Y, font(BODY), MUTED); y += LINE + 2 * PAD_Y; return; }
      for (const row of rows) {
        const lines = cells(row, font(BODY)), total = Math.max(1, ...lines.map(l => l.length));
        let from = 0;
        while (from < total) {
          const left = total - from, fresh = Math.floor((bottom - m - 14 - headH - 2 * PAD_Y) / LINE);
          let fits = Math.floor((bottom - y - 2 * PAD_Y) / LINE);
          // A row that fits on a fresh page moves there whole; a taller one splits across pages.
          if (fits < 1 || fits < left && left <= fresh) {
            newPage(); header(); fits = Math.floor((bottom - y - 2 * PAD_Y) / LINE);
          }
          const count = Math.max(1, Math.min(left, fits));
          drawRow(lines, font(BODY), from, count);
          y += count * LINE + 2 * PAD_Y; from += count;
          rule(y, RULE, .3, m, xs[xs.length - 1]);
        }
      }
    }
    // Footers once the page count is known.
    const date = o.date instanceof Date ? o.date : new Date();
    pages.forEach((p, n) => {
      c = p.ctx;
      const fy = H - m - 8;
      text("Waffle EDA", m, fy, font(7), MUTED);
      text(date.toISOString().slice(0, 10), W / 2, fy, font(7), MUTED, "center");
      text("Page " + (n + 1) + " of " + pages.length, W - m, fy, font(7), MUTED, "right");
      delete p.ctx;
    });
    return {pages, orientation, options: o, title, name: fileName(report),
      bytes() {
        const doc = PDF().document({title: title + (subtitle ? " · " + subtitle : ""), subject: "Waffle report", date});
        for (const p of pages) doc.page(p.w, p.h, p.list);
        return doc.bytes();
      }};
  }
  const fileName = report => {
    const base = str(report.name || report.title || "Report").replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim() || "Report";
    return /\.pdf$/i.test(base) ? base : base + ".pdf";
  };
  const resolve = report => typeof report === "function" ? report() : report;
  async function print(report, options = {}) {
    const r = layout(await resolve(report), options);
    if (!G.AtriumPrint?.output) throw Error("Printing is unavailable in this build.");
    return G.AtriumPrint.output(r, r.name);
  }

  // ------------------------------------------------------------ dialog
  // The same dialog as File › Print… (print.js classes): page settings and a preview on the left and
  // right, Close / Export PDF… / Print… below. Mod+P in it prints.
  const STORE = "atrium.print.report.v1";
  function remembered() { try { return JSON.parse(localStorage.getItem(STORE) || "null") || {}; } catch { return {}; } }
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function open(ctx = {}, how = {}) {
    const keep = remembered(), o = {...DEFAULTS, paper: PAPER()[keep.paper] ? keep.paper : DEFAULTS.paper, margin: +keep.margin || DEFAULTS.margin,
      orientation: how.orientation || "auto"};
    const pdf = how.mode === "pdf", heading = pdf ? "Export PDF" : "Print";
    const d = el("dialog", null, "work-dialog ui-dialog print-dialog print-report-dialog"); d.setAttribute("aria-label", heading);
    d.dataset.printTarget = "";
    let timer = 0, ticket = 0, busy = false, report = null, result = null;
    const {body, form, status, choice, paintPages, clearPages, releasePages, printBtn, pdfBtn, close} = G.AtriumPrint.dialogControls(d, changed);
    const page = el("fieldset"); page.append(el("legend", "Page"),
      choice("Paper", Object.keys(PAPER()).map(k => [k, k + " · " + PAPER()[k].map(v => +v.toFixed(1)).join(" × ") + " mm"]), o.paper, v => { o.paper = v; }),
      choice("Orientation", [["auto", "Automatic (fits the table)"], ["landscape", "Landscape"], ["portrait", "Portrait"]], o.orientation, v => { o.orientation = v; }),
      choice("Margins", [[8, "8 mm"], [12, "12 mm"], [15, "15 mm"], [20, "20 mm"]], o.margin, v => { o.margin = +v; }));
    form.append(page);
    function changed() {
      clearTimeout(timer); timer = setTimeout(refresh, 120);
      try { localStorage.setItem(STORE, JSON.stringify({paper: o.paper, margin: o.margin})); } catch {}
    }
    function build() { result = layout(report, o); return result; }
    async function refresh() {
      const mine = ++ticket;
      try {
        report ??= await resolve(how.report);
        if (mine !== ticket || !d.open) return;
        const t = Date.now(), r = build(), P = PDF();
        paintPages(r.pages, p => P.svg(p.w, p.h, p.list), (_p, n) => "Page " + n);
        status.textContent = r.pages.length + " page" + (r.pages.length === 1 ? "" : "s") + " · " + r.orientation + " · laid out in " + (Date.now() - t) + " ms";
      } catch (e) {
        if (mine === ticket && d.open) { clearPages(); status.textContent = e.message || String(e); }
      }
    }
    const run = fn => async () => {
      if (busy) return; busy = true; status.textContent = "Working…";
      try {
        report ??= await resolve(how.report);
        if (!d.open) return;
        await fn(result && result.options.paper === o.paper && result.options.margin === o.margin && result.options.orientation === o.orientation ? result : build());
      }
      catch (e) { status.textContent = e.message || String(e); }
      finally { busy = false; }
    };
    const primary = pdf ? pdfBtn : printBtn, secondary = pdf ? printBtn : pdfBtn;
    primary.classList.add("is-primary"); primary.dataset.variant = "primary"; primary.dataset.uiDefault = "false";
    printBtn.onclick = run(async r => {
      if (!G.AtriumPrint?.output) throw Error("Printing is unavailable in this build.");
      const done = await G.AtriumPrint.output(r, r.name);
      status.textContent = done === false ? "Printing cancelled." : "Sent to the printer.";
    });
    pdfBtn.onclick = run(async r => {
      const save = ctx.exportFile || G.AtriumIO?.exportFile;
      if (!save) throw Error("Saving files is unavailable here.");
      const bytes = r.bytes();
      if (await save(r.name, bytes)) { status.textContent = "Exported " + r.name + " · " + Math.max(1, Math.round(bytes.length / 1024)) + " KB"; ctx.info?.("Exported " + r.name); }
    });
    close.onclick = () => d.close();
    const actions = el("div", null, "work-actions ui-dialog-actions");
    actions.append(status, close, secondary, primary);
    const title = el("h2", how.title ? heading + " · " + how.title : heading);
    d.append(title, body, actions);
    G.AtriumShell.openDialog(d, {title, body, actions, initialFocus: () => primary,
      onClose() { clearTimeout(timer); releasePages(); }});
    refresh();
    return d;
  }

  return Object.freeze({layout, print, open, wrap, fit, settle, fileName, DEFAULTS});
})();
