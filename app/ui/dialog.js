"use strict";

globalThis.AtriumUI = (() => {
  const doc = globalThis.document;
  const FIELD = "input:not([type=checkbox],[type=radio],[type=button],[type=submit],[type=reset],[type=hidden],[type=file],[type=range],[type=color]),select";
  const FOCUSABLE = "button, a[href], input:not([type=hidden]), select, textarea, details > summary, [contenteditable=true], [tabindex]";
  const visible = n => !!(n?.getClientRects?.().length && getComputedStyle(n).visibility === "visible");
  const focusableFromMarkup = n => !n.matches(":disabled")
    && !n.closest("[hidden],[inert],[aria-hidden=true],details:not([open]) > :not(summary)");
  const available = n => visible(n) && focusableFromMarkup(n);
  const dialogOptions = new WeakMap();
  let id = 0;

  function button(node, variant, size) {
    node.classList.add("ui-button");
    if (variant) node.dataset.variant = variant;
    if (size) node.dataset.size = size;
    if (node.tagName === "BUTTON" && !node.hasAttribute("type") && !node.form) node.type = "button";
    return node;
  }
  // Native action button. PDN's local button is the donor; button() still owns class and variant.
  function nativeButton(text, act, cls, title, options = {}) {
    const node = doc.createElement("button");
    if (text != null) node.textContent = text;
    if (cls) node.className = cls;
    node.type = "button";
    const mapped = cls === "is-primary" || cls === "fp-go" ? "primary" : cls === "vs-danger" ? "danger" : undefined;
    button(node, options.variant ?? mapped, options.size);
    if (node.matches(".ui-tab, .ui-segment")) node.classList.remove("ui-button");
    if (title) node.title = title;
    if (options.ariaLabel) node.setAttribute("aria-label", options.ariaLabel);
    if (options.pressed != null) node.setAttribute("aria-pressed", String(!!options.pressed));
    if (options.disabled) node.disabled = true;
    if (act) node.onclick = act;
    if (options.run) node.addEventListener("click", options.run);
    return node;
  }
  const footerOf = d => [...d.querySelectorAll(".ui-dialog-actions,.work-actions")].filter(n => n.closest("dialog") === d).at(-1);
  const buttonsOf = footer => [...(footer?.children || [])].filter(n => n.tagName === "BUTTON");
  const preferred = b => b.dataset.variant ? b.dataset.variant === "primary" : b.matches(".is-primary,.lib-primary");
  const defaultButton = buttons => buttons.find(b => b.matches("[data-ui-default]:not([data-ui-default=false])"))
    || buttons.find(b => preferred(b) && b.dataset.uiDefault !== "false");

  function orderActions(footer, buttons) {
    const primary = buttons.filter(b => preferred(b) || b.matches("[data-variant=danger][data-ui-default]:not([data-ui-default=false])"));
    if (!primary.length || primary.length === buttons.length) return;
    const secondary = buttons.filter(b => !primary.includes(b));
    const platform = globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "";
    const ordered = /Win/i.test(platform) ? [...primary, ...secondary] : [...secondary, ...primary];
    if (ordered.every((b, i) => b === buttons[i])) return;
    const focused = buttons.find(b => b === doc.activeElement);
    // Keep other footer content in its original slots.
    if (footer.children.length === buttons.length) footer.append(...ordered);
    else {
      const slots = buttons.map(b => { const slot = doc.createComment(""); b.replaceWith(slot); return slot; });
      slots.forEach((slot, i) => slot.replaceWith(ordered[i]));
    }
    focused?.focus({preventScroll:true});
  }
  function adoptDialog(d, {title = d.querySelector("h2"), body, actions = footerOf(d), sheet, modeless, initialFocus,
    order = "platform", defaultAction = true} = {}) {
    d.classList.add("ui-dialog");
    if (sheet) d.classList.add("ui-sheet");
    if (modeless) d.dataset.uiModeless = "";
    if (title) {
      title.classList.add("ui-dialog-title");
      if (!d.hasAttribute("aria-label") && !d.hasAttribute("aria-labelledby")) {
        title.id ||= "ui-dialog-" + ++id;
        d.setAttribute("aria-labelledby", title.id);
      }
    }
    for (const section of [].concat(body || [])) section?.classList?.add("ui-dialog-body");
    if (actions) {
      actions.classList.add("ui-dialog-actions");
      const buttons = buttonsOf(actions);
      for (const b of buttons) button(b, b.dataset.variant || (preferred(b) ? "primary" : "secondary"));
      if (order === "platform") orderActions(actions, buttons);
    }
    if (!dialogOptions.has(d)) d.addEventListener("keydown", event => {
      if (event.key !== "Enter" || event.defaultPrevented || event.isComposing || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
      const input = event.target, options = dialogOptions.get(d);
      if (!options.defaultAction || !input.matches?.(FIELD) || input.closest("dialog") !== d || input.closest("[role=combobox]")) return;
      if (input.form?.querySelector("button[type=submit],input[type=submit],button:not([type])")) return;
      const primary = defaultButton(buttonsOf(options.actions));
      if (!available(primary)) return;
      event.preventDefault();
      primary.click();
    });
    dialogOptions.set(d, {actions, initialFocus, defaultAction});
    return d;
  }

  // beforeRemove still sees the connected dialog. onClose runs after it leaves the document.
  function openDialog(d, {onClose, beforeRemove, ...options} = {}) {
    adoptDialog(d, options);
    d.addEventListener("close", () => {
      beforeRemove?.();
      d.remove();
      onClose?.();
    }, {once:true});
    doc.body.append(d);
    d.showModal();
    return d;
  }

  function dialog({title, body = [], actions = [{label:"Close", primary:true}], className = "", label,
    onClose, sheet = false, order = "platform"} = {}) {
    const d = doc.createElement("dialog");
    d.className = ("work-dialog shell-dialog " + className).trim();
    if (label) d.setAttribute("aria-label", label);
    const heading = doc.createElement("h2");
    heading.textContent = title || "";
    const footer = doc.createElement("div");
    footer.className = "work-actions";
    let result = null, running = false, initialFocus;
    for (const action of actions) {
      const b = button(doc.createElement("button"), action.variant || (action.primary ? "primary" : "secondary"), action.size);
      b.textContent = action.label;
      if (action.title) b.title = action.title;
      if (action.primary) b.classList.add("is-primary");
      if (action.default != null) b.dataset.uiDefault = String(action.default);
      if (action.focus) initialFocus = b;
      b.addEventListener("click", async () => {
        if (running || !d.open) return;
        running = true;
        try {
          if ((action.run && await action.run(d) === false) || !d.open) return;
          result = action.label;
          d.close();
        } finally { running = false; }
      });
      footer.append(b);
      action.button = b;
    }
    const sections = body.filter(Boolean);
    d.append(heading, ...sections, footer);
    let settle;
    d.done = new Promise(resolve => {
      let settled = false;
      settle = () => {
        if (settled) return;
        settled = true;
        resolve(result);
        onClose?.(result);
      };
      // Resolve the action when native modal state closes. Paint may remain
      // briefly on screen and its close event still owns removing the node.
      d.addEventListener("beforetoggle", event => {
        if (event.newState === "closed") queueMicrotask(() => { if (!d.open) settle(); });
      });
    });
    openDialog(d, {title:heading, body:sections, actions:footer, sheet, order, onClose:settle});
    const active = doc.activeElement;
    if (!available(initialFocus) && footer.contains(active)) {
      initialFocus = [...d.querySelectorAll(FIELD + ",textarea")].find(available)
        || actions.find(a => a.button.dataset.variant !== "danger" && !preferred(a.button) && available(a.button))?.button
        || buttonsOf(footer).find(b => b.dataset.variant !== "danger" && available(b));
      if (!initialFocus) { heading.tabIndex = -1; initialFocus = heading; }
    }
    initialFocus?.focus({preventScroll:true});
    return d;
  }

  function setupDialogs(focusEditor) {
    // Track the topmost modal through focus; DOM order can differ from the native stack.
    const modals = new WeakMap();
    doc.addEventListener("focusin", event => {
      const d = event.target.closest?.("dialog:modal");
      if (!d || modals.has(d)) return;
      const from = event.relatedTarget;
      const state = {from, parent:from?.closest?.("dialog[open]"), escaped:false};
      modals.set(d, state);
      d.addEventListener("close", () => {
        modals.delete(d);
        requestAnimationFrame(() => {
          if (d.open) return;
          const current = doc.activeElement;
          const modal = current?.closest?.("dialog:modal");
          if (modal || doc.querySelector("dialog:modal")) {
            if ((!modal || modal === state.parent) && state.parent?.matches(":modal") && available(state.from)) state.from.focus({preventScroll:true});
            return;
          }
          const lost = current === doc.body || !available(current);
          const returnToOpener = d.dataset.returnFocus === "opener" || (state.parent?.open && available(state.from));
          if (state.escaped && !returnToOpener && (lost || current === state.from)) focusEditor();
          else if (lost && state.from !== doc.body && available(state.from)) state.from.focus({preventScroll:true});
          else if (lost) focusEditor();
        });
      }, {once:true});
      const preferredFocus = dialogOptions.get(d)?.initialFocus;
      const target = (typeof preferredFocus === "function" ? preferredFocus() : preferredFocus)
        || d.querySelector("[data-ui-initial-focus]");
      if (available(target)) target.focus({preventScroll:true});
    });
    doc.addEventListener("keydown", event => {
      if (event.defaultPrevented || event.isComposing) return;
      const d = event.target.closest?.("dialog:modal");
      if (!d) return;
      if (event.key === "Escape") {
        const state = modals.get(d);
        if (state && !event.repeat && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
          state.escaped = true;
          // An inline menu or search input may consume Escape and leave the dialog open.
          setTimeout(() => { if (d.open) state.escaped = false; }, 0);
        }
        return;
      }
      if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
      const at = doc.activeElement;
      const items = [...d.querySelectorAll(FOCUSABLE)].filter(n => n.tabIndex >= 0 && available(n));
      const tabbable = items.filter(node => {
        if (node.type !== "radio" || !node.name) return true;
        const group = items.filter(other => other.type === "radio" && other.name === node.name && other.form === node.form);
        const entry = group.find(n => n.checked) || (group.includes(at) ? at : event.shiftKey ? group.at(-1) : group[0]);
        return entry === node;
      });
      tabbable.sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
      const first = tabbable[0], last = tabbable.at(-1);
      const dest = at === d ? (event.shiftKey ? last : first) : event.shiftKey && at === first ? last : !event.shiftKey && at === last ? first : null;
      if (dest || !tabbable.length) {
        event.preventDefault();
        (dest || d).focus();
      }
    }, true);

    doc.addEventListener("keydown", event => {
      if (!/^(Arrow|Home$|End$)/.test(event.key) || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const group = event.target.closest?.(".ui-tabs[role=tablist],.ui-segmented[role=radiogroup]");
      if (!group) return;
      const role = group.getAttribute("role"), radio = role === "radiogroup";
      const selector = radio ? "button[role=radio]" : "[role=tab]";
      const items = () => [...group.querySelectorAll(selector)].filter(n =>
        n.closest("[role=" + role + "]") === group && available(n) && n.getAttribute("aria-disabled") !== "true");
      const choices = items(), at = choices.indexOf(event.target.closest(selector));
      if (at < 0) return;
      const vertical = group.getAttribute("aria-orientation") === "vertical";
      let step = (vertical || radio) && ({ArrowDown:1, ArrowUp:-1}[event.key] || 0);
      if (!vertical && !step) {
        step = {ArrowRight:1, ArrowLeft:-1}[event.key] || 0;
        if (step && getComputedStyle(group).direction === "rtl") step *= -1;
      }
      const next = step ? (at + step + choices.length) % choices.length
        : event.key === "Home" ? 0 : event.key === "End" ? choices.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      choices[next].click();
      const state = radio ? "aria-checked" : "aria-selected";
      const live = items(), target = live.find(n => n.getAttribute(state) === "true") || live[next];
      for (const n of live) n.tabIndex = n === target ? 0 : -1;
      target?.focus();
    });
  }

  // Single-line selects open Waffle's option list (ui/select-popup.js, loaded on first use) instead of
  // the platform pop-up, which is placed from native pop-up button metrics and lands off the field.
  // Touch keeps the system picker; [data-native-select] on a select or an ancestor opts out.
  if (doc?.addEventListener) {
    // Set the tooltip for an ellipsized status before the shared tooltip handles first hover.
    doc.addEventListener("pointerover", event => {
      const status = event.target.closest?.(".ui-dialog-actions .ui-dialog-status");
      if (!status || status.contains(event.relatedTarget)) return;
      if (status.scrollWidth > status.clientWidth) status.dataset.tooltip = status.textContent;
      else delete status.dataset.tooltip;
    }, true);
    let touch = false;
    const mac = /Mac|iP/.test(globalThis.navigator?.userAgentData?.platform || globalThis.navigator?.platform || "");
    const ours = s => s?.tagName === "SELECT" && !s.multiple && !(s.size > 1) && !s.disabled && !s.closest("[data-native-select]");
    const show = s => {
      const P = globalThis.AtriumSelectPopup;
      if (P) P.open(s); else globalThis.AtriumLazy?.need("AtriumSelectPopup").then(p => p.open(s), () => {});
    };
    doc.addEventListener("pointerdown", e => { touch = e.pointerType === "touch"; }, true);
    doc.addEventListener("mousedown", e => {
      const s = e.target;
      if (e.button || touch || !ours(s)) return;
      e.preventDefault(); s.focus({preventScroll: true}); show(s);
    }, true);
    doc.addEventListener("keydown", e => {
      const s = e.target;
      if (!ours(s) || e.metaKey || e.ctrlKey || globalThis.AtriumSelectPopup?.isOpen()) return;
      const arrow = e.key === "ArrowDown" || e.key === "ArrowUp";
      if (e.key === " " || e.key === "F4" || arrow && (e.altKey || mac)) { e.preventDefault(); show(s); }
    }, true);
  }

  // Static .ui-search shell. AtriumUIKit.adoptSearch remains the enhancement
  // (clear button, match count, Escape). Pass type to set type="search" while cold.
  function searchField(input, {cls, type, accessory} = {}) {
    const box = doc.createElement("div");
    box.className = "ui-search" + (cls ? " " + cls : "");
    input.classList.add("ui-field");
    if (type) input.type = "search";
    box.append(AtriumNavCommon.icon("search"), input);
    if (accessory) box.append(accessory);
    return globalThis.AtriumUIKit?.adoptSearch(input) || box;
  }

  return {adoptDialog, button, nativeButton, dialog, openDialog, setupDialogs, searchField, FIELD, visible, available, focusableFromMarkup};
})();
