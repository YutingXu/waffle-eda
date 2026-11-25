"use strict";
// A small, deterministic presentation of the public Compare result, shared by the worker and MCP.
// Paths contain only numeric drawing commands, in the same 88 × 46 frame on both sides.
globalThis.AtriumHistorySummary = (() => {
  const OPTIONS = Object.freeze({geometry: true, drc: false});
  const VERSION = "history-9";
  const empty = () => ({format: "atrium", version: 1, name: "(none)", documents: [], library: []});
  const unchanged = () => ({total: 0, counts: {electrical: 0, mechanical: 0, cosmetic: 0}, text: "No design changes", regions: []});
  const key = (before, after, build, region = 0) => JSON.stringify([VERSION, build, OPTIONS, before, after, region]);
  const union = (a, b) => !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
  const intersects = (a, b) => a && b && a[2] >= b[0] && a[3] >= b[1] && a[0] <= b[2] && a[1] <= b[3];
  const index = list => new Map(list.map(i => [i.id, i]));
  const short = text => String(text || "").slice(0, 156);

  // Short and plain, like a commit message: "2 tracks rerouted on SUPPLY · R5 value 10k → 47k".
  // Counted kinds share one phrase; one change that names a component keeps Compare's own text.
  const NOUNS = {"track.reshaped": ["track", "rerouted"], "track.moved": ["track", "moved"], "track.added": ["track", "added"],
    "track.removed": ["track", "removed"], "via.added": ["via", "added"], "via.removed": ["via", "removed"],
    "part.added": ["component", "added"], "part.removed": ["component", "removed"], "part.footprint": ["footprint", "changed"],
    "library.footprint": ["footprint", "changed"], "part.moved": ["component", "moved"], "part.value": ["value", "changed"],
    "pin.moved": ["pin connection", "changed"]};
  const NAMED = new Set(["part.added", "part.removed", "part.moved", "part.value", "part.footprint"]);
  const COPPER = /^(track|via)\./;
  // The row already names the sheet or board: drop Compare's own document and domain wording.
  const plain = (text, doc) => {
    let t = String(text).split(" — ")[0].replace(/^(Schematic|Board|PCB): /, "");
    if (doc) t = t.split(" from " + doc).join("").split(" on " + doc).join("");
    return t;
  };
  function headline(changes, doc = "") {
    // Net routing metrics repeat the track changes they come from; keep them only on their own.
    const copper = changes.some(c => COPPER.test(c.kind));
    const groups = new Map();
    for (const c of changes) {
      if (c.kind === "routing.changed" && copper) continue;
      const k = NOUNS[c.kind] ? NOUNS[c.kind].join(" ") : c.kind;
      const group = groups.get(k) || {kind: c.kind, first: c, count: 0, nets: new Set()};
      group.count++; group.nets.add(c.target?.net || "");
      groups.set(k, group);
    }
    const parts = [];
    const priority = g => g.kind === "board.translated" ? 3 : NOUNS[g.kind] ? 2 : g.kind === "document.setting" ? 0 : 1;
    const ordered = [...groups.values()].sort((a, b) => priority(b) - priority(a) || b.count - a.count);
    for (const {kind, count, first, nets} of ordered) {
      const noun = NOUNS[kind], net = nets.size === 1 ? [...nets][0] : "";
      if (first.fields?.includes("bodies3d")) parts.push((first.target?.ref ? first.target.ref + " " : "") + "3D body changed" + (count > 1 ? " (+" + (count - 1) + ")" : ""));
      else if (first.target?.field === "bodyModels") parts.push("3D model files changed");
      else if (kind === "document.setting" && ["schDrawing", "pcbDrawing"].includes(first.target?.field)) parts.push("Drawing settings changed");
      else if (kind === "routing.changed") parts.push(count > 1 ? count + " nets rerouted" : (first.target?.net || "1 net") + " rerouted");
      else if (noun && (count > 1 || !NAMED.has(kind))) parts.push(count + " " + noun[0] + (count > 1 ? "s " : " ") + noun[1] + (net ? " on " + net : ""));
      else parts.push(short(plain(first.text, doc)) + (count > 1 ? " (+" + (count - 1) + ")" : ""));
    }
    return parts.slice(0, 3).join(" · ") + (parts.length > 3 ? " · " + (parts.length - 3) + " more" : "");
  }

  function frame(box) {
    const [x0, y0, x1, y1] = box, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const scale = Math.min(74 / Math.max(3, x1 - x0), 34 / Math.max(3, y1 - y0));
    const num = v => Math.round(Math.max(-999, Math.min(999, v)) * 10) / 10;
    return {box: [cx - 44 / scale, cy - 23 / scale, cx + 44 / scale, cy + 23 / scale],
      point: p => [num(44 + (p[0] - cx) * scale), num(23 - (p[1] - cy) * scale)]};
  }

  function path(shape, view) {
    if (!shape?.box || !intersects(shape.box, view.box)) return "";
    if (shape.path?.length > 1) {
      // Bound the number of vertices in a thumbnail even for imported copper.
      const pts = shape.path, step = Math.max(1, Math.ceil((pts.length - 1) / 23));
      const p = [view.point(pts[0])];
      for (let i = step; i < pts.length - 1; i += step) p.push(view.point(pts[i]));
      p.push(view.point(pts[pts.length - 1]));
      return "M" + p.join("L") + (shape.closed ? "Z" : "");
    }
    const [x, y] = view.point(shape.box.slice(0, 2)), [u, v] = view.point(shape.box.slice(2));
    const w = Math.max(1, u - x), h = Math.max(1, y - v);
    if (shape.round) {
      const rx = w / 2, ry = h / 2, arc = "a" + rx + "," + ry + " 0 1,0 ";
      return "M" + x + "," + (v + ry) + arc + w + ",0" + arc + -w + ",0Z";
    }
    return "M" + x + "," + v + "h" + w + "v" + h + "h" + -w + "Z";
  }

  // The 2D history tile uses the saved plan outlines. STEP geometry stays compressed.
  function ringsShape(rings, owner, flipped = false) {
    const paths = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const ring of rings) {
      if (ring.length < 3 || paths.length >= 52) continue;
      const stride = Math.max(1, Math.ceil(ring.length / 23)), pts = [];
      for (let i = 0; i < ring.length; i++) {
        const p = owner ? Atrium.world(flipped ? [ring[i][0], -ring[i][1]] : ring[i], owner) : ring[i];
        x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
        x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
        if (!(i % stride) || i === ring.length - 1) pts.push(p);
      }
      paths.push({box: Atrium.bounds(pts), path: pts, closed: true});
    }
    return paths.length ? {box:[x0,y0,x1,y1], paths} : null;
  }
  function boardProfile(doc) {
    if (!doc) return null;
    const B = globalThis.AtriumBoardShape, native = B?.fresh(doc);
    return ringsShape(native ? B.profileContours(native).map(c => B.flattenContour(c, .1)) : [doc.outline || []]);
  }
  function bodyOutline(body, owner) {
    return ringsShape(body.rings || [], owner, owner && (owner.layer === "Bottom" ? "Bottom" : "Top") !== body.ownerSide);
  }
  function changedBodies(owner, other, placed) {
    if (!owner?.bodies3d) return null;
    const previous = new Map((other?.bodies3d || []).map(b => [b.sourceRecord, b]));
    const paths = [];
    let box = null;
    for (const b of owner.bodies3d) {
      const prior = previous.get(b.sourceRecord);
      if (prior && AtriumDiff.same(prior, b)) continue;
      const shape = bodyOutline(b, placed ? owner : null);
      if (shape) { box = union(box, shape.box); paths.push(...shape.paths.slice(0, 52 - paths.length)); }
    }
    return paths.length ? {box, paths} : null;
  }
  function spatialChange(change, a, b, beforeItems, afterItems) {
    let before, after;
    if (change.kind === "board.shape") { before = boardProfile(a); after = boardProfile(b); }
    else if (change.fields?.includes("bodies3d")) {
      const placed = change.target.type !== "document";
      const old = placed ? beforeItems.get(change.target.beforeId) : a;
      const next = placed ? afterItems.get(change.target.afterId) : b;
      before = changedBodies(old, next, placed); after = changedBodies(next, old, placed);
    }
    const box = union(before?.box, after?.box);
    return box ? {...change, geometry:{box, before, after}} : change;
  }

  function tile(doc, defs, shapes, view, whole) {
    if (!doc) return null;
    const A = globalThis.Atrium, D = globalThis.AtriumDiff, context = [], changed = [];
    const add = (geometry, active) => {
      const bucket = active ? changed : context;
      for (const g of geometry?.paths || [geometry]) {
        if (bucket.length >= 52) break;
        const d = path(g, view);
        if (d) bucket.push(d);
      }
    };
    // These outlines locate a board or body change independently of its footprint.
    for (const [id, g] of shapes) if (g.paths) { add(g, true); shapes.delete(id); }
    if (doc.outline?.length) add(whole ? boardProfile(doc) : {box: A.bounds(doc.outline), path: doc.outline, closed: true}, whole);
    if (whole) for (const b of doc.bodies3d || []) {
      if (changed.length >= 52) break;
      add(bodyOutline(b), true);
    }
    // Draw actual routes, component outlines, symbol strokes, pads and pins behind the change.
    for (const item of doc.items) {
      if (whole && changed.length >= 52 || context.length >= 52 && !shapes.size) break;
      if (context.length >= 52 && !shapes.has(item.id)) continue;
      const g = A.geometries(defs.get(item.def), doc.kind);
      const outline = D.shapeOf(item, g, doc.kind);
      if (!intersects(outline?.box, view.box)) continue;
      const active = whole || shapes.has(item.id);
      if (active && !whole) shapes.delete(item.id);
      if (item.kind === "part" && g) {
        if (whole) for (const b of item.bodies3d || []) {
          if (changed.length >= 52) break;
          add(bodyOutline(b, item), true);
        }
        const def = A.gate(g, item);
        for (const s of (def.shapes || []).slice(0, 12)) {
          const native = s.regionShape && globalThis.AtriumBoardShape?.regionOf(s);
          if (native) {
            add(ringsShape(AtriumBoardShape.profileContours(native).map(c => AtriumBoardShape.flattenContour(c, .1)), item), active);
            continue;
          }
          let points = s.points;
          if (s.kind === "text" && s.size > 0) {
            // Orient a baseline and cap-height stroke at the actual legend anchor.
            const text = A.special(s, item).text || "";
            const box = s.sourceTextBox;
            points = [[0, box?.height || s.size], [0, 0], [box?.width || Math.max(1, text.length) * s.size * .6, 0]].map(p => {
              const q = A.rotate(p, s.angle || 0); return [s.x + q[0], s.y + q[1]];
            });
          }
          if (!points?.length) continue;
          const pts = points.map(p => A.world(p, item));
          add({box: A.bounds(pts), path: pts, closed: s.kind === "polygon"}, active);
        }
        for (const p of (def.pads || def.pins || []).slice(0, 16)) {
          const [x, y] = A.world([p.x, p.y], item), w = (p.w || .35) / 2, h = (p.h || .35) / 2;
          add({box: [x - w, y - h, x + w, y + h], round: p.shape === "round"}, active);
        }
      }
      const native = item.regionShape && globalThis.AtriumBoardShape?.regionOf(item);
      if (native) add(ringsShape(AtriumBoardShape.profileContours(native).map(c => AtriumBoardShape.flattenContour(c, .1))), active);
      else add(outline, active);
    }
    for (const g of shapes.values()) add(g, true);
    return {context: context.join(""), changed: changed.join("")};
  }

  function clusters(changes, board) {
    // Separate far-apart PCB changes. A whole-net metric can span several regions, so prefer
    // the actual changed copper and footprints when choosing where to zoom.
    const located = changes.filter(c => c.geometry?.box);
    const objects = located.filter(c => c.category !== "connectivity" && c.kind !== "routing.changed");
    const relevant = objects.length ? objects : located;
    if (!board || relevant.length < 2) return [relevant];
    const groups = [];
    // Independent readers allocate different object IDs. Keep region membership and
    // gallery order tied to drawing space when their comparison records arrive in another order.
    const byBox = (a, b) => {
      for (let i = 0; i < 4; i++) if (a.geometry.box[i] !== b.geometry.box[i]) return a.geometry.box[i] - b.geometry.box[i];
      return 0;
    };
    for (const c of relevant.slice().sort(byBox)) {
      const box = c.geometry.box;
      let best = null, distance = Infinity;
      for (const g of groups) {
        const dx = Math.max(0, g.box[0] - box[2], box[0] - g.box[2]);
        const dy = Math.max(0, g.box[1] - box[3], box[1] - g.box[3]);
        if (dx * dx + dy * dy < distance) { best = g; distance = dx * dx + dy * dy; }
      }
      if (!best || distance > 100 && groups.length < 4) groups.push({box, changes: [c]});
      else { best.box = union(best.box, box); best.changes.push(c); }
    }
    return groups.map(g => g.changes);
  }

  // A library footprint or symbol can redraw its placed instances even when their own records
  // are identical. Use Compare's definition IDs to locate those instances on each side separately.
  function affectedInstances(doc, defs, changes, side) {
    if (!doc || !changes.size) return [];
    const located = [];
    for (const item of doc.items) {
      const change = changes.get(item.def);
      if (item.kind !== "part" || !change) continue;
      const shape = AtriumDiff.shapeOf(item, Atrium.geometries(defs.get(item.def), doc.kind), doc.kind);
      if (shape) located.push({change, kind: change.kind, category: "library", text: change.text,
        target: {[side + "Id"]: item.id}, geometry: {box: shape.box, [side]: shape}});
    }
    return located;
  }

  function present(before, after, diff, preview) {
    if (!diff.summary.total) return unchanged();
    const docsA = index(before.documents), docsB = index(after.documents);
    const defsA = index(before.library), defsB = index(after.library), byDoc = new Map(), general = [];
    for (const c of diff.changes) {
      const id = c.target.doc || c.geometry?.doc;
      if (!id) { general.push(c); continue; }
      if (!byDoc.has(id)) byDoc.set(id, []);
      byDoc.get(id).push(c);
    }
    const library = {before: {pcb: new Map(), schematic: new Map()}, after: {pcb: new Map(), schematic: new Map()}}, placed = new Set();
    for (const c of general) {
      const k = c.kind === "library.footprint" ? "pcb" : c.kind === "library.symbol" ? "schematic" : null;
      if (!k) continue;
      for (const side of ["before", "after"]) if (c.target[side + "Id"]) library[side][k].set(c.target[side + "Id"], c);
    }
    const regions = [], lines = [];
    for (const doc of diff.summary.documents) {
      let changes = byDoc.get(doc.id) || [];
      const a = docsA.get(doc.beforeId), b = doc.status === "removed" ? null : docsB.get(doc.id);
      if (doc.kind === "pcb" && changes.some(c => c.kind === "board.shape" || c.fields?.includes("bodies3d"))) {
        const hasPlaced = changes.some(c => c.target.type !== "document" && c.fields?.includes("bodies3d"));
        const left = hasPlaced && index(a?.items || []), right = hasPlaced && index(b?.items || []);
        changes = changes.map(c => spatialChange(c, a, b, left, right));
      }
      const instances = [...affectedInstances(a, defsA, library.before[doc.kind] || new Map(), "before"),
        ...affectedInstances(b, defsB, library.after[doc.kind] || new Map(), "after")];
      if (!changes.length && !instances.length) continue;
      const definitions = new Set(instances.map(x => x.change));
      for (const c of definitions) placed.add(c);
      const notes=changes.filter(c=>c.category==="notes"),design=notes.length?changes.filter(c=>c.category!=="notes"):changes;
      const groups = clusters(design.concat(instances), doc.kind === "pcb");
      if(notes.length) groups.push(notes);
      const text = headline([...changes, ...definitions], doc.name);
      lines.push(short(doc.name) + ": " + text);
      for (const [i, area] of groups.entries()) {
        // A setting can change on a sheet alongside an actual changed board. Keep its
        // headline, and reserve before/after drawing tiles for spatial changes.
        if (!area.length && a && b) continue;
        const name = area===notes?short(doc.name)+" · Notes":short(doc.name) + (groups.length > 1 ? " · Region " + (i + 1) : "");
        const region = {document: doc.id, name, kind: doc.kind, ...(area===notes?{group:"Notes"}:{}), text: groups.length > 1 ? headline(area, doc.name) : text};
        regions.push(region);
        // The desktop gallery shows one region at a time. Compute another only when requested.
        if (preview !== "all" && preview !== regions.length - 1) continue;
        const left = new Map(), right = new Map();
        let bounds = null;
        for (const c of area) {
          if(!c.geometry) continue;
          bounds = union(bounds, c.geometry.box);
          if (c.geometry.before) left.set(c.target.beforeId || c.id, c.geometry.before);
          if (c.geometry.after) right.set(c.target.afterId || c.id, c.geometry.after);
        }
        if (!bounds) {
          bounds = union(a && Atrium.docBounds(a, defsA), b && Atrium.docBounds(b, defsB));
          if (!a || !b) for (const body of (a || b)?.bodies3d || []) bounds = union(bounds, bodyOutline(body)?.box);
        }
        const view = frame(bounds || [-1, -1, 1, 1]);
        region.before = tile(a, defsA, left, view, !b);
        region.after = tile(b, defsB, right, view, !a);
      }
    }
    const other = general.filter(c => !placed.has(c));
    if (other.length) lines.push(headline(other));
    return {total: diff.summary.total, counts: diff.summary.bySeverity, text: lines.join(" · "), regions, objects: objects(diff.changes)};
  }
  // The changed objects for History's details (history-view.js): bounded, plain values only, grouped there by type.
  const value = v => v == null ? null : typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? short(String(v)).slice(0, 60) : null;
  function objects(changes) {
    const out = [];
    for (const c of changes) {
      if (c.category === "drc" || out.length >= 400) continue;
      const t = c.target || {};
      out.push({kind: c.kind, type: t.type || "", severity: c.severity, label: short(t.label || t.ref || t.net || t.name || "").slice(0, 80),
        doc: t.doc || null, docName: short(t.docName || "").slice(0, 80), text: short(plain(c.text, t.docName || "")),
        before: value(c.before), after: value(c.after), id: t.afterId || t.beforeId || null});
    }
    return out;
  }

  function fromProjects(before, after, preview = "all", sourcesDiffer = false) {
    const a = before || empty(), b = after || empty();
    const result = present(a, b, globalThis.AtriumDiff.compare(a, b, {...OPTIONS, validate: false}), preview);
    if (!result.total && sourcesDiffer) result.text = "Source files changed · no modeled design changes";
    const missing = Math.max(a.historyMissingLibraries || 0, b.historyMissingLibraries || 0);
    if (missing) {
      result.unavailableLibraries = missing;
      result.text += " · " + missing + " referenced " + (missing === 1 ? "library" : "libraries") + " unavailable";
    }
    return result;
  }
  return Object.freeze({empty, unchanged, key, fromProjects});
})();

// BoardRunner supplies these inputs after verifying the saved folder or locating the EDA blobs.
globalThis.AtriumProjectHistoryReport = (header, left, right) => {
  const h = JSON.parse(header), native = h?.nativeFolder === true, foreign = h?.sources === true;
  if (native === foreign) throw Error("Project history requires a verified Waffle folder or source EDA revision.");
  const summary = AtriumHistorySummary;
  if (h.same === true) return JSON.stringify(summary.unchanged());
  if (foreign) {
    const source = (blob, text) => blob ? AtriumHistorySource.project(JSON.parse(text)) : null;
    return JSON.stringify(summary.fromProjects(source(h.before, left), source(h.after, right), "all", true));
  }
  const editorProject = (version, text) => {
    if (!version) return null;
    const project = JSON.parse(text);
    if (project?.format !== "atrium" || project.version !== 1 || !Array.isArray(project.library) || !Array.isArray(project.documents))
      throw Error("The verified revision has an invalid editor model.");
    return Atrium.validate(project);
  };
  const result = summary.fromProjects(editorProject(h.before, left), editorProject(h.after, right));
  if (!result.total) result.text = "Saved files changed · no modeled design changes";
  return JSON.stringify(result);
};
