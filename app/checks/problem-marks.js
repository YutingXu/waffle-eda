"use strict";
// One size for every problem marker on sheets and boards: ERC and check markers (sch-markers.js), DRC
// markers (drc-markers.js), Design Insight diamonds (insights-ui.js) and the badge a problem shows on
// the other document (checks-cross.js, drawn here). A marker is sized in world units, so it grows with
// the drawing as you zoom in, and clamped on screen: never under MIN px (still findable zoomed out, the
// size the overview cells are built for) and never over MAX px (it does not swamp the pins it points at).
// Hit areas use hit(), so they track the drawn size.
globalThis.AtriumProblemMarks = (() => {
  const MIN = 7, MAX = 14;
  // World radius: about a pin number's height on a sheet (mm), a small pad on a board (mm).
  const WORLD = {schematic: .7, pcb: .35};
  // A hint (live finding not yet compiled, a Design Insight) is quieter and smaller; a badge for a
  // problem on the other document is smaller too.
  const TIER = {hint: .7, badge: .8};
  // size(scale, kind, tier) -> {r: world radius, screen: radius in px, px: one screen px in world
  // units, w: stroke factor (1 at MIN, growing slower than the glyph)}.
  function size(scale, kind = "pcb", tier = null) {
    const s = scale > 0 ? scale : 1, screen = Math.min(MAX, Math.max(MIN, (WORLD[kind] ?? WORLD.pcb) * s)) * (TIER[tier] ?? 1);
    return {r: screen / s, screen, px: 1 / s, w: Math.sqrt(Math.max(1, screen / MIN))};
  }
  // Stroke weights in screen px (times size().w): a thin severity outline on a slim dark halo that keeps it
  // readable on copper, and a little heavier for the hovered or pinned marker. Quiet enough that a board
  // with hundreds of findings reads as a board with notes on it, not as an alarm.
  const STROKE = Object.freeze({line: 1.2, hot: 1.7, halo: 2.4});
  // Pointer reach in screen px for a marker of screen radius `screen`.
  const hit = screen => screen + 4;
  // A pane view's scale (a method on editor panes, a number on plain views).
  const scaleOf = view => (typeof view?.scale === "function" ? view.scale() : view?.scale) || 1;
  // Board canvas palette (the board is dark in every theme). Severity first; ring is the focus ring
  // of the pinned problem, halo the dark edge that keeps glyphs readable on copper.
  const BOARD = Object.freeze({error: "#ff5a52", warning: "#ffb22e", waived: "#a3acb6", hint: "#b7a2ff", halo: "rgba(0,0,0,.7)", ring: "#ffffff", dim: "#7f8a7f"});

  // ---------------------------------------------------------------- merging close markers
  // cluster(rows, atOf, scale, kind, rank) -> [{rep, first, members, at}]: markers closer on screen than
  // a marker's diameter (they would overlap) draw as one. Greedy in list order on a world grid of that
  // size, so it is linear and the same rows at the same scale always give the same groups (drawing
  // and the pointer agree). at = the first member's place (stable as others join); rep = the first
  // member of the worst rank (lowest rank value): the glyph drawn and the one a click opens.
  function cluster(rows, atOf, scale, kind, rank) {
    const d = 2 * size(scale, kind).r, grid = new Map(), out = [];
    for (const row of rows) {
      const at = atOf(row);
      if (!at) continue;
      const gx = Math.floor(at[0] / d), gy = Math.floor(at[1] / d);
      let best = null, bd = d;
      for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const c of grid.get((gx + i) + "," + (gy + j)) || []) {
        const e = Math.hypot(c.at[0] - at[0], c.at[1] - at[1]);
        if (e < bd) { bd = e; best = c; }
      }
      if (best) { best.members.push(row); if (rank(row) < rank(best.rep)) best.rep = row; continue; }
      const c = {rep: row, first: row, members: [row], at}, k = gx + "," + gy;
      out.push(c);
      if (grid.has(k)) grid.get(k).push(c); else grid.set(k, [c]);
    }
    return out;
  }
  // Each source publishes a plan at the pane's actual camera. Painters use its world anchors and the
  // picker builds the CSS-pixel index on demand. One latest plan per source is held only by its canvas.
  const panes = new WeakMap(), CELL = 48;
  function register() {
    const source = Symbol();
    return (doc, frame, stamp, build) => {
      const {canvas, scale, width, height, worldToScreen, worldViewport} = frame;
      const make = () => ({...build(), worldToScreen});
      if (!canvas || !stamp || !worldToScreen) return make();
      let sources = panes.get(canvas);
      if (!sources) panes.set(canvas, sources = new Map());
      const key = [doc, scale, width, height, ...(worldViewport?.(null) || []),
        ...worldToScreen([0, 0]), ...worldToScreen([1, 0]), ...worldToScreen([0, 1]), ...stamp];
      const old = sources.get(source);
      if (old?.key.length === key.length && key.every((v, i) => v === old.key[i])) return old.plan;
      const plan = make();
      sources.set(source, {key, plan});
      return plan;
    };
  }
  function paneFrame(pane, rect) {
    const {canvas, view} = pane;
    return {canvas, scale: scaleOf(view), width: rect.width, height: rect.height, options: pane.options, selectable: view.selectable,
      worldToScreen: p => view.worldToScreen(p),
      worldViewport: view.worldViewport && ((area, pad) => view.worldViewport(area, pad))};
  }
  const cellKey = (x, y) => x + "," + y;
  function pick(plan, x, y) {
    const project = plan.worldToScreen;
    if (!project) return null;
    if (!plan.slots) {
      const slots = plan.slots = new Map();
      for (const mark of plan.marks) {
        if (!mark.live) continue;
        const [sx, sy] = project(mark.at), r = mark.reach, entry = {mark, sx, sy};
        for (let col = Math.floor((sx - r) / CELL); col <= Math.floor((sx + r) / CELL); col++) {
          for (let row = Math.floor((sy - r) / CELL); row <= Math.floor((sy + r) / CELL); row++) {
            const key = cellKey(col, row);
            let bucket = slots.get(key);
            if (!bucket) slots.set(key, bucket = []);
            bucket.push(entry);
          }
        }
      }
    }
    let best = null, distance = Infinity;
    for (const {mark, sx, sy} of plan.slots.get(cellKey(Math.floor(x / CELL), Math.floor(y / CELL))) || []) {
      const d = Math.hypot(sx - x, sy - y);
      if (d <= mark.reach && d <= distance) { best = mark; distance = d; }
    }
    return best;
  }
  // The dense painters use cells aligned to the scaled model, so pan strips keep the same winners.
  function cells(rows, atOf, scale, cell, rank) {
    const grid = new Map(), groups = [];
    for (const row of rows) {
      const at = atOf(row);
      if (!at) continue;
      const x = Math.floor(at[0] * scale / cell), y = Math.floor(at[1] * scale / cell);
      let column = grid.get(x);
      if (!column) grid.set(x, column = new Map());
      const score = rank(row), old = column.get(y);
      if (old) {
        old.members.push(row);
        if (score > old.score) { old.rep = row; old.at = at; old.score = score; }
      } else {
        const group = {rep: row, members: [row], at, score};
        column.set(y, group);
        groups.push(group);
      }
    }
    return groups;
  }
  const CLOSE_PCB_SCALE = 32;
  // Every world cell becomes four children at the next band. Their boundaries never move with the pane.
  function pcbCell({scale, worldToScreen}) {
    return worldToScreen && scale > 0 && scale < CLOSE_PCB_SCALE ?
      2 ** Math.floor(Math.log2(2 * CLOSE_PCB_SCALE / scale)) : 0;
  }
  function visibleWinner(group, {worldToScreen, width, height}, atOf, rank, dx = 0, dy = 0) {
    if (!width || !height) return group.rep;
    const onscreen = row => {
      const [x,y] = worldToScreen(atOf(row));
      return x - dx >= 0 && x - dx < width && y - dy >= 0 && y - dy < height;
    };
    if (onscreen(group.rep)) return group.rep;
    let best = null;
    for (const row of group.members) if ((!best || rank(row) > rank(best)) && onscreen(row)) best = row;
    return best || group.rep;
  }
  // Compare both snapped cameras with the same world membership; only changed glyphs need repairs.
  function groupPanDamage(groups, frame, atOf, rank, radius, dx, dy) {
    const rects = [];
    for (const group of groups) {
      if (group.members.length < 2) continue;
      const before = visibleWinner(group, frame, atOf, rank, dx, dy), after = visibleWinner(group, frame, atOf, rank);
      if (before === after) continue;
      for (const row of [before, after]) {
        const [x,y] = frame.worldToScreen(atOf(row));
        rects.push([x - radius, y - radius, x + radius, y + radius]);
      }
    }
    return rects;
  }
  // The camera determinant detects a flip even when rotation points the world x axis left.
  function mirrored(ctx, a) {
    const m = ctx.getTransform?.();
    if (m) return m.a * m.d - m.b * m.c < 0;
    if (typeof a.worldToScreen !== "function") return false;
    const [x, y] = a.worldToScreen([0, 0]), p = a.worldToScreen([1, 0]), q = a.worldToScreen([0, 1]);
    return (p[0] - x) * (q[1] - y) - (p[1] - y) * (q[0] - x) < 0;
  }
  // The small count beside a marker of screen radius z (more than one problem in it): right of the
  // glyph, unmirrored on a flipped board.
  function count(ctx, a, x, y, z, n, c) {
    if (!(n > 1)) return;
    const flip = mirrored(ctx, a);
    ctx.save(); ctx.setLineDash([]); ctx.globalAlpha = 1;
    ctx.translate(x + z.r * 1.05, y - z.r * .55); ctx.scale(z.px, z.px); if (flip) ctx.scale(-1, 1);
    ctx.font = "600 " + Math.round(Math.max(10, z.screen * .95)) + "px system-ui, sans-serif"; ctx.textAlign = "left"; ctx.textBaseline = "middle";
    const t = String(Math.min(99, n));
    ctx.lineJoin = "round"; ctx.lineWidth = 3; ctx.strokeStyle = c.halo; ctx.strokeText(t, 0, 0); ctx.fillStyle = c.ink; ctx.fillText(t, 0, 0);
    ctx.restore();
  }

  // ---------------------------------------------------------------- the other document's badge
  // A problem that lives on the other document (a board problem on a sheet net, a sheet problem on a
  // footprint): its severity glyph drawn hollow on a second outline offset behind it (a stack of
  // cards: it stands for problems kept elsewhere), and the count beside it when there is more than one.
  // The status line says where they are. Placed up and right of its anchor, clear of a full-size
  // marker there (a part's own problems sit at the same corner).
  function badgeAt(at, scale, kind) {
    const z = size(scale, kind, "badge"), d = 1.3 * size(scale, kind).r + 2 * z.px;
    return {x: at[0] + d, y: at[1] - d, z};
  }
  // badge(ctx, a, at, {severity, count}, kind, {ink, halo, fill}): a = the overlay's {scale, worldToScreen}.
  function badge(ctx, a, at, b, kind, c) {
    const {x, y, z} = badgeAt(at, a.scale, kind), r = z.r, px = z.px, w = z.w, warn = b.severity === "warning", o = 2.5 * px * w;
    ctx.save(); ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
    const outline = (x, y) => {
      ctx.beginPath();
      if (warn) { ctx.moveTo(x, y - r * 1.1); ctx.lineTo(x + r * 1.05, y + r * .75); ctx.lineTo(x - r * 1.05, y + r * .75); ctx.closePath(); }
      else ctx.arc(x, y, r, 0, Math.PI * 2);
    };
    // The card behind, then the glyph: each with its halo, fill and rim.
    for (const [gx, gy, alpha] of [[x + o, y - o, .55], [x, y, 1]]) {
      ctx.globalAlpha = 1; ctx.strokeStyle = c.halo; ctx.lineWidth = STROKE.halo * px * w; outline(gx, gy); ctx.stroke();
      ctx.fillStyle = c.fill; ctx.fill();
      ctx.globalAlpha = alpha; ctx.strokeStyle = c.ink; ctx.lineWidth = STROKE.line * px * w; ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Inside: the severity's own mark (a cross for an error, a bar and dot for a warning).
    ctx.lineWidth = STROKE.line * px * w; ctx.beginPath();
    if (warn) { ctx.moveTo(x, y - r * .35); ctx.lineTo(x, y + r * .15); ctx.stroke(); ctx.fillStyle = c.ink; ctx.beginPath(); ctx.arc(x, y + r * .42, Math.max(r * .09, .8 * px), 0, Math.PI * 2); ctx.fill(); }
    else { const q = r * .42; ctx.moveTo(x - q, y - q); ctx.lineTo(x + q, y + q); ctx.moveTo(x + q, y - q); ctx.lineTo(x - q, y + q); ctx.stroke(); }
    ctx.restore();
    count(ctx, a, x + o, y, z, b.count, c);
  }
  function paintBadges(ctx, frame, list, kind, palette) {
    for (const b of list) {
      const ink = b.severity === "warning" ? palette.warning : palette.error;
      badge(ctx, frame, b.at, b, kind, {ink, halo:palette.halo, fill:palette.halo});
    }
  }
  // The badge under a screen point of a pane, or null: list = {at}[], kind = the document's kind.
  function badgeUnder(pane, list, kind, sx, sy) {
    const scale = scaleOf(pane.view);
    let best = null, bd = Infinity;
    for (const g of list) {
      const {x, y, z} = badgeAt(g.at, scale, kind), s = pane.view.worldToScreen([x, y]), d = Math.hypot(s[0] - sx, s[1] - sy);
      if (d < hit(z.screen) && d < bd) { bd = d; best = g; }
    }
    return best;
  }
  // One status slot for ERC and DRC. Empty text clears the line only while that source owns it.
  let hoverLine = null, hoverOwner = null;
  function hoverStatus(source, text) {
    if (typeof document === "undefined") return;
    const message = text || "";
    if (!message && hoverOwner !== source) return;
    const bar = document.querySelector(".statusbar");
    if (message && !hoverLine?.isConnected) {
      const status = document.getElementById("status");
      if (!status) return;
      hoverLine = document.querySelector(".status-drc-hover") || globalThis.AtriumNavCommon.el("span", null, "status-drc-hover");
      if (!hoverLine.isConnected) status.before(hoverLine);
    }
    if (!hoverLine) return;
    hoverOwner = message ? source : null;
    hoverLine.textContent = message; hoverLine.hidden = !message;
    bar?.classList.toggle("drc-hovering", !!message);
  }
  function badgeDetail(at, scale, kind) {
    const p = badgeAt(at, scale, kind);
    return {at: [p.x, p.y], radius: hit(p.z.screen)};
  }
  return Object.freeze({STROKE, size, hit, scaleOf, cluster, cells, pcbCell, visibleWinner, groupPanDamage, register, paneFrame, pick, count,
    mirrored, badge, paintBadges, badgeAt, badgeUnder, badgeDetail, hoverStatus, BOARD, MIN, MAX});
})();
