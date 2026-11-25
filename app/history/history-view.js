"use strict";
// History: one surface for everything that happened to
// the design, newest first. A read-only document tab beside the documents, like Project History was.
//
//   Now        the working design (unsaved state), with this session's undo steps folded under it
//   Local      autosaves, saves, checkpoints and board revisions kept in this project, folded
//   Commits    the Git history of every branch, with commit-graph lanes, refs, authors and times
//
// One list, one selection, one details pane. The list is virtual (only rows in view exist) and the
// graph is one canvas (ui/commit-graph.js). Git is read in pages: a small first page paints at once,
// the rest loads at idle. Design summaries (project-history-data.js, worker) are read for the selected
// commit first, then for rows in view while the list is still. Compare opens the visual diff; Restore
// as copy opens the revision as a new unsaved project; nothing here writes the project or the repository
// except Create branch, which asks first.
//
// Engines: AtriumProjectHistoryData (log, summaries, Compare), AtriumSourceHistory (revisions for
// Restore as copy), AtriumBlame.sourceHistory (object and net filters), AtriumUndoStore and
// AtriumHistoryPanel.label (undo steps), AtriumAutosave (snapshots), AtriumRevisions (board revisions).
// Commit messages, author names and ref names are untrusted text and only ever set textContent.
globalThis.AtriumHistoryView = (() => {
  const G = globalThis, ID = "history", FIRST = 200, PAGE = 1000, FILE_PAGE = 100, CAP = 20000;
  const SEVERITY = {electrical: "danger", mechanical: "warning", cosmetic: null};
  const GROUPS = [["part", "Components"], ["net", "Nets"], ["track", "Tracks"], ["arc", "Tracks"], ["via", "Vias"], ["pad", "Pads"],
    ["wire", "Wires"], ["polygon", "Pours"], ["pour", "Pours"], ["document", "Documents"], ["library", "Library"], ["rule", "Rules"]];
  const GROUP = new Map(GROUPS);
  const REF_TONE = {branch: "accent", tag: "info", head: "warning"};
  let instance = null;
  const perf = {open: 0, shell: 0, firstRows: 0, rows: 0, renders: [], longest: 0, cached: false};
  const now = () => performance.now();

  // ------------------------------------------------------------------ small helpers
  function hash(s) { let h = 2166136261; s = String(s || ""); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
  const hueOf = name => hash(String(name).toLowerCase()) % 5;
  function initials(name) {
    const words = String(name || "?").replace(/[<>@].*$/, "").trim().split(/[\s._-]+/).filter(Boolean);
    return ((words[0]?.[0] || "?") + (words.length > 1 ? words[words.length - 1][0] : "")).toUpperCase();
  }
  const ago = d => G.AtriumGit?.ago?.(d) || "";
  function exact(d) {
    const t = typeof d === "number" ? d : Date.parse(d);
    if (!Number.isFinite(t)) return "";
    return new Date(t).toLocaleString([], {year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"});
  }
  function agoTs(t) { return t ? ago(new Date(t).toISOString()) : ""; }
  const plural = (n, w, p = w + "s") => n.toLocaleString() + " " + (n === 1 ? w : p);
  async function copy(text) {
    try { if (!navigator.clipboard?.writeText) throw Error(); await navigator.clipboard.writeText(text); return true; }
    catch {
      const t = document.createElement("textarea"); t.value = text; t.className = "hv-offscreen"; document.body.append(t); t.select();
      let ok = false; try { ok = document.execCommand?.("copy") === true; } catch { /* no clipboard */ } t.remove(); return ok;
    }
  }
  function parseQuery(text) {
    const out = {text: "", author: "", object: "", net: ""}, rest = [];
    for (const part of String(text || "").match(/(?:[^\s"]|"(?:\\.|[^"\\])*")+/g) || []) {
      const m = /^(author|by|object|part|net):(.*)$/i.exec(part);
      if (!m) { rest.push(part); continue; }
      const k = m[1].toLowerCase();
      let value = m[2];
      if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { /* unfinished query */ } }
      out[k === "by" ? "author" : k === "part" ? "object" : k] = value;
    }
    out.text = rest.join(" ").toLowerCase(); out.author = out.author.toLowerCase();
    return out;
  }

  // ------------------------------------------------------------------ the view
  function mount(box, initial) {
    const K = G.AtriumUIKit, CG = G.AtriumCommitGraph, host = G.AtriumNavHost, git = G.AtriumGit;
    const el = K.el;
    const source = G.AtriumProjectHistoryData.source(git), project0 = host.project();
    const available = source.available();
    let closed = false, rowH = 24, commits = [], refs = new Map(), head = null, headRef = null, snapshot = null, more = false;
    let loading = false, loadError = null, stale = false, ticket = 0, idleLoad = 0, branchMode = "all";
    if (initial.file) branchMode = "file";
    let fileReader = null, checked = 0, logRequested = false, objectError = null, objectResult = null;
    let edits = [], snapshots = [], items = [], rows = [], keyIndex = new Map(), graphW = 18;
    let sel = "working", mark = null, query = parseQuery(""), objectScan = null, objectFields = new Map(), objectTarget = null;
    const kinds = {edits: true, snapshots: true, commits: true};
    const expanded = new Set();
    const summaries = new Map(), full = new Map();
    let summaryTask = null, detailTask = null, scrollIdle = 0, frame = 0, still = true;
    const mounted = new Map(); // key -> row element
    // The view's own root inside the document view (doc-views.css owns the box's placement).
    const root = el("div", "hv-view"); box.append(root);

    // ---------------------------------------------------------------- chrome
    const searchBox = K.search({placeholder: "Filter: message, hash, author:, object:, net:", label: "Filter history",
      onInput: () => { clearTimeout(searchBox.timer); searchBox.timer = setTimeout(() => setQuery(searchBox.input.value), 120); }});
    searchBox.classList.add("hv-search");
    const branchSelect = K.select([["all", "All branches"], ["current", "Current branch"], ["file", "This file"]], {value: branchMode, label: "Branches and file",
      onChange: mode => setBranchMode(mode)});
    branchSelect.classList.add("hv-branches");
    const chipEdits = K.chip("Edits", {pressed: true, title: "Undo steps of this session", onToggle: on => { kinds.edits = on; rebuild(); }});
    const chipSnaps = K.chip("Snapshots", {pressed: true, title: "Autosaves, saves, checkpoints and board revisions", onToggle: on => { kinds.snapshots = on; rebuild(); }});
    const chipCommits = K.chip("Commits", {pressed: true, title: "Git commits", onToggle: on => { kinds.commits = on; rebuild(); }});
    const refresh = K.button("Refresh", {variant: "quiet", size: "sm", title: "Read the repository and local history again", run: refreshHistory});
    const toolbar = K.toolbar([searchBox, branchSelect, "|", K.chips([chipEdits, chipSnaps, chipCommits], "Show"), "->", refresh], {label: "History"});
    toolbar.classList.add("hv-toolbar");
    const noticeSlot = el("div", "hv-notice");
    const listPane = el("div", "hv-list-pane"), canvas = el("canvas", "hv-graph"), scroller = el("div", "hv-scroll");
    const list = el("div", "ui-list hv-list"), empty = el("div", "hv-empty"), foot = el("div", "hv-foot");
    canvas.setAttribute("aria-hidden", "true");
    list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "History, newest first");
    scroller.tabIndex = 0; scroller.setAttribute("role", "presentation");
    list.tabIndex = -1;
    scroller.append(list); listPane.append(canvas, scroller, empty);
    const details = el("aside", "hv-details"); details.setAttribute("aria-label", "Details"); details.tabIndex = -1;
    let detailWidth = 380;
    const splitter = K.splitter({label: "Resize details", onResize: d => { detailWidth = Math.max(280, Math.min(720, detailWidth - d)); layout(); }});
    const split = el("div", "ui-split hv-split");
    split.append(listPane, splitter, details);
    const main = el("div", "hv-main");
    main.append(noticeSlot, split);
    root.append(toolbar, main, foot);
    function layout() { split.style.setProperty("--hv-details-w", detailWidth + "px"); schedule(); }
    layout();

    // ---------------------------------------------------------------- data: now and local
    const undoState = () => G.AtriumUndoStore.timeline(host);
    let editLine = [];
    function readEdits(state = undoState()) {
      const out = [];
      for (let i = state.list.length - 1; i >= 1; i--) out.push({i, undone:i > state.at, current:i === state.at,
        previous:state.list[i - 1], step:state.list[i], label:null});
      editLine = state.list;
      edits = out;
    }
    function editLabel(e) {
      if (e.label) return e.label;
      const P = G.AtriumHistoryPanel;
      if (!P) return "Edit " + e.i;
      try {
        const info = P.label(e.previous, e.step);
        e.label = info.label || "Edit";
        e.docs = (info.docs || []).map(d => d.name || d).filter(Boolean);
      } catch { e.label = "Edit " + e.i; }
      return e.label;
    }
    let undoModules = null;
    function needUndo() {
      undoModules ??= G.AtriumLazy.need(["AtriumUndoStore", "AtriumHistoryPanel"]).then(() => { if (!closed) paintRows(true); }).catch(() => {});
      return undoModules;
    }
    async function readLocal() {
      const A = G.AtriumAutosave, out = [], p = host.project();
      try {
        for (const m of await (A?.recoverySnapshots?.(A) || [])) out.push({key: m.key, type: m.type, id: m.id, slot: m.slot, ts: m.ts, title: m.title, meta: m.meta, reason: m.reason});
      } catch (error) { out.push({key: "snap:error", type: "snapshot", error: error.message, title: "Recovery storage unavailable", ts: 0}); }
      if (p?.revisions?.length) {
        try {
          const R = await G.AtriumLazy.need("AtriumRevisions");
          for (const r of R.list(p)) out.push({key: "rev:" + r.id, type: "revision", id: r.id, ts: Date.parse(r.released || r.date) || 0, title: "Rev " + r.letter,
            status: r.status, notes: r.notes || "", date: r.date});
        } catch { /* revisions module unavailable */ }
      }
      if (closed || host.project() !== p) return;
      snapshots = out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
      rebuild();
    }

    // ---------------------------------------------------------------- data: Git
    // The first page may come from the entry's idle prefetch (history-entry.js): rows paint at once, and the
    // fresh read replaces them only if the repository moved meanwhile (its snapshot differs).
    function accept(r, append) {
      if (!append) {
        commits = []; refs = new Map();
        for (const ref of r.refs || []) { if (!refs.has(ref.revision)) refs.set(ref.revision, []); refs.get(ref.revision).push(ref); }
      }
      head = r.head || null; headRef = r.ref || null; snapshot = r.snapshot; more = !!r.more;
      for (const c of r.commits) commits.push(c);
      const t = now();
      rebuild();
      if (!perf.firstRows) perf.firstRows = now() - perf.open;
      perf.rows = now() - t;
    }
    function setBranchMode(mode, readLog = true) {
      if (branchMode === mode) return;
      branchMode = branchSelect.value = mode;
      mark = null;
      commits = []; refs.clear(); more = false;
      rebuild();
      logRequested = false;
      if (readLog && !scoped()) load(false);
    }
    async function loadFile(append, mine) {
      if (!append) {
        fileReader?.close();
        fileReader = G.AtriumSourceHistory.open();
        checked = 0;
        commits = []; refs.clear(); head = headRef = null;
        rebuild();
      }
      const reader = fileReader;
      const result = await reader.page(checked, FILE_PAGE, c => {
        if (closed || mine !== ticket || reader !== fileReader) return false;
        commits.push(c);
        rebuild();
      });
      if (!closed && mine === ticket && reader === fileReader) checked = result.checked;
      return {...result, commits:commits.slice()};
    }
    async function load(append) {
      if (closed) return;
      logRequested = true;
      if (!available) { rebuild(); return; }
      const mine = ++ticket, all = branchMode === "all", file = branchMode === "file";
      if (!file) { fileReader?.close(); fileReader = null; }
      cancelIdle();
      const early = !append && all && !commits.length ? G.AtriumHistoryEntry?.cachedLog?.() : null;
      if (!append) {
        source.refresh(); summaryTask?.controller.abort(); detailTask?.controller.abort();
        summaryTask = detailTask = null;
      }
      if (early) { perf.cached = true; accept(early, false); }
      loading = !early; loadError = null; stale = false; paintNotice(); paintFoot();
      try {
        const limit = append ? PAGE : FIRST;
        const linked = all && !G.AtriumHost?.historyPath && G.AtriumPrefs?.get("butter.links") === true;
        const r = file ? await loadFile(append, mine) : await source.query("projectLog", {limit, skip: append ? commits.length : 0,
          ...(append ? {snapshot} : {}), ...(!all && {firstParent:true}), ...(linked && {recordLinks:true})});
        if (closed || mine !== ticket || !source.current()) return;
        if (linked) {
          try {
            const links = await G.AtriumLazy.need("AtriumLinksDesktop");
            if (!closed && mine === ticket && source.current()) links.index(project0.id)?.importCommits(r.commits, {replace:!append});
          } catch (error) { if (!closed && mine === ticket) host.info?.(error.message); }
          if (closed || mine !== ticket || !source.current()) return;
        }
        loading = false;
        if (!append) G.AtriumHistoryEntry?.rememberLog?.(r, all);
        if (early && r.snapshot === early.snapshot && r.commits.length === early.commits.length) paintFoot();
        else { if (!append) { summaries.clear(); full.clear(); } accept(r, append && !file); }
        if (!file && more && commits.length < CAP) idleLoad = (G.requestIdleCallback || setTimeout)(() => { idleLoad = 0; load(true); }, {timeout: 400});
      } catch (error) {
        if (closed || mine !== ticket) return;
        loading = false;
        if (/history changed/i.test(error.message)) stale = true; else loadError = error.message;
        rebuild();
      }
    }
    function cancelIdle() { if (idleLoad) { (G.cancelIdleCallback || clearTimeout)(idleLoad); idleLoad = 0; } }

    // ---------------------------------------------------------------- items and graph
    const commitMatches = c => {
      if (query.author && !String(c.author || "").toLowerCase().includes(query.author)) return false;
      if (query.text && !String(c.subject || "").toLowerCase().includes(query.text) && !c.revision.startsWith(query.text)) return false;
      return true;
    };
    const scoped = () => !!(query.object || query.net);
    const filtering = () => !!(query.text || query.author || scoped());
    function rebuild() {
      if (closed) return;
      const t = now(), out = [], f = filtering();
      if (objectFields.get("working")?.fields?.length) out.push({key:"working", type:"working"});
      if (!f && branchMode !== "file") {
        out.push({key: "working", type: "working"});
        if (kinds.edits && expanded.has("working")) for (const e of edits) out.push({key: "edit:" + e.i, type: "edit", e, depth: 1});
        const local = snapshots.filter(s => !s.error);
        if (kinds.snapshots && snapshots.length) {
          out.push({key: "local", type: "local", count: local.length});
          if (expanded.has("local")) for (const s of snapshots) out.push({key: s.key, type: s.type, s, depth: 1});
        }
      }
      const visibleCommits = scoped() ? (objectResult?.entries || []).map(entry => entry.commit) : commits;
      if (kinds.commits) for (const c of visibleCommits) if (!f || commitMatches(c)) out.push({key: c.revision, type: "commit", c});
      items = out;
      keyIndex = new Map(items.map((it, i) => [it.key, i]));
      // The graph: uncommitted rows chain into HEAD on a dashed lane; a filtered list is one plain line.
      const input = [];
      if (f) items.forEach((it, i) => input.push({revision: it.key, parents: items[i + 1] ? [items[i + 1].key] : []}));
      else {
        const pseudo = items.filter(it => it.type !== "commit"), known = keyIndex.has(head || "");
        pseudo.forEach((it, i) => input.push({revision: it.key, pseudo: true, parents: pseudo[i + 1] ? [pseudo[i + 1].key] : known ? [head] : []}));
        for (const it of items) if (it.type === "commit") input.push({revision: it.c.revision, parents: it.c.parents});
      }
      rows = CG.lanes(input);
      graphW = CG.width(rows) + 4;
      list.style.height = items.length * rowH + "px";
      root.style.setProperty("--hv-graph-w", graphW + "px");
      if (!keyIndex.has(sel)) sel = items[0]?.key || null;
      if (mark && !keyIndex.has(mark)) mark = null;
      const counted = kinds.commits ? visibleCommits.filter(c => !f || commitMatches(c)).length : 0;
      searchBox.setCount(f ? counted.toLocaleString() + " of " + visibleCommits.length.toLocaleString() +
        ((scoped() ? objectResult?.more : more) ? "+" : "") : null);
      perf.renders.push(now() - t);
      // Local entries can change in place (an undo); a commit's details only change with the selection.
      paintNotice(); paintFoot(); paintRows(true); paintDetails(items[keyIndex.get(sel)]?.type !== "commit");
    }

    // ---------------------------------------------------------------- notices, footer and empty states
    function paintNotice() {
      const nodes = [];
      if (!available) nodes.push(K.notice({tone:"info", title:"No Git history.",
        text: (branchMode === "file" || objectTarget ? "" : "Edits and local snapshots are shown. ") +
          "Save the project inside a Git repository in the desktop app to see its commits here.",
        actions:branchMode === "file" ? [K.button("Compare two revisions…", {size:"sm", run:() => host.act("diff-compare")})] : []}));
      else if (stale) nodes.push(K.notice({tone: "warning", title: "The repository changed.", text: "Branches or commits changed since History opened.",
        actions: [K.button("Refresh", {size: "sm", run: () => load(false)})], live: true}));
      else if (loadError) nodes.push(K.notice({tone: "danger", title: "Git history unavailable.", text: loadError,
        actions: [K.button("Try again", {size: "sm", run: () => load(false)})], live: true}));
      if (objectError) nodes.push(K.notice({tone:"danger", title:"Object history unavailable.", text:objectError,
        actions:[K.button("Try again", {size:"sm", run:() => {
          searchBox.input.focus({preventScroll:true});
          startObject();
        }})], live:true}));
      noticeSlot.replaceChildren(...nodes);
      noticeSlot.hidden = !nodes.length;
      empty.replaceChildren();
      const readingLog = !scoped() && loading;
      if ((!items.length || filtering() && kinds.commits && !items.some(it => it.type === "commit")) && !readingLog && !objectScan) {
        const label = query.object || query.net ? (query.object ? query.object : "net " + query.net) : searchBox.input.value.trim();
        empty.append(K.empty({text: filtering() ? "No commits match " + label + "." : branchMode === "file" ? "No commits changed this file." : "Nothing to show. Turn on Edits, Snapshots or Commits.",
          actions: filtering() ? [K.button("Clear filter", {size: "sm", run: () => setQuery("", true)})] : []}));
      } else if (readingLog && !commits.length && kinds.commits) {
        const sk = el("div", "hv-skeleton");
        for (let i = 0; i < 8; i++) { const b = el("span", "ui-skeleton"); b.style.setProperty("--hv-w", (40 + (i * 37) % 45) + "%"); sk.append(b); }
        sk.style.top = (items.length * rowH + 4) + "px"; empty.append(sk);
      }
      empty.hidden = !empty.childElementCount;
    }
    function paintFoot() {
      const parts = [];
      if (objectScan) parts.push(objectScan.text);
      else if (objectResult) parts.push(plural(objectResult.entries.length, "change") + " in " +
        plural(objectResult.checked, "first-parent commit") + (objectResult.more ? " · Older history available" : ""));
      else if (loading && !scoped()) parts.push(commits.length ? "Reading older commits…" : "Reading Git history…");
      else if (available && !loadError && !scoped()) {
        const branches = [...refs.values()].flat().filter(r => r.kind === "branch").length, tags = [...refs.values()].flat().filter(r => r.kind === "tag").length;
        parts.push(plural(commits.length, "commit") + (more ? "+" : ""));
        if (branchMode === "file") parts.push(checked.toLocaleString() + " first-parent commits checked");
        else {
          parts.push(plural(branches, "branch", "branches"), plural(tags, "tag"));
          if (headRef) parts.push("On " + headRef.replace(/^refs\/heads\//, ""));
          else if (head) parts.push("Detached at " + git.short(head));
        }
      }
      if (host.isDirty?.()) parts.push("Unsaved changes");
      const line = K.statusLine(parts.join(" · "), {busy: !!(objectScan || loading && !scoped())});
      if (objectScan) line.append(K.button("Cancel", {variant: "quiet", size: "sm", run: () => cancelObject()}));
      if (branchMode === "file" && more && !loading && !loadError && !stale)
        line.append(K.button("Show older commits", {size:"sm", run:() => load(true)}));
      foot.replaceChildren(line);
    }

    // ---------------------------------------------------------------- rows
    function nodeOf(i) {
      const it = items[i];
      if (!it) return {kind: "none"};
      if (it.type === "working") return {kind: "working", current: !!host.isDirty?.()};
      if (it.type !== "commit") return {kind: "step"};
      const s = summaries.get(it.c.revision);
      return {kind: it.c.parents.length > 1 ? "merge" : "commit", solid: !s || s.total > 0, current: it.c.revision === head};
    }
    function refBadges(c) {
      const out = [], labels = refs.get(c.revision) || [];
      if (c.revision === head) out.push(K.badge(headRef ? headRef.replace(/^refs\/heads\//, "") : "HEAD", headRef ? "accent" : "warning"));
      for (const r of labels) {
        if (headRef && r.name === headRef) continue;
        if (out.length >= 3) { out.push(K.badge("+" + (labels.length - 2))); break; }
        out.push(K.badge(r.short, REF_TONE[r.kind]));
      }
      for (const b of out) b.classList.add("hv-ref");
      if (c.revision === head && headRef) out[0].title = "HEAD → " + headRef.replace(/^refs\/heads\//, "");
      return out;
    }
    function severityDots(s) {
      if (!s?.counts) return [];
      const out = [];
      for (const [k, tone] of Object.entries(SEVERITY)) if (s.counts[k] && tone) out.push(K.dot(tone, {label: s.counts[k] + " " + k}));
      return out;
    }
    function rowNode(it, i) {
      const tree = it.type === "working" || it.type === "local", r = el("div", "ui-row hv-row" + (tree || it.depth ? " ui-tree-row" : ""));
      r.setAttribute("role", "option"); r.id = "hv-row-" + i; r.dataset.key = it.key; r.dataset.type = it.type;
      if (it.depth) r.style.setProperty("--ui-depth", String(it.depth));
      r.style.transform = "translateY(" + i * rowH + "px)";
      const text = el("span", "ui-row-text hv-row-text"), meta = el("span", "ui-row-meta hv-row-meta");
      if (tree || it.depth) {
        const disc = el("span", "ui-disclosure");
        if (tree && (it.type === "working" ? edits.length : it.count)) { r.setAttribute("aria-expanded", String(expanded.has(it.key))); disc.dataset.toggle = ""; }
        r.append(disc);
      }
      const title = el("span", "ui-row-title");
      if (it.type === "working") {
        title.textContent = "Working design";
        text.append(title);
        if (host.isDirty?.()) text.append(K.badge("Unsaved"));
        meta.append(el("span", "hv-when", edits.length ? plural(edits.length, "edit") : "No edits"));
      } else if (it.type === "edit") {
        title.textContent = editLabel(it.e); text.append(title);
        if (it.e.undone) { r.dataset.state = "pending"; meta.append(el("span", "hv-when", "Undone")); }
        else if (it.e.current) meta.append(el("span", "hv-when", "Current"));
      } else if (it.type === "local") {
        title.textContent = "Local snapshots"; text.append(title);
        meta.append(el("span", "hv-when", plural(it.count, "snapshot")));
      } else if (it.type === "snapshot") {
        title.textContent = it.s.error ? it.s.title : it.s.title; text.append(title);
        if (it.s.error) r.dataset.state = "broken";
        meta.append(el("span", "hv-when", agoTs(it.s.ts)));
      } else if (it.type === "revision") {
        text.append(K.badge(it.s.title, it.s.status === "released" ? "success" : null)); title.textContent = it.s.notes || "Board revision"; text.append(title);
        meta.append(el("span", "hv-when", it.s.date || agoTs(it.s.ts)));
      } else {
        const c = it.c, s = summaries.get(c.revision);
        text.append(...refBadges(c));
        title.textContent = c.subject || "(no message)"; text.append(title, ...severityDots(s));
        if (s && !s.total) r.dataset.quiet = "";
        const who = el("span", "hv-who");
        who.append(K.avatar(initials(c.author), {hue: hueOf(c.author), size: "sm"}), el("span", "hv-author", c.author || ""));
        const time = el("time", "hv-when", ago(c.date)); time.dateTime = c.date || ""; time.title = exact(c.date);
        meta.append(who, time);
        r.title = git.short(c.revision) + " · " + (c.subject || "");
      }
      r.append(text, meta);
      return r;
    }
    function paintRow(r, it) {
      const selected = it.key === sel || it.key === mark;
      r.setAttribute("aria-selected", String(selected));
      if (it.key === mark) r.dataset.mark = ""; else delete r.dataset.mark;
    }
    function paintRows(force) {
      if (closed) return;
      const t = now();
      const height = scroller.clientHeight || 600, top = scroller.scrollTop;
      const first = Math.max(0, Math.floor(top / rowH) - 4), last = Math.min(items.length, Math.ceil((top + height) / rowH) + 4);
      if (force) { for (const r of mounted.values()) r.remove(); mounted.clear(); }
      const wanted = new Set();
      for (let i = first; i < last; i++) wanted.add(items[i].key);
      for (const [key, r] of mounted) if (!wanted.has(key)) { r.remove(); mounted.delete(key); }
      const frag = document.createDocumentFragment();
      for (let i = first; i < last; i++) {
        const it = items[i];
        let r = mounted.get(it.key);
        if (!r) { r = rowNode(it, i); mounted.set(it.key, r); frag.append(r); }
        paintRow(r, it);
      }
      list.append(frag);
      const active = keyIndex.get(sel);
      if (active != null && mounted.has(sel)) scroller.setAttribute("aria-activedescendant", "hv-row-" + active); else scroller.removeAttribute("aria-activedescendant");
      // The graph covers the rows in view only; it scrolls with whole rows of offset.
      const gFirst = Math.max(0, Math.floor(top / rowH)), gLast = Math.min(items.length, Math.ceil((top + height) / rowH) + 1);
      CG.paint(canvas, {rows, first: gFirst, last: gLast, top: gFirst * rowH - top, rowHeight: rowH, width: graphW, height, nodes: nodeOf});
      const spent = now() - t;
      perf.longest = Math.max(perf.longest, spent);
      if (!still) return;
      pumpSummaries(first, last);
    }
    function schedule() { if (!frame && !closed) frame = requestAnimationFrame(() => { frame = 0; paintRows(false); }); }
    scroller.addEventListener("scroll", () => {
      still = false; summaryTask?.controller.abort();
      clearTimeout(scrollIdle); scrollIdle = setTimeout(() => { still = true; schedule(); }, 180);
      schedule();
    }, {passive: true});
    const resize = new ResizeObserver(() => schedule());
    resize.observe(scroller);

    // ---------------------------------------------------------------- summaries
    function parentOf(c) {
      const id = c.parents[0];
      if (!id) return null;
      return objectFields.get(id)?.commit || commits.find(x => x.revision === id) || {revision: id, parents: [], subject: "First parent"};
    }
    async function summaryOf(c, signal) {
      if (full.has(c.revision)) return full.get(c.revision);
      const data = await source.summary(c, signal, 0);
      full.set(c.revision, data);
      if (full.size > 60) full.delete(full.keys().next().value);
      summaries.set(c.revision, {total: data.total, counts: data.counts});
      return data;
    }
    function pumpSummaries(first, last) {
      if (summaryTask || detailTask || closed || !available || document.hidden || box.hidden) return;
      let it = null;
      for (let i = first; i < last; i++) if (items[i]?.type === "commit" && !summaries.has(items[i].key)) { it = items[i]; break; }
      if (!it) return;
      const controller = new AbortController(), task = summaryTask = {key: it.key, controller};
      summaryOf(it.c, controller.signal).then(() => {
        const r = mounted.get(it.key);
        if (r && !closed) { const i = keyIndex.get(it.key); const next = rowNode(items[i], i); paintRow(next, items[i]); r.replaceWith(next); mounted.set(it.key, next); }
      }, error => { if (!controller.signal.aborted) summaries.set(it.key, {total: 1, counts: {}, error: error.message}); })
        .finally(() => { if (summaryTask === task) summaryTask = null; if (!closed) schedule(); });
    }

    // ---------------------------------------------------------------- selection and keyboard
    function select(key, {extend = false, toggleMark = false, focus = true, reveal = true} = {}) {
      if (key == null || !keyIndex.has(key)) return;
      if (toggleMark) mark = mark === key ? null : key !== sel ? key : mark;
      else if (extend) { if (!mark) mark = sel; sel = key; if (mark === sel) mark = null; }
      else { sel = key; mark = null; }
      if (reveal) revealRow(keyIndex.get(sel));
      for (const [k, r] of mounted) paintRow(r, items[keyIndex.get(k)]);
      const active = keyIndex.get(sel);
      if (mounted.has(sel)) scroller.setAttribute("aria-activedescendant", "hv-row-" + active);
      if (focus && !scroller.contains(document.activeElement)) scroller.focus({preventScroll: true});
      paintDetails();
    }
    function revealRow(i) {
      if (i == null) return;
      const top = i * rowH, bottom = top + rowH;
      if (top < scroller.scrollTop) scroller.scrollTop = top;
      else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
      paintRows(false);
    }
    function toggle(key, open) {
      const on = open ?? !expanded.has(key);
      if (on === expanded.has(key)) return;
      if (on) { expanded.add(key); if (key === "working") { readEdits(); needUndo(); } } else expanded.delete(key);
      rebuild();
    }
    list.addEventListener("click", e => {
      const r = e.target.closest(".hv-row");
      if (!r) return;
      if (e.target.closest(".ui-disclosure[data-toggle]")) { toggle(r.dataset.key); select(r.dataset.key, {reveal: false}); return; }
      select(r.dataset.key, {extend: e.shiftKey, toggleMark: e.metaKey || e.ctrlKey, reveal: false});
    });
    list.addEventListener("dblclick", e => { const r = e.target.closest(".hv-row"); if (r) { select(r.dataset.key); primary(); } });
    list.addEventListener("contextmenu", e => {
      const r = e.target.closest(".hv-row");
      if (!r) return;
      e.preventDefault();
      if (r.dataset.key !== sel && r.dataset.key !== mark) select(r.dataset.key, {reveal: false});
      menu(r.querySelector(".ui-row-title") || r);
    });
    scroller.addEventListener("keydown", e => {
      const i = keyIndex.get(sel) ?? 0, page = Math.max(1, Math.floor(scroller.clientHeight / rowH) - 1);
      const to = {ArrowUp: i - 1, ArrowDown: i + 1, Home: 0, End: items.length - 1, PageUp: i - page, PageDown: i + page}[e.key];
      const mod = e.metaKey || e.ctrlKey;
      if (to != null && !mod && !e.altKey) {
        e.preventDefault();
        select(items[Math.max(0, Math.min(items.length - 1, to))]?.key, {extend: e.shiftKey});
      } else if (e.key === "ArrowRight" && !mod) {
        const it = items[i]; e.preventDefault();
        if ((it?.type === "working" || it?.type === "local") && !expanded.has(it.key)) toggle(it.key, true);
        else if (items[i + 1]) select(items[i + 1].key);
      } else if (e.key === "ArrowLeft" && !mod) {
        const it = items[i]; e.preventDefault();
        if (expanded.has(it?.key)) toggle(it.key, false);
        else if (it?.depth) { for (let k = i - 1; k >= 0; k--) if (!items[k].depth) { select(items[k].key); break; } }
      } else if (e.key === "Enter") { e.preventDefault(); primary(); }
      else if (e.key === " ") { e.preventDefault(); select(sel, {toggleMark: false}); markCurrent(); }
      else if (mod && e.key.toLowerCase() === "c" && items[i]?.type === "commit") { e.preventDefault(); copyHash(items[i].c); }
      else if ((mod && e.key.toLowerCase() === "f") || e.key === "/") { e.preventDefault(); searchBox.input.focus(); searchBox.input.select(); }
      else if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (mark) { mark = null; select(sel, {reveal: false}); }
        else if (filtering()) setQuery("", true);
        else G.AtriumDocViews.hide(ID);
      } else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
        e.preventDefault(); menu(mounted.get(sel)?.querySelector(".ui-row-title") || scroller);
      }
    });
    // Space picks the row under the cursor as the other side of Compare (a second press clears it).
    function markCurrent() {
      const it = items[keyIndex.get(sel)];
      if (!it || it.type !== "commit") return;
      const i = keyIndex.get(sel);
      const next = items[i + 1]?.type === "commit" ? items[i + 1].key : null;
      if (mark) mark = null; else if (next) { mark = sel; sel = next; }
      select(sel, {reveal: true});
    }
    searchBox.input.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "Enter") { e.preventDefault(); scroller.focus({preventScroll: true}); if (!keyIndex.has(sel)) select(items[0]?.key); }
    });
    box.addEventListener("keydown", e => {
      if (e.key === "Escape" && e.target === box) { e.preventDefault(); G.AtriumDocViews.hide(ID); }
    });

    // ---------------------------------------------------------------- filters
    function setQuery(text, write, target = null) {
      if (write) searchBox.input.value = text;
      const q = parseQuery(text);
      if (q.object !== query.object || q.net !== query.net || target) {
        objectTarget = target;
        query = q;
        startObject();
      } else query = q;
      if (!scoped() && !logRequested) load(false);
      rebuild();
    }
    function targetFor(q) {
      if (q.net) return {net: q.net, label: "Net " + q.net};
      // A designator can name the symbol on a sheet and the footprint on the board: the open document wins.
      const want = q.object.toLowerCase(), docs = host.project().documents, open = host.currentId?.();
      for (const doc of [...docs.filter(d => d.id === open), ...docs.filter(d => d.id !== open)]) for (const item of doc.items || []) {
        if (String(item.ref || item.name || "").toLowerCase() === want) {
          return {key: G.AtriumBlame.engine.itemKey(doc.id, item.id), docId: doc.id, item, label: (item.ref || item.name || item.kind) + (docs.length > 1 ? " on " + doc.name : "")};
        }
      }
      return null;
    }
    function cancelObject() { objectScan?.controller.abort(); objectScan = null; paintFoot(); paintNotice(); }
    async function startObject() {
      objectError = null;
      objectResult = null;
      cancelObject(); objectFields.clear();
      if (!scoped() || !available) return;
      const controller = new AbortController(), scan = objectScan = {controller, text: "Finding commits that changed " + (query.object || "net " + query.net) + "…"};
      paintFoot();
      let reader = null;
      try {
        const B = await G.AtriumLazy.need("AtriumBlame");
        if (controller.signal.aborted) return;
        const chosen = objectTarget || targetFor(query);
        if (!chosen) throw Error("No object named " + query.object + " in this project.");
        const target = chosen.item && !chosen.key ? {...chosen, key:B.engine.itemKey(chosen.docId, chosen.item.id)} : chosen;
        reader = G.AtriumSourceHistory.open();
        controller.signal.addEventListener("abort", () => reader.close(), {once: true});
        const r = await B.sourceHistory(reader, host, target, true, n => {
          if (objectScan !== scan) return;
          scan.text = "Checked " + n.toLocaleString() + " commits for " + target.label + "…"; paintFoot();
        });
        if (controller.signal.aborted || objectScan !== scan) return;
        objectResult = r;
        for (const entry of r.entries) objectFields.set(entry.commit.revision, entry);
        objectFields.set("working", {status: "uncommitted", fields: r.working});
        objectScan = null;
        rebuild();
      } catch (error) {
        if (objectScan === scan) { objectScan = null; objectError = error.message; rebuild(); }
      } finally { reader?.close(); }
    }
    async function loadUntil(revision) {
      while (!closed && !loading && !loadError && !stale && more && commits.length < CAP && branchMode !== "file" && !commits.some(c => c.revision === revision)) await load(true);
    }

    // ---------------------------------------------------------------- actions
    const busy = new Set();
    async function act(name, run) {
      if (busy.has(name)) return;
      busy.add(name);
      try { await run(); } catch (error) { if (!closed) host.info?.(error.message); } finally { busy.delete(name); }
    }
    const current = () => !closed && host.project() === project0 && source.current();
    function compareCommits(before, after) {
      return act("compare", async () => {
        const controller = new AbortController();
        await source.compare(before, after, controller.signal, {doc:objectTarget?.docId, focus:objectTarget?.item?.id});
      });
    }
    function compareWithWorking(c) {
      return act("compare", async () => {
        const reader = G.AtriumSourceHistory.open();
        try {
          await reader.compare({type:"commit", rev:c.revision, label:c.subject}, {type:"working"}, host,
            {active:current, doc:objectTarget?.docId, focus:objectTarget?.item?.id});
        } finally { reader.close(); }
      });
    }
    function restoreCommit(c) {
      return act("restore", async () => {
        const reader = G.AtriumSourceHistory.open();
        try { await reader.restoreCopy(c.revision, host, current); }
        finally { reader.close(); }
      });
    }
    const workingSide = () => git.readSpec({type:"working"}, host, undefined, current);
    function compareSnapshot(s) {
      return act("compare", async () => {
        const label = s.type === "revision" ? s.title : s.title + " · " + exact(s.ts);
        const left = await git.readSpec({type:s.type, id:s.id, slot:s.slot, label}, host, undefined, current);
        const right = await workingSide();
        await git.compare(left, right, {active:current});
      });
    }
    function restoreSnapshot(s) {
      return act("restore", async () => { await G.AtriumAutosave.restore(s.id, {copy: true, current}); });
    }
    function goToEdit(e) {
      if (G.AtriumCollabLive?.active?.()) { host.info?.("Undo steps are shared in a live session. Use Undo my change instead."); return; }
      const s = undoState(), index = s.list.indexOf(e.step);
      if (index < 0) { host.info?.("This undo state has expired."); return; }
      const n = index - s.at;
      if (n) host.historyGo(n);
      readEdits(); rebuild();
    }
    function compareEdit(e) {
      return act("compare", async () => {
        await needUndo();
        const left = await git.readSpec({type:"undo", mark:e.step, label:"Undo: " + editLabel(e)}, host, undefined, current);
        const right = await workingSide();
        await git.compare(left, right, {active:current});
      });
    }
    // A folder project keeps drafts of unsaved owners, not whole-project snapshots (autosave.js).
    const canCheckpoint = () => !host.folderProject?.() && !host.isStarter?.() && !!G.AtriumAutosave?.save && G.AtriumAutosave.backend?.() !== "localStorage";
    function checkpoint() {
      return act("checkpoint", async () => {
        if (!G.AtriumHistoryPanel) await G.AtriumLazy.need("AtriumHistoryPanel");
        await G.AtriumHistoryPanel.checkpoint("checkpoint", current);
        await readLocal();
        host.info?.("Saved a checkpoint in local history.");
      });
    }
    function copyHash(c) { copy(c.revision).then(ok => host.info?.(ok ? "Copied " + git.short(c.revision) + "." : "Copy is unavailable here.")); }
    function branchAt(c) {
      if (G.AtriumHost?.historyPath) { host.info?.("Imported source history is read-only."); return; }
      const field = K.field({label: "Branch name", value: ""});
      const status = el("p", "hv-dialog-status"); status.setAttribute("role", "status");
      const d = G.AtriumShell.dialog({title: "Create Git branch", label: "Create Git branch",
        body: [K.propRow("Name", field), K.propRow("At", git.short(c.revision) + " · " + (c.subject || "")), status],
        actions: [{label: "Cancel"}, {label: "Create branch", primary: true, run: async () => {
          const name = field.value.trim();
          if (!name) { status.textContent = "Enter a branch name."; return false; }
          try { await git.q("createBranch", {name, revision: c.revision, confirm: true}); }
          catch (error) { status.textContent = error.message; return false; }
          host.info?.("Created branch " + name + " at " + git.short(c.revision) + ".");
          load(false); return true;
        }}]});
      return d;
    }
    function pairOf() {
      if (!mark) return null;
      const a = items[keyIndex.get(sel)], b = items[keyIndex.get(mark)];
      if (a?.type !== "commit" || b?.type !== "commit") return null;
      const [older, newer] = keyIndex.get(a.key) > keyIndex.get(b.key) ? [a.c, b.c] : [b.c, a.c];
      return {older, newer};
    }
    function primary() {
      const pair = pairOf(), it = items[keyIndex.get(sel)];
      if (pair) return compareCommits(pair.older, pair.newer);
      if (!it) return;
      if (it.type === "commit") return compareCommits(parentOf(it.c), it.c);
      if (it.type === "working" && available && head) return compareWithWorking({revision: head, subject: "HEAD"});
      if (it.type === "working" || it.type === "local") return toggle(it.key);
      if (it.type === "edit") return goToEdit(it.e);
      if (it.type === "snapshot" || it.type === "revision") return it.s.error ? null : compareSnapshot(it.s);
    }
    function commands(it) {
      if (it?.type !== "commit") return [];
      const c = it.c, pair = pairOf();
      return [
        ...(pair ? [{label: "Compare " + git.short(pair.older.revision) + " → " + git.short(pair.newer.revision), run: () => compareCommits(pair.older, pair.newer)}, "-"] : []),
        {label: "Compare with parent", run: () => compareCommits(parentOf(c), c)},
        {label: "Compare with working design", run: () => compareWithWorking(c)},
        {label: "Restore as copy", run: () => restoreCommit(c)},
        "-",
        {label: "Create branch here…", enabled: !G.AtriumHost?.historyPath, run: () => branchAt(c)},
        {label: "Copy commit hash", run: () => copyHash(c)}
      ];
    }
    async function menu(anchor) {
      const it = items[keyIndex.get(sel)], list = commands(it);
      if (!list.length) return;
      const M = await G.AtriumLazy.need("AtriumContextMenu");
      if (!closed) M.dropdown(anchor, list);
    }

    // ---------------------------------------------------------------- details
    let detailKey = null;
    function heading(title, ...rest) {
      const h = el("header", "hv-detail-head"), t = el("h2", "hv-detail-title", title);
      h.append(t, ...rest); return h;
    }
    function actionsRow(...buttons) { const a = el("div", "hv-detail-actions"); a.append(...buttons.filter(Boolean)); return a; }
    function tile(region, side) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 88 46"); svg.setAttribute("aria-hidden", "true"); svg.classList.add("hv-tile", "hv-" + side);
      for (const layer of ["context", "changed"]) if (region?.[side]?.[layer]) {
        const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
        p.setAttribute("d", region[side][layer]); p.setAttribute("class", "hv-" + layer); svg.append(p);
      }
      return svg;
    }
    function fieldRow(f) {
      const r = K.row({title:f.field}), d = el("span", "ui-row-detail");
      r.dataset.historyField = f.field;
      d.append(K.diff(String(f.before ?? "—"), String(f.after ?? "—"))); r.querySelector(".ui-row-text").append(d);
      return r;
    }
    function groupObjects(objects) {
      const groups = new Map();
      for (const o of objects || []) {
        const name = GROUP.get(o.type) || (o.kind.startsWith("library.") ? "Library" : o.kind.startsWith("rule") ? "Rules" : "Other");
        if (!groups.has(name)) groups.set(name, []);
        groups.get(name).push(o);
      }
      const order = ["Components", "Nets", "Tracks", "Vias", "Pads", "Wires", "Pours", "Documents", "Library", "Rules", "Other"];
      return [...groups].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
    }
    function objectRow(o, c, docs) {
      // Compare's sentence repeats the object's name: keep only what changed.
      const said = o.label && o.text.startsWith(o.label) ? o.text.slice(o.label.length).replace(/^[\s:·,-]+/, "") : o.text;
      const detail = o.before != null || o.after != null ? K.diff(o.before ?? "—", o.after ?? "—") : el("span", null, said ? said[0].toUpperCase() + said.slice(1) : o.text);
      const r = el("div", "ui-row hv-object");
      r.setAttribute("role", "option"); r.tabIndex = -1;
      const text = el("span", "ui-row-text"), title = el("span", "ui-row-title", o.label || o.text), d = el("span", "ui-row-detail");
      d.append(detail); text.append(title, d);
      const meta = el("span", "ui-row-meta"); if (SEVERITY[o.severity]) meta.append(K.dot(SEVERITY[o.severity], {label: o.severity}));
      if (docs > 1 && o.docName) meta.append(document.createTextNode(o.docName));
      r.append(text, meta);
      r.title = o.text;
      r.addEventListener("click", () => act("compare", async () => {
        const controller = new AbortController();
        await source.compare(parentOf(c), c, controller.signal);
      }));
      return r;
    }
    function commitDetails(c) {
      const out = [], pair = pairOf();
      out.push(heading(c.subject || "(no message)"));
      const by = el("div", "hv-byline");
      const who = el("div", "hv-byline-text");
      who.append(el("span", "hv-byline-name", c.author || "Unknown author"), el("span", "hv-byline-when", ago(c.date) + " · " + exact(c.date)));
      by.append(K.avatar(initials(c.author), {hue: hueOf(c.author), label: c.author}), who);
      out.push(by);
      const ids = el("div", "hv-ids");
      const code = el("code", "ui-code ui-selectable", git.short(c.revision)); code.title = c.revision;
      ids.append(code, K.button("Copy", {variant: "quiet", size: "sm", title: "Copy the full commit hash", run: () => copyHash(c)}));
      for (const b of refBadges(c)) ids.append(b);
      if (c.parents.length > 1) ids.append(K.badge("Merge"));
      out.push(ids);
      const parents = el("div", "hv-ids hv-parents");
      parents.append(el("span", "hv-muted", c.parents.length > 1 ? "Parents" : c.parents.length ? "Parent" : "First commit"));
      for (const p of c.parents) {
        const b = K.button(git.short(p), {variant: "quiet", size: "sm", run: () => { if (keyIndex.has(p)) select(p); else loadUntil(p).then(() => select(p)); }});
        b.title = "Select the parent commit"; parents.append(b);
      }
      out.push(parents);
      const compare = K.button(pair ? "Compare " + git.short(pair.older.revision) + " → " + git.short(pair.newer.revision) : "Compare", {variant: "primary", size: "sm",
        title: pair ? "Compare the two selected commits" : c.parents.length ? "Compare with its first parent" : "Compare with an empty design",
        run: () => pair ? compareCommits(pair.older, pair.newer) : compareCommits(parentOf(c), c)});
      const more = K.iconButton("more", "More actions", {size: "sm"});
      more.dataset.menuIndicator = "custom";
      G.AtriumNavCommon.actionMenu(more, commands(items[keyIndex.get(c.revision)] || {type: "commit", c}));
      out.push(actionsRow(compare, K.button("With working design", {size: "sm", run: () => compareWithWorking(c), title: "Compare with the working design, unsaved edits included"}),
        K.button("Restore as copy", {size: "sm", run: () => restoreCommit(c), title: "Open this commit as a new unsaved copy; the project stays as it is"}), more));
      if (pair) out.push(el("p", "ui-section-note", "Two commits are selected. Compare shows what changed from the older to the newer. Esc clears the second one."));
      const fields = objectFields.get(c.revision);
      if (fields && (fields.fields?.length || fields.objects?.length)) {
        const name = query.object || ("Net " + query.net);
        const rowsOut = (fields.fields || []).map(fieldRow);
        for (const o of fields.objects || []) rowsOut.push(K.row({title: o.label}));
        out.push(K.section(name + " · " + ({added: "added", removed: "removed", created: "first commit"}[fields.status] || "changed"), {}, K.list(rowsOut, {label: name})));
      }
      const changes = K.section("Design changes", {actions: []});
      const body = el("div", "hv-changes");
      changes.append(body); out.push(changes);
      const s = full.get(c.revision);
      if (!s) {
        body.append(K.statusLine("Reading design changes…", {busy: true}));
        loadDetail(c);
      } else paintChanges(changes, body, s, c);
      return out;
    }
    function paintChanges(section, body, s, c) {
      body.replaceChildren();
      if (s.error) { body.append(K.notice({tone: "danger", text: "Summary unavailable. " + s.error})); return; }
      const actions = section.querySelector(".ui-section-head");
      const counts = el("div", "ui-section-actions");
      for (const [k, tone] of Object.entries(SEVERITY)) if (s.counts?.[k]) counts.append(K.badge(s.counts[k] + " " + k, tone));
      actions.append(counts);
      if (!s.total) { body.append(K.empty({text: s.text || "No design changes. Only files outside the design changed."})); return; }
      body.append(el("p", "hv-headline ui-selectable", s.text));
      const regions = s.regions || [];
      if (regions.length) {
        let at = 0;
        const pairBox = el("div", "ui-thumbs hv-pair"), caption = el("div", "hv-region");
        const name = el("span", "hv-region-name");
        const pager = regions.length > 1 ? K.pager({index: 0, count: regions.length, unit: "region", label: "Changed regions", onStep: d => show(Math.max(0, Math.min(regions.length - 1, d === Infinity ? regions.length - 1 : d === -Infinity ? 0 : at + d)))}) : null;
        caption.append(name); if (pager) caption.append(pager);
        async function show(i) {
          at = i; pager?.set(i, regions.length);
          let region = regions[i];
          name.textContent = region.name;
          if (!region.before && !region.after && !region.error) {
            pairBox.replaceChildren(K.thumb({label: "Before", state: "pending"}), K.thumb({label: "After", state: "pending"}));
            try { region = (await source.summary(c, new AbortController().signal, i)).regions?.[i] || region; regions[i] = region; } catch { region = {...region, error: true}; }
            if (at !== i || closed) return;
          }
          if (region.error) { pairBox.replaceChildren(K.thumb({label: "Preview unavailable", state: "failed"})); return; }
          const b = K.thumb({label: "Before", art: tile(region, "before")}), a = K.thumb({label: "After", art: tile(region, "after")});
          for (const t of [b, a]) { t.tabIndex = 0; t.setAttribute("role", "button"); t.addEventListener("click", () => compareCommits(parentOf(c), c)); t.title = "Compare in the visual diff"; }
          pairBox.replaceChildren(b, a);
        }
        body.append(pairBox, caption);
        show(0);
      }
      const docs = new Set((s.objects || []).map(o => o.docName).filter(Boolean)).size;
      for (const [group, list] of groupObjects(s.objects)) {
        const rowsOut = list.slice(0, 60).map(o => objectRow(o, c, docs));
        const sec = K.section(group, {actions: [K.count(list.length)]}, K.list(rowsOut, {label: group}));
        if (list.length > 60) sec.append(el("p", "ui-section-note", (list.length - 60) + " more in Compare."));
        sec.classList.add("hv-group");
        body.append(sec);
      }
    }
    function loadDetail(c) {
      if (box.hidden || document.hidden || detailTask?.key === c.revision) return;
      detailTask?.controller.abort(); summaryTask?.controller.abort();
      const controller = new AbortController(), task = detailTask = {key: c.revision, controller};
      summaryOf(c, controller.signal).then(() => {
        if (detailTask !== task || closed) return;
        if (detailKey === c.revision) paintDetails(true);
        const r = mounted.get(c.revision), i = keyIndex.get(c.revision);
        if (r && i != null) { const next = rowNode(items[i], i); paintRow(next, items[i]); r.replaceWith(next); mounted.set(c.revision, next); schedule(); }
      }, error => {
        if (controller.signal.aborted || detailTask !== task) return;
        full.set(c.revision, {error: error.message});
        if (detailKey === c.revision) paintDetails(true);
      }).finally(() => { if (detailTask === task) detailTask = null; schedule(); });
    }
    function workingDetails() {
      const out = [heading("Working design")];
      const dirty = !!host.isDirty?.();
      out.push(el("p", "hv-lede", dirty ? "Unsaved changes. Save writes them to the project." : "All changes are saved."));
      const branchName = headRef ? headRef.replace(/^refs\/heads\//, "") : head ? "detached HEAD" : "";
      if (available && head) out.push(el("p", "hv-muted", "Based on " + git.short(head) + (branchName ? " on " + branchName : "") + "."));
      const fields = objectFields.get("working");
      out.push(actionsRow(available && head ? K.button("Compare with last commit", {variant: "primary", size: "sm", run: () => compareWithWorking({revision: head, subject: "HEAD"})}) : null,
        canCheckpoint() ? K.button("Save checkpoint", {size: "sm", run: checkpoint, title: "Keep this version in local history"}) : null));
      if (fields?.fields?.length) out.push(K.section("Not committed yet", {}, K.list(fields.fields.map(fieldRow))));
      if (!edits.length) readEdits();
      const recent = edits.slice(0, 8);
      if (recent.length) {
        needUndo();
        const rowsOut = recent.map(e => { const r = K.row({title: editLabel(e), meta: e.undone ? "Undone" : e.current ? "Current" : "", state: e.undone ? "pending" : undefined, run: () => { toggle("working", true); select("edit:" + e.i); }}); return r; });
        out.push(K.section("Edits this session", {actions: [K.count(edits.length)]}, K.list(rowsOut, {label: "Edits this session"})));
      } else out.push(K.section("Edits this session", {}, K.empty({text: "No edits yet in this session."})));
      return out;
    }
    function editDetails(e) {
      const out = [heading(editLabel(e))];
      out.push(el("p", "hv-lede", e.undone ? "Undone. Going to this step redoes it." : e.current ? "The current state of the design." : "An earlier state in this session."));
      if (e.docs?.length) out.push(el("p", "hv-muted", e.docs.join(" · ")));
      const live = G.AtriumCollabLive?.active?.();
      out.push(actionsRow(K.button(e.current ? "Current step" : "Go to this step", {variant: "primary", size: "sm", disabled: e.current || live, run: () => goToEdit(e),
        title: live ? "Undo steps are shared in a live session" : "Undo or redo to this step"}),
      K.button("Compare with now", {size: "sm", disabled: e.current, run: () => compareEdit(e)})));
      return out;
    }
    function snapshotDetails(s) {
      if (s.error) return [heading(s.title), K.notice({tone: "danger", text: s.error})];
      const out = [heading(s.type === "revision" ? s.title + (s.notes ? " · " + s.notes : "") : s.title)];
      out.push(el("p", "hv-lede", (s.type === "revision" ? G.AtriumRevisions?.statusLabel?.(s.status) + " · " + (s.date || "") : agoTs(s.ts) + " · " + exact(s.ts)) + (s.meta ? " · " + s.meta.replace(/^[^·]*· /, "") : "")));
      out.push(actionsRow(K.button("Compare with working design", {variant: "primary", size: "sm", run: () => compareSnapshot(s)}),
        s.type === "snapshot" ? K.button("Restore as copy", {size: "sm", run: () => restoreSnapshot(s), title: "Open this version as a private copy"}) :
          K.button("Board revisions…", {size: "sm", run: () => host.act("revisions")})));
      return out;
    }
    function localDetails() {
      return [heading("Local snapshots"),
        el("p", "hv-lede", "Autosave keeps a snapshot about every minute while you edit. Saves, checkpoints and board revisions are kept here too, on this computer."),
        actionsRow(K.button(expanded.has("local") ? "Fold" : "Show all", {variant: "primary", size: "sm", run: () => toggle("local")}),
          canCheckpoint() ? K.button("Save checkpoint", {size: "sm", run: checkpoint}) : null)];
    }
    function paintDetails(force) {
      if (closed) return;
      const pairKey = sel + "|" + (mark || "");
      if (!force && detailKey === pairKey && details.childElementCount) return;
      detailKey = items[keyIndex.get(sel)]?.type === "commit" && !mark ? sel : pairKey;
      const it = items[keyIndex.get(sel)];
      let nodes;
      if (!it) nodes = [K.empty({text: "Select an entry to see what changed."})];
      else if (it.type === "commit") nodes = commitDetails(it.c);
      else if (it.type === "working") nodes = workingDetails();
      else if (it.type === "edit") nodes = editDetails(it.e);
      else if (it.type === "local") nodes = localDetails();
      else nodes = snapshotDetails(it.s);
      details.replaceChildren(...nodes);
      details.scrollTop = 0;
    }

    function refreshHistory() {
      source.refresh({commits:true});
      summaries.clear(); full.clear();
      readLocal();
      if (scoped()) startObject(); else load(false);
    }

    // ---------------------------------------------------------------- lifecycle
    const offChange = host.on?.("change", () => {
      if (closed) return;
      const state = undoState();
      if (state.list.length !== editLine.length || state.list.some((step, i) => step !== editLine[i])) {
        readEdits(state);
        if (expanded.has("working")) rebuild(); else { paintRows(true); if (sel === "working") paintDetails(true); }
      } else if (sel === "working") paintRows(true);
    });
    const onVisible = () => {
      if (!document.hidden && !box.hidden) {
        paintDetails(true);
        schedule();
      } else {
        summaryTask?.controller.abort(); detailTask?.controller.abort();
        summaryTask = detailTask = null;
      }
    };
    const visibility = new MutationObserver(onVisible);
    visibility.observe(box, {attributes:true, attributeFilter:["hidden"]});
    document.addEventListener("visibilitychange", onVisible);
    const probe = el("div", "ui-row hv-row hv-probe"); probe.append(el("span", "ui-row-text", "M")); list.append(probe);
    rowH = Math.max(20, Math.round(probe.getBoundingClientRect().height) || 24); probe.remove();
    root.style.setProperty("--hv-row-h", rowH + "px");
    readEdits();
    rebuild();
    perf.shell = now() - perf.open;
    readLocal();
    if (!initial.target) load(false);

    return {
      apply(o = {}) {
        setBranchMode(o.file ? "file" : "all", !o.target);
        if (o.target) {
          const field = o.target.net ? "net" : "object", value = o.target.net || o.target.label;
          setQuery(field + ":" + JSON.stringify(value), true, o.target);
        } else if (objectTarget || o.file || o.select) setQuery("", true);
        if (o.select && keyIndex.has(o.select)) select(o.select);
        if (o.target) searchBox.input.focus({preventScroll:true});
        else scroller.focus({preventScroll:true});
      },
      dispose() {
        closed = true; ticket++; cancelIdle(); cancelObject();
        summaryTask?.controller.abort(); detailTask?.controller.abort();
        cancelAnimationFrame(frame); clearTimeout(scrollIdle); resize.disconnect(); visibility.disconnect();
        document.removeEventListener("visibilitychange", onVisible);
        if (typeof offChange === "function") offChange();
        fileReader?.close(); source.close();
      },
      refresh() { if (!source.current()) return false; refreshHistory(); return true; },
      // Tests and the design note's measurements.
      state: () => ({items: items.length, mounted: mounted.size, commits: commits.length, sel, mark, more, loading, rowHeight: rowH, graphWidth: graphW,
        query: {...query}, objectHits: scoped() ? objectResult?.entries.length ?? 0 : null, summaries: summaries.size, expanded: [...expanded]}),
      select: key => select(key), keyOf: i => items[i]?.key, paint: () => paintRows(false)
    };
  }

  function open(o = {}, current = () => true) {
    if (!current()) return null;
    perf.open = now(); perf.firstRows = 0; perf.renders = []; perf.longest = 0; perf.cached = false;
    G.AtriumDocViews.open(ID, {title:"History", icon:"history", mount:box => { instance = mount(box, o); },
      onClose:() => { instance?.dispose(); instance = null; }});
    instance?.apply(o);
    return instance;
  }
  const close = () => G.AtriumDocViews?.close?.(ID);
  G.addEventListener?.("atrium-host-project", close);
  G.addEventListener?.("atrium-git-binding", event => {
    if (instance && (event.detail?.fromSave || !instance.refresh())) close();
  });
  return Object.freeze({open, close, perf: () => ({...perf, renders: perf.renders.slice()}), state: () => instance?.state() || null,
    instance: () => instance, parseQuery});
})();
