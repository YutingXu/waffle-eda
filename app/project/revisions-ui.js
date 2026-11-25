"use strict";
// Board revisions in the editor (Project › Revisions…, the status-bar chip, the read-only banner).
// The model lives in revisions.js (AtriumRevisions); this module is the UI and loads with it.
//
//   open(ctx, {view})   the Board Revisions dialog: the working revision (notes, Release, New
//                       Revision From…), the frozen revisions (compare, start from, obsolete) and
//                       the release flow (checks -> outputs -> freeze, one undo step)
//   compareWith(ctx)    Compare with Revision…: picks a revision, opens the visual diff (diff-view.js)
//   newFrom(ctx)        New Revision From…  ·  release(ctx)  Release Revision…
//   blocked(p)          called by AtriumRevisions.guard when an edit hits a released revision
// No hover pop-ups: everything is a click, a key or a visible line of text.
globalThis.AtriumRevisionsUI = (() => {
  const G = globalThis, RV = () => G.AtriumRevisions;
  const hasDOM = () => typeof document !== "undefined" && !!document.createElement;
  const plural = (n, w) => globalThis.AtriumI18n?.plural?.(n, w) ?? n + " " + w + (n === 1 ? "" : "s");
  const size = n => n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB";
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs, {omitNull:true}); }
  // A revision or check status is a library badge; obsolete and skipped stay neutral.
  const STATUS_TONES = {draft: "info", released: "success", pass: "success", fail: "danger", warn: "warning"};
  function statusBadge(text, status) { const b = el("span", text, "ui-badge revisions-chip"); if (STATUS_TONES[status]) b.dataset.tone = STATUS_TONES[status]; return b; }
  function btn(text, fn, cls, label) {
    const b = el("button", text, cls); b.type = "button";
    b.classList.add("ui-button"); b.dataset.size = "lg";
    if (cls === "primary" || cls === "revision-banner-primary") b.dataset.variant = "primary";
    b.onclick = fn;
    if (label) b.setAttribute("aria-label", label);
    return b;
  }
  let host = null, chip = null, banner = null, chipSig = "";

  function ctxOf(ctx) {
    const live = () => ctx?.currentProject?.() || host?.project?.() || ctx?.project;
    const info = m => (ctx?.info || host?.info)?.(m);
    // One undo step, allowed through the read-only gate (these are the revision operations).
    const edit = (fn, label) => {
      let out;
      RV().allow(() => { const run = () => { out = fn(live()); }; if (host?.edit) host.edit(run, label); else if (typeof ctx?.edit === "function") ctx.edit(run); else run(); });
      sync(true);
      return out;
    };
    return {live, info, edit, exportFile: ctx?.exportFile || host?.exportFile};
  }

  // ------------------------------------------------------------ status bar chip + banner
  function sync(force) {
    if (!hasDOM() || !host) return;
    const p = host.project?.(), R = RV();
    if (!p || !R) return;
    const w = R.working(p), sig = w ? w.letter + "|" + w.status + "|" + R.list(p).length : "-";
    if (!force && sig === chipSig) return;
    chipSig = sig;
    installChip();
    if (chip) {
      chip.hidden = !w;
      if (w) {
        chip.textContent = "Rev " + w.letter + " · " + R.statusLabel(w.status);
        chip.dataset.status = w.status;
        chip.setAttribute("aria-label", "Board revision " + w.letter + ", " + R.statusLabel(w.status) + ". Open Board Revisions.");
      }
    }
    paintBanner(p);
  }
  function installChip() {
    if (chip?.isConnected) return;
    const bar = document.querySelector("footer.statusbar");
    if (!bar) return;
    chip = bar.querySelector(".revision-chip") || el("button", "", "revision-chip status-action", {type:"button"});
    if (!chip.isConnected) {
      chip.onclick = () => open({});
      const anchor = bar.querySelector(".variant-switch") || bar.querySelector("#doc-kind");
      if (anchor) anchor.after(chip); else bar.append(chip);
    }
  }
  function paintBanner(p) {
    const R = RV(), w = R.working(p);
    if (!R.locked(p)) { banner?.remove(); banner = null; return; }
    if (!banner) {
      // A floating library notice over the canvas (ui/components.css): dot, text, actions.
      banner = el("div", null, "ui-notice revision-banner", {role: "status", "data-floating": "", "data-tone": "success"});
      document.body.append(banner);
    }
    const text = el("div", null, "ui-notice-text"), actions = el("div", null, "ui-notice-actions");
    text.append(el("span", "Rev " + w.letter, "ui-notice-title"), " " + R.statusLabel(w.status) + " · read-only. Edits start in a new revision.");
    actions.append(btn("New Revision From " + w.letter, () => newFrom({}, null), "revision-banner-primary"), btn("Revisions…", () => open({}), "revision-banner-more"));
    for (const b of actions.children) delete /** @type {HTMLElement} */ (b).dataset.size; // the notice sizes its actions
    banner.replaceChildren(el("span", null, "ui-dot", {"aria-hidden": "true", "data-tone": "success"}), text, actions);
  }
  function blocked(p) {
    sync(true);
    host?.info?.(RV().message(p));
    if (banner && hasDOM()) { banner.classList.remove("is-cue"); void banner.offsetWidth; banner.classList.add("is-cue"); }
  }

  // ------------------------------------------------------------ dialog
  function open(ctx = {}, options = {}) {
    if (!hasDOM()) throw Error("Board revisions need a window.");
    document.querySelectorAll("dialog.revisions-dialog").forEach(d => d.close());
    const c = ctxOf(ctx), R = RV();
    const d = el("dialog", null, "work-dialog ui-dialog revisions-dialog", {"aria-labelledby": "revisions-heading"});
    const heading = el("h2", "Board Revisions", null, {id: "revisions-heading"}), summary = el("p", null, "revisions-summary", {role: "status"});
    const head = el("header", null, "revisions-head"), titles = el("div");
    titles.append(heading, summary);
    head.append(titles, btn("Close", () => d.close(), "revisions-close"));
    const body = el("div", null, "revisions-body"), foot = el("footer", null, "revisions-foot"), status = el("span", null, "revisions-status", {role: "status"});
    foot.append(status);
    d.append(head, body, foot);
    let view = options.view || "overview", focusRow = 0;
    const say = (m, bad) => { status.textContent = m || ""; status.classList.toggle("is-bad", !!bad); };
    const run = (fn, label, done) => { try { const r = c.edit(fn, label); say(done ? done(r) : ""); } catch (e) { say(e.message, true); } paint(); };

    function paint() {
      const p = c.live(), w = R.working(p), revs = R.list(p), st = R.storeStats(p);
      summary.textContent = w ? "Working: Rev " + w.letter + " · " + R.statusLabel(w.status) + (w.from ? " · from Rev " + w.from : "") + " · " + plural(revs.length, "frozen revision")
        : "Revision tracking is off for this project.";
      body.replaceChildren(view === "release" ? releaseView(p) : overview(p, w, revs, st));
    }

    function overview(p, w, revs, st) {
      const box = el("div", null, "revisions-overview");
      // The working revision.
      const card = el("section", null, "revisions-working" + (w ? " is-" + w.status : ""), {"aria-label": "Working revision"});
      if (!w) {
        const empty = el("div", null, "revisions-empty");
        empty.append(el("strong", "No revisions yet"),
          el("p", "A revision is a named, frozen copy of the board (A, B, C…). Start Rev A, edit as usual, then Release: Waffle runs the DRC and ERC, " +
            "writes the outputs to " + R.outputsFolder(p, "A") + "/ and freezes the design. Released revisions are read-only; New Revision From… starts the next one."));
        const letter = el("input", null, "revisions-letter ui-field", {"aria-label": "First revision", maxlength: "8", value: R.nextLetter(p)});
        const go = btn("Start Rev " + R.nextLetter(p), () => run(q => R.start(q, {letter: letter.value}), "Start revision " + letter.value, r => "Rev " + r.letter + " started as a draft."), "primary");
        letter.oninput = () => { go.textContent = "Start Rev " + (letter.value.trim().toUpperCase() || "?"); };
        const row = el("div", null, "revisions-row"); row.append(el("label", "First revision", null, {for: "rev-first"}), letter, go); letter.id = "rev-first";
        empty.append(row);
        card.append(empty);
        box.append(card);
        setTimeout(() => go.focus(), 0);
        return box;
      }
      const top = el("div", null, "revisions-working-top");
      top.append(el("span", "Rev " + w.letter, "revisions-letter-big"), chipOf(w.status));
      const meta = el("span", [w.date ? "Started " + w.date : "", w.from ? "from Rev " + w.from : ""].filter(Boolean).join(" · "), "revisions-meta");
      top.append(meta);
      card.append(top);
      const notes = el("textarea", null, "revisions-notes ui-field", {rows: "3", "aria-label": "Revision notes", placeholder: "What changed in this revision (shown in the release and in =RevisionNotes)"});
      notes.value = w.notes || "";
      const acts = el("div", null, "revisions-actions");
      if (w.status === "draft") {
        notes.onchange = () => run(q => R.setNotes(q, notes.value), "Edit revision notes", () => "Notes saved.");
        acts.append(btn("Release Rev " + w.letter + "…", () => { view = "release"; paint(); }, "primary"));
      } else {
        notes.readOnly = true;
        acts.append(el("span", "Rev " + w.letter + " is " + R.statusLabel(w.status).toLowerCase() + " and read-only.", "revisions-locked"),
          btn("New Revision From " + w.letter, () => { newFrom(ctx, null); paint(); }, "primary"));
      }
      if (revs.length) acts.append(btn("Compare with Revision…", () => compareWith(ctx)));
      card.append(notes, acts);
      box.append(card);
      // Frozen revisions.
      const sec = el("section", null, "revisions-history", {"aria-label": "Frozen revisions"});
      sec.append(el("h3", "Frozen revisions"));
      if (!revs.length) sec.append(el("p", "Nothing frozen yet. Release Rev " + w.letter + " to freeze it; it then appears here, read-only, with its checks and outputs.", "revisions-hint"));
      else {
        const t = el("table", null, "revisions-table", {role: "grid", "aria-label": "Frozen revisions"}), th = el("thead"), tb = el("tbody"), hr = el("tr");
        for (const h of ["Rev", "Status", "Date", "Notes", "Checks", "Stored", ""]) hr.append(el("th", h, null, {scope: "col"}));
        th.append(hr);
        revs.slice().reverse().forEach((r, i) => {
          const tr = el("tr", null, i === focusRow ? "is-focus" : "", {tabindex: i === focusRow ? "0" : "-1", "aria-rowindex": String(i + 1)});
          const fails = (r.checks || []).filter(x => x.status === "fail").length, over = (r.overrides || []).length;
          const checks = !r.checks?.length ? "—" : fails ? (over ? plural(over, "override") : plural(fails, "failure")) : "Passed";
          const cmp = btn("Compare", () => startDiff(ctx, r.id, "working"), null, "Compare Rev " + r.letter + " with the working design");
          const from = btn("Start from", () => { newFrom(ctx, r.id); paint(); }, null, "Start the next revision from Rev " + r.letter);
          const flip = btn(r.status === "obsolete" ? "Reinstate" : "Obsolete", () => run(q => R.setStatus(q, r.id, r.status === "obsolete" ? "released" : "obsolete"),
            "Mark revision " + r.letter + " " + (r.status === "obsolete" ? "released" : "obsolete"), x => "Rev " + x.letter + " is " + R.statusLabel(x.status).toLowerCase() + "."), null,
            (r.status === "obsolete" ? "Mark Rev " + r.letter + " released again" : "Mark Rev " + r.letter + " obsolete"));
          const tdA = el("td", null, "revisions-row-actions"); tdA.append(cmp, from, flip);
          const stDiv = el("td"); stDiv.append(chipOf(r.status));
          tr.append(el("th", r.letter, "revisions-rev", {scope: "row"}), stDiv, el("td", r.date), el("td", r.notes || "—", "revisions-note-cell"),
            el("td", checks, fails && !over ? "is-bad" : ""), el("td", r.stored ? "+" + size(r.stored.bytes) : "—", "revisions-num"), tdA);
          tr.onfocus = () => { focusRow = i; };
          tr.onkeydown = e => {
            const rows = [...tb.rows];
            if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const n = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]; rows.forEach(x => { x.tabIndex = -1; x.classList.remove("is-focus"); }); n.tabIndex = 0; n.classList.add("is-focus"); n.focus(); }
            else if (e.key === "Enter" && e.target === tr) { e.preventDefault(); cmp.click(); }
          };
          tb.append(tr);
        });
        t.append(th, tb);
        const wrap = el("div", null, "revisions-table-wrap"); wrap.append(t);
        sec.append(wrap, el("p", plural(revs.length, "revision") + " stored in " + size(st.bytes) + ": each revision keeps only the parts of the design that changed.", "revisions-hint"));
      }
      box.append(sec);
      return box;
    }
    const chipOf = s => statusBadge(R.statusLabel(s), s);

    // ---------------------------------------------------------- release flow
    const rel = {job: null, variants: "active", outputs: true, overrides: {}, checks: null, busy: false, files: null, folder: ""};
    function releaseView(p) {
      const w = R.working(p), letter = w && !w.legacy ? w.letter : R.nextLetter(p), box = el("div", null, "revisions-release");
      const back = btn("← Back", () => { view = "overview"; paint(); }, "revisions-back");
      box.append(back, el("h3", "Release Rev " + letter));
      box.append(el("p", "Releasing runs the checks of the job set, makes its outputs in " + R.outputsFolder(p, letter) + "/ and freezes Rev " + letter +
        ". After that the design is read-only; New Revision From " + letter + " starts the next revision. Undo reverses the release.", "revisions-hint"));
      const J = G.AtriumOutputJobs, grid = el("div", null, "revisions-form");
      const job = el("select", null, "ui-field", {id: "rev-job", "aria-label": "Output job set"});
      const names = J ? [...J.list(p).map(x => x.name), ...J.presets().map(x => x.name)] : ["Generic fab + assembly"];
      for (const n of [...new Set(names)]) job.add(new Option(n, n));
      rel.job = rel.job && names.includes(rel.job) ? rel.job : names.includes("Generic fab + assembly") && !J?.list(p).length ? "Generic fab + assembly" : names[0];
      job.value = rel.job; job.onchange = () => { rel.job = job.value; rel.checks = null; paint(); };
      const vs = el("select", null, "ui-field", {id: "rev-variants", "aria-label": "Variants"});
      for (const [v, t] of [["active", "Active variant"], ["base", "Base design"], ["all", "Every variant (one package each)"]]) vs.add(new Option(t, v));
      vs.value = rel.variants; vs.onchange = () => { rel.variants = vs.value; rel.checks = null; paint(); };
      const outs = el("input", null, "ui-checkbox", {type: "checkbox", id: "rev-outputs"}); outs.checked = rel.outputs; outs.onchange = () => { rel.outputs = outs.checked; };
      const field = (label, ctl, id) => { const l = el("label", label, null, {for: id}); grid.append(l, ctl); };
      field("Job set", job, "rev-job"); field("Variants", vs, "rev-variants");
      const ol = el("label", null, "revisions-check"); ol.append(outs, el("span", "Generate outputs into " + R.outputsFolder(p, letter) + "/")); grid.append(el("span"), ol);
      box.append(grid);
      // Checks
      const sec = el("section", null, "revisions-checks", {"aria-label": "Checks"});
      sec.append(el("h4", "Checks"));
      if (!rel.checks) sec.append(el("p", "Not run yet.", "revisions-hint"));
      else for (const ck of rel.checks) {
        const row = el("div", null, "revisions-check-row is-" + ck.status);
        row.append(statusBadge(ck.status === "pass" ? "Passed" : ck.status === "fail" ? "Failed" : ck.status === "warn" ? "Warning" : "Skipped", ck.status),
          el("strong", ck.label), el("span", ck.summary, "revisions-check-sum"));
        if (ck.status === "fail") {
          const why = el("input", null, "revisions-override ui-field", {"aria-label": "Reason to release despite " + ck.label, placeholder: "Reason to release anyway (recorded)", value: rel.overrides[ck.id] || ""});
          why.oninput = () => { rel.overrides[ck.id] = why.value; };
          row.append(why);
        }
        sec.append(row);
      }
      box.append(sec);
      const acts = el("div", null, "revisions-actions");
      const checkBtn = btn(rel.checks ? "Run Checks Again" : "Run Checks", () => runChecks(), rel.checks ? "" : "primary");
      const go = btn("Release Rev " + letter, () => doRelease(letter), rel.checks ? "primary" : "");
      go.disabled = rel.busy || !rel.checks; checkBtn.disabled = rel.busy;
      acts.append(checkBtn, go);
      if (rel.files) acts.append(btn("Save Outputs (.zip)", () => saveOutputs(), "primary"));
      box.append(acts);
      return box;
    }
    async function modules() {
      const L = G.AtriumLazy;
      if (!G.AtriumOutputJobs && L) await L.need("AtriumOutputJobs");
      if (!G.AtriumRelease && L) await L.need("AtriumReleaseUI");
      if (!G.AtriumRelease) throw Error("Releasing needs the Release page (release.js), which is not in this build.");
    }
    async function runChecks() {
      rel.busy = true; say("Running the checks…"); paint();
      try {
        await modules();
        const pre = G.AtriumRelease.preflight(c.live(), rel.job, {variants: rel.variants, unsaved: false, git: {available: false}});
        rel.checks = pre.checks.filter(x => x.id !== "git");
        const fails = rel.checks.filter(x => x.status === "fail").length;
        say(fails ? plural(fails, "check") + " failed: fix them, or give a reason to release anyway." : "All checks passed.", !!fails);
      } catch (e) { say(e.message, true); }
      rel.busy = false; paint();
    }
    async function doRelease(letter) {
      if (rel.busy) return;
      const overrides = Object.entries(rel.overrides).filter(([, r]) => r && r.trim().length >= 3).map(([check, reason]) => ({check, reason: reason.trim()}));
      const blocking = G.AtriumRelease.blocking(rel.checks || [], overrides);
      if (blocking.length) { say("Fix or give a reason for: " + blocking.map(x => x.label).join(", ") + ".", true); return; }
      rel.busy = true; paint();
      const p = c.live(), stamp = host?.revision?.(), date = new Date(), folder = R.outputsFolder(p, letter);
      let res = null;
      try {
        if (rel.outputs) {
          await modules();
          const w = R.working(p) || {letter, status: "draft"};
          const frozen = {...p, revision: {...(w.legacy ? {letter: w.letter} : w), letter, status: "released", date: date.toISOString().slice(0, 10)}};
          say("Making the outputs for Rev " + letter + "…");
          res = await G.AtriumRelease.release(frozen, rel.job, {date, revision: letter, variants: rel.variants, overrides, notes: R.working(p)?.notes || "", git: {available: false}, worker: true,
            progress: e => { if (e.phase === "start") say("Rev " + letter + ": " + (e.index + 1) + " of " + e.total + ": " + e.label + "…"); }});
          if (host?.revision && host.revision() !== stamp) throw Error("The design changed while the outputs were made. Nothing was released; release again.");
        }
        c.edit(q => {
          const e = R.freeze(q, {date, letter, checks: rel.checks || [], overrides, outputs: rel.outputs ? folder + "/" : undefined, release: res?.record?.id});
          if (res?.record) G.AtriumRelease.add(q, res.record);
          return e;
        }, "Release revision " + letter);
        rel.files = res ? res.files.map(f => ({name: folder + "/" + f.name, data: f.data})) : null;
        rel.folder = folder;
        say("Released Rev " + letter + (res ? (res.ok ? "" : " (some outputs failed: see the Release page)") + ". Save the outputs below." : ". No outputs were made."), res && !res.ok);
      } catch (e) { say(e.message, true); }
      rel.busy = false; paint();
    }
    async function saveOutputs() {
      try {
        const Z = G.AtriumZip || (G.AtriumLazy ? await G.AtriumLazy.need("AtriumZip") : null);
        const data = Z.create(rel.files, {date: new Date()}), name = rel.folder.replace("/", "-") + ".zip";
        if (await c.exportFile?.(name, data)) say("Saved " + name + " (" + rel.folder + "/ inside).");
      } catch (e) { say(e.message, true); }
    }

    d.onkeydown = e => { if (e.key === "Escape" && view === "release" && !rel.busy) { e.preventDefault(); view = "overview"; paint(); } };
    d.onclose = () => d.remove();
    paint();
    G.AtriumShell.adoptDialog(d, {title: heading, body});
    document.body.append(d);
    d.showModal();
    if (view === "release" && !rel.checks) runChecks();
    return d;
  }

  // ------------------------------------------------------------ actions
  function newFrom(ctx = {}, ref) {
    const c = ctxOf(ctx), R = RV(), p = c.live(), w = R.working(p);
    if (ref === undefined) return pick(ctx, "New Revision From", "Start the next revision from", true, r => newFrom(ctx, r === "working" ? null : r));
    const src = ref ? R.find(p, ref) : null;
    let replace = false;
    if (w?.status === "draft" && !w.legacy) {
      if (!src) { c.info("Rev " + w.letter + " is still a draft: keep editing it, or release it first."); return null; }
      if (!G.confirm?.("Rev " + w.letter + " is a draft. Starting from Rev " + src.letter + " replaces the draft's design with Rev " + src.letter + "'s. Undo restores it. Continue?")) return null;
      replace = true;
    }
    try {
      const r = c.edit(q => R.newFrom(q, ref, {replaceDraft: replace}), src ? "New revision from " + src.letter : "New revision");
      c.info("Rev " + r.letter + " is a draft" + (r.from ? " from Rev " + r.from : "") + ". Edit away.");
      host?.moduleLoaded?.();
      return r;
    } catch (e) { c.info(e.message); return null; }
  }
  function startDiff(ctx, a, b) {
    const c = ctxOf(ctx), R = RV(), p = c.live();
    let pair;
    try { pair = R.compare(p, a, b); } catch (e) { c.info(e.message); return; }
    document.querySelectorAll("dialog.revisions-dialog,dialog.revisions-pick").forEach(d => d.close());
    const after = b === "working" ? {project: p, label: pair.to, working: true} : {project: pair.after, label: pair.to};
    const L = G.AtriumLazy;
    (L ? L.need("AtriumDiffView") : Promise.resolve(G.AtriumDiffView)).then(V => V.start({project: pair.before, label: pair.from}, after), e => c.info(e.message));
  }
  function compareWith(ctx = {}) {
    return pick(ctx, "Compare with Revision", "Compare the working design with", false, r => startDiff(ctx, r, "working"));
  }
  function release(ctx = {}) {
    const R = RV(), p = ctxOf(ctx).live(), w = R.working(p);
    if (R.locked(p)) { ctxOf(ctx).info(R.message(p)); return open(ctx); }
    return open(ctx, {view: w ? "release" : "overview"});
  }
  // A small list dialog: choose a frozen revision (and, for New Revision From, the working design).
  function pick(ctx, title, prompt, withWorking, done) {
    if (!hasDOM()) throw Error("Board revisions need a window.");
    const c = ctxOf(ctx), R = RV(), p = c.live(), revs = R.list(p).slice().reverse(), w = R.working(p);
    const d = el("dialog", null, "work-dialog ui-dialog revisions-pick", {"aria-label": title});
    const heading = el("h2", title), body = el("div"), actions = el("div", null, "revisions-actions ui-dialog-actions");
    let initialFocus;
    if (!revs.length && !(withWorking && w)) {
      body.append(el("p", "No frozen revisions yet. Release the working revision first (Project › Release Revision…).", "revisions-hint"));
      initialFocus = btn("Close", () => d.close(), "primary");
      actions.append(btn("Board Revisions…", () => { d.close(); open(ctx); }), initialFocus);
    } else {
      body.append(el("p", prompt + ":", "revisions-hint"));
      const listBox = el("div", null, "ui-list revisions-pick-list", {role: "listbox", "aria-label": title, tabindex: "0", "data-layout": "flush"});
      const opts = [];
      if (withWorking && w && w.status !== "draft") opts.push({id: "working", text: "Rev " + w.letter + " (working, " + R.statusLabel(w.status).toLowerCase() + ")"});
      for (const r of revs) opts.push({id: r.id, text: "Rev " + r.letter + " · " + R.statusLabel(r.status) + " · " + r.date + (r.notes ? " — " + r.notes.slice(0, 60) : "")});
      let at = 0;
      const paint = () => { listBox.replaceChildren(...opts.map((o, i) => { const b = el("div", o.text, "ui-row revisions-pick-item", {role: "option", "aria-selected": String(i === at), id: "rev-pick-" + i}); b.onclick = () => { at = i; go(); }; return b; })); listBox.setAttribute("aria-activedescendant", "rev-pick-" + at); };
      const go = () => { const o = opts[at]; d.close(); if (o) done(o.id); };
      listBox.onkeydown = e => {
        if (e.key === "ArrowDown") { e.preventDefault(); at = Math.min(opts.length - 1, at + 1); paint(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); at = Math.max(0, at - 1); paint(); }
        else if (e.key === "Enter") { e.preventDefault(); go(); }
      };
      paint();
      actions.append(btn("Cancel", () => d.close()), btn("Choose", go, "primary"));
      body.append(listBox);
      initialFocus = listBox;
    }
    d.onclose = () => d.remove();
    d.append(heading, body, actions);
    G.AtriumShell.adoptDialog(d, {title: heading, body, actions, initialFocus});
    document.body.append(d);
    d.showModal();
    return d;
  }

  function install(h) {
    host = h;
    const safe = f => () => { try { f(); } catch (e) { h.info?.(e.message); } };
    h.registerAction?.("revisions", safe(() => open({})));
    h.registerAction?.("revision-new", safe(() => newFrom({})));
    h.registerAction?.("revision-release", safe(() => release({})));
    h.registerAction?.("revision-compare", safe(() => compareWith({})));
    h.on?.("change", () => sync(false));
    sync(true);
  }
  if (hasDOM()) G.AtriumNavCommon?.ready?.(install);
  return Object.freeze({open, newFrom, compareWith, release, blocked, sync});
})();
