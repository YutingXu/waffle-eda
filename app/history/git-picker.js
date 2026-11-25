"use strict";
// Git for designs: the revision picker and the Git commands of Project › Git (lazy).
//
//   AtriumGit            the data layer over AtriumHost.gitQuery (native/git_head.py): refs, log, file log,
//                        status, read a revision, merge base, commit-graph lanes, compare two revisions.
//   AtriumGitPicker      pick(o) -> one revision spec; pickPair(o) -> {before, after}; the Compare, Compare
//                        Branches, Changes Since Last Opened and merge-driver commands; onProjectOpened.
//
// A revision spec is plain data:
//   {type:"working"}                       the design in the editor, with unsaved edits
//   {type:"worktree"}                      the project file on disk          (Git)
//   {type:"index"}                         the staged project                (Git)
//   {type:"commit", rev, label}            a commit                          (Git)
//   {type:"ref", kind, name, short, rev}   a branch, remote branch or tag    (Git)
//   {type:"stage", stage}                  base | ours | theirs of a merge conflict (Git)
//   {type:"file", name, project}           a saved Waffle project ZIP the user chose
//   {type:"undo", mark, label}             a state in the current editor's Undo timeline
//   {type:"snapshot", id, slot, label}      a private recovery snapshot
//   {type:"revision", id, label}            a released revision of the active design
// Without Git (the browser build, an unsaved project or a folder outside a repository) the picker offers
// the working design and saved files only: "compare two files".
//
// The page sends allowlisted operations that the native host and git_head.py validate again.
// History reads use read-only plumbing. Commit and merge setup require an explicit action.
// Commit messages, author names and ref names are untrusted text and only ever set textContent.
globalThis.AtriumGit = (() => {
  const G = globalThis;
  const H = () => G.AtriumHost;
  const folder = () => !!H()?.folderGitGrant;
  const binding = () => H()?.folderGitGrant || null;
  const available = () => !!(H()?.gitQuery && binding());
  function bound() {
    const host = H(), grant = binding(), generation = host?.projectGeneration;
    return () => !!grant && host === H() && grant === binding() && generation === host?.projectGeneration;
  }
  const short = id => String(id || "").slice(0, 7);
  const workerURL = new URL("../workers/diff-worker.js", document.currentScript?.src || new URL("history/git-picker.js", document.baseURI)).href;
  let cache;
  function reset() { cache = {refs:null, refsAt:0, ticket:0, current:bound()}; }
  async function q(op, args, options) {
    if (!available()) throw Error("Git history is available in the desktop app for a project saved inside a Git repository.");
    return H().gitQuery(op, args || {}, options);
  }
  async function refs(force) {
    if (!cache?.current()) reset();
    const scope = cache;
    if (!force && scope.refs && Date.now() - scope.refsAt < 15000) return scope.refs;
    const ticket = ++scope.ticket;
    const result = await q("refs");
    if (!scope.current()) throw Error("The active project changed. Open revision review again.");
    if (cache === scope && scope.ticket === ticket) {
      scope.refs = result;
      scope.refsAt = Date.now();
    }
    return result;
  }
  const log = (o = {}) => q("log", clean(o, ["refs", "limit", "skip", "search"]));
  const status = options => q("status",undefined,options);
  const mergeBase = (a, b) => q("mergeBase", {a, b}).then(r => r.base || null);
  function clean(o, keys) { const out = {}; for (const k of keys) if (o[k] != null && o[k] !== "") out[k] = o[k]; return out; }
  async function chooseReference() {
    const reference = await (await G.AtriumLazy.need("AtriumProjectArchiveUI")).chooseReference();
    return reference && {type:"file", ...reference};
  }
  async function folderProject(revision, pinned, active = bound()) {
    const stage = ["index", "base", "ours", "theirs"].includes(revision);
    const bundle = pinned || await q("folderRevisions", stage ? {stage: revision} : {revisions: [revision]});
    if (!active()) throw Error("The active project changed. Open revision review again.");
    if (!bundle.revisions?.some(item => item.revision === revision && item.blob)) throw Error("This project is unavailable in the selected revision.");
    return readFolder({bundle, project:revision}, active);
  }
  async function readFolder(request, active) {
    if (!active()) throw Error("The active project changed. Open revision review again.");
    if (!G.AtriumWorkerPool) await G.AtriumLazy.need("AtriumWorkerPool");
    const worker = G.AtriumWorkerPool.script(workerURL);
    try {
      const result = await new Promise((resolve, reject) => {
        worker.onmessage = e => e.data?.error ? reject(Error(e.data.error)) : resolve(e.data.result?.value);
        worker.onerror = () => reject(Error("The comparison worker could not read the saved revision."));
        worker.postMessage({folder:request});
      });
      if (!active()) throw Error("The active project changed. Open revision review again.");
      return result;
    } finally { worker.terminate(); }
  }
  function specLabel(s) {
    if (!s) return "";
    switch (s.type) {
      case "working": return "Working design";
      case "worktree": return "Saved file (working tree)";
      case "index": return "Staged";
      case "commit": return short(s.rev) + (s.label ? " · " + String(s.label).slice(0, 60) : "");
      case "ref": return (s.kind === "tag" ? "Tag " : s.kind === "remote" ? "Remote " : "Branch ") + (s.short || s.name);
      case "stage": return ({base: "Merge base", ours: "Ours", theirs: "Theirs"})[s.stage] || s.stage;
      case "file": return String(s.name || "File").slice(0, 80);
      case "base": return "Merge base " + short(s.rev);
    }
    return String(s.type);
  }
  // A pending comparison belongs to the file and grant it was started in.
  function readBound(host, active = () => true) {
    const opened = host.project?.(), session = host.fileSession?.();
    const native = H(), projectGeneration = native?.projectGeneration, grant = binding();
    return () => active() && host.project?.() === opened && host.fileSession?.() === session &&
      native === H() && projectGeneration === native?.projectGeneration && grant === binding();
  }
  // After a verified read, open that historical project as a dirty unsaved copy.
  async function openPrivateCopy(host, project, revision, current) {
    project.name = String(project.name || "Untitled") + " (" + short(revision) + ")";
    return host.replaceProject(project, {copy: true, dirty: true, current});
  }
  // {project, label, spec}. host: AtriumNavHost (for the working design).
  async function readSpec(s, host, pinned, active) {
    if (!s) throw Error("Choose a revision.");
    const opened = host.project?.(), session = host.fileSession?.(), current = readBound(host, active);
    const check = () => { if (!current()) throw Error("The active project changed. Open revision review again."); };
    check();
    if (s.type === "working") {
      const project = await host.requireProjectClosure({purpose: "comparison"});
      check();
      return {project, label: "Working design", working: true, spec: s};
    }
    if (s.type === "file") {
      const reference = s.project ? s : await chooseReference();
      check();
      return reference && {project: reference.project, label: specLabel(reference), spec: reference};
    }
    if (s.type === "undo") {
      const mark = s.mark;
      if (!mark || mark.fileSession && mark.fileSession !== session) throw Error("This history step belongs to another file.");
      const U = G.AtriumUndoStore || await G.AtriumLazy.need("AtriumUndoStore");
      check();
      if (s.reviewed ? !U.sinceReview(mark) : !U.timeline(host).has(mark)) throw Error("This undo state has expired.");
      const project = U.project(mark);
      if (!project) throw Error("This undo state has expired.");
      return {project, label:s.label};
    }
    if (s.type === "snapshot") {
      const saved = await G.AtriumAutosave.read(s.id);
      check();
      if (s.slot && saved.meta?.slot !== s.slot) throw Error("This snapshot belongs to another project.");
      return {project:JSON.parse(typeof saved === "string" ? saved : saved.text ?? saved.json), label:s.label, spec:s};
    }
    if (s.type === "revision") {
      const R = G.AtriumRevisions || await G.AtriumLazy.need("AtriumRevisions");
      check();
      return {project:R.designOf(opened, s.id), label:s.label, spec:s};
    }
    if (host.folderProject?.() && s.type === "worktree") {
      const {project, version} = await host.requireProjectClosure({purpose: "comparison", saved: true});
      check();
      return {project, version, label: "Saved folder (working tree)", spec: s};
    }
    const granted = bound();
    const authorized = () => current() && granted();
    const revision = s.type === "worktree" ? "worktree" : s.type === "index" ? "index" : s.type === "stage" ? s.stage :
      s.type === "head" ? (await refs(true)).head : s.rev;
    if (!revision) throw Error("This Git worktree has no HEAD commit.");
    if (!folder()) throw Error("Open a Waffle project folder to compare its Git history.");
    let result;
    if (!pinned && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)) {
      const history = G.AtriumProjectHistoryData || await G.AtriumLazy.need("AtriumProjectHistoryData");
      result = await history.readCommit(G.AtriumGit, revision, {active:authorized});
      if (!result.project) throw Error("This project is unavailable in the selected revision.");
    } else result = await folderProject(revision, pinned, authorized);
    return {...result, label: s.type === "head" ? "HEAD · " + short(revision) : specLabel(s), spec: {...s, rev: revision}};
  }
  async function readStages(conflicts, active = bound()) {
    const bundle = await q("folderRevisions", {stages:["base", "ours", "theirs"]});
    const review = await readFolder({bundle, reviewStages:conflicts}, active);
    if (review.exact) {
      review.versions = conflicts.map(({path, stages}) => {
        const removed = bundle.removedOwners?.[path];
        return {path, removed, stages:bundle.revisions.flatMap(side => {
          const digest = removed?.stages[side.revision] || side.files?.[path];
          return stages.includes(side.revision) && Object.hasOwn(bundle.objects,digest) ?
            [{label:side.revision,data:bundle.objects[digest]}] : [];
        })};
      });
    }
    return review;
  }
  const planRemovedOwner = (resolveOwner, active) => readFolder({resolveOwner}, active);
  function comparisonScope(host, active = () => true) {
    if (!host) return active;
    const revision = host.revision?.(), current = readBound(host, active);
    return () => current() && host.revision?.() === revision;
  }
  let comparison;
  async function openComparison(open, active) {
    comparison?.notice?.close();
    const request = {};
    comparison = request;
    const current = () => comparison === request && active();
    try {
      while (current()) {
        try {
          const viewer = await G.AtriumLazy?.need("AtriumDiffView") || G.AtriumDiffView;
          if (!viewer) throw Error("The comparison viewer could not load.");
          if (!current()) break;
          const result = await open(viewer, current);
          if (result || current()) return result;
          break;
        } catch (error) {
          if (!current()) break;
          if (!G.AtriumShell?.dialog) throw error;
          request.notice = G.AtriumShell.dialog({
            title: "Could not open comparison",
            body: [G.AtriumNavCommon.el("p", "Retry to open the same comparison.")],
            actions: [{label: "Cancel", focus: true}, {label: "Retry", primary: true, default: false}]
          });
          if (await request.notice.done !== "Retry") return null;
          request.notice = null;
        }
      }
      if (comparison === request && !active()) throw Error("The active project changed. Open Compare again.");
      return null;
    } finally {
      if (comparison === request) comparison = null;
    }
  }
  function compare(b, a, options = {}) {
    return openComparison((viewer, active) => viewer.start(b, a, {...options, active}),
      comparisonScope(G.AtriumNavHost, options.active));
  }
  function reviewChanges(host) {
    return openComparison((viewer, active) => viewer.sinceSave(active), comparisonScope(host));
  }
  // Commit-graph lanes for a topologically ordered list. Each row: {lane, before, after, parents}
  // (lane indexes; before/after hold the commit each lane is waiting for, or null when free).
  function lanes(commits) {
    let open = [];
    const rows = [];
    for (const c of commits) {
      let i = open.indexOf(c.revision);
      if (i < 0) { i = open.indexOf(null); if (i < 0) { i = open.length; open.push(null); } }
      const before = open.slice(), joins = [];
      for (let j = 0; j < open.length; j++) if (j !== i && open[j] === c.revision) { joins.push(j); open[j] = null; }
      const parents = c.parents || [];
      open[i] = parents[0] ?? null;
      const to = parents.length ? [i] : [];
      for (const p of parents.slice(1)) {
        let k = open.indexOf(p);
        if (k < 0) { k = open.indexOf(null); if (k < 0) { k = open.length; open.push(null); } open[k] = p; }
        to.push(k);
      }
      while (open.length && open[open.length - 1] === null) open.pop();
      rows.push({lane: i, before, after: open.slice(), joins, to});
    }
    return rows;
  }
  function ago(date) {
    const t = Date.parse(date);
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    if (s < 86400 * 1.5) return "yesterday";
    if (s < 86400 * 14) return Math.round(s / 86400) + " days ago";
    return new Date(t).toISOString().slice(0, 10);
  }
  return Object.freeze({available, bound, q, refs, log, status, mergeBase, chooseReference, specLabel, readSpec, readStages, planRemovedOwner, compare, reviewChanges, readBound, openPrivateCopy, lanes, ago, short, reset});
})();

