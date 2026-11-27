"use strict";
// The visual three-way merge (Project › Git › Resolve Merge Conflicts…, Merge Three Files…; lazy).
// AtriumMerge3 merges Base, Ours and Theirs object by object; this view lists
// what merged by itself and each true conflict (one object changed on both sides). Per conflict:
// Take Ours, Take Theirs or Keep Both, with the three versions overlaid on a small drawing and field
// by field, and Compare on the full canvas (the visual diff, Base → Ours and Base → Theirs).
// The result is checked live (board DRC and schematic ERC against Ours). Nothing is written until the
// user applies the result to the editor and saves it with File › Save; marking the file resolved
// (git add) stays the user's own Git step.
//
//   AtriumMergeUI.openFromGit(host)          Base/Ours/Theirs from the index stages of a conflicted merge
//   AtriumMergeUI.openFiles(host)            three .waffle files chosen by the user (also in the browser)
//   AtriumMergeUI.open(host, {base, ours, theirs, labels})
globalThis.AtriumMergeUI = (() => {
  const G = globalThis, M = () => G.AtriumMerge3;
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const btn = (text, fn, cls, label) => {
    const b = el("button", text, cls); b.type = "button";
    b.classList.add("ui-button");
    if (cls === "is-primary") b.dataset.variant = "primary";
    b.onclick = fn;
    if (label) { b.title = label; b.setAttribute("aria-label", label); } return b;
  };
  // A conflict's state badge: open in warning, then the side it took.
  const MG_TONES = {open: "warning", ours: "accent", theirs: "info", both: "success"};
  const SVG = "http://www.w3.org/2000/svg";
  const isObj = v => v !== null && typeof v === "object" && !Array.isArray(v);
  const show = v => v === undefined ? "—" : typeof v === "number" ? String(Number(v.toPrecision(8))) : typeof v === "string" ? (v.length > 48 ? v.slice(0, 45) + "…" : v) :
    (t => t.length > 48 ? (Array.isArray(v) ? v.length + " entries" : "{…}") : t)(JSON.stringify(v));
  const STATUS = {"modified-both": "Changed on both sides", "deleted-ours": "Deleted in ours, changed in theirs", "deleted-theirs": "Changed in ours, deleted in theirs", "added-both": "Added differently on both sides"};

  // ------------------------------------------------------------------ the drawing (overlay of three versions)
  function pointsOf(o) {
    if (!isObj(o)) return [];
    if (Array.isArray(o.points)) return o.points.filter(p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite));
    if (Number.isFinite(o.x) && Number.isFinite(o.y)) return [[o.x, o.y]];
    return [];
  }
  function sketch(c) {
    const sides = [["base", c.base], ["ours", c.sides?.ours ?? c.ours], ["theirs", c.sides?.theirs ?? c.theirs]].filter(([, v]) => pointsOf(v).length);
    if (!sides.length) return null;
    const all = sides.flatMap(([, v]) => pointsOf(v));
    let [x0, y0, x1, y1] = [Math.min(...all.map(p => p[0])), Math.min(...all.map(p => p[1])), Math.max(...all.map(p => p[0])), Math.max(...all.map(p => p[1]))];
    const span = Math.max(x1 - x0, y1 - y0, 4), pad = span * .3;
    x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
    // A 4:3 view, centred.
    const w = Math.max(x1 - x0, (y1 - y0) * 4 / 3), h = w * 3 / 4, cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    [x0, x1, y0, y1] = [cx - w / 2, cx + w / 2, cy - h / 2, cy + h / 2];
    const s = document.createElementNS(SVG, "svg");
    s.setAttribute("viewBox", [x0, y0, x1 - x0, y1 - y0].join(" ")); s.setAttribute("class", "mg-sketch"); s.setAttribute("role", "img");
    s.setAttribute("aria-label", "Base, ours and theirs overlaid: " + sides.map(([k, v]) => k + " at " + pointsOf(v)[0].map(n => n.toFixed(2)).join(", ")).join("; "));
    const r = Math.max(x1 - x0, y1 - y0) / 40;
    for (const [side, v] of sides) {
      const pts = pointsOf(v), g = document.createElementNS(SVG, "g");
      g.setAttribute("class", "mg-" + side);
      if (pts.length > 1) {
        const p = document.createElementNS(SVG, "polyline");
        p.setAttribute("points", pts.map(q => q.join(",")).join(" ")); p.setAttribute("stroke-width", String(Math.max(v.width || 0, r / 2)));
        g.append(p);
      } else {
        const dot = document.createElementNS(SVG, "circle");
        dot.setAttribute("cx", String(pts[0][0])); dot.setAttribute("cy", String(pts[0][1])); dot.setAttribute("r", String(r * (side === "base" ? 1.6 : 1.1)));
        g.append(dot);
        const t = document.createElementNS(SVG, "text");
        const dy = side === "ours" ? -r * 2 : side === "theirs" ? r * 3.6 : r * 5.2;
        t.setAttribute("x", String(pts[0][0])); t.setAttribute("y", String(pts[0][1] + dy)); t.setAttribute("font-size", String(r * 2.2)); t.setAttribute("text-anchor", "middle");
        t.textContent = side[0].toUpperCase() + side.slice(1); g.append(t);
      }
      s.append(g);
    }
    return s;
  }

  // ------------------------------------------------------------------ live checks
  async function checks(project) {
    const L = G.AtriumLazy, out = {drc: null, erc: null};
    const boards = project.documents.filter(d => d.kind === "pcb");
    const needed = ["AtriumRules", "AtriumERC"];
    if (boards.length) needed.push("AtriumConnectivity");
    try { if (L) await L.need(needed); } catch { return out; }
    const defs = new Map((project.library || []).map(d => [d.id, d]));
    try {
      if (G.AtriumRules?.drc) {
        let n = 0;
        for (const doc of boards) {
          const rules = G.AtriumRules.stored(doc, project) || G.AtriumRules.defaults();
          n += (G.AtriumRules.drc(doc, defs, rules, {limit: 1000}).violations || []).length;
          await new Promise(r => setTimeout(r, 0));
        }
        out.drc = n;
      }
    } catch { out.drc = null; }
    try {
      if (G.AtriumERC && project.documents.some(d => d.kind === "schematic")) {
        const r = await G.AtriumERC.runAsync(project);
        out.erc = r.counts.Error + r.counts.Fatal;
      }
    } catch { out.erc = null; }
    return out;
  }

  // ------------------------------------------------------------------ the view
  function open(host, o) {
    const result = M().merge(o.base, o.ours, o.theirs, {nativeConflicts:o.nativeConflicts});
    const labels = {base: "Base", ours: "Ours", theirs: "Theirs", ...(o.labels || {})};
    const choices = {};
    const d = el("dialog", null, "work-dialog ui-dialog mg-dialog"); d.setAttribute("aria-label", "Resolve merge conflicts");
    const head = el("header", null, "mg-head"), title = el("h2", result.conflicts.length ? "Resolve merge conflicts" : "Merge result");
    const sub = el("p", "Merging " + labels.theirs + " into " + labels.ours + " · " + result.stats.changes + " changes merged by themselves (" + result.stats.ours + " ours, " +
      result.stats.theirs + " theirs) · " + result.conflicts.length + (result.conflicts.length === 1 ? " conflict" : " conflicts"), "mg-sub");
    head.append(title, sub);
    const renames = Object.entries({...result.renames.ours, ...result.renames.theirs});
    if (renames.length) head.append(el("p", "Net renames carried into the other side's new objects: " + renames.map(([a, b]) => a + " → " + b).join(", "), "mg-note"));
    const renum = result.renumbered || [];
    if (renum.length) head.append(el("p", "Both sides added the same designator; theirs renumbered: " + renum.slice(0, 12).map(r => r.from + " → " + r.to).join(", ") + (renum.length > 12 ? " …" : ""), "mg-note"));
    const body = el("div", null, "mg-body"), nav = el("nav", null, "mg-nav"), detail = el("section", null, "mg-detail");
    nav.setAttribute("aria-label", "Conflicts and merged changes");
    const conflictList = el("div", null, "ui-list mg-list"); conflictList.dataset.layout = "flush"; conflictList.setAttribute("role", "listbox"); conflictList.setAttribute("aria-label", "Conflicts"); conflictList.tabIndex = 0;
    const autoBox = el("details", null, "mg-auto"); autoBox.append(el("summary", "Merged by themselves (" + result.changes.length + ")"));
    const autoList = el("ul", null, "mg-auto-list");
    for (const c of result.changes.slice(0, 400)) {
      const li = el("li", null, "mg-auto-row is-" + c.side);
      li.append(el("span", c.side === "both" ? "Both" : c.side === "ours" ? "Ours" : "Theirs", "mg-side"), el("span", c.status + " · " + c.label + (c.docName ? " · " + c.docName : ""), "mg-auto-text"));
      autoList.append(li);
    }
    if (result.changes.length > 400) autoList.append(el("li", "… and " + (result.changes.length - 400) + " more", "mg-auto-row"));
    autoBox.append(autoList);
    const bulk = el("div", null, "mg-bulk");
    bulk.append(btn("All Ours", () => { for (const c of result.conflicts) choices[c.id] = "ours"; repaint(); }), btn("All Theirs", () => { for (const c of result.conflicts) choices[c.id] = "theirs"; repaint(); }));
    nav.append(el("h3", "Conflicts"), conflictList, bulk, autoBox);
    body.append(nav, detail);
    const checkLine = el("p", null, "mg-checks"); checkLine.setAttribute("role", "status");
    const apply = btn("Apply to Editor", applyResult, "is-primary", "Put the merged design in the editor; File › Save writes it");
    const cancel = btn("Cancel", () => d.close());
    const compareResult = btn("Compare Result with Ours", async () => {
      try { await G.AtriumGit.compare({project: o.ours, label: labels.ours}, {project: resolved(), label: "Merge result"}); } catch (e) { host.info(e.message); }
    });
    const foot = el("div", null, "work-actions ui-dialog-actions mg-foot"); foot.append(checkLine, compareResult, cancel, apply);
    d.append(head, body, foot);
    let selected = result.conflicts.length ? 0 : -1, checkTimer = 0, checkTicket = 0, baseline = null;
    const copyIds = new Map();
    const resolved = () => M().resolve(result, choices, copyIds);
    function chip(c) { const v = choices[c.id]; return v ? ({ours: "Ours", theirs: "Theirs", both: "Both"})[v] : "Unresolved"; }
    function paintList() {
      conflictList.replaceChildren();
      if (!result.conflicts.length) { conflictList.append(el("p", "No conflicts: every change merged by itself.", "mg-empty")); return; }
      result.conflicts.forEach((c, i) => {
        const r = el("div", null, "ui-row mg-row" + (choices[c.id] ? " is-done" : ""));
        r.setAttribute("role", "option"); r.id = "mg-opt-" + i; r.setAttribute("aria-selected", String(i === selected));
        const text = el("span", null, "mg-row-text");
        text.append(el("strong", c.label), el("small", (c.docName ? c.docName + " · " : "") + (STATUS[c.status] || c.status), "ui-row-detail"));
        const state = el("span", chip(c), "ui-badge mg-chip");
        state.dataset.tone = MG_TONES[choices[c.id] || "open"];
        r.append(text, state);
        r.onclick = () => { selected = i; repaint(); };
        conflictList.append(r);
      });
      if (selected >= 0) conflictList.setAttribute("aria-activedescendant", "mg-opt-" + selected);
    }
    conflictList.onkeydown = e => {
      const n = result.conflicts.length; if (!n) return;
      const to = ({ArrowDown: Math.min(selected + 1, n - 1), ArrowUp: Math.max(selected - 1, 0), Home: 0, End: n - 1})[e.key];
      if (to != null) { e.preventDefault(); selected = to; repaint(); conflictList.querySelector('[aria-selected="true"]')?.scrollIntoView?.({block: "nearest"}); return; }
      const key = ({o: "ours", t: "theirs", b: "both"})[e.key.toLowerCase()];
      if (key && (key !== "both" || result.conflicts[selected].both)) { e.preventDefault(); take(key); }
    };
    function take(side) {
      const c = result.conflicts[selected]; if (!c) return;
      choices[c.id] = side;
      const next = result.conflicts.findIndex((x, i) => i > selected && !choices[x.id]);
      if (next >= 0) selected = next;
      repaint();
    }
    function paintDetail() {
      detail.replaceChildren();
      const c = result.conflicts[selected];
      if (!c) {
        detail.append(el("h3", "Everything merged"), el("p", "Apply the result to the editor, check it, then save. " + result.stats.changes + " changes came from both sides without conflict."));
        return;
      }
      const top = el("header", null, "mg-detail-head");
      top.append(el("h3", c.label), el("p", (c.docName ? c.docName + " · " : "") + (STATUS[c.status] || c.status) + (c.fields?.length ? " · conflicting: " + c.fields.join(", ") : "")));
      detail.append(top);
      const cols = el("div", null, "mg-cols");
      const picture = sketch(c);
      if (picture) { const fig = el("figure", null, "mg-figure"); fig.append(picture, el("figcaption", "Base (dashed), Ours and Theirs overlaid")); cols.append(fig); }
      const t = el("table", null, "mg-fields"), hr = el("tr");
      for (const h of ["Field", labels.base, labels.ours, labels.theirs]) { const th = el("th", h); th.scope = "col"; hr.append(th); }
      t.append(el("thead")); t.firstChild.append(hr);
      const tb = el("tbody");
      const raw = {base: c.base, ours: c.sides?.ours ?? c.ours, theirs: c.sides?.theirs ?? c.theirs};
      const keys = new Set([...Object.keys(raw.base || {}), ...Object.keys(raw.ours || {}), ...Object.keys(raw.theirs || {})]);
      const conflicting = new Set((c.fields || []).map(f => f.split(/[.[]/)[0]));
      for (const k of [...keys].sort((a, b) => conflicting.has(b) - conflicting.has(a) || a.localeCompare(b))) {
        if (k === "id") continue;
        const vals = [raw.base?.[k], raw.ours?.[k], raw.theirs?.[k]];
        const differ = JSON.stringify(vals[1]) !== JSON.stringify(vals[0]) || JSON.stringify(vals[2]) !== JSON.stringify(vals[0]);
        if (!differ && !conflicting.has(k)) continue;
        const r = el("tr", null, conflicting.has(k) ? "is-conflict" : "");
        const th = el("th", k); th.scope = "row"; r.append(th);
        vals.forEach((v, n) => r.append(el("td", raw[["base", "ours", "theirs"][n]] === undefined ? (n ? "deleted" : "—") : show(v), n && JSON.stringify(v) !== JSON.stringify(vals[0]) ? "is-changed" : "")));
        tb.append(r);
      }
      t.append(tb); cols.append(t); detail.append(cols);
      const acts = el("div", null, "mg-take");
      const mk = (side, text, hint) => { const b = btn(text, () => take(side), "mg-take-btn", hint); b.setAttribute("aria-pressed", String(choices[c.id] === side)); return b; };
      acts.append(mk("ours", "Take Ours", "Keep our version (O)"), mk("theirs", "Take Theirs", "Use their version (T)"));
      if (c.both) acts.append(mk("both", "Keep Both", "Keep ours and add theirs as a copy with a new designator (B)"));
      const where = el("div", null, "mg-canvas");
      where.append(btn("Base → Ours on canvas", () => canvas(c, "ours")), btn("Base → Theirs on canvas", () => canvas(c, "theirs")));
      detail.append(acts, where);
    }
    async function canvas(c, side) {
      try { await G.AtriumGit.compare({project: o.base, label: labels.base}, {project: o[side], label: labels[side]}, {doc: c.docId, focus: c.objectId}); }
      catch (e) { host.info(e.message); }
    }
    function scheduleChecks() {
      clearTimeout(checkTimer);
      checkTimer = setTimeout(async () => {
        const id = ++checkTicket;
        checkLine.textContent = "Checking the merged design…";
        if (!baseline) baseline = await checks(o.ours);
        const now = await checks(resolved());
        if (id !== checkTicket || !d.open) return;
        const part = (name, n, b) => n == null ? "" : name + " " + n + (b != null && b !== n ? " (" + (n > b ? "+" : "") + (n - b) + " vs ours)" : "");
        const open_ = result.conflicts.filter(x => !choices[x.id]).length;
        checkLine.textContent = [open_ ? open_ + " unresolved (ours kept)" : "All conflicts resolved", part("DRC", now.drc, baseline.drc), part("ERC errors", now.erc, baseline.erc)].filter(Boolean).join(" · ");
      }, 250);
    }
    function repaint() { paintList(); paintDetail(); scheduleChecks(); }
    async function applyResult() {
      const open_ = result.conflicts.filter(c => !choices[c.id]).length;
      if (open_ && !G.confirm?.(open_ + (open_ === 1 ? " conflict is" : " conflicts are") + " unresolved and will keep our version. Apply anyway?")) return;
      const project = resolved();
      if (o.active) {
        apply.disabled = true;
        try {
          const P = await G.AtriumLazy.need("AtriumProposal");
          await host.requireProjectClosure({purpose:"comparison",assets:false});
          await o.verifyStages();
          if (!o.active()) throw Error("The working design changed. Reopen merge review.");
          const {proposal} = P.build(o.ours, project, {allowV1:false});
          if (proposal) {
            const edit = (fn, label, touched, scope) => G.AtriumFolderProjectUI.atomicEdit(o.folder, () =>
              host.edit(fn, "Resolve Git merge", touched, scope));
            // The merged design is the user's own: keep its designators as Git merged them.
            const applied = P.applyChecked(host.project(), proposal, {validate:G.Atrium.validate, edit, designators:false});
            if (!applied) return;
          }
          d.close();
          host.info("Merge reviewed in the editor. Save the changed documents before staging the resolution in Git.");
        } catch (error) { host.info(error.message); }
        finally { apply.disabled = false; }
        return;
      }
      d.close();
      if (await host.replaceProject(project, {dirty: true})) host.info("The merged design is in the editor. Check it, then save.");
    }
    apply.dataset.uiDefault = "false";
    G.AtriumShell.openDialog(d, {title, body, actions: foot, initialFocus: () => result.conflicts.length ? conflictList : cancel, beforeRemove() { clearTimeout(checkTimer); checkTicket++; }});
    repaint();
    return {dialog: d, result, choices, take: (id, side) => { const i = result.conflicts.findIndex(c => c.id === id); if (i >= 0) { selected = i; take(side); } }, resolved};
  }

  async function openFromGit(host) {
    const GIT = G.AtriumGit;
    const decode = data => Uint8Array.fromBase64 ? Uint8Array.fromBase64(data) : Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const explain = (text, versions, verifyStages, resolveRemoved) => {
      const d = el("dialog", null, "work-dialog ui-dialog gp-confirm"); d.setAttribute("aria-label", "Resolve merge conflicts");
      const foot = el("div", null, "work-actions ui-dialog-actions"), close = btn("Close", () => d.close(), "is-primary");
      if (!versions) foot.append(btn("Merge Three Files…", () => { d.close(); openFiles(host).catch(e => host.info(e.message)); }));
      foot.append(close);
      const title = el("h2", "Resolve merge conflicts"), body = el("div");
      body.append(el("p", text));
      if (versions) {
        const list = el("ul"), labels = {base:"Base", ours:"Ours", theirs:"Theirs"};
        for (const {path, stages, removed} of versions) {
          const row = el("li"), name = path.split("/").at(-1);
          const edited = removed && stages.find(stage => stage.label === removed.edit)?.data;
          row.append(el("p", path));
          if (removed) row.append(el("p", removed.edit === "ours" ? "Ours edited this document. Theirs deleted it." :
            "Ours deleted this document. Theirs edited it."));
          if (edited) {
            const preview = el("details");
            preview.append(el("summary", "Show edited records"));
            preview.addEventListener("toggle", () => {
              if (!preview.open || preview.lastChild.tagName === "PRE") return;
              const limit = 24 * 1024;
              const text = new TextDecoder().decode(decode(edited.slice(0,limit)));
              const block = el("pre", text + (edited.length > limit ? "\n…" : ""));
              preview.append(block);
            });
            row.append(preview);
          }
          for (const {label, data} of stages) {
            const action = btn("Export " + labels[label], async () => {
              try {
                await verifyStages();
                await host.exportFile(label + "-" + name, decode(data));
              } catch (error) { host.info(error.message); }
            });
            row.append(action);
          }
          if (removed && resolveRemoved) {
            const choose = async choice => {
              for (const button of row.querySelectorAll("button")) button.disabled = true;
              try {
                await resolveRemoved(path,removed,edited,choice);
                d.close();
                host.info(choice ? "The edited document and its project reference were restored. Stage them in Git when ready." :
                  "The project keeps the deletion. Use Git to stage the deletion of the remaining file.");
              } catch (error) { host.info(error.message); }
              finally { for (const button of row.querySelectorAll("button")) button.disabled = false; }
            };
            if (edited) row.append(btn("Keep Deletion", () => choose(false)), btn("Restore Edited Document", () => choose(true)));
          }
          list.append(row);
        }
        body.append(list);
      }
      d.append(title, body, foot);
      G.AtriumShell.openDialog(d, {title, body, actions: foot, initialFocus: close});
      return null;
    };
    if (!GIT?.available()) return explain("Merge conflicts are read from Git: open a project saved in a Git repository in the desktop app while a merge is in progress. Merge Three Files… merges any base, ours and theirs files.");
    const bound = GIT.bound(), folder = host.folderProject?.(), current = host.project();
    const revision = host.revision();
    const active = () => bound() && host.folderProject?.() === folder && host.project() === current && host.revision() === revision;
    const st = await GIT.status();
    if (!active()) throw Error("The active project changed. Reopen merge review.");
    if (!st.conflicted) return explain("This project is not in a merge conflict" + (st.mergeHead ? "." : ": no merge is in progress.") + " With the Waffle merge driver set up (Project › Git › Set Up Merge Driver…), Git merges different objects by itself and leaves only objects changed on both sides for this view.");
    async function verifyStages() {
      const latest = await GIT.status();
      if (!active() || latest.head !== st.head || latest.mergeHead !== st.mergeHead || latest.indexBlob !== st.indexBlob ||
          latest.conflictVersion !== st.conflictVersion) throw Error("The Git conflict changed. Reopen merge review.");
    }
    const review = await GIT.readStages(st.conflicts || [], active);
    await verifyStages();
    if (review.exact) {
      const resolveRemoved = folder?.resolveGitOwner && !folder.readOnly ? (path, owner, edited, chooseEdit) =>
        folder.resolveGitOwner(owner.id,path,
          (manifest,current) => GIT.planRemovedOwner({path,owner,edited,chooseEdit,manifest,current},active), verifyStages) : null;
      return explain("These conflicts need the exact saved records. Choose a resolution where available, or export an original version to inspect it.",
        review.versions, verifyStages, resolveRemoved);
    }
    const [base, ours, theirs] = review.stages.map(stage => stage.project);
    return open(host, {base, ours, theirs, folder, active, verifyStages, nativeConflicts:review.atomic,
      labels: {base: "Base", ours: "Ours" + (st.ref ? " (" + st.ref.replace(/^refs\/heads\//, "") + ")" : ""), theirs: "Theirs" + (st.mergeHead ? " (" + GIT.short(st.mergeHead) + ")" : "")}});
  }
  async function openFiles(host) {
    const pick = async what => {
      host.info("Choose the " + what + " project ZIP…");
      return (await G.AtriumLazy.need("AtriumProjectArchiveUI")).chooseReference();
    };
    const base = await pick("base (common ancestor)"); if (!base) return null;
    const ours = await pick("ours"); if (!ours) return null;
    const theirs = await pick("theirs"); if (!theirs) return null;
    return open(host, {base: base.project, ours: ours.project, theirs: theirs.project, labels: {base: "Base · " + base.name, ours: "Ours · " + ours.name, theirs: "Theirs · " + theirs.name}});
  }
  const run = (h, fn) => () => fn(h).catch(e => h.info(e.message));
  function attach(h) {
    h.registerAction?.("merge-conflicts", run(h, openFromGit));
    h.registerAction?.("merge-files", run(h, openFiles));
  }
  if (typeof document !== "undefined") G.AtriumNavCommon?.ready?.(attach);
  return Object.freeze({open, openFromGit, openFiles, attach, checks});
})();
