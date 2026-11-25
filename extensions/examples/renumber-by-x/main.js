// Renumber by X Position: a write command that runs in the extension worker.
// Everything it changes goes through one transaction, so Undo restores it in one step.
exports.activate = function (api) {
  api.commands.register("renumber.byX", async () => {
    const settings = await api.settings.get();
    const sign = settings.direction === "right-to-left" ? -1 : 1, tolerance = Number(settings.rowTolerance) || 0;
    const active = await api.documents.active();
    const selection = new Set(await api.selection.get());
    const fields = ["id", "ref", "x", "y", "link", "designatorLocked"];
    let parts = await api.items.list({doc: active.id, kind: "part", fields});
    if (selection.size) parts = parts.filter(p => selection.has(p.id));
    parts = parts.filter(p => !p.designatorLocked && /^[A-Za-z_]+\d+$/.test(p.ref));
    if (!parts.length) { await api.ui.showMessage("No numbered components to renumber."); return {changed: 0}; }

    const groups = new Map();
    for (const p of parts) {
      const prefix = p.ref.match(/^[A-Za-z_]+/)[0];
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix).push(p);
    }
    const order = (a, b) => Math.abs(a.x - b.x) <= tolerance ? a.y - b.y : sign * (a.x - b.x);
    const next = new Map(); // part id -> new designator
    for (const [prefix, list] of groups) {
      // With a selection, reuse the selected parts' own numbers so nothing collides.
      const numbers = selection.size ? list.map(p => Number(p.ref.slice(prefix.length))).sort((a, b) => a - b) : list.map((_, n) => n + 1);
      list.sort(order).forEach((p, n) => next.set(p.id, prefix + numbers[n]));
    }

    // Keep linked schematic/board counterparts in step.
    const docs = await api.documents.list();
    const byLink = new Map(parts.filter(p => p.link).map(p => [p.link, next.get(p.id)]));
    const linked = [];
    for (const d of docs) {
      if (d.id === active.id || !byLink.size) continue;
      for (const p of await api.items.list({doc: d.id, kind: "part", fields: ["id", "ref", "link"]})) {
        if (p.link && byLink.has(p.link) && p.ref !== byLink.get(p.link)) linked.push([p.id, byLink.get(p.link)]);
      }
    }
    const changes = parts.filter(p => p.ref !== next.get(p.id)).map(p => [p.id, next.get(p.id)]).concat(linked);
    if (!changes.length) { await api.ui.showMessage("Designators already follow X order."); return {changed: 0}; }
    await api.transaction("Renumber by X position", tx => { for (const [id, ref] of changes) tx.update(id, {ref}); });
    await api.ui.showMessage(changes.length + " designator" + (changes.length === 1 ? "" : "s") + " renumbered");
    return {changed: changes.length};
  });
};
