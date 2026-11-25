// Teardrops and via stitching: geometry commands built only on AtriumAPI reads,
// one spatial query per row, and a single transaction each (one undo step).
const EPS = 1e-3;

exports.activate = function (api) {
  const g = api.geometry;

  // Copper landing sites: vias, free pads and component pads (with their nets).
  async function sites(doc) {
    const out = [];
    for (const v of await api.items.list({doc: doc.id, kinds: ["via", "pad"], fields: ["kind", "x", "y", "diameter", "w", "h", "layer", "net"]})) {
      out.push({x: v.x, y: v.y, r: (v.kind === "via" ? v.diameter : Math.min(v.w, v.h)) / 2, layer: v.layer || "Multi", net: v.net || ""});
    }
    const parts = await api.items.list({doc: doc.id, kind: "part", fields: ["id"]});
    // Issued together, these reads travel in one batched message each way.
    const pins = await Promise.all(parts.map(p => api.parts.pins(p.id)));
    for (const list of pins) for (const p of list) if (p.w && p.h) out.push({x: p.x, y: p.y, r: Math.min(p.w, p.h) / 2, layer: p.layer || "Multi", net: p.net || ""});
    return out;
  }

  api.commands.register("teardrops.add", async () => {
    const s = await api.settings.get(), doc = await api.documents.active();
    if (doc.kind !== "pcb") return api.ui.showMessage("Open a PCB layout first.");
    const ratio = Math.max(.2, Number(s.teardropLength) || 1), strands = Math.max(1, Math.min(6, Math.round(Number(s.teardropStrands) || 2)));
    const tracks = await api.items.list({doc: doc.id, kind: "track", fields: ["id", "points", "width", "layer", "net", "teardrop", "teardropFor", "teardropEnd"]});
    const done = new Set(tracks.filter(t => t.teardrop).map(t => t.teardropFor + "/" + t.teardropEnd));
    const pads = await sites(doc);
    const index = new Map();
    for (const p of pads) { const k = Math.round(p.x * 100) + "," + Math.round(p.y * 100); if (!index.has(k)) index.set(k, []); index.get(k).push(p); }
    const at = q => index.get(Math.round(q[0] * 100) + "," + Math.round(q[1] * 100)) || [];
    let added = 0;
    const count = await api.transaction("Add teardrops", tx => {
      for (const t of tracks) {
        if (t.teardrop || t.points.length < 2) continue;
        for (const end of [0, 1]) {
          if (done.has(t.id + "/" + end)) continue;
          const pts = end ? t.points.slice().reverse() : t.points, p0 = pts[0], p1 = pts[1];
          const pad = at(p0).find(p => g.distance(p, [p0[0], p0[1]]) < EPS || (Math.abs(p.x - p0[0]) < EPS && Math.abs(p.y - p0[1]) < EPS));
          if (!pad || (pad.net && t.net && pad.net !== t.net) || (pad.layer !== "Multi" && pad.layer !== t.layer)) continue;
          const w = t.width || .25, seg = g.distance(p0, p1);
          if (pad.r * 2 <= w * 1.2 || seg < EPS) continue;
          const d = [(p1[0] - p0[0]) / seg, (p1[1] - p0[1]) / seg], n = [-d[1], d[0]];
          const reach = Math.min(pad.r * (1 + ratio), seg * .8);
          if (reach <= pad.r + w / 2) continue;
          const neck = [p0[0] + d[0] * reach, p0[1] + d[1] * reach], spread = Math.max(0, pad.r * .9 - w / 2);
          for (let k = 1; k <= strands; k++) for (const side of [1, -1]) {
            const o = spread * k / strands * side;
            tx.add({kind: "track", points: [[p0[0] + n[0] * o, p0[1] + n[1] * o], neck], width: w, layer: t.layer, net: t.net || pad.net,
              teardrop: true, teardropFor: t.id, teardropEnd: end}, {doc: doc.id});
            added++;
          }
        }
      }
      return added;
    });
    await api.ui.showMessage(added ? added + " teardrop segments added" : "No track ends land on a pad or via.");
    return count.result;
  });

  async function removeTagged(tag, label) {
    const doc = await api.documents.active();
    const ids = (await api.items.list({doc: doc.id, where: {[tag]: true}, fields: ["id"]})).map(i => i.id);
    if (!ids.length) return api.ui.showMessage("Nothing to remove.");
    await api.transaction(label, tx => tx.remove(ids));
    await api.ui.showMessage(ids.length + " objects removed");
    return ids.length;
  }
  api.commands.register("teardrops.remove", () => removeTagged("teardrop", "Remove teardrops"));
  api.commands.register("stitching.remove", () => removeTagged("stitching", "Remove stitching vias"));

  api.commands.register("stitching.add", async options => {
    const s = await api.settings.get(), doc = await api.documents.active();
    if (doc.kind !== "pcb") return api.ui.showMessage("Open a PCB layout first.");
    if (!doc.outline || doc.outline.length < 3) return api.ui.showMessage("Set the board perimeter first.");
    let net = options?.net;
    if (!net) {
      const nets = (await api.nets.list()).map(n => n.name);
      const preferred = nets.filter(n => /gnd|ground|vss/i.test(n)), choice = await api.ui.showQuickPick([...preferred, ...nets.filter(n => !preferred.includes(n))].map(n => ({label: n})), {title: "Stitch which net?"});
      net = choice?.label;
      if (!net) return;
    }
    const pitch = Math.max(.5, options?.pitch ?? (Number(s.stitchPitch) || 2.5)), gap = Math.max(0, options?.clearance ?? (Number(s.stitchClearance) || .5));
    const dia = Number(s.stitchDiameter) || .6, drill = Math.min(dia * .9, Number(s.stitchDrill) || .3), r = dia / 2, keep = r + gap;
    const box = g.bounds(doc.outline), edges = doc.outline.map((p, i) => [p, doc.outline[(i + 1) % doc.outline.length]]);
    const placed = [];
    let n = 0;
    await api.transaction("Add stitching vias", async tx => {
      for (let y = box[1] + keep; y <= box[3] - keep + EPS; y += pitch) {
        // One spatial query per row: everything within reach of this row.
        const row = await api.query.spatial([box[0], y - keep - 5, box[2], y + keep + 5], {doc: doc.id, fields: ["id", "kind", "x", "y", "points", "width", "diameter", "w", "h", "net"]});
        // Component pads in reach, fetched together (one batched round trip).
        const pads = (await Promise.all(row.filter(i => i.kind === "part").map(i => api.parts.pins(i.id)))).flat().filter(p => p.w && p.h);
        for (let x = box[0] + keep; x <= box[2] - keep + EPS; x += pitch) {
          const q = [x, y];
          if (!g.pointInPolygon(q, doc.outline) || edges.some(([a, b]) => g.segmentDistance(q, a, b) < keep)) continue;
          const blocked = row.some(i => {
            if (i.kind === "track" || i.kind === "wire" || i.kind === "graphic") return i.points.some((p, k) => k && g.segmentDistance(q, i.points[k - 1], p) < keep + (i.width || 0) / 2);
            if (i.kind === "via") return g.distance(q, [i.x, i.y]) < keep + i.diameter / 2;
            if (i.kind === "pad") return g.distance(q, [i.x, i.y]) < keep + Math.max(i.w, i.h) / 2;
            return false;
          }) || pads.some(p => g.distance(q, [p.x, p.y]) < keep + Math.hypot(p.w, p.h) / 2) || placed.some(p => g.distance(p, q) < pitch * .5);
          if (blocked) continue;
          tx.add({kind: "via", x: +x.toFixed(4), y: +y.toFixed(4), diameter: dia, drill, layer: "Multi", net, stitching: true}, {doc: doc.id});
          placed.push(q); n++;
        }
      }
    });
    await api.ui.showMessage(n + " stitching vias added on " + net);
    return n;
  });
};
