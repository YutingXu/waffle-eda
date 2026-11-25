// Select all 0402 parts (or any footprint size) on the active document.
// Matches the footprint name of each part's library definition, e.g. "R_0402", "C_0402_1005Metric".
// args (optional): {size: "0402"}   — any text, matched case-insensitively
const size = String(args?.size || "0402");
const doc = await api.documents.active();
const defs = new Map((await api.defs.list()).map(d => [d.id, d]));
const parts = await api.items.list({doc: doc.id, kind: "part", fields: ["id", "ref", "def"]});
const hits = parts.filter(p => String(defs.get(p.def)?.footprint || "").toLowerCase().includes(size.toLowerCase()));
// Selecting is a UI action: the console may, a headless run (MCP run_script) has no selection to set.
try { await api.selection.set(hits.map(p => p.id)); } catch (e) { console.warn("Not selected here: " + e.message); }
console.log(hits.length + " parts with " + size + " footprints: " + hits.map(p => p.ref).join(", "));
return hits.map(p => p.ref);
