// Widen power and ground tracks to a minimum width, as one undo step.
// args (optional): {width: 0.5, nets: "^(GND|VDD|VCC|VIN|\\+?\\d+V\\d*)$"}
const width = Number(args?.width) > 0 ? Number(args.width) : 0.5;
const pattern = new RegExp(args?.nets || "^(A|D|P)?GND|^V(CC|DD|IN|BAT|BUS)|^\\+?\\d+V\\d*$", "i");
const doc = await api.documents.active();
if (doc.kind !== "pcb") return "Open a board layout first.";
const narrow = (await api.items.list({doc: doc.id, kind: "track", fields: ["id", "net", "width"]})).filter(t => t.net && pattern.test(t.net) && t.width < width);
if (!narrow.length) return "Every power track is at least " + width + " mm.";
const r = await api.transaction("Widen power tracks to " + width + " mm", tx => narrow.forEach(t => tx.update(t.id, {width})));
console.log("Widened " + narrow.length + " tracks on " + [...new Set(narrow.map(t => t.net))].join(", "));
return {widened: narrow.length, applied: r.applied};
