"use strict";
// AtriumUIKit: small builders for the UI library (docs/ui-library.md). Each returns plain DOM that
// carries the library classes from ui/controls.css and ui/components.css, so a feature never writes
// its own control CSS. Lazy: `await AtriumLazy.need("AtriumUIKit")`. Static markup may use the same
// classes directly; the builders add the roles, states and keyboard behaviour that go with them.
// Dialogs stay with AtriumShell.dialog, dropdowns with a native <select> (AtriumSelectPopup opens
// it), menus with AtriumContextMenu, shortcuts with AtriumShortcut and toasts with AtriumToast.
globalThis.AtriumUIKit = (() => {
  const doc = globalThis.document;
  /** @param {string} tag @param {string} [cls] @param {string|null} [text] */
  function el(tag, cls, text) {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  /** @param {string} name the icon-bank id without "i-" */
  function icon(name) {
    const ns = "http://www.w3.org/2000/svg", svg = doc.createElementNS(ns, "svg"), use = doc.createElementNS(ns, "use");
    svg.setAttribute("class", "icon"); svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", "#i-" + name); svg.append(use);
    return svg;
  }
  const put = (node, child) => { if (child != null && child !== false) node.append(child); return node; };
  const tone = (node, value) => { if (value) node.dataset.tone = value; else delete node.dataset.tone; return node; };

  /** A text button. variant: "secondary" (default), "primary", "quiet" or "danger"; size "sm", "md" or "lg". */
  function button(label, {variant = "secondary", size, run, title, pressed, disabled} = {}) {
    return globalThis.AtriumUI.nativeButton(label, null, null, title, {variant, size, run, pressed, disabled});
  }
  /** A square icon-only button. The label is its accessible name and tooltip. */
  function iconButton(name, label, {size, run, pressed, disabled} = {}) {
    const b = /** @type {HTMLButtonElement} */ (el("button", "ui-icon-button"));
    b.type = "button"; b.setAttribute("aria-label", label); b.title = label; b.append(icon(name));
    if (size) b.dataset.size = size;
    if (pressed != null) b.setAttribute("aria-pressed", String(!!pressed));
    if (disabled) b.disabled = true;
    if (run) b.addEventListener("click", run);
    return b;
  }
  /** The dialog and panel close button: the shared close icon, "Close" for assistive technology. */
  function closeButton(run, label = "Close") {
    const b = /** @type {HTMLButtonElement} */ (el("button", "ui-close", "×"));
    b.type = "button"; b.setAttribute("aria-label", label); b.title = label;
    if (run) b.addEventListener("click", run);
    return b;
  }
  /** A chip. With onToggle it is a toggle (aria-pressed); with onRemove it gets a remove button. */
  function chip(label, {pressed, onToggle, onRemove, title, invalid} = {}) {
    const c = el(onToggle ? "button" : "span", "ui-chip");
    put(c, el("span", "ui-chip-label", label));
    if (title) c.title = title;
    if (invalid) c.dataset.invalid = "true";
    if (onToggle) {
      const b = /** @type {HTMLButtonElement} */ (c); b.type = "button";
      b.setAttribute("aria-pressed", String(!!pressed));
      b.addEventListener("click", () => {
        const on = b.getAttribute("aria-pressed") !== "true";
        b.setAttribute("aria-pressed", String(on)); onToggle(on, b);
      });
    } else if (pressed) c.classList.add("is-on");
    if (onRemove) {
      const x = /** @type {HTMLButtonElement} */ (el("button", "ui-chip-remove", "×"));
      x.type = "button"; x.setAttribute("aria-label", "Remove " + label); x.title = "Remove";
      x.addEventListener("click", event => { event.stopPropagation(); onRemove(c); });
      c.append(x);
    }
    return c;
  }
  /** A wrapping row of chips. */
  const chips = (items, label) => { const n = el("div", "ui-chips"); if (label) { n.setAttribute("role", "group"); n.setAttribute("aria-label", label); } n.append(...items); return n; };
  /** A state label. tone: info, success, warning, danger, accent or none (neutral). */
  const badge = (text, toneName) => tone(el("span", "ui-badge", text), toneName);
  /** A number beside a label. {strong:true} with tone "danger" gives the solid red count. */
  function count(n, {tone: toneName, strong, label} = {}) {
    const c = tone(el("span", "ui-count", String(n)), toneName);
    if (strong) c.dataset.strong = "";
    if (label) c.setAttribute("aria-label", label);
    return c;
  }
  /** A status dot; pulse adds a still halo for a live state (recording, connecting). */
  function dot(toneName, {pulse, label} = {}) {
    const d = tone(el("span", "ui-dot"), toneName);
    if (pulse) d.dataset.pulse = "";
    if (label) { d.setAttribute("role", "img"); d.setAttribute("aria-label", label); } else d.setAttribute("aria-hidden", "true");
    return d;
  }
  /** An avatar: a person's initials or a monogram. hue 0-4 is an identity colour (a stable hash of the id);
   *  size sm (14 px) or lg (32 px); shape "square" for a monogram; state active, away or stale. */
  function avatar(text, {hue, size, shape, state, label} = {}) {
    const a = el("span", "ui-avatar", text);
    if (hue != null) a.dataset.hue = String(hue);
    if (size) a.dataset.size = size;
    if (shape) a.dataset.shape = shape;
    if (state) a.dataset.state = state;
    if (label) { a.setAttribute("role", "img"); a.setAttribute("aria-label", label); }
    return a;
  }
  /** A short label over artwork; put it inside the positioned artwork box. */
  const overlayLabel = text => el("span", "ui-overlay-label", text);
  /** A text field. type "number" gets the number width; unit adds the unit after it. */
  function field({type = "text", value = "", placeholder, label, unit, invalid, disabled, onInput} = {}) {
    const input = /** @type {HTMLInputElement} */ (el("input", "ui-field"));
    input.type = type; input.value = String(value);
    if (placeholder) input.placeholder = placeholder;
    if (label) input.setAttribute("aria-label", label);
    if (invalid) input.setAttribute("aria-invalid", "true");
    if (disabled) input.disabled = true;
    if (onInput) input.addEventListener("input", () => onInput(input.value, input));
    if (!unit) return input;
    const row = el("span", "ui-field-measure");
    row.append(input, el("span", "ui-field-unit", unit));
    return row;
  }
  /** Nullable engineering number. Blank stays null, explicit zero stays 0, and the callback runs from onchange. */
  function nullableNumber(value, onValue, {label, unit, min, placeholder} = {}) {
    const input = field({type: "number", value: value == null ? "" : value, placeholder, label});
    input.step = "any";
    if (min != null) input.min = min;
    if (unit) input.dataset.numericUnit = unit;
    input.onchange = () => onValue(input.value === "" ? null : +input.value);
    return input;
  }
  /** Analysis label and visible unit. prefix is "pdn" or "thm". A preset numericUnit is left in place. */
  function analysisField(label, input, unit, cls, prefix) {
    const row = el("label", prefix + "-field" + (cls ? " " + cls : ""));
    row.append(el("span", prefix + "-label", label), input);
    if (input.type === "number" && unit && input.dataset.numericUnit == null)
      input.dataset.numericUnit = ({"W/m²K":"W/m²/K","W/m·K":"W/m/K","°C rise":"Δ°C","k":"","M":""})[unit] ?? unit;
    if (unit) row.append(el("span", prefix + "-unit", unit));
    return row;
  }
  /** A dropdown: a native single-line <select>; AtriumSelectPopup opens its list. */
  function select(options, {value, label, onChange, disabled, native} = {}) {
    const s = /** @type {HTMLSelectElement} */ (el("select", native ? null : "ui-field"));
    for (const o of options) {
      const [v, text] = Array.isArray(o) ? o : [o, o];
      const opt = /** @type {HTMLOptionElement} */ (el("option", null, String(text))); opt.value = String(v); s.append(opt);
    }
    if (value != null) s.value = String(value);
    if (label) s.setAttribute("aria-label", label);
    if (disabled) s.disabled = true;
    if (onChange) s.addEventListener("change", () => onChange(s.value, s));
    return s;
  }
  /** label.ui-switch-row > input.ui-switch[role=switch]. The knob animates over --motion-toggle. */
  function switchRow(label, {checked, onChange, disabled} = {}) {
    const row = el("label", "ui-switch-row"), input = /** @type {HTMLInputElement} */ (el("input", "ui-switch"));
    input.type = "checkbox"; input.setAttribute("role", "switch"); input.checked = !!checked;
    if (disabled) input.disabled = true;
    if (onChange) input.addEventListener("change", () => onChange(input.checked, input));
    row.append(el("span", null, label), input);
    return row;
  }
  /** label.ui-checkbox-row > input.ui-checkbox + text. */
  function checkbox(label, {checked, indeterminate, onChange, disabled} = {}) {
    const row = el("label", "ui-checkbox-row"), input = /** @type {HTMLInputElement} */ (el("input", "ui-checkbox"));
    input.type = "checkbox"; input.checked = !!checked; input.indeterminate = !!indeterminate;
    if (disabled) input.disabled = true;
    if (onChange) input.addEventListener("change", () => onChange(input.checked, input));
    row.append(input, el("span", null, label));
    return row;
  }
  let groups = 0;
  /** A radio group: fieldset.ui-radio-group of label.ui-radio-row > input.ui-radio. */
  function radioGroup(options, {value, label, onChange, name = "ui-radio-" + ++groups} = {}) {
    const g = el("fieldset", "ui-radio-group");
    if (label) g.append(el("legend", "visually-hidden", label));
    for (const o of options) {
      const [v, text, disabled] = Array.isArray(o) ? o : [o, o];
      const row = el("label", "ui-radio-row"), input = /** @type {HTMLInputElement} */ (el("input", "ui-radio"));
      input.type = "radio"; input.name = name; input.value = String(v); input.checked = String(v) === String(value);
      if (disabled) input.disabled = true;
      if (onChange) input.addEventListener("change", () => input.checked && onChange(input.value, input));
      row.append(input, el("span", null, String(text))); g.append(row);
    }
    return g;
  }
  /** A segmented control of buttons with aria-pressed; arrows move through it (ui/dialog.js). */
  function segmented(options, {value, label, onChange, size} = {}) {
    const g = el("div", "ui-segmented");
    g.setAttribute("role", "group"); if (label) g.setAttribute("aria-label", label);
    const buttons = options.map(o => {
      const [v, text] = Array.isArray(o) ? o : [o, o];
      const b = /** @type {HTMLButtonElement} */ (el("button", "ui-segment", String(text)));
      b.type = "button"; b.value = String(v); b.setAttribute("aria-pressed", String(String(v) === String(value)));
      if (size) b.dataset.size = size;
      b.addEventListener("click", () => {
        for (const other of buttons) other.setAttribute("aria-pressed", String(other === b));
        onChange?.(b.value, b);
      });
      return b;
    });
    g.append(...buttons);
    return g;
  }
  /** Tabs: a .ui-tabs tablist of .ui-tab buttons with a roving tabindex. strip: the filled band with a hairline. */
  function tabs(items, {value, label, onChange, strip, boxed} = {}) {
    const list = el("div", "ui-tabs");
    if (strip) list.dataset.strip = "";
    if (boxed) list.dataset.boxed = "";
    list.setAttribute("role", "tablist"); if (label) list.setAttribute("aria-label", label);
    const buttons = items.map(o => {
      const [v, text] = Array.isArray(o) ? o : [o, o];
      const b = /** @type {HTMLButtonElement} */ (el("button", "ui-tab", String(text)));
      b.type = "button"; b.value = String(v); b.setAttribute("role", "tab");
      const on = String(v) === String(value);
      b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1;
      b.addEventListener("click", () => {
        for (const other of buttons) { other.setAttribute("aria-selected", String(other === b)); other.tabIndex = other === b ? 0 : -1; }
        onChange?.(b.value, b);
      });
      return b;
    });
    list.append(...buttons);
    return list;
  }
  /** A search field: magnifier, native search input, optional match count and a clear button.
   *  The node carries .input and .setCount(text); an empty text hides the count. */
  function search({placeholder = "Search", label, value = "", onInput, count: matches} = {}) {
    const input = /** @type {HTMLInputElement} */ (el("input", "ui-field"));
    input.placeholder = placeholder; input.value = value;
    return adoptSearch(input, {label: label || placeholder, onInput, count: matches});
  }
  /** Upgrade an existing input (static markup) to the library search field, in place: it is wrapped in
   *  .ui-search (or keeps its .ui-search parent) and gains the magnifier, the clear button and, with
   *  count, a match count. Idempotent. Escape clears the text first and only then reaches the surface. */
  function adoptSearch(input, {label, onInput, count: matches} = {}) {
    let wrap = /** @type {HTMLElement & {input?:HTMLInputElement, setCount?:(text:any)=>void}} */ (input.parentElement);
    if (wrap?.matches?.(".ui-search") && wrap.setCount) { if (matches != null) wrap.setCount(matches); return wrap; }
    if (!wrap?.matches?.(".ui-search")) { const w = el("div", "ui-search"); input.replaceWith(w); w.append(input); wrap = w; }
    input.classList.add("ui-field"); input.type = "search";
    if (label && !input.hasAttribute("aria-label") && !input.labels?.length) input.setAttribute("aria-label", label);
    if (!wrap.querySelector(":scope > .icon")) wrap.prepend(icon("search"));
    // Static markup may already hold the count; the clear button is always the kit's (it needs the handler).
    const out = wrap.querySelector(":scope > .ui-search-count") || el("span", "ui-search-count");
    out.setAttribute("aria-live", "polite");
    const clear = iconButton("close", "Clear search", {size: "sm", run: () => {
      input.value = ""; input.dispatchEvent(new Event("input", {bubbles: true})); input.focus();
    }});
    clear.classList.add("ui-search-clear");
    wrap.querySelector(":scope > .ui-search-clear")?.remove();
    wrap.append(out, clear);
    const setCount = text => {
      out.textContent = text == null ? "" : String(text);
      wrap.style.setProperty("--ui-search-count-w", out.textContent.length + "ch");
    };
    setCount(matches ?? (out.textContent || null));
    if (onInput) input.addEventListener("input", () => onInput(input.value, input));
    input.addEventListener("keydown", event => { if (event.key === "Escape" && input.value) { event.stopPropagation(); event.preventDefault(); clear.click(); } });
    return Object.assign(wrap, {input, setCount});
  }
  /** A section: heading row with its actions, hairline, then the content. */
  function section(title, {actions = [], note, quiet, level = 3} = {}, ...content) {
    const s = el("section", "ui-section"), head = el("div", "ui-section-head"), h = el("h" + level, "ui-section-title", title);
    if (quiet) head.dataset.quiet = "";
    head.append(h);
    if (actions.length) { const a = el("div", "ui-section-actions"); a.append(...actions); head.append(a); }
    s.append(head);
    if (note) s.append(el("p", "ui-section-note", note));
    s.append(...content);
    return s;
  }
  /** A property row: caption and value or control. A string value is read-only text. */
  function propRow(caption, value, {error, stacked} = {}) {
    const control = typeof value === "string" ? el("span", "ui-prop-value ui-selectable", value) : value;
    const row = el(control instanceof HTMLElement && control.matches("input,select,textarea") ? "label" : "div", "ui-prop-row");
    if (stacked) row.dataset.stacked = "";
    row.append(el("span", null, caption), control);
    if (error) { const e = el("span", "ui-prop-error", error); row.append(e); control.setAttribute?.("aria-invalid", "true"); }
    return row;
  }
  /** A list row. Pass selected for the selection fill, checked for a radio-like choice (role "radio",
   *  aria-checked), depth/expanded for a tree row. */
  function row({title, detail, icon: iconName, meta, actions = [], selected, checked, current, depth, expanded, state, role = "option", reveal = true, run} = {}) {
    const tree = depth != null || expanded != null;
    const r = el(run ? "button" : "div", "ui-row" + (tree ? " ui-tree-row" : ""));
    if (run) { /** @type {HTMLButtonElement} */ (r).type = "button"; r.addEventListener("click", run); }
    else if (role) r.setAttribute("role", tree ? "treeitem" : role);
    if (depth) r.style.setProperty("--ui-depth", String(depth));
    if (expanded != null) r.setAttribute("aria-expanded", String(!!expanded));
    if (selected != null) r.setAttribute(run ? "aria-pressed" : "aria-selected", String(!!selected));
    if (current) r.setAttribute("aria-current", "true");
    if (checked != null) { r.setAttribute("role", "radio"); r.setAttribute("aria-checked", String(!!checked)); }
    if (state) r.dataset.state = state;
    if (tree) r.append(el("span", "ui-disclosure"));
    if (iconName) { const i = typeof iconName === "string" ? icon(iconName) : iconName; i.classList.add("ui-row-icon"); r.append(i); }
    const text = el("span", "ui-row-text");
    text.append(el("span", "ui-row-title", title));
    if (detail) text.append(el("span", "ui-row-detail", detail));
    r.append(text);
    if (meta != null) r.append(typeof meta === "string" ? el("span", "ui-row-meta", meta) : meta);
    if (actions.length) { const a = el("span", "ui-row-actions"); if (reveal) a.dataset.reveal = ""; a.append(...actions); r.append(a); }
    return r;
  }
  /** A list container for rows (listbox or tree). */
  function list(rows, {label, role = "listbox"} = {}) {
    const l = el("div", "ui-list"); l.setAttribute("role", role); if (label) l.setAttribute("aria-label", label);
    l.append(...rows); return l;
  }
  /** Engineering result table. renderRow returns each data row. An empty list is one cell spanning
   *  every column. Null rows leave the body empty so the caller can fill it. */
  function analysisTable(cols, rows, renderRow, {wrapClass, tableClass, empty = "Nothing to report.", emptyClass} = {}) {
    const host = el("div", wrapClass), table = el("table", tableClass), head = el("thead"), hr = el("tr"), body = el("tbody");
    for (const label of cols) {
      const th = el("th", null, label);
      th.setAttribute("scope", "col");
      hr.append(th);
    }
    head.append(hr); table.append(head, body); host.append(table);
    if (rows != null && !rows.length) {
      const tr = el("tr"), td = el("td", emptyClass, empty);
      td.setAttribute("colspan", String(cols.length));
      tr.append(td); body.append(tr);
    } else if (rows != null) {
      for (const row of rows) body.append(renderRow(row));
    }
    return host;
  }
  /** A toolbar. Pass "|" for a separator and "->" for a flexible spacer. */
  function toolbar(items, {label, floating} = {}) {
    const t = el("div", "ui-toolbar"); t.setAttribute("role", "toolbar"); if (label) t.setAttribute("aria-label", label);
    if (floating) t.dataset.floating = floating === true ? "" : floating;
    for (const item of items) t.append(item === "|" ? el("span", "ui-toolbar-sep") : item === "->" ? el("span", "ui-toolbar-spacer") : item);
    return t;
  }
  /** An inline notice. tone: info, success, warning, danger or none. */
  function notice({tone: toneName, title, text, actions = [], live, floating} = {}) {
    const n = tone(el("div", "ui-notice"), toneName);
    if (floating) n.dataset.floating = ""; // a banner over the canvas: solid surface under the tint, --elev-2
    if (live) n.setAttribute("role", toneName === "danger" ? "alert" : "status");
    n.append(dot(toneName));
    const body = el("div", "ui-notice-text");
    if (title) body.append(el("span", "ui-notice-title", title), text ? doc.createTextNode(" ") : "");
    if (text) body.append(text);
    n.append(body);
    if (actions.length) { const a = el("div", "ui-notice-actions"); a.append(...actions); n.append(a); }
    return n;
  }
  /** An empty state: what is missing, why, and the action that fills it. */
  function empty({title, text, actions = [], centred} = {}) {
    const e = el("div", "ui-empty");
    if (centred) e.dataset.centred = "";
    if (title) e.append(el("p", "ui-empty-title", title));
    if (text) e.append(el("p", null, text));
    if (actions.length) { const a = el("div", "ui-empty-actions"); a.append(...actions); e.append(a); }
    return e;
  }
  /** A progress bar. value null = indeterminate. Returns the element with set(value, text). */
  function progress({value = null, max = 1, label, detail} = {}) {
    const wrap = el("div", "ui-progress-row"), name = el("span", "ui-progress-label", label || ""), out = el("span", "ui-progress-value");
    const bar = el("div", "ui-progress"); bar.setAttribute("role", "progressbar");
    if (label) bar.setAttribute("aria-label", label);
    const set = (v, text) => {
      if (v == null) { bar.dataset.indeterminate = ""; bar.removeAttribute("aria-valuenow"); }
      else {
        const f = Math.max(0, Math.min(1, v / max));
        delete bar.dataset.indeterminate; bar.style.setProperty("--ui-progress", String(f));
        bar.setAttribute("aria-valuemin", "0"); bar.setAttribute("aria-valuemax", String(max)); bar.setAttribute("aria-valuenow", String(v));
      }
      out.textContent = text ?? (v == null ? "" : Math.round(100 * Math.max(0, Math.min(1, v / max))) + " %");
    };
    set(value, detail);
    wrap.append(name, out, bar);
    return Object.assign(wrap, {set});
  }
  /** A spinner for a short wait with no measurable progress. */
  function spinner({label = "Working", size} = {}) {
    const s = el("span", "ui-spinner"); s.setAttribute("role", "status"); s.setAttribute("aria-label", label);
    if (size) s.dataset.size = size;
    return s;
  }
  /** One muted line of state. */
  function statusLine(text, {tone: toneName, busy} = {}) {
    const s = tone(el("div", "ui-status-line"), toneName);
    if (busy) s.append(spinner({size: "sm", label: text}));
    s.append(el("span", "ui-status-text", text));
    s.setAttribute("role", "status");
    return s;
  }
  /** A thumbnail tile. state: pending, failed or none; art: an <img>, <canvas> or nothing yet. */
  function thumb({label, art, current, state, run} = {}) {
    const t = el(run ? "button" : "div", "ui-thumb"), box = el("span", "ui-thumb-art");
    if (run) { /** @type {HTMLButtonElement} */ (t).type = "button"; t.addEventListener("click", run); }
    if (current) t.setAttribute("aria-current", "true");
    if (state) t.dataset.state = state;
    if (art) box.append(art);
    t.append(box, el("span", "ui-thumb-label", label));
    return t;
  }
  /** A pager: previous, "3 of 12", next. One way to step pages, slides, views, matches and history.
   *  onStep(delta) runs for the buttons and for ←/→, PageUp/PageDown inside the group; Home/End pass
   *  -Infinity/Infinity. Returns the group with set(index, count, text) (index is 0-based). */
  function pager({index = 0, count = 0, unit = "page", label, onStep, size = "sm"} = {}) {
    const p = el("div", "ui-pager"); p.setAttribute("role", "group"); p.setAttribute("aria-label", label || "Step " + unit + "s");
    const prev = iconButton("chevron", "Previous " + unit, {size, run: () => onStep?.(-1)});
    const next = iconButton("chevron", "Next " + unit, {size, run: () => onStep?.(1)});
    const out = el("output", "ui-pager-position"); out.setAttribute("aria-live", "polite");
    p.append(prev, out, next);
    const set = (i, n, text) => {
      out.textContent = text ?? (n ? (i + 1) + " of " + n : "–");
      prev.disabled = !n || i <= 0; next.disabled = !n || i >= n - 1;
      if (n && i >= n - 1) p.dataset.state = "end"; else delete p.dataset.state;
    };
    p.addEventListener("keydown", event => {
      const d = {ArrowLeft: -1, ArrowRight: 1, PageUp: -1, PageDown: 1, Home: -Infinity, End: Infinity}[event.key];
      if (!d || event.altKey || event.metaKey || event.ctrlKey) return;
      event.preventDefault(); onStep?.(globalThis.getComputedStyle?.(p).direction === "rtl" && Math.abs(d) === 1 && event.key.startsWith("Arrow") ? -d : d);
    });
    set(index, count);
    return Object.assign(p, {set, prev, next, position: out});
  }
  /** Ordered steps. Each: {title, state: pending|running|done|skipped|failed, result}. */
  function steps(items) {
    const ol = el("ol", "ui-steps");
    for (const s of items) {
      const li = el("li", "ui-step"); if (s.state) li.dataset.state = s.state;
      li.append(el("span", "ui-row-title", s.title), el("span", "ui-step-result", s.result || ""));
      ol.append(li);
    }
    return ol;
  }
  /** A before → after value pair. */
  function diff(before, after) {
    const d = el("span", "ui-diff");
    const b = el("del", "ui-diff-before", before), a = el("ins", "ui-diff-after", after), arrow = el("span", "ui-diff-arrow", "→");
    arrow.setAttribute("aria-hidden", "true");
    d.append(b, arrow, a);
    return d;
  }
  /** A splitter between two panes. onResize(deltaPx) runs during the drag and for arrow keys. */
  function splitter({orientation = "vertical", label = "Resize", onResize} = {}) {
    const s = el("div", "ui-splitter"); s.setAttribute("role", "separator"); s.setAttribute("aria-orientation", orientation);
    s.setAttribute("aria-label", label); s.tabIndex = 0;
    const along = orientation === "vertical" ? "clientX" : "clientY";
    s.addEventListener("pointerdown", event => {
      if (event.button) return;
      event.preventDefault(); s.setPointerCapture(event.pointerId); s.classList.add("is-dragging");
      let last = event[along];
      const move = e => { const d = e[along] - last; last = e[along]; if (d) onResize?.(d); };
      const up = () => { s.classList.remove("is-dragging"); s.removeEventListener("pointermove", move); s.removeEventListener("pointerup", up); s.removeEventListener("pointercancel", up); };
      s.addEventListener("pointermove", move); s.addEventListener("pointerup", up); s.addEventListener("pointercancel", up);
    });
    s.addEventListener("keydown", event => {
      const keys = orientation === "vertical" ? {ArrowLeft: -1, ArrowRight: 1} : {ArrowUp: -1, ArrowDown: 1};
      const k = keys[/** @type {"ArrowLeft"} */ (event.key)];
      if (k) { event.preventDefault(); onResize?.(k * (event.shiftKey ? 64 : 16)); }
    });
    return s;
  }
  /** A drag handle (six dots, arrow cursor). */
  const dragHandle = (label = "Drag to reorder") => { const h = el("span", "ui-drag-handle"); h.setAttribute("aria-hidden", "true"); h.title = label; return h; };
  /** Mark a node as a drop target. state: ready, over, denied, busy, or null to clear. */
  function dropState(node, state) {
    node.classList.add("ui-drop-target");
    if (state) node.dataset.drop = state; else delete node.dataset.drop;
    return node;
  }
  /** A transcript turn. role: user, assistant or tool. body: text or nodes. */
  function turn(role, body, {label} = {}) {
    const t = el("article", "ui-turn"); t.dataset.role = role;
    t.append(el("span", "ui-turn-role", label || (role === "user" ? "You" : role === "tool" ? "Tool" : "Assistant")));
    const b = el("div", "ui-turn-body ui-selectable"); b.append(...[].concat(body)); t.append(b);
    return t;
  }
  /** A numbered citation marker inside an answer. */
  function cite(n, {run, label} = {}) {
    const c = /** @type {HTMLButtonElement} */ (el("button", "ui-cite", String(n))); c.type = "button";
    c.setAttribute("aria-label", label || "Source " + n); if (run) c.addEventListener("click", run);
    return c;
  }
  /** The recording indicator: a danger dot with a halo and a short state. */
  function recording(text = "Recording") {
    const r = el("span", "ui-recording"); r.setAttribute("role", "status");
    r.append(dot("danger", {pulse: true}), el("span", null, text));
    return r;
  }
  /** A panel: heading (title + actions), scrolling body and optional footer. */
  function panel({title, actions = [], body = [], foot} = {}) {
    const p = el("section", "ui-panel"), head = el("header", "ui-panel-head"), b = el("div", "ui-panel-body");
    head.append(el("h2", "ui-panel-title", title || ""), ...actions);
    b.append(...[].concat(body)); p.append(head, b);
    if (foot) { const f = el("footer", "ui-panel-foot"); f.append(...[].concat(foot)); p.append(f); }
    return Object.assign(p, {body: b});
  }

  // Static markup (.ui-search > input) gains the clear button, the count and Escape when first focused.
  // lazy.js prefetches the kit at idle, so a field focused later is already adopted when typing starts.
  const adoptFocused = (/** @type {any} */ t) => { if (t?.matches?.(".ui-search > input")) adoptSearch(t); };
  doc?.addEventListener?.("focusin", event => adoptFocused(event.target), true);
  adoptFocused(doc?.activeElement); // focused before the kit arrived

  return {el, icon, button, iconButton, closeButton, chip, chips, badge, count, dot, field, nullableNumber, analysisField, select, switchRow, checkbox, radioGroup,
    segmented, tabs, search, adoptSearch, section, propRow, row, list, analysisTable, toolbar, notice, empty, progress, spinner, statusLine, thumb, pager, steps, diff,
    avatar, overlayLabel,
    splitter, dragHandle, dropState, turn, cite, recording, panel};
})();
