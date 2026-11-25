// Renumber designators by position (Scripting Console, or MCP run_script).
// Reading order: rows by Y, then X within a row, separately for each prefix (R, C, U…).
// Renames the linked part on the other document too (schematic <-> board), so they stay in step.
// args (optional): {tolerance: 1, prefixes: ["R", "C"], start: 1, reverseY: false}
//   tolerance: parts whose Y differs by less than this (mm) share a row; reverseY: rows from the largest Y
const o = {tolerance: 1, start: 1, ...(args || {})};
const doc = await api.documents.active();
const parts = (await api.items.list({doc: doc.id, kind: "part", fields: ["id", "ref", "x", "y", "link"]})).filter(p => /^[A-Za-z]+\d+$/.test(p.ref || ""));
const prefix = p => p.ref.match(/^[A-Za-z]+/)[0];
const groups = {};
for (const p of parts) if (!o.prefixes || o.prefixes.includes(prefix(p))) (groups[prefix(p)] ||= []).push(p);
// Parts linked across documents share `link`; find their counterparts once.
const others = (await api.documents.list()).filter(d => d.id !== doc.id && (d.kind === "pcb" || d.kind === "schematic"));
const linked = new Map();
for (const d of others) for (const q of await api.items.list({doc: d.id, kind: "part", fields: ["id", "link"]})) if (q.link) linked.set(q.link, [...(linked.get(q.link) || []), q.id]);
const renames = [];
for (const [pre, list] of Object.entries(groups)) {
  const dy = (a, b) => (o.reverseY ? b.y - a.y : a.y - b.y);
  list.sort((a, b) => Math.abs(a.y - b.y) > o.tolerance ? dy(a, b) : a.x - b.x);
  list.forEach((p, n) => { const ref = pre + (o.start + n); if (ref !== p.ref) renames.push([p, ref]); });
}
if (!renames.length) return "Already in order.";
// Two passes through temporary names, so R1 <-> R2 swaps never collide.
await api.transaction("Renumber by position", tx => {
  for (const [p] of renames) for (const id of [p.id, ...(linked.get(p.link) || [])]) tx.update(id, {ref: "__tmp_" + p.id});
  for (const [p, ref] of renames) for (const id of [p.id, ...(linked.get(p.link) || [])]) tx.update(id, {ref});
});
console.log(renames.map(([p, ref]) => p.ref + " → " + ref).join(", "));
return renames.length + " designators renumbered";
