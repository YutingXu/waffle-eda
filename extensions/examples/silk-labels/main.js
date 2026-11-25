// Silkscreen Label Generator: an edit made as a reviewed proposal.
// Permissions: read:project, propose:edits (never write:edits) and ui:command.
//
// api.transaction() collects the operations; with propose:edits the editor shows them in its
// review dialog, applies the ones the user keeps as ONE undo step, and refuses the whole change
// if anything it touches changed meanwhile. Generated labels carry groupId "silk-labels:<part id>",
// so a second run replaces them and Remove finds them.
const TAG = "silk-labels:";
const FIELD = /\{\s*(ref|value|footprint|param)(?::([^{}]+))?\s*\}/gi;

exports.activate = function (api) {
  function textFor(template, part, def) {
    let filled = 0;
    const params = {};
    for (const src of [def && def.parameters, part.parameters]) if (src) for (const [k, v] of Object.entries(src)) params[k.trim().toUpperCase()] = String(v ?? "");
    const text = template.replace(FIELD, (m, f, arg) => {
      const fp = def && def.footprint && typeof def.footprint === "object" ? def.footprint.name : "";
      const v = f.toLowerCase() === "ref" ? part.ref : f.toLowerCase() === "value" ? part.value : f.toLowerCase() === "footprint" ? fp : params[String(arg || "").trim().toUpperCase()];
      if (v) filled++;
      return v || "";
    }).replace(/\s+/g, " ").trim();
    return filled || !/\{\s*(ref|value|footprint|param)\b/i.test(template) ? text : "";
  }

  async function generate(options = {}) {
    const doc = await api.documents.active();
    if (doc.kind !== "pcb") throw Error("Open a board layout to place silkscreen labels.");
    const s = {...(await api.settings.get()), ...options};
    let template = String(s.template || "{value}");
    if (s.ask !== false && !options.template) {
      const typed = await api.ui.showInputBox({title: "Silkscreen labels", prompt: "Text for each label: {ref}, {value}, {footprint}, {param:Name}", value: template});
      if (typed == null) return {placed: 0, cancelled: true};
      template = typed;
    }
    const size = Number(s.size) > 0 ? Number(s.size) : 0.8, gap = Number(s.gap) >= 0 ? Number(s.gap) : 0.4;
    const selected = new Set(await api.selection.get());
    const parts = (await api.items.list({doc: doc.id, kind: "part", fields: ["id", "ref", "value", "def", "parameters", "x", "y", "layer", "side"]}))
      .filter(p => !selected.size || selected.has(p.id));
    const old = (await api.items.list({doc: doc.id, kind: "label", fields: ["id", "groupId"]})).filter(l => String(l.groupId || "").startsWith(TAG));
    const defs = new Map();
    const labels = [];
    for (const p of parts) {
      if (!defs.has(p.def)) defs.set(p.def, await api.defs.get(p.def));
      const text = textFor(template, p, defs.get(p.def));
      if (!text) continue;
      // Below the lowest pad edge, centred on the part.
      const pins = await api.parts.pins(p.id);
      const bottom = pins.length ? Math.max(...pins.map(q => q.y + (q.h || 0) / 2)) : p.y;
      const back = p.layer === "Bottom" || p.side === "bottom";
      labels.push({part: p, label: {kind: "label", text, x: p.x, y: Math.round((bottom + gap + size) * 1e4) / 1e4, size,
        layer: back ? "Bottom silk" : "Silk", justify: "bottom-center", ...(back ? {mirrored: true} : {}), groupId: TAG + p.id}});
    }
    const replaced = old.filter(l => labels.some(x => l.groupId === TAG + x.part.id)).map(l => l.id);
    if (!labels.length && !replaced.length) { await api.ui.showMessage("No labels to place: the template filled nothing."); return {placed: 0, removed: 0}; }
    const r = await api.transaction("Silkscreen labels (" + labels.length + ")", tx => {
      if (replaced.length) tx.remove(replaced);
      for (const {label} of labels) tx.add(label, {doc: doc.id});
    });
    return {placed: r.declined ? 0 : labels.length, removed: r.declined ? 0 : replaced.length, applied: r.applied || 0, declined: !!r.declined};
  }

  async function remove() {
    const doc = await api.documents.active();
    const ids = (await api.items.list({doc: doc.id, kind: "label", fields: ["id", "groupId"]})).filter(l => String(l.groupId || "").startsWith(TAG)).map(l => l.id);
    if (!ids.length) { await api.ui.showMessage("There are no generated silkscreen labels."); return {removed: 0}; }
    const r = await api.transaction("Remove silkscreen labels", tx => tx.remove(ids));
    return {removed: r.declined ? 0 : ids.length, declined: !!r.declined};
  }

  api.commands.register("silkLabels.generate", generate);
  api.commands.register("silkLabels.remove", remove);
};

exports.deactivate = function () {};
