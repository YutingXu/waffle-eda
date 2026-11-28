"use strict";
// The view for the shared Command Centre and Insert palette. Search, ranking,
// placement, and extension dispatch belong to palette.js and its providers.
globalThis.AtriumPaletteView = (() => {
  const C = globalThis.AtriumNavCommon;
  const t = globalThis.AtriumI18n.define({
    "palette.command_name": "Command palette",
    "palette.insert_name": "Insert palette",
    "palette.search": "Search commands, parts, settings…",
    "palette.search_components": "Search components…",
    "palette.commands": "Type a command…",
    "palette.objects": "Designator, net or pad…",
    "palette.position": "X, Y",
    "palette.insert_search": "Find something to insert…",
    "palette.close": "Close palette",
    "palette.back": "Back to results",
    "palette.results": "Results",
    "palette.group_objects": "Objects",
    "palette.result": "1 result",
    "palette.result_count": "{count} results",
    "palette.result_range": "{shown} of {total} results",
    "palette.searching": "Searching…",
    "palette.no_commands": "No matching commands.",
    "palette.no_objects": "No matching designator, net or pad.",
    "palette.no_results": "No matching results.",
    "palette.preview": "Result preview",
    "palette.preview_symbol": "Symbol for {name}",
    "palette.preview_footprint": "Footprint for {name}",
    "palette.actions": "Actions",
    "palette.insert": "Insert",
    "palette.goto": "Go to",
    "palette.open": "Open",
    "palette.run": "Run",
    "palette.copy": "Copy",
    "palette.group_top": "Top hit",
    "palette.group_insert": "Insert",
    "palette.group_commands": "Commands",
    "palette.group_jumps": "Jumps",
    "palette.group_answer": "Answer",
    "palette.group_documents": "Documents",
    "palette.group_components": "Components",
    "palette.group_pins_pads": "Pins and pads",
    "palette.group_nets": "Nets",
    "palette.group_ports": "Ports and labels",
    "palette.group_library": "Library",
    "palette.group_files": "Files",
    "palette.group_recent_files": "Recent files",
    "palette.group_settings": "Settings",
    "palette.group_help": "Help",
    "palette.group_notebook": "Notebook",
    "palette.group_clipboard": "Clipboard",
    "palette.help": "Use arrow keys to choose, {activate} to act, and Escape to close.",
    "palette.options_help": "Use Tab when options are available, or {shortcut} for actions."
  });

  const artworkAspects = new WeakMap();
  const GROUPS = new Map([
    ["Top hit", "palette.group_top"], ["Insert", "palette.group_insert"], ["Commands", "palette.group_commands"],
    ["Jumps", "palette.group_jumps"], ["Answer", "palette.group_answer"], ["Actions", "palette.actions"],
    ["Documents", "palette.group_documents"], ["Objects", "palette.group_objects"], ["Components", "palette.group_components"], ["Pins and pads", "palette.group_pins_pads"],
    ["Nets", "palette.group_nets"],
    ["Ports and labels", "palette.group_ports"], ["Library", "palette.group_library"], ["Files", "palette.group_files"],
    ["Recent files", "palette.group_recent_files"], ["Settings", "palette.group_settings"], ["Help", "palette.group_help"],
    ["Notebook", "palette.group_notebook"], ["Clipboard", "palette.group_clipboard"]
  ]);
  const ICONS = {
    command:"command", setting:"settings", document:"schematic", file:"folder", recent:"folder", library:"chip",
    component:"chip", part:"chip", pin:"via", pad:"via", port:"label", net:"route", netclass:"route", location:"dcallout",
    insert:"plus", clipboard:"new", snippet:"new", notebook:"comment", widget:"dtable", table:"dtable",
    text:"dtext", math:"measure", calc:"measure", answer:"measure", frame:"project", help:"book"
  };
  const CATEGORY_ICONS = {
    file:"folder", edit:"select", view:"dview", project:"project", place:"plus", design:"board",
    tools:"settings", reports:"dtable", route:"route", routing:"route", window:"dview", panels:"layers", help:"book"
  };
  const ACTION_ICONS = {
    new:"new", open:"open", save:"save", "save-all":"save", "save-as":"save", "save-copy":"save", undo:"undo", redo:"redo",
    cut:"select", copy:"select", paste:"plus", delete:"delete", "zoom-in":"plus", "zoom-out":"minus",
    fit:"fit", "fit-objects":"fit", "fit-document":"fit", grid:"grid", "grid-picker":"grid", "toggle-units":"measure",
    rotate:"rotate", "camera-turn-reset":"rotate", "camera-turn-right":"rotate", "camera-turn-left":"rotate",
    route:"route", via:"via", pan:"pan", "new-schematic":"schematic", "new-pcb":"board", "new-drawing":"drawing",
    preferences:"settings", "keyboard-shortcuts":"command", "export-pdf":"drawing", print:"drawing"
  };
  const actionsKey = e => !e.isComposing && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
  const textKey = value => value?.trim().replace(/[.?!…]+$/, "").toLowerCase();
  const sameText = (a, b) => textKey(a) === textKey(b);
  const containsWords = (title, phrase) => (" " + textKey(title).replaceAll(": ", " ") + " ").includes(" " + textKey(phrase) + " ");
  function resultTitle(entry) {
    const label = text(entry.label);
    const separator = label.indexOf(": ");
    if (entry.kind !== "command" || separator < 0) return label;
    const own = label.slice(separator + 2);
    return containsWords(own, label.slice(0, separator)) ? own : label;
  }
  function breadcrumbs(entry, group, label = resultTitle(entry)) {
    const detail = text(entry.detail), menuPath = entry.kind === "command" && detail.includes(" › ");
    const crumbs = menuPath ? detail.split(" › ") : [detail];
    if (menuPath && sameText(crumbs.at(-1), entry.label.split(": ").at(-1))) crumbs.pop();
    const kept = crumbs.filter((crumb, i) => crumb && !sameText(crumb, label) && !(i === 0 && entry.kind === "command" && sameText(crumb, group)) &&
      !(menuPath && i > 0 && containsWords(label, crumb)) && !crumbs.slice(0, i).some(other => sameText(crumb, other)));
    const source = text(entry.source);
    return {detail:kept.join(" › "), source:source && ![label, group, ...kept].some(other => sameText(source, other)) ? source : ""};
  }
  const text = (value, limit = 600) => typeof value === "string" ? value.slice(0, limit) : "";
  function artworkAspect(def, kind) {
    const A = globalThis.Atrium, geometry = A.geometries(def, kind);
    if (!geometry) return 2;
    if (!artworkAspects.has(geometry)) {
      const box = A.bounds(A.symbolPoints(geometry));
      const ratio = box ? (box[2] - box[0]) / Math.max(.2, box[3] - box[1]) : 2;
      artworkAspects.set(geometry, Math.min(3.6, Math.max(1, ratio)));
    }
    return artworkAspects.get(geometry);
  }
  function glyph(name, fallback = "plus") {
    const icon = typeof name === "string" && /^(?:i-)?[a-z][a-z-]{0,31}$/.test(name) && name.replace(/^i-/, "");
    return C.icon(icon && document.getElementById("i-" + icon) ? icon : fallback);
  }
  function button(label, run, icon, cls = "") {
    const b = C.el("button", icon ? null : label, "ui-button nav-palette-btn" + cls);
    b.dataset.variant = cls.includes("is-primary") ? "primary" : icon ? "quiet" : "secondary";
    b.type = "button";
    if (icon) {b.setAttribute("aria-label", label); b.append(glyph(icon));}
    if (run) b.addEventListener("click", run);
    return b;
  }
  // Clipboard thumbnails are small, host-generated PNGs. Do not load remote artwork or SVG here.
  function thumbnail(url) {
    const prefix = "data:image/png;base64,";
    if (typeof url !== "string" || url.length > 1000000 || !url.startsWith(prefix)) return null;
    const data = url.slice(prefix.length);
    if (!/^[a-z0-9+/]+={0,2}$/i.test(data)) return null;
    try {
      const header = atob(data.slice(0, 32));
      if (!header.startsWith("\x89PNG\r\n\x1a\n") || header.slice(12, 16) !== "IHDR") return null;
      const int = at => [0, 1, 2, 3].reduce((n, k) => n * 256 + header.charCodeAt(at + k), 0);
      return [int(16), int(20)].every(n => n > 0 && n <= 512) ? url : null;
    } catch {return null;}
  }
  function picture(url, alt) {
    const src = thumbnail(url);
    if (!src) return null;
    const img = C.el("img"); img.alt = text(alt); img.src = src;
    return img;
  }
  const equationInk = element => {
    const style = getComputedStyle(element);
    return style.getPropertyValue("--ink").trim() || style.color;
  };
  // Always put a readable string in the tree before requesting an offline renderer.
  function detailEquation(source, display, budget) {
    const tex = text(source, 2000);
    const host = C.el("span", tex, "nav-palette-detail-equation" + (display ? " is-display" : ""));
    host.setAttribute("role", "math"); host.setAttribute("aria-label", tex);
    if (!tex || budget.equations < 1) return host;
    budget.equations--;
    Promise.resolve().then(async () => {
      if (!host.isConnected) return;
      const M = globalThis.AtriumMath || await globalThis.AtriumLazy?.need("AtriumMath");
      if (!M || !host.isConnected) return;
      const layout = M.layout(tex, {display}), size = display ? 23 : 17;
      if (layout.errors?.length || !layout.commands?.length) return;
      const bounds = M.noteDimensions(layout, size), w = Math.ceil(bounds.w) + 2, h = Math.ceil(bounds.h) + 2;
      const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
      const width = Math.ceil(w * ratio), height = Math.ceil(h * ratio), area = width * height;
      if (!(w > 0 && h > 0 && w <= 1024 && h <= 512 && area <= budget.pixels)) return;
      const canvas = C.el("canvas");
      canvas.width = width; canvas.height = height;
      canvas.style.width = w + "px";
      canvas.setAttribute("aria-hidden", "true");
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(ratio, ratio);
      M.draw(ctx, layout, {x: bounds.dx + 1, y: bounds.dy + 1, size, ink: equationInk(host)});
      budget.pixels -= area;
      const transcription = C.el("span", layout.plain || tex, "nav-palette-detail-equation-text");
      host.setAttribute("aria-label", transcription.textContent);
      host.replaceChildren(canvas, transcription);
    }).catch(() => {}); // The escaped source remains readable if layout is unavailable.
    return host;
  }
  function detailRichText(body, budget) {
    const host = C.el("div", null, "nav-palette-rich-text");
    if (!Array.isArray(body?.blocks) || body.blocks.length > 16) return host;
    const blocks = [];
    let remaining = 8192;
    for (const b of body.blocks) {
      if (!Array.isArray(b?.runs) || b.runs.length > 32) continue;
      const runs = [];
      for (const r of b.runs) {
        if (!remaining || !budget.runs || !budget.chars || !["text", "math"].includes(r?.type)) continue;
        const key = r.type === "text" ? "text" : "tex", value = text(r[key], Math.min(2000, remaining, budget.chars));
        if (!value) continue;
        remaining -= value.length; budget.chars -= value.length; budget.runs--;
        const run = {type: r.type, [key]: value};
        for (const mark of ["bold", "italic", "underline", "strike", "code"]) if (r[mark] === true) run[mark] = true;
        runs.push(run);
      }
      if (runs.length) blocks.push({style: b.style, checked: b.checked === true, runs});
    }
    host.textContent = blocks.map(b => b.runs.map(r => r.text || r.tex).join("")).join("\n");
    if (!blocks.length) return host;
    Promise.resolve().then(async () => {
      if (!host.isConnected) return;
      const N = globalThis.AtriumNotebook || await globalThis.AtriumLazy?.need("AtriumNotebook");
      if (!host.isConnected || !N?.validate({blocks})) return;
      const fragment = document.createDocumentFragment();
      let group, previousStyle;
      for (const b of blocks) {
        const list = ["bullet", "number", "check"].includes(b.style);
        const el = C.el(list ? "li" : ["h1", "h2", "h3"].includes(b.style) ? b.style : "p");
        if (list) {
          if (previousStyle !== b.style) { group = C.el(b.style === "number" ? "ol" : "ul"); fragment.append(group); }
          group.append(el);
          if (b.style === "check") {
            group.classList.add("is-checklist");
            const box = C.el("input"); box.type = "checkbox"; box.disabled = true; box.checked = b.checked;
            const label = C.el("label"); label.append(box); el.append(label);
          }
        } else fragment.append(el);
        const target = el.querySelector("label") || el;
        for (const r of b.runs) {
          let content = r.type === "math" ? detailEquation(r.tex, false, budget) : document.createTextNode(r.text);
          for (const [mark, tag] of [["bold", "strong"], ["italic", "em"], ["underline", "u"], ["strike", "s"], ["code", "code"]]) {
            if (r[mark]) { const wrapper = C.el(tag); wrapper.append(content); content = wrapper; }
          }
          target.append(content);
        }
        previousStyle = b.style;
      }
      host.replaceChildren(fragment);
    }).catch(() => {});
    return host;
  }
  function actionLabel(entry) {
    if (entry?.primaryLabel) return text(entry.primaryLabel);
    if (entry?.kind === "answer") return t("palette.copy");
    if (entry?.kind === "command") return t("palette.run");
    if (["location", "object", "component", "pin", "port", "net", "netclass"].includes(entry?.kind)) return t("palette.goto");
    if (["library", "insert", "widget", "snippet", "clipboard"].includes(entry?.kind)) return t("palette.insert");
    return t("palette.open");
  }

  function create(dialog, callbacks) {
    const input = dialog.querySelector('[role="combobox"]'), query = input.parentElement;
    const list = dialog.querySelector(".ui-list[role=listbox]"), resultsRegion = list.parentElement, body = resultsRegion.parentElement;
    const aside = body.querySelector(".nav-palette-preview"), footer = dialog.querySelector(".nav-palette-foot");
    const count = footer.querySelector('[role="status"]');
    const magnifier = query.querySelector(".nav-palette-search-icon"), scopeChip = query.querySelector(".nav-palette-scope-chip"), grip = C.el("div", null, "nav-palette-grip");
    const back = button(t("palette.back"), () => leave(), "chevron", " is-icon is-back"); back.hidden = true;
    const title = C.el("h2", null, "nav-palette-screen-title"); title.hidden = true;
    grip.setAttribute("aria-hidden", "true"); dialog.prepend(grip);
    query.prepend(back); query.append(title);

    const empty = C.el("p", null, "nav-palette-empty"); empty.hidden = true;
    empty.setAttribute("aria-hidden", "true"); resultsRegion.prepend(empty);
    const heading = C.el("h2", null, "nav-palette-preview-title"), detail = C.el("p", null, "nav-palette-preview-detail");
    const head = C.el("div", null, "nav-palette-preview-head"); head.hidden = true; head.append(heading, detail);
    const visual = C.el("div", null, "nav-palette-preview-visual");
    const config = C.el("div", null, "nav-palette-config"); config.hidden = true;
    const content = C.el("div", null, "nav-palette-preview-content");
    content.tabIndex = -1; heading.id = "nav-palette-preview-title";
    content.setAttribute("role", "region"); content.setAttribute("aria-labelledby", heading.id);
    content.append(head, visual, config); aside.append(content);
    const screen = C.el("section", null, "nav-palette-screen"); screen.hidden = true; screen.tabIndex = 0;
    body.after(screen);
    const keymap = globalThis.AtriumKeymap;
    // The chip names the open filter (nav-common.js openPalette); only the Commands name is translated here.
    scopeChip.dataset.commands = t("palette.group_commands");
    const filter = scopeChip.dataset[dialog.dataset.paletteScope] || scopeChip.dataset.commands;
    scopeChip.firstElementChild.textContent = filter; scopeChip.ariaLabel = "Remove " + filter + " scope";
    globalThis.AtriumHost?.macShortcutIntent?.();
    const commands = C.el("div", null, "nav-palette-commands");
    const primary = button("", () => callbacks.run(active), null, " nav-palette-foot-btn");
    const primaryName = C.el("span");
    primary.append(footLabel(primaryName, "Enter"));
    primary.setAttribute("aria-keyshortcuts", "Enter");
    const secondary = button("", () => phase?.kind === "actions" ? leave() : callbacks.actions(active), null, " nav-palette-foot-btn");
    secondary.append(footLabel(C.el("span", t("palette.actions")), "Mod+K"));
    secondary.setAttribute("aria-keyshortcuts", "Meta+K Control+K");
    secondary.setAttribute("aria-haspopup", "menu"); secondary.setAttribute("aria-expanded", "false");
    const dismiss = button("", () => callbacks.close(), null, " nav-palette-foot-btn nav-palette-dismiss");
    const dismissKey = shortcutBadge("Escape"), dismissName = C.el("span", t("palette.close"));
    dismiss.append(dismissKey, dismissName);
    dismiss.setAttribute("aria-label", t("palette.close"));
    dismiss.setAttribute("aria-keyshortcuts", "Escape");
    for (const control of [primary, secondary, dismiss]) {control.dataset.variant = "quiet"; control.dataset.size = "sm";}
    commands.append(primary, secondary, dismiss);
    const menu = C.el("div", null, "nav-palette-action-menu");
    menu.id = "nav-palette-action-menu"; menu.hidden = true;
    menu.setAttribute("role", "menu"); menu.setAttribute("aria-label", t("palette.actions"));
    secondary.setAttribute("aria-controls", menu.id);
    dialog.append(menu);
    const help = C.el("span", null, "visually-hidden"); help.id = "nav-palette-key-help";
    help.textContent = t("palette.help", {activate:keymap.display("Enter", true)}) + " " + t("palette.options_help", {shortcut:keymap.display("Mod+K", true)});
    input.setAttribute("aria-describedby", help.id); footer.append(commands, help);

    let entries = [], nodes = [], cache = new Map(), serial = 0, active = -1, activeKey = null;
    let insertion = false, phase = null, pointer = null, swipe = null;
    let controller = null, previewTimer = 0, draw = null, drawFrame = 0, fadeFrame = 0, visualToken = "";
    let pendingPointerPreview = false;
    const resize = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleDraw) : null;
    const listResize = typeof ResizeObserver === "function" ? new ResizeObserver(() => {
      if (dialog.open && !list.hidden && !body.hidden && nodes[active]) reveal(nodes[active]);
      scheduleFade();
    }) : null;
    const status = value => {if (count.textContent !== value) count.textContent = value;};

    function refreshLabels(isInsert, mode) {
      const name = isInsert ? t("palette.insert_name") : t("palette.command_name");
      dialog.setAttribute("aria-label", name); input.setAttribute("aria-label", name);
      const placeholder = isInsert ? t("palette.insert_search") : mode === ">" ? t("palette.commands") :
        mode === "@" ? t("palette.objects") : mode === ":" ? t("palette.position") :
        dialog.dataset.paletteScope === "library" ? t("palette.search_components") : t("palette.search");
      // Chromium replaces its painted placeholder text node even for a same-value write.
      if (input.placeholder !== placeholder) input.placeholder = placeholder;
      list.setAttribute("aria-label", t("palette.results")); aside.setAttribute("aria-label", t("palette.preview"));
    }
    function rowFor(entry, i, group, match, retain, selected) {
      const enabled = !!entry.run && !entry.disabled;
      const title = resultTitle(entry), {detail, source} = breadcrumbs(entry, group, title);
      const typeIcon = entry.kind === "command" && !entry.provider ?
        ACTION_ICONS[entry.action] || CATEGORY_ICONS[entry.category?.toLowerCase()] || "select" :
        ICONS[entry.kind === "object" ? entry.target?.type : entry.kind] || "new";
      const icon = entry.icon || typeIcon;
      const signature = [title, detail, entry.hint, icon, source, match, enabled].join("\u0000");
      const old = cache.get(entry.key);
      let row = old?.row;
      if (!row || old.signature !== signature) {
        row = C.el("div", null, "ui-row nav-palette-item"); row.id = old?.row.id || "nav-palette-opt-" + ++serial;
        row.setAttribute("role", "option");
        row.append(glyph(icon, typeIcon));
        const copy = C.el("span", null, "nav-palette-item-copy"), label = C.el("span", null, "nav-palette-label");
        label.append(C.highlighted(title, match)); copy.append(label);
        if (detail) copy.append(C.el("span", detail, "nav-palette-detail"));
        row.append(copy);
        if (source) row.append(C.el("span", source, "nav-palette-source"));
        if (entry.hint) {
          const keys = C.el("span", null, "nav-palette-keys"); keys.append(shortcutBadge(entry.hint, false)); row.append(keys);
        }
        if (!enabled) row.setAttribute("aria-disabled", "true");
      }
      row.dataset.i = String(i);
      row.setAttribute("aria-selected", String(selected));
      retain.set(entry.key, {row, signature});
      return row;
    }
    function results(next, state = {}) {
      const {q = "", mode = "", entryMode: entry = "", active: nextActive = 0, instant = false, loading = false} = state;
      insertion = ![">", "@", ":"].includes(mode) && (entry === "insert" || entry === "/" || mode === "/");
      entries = next;
      const fragment = document.createDocumentFragment(), retain = new Map(), groups = next.groups || [], scroll = list.scrollTop;
      const selected = next[nextActive]?.key;
      let group = null, groupIndex = 0, section, sectionCount = 0, container = fragment;
      nodes = next.map((row, i) => {
        if (groups[groupIndex]?.start === i) group = groups[groupIndex++];
        const name = group?.heading || group?.name;
        const translation = !group?.heading && !group?.remote && GROUPS.get(name);
        if (name !== section || i === group?.start) {
          section = name;
          if (!name) container = fragment;
          else {
            container = C.el("div"); container.setAttribute("role", "group");
            const label = C.el("div", translation ? t(translation) : text(name), "nav-palette-group");
            label.id = "nav-palette-group-" + ++sectionCount;
            container.setAttribute("aria-labelledby", label.id); container.append(label); fragment.append(container);
          }
        }
        const option = rowFor(row, i, name, mode === ":" ? "" : q, retain, i === nextActive);
        container.append(option); return option;
      });
      cache = retain;
      list.replaceChildren(fragment);
      list.hidden = !next.length;
      empty.hidden = !!next.length;
      input.setAttribute("aria-expanded", String(!list.hidden));
      refreshLabels(insertion, mode);
      const total = state.total ?? next.total ?? next.length;
      const message = state.diagnostic || (state.counting ? t("palette.searching") : next.length ? (total > next.length ? t("palette.result_range", {shown: next.length, total}) :
        total === 1 ? t("palette.result") : t("palette.result_count", {count: total})) : loading ? t("palette.searching") :
        mode === ">" ? t("palette.no_commands") : mode === "@" ? t("palette.no_objects") : t("palette.no_results"));
      if (empty.textContent !== message) empty.textContent = message;
      status(message);
      list.scrollTop = selected != null && selected === activeKey ? scroll : 0;
      select(nextActive, {scroll: selected != null && selected !== activeKey && nextActive > 0, instant});
      scheduleFade();
    }
    function scheduleFade() {
      if (!dialog.open || fadeFrame) return;
      fadeFrame = requestAnimationFrame(() => {
        fadeFrame = 0;
        resultsRegion.toggleAttribute("data-more-below", !list.hidden && !body.hidden && list.scrollTop + list.clientHeight + 1 < list.scrollHeight);
      });
    }
    function reveal(row) {
      if (row === nodes.at(-1)) {list.scrollTop = list.scrollHeight; return;}
      const outer = list.getBoundingClientRect(), inner = row.getBoundingClientRect();
      if (inner.top < outer.top) list.scrollTop += inner.top - outer.top;
      else {
        const bottom = outer.bottom - 12;
        if (inner.bottom > bottom) list.scrollTop += inner.bottom - bottom;
      }
    }
    function select(index, {scroll = true, event, instant = false} = {}) {
      if (active !== index) nodes[active]?.setAttribute("aria-selected", "false");
      active = index;
      const row = nodes[index], entry = entries[index];
      if (row) {
        row.setAttribute("aria-selected", "true"); input.setAttribute("aria-activedescendant", row.id);
        if (scroll) reveal(row);
      } else input.removeAttribute("aria-activedescendant");
      if (phase?.key && phase.key !== entry?.key) leave();
      activeKey = entry?.key ?? null;
      if (!phase) updatePreview(event, instant);
    }
    function shortcutBadge(binding, hideSpoken = true) {
      const shortcut = globalThis.AtriumShortcut.render(binding);
      if (hideSpoken) shortcut.setAttribute("aria-hidden", "true");
      return shortcut;
    }
    function footLabel(name, binding) {
      const block = C.el("span", null, "nav-palette-foot-label");
      block.append(name, shortcutBadge(binding));
      return block;
    }
    function updatePreview(event, instant = false) {
      const entry = entries[active], request = entry ? callbacks.request?.(active) : null;
      const answer = entry?.kind === "answer" && entry.answer?.state === "ready" ? text(entry.answer.display) : "";
      const name = answer ? text(entry.detail) || text(entry.label) : entry ? resultTitle(entry) : "";
      let description = entry && !answer ? breadcrumbs(entry).detail : "";
      if (entry?.kind === "command" && !entry.provider) description = text(entry.previewText);
      if (sameText(description, name)) description = "";
      const showPreview = !!entry && (entry.kind !== "command" || !!entry.preview || !!description);
      const token = entry ? [entry.key, name, description, text(request?.argument), !!entry.preview, answer].join("\u0000") : "";
      const enabled = !!entry?.run && !entry.disabled;
      const label = entry ? actionLabel(entry) : "";
      primary.hidden = secondary.hidden = !enabled;
      dismiss.hidden = enabled;
      if (primaryName.textContent !== label) primaryName.textContent = label;
      if (token === visualToken && !(instant && pendingPointerPreview)) return;
      visualToken = token;
      stopPreview();
      const showDetails = () => {
        aside.hidden = !showPreview; head.hidden = !entry;
        content.tabIndex = showPreview ? 0 : -1;
        if (heading.textContent !== name) heading.textContent = name;
        if (detail.textContent !== description) detail.textContent = description;
        detail.hidden = !description;
      };
      if (!showPreview) {showDetails(); clearVisual(); return;}
      const settle = event?.type === "pointermove" && typeof entry.preview === "function";
      if (!settle) {showDetails(); clearVisual();}
      const next = new AbortController(); controller = next; pendingPointerPreview = settle;
      const load = async () => {
        previewTimer = 0;
        if (!dialog.open || next.signal.aborted) return;
        let value = answer ? {kind:"answer", text:answer} : null;
        try {
          if (entry.preview) value = await (typeof entry.preview === "function" ? entry.preview({...request, signal:next.signal}) : entry.preview);
        } catch {}
        if (next.signal.aborted || !dialog.open) return;
        pendingPointerPreview = false;
        if (settle) showDetails();
        renderVisual(entry, value, next.signal);
      };
      // Only pointer hover waits for the selection to settle. Keep queued providers cancellable.
      if (settle) previewTimer = setTimeout(load, 60);
      else queueMicrotask(load);
    }
    function stopPreview() {
      controller?.abort(); controller = null; pendingPointerPreview = false;
      clearTimeout(previewTimer); previewTimer = 0;
    }
    function stopDrawing() {
      resize?.disconnect(); draw = null;
      if (drawFrame) cancelAnimationFrame(drawFrame);
      drawFrame = 0;
    }
    function clearVisual() {
      stopDrawing();
      visual.replaceChildren(); delete visual.dataset.kind;
    }
    function scheduleDraw(event) {
      if (event?.type === "atrium-theme") refreshEquationInk();
      if (draw && !drawFrame) drawFrame = requestAnimationFrame(() => {drawFrame = 0; if (dialog.open) draw?.();});
    }
    function renderVisual(entry, value, signal) {
      if (!value) {clearVisual(); return;}
      const kind = value.kind, name = text(value.title || entry.label);
      let node = null, painter = null, equation = null;
      if ((kind === "symbol" || kind === "footprint") && value.def && globalThis.AtriumCanvas?.preview) {
        const documentKind = kind === "symbol" ? "schematic" : "pcb";
        node = C.el("canvas"); node.setAttribute("role", "img"); node.dataset.artwork = kind;
        node.setAttribute("aria-label", t(kind === "symbol" ? "palette.preview_symbol" : "palette.preview_footprint", {name}));
        node.style.setProperty("--palette-art-aspect", artworkAspect(value.def, documentKind));
        painter = () => {if (node.isConnected) try {AtriumCanvas.preview(node, value.def, documentKind);} catch {}};
      } else if (kind === "widget" && value.scene && globalThis.AtriumSheetWidgets) {
        node=C.el("canvas"); node.setAttribute("role","img");node.setAttribute("aria-label",name);
        painter=()=>{if (!node.isConnected) return;const ratio=globalThis.devicePixelRatio || 1, width=node.clientWidth || 180;
          node.width=Math.ceil(width*ratio);node.height=Math.ceil(node.width*value.scene.height/value.scene.width);
          const c=node.getContext("2d"), k=node.width/value.scene.width;c.setTransform(k,0,0,k,0,0);
          AtriumSheetWidgets.draw(c,value.scene,{theme:globalThis.AtriumSheetWidgetRuntime?.theme()});};
      } else if (kind === "image") {
        node = picture(value.url, value.alt || name);
      } else if (kind === "equation" && typeof value.tex === "string" && typeof globalThis.AtriumMathEditor?.preview === "function") {
        node = C.el("div", null, "nav-palette-equation");
        equation = () => AtriumMathEditor.preview(node, {tex:value.tex, signal});
      } else if (typeof value.text === "string" && value.text.trim() !== text(entry.detail).trim()) {
        node = C.el("p", text(value.text, 1600), entry.kind === "answer" ? "nav-palette-answer" : "nav-palette-plain");
      }
      if (!node) {clearVisual(); return;}
      clearVisual();
      visual.dataset.kind = kind || "text";
      visual.append(node);
      equation?.();
      draw = painter;
      if (draw) {draw(); resize?.observe(node);}
    }

    function options(index, request) {
      const entry = entries[index];
      if (!entry?.options?.length || !entry.run || entry.disabled) return false;
      stopPreview();
      phase = {kind: "options", key: entry.key};
      back.hidden = false; magnifier.setAttribute("hidden", "");
      visual.hidden = footer.hidden = true; aside.hidden = config.hidden = head.hidden = false; content.scrollTop = 0;
      heading.textContent = resultTitle(entry);
      detail.textContent = breadcrumbs(entry).detail;
      detail.hidden = !detail.textContent;
      const form = fields(entry.options, request?.values, actionLabel(entry), values => {
        const current = entries.findIndex(e => e.key === entry.key);
        if (current >= 0) callbacks.run(current, values);
      });
      config.replaceChildren(form);
      form.querySelector("input, select, button")?.focus({preventScroll: true});
      return true;
    }
    function fields(specs, values, label, submit) {
      const form = C.el("form", null, "nav-palette-forms"), controls = [];
      for (const spec of (Array.isArray(specs) ? specs : []).slice(0, 40)) {
        const id = text(spec?.id ?? spec?.key, 64);
        if (!id) continue;
        const control = C.el(spec.type === "select" ? "select" : "input", null, "ui-field");
        if (control.tagName === "SELECT") {
          for (const choice of (Array.isArray(spec.choices) ? spec.choices : []).slice(0, 100)) {
            const value = choice?.value ?? choice?.id;
            if (value == null) continue;
            const option = C.el("option", String(choice.label ?? value)); option.value = String(value); control.append(option);
          }
        } else control.type = spec.type === "number" ? "number" : "text";
        if (control.type === "number") {
          control.step = "any";
          for (const limit of ["min", "max"]) if (Number.isFinite(spec[limit])) control[limit] = String(spec[limit]);
        }
        if (control.type === "text" && Number.isInteger(spec.maxLength) && spec.maxLength >= 0) control.maxLength = spec.maxLength;
        control.required = !!spec.required;
        const value = values && Object.hasOwn(values, id) ? values[id] : spec.value;
        if (value != null) control.value = String(value);
        const field = C.el("label"), caption = C.el("span", text(spec.label) || id);
        caption.id = "nav-palette-field-" + ++serial;
        control.setAttribute("aria-labelledby", caption.id); field.append(caption, control);
        controls.push({id, control}); form.append(field);
      }
      const apply = button(label, null, null, " is-primary"); apply.type = "submit";
      form.append(apply);
      form.addEventListener("submit", e => {e.preventDefault(); submit(Object.fromEntries(controls.map(({id, control}) => [id, control.value])));});
      return form;
    }
    function actions(index, descriptions) {
      if (!entries[index] || !Array.isArray(descriptions) || !descriptions.length) return false;
      if (phase?.kind === "actions") return leave();
      const items = [];
      for (const action of descriptions.slice(0, 40)) {
        const label = text(action?.label);
        if (!label) continue;
        const item = button(label, () => {leave(); action.run?.();}, null, " nav-palette-action-item");
        item.dataset.variant = "quiet";
        item.setAttribute("role", "menuitem");
        item.tabIndex = -1;
        if (action.hint) item.append(shortcutBadge(action.hint));
        item.disabled = !!action.disabled || typeof action.run !== "function";
        items.push(item);
      }
      const first = items.find(item => !item.disabled);
      if (!first) return false;
      phase = {kind: "actions", key: entries[index].key};
      menu.replaceChildren(...items); menu.hidden = false;
      secondary.setAttribute("aria-expanded", "true");
      first.focus({preventScroll: true});
      return true;
    }
    function screenItems(model, run) {
      const items = C.el("ul", null, "nav-palette-screen-items"); items.dataset.kind = model.kind;
      items.setAttribute("role", "list");
      for (const item of (Array.isArray(model.items) ? model.items : []).slice(0, 120)) {
        const label = text(item?.label);
        if (!label) continue;
        const li = C.el("li", null, "nav-palette-screen-item");
        const btn = button("", () => run?.(item.id), null, " nav-palette-screen-item-main");
        btn.disabled = !!item.disabled || typeof run !== "function";
        const image = item.thumbnail?.kind === "png" && picture(item.thumbnail.data, item.thumbnail.alt);
        if (image) btn.append(image);
        else if (item.icon) btn.append(glyph(item.icon));
        const title = C.el("span", label); title.id = "nav-palette-item-name-" + ++serial;
        const copy = C.el("span", null, "nav-palette-screen-item-copy"); copy.append(title);
        if (item.detail) copy.append(C.el("small", text(item.detail)));
        btn.append(copy);
        if (item.accessory) btn.append(C.el("small", text(item.accessory), "nav-palette-screen-accessory"));
        li.append(btn);
        if (Array.isArray(item.actions) && item.actions.length && typeof run === "function") {
          const actions = C.el("div", null, "nav-palette-screen-item-actions");
          for (const action of item.actions.slice(0, 12)) {
            if (!action?.label) continue;
            const choice = button(text(action.label), () => run(action.id, item.id));
            choice.setAttribute("aria-describedby", title.id); choice.disabled = !!action.disabled;
            actions.append(choice);
          }
          li.append(actions);
        }
        items.append(li);
      }
      return items;
    }
    function present(model, handlers = {}) {
      if (!model || !["list", "grid", "detail", "form"].includes(model.kind)) return false;
      stopPreview();
      phase = {kind: "screen", back: handlers.back};
      input.hidden = body.hidden = footer.hidden = true; magnifier.setAttribute("hidden", "");
      back.hidden = title.hidden = screen.hidden = false;
      title.textContent = text(model.title || entries[active]?.label);
      screen.setAttribute("aria-label", title.textContent || t("palette.actions"));
      screen.replaceChildren();
      screen.scrollTop = 0;
      if (!config.hidden) {config.hidden = true; config.replaceChildren();}
      if (model.text) screen.append(C.el("p", text(model.text, 2400), "nav-palette-screen-copy" + (model.outputType === "quantity" ? " nav-palette-answer" : "")));
      if (model.kind === "list" || model.kind === "grid") {
        screen.append(screenItems(model, handlers.run));
      }
      if (model.kind === "form") {
        screen.append(fields(model.fields, null, text(model.primary?.label) || t("palette.run"), values => handlers.submit?.(values, model.primary?.id)));
      }
      if (model.kind === "detail") {
        const budget = {equations: 32, pixels: 2000000, runs: 256, chars: 16384};
        for (const block of (Array.isArray(model.blocks) ? model.blocks : []).slice(0, 32)) {
          if (block?.kind === "text") {
            screen.append(C.el("p", text(block.text, 2400), "nav-palette-screen-copy"));
          } else if (block?.kind === "math") {
            screen.append(detailEquation(block.text, true, budget));
          } else if (block?.kind === "richText") {
            screen.append(detailRichText(block.body, budget));
          } else if (block?.kind === "image" && block.image?.kind === "png") {
            const image = picture(block.image.data, block.image.alt);
            if (image) screen.append(image);
          }
        }
        if (model.primary?.label) screen.append(button(text(model.primary.label), () => handlers.run?.(model.primary.id), null, " is-primary"));
      }
      if (model.actions?.length) {
        const row = C.el("div", null, "nav-palette-cta");
        for (const action of model.actions.slice(0, 20)) if (action?.label) row.append(button(text(action.label), () => handlers.run?.(action.id)));
        screen.append(row);
      }
      (screen.querySelector("input, select, button:enabled") || screen).focus({preventScroll: true});
      return true;
    }
    function leave(focus = true, repaint = true) {
      const previous = phase; phase = null;
      if (!previous) return false;
      if (previous.kind === "actions") {
        menu.hidden = true; menu.replaceChildren();
        secondary.setAttribute("aria-expanded", "false");
        if (focus) input.focus({preventScroll:true});
        if (repaint && dialog.open) updatePreview();
        return true;
      }
      if (focus && typeof previous.back === "function") {
        const handled = previous.back();
        if (phase) return true;
        if (handled === false) {phase = previous; return true;}
      }
      screen.hidden = back.hidden = title.hidden = config.hidden = true;
      input.hidden = body.hidden = footer.hidden = visual.hidden = false; magnifier.removeAttribute("hidden");
      visualToken = "";
      screen.replaceChildren(); config.replaceChildren();
      if (focus) input.focus({preventScroll: true});
      if (repaint && dialog.open) updatePreview();
      return true;
    }
    function panelKeys(e) {
      if (e.isComposing) return;
      if (actionsKey(e) && (!phase && e.target !== input || phase?.kind === "actions")) {
        e.preventDefault(); e.stopPropagation();
        if (phase) leave();
        else callbacks.actions(active);
        return;
      }
      if (!phase) return;
      if (e.key === "Escape" || phase.kind === "actions" && e.key === "Tab") {
        e.preventDefault(); e.stopPropagation(); leave(); return;
      }
      const step = {ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1}[e.key];
      if (!step && !["Home", "End"].includes(e.key)) return;
      const items = e.target.closest?.(".nav-palette-action-menu, .nav-palette-screen-items");
      if (!items) return;
      const buttons = [...items.querySelectorAll(items.dataset.kind ? ".nav-palette-screen-item-main:enabled" : "button:enabled")];
      const i = buttons.indexOf(e.target.closest?.("button"));
      if (i < 0) return;
      e.preventDefault(); e.stopPropagation();
      const j = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (i + step + buttons.length) % buttons.length;
      buttons[j]?.focus();
    }

    const rowAt = e => e.target.closest?.("[data-i]");
    list.addEventListener("scroll", scheduleFade, {passive:true});
    secondary.addEventListener("keydown", e => {
      if (e.key === "ArrowDown") {e.preventDefault(); callbacks.actions(active);}
    });
    dialog.addEventListener("pointerdown", e => {
      if (phase?.kind === "actions" && !menu.contains(e.target) && !secondary.contains(e.target)) leave();
    });
    list.addEventListener("pointerdown", e => {pointer = {type: e.pointerType, row: rowAt(e)};});
    list.addEventListener("pointercancel", () => {pointer = null;});
    list.addEventListener("pointermove", e => {
      if (phase || e.pointerType !== "mouse" || e.buttons) return;
      const row = rowAt(e), i = row && Number(row.dataset.i);
      if (row && i !== active) callbacks.choose(i, false, e);
    });
    list.addEventListener("click", e => {
      const row = rowAt(e);
      if (!row) return;
      const index = Number(row.dataset.i), touch = e.pointerType === "touch" || pointer?.type === "touch" && pointer.row === row;
      pointer = null;
      if (touch) {callbacks.choose(index, false, e); input.focus({preventScroll: true});}
      else callbacks.run(index);
    });
    dialog.addEventListener("keydown", panelKeys, true);
    grip.addEventListener("pointerdown", e => {
      if (e.pointerType !== "touch") return;
      swipe = {id: e.pointerId, x: e.clientX, y: e.clientY};
      try {grip.setPointerCapture(e.pointerId);} catch {}
    });
    grip.addEventListener("pointerup", e => {
      if (e.pointerId !== swipe?.id) return;
      const dx = Math.abs(e.clientX - swipe.x), dy = e.clientY - swipe.y;
      swipe = null;
      if (dy >= 64 && dy > dx * 1.5) callbacks.close();
    });
    for (const type of ["pointercancel", "lostpointercapture"]) grip.addEventListener(type, () => {swipe = null;});
    function refreshEquationInk() {
      for (const canvas of screen.querySelectorAll(".nav-palette-detail-equation canvas")) {
        const ctx = canvas.getContext("2d");
        ctx.save(); ctx.resetTransform();
        ctx.globalCompositeOperation = "source-in";
        ctx.fillStyle = equationInk(canvas);
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.restore();
      }
    }
    function open(context = {}) {
      dialog.dataset.palettePointer = context.pointerType || "";
      const touch = context.pointerType === "touch" || globalThis.matchMedia("(any-pointer:coarse)").matches;
      dismissKey.hidden = touch;
      dismissName.hidden = !touch;
      listResize?.observe(list);
      globalThis.addEventListener("atrium-theme", scheduleDraw);
    }
    function close() {
      stopPreview(); leave(false, false); clearVisual(); visualToken = "";
      if (fadeFrame) cancelAnimationFrame(fadeFrame);
      fadeFrame = 0; resultsRegion.removeAttribute("data-more-below");
      entries = []; nodes = []; cache.clear(); active = -1; activeKey = null;
      list.replaceChildren(); list.hidden = aside.hidden = head.hidden = primary.hidden = secondary.hidden = empty.hidden = true;
      input.removeAttribute("aria-activedescendant"); input.setAttribute("aria-expanded", "false");
      content.tabIndex = -1; status("");
      swipe = pointer = null;
      listResize?.disconnect();
      globalThis.removeEventListener("atrium-theme", scheduleDraw);
    }
    return {open, close, results, select, options, actions, actionsKey, present, back: leave};
  }
  return Object.freeze({create, resultTitle});
})();
