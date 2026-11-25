"use strict";
// Window › List Windows… and tab tear-out for project windows (butter.windows, task 48).
// Everything here is library markup
// (docs/ui-library.md): one compact dialog with two sections (open windows as a tree of
// tabs, saved layouts), one notice for the most severe state, and a status line in the action row.
// Lazy: project-window-client.js registers and loads it once the native host offers windows.
globalThis.AtriumWindowsUI = (() => {
  const G = globalThis, L = G.AtriumLazy;
  const DOCUMENT = "application/x-atrium-document", TABS_SHOWN = 8;
  let open = null, tabsInstalled = false;

  // The real source: the window client and the Butter broker. Tests pass their own with the same shape.
  function liveSource() {
    const client = () => G.AtriumProjectWindowClient, host = () => G.AtriumNavHost;
    return {
      async list() { return (await G.AtriumButter.run("butter.windows.list-windows", {})).result; },
      status: () => client().status(),
      layouts: () => client().layouts(),
      async run(command, args = {}) {
        const editor = await L.need("AtriumButterEditor"), receipt = await editor.apply("butter.windows." + command, args);
        const failure = G.AtriumButter.failure?.(receipt?.result);
        if (failure) throw Object.assign(Error(failure.message), {code:failure.code});
        return receipt?.result;
      },
      returnTabs: args => client().returnTabs(args),
      discardPending: () => client().discardPending(),
      doc: id => host()?.docById(id) ?? null,
      on(listener) {
        G.addEventListener("atrium-window-workspace-status", listener);
        return () => G.removeEventListener("atrium-window-workspace-status", listener);
      }
    };
  }

  const plural = (n, one, many = one + "s") => n + " " + (n === 1 ? one : many);
  const kindIcon = kind => ({pcb:"board", schematic:"schematic", drawing:"drawing", panel:"board"})[kind] || "project";

  // The one notice the dialog shows, most severe first (docs/ui-library.md › Notices).
  function noticeFor(K, status, retry, review) {
    const r = status.recovery;
    if (r?.state === "conflict") return K.notice({tone:"warning", title:"An edit is waiting for review.",
      text:(r.label ? "“" + r.label + "” " : "The last edit ") + "conflicts with a newer change in the main window. It stays pending until you review it.",
      live:true, actions:review ? [K.button("Review…", {size:"sm", run:review})] : []});
    if (status.writer === "unavailable") return K.notice({tone:"warning", title:"The main window is reconnecting.",
      text:"Edits from other windows wait until it is back. Nothing is lost.", live:true});
    if (status.store) return K.notice({tone:"danger", title:"Layouts can’t be saved.", text:status.store.message, live:true,
      actions:[K.button("Try again", {size:"sm", run:retry})]});
    if (r?.state === "replaying") return K.notice({tone:"info", title:"Replaying the last edit…",
      text:r.label ? "“" + r.label + "” from a detached window." : "From a detached window.", live:true});
    if (r?.state === "reattached") return K.notice({tone:"success", title:"Reconnected.",
      text:r.label ? "“" + r.label + "” was applied once." : "Every window shows the current project.", live:true});
    return null;
  }

  function render(state) {
    const {K, source, body, say} = state, {layout, missing, status, layouts} = state.data;
    const writer = status.writerWindow ? status.window : layout.windows[0]?.id;
    const busy = state.busy, loading = new Set(status.loading);
    const act = (label, work) => async () => {
      if (state.busy) return;
      state.busy = true; say(label + "…", {busy:true}); paint();
      try { const note = await work(); say(typeof note === "string" ? note : ""); }
      catch (error) { say(error.message, {tone:"danger"}); }
      finally { state.busy = false; await refresh(state); }
    };
    const paint = () => render(state);
    const nodes = [];
    const review = source.discardPending && (() => reviewPending(state));
    const notice = noticeFor(K, status, act("Saving layouts", () => source.run("save-workspace-layout", {name:layouts.find(l => l.active)?.name || "Last layout"})), review);
    if (notice) nodes.push(notice);

    // Open windows: a tree of windows and their tabs.
    const rows = [];
    layout.windows.forEach((win, index) => {
      const main = win.id === writer, first = source.doc(win.active), pending = loading.has(win.id);
      const names = win.tabs.map(id => source.doc(id)?.name).filter(Boolean);
      const expanded = state.expanded.has(win.id);
      const detail = pending ? "Opening…" : main && status.writer === "unavailable" ? "Reconnecting…"
        : [plural(win.tabs.length, "tab"), names.slice(0, 3).join(", ") + (names.length > 3 ? " +" + (names.length - 3) : "")].filter(Boolean).join(" · ");
      const meta = pending ? K.spinner({size:"sm", label:"Opening window"}) : K.el?.("span") ?? document.createElement("span");
      if (!pending) { meta.className = "ui-row-meta"; meta.textContent = win.bounds?.display || ""; }
      const actions = main ? [] : [K.button("Return", {variant:"quiet", size:"sm", disabled:busy || pending,
        title:"Move these tabs back to the main window", run:act("Returning tabs", () => source.returnTabs({window:win.id}))})];
      const row = K.row({title:main ? "Main window" : "Window " + (index + 1), detail, icon:kindIcon(first?.kind),
        meta, actions, current:win.id === layout.focused, expanded, state:pending ? "pending" : undefined, role:"treeitem"});
      row.dataset.window = win.id;
      row.addEventListener("click", event => {
        if (event.target.closest("button")) return;
        if (expanded) state.expanded.delete(win.id); else state.expanded.add(win.id);
        paint();
      });
      rows.push(row);
      if (!expanded) return;
      const limit = state.all.has(win.id) ? win.tabs.length : TABS_SHOWN;
      for (const id of win.tabs.slice(0, limit)) {
        const d = source.doc(id), alone = win.tabs.length === 1;
        const move = K.button("New window", {variant:"quiet", size:"sm", disabled:busy || alone || pending,
          title:alone ? "This tab already has its own window" : "Move this tab to a new window",
          run:act("Opening a new window", () => source.run("move-tab-to-new-window", {tab:id}))});
        const tab = K.row({title:d?.name ?? "Missing document", icon:kindIcon(d?.kind), depth:1, actions:[move],
          meta:id === win.active ? "Showing" : undefined, state:d ? undefined : "broken", role:"treeitem"});
        tab.dataset.tab = id;
        rows.push(tab);
      }
      if (win.tabs.length > limit) {
        const more = K.row({title:"Show " + plural(win.tabs.length - limit, "more tab"), depth:1, role:"treeitem",
          run:() => { state.all.add(win.id); paint(); }});
        more.setAttribute("role", "treeitem");
        rows.push(more);
      }
    });
    const merge = K.button("Merge all", {variant:"quiet", size:"sm", disabled:busy || layout.windows.length < 2,
      title:"Gather every tab into the main window", run:act("Merging windows", () => source.run("merge-all-windows"))});
    const windowsList = K.list(rows, {label:"Open windows", role:"tree"});
    nodes.push(K.section("Open windows", {actions:[K.count(layout.windows.length), merge],
      note:missing?.length ? plural(missing.length, "tab") + " from the last session no longer exist in the project." : undefined}, windowsList));

    // Saved layouts.
    const saveRow = () => {
      const existing = new Set(layouts.map(l => l.name));
      const input = K.field({label:"Layout name", placeholder:"Layout name", value:state.draft ?? ""});
      const field = input.matches("input") ? input : input.querySelector("input");
      const save = K.button("Save", {size:"sm", disabled:busy, run:() => submit()});
      const cancel = K.button("Cancel", {variant:"quiet", size:"sm", run:() => { state.draft = null; paint(); }});
      const sync = () => {
        const name = field.value.trim();
        save.textContent = existing.has(name) ? "Replace" : "Save";
        save.disabled = busy || !name;
        state.draft = field.value;
      };
      const submit = () => {
        const name = field.value.trim();
        if (!name) return;
        state.draft = null;
        act("Saving " + name, () => source.run("save-workspace-layout", {name}))();
      };
      field.addEventListener("input", sync);
      field.addEventListener("keydown", event => {
        if (event.key === "Enter") { event.preventDefault(); submit(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); state.draft = null; paint(); }
      });
      sync();
      const line = K.el?.("div") ?? document.createElement("div");
      line.className = "ui-toolbar win-save";
      line.setAttribute("role", "group"); line.setAttribute("aria-label", "Save layout");
      line.append(input, save, cancel);
      queueMicrotask(() => field.focus());
      return line;
    };
    const layoutRows = layouts.map(entry => {
      const detail = [plural(entry.windows, "window"), entry.displays.join(", ")].filter(Boolean).join(" · ");
      const meta = entry.missing.length ? K.badge(plural(entry.missing.length, "document") + " missing", "warning")
        : entry.missingDisplays?.length ? K.badge("Display unavailable", "warning") : entry.active ? K.badge("Current") : null;
      const restore = K.button("Restore", {variant:"quiet", size:"sm", disabled:busy || !!status.store,
        title:entry.missing.length ? "Restore; missing documents are left out" : "Restore these windows",
        run:act("Restoring " + entry.name, async () => {
          const result = await source.run("restore-workspace-layout", {name:entry.name});
          if (result?.missing?.length) return plural(result.missing.length, "document") + " no longer in the project " + (result.missing.length === 1 ? "was" : "were") + " left out.";
        })});
      const row = K.row({title:entry.name, detail, meta, actions:[restore]});
      row.dataset.layout = entry.name;
      return row;
    });
    const saveAction = K.button("Save layout…", {variant:"quiet", size:"sm", disabled:busy || !!status.store || state.draft != null,
      run:() => { state.draft = ""; paint(); }});
    const layoutBody = layouts.length ? [K.list(layoutRows, {label:"Saved layouts"})]
      : state.draft == null ? [K.empty({text:"No saved layouts. Save the current windows to bring them back later."})] : [];
    if (state.draft != null) layoutBody.unshift(saveRow());
    nodes.push(K.section("Saved layouts", {actions:[saveAction]}, ...layoutBody));
    body.replaceChildren(...nodes);
    keyboard(body);
  }

  // The pending edit a restarted writer could not replay: say what it was and why, keep or discard it.
  async function reviewPending(state) {
    const {K, source} = state, r = source.status().recovery ?? {};
    const body = [K.propRow("Edit", r.label || "Edit in another window"), K.propRow("Reason", r.message || "The project changed after this edit was made.")];
    const sheet = G.AtriumShell.dialog({title:"Pending edit", label:"Pending edit", body, actions:[
      {label:"Discard edit", variant:"danger", run:async () => { await source.discardPending(); await refresh(state); }},
      {label:"Keep pending", primary:true, default:true, focus:true}]});
    sheet.showModal();
    return sheet.done;
  }

  // Arrow keys move through each list's rows; Left and Right fold a window (WAI-ARIA tree).
  function keyboard(root) {
    for (const list of root.querySelectorAll(".ui-list")) {
      const rows = [...list.querySelectorAll(".ui-row")];
      rows.forEach((row, i) => { row.tabIndex = i === 0 ? 0 : -1; });
      list.onkeydown = event => {
        const at = rows.indexOf(event.target.closest(".ui-row"));
        if (at < 0 || event.target.closest("button:not(.ui-row)")) return;
        const go = {ArrowDown:at + 1, ArrowUp:at - 1, Home:0, End:rows.length - 1}[event.key];
        if (go != null) { event.preventDefault(); rows[Math.max(0, Math.min(rows.length - 1, go))].focus(); return; }
        const row = rows[at];
        if ((event.key === "ArrowRight" && row.getAttribute("aria-expanded") === "false") ||
            (event.key === "ArrowLeft" && row.getAttribute("aria-expanded") === "true") || event.key === "Enter" && row.dataset.window) {
          event.preventDefault();
          const id = row.dataset.window;
          row.click();
          root.querySelector(`[data-window="${id}"]`)?.focus();
        }
      };
    }
  }

  async function refresh(state) {
    const {source} = state;
    try {
      const [list, layouts] = await Promise.all([source.list(), source.layouts()]);
      state.data = {...list, status:source.status(), layouts};
    } catch (error) {
      state.data ??= {layout:{windows:[]}, missing:[], status:source.status(), layouts:[]};
      state.say(error.message, {tone:"danger"});
    }
    if (state.dialog.open) render(state);
  }

  async function show({source = liveSource()} = {}) {
    if (open?.dialog.open) { await refresh(open); open.dialog.focus(); return open.dialog; }
    const K = await L.need("AtriumUIKit");
    const body = document.createElement("div");
    body.className = "win-body";
    const dialog = G.AtriumShell.dialog({title:"Windows", label:"Windows", className:"win-dialog", body:[body],
      actions:[{label:"Done", primary:true, default:true}], onClose:() => { off?.(); if (open?.dialog === dialog) open = null; }});
    const status = document.createElement("span");
    status.className = "ui-dialog-status";
    status.setAttribute("role", "status");
    dialog.querySelector(".work-actions")?.prepend(status);
    const say = (text, {tone, busy} = {}) => {
      status.replaceChildren();
      if (busy) status.append(K.spinner({size:"sm", label:text}), " ");
      status.append(text);
      status.title = text;
      if (tone) status.dataset.tone = tone; else delete status.dataset.tone;
    };
    const state = open = {K, source, body, dialog, say, busy:false, expanded:new Set(), all:new Set(), draft:null, data:null};
    const off = source.on?.(() => { if (dialog.open && !state.busy) refresh(state); });
    await refresh(state);
    const first = state.data?.layout.windows.find(w => w.id === state.data.layout.focused);
    if (first && state.data.layout.windows.length <= 3) { state.expanded.add(first.id); render(state); }
    if (!dialog.open) dialog.showModal();
    return dialog;
  }

  const leftWindow = e => e.clientX <= 0 || e.clientY <= 0 || e.clientX >= G.innerWidth || e.clientY >= G.innerHeight;

  // Chrome-style tabs: drag a document tab out of the window to give it its own window, and drop a
  // detached tab on the main window's strip to bring it back. The strip keeps its settled drop face.
  function installTabs({source = liveSource()} = {}) {
    if (tabsInstalled) return;
    tabsInstalled = true;
    const enabled = () => G.AtriumPrefs?.get("butter.windows") === true;
    let local = null, outside = false;
    document.addEventListener("dragstart", event => {
      local = event.target.closest?.("#document-tabs .document-tab[data-tab]")?.dataset.tab ?? null;
      outside = false;
    }, true);
    // WebKit and Chromium often leave relatedTarget null between elements, so the window edge decides.
    document.addEventListener("dragleave", event => { if (local) outside = leftWindow(event); }, true);
    document.addEventListener("dragover", () => { outside = false; }, true);
    document.addEventListener("dragend", event => {
      const tab = local;
      local = null;
      if (!tab || !enabled() || !outside || event.dataTransfer?.dropEffect !== "none") return;
      outside = false;
      source.run("move-tab-to-new-window", {tab}).catch(error => G.AtriumNavHost?.info(error.message));
    }, true);
    const strip = () => document.getElementById("document-tabs");
    const foreign = event => !local && enabled() && [...(event.dataTransfer?.types ?? [])].includes(DOCUMENT) &&
      source.status().writerWindow && event.target.closest?.("#document-tabs");
    const mark = on => G.AtriumSpatialMotion?.target(strip(), on, "ui-tab-drop");
    document.addEventListener("dragover", event => {
      if (!foreign(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      mark(true);
    }, true);
    document.addEventListener("dragleave", event => {
      if (local) return;
      const box = strip()?.getBoundingClientRect();
      if (!box || event.clientX < box.left || event.clientX >= box.right || event.clientY < box.top || event.clientY >= box.bottom) mark(false);
    }, true);
    document.addEventListener("drop", event => {
      if (!foreign(event)) return;
      event.preventDefault();
      event.stopPropagation();
      mark(false);
      const tab = event.dataTransfer.getData(DOCUMENT);
      if (tab) source.returnTabs({tab}).catch(error => G.AtriumNavHost?.info(error.message));
    }, true);
  }

  return Object.freeze({open:show, installTabs, liveSource});
})();
