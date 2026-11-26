"use strict";

// File › Release…: one page for output job sets, pre-flight checks and the release history
//. Three tabs in the order of the work:
//   Outputs     the job set as cards grouped by destination (Fabrication, Assembly, Documentation,
//               Reports), each with a live thumbnail, its file names and its settings; one Package
//               control (folder, zip, vendor bundle), the variant and the revision.
//   Pre-flight  DRC, ERC, BOM completeness, variants, saved/committed: Fix jumps to the problem,
//               Override… records a reason in the release.
//   Releases    past releases (project.releases); pick two to compare.
// AtriumReleaseUI.open(ctx, {tab}) -> the dialog. ctx is the editor's workflow context.
globalThis.AtriumReleaseUI = (() => {
  const J = () => AtriumOutputJobs, R = () => AtriumRelease, P = () => AtriumReleasePreview;
  const clone = v => JSON.parse(JSON.stringify(v));
  const plural = (n, w, ws) => globalThis.AtriumI18n?.plural?.(n, w, ws || w + "s") ?? n + " " + (n === 1 ? w : ws || w + "s");
  const sizeText = n => n == null ? "" : n < 1024 ? n + " B" : n < 1048576 ? (n / 1024).toFixed(1) + " KB" : (n / 1048576).toFixed(2) + " MB";
  // Kept for the session: the draft being edited, the preview cache and design snapshots per release.
  const memory = {draft: null, tab: "outputs", cache: null, snapshots: new Map(), overrides: [], notes: ""};
  // The ODB++ card's progress, problem, fidelity and receipt lines (butter.odb, release-odb.js).
  globalThis.AtriumLazy?.register("AtriumODBCard", {scripts: ["formats/release-odb.js"], css: ["formats/release-odb.css"]});
  const odbCard = run => globalThis.AtriumLazy.need("AtriumODBCard").then(run, () => {});
  function el(tag, text, cls, attrs) { return AtriumNavCommon.elWithAttributes(tag, text, cls, attrs, {omitNull:true}); }
  // A release state is a library badge (docs/ui-library.md › Badges); tone accent by default.
  function badge(text, tone = "accent") { return el("span", text, "ui-badge rel-chip", {"data-tone": tone}); }
  const button = (text, fn, cls, title) => globalThis.AtriumUI.nativeButton(text, fn, cls, title, title ? {ariaLabel: title} : undefined);

  async function gitState(project) {
    const H = globalThis.AtriumHost, editor = globalThis.AtriumNavHost, folder = editor?.folderProject?.();
    const grant = folder?.grant, generation = H?.projectGeneration;
    const current = () => H === globalThis.AtriumHost && grant === H.folderGitGrant && generation === H.projectGeneration &&
      editor.folderProject() === folder && editor.project() === project;
    if (!H?.gitQuery || !grant || folder.temporary || !current())
      return {available:false, reason:"Open a saved Waffle folder in a Git working copy to record its commit."};
    try {
      const s = await H.gitQuery("status", {});
      if (!current()) return {available:false, reason:"The active project changed. Run the release checks again."};
      if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(s?.head || ""))
        return {available:false, reason:"The project folder has no Git commit yet."};
      const dirty = s.dirty || (s.worktreeBlob && s.headBlob !== s.worktreeBlob) || (s.indexBlob && s.indexBlob !== s.headBlob);
      return {available:true, commit:s.head, branch:s.ref || null, dirty:!!dirty, conflicted:!!s.conflicted};
    } catch (e) { return {available:false, reason:current() ? "Git: " + e.message : "The active project changed. Run the release checks again."}; }
  }

  function open(ctx, options = {}) {
    document.querySelectorAll("dialog.rel-dialog").forEach(x => { x.close(); x.atriumTeardown?.(); });
    const live = () => ctx.currentProject?.() || ctx.project;
    memory.cache ||= R().createCache(400);
    const pool = R().workerPool();
    const d = el("dialog", null, "work-dialog ui-dialog rel-dialog", {"aria-label": "Release"});
    let tab = options.tab || memory.tab || "outputs", current = null, run = null, lastRun = null, pre = null, released = null, busy = false, pickA = null, pickB = null, compareOut = null;
    const head = el("header", null, "rel-head"), bar = el("div", null, "rel-bar"), body = el("div", null, "rel-body"), foot = el("div", null, "work-actions ui-dialog-actions rel-actions");
    const status = el("p", null, "rel-status", {role: "status", "aria-live": "polite"});
    const heading = el("h2", "Release");
    d.append(head, bar, body, foot);
    // Teardown runs once, on the close event or before a jump elsewhere (Fix), whichever comes first.
    let torn = false;
    const teardown = () => { if (torn) return; torn = true; stopRun(); pool.close(); P().revokeAll(); memory.tab = tab; if (current) memory.draft = current; d.remove(); };
    d.atriumTeardown = teardown;
    d.addEventListener("close", teardown, {once: true});
    d.addEventListener("cancel", ev => { if (busy) ev.preventDefault(); });

    // ------------------------------------------------------------ job set state
    function pick(set, preset) {
      current = {set: clone(set), preset: !!preset, original: set.name, dirty: false};
      pre = null; released = null; lastRun = null; paint(); refresh();
    }
    function touch(repaint) {
      current.dirty = true; pre = null;
      if (repaint) paint(); else { paintBar(); paintActions(); }
      schedule();
    }
    const uniqueName = base => { let n = base, i = 2; while (J().find(live(), n)) n = base + " " + i++; return n; };
    function saveSet(asNew) {
      try {
        const s = clone(current.set);
        if (current.preset || asNew) { s.from = current.preset ? current.set.name : current.set.from; s.name = uniqueName(current.preset ? current.set.name + " (custom)" : s.name + " copy"); }
        const v = J().normalise(s), write = () => { const p = live(); if (!current.preset && !asNew && current.original && current.original.toLowerCase() !== v.name.toLowerCase()) J().remove(p, current.original); J().save(p, v); };
        if (typeof ctx.edit === "function") ctx.edit(write); else write();
        current = {set: clone(v), preset: false, original: v.name, dirty: false};
        say("Saved " + v.name + " in the project.");
        paint();
      } catch (e) { say(e.message, true); }
    }
    function deleteSet() {
      const name = current.original;
      if (globalThis.confirm && !confirm("Delete the job set " + name + "? Releases made with it stay in the history.")) return;
      const write = () => J().remove(live(), name);
      if (typeof ctx.edit === "function") ctx.edit(write); else write();
      say("Deleted " + name + ".");
      pick(J().presets()[0], true);
    }
    const say = (t, bad) => { status.textContent = t; status.classList.toggle("is-bad", !!bad); };

    // ------------------------------------------------------------ header and tabs
    function paintHead() {
      const keepTabFocus = document.activeElement?.closest(".rel-tabs")?.parentElement === head;
      head.replaceChildren();
      const title = el("div", null, "rel-title");
      title.append(heading, el("p", "Choose what to make, check it, release it. Job sets and releases are saved with the project.", "rel-sub"));
      const tabs = el("div", null, "rel-tabs ui-tabs", {role: "tablist", "aria-label": "Release steps"});
      const nRel = R().list(live()).length, fails = pre ? R().blocking(pre.checks, memory.overrides).length : null;
      for (const [id, label, badge] of [["outputs", "1  Outputs", null], ["preflight", "2  Pre-flight", fails == null ? null : fails ? String(fails) : "✓"], ["releases", "Releases", nRel ? String(nRel) : null]]) {
        const b = button(label, () => { tab = id; paint(); if (id === "preflight" && !pre) check(); }, "rel-tab ui-tab");
        b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(tab === id)); b.id = "rel-tab-" + id;
        b.tabIndex = tab === id ? 0 : -1;
        if (tab === id) b.setAttribute("aria-controls", "rel-pane-" + id);
        if (badge) b.append(el("span", badge, "rel-count" + (badge === "✓" ? " is-ok" : id === "preflight" ? " is-bad" : "")));
        tabs.append(b);
      }
      head.append(title, tabs);
      if (keepTabFocus) tabs.querySelector('[aria-selected="true"]')?.focus({preventScroll: true});
    }

    // ------------------------------------------------------------ the job set bar
    function paintBar() {
      const keepPackageFocus = bar.contains(document.activeElement?.closest(".rel-seg"));
      bar.replaceChildren();
      bar.hidden = tab === "releases";
      if (!current) return;
      const s = current.set, p = live();
      const jobs = el("select", null, "ui-field", {"aria-label": "Job set"});
      const mine = J().list(p), og1 = el("optgroup", null, null, {label: "Presets"}), og2 = el("optgroup", null, null, {label: "This project"});
      J().presets().forEach((x, i) => og1.append(new Option(x.name, "p:" + i)));
      mine.forEach((x, i) => og2.append(new Option(x.name, "j:" + i)));
      jobs.append(og1); if (mine.length) jobs.append(og2);
      const pi = J().presets().findIndex(x => x.name === current.original), ji = mine.findIndex(x => x.name === current.original);
      jobs.value = current.preset ? "p:" + pi : "j:" + ji;
      jobs.onchange = () => {
        if (current.dirty && globalThis.confirm && !confirm("Discard the changes to " + current.set.name + "?")) { jobs.value = current.preset ? "p:" + pi : "j:" + ji; return; }
        const [k, i] = jobs.value.split(":");
        if (k === "p") pick(J().presets()[+i], true); else pick(J().normalise(mine[+i]), false);
      };
      const setBox = el("div", null, "rel-field rel-job");
      setBox.append(el("label", "Job set", null, {for: "rel-job"}), jobs); jobs.id = "rel-job";
      const tag = current.preset ? (current.dirty ? "Preset, edited: Save keeps a copy" : "Preset") : current.dirty ? "Unsaved changes" : s.from ? "From " + s.from : "Saved in project";
      setBox.append(badge(tag, current.dirty ? "warning" : "accent"));
      const tools = el("span", null, "rel-job-tools");
      const save = button(current.preset ? "Save as job set" : "Save", () => saveSet(false), null, current.preset ? "Save a copy of this preset in the project" : "Save the job set");
      save.disabled = busy || (!current.dirty && !current.preset);
      tools.append(save);
      if (!current.preset) {
        tools.append(button("Duplicate", () => saveSet(true), null, "Save a copy under a new name"));
        const del = button("Delete", deleteSet, null, "Delete this job set"); del.disabled = busy; tools.append(del);
        const name = el("input", null, "ui-field", {"aria-label": "Job set name", maxlength: "80", value: s.name});
        name.oninput = () => { s.name = name.value; current.dirty = true; paintActions(); };
        name.onchange = () => paintBar();
        setBox.append(name);
      }
      setBox.append(tools);
      if (s.description && tab === "outputs") setBox.append(el("p", s.description, "rel-desc"));

      // Package: one control for where the files go.
      const pkg = el("div", null, "rel-field rel-package");
      pkg.append(el("span", "Package", "rel-label"));
      const seg = el("div", null, "rel-seg ui-segmented", {role: "radiogroup", "aria-label": "Package"});
      for (const [mode, label, title] of [["folder", "Folder", "Files in one folder (saved as a .zip of the folder in the app)"], ["zip", "Zip", "One .zip with everything"],
        ["vendor", "Vendor bundle", "Laid out flat for a board house's upload form"]]) {
        const b = button(label, () => { s.package = mode === "vendor" ? {mode, vendor: s.package?.vendor || "JLCPCB"} : {mode}; s.zip = mode === "zip"; touch(true); }, "ui-segment", title);
        const selected = (s.package?.mode || "folder") === mode;
        b.setAttribute("role", "radio"); b.setAttribute("aria-checked", String(selected)); b.tabIndex = selected ? 0 : -1;
        seg.append(b);
      }
      pkg.append(seg);
      if (s.package?.mode === "vendor") {
        const v = el("select", null, "ui-field", {"aria-label": "Board house"});
        for (const x of J().VENDORS) v.add(new Option(x, x));
        v.value = s.package.vendor; v.onchange = () => { s.package.vendor = v.value; touch(true); };
        pkg.append(v);
      }
      // Variant and revision.
      const vs = el("select", null, "ui-field", {"aria-label": "Variant", id: "rel-variant"}), variants = globalThis.AtriumVariants?.list(p) || [];
      const active = variants.find(v => v.id === p.activeVariant);
      vs.add(new Option(variants.length ? "Active (" + (active?.name || "base design") + ")" : "Base design (no variants)", "active"));
      if (variants.length) { vs.add(new Option("Base design", "base")); for (const v of variants) vs.add(new Option(v.name, "v:" + v.name)); vs.add(new Option("All variants (" + (variants.length + 1) + " packages)", "all")); }
      vs.value = s.variants === "base" || s.variants === "all" ? s.variants : Array.isArray(s.variants) && s.variants.length === 1 ? "v:" + s.variants[0] : "active";
      vs.disabled = !variants.length;
      vs.onchange = () => { if (vs.value === "active") delete s.variants; else if (vs.value.startsWith("v:")) s.variants = [vs.value.slice(2)]; else s.variants = vs.value; touch(false); };
      const varBox = el("div", null, "rel-field"); varBox.append(el("label", "Variant", null, {for: "rel-variant"}), vs);
      const rev = el("input", null, "ui-field", {id: "rel-rev", "aria-label": "Revision", maxlength: "40", placeholder: R().revisionOf(p, {...s, revision: undefined}), value: s.revision || ""});
      rev.oninput = () => { if (rev.value.trim()) s.revision = rev.value.trim(); else delete s.revision; current.dirty = true; paintName(); paintActions(); };
      rev.onchange = () => schedule();
      const revBox = el("div", null, "rel-field rel-rev"); revBox.append(el("label", "Revision", null, {for: "rel-rev"}), rev);
      const nameBox = el("div", null, "rel-field rel-name"); nameBox.append(el("span", "Release name", "rel-label"), el("output", null, "rel-pkgname", {"aria-live": "polite"}));
      bar.append(setBox, pkg, varBox, revBox, nameBox);
      if (keepPackageFocus) seg.querySelector('[aria-checked="true"]')?.focus({preventScroll: true});
      paintName();
    }
    function packageLabel() {
      const p = live(), s = current.set;
      let t;
      try { t = R().targets(p, s); } catch (e) { return e.message; }
      const named = (globalThis.AtriumVariants?.list(p) || []).length > 0, ext = s.package?.mode === "zip" ? ".zip" : "/";
      const one = v => R().packageName(p, s, {variant: named ? v : ""}) + ext;
      return t.length > 1 ? one("{variant}") + "  ×" + t.length : one(t[0].name);
    }
    function paintName() { const o = bar.querySelector(".rel-pkgname"); if (o) o.textContent = packageLabel(); }

    // ------------------------------------------------------------ outputs tab
    const cards = new Map(); // output id -> {node, thumb, files, summary, state}
    function paintOutputs() {
      cards.clear();
      const s = current.set, wrap = el("div", null, "rel-groups", {role: "tabpanel", "aria-labelledby": "rel-tab-outputs"});
      for (const g of J().GROUPS) {
        const sec = el("section", null, "rel-group", {"aria-label": g.label}), outs = s.outputs.map((o, i) => [o, i]).filter(([o]) => J().groupOf(o.kind) === g.id || (!J().KINDS[o.kind] && g.id === "reports"));
        const h = el("div", null, "rel-group-head");
        h.append(el("h3", g.label), el("span", g.hint, "rel-hint"), el("span", outs.filter(([o]) => o.enabled).length + " of " + outs.length + " on", "rel-hint rel-on"));
        const grid = el("div", null, "rel-cards");
        for (const [o, i] of outs) grid.append(card(o, i));
        grid.append(adder(g));
        sec.append(h, grid);
        wrap.append(sec);
      }
      return wrap;
    }
    function card(out, index) {
      const K = J().KINDS[out.kind], label = out.label || K?.label || out.kind, art = el("article", null, "rel-card" + (out.enabled ? "" : " is-off"), {"data-kind": out.kind, "data-id": out.id, "aria-label": label});
      const top = el("header", null, "rel-card-head");
      const sw = el("input", null, "ui-switch", {type: "checkbox", role: "switch", "aria-label": "Make " + label}), swRow = el("label", null, "ui-switch-row rel-switch");
      sw.checked = !!out.enabled;
      sw.onchange = () => { out.enabled = sw.checked; art.classList.toggle("is-off", !sw.checked); touch(false); };
      const chip = el("span", "", "rel-state");
      swRow.append(sw);
      top.append(swRow, el("strong", label, "rel-card-title"), chip);
      if (K?.needs && !globalThis[K.needs] && !["pdf", "drawing"].includes(out.kind)) top.append(badge("not in this build", "warning"));
      const thumb = el("div", null, "rel-thumb", {"aria-hidden": "false"});
      thumb.append(el("div", out.enabled ? "Preparing preview…" : "Switched off.", "rp-note"));
      const files = el("ul", null, "rel-files", {"aria-label": "Files"}), summary = el("p", null, "rel-summary");
      const opts = el("details", null, "rel-settings"), sum = el("summary", "Settings");
      opts.append(sum, settings(out));
      const tools = el("div", null, "rel-card-tools");
      tools.append(button("Duplicate", () => { const c = clone(out); c.id = globalThis.Atrium.id(); c.label = label + " (2)"; current.set.outputs.splice(index + 1, 0, c); touch(true); }, "rel-mini", "Duplicate " + label),
        button("Remove", () => { current.set.outputs.splice(index, 1); touch(true); }, "rel-mini", "Remove " + label));
      opts.append(tools);
      art.append(top, thumb, files, summary, opts);
      const entry = {node: art, thumb, files, summary, chip};
      cards.set(out.id, entry);
      const cached = lastRun?.byId.get(out.id);
      if (cached && out.enabled) fill(entry, out, cached.row, cached.files);
      else if (out.enabled) plannedFiles(entry, out);
      return art;
    }
    function plannedFiles(entry, out) {
      entry.files.replaceChildren(el("li", (J().KINDS[out.kind]?.folder ? J().KINDS[out.kind].folder + "/" : "") + "…", "rel-muted"));
    }
    function fill(entry, out, row, files) {
      entry.thumb.replaceChildren(P().thumb(out.kind, files, row, {project: live(), out}));
      entry.files.replaceChildren(...(row.files || []).slice(0, 4).map(f => { const li = el("li"); li.append(el("code", typeof f === "string" ? f : f.name)); if (f.bytes != null) li.append(el("small", sizeText(f.bytes))); return li; }));
      if ((row.files || []).length > 4) entry.files.append(el("li", "and " + (row.files.length - 4) + " more", "rel-muted"));
      entry.summary.textContent = [row.summary, row.message].filter(Boolean).join(" — ");
      if (row.warnings?.length) { const w = el("details", null, "rel-warn"); w.append(el("summary", plural(row.warnings.length, "warning"))); const ul = el("ul"); row.warnings.slice(0, 20).forEach(m => ul.append(el("li", m))); w.append(ul); entry.summary.append(w); }
      const st = {ok: ["Ready", "ok"], warning: ["Warnings", "warn"], failed: ["Gate fails", "bad"], error: ["Error", "bad"], skipped: ["Skipped", "muted"]}[row.status] || [row.status, "muted"];
      entry.chip.textContent = st[0] + (row.cached ? " · cached" : "");
      entry.chip.className = "rel-state is-" + st[1];
      entry.node.classList.remove("is-busy");
      if (out.kind === "odb") odbCard(C => C.fill(entry, row, {project: live(), retry: schedule,
        act: action => { if (action === "labs") globalThis.AtriumPrefs?.open?.("labs"); else { d.close(); globalThis.AtriumNavHost?.act(action); } }}));
    }
    function settings(out) {
      const K = J().KINDS[out.kind], box = el("div", null, "rel-form");
      out.options ||= {};
      const field = (label, control, hint) => { const l = el("label", null, "rel-opt"); l.append(el("span", label), control); if (hint) l.append(el("small", hint)); return l; };
      const input = (value, on, attrs) => {
        const i = el("input", null, "ui-field", attrs); i.value = value ?? "";
        i.oninput = () => {
          on(i.value); pre = null;
          if (!current.dirty) { current.dirty = true; paintBar(); }
          paintActions();
        };
        // A click on Save blurs the field. Keep its button attached until the click is delivered.
        i.onchange = schedule;
        return i;
      };
      const check = (value, on, label) => { const i = el("input", null, "ui-checkbox", {type: "checkbox", "aria-label": label}); i.checked = !!value; i.onchange = () => { on(i.checked); touch(false); }; return i; };
      const choose = (values, value, on, label) => { const s = el("select", null, "ui-field", {"aria-label": label}); for (const [v, t] of values) s.add(new Option(t, v)); s.value = value ?? values[0]?.[0] ?? ""; s.onchange = () => { on(s.value); touch(false); }; return s; };
      box.append(field("Label", input(out.label || "", v => { if (v.trim()) out.label = v; else delete out.label; }, {"aria-label": "Output label", placeholder: K?.label || out.kind})),
        field("Sub-folder", input(out.folder ?? "", v => { out.folder = v; }, {"aria-label": "Sub-folder", placeholder: K?.folder || "(top level)"}), "Empty: " + (K?.folder || "top level")));
      let tileScaleRow;
      for (const [key, label, type, values, hint, attributes] of K?.fields || []) {
        const v = out.options[key], set = x => { if (x === "" || x === undefined) delete out.options[key]; else out.options[key] = x; };
        if (out.kind === "pdf" && key.startsWith("infinite") && !live().documents.some(d => d.sheet?.infinite === true)) continue;
        let c;
        if (type === "ratio") c = input(v ?? "", x => { if (x === "" || +x === 1) set(undefined); else if (+x > 0) set(+x); },
          {type: "number", min: "0.000001", step: "any", "aria-label": label, placeholder: String(values)});
        else if (type === "bool") c = check(v ?? values, x => set(x), label);
        else if (type === "select") c = choose(values, key === "infiniteLayout" && !values.some(([k]) => k === v) ? "" : v ?? values[0][0], x => {
          set(x); if (key === "infiniteLayout" && tileScaleRow) tileScaleRow.hidden = x !== "tile";
        }, label);
        else if (type === "number") c = input(v ?? "", x => set(x === "" ? undefined : Number(x)), {type: "number", step: "0.01", "aria-label": label, placeholder: String(values), ...attributes});
        else if (type === "count") c = input(v == null ? "" : String(v), x => { if (x === "") out.options[key] = null; else if (Number.isInteger(+x) && +x >= 0) out.options[key] = +x; }, {type: "number", min: "0", step: "1", "aria-label": label});
        else if (type === "view") { const views = globalThis.AtriumBOM?.views(live()) || []; c = choose([["", "Default columns"], ...views.map(w => [w.name, w.name])], v || "", x => set(x || undefined), label); }
        else c = input(v ?? "", x => set(x || undefined), {"aria-label": label, placeholder: String(values || "")});
        const row = field(label, c, hint);
        if (key === "infiniteScale") { tileScaleRow = row; row.hidden = out.options.infiniteLayout !== "tile"; }
        box.append(row);
      }
      return box;
    }
    function adder(g) {
      const box = el("div", null, "rel-card rel-add");
      const kinds = g.kinds.filter(k => (k !== "odb" || globalThis.AtriumPrefs?.get("butter.odb") === true)
        && (k !== "readme" || !current.set.outputs.some(o => o.kind === "readme")));
      const s = el("select", null, "ui-field", {"aria-label": "Add to " + g.label});
      for (const k of kinds) s.add(new Option(J().KINDS[k].label, k));
      box.append(el("span", "Add to " + g.label, "rel-hint"), s, button("Add output", () => {
        current.set.outputs.push({id: globalThis.Atrium.id(), kind: s.value, enabled: true, options: J().defaultsOf(s.value)}); touch(true);
      }));
      return box;
    }

    // ------------------------------------------------------------ live previews
    let timer = 0;
    // Outputs wait for the exact copper fill (output-jobs.js settle; Repour All shows its progress on the board).
    const poursText = e => "Filling copper pours before making outputs" + (e.total ? ": " + e.done + " of " + e.total : "") + "…";
    function schedule() { clearTimeout(timer); timer = setTimeout(refresh, 350); }
    // A run in flight is cancelled; the worker it used is ended so the next run does not queue behind it.
    function stopRun() {
      if (!run) return;
      run.abort(); run = null; pool.cancel();
      for (const c of cards.values()) if (c.node.classList.contains("is-busy") || (!c.chip.textContent && !c.node.classList.contains("is-off"))) {
        c.node.classList.remove("is-busy"); c.chip.textContent = "Cancelled"; c.chip.className = "rel-state is-muted";
        if (c.node.dataset.kind === "odb") odbCard(C => C.clear(c));
      }
    }
    async function refresh() {
      if (!current || !d.isConnected) return;
      stopRun();
      const ac = new AbortController(), me = {abort: () => ac.abort()};
      run = me; paintActions();
      const set = clone(current.set);
      await needModules(set);
      if (run !== me) return;
      for (const [id, c] of cards) { const o = set.outputs.find(x => x.id === id); if (o?.enabled) { c.node.classList.add("is-busy"); c.chip.textContent = "Queued"; c.chip.className = "rel-state is-muted"; } }
      const byId = new Map();
      say("Making previews…");
      try {
        const variant = Array.isArray(set.variants) && set.variants.length ? set.variants[0] : set.variants === "base" || set.variants === "all" ? null : undefined;
        const res = await R().generate(live(), set, {cache: memory.cache, worker: pool, signal: ac.signal, provenance:globalThis.AtriumImportReports?.provenance(), variant, progress: e => {
          if (run !== me) return;
          if (e.phase === "pours") { say(poursText(e)); return; }
          const c = cards.get(e.id), out = set.outputs.find(x => x.id === e.id);
          if (e.phase === "start" && c) { c.chip.textContent = "Making…"; if (out?.kind === "odb") odbCard(C => { if (run === me) C.busy(c); }); }
          if (e.phase === "done") { byId.set(e.id, {row: e.row, files: e.files}); if (c && out?.enabled) fill(c, out, e.row, e.files); }
        }});
        if (run !== me) return;
        for (const r of res.report.outputs) { const x = byId.get(r.id); if (x) x.row = r; const c = cards.get(r.id), out = set.outputs.find(o => o.id === r.id); if (c && out?.enabled && x) fill(c, out, r, x.files); }
        lastRun = {byId, report: res.report, stats: res.stats};
        const s = res.stats, made = s.page + s.worker;
        say("Previews ready: " + plural(res.report.outputs.filter(o => o.status !== "skipped").length, "output") + (s.cached ? ", " + s.cached + " unchanged" : "") + (made ? ", " + made + " made" + (s.worker ? " (" + s.worker + " in the background)" : "") : "") + ".");
      } catch (e) { if (run === me) say(e.message, true); }
      finally { if (run === me) run = null; paintActions(); }
    }
    // PDF and drawing outputs draw with print.js / drawing.js, which load on demand.
    async function needModules(set) {
      const L = globalThis.AtriumLazy;
      if (!L) return;
      const want = [];
      if (!globalThis.AtriumPrint && set.outputs.some(x => x.kind === "pdf" && x.enabled)) want.push("AtriumPrint");
      if (!globalThis.AtriumDrawing && set.outputs.some(x => x.kind === "drawing" && x.enabled)) want.push("AtriumDrawing");
      for (const m of want) { try { await L.need(m); } catch { /* reported as skipped */ } }
    }

    // ------------------------------------------------------------ pre-flight tab
    async function check() {
      if (!current) return;
      pre = null;
      const project = live();
      say("Running pre-flight checks…");
      busy = true; paintActions();
      await new Promise(r => setTimeout(r, 0));
      try {
        const git = await gitState(project), unsaved = !!(globalThis.AtriumNavHost?.isDirty?.());
        const checked = await R().preflightAsync(project, current.set, {git, unsaved});
        if (project !== live()) throw Error("The active project changed. Run the release checks again.");
        pre = {...checked, git, unsaved};
        const b = R().blocking(pre.checks, memory.overrides);
        say(b.length ? plural(b.length, "check") + " to fix or override before release." : "Pre-flight passed. Ready to release.");
      } catch (e) { say(e.message, true); }
      finally { busy = false; paint(); }
    }
    const ICON = {pass: "✓", warn: "!", fail: "✕", skip: "–"};
    function paintPreflight() {
      const wrap = el("div", null, "rel-pre", {role: "tabpanel", "aria-labelledby": "rel-tab-preflight"});
      if (!pre) { wrap.append(el("p", "Checks have not run yet.", "rel-empty"), button("Run checks", check, "is-primary")); return wrap; }
      const ul = el("ul", null, "rel-checks");
      for (const c of pre.checks) {
        const ov = memory.overrides.find(o => o.check === c.id), li = el("li", null, "rel-check is-" + (ov && c.status === "fail" ? "override" : c.status));
        const row = el("div", null, "rel-check-row");
        row.append(el("span", ov && c.status === "fail" ? "↷" : ICON[c.status], "rel-icon", {"aria-hidden": "true"}));
        const t = el("div", null, "rel-check-text");
        t.append(el("strong", c.label), el("span", c.summary, "rel-check-sum"));
        if (ov && c.status === "fail") t.append(el("span", "Overridden: " + ov.reason, "rel-override-note"));
        row.append(t);
        const acts = el("div", null, "rel-check-acts");
        if (c.fix && c.status !== "pass" && c.status !== "skip") acts.append(button(c.fix.label || "Fix", () => fix(c, null), null, c.fix.label + " for " + c.label));
        if (c.status === "fail") acts.append(ov ? button("Undo override", () => { memory.overrides = memory.overrides.filter(o => o.check !== c.id); paint(); }) : button("Override…", () => overrideBox(li, c)));
        row.append(acts);
        li.append(row);
        if (c.items.length) {
          const det = el("details", null, "rel-items"); det.open = c.status === "fail" && c.items.length <= 6;
          det.append(el("summary", plural(c.items.length + c.more, "item")));
          const list = el("ul");
          for (const it of c.items.slice(0, 30)) {
            const x = el("li", null, "is-" + (it.level || (c.status === "fail" ? "fail" : "warn")));
            x.append(el("span", it.text));
            if (it.target?.id || it.target?.doc) x.append(button("Show", () => fix(c, it), "rel-mini", "Show " + it.text));
            list.append(x);
          }
          if (c.items.length + c.more > 30) list.append(el("li", "and " + (c.items.length + c.more - 30) + " more", "rel-muted"));
          det.append(list); li.append(det);
        }
        ul.append(li);
      }
      const notes = el("textarea", null, "rel-notes ui-field", {rows: "3", "aria-label": "Release notes", placeholder: "What changed in this release (goes into RELEASE.md and release.json)"});
      notes.value = memory.notes; notes.oninput = () => { memory.notes = notes.value; };
      const nl = el("label", null, "rel-notes-field"); nl.append(el("span", "Release notes"), notes);
      wrap.append(ul, nl);
      if (released) wrap.append(resultPanel());
      return wrap;
    }
    function overrideBox(li, c) {
      if (li.querySelector(".rel-override")) return;
      const box = el("div", null, "rel-override"), why = el("input", null, "ui-field", {"aria-label": "Reason for overriding " + c.label, placeholder: "Reason (recorded in the release)", maxlength: "500"});
      const ok = button("Override", () => { if (!why.value.trim()) { why.focus(); return; } memory.overrides = [...memory.overrides.filter(o => o.check !== c.id), {check: c.id, reason: why.value.trim()}]; paint(); }, "is-primary");
      why.onkeydown = e => { if (e.key === "Enter") ok.click(); };
      box.append(why, ok, button("Cancel", () => box.remove()));
      li.append(box); why.focus();
    }
    // Fix: close the page and go to the problem (the draft stays for next time).
    function fix(c, item) {
      const t = item?.target;
      // Save keeps the page open and checks again once the project is saved (it used to close Release).
      if (c.fix?.action === "save" && !t?.id) {
        globalThis.dispatchEvent?.(new CustomEvent("atrium-command", {detail: "save"}));
        let n = 0;
        const wait = () => { if (!d.open) return; if (!globalThis.AtriumNavHost?.isDirty?.() || ++n > 60) { check(); return; } setTimeout(wait, 300); };
        setTimeout(wait, 300);
        return;
      }
      d.close(); teardown();
      if (t?.id && typeof ctx.select === "function") { try { ctx.select(t.id); return; } catch { /* fall through to the action */ } }
      const act = c.fix?.action;
      if (!act) return;
      // The same "atrium-command" event the command palette uses, so the menu action runs as if chosen.
      const id = {history: "history-panel"}[act] || act;
      if (["save", "history-panel", "variants", "bom", "compile", "drc"].includes(id)) globalThis.dispatchEvent?.(new CustomEvent("atrium-command", {detail: id}));
    }

    // ------------------------------------------------------------ release
    async function doRelease() {
      if (busy || !current) return;
      if (!pre) { await check(); }
      if (!pre) return;
      const b = R().blocking(pre.checks, memory.overrides);
      if (b.length) { tab = "preflight"; paint(); say(plural(b.length, "check") + " to fix or override first: " + b.map(c => c.label).join(", ") + ".", true); return; }
      stopRun(); busy = true; paintActions();
      const ac = new AbortController(); run = {abort: () => ac.abort()};
      const set = clone(current.set);
      await needModules(set);
      try {
        const res = await R().release(live(), set, {preflight: pre, overrides: memory.overrides, notes: memory.notes, git: pre.git, unsaved: pre.unsaved, cache: memory.cache, worker: pool, signal: ac.signal, provenance:globalThis.AtriumImportReports?.provenance(),
          progress: e => { if (e.phase === "pours") say(poursText(e)); if (e.phase === "start") say("Releasing: " + (e.variant ? e.variant + ", " : "") + (e.index + 1) + " of " + e.total + ": " + e.label + "…"); }});
        const snap = clone(live());
        delete snap.releases;
        memory.snapshots.set(res.record.id, snap);
        const write = () => R().add(live(), res.record);
        if (typeof ctx.edit === "function") ctx.edit(write); else write();
        released = res;
        say("Released " + res.name + (res.ok ? "." : " with failed outputs (see the cards).") + " Save the package below.", !res.ok);
        tab = "preflight";
      } catch (e) { say(e.message, true); }
      finally { busy = false; run = null; paint(); }
    }
    function resultPanel() {
      const box = el("section", null, "rel-result", {"aria-label": "Released packages"});
      box.append(el("h3", "Released: " + released.name));
      for (const pkg of released.packages) {
        const files = released.files.filter(f => f.name === pkg.name + ".zip" || f.name.startsWith(pkg.name + "/"));
        const row = el("div", null, "rel-result-row");
        row.append(el("strong", pkg.name), el("span", plural(pkg.manifest.files.length + 1, "file") + (pkg.ok ? "" : " · some outputs failed"), "rel-hint"));
        row.append(button(files.length === 1 ? "Save " + files[0].name : "Save package (.zip)", () => savePackage(pkg, files), "is-primary"));
        box.append(row);
        if (files.length > 1) {
          const det = el("details", null, "rel-items"), ul = el("ul");
          det.append(el("summary", "Save single files (for upload forms)"));
          for (const f of files) { const li = el("li"); li.append(el("code", f.name.slice(pkg.name.length + 1)), button("Save", () => saveOne(f), "rel-mini", "Save " + f.name)); ul.append(li); }
          det.append(ul); box.append(det);
        }
      }
      return box;
    }
    async function savePackage(pkg, files) {
      try {
        const data = files.length === 1 ? files[0].data : AtriumZip.create(files.map(f => ({name: f.name, data: f.data})), {date: new Date(pkg.manifest.date)});
        const name = files.length === 1 ? files[0].name : pkg.name + ".zip";
        if (await ctx.exportFile(name, data, {manufacturing:true})) ctx.info?.("Saved " + name);
      } catch (e) { say(e.message, true); }
    }
    async function saveOne(f) { try { const name = f.name.split("/").pop(); if (await ctx.exportFile(name, f.data, {manufacturing:true})) ctx.info?.("Saved " + name); } catch (e) { say(e.message, true); } }

    // ------------------------------------------------------------ releases tab
    function paintReleases() {
      const wrap = el("div", null, "rel-history", {role: "tabpanel", "aria-labelledby": "rel-tab-releases"}), recs = R().list(live()).slice().reverse();
      if (!recs.length) { wrap.append(el("p", "No releases yet. Releases you make are listed here with their files, checks and overrides, and you can compare any two.", "rel-empty")); return wrap; }
      const t = el("table", null, "rel-table"), th = el("thead"), tb = el("tbody"), hr = el("tr");
      for (const h of ["A", "B", "Release", "Date", "Rev", "Job set", "Checks", "Files"]) hr.append(el("th", h, null, {scope: "col"}));
      th.append(hr);
      for (const r of recs) {
        const tr = el("tr", null, r.id === pickA || r.id === pickB ? "is-picked" : "");
        const radio = (which) => { const i = el("input", null, null, {type: "radio", name: "rel-" + which, "aria-label": "Compare " + (which === "a" ? "from" : "to") + " " + r.name}); i.checked = (which === "a" ? pickA : pickB) === r.id; i.onchange = () => { if (which === "a") pickA = r.id; else pickB = r.id; compareOut = null; paint(); }; const td = el("td"); td.append(i); return td; };
        const overrides = (r.overrides || []).length, fails = (r.gates || []).filter(g => g.status === "fail").length;
        const gates = el("td"); gates.append(badge(fails ? (overrides ? plural(overrides, "override") : plural(fails, "failure")) : "All passed", fails ? overrides ? "warning" : "danger" : "success"));
        if (overrides) gates.title = r.overrides.map(o => o.check + ": " + o.reason).join("\n");
        tr.append(radio("a"), radio("b"), el("td", r.name + (r.packages.length > 1 ? " (" + r.packages.length + " variants)" : "")), el("td", r.date.slice(0, 16).replace("T", " ")), el("td", r.revision), el("td", r.job), gates,
          el("td", String(r.packages.reduce((n, p) => n + p.files.length, 0))));
        tb.append(tr);
      }
      t.append(th, tb);
      const acts = el("div", null, "rel-history-acts");
      const cmp = button("Compare A → B", compareNow, "is-primary"); cmp.disabled = !pickA || !pickB || pickA === pickB;
      const del = button("Remove record", () => {
        const id = pickB || pickA; if (!id) return;
        if (globalThis.confirm && !confirm("Remove this release from the history? Its files are not touched.")) return;
        const write = () => R().remove(live(), id);
        if (typeof ctx.edit === "function") ctx.edit(write); else write();
        if (pickA === id) pickA = null; if (pickB === id) pickB = null; compareOut = null; paint();
      }, null, "Remove the B release (or A) from the history");
      del.disabled = !pickA && !pickB;
      acts.append(el("span", "Pick A and B, then compare.", "rel-hint"), del, cmp);
      wrap.append(t, acts);
      if (compareOut) wrap.append(compareView(compareOut));
      return wrap;
    }
    async function designOf(rec) {
      if (memory.snapshots.has(rec.id)) return memory.snapshots.get(rec.id);
      const p = live();
      if (rec.designHash && rec.designHash === R().designHash(p)) return p;
      if (rec.git?.commit && !rec.git.dirty && typeof ctx.gitRevision === "function") {
        try { const item = await ctx.gitRevision(rec.git.commit); if (item && typeof item.text === "string") return JSON.parse(item.text); } catch { /* no design diff */ }
      }
      return null;
    }
    async function compareNow() {
      const recs = R().list(live()), a = recs.find(r => r.id === pickA), b = recs.find(r => r.id === pickB);
      if (!a || !b) return;
      say("Comparing…");
      try {
        const [before, after] = await Promise.all([designOf(a), designOf(b)]);
        if (before && after && !globalThis.AtriumDiff && globalThis.AtriumLazy) { try { await AtriumLazy.need("AtriumDiff"); } catch { /* file-level only */ } }
        compareOut = R().compare(a, b, {before, after});
        say("Compared " + a.name + " with " + b.name + ".");
      } catch (e) { say(e.message, true); }
      paint();
    }
    function compareView(c) {
      const box = el("section", null, "rel-compare", {"aria-label": "Comparison"});
      box.append(el("h3", c.a.name + " → " + c.b.name));
      for (const n of c.notes) box.append(el("p", n, "rel-hint"));
      const stats = el("div", null, "rel-compare-stats");
      for (const [n, label, tone] of [[c.files.added.length, "files added", "ok"], [c.files.removed.length, "removed", "bad"], [c.files.changed.length, "changed", "warn"], [c.files.datesOnly.length, "only dates differ", "muted"], [c.files.same.length, "identical", "muted"]])
      { const s = el("div", null, "rp-stat is-" + tone); s.append(el("strong", String(n)), el("span", label)); stats.append(s); }
      box.append(stats);
      const list = (title, rows, fmt) => { if (!rows.length) return; const det = el("details", null, "rel-items"); det.open = rows.length <= 12; det.append(el("summary", title + " (" + rows.length + ")")); const ul = el("ul"); rows.slice(0, 200).forEach(r => ul.append(el("li", fmt(r)))); det.append(ul); box.append(det); };
      list("Changed files", c.files.changed, f => f.path + "  " + sizeText(f.before) + " → " + sizeText(f.after));
      list("Added files", c.files.added, f => f.path);
      list("Removed files", c.files.removed, f => f.path);
      if (c.bom.available) {
        box.append(el("h4", "Bill of materials"));
        if (!c.bom.added.length && !c.bom.removed.length && !c.bom.changed.length) box.append(el("p", "No BOM changes.", "rel-hint"));
        list("Parts changed", c.bom.changed, r => r.ref + ": " + r.fields.map(f => f + " " + (r.before[f] || "—") + " → " + (r.after[f] || "—")).join(", "));
        list("Parts added", c.bom.added, r => r.ref + " " + r.comment + (r.mpn ? " (" + r.mpn + ")" : ""));
        list("Parts removed", c.bom.removed, r => r.ref + " " + r.comment + (r.mpn ? " (" + r.mpn + ")" : ""));
      }
      if (c.design) {
        box.append(el("h4", "Design"));
        const s = c.design.summary || {};
        box.append(el("p", typeof s === "string" ? s : Object.entries(s.bySeverity || s.severity || {}).map(([k, v]) => v + " " + k).join(", ") || plural(c.design.changes.length, "change"), "rel-hint"));
        list("Design changes", c.design.changes, x => "[" + x.severity + "] " + x.text);
      }
      return box;
    }

    // ------------------------------------------------------------ paint
    function paintActions() {
      foot.replaceChildren();
      foot.append(status);
      const close = button("Close", () => { if (busy) return; d.close(); });
      foot.append(close);
      if (run) foot.append(button("Cancel", () => { stopRun(); say("Cancelled. Outputs made so far stay cached."); paintActions(); }, null, "Stop making outputs"));
      if (tab !== "releases") {
        const again = button("Refresh previews", () => { memory.cache.clear(); refresh(); }, null, "Make every preview again"); again.disabled = busy;
        const chk = button("Run checks", check); chk.disabled = busy;
        let n = 1;
        try { n = R().targets(live(), current?.set || {}).length; } catch { n = 1; }
        const rel = button(busy ? "Working…" : n > 1 ? "Release " + n + " packages" : "Release", doRelease, "is-primary", "Run pre-flight, then make the versioned release package");
        rel.dataset.uiDefault = "false";
        rel.disabled = busy || !current || !current.set.outputs.some(o => o.enabled);
        foot.append(again, chk, rel);
      }
      globalThis.AtriumShell.adoptDialog(d, {title: heading, body, actions: foot});
    }
    function paint() {
      paintHead(); paintBar();
      const pane = tab === "outputs" ? paintOutputs() : tab === "preflight" ? paintPreflight() : paintReleases();
      pane.id = "rel-pane-" + tab;
      body.replaceChildren(pane);
      paintActions();
    }
    // Start: the remembered draft, else the first saved job set, else the first preset.
    const mine = J().list(live());
    if (options.job) { try { const s = J().resolve(live(), options.job); current = {set: clone(s), preset: !!s.preset, original: s.name, dirty: false}; } catch { /* below */ } }
    if (!current && memory.draft && (memory.draft.preset || J().find(live(), memory.draft.original))) current = memory.draft;
    if (!current) { if (mine.length) current = {set: J().normalise(mine[0]), preset: false, original: mine[0].name, dirty: false}; else { const p = J().presets()[0]; current = {set: clone(p), preset: true, original: p.name, dirty: false}; } }
    paint();
    document.body.append(d);
    d.showModal();
    if (tab === "preflight") check(); else refresh();
    return d;
  }
  return Object.freeze({open});
})();
