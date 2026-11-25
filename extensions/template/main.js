// __NAME__ (__ID__): a Waffle extension. It runs in its own sandboxed worker and reaches
// the editor only through `api` (AtriumAPI v1), within the permissions in waffle-extension.json.
// API reference: docs/extension-api.md in the Waffle repository.
exports.activate = function (api, context) {
  async function show() {
    const doc = await api.documents.active();
    const counts = {};
    for (const item of await api.items.list({doc: doc.id, fields: ["kind"]})) counts[item.kind] = (counts[item.kind] || 0) + 1;
    const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({kind, count}));
    // Panels are data: the editor renders them, so the extension never touches the DOM.
    await api.ui.setPanel("__PREFIX__", [
      {type: "heading", text: doc.name},
      rows.length
        ? {type: "table", columns: [{key: "kind", title: "Kind"}, {key: "count", title: "Objects", align: "right"}], rows}
        : {type: "text", text: "This document is empty.", muted: true},
      {type: "buttons", items: [{label: "Refresh", command: "__PREFIX__.show"}]}
    ]);
    await api.ui.showPanel("__PREFIX__");
    return counts;
  }
  api.commands.register("__PREFIX__.show", show);
  // Re-render when the user edits; subscriptions are disposed when the extension stops.
  context.subscriptions.push(api.events.on("documentChanged", () => show().catch(e => console.error(e.message))));
};

exports.deactivate = function () {};
