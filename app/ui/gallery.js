"use strict";
// The UI library's living gallery (docs/ui-library.md): every component in every state that can be
// shown at rest, drawn by the real stylesheets and the real builders (ui/kit.js), inside the real app
// so the icon bank, AtriumSelectPopup, tooltips and the native-behaviour policies all apply.
// Open app/index.html#ui-gallery (development) or run the "ui-gallery" action. Theme and keyboard-focus
// switches sit in its toolbar; touch density follows the device (tests/browser-ui-gallery.cjs emulates it).
// Each section's id matches its entry in docs/ui-library.md.
globalThis.AtriumUIGallery = (() => {
  const K = () => globalThis.AtriumUIKit, doc = globalThis.document;
  let root = null;

  const specimen = (label, ...nodes) => {
    const s = K().el("div", "ui-gallery-specimen"), cap = K().el("span", "ui-gallery-caption", label), box = K().el("div", "ui-gallery-stage");
    box.append(...nodes); s.append(cap, box); return s;
  };
  const family = (id, title, note, ...specimens) => {
    const s = K().section(title, {note, level: 2}, ...specimens);
    s.id = "ui-" + id; s.classList.add("ui-gallery-family"); s.dataset.family = id;
    return s;
  };
  const disabled = node => { (node.matches("button,input,select,textarea") ? node : node.querySelector("button,input,select,textarea")).disabled = true; return node; };
  const focusDemo = node => { node.dataset.galleryFocus = ""; return node; };
  // A specimen on a drawing-like backdrop, for parts that sit over artwork (floating notices, overlay labels).
  const onArtwork = (label, ...nodes) => { const s = specimen(label, ...nodes); s.lastChild.classList.add("ui-gallery-canvas"); return s; };

  function sections() {
    const k = K(), b = k.button, sc = globalThis.AtriumShortcut;
    const marks = AtriumNavCommon.elWithAttributes("div", null, null, {role:"radiogroup", "aria-label":"Alignment"});
    marks.append(AtriumNavCommon.elWithAttributes("button", null, "ui-choice ui-choice-tinted ui-choice-marker", {type:"button", role:"radio", "aria-label":"Center", "aria-checked":"true"}));
    const modifier = AtriumNavCommon.elWithAttributes("button", "Add", "ui-choice ui-choice-tinted", {type:"button", "data-size":"touch", "aria-pressed":"true"});
    const textarea = () => { const t = k.el("textarea", "ui-field"); t.rows = 2; t.value = "Pin 1 is VDD.\nPin 2 is GND."; t.setAttribute("aria-label", "Notes"); return t; };
    const keycap = (binding, variant) => sc.render(binding, {variant});
    const menu = () => {
      const m = k.el("div", "nav-menu ui-gallery-static"); m.setAttribute("role", "menu"); m.setAttribute("aria-label", "Specimen menu");
      const item = (label, key, dis) => {
        const i = k.el("button", "nav-menu-item"); i.type = "button"; i.setAttribute("role", "menuitem"); i.tabIndex = -1;
        i.append(k.el("span", null, label)); if (key) i.append(keycap(key, "inline")); if (dis) i.disabled = true; return i;
      };
      m.append(item("Cut", "Mod+X"), item("Copy", "Mod+C"), item("Paste", "Mod+V", true), k.el("hr"), item("Properties…"));
      return m;
    };
    // The problem marker card (problem-hover.js): severity dot, title, one line, the objects and small actions.
    const problemCard = () => {
      const t = k.el("div", "ui-tooltip is-card ui-gallery-static"), head = k.el("div", "ui-tooltip-head"), dot = k.el("span", "ui-dot");
      dot.dataset.tone = "danger";
      head.append(dot, k.el("strong", null, "Clearance"), k.el("span", "ui-tooltip-meta", "Error"));
      const actions = k.el("div", "ui-tooltip-actions"), b = k.el("button", "ui-button", "Show in Messages");
      b.type = "button"; b.dataset.size = "sm"; b.dataset.variant = "quiet"; actions.append(b);
      t.append(head, k.el("div", "ui-tooltip-detail", "Measured 0.186 mm · required ≥ 0.2 mm"), k.el("div", "ui-tooltip-detail ui-tooltip-objects", "R12.1, Track GND"), actions);
      return t;
    };
    const tooltip = card => {
      const t = k.el("div", "ui-tooltip ui-gallery-static" + (card ? " is-card" : ""));
      if (card) { t.append(k.el("div", null, "R12 · 10 kΩ"), k.el("div", "ui-tooltip-detail", "0402 · Net VREF")); }
      else { t.append("Rotate selection "); t.append(keycap("Space", "inline")); }
      return t;
    };
    const toast = kind => { const t = k.el("div", "ui-toast ui-gallery-static is-shown", kind === "ok" ? "Saved Sensor board" : kind === "warn" ? "3 nets have no copper" : "Copied 4 parts"); t.dataset.kind = kind; return t; };
    const staticDialog = () => {
      const d = k.el("div", "ui-dialog ui-gallery-static ui-gallery-dialog"); d.setAttribute("role", "group"); d.setAttribute("aria-label", "Dialog specimen");
      const h = k.el("h2", "ui-dialog-title", "Rename Net");
      const body = k.el("div", "ui-dialog-body");
      const label = k.el("label", "ui-field-row"); label.append(k.el("span", null, "Name"), k.field({value: "VREF_2V5"}));
      body.append(label);
      const actions = k.el("div", "ui-dialog-actions");
      actions.append(k.el("span", "ui-dialog-status", "Used on 3 sheets"), b("Cancel"), b("Rename", {variant: "primary"}));
      d.append(h, body, actions); return d;
    };
    const table = () => {
      const t = k.el("table", "ui-table"), head = k.el("thead"), body = k.el("tbody"), tr = k.el("tr");
      for (const [h, n] of [["Designator"], ["Value"], ["Qty", true]]) { const th = k.el("th", n ? "is-number" : null, h); tr.append(th); }
      head.append(tr);
      const rows = [["C1–C4", "100 nF", "4"], ["R12", "10 kΩ", "1", "selected"], ["U3", "LDO 2.5 V", "1"], ["J1", "#REF!", "1", "error"]];
      for (const [d, v, q, st] of rows) {
        const r = k.el("tr"); if (st === "selected") r.setAttribute("aria-selected", "true");
        const vd = k.el("td", null, v); if (st === "error") vd.dataset.state = "error";
        r.append(k.el("td", null, d), vd, k.el("td", "is-number", q)); body.append(r);
      }
      t.append(head, body); return t;
    };
    const calcInput = k.el("details");
    calcInput.append(k.el("summary", "ui-disclosure-card", "R1"), k.el("div", null, "1 kΩ · Sensor board"));
    const clipRow = k.row({title: "Track", detail: "PCB · Top layer", selected: true}), clipList = k.list([clipRow], {label: "Clipboard"});
    clipRow.classList.add("ui-card-row");
    clipList.dataset.layout = "flush"; clipList.dataset.selectOnFocus = ""; clipList.tabIndex = 0;
    const projectHeading = k.el("summary", "ui-project-row"), projectGroup = k.el("details");
    const projectIcon = k.icon("project"); projectIcon.classList.add("tree-icon");
    projectHeading.append(projectIcon, k.el("span", "tree-label", "Sensor project")); projectGroup.append(projectHeading);
    const stackedList = k.list([k.row({title: "Standard", detail: "Four-layer board", selected: true})], {label: "Fabrication presets"});
    stackedList.dataset.layout = "stacked";
    const flushList = k.list([k.row({title: "Working design", selected: true}), k.row({title: "Saved file"})], {label: "Revisions"});
    flushList.dataset.layout = "flush"; flushList.tabIndex = 0;
    const reportActions = k.el("div", "ui-toolbar-actions"); reportActions.append(k.el("button", null, "Locate"));
    const tableScope = k.select(["All objects", "Selected objects"], {label: "Rows"}); tableScope.className = "ui-compact-field";
    const tableToolbar = k.toolbar([k.el("h2", null, "PCB List"), tableScope], {label: "PCB List"}); tableToolbar.dataset.table = "";
    const editorTabs = k.tabs(["Sensor board", "Power"], {value: "Sensor board", label: "Pane tabs"}); editorTabs.classList.add("ui-editor-tab-strip"); editorTabs.dataset.tabStrip = "pane";
    const copperLayer = k.el("button", "layer-tab copper ui-layer-action ui-chrome-action", "Top"); copperLayer.type = "button"; copperLayer.setAttribute("aria-pressed", "true");
    const tabDismiss = k.el("button", "ui-icon-button ui-chrome-action ui-dismiss-glyph");
    tabDismiss.type = "button"; tabDismiss.setAttribute("aria-label", "Close tab");
    const orbitTools = k.el("div", "ui-canvas-tools ui-gallery-static"); orbitTools.dataset.canvasTools = "right";
    orbitTools.append(k.el("button", null, "View"));
    const orbit = k.el("canvas", "ui-viewport ui-gallery-static ui-gallery-art");
    orbit.dataset.interaction = "orbit"; orbit.setAttribute("aria-label", "3D orbit surface");
    const gridEditor = k.field({value: "10 kΩ", label: "Edit value"}); gridEditor.dataset.gridEditing = "";
    const underlinedTabs = k.tabs([["pins", "Pins"], ["body", "Body"]], {value: "pins", label: "Symbol views"}); underlinedTabs.dataset.underline = "";
    const matrixFields = ["inherited", "authored", "override"].map(source =>
      AtriumNavCommon.elWithAttributes("input", null, "ui-field ui-field-number", {
        "data-value-source": source, "aria-label": source + " clearance", placeholder: "0.20", value: source === "inherited" ? "" : "0.25"
      }));
    const severityCell = b("W", {title: "Warning"});
    severityCell.classList.add("ui-severity-cell"); severityCell.dataset.severity = "warning";
    const art = ratio => { const a = k.el("span", "ui-gallery-art"); a.style.aspectRatio = ratio; return a; };
    const pageArt = art("4 / 3"); pageArt.classList.add("ui-page-art");
    const pageZoom = k.el("div", "ui-page-zoom"); pageZoom.append(pageArt.cloneNode());
    pageArt.style.maxWidth = "120px"; pageZoom.style.width = "160px";
    const detailPane = () => {
      const p = k.panel({title: "R12", actions: [k.iconButton("close", "Close", {size: "sm"})]});
      const matrix = k.section("Clearance matrix", {}, ...matrixFields); matrix.querySelector(".ui-section-head").dataset.bleed = "";
      p.body.append(underlinedTabs,
        k.section("Component", {quiet: true}, k.propRow("Designator", k.field({value: "R12", label: "Designator"})),
          k.propRow("Value", k.field({value: "10", unit: "kΩ", type: "number", label: "Value"})), k.propRow("Footprint", "0402")),
        matrix, calcInput,
        k.section("Links", {actions: [k.button("Add", {size: "sm", variant: "quiet"})]},
          k.row({title: "Datasheet p. 12", icon: "book", detail: "Rev C", meta: "PDF"}),
          k.row({title: "Removed note", icon: "comment", state: "broken", detail: "Target deleted"})));
      return p;
    };

    return [
      family("button", "Buttons", "One face per variant: soft-fill secondary, primary, quiet and danger. Sizes sm, md (default) and lg.",
        specimen("Variants", b("Secondary"), b("Primary", {variant: "primary"}), b("Quiet", {variant: "quiet"}), b("Delete", {variant: "danger"})),
        specimen("Sizes", b("Small", {size: "sm"}), b("Medium"), b("Large", {size: "lg"})),
        specimen("Stepper", AtriumUI.nativeButton("+", null, "ui-stepper-button", null, {variant:"quiet", ariaLabel:"Increase value"})),
        specimen("States", b("Pressed", {pressed: true}), b("Disabled", {disabled: true}), b("Primary disabled", {variant: "primary", disabled: true}), focusDemo(b("Keyboard focus")))),
      family("icon-button", "Icon buttons", "A square button around one icon; its label is the tooltip and accessible name.",
        specimen("Sizes", k.iconButton("search", "Search", {size: "sm"}), k.iconButton("settings", "Settings"), k.iconButton("layers", "Layers", {size: "lg"})),
        specimen("States", k.iconButton("grid", "Grid", {pressed: true}), k.iconButton("delete", "Delete", {disabled: true}), focusDemo(k.iconButton("plus", "Add")))),
      family("close", "Close button", "Dialogs and panels close with the shared close icon.",
        specimen("Default", k.closeButton(null)), specimen("Tab dismiss", tabDismiss), specimen("Disabled", disabled(k.closeButton(null)))),
      family("field", "Text and number fields", "28 px, 8 px text inset; numbers use the 80 px width with the unit beside them.",
        specimen("Text", k.field({value: "Sensor board", label: "Name"}), k.field({placeholder: "Placeholder", label: "Empty"})),
        specimen("Number with unit", k.field({type: "number", value: "0.15", unit: "mm", label: "Clearance"}), k.field({type: "number", value: "25", unit: "°C", label: "Ambient"})),
        specimen("States", k.field({value: "1.2.3", invalid: true, label: "Invalid"}), k.field({value: "Read only", disabled: true, label: "Disabled"}), focusDemo(k.field({value: "Focused", label: "Focused"})), AtriumNavCommon.elWithAttributes("input", null, "ui-field", {value: "Invalid length", "aria-label": "Rejected edit", "data-edit-rejected": "ink"})),
        specimen("Multiline", textarea())),
      family("select", "Selects", "A native single-line select; AtriumSelectPopup opens its list.",
        specimen("Default", k.select([["mm", "Millimetres"], ["mil", "Mils"], ["in", "Inches"]], {value: "mm", label: "Units"})),
        specimen("Disabled", k.select(["Top Layer"], {disabled: true, label: "Layer"})),
        specimen("Open list", (() => {
          const l = k.el("div", "ui-select-list ui-gallery-static"); l.setAttribute("role", "listbox"); l.setAttribute("aria-label", "Units");
          for (const [t, st] of [["Millimetres", "selected"], ["Mils", "active"], ["Inches"]]) {
            const o = k.el("div", "ui-select-option" + (st === "active" ? " active" : ""), t); o.setAttribute("role", "option");
            o.setAttribute("aria-selected", String(st === "selected")); l.append(o);
          }
          return l;
        })()),
        specimen("Completion list", (() => {
          const l = k.el("div", "ui-select-list ui-gallery-static"); l.setAttribute("role", "listbox"); l.setAttribute("aria-label", "Suggestions"); l.dataset.completion = "";
          for (const [t, on] of [["InNet('GND')", true], ["InNetClass('Power')"], ["InComponent('U3')"]]) {
            const o = k.el("div", "ui-select-option", t); o.setAttribute("role", "option"); o.setAttribute("aria-selected", String(!!on)); l.append(o);
          }
          return l;
        })())),
      family("switch", "Switches", "An immediate on/off setting. The knob slides over --motion-toggle.",
        specimen("Off and on", k.switchRow("Snap to grid"), k.switchRow("Show pad numbers", {checked: true})),
        specimen("Disabled", k.switchRow("Locked", {disabled: true}), k.switchRow("Locked on", {checked: true, disabled: true}))),
      family("checkbox", "Checkboxes", "A choice that applies with the form, or one of several.",
        specimen("States", k.checkbox("Unchecked"), k.checkbox("Checked", {checked: true}), k.checkbox("Mixed", {indeterminate: true}), k.checkbox("Disabled", {disabled: true}))),
      family("radio", "Radio buttons", "One of a few exclusive options, all visible.",
        specimen("Group", k.radioGroup([["top", "Top side"], ["bottom", "Bottom side"], ["both", "Both sides", true]], {value: "top", label: "Side"})),
        specimen("Canvas choices", marks, modifier),
        specimen("Checked row", Object.assign(k.radioGroup([["saved", "Saved snapshot"]], {value: "saved"}).firstElementChild, {className: "ui-radio-row ui-choice ui-choice-tinted"}))),
      family("segmented", "Segmented controls", "Two to five exclusive modes in a soft track; the chosen segment is raised.",
        specimen("Default", k.segmented([["2d", "2D"], ["3d", "3D"], ["split", "Split"]], {value: "2d", label: "View"})),
        specimen("Small", k.segmented([["a", "All"], ["e", "Errors"], ["w", "Warnings"]], {value: "e", label: "Filter", size: "sm"}))),
      family("tabs", "Tabs", "Switch between views of the same thing; one 2 px accent indicator.",
        specimen("Default", k.tabs([["general", "General"], ["rules", "Rules"], ["history", "History"]], {value: "rules", label: "Sections"})),
        specimen("Editor strip", editorTabs),
        specimen("Boxed", k.tabs([["lines", "Lines"], ["optimise", "Optimise"]], {value: "lines", label: "BOM views", boxed: true})),
        specimen("Strip", k.tabs([["bom", "Bill of Materials"], ["parts", "Parts"], ["check", "Check"]], {value: "bom", label: "Views", strip: true}))),
      family("chip", "Chips", "22 px, control radius; hairline off, raised neutral fill on. Never a pill or an accent fill.",
        specimen("Toggle", k.chip("Parts", {onToggle: () => {}, pressed: true}), k.chip("Wires", {onToggle: () => {}}), k.chip("Labels", {onToggle: () => {}})),
        specimen("Token", k.chip("net:GND", {onRemove: () => {}}), k.chip("layer:Top", {onRemove: () => {}}), k.chip("bad:value", {invalid: true})),
        specimen("States", disabled(k.chip("Disabled", {onToggle: () => {}})), focusDemo(k.chip("Focused", {onToggle: () => {}})))),
      family("badge", "Badges, counts and dots", "Status ink on its tint. Counts use tabular figures.",
        specimen("Badges", k.badge("Draft"), k.badge("Ready", "success"), k.badge("Stale", "warning"), k.badge("Failed", "danger"), k.badge("Beta", "info"), k.badge("Linked", "accent"), AtriumNavCommon.elWithAttributes("span", "Applied", "ui-badge", {"data-outline": ""})),
        specimen("Counts", k.count(3), k.count(128, {tone: "warning"}), k.count(2, {tone: "danger", strong: true})),
        specimen("Dots", k.dot("success", {label: "Connected"}), k.dot("warning", {label: "Partial"}), k.dot("danger", {label: "Offline"}), k.dot("accent", {pulse: true, label: "Live"}))),
      family("avatar", "Avatars", "Initials for a person, a monogram for an extension. The hue is an identity colour, not a status.",
        specimen("Presence", ...[0, 1, 2, 3, 4].map(hue => k.avatar("YX".slice(0, 1 + hue % 2), {hue, label: "Collaborator " + (hue + 1)})), k.avatar("+3")),
        specimen("States", k.avatar("A", {hue: 0, state: "active", label: "Editing"}), k.avatar("B", {hue: 1, state: "away", label: "Viewing"}), k.avatar("C", {hue: 2, state: "stale", label: "Stale lock"}),
          k.avatar("D", {hue: 3, size: "sm", state: "active", label: "Editing"}), k.avatar("E", {hue: 4, size: "sm", label: "Viewing"})),
        specimen("Monogram", k.avatar("GS", {hue: 0, size: "lg", shape: "square", label: "Gerber Studio"}), k.avatar("IP", {size: "lg", shape: "square", label: "IPC Tools"}))),
      family("overlay-label", "Overlay labels", "A short label on a solid surface over artwork, in its end corner.",
        onArtwork("On artwork", k.overlayLabel("4L + flex"), AtriumNavCommon.elWithAttributes("button", "×", "ui-close", {type: "button", "aria-label": "Hide minimap", "data-fill": "overlay"}))),
      family("search", "Search fields", "A magnifier, the query, an optional match count and a clear button.",
        specimen("Empty", k.search({placeholder: "Search parts"})), specimen("With matches", k.search({value: "net:GND", count: "12 of 40", label: "Find"}))),
      family("keycap", "Keycaps and shortcuts", "AtriumShortcut renders bindings: keycaps for keys, inline for hints. Mac shows \"esc\".",
        specimen("Keycaps", keycap("Mod+Shift+P", "keycap"), keycap("Escape", "keycap")), specimen("Inline", keycap("Mod+S", "inline"))),
      family("section", "Section headers", "A heading with its actions on the same row and a hairline under it; no boxes.",
        specimen("With actions", k.section("Net Classes", {actions: [k.iconButton("plus", "Add class", {size: "sm"}), k.iconButton("settings", "Class options", {size: "sm"})]}, k.el("p", "ui-gallery-filler", "Content follows the hairline."))),
        specimen("With note", k.section("Clearance", {note: "Applies to every copper object on the board."})),
        specimen("Disclosure marker", k.el("div", "ui-section-head ui-disclosure-marker", "Clearance"))),
      family("prop-row", "Property rows", "Caption and value side by side; Properties, inspectors and settings.",
        specimen("Rows", k.propRow("Designator", k.field({value: "U3", label: "Designator"})), k.propRow("Width", k.field({type: "number", value: "0.2", unit: "mm", label: "Width"})),
          k.propRow("Locked", k.switchRow("", {checked: true})), k.propRow("Package", "SOT-23-5"), k.propRow("Value", AtriumNavCommon.elWithAttributes("input", null, "ui-field", {value:"1k2k", "aria-label":"Value", "data-edit-rejected":""}), {error: "Not a resistance"}))),
      family("row", "List and tree rows", "One row shape for lists and trees: icon, title, detail, meta, actions on hover.",
        specimen("List", k.list([
          k.row({title: "Sensor board", icon: "board", detail: "PCB · Saved 2 min ago", meta: "v12"}),
          k.row({title: "Power", icon: "schematic", detail: "Sheet 2", selected: true, actions: [k.iconButton("delete", "Remove", {size: "sm"})], reveal: false}),
          k.row({title: "Removed view", icon: "dview", state: "broken", detail: "Target deleted"}),
          k.row({title: "Loading revision…", icon: "open", state: "pending", meta: k.spinner({size: "sm", label: "Loading"})})], {label: "Documents"})),
        specimen("Flush list", flushList),
        specimen("Clipboard cards", clipList),
        specimen("Stacked list", stackedList),
        specimen("Project tree row", projectGroup),
        specimen("Tree", k.list([
          k.row({title: "Project", icon: "project", depth: 0, expanded: true}),
          k.row({title: "Schematics", icon: "folder", depth: 1, expanded: false}),
          k.row({title: "Board.PcbDoc", icon: "board", depth: 1, expanded: undefined, selected: true, current: true}),
          k.row({title: "Notes", icon: "comment", depth: 1})], {role: "tree", label: "Project"})),
        specimen("Choice", k.list([
          k.row({title: "Shortest path", detail: "Fewest vias", checked: true}),
          k.row({title: "Fanout first", detail: "Escape BGAs, then route", checked: false})], {role: "radiogroup", label: "Strategy"}))),
      family("table", "Tables", "Sticky muted header, 24 px rows, tabular numbers; errors mark the cell.",
        specimen("Data table", table()),
        specimen("Cell editor", gridEditor),
        specimen("Severity cell", severityCell),
        specimen("Analysis results", k.analysisTable(["Net", "Status"], [["VREF", "OK"]], cells => {
          const row = k.el("tr");
          row.append(...cells.map(value => k.el("td", null, value)));
          return row;
        }, {tableClass: "analysis-table"}))),
      family("viewport", "Design viewport", "Orbit uses the grab cursor over artwork.", specimen("Orbit", orbit), specimen("Orbit tools", orbitTools)),
      family("toolbar", "Toolbars", "Icon buttons, separators, a spacer and a search field on one row.",
        specimen("Default", k.toolbar([k.iconButton("select", "Select", {pressed: true}), k.iconButton("route", "Route"), "|", k.iconButton("undo", "Undo"), k.iconButton("redo", "Redo"), "->", k.search({placeholder: "Filter"})], {label: "Specimen tools"})),
        specimen("Table header", tableToolbar), specimen("Table actions", reportActions),
        specimen("Current copper layer", copperLayer),
        specimen("Floating", (() => { const t = k.toolbar([k.pager({index: 2, count: 12, unit: "slide"}), k.el("span", "ui-toolbar-title", "Power stage"), "|", k.button("Notes", {variant: "quiet", size: "sm", pressed: false}), k.button("End", {variant: "quiet", size: "sm"})], {label: "Specimen presentation", floating: true}); t.classList.add("ui-gallery-floating"); return t; })()),
        specimen("Note formatting", k.toolbar([k.select([["text","Text"]], {label:"Paragraph style", native:true}), AtriumNavCommon.elWithAttributes("button", "B", null, {type:"button","aria-pressed":"true","aria-label":"Bold"}), AtriumNavCommon.elWithAttributes("input", null, "ui-field", {type:"url","aria-label":"Link URL","data-field-face":"paper",placeholder:"https://"})], {label:"Note formatting",floating:"editing"}))),
      family("menu", "Menus", "Menus and context menus come from AtriumContextMenu (popup, dropdown); shortcuts sit at the end.",
        specimen("Menu", menu()), specimen("Menu button", (() => {
          const t = b("Options…"); globalThis.AtriumNavCommon?.actionMenu?.(t, [{label: "Rename", run: () => {}}, {label: "Duplicate", run: () => {}}]); return t;
        })()), specimen("Command picks", (() => { const group = k.el("details", "ui-menu-picks"); group.open = true; group.append(AtriumNavCommon.elWithAttributes("summary", "Resistors", "ui-chrome-action ui-chrome-action-compact", {"data-fill": "soft"}), k.el("button", "selected", "10 kΩ, 0402")); return group; })())),
      family("popover", "Popovers, tooltips and hover cards", "Tooltips and hover cards are AtriumTooltip: small, never in the way, gone on camera moves.",
        specimen("Tooltip", tooltip(false)), specimen("Hover card", tooltip(true)), specimen("Problem card", problemCard()),
        specimen("Popover", (() => { const p = k.el("div", "ui-popover ui-gallery-static ui-gallery-popover"); p.append(k.propRow("Grid", k.field({type: "number", value: "0.1", unit: "mm", label: "Grid"}))); return p; })())),
      family("dialog", "Dialogs and sheets", "AtriumShell.dialog: compact, title, body, one action row; centred in the window's safe area.",
        specimen("Dialog", staticDialog()), specimen("Open one", b("Open Dialog…", {run: () => globalThis.AtriumShell?.dialog({title: "Rename Net", body: [k.field({value: "VREF", label: "Name"})], actions: [{label: "Cancel"}, {label: "Rename", primary: true}]})}))),
      family("toast", "Toasts and status lines", "AtriumToast.show for a brief notice; a status line for state inside a surface.",
        specimen("Toasts", toast("info"), toast("ok"), toast("warn")),
        specimen("Status lines", k.statusLine("Saved 2 minutes ago"), k.statusLine("Counting matches…", {busy: true}), k.statusLine("3 links are broken", {tone: "danger"}))),
      family("notice", "Notices", "An inline note about a surface's state: stale, offline, read-only, partial.",
        specimen("Tones", k.notice({text: "This view shows the saved revision."}), k.notice({tone: "info", title: "Read-only.", text: "Opened from a Git revision."}),
          k.notice({tone: "warning", title: "Stale.", text: "The board changed after this preview.", actions: [b("Refresh", {size: "sm"})]}),
          k.notice({tone: "danger", title: "Offline.", text: "The datasheet source cannot be reached.", actions: [b("Retry", {size: "sm"})]})),
        onArtwork("Floating", k.notice({tone: "warning", floating: true, title: "Rev B", text: "Released · read-only.", actions: [b("New Revision", {size: "sm", variant: "primary"}), b("Revisions…", {size: "sm"})]}))),
      family("empty", "Empty states", "Say what is missing and offer the one action that fills it.",
        specimen("In a list", k.empty({title: "No saved views", text: "Save the current camera, layers and filter to come back to it.", actions: [b("Save View")]})),
        specimen("Plain", k.empty({text: "No matches for “net:VREF”."}))),
      family("progress", "Progress and spinners", "A bar when progress is measurable, a spinner for a short unmeasured wait.",
        specimen("Determinate", k.progress({value: .4, label: "Exporting ODB++"})), specimen("Indeterminate", k.progress({label: "Reading datasheet"})),
        specimen("Spinners", k.spinner(), k.spinner({size: "sm"})), specimen("Placeholder", (() => { const s = k.el("div", "ui-skeleton ui-gallery-skeleton"); return s; })())),
      family("thumb", "Thumbnails", "Pages, slides, history steps and views; current has the accent ring.",
        specimen("Tiles", k.el("div", "ui-thumbs ui-gallery-thumbs")),
        specimen("Printed pages", pageArt, pageZoom),
        specimen("Strip", (() => { const t = k.el("div", "ui-thumbs ui-gallery-strip"); t.dataset.strip = "row"; return t; })())),
      family("pager", "Pagers", "One way to step pages, slides, views, matches and history: previous, position, next.",
        specimen("Pages", k.pager({index: 2, count: 48})), specimen("Matches", k.pager({index: 0, count: 9, unit: "match"})),
        specimen("At the end", k.pager({index: 11, count: 12, unit: "slide"})), specimen("Nothing yet", k.pager({count: 0, unit: "slide"}))),
      family("commit-graph", "Commit graph", "Proposed (History). Lanes for branches and merges on one canvas beside a virtual list; uncommitted work is dashed. Lane colours are identity hues, never status tones.",
        specimen("Branches, a merge and uncommitted work", k.el("div", "ui-gallery-graph ui-list")),
        specimen("Icons (proposed)", k.iconButton("history", "History"), k.iconButton("branch", "Branch"), k.iconButton("more", "More actions"))),
      family("steps", "Steps", "An ordered list of work with each step's state (macros, jobs).",
        specimen("Replay", k.steps([{title: "Select net GND", state: "done", result: "12 objects"}, {title: "Set width 0.3 mm", state: "running", result: "Applying"},
          {title: "Run DRC", state: "skipped", result: "Condition false"}, {title: "Export Gerber", state: "failed", result: "No outline"}, {title: "Save"}]))),
      family("diff", "Before and after", "Proposed and previewed changes.",
        specimen("Values", k.diff("0.15 mm", "0.20 mm"), k.diff("10 kΩ", "12 kΩ")), specimen("Error span", (() => { const p = k.el("span", "ui-code"); p.append("width > ", k.el("span", "ui-error-span", "3 apples")); return p; })())),
      family("transcript", "Transcript", "AI requests, answers with citations and tool evidence.",
        specimen("Turns", k.el("div", "ui-transcript ui-gallery-transcript"))),
      family("recording", "Recording indicator", "A dot with a halo while a macro records.", specimen("Recording", k.recording("Recording · 4 steps"))),
      family("splitter", "Splitters", "1 px divider, 4 px hit area (16 px on touch), lit on hover, drag and keyboard focus.",
        specimen("Vertical", (() => { const w = k.el("div", "ui-gallery-split"); w.append(k.el("div", null, "List"), k.splitter({label: "Resize list"}), k.el("div", null, "Detail")); return w; })())),
      family("drag", "Drag handles and drop targets", "Handles keep the arrow cursor; targets say ready, over, denied or busy.",
        specimen("Handle", (() => { const r = k.row({title: "Step 2", detail: "Drag to reorder"}); r.prepend(k.dragHandle()); r.style.gridTemplateColumns = "auto auto minmax(0,1fr)"; return r; })()),
        specimen("Targets", ...["ready", "over", "denied", "busy"].map(state => k.dropState(k.el("div", "ui-gallery-drop", state), state))),
        specimen("Insertion line", k.el("div", "ui-drop-line"))),
      family("panel", "Panels and list-detail", "A panel: heading with actions, scrolling body, footer. Detail panes reuse sections and property rows.",
        specimen("Inspector", detailPane()),
        specimen("Overlay drawers", ...["workspace", "sheet"].map(edge => Object.assign(k.el("aside", "ui-drawer ui-gallery-static", edge === "sheet" ? "Columns" : "Workspace"), {style: `--ui-drawer-shadow:var(--elev-${edge}-drawer);background:var(--surface);padding:var(--s-8)`})))),
    ];
  }

  function fillLate(node) {
    const k = K();
    const tiles = node.querySelector(".ui-gallery-thumbs");
    tiles?.append(k.thumb({label: "1", art: art("1 / 1.414"), current: true}), k.thumb({label: "2", art: art("1 / 1.414")}), k.thumb({label: "3", state: "pending"}), k.thumb({label: "4", state: "failed", art: art("1 / 1.414")}));
    node.querySelector(".ui-gallery-strip")?.append(...["Overview", "Power stage", "Sensor", "Layout"].map((label, i) =>
      k.thumb({label: (i + 1) + "  " + label, art: art("16 / 9"), current: i === 1, state: i === 3 ? "pending" : undefined})));
    const t = node.querySelector(".ui-gallery-transcript");
    t?.append(k.turn("user", "Which nets have no copper?"),
      k.turn("tool", "query nets where copper = 0 · 3 results"),
      k.turn("assistant", ["VREF, SENSE_N and NC_4 have no copper ", k.cite(1), "."]));
    function art(ratio) { const a = k.el("span", "ui-gallery-art"); a.style.aspectRatio = ratio; return a; }
    const graph = node.querySelector(".ui-gallery-graph");
    if (graph) {
      const L = globalThis.AtriumLazy;
      L.register("AtriumCommitGraph", {scripts: ["ui/commit-graph.js"]});
      L.need("AtriumCommitGraph").then(CG => {
        CG.icons();
        const entries = [["working", "Working design", ["e1"], true], ["e1", "Rotate R2", ["c1"], true], ["c1", "Merge review", ["c2", "c4"]],
          ["c2", "Fab notes", ["c3"]], ["c4", "Check creepage", ["c5"]], ["c3", "Reroute supply", ["c5"]], ["c5", "Add sensor interface", []]];
        const rows = CG.lanes(entries.map(([revision, , parents, pseudo]) => ({revision, parents, pseudo})));
        const canvas = k.el("canvas"), width = CG.width(rows) + 4;
        canvas.setAttribute("aria-hidden", "true");
        graph.style.setProperty("--ui-graph-w", width + "px");
        graph.setAttribute("role", "listbox"); graph.setAttribute("aria-label", "Commit graph specimen");
        graph.append(canvas, ...entries.map(([, title], i) => k.row({title, selected: i === 2, depth: undefined})));
        const h = graph.querySelector(".ui-row").getBoundingClientRect().height || 24;
        CG.paint(canvas, {rows, first: 0, last: rows.length, top: 0, rowHeight: h, width, height: h * rows.length,
          nodes: i => i === 0 ? {kind: "working"} : i === 1 ? {kind: "step"} : {kind: i === 2 ? "merge" : "commit", solid: true, current: i === 2}});
      }).catch(() => {});
    }
  }

  function mount() {
    if (root?.isConnected) { root.focus(); return root; }
    const k = K();
    root = k.el("div", "ui-gallery ui-fullwindow pane-scroll");
    root.setAttribute("role", "region"); root.setAttribute("aria-label", "Component Gallery"); root.tabIndex = -1;
    const html = doc.documentElement;
    const theme = k.segmented([["light", "Light"], ["dark", "Dark"]], {value: html.dataset.theme === "light" ? "light" : "dark", label: "Theme",
      onChange: v => { html.dataset.theme = v; html.style.colorScheme = v; }});
    const keys = k.switchRow("Keyboard focus", {onChange: on => {
      if (on) { html.dataset.focusNav = "keys"; for (const n of root.querySelectorAll("[data-gallery-focus]")) n.classList.add("ui-gallery-focus-on"); root.querySelector("[data-gallery-focus]")?.focus(); }
      else delete html.dataset.focusNav;
    }});
    const head = k.toolbar([k.el("h1", "ui-gallery-title", "Component Gallery"), "->", theme, keys, k.button("Close", {run: unmount})], {label: "Gallery"});
    head.classList.add("ui-gallery-head", "ui-fullwindow-bar");
    const body = k.el("div", "ui-gallery-body");
    body.append(...sections());
    root.append(head, body);
    fillLate(root);
    // The Start page opens on launch; on the gallery page it would cover the specimens.
    const quiet = () => { for (const d of doc.querySelectorAll("dialog.sp-dialog[open]")) d.close(); };
    quiet();
    for (let i = 1; i <= 20; i++) setTimeout(quiet, i * 150);
    doc.body.append(root);
    root.addEventListener("keydown", event => { if (event.key === "Escape" && event.target === root) unmount(); });
    root.focus({preventScroll: true});
    return root;
  }
  function unmount() {
    root?.remove(); root = null;
    if (globalThis.location?.hash === "#ui-gallery") globalThis.history?.replaceState?.(null, "", globalThis.location.pathname + globalThis.location.search);
  }
  globalThis.AtriumNavHost?.registerAction?.("ui-gallery", mount);
  return {mount, unmount, families: () => sections().map(s => s.dataset.family)};
})();
