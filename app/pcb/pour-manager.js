"use strict";
// Pours panel (Window › Panels › Pours; Tools › Polygon Pours › Polygon Pour Manager): Altium's
// Polygon Pour Manager as a dock panel, non-modal, beside the board. Lazy: nothing here loads or
// listens until the panel is first opened, and while it is closed a board edit costs nothing.
//   List     every pour in pour order: name, net, layer, state (Current, Stale, Failed with its
//            reason and Retry, Shelved, Not Poured, Cutout), copper area, islands (dead ones
//            counted) and the last refill this session. Click a row: the pour is selected on the
//            board and zoomed to; a pour selected on the board highlights its row.
//   Bulk     Repour All, Repour Stale, Repour Selected, Shelve All, Restore All.
//   Pour     the selected pour's settings, each change one undo step: name, net, layer, clearance,
//            connect style, fill mode (Solid, Hatched, None (Outlines Only)), Remove Dead Copper,
//            Remove Islands Less Than (area), Remove Necks Less Than (width), arc approximation,
//            minimum primitive length, Locked; Repour, Shelve / Restore, pour order up and down.
// No hover pop-ups: every control says what it does in its label.
//
// DOM-free API (tests, MCP headless.js):
//   AtriumPourManager.rows(doc, defs)               -> [{id, name, net, layer, priority, ..., area, islands, dead, state, reason, refill}]
//   AtriumPourManager.setField(doc, id, key, value) -> mutates one polygon (validated); call inside edit()
//   AtriumPourManager.reorder(doc, ids)             -> pour order follows ids (priority 1 first)
//   AtriumPourManager.move(doc, ids, step)          -> moves those pours up (-1) or down (+1) in pour order
//   AtriumPourManager.shelve(doc, ids, on)          -> shelves (strips copper) or restores; returns the changed ids
//   AtriumPourManager.affected(doc, ids)            -> ids plus the poured pours after them on their layers
//   AtriumPourManager.repour(doc, defs, ids|null, o)-> AtriumPolygonPour.apply result
globalThis.AtriumPourManager = (() => {
  const G = globalThis;
  const PP = () => G.AtriumPolygonPour || fail("The polygon pour engine (polygon-pour.js) is not loaded.");
  const fail = m => { throw Error(m); };
  const STYLES = ["relief", "direct", "none", "auto"], FILLS = ["solid", "hatched", "outline"];
  // Editable fields: key -> [polygon field, kind]. "minWidth" is Altium's Min Prim Length;
  // "neckWidth" Remove Necks When Copper Width Less Than (blank or 0: off).
  const FIELDS = {name: ["name", "text"], net: ["net", "net"], layer: ["layer", "layer"], connectStyle: ["connectStyle", "style"],
    clearance: ["clearance", "length?"], minWidth: ["minPrimLength", "length"], fill: ["fillMode", "fill"], removeIslands: ["removeDeadCopper", "bool"],
    islandArea: ["islandAreaThreshold", "area"], neckWidth: ["neckWidth", "length?"], arcApproximation: ["arcApproximation", "length+"],
    enabled: ["shelved", "notbool"], locked: ["locked", "flag"]};

  // ------------------------------------------------------------------ model
  function ringArea(r) { let s = 0; const n = r.length >> 1; for (let i = 0, j = n - 1; i < n; j = i++) s += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1]; return Math.abs(s) / 2; }
  // Copper area of poured regions in mm²: each outline minus its holes.
  function area(regions) {
    let a = 0;
    for (const reg of regions) { const rs = PP().rings(reg); rs.forEach((r, k) => { a += k ? -ringArea(r) : ringArea(r); }); }
    return a;
  }
  function order(doc) {
    const P = PP();
    return (doc.items || []).map((item, index) => ({item, index})).filter(e => e.item.kind === "polygon")
      .sort((a, b) => (!!a.item.cutout - !!b.item.cutout) || P.settings(a.item).pourIndex - P.settings(b.item).pourIndex || a.index - b.index).map(e => e.item);
  }
  function rows(doc, defs, o = {}) {
    const P = PP(), list = order(doc), pours = doc.pcbDrawing?.pours || [];
    const failed = P.failures(doc), refills = P.refills(doc);
    let report = o.report;
    if(!report)try { report = P.inspectCopper(doc, defs, o); } catch { /* copper could not be verified */ }
    const by = new Map();
    for (const r of pours) if (r.polygon != null) { if (!by.has(r.polygon)) by.set(r.polygon, []); by.get(r.polygon).push(r); }
    const pending = new Set(P.live.running?.doc===doc ? P.live.running.ids : []);
    let rank = 0;
    return list.map(p => {
      const s = P.settings(p), regions = by.get(p.id) || [];
      const state = p.cutout ? "cutout" : p.shelved ? "shelved" : pending.has(p.id) ? "pending" :
        failed[p.id] ? "failed" : report ? P.ownerState(report,p.id) : "unknown";
      // A dead island: copper of a pour with a net that touches no object of that net (it stays when Remove Dead Copper is off).
      const dead = s.net ? regions.filter(r => !(r.links || []).length).length : 0;
      return {id: p.id, name: s.name || "", net: s.net, layer: s.layer, priority: p.cutout ? null : ++rank, pourIndex: s.pourIndex,
        connectStyle: s.connectStyle, clearance: s.clearance, minWidth: s.minPrimLength, fill: s.fillMode, removeIslands: s.removeDeadCopper,
        islandArea: s.islandAreaThreshold, neckWidth: s.neckWidth || 0, arcApproximation: s.arcApproximation, locked: p.locked === true,
        enabled: !p.shelved, cutout: !!p.cutout, regions: regions.length, islands: regions.length, dead, area: regions.length ? area(regions) : 0, state,
        reason: failed[p.id]?.reason || null, refill: refills[p.id] || null};
    });
  }
  const find = (doc, id) => (doc.items || []).find(i => i.id === id && i.kind === "polygon") || fail("No polygon pour has the ID " + id + ".");
  // One field of one pour. Values: lengths in mm (clearance and neck width null = from the rules / off), area in mm².
  function setField(doc, id, key, value) {
    const f = FIELDS[key] || fail("Unknown pour field " + key + ".");
    const p = find(doc, id), [prop, kind] = f, next = {...p};
    const numberOf = v => { const n = typeof v === "number" ? v : parseFloat(v); if (!Number.isFinite(n) || n < 0 || n > 1000) fail("Enter a value from 0 to 1000."); return n; };
    if (kind === "text") next[prop] = String(value ?? "").slice(0, 200);
    else if (kind === "net") next[prop] = String(value ?? "");
    else if (kind === "layer") next[prop] = String(value);
    else if (kind === "style") { if (!STYLES.includes(value)) fail("Connect style must be one of " + STYLES.join(", ") + "."); next[prop] = value; }
    else if (kind === "fill") { if (!FILLS.includes(value)) fail("Fill must be solid, hatched or outline."); next[prop] = value; }
    else if (kind === "bool") next[prop] = !!value;
    else if (kind === "notbool") next[prop] = !value;
    else if (kind === "flag") next[prop] = value ? true : null;
    else if (kind === "length?") next[prop] = value == null || value === "" || (prop === "neckWidth" && +value === 0) ? null : numberOf(value);
    else if (kind === "length+") { const n = numberOf(value); if (!(n > 0)) fail("Enter a value above 0."); next[prop] = n; }
    else next[prop] = numberOf(value);
    if (prop === "neckWidth" && next[prop] != null && next[prop] > 5) fail("Remove Necks Less Than takes a width up to 5 mm.");
    if (next[prop] === null) delete next[prop];
    PP().validate(next);
    if (next[prop] === undefined) delete p[prop]; else p[prop] = next[prop];
    // Shelving removes the pour's copper at once (Altium Shelve); un-shelving leaves it to repour.
    if (key === "enabled" && !value) PP().strip(doc, [id]);
    return p;
  }
  // Pour order (priority 1 pours first and wins) follows `ids`; pours not listed keep their
  // relative order after them. Cutouts have no order.
  function reorder(doc, ids) {
    const list = order(doc).filter(p => !p.cutout), pos = new Map(ids.map((id, i) => [id, i]));
    const sorted = [...list.filter(p => pos.has(p.id)).sort((a, b) => pos.get(a.id) - pos.get(b.id)), ...list.filter(p => !pos.has(p.id))];
    let changed = false;
    sorted.forEach((p, i) => { if (p.pourIndex !== i) { p.pourIndex = i; changed = true; } if ("priority" in p) delete p.priority; });
    return changed;
  }
  // Move the pours `ids` one place up (step -1, poured earlier) or down (+1) in pour order.
  function move(doc, ids, step) {
    const now = order(doc).filter(p => !p.cutout).map(p => p.id), sel = now.filter(id => ids.includes(id));
    if (!sel.length) return false;
    const idx = sel.map(id => now.indexOf(id));
    if (step < 0 ? idx[0] === 0 : idx.at(-1) === now.length - 1) return false;
    for (const i of step < 0 ? idx : idx.slice().reverse()) [now[i], now[i + step]] = [now[i + step], now[i]];
    return reorder(doc, now);
  }
  // Shelve (on) or restore the pours `ids` (all pours when null); returns the ids that changed.
  function shelve(doc, ids, on) {
    const changed = [];
    for (const p of order(doc)) {
      if (p.cutout || (ids && !ids.includes(p.id)) || !!p.shelved === !!on) continue;
      setField(doc, p.id, "enabled", !on); changed.push(p.id);
    }
    return changed;
  }
  // The pours to repour with `ids`: each one and every poured pour after it in pour order on its
  // layer (a cutout affects every pour on its layer). Mirrors AtriumPCBDraw.affectedPours.
  function affected(doc, ids) {
    const P = PP(), list = P.polygons(doc), poured = new Set((doc.pcbDrawing?.pours || []).map(r => r.polygon).filter(v => v != null)), out = new Set();
    for (const id of ids) {
      const poly = (doc.items || []).find(i => i.id === id && i.kind === "polygon");
      if (!poly) continue;
      const same = p => poly.layer === "Multi" || p.layer === poly.layer;
      if (poly.cutout) { for (const p of list) if (same(p) && poured.has(p.id)) out.add(p.id); continue; }
      const k = list.indexOf(poly);
      if (k < 0) continue;
      for (const p of list.slice(k)) if (p === poly || same(p) && poured.has(p.id)) out.add(p.id);
    }
    return list.filter(p => out.has(p.id)).map(p => p.id);
  }
  function repour(doc, defs, ids, o = {}) {
    const P = PP();
    if (!P.polygons(doc).length) fail("This board has no poured polygons (shelved and cutout polygons do not pour).");
    return P.apply(doc, defs, ids ? {...o, only: affected(doc, ids)} : o);
  }
  // Outline bounds of a pour [x0, y0, x1, y1].
  function bounds(p) {
    const pts = PP().outline(p);
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const [x, y] of pts) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)];
    return b;
  }
  // A small SVG (string) of a pour: outline dashed, poured copper filled.
  function thumbnail(doc, id, w = 64, h = 44) {
    const p = find(doc, id), b = bounds(p), pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.06 + 0.01;
    const vb = [b[0] - pad, b[1] - pad, b[2] - b[0] + 2 * pad, b[3] - b[1] + 2 * pad].map(v => +v.toFixed(4));
    const regions = (doc.pcbDrawing?.pours || []).filter(r => r.polygon === id);
    const outline = PP().outline(p).map((q, i) => (i ? "L" : "M") + (+q[0]).toFixed(4) + " " + (+q[1]).toFixed(4)).join("") + "Z";
    const sw = (vb[2] + vb[3]) / 120;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + vb.join(" ") + '" width="' + w + '" height="' + h + '" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
      (regions.length ? '<path class="pm-copper" fill-rule="evenodd" d="' + PP().svgPath(regions) + '"/>' : "") +
      '<path class="pm-outline" fill="none" stroke-width="' + sw.toFixed(4) + '" stroke-dasharray="' + (sw * 3).toFixed(4) + '" d="' + outline + '"/></svg>';
  }

  // ================================================================== panel (browser only)
  const I18N = G.AtriumI18n || {define: m => (k, a) => m[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  // ")" is ")" after a placeholder (scripts/i18n-extract.py ends a define() table at the first "})").
  const t = I18N.define({
    "pours.title": "Pours",
    "pours.repour_all": "Repour All",
    "pours.repour_stale": "Repour Stale",
    "pours.repour_selected": "Repour Selected",
    "pours.shelve_all": "Shelve All",
    "pours.restore_all": "Restore All",
    "pours.list": "Polygon pours",
    "pours.empty": "This board has no polygon pours. Place one with Place › Polygon Pour.",
    "pours.no_board": "Open a board layout to manage its pours.",
    "pours.state.poured": "Current",
    "pours.state.empty": "Empty",
    "pours.state.outline": "Outlines Only",
    "pours.more": "More",
    "pours.more_bulk": "More pour actions",
    "pours.more_selected": "More actions for {name}",
    "pours.one": "1 pour",
    "pours.total": "{n} pours",
    "pours.stale_count": "{n} stale",
    "pours.failed_count": "{n} failed",
    "pours.shelved_count": "{n} shelved",
    "pours.state.stale": "Stale",
    "pours.state.pending": "Pending",
    "pours.state.unknown": "Unverified",
    "pours.state.failed": "Failed",
    "pours.state.shelved": "Shelved",
    "pours.state.unpoured": "Not Poured",
    "pours.state.cutout": "Cutout",
    "pours.islands": "{n} islands",
    "pours.dead": "{n} dead",
    "pours.no_copper": "no copper (every island removed)",
    "pours.refilled": "refilled {time} ({ms})",
    "pours.never": "not refilled this session",
    "pours.failed": "Kept its previous copper: {reason}.",
    "pours.retry": "Retry",
    "pours.locked": "Locked",
    "pours.selected": "Pour",
    "pours.none_selected": "Select a pour in the list or on the board to edit it.",
    "pours.f.name": "Name",
    "pours.f.net": "Net",
    "pours.f.layer": "Layer",
    "pours.f.clearance": "Clearance",
    "pours.f.rules": "Rules",
    "pours.f.connect": "Connect Style",
    "pours.f.fill": "Fill Mode",
    "pours.f.dead": "Remove Dead Copper",
    "pours.f.island_area": "Remove Islands Less Than",
    "pours.f.necks": "Remove Necks Less Than",
    "pours.f.off": "Off",
    "pours.f.arc": "Arc Approximation",
    "pours.f.min_prim": "Min Prim Length",
    "pours.f.locked": "Locked",
    "pours.fill.solid": "Solid (Copper Regions)",
    "pours.fill.hatched": "Hatched (Tracks/Arcs)",
    "pours.fill.outline": "None (Outlines Only)",
    "pours.style.relief": "Relief Connect",
    "pours.style.direct": "Direct Connect",
    "pours.style.none": "No Connect",
    "pours.style.auto": "Auto (smart)",
    "pours.no_net": "No Net",
    "pours.repour": "Repour",
    "pours.shelve": "Shelve",
    "pours.restore": "Restore",
    "pours.up": "Pour Earlier",
    "pours.down": "Pour Later",
    "pours.properties": "Properties…",
    "pours.said.changed": "{name}: {field} changed. It repours with the live pours, or use Repour.",
    "pours.said.order": "Pour order changed. Repour to apply it.",
    "pours.said.repoured": "Repoured {n} pours in {ms} ms.",
    "pours.said.nothing": "Select pours to repour.",
    "pours.said.shelved": "Shelved {n} pours.",
    "pours.said.restored": "Restored and repoured {n} pours."
  });
  let host = null, panel = null, ui = null, timer = 0, busy = false, lastClick = null;
  const selected = new Set();
  let rowsNow = [];
  function el(tag, text, cls, attrs) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) n.setAttribute(k, v === true ? "" : v);
    return n;
  }
  const btn = (text, fn, cls) => { const b = el("button", text, cls || "pm-btn ui-button", {type: "button"}); b.onclick = fn; return b; };
  const boardDoc = () => { const d = host?.doc?.(); return d?.kind === "pcb" ? d : null; };
  const U = () => G.Atrium?.units, unit = () => host?.units?.() === "mil" ? "mil" : "mm";
  const show = mm => mm == null ? "" : U() ? String(U().value(mm, unit())) : String(+(+mm).toFixed(4));
  const parse = text => U() ? U().parse(text, unit()) : parseFloat(text);
  const nameOf = r => r.name || ((r.net || t("pours.no_net")) + " on " + r.layer);
  const say = (text, bad) => { if (!ui) return; ui.status.textContent = text; ui.status.classList.toggle("bad", !!bad); };
  function build() {
    const dock = document.getElementById("properties");
    if (!dock) return false;
    panel = el("section", null, "panel panel-pours", {"aria-label": t("pours.title")}); panel.hidden = true;
    const count = el("p", "", "pm-count");
    const bulk = el("div", null, "pm-bulk", {role: "toolbar", "aria-label": t("pours.list")});
    const all = btn(t("pours.repour_all"), () => doRepour(null)), stale = btn(t("pours.repour_stale"), () => doRepour(rowsNow.filter(r => r.state === "stale" || r.state === "unpoured" || r.state === "failed").map(r => r.id)));
    const sel = btn(t("pours.repour_selected"), () => doRepour([...selected])), shelveAll = btn(t("pours.shelve_all"), () => doShelve(null, true)), restoreAll = btn(t("pours.restore_all"), () => doShelve(null, false));
    const more = btn(t("pours.more"));
    more.setAttribute("aria-label", t("pours.more_bulk"));
    bulk.append(all, G.AtriumNavCommon.actionMenu(more, [stale, sel, shelveAll, restoreAll]));
    const list = el("div", null, "ui-list pm-options", {role: "listbox", "aria-label": t("pours.list"), "aria-multiselectable": "true", tabindex: "0"});
    const empty = el("p", "", "ui-empty pm-empty", {role: "status"}), scroll = el("div", null, "pm-list pane-scroll");
    scroll.append(list, empty);
    const detail = el("div", null, "pm-detail");
    const status = el("p", "", "pm-status", {role: "status"});
    panel.append(count, bulk, scroll, detail, status);
    dock.append(panel);
    ui = {count, list, empty, detail, status, all, stale, sel, shelveAll, restoreAll};
    list.addEventListener("keydown", keys);
    const spec = {id: "pours", title: t("pours.title"), element: panel, area: "right", alwaysTab: true, action: "pour-manager", scope: "pcb"};
    if (G.AtriumDock?.register) G.AtriumDock.register(spec); else (G.AtriumDockPending ||= []).push(spec);
    return true;
  }
  // One undo step per change; the panel repaints on the editor's change event.
  function change(label, fn) {
    const doc = boardDoc();
    if (!doc) return;
    try { let out; host.edit(() => { out = fn(doc); }); say(label); return out; } catch (e) { say(e.message, true); paint(); }
  }
  async function doRepour(ids) {
    if (busy) return;
    if (ids && !ids.length) { say(t("pours.said.nothing"), true); return; }
    busy = true;
    try {
      const t0 = Date.now(), doc = boardDoc(), P = PP();
      if (!doc) return;
      if (!P.polygons(doc).length) fail("This board has no poured polygons (shelved and cutout polygons do not pour).");
      const only = ids ? affected(doc, ids) : undefined;
      const r = await P.repour(doc, host.defs(), {project: host.project(), only}, fn => host.edit(fn), say);
      if (!r) return;
      say(t("pours.said.repoured", {n: Object.keys(r?.stats?.polygons || {}).length, ms: Date.now() - t0}) + (r.failed?.length ? " " + r.failed.length + " failed." : ""));
    } catch (e) { say(e.message, true); } finally { busy = false; paint(); }
  }
  async function doShelve(ids, on) {
    const done = change("", doc => shelve(doc, ids, on)) || [];
    if (on) { say(t("pours.said.shelved", {n: done.length})); return; }
    if (done.length) { await doRepour(done); say(t("pours.said.restored", {n: done.length})); }
  }
  function select(ids, zoom) {
    selected.clear(); for (const id of ids) selected.add(id);
    syncSelection();
    try {
      host.select?.(ids);
      if (zoom && ids.length) {
        const doc = boardDoc(); let b = null;
        for (const id of ids) { const q = bounds(find(doc, id)); b = b ? [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])] : q; }
        host.zoomTo?.(b);
      }
    } catch { /* the board changed */ }
    paintDetail();
  }
  const ago = at => { try { return new Date(at).toLocaleTimeString(); } catch { return ""; } };
  function row(r) {
    const displayState = r.state === "poured" && !r.regions ? (r.fill === "outline" ? "outline" : "empty") : r.state;
    const on = selected.has(r.id), node = el("div", null, "ui-row pm-row pm-" + (displayState === "empty" ? "empty-copper" : displayState === "outline" ? "outlines-only" : displayState) + (on ? " is-selected" : ""), {role: "option", "aria-selected": String(on), "data-id": r.id, id: "pm-opt-" + r.id});
    const line = el("div", null, "pm-line");
    line.append(el("span", r.cutout ? "–" : String(r.priority), "pm-order"), el("span", nameOf(r), "pm-name"));
    if (r.locked) line.append(el("span", t("pours.locked"), "ui-badge"));
    const tone = {poured: "success", empty: "warning", stale: "warning", unpoured: "warning", failed: "danger"}[displayState];
    line.append(el("span", t("pours.state." + displayState), "ui-badge", tone ? {"data-tone": tone} : undefined));
    const meta = el("div", null, "pm-meta");
    const bits = [r.net || t("pours.no_net"), r.layer];
    if (!r.regions && r.fill !== "outline" && (r.state === "poured" || r.state === "stale")) bits.push(t("pours.no_copper"));
    if (r.regions) bits.push(U() && unit() === "mil" ? (r.area / 645.16).toFixed(3) + " in²" : r.area.toFixed(2) + " mm²", t("pours.islands", {n: r.islands}) + (r.dead ? " (" + t("pours.dead", {n: r.dead}) + ")" : ""));
    if (!r.cutout && r.enabled) bits.push(r.refill ? t("pours.refilled", {time: ago(r.refill.at), ms: Math.round(r.refill.ms) + " ms"}) : t("pours.never"));
    meta.textContent = bits.join(" · ");
    // A library list row: the pour's line and meta stack in the row's text column.
    const text = el("div", null, "ui-row-text"); text.append(line, meta); node.append(text);
    if (r.state === "failed") text.append(el("p", t("pours.failed", {reason: r.reason}), "pm-why"));
    node.onclick = e => {
      if (e.target.closest("button")) return;
      let ids = [r.id];
      if (e.shiftKey && lastClick) { const a = rowsNow.findIndex(x => x.id === lastClick), b = rowsNow.findIndex(x => x.id === r.id); ids = rowsNow.slice(Math.min(a, b), Math.max(a, b) + 1).map(x => x.id); }
      else if (e.metaKey || e.ctrlKey) ids = selected.has(r.id) ? [...selected].filter(x => x !== r.id) : [...selected, r.id];
      lastClick = r.id;
      select(ids, ids.length === 1);
    };
    return node;
  }
  let copperPreparation;
  function paint() {
    clearTimeout(timer); timer = 0;
    if (!panel || panel.hidden || !ui) return;
    const doc = boardDoc();
    const P = PP();
    rowsNow = doc ? rows(doc, host.defs(), {project: host.project()}) : [];
    if(rowsNow.some(r=>r.state==="pending"||r.state==="unknown")){
      const work=P.live.prepare(doc,host.defs());
      if(work&&work!==copperPreparation){
        copperPreparation=work;
        work.then(()=>{if(copperPreparation===work){copperPreparation=null;schedule();}});
      }
    }
    for (const id of [...selected]) if (!rowsNow.some(r => r.id === id)) selected.delete(id);
    const keep = document.activeElement === ui.list;
    ui.list.replaceChildren(...rowsNow.map(row));
    ui.list.hidden = !rowsNow.length;
    ui.empty.hidden = !!rowsNow.length;
    if (!rowsNow.length) {
      const message = t(doc ? "pours.empty" : "pours.no_board");
      if (ui.empty.textContent !== message) ui.empty.textContent = message;
    }
    const st = k => rowsNow.filter(r => r.state === k).length;
    const summary = [rowsNow.length === 1 ? t("pours.one") : t("pours.total", {n: rowsNow.length})];
    for (const state of ["stale", "failed", "shelved"]) {
      const n = st(state);
      if (n) summary.push(t("pours." + state + "_count", {n}));
    }
    ui.count.textContent = summary.join(" · ");
    ui.stale.disabled = !rowsNow.some(r => r.state === "stale" || r.state === "unpoured" || r.state === "failed");
    ui.shelveAll.disabled = !rowsNow.some(r => !r.cutout && r.enabled);
    ui.restoreAll.disabled = !rowsNow.some(r => !r.enabled);
    ui.all.disabled = !rowsNow.some(r => !r.cutout && r.enabled);
    syncSelection();
    paintDetail();
    if (keep) (rowsNow.length ? ui.list : panel.closest(".dock-group")?.querySelector('[data-dock-tab="pours"]'))?.focus({preventScroll: true});
  }
  function syncSelection() {
    if (!ui) return;
    for (const n of ui.list.children) { const on = selected.has(n.dataset?.id); n.classList.toggle("is-selected", on); n.setAttribute?.("aria-selected", String(on)); }
    ui.sel.disabled = !selected.size;
    const first = [...selected][0];
    if (first) { ui.list.setAttribute("aria-activedescendant", "pm-opt-" + first); ui.list.querySelector('[data-id="' + CSS.escape(first) + '"]')?.scrollIntoView?.({block: "nearest"}); }
    else ui.list.removeAttribute("aria-activedescendant");
  }
  // The selected pour's settings (one pour selected), each change one undo step.
  function paintDetail() {
    if (!ui) return;
    const doc = boardDoc(), r = selected.size === 1 && rowsNow.find(x => x.id === [...selected][0]);
    if (!doc || !r) { ui.detail.replaceChildren(el("p", t("pours.none_selected"), "pm-hint")); return; }
    const focusKey = document.activeElement?.closest?.(".pm-detail") ? document.activeElement.getAttribute("data-key") : null;
    const form = el("div", null, "pm-form");
    const set = (key, label) => v => change(t("pours.said.changed", {name: nameOf(r), field: label}), d => setField(d, r.id, key, v));
    const field = (label, control) => { const l = el("label", null, "pm-field"); l.append(el("span", label, "pm-label"), control); form.append(l); return control; };
    const select = (key, label, options, value) => {
      const s = el("select", null, "pm-in ui-field", {"data-key": key, "data-size":"sm"}); for (const [v, text] of options) s.add(new Option(text, v)); s.value = value; s.onchange = () => set(key, label)(s.value); return field(label, s);
    };
    const text = (key, label, value, onset, placeholder, suffix) => {
      const i = el("input", null, "pm-in ui-field", {"data-size":"sm", type: "text", spellcheck: "false", "data-key": key, inputmode: key === "name" ? null : "decimal"}); i.value = value; if (placeholder) i.placeholder = placeholder;
      const commit = () => { if (i.value !== value) onset(i.value); };
      i.onchange = commit; i.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); commit(); } else if (e.key === "Escape") { e.stopPropagation(); i.value = value; i.blur(); } };
      if (!suffix) return field(label, i);
      const box = el("span", null, "pm-unit"); box.append(i, el("span", suffix)); field(label, box); return i;
    };
    const length = (key, label, value, blank) => text(key, label, show(value || (blank ? null : 0)), v => {
      const mm = v.trim() === "" ? null : parse(v);
      if (mm != null && Number.isNaN(mm)) { say("Enter a length" + (blank ? ", or leave it blank." : "."), true); paint(); return; }
      set(key, label)(mm);
    }, blank ? (key === "clearance" ? t("pours.f.rules") : t("pours.f.off")) : null, unit());
    const check = (key, label, value) => { const c = el("input", null, "ui-checkbox", {type: "checkbox", "data-key": key}); c.checked = value; c.onchange = () => set(key, label)(c.checked); const l = el("label", null, "pm-check"); l.append(c, el("span", label)); form.append(l); return c; };
    text("name", t("pours.f.name"), r.name, v => set("name", t("pours.f.name"))(v));
    if (!r.cutout) {
      const nets = new Set([""]);
      for (const i of doc.items) { if (i.net) nets.add(i.net); for (const n of Object.values(i.pinNets || {})) if (n) nets.add(n); }
      nets.add(r.net);
      select("net", t("pours.f.net"), [...nets].sort((a, b) => a.localeCompare(b, undefined, {numeric: true})).map(n => [n, n || t("pours.no_net")]), r.net);
    }
    let layers = ["Top", "Bottom"];
    try { layers = host.copperLayers?.() || G.AtriumStackup?.copperLayers(doc, host.defs()) || layers; } catch { /* default */ }
    if (!layers.includes(r.layer)) layers = [...layers, r.layer];
    select("layer", t("pours.f.layer"), layers.map(k => [k, k]), r.layer);
    if (!r.cutout) {
      length("clearance", t("pours.f.clearance"), r.clearance, true);
      select("connectStyle", t("pours.f.connect"), STYLES.map(s => [s, t("pours.style." + s)]), r.connectStyle);
      select("fill", t("pours.f.fill"), FILLS.map(f => [f, t("pours.fill." + f)]), r.fill);
      check("removeIslands", t("pours.f.dead"), r.removeIslands);
      text("islandArea", t("pours.f.island_area"), r.islandArea ? String(+r.islandArea.toFixed(4)) : "", v => set("islandArea", t("pours.f.island_area"))(v.trim() === "" ? 0 : v), "0", "mm²");
      const neck = length("neckWidth", t("pours.f.necks"), r.neckWidth || null, true);
      if (r.fill !== "solid") neck.disabled = true;
      length("arcApproximation", t("pours.f.arc"), r.arcApproximation, false);
      length("minWidth", t("pours.f.min_prim"), r.minWidth, false);
    }
    check("locked", t("pours.f.locked"), r.locked);
    const actions = el("div", null, "pm-actions");
    const properties = btn(t("pours.properties"), () => {
      const p = boardDoc()?.items.find(i => i.id === r.id);
      if (p) PP().open({doc: boardDoc(), defs: host.defs(), unit: unit(), edit: host.edit, info: host.info, layer: p.layer, options: {project: host.project()}, polygon: p});
    });
    if (!r.cutout) {
      const rep = btn(t(r.state === "failed" ? "pours.retry" : "pours.repour"), () => doRepour([r.id])); rep.disabled = !r.enabled;
      actions.append(rep, r.enabled ? btn(t("pours.shelve"), () => doShelve([r.id], true)) : btn(t("pours.restore"), () => doShelve([r.id], false)));
      const up = btn(t("pours.up"), () => change(t("pours.said.order"), d => move(d, [r.id], -1))), down = btn(t("pours.down"), () => change(t("pours.said.order"), d => move(d, [r.id], 1)));
      up.disabled = r.priority === 1; down.disabled = r.priority === rowsNow.filter(x => !x.cutout).length;
      const more = btn(t("pours.more"));
      more.setAttribute("aria-label", t("pours.more_selected", {name:nameOf(r)}));
      actions.append(G.AtriumNavCommon.actionMenu(more, [up, down, properties]));
    } else actions.append(properties);
    const headRow = el("div", null, "pm-detail-head"); headRow.append(el("h3", t("pours.selected") + ": " + nameOf(r)));
    ui.detail.replaceChildren(headRow, actions, form);
    if (focusKey) ui.detail.querySelector('[data-key="' + focusKey + '"]')?.focus({preventScroll: true});
  }
  function keys(e) {
    if (e.target !== ui.list) return;
    const step = {ArrowDown: 1, ArrowUp: -1}[e.key];
    if (step) {
      e.preventDefault();
      const i = rowsNow.findIndex(r => selected.has(r.id)), j = Math.max(0, Math.min(rowsNow.length - 1, i < 0 ? 0 : i + step));
      if (e.altKey && i >= 0) { change(t("pours.said.order"), d => move(d, [...selected], step)); return; }
      if (rowsNow[j]) select([rowsNow[j].id], false);
    } else if (e.key === "Enter" && selected.size) { e.preventDefault(); select([...selected], true); }
    else if (e.key === "Escape") { e.preventDefault(); host.canvas?.()?.focus?.(); }
  }
  function schedule() { if (!panel || panel.hidden || timer) return; timer = setTimeout(() => { if (!busy) paint(); else timer = 0; }, 150); }
  // A pour selected on the board: its row is highlighted (other objects leave the list's selection).
  function boardSelection() {
    if (!panel || panel.hidden) return;
    const ids = (host.selection?.() || []).filter(id => rowsNow.some(r => r.id === id));
    if (!ids.length || ids.length === selected.size && ids.every(id => selected.has(id))) return;
    selected.clear(); for (const id of ids) selected.add(id);
    syncSelection(); paintDetail();
  }
  function toggle(show) {
    if (!panel && !build()) return false;
    const on = show ?? panel.hidden;
    panel.hidden = !on;
    if (on && !G.AtriumDock) document.body.classList.remove("hide-right");
    G.AtriumNavCommon?.setChecked?.("pour-manager", on);
    if (on) {
      if (!boardDoc()) {
        const p = host.project?.(), b = G.Atrium?.preferredDocument?.(p, "pcb", host.currentId?.()) || p?.documents?.find(x => x.kind === "pcb");
        if (b) host.selectDocument?.(b.id);
      }
      for (const id of host.selection?.() || []) if ((boardDoc()?.items || []).some(i => i.id === id && i.kind === "polygon")) selected.add(id);
      paint(); ui.list.focus({preventScroll: true});
    } else host.canvas?.()?.focus?.();
    return on;
  }
  function attach(h) {
    if (host === h) return;
    host = h;
    h.registerAction?.("pour-manager", () => { try { toggle(); } catch (e) { h.info?.(e.message); } });
    for (const ev of ["change", "document"]) h.on?.(ev, schedule);
    h.on?.("selection", boardSelection);
  }
  if (typeof document !== "undefined" && G.AtriumNavCommon?.ready) G.AtriumNavCommon.ready(attach);

  return Object.freeze({rows, setField, reorder, move, shelve, affected, repour, area, bounds, thumbnail, FIELDS,
    toggle: (h, on) => { if (h) attach(h); return toggle(on); }, open: ctx => { if (ctx?.host) attach(ctx.host); return toggle(true); }, isOpen: () => !!panel && !panel.hidden, attach});
})();
