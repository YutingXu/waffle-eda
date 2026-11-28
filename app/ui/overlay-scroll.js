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
  // scroller -> {v, h, timer, hot, ref}. A scroller is held only weakly: a closed dialog or panel must not
  // stay in memory, with its whole subtree, because the pointer once crossed it. tracked lists the
  // scrollers for the sweeps below. A scroller that leaves the document (a menu closed with Escape, a
  // dialog closed mid-drag) takes its thumbs and its drag with it at once: the owner layer watches each
  // thumb's scroller (ui/owner-layer.js), since its next pointer move may never come.
  const bars = new WeakMap(), tracked = new Set();
  const weak = el => typeof WeakRef === "function" ? new WeakRef(el) : {deref:() => el};
  function scrollers() {
    const live = [];
    for (const ref of tracked) {
      const el = ref.deref();
      if (!el) tracked.delete(ref);
      else if (!el.isConnected) drop(el);
      else live.push([el, bars.get(el)]);
    }
    return live;
  }
  let frame = 0, drag = null;
  const pending = new Set();

  const rootScroller = () => doc.scrollingElement || doc.documentElement;
  function overflows(el, axis) {
    if (axis === "v" ? el.scrollHeight - el.clientHeight < 1 : el.scrollWidth - el.clientWidth < 1) return false;
    if (el === rootScroller()) return true;
    const o = getComputedStyle(el)[axis === "v" ? "overflowY" : "overflowX"];
    return o === "auto" || o === "scroll";
  }
  // The thumb joins its scroller's own layer (ui/owner-layer.js): the nearest ancestor that stacks, in
  // the scroller's dialog, popover or app bar, else the body; a scrolling dialog or popover hosts its own
  // thumb. Whatever draws over the scroller (a menu, a floating panel) then also covers the thumb.
  const L = () => globalThis.AtriumLayer;
  // In that layer the thumb only has to clear what its scroller draws at that edge: its sticky headers
  // and pinned columns. It takes one more than the highest of their z-indexes, so everything else in the
  // layer at a higher z-index still covers it. A scroller that is itself a layer shares its z-index, and
  // the thumb, appended after it, paints over it. Sticky rows sit near the top: the scan is capped, and
  // runs on each full placement (shown, hovered, resized), never per scroll.
  const SCAN = 600;
  function stickyTop(el) {
    let z = 0, n = 0;
    const walk = doc.createTreeWalker(el, 1);
    for (let e = walk.nextNode(); e && n < SCAN; e = walk.nextNode(), n++) {
      const cs = getComputedStyle(e);
      if (cs.position === "sticky") z = Math.max(z, parseInt(cs.zIndex, 10) || 0);
    }
    return z;
  }
  function layerOf(el, host) {
    if (el !== host && el !== rootScroller() && L().stacks(el)) return String(parseInt(getComputedStyle(el).zIndex, 10) || 0);
    return String(stickyTop(el) + 1);
  }
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
    if (!b) {b = {v:null, h:null, timer:0, hot:false, ref:weak(el)}; bars.set(el, b); tracked.add(b.ref);}
    return b;
  }
  // A full placement measures the scroller once (rects, sizes) and parks each thumb at the start of its
  // track. A scroll then only moves the thumb with a transform from scrollTop/scrollLeft, which reads no
  // rects and writes nothing that needs layout, so scrolling a long list stays layout-free.
  function place(el, b, show = true) {
    if (!el.isConnected) {drop(el); return;}
    const host = L().layer(el, {own:true}), r = el === rootScroller() ? {left:0, top:0, right:innerWidth, bottom:innerHeight, width:innerWidth, height:innerHeight} : el.getBoundingClientRect();
    const o = L().origin(host), ox = -o.x, oy = -o.y;
    // A follow placement (the layer moved under a fixed thumb) reuses the z-index found last time.
    let z = show || b.z == null ? null : b.z;
    b.geo = {};
    for (const axis of ["v", "h"]) {
      if (axis === "h" && el.matches?.(SKIP)) continue;
      const show = overflows(el, axis);
      let t = b[axis];
      if (!show) {t?.remove(); b[axis] = null; continue;}
      if (!t || t.parentElement !== host) {t?.remove(); t = b[axis] = thumb(el, axis); host.append(t); L().watch(t, el, () => drop(el));}
      t.style.position = o.position;
      t.style.zIndex = b.z = z ??= layerOf(el, host);
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
    move(el, b, show);
  }
  function move(el, b, show = true) {
    for (const axis of ["v", "h"]) {
      const t = b[axis], g = b.geo?.[axis];
      if (!t || !g) continue;
      const at = Math.round(g.free * (axis === "v" ? el.scrollTop : el.scrollLeft) / g.range);
      t.style.transform = axis === "v" ? `translateY(${at}px)` : `translateX(${at}px)`;
      if (show) t.toggleAttribute("data-shown", true);
    }
    if (!show) return;
    clearTimeout(b.timer);
    if (!b.hot && !drag) b.timer = setTimeout(() => fade(el), HIDE_MS);
  }
  function fade(el) {
    const b = bars.get(el); if (!b) return;
    if (!el.isConnected) {drop(el); return;}
    if (b.hot || drag) return;
    for (const axis of ["v", "h"]) b[axis]?.removeAttribute("data-shown");
  }
  function drop(el) {
    if (drag?.el === el) drag.end();
    const b = bars.get(el); if (!b) return;
    clearTimeout(b.timer); b.v?.remove(); b.h?.remove(); bars.delete(el); tracked.delete(b.ref);
  }
  // full: measure again (shown, resized, hot or dragged); otherwise only the scroll position moved.
  const measure = new Set(), quiet = new Set();
  // follow: re-place without showing (its layer moved under it, the scroller itself did not scroll).
  function schedule(el, full = true, follow = false) {
    if (follow) {if (!pending.has(el)) quiet.add(el);} else quiet.delete(el);
    pending.add(el);
    const b = bars.get(el);
    if (full || !b?.geo || stale(b)) measure.add(el);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      for (const p of pending) {const b = entry(p); if (measure.has(p)) place(p, b, !quiet.has(p)); else if (p.isConnected) move(p, b); else drop(p);}
      pending.clear(); measure.clear(); quiet.clear();
    });
  }
  function scrolled(e) {
    const el = e.target === doc ? rootScroller() : e.target;
    if (el?.nodeType !== 1 || el.matches?.(SKIP) && !overflows(el, "v")) return;
    schedule(el, false);
    // Scrollers inside it moved: a shown thumb follows with a full placement (without showing it again);
    // a hidden one forgets its geometry, so it is measured afresh when it next shows.
    for (const [inner, b] of scrollers()) {
      if (inner === el || !el.contains(inner)) continue;
      if ([b.v, b.h].some(t => t?.hasAttribute("data-shown"))) schedule(inner, true, true); else b.geo = null;
    }
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
    for (const [s, b] of scrollers()) if (b.hot && s !== el) {b.hot = false; place(s, b);}
    if (!el) return;
    const r = el.getBoundingClientRect(), near = r.right - e.clientX <= EDGE && e.clientX <= r.right;
    // Only a scroller whose edge the pointer reaches gets an entry; passing over one leaves no trace.
    if (near !== !!bars.get(el)?.hot) {entry(el).hot = near; schedule(el);}
  }
  function startDrag(e, el, axis, t) {
    if (e.button !== 0) return;
    e.preventDefault(); e.stopPropagation();
    const r = el.getBoundingClientRect(), v = axis === "v";
    const track = (v ? r.height : r.width) - 2 * INSET, size = v ? t.offsetHeight : t.offsetWidth;
    const range = v ? el.scrollHeight - el.clientHeight : el.scrollWidth - el.clientWidth;
    drag?.end();
    const id = e.pointerId, from = v ? e.clientY : e.clientX, start = v ? el.scrollTop : el.scrollLeft, ratio = range / Math.max(1, track - size);
    const move = ev => { if (ev.pointerId === id) el[v ? "scrollTop" : "scrollLeft"] = start + ((v ? ev.clientY : ev.clientX) - from) * ratio; };
    // The drag ends however its capture ends: a release, a cancel or the capture lost. A thumb removed
    // mid-drag (Escape closed its dialog) gets none of them: Chromium sends the loss to the document and
    // the release to whatever is under the pointer. So the document listens, and drop() ends it at once.
    const ends = ["pointerup", "pointercancel", "lostpointercapture"];
    const stop = ev => { if (ev.pointerId === id) end(); };
    const end = () => {
      if (drag !== state) return;
      t.removeEventListener("pointermove", move); for (const type of ends) doc.removeEventListener(type, stop, true);
      drag = null;
      if (el.isConnected) schedule(el);
    };
    const state = drag = {el, thumb:t, end};
    t.addEventListener("pointermove", move); for (const type of ends) doc.addEventListener(type, stop, true);
    t.setPointerCapture?.(id);
    schedule(el);
  }
  doc.addEventListener("scroll", scrolled, {capture:true, passive:true});
  doc.addEventListener("pointermove", moved, {capture:true, passive:true});
  // A scroller that leaves (a closed panel or dialog) takes its thumbs with it.
  globalThis.addEventListener("resize", () => {for (const [el] of scrollers()) schedule(el);});
  return Object.freeze({show:el => schedule(el), thumbs:() => scrollers().flatMap(([, b]) => [b.v, b.h].filter(Boolean))});
})();
