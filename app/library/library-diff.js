"use strict";
// Library update review: what a newer library copy of a component changes, drawn rather than
// listed. Replaces the text list (AtriumLibrary.diffDefs) in "Update from library".
//
// DOM-free core (MCP and tests):
//   compare(a, b)                 -> {fields, params, pins, pads, symbolArt, footprintArt, courtyard, model3d, changed}
//   impact(project, def, next)    -> {designators, lostNets: [{ref, pin, net, doc}], routedPads: [{ref, pad, net}], gates}
//   svg(a, b, "symbol"|"footprint") -> SVG text: the old drawing under the new one. Pins and pads
//                                    that were added are green, removed red, moved or resized amber.
//   applyUpdate(project, def, lib, src, refs?) -> report; refs: only these designators move to the
//                                    library copy (a new definition); the rest keep the project copy
// Dialog:
//   review(ctx, entries, o)       entries: [{def, lib, src}]; Update all / Update selected designators /
//                                 Keep project copy. One undo step, labelled "rev 3 → rev 5".
globalThis.AtriumLibraryDiff = (() => {
  const A = () => globalThis.Atrium, L = () => globalThis.AtriumLibrary;
  const obj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const r3 = v => Math.round(v * 1000) / 1000;
  const MPN = /^(mpn|manufacturer part( number)?|part number|manufacturer|mfr\.?|lcsc ?#?|supplier part( number)?)$/i;
  const stable = v => globalThis.AtriumLibraryStore ? AtriumLibraryStore.canonical(v) : JSON.stringify(v);
  const natural = (a, b) => String(a).localeCompare(String(b), "en", {numeric: true});
  const isCourtyard = s => /courtyard|mechanical ?15|mech15/i.test(String(s.layer || "") + " " + String(s.style || ""));

  // ------------------------------------------------------------------ comparison
  function pinMap(sym) { const m = new Map(); for (const p of sym?.pins || []) m.set(String(p.number) + "|" + (p.part || 0), p); return m; }
  function padMap(fp) { const m = new Map(); for (const p of fp?.pads || []) { const k = String(p.number ?? ""); if (!k || p.thermalVia) continue; if (!m.has(k)) m.set(k, p); } return m; }
  function compare(a, b) {
    const out = {fields: [], params: [], pins: {added: [], removed: [], changed: [], moved: []}, pads: {added: [], removed: [], moved: [], resized: []},
      symbolArt: false, footprintArt: false, courtyard: false, model3d: null, symbol: null, footprint: null, changed: 0};
    for (const k of ["name", "prefix", "value", "category", "description", "state"]) if ((a?.[k] ?? "") !== (b?.[k] ?? "")) out.fields.push({key: k, before: a?.[k] ?? "", after: b?.[k] ?? ""});
    out.fields.push(...L().sourceChanges(a, b));
    const previousPackage = a?.footprint?.name || a?.footprintName, nextPackage = b?.footprint?.name || b?.footprintName;
    if ((previousPackage || "") !== (nextPackage || "")) out.fields.push({key: "Package", before: previousPackage || "", after: nextPackage || ""});
    const pa = obj(a?.parameters) ? a.parameters : {}, pb = obj(b?.parameters) ? b.parameters : {};
    for (const k of [...new Set([...Object.keys(pa), ...Object.keys(pb)])].sort(natural)) if (String(pa[k] ?? "") !== String(pb[k] ?? "")) out.params.push({key: k, before: pa[k] ?? "", after: pb[k] ?? "", sourcing: MPN.test(k.trim())});
    if (!!a?.symbol !== !!b?.symbol) {
      out.symbol = b?.symbol ? "added" : "removed";
      out.pins[out.symbol] = [...pinMap(b?.symbol || a?.symbol).values()];
    }
    if (a?.symbol && b?.symbol) {
      const ma = pinMap(a.symbol), mb = pinMap(b.symbol);
      for (const [k, p] of mb) {
        const q = ma.get(k);
        if (!q) { out.pins.added.push(p); continue; }
        const what = [];
        if ((q.name || "") !== (p.name || "")) what.push("name " + (q.name || "—") + " → " + (p.name || "—"));
        if ((q.electrical ?? 4) !== (p.electrical ?? 4)) what.push("type " + (L()?.ELECTRICAL[q.electrical ?? 4] || q.electrical) + " → " + (L()?.ELECTRICAL[p.electrical ?? 4] || p.electrical));
        if (!!q.hidden !== !!p.hidden) what.push(p.hidden ? "hidden" : "shown");
        if (what.length) out.pins.changed.push({pin: p, before: q, what});
        if (Math.hypot(q.x - p.x, q.y - p.y) > 1e-6) out.pins.moved.push({pin: p, before: q});
      }
      for (const [k, q] of ma) if (!mb.has(k)) out.pins.removed.push(q);
      const art = s => stable((s.shapes || []).filter(x => !x.pinArt && x.style !== "pin"));
      out.symbolArt = art(a.symbol) !== art(b.symbol) || (a.symbol.parts || 1) !== (b.symbol.parts || 1);
    }
    out.pads = L().compareLands(a?.footprint, b?.footprint);
    if (!!a?.footprint !== !!b?.footprint) out.footprint = b?.footprint ? "added" : "removed";
    if (a?.footprint && b?.footprint) {
      const graphics = f => stable((f.shapes || []).filter(s => !isCourtyard(s)));
      out.footprintArt = graphics(a.footprint) !== graphics(b.footprint);
      out.courtyard = stable((a.footprint.shapes || []).filter(isCourtyard)) !== stable((b.footprint.shapes || []).filter(isCourtyard));
    }
    out.model3d = L().modelChange(a, b);
    out.changed = out.fields.length + out.params.length + out.pins.added.length + out.pins.removed.length + out.pins.changed.length + out.pins.moved.length +
      out.pads.added.length + out.pads.removed.length + out.pads.moved.length + out.pads.resized.length + (out.symbolArt ? 1 : 0) + (out.footprintArt ? 1 : 0) +
      (out.courtyard ? 1 : 0) + (out.model3d ? 1 : 0) + (out.symbol ? 1 : 0) + (out.footprint ? 1 : 0);
    return out;
  }

  // ------------------------------------------------------------------ impact on the design
  function impact(project, def, next, comparison) {
    const users = [], designators = new Set(), lostNets = [], routedPads = [], gates = [], joinedNets = [];
    const incoming = {...next, id: def.id}, mirror = project.library.find(x => x.mirrorOf === def.id);
    const pinsChanged = (def.symbol?.parts || 1) !== (next.symbol?.parts || 1) || !!def.symbol?.alternate !== !!next.symbol?.alternate ||
      stable(def.symbol?.pins || []) !== stable(next.symbol?.pins || []);
    const keepPads = padMap(next.footprint);
    const lands = comparison?.pads || L().compareLands(def.footprint, next.footprint);
    const affectedPads = new Set([...lands.moved.map(m => m.before), ...lands.removed].map(p => String(p.number)));
    const parts = Math.max(1, next.symbol?.parts || 1);
    for (const d of project.documents || []) {
      const mine = (d.items || []).filter(i => i.kind === "part" && (i.def === def.id || d.kind === "pcb" && mirror && i.def === mirror.id));
      if (!mine.length) continue;
      for (const i of mine) { users.push({doc: d, item: i}); if (i.ref) designators.add(i.ref); }
      if (d.kind === "schematic" && def.symbol) {
        for (const i of mine) if ((i.unit || i.part || 1) > parts) gates.push(i.ref + String.fromCharCode(64 + (i.unit || i.part)));
        if (pinsChanged) {
          // Only items this operation can mutate need a copy. Preview uses the same electrical
          // update and connectivity as apply, including unit-specific pins and interior contacts.
          const sheet = {...d, items: d.items.map(i => i.kind === "wire" ? {...i} : i.kind === "part" ? {...i, pinNets: {...i.pinNets}} : i)};
          const model = {library: project.library.map(x => x.id === def.id ? incoming : x), documents: [sheet]};
          const result = L().updateParts(model, incoming, {oldDef: def, schematicPreview: true});
          lostNets.push(...result.lostNets); joinedNets.push(...result.joinedNets);
        }
      } else if (d.kind === "pcb") for (const i of mine) for (const [k, net] of Object.entries(i.pinNets || {})) {
        if (!net) continue;
        if (!keepPads.has(k)) lostNets.push({ref: i.ref, pin: k, net, doc: d.name});
        else if (affectedPads.has(k)) routedPads.push({ref: i.ref, pad: k, net});
      }
    }
    const sort = (x, y) => natural(x.ref, y.ref) || natural(x.pin ?? x.pad, y.pin ?? y.pad);
    return {designators: [...designators].sort(natural), parts: users.length, lostNets: lostNets.sort(sort), joinedNets, routedPads: routedPads.sort(sort), gates};
  }

  // ------------------------------------------------------------------ drawings
  const esc = s => String(s).replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
  const f = v => String(r3(v));
  function shapeSVG(s, cls) {
    if (s.kind === "circle") return '<circle class="' + cls + '" cx="' + f(s.x) + '" cy="' + f(s.y) + '" r="' + f(s.r) + '"/>';
    if (s.kind === "path" && s.points?.length > 1) return '<path class="' + cls + '" d="M' + s.points.map(p => f(p[0]) + " " + f(p[1])).join("L") + (s.closed ? "Z" : "") + '"/>';
    return "";
  }
  function padSVG(p, cls, label) {
    const w = p.w || .2, h = p.h || .2, rot = p.angle ? ' transform="rotate(' + f(-p.angle) + " " + f(p.x) + " " + f(p.y) + ')"' : "";
    const round = p.shape === "round" || p.shape === "circle" ? Math.min(w, h) / 2 : p.shape === "roundrect" || p.shape === "oval" || p.shape === "obround" ? Math.min(w, h) / 4 : 0;
    let s = '<rect class="' + cls + '" x="' + f(p.x - w / 2) + '" y="' + f(p.y - h / 2) + '" width="' + f(w) + '" height="' + f(h) + '" rx="' + f(round) + '"' + rot + "/>";
    if (label) s += '<text class="ld-num" x="' + f(p.x) + '" y="' + f(p.y) + '" font-size="' + f(Math.max(.35, Math.min(w, h) * .6)) + '">' + esc(p.number) + "</text>";
    return s;
  }
  const DIRS = {left: [1, 0], right: [-1, 0], up: [0, 1], down: [0, -1]};
  function pinEnd(p) {
    const [dx, dy] = DIRS[p.orientation] || [0, 0], length = p.length || 2.54;
    return [p.x + dx * length, p.y + dy * length];
  }
  function pinSVG(p, cls, label) {
    const [x2, y2] = pinEnd(p);
    let s = '<line class="' + cls + '" x1="' + f(p.x) + '" y1="' + f(p.y) + '" x2="' + f(x2) + '" y2="' + f(y2) + '"/><circle class="' + cls + ' ld-tip" cx="' + f(p.x) + '" cy="' + f(p.y) + '" r=".45"/>';
    if (label) s += '<text class="ld-num" x="' + f((p.x + x2) / 2) + '" y="' + f((p.y + y2) / 2 - .55) + '" font-size="1.1">' + esc(p.number) + "</text>";
    return s;
  }
  function svg(a, b, side, o = {}) {
    const c = o.compare || compare(a, b), body = [], pts = [];
    const extent = g => { for (const s of g?.shapes || []) for (const p of s.points || (s.kind === "circle" ? [[s.x - s.r, s.y - s.r], [s.x + s.r, s.y + s.r]] : s.x != null ? [[s.x, s.y]] : [])) pts.push(p); };
    if (side === "symbol") {
      const sa = a?.symbol, sb = b?.symbol;
      extent(sa); extent(sb);
      for (const p of [...sa?.pins || [], ...sb?.pins || []]) pts.push([p.x, p.y], pinEnd(p));
      for (const s of sa?.shapes || []) if (s.style !== "pin" && !s.pinArt) body.push(shapeSVG(s, "ld-old"));
      for (const s of sb?.shapes || []) if (s.style !== "pin" && !s.pinArt) body.push(shapeSVG(s, "ld-new"));
      const added = new Set(c.pins.added), moved = new Map(c.pins.moved.map(m => [m.pin, m.before])), changed = new Set(c.pins.changed.map(m => m.pin));
      for (const q of c.pins.removed) body.push(pinSVG(q, "ld-del", true));
      for (const [, q] of moved) body.push(pinSVG(q, "ld-was", false));
      for (const p of sb?.pins || []) body.push(pinSVG(p, added.has(p) ? "ld-add" : moved.has(p) || changed.has(p) ? "ld-mod" : "ld-same", added.has(p) || moved.has(p) || changed.has(p)));
    } else {
      const fa = a?.footprint, fb = b?.footprint;
      extent(fa); extent(fb);
      for (const p of [...fa?.pads || [], ...fb?.pads || []]) pts.push([p.x - (p.w || 0) / 2, p.y - (p.h || 0) / 2], [p.x + (p.w || 0) / 2, p.y + (p.h || 0) / 2]);
      for (const s of fa?.shapes || []) if (isCourtyard(s) && c.courtyard) body.push(shapeSVG(s, "ld-old ld-yard"));
      for (const s of fb?.shapes || []) if (isCourtyard(s)) body.push(shapeSVG(s, "ld-new ld-yard"));
      const added = new Set(c.pads.added), moved = new Set(c.pads.moved.map(m => m.pad)), resized = new Set(c.pads.resized.map(m => m.pad));
      for (const q of c.pads.removed) body.push(padSVG(q, "ld-del", true));
      for (const q of new Set([...c.pads.moved, ...c.pads.resized].map(m => m.before))) body.push(padSVG(q, "ld-was", false));
      for (const p of fb?.pads || []) { const k = added.has(p) ? "ld-add" : moved.has(p) || resized.has(p) ? "ld-mod" : "ld-same"; if (p.thermalVia && k === "ld-same") continue; body.push(padSVG(p, k, k !== "ld-same" || (fb.pads.length <= 64))); }
    }
    if (!pts.length) pts.push([-1, -1], [1, 1]);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of pts) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    const margin = 1.5, minSize = side === "symbol" ? 15 : 5;
    const w = Math.max(minSize, maxX - minX + 2 * margin), h = Math.max(minSize, maxY - minY + 2 * margin);
    const x0 = (minX + maxX - w) / 2, y0 = (minY + maxY - h) / 2;
    return '<svg xmlns="http://www.w3.org/2000/svg" class="ld-svg" viewBox="' + [x0, y0, w, h].map(f).join(" ") + '" role="img" aria-label="' + esc(side === "symbol" ? "Symbol: old and new" : "Footprint: old and new pads") + '">' + body.join("") + "</svg>";
  }

  // ------------------------------------------------------------------ apply
  // Update every placed part (refs null) or only the given designators. A partial update adds the
  // library copy as a new definition for those designators and keeps the project copy for the rest.
  function applyUpdate(project, def, lib, src, refs = null) {
    L().checkUpdate(project, def, src, refs);
    const Lib = L(), users = Lib.usage(project, def.id);
    const all = !refs || users.every(u => !u.variant && refs.includes(u.item.ref));
    if (all) return {...Lib.updateFromLibrary(project, def, lib, src), def: def.id};
    const pick = new Set(refs), selected = users.filter(u => !u.variant && pick.has(u.item.ref));
    const bottom = selected.find(u => u.mirrored), pci = globalThis.AtriumPCBEdit;
    if (bottom && !pci?.counterpart) throw Error("The bottom-side footprint could not be prepared.");
    const next = JSON.parse(JSON.stringify(src));
    next.id = A().id(); delete next.rev;
    next.libraryRef = Lib.libraryRefFor(lib, src);
    Lib.replaceDef(project, next);
    const mirrored = bottom && pci.counterpart(project, next, null, {inner: pci.innerCount(bottom.doc, new Map(project.library.map(x => [x.id, x])))});
    for (const u of selected) u.item.def = u.mirrored ? mirrored.id : next.id;
    return {...Lib.updateParts(project, next, {oldDef: def}), def: next.id, split: true};
  }
  const revs = (def, src) => "rev " + (def.libraryRef?.rev || 1) + " → rev " + (src.rev || 1);

  // Shared by project updates and group revision reviews. The controls that approve the
  // change belong to the caller, so reviewing a library never mutates an open project.
  function visualChanges(before, after, c = compare(before, after)) {
    const Lib = L(), el = Lib.ui.el, sec = document.createDocumentFragment();
    const pics = el("div", null, "ld-pics");
    const pic = (title, side, note) => { const f = el("figure", null, "ld-fig"); f.append(el("figcaption", title)); const holder = el("div", null, "ld-draw"); holder.innerHTML = svg(before, after, side, {compare: c}); f.append(holder); if (note) f.append(el("p", note, "ld-note")); pics.append(f); };
    if (before.symbol || after.symbol) pic("Symbol", "symbol", c.symbol ? "Symbol " + c.symbol : [c.pins.added.length && "+" + c.pins.added.length + " pins", c.pins.removed.length && "−" + c.pins.removed.length + " pins",
      c.pins.moved.length && c.pins.moved.length + " moved", c.pins.changed.length && c.pins.changed.length + " changed", c.symbolArt && "graphics changed"].filter(Boolean).join(" · ") || "No pin changes");
    if (before.footprint || after.footprint) pic("Footprint", "footprint", c.footprint ? "Footprint " + c.footprint : [c.pads.added.length && "+" + c.pads.added.length + " pads", c.pads.removed.length && "−" + c.pads.removed.length + " pads",
      c.pads.moved.length && c.pads.moved.length + " moved", c.pads.resized.length && c.pads.resized.length + " resized", c.courtyard && "courtyard changed", c.model3d && "3D model " + c.model3d].filter(Boolean).join(" · ") || "No pad changes");
    sec.append(pics);
    const legend = el("p", null, "ld-legend");
    for (const [cls, text] of [["ld-add", "Added"], ["ld-del", "Removed"], ["ld-mod", "Moved or changed"], ["ld-was", "Old position"]]) {
      const label = el("span", null, "ld-key-label"), key = el("span", null, "ld-key " + cls);
      key.setAttribute("aria-hidden", "true"); label.append(key, text); legend.append(label);
    }
    sec.append(legend);
    const rows = [];
    for (const x of c.pins.changed) rows.push(["Pin " + x.pin.number + (x.pin.part ? " (gate " + Lib.gateLetter(x.pin.part) + ")" : ""), x.what.join("; ")]);
    for (const x of c.pads.moved) rows.push(["Pad " + x.pad.number, "moved " + x.by + " mm"]);
    for (const x of c.pads.resized) rows.push(["Pad " + (x.pad.number || "(unnumbered)"), Lib.landChanges(x).join(", ")]);
    for (const x of c.fields) rows.push([x.key, (x.before || "—") + " → " + (x.after || "—")]);
    for (const x of c.params) rows.push([x.key + (x.sourcing ? " (sourcing)" : ""), (x.before || "—") + " → " + (x.after || "—"), x.sourcing]);
    if (rows.length) {
      const t = el("table", null, "se-table ld-table");
      for (const [k, v, hot] of rows.slice(0, 200)) { const tr = el("tr"); if (hot) tr.className = "ld-hot"; tr.append(el("th", k), el("td", v)); t.append(tr); }
      sec.append(t);
    }
    return sec;
  }

  // ------------------------------------------------------------------ dialog
  function review(ctx, entries, o = {}) {
    const Lib = L(), ui = Lib.ui, el = ui.el, project = () => ctx.currentProject ? ctx.currentProject() : ctx.project;
    entries = entries.filter(e => e?.def && e.src);
    if (!entries.length) { ctx.info?.("Every component is up to date."); return null; }
    const owner = project(), revision = ctx.revision?.();
    const many = entries.length > 1;
    const d = ui.dialog(many ? "Review " + entries.length + " library updates" : "Update " + entries[0].def.name + " from " + entries[0].lib.name + " (" + revs(entries[0].def, entries[0].src) + ")", "ld-dialog");
    const box = el("div", null, "ld-body"), picks = new Map(), keep = new Set();
    for (const e of entries) {
      const c = compare(e.def, e.src), imp = impact(project(), e.def, e.src, c);
      const sec = el(many ? "details" : "section", null, "ld-entry");
      if (many) { sec.open = entries.length <= 3; const s = el("summary"); s.append(el("strong", e.def.name), el("span", " " + revs(e.def, e.src) + " · " + c.changed + " change" + (c.changed === 1 ? "" : "s") + (imp.lostNets.length ? " · ⚠ " + imp.lostNets.length + " pin(s) lose a net" : ""), "ld-meta")); sec.append(s); }
      else sec.append(el("p", e.lib.name + " · " + revs(e.def, e.src) + (e.src.verified?.by ? " · verified by " + e.src.verified.by : ""), "fe-note"));
      sec.append(visualChanges(e.def, e.src, c));
      const im = el("div", null, "ld-impact");
      im.append(el("p", imp.designators.length ? "Placed as " + imp.designators.slice(0, 24).join(", ") + (imp.designators.length > 24 ? "…" : "") : "Not placed in this project.", "fe-note"));
      if (imp.lostNets.length) im.append(el("p", "⚠ Would lose a net: " + imp.lostNets.slice(0, 16).map(x => x.ref + "." + x.pin + " (" + x.net + ")").join(", ") + (imp.lostNets.length > 16 ? "…" : ""), "lib-warning"));
      if (imp.joinedNets.length) im.append(el("p", "⚠ This update joins " + imp.joinedNets.map(x => x.nets.join(" and ") + " on " + x.doc).join(", "), "lib-warning"));
      if (imp.routedPads.length) im.append(el("p", "Connected pads with moved or removed lands: " + imp.routedPads.slice(0, 16).map(x => x.ref + "." + x.pad).join(", ") + (imp.routedPads.length > 16 ? "…" : ""), "lib-warning"));
      if (imp.gates.length) im.append(el("p", "Gates that no longer exist: " + imp.gates.join(", "), "lib-warning"));
      // Update selected designators: everything ticked by default.
      if (imp.designators.length > 1) {
        const pickBox = el("div", null, "ld-refs"), boxes = new Map();
        pickBox.append(el("span", "Update: ", "ld-meta"));
        for (const r of imp.designators) { const l = el("label", null, "fw-check"), cb = el("input"); cb.type = "checkbox"; cb.checked = true; boxes.set(r, cb); l.append(cb, el("span", r)); pickBox.append(l); }
        im.append(pickBox); picks.set(e, boxes);
      }
      if (many) {
        const l = el("label", null, "fw-check"), cb = el("input"); cb.type = "checkbox";
        cb.onchange = () => { if (cb.checked) keep.add(e); else keep.delete(e); };
        l.append(cb, el("span", "Keep the project copy")); im.append(l);
      }
      sec.append(im); box.append(sec);
    }
    const foot = el("div", null, "lib-actions");
    const apply = selectedOnly => {
      const chosen = entries.filter(e => !keep.has(e));
      let done = 0, lost = 0, joined = 0;
      const label = many ? "Update " + chosen.length + " components from library" : "Update " + entries[0].def.name + " (" + revs(entries[0].def, entries[0].src) + ")";
      try {
        if (project() !== owner || revision !== ctx.revision?.() || o.current && !o.current()) throw Error("The project or library changed. Reopen the update review.");
        const refsOf = e => selectedOnly && picks.has(e) ? [...picks.get(e)].filter(([, cb]) => cb.checked).map(([r]) => r) : null;
        for (const e of chosen) {
          if (owner.library.find(x => x.id === e.def.id) !== e.def) throw Error("The component changed. Reopen the update review.");
          const refs = refsOf(e);
          if (!refs || refs.length) Lib.checkUpdate(owner, e.def, e.src, refs);
        }
        ctx.edit(() => {
          for (const e of chosen) {
            const live = project().library.find(x => x.id === e.def.id);
            if (!live) continue;
            const refs = refsOf(e);
            if (refs && !refs.length) continue;
            const r = applyUpdate(project(), live, e.lib, e.src, refs);
            done++; lost += r.disconnected?.length || 0; joined += r.joinedNets?.length || 0;
          }
        }, label);
      } catch (err) { ctx.info?.(err.message); return; }
      d.close();
      ctx.info?.(done ? label + (lost ? " · ⚠ " + lost + " pin(s) now unconnected" : "") + (joined ? " · ⚠ " + joined + " net merge(s)" : "") : "Nothing was updated.");
      o.done?.();
    };
    const all = ui.button(many ? "Update all" : "Update all designators", () => apply(false)); all.className = "lib-primary";
    const some = ui.button("Update selected designators", () => apply(true)); some.hidden = !picks.size;
    foot.append(ui.button("Keep project copy", () => d.close()), some, all);
    d.append(box, foot); ui.show(d);
    return d;
  }

  return Object.freeze({compare, impact, svg, visualChanges, applyUpdate, review});
})();
