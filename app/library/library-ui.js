"use strict";
// Shared Library UI modules: AtriumLibraryRows, AtriumLibraryFacetsUI, AtriumLibraryInspector, AtriumLibraryDockUI.

// Shared library component rows and tree builder (Design A docked tab + Design B workspace).
// Built strictly from AtriumUIKit (.ui-list, .ui-row, .ui-tree-row, .ui-row-icons, .ui-badge, .ui-count, .ui-dot).
globalThis.AtriumLibraryRows = (() => {
  const K = () => globalThis.AtriumUIKit;
  const closedNodes = new Set();
  const openFamilies = new WeakMap();

  /** Compact symbol / footprint presence glyphs (14 px dense icons, dimmed when absent). */
  function presenceIcons(def, target) {
    const k = K(), wrap = k.el("span", "ui-row-icons");
    wrap.setAttribute("aria-hidden", "true");
    for (const kind of target ? [target] : ["schematic", "pcb"]) {
      const i = k.icon(kind === "pcb" ? "chip" : "schematic");
      const present = kind === "pcb" ? !!def?.footprint : !!def?.symbol;
      if (!present) i.dataset.absent = "";
      wrap.append(i);
    }
    return wrap;
  }

  /** One component row (.ui-row.ui-tree-row.lib-row) with presence icons, title/detail, counts/badges and drag-to-place. */
  function componentRow(o) {
    const k = K(), def = o.def, f = o.facts || {};
    const title = o.variant?.label || def.name || def.id;
    const metaText = [f.prefix && f.prefix + "?", f.pkg, f.pins ? f.pins + " pins" : "", !f.pins && f.pads ? f.pads + " pads" : ""].filter(Boolean).join(" · ");
    const detail = o.variant
      ? (o.variant.description || [f.pins ? f.pins + " pins" : "", f.pads ? f.pads + " pads" : ""].filter(Boolean).join(" · "))
      : (o.detail ?? (metaText || def.category || ""));
    const badges = k.el("span", "ui-row-meta lib-badges");
    if (o.issues) {
      const d = k.dot("warning", {label: o.issues + " issue(s)"});
      d.title = o.issues + " issue(s)";
      badges.append(d);
    }
    if (o.status && o.statusMark) {
      const b = k.badge(o.statusMark, o.statusTone);
      if (o.statusText) b.title = o.statusText;
      badges.append(b);
    }
    if (o.used) {
      const c = k.count("×" + o.used, {label: "Placed " + o.used + " time(s)"});
      c.title = "Placed " + o.used + " time(s)";
      badges.append(c);
    }
    if (o.extraBadges) for (const b of o.extraBadges) badges.append(b);

    const row = k.row({
      title,
      detail,
      icon: presenceIcons(def, o.target),
      meta: badges.childElementCount ? badges : null,
      selected: !!o.selected,
      depth: o.depth ?? 0,
      role: o.role || "treeitem"
    });
    row.classList.add("lib-row");
    if (o.extraClass) row.classList.add(o.extraClass);
    row.dataset.def = def.id;
    row.tabIndex = o.selected ? 0 : -1;
    row.draggable = o.draggable !== undefined ? !!o.draggable : dropReceiver();
    if (o.variant) {
      row.dataset.packageChoice = "";
      row.querySelector(".ui-row-text")?.append(k.el("span", "visually-hidden", o.variant.context));
    }
    row.title = o.variant ? [title, detail].filter(Boolean).join(" · ") : (def.name || "");
    if (o.onSelect) row.addEventListener("click", () => o.onSelect(def, row));
    if (o.onActivate) row.addEventListener("dblclick", () => o.onActivate(def, row));
    if (o.onPointerDown) row.addEventListener("pointerdown", e => o.onPointerDown(e, def, row));
    if (o.onFocus) row.addEventListener("focus", () => o.onFocus(def, row));
    if (o.onHover) row.addEventListener("pointermove", e => { if (e.pointerType !== "touch") o.onHover(def, row); });
    if (o.onDragStart) {
      row.addEventListener("dragstart", e => {
        o.onDragStart(e, def, row);
        globalThis.AtriumSpatialMotion?.lift?.(row);
      });
      row.addEventListener("dragend", () => {
        o.onDragEnd?.(def, row);
        globalThis.AtriumSpatialMotion?.settle?.(row);
      });
    }
    return row;
  }

  /** Arm placement of a project def. A document view over the active pane's canvas (the Library tab) steps aside first. */
  function place(ctx, def, kind) {
    globalThis.AtriumDocViews?.showCanvas?.();
    if (ctx.placeDef) ctx.placeDef(def, kind); else ctx.info?.("Placement is unavailable in this build.");
  }

  /** Reveal a part in the dock or the tab: clear the parameter filters of `key`, and find where it lives (the source
   *  given, else a registered library holding its id when the project has none). A built-in part has neither. */
  function revealSource(key, def, source, {project, libs, api}) {
    globalThis.AtriumLibraryFacetsUI?.close();
    globalThis.AtriumCatalogue?.clearFacets?.(key);
    const inProject = project.library.some(d => d.id === def.id);
    return {inProject, lib: source || (inProject ? null : libs.find(l => api.sourceEntry(l, {id: def.id})) || null)};
  }

  /** Whether the experimental system file-drop receiver is enabled (otherwise pointer drag places live). */
  const dropReceiver = () => globalThis.AtriumPrefs?.get("butter.drop") === true;

  /** Live pointer-driven drag-to-place onto the design canvas (Space rotates, X/Y mirror, release lands). */
  function startDragPlace(e, {def, lib, row, onSelect, placeEntry, currentKind, info}) {
    if (e.button !== 0 || e.pointerType === "touch" || row.draggable) return;
    const host = globalThis.AtriumNavHost, id = e.pointerId, start = [e.clientX, e.clientY];
    let lifted = false, placing = false, full = null, at = null, added = null;
    const onCanvas = ev => !!host?.canvas?.() && document.elementFromPoint(ev.clientX, ev.clientY) === host.canvas();
    const listen = on => {
      for (const [type, fn] of [["pointermove", move], ["pointerup", up], ["pointercancel", cancel], ["keydown", key]]) {
        (on ? addEventListener : removeEventListener)(type, fn, true);
      }
    };
    const end = () => { listen(false); if (lifted) globalThis.AtriumSpatialMotion?.settle?.(row); lifted = false; };
    function begin(activate = false) {
      if (placing || !full || !at || !host?.canvasAt?.(at[0], at[1], activate)) return false;
      placing = true;
      const before = host.revision();
      placeEntry(lib, full, currentKind());
      if (host.revision() !== before) added = host.revision();
      return true;
    }
    function abandon() {
      if (placing && host?.placing?.()) host.act("select");
      if (added != null && host?.revision?.() === added) host.act("undo");
    }
    function move(ev) {
      if (ev.pointerId !== id) return;
      if (!lifted) {
        if (Math.hypot(ev.clientX - start[0], ev.clientY - start[1]) < 4) return;
        lifted = true; onSelect?.(def, row); globalThis.AtriumSpatialMotion?.lift?.(row);
        const ready = lib && def.stub ? globalThis.AtriumLibrarySources.load(lib, def.id) : Promise.resolve(def);
        ready.then(d => { if (lifted) { full = d; begin(); } }, error => { end(); info?.(error.message); });
      }
      at = [ev.clientX, ev.clientY];
      if (!placing) begin();
    }
    function up(ev) {
      if (ev.pointerId !== id) return;
      end();
      if (placing && !host?.placing?.()) return abandon();
      if (placing && onCanvas(ev)) return void host.placeAt(ev.clientX, ev.clientY);
      abandon(); placing = false; added = null; at = [ev.clientX, ev.clientY];
      if (begin(true) && host?.placing?.()) host.placeAt(ev.clientX, ev.clientY);
    }
    function cancel(ev) { if (ev.pointerId === id) { end(); abandon(); } }
    function key(ev) { if (ev.key === "Escape" && !placing) end(); }
    listen(true);
  }

  /** One collapsible group / category / family header row (.ui-row.ui-tree-row). */
  function groupRow({title, count, depth = 0, expanded = true, onToggle, onFocus}) {
    const k = K();
    const row = k.row({
      title,
      detail: count != null ? String(count) : undefined,
      depth,
      expanded: !!expanded,
      role: "treeitem"
    });
    row.classList.add("lib-group-row");
    row.tabIndex = -1;
    row.addEventListener("click", () => onToggle?.());
    if (onFocus) row.addEventListener("focus", () => onFocus(row));
    return row;
  }

  /** Render a category tree (Group › Category › component rows) using shared .ui-tree-row disclosures. */
  function categoryTree(list, defs, buildRow, o = {}) {
    const C = globalThis.AtriumCatalogue, k = K();
    if (!C) {
      for (const d of defs) list.append(buildRow(d, null, 0));
      return;
    }
    const key = o.key || "list", cap = o.cap || (defs.length > 400 ? 24 : 150), byGroup = new Map();
    for (const d of defs) {
      const r = C.record(d);
      if (!byGroup.has(r.group)) byGroup.set(r.group, new Map());
      const m = byGroup.get(r.group);
      if (!m.has(r.cat)) m.set(r.cat, []);
      m.get(r.cat).push(d);
    }
    const order = [...C.GROUPS.map(x => x[0]), "Other"];
    const rankCat = c => { const i = C.LEAVES.indexOf(c); return i < 0 ? 1e3 : i; };

    function mountBranch(parent, name, count, id, depth, buildChildren) {
      const stateKey = key + "|" + id;
      let open = !!o.open || !closedNodes.has(stateKey);
      let built = false;
      const box = k.el("div", "lib-tree-branch");
      box.setAttribute("role", "group");
      box.hidden = !open;
      const ensure = () => { if (open && !built) { built = true; buildChildren(box, depth + 1); } };
      const head = groupRow({
        title: name,
        count,
        depth,
        expanded: open,
        onToggle: () => {
          open = !open;
          head.setAttribute("aria-expanded", String(open));
          box.hidden = !open;
          if (!o.open) { if (open) closedNodes.delete(stateKey); else closedNodes.add(stateKey); }
          ensure();
        }
      });
      head.dataset.category = name;
      parent.append(head, box);
      ensure();
    }

    function fillItems(box, items, depth) {
      const add = (from, n) => {
        for (const d of items.slice(from, from + n)) box.append(buildRow(d, null, depth));
        if (items.length > from + n) {
          const rest = items.length - from - n;
          const more = k.button("Show " + Math.min(150, rest) + " more" + (rest > 150 ? " of " + rest : ""), {
            variant: "quiet", size: "sm",
            run: e => { e.stopPropagation(); more.remove(); add(from + n, 150); }
          });
          more.classList.add("lib-tree-more");
          box.append(more);
        }
      };
      add(0, cap);
    }

    for (const g of [...byGroup.keys()].sort((a, b) => order.indexOf(a) - order.indexOf(b))) {
      const cats = [...byGroup.get(g)].sort((a, b) => rankCat(a[0]) - rankCat(b[0]) || C.natural(a[0], b[0]));
      const total = cats.reduce((n, c) => n + c[1].length, 0);
      mountBranch(list, g, total, g, 0, (box, depth) => {
        if (cats.length === 1 && cats[0][0] === g) { fillItems(box, cats[0][1], depth); return; }
        for (const [c, items] of cats) {
          mountBranch(box, c, items.length, g + "/" + c, depth, (cBox, cDepth) => fillItems(cBox, items, cDepth));
        }
      });
    }
  }

  /** Render families (Family › Chip › Packages) followed by ungrouped category tree using .ui-tree-row. */
  function componentTree(list, defs, buildRow, o = {}) {
    const members = o.members, k = K(), F = globalThis.AtriumComponentFamilies;
    if (!members?.size || !F) { categoryTree(list, defs, buildRow, o); return; }
    const scope = o.scope || o.owner || list;
    let opened = openFamilies.get(scope);
    if (!opened) { opened = new Set(); openFamilies.set(scope, opened); }
    const grouped = [], ordinary = [];
    for (const d of defs) (members.has(d.id) ? grouped : ordinary).push(d);
    const families = F.browse(o.owner, grouped);
    const sourced = def => {
      for (const [key, value] of Object.entries(def?.parameters || {})) {
        if (/^(lcsc ?#?|lcsc part|mpn|manufacturer part number|supplier part number|jlc ?#?)$/i.test(key) && String(value || "").trim()) return String(value).trim();
      }
      return "";
    };

    function mountFamilyBranch(parent, title, count, idKey, depth, reveal, boxClass, buildChildren) {
      const id = JSON.stringify([o.key, o.source, idKey]);
      let open = !!(o.open || reveal || opened.has(id));
      let built = false;
      const box = k.el("div", boxClass || "lib-tree-branch");
      box.setAttribute("role", "group");
      box.hidden = !open;
      const ensure = () => { if (open && !built) { built = true; buildChildren(box, depth + 1); } };
      const head = groupRow({
        title,
        count,
        depth,
        expanded: open,
        onFocus: o.onGroup,
        onToggle: () => {
          open = !open;
          head.setAttribute("aria-expanded", String(open));
          box.hidden = !open;
          if (!o.open && !reveal) { if (open) opened.add(id); else opened.delete(id); }
          ensure();
          o.onGroup?.(head);
        }
      });
      head.classList.add(depth === 0 ? "lib-family-head" : "lib-chip-head");
      parent.append(head, box);
      ensure();
    }

    for (const family of families) {
      const partCount = family.parts.length;
      const reveals = part => part.options.some(v => v.id === o.reveal);
      mountFamilyBranch(list, family.name, partCount + (partCount === 1 ? " chip" : " chips"), family.id, 0, family.parts.some(reveals), "lib-tree-branch", (fBox, fDepth) => {
        for (const part of family.parts) {
          const n = part.options.length;
          mountFamilyBranch(fBox, part.name, n + (n === 1 ? " package" : " packages"), [family.id, part.name], fDepth, reveals(part), "cat-family-packages", (pBox, pDepth) => {
            const labels = new Map();
            for (const v of part.options) labels.set(v.packageName, (labels.get(v.packageName) || 0) + 1);
            for (const v of part.options) {
              const label = v.packageName || (v.def.symbol ? "Symbol only" : "Footprint");
              const exactName = v.def.name === part.name ? "" : v.def.name;
              const description = labels.get(v.packageName) > 1 ? [exactName, sourced(v.def), v.id].filter(Boolean).join(" · ") : exactName;
              pBox.append(buildRow(v.def, {label, description, context: family.name + ", " + part.name}, pDepth));
            }
          });
        }
      });
    }
    categoryTree(list, ordinary, buildRow, o);
  }

  /** Visible interactive rows inside a tree list (excluding rows inside collapsed branches). */
  function visibleRows(list) {
    return [...list.querySelectorAll(".ui-row, .lib-tree-more")].filter(node => !node.closest("[hidden]"));
  }

  /** Standard tree keyboard navigation: Up/Down across visible rows, Left/Right to collapse/expand, Enter/Space toggle a group. */
  function handleTreeKey(e, list, {onSelectRow, onTopEscape}) {
    if ((e.key === "Enter" || e.key === " ") && e.target.matches?.(".lib-group-row")) {
      e.preventDefault(); e.target.click(); return true;
    }
    if (e.key === "ArrowRight" && e.target.matches?.(".lib-group-row[aria-expanded=false]")) {
      e.preventDefault(); e.target.click(); return true;
    }
    if (e.key === "ArrowLeft" && e.target.matches?.(".lib-group-row[aria-expanded=true]")) {
      e.preventDefault(); e.target.click(); return true;
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return false;
    e.preventDefault();
    const rows = visibleRows(list);
    if (!rows.length) return true;
    let index = rows.indexOf(e.target);
    if (index < 0) index = rows.findIndex(r => r.getAttribute("aria-selected") === "true");
    if (e.key === "ArrowUp" && index <= 0) { onTopEscape?.(); return true; }
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      if (next.matches(".lib-row")) onSelectRow?.(next);
      next.focus();
      next.scrollIntoView?.({block: "nearest"});
    }
    return true;
  }

  return Object.freeze({presenceIcons, componentRow, groupRow, categoryTree, componentTree, visibleRows, handleTreeKey, dropReceiver, startDragPlace, place, revealSource});
})();

// Shared parameter facet popover for the Library docked tab (Design A) and workspace (Design B).
// Uses only shared UI library surfaces: .ui-popover, K.section, K.checkbox, K.button, K.empty.
globalThis.AtriumLibraryFacetsUI = (() => {
  const K = () => globalThis.AtriumUIKit;
  const C = () => globalThis.AtriumCatalogue;
  let active = null; // {popover, trigger, close}

  function captionTop() {
    try { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0; }
    catch { return 0; }
  }

  function activeCount(key, onlyFacet) {
    const st = C()?.state?.(key);
    if (!st) return 0;
    if (onlyFacet) return st.facets[onlyFacet]?.size || 0;
    return Object.values(st.facets).reduce((n, m) => n + m.size, 0);
  }

  function summaryLabel(key, facetKey, fallback) {
    const m = C()?.state?.(key)?.facets?.[facetKey];
    if (!m?.size) return fallback;
    const vals = [...m.values()];
    return fallback + ": " + (vals.length <= 2 ? vals.join(", ") : vals.slice(0, 2).join(", ") + " +" + (vals.length - 2));
  }

  function close() {
    if (!active) return;
    const {popover, trigger, onDown, onKey} = active;
    active = null;
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    popover.remove();
    trigger?.setAttribute("aria-expanded", "false");
  }

  function position(popover, trigger) {
    const r = trigger.getBoundingClientRect();
    const minTop = captionTop() + 6;
    const vw = window.innerWidth || 1280, vh = window.innerHeight || 800;
    const w = Math.min(280, Math.max(220, r.width));
    popover.style.width = w + "px";
    const left = Math.max(8, Math.min(r.left, vw - w - 8));
    let top = Math.max(minTop, r.bottom + 4);
    popover.style.left = Math.round(left) + "px";
    popover.style.top = Math.round(top) + "px";
    popover.style.maxHeight = Math.max(160, Math.round(vh - top - 12)) + "px";
    const pr = popover.getBoundingClientRect();
    if (pr.bottom > vh - 8 && r.top - pr.height - 4 >= minTop) {
      top = Math.max(minTop, r.top - pr.height - 4);
      popover.style.top = Math.round(top) + "px";
    }
  }

  /** Render facet groups into a container (used by the popover and reusable in panels). */
  function fill(host, key, counts, onChange, {onlyFacet, title} = {}) {
    const k = K(), cat = C();
    if (!cat) return;
    const st = cat.state(key);
    host.replaceChildren();
    const nActive = activeCount(key, onlyFacet);
    const clearBtn = k.button("Clear", {
      variant: "quiet", size: "sm", disabled: !nActive,
      title: onlyFacet ? "Clear this filter" : "Clear every parameter filter",
      run: () => {
        if (onlyFacet) st.facets[onlyFacet]?.clear();
        else cat.clearFacets(key);
        onChange?.();
      }
    });
    const list = onlyFacet ? cat.FACETS.filter(([fk]) => fk === onlyFacet) : cat.FACETS;
    const headerTitle = title || (onlyFacet ? (list[0]?.[1] || "Filter") : "Filters");
    const body = k.el("div", "lib-facets-scroll");
    let shown = 0;
    for (const [fk, label] of list) {
      const m = counts?.[fk];
      if (!m?.size) continue;
      shown++;
      const sel = st.facets[fk] || (st.facets[fk] = new Map());
      const values = [...m].sort((a, b) =>
        (fk === "pins" ? (+a[1].label) - (+b[1].label) : fk === "value" || fk === "package" ? b[1].n - a[1].n : 0) ||
        cat.natural(a[1].label, b[1].label)
      );
      const cap = st.more.has(fk) ? Infinity : 8;
      const rows = [];
      values.forEach(([v, c], i) => {
        if (i >= cap && !sel.has(v)) return;
        const row = k.checkbox(c.label, {
          checked: sel.has(v),
          onChange: checked => {
            if (checked) sel.set(v, c.label); else sel.delete(v);
            onChange?.();
          }
        });
        row.classList.add("lib-facet-row");
        if (!c.n) row.dataset.zero = "";
        const countEl = k.el("span", "ui-row-meta", String(c.n));
        row.append(countEl);
        rows.push(row);
      });
      if (values.length > cap) {
        rows.push(k.button("Show all " + values.length, {
          variant: "quiet", size: "sm",
          run: () => { st.more.add(fk); onChange?.(); }
        }));
      }
      if (onlyFacet) {
        body.append(...rows);
      } else {
        const badge = sel.size ? [k.count(sel.size, {tone: "accent"})] : [];
        body.append(k.section(label, {quiet: true, actions: badge}, ...rows));
      }
    }
    if (!shown) body.append(k.empty({text: "No parameters available to filter by."}));
    host.append(k.section(headerTitle, {actions: [clearBtn]}, body));
  }

  /** Toggle a shared .ui-popover anchored to `trigger`. Re-renders in place on filter changes. */
  function togglePopover(trigger, {key, getCounts, onChange, onlyFacet, title}) {
    if (active?.trigger === trigger) { close(); return false; }
    close();
    const k = K(), pop = k.el("div", "ui-popover lib-facets-popover");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", title || "Parameter filters");
    const refresh = () => {
      onChange?.();
      if (active?.popover === pop) fill(pop, key, getCounts?.() || {}, refresh, {onlyFacet, title});
    };
    fill(pop, key, getCounts?.() || {}, refresh, {onlyFacet, title});
    document.body.append(pop);
    position(pop, trigger);
    trigger.setAttribute("aria-expanded", "true");
    const onDown = e => { if (!pop.contains(e.target) && !trigger.contains(e.target)) close(); };
    const onKey = e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); trigger.focus(); }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    active = {popover: pop, trigger, close, onDown, onKey};
    pop.querySelector("input,button")?.focus?.();
    return true;
  }

  return Object.freeze({activeCount, summaryLabel, fill, togglePopover, close, isOpen: () => !!active});
})();

