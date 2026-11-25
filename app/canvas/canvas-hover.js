"use strict";
// Passive canvas cards share one deadline clock, one visible owner and one fit
// decision. Presenters provide their own hit tests, interaction rules, side
// priority, obstacles and existing card faces.
globalThis.AtriumCanvasHover = (() => {
  const G = globalThis, doc = G.document;
  const adapters = new Map(), requests = new Map();
  const priority = ["problem", "insight", "connection", "object"];
  let host, active, leaving, timer, due = Infinity;
  const camera = view => {
    const c = view.camera();
    return [c.cx, c.cy, c.scale, c.rotation || 0, !!c.flipped].join();
  };
  function locate(canvas) {
    const pane = canvas?.isConnected && host?.panes().find(p => p.canvas === canvas);
    const design = pane?.view && host.docById(pane.docId);
    return design && {canvas, view: pane.view, design, camera: camera(pane.view)};
  }
  function valid(scope, touch = false) {
    const at = locate(scope.canvas);
    return at?.view === scope.view && at.design === scope.design && at.camera === scope.camera &&
      (touch || host.allowsHover(scope.canvas) && !host.liveRoute?.());
  }
  function arm() {
    let next = leaving?.at ?? Infinity;
    for (const row of requests.values()) next = Math.min(next, row.at);
    if (next === due) return;
    clearTimeout(timer);
    due = next;
    if (Number.isFinite(next)) timer = setTimeout(run, Math.max(0, next - performance.now()));
  }
  function run() {
    due = Infinity;
    const now = performance.now();
    if (leaving && leaving.at <= now) {
      const job = leaving;
      leaving = null;
      if (active === job.owner) job.run();
    }
    for (const [kind, job] of requests) {
      if (job.at > now) continue;
      requests.delete(kind);
      if (valid(job.scope, job.touch)) job.run();
    }
    arm();
  }
  function queue(kind, canvas, ms, data, run, {touch = false} = {}) {
    const scope = locate(canvas);
    if (!scope) return;
    requests.set(kind, {scope, data, run, touch, at: performance.now() + ms});
    arm();
  }
  function cancel(kind) { if (requests.delete(kind)) arm(); }
  function stay(kind) {
    if (leaving?.owner.kind !== kind) return;
    leaving = null;
    arm();
  }
  function leave(kind, ms, run, restart = false) {
    if (active?.kind !== kind || leaving && !restart) return;
    leaving = {owner: active, at: performance.now() + ms, run};
    arm();
  }
  function release(kind) {
    if (active?.kind === kind) active = null;
    stay(kind);
  }
  function closeActive(reason) {
    const owner = active;
    if (!owner) return;
    release(owner.kind);
    adapters.get(owner.kind).hide(reason);
  }
  function dismiss(reason) {
    requests.clear();
    closeActive(reason);
    for (const adapter of adapters.values()) adapter.reset?.(reason);
    arm();
  }
  function show(kind, canvas, render, {touch = false} = {}) {
    const scope = locate(canvas);
    if (!scope || !valid(scope, touch)) return false;
    const previous = active;
    if (!touch && [...adapters.values()].some(adapter => adapter.contains?.(doc.activeElement))) return false;
    if (previous && previous.kind !== kind) closeActive();
    const owner = active = {kind, scope, touch};
    stay(kind);
    if (render() !== false && active === owner) return true;
    if (active === owner) release(kind);
    return false;
  }
  function frame() {
    if (active && !valid(active.scope, active.touch)) { dismiss("frame"); return; }
    for (const [kind, job] of requests) {
      if (valid(job.scope, job.touch)) continue;
      requests.delete(kind);
      adapters.get(kind)?.reset?.("frame");
    }
    arm();
  }
  function contains(target) {
    return !!active && !!adapters.get(active.kind).contains?.(target);
  }
  function leaveCanvas(e) {
    if (e.pointerType === "touch" || e.target?.tagName !== "CANVAS") return;
    for (const [kind, job] of requests) {
      if (!job.touch && job.scope.canvas === e.target) requests.delete(kind);
    }
    if (active?.scope.canvas === e.target && !contains(e.relatedTarget)) adapters.get(active.kind).leaveCanvas?.();
    arm();
  }
  function preferred(kind, canvas, x, y, hit) {
    for (const name of priority) {
      if (name === kind) return true;
      if (adapters.get(name)?.over?.(canvas, x, y, hit)) return false;
    }
    return false;
  }
  function limit(n, low, high) {
    return Math.max(low, Math.min(high, n));
  }
  function sideCandidate(edge, width, height, box, side, along, gap) {
    const left = side === "right" ? edge.right + gap : side === "left" ? edge.left - width - gap : limit(along, box.left, box.right - width);
    const top = side === "bottom" ? edge.bottom + gap : side === "top" ? edge.top - height - gap : limit(along, box.top, box.bottom - height);
    return {left, top, right: left + width, bottom: top + height};
  }
  // Clamp the free axis into the fit box, then take the first clear card.
  // The anchor itself stays put, including at an RTL corner.
  function firstFit(anchor, width, height, box, {gap = 0, order, rtl = false, ranks, align, edge, major, clear} = {}) {
    const home = edge || anchor;
    let horizontal, vertical;
    if (align) {
      horizontal = align.horizontal;
      vertical = align.vertical;
    } else {
      const chosen = ranks || ["start", "center", "end"];
      const at = {
        start: [anchor.left, anchor.top],
        center: [(anchor.left + anchor.right - width) / 2, (anchor.top + anchor.bottom - height) / 2],
        end: [anchor.right - width, anchor.bottom - height]
      };
      horizontal = chosen.map(rank => at[rank][0]);
      vertical = chosen.map(rank => at[rank][1]);
      if (rtl) horizontal.reverse();
    }
    const accept = (side, index) => {
      const along = side === "left" || side === "right" ? vertical[index] : horizontal[index];
      const rect = sideCandidate(home, width, height, box, side, along, gap);
      if (rect.left >= box.left && rect.top >= box.top && rect.right <= box.right && rect.bottom <= box.bottom && (!clear || clear(rect)))
        return {left: rect.left, top: rect.top, side};
      return null;
    };
    if (major === "align") {
      const count = Math.max(horizontal.length, vertical.length);
      for (let index = 0; index < count; index += 1) {
        for (const side of order) {
          const hit = accept(side, index);
          if (hit) return hit;
        }
      }
    } else {
      for (const side of order) {
        const n = side === "left" || side === "right" ? vertical.length : horizontal.length;
        for (let index = 0; index < n; index += 1) {
          const hit = accept(side, index);
          if (hit) return hit;
        }
      }
    }
    return null;
  }
  function attach(h) {
    host = h;
    h.on("frame", frame);
    for (const name of ["document", "replace", "panes", "change", "folder-owner"]) h.on(name, () => dismiss(name));
  }
  if (doc?.body) {
    G.AtriumNavCommon?.ready?.(attach);
    const stop = () => dismiss();
    doc.addEventListener("pointerout", leaveCanvas, {capture: true, passive: true});
    doc.addEventListener("pointerdown", e => { if (!contains(e.target)) dismiss(); }, true);
    doc.addEventListener("keydown", e => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      if (active) { e.preventDefault(); e.stopPropagation(); }
      dismiss("escape");
    }, true);
    doc.addEventListener("wheel", e => {
      if (!contains(e.target) || active.kind !== "connection") dismiss();
    }, {capture: true, passive: true});
    doc.addEventListener("scroll", e => { if (!contains(e.target)) dismiss(); }, {capture: true, passive: true});
    doc.addEventListener("pointercancel", stop, true);
    doc.addEventListener("visibilitychange", stop);
    G.addEventListener("blur", stop);
    G.addEventListener("resize", stop, {passive: true});
    G.visualViewport?.addEventListener("resize", stop, {passive: true});
    G.visualViewport?.addEventListener("scroll", stop, {passive: true});
  }
  return Object.freeze({queue, cancel, leave, stay, release, show, preferred, firstFit, dismiss, locate, valid,
    pending: kind => requests.get(kind)?.data,
    register: (kind, adapter) => adapters.set(kind, adapter)});
})();
