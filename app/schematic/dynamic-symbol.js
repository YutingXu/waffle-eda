"use strict";
// Dynamic symbols: placeholder connector symbols whose pins are defined as you wire them
// (KiCad 10-style dynamic connectors).
//
// A dynamic connector is a library definition of its own, marked def.dynamic:
//   def.dynamic = {body:[x0,y0,x1,y1] (symbol mm, Y down), rows:1|2, pitch,
//                  pins:[{number, name, x, y, orientation, auto?}]}
//   def.symbol / def.schDrawing are rebuilt from dynamic.pins (AtriumLibrary.buildSymbol), and
//   def.footprint is a through-hole header from the IPC wizard header family that tracks the
//   pin count (1×N, or 2×ceil(N/2) with rows 2).
// A wire whose end lands on the body edge, away from the existing pins, adds a pin there
// (settle(), which editor.js runs inside every edit). The pin takes the net label of its wire,
// or its number; auto-named pins follow a net label added later. Pins can be renamed and
// renumbered (reordered) in place; freeze() turns the definition into a normal library symbol
// through AtriumLibrary.replaceDef and opens it in the symbol editor.
globalThis.AtriumDynamicSymbol = (() => {
  const A = () => globalThis.Atrium;
  const G = 2.54, EPS = 1e-4, MAX_PINS = 400;
  const r6 = v => Math.round(v * 1e6) / 1e6 + 0;
  const fail = m => { throw Error(m); };
  const isDynamic = d => !!d && d.dynamic !== null && typeof d.dynamic === "object" && Array.isArray(d.dynamic.pins);
  const natural = (a, b) => String(a).localeCompare(String(b), undefined, {numeric: true});

  // ------------------------------------------------------------------ geometry
  function bodyShapes(dyn) {
    const [x0, y0, x1, y1] = dyn.body;
    return [{kind: "path", style: "body", closed: true, fill: true, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]].map(p => p.map(r6))},
      {kind: "text", text: "dynamic", x: r6(x0 + .5), y: r6(y1 - .6), size: 1.27, align: "left", style: "body"}];
  }
  // Edge of the body a symbol-local point sits on (corners excluded), or null.
  function edgeOf(body, q) {
    const [x0, y0, x1, y1] = body, inY = q[1] > y0 + EPS && q[1] < y1 - EPS, inX = q[0] > x0 + EPS && q[0] < x1 - EPS;
    if (inY && Math.abs(q[0] - x0) < EPS) return "left";
    if (inY && Math.abs(q[0] - x1) < EPS) return "right";
    if (inX && Math.abs(q[1] - y0) < EPS) return "up";
    if (inX && Math.abs(q[1] - y1) < EPS) return "down";
    return null;
  }
  // World point -> symbol coordinates of a placed part (inverse of Atrium.world).
  function local(p, item) {
    const q = A().rotate([p[0] - (item.x || 0), p[1] - (item.y || 0)], -(item.angle || 0));
    return [r6(item.mirror ? -q[0] : q[0]), r6(q[1])];
  }
  const pinLength = dyn => Math.min(G, Math.max(1.27, (dyn.body[2] - dyn.body[0]) / 4));

  // ------------------------------------------------------------------ definitions
  function header(n, rows, id) {
    const W = globalThis.AtriumFootprintWizard;
    const cols = rows === 2 ? Math.max(1, Math.ceil(n / 2)) : Math.max(1, n);
    if (W?.generate) {
      try {
        const def = W.generate({family: "header", rows: rows === 2 ? 2 : 1, cols, pitch: 2.54, lead: .64, numbering: "zigzag", symbol: false, id});
        if (def?.footprint) return def.footprint;
      } catch { /* fall back to plain pads */ }
    }
    // Without the wizard (headless runners that skip it): plain 1.7 mm pads, 1.0 mm drill.
    const pads = [];
    for (let i = 0; i < Math.max(1, n); i++) {
      const r = rows === 2 ? i % 2 : 0, c = rows === 2 ? Math.floor(i / 2) : i;
      pads.push({number: String(i + 1), x: r6((r - (rows === 2 ? .5 : 0)) * 2.54), y: r6((c - (cols - 1) / 2) * 2.54), w: 1.7, h: 1.7, drill: 1, shape: i ? "round" : "rect", angle: 0});
    }
    return {name: "HDR" + (rows === 2 ? "2X" : "1X") + cols, pads, shapes: []};
  }
  // Rebuild symbol, pin text and footprint from def.dynamic.
  function rebuild(def) {
    const dyn = def.dynamic, L = globalThis.AtriumLibrary;
    const len = pinLength(dyn);
    // Split across sheets (addPart): dyn.parts gates share the body; each pin belongs to one gate.
    const parts = Math.max(1, dyn.parts | 0 || 1);
    const model = {pins: dyn.pins.map(p => ({number: p.number, name: p.name, x: p.x, y: p.y, orientation: p.orientation, length: len, electrical: 4, ...(parts > 1 ? {part: p.part || 1} : {})})),
      shapes: parts > 1 ? Array.from({length: parts}, (_, k) => bodyShapes(dyn).map(s => ({...s, part: k + 1}))).flat() : bodyShapes(dyn), parts};
    if (L?.buildSymbol) {
      const built = L.buildSymbol(model);
      def.symbol = built.symbol;
      if (built.schDrawing) def.schDrawing = built.schDrawing; else delete def.schDrawing;
    } else {
      def.symbol = {pins: model.pins.map(p => ({...p})), shapes: model.shapes};
      delete def.schDrawing;
    }
    const count = Math.max(1, dyn.pins.length);
    if (!def.footprint || (def.footprint.pads || []).length !== count || dyn.footprintRows !== dyn.rows) {
      def.footprint = header(count, dyn.rows, def.id);
      dyn.footprintRows = dyn.rows;
    }
    return def;
  }
  function make(o = {}) {
    const rows = o.rows === 2 ? 2 : 1, h = Math.max(2, Math.min(200, o.height | 0 || 6)) * G, w = Math.max(2, Math.min(20, o.width | 0 || 4)) * G;
    const def = {id: A().id(), name: o.name || "Dynamic Connector", prefix: o.prefix || "J", value: o.value ?? "CONN", category: "Connectors",
      description: "Dynamic connector: wire to its edge to add pins.",
      dynamic: {body: [r6(-w / 2), r6(-h / 2), r6(w / 2), r6(h / 2)], rows, pitch: G, pins: []}};
    return rebuild(def);
  }
  // Place a new dynamic connector (its own definition) at p on a schematic. Returns {def, part}.
  function place(project, doc, p, o = {}) {
    if (doc?.kind !== "schematic") fail("Dynamic connectors go on a schematic sheet.");
    const def = make(o);
    project.library.push(def);
    const at = [A().snap(p?.[0] ?? 0, G), A().snap(p?.[1] ?? 0, G)];
    const part = A().instantiate(project, def, at, o.angle || 0);
    doc.items.push(part);
    return {def, part};
  }
  const nextNumber = dyn => String(Math.max(0, ...dyn.pins.map(p => parseInt(p.number, 10)).filter(Number.isFinite)) + 1);
  // Grow the body so the next pin slot on the left/right edges stays free.
  function grow(dyn) {
    const [, y0, , y1] = dyn.body, sides = dyn.pins.filter(p => p.orientation === "left" || p.orientation === "right");
    const bottomPins = dyn.pins.some(p => p.orientation === "down");
    if (!bottomPins && sides.some(p => p.y >= y1 - G - EPS) && y1 - y0 < 200 * G) dyn.body = [dyn.body[0], y0, dyn.body[2], r6(y1 + G)];
  }

  // ------------------------------------------------------------------ settle (editor.js edit())
  // Adds a pin for every wire end on a dynamic body edge, names pins from net labels.
  // Returns the number of pins added or renamed.
  function settle(project, doc) {
    if (doc?.kind !== "schematic" || !project?.library?.some?.(isDynamic)) return 0;
    const dynDefs = new Map(project.library.filter(isDynamic).map(d => [d.id, d]));
    const parts = doc.items.filter(i => i.kind === "part" && dynDefs.has(i.def));
    if (!parts.length) return 0;
    const ends = [];
    for (const w of doc.items) if (w.kind === "wire" && w.points?.length >= 2) ends.push(w.points[0], w.points.at(-1));
    const touched = new Set();
    let changes = 0;
    for (const part of parts) {
      const def = dynDefs.get(part.def), dyn = def.dynamic;
      for (const p of ends) {
        if (dyn.pins.length >= MAX_PINS) break;
        const q = local(p, part), edge = edgeOf(dyn.body, q), gate = dyn.parts > 1 ? part.unit || part.part || 1 : 0;
        if (!edge || dyn.pins.some(x => (!gate || (x.part || 1) === gate) && Math.abs(x.x - q[0]) < EPS && Math.abs(x.y - q[1]) < EPS)) continue;
        const number = nextNumber(dyn);
        dyn.pins.push({number, name: number, x: q[0], y: q[1], orientation: edge, auto: true, ...(gate ? {part: gate} : {})});
        grow(dyn); touched.add(def); changes++;
      }
    }
    for (const def of touched) rebuild(def);
    // Auto-named pins take the net label of their net.
    const auto = parts.some(part => dynDefs.get(part.def).dynamic.pins.some(p => p.auto));
    if (auto) {
      let net = null;
      try { net = A().connectivity(doc, new Map(project.library.map(d => [d.id, d]))); } catch { net = null; }
      if (net) for (const part of parts) {
        const def = dynDefs.get(part.def);
        let renamed = false;
        for (const pin of def.dynamic.pins) {
          // A pin of another part (on another sheet) has no net here: keep its name.
          if (!pin.auto || (def.dynamic.parts > 1 && (pin.part || 1) !== (part.unit || part.part || 1))) continue;
          const n = net.byPin.get(part.id + "/" + pin.number), name = n && !A().isAutoNetName(n) ? n : pin.number;
          if (name !== pin.name) { pin.name = name; renamed = true; }
        }
        if (renamed) { rebuild(def); changes++; }
      }
    }
    return changes;
  }

  // ------------------------------------------------------------------ pin edits
  function defOf(project, idOrPart) {
    const d = project.library.find(x => x.id === idOrPart) || project.library.find(x => x.id === idOrPart?.def);
    if (!isDynamic(d)) fail("That part is not a dynamic connector.");
    return d;
  }
  function rename(project, defId, number, name) {
    const def = defOf(project, defId), pin = def.dynamic.pins.find(p => p.number === String(number)) || fail("The connector has no pin " + number + ".");
    const n = String(name ?? "").trim().slice(0, 100);
    pin.name = n || pin.number;
    if (n) delete pin.auto; else pin.auto = true;
    return rebuild(def);
  }
  // order: pin numbers in their new order; pin k gets number k+1 (positions stay, so wires stay).
  function reorder(project, defId, order) {
    const def = defOf(project, defId), pins = def.dynamic.pins;
    const by = new Map(pins.map(p => [p.number, p])), seen = new Set();
    const list = order.map(String).map(n => { const p = by.get(n); if (!p || seen.has(n)) fail("Give each pin number once."); seen.add(n); return p; });
    for (const p of pins) if (!seen.has(p.number)) list.push(p);
    list.forEach((p, i) => { const was = p.number; p.number = String(i + 1); if (p.auto && p.name === was) p.name = p.number; });
    def.dynamic.pins = list;
    return rebuild(def);
  }
  function move(project, defId, number, delta) {
    const def = defOf(project, defId), order = def.dynamic.pins.map(p => p.number).sort(natural), i = order.indexOf(String(number)), j = i + delta;
    if (i < 0 || j < 0 || j >= order.length) return def;
    [order[i], order[j]] = [order[j], order[i]];
    return reorder(project, defId, order);
  }
  function setRows(project, defId, rows) { const def = defOf(project, defId); def.dynamic.rows = rows === 2 ? 2 : 1; return rebuild(def); }
  // Another part (gate) of the same connector on any sheet: same designator and link, the next unit.
  // Pins wired to it are numbered on from the other parts.
  function addPart(project, defId, doc, p) {
    if (doc?.kind !== "schematic") fail("Dynamic connector parts go on a schematic sheet.");
    const def = defOf(project, defId), dyn = def.dynamic, have = Math.max(1, dyn.parts | 0 || 1);
    if (have >= 26) fail("A dynamic connector has at most 26 parts.");
    const first = project.documents.flatMap(d => d.items).find(i => i.kind === "part" && i.def === def.id) || fail("Place the connector first.");
    if (have === 1) for (const pin of dyn.pins) pin.part = 1;
    dyn.parts = have + 1;
    for (const d of project.documents) for (const i of d.items) if (i.kind === "part" && i.def === def.id && !(i.unit || i.part)) i.unit = 1;
    rebuild(def);
    const part = A().instantiate(project, def, [A().snap(p?.[0] ?? 0, G), A().snap(p?.[1] ?? 0, G)], 0, first);
    part.unit = dyn.parts;
    doc.items.push(part);
    return part;
  }
  // A normal library symbol from a dynamic one, through the symbol editor's model (same pin
  // positions, so wires stay connected). Returns the frozen definition.
  function freeze(project, defId, o = {}) {
    const def = defOf(project, defId), L = globalThis.AtriumLibrary;
    if (!def.dynamic.pins.length) fail("Wire at least one pin before freezing the connector.");
    rebuild(def);
    const frozen = JSON.parse(JSON.stringify(def));
    delete frozen.dynamic;
    frozen.name = o.name || (def.name === "Dynamic Connector" ? "Connector " + def.dynamic.pins.length + " pins" : def.name);
    frozen.description = "Connector, " + def.dynamic.pins.length + " pins";
    frozen.symbol.shapes = frozen.symbol.shapes.filter(s => !(s.kind === "text" && s.text === "dynamic"));
    if (L?.replaceDef) L.replaceDef(project, frozen);
    else project.library[project.library.indexOf(def)] = frozen;
    return frozen;
  }

  // ------------------------------------------------------------------ headless (MCP run_command dynamic_symbol)
  function headless(project, a = {}) {
    const op = a.op || "list";
    const sheet = () => {
      const d = a.document_id != null ? project.documents.find(x => x.id === a.document_id || x.name === a.document_id) : project.documents.find(x => x.kind === "schematic");
      if (!d) fail("The project has no schematic" + (a.document_id != null ? " " + a.document_id : "") + ".");
      if (d.kind !== "schematic") fail("Choose a schematic document.");
      return d;
    };
    const row = d => ({def_id: d.id, name: d.name, rows: d.dynamic?.rows, pins: (d.dynamic?.pins || d.symbol?.pins || []).map(p => ({number: p.number, name: p.name, x: p.x, y: p.y, side: p.orientation})),
      footprint_pads: d.footprint?.pads?.length || 0, dynamic: isDynamic(d)});
    const target = () => {
      if (a.def_id) return defOf(project, a.def_id).id;
      if (a.designator) {
        for (const d of project.documents) for (const i of d.items) if (i.kind === "part" && i.ref === a.designator && isDynamic(project.library.find(x => x.id === i.def))) return i.def;
        fail("No dynamic connector " + a.designator + ".");
      }
      fail("Give def_id or designator.");
    };
    if (op === "list") return {connectors: project.library.filter(isDynamic).map(row)};
    if (op === "place") { const doc = sheet(); const r = place(project, doc, [a.x ?? 0, a.y ?? 0], {rows: a.rows, height: a.height, width: a.width, name: a.name}); return {document_id: doc.id, part_id: r.part.id, designator: r.part.ref, ...row(r.def)}; }
    if (op === "settle") { const doc = sheet(); return {document_id: doc.id, changes: settle(project, doc), connectors: project.library.filter(isDynamic).map(row)}; }
    const id = target();
    if (op === "rename") return row(rename(project, id, a.number, a.name));
    if (op === "reorder") return row(reorder(project, id, a.order || []));
    if (op === "rows") return row(setRows(project, id, a.rows));
    if (op === "add_part") { const doc = sheet(), part = addPart(project, id, doc, [a.x ?? 0, a.y ?? 0]); return {document_id: doc.id, part_id: part.id, unit: part.unit, ...row(defOf(project, id))}; }
    if (op === "finalise") return row(freeze(project, id, {name: a.name}));
    if (op === "freeze") return row(freeze(project, id, {name: a.name}));
    fail("Unknown dynamic symbol operation " + op + ".");
  }

  // ------------------------------------------------------------------ editor UI
  // The stylesheet loads with the first dialog (lazy.js loads scripts only for this module).
  function ensureCss() {
    if (typeof document === "undefined" || !document.head || document.querySelector?.('link[href="pcb/component-classes.css"]')) return;
    const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "pcb/component-classes.css"; document.head.append(l);
  }
  let H = null;
  function el(tag, text, cls) { return AtriumNavCommon.el(tag, text, cls); }
  function button(text, click, cls) { const b = el("button", text, cls); b.type = "button"; b.onclick = click; return b; }
  function selectedDynamic(host) {
    const p = host.project(), doc = host.doc(), sel = new Set(host.selection());
    const part = doc.items.find(i => sel.has(i.id) && i.kind === "part" && isDynamic(p.library.find(d => d.id === i.def)));
    return part || null;
  }
  function placeCommand(host) {
    const doc = host.doc();
    if (doc?.kind !== "schematic") { host.info("Open a schematic sheet to place a dynamic connector."); return; }
    const at = host.pointer?.() || [0, 0];
    let made = null;
    host.edit(() => { made = place(host.project(), host.doc(), at); });
    host.select([made.part.id], made.part.id);
    host.info("Placed " + made.part.ref + ". Draw wires to its edge to add pins; Design → Dynamic Connector Pins… renames, reorders and freezes them.");
  }
  function pinsDialog(host) {
    const part = selectedDynamic(host);
    if (!part) { host.info("Select a dynamic connector on the schematic first."); return null; }
    ensureCss();
    const d = el("dialog", null, "work-dialog ds-dialog"); d.setAttribute("aria-label", "Dynamic Connector Pins");
    const status = el("p", null, "ds-status"); status.setAttribute("role", "status");
    const table = el("div", null, "ds-pins");
    const say = t => { status.textContent = t || ""; };
    const safe = fn => (...a) => { try { say(""); fn(...a); } catch (e) { say(e.message); } };
    const def = () => host.project().library.find(x => x.id === part.def);
    function paint() {
      const cur = def();
      table.replaceChildren();
      if (!isDynamic(cur)) { d.close(); return; }
      const pins = [...cur.dynamic.pins].sort((a, b) => natural(a.number, b.number));
      if (!pins.length) table.append(el("p", "No pins yet. Draw a wire to the connector's edge to add one.", "ds-empty"));
      for (const p of pins) {
        const row = el("div", null, "ds-row"), name = el("input");
        name.value = p.auto ? "" : p.name; name.placeholder = p.name; name.setAttribute("aria-label", "Name of pin " + p.number);
        name.onchange = safe(() => { host.edit(() => rename(host.project(), cur.id, p.number, name.value)); paint(); });
        row.append(el("span", p.number, "ds-number"), name, el("small", p.orientation, "ds-side"),
          button("↑", safe(() => { host.edit(() => move(host.project(), cur.id, p.number, -1)); paint(); }), "ds-move"),
          button("↓", safe(() => { host.edit(() => move(host.project(), cur.id, p.number, 1)); paint(); }), "ds-move"));
        row.querySelectorAll(".ds-move").forEach((b, i) => b.setAttribute("aria-label", (i ? "Move down " : "Move up ") + "pin " + p.number));
        table.append(row);
      }
      rows.checked = cur.dynamic.rows === 2;
      head.textContent = part.ref + " · " + pins.length + " pin" + (pins.length === 1 ? "" : "s") + " · footprint " + (cur.footprint?.name || "");
    }
    const head = el("p", null, "ds-head");
    const rowsLabel = el("label", null, "ds-rows"), rows = el("input"); rows.type = "checkbox";
    rows.onchange = safe(() => { host.edit(() => setRows(host.project(), part.def, rows.checked ? 2 : 1)); paint(); });
    rowsLabel.append(rows, document.createTextNode(" Two-row header footprint"));
    const foot = el("div", null, "work-actions");
    const freezeBtn = button("Freeze as library symbol", safe(() => {
      let frozen = null;
      host.edit(() => { frozen = freeze(host.project(), part.def); });
      d.close();
      host.info(frozen.name + " is now a normal library symbol.");
      const L = globalThis.AtriumLibrary;
      if (L?.openSymbolEditor) L.openSymbolEditor({info: host.info, currentProject: host.project, edit: host.edit, placeDef: null}, host.project().library.find(x => x.id === frozen.id));
    }));
    // Finalise… and Add Part… (generic-parts-ui.js, loaded on first use through the editor's action gate).
    if (host.act) { freezeBtn.textContent = "Finalise…"; freezeBtn.onclick = () => { d.close(); host.act("dynamic-connector-finalise"); };
      foot.append(button("Add Part on Another Sheet…", () => { d.close(); host.act("dynamic-connector-add-part"); })); }
    foot.append(freezeBtn, button("Done", () => d.close(), "is-primary"));
    d.append(el("h2", "Dynamic Connector Pins"), head, el("p", "Pins are added where wires meet the body edge. Rename them here; ↑ ↓ renumber them (wires stay put).", "ds-help"), table, rowsLabel, status, foot);
    document.body.append(d); d.addEventListener("close", () => { d.remove(); host.redraw?.(); }, {once: true});
    globalThis.AtriumShell?.adoptDialog?.(d, {title:d.firstElementChild, body:[head,table,rowsLabel,status], actions:foot});
    paint(); d.showModal();
    return d;
  }
  let installed = false;
  function install(host) {
    H = host;
    host.registerAction("dynamic-connector", () => placeCommand(host));
    host.registerAction("dynamic-connector-pins", () => pinsDialog(host));
    if (installed) return;
    installed = true;
    const NC = globalThis.AtriumNavCommon;
    NC?.menuItem?.("place", "dynamic-connector", "Dynamic Connector", {after: "sch-power", scope: "schematic"});
    NC?.menuItem?.("design", "dynamic-connector-pins", "Dynamic Connector Pins…", {after: "symbol-editor", scope: "schematic"});
  }
  const boot = () => globalThis.AtriumNavCommon?.ready?.(install);
  if (globalThis.AtriumNavCommon) boot(); else if (globalThis.document?.addEventListener) document.addEventListener("DOMContentLoaded", boot, {once: true});

  return Object.freeze({isDynamic, make, place, settle, rebuild, rename, reorder, move, setRows, addPart, freeze, headless, edgeOf, local, header, install});
})();