// Shared component inspector for the docked Library tab (Design A), Place dialog (transition),
// and the full Library workspace tab (Design B). Built strictly from AtriumUIKit + AtriumNavCommon.actionMenu.
globalThis.AtriumLibraryInspector = (() => {
  const K = () => globalThis.AtriumUIKit;

  function buildPinsTable(def) {
    const k = K(), pins = def?.symbol?.pins || [];
    if (!pins.length) return k.empty({text: "This component has no symbol pins."});
    const gated = (def.symbol?.parts || 1) > 1;
    const cols = gated ? ["#", "Name", "Type", "Gate"] : ["#", "Name", "Type"];
    return k.analysisTable(cols, pins, pin => {
      const tr = k.el("tr");
      tr.append(
        k.el("td", null, String(pin.number ?? "—")),
        k.el("td", null, pin.name || "—"),
        k.el("td", null, pin.electrical || "passive")
      );
      if (gated) tr.append(k.el("td", null, pin.part > 0 ? String(pin.part) : "All"));
      return tr;
    }, {wrapClass: "lib-pins-wrap", tableClass: "ui-table"});
  }

  function buildProperties(def, {facts, used, status, statusText, statusTone, lib, linked, onReviewUpdate}) {
    const k = K(), rows = [];
    const add = (caption, value) => {
      if (value === "" || value == null) return;
      rows.push(k.propRow(caption, typeof value === "string" ? value : value));
    };
    add("Value", def.value || "");
    add("Footprint", facts.pkg || "");
    add("Pins / pads", (facts.pins || "–") + " / " + (facts.pads || "–"));
    if (facts.height) add("Height", facts.height + " mm");
    if (lib) {
      add("In project", linked?.length ? "Yes" : "No");
    } else if (used) {
      const refs = [...new Set(used.map(u => u.item.ref))];
      add("Placed", refs.length ? refs.slice(0, 10).join(", ") + (refs.length > 10 ? " +" + (refs.length - 10) : "") : "Not placed");
    }
    if (def.symbol?.parts > 1) add("Gates", def.symbol.parts + (def.symbol.alternate ? " + De Morgan" : ""));
    if (!lib && status) {
      const val = k.el("span", "ui-prop-value lib-prop-inline");
      val.append(k.el("span", null, status.lib?.name || def.libraryRef?.library || "Library"));
      val.append(k.badge(statusText || status.state, statusTone));
      if (status.src && !status.same && onReviewUpdate) {
        val.append(k.button("Review…", {size: "sm", run: onReviewUpdate}));
      }
      add("Library", val);
    }
    for (const [key, val] of Object.entries(facts.params || {}).slice(0, 12)) add(key, String(val));
    return rows;
  }

  function buildOverflowCommands(spec) {
    const def = spec.def, a = spec.actions || {}, kind = spec.currentKind || "schematic";
    if (spec.lib) {
      const cmds = [];
      if (kind === "schematic" && def.footprint) cmds.push({label: "Place footprint on board", run: () => a.place?.("pcb")});
      if (kind === "pcb" && def.symbol) cmds.push({label: "Place symbol on sheet", run: () => a.place?.("schematic")});
      if (spec.linked?.length && spec.sourceDiffCount) {
        cmds.push({label: "Update project (" + spec.sourceDiffCount + ")…", run: () => a.reviewUpdate?.()});
      }
      return cmds;
    }
    const cmds = [];
    if (kind === "schematic") cmds.push({label: "Place footprint on board", enabled: !!def.footprint, run: () => a.place?.("pcb")});
    else cmds.push({label: "Place symbol on sheet", enabled: !!def.symbol, run: () => a.place?.("schematic")});
    cmds.push("-");
    cmds.push({label: def.symbol ? "Edit symbol" : "Create symbol", shortcut: "E", run: () => a.editSymbol?.()});
    cmds.push({label: def.footprint ? "Edit footprint" : "Create footprint", shortcut: "Shift+E", run: () => a.editFootprint?.()});
    if (def.footprint?.wizard) cmds.push({label: "Open in IPC wizard…", run: () => a.openWizard?.()});
    cmds.push("-");
    if (a.attachPackage && def.symbol && def.footprint) cmds.push({label: "Add package…", run: () => a.attachPackage(true)});
    else if (a.attachPackage && (def.symbol || def.footprint)) {
      const other = def.symbol ? "footprint" : "symbol";
      cmds.push({label: "Attach " + other + "…", run: () => a.attachPackage(false)});
    }
    if (a.manageFamily) cmds.push({label: spec.family ? "Edit family…" : "Group component…", run: () => a.manageFamily()});
    cmds.push({label: "Duplicate", shortcut: "Mod+D", run: () => a.duplicate?.()});
    cmds.push("-");
    cmds.push({label: "Update placed parts", run: () => a.updateParts?.()});
    if (spec.status?.src && !spec.status.same) {
      cmds.push({label: spec.status.pending ? "Compare with library…" : "Update from library…", run: () => a.reviewUpdate?.()});
    }
    cmds.push({label: "Save to library…", run: () => a.saveToLibrary?.()});
    if (a.saveToFolder) cmds.push({label: "Save to folder…", run: () => a.saveToFolder()});
    cmds.push("-");
    cmds.push({
      label: "Delete",
      shortcut: spec.used?.length ? undefined : "Backspace",
      enabled: !(spec.used?.length > 0),
      run: () => a.remove?.()
    });
    return cmds;
  }

  /** Render the inspector into `host`. Supports compact (docked) and tabbed (workspace) layouts. */
  function render(host, spec) {
    const k = K();
    globalThis.AtriumCatalogue?.cancelPreview?.(host);
    host.replaceChildren();
    const def = spec.def;
    if (!def) {
      if (spec.beforeEmpty) spec.beforeEmpty(host);
      host.append(k.empty({text: spec.emptyText || "Select a component. Drag it onto the sheet or board to place it."}));
      return;
    }
    if (def.stub) {
      const title = k.el("div", "lib-detail-title");
      title.append(k.el("strong", null, def.name), k.el("small", null, spec.lib?.name || ""));
      host.append(title, k.statusLine("Reading " + def.name + "…", {busy: true}));
      return;
    }

    const kind = spec.currentKind || "schematic";
    const tab = spec.tabbed ? (spec.activeTab || "overview") : "overview";

    // Optional strip tabs for Design B workspace inspector.
    if (spec.tabbed) {
      const strip = k.tabs([
        ["overview", "Overview"],
        ["symbol", "Symbol"],
        ["footprint", "Footprint"],
        ["pins", "Pins"],
        ["params", "Parameters"]
      ], {strip: true, value: tab, label: "Component inspector", onChange: next => spec.onTab?.(next)});
      host.append(strip);
    }

    const body = k.el("div", "lib-inspector-body");
    host.append(body);

    // Header: title + primary Place action + shared actionMenu (⋯).
    const head = k.el("div", "lib-detail-head");
    const title = k.el("div", "lib-detail-title");
    title.append(k.el("strong", null, def.name));
    const subParts = spec.lib
      ? [spec.lib.name, def.value, spec.family && (spec.family.name + " › " + spec.family.part)]
      : [def.prefix, def.value, spec.family && (spec.family.name + " › " + spec.family.part)];
    const sub = subParts.filter(Boolean).join(" · ");
    if (sub) title.append(k.el("small", null, sub));

    const acts = k.el("div", "lib-detail-actions");
    const canPlacePrimary = kind === "pcb" ? !!def.footprint : !!def.symbol;
    const placePrimaryKind = canPlacePrimary ? kind : (def.symbol ? "schematic" : "pcb");
    const placeBtn = k.button("Place", {
      variant: "primary",
      size: spec.tabbed ? undefined : "sm",
      disabled: !def.symbol && !def.footprint,
      title: placePrimaryKind === "pcb" ? "Place footprint on board" : "Place symbol on sheet",
      run: () => spec.actions?.place?.(placePrimaryKind)
    });
    if (!spec.tabbed) {
      acts.append(placeBtn);
      if (spec.lib && spec.actions?.addToProject) {
        acts.append(k.button("Add to project", {
          size: "sm",
          disabled: !!(spec.linked?.length),
          title: spec.linked?.length ? "Already in the project" : "Copy into this project's library",
          run: () => spec.actions.addToProject()
        }));
      }
    }
    const overflowCmds = buildOverflowCommands(spec);
    if (overflowCmds.length) {
      const more = k.iconButton("more", "More component actions", {size: spec.tabbed ? "md" : "sm"});
      globalThis.AtriumNavCommon?.actionMenu?.(more, overflowCmds);
      acts.append(more);
    }
    head.append(title, acts);
    body.append(head);

    if (spec.tabbed) {
      const placeRow = k.el("div", "lib-detail-place-row");
      placeRow.append(
        k.button("Place on sheet", {variant: kind === "schematic" ? "primary" : "secondary", disabled: !def.symbol, run: () => spec.actions?.place?.("schematic")}),
        k.button("Place on board", {variant: kind === "pcb" ? "primary" : "secondary", disabled: !def.footprint, run: () => spec.actions?.place?.("pcb")})
      );
      if (spec.lib && spec.actions?.addToProject) {
        placeRow.append(k.button("Add to project", {disabled: !!(spec.linked?.length), run: () => spec.actions.addToProject()}));
      }
      body.append(placeRow);
    }

    // Validation notices (errors/warnings via shared K.notice).
    const v = spec.validation;
    if (v?.errors?.length) {
      body.append(k.notice({tone: "danger", text: v.errors[0] + (v.errors.length > 1 ? " (+" + (v.errors.length - 1) + " more)" : "")}));
    } else if (v?.warnings?.length) {
      body.append(k.notice({tone: "warning", text: v.warnings[0] + (v.warnings.length > 1 ? " (+" + (v.warnings.length - 1) + " more)" : "")}));
    }

    if (tab === "overview") {
      globalThis.AtriumCatalogue?.preview?.(body, def, {title: false, params: false, pins: false});
      const pinCount = def.symbol?.pins?.length || 0;
      const secActions = !spec.tabbed && pinCount ? [k.button(spec.pinsOpen ? "Properties" : "Pins (" + pinCount + ")", {
        variant: "quiet", size: "sm", run: () => spec.onTogglePins?.()
      })] : [];
      if (!spec.tabbed && spec.pinsOpen && pinCount) {
        body.append(k.section("Pins", {quiet: true, actions: secActions}, buildPinsTable(def)));
      } else {
        const propRows = buildProperties(def, spec);
        body.append(k.section("Properties", {quiet: true, actions: secActions}, ...propRows));
      }
      if (spec.tabbed && v && (v.errors.length || v.warnings.length)) {
        const checkRows = [
          ...v.errors.map(msg => k.row({title: msg, icon: k.dot("danger"), role: "listitem"})),
          ...v.warnings.slice(0, 8).map(msg => k.row({title: msg, icon: k.dot("warning"), role: "listitem"}))
        ];
        body.append(k.section("Checks", {quiet: true, actions: [k.count(v.errors.length + v.warnings.length, {tone: v.errors.length ? "danger" : "warning"})]},
          k.list(checkRows, {role: "list", label: "Component checks"})));
      }
    } else if (tab === "symbol") {
      const box = k.el("div", "lib-single-preview");
      globalThis.AtriumCatalogue?.preview?.(box, def, {title: false, params: false, pins: false});
      box.dataset.only = "schematic";
      body.append(box);
      if (!spec.lib) {
        body.append(k.el("div", "lib-single-actions"));
        body.lastChild.append(k.button(def.symbol ? "Edit symbol" : "Create symbol", {run: () => spec.actions?.editSymbol?.()}));
      }
    } else if (tab === "footprint") {
      const box = k.el("div", "lib-single-preview");
      globalThis.AtriumCatalogue?.preview?.(box, def, {title: false, params: false, pins: false});
      box.dataset.only = "pcb";
      body.append(box);
      if (!spec.lib) {
        const row = k.el("div", "lib-single-actions");
        row.append(k.button(def.footprint ? "Edit footprint" : "Create footprint", {run: () => spec.actions?.editFootprint?.()}));
        if (def.footprint?.wizard) row.append(k.button("IPC wizard", {variant: "quiet", run: () => spec.actions?.openWizard?.()}));
        body.append(row);
      }
    } else if (tab === "pins") {
      body.append(buildPinsTable(def));
    } else if (tab === "params") {
      const propRows = buildProperties(def, spec);
      body.append(k.section("Parameters", {quiet: true}, ...propRows));
    }
  }

  return Object.freeze({render, buildPinsTable, buildProperties});
})();

