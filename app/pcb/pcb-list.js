"use strict";
// List panel (Panels → List; Altium's SCH List and PCB List in one panel): a docked, windowed
// grid of the selected objects, or of every object of a kind, on the sheet or board in view.
// It is titled SCH List on a sheet and PCB List on a board; board-only columns hide on sheets.
// Edit a cell in place (double-click, F2 or type), paste a column from a spreadsheet,
// or set one field on every selected row with the bulk-edit bar. Each edit is one undo
// step however many objects it touches.
//
// Headless API (pure):
//   AtriumPCBList.rows(doc, defs, {kinds, ids})                → [{id, kind, item, cells}]
//   AtriumPCBList.apply(doc, defs, ids, field, text, {unit})    → {changed, skipped, errors}  (mutates; call inside edit())
//   AtriumPCBList.editable(field, item)                         → bool
globalThis.AtriumPCBList = (() => {
  const C = globalThis.AtriumNavCommon;
  const A = () => globalThis.Atrium;
  // One List panel for both editors (Altium's SCH List and PCB List): the same grid, editing and
  // bulk-set; the object kinds and the board-only columns (pcb:true) follow the document.
  const KINDS = {part:"Component", track:"Track", via:"Via", pad:"Pad", label:"Text", polygon:"Polygon", graphic:"Graphic"};
  const SCH_KINDS = {part:"Component", wire:"Wire", bus:"Bus", netlabel:"Net Label", power:"Power Port", port:"Port", offsheet:"Off Sheet Connector",
    junction:"Junction", text:"Text", sheetsymbol:"Sheet Symbol"};
  const kindsOf = doc => doc?.kind === "schematic" ? SCH_KINDS : KINDS;
  const NAMED = new Set(["label", "netlabel", "power", "port", "offsheet", "text"]), PLACED = ["netlabel", "power", "port", "offsheet", "text", "junction", "sheetsymbol"];
  // Field, header, which kinds have it, which kinds may edit it.
  const FIELDS = [
    {key:"kind", label:"Object", read:i => KINDS[i.kind] || SCH_KINDS[i.kind] || i.kind},
    {key:"name", label:"Designator / Text", read:i => i.kind === "part" ? i.ref : i.kind === "pad" ? i.number ?? "" : i.kind === "sheetsymbol" ? i.name ?? "" : NAMED.has(i.kind) ? i.text ?? "" : "",
      edit:["part", ...NAMED, "sheetsymbol"]},
    {key:"value", label:"Comment", read:i => i.kind === "part" ? i.value ?? "" : "", edit:["part"]},
    {key:"layer", label:"Layer", pcb:true, read:i => i.layer || (i.kind === "via" ? "Multi" : i.kind === "part" ? "Top" : ""), edit:["track", "label", "graphic", "polygon", "pad"]},
    {key:"net", label:"Net", pcb:true, read:i => i.kind === "part" ? "" : i.net || "", edit:["track", "via", "pad", "polygon"]},
    {key:"x", label:"X", length:true, read:i => i.points ? i.points[0][0] : i.x, edit:["part", "via", "pad", "label", ...PLACED]},
    {key:"y", label:"Y", length:true, read:i => i.points ? i.points[0][1] : i.y, edit:["part", "via", "pad", "label", ...PLACED]},
    {key:"width", label:"Width", pcb:true, length:true, read:i => i.kind === "track" || i.kind === "graphic" || i.kind === "polygon" ? i.width : null, edit:["track", "graphic"], min:.001},
    {key:"size", label:"Size", pcb:true, length:true, read:i => i.kind === "via" ? i.diameter : i.kind === "pad" ? i.w : i.kind === "label" ? i.size : null, edit:["via", "pad", "label"], min:.001},
    {key:"drill", label:"Hole", pcb:true, length:true, read:i => i.kind === "via" || i.kind === "pad" ? i.drill ?? null : null, edit:["via", "pad"], min:0},
    {key:"rotation", label:"Rotation", read:i => ["part", "pad", "label", "port", "offsheet"].includes(i.kind) ? i.angle || 0 : null, edit:["part", "pad", "label", "port", "offsheet"]},
    {key:"length", label:"Length", pcb:true, length:true, read:i => i.points && i.kind === "track" ? A().pathLength(i) : null}
  ];
  const FIELD = Object.fromEntries(FIELDS.map(f => [f.key, f]));
  const editable = (field, item) => !!FIELD[field]?.edit?.includes(item.kind);

  function rows(doc, defs, {kinds = null, ids = null} = {}) {
    const want = ids ? new Set(ids) : null, ks = kinds ? new Set(kinds) : null, out = [];
    for (const i of doc.items) {
      if (want && !want.has(i.id)) continue;
      if (ks && !ks.has(i.kind)) continue;
      if (!kindsOf(doc)[i.kind]) continue;
      const cells = {};
      for (const f of FIELDS) cells[f.key] = f.read(i);
      out.push({id:i.id, kind:i.kind, item:i, cells});
    }
    return out;
  }
  // Apply one field to many objects. Text is parsed in the display unit (suffixes win).
  function apply(doc, defs, ids, field, text, {unit = "mm", layers = null, touched = null} = {}) {
    const f = FIELD[field], U = A().units, want = new Set(ids), res = {changed:0, skipped:0, errors:[]};
    if (!f?.edit) {res.errors.push("“" + (f?.label || field) + "” cannot be edited."); return res;}
    const raw = String(text ?? "").trim();
    let num = null;
    if (f.length) {
      num = U.parse(raw, unit);
      if (!Number.isFinite(num) || Math.abs(num) > 1e7 || (f.min != null && num < f.min)) {res.errors.push("Enter a length such as 0.25mm or 10mil" + (f.min ? " (at least " + U.format(f.min, unit) + ")" : "") + "."); return res;}
    }
    if (field === "rotation") {num = Number(raw.replace(/°$/, "")); if (!Number.isFinite(num)) {res.errors.push("Enter an angle in degrees."); return res;} num = ((num % 360) + 360) % 360;}
    if (field === "layer" && layers && !layers.includes(raw)) {res.errors.push("Unknown layer “" + raw + "”. Use one of: " + layers.join(", ") + "."); return res;}
    if ((field === "name") && !raw) {res.errors.push("Enter a designator or text."); return res;}
    const refs = field === "name" ? new Set(doc.items.filter(i => i.kind === "part" && !want.has(i.id)).map(i => i.ref)) : null;
    for (const i of doc.items) {
      if (!want.has(i.id)) continue;
      if (!f.edit.includes(i.kind)) {res.skipped++; continue;}
      const def = defs?.get?.(i.def);
      let moved;
      switch (field) {
        case "name":
          if (i.kind === "part") {if (refs.has(raw) || want.size > 1) {res.skipped++; continue;} i.ref = raw;} else if (i.kind === "sheetsymbol") i.name = raw; else i.text = raw;
          break;
        case "value": i.value = raw; break;
        case "net": i.net = raw; break;
        case "layer": i.layer = raw; break;
        case "width": i.width = num; break;
        case "drill":
          if (i.kind === "via" && num >= i.diameter) {res.skipped++; continue;}
          if (i.kind === "pad" && num >= Math.min(i.w, i.h) && num > 0) {res.skipped++; continue;}
          i.drill = num; break;
        case "size":
          if (i.kind === "via") {if (num <= (i.drill || 0)) {res.skipped++; continue;} i.diameter = num;}
          else if (i.kind === "pad") {const k = num / (i.w || num); i.w = num; i.h = Number(((i.h || num) * k).toFixed(6));}
          else i.size = num;
          break;
        case "x": case "y":
          if (i.kind === "part") moved = A().transformPart(doc, i, def, {[field]:num});
          else i[field] = num;
          break;
        case "rotation":
          if (i.kind === "part") moved = A().transformPart(doc, i, def, {angle:num}); else i.angle = num;
          break;
        default: res.skipped++; continue;
      }
      if (touched) for (const item of moved || [i]) touched.add(item);
      res.changed++;
    }
    return res;
  }

  // ------------------------------------------------------------------ UI
  let host = null, panel = null, ui = null, list = [], picked = new Set(), activeR = 0, activeC = 1, editor = null, timer = 0;
  const state = {scope:"selection", kind:""};
  const columns = () => FIELDS.filter(f => (!f.pcb || host?.doc?.().kind === "pcb") && (!state.kind || f.key === "kind" || FIELDS_FOR(state.kind).includes(f.key)));
  const listTitle = () => host?.doc?.().kind === "schematic" ? "SCH List" : "PCB List";
  const FIELDS_FOR = k => FIELDS.filter(f => f.key === "kind" || f.read({kind:k, points:k === "track" || k === "graphic" || k === "polygon" ? [[0, 0], [1, 0]] : null, x:0, y:0, w:1, h:1, diameter:1, drill:0, size:1, width:1, angle:0, ref:"", text:"", value:"", number:"", net:"", layer:"Top"}) != null || f.edit?.includes(k)).map(f => f.key);
  function compute() {
    const d = host.doc();
    if (d.kind !== "pcb" && d.kind !== "schematic") {list = []; return;}
    const ids = state.scope === "selection" ? host.selection() : null;
    list = rows(d, host.defs(), {kinds:state.kind ? [state.kind] : null, ids});
    const live = new Set(list.map(r => r.id));
    for (const id of [...picked]) if (!live.has(id)) picked.delete(id);
  }
  function fmt(f, v) {
    if (v == null || v === "") return "";
    if (f.length && typeof v === "number") return A().units.value(v, host.units()).toString();
    if (f.key === "rotation") return Number(v.toFixed(3)) + "°";
    return String(v);
  }
  function build() {
    panel = C.el("section", null, "pl-panel"); panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "PCB List"); panel.hidden = true;
    const grip = C.el("div", null, "msg-grip pl-grip"); grip.setAttribute("aria-hidden", "true");
    const head = C.el("header", null, "pl-head ui-toolbar"); head.dataset.table = "";
    const scope = C.el("select", null, "ui-compact-field"); scope.setAttribute("aria-label", "Rows");
    scope.add(new Option("Selected objects", "selection")); scope.add(new Option("All objects", "all"));
    scope.onchange = () => {state.scope = scope.value; refresh();};
    const kind = C.el("select", null, "ui-compact-field"); kind.setAttribute("aria-label", "Object kind");
    kind.onchange = () => {state.kind = kind.value; refresh();};
    const countNode = C.el("span", null, "pl-count");
    const field = C.el("select", null, "ui-compact-field"); field.setAttribute("aria-label", "Field to set");
    const value = C.el("input", null, "ui-compact-field"); value.type = "text"; value.placeholder = "Value"; value.setAttribute("aria-label", "New value"); value.spellcheck = false;
    const applyBtn = C.button("Set", bulk, "pl-apply ui-button", "Set this field on the chosen rows (one undo step)");
    applyBtn.dataset.variant = "primary"; applyBtn.dataset.size = "sm";
    value.addEventListener("keydown", e => {if (e.key === "Enter") {e.preventDefault(); bulk();} e.stopPropagation();});
    const close = C.button("×", () => toggle(false), "ui-close msg-close", "Close List");
    const title = C.el("h2", "PCB List");
    head.append(title, scope, kind, countNode, C.el("span", null, "ui-toolbar-spacer"), C.el("span", "Set", "pl-label"), field, value, applyBtn, close);
    const scroller = C.el("div", null, "pl-grid"); scroller.tabIndex = 0;
    scroller.setAttribute("role", "grid"); scroller.setAttribute("aria-label", "Board objects"); scroller.setAttribute("aria-multiselectable", "true");
    const table = C.el("table"), thead = C.el("thead"), tbody = C.el("tbody");
    table.append(thead, tbody); scroller.append(table);
    const foot = C.el("footer", null, "msg-foot"), status = C.el("span"), hint = C.el("span", null, "msg-hint");
    hint.append("Click selects · Shift-click extends the selection · Double-click or ", AtriumShortcut.render("F2", {variant:"inline"}),
      " edits · ", AtriumShortcut.render("Mod+V", {variant:"inline"}), " pastes a column");
    status.setAttribute("role", "status"); foot.append(status, hint);
    panel.append(grip, head, scroller, foot);
    document.body.append(panel);
    const grid = AtriumWindowedTable(scroller, tbody, () => columns().length, paintRow, {rowHeight:22});
    ui = {title, scope, kind, kindFor: null, countNode, field, value, applyBtn, scroller, thead, tbody, grid, status};
    tbody.addEventListener("click", e => {const tr = e.target.closest("tr[data-r]"); if (!tr) return; const td = e.target.closest("td[data-c]"); clickRow(Number(tr.dataset.r), td ? Number(td.dataset.c) : activeC, e);});
    tbody.addEventListener("dblclick", e => {const td = e.target.closest("td[data-c]"), tr = e.target.closest("tr[data-r]"); if (td && tr) beginEdit(Number(tr.dataset.r), Number(td.dataset.c));});
    scroller.addEventListener("keydown", keys);
    scroller.addEventListener("paste", pasteColumn);
    grip.onpointerdown = e => {
      e.preventDefault(); grip.setPointerCapture(e.pointerId);
      const start = e.clientY, height = panel.getBoundingClientRect().height;
      grip.onpointermove = m => {panel.style.height = Math.max(120, Math.min(innerHeight * .8, height + start - m.clientY)) + "px"; grid.refresh();};
      grip.onpointerup = () => {grip.onpointermove = grip.onpointerup = null;};
    };
  }
  function header() {
    const tr = C.el("tr"), cols = columns();
    cols.forEach(f => {const th = C.el("th", f.label + (f.length ? " (" + host.units() + ")" : "")); th.scope = "col"; if (f.edit) th.classList.add("pl-editable"); tr.append(th);});
    ui.thead.replaceChildren(tr);
    const fields = cols.filter(f => f.edit && list.some(r => editable(f.key, r.item)));
    const prev = ui.field.value;
    ui.field.replaceChildren(...fields.map(f => new Option(f.label, f.key)));
    if (fields.some(f => f.key === prev)) ui.field.value = prev;
    ui.field.disabled = ui.value.disabled = ui.applyBtn.disabled = !fields.length || !list.length;
  }
  function paintRow(tr, r, i) {
    tr.setAttribute("aria-selected", String(picked.has(r.id)));
    if (picked.has(r.id)) tr.classList.add("is-picked");
    columns().forEach((f, c) => {
      const td = C.el("td", fmt(f, r.cells[f.key]));
      td.dataset.c = String(c);
      if (f.length || f.key === "rotation") td.className = "num";
      if (f.edit && editable(f.key, r.item)) td.classList.add("pl-can-edit");
      if (i === activeR && c === activeC) {td.classList.add("active"); td.id = "pl-active-cell";}
      tr.append(td);
    });
  }
  function refresh() {
    if (!panel || panel.hidden) return;
    if (editor) return;
    // The document kind picks the title (SCH List / PCB List) and the object kinds.
    const dk = host.doc().kind;
    if (ui.kindFor !== dk) {
      ui.kindFor = dk;
      const kinds = kindsOf(host.doc()), sheet = dk === "schematic";
      if (state.kind && !kinds[state.kind]) state.kind = "";
      ui.kind.replaceChildren(new Option("All kinds", ""), ...Object.entries(kinds).map(([k, label]) => new Option(label + (/s$/.test(label) ? "es" : "s"), k)));
      ui.kind.value = state.kind;
      ui.title.textContent = listTitle(); panel.setAttribute("aria-label", listTitle());
      ui.scroller.setAttribute("aria-label", sheet ? "Sheet objects" : "Board objects");
    }
    compute(); header();
    activeR = Math.min(activeR, Math.max(0, list.length - 1)); activeC = Math.min(activeC, columns().length - 1);
    ui.countNode.textContent = list.length + " object" + (list.length === 1 ? "" : "s") + (picked.size ? " · " + picked.size + " chosen" : "");
    ui.applyBtn.textContent = "Set on " + (picked.size || list.length);
    if (dk !== "pcb" && dk !== "schematic") ui.status.textContent = "Open a schematic sheet or a board layout to list its objects.";
    else if (!list.length) ui.status.textContent = state.scope === "selection" ? "Select objects on the " + (dk === "pcb" ? "board" : "sheet") + ", or show all objects." : "No objects of this kind.";
    else ui.status.textContent = "";
    ui.grid.refresh(list);
    if (list.length) ui.scroller.setAttribute("aria-activedescendant", "pl-active-cell");
  }
  function clickRow(r, c, e) {
    const row = list[r]; if (!row) return;
    if (e.shiftKey && list[activeR]) {const [a, b] = [Math.min(activeR, r), Math.max(activeR, r)]; for (let k = a; k <= b; k++) picked.add(list[k].id);}
    else if (e.ctrlKey || e.metaKey) {if (picked.has(row.id)) picked.delete(row.id); else picked.add(row.id);}
    else {picked = new Set([row.id]);}
    activeR = r; activeC = c;
    // Selecting rows selects the objects on the board (unless the list is the selection).
    if (state.scope !== "selection") host.select([...picked]);
    refresh();
  }
  function keys(e) {
    if (editor) return;
    const cols = columns().length;
    const mv = {ArrowDown:[1, 0], ArrowUp:[-1, 0], ArrowLeft:[0, -1], ArrowRight:[0, 1], PageDown:[10, 0], PageUp:[-10, 0]}[e.key];
    if (mv) {
      e.preventDefault(); e.stopPropagation();
      activeR = Math.max(0, Math.min(list.length - 1, activeR + mv[0])); activeC = Math.max(0, Math.min(cols - 1, activeC + mv[1]));
      if (e.shiftKey && mv[0] && list[activeR]) picked.add(list[activeR].id);
      ui.grid.scrollTo(activeR); refresh(); return;
    }
    if (e.key === " " && list[activeR]) {e.preventDefault(); e.stopPropagation(); const id = list[activeR].id; if (picked.has(id)) picked.delete(id); else picked.add(id); if (state.scope !== "selection") host.select([...picked]); refresh(); return;}
    if ((e.key === "a" || e.key === "A") && (e.ctrlKey || e.metaKey)) {e.preventDefault(); e.stopPropagation(); picked = new Set(list.map(r => r.id)); refresh(); return;}
    if (e.key === "F2" || e.key === "Enter") {e.preventDefault(); e.stopPropagation(); beginEdit(activeR, activeC); return;}
    if (e.key === "Escape") {e.preventDefault(); e.stopPropagation(); if (picked.size) {picked.clear(); refresh();} else toggle(false); return;}
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {e.preventDefault(); e.stopPropagation(); beginEdit(activeR, activeC, e.key); return;}
    if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
  }
  // Rows an edit applies to: every chosen row when the edited row is one of them.
  const targetsFor = row => picked.has(row.id) && picked.size > 1 ? [...picked] : [row.id];
  function beginEdit(r, c, initial) {
    const row = list[r], f = columns()[c];
    if (!row || !f || !editable(f.key, row.item)) {host.info(f ? "“" + f.label + "” is read-only for " + (FIELD.kind.read(row || {}) || "this object") + "." : ""); return;}
    activeR = r; activeC = c; ui.grid.refresh();
    const td = ui.tbody.querySelector('tr[data-r="' + r + '"] td[data-c="' + c + '"]');
    if (!td) return;
    const layers = f.key === "layer" ? layerChoices(row.item) : null;
    const input = layers ? C.el("select") : C.el("input");
    if (layers) for (const l of layers) input.add(new Option(l, l)); else {input.type = "text"; input.spellcheck = false;}
    input.value = initial ?? (f.length ? fmt(f, row.cells[f.key]) : f.key === "rotation" ? String(row.cells.rotation) : String(row.cells[f.key] ?? ""));
    input.className = "pl-cell-editor"; input.setAttribute("aria-label", f.label + " for " + (targetsFor(row).length > 1 ? targetsFor(row).length + " objects" : FIELD.kind.read(row.item)));
    td.replaceChildren(input); editor = input;
    const finish = commit => {
      if (editor !== input) return;
      editor = null;
      if (commit) set(targetsFor(row), f.key, input.value);
      refresh(); ui.scroller.focus({preventScroll:true});
    };
    input.addEventListener("keydown", e => {
      e.stopPropagation();
      if (e.key === "Enter" || e.key === "Tab") {e.preventDefault(); finish(true); if (e.key === "Tab") {activeC = Math.min(columns().length - 1, activeC + (e.shiftKey ? -1 : 1)); refresh();}}
      else if (e.key === "Escape") {e.preventDefault(); finish(false);}
    });
    input.addEventListener("blur", () => finish(true));
    input.focus(); if (input.select && initial == null) input.select();
  }
  function layerChoices(item) {
    const copper = globalThis.AtriumCanvas?.routingLayers?.(host.doc(), host.defs()) || ["Top", "Bottom"];
    if (item.kind === "track" || item.kind === "polygon") return copper;
    if (item.kind === "pad") return [...copper, "Multi"];
    return [...new Set([...copper, "Silk", "Bottom silk", "Mechanical", item.layer].filter(Boolean))];
  }
  function set(ids, field, text) {
    const d = host.doc();
    const touched = new Set();let res = null;
    try {
      host.edit(() => {
        res = apply(d, host.defs(), ids, field, text, {unit:host.units(), touched});
        if (res.errors.length || !res.changed) throw Object.assign(Error(res.errors[0] || "Nothing changed."), {quiet:!res.errors.length});
      }, undefined, touched);
    } catch (e) {host.info(e.message); return res;}
    host.info(FIELD[field].label + " set on " + res.changed + " object" + (res.changed === 1 ? "" : "s") + (res.skipped ? " · " + res.skipped + " skipped" : "") + " (one undo step)");
    return res;
  }
  function bulk() {
    const ids = picked.size ? [...picked] : list.map(r => r.id);
    if (!ids.length || !ui.field.value) return;
    if (set(ids, ui.field.value, ui.value.value)?.changed) ui.value.select();
  }
  // Paste lines from a spreadsheet down the active column, starting at the active row.
  function pasteColumn(e) {
    if (editor) return;
    const text = e.clipboardData?.getData("text/plain"); if (!text) return;
    const f = columns()[activeC], lines = text.replace(/\r/g, "").split("\n").filter((l, k, a) => l !== "" || k < a.length - 1).map(l => l.split("\t")[0]);
    if (!f?.edit) {host.info("“" + (f?.label || "This column") + "” is read-only."); return;}
    e.preventDefault();
    const d = host.doc(), touched = new Set();let changed = 0, failed = 0;
    try {
      host.edit(() => {
        lines.forEach((v, k) => {const row = list[activeR + k]; if (!row) return; const r = apply(d, host.defs(), [row.id], f.key, v, {unit:host.units(), touched}); changed += r.changed; if (r.errors.length) failed++;});
        if (!changed) throw Error("Nothing pasted.");
      }, undefined, touched);
    } catch (err) {host.info(err.message); return;}
    host.info("Pasted " + changed + " " + f.label.toLowerCase() + " value" + (changed === 1 ? "" : "s") + (failed ? " · " + failed + " rejected" : "") + " (one undo step)");
  }
  function toggle(show) {
    if (typeof document === "undefined") return;
    if (!panel) build();
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    C.setChecked("pcb-list", on);
    if (on) {refresh(); ui.scroller.focus({preventScroll:true});} else host.canvas()?.focus();
  }
  function open({scope = null, kind = null} = {}) {
    if (!panel) build();
    if (scope) {state.scope = scope; ui.scope.value = scope;}
    if (kind != null) {state.kind = kind; ui.kind.value = kind;}
    toggle(true);
  }
  function schedule() {if (!panel || panel.hidden) return; clearTimeout(timer); timer = setTimeout(refresh, 60);}

  function attach(h) {
    host = h;
    host.registerAction("pcb-list", () => toggle());
    host.on("change", schedule);
    host.on("document", schedule);
    host.on("selection", () => {if (state.scope === "selection") schedule();});
    if (typeof document === "undefined") return;
    C.menuItem("panels", "pcb-list", "List", {after:"nets-panel", checkable:true});
  }
  C?.ready(attach);

  return {rows, apply, editable, FIELDS, KINDS, SCH_KINDS, open, toggle, isOpen:() => !!panel && !panel.hidden, attach};
})();
