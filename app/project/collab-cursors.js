"use strict";
// Remote pointers and selections have their own transparent surface in each 2D view.
// Incoming world positions and edit claims stay authoritative while the pointer travels.
globalThis.AtriumCollabCursors = (() => {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(n, hi));
  const overlaps = (a, b) => a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2;
  const samePoint = (a, b) => a && b && a[0] === b[0] && a[1] === b[1];
  function turns(a, b, c) {
    const dx = b[0] - a[0], dy = b[1] - a[1], vx = c[0] - b[0], vy = c[1] - b[1];
    return dx * vx + dy * vy < .7 * Math.hypot(dx, dy) * Math.hypot(vx, vy);
  }
  // Work in screen pixels so a corner means the same thing at every zoom. Only a
  // checkpoint, a substantial turn, or the end of a gesture needs to cross the wire.
  function waypoints(send) {
    const checkpoint = 320, turnInterval = 160, settle = 100, step = 12;
    const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let anchor = null, pivot = null, latest = null, corner = null, sentAt = 0, movedAt = 0, timer = 0;
    function emit(at, end = false, turn = false) {
      anchor = pivot = at; corner = null; sentAt = performance.now();
      send(at, end, turn);
    }
    function check() {
      timer = 0;
      const now = performance.now(), quiet = now - movedAt;
      if (quiet >= settle) {
        if (corner && !samePoint(corner, latest)) emit(corner, false, true);
        emit(latest, true); return;
      }
      const far = distance(anchor, latest) >= step;
      if (corner && now - sentAt >= turnInterval) emit(corner, false, true);
      else if (far && now - sentAt >= checkpoint) emit(latest);
      const remaining = corner ? turnInterval - (now - sentAt) : far ? checkpoint - (now - sentAt) : settle;
      timer = setTimeout(check, Math.max(1, Math.min(settle - quiet, remaining)));
    }
    function move(at) {
      if (samePoint(latest, at)) return;
      latest = at; movedAt = performance.now();
      if (!anchor) { emit(at); return; }
      if (distance(pivot, at) >= step) {
        if (distance(anchor, pivot) >= step && turns(anchor, pivot, at)) corner ||= pivot;
        pivot = at;
      }
      if (corner && movedAt - sentAt >= turnInterval) emit(corner, false, true);
      else if (movedAt - sentAt >= checkpoint && distance(anchor, at) >= step) emit(at);
      if (!timer) timer = setTimeout(check, settle);
    }
    function reset(at = null) {
      clearTimeout(timer); timer = 0; corner = null; anchor = pivot = latest = at; sentAt = performance.now();
    }
    return {move, reset};
  }
  function moves() {
    return globalThis.AtriumMotion?.moves?.() ?? !globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  function position(p, now) {
    const m = p.glide;
    if (!m) return p.at;
    let t = clamp((now - m.start) / m.ms, 0, 1);
    if (t === 1 || !moves()) { p.glide = null; return p.at; }
    let from = m.from, to = p.at;
    if (m.via) {
      if (t < m.split) { to = m.via; t /= m.split; }
      else { from = m.via; t = (t - m.split) / (1 - m.split); }
    }
    const progress = m.end && to === p.at ? t * (2 - t) : t;
    return from.map((v, i) => v + (to[i] - v) * progress);
  }
  function fitText(ctx, label, width) {
    if (ctx.measureText(label).width <= width) return label;
    const letters = Array.from(label);
    let lo = 0, hi = letters.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (ctx.measureText(letters.slice(0, mid).join("") + "…").width <= width) lo = mid;
      else hi = mid - 1;
    }
    return letters.slice(0, lo).join("") + "…";
  }
  // Prefer the tail of the arrow. Try the other side and stack nearby names when tips coincide.
  function placeLabel(x, y, w, width, height, occupied, previous) {
    const h = 19;
    if (width < w + 4 || height < h + 4) return null;
    function candidate(row, above, side) {
      const top = above ? y - h - 4 - row * (h + 3) : y + 13 + row * (h + 3);
      if (top < 2 || top + h > height - 2) return null;
      const shift = Math.floor(side / 2) * (w + 4);
      const left = side % 2 ? x - w - 6 - shift : x + 9 + shift;
      const box = {x: clamp(left, 2, width - w - 2), y: top, w, h, row, above, side};
      return occupied.some(other => overlaps(box, other)) ? null : box;
    }
    // A stacked name can move back beside its pointer when a crowd disperses.
    if (previous && ((!previous.row && previous.side < 2) || occupied.length >= previous.count)) {
      const sameSlot = candidate(previous.row, previous.above, previous.side);
      if (sameSlot) return sameSlot;
    }
    const rows = Math.min(occupied.length, Math.ceil(height / (h + 3)));
    const columns = Math.min(occupied.length + 1, Math.ceil(width / (w + 4)));
    for (let column = 0; column < columns; column++) {
      for (let row = 0; row <= rows; row++) {
        for (const above of [false, true]) {
          for (let side = column * 2; side < column * 2 + 2; side++) {
            const box = candidate(row, above, side);
            if (box) return box;
          }
        }
      }
    }
    return null;
  }
  function selectionBoxes(layer, doc, peers, host) {
    const ids = new Set(peers.flatMap(p => [...(p.sel || []), ...(p.lock || [])])), revision = host.revision();
    if (layer.doc === doc && layer.revision === revision && ids.size === layer.boxes.size && [...ids].every(id => layer.boxes.has(id))) return;
    layer.doc = doc; layer.revision = revision;
    layer.boxes = new Map([...ids].map(id => [id, null]));
    if (!ids.size) return;
    const defs = host.defs(), A = globalThis.Atrium;
    for (const item of doc.items) {
      if (!ids.has(item.id)) continue;
      try {
        const points = A.itemPoints(item, defs.get(item.def), doc.kind);
        if (points?.length) layer.boxes.set(item.id, A.bounds(points));
      } catch { /* This item has no drawable selection bounds. */ }
    }
  }
  function surfaceAfter(canvas, className) {
    const surface = document.createElement("canvas");
    surface.className = className; surface.setAttribute("aria-hidden", "true"); canvas.after(surface);
    return {surface, ctx: surface.getContext("2d")};
  }
  function clearSurface({surface, ctx}, canvas, width, height) {
    if (surface.width !== canvas.width) surface.width = canvas.width;
    if (surface.height !== canvas.height) surface.height = canvas.height;
    ctx.setTransform(surface.width / width, 0, 0, surface.height / height, 0, 0);
    ctx.clearRect(0, 0, width, height);
  }
  // Selections stay on their own surface while pointers animate above them.
  function paintSelections(layer, pane, doc, peers, host, colours, style, width, height) {
    const selected = peers.filter(p => p.sel?.length || p.lock?.length);
    if (!selected.length) { layer.selection?.surface.remove(); layer.selection = null; return; }
    const {canvas, view} = pane, cam = view.camera();
    const key = [cam.cx, cam.cy, cam.scale, cam.flipped, width, height, canvas.width, canvas.height].join("/");
    const selection = layer.selection ||= surfaceAfter(canvas, "collab-selections");
    const paints = selected.map(p => style.getPropertyValue(colours[p.colour]).trim());
    if (layer.doc === doc && layer.revision === host.revision() && selection.key === key &&
        selection.people.length === selected.length && selected.every((p, i) => {
          const old = selection.people[i];
          return old.peer === p && old.sel === p.sel && old.lock === p.lock && old.paint === paints[i];
        })) return;
    selection.key = key;
    selection.people = selected.map((p, i) => ({peer: p, sel: p.sel, lock: p.lock, paint: paints[i]}));
    selectionBoxes(layer, doc, selected, host);
    clearSurface(selection, canvas, width, height);
    const ctx = selection.ctx;
    ctx.lineWidth = 2;
    for (const [i, p] of selected.entries()) {
      ctx.strokeStyle = paints[i];
      for (const id of new Set([...(p.sel || []), ...(p.lock || [])])) {
        const b = layer.boxes.get(id); if (!b) continue;
        const a = view.worldToScreen([b[0], b[1]]), z = view.worldToScreen([b[2], b[3]]);
        ctx.setLineDash(p.lock?.includes(id) ? [] : [5, 3]);
        ctx.strokeRect(Math.min(a[0], z[0]) - 4, Math.min(a[1], z[1]) - 4, Math.abs(z[0] - a[0]) + 8, Math.abs(z[1] - a[1]) + 8);
      }
    }
  }
  function paint(layer, pane, doc, peers, host, colours, style, now) {
    const {canvas, view} = pane, {ctx} = layer;
    const width = canvas.clientWidth, height = canvas.clientHeight;
    if (!width || !height) return false;
    paintSelections(layer, pane, doc, peers, host, colours, style, width, height);
    const tips = [];
    let traveling = false;
    for (const p of peers) {
      const at = position(p, now);
      if (!at) continue;
      const [x, y] = view.worldToScreen(at);
      if (x >= 0 && x < width && y >= 0 && y < height) {
        tips.push({p, x, y, colour: style.getPropertyValue(colours[p.colour]).trim()});
        traveling ||= !!p.glide;
      } else if (p.glide) {
        const [tx, ty] = view.worldToScreen(p.at);
        const corners = p.glide.via && now < p.glide.start + p.glide.ms * p.glide.split ? view.worldToScreen(p.glide.via) : [tx, ty];
        traveling ||= Math.max(x, tx, corners[0]) >= 0 && Math.min(x, tx, corners[0]) < width &&
          Math.max(y, ty, corners[1]) >= 0 && Math.min(y, ty, corners[1]) < height;
      }
    }
    if (!tips.length && !layer.hasInk) return traveling;
    clearSurface(layer, canvas, width, height);
    layer.hasInk = tips.length > 0;
    ctx.font = "600 11px system-ui, sans-serif";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const background = style.getPropertyValue("--menu-bg").trim(), ink = style.getPropertyValue("--ink").trim();
    const occupied = tips.map(t => ({x: t.x - 2, y: t.y - 2, w: 6, h: 7})), labels = [];
    const local = pane.active && host.pointer?.();
    if (local) {
      const [x, y] = view.worldToScreen(local);
      occupied.push({x: x - 4, y: y - 4, w: 12, h: 16});
    }
    for (const {p, x, y, colour} of tips) {
      const label = fitText(ctx, p.name + (p.act ? " — " + p.act : ""), Math.min(250, width - 14));
      const box = placeLabel(x, y, Math.ceil(ctx.measureText(label).width) + 10, width, height, occupied, layer.slots.get(p));
      if (!box) continue;
      box.count = occupied.length;
      layer.slots.set(p, box);
      occupied.push(box);
      labels.push({box, colour, label});
      ctx.strokeStyle = colour; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(clamp(x, box.x, box.x + box.w), clamp(y, box.y, box.y + box.h)); ctx.stroke();
    }
    for (const {box, colour, label} of labels) {
      ctx.strokeStyle = colour;
      ctx.fillStyle = background; ctx.fillRect(box.x, box.y, box.w, box.h);
      ctx.strokeRect(box.x + .5, box.y + .5, box.w - 1, box.h - 1);
      ctx.fillStyle = ink; ctx.fillText(label, box.x + 5, box.y + box.h / 2);
    }
    for (const {x, y, colour} of tips) {
      const dx = x < width - 12 ? 1 : -1, dy = y < height - 14 ? 1 : -1;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 3 * dx, y + 13 * dy); ctx.lineTo(x + 6 * dx, y + 9 * dy); ctx.lineTo(x + 12 * dx, y + 8 * dy); ctx.closePath();
      ctx.fillStyle = colour; ctx.fill(); ctx.strokeStyle = background; ctx.lineWidth = 1; ctx.stroke();
    }
    return traveling;
  }
  function create(host, people, colours) {
    const layers = new Map();
    let frame = 0;
    function request() { if (!frame) frame = requestAnimationFrame(draw); }
    function draw(now) {
      frame = 0;
      const peers = people();
      if (!peers.length && !layers.size) return;
      const seen = new Set(), style = getComputedStyle(document.documentElement);
      for (const pane of host.panes()) {
        const canvas = pane.canvas, doc = host.docById(pane.docId), here = peers.filter(p => p.doc === pane.docId && (p.at || p.sel?.length || p.lock?.length));
        if (!doc || !here.length || globalThis.Atrium3D?.isOpen?.(canvas.parentElement)) continue;
        seen.add(canvas);
        let layer = layers.get(canvas);
        if (!layer) {
          layer = {...surfaceAfter(canvas, "collab-cursors"), boxes: new Map(), slots: new WeakMap()};
          layers.set(canvas, layer);
        }
        if (paint(layer, pane, doc, here, host, colours, style, now)) request();
      }
      for (const [canvas, layer] of layers) if (!seen.has(canvas)) { layer.surface.remove(); layer.selection?.surface.remove(); layers.delete(canvas); }
    }
    function refresh() {
      if (frame) cancelAnimationFrame(frame);
      draw(performance.now());
    }
    function sample(p, doc, at, end = false, turn = false) {
      const now = performance.now(), gap = now - (p.sampleTime ?? now);
      const changed = p.doc !== doc || !samePoint(at, p.at);
      if (!at || !p.at || p.doc !== doc || gap > 1200 || !moves()) p.glide = null;
      else if (changed || (end && p.glide && !p.glide.end)) {
        const from = position(p, now);
        const glide = p.glide;
        // Preserve one unfinished corner when the next point arrives early. Bound its
        // travel time so a delayed burst never leaves the pointer replaying a long trail.
        let via = glide && (p.turn || turns(from, p.at, at)) ? p.at : null;
        if (!via && glide?.via && now < glide.start + glide.split * glide.ms) via = glide.via;
        if (samePoint(via, from) || samePoint(via, at)) via = null;
        const ms = (end ? clamp(gap, 65, 145) : clamp(gap, 40, 440)) + (via ? 60 : 0);
        const leg = via ? Math.hypot(via[0] - from[0], via[1] - from[1]) : 0;
        const split = via ? clamp(leg / (leg + Math.hypot(at[0] - via[0], at[1] - via[1])), .15, .75) : 0;
        p.glide = !via && samePoint(from, at) ? null : {from, via, split, start: now, ms, end};
      }
      if (changed) { p.sampleTime = now; p.turn = turn; }
      p.doc = doc; p.at = at;
      request();
    }
    function stop() {
      cancelAnimationFrame(frame); frame = 0;
      for (const layer of layers.values()) { layer.surface.remove(); layer.selection?.surface.remove(); }
      layers.clear();
    }
    return {sample, request, refresh, stop};
  }
  return Object.freeze({create, waypoints});
})();
