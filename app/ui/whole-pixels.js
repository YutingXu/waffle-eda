"use strict";
// AtriumWholePixels: content-sized chrome on whole pixels where CSS calc-size() is missing (WebKit).
//
// style.css, dock.css and nav.css round menu titles, document and dock tabs and context menus up to
// whole pixels with inline-size:calc-size(max-content, round(up,size,1px)). Without calc-size() each
// box keeps its fractional text width, so every label after the first starts on a fractional x and
// rasterises softer or heavier than its neighbours. This rounds the same boxes up the same way: one
// ResizeObserver, measured once per layout change of a box (or of its label), never per frame.
// AtriumWorkbench.wholePixels() loads this module only where calc-size() is unsupported.
//
//   AtriumWholePixels.observe(box, label?)  round box up now and after each change of box or label
//
// A label is watched as well when its text can shrink: the rounded minimum holds the box at its old
// width, so only the label's own size reports the change. A rounded minimum still gives way to an
// !important min-inline-size:0 (a squeezed dock tab) and to max-inline-size.
globalThis.AtriumWholePixels = (() => {
  const boxOf = new WeakMap();
  // In the next frame, so the rounding is not a resize inside this observer's own delivery.
  const fit = new ResizeObserver(rows => requestAnimationFrame(() => {
    const boxes = new Set();
    for (const {target} of rows) {
      const box = boxOf.get(target);
      if (box?.isConnected) boxes.add(box); else fit.unobserve(target);
    }
    // Clear, then read, then write: one layout for the whole batch.
    for (const box of boxes) box.style.minInlineSize = "";
    const list = [...boxes], widths = list.map(box => parseFloat(getComputedStyle(box).inlineSize)); // "auto" when not rendered
    list.forEach((box, i) => {if (widths[i] % 1 > 0) box.style.minInlineSize = Math.ceil(widths[i]) + "px";});
  }));
  function observe(box, label) {
    for (const target of [box, label]) if (target) {boxOf.set(target, box); fit.observe(target);}
  }
  return Object.freeze({observe});
})();
