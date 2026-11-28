"use strict";
globalThis.AtriumWindowedTable = (() => {
  const el = AtriumNavCommon.el;
  // The BOM grid's approach (bom.js paintRows): only rows in view (plus a margin)
  // exist; spacer rows keep the scroll height; the row height is measured once.
  // paint(tr, row, index) fills one <tr>. Returns {refresh(rows), scrollTo(i), rows()}.
  // With editable rows, paint also updates mounted rows and their controls in place.
  return function windowed(scroller, tbody, columns, paint, {rowHeight = 22, overscan = 8, editable = false} = {}) {
    let rows = [], rowH = rowHeight, frame = 0, view = 0;
    const spacer = h => {const tr = el("tr", null, "nav-spacer"), td = el("td"); tr.setAttribute("aria-hidden", "true"); td.colSpan = columns(); td.style.height = h + "px"; tr.append(td); return tr;};
    function draw() {
      view = scroller.clientHeight || 400;
      const top = Math.min(scroller.scrollTop, Math.max(0, rows.length * rowH - view));
      const first = Math.max(0, Math.floor(top / rowH) - overscan), last = Math.min(rows.length, Math.ceil((top + view) / rowH) + overscan);
      const indexes = Array.from({length: last - first}, (_, i) => first + i);
      const mounted = new Map();
      if (editable) {
        for (const tr of tbody.children) if (tr.dataset.r != null) mounted.set(Number(tr.dataset.r), tr);
        const active = document.activeElement?.closest("tr[data-r]");
        if (active?.parentNode === tbody) {
          const i = Number(active.dataset.r);
          if (i < first) indexes.unshift(i);
          else if (i >= last && i < rows.length) indexes.push(i);
        }
      }
      const next = [];
      let from = 0;
      for (const i of indexes) {
        if (i > from) next.push(spacer((i - from) * rowH));
        const tr = mounted.get(i) || el("tr");
        if (!mounted.has(i)) tr.dataset.r = String(i);
        paint(tr, rows[i], i);
        next.push(tr);
        from = i + 1;
      }
      if (from < rows.length) next.push(spacer((rows.length - from) * rowH));
      if (editable) {
        // Keep focused inputs in the DOM even if scrolling takes them out of the window.
        const keep = new Set(next);
        for (const tr of [...tbody.children]) if (!keep.has(tr)) tr.remove();
        let here = tbody.firstChild;
        for (const tr of next) {
          if (tr === here) here = here.nextSibling;
          else tbody.insertBefore(tr, here);
        }
      } else tbody.replaceChildren(...next);
      const probe = tbody.querySelector("tr[data-r]"), h = probe?.getBoundingClientRect().height;
      if (h && Math.abs(h - rowH) > .5) {rowH = h; draw();}
    }
    function schedule() {
      if (frame) return;
      const raf = globalThis.requestAnimationFrame || (f => setTimeout(f, 16));
      frame = raf(() => {frame = 0; draw();});
    }
    scroller.addEventListener("scroll", schedule);
    const observer = editable && globalThis.ResizeObserver ? new ResizeObserver(() => {
      if ((scroller.clientHeight || 400) !== view) schedule();
    }) : null;
    observer?.observe(scroller);
    return {
      refresh(next) {if (next) rows = next; draw();},
      scrollTo(i) {
        const y = i * rowH, h = scroller.clientHeight - 2 * rowH;
        if (y < scroller.scrollTop) scroller.scrollTop = y; else if (y > scroller.scrollTop + h) scroller.scrollTop = Math.max(0, y - h);
        draw();
      },
      rows: () => rows, rowHeight: () => rowH,
      dispose() {
        observer?.disconnect();
        scroller.removeEventListener("scroll", schedule);
        if (frame) (globalThis.cancelAnimationFrame || clearTimeout)(frame);
      }
    };
  };
})();
