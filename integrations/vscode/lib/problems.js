"use strict";
// DRC and ERC results from the Waffle MCP server / CLI (run_drc, run_erc) turned into
// located problems for VS Code's Problems panel. Pure JS.
//
//   fromDrc(result, text) -> [{start, end, message, severity, code, source, at}]
//   fromErc(result, text) -> same
//
// Each result names the object it is about by id; the problem is placed on that object's
// "id" in the native member text. Findings without an object fall back to the owning document.
(function (factory) {
  const api = factory(typeof require === "function" ? require("./jsonpos.js") : globalThis.AtriumJsonPos);
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.AtriumProblems = api;
})(function (J) {
  const num = v => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 1e4) / 1e4) : null);
  const where = at => (Array.isArray(at) && at.length === 2 && num(at[0]) != null ? " at (" + num(at[0]) + ", " + num(at[1]) + ") mm" : "");
  // Design text inside messages is untrusted: keep it to one line and a sane length.
  const clean = s => String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").slice(0, 400);
  function locator(text) {
    const index = new Map();
    let offset = 0;
    for (const row of (text || "").split("\n")) {
      const {root} = J.parse(row);
      const id = root && J.at(root, ["id"]);
      if (id?.type === "string") index.set(id.value,{start:offset + id.start,end:offset + id.end});
      offset += row.length + 1;
    }
    return (...ids) => {
      for (const id of ids) { const node = typeof id === "string" && index.get(id); if (node) return [node.start, node.end]; }
      return [0, 1];
    };
  }
  function fromDrc(result, text) {
    const locate = locator(text), out = [];
    for (const v of result?.items || []) {
      const values = [num(v.actual) != null ? "actual " + num(v.actual) + " mm" : "", num(v.required) != null ? "required " + (v.limit === "max" ? "≤ " : "≥ ") + num(v.required) + " mm" : ""].filter(Boolean);
      const [start, end] = locate(v.id, v.other_id, result.document_id);
      out.push({start, end, severity: v.type === "unrouted" ? "warning" : "error", source: "Waffle DRC", code: clean(v.rule || v.type),
        message: clean(v.title || v.type) + (v.detail ? " — " + clean(v.detail) : "") + (values.length ? " (" + values.join(", ") + ")" : "") + where(v.at), at: v.at});
    }
    return out;
  }
  const ERC_SEVERITY = {Fatal: "error", Error: "error", Warning: "warning", Info: "information"};
  function fromErc(result, text) {
    const locate = locator(text), out = [];
    for (const [cls, group] of Object.entries(result?.classes || {}))
      for (const m of group?.items || []) {
        const [start, end] = locate(m.object_id, m.document_id);
        out.push({start, end, severity: ERC_SEVERITY[cls] || "warning", source: "Waffle ERC", code: clean(m.check), message: clean(m.text) + where(m.at), at: m.at});
      }
    return out;
  }
  return {fromDrc, fromErc};
});
