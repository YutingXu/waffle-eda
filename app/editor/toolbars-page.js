"use strict";
// Preferences › Toolbars: the Active Bar for each document kind (docs/design/customisable-bars.md).
// Lazy (bars.js registers the page and loads this when it first renders). Every control is from the
// UI kit; the button list is K.reorderable (keyboard, mouse, pen and touch). Each edit is stored in
// "workbench.bars" at once, so the real bar follows while Preferences stays open.
globalThis.AtriumToolbarsPage = (() => {
  const G = globalThis, D = G.document, K = G.AtriumUIKit, B = () => G.AtriumBars, SEP = "|";
  const t = G.AtriumI18n.define({
    "toolbars.bar": "Active Bar",
    "toolbars.kind": "Document kind",
    "toolbars.kind_schematic": "Schematic",
    "toolbars.kind_pcb": "PCB",
    "toolbars.kind_drawing": "Drawing",
    "toolbars.buttons": "Active Bar buttons",
    "toolbars.separator": "Separator",
    "toolbars.add_separator": "Add Separator",
    "toolbars.reset": "Reset",
    "toolbars.reset_title": "Put this kind’s bar back to the default",
    "toolbars.add": "Add a button",
    "toolbars.search": "Search commands and macros",
    "toolbars.remove": "Remove {name}",
    "toolbars.more": "More actions for {name}",
    "toolbars.move_up": "Move Up",
    "toolbars.move_down": "Move Down",
    "toolbars.into_flyout": "Add to Flyout of Previous Button",
    "toolbars.out_of_flyout": "Move Out of Flyout",
    "toolbars.flyout": "Flyout: {names}",
    "toolbars.unavailable": "Not available now; kept for when it returns",
    "toolbars.not_here": "Not shown on this kind",
    "toolbars.count": "{count} of {limit} buttons",
    "toolbars.full": "The bar holds at most {limit} buttons. Remove one to add another.",
    "toolbars.flyout_full": "A flyout holds at most {limit} commands.",
    "toolbars.help": "Drag a button by its handle, or select it and press {up} or {down}. Right-click a button on the bar for its flyout.",
    "toolbars.no_match": "No commands match.",
    "toolbars.provided": "Its flyout lists what the notebook can insert"
  });
  const object = v => !!v && typeof v === "object" && !Array.isArray(v);
  const idOf = x => object(x) ? x.face : x;
  const clone = x => JSON.parse(JSON.stringify(x));
  const kinds = () => [["schematic", t("toolbars.kind_schematic")], ["pcb", t("toolbars.kind_pcb")], ["drawing", t("toolbars.kind_drawing")]];
  let kind = (D.body.dataset.kind && kinds().some(([k]) => k === D.body.dataset.kind)) ? D.body.dataset.kind : "schematic";
  // Expanded groups, by the item's face id: a move or an edit above keeps the same group expanded.
  const open = new Set();

  function render(into, api) {
    const card = api.group(into, t("toolbars.bar"));
    const status = K.el("p", "prf-help"); status.setAttribute("role", "status");
    const seg = K.segmented(kinds(), {value:kind, label:t("toolbars.kind"), onChange:v => { kind = v; draw(); }});
    const reset = K.button(t("toolbars.reset"), {variant:"quiet", size:"sm", title:t("toolbars.reset_title"), run:() => { B().reset(kind); open.clear(); draw(); }});
    const addSep = K.button(t("toolbars.add_separator"), {variant:"quiet", size:"sm", run:() => edit(list => list.push(SEP))});
    const count = K.el("span", "prf-help");
    const list = K.list([], {label:t("toolbars.buttons"), role:"tree"});
    const help = K.el("p", "prf-help", t("toolbars.help", {up:G.AtriumKeymap?.display("Alt+Up") || "Alt+↑", down:G.AtriumKeymap?.display("Alt+Down") || "Alt+↓"}));
    card.append(K.toolbar([seg, "->", count, addSep, reset], {label:t("toolbars.bar"), wrap:true}), list, help, status);
    card.dataset.search = (t("toolbars.bar") + " toolbar active bar buttons").toLowerCase();
    const add = api.group(into, t("toolbars.add"));
    const results = K.list([], {label:t("toolbars.add")});
    const search = K.search({placeholder:t("toolbars.search"), onInput:() => found()});
    add.append(search, results);
    let meta = [];
    K.reorderable(list, {canMove:(from, to) => target(from, to) != null, onMove:(from, to) => move(from, target(from, to))});

    // ---------------------------------------------------------------- the list
    const current = () => clone(B().effective(kind));
    function edit(change) {
      const next = current();
      if (change(next) === false) return;
      if (next.length > B().LIMITS.bar) { say(t("toolbars.full", {limit:B().LIMITS.bar})); return; }
      B().setList(kind, next); say(""); draw();
    }
    const say = text => { status.textContent = text || ""; };
    // A group item in place of a markup button with a built-in flyout, so its members can change.
    const asGroup = (x, k) => object(x) ? x : {face:x, more:B().flyoutOf(x, k)};
    function draw() {
      const items = B().effective(kind), rows = [];
      meta = [];
      for (const [b, label] of kinds()) seg.querySelector('[value="' + b + '"]')?.setAttribute("aria-pressed", String(b === kind));
      count.textContent = t("toolbars.count", {count:items.length, limit:B().LIMITS.bar});
      reset.disabled = !B().listFor(kind) && !Object.keys(B().faces(kind)).length;
      items.forEach((x, i) => {
        if (x === SEP) {
          meta.push({top:i}); rows.push(itemRow({title:t("toolbars.separator"), depth:0}, i, null)); return;
        }
        const id = idOf(x), info = B().info(id, kind), flyout = B().flyoutOf(x, kind), group = flyout.length > 1;
        const provided = !object(x) && info.provided;
        const names = flyout.filter(m => m !== id).map(m => B().info(m, kind).label);
        const detail = !info.known ? t("toolbars.unavailable") : !info.drawable ? t("toolbars.not_here") : group ? t("toolbars.flyout", {names:names.join(", ")}) : provided ? t("toolbars.provided") : "";
        meta.push({top:i});
        rows.push(itemRow({title:info.label, detail, icon:info.icon, key:info.key, state:info.known ? undefined : "pending", depth:0, expanded:group ? open.has(id) : undefined}, i, null, id));
        if (group && open.has(id)) flyout.forEach((m, j) => {
          const mi = B().info(m, kind);
          meta.push({top:i, member:j});
          rows.push(itemRow({title:mi.label, detail:mi.known ? "" : t("toolbars.unavailable"), icon:mi.icon, key:mi.key, depth:1}, i, j));
        });
      });
      const focus = list.contains(D.activeElement) ? [...list.children].indexOf(/** @type {Element} */ (D.activeElement).closest(".ui-row")) : -1;
      list.replaceChildren(...rows);
      if (focus >= 0) queueMicrotask(() => list.children[Math.min(focus, list.children.length - 1)]?.focus());
      found();
    }
    function itemRow({title, detail, icon, key, state, depth, expanded}, i, j, id) {
      const toggle = on => { if (on ?? !open.has(id)) open.add(id); else open.delete(id); draw(); };
      const actions = [];
      const menu = K.iconButton("more", t("toolbars.more", {name:title}), {size:"sm"});
      G.AtriumNavCommon.actionMenu(menu, () => commands(i, j));
      actions.push(menu, K.iconButton("close", t("toolbars.remove", {name:title}), {size:"sm", run:() => remove(i, j)}));
      const badge = key ? G.AtriumShortcut.render(key, {variant:"inline"}) : undefined;
      const r = K.row({title, detail, icon:icon || undefined, meta:badge, actions, depth, expanded, state, role:"treeitem"});
      if (expanded != null) r.addEventListener("click", e => { if (!e.target.closest(".ui-row-actions,.ui-drag-handle")) toggle(); });
      r.addEventListener("keydown", e => {
        if (e.target !== r) return;
        if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); remove(i, j); }
        if (expanded != null && (e.key === "ArrowRight" || e.key === "ArrowLeft")) { e.preventDefault(); toggle(e.key === "ArrowRight"); }
      });
      return r;
    }
    // The menu of one row: moves for touch and keyboard users, flyout grouping, removal.
    function commands(i, j) {
      const items = B().effective(kind), x = items[i];
      if (j != null) {
        const members = B().flyoutOf(x, kind), face = members[j] === idOf(x);
        return [
          {label:t("toolbars.move_up"), enabled:j > 0, run:() => moveMember(i, j, j - 1)},
          {label:t("toolbars.move_down"), enabled:j < members.length - 1, run:() => moveMember(i, j, j + 1)},
          {label:t("toolbars.out_of_flyout"), enabled:!face, run:() => outOfFlyout(i, j)}
        ];
      }
      const prev = items[i - 1];
      return [
        {label:t("toolbars.move_up"), enabled:i > 0, run:() => move(flat(i), i - 1)},
        {label:t("toolbars.move_down"), enabled:i < items.length - 1, run:() => move(flat(i), i + 1)},
        {label:t("toolbars.into_flyout"), enabled:x !== SEP && prev != null && prev !== SEP, run:() => intoFlyout(i)}
      ];
    }
    const flat = i => meta.findIndex(m => m.top === i && m.member == null);
    // Where a drag or Alt+arrow from one row lands: another top item, or a place in the same flyout.
    function target(from, to) {
      const a = meta[from], b = meta[to];
      if (!a || !b || from === to) return null;
      if (a.member != null) return b.member != null && b.top === a.top ? b.member : null;
      const top = b.member == null ? b.top : b.top === a.top ? a.top + (to > from ? 1 : 0) : b.top;
      return top === a.top ? null : top;
    }
    // Returns the moved row's place in the redrawn list, so focus stays on it (K.reorderable).
    function move(from, to) {
      const a = meta[from];
      if (to == null || !a) return undefined;
      if (a.member != null) { moveMember(a.top, a.member, to); return meta.findIndex(m => m.top === a.top && m.member === to); }
      edit(list => { const [x] = list.splice(a.top, 1); list.splice(to, 0, x); });
      return flat(to);
    }
    function moveMember(i, j, to) {
      edit(list => {
        const g = list[i] = asGroup(list[i], kind), m = B().members(g);
        const [x] = m.splice(j, 1); m.splice(to, 0, x);
        g.more = m;
      });
    }
    function remove(i, j) {
      edit(list => {
        if (j == null) { open.delete(idOf(list[i])); list.splice(i, 1); return; }
        const g = list[i] = asGroup(list[i], kind), m = B().members(g);
        m.splice(j, 1);
        if (!m.length) { list.splice(i, 1); return; }
        if (!m.includes(g.face)) { if (open.delete(g.face)) open.add(m[0]); g.face = m[0]; }
        g.more = m;
      });
    }
    function intoFlyout(i) {
      edit(list => {
        const g = list[i - 1] = asGroup(list[i - 1], kind), m = B().members(g), x = list[i];
        for (const id of object(x) ? B().members(x) : [x]) if (!m.includes(id)) m.push(id);
        if (m.length > B().LIMITS.flyout) { say(t("toolbars.flyout_full", {limit:B().LIMITS.flyout})); return false; }
        g.more = m; list.splice(i, 1); open.add(g.face);
      });
    }
    function outOfFlyout(i, j) {
      edit(list => {
        const g = list[i] = asGroup(list[i], kind), m = B().members(g), [id] = m.splice(j, 1);
        g.more = m; list.splice(i + 1, 0, id);
      });
    }

    // ---------------------------------------------------------------- adding
    // The palette's search (aliases, keywords, acronyms) for this kind, then every command and Place ›
    // Power Port net it does not list, so commands for another kind can be added too.
    let palette = null;
    G.AtriumLazy.need("AtriumPalette").then(P => P.loadIndex().then(() => { palette = P; found(); })).catch(() => {});
    function candidates(q) {
      const out = new Map(), want = q.trim().toLowerCase();
      const keep = (id, label, detail) => { if (id && !out.has(id) && B().drawable(id, kind)) out.set(id, {id, label, detail}); };
      if (want && palette && kind === (D.body.dataset.kind || "schematic")) {
        for (const e of palette.searchAll(q, ">") || []) {
          const m = /^(?:cmd|menu):(.+)$/.exec(e.key || "");
          keep(m ? m[1] : /^power:/.test(e.key) ? e.key : null, e.label, e.detail);
        }
      }
      for (const n of D.querySelectorAll(".menubar [data-power-net]:not([data-power-net=''])")) {
        const id = "power:" + n.dataset.powerNet, label = B().info(id, kind).label;
        if (!want || label.toLowerCase().includes(want)) keep(id, label, "Place › Power Port");
      }
      for (const c of G.AtriumKeymap?.commands() || []) {
        const label = c.titles?.[kind] || c.title;
        if (want && (label + " " + c.id + " " + c.category).toLowerCase().includes(want)) keep(c.id, label, c.category);
      }
      return [...out.values()];
    }
    function found() {
      const q = search.input.value, onBar = new Set(B().effective(kind).flatMap(x => x === SEP ? [] : [idOf(x), ...B().members(x)]));
      if (!q.trim()) { results.replaceChildren(); search.setCount(""); return; }
      const list = candidates(q).filter(c => !onBar.has(c.id)).slice(0, 12);
      search.setCount(list.length ? String(list.length) : "");
      results.replaceChildren(...(list.length ? list.map(c => {
        const info = B().info(c.id, kind);
        return K.row({title:c.label || info.label, detail:c.detail, icon:info.icon || undefined, meta:info.key ? G.AtriumShortcut.render(info.key, {variant:"inline"}) : undefined,
          run:() => edit(list => list.push(c.id))});
      }) : [K.el("p", "prf-help", t("toolbars.no_match"))]));
    }
    const off = G.AtriumPrefs?.on?.(B().PREF, () => { if (card.isConnected) draw(); else off?.(); });
    draw();
    B().loadIcons?.().then(() => { if (card.isConnected) draw(); });
  }
  return Object.freeze({render});
})();
