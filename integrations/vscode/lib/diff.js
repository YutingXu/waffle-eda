"use strict";
// The VS Code extension's change summary, computed by Waffle's design-diff engine (app/diff.js,
// AtriumDiff): the same engine as the editor's Compare Revisions and Review Changes, the MCP tool
// diff_designs and bin/waffle-diff. The engine is bundled into media/app/ with the viewer
// (scripts/bundle-viewer.py); in a source checkout it is read from ../../../app/.
//
//   report(before, after, {title, from, to})  -> Markdown from AtriumDiff.toMarkdown (the command's output)
//   summarize(before, after)                  -> {documents: [...], library: {...}, totals, projectFields, identical}
//   format(summary, {title})                  -> Markdown of that per-document summary (bin/waffle-summary.js)
//   engine()                                  -> AtriumDiff
//
// summarize() keeps its per-document shape (parts, nets by membership REF.pin, other objects) for
// existing callers; the matching, tolerant field comparison and net membership come from the engine.
(function (factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else globalThis.AtriumVSCodeDiff = api;
})(function () {
  const PART_FIELDS = ["ref", "value", "def", "x", "y", "angle", "layer", "mirrored", "locked", "pinNets", "dnp", "parameters"];
  const EMPTY = {format: "atrium", version: 1, name: "(none)", documents: [], library: []};
  const list = v => (Array.isArray(v) ? v : []);
  const byId = arr => { const m = new Map(); for (const x of list(arr)) if (x && typeof x.id === "string") m.set(x.id, x); return m; };
  const round = v => (typeof v === "number" ? Math.round(v * 1e4) / 1e4 : v);
  const show = v => { if (v === undefined) return "(none)"; const s = typeof v === "string" ? v : JSON.stringify(round(v)); return s.length > 60 ? s.slice(0, 57) + "…" : s; };

  // ---------------------------------------------------------------- the engine
  // waivers.js: the engine lists waivers (added, removed, changed, stale) in their own category.
  // net-intent.js + signals.js: signals and tags (format 1.4) compare as models, as in the app.
  const GLOBALS = {"core/model.js": "Atrium", "schematic/sch-objects.js": "AtriumSchObjects", "project/hierarchy.js": "AtriumHierarchy", "checks/waivers.js": "AtriumWaivers",
    "checks/net-intent.js": "AtriumNetIntent", "core/signals.js": "AtriumSignals", "library/component-match.js": "AtriumComponentMatch", "history/diff.js": "AtriumDiff"};
  function engine() {
    if (globalThis.AtriumDiff && typeof globalThis.AtriumDiff.compare === "function") return globalThis.AtriumDiff;
    const path = require("path"), fs = require("fs");
    for (const dir of [path.join(__dirname, "..", "media", "app"), path.join(__dirname, "..", "..", "..", "app")]) {
      if (!fs.existsSync(path.join(dir, "history/diff.js"))) continue;
      // A bundle made before waivers.js joined it still loads (waiver changes then show as raw fields).
      for (const [file, name] of Object.entries(GLOBALS)) if (!globalThis[name] && fs.existsSync(path.join(dir, file))) require(path.join(dir, file));
      if (globalThis.AtriumDiff) return globalThis.AtriumDiff;
    }
    throw Error("Waffle's diff engine (diff.js) is not bundled. Run scripts/bundle-viewer.py.");
  }
  const compare = (before, after, opts) => engine().compare(before || EMPTY, after || EMPTY, {validate: false, ...opts});

  function report(before, after, opts = {}) {
    const E = engine();
    return E.toMarkdown(compare(before, after), {title: opts.title || "Waffle changes", from: opts.from, to: opts.to, limit: opts.limit ?? 300});
  }

  // ---------------------------------------------------------------- per-document summary
  function summarize(before, after) {
    const E = engine(), r = compare(before, after, {schematicNets: "pinNets", geometry: false}), M = r.matching;
    const docsA = byId(before?.documents), docsB = byId(after?.documents);
    const backDoc = new Map([...M.docs].map(([a, b]) => [b, a]));
    const pinsOf = (rec, docId) => new Set((rec || []).filter(p => p.doc === docId).map(p => p.label));
    function netsOf(da, db) {
      const doc = db || da, out = {added: [], removed: [], changed: []};
      for (const e of Object.values(r.byNet)) {
        const rec = doc.kind === "pcb" ? e.boards[db?.id] || e.boards[da?.id] : e.schematic;
        if (!rec || !rec.before) continue;
        const pa = da ? pinsOf(rec.before, da.id) : new Set(), pb = db ? pinsOf(rec.after, db.id) : new Set();
        const copper = rec.copper || [0, 0];
        if (!pa.size && !pb.size) continue;
        if (!pa.size) { out.added.push({name: e.name, pins: [...pb].sort()}); continue; }
        if (!pb.size) { out.removed.push({name: e.name, pins: [...pa].sort()}); continue; }
        const gained = [...pb].filter(p => !pa.has(p)).sort(), lost = [...pa].filter(p => !pb.has(p)).sort();
        if (gained.length || lost.length || copper[0] !== copper[1]) out.changed.push({name: e.name, gained, lost, copper});
      }
      return out;
    }
    function documentDiff(da, db) {
      const parts = {added: [], removed: [], changed: []}, objects = {};
      const tally = (kind, key) => { (objects[kind] ??= {added: 0, removed: 0, changed: 0})[key]++; };
      const itemsA = byId(da?.items), idsB = new Set(list(db?.items).map(i => i.id));
      for (const b of list(db?.items)) {
        const idA = M.back.get(b.id), a = idA != null ? itemsA.get(idA) || null : null;
        if (b.kind === "part") {
          if (!a) parts.added.push({id: b.id, ref: b.ref, value: b.value, def: b.def});
          else {
            const diff = E.fieldDiff(a, b, {});
            const fields = PART_FIELDS.filter(f => diff.includes(f)).map(f => ({field: f, before: a[f], after: b[f]}));
            const other = diff.filter(f => !PART_FIELDS.includes(f));
            if (fields.length || other.length) parts.changed.push({id: b.id, ref: b.ref, before: a.ref, fields, other});
          }
        } else if (!a) tally(b.kind, "added");
        else if (E.fieldDiff(a, b, {}).length) tally(b.kind, "changed");
      }
      for (const a of list(da?.items)) if (!M.items.has(a.id) || !idsB.has(M.items.get(a.id).id)) {
        if (a.kind === "part") parts.removed.push({id: a.id, ref: a.ref, value: a.value, def: a.def}); else tally(a.kind, "removed");
      }
      const nets = netsOf(da, db);
      const sortRef = (x, y) => String(x.ref ?? x.name).localeCompare(String(y.ref ?? y.name), undefined, {numeric: true});
      for (const k of ["added", "removed", "changed"]) { parts[k].sort(sortRef); nets[k].sort(sortRef); }
      const settings = ["name", "kind", "grid", "outline", "rules", "origin"].filter(k => !E.same(da?.[k], db?.[k]));
      return {parts, nets, objects, settings};
    }
    const documents = [];
    for (const [id, b] of docsB) {
      const a = docsA.get(backDoc.get(id)) || null;
      documents.push({id, name: b.name, kind: b.kind, status: a ? "changed" : "added", ...documentDiff(a, b)});
    }
    for (const [id, a] of docsA) if (!M.docs.has(id)) documents.push({id, name: a.name, kind: a.kind, status: "removed", ...documentDiff(a, null)});
    const library = {added: [], removed: [], changed: []};
    const defsA = byId(before?.library), defsB = byId(after?.library), seen = new Set();
    for (const [ida, m] of M.defs) {
      const a = defsA.get(ida), b = defsB.get(m.id); seen.add(m.id);
      if (a && b && !E.same(a, b)) library.changed.push({id: b.id, name: b.name});
    }
    for (const [id, b] of defsB) if (!seen.has(id)) library.added.push({id, name: b.name});
    for (const [id, a] of defsA) if (!M.defs.has(id)) library.removed.push({id, name: a.name});
    const sum = f => documents.reduce((n, d) => n + f(d), 0);
    const totals = {
      parts: {added: sum(d => d.parts.added.length), removed: sum(d => d.parts.removed.length), changed: sum(d => d.parts.changed.length)},
      nets: {added: sum(d => d.nets.added.length), removed: sum(d => d.nets.removed.length), changed: sum(d => d.nets.changed.length)},
      library: {added: library.added.length, removed: library.removed.length, changed: library.changed.length}
    };
    // Waivers (project.waivers, doc.drcWaivers, project.insights dismissals): the engine's own waiver changes, with notes.
    const waiverStores = globalThis.AtriumWaivers ? ["waivers", "insights"] : [];
    const waivers = r.changes.filter(c => c.category === "waivers").map(c => ({kind: c.kind.replace(/^waiver\./, ""), text: c.text, document: c.target.docName || null}));
    const projectFields = Object.keys({...(before || {}), ...(after || {})}).filter(k => !["documents", "library", ...waiverStores].includes(k) && !E.same(before?.[k], after?.[k]));
    totals.waivers = {added: waivers.filter(w => w.kind === "added").length, removed: waivers.filter(w => w.kind === "removed").length, changed: waivers.filter(w => w.kind === "changed").length, stale: waivers.filter(w => w.kind === "stale").length};
    return {documents, library, waivers, totals, projectFields, identical: r.summary.identical && !projectFields.length && !waivers.length, engine: {summary: r.summary, stats: r.stats}};
  }

  // ---------------------------------------------------------------- Markdown of the summary
  // Design-derived text (designators, values, net names) is escaped so it renders as text.
  // Escaping [ ] < > is enough to stop links, images and HTML; the rest stops emphasis and tables.
  const esc = s => String(s ?? "").replace(/[\\`*_[\]<>|~]/g, c => "\\" + c).replace(/\s+/g, " ");
  const count = (n, word) => n + " " + word + (n === 1 ? "" : "s");
  // Only the pins whose net changed: "pin 2 VIN → VIN2".
  function pinBits(a, b) {
    a = a && typeof a === "object" ? a : {}; b = b && typeof b === "object" ? b : {};
    const pins = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => a[k] !== b[k]).sort((x, y) => x.localeCompare(y, undefined, {numeric: true}));
    return pins.map(k => "pin " + esc(k) + " " + esc(a[k] ?? "(none)") + " → " + esc(b[k] ?? "(none)")).join(", ");
  }
  function format(s, {title = "Waffle changes", limit = 200} = {}) {
    const out = ["# " + esc(title), ""];
    if (s.identical) return out.concat("No design changes.", "").join("\n");
    const t = s.totals;
    out.push("**Parts** +" + t.parts.added + " −" + t.parts.removed + " ~" + t.parts.changed + " · **Nets** +" + t.nets.added + " −" + t.nets.removed + " ~" + t.nets.changed +
      " · **Library** +" + t.library.added + " −" + t.library.removed + " ~" + t.library.changed, "");
    if (s.projectFields.length) out.push("Project settings changed: " + s.projectFields.map(esc).join(", ") + ".", "");
    for (const d of s.documents) {
      const empty = d.status === "changed" && !d.parts.added.length && !d.parts.removed.length && !d.parts.changed.length && !d.nets.added.length &&
        !d.nets.removed.length && !d.nets.changed.length && !Object.keys(d.objects).length && !d.settings.length;
      if (empty) continue;
      out.push("## " + esc(d.name) + " (" + (d.kind === "pcb" ? "board" : d.kind === "schematic" ? "sheet" : d.kind) + (d.status === "changed" ? "" : ", " + d.status) + ")", "");
      if (d.settings.length) out.push("Document settings changed: " + d.settings.map(esc).join(", ") + ".", "");
      const rows = [];
      for (const p of d.parts.added.slice(0, limit)) rows.push("- Added **" + esc(p.ref) + "** " + esc(p.value) + " (" + esc(p.def) + ")");
      for (const p of d.parts.removed.slice(0, limit)) rows.push("- Removed **" + esc(p.ref) + "** " + esc(p.value) + " (" + esc(p.def) + ")");
      for (const p of d.parts.changed.slice(0, limit)) {
        const moved = p.fields.filter(f => ["x", "y", "angle"].includes(f.field)), rest = p.fields.filter(f => !["x", "y", "angle"].includes(f.field));
        const bits = rest.map(f => f.field === "pinNets" ? pinBits(f.before, f.after) : f.field + " " + esc(show(f.before)) + " → " + esc(show(f.after)));
        if (moved.length) bits.push(moved.some(f => f.field === "angle") && moved.length === 1 ? "rotated" : "moved");
        if (p.other.length) bits.push(count(p.other.length, "other field"));
        rows.push("- Changed **" + esc(p.ref) + "**: " + bits.join("; "));
      }
      if (rows.length) out.push("### Parts", "", ...rows, "");
      const nrows = [];
      for (const n of d.nets.added.slice(0, limit)) nrows.push("- Added net **" + esc(n.name) + "**" + (n.pins.length ? ": " + n.pins.map(esc).join(", ") : ""));
      for (const n of d.nets.removed.slice(0, limit)) nrows.push("- Removed net **" + esc(n.name) + "**" + (n.pins.length ? ": " + n.pins.map(esc).join(", ") : ""));
      for (const n of d.nets.changed.slice(0, limit)) {
        const bits = [];
        if (n.gained.length) bits.push("+" + n.gained.map(esc).join(", +"));
        if (n.lost.length) bits.push("−" + n.lost.map(esc).join(", −"));
        if (n.copper[0] !== n.copper[1]) bits.push("copper objects " + n.copper[0] + " → " + n.copper[1]);
        nrows.push("- Changed net **" + esc(n.name) + "**: " + bits.join("; "));
      }
      if (nrows.length) out.push("### Nets", "", ...nrows, "");
      const kinds = Object.entries(d.objects).sort(([a], [b]) => a.localeCompare(b));
      if (kinds.length) out.push("### Other objects", "", ...kinds.map(([k, c]) => "- " + esc(k) + ": +" + c.added + " −" + c.removed + " ~" + c.changed), "");
    }
    const lib = s.library;
    if (lib.added.length || lib.removed.length || lib.changed.length) {
      out.push("## Library", "");
      for (const [key, word] of [["added", "Added"], ["removed", "Removed"], ["changed", "Changed"]])
        for (const x of lib[key].slice(0, limit)) out.push("- " + word + " " + esc(x.name) + " (" + esc(x.id) + ")");
      out.push("");
    }
    if (s.waivers?.length) {
      out.push("## Waivers", "");
      for (const w of s.waivers.slice(0, limit)) out.push("- " + esc(w.text) + (w.document ? " (" + esc(w.document) + ")" : ""));
      out.push("");
    }
    return out.join("\n");
  }
  return {summarize, format, report, engine};
});
