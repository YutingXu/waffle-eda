"use strict";
const preview = require("./thumbnail.js");
exports.activate = api => {
  let byId = new Map();
  api.commands.register("footprints.browse", async event => {
    if (event.type === "open") {
      const defs = (await api.defs.list()).filter(d => d.footprint).slice(0, 30);
      const rows = await Promise.all(defs.map(async (d, index) => {
        const full = await api.defs.get(d.id), pads = full.footprint.pads || [];
        return {id: "fp-" + index, label: d.footprint, detail: d.name, accessory: pads.length + (pads.length === 1 ? " pad" : " pads"), thumbnail: preview(pads, d.footprint)};
      }));
      byId = new Map(rows.map((row, i) => [row.id, {row, definition: defs[i]}]));
      return {kind: "grid", title: "Project footprints", items: rows, text: rows.length ? "" : "This project has no footprints."};
    }
    const selected = byId.get(event.itemId);
    if (!selected) return;
    const {row, definition} = selected;
    if (event.actionId !== "place") return {kind: "detail", title: row.label, text: row.detail + " · " + row.accessory,
      blocks: [{kind: "image", image: row.thumbnail}], primary: {id: "place", label: "Place footprint"}};
    const doc = await api.documents.active();
    if (doc.kind !== "pcb" || doc.id !== event.documentId || !event.point) throw Error("Open the footprint browser on the destination board.");
    const parts = await api.items.list({doc: doc.id, kind: "part", fields: ["ref"]});
    const used = new Set(parts.map(p => p.ref)); let n = 1;
    const prefix = definition.prefix || "U"; while (used.has(prefix + n)) n++;
    const result = await api.transaction("Place " + row.label, tx => tx.add({kind: "part", def: definition.id, ref: prefix + n,
      value: definition.value || "", x: event.point[0], y: event.point[1], angle: 0, side: "top", pinNets: {}}, {doc: doc.id}));
    return {kind: "detail", title: row.label, text: result.declined ? "Placement cancelled." : "Placed " + prefix + n + "."};
  });
};
