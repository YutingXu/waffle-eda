"use strict";
// Back-drill and via-stub report (Tools › Via Stub Report…), after Allegro's
// backdrill analysis. A via's plated barrel that runs past the last copper
// layer it connects to is a stub: an open-ended transmission line that
// resonates at high data rates. For each via this module finds the copper
// layers it really connects to (tracks, pads, polygons and fills of its net
// touching its land), measures the stubs above the first and below the last
// used layer from the layer stack (AtriumViaStack.physical, top surface = 0),
// takes a back-drill (via.backdrill, viastack.js) into account and flags vias
// whose remaining stub exceeds the limit. The Max Via Stub Length rule
// (rules.js type viaStub) reports the same numbers in the DRC.
//
// AtriumViaStubs.report(board, defs, {max}) ->
//   {rows:[{id, net, at, span:[from,to], used:[layers], stubTop, stubBottom, stub,
//           backdrill:null|{side, stopLayer, stubMax}, residual, status, recommend}],
//    total, thickness, max, counts:{vias, stubs, over, backdrilled, unused, severed}}
// status: "ok" | "over" (stub > max, back-drill recommended) | "backdrilled" |
//   "severed" (the back-drill cuts a layer the via uses) | "unused".
globalThis.AtriumViaStubs = (() => {
  const EPS = 1e-6, DEFAULT_MAX = .25;
  const round = v => Math.round(v * 1e4) / 1e4 + 0;
  const finite = v => typeof v === "number" && Number.isFinite(v);
  const own = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
  const COPPER = /^(Top|Bottom|Inner (?:[1-9]\d?|1[01]\d|12[0-6]))$/;
  const index = k => { if (k === "Top") return 0; if (k === "Bottom") return 127; const m = /^Inner (\d+)$/.exec(k || ""); return m ? Number(m[1]) : null; };
  const A = () => globalThis.Atrium;

  function inside(p, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const a = poly[i], b = poly[j];
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  }
  // Copper of each net by layer: [{layer, net, test(p, r)}], built once per report.
  function copperIndex(doc, defs) {
    const {nearSegment} = A();
    const byNet = new Map(), add = (net, layer, test) => {
      if (!net || !COPPER.test(layer || "")) return;
      if (!byNet.has(net)) byNet.set(net, []);
      byNet.get(net).push({layer, test});
    };
    const path = (net, layer, pts, width, fill, closed) => {
      if (!Array.isArray(pts) || pts.length < 2) return;
      const w = Math.max(0, +width || 0) / 2;
      add(net, layer, (p, r) => {
        if (fill && closed !== false && pts.length > 2 && inside(p, pts)) return true;
        for (let n = 1; n < pts.length; n++) if (nearSegment(p, pts[n - 1], pts[n]) <= r + w + EPS) return true;
        return closed && pts.length > 2 && nearSegment(p, pts.at(-1), pts[0]) <= r + w + EPS;
      });
    };
    const pad = (net, layers, c, p) => {
      const half = Math.hypot(p.w || p.diameter || 0, p.h || p.diameter || 0) / 2, small = Math.min(p.w || p.diameter || 0, p.h || p.diameter || 0) / 2;
      for (const l of layers) add(net, l, (q, r) => { const d = Math.hypot(q[0] - c[0], q[1] - c[1]); return d <= r + small + EPS || d <= half && d <= r + half; });
    };
    const keys = layerKeys(doc, defs);
    for (const i of doc.items || []) {
      if (i.kind === "track" || i.kind === "graphic" && i.net) path(i.net, i.layer, i.points, i.width, i.fill, i.closed ?? !!i.fill);
      else if (i.kind === "polygon" && i.net && !i.cutout && !i.shelved && Array.isArray(i.points)) add(i.net, i.layer, p => inside(p, i.points));
      else if (i.kind === "pad" && i.net) pad(i.net, i.drill > 0 || i.layer === "Multi" ? keys : [i.layer || "Top"], [i.x, i.y], i);
      else if (i.kind === "part") {
        const fp = defs?.get?.(i.def)?.footprint;
        for (const p of fp?.pads || []) {
          const net = own(i.pinNets, p.number) ? i.pinNets[p.number] : p.net || "";
          if (!net) continue;
          const c = A().world([p.x, p.y], i), side = i.layer === "Bottom" ? (p.layer === "Bottom" ? "Top" : "Bottom") : p.layer || "Top";
          pad(net, p.drill > 0 || p.layer === "Multi" ? keys : [side], c, p);
        }
        for (const s of fp?.shapes || []) if (s.net && s.kind === "path") path(s.net, s.layer, s.points.map(q => A().world(q, i)), s.width, s.fill, s.closed);
      }
    }
    return byNet;
  }
  function layerKeys(doc, defs) {
    try { const k = globalThis.AtriumStackup?.copperLayers?.(doc, defs); if (Array.isArray(k) && k.length >= 2) return k; } catch { /* fall back */ }
    const set = new Set(["Top", "Bottom"]);
    for (const i of doc.items || []) for (const k of [i.layer, i.fromLayer, i.toLayer]) if (COPPER.test(k || "")) set.add(k);
    return [...set].sort((a, b) => index(a) - index(b));
  }
  // Physical layer positions: AtriumViaStack.physical when loaded, else a
  // stack spread evenly over the board thickness.
  function physical(doc, defs) {
    const VS = globalThis.AtriumViaStack;
    if (VS?.physical) { try { const P = VS.physical(doc, defs); if (P?.copper?.size) return P; } catch { /* fall back */ } }
    const keys = layerKeys(doc, defs), total = finite(doc.thickness) && doc.thickness > 0 ? doc.thickness : 1.6, t = .035;
    const copper = new Map(keys.map((k, n) => [k, {key: k, z: keys.length > 1 ? n * (total - t) / (keys.length - 1) : 0, t}]));
    return {copper, total, keys, estimated: true};
  }
  const spanOf = v => {
    const VS = globalThis.AtriumViaStack;
    if (VS?.spanOf) return VS.spanOf(v);
    const a = v.fromLayer, b = v.toLayer;
    if (!COPPER.test(a || "") || !COPPER.test(b || "") || a === b) return ["Top", "Bottom"];
    return index(a) < index(b) ? [a, b] : [b, a];
  };
  function ruleSubject(via, span) {
    const at = [via.x, via.y];
    const subject = globalThis.AtriumRules?.kit.copperSubject(via, null, "via", at);
    return {...(subject || via), layer: "Multi", span: span.map(index), at};
  }

  function measureVia(v, P, keys, nets, maxFor, defaultMax) {
    const span = spanOf(v), [a, b] = span, inSpan = keys.filter(k => index(k) >= index(a) && index(k) <= index(b));
    const at = [v.x, v.y], r = Math.max(0, +v.diameter || 0) / 2;
    const used = inSpan.filter(k => (nets.get(v.net) || []).some(c => c.layer === k && c.test(at, r)));
    const top = P.copper.get(a), bottom = P.copper.get(b);
    const z0 = top ? top.z : 0, z1 = bottom ? bottom.z + bottom.t : P.total;
    const row = {id: v.id, net: v.net || "", at, span, used, drill: v.drill || 0, depth: round(z1 - z0), stubTop: 0, stubBottom: 0, stub: 0,
      backdrill: null, residual: 0, status: "ok", recommend: null, max: maxFor?.(v, span) ?? null};
    if (!used.length) { row.status = "unused"; row.stub = row.residual = row.depth; return row; }
    const u0 = P.copper.get(used[0]), u1 = P.copper.get(used.at(-1));
    row.stubTop = round(Math.max(0, (u0 ? u0.z : z0) - z0));
    row.stubBottom = round(Math.max(0, z1 - (u1 ? u1.z + u1.t : z1)));
    row.stub = Math.max(row.stubTop, row.stubBottom);
    let top2 = row.stubTop, bottom2 = row.stubBottom;
    const bd = v.backdrill;
    if (bd && COPPER.test(bd.toLayer || "") && (bd.from === "top" || bd.from === "bottom")) {
      const stop = P.copper.get(bd.toLayer), stubMax = finite(bd.stubMax) ? bd.stubMax : .2;
      row.backdrill = {side: bd.from, stopLayer: bd.toLayer, stubMax};
      if (stop) {
        const severs = bd.from === "bottom" ? used.some(k => index(k) > index(bd.toLayer)) : used.some(k => index(k) < index(bd.toLayer));
        if (severs) row.status = "severed";
        if (bd.from === "bottom") { const end = Math.min(z1, stop.z + stop.t + stubMax); bottom2 = round(Math.max(0, end - (u1 ? u1.z + u1.t : z1))); }
        else { const end = Math.max(z0, stop.z - stubMax); top2 = round(Math.max(0, (u0 ? u0.z : z0) - end)); }
      }
    }
    row.residual = Math.max(top2, bottom2);
    const max = row.max ?? defaultMax ?? DEFAULT_MAX;
    if (row.status !== "severed") {
      if (row.residual > max + EPS) {
        row.status = "over";
        // One back-drill per via: from the side with the longer stub, stopping at the used layer.
        row.recommend = bottom2 >= top2 ? {from: "bottom", toLayer: used.at(-1)} : {from: "top", toLayer: used[0]};
        if (Math.min(top2, bottom2) > max + EPS) row.note = "Both ends exceed the limit; one back-drill removes only one stub.";
      } else if (row.backdrill) row.status = "backdrilled";
    }
    return row;
  }
  function measureBoard(doc, defs, maxFor, defaultMax, visit) {
    if (doc?.kind !== "pcb") throw Error("Choose a PCB layout for the via stub report.");
    const P = physical(doc, defs), keys = P.keys?.length ? P.keys.filter(k => COPPER.test(k)) : layerKeys(doc, defs);
    const nets = copperIndex(doc, defs);
    for (const v of doc.items || []) if (v.kind === "via" && v.net) visit(v, measureVia(v, P, keys, nets, maxFor, defaultMax));
    return {P, keys};
  }

  function report(doc, defs = new Map(), options = {}) {
    const rows = [];
    let rules;
    function maximum(via, span) {
      if (finite(options.max)) return options.max;
      try {
        rules ??= globalThis.AtriumRules?.compiled(doc, {defs, project: options.project});
        return rules?.first("viaStub", ruleSubject(via, span))?.max ?? null;
      } catch { return null; }
    }
    const {P, keys} = measureBoard(doc, defs, maximum, options.defaultMax, (_, row) => rows.push(row));
    const counts = {vias: rows.length, stubs: rows.filter(r => r.stub > EPS).length, over: rows.filter(r => r.status === "over").length,
      backdrilled: rows.filter(r => r.backdrill).length, unused: rows.filter(r => r.status === "unused").length, severed: rows.filter(r => r.status === "severed").length};
    return {rows, total: round(P.total), thickness: round(P.total), estimated: !!P.estimated, layers: keys, max: options.max ?? null, counts};
  }
  // DRC hook (rules.js): flag(rule, violation) for vias over the Max Via Stub Length rule.
  function drc(doc, defs, {first, flag, notes} = {}) {
    const rows = [];
    let stack;
    try { stack = measureBoard(doc, defs, null, Infinity, (via, row) => rows.push([via, row])).P; }
    catch (e) { notes?.push("Via stub check skipped: " + e.message); return; }
    if (stack.estimated) notes?.push("Via stub lengths assume an evenly spread " + round(stack.total) + " mm stack: define the layer stack for exact values.");
    for (const [via, row] of rows) {
      const r = first("viaStub", ruleSubject(via, row.span));
      if (!r || row.status === "unused") continue;
      if (row.status === "severed") {
        flag(r, {id: row.id, title: "Via " + row.net + " (" + row.span.join("–") + ")", what: "Back-drill", detail: "Back-drill to " + row.backdrill.stopLayer + " cuts a layer the via connects to (" + row.used.join(", ") + ")", at: row.at});
        continue;
      }
      if (row.residual > r.max + EPS) flag(r, {id: row.id, title: "Via " + row.net + " (" + row.span.join("–") + ", used " + row.used.join(", ") + ")" + (row.backdrill ? " back-drilled from " + row.backdrill.side : ""),
        what: "Via stub", actual: row.residual, required: r.max, limit: "max", at: row.at});
    }
  }
  // Set (or clear, with null) the back-drill of a via to a recommendation.
  function setBackdrill(via, recommend, stubMax = .2) {
    if (!recommend) { delete via.backdrill; return via; }
    via.backdrill = {from: recommend.from, toLayer: recommend.toLayer, stubMax};
    return via;
  }

  // ---------------------------------------------------------------- dialog
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs); }
  function button(text, act, cls, title) { const b = el("button", text, cls); b.classList.add("ui-button"); b.type = "button"; b.onclick = act; if (title) b.title = title; return b; }
  const STATUS = {ok: "OK", over: "Back-drill", backdrilled: "Back-drilled", severed: "Cuts used layer", unused: "Unconnected"};
  function open(ctx) {
    const doc = ctx.doc;
    if (doc?.kind !== "pcb") { ctx.info?.("Open a board layout for the via stub report."); return null; }
    document.querySelectorAll("dialog.vstub-dialog").forEach(x => x.close());
    const U = globalThis.Atrium?.units, unit = U ? U.normal(ctx.project?.units) : "mm";
    const fmt = mm => U ? U.value(mm, unit, unit === "mil" ? 1 : 3) + " " + unit : round(mm) + " mm"; // "0 mm", as elsewhere in the UI
    let max = DEFAULT_MAX, onlyIssues = false, rep = null;
    const d = el("dialog", null, "ui-dialog work-dialog vstub-dialog", {"aria-label": "Via stub report"});
    const head = el("div", null, "vstub-head"), summary = el("p", null, "vstub-summary", {role: "status", "aria-live": "polite"});
    head.append(el("h2", "Via Stub Report", "ui-dialog-title"), summary);
    const tools = el("div", null, "work-toolbar vstub-tools");
    const limit = el("input", null, "vstub-limit ui-field", {type: "number", min: "0", step: "0.05", "aria-label": "Default stub limit in mm"});
    limit.dataset.numericUnit = "mm"; limit.value = String(max);
    limit.onchange = () => { const v = Number(limit.value); if (v >= 0) { max = v; paint(); } };
    const filter = el("label", null, "vstub-filter"), box = el("input", null, "ui-checkbox", {type: "checkbox"});
    box.onchange = () => { onlyIssues = box.checked; paint(); };
    filter.append(box, el("span", " Only vias that need attention"));
    const limitLabel = el("label", null, "vstub-filter");
    limitLabel.append(el("span", "Limit without a rule (mm) "), limit);
    tools.append(limitLabel, filter, button("Back-drill all flagged", () => {
      const flagged = rep.rows.filter(r => r.status === "over" && r.recommend);
      if (!flagged.length) { summary.textContent = "No via needs back-drilling."; return; }
      ctx.edit(() => { for (const r of flagged) { const v = ctx.doc.items.find(i => i.id === r.id); if (v) setBackdrill(v, r.recommend); } });
      paint(); summary.textContent += " · " + flagged.length + " back-drill" + (flagged.length === 1 ? "" : "s") + " added.";
    }, "", "Set a back-drill from the longer stub side to the last used layer on every flagged via"));
    const wrap = el("div", null, "vstub-table-wrap ui-dialog-body"), table = el("table", null, "vstub-table"), tbody = el("tbody");
    const hr = el("tr");
    for (const h of ["Via", "Net", "Span", "Used layers", "Top stub", "Bottom stub", "Residual", "Back-drill", "Status", ""]) hr.append(el("th", h, null, {scope: "col"}));
    const thead = el("thead"); thead.append(hr); table.append(thead, tbody); wrap.append(table);
    const footer = el("div", null, "work-actions ui-dialog-actions");
    footer.append(button("Close", () => d.close()));
    d.append(head, tools, wrap, footer);
    d.addEventListener("close", () => d.remove(), {once: true});
    d.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); d.close(); } });
    function paint() {
      try { rep = report(ctx.doc, ctx.defs, {project: ctx.project, defaultMax: max}); } catch (e) { summary.textContent = e.message; return; }
      const c = rep.counts;
      summary.textContent = c.vias + " via" + (c.vias === 1 ? "" : "s") + " · " + c.stubs + " with stubs · " + c.over + " over the limit · " + c.backdrilled + " back-drilled" +
        (c.severed ? " · " + c.severed + " cut a used layer" : "") + " · board " + fmt(rep.total) + (rep.estimated ? " (estimated stack)" : "");
      tbody.replaceChildren();
      const rows = onlyIssues ? rep.rows.filter(r => r.status === "over" || r.status === "severed") : rep.rows;
      rows.forEach((r, n) => {
        const tr = el("tr", null, "vstub-" + r.status);
        const bd = el("input", null, "ui-checkbox", {type: "checkbox", "aria-label": "Back-drill via " + (n + 1) + " on " + r.net});
        bd.checked = !!r.backdrill; bd.disabled = !r.backdrill && !r.recommend;
        bd.onchange = () => {
          ctx.edit(() => { const v = ctx.doc.items.find(i => i.id === r.id); if (v) setBackdrill(v, bd.checked ? r.recommend || {from: "bottom", toLayer: r.used.at(-1)} : null); });
          paint();
        };
        const cell = el("td"); cell.append(bd);
        if (r.backdrill) cell.append(el("span", " " + r.backdrill.side + " → " + r.backdrill.stopLayer));
        else if (r.recommend) cell.append(el("span", " " + r.recommend.from + " → " + r.recommend.toLayer, "vstub-hint"));
        const locate = button("Locate", () => { try { ctx.locate ? ctx.locate(r.id, r.at) : ctx.select?.(r.id); } catch (e) { summary.textContent = e.message; } });
        locate.setAttribute("aria-label", "Locate via " + (n + 1) + " on " + r.net);
        const act = el("td"); act.append(locate);
        tr.append(el("td", String(n + 1), "n"), el("td", r.net), el("td", r.span.join("–")), el("td", r.used.join(", ") || "—"),
          el("td", fmt(r.stubTop), "n"), el("td", fmt(r.stubBottom), "n"), el("td", fmt(r.residual), "n"), cell,
          el("td", STATUS[r.status] + (r.note ? " *" : ""), "vstub-status", r.note ? {title: r.note} : null), act);
        tbody.append(tr);
      });
      if (!rows.length) { const tr = el("tr"), td = el("td", onlyIssues ? "No via needs attention." : "The board has no vias on a net.", "vstub-empty", {colspan: "10"}); tr.append(td); tbody.append(tr); }
    }
    document.body.append(d); paint(); globalThis.AtriumShell?.adoptDialog?.(d); d.showModal();
    return d;
  }
  return Object.freeze({DEFAULT_MAX, report, drc, setBackdrill, open, physical});
})();