globalThis.AtriumGitPicker = (() => {
  const G = globalThis, GIT = G.AtriumGit;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  // A ref label is a library badge: branches in the accent tone, tags in info, HEAD in warning, remotes neutral.
  const REF_TONES = {branch: "accent", tag: "info", head: "warning"};
  const refBadge = (text, kind, current) => {
    const b = el("span", text, "ui-badge gp-chip" + (current ? " is-current" : ""));
    if (REF_TONES[kind]) b.dataset.tone = REF_TONES[kind];
    return b;
  };
  const btn = (text, fn, cls, label) => {
    const b = el("button", text, cls); b.type = "button";
    b.classList.add("ui-button");
    if (cls === "is-primary") b.dataset.variant = "primary";
    if (fn) b.onclick = fn;
    if (label) { b.setAttribute("aria-label", label); b.title = label; } return b;
  };
  const SVG = "http://www.w3.org/2000/svg";
  const LANE = 12, ROW = 30, MAX_LANES = 8;
  const PAGE = 150;
  let host = null;

  // ------------------------------------------------------------------ graph cell
  function graphCell(row, width, touches, height = ROW, maxLanes = MAX_LANES) {
    const s = document.createElementNS(SVG, "svg");
    s.setAttribute("class", "gp-graph"); s.setAttribute("width", String(width)); s.setAttribute("height", String(height));
    s.setAttribute("aria-hidden", "true");
    const x = i => Math.min(i, maxLanes - 1) * LANE + LANE / 2, mid = height / 2;
    const line = (x1, y1, x2, y2, lane) => {
      const p = document.createElementNS(SVG, "path");
      p.setAttribute("d", x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
      p.setAttribute("class", "gp-edge gp-lane-" + (lane % 6)); s.append(p);
    };
    row.before.forEach((rev, j) => {
      if (rev == null) return;
      if (j === row.lane || row.joins.includes(j)) line(x(j), 0, x(row.lane), mid, j);
      else if (row.after[j] != null) line(x(j), 0, x(j), height, j);
    });
    for (const k of row.to) line(x(row.lane), mid, x(k), height, k);
    const dot = document.createElementNS(SVG, "circle");
    dot.setAttribute("cx", String(x(row.lane))); dot.setAttribute("cy", String(mid)); dot.setAttribute("r", row.to.length > 1 ? "4.5" : "3.5");
    dot.setAttribute("class", "gp-node gp-lane-" + (row.lane % 6) + (row.to.length > 1 ? " is-merge" : "") + (touches ? " touches" : ""));
    s.append(dot);
    return s;
  }

  // ------------------------------------------------------------------ the picker
  // o: {title, mode:"single"|"pair", before, after, allowWorking, allowFiles, intro, base:true (offer merge-base)}
  // Resolves to a spec (single), {before, after, mergeBase} (pair) or null.
  function open(o = {}) {
    const pair = o.mode === "pair", git = GIT.available();
    return new Promise(resolve => {
      const d = el("dialog", null, "work-dialog ui-dialog gp-dialog"); d.setAttribute("aria-label", o.title || "Choose a revision");
      const head = el("header", null, "gp-head");
      const title = el("h2", o.title || (pair ? "Compare revisions" : "Choose a revision"));
      head.append(title);
      if (o.intro) head.append(el("p", o.intro, "gp-intro"));
      const slots = {before: o.before || (pair ? null : null), after: o.after || (pair ? {type: "working"} : null)};
      let slot = pair ? (slots.before ? "after" : "before") : "before";
      const chips = el("div", null, "gp-slots");
      const chip = {};
      if (pair) {
        for (const [key, label] of [["before", "Before"], ["after", "After"]]) {
          const c = btn("", () => { slot = key; paintSlots(); search.focus(); }, "gp-slot");
          c.dataset.slot = key; chip[key] = c; c.append(el("small", label), el("span", "", "gp-slot-value"));
          chips.append(c);
          if (key === "before") chips.append(btn("⇄", () => { [slots.before, slots.after] = [slots.after, slots.before]; paintSlots(); }, "gp-swap", "Swap before and after"));
        }
      }
      const baseRow = el("label", null, "gp-base");
      const baseBox = el("input", null, "ui-checkbox"); baseBox.type = "checkbox"; baseBox.checked = !!o.base;
      baseRow.append(baseBox, el("span", "Only the changes made on After since it branched from Before (merge base, like git diff A…B)"));
      baseRow.hidden = !pair;
      const search = el("input", null, "gp-search ui-field"); search.type = "search";
      search.placeholder = git ? "Search messages, authors or a commit hash" : "Search";
      search.setAttribute("aria-label", "Search revisions");
      const onlyFile = el("label", null, "gp-only");
      const onlyBox = el("input", null, "ui-checkbox"); onlyBox.type = "checkbox"; onlyBox.checked = !!o.onlyFile;
      onlyFile.append(onlyBox, el("span", "Only commits that changed this file"));
      const tools = el("div", null, "gp-tools"); tools.append(AtriumUI.searchField(search), onlyFile);
      onlyFile.hidden = !git;
      const side = el("nav", null, "gp-side"); side.setAttribute("aria-label", "Revision groups");
      const list = el("div", null, "ui-list gp-list"); list.dataset.layout = "flush"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Revisions"); list.tabIndex = 0;
      const status = el("p", null, "gp-status"); status.setAttribute("role", "status");
      const more = btn("Load more commits", () => loadCommits(true), "gp-more"); more.hidden = true;
      const main = el("div", null, "gp-main"); main.append(list, more);
      const body = el("div", null, "gp-body"); body.append(side, main);
      const ok = btn(pair ? "Compare" : "Choose", finish, "is-primary"), cancel = btn("Cancel", () => d.close());
      const foot = el("div", null, "work-actions ui-dialog-actions gp-foot"); foot.append(status, cancel, ok);
      d.append(head, chips, baseRow, tools, body, foot);
      let refs = null, commits = [], rows = [], cursor = -1, result = null, ticket = 0, more_ = false, refFilter = null, files = [];
      const entries = []; // what the list shows: {spec, node}

      function paintSlots() {
        if (!pair) return;
        for (const key of ["before", "after"]) {
          chip[key].classList.toggle("is-active", key === slot);
          chip[key].setAttribute("aria-pressed", String(key === slot));
          chip[key].querySelector(".gp-slot-value").textContent = slots[key] ? GIT.specLabel(slots[key]) : "Choose…";
        }
        const both = slots.before && slots.after;
        const commitish = s => s && (s.type === "commit" || s.type === "ref");
        baseRow.hidden = !(commitish(slots.before) && commitish(slots.after));
        ok.disabled = !both;
      }
      function assign(spec) {
        if (!pair) { slots.before = spec; ok.disabled = false; return; }
        slots[slot] = spec;
        if (slot === "before" && !o.keepSlot) slot = "after"; else if (slot === "after" && !slots.before) slot = "before";
        paintSlots();
      }
      // Left: pseudo-revisions, branches and tags (a click filters the graph to that ref's history).
      function sideItem(label, meta, spec, cls, onSelect) {
        const b = btn("", () => { if (onSelect) onSelect(); else { assign(spec); if (!pair) finish(); } }, "gp-side-item " + (cls || ""));
        b.append(el("span", label, "gp-side-label")); if (meta) b.append(el("small", meta, "gp-side-meta"));
        b.title = label + (meta ? " · " + meta : "");
        return b;
      }
      function paintSide() {
        side.replaceChildren();
        const group = (title, nodes) => { if (!nodes.length) return; const g = el("div", null, "gp-group"); g.append(el("h3", title), ...nodes); side.append(g); };
        const pseudo = [];
        if (o.allowWorking !== false) pseudo.push(sideItem("Working design", "unsaved edits included", {type: "working"}, "is-pseudo"));
        if (git) {
          pseudo.push(sideItem("Saved file", "working tree on disk", {type: "worktree"}, "is-pseudo"));
          pseudo.push(sideItem("Staged", "the index", {type: "index"}, "is-pseudo"));
        }
        if (o.allowFiles !== false) pseudo.push(sideItem("Saved project ZIP…", git ? "any project ZIP on disk" : "compare two files", {type: "file"}, "is-file", async () => {
          const spec = await chooseFile(); if (spec) { assign(spec); if (!pair) finish(); }
        }));
        for (const f of files) pseudo.push(sideItem(f.name, "chosen file", f, "is-file"));
        group("This design", pseudo);
        if (!refs) return;
        const pick = (r) => ({type: "ref", kind: r.kind, name: r.name, short: r.short, rev: r.revision});
        const refNode = r => {
          const b = sideItem(r.short, r.name === refs.ref ? "current branch" : GIT.ago(r.date), pick(r), "is-" + r.kind);
          b.ondblclick = () => { assign(pick(r)); if (!pair) finish(); };
          b.onclick = () => { assign(pick(r)); if (!pair) { finish(); return; } refFilter = r.name; loadCommits(false); };
          if (r.name === refs.ref) b.classList.add("is-current");
          return b;
        };
        const all = sideItem("All branches", "commit graph", null, "is-all" + (refFilter ? "" : " is-current"), () => { refFilter = null; loadCommits(false); });
        group("History", [all]);
        group("Branches", refs.refs.filter(r => r.kind === "branch").sort((a, b) => (b.name === refs.ref) - (a.name === refs.ref) || String(b.date).localeCompare(String(a.date))).map(refNode));
        group("Remote branches", refs.refs.filter(r => r.kind === "remote").slice(0, 60).map(refNode));
        group("Tags", refs.refs.filter(r => r.kind === "tag").sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 80).map(refNode));
      }
      async function chooseFile() {
        try {
          const spec = await GIT.chooseReference();
          if (!spec) return null;
          files.push(spec); paintSide();
          return spec;
        } catch (e) { status.textContent = e.message; return null; }
      }
      // Right: the commits, newest first, with lanes and the "changed this file" mark.
      function paintList() {
        const keep = cursor;
        list.replaceChildren(); entries.length = 0;
        const searching = !!search.value.trim();
        const shown = onlyBox.checked ? commits.filter(c => c.touches) : commits;
        const graph = !searching && !onlyBox.checked;
        rows = graph ? GIT.lanes(shown) : [];
        const width = Math.min(MAX_LANES, Math.max(1, ...rows.map(r => Math.max(r.lane, ...r.to, r.before.length - 1, r.after.length - 1) + 1))) * LANE;
        const tips = new Map();
        for (const r of refs?.refs || []) { if (!tips.has(r.revision)) tips.set(r.revision, []); tips.get(r.revision).push(r); }
        shown.forEach((c, i) => {
          const spec = {type: "commit", rev: c.revision, label: c.subject};
          const node = el("div", null, "ui-row gp-row" + (c.touches ? " touches" : ""));
          node.setAttribute("role", "option"); node.id = "gp-opt-" + i; node.setAttribute("aria-selected", "false");
          if (graph) node.append(graphCell(rows[i], width, c.touches)); else node.append(el("span", null, "gp-graph-off"));
          // Filled node: the commit changed this file; hollow: it changed other files only.
          if (!graph) { const mark = el("span", c.touches ? "●" : "○", "gp-touch"); mark.title = c.touches ? "Changed this file" : "Did not change this file"; node.append(mark); }
          const text = el("span", null, "gp-text"), line = el("span", null, "gp-line");
          for (const r of tips.get(c.revision) || []) line.append(refBadge(r.short, r.kind, r.name === refs.ref));
          if (c.revision === refs?.head && !tips.get(c.revision)?.some(r => r.name === refs.ref)) line.append(refBadge("HEAD", "head"));
          line.append(el("span", c.subject || "(no message)", "gp-subject"));
          text.append(line, el("span", [c.author, GIT.ago(c.date), GIT.short(c.revision)].filter(Boolean).join(" · "), "ui-row-detail gp-meta"));
          node.append(text);
          node.setAttribute("aria-label", (c.subject || "Commit") + ", " + c.author + ", " + GIT.ago(c.date) + (c.touches ? ", changed this file" : ""));
          node.title = c.revision + "\n" + (c.date || "");
          node.onclick = () => { focusRow(i); assign(spec); };
          node.ondblclick = () => { assign(spec); finish(); };
          list.append(node); entries.push({spec, node});
        });
        if (!shown.length) list.append(el("p", git ? (searching ? "No commits match." : onlyBox.checked ? "No commits changed this file." : "No commits yet.")
          : "Git history appears here for a project saved in a Git repository (desktop app). You can still compare the working design with saved project ZIPs.", "gp-empty"));
        if (keep >= 0 && keep < entries.length) focusRow(keep, true);
      }
      function focusRow(i, quiet) {
        if (cursor >= 0 && entries[cursor]) entries[cursor].node.setAttribute("aria-selected", "false");
        cursor = i; const e = entries[i]; if (!e) return;
        e.node.setAttribute("aria-selected", "true"); list.setAttribute("aria-activedescendant", e.node.id);
        if (!quiet) e.node.scrollIntoView?.({block: "nearest"});
      }
      list.onkeydown = e => {
        if (!entries.length) return;
        const to = ({ArrowDown: Math.min(cursor + 1, entries.length - 1), ArrowUp: Math.max(cursor - 1, 0), Home: 0, End: entries.length - 1,
          PageDown: Math.min(cursor + 10, entries.length - 1), PageUp: Math.max(cursor - 10, 0)})[e.key];
        if (to != null) { e.preventDefault(); focusRow(to); return; }
        if ((e.key === "Enter" || e.key === " ") && entries[cursor]) { e.preventDefault(); assign(entries[cursor].spec); if (e.key === "Enter" && (!pair || (slots.before && slots.after))) finish(); }
      };
      search.onkeydown = e => { if (e.key === "ArrowDown") { e.preventDefault(); list.focus(); focusRow(Math.max(0, cursor)); } else if (e.key === "Enter") { e.preventDefault(); loadCommits(false); } };
      let timer = 0;
      search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => loadCommits(false), 220); };
      onlyBox.onchange = () => paintList();
      async function loadCommits(append) {
        if (!git) { paintList(); return; }
        const id = ++ticket, text = search.value.trim();
        status.textContent = append ? "Reading more commits…" : text ? "Searching…" : "Reading the history…";
        try {
          const r = await GIT.log({refs: refFilter ? [refFilter] : "all", skip: append ? commits.length : 0, limit: PAGE, search: text || undefined});
          if (id !== ticket || !d.open) return;
          commits = append ? commits.concat(r.commits) : r.commits;
          more_ = !!r.more; more.hidden = !more_;
          if (!append) cursor = -1;
          paintList();
          const touching = commits.filter(c => c.touches).length;
          status.textContent = commits.length ? commits.length + (more_ ? "+" : "") + " commits · " + touching + " changed this file" : "";
        } catch (e) { if (id === ticket) status.textContent = e.message; }
      }
      function finish() {
        if (pair) { if (!slots.before || !slots.after) return; result = {before: slots.before, after: slots.after, mergeBase: !baseRow.hidden && baseBox.checked}; }
        else {
          if (!slots.before && entries[cursor]) slots.before = entries[cursor].spec;
          if (!slots.before) return;
          result = slots.before;
        }
        d.close();
      }
      d.addEventListener("keydown", e => {
        if (e.key === "Escape") return;
        if (e.target === d && e.key.length === 1 && !e.metaKey && !e.ctrlKey) search.focus();
      });
      G.AtriumShell.openDialog(d, {title, body, actions: foot, initialFocus: git ? search : list,
        beforeRemove() { ticket++; clearTimeout(timer); }, onClose() { resolve(result); }});
      paintSlots(); paintSide(); paintList();
      ok.disabled = pair ? !(slots.before && slots.after) : false;
      if (git) {
        status.textContent = "Reading branches and tags…";
        GIT.refs().then(r => { if (!d.open) return; refs = r; paintSide(); return loadCommits(false); }, e => { status.textContent = e.message; refs = null; paintSide(); paintList(); });
      } else status.textContent = "Without Git, compare the working design with saved project ZIPs.";
    });
  }
  const pick = o => open({...o, mode: "single"});
  const pickPair = o => open({...o, mode: "pair"});

  // ------------------------------------------------------------------ commands
  const say = m => host?.info?.(m);
  async function compareSpecs(b, a, o = {}) {
    say("Reading " + GIT.specLabel(b) + " and " + GIT.specLabel(a) + "…");
    const active = GIT.readBound(host, o.active);
    let before = await GIT.readSpec(b, host, undefined, active); if (!before) return;
    const after = await GIT.readSpec(a, host, undefined, active); if (!after) return;
    if (o.mergeBase && (b.type === "commit" || b.type === "ref") && (a.type === "commit" || a.type === "ref")) {
      const base = await GIT.mergeBase(b.rev, a.rev);
      if (!base) throw Error("These revisions have no common ancestor.");
      if (base !== b.rev) before = await GIT.readSpec({type: "base", rev: base}, host, undefined, active);
      before.label = "Merge base " + GIT.short(base) + " (" + GIT.specLabel(b) + " … " + GIT.specLabel(a) + ")";
    }
    return GIT.compare(before, after, {...o, active});
  }
  async function comparePick(o = {}) {
    const r = await pickPair({title: o.title || "Compare revisions", before: o.before, after: o.after, base: o.base,
      intro: o.intro || "Pick Before and After: a commit in the graph, a branch or tag, the saved or staged file, the working design or a saved project ZIP."});
    if (r) await compareSpecs(r.before, r.after, {mergeBase: r.mergeBase});
  }
  async function compareBranches() {
    if (!GIT.available()) { await comparePick({title: "Compare two files", intro: "Git branches are available in the desktop app for a project saved in a Git repository. Compare two saved project ZIPs, or one with the working design."}); return; }
    const r = await GIT.refs();
    const current = r.refs.find(x => x.name === r.ref);
    const spec = x => x && {type: "ref", kind: x.kind, name: x.name, short: x.short, rev: x.revision};
    const other = r.refs.find(x => x.kind === "branch" && x.name !== r.ref) || r.refs.find(x => x.kind === "remote");
    await comparePick({title: "Compare branches", before: spec(current), after: spec(other), base: true,
      intro: "Before is the branch you compare against, After the branch with the changes. With the merge base on, you see only what After changed since it branched off (git diff A…B)."});
  }
  // "What changed since I last opened": the commit HEAD was at when this project was last opened here.
  const SEEN_KEY = "atrium.git.seen.v2";
  const store = {get() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || "{}") || {}; } catch { return {}; } },
    set(v) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(v)); } catch { /* private mode */ } }};
  let lastSeen = null, conflictNote = null, observed = null;
  const keyOf = st => typeof st.projectKey === "string" && /^[a-f0-9]{64}$/.test(st.projectKey) ? st.projectKey : null;
  function remember(st, active) {
    const key = keyOf(st);
    if (!key) return null;
    const all = store.get(), prev = all[key];
    if (!observed?.active() || observed.key !== key) {
      lastSeen = prev?.head ? prev : null;
      observed = {active,key};
      if (st.head) {
        const previous = prev?.head && prev.head !== st.head ? {head:prev.head,at:prev.at} : prev?.previous || null;
        all[key] = {head:st.head,at:Date.now(),previous};
        const keys = Object.keys(all);
        if (keys.length > 200) for (const k of keys.sort((a, b) => (all[a].at || 0) - (all[b].at || 0)).slice(0, keys.length - 200)) delete all[k];
        store.set(all);
      }
    }
    return all[key] || null;
  }
  async function onProjectOpened(h) {
    host = h || host || G.AtriumNavHost;
    GIT.reset();
    if (!observed?.active()) lastSeen = conflictNote = null;
    if (!GIT.available()) return null;
    const active = GIT.bound();
    let st;
    try { st = await GIT.status({advisory:true}); } catch { return null; }
    if (!active()) return null;
    remember(st,active);
    conflictNote = st.conflicted ? st : null;
    if (st.conflicted) {
      const text = "This project has Git merge conflicts" + (st.mergeHead ? " (merging " + GIT.short(st.mergeHead) + ")" : "") + ". Project › Git › Resolve Merge Conflicts… shows Base, Ours and Theirs.";
      try { G.AtriumMessages?.update?.("Git", [{class: "Warning", source: "Git", text}]); } catch { /* the toast still says it */ }
      say(text);
    }
    return st;
  }
  async function changesSinceOpened() {
    if (!GIT.available()) { say("Git history is available in the desktop app for a project saved in a Git repository."); return; }
    const active = GIT.bound();
    const st = await GIT.status();
    if (!active()) return;
    if (!st.head) { say("This Git worktree has no HEAD commit."); return; }
    const entry = remember(st,active);
    const previous = observed?.active() && observed.key === keyOf(st) ? lastSeen : null;
    const seen = [entry, previous, entry?.previous].find(value => value?.head && value.head !== st.head);
    if (!seen?.head) {
      say("Nothing new since you last opened this project: HEAD is where it was" + (entry?.at ? " on " + new Date(entry.at).toLocaleString() : "") + ".");
      await compareSpecs({type: "commit", rev: st.head, label: "HEAD"}, {type: "working"}, {active});
      return;
    }
    const before = {type: "commit", rev: seen.head, label: "Last opened " + new Date(seen.at).toLocaleString()};
    await compareSpecs(before, {type: "working"}, {active});
  }
  async function setupMergeDriver() {
    const can = GIT.available();
    const d = el("dialog", null, "work-dialog ui-dialog gp-dialog gp-confirm"); d.setAttribute("aria-label", "Set up the Waffle merge driver");
    const title = el("h2", "Set up the Waffle merge driver"), body = el("div");
    body.append(
      el("p", "Git then uses record IDs to combine independent Waffle edits. Review competing changes in Project › Git › Resolve Merge Conflicts."));
    const ul = el("ul");
    // The exact files (mergeDriverPlan, read-only); Set Up sends the plan back, so it writes only these.
    let plan = null;
    if (can) GIT.q("mergeDriverPlan").then(p => {
      plan = p; ok.disabled = false;
      const attributes = el("li", "Add these entries to " + p.attributes + " (commit this file to share them).");
      attributes.append(el("pre", p.attributeLines.join("\n")));
      ul.replaceChildren(el("li", "Set merge.waffle.name and merge.waffle.driver in " + p.config + " (this clone only)."), attributes);
    }, e => { status.textContent = e.message; ok.hidden = true; cancel.textContent = "Close"; });
    const status = el("p", null, "gp-status"); status.setAttribute("role", "status");
    const ok = btn("Set Up", async () => {
      ok.disabled = true; status.textContent = "Writing the repository settings…";
      try {
        const r = await GIT.q("installMergeDriver", {confirm: true, plan: plan.plan});
        status.textContent = "Done. " + (r.attributeAdded ? ".gitattributes now has the merge entries. " : "") + (r.note || "");
        ok.hidden = true; cancel.textContent = "Close";
      } catch (e) { status.textContent = e.message; ok.disabled = false; }
    }, "is-primary");
    const cancel = btn("Cancel", () => d.close());
    ok.disabled = !plan; // until the plan is read
    if (!can) {
      ok.hidden = true; cancel.textContent = "Close";
      status.textContent = "Open a project saved in a Git repository in the desktop app, or run in a terminal: python3 native/git_head.py --install-merge-driver <repository folder>";
    }
    const foot = el("div", null, "work-actions ui-dialog-actions"); foot.append(status, cancel, ok);
    body.append(ul); d.append(title, body, foot);
    ok.dataset.uiDefault = "false";
    G.AtriumShell.openDialog(d, {title, body, actions: foot, initialFocus: cancel});
  }
  async function commitProject() {
    const active = GIT.bound();
    const preview = await GIT.q("commitPlan");
    if (!active()) return;
    if (!preview.paths.length) {
      say("Stage the project files you want to commit in Git, then open Commit again.");
      return;
    }
    const list = el("div"), branch = el("p", "Branch " + preview.branch.replace(/^refs\/heads\//, ""));
    const description = el("p", "Choose the staged project files to include.");
    const message = el("input", null, "ui-field"), label = el("label", "Commit message", "ui-field-row");
    message.maxLength = 256;
    label.append(message);
    const selections = preview.paths.map(({path, change}) => {
      const row = el("label", null, "ui-checkbox-row"), input = el("input", null, "ui-checkbox");
      input.type = "checkbox";
      row.append(input, el("span", path + " (" + change + ")"));
      list.append(row);
      return {path, input};
    });
    const status = el("p");
    status.setAttribute("role", "status");
    const choose = () => selections.filter(({input}) => input.checked).map(({path}) => path);
    const commit = {label: "Commit", primary: true, default: false, async run() {
      if (!active()) { status.textContent = "The active project changed. Open Commit again."; return false; }
      const paths = choose(), subject = message.value.trim();
      if (!paths.length || paths.length > 256 || !subject) return false;
      try {
        const result = await GIT.q("commitStaged", {confirm: true, message: subject, paths, plan: preview.plan});
        GIT.reset();
        const count = result.paths.length;
        say("Committed " + count + " staged project " + (count === 1 ? "file" : "files") + " as " + GIT.short(result.commit) + ".");
        return true;
      } catch (error) {
        status.textContent = error.message;
        return false;
      }
    }};
    const dialog = G.AtriumShell.dialog({title: "Commit staged project files", body: [branch, description, list, label, status],
      actions: [{label: "Cancel", focus: true}, commit]});
    const button = /** @type {HTMLButtonElement} */ (dialog.querySelector('button[data-variant="primary"]'));
    const update = () => {
      const count = choose().length;
      button.disabled = !count || count > 256 || !message.value.trim();
    };
    list.addEventListener("change", update);
    message.addEventListener("input", update);
    update();
  }
  const run = (fn) => () => Promise.resolve().then(fn).catch(e => say(e.message));
  function attach(h) {
    host = h;
    h.registerAction?.("review-changes", run(() => {
      say("Changes Since Last Save…");
      return GIT.reviewChanges(h);
    }));
    h.registerAction?.("compare-branches", run(compareBranches));
    h.registerAction?.("changes-since-opened", run(changesSinceOpened));
    h.registerAction?.("git-merge-driver", run(setupMergeDriver));
    h.registerAction?.("git-commit", run(commitProject));
  }
  if (typeof document !== "undefined") G.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({open, pick, pickPair, graphCell, comparePick, compareSpecs, compareBranches, changesSinceOpened, setupMergeDriver, onProjectOpened, attach,
    lastSeen: () => observed?.active() ? lastSeen : null, conflicts: () => observed?.active() ? conflictNote : null});
})();
