"use strict";
// Engine entry for diff_designs (mcp/diff_designs.py) and bin/waffle-diff:
//   AtriumDiffReport(headerJSON, beforeText, afterText) -> JSON
// The header carries {format, section, severity, category, net, document_id, query, offset, limit,
// options, from, to, key}. The last comparison is kept (by `key`, the two SHA-256s plus the
// options), so paging through a large change set compares once.
globalThis.AtriumDiffReport = (() => {
  let last = null;
  const RANK = {electrical: 0, mechanical: 1, cosmetic: 2};
  function parse(text, side) {
    let p;
    try { p = JSON.parse(text); } catch { throw Error("The " + side + " design is not valid JSON."); }
    if (!p || typeof p !== "object" || !Array.isArray(p.documents)) throw Error("The " + side + " design is not a Waffle project.");
    if (p.documents.length) {
      try { Atrium.validate(p); } catch { throw Error("The " + side + " design is not a supported Waffle project."); }
    }
    return p;
  }
  function page(items, h) {
    const offset = h.offset ?? 0, limit = Math.min(h.limit ?? 50, 200), end = offset + limit;
    return {items: items.slice(offset, end), total: items.length, next_offset: end < items.length ? end : null};
  }
  return function AtriumDiffReport(headerText, beforeText, afterText) {
    const h = JSON.parse(headerText);
    let r = last && h.key && last.key === h.key ? last.result : null;
    if (!r) {
      last = null;
      const a = parse(beforeText, "before"), b = parse(afterText, "after");
      r = AtriumDiff.compare(a, b, {...(h.options || {}), validate: false});
      last = {key: h.key, result: r};
    }
    const opts = {title: "Design changes", from: h.from, to: h.to, severity: h.severity, category: h.category, net: h.net};
    if (h.format === "markdown") return JSON.stringify({summary: r.summary, stats: r.stats, report: AtriumDiff.toMarkdown(r, opts)});
    if (h.format === "html") return JSON.stringify({summary: r.summary, stats: r.stats, report: AtriumDiff.toHTML(r, opts)});
    if (h.format === "json") return JSON.stringify({summary: r.summary, stats: r.stats, report: AtriumDiff.toJSON(r, opts)});
    if (h.section === "components") {
      const q = String(h.query || "").toLowerCase();
      const rows = r.components.filter(m => (!h.document_id || m.doc === h.document_id) &&
        (!q || [m.beforeRef,m.afterRef,...(m.alternatives || []).map(c=>c.ref)].some(ref=>String(ref || "").toLowerCase().includes(q))))
        .sort((a,b) => Number(b.review)-Number(a.review));
      const p = page(rows,h);
      return JSON.stringify({summary:r.summary,stats:r.stats,section:"components",components:p.items,total:p.total,next_offset:p.next_offset});
    }
    if (h.section === "nets") {
      const q = String(h.query || "").toLowerCase();
      const nets = Object.values(r.byNet).filter(e => (!h.net || e.name === h.net) && (!q || e.name.toLowerCase().includes(q)))
        .sort((x, y) => x.name < y.name ? -1 : x.name > y.name ? 1 : 0)
        .map(e => ({name: e.name, status: e.status, renamed_from: e.renamedFrom, renamed_to: e.renamedTo,
          schematic: e.schematic && {gained: e.schematic.gained, lost: e.schematic.lost, pins: e.schematic.after.length},
          boards: Object.fromEntries(Object.entries(e.boards).map(([id, b]) => [id, {gained: b.gained, lost: b.lost, routing: b.routing || null, copper: b.copper || null}])),
          changes: e.changes.map(i => r.changes[i].id)}));
      const p = page(nets, h);
      return JSON.stringify({summary: r.summary, stats: r.stats, section: "nets", nets: p.items, total: p.total, next_offset: p.next_offset});
    }
    const sev = h.severity ? RANK[h.severity] : 2, q = String(h.query || "").toLowerCase();
    const rows = r.changes.filter(c => RANK[c.severity] <= sev && (!h.category || c.category === h.category) && (!h.net || c.target.net === h.net) &&
      (!h.document_id || c.target.doc === h.document_id) && (!q || c.text.toLowerCase().includes(q) || c.kind.includes(q)));
    const p = page(rows, h);
    const json = AtriumDiff.toJSON({...r, changes: p.items}, {});
    return JSON.stringify({summary: r.summary, stats: r.stats, section: "changes", changes: json.changes, total: p.total, next_offset: p.next_offset});
  };
})();
