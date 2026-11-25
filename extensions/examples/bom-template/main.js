// BOM Template Export: an output contribution. It reads the parts (read:project), groups them
// into BOM lines, fills the columns from a user template and saves the result through the
// system save dialog (outputs:write). It never changes the design.
//
// Template: "Title={field}, Title={field} …". A cell may mix text and fields: "{value} ({param:Tolerance})".
// Fields: qty, refs, value, footprint, name, category, prefix, param:<Name> (case-insensitive).

const FIELD = /\{\s*([a-z]+)(?::([^{}]+))?\s*\}/gi;

// Split on commas that are not inside {braces}.
function parseTemplate(text) {
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of String(text || "")) {
    if (ch === "{") depth++;
    if (ch === "}") depth = Math.max(0, depth - 1);
    if (ch === "," && !depth) { parts.push(cur); cur = ""; } else cur += ch;
  }
  parts.push(cur);
  const columns = parts.map(p => p.trim()).filter(Boolean).map(p => {
    const eq = p.indexOf("="), brace = p.indexOf("{");
    if (eq > 0 && (brace < 0 || eq < brace)) return {title: p.slice(0, eq).trim(), cell: p.slice(eq + 1).trim()};
    return {title: p.replace(FIELD, (m, f, arg) => arg || f).trim(), cell: p};
  });
  if (!columns.length) throw Error("The column template is empty.");
  return columns;
}

const naturalRef = (a, b) => a.localeCompare(b, undefined, {numeric: true});
const paramsOf = (part, def) => {
  const out = {};
  for (const src of [def && def.parameters, part.parameters]) if (src && typeof src === "object")
    for (const [k, v] of Object.entries(src)) if (v != null && typeof v !== "object") out[k.trim().toUpperCase()] = String(v).trim();
  return out;
};

function field(line, name, arg) {
  switch (name.toLowerCase()) {
    case "qty": return String(line.refs.length);
    case "refs": return line.refs.join(", ");
    case "value": return line.value;
    case "footprint": return line.footprint;
    case "name": return line.name;
    case "category": return line.category;
    case "prefix": return line.prefix;
    case "param": return line.params[String(arg || "").trim().toUpperCase()] || "";
    default: throw Error("Unknown BOM field {" + name + "}.");
  }
}
const fill = (line, cell) => cell.replace(FIELD, (m, name, arg) => field(line, name, arg));

async function collect(api, source) {
  const docs = await api.documents.list(), active = await api.documents.active();
  const kind = source === "auto" ? (active.kind === "pcb" || active.kind === "schematic" ? active.kind : "schematic") : source;
  const chosen = kind === active.kind ? [active] : docs.filter(d => d.kind === kind);
  if (!chosen.length) throw Error("This project has no " + (kind === "pcb" ? "board layout" : "schematic") + ".");
  const defs = new Map();
  for (const d of await api.defs.list({fields: ["id", "name", "category", "prefix", "footprint", "parameters"]})) defs.set(d.id, d);
  const parts = [];
  // A schematic BOM spans every sheet; a board BOM is the active (or first) board.
  for (const d of kind === "pcb" ? chosen.slice(0, 1) : chosen)
    parts.push(...await api.items.list({doc: d.id, kind: "part", fields: ["id", "ref", "value", "def", "parameters"]}));
  return {kind, parts, defs};
}

function lines({parts, defs}, groupBy) {
  const keys = String(groupBy || "value, footprint").split(",").map(k => k.trim()).filter(Boolean);
  const out = new Map();
  for (const p of parts) {
    const def = defs.get(p.def) || {};
    const fp = def.footprint && typeof def.footprint === "object" ? def.footprint.name : def.footprint;
    const base = {value: String(p.value || ""), footprint: String(fp || ""), name: String(def.name || ""), category: String(def.category || ""),
      prefix: String((p.ref || "").match(/^[A-Za-z]+/)?.[0] || def.prefix || ""), params: paramsOf(p, def), refs: []};
    const key = keys.map(k => { const [f, arg] = k.split(":"); return field(base, f, arg); }).join("\u0000");
    if (!out.has(key)) out.set(key, base);
    out.get(key).refs.push(String(p.ref || "?"));
  }
  const list = [...out.values()];
  for (const l of list) l.refs.sort(naturalRef);
  return list.sort((a, b) => a.prefix.localeCompare(b.prefix) || naturalRef(a.refs[0], b.refs[0]));
}

// Markdown: escape the characters that would break a table cell.
const md = s => String(s).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
// CSV: quote when needed, and keep spreadsheets from evaluating text as a formula.
const csv = s => {
  let v = String(s);
  if (/^[=+\-@\t\r]/.test(v) && !/^[+-]?\d+(\.\d+)?$/.test(v)) v = "'" + v;
  return /[",\r\n]|^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
};

function render(format, columns, rows, title) {
  if (format === "csv") return [columns.map(c => csv(c.title)), ...rows.map(r => r.map(csv))].map(r => r.join(",")).join("\r\n") + "\r\n";
  return ["# " + md(title), "", "| " + columns.map(c => md(c.title)).join(" | ") + " |", "|" + columns.map(() => " --- |").join(""),
    ...rows.map(r => "| " + r.map(md).join(" | ") + " |"), ""].join("\n");
}

exports.activate = function (api) {
  // `options` lets scripts and tests override the settings: {template, groupBy, source, save:false}.
  async function exportAs(format, options = {}) {
    const s = {...(await api.settings.get()), ...(options || {})};
    const columns = parseTemplate(s.template);
    const data = await collect(api, s.source || "auto");
    const bom = lines(data, s.groupBy);
    const rows = bom.map(line => columns.map(c => fill(line, c.cell)));
    const info = await api.project.info();
    const text = render(format, columns, rows, info.name + " · Bill of Materials (" + (data.kind === "pcb" ? "board" : "schematic") + ")");
    const name = info.name.replace(/[\\/:*?"<>|]/g, "-") + " BOM." + (format === "csv" ? "csv" : "md");
    if (options.save !== false) await api.files.export(name, text);
    return {name, lines: bom.length, parts: data.parts.length, text};
  }
  api.commands.register("bomTemplate.markdown", o => exportAs("markdown", o));
  api.commands.register("bomTemplate.csv", o => exportAs("csv", o));
};

exports.deactivate = function () {};
