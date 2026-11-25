"use strict";
// History commands, quick access, branch status and the first Git log page.
globalThis.AtriumHistoryEntry = (() => {
  const G = globalThis, L = () => G.AtriumLazy;
  // The proposed icons (history, branch, more) live with the commit graph until the icon bank takes them.
  const icons = () => G.AtriumCommitGraph?.icons();
  let host = null, button = null, status = null, branch = "", dirty = false, refsTicket = 0, request = 0;
  function open(options = {}) {
    if (!host) return;
    const context = bound(), project = host.project(), session = host.fileSession?.(), mine = ++request;
    const current = () => mine === request && host.project() === project && session === host.fileSession?.() && sameBinding(context, bound());
    async function load() {
      const view = await L().need("AtriumHistoryView");
      if (current()) await view.open(options, current);
    }
    return load().catch(async error => {
      if (!current()) return;
      const retry = {label: "Try again", primary: true, run: async () => {
        if (!current()) return;
        try { await load(); } catch (failure) {
          message.textContent = failure.message;
          return false;
        }
      }};
      const message = document.createElement("p");
      message.setAttribute("role", "alert");
      message.textContent = error.message;
      G.AtriumUI.dialog({title:"History could not open", body:[message], actions:[{label:"Close"}, retry]});
    });
  }
  function targetFor(doc, item) {
    return {docId:doc.id, item, label:item.ref || item.name || item.text || item.kind};
  }
  function openObject() {
    const doc = host.doc(), id = host.selection()[0], item = doc?.items?.find(i => i.id === id);
    const net = host.highlight?.();
    if (item) return open({target:targetFor(doc, item)});
    if (net) return open({target:{net, label:"Net " + net}});
    host.info?.("Select a part, net or track to see its history.");
  }
  function shortcut() {
    const K = G.AtriumKeymap, C = G.AtriumNavCommon;
    if (button && C?.shortcutTitle) C.shortcutTitle(button, "History", K?.hintKey?.("history", document.body.dataset.kind));
  }
  function paintStatus() {
    if (!status) return;
    const label = status.querySelector(".hv-status-label"), dot = status.querySelector(".ui-dot");
    status.querySelector("use").setAttribute("href", branch ? "#i-branch" : "#i-history");
    label.textContent = branch || "History";
    dot.hidden = !dirty;
    const what = (branch ? "On branch " + branch : "History") + (dirty ? ", unsaved changes" : "");
    status.setAttribute("aria-label", what + ". Open History");
    status.title = what;
  }
  function sync(next = !!host?.isDirty?.()) {
    if (next !== dirty) { dirty = next; paintStatus(); }
  }
  async function readBranch() {
    const ticket = ++refsTicket, H = G.AtriumHost;
    if (!H?.folderGitGrant || !H.gitQuery) { branch = ""; paintStatus(); return; }
    try {
      if (!G.AtriumGit) await L().need("AtriumGitPicker");
      if (ticket !== refsTicket) return;
      const r = await G.AtriumGit.refs(true);
      if (ticket !== refsTicket) return;
      branch = r.ref ? r.ref.replace(/^refs\/heads\//, "") : r.head ? "Detached " + G.AtriumGit.short(r.head) : "";
    } catch { if (ticket === refsTicket) branch = ""; }
    paintStatus();
  }
  // The first page of the log, read at idle after a project opens so History paints its rows at once.
  // Bound to the folder grant and project generation; History replaces it with every fresh read.
  let logCache = null, prefetchTimer = 0, prefetchTicket = 0;
  const bound = () => ({native:G.AtriumHost, grant:G.AtriumHost?.folderGitGrant || null,
    path:G.AtriumHost?.historyPath, generation:G.AtriumHost?.projectGeneration});
  const sameBinding = (a, b) => a.native === b.native && a.grant === b.grant && a.path === b.path && a.generation === b.generation;
  function rememberLog(r, all = true) { if (all && r?.commits) logCache = {...bound(), r}; }
  function cachedLog() {
    const b = bound();
    return logCache && b.grant && sameBinding(logCache, b) ? logCache.r : null;
  }
  function prefetch() {
    clearTimeout(prefetchTimer);
    const ticket = ++prefetchTicket;
    prefetchTimer = setTimeout(() => (G.requestIdleCallback || (f => f()))(async () => {
      const H = G.AtriumHost, b = bound();
      if (ticket !== prefetchTicket || !H?.folderGitGrant || !H.gitQuery || cachedLog()) return;
      try {
        if (!G.AtriumGit) await L().need("AtriumGitPicker");
        if (ticket !== prefetchTicket) return;
        const r = await G.AtriumGit.q("projectLog", {limit: 200});
        const now = bound();
        if (sameBinding(now, b)) rememberLog(r);
      } catch { /* History reads the log itself when it opens */ }
    }, {timeout: 3000}), 400);
  }
  function install(h) {
    if (host) return;
    host = h;
    icons();
    const redo = document.querySelector('.quick-access [data-action="redo"]');
    if (redo) {
      const chrome = G.AtriumNavCommon;
      button = chrome.elWithAttributes("button", null, "command-link hv-entry ui-chrome-action", {
        type:"button", "data-action":"history", "aria-label":"History", "data-hover":"raised"
      });
      button.append(chrome.icon("history")); redo.after(button); shortcut();
    }
    const right = document.querySelector(".statusbar .status-right");
    if (right) {
      status = document.createElement("button");
      status.type = "button"; status.className = "status-action hv-status"; status.dataset.action = "history-working";
      const dot = document.createElement("span"); dot.className = "ui-dot"; dot.dataset.tone = "accent"; dot.hidden = true;
      const label = document.createElement("span"); label.className = "hv-status-label";
      status.append(G.AtriumNavCommon.icon("history"), label, dot);
      right.prepend(status); paintStatus();
    }
    for (const id of ["history", "project-history"]) h.registerAction?.(id, () => open());
    h.registerAction?.("history-working", () => open({select:"working"}));
    h.registerAction?.("file-history", () => open({file:true}));
    for (const id of ["history-object", "object-history"]) h.registerAction?.(id, openObject);
    G.AtriumKeymap?.onChange?.(shortcut);
    let lastBinding = bound();
    const onProject = event => {
      const context = bound();
      if (!event && sameBinding(context, lastBinding)) return;
      lastBinding = context;
      logCache = null;
      if (event?.detail?.fromSave) {
        refsTicket++; prefetchTicket++; clearTimeout(prefetchTimer);
        branch = ""; sync(); paintStatus(); return;
      }
      readBranch(); sync(); prefetch();
    };
    G.addEventListener("atrium-host-project", onProject);
    G.addEventListener("atrium-git-binding", onProject);
    G.addEventListener("focus", readBranch);
    h.on?.("replace", () => onProject());
    h.on?.("dirty", next => sync(!!next));
    dirty = !!h.isDirty?.(); readBranch(); prefetch();
  }
  G.AtriumNavCommon?.ready?.(install);
  return Object.freeze({open, targetFor, cachedLog, rememberLog, status: () => ({branch, dirty, installed: !!button})});
})();
