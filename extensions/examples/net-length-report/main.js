// Net Length Report: a declarative panel. The extension never touches the DOM; it
// sends a view description and the editor renders it in the right dock.
exports.activate = function (api, context) {
  let timer = null, last = [];

  async function lengths(doc) {
    // Prefer the editor's length engine (counts via barrels when the stackup is known).
    if ((await api.features()).includes("length")) {
      return (await api.length({doc: doc.id})).filter(e => e.length > 0).map(e => ({net: e.net, length: e.length, tracks: e.tracks ?? e.segmentCount ?? 0, vias: e.vias ?? 0}));
    }
    const out = new Map(), entry = n => out.get(n) || out.set(n, {net: n, length: 0, tracks: 0, vias: 0}).get(n);
    for (const t of await api.items.list({doc: doc.id, kind: "track", fields: ["net", "points"]})) if (t.net) { const e = entry(t.net); e.length += api.geometry.length(t.points); e.tracks++; }
    for (const v of await api.items.list({doc: doc.id, kind: "via", fields: ["net"]})) if (v.net) entry(v.net).vias++;
    return [...out.values()];
  }

  async function render() {
    const doc = await api.documents.active();
    if (doc.kind !== "pcb") {
      await api.ui.setPanel("netLengths", {type: "text", text: "Open a PCB layout to see routed net lengths.", muted: true});
      return;
    }
    const unit = await api.units.get(), fmt = mm => api.units.format(mm, unit, unit === "mil" ? 1 : 3);
    last = (await lengths(doc)).sort((a, b) => b.length - a.length || a.net.localeCompare(b.net));
    const total = last.reduce((n, r) => n + r.length, 0);
    await api.ui.setPanel("netLengths", [
      {type: "kv", rows: [["Board", doc.name], ["Routed nets", last.length], ["Total length", fmt(total)]]},
      last.length
        ? {type: "table", rowCommand: "netLengths.select",
          columns: [{key: "net", title: "Net"}, {key: "len", title: "Length", align: "right"}, {key: "tracks", title: "Tracks", align: "right"}, {key: "vias", title: "Vias", align: "right"}],
          rows: last.map(r => ({net: r.net, len: fmt(r.length), tracks: r.tracks, vias: r.vias}))}
        : {type: "text", text: "No routed nets yet.", muted: true},
      {type: "buttons", items: [{label: "Refresh", command: "netLengths.refresh"}, {label: "Export CSV", command: "netLengths.export"}]}
    ]);
  }
  const soon = () => { clearTimeout(timer); timer = setTimeout(() => render().catch(e => console.error(e)), 250); };

  api.commands.register("netLengths.show", async () => { await api.ui.showPanel("netLengths"); await render(); });
  api.commands.register("netLengths.refresh", render);
  api.commands.register("netLengths.select", async row => {
    const ids = (await api.nets.items(row.net, {fields: ["id"]})).map(i => i.id);
    await api.selection.set(ids);
    await api.ui.showMessage(row.net + " · " + ids.length + " objects selected");
  });
  api.commands.register("netLengths.export", async () => {
    if (!last.length) await render();
    const csv = ["Net,Length (mm),Tracks,Vias", ...last.map(r => [JSON.stringify(r.net), r.length.toFixed(4), r.tracks, r.vias].join(","))].join("\n");
    await api.files.export("net-lengths.csv", csv);
  });
  // Events arrive only because this extension subscribed; other extensions pay nothing.
  context.subscriptions.push(
    api.events.on("documentChanged", soon),
    api.events.on("activeDocumentChanged", soon),
    api.events.on("panelShown", e => { if (e.id === "netLengths") render(); })
  );
};

exports.deactivate = function () {};
