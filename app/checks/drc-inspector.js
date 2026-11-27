"use strict";
// Violation inspector: the pinned, non-blocking details of one DRC violation, shown at the top
// of the Properties pane (lazy; loaded on the first marker click or F8).
//
// Opened by clicking a marker on the board (drc-markers.js), by Tools › Next / Previous
// Violation (F8 / Shift+F8, which also fly the camera to it), or kept in step with the row
// chosen in Messages while it is open. It shows:
//   - severity (Error / Warning / Waived), the rule kind and the rule's name;
//   - the actual and the required value;
//   - the objects involved, each a button that selects it and frames it;
//   - Fix (the suggested fixes of drc-fixes.js, previewed on the board as each is hovered or
//     focused), Waive… (drc-waivers.js) or Remove Waiver, Show in Messages and Rules….
// Escape (in the Select tool) or a click on the board away from a marker closes it. Nothing is
// modal: the board, the menus and the rest of Properties keep working while it is open.
// After an edit the violation is looked up again; when online DRC no longer reports it the
// inspector says so and offers the next one.
//
// One inspector for both editors (docs/design/unified-rules-and-checks.md §2.7): on a sheet it shows a
// schematic problem from the check store (checks.js; live or compiled ERC), with the same sections:
// severity, check, message, objects (each selects and frames), Waive… (waivers.js), Show in
// Messages and Options…. F8 / Shift+F8 step through a sheet's problems as through a board's.
globalThis.AtriumDRCInspector = (() => {
  const C = () => globalThis.AtriumNavCommon, V = () => globalThis.AtriumDRCView, M = () => globalThis.AtriumDRCMarkers,
    F = () => globalThis.AtriumDRCFixes, R = () => globalThis.AtriumRules;
  const SEVERITY = {error: "Error", warning: "Warning", waived: "Waived"};
  let host = null, state = null;   // state: {v, el, hidRight, fixes, resolved}
  const el = (t, x, c) => C().el(t, x, c);
  const btn = (text, fn, cls, label) => { const b = C().button(text, fn, cls);
    if (b.classList.contains("drc-insp-action")) {
      globalThis.AtriumUI?.button(b, b.classList.contains("is-primary") ? "primary" : "secondary");
    }
    if (label) b.setAttribute("aria-label", label); return b; };
  // Library parts for the head: the close button, the step arrows and the severity badge.
  const closeBtn = label => { const b = btn("×", () => closeInspector({reason: "button"}), "ui-close drc-insp-close", label); b.title = label; return b; };
  const stepBtn = (dir, label) => { const b = btn(null, () => step(dir), "ui-icon-button drc-insp-nav", label); b.dataset.size = "sm"; b.append(C().icon(dir < 0 ? "left" : "right")); return b; };
  const TONE = {error: "danger", warning: "warning", ok: "success"};
  const badge = (text, sev) => { const b = el("span", text, "ui-badge drc-insp-sev"); b.dataset.sev = sev; if (TONE[sev]) b.dataset.tone = TONE[sev]; return b; };

  // ------------------------------------------------------------------ pure helpers
  // Violations to step through on the current board, in Messages order.
  const K = () => globalThis.AtriumChecks;
  // A problem in the check store's shape (a schematic one); a DRC violation has its own object.
  const unified = v => !!v && typeof v.key === "string" && typeof v.check === "string" && Array.isArray(v.objects);
  function navigable(docId) { return K()?.navigable ? K().navigable(docId, host) : (V()?.violations?.(docId) || []).filter(v => v.type !== "unrouted" && (v.at || v.otherAt)); }
  const key = v => !v ? "" : unified(v) ? v.key : v.type + "|" + (v.ruleName || "") + "|" + [v.id, v.otherId].filter(Boolean).sort().join("|");
  // The same violation after online DRC re-checked: identity, else rule + objects (nearest point).
  function relocate(v, list) {
    if (!v) return null;
    if (list.includes(v)) return v;
    const k = key(v), at = v.at || v.otherAt;
    let best = null, bd = Infinity;
    for (const x of list) if (key(x) === k) {
      const p = x.at || x.otherAt, d = at && p ? Math.hypot(p[0] - at[0], p[1] - at[1]) : 0;
      if (d < bd) { bd = d; best = x; }
    }
    return best;
  }
  // {actual, required} text for the values block.
  function values(v, unit = "mm") {
    const f = x => { try { return R().units.format(x, unit); } catch { return (+x).toFixed(3) + " mm"; } };
    if (v.delay) return {actual: v.delay.actual.toFixed(2) + " ps", required: (v.delay.limit === "max" ? "≤ " : "≥ ") + v.delay.required.toFixed(2) + " ps"};
    return {actual: v.actual != null ? f(v.actual) : "", required: v.required != null ? (v.limit === "max" ? "≤ " : "≥ ") + f(v.required) : ""};
  }
  // [{id, text}] for the objects a violation names (titles are "A ↔ B").
  function objects(v) {
    const names = String(v.title || "").split(/\s+↔\s+/).filter(Boolean), ids = [v.id, v.otherId].filter((x, i, a) => x && a.indexOf(x) === i);
    if (!ids.length) return names.map(text => ({id: null, text}));
    return ids.map((id, i) => ({id, text: names[i] || names[0] || id}));
  }

  // ------------------------------------------------------------------ DOM
  function pane() { return typeof document !== "undefined" ? document.getElementById("properties") : null; }
  function mount() {
    const p = pane(); if (!p) return null;
    if (!state.el?.isConnected) {
      state.el = el("section", null, "drc-insp");
      state.el.setAttribute("role", "region"); state.el.setAttribute("aria-label", "Violation");
      const head = p.querySelector(".pane-heading");
      if (head) head.after(state.el); else p.prepend(state.el);
    }
    if (document.body.classList.contains("hide-right")) { host.act?.("toggle-right"); state.hidRight = true; }
    return state.el;
  }
  function hint(action) { try { return globalThis.AtriumKeymap?.hintFor?.(action, "pcb") || ""; } catch { return ""; } }
  const TIER = {fatal: "Fatal", error: "Error", warning: "Warning", hint: "Hint"};
  // A schematic problem: the same sections as a DRC violation.
  function renderProblem(root, v, list) {
    const d = host.doc(), at = list.findIndex(x => x.key === v.key), C = K();
    const head = el("header", null, "drc-insp-head"), title = el("h3", null, "drc-insp-title");
    const close = closeBtn("Close problem details (Escape)");
    const prev = stepBtn(-1, "Previous problem" + (hint("drc-prev") ? " (" + hint("drc-prev") + ")" : ""));
    const next = stepBtn(1, "Next problem" + (hint("drc-next") ? " (" + hint("drc-next") + ")" : ""));
    prev.disabled = next.disabled = !list.length;
    const count = el("span", list.length ? (at >= 0 ? at + 1 + " of " + list.length : list.length + " left") : "none left", "drc-insp-count");
    if (state.resolved) {
      title.append(badge("Resolved", "ok"), el("span", "Problem cleared"));
      head.append(title, count, prev, next, close);
      root.replaceChildren(head, el("p", "The schematic check no longer reports this problem after the last edit." + (list.length ? " Next shows the next one." : " No problems are left on this sheet."), "drc-insp-note"));
      return;
    }
    const sev = v.severity === "fatal" ? "error" : v.severity === "hint" ? "waived" : v.severity, chip = badge(TIER[v.severity] || v.severity, sev);
    root.dataset.sev = sev;
    title.append(chip, el("span", C?.title?.(v.check) || v.check));
    head.append(title, count, prev, next, close);
    const body = [head, el("p", v.text, "drc-insp-detail")];
    if (v.severity === "hint" && v.hint) body.push(el("p", "Found while editing; Compile reports it as " + (v.hint === "error" ? "an " : "a ") + v.hint + ".", "drc-insp-rule"));
    const objs = v.objects.filter(o => (o.doc ?? d.id) === d.id);
    if (objs.length) {
      const ul = el("ul", null, "drc-insp-objects");
      for (const o of objs) {
        const item = d.items.find(i => i.id === o.id), li = el("li"), text = item ? (item.ref || item.text || item.name || item.kind) : o.id;
        if (item) { const b = btn(text, () => selectObject(o.id), "drc-insp-object"); b.title = "Select and show " + text; li.append(b); } else li.append(el("span", text));
        ul.append(li);
      }
      body.push(el("h4", "Objects", "drc-insp-sub"), ul);
    }
    const where = v.at.find(a => (a.doc ?? d.id) === d.id)?.point;
    if (where) body.push(el("p", "At " + where[0].toFixed(2) + ", " + where[1].toFixed(2), "drc-insp-where"));
    const acts = el("div", null, "drc-insp-actions");
    if (objs.length) acts.append(btn("Waive…", () => waiveProblem(v), "drc-insp-action is-primary"));
    acts.append(btn("Show in Messages", () => showInMessages(v), "drc-insp-action"));
    if (v.source === "erc") acts.append(btn("Options…", () => host.act("erc"), "drc-insp-action"));
    body.push(acts, el("small", "Escape or a click on the sheet closes this" + (hint("drc-next") ? " · " + hint("drc-next") + " next, " + hint("drc-prev") + " previous" : ""), "drc-insp-foot"));
    root.replaceChildren(...body);
  }
  // Waive… a schematic problem: a note, then one undoable edit (project.waivers).
  async function waiveProblem(v) {
    const L = globalThis.AtriumLazy;
    if (!globalThis.AtriumWaivers && L?.modules?.().includes("AtriumWaivers")) { try { await L.need("AtriumWaivers"); } catch (e) { host.info?.(e.message); return; } }
    const W = globalThis.AtriumWaivers, S = /** @type {any} */ (globalThis.AtriumShell);
    if (!W) { host.info?.("Waivers are unavailable in this build."); return; }
    const commit = note => {
      try { host.edit(() => W.waive(host.project(), v, {note})); } catch (e) { host.info?.(e.message); return false; }
      host.invalidate?.(); after();
      host.info?.("Waived: " + (K()?.title?.(v.check) || v.check) + ". Saved with the project; it is listed for review if its objects change.");
      return true;
    };
    if (!S?.dialog || typeof document === "undefined") { commit(""); return; }
    const label = el("label", "Note (optional)", "drc-waive-label"), note = document.createElement("textarea");
    note.className = "drc-waive-note"; note.rows = 3; note.maxLength = 500; note.placeholder = "Why this is acceptable, e.g. a test point left open on purpose";
    label.append(note);
    S.dialog({title: "Waive Problem", className: "drc-waive-dialog", body: [el("p", (K()?.title?.(v.check) || v.check) + " · " + v.text), label],
      actions: [{label: "Cancel"}, {label: "Waive", primary: true, run: () => commit(note.value.trim())}]});
  }
  function render() {
    if (!state) return;
    const root = mount(); if (!root) return;
    if (unified(state.v)) { renderProblem(root, state.v, navigable(host.doc().id)); return; }
    const v = state.v, unit = host.units?.() || "mm", d = host.doc(), list = navigable(d.id), at = list.indexOf(v);
    const head = el("header", null, "drc-insp-head"), title = el("h3", null, "drc-insp-title");
    const close = closeBtn("Close violation details (Escape)");
    const prev = stepBtn(-1, "Previous violation" + (hint("drc-prev") ? " (" + hint("drc-prev") + ")" : ""));
    const next = stepBtn(1, "Next violation" + (hint("drc-next") ? " (" + hint("drc-next") + ")" : ""));
    prev.disabled = next.disabled = !list.length;
    const count = el("span", v?.waived ? list.length + " active" : list.length ? (at >= 0 ? at + 1 + " of " + list.length : list.length + " left") : "none left", "drc-insp-count");
    if (state.resolved) {
      title.append(badge("Resolved", "ok"), el("span", "Violation cleared"));
      head.append(title, count, prev, next, close);
      root.replaceChildren(head, el("p", "Online DRC no longer reports this violation after the last edit." + (list.length ? " Next shows the next one." : " No violations are left on this board."), "drc-insp-note"));
      return;
    }
    const sev = M()?.severity?.(v) || "error", T = R()?.types?.[v.type], kind = T?.title || v.typeTitle || v.type;
    const chip = badge(SEVERITY[sev], sev);
    title.append(chip, el("span", kind));
    head.append(title, count, prev, next, close);
    const body = [head];
    root.dataset.sev = sev;
    if (v.ruleName && v.ruleName !== kind) body.push(el("p", "Rule: " + v.ruleName, "drc-insp-rule"));
    if (v.ruleSet) body.push(el("p", "Rule set: " + v.ruleSet, "drc-insp-rule"));
    const val = values(v, unit);
    if (val.actual || val.required) {
      const dl = el("dl", null, "drc-insp-values");
      if (val.actual) dl.append(el("dt", v.what ? v.what : "Actual"), el("dd", val.actual, "drc-insp-actual"));
      if (val.required) dl.append(el("dt", "Required"), el("dd", val.required));
      body.push(dl);
    }
    if (v.detail && !(val.actual && val.required)) body.push(el("p", v.detail, "drc-insp-detail"));
    const objs = objects(v);
    if (objs.length) {
      const ul = el("ul", null, "drc-insp-objects");
      for (const o of objs) {
        const li = el("li");
        if (o.id && d.items.some(i => i.id === o.id)) {
          const b = btn(o.text, () => selectObject(o.id), "drc-insp-object");
          b.title = "Select and show " + o.text;
          li.append(b);
        } else li.append(el("span", o.text));
        ul.append(li);
      }
      body.push(el("h4", "Objects", "drc-insp-sub"), ul);
    }
    const where = v.at || v.otherAt;
    if (where) { const f = x => { try { return R().units.format(x, unit); } catch { return x.toFixed(3); } }; body.push(el("p", "At " + f(where[0]) + ", " + f(where[1]), "drc-insp-where")); }
    if (v.waived) body.push(el("p", "Waived" + (v.waived.note ? ": " + v.waived.note : "") + (v.waived.created ? " · " + String(v.waived.created).slice(0, 10) : ""), "drc-insp-note"));
    // Actions: Fix and Waive… first, one click away.
    const acts = el("div", null, "drc-insp-actions"), fixable = !v.waived && !!F()?.hasFix?.(v);
    if (fixable) {
      const fix = btn(state.fixes ? "Hide Fixes" : "Fix…", () => toggleFixes(), "drc-insp-action is-primary");
      fix.title = "Suggested fix: " + (F().fixLabel?.(v) || "") + ". Previewed on the board before it is applied.";
      fix.setAttribute("aria-expanded", String(!!state.fixes));
      acts.append(fix);
    }
    if (v.waived) acts.append(btn("Remove Waiver", () => unwaive(v), "drc-insp-action"));
    else if (v.id || v.otherId) acts.append(btn("Waive…", () => waive(v), "drc-insp-action"));
    acts.append(btn("Show in Messages", () => showInMessages(v), "drc-insp-action"), btn("Rules…", () => host.act("rules"), "drc-insp-action"));
    body.push(acts);
    if (state.fixes) body.push(state.fixes);
    else if (!fixable && !v.waived) body.push(el("p", "No automatic fix for this rule. Move or resize the objects, or waive it if it is acceptable.", "drc-insp-note"));
    body.push(el("small", "Escape or a click on the board closes this" + (hint("drc-next") ? " · " + hint("drc-next") + " next, " + hint("drc-prev") + " previous" : ""), "drc-insp-foot"));
    root.replaceChildren(...body);
  }
  function toggleFixes() {
    if (state.fixes) { state.fixes = null; F()?.clearPreview?.(); render(); return; }
    let p = null;
    try { p = F()?.panel?.(host, state.v); } catch (e) { host.info?.(e.message); }
    if (!p) { host.info?.("No automatic fix applies to this violation."); return; }
    state.fixes = p; render();
    state.el?.querySelector(".drc-fix-button")?.focus({preventScroll: true});
  }
  function selectObject(id) {
    const d = host.doc(), item = d.items.find(i => i.id === id);
    if (!item) return;
    host.select?.([id], id);
    const b = C().itemBox?.(d, host.defs(), item);
    if (b) host.zoomTo?.(C().grow(b, Math.max(1, .3 * Math.max(b[2] - b[0], b[3] - b[1]))));
  }
  async function waive(v) {
    const L = globalThis.AtriumLazy;
    if (!globalThis.AtriumDRCWaivers && L?.modules?.().includes("AtriumDRCWaivers")) { try { await L.need("AtriumDRCWaivers"); } catch (e) { host.info?.(e.message); return; } }
    globalThis.AtriumDRCWaivers?.waiveDialog?.(host, v, () => { V()?.refresh?.(); after(); });
  }
  function unwaive(v) {
    const W = globalThis.AtriumDRCWaivers, d = host.doc();
    if (!W || !v.waived?.id) return;
    host.edit(() => W.remove(d, v.waived.id));
    V()?.refresh?.();
    host.info?.("Waiver removed: the violation is checked again.");
    after();
  }
  function showInMessages(v) {
    const ctx = host.messageContext?.(), L = globalThis.AtriumLazy;
    const go = () => {
      const Ms = globalThis.AtriumMessages;
      if (Ms?.revealProblem?.(v, ctx)) return;
      if (unified(v)) Ms?.open?.(ctx, {view: "problems"}); else host.act(Ms ? "drc" : "messages");
    };
    if (globalThis.AtriumMessages || !L?.need) go(); else L.need("AtriumMessages").then(go, e => host.info?.(e.message));
  }

  // ------------------------------------------------------------------ state
  function open(h, v, {fly = false} = {}) {
    host ||= h;
    if (!v || (host.doc()?.kind !== "pcb" && !unified(v))) return false;
    if (state?.v !== v) { F()?.clearPreview?.(); if (state) state.fixes = null; }
    state = {...(state || {}), v, resolved: false, fixes: state?.v === v ? state.fixes : null};
    if (unified(v)) { globalThis.AtriumSchMarkers?.focus?.(v); if (fly) { const p = v.at[0]?.point; if (p) host.zoomTo?.([p[0] - 8, p[1] - 8, p[0] + 8, p[1] + 8]); } }
    else { V()?.focus?.(v); if (fly) M()?.fly?.(host, v); }
    render();
    listen(true);
    return true;
  }
  function closeInspector({reason = ""} = {}) {
    if (!state) return false;
    F()?.clearPreview?.();
    state.el?.remove();
    if (state.hidRight && !document.body.classList.contains("hide-right")) host.act?.("toggle-right");
    state = null;
    V()?.focus?.(null); globalThis.AtriumSchMarkers?.focus?.(null);
    listen(false);
    if (reason === "escape") host.info?.("Violation details closed.");
    return true;
  }
  // Messages row chosen while the inspector is open: show that violation.
  function follow(h, v) { if (state && v && v !== state.v && !v.waived) open(h, v); }
  // After a fix, waiver or edit: find the violation again (online DRC replaced its object).
  let timer = 0;
  function after() {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!state) return;
      const d = host.doc();
      if (unified(state.v)) {
        const found = navigable(d.id).find(x => x.key === state.v.key);
        if (found) { state.v = found; state.resolved = false; } else state.resolved = true;
        globalThis.AtriumSchMarkers?.focus?.(found || null);
        render(); return;
      }
      if (d.kind !== "pcb") { closeInspector(); return; }
      const pool = state.v?.waived ? V()?.waived?.(d.id) || [] : V()?.violations?.(d.id) || [];
      const found = relocate(state.v, pool);
      F()?.clearPreview?.(); state.fixes = null;
      if (found) { state.v = found; state.resolved = false; V()?.focus?.(found); }
      else { state.resolved = true; V()?.focus?.(null); }
      render();
    }, 260);
  }
  function step(dir) {
    const h = host || globalThis.AtriumNavHost; host ||= h;
    const d = h?.doc?.();
    if (d?.kind === "schematic") {
      const list = navigable(d.id);
      if (!list.length) { h.info?.(K() ? "No problems on this sheet." : "Compile the project (C C) to check this sheet."); if (state) { state.resolved = true; render(); } return null; }
      const cur = state && !state.resolved ? state.v : globalThis.AtriumSchMarkers?.focused?.();
      let i = cur ? list.findIndex(x => x.key === cur.key) : -1;
      i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
      open(h, list[i], {fly: true});
      h.info?.("Problem " + (i + 1) + " of " + list.length + ": " + list[i].text);
      return list[i];
    }
    if (d?.kind !== "pcb") { h?.info?.("Open a schematic sheet or a PCB layout to step through its problems."); return null; }
    const list = navigable(d.id);
    if (!list.length) { h.info?.(V()?.enabled?.() === false ? "No violations listed. Run the design rule check (T D)." : "No rule violations on this board."); if (state) { state.resolved = !state.v?.waived; render(); } return null; }
    const cur = state && !state.resolved ? state.v : V()?.focused?.();
    let i = cur ? list.indexOf(relocate(cur, list)) : -1;
    i = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
    open(h, list[i], {fly: true});
    h.info?.("Violation " + (i + 1) + " of " + list.length + ": " + (M()?.statusText?.(list[i], h.units?.() || "mm", {hint: false}) || list[i].type));
    return list[i];
  }

  // ------------------------------------------------------------------ events
  let listening = false;
  function onKey(e) {
    if (!state || e.key !== "Escape" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector("dialog[open], .drc-fix-pop, .nav-menu")) return;
    const t = e.target, inMe = state.el?.contains(t);
    if (!inMe && t?.closest?.("input,textarea,select,[contenteditable=true]")) return;
    // In another tool Escape belongs to that tool (cancel the route, the placement …).
    if (!inMe && host.tool?.() !== "select") return;
    e.preventDefault(); e.stopPropagation();
    closeInspector({reason: "escape"});
    if (inMe) host.canvas?.()?.focus?.();
  }
  function listen(on) {
    if (typeof document === "undefined" || on === listening) return;
    listening = on;
    if (on) document.addEventListener("keydown", onKey, true); else document.removeEventListener("keydown", onKey, true);
  }
  function attach(h) {
    host = h;
    host.registerAction("drc-next", () => step(1));
    host.registerAction("drc-prev", () => step(-1));
    host.on?.("change", () => { if (state) after(); });
    host.on?.("document", () => { if (state) closeInspector(); });
  }
  globalThis.AtriumNavCommon?.ready?.(attach);

  return Object.freeze({open, close: closeInspector, follow, step, next: () => step(1), prev: () => step(-1), relocate, values, objects, navigable,
    current: () => state?.v || null, isOpen: () => !!state, attach});
})();
