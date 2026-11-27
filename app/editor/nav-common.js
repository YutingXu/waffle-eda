"use strict";
// Shared editor navigation, geometry and windowed-list controls.
globalThis.AtriumNavCommon = (() => {
  const A = () => globalThis.Atrium;
  const hasDOM = () => typeof document !== "undefined" && !!document.createElement;

  // DOM
  function elementIn(doc, tag, text, cls, classFirst = false) {
    const node = doc.createElement(tag);
    if (classFirst && cls) node.className = cls;
    if (text != null) node.textContent = text;
    if (!classFirst && cls) node.className = cls;
    return node;
  }
  const el = (tag, text, cls) => elementIn(document, tag, text, cls);
  const classedElement = (doc, tag, cls, text) => elementIn(doc, tag, text, cls, true);
  function elWithAttributes(tag, text, cls, attrs, {omitNull = false} = {}) {
    const node = el(tag, text, cls);
    for (const [name, value] of Object.entries(attrs || {}))
      if (!omitNull || value != null) node.setAttribute(name, value);
    return node;
  }
  // Property rows (ui-library.md): read-only text, a switch, a unit inside a field.
  function appendPropertyRow(parent, label, value, control = el("span", value, "ui-prop-value ui-selectable")) { const row = el("div", null, "ui-prop-row"); if (value != null) row.title = value; row.append(elWithAttributes("span", label, null, {title: label}), control); parent.append(row); return row; }
  function appendSwitchRow(parent, label, checked, update, name = label) {
    const l = el("label", null, "ui-switch-row"), box = elWithAttributes("input", null, "ui-switch", {type: "checkbox", role: "switch", "aria-label": name});
    box.checked = checked; box.onchange = () => update(box.checked, box); l.append(box); appendPropertyRow(parent, label, null, l); return box;
  }
  const measure = (input, unit) => { const m = el("span", null, "ui-field-measure"); m.append(input, el("span", unit, "ui-field-unit")); return m; };
  // The icon bank in index.html owns the geometry. The enclosing control owns the label.
  function icon(name) {
    const ns = "http://www.w3.org/2000/svg", svg = document.createElementNS(ns, "svg"), use = document.createElementNS(ns, "use");
    svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
    if (name) use.setAttribute("href", "#i-" + name);
    svg.append(use);
    return svg;
  }
  function button(text, fn, cls, title, ariaLabel) {
    const b = el("button", text, cls); b.type = "button"; if (fn) b.onclick = fn;
    if (title) {b.title = title; if (ariaLabel || !text) b.setAttribute("aria-label", ariaLabel || title);}
    return b;
  }
  function actionButton(text, fn, cls, title) {
    const b = button(text, fn, cls, title);
    return globalThis.AtriumUI?.button(b, "secondary") ?? b;
  }
  const isMac = () => /Mac|iPhone|iPad/i.test(globalThis.navigator?.platform || "");
  function shortcutTitle(node, label, binding, suffix = "") {
    const K = globalThis.AtriumKeymap;
    const spoken = K?.display(binding, true);
    if (!binding) suffix = "";
    if (!globalThis.AtriumTooltip) {
      const visual = K?.display(binding), title = label + (visual ? " (" + visual + ")" + suffix : "");
      if (node.title !== title) node.title = title;
    }
    for (const [attr, value] of [["data-tooltip-label", label], ["data-tooltip-shortcut", binding], ["data-tooltip-shortcut-suffix", suffix]]) {
      if (value && node.getAttribute(attr) !== value) node.setAttribute(attr, value);
      else if (!value && node.hasAttribute(attr)) node.removeAttribute(attr);
    }
    if (spoken) {
      const description = spoken + suffix;
      if (node.getAttribute("aria-description") !== description) node.setAttribute("aria-description", description);
    } else if (node.hasAttribute("aria-description")) node.removeAttribute("aria-description");
  }
  function shortcutBadge(container, binding, variant = "inline") {
    const current = container.querySelector(":scope > .ui-shortcut");
    if (!binding) {current?.remove(); return;}
    if (current?.dataset.binding === binding && current.dataset.variant === variant) return;
    const badge = AtriumShortcut.render(binding, {variant, node:current ?? undefined});
    badge.dataset.binding = binding;
    if (!current) container.append(badge);
  }
  // Translate the sentence with named placeholders before inserting rendered keys.
  function shortcutParts(sentence, bindings) {
    return sentence.split(/(\{\w+\})/).flatMap(part => {
      if (!part.startsWith("{") || !Object.hasOwn(bindings, part.slice(1, -1))) return part;
      const keys = [].concat(bindings[part.slice(1, -1)]);
      return keys.flatMap((key, i) => [...(i ? [" / "] : []), AtriumShortcut.render(key, {variant:"inline"})]);
    });
  }
  function paletteInstance(host,docId) {
    const occ = globalThis.AtriumConnectionPreview?.location()?.occurrence;
    return host?.instanceId?.() || (occ?.docId === docId ? occ?.instanceId : undefined);
  }
  const notebookEnabled = () => globalThis.AtriumLabs?.notebookEnabled() === true;
  let paletteTemplate;
  globalThis.AtriumLabs?.onChange?.(() => {
    const old = hasDOM() && document.getElementById("palette");
    if (!old || !paletteTemplate) return;
    const trigger = old.paletteRequest?.previous;
    globalThis.AtriumPalette?.resetMode?.();
    old.paletteRequest = null;
    if (old.open) old.close();
    if (old.fitPaletteViewport) {
      globalThis.visualViewport?.removeEventListener("resize",old.fitPaletteViewport);
      globalThis.visualViewport?.removeEventListener("scroll",old.fitPaletteViewport);
    }
    old.replaceWith(paletteTemplate.cloneNode(true));
    if (trigger?.isConnected && document.activeElement === document.body) trigger.focus({preventScroll:true});
  });
  // Capture placement before the dialog takes focus.
  function openPalette(entrance = "", continuation = null, at = {}) {
    const enhanced = notebookEnabled();
    const insert = entrance === "insert" || entrance === "/";
    if (!enhanced && (insert || at.entryKey)) return null;
    const d = document.getElementById("palette"), input = d.querySelector("[role=combobox]");
    paletteTemplate ??= d.cloneNode(true);
    const h = globalThis.AtriumNavHost, previous = d.open ? d.paletteRequest?.previous : at.trigger || document.activeElement;
    const target = at.target || at.canvas || previous;
    const surface = target?.closest?.("dialog")?.paletteSurface || null;
    const point = at.point || at.world || surface?.point?.() || h?.palettePoint?.() || h?.pointer?.();
    const docId = at.docId || h?.currentId?.(), instanceId = at.instanceId || paletteInstance(h,docId);
    const request = {enhanced, entrance, continuation, previous, surface, target, entryKey:at.entryKey, source:at.source, docId, instanceId, point:point && [...point], pointerType:at.pointerType || "keyboard", selection:h?.selection?.() || [], tool:h?.tool?.()};
    d.paletteRequest = request;
    const entryMode = insert ? "insert" : entrance === ">" || entrance === "command" ? "command" : "search";
    d.dataset.mode = entryMode;
    d.toggleAttribute("data-palette-commands",entryMode === "command");
    // Scoped entrances (find, files): index.html names the chips.
    const chip = d.querySelector(".nav-palette-scope-chip"), scoped = chip.dataset[entrance], name = scoped || chip.dataset.commands;
    if (scoped) d.dataset.paletteScope = entrance; else delete d.dataset.paletteScope;
    chip.firstElementChild.textContent = name; chip.ariaLabel = "Remove " + name + " scope";
    const v = globalThis.visualViewport;
    if (v && !d.fitPaletteViewport) {
      d.fitPaletteViewport = e => {
        if (e && !d.open) return;
        for (const [key, value] of [["x",v.offsetLeft],["y",v.offsetTop],["w",v.width],["h",v.height]]) d.style.setProperty("--palette-" + key, value + "px");
        d.toggleAttribute("data-palette-short",v.height < 415);
        d.toggleAttribute("data-palette-stacked",v.width <= 660);
      };
      v.addEventListener("resize",d.fitPaletteViewport);
      v.addEventListener("scroll",d.fitPaletteViewport);
    }
    d.fitPaletteViewport?.();
    input.value = insert || scoped || entryMode === "command" ? "" : entrance;
    if (!d.open) d.showModal();
    else input.focus({preventScroll:true});
    input.setSelectionRange(input.value.length, input.value.length);
    const begin = P => {if (d.open && d.paletteRequest === request) P.resume(d, request);};
    const P = globalThis.AtriumPalette;
    if (P) begin(P);
    else {
      const earlyScope = entryMode === "command" || scoped ? new AbortController() : null;
      if (earlyScope) {
        const clear = event => {
          if (!d.open || d.paletteRequest !== request || !d.hasAttribute("data-palette-commands") && !d.dataset.paletteScope) return;
          if (event.type === "keydown" && (event.key !== "Backspace" || event.isComposing || input.value)) return;
          event.preventDefault();
          d.removeAttribute("data-palette-commands"); delete d.dataset.paletteScope; request.continuation = null;
          input.focus({preventScroll:true});
        };
        const options = {signal:earlyScope.signal};
        input.addEventListener("keydown", event => {
          if (d.open && d.paletteRequest === request && request.continuation?.(event, rec => {
            d.close();
            globalThis.AtriumKeymap.invoke(rec, (a, p) => h?.executeKey?.(a, p));
          })) event.stopPropagation();
          else clear(event);
        }, options);
        d.querySelector(".nav-palette-scope-chip").addEventListener("click", clear, options);
      }
      globalThis.AtriumLazy.need("AtriumPalette").then(P => {
        earlyScope?.abort(); begin(P);
      }, error => {
        earlyScope?.abort();
        if (d.open && d.paletteRequest === request) {d.close(); h?.info?.(error.message);}
      });
    }
    return d;
  }
  function openPaletteAction(action, continuation, at) {
    const entrance = globalThis.AtriumKeymap?.command?.(action)?.palette;
    if (entrance === undefined) return false;
    if (globalThis.AtriumLabs?.allowsAction(action) !== false) openPalette(entrance,continuation,at);
    return true;
  }
  if (hasDOM()) {
    document.addEventListener("click", e => {
      const button = e.target.closest?.(".palette-insert-launch");
      if (!button || !notebookEnabled()) return;
      const h = globalThis.AtriumNavHost, surface = button.closest("dialog")?.paletteSurface;
      const canvas = surface?.canvas || h?.canvas?.(), rect = canvas?.getBoundingClientRect();
      const point = e.detail && rect ? surface ? surface.toWorld(e.clientX,e.clientY) : h.view().screenToWorld([e.clientX-rect.left,e.clientY-rect.top]) : null;
      openPaletteAction("insert-palette",null,{target:button,trigger:button,point,pointerType:e.pointerType || (e.detail ? "mouse" : "keyboard"),source:"button"});
    });
    document.addEventListener("waffle-insert-request", e => {
      if (e.defaultPrevented || !notebookEnabled()) return;
      e.preventDefault(); openPaletteAction("insert-palette", null, {...e.detail, target:e.target});
    });
  }

  // geometry
  // World bounds of one object; parts include their footprint or symbol.
  function itemBox(doc, defs, item) {
    if (!item) return null;
    try {return A().bounds(A().itemPoints(item, defs?.get?.(item.def), doc.kind));} catch {return null;}
  }
  function union(a, b) {return !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];}
  function grow(b, d) {return b && [b[0] - d, b[1] - d, b[2] + d, b[3] + d];}
  const overlaps = (a, b) => !!a && !!b && a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
  const inside = (p, b) => !!p && !!b && p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
  // Limit the zoom for a single pad or pin.
  function cameraFor(box, w, h, cam, {margin = .3, maxFactor = 24, minScale = null} = {}) {
    const bw = Math.max(.5, box[2] - box[0]), bh = Math.max(.5, box[3] - box[1]);
    const ref = cam?.referenceScale || cam?.scale || 8;
    let scale = Math.min(w * (1 - margin) / bw, h * (1 - margin) / bh);
    scale = Math.min(scale, ref * maxFactor);
    if (minScale != null) scale = Math.max(scale, minScale);
    return {cx:(box[0] + box[2]) / 2, cy:(box[1] + box[3]) / 2, scale, referenceScale:ref};
  }

  // toast
  // A brief, polite notice above the status bar. One at a time; it never takes focus.
  let toastNode = null, toastTimer = null;
  function toast(text, {kind = "info", ms = 2600} = {}) {
    if (!hasDOM() || !document.body) return null;
    if (!toastNode) {
      toastNode = el("div", null, "ui-toast"); toastNode.setAttribute("role", "status"); toastNode.setAttribute("aria-live", "polite");
      document.body.append(toastNode);
    }
    toastNode.textContent = text; toastNode.dataset.kind = kind; toastNode.hidden = false;
    toastNode.classList.add("is-shown");
    toastTimer?.cancel();
    const expire = () => { toastNode.classList.remove("is-shown"); toastNode.hidden = true; toastTimer = null; };
    if (globalThis.AtriumMotion?.afterVisible) toastTimer = AtriumMotion.afterVisible(ms, expire);
    else { const timer = setTimeout(expire, ms); toastTimer = {cancel: () => clearTimeout(timer)}; }
    return toastNode;
  }

  // host
  // The editor publishes AtriumNavHost (see the integration patch). Modules call
  // ready(fn) and run once it exists, whatever the script order.
  const waiting = [];
  function ready(fn) {
    if (globalThis.AtriumNavHost) {try {fn(globalThis.AtriumNavHost);} catch (e) {globalThis.console?.error?.(e);} return;}
    waiting.push(fn);
  }
  function hostReady(host) {while (waiting.length) {const fn = waiting.shift(); try {fn(host);} catch (e) {globalThis.console?.error?.(e);}}}

  // Install menu items once into an existing menu (by data-menu), after an anchor action if given.
  function menuItem(menu, action, text, {after = null, scope = null, separator = false, checkable = false} = {}) {
    if (!hasDOM()) return null;
    const list = document.querySelector('.work-menu[data-menu="' + menu + '"] .menu-items');
    if (!list || list.querySelector('[data-action="' + action + '"]')) return list?.querySelector('[data-action="' + action + '"]') || null;
    const b = el("button", globalThis.AtriumI18n?.text?.(text, "menu") ?? text); b.type = "button"; b.setAttribute("role", "menuitem"); b.dataset.action = action; // i18n: menu label
    if (scope) b.dataset.scope = scope;
    if (checkable) b.dataset.checkable = "true";
    // integ-slot: index.html names a home for known items (<i data-slot>) inside the menu
    // structure (submenus); the item takes the slot's short label. A slot in another menu
    // (Window › Panels for the status-bar Panels menu) receives a copy.
    const slot = document.querySelector('.menubar [data-slot="' + action + '"]');
    if (slot && slot.closest(".work-menu") === list.closest(".work-menu")) {if (slot.dataset.label) b.textContent = slot.dataset.label; slot.before(b); return b;}
    if (slot && !slot.parentElement.querySelector(':scope > [data-action="' + action + '"]')) {const copy = b.cloneNode(true); if (slot.dataset.label) copy.textContent = slot.dataset.label; slot.before(copy);}
    const anchor = after && list.querySelector('[data-action="' + after + '"]');
    const nodes = separator ? [el("hr"), b] : [b];
    if (scope && separator) nodes[0].dataset.scope = scope;
    if (anchor) anchor.after(...nodes); else list.append(...nodes);
    return b;
  }
  function menuLabel(button) {
    return (button.dataset.label || [...button.childNodes]
      .filter(node => !/** @type {Element} */ (node).classList?.contains("ui-shortcut")).map(node => node.textContent).join("")).trim();
  }
  function setChecked(action, on) {
    if (!hasDOM()) return;
    for (const b of document.querySelectorAll('[data-action="' + action + '"][data-checkable]')) {
      b.dataset.checked = String(!!on);
      const base = b.dataset.label || (b.dataset.label = menuLabel(b));
      b.setAttribute("aria-label", base + (on ? " (on)" : " (off)"));
    }
  }

  function actionMenu(trigger, commands, options = {}) {
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
    trigger.classList.add("action-menu-button");
    trigger.onclick = async () => {
      try {
        const menu = await globalThis.AtriumLazy.need("AtriumContextMenu");
        if (trigger.isConnected && !trigger.disabled) menu.dropdown(trigger,
          typeof commands === "function" ? commands() : commands, options);
      } catch (err) { globalThis.AtriumNavHost?.info(err.message); }
    };
    trigger.addEventListener("keydown", event => {
      if (event.key === "ArrowDown") {event.preventDefault(); trigger.click();}
    });
    return trigger;
  }

  const statusMore = hasDOM() && document.getElementById("status-more");
  if (statusMore) actionMenu(statusMore, () => AtriumContextMenu.statusItems(statusMore), {above:true});

  // Read the saved Cross Select mode before Cross Probe loads, so the first menu shows it.
  function crossSelectEnabled() {
    try { return globalThis.localStorage?.getItem("atrium-cross-select") === "1"; }
    catch { return false; }
  }
  return {crossSelectEnabled, el, elementIn, classedElement, elWithAttributes, appendPropertyRow, appendSwitchRow, measure, icon, button, actionButton, actionMenu, shortcutTitle, shortcutBadge, shortcutParts, openPalette, openPaletteAction, paletteInstance, isMac, itemBox, union, grow, overlaps, inside, cameraFor,
    toast, ready, hostReady, menuItem, menuLabel, setChecked};
})();
globalThis.AtriumToast = {show:(t, o) => AtriumNavCommon.toast(t, o)};
// The PCB List loads from its menu or rail button on first use.
globalThis.AtriumLazy?.register?.("AtriumPCBList", {scripts:["pcb/pcb-list.js"],deps:["AtriumWindowedTable"]}, ["pcb-list"]);
