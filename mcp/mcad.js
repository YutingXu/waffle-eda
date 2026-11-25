"use strict";
// Headless ECAD-MCAD exchange for the MCP server (mcp/mcad.py): mcad_status, import_mcad_changes and
// export_idx, on the server's working copy of the project. The exchange is app/mcad*.js.
//   op mcad_status   {document_id, gap, list}  body: an enclosure STEP (optional) -> status (+ clearance)
//   op mcad_import   {document_id, format, file, accept, reject, comment}  body: the file text -> proposals
//   op mcad_export   {document_id, kind, date, record, batch, index}       -> [head, file text]
globalThis.AtriumMCADHeadless = (() => {
  const G = globalThis;
  const fail = m => { throw Error(m); };
  const need = (g, f) => G[g] || fail("ECAD-MCAD exchange is not available in this build (" + f + ").");
  const brief = p => ({id: p.id, kind: p.kind, status: p.status, key: p.key || null, source: p.source, ident: p.ident ? {scope: p.ident.scope, number: p.ident.number} : null,
    before: p.before && p.kind !== "outline" ? p.before : p.before ? {points: p.before.outline.length, cutouts: (p.before.cutouts || []).length} : null,
    after: p.after && p.kind !== "outline" ? p.after : p.after ? {points: p.after.outline.length, cutouts: (p.after.cutouts || []).length} : null, comment: p.comment || null});
  function status(a, ctx, body) {
    const MC = need("AtriumMCAD", "formats/mcad.js"), p = ctx.project(), d = ctx.board(p, a.document_id), out = MC.status(p, d);
    if (a.list !== false) out.untrusted_design_text = {proposals: (MC.peek(d)?.inbox || []).filter(x => x.status === "pending").slice(0, 500).map(x => ({...brief(x), label: x.label})),
      received: (MC.peek(d)?.received || []).slice(-20).map(r => ({batch: r.batch, file: r.file, kind: r.kind, source: r.source, at: r.at, count: r.count}))};
    if (body) {
      const ST = need("AtriumMCADStep", "formats/mcad-step.js"), e = MC.peek(d)?.enclosure;
      const enc = ST.enclosure(String(body), {offset: a.offset || e?.offset, rz: a.rz ?? e?.rz});
      const r = ST.clearance(p, d, enc, {gap: a.gap ?? e?.gap ?? 1});
      out.clearance = {gap: r.gap, triangles: enc.triangles, bbox: enc.bbox, stats: r.stats, findings: r.findings.slice(0, 500).map(f => ({id: f.id, kind: f.kind, distance: f.distance, at3d: f.at3d})),
        untrusted_design_text: {designators: r.findings.slice(0, 500).map(f => f.ref)}};
      if (a.derive) {
        const des = ST.derive(p, d, enc, {mode: a.derive.mode, z: a.derive.z, up: a.derive.up, inset: a.derive.inset});
        out.derived = {proposals: MC.compare(p, d, des).map(x => ({...brief(x), label: x.label}))};
      }
    }
    return out;
  }
  function importChanges(a, ctx, body) {
    const MC = need("AtriumMCAD", "formats/mcad.js"), text = String(body ?? ""), file = String(a.file || "mcad");
    const fmt = a.format && a.format !== "auto" ? a.format : /\.(emn|idf|brd)$/i.test(file) || /^\s*\.HEADER/i.test(text.slice(0, 64)) ? "idf" : /\.(step|stp)$/i.test(file) || /^\s*ISO-10303-21/.test(text.slice(0, 64)) ? "step" : "idx";
    const design = fmt === "idf" ? need("AtriumIDF", "formats/mcad-idf.js").read(text) : fmt === "step" ? need("AtriumMCADStep", "formats/mcad-step.js").boardFromStep(text) : need("AtriumIDX", "formats/mcad-idx.js").read(text);
    const p = ctx.mutable(), d = ctx.board(p, a.document_id);
    const r = MC.receive(p, d, design, {file, at: a.date || "", source: fmt});
    const ids = new Set(r.proposals.map(x => x.id)), applied = [], rejected = [], errors = [];
    const pick = v => v === "all" ? r.proposals.filter(x => x.status === "pending").map(x => x.id) : Array.isArray(v) ? v.filter(id => ids.has(id)) : [];
    for (const id of pick(a.accept)) { try { MC.accept(p, d, id); applied.push(id); } catch (e) { errors.push(id + ": " + e.message); } }
    for (const id of pick(a.reject)) { try { MC.reject(p, d, id, a.comment); rejected.push(id); } catch (e) { errors.push(id + ": " + e.message); } }
    ctx.touched();
    return {document_id: d.id, format: fmt, kind: design.kind, batch: r.batch, proposals: r.proposals.map(brief), accepted: applied, rejected, errors,
      responses: design.responses?.length ? design.responses.map(x => ({number: x.ident?.number || null, accepted: x.accepted})) : undefined,
      untrusted_design_text: {labels: r.proposals.map(x => x.label), header: design.header || null, notes: design.notes || []}};
  }
  function exportFile(a, ctx) {
    const MC = need("AtriumMCAD", "formats/mcad.js"), record = a.record !== false && (a.kind === "baseline" || a.kind === "changes");
    const p = record ? ctx.mutable() : ctx.project(), d = ctx.board(p, a.document_id), o = {date: a.date, record, batch: a.batch, pinHoles: a.pin_holes, vias: a.vias};
    if (a.kind === "idf") {
      const r = need("AtriumIDF", "formats/mcad-idf.js").write(p, d, o), f = a.index === 1 ? r.emp : r.emn;
      return [{name: f.name, kind: "idf", files: 2, stats: r.stats, recorded: false}, f.text];
    }
    const I = need("AtriumIDX", "formats/mcad-idx.js"), r = a.kind === "changes" ? I.changes(p, d, o) : a.kind === "response" ? I.response(p, d, o) : I.baseline(p, d, o);
    if (record) ctx.touched();
    return [{name: r.name, kind: a.kind || "baseline", stats: r.stats, problems: r.problems, recorded: record, baseline: MC.peek(d)?.baseline ? {sequence: MC.peek(d).baseline.seq} : null}, r.text];
  }
  const OPS = {mcad_status: status, mcad_import: importChanges, mcad_export: exportFile};
  return Object.freeze({headless: (op, a, ctx, body) => (OPS[op] || fail("Unknown MCAD operation " + op + "."))(a || {}, ctx, body)});
})();
