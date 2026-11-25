"use strict";

// Shell behaviour that sits outside the editor: collapsible Properties sections
// and dock panels (remembered per title), and a brief cue when the status text
// changes. Everything here is presentation-only; the editor never depends on it.
globalThis.AtriumShell = (() => {
  const doc = globalThis.document;
  if (!doc?.getElementById) return {};
  const child = (parent, test) => Array.from(parent?.children || []).filter(test);
  try {
  const store = {
    read(key) { try { return JSON.parse(globalThis.localStorage?.getItem(key) || "[]"); } catch { return []; } },
    write(key, values) { try { globalThis.localStorage?.setItem(key, JSON.stringify([...values])); } catch {} }
  };
  const SECTION_KEY = "atrium.collapsed-sections", PANEL_KEY = "atrium.collapsed-panels";
  const collapsedSections = new Set(store.read(SECTION_KEY));
  const collapsedPanels = new Set(store.read(PANEL_KEY));
  function collapseBody(container, heading) {
    const wrapper = doc.createElement("div"), content = doc.createElement("div");
    const focused = container.contains(doc.activeElement) && doc.activeElement;
    wrapper.className = "ui-collapse";
    content.className = "ui-collapse-content";
    for (const item of [...container.children]) if (item !== heading) content.append(item);
    wrapper.append(content);
    container.append(wrapper);
    wrapper.inert = container.classList.contains("collapsed");
    if (focused && !wrapper.inert && doc.activeElement !== focused) focused.focus({preventScroll:true});
    return wrapper;
  }

  // A header becomes a disclosure control without changing its heading role in
  // the document outline: the button inside carries the state.
  function makeToggle(header, title, collapsed, onToggle) {
    if (header.dataset.collapsible) return;
    header.dataset.collapsible = "true";
    const label = doc.createElement("button");
    label.type = "button";
    label.className = "section-toggle ui-disclosure-marker";
    label.setAttribute("aria-expanded", String(!collapsed));
    while (header.firstChild) label.append(header.firstChild);
    header.append(label);
    label.addEventListener("click", event => { event.stopPropagation(); onToggle(label); });
    label.addEventListener("keydown", event => {
      if (event.key !== " ") return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) label.click();
    });
  }

  // Properties: sections are rebuilt on every inspect(), so re-apply on change.
  const inspector = doc.getElementById("inspector");
  const selectionSummary = doc.createElement("p");
  selectionSummary.id = "canvas-selection-summary";
  selectionSummary.className = "visually-hidden";
  selectionSummary.setAttribute("role", "status");
  inspector?.before(selectionSummary);
  function describeCanvas() {
    const host = globalThis.AtriumNavHost;
    if (!host || !inspector) return;
    const design = host.doc(), ids = host.selection(), selected = ids.length === 1 ? design.items.find(i => i.id === ids[0]) : null;
    let summary = "No objects selected.";
    if (ids.length > 1) {
      const section = inspector.querySelector(":scope > .inspect-section:not(.pcb-edit-filter-section)");
      const counts = [...(section?.querySelectorAll(":scope > .property-row, :scope > .ui-collapse > .ui-collapse-content > .property-row") || [])]
        .map(row => [row.firstElementChild?.textContent, row.lastElementChild?.textContent])
        .filter(([kind, count]) => kind && /^\d+$/.test(count));
      const breakdown = counts.map(([kind, count]) => kind + " count " + count + ".").join(" ");
      summary = ids.length + " objects selected." + (breakdown ? " " + breakdown : "");
    } else if (selected) {
      const title = selected.kind === "part" ? (design.kind === "pcb" ? "Footprint" : "Symbol")
        : globalThis.AtriumSchObjects?.isFrame(selected) ? "Frame" : globalThis.AtriumSchObjects?.LABELS?.[selected.kind] || ({netlabel:"Net label", label:"Text", track:"Track", via:"Via", pad:"Pad"})[selected.kind]
          || selected.kind.replace(/([a-z])([A-Z])/g, "$1 $2");
      const name = selected.ref || selected.name || selected.text;
      const net = selected.net || (selected.kind === "wire"
        ? [...inspector.querySelectorAll(".property-row")].find(n => n.firstElementChild?.textContent === "Connected net")?.lastElementChild?.textContent : "");
      const layer = selected.layer && (globalThis.AtriumPCBAppearance?.name?.(selected.layer) || selected.layer);
      summary = title + (name ? " " + name : "") + " selected." +
        (selected.value ? " " + selected.value + "." : "") + (net ? " Net " + net + "." : "") + (layer ? " Layer " + layer + "." : "");
    }
    if (selectionSummary.textContent !== summary) selectionSummary.textContent = summary;
    for (const pane of host.panes()) {
      const name = host.docById(pane.docId)?.name;
      const label = name ? name + " design canvas" : "Design canvas";
      if (pane.canvas.getAttribute("aria-label") !== label) pane.canvas.setAttribute("aria-label", label);
      if (pane.active && pane.canvas.getAttribute("aria-describedby") !== selectionSummary.id) pane.canvas.setAttribute("aria-describedby", selectionSummary.id);
      else if (!pane.active) pane.canvas.removeAttribute("aria-describedby");
    }
  }
  function decorateInspector() {
    for (const section of child(inspector, n => n.classList?.contains("inspect-section"))) {
      const heading = child(section, n => n.matches("h3,.inspect-section-heading"))[0];
      const header = heading?.tagName === "H3" ? heading : child(heading, n => n.tagName === "H3")[0];
      if (!header || header.dataset.collapsible) continue;
      const title = section.dataset.collapseKey || header.textContent.trim();
      const collapsed = collapsedSections.has(title);
      section.classList.toggle("collapsed", collapsed);
      const body = collapseBody(section, heading);
      makeToggle(header, title, collapsed, button => {
        const now = !section.classList.contains("collapsed");
        section.classList.toggle("collapsed", now);
        body.inert = now;
        button.setAttribute("aria-expanded", String(!now));
        if (now) collapsedSections.add(title); else collapsedSections.delete(title);
        store.write(SECTION_KEY, collapsedSections);
      });
    }
    describeCanvas();
  }
  globalThis.AtriumNavHost?.on("panes", describeCanvas);
  if (inspector && typeof MutationObserver !== "undefined") {
    new MutationObserver(decorateInspector).observe(inspector, { childList: true });
    decorateInspector();
  }

  // Dock panels (Projects, Components) collapse from their title bars.
  for (const panel of doc.querySelectorAll(".side-pane .panel")) {
    const header = child(panel, n => n.classList?.contains("pane-heading"))[0];
    const title = header?.querySelector("h2")?.textContent.trim();
    if (!header || !title) continue;
    const collapsed = collapsedPanels.has(title);
    panel.classList.toggle("collapsed", collapsed);
    const body = collapseBody(panel, header);
    makeToggle(header.querySelector("h2"), title, collapsed, button => {
      const now = !panel.classList.contains("collapsed");
      panel.classList.toggle("collapsed", now);
      body.inert = now;
      button.setAttribute("aria-expanded", String(!now));
      if (now) collapsedPanels.add(title); else collapsedPanels.delete(title);
      store.write(PANEL_KEY, collapsedPanels);
    });
  }
  const animatedDetails = ".project-tree,.tree-folder,.inspector-disclosure";
  doc.addEventListener("toggle", event => {
    const details = event.target;
    if (!details.matches?.(animatedDetails)) return;
    const body = details.querySelector(":scope > .ui-collapse");
    if (body) body.inert = !details.open || details.classList.contains("ui-detail-closing");
  }, true);
  doc.addEventListener("click", event => {
    const summary = event.target.closest?.(`:is(${animatedDetails}) > summary`);
    if (!summary || event.defaultPrevented) return;
    const details = summary.parentElement, body = details.querySelector(":scope > .ui-collapse");
    if (!body) return;
    event.preventDefault();
    const motion = globalThis.AtriumMotionUI;
    if (motion?.disclosure) {
      motion.disclosure(details, summary, body, event);
      return;
    }
    details.open = !details.open;
    details.classList.remove("ui-detail-closing");
    summary.removeAttribute("aria-expanded");
    body.inert = !details.open;
  });

  const {FIELD, visible, available, dialog, adoptDialog, openDialog, setupDialogs} = AtriumUI;
  function focusEditor() {
    if (globalThis.AtriumStartPage?.isOpen?.()) return;
    const canvas = globalThis.AtriumNavHost?.canvas?.();
    if (canvas?.inert && globalThis.AtriumDocViews?.focusPane) { globalThis.AtriumDocViews.focusPane(canvas); return; }
    const viewer = canvas?.parentElement?.querySelector(":scope > .v3d:has(> .v3d-bar) > canvas");
    const surface = available(viewer) ? viewer : canvas;
    if (available(surface)) surface.focus({preventScroll:true});
  }
  setupDialogs(focusEditor);

  // ------------------------------------------------- Roving focus (toolbars, Projects)
  // Each toolbar and the Projects tree is one Tab stop; arrow keys move inside it.
  const ROVE = "button:not(:disabled):not([hidden])";
  function roveItems(group) {
    if (group.id === "projects-tree") return Array.from(group.querySelectorAll("summary, #documents > button")).filter(available);
    return Array.from(group.querySelectorAll(ROVE)).filter(n => visible(n) && n.closest("[role=toolbar]") === group);
  }
  function roveSync(group) {
    const items = roveItems(group); if (!items.length) return;
    const keep = items.find(n => n.tabIndex === 0 && n.dataset.rove === "on") || items.find(n => n.matches("[aria-current=true],[aria-pressed=true],[aria-selected=true]")) || items[0];
    for (const n of items) { n.tabIndex = n === keep ? 0 : -1; n.dataset.rove = n === keep ? "on" : ""; }
  }
  function roveTo(group, node) {
    for (const n of roveItems(group)) { n.tabIndex = n === node ? 0 : -1; n.dataset.rove = n === node ? "on" : ""; }
    node.focus();
  }
  const projectsBody = doc.querySelector(".panel-projects .panel-body");
  if (projectsBody) { projectsBody.id ||= "projects-tree"; doc.getElementById("documents")?.setAttribute("role", "tree"); }
  const roveGroups = () => [...doc.querySelectorAll("[role=toolbar]"), projectsBody].filter(Boolean);
  doc.addEventListener("keydown", event => {
    const group = event.target.closest?.("[role=toolbar],#projects-tree");
    if (!group || event.altKey || event.ctrlKey || event.metaKey || event.target.matches?.(FIELD + ",textarea")) return;
    const items = roveItems(group), at = items.indexOf(event.target);
    if (at < 0) return;
    const tree = group.id === "projects-tree", key = event.key;
    const next = tree ? { ArrowDown: 1, ArrowUp: -1 }[key] : { ArrowRight: 1, ArrowLeft: -1, ArrowDown: group.getAttribute("aria-orientation") === "vertical" ? 1 : 0, ArrowUp: group.getAttribute("aria-orientation") === "vertical" ? -1 : 0 }[key];
    let dest = null;
    if (next) dest = items[(at + next + items.length) % items.length];
    else if (key === "Home") dest = items[0];
    else if (key === "End") dest = items.at(-1);
    else if (tree && (key === "ArrowLeft" || key === "ArrowRight")) {
      const t = event.target, details = t.tagName === "SUMMARY" ? t.parentElement : null;
      const open = details?.open && !details.classList.contains("ui-detail-closing");
      const depth = Number(t.dataset.depth || 0);
      if (key === "ArrowRight") {
        if (details && !open) t.click();
        else if (details?.contains(items[at + 1]) || Number(items[at + 1]?.dataset.depth || 0) > depth) dest = items[at + 1];
      } else if (open) t.click();
      else if (depth) dest = items.slice(0, at).findLast(row => Number(row.dataset.depth || 0) === depth - 1);
      else {
        const parent = (details ? details.parentElement : t).closest("details");
        dest = parent?.querySelector(":scope > summary") || null;
      }
      event.preventDefault();
    } else return;
    event.preventDefault();
    if (dest) roveTo(group, dest);
  });
  doc.addEventListener("focusin", event => {
    const group = event.target.closest?.("[role=toolbar],#projects-tree");
    if (group && roveItems(group).includes(event.target)) roveTo(group, event.target);
  });
  if (typeof MutationObserver !== "undefined") {
    const resync = new MutationObserver(records => { const seen = new Set(); for (const r of records) { const g = r.target.closest?.("[role=toolbar],#projects-tree"); if (g && !seen.has(g)) { seen.add(g); roveSync(g); } } });
    for (const g of roveGroups()) { roveSync(g); resync.observe(g, { childList: true, subtree: true, attributes: true, attributeFilter: ["hidden", "disabled", "aria-current", "open"] }); }
  }

  // ------------------------------------------------- Native behaviour (docs/design-system.md)
  // Waffle is an app, not a page: one policy per browser behaviour, for the whole window.
  const root = doc.documentElement, G = globalThis;
  const TEXT_FIELD = "input:not([type=checkbox],[type=radio],[type=range],[type=color],[type=button],[type=submit],[type=reset],[type=file],[type=image]),textarea,[contenteditable]:not([contenteditable=false])";
  const editable = node => !!node?.closest?.(TEXT_FIELD);

  // Focus rings follow keyboard navigation, like macOS with keyboard navigation turned on.
  // Navigating with the keyboard sets html[data-focus-nav=keys]: Tab, arrows, Home, End and Page
  // keys on a control, and Enter or Space on one. A shortcut clears it (any key with Command,
  // Control or Alt, and letters, digits or function keys outside a field), as does a pointer
  // press; typing in a field and Escape leave it as it was. Browsers treat any focus() after a
  // key press as :focus-visible, so polish.css shows rings only under this marker: a shortcut, or
  // a dialog closed after one, never rings the control that gets focus back, while a keyboard
  // user who opened that dialog with Enter sees where focus returned. Text fields keep their rings.
  const NAV_KEYS = new Set(["Tab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", "Enter", " "]);
  const UNCHANGED = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "Escape", "Dead", "Process", "Unidentified"]);
  const navigating = on => { if (on) root.dataset.focusNav = "keys"; else delete root.dataset.focusNav; };
  doc.addEventListener("keydown", event => {
    if (UNCHANGED.has(event.key) || event.isComposing) return;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey, target = event.target;
    const field = editable(target);
    if (!plain) { navigating(false); return; }
    if (event.key === "Tab") { navigating(true); return; }
    if (field) return;
    const control = target?.closest && target !== doc.body && target !== root && !target.matches("canvas");
    navigating(!!control && NAV_KEYS.has(event.key));
  }, true);
  doc.addEventListener("pointerdown", () => navigating(false), true);
  // Touch leaves no hover behind: a touch press sets html[data-pointer=touch] until a mouse or pen moves
  // again, and canvas chrome writes its :hover fills under :where(:root:not([data-pointer=touch])).
  doc.addEventListener("pointerdown", e => { if (e.pointerType === "touch") root.dataset.pointer = "touch"; }, true);
  doc.addEventListener("pointermove", e => { if (e.pointerType !== "touch" && !e.buttons && (e.movementX || e.movementY)) delete root.dataset.pointer; }, true);

  // Browser shortcuts never reach the browser: reload, find, history, print, save, address bar,
  // bookmarks, view source, developer tools, caret browsing and page zoom. The keymap runs first
  // (document listeners); this window listener only cancels what nothing handled. On the macOS
  // host the menu bar owns its own key equivalents (main.swift), so those are left alone there.
  const mac = /Mac|iPhone|iPad/i.test(G.navigator?.platform || "");
  const menuBarKeys = mac && G.webkit?.messageHandlers?.atriumHost ? new Set(["n", "o", "s", "w", "z", "x", "c", "v", "a", "0", "h", "q", "m", ","]) : new Set();
  // Command keys that only a browser uses; the second set also edits text (Redo, Underline…),
  // so it is cancelled only outside fields.
  const BROWSER_MOD = new Set(["r", "f", "g", "[", "]", "p", "s", "o", "l", "d", "j", "=", "+", "-", "_", "0"]);
  const BROWSER_MOD_CHROME = new Set(["u", "e", "y", "k", ...(mac ? [] : ["h"])]);
  const BROWSER_FN = new Set(["F3", "F5", "F7", "F12", "BrowserBack", "BrowserForward", "BrowserRefresh", "BrowserSearch"]);
  function browserShortcut(event) {
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (BROWSER_FN.has(key)) return true;
    const field = editable(event.target);
    if (mod) return (BROWSER_MOD.has(key) || !field && BROWSER_MOD_CHROME.has(key)) && !menuBarKeys.has(key);
    if (field) return false;
    return key === "Backspace" && !event.altKey || event.altKey && !mac && (key === "ArrowLeft" || key === "ArrowRight");
  }
  G.addEventListener?.("keydown", event => {
    if (!event.defaultPrevented && event.isTrusted && !event.isComposing && browserShortcut(event)) event.preventDefault();
  });

  // Fields: identifiers, numbers, net names, queries and paths are not prose, so single-line
  // fields never check spelling, autocorrect or autocapitalise unless they opt in with
  // spellcheck="true". Multi-line text and rich text are prose and keep the checks unless they
  // say spellcheck="false" (code, CSV, JSON).
  // Browser form autofill never offers saved entries either.
  doc.addEventListener("focusin", event => {
    const field = event.target;
    if (!field?.matches?.("input")) return;
    if (!field.hasAttribute("autocomplete")) field.setAttribute("autocomplete", "off");
    if (field.hasAttribute("spellcheck")) return;
    field.spellcheck = false;
    field.setAttribute("autocorrect", "off");
    field.setAttribute("autocapitalize", "off");
  }, true);

  // Drags: only the app's own draggable="true" sources start a drag. Images, icons, links and
  // chrome never lift a ghost image; selected text in fields and selectable content still drags.
  doc.addEventListener("dragstart", event => {
    const node = event.target?.nodeType === 3 ? event.target.parentElement : event.target;
    if (!node?.closest || node.closest("[draggable=true]")) return;
    const selection = G.getSelection?.();
    if (editable(node) || selection && !selection.isCollapsed && selection.containsNode?.(node, true) && G.getComputedStyle(node).userSelect !== "none") return;
    event.preventDefault();
  }, true);

  // Links: an external http(s) link opens in the system browser; the window never navigates.
  function openExternal(event) {
    const link = event.target?.closest?.("a[href]");
    if (!link || event.defaultPrevented || event.type === "auxclick" && event.button !== 1) return;
    let url;
    try { url = new URL(link.getAttribute("href"), G.location?.href); } catch { return; }
    if (!/^https?:$/.test(url.protocol)) return;
    event.preventDefault();
    if (url.username || url.password) return;
    if (G.AtriumHost?.openURL) G.AtriumHost.openURL(url.href)?.catch?.(() => {});
    else if (!G.AtriumHost) G.open?.(url.href, "_blank", "noopener,noreferrer");
  }
  doc.addEventListener("click", openExternal);
  doc.addEventListener("auxclick", openExternal);

  // The window itself never scrolls: focus() and scrollIntoView() can still scroll an
  // overflow:hidden root, which would shift the whole app.
  doc.addEventListener("scroll", event => {
    const node = event.target === doc ? doc.scrollingElement : event.target;
    if ((node === root || node === doc.body) && (node.scrollTop || node.scrollLeft)) node.scrollTop = node.scrollLeft = 0;
  }, {capture:true, passive:true});

  // polish.css overrides module styles, so it stays the last stylesheet: stylesheets that
  // lazily loaded modules add later are moved in front of it (they are still loading).
  const head = doc.head;
  let polish = head?.querySelector('link[href$="editor/polish.css"]');
  if (head && !polish) { polish = doc.createElement("link"); polish.rel = "stylesheet"; polish.href = "editor/polish.css"; head.append(polish); }
  if (head && typeof MutationObserver !== "undefined") new MutationObserver(records => {
    for (const r of records) for (const n of r.addedNodes) {
      if (n !== polish && (n.tagName === "STYLE" || (n.tagName === "LINK" && n.rel === "stylesheet")) && polish.compareDocumentPosition(n) & 4) head.insertBefore(n, polish);
    }
  }).observe(head, { childList: true });

  return { decorateInspector, dialog, adoptDialog, openDialog, focusEditor, browserShortcut };
  } catch (error) { globalThis.console?.warn?.("Waffle shell enhancements unavailable", error); return {}; }
})();
