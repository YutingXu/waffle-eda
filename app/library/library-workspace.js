"use strict";
// Full-window Library workspace hosted in an editor tab via AtriumDocViews (Design B Part 1).
// Built strictly from shared UI library primitives: AtriumUIKit, AtriumDocViews, AtriumWindowedTable,
// AtriumNavCommon.actionMenu, AtriumLibraryRows, AtriumLibraryFacetsUI, and AtriumLibraryInspector.
globalThis.AtriumLibraryView = (() => {
  const G = globalThis, ID = "library";
  const K = () => G.AtriumUIKit;
  const ROWS = () => G.AtriumLibraryRows;
  const FACETS = () => G.AtriumLibraryFacetsUI;
  const INSP = () => G.AtriumLibraryInspector;

  let instance = null;

  function makeContext(host) {
    return {
      currentProject: () => host.project(),
      project: host.project(),
      doc: host.doc?.(),
      documentKind: () => host.doc?.()?.kind || "schematic",
      revision: () => host.revision?.() ?? 0,
      selection: () => host.selection?.() || [],
      edit: (fn, label) => host.edit(fn, label),
      info: msg => host.info?.(msg),
      placeDef: (def, kind) => host.placeDef?.(def, kind),
      act: a => host.act?.(a)
    };
  }

  function mount(box, initial = {}) {
    const k = K(), el = k.el, host = G.AtriumNavHost, api = G.AtriumLibrary.panelApi();
    const ctx = makeContext(host);
    const S = {
      source: initial.source || "project",
      view: "all", // project view: all | used | unused | issues | family:<id>
      kindFilter: "all", // all | symbol | footprint
      query: initial.query || "",
      groupBy: "category", // category | family | none
      sortKey: "name",
      sortDir: 1,
      selected: initial.select || null,
      inspTab: "overview",
      lib: null,
      libraries: [],
      rows: [], // flat array of {type:"group", label, count} | {type:"item", def, facts, used, issues, status, statusMark, statusTone}
      itemIndex: new Map(),
      detailRead: null,
      detailBody: null,
      lastCounts: {}
    };
    let closed = false, intent = 0, checkTimer = 0;

    const project = () => ctx.currentProject();
    const documentKind = () => ctx.documentKind();
    const currentKind = () => documentKind() === "pcb" ? "pcb" : "schematic";
    const folderLibs = () => G.AtriumLibrarySources?.libraries() || [];
    const allLibs = () => [...api.sourceStore.sources(), ...folderLibs(), ...(G.AtriumGroupLocal?.libraries() || [])];

    // Nested .ui-split layout: sidebar | splitter | (main | splitter | inspector)
    const root = el("div", "ui-split lib-ws");
    const side = el("nav", "lib-ws-side pane-scroll");
    side.setAttribute("aria-label", "Library sources");

    let sideW = 204;
    const splitLeft = k.splitter({
      orientation: "vertical",
      label: "Resize library sources",
      onResize: dx => {
        sideW = Math.max(160, Math.min(340, sideW + dx));
        root.style.setProperty("--ui-split-list", Math.round(sideW) + "px");
      }
    });

    const inner = el("div", "ui-split lib-ws-inner");
    const main = el("div", "lib-ws-main");
    let inspW = 304;
    const splitRight = k.splitter({
      orientation: "vertical",
      label: "Resize component inspector",
      onResize: dx => {
        inspW = Math.max(240, Math.min(480, inspW - dx));
        inner.style.setProperty("--ui-split-insp", Math.round(inspW) + "px");
      }
    });
    const insp = el("aside", "lib-ws-insp pane-scroll");
    insp.setAttribute("aria-label", "Component inspector");

    // Centre toolbar (shared K.toolbar + K.search + K.chips + New actionMenu)
    const searchWrap = k.search({
      placeholder: "Search name, value, package, MPN…",
      label: "Search library workspace",
      value: S.query,
      onInput: val => { cancelIntent(); S.query = val; render(); }
    });
    const chipSym = k.chip("Symbols", {
      pressed: false,
      onToggle: on => { S.kindFilter = on ? "symbol" : "all"; chipFp.setAttribute("aria-pressed", "false"); render(); }
    });
    const chipFp = k.chip("Footprints", {
      pressed: false,
      onToggle: on => { S.kindFilter = on ? "footprint" : "all"; chipSym.setAttribute("aria-pressed", "false"); render(); }
    });
    const newBtn = k.button("New", {title: "Create a symbol, footprint or run a wizard"});
    G.AtriumNavCommon?.actionMenu?.(newBtn, () => [
      // `action` shows the command's key from AtriumKeymap; `run` still opens the editor as a tab.
      {label: "New symbol…", action: "symbol-editor", run: () => api.openSymbolEditor(ctx, null, {asTab: true})},
      {label: "New footprint…", run: () => api.openFootprintEditor(ctx, null, {asTab: true})},
      "-",
      {label: "IPC footprint wizard…", action: "footprint-wizard", run: () => api.openWizard(ctx)},
      {label: "Symbol wizard…", run: () => host.act?.("symbol-wizard")},
      "-",
      {label: "Manage families…", enabled: !S.lib, run: () => G.AtriumLibraryFamiliesUI?.manage(ctx, {initial: S.selected, done: id => { S.selected = id; render(); }})},
      {label: "Check library…", run: () => {
        const lib = S.lib;
        api.checkLibrary(ctx, lib, undefined, {current: () => !closed && S.lib === lib, reveal: id => reveal(project().library.find(d => d.id === id))});
      }}
    ]);
    const toolbar = k.toolbar([searchWrap, "|", k.chips([chipSym, chipFp], "Geometry"), "->", newBtn], {label: "Library tools"});
    toolbar.classList.add("lib-ws-toolbar");

    // Per-facet filter strip (shared .ui-chip buttons opening AtriumLibraryFacetsUI popover + Group select)
    const filterBar = el("div", "lib-ws-filters");
    const facetChips = new Map();
    const facetGroup = k.chips([], "Parameter filters");
    const WS_FACETS = [["package", "Package"], ["value", "Value"], ["mounting", "Mounting"], ["pins", "Pins"], ["tolerance", "Tolerance"], ["voltage", "Voltage"]];
    for (const [fk, label] of WS_FACETS) {
      const btn = el("button", "ui-chip");
      btn.type = "button";
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-expanded", "false");
      btn.append(el("span", "ui-chip-label", label));
      btn.addEventListener("click", () => {
        FACETS()?.togglePopover(btn, {
          key: "workspace",
          onlyFacet: fk,
          title: label,
          getCounts: () => S.lastCounts || {},
          onChange: () => render()
        });
      });
      facetChips.set(fk, {btn, label});
      facetGroup.append(btn);
    }
    function clearFilters() { G.AtriumCatalogue?.clearFacets?.("workspace"); S.query = ""; searchWrap.input.value = ""; S.kindFilter = "all"; chipSym.setAttribute("aria-pressed", "false"); chipFp.setAttribute("aria-pressed", "false"); render(); }
    const clearFiltersBtn = k.button("Clear", {variant: "quiet", size: "sm", run: clearFilters});
    clearFiltersBtn.hidden = true;
    const groupSel = k.select([["category", "Group: Category"], ["family", "Group: Family"], ["none", "Group: None"]], {
      value: S.groupBy, label: "Group components by",
      onChange: val => { S.groupBy = val; render(); }
    });
    groupSel.classList.add("lib-ws-group-select");
    filterBar.append(facetGroup, clearFiltersBtn, el("span", "ui-toolbar-spacer"), groupSel);

    const noticeSlot = el("div", "lib-notice-slot lib-ws-notice");
    noticeSlot.hidden = true;

    // Virtualized sortable .ui-table (AtriumWindowedTable — scales to 36k KiCad parts)
    const tableWrap = el("div", "lib-ws-table-wrap pane-scroll");
    tableWrap.tabIndex = 0;
    const table = el("table", "ui-table lib-ws-table");
    const thead = el("thead"), headRow = el("tr"), tbody = el("tbody");
    const COLS = [
      {key: null, label: "", cls: "lib-ws-col-icons"},
      {key: "name", label: "Name"},
      {key: "value", label: "Value"},
      {key: "pkg", label: "Package"},
      {key: "pins", label: "Pins", num: true},
      {key: "placed", label: "Placed", num: true},
      {key: "status", label: "Status"}
    ];
    const thMap = new Map();
    for (const col of COLS) {
      const th = el("th", col.cls || (col.num ? "is-number" : null), col.label);
      th.scope = "col";
      if (col.key) {
        th.classList.add("lib-ws-sortable");
        th.tabIndex = 0; // Enter or Space sorts, as a click does
        const sort = () => {
          if (S.sortKey === col.key) S.sortDir = -S.sortDir; else { S.sortKey = col.key; S.sortDir = 1; }
          render();
        };
        th.addEventListener("click", sort);
        th.addEventListener("keydown", e => {
          if (e.key !== "Enter" && e.key !== " ") return;
          e.preventDefault(); e.stopPropagation(); sort();
        });
        thMap.set(col.key, th);
      }
      headRow.append(th);
    }
    thead.append(headRow);
    table.append(thead, tbody);
    const emptySlot = el("div", "lib-ws-empty");
    emptySlot.hidden = true;
    tableWrap.append(table, emptySlot);

    const foot = el("footer", "lib-ws-foot");
    const statusLine = k.statusLine("");
    const hintLine = el("span", "lib-ws-hint", "Drag a row onto a split sheet or board to place it");
    foot.append(statusLine, hintLine);

    main.append(toolbar, filterBar, noticeSlot, tableWrap, foot);
    inner.append(main, splitRight, insp);
    root.append(side, splitLeft, inner);
    box.append(root);

    function cancelIntent() { intent++; S.detailRead = null; S.detailBody = null; }
    function selectSource(id) {
      cancelIntent();
      S.source = id || "project";
      S.view = "all";
      S.selected = null;
      render();
      if (S.lib?.unopened) api.folderUI(u => u.restore([S.lib.folder]));
    }

    const addMenuCommands = () => [
      {label: "Open library file…", run: () => api.openLibraryFile(ctx).then(lib => { if (lib) selectSource(lib.id); })},
      {label: "Add library folder…", run: () => api.folderUI(u => u.addFolder(ctx, {started: selectSource, done: () => render()}))},
      {label: "Import library files…", run: () => api.folderUI(u => u.importFiles(ctx, {started: selectSource, done: selectSource}))},
      {label: "Group library…", run: () => api.groupUI(u => u.dialog(ctx, S.lib?.kind === "group" ? S.lib.id : null, {onChoose: id => { if (id) selectSource(id); else render(); }}))},
      "-",
      {label: "Get KiCad libraries…", run: () => api.folderUI(u => u.getKiCad(ctx, {started: selectSource, done: () => render()}))},
      {label: "Library sources…", run: () => api.manageLibraries(ctx, () => render())}
    ];

    function placementCounts(p) {
      const counts = new Map();
      for (const doc of p.documents) {
        for (const item of doc.items) if (item.kind === "part" && item.def) counts.set(item.def, (counts.get(item.def) || 0) + 1);
      }
      for (const def of p.library) if (def.mirrorOf && counts.get(def.id)) counts.set(def.mirrorOf, (counts.get(def.mirrorOf) || 0) + counts.get(def.id));
      const used = new Set([...counts].filter(([, n]) => n).map(([id]) => id));
      for (const variant of Array.isArray(p.variants) ? p.variants : []) {
        for (const value of Object.values(variant.parts || {})) if (value?.alternate?.def) used.add(value.alternate.def);
      }
      return {counts, used};
    }

    function statusOf(def, p) {
      if (!def.libraryRef || !S.libraries.length) return null;
      const st = api.libraryStatus(def, S.libraries, p);
      if (!st || st.pending || st.state === "current") return null;
      return st.missing ? {state: "missing", ref: def.libraryRef} : st;
    }

    // Windowed table row painter
    const windowed = G.AtriumWindowedTable(tableWrap, tbody, () => COLS.length, (tr, entry) => {
      if (entry.type === "group") {
        tr.className = "lib-ws-group";
        const td = el("td");
        td.colSpan = COLS.length;
        td.append(el("strong", null, entry.label), el("span", "ui-row-meta lib-ws-group-count", String(entry.count)));
        tr.append(td);
        return;
      }
      const def = entry.def;
      tr.className = "lib-ws-row";
      tr.dataset.def = def.id;
      tr.draggable = ROWS().dropReceiver();
      tr.setAttribute("aria-selected", String(S.selected === def.id));
      const cIcons = el("td", "lib-ws-col-icons");
      cIcons.append(ROWS().presenceIcons(def));
      const cName = el("td", null, def.name || def.id);
      cName.title = def.name || def.id;
      const cVal = el("td", null, def.value || "—");
      const cPkg = el("td", null, entry.facts.pkg || "—");
      const cPins = el("td", "is-number", entry.facts.pins ? String(entry.facts.pins) : "—");
      const cPlaced = el("td", "is-number", entry.used ? String(entry.used) : "—");
      const cStatus = el("td");
      if (entry.issues) cStatus.append(k.badge(entry.issues + (entry.issues === 1 ? " issue" : " issues"), "warning"));
      else if (entry.status) cStatus.append(k.badge(api.stateText(entry.status), api.STATE_TONE[entry.status.state]));
      else if (def.libraryRef && !S.lib) cStatus.append(k.badge("Current", "success"));
      else if (!S.lib) cStatus.append(k.badge("Local"));
      else if (entry.inProject) cStatus.append(k.badge("In project", "success"));
      tr.append(cIcons, cName, cVal, cPkg, cPins, cPlaced, cStatus);

      tr.addEventListener("click", () => select(def.id));
      tr.addEventListener("dblclick", () => placeEntry(S.lib, def));
      tr.addEventListener("pointerdown", e => ROWS().startDragPlace(e, {
        def, lib: S.lib, row: tr,
        onSelect: d => select(d.id),
        placeEntry, currentKind, info: m => ctx.info?.(m)
      }));
      tr.addEventListener("dragstart", e => {
        const lib = S.lib, drop = G.AtriumDropEditor;
        drop?.offer(e, {kind: "library-part", id: def.id}, lib ? async signal => {
          const full = def.stub ? await G.AtriumLibrarySources.load(lib, def.id) : def;
          return signal.aborted ? null : {lib, def: full};
        } : null);
        e.dataTransfer.effectAllowed = "copy";
        select(def.id);
        G.AtriumSpatialMotion?.lift?.(tr);
      });
      tr.addEventListener("dragend", () => G.AtriumSpatialMotion?.settle?.(tr));
    }, {rowHeight: 24, overscan: 12});

    function select(id) {
      if (S.selected === id) return;
      cancelIntent();
      S.selected = id;
      windowed.refresh();
      renderInspector();
    }

    function renderSidebar(p, placedInfo) {
      side.replaceChildren();
      const projDefs = p.library.filter(d => !d.mirrorOf);
      const placedCount = projDefs.filter(d => placedInfo.used.has(d.id)).length;
      const unusedCount = projDefs.length - placedCount;
      const issuesCount = projDefs.filter(d => {
        const st = statusOf(d, p);
        if (st && ["update", "diverged", "missing"].includes(st.state)) return true;
        const v = api.cachedValidate(d);
        return !v.ok || v.warnings.length;
      }).length;

      const projRows = [
        ["all", "project", "All components", projDefs.length, null],
        ["used", "schematic", "Placed", placedCount, null],
        ["unused", "new", "Unused", unusedCount, null],
        ["issues", "filter", "Needs attention", issuesCount, issuesCount ? k.dot("warning") : null]
      ].map(([v, icon, label, count, dot]) => {
        const meta = el("span", "ui-row-meta lib-badges");
        if (dot) meta.append(dot);
        meta.append(el("span", null, String(count)));
        return k.row({
          title: label, icon, meta,
          selected: S.source === "project" && S.view === v,
          run: () => { cancelIntent(); S.source = "project"; S.view = v; S.selected = null; render(); }
        });
      });
      side.append(k.section("This project", {quiet: true}, k.list(projRows, {label: "Project views"})));

      const addLibBtn = k.iconButton("plus", "Add library", {size: "sm"});
      G.AtriumNavCommon?.actionMenu?.(addLibBtn, addMenuCommands);
      const libRows = S.libraries.map(lib => {
        const meta = el("span", "ui-row-meta lib-badges");
        if (lib.kind === "group") meta.append(k.dot("success", {label: "Synced"}));
        if (lib.scan) meta.append(k.spinner({size: "sm", label: "Indexing"}));
        meta.append(el("span", null, lib.defs.length.toLocaleString("en")));
        return k.row({
          title: lib.name,
          icon: lib.kind === "folder" ? "folder" : "book",
          meta,
          selected: S.source === lib.id,
          run: () => selectSource(lib.id)
        });
      });
      side.append(k.section("Libraries", {quiet: true, actions: [addLibBtn]},
        libRows.length ? k.list(libRows, {label: "Connected libraries"}) : k.empty({text: "No external libraries yet."})));

      const owner = S.lib || p;
      const members = owner.search?.members || G.AtriumComponentFamilies?.memberships(owner);
      const families = members?.size && G.AtriumComponentFamilies ? G.AtriumComponentFamilies.browse(owner, owner.defs || owner.library) : [];
      if (families.length) {
        const famRows = families.map(f => {
          const total = f.parts.reduce((n, pt) => n + pt.options.length, 0);
          return k.row({
            title: f.name, icon: "chip", meta: String(total),
            selected: S.view === "family:" + f.id,
            run: () => { cancelIntent(); S.view = S.view === "family:" + f.id ? "all" : "family:" + f.id; S.selected = null; render(); }
          });
        });
        side.append(k.section("Families", {quiet: true}, k.list(famRows, {label: "Component families"})));
      }
    }

    function renderNotice(p) {
      const focusStop = noticeSlot.contains(document.activeElement) && document.activeElement?.tagName === "BUTTON";
      noticeSlot.replaceChildren();
      noticeSlot.hidden = true;
      if (S.lib) {
        if (S.lib.kind === "folder") G.AtriumLibrarySourcesUI?.sourceNotice(noticeSlot, S.lib, focusStop);
        return;
      }
      const due = p.library.filter(d => !d.mirrorOf && ["update", "diverged"].includes(statusOf(d, p)?.state));
      if (!due.length) return;
      noticeSlot.hidden = false;
      noticeSlot.append(k.notice({
        tone: "warning", live: true,
        text: due.length + " component" + (due.length === 1 ? " has a library update" : "s have library updates"),
        actions: [k.button("Review…", {size: "sm", run: () => reviewUpdates(due.map(d => { const s = statusOf(d, p); return {def: d, lib: s.lib, src: s.src}; }))})]
      }));
    }

    function render() {
      if (closed || !root.isConnected) return;
      watch();
      const p = project();
      S.libraries = allLibs();
      if (S.source !== "project" && !S.libraries.some(l => l.id === S.source)) S.source = "project";
      S.lib = S.source === "project" ? null : S.libraries.find(l => l.id === S.source) || null;
      const owner = S.lib || p;
      const placedInfo = placementCounts(p);
      const members = owner.search?.members || G.AtriumComponentFamilies?.memberships(owner);
      const C = G.AtriumCatalogue;

      renderSidebar(p, placedInfo);
      renderNotice(p);

      // Filter criteria
      const libDefs = owner.defs || owner.library;
      const familyFilterId = S.view.startsWith("family:") ? S.view.slice(7) : null;
      const accept = d => {
        if (S.kindFilter === "symbol" && !d.symbol) return false;
        if (S.kindFilter === "footprint" && !d.footprint) return false;
        if (familyFilterId && members?.get(d.id)?.id !== familyFilterId) return false;
        if (!S.lib) {
          if (S.view === "used" && !placedInfo.used.has(d.id)) return false;
          if (S.view === "unused" && placedInfo.used.has(d.id)) return false;
          if (S.view === "issues") {
            const st = statusOf(d, p);
            const hasSt = st && ["update", "diverged", "missing"].includes(st.state);
            const v = api.cachedValidate(d);
            if (!hasSt && v.ok && !v.warnings.length) return false;
          }
        }
        return true;
      };

      let res;
      if (C && owner.search) {
        res = C.queryPrepared(libDefs, owner.search, S.query, {accept, state: C.state("workspace").facets, limit: 100000, counts: true});
      } else if (C) {
        const subset = libDefs.filter(accept);
        res = C.query(subset, S.query, {ids: new Set(libDefs.map(d => d.id)), keep: d => !S.lib && placedInfo.used.has(d.id), state: C.state("workspace").facets, members});
      } else {
        const subset = (S.query.trim() ? api.search(libDefs, S.query) : libDefs.filter(d => !d.mirrorOf)).filter(accept);
        res = {items: subset, matching: subset.length, counts: {}};
      }

      S.lastCounts = res.counts || {};
      const matching = res.matching ?? res.items.length;
      searchWrap.setCount(matching ? matching.toLocaleString("en") : (S.query.trim() ? "0" : ""));

      // Update per-facet filter chips
      let anyFacet = 0;
      for (const [fk, {btn, label}] of facetChips) {
        const n = FACETS()?.activeCount("workspace", fk) || 0;
        anyFacet += n;
        btn.setAttribute("aria-pressed", String(n > 0));
        btn.querySelector(".ui-chip-label").textContent = FACETS()?.summaryLabel("workspace", fk, label) || label;
      }
      clearFiltersBtn.hidden = !(anyFacet || S.query.trim() || S.kindFilter !== "all");

      // Sort indicators
      for (const [key, th] of thMap) th.setAttribute("aria-sort", S.sortKey !== key ? "none" : S.sortDir > 0 ? "ascending" : "descending");

      // Build virtualized row entries
      const linkedSet = S.lib ? new Set(p.library.filter(d => api.sameLibrary(S.lib, d.libraryRef)).map(d => api.sourceEntry(S.lib, d.libraryRef)?.id || d.libraryRef.id)) : null;
      const entries = res.items.map(def => {
        const f = api.facts(def);
        const used = S.lib ? 0 : (placedInfo.counts.get(def.id) || 0);
        const st = S.lib ? null : statusOf(def, p);
        const issues = !def.stub && (def.footprint || def.symbol) ? api.cachedValidate(def).errors.length : 0;
        const cat = C ? C.record(def).group : (def.category || "Other");
        const fam = members?.get(def.id)?.name || "Ungrouped";
        return {type: "item", def, facts: f, used, status: st, issues, inProject: !!linkedSet?.has(def.id), cat, fam};
      });

      const cmp = (a, b) => {
        const dir = S.sortDir;
        if (S.sortKey === "pins") return ((a.facts.pins || 0) - (b.facts.pins || 0)) * dir;
        if (S.sortKey === "placed") return (a.used - b.used) * dir;
        const va = S.sortKey === "value" ? (a.def.value || "") : S.sortKey === "pkg" ? (a.facts.pkg || "") : S.sortKey === "status" ? (a.status?.state || "") : (a.def.name || "");
        const vb = S.sortKey === "value" ? (b.def.value || "") : S.sortKey === "pkg" ? (b.facts.pkg || "") : S.sortKey === "status" ? (b.status?.state || "") : (b.def.name || "");
        return (C ? C.natural(va, vb) : va.localeCompare(vb)) * dir;
      };

      const flatRows = [];
      if (S.groupBy === "none") {
        entries.sort(cmp);
        flatRows.push(...entries);
      } else {
        const field = S.groupBy === "family" ? "fam" : "cat";
        const buckets = new Map();
        for (const e of entries) {
          if (!buckets.has(e[field])) buckets.set(e[field], []);
          buckets.get(e[field]).push(e);
        }
        const order = C ? [...C.GROUPS.map(x => x[0]), "Other"] : [];
        const keys = [...buckets.keys()].sort((a, b) => {
          if (field === "cat") {
            const ia = order.indexOf(a), ib = order.indexOf(b);
            if (ia >= 0 && ib >= 0) return ia - ib;
            if (ia >= 0) return -1;
            if (ib >= 0) return 1;
          }
          return a.localeCompare(b);
        });
        for (const key of keys) {
          const list = buckets.get(key);
          list.sort(cmp);
          flatRows.push({type: "group", label: key, count: list.length}, ...list);
        }
      }

      S.rows = flatRows;
      S.itemIndex = new Map();
      flatRows.forEach((r, i) => { if (r.type === "item") S.itemIndex.set(r.def.id, i); });
      if (S.selected && !S.itemIndex.has(S.selected)) S.selected = null;

      emptySlot.replaceChildren();
      if (!entries.length) {
        table.hidden = true;
        emptySlot.hidden = false;
        emptySlot.append(k.empty({
          centred: true,
          title: S.lib?.scan ? "Indexing library…" : "No matching components",
          text: S.lib?.scan ? "More components will appear as indexing continues." : "Try adjusting your search or clearing the active filters.",
          actions: clearFiltersBtn.hidden ? [] : [k.button("Clear filters", {run: () => clearFiltersBtn.click()})]
        }));
      } else {
        table.hidden = false;
        emptySlot.hidden = true;
        windowed.refresh(flatRows);
      }

      const placedTotal = entries.filter(e => e.used > 0).length;
      statusLine.querySelector(".ui-status-text").textContent =
        matching.toLocaleString("en") + (matching === 1 ? " component" : " components") +
        (!S.lib ? " · " + placedTotal.toLocaleString("en") + " placed" : "");

      renderInspector();
    }

    function renderInspector() {
      const p = project(), kind = currentKind();
      if (S.lib) {
        const lib = S.lib;
        const rowDef = S.selected && api.sourceEntry(lib, {id: S.selected});
        const def = S.detailBody?.row === rowDef && S.detailBody.lib === lib ? S.detailBody.def : rowDef;
        if (!def) {
          INSP().render(insp, {
            def: null,
            emptyText: "Select a component from the table to inspect or place it.",
            beforeEmpty: hostNode => {
              const title = el("div", "lib-detail-title");
              title.append(el("strong", null, lib.name), el("small", null, (lib.kind === "group" ? "Local group copy" : lib.path || "library file") + " · " + lib.defs.length.toLocaleString("en") + " components"));
              hostNode.append(title);
              if (lib.kind === "folder") api.folderUI(u => u.folderDetail(ctx, hostNode, lib, {done: () => render()}));
            }
          });
          return;
        }
        if (def.stub) {
          INSP().render(insp, {def, lib});
          if (S.detailRead?.row !== rowDef || S.detailRead.lib !== lib) {
            const token = intent, req = S.detailRead = {row: rowDef, lib};
            G.AtriumLibrarySources.load(lib, def.id).then(full => {
              if (closed || token !== intent || S.detailRead !== req) return;
              S.detailRead = null; S.detailBody = {row: rowDef, lib, def: full}; renderInspector();
            }, e => {
              if (closed || token !== intent || S.detailRead !== req) return;
              S.detailRead = null; insp.replaceChildren(k.notice({tone: "danger", text: e.message}));
            });
          }
          return;
        }
        const linked = p.library.filter(d => api.linksEntry(lib, d.libraryRef, def.id));
        let sourceDiffCount = 0;
        if (linked[0]) {
          const changes = api.diffDefs(linked[0], def);
          if (!changes.length && !api.libraryStatus(linked[0], [lib], p)?.same) changes.push("Component metadata changed");
          sourceDiffCount = changes.length;
        }
        INSP().render(insp, {
          def, lib, project: p, facts: api.facts(def), linked, sourceDiffCount,
          tabbed: true, activeTab: S.inspTab, onTab: t => { S.inspTab = t; renderInspector(); },
          currentKind: kind,
          actions: {
            place: knd => placeFromSource(lib, def, knd),
            addToProject: () => ensureFromSource(lib, def),
            reviewUpdate: () => reviewUpdates([{def: linked[0], lib, src: def}])
          }
        });
        return;
      }

      const def = p.library.find(d => d.id === S.selected) || null;
      if (!def) {
        INSP().render(insp, {def: null, emptyText: "Select a component from the table to inspect, edit, or place it."});
        return;
      }
      const status = api.libraryStatus(def, S.libraries, p);
      const older = api.similar(p, def);
      INSP().render(insp, {
        def, project: p, facts: api.facts(def), used: api.usage(p, def.id),
        validation: api.cachedValidate(def),
        family: G.AtriumComponentFamilies?.memberships(p)?.get(def.id),
        status, statusText: status && !status.pending ? api.stateText(status.missing ? {state: "missing", ref: def.libraryRef} : status) : null,
        statusTone: status ? api.STATE_TONE[status.state] : null,
        tabbed: true, activeTab: S.inspTab, onTab: t => { S.inspTab = t; renderInspector(); },
        currentKind: kind,
        onReviewUpdate: status?.src && !status.same ? () => reviewUpdates([{def, lib: status.lib, src: status.src}]) : null,
        actions: {
          place: knd => place(def, knd),
          editSymbol: () => editSelected(def.id, "schematic"),
          editFootprint: () => editSelected(def.id, "pcb"),
          openWizard: () => api.openWizard(ctx, def),
          attachPackage: G.AtriumLibraryFamiliesUI ? variant => {
            const live = project().library.find(d => d.id === def.id);
            if (live) AtriumLibraryFamiliesUI.attach(ctx, live, {variant, done: id => { S.selected = id; render(); }});
          } : null,
          manageFamily: G.AtriumLibraryFamiliesUI ? () => AtriumLibraryFamiliesUI.manage(ctx, {initial: def.id, done: id => { S.selected = id; render(); }}) : null,
          duplicate: () => runEdit(() => { const c = api.duplicate(project(), def); S.selected = c.id; }, "Duplicated " + def.name),
          updateParts: () => {
            const go = ids => runEdit(() => {
              const r = api.updateParts(project(), def, {sources: ids});
              ctx.info?.("Updated " + r.parts + " part(s).");
            }, null);
            if (!older.length) { go([]); return; }
            api.chooseCopies(def, older, go);
          },
          reviewUpdate: () => status?.src && reviewUpdates([{def, lib: status.lib, src: status.src}]),
          saveToLibrary: () => api.saveToLibraryDialog(ctx, def, () => render()),
          saveToFolder: (G.AtriumHost?.chooseLibraryFolder || G.showDirectoryPicker)
            ? () => api.folderUI(u => u.saveToFolder(ctx, def, () => render())) : null,
          remove: () => {
            try { runEdit(() => api.remove(project(), def.id), def.name + " deleted"); S.selected = null; }
            catch (e) { ctx.info?.(e.message); }
          }
        }
      });
    }

    function runEdit(fn, msg) { try { ctx.edit(fn); if (msg) ctx.info?.(msg); render(); } catch (e) { ctx.info?.(e.message); } }
    const kindFor = def => currentKind() === "pcb" && def.footprint ? "pcb" : def.symbol ? "schematic" : "pcb";
    function placeEntry(lib, def, kind = kindFor(def)) { if (lib) placeFromSource(lib, def, kind); else place(def, kind); }
    function place(def, kind) { ROWS().place(ctx, def, kind); }
    function editSelected(id, kind) {
      const def = project().library.find(d => d.id === id);
      if (def && !S.lib) (kind === "pcb" || (!kind && !def.symbol && def.footprint) ? api.openFootprintEditor : api.openSymbolEditor)(ctx, def, {asTab: true});
    }
    // A source read finishes only while the tab still shows what started it (as the dock's guard).
    function guard(lib, placement = false) {
      const token = intent, owner = project(), source = S.source, rev = ctx.revision(), doc = host.doc?.();
      return () => !closed && token === intent && project() === owner && S.source === source &&
        (lib?.kind !== "folder" || G.AtriumLibrarySources?.library(lib.folder) === lib) &&
        (!placement || rev === ctx.revision() && doc === host.doc?.());
    }
    function ensureFromSource(lib, def) {
      if (def.stub) {
        const current = guard(lib, true);
        G.AtriumLibrarySources.load(lib, def.id).then(full => { if (current()) ensureFromSource(lib, full); }, e => { if (current()) ctx.info?.(e.message); });
        return null;
      }
      const p = project(), linked = p.library.find(d => api.linksEntry(lib, d.libraryRef, def.id));
      if (linked) return linked;
      let exact;
      runEdit(() => { exact = api.addFromLibrary(lib, def, p); }, def.name + " added to the project from " + lib.name);
      return exact;
    }
    function placeFromSource(lib, def, kind) {
      if (def.stub) {
        const current = guard(lib, true);
        G.AtriumLibrarySources.load(lib, def.id).then(full => { if (current()) placeFromSource(lib, full, kind); }, e => { if (current()) ctx.info?.(e.message); });
        return;
      }
      if (!Atrium.geometries(def, kind)) return;
      const exact = ensureFromSource(lib, def);
      if (exact) place(exact, kind);
    }
    function reviewUpdates(entries) { return G.AtriumLibraryDockUI.review(ctx, api, entries, {current: guard(null), libs: allLibs, done: () => render()}); }

    // Keyboard navigation on the virtualized table
    tableWrap.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const dir = e.key === "ArrowDown" ? 1 : -1;
        let idx = S.selected != null ? (S.itemIndex.get(S.selected) ?? -1) : -1;
        for (let i = idx + dir; i >= 0 && i < S.rows.length; i += dir) {
          if (S.rows[i].type === "item") {
            select(S.rows[i].def.id);
            windowed.scrollTo(i);
            return;
          }
        }
        return;
      }
      if (!S.selected) return;
      if (e.key === "Enter") {
        e.preventDefault();
        if (S.lib) { const d = S.lib.defs.find(x => x.id === S.selected); if (d) placeFromSource(S.lib, d, currentKind()); }
        else { const d = project().library.find(x => x.id === S.selected); if (d) place(d, currentKind()); }
      } else if (!S.lib && (e.key === "e" || e.key === "E")) {
        e.preventDefault(); editSelected(S.selected, e.shiftKey ? "pcb" : "schematic");
      } else if (!S.lib && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        const d = project().library.find(x => x.id === S.selected);
        if (d) runEdit(() => { S.selected = api.duplicate(project(), d).id; }, "Duplicated " + d.name);
      } else if (!S.lib && (e.key === "Delete" || e.key === "Backspace")) {
        e.preventDefault();
        const d = project().library.find(x => x.id === S.selected);
        if (d) { try { runEdit(() => api.remove(project(), d.id), d.name + " deleted"); S.selected = null; } catch (err) { ctx.info?.(err.message); } }
      }
    });

    const scheduleRender = () => { if (!closed && !checkTimer) checkTimer = setTimeout(() => { checkTimer = 0; render(); }, 0); };
    const offNav = ["change", "document"].map(ev => host?.on?.(ev, scheduleRender));
    const onSources = () => scheduleRender();
    G.addEventListener?.("waffle-library-sources", onSources);
    G.addEventListener?.("storage", onSources);
    // Folder, KiCad and group libraries: watched once their modules load (by this tab or the dock), and
    // restored through the same loaders the dock uses, so the tab lists them when it opens first.
    let offFolders = null, offGroups = null;
    function watch() {
      if (closed) return;
      offFolders ||= G.AtriumLibrarySources?.onChange?.(scheduleRender);
      offGroups ||= G.AtriumGroupLocal?.onChange?.(scheduleRender);
    }

    render();
    api.folderUI(u => { watch(); scheduleRender(); u.restore(project().library.map(d => d.libraryRef?.library).filter(Boolean)); }, true);
    api.restoreGroups(watch);

    // Show a part: its source, no filter that hides it. A built-in part (starter or catalogue) has no source here.
    function reveal(def, source) {
      if (!def) return;
      const {lib, inProject} = ROWS().revealSource("workspace", def, source, {project: project(), libs: allLibs(), api});
      cancelIntent();
      S.source = lib?.id || "project";
      S.view = "all";
      S.selected = def.id;
      clearFilters();
      if (S.lib?.unopened) api.folderUI(u => u.restore([S.lib.folder]));
      const idx = S.itemIndex.get(def.id);
      if (idx != null) windowed.scrollTo(idx);
      else if (!lib && !inProject) ctx.info?.((def.name || def.id) + " is a built-in part. Place it from Quick Place; it is listed here once placed.");
    }

    return {
      reveal,
      showSource(source) { const id = typeof source === "string" ? source : source?.id; if (id && id !== S.source) selectSource(id); },
      focusSearch() { searchWrap.input.focus(); searchWrap.input.select?.(); },
      dispose() {
        closed = true;
        cancelIntent();
        FACETS()?.close();
        G.AtriumCatalogue?.cancelPreview?.(insp);
        clearTimeout(checkTimer);
        offNav.forEach(off => off?.());
        offFolders?.();
        offGroups?.();
        G.removeEventListener?.("waffle-library-sources", onSources);
        G.removeEventListener?.("storage", onSources);
      }
    };
  }

  function open(o = {}) {
    G.AtriumDocViews.open(ID, {
      title: "Library",
      icon: "book",
      mount: box => { instance = mount(box, o); },
      onClose: () => { instance?.dispose(); instance = null; }
    });
    if (o.def) instance?.reveal(o.def, o.source);
    else { if (o.source) instance?.showSource(o.source); instance?.focusSearch(); }
    return instance;
  }

  const close = () => G.AtriumDocViews?.close?.(ID);
  G.addEventListener?.("atrium-host-project", close);
  G.AtriumNavCommon?.ready?.(host => {
    host.registerAction("library-workspace", () => open());
  });

  return Object.freeze({open, close, reveal: (def, source) => open({def, source}), instance: () => instance});
})();
