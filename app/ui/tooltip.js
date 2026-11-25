"use strict";
// One native-top-layer tooltip serves late menus, dialogs, disabled controls and canvas cards.
globalThis.AtriumTooltip = (() => {
  const G = globalThis, doc = G.document;
  if (!doc?.body) return;
  const canvasHover = G.AtriumCanvasHover;
  const attributes = ["title", "data-tooltip", "data-tooltip-label", "data-tooltip-shortcut", "data-tooltip-shortcut-suffix", "disabled", "aria-disabled"];
  const selector = "[title], [data-tooltip], [data-tooltip-label]";
  const labels = new WeakMap(), descriptions = new WeakMap();
  const interactive = "button, a[href], input, select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=img], img";
  const disabled = ":disabled, [aria-disabled=true]", lettering = /[\p{L}\p{N}]/u;
  const halo = 8, slop = 4;
  let box, trigger, visible, timer, warmUntil = 0, touch, spatial;
  const remaining = (event,ms) => Math.max(0,ms-Math.max(0,performance.now()-event.timeStamp));
  const motion = () => G.AtriumMotion?.ui || G.AtriumMotionUI;
  const canFade = (source,fx) => source === "hover" && fx.hover("pointer");

  function manage(element) {
    if (!element?.hasAttribute || element.localName === "title") return;
    if (element.hasAttribute("title")) {
      const title = element.getAttribute("title");
      if (title) element.setAttribute("data-tooltip", title);
      else element.removeAttribute("data-tooltip");
      element.removeAttribute("title");
    }
    const text = label(element), previous = labels.get(element);
    if (previous && element.getAttribute("aria-label") === previous) {
      if (text) element.setAttribute("aria-label", text);
      else element.removeAttribute("aria-label");
      labels.delete(element);
      if (text) labels.set(element, text);
    } else if (text && element.matches(interactive) && !element.hasAttribute("aria-label") &&
      !element.hasAttribute("aria-labelledby") && !element.labels?.length && !lettering.test(element.textContent) &&
      !element.getAttribute("alt") && !element.querySelector("svg > title, img[alt]")) {
      element.setAttribute("aria-label", text);
      labels.set(element, text);
    }
    const priorDescription = descriptions.get(element), unavailable = element.matches(disabled);
    if (!priorDescription && !unavailable) return;
    const description = element.getAttribute("aria-description");
    if (description && description !== priorDescription) return;
    const name = element.getAttribute("aria-label") || element.textContent.trim();
    if (unavailable && name && text && name !== text) {
      if (description !== text) element.setAttribute("aria-description",text);
      descriptions.set(element,text);
    } else if (priorDescription) {
      if (description === priorDescription) element.removeAttribute("aria-description");
      descriptions.delete(element);
    }
  }
  function label(element) {
    return element.getAttribute("data-tooltip-label") || element.getAttribute("data-tooltip") || "";
  }
  function hasVisibleLabel(element) {
    const control = element.closest(interactive + ", [role=menuitemcheckbox], [role=menuitemradio], [role=treeitem], [role=option]");
    if (!control) return false;
    const labels = doc.createTreeWalker(control,NodeFilter.SHOW_TEXT);
    const range = doc.createRange();
    let visible = false;
    for (let node = labels.nextNode(); node; node = labels.nextNode()) {
      const parent = node.parentElement, word = node.textContent.trim();
      if (!lettering.test(word) || parent.closest("svg, .ui-shortcut, .visually-hidden, .sr-only, [hidden]") ||
          getComputedStyle(parent).visibility !== "visible") continue;
      range.selectNodeContents(node);
      const boxes = [...range.getClientRects()].filter(rect=>rect.width && rect.height);
      if (!boxes.length) continue;
      for (let clip = parent; control.contains(clip); clip = clip.parentElement) {
        if (getComputedStyle(clip).overflowX === "visible" || !clip.clientWidth) continue;
        const bounds = clip.getBoundingClientRect(), left = bounds.left+clip.clientLeft, right = left+clip.clientWidth;
        if (boxes.some(rect=>rect.left < left-1 || rect.right > right+1)) return false;
      }
      visible = true;
    }
    return visible;
  }
  function anchor(element) {
    return element?.closest?.(selector);
  }
  function scan(root) {
    if (root?.nodeType !== 1) return;
    if (root.matches(selector)) manage(root);
    for (const element of root.querySelectorAll(selector)) manage(element);
  }
  function describe(element, add) {
    if (!element) return;
    const ids = (element.getAttribute("aria-describedby") || "").split(/\s+/).filter(id => id && id !== box.id);
    if (add) ids.push(box.id);
    if (ids.length) element.setAttribute("aria-describedby", ids.join(" "));
    else element.removeAttribute("aria-describedby");
  }
  function ensureBox() {
    if (box) return box;
    box = doc.createElement("div");
    box.id = "waffle-tooltip";
    box.className = "ui-tooltip";
    box.setAttribute("role", "tooltip");
    box.hidden = true;
    if (typeof box.showPopover === "function") box.popover = "manual";
    doc.body.append(box);
    return box;
  }
  function conceal() {
    if (visible || !box) return;
    if (box.popover === "manual" && box.matches(":popover-open")) box.hidePopover();
    box.hidden = true;
    canvasHover.release("object");
  }
  function hide(instant = false) {
    clearTimeout(timer);
    trigger = null;
    const last = visible;
    if (!last && !instant) return;
    visible = null;
    if (last?.element) {
      describe(last.element, false);
      warmUntil = performance.now() + 1000;
    }
    const fx = motion();
    if (fx && last && !instant && canFade(last.source,fx)) {
      const to = {opacity:0};
      if (last.offset && fx.moves("pointer")) to.transform = last.offset;
      fx.exit(box,{to,duration:last.card ? 100 : 80,intent:"pointer",done:conceal});
    } else {
      if (box) fx?.cancel(box);
      conceal();
    }
  }
  function position(bounds, width, height, clear) {
    const viewport = G.visualViewport;
    // The top edge stays below the macOS title bar (--window-caption-height).
    const x = viewport?.offsetLeft || 0, y = (viewport?.offsetTop || 0) + (parseFloat(getComputedStyle(doc.documentElement).getPropertyValue("--window-caption-height")) || 0);
    const right = x + (viewport?.width || G.innerWidth), bottom = y + (viewport?.height || G.innerHeight);
    return canvasHover.firstFit(bounds, width, height, {
      left: x + halo, top: y + halo, right: right - halo, bottom: bottom - halo
    }, {
      gap: halo,
      order: ["bottom", "top", "right", "left"],
      rtl: doc.documentElement.dir === "rtl",
      clear
    });
  }
  function contents(element, card) {
    box.replaceChildren();
    if (card) {
      const title = doc.createElement("strong"), detail = doc.createElement("div");
      title.textContent = card.label;
      detail.className = "ui-tooltip-detail";
      detail.textContent = card.detail;
      box.append(title);
      if (card.detail) box.append(detail);
      return;
    }
    box.append(label(element));
    const binding = element.getAttribute("data-tooltip-shortcut");
    const key = binding && G.AtriumShortcut?.render(binding,{variant:"keycap"});
    if (key) box.append(" ", key);
    const suffix = element.getAttribute("data-tooltip-shortcut-suffix");
    if (suffix) box.append(suffix);
  }
  function show(element, card, source) {
    if (!card && (!element?.isConnected || !label(element) || hasVisibleLabel(element))) {
      if (element && visible?.element === element) hide(true);
      return false;
    }
    ensureBox();
    if (!card) canvasHover.release("object");
    const refresh = element && visible?.element === element;
    if (visible?.element && visible.element !== element) describe(visible.element, false);
    const moving = motion();
    box.lang = doc.documentElement.lang;
    box.classList.toggle("is-card", !!card);
    box.hidden = false;
    if (box.popover === "manual" && !box.matches(":popover-open")) box.showPopover();
    else if (box.popover !== "manual") {
      const layer = element?.closest("dialog[open]") || doc.body;
      if (box.parentElement !== layer) layer.append(box);
    }
    contents(element, card);
    const bounds = card?.bounds || element.getBoundingClientRect();
    const place = (bounds.width || bounds.height || card) && position(bounds,box.offsetWidth,box.offsetHeight,card?.clear);
    if (!place) {
      moving?.cancel(box);
      if (box.popover === "manual" && box.matches(":popover-open")) box.hidePopover();
      box.hidden = true;
      if (visible?.element) describe(visible.element, false);
      visible = null;
      return false;
    }
    box.style.left = place.left + "px";
    box.style.top = place.top + "px";
    if (element && (element.hasAttribute("data-tooltip-shortcut") ||
      label(element) !== element.getAttribute("aria-label") && label(element) !== element.textContent.trim())) describe(element, true);
    const offset = card && {bottom:"translateY(2px)", top:"translateY(-2px)", right:"translateX(2px)", left:"translateX(-2px)"}[place.side];
    visible = {element, card, source, offset};
    if (!refresh && moving) {
      if (canFade(source,moving)) {
        const from = {opacity:0};
        if (offset && moving.moves("pointer")) from.transform = offset;
        moving.enter(box,{from,duration:card ? 150 : 125,intent:"pointer"});
      } else moving.cancel(box);
    }
    return true;
  }
  function queue(element, delay, source) {
    if (element === trigger || visible?.element === element) return;
    hide(source === "keyboard");
    if (!element) return;
    manage(element);
    trigger = element;
    if (delay <= 0) show(element,null,source);
    else timer = setTimeout(() => show(element,null,source), delay);
  }
  function stopSpatial(instant = false) {
    canvasHover.cancel("object");
    spatial = null;
    if (visible?.card || instant && box?.classList.contains("is-card") && !box.hidden) hide(instant);
  }
  function hoverCard(canvas,x,y) {
    const nav = G.AtriumNavHost;
    if (!nav?.allowsHover(canvas)) return;
    const hit = nav.hit(canvas,x,y);
    if (!hit?.item || !canvasHover.preferred("object",canvas,x,y,hit)) return;
    const {doc:design,item,point,pane:{view}} = hit;
    const A = G.Atrium, defs = nav.defs(), board = design.kind === "pcb", origin = canvas.getBoundingClientRect();
    const nets = board ? null : A.sheetNets(nav.project(),design,defs,nav);
    const netFor = row => board ? row.net : nets?.byWire.get(row.id) || (row.kind === "netlabel" ? row.text : "");
    const pinNet = (row,pin) => board ? row.pinNets?.[pin.number] ?? pin.net : nets?.byPin.get(row.id+"/"+pin.number);
    const definition = item.kind === "part" ? defs.get(item.def) : null;
    let pin, distance = Infinity;
    if (definition) for (const candidate of A.pins(item,definition,design.kind)) {
      if (candidate.hidden) continue;
      const d = Math.hypot(candidate.at[0]-point[0],candidate.at[1]-point[1]);
      if (d > Math.max(candidate.w || 0,candidate.h || 0)/2 + 5/view.scale() || d >= distance) continue;
      pin = candidate; distance = d;
    }
    const net = netFor(item) || (pin && pinNet(item,pin));
    const rawKind = {part:"Component",pad:"Pad",via:"Via",wire:"Wire",track:"Track",netlabel:"Net label",zone:"Copper area"}[item.kind] ||
      item.kind.replace(/^./,letter=>letter.toUpperCase());
    const kind = G.AtriumI18n?.text?.(rawKind) || rawKind;
    const label = item.ref || item.text || net || kind;
    const detail = [item.ref && (item.value || definition?.name), pin && (pin.name || pin.number),
      item.layer && board && G.AtriumPCBAppearance.name(item.layer),
      net && net !== label && net].filter(Boolean).join(" · ");
    // A card that would only repeat text already drawn in full (a note, a text frame, a label) adds
    // nothing: no card. A minimized note hides its text, so it keeps one.
    if (!detail && !item.ref && typeof item.text === "string" && label === item.text && !minimized(design,item)) return;
    const corners = ([l,t,r,b]) => [[l,t],[r,t],[r,b],[l,b]];
    const itemBox = row => G.AtriumCanvas.schematicArtwork.box(row,design,defs);
    const screen = world => A.bounds(corners(world).map(point => {
      const [sx,sy] = view.worldToScreen(point); return [origin.left+sx,origin.top+sy];
    }));
    const world = itemBox(item);
    if (!world) return;
    const [left,top,right,bottom] = anchorBox(screen(anchorWorld(item,design,defs) || world),origin,x,y);
    function clear(rect) {
      if (!net) return true;
      const area = [rect.left-3,rect.top-3,rect.right+3,rect.bottom+3];
      const query = A.bounds(corners(area).map(([sx,sy]) => view.screenToWorld([sx-origin.left,sy-origin.top])));
      function overlaps(object) {
        const [l,t,r,b] = screen(object);
        return l<area[2] && r>area[0] && t<area[3] && b>area[1];
      }
      for (const row of view.query(design,defs,query)) {
        if (row === item) continue;
        const sameNet = netFor(row) === net || row.kind === "part" &&
          A.pins(row,defs.get(row.def),design.kind).some(pin=>!pin.hidden && pinNet(row,pin) === net);
        if (!sameNet) continue;
        if ((row.kind === "wire" || row.kind === "track") && row.points?.length > 1) {
          const pad = Math.max(.13,(row.width || 0)/2);
          if (row.points.some(([a,b],i) => {
            if (!i) return false;
            const [x,y] = row.points[i-1];
            return overlaps([Math.min(x,a)-pad,Math.min(y,b)-pad,Math.max(x,a)+pad,Math.max(y,b)+pad]);
          })) return false;
        } else {
          const obstacle = anchorWorld(row,design,defs) || itemBox(row);
          if (obstacle && overlaps(obstacle)) return false;
        }
      }
      return true;
    }
    return {label,detail,bounds:{left,top,right,bottom},clear};
  }
  function minimized(design, item) {
    try { return !!G.AtriumMarkup?.kind?.(item) && !!G.AtriumMarkup.localView?.(design)?.minimized?.has?.(item.id); } catch { return false; }
  }
  // The painted box (canvas.js objectBox) is deliberately generous for redraw invalidation: text
  // halos and pin-name discs can make it many times the object's size, which put cards far from the
  // pointer. Anchor on the object's own geometry instead.
  function anchorWorld(item, design, defs) {
    const A = G.Atrium, look = G.AtriumSchAppearance;
    try {
      if (design.kind !== "pcb" && (item.kind === "netlabel" || item.kind === "label") && look?.labelBox)
        return look.labelBox(look.displayItem?.(design,item) || item);
      const b = A.bounds(A.itemPoints(item,defs.get(item.def),design.kind));
      return b && (b[2] > b[0] || b[3] > b[1]) ? b : null;
    } catch { return null; }
  }
  // Keep the anchor on the visible canvas and next to the pointer. An object larger than the card's
  // reach (a big part at high zoom), or geometry that does not contain the pointer, anchors on the
  // pointer itself, so a card never appears away from what is under it.
  function anchorBox([l,t,r,b], origin, x, y) {
    const reach = 24, pointer = [x-12,y-12,x+12,y+12];
    l = Math.max(l-2,origin.left); t = Math.max(t-2,origin.top); r = Math.min(r+2,origin.right); b = Math.min(b+2,origin.bottom);
    if (!(r > l && b > t) || r-l > 320 || b-t > 200) return pointer;
    if (x < l-reach || x > r+reach || y < t-reach || y > b+reach) return pointer;
    return [l,t,r,b];
  }
  function spatialAt(event) {
    const nav = G.AtriumNavHost;
    if (!event.target.matches?.(".split-pane > canvas") || !nav?.allowsHover || event.buttons) {
      stopSpatial();
      return;
    }
    const canvas = event.target, x = event.clientX, y = event.clientY;
    if (spatial?.canvas === canvas && Math.hypot(spatial.x-x,spatial.y-y) <= slop) return;
    stopSpatial();
    spatial = {canvas,x,y};
    canvasHover.queue("object",canvas,remaining(event,300),spatial,() => {
      const card = hoverCard(canvas,x,y);
      if (card) canvasHover.show("object",canvas,() => show(null,card,"hover"));
    });
  }
  canvasHover.register("object", {
    hide() { if (box?.classList.contains("is-card")) hide(true); },
    reset(reason) { if (reason !== "frame") spatial = null; }
  });

  function pointerOver(event) {
    if (event.pointerType === "touch" || event.buttons) return;
    const element = anchor(event.target);
    if (element) {
      stopSpatial();
      queue(element,performance.now() < warmUntil || visible?.element ? 0 : remaining(event,500),"hover");
    } else if (trigger) hide();
    if (!element) spatialAt(event);
  }
  doc.addEventListener("pointerover", pointerOver, true);
  doc.addEventListener("pointerout", event => {
    if (event.pointerType === "touch") return;
    if (trigger && anchor(event.target) === trigger && !trigger.contains(event.relatedTarget)) {
      const next = anchor(event.relatedTarget);
      if (!next) hide();
    }
    if (spatial?.canvas === event.target && event.relatedTarget !== event.target) stopSpatial();
  }, true);
  function focusIn(event) {
    if (event.target.matches?.(":focus-visible")) queue(anchor(event.target),performance.now() < warmUntil ? 0 : remaining(event,500),"keyboard");
  }
  doc.addEventListener("focusin", focusIn);
  doc.addEventListener("focusout", event => {
    if (trigger?.contains(event.target) && !trigger.contains(event.relatedTarget)) hide(true);
  });
  doc.addEventListener("pointermove", event => {
    if (event.pointerType === "touch") {
      if (touch && !touch.shown && Math.hypot(touch.x-event.clientX,touch.y-event.clientY)>slop) cancelTouch();
      return;
    }
    if (spatial || event.target.tagName === "CANVAS") spatialAt(event);
  }, {capture:true,passive:true});

  function cancelTouch() {
    if (touch) clearTimeout(touch.timer);
    touch = null;
  }
  function pointerDown(event) {
    cancelTouch();
    stopSpatial();
    hide();
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const element = anchor(event.target);
    if (!element || element.matches("input, textarea, select, [contenteditable], [data-tool-group]") ||
        hasVisibleLabel(element)) return;
    manage(element);
    touch = {x:event.clientX,y:event.clientY,pointer:event.pointerId,element,timer:setTimeout(() => {
      trigger = element;
      touch.shown = show(element,null,"touch");
    },remaining(event,500))};
  }
  doc.addEventListener("pointerdown", pointerDown, true);
  doc.addEventListener("pointerup", event => {
    if (!touch || touch.pointer !== event.pointerId) return;
    if (touch.shown) {
      clearTimeout(touch.timer);
      touch.timer = setTimeout(() => {cancelTouch(); hide();},1600);
    } else cancelTouch();
  }, true);
  doc.addEventListener("contextmenu", event => {
    if (touch?.element.contains(event.target)) event.preventDefault();
    else { stopSpatial(); hide(); }
  }, true);
  doc.addEventListener("click", event => {
    if (touch?.shown && touch.element.contains(event.target)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);
  function dismiss() { stopSpatial(true); cancelTouch(); hide(true); }
  doc.addEventListener("pointercancel", dismiss, true);
  doc.addEventListener("visibilitychange", dismiss);
  doc.addEventListener("scroll", dismiss, {capture:true,passive:true});
  doc.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      if (visible) {
        event.preventDefault();
        event.stopPropagation();
      }
      dismiss();
    } else if (spatial) stopSpatial(true);
  }, true);
  G.addEventListener("resize", dismiss, {passive:true});
  G.addEventListener("blur", dismiss);
  G.visualViewport?.addEventListener("resize", dismiss, {passive:true});
  G.visualViewport?.addEventListener("scroll", dismiss, {passive:true});
  doc.addEventListener("wheel", dismiss, {capture:true,passive:true});
  scan(doc.body);
  new MutationObserver(records => {
    let changed = false;
    for (const record of records) {
      if (record.type === "attributes") {
        if ((record.attributeName === "disabled" || record.attributeName === "aria-disabled") && !record.target.matches(selector)) continue;
        if (record.target.hasAttribute("title") || record.attributeName !== "title") manage(record.target);
        if (visible?.element === record.target && record.attributeName !== "title") changed = true;
      } else {
        for (const element of record.addedNodes) scan(element);
      }
    }
    if (trigger && !trigger.isConnected) hide();
    else if (changed && visible?.element) {
      if (label(visible.element)) show(visible.element,null,visible.source);
      else hide();
    }
  }).observe(doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:attributes});
  function begin(event) {
    if (event.type === "focusin") {
      if (doc.activeElement === event.target) focusIn(event);
    } else if (event.target.contains(doc.elementFromPoint(event.clientX,event.clientY))) {
      if (event.type === "pointerover") pointerOver(event);
      else if (event.type === "pointerdown") pointerDown(event);
    }
  }
  return Object.freeze({dismiss, begin});
})();
