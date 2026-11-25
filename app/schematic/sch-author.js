"use strict";
// Design authoring operations shared by the editor, scripts and the MCP tools (mcp/headless.js).
// No DOM access. Every operation edits the project in place (call it inside the editor's edit()
// for one undo step) and returns plain JSON with the stable IDs it created or changed.
//
//   placePart(p,{sheet,def,x,y,rotation,designator,value,unit,parameters})  -> {id,ref,unit,def,link,pins:[{number,name,at}]}
//   addWire(p,{sheet,points} | {sheet,from,to,via},allowJoin)   from/to: {designator,pin} or {x,y}.
//     A wire joins every connection point on its segments (model.js), so a route that would pass
//     through another pin, wire end, label or port is refused unless allowJoin; from/to tries both elbows.
//   addNetLabel(p,{sheet,text,x,y | at:{designator,pin},rotation,netClass,diffPair})
//   addPowerPort(p,{sheet,net,style,x,y | at})
//   setBoardOutline(p,{board,rect:[x0,y0,x1,y1] | points:[[x,y],...]})
//   moveComponent(p,{board,component,x,y,rotation,dx,dy})
//   deleteItems(p,{document,ids,designators,allDocuments})   designators need a document or allDocuments
// Positions are millimetres. Schematic positions snap to the sheet grid unless snap is false.
globalThis.AtriumSchAuthor = (() => {
  const A = Atrium;
  const fail = m => { throw Error(m); };
  const up = s => String(s ?? "").trim().toUpperCase();
  const num = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e6;
  const round = v => Math.round(v * 1e4) / 1e4 + 0;

  function documentOf(p, ref, kind) {
    const docs = p.documents.filter(d => d.kind === kind);
    if (ref == null || ref === "") return docs[0] || fail("The project has no " + (kind === "pcb" ? "board layout." : "schematic sheet."));
    return docs.find(d => d.id === ref) || docs.find(d => up(d.name) === up(ref)) ||
      fail("No " + (kind === "pcb" ? "board" : "schematic sheet") + " is called " + ref + ". " + (kind === "pcb" ? "Boards" : "Sheets") + ": " + docs.map(d => d.name).join(", ") + ".");
  }
  // A library definition by ID or name; otherwise a built-in starter part (AtriumParts), copied
  // into the project library on first use; otherwise the shared library sources (AtriumLibrary).
  function resolveDef(p, ref) {
    if (ref == null || ref === "") fail("Name the component (library ID or name).");
    const key = up(ref);
    let d = p.library.find(x => x.id === ref) || p.library.find(x => up(x.name) === key);
    if (d) return d;
    const builtin = (globalThis.AtriumParts?.catalogue || []).find(x => x.id === ref || up(x.name) === key);
    const found = builtin || globalThis.AtriumLibrary?.findDef?.(p, ref) || null;
    if (!found) fail("The library has no component " + ref + ". Library: " + p.library.map(x => x.name).slice(0, 40).join(", ") + (globalThis.AtriumParts ? "; built-in: " + AtriumParts.catalogue.map(x => x.id).join(", ") : "") + ".");
    d = p.library.find(x => x.id === found.id);
    if (!d) { d = A.clone(found); p.library.push(d); }
    return d;
  }
  const defsOf = p => new Map(p.library.map(d => [d.id, d]));
  const unitOf = i => (Number.isInteger(i.unit) && i.unit > 0 ? i.unit : 0) || (Number.isInteger(i.part) && i.part > 0 ? i.part : 0) || 1;
  const snapPt = (doc, x, y, snap) => snap === false ? [x, y] : [A.snap(x, doc.grid), A.snap(y, doc.grid)];
  const angleOf = r => {
    const a = ((Math.round(Number(r || 0)) % 360) + 360) % 360;
    if (a % 90) fail("Schematic rotation must be 0, 90, 180 or 270 degrees.");
    return a;
  };
  function pinList(item, def) {
    return A.pins(item, def, "schematic").map(x => ({number: String(x.number), name: x.name || "", at: [round(x.at[0]), round(x.at[1])]}));
  }

  // ------------------------------------------------------------------ schematic
  function placePart(p, a) {
    const doc = documentOf(p, a.sheet, "schematic"), def = resolveDef(p, a.def);
    if (!def.symbol) fail(def.name + " has no schematic symbol.");
    if (!num(a.x) || !num(a.y)) fail("Give the position as x and y in mm.");
    const parts = p.documents.flatMap(d => d.kind === "schematic" ? d.items.filter(i => i.kind === "part") : []);
    const gates = def.symbol.parts > 1 ? def.symbol.parts : 1;
    let ref = a.designator != null ? String(a.designator).trim() : "", unit = a.unit ?? null;
    if (ref && /\s/.test(ref)) fail("A designator cannot contain spaces.");
    // "U1B" for a multi-gate part is gate B of U1, as the sheet shows it (Atrium.gateLabel).
    const gateRef = gates > 1 && /^(.*\d)([A-Za-z])$/.exec(ref);
    if (gateRef) {
      const u = gateRef[2].toUpperCase().charCodeAt(0) - 64;
      if (u > gates) fail(def.name + " has " + gates + " gates; " + ref + " names gate " + gateRef[2].toUpperCase() + ".");
      if (unit != null && unit !== u) fail(ref + " names gate " + u + ", but unit is " + unit + ".");
      ref = gateRef[1]; unit = u;
    }
    let package_ = null;
    if (ref && !ref.includes("?")) {
      const same = parts.filter(i => up(i.ref) === up(ref));
      if (same.length) {
        if (gates < 2 || same.some(i => i.def !== def.id)) fail("Designator " + ref + " is already in use.");
        const used = new Set(same.map(unitOf));
        if (unit == null) { for (let u = 1; u <= gates; u++) if (!used.has(u)) { unit = u; break; } }
        if (unit == null) fail("Every gate of " + ref + " is already placed.");
        if (used.has(unit)) fail("Gate " + unit + " of " + ref + " is already placed.");
        package_ = same[0];
      }
    } else ref = A.nextRef(p, def.prefix || "U");
    if (unit != null && (!Number.isInteger(unit) || unit < 1 || unit > gates)) fail(def.name + " has " + gates + " gate" + (gates === 1 ? "" : "s") + ".");
    const at = snapPt(doc, a.x, a.y, a.snap);
    const item = A.instantiate(p, def, at, angleOf(a.rotation));
    item.ref = ref;
    if (a.value != null) item.value = String(a.value);
    if (package_) { item.link = package_.link || item.link; item.value = a.value != null ? String(a.value) : package_.value; }
    if (unit != null && gates > 1) item.unit = unit;
    if (a.parameters && typeof a.parameters === "object") item.parameters = Object.fromEntries(Object.entries(a.parameters).map(([k, v]) => [String(k), String(v)]));
    delete item.pinNets;
    doc.items.push(item);
    return {id: item.id, document_id: doc.id, ref: item.ref, unit: item.unit || null, label: A.gateLabel ? A.gateLabel(item, def).ref : item.ref,
      def: def.id, def_name: def.name, value: item.value, link: item.link, at: [round(item.x), round(item.y)], rotation: item.angle, pins: pinList(item, def)};
  }
  // Where a pin of a placed part is. A multi-gate part looks in the gate that owns the pin.
  function pinAt(p, doc, designator, pin) {
    const defs = defsOf(p), parts = doc.items.filter(i => i.kind === "part" && (up(i.ref) === up(designator) || i.id === designator ||
      (A.gateLabel && up(A.gateLabel(i, defs.get(i.def)).ref) === up(designator))));
    if (!parts.length) fail("No part " + designator + " is on " + doc.name + ".");
    for (const part of parts) {
      const hit = A.pins(part, defs.get(part.def), "schematic").find(x => String(x.number) === String(pin) || x.name && up(x.name) === up(pin) && String(pin) !== "");
      if (hit) return {at: hit.at.map(round), part};
    }
    fail(designator + " has no pin " + pin + ".");
  }
  function endpoint(p, doc, e, name) {
    if (!e || typeof e !== "object") fail("Give the wire's " + name + " as {designator, pin} or {x, y}.");
    if (e.designator != null) return pinAt(p, doc, e.designator, e.pin ?? fail("Name the pin of " + e.designator + ".")).at;
    if (num(e.x) && num(e.y)) return snapPt(doc, e.x, e.y, e.snap);
    fail("Give the wire's " + name + " as {designator, pin} or {x, y}.");
  }
  // A junction where a new wire ends on the inside of an existing wire (a T), as Altium draws it.
  function junctions(doc, wire) {
    const out = [];
    for (const end of [wire.points[0], wire.points[wire.points.length - 1]]) {
      const key = A.pointKey(end);
      if (doc.items.some(i => i.kind === "junction" && A.pointKey([i.x, i.y]) === key)) continue;
      const tee = doc.items.some(w => w.kind === "wire" && w !== wire && w.points.some((q, n) => n > 0 &&
        A.nearSegment(end, w.points[n - 1], q) < 1e-4 && !A.same(end, w.points[n - 1]) && !A.same(end, q)));
      if (tee) { const j = {id: A.id(), kind: "junction", x: end[0], y: end[1]}; doc.items.push(j); out.push(j.id); }
    }
    return out;
  }
  // Every point a wire would join if one of its segments passed over it (Atrium.connectivity):
  // pins, wire vertices, junctions, net labels, power ports, ports and sheet entries.
  function connectionPoints(p, doc) {
    const defs = defsOf(p), out = [];
    for (const i of doc.items) {
      if (i.kind === "part") {
        const def = defs.get(i.def), name = A.gateLabel ? A.gateLabel(i, def).ref : i.ref;
        for (const pin of A.pins(i, def, "schematic")) out.push({at: pin.at, what: name + " pin " + pin.number});
      } else if (i.kind === "wire") i.points.forEach((q, n) => out.push({at: q, what: "a wire " + (n === 0 || n === i.points.length - 1 ? "end" : "corner"), wire: i}));
      else if (i.kind === "junction") out.push({at: [i.x, i.y], what: "a junction"});
      else if (i.kind === "netlabel") out.push({at: [i.x, i.y], what: "net label " + i.text});
      else if (globalThis.AtriumSchObjects?.KINDS.has(i.kind)) for (const q of AtriumSchObjects.hotspots(i)) out.push({at: q, what: (i.kind === "power" ? "power port " : i.kind === "port" ? "port " : i.kind + " ") + (i.text || i.name || "")});
    }
    return out;
  }
  function collisions(p, doc, pts, points = connectionPoints(p, doc)) {
    const ends = new Set([A.pointKey(pts[0]), A.pointKey(pts[pts.length - 1])]), hits = new Map();
    for (let k = 1; k < pts.length; k++) for (const c of points) {
      const key = A.pointKey(c.at);
      if (!ends.has(key) && A.nearSegment(c.at, pts[k - 1], pts[k]) < 1e-4) hits.set(key + c.what, c.what + " at " + c.at.map(round).join(", "));
    }
    // A corner of the new wire lying on an existing wire joins it too.
    for (const q of pts.slice(1, -1)) for (const w of doc.items) if (w.kind === "wire")
      for (let k = 1; k < w.points.length; k++) if (A.nearSegment(q, w.points[k - 1], w.points[k]) < 1e-4) hits.set("w" + w.id, "a wire through " + q.map(round).join(", "));
    return [...hits.values()];
  }
  function addWire(p, a) {
    const doc = documentOf(p, a.sheet, "schematic");
    let pts;
    if (Array.isArray(a.points)) {
      if (a.points.length < 2) fail("A wire needs at least two points.");
      pts = a.points.map(q => { if (!Array.isArray(q) || !num(q[0]) || !num(q[1])) fail("Wire points are [x, y] in mm."); return snapPt(doc, q[0], q[1], a.snap); });
    } else {
      const from = endpoint(p, doc, a.from, "start"), to = endpoint(p, doc, a.to, "end");
      const via = (a.via || []).map(q => { if (!Array.isArray(q) || !num(q[0]) || !num(q[1])) fail("via points are [x, y] in mm."); return snapPt(doc, q[0], q[1], a.snap); });
      // Orthogonal route through the via points; without them, either elbow (horizontal or vertical first).
      const route = flip => {
        const out = [from];
        for (const q of [...via, to]) {
          const last = out[out.length - 1];
          const leg = flip && !via.length ? [last, [last[0], q[1]], q].filter((r, i, l) => !i || !A.same(r, l[i - 1])) : A.pathBetween(last, q);
          for (const r of leg.slice(1)) out.push(r);
        }
        return out;
      };
      pts = route(false);
      if (!a.allowJoin) {
        const points = connectionPoints(p, doc), first = collisions(p, doc, dedupe(pts), points);
        if (first.length) {
          const other = route(true);
          if (!via.length && !collisions(p, doc, dedupe(other), points).length) pts = other;
          else fail("The wire would connect to " + first.slice(0, 12).join("; ") + (first.length > 12 ? " and " + (first.length - 12) + " more" : "") +
            ". Add via points to route around them, or pass allow_join to connect them.");
        }
      }
    }
    pts = dedupe(pts);
    if (pts.length < 2) fail("The wire's start and end are the same point.");
    if (Array.isArray(a.points) && !a.allowJoin) {
      const hit = collisions(p, doc, pts);
      if (hit.length) fail("The wire would connect to " + hit.slice(0, 12).join("; ") + (hit.length > 12 ? " and " + (hit.length - 12) + " more" : "") + ". Pass allow_join to connect them.");
    }
    const wire = {id: A.id(), kind: "wire", points: pts};
    doc.items.push(wire);
    return {id: wire.id, document_id: doc.id, points: pts.map(q => q.map(round)), junctions: junctions(doc, wire)};
  }
  const dedupe = pts => pts.filter((q, i) => !i || !A.same(q, pts[i - 1]));
  function placeAt(p, doc, a) {
    if (a.at) return pinAt(p, doc, a.at.designator, a.at.pin).at;
    if (num(a.x) && num(a.y)) return snapPt(doc, a.x, a.y, a.snap);
    fail("Give the position as x and y in mm, or at: {designator, pin}.");
  }
  function addNetLabel(p, a) {
    const doc = documentOf(p, a.sheet, "schematic"), text = String(a.text ?? a.net ?? "").trim();
    if (!text) fail("Name the net.");
    const at = placeAt(p, doc, a), item = {id: A.id(), kind: "netlabel", x: at[0], y: at[1], text};
    if (a.rotation) item.angle = angleOf(a.rotation);
    if (a.netClass) item.netClass = String(a.netClass);
    if (a.diffPair) item.diffPair = String(a.diffPair);
    // Signal directives (format 1.4, signals.js): live on the board.
    if (a.signal) item.signal = String(a.signal).trim();
    if (a.polarity === 1 || a.polarity === -1 || a.polarity === "+" || a.polarity === "-") item.polarity = a.polarity === 1 || a.polarity === "+" ? 1 : -1;
    if (a.tags) { const t = (Array.isArray(a.tags) ? a.tags : String(a.tags).split(",")).map(x => String(x).trim()).filter(Boolean); if (t.length) item.tags = [...new Set(t)]; }
    doc.items.push(item);
    return {id: item.id, document_id: doc.id, text, at: at.map(round)};
  }
  const POWER_STYLES = ["gnd", "signal", "earth", "bar", "arrow", "circle", "wave"];
  function addPowerPort(p, a) {
    const doc = documentOf(p, a.sheet, "schematic"), net = String(a.net ?? "").trim();
    if (!net) fail("Name the power net, e.g. GND or +3V3.");
    const style = a.style || (/^(0V|GND|VSS|AGND|DGND|PGND)/i.test(net) ? "gnd" : "bar");
    if (!POWER_STYLES.includes(style)) fail("Power port style is one of " + POWER_STYLES.join(", ") + ".");
    const at = placeAt(p, doc, a), opts = {text: net, style};
    if (a.direction != null) opts.direction = a.direction;
    const item = globalThis.AtriumSchObjects ? AtriumSchObjects.make("power", at, opts) :
      {id: A.id(), kind: "power", x: at[0], y: at[1], text: net, style, direction: a.direction ?? (["gnd", "signal", "earth"].includes(style) ? 3 : 1), showName: true};
    doc.items.push(item);
    return {id: item.id, document_id: doc.id, net, style, at: at.map(round)};
  }

  // ------------------------------------------------------------------ board
  function setBoardOutline(p, a) {
    const doc = documentOf(p, a.board, "pcb");
    let pts;
    if (Array.isArray(a.rect)) {
      const [x0, y0, x1, y1] = a.rect;
      if (![x0, y0, x1, y1].every(num) || x1 <= x0 || y1 <= y0) fail("rect is [x0, y0, x1, y1] in mm with x1 > x0 and y1 > y0.");
      pts = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
    } else if (Array.isArray(a.points)) pts = a.points.map(q => [Number(q?.[0]), Number(q?.[1])]);
    else fail("Give the outline as rect [x0, y0, x1, y1] or a points polygon.");
    if (!pts.every(q => num(q[0]) && num(q[1])) || !A.validOutline(pts)) fail("The outline needs at least three points enclosing an area.");
    // The exact board shape (arcs and cutouts, board-shape.js) is replaced only when asked.
    const cutouts = doc.boardShape?.cutouts?.length || 0;
    if (cutouts && !a.replaceCutouts) fail("The board shape has " + cutouts + " cutout" + (cutouts === 1 ? "" : "s") + ", which a new outline removes. Pass replace_cutouts to replace them.");
    const replaced = doc.boardShape ? {board_shape: true, cutouts} : null;
    doc.outline = pts.map(q => q.map(round));
    delete doc.boardShape;
    const b = A.bounds(doc.outline);
    return {document_id: doc.id, points: doc.outline, width: round(b[2] - b[0]), height: round(b[3] - b[1]), ...(replaced ? {replaced} : {})};
  }
  function findPart(doc, ref) {
    const list = doc.items.filter(i => i.kind === "part" && (i.id === ref || up(i.ref) === up(ref)));
    if (!list.length) fail("No component " + ref + " is on " + doc.name + ".");
    if (list.length > 1) fail("Several components on " + doc.name + " are called " + ref + ". Use the ID.");
    return list[0];
  }
  function moveComponent(p, a) {
    const doc = documentOf(p, a.board, "pcb"), part = findPart(doc, a.component ?? fail("Name the component (designator or ID)."));
    if (part.locked) fail(part.ref + " is locked.");
    const x = num(a.x) ? a.x : part.x + (num(a.dx) ? a.dx : 0), y = num(a.y) ? a.y : part.y + (num(a.dy) ? a.dy : 0);
    if (!num(x) || !num(y)) fail("Give x and y (or dx and dy) in mm.");
    part.x = round(x); part.y = round(y);
    if (a.rotation != null) { if (!num(a.rotation)) fail("rotation is in degrees."); part.angle = round(((a.rotation % 360) + 360) % 360); }
    return {id: part.id, document_id: doc.id, ref: part.ref, at: [part.x, part.y], rotation: part.angle || 0};
  }
  function deleteItems(p, a) {
    const ids = new Set(a.ids || []), removed = [], missing = [];
    if (a.designators?.length && a.document == null && !a.allDocuments)
      fail("Name the document whose components to delete (a designator is on the schematic and the board), or pass all_documents.");
    const docs = a.document != null ? [p.documents.find(d => d.id === a.document || up(d.name) === up(a.document)) || fail("No document " + a.document + ".")] : p.documents;
    for (const ref of a.designators || []) {
      const hits = docs.flatMap(d => d.items.filter(i => i.kind === "part" && up(i.ref) === up(ref)));
      if (!hits.length) missing.push(ref);
      for (const h of hits) ids.add(h.id);
    }
    const found = new Set();
    for (const d of docs) for (const i of d.items) if (ids.has(i.id)) { found.add(i.id); if (i.locked) fail((i.ref || i.kind) + " is locked. Unlock it first."); }
    for (const id of ids) if (!found.has(id)) missing.push(id);
    if (missing.length) fail("Not found: " + missing.slice(0, 20).join(", ") + ".");
    for (const d of docs) {
      const keep = [];
      for (const i of d.items) if (ids.has(i.id)) removed.push({id: i.id, kind: i.kind, document_id: d.id, ...(i.ref ? {ref: i.ref} : {})}); else keep.push(i);
      d.items = keep;
    }
    return {removed};
  }

  return {resolveDef, documentOf, pinAt, placePart, addWire, addNetLabel, addPowerPort, setBoardOutline, moveComponent, deleteItems, POWER_STYLES};
})();
