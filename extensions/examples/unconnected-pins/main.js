// Unconnected Pins: a command that works on the selection (its `when` is "selection") and
// shows its results in a declarative panel. Read-only: read:project, ui:command, ui:panel.
//
// A pin is unconnected when it has no net, or (optionally) when its net reaches no other pin.
// Schematic pins get their nets from the sheet's connectivity; board pads from the part's pin nets.
exports.activate = function (api, context) {
  let last = {doc: null, rows: [], parts: 0};

  // How many pins each net reaches on this document.
  async function netPins(doc) {
    const count = new Map(), bump = n => { if (n) count.set(n, (count.get(n) || 0) + 1); };
    if (doc.kind === "pcb") {
      for (const p of await api.items.list({doc: doc.id, kind: "part", fields: ["pinNets"]})) for (const n of Object.values(p.pinNets || {})) bump(n);
      for (const p of await api.items.list({doc: doc.id, kind: "pad", fields: ["net"]})) bump(p.net);
      return {count, netOf: (part, pin) => pin.net || ""};
    }
    const c = await api.query.connectivity({doc: doc.id});
    for (const n of c.nets) count.set(n.name, typeof n.pins === "number" ? n.pins : (n.pins || []).length);
    return {count, netOf: (part, pin) => c.byPin[part.id + "/" + pin.number] || ""};
  }

  async function find() {
    const doc = await api.documents.active();
    const parts = (await api.selection.items({fields: ["id", "kind", "ref", "def"]})).filter(i => i.kind === "part");
    if (!parts.length) {
      await api.ui.showMessage("Select one or more components first.");
      return {parts: 0, unconnected: []};
    }
    const {singlePinNets} = await api.settings.get();
    const nets = await netPins(doc), rows = [];
    for (const part of parts) {
      const def = await api.defs.get(part.def);
      // Pins the library marks hidden or no-connect are expected to be unconnected.
      const quiet = new Set(((doc.kind === "pcb" ? def?.footprint?.pads : def?.symbol?.pins) || []).filter(p => p.hidden || p.noConnect).map(p => String(p.number)));
      for (const pin of await api.parts.pins(part.id)) {
        if (quiet.has(String(pin.number))) continue;
        const net = nets.netOf(part, pin);
        const reason = !net ? "No net" : singlePinNets !== false && (nets.count.get(net) || 0) <= 1 ? "Only pin on " + net : null;
        if (reason) rows.push({part: part.ref, partId: part.id, pin: String(pin.number), name: pin.name || "", reason});
      }
    }
    rows.sort((a, b) => a.part.localeCompare(b.part, undefined, {numeric: true}) || a.pin.localeCompare(b.pin, undefined, {numeric: true}));
    last = {doc: doc.name, rows, parts: parts.length};
    await render();
    await api.ui.showPanel("unconnectedPins");
    return {parts: parts.length, unconnected: rows.map(r => r.part + "." + r.pin)};
  }

  async function render() {
    if (!last.doc) {
      await api.ui.setPanel("unconnectedPins", {type: "text", text: "Select components and run Tools › Find Unconnected Pins on Selected Part.", muted: true});
      return;
    }
    await api.ui.setPanel("unconnectedPins", [
      {type: "kv", rows: [["Document", last.doc], ["Parts checked", last.parts], ["Unconnected pins", last.rows.length]]},
      last.rows.length
        ? {type: "table", rowCommand: "unconnectedPins.locate",
          columns: [{key: "part", title: "Part"}, {key: "pin", title: "Pin", align: "right"}, {key: "name", title: "Name"}, {key: "reason", title: "Why"}],
          rows: last.rows}
        : {type: "text", text: "Every pin of the selection is connected.", level: "info"},
      {type: "buttons", items: [{label: "Check selection again", command: "unconnectedPins.find"}]}
    ]);
  }

  api.commands.register("unconnectedPins.find", find);
  // Row commands receive the row; select the part it belongs to.
  api.commands.register("unconnectedPins.locate", row => api.selection.set([row.partId]));
  context.subscriptions.push(api.events.on("panelShown", e => { if (e.id === "unconnectedPins") render(); }));
};

exports.deactivate = function () {};