// Docked Library tab (Design A), mounted inside AtriumDock's "library" tab.
// Built strictly from shared UI library primitives: AtriumUIKit, AtriumSelectPopup, AtriumNavCommon.actionMenu,
// AtriumLibraryRows, AtriumLibraryFacetsUI, and AtriumLibraryInspector.
globalThis.AtriumLibraryDockUI = (() => {
  const K = () => globalThis.AtriumUIKit;
  const ROWS = () => globalThis.AtriumLibraryRows;
  const FACETS = () => globalThis.AtriumLibraryFacetsUI;
  const INSP = () => globalThis.AtriumLibraryInspector;

  function G_openWorkspace(ctx, def, source) {
    const go = () => {
      if (def) globalThis.AtriumLibraryView?.reveal?.(def, source);
      else globalThis.AtriumLibraryView?.open?.({source: source?.id});
    };
    if (globalThis.AtriumLibraryView) { go(); return; }
    globalThis.AtriumLazy?.need?.("AtriumLibraryView").then(go, e => ctx?.info?.(e.message));
  }

  /** Review library updates for project defs: read each source entry, then AtriumLibraryDiff, while `current()` holds. */
  async function review(ctx, api, entries, {current, libs, done}) {
    if (!globalThis.AtriumLibraryDiff) { ctx.info?.("The library review is unavailable in this build."); return; }
    const p = ctx.currentProject ? ctx.currentProject() : ctx.project, rev = ctx.revision?.(), ready = [];
    const isCurrent = () => current() && rev === ctx.revision?.() && entries.every(e => {
      const live = libs().find(l => l.id === e.lib.id && l.kind === e.lib.kind);
      if (e.lib.kind === "group") return live?.revisionKeys?.get(e.src.id) === e.lib.revisionKeys?.get(e.src.id);
      return e.lib === live;
    });
    try {
      for (const e of entries) {
        if (!isCurrent()) return;
        const full = e.src.stub ? await globalThis.AtriumLibrarySources.load(e.lib, e.src.id) : e.src;
        if (!isCurrent()) return;
        if (!api.libraryStatus(e.def, [e.lib], p)?.same) ready.push({...e, src: full});
      }
      AtriumLibraryDiff.review(ctx, ready, {current: isCurrent, done});
    } catch (e) { if (current()) ctx.info?.(e.message); }
  }

  function mount(ctx, api) {
    const k = K(), el = k.el;
    const P = {ctx, node: null, selected: null, filter: "all", source: "project", pinsOpen: false, lastRevision: -1, lastLibrary: null};
    const host = document.getElementById("properties") || document.body;
    const node = el("section", "panel panel-library");
    node.setAttribute("aria-label", "Library");

    // Dock heading (.pane-heading is adopted by AtriumDock; hidden when the dock tab bar shows).
    const head = el("header", "pane-heading");
    head.append(el("h2", null, "Library"));
    const close = k.closeButton(() => api.togglePanel(P.ctx, false), "Close the Library panel");
    close.classList.add("lib-panel-close");
    head.append(close);

    // Source bar: pure-data source select + "+" Add library menu + open-tab button + "⋯" Library commands menu.
    const sourceBar = el("div", "lib-source-bar");
    const sourceSel = k.select([], {label: "Library source"});
    sourceSel.classList.add("lib-source");
    sourceSel.title = "Show this project's components or a library source";
    const addBtn = k.iconButton("plus", "Add library");
    const openTabBtn = k.iconButton("book", "Open full Library tab", {
      run: () => {
        const open = () => G_openWorkspace(P.ctx, P.selected ? (P.lib?.defs || project().library).find(d => d.id === P.selected) : null, P.lib);
        open();
      }
    });
    const moreBtn = k.iconButton("more", "Library commands");
    sourceBar.append(sourceSel, addBtn, openTabBtn, moreBtn);

    const selectSource = id => { if (id && P.source !== id) { P.source = id; P.selected = null; } render(); };
    globalThis.AtriumNavCommon?.actionMenu?.(addBtn, () => [
      {label: "Open library file…", run: () => api.openLibraryFile(P.ctx).then(lib => { if (lib) selectSource(lib.id); })},
      {label: "Add library folder…", run: () => api.folderUI(u => u.addFolder(P.ctx, {started: selectSource, done: () => render()}))},
      {label: "Import library files…", run: () => api.folderUI(u => u.importFiles(P.ctx, {started: selectSource, done: selectSource}))},
      {label: "Group library…", run: () => api.groupUI(u => u.dialog(P.ctx, P.lib?.kind === "group" ? P.lib.id : null, {onChoose: id => { if (id) selectSource(id); else render(); }}))},
      "-",
      {label: "Get KiCad libraries…", run: () => api.folderUI(u => u.getKiCad(P.ctx, {started: selectSource, done: () => render()}))},
      {label: "Library sources…", run: () => api.manageLibraries(P.ctx, () => render())}
    ]);
    globalThis.AtriumNavCommon?.actionMenu?.(moreBtn, () => [
      {label: "Open Library tab", run: () => P.ctx.act?.("library-workspace") || globalThis.AtriumNavHost?.act?.("library-workspace")},
      "-",
      // `action` shows the command's key from AtriumKeymap; `run` opens it with this panel's context.
      {label: "New symbol…", action: "symbol-editor", run: () => api.openSymbolEditor(P.ctx, null)},
      {label: "New footprint…", run: () => api.openFootprintEditor(P.ctx, null)},
      {label: "IPC footprint wizard…", action: "footprint-wizard", run: () => api.openWizard(P.ctx)},
      {label: "Symbol wizard…", run: () => globalThis.AtriumNavHost?.act?.("symbol-wizard")},
      "-",
      {label: "Manage families…", enabled: !P.lib, run: () => manageFamilies(P.source === "project" ? P.selected : null)},
      {label: "Check library…", run: () => api.checkLibrary(P.ctx, P.lib)},
      {label: "Catalogue…", run: () => P.ctx.showCatalogue ? P.ctx.showCatalogue() : P.ctx.info?.("The catalogue is unavailable here.")}
    ]);

    const noticeSlot = el("div", "lib-notice-slot");
    noticeSlot.hidden = true;

    const searchWrap = k.search({
      placeholder: "Search families, components, packages…",
      label: "Search the library",
      onInput: () => { cancelIntent(); P.selected = null; render(); }
    });
    const search = searchWrap.input;
    search.spellcheck = false;

    // Type filter chips + "Filters" popover trigger.
    const filterButtons = [];
    for (const [fk, label] of [["all", "All"], ["symbol", "Symbols"], ["footprint", "Footprints"], ["used", "Placed"], ["unused", "Unused"], ["issues", "Issues"]]) {
      const b = k.chip(label, {
        pressed: fk === P.filter,
        onToggle: () => { P.filter = fk; P.selected = null; render(); }
      });
      b.dataset.filter = fk;
      filterButtons.push(b);
    }
    const facetBtn = el("button", "ui-chip lib-facet-trigger");
    facetBtn.type = "button";
    facetBtn.setAttribute("aria-pressed", "false");
    facetBtn.setAttribute("aria-expanded", "false");
    facetBtn.append(k.icon("filter"), el("span", "ui-chip-label", "Filters"));
    const facetBadge = k.count(0, {tone: "accent"});
    facetBadge.hidden = true;
    facetBtn.append(facetBadge);
    facetBtn.addEventListener("click", () => {
      FACETS()?.togglePopover(facetBtn, {
        key: "panel",
        getCounts: () => P.lastCounts || {},
        onChange: () => { P.selected = null; render(); }
      });
    });
    const chips = k.chips([...filterButtons, facetBtn], "Filter components");

    const gateBar = el("div", "lib-gate");
    gateBar.hidden = true;

    // Vertical list-detail split using shared .ui-split[data-orientation=vertical] + K.splitter.
    const split = el("div", "ui-split lib-split");
    split.dataset.orientation = "vertical";
    const listWrap = el("div", "lib-list-pane pane-scroll");
    const list = k.list([], {role: "tree", label: "Library components"});
    list.classList.add("lib-list");
    list.tabIndex = 0;
    listWrap.append(list);

    let detailPct = 42;
    const splitter = k.splitter({
      orientation: "horizontal",
      label: "Resize component detail",
      onResize: delta => {
        const h = split.getBoundingClientRect().height || 400;
        detailPct = Math.max(20, Math.min(72, detailPct - (delta / h) * 100));
        split.style.setProperty("--ui-split-detail", detailPct.toFixed(1) + "%");
      }
    });
    const detail = el("div", "lib-detail pane-scroll");
    split.append(listWrap, splitter, detail);

    const body = el("div", "lib-panel-body");
    body.append(sourceBar, noticeSlot, searchWrap, chips, gateBar, split);
    node.append(head, body);

    const components = host.querySelector(".panel-components");
    if (components) components.after(node); else host.append(node);
    P.node = node;

    const project = () => P.ctx.currentProject ? P.ctx.currentProject() : P.ctx.project;
    const visible = () => node.isConnected && !node.hidden && document.visibilityState !== "hidden" &&
      globalThis.AtriumPower?.visible?.() !== false &&
      (node.checkVisibility?.() ?? (!node.closest("[hidden], .dock-inactive") && (node.getClientRects?.().length ?? 1) > 0));
    let checkTimer = 0, tick = 0, showing = false, needsRender = true, focusOnShow = false, intent = 0;

    function cancelIntent() { intent++; P.detailRead = null; P.detailBody = null; }
    function guard(lib, placement = false) {
      const token = intent, owner = project(), rev = P.ctx.revision?.(), nav = globalThis.AtriumNavHost;
      const doc = nav?.doc?.() || P.ctx.doc, selected = P.selected, source = P.source;
      const camera = () => JSON.stringify(nav?.view?.()?.camera?.());
      const before = placement && camera();
      return () => token === intent && visible() && project() === owner && P.source === source && P.selected === selected &&
        (!lib || P.lib === lib || source === "project") &&
        (lib?.kind !== "folder" || globalThis.AtriumLibrarySources?.library(lib.folder) === lib) &&
        (!placement || rev === P.ctx.revision?.() && doc === (nav?.doc?.() || P.ctx.doc) && before === camera());
    }

    function markSelected(row) {
      const selected = row.dataset.def === P.selected;
      row.setAttribute("aria-selected", String(selected));
      row.tabIndex = selected ? 0 : -1;
    }
    function select(id, row = null) {
      if (P.selected === id) return;
      const previous = list.querySelector('.lib-row[aria-selected="true"]');
      cancelIntent(); P.selected = id; P.pinsOpen = false;
      if (previous) markSelected(previous);
      if (row) markSelected(row);
      render(false);
    }

    const folderLibs = () => globalThis.AtriumLibrarySources?.libraries() || [];
    const libs = () => [...api.sourceStore.sources(), ...folderLibs(), ...(globalThis.AtriumGroupLocal?.libraries() || [])];

    function renderSources(listSources) {
      if (P.source !== "project" && !listSources.some(l => l.id === P.source)) {
        P.source = listSources.find(l => l.folder && l.folder === P.lib?.folder)?.id || "project";
      }
      const count = project().library.filter(d => !d.mirrorOf).length;
      const signature = JSON.stringify([count, ...listSources.map(l => [l.id, l.name, l.kind, l.defs.length, !!l.modified])]);
      if (P.sourceMenu === signature) { sourceSel.value = P.source; return; }
      P.sourceMenu = signature;
      sourceSel.replaceChildren(new Option("This project (" + count + ")", "project"));
      for (const l of listSources) {
        sourceSel.add(new Option(
          l.name + " (" + l.defs.length + ")" + (l.kind === "folder" ? " · folder" : l.kind === "group" ? " · group" : "") + (l.modified ? " •" : ""),
          l.id
        ));
      }
      sourceSel.value = P.source;
    }

    sourceSel.onchange = () => {
      cancelIntent();
      P.source = sourceSel.value;
      P.selected = null;
      render();
      if (P.lib?.unopened) api.folderUI(u => u.restore([P.lib.folder]));
    };

    const undo = () => globalThis.AtriumUndoStore;
    const versions = p => undo()?.documentVersions?.(p.documents[0], p);

    function placements(p, v) {
      const old = P.placements, U = undo();
      const reuse = old && old.project === p && v && old.v && v.floor === old.v.floor;
      if (reuse && v.assembly === old.v.assembly && v.library === old.v.library && v.project === old.v.project) {
        old.v = v; return old;
      }
      const byDoc = reuse ? old.byDoc : new Map(), direct = reuse ? old.direct : new Map();
      const bump = (id, n) => { if (id) direct.set(id, (direct.get(id) || 0) + n); };
      for (const doc of p.documents) {
        let parts = byDoc.get(doc);
        const diff = reuse && parts && U.recordedChanges(doc, old.v.seq);
        if (diff?.ids) {
          for (const id of diff.ids) {
            const before = parts.get(id), item = diff.items.get(id), after = item?.kind === "part" ? item.def : null;
            if (before === after) continue;
            if (before) { bump(before, -1); parts.delete(id); }
            if (after) { bump(after, 1); parts.set(id, after); }
          }
        } else {
          if (parts) for (const id of parts.values()) bump(id, -1);
          byDoc.set(doc, parts = new Map());
          for (const item of doc.items) if (item.kind === "part") { bump(item.def, 1); parts.set(item.id, item.def); }
        }
      }
      const counts = new Map(direct);
      for (const def of p.library) if (def.mirrorOf && direct.get(def.id)) counts.set(def.mirrorOf, (counts.get(def.mirrorOf) || 0) + direct.get(def.id));
      const used = new Set([...counts].filter(([, n]) => n).map(([id]) => id));
      for (const variant of Array.isArray(p.variants) ? p.variants : []) for (const value of Object.values(variant.parts || {})) if (value?.alternate?.def) used.add(value.alternate.def);
      return P.placements = {project: p, v, byDoc, direct, counts, used};
    }

    function filtered(owner, members) {
      const lib = owner.defs || owner.library, C = globalThis.AtriumCatalogue, fk = P.filter, p = project();
      const usedSourceIds = P.lib && (fk === "used" || fk === "unused")
        ? new Set(p.library.filter(d => api.sameLibrary(P.lib, d.libraryRef) && P.placements.used.has(d.id)).map(d => api.sourceEntry(P.lib, d.libraryRef)?.id || d.libraryRef.id))
        : null;
      const accept = ({
        symbol: d => !!d.symbol,
        footprint: d => !!d.footprint,
        used: d => usedSourceIds ? usedSourceIds.has(d.id) : P.placements.used.has(d.id),
        unused: d => usedSourceIds ? !usedSourceIds.has(d.id) : !P.placements.used.has(d.id),
        issues: d => { if (d.stub) return false; const v = api.cachedValidate(d); return !v.ok || v.warnings.length; }
      })[fk];
      let res;
      if (C && owner.search) {
        const st = C.state("panel");
        res = C.queryPrepared(lib, owner.search, search.value, {accept, state: st.facets, limit: 400, counts: true});
      } else {
        let defs = C ? lib : search.value.trim() ? api.search(lib, search.value) : lib.filter(d => !d.mirrorOf);
        if (accept) defs = defs.filter(accept);
        if (!C) {
          globalThis.AtriumLazy?.need("AtriumCatalogue").then(() => { if (!node.hidden && node.isConnected) render(); }, () => {});
          return {items: members?.size ? [] : defs, matching: members?.size ? 0 : defs.length, counts: {}};
        }
        const placed = P.placements.used;
        res = C.query(defs, search.value, {ids: new Set(lib.map(d => d.id)), keep: d => !P.lib && placed.has(d.id), state: C.state("panel").facets, members});
      }
      P.lastCounts = res.counts || {};
      const activeFacets = FACETS()?.activeCount("panel") || 0;
      facetBtn.setAttribute("aria-pressed", String(activeFacets > 0));
      facetBadge.textContent = String(activeFacets);
      facetBadge.hidden = !activeFacets;
      return {items: res.items, matching: res.matching ?? res.items.length};
    }

    function statusOf(def) {
      if (!def.libraryRef || !P.libraries) return null;
      const version = undo()?.definitionVersion?.(def);
      const lib = P.libraries.find(l => l.id === def.libraryRef.library && (!def.libraryRef.groupRevision || l.kind === "group"));
      const source = lib ? api.sourceEntry(lib, def.libraryRef) : null;
      const key = lib?.kind === "group" ? lib.revisionKeys.get(def.libraryRef.id) : source;
      const cache = P.statusCache ||= new WeakMap(), old = cache.get(def);
      if (old && old.version === version && old.key === key && old.lib === lib && (lib || old.registry === P.libraries)) return old.result;
      const s = api.libraryStatus(def, P.libraries, project());
      const result = !s || s.pending || s.state === "current" ? null : s.missing ? {state: "missing", ref: def.libraryRef} : s;
      cache.set(def, {version, lib, key, registry: P.libraries, result});
      return result;
    }

    function buildRow(original, variant, depth = 0) {
      const def = P.shown.get(original.id) || original;
      const used = P.lib ? 0 : P.placements.counts.get(def.id) || 0;
      const version = undo()?.definitionVersion?.(def);
      const state = P.lib ? null : statusOf(def);
      const status = state ? api.stateText(state) : "";
      const errors = !def.stub && (def.footprint || def.symbol) ? api.cachedValidate(def).errors.length : 0;
      const prior = P.rows.get(def.id);
      if (prior && prior.def === def && prior.version === version && prior.used === used && prior.status === status && prior.errors === errors && prior.depth === depth) {
        markSelected(prior.node);
        return prior.node;
      }
      const r = ROWS().componentRow({
        def,
        facts: api.facts(def),
        used,
        issues: errors,
        status: state,
        statusMark: state ? api.STATE_MARK[state.state] : null,
        statusTone: state ? api.STATE_TONE[state.state] : null,
        statusText: status,
        variant,
        depth,
        selected: def.id === P.selected,
        onSelect: (d, nodeRow) => select(d.id, nodeRow),
        onActivate: d => placeEntry(P.lib, d),
        onPointerDown: (e, d, nodeRow) => ROWS().startDragPlace(e, {
          def: d, lib: P.lib, row: nodeRow,
          onSelect: (dd, rr) => select(dd.id, rr),
          placeEntry, currentKind, info: m => P.ctx.info?.(m)
        }),
        onDragStart: (e, d, nodeRow) => {
          const lib = P.lib, drop = globalThis.AtriumDropEditor;
          drop?.offer(e, {kind: "library-part", id: d.id}, lib ? async signal => {
            const full = d.stub ? await globalThis.AtriumLibrarySources.load(lib, d.id) : d;
            return signal.aborted ? null : {lib, def: full};
          } : null);
          e.dataTransfer.effectAllowed = "copy";
          select(d.id, nodeRow);
        }
      });
      P.rows.set(def.id, {node: r, def, version, status, used, errors, variant, depth});
      return r;
    }

    function renderNotice() {
      const focusStop = noticeSlot.contains(document.activeElement) && document.activeElement?.tagName === "BUTTON";
      noticeSlot.replaceChildren();
      noticeSlot.hidden = true;
      if (P.lib) {
        if (P.lib.kind === "folder") globalThis.AtriumLibrarySourcesUI?.sourceNotice(noticeSlot, P.lib, focusStop);
        return;
      }
      const due = project().library.filter(d => !d.mirrorOf && ["update", "diverged"].includes(statusOf(d)?.state));
      if (!due.length) return;
      noticeSlot.hidden = false;
      noticeSlot.append(k.notice({
        tone: "warning",
        live: true,
        text: due.length + " component" + (due.length === 1 ? " has a library update" : "s have library updates"),
        actions: [k.button("Review…", {size: "sm", run: () => reviewUpdates(due.map(d => { const s = statusOf(d); return {def: d, lib: s.lib, src: s.src}; }))})]
      }));
    }

    function render(full = true) {
      if (!visible()) { needsRender = true; return; }
      const p = project();
      if (full || needsRender) {
        if (P.lastProject !== p) { cancelIntent(); P.lastProject = p; P.selected = null; }
        needsRender = false; P.lastRevision = P.ctx.revision?.() ?? 0; P.lastLibrary = p.library;
        P.versions = versions(p); P.familyVersion = undo()?.familyVersion?.(); placements(p, P.versions);
        const sources = libs();
        if (!P.libraries || sources.length !== P.libraries.length || sources.some((s, i) => s !== P.libraries[i])) P.libraries = sources;
        renderSources(P.libraries);
        P.lib = P.source === "project" ? null : P.libraries.find(l => l.id === P.source) || null;
        const owner = P.lib || p;
        P.members = owner.search?.members || globalThis.AtriumComponentFamilies?.memberships(owner);
        for (const b of filterButtons) b.setAttribute("aria-pressed", String(b.dataset.filter === P.filter));
        const {items: defs, matching} = filtered(owner, P.members);
        searchWrap.setCount(matching ? String(matching) : (search.value.trim() ? "0" : ""));
        const shown = defs.slice(0, 400);
        if (P.selected && !shown.some(d => d.id === P.selected)) P.selected = null;
        const C = globalThis.AtriumCatalogue;
        const treeKey = JSON.stringify([P.source, !!C, !!search.value.trim(), matching, shown.map(d => {
          const m = P.members?.get(d.id), rec = C?.record(d);
          return [d.id, rec?.group, rec?.cat, m?.id, m?.name, m?.part, m ? d.footprint?.name : null];
        })]);
        P.shown = new Map(shown.map(d => [d.id, d]));
        if (P.treeKey === treeKey && P.treeProject === p) {
          for (const [id, prior] of P.rows) {
            const targetDef = P.shown.get(id);
            if (!targetDef) continue;
            const next = buildRow(targetDef, prior.variant, prior.depth);
            if (next !== prior.node) {
              const focused = document.activeElement === prior.node;
              prior.node.replaceWith(next);
              if (focused) next.focus({preventScroll: true});
            }
          }
        } else {
          const choice = [P.source, P.filter, search.value].join("\0");
          const motion = P.treeProject === p && P.treeChoice === choice && !P.lib?.scan && !search.value.trim()
            ? globalThis.AtriumSpatialMotion : null;
          const rebuild = () => {
            P.treeKey = treeKey; P.treeProject = p; P.rows = new Map(); list.replaceChildren();
            if (shown.length) {
              ROWS().componentTree(list, shown, buildRow, {
                key: "panel", scope: p, source: P.source, owner, members: P.members,
                reveal: P.selected, open: !!search.value.trim(), onGroup: () => select(null)
              });
            }
            if (matching > 400) {
              list.append(k.statusLine((matching - 400) + " more — refine search or open the full Library tab."));
            }
            if (!defs.length) {
              const hasAny = (P.lib?.defs || p.library).length > 0;
              const clearAction = hasAny && (search.value.trim() || P.filter !== "all" || FACETS()?.activeCount("panel"))
                ? [k.button("Clear filters", {variant: "quiet", size: "sm", run: () => {
                    search.value = ""; P.filter = "all"; globalThis.AtriumCatalogue?.clearFacets?.("panel"); render();
                  }})]
                : [];
              list.append(k.empty({
                text: P.lib?.scan ? "More components will appear as indexing continues." :
                  !C && P.members?.size ? "Loading component library…" :
                  hasAny ? "No matching components." : "The library is empty.",
                actions: clearAction
              }));
            }
          };
          if (motion) motion.layout(list, ".lib-row[data-def]", r => r.dataset.def, rebuild); else rebuild();
          P.treeChoice = choice;
        }
        renderNotice();
      }
      P.lastSel = (P.ctx.selection?.() || []).join(",");
      renderDetail();
      renderGate();
    }

    function renderDetail() {
      const p = project(), kind = currentKind();
      if (P.lib) {
        const lib = P.lib;
        const rowDef = P.selected && api.sourceEntry(lib, {id: P.selected});
        const def = P.detailBody?.row === rowDef && P.detailBody.lib === lib ? P.detailBody.def : rowDef;
        if (!def) {
          INSP().render(detail, {
            def: null,
            emptyText: "Select a library component to add it to the project or place it.",
            beforeEmpty: hostNode => {
              const title = el("div", "lib-detail-title");
              title.append(el("strong", null, lib.name), el("small", null, (lib.kind === "group" ? "Local group copy" : lib.path || "library file") + " · " + lib.defs.length + " components"));
              hostNode.append(title);
              if (lib.kind === "group") {
                hostNode.append(k.button("Group library…", {size: "sm", run: () => api.groupUI(u => u.dialog(P.ctx, lib.id))}));
              }
              if (lib.kind === "folder") api.folderUI(u => u.folderDetail(P.ctx, hostNode, lib, {done: () => render()}));
            }
          });
          return;
        }
        if (def.stub) {
          INSP().render(detail, {def, lib});
          if (P.detailRead?.row !== rowDef || P.detailRead.lib !== lib) {
            const current = guard(lib), request = P.detailRead = {row: rowDef, lib};
            globalThis.AtriumLibrarySources.load(lib, def.id).then(full => {
              if (P.detailRead !== request || !current()) return;
              P.detailRead = null; P.detailBody = {row: rowDef, lib, def: full}; renderDetail();
            }, e => {
              if (P.detailRead !== request || !current()) return;
              P.detailRead = null; detail.replaceChildren(k.notice({tone: "danger", text: e.message}));
            });
          }
          return;
        }
        const linked = p.library.filter(d => api.linksEntry(lib, d.libraryRef, def.id));
        let sourceDiffCount = 0;
        if (linked[0]) {
          const changes = api.diffDefs(linked[0], def);
          if (!changes.length && !api.libraryStatus(linked[0], [lib], p)?.same) changes.push("Component metadata changed");
          sourceDiffCount = changes.length;
        }
        INSP().render(detail, {
          def, lib, project: p, facts: api.facts(def), family: P.members?.get(def.id),
          linked, sourceDiffCount, currentKind: kind,
          pinsOpen: P.pinsOpen, onTogglePins: () => { P.pinsOpen = !P.pinsOpen; renderDetail(); },
          actions: {
            place: knd => placeFromSource(lib, def, knd),
            addToProject: () => ensureFromSource(lib, def),
            reviewUpdate: () => reviewUpdates([{def: linked[0], lib, src: def}])
          }
        });
        return;
      }

      const def = p.library.find(d => d.id === P.selected) || null;
      if (!def) {
        INSP().render(detail, {def: null});
        return;
      }
      const status = api.libraryStatus(def, P.libraries, p);
      const older = api.similar(p, def);
      INSP().render(detail, {
        def, project: p, facts: api.facts(def), used: api.usage(p, def.id),
        validation: api.cachedValidate(def), family: P.members?.get(def.id),
        status, statusText: status && !status.pending ? api.stateText(status.missing ? {state: "missing", ref: def.libraryRef} : status) : null,
        statusTone: status ? api.STATE_TONE[status.state] : null,
        currentKind: kind,
        pinsOpen: P.pinsOpen, onTogglePins: () => { P.pinsOpen = !P.pinsOpen; renderDetail(); },
        onReviewUpdate: status?.src && !status.same ? () => reviewUpdates([{def, lib: status.lib, src: status.src}]) : null,
        actions: {
          place: knd => place(def, knd),
          editSymbol: () => editSelected(def.id, "schematic"),
          editFootprint: () => editSelected(def.id, "pcb"),
          openWizard: () => api.openWizard(P.ctx, def),
          attachPackage: globalThis.AtriumLibraryFamiliesUI ? variant => {
            const live = project().library.find(d => d.id === def.id);
            if (live) AtriumLibraryFamiliesUI.attach(P.ctx, live, {variant, done: id => { P.selected = id; render(); }});
          } : null,
          manageFamily: globalThis.AtriumLibraryFamiliesUI ? () => manageFamilies(def.id) : null,
          duplicate: () => run(() => { const c = api.duplicate(project(), def); P.selected = c.id; }, "Duplicated " + def.name),
          updateParts: () => {
            const go = ids => run(() => {
              const r = api.updateParts(project(), def, {sources: ids});
              P.ctx.info?.("Updated " + r.parts + " part(s): " + r.retargeted + " retargeted, " + r.rewired + " wire end(s) followed moved pins, " + (r.stubs ? r.stubs + " stub(s) kept connections, " : "") +
                r.dropped + " stale pin net(s) cleared" + (r.disconnected.length ? " · ⚠ now unconnected: " + r.disconnected.slice(0, 8).join(", ") : "") + ".");
            }, null);
            if (!older.length) { go([]); return; }
            api.chooseCopies(def, older, go);
          },
          reviewUpdate: () => status?.src && reviewUpdates([{def, lib: status.lib, src: status.src}]),
          saveToLibrary: () => api.saveToLibraryDialog(P.ctx, def, () => render()),
          saveToFolder: (globalThis.AtriumHost?.chooseLibraryFolder || globalThis.showDirectoryPicker)
            ? () => api.folderUI(u => u.saveToFolder(P.ctx, def, () => render())) : null,
          remove: () => {
            try { run(() => api.remove(project(), def.id), def.name + " deleted"); P.selected = null; }
            catch (e) { P.ctx.info?.(e.message); }
          }
        }
      });
    }

    function renderGate() {
      gateBar.replaceChildren(); gateBar.hidden = true;
      const ids = P.ctx.selection?.() || [];
      if (ids.length !== 1) return;
      const p = project();
      let item = null;
      for (const d of p.documents) { item = d.items.find(i => i.id === ids[0]); if (item) break; }
      const def = item?.kind === "part" && p.library.find(d => d.id === item.def);
      const sym = def?.symbol;
      if (!sym || !((sym.parts || 1) > 1 || sym.alternate)) return;
      gateBar.hidden = false;
      gateBar.append(el("span", null, item.ref + " gate"));
      for (let g = 1; g <= (sym.parts || 1); g++) {
        gateBar.append(k.chip(String.fromCharCode(64 + g), {
          pressed: (item.unit || item.part || 1) === g,
          onToggle: () => run(() => { item.unit = g; delete item.part; }, item.ref + " now shows gate " + String.fromCharCode(64 + g))
        }));
      }
      if (sym.alternate) {
        gateBar.append(k.chip("De Morgan", {
          pressed: !!item.alt,
          onToggle: () => run(() => { item.alt = !item.alt; if (!item.alt) delete item.alt; }, null)
        }));
      }
    }

    function reviewUpdates(entries) { return review(P.ctx, api, entries, {current: guard(null), libs, done: () => render()}); }

    function run(fn, message) { try { P.ctx.edit(fn); if (message) P.ctx.info?.(message); render(); } catch (e) { P.ctx.info?.(e.message); } }
    const kindFor = def => currentKind() === "pcb" && def.footprint ? "pcb" : def.symbol ? "schematic" : "pcb";
    function placeEntry(lib, def, kind = kindFor(def)) { if (lib) placeFromSource(lib, def, kind); else place(def, kind); }
    function place(def, kind) { ROWS().place(P.ctx, def, kind); }
    function editSelected(id, kind) {
      const def = project().library.find(d => d.id === id);
      if (def && !P.lib) (kind === "pcb" || (!kind && !def.symbol && def.footprint) ? api.openFootprintEditor : api.openSymbolEditor)(P.ctx, def);
    }
    function manageFamilies(initial) {
      globalThis.AtriumLibraryFamiliesUI?.manage(P.ctx, {initial, done: id => { P.selected = id; render(); }});
    }
    function ensureFromSource(lib, def) {
      if (def.stub) {
        const current = guard(lib, true);
        globalThis.AtriumLibrarySources.load(lib, def.id).then(full => { if (current()) ensureFromSource(lib, full); }, e => { if (current()) P.ctx.info?.(e.message); });
        return null;
      }
      const p = project(), linked = p.library.find(d => api.linksEntry(lib, d.libraryRef, def.id));
      if (linked) return linked;
      let exact;
      run(() => { exact = api.addFromLibrary(lib, def, p); }, def.name + " added to the project from " + lib.name);
      return exact;
    }
    function placeFromSource(lib, def, kind) {
      if (def.stub) {
        const current = guard(lib, true);
        globalThis.AtriumLibrarySources.load(lib, def.id).then(full => { if (current()) placeFromSource(lib, full, kind); }, e => { if (current()) P.ctx.info?.(e.message); });
        return;
      }
      if (!Atrium.geometries(def, kind)) return;
      const exact = ensureFromSource(lib, def);
      if (exact) place(exact, kind);
    }

    const documentKind = () => P.ctx.documentKind?.() || P.ctx.doc?.kind || "schematic";
    const currentKind = () => documentKind() === "pcb" ? "pcb" : "schematic";
    let hintsKind;
    function updateToolHints() {
      hintsKind = documentKind();
      api.ui.shortcut(close, "Close the Library panel", AtriumKeymap.hintKey("library-panel", hintsKind), " from the design canvas");
    }
    const offKeys = AtriumKeymap.onChange(() => { if (visible()) updateToolHints(); });

    // Keyboard navigation & actions
    node.addEventListener("keydown", e => {
      if (e.key === "Escape" && !FACETS()?.isOpen()) { cancelIntent(); select(null); return; }
      // Tab hops between a selected package row and the first detail action.
      if (e.key !== "Tab" || e.metaKey || e.ctrlKey || e.altKey) return;
      const first = detail.querySelector(".lib-detail-actions button:not(:disabled)");
      const selected = ROWS().visibleRows(list).find(r => r.dataset.def === P.selected && r.closest(".cat-family-packages"));
      if (!first || !selected) return;
      const [from, to] = e.shiftKey ? [first, selected] : [selected, first];
      if (e.target === from) { e.preventDefault(); to.focus(); }
    });
    list.addEventListener("keydown", e => {
      if (ROWS().handleTreeKey(e, list, {
        onSelectRow: row => select(row.dataset.def, row),
        onTopEscape: () => search.focus()
      })) return;
      if (e.target !== list && !e.target.matches(".lib-row")) return;
      const id = e.target.dataset.def || P.selected;
      if (!id) return;
      // The list itself acts on the selection only while its row is visible (not in a collapsed branch).
      if (e.target === list && !ROWS().visibleRows(list).some(r => r.dataset.def === id)) return;
      if (P.lib) {
        if (e.key === "Enter") { e.preventDefault(); const d = P.lib.defs.find(def => def.id === id); if (d) placeFromSource(P.lib, d, currentKind()); }
        else if (e.key === "Delete" || e.key === "Backspace" || e.key === "e" || e.key === "E") {
          e.preventDefault(); P.ctx.info?.("Library entries are read-only here. Add the component to the project to edit it.");
        }
        return;
      }
      const def = project().library.find(d => d.id === id);
      if (!def) return;
      if (e.key === "Enter") { e.preventDefault(); place(def, currentKind()); }
      else if (e.key === "e" || e.key === "E") { e.preventDefault(); editSelected(id, e.shiftKey ? "pcb" : "schematic"); }
      else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") { e.preventDefault(); run(() => { P.selected = api.duplicate(project(), def).id; }, "Duplicated " + def.name); }
      else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        try { run(() => api.remove(project(), def.id), def.name + " deleted"); P.selected = null; }
        catch (err) { P.ctx.info?.(err.message); }
      }
    });
    search.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const first = ROWS().visibleRows(list)[0];
        if (first) { if (first.matches(".lib-row")) select(first.dataset.def, first); first.focus(); }
      }
    });

    function check(forceHints = false) {
      checkTimer = 0;
      if (!visible()) return;
      const rev = P.ctx.revision?.() ?? 0, p = project(), lib = p.library;
      const sel = (P.ctx.selection?.() || []).join(",");
      const contextChanged = hintsKind !== documentKind();
      if (forceHints || contextChanged) updateToolHints();
      const prev = P.versions, v = versions(p);
      const sameScope = prev && v && prev.floor === v.floor && prev.library === v.library && prev.assembly === v.assembly &&
        prev.project === v.project && P.familyVersion === undo()?.familyVersion?.();
      if (needsRender || p !== P.lastProject || lib !== P.lastLibrary || rev !== P.lastRevision && !sameScope) render();
      else {
        P.lastRevision = rev;
        if (v) P.versions = v;
        if (contextChanged) renderDetail();
        if (sel !== P.lastSel) { P.lastSel = sel; renderGate(); }
      }
    }
    function scheduleCheck() { if (showing && !node.hidden && !checkTimer) checkTimer = setTimeout(check, 0); }
    const N = globalThis.AtriumNavHost;
    const offs = typeof N?.on === "function" ? ["change", "document", "selection"].map(t => N.on(t, scheduleCheck)) : null;

    function stop() {
      cancelIntent();
      FACETS()?.close();
      if (globalThis.AtriumCatalogue?.cancelPreview(detail)) needsRender = true;
      clearTimeout(checkTimer); checkTimer = 0;
      clearInterval(tick); tick = 0;
    }
    function visibilityChanged() {
      if (!node.isConnected) { dispose(); return; }
      const on = visible();
      if (on && !P.groupRestored) { P.groupRestored = true; api.restoreGroups(); }
      if (on !== showing) {
        showing = on;
        if (!on) { stop(); return; }
        api.folderUI(u => {
          if (!visible()) return;
          render();
          u.restore(P.lib?.folder ? [P.lib.folder] : project().library.map(d => d.libraryRef?.library).filter(Boolean));
        }, true);
        check(true);
        if (!offs) tick = setInterval(check, 500);
      }
      if (on && focusOnShow) { focusOnShow = false; search.focus(); }
    }

    const resize = globalThis.ResizeObserver && new ResizeObserver(visibilityChanged);
    resize?.observe(node);
    const offPower = globalThis.AtriumPower?.onChange?.(visibilityChanged);
    document.addEventListener("visibilitychange", visibilityChanged);
    const sourceStorage = e => { if (e.key === api.SOURCES || e.key == null) render(); };
    globalThis.addEventListener?.("storage", sourceStorage);

    function dispose() {
      stop();
      resize?.disconnect(); offPower?.(); offKeys(); offs?.forEach(off => off?.()); P.folderSub?.(); P.groupSub?.();
      document.removeEventListener("visibilitychange", visibilityChanged);
      globalThis.removeEventListener?.("storage", sourceStorage);
    }

    P.reveal = (def, source) => {
      const {lib} = ROWS().revealSource("panel", def, source, {project: project(), libs: libs(), api});
      cancelIntent();
      P.source = lib?.id || "project"; P.filter = "all"; search.value = def.name || def.id;
      render(); select(def.id);
      list.querySelector('[aria-selected="true"]')?.scrollIntoView?.({block: "nearest"});
    };
    P.render = render; P.search = search; P.dispose = dispose;
    P.folderProgress = id => { if (P.lib?.folder === id && visible()) renderNotice(); };
    P.toggled = open => { focusOnShow = open; visibilityChanged(); };
    P.focusSearch = () => { focusOnShow = true; visibilityChanged(); if (document.activeElement === search) search.select?.(); };
    api.mounted?.(P);
    visibilityChanged();
    return P;
  }

  return Object.freeze({mount, review});
})();
