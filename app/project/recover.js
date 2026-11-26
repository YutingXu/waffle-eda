"use strict";
// AtriumAutosave (autosave.js, eager): autosave and crash recovery (v2).
//
// Snapshots of the open project go to IndexedDB ("waffle-editor-drafts"), one slot per project, with
// metadata kept apart from the JSON so listing never reads a large board. A save is debounced
// (DEBOUNCE after the last change, at most MAX_WAIT after the first) and runs in an idle
// callback: one JSON.stringify and one IndexedDB put. stats() reports its main-thread cost.
// Without IndexedDB, small projects (≤ LS_MAX characters) fall back to one localStorage key.
//
// Retention per project: the newest KEEP snapshots plus one per 10 minutes for 2 hours, one per
// 2 hours for 2 days and one per day for 2 weeks (retain()). During continuous editing the
// newest snapshot is rewritten in place for HEAD_MS, so the history grows about once a minute.
//
// Sessions: a tiny index in localStorage ("waffle-editor-drafts-v1") records each running editor
// (heartbeat, clean exit) and the last project. At startup, after an unclean exit or with
// unsaved changes, a prompt offers Restore / Open as copy / Discard with timestamps and sizes.
// Nothing is restored silently; a project that was saved and closed cleanly is reopened with a
// status message. File › Recover… browses every snapshot. Storage errors (quota) show a warning.
//
//   AtriumAutosave.schedule()  after a change        AtriumAutosave.flush()  save now
//   AtriumAutosave.recent()    recent projects       AtriumAutosave.openRecent(slot)
//   AtriumAutosave.openBrowser() / openRecovery()    AtriumAutosave.stats()
//   AtriumAutosave.read(id) -> {meta, text}           one snapshot (stable: the layout may change)
//   AtriumAutosave.create({indexedDB, localStorage, now, schedule}) -> an instance (tests)
//
// Incremental snapshots encode the current in-memory editor model. Folder projects use owner
// drafts scoped to a verified saved folder instead.
// Recovery dialogs for AtriumAutosave (autosave.js), loaded on first use through AtriumLazy:
//   AtriumRecover.prompt(autosave, host, plan)  startup prompt: Restore / Open as copy / Discard
//   AtriumRecover.browser(autosave, host)       File › Recover…: every snapshot, by project
//   AtriumRecover.warning(autosave, host, text) a persistent storage warning; hideWarning()
// `autosave` is an AtriumAutosave instance, `host` the editor's AtriumNavHost.
globalThis.AtriumRecover = (() => {
  const el = (tag, text, cls) => AtriumNavCommon.el(tag, text, cls);
  const button = (text, fn, cls) => { const b = el("button", text, cls); b.type = "button"; b.onclick = fn; return b; };
  function dialog(label, cls) {
    const d = el("dialog", null, "work-dialog recover-dialog " + cls);
    d.setAttribute("aria-label", label);
    d.addEventListener("close", () => d.remove(), {once: true});
    return d;
  }
  // Run a restore; close the dialog unless it was declined (the replace prompt said no).
  const act = (host, fn, d) => () => Promise.resolve().then(fn).then(ok => { if (ok !== false) d.close(); }, e => {
    let error = d.querySelector(".recover-error");
    if (!error) {
      error = el("p", "", "recover-error"); error.setAttribute("role", "alert");
      d.querySelector(".work-actions").before(error);
    }
    error.textContent = e.message;
    host?.info?.(e.message);
  });

  function prompt(A, host, plan) {
    const d = dialog("Recover unsaved work", "recover-prompt"), first = plan.snapshots[0];
    const title = el("h2", first ? "Recover unsaved work?" : "Project recovery");
    d.append(title);
    if (plan.unreadable) {
      d.append(el("p", "The recovery file could not be read. " + (first ? "Choose a stored snapshot of this project." : "There are no stored snapshots for this project.") +
        " The recovery file is still on disk."));
    } else if (!first) {
      d.append(el("p", "No recovery snapshot was found for this file. You can reopen the saved project."));
    } else {
      d.append(el("p", (plan.unclean ? "Waffle didn't close cleanly last time. " : "Your last session ended with unsaved changes. ") +
        "“" + first.name + "” was autosaved " + A.fmtTimeNow(first.ts) + ". Choose a snapshot:"));
    }
    const path = plan.path || first?.path;
    if (path) d.append(el("p", path, "recover-meta"));
    const list = el("div", null, "recover-list"); list.setAttribute("role", "radiogroup"); list.setAttribute("aria-label", "Snapshots");
    let chosen = first?.id;
    plan.snapshots.forEach((m, i) => {
      const row = el("label", null, "recover-row ui-choice ui-choice-tinted"), r = el("input");
      r.type = "radio"; r.name = "recover-snap"; r.value = m.id; r.checked = i === 0; r.onchange = () => { chosen = m.id; };
      row.append(r, el("span", m.name, "recover-name"), el("span", A.describe(m), "recover-meta ui-choice-meta"));
      list.append(row);
    });
    const foot = el("div", null, "work-actions");
    foot.append(button("Browse all snapshots…", () => { d.close(); browser(A, host); }, "recover-link"));
    if (!first || plan.unreadable) foot.append(button("Close", () => { if (plan.unreadable) A.dismiss(plan.unreadable); d.close(); }, first ? undefined : "is-primary"));
    else {
      const discard = button("Discard", () => { A.dismiss(first.id); d.close(); host?.info?.("Recovery discarded. The snapshots stay in File › Recover… until they age out."); });
      discard.dataset.variant = "danger"; foot.append(discard);
    }
    if (first) {
      d.append(list);
      foot.append(button("Open as copy", act(host, () => A.restore(chosen, {copy: true}), d)),
        button("Restore", act(host, () => A.restore(chosen), d), "is-primary"));
    }
    const body = Array.from(d.children).slice(1);
    d.append(foot);
    AtriumShell.adoptDialog(d, {title, body, actions:foot, initialFocus:foot.querySelector(".is-primary")});
    document.body.append(d); d.showModal();
    return d;
  }

  async function browser(A, host) {
    const d = dialog("Recover", "recover-browser");
    const title = el("h2", "Recover"), detail = el("p", "Autosaved snapshots kept in this " + (globalThis.AtriumHost ? "app" : "browser") +
      ": the newest five of each project, then one per 10 minutes for 2 hours, one per 2 hours for 2 days and one per day for 2 weeks.");
    d.append(title, detail);
    const body = el("div", null, "recover-groups"), usage = el("small", "", "recover-usage"), foot = el("div", null, "work-actions");
    const clear = button("Delete all snapshots", async () => {
      if (typeof confirm === "function" && !confirm("Delete every recovery snapshot?")) return;
      await A.remove((await A.list()).map(m => m.id)); await A.refreshRecent(); render();
    }), close = button("Close", () => d.close());
    clear.dataset.variant = "danger"; close.dataset.variant = "primary";
    foot.append(clear, close);
    d.append(body, usage, foot);
    AtriumShell.adoptDialog(d, {title, body:[detail, body, usage], actions:foot, initialFocus:close});
    async function render() {
      body.replaceChildren();
      const all = (await A.list()).sort((a, b) => b.ts - a.ts), groups = new Map();
      for (const m of all) { if (!groups.has(m.slot)) groups.set(m.slot, []); groups.get(m.slot).push(m); }
      const foreign=await A.foreignHeads?.() || [];
      if (foreign.length) globalThis.AtriumForeignDraftUI.append(foreign,body,d,host,render);
      if (!groups.size && !foreign.length) body.append(el("p", "No snapshots yet. Waffle autosaves a moment after each change.", "recover-empty"));
      for (const [s, list] of groups) {
        const g = el("section", null, "recover-group");
        g.append(el("h3", list[0].name + (s === A.slot() ? " (open)" : "") + (list[0].path ? " — " + list[0].path : "")));
        for (const m of list) {
          const row = el("div", null, "recover-row");
          row.append(el("span", A.describe(m), "recover-meta"), button("Restore", act(host, () => A.restore(m.id), d)),
            button("Open as copy", act(host, () => A.restore(m.id, {copy: true}), d)),
            button("Delete", async () => { await A.remove([m.id]); await A.refreshRecent(); render(); }));
          g.append(row);
        }
        body.append(g);
      }
      let est = null;
      try { est = await navigator.storage?.estimate?.(); } catch { /* unsupported */ }
      const st = A.stats(), gb = n => n >= 1073741824 ? (n / 1073741824).toFixed(1) + " GB" : A.fmtSize(n);
      usage.textContent = all.length + " snapshot" + (all.length === 1 ? "" : "s") + " · " + A.fmtSize(all.reduce((n, m) => n + m.size, 0)) + " of project data" +
        (est?.quota ? " · storage " + gb(est.usage || 0) + " used of " + gb(est.quota) : "") + " · " + A.backend() +
        (st.saves ? " · last autosave " + st.mainThreadMs.toFixed(1) + " ms" : "") + (st.error ? " · " + st.error : "");
    }
    document.body.append(d); d.showModal();
    await render();
    return d;
  }

  const FAILURE_FIELDS = ["javascriptErrors", "unhandledRejections", "scriptLoadFailures", "autosaveFailures",
    "workerFailures", "workerTimeouts"];
  const TERMINATION_FIELDS = ["exited", "unresponsive", "browserExited", "memoryLimit", "terminated"];
  const GPU_WORK_FIELDS = ["frames", "gridBufferAllocations", "driverFenceSubmissions", "driverMemoryChecks"];
  const MIB = 1048576;
  const read = fn => { try { return fn(); } catch { return undefined; } };
  const field = (obj, key) => read(() => Object.getOwnPropertyDescriptor(obj, key)?.value);
  const oneOf = (value, choices) => choices.includes(value) ? value : "unknown";
  const flag = value => typeof value === "boolean" ? value : null;
  const band = (value, bounds, labels, unknown = "unknown") => {
    if (!Number.isFinite(value) || value < 0 || value > 2 ** 40) return unknown;
    const index = bounds.findIndex(bound => value < bound);
    return labels[index < 0 ? bounds.length : index];
  };
  const count = value => Number.isSafeInteger(value) && value <= 32
    ? band(value, [1, 2, 5], ["none", "one", "two-to-four", "five-or-more"]) : "unknown";
  const counts = (source, fields) => Object.fromEntries(fields.map(key => [key, count(field(source, key))]));
  const editorFailures = () => counts(read(() => globalThis.AtriumDiagnostics?.failures?.()), FAILURE_FIELDS);
  const reportText = value => JSON.stringify(value, null, 2) + "\n";
  function gpuWork(source) {
    const available = source != null && typeof source === "object" && !Array.isArray(source);
    return {scope: available ? "active-pcb-gpu-view" : "not-applicable", ...Object.fromEntries(GPU_WORK_FIELDS.map(key => {
      const value = field(source, key);
      return [key, !available ? "not-applicable" : globalThis.AtriumDiagnostics?.countBucket?.(value) ?? "unknown"];
    }))};
  }
  function applicationVersion() {
    const value = read(() => /** @type {HTMLMetaElement | null} */ (
      document.querySelector('meta[name="application-version"]')
    )?.content);
    return typeof value === "string" && /^(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})\.(?:0|[1-9]\d{0,2})$/.test(value)
      ? value.split(".").map(Number) : null;
  }
  async function nativeState() {
    const pending = read(() => globalThis.AtriumHost?.supportDiagnostics?.());
    if (!pending) return null;
    let timeout;
    try {
      return await Promise.race([pending, new Promise(resolve => { timeout = setTimeout(() => resolve(null), 1500); })]);
    } catch { return null; }
    finally { clearTimeout(timeout); }
  }
  // The report is a one-time projection. Its keys are fixed, and no producer object, free text,
  // exception, or identifier is retained or passed to the serializer.
  async function report() {
    const G = globalThis;
    if (!G.AtriumPerformanceDiagnostics) {
      try { await G.AtriumLazy?.need("AtriumPerformanceDiagnostics", {measure: false}); }
      catch { /* startup failure counts are still available */ }
    }
    const viewport = read(() => G.AtriumNavHost?.viewportDiagnostics?.()), gpu = field(viewport, "gpu");
    const preference = read(() => G.AtriumCanvasGPUPref?.diagnosticState?.());
    const visible = flag(read(() => G.AtriumPower?.visible?.()));
    const efficiencyActive = flag(read(() => G.AtriumPower?.efficient?.()));
    const activity = read(() => G.AtriumDiagnostics?.performanceSnapshot?.({shareable: true}));
    const frame = field(activity, "frame");
    const timing = key => field(frame, key) ?? "not-measured";
    const failures = editorFailures();
    const version = applicationVersion();
    const pixelRatio = read(() => G.devicePixelRatio);
    const kind = oneOf(field(viewport, "kind"), ["home", "pcb", "schematic", "drawing", "panel", "3d"]);
    const presentation = oneOf(field(viewport, "presentation"), ["foreground", "covered", "hidden", "not-applicable"]);
    const width = field(viewport, "width"), height = field(viewport, "height");
    const area = Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0 ? width * height : null;
    const native = await nativeState();
    const platform = oneOf(field(native, "platform"), ["macos", "windows", "linux"]);
    const renderState = kind !== "pcb" ? "not-applicable" : presentation === "covered" ? "covered" :
      presentation === "hidden" ? "paused" : oneOf(field(gpu, "state"),
        ["gpu", "2d", "paused", "context-lost", "memory-limit", "disabled", "error"]);
    return reportText({
      format: "waffle-diagnostics",
      schemaVersion: 1,
      applicationVersion: version,
      host: {kind: G.AtriumHost ? "desktop" : "browser", platform,
        architecture: oneOf(field(native, "architecture"), ["arm64", "x64"]),
        availableDisplays: oneOf(field(native, "displayCount"), ["one", "two", "three-or-more"])},
      viewport: {
        kind, presentation, windowVisible: visible, efficiencyActive,
        cssArea: band(area, [500000, 1200000, 2500000], ["small", "medium", "large", "very-large"]),
        pixelRatio: band(Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : null,
          [1.25, 1.75, 2.5], ["near-1", "near-1.5", "near-2", "above-2"])
      },
      boardRenderer: {
        preference: oneOf(field(preference, "preference"), ["auto", "gpu", "2d"]),
        webgl2: oneOf(field(preference, "capability"), ["disabled", "available", "unavailable", "software"]),
        renderState, retainedContexts: count(field(gpu, "contexts")), contextLosses: count(field(gpu, "losses")),
        warmupPending: flag(field(gpu, "warmupPending")), activeParkedScenes: count(field(gpu, "parkedScenes")),
        activeEstimatedGpuBytes: band(field(gpu, "activeBytes"), [1, 32 * MIB, 128 * MIB, 512 * MIB],
          ["none", "under-32MiB", "32-to-128MiB", "128-to-512MiB", "512MiB-or-more"]),
        activeViewWork: gpuWork(kind === "pcb" ? field(gpu, "work") : null)
      },
      performance: {
        canvasMainThreadP95: timing("drawCpuP95"),
        controlWheelToDrawP95: timing("wheelToDrawP95"),
        editCommitMainThreadP95: timing("commitCpuP95"),
        editFollowUpMainThreadP95: timing("followUpCpuP95"),
        animationCallbackIntervalP95: timing("callbackIntervalP95"),
        displayPresentedFps: "not-measured",
        systemCpuUtilization: "not-measured",
        activity: activity ?? {version: 1, recording: false, rows: []}
      },
      recordedEditorFailures: failures,
      rendererTerminations: counts(field(native, "rendererTerminations"), TERMINATION_FIELDS)
    });
  }
  async function diagnostics(A, host) {
    const d = dialog("Crash Diagnostics", "diagnostics-dialog");
    const log = el("textarea", null, "diagnostics-log ui-field"), foot = el("div", null, "work-actions");
    log.readOnly = true;
    log.setAttribute("aria-label", "Diagnostics report");
    let preview;
    const copy = button("Copy report", async () => {
      if (!preview) return;
      try { await navigator.clipboard.writeText(preview); }
      catch {
        log.value = preview;
        log.focus();
        log.select();
        if (!read(() => document.execCommand?.("copy"))) {
          host?.info?.("Could not copy the diagnostics report");
          return;
        }
      }
      host?.info?.("Diagnostics report copied");
    });
    const save = button("Save report…", async () => {
      if (!preview) return;
      try { await globalThis.AtriumIO.exportFile("waffle-diagnostics.json", preview, {diagnostics: true}); }
      catch { host?.info?.("Could not save the diagnostics report"); }
    });
    const clear = button("Clear error counts", () => {
      if (!preview) return;
      globalThis.AtriumDiagnostics?.clearFailures?.();
      const report = JSON.parse(preview);
      report.recordedEditorFailures = editorFailures();
      preview = log.value = reportText(report);
    });
    clear.dataset.variant = "quiet";
    copy.disabled = save.disabled = clear.disabled = true;
    const close = button("Close", () => d.close());
    close.dataset.variant = "primary";
    foot.append(button("Recover unsaved work…", () => { d.close(); A.openBrowser(); }, "recover-link"), clear, copy, save, close);
    const title = el("h2", "Crash Diagnostics"), detail = el("p",
      "Preview the report you can copy or save for a bug report. Editor error counts cover today and the previous six UTC days. Frame Monitor samples animation callbacks and elapsed operation times. System CPU utilization is not measured.");
    d.append(title, detail, log, foot);
    AtriumShell.adoptDialog(d, {title, body:[detail, log], actions:foot, initialFocus:close});
    document.body.append(d); d.showModal();
    const text = await report();
    if (!d.open) return d;
    preview = log.value = text;
    copy.disabled = save.disabled = false;
    clear.disabled = !globalThis.AtriumDiagnostics?.clearFailures;
    return d;
  }

  let bar = null;
  function warning(A, host, text) {
    if (!bar?.isConnected) {
      // A floating library notice over the canvas (ui/components.css): dot, text, actions.
      bar = el("div", null, "ui-notice recover-warning"); bar.setAttribute("role", "alert");
      bar.dataset.floating = ""; bar.dataset.tone = "warning";
      const dot = el("span", null, "ui-dot"), actions = el("div", null, "ui-notice-actions");
      dot.setAttribute("aria-hidden", "true"); dot.dataset.tone = "warning";
      actions.append(button("Save project", () => host?.act?.("save"), "ui-button"),
        button("Recover…", () => browser(A, host), "ui-button"), button("Dismiss", hideWarning, "ui-button"));
      bar.append(dot, el("span", "", "ui-notice-text recover-warning-text"), actions);
      document.body.append(bar);
    }
    bar.querySelector(".recover-warning-text").textContent = text;
    return bar;
  }
  function hideWarning() { bar?.remove(); bar = null; }
  return Object.freeze({prompt, browser, diagnostics, warning, hideWarning, report});
})();
