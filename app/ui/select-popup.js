"use strict";
// One option list for every single-line <select>. The platform list (an NSMenu in WKWebView, a
// native pop-up in Chrome) is placed from the platform's own pop-up button metrics, which do not
// match Waffle's restyled field (appearance:none, 8 px inset, 12 px text), so it landed a few pixels
// off and drew in another font. This list opens like the app's menus: directly below the field with
// the 2 px menu gap, left edges aligned, at least as wide as the field, flipped above when there is
// no room. It sits in the top layer inside the field's dialog (so a modal dialog's translate, the
// page scroll and zoom do not move it), on whole device pixels. The <select> stays the source of
// truth: choosing an option sets its value and fires input and change.
globalThis.AtriumSelectPopup = (() => {
  const doc = globalThis.document, GAP = 2, EDGE = 8;
  let list = null, field = null, active = -1, rows = [], typed = "", typedAt = 0, cleanup = null;

  const snap = v => { const r = globalThis.devicePixelRatio || 1; return Math.round(v * r) / r; };
  function items(select) {
    const out = [];
    for (const node of select.children) {
      if (node.tagName === "OPTGROUP") {
        out.push({group: node.label, disabled: node.disabled, hidden: node.hidden});
        for (const o of node.children) if (o.tagName === "OPTION") out.push({option: o, disabled: node.disabled || o.disabled, hidden: o.hidden, nested: true});
      } else if (node.tagName === "OPTION") out.push({option: node, disabled: node.disabled, hidden: node.hidden});
    }
    return out.filter(x => !x.hidden);
  }
  function build(select) {
    const box = doc.createElement("div");
    box.className = "ui-select-list";
    box.id = "ui-select-list";
    box.setAttribute("role", "listbox");
    box.tabIndex = -1;
    const label = select.getAttribute("aria-label") || select.labels?.[0]?.textContent?.trim();
    if (label) box.setAttribute("aria-label", label);
    if (typeof box.showPopover === "function") box.popover = "manual";
    const style = getComputedStyle(select);
    box.style.font = style.font;
    rows = [];
    for (const x of items(select)) {
      const row = doc.createElement("div");
      if (x.group != null) {
        row.className = "ui-select-group"; row.textContent = x.group; row.setAttribute("role", "presentation");
        box.append(row); continue;
      }
      row.className = "ui-select-option" + (x.nested ? " nested" : "");
      row.id = "ui-select-option-" + rows.length;
      row.setAttribute("role", "option");
      row.textContent = x.option.label || x.option.textContent;
      row.setAttribute("aria-selected", String(x.option.selected));
      if (x.disabled) row.setAttribute("aria-disabled", "true");
      row.dataset.index = String(rows.length);
      rows.push({row, option: x.option, disabled: x.disabled});
      box.append(row);
    }
    return box;
  }
  // Below the field (menu gap), left edges aligned; above it when the space below is short.
  function place(box, select) {
    const r = select.getBoundingClientRect(), vw = doc.documentElement.clientWidth, vh = doc.documentElement.clientHeight;
    // Above the field, the list stays below the macOS title bar (--window-caption-height).
    const top = EDGE + (parseFloat(getComputedStyle(doc.documentElement).getPropertyValue("--window-caption-height")) || 0);
    const below = vh - r.bottom - GAP - EDGE, above = r.top - GAP - top;
    Object.assign(box.style, {position: "fixed", inset: "auto", margin: "0", minWidth: snap(r.width) + "px", maxHeight: "", left: "0px", top: "0px"});
    const natural = box.scrollHeight + (box.offsetHeight - box.clientHeight);
    const up = natural > below && above > below;
    const room = Math.max(72, up ? above : below);
    box.style.maxHeight = Math.floor(Math.min(room, 360)) + "px";
    const h = box.offsetHeight, w = box.offsetWidth;
    const rtl = getComputedStyle(select).direction === "rtl";
    box.dir = rtl ? "rtl" : "ltr";
    let x = rtl ? r.right - w : r.left, y = up ? r.top - GAP - h : r.bottom + GAP;
    if (x + w > vw - EDGE) x = Math.max(EDGE, vw - EDGE - w);
    if (x < EDGE) x = EDGE;
    x = snap(x); y = snap(y);
    box.style.left = x + "px"; box.style.top = y + "px";
    // A containing block that is not the viewport (no top layer, or a transformed ancestor) offsets
    // fixed positioning; measure and correct so the list lands exactly where it was asked to.
    const at = box.getBoundingClientRect();
    if (Math.abs(at.left - x) > .01 || Math.abs(at.top - y) > .01) {
      box.style.left = snap(2 * x - at.left) + "px"; box.style.top = snap(2 * y - at.top) + "px";
    }
    box.dataset.side = up ? "top" : "bottom";
  }
  function setActive(i, scroll = true) {
    if (active >= 0 && rows[active]) rows[active].row.classList.remove("active");
    active = i;
    const row = rows[i]?.row;
    if (!row) { list?.removeAttribute("aria-activedescendant"); return; }
    row.classList.add("active");
    list.setAttribute("aria-activedescendant", row.id);
    if (scroll) {
      const top = row.offsetTop, bottom = top + row.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top - 4;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
    }
  }
  function step(from, delta) {
    for (let i = from + delta; i >= 0 && i < rows.length; i += delta) if (!rows[i].disabled) return i;
    return from;
  }
  function choose(i) {
    const select = field, x = rows[i];
    if (!x || x.disabled) return;
    close(true);
    if (select.selectedIndex !== x.option.index) {
      select.selectedIndex = x.option.index;
      select.dispatchEvent(new Event("input", {bubbles: true}));
      select.dispatchEvent(new Event("change", {bubbles: true}));
    }
  }
  function close(refocus) {
    if (!list) return;
    const select = field, box = list;
    cleanup?.(); cleanup = null;
    if (box.popover === "manual" && box.matches(":popover-open")) box.hidePopover();
    box.remove();
    list = null; field = null; rows = []; active = -1;
    select.removeAttribute("aria-expanded"); select.removeAttribute("aria-controls");
    if (refocus) select.focus({preventScroll: true});
  }
  function onKey(e) {
    const page = Math.max(1, Math.floor(list.clientHeight / (rows[0]?.row.offsetHeight || 24)) - 1);
    const go = {ArrowDown: () => step(active, 1), ArrowUp: () => step(active, -1), Home: () => step(-1, 1), End: () => step(rows.length, -1),
      PageDown: () => { let i = active; for (let k = 0; k < page; k++) i = step(i, 1); return i; },
      PageUp: () => { let i = active; for (let k = 0; k < page; k++) i = step(i, -1); return i; }}[e.key];
    if (go) setActive(go());
    else if (e.key === "Enter" || e.key === " " && !typed) choose(active);
    else if (e.key === "Escape") close(true);
    else if (e.key === "Tab") { close(true); return; }
    else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      const now = Date.now();
      typed = (now - typedAt > 700 ? "" : typed) + e.key.toLowerCase(); typedAt = now;
      const n = rows.length, start = typed.length === 1 ? active + 1 : Math.max(active, 0);
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        if (!rows[i].disabled && rows[i].row.textContent.trim().toLowerCase().startsWith(typed)) { setActive(i); break; }
      }
    } else return;
    e.preventDefault(); e.stopPropagation();
  }
  function open(select) {
    if (list) { const same = field === select; close(same); if (same) return; }
    if (!select || select.disabled || select.multiple || select.size > 1 || !select.isConnected) return;
    field = select;
    list = build(select);
    (select.closest("dialog[open]") || select.closest("[popover]") || doc.body).append(list);
    if (list.popover === "manual") list.showPopover();
    place(list, select);
    select.setAttribute("aria-expanded", "true"); select.setAttribute("aria-controls", list.id);
    typed = "";
    setActive(rows.findIndex(x => x.option.selected && !x.disabled), false);
    if (active < 0) setActive(step(-1, 1), false);
    else { const row = rows[active].row; list.scrollTop = Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2); }
    list.focus({preventScroll: true});
    const box = list;
    box.addEventListener("keydown", onKey);
    box.addEventListener("pointermove", e => { const row = e.target.closest?.(".ui-select-option"); if (row && !row.matches("[aria-disabled]")) setActive(Number(row.dataset.index), false); });
    box.addEventListener("click", e => { const row = e.target.closest?.(".ui-select-option"); if (row) choose(Number(row.dataset.index)); });
    // Like a menu: a press elsewhere, a scroll outside the list, a resize or losing focus closes it.
    const away = e => { if (!box.contains(e.target) && e.target !== select) close(false); };
    const scrolled = e => { if (!box.contains(e.target)) close(false); };
    const resized = () => close(false);
    const blurred = () => setTimeout(() => { if (list === box && !box.contains(doc.activeElement)) close(false); });
    doc.addEventListener("pointerdown", away, true);
    doc.addEventListener("scroll", scrolled, true);
    globalThis.addEventListener("resize", resized);
    box.addEventListener("focusout", blurred);
    // A select that leaves (a key the list passes on rebuilt the inspector, a module arrived) takes its
    // list with it at once: the list kept focus, so no focusout or press would come (ui/owner-layer.js).
    globalThis.AtriumLayer?.watch(box, select, () => { if (list === box) close(false); });
    cleanup = () => {
      doc.removeEventListener("pointerdown", away, true);
      doc.removeEventListener("scroll", scrolled, true);
      globalThis.removeEventListener("resize", resized);
    };
  }
  return {open, close, isOpen: () => !!list, element: () => list, field: () => field};
})();
