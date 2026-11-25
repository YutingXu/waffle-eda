"use strict";
// AtriumDiffView: the visual design diff (Project › Compare…, Compare With… on a document, Review
// Changes, the History panel and the revision dialog all open it). Lazy; nothing here runs at startup.
//
// Layout: a diff editor over the editor area. Header: the two revisions (swap, change), the summary
// ("14 electrical · 32 layout · 5 cosmetic changes"), the DRC and routing deltas, the five views and
// Export. Left: documents with change counts. Centre: the canvases. Right: filters, the change list
// (grouped by severity, electrical first, then kind) and the inspector of the selected change.
//
// Views (one key each): 1 side by side (synchronised camera, linked crosshair), 2 overlay (onion-skin
// opacity), 3 swipe (draggable divider), 4 blink, 5 changes only (unchanged objects dimmed to 15 %).
// Keys inside the view: J / F7 next change, K / Shift+F7 previous, Enter zoom, F fit, X swap sides,
// [ ] onion or swipe, Space blink, / search, C comment, L copy link, G linked change on the other
// document, PageUp / PageDown document, Esc close. Each pane has a base canvas (AtriumCanvas, the
// real renderer), an ink canvas (highlights, ghosts, dimming) and a cross canvas (crosshair, pointer).
//
// Colours are the status tokens: added --success, removed --danger, moved / modified --warning,
// properties --info, lifted or darkened against the canvas so they read in every theme. Shape cues
// carry the same meaning without colour: solid + "+" added, dashed + "−" removed, ghost + arrow
// moved, double outline + "~" modified, dotted + "i" properties; every outline has a halo.
globalThis.AtriumDiffView = (() => {
  const G = globalThis;
  const M = () => G.AtriumDiffModel;
  const MODES = [["side", "Side by side", "1"], ["overlay", "Overlay", "2"], ["swipe", "Swipe", "3"], ["blink", "Blink", "4"], ["changes", "Changes only", "5"]];
  const STATUS_TOKEN = {added: "--success", removed: "--danger", moved: "--warning", modified: "--warning", properties: "--info"};
  const STATUS_FALLBACK = {added: "#4ec27a", removed: "#f0706a", moved: "#e5b84b", modified: "#e5b84b", properties: "#4aa3df"};
  // A severity filter's dot: electrical in danger, layout in warning, cosmetic in info.
  const SEV_TONE = {electrical: "danger", layout: "warning", cosmetic: "info"};
  const GLYPH = {added: "+", removed: "−", moved: "→", modified: "~", properties: "i"};
  const RECENT_KEY = "atrium.diff.recent.v1", PREF_KEY = "atrium.diff.prefs.v1";
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const btn = (text, fn, cls, label) => { const b = el("button", text, cls); b.type = "button";
    // Severity and change-type filters are library chips; the other small actions are library buttons.
    if (b.matches(".dv-filter")) b.classList.add("ui-chip");
    else if (b.matches(".dv-chip, .dv-tool")) { b.classList.add("ui-button"); b.dataset.size = "sm"; }
    if (b.classList.contains("dv-tool")) b.dataset.variant = "quiet";
    if (fn) b.onclick = fn;
    if (label) { b.setAttribute("aria-label", label); b.title = label; }
    return b; };
  const short = id => String(id || "").slice(0, 7);
  const now = () => G.performance?.now?.() ?? Date.now();
  const raf = f => (G.requestAnimationFrame || (g => setTimeout(() => g(now()), 16)))(f);
  const store = {get(k, d) { try { const v = JSON.parse(G.localStorage?.getItem(k) || "null"); return v ?? d; } catch { return d; } },
    set(k, v) { try { G.localStorage?.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } }};
  let host = null, S = null, outdated = null;
  // i18n (docs/translating.md): plain text is extracted into "diff" and translated where it is
  // rendered (the scope below); text with values goes through T(), model labels through tx().
  // Headless tests run without i18n.js: the stand-in formats the English table itself.
  // "\u0029" is ")": scripts/i18n-extract.py reads the table up to the first "})".
  const AtriumI18n = G.AtriumI18n || {define: o => (k, a) => o[k].replace(/\{(\w+)\}/g, (s, n) => a?.[n] ?? s)};
  const T = AtriumI18n.define({
    "diff.view.tag": "Tag {name}",
    "diff.view.branch": "Branch {name}",
    "diff.view.branch_current": "Branch {name} (current)",
    "diff.view.choose_before": "Choose the before project ZIP…",
    "diff.view.choose_after": "Choose the after project ZIP…",
    "diff.view.compare_doc": "Compare {name} with…",
    "diff.view.choose_revisions": "Compare: choose revisions",
    "diff.view.recent": "{before}  →  {after}",
    "diff.view.recent_file": "{before}  →  {after} (choose the file again)",
    "diff.view.compare_text": "Compare {text}",
    "diff.view.comparing": "Comparing {from} with {to}…",
    "diff.view.failed": "Comparison failed: {error}",
    "diff.view.announce": "{summary} between {from} and {to}. Press J for the first change.",
    "diff.view.announce_none": "No changes between {from} and {to}.",
    "diff.view.info": "Compare: {summary} · {from} → {to}",
    "diff.view.info_none": "Compare: no changes · {from} → {to}",
    "diff.view.before_rev": "Before: {rev}. Change revisions…",
    "diff.view.after_rev": "After: {rev}. Change revisions…",
    "diff.view.keys": "{change} next and previous · {kind} next kind · {electrical} electrical only · {zoom} zoom · {document} document · {fit} fit · {swap} swap · {search} search · {escape} back",
    "diff.view.mode": "{mode} view",
    "diff.view.cap_before": "Before · {rev}",
    "diff.view.cap_after": "After · {rev}",
    "diff.view.not_in": "Not in {rev}.",
    "diff.view.new_board": "New board · {name} · {count} objects · in {rev}",
    "diff.view.new_sheet": "New sheet · {name} · {count} objects · in {rev}",
    "diff.view.removed_board": "Board removed · {name} · {count} objects · was in {rev}",
    "diff.view.removed_sheet": "Sheet removed · {name} · {count} objects · was in {rev}",
    "diff.view.changes_here": "{count} changes here",
    "diff.view.sum_electrical": "{count} electrical",
    "diff.view.sum_layout": "{count} layout",
    "diff.view.sum_cosmetic": "{count} cosmetic",
    "diff.view.sum_change": "change",
    "diff.view.sum_changes": "changes",
    "diff.view.plus_more": "+{count} more",
    "diff.view.warning": "{count} warning",
    "diff.view.warnings": "{count} warnings",
    "diff.view.routing_net": "Routing Δ {count} net",
    "diff.view.routing_nets": "Routing Δ {count} nets",
    "diff.view.drc": "DRC +{added} new · {fixed} fixed",
    "diff.view.identical": "Identical: 0 electrical, 0 layout, 0 cosmetic changes.",
    "diff.view.ignored": "{count} differences that do not change the design (float noise, reordering, regenerated pour fill) were ignored.",
    "diff.view.ignored_short": "{count} non-design differences ignored",
    "diff.view.ignored_one": "1 non-design difference ignored",
    "diff.view.doc_new_board": "new board",
    "diff.view.doc_new_sheet": "new sheet",
    "diff.view.doc_removed": "removed",
    "diff.view.electrical_of": "{count} electrical of {total}",
    "diff.view.change": "{count} change",
    "diff.view.changes": "{count} changes",
    "diff.view.doc_board": "{name} (board), {changes}",
    "diff.view.doc_sheet": "{name} (sheet), {changes}",
    "diff.view.doc_added": "{label}, added",
    "diff.view.doc_removed_aria": "{label}, removed",
    "diff.view.layer_title": "{name}: {changes}. Click to show or hide; Shift+click to show only this layer.",
    "diff.view.count": "{label} {count}",
    "diff.view.filters_n": "Filters ({count}\u0029",
    "diff.view.group": "{label} · {count}",
    "diff.view.group_aria": "{label}, {count}",
    "diff.view.more_rows": "{count} more {kind} · narrow the filters or search to see them",
    "diff.view.hide_objects": "Hide its {count} objects",
    "diff.view.show_objects": "Show its {count} objects",
    "diff.view.also_on": "Also changed on {doc}; press G.",
    "diff.view.field_changed": "{field} changed from {before} to {after}",
    "diff.view.nothing": "nothing",
    "diff.view.more_fields": "More fields ({count}\u0029",
    "diff.view.show_on": "Show on {doc} (G)",
    "diff.view.merge": "Net merge: {before} → {after}",
    "diff.view.split": "Net split: {before} → {after}",
    "diff.view.rename": "Net rename: {before} → {after}",
    "diff.view.netlist_source": "Netlist source: before {before}, after {after}.",
    "diff.view.show_net": "Show the changes on {net}",
    "diff.view.after_lc": "after",
    "diff.view.drc_skipped": "Skipped on large boards ({boards}\u0029: the check runs on request.",
    "diff.view.swapped": "Sides swapped: {from} → {to}",
    "diff.view.copied": "Link copied: {link}",
    "diff.view.copy_failed": "Copy failed; the link is {link}",
    "diff.view.writing": "Writing the {kind} review report…",
    "diff.view.exported": "Exported {file}",
    "diff.view.export_failed": "Export failed: {error}",
    "diff.view.printing": "Preparing the review report for printing…",
    "diff.view.printed": "Sent {file} to the printer",
    "diff.view.print_failed": "Printing failed: {error}",
    "diff.view.progress": "Comparing… {pct}% · {count} changes so far",
    "diff.view.opacity": "Before opacity {pct}%",
    "diff.view.doc_count": "{name}, {count} changes",
    "diff.view.read_failed": "Could not read the last saved copy: {error}"
  });
  const tx = s => G.AtriumI18n?.text ? G.AtriumI18n.text(s, "diff") : s;
  // A group label such as "Electrical · Nets", part by part.
  const txs = s => String(s ?? "").split(" · ").map(tx).join(" · ");
  // Text that is design data (document and layer names) stays as written.
  const data = n => { n.translate = false; return n; };
  const SUM = {electrical: "diff.view.sum_electrical", layout: "diff.view.sum_layout", cosmetic: "diff.view.sum_cosmetic"};
  G.AtriumI18n?.scope?.(".dv, .dv-picker, .dv-docmenu, .dv-outdated", ["diff"]);

  // ------------------------------------------------------------------ colours
  let probe = null;
  function css(name) { try { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { return ""; } }
  function rgbOf(c) {
    if (!c) return null;
    probe ??= document.createElement("canvas").getContext("2d");
    if (!probe) return null;
    probe.fillStyle = "#010203"; probe.fillStyle = c;
    const v = String(probe.fillStyle);
    if (v === "#010203" && c.toLowerCase() !== "#010203") return null;
    const h = /^#([0-9a-f]{6})$/i.exec(v);
    if (h) return [0, 2, 4].map(i => parseInt(h[1].slice(i, i + 2), 16));
    const m = /rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)/.exec(v);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  const luma = c => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
  const rgb = c => "rgb(" + c.map(v => Math.round(v)).join(",") + ")";
  // A status colour that reads on this canvas: lifted on dark canvases, darkened on light ones.
  function inkFor(status, bg) {
    const c = rgbOf(css(STATUS_TOKEN[status])) || rgbOf(STATUS_FALLBACK[status]);
    if (!bg) return rgb(c);
    const L = luma(bg), l = luma(c);
    if (L < .42 && l < .55) return rgb(c.map(v => v + (255 - v) * .42));
    if (L > .6 && l > .5) return rgb(c.map(v => v * .58));
    return rgb(c);
  }
  // CIE76 ΔE between two sRGB colours (the same check theme-library.js runs for layer colours).
  function lab(c) {
    const f = v => { v /= 255; return v <= .04045 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); };
    const [r, g, b] = c.map(f), X = (r * .4124 + g * .3576 + b * .1805) / .95047, Y = r * .2126 + g * .7152 + b * .0722, Z = (r * .0193 + g * .1192 + b * .9505) / 1.08883;
    const h = t => t > .008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
    return [116 * h(Y) - 16, 500 * (h(X) - h(Y)), 200 * (h(Y) - h(Z))];
  }
  const deltaE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
  // Status inks that clash with the board's own copper colours are swapped for a fallback hue that
  // does not (magenta, cyan, then white or black), so a removed track on red Top copper still shows.
  const SPARE = [[255, 79, 216], [63, 224, 255], [190, 140, 255], [255, 255, 255], [20, 20, 20]];
  function copperColours(kind) {
    if (kind !== "pcb") return [];
    const P = G.AtriumPCBAppearance, out = [];
    for (const l of ["Top", "Bottom"]) { try { const c = rgbOf(P?.color?.(l)); if (c) out.push(c); } catch { /* no appearance */ } } // i18n-ignore
    return out;
  }
  function paletteFor(bg, kind) {
    const dark = !bg || luma(bg) < .5, out = {}, copper = copperColours(kind), used = [];
    for (const s of Object.keys(STATUS_TOKEN)) {
      if (s === "modified") { out.modified = out.moved; continue; }   // one token, one ink
      let c = rgbOf(inkFor(s, bg));
      if (copper.some(k => deltaE(c, k) < 40)) c = SPARE.find(x => !copper.some(k => deltaE(x, k) < 40) && !used.some(u => deltaE(x, u) < 15) && (!bg || deltaE(x, bg) > 30)) || c;
      used.push(c); out[s] = rgb(c);
    }
    const acc = rgbOf(css("--accent")) || [55, 148, 255];
    out.halo = dark ? "rgba(0,0,0,.78)" : "rgba(255,255,255,.9)";
    out.inner = dark ? "rgba(255,255,255,.95)" : "rgba(0,0,0,.9)";   // the thin neutral line inside every highlight
    out.cross = dark ? rgb(acc.map(v => v + (255 - v) * .35)) : rgb(acc.map(v => v * .75));
    out.ring = dark ? "#ffffff" : "#111111";
    out.dim = bg ? "rgba(" + bg.join(",") + ",.85)" : "rgba(0,0,0,.85)";
    out.shade = bg ? "rgba(" + bg.join(",") + ",.5)" : "rgba(0,0,0,.5)";
    out.electrical = rgb(rgbOf(inkFor("removed", bg)) || [240, 112, 106]);
    out.dark = dark;
    return out;
  }
  function motion() {
    const C = G.AtriumCamera;
    if (typeof C?.animate === "function") { try { return C.animate(); } catch { /* fall through */ } }
    if (typeof G.AtriumMotion?.level === "function") return G.AtriumMotion.level() === "full";
    const m = document.documentElement.getAttribute("data-motion");
    if (m === "reduce" || m === "off") return false;
    try { return !G.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches; } catch { return true; }
  }

  // ------------------------------------------------------------------ revisions
  const git = () => !!G.AtriumHost?.folderGitGrant;
  // A side: {type:"working"} | {type:"head"} | {type:"commit", rev, label} | {type:"ref", kind, name, rev} | {type:"file", name}
  function specLabel(s) {
    if (!s) return "";
    if (s.type === "working") return tx("Working design");
    if (s.type === "head") return "HEAD";
    if (s.type === "commit") return short(s.rev) + (s.label ? " · " + String(s.label).slice(0, 48) : "");
    if (s.type === "ref") return T(s.kind === "tag" ? "diff.view.tag" : "diff.view.branch", {name: s.name});
    if (s.type === "file") return String(s.name || "File").slice(0, 60);
    return String(s.type);
  }
  async function readSpec(s, side, say, active) {
    if (s.type === "file" && !s.project) say?.(T(side === "before" ? "diff.view.choose_before" : "diff.view.choose_after"));
    if (!G.AtriumGit) await G.AtriumLazy.need("AtriumGitPicker");
    return G.AtriumGit.readSpec(s, host, undefined, active);
  }
  function remember(b, a) {
    const key = x => JSON.stringify([x.type, x.rev || "", x.name || ""]);
    const list = store.get(RECENT_KEY, []).filter(r => !(key(r.b) === key(b) && key(r.a) === key(a)));
    const keep = s => ({type: s.type, rev: s.rev, label: s.label, name: s.name, kind: s.kind});
    list.unshift({b: keep(b), a: keep(a), at: Date.now()});
    store.set(RECENT_KEY, list.slice(0, 8));
  }

  // ------------------------------------------------------------------ picker
  // With the Git picker in the build (git-picker.js: commit graph, branches, tags, merge base) Compare…
  // uses it; the dialog below is the fallback (working design, saved files, HEAD and recent commits).
  let pendingDoc = null;
  function open(o = {}) {
    if (!host) return null;
    const L = G.AtriumLazy, hasGit = !!G.AtriumGitPicker || !!L?.modules?.().includes?.("AtriumGitPicker");
    if (hasGit && !o.fallback) {
      pendingDoc = o.doc || null;
      (G.AtriumGitPicker ? Promise.resolve(G.AtriumGitPicker) : L.need("AtriumGitPicker"))
        .then(P => P.comparePick({before: o.before, after: o.after, title: o.doc ? T("diff.view.compare_doc", {name: host.docById?.(o.doc)?.name || "document"}) : T("diff.view.choose_revisions")}))
        .catch(e => { pendingDoc = null; say(e.message); });
      return null;
    }
    return picker(o);
  }
  function picker(o) {
    const d = el("dialog", null, "work-dialog ui-dialog dv-picker"); d.setAttribute("aria-label", "Compare");
    const title = el("h2", o.doc ? T("diff.view.compare_doc", {name: host.docById?.(o.doc)?.name || "document"}) : "Compare: choose revisions");
    const body = el("div");
    body.append(el("p", "Show what changed between two versions of the design: side by side, overlaid, swiped or blinked, with every change listed and explained.", "dv-intro"));
    const grid = el("div", null, "dv-pick-grid");
    const sides = {b: el("select", null, "ui-field"), a: el("select", null, "ui-field")};
    sides.b.setAttribute("aria-label", "Before"); sides.a.setAttribute("aria-label", "After");
    const status = el("p", null, "dv-pick-status"); status.setAttribute("role", "status");
    const specs = new Map();
    let n = 0;
    const opt = (sel, group, s, text) => { const v = "s" + (++n); specs.set(v, s); const op = new Option(text || specLabel(s), v); (group || sel).append(op); return v; };
    const fill = (sel, refs, commits) => {
      sel.replaceChildren();
      const g1 = el("optgroup"); g1.label = "This design"; sel.append(g1);
      opt(sel, g1, {type: "working"});
      if (git()) {
        const g2 = el("optgroup"); g2.label = "Git"; sel.append(g2);
        opt(sel, g2, {type: "head"}, "HEAD (last commit)");
        for (const r of refs?.branches || []) opt(sel, g2, {type: "ref", kind: "branch", name: r.name, rev: r.revision}, T(r.current ? "diff.view.branch_current" : "diff.view.branch", {name: r.name}));
        for (const r of refs?.tags || []) opt(sel, g2, {type: "ref", kind: "tag", name: r.name, rev: r.revision}, T("diff.view.tag", {name: r.name}));
        if (commits?.length) {
          const g3 = el("optgroup"); g3.label = "Commits"; sel.append(g3);
          for (const c of commits) opt(sel, g3, {type: "commit", rev: c.revision, label: c.subject || ""},
            [String(c.date || "").slice(0, 10), String(c.subject || "(no subject)").slice(0, 70), short(c.revision)].filter(Boolean).join(" · "));
        }
      }
      const g4 = el("optgroup"); g4.label = "File"; sel.append(g4);
      opt(sel, g4, {type: "file"}, "Saved project ZIP…");
    };
    const pickBy = (sel, test) => { for (const op of sel.options) if (test(specs.get(op.value))) { sel.value = op.value; return true; } return false; };
    const preset = () => {
      const b = o.before, a = o.after;
      if (b) pickBy(sides.b, s => s.type === b.type && (!b.rev || s.rev === b.rev) && (!b.name || s.name === b.name));
      else if (!pickBy(sides.b, s => s.type === "head")) pickBy(sides.b, s => s.type === "file");
      if (a) pickBy(sides.a, s => s.type === a.type && (!a.rev || s.rev === a.rev)); else pickBy(sides.a, s => s.type === "working");
    };
    fill(sides.b); fill(sides.a); preset();
    const swap = btn("⇄", () => { const v = sides.b.value, w = sides.a.value; const sb = specs.get(v), sa = specs.get(w);
      pickBy(sides.b, s => s === sa || JSON.stringify(s) === JSON.stringify(sa)); pickBy(sides.a, s => s === sb || JSON.stringify(s) === JSON.stringify(sb)); }, "dv-swap ui-button", "Swap sides");
    const col = (t, s) => { const l = el("label", null, "dv-pick-side"); l.append(el("span", t), s); return l; };
    grid.append(col("Before", sides.b), swap, col("After", sides.a));
    const docRow = el("label", null, "work-row dv-pick-doc"), docSel = el("select", null, "ui-field");
    docSel.setAttribute("aria-label", "Open on");
    docSel.add(new Option("First document with changes", ""));
    for (const x of host.project().documents) docSel.add(new Option(x.name, x.id));
    if (o.doc) docSel.value = o.doc;
    docRow.append(el("span", "Open on"), docSel);
    const recents = el("div", null, "dv-recents");
    const list = store.get(RECENT_KEY, []);
    if (list.length) {
      recents.append(el("h3", "Recent"));
      for (const r of list.slice(0, 6)) {
        const text = T(r.b.type === "file" || r.a.type === "file" ? "diff.view.recent_file" : "diff.view.recent", {before: specLabel(r.b), after: specLabel(r.a)});
        recents.append(btn(text, () => go(r.b, r.a), "dv-recent", T("diff.view.compare_text", {text})));
      }
    }
    let alive = true, busy = false;
    const opened = host.project(), file = host.fileSession?.();
    const active = () => alive && host.project() === opened && host.fileSession?.() === file;
    if (git()) {
      status.textContent = "Reading the Git history…";
      Promise.all([G.AtriumHost.gitRefs ? G.AtriumHost.gitRefs().catch(() => null) : null, G.AtriumHost.gitHistory ? G.AtriumHost.gitHistory().catch(e => ({error: e})) : null]).then(([refs, hist]) => {
        if (!alive) return;
        const commits = Array.isArray(hist?.commits) ? hist.commits.slice(0, 200) : [];
        fill(sides.b, refs, commits); fill(sides.a, refs, commits); preset();
        status.textContent = hist?.error ? hist.error.message : commits.length ? "" : "This file has no commit history yet.";
      });
    } else status.textContent = "Compare the working design with a saved project ZIP, or compare two ZIPs. Git history, branches and tags are available in the desktop app for a saved project.";
    async function go(b, a) {
      if (busy) return;
      if (JSON.stringify(b) === JSON.stringify(a) && b.type !== "file") { status.textContent = "Choose two different revisions."; return; }
      busy = true; run.disabled = true;
      try {
        const B = await readSpec(b, "before", t => { status.textContent = t; }, active); if (!B || !active()) return;
        const Aa = await readSpec(a, "after", t => { status.textContent = t; }, active); if (!Aa || !active()) return;
        remember(B.spec, Aa.spec);
        d.close();
        await start(B, Aa, {doc: docSel.value || o.doc || null});
      } catch (e) { if (alive) status.textContent = e.message; }
      finally { busy = false; run.disabled = false; }
    }
    const run = btn("Compare", () => go(specs.get(sides.b.value), specs.get(sides.a.value)), "is-primary");
    const foot = el("div", null, "work-actions ui-dialog-actions"); foot.append(status, btn("Cancel", () => d.close()), run);
    body.append(grid, docRow, recents);
    d.append(title, body, foot);
    G.AtriumShell.openDialog(d, {title, body, actions: foot, initialFocus: sides.b, beforeRemove() { alive = false; }});
    return d;
  }

  // ------------------------------------------------------------------ session
  const defsOf = p => new Map((p?.library || []).map(d => [d.id, d]));
  async function start(b, a, o = {}) {
    if (!host) throw Error("The editor is not ready.");
    if (!b?.project || !a?.project) throw Error("Both revisions are needed.");
    if (o.active?.() === false) return null;
    if (a.working && G.AtriumImportReports) b = {...b, project:await G.AtriumImportReports.comparison(b.project)};
    if (o.active?.() === false) return null;
    if (!o.doc && pendingDoc) o = {...o, doc: pendingDoc};
    pendingDoc = null;
    close(true);
    const t0 = now();
    const prefs = store.get(PREF_KEY, {});
    const model = M().create(b.project, a.project, {from: b.label || "Before", to: a.label || "After", missingSide: !!(b.missing || a.missing)});
    S = {model, b, a, t0, mode: MODES.some(m => m[0] === prefs.mode) ? prefs.mode : "side", onion: Number.isFinite(prefs.onion) ? prefs.onion : .5, swipe: .5,
      blink: {on: false, auto: motion(), delay: null}, cam: null, doc: null, current: null, list: [], pointer: null, hidden: new Map(),
      filter: {severities: new Set(M().SEVERITIES.filter(x => x !== "cosmetic" || !prefs.hideCosmetic)), statuses: new Set(M().STATUSES), hideCosmetic: false, query: "", kind: "", net: "", layer: "", scope: "all"},
      groupBy: prefs.groupBy === "severity" ? "severity" : "document", expanded: new Set(), sideW: Number.isFinite(prefs.sideW) ? prefs.sideW : 340,
      returnFocus: document.activeElement, metrics: {start: t0}, token: {}, defs: [defsOf(b.project), defsOf(a.project)], wanted: o.doc || null, focusKey: o.focus || null, focusItem: o.focusItem || null};
    // A large pair compares in a worker: start it now so its scripts load while both revisions paint.
    try { G.AtriumDiff?.warm?.(b.project, a.project); } catch { /* the comparison starts it */ }
    build(o.reviewAction);
    // First paint: both revisions of the chosen (or first) document, before any comparison.
    const docs = docList();
    S.doc = (o.doc && docs.some(d => d.id === o.doc) ? o.doc : null) || host.currentId?.() && docs.find(d => d.id === host.currentId())?.id || docs[0]?.id || null;
    paintDocs(); fitDoc(); renderNow();
    S.metrics.firstPaint = now() - t0;
    progress(0, T("diff.view.comparing", {from: model.from, to: model.to}));
    const token = S.token;
    let pending = 0;
    // The first rows paint on the next frame; later batches are coalesced (a full refresh of a 5k list is ~45 ms).
    let shown = false;
    const paintPartial = () => {
      pending = 0;
      if (S?.token !== token || model.done) return;
      refresh();
      S.metrics.firstList ??= now() - t0;
    };
    const soon = () => {
      if (pending) return;
      pending = shown ? setTimeout(paintPartial, 120) : raf(paintPartial);
      shown = true;
    };
    // Post to the worker after the first frame is on screen.
    await new Promise(r => raf(() => setTimeout(r, 0)));
    if (S?.token !== token) return null;
    // The one engine (diff.js); lazy.js lists it as a dependency, so this only covers an unusual load order.
    if (typeof G.AtriumDiff?.compare !== "function" && G.AtriumLazy?.need) { try { await G.AtriumLazy.need("AtriumDiff"); } catch { /* fallback core */ } }
    if (S?.token !== token) return null;
    try {
      await model.run({active: () => S?.token === token, onPartial: () => { S.metrics.firstChanges ??= now() - t0; soon(); }, onProgress: p => progress(p)});
    } catch (e) {
      if (S?.token === token) { progress(null); say(T("diff.view.failed", {error: e.message})); }
      return null;
    }
    if (S?.token !== token) return null;
    S.metrics.diffDone = now() - t0;
    progress(null);
    if (!S.wanted) { const first = model.ordered(visible(), S.groupBy)[0]; if (first && first.doc !== S.doc && !(model.docCounts().get(S.doc)?.total)) switchDoc(first.doc, false); }
    refresh();
    S.metrics.firstList ??= now() - t0;
    // Open on the changes, never on an empty corner of the sheet; preselect the first electrical change
    // (without flying) so the inspector says what changed.
    fitChanges();
    if (!S.focusKey || !S.current) { const ele = S.list.find(c => c.severity === "electrical" && c.doc === S.doc) || S.list.find(c => c.doc === S.doc); if (ele) select(ele, {fly: false, quiet: true}); }
    renderNow();
    const total = model.changes.length;
    announce(total ? T("diff.view.announce", {summary: model.summary().text, from: model.from, to: model.to}) : T("diff.view.announce_none", {from: model.from, to: model.to}));
    if (S.focusKey) {
      // The same change after a swap: its key, else the same object (ids swap sides) or designator.
      const ids = new Set(S.focusItem || []);
      const c = model.changes.find(x => x.key === S.focusKey) || model.changes.find(x => ids.has(x.item) || ids.has(x.beforeItem) || x.ref && ids.has(x.ref));
      if (c) select(c, {fly: true});
    }
    host.info?.(total ? T("diff.view.info", {summary: model.summary().text, from: model.from, to: model.to}) : T("diff.view.info_none", {from: model.from, to: model.to}));
    if (S.reviewButton) S.reviewButton.disabled = false;
    drcLater(token);
    return S;
  }
  function close(quiet = false) {
    for(const p of S?.panes||[])p.releaseInput?.();
    if (outdated) { outdated.close(); outdated.remove(); outdated = null; }
    if (!S) return;
    S.powerOff?.();
    stopBlink(S);
    S.token = null;
    S.ro?.disconnect?.();
    S.root?.remove();
    document.getElementById("editor-area")?.classList.remove("dv-open");
    const back = S.returnFocus, folded = S.folded || [];
    S.themeOff?.();
    S = null;
    for (const a of folded) { try { host.act?.(a); } catch { /* the pane stays folded */ } }
    if (!quiet) {
      // Back to where the user was; a dialog's button that is gone or <body> means the editor canvas.
      const target = back?.isConnected && back !== document.body && !back.closest?.("dialog") ? back : host.canvas?.() || document.getElementById("canvas");
      target?.focus?.();
      host.info?.("Compare closed"); host.invalidate?.();
    }
  }
  // The geometry and rows retain references to the working model. Once it changes,
  // retire that comparison (including any worker). Refresh is explicit and uses the latest edit.
  function workingChanged() {
    if (!S || !(S.a.working || S.b.working)) return;
    const {a, b, doc} = S;
    close(true);
    const d = el("dialog", null, "work-dialog ui-dialog dv-outdated");
    const title = el("h2", "The working design changed");
    d.setAttribute("aria-label", title.textContent);
    const refresh = btn("Refresh comparison", async () => {
      refresh.disabled = true;
      try {
        const side = s => s.working ? {...s, project: host.project()} : s;
        if (outdated === d) await start(side(b), side(a), {doc});
      } catch (e) { say(e.message); }
    }, "is-primary");
    const foot = el("div", null, "work-actions ui-dialog-actions");
    foot.append(btn("Close", () => d.close()), refresh); d.append(title, foot);
    outdated = d;
    G.AtriumShell.openDialog(d, {title, actions: foot, initialFocus: refresh, beforeRemove() { if (outdated === d) outdated = null; }});
  }
  function say(t) { if (S?.live) S.live.textContent = t; host?.info?.(t); }
  function announce(t) { if (S?.live) { S.live.textContent = ""; setTimeout(() => { if (S?.live) S.live.textContent = t; }, 30); } }
  function savePrefs() { store.set(PREF_KEY, {mode: S.mode, onion: S.onion, hideCosmetic: !S.filter.severities.has("cosmetic"), groupBy: S.groupBy, sideW: S.sideW}); }
  // Documents as the engine paired them once it has answered; until then, by id from the two projects.
  function docList() {
    const m = S.model, seen = new Map();
    for (const d of m.docs) seen.set(d.id, d);
    if (m.done) return [...seen.values()].filter(d => d.kind === "pcb" || d.kind === "schematic");
    for (const d of [...(S.a.project.documents || []), ...(S.b.project.documents || [])]) {
      if (seen.has(d.id) || (d.kind !== "pcb" && d.kind !== "schematic")) continue;
      const inA = (S.a.project.documents || []).some(x => x.id === d.id), inB = (S.b.project.documents || []).some(x => x.id === d.id);
      seen.set(d.id, {id: d.id, name: d.name, kind: d.kind, side: inA && inB ? "both" : inA ? "added" : "removed", before: inB ? d.id : null, after: inA ? d.id : null});
    }
    return [...seen.values()].filter(d => d.kind === "pcb" || d.kind === "schematic");
  }

  // ------------------------------------------------------------------ DOM
  function build(reviewAction) {
    const area = document.getElementById("editor-area") || document.body;
    area.classList.add("dv-open");
    // The comparison has its own documents rail and inspector: fold the Projects and Properties
    // panes while it is open (restored on close), so both revisions get the width.
    S.folded = [];
    for (const [cls, a] of [["hide-left", "toggle-left"], ["hide-right", "toggle-right"]])
      if (!document.body.classList.contains(cls) && host.act) { try { host.act(a); S.folded.push(a); } catch { /* keep the panes */ } }
    // The Messages panel under the editor (an import's notes, check results) folds too; it returns on close.
    try { if (G.AtriumMessages?.isOpen?.() && host.act) { G.AtriumMessages.close(); S.folded.push("messages"); } } catch { /* it stays */ }
    const root = el("section", null, "dv mode-" + S.mode); root.setAttribute("aria-label", "Design comparison"); root.tabIndex = -1;
    S.root = root;
    // Header
    const head = el("header", null, "dv-head");
    const range = el("div", null, "dv-range");
    S.fromBtn = btn(S.model.from, () => open({before: S.b.spec, after: S.a.spec, doc: S.doc}), "dv-rev dv-rev-before ui-button", T("diff.view.before_rev", {rev: S.model.from}));
    S.toBtn = btn(S.model.to, () => open({before: S.b.spec, after: S.a.spec, doc: S.doc}), "dv-rev dv-rev-after ui-button", T("diff.view.after_rev", {rev: S.model.to}));
    range.append(el("span", "Before", "dv-side-tag"), S.fromBtn, btn("⇄", swapSides, "dv-swap ui-button", "Swap sides (X)"), el("span", "After", "dv-side-tag"), S.toBtn);
    const summary = el("div", null, "dv-summary");
    S.sumText = el("strong", "Comparing…", "dv-sum"); S.sumText.setAttribute("aria-live", "polite");
    const unavailable = Math.max(S.a.unavailableLibraries || 0, S.b.unavailableLibraries || 0);
    if (unavailable) summary.append(el("span", String(unavailable) + " referenced " +
      (unavailable === 1 ? "library" : "libraries") + " unavailable", "dv-source-notice"));
    S.drcBtn = btn("DRC Δ …", () => togglePop("drc"), "dv-chip dv-drc", "Design rule check delta: new and fixed violations");
    S.routeBtn = btn("Routing Δ", () => togglePop("routing"), "dv-chip dv-routing", "Per-net routing delta: length and vias");
    S.warnBtn = btn("", () => togglePop("warnings"), "dv-chip dv-warn", "Comparison warnings");
    S.matchBtn = btn("Component matches", () => togglePop("matches"), "dv-chip");
    S.matchBtn.hidden = S.drcBtn.hidden = S.routeBtn.hidden = S.warnBtn.hidden = true;
    summary.append(S.sumText, S.warnBtn, S.matchBtn, S.drcBtn, S.routeBtn);
    S.headline = el("p", null, "dv-headline"); S.headline.hidden = true;
    const modes = el("div", null, "dv-modes ui-segmented"); modes.setAttribute("role", "radiogroup"); modes.setAttribute("aria-label", "View");
    S.modeBtns = new Map();
    for (const [id, label, key] of MODES) {
      const b = btn(label, () => setMode(id), "dv-mode ui-segment");
      AtriumNavCommon.shortcutTitle(b, tx(label), key);
      b.setAttribute("role", "radio"); b.dataset.mode = id; b.append(AtriumShortcut.render(key, {variant:"inline"}));
      modes.append(b); S.modeBtns.set(id, b);
    }
    // One tab stop for the group; arrows move between views (radio group pattern).
    modes.addEventListener("keydown", e => {
      const d = {ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1}[e.key];
      if (!d) return;
      e.preventDefault(); e.stopPropagation();
      const i = MODES.findIndex(m => m[0] === S.mode), next = MODES[(i + d + MODES.length) % MODES.length][0];
      setMode(next); S.modeBtns.get(next).focus();
    });
    const onion = el("label", null, "dv-onion"), range2 = el("input");
    range2.type = "range"; range2.min = "0"; range2.max = "100"; range2.value = String(Math.round(S.onion * 100)); range2.setAttribute("aria-label", "Before opacity (onion skin)");
    range2.oninput = () => { S.onion = +range2.value / 100; applyMode(); savePrefs(); };
    onion.append(el("span", "Before ◀"), range2, el("span", "▶ After")); S.onionInput = range2; S.onionBox = onion;
    const blinkBox = el("label", null, "dv-blink"), blinkAuto = el("input", null, "ui-checkbox");
    blinkAuto.type = "checkbox"; blinkAuto.checked = S.blink.auto; blinkAuto.onchange = () => { S.blink.auto = blinkAuto.checked; applyMode(); };
    blinkBox.append(blinkAuto, el("span", "Auto (Space flips)")); S.blinkBox = blinkBox;
    const acts = el("div", null, "dv-actions");
    if (reviewAction) {
      S.reviewButton = btn(reviewAction.label, reviewAction.run, "is-primary ui-button");
      S.reviewButton.dataset.variant = "primary";
      S.reviewButton.disabled = true;
      acts.append(S.reviewButton);
    }
    acts.append(btn("Export…", e => exportMenu(e.currentTarget), "dv-export ui-button", "Export the comparison as a PDF or HTML review report"), btn("Close", () => close(), "dv-close ui-button", "Close the comparison (Esc)"));
    const viewbar = el("div", null, "dv-viewbar");
    const keys = el("span", null, "dv-keys");
    keys.append(...AtriumNavCommon.shortcutParts(T("diff.view.keys"), {
      change:["J", "K"], kind:["Shift+J", "Shift+K"], electrical:"E", zoom:["PageUp", "PageDown"],
      document:["Mod+PageUp", "Mod+PageDown"], fit:"F", swap:"X", search:"/", escape:"Escape"
    }));
    viewbar.append(modes, onion, blinkBox, keys);
    head.append(range, summary, acts, S.headline, viewbar);
    // Body
    const body = el("div", null, "dv-body");
    const nav = el("nav", null, "dv-docs"); nav.setAttribute("aria-label", "Documents");
    S.docsNode = nav;
    const stage = el("div", null, "dv-stage"); S.stage = stage;
    const panes = el("div", null, "dv-panes"); S.panesNode = panes;
    S.panes = ["before", "after"].map(side => {
      const p = el("div", null, "dv-pane dv-" + side), cap = el("div", null, "dv-caption");
      const base = el("canvas", null, "dv-base"), ink = el("canvas", null, "dv-ink"), cross = el("canvas", null, "dv-cross");
      base.setAttribute("aria-hidden", "true"); ink.setAttribute("aria-hidden", "true");
      cross.tabIndex = 0; cross.setAttribute("role", "img");
      const empty = el("div", null, "dv-pane-empty"); empty.hidden = true;
      p.append(base, ink, cross, cap, empty);
      panes.append(p);
      return {side, node: p, cap, base, ink, cross, empty, view: G.AtriumCanvas.create(base), bg: null, pal: null};
    });
    const handle = el("div", null, "dv-handle"); handle.setAttribute("role", "slider"); handle.tabIndex = 0;
    handle.setAttribute("aria-label", "Swipe divider: before on the left, after on the right"); handle.setAttribute("aria-valuemin", "0"); handle.setAttribute("aria-valuemax", "100");
    panes.append(handle); S.handle = handle;
    const prog = el("div", null, "dv-progress"); prog.setAttribute("role", "status"); prog.append(el("div", null, "ui-progress"), el("span")); S.prog = prog;
    const layers = el("div", null, "dv-layers"); layers.setAttribute("role", "toolbar"); layers.setAttribute("aria-label", "Layers: change counts; click to show or hide, Shift+click to show only that layer");
    S.layersNode = layers;
    stage.append(panes, prog, layers);
    const side = el("aside", null, "dv-side"); side.setAttribute("aria-label", "Changes");
    const filters = el("div", null, "dv-filters");
    const search = el("input", null, "dv-search ui-field"); search.type = "search"; search.placeholder = "Find a designator, net, layer…"; search.setAttribute("aria-label", "Find changes (/)");
    search.oninput = () => { S.filter.query = search.value; refreshList(); };
    S.search = search;
    const sev = el("div", null, "dv-sev"); sev.setAttribute("role", "group"); sev.setAttribute("aria-label", "Severity (E: electrical only)");
    S.sevBtns = new Map();
    for (const s of M().SEVERITIES) {
      const b = btn(null, () => { toggle(S.filter.severities, s); refresh(); }, "dv-filter dv-sev-" + s);
      const dot = el("span", null, "ui-dot"); dot.dataset.tone = SEV_TONE[s] || "";
      b.append(dot, el("span", M().SEVERITY_LABEL[s]));
      b.dataset.sev = s; sev.append(b); S.sevBtns.set(s, b);
    }
    const st = el("div", null, "dv-status"); st.setAttribute("role", "group"); st.setAttribute("aria-label", "Change type");
    S.stBtns = new Map();
    for (const s of M().STATUSES) {
      const b = btn(null, () => { toggle(S.filter.statuses, s); refresh(); }, "dv-filter dv-st", M().STATUS_LABEL[s]);
      b.dataset.status = s; b.append(el("i", GLYPH[s], "dv-glyph"), el("span", M().STATUS_LABEL[s]));
      st.append(b); S.stBtns.set(s, b);
    }
    const more = el("div", null, "dv-more");
    const sel = (label, key) => { const s = el("select", null, "ui-field"); s.setAttribute("aria-label", label); s.onchange = () => { S.filter[key] = s.value; refresh(); }; more.append(s); return s; };
    S.kindSel = sel("Kind", "kind"); S.netSel = sel("Net", "net"); S.layerSel = sel("Layer", "layer"); S.scopeSel = sel("Documents", "scope");
    const grp = el("select", null, "ui-field"); grp.setAttribute("aria-label", "Group by");
    grp.add(new Option("Group by document", "document")); grp.add(new Option("Group by severity", "severity")); grp.value = S.groupBy;
    grp.onchange = () => { S.groupBy = grp.value; savePrefs(); refresh(); };
    more.append(grp);
    // Search and severity stay in view; status, kind, net, layer and grouping fold into "Filters".
    const top = el("div", null, "dv-filter-top"), fold = el("details", null, "dv-filter-more"), sum = el("summary", "Filters");
    S.filterSummary = sum;
    fold.append(sum, st, more);
    top.append(S.searchWrap = AtriumUI.searchField(search), sev);
    filters.append(top, fold);
    const list = el("div", null, "ui-list dv-list"); list.dataset.layout = "flush"; list.setAttribute("role", "listbox"); list.setAttribute("aria-label", "Changes"); list.tabIndex = 0; S.listNode = list;
    const insp = el("section", null, "dv-inspect"); insp.setAttribute("aria-label", "Selected change"); S.inspNode = insp;
    side.append(filters, list, insp);
    // The change column can be widened: drag its edge (or arrow keys on it); the width is remembered.
    const sash = el("div", null, "dv-side-sash"); sash.setAttribute("role", "separator"); sash.setAttribute("aria-orientation", "vertical"); sash.tabIndex = 0;
    sash.setAttribute("aria-label", "Resize the change list");
    const setW = w => { S.sideW = Math.round(Math.min(720, Math.max(260, w))); root.style.setProperty("--dv-side-w", S.sideW + "px"); };
    setW(S.sideW);
    sash.addEventListener("pointerdown", e => {
      e.preventDefault(); sash.setPointerCapture?.(e.pointerId);
      const r = root.getBoundingClientRect(), mv = ev => { setW(r.right - ev.clientX); for (const p of S.panes) p.view.resized?.(); renderSoon(); };
      const up = () => { sash.removeEventListener("pointermove", mv); sash.removeEventListener("pointerup", up); savePrefs(); };
      sash.addEventListener("pointermove", mv); sash.addEventListener("pointerup", up);
    });
    sash.addEventListener("keydown", e => { const d = {ArrowLeft: 20, ArrowRight: -20}[e.key]; if (!d) return; e.preventDefault(); e.stopPropagation(); setW(S.sideW + d); savePrefs(); renderSoon(); });
    side.prepend(sash);
    body.append(nav, stage, side);
    const live = el("div", null, "visually-hidden"); live.setAttribute("role", "status"); live.setAttribute("aria-live", "polite"); S.live = live;
    const pop = el("div", null, "dv-pop ui-popover"); pop.hidden = true; pop.setAttribute("role", "dialog"); S.pop = pop;
    root.append(head, body, live, pop);
    area.append(root);
    bindStage(); bindKeys(); bindList();
    S.powerOff = G.AtriumPower?.onChange?.(syncBlink);
    applyMode();
    S.ro = typeof ResizeObserver === "function" ? new ResizeObserver(() => { for (const p of S?.panes || []) p.view.resized?.(); renderSoon(); }) : null;
    S.ro?.observe(panes);
    // A theme change repaints with the new layer and status colours.
    S.themeOff = G.AtriumTheme?.onChange?.(() => { if (!S) return; for (const p of S.panes) { p.bg = null; p.pal = null; } renderSoon(); }) || null;
    list.focus();
  }
  function icon(d) {
    const NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), path = document.createElementNS(NS, "path");
    svg.setAttribute("viewBox", "0 0 20 20"); svg.setAttribute("aria-hidden", "true"); svg.setAttribute("class", "icon");
    path.setAttribute("d", d); svg.append(path); return svg;
  }
  function toggle(set, v) { if (set.has(v)) set.delete(v); else set.add(v); }

  // ------------------------------------------------------------------ views
  function setMode(id) {
    if (!S || !MODES.some(m => m[0] === id)) return;
    S.mode = id; savePrefs(); applyMode();
    announce(T("diff.view.mode", {mode: tx(MODES.find(m => m[0] === id)[1])}));
  }
  function applyMode() {
    const r = S.root;
    for (const [id] of MODES) r.classList.toggle("mode-" + id, id === S.mode);
    for (const [id, b] of S.modeBtns) {
      const selected = id === S.mode;
      b.setAttribute("aria-checked", String(selected)); b.tabIndex = selected ? 0 : -1;
    }
    S.onionBox.hidden = S.mode !== "overlay"; S.blinkBox.hidden = S.mode !== "blink";
    const before = S.panes[0].node;
    before.style.opacity = S.mode === "overlay" ? String(S.onion) : "";
    S.panesNode.style.setProperty("--dv-swipe", (S.swipe * 100).toFixed(2) + "%");
    S.handle.hidden = S.mode !== "swipe"; S.handle.setAttribute("aria-valuenow", String(Math.round(S.swipe * 100)));
    stopBlink(S);
    syncBlink();
    applyBlink();
    for (const p of S.panes) p.view.resized?.();
    renderSoon();
  }
  function stopBlink(state) {
    state.blink.delay?.cancel();
    state.blink.delay = null;
  }
  function syncBlink() {
    const state = S;
    if (!state) return;
    const blink = state.blink;
    if (state.mode !== "blink" || !blink.auto || G.AtriumPower?.efficient?.()) { stopBlink(state); return; }
    if (blink.delay) return;
    blink.delay = G.AtriumMotion?.afterVisible?.(650, () => {
      blink.delay = null;
      if (S !== state) return;
      blink.on = !blink.on;
      applyBlink();
      syncBlink();
    });
  }
  function applyBlink() {
    const show = S.mode !== "blink" || S.blink.on;
    S.panes[0].node.classList.toggle("is-off", !show);
    S.panes[1].cap.textContent = S.mode === "blink" ? (S.blink.on ? T("diff.view.cap_before", {rev: S.model.from}) : T("diff.view.cap_after", {rev: S.model.to})) : T("diff.view.cap_after", {rev: S.model.to});
  }
  // Which panes draw which sides: side by side keeps them apart, the stacked views draw both in the after pane's ink.
  const stacked = () => S.mode !== "side";
  function docPair() {
    const d = docList().find(x => x.id === S.doc);
    if (!d) return {d: null, d0: null, d1: null};
    const s = S.model.sides(d.id);
    return {d, d0: s.before || (S.b.project.documents || []).find(x => x.id === (d.before ?? d.id)) || null, d1: s.after || (S.a.project.documents || []).find(x => x.id === (d.after ?? d.id)) || null};
  }
  function renderOpts(doc) {
    const hid = S.hidden.get(S.doc) || new Set();
    return doc.kind === "pcb" ? {hidden: hid, layer: "Top", layerMode: "all", grid: true, showUnrouted: false, selectedIds: new Set(), origin: false} // i18n-ignore
      : {hidden: new Set(), selectedIds: new Set(), grid: true};
  }
  let frame = 0, moving = false;
  function renderSoon(gesture = false) {
    if (!S) return;
    moving = moving || gesture;
    if (frame) return;
    frame = raf(() => { frame = 0; const g = moving; moving = false; renderNow(g); });
  }
  // A document that only one revision has: one clean pane with a banner, no per-object confetti.
  function wholeDoc() { const d = docList().find(x => x.id === S.doc); return d && d.side !== "both" ? d : null; }
  function renderNow(gesture = false) {
    if (!S) return;
    const {d0, d1} = docPair(), whole = wholeDoc();
    S.panesNode.classList.toggle("is-single", !!whole && S.mode === "side");
    for (const p of S.panes) {
      const doc = p.side === "before" ? d0 : d1;
      const hide = p.side === "before" && S.mode === "changes" || !!whole && S.mode === "side" && !doc;
      p.node.hidden = hide;
      p.empty.hidden = !!doc || hide;
      if (!doc) { p.empty.textContent = T("diff.view.not_in", {rev: p.side === "before" ? S.model.from : S.model.to}); clear(p.ink); clear(p.base); continue; }
      if (hide) continue;
      if (S.cam) p.view.restoreCamera(S.cam);
      if (gesture) p.view.moving?.();
      try { p.view.render(doc, p.side === "before" ? S.defs[0] : S.defs[1], renderOpts(doc)); } catch (e) { G.console?.error?.(e); }
      if (!p.bg || p.bgKind !== doc.kind) { p.bg = sample(p.base); p.bgKind = doc.kind; p.pal = paletteFor(p.bg, doc.kind); p.palAt = now(); }
      else if (now() - p.palAt > 1500) { p.pal = paletteFor(p.bg, doc.kind); p.palAt = now(); }
      if (whole) {
        const n = S.model.wholeCount?.(whole.id) || doc.items.length, what = whole.kind === "pcb" ? "board" : "sheet";
        p.cap.textContent = whole.side === "added" ? T(whole.kind === "pcb" ? "diff.view.new_board" : "diff.view.new_sheet", {name: whole.name, count: n, rev: S.model.to})
          : T(whole.kind === "pcb" ? "diff.view.removed_board" : "diff.view.removed_sheet", {name: whole.name, count: n, rev: S.model.from});
      } else if (p.side === "before") p.cap.textContent = T("diff.view.cap_before", {rev: S.model.from});
      else if (S.mode !== "blink") p.cap.textContent = T("diff.view.cap_after", {rev: S.model.to});
    }
    paintInk();
    paintCross();
  }
  function clear(c) { const g = c.getContext("2d"); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, c.width, c.height); }
  function sample(c) { try { const d = c.getContext("2d").getImageData(2, 2, 1, 1).data; return [d[0], d[1], d[2]]; } catch { return null; } }
  function sizeTo(c, ref) {
    const r = ref.getBoundingClientRect(), dpr = Math.max(1, Math.min(4, G.devicePixelRatio || 1));
    const w = Math.round(r.width * dpr), h = Math.round(r.height * dpr);
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return {w: r.width, h: r.height, dpr};
  }
  // F: the whole board (its outline) or the whole sheet (its frame, title block included).
  function fitDoc() {
    const {d0, d1} = docPair(), doc = d1 || d0;
    if (!doc) return;
    const p = d1 && !S.panes[1].node.hidden ? S.panes[1] : S.panes[0];
    try { p.view.fit(doc, d1 ? S.defs[1] : S.defs[0], doc.kind === "pcb" ? "board" : "document"); } catch { /* empty document */ }
    S.cam = p.view.camera();
  }
  // Open and Home: fit the changes on this document (at least 12 mm on boards, 30 mm on sheets), so the
  // first view is never an empty corner; the whole document when it has none.
  function fitChanges() {
    if (!S) return;
    fitDoc();
    if (wholeDoc()) return;
    let box = null;
    for (const c of onDoc()) {
      if (areaOnly(c)) continue;
      const g = S.model.geometry(c), b = g.span || g.box;
      if (b) box = box ? [Math.min(box[0], b[0]), Math.min(box[1], b[1]), Math.max(box[2], b[2]), Math.max(box[3], b[3])] : b.slice();
    }
    if (!box || !G.AtriumNavCommon) return;
    const kind = docPair().d?.kind, min = (kind === "pcb" ? 12 : 30) / 2, cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const hw = Math.max((box[2] - box[0]) / 2 * 1.15, min), hh = Math.max((box[3] - box[1]) / 2 * 1.15, min);
    const p = S.panes[1].node.hidden ? S.panes[0] : S.panes[1], r = p.base.getBoundingClientRect();
    const cam = G.AtriumNavCommon.cameraFor([cx - hw, cy - hh, cx + hw, cy + hh], r.width || 800, r.height || 600, S.cam, {margin: .12, maxFactor: 40});
    // Never zoom out past the document fit.
    S.cam = {...S.cam, cx: cam.cx, cy: cam.cy, scale: Math.max(cam.scale, S.cam.scale)};
  }
  // ------------------------------------------------------------------ ink
  function visible() {
    const f = S.filter, m = S.model;
    return m.filter({severities: f.severities, statuses: f.statuses, hideCosmetic: f.hideCosmetic, query: f.query, expanded: S.expanded,
      kinds: f.kind ? new Set([f.kind]) : null, nets: f.net ? new Set([f.net]) : null, docs: f.scope === "doc" ? new Set([S.doc]) : null,
      layers: f.layer ? new Set([f.layer]) : null});
  }
  function onDoc() {
    const hid = S.hidden.get(S.doc);
    return S.list.filter(c => c.doc === S.doc && !(hid && c.layer && hid.has(c.layer)));
  }
  // Filters and selection helpers (Esc steps back through them; E toggles electrical only).
  function filtered() {
    const f = S.filter;
    return f.query || f.kind || f.net || f.layer || f.scope === "doc" || f.severities.size !== M().SEVERITIES.length || f.statuses.size !== M().STATUSES.length;
  }
  function resetFilters() {
    const f = S.filter;
    f.query = ""; f.kind = f.net = f.layer = ""; f.scope = "all"; f.severities = new Set(M().SEVERITIES); f.statuses = new Set(M().STATUSES);
    S.search.value = ""; refresh();
  }
  function clearSelection() {
    S.current = null; S.linkedSet = new Set();
    for (const r of S.listNode.querySelectorAll(".dv-row[aria-selected=true]")) r.setAttribute("aria-selected", "false");
    S.listNode.removeAttribute("aria-activedescendant");
    paintInspector(); renderSoon(); announce("Selection cleared");
  }
  function electricalOnly() {
    const f = S.filter, only = f.severities.size === 1 && f.severities.has("electrical");
    f.severities = only ? new Set(M().SEVERITIES) : new Set(["electrical"]);
    refresh(); announce(only ? "All severities" : "Electrical changes only");
  }
  // Badges are collected while drawing and placed afterwards: several changes on one object fan out
  // along its top edge, badges closer than 18 px cluster into one count bubble (click: zoom there), and
  // below 4 px per mm only outlines are drawn. The current and linked changes always get their badge.
  const CLUSTER = 18, BADGE_MIN_SCALE = 4;
  function paintInk() {
    const items = onDoc(), whole = wholeDoc();
    for (const p of S.panes) {
      if (p.node.hidden) continue;
      const box = sizeTo(p.ink, p.base), g = p.ink.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, p.ink.width, p.ink.height);
      g.setTransform(box.dpr, 0, 0, box.dpr, 0, 0);
      p.clusters = [];
      if (whole) continue;   // a whole added or removed document is shown clean, with a banner
      const pal = p.pal || paletteFor(null);
      const both = stacked() && p.side === "after", sideBefore = p.side === "before" && !stacked();
      if (S.mode === "changes" && p.side === "after") dimUnchanged(g, p, items, box, pal);
      const badges = [];
      // Cosmetic first, electrical last, so electrical outlines sit on top.
      const order = {cosmetic: 0, layout: 1, electrical: 2};
      for (const c of [...items].sort((a, b) => order[a.severity] - order[b.severity]))
        drawChange(g, p, c, pal, {before: sideBefore || both || S.mode === "changes", after: !sideBefore, ghost: S.mode === "side",
          current: c === S.current, linked: S.linkedSet?.has(c)}, badges);
      placeBadges(g, p, badges, pal, box);
    }
  }
  function placeBadges(g, p, badges, pal, box) {
    const small = p.view.scale() < BADGE_MIN_SCALE;
    const keep = badges.filter(b => b.always || !small);
    // Fan out badges of one object.
    const byAnchor = new Map();
    for (const b of keep) { const k = Math.round(b.x) + "," + Math.round(b.y); if (!byAnchor.has(k)) byAnchor.set(k, []); byAnchor.get(k).push(b); }
    for (const list of byAnchor.values()) list.forEach((b, i) => { b.x -= i * 17; });
    const cells = new Map(), solo = [];
    for (const b of keep) {
      if (b.always) { solo.push(b); continue; }
      const k = Math.floor(b.x / CLUSTER) + "," + Math.floor(b.y / CLUSTER);
      if (!cells.has(k)) cells.set(k, []); cells.get(k).push(b);
    }
    for (const list of cells.values()) {
      if (list.length === 1) { solo.push(list[0]); continue; }
      const x = list.reduce((s, b) => s + b.x, 0) / list.length, y = list.reduce((s, b) => s + b.y, 0) / list.length;
      const electrical = list.some(b => b.c.severity === "electrical"), r = 10;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fillStyle = electrical ? pal.electrical : pal.ring; g.fill();
      g.lineWidth = 2; g.strokeStyle = pal.halo; g.stroke();
      g.fillStyle = electrical ? "#fff" : pal.dark ? "#111" : "#fff"; g.font = "600 10px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(list.length), x, y + .5);
      let world = null;
      for (const b of list) { const gb = S.model.geometry(b.c).box; if (gb) world = world ? [Math.min(world[0], gb[0]), Math.min(world[1], gb[1]), Math.max(world[2], gb[2]), Math.max(world[3], gb[3])] : gb.slice(); }
      p.clusters.push({x, y, r, box: world, n: list.length});
    }
    for (const b of solo) badge(g, Math.min(box.w - 10, Math.max(10, b.x)), Math.max(10, b.y), b.c.status, b.col, pal, b.big, b.c.severity);
  }
  const W2S = (p, pt) => p.view.worldToScreen(pt);
  function screenBox(p, b) {
    const a = W2S(p, [b[0], b[1]]), c = W2S(p, [b[2], b[3]]);
    return [Math.min(a[0], c[0]), Math.min(a[1], c[1]), Math.max(a[0], c[0]), Math.max(a[1], c[1])];
  }
  function tracePath(g, p, pts, closed) {
    g.beginPath();
    for (let k = 0; k < pts.length; k++) { const q = W2S(p, pts[k]); if (k) g.lineTo(q[0], q[1]); else g.moveTo(q[0], q[1]); }
    if (closed) g.closePath();
  }
  // One shape's highlight in screen pixels: a ring around tracks and wires, a box or circle for parts,
  // pads and vias, the outline for pours. Layers: the object's own copper shaded to half (so the ink
  // does not fight copper of a similar hue), a halo, the status colour, then a thin neutral line
  // inside it. `double` (electrical) adds a second ring outside.
  function outline(g, p, s, col, pal, {dash = null, w = 2.5, fill = 0, punch = false, shade = false, double = false, alpha = 1} = {}) {
    if (!s) return;
    const scale = p.view.scale();
    g.save(); g.globalAlpha = alpha;
    if (s.path && !s.closed) {
      const core = Math.max(1.5, s.width * scale);
      tracePath(g, p, s.path, false);
      g.setLineDash([]); g.lineCap = "round"; g.lineJoin = "round";
      if (punch) { g.lineWidth = core + 6; g.stroke(); g.restore(); return; }
      if (shade) { g.strokeStyle = pal.shade; g.lineWidth = core; g.stroke(); }
      const ring = core + 4 + 2 * w;
      if (double) { g.strokeStyle = pal.halo; g.lineWidth = ring + 9; g.stroke(); g.strokeStyle = col; g.lineWidth = ring + 6; g.stroke(); }
      g.strokeStyle = pal.halo; g.lineWidth = ring + 3; g.stroke();
      g.strokeStyle = col; g.lineWidth = ring; if (dash) g.setLineDash(dash); g.stroke(); g.setLineDash([]);
      // The neutral inner line: a stroke 1.5 px wider than the hole, then the hole again.
      if (!dash) { g.strokeStyle = pal.inner; g.lineWidth = core + 5; g.stroke(); }
      g.save(); g.globalCompositeOperation = "destination-out"; g.lineWidth = core + 2; g.stroke(); g.restore();
      if (fill) { g.globalAlpha = alpha * fill; g.strokeStyle = col; g.lineWidth = core + 2; g.stroke(); }
      g.restore();
      return;
    }
    const pad = 3, trace = (grow = 0) => {
      if (s.path && s.closed) { tracePath(g, p, s.path, true); return; }
      const b = screenBox(p, s.box);
      g.beginPath();
      if (s.round) { const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2; g.arc(cx, cy, Math.max(b[2] - b[0], b[3] - b[1]) / 2 + pad + grow, 0, Math.PI * 2); }
      else g.rect(b[0] - pad - grow, b[1] - pad - grow, b[2] - b[0] + 2 * (pad + grow), b[3] - b[1] + 2 * (pad + grow));
    };
    trace();
    if (punch) { g.fill(); g.restore(); return; }
    if (shade) { g.fillStyle = pal.shade; g.fill(); }
    if (fill) { g.save(); g.globalAlpha = alpha * fill; g.fillStyle = col; g.fill(); g.restore(); }
    g.setLineDash([]); g.strokeStyle = pal.halo; g.lineWidth = w + 3; g.stroke();
    if (dash) g.setLineDash(dash);
    g.strokeStyle = col; g.lineWidth = w; g.stroke(); g.setLineDash([]);
    if (!dash) { trace(-w / 2 - .5); g.strokeStyle = pal.inner; g.lineWidth = 1; g.stroke(); }
    if (double) { trace(w + 3); g.strokeStyle = pal.halo; g.lineWidth = w + 2; g.stroke(); g.strokeStyle = col; g.lineWidth = w; g.stroke(); }
    g.restore();
  }
  function dimUnchanged(g, p, items, box, pal) {
    // The canvas colour at 85 % over everything, with the changed objects punched out (unchanged ≈ 15 %).
    g.save(); g.fillStyle = pal.dim; g.fillRect(0, 0, box.w, box.h);
    g.globalCompositeOperation = "destination-out"; g.fillStyle = "#000"; g.strokeStyle = "#000";
    // Only objects are punched out: net, routing and document rows cover whole areas, not things.
    for (const c of items) {
      if (c.status === "removed" || areaOnly(c)) continue;
      const geo = S.model.geometry(c);
      if (geo.after && !geo.after.dotted) {
        outline(g, p, geo.after, "#000", pal, {punch: true});
        // The part's own designator and value text sits above and below its body: punch that band too.
        if (c.objectKind === "part" && !geo.after.path) { const b = screenBox(p, geo.after.box), h = Math.max(14, (b[3] - b[1]) * .6); g.fillRect(b[0] - 12, b[1] - h, b[2] - b[0] + 24, b[3] - b[1] + 2 * h); }
      }
    }
    g.restore();
  }
  function badge(g, x, y, status, col, pal, big, severity) {
    const r = big ? 9 : 7.5;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.fillStyle = col; g.fill(); g.lineWidth = 2; g.strokeStyle = pal.halo; g.stroke();
    const rgbc = rgbOf(col) || [0, 0, 0], ink = luma(rgbc) > .55 ? "#111" : "#fff";
    g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 1.8; g.lineCap = "round";
    const k = r * .5;
    g.beginPath();
    if (status === "added") { g.moveTo(x - k, y); g.lineTo(x + k, y); g.moveTo(x, y - k); g.lineTo(x, y + k); g.stroke(); }
    else if (status === "removed") { g.moveTo(x - k, y); g.lineTo(x + k, y); g.stroke(); }
    else if (status === "moved") { g.moveTo(x - k, y); g.lineTo(x + k, y); g.moveTo(x + k * .2, y - k * .7); g.lineTo(x + k, y); g.lineTo(x + k * .2, y + k * .7); g.stroke(); }
    else if (status === "modified") { g.moveTo(x - k, y + k * .2); g.bezierCurveTo(x - k * .4, y - k * .9, x + k * .2, y + k * .9, x + k, y - k * .3); g.stroke(); }
    else { g.arc(x, y - k * .75, 1.1, 0, Math.PI * 2); g.fill(); g.beginPath(); g.moveTo(x, y - k * .1); g.lineTo(x, y + k * .8); g.stroke(); }
    if (severity === "electrical") {
      // A small lightning tag at the badge's lower right: electrical changes read as electrical without the list.
      const tx = x + r * .8, ty = y + r * .8;
      g.beginPath(); g.arc(tx, ty, 5.5, 0, Math.PI * 2); g.fillStyle = pal.electrical; g.fill(); g.lineWidth = 1.5; g.strokeStyle = pal.halo; g.stroke();
      g.beginPath(); g.moveTo(tx + 1, ty - 3.6); g.lineTo(tx - 2, ty + .4); g.lineTo(tx + .3, ty + .4); g.lineTo(tx - 1, ty + 3.6); g.lineTo(tx + 2.2, ty - .6); g.lineTo(tx - .1, ty - .6); g.closePath();
      g.fillStyle = "#fff"; g.fill();
    }
  }
  function arrow(g, a, b, col, pal) {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), h = 9;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 6) return;
    const path = () => { g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.moveTo(b[0], b[1]); g.lineTo(b[0] - h * Math.cos(ang - .45), b[1] - h * Math.sin(ang - .45));
      g.moveTo(b[0], b[1]); g.lineTo(b[0] - h * Math.cos(ang + .45), b[1] - h * Math.sin(ang + .45)); };
    g.setLineDash([]); g.lineCap = "round";
    path(); g.strokeStyle = pal.halo; g.lineWidth = 4.5; g.stroke();
    path(); g.strokeStyle = col; g.lineWidth = 2; g.stroke();
  }
  const AREA_KINDS = new Set(["routing", "document", "drc", "waiver", "board", "rules", "rule", "ruleSet", "project", "library", "order", "comments", "signal", "tag", "netTag",
    "netClass", "diffPair", "diffPairClass", "componentClass", "variant"]);
  // A row that covers an area (a net's routing, a sheet, a rule) rather than one object. A library row
  // on a placed part (library.resolved: a placeholder became a real component) is that part.
  const areaOnly = c => AREA_KINDS.has(c.objectKind) && !(c.objectKind === "library" && c.item != null && c.doc != null);
  function drawChange(g, p, c, pal, o, badges) {
    const geo = S.model.geometry(c);
    if (!geo.box) return;
    // A routing or document row spans a whole net or sheet: outline it only while it is the selected change.
    if (areaOnly(c) && !o.current) return;
    const col = pal[c.status] || pal.properties, ele = c.severity === "electrical", cos = c.severity === "cosmetic";
    const w = o.current ? 3.2 : ele ? 2.6 : cos ? 1.4 : 2.2, alpha = cos && !o.current ? .6 : 1, double = ele;
    const vb = screenBox(p, geo.span || geo.box), cw = p.ink.width, ch = p.ink.height;
    if (vb[2] < -40 || vb[3] < -40 || vb[0] > cw + 40 || vb[1] > ch + 40) return;
    if (/^(pin|pad)\./.test(c.kind || "") || c.objectKind === "pin") {
      // A pin or pad whose connection changed: a constant-size ring on the pin (the part did not change shape).
      const sh = geo.after || geo.before, q = W2S(p, centreOf(sh.box)), r = o.current ? 9 : 7;
      g.save(); g.globalAlpha = alpha;
      g.beginPath(); g.arc(q[0], q[1], r, 0, Math.PI * 2); g.lineWidth = 6; g.strokeStyle = pal.halo; g.stroke();
      g.lineWidth = 3; g.strokeStyle = col; g.setLineDash(c.status === "removed" ? [3, 2.5] : []); g.stroke(); g.setLineDash([]);
      g.beginPath(); g.arc(q[0], q[1], r - 2.5, 0, Math.PI * 2); g.lineWidth = 1; g.strokeStyle = pal.inner; g.stroke();
      g.restore();
      if (badges) badges.push({x: q[0] + r + 4, y: q[1] - r - 2, c, col, big: o.current, always: o.current || o.linked});
      if (o.current || o.linked) { const b = [q[0] - r, q[1] - r, q[0] + r, q[1] + r]; g.strokeStyle = pal.halo; g.lineWidth = 4; corners(g, b, 6); g.strokeStyle = pal.ring; g.lineWidth = 1.6; corners(g, b, 6); }
      return;
    }
    if (geo.dots) {
      // Net topology on the canvas: a short ring marker on each pin, lost pins dashed (no star lines:
      // on a schematic they would read as wires).
      const nets = [...new Set(geo.dots.map(d => d.net))];
      nets.forEach((net, k) => {
        const ink = k % 2 ? pal.properties : col;
        for (const d of geo.dots.filter(x => x.net === net)) {
          const q = W2S(p, d.at);
          g.beginPath(); g.arc(q[0], q[1], 6, 0, Math.PI * 2); g.lineWidth = 4.5; g.strokeStyle = pal.halo; g.stroke();
          g.setLineDash(d.side === "before" ? [2.5, 2.5] : []); g.lineWidth = 2.2; g.strokeStyle = ink; g.stroke(); g.setLineDash([]);
          g.beginPath(); g.arc(q[0], q[1], 2, 0, Math.PI * 2); g.fillStyle = ink; g.fill();
        }
      });
    } else if (c.status === "removed") {
      if (o.before) outline(g, p, geo.before, col, pal, {dash: [7, 4], w, fill: .14, double, alpha});
      else if (o.ghost && geo.before) outline(g, p, geo.before, col, pal, {dash: [3, 4], w: 1.4, alpha: .4});
    } else if (c.status === "added") {
      if (o.after) outline(g, p, geo.after, col, pal, {w, fill: .16, shade: true, double, alpha});
      else if (o.ghost && geo.after) outline(g, p, geo.after, col, pal, {dash: [3, 4], w: 1.4, alpha: .4});
    } else if (c.status === "moved" || c.status === "modified") {
      if (geo.before && (o.before || o.ghost)) outline(g, p, geo.before, col, pal, {dash: c.status === "moved" ? [5, 4] : [2, 3.5], w: 1.4, alpha: o.before ? .75 : .4});
      if (geo.after && (o.after || o.ghost)) {
        if (o.after) outline(g, p, geo.after, col, pal, {w, fill: .1, shade: true, double, alpha});
        else outline(g, p, geo.after, col, pal, {dash: [3, 4], w: 1.4, alpha: .4});
      }
      if (geo.before && geo.after && c.status === "moved" && (o.after || o.ghost)) arrow(g, W2S(p, centreOf(geo.before.box)), W2S(p, centreOf(geo.after.box)), col, pal);
    } else {
      const s = o.after ? geo.after || geo.before : geo.before;
      outline(g, p, s, col, pal, {dash: [1.5, 3], w: Math.max(w, 2), double, alpha});
    }
    // Badge at the top-right corner of the (new) shape; placed later with the others.
    const s = (o.after && geo.after) || (o.before && geo.before);
    if (s && badges) { const b = screenBox(p, s.box); badges.push({x: b[2] + 5, y: b[1] - 5, c, col, big: o.current, always: o.current || o.linked}); }
    if (o.current || o.linked) {
      const b = screenBox(p, geo.span || geo.box), m = 10;
      g.setLineDash(o.current ? [] : [3, 3]);
      g.strokeStyle = pal.halo; g.lineWidth = 4; corners(g, b, m); g.strokeStyle = pal.ring; g.lineWidth = 1.6; corners(g, b, m); g.setLineDash([]);
    }
  }
  const centreOf = b => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  function corners(g, b, m) {
    const x0 = b[0] - m, y0 = b[1] - m, x1 = b[2] + m, y1 = b[3] + m, k = Math.min(14, (x1 - x0) / 3, (y1 - y0) / 3);
    g.beginPath();
    g.moveTo(x0, y0 + k); g.lineTo(x0, y0); g.lineTo(x0 + k, y0); g.moveTo(x1 - k, y0); g.lineTo(x1, y0); g.lineTo(x1, y0 + k);
    g.moveTo(x1, y1 - k); g.lineTo(x1, y1); g.lineTo(x1 - k, y1); g.moveTo(x0 + k, y1); g.lineTo(x0, y1); g.lineTo(x0, y1 - k);
    g.stroke();
  }
  function paintCross() {
    for (const p of S.panes) {
      if (p.node.hidden) continue;
      const box = sizeTo(p.cross, p.base), g = p.cross.getContext("2d");
      g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, p.cross.width, p.cross.height);
      if (!S.pointer) continue;
      g.setTransform(box.dpr, 0, 0, box.dpr, 0, 0);
      const q = W2S(p, S.pointer), pal = p.pal || paletteFor(null);
      g.globalAlpha = .7; g.strokeStyle = pal.cross; g.lineWidth = 1; g.setLineDash([4, 4]);
      g.beginPath(); g.moveTo(0, Math.round(q[1]) + .5); g.lineTo(box.w, Math.round(q[1]) + .5); g.moveTo(Math.round(q[0]) + .5, 0); g.lineTo(Math.round(q[0]) + .5, box.h); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1; g.beginPath(); g.arc(q[0], q[1], 5, 0, Math.PI * 2); g.lineWidth = 1.5; g.stroke();
    }
  }

  // ------------------------------------------------------------------ camera and pointer
  function viewOf(canvas) { return S.panes.find(p => p.cross === canvas) || null; }
  function bindStage() {
    let drag = null;
    for (const p of S.panes) {
      const c = p.cross;
      const point=(x,y)=>{const r=c.getBoundingClientRect();return p.view.screenToWorld([x-r.left,y-r.top]);};
      p.releaseInput=G.AtriumCanvasInput?.registerView({canvas:c,view:p.view,input:{
        navigation:true,active:()=>!!S&&!p.node.hidden,point,screen:q=>p.view.worldToScreen(q),
        host:{currentId:()=>S?.doc,tool:()=>"select",hit(_,x,y){
          const at=point(x,y);return {doc:{id:S.doc,kind:"review"},point:at,item:hitChange(p,at)};
        },act(){}}, // The revision view has read-only history.
        frame(){stopFly();S.cam=p.view.camera();renderSoon(true);},
        hold(d){if(d.item)select(d.item,{fly:false});return true;},
        zoom(hit){select(hit.item,{fly:true});}
      }});
      // As in the editor: left or middle drag pans, and so does a right drag (a right click that does
      // not move 4 px within 250 ms stays a click; there is no context menu here).
      c.addEventListener("pointerdown", e => {
        if (e.button !== 0 && e.button !== 1 && e.button !== 2) return;
        e.preventDefault(); c.focus({preventScroll: true}); try { c.setPointerCapture?.(e.pointerId); } catch { /* a synthetic or ended pointer */ }
        drag = {p, x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t: now(), moved: false, id: e.pointerId, button: e.button};
      });
      c.addEventListener("contextmenu", e => e.preventDefault());
      c.addEventListener("pointermove", e => {
        const r = c.getBoundingClientRect(), pt = [e.clientX - r.left, e.clientY - r.top];
        if (drag && drag.p === p) {
          const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
          if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < (drag.button === 2 ? 4 : 3)) return;
          drag.moved = true; drag.x = e.clientX; drag.y = e.clientY;
          stopFly(); p.view.restoreCamera(S.cam); p.view.pan(dx, dy); S.cam = p.view.camera();
          S.pointer = p.view.screenToWorld(pt); renderSoon(true); return;
        }
        if (S.cam) p.view.restoreCamera(S.cam);
        S.pointer = p.view.screenToWorld(pt); paintCrossSoon();
      });
      const end = e => {
        if (!drag || drag.p !== p) return;
        const d = drag; drag = null;
        if (!d.moved && e.type === "pointerup" && d.button === 0) {
          const r = c.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
          const cl = (p.clusters || []).find(k => Math.hypot(k.x - x, k.y - y) <= k.r + 2);
          if (cl?.box) { flyTo(cl.box); announce(T("diff.view.changes_here", {count: cl.n})); return; }
          const w = p.view.screenToWorld([x, y]), hit = hitChange(p, w);
          if (hit) select(hit, {fly: false});
        } else renderSoon();
      };
      c.addEventListener("pointerup", end); c.addEventListener("pointercancel", end);
      c.addEventListener("pointerleave", () => { S.pointer = null; paintCrossSoon(); });
      c.addEventListener("dblclick", e => {
        const r = c.getBoundingClientRect(), w = p.view.screenToWorld([e.clientX - r.left, e.clientY - r.top]), hit = hitChange(p, w);
        if (hit) select(hit, {fly: true});
      });
      c.addEventListener("wheel", e => {
        e.preventDefault(); stopFly();
        const r = c.getBoundingClientRect(), at = [e.clientX - r.left, e.clientY - r.top];
        p.view.restoreCamera(S.cam);
        // The user's wheel preferences (Preferences › Mouse) through the editor's own helper.
        const C = G.AtriumCamera;
        let done = false;
        if (typeof C?.wheel === "function") { try { done = C.wheel(e, p.view, at, p.cross) !== false; } catch { done = false; } }
        if (!done) {
          if (e.ctrlKey || e.metaKey || !e.shiftKey && Math.abs(e.deltaX) < 1 && e.deltaMode !== 0 || !e.shiftKey && Math.abs(e.deltaX) < 1 && Math.abs(e.deltaY) >= 40) p.view.zoom(Math.exp(-Math.max(-120, Math.min(120, e.deltaY)) * .008), at);
          else p.view.pan(-(e.shiftKey ? e.deltaY : e.deltaX), e.shiftKey ? 0 : -e.deltaY);
        }
        S.cam = p.view.camera(); S.pointer = p.view.screenToWorld(at); renderSoon(true);
      }, {passive: false});
    }
    // Swipe divider: drag, arrow keys, Home/End.
    const h = S.handle;
    h.addEventListener("pointerdown", e => {
      e.preventDefault(); h.setPointerCapture?.(e.pointerId);
      const follow = ev => { const r = S.panesNode.getBoundingClientRect(); S.swipe = Math.min(1, Math.max(0, (ev.clientX - r.left) / Math.max(1, r.width))); applySwipe(); };
      const done = () => { h.removeEventListener("pointermove", follow); h.removeEventListener("pointerup", done); h.removeEventListener("pointercancel", done); };
      h.addEventListener("pointermove", follow); h.addEventListener("pointerup", done); h.addEventListener("pointercancel", done);
    });
    h.addEventListener("keydown", e => {
      const step = {ArrowLeft: -.02, ArrowRight: .02, PageDown: -.1, PageUp: .1}[e.key];
      if (e.key === "Home" || e.key === "End") { S.swipe = e.key === "Home" ? 0 : 1; }
      else if (step) S.swipe = Math.min(1, Math.max(0, S.swipe + step)); else return;
      e.preventDefault(); e.stopPropagation(); applySwipe();
    });
  }
  function applySwipe() { S.panesNode.style.setProperty("--dv-swipe", (S.swipe * 100).toFixed(2) + "%"); S.handle.setAttribute("aria-valuenow", String(Math.round(S.swipe * 100))); }
  let crossFrame = 0;
  function paintCrossSoon() { if (crossFrame) return; crossFrame = raf(() => { crossFrame = 0; if (S) paintCross(); }); }
  function hitChange(p, w) {
    let best = null, area = Infinity;
    const tol = 6 / p.view.scale();
    for (const c of onDoc()) {
      const g = S.model.geometry(c), boxes = [g.after?.box, (p.side === "before" || stacked()) ? g.before?.box : null].filter(Boolean);
      for (const b of boxes) {
        if (w[0] < b[0] - tol || w[0] > b[2] + tol || w[1] < b[1] - tol || w[1] > b[3] + tol) continue;
        const a = (b[2] - b[0]) * (b[3] - b[1]);
        if (a < area) { area = a; best = c; }
      }
    }
    return best;
  }
  let fly = null;
  function stopFly() { if (fly) { fly.stop = true; fly = null; } }
  function flyTo(box) {
    const p = S.panes[1].node.hidden ? S.panes[0] : S.panes[1], r = p.base.getBoundingClientRect();
    const NC = G.AtriumNavCommon, w = Math.max(2, box[2] - box[0]), h = Math.max(2, box[3] - box[1]);
    // Enough surroundings to recognise the place: at least 12 mm across on boards, 30 mm on sheets.
    const min = (docPair().d?.kind === "pcb" ? 12 : 30) / 2, cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
    const hw = Math.max(w * .9, min), hh = Math.max(h * .9, min), b = [cx - hw, cy - hh, cx + hw, cy + hh];
    const to = NC ? NC.cameraFor(b, r.width || 800, r.height || 600, S.cam, {margin: .15, maxFactor: 40}) : {...S.cam, cx: (b[0] + b[2]) / 2, cy: (b[1] + b[3]) / 2};
    const from = S.cam, target = {...from, cx: to.cx, cy: to.cy, scale: to.scale};
    stopFly();
    if (!motion()) { S.cam = target; renderSoon(); return; }
    const t0 = now(), ms = 220, me = {stop: false};
    fly = me;
    const ease = t => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
    const step = () => {
      if (me.stop || !S) return;
      const t = Math.min(1, (now() - t0) / ms), k = ease(t);
      S.cam = {...target, cx: from.cx + (target.cx - from.cx) * k, cy: from.cy + (target.cy - from.cy) * k, scale: from.scale * Math.pow(target.scale / from.scale, k)};
      if (t < 1) { renderNow(true); raf(step); } else { fly = null; renderNow(false); }
    };
    raf(step);
  }

  // ------------------------------------------------------------------ list, filters, inspector
  function refresh() {
    if (!S) return;
    S.list = S.model.ordered(visible(), S.groupBy);
    paintSummary(); paintDocs(); paintLayers(); paintFilters(); refreshList(false); paintInspector();
    renderSoon();
  }
  function paintSummary() {
    const m = S.model, s = m.summary(m.changes), node = S.sumText;
    node.replaceChildren();
    if (!m.done && !m.changes.length) node.append("Comparing…");
    else if (!s.total) node.append(m.identical ? "Identical" : "No changes");
    else {
      // Electrical leads, in the danger tint; then layout and cosmetic.
      const bits = M().SEVERITIES.filter(k => s[k]).map(k => { const b = el("span", SUM[k] ? T(SUM[k], {count: s[k]}) : s[k] + " " + k, "dv-sum-" + k); return b; });
      bits.forEach((b, k) => { if (k) node.append(" · "); node.append(b); });
      node.append(" " + T(s.total === 1 ? "diff.view.sum_change" : "diff.view.sum_changes") + (m.done ? "" : "…"));
    }
    const head = (m.headline || []).slice(0, 3);
    // Noise the engine dropped (float noise, reordering, re-poured copper, re-segmented tracks) is
    // counted, so a quiet list is trusted rather than suspected.
    const ignored = Object.values(m.suppressed || {}).reduce((a, v) => a + (+v || 0), 0);
    S.headline.hidden = !head.length;
    if (head.length) {
      S.headline.textContent = head.join(" · ") + (s.total > head.length ? " · " + T("diff.view.plus_more", {count: s.total - head.length}) : "") + (ignored ? " · " + T(ignored === 1 ? "diff.view.ignored_one" : "diff.view.ignored_short", {count: ignored}) : "");
      S.headline.title = ignored ? T("diff.view.ignored", {count: ignored}) : "";
    }
    S.matchBtn.hidden = !m.components?.length;
    const review = (m.stats?.components?.review || 0) + (m.stats?.components?.unpairedReview || 0);
    S.matchBtn.textContent = review ? "Component matches · " + review + " to review" : "Component matches";
    const warn = m.warnings || [];
    S.warnBtn.hidden = !warn.length;
    if (warn.length) { S.warnBtn.textContent = "⚠ " + T(warn.length === 1 ? "diff.view.warning" : "diff.view.warnings", {count: warn.length}); S.warnBtn.title = warn.join("\n"); }
    S.routeBtn.hidden = !m.routing?.length;
    if (m.routing?.length) S.routeBtn.textContent = T(m.routing.length === 1 ? "diff.view.routing_net" : "diff.view.routing_nets", {count: m.routing.length});
    const drc = m.drc;
    if (!drc && S.drcToken === S.token) { S.drcBtn.hidden = false; S.drcBtn.textContent = "DRC Δ"; S.drcBtn.classList.remove("is-bad"); }
    else if (drc === "busy") { S.drcBtn.hidden = false; S.drcBtn.textContent = "DRC Δ …"; }
    else if (drc && typeof drc === "object") {
      S.drcBtn.hidden = !drc.boards && !drc.skipped.length;
      S.drcBtn.textContent = drc.boards ? T("diff.view.drc", {added: drc.added.length, fixed: drc.fixed.length}) : "Run DRC delta";
      S.drcBtn.classList.toggle("is-bad", drc.added.length > 0);
    }
    // Identical revisions: a calm empty state on the stage instead of a wall of zeroed filters.
    S.root.classList.toggle("is-identical", m.done && !s.total);
    if (m.done && !s.total) {
      let note = S.stage.querySelector(".dv-identical");
      if (!note) { note = el("div", null, "dv-identical"); note.setAttribute("role", "status"); S.stage.append(note); }
      const sup = m.suppressed || {}, n = Object.values(sup).reduce((a, v) => a + (+v || 0), 0);
      note.textContent = T("diff.view.identical") + (n ? " " + T("diff.view.ignored", {count: n}) : "");
    }
  }
  function paintDocs() {
    const counts = S.model.docCounts(), nav = S.docsNode;
    nav.replaceChildren(el("h3", "Documents", "dv-docs-h"));
    const hideC = S.filter.hideCosmetic;
    for (const d of docList()) {
      const c = counts.get(d.id), n = d.side !== "both" ? S.model.wholeCount?.(d.id) || 0 : c ? c.total - (hideC ? c.cosmetic : 0) : 0;
      const b = btn(null, () => switchDoc(d.id, true), "dv-doc");
      b.dataset.kind = d.kind;
      if (d.id === S.doc) b.setAttribute("aria-current", "true");
      const name = el("span", null, "dv-doc-name"); name.append(data(el("span", d.name)));
      if (d.side !== "both") name.append(el("small", d.side === "added" ? T(d.kind === "pcb" ? "diff.view.doc_new_board" : "diff.view.doc_new_sheet") : T("diff.view.doc_removed"), "dv-doc-side"));
      b.append(el("i", d.kind === "pcb" ? "▦" : "▤", "dv-doc-icon"), name);
      // The electrical count in red; a document without changes gets a neutral zero.
      const ele = c?.electrical || 0, badge = el("span", S.model.done || n ? String(ele && d.side === "both" ? ele + "/" + n : n) : "…", "ui-count dv-badge");
      if (ele) badge.dataset.tone = "danger"; else if (n || !S.model.done) badge.dataset.tone = "warning";
      if (ele && d.side === "both") badge.title = T("diff.view.electrical_of", {count: ele, total: n});
      b.append(badge);
      { const label = T(d.kind === "pcb" ? "diff.view.doc_board" : "diff.view.doc_sheet", {name: d.name, changes: T(n === 1 ? "diff.view.change" : "diff.view.changes", {count: n})});
        b.setAttribute("aria-label", d.side === "both" ? label : T(d.side === "added" ? "diff.view.doc_added" : "diff.view.doc_removed_aria", {label})); }
      nav.append(b);
    }
  }
  function layerNames(doc0, doc1) {
    const names = new Set();
    try { for (const n of G.AtriumCanvas.routingLayers(doc1 || doc0, doc1 ? S.defs[1] : S.defs[0])) names.add(n); } catch { /* no stack */ }
    for (const d of [doc0, doc1]) for (const i of d?.items || []) if (i?.layer && i.kind !== "part") names.add(i.layer);
    for (const c of S.model.changes) if (c.doc === S.doc && c.layer) names.add(c.layer);
    return [...names];
  }
  function paintLayers() {
    const {d, d0, d1} = docPair(), node = S.layersNode;
    node.replaceChildren();
    node.hidden = d?.kind !== "pcb";
    if (node.hidden) return;
    const counts = S.model.layerCounts(S.doc), hid = S.hidden.get(S.doc) || new Set();
    for (const name of layerNames(d0, d1)) {
      const n = counts.get(name) || 0, b = btn(null, e => {
        const set = S.hidden.get(S.doc) || new Set();
        if (e.shiftKey) { const all = layerNames(d0, d1); set.clear(); for (const x of all) if (x !== name) set.add(x); }
        else toggle(set, name);
        S.hidden.set(S.doc, set); paintLayers(); renderSoon();
      }, "dv-layer");
      b.setAttribute("aria-pressed", String(!hid.has(name)));
      const count = el("b", String(n), "ui-count dv-badge"); if (n) count.dataset.tone = "warning";
      b.append(data(el("span", name)), count);
      b.title = T("diff.view.layer_title", {name, changes: T(n === 1 ? "diff.view.change" : "diff.view.changes", {count: n})});
      node.append(b);
    }
  }
  function paintFilters() {
    const m = S.model, all = m.changes, f = S.filter;
    for (const [s, b] of S.sevBtns) { const n = all.filter(c => c.severity === s).length; b.lastChild.textContent = T("diff.view.count", {label: tx(M().SEVERITY_LABEL[s]), count: n}); b.setAttribute("aria-pressed", String(f.severities.has(s))); }
    for (const [s, b] of S.stBtns) { const n = all.filter(c => c.status === s).length; b.lastChild.textContent = T("diff.view.count", {label: tx(M().STATUS_LABEL[s]), count: n}); b.setAttribute("aria-pressed", String(f.statuses.has(s))); }
    const fillSel = (sel, label, values, cur) => {
      const keep = sel.value;
      sel.replaceChildren(new Option(label, ""));
      for (const [v, t] of values) sel.add(new Option(t, v));
      sel.value = values.some(x => x[0] === cur) ? cur : "";
      if (sel.value !== keep && document.activeElement === sel) sel.value = keep;
    };
    const kinds = [...new Set(all.map(c => c.objectKind))].sort().map(k => [k, M().kindLabel(k)]);
    fillSel(S.kindSel, "All kinds", kinds, f.kind);
    const nets = [...new Set(all.flatMap(c => c.nets || []))].sort((a, b) => a.localeCompare(b, undefined, {numeric: true})).slice(0, 500).map(n => [n, n]);
    fillSel(S.netSel, "All nets", nets, f.net);
    const layers = [...new Set(all.filter(c => c.docKind === "pcb").map(c => c.layer).filter(Boolean))].sort().map(n => [n, n]);
    fillSel(S.layerSel, "All layers", layers, f.layer);
    fillSel(S.scopeSel, "All documents", [["doc", "This document only"]], f.scope === "doc" ? "doc" : "");
    const n = (f.statuses.size !== M().STATUSES.length) + !!f.kind + !!f.net + !!f.layer + (f.scope === "doc");
    S.filterSummary.textContent = n ? T("diff.view.filters_n", {count: n}) : "Filters";
  }
  const ROW_CAP = 400;
  function refreshList(keep = true) {
    if (!S) return;
    if (keep) S.list = S.model.ordered(visible(), S.groupBy);
    const node = S.listNode, groups = S.model.groups(S.list, S.groupBy);
    S.searchWrap?.setCount?.(S.filter.query ? S.list.length : null);
    node.replaceChildren();
    if (!S.list.length) {
      node.append(el("p", S.model.done ? S.model.changes.length ? "No changes match the filters." : "No changes between these revisions." : "Comparing…", "dv-empty"));
      node.removeAttribute("aria-activedescendant"); paintSummary(); renderSoon(); return;
    }
    const linked = S.linkedSet || new Set();
    for (const g of groups) {
      const sec = el("div", null, "dv-group"); sec.setAttribute("role", "group"); sec.setAttribute("aria-label", T("diff.view.group_aria", {label: txs(g.label), count: g.count}));
      sec.append(el("div", T("diff.view.group", {label: txs(g.label), count: g.count}), "dv-group-h dv-sev-" + g.severity));
      for (const k of g.kinds) {
        sec.append(el("div", T("diff.view.group", {label: txs(k.label), count: k.items.length}), "dv-kind-h" + (k.severity ? " dv-kind-" + k.severity : "")));
        for (const c of k.items.slice(0, ROW_CAP)) sec.append(row(c, linked.has(c)));
        if (k.items.length > ROW_CAP) sec.append(el("p", T("diff.view.more_rows", {count: k.items.length - ROW_CAP, kind: txs(k.label).toLowerCase()}), "dv-more-rows"));
      }
      node.append(sec);
    }
    if (S.current && S.list.includes(S.current)) { node.setAttribute("aria-activedescendant", "dv-row-" + S.current.id); node.querySelector("#dv-row-" + CSS.escape(S.current.id))?.scrollIntoView?.({block: "nearest"}); }
    else node.removeAttribute("aria-activedescendant");
    paintSummary(); renderSoon();
  }
  function row(c, linked) {
    const r = el("div", null, "ui-row dv-row"); r.id = "dv-row-" + c.id; r.setAttribute("role", "option");
    r.dataset.status = c.status; r.dataset.id = c.id;
    r.setAttribute("aria-selected", String(c === S.current));
    if (linked) r.classList.add("is-linked");
    r.append(el("i", GLYPH[c.status], "dv-glyph"));
    const text = el("span", null, "ui-row-text");
    text.append(el("span", c.sentence || c.name, "dv-sentence"));
    const meta = [c.docName, c.layer].filter(Boolean).join(" · ");
    if (meta) text.append(el("small", meta, "ui-row-subtitle"));
    r.append(text);
    if (c.objectKind === "document" && c.doc) {
      // A whole sheet or board: its objects stay folded under this row.
      const n = S.model.wholeCount?.(c.doc) || 0, open = S.expanded.has(c.doc);
      if (n) text.append(btn(T(open ? "diff.view.hide_objects" : "diff.view.show_objects", {count: n}), e => { e.stopPropagation(); open ? S.expanded.delete(c.doc) : S.expanded.add(c.doc); refresh(); }, "dv-link-btn dv-expand"));
    }
    const tools = el("span", null, "dv-row-tools");
    const cm = btn(null, e => { e.stopPropagation(); comment(c); }, "dv-tool", "Add comment on this change (C)"), ln = btn(null, e => { e.stopPropagation(); copyLink(c); }, "dv-tool", "Copy link to this change (L)");
    cm.append(icon("M3 4h14v9H8l-4 3v-3H3z")); ln.append(icon("M8 12l4-4M6.5 9.5l-2 2a2.5 2.5 0 003.5 3.5l2-2M13.5 10.5l2-2A2.5 2.5 0 0012 5l-2 2"));
    // The row is one option for assistive technology; C and L reach these tools from the keyboard.
    cm.tabIndex = ln.tabIndex = -1; tools.setAttribute("aria-hidden", "true");
    tools.append(cm, ln); r.append(tools);
    r.setAttribute("aria-label", S.model.speak(c));
    return r;
  }
  function bindList() {
    S.listNode.addEventListener("click", e => {
      const r = e.target.closest?.(".dv-row"); if (!r) return;
      const c = S.model.byId(r.dataset.id); if (c) select(c, {fly: true});
    });
    S.listNode.addEventListener("keydown", e => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); step(e.key === "ArrowDown" ? 1 : -1, {flyLater: true}); }
      else if (e.key === "Home" || e.key === "End") { e.preventDefault(); e.stopPropagation(); if (S.list.length) select(e.key === "Home" ? S.list[0] : S.list.at(-1), {fly: true}); }
    });
  }
  let flyTimer = 0;
  function select(c, {fly: doFly = true, flyLater = false, quiet = false} = {}) {
    if (!S || !c) return;
    const was = S.current, wasLinked = S.linkedSet || new Set();
    S.current = c;
    const linked = S.model.linked(c);
    S.linkedSet = new Set(linked);
    // Another document without a fly to follow: fit its changes, never keep the old document's camera
    // (it points at empty space on the new one).
    if (c.doc && c.doc !== S.doc && docList().some(d => d.id === c.doc)) { switchDoc(c.doc, false); if (!doFly && !flyLater) fitChanges(); }
    // Only the rows whose state changed are touched (a 5k-change list must step in a frame).
    const rowOf = x => x && S.listNode.querySelector("#dv-row-" + CSS.escape(x.id));
    for (const x of new Set([was, c, ...wasLinked, ...linked])) {
      const r = rowOf(x); if (!r) continue;
      r.setAttribute("aria-selected", String(x === c)); r.classList.toggle("is-linked", S.linkedSet.has(x));
    }
    S.listNode.setAttribute("aria-activedescendant", "dv-row-" + c.id);
    rowOf(c)?.scrollIntoView?.({block: "nearest"});
    paintInspector();
    const i = S.list.indexOf(c);
    if (!quiet) announce(S.model.speak(c, i < 0 ? null : i, S.list.length) + (linked.length ? " " + T("diff.view.also_on", {doc: linked[0].docName}) : ""));
    const geo = S.model.geometry(c);
    clearTimeout(flyTimer);
    if (geo.box && (doFly || flyLater)) { if (flyLater) flyTimer = setTimeout(() => S && flyTo(geo.span || geo.box), 140); else flyTo(geo.span || geo.box); }
    renderSoon();
  }
  function step(dir, o = {}) {
    if (!S?.list.length) { announce(S?.model.done ? "No changes to show." : "Still comparing…"); return; }
    const at = S.list.indexOf(S.current);
    const next = S.list[at < 0 ? (dir > 0 ? 0 : S.list.length - 1) : (at + dir + S.list.length) % S.list.length];
    select(next, {fly: !o.flyLater, flyLater: !!o.flyLater});
  }
  // Shift+J / Shift+K: the first change of the next (previous) kind group, so 4,000 track-width rows
  // are one step, not 4,000.
  function stepGroup(dir) {
    if (!S?.list.length) { step(dir); return; }
    const heads = S.model.groups(S.list, S.groupBy).flatMap(g => g.kinds).map(k => k.items).filter(x => x.length);
    const at = heads.findIndex(items => items.includes(S.current));
    const next = heads[at < 0 ? (dir > 0 ? 0 : heads.length - 1) : (at + dir + heads.length) % heads.length];
    if (next) select(next[0], {fly: true});
  }
  function switchDoc(id, fit) {
    if (!S || !docList().some(d => d.id === id)) return;
    // A new document: stop any fly still heading for a place on the old one and start from this
    // document's own fit (the two documents' coordinates are unrelated).
    if (S.doc !== id) { S.doc = id; for (const p of S.panes) { p.bg = null; } stopFly(); clearTimeout(flyTimer); fitDoc(); }
    if (S.filter.scope === "doc") S.list = S.model.ordered(visible(), S.groupBy);
    paintDocs(); paintLayers();
    if (fit) { fitChanges(); refreshList(false); }
    renderSoon();
  }
  function paintInspector() {
    const node = S.inspNode, c = S.current;
    node.replaceChildren();
    node.classList.toggle("is-empty", !c);
    if (!c) {
      const hint = el("p", null, "dv-empty");
      hint.append("No change selected · ", ...AtriumNavCommon.shortcutParts("{keys} step through them", {keys:["J","K"]}));
      node.append(hint); return;
    }
    const h = el("div", null, "dv-insp-head");
    h.append(el("i", GLYPH[c.status], "dv-glyph dv-st-" + c.status), el("strong", c.sentence || c.name));
    node.append(h);
    const meta = el("p", [tx(M().SEVERITY_LABEL[c.severity]), tx(M().STATUS_LABEL[c.status]), c.docName, c.layer].filter(Boolean).join(" · "), "dv-insp-meta");
    node.append(meta);
    if (c.matchReasons?.length) node.append(el("p", [tx(c.matchReview ? "Proposed match" : "Component match"),
      ...c.matchReasons.map(tx)].join(" · "), "dv-insp-meta"));
    if (c.translation) {
      const details = el("details"), summary = el("summary","Objects that moved with the board");
      details.append(summary);
      details.addEventListener("toggle",() => {
        if (!details.open || details.children.length > 1) return;
        const parts = S.model.translatedItems(c), list = el("ul");
        let offset = 0;
        const prev = btn("Previous",() => show(offset-25),"dv-chip"), next = btn("Next",() => show(offset+25),"dv-chip");
        function show(start) {
          offset = start;
          list.replaceChildren();
          for (const i of parts.slice(start,start+25)) {
            const p = i.points?.[0] || [i.x,i.y];
            list.append(el("li",[M().kindLabel(i.kind),i.ref || i.net || i.text,
              p.every(Number.isFinite) ? "(" + p.map(v => Number(v.toFixed(4))).join(", ") + ") mm" : ""].filter(Boolean).join(" · ")));
          }
          prev.disabled = start === 0; next.disabled = start+25 >= parts.length;
        }
        details.append(list);
        if (parts.length > 25) details.append(prev,next);
        show(0);
      });
      node.append(details);
    }
    if (c.topology) node.append(topology(c.topology));
    const fields = (c.fields || []).filter(f => f.key !== "id"), shown = fields.filter(f => !f.hidden), more = fields.filter(f => f.hidden);
    // The shared property table (diff-props.js). An added or removed object has one side only: its
    // properties are listed without change marks.
    const table = rows => globalThis.AtriumDiffProps.table(document, rows.map(f => {
      const marked = !!f.changed && c.status !== "added" && c.status !== "removed";
      return {label: f.label, before: f.before, after: f.after, changed: marked,
        title: marked ? T("diff.view.field_changed", {field: f.label, before: f.before || T("diff.view.nothing"), after: f.after || T("diff.view.nothing")}) : null};
    }));
    if (shown.length) node.append(table(shown));
    if (more.length) { const d = el("details", null, "dv-more-fields"); d.append(el("summary", T("diff.view.more_fields", {count: more.length})), table(more)); node.append(d); }
    const linked = S.model.linked(c);
    if (linked.length) {
      const box = el("div", null, "dv-linked");
      box.append(el("span", "Cross-probe"));
      for (const x of linked.slice(0, 4)) box.append(btn(x.docName + ": " + x.sentence, () => select(x, {fly: true}), "dv-link-btn", T("diff.view.show_on", {doc: x.docName})));
      node.append(box);
    }
    const acts = el("div", null, "dv-insp-acts");
    acts.append(btn("Zoom", () => { const g = S.model.geometry(c); if (g.box) flyTo(g.span || g.box); }, "ui-button", "Zoom to the change (Enter)"),
      btn("Add comment", () => comment(c), "ui-button", "Add a review comment on this change (C)"), btn("Copy link", () => copyLink(c), "ui-button", "Copy a link to this change (L)"));
    node.append(acts);
  }
  // A small connection diagram for a net merge, split or rename: nets as columns of pins, before → after.
  // A small connection diagram for a net merge, split or rename: one column per side, nets with their
  // pins, wires from each pin's old net to its new one. Pins the after side gained are marked "+",
  // pins the before side lost "−"; columns name where the nets live.
  function topology(t) {
    const NS = "http://www.w3.org/2000/svg", mk = (n, a) => { const e = document.createElementNS(NS, n); for (const k in a) e.setAttribute(k, a[k]); return e; };
    const cols = [t.before || [], t.after || []], rowH = 15, W = 300, MAX = 8;
    const rows = Math.max(...cols.map(c => c.reduce((s, g) => s + Math.min(MAX, g.nodes.length) + 1, 0)), 1);
    const H = rows * rowH + 34, svg = mk("svg", {viewBox: "0 0 " + W + " " + H, class: "dv-topo", role: "img"});
    const label = T(t.type === "merge" ? "diff.view.merge" : t.type === "split" ? "diff.view.split" : "diff.view.rename", {before: cols[0].map(g => g.net).join(", "), after: cols[1].map(g => g.net).join(", ")});
    svg.setAttribute("aria-label", label + (t.where ? " (" + t.where + ")" : ""));
    svg.append(mk("title", {})); svg.firstChild.textContent = label;
    const head = (x, text) => { const e = mk("text", {x: String(x), y: "11", class: "dv-topo-head"}); e.textContent = text; svg.append(e); };
    head(8, tx("Before") + (t.where ? " · " + t.where : "")); head(W - 104, tx("After"));
    const pos = new Map();
    cols.forEach((col, ci) => {
      let y = 30;
      const x = ci ? W - 104 : 8;
      for (const g of col) {
        const tx = mk("text", {x: String(x), y: String(y), class: "dv-topo-net" + (ci ? " is-after" : "")}); tx.textContent = g.net; svg.append(tx); y += rowH;
        const mark = new Set(ci ? g.gained || [] : g.lost || []);
        for (const n of g.nodes.slice(0, MAX)) {
          const t2 = mk("text", {x: String(x + 10), y: String(y), class: "dv-topo-pin" + (mark.has(n) ? ci ? " is-gained" : " is-lost" : "")});
          t2.textContent = (mark.has(n) ? ci ? "+ " : "− " : "") + n; svg.append(t2);
          if (!pos.has(n)) pos.set(n, [null, null]);
          pos.get(n)[ci] = [ci ? x + 4 : x + 92, y - 4];
          y += rowH;
        }
        if (g.nodes.length > MAX) { const e = mk("text", {x: String(x + 10), y: String(y), class: "dv-topo-pin"}); e.textContent = T("diff.view.plus_more", {count: g.nodes.length - MAX}); svg.append(e); y += rowH; }
      }
    });
    for (const [, [a, b]] of pos) if (a && b) svg.prepend(mk("path", {d: "M" + a[0] + " " + a[1] + " C" + (a[0] + 50) + " " + a[1] + " " + (b[0] - 50) + " " + b[1] + " " + b[0] + " " + b[1], class: "dv-topo-wire"}));
    const wrap = el("figure", null, "dv-topo-wrap"); wrap.append(svg); return wrap;
  }
  function togglePop(kind) {
    const pop = S.pop;
    if (!pop.hidden && pop.dataset.kind === kind) { hidePop(); return; }
    const switching = !pop.hidden;
    pop.replaceChildren(); pop.dataset.kind = kind; pop.hidden = false;
    const anchor = kind === "matches" ? S.matchBtn : kind === "drc" ? S.drcBtn : kind === "warnings" ? S.warnBtn : S.routeBtn, r = anchor.getBoundingClientRect(), rr = S.root.getBoundingClientRect();
    pop.style.left = Math.max(8, r.left - rr.left) + "px"; pop.style.top = (r.bottom - rr.top + 4) + "px";
    pop.setAttribute("aria-label", kind === "matches" ? "Component matches" : kind === "drc" ? "DRC delta" : kind === "warnings" ? "Comparison warnings" : "Routing delta");
    S.popAnchor = anchor;
    const closeBtn = btn("Close", hidePop, "dv-pop-close ui-button");
    if (kind === "matches") {
      const rows = [...S.model.components].sort((a,b) => Number(b.review)-Number(a.review) || (a.confidence??0)-(b.confidence??0));
      const list = el("div"), prev = btn("Previous", () => show(page-1), "dv-chip"), next = btn("Next", () => show(page+1), "dv-chip");
      let page = 0;
      function show(index) {
        page=index; list.replaceChildren();
        const table = el("table", null, "dv-props dv-matches"), head = el("tr");
        for (const label of ["Component", "Document", "Confidence", "Evidence"]) head.append(el("th", label));
        const thead=el("thead"), body=el("tbody"); thead.append(head);table.append(thead,body);
        for (const m of rows.slice(page*50,(page+1)*50)) {
          const tr=el("tr"), doc=S.model.docs.find(d=>d.id===m.doc);
          // One designator when it did not change, "R22 → R1" when it did; an unpaired part says so.
          const ref = !m.afterRef ? m.beforeRef + " · unpaired" : m.beforeRef === m.afterRef ? m.afterRef : m.beforeRef + " → " + m.afterRef;
          const conf = el("td", m.review ? "Needs review" : m.confidence === 1 ? "Exact" : "Inferred");
          if (m.review) conf.classList.add("is-review");
          const evidence = el("td",m.reasons.map(tx).join(" · "));
          if (m.alternatives?.length) {
            const details = el("details"), summary = el("summary","Candidate evidence");
            details.append(summary);
            details.addEventListener("toggle",() => {
              if (!details.open || details.children.length > 1) return;
              const list = el("ul");
              for (const candidate of m.alternatives) {
                const sheet = S.model.docs.find(d => d.id === candidate.doc);
                list.append(el("li",[candidate.ref,sheet?.name,...candidate.reasons.map(tx)].filter(Boolean).join(" · ")));
              }
              details.append(list);
            });
            evidence.append(details);
          }
          tr.append(el("td",ref),el("td",doc?.name||""),conf,evidence);body.append(tr);
        }
        list.append(table);prev.disabled=page===0;next.disabled=(page+1)*50>=rows.length;
      }
      pop.append(el("h3", "Component matches", "ui-dialog-title"),list);
      if(rows.length>50)pop.append(prev,next);
      pop.append(closeBtn);show(0);closeBtn.focus();return;
    }
    if (kind === "warnings") {
      pop.append(el("h3", "Comparison warnings", "ui-dialog-title"));
      const ul = el("ul", null, "dv-drc-list");
      for (const w of S.model.warnings || []) ul.append(el("li", w));
      const src = S.model.stats?.netlistSource;
      if (src) ul.append(el("li", T("diff.view.netlist_source", {before: src.before, after: src.after})));
      pop.append(ul, closeBtn);
      pop.querySelector("button")?.focus(); return;
    }
    if (kind === "routing") {
      const t = el("table", null, "dv-props dv-route"), hd = el("tr");
      for (const x of ["Net", "Board", "Length before", T("diff.view.after_lc"), "Δ", "Vias", "Δ"]) hd.append(el("th", x));
      const thead = el("thead"); thead.append(hd); t.append(thead);
      const tb = el("tbody"), f = v => (Math.round(v * 100) / 100).toFixed(2);
      for (const x of S.model.routing.slice(0, 200)) {
        const tr = el("tr"), dl = x.lengthAfter - x.lengthBefore, dv = x.viasAfter - x.viasBefore;
        const nb = btn(x.net, () => { S.filter.net = x.net; setPop(false, true); refresh(); }, "dv-link-btn", T("diff.view.show_net", {net: x.net}));
        const td = el("td"); td.append(nb);
        tr.append(td, el("td", x.docName), el("td", f(x.lengthBefore) + " mm"), el("td", f(x.lengthAfter) + " mm"), el("td", (dl > 0 ? "+" : "") + f(dl), dl > 0 ? "is-up" : dl < 0 ? "is-down" : ""),
          el("td", x.viasBefore + " → " + x.viasAfter), el("td", (dv > 0 ? "+" : "") + dv, dv > 0 ? "is-up" : dv < 0 ? "is-down" : ""));
        tb.append(tr);
      }
      t.append(tb); pop.append(el("h3", "Routing delta per net", "ui-dialog-title"), t, closeBtn);
    } else {
      if (!S.model.drc) drcRun(S.token);
      const d = S.model.drc;
      pop.append(el("h3", "DRC delta", "ui-dialog-title"));
      if (!d || d === "busy") pop.append(el("p", "Running the design rule check on both revisions…", "dv-empty"));
      else {
        if (d.skipped.length) {
          pop.append(el("p", T("diff.view.drc_skipped", {boards: d.skipped.join(", ")}), "dv-empty"));
          pop.append(btn("Run DRC on both revisions", async () => { S.model.drc = "busy"; paintSummary(); setPop(false, true); await S.model.drcDelta({limit: Infinity}); if (S) { paintSummary(); togglePop("drc"); } }));
        }
        const sect = (title, list, cls) => {
          pop.append(el("h4", T("diff.view.group", {label: tx(title), count: list.length}), cls));
          const ul = el("ul", null, "dv-drc-list");
          for (const v of list.slice(0, 100)) {
            const li = el("li"), b = btn(v.title, () => { if (v.doc !== S.doc) switchDoc(v.doc, false); if (Array.isArray(v.at)) flyTo([v.at[0] - 1, v.at[1] - 1, v.at[0] + 1, v.at[1] + 1]); }, "dv-link-btn");
            li.append(b); ul.append(li);
          }
          pop.append(ul);
        };
        sect("New violations", d.added, "dv-new"); sect("Fixed violations", d.fixed, "dv-fixed");
      }
      pop.append(closeBtn);
    }
    setPop(true, switching);
    pop.querySelector("button")?.focus();
  }
  // The DRC delta runs on request (opening its chip), not with every compare: a full check of both revisions.
  function drcLater(token) {
    const m = S.model;
    if (!m.docs.some(d => d.kind === "pcb" && d.side === "both")) return;
    S.drcToken = token; paintSummary();
  }
  function drcRun(token) {
    const m = S.model;
    if (S.drcToken !== token || m.drc) return;
    m.drc = "busy"; paintSummary();
    const go = async () => {
      if (S?.token !== token) return;
      try { if (!G.AtriumRules && G.AtriumLazy) await G.AtriumLazy.need("AtriumRules"); } catch { /* no rules module */ }
      if (S?.token !== token) return;
      try { await m.drcDelta({active: () => S?.token === token}); } catch { m.drc = null; }
      if (S?.token !== token) return;
      paintSummary();
      // The open chip shows the result; a failed run closes it (the chip offers the delta again).
      if (!S.pop.hidden && S.pop.dataset.kind === "drc") { setPop(false, true); if (m.drc && typeof m.drc === "object") togglePop("drc"); }
    };
    go();
  }

  // ------------------------------------------------------------------ actions
  function swapSides() {
    if (!S) return;
    const b = S.b, a = S.a, doc = S.doc, mode = S.mode, cur = S.current;
    start(a, b, {doc, focus: cur?.key, focusItem: cur ? [cur.item, cur.beforeItem, cur.ref].filter(x => x != null) : null}).then(() => { if (S) { setMode(mode); announce(T("diff.view.swapped", {from: S.model.from, to: S.model.to})); } }, e => say(e.message));
  }
  async function comment(c) {
    if (!c) { announce("Choose a change first (J)."); return; }
    const session = S, doc = c.doc && host.docById?.(c.doc);
    if (!doc) { say("The working design has no document for this change, so it cannot hold a comment."); return; }
    try { if (!G.AtriumReviewComments && G.AtriumLazy) await G.AtriumLazy.need("AtriumReviewComments"); } catch { /* reported below */ }
    if (S !== session || host.docById?.(c.doc) !== doc) return;
    const C = G.AtriumReviewComments;
    if (!C?.compose) { say("Review comments are unavailable in this build."); return; }
    const g = session.model.geometry(c), box = g.box || [0, 0, 1, 1], at = [(box[0] + box[2]) / 2, box[1]];
    const live = session.a.working && c.item != null && c.status !== "removed" && doc.items.some(i => i.id === c.item);
    const kind = c.objectKind === "part" ? "part" : c.objectKind === "track" ? "track" : "item";
    const label = M().STATUS_LABEL[c.status] + " · " + (c.name || c.sentence).slice(0, 60);
    const anchor = live ? {kind, id: c.item, label, at, box} : {kind: "area", label, at, box};
    C.compose(doc, [anchor], {diff: {status: M().STATUS_LABEL[c.status], name: c.name, key: c.key, sentence: c.sentence}});
  }
  async function copyLink(c) {
    if (!c) { announce("Choose a change first (J)."); return; }
    const text = S.model.link(c);
    let ok = false;
    try { await G.navigator?.clipboard?.writeText?.(text); ok = true; } catch { /* fall back */ }
    if (!ok) {
      const t = el("textarea"); t.value = text; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.append(t); t.select(); try { ok = document.execCommand("copy"); } catch { ok = false; } t.remove();
    }
    say(ok ? T("diff.view.copied", {link: text}) : T("diff.view.copy_failed", {link: text}));
  }
  function openLink(text) { if (!S) return false; const c = S.model.find(text); if (c) select(c, {fly: true}); return !!c; }
  function exportMenu(anchor) {
    const pop = S.pop;
    if (!pop.hidden && pop.dataset.kind === "export") { hidePop(); return; }
    const switching = !pop.hidden;
    S.popAnchor = anchor;
    pop.replaceChildren(); pop.dataset.kind = "export"; pop.hidden = false; pop.setAttribute("aria-label", "Export review report");
    const r = anchor.getBoundingClientRect(), rr = S.root.getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(rr.width - 280, r.left - rr.left - 180)) + "px"; pop.style.top = (r.bottom - rr.top + 4) + "px";
    const run = kind => async () => {
      const printing = kind === "print";
      hidePop(); say(printing ? T("diff.view.printing") : T("diff.view.writing", {kind: kind.toUpperCase()}));
      try {
        if (!G.AtriumDiffExport) await G.AtriumLazy.need("AtriumDiffExport");
        const name = await G.AtriumDiffExport[kind](S, host);
        if (name) say(T(printing ? "diff.view.printed" : "diff.view.exported", {file: name}));
      } catch (e) { say(T(printing ? "diff.view.print_failed" : "diff.view.export_failed", {error: e.message})); }
    };
    pop.append(el("h3", "Export review report", "ui-dialog-title"), btn("Print…", run("print"), "dv-pop-item ui-button", "Print the PDF report: the system print panel picks the printer"),
      btn("Export PDF…", run("pdf"), "dv-pop-item ui-button", "A PDF with the summary, change list and before/after thumbnails"),
      btn("HTML report…", run("html"), "dv-pop-item ui-button", "A self-contained HTML page with the summary, change list and thumbnails"), btn("Cancel", hidePop, "dv-pop-close ui-button"));
    setPop(true, switching);
    pop.querySelector("button").focus();
  }
  function setPop(open, instant = false) {
    const surface = G.AtriumSurfaceMotion;
    if (surface) surface.popover(S.pop, open, {instant});
    else S.pop.hidden = !open;
  }
  function hidePop() {
    setPop(false);
    S.popAnchor?.focus({preventScroll: true});
  }
  function progress(p, text) {
    if (!S) return;
    const n = S.prog;
    if (p == null) { n.hidden = true; return; }
    n.hidden = false; n.firstChild.style.setProperty("--ui-progress", Math.max(.03, Math.min(1, p)).toFixed(3));
    if (text) n.lastChild.textContent = text;
    else n.lastChild.textContent = T("diff.view.progress", {pct: Math.round(p * 100), count: S.model.changes.length});
  }

  // ------------------------------------------------------------------ keys
  function bindKeys() {
    S.root.addEventListener("keydown", e => {
      if (!S) return;
      const t = e.target, typing = t.matches?.("input[type=search], input[type=text], textarea, select") || t.isContentEditable;
      const mod = e.ctrlKey || e.metaKey || e.altKey, k = e.key;
      if (k === "Escape") {
        e.stopPropagation(); e.preventDefault();
        if (!S.pop.hidden) { hidePop(); return; }
        if (t === S.search && S.search.value) { S.search.value = ""; S.filter.query = ""; refreshList(); return; }
        if (typing) { S.listNode.focus(); return; }
        // Esc steps back, as it does everywhere in the editor: selection, then filters, then the view.
        if (S.current) { clearSelection(); return; }
        if (filtered()) { resetFilters(); announce("Filters cleared"); return; }
        close(); return;
      }
      if (typing) { if (k === "Enter" && t === S.search) { e.preventDefault(); step(1); S.listNode.focus(); } e.stopPropagation(); return; }
      if ((k === "Enter" || k === " ") && t.closest?.("summary, button")) { e.stopPropagation(); return; }
      if (k === "F7") { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? -1 : 1); return; }
      if ((e.ctrlKey || e.metaKey) && (k === "PageDown" || k === "PageUp")) { e.preventDefault(); e.stopPropagation(); docStep(k === "PageDown" ? 1 : -1); return; }
      if ((e.ctrlKey || e.metaKey) && /^w$/i.test(k)) { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (mod) {
        // Undo, redo and delete would act on the editor behind the comparison: keep them here.
        if (/^[zyx]$/i.test(k) || k === "Backspace" || k === "Delete") { e.preventDefault(); e.stopPropagation(); }
        return;
      }
      const act = {
        "1": () => setMode("side"), "2": () => setMode("overlay"), "3": () => setMode("swipe"), "4": () => setMode("blink"), "5": () => setMode("changes"),
        j: () => step(1), J: () => stepGroup(1), k: () => step(-1), K: () => stepGroup(-1), n: () => step(1), p: () => step(-1),
        Enter: () => { const g = S.current && S.model.geometry(S.current); if (g?.box) flyTo(g.span || g.box); else step(1); },
        f: () => { fitDoc(); renderSoon(); }, F: () => { fitDoc(); renderSoon(); }, x: swapSides, X: swapSides,
        "[": () => nudge(-.1), "]": () => nudge(.1), " ": () => { if (S.mode !== "blink") setMode("blink"); S.blink.on = !S.blink.on; applyBlink(); },
        "/": () => S.search.focus(), c: () => comment(S.current), C: () => comment(S.current), l: () => copyLink(S.current), L: () => copyLink(S.current),
        g: () => { const x = S.current && S.model.linked(S.current)[0]; if (x) select(x, {fly: true}); else announce("No linked change on another document."); },
        G: () => { const x = S.current && S.model.linked(S.current)[0]; if (x) select(x, {fly: true}); },
        PageDown: () => zoomBy(1 / 1.6), PageUp: () => zoomBy(1.6), Home: () => { fitChanges(); renderSoon(); },
        e: () => electricalOnly(), E: () => electricalOnly(),
        "+": () => zoomBy(1.25), "=": () => zoomBy(1.25), "-": () => zoomBy(.8),
        ArrowLeft: () => panBy(60, 0), ArrowRight: () => panBy(-60, 0), ArrowUp: () => panBy(0, 60), ArrowDown: () => panBy(0, -60)
      }[k];
      if (t.closest?.(".ui-segmented") && (k === "Home" || k === "End")) return;
      const onCanvas = t.classList?.contains("dv-cross");
      if (act && (!k.startsWith("Arrow") || onCanvas)) { e.preventDefault(); e.stopPropagation(); act(); return; }
      // Everything else stays out of the editor's shortcuts (tools would act on the hidden design).
      if (k.length === 1 || k === "Delete" || k === "Backspace") e.stopPropagation();
    });
  }
  function nudge(d) {
    if (S.mode === "swipe") { S.swipe = Math.min(1, Math.max(0, S.swipe + d)); applySwipe(); return; }
    if (S.mode !== "overlay") setMode("overlay");
    S.onion = Math.min(1, Math.max(0, S.onion + d)); S.onionInput.value = String(Math.round(S.onion * 100)); applyMode(); savePrefs();
    announce(T("diff.view.opacity", {pct: Math.round(S.onion * 100)}));
  }
  function docStep(dir) {
    const docs = docList(), i = docs.findIndex(d => d.id === S.doc);
    if (docs.length < 2) return;
    const d = docs[(i + dir + docs.length) % docs.length];
    switchDoc(d.id, true); announce(T("diff.view.doc_count", {name: d.name, count: S.model.docCounts().get(d.id)?.total || 0}));
  }
  function zoomBy(f) { const p = S.panes[1].node.hidden ? S.panes[0] : S.panes[1]; p.view.restoreCamera(S.cam); p.view.zoom(f); S.cam = p.view.camera(); renderSoon(); }
  function panBy(dx, dy) { const p = S.panes[1]; p.view.restoreCamera(S.cam); p.view.pan(dx, dy); S.cam = p.view.camera(); renderSoon(); }

  // ------------------------------------------------------------------ document context menu
  function docMenu(x, y, docId) {
    document.querySelector(".dv-docmenu")?.remove();
    const m = el("div", null, "dv-docmenu"); m.setAttribute("role", "menu"); m.setAttribute("aria-label", "Document");
    const back = document.activeElement;
    const item = (t, fn) => { const b = btn(t, () => { m.remove(); fn(); }, "ui-menu-item"); b.setAttribute("role", "menuitem"); m.append(b); return b; };
    item("Compare With…", () => open({doc: docId}));
    if (git()) item("Compare With HEAD", () => quick({type: "head"}, {type: "working"}, docId));
    m.style.left = Math.min(x, innerWidth - 200) + "px"; m.style.top = Math.min(y, innerHeight - 80) + "px";
    m.addEventListener("keydown", e => {
      const items = [...m.querySelectorAll("button")], i = items.indexOf(document.activeElement);
      if (e.key === "Escape") { e.preventDefault(); m.remove(); back?.focus?.(); }
      else if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus(); }
    });
    document.body.append(m); m.querySelector("button").focus();
    setTimeout(() => document.addEventListener("pointerdown", function off(e) { if (!m.contains(e.target)) { m.remove(); document.removeEventListener("pointerdown", off, true); } }, true), 0);
    return m;
  }
  async function quick(b, a, doc) {
    try {
      const opened = host.project(), file = host.fileSession?.();
      const active = () => host.project() === opened && host.fileSession?.() === file;
      const B = await readSpec(b, "before", null, active), Aa = await readSpec(a, "after", null, active);
      if (!B || !Aa) return null;
      remember(B.spec, Aa.spec);
      return await start(B, Aa, {doc});
    } catch (e) { say(e.message); return null; }
  }
  // Project › Changes Since Last Save: the working design against its baseline, without a picker. The
  // baseline is Git HEAD in the desktop app for a project in a repository, else the last explicit save
  // in the local history (autosave.js), else the copy as it was opened. With none, say why.
  async function sinceSave(current = () => true) {
    if (!host) return null;
    const opened = host.project(), file = host.fileSession?.();
    const active = () => current() && host.project() === opened && host.fileSession?.() === file;
    if (host.folderProject?.()) {
      try {
        const working = await readSpec({type:"working"}, null, null, active);
        let baseline;
        if (git()) try { baseline = await readSpec({type:"head"}, null, null, active); }
        catch (error) {
          if (!/outside a Git worktree|no HEAD commit|unavailable in the selected revision/.test(error.message)) throw error;
        }
        baseline ||= await readSpec({type:"worktree"}, null, null, active);
        return start(baseline, working, {active});
      } catch (e) { if (active()) say(T("diff.view.read_failed", {error: e.message})); return null; }
    }
    const working = {project: host.project(), label: "Working design", working: true, spec: {type: "working"}};
    const A = G.AtriumAutosave;
    host.info?.("Changes Since Last Save: looking for the last saved copy…");
    let metas = [];
    // The local history lives in IndexedDB; never wait on it for more than 2 s.
    const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);
    try { const slot = A?.slot?.(); metas = ((await within(A?.list?.(), 2000)) || []).filter(m => !slot || m.slot === slot); } catch { metas = []; }
    if (!active()) return null;
    const pick = reason => metas.filter(m => m.reason === reason).sort((x, y) => (y.ts || 0) - (x.ts || 0))[0];
    const base = pick("saved") || pick("open");
    if (!base || typeof A?.read !== "function") {
      say("Save the project or open a saved file, then use Changes Since Last Save. Compare… compares any two files.");
      return null;
    }
    try {
      const when = base.ts ? new Date(base.ts).toTimeString().slice(0, 5) : "";
      const label = (base.reason === "saved" ? tx("Last save") : tx("As opened")) + (when ? " · " + when : "");
      const snapshot = await readSpec({type:"snapshot", id:base.id, slot:base.slot, label}, null, null, active);
      return await start(snapshot, working, {active});
    } catch (e) { if (active()) say(T("diff.view.read_failed", {error: e.message})); return null; }
  }
  function attach(h) {
    host = h;
    h.on?.("change", workingChanged);
    h.on?.("replace", () => { if (S?.a.working || S?.b.working || outdated) close(true); });
    h.registerAction("diff-compare", () => open());
    h.registerAction("diff-compare-with", () => open({doc: h.currentId?.()}));
  }
  G.AtriumNavCommon?.ready(attach);
  return Object.freeze({open, start, sinceSave, close, step, select, setMode, refresh, paint: () => renderNow(), docMenu, quick, openLink, attach, session: () => S, MODES, paletteFor, inkFor});
})();
