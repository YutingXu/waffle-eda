"use strict";

// Overlay scrollbars, as on the Mac with "Show scroll bars: When scrolling". No native scrollbar takes
// layout space (ui/components.css hides them), so content never changes width when it starts to scroll.
// This module draws one thin thumb over the edge of whatever scrolls: while it scrolls, and while a mouse
// or pen nears that edge, when the thumb widens and can be dragged. It fades out after a pause.
// Loaded at idle and on the first scroll (lazy.js); nothing here runs until something scrolls.
globalThis.AtriumOverlayScroll = (() => {
  const doc = globalThis.document;
  if (!doc) return Object.freeze({});
  const HIDE_MS = 900, EDGE = 14, MIN = 24, INSET = 2;
  // Strips that scroll sideways without a bar: tab strips, the toolbars and the Messages header.
  const SKIP = ".ui-tabs,#document-tabs,.pane-tabs,.active-bar,.layer-tabs,.msg-head,.dock-tabs,.ui-select-list";
  const bars = new Map(); // scroller -> {v, h, timer, hot}
  let frame = 0, drag = null;
  const pending = new Set();

  const rootScroller = () => doc.scrollingElement || doc.documentElement;
  function overflows(el, axis) {
    if (axis === "v" ? el.scrollHeight - el.clientHeight < 1 : el.scrollWidth - el.clientWidth < 1) return false;
    if (el === rootScroller()) return true;
    const o = getComputedStyle(el)[axis === "v" ? "overflowY" : "overflowX"];
    return o === "auto" || o === "scroll";
  }
  // The thumb lives where the scroller is drawn: in the open modal dialog or popover (the top layer),
  // in the app bar (a title-bar row: its menus may draw in the caption band), else in the body. Inside
  // that, it joins the scroller's own layer, the nearest ancestor with a z-index (a floating dock, a
  // popover card), so whatever draws over the scroller also covers its thumb.
  const stacks = n => {const cs = getComputedStyle(n); return cs.position !== "static" && cs.zIndex !== "auto";};
  function hostOf(el) {
    const top = el.closest?.("dialog[open], :popover-open, .appbar") || doc.body;
    for (let n = el.parentElement; n && n !== top; n = n.parentElement) if (stacks(n)) return n;
    return top;
  }
  // Above sticky headers in its layer; a scroller that is itself a layer (a fixed card) shares its z-index,
  // and the thumb, appended after it, paints over it.
  const layerOf = el => el !== rootScroller() && stacks(el) ? getComputedStyle(el).zIndex : "2";
  const stale = b => [b.v, b.h].some(t => t && !t.isConnected);
  function thumb(el, axis) {
    const t = doc.createElement("div");
    t.className = "ui-scroll-thumb";
    t.dataset.axis = axis;
    t.setAttribute("aria-hidden", "true");
    t.addEventListener("pointerdown", e => startDrag(e, el, axis, t));
    return t;
  }
  function entry(el) {
    let b = bars.get(el);
    if (!b) {b = {v:null, h:null, timer:0, hot:false}; bars.set(el, b);}
    return b;
  }
  // A full placement measures the scroller once (rects, sizes) and parks each thumb at the start of its
  // track. A scroll then only moves the thumb with a transform from scrollTop/scrollLeft, which reads no
  // rects and writes nothing that needs layout, so scrolling a long list stays layout-free.
  function place(el, b) {
    if (!el.isConnected) {drop(el); return;}
    const host = hostOf(el), fixed = host === doc.body, r = el === rootScroller() ? {left:0, top:0, right:innerWidth, bottom:innerHeight, width:innerWidth, height:innerHeight} : el.getBoundingClientRect();
    const hr = fixed ? {left:0, top:0} : host.getBoundingClientRect();
    const ox = fixed ? 0 : -hr.left - host.clientLeft + host.scrollLeft, oy = fixed ? 0 : -hr.top - host.clientTop + host.scrollTop;
    b.geo = {};
    for (const axis of ["v", "h"]) {
      if (axis === "h" && el.matches?.(SKIP)) continue;
      const show = overflows(el, axis);
      let t = b[axis];
      if (!show) {t?.remove(); b[axis] = null; continue;}
      if (!t || t.parentElement !== host) {t?.remove(); t = b[axis] = thumb(el, axis); host.append(t);}
      t.style.position = fixed ? "fixed" : "absolute";
      t.style.zIndex = layerOf(el);
      if (axis === "v") {
        const track = r.height - 2 * INSET, size = Math.max(MIN, track * el.clientHeight / el.scrollHeight);
        b.geo.v = {free:track - size, range:Math.max(1, el.scrollHeight - el.clientHeight)};
        t.style.left = Math.round(r.right + ox - INSET) + "px"; t.style.top = Math.round(r.top + oy + INSET) + "px";
        t.style.height = Math.round(size) + "px"; t.style.width = "";
      } else {
        const track = r.width - 2 * INSET, size = Math.max(MIN, track * el.clientWidth / el.scrollWidth);
        b.geo.h = {free:track - size, range:Math.max(1, el.scrollWidth - el.clientWidth)};
        t.style.top = Math.round(r.bottom + oy - INSET) + "px"; t.style.left = Math.round(r.left + ox + INSET) + "px";
        t.style.width = Math.round(size) + "px"; t.style.height = "";
      }
      t.toggleAttribute("data-hot", b.hot || drag?.thumb === t);
    }
    move(el, b);
  }
  function move(el, b) {
    for (const axis of ["v", "h"]) {
      const t = b[axis], g = b.geo?.[axis];
      if (!t || !g) continue;
      const at = Math.round(g.free * (axis === "v" ? el.scrollTop : el.scrollLeft) / g.range);
      t.style.transform = axis === "v" ? `translateY(${at}px)` : `translateX(${at}px)`;
      t.toggleAttribute("data-shown", true);
    }
    clearTimeout(b.timer);
    if (!b.hot && !drag) b.timer = setTimeout(() => fade(el), HIDE_MS);
  }
  function fade(el) {
    const b = bars.get(el); if (!b || b.hot || drag) return;
    for (const axis of ["v", "h"]) b[axis]?.removeAttribute("data-shown");
  }
  function drop(el) {
    const b = bars.get(el); if (!b) return;
    clearTimeout(b.timer); b.v?.remove(); b.h?.remove(); bars.delete(el);
  }
  // full: measure again (shown, resized, hot or dragged); otherwise only the scroll position moved.
  const measure = new Set();
  function schedule(el, full = true) {
    pending.add(el);
    const b = bars.get(el);
    if (full || !b?.geo || stale(b)) measure.add(el);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const p of pending) {const b = entry(p); if (measure.has(p)) place(p, b); else if (p.isConnected) move(p, b); else drop(p);}
      pending.clear(); measure.clear();
    });
  }
  function scrolled(e) {
    const el = e.target === doc ? rootScroller() : e.target;
    if (el?.nodeType !== 1 || el.matches?.(SKIP) && !overflows(el, "v")) return;
    schedule(el, false);
  }
  // A mouse or pen near a scroller's edge shows its thumb, wide enough to grab.
  function scrollerAt(node) {
    for (let n = node; n && n.nodeType === 1; n = n.parentElement) if (overflows(n, "v") && !n.classList.contains("ui-scroll-thumb")) return n;
    return null;
  }
  function moved(e) {
    if (e.pointerType === "touch" || drag) return;
    if (e.target.classList?.contains("ui-scroll-thumb")) return;
    const el = scrollerAt(e.target);
    for (const [s, b] of bars) if (b.hot && s !== el) {b.hot = false; place(s, b);}
    if (!el) return;
    const r = el.getBoundingClientRect(), near = r.right - e.clientX <= EDGE && e.clientX <= r.right;
    const b = entry(el);
    if (near !== b.hot) {b.hot = near; schedule(el);}
  }
  function startDrag(e, el, axis, t) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect(), v = axis === "v";
    const track = (v ? r.height : r.width) - 2 * INSET, size = v ? t.offsetHeight : t.offsetWidth;
    const range = v ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    drag = {el, axis, thumb:t, from:v ? e.clientY : e.clientX, start:v ? el.scrollTop : el.scrollLeft, ratio:range / Math.max(1, track - size)};
    t.setPointerCapture?.(e.pointerId);
    const move = ev => {
      const d = (v ? ev.clientY : ev.clientX) - drag.from;
      el[v ? "scrollTop" : "scrollLeft"] = drag.start + d * drag.ratio;
    };
    const end = () => {
      t.removeEventListener("pointermove", move); t.removeEventListener("pointerup", end); t.removeEventListener("pointercancel", end);
      drag = null; schedule(el);
    };
    t.addEventListener("pointermove", move); t.addEventListener("pointerup", end); t.addEventListener("pointercancel", end);
    schedule(el);
  }
  doc.addEventListener("scroll", scrolled, {capture:true, passive:true});
  doc.addEventListener("pointermove", moved, {capture:true, passive:true});
  // A scroller that leaves (a closed panel or dialog) takes its thumbs with it.
  globalThis.addEventListener("resize", () => {for (const el of bars.keys()) schedule(el);});
  return Object.freeze({show:el => schedule(el), thumbs:() => [...bars.values()].flatMap(b => [b.v, b.h].filter(Boolean))});
})();
