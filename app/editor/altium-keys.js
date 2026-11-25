"use strict";
// Altium muscle memory that needs more than a key binding (lazy: lazy.js loads it on first use).
//
//   Net highlight mask    Ctrl/⌘+click (boards), Alt+click (sheets) or Highlight Net dims everything
//                         except the highlighted net, like the Filter panel's Mask (editor.js sets it).
//   E D                   Delete objects by clicking them, until Escape or right-click.
//   S I / S O             Select the objects inside / outside a two-click area.
//   Shift+W / Shift+V     While routing: choose a track width / via size preset near the cursor.
//   Route › Un-Route      All, Net (delete-net-copper), Connection, Component, Room: one undo step each.
//
// Headless API (pure): AtriumAltiumKeys.unroute(doc, defs, scope, {ids, point}) -> {ids, locked, message}
//                      AtriumAltiumKeys.maskShapes(doc, defs, net) -> {fills, strokes} in world coordinates.
globalThis.AtriumAltiumKeys = (() => {
  const A = () => globalThis.Atrium;
  const EPS = 1e-4;
  const isCopperLayer = l => !globalThis.AtriumPCBAppearance?.index || AtriumPCBAppearance.index(l) >= 0;
  // Routed copper: tracks on copper layers and vias, on a net, not keep-outs.
  const routed = i => !!i.net && !i.keepout && (i.kind === "via" || i.kind === "track" && Array.isArray(i.points) && i.points.length > 1 && isCopperLayer(i.layer));
  function distToPath(p, pts) {
    let d = Infinity;
    for (let k = 1; k < pts.length; k++) d = Math.min(d, A().nearSegment(p, pts[k - 1], pts[k]));
    if (pts.length === 1) d = Math.hypot(p[0] - pts[0][0], p[1] - pts[0][1]);
    return d;
  }
  const ends = i => i.kind === "via" ? [[i.x, i.y]] : [i.points[0], i.points[i.points.length - 1]];
  const shape = i => i.kind === "via" ? [[i.x, i.y]] : i.points;
  const reach = i => i.kind === "via" ? (i.diameter || .6) / 2 : (i.width || .2) / 2;

  // Pads of one net on a board: {at, r} (parts' pads by pinNets, and free pads).
  function padsOf(doc, defs, net) {
    const out = [];
    for (const i of doc.items) {
      if (i.kind === "pad" && i.net === net) out.push({at:[i.x, i.y], r:Math.max(i.w || i.diameter || .5, i.h || i.diameter || .5) / 2});
      else if (i.kind === "part") {
        for (const p of A().pins(i, defs.get(i.def), "pcb")) if ((i.pinNets?.[p.number] ?? p.net) === net) out.push({at:p.at, r:Math.max(p.w || p.diameter || .5, p.h || p.diameter || .5) / 2, part:i.id});
      }
    }
    return out;
  }
  const inPad = (q, pads) => pads.some(p => Math.hypot(q[0] - p.at[0], q[1] - p.at[1]) <= p.r + EPS);
  // Two pieces of copper touch when an end of one lies on the other (same layer for tracks).
  // With `stops`, a touch inside a pad does not join them: a connection runs pad to pad.
  function touch(a, b, stops) {
    if (a.kind === "track" && b.kind === "track" && a.layer !== b.layer) return false;
    const test = (x, y) => {
      const tol = Math.max(reach(y), x.kind === "via" ? reach(x) : 0) + EPS;
      for (const q of ends(x)) if (distToPath(q, shape(y)) <= tol && !(stops && inPad(q, stops))) return true;
      return false;
    };
    return test(a, b) || test(b, a);
  }
  // Copper connected to the seeds through tracks and vias of the same net, stopping at pads.
  function flood(doc, defs, seeds) {
    const out = new Set(), byNet = new Map();
    for (const s of seeds) {if (!byNet.has(s.net)) byNet.set(s.net, []); byNet.get(s.net).push(s);}
    for (const [net, list] of byNet) {
      const copper = doc.items.filter(i => routed(i) && i.net === net), pads = padsOf(doc, defs, net);
      const todo = list.slice(), seen = new Set(list.map(i => i.id));
      while (todo.length) {
        const a = todo.pop(); out.add(a.id);
        for (const b of copper) if (!seen.has(b.id) && touch(a, b, pads)) {seen.add(b.id); todo.push(b);}
      }
    }
    return out;
  }
  function inside(points, p) {
    let n = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
      const [xi, yi] = points[i], [xj, yj] = points[j];
      if (A().nearSegment(p, points[i], points[j]) <= EPS) return true;
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) n = !n;
    }
    return n;
  }
  function roomFor(doc, defs, ids, point) {
    const rooms = Array.isArray(doc.rooms) ? doc.rooms : [];
    if (point) return rooms.find(r => inside(r.points, point)) || null;
    for (const i of doc.items) {
      if (!ids.includes(i.id)) continue;
      const pts = i.kind === "part" ? [[i.x, i.y]] : A().itemPoints(i, defs.get(i.def), "pcb");
      const r = rooms.find(r => pts.every(p => inside(r.points, p)));
      if (r) return r;
    }
    return null;
  }
  // Ids of the routed copper an Un-Route scope removes. scope: all | net | connection | component | room.
  function unroute(doc, defs, scope, o = {}) {
    const ids = o.ids || [], chosen = doc.items.filter(i => ids.includes(i.id));
    let found = [], what = "";
    if (scope === "all") {found = doc.items.filter(routed); what = "on the board";}
    else if (scope === "net") {
      const net = o.net || chosen.map(i => i.net || "").find(Boolean) || "";
      if (!net) return {ids:[], locked:0, message:"Select a track or via on a net first."};
      found = doc.items.filter(i => routed(i) && i.net === net); what = "on net " + net;
    } else if (scope === "connection") {
      const seeds = chosen.filter(routed);
      if (!seeds.length) return {ids:[], locked:0, message:"Click or select a track or via of the connection."};
      const set = flood(doc, defs, seeds); found = doc.items.filter(i => set.has(i.id)); what = "in the connection";
    } else if (scope === "component") {
      const parts = chosen.filter(i => i.kind === "part");
      if (!parts.length) return {ids:[], locked:0, message:"Click or select a component."};
      const seeds = [];
      for (const part of parts) for (const p of A().pins(part, defs.get(part.def), "pcb")) {
        const net = part.pinNets?.[p.number] ?? p.net; if (!net) continue;
        const r = Math.max(p.w || p.diameter || .5, p.h || p.diameter || .5) / 2;
        for (const c of doc.items) if (routed(c) && c.net === net && ends(c).some(q => Math.hypot(q[0] - p.at[0], q[1] - p.at[1]) <= r + reach(c) + EPS)) seeds.push(c);
      }
      const set = flood(doc, defs, seeds); found = doc.items.filter(i => set.has(i.id));
      what = "on " + parts.map(p => p.ref || "the component").join(", ");
    } else if (scope === "room") {
      const room = roomFor(doc, defs, ids, o.point);
      if (!room) return {ids:[], locked:0, message:"Click inside a room, or select an object in one."};
      found = doc.items.filter(i => routed(i) && shape(i).every(p => inside(room.points, p))); what = "inside room " + (room.name || "");
    } else return {ids:[], locked:0, message:"Unknown Un-Route scope " + scope + "."};
    const locked = found.filter(i => i.locked).length, out = found.filter(i => !i.locked).map(i => i.id);
    const n = out.length;
    return {ids:out, locked, message:n ? "Un-routed " + n + " track and via object" + (n === 1 ? "" : "s") + " " + what + (locked ? " (" + locked + " locked kept)" : "") + ". Undo restores them."
      : "No unlocked tracks or vias " + what + "."};
  }

  // ------------------------------------------------------------------ highlight mask
  // World-space cut-outs for one net: fills (pads, vias, pours, labels, pins) and strokes by width.
  function maskShapes(doc, defs, net, graph, members) {
    const fills = [], strokes = new Map(), X = globalThis.AtriumCrossProbe, C = globalThis.AtriumNavCommon;
    const stroke = (w, pts) => {const k = Math.round(w * 1e4) / 1e4; if (!strokes.has(k)) strokes.set(k, []); strokes.get(k).push(pts);};
    const rect = (b, pad = 0) => fills.push({rect:[b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad]});
    const corners = (w, h, at) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sy]) => at([sx * w / 2, sy * h / 2]));
    if (doc.kind === "pcb") {
      for (const i of doc.items) {
        if (i.kind === "part") {
          const g = A().gate?.(A().geometries(defs.get(i.def), "pcb"), i);
          for (const p of g?.pads || []) {
            if ((i.pinNets?.[p.number] ?? p.net) !== net) continue;
            const w = p.w || p.diameter || .5, h = p.h || p.diameter || .5;
            fills.push({poly:corners(w, h, q => A().world(A().world(q, p), i))});
          }
          continue;
        }
        if (i.net !== net) continue;
        if (i.kind === "track" && i.points?.length) {if (i.fill && i.points.length > 2) fills.push({poly:i.points}); else stroke(i.width || .2, i.points);}
        else if (i.kind === "via") fills.push({circle:[i.x, i.y, (i.diameter || .6) / 2]});
        else if (i.kind === "pad") fills.push({poly:corners(i.w || i.diameter || .5, i.h || i.diameter || .5, q => A().world(q, i))});
        // A pour's outline only when it has no poured copper yet (poured regions are cut in overlay()).
        else if (i.kind === "polygon" && i.points?.length > 2 && !(doc.pcbDrawing?.pours || []).some(r => r.polygon === i.id)) fills.push({poly:i.points});
      }
    } else {
      if (members && !members.ids.size && !members.pins.length) return {fills, strokes:[]};
      const n = members ? null : graph || X?.schematicNets?.(doc, defs) || A().connectivity(doc, defs);
      const wireMatches = members ? id => members.ids.has(id) : id => n.byWire.get(id) === net;
      if (members) for (const {pin} of members.pins) fills.push({circle:[pin.at[0], pin.at[1], 1.1]});
      let wirePoints;
      for (const i of doc.items) {
        if (i.kind === "wire" && wireMatches(i.id)) stroke(.6, i.points);
        else if (i.kind === "part" && !members) {
          for (const p of A().pins(i, defs.get(i.def), "schematic")) if (n.byPin.get(i.id + "/" + p.number) === net)
            fills.push({circle:[p.at[0], p.at[1], 1.1]});
        } else if ((members ? members.ids.has(i.id) : i.text === net) &&
          (i.kind === "netlabel" || globalThis.AtriumSchObjects?.KINDS?.has(i.kind)) && C?.itemBox) {
          const b = C.itemBox(doc, defs, i); if (b) rect(b, .6);
        }
        else if (i.kind === "junction") {
          if (!wirePoints) {
            wirePoints = new Set();
            for (const w of doc.items) if (w.kind === "wire" && wireMatches(w.id))
              for (const p of w.points) wirePoints.add(A().pointKey(p));
          }
          if (wirePoints.has(A().pointKey([i.x, i.y]))) fills.push({circle:[i.x, i.y, 1]});
        }
      }
    }
    return {fills, strokes:[...strokes]};
  }
  const cache = new WeakMap();
  function pathsFor(doc, defs, net, revision, members, transient) {
    const graph = !members && doc.kind === "schematic" && globalThis.AtriumCrossProbe?.schematicNets?.(doc, defs);
    const version = members || graph || revision;
    let c = cache.get(doc);
    if (!transient && c && c.net === net && c.items === doc.items && c.length === doc.items.length && c.version === version && c.defs === defs) return c.paths;
    const sh = maskShapes(doc, defs, net, graph, members), fill = new Path2D(), strokes = [];
    for (const f of sh.fills) {
      if (f.rect) fill.rect(f.rect[0], f.rect[1], f.rect[2] - f.rect[0], f.rect[3] - f.rect[1]);
      else if (f.circle) {fill.moveTo(f.circle[0] + f.circle[2], f.circle[1]); fill.arc(f.circle[0], f.circle[1], f.circle[2], 0, Math.PI * 2);}
      else if (f.poly) {fill.moveTo(f.poly[0][0], f.poly[0][1]); for (let k = 1; k < f.poly.length; k++) fill.lineTo(f.poly[k][0], f.poly[k][1]);} // filled only: fill() closes it
    }
    for (const [w, list] of sh.strokes) {
      const p = new Path2D();
      for (const pts of list) {p.moveTo(pts[0][0], pts[0][1]); for (let k = 1; k < pts.length; k++) p.lineTo(pts[k][0], pts[k][1]);}
      strokes.push([w, p]);
    }
    const paths = {fill, strokes};
    if (!transient) cache.set(doc, {net, items:doc.items, length:doc.items.length, version, defs, paths});
    return paths;
  }
  function colours(kind) {
    const PCB = globalThis.AtriumPCBAppearance?.system, SCH = globalThis.AtriumSchAppearance;
    const base = String(kind === "pcb" ? PCB?.workspace || "#1e1e1e" : SCH?.workspace || "#f4f4f2");
    const m = /^#([0-9a-f]{6})$/i.exec(base), v = m ? parseInt(m[1], 16) : 0x1e1e1e;
    const light = (0.2126 * (v >> 16 & 255) + 0.7152 * (v >> 8 & 255) + 0.0722 * (v & 255)) > 140;
    return {dim:light ? "#ffffff" : "#000000", alpha:light ? .62 : .6};
  }
  let maskCanvas = null, maskKey = null;
  function overlay(host, doc) {
    return (ctx, info) => {
      const net = host.highlight();
      if (!net || !ctx.getTransform || typeof Path2D !== "function" || typeof document === "undefined") return;
      const members = host.highlightMembers?.(doc);
      const paths = pathsFor(doc, host.defs(), net, host.revision(), members, members && host.drag?.()?.before),
        cv = ctx.canvas, scale = info.scale || 1, c = colours(doc.kind);
      if (!maskCanvas) maskCanvas = document.createElement("canvas");
      if (maskCanvas.width !== cv.width || maskCanvas.height !== cv.height) {maskCanvas.width = cv.width; maskCanvas.height = cv.height; maskKey = null;}
      // Rebuilt only when the view, the canvas size, the net's shapes or its pours change.
      const t = ctx.getTransform(), pours = doc.kind === "pcb" ? doc.pcbDrawing?.pours || null : null;
      const key = [cv.width, cv.height, t.a, t.b, t.c, t.d, t.e, t.f, paths, pours, pours?.length, net, c.alpha, c.dim, scale, !!globalThis.AtriumPCBPours];
      if (!maskKey || key.some((v, k) => v !== maskKey[k])) {
        const m = maskCanvas.getContext("2d");
        m.setTransform(1, 0, 0, 1, 0, 0); m.globalCompositeOperation = "source-over"; m.clearRect(0, 0, cv.width, cv.height);
        m.globalAlpha = c.alpha; m.fillStyle = c.dim; m.fillRect(0, 0, cv.width, cv.height);
        m.setTransform(t); m.globalAlpha = 1; m.globalCompositeOperation = "destination-out";
        m.fillStyle = "#000"; m.fill(paths.fill); m.lineCap = "round"; m.lineJoin = "round";
        if (doc.kind === "pcb" && globalThis.AtriumPCBPours) for (const r of pours || []) if (r.net === net) try {AtriumPCBPours.paint(m, r);} catch {}
        for (const [w, p] of paths.strokes) {m.lineWidth = w + 3 / scale; m.stroke(p);}
        m.globalCompositeOperation = "source-over";
        maskKey = key;
      }
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.drawImage(maskCanvas, 0, 0); ctx.restore();
    };
  }

  // ------------------------------------------------------------------ pick tools
  let host = null;
  const sel = () => host.selection();
  // Point picks snap to the grid; hit tests use the raw pointer.
  const raw = p => host.pointer?.() || p;
  async function deletePick() {
    let n = 0;
    for (;;) {
      const p = await host.pickPoint(n ? "Deleted " + n + ". Click the next object to delete; Escape or right-click ends." : "Delete: click the objects to delete. Escape or right-click ends.");
      if (!p) {if (n) host.info("Deleted " + n + " object" + (n === 1 ? "" : "s") + ". Undo restores them."); return n;}
      const hit = host.hitAt(raw(p));
      if (!hit || !host.selectableItems().includes(hit)) continue;
      const before = host.doc().items.length;
      host.select([hit.id]); host.act("delete");
      if (host.doc().items.length < before) n++;
    }
  }
  async function areaSelect(outside) {
    const a = await host.pickPoint((outside ? "Select Outside Area" : "Select Inside Area") + ": click the first corner.");
    if (!a) return;
    const b = await host.pickPoint("Click the opposite corner.", {from:a});
    if (!b) return;
    const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    let ids;
    if (!outside) ids = host.enclosed(box).map(i => i.id);
    else {
      const d = host.doc(), defs = host.defs();
      ids = host.selectableItems().filter(i => {
        const bb = A().bounds(A().itemPoints(i, defs.get(i.def), d.kind));
        return bb && (bb[2] < box[0] || bb[0] > box[2] || bb[3] < box[1] || bb[1] > box[3]);
      }).map(i => i.id);
    }
    host.select(ids);
    host.info(ids.length + " object" + (ids.length === 1 ? "" : "s") + " selected " + (outside ? "outside" : "inside") + " the area.");
  }
  async function unrouteCommand(scope) {
    const d = host.doc();
    if (d.kind !== "pcb") {host.info("Un-Route works on a board layout."); return;}
    let ids = sel(), point = null;
    const need = {connection:i => routed(i), component:i => i.kind === "part", room:() => true}[scope];
    if (need && !d.items.some(i => ids.includes(i.id) && need(i))) {
      const p = await host.pickPoint({connection:"Un-Route Connection: click a track or via of the connection.", component:"Un-Route Component: click a component.",
        room:"Un-Route Room: click inside the room."}[scope] + " Escape cancels.");
      if (!p) return;
      if (scope === "room") point = raw(p);
      else {const hit = host.hitAt(raw(p)); ids = hit ? [hit.id] : [];}
    }
    const r = unroute(d, host.defs(), scope, {ids, point});
    if (r.ids.length) {const gone = new Set(r.ids); host.edit(() => {d.items = d.items.filter(i => !gone.has(i.id));}); host.select([]);}
    host.info(r.message);
    return r;
  }

  // ------------------------------------------------------------------ net highlight, Select Net, layers, properties
  const X = () => globalThis.AtriumCrossProbe;
  // Ctrl/⌘+click on a board (editor.js sets the pointer): highlight the net under it, or clear on empty canvas.
  function netClick() {
    const p = host.pointer(), d = host.doc(), hit = p && host.hitAt(p), net = hit ? X()?.targetAt(d, host.defs(), hit, p)?.net || "" : "";
    if (net) {
      const clear = globalThis.AtriumKeymap?.hintFor("query-clear", d.kind);
      host.setHighlight(net); host.info("Net " + net + " highlighted. " + (clear ? clear + " or a click" : "A click") + " on empty canvas clears it.");
    }
    else if (hit) host.info("This object is not on a net.");
    else if (host.clearHighlight()) host.info("Net highlight cleared.");
  }
  // Shift+C (and the status-bar chip): clear the Filter and the net highlight together.
  function clearAll() {
    const lit = host.clearHighlight(), Q = globalThis.AtriumQuery, filtered = !!Q?.applied?.();
    if (filtered) Q.clear(true);
    host.info(filtered && lit ? "Filter and net highlight cleared" : filtered ? "Filter cleared" : lit ? "Net highlight cleared" : "No filter or net highlight to clear");
  }
  function selectNet(net) {
    const d = host.doc(), selectable = new Set(host.selectableItems().map(i => i.id));
    const ids = X().netObjects(d, host.defs(), net).ids.filter(id => selectable.has(id));
    host.select(ids); host.info("Net " + net + ": " + ids.length + " object" + (ids.length === 1 ? "" : "s") + " selected.");
  }
  // Select Net (S N, Ctrl+H on boards): the net of the selection or highlight, else click an object on it.
  async function selectNetPick() {
    const d = host.doc(), t = X()?.targetForSelection(d, host.defs(), host.selection(), host.highlight());
    if (t?.net) return selectNet(t.net);
    const p = await host.pickPoint("Select Net: click an object on the net. Escape cancels."); if (!p) return;
    const at = raw(p), hit = host.hitAt(at), net = hit && X()?.targetAt(host.doc(), host.defs(), hit, at)?.net;
    if (!net) {host.info("That object is not on a net."); return;}
    selectNet(net);
  }
  // Move Selection (M S) and Drag (M D): pick a reference point (or the object), then it follows the pointer.
  async function stickyMove(sel) {
    const d = host.doc();
    if (d.kind === "panel") return;
    if (sel && !host.selection().length) {host.info("Select the objects to move first."); return;}
    const ids = host.selection();
    const p = await host.pickPoint(sel ? "Move Selection: click the reference point." : "Drag: click the object to drag."); if (!p) return;
    let item;
    if (sel) {host.select(ids); item = host.doc().items.find(i => ids.includes(i.id));}
    else {
      item = host.hitAt(raw(p)); if (item && !host.selectableItems().includes(item)) item = null;
      if (!item) {host.info("Nothing to drag there."); return;}
      if (!host.selection().includes(item.id)) host.select([item.id], item.id);
    }
    if (!item) return;
    host.beginStickyMove(item, p);
    host.info((sel ? "Move the selection" : "Drag " + (item.ref || item.kind)) + ", then click to place. Escape or right-click cancels.");
  }
  // Double-click a board object: select it and edit it in the Properties panel.
  function boardProperties() {
    const p = host.pointer(); let hit = p && host.hitAt(p);
    if (hit && !host.selectableItems().includes(hit)) hit = null;
    if (!hit) return;
    document.body.classList.remove("hide-right");
    host.select([hit.id], hit.id);
    const field = [...document.querySelectorAll("#inspector input:not([type=hidden]):not([type=checkbox]):not([disabled]):not([readonly]),#inspector select:not([disabled]),#inspector textarea:not([disabled])")]
      .find(n => !n.closest(".pcb-edit-filter-section"));
    field?.focus(); field?.select?.();
    host.info("Properties: " + (hit.ref || hit.kind) + ". Enter applies, Escape returns to the canvas.");
  }
  // + / − step through the shown copper layers, * through the signal layers (planes skipped).
  function stepLayer(action) {
    const d = host.doc(); if (d.kind !== "pcb") return;
    const hidden = host.hiddenLayers(), name = l => globalThis.AtriumPCBAppearance?.name?.(l) || l;
    let ls = host.copperLayers().filter(l => !hidden.has(l));
    if (action === "layer-signal-next") {
      const planes = new Set((globalThis.AtriumStackup?.stored?.(d)?.layers || []).filter(l => l.type === "Plane").map(l => l.key));
      const sig = ls.filter(l => !planes.has(l)); if (sig.length) ls = sig;
    }
    if (!ls.length) {host.info("Show a copper layer first."); return;}
    const cur = host.activeLayer(), k = ls.indexOf(cur), next = ls[k < 0 ? 0 : (k + (action === "layer-prev" ? -1 : 1) + ls.length) % ls.length];
    if (next === cur) {host.info("Only one layer is shown: " + name(next)); return;}
    host.setLayer(next);
    if (!host.liveRoute()) host.info("Current layer: " + name(next));
  }
  // Status-bar chip naming the highlighted net (click clears it); synced on every render.
  let chipNet = null;
  function syncChip(force = false) {
    const net = host.highlight();
    if ((!force && net === chipNet) || typeof document === "undefined") return;
    chipNet = net; let chip = document.getElementById("net-highlight");
    if (!net) {if (chip) chip.hidden = true; return;}
    if (!chip) {
      const st = document.getElementById("status"); if (!st) return;
      chip = document.createElement("button"); chip.type = "button"; chip.id = "net-highlight"; chip.className = "status-units status-net"; chip.dataset.action = "query-clear"; st.before(chip);
    }
    const label = "Highlighted net " + net + ". Click to clear it.";
    chip.hidden = false; chip.textContent = "Net " + net; chip.setAttribute("aria-label", label);
    globalThis.AtriumNavCommon.shortcutTitle(chip, label, globalThis.AtriumKeymap?.hintKey("query-clear", host.doc().kind));
  }

  globalThis.AtriumKeymap?.onChange(() => {if (host?.highlight?.()) syncChip(true);});

  // ------------------------------------------------------------------ Shift+W / Shift+V preset choosers
  let menu = null;
  function closeMenu(refocus = true) {if (!menu) return; const m = menu; menu = null; m.remove(); if (refocus) host?.canvas()?.focus();}
  function chooser(kind) {
    const R = host.routeTool?.();
    if (!R) {host.info("Shift+W and Shift+V choose a track width or via size while routing."); return;}
    const ps = R.presets();
    if (!ps) {host.info("This routing mode has no presets."); return;}
    const U = A().units, unit = host.units(), f = v => U.format(v, unit);
    const st = R.state(), list = kind === "width" ? ps.widths || [] : ps.vias || [];
    if (!list.length) {host.info("No " + (kind === "width" ? "track width" : "via") + " presets for this net."); return;}
    closeMenu(false);
    const C = globalThis.AtriumNavCommon, el = C.el;
    menu = el("div", null, "nav-menu"); globalThis.AtriumWorkbench?.wholePixels(menu); menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", kind === "width" ? "Track Width" : "Via Size");
    const head = el("div", kind === "width" ? "Track Width" : "Via Size", "nav-menu-head"); head.setAttribute("role", "presentation"); menu.append(head);
    const items = [];
    list.slice(0, 9).forEach((v, n) => {
      const current = kind === "width" ? Math.abs(v - (st.width ?? -1)) < 1e-9 : st.via && Math.abs(v.diameter - st.via.diameter) < 1e-9 && Math.abs(v.drill - st.via.drill) < 1e-9;
      const label = kind === "width" ? f(v) : f(v.diameter) + " / " + f(v.drill) + " drill";
      const b = el("button", null, "nav-menu-item"); b.type = "button"; b.setAttribute("role", "menuitemradio"); b.setAttribute("aria-checked", String(!!current));
      b.append(el("span", label), AtriumShortcut.render(String(n + 1), {variant:"inline"}));
      b.onclick = () => {closeMenu(); if (kind === "width") {R.setWidth(v); host.info("Track width " + f(v));} else {R.setVia(v); host.info("Via " + label);}};
      menu.append(b); items.push(b);
    });
    menu.addEventListener("keydown", e => {
      const at = items.indexOf(document.activeElement), k = e.key;
      e.stopPropagation();
      if (k === "Escape" || k === "Tab") {e.preventDefault(); closeMenu(); return;}
      if (/^[1-9]$/.test(k) && items[+k - 1]) {e.preventDefault(); items[+k - 1].click(); return;}
      const step = {ArrowDown:1, ArrowUp:-1}[k];
      if (step) {e.preventDefault(); items[(at + step + items.length) % items.length]?.focus();}
    });
    menu.addEventListener("focusout", e => {if (menu && !menu.contains(e.relatedTarget)) closeMenu(false);});
    menu.addEventListener("mousedown", e => e.preventDefault());
    document.body.append(menu);
    const c = host.canvas(), rc = c.getBoundingClientRect(), pt = host.pointer?.(), s = pt ? host.view().worldToScreen(pt) : [rc.width / 2, rc.height / 2];
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(rc.left + s[0] + 12, innerWidth - r.width - 4)) + "px";
    menu.style.top = Math.max(4 + (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0), Math.min(rc.top + s[1] + 12, innerHeight - r.height - 4)) + "px"; // below the title bar
    (items.find(b => b.getAttribute("aria-checked") === "true") || items[0]).focus();
    return menu;
  }

  function attach(h) {
    host = h;
    host.addRenderer((d, info) => {if (info?.active) syncChip(); return host.highlight() && d && d.kind !== "panel" ? {overlay:overlay(host, d)} : null;});
    host.on?.("highlight", () => {syncChip(); if (!host.highlight() && maskCanvas) {maskKey = null; maskCanvas.width = maskCanvas.height = 1;}});
    host.registerAction("net-click", netClick);
    host.registerAction("highlight-filter-clear", clearAll);
    host.registerAction("select-net-pick", selectNetPick);
    host.registerAction("move-selection", () => stickyMove(true));
    host.registerAction("drag-object", () => stickyMove(false));
    host.registerAction("board-properties", boardProperties);
    host.registerAction("layer-next", () => stepLayer("layer-next"));
    host.registerAction("layer-prev", () => stepLayer("layer-prev"));
    host.registerAction("layer-signal-next", () => stepLayer("layer-signal-next"));
    host.registerAction("delete-pick", deletePick);
    host.registerAction("select-inside", () => areaSelect(false));
    host.registerAction("select-outside", () => areaSelect(true));
    host.registerAction("unroute-all", () => unrouteCommand("all"));
    host.registerAction("unroute-connection", () => unrouteCommand("connection"));
    host.registerAction("unroute-component", () => unrouteCommand("component"));
    host.registerAction("unroute-room", () => unrouteCommand("room"));
    host.registerAction("route-width-pick", () => chooser("width"));
    host.registerAction("route-via-pick", () => chooser("via"));
    if (typeof document !== "undefined") document.addEventListener("pointerdown", e => {if (menu && !menu.contains(e.target)) closeMenu(false);}, true);
    syncChip(); host.redraw?.();
  }
  globalThis.AtriumNavCommon?.ready(attach);

  return Object.freeze({unroute, maskShapes, flood, chooser, selectNet, attach});
})();
