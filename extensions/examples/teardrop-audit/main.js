// Teardrop Audit: a read-only design check that reports to the Messages panel.
// Permissions: read:project (the board) and ui:command (the command and the report).
//
// Teardrops in Waffle are filled graphics tagged {teardrop: true, teardropTrack, teardropAnchor}
// (Tools › Teardrops). An anchor is a via id, a free pad id, or "<part id>:<pad number>".
exports.activate = function (api) {
  const near = (a, b, r) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= r + 1e-6;

  async function anchors(doc, o) {
    const out = [];
    if (o.vias) for (const v of await api.items.list({doc: doc.id, kind: "via", fields: ["id", "x", "y", "diameter", "net"]}))
      out.push({id: v.id, at: [v.x, v.y], size: v.diameter || 0, net: v.net || "", what: "via"});
    if (o.pads) {
      for (const p of await api.items.list({doc: doc.id, kind: "pad", fields: ["id", "x", "y", "w", "h", "drill", "net", "number"]}))
        if (!(p.drill >= Math.min(p.w, p.h))) out.push({id: p.id, at: [p.x, p.y], size: Math.min(p.w, p.h), net: p.net || "", what: "pad"});
      for (const part of await api.items.list({doc: doc.id, kind: "part", fields: ["id", "ref"]}))
        for (const pin of await api.parts.pins(part.id))
          out.push({id: part.id + ":" + pin.number, owner: part.id, at: [pin.x, pin.y], size: Math.min(pin.w || 0, pin.h || 0), net: pin.net || "", what: part.ref + "." + pin.number});
    }
    return out.filter(a => a.size > 0);
  }

  async function audit() {
    const doc = await api.documents.active();
    if (doc.kind !== "pcb") throw Error("Open a board layout to audit teardrops.");
    const o = await api.settings.get(), ratio = Number(o.ratio) > 0 ? Number(o.ratio) : 1.2;
    const tracks = (await api.items.list({doc: doc.id, kind: "track", fields: ["id", "points", "width", "net", "layer", "teardrop"]})).filter(t => !t.teardrop);
    const drops = (await api.items.list({doc: doc.id, kind: "graphic", fields: ["id", "teardrop", "groupId", "teardropTrack", "teardropAnchor", "layer"]}))
      .filter(g => g.teardrop === true || String(g.groupId || "").startsWith("teardrop:"));
    const lands = await anchors(doc, o);
    const have = new Set(drops.map(d => d.teardropTrack + "|" + d.teardropAnchor)), byId = new Set(tracks.map(t => t.id)), landIds = new Set(lands.map(a => a.id));
    const rows = [];
    let ends = 0;
    for (const t of tracks) {
      for (const end of [t.points[0], t.points[t.points.length - 1]]) {
        const land = lands.find(a => a.net === (t.net || "") && near(end, a.at, a.size / 2) && a.size >= t.width * ratio);
        if (!land) continue;
        ends++;
        if (!have.has(t.id + "|" + land.id))
          rows.push({class: "Warning", text: "No teardrop where the " + (t.net || "unnamed") + " track meets " + land.what + " on " + t.layer + ".", objectId: t.id, point: end});
      }
    }
    for (const d of drops) if (!byId.has(d.teardropTrack) || !landIds.has(d.teardropAnchor) && o.pads && o.vias)
      rows.push({class: "Warning", text: "Teardrop left behind: its " + (byId.has(d.teardropTrack) ? "pad or via" : "track") + " no longer exists.", objectId: d.id});
    const summary = rows.length ? rows.length + " teardrop issue" + (rows.length === 1 ? "" : "s") + " on " + doc.name : "Teardrops complete on " + doc.name + " (" + ends + " track ends checked)";
    // `messages` puts the rows in the Messages panel, under this extension's name.
    await api.ui.showMessage(summary, {level: rows.length ? "warn" : "info", messages: [...rows, {class: "Info", text: summary + "."}]});
    return {ends, missing: rows.filter(r => /^No teardrop/.test(r.text)).length, stale: rows.filter(r => /left behind/.test(r.text)).length};
  }

  api.commands.register("teardropAudit.run", audit);
};

exports.deactivate = function () {};
