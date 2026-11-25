// AI Assistant: the tools the model may call. Each one maps onto AtriumAPI v1 and, where
// the MCP server (mcp/server.py, mcp/automation.py) has the same tool, uses its name and
// arguments. Reads return compact JSON. Edits never apply here: they become proposals the
// user opens with "Review proposal", which goes through the editor's guarded review dialog.
"use strict";

const STR = {type: "string", maxLength: 512};
const DOC = {type: "string", maxLength: 256, description: "Document ID. Defaults to the active document (PCB tools: the active or first PCB)."};
const OFFSET = {type: "integer", minimum: 0, description: "Page offset (default 0)."};
const LIMIT = {type: "integer", minimum: 1, maximum: 200, description: "Page size (default 50)."};
const IDS = {type: "array", items: {type: "string", maxLength: 256}, minItems: 1, maxItems: 500};
const obj = (properties, required = []) => ({type: "object", properties, required, additionalProperties: false});
const EDIT_FIELDS = ["angle", "ref", "value", "x", "y"];
const MAX_RESULT = 24000;

const DEFS = [
  // ------------------------------------------------------------- reads
  ["project_summary", "Inspect the open project: name, units, documents with IDs and object counts, active document, library size and selection count.", obj({}), "read"],
  ["list_components", "Read a page of components (parts) with stable IDs, designators, values, positions in mm, rotation and footprint.", obj({document_id: DOC, query: {...STR, description: "Filter by designator or value."}, offset: OFFSET, limit: LIMIT}), "read"],
  ["inspect_component", "Inspect one placed component with its library definition and its pins or pads (positions in mm and nets).", obj({component_id: STR}, ["component_id"]), "read"],
  ["list_nets", "List the nets of a document: PCB nets with object counts, or compiled schematic nets with their pins.", obj({document_id: DOC, offset: OFFSET, limit: LIMIT}), "read"],
  ["inspect_net", "List the objects on one net (tracks, vias, pads, wires, labels).", obj({net: STR, document_id: DOC, limit: LIMIT}, ["net"]), "read"],
  ["list_objects", "Find objects by kind, layer, net or area. Kinds: part, wire, track, graphic, label, netlabel, junction, via, pad.", obj({document_id: DOC,
    kinds: {type: "array", items: {enum: ["part", "wire", "track", "graphic", "label", "netlabel", "junction", "via", "pad"]}, minItems: 1, maxItems: 9},
    layer: STR, net: STR, bounds: {type: "array", items: {type: "number"}, minItems: 4, maxItems: 4, description: "[x0, y0, x1, y1] in mm."}, offset: OFFSET, limit: LIMIT}), "read"],
  ["list_library", "Search symbol and footprint definitions in the project library.", obj({query: STR, offset: OFFSET, limit: LIMIT}), "read"],
  ["get_selection", "Read the objects the user has selected in the active document.", obj({}), "read"],
  ["run_drc", "Run the design rule check on a PCB. Violations list rule, object IDs, actual and required values and locations in mm. Filter by rule type, name or ID.",
    obj({document_id: DOC, rules: {type: "array", items: STR, minItems: 1, maxItems: 100}, max_per_rule: {type: "integer", minimum: 1, maximum: 1000}, offset: OFFSET, limit: LIMIT}), "read"],
  ["run_erc", "Compile the schematics and run the electrical rules check. Messages are grouped by class (Fatal, Error, Warning, Info).",
    obj({classes: {type: "array", items: {enum: ["Fatal", "Error", "Warning", "Info"]}, minItems: 1, uniqueItems: true}, limit: {type: "integer", minimum: 0, maximum: 500, description: "Messages listed per class (default 50)."}}), "read"],
  ["list_rules", "Read the effective design rules of a PCB (board rules, else project rules, else defaults). Lengths in mm.", obj({document_id: DOC}), "read"],
  ["net_lengths", "Routed length per net in mm, as Length DRC and the Length Manager measure it: pad to pad for two-pad nets, else the total copper; via barrels between the copper layers they connect; die (pin package) length.", obj({document_id: DOC, nets: {type: "array", items: STR, minItems: 1, maxItems: 500}, offset: OFFSET, limit: LIMIT}), "read"],
  ["stackup_get", "Read a board's layer stack: layers top to bottom, thickness and drill pairs.", obj({document_id: DOC}), "read"],
  ["generate_bom", "Build the bill of materials and return its columns, line and part counts and the first rows. Nothing is saved.", obj({preview: {type: "integer", minimum: 0, maximum: 200, description: "Rows to include (default 50)."}}), "read"],
  ["generate_fabrication", "Build the fabrication outputs (Gerber, drill, pick and place) in memory and report the files and warnings. Nothing is saved; the user saves them from Fabrication Outputs.", obj({document_id: DOC}), "read"],
  ["select_objects", "Select and show objects in the editor so the user can see them. This changes only the selection, not the design.", obj({ids: IDS}, ["ids"]), "view"],
  // ------------------------------------------------------------- proposals
  ["propose_component_edits", "Propose component value, designator, position (mm) or rotation (degrees) changes. Nothing changes until the user reviews and applies the proposal.",
    obj({changes: {type: "array", minItems: 1, maxItems: 100, items: obj({component_id: STR, field: {enum: EDIT_FIELDS}, value: {type: ["string", "number"]}}, ["component_id", "field", "value"])},
      summary: {...STR, description: "One line describing the change for the reviewer."}}, ["changes"]), "propose"],
  ["propose_edits", "Propose general object edits: update fields, move by dx/dy mm, remove, or add objects. Each object is validated with the editor's model rules. Nothing changes until the user reviews and applies the proposal.",
    obj({summary: STR, operations: {type: "array", minItems: 1, maxItems: 200, items: obj({
      action: {enum: ["update", "move", "remove", "add"]}, id: {...STR, description: "Object ID (update, move, remove)."},
      set: {type: "object", description: "Fields to set (update). null deletes a field; id and kind never change."},
      dx: {type: "number"}, dy: {type: "number"}, document_id: DOC, object: {type: "object", description: "The new object (add), with kind and its fields."}
    }, ["action"])}}, ["operations"]), "propose"],
  ["annotate", "Number schematic designators. mode plan (default) lists the changes; mode proposal queues them for the user to review.",
    obj({order: {enum: ["up-across", "down-across", "across-up", "across-down"]}, action: {enum: ["update", "annotate", "reset-all", "reset-duplicates"]}, mode: {enum: ["plan", "proposal"]}}), "propose"],
  ["pour_polygons", "Queue a repour of the board's polygon pours for the user to review.", obj({document_id: DOC}), "propose"],
  ["autoroute", "Queue an autoroute of the board's unrouted connections for the user to review.", obj({document_id: DOC}), "propose"],
  ["fanout", "Queue a fanout of surface-mount pads to vias for the user to review.", obj({document_id: DOC}), "propose"],
  ["propose_placement", "Place footprints inside the board outline (connectivity clusters, connectors on edges, decoupling caps by IC power pins, rooms, keep-outs, DFA spacing) and queue the best of several scored alternatives for the user to review. Returns each alternative's score (airwire length, DFA violations, density). scope unplaced (default) places only parts outside the board; selected uses component_ids; all moves every unlocked part.",
    obj({document_id: DOC, strategy: {enum: ["balanced", "compact", "clustered", "spread"]}, seed: {type: "integer", minimum: 1, maximum: 1000000},
      scope: {enum: ["unplaced", "selected", "all"]}, component_ids: IDS, alternative: {type: "integer", minimum: 0, maximum: 3, description: "Which scored alternative to queue (default 0, the best)."},
      constraints: {type: "object", description: "grid, spacing, margin (mm), rotate, region [x0,y0,x1,y1], keepouts [[x0,y0,x1,y1]], edges {ref: left|right|top|bottom}, place {ref: {x,y,angle}}, groups [[ref,...]], rip_up."}}), "propose"],
  ["propose_routing", "Route the unrouted connections in priority order (power, differential pairs, critical, the rest) with fanout for BGAs, and queue the result for the user to review. Returns routed and unrouted connections with reasons.",
    obj({document_id: DOC, nets: {type: "array", items: STR, minItems: 1, maxItems: 2000}, classes: {type: "array", items: STR, minItems: 1, maxItems: 100},
      strategy: {enum: ["default2", "multi", "orthogonal", "dense", "single"]}, time_limit_ms: {type: "integer", minimum: 500, maximum: 120000}}), "propose"],
  ["propose_planes", "Suggest ground and supply planes or pours per copper layer from the layer stack and each net's current (IPC-2152 track width), and queue the pours for the user to review.",
    obj({document_id: DOC, stackup: {type: "object", description: "Per-layer override {LAYER: NET or \"signal\"}."}, currents: {type: "object", description: "Amps per net {NET: A}."}}), "propose"]
];
const TOOLS = DEFS.map(([name, description, parameters, kind]) => ({name, description, parameters, kind}));
const byName = new Map(TOOLS.map(t => [t.name, t]));

