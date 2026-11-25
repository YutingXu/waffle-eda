"use strict";
// AtriumCommitGraph (proposed component, 2026-11-23; docs/ui-library.md › Commit graph). Lanes for a
// topologically ordered history, painted on one canvas beside a virtual list: only the rows in view are
// drawn, so the cost does not grow with the length of the history. Lazy; History (history-view.js) and
// the gallery load it.
//
//   lanes(commits) -> rows   commits newest first, each {revision, parents[], pseudo?}. Each row:
//                            {lane, before[], after[], joins[], to[], dashBefore[], dash}: the lanes open
//                            above and below the node, the lanes that end in it, the lanes its parents
//                            continue in, and which of them are dashed (work that is not committed yet).
//   width(rows, max)         the column width in CSS pixels for the widest row (max lanes, default 10)
//   paint(canvas, o)         o: {rows, first, last, top, rowHeight, width, height, max, nodes(i) -> {kind, solid,
//                            current}} where top is the y of row `first` in canvas pixels. kind "commit",
//                            "merge", "working" (ring), "step" (small dot) or "none".
//   palette(node)            lane colours read from the theme tokens, once per theme change.
//
// Colours: lane 0 (the current line of work) is --accent; other lanes cycle through the identity hues the
// avatars use (success, insight, info) and --muted. A lane is a branch identity, not a status, so the
// warning and danger tones are never used for lanes.
globalThis.AtriumCommitGraph = (() => {
  const LANE = 12;
  function lanes(commits) {
    let open = [], dash = [];
    const rows = [];
    const take = () => { let k = open.indexOf(null); if (k < 0) { k = open.length; open.push(null); dash.push(false); } return k; };
    for (const c of commits) {
      let i = open.indexOf(c.revision);
      if (i < 0) i = take();
      const before = open.slice(), dashBefore = dash.slice(), joins = [];
      for (let j = 0; j < open.length; j++) if (j !== i && open[j] === c.revision) { joins.push(j); open[j] = null; dash[j] = false; }
      const parents = c.parents || [];
      open[i] = parents[0] ?? null; dash[i] = !!c.pseudo && open[i] != null;
      const to = parents.length ? [i] : [];
      for (const p of parents.slice(1)) {
        let k = open.indexOf(p);
        if (k < 0) { k = take(); open[k] = p; dash[k] = !!c.pseudo; }
        to.push(k);
      }
      while (open.length && open[open.length - 1] === null) { open.pop(); dash.pop(); }
      rows.push({lane: i, before, after: open.slice(), joins, to, dashBefore, dash: !!c.pseudo});
    }
    return rows;
  }
  function width(rows, max = 10) {
    let n = 1;
    for (const r of rows) n = Math.max(n, r.before.length, r.after.length, r.lane + 1);
    return Math.min(n, max) * LANE + LANE / 2;
  }
  const TOKENS = ["--accent", "--success", "--insight", "--info", "--muted"];
  let cache = null;
  function palette(node) {
    const theme = document.documentElement.dataset.theme || "";
    if (cache?.theme === theme) return cache;
    const style = getComputedStyle(node || document.documentElement);
    const read = t => style.getPropertyValue(t).trim() || "#888";
    cache = {theme, lanes: TOKENS.map(read), surface: read("--surface"), muted: read("--muted"), ink: read("--ink"),
      selection: read("--selection")};
    return cache;
  }
  function reset() { cache = null; }
  function paint(canvas, o) {
    const ratio = Math.min(3, Math.max(1, globalThis.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(o.width)), h = Math.max(1, Math.round(o.height));
    if (canvas.width !== w * ratio || canvas.height !== h * ratio) {
      canvas.width = w * ratio; canvas.height = h * ratio;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
    }
    const ctx = canvas.getContext("2d"), colours = palette(canvas), max = o.max || 10, rh = o.rowHeight;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.lineWidth = 1.5; ctx.lineCap = "round";
    const x = i => Math.min(i, max - 1) * LANE + LANE / 2 + 2;
    const colour = i => colours.lanes[i % colours.lanes.length];
    function edge(x1, y1, x2, y2, lane, dashed) {
      ctx.strokeStyle = colour(lane);
      ctx.setLineDash(dashed ? [2, 3] : []);
      ctx.beginPath(); ctx.moveTo(x1, y1);
      if (x1 === x2) ctx.lineTo(x2, y2);
      else ctx.bezierCurveTo(x1, (y1 + y2) / 2, x2, (y1 + y2) / 2, x2, y2);
      ctx.stroke();
    }
    const nodes = [];
    for (let i = o.first; i < o.last; i++) {
      const r = o.rows[i];
      if (!r) continue;
      const y0 = o.top + (i - o.first) * rh, mid = y0 + rh / 2;
      r.before.forEach((rev, j) => {
        if (rev == null) return;
        if (j === r.lane || r.joins.includes(j)) edge(x(j), y0, x(r.lane), mid, j, r.dashBefore[j]);
        else if (r.after[j] != null) edge(x(j), y0, x(j), y0 + rh, j, r.dashBefore[j]);
      });
      for (const k of r.to) edge(x(r.lane), mid, x(k), y0 + rh, k, r.dash);
      nodes.push([i, x(r.lane), mid, r.lane]);
    }
    ctx.setLineDash([]);
    // Nodes last, so every edge passes under them.
    for (const [i, cx, cy, lane] of nodes) {
      const n = o.nodes?.(i) || {kind: "commit", solid: true};
      if (n.kind === "none") continue;
      const tint = n.kind === "working" || n.kind === "step" ? colours.lanes[0] : colour(lane);
      const radius = n.kind === "merge" ? 4.5 : n.kind === "step" ? 2.5 : n.kind === "working" ? 4 : 3.5;
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.lineWidth = n.kind === "merge" || n.kind === "working" ? 1.5 : 1.5;
      if (n.solid && n.kind !== "working" && n.kind !== "merge") { ctx.fillStyle = tint; ctx.fill(); ctx.strokeStyle = colours.surface; ctx.stroke(); }
      else { ctx.fillStyle = colours.surface; ctx.fill(); ctx.strokeStyle = tint; ctx.stroke(); }
      if (n.current) { ctx.beginPath(); ctx.arc(cx, cy, radius + 2.5, 0, Math.PI * 2); ctx.strokeStyle = tint; ctx.lineWidth = 1; ctx.stroke(); }
    }
  }
  // Proposed icon-bank symbols (docs/ui-library.md › Commit graph): History, a Git branch and More (⋯).
  // Added to the page's icon bank on first use until they are approved for index.html.
  const ICONS = {
    history: '<path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/><path d="M12 8v4l3 2"/>',
    branch: '<circle cx="7" cy="6" r="2"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="8" r="2"/><path d="M7 8v8M17 10c0 4-6 3-9.2 6.4"/>',
    more: '<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></g>'
  };
  function icons() {
    const bank = document.querySelector("svg symbol[id^=i-]")?.parentElement;
    if (!bank) return;
    for (const [name, body] of Object.entries(ICONS)) {
      if (document.getElementById("i-" + name)) continue;
      const s = document.createElementNS("http://www.w3.org/2000/svg", "symbol");
      s.id = "i-" + name; s.setAttribute("viewBox", "0 0 24 24"); s.dataset.proposed = "";
      s.innerHTML = body; bank.append(s);
    }
  }
  return Object.freeze({LANE, lanes, width, paint, palette, reset, icons});
})();
