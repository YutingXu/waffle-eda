// Snap the selected components (or every component) to the document grid, as one undo step.
// args (optional): {grid: 0.25}   — mm; defaults to the document's grid
const doc = await api.documents.active();
const grid = Number(args?.grid) > 0 ? Number(args.grid) : doc.grid;
const selected = new Set(await api.selection.get());
const parts = (await api.items.list({doc: doc.id, kind: "part", fields: ["id", "ref", "x", "y"]})).filter(p => !selected.size || selected.has(p.id));
const snap = v => Math.round(Math.round(v / grid) * grid * 1e6) / 1e6;
const moves = parts.map(p => [p, snap(p.x) - p.x, snap(p.y) - p.y]).filter(([, dx, dy]) => Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9);
if (!moves.length) return "Already on the " + grid + " mm grid.";
// tx.move keeps wires attached on schematics and pads with their part on boards.
await api.transaction("Snap to " + grid + " mm grid", tx => moves.forEach(([p, dx, dy]) => tx.move(p.id, dx, dy)));
return moves.map(([p]) => p.ref);
