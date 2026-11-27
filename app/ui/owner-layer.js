"use strict";

// Owner layers: where a decoration that belongs to one element is drawn (a scroll thumb, a completion
// ghost over a field, a hint, readout or flash over a canvas). The page is a stack of layers: the
// workbench is one (isolated), and above it in fixed order come the app bar, floating panels and context
// menus (--z-float), toasts, popovers, alerts, then the top layer (modal dialogs and open popovers). A
// decoration joins its owner's own layer, never the body at a high z-index, so whatever is drawn over
// its owner (a menu, a floating panel, a dialog) also covers the decoration, and its z-index only orders
// it among its owner's neighbours. docs/design-system.md › Layers.
globalThis.AtriumLayer = (() => {
  const doc = globalThis.document;
  if (!doc) return Object.freeze({});
  const TOP = "dialog[open], :popover-open, .appbar";
  const css = n => getComputedStyle(n);
  // Does n start a stacking context of its own (the properties that do, as far as the app uses them)?
  function stacks(n) {
    const cs = css(n);
    if (cs.position === "fixed" || cs.position === "sticky") return true;
    if (cs.zIndex !== "auto") {
      if (cs.position !== "static") return true;
      const p = n.parentElement && css(n.parentElement).display;
      if (/flex|grid/.test(p || "")) return true;
    }
    return cs.isolation === "isolate" || +cs.opacity < 1 || cs.transform !== "none" || cs.translate !== "none" ||
      cs.scale !== "none" || cs.rotate !== "none" || cs.filter !== "none" || (cs.backdropFilter || "none") !== "none" ||
      cs.mixBlendMode !== "normal" || /paint|layout|strict|content/.test(cs.contain || "") ||
      /transform|opacity|filter|translate|scale|rotate/.test(cs.willChange || "");
  }
  // The layer a decoration of `owner` belongs to: the nearest ancestor that stacks, inside the owner's
  // dialog, popover or app bar (or the body). With own, an owner that is itself that dialog or popover
  // hosts its decorations (a scrolling popover's thumb stays in the top layer with it).
  function layer(owner, {own = false} = {}) {
    const top = owner.closest?.(TOP) || doc.body;
    if (top === owner) return own ? owner : owner.parentElement?.closest?.(TOP) || doc.body;
    for (let n = owner.parentElement; n && n !== top; n = n.parentElement) if (stacks(n)) return n;
    return top;
  }
  function attach(node, owner, options) {
    const host = layer(owner, options);
    if (node.parentElement !== host) host.append(node);
    return host;
  }
  // A fixed-position node is placed in viewport coordinates unless an ancestor (a transform, a filter,
  // containment) becomes its containing block; then its coordinates start at that block's padding box.
  function containing(n) {
    for (; n && n.nodeType === 1 && n !== doc.documentElement; n = n.parentElement) {
      const cs = css(n);
      if (cs.transform !== "none" || cs.translate !== "none" || cs.scale !== "none" || cs.rotate !== "none" ||
        cs.perspective !== "none" || cs.filter !== "none" || (cs.backdropFilter || "none") !== "none" ||
        /paint|layout|strict|content/.test(cs.contain || "") || /transform|filter|perspective/.test(cs.willChange || "")) return n;
    }
    return null;
  }
  // How a node in host is positioned. A positioned host that does not scroll (a floating panel, a card,
  // a dialog) holds it absolutely, so it moves with the host; otherwise it is fixed, in viewport coordinates unless an
  // ancestor (a transform, a filter, containment) becomes its containing block. x, y is the viewport
  // point that left:0; top:0 lands on.
  function origin(host) {
    const hs = host && host !== doc.body ? css(host) : null;
    if (hs && hs.position !== "static" && !/auto|scroll/.test(hs.overflowX + hs.overflowY)) {
      const r = host.getBoundingClientRect();
      return {position:"absolute", x:r.left + host.clientLeft - host.scrollLeft, y:r.top + host.clientTop - host.scrollTop};
    }
    const cb = host && containing(host);
    if (!cb) return {position:"fixed", x:0, y:0};
    const r = cb.getBoundingClientRect();
    return {position:"fixed", x:r.left + cb.clientLeft - cb.scrollLeft, y:r.top + cb.clientTop - cb.scrollTop};
  }
  // Put a node (already attached) at viewport point x, y.
  function at(node, x, y) {
    const o = origin(node.parentElement || doc.body);
    node.style.position = o.position;
    node.style.left = x - o.x + "px"; node.style.top = y - o.y + "px";
  }
  // The part of owner that can be seen: its box cut by every ancestor that clips (scrollers, panes) and
  // the viewport. Null when none of it is shown (hidden, detached or scrolled away).
  function visible(owner) {
    if (!owner?.isConnected || !owner.getClientRects().length) return null;
    const b = owner.getBoundingClientRect();
    let l = b.left, t = b.top, r = b.right, btm = b.bottom;
    for (let n = owner.parentElement; n && n !== doc.documentElement; n = n.parentElement) {
      const cs = css(n);
      if (cs.overflowX === "visible" && cs.overflowY === "visible") continue;
      const c = n.getBoundingClientRect();
      if (cs.overflowX !== "visible") {l = Math.max(l, c.left + n.clientLeft); r = Math.min(r, c.left + n.clientLeft + n.clientWidth);}
      if (cs.overflowY !== "visible") {t = Math.max(t, c.top + n.clientTop); btm = Math.min(btm, c.top + n.clientTop + n.clientHeight);}
      if (cs.position === "fixed") break;
    }
    l = Math.max(l, 0); t = Math.max(t, 0); r = Math.min(r, innerWidth); btm = Math.min(btm, innerHeight);
    return r > l && btm > t ? {left:l, top:t, right:r, bottom:btm, width:r - l, height:btm - t} : null;
  }
  // Clip a placed node to its owner's visible part (clip-path in the node's own box); false when the
  // owner cannot be seen, and the node is then hidden.
  function clip(node, owner) {
    const v = visible(owner);
    node.style.visibility = v ? "" : "hidden";
    if (!v) {node.style.clipPath = ""; return false;}
    const b = node.getBoundingClientRect();
    const i = [v.top - b.top, b.right - v.right, b.bottom - v.bottom, v.left - b.left].map(n => Math.max(0, n));
    node.style.clipPath = i.some(n => n > 0) ? `inset(${i.map(n => n + "px").join(" ")})` : "";
    return true;
  }
  return Object.freeze({stacks, layer, attach, origin, at, visible, clip});
})();
