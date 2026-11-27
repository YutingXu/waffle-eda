"use strict";
// Panel docking and named workspace layouts (lazy; index.html loads it once the editor is idle,
// or at once when the saved layout moves the startup panels).
//
//   - Any panel can dock left, right or bottom, or float, by dragging its tab or its title bar.
//     A preview shows where it lands: the middle of a group makes it a tab there, the edge of a
//     group splits it off as a new group, the edges of the editor dock it to that side, and
//     anywhere else on the editor floats it. Escape cancels a drag.
//   - Panels in one group are tabs (a tab strip appears once two are open). Sashes resize the
//     side bars, the bottom area and the groups; a double click (or Enter) restores the default.
//   - Window › Move Panel… does every docking move from the keyboard; F6 / Shift+F6 move focus
//     through the parts (side-bar groups, editor panes, bottom groups, floating windows).
//   - Window › Layouts: Save Current…, Manage…, Default, Schematic Capture, PCB Routing, Review
//     and saved layouts; Switch by Document Kind (off by default) applies Schematic Capture to
//     sheets and PCB Routing to boards, remembering changes per kind. Ctrl/⌘+K Z is Zen mode.
//
// Layouts live in the user's preferences (AtriumPref / AtriumPrefs), never in the project, so
// Export / Import Settings carry them:
//   "workbench.layout"       the current layout (an eager snippet in index.html applies its sizes
//                            and collapsed sides before first paint)
//   "workbench.layouts"      {name: layout} saved by Save Current…
//   "workbench.kindLayouts"  {schematic, pcb} the last layout per document kind (auto switch)
//   "general.layoutByKind"   the auto switch (Preferences › General, Window › Layouts)
//
// Panels register by selector (KNOWN below) or through the API; a module that loads before this
// one can queue specs on globalThis.AtriumDockPending:
//   AtriumDock.register({id, title, element | match, area: "left"|"right"|"bottom", action, scope})
// Any <section class="panel panel-x"> a module appends to a side bar is adopted as "x".
//
// Pure model (headless, tests/dock.cjs): BUILTINS, builtin(key), normalize(layout), locate(layout, id),
// remove(layout, id), move(layout, id, target), place(layout, id, area), activate(layout, id), isCustom(layout).
globalThis.AtriumDock = (() => {
  const PREF = "workbench.layout", NAMED = "workbench.layouts", SLOTS = "workbench.kindLayouts", AUTO = "general.layoutByKind";
  const AREAS = ["left", "right", "bottom"];
  const MIN = {left: 160, right: 180, bottom: 90, group: 64, floatW: 220, floatH: 140};
  const AREA_NAME = {left: "left side bar", right: "right side bar", bottom: "bottom panel", float: "a floating window"};
  // Panels known by selector. core: always open (no close); scope: the document kind it needs.
  const KNOWN = [
    {id: "projects", title: "Projects", match: ".panel-projects", area: "left", core: true},
    {id: "components", title: "Components", match: ".panel-components", area: "right", core: true},
    {id: "properties", title: "Properties", match: ".panel-properties", area: "right", core: true},
    {id: "messages", title: "Messages", match: ".msg-panel", area: "right", action: "messages"},
    {id: "pcb-list", title: "List", match: ".pl-panel", area: "right", action: "pcb-list"},
    {id: "navigator", title: "Navigator", match: ".panel-navp", area: "left", action: "navigator-panel"},
    {id: "filter", title: "Filter", match: ".panel-query", area: "right", action: "query-panel"},
    {id: "comments", title: "Comments", match: '.ui-dock-panel[data-dock="comments"]', area: "right", action: "comments-panel"},
    {id: "library", title: "Library", match: ".panel-library", area: "right", action: "library-panel"},
    {id: "nets", title: "Nets", match: ".panel-nets", area: "right", action: "nets-panel"},
    {id: "calculators", title: "Calculators", match: ".panel-calc", area: "right", action: "calculators"},
    {id: "clipboard", title: "Clipboard", match: '.ui-dock-panel[data-dock="clipboard"]', area: "right"},
    {id: "scripting", title: "Scripting Console", match: ".script-console", area: "right", action: "scripting-console"}
  ];
  const known = id => KNOWN.find(k => k.id === id);

  // ------------------------------------------------------------------ model (pure)
  const clone = x => JSON.parse(JSON.stringify(x));
  // Floating windows stay below the macOS title bar (--window-caption-height, docs/ui-library.md).
  const captionTop = () => globalThis.document ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-caption-height")) || 0 : 0;
  const G = (panels, extra) => ({panels: panels.slice(), active: panels[0] || null, size: null, ...extra});
  const BUILTINS = Object.freeze({
    default: {name: "Default", areas: {left: [G(["projects"], {auto: true})], right: [G(["properties", "components", "library", "nets", "messages", "pcb-list", "scripting"])], bottom: []}, floats: [], sizes: {}, hide: {}, open: []},
    // One convention in every layout, as in Altium: the project tree and Navigator on the left; Properties,
    // Components, Library, Nets and the other browse panels on the right.
    schematic: {name: "Schematic Capture", areas: {left: [G(["projects"], {auto: true}), G(["navigator"])],
      right: [G(["properties", "components", "library", "comments", "messages", "scripting"])], bottom: []}, floats: [], sizes: {}, hide: {}, open: ["library"]},
    pcb: {name: "PCB Routing", areas: {left: [G(["projects"], {auto: true}), G(["navigator"])],
      right: [G(["properties", "components"]), G(["nets", "filter", "messages", "pcb-list", "scripting"])], bottom: []},
      floats: [], sizes: {right: 344}, hide: {left: true}, open: ["nets"]},
    review: {name: "Review", areas: {left: [G(["projects"], {auto: true}), G(["navigator"])],
      right: [G(["comments", "properties", "components", "messages"])], bottom: []}, floats: [], sizes: {right: 344}, hide: {}, open: ["comments", "navigator"]}
  });
  const BUILTIN_ACTION = {default: "layout-default", schematic: "layout-schematic", pcb: "layout-pcb", review: "layout-review"};
  function builtin(key) {const b = BUILTINS[key]; return b ? normalize({...clone(b), name: b.name}) : null;}
  const num = (v, lo, hi) => Number.isFinite(+v) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, +v)) : null;

  // A valid layout: every panel id once, no empty groups, sane sizes; the core panels always somewhere.
  function normalize(input) {
    const src = input && typeof input === "object" ? input : {};
    const out = {v: 1, name: typeof src.name === "string" ? src.name.slice(0, 80) : null, areas: {left: [], right: [], bottom: []}, floats: [], sizes: {}, hide: {}};
    const seen = new Set();
    const group = g => {
      const panels = (Array.isArray(g?.panels) ? g.panels : []).filter(id => typeof id === "string" && id && !seen.has(id) && seen.add(id));
      if (!panels.length) return null;
      const o = {panels, active: panels.includes(g.active) ? g.active : panels[0], size: num(g.size, MIN.group, 4000)};
      if (g.auto) o.auto = true;
      return o;
    };
    for (const a of AREAS) for (const g of Array.isArray(src.areas?.[a]) ? src.areas[a] : []) {const o = group(g); if (o) out.areas[a].push(o);}
    for (const f of Array.isArray(src.floats) ? src.floats : []) {
      const o = group(f); if (!o) continue;
      out.floats.push({...o, x: num(f.x, 0, 8000) ?? 80, y: num(f.y, 0, 8000) ?? 80, w: num(f.w, MIN.floatW, 4000) ?? 320, h: num(f.h, MIN.floatH, 4000) ?? 360});
    }
    for (const a of AREAS) {const s = num(src.sizes?.[a], MIN[a], 4000); if (s != null) out.sizes[a] = Math.round(s);}
    for (const a of ["left", "right"]) if (src.hide?.[a]) out.hide[a] = true;
    if (Array.isArray(src.open)) out.open = src.open.filter(id => typeof id === "string").slice(0, 64);
    // The startup panels are never lost: put a missing one back where Default has it.
    if (!seen.has("projects")) out.areas.left.unshift({panels: ["projects"], active: "projects", size: null, auto: true});
    if (!seen.has("properties")) {const g = out.areas.right[0]; if (g) g.panels.unshift("properties"); else out.areas.right.push({panels: ["properties"], active: "properties", size: null});}
    if (!seen.has("components")) {const g = out.areas.right[0]; if (g) g.panels.push("components"); else out.areas.right.push({panels:["components"], active:"components", size:null});}
    out.custom = isCustom(out);
    return out;
  }
  function groups(L) {
    const all = [];
    for (const a of AREAS) L.areas[a].forEach((g, i) => all.push({where: a, index: i, group: g}));
    L.floats.forEach((g, i) => all.push({where: "float", index: i, group: g}));
    return all;
  }
  function locate(L, id) {for (const x of groups(L)) {const i = x.group.panels.indexOf(id); if (i >= 0) return {...x, at: i};} return null;}
  function prune(L) {for (const a of AREAS) L.areas[a] = L.areas[a].filter(g => g.panels.length); L.floats = L.floats.filter(g => g.panels.length);}
  // Take id out of its group (mutates L; group objects keep their identity).
  function take(L, id) {
    const at = locate(L, id); if (!at) return null;
    const g = at.group; g.panels.splice(at.at, 1);
    if (g.active === id) g.active = g.panels[Math.min(at.at, g.panels.length - 1)] || null;
    return at;
  }
  function remove(L, id) {const o = clone(L); take(o, id); prune(o); return normalize(o);}
  // target: {area, mode: "tab"|"before"|"after", group} | {area, mode: "end"} | {area: "float", rect: {x, y, w, h}}
  function move(L, id, target) {
    const o = clone(L), from = locate(o, id), t = target || {};
    const list = t.area === "float" ? o.floats : o.areas[t.area];
    if (!list) return normalize(o);
    const tg = t.group != null ? list[t.group] : null;
    if ((t.mode === "tab" || t.mode === "before" || t.mode === "after") && !tg) return normalize(o);
    if (from && tg && from.group === tg && (t.mode === "tab" || tg.panels.length === 1)) {tg.active = id; return normalize(o);}
    take(o, id);
    if (t.area === "float" && t.mode !== "tab") {
      const r = t.rect || {};
      o.floats.push({panels: [id], active: id, size: null, x: r.x ?? 120, y: r.y ?? 120, w: r.w ?? 320, h: r.h ?? 360});
    } else if (t.mode === "tab") {tg.panels.push(id); tg.active = id;}
    else if (t.mode === "before" || t.mode === "after") {
      const i = list.indexOf(tg); list.splice(t.mode === "before" ? i : i + 1, 0, {panels: [id], active: id, size: null});
    } else list.push({panels: [id], active: id, size: null});
    prune(o);
    const out = normalize(o); out.name = null; return out;
  }
  // A panel the layout does not mention yet joins its area's last group (Library joins Components).
  function place(L, id, area) {
    if (locate(L, id)) return L;
    const o = clone(L), list = o.areas[AREAS.includes(area) ? area : "right"];
    const g = list.filter(x => !x.auto).at(-1);
    if (g) g.panels.push(id); else list.push({panels: [id], active: id, size: null});
    return normalize(o);
  }
  function activate(L, id) {const o = clone(L), at = locate(o, id); if (at) at.group.active = id; return normalize(o);}
  function restoreLayout(saved) {
    const layout = saved ? normalize(saved) : builtin("default");
    // Only the stock layout bears the Default name after a move. Migrate its old
    // tool positions without disturbing a saved layout, floating window or split.
    if (saved?.name === "Default" && saved.custom === false) {
      const group = locate(layout, "properties").group;
      for (const id of ["components", "library", "nets", "messages", "pcb-list", "scripting", "history", "clipboard", "calculators"]) {
        const at = locate(layout, id);
        if ((!at && ["components", "library", "nets"].includes(id)) || (at && at.where !== "right" && at.where !== "float")) {
          take(layout, id); group.panels.push(id);
        }
      }
      prune(layout); layout.custom = isCustom(layout);
    }
    return layout;
  }
  // Startup panels placed off Default (the eager snippet waits for this module).
  function isCustom(L) {
    const p = locate(L, "projects"), c = locate(L, "components"), r = locate(L, "properties");
    return !(p?.where === "left" && p.index === 0 && p.group.panels.length === 1 && r?.where === "right" && c?.group === r.group && r.group.active === "properties");
  }

  // ------------------------------------------------------------------ DOM
  const D = globalThis.document;
  const live = !!(D && D.getElementById && D.getElementById("workbench"));
  if (!live) return {BUILTINS, KNOWN, MIN, builtin, normalize, locate, remove, move, place, activate, isCustom, restoreLayout, register() {}, current: () => null};

  const reg = new Map(); // id -> {id, title, el, action, core, area, scope}
  let L = null, host = null, queued = false, saveTimer = 0, drag = null, lastFocused = null, kindSeen = D.body.dataset.kind || "", applying = false, pendingInto = null;
  const pref = (k, fallback) => {try {const v = globalThis.AtriumPref?.get(k); return v === undefined ? fallback : v;} catch {return fallback;}};
  const setPref = (k, v) => {try {globalThis.AtriumPref?.set(k, v);} catch {}};
  function el(tag, cls, text) { return AtriumNavCommon.classedElement(D, tag, cls, text); }
  function info(text) {if (host?.info) host.info(text); else {const s = D.getElementById("status"); if (s) s.textContent = text;}}
  const bottomEl = () => {
    let b = D.getElementById("dock-bottom");
    if (!b) {
      b = el("section", "dock-area dock-bottom"); b.id = "dock-bottom"; b.setAttribute("aria-label", "Bottom panel");
      const foot = D.querySelector("body > .statusbar"); if (foot) foot.before(b); else D.body.append(b);
    }
    return b;
  };
  const areaEl = a => a === "left" ? D.getElementById("navigator") : a === "right" ? D.getElementById("properties") : a === "bottom" ? bottomEl() : null;
  const isOpen = p => !!p?.el && p.el.isConnected && (p.core || !p.el.hidden);
  const title = p => p.title || p.id;

  // ---- registration and adoption
  function slug(s) {return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");}
  function specFor(node) {
    for (const k of KNOWN) if (node.matches?.(k.match)) return {...k};
    if (node.matches?.(".ext-panel[data-extension]")) {
      const t = node.querySelector("h2")?.textContent?.trim() || "Extension";
      return {id: "ext:" + node.dataset.extension + ":" + slug(t), title: t, area: "right"};
    }
    if (node.matches?.("section.panel")) {
      const c = [...node.classList].find(x => x.startsWith("panel-") && x !== "panel");
      const t = node.querySelector("h2")?.textContent?.trim() || node.getAttribute("aria-label") || (c ? c.slice(6) : "Panel");
      return {id: c ? c.slice(6) : slug(t), title: t, area: "right"};
    }
    return null;
  }
  function register(spec) {
    if (!spec?.id) return null;
    const node = spec.element || (spec.match && D.querySelector(spec.match));
    const prev = reg.get(spec.id), p = {...known(spec.id), ...prev, ...spec, el: node || prev?.el || null};
    delete p.element;
    if (!p.el) {reg.set(spec.id, p); return p;}
    if (!p.el.id) p.el.id = "dock-panel-" + slug(p.id);
    p.el.dataset.dockPanel = p.id;
    // Bottom docks size themselves with their own grips; in a group the group decides.
    if (p.el.matches(".msg-panel,.pl-panel,.script-console")) p.el.style.height = "";
    reg.set(p.id, p);
    if (!locate(L, p.id)) L = place(L, p.id, p.area);
    if (pendingInto?.id === p.id) {L = move(L, p.id, pendingInto.target); pendingInto = null;}
    hidden.observe(p.el, {attributes: true, attributeFilter: ["hidden"]});
    // A module usually builds its panel and opens it in one go: the new panel takes its group's tab.
    const fresh = !prev?.el;
    p.wasOpen = isOpen(p);
    if (fresh && p.wasOpen && !p.core) opened(p);
    schedule();
    return p;
  }
  function adopt(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.dataset.dockPanel && reg.get(node.dataset.dockPanel)?.el === node) {schedule(); return;}
    const s = specFor(node); if (s) register({...s, element: node});
  }
  // A panel's hidden attribute: opening one shows its tab (and its side bar); closing picks the next tab.
  const hidden = new MutationObserver(records => {
    for (const r of records) {
      const p = reg.get(r.target.dataset.dockPanel); if (!p) continue;
      const open = isOpen(p); if (open === p.wasOpen) continue; p.wasOpen = open;
      if (open) opened(p);
      schedule(); save();
    }
  });
  function opened(p) {
    L = activate(L, p.id);
    const at = locate(L, p.id);
    if (at && (at.where === "left" || at.where === "right") && D.body.classList.contains("hide-" + at.where)) collapse(at.where, false);
    // A module's panel docked elsewhere leaves the left side bar as it was.
    if (!matchMedia("(max-width:620px)").matches) for (const side of ["left", "right"]) if (side !== at?.where && L.hide[side] && !D.body.classList.contains("hide-" + side)) collapse(side, true);
  }
  // Panels arrive when their module builds them: side bars, the editor column and the body.
  const arrivals = new MutationObserver(records => {for (const r of records) for (const n of r.addedNodes) adopt(n);});
  function watch(node) {if (node && !node.dataset.dockWatched) {node.dataset.dockWatched = "1"; arrivals.observe(node, {childList: true});}}

  // The Properties pane's heading and inspector become one panel, so it can move like the others.
  function wrapProperties() {
    const aside = D.getElementById("properties"); if (!aside || aside.querySelector(":scope .panel-properties")) return;
    const head = aside.querySelector(":scope > .pane-heading"), ins = D.getElementById("inspector");
    if (!ins) return;
    const sec = el("section", "panel panel-properties");
    const h2 = head?.querySelector("h2"); if (h2) {h2.id ||= "properties-heading"; sec.setAttribute("aria-labelledby", h2.id);} else sec.setAttribute("aria-label", "Properties");
    if (head) sec.append(head);
    const summary = D.getElementById("canvas-selection-summary");
    if (summary) sec.append(summary);
    sec.append(ins); aside.prepend(sec);
  }

  // ---- render
  function schedule() {if (queued) return; queued = true; (globalThis.queueMicrotask || (f => Promise.resolve().then(f)))(() => {queued = false; render();});}
  function groupNode(container, key, cls) {
    let g = container.querySelector(':scope > [data-dock-group="' + key + '"]');
    if (!g) {
      g = el("div", "dock-group " + cls); g.dataset.dockGroup = key;
      const tabs = el("div", "dock-tabs ui-tabs ui-editor-tab-strip"), tablist = el("div", "visually-hidden"); tabs.dataset.tabStrip = "dock";
      tablist.setAttribute("role", "tablist");
      tabs.append(tablist, moreButton());
      const body = el("div", "dock-body");
      g.append(tabs, body); watch(body); // Library inserts itself after Components, inside this body
    }
    return g;
  }
  // The tab strip's last control, always there: the tabs that do not fit, then every panel.
  function moreButton() {
    const wrap = el("span", "dock-tab-overflow"), b = el("button", "dock-tab-more ui-button");
    wrap.setAttribute("role", "presentation");
    b.type = "button";
    b.dataset.variant = "quiet"; b.dataset.size = "sm";
    b.setAttribute("aria-label", "Panels"); b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false");
    b.dataset.tooltipLabel = "More panels";
    // The same ⋯ as Messages' More actions: one face for every overflow menu.
    const NS = "http://www.w3.org/2000/svg", icon = D.createElementNS(NS, "svg"), dots = D.createElementNS(NS, "g");
    icon.setAttribute("class", "icon"); icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true");
    dots.setAttribute("fill", "currentColor"); dots.setAttribute("stroke", "none");
    for (const cx of [5, 12, 19]) {const c = D.createElementNS(NS, "circle"); c.setAttribute("cx", cx); c.setAttribute("cy", 12); c.setAttribute("r", 1.7); dots.append(c);}
    icon.append(dots); b.append(icon); wrap.append(b);
    return wrap;
  }
  // VS Code tabs: every tab keeps its full label. Those that do not fit leave the strip for the ⋯ menu, and
  // the active tab always shows (in the last slot when it would fall off the end). Measured once per render
  // or resize of the strip, never per frame.
  function fitTabs(strip) {
    const wrap = strip.querySelector(":scope > .dock-tab-overflow");
    if (!wrap) return;
    const tabs = [...strip.querySelectorAll(":scope > .dock-tab-wrap")];
    for (const t of tabs) t.classList.remove("dock-tab-hidden", "dock-tab-squeezed");
    if (strip.hidden || !tabs.length) return;
    // Whole pixels, rounded up as calc-size() (or AtriumWholePixels, without it) lays the tabs out.
    const budget = strip.clientWidth - wrap.offsetWidth, widths = tabs.map(t => Math.ceil(t.getBoundingClientRect().width - .01));
    strip.scrollLeft = 0;
    if (widths.reduce((a, b) => a + b, 0) <= budget) return;
    const active = Math.max(0, tabs.findIndex(t => t.classList.contains("is-active")));
    const keep = new Set();
    let used = 0;
    for (let i = 0; i < tabs.length && used + widths[i] <= budget; i++) {keep.add(i); used += widths[i];}
    if (!keep.has(active)) {
      for (const i of [...keep].reverse()) {if (used + widths[active] <= budget) break; keep.delete(i); used -= widths[i];}
      keep.add(active);
      if (used + widths[active] > budget) tabs[active].classList.add("dock-tab-squeezed"); // too narrow for even its label
    }
    tabs.forEach((t, i) => t.classList.toggle("dock-tab-hidden", !keep.has(i)));
  }
  // The tabs the strip has no room for, in strip order.
  function hiddenTabs(strip) {
    return [...strip.querySelectorAll(":scope > .dock-tab-wrap.dock-tab-hidden > [data-dock-tab]")];
  }
  // The ⋯ menu: the hidden tabs, then every panel with a check on each open one. A closed panel opens as
  // a tab of this group; an open one comes to the front where it is.
  function overflowMenu(more) {
    const strip = more.closest(".dock-tabs"), key = strip.parentElement.dataset.dockGroup || "";
    const front = p => {if (!p) return; opened(p); render(); save(); focusPanel(p);};
    const hiddenEntries = hiddenTabs(strip).map(t => ({label: t.textContent, enabled: true, run: () => front(reg.get(t.dataset.dockTab))}));
    const panels = panelChoices().map(id => {
      const p = reg.get(id), on = isOpen(p) && !!locate(L, id);
      return {label: title(p || known(id)), checked: on, enabled: true, run: () => on ? front(p) : openInto(id, key)};
    });
    const entries = hiddenEntries.length ? [...hiddenEntries, "-", ...panels] : panels;
    globalThis.AtriumLazy?.need?.("AtriumContextMenu").then(menu => {if (more.isConnected) menu.dropdown(more, entries, {host: host || globalThis.AtriumNavHost});},
      e => info(e.message));
  }
  // Window › Panels' order with Projects first, then any other panel that can open (extensions).
  function panelChoices() {
    const ids = ["projects", ...[...D.querySelectorAll(".menubar [data-dock-target]")].map(b => b.dataset.dockTarget)];
    for (const [id, p] of reg) if (!ids.includes(id) && (isOpen(p) || p.action)) ids.push(id);
    return [...new Set(ids)].filter(id => reg.get(id) || known(id));
  }
  // A closed panel joins the group as a tab, then opens; a panel whose module is not loaded yet joins on arrival.
  function openInto(id, key) {
    const [area, group] = key.split(":"), target = {area, mode: "tab", group: +group};
    if (reg.get(id)?.el) {L = move(L, id, target); render(); save();} else pendingInto = {id, target};
    openPanel(id);
  }
  const stripObserver = typeof ResizeObserver === "function" ? new ResizeObserver(entries => {for (const en of entries) fitTabs(en.target);}) : null;
  function renderTabs(g, gr, openPanels, label) {
    const strip = g.firstElementChild;
    const show = openPanels.length > 1 || openPanels.some(p => p.alwaysTab);
    const chrome = openPanels.some(p => p.id === "properties" || p.id === "components");
    strip.hidden = !show;
    if (!strip.dataset.overflowWatched && stripObserver) {strip.dataset.overflowWatched = "1"; stripObserver.observe(strip);}
    strip.classList.toggle("editor-chrome-tabs",chrome);
    const tablist = strip.firstElementChild;
    tablist.setAttribute("aria-label", label);
    // Each visible close button sits beside its tab. The tablist owns only tabs.
    if (show) tablist.setAttribute("aria-owns", openPanels.map(p => "dock-tab-" + slug(p.id)).join(" "));
    else tablist.removeAttribute("aria-owns");
    g.classList.toggle("is-tabbed", show);
    const want = show ? openPanels : [];
    const have = [...strip.querySelectorAll(":scope > .dock-tab-wrap")];
    have.forEach((w, i) => {if (!want[i] || w.dataset.tabFor !== want[i].id) w.remove();});
    want.forEach((p, i) => {
      let w = strip.children[i + 1];
      if (!w || w.dataset.tabFor !== p.id) {
        w = el("span", "dock-tab-wrap ui-tab-wrap"); w.dataset.tabFor = p.id; w.setAttribute("role", "presentation");
        const t = el("button", "dock-tab ui-tab", title(p)); t.type = "button"; t.setAttribute("role", "tab"); t.dataset.dockTab = p.id; t.id = "dock-tab-" + slug(p.id);
        t.setAttribute("aria-controls", p.el.id);
        w.append(t); globalThis.AtriumWorkbench?.wholePixels(t); // the × and the next tab follow on whole pixels
        if (!p.core) {t.setAttribute("aria-keyshortcuts", "Delete"); const x = el("button", "dock-tab-close ui-chrome-action ui-chrome-action-compact ui-dismiss-glyph", "×"); x.type = "button"; x.dataset.hover = "ink"; x.tabIndex = -1; x.dataset.dockClose = p.id; x.title = "Close " + title(p); x.setAttribute("aria-label", "Close " + title(p)); w.append(x);}
        strip.insertBefore(w, strip.children[i + 1] || null);
      }
      const t = w.firstElementChild, on = p.id === gr.active;
      w.classList.toggle("editor-chrome-tab",chrome);
      if (t.textContent !== title(p)) t.textContent = title(p);
      t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1; w.classList.toggle("is-active", on);
      const close = w.querySelector(".dock-tab-close");
      if (close) close.tabIndex = on ? 0 : -1;
    });
  }
  function indicatorRect(strip) {
    const slide = strip.querySelector(".dock-tab-slide");
    if (slide) return slide.getBoundingClientRect();
    const active = strip.querySelector(".dock-tab-wrap.is-active");
    if (!active) return null;
    const {left,width} = active.getBoundingClientRect();
    const inset = parseFloat(getComputedStyle(active,"::after").insetInlineStart) || 0;
    return {left:left + inset,width:Math.max(0,width - inset * 2)};
  }
  function animateTabChange(strip, previous) {
    const motion = globalThis.AtriumMotionUI;
    const old = strip.querySelector(".dock-tab-slide");
    if (old) {motion?.cancel(old); old.remove(); strip.classList.remove("dock-sliding");}
    if (strip.hidden || !previous || !motion?.moves()) return;
    const bounds = strip.getBoundingClientRect(), next = indicatorRect(strip);
    if (!next?.width || !previous.width || next.left === previous.left && next.width === previous.width) return;
    const indicator = el("span","dock-tab-slide");
    indicator.setAttribute("aria-hidden","true");
    indicator.style.width = next.width + "px";
    strip.append(indicator); strip.classList.add("dock-sliding");
    const x = edge => edge.left - bounds.left + strip.scrollLeft;
    const to = "translateX(" + x(next) + "px)";
    indicator.style.transform = to;
    motion.enter(indicator,{from:{transform:"translateX(" + x(previous) + "px) scaleX(" + (previous.width / next.width) + ")"},
      to:{transform:to},duration:"base",done:() => {indicator.remove(); strip.classList.remove("dock-sliding");}});
  }
  function fillGroup(g, gr, where) {
    // A panel its module moved into a dialog of its own (Calculators' float button) is left there.
    const body = g.lastElementChild, ps = gr.panels.map(id => reg.get(id)).filter(p => p?.el && !p.el.closest("dialog"));
    // Move only what is out of place: re-parenting resets a panel's scroll position.
    let i = 0;
    for (const p of ps) {if (body.children[i] !== p.el) body.insertBefore(p.el, body.children[i] || null); i++;}
    const open = ps.filter(isOpen);
    if (!open.some(p => p.id === gr.active)) gr.active = open[0]?.id || gr.active;
    const strip = g.firstElementChild, previous = g.dataset.activePanel;
    const switched = previous && previous !== gr.active;
    const priorRect = switched && globalThis.AtriumMotionUI?.moves() && indicatorRect(strip);
    if (previous !== gr.active) g.dataset.activePanel = gr.active || "";
    for (const p of ps) {
      const on = p.id === gr.active, tabbed = open.length > 1 || !!p.alwaysTab;
      p.el.classList.toggle("dock-inactive", !on);
      p.el.classList.toggle("dock-tabbed", tabbed);
      if (tabbed && !p.el.hasAttribute("role")) {
        p.el.dataset.dockRole = "1";
        p.labelBeforeTab = p.el.getAttribute("aria-labelledby");
        p.el.setAttribute("role", "tabpanel");
      }
      if (tabbed && p.el.dataset.dockRole) p.el.setAttribute("aria-labelledby", "dock-tab-" + slug(p.id));
      if (!tabbed && p.el.dataset.dockRole) {
        p.el.removeAttribute("role");
        if (p.labelBeforeTab) p.el.setAttribute("aria-labelledby", p.labelBeforeTab); else p.el.removeAttribute("aria-labelledby");
        delete p.el.dataset.dockRole;
      }
      if (!tabbed && !p.el.hasAttribute("aria-label") && !p.el.hasAttribute("aria-labelledby")) p.el.setAttribute("aria-label", title(p));
    }
    renderTabs(g, gr, open, (where === "float" ? "Floating" : AREA_NAME[where].replace(/^./, c => c.toUpperCase())) + " tabs");
    if (switched) animateTabChange(strip,priorRect);
    g.classList.toggle("dock-empty", !open.length);
    g.classList.toggle("dock-auto", !!gr.auto && !gr.size);
    g.style.flex = gr.size ? "0 0 " + gr.size + "px" : "";
    return open.length;
  }
  function sash(kind, extra) {
    const s = el("div", "dock-sash dock-sash-" + kind); s.setAttribute("role", "separator"); s.tabIndex = 0;
    s.dataset.sash = kind; if (extra) Object.assign(s.dataset, extra);
    return s;
  }
  function revealActiveTabs() {
    for (const strip of D.querySelectorAll(".dock-tabs")) fitTabs(strip);
  }
  function render() {
    if (!L) return;
    const focus = D.activeElement;
    for (const a of AREAS) {
      const box = areaEl(a); if (!box) continue;
      box.classList.add("dock-area"); box.dataset.dockArea = a;
      const list = L.areas[a], keys = new Set();
      let visible = 0, prevVisible = null;
      list.forEach((gr, i) => {
        const key = a + ":" + i; keys.add(key);
        const g = groupNode(box, key, "dock-in-" + a);
        const anchor = box.querySelector(":scope > .dock-sash-" + a);
        const want = [...box.querySelectorAll(":scope > .dock-group")][i];
        if (want !== g) box.insertBefore(g, want || anchor || null);
        const n = fillGroup(g, gr, a);
        // A sash between this group and the visible one before it.
        let s = g.previousElementSibling?.matches?.(".dock-sash-group") ? g.previousElementSibling : null;
        if (n && prevVisible != null) {
          if (!s) {s = sash("group", {area: a}); g.before(s);}
          s.dataset.group = String(prevVisible); s.setAttribute("aria-orientation", a === "bottom" ? "vertical" : "horizontal");
          s.setAttribute("aria-label", "Resize " + title(reg.get(list[prevVisible].active) || {id: "panel"}) + " group");
        } else s?.remove();
        if (n) {prevVisible = i; visible++;}
      });
      for (const g of box.querySelectorAll(":scope > .dock-group")) if (!keys.has(g.dataset.dockGroup)) {
        // Panels still inside a dropped group go back to the area (the next render places them).
        if (g.previousElementSibling?.matches?.(".dock-sash-group")) g.previousElementSibling.remove();
        for (const p of [...g.lastElementChild.children]) box.append(p);
        g.remove();
      }
      for (const s of box.querySelectorAll(":scope > .dock-sash-group")) if (!s.nextElementSibling?.matches?.(".dock-group")) s.remove();
      // The last visible group fills what is left.
      const vis = [...box.querySelectorAll(":scope > .dock-group:not(.dock-empty)")];
      vis.forEach((g, i) => g.classList.toggle("dock-fill", i === vis.length - 1));
      if (!box.querySelector(":scope > .dock-sash-" + a)) box.append(sash(a));
      const edge = box.querySelector(":scope > .dock-sash-" + a);
      edge.setAttribute("aria-orientation", a === "bottom" ? "horizontal" : "vertical");
      edge.setAttribute("aria-label", "Resize " + AREA_NAME[a]);
      box.append(edge);
      const titles = vis.map(g => title(reg.get(L.areas[a][+g.dataset.dockGroup.split(":")[1]]?.active) || {id: ""})).filter(Boolean);
      if (a !== "bottom") D.body.classList.toggle("dock-empty-" + a, !visible);
      else box.hidden = !visible;
      if (titles.length) box.setAttribute("aria-label", titles.join(", "));
    }
    renderFloats();
    sizes();
    for (const border of D.querySelectorAll(".dock-sash-group")) syncGroupSash(border);
    revealActiveTabs();
    syncMenus();
    // Settle deferred Properties before a newly shown field can take an edit.
    host?.revealInspector?.();
    if (focus && focus !== D.activeElement && focus.isConnected && !focus.closest(".dock-inactive")) try {focus.focus({preventScroll: true});} catch {}
  }
  function renderFloats() {
    const keep = new Set();
    L.floats.forEach((f, i) => {
      const key = "float:" + i; keep.add(key);
      let w = D.querySelector('.dock-float[data-dock-float="' + key + '"]');
      if (!w) {
        w = el("div", "dock-float"); w.dataset.dockFloat = key; w.setAttribute("role", "region");
        const bar = el("div", "dock-float-bar"); bar.tabIndex = 0; bar.setAttribute("role", "group");
        const name = el("span", "dock-float-title"), back = el("button", "dock-float-dock ui-chrome-action ui-chrome-action-compact", "Dock"); back.type = "button"; back.dataset.hover = "ink";
        bar.append(name, back);
        const g = groupNode(w, key, "dock-in-float");
        w.append(bar, g); D.body.append(w);
        floatObserver?.observe(w);
      }
      const g = w.querySelector(":scope > .dock-group");
      const n = fillGroup(g, f, "float");
      const t = title(reg.get(f.active) || {id: "Panel"});
      w.querySelector(".dock-float-title").textContent = t;
      w.setAttribute("aria-label", t);
      const back = w.querySelector(".dock-float-dock"); back.title = "Dock " + t + " back to its side bar"; back.setAttribute("aria-label", back.title);
      w.querySelector(".dock-float-bar").setAttribute("aria-label", t + " floating window: arrows move, Alt+arrows resize");
      w.setAttribute("aria-label", t + " (floating)");
      w.hidden = !n;
      const vw = innerWidth || 1200, vh = innerHeight || 800, top = captionTop(), fw = Math.min(f.w, vw - 16), fh = Math.min(f.h, vh - 16 - top);
      Object.assign(w.style, {left: Math.max(0, Math.min(f.x, vw - fw)) + "px", top: Math.max(top, Math.min(f.y, vh - fh)) + "px", width: fw + "px", height: fh + "px"});
    });
    for (const w of D.querySelectorAll(".dock-float")) if (!keep.has(w.dataset.dockFloat)) {
      for (const p of [...w.querySelectorAll(":scope > .dock-group > .dock-body > *")]) (areaEl(reg.get(p.dataset.dockPanel)?.area || "left") || D.body).append(p);
      w.remove();
    }
  }
  // Sizes are root CSS variables: index.html sets them before first paint.
  function sizes() {
    const r = D.documentElement.style, s = L.sizes;
    s.left ? r.setProperty("--sidebar", "min(" + s.left + "px,45vw)") : r.removeProperty("--sidebar");
    s.right ? r.setProperty("--properties", "min(" + s.right + "px,45vw)") : r.removeProperty("--properties");
    s.bottom ? r.setProperty("--dock-bottom-h", "min(" + s.bottom + "px,70vh)") : r.removeProperty("--dock-bottom-h");
  }
  function collapse(side, hide) {
    D.body.classList.toggle("hide-" + side, hide);
    for (const t of D.querySelectorAll('[data-action="toggle-' + side + '"]')) t.setAttribute("aria-expanded", String(!hide));
    try {globalThis.dispatchEvent(new Event("resize"));} catch {}
  }

  // ---- persistence
  function snapshot() {
    const o = clone(L);
    // A narrow window hides both side bars by itself: keep the collapsed state chosen at full width.
    if (!matchMedia("(max-width:620px)").matches) {o.hide = {}; for (const a of ["left", "right"]) if (D.body.classList.contains("hide-" + a)) o.hide[a] = true;}
    delete o.open;
    o.custom = isCustom(o);
    return o;
  }
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (!L) return;
      const o = snapshot(); L.hide = o.hide;
      lastSaved = JSON.stringify(o); setPref(PREF, o);
      if (pref(AUTO, false) && kindSeen) setPref(SLOTS, {...(pref(SLOTS, {}) || {}), [kindSeen]: o});
    }, 150);
  }
  let lastSaved = "";
  // A layout from Import Settings (or another window) applies at once.
  function prefChanged({key, value}) {
    if (key === PREF && value && JSON.stringify(value) !== lastSaved) apply(value, {quiet: true});
    if (key === NAMED || key === AUTO) syncMenus();
  }

  // ---- applying layouts
  function opener(p) {
    const close = p.el?.querySelector(':scope > header button[aria-label^="Close"], :scope > header button[title^="Close"], :scope > .pane-heading button[aria-label^="Close"]');
    return close;
  }
  function closePanel(id) {
    const p = reg.get(id); if (!p || p.core || !isOpen(p)) return;
    const current = D.activeElement, group = current?.closest(".dock-group");
    const back = current?.dataset.dockTab === id || current?.dataset.dockClose === id || p.el.contains(current);
    const b = opener(p);
    if (b) b.click(); else if (p.action) host?.act?.(p.action);
    if (back) requestAnimationFrame(() => {
      if (isOpen(p) || (D.activeElement !== D.body && D.activeElement !== current)) return;
      if (!group?.getClientRects().length) {globalThis.AtriumShell?.focusEditor(); return;}
      const tab = group.querySelector(".dock-tabs:not([hidden]) .dock-tab[aria-selected=true]");
      if (tab) tab.focus(); else globalThis.AtriumShell?.focusEditor();
    });
  }
  // An open panel to the front (Place › Component).
  function reveal(id) {const p = reg.get(id); if (!isOpen(p)) return false; opened(p); schedule(); save(); return true;}
  function openPanel(id) {
    const p = reg.get(id) || known(id), kind = D.body.dataset.kind;
    if (!p || p.core || isOpen(reg.get(id)) || !p.action || p.scope && p.scope !== kind) return;
    host?.act?.(p.action);
  }
  // Window › Panels: open a closed panel, bring one behind a tab to the front, or close the front one.
  function toggle(id) {
    const p = reg.get(id);
    if (!isOpen(p)) {openPanel(id); return;}
    const at = locate(L, id);
    if (!at) return;
    const side = at.where === "left" || at.where === "right";
    if (at.group.active === id && (!side || !D.body.classList.contains("hide-" + at.where))) {
      if (!p.core) closePanel(id);
      else if (side) collapse(at.where, true);
      else focusPanel(p);
    } else {
      opened(p);
      render();
      focusPanel(p);
    }
    syncMenus();
    save();
  }
  function apply(layout, {quiet = false, name = null} = {}) {
    applying = true;
    const want = normalize(layout);
    if (name) want.name = name;
    L = reg.size ? [...reg.values()].reduce((acc, p) => place(acc, p.id, p.area), want) : want;
    if (name) L.name = name;
    const narrow = matchMedia("(max-width:620px)").matches;
    if (!narrow) for (const a of ["left", "right"]) collapse(a, !!want.hide[a]);
    if (Array.isArray(want.open)) {
      const keep = new Set(want.open);
      for (const p of reg.values()) if (!p.core && isOpen(p) && !keep.has(p.id)) closePanel(p.id);
      for (const id of want.open) openPanel(id);
    }
    render(); save();
    applying = false;
    if (!quiet) info("Layout: " + (L.name || "custom"));
  }
  function named() {const n = pref(NAMED, {}); return n && typeof n === "object" && !Array.isArray(n) ? n : {};}
  function applyBuiltin(key) {const b = builtin(key); if (b) apply(b, {name: b.name});}
  function applyNamed(name) {const n = named()[name]; if (n) apply({...n, open: n.open || []}, {name}); else info("No layout named " + name + ".");}
  function currentOpen() {return [...reg.values()].filter(p => !p.core && isOpen(p)).map(p => p.id);}

  // ---- menus
  function syncMenus() {
    const C = globalThis.AtriumNavCommon;
    // Window › Panels: a check on each open panel (a core panel: when it is the one in front).
    for (const b of D.querySelectorAll(".menu-items [data-dock-target]")) {
      const id = b.dataset.dockTarget, at = locate(L, id), p = reg.get(id);
      const on = !!at && isOpen(p) && (!p.core || at.group.active === id) && !D.body.classList.contains("hide-" + at.where);
      b.setAttribute("role", "menuitemcheckbox"); b.setAttribute("aria-checked", String(on)); b.dataset.checked = String(on);
    }
    for (const [key, action] of Object.entries(BUILTIN_ACTION)) for (const b of D.querySelectorAll('[data-action="' + action + '"]'))
      b.setAttribute("aria-checked", String(L?.name === BUILTINS[key].name));
    C?.setChecked?.("layout-auto", !!pref(AUTO, false));
    C?.setChecked?.("zen-mode", D.body.classList.contains("dock-zen"));
    const marker = D.querySelector(".menubar hr[data-dock-user]"); if (!marker) return;
    const list = marker.parentElement, names = Object.keys(named()).sort((a, b) => a.localeCompare(b));
    for (const b of list.querySelectorAll(":scope > [data-dock-layout]")) if (!names.includes(b.dataset.dockLayout)) b.remove();
    let after = marker.previousElementSibling;
    for (const n of names) {
      let b = list.querySelector(':scope > [data-dock-layout="' + CSS.escape(n) + '"]');
      if (!b) {b = el("button", null, n); b.type = "button"; b.setAttribute("role", "menuitemradio"); b.dataset.dockLayout = n; after.after(b);}
      b.setAttribute("aria-checked", String(L?.name === n)); after = b;
    }
  }

  // ---- dialogs (Save Current…, Manage…, Move Panel…)
  function dialog(opts) {return globalThis.AtriumShell.dialog({sheet: true, ...opts});}
  function field(label, control) {const l = el("label", "work-row"); control.classList.add("ui-field"); l.append(el("span", null, label), control); return l;}
  function saveDialog() {
    const input = el("input"); input.type = "text"; input.maxLength = 80; input.value = L.name && !BUILTINS[Object.keys(BUILTINS).find(k => BUILTINS[k].name === L.name)] ? L.name : "";
    input.placeholder = "My layout"; input.setAttribute("aria-label", "Layout name");
    const note = el("small", null, "Saved with your preferences (not the project), so Export Settings carries it. The open panels are saved too.");
    const err = el("p", "dock-error"); err.setAttribute("role", "alert"); err.hidden = true;
    const run = () => {
      const name = input.value.trim();
      if (!name) {err.textContent = "Enter a name."; err.hidden = false; return false;}
      if (Object.values(BUILTINS).some(b => b.name.toLowerCase() === name.toLowerCase())) {err.textContent = "“" + name + "” is a built-in layout: choose another name."; err.hidden = false; return false;}
      const o = snapshot(); o.name = name; o.open = currentOpen();
      setPref(NAMED, {...named(), [name]: o}); L.name = name; syncMenus(); save();
      info("Saved layout “" + name + "”. Window › Layouts lists it."); return true;
    };
    const d = dialog({title: "Save current layout", className: "dock-dialog", body: [field("Name", input), err, note],
      actions: [{label: "Cancel"}, {label: "Save", variant: "primary", default: true, run}]});
    input.focus(); input.select();
    return d;
  }
  function manageDialog() {
    const list = el("div", "dock-manage"); list.setAttribute("role", "list");
    const draw = () => {
      list.replaceChildren();
      const n = named(), names = Object.keys(n).sort((a, b) => a.localeCompare(b));
      if (!names.length) list.append(el("p", "empty-state", "No saved layouts yet. Window › Layouts › Save Current… adds one."));
      for (const name of names) {
        const row = el("div", "dock-manage-row"); row.setAttribute("role", "listitem");
        const use = el("button", "ui-button", "Apply"), del = el("button", "ui-button", "Delete"); use.type = del.type = "button";
        use.setAttribute("aria-label", "Apply " + name); del.setAttribute("aria-label", "Delete " + name);
        use.onclick = () => {applyNamed(name); list.closest("dialog")?.close();};
        del.onclick = () => {const m = named(); delete m[name]; setPref(NAMED, m); if (L.name === name) L.name = null; syncMenus(); draw(); (list.querySelector("button") || list.closest("dialog")?.querySelector(".ui-dialog-actions button"))?.focus();};
        row.append(el("span", "dock-manage-name", name), use, del); list.append(row);
      }
    };
    draw();
    const auto = el("input", "ui-checkbox"); auto.type = "checkbox"; auto.checked = !!pref(AUTO, false);
    auto.onchange = () => setAuto(auto.checked);
    const autoRow = el("label", "dock-auto-row"); autoRow.append(auto, el("span", null, " Switch layout by document kind (Schematic Capture for sheets, PCB Routing for boards)"));
    return dialog({title: "Workspace layouts", className: "dock-dialog", body: [list, autoRow], actions: [{label: "Close", variant: "primary"}]});
  }
  function panelAt(node) {const n = node?.closest?.("[data-dock-panel]"); return n ? reg.get(n.dataset.dockPanel) : null;}
  function moveDialog(preset) {
    const panels = [...reg.values()].filter(isOpen).sort((a, b) => title(a).localeCompare(title(b)));
    const which = el("select"); which.setAttribute("aria-label", "Panel");
    for (const p of panels) which.add(new Option(title(p), p.id));
    const cur = preset || panelAt(D.activeElement)?.id || lastFocused; if (cur && panels.some(p => p.id === cur)) which.value = cur;
    const where = el("select"); where.setAttribute("aria-label", "Destination");
    const fill = () => {
      where.replaceChildren();
      const id = which.value, from = locate(L, id);
      for (const a of AREAS) {
        const og = el("optgroup"); og.label = AREA_NAME[a].replace(/^./, c => c.toUpperCase());
        L.areas[a].forEach((g, i) => {
          const names = g.panels.filter(x => x !== id && isOpen(reg.get(x))).map(x => title(reg.get(x)));
          if (names.length && !(from && from.where === a && from.index === i && g.panels.length === 1)) og.append(new Option("Tab with " + names.join(", "), JSON.stringify({area: a, mode: "tab", group: i})));
        });
        og.append(new Option("New group", JSON.stringify({area: a, mode: "end"})));
        where.append(og);
      }
      where.append(new Option("Floating window", JSON.stringify({area: "float"})));
    };
    which.onchange = fill; fill();
    const run = () => {
      const id = which.value; if (!id) return true;
      let t = JSON.parse(where.value || "null"); if (!t) return true;
      if (t.area === "float") t = {area: "float", rect: {x: Math.round((innerWidth - 340) / 2), y: Math.round((innerHeight - 380) / 3), w: 340, h: 380}};
      moveTo(id, t);
      setTimeout(() => focusPanel(reg.get(id)), 0);
      return true;
    };
    const key = globalThis.AtriumKeymap?.hintKey("focus-part-next", host?.doc?.()?.kind);
    const note = el("small", null, "Drag a tab or a panel's title bar to do the same with the mouse.");
    if (key) note.append(" ", AtriumShortcut.render(key, {variant:"inline"}), " moves focus between panels.");
    const d = dialog({title: "Move panel", className: "dock-dialog", body: [field("Panel", which), field("Move to", where),
      note],
    actions: [{label: "Cancel"}, {label: "Move", variant: "primary", default: true, run}]});
    if (!panels.length) info("Open a panel first (Window › Panels).");
    which.focus();
    return d;
  }
  // Back to the panel's own side, as a tab in that side's last group (where it would open by default).
  function dockBack(id) {
    const area = reg.get(id)?.area || known(id)?.area || "left", list = L.areas[area];
    let g = -1; list.forEach((x, i) => {if (!x.auto && !x.panels.includes(id)) g = i;});
    moveTo(id, g >= 0 ? {area, mode: "tab", group: g} : {area, mode: "end"});
  }
  function moveTo(id, target) {
    const before = locate(L, id);
    L = move(L, id, target);
    const at = locate(L, id);
    if (at && (at.where === "left" || at.where === "right") && D.body.classList.contains("hide-" + at.where)) collapse(at.where, false);
    render(); save();
    if (at && (!before || before.where !== at.where || before.index !== at.index)) info("Moved " + title(reg.get(id) || {id}) + " to " + (target.mode === "tab" ? "a tab in the " : target.mode === "before" || target.mode === "after" ? "a new group in the " : at.where === "float" ? "" : "the ") + AREA_NAME[at.where] + ".");
  }

  // ---- focus: F6 / Shift+F6 through side-bar groups, editor panes, bottom groups and floating windows
  function parts() {
    const out = [], visible = n => n && n.isConnected && n.getClientRects().length && !n.closest("[hidden]");
    const grp = a => [...(areaEl(a)?.querySelectorAll(":scope > .dock-group:not(.dock-empty)") || [])].filter(visible).map(g => ({kind: "group", el: g}));
    out.push(...grp("left"));
    const panes = host?.panes?.() || [];
    if (panes.length) for (const p of panes) {if (visible(p.canvas)) out.push({kind: "pane", el: p.canvas});}
    else {const c = D.getElementById("canvas"); if (visible(c)) out.push({kind: "pane", el: c});}
    out.push(...grp("bottom"), ...grp("right"));
    for (const w of D.querySelectorAll(".dock-float:not([hidden]) > .dock-group")) if (visible(w)) out.push({kind: "group", el: w});
    // Non-modal tool windows (Thermal, Signal Integrity) and the menu bar are parts too.
    for (const w of D.querySelectorAll("dialog.work-dialog[open]")) if (!w.matches(":modal") && visible(w)) out.push({kind: "window", el: w});
    const bar = D.querySelector(".menubar");
    if (visible(bar?.querySelector(".work-menu > summary"))) out.push({kind: "menu", el: bar});
    return out;
  }
  const FOCUSABLE = 'input:not([type=hidden]):not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"],button:not(:disabled),a[href],summary';
  function focusPanel(p) {
    if (!p?.el) return false;
    if (p.id === "properties") host?.revealInspector?.();
    const vis = n => n.getClientRects().length && !n.closest("[hidden],.dock-inactive");
    const inner = [...p.el.querySelectorAll(FOCUSABLE)].filter(n => vis(n) && !n.closest("header,.pane-heading,.msg-head,.pl-head"));
    const t = inner[0] || [...p.el.querySelectorAll(FOCUSABLE)].find(vis);
    if (t) t.focus(); else {p.el.tabIndex = -1; p.el.focus();}
    lastFocused = p.id;
    return true;
  }
  function focusPart(step) {
    const list = parts(); if (!list.length) return;
    const a = D.activeElement;
    let at = list.findIndex(x => x.el === a || x.el.contains?.(a) || x.kind === "pane" && x.el.parentElement?.contains(a) && !a.closest?.(".dock-group"));
    const next = list[at < 0 ? (step > 0 ? 0 : list.length - 1) : (at + step + list.length) % list.length];
    if (next.kind === "pane") {
      if (next.el.inert && globalThis.AtriumDocViews?.focusPane) globalThis.AtriumDocViews.focusPane(next.el);
      else next.el.focus();
      const panes = list.filter(x => x.kind === "pane");
      info("Focus: editor" + (panes.length > 1 ? " pane " + (panes.indexOf(next) + 1) : ""));
    }
    else if (next.kind === "menu") {next.el.querySelector(".work-menu > summary").focus(); info("Focus: menu bar");}
    else if (next.kind === "window") {
      const all = [...next.el.querySelectorAll(FOCUSABLE)].filter(n => n.tabIndex >= 0 && n.getClientRects().length && !n.closest("[hidden]"));
      (all.find(n => !n.closest("[class$=-head]")) || all[0] || next.el).focus();
      info("Focus: " + (next.el.querySelector("h2")?.textContent || "window"));
    }
    else {
      const key = next.el.dataset.dockGroup, [w, i] = key.split(":"), gr = w === "float" ? L.floats[+i] : L.areas[w][+i], p = reg.get(gr?.active);
      focusPanel(p); info("Focus: " + title(p || {id: "panel"}));
    }
  }

  // ---- zen mode: only the editor and the menu bar
  function zen(on) {
    const now = on ?? !D.body.classList.contains("dock-zen");
    D.body.classList.toggle("dock-zen", now);
    syncMenus();
    try {globalThis.dispatchEvent(new Event("resize"));} catch {}
    const KM = globalThis.AtriumKeymap, key = KM?.bindingsFor?.("zen-mode")?.[0]?.key;
    info(now ? "Zen mode: " + (key ? KM.display(key) : "Window › Zen Mode") + " again restores the panels." : "Zen mode off.");
    if (now) (host?.canvas?.() || D.getElementById("canvas"))?.focus();
  }

  // ---- drag and drop
  const HANDLE = ".dock-tab, [data-dock-panel] > header, [data-dock-panel] > .pane-heading, [data-dock-panel] > .script-bar";
  const NOT_HANDLE = "input,select,textarea,a,[contenteditable],.dock-tab-close,header button:not(.dock-tab),.pane-heading button";
  function startDrag(e) {
    if (e.button !== 0 || drag || matchMedia("(max-width:620px)").matches) return;
    const h = e.target.closest?.(HANDLE); if (!h || e.target.closest(NOT_HANDLE) && !e.target.closest(".dock-tab")) return;
    const id = h.dataset.dockTab || h.parentElement?.dataset.dockPanel; if (!id || !reg.get(id)) return;
    drag = {id, x: e.clientX, y: e.clientY, started: false, pointer: e.pointerId, target: null};
    addEventListener("pointermove", dragMove, true); addEventListener("pointerup", dragEnd, true); addEventListener("pointercancel", dragCancel, true);
    addEventListener("keydown", dragKey, true);
  }
  function dragMove(e) {
    if (!drag) return;
    if (!drag.started) {
      if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 6) return;
      drag.started = true; D.body.classList.add("dock-dragging");
      drag.ghost = el("div", "dock-ghost", title(reg.get(drag.id))); drag.ghost.setAttribute("aria-hidden", "true");
      drag.preview = el("div", "dock-preview"); drag.preview.setAttribute("aria-hidden", "true");
      D.body.append(drag.preview, drag.ghost);
    }
    e.preventDefault();
    drag.ghost.style.transform = "translate(" + (e.clientX + 12) + "px," + (e.clientY + 10) + "px)";
    const t = hitTest(e.clientX, e.clientY);
    drag.target = t?.target || null;
    const r = t?.rect;
    drag.preview.hidden = !r;
    const motion = globalThis.AtriumMotion;
    if (motion?.butterEnabled()) {
      drag.hasMotionGuide = true;
      motion.placeBox(drag.preview,r,{direct:t?.target?.area === "float"});
    } else {
      if (drag.hasMotionGuide) { motion?.placeBox(drag.preview,null); drag.hasMotionGuide = false; }
      if (r) Object.assign(drag.preview.style, {left:r.left + "px",top:r.top + "px",width:r.width + "px",height:r.height + "px"});
    }
    drag.preview.dataset.mode = t?.target?.mode || t?.target?.area || "";
  }
  function box(l, t, w, h) {return {left: l, top: t, width: Math.max(0, w), height: Math.max(0, h)};}
  // Where a drop at (x, y) lands, and the rectangle the preview shows.
  function hitTest(x, y) {
    const stack = D.elementsFromPoint ? D.elementsFromPoint(x, y) : [D.elementFromPoint(x, y)];
    const n = stack.find(s => s && !s.closest?.(".dock-ghost,.dock-preview"));
    if (!n) return null;
    const g = n.closest?.(".dock-group:not(.dock-empty)");
    if (g) {
      const [where, i] = g.dataset.dockGroup.split(":"), r = g.getBoundingClientRect(), idx = +i;
      const gr = where === "float" ? L.floats[idx] : L.areas[where][idx], from = locate(L, drag.id);
      const self = from && from.where === where && from.index === idx;
      if (where === "float" || n.closest(".dock-tabs") || n.closest("[data-dock-panel] > header, .pane-heading")) {
        if (self && gr.panels.length === 1) return null;
        return {target: {area: where, mode: "tab", group: idx}, rect: box(r.left, r.top, r.width, r.height)};
      }
      const row = where === "bottom", f = row ? (x - r.left) / r.width : (y - r.top) / r.height;
      if (f < .28 || f > .72) {
        if (self && gr.panels.length === 1) return null;
        const before = f < .28;
        return landing({area: where, mode: before ? "before" : "after", group: idx});
      }
      if (self && gr.panels.length === 1) return null;
      return {target: {area: where, mode: "tab", group: idx}, rect: box(r.left, r.top, r.width, r.height)};
    }
    const area = n.closest?.(".dock-area");
    if (area && area.dataset.dockArea) return landing({area: area.dataset.dockArea, mode: "end"});
    const ed = D.getElementById("editor-area");
    if (ed && ed.contains(n)) {
      const r = drag.editor || (drag.editor = ed.getBoundingClientRect()), side = Math.max(48, r.width * .14), low = Math.max(48, r.height * .2);
      if (x < r.left + side) return landing({area: "left", mode: "end"});
      if (x > r.right - side) return landing({area: "right", mode: "end"});
      if (y > r.bottom - low) return landing({area: "bottom", mode: "end"});
      const fw = 320, fh = 360, fx = Math.max(0, Math.min(x - 40, innerWidth - fw)), fy = Math.max(captionTop(), Math.min(y - 12, innerHeight - fh));
      return {target: {area: "float", rect: {x: Math.round(fx), y: Math.round(fy), w: fw, h: fh}}, rect: box(fx, fy, fw, fh)};
    }
    return null;
  }
  // The preview shows exactly where the panel lands: the layout after the move is laid out once per
  // target (the source group emptied, the target area shown, a stand-in group where the new one goes),
  // measured, and put back before anything paints. The panels themselves never move, so iframes and
  // canvases are untouched, and observers see no size change. Cached for the rest of the drag.
  function landing(target) {
    const key = target.area + ":" + target.mode + ":" + (target.group ?? "");
    const memo = drag.landings || (drag.landings = new Map());
    if (!memo.has(key)) {let rect = null; try {rect = simulate(target);} catch {} memo.set(key, rect);}
    const rect = memo.get(key);
    return rect ? {target, rect} : null;
  }
  function simulate(target) {
    const a = target.area, area = areaEl(a); if (!area) return null;
    const undo = [], from = locate(L, drag.id), groups = n => [...n.querySelectorAll(":scope > .dock-group:not(.dock-empty)")];
    const flip = (n, c, on) => {if (n && n.classList.contains(c) !== on) {n.classList.toggle(c, on); undo.push(() => n.classList.toggle(c, !on));}};
    const hide = (n, on) => {if (n && n.hidden !== on) {n.hidden = on; undo.push(() => {n.hidden = !on;});}};
    const stand = el("div", "dock-group dock-in-" + a);
    try {
      // The panel leaves its group; a group left with no open panel folds, and so does an emptied area.
      if (from && from.where !== "float") {
        const src = areaEl(from.where), g = src?.querySelector(':scope > [data-dock-group="' + from.where + ":" + from.index + '"]');
        if (g && !from.group.panels.some(id => id !== drag.id && isOpen(reg.get(id)))) {
          flip(g, "dock-empty", true);
          if (src && !groups(src).length && from.where !== a) {if (from.where === "bottom") hide(src, true); else flip(D.body, "dock-empty-" + from.where, true);}
        }
      }
      if (a === "bottom") hide(area, false); else {flip(D.body, "dock-empty-" + a, false); flip(D.body, "hide-" + a, false);}
      const vis = groups(area), at = target.group != null ? area.querySelector(':scope > [data-dock-group="' + a + ":" + target.group + '"]') : null;
      if (target.mode === "before" && at) at.before(stand);
      else if (target.mode === "after" && at) at.after(stand);
      else area.insertBefore(stand, area.querySelector(":scope > .dock-sash-" + a));
      // The last visible group fills what is left (render() does the same).
      const last = groups(area).at(-1);
      for (const g of vis) if (g !== last) flip(g, "dock-fill", false);
      flip(last, "dock-fill", true);
      const r = stand.getBoundingClientRect();
      return r.width && r.height ? box(Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)) : null;
    } finally {
      stand.remove();
      for (const f of undo.reverse()) f();
      arrivals.takeRecords(); bodyObserver.takeRecords();
    }
  }
  function dragStop() {
    removeEventListener("pointermove", dragMove, true); removeEventListener("pointerup", dragEnd, true); removeEventListener("pointercancel", dragCancel, true);
    removeEventListener("keydown", dragKey, true);
    globalThis.AtriumMotion?.placeBox(drag?.preview,null);
    drag?.ghost?.remove(); drag?.preview?.remove(); D.body.classList.remove("dock-dragging");
    const d = drag; drag = null; return d;
  }
  function dragEnd(e) {
    const d = dragStop(); if (!d?.started) return;
    e.preventDefault();
    // The click that follows a drag must not activate a tab or a header button.
    const eat = ev => {ev.stopPropagation(); ev.preventDefault();};
    addEventListener("click", eat, {capture: true, once: true});
    setTimeout(() => removeEventListener("click", eat, true), 60);
    if (d.target) moveTo(d.id, d.target);
  }
  function dragCancel() {dragStop();}
  function dragKey(e) {if (e.key === "Escape" && drag) {e.preventDefault(); e.stopPropagation(); dragStop(); info("Move cancelled.");}}

  // ---- sashes
  const sizeOf = a => {const n = areaEl(a); return n ? (a === "bottom" ? n.getBoundingClientRect().height : n.getBoundingClientRect().width) : 0;};
  const maxOf = a => a === "bottom" ? Math.max(MIN.bottom, innerHeight * .7) : Math.max(MIN[a], innerWidth * .45);
  function setArea(a, px) {L.sizes[a] = Math.round(Math.min(maxOf(a), Math.max(MIN[a], px))); L.name = null; sizes(); syncSash(a);}
  function syncSash(a) {
    const s = areaEl(a)?.querySelector(":scope > .dock-sash-" + a); if (!s) return;
    s.setAttribute("aria-valuemin", String(MIN[a])); s.setAttribute("aria-valuemax", String(Math.round(maxOf(a))));
    s.setAttribute("aria-valuenow", String(Math.round(L.sizes[a] || sizeOf(a))));
  }
  function groupPair(s) {
    const a = s.dataset.area, i = +s.dataset.group, gr = L.areas[a]?.[i], prev = s.previousElementSibling?.closest?.(".dock-group");
    const g = [...areaEl(a).querySelectorAll(":scope > .dock-group")][i];
    return {a, gr, g: g || prev};
  }
  function syncGroupSash(s) {
    const {a, g} = groupPair(s);
    if (!g) return;
    const side = a === "bottom" ? "width" : "height";
    const current = Math.round(g.getBoundingClientRect()[side]), total = Math.round(areaEl(a).getBoundingClientRect()[side]);
    s.setAttribute("aria-valuemin", String(Math.min(current, MIN.group)));
    s.setAttribute("aria-valuemax", String(Math.max(current, MIN.group, total - MIN.group)));
    s.setAttribute("aria-valuenow", String(current));
  }
  function setGroup(s, px) {
    const {a, gr, g} = groupPair(s); if (!gr || !g) return;
    const box = areaEl(a).getBoundingClientRect(), total = a === "bottom" ? box.width : box.height;
    gr.size = Math.round(Math.min(total - MIN.group, Math.max(MIN.group, px))); gr.auto = false; L.name = null;
    g.style.flex = "0 0 " + gr.size + "px"; g.classList.remove("dock-auto");
    syncGroupSash(s);
  }
  function sashDown(e) {
    const s = e.target.closest?.(".dock-sash"); if (!s || e.button !== 0) return;
    e.preventDefault(); try {s.setPointerCapture?.(e.pointerId);} catch {} s.classList.add("is-dragging"); D.body.classList.add("dock-resizing");
    const kind = s.dataset.sash, startX = e.clientX, startY = e.clientY;
    const start = kind === "group" ? (() => {const {a, g} = groupPair(s); const r = g?.getBoundingClientRect(); return a === "bottom" ? r?.width : r?.height;})() : sizeOf(kind);
    // One layout change per frame however fast the pointer reports: the canvases and panels then follow
    // it in that frame (editor.js redraws a resized pane before paint).
    let last = null, frame = 0;
    const apply = () => {
      frame = 0; const m = last; if (!m) return; last = null;
      const dx = m.clientX - startX, dy = m.clientY - startY;
      if (kind === "left") setArea("left", start + dx); else if (kind === "right") setArea("right", start - dx);
      else if (kind === "bottom") setArea("bottom", start - dy);
      else setGroup(s, start + (s.dataset.area === "bottom" ? dx : dy));
    };
    const follow = m => {last = {clientX: m.clientX, clientY: m.clientY}; if (!frame) frame = requestAnimationFrame(apply);};
    const done = () => {if (frame) cancelAnimationFrame(frame); apply(); s.classList.remove("is-dragging"); D.body.classList.remove("dock-resizing"); s.removeEventListener("pointermove", follow); s.removeEventListener("pointerup", done); s.removeEventListener("pointercancel", done); save(); try {globalThis.dispatchEvent(new Event("resize"));} catch {}};
    s.addEventListener("pointermove", follow); s.addEventListener("pointerup", done); s.addEventListener("pointercancel", done);
  }
  function sashReset(s) {
    const kind = s.dataset.sash;
    if (kind === "group") {const {gr} = groupPair(s); if (gr) {gr.size = null; const def = builtin("default"); if (s.dataset.area === "left" && +s.dataset.group === 0 && locate(def, gr.active)?.group?.auto) gr.auto = true;}}
    else delete L.sizes[kind];
    L.name = null; render(); save(); syncSash(kind);
    try {globalThis.dispatchEvent(new Event("resize"));} catch {}
    info("Restored the default size.");
  }
  function sashKey(e) {
    const s = e.target.closest?.(".dock-sash"); if (!s) return;
    const kind = s.dataset.sash, step = e.shiftKey ? 50 : 10;
    if (e.key === "Enter") {e.preventDefault(); e.stopPropagation(); sashReset(s); return;}
    const horiz = kind === "left" || kind === "right" || kind === "group" && s.dataset.area === "bottom";
    const keys = horiz ? {ArrowLeft: -1, ArrowRight: 1} : {ArrowUp: -1, ArrowDown: 1};
    let d = keys[e.key];
    if (e.key === "Home" || e.key === "End") d = e.key === "Home" ? -1e4 : 1e4;
    if (d == null) return;
    e.preventDefault(); e.stopPropagation();
    const mul = Math.abs(d) > 1 ? 1 : step;
    if (kind === "group") {const {a, g} = groupPair(s); const r = g?.getBoundingClientRect(); setGroup(s, (a === "bottom" ? r.width : r.height) + d * mul);}
    else {const cur = sizeOf(kind), sign = kind === "right" ? -1 : kind === "bottom" ? -1 : 1; setArea(kind, cur + sign * d * mul);}
    save(); try {globalThis.dispatchEvent(new Event("resize"));} catch {}
  }

  // ---- floating windows: drag the bar to move; arrows move, Alt+arrows resize; Dock returns the panel
  function floatOf(n) {const w = n.closest?.(".dock-float"); return w ? {w, f: L.floats[+w.dataset.dockFloat.split(":")[1]]} : null;}
  function floatDown(e) {
    const bar = e.target.closest?.(".dock-float-bar"); if (!bar || e.button !== 0 || e.target.closest("button")) return;
    const {w, f} = floatOf(bar) || {}; if (!f) return;
    e.preventDefault(); try {bar.setPointerCapture?.(e.pointerId);} catch {}
    const sx = e.clientX - f.x, sy = e.clientY - f.y;
    const follow = m => {f.x = Math.max(0, Math.min(innerWidth - 60, m.clientX - sx)); f.y = Math.max(captionTop(), Math.min(innerHeight - 30, m.clientY - sy)); w.style.left = f.x + "px"; w.style.top = f.y + "px";};
    const done = () => {bar.removeEventListener("pointermove", follow); bar.removeEventListener("pointerup", done); bar.removeEventListener("pointercancel", done); L.name = null; save();};
    bar.addEventListener("pointermove", follow); bar.addEventListener("pointerup", done); bar.addEventListener("pointercancel", done);
  }
  function floatKey(e) {
    const bar = e.target.closest?.(".dock-float-bar"); if (!bar || e.target !== bar) return;
    const {f} = floatOf(bar) || {}; if (!f) return;
    const v = {ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1]}[e.key]; if (!v) return;
    e.preventDefault(); e.stopPropagation();
    const step = e.shiftKey ? 50 : 10;
    if (e.altKey) {f.w = Math.max(MIN.floatW, f.w + v[0] * step); f.h = Math.max(MIN.floatH, f.h + v[1] * step);}
    else {f.x = Math.max(0, f.x + v[0] * step); f.y = Math.max(0, f.y + v[1] * step);}
    L.name = null; renderFloats(); save();
  }
  const floatObserver = typeof ResizeObserver === "function" ? new ResizeObserver(entries => {
    let changed = false;
    for (const en of entries) {
      const w = en.target, f = L?.floats[+w.dataset.dockFloat?.split(":")[1]]; if (!f || w.hidden) continue;
      const r = w.getBoundingClientRect(); if (!r.width || !r.height) continue;
      if (Math.abs(r.width - f.w) > 2 || Math.abs(r.height - f.h) > 2) {f.w = Math.round(r.width); f.h = Math.round(r.height); changed = true;}
    }
    if (changed) save();
  }) : null;

  // ---- tabs: click, keys, close
  function tabClick(e) {
    const x = e.target.closest?.("[data-dock-close]");
    if (x) {e.stopPropagation(); closePanel(x.dataset.dockClose); return;}
    const more = e.target.closest?.(".dock-tab-more");
    if (more) {e.stopPropagation(); overflowMenu(more); return;}
    const back = e.target.closest?.(".dock-float-dock");
    if (back) {const {f} = floatOf(back) || {}; if (f) dockBack(f.active); return;}
    const t = e.target.closest?.("[data-dock-tab]");
    if (t) {L = activate(L, t.dataset.dockTab); render(); save(); return;}
    const lay = e.target.closest?.("[data-dock-layout]");
    if (lay) {e.stopPropagation(); globalThis.AtriumWorkbench?.dismiss?.(); applyNamed(lay.dataset.dockLayout);}
  }
  function tabKey(e) {
    const t = e.target.closest?.("[data-dock-tab]"); if (!t) return;
    const strip = t.closest(".dock-tabs"), list = [...strip.querySelectorAll("[data-dock-tab]")], at = list.indexOf(t);
    const go = {ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: list.length - 1}[e.key];
    if (go != null) {e.preventDefault(); e.stopPropagation(); const n = list[(go + list.length) % list.length]; L = activate(L, n.dataset.dockTab); render(); save(); D.getElementById(n.id)?.focus(); return;}
    if (e.key === "Delete" && !reg.get(t.dataset.dockTab)?.core) {e.preventDefault(); e.stopPropagation(); closePanel(t.dataset.dockTab);}
    else if (e.key === "Enter" || e.key === " ") {e.preventDefault(); e.stopPropagation(); focusPanel(reg.get(t.dataset.dockTab));}
  }
  // F6 inside panels whose own key handlers stop propagation (search boxes, grids).
  function partKey(e) {
    if (e.key !== "F6" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!e.target.closest?.(".dock-group,.dock-float,dialog.work-dialog,.menubar") || e.target.closest("dialog:modal")) return;
    const KM = globalThis.AtriumKeymap, id = e.shiftKey ? "focus-part-prev" : "focus-part-next";
    const bound = KM?.bindingsFor?.(id);
    if (bound && !bound.some(b => KM.normalize(b.key) === (e.shiftKey ? "Shift+F6" : "F6"))) return;
    e.preventDefault(); e.stopPropagation(); focusPart(e.shiftKey ? -1 : 1);
  }

  // ---- document kind: auto layout switch
  const kindObserver = new MutationObserver(() => {
    const k = D.body.dataset.kind || ""; if (k === kindSeen) return;
    const was = kindSeen;
    if (pref(AUTO, false) && was && L) {clearTimeout(saveTimer); setPref(SLOTS, {...(pref(SLOTS, {}) || {}), [was]: snapshot()});}
    kindSeen = k;
    if (!pref(AUTO, false) || !k || !was) return;
    const slot = (pref(SLOTS, {}) || {})[k];
    if (slot) apply(slot, {quiet: true, name: slot.name}); else applyBuiltin(k === "pcb" ? "pcb" : "schematic");
    info("Layout for " + (k === "pcb" ? "boards" : "schematics") + ": " + (L.name || "custom") + " (Window › Layouts)");
  });
  // Turning the switch on starts each kind from its built-in layout; later changes are kept per kind.
  function setAuto(v) {
    setPref(AUTO, v);
    if (v) {setPref(SLOTS, {}); const k = D.body.dataset.kind; if (k) applyBuiltin(k === "pcb" ? "pcb" : "schematic");}
    syncMenus();
    info(v ? "Layouts now follow the document kind: " + (L.name || "custom") + "." : "Layouts no longer follow the document kind.");
  }
  const bodyObserver = new MutationObserver(() => {if (!applying) save();});

  // Escape in a panel that did not handle it: a filled search field clears first; then the Library (a
  // picker, like Altium's Components panel) closes, and the keyboard goes back to the editor.
  function panelEscape(e) {
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const t = e.target, node = t.closest?.("[data-dock-panel]");
    if (!node || t.closest("dialog[open], select, [contenteditable=true]")) return;
    e.preventDefault();
    if (t.matches("input[type=search], input[type=text], input:not([type])") && t.value) {t.value = ""; t.dispatchEvent(new Event("input", {bubbles: true})); return;}
    if (node.dataset.dockPanel === "library") closePanel("library");
    host?.canvas?.()?.focus();
  }
  // ---- start
  function init() {
    wrapProperties();
    const stored = pref(PREF, null);
    L = restoreLayout(stored);
    if (stored?.name) L.name = stored.name; else if (!stored) L.name = "Default";
    lastSaved = stored ? JSON.stringify(stored) : "";
    for (const q of globalThis.AtriumDockPending || []) register(q);
    globalThis.AtriumDockPending = {push: s => register(s)};
    for (const a of ["left", "right"]) {const box = areaEl(a); watch(box); for (const n of [...(box?.children || [])]) adopt(n);}
    watch(D.body); watch(D.getElementById("editor-area")); watch(bottomEl());
    for (const n of D.querySelectorAll("body > .msg-panel, body > .pl-panel, #editor-area > .script-console, body > .ext-panel")) adopt(n);
    for (const k of KNOWN) {const n = D.querySelector(k.match); if (n) adopt(n);}
    render();
    for (const a of AREAS) syncSash(a);
    D.addEventListener("pointerdown", e => {startDrag(e); sashDown(e); floatDown(e);}, true);
    D.addEventListener("dblclick", e => {const s = e.target.closest?.(".dock-sash"); if (s) {e.preventDefault(); sashReset(s);}});
    D.addEventListener("keydown", e => {sashKey(e); floatKey(e);});
    D.addEventListener("keydown", tabKey, true);
    D.addEventListener("keydown", panelEscape);
    D.addEventListener("keydown", partKey, true);
    D.addEventListener("click", tabClick, true);
    D.addEventListener("focusin", e => {const p = panelAt(e.target); if (p) lastFocused = p.id;});
    globalThis.addEventListener("resize", revealActiveTabs);
    kindObserver.observe(D.body, {attributes: true, attributeFilter: ["data-kind"]});
    bodyObserver.observe(D.body, {attributes: true, attributeFilter: ["class"]});
    globalThis.AtriumWorkbench?.onOpen?.(() => syncMenus());
    const prefs = P => P?.on?.(prefChanged);
    if (globalThis.AtriumPrefs) prefs(globalThis.AtriumPrefs); else globalThis.AtriumLazy?.need?.("AtriumPrefs").then(prefs, () => {});
    const ready = h => {
      host = h;
      const on = (id, f) => h.registerAction(id, f);
      on("move-panel", () => moveDialog()); on("zen-mode", () => zen());
      on("layout-save", saveDialog); on("layout-manage", manageDialog);
      for (const [key, action] of Object.entries(BUILTIN_ACTION)) on(action, () => applyBuiltin(key));
      on("layout-auto", () => setAuto(!pref(AUTO, false)));
      on("focus-part-next", () => focusPart(1)); on("focus-part-prev", () => focusPart(-1));
    };
    const C = globalThis.AtriumNavCommon;
    if (C) C.ready(ready); else addEventListener("DOMContentLoaded", () => globalThis.AtriumNavCommon?.ready(ready), {once: true});
  }
  init();

  return {BUILTINS, KNOWN, MIN, builtin, normalize, locate, remove, move, place, activate, isCustom,
    register, adopt, apply, applyBuiltin, applyNamed, moveTo, focusPart, toggle, reveal, zen, render,
    current: () => L && clone(L), panels: () => [...reg.values()].map(p => ({id: p.id, title: title(p), open: isOpen(p), core: !!p.core, where: locate(L, p.id)?.where || null})),
    hitTest: (x, y) => {const was = drag; drag = drag || {id: ""}; try {return hitTest(x, y);} finally {drag = was;}}};
})();