// ------------------------------------------------------------------ validation
// The subset of JSON Schema the tool definitions use. Unknown or mistyped arguments are refused.
function validate(schema, v, at = "input") {
  const type = schema.type, types = Array.isArray(type) ? type : type ? [type] : null;
  const is = t => t === "integer" ? Number.isInteger(v) : t === "number" ? typeof v === "number" && Number.isFinite(v) : t === "array" ? Array.isArray(v)
    : t === "object" ? v !== null && typeof v === "object" && !Array.isArray(v) : t === "null" ? v === null : typeof v === t;
  if (schema.enum && !schema.enum.includes(v)) throw Error(at + " must be one of " + schema.enum.join(", ") + ".");
  if (types && !types.some(is)) throw Error(at + " must be " + types.join(" or ") + ".");
  if (typeof v === "string" && schema.maxLength && v.length > schema.maxLength) throw Error(at + " is too long.");
  if (typeof v === "number") {
    if (schema.minimum != null && v < schema.minimum) throw Error(at + " must be at least " + schema.minimum + ".");
    if (schema.maximum != null && v > schema.maximum) throw Error(at + " must be at most " + schema.maximum + ".");
  }
  if (Array.isArray(v)) {
    if (schema.minItems && v.length < schema.minItems) throw Error(at + " needs at least " + schema.minItems + " item(s).");
    if (schema.maxItems && v.length > schema.maxItems) throw Error(at + " allows at most " + schema.maxItems + " items.");
    if (schema.uniqueItems && new Set(v.map(x => JSON.stringify(x))).size !== v.length) throw Error(at + " has repeated items.");
    if (schema.items) v.forEach((x, i) => validate(schema.items, x, at + "[" + i + "]"));
  }
  if (is("object") && schema.properties) {
    for (const k of schema.required || []) if (!(k in v)) throw Error(at + "." + k + " is required.");
    for (const [k, x] of Object.entries(v)) {
      if (!(k in schema.properties)) { if (schema.additionalProperties === false) throw Error(at + " has an unknown field " + k + "."); continue; }
      validate(schema.properties[k], x, at + "." + k);
    }
  }
  return v;
}

