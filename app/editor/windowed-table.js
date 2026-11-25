"use strict";
globalThis.AtriumWindowedTable = (() => {
  const el = AtriumNavCommon.el;
  // The BOM grid's approach (bom.js paintRows): only rows in view (plus a margin)
  // exist; spacer rows keep the scroll height; the row height is measured once.
  // paint(tr, row, index) fills one <tr>. Returns {refresh(rows), scrollTo(i), rows()}.
  return function windowed(scroller, tbody, columns, paint, {rowHeight = 22, overscan = 8} = {}) {
    let rows = [], rowH = rowHeight, frame = 0;
    const spacer = h => {const tr = el("tr", null, "nav-spacer"), td = el("td"); tr.setAttribute("aria-hidden", "true"); td.colSpan = columns(); td.style.height = h + "px"; tr.append(td); return tr;};
    function draw() {
      const view = scroller.clientHeight || 400, top = scroller.scrollTop;
      const first = Math.max(0, Math.floor(top / rowH) - overscan), last = Math.min(rows.length, Math.ceil((top + view) / rowH) + overscan);
      const frag = document.createDocumentFragment();
      if (first) frag.append(spacer(first * rowH));
      for (let r = first; r < last; r++) {const tr = el("tr"); tr.dataset.r = String(r); paint(tr, rows[r], r); frag.append(tr);}
      if (last < rows.length) frag.append(spacer((rows.length - last) * rowH));
      tbody.replaceChildren(frag);
      const probe = tbody.querySelector("tr[data-r]"), h = probe?.getBoundingClientRect().height;
      if (h && Math.abs(h - rowH) > .5) {rowH = h; draw();}
    }
    scroller.addEventListener("scroll", () => {
      if (frame) return;
      const raf = globalThis.requestAnimationFrame || (f => setTimeout(f, 16));
      frame = raf(() => {frame = 0; draw();});
    });
    return {
      refresh(next) {if (next) rows = next; draw();},
      scrollTo(i) {
        const y = i * rowH, h = scroller.clientHeight - 2 * rowH;
        if (y < scroller.scrollTop) scroller.scrollTop = y; else if (y > scroller.scrollTop + h) scroller.scrollTop = Math.max(0, y - h);
        draw();
      },
      rows: () => rows, rowHeight: () => rowH
    };
  };
})();
