"use strict";
// AtriumDiffProps: the visual diff's property table and status glyphs (Property · Before · After,
// changed rows struck through and highlighted), shared by the visual diff's inspector (diff-view.js)
// and the extension proposal review (extensions.js). Styles: diff-props.css.
//
//   table(doc, rows, {labels, limit})  rows: [{label, before, after, changed, control?, title?}] -> <table>
//   glyph(doc, status)                 status: added | removed | moved | modified | properties -> <i>
//   proposalGroups(rows)               AtriumProposal.inspect rows grouped by the object they change (DOM-free)
//   valueText(v, max)                  a JSON value as short text for a cell (DOM-free)
globalThis.AtriumDiffProps = (() => {
  const GLYPH = Object.freeze({added: "+", removed: "−", moved: "→", modified: "~", properties: "i"});
  const el = (doc, tag, text, cls) => AtriumNavCommon.elementIn(doc, tag, text, cls);
  function glyph(doc, status) {
    const g = el(doc, "i", GLYPH[status] || "~", "dv-glyph dv-st-" + (GLYPH[status] ? status : "modified"));
    g.setAttribute("aria-hidden", "true");
    return g;
  }
  function table(doc, rows, o = {}) {
    const labels = o.labels || ["Property", "Before", "After"], limit = o.limit ?? 40;
    const t = el(doc, "table", null, "dv-props"), hd = el(doc, "thead"), tr = el(doc, "tr");
    for (const l of labels) tr.append(el(doc, "th", l));
    hd.append(tr);
    const tb = el(doc, "tbody");
    for (const f of rows.slice(0, limit)) {
      const r = el(doc, "tr"); if (f.changed) r.className = "is-changed";
      const th = el(doc, "th"); th.scope = "row";
      if (f.control) { const l = el(doc, "label", null, "dv-props-pick"); l.append(f.control, el(doc, "span", f.label)); th.append(l); }
      else th.textContent = f.label;
      r.append(th, el(doc, "td", f.before || "—"), el(doc, "td", f.after || "—"));
      if (f.title) r.setAttribute("aria-label", f.title);
      tb.append(r);
    }
    t.append(hd, tb);
    return t;
  }
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  function valueText(v, max = 160) {
    if (v === undefined) return "";
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }
  // Rows from AtriumProposal.inspect ({index, op, label, detail}) as the visual diff shows them: one
  // group per changed object (status added, removed or properties) with a row per field.
  function proposalGroups(rows) {
    const groups = new Map();
    for (const row of rows) {
      const o = row.op || {};
      if (o.op === "set") {
        const key = o.target + "/" + (o.document || "") + "/" + (o.id || "");
        let g = groups.get(key);
        if (!g) groups.set(key, g = {key, status: "properties", title: String(row.label).split(" · ")[0], rows: []});
        g.rows.push({index: row.index, label: o.path.join("."), before: own(o, "before") ? valueText(o.before) : "", after: own(o, "after") ? valueText(o.after) : "", changed: true});
      } else {
        const v = (o.op === "add" ? o.value : o.before) || {};
        const fields = ["kind", "ref", "value", "name", "net", "layer", "text"].filter(k => v[k] != null).map(k => ({label: k, value: valueText(v[k])}));
        groups.set("row/" + row.index, {key: "row/" + row.index, status: o.op === "add" ? "added" : "removed", title: row.label + (row.detail ? " · " + row.detail : ""),
          rows: [{index: row.index, label: o.op === "add" ? "Add" : "Remove", before: o.op === "add" ? "" : fields.map(f => f.label + " " + f.value).join(", "),
            after: o.op === "add" ? fields.map(f => f.label + " " + f.value).join(", ") : "", changed: true}]});
      }
    }
    return [...groups.values()];
  }
  return Object.freeze({GLYPH, glyph, table, proposalGroups, valueText});
})();