// ------------------------------------------------------------------ helpers
const page = (list, a, size = 50) => {
  const offset = a.offset || 0, limit = a.limit || size, end = offset + limit;
  return {items: list.slice(offset, end), total: list.length, next_offset: end < list.length ? end : null};
};
const round = v => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v);
const roundAll = o => JSON.parse(JSON.stringify(o, (k, v) => round(v)));
function encode(data) {
  let text = JSON.stringify(roundAll(data));
  if (text.length > MAX_RESULT) text = text.slice(0, MAX_RESULT) + " …[truncated: request a smaller page with offset/limit]";
  return text;
}
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
async function pcbDoc(api, id) {
  if (id) return id;
  const docs = await api.documents.list(), active = await api.documents.active();
  if (active.kind === "pcb") return active.id;
  const pcb = docs.find(d => d.kind === "pcb");
  if (!pcb) throw Error("This project has no PCB layout.");
  return pcb.id;
}
const PART_FIELDS = ["id", "ref", "value", "x", "y", "angle", "layer", "def", "link"];
const OBJ_FIELDS = ["id", "kind", "ref", "value", "net", "layer", "x", "y", "angle", "width", "text", "points", "diameter", "drill", "def"];

// ------------------------------------------------------------------ execution
// ctx: {proposals: Map, nextId(), describe?(id)}. Returns {data, summary, proposal?, locate?}.
async function execute(api, name, input, ctx) {
  const tool = byName.get(name);
  if (!tool) throw Error("Unknown tool " + name + ".");
  const a = validate(tool.parameters, input || {});
  switch (name) {
    case "project_summary": {
      const info = await api.project.info(), sel = await api.selection.get();
      return {summary: "Read the project summary", data: {...info, selectionCount: sel.length}};
    }
    case "list_components": {
      const docs = await api.documents.list(), list = [];
      const defs = new Map((await api.defs.list()).map(d => [d.id, d]));
      for (const d of a.document_id ? docs.filter(x => x.id === a.document_id) : docs) {
        for (const p of await api.items.list({doc: d.id, kind: "part", fields: PART_FIELDS})) {
          const q = (a.query || "").toLowerCase();
          if (q && !((p.ref || "") + " " + (p.value || "")).toLowerCase().includes(q)) continue;
          const def = defs.get(p.def);
          list.push({...p, document: d.id, documentKind: d.kind, part: def?.name, footprint: def?.footprint || undefined});
        }
      }
      if (a.document_id && !docs.some(d => d.id === a.document_id)) throw Error("Unknown document " + a.document_id + ".");
      const r = page(list, a);
      return {summary: "Listed " + plural(r.total, "component"), data: r};
    }
    case "inspect_component": {
      const item = await api.items.get(a.component_id);
      if (!item || item.kind !== "part") throw Error("No component has the ID " + a.component_id + ".");
      const def = item.def ? await api.defs.get(item.def) : null, pins = await api.parts.pins(item.id);
      return {summary: "Inspected " + (item.ref || item.id), locate: item.id, data: {component: item,
        definition: def && {id: def.id, name: def.name, prefix: def.prefix, value: def.value, category: def.category, footprint: def.footprint?.name, description: def.description},
        pins: pins.slice(0, 400)}};
    }
    case "list_nets": {
      const nets = await api.nets.list({doc: a.document_id});
      const r = page(nets, a);
      return {summary: "Listed " + plural(r.total, "net"), data: r};
    }
    case "inspect_net": {
      const items = await api.nets.items(a.net, {doc: a.document_id, fields: OBJ_FIELDS});
      return {summary: "Inspected net " + a.net + " (" + plural(items.length, "object") + ")", data: page(items, a, 100)};
    }
    case "list_objects": {
      const filter = {doc: a.document_id, fields: OBJ_FIELDS};
      if (a.kinds) filter.kinds = a.kinds;
      if (a.layer) filter.layer = a.layer;
      if (a.net) filter.net = a.net;
      const r = await api.items.page({...filter, bounds: a.bounds, offset: a.offset || 0, limit: a.limit || 50});
      return {summary: "Found " + plural(r.total, "object"), data: r};
    }
    case "list_library": {
      const q = (a.query || "").toLowerCase(), defs = (await api.defs.list()).filter(d => !q || (d.name + " " + (d.value || "") + " " + (d.category || "")).toLowerCase().includes(q));
      const r = page(defs, a);
      return {summary: "Searched the library: " + r.total + (r.total === 1 ? " match" : " matches"), data: r};
    }
    case "get_selection": {
      const items = await api.selection.items({fields: OBJ_FIELDS});
      return {summary: "Read the selection (" + plural(items.length, "object") + ")", data: {count: items.length, items: items.slice(0, 200)}};
    }
    case "run_drc": {
      const doc = await pcbDoc(api, a.document_id), r = await api.drc({doc});
      let v = r.violations || [];
      if (a.rules) { const keys = a.rules.map(x => String(x).toLowerCase()); v = v.filter(x => [x.type, x.ruleName, x.ruleId].some(k => keys.includes(String(k).toLowerCase()))); }
      if (a.max_per_rule) { const n = new Map(); v = v.filter(x => { const c = (n.get(x.ruleId) || 0) + 1; n.set(x.ruleId, c); return c <= a.max_per_rule; }); }
      const p = page(v, a);
      const failed = (r.rules || []).filter(x => x.count > 0);
      return {summary: "Ran DRC: " + plural(v.length, "violation"), drc: v.slice(0, 20), data: {document: doc, total: v.length, rules: failed, violations: p.items, next_offset: p.next_offset}};
    }
    case "run_erc": {
      const r = await api.erc({}), per = a.limit ?? 50, classes = a.classes || ["Fatal", "Error", "Warning", "Info"], out = {};
      for (const c of classes) out[c] = (r.messages || []).filter(m => m.class === c).slice(0, per).map(m => ({check: m.check, text: m.text, document: m.document, id: m.id || m.object, at: m.at || m.location}));
      const n = r.counts || {};
      const passed = !(n.Fatal || n.Error);
      return {summary: "Ran ERC: " + plural(n.Error || 0, "error") + ", " + plural(n.Warning || 0, "warning"), data: {passed, counts: n, summary: r.summary, classes: out}};
    }
    case "list_rules": return {summary: "Read the design rules", data: await api.rules.get({doc: a.document_id})};
    case "net_lengths": {
      const doc = await pcbDoc(api, a.document_id), rows = await api.length({doc, nets: a.nets});
      return {summary: "Measured " + plural(Array.isArray(rows) ? rows.length : 0, "net") + " lengths", data: Array.isArray(rows) ? page(rows, a) : rows};
    }
    case "stackup_get": {
      const doc = await pcbDoc(api, a.document_id);
      return {summary: "Read the layer stack", data: (await api.stackup({doc})) ?? {note: "The board has no stored stack; it uses the default two-layer stack."}};
    }
    case "generate_bom": {
      const r = await api.bom({}), n = a.preview ?? 50;
      return {summary: "Built the BOM: " + plural(r.lineCount ?? (r.rows || []).length, "line") + ", " + plural(r.totalParts ?? 0, "part"),
        data: {title: r.title, source: r.source, totalParts: r.totalParts, lineCount: r.lineCount, excluded: r.excluded, columns: (r.columns || []).map(c => c.key), rows: (r.rows || []).slice(0, n)}};
    }
    case "generate_fabrication": {
      const doc = await pcbDoc(api, a.document_id), r = await api.outputs.build({doc});
      const files = (r.files || []).map(f => ({name: f.name, kind: f.kind, title: f.title, bytes: typeof f.content === "string" ? f.content.length : f.content?.byteLength ?? 0}));
      return {summary: "Built " + plural(files.length, "fabrication file"), data: {name: r.name, warnings: r.warnings, files, note: "Not saved. The user saves outputs from File › Fabrication Outputs."}};
    }
    case "select_objects": {
      await api.selection.set(a.ids);
      if (a.ids.length) await api.ui.locate(a.ids[0]);
      return {summary: "Selected " + plural(a.ids.length, "object"), data: {selected: a.ids.length}};
    }
    // ------------------------------------------------------------- proposals
    case "propose_component_edits": {
      const ops = [];
      for (const c of a.changes) {
        const item = await api.items.get(c.component_id);
        if (!item || item.kind !== "part") throw Error("No component has the ID " + c.component_id + ".");
        const geometry = ["x", "y", "angle"].includes(c.field);
        if (geometry && typeof c.value !== "number") throw Error(c.field + " must be a number (mm or degrees).");
        if (!geometry && typeof c.value !== "string") throw Error(c.field + " must be text.");
        if (c.field === "ref" && !c.value.trim()) throw Error("A designator cannot be empty.");
        ops.push({op: geometry ? "transform" : "update", id: item.id, set: {[c.field]: c.value}});
      }
      const label = a.summary || "AI: edit " + plural(ops.length, "component field");
      return queued(ctx, label, await api.proposals.draft("transaction", {label, ops}));
    }
    case "propose_edits": {
      const ops = [];
      for (const o of a.operations) {
        if (o.action === "add") { ops.push({op: "add", doc: o.document_id || null, item: o.object}); continue; }
        if (!o.id) throw Error(o.action + " needs an object ID.");
        let action = o.action;
        if (action === "update" && o.set && Object.keys(o.set).every(k => ["x", "y", "angle"].includes(k)) &&
            (await api.items.get(o.id, {fields:["kind"]}))?.kind === "part") action = "transform";
        ops.push({op: action, id: o.id, ...(action === "move" ? {dx:o.dx, dy:o.dy} : o.set ? {set:o.set} : {})});
      }
      const label = a.summary || "AI: " + plural(ops.length, "edit");
      return queued(ctx, label, await api.proposals.draft("transaction", {label, ops}));
    }
    case "annotate": {
      const options = {}; if (a.order) options.order = a.order; if (a.action) options.action = a.action;
      if (a.mode === "proposal") {
        const draft = await api.proposals.draft("annotate.apply", options);
        return queued(ctx, "AI: annotate designators", draft, {changes: draft.annotation || [], total: draft.report?.schematic || 0});
      }
      const plan = await api.annotate(options), changed = (plan.rows || []).filter(r => r.changed);
      const data = {changes: changed.slice(0, 200).map(r => ({id: r.id, sheet: r.sheetName, current: r.current, proposed: r.proposed})), total: changed.length};
      return {summary: "Planned annotation: " + plural(changed.length, "change"), data};
    }
    case "pour_polygons": case "autoroute": case "fanout": case "propose_placement": case "propose_routing": case "propose_planes": {
      const [method, nameText] = {pour_polygons:["pour","repour polygons"], autoroute:["route","autoroute"], fanout:["fanout","fanout"],
        propose_placement:["autoplace","auto place"], propose_routing:["routePlan","route plan"], propose_planes:["planes","power planes"]}[name];
      const args = {doc: await pcbDoc(api, a.document_id)};
      for (const [k, v] of Object.entries(a)) if (k !== "document_id") args[k === "component_ids" ? "components" : k] = v;
      const draft = await api.proposals.draft(method, args);
      return queued(ctx, "AI: " + nameText, draft, {preview: draft.report});
    }
  }
  throw Error("Unknown tool " + name + ".");
}
function queued(ctx, title, draft, extra = {}) {
  if (draft.stale || draft.revoked || draft.cancelled) throw Error("The design or permission changed while planning. Request a fresh draft.");
  if (!draft.handle) return {summary: title + ": no changes", data: {...extra, changes: [], total: 0}};
  const id = ctx.nextId(), rows = draft.changes.map(r => r.label.replace(" · ", " ") + (r.detail ? ": " + r.detail : ""));
  ctx.proposals.set(id, {id, title, rows, handle: draft.handle, status: "pending"});
  return {summary: "Proposed: " + title.replace(/^AI: /, "") + " (" + plural(draft.total, "change") + ")", proposal: id,
    data: {...extra, proposal: id, status: "waiting for the user's review", changes: rows, total: draft.total,
      note: "Nothing has changed yet. The user reviews this proposal in Waffle and may apply all, some or none of it."}};
}

async function review(api, proposal) {
  const r = await api.proposals.review(proposal.handle);
  if (r.stale) return {status: "stale", message: "The design changed or this draft expired. Ask for a fresh proposal."};
  if (r.blocked) return {status: "blocked", message: "The design is read-only or a collaborator holds a required lock."};
  if (r.revoked) return {status: "revoked"};
  if (r.cancelled) return {status: "cancelled"};
  return r.declined ? {status: "discarded"} : {status: r.applied ? "applied" : "nothing to change", applied: r.applied || 0};
}

module.exports = {TOOLS, validate, execute, review, EDIT_FIELDS};
