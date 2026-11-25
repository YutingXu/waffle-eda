// Export routed net lengths as CSV (save dialog in the console; logged when run headless).
// Length is the sum of track segments per net; vias are counted. Uses the editor's length engine
// (which adds via barrels when the stackup is known) when it is available.
// args (optional): {nets: ["USB_P", "USB_N"], file: "net-lengths.csv"}
const doc = await api.documents.active();
if (doc.kind !== "pcb") return "Open a board layout first.";
const want = args?.nets ? new Set(args.nets) : null;
const rows = new Map(), row = n => rows.get(n) || rows.set(n, {net: n, length: 0, tracks: 0, vias: 0}).get(n);
for (const t of await api.items.list({doc: doc.id, kind: "track", fields: ["net", "points"]})) if (t.net) { const r = row(t.net); r.length += api.geometry.length(t.points); r.tracks++; }
for (const v of await api.items.list({doc: doc.id, kind: "via", fields: ["net"]})) if (v.net) row(v.net).vias++;
const list = [...rows.values()].filter(r => !want || want.has(r.net)).sort((a, b) => b.length - a.length);
const csv = ["Net,Length (mm),Tracks,Vias", ...list.map(r => [JSON.stringify(r.net), r.length.toFixed(3), r.tracks, r.vias].join(","))].join("\n") + "\n";
// The console saves through the save dialog; a headless run (MCP run_script) has no files.export, so log the CSV instead.
try { await api.files.export(args?.file || "net-lengths.csv", csv); } catch (e) { console.log(csv); }
console.log(list.length + " nets, longest " + (list[0] ? list[0].net + " " + list[0].length.toFixed(2) + " mm" : "none"));
return list.map(r => ({net: r.net, length: Math.round(r.length * 1000) / 1000, tracks: r.tracks, vias: r.vias}));
