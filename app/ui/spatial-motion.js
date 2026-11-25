"use strict";
// UI relayouts use visible, keyed elements. Scrolling, cursor motion and the
// canvas input pipeline do not enter this module.
globalThis.AtriumSpatialMotion = (() => {
  const M = () => globalThis.AtriumMotionUI;
  const TABS = ":scope > .document-tab[data-tab]", ALL_TABS = ":scope > .document-tab";
  const DOCUMENT = "application/x-atrium-document";
  const TAB_SCALE = "scaleX(.97)", ROW_TRAVEL = "translateY(12%)";
  const bound = new WeakSet(), departures = new WeakMap();
  let drag = null;

  const items = (container, selector) => [...container.querySelectorAll(selector)].filter(el => !el.hidden);
  const visible = (rect, clip) => rect.width > 0 && rect.height > 0 &&
    rect.right > clip.left && rect.bottom > clip.top && rect.left < clip.right && rect.top < clip.bottom;

  function copyVisual(row, rect, opacity, parent, table) {
    const copy = row.cloneNode(true);
    for (const node of [copy,...copy.querySelectorAll("[id]")]) node.removeAttribute("id");
    copy.removeAttribute("hidden");
    let ghost = copy;
    if (table) {
      ghost = table.cloneNode(false);
      ghost.removeAttribute("id");
      const columns = table.querySelector(":scope > colgroup");
      if (columns) ghost.append(columns.cloneNode(true));
      ghost.createTBody().append(copy);
    }
    ghost.inert = true;
    ghost.setAttribute("aria-hidden", "true");
    ghost.classList.add("ui-spatial-ghost");
    Object.assign(ghost.style, {
      left:rect.left + "px", top:rect.top + "px", width:rect.width + "px", height:rect.height + "px", opacity
    });
    parent.append(ghost);
    return ghost;
  }

  function layout(container, selector, key, mutate, {tabs = false, viewport = container, intent} = {}) {
    const m = M();
    if (!m?.enabled(intent) || !container?.isConnected || !container.getClientRects().length) return mutate();
    const moves = m.moves(intent);
    const clip = viewport.getBoundingClientRect(), measure = new Map();
    const table = container.matches("tbody") ? container.closest("table") : null;
    const ghostParent = tabs ? container.ownerDocument.body : table?.parentElement || container.parentElement;
    const styleOf = el => el.ownerDocument.defaultView.getComputedStyle(el);
    let leaving = departures.get(container);
    let staggered = 0;
    const timing = (duration, curve, continuing = false) => ({
      duration, curve, intent, delay:tabs || continuing ? 0 : Math.min(staggered++,3) * 30
    });
    for (const el of items(container, selector)) {
      const rect = el.getBoundingClientRect();
      if (!visible(rect, clip)) continue;
      const style = styleOf(el);
      measure.set(key(el), {el, rect, opacity:style.opacity, continuing:style.opacity !== "1" || style.transform !== "none"});
    }
    const result = mutate();
    for (const el of items(container, selector)) {
      const id = key(el), ghost = leaving?.get(id);
      let prior = measure.get(id);
      measure.delete(id);
      if (ghost) {
        prior = {el, rect:ghost.getBoundingClientRect(), opacity:styleOf(ghost).opacity, continuing:true};
        m.cancel(ghost);
        ghost.remove();
        leaving.delete(id);
      }
      if (prior && prior.el !== el) m.cancel(prior.el);
      m.cancel(el);
      const now = el.getBoundingClientRect();
      if (!visible(now, clip)) continue;
      if (!prior) {
        const from = moves ? {opacity:0,transform:tabs ? TAB_SCALE : ROW_TRAVEL} : {opacity:0};
        m.enter(el, {from,...timing(tabs ? 150 : 180,"decelerate")});
        continue;
      }
      const dx = (prior.rect.left + prior.rect.right - now.left - now.right) / 2;
      const dy = (prior.rect.top + prior.rect.bottom - now.top - now.bottom) / 2;
      const sx = prior.rect.width / now.width, sy = prior.rect.height / now.height;
      const from = {};
      if (moves && (dx || dy || Math.abs(sx - 1) > .001 || Math.abs(sy - 1) > .001)) {
        from.transform = "translate(" + dx + "px," + dy + "px) scale(" + sx + "," + sy + ")";
      }
      if (prior.opacity !== styleOf(el).opacity) from.opacity = prior.opacity;
      if (Object.keys(from).length) m.enter(el, {
        from,...timing(ghost && tabs ? 150 : 180,tabs && !ghost ? "standard" : "decelerate",prior.continuing)
      });
    }
    for (const [id,{el,rect,opacity,continuing}] of measure) {
      m.cancel(el);
      if (Number(opacity) === 0) continue;
      const ghost = copyVisual(el, rect, opacity, ghostParent, table);
      if (!leaving) { leaving = new Map(); departures.set(container, leaving); }
      leaving.set(id, ghost);
      const to = moves ? {transform:tabs ? TAB_SCALE : ROW_TRAVEL,opacity:0} : {opacity:0};
      m.exit(ghost, {to,...timing(tabs ? 150 : 180,"accelerate",continuing),done:() => {
          ghost.remove();
          if (leaving.get(id) === ghost) leaving.delete(id);
        }});
    }
    return result;
  }

  function lift(el) {
    if (!M()?.moves("pointer")) return;
    el.classList.add("ui-drag-lift");
    M().enter(el, {from:{transform:"scale(1)"},duration:120,curve:"decelerate",intent:"pointer"});
  }

  function settle(el) {
    if (!el.classList.contains("ui-drag-lift")) return;
    const m = M(), from = el.ownerDocument.defaultView.getComputedStyle(el).transform;
    m?.cancel(el);
    el.classList.remove("ui-drag-lift");
    if (el.isConnected && m?.moves("pointer")) m.enter(el, {from:{transform:from},duration:200,curve:"decelerate",intent:"pointer"});
  }

  function target(element, on, className = "is-drop") {
    if (!element) return;
    if (on && element.matches(".split-pane") && !element.querySelector(":scope > .ui-drop-layer")) {
      const layer = element.ownerDocument.createElement("div");
      layer.className = "ui-drop-layer";
      layer.setAttribute("aria-hidden", "true");
      element.append(layer);
    }
    element.classList.toggle(className, on);
  }

  function clear(options = {}) {
    if (!drag) return;
    const {strip, source, original, stop} = drag;
    drag = null;
    stop();
    target(strip, false, "ui-tab-drop");
    if (!options.commit && source.parentElement === strip) {
      const next = original?.parentElement === strip ? original : null;
      if (source.nextElementSibling !== next) {
        M().flip(items(strip,ALL_TABS), () => {
          source.classList.remove("ui-drag-lift");
          strip.insertBefore(source,next);
        }, {duration:200,curve:"decelerate",intent:"pointer"});
        return;
      }
    }
    settle(source);
  }

  function owns(e) { return [...(e.dataTransfer?.types || [])].includes(drag.type); }

  function tabs(strip, commit) {
    if (bound.has(strip)) return;
    bound.add(strip);
    strip.addEventListener("dragstart", e => {
      const source = e.target.closest?.(".document-tab:is([data-tab],[data-view])");
      if (!source || source.parentElement !== strip || !e.dataTransfer) return;
      clear();
      const doc = strip.ownerDocument;
      const session = {strip, source, original:source.nextElementSibling, order:items(strip,ALL_TABS),
        type:source.dataset.view ? "application/x-atrium-document-view" : DOCUMENT,
        stop:() => doc.removeEventListener("drop", afterDrop, true)};
      // A native drop runs microtasks between capture and the destination handler.
      // Let that handler consume the preview before cleaning up an external drop.
      const afterDrop = () => setTimeout(() => { if (drag === session) clear(); }, 0);
      drag = session;
      doc.addEventListener("drop",afterDrop,true);
      lift(source);
    });
    strip.addEventListener("dragover", e => {
      if (!drag || drag.strip !== strip || !owns(e)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      target(strip, true, "ui-tab-drop");
      const to = e.target.closest?.(".document-tab:is([data-tab],[data-view])");
      if (!to || to.parentElement !== strip || to === drag.source) return;
      // Swap only once the pointer would land on the dragged tab afterwards: with tabs of different
      // widths a midpoint test swaps back on the next dragover, and the strip flips on every event.
      const rect = to.getBoundingClientRect(), width = drag.source.getBoundingClientRect().width;
      const after = !!(drag.source.compareDocumentPosition(to) & 4); // Node.DOCUMENT_POSITION_FOLLOWING
      if (after ? e.clientX < rect.right - width : e.clientX >= rect.left + width) return;
      const destination = after ? to.nextElementSibling : to;
      if (destination === drag.source || destination === drag.source.nextElementSibling) return;
      const reorder = () => strip.insertBefore(drag.source, destination);
      if (M()?.moves("pointer")) M().flip(items(strip,ALL_TABS).filter(n => n !== drag.source), reorder, {duration:180,intent:"pointer"});
      else reorder();
    });
    strip.addEventListener("dragleave", e => {
      if (!strip.contains(e.relatedTarget)) target(strip,false,"ui-tab-drop");
    });
    strip.addEventListener("drop", e => {
      if (!drag || drag.strip !== strip || !owns(e)) return;
      e.preventDefault();
      e.stopPropagation();
      const ordered = items(strip,ALL_TABS);
      const changed = ordered.some((tab,index) => tab !== drag.order[index]);
      clear({commit:true});
      if (changed) commit(ordered.flatMap(tab => tab.dataset.tab ? [tab.dataset.tab] : []));
    });
    strip.addEventListener("dragend", () => { if (drag?.strip === strip) clear(); });
  }

  function tabLayout(strip, mutate, views = true) {
    return layout(strip, views ? ALL_TABS : TABS, el => el.dataset.tab || "view:" + el.dataset.view, mutate, {tabs:true});
  }
  const dragOrder = strip => drag?.strip === strip ? items(strip,TABS).map(n => n.dataset.tab) : null;
  return Object.freeze({layout, tabLayout, lift, settle, target, tabs, dragOrder});
})();
