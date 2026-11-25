"use strict";
// Versioned, local project layout. It stores document identities, never paths or grants.
globalThis.AtriumWindowWorkspace = (() => {
  const version = 1;
  const windowId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
  const orientations = new Set(["right", "down"]);
  const error = (code, message) => Object.assign(Error(message), {code});

  function checkId(value, name) {
    if (typeof value !== "string" || !value || /[\ud800-\udfff]/u.test(value) || (name === "window" && !windowId.test(value)))
      throw error("invalid_layout", `Invalid ${name} identity.`);
    return value;
  }

  function viewport(source) {
    if (source == null) return;
    const {display, left, top, width, height} = source;
    if ((display != null && (typeof display !== "string" || display.length > 128)) ||
        ![left, top, width, height].every(Number.isSafeInteger) || width <= 0 || height <= 0)
      throw error("invalid_layout", "Invalid window bounds.");
    return {display:display ?? null, left, top, width, height};
  }

  function splitView(source, tabs) {
    if (source == null) return;
    const {direction, secondary, ratio} = source;
    if (!orientations.has(direction) || !Number.isFinite(ratio) || ratio <= 0 || ratio >= 1)
      throw error("invalid_layout", "Invalid window split.");
    checkId(secondary, "split document");
    return tabs.includes(secondary) ? {direction, secondary, ratio} : undefined;
  }

  function memberIds(members) {
    const ids = new Set(members.map(member => checkId(member, "project document")));
    if (!ids.size || ids.size !== members.length) throw error("invalid_layout", "A workspace needs distinct project documents.");
    return ids;
  }

  function newWindow(windowId, tabs, active) {
    return {id:checkId(windowId, "window"), tabs:[...tabs], active:tabs.includes(active) ? active : tabs[0]};
  }

  function initial(project, members, windowId, active) {
    checkId(project, "project");
    const tabs = [...memberIds(members)];
    return {version, project, focused:windowId, windows:[newWindow(windowId, tabs, active)]};
  }

  function restore(saved, project, members, fallbackWindow, active, {preserveWriter = false} = {}) {
    checkId(project, "project");
    const remaining = memberIds(members);
    if (saved == null) return {layout:initial(project, members, fallbackWindow, active), missing:[]};
    if (saved.version !== version) throw error("unsupported_layout", "This local workspace has a different version.");
    if (saved.project !== project || !Array.isArray(saved.windows))
      throw error("invalid_layout", "This local workspace belongs to a different project.");

    const windows = [], windowIds = new Set(), seenTabs = new Set(), missing = [];
    let writerBounds;
    for (const entry of saved.windows) {
      const windowId = checkId(entry?.id, "window");
      if (windowIds.has(windowId) || !Array.isArray(entry.tabs)) throw error("invalid_layout", "Invalid workspace window list.");
      windowIds.add(windowId);
      const tabs = [];
      for (const tab of entry.tabs) {
        checkId(tab, "tab");
        if (seenTabs.has(tab)) throw error("invalid_layout", "The same tab has more than one window.");
        seenTabs.add(tab);
        if (remaining.delete(tab)) tabs.push(tab); else missing.push(tab);
      }
      const bounds = viewport(entry.bounds), split = splitView(entry.split, tabs);
      if (windowId === fallbackWindow) writerBounds = bounds;
      if (!tabs.length) continue;
      const window = newWindow(windowId, tabs, entry.active);
      if (bounds) window.bounds = bounds;
      if (split) window.split = split;
      windows.push(window);
    }
    if (!windows.length) return {layout:initial(project, members, fallbackWindow, active), missing};
    if (preserveWriter && !windows.some(row => row.id === fallbackWindow)) {
      const tabs = [...remaining];
      remaining.clear();
      if (!tabs.length) {
        const donor = windows.find(row => row.tabs.length > 1) ?? windows[0];
        const tab = donor.tabs.find(id => id !== donor.active) ?? donor.active;
        tabs.push(tab);
        donor.tabs.splice(donor.tabs.indexOf(tab), 1);
        if (!donor.tabs.length) windows.splice(windows.indexOf(donor), 1);
        if (donor.split?.secondary === tab) delete donor.split;
      }
      const writer = newWindow(fallbackWindow, tabs, active);
      if (writerBounds) writer.bounds = writerBounds;
      windows.unshift(writer);
    }
    const target = windows.find(window => window.id === saved.focused) ?? windows[0];
    target.tabs.push(...remaining);
    return {layout:{version, project, focused:target.id, windows}, missing};
  }

  function plan(layout, command, args = {}) {
    const windows = layout.windows.map(window => ({...window, tabs:[...window.tabs]}));
    const focused = windows.find(window => window.id === layout.focused);
    const source = args.window == null ? focused : windows.find(window => window.id === args.window);
    if (!source) throw error("window_missing", "This project window has closed.");
    const result = {...layout, windows};
    switch (command) {
      case "focus":
        result.focused = source.id;
        break;
      case "move-tab-to-new-window": {
        const tab = args.tab ?? source.active;
        const index = source.tabs.indexOf(tab);
        if (index < 0) throw error("tab_missing", "This tab is not in the selected window.");
        const target = newWindow(args.newWindow, [tab], tab);
        if (windows.some(window => window.id === target.id)) throw error("window_exists", "This project window already exists.");
        source.tabs.splice(index, 1);
        if (source.active === tab) source.active = source.tabs[Math.min(index, source.tabs.length - 1)];
        if (source.split?.secondary === tab) delete source.split;
        windows.push(target);
        if (!source.tabs.length) result.windows = windows.filter(window => window !== source);
        result.focused = target.id;
        break;
      }
      case "merge-all-windows": {
        const merged = windows.flatMap(window => window.tabs);
        result.windows = [{...source, tabs:merged}];
        result.focused = source.id;
        break;
      }
      case "close-window": {
        if (windows.length === 1) throw error("last_window", "The project has only one window.");
        const target = source === focused ? windows.find(window => window !== source) : focused;
        target.tabs.push(...source.tabs);
        result.windows = windows.filter(window => window !== source);
        result.focused = target.id;
        break;
      }
      case "window-view": {
        if (!source.tabs.includes(args.tab)) throw error("tab_missing", "This tab is not in the selected window.");
        source.active = args.tab;
        const bounds = viewport(args.bounds), split = splitView(args.split, source.tabs);
        if (args.bounds === null) delete source.bounds;
        else if (bounds) source.bounds = bounds;
        if (args.split === null) delete source.split;
        else if (split) source.split = split;
        break;
      }
      default:
        throw error("unsupported_command", "Unknown project window command.");
    }
    return result;
  }

  return Object.freeze({initial, restore, plan, version});
})();
