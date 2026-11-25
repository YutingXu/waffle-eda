"use strict";
// Board shape user interface: the Design › Board Shape dialog (define, dimensions, wizard, DXF
// import and export tabs) and the board inspector section. The geometry is AtriumBoardShape,
// whose open() and properties() load this file and its editing dependencies on first use through
// lazy.js when a board-shape control is opened.
globalThis.AtriumBoardShapeUI = (() => {
  const Shape = globalThis.AtriumBoardShape;
  const {CHAIN_TOL, apply, area, pointAt:at, bounds, contourBounds, current, fromUser, head, holes, line, originPoint, setOrigin, svgPath, toUser} = Shape;
  const editing = () => globalThis.AtriumBoardShapeEditing;
  const SVGNS = "http://www.w3.org/2000/svg";
  function el(tag, text, cls, attrs) {
    const n = document.createElement(tag);
    if (text != null) n.textContent = text;
    if (cls) n.className = cls;
    for (const [k, v] of Object.entries(attrs || {})) if (v != null && v !== false) n.setAttribute(k, v === true ? "" : v);
    return n;
  }
  function sv(tag, attrs) { const n = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v); return n; }
  function button(text, act, cls, title) {
    const b = el("button", text, cls, {type: "button", title}); b.onclick = act;
    return !b.classList.contains("ui-tab") ? (globalThis.AtriumUI?.button(b) ?? b) : b;
  }
  function unitsOf(ctx) {
    const U = globalThis.Atrium?.units, unit = U ? U.normal(ctx.project?.units) : "mm";
    return {unit, show: mm => U ? String(U.value(mm, unit)) : String(+(+mm).toFixed(4)), parse: t => U ? U.parse(t, unit) : parseFloat(t),
      fmt: mm => U ? U.format(mm, unit) : +(+mm).toFixed(4) + "mm",
      area: mm2 => unit === "mil" ? +(mm2 / 645.16).toFixed(4) + " in²" : +mm2.toFixed(3) + " mm²"};
  }
  function lengthField(u, value, label, onValue, opt = {}) {
    const wrap = el("label", null, "bsh-field" + (opt.cls ? " " + opt.cls : "")), box = el("span", null, "ui-field-measure");
    const input = el("input", null, "bsh-num ui-field ui-field-number", {type: "text", inputmode: "decimal", spellcheck: "false", "aria-label": (opt.aria || label) + " (" + u.unit + ")"});
    input.value = value == null || !Number.isFinite(value) ? "" : u.show(value);
    globalThis.AtriumLazy?.numericField?.(input,{unit:u.unit,storageUnit:"mm",nanometres:true,min:opt.positive?1e-6:opt.min,max:1e6});
    if (opt.disabled) input.disabled = true;
    box.append(input, el("small", u.unit, "ui-field-unit"));
    wrap.append(el("span", label), box);
    input.onchange = () => {
      const v = u.parse(input.value);
      if (!Number.isFinite(v) || opt.positive && !(v > 0) || opt.min != null && v < opt.min || Math.abs(v) > 1e6) {
        input.setAttribute("aria-invalid", "true"); opt.error?.(label + ": enter " + (opt.positive ? "a positive length" : "a length") + ", e.g. 25 or 1000mil."); return;
      }
      input.removeAttribute("aria-invalid"); onValue(v);
    };
    return {wrap, input};
  }
  function choice(label, options, value, onChange, cls) {
    const wrap = el("label", null, "bsh-field" + (cls ? " " + cls : "")), s = el("select", null, "bsh-select ui-field", {"aria-label": label});
    for (const o of options) {
      if (o.group) { const g = el("optgroup", null, null, {label: o.group}); for (const p of o.options) g.append(Object.assign(el("option", p[1]), {value: p[0]})); s.append(g); }
      else s.append(Object.assign(el("option", o[1]), {value: o[0]}));
    }
    s.value = value; s.onchange = () => onChange(s.value);
    wrap.append(el("span", label), s);
    return {wrap, select: s};
  }
  function check(label, value, onChange) {
    const wrap = el("label", null, "bsh-check"), c = el("input", null, "ui-checkbox", {type: "checkbox"});
    c.checked = !!value; c.onchange = () => onChange(c.checked);
    wrap.append(c, el("span", label));
    return {wrap, input: c};
  }
  // Preview: board (even-odd fill), extra paths, holes and gap markers.
  function preview(host, o = {}) {
    host.replaceChildren();
    let b = o.bounds || (o.shape ? bounds(o.shape) : null);
    if (o.holes?.length && b) for (const h of o.holes) b = [Math.min(b[0], h.x - h.d), Math.min(b[1], h.y - h.d), Math.max(b[2], h.x + h.d), Math.max(b[3], h.y + h.d)];
    if (!b) { host.append(el("p", o.empty || "Nothing to preview.", "ui-empty bsh-empty")); return; }
    const w = Math.max(b[2] - b[0], 1e-6), h = Math.max(b[3] - b[1], 1e-6), m = Math.max(w, h) * .06;
    const svg = sv("svg", {viewBox: [b[0] - m, b[1] - m, w + 2 * m, h + 2 * m].map(v => +v.toFixed(4)).join(" "), class: "bsh-svg", role: "img", "aria-label": o.label || "Board shape preview", preserveAspectRatio: "xMidYMid meet"});
    const f = v => +v.toFixed(Math.max(0, Math.min(6, 4 - Math.floor(Math.log10(Math.max(w, h))))));
    if (o.shape) svg.append(sv("path", {class: "bsh-board", d: [o.shape.contour, ...(o.shape.cutouts || [])].map(c => svgPath(c, f) + "Z").join(""), "fill-rule": "evenodd", "vector-effect": "non-scaling-stroke"}));
    for (const p of o.paths || []) svg.append(sv("path", {class: "bsh-line", d: p.d, "vector-effect": "non-scaling-stroke"}));
    for (const hl of o.holes || []) svg.append(sv("circle", {class: "bsh-hole", cx: f(hl.x), cy: f(hl.y), r: f(hl.d / 2), "vector-effect": "non-scaling-stroke"}));
    for (const g of o.gaps || []) {
      if (g.to) svg.append(sv("line", {class: "bsh-gap-line", x1: f(g.from[0]), y1: f(g.from[1]), x2: f(g.to[0]), y2: f(g.to[1]), "vector-effect": "non-scaling-stroke"}));
      svg.append(sv("circle", {class: "bsh-gap", cx: f(g.at[0]), cy: f(g.at[1]), r: f(Math.max(w, h) * .018), "vector-effect": "non-scaling-stroke"}));
    }
    host.append(svg);
    if (o.caption) host.append(el("p", o.caption, "bsh-caption"));
  }
  function summaryText(shape, u) {
    const s = Shape.describe(shape);
    if (!s) return "No board outline";
    return u.fmt(s.width) + " × " + u.fmt(s.height) + " · " + u.area(s.area) + (s.cutouts ? " · " + s.cutouts + " cutout" + (s.cutouts === 1 ? "" : "s") : "") + (s.arcs ? " · " + s.arcs + " arc" + (s.arcs === 1 ? "" : "s") : "");
  }

  // Width, height, lower-left position, corners and origin. Applies on change.
  // Used by the inspector (compact) and by the dialog's Dimensions tab.
  function properties(host, ctx, opt = {}) {
    const doc = ctx.doc, u = unitsOf(ctx), say = opt.say || (m => ctx.info?.(m));
    host.replaceChildren();
    const shape = current(doc, {fitArcs: true});
    if (!shape) { host.append(el("p", "The board has no outline yet. Use the Board Wizard or define it from selected objects.", "bsh-note")); return; }
    const b = bounds(shape), params = editing().analyze(shape), ll = toUser(doc, [b[0], b[3]]);
    const commit = o => {
      try { const next = editing().resize(shape, o); ctx.edit(() => apply(doc, next, shape.source)); opt.after?.(); }
      catch (e) { say(e.message); }
    };
    const grid = el("div", null, "bsh-grid");
    grid.append(
      lengthField(u, b[2] - b[0], "Width", v => commit({width: v}), {positive: true, error: say}).wrap,
      lengthField(u, b[3] - b[1], "Height", v => commit({height: v}), {positive: true, error: say}).wrap,
      lengthField(u, ll[0], "X", v => { const p = fromUser(doc, [v, ll[1]]); commit({x: p[0], y: p[1]}); }, {aria: "Lower-left X", error: say}).wrap,
      lengthField(u, ll[1], "Y", v => { const p = fromUser(doc, [ll[0], v]); commit({x: p[0], y: p[1]}); }, {aria: "Lower-left Y", error: say}).wrap);
    host.append(grid);
    if (!opt.compact) host.append(el("p", "X and Y place the lower-left corner" + (doc.origin ? ", relative to the board origin with Y up." : "."), "bsh-note"));
    // Corners laid out as on the board.
    const corners = el("div", null, "bsh-corners" + (params ? "" : " is-disabled"), {role: "group", "aria-label": "Corners"});
    const names = {tl: "Top left", tr: "Top right", bl: "Bottom left", br: "Bottom right"}, short = {tl: "TL", tr: "TR", bl: "BL", br: "BR"};
    const cur = params?.corners || {tl: {style: "sharp", size: 0}, tr: {style: "sharp", size: 0}, bl: {style: "sharp", size: 0}, br: {style: "sharp", size: 0}};
    const setCorner = (keys, style, size) => {
      const next = {...cur};
      for (const k of keys) next[k] = {style, size: style === "sharp" ? 0 : size};
      if (style !== "sharp" && !(size > 0)) { say("Enter a corner size."); return; }
      commit({corners: next});
    };
    for (const k of ["tl", "tr", "bl", "br"]) {
      const c = cur[k], box = el("div", null, "bsh-corner bsh-corner-" + k);
      const sel = choice(opt.compact ? short[k] : names[k], [["sharp", "Sharp"], ["radius", "Radius"], ["chamfer", "Chamfer"]], c.style, v => setCorner([k], v, v === "sharp" ? 0 : (c.size || Math.min(3, (b[2] - b[0]) / 4, (b[3] - b[1]) / 4))));
      const size = lengthField(u, c.size || null, "Size", v => setCorner([k], c.style === "sharp" ? "radius" : c.style, v), {positive: true, error: say, aria: names[k] + " size", disabled: !params || c.style === "sharp"});
      sel.select.disabled = !params; sel.select.setAttribute("aria-label", names[k] + " corner"); sel.wrap.title = names[k];
      box.append(sel.wrap, size.wrap);
      corners.append(box);
    }
    host.append(el("h4", "Corners", "bsh-sub"), corners);
    if (params && !opt.compact) {
      const all = el("div", null, "bsh-row");
      let style = "radius", size = cur.tl.size || 3;
      all.append(choice("All corners", [["radius", "Radius"], ["chamfer", "Chamfer"], ["sharp", "Sharp"]], style, v => { style = v; }).wrap,
        lengthField(u, size, "Size", v => { size = v; }, {positive: true, error: say, aria: "All corners size"}).wrap,
        button("Apply to all", () => setCorner(["tl", "tr", "bl", "br"], style, size)));
      host.append(all);
    }
    if (!params) host.append(el("p", "Corner styles apply to rectangular boards. Width and height scale this shape about its lower-left corner.", "bsh-note"));
    if (shape.cutouts?.length) host.append(el("p", shape.cutouts.length + " cutout" + (shape.cutouts.length === 1 ? " keeps its" : "s keep their") + " position when the size changes and move with the board.", "bsh-note"));
    // Board origin.
    const o = el("div", null, "bsh-origin");
    o.append(el("h4", "Board origin", "bsh-sub"), el("p", doc.origin ? "At " + u.fmt(doc.origin[0]) + ", " + u.fmt(doc.origin[1]) + " (design coordinates)" : "Design origin (0, 0)", "bsh-note"));
    const setO = p => { try { ctx.edit(() => setOrigin(doc, p)); opt.after?.(); say(p ? "Board origin set." : "Board origin cleared."); } catch (e) { say(e.message); } };
    const row = el("div", null, "bsh-row");
    row.append(button("Lower-left", () => setO(originPoint(doc, "lower-left")), null, "Set the origin at the board's lower-left corner"),
      button("Centre", () => setO(originPoint(doc, "centre")), null, "Set the origin at the centre of the board extents"));
    if (ctx.pickPoint) row.append(button("Pick point…", async () => { opt.beforePick?.(); const p = await ctx.pickPoint("Click the new board origin"); if (p) setO(originPoint(doc, "point", p)); }));
    if (doc.origin) row.append(button("Clear", () => setO(null)));
    o.append(row);
    if (!opt.compact) {
      const at = el("div", null, "bsh-row");
      let px = 0, py = 0;
      at.append(lengthField(u, 0, "X", v => { px = v; }, {aria: "Origin X in design coordinates", error: say}).wrap, lengthField(u, 0, "Y", v => { py = v; }, {aria: "Origin Y in design coordinates", error: say}).wrap,
        button("Set at X, Y", () => setO([px, py])));
      o.append(at);
    }
    host.append(o);
    if (!opt.compact) host.append(el("p", summaryText(shape, u), "bsh-summary-line"));
  }

  const LAYER_CHOICES = Array.from({length: 16}, (_, i) => "Mechanical " + (i + 1));
  function open(ctx, opts = {}) {
    const first = ctx.doc;
    if (first?.kind !== "pcb") { ctx.info?.("Open a board layout to edit its shape."); return null; }
    // Undo replaces the editor's project, so look the document up on each use.
    const live = () => ctx.currentProject?.()?.documents?.find(x => x.id === first.id) || first;
    const u = unitsOf(ctx), DXF = globalThis.AtriumDXF;
    for (const old of document.querySelectorAll("dialog.bsh-dialog")) { old.close(); old.remove(); }
    const d = el("dialog", null, "ui-dialog work-dialog bsh-dialog", {"aria-label": "Board Shape"});
    const head = el("div", null, "bsh-head"), status = el("span", null, "bsh-doc");
    head.append(el("h2", "Board Shape", "ui-dialog-title"), status);
    const tabs = el("div", null, "bsh-tabs ui-tabs", {"data-strip": "", role: "tablist", "aria-label": "Board shape tools"});
    const message = el("div", null, "bsh-message", {role: "status", "aria-live": "polite"});
    const actions = el("div", null, "work-actions ui-dialog-actions"), primary = button("Apply", () => run(), "bsh-primary");
    primary.dataset.variant = "primary";
    actions.append(button("Close", () => d.close()), primary);
    const say = (text, kind) => { message.replaceChildren(); message.dataset.kind = kind || ""; if (text) message.append(el("span", text)); };
    const refreshHead = () => { status.textContent = (live().name || "Board") + " · " + summaryText(current(live()), u); };
    const T = {}, buttons = {}, panels = {};
    let tab = null, pendingTab = 0;
    const def = (id, label, action, build) => { T[id] = {label, action, build, built: false}; };
    function select(id) {
      const request = ++pendingTab;
      if ((id === "define" || id === "import") && !globalThis.AtriumBoardShapeSources) {
        const pending = globalThis.AtriumLazy?.need("AtriumBoardShapeSources");
        if (!pending) { say("The board outline tools are unavailable.", "error"); return; }
        primary.disabled = true;
        say("Loading board outline tools…");
        pending.then(() => { if (d.open && request === pendingTab) select(id); }, error => {
          if (d.open && request === pendingTab) { say(error.message, "error"); if (tab) syncPrimary(); }
        });
        return;
      }
      tab = id;
      for (const k of Object.keys(T)) { buttons[k].setAttribute("aria-selected", String(k === id)); buttons[k].tabIndex = k === id ? 0 : -1; panels[k].hidden = k !== id; }
      if (!T[id].built) { T[id].api = T[id].build(panels[id]) || {}; T[id].built = true; } else T[id].api.show?.();
      primary.textContent = T[id].action; primary.hidden = !T[id].action; syncPrimary(); say("");
      // Define from Selection docks beside the canvas so objects stay selectable while it is open.
      d.classList.toggle("bsh-docked", id === "define");
      d.classList.toggle("ui-sheet", id === "define");
    }
    const syncPrimary = () => { primary.disabled = !!T[tab]?.api?.disabled?.(); };
    async function run() { try { const ui=globalThis.AtriumNumericFields;if(ui?.pending(panels[tab]) && !await ui.flush(panels[tab]))return;await T[tab].api.run?.(); } catch (e) { say(e.message, "error"); } syncPrimary(); refreshHead(); }
    const split = panel => { const s = el("div", null, "bsh-split"), form = el("div", null, "bsh-form"), view = el("div", null, "bsh-preview"); s.append(form, view); panel.append(s); return {form, view}; };
    const done = text => { refreshHead(); ctx.refresh?.(); ctx.fit?.(); say(text); };

    // -- Define from selection -------------------------------------------------
    def("define", "Define from Selection", "Define Board Shape", panel => {
      const {form, view} = split(panel);
      const st = {source: "primitives", from: "auto", tol: CHAIN_TOL, fit: true, closeGaps: 0, result: null};
      const intro = el("p", "Select lines and arcs on any layer (or a closed region) that form the board edge, then define the shape. The largest closed loop becomes the board; loops inside it become cutouts.", "bsh-note");
      const opts1 = el("div", null, "bsh-grid");
      const fromSel = choice("Use", [["auto", "Courtyard, else body"], ["courtyard", "Courtyard"], ["body", "Body / assembly"]], st.from, v => { st.from = v; analyse(); });
      const src = choice("Source", [["primitives", "Selected primitives"], ["component", "Selected component"]], st.source, v => { st.source = v; fromSel.wrap.hidden = v !== "component"; analyse(); });
      fromSel.wrap.hidden = true;
      opts1.append(src.wrap, fromSel.wrap, lengthField(u, st.tol, "Endpoint tolerance", v => { st.tol = v; analyse(); }, {positive: true, error: say}).wrap);
      const arcs = check("Recognise tessellated arcs", st.fit, v => { st.fit = v; analyse(); });
      const result = el("div", null, "bsh-result");
      form.append(intro, opts1, arcs.wrap, result);
      function analyse() {
        const ids = ctx.selection?.() || [];
        st.result = null; result.replaceChildren();
        try {
          if (st.source === "component") {
            const part = live().items.find(i => i.kind === "part" && ids.includes(i.id));
            if (!part) throw Error("Select a component on the board.");
            st.result = AtriumBoardShapeSources.fromComponent(live(), ctx.defs, part.id, {from: st.from, tolerance: st.tol});
          } else {
            if (!ids.length) throw Error("Nothing is selected yet. Select the lines and arcs of the board edge on the canvas; this panel updates as you select.");
            st.result = AtriumBoardShapeSources.fromItems(live(), ids, {tolerance: st.tol, fitArcs: st.fit, closeGaps: st.closeGaps});
          }
        } catch (e) { result.append(el("p", e.message, "bsh-warn")); preview(view, {empty: "Select objects to preview the board shape."}); syncPrimary(); return; }
        const r = st.result, dl = el("dl", null, "bsh-facts");
        const fact = (k, v) => dl.append(el("dt", k), el("dd", v));
        if (r.segments != null) fact("Primitives", String(r.segments));
        if (r.from) fact("Outline from", r.from === "extents" ? "footprint extents" : r.from);
        fact("Closed loops", String(r.loops));
        if (r.shape) { const s = Shape.describe(r.shape); fact("Size", u.fmt(s.width) + " × " + u.fmt(s.height)); fact("Area", u.area(s.area)); fact("Perimeter", u.fmt(s.perimeter)); fact("Cutouts", String(s.cutouts)); fact("Arcs", String(s.arcs)); }
        result.append(dl);
        for (const w of r.warnings || []) result.append(el("p", w, "bsh-warn"));
        const gaps = (r.gaps || []).filter(g => Number.isFinite(g.distance));
        const loose = (r.gaps || []).filter(g => !Number.isFinite(g.distance));
        if (gaps.length || loose.length) {
          result.append(el("h4", (r.shape ? "Open ends outside the board" : "The outline does not close") + " · " + (gaps.length + loose.length) + " gap" + (gaps.length + loose.length === 1 ? "" : "s"), "bsh-sub"));
          const list = el("ul", null, "bsh-gaps");
          for (const [n, g] of [...gaps, ...loose].slice(0, 12).entries()) {
            const at = toUser(live(), g.at), li = el("li");
            li.append(el("span", (Number.isFinite(g.distance) ? u.fmt(g.distance) + " gap" : "Dangling end") + " at " + u.show(at[0]) + ", " + u.show(at[1])),
              button("Show", () => locateGap(n), null, "Close this dialog and show the gap on the board"));
            list.append(li);
          }
          result.append(list);
          if (gaps.length) {
            const row = el("div", null, "bsh-row"), max = Math.max(...gaps.map(g => g.distance));
            let limit = Math.ceil(max * 1000) / 1000;
            row.append(lengthField(u, limit, "Close gaps up to", v => { limit = v; }, {positive: true, error: say}).wrap,
              button("Close gaps", () => { st.closeGaps = limit; analyse(); say(st.result?.bridged ? "Closed " + st.result.bridged + " gap" + (st.result.bridged === 1 ? "" : "s") + " with straight edges." : "No gaps within that distance."); }, null, "Bridge open ends with straight edges in the board shape"));
            result.append(row);
          }
          function locateGap(n) {
            const all = [...gaps, ...loose];
            publishGaps(all);
            const g = all[n];
            d.close();
            ctx.locate?.(g.ids[0] ?? null, g.at);
          }
        }
        if (st.closeGaps && r.bridged) result.append(el("p", "Gaps up to " + u.fmt(st.closeGaps) + " are bridged.", "bsh-note"));
        const open = [...(r.openSegments || []), ...(r.loopSegments || [])].map(segs => ({d: svgPath(segs)}));
        preview(view, {shape: r.shape, paths: open, gaps: r.gaps.filter(g => g.to || !r.shape), bounds: r.shape ? null : openBounds(r), empty: "No closed loop yet.",
          caption: r.shape ? "Board in grey, cutouts open. Red marks open ends." : "Red marks where the outline is open."});
        syncPrimary();
      }
      function publishGaps(list) {
        globalThis.AtriumMessages?.show?.(ctx, {title: "Board Shape", group: "Board Shape", messages: list.map(g => ({class: "Warning", source: "Board Shape", document: live().name, documentId: live().id,
          objectId: g.ids[0], point: g.at, text: (Number.isFinite(g.distance) ? "Outline gap of " + u.fmt(g.distance) : "Open outline end") + " at " + u.show(toUser(live(), g.at)[0]) + ", " + u.show(toUser(live(), g.at)[1])}))});
      }
      analyse();
      return {
        show: analyse,
        disabled: () => !st.result?.shape,
        run() {
          const r = st.result;
          if (!r?.shape) throw Error("No closed outline to define.");
          ctx.edit(() => apply(live(), r.shape, st.source === "component" ? "component" : "primitives"));
          done("Board shape defined: " + summaryText(current(live()), u) + ".");
        }
      };
    });

    // -- Dimensions and corners -------------------------------------------------
    def("dims", "Dimensions & Corners", null, panel => {
      const {form, view} = split(panel);
      const paint = () => {
        properties(form, {...ctx, doc: live()}, {say: m => say(m, /enter|must|apply|only/i.test(m) ? "error" : ""), after: () => { refreshHead(); paint(); }, beforePick: () => d.close()});
        preview(view, {shape: current(live()), empty: "The board has no outline.", caption: live().origin ? "Origin marked in the editor at the board origin." : ""});
      };
      paint();
      return {show: paint};
    });

    // -- Wizard ---------------------------------------------------------------------
    def("wizard", "Board Wizard", "Create Board", panel => {
      const {form, view} = split(panel), b0 = current(live()) ? bounds(current(live())) : null;
      const ll = toUser(live(), b0 ? [b0[0], b0[3]] : [0, 0]);
      const st = {type: "rounded", preset: "100x100", width: 100, height: 80, radius: 3, diameter: 50, x: ll[0], y: ll[1], holes: false, holeDiameter: 3.2, holeInset: 4, holeCount: 4, pad: 0};
      const fields = el("div", null, "bsh-grid"), extra = el("div"), note = el("p", null, "bsh-note");
      const types = [["rect", "Rectangle"], ["rounded", "Rounded rectangle"], ["circle", "Circle"], {group: "Standard form factors", options: editing().PRESETS.map(p => ["preset:" + p.id, p.name])}];
      const type = choice("Shape", types, st.type, v => { if (v.startsWith("preset:")) { st.type = "preset"; st.preset = v.slice(7); st.holes = true; } else st.type = v; paint(); });
      form.append(type.wrap, fields, extra, note);
      const params = () => { const p = fromUser(live(), [st.x, st.y]); return {...st, x: p[0], y: p[1], holeDiameter: st.type === "preset" && st.holeDiameterSet == null ? undefined : st.holeDiameter}; };
      function paint() {
        fields.replaceChildren(); extra.replaceChildren();
        const f = (label, key, o = {}) => fields.append(lengthField(u, st[key], label, v => { st[key] = v; if (key === "holeDiameter") st.holeDiameterSet = true; draw(); }, {error: say, ...o}).wrap);
        if (st.type === "rect" || st.type === "rounded") { f("Width", "width", {positive: true}); f("Height", "height", {positive: true}); }
        if (st.type === "rounded") f("Corner radius", "radius", {positive: true});
        if (st.type === "circle") f("Diameter", "diameter", {positive: true});
        f("Lower-left X", "x"); f("Lower-left Y", "y");
        const holes = check(st.type === "preset" ? "Add the form factor's mounting holes" : "Add mounting holes", st.holes, v => { st.holes = v; paint(); });
        extra.append(holes.wrap);
        if (st.holes) {
          const g = el("div", null, "bsh-grid");
          const p = st.type === "preset" ? editing().PRESETS.find(q => q.id === st.preset) : null;
          if (st.type === "preset" && !st.holeDiameterSet && p?.holes) st.holeDiameter = p.holes.d;
          g.append(lengthField(u, st.holeDiameter, "Hole diameter", v => { st.holeDiameter = v; st.holeDiameterSet = true; draw(); }, {positive: true, error: say}).wrap);
          if (st.type !== "preset") g.append(lengthField(u, st.holeInset, st.type === "circle" ? "Inset from edge" : "Inset from corners", v => { st.holeInset = v; draw(); }, {positive: true, error: say}).wrap);
          if (st.type === "circle") { const c = choice("Holes", [["2", "2"], ["3", "3"], ["4", "4"], ["6", "6"], ["8", "8"]], String(st.holeCount), v => { st.holeCount = +v; draw(); }); g.append(c.wrap); }
          g.append(lengthField(u, st.pad || null, "Pad diameter", v => { st.pad = v; draw(); }, {min: 0, error: say, aria: "Pad diameter, empty or 0 for non-plated"}).wrap);
          extra.append(g, el("p", "Leave the pad diameter empty for non-plated holes; a larger pad makes plated mounting holes.", "bsh-note"));
          if (p && !p.holes) extra.append(el("p", "This form factor has no standard mounting holes.", "bsh-note"));
        }
        draw();
      }
      let last = null;
      function draw() {
        try {
          last = editing().wizard(params());
          note.textContent = last.note || "";
          preview(view, {shape: last.shape, holes: last.holes, caption: summaryText(last.shape, u) + (last.holes.length ? " · " + last.holes.length + " hole" + (last.holes.length === 1 ? "" : "s") : "")});
        } catch (e) { last = null; preview(view, {empty: e.message}); }
        syncPrimary();
      }
      paint();
      return {
        disabled: () => !last,
        run() {
          if (!last) throw Error("Check the board parameters.");
          const holes = editing().holeItems(last.holes, {pad: st.pad});
          ctx.edit(() => { apply(live(), last.shape, "wizard"); live().items.push(...holes); });
          done("Board created: " + summaryText(current(live()), u) + (holes.length ? " with " + holes.length + " mounting hole" + (holes.length === 1 ? "" : "s") : "") + ".");
        }
      };
    });

    // -- Import DXF -------------------------------------------------------------------
    def("import", "Import DXF", "Import", panel => {
      const {form, view} = split(panel);
      const st = {name: "", result: null, units: "auto", layers: new Set(), as: "shape", target: "Mechanical 1", x: 0, y: 0, toOrigin: true, tol: CHAIN_TOL, width: .1};
      const pick = el("div", null, "bsh-row"), info = el("p", "Choose an ASCII DXF exported from your MCAD tool (R12 to R2018).", "bsh-note");
      pick.append(button("Choose DXF file…", async () => {
        if (!ctx.pickFile) { say("File picking is unavailable in this build.", "error"); return; }
        const f = await ctx.pickFile([".dxf"]);
        if (!f) return;
        say("Reading " + f.name + "…");
        // Browser File, or a host object with text/bytes/content.
        const data = typeof f.arrayBuffer === "function" ? new Uint8Array(await f.arrayBuffer()) : typeof f.text === "function" ? await f.text() : f.bytes || f.data || f.content || "";
        await load(f.name || "drawing.dxf", data);
      }), info);
      const body = el("div");
      form.append(pick, body);
      async function load(name, input, translated) {
        try {
          st.file = translated?.provenance.files[0] || {name, bytes:typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input)};
          const r = translated || await (await globalThis.AtriumLazy.need("AtriumTranslatorClient")).import([st.file], {translator:"dxf"});
          st.result = r.provenance.mechanical.drawing;
        } catch (e) { st.result = null; body.replaceChildren(); say(e.message, "error"); preview(view, {empty: "No drawing loaded."}); syncPrimary(); return; }
        st.name = name;
        const L = st.result.layers.filter(l => l.count);
        const guess = L.filter(l => /outline|board|edge|profile|border|contour|pcb|dim/i.test(l.name));
        st.layers = new Set((guess.length ? guess : L.slice(0, 1)).map(l => l.name));
        say("");
        paint();
      }
      const mm = () => st.units === "auto" ? st.result.units.mm : DXF.UNITS[st.units];
      function paint() {
        const r = st.result;
        body.replaceChildren();
        if (!r) return;
        const det = r.units;
        info.textContent = st.name + " · " + r.entities.length + " entities · " + (det.assumed ? "no $INSUNITS, assuming " + det.name : "units " + det.name) + (r.version ? " · " + r.version : "");
        const g = el("div", null, "bsh-grid");
        g.append(choice("Units", [["auto", "From file (" + det.name + ")"], ["mm", "Millimetres"], ["cm", "Centimetres"], ["m", "Metres"], ["in", "Inches"], ["mil", "Mils"], ["ft", "Feet"]], st.units, v => { st.units = v; draw(); }).wrap,
          choice("Import as", [["shape", "Board shape"], ["graphics", "Graphics on a layer"]], st.as, v => { st.as = v; paint(); }).wrap);
        if (st.as === "graphics") {
          const names = [...new Set([...LAYER_CHOICES, ...live().items.map(i => i.layer).filter(l => l && l !== "Multi")])];
          g.append(choice("Layer", names.map(n => [n, n]), st.target, v => { st.target = v; }).wrap, lengthField(u, st.width, "Line width", v => { st.width = v; }, {min: 0, error: say}).wrap);
        } else g.append(lengthField(u, st.tol, "Endpoint tolerance", v => { st.tol = v; draw(); }, {positive: true, error: say}).wrap);
        body.append(g);
        // Layer table.
        const wrap = el("div", null, "bsh-table-wrap"), table = el("table", null, "bsh-table", {"aria-label": "DXF layers"});
        const hr = el("tr");
        for (const h of ["", "Layer", "Entities", "Types"]) hr.append(el("th", h, null, {scope: "col"}));
        const thead = el("thead"), tbody = el("tbody");
        thead.append(hr); table.append(thead, tbody);
        for (const l of r.layers) {
          const tr = el("tr", null, l.count ? null : "is-empty"), c = el("input", null, null, {type: "checkbox", "aria-label": "Import layer " + l.name});
          c.checked = st.layers.has(l.name); c.disabled = !l.count;
          c.onchange = () => { if (c.checked) st.layers.add(l.name); else st.layers.delete(l.name); draw(); };
          const td = el("td"); td.append(c);
          tr.append(td, el("td", l.name), el("td", String(l.count), "bsh-numcell"), el("td", Object.entries(l.types).map(([k, n]) => n + " " + k.toLowerCase()).join(", ")));
          tbody.append(tr);
        }
        wrap.append(table); body.append(wrap);
        const place = el("div", null, "bsh-grid");
        place.append(lengthField(u, st.x, "Offset X", v => { st.x = v; draw(); }, {error: say}).wrap, lengthField(u, st.y, "Offset Y", v => { st.y = v; draw(); }, {error: say}).wrap);
        body.append(place, check("Move the drawing's lower-left corner to the offset", st.toOrigin, v => { st.toOrigin = v; draw(); }).wrap);
        for (const w of r.warnings) body.append(el("p", w, "bsh-note"));
        body.append(state);
        draw();
      }
      const state = el("div", null, "bsh-result");
      let plan = null;
      function draw() {
        plan = null; state.replaceChildren();
        const r = st.result;
        if (!r || !st.layers.size) { preview(view, {empty: r ? "Choose at least one layer." : "No drawing loaded."}); syncPrimary(); return; }
        const k = mm(), pv = DXF.preview(r, {layers: [...st.layers]}), b = pv.bounds;
        if (!b) { preview(view, {empty: "The chosen layers are empty."}); syncPrimary(); return; }
        const o = fromUser(live(), [st.x, st.y]), offset = st.toOrigin ? [o[0] - b[0] * k, o[1] - b[3] * k] : o;
        if (st.as === "shape") {
          const res = AtriumBoardShapeSources.fromSegments(DXF.segments(r, {layers: [...st.layers], mm: k, offset}), {tolerance: st.tol, source: "dxf"});
          plan = {kind: "shape", res, offset, k};
          const dl = el("dl", null, "bsh-facts");
          dl.append(el("dt", "Closed loops"), el("dd", String(res.loops)));
          if (res.shape) { const s = Shape.describe(res.shape); dl.append(el("dt", "Size"), el("dd", u.fmt(s.width) + " × " + u.fmt(s.height)), el("dt", "Cutouts"), el("dd", String(s.cutouts)), el("dt", "Arcs"), el("dd", String(s.arcs))); }
          state.append(dl);
          for (const w of res.warnings) state.append(el("p", w, "bsh-warn"));
          const gaps = res.gaps.filter(g => Number.isFinite(g.distance));
          if (!res.shape) state.append(el("p", "The chosen layers do not form a closed outline" + (gaps.length ? "; the largest gap is " + u.fmt(Math.max(...gaps.map(g => g.distance))) + ". Raise the endpoint tolerance or fix the drawing." : "."), "bsh-warn"));
          else if (res.gaps.length) state.append(el("p", res.gaps.length + " open end" + (res.gaps.length === 1 ? " was" : "s were") + " ignored.", "bsh-note"));
          preview(view, {shape: res.shape, gaps: res.shape ? [] : res.gaps, bounds: res.shape ? null : [offset[0] + b[0] * k, offset[1] + b[1] * k, offset[0] + b[2] * k, offset[1] + b[3] * k],
            caption: (pv.truncated ? "Preview truncated. " : "") + (res.shape ? summaryText(res.shape, u) : "")});
        } else {
          plan = {kind: "graphics", offset, k};
          const vb = [b[0], b[1], b[2], b[3]];
          preview(view, {paths: pv.paths, bounds: vb, caption: (pv.truncated ? "Preview truncated to the first 40,000 segments. " : "") + "Drawing size " + u.fmt((b[2] - b[0]) * k) + " × " + u.fmt((b[3] - b[1]) * k)});
        }
        syncPrimary();
      }
      if (opts.dxfTranslation) load(opts.dxfTranslation.provenance.files[0].name, null, opts.dxfTranslation);
      else if (opts.dxfText) load(opts.dxfName || "drawing.dxf", opts.dxfText);
      else preview(view, {empty: "No drawing loaded."});
      return {
        disabled: () => !plan || plan.kind === "shape" && !plan.res.shape,
        async run() {
          if (!plan) throw Error("Choose a DXF file and layers.");
          const target = live(), project = ctx.currentProject?.() || ctx.project, kind = plan.kind;
          const client = await globalThis.AtriumLazy.need("AtriumTranslatorClient");
          const r = await client.import([st.file], {translator:"dxf", mode:kind === "shape" ? "outline" : "graphics",
            layers:[...st.layers], mm:plan.k, offset:plan.offset, tolerance:st.tol, target:st.target, width:st.width});
          if (ctx.currentProject && ctx.currentProject() !== project || live() !== target) throw Error("The target board changed. Import the drawing again.");
          const added = r.model.documents[0];
          if (kind === "shape") {
            ctx.edit(() => apply(target, globalThis.AtriumBoardShape.fresh(added), "dxf"));
            done("Board shape imported from " + st.name + ". " + summaryText(current(target), u) + ".");
          } else {
            ctx.edit(() => { for (const item of added.items) target.items.push(item); });
            done("Imported " + added.items.length + " graphics onto " + st.target + ".");
          }
          await globalThis.AtriumNavHost.showImportReport(r, [target.id], [st.name]);
        }
      };
    });

    // -- Export DXF -------------------------------------------------------------------
    def("export", "Export DXF", "Export DXF", panel => {
      const {form, view} = split(panel);
      const layers = DXF.layersOf(live(), ctx.defs || new Map());
      const st = {units: u.unit === "mil" ? "in" : "mm", origin: live().origin ? "user" : "board", mode: "polyline", outline: true, holes: true, layers: new Set(layers.filter(l => /^mechanical/i.test(l.name)).map(l => l.name))};
      const g = el("div", null, "bsh-grid");
      g.append(choice("Units", [["mm", "Millimetres"], ["in", "Inches"]], st.units, v => { st.units = v; }).wrap,
        choice("Origin", [["board", "Board lower-left"], ["absolute", "Design origin (0, 0)"], ...(live().origin ? [["user", "Board origin"]] : [])], st.origin, v => { st.origin = v; }).wrap,
        choice("Entities", [["polyline", "Polylines (arc bulges)"], ["primitives", "Lines and arcs"]], st.mode, v => { st.mode = v; }).wrap);
      form.append(g, check("Board outline and cutouts (layer BOARD_OUTLINE)", st.outline, v => { st.outline = v; draw(); }).wrap, check("Drill holes as circles (layer HOLES)", st.holes, v => { st.holes = v; draw(); }).wrap);
      if (layers.length) {
        form.append(el("h4", "Layers", "bsh-sub"));
        const list = el("div", null, "bsh-layer-list");
        for (const l of layers) list.append(check(l.name + " (" + l.count + ")", st.layers.has(l.name), v => { if (v) st.layers.add(l.name); else st.layers.delete(l.name); draw(); }).wrap);
        form.append(list);
      }
      form.append(el("p", "Writes AutoCAD R12 ASCII DXF, which every MCAD tool reads. Arcs stay exact; tracks and graphics export as centre lines.", "bsh-note"));
      function draw() {
        const shape = st.outline ? current(live()) : null;
        const holes = [];
        if (st.holes) for (const i of live().items) if ((i.kind === "pad" || i.kind === "via") && i.drill > 0) holes.push({x: i.x, y: i.y, d: i.drill});
        const paths = [];
        for (const i of live().items) if (Array.isArray(i.points) && i.points.length >= 2 && st.layers.has(i.layer || "Top")) paths.push({d: "M" + i.points.map(p => p[0].toFixed(3) + " " + p[1].toFixed(3)).join("L") + (i.closed ? "Z" : "")});
        preview(view, {shape, holes, paths: paths.slice(0, 5000), empty: "Nothing selected for export."});
        syncPrimary();
      }
      draw();
      return {
        show: draw,
        disabled: () => !st.outline && !st.holes && !st.layers.size,
        async run() {
          const client = await globalThis.AtriumLazy.need("AtriumTranslatorClient");
          const r = await client.export("dxf", ctx.currentProject?.() || ctx.project, {documentId:live().id,
            units:st.units, origin:st.origin, mode:st.mode, outline:st.outline, holes:st.holes, layers:[...st.layers],
            provenance:globalThis.AtriumImportReports?.provenance()});
          if (!r.details.entities) throw Error("Nothing to export.");
          const {name, text} = r.files[0], ok = await ctx.exportFile(name, text);
          if (ok !== false) say("Exported " + r.details.entities + " entit" + (r.details.entities === 1 ? "y" : "ies") + " to " + name + ".");
        }
      };
    });

    for (const [id, t] of Object.entries(T)) {
      const b = button(t.label, () => select(id), "bsh-tab ui-tab");
      b.setAttribute("role", "tab"); b.id = "bsh-tab-" + id; b.setAttribute("aria-controls", "bsh-panel-" + id);
      buttons[id] = b; tabs.append(b);
      panels[id] = el("section", null, "bsh-panel ui-dialog-body", {role: "tabpanel", id: "bsh-panel-" + id, "aria-labelledby": "bsh-tab-" + id});
    }
    tabs.addEventListener("keydown", e => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const ids = Object.keys(T), next = ids[(ids.indexOf(tab) + (e.key === "ArrowRight" ? 1 : ids.length - 1)) % ids.length];
      select(next); buttons[next].focus(); e.preventDefault();
    });
    d.append(head, tabs, ...Object.values(panels), message, actions);
    // Non-modal: the canvas stays live. Selection changes made on the canvas refresh the
    // Define from Selection analysis; Escape inside the panel closes it.
    let pending = 0;
    const follow = e => {
      if (tab !== "define" || d.contains(e.target)) return;
      clearTimeout(pending); pending = setTimeout(() => { if (d.open && tab === "define") T.define.api?.show?.(); }, 0);
    };
    document.addEventListener("pointerup", follow, true); document.addEventListener("keyup", follow, true);
    d.addEventListener("keydown", e => { if (e.key === "Escape" && !e.defaultPrevented) { e.preventDefault(); e.stopPropagation(); d.close(); } });
    d.addEventListener("close", () => { document.removeEventListener("pointerup", follow, true); document.removeEventListener("keyup", follow, true); clearTimeout(pending); d.remove(); });
    document.body.append(d);
    refreshHead();
    globalThis.AtriumShell?.adoptDialog?.(d, {defaultAction: false}); d.show();
    const initial = T[opts.tab] ? opts.tab : (ctx.selection?.() || []).length ? "define" : current(live()) ? "dims" : "wizard";
    select(initial);
    return d;
  }
  function openBounds(r) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const segs of r.openSegments || []) contourBounds(segs, b);
    for (const g of r.gaps || []) { contourBounds([line(g.from, g.to || g.from)], b); }
    return b[0] === Infinity ? null : b;
  }

  function perimeter(board, ctx) {
    const points = board.outline.length ? board.outline : [[0, 0], [40, 0], [40, 25], [0, 25]];
    const u = unitsOf(ctx), words = u.unit === "mil" ? "mils" : "millimetres";
    const dialog = el("dialog", null, "ui-dialog message-dialog", {"aria-label": "Board perimeter"});
    const field = el("textarea", null, "ui-field", {"aria-label": "Perimeter vertices in " + words});
    const error = el("p");
    field.rows = Math.min(12, Math.max(4, points.length)); field.spellcheck = false;
    field.value = points.map(pair => pair.map(u.show).join(", ")).join("\n");
    const apply = () => {
      const outline = field.value.trim().split(/\n/).map(line =>
        line.trim().replace(/(\d)\s+(?=[a-z"µμ])/gi, "$1").split(/[,\s]+/).map(u.parse));
      if (outline.length < 3 || outline.some(p => p.length !== 2 || p.some(v => !Number.isFinite(v) || Math.abs(v) > 1e7)) || !globalThis.Atrium.validOutline(outline)) {
        error.textContent = "Enter at least three coordinate pairs enclosing a nonzero area.";
        return;
      }
      ctx.apply(outline);
      dialog.close();
    };
    const title = el("h2", "Board perimeter", "ui-dialog-title"), body = el("div", null, "ui-dialog-body");
    body.append(el("p", "Enter one X, Y pair per line in " + words + ". Suffixes such as mm or mil override the unit."), field, error);
    const actions = el("div", null, "ui-dialog-actions"), save = button("Apply", apply);
    save.dataset.variant = "primary";
    actions.append(button("Cancel", () => dialog.close()), save);
    dialog.append(title, body, actions);
    document.body.append(dialog);
    dialog.onclose = () => dialog.remove();
    globalThis.AtriumShell?.adoptDialog?.(dialog, {initialFocus: field}); dialog.showModal();
  }
  return {open, properties, preview, perimeter};
})();
