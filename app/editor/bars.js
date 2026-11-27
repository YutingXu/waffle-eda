"use strict";
// Customisable bars (docs/design/customisable-bars.md). Phase 1 registers the Active Bar only.
// Lazy, in the AtriumActiveBarMenu bundle: active-bar.js loads it when a kind has a stored bar or a
// remembered flyout face, when the bar overflows, on a right-click on the bar, or on the first flyout.
//
//   "workbench.bars" (AtriumPrefs)  {version:1, active:{<kind>:[item…]}}, only the kinds the user
//       changed. An item is a command id, a "power:<net>" key (the palette's and key map's own key for
//       Place › Power Port › <net>), "|" (a separator) or {face, more:[id…]} (a button and its flyout).
//       At most 24 items per bar and 16 per flyout. Unknown ids are kept and not drawn; a malformed
//       value draws the default. Settings export, import and Restore Defaults carry it as any preference.
//       "seen":{<kind>:[id…]} lists the extension buttons a customised bar has already met: a new one is
//       added once at the end, and one the user removed stays removed.
//   "atrium.bar-faces" (localStorage, view state beside the dock's collapsed panels, exported with them)
//       {<kind>:{<slot>:face}}: the last flyout choice per button (sticky flyouts). A face is a command
//       id, or {id, label, icon, group} for an entry a module provides (the notebook's Widgets).
//
// The default is the static #tools markup, read once; a bar equal to it is not stored. A stored bar is
// drawn with the same DOM: the markup's own buttons are moved, not copied, so the editor's pressed
// states, the tutorial and drawing.js keep finding them by [data-action].
globalThis.AtriumBars = (() => {
  const G = globalThis, D = G.document, PREF = "workbench.bars", FACES = "atrium.bar-faces", SEP = "|", VERSION = 1;
  const LIMITS = Object.freeze({bar:24, flyout:16}), KINDS = Object.freeze(["schematic", "pcb", "drawing"]);
  const t = G.AtriumI18n?.define?.({
    "bars.more_tools": "More tools",
    "bars.customise": "Customise Active Bar…",
    "bars.power_port": "{net} power port",
    "bars.unavailable": "{name} is not available here.",
    "bars.toolbars": "Toolbars"
  }) || ((k, p) => k);
  const object = v => !!v && typeof v === "object" && !Array.isArray(v);
  const isId = v => typeof v === "string" && v !== SEP && /^[^\s"'<>`\\]{1,160}$/.test(v);

  // ------------------------------------------------------------------ model (pure)
  function item(x) {
    if (x === SEP || isId(x)) return x;
    if (!object(x) || !isId(x.face)) return null;
    return {face:x.face, more:(Array.isArray(x.more) ? x.more : []).filter(isId).slice(0, LIMITS.flyout)};
  }
  // A stored value as the model reads it, or null for anything that is not a bars object.
  function normalize(value) {
    if (!object(value) || (value.version ?? VERSION) !== VERSION || !object(value.active)) return null;
    const active = {};
    for (const [k, list] of Object.entries(value.active))
      if (/^[a-z][a-z0-9-]{0,31}$/.test(k) && Array.isArray(list)) active[k] = list.map(item).filter(x => x != null).slice(0, LIMITS.bar);
    const seen = {};
    for (const [k, ids] of Object.entries(object(value.seen) ? value.seen : {}))
      if (active[k] && Array.isArray(ids)) { const v = [...new Set(ids.filter(isId))].slice(0, 64); if (v.length) seen[k] = v; }
    return Object.keys(seen).length ? {version:VERSION, active, seen} : {version:VERSION, active};
  }
  // Separators never lead, trail or double up on the bar.
  function tidy(list, isSep = x => x === SEP) {
    const out = [];
    for (const x of list) if (!isSep(x) || (out.length && !isSep(out.at(-1)))) out.push(x);
    while (out.length && isSep(out.at(-1))) out.pop();
    return out;
  }
  // The default list for a kind: the markup's entries [{id, scope} | {sep:true}] in order, then the
  // extension buttons [{id, when}] whose context allows that kind.
  function defaults(entries, kind, extra = [], allows = () => true) {
    const list = entries.filter(e => e.sep || !e.scope || e.scope === kind).map(e => e.sep ? SEP : e.id);
    return tidy([...list, ...extra.filter(e => allows(e.when, kind)).map(e => e.id)]);
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  // A group's flyout: its face first, unless the list places the face itself.
  const members = x => object(x) ? (x.more.includes(x.face) ? x.more.slice() : [x.face, ...x.more]) : [];
  // The stored value after setting one kind's list (null or the default list: that kind is removed).
  // seen: the extension buttons present now, which this kind's bar has therefore met.
  function put(stored, kind, list, def, seen = []) {
    const was = normalize(stored), active = {...(was?.active || {})}, met = {...(was?.seen || {})};
    const next = Array.isArray(list) ? normalize({active:{[kind]:list}}).active[kind] : null;
    if (!next || same(next, def)) { delete active[kind]; delete met[kind]; }
    else { active[kind] = next; met[kind] = [...new Set([...(met[kind] || []), ...seen])]; }
    return Object.keys(active).length ? normalize({version:VERSION, active, seen:met}) : null;
  }
  // Extension buttons a customised bar has not met yet: they join its end once.
  function newcomers(stored, kind, ids) {
    const v = normalize(stored), list = v?.active[kind];
    if (!list) return [];
    const on = new Set(list.flatMap(x => x === SEP ? [] : object(x) ? [x.face, ...x.more] : [x])), met = new Set(v.seen?.[kind] || []);
    return ids.filter(id => !on.has(id) && !met.has(id));
  }
  function cleanFaces(value) {
    const out = {};
    if (!object(value)) return out;
    for (const [k, map] of Object.entries(value)) {
      if (!object(map)) continue;
      const m = {};
      for (const [slot, f] of Object.entries(map)) {
        if (!isId(slot)) continue;
        if (isId(f)) m[slot] = f;
        else if (object(f) && isId(f.id) && typeof f.label === "string") m[slot] = {id:f.id, label:f.label.slice(0, 200), icon:/^[a-z0-9-]{1,40}$/.test(f.icon) ? f.icon : "", group:isId(f.group) ? f.group : ""};
      }
      if (Object.keys(m).length) out[k] = m;
    }
    return out;
  }
  const model = {LIMITS, KINDS, SEP, normalize, tidy, defaults, members, put, newcomers, cleanFaces, item};
  if (!D) return Object.freeze(model);

  // ------------------------------------------------------------------ storage
  const K = () => G.AtriumKeymap, C = () => G.AtriumNavCommon, M = () => G.AtriumActiveBarMenu;
  const kind = () => D.body.dataset.kind || "schematic";
  const stored = () => { try { return normalize(G.AtriumPref?.get(PREF)); } catch { return null; } };
  const listFor = k => stored()?.active[k] ?? null;
  function faces() { try { return cleanFaces(JSON.parse(G.localStorage.getItem(FACES) || "null")); } catch { return {}; } }
  function writeFaces(value) {
    try { if (Object.keys(value).length) G.localStorage.setItem(FACES, JSON.stringify(value)); else G.localStorage.removeItem(FACES); } catch {}
  }
  function write(value) {
    const P = G.AtriumPrefs;
    if (!value) { if (P) P.reset([PREF]); else G.AtriumPref?.set(PREF, null); }
    else (P || G.AtriumPref)?.set(PREF, value);
    render();
  }

  // ------------------------------------------------------------------ the markup
  const bar = D.getElementById("tools");
  // The markup with its whitespace, so the default draws byte for byte what index.html has.
  const layout = bar ? [...bar.childNodes].filter(n => n.nodeType !== 1 || !n.classList.contains("ext-tool")) : [];
  const pristine = layout.filter(n => n.nodeType === 1);
  for (const n of pristine) delete n.dataset.overflow;
  const parked = D.createDocumentFragment(), made = new WeakSet(), slots = new WeakMap(), groups = new Map(), known = new Map();
  let more = null, rendering = false, availableIds = null;
  const isDivider = n => n.classList.contains("tool-divider");
  const idOf = n => n.dataset.powerNet ? "power:" + n.dataset.powerNet : n.dataset.command || n.dataset.action || "";
  const entries = () => pristine.map(n => isDivider(n) ? {sep:true} : {id:idOf(n), scope:n.dataset.scope || ""});
  const template = id => pristine.find(n => !isDivider(n) && idOf(n) === id) || null;
  // Extension buttons in the order they arrived, wherever they are now (on the bar or parked).
  const arrived = [];
  const extNodes = () => {
    if (!bar) return [];
    for (const n of bar.querySelectorAll(":scope > .ext-tool")) if (!arrived.includes(n)) arrived.push(n);
    for (let i = arrived.length - 1; i >= 0; i--) if (arrived[i].parentNode !== bar && arrived[i].parentNode !== parked) arrived.splice(i, 1);
    return arrived.slice();
  };
  const assume = k => ({kind:k, tool:"select", interactive:false, selected:true, selectionCount:1, canvas:true, __assume:true});
  function allows(when, k) {
    if (!when) return true;
    try { return K()?.compileWhen(when)?.(assume(k), true) !== false; } catch { return true; }
  }
  const defaultList = k => defaults(entries().filter(e => e.sep || !hiddenOn(k).has(e.id)), k, extNodes().map(n => ({id:idOf(n), when:n.dataset.when || ""})), allows);
  const effective = k => listFor(k) ?? defaultList(k);
  // Commands come and go (macros, extensions, Experimental features): a stored bar draws what exists now.
  let redraw = false;
  K()?.onChange?.(() => {
    availableIds = null;
    if (redraw || !(listFor(kind()) || faces()[kind()])) return;
    redraw = true; queueMicrotask(() => { redraw = false; render(); });
  });
  function command(id) {
    const c = K()?.command(id);
    if (!c) return null;
    availableIds ??= new Set(K().commands().map(x => x.id));
    return availableIds.has(id) ? c : null;
  }
  // Whether an id draws on a kind's bar: the markup's scope, Place › Power Port on sheets, an
  // extension button, or a command whose context allows the kind.
  function drawable(id, k) {
    if (!isId(id)) return false;
    if (id.startsWith("power:")) return k === "schematic";
    if (hiddenOn(k).has(id)) return false;
    const n = template(id);
    if (n) return !n.dataset.scope || n.dataset.scope === k;
    if (extNodes().some(x => idOf(x) === id)) return true;
    if (known.get(id)?.group) return true;
    const c = command(id);
    return !!c && (!c.whenTest || c.whenTest(assume(k), true));
  }
  const groundNet = net => (G.AtriumSchPlace?.powerStyleFor?.(net) ?? (/^(GND|VSS|0V|AGND|DGND|PGND|EARTH)/i.test(net) ? "gnd" : "bar")) !== "bar";
  // The name of an id in a flyout or a list: a built-in group's wording, the menu's, the command's.
  function name(id, k) {
    if (id.startsWith("power:")) return id.slice(6);
    const own = template(id);
    if (own) return K()?.command(id)?.titles?.[k] || base(own);
    for (const key of Object.keys(M()?.GROUPS || {})) { const r = M().rows(key, k)?.find(x => x.id === id); if (r) return r.label; }
    const m = [...D.querySelectorAll('.menubar .menu-items [data-action]:not([data-power-net])')].find(b => b.dataset.action === id);
    if (m) return C()?.menuLabel(m) || id;
    const c = K()?.command(id);
    if (c) return c.titles?.[k] || c.title;
    const n = template(id) || extNodes().find(x => idOf(x) === id);
    return n ? base(n) : known.get(id)?.label || id;
  }
  const base = n => n.dataset.baseTitle || (n.getAttribute("aria-label") || n.title || "").replace(/\s*\(.*\)$/, "");

  // ------------------------------------------------------------------ command icons
  // The registry's `icon` for built-in commands comes from what Waffle already draws: first a chrome
  // control's sprite (the quick-access and status-bar buttons: Undo, Zoom In…), then the palette's own
  // action icons (AtriumPaletteView.actionIcons) where the symbol is named for the action (Fit, Grid,
  // Delete, Rotate). A symbol keeps one meaning: Paste is not drawn as Zoom In's plus.
  let table = null, tableLoad = null;
  function pairIcons() {
    const pairs = new Map(), meaning = new Map();
    for (const n of D.querySelectorAll("[data-action]:not([data-power-net])")) {
      const u = n.querySelector(":scope > svg > use")?.getAttribute("href");
      if (!u?.startsWith("#i-") || n.closest("#tools")) continue;
      const a = n.dataset.action, icon = u.slice(3);
      if (!pairs.has(a)) pairs.set(a, icon);
      if (!meaning.has(icon)) meaning.set(icon, a);
    }
    for (const n of pristine) { const u = n.querySelector?.("use")?.getAttribute("href"); if (u && !meaning.has(u.slice(3))) meaning.set(u.slice(3), idOf(n)); }
    for (const [a, icon] of Object.entries(table || {}))
      if (!pairs.has(a) && (a === icon || a.startsWith(icon + "-")) && (!meaning.has(icon) || meaning.get(icon) === icon)) pairs.set(a, icon);
    for (const c of K()?.commands() || []) {
      const icon = c.builtin && !c.icon && pairs.get(c.id);
      if (icon && D.getElementById("i-" + icon)) c.icon = icon;
    }
  }
  // Load the palette's table only when a button to draw has no icon yet (or the Toolbars page asks).
  function loadIcons() {
    const L = G.AtriumLazy;
    return tableLoad ??= L.need("AtriumPalette").then(() => L.need("AtriumPaletteView")).then(V => { table = V.actionIcons || {}; }, () => { table = {}; })
      .then(() => pairIcons());
  }
  function needIcons(ids) {
    if (table || !ids.some(id => !template(id) && !id.startsWith("power:") && command(id) && !command(id).icon)) return null;
    return loadIcons();
  }
  const drawnIds = k => [...(listFor(k) || []).flatMap(x => x === SEP ? [] : object(x) ? [x.face] : [x]),
    ...Object.values(faces()[k] || {}).map(f => typeof f === "string" ? f : f.id)];
  // Tools the markup hides on a kind (data-hide-kind: drawings hide the schematic and board tools).
  const hiddenOn = k => new Set(pristine.filter(n => (n.dataset.hideKind || "").split(/\s+/).includes(k)).map(idOf));
  function iconOf(id, k) {
    if (id.startsWith("power:")) return groundNet(id.slice(6)) ? "power-gnd" : "power-bar";
    const use = template(id)?.querySelector("use")?.getAttribute("href");
    if (use) return use.replace(/^#i-/, "");
    const c = K()?.command(id), i = c?.icon || known.get(id)?.icon;
    return /^[a-z0-9-]{1,40}$/.test(i || "") && D.getElementById("i-" + i) ? i : "";
  }
  // The text face for a command without an icon: the extension buttons' two-letter label.
  const letters = text => String(text).replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase() || "?";
  function svg(icon) {
    const s = C()?.icon(icon);
    if (s) return s;
    const n = D.createElementNS("http://www.w3.org/2000/svg", "svg"), u = D.createElementNS("http://www.w3.org/2000/svg", "use");
    n.setAttribute("class", "icon"); n.setAttribute("aria-hidden", "true"); u.setAttribute("href", "#i-" + icon); n.append(u);
    return n;
  }
  // A button for an id: a copy of the markup's button, or one built from the command (icon or text face).
  function build(id, k) {
    const n = template(id);
    if (n) {
      const b = /** @type {HTMLElement} */ (n.cloneNode(true));
      b.removeAttribute("aria-controls"); if (b.hasAttribute("aria-expanded")) b.setAttribute("aria-expanded", "false");
      made.add(b); return b;
    }
    const b = D.createElement("button"), power = id.startsWith("power:"), label = power ? t("bars.power_port", {net:id.slice(6)}) : name(id, k), icon = iconOf(id, k);
    b.type = "button"; b.className = "tool";
    if (power) { b.dataset.action = "sch-power"; b.dataset.powerNet = id.slice(6); b.dataset.scope = "schematic"; }
    else { b.dataset.action = command(id)?.action || id; b.dataset.barRun = id; }
    b.setAttribute("aria-label", label); b.title = label;
    if (icon) b.append(svg(icon));
    else { const s = D.createElement("span"); s.className = "tool-text"; s.setAttribute("aria-hidden", "true"); s.textContent = letters(label); b.append(s); }
    made.add(b); return b;
  }
  function flyoutOn(n, key, from) {
    n.classList.add("has-flyout"); n.dataset.toolGroup = key;
    n.setAttribute("aria-haspopup", "menu"); n.setAttribute("aria-expanded", "false");
    // A face keeps its button's place: the same document kind and the same notebook gate.
    for (const a of ["data-scope", "data-notebook-action"]) if (from?.hasAttribute(a)) n.setAttribute(a, from.getAttribute(a)); else if (from) n.removeAttribute(a);
    return n;
  }
  const divider = () => { const s = D.createElement("span"); s.className = "tool-divider"; s.setAttribute("aria-hidden", "true"); made.add(s); return s; };

  // ------------------------------------------------------------------ render
  // list: draw this list instead of the stored one (tests: the rendering contract).
  function render(k = kind(), given) {
    if (!bar) return;
    rendering = true;
    const focused = bar.contains(D.activeElement) ? slots.get(/** @type {Element} */ (D.activeElement)) : null;
    const list = Array.isArray(given) ? given.map(item).filter(x => x != null) : listFor(k), chosen = faces()[k] || {}, used = new Set(), dividers = pristine.filter(isDivider), out = [];
    groups.clear();
    // The remembered flyout choice for a button (slot), drawn with that button's group.
    const face = (slot, key, node) => {
      const f = chosen[slot], id = typeof f === "string" ? f : f?.id;
      if (!id || id === slot) return node;
      if (typeof f === "object") known.set(id, {label:f.label, icon:f.icon, group:f.group});
      if (!drawable(id, k) && !(groups.get(key) || M()?.rows(key, k)?.map(r => r.id) || []).includes(id)) return node;
      const n = flyoutOn(build(id, k), key, node);
      slots.set(n, slot); return n;
    };
    if (!list) {
      // The markup in order (other kinds' buttons stay hidden by their scope), extension buttons last.
      for (const n of layout) {
        if (n.nodeType !== 1 || isDivider(n)) { out.push(n); continue; }
        used.add(n); slots.set(n, idOf(n));
        out.push(n.dataset.toolGroup ? face(idOf(n), n.dataset.toolGroup, n) : n);
      }
      for (const n of extNodes()) { used.add(n); out.push(n); }
    } else {
      let g = 0;
      for (const x of list) {
        if (x === SEP) { out.push(dividers.find(d => !used.has(d) && used.add(d)) || divider()); continue; }
        const id = object(x) ? x.face : x;
        if (!drawable(id, k)) continue;
        const ext = extNodes().find(n => idOf(n) === id && !used.has(n));
        let n;
        if (ext) n = ext;
        else if (object(x) && members(x).length > 1) { const key = "bar-" + g++; groups.set(key, members(x)); n = flyoutOn(build(id, k), key, template(id)); slots.set(n, id); n = face(id, key, n); }
        else if (object(x)) {
          // A group whose flyout was emptied: the button alone.
          n = build(id, k); slots.set(n, id); n.classList.remove("has-flyout");
          for (const a of ["data-tool-group", "aria-haspopup", "aria-expanded"]) n.removeAttribute(a);
        } else {
          const own = template(id);
          n = own && !used.has(own) ? own : build(id, k);
          slots.set(n, id);
          if (n.dataset.toolGroup) n = face(id, n.dataset.toolGroup, n);
        }
        used.add(n); out.push(n);
      }
    }
    // An extension button this customised bar has never met joins its end, once.
    if (list && !Array.isArray(given)) {
      const fresh = newcomers(G.AtriumPref?.get(PREF), k, extIds(k));
      if (fresh.length) queueMicrotask(() => {
        const now = listFor(k), add = newcomers(G.AtriumPref?.get(PREF), k, extIds(k));
        if (now && add.length) write(put(G.AtriumPref?.get(PREF), k, [...now, ...add].slice(0, LIMITS.bar), defaultList(k), extIds(k)));
      });
    }
    const shown = list ? tidy(out, n => isDivider(n)) : out;
    for (const n of shown) if (n.nodeType === 1 && n.dataset.scope && !n.classList.contains("ext-tool")) n.hidden = n.dataset.scope !== k;
    for (const n of [...bar.children, ...pristine]) if (!shown.includes(n) && n !== more && !made.has(n) && n.parentNode !== parked) parked.append(n);
    const current = [...bar.childNodes].filter(n => n !== more);
    if (current.length !== shown.length || current.some((n, i) => n !== shown[i])) bar.replaceChildren(...shown);
    watcher?.takeRecords();
    rendering = false;
    G.AtriumActiveBar?.titles();
    fit();
    if (!table && list) needIcons(drawnIds(k))?.then(() => render(k));
    if (focused) [...bar.children].find(n => slots.get(n) === focused)?.focus();
  }
  // ------------------------------------------------------------------ overflow
  // Trailing items that do not fit move into a "⋯" flyout (the same nav-flyout menu).
  function fit() {
    if (!bar?.isConnected) return;
    rendering = true;
    for (const n of bar.querySelectorAll(":scope > [data-overflow]")) delete n.dataset.overflow;
    more?.remove();
    if (bar.getClientRects().length && bar.scrollWidth > bar.clientWidth + 1) {
      more ||= overflowButton();
      bar.append(more);
      const items = [...bar.children].filter(n => n !== more && n.getClientRects().length);
      while (items.length && bar.scrollWidth > bar.clientWidth + 1) items.pop().dataset.overflow = "";
      while (items.length && isDivider(items.at(-1))) items.pop().dataset.overflow = "";
      bar.scrollLeft = 0;
    }
    watcher?.takeRecords();
    rendering = false;
  }
  function overflowButton() {
    const b = D.createElement("button"), label = t("bars.more_tools");
    b.type = "button"; b.className = "tool has-flyout"; b.dataset.toolGroup = "overflow"; b.dataset.barRun = "bar-overflow";
    b.setAttribute("aria-haspopup", "menu"); b.setAttribute("aria-expanded", "false"); b.setAttribute("aria-label", label); b.title = label;
    b.append(svg("more"));
    return b;
  }
  const overflowRows = () => [...bar.querySelectorAll(":scope > [data-overflow]")].filter(n => !isDivider(n) && !n.hidden)
    .map(n => ({id:idOf(n), label:base(n), overflow:true, run:() => n.click()}));

  // ------------------------------------------------------------------ flyouts
  // Rows for a button's flyout, or null for a built-in group (GROUPS, drawings). A promise for a
  // group a module provides: the notebook's Widgets (AtriumWidgetCatalogue.toolGroups).
  async function provided(key, k) {
    if (k !== "schematic" || G.AtriumLabs?.notebookEnabled?.() !== true) return [];
    const L = G.AtriumLazy;
    await L.need("AtriumPalette"); await L.need(["AtriumPaletteActions", "AtriumWidgetCatalogue"]);
    const rows = G.AtriumWidgetCatalogue.toolGroups?.[key]?.() || [];
    for (const r of rows) known.set(r.id, {label:r.label, icon:r.icon || "", group:key});
    return rows;
  }
  function flyout(button, k) {
    const key = button.dataset.toolGroup;
    if (key === "overflow") return overflowRows();
    if (groups.has(key)) return groups.get(key).filter(id => drawable(id, k)).map(id => ({id, label:name(id, k), run:() => run(id)}));
    if (key === "widgets") return provided(key, k);
    return null;
  }
  // Sticky flyouts: the choice becomes the button's face for this kind (view state, not the bar).
  function choose(button, row, k = kind()) {
    if (!button || button === more || row?.overflow || !isId(row?.id)) return;
    const slot = slots.get(button) || idOf(button);
    if (!isId(slot)) return;
    const all = faces(), mine = {...(all[k] || {})}, group = known.get(row.id)?.group;
    if (row.id === slot) delete mine[slot];
    else mine[slot] = group ? {id:row.id, label:row.label, icon:row.icon || known.get(row.id)?.icon || "", group} : row.id;
    if (same(mine, all[k] || {})) return;
    if (Object.keys(mine).length) all[k] = mine; else delete all[k];
    writeFaces(all); render(k);
  }

  // ------------------------------------------------------------------ running a button
  // Buttons the bar builds run like the palette runs a command; the markup's buttons keep the editor's path.
  async function run(id, button) {
    const host = G.AtriumNavHost;
    try {
      if (id === "bar-overflow") return G.AtriumActiveBar.open(button);
      if (id.startsWith("power:")) {
        const m = [...D.querySelectorAll(".menubar [data-power-net]")].find(b => b.dataset.powerNet === id.slice(6));
        if (m) return m.click();
        throw Error(t("bars.unavailable", {name:id.slice(6)}));
      }
      const group = known.get(id)?.group;
      if (group && !command(id)) {
        const row = (await provided(group, kind())).find(r => r.id === id);
        if (!row) throw Error(t("bars.unavailable", {name:known.get(id)?.label || id}));
        return await row.run();
      }
      // A macro with parameters asks for them in its own Run… dialog; one without runs at once.
      const macro = G.AtriumMacros?.forCommand?.(id);
      if (macro?.parameters?.length) return await (await G.AtriumLazy.need("AtriumMacrosUI")).run(macro);
      const c = command(id);
      if (c?.run) return await c.run(c.param);
      if (host) host.executeKey(c ? c.action : id, c?.param);
    } catch (e) { host?.info?.(e.message); }
  }
  function customise() {
    return G.AtriumLazy.need("AtriumPrefs").then(P => P.open("toolbars"), e => G.AtriumNavHost?.info?.(e.message));
  }
  // The bar's context menu on empty space.
  function menu() {
    G.AtriumLazy.need("AtriumContextMenu").then(CM => CM.dropdown(bar, [{label:t("bars.customise"), enabled:true, run:customise}]), () => {});
  }

  // ------------------------------------------------------------------ editing (the Toolbars page)
  const extIds = k => extNodes().filter(n => allows(n.dataset.when || "", k)).map(idOf);
  function setList(k, list) { write(put(G.AtriumPref?.get(PREF), k, list, defaultList(k), extIds(k))); }
  function reset(k) {
    if (k) { setList(k, null); const all = faces(); delete all[k]; writeFaces(all); }
    else { writeFaces({}); write(null); }
    render();
  }
  function clearFaces() { writeFaces({}); render(); }
  // The flyout ids of an item on a kind's bar: a user's group, or the built-in group of a markup button.
  function flyoutOf(x, k) {
    if (object(x)) return members(x).length > 1 ? members(x) : [];
    const key = template(x)?.dataset.toolGroup;
    if (!key) return [];
    if (key === "widgets") return [];
    return M()?.rows(key, k)?.map(r => r.id) || [];
  }
  // What the Toolbars page shows for an id on a kind's bar.
  const info = (id, k) => ({id, label:id.startsWith("power:") ? t("bars.power_port", {net:id.slice(6)}) : name(id, k), icon:iconOf(id, k),
    drawable:drawable(id, k), known:KINDS.some(x => drawable(id, x)) || !!template(id) || !!command(id),
    provided:template(id)?.dataset.toolGroup === "widgets", key:K()?.hintKey(id, k) || ""});

  // ------------------------------------------------------------------ boot
  let watcher = null;
  // The first drawing: the bar stays hidden (active-bar.js) until the faces have their icons.
  function sync() { pairIcons(); render(); return needIcons(drawnIds(kind()))?.then(() => render()); }
  if (bar) {
    bar.addEventListener("click", e => {
      const b = /** @type {HTMLElement|null} */ (e.target).closest?.("[data-bar-run]");
      if (!b || !bar.contains(b)) return;
      e.stopPropagation();
      run(b.dataset.barRun, b);
    });
    // Extension buttons arrive (and leave) on their own: a stored bar places or parks them.
    watcher = new MutationObserver(() => { if (!rendering) queueMicrotask(() => (listFor(kind()) || faces()[kind()] ? render() : fit())); });
    watcher.observe(bar, {childList:true});
    new MutationObserver(() => render()).observe(D.body, {attributes:true, attributeFilter:["data-kind"]});
    let frame = 0;
    new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(fit); }).observe(bar.parentElement || bar);
    // A microtask later, so an imported settings file's flyout faces (written after its preferences) apply too.
    const prefs = P => P?.on?.(PREF, () => queueMicrotask(() => render()));
    if (G.AtriumPrefs) prefs(G.AtriumPrefs); else G.AtriumLazy?.need?.("AtriumPrefs").then(prefs, () => {});
    G.addEventListener?.("storage", e => { if (e.key === FACES) render(); });
    G.AtriumLazy?.register?.("AtriumToolbarsPage", {scripts:["editor/toolbars-page.js"], deps:["AtriumUIKit"]});
    const page = P => P?.registerPage?.({id:"toolbars", title:t("bars.toolbars"), order:4.2, keywords:"toolbars active bar customise customize buttons tools flyout overflow macros",
      resetKeys:[PREF], reset:clearFaces,
      render(c, api) { G.AtriumLazy.appendOnLoad("AtriumToolbarsPage", c, (ui, into) => ui.render(into, api), m => api.el && c.append(api.el("p", "prf-note", m))); }});
    if (G.AtriumPrefs) page(G.AtriumPrefs); else G.AtriumLazy?.need?.("AtriumPrefs").then(page, () => {});
    pairIcons();
    queueMicrotask(fit);
  }
  return Object.freeze({...model, sync, render, fit, flyout, choose, run, menu, customise, effective, defaultList, listFor, setList, reset, clearFaces,
    faces:k => k ? faces()[k] || {} : faces(), flyoutOf, info, drawable, name, kinds:() => KINDS.slice(), loadIcons, PREF, FACES});
})();
if (typeof module !== "undefined") module.exports = globalThis.AtriumBars;
