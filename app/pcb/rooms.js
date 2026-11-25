"use strict";
// Rooms: board regions that hold a group of components, usually one channel of a
// multichannel design (multichannel.js creates one per channel on Update Board).
//
// Stored on the board document, outside doc.items so the item model is unchanged:
//   doc.rooms = [{id, name, points:[[x,y],...] (>= 3, a rectangle has 4), channel?, sheet?,
//                 members?:[part id], locked?:true, color?:"#rrggbb"}]
//   channel  the hierarchy instance id of the channel (AtriumHierarchy.instances); a
//            board part belongs to the room when part.channel === room.channel
//   sheet    the schematic document the channel instantiates; rooms of one sheet are the
//            channels that Copy Room Formats can copy between
//   members  explicit part ids, for rooms that are not channels
//
// Moving a room moves its parts and the copper wholly inside it. The Room Definition
// check reports a part that is not wholly inside its room (AtriumRules.drc calls drc()).
// Model functions are DOM-free; install(host) wires the canvas overlay and actions.
globalThis.AtriumRooms = (() => {
  const A = () => globalThis.Atrium;
  const EPS = 1e-6;
  const finite = v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) < 1e8;
  const point = p => Array.isArray(p) && p.length === 2 && p.every(finite);
  const str = s => typeof s === "string";
  const COPPER = new Set(["track", "via", "polygon"]);

  // ------------------------------------------------------------------ model
  function validate(rooms, invalid = () => {throw Error("This file is not a supported Waffle project.");}) {
    if (!Array.isArray(rooms) || rooms.length > 4096) invalid();
    const ids = new Set();
    for (const r of rooms) {
      if (!r || typeof r !== "object" || !str(r.id) || !r.id || ids.has(r.id) || !str(r.name) || r.name.length > 200) invalid();
      ids.add(r.id);
      if (!Array.isArray(r.points) || r.points.length < 3 || r.points.length > 4096 || !r.points.every(point)) invalid();
      if (r.channel != null && !str(r.channel) || r.sheet != null && !str(r.sheet)) invalid();
      if (r.members != null && (!Array.isArray(r.members) || !r.members.every(str))) invalid();
      if (r.locked != null && typeof r.locked !== "boolean") invalid();
      if (r.componentClass != null && !(str(r.componentClass) && r.componentClass.length <= 200)) invalid();
      if (r.color != null && !(str(r.color) && /^#[0-9a-f]{6}$/i.test(r.color))) invalid();
    }
    return rooms;
  }
  const list = doc => Array.isArray(doc?.rooms) ? doc.rooms : [];
  const rectPoints = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  function bbox(points) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of points) {if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;}
    return x0 === Infinity ? null : [x0, y0, x1, y1];
  }
  // The room origin is its bounding box's top-left corner (minimum x and y, Y down):
  // Copy Room Formats keeps every object at the same offset from it.
  function origin(room) {const b = bbox(room.points); return [b[0], b[1]];}
  function onSegment(p, a, b) {return A().nearSegment(p, a, b) <= EPS;}
  // Even-odd point in polygon; points on the outline count as inside.
  function inside(room, p) {
    const pts = room.points || room;
    let hit = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i], b = pts[j];
      if (onSegment(p, a, b)) return true;
      if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < (b[0] - a[0]) * (p[1] - a[1]) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  }
  const make = ({id, name, points, channel, sheet, members, color}) => {
    const r = {id:id || A().id(), name:String(name || "Room"), points:points.map(p => [p[0], p[1]])};
    if (channel) r.channel = channel; if (sheet) r.sheet = sheet; if (members) r.members = [...members]; if (color) r.color = color;
    return r;
  };
  // The channel a board part belongs to: part.channel, else the deepest room channel that
  // its channel link (schematicLink@instanceId, as ECO creates them) falls in.
  function channelOf(doc, part) {
    if (part.channel) return part.channel;
    const at = typeof part.link === "string" ? part.link.indexOf("@") : -1;
    if (at < 0) return "";
    const inst = part.link.slice(at + 1);
    let best = "";
    for (const r of list(doc)) if (r.channel && r.channel.length > best.length && (inst === r.channel || inst.startsWith(r.channel + "/"))) best = r.channel;
    return best;
  }
  // room.componentClass: the parts of a component class (component-classes.js; room classes left out).
  function classMembers(doc, room) {
    if (!room.componentClass) return null;
    const project = globalThis.AtriumSignals?.projectOf?.(doc) ?? globalThis.AtriumNavHost?.project?.();
    return globalThis.AtriumComponentClasses?.map(doc, project, {rooms:false}).get(room.componentClass);
  }
  function roomOf(doc, part) {
    const ch = channelOf(doc, part);
    for (const r of list(doc)) if ((ch && r.channel === ch) || r.members?.includes(part.id) || classMembers(doc, r)?.has(part.ref)) return r;
    return null;
  }
  function members(doc, room, refs = classMembers(doc, room)) {
    const ids = room.members ? new Set(room.members) : null;
    return doc.items.filter(i => i.kind === "part" && ((room.channel && channelOf(doc, i) === room.channel) || ids?.has(i.id) || refs?.has(i.ref)));
  }
  // ECO "Create a room per sheet" (eco.js): rooms around the footprints it just added. The
  // footprints of a multichannel sheet are packed into one block per channel, each with its
  // own room; any others get one room named after the sheet.
  function ecoRoom(board, {name, sheet, bounds, components = [], project} = {}) {
    const M = globalThis.AtriumMultichannel;
    const made = M && project ? M.ecoRooms(project, board, components, bounds, {name, sheet}) : null;
    if (made) return made;
    const ids = new Set(components), parts = board.items.filter(i => i.kind === "part" && ids.has(i.id));
    const defs = new Map((project?.library || []).map(d => [d.id, d]));
    const points = Array.isArray(bounds) && bounds.length === 4 && bounds.every(finite) ? rectPoints(...bounds) : around(parts, defs, 1);
    if (!points) return [];
    const room = make({name:uniqueName(board, name || "Room"), points, sheet, members:[...ids]});
    (board.rooms ||= []).push(room);
    return [room];
  }
  function uniqueName(doc, name) {
    const used = new Set(list(doc).map(r => r.name));
    let n = name, k = 2; while (used.has(n)) n = name + "_" + k++;
    return n;
  }
  // Footprint extent of a part (pads and outline shapes) in board coordinates.
  function partPoints(part, def) {
    const pts = A().itemPoints(part, def, "pcb");
    return pts.length ? pts : [[part.x, part.y]];
  }
  function itemPoints(item) {
    if (item.points) return item.points;
    const r = (item.diameter || item.w || 0) / 2;
    return r ? [[item.x - r, item.y - r], [item.x + r, item.y + r], [item.x - r, item.y + r], [item.x + r, item.y - r]] : [[item.x, item.y]];
  }
  const within = (room, pts) => pts.every(p => inside(room, p));
  // Copper (tracks, vias, polygons) wholly inside the room.
  function copperIn(doc, room) {return doc.items.filter(i => COPPER.has(i.kind) && within(room, itemPoints(i)));}
  // A rectangle around parts (and optional extra points), grown by margin and snapped
  // outward to 0.01 mm so rooms have tidy coordinates.
  function around(parts, defs, margin = 1, extra = []) {
    const pts = [...extra];
    for (const p of parts) pts.push(...partPoints(p, defs.get(p.def)));
    const b = bbox(pts); if (!b) return null;
    const lo = v => Math.floor((v - margin) * 100) / 100, hi = v => Math.ceil((v + margin) * 100) / 100;
    return rectPoints(lo(b[0]), lo(b[1]), hi(b[2]), hi(b[3]));
  }
  function fitPlan(doc, defs, margin = 1, ids = null) {
    const out = [];
    for (const r of list(doc)) {
      if (ids && !ids.includes(r.id) || r.locked) continue;
      const parts = members(doc, r); if (!parts.length) continue;
      const pts = around(parts, defs, margin); if (pts) out.push({id:r.id, points:pts});
    }
    return out;
  }
  function applyFit(doc, plan) {
    const byId = new Map(list(doc).map(r => [r.id, r]));
    for (const f of plan) {const r = byId.get(f.id); if (r) r.points = f.points;}
    return plan.length;
  }

  // ------------------------------------------------------------------ move
  // Moving a room moves its parts (unless locked) and the copper wholly inside it.
  function movePlan(doc, room, dx, dy, {skipLocked = true} = {}) {
    const parts = members(doc, room), skipped = [];
    const moved = parts.filter(p => {if (skipLocked && p.locked === true) {skipped.push(p.ref); return false;} return true;});
    const copper = copperIn(doc, room).filter(i => !(skipLocked && i.locked === true));
    return {room:room.id, dx, dy, parts:moved.map(p => p.id), copper:copper.map(i => i.id), skipped};
  }
  function applyMove(doc, plan, defs) {
    const room = list(doc).find(r => r.id === plan.room); if (!room) return 0;
    const {dx, dy} = plan, ids = new Set([...plan.parts, ...plan.copper]);
    room.points = room.points.map(([x, y]) => [x + dx, y + dy]);
    let polygons = [];
    for (const i of doc.items) if (ids.has(i.id)) {A().moveItem(i, dx, dy); if (i.kind === "polygon") polygons.push(i.id);}
    if (polygons.length) repour(doc, defs, polygons);
    return ids.size;
  }
  // Moved or copied pours are refilled when the pour engine is loaded; otherwise their old
  // copper regions are dropped so nothing stale is plotted (Repour All refills them).
  function repour(doc, defs, ids) {
    const P = globalThis.AtriumPolygonPour;
    if (P?.apply && defs) {try {P.apply(doc, defs, {only:ids}); return true;} catch {}}
    const pours = doc.pcbDrawing?.pours;
    if (Array.isArray(pours)) {
      const s = new Set(ids), kept = pours.filter(r => !s.has(r.polygon));
      if (kept.length) doc.pcbDrawing.pours = kept; else {delete doc.pcbDrawing.pours; delete doc.pcbDrawing.pourSignatures; delete doc.sourcePourSignature;}
    }
    return false;
  }

  // ------------------------------------------------------------------ check
  // Room Definition: every member part must lie wholly inside its room.
  function check(doc, defs) {
    const out = [];
    for (const room of list(doc)) for (const p of members(doc, room)) {
      const pts = partPoints(p, defs.get(p.def));
      if (within(room, pts)) continue;
      const outside = pts.find(q => !inside(room, q)) || [p.x, p.y];
      out.push({id:p.id, room:room.id, title:"Component " + p.ref + " is outside room " + room.name, detail:"Room " + room.name, at:[p.x, p.y], point:outside});
    }
    return out;
  }
  function ensureRuleType() {
    const T = globalThis.AtriumRules?.types;
    if (T && !T.roomDefinition) T.roomDefinition = {category:"Placement", title:"Room Definition", altium:"RoomDefinition",
      help:"Components assigned to a room (a channel of a multichannel design) must lie inside it.", fields:[]};
  }
  // Hook for AtriumRules.drc: flags room violations under a pseudo rule and returns its
  // summary row (or null when the board has no rooms).
  function drc(doc, defs, flag, tallies) {
    if (!list(doc).length) return null;
    ensureRuleType();
    const rule = {id:"room-definition", type:"roomDefinition", name:"RoomDefinition", label:"Room Definition"};
    for (const v of check(doc, defs)) flag(rule, v);
    return {id:rule.id, name:rule.name, type:rule.type, priority:1, count:tallies.get(rule.id)?.count || 0, description:"Components stay inside their rooms"};
  }

  // ------------------------------------------------------------------ editor
  let H = null, shown = true, drag = null, mode = false;
  const isPcb = () => H?.doc?.()?.kind === "pcb";
  function roomAt(doc, p) {
    // Smallest room under the point wins, so nested rooms stay reachable.
    let best = null, area = Infinity;
    for (const r of list(doc)) if (inside(r, p)) {const b = bbox(r.points), a = (b[2] - b[0]) * (b[3] - b[1]); if (a < area) {area = a; best = r;}}
    return best;
  }
  const PALETTE = ["#b07cff", "#4fb3ff", "#4cd08a", "#ffb347", "#ff6f91", "#3dd6d0", "#d4d44f", "#ff8f5a"];
  const colorOf = (r, k) => r.color || PALETTE[k % PALETTE.length];
  function tabRect(info, r) {
    const b = bbox(r.points), [x, y] = info.worldToScreen([b[0], b[1]]);
    return [x, y - 16, Math.min(220, 14 + (r.locked ? LOCK_W : 0) + r.name.length * 6.6), 16];
  }
  // A small vector padlock (10 px wide) for locked rooms, drawn in the tab's ink.
  const LOCK_W = 11;
  function lock(ctx, x, cy) {
    ctx.save(); ctx.lineWidth = 1.4; ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x + 2.5, cy - 1); ctx.lineTo(x + 2.5, cy - 2.5); ctx.arc(x + 5, cy - 2.5, 2.5, Math.PI, 0); ctx.lineTo(x + 7.5, cy - 1); ctx.stroke();
    ctx.fillRect(x + 1, cy - 1, 8, 5.5);
    ctx.restore();
  }
  function paint(ctx, info) {
    const doc = H.doc(); if (!doc || doc.kind !== "pcb") return;
    const px = 1 / info.scale, rooms = list(doc), sel = new Set(H.selection());
    ctx.save(); ctx.lineJoin = "round";
    rooms.forEach((r, k) => {
      const offset = drag && drag.room === r.id ? drag.delta : [0, 0], pts = r.points.map(p => [p[0] + offset[0], p[1] + offset[1]]);
      const c = colorOf(r, k), active = drag?.room === r.id || members(doc, r).some(p => sel.has(p.id));
      ctx.beginPath(); pts.forEach((p, i) => i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])); ctx.closePath();
      ctx.globalAlpha = active ? .16 : .07; ctx.fillStyle = c; ctx.fill();
      ctx.globalAlpha = .9; ctx.strokeStyle = c; ctx.lineWidth = (active ? 2 : 1.2) * px;
      if (r.locked) ctx.setLineDash([6 * px, 3 * px]);
      ctx.stroke(); ctx.setLineDash([]);
      if (drag && drag.room === r.id) {
        ctx.globalAlpha = .55; ctx.strokeStyle = c; ctx.lineWidth = px;
        for (const p of members(doc, r)) {
          const b = bbox(partPoints(p, H.defs().get(p.def))); if (!b) continue;
          ctx.strokeRect(b[0] + offset[0], b[1] + offset[1], b[2] - b[0], b[3] - b[1]);
        }
      }
    });
    // Name tabs in screen space, above each room's top-left corner.
    ctx.setTransform(info.dpr, 0, 0, info.dpr, 0, 0); ctx.globalAlpha = 1;
    ctx.font = "600 11px ui-sans-serif, system-ui, sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
    rooms.forEach((r, k) => {
      const shifted = drag && drag.room === r.id ? {...r, points:r.points.map(p => [p[0] + drag.delta[0], p[1] + drag.delta[1]])} : r;
      const [x, y, w, h] = tabRect(info, shifted); if (x > info.width || y > info.height || x + w < 0 || y + h < 0) return;
      ctx.fillStyle = colorOf(r, k); ctx.globalAlpha = .85; ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1; ctx.fillStyle = ctx.strokeStyle = "#111";
      const lx = r.locked ? LOCK_W : 0;
      if (r.locked) lock(ctx, x + 6, y + h / 2);
      ctx.fillText(r.name, x + 6 + lx, y + h / 2 + .5, w - 10 - lx);
    });
    ctx.restore();
  }
  function render(d, info) {
    if (!info?.active || d.kind !== "pcb" || !shown || !list(d).length) return null;
    return {overlay:paint};
  }
  function worldOf(e) {const c = H.canvas(), b = c.getBoundingClientRect(); return H.view().screenToWorld([e.clientX - b.left, e.clientY - b.top]);}
  function tabAt(e) {
    const doc = H.doc(), c = H.canvas(), b = c.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top;
    const view = H.view(), info = {worldToScreen:p => view.worldToScreen(p)};
    for (const r of list(doc).slice().reverse()) {const [tx, ty, w, h] = tabRect(info, r); if (x >= tx && x <= tx + w && y >= ty && y <= ty + h) return r;}
    return null;
  }
  const swallow = e => {e.preventDefault(); e.stopImmediatePropagation();};
  function onDown(e) {
    if (!H || e.button !== 0 || e.target !== H.canvas?.() || !isPcb()) return;
    const tool = H.tool?.();
    const room = mode ? roomAt(H.doc(), worldOf(e)) : shown && tool === "select" ? tabAt(e) : null;
    if (!room) {if (mode) {swallow(e); H.info("Click inside a room to move it. Esc cancels.");} return;}
    if (room.locked) {swallow(e); H.info("Room " + room.name + " is locked."); return;}
    swallow(e);
    const at = H.snapAt ? H.snapAt(worldOf(e)) : worldOf(e);
    drag = {room:room.id, start:at, delta:[0, 0], moved:false};
    try {H.canvas().setPointerCapture(e.pointerId);} catch {}
    H.info("Moving room " + room.name + ". Release to place, Esc cancels.");
    H.redraw();
  }
  function onMove(e) {
    if (!drag) return;
    const p = H.snapAt ? H.snapAt(worldOf(e)) : worldOf(e);
    drag.delta = [p[0] - drag.start[0], p[1] - drag.start[1]];
    drag.moved = Math.hypot(...drag.delta) > EPS;
    swallow(e); H.redraw();
  }
  function onUp(e) {
    if (!drag) return;
    swallow(e);
    const d = drag; drag = null; mode = false;
    const doc = H.doc(), room = list(doc).find(r => r.id === d.room);
    if (!room || !d.moved) {H.info("Room not moved."); H.redraw(); return;}
    const plan = movePlan(doc, room, d.delta[0], d.delta[1]);
    H.edit(() => applyMove(doc, plan, H.defs()));
    H.info("Moved room " + room.name + " with " + plan.parts.length + " component" + (plan.parts.length === 1 ? "" : "s") + " and " + plan.copper.length + " copper object" + (plan.copper.length === 1 ? "" : "s") +
      (plan.skipped.length ? " · locked, left in place: " + plan.skipped.join(", ") : "") + ".");
  }
  function onKey(e) {
    if (e.key !== "Escape" || !(drag || mode)) return;
    drag = null; mode = false; swallow(e); H.info("Room move cancelled."); H.redraw();
  }
  function needBoard() {
    if (isPcb()) return true;
    const p = H.project(), b = globalThis.Atrium?.preferredDocument?.(p, "pcb", H.currentId?.()) || p.documents.find(d => d.kind === "pcb");
    if (!b) {H.info("Open a board layout first."); return false;}
    H.selectDocument(b.id); return isPcb();
  }
  function command(a) {
    if (!needBoard()) return;
    const doc = H.doc(), rooms = list(doc);
    if (a === "rooms-show") {shown = !shown; globalThis.AtriumNavCommon?.setChecked?.("rooms-show", shown); H.info(shown ? "Rooms shown." : "Rooms hidden."); H.redraw(); return;}
    if (!rooms.length) {H.info("This board has no rooms. Use Design → Update Board from Channels to create channel rooms."); return;}
    if (a === "room-move") {mode = true; shown = true; H.info("Click inside a room and drag it; its components and copper move with it. Esc cancels."); H.redraw(); return;}
    if (a === "rooms-fit") {
      const sel = new Set(H.selection()), picked = rooms.filter(r => members(doc, r).some(p => sel.has(p.id))).map(r => r.id);
      const plan = fitPlan(doc, H.defs(), globalThis.AtriumMultichannel?.settings?.(H.project()).margin ?? 1, picked.length ? picked : null);
      if (!plan.length) {H.info("No unlocked room has components to fit."); return;}
      H.edit(() => applyFit(doc, plan)); H.info("Fitted " + plan.length + " room" + (plan.length === 1 ? "" : "s") + " to their components."); return;
    }
    if (a === "rooms-lock") {
      const sel = new Set(H.selection()), picked = rooms.filter(r => members(doc, r).some(p => sel.has(p.id)));
      const target = picked.length ? picked : rooms, lock = !target.every(r => r.locked);
      H.edit(() => {for (const r of target) {if (lock) r.locked = true; else delete r.locked;}});
      H.info((lock ? "Locked " : "Unlocked ") + target.length + " room" + (target.length === 1 ? "" : "s") + "."); return;
    }
  }
  const ACTIONS = ["room-move", "rooms-fit", "rooms-lock", "rooms-show"];
  let installed = false;
  function install(host) {
    H = host;
    for (const a of ACTIONS) host.registerAction(a, () => command(a));
    if (installed) return;
    installed = true;
    host.addRenderer(render);
    host.on("document", () => {drag = null; mode = false;});
    const NC = globalThis.AtriumNavCommon;
    if (NC?.menuItem) {
      NC.menuItem("design", "room-move", "Rooms: Move Room", {scope:"pcb"});
      NC.menuItem("design", "rooms-fit", "Rooms: Fit Rooms to Components", {after:"room-move", scope:"pcb"});
      NC.menuItem("design", "rooms-lock", "Rooms: Lock / Unlock Rooms", {after:"rooms-fit", scope:"pcb"});
      NC.menuItem("design", "rooms-show", "Rooms: Show Rooms", {after:"rooms-lock", scope:"pcb", checkable:true});
      NC.setChecked?.("rooms-show", shown);
    }
    const K = globalThis.AtriumKeymap;
    if (K?.registerCommand) for (const [id, title, key] of [["room-move", "Move room", "D M M"], ["rooms-fit", "Fit rooms to components", "D M F"],
      ["rooms-lock", "Lock or unlock rooms", null], ["rooms-show", "Show rooms", null]])
      try {K.registerCommand({id:"rooms:" + id, title, category:"Design", when:"pcb", action:id, defaultKeys:key ? [key] : []});} catch {}
    if (typeof window !== "undefined") {
      window.addEventListener("pointerdown", onDown, true);
      window.addEventListener("pointermove", onMove, true);
      window.addEventListener("pointerup", onUp, true);
      window.addEventListener("keydown", onKey, true);
    }
  }
  const boot = () => globalThis.AtriumNavCommon?.ready?.(install);
  if (globalThis.AtriumNavCommon) boot(); else if (globalThis.document?.addEventListener) document.addEventListener("DOMContentLoaded", boot, {once:true});

  return {validate, list, make, rectPoints, bbox, origin, inside, channelOf, roomOf, members, ecoRoom, uniqueName, partPoints, itemPoints, within, copperIn, around,
    fitPlan, applyFit, movePlan, applyMove, repour, check, drc, roomAt, install, ensureRuleType};
})();
