"use strict";
// Shared surface for the Butter intelligence features: Ask AI, Query, Macros and Links.
// One entry model (the "/" palette and the Command list), one dock-panel shell, one
// cross-probe for every result, citation and link target, and one proposal review that
// shows before and after values and applies the reviewed operations as one Undo step.
// Lazy: butter-editor.js loads it only when one of the four flags is on. Each feature's
// own view loads when its surface opens.
globalThis.AtriumIntelUI = (() => {
  const G = globalThis, D = G.document, L = G.AtriumLazy;
  const FEATURES = {ai:"AtriumAskUI", query:"AtriumQueryUI", macros:"AtriumMacrosUI", links:"AtriumLinksUI"};
  const SCRIPTS = {ai:"automation/ai-ui.js", query:"checks/query-ui.js", macros:"automation/macros-ui.js", links:"project/links-ui.js"};
  for (const [feature, name] of Object.entries(FEATURES)) L.register(name, {scripts:[SCRIPTS[feature]], deps:["AtriumIntelUI"]});
  const enabled = feature => G.AtriumButter?.state(feature).enabled === true;
  const host = () => G.AtriumNavHost;
  let K = G.AtriumUIKit;
  const kit = async () => K ??= G.AtriumUIKit ?? await L.need("AtriumUIKit");
  const view = feature => L.need(FEATURES[feature]);

  // ------------------------------------------------------------------ dock panels
  // A Dock panel body with the dock's own heading: title, heading actions, close. Below it one
  // notice slot (one state at a time, most severe first), the scrolling body and a footer.
  const panels = new Map();
  function dockPanel({id, title}) {
    const known = panels.get(id);
    if (known) return known;
    const el = K.el("section", "panel intel-panel panel-" + id);
    el.hidden = true;
    const head = K.el("header", "pane-heading"), h2 = K.el("h2", null, title), actions = K.el("div", "intel-head-actions");
    h2.id = "intel-" + id + "-heading";
    el.setAttribute("aria-labelledby", h2.id);
    const notice = K.el("div", "intel-notice"), strip = K.el("div", "intel-strip"), body = K.el("div", "intel-body pane-scroll"),
      foot = K.el("div", "intel-foot");
    notice.hidden = strip.hidden = foot.hidden = true;
    const panel = {id, el, head, notice, strip, body, foot,
      // Heading actions appear only when a view uses them, so a tabbed dock can drop the heading.
      get actions() { if (!actions.isConnected) h2.after(actions); return actions; },
      // Opening a panel that sits behind another tab brings it to the front.
      show() { if (el.hidden) el.hidden = false; else G.AtriumDock?.reveal?.(id); return panel; },
      hide() { el.hidden = true; host()?.canvas?.()?.focus?.({preventScroll:true}); },
      get open() { return !el.hidden && el.isConnected; },
      setNotice(node) { notice.replaceChildren(...(node ? [node] : [])); notice.hidden = !node; },
      dispose() { el.remove(); panels.delete(id); }};
    head.append(h2, K.closeButton(() => panel.hide(), "Close " + title));
    el.append(head, strip, notice, body, foot);
    el.addEventListener("keydown", event => {
      if (event.key === "Escape" && !event.defaultPrevented && !event.target.closest?.("input,textarea,select")) {
        event.preventDefault(); panel.hide();
      }
    });
    // Each feature registers its own literal Dock spec, so the field inventory can see it.
    (D.getElementById("properties") ?? D.body).append(el);
    panels.set(id, panel);
    return panel;
  }

  // ------------------------------------------------------------------ cross-probe
  // One behaviour for a query row, an AI citation, a link target and a palette jump:
  // open the document, activate the occurrence, select the object, frame it and light its net.
  // Focus stays where the user is working, so a list can be walked with the arrow keys
  // while the canvas follows. current() is the caller's project and revision guard.
  // status(hit, doc) owns the success text. order and focus keep each caller's sequence.
  function qualifiedKey(target) {
    if (!target.type || target.kind || target.documentId) return target;
    return {kind:target.type, id:target.id, ownerId:target.ownerId, pin:target.pad, padIndex:target.padIndex,
      padId:target.padId, instanceId:target.instanceId, net:target.type === "net" ? target.net : undefined};
  }
  async function probe(target, {focus = false, activateOccurrence = true, current, status, order} = {}) {
    const h = host();
    if (!h || !target) return {status:"unavailable"};
    if (target.url) {
      const links = G.AtriumLinksDesktop ?? await L.need("AtriumLinksDesktop");
      const address = G.AtriumLinks.parse(target.url);
      const result = address ? await links.follow(address) : {status:"invalid-link"};
      if (result.status !== "found") h.info(openMessage(result.status));
      return result;
    }
    const project = h.project(), doc = project.documents.find(d => d.id === (target.documentId ?? target.docId));
    if (!doc) {
      if (!status) h.info("The document for this result is no longer in the project.");
      return {status:"missing-document"};
    }
    const stale = () => current && !current();
    if (stale()) return {status:"stale"};
    if (h.currentId() !== doc.id) await h.selectDocument(doc.id);
    const ready = G.AtriumCrossProbe ?? await L.need("AtriumCrossProbe");
    const key = qualifiedKey(target);
    const occurrence = target.instanceId ?? key.instanceId;
    const preview = activateOccurrence && occurrence && (G.AtriumConnectionPreview ?? await L.need("AtriumConnectionPreview"));
    if (stale()) return {status:"stale"};
    if (h.project() !== project || h.currentId() !== doc.id) return {status:"missing-document"};
    if (preview) preview.activateInstance(doc.id, occurrence);
    const hit = ready.resolveLocal(h.doc(), h.defs(), key);
    if (!hit) {
      if (!status) h.info("This object is no longer in " + doc.name + ".");
      return {status:"missing-object"};
    }
    for (const step of order ?? ["select", "highlight", "zoom"]) {
      if (step === "highlight" && hit.net) h.setHighlight(hit.net);
      else if (step === "select" && hit.ids.length) h.select(hit.ids);
      else if (step === "zoom" && hit.box) h.zoomTo(hit.box);
      else if (step === "focus" && focus) G.AtriumShell?.focusEditor?.();
    }
    if (focus && !order) G.AtriumShell?.focusEditor?.();
    if (status) status(hit, doc);
    return {status:"found", label:hit.label};
  }
  function openMessage(status) {
    return {
      disabled:"Turn on Project Links in Experimental features to open Waffle links.",
      "invalid-link":"This is not a Waffle link.",
      "missing-project":"The project for this link could not be found.",
      "project-mismatch":"The chosen project does not match this link.",
      "ambiguous-project":"More than one recent project has this identity. Open the intended project first.",
      "missing-object":"The object for this link is missing.",
      "missing-fragment":"This datasheet page is unavailable.",
      "missing-document":"The document for this link is unavailable.",
      partial:"Part of the project is still loading. Try again in a moment.",
      ambiguous:"More than one object has this identity.",
      cancelled:"Opening the link was cancelled.",
      busy:"Another Waffle link is opening."
    }[status] ?? "The Waffle link was not opened.";
  }

  // A result row named the way the canvas names it: designator, then net, then kind.
  const title = text => text ? text[0].toUpperCase() + text.slice(1).replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : "";
  function describe(row) {
    const project = host().project(), doc = project.documents.find(d => d.id === row.documentId);
    if (row.kind === "net") {
      const label = row.fields?.name ?? row.fields?.["net.name"] ?? row.id?.slice(4) ?? "Net";
      return {label,kind:"Net",document:doc?.name ?? "Missing document",missing:!doc};
    }
    const item = doc?.items?.find(i => i.id === (row.ownerId ?? row.id)), kind = title(item?.kind === "part" ? "component" : item?.kind ?? row.kind);
    const name = item?.ref ?? item?.name ?? item?.text ?? item?.net;
    const label = row.pin != null ? (item?.ref ?? kind) + "." + row.pin : name ? (item?.ref || item?.name ? name : kind + " · " + name) : kind;
    return {label, kind, layer:item?.layer, document:doc?.name ?? "Missing document", missing:!item};
  }
  // Engineering notation for a typed quantity: 10000 Ω → 10 kΩ.
  function quantity(q) {
    if (q == null || typeof q !== "object") return q == null ? "" : String(q);
    const m = q.magnitude ?? q.value;
    if (!Number.isFinite(m)) return "";
    const unit = q.unit ?? "", prefixes = [[1e9, "G"], [1e6, "M"], [1e3, "k"], [1, ""], [1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"]];
    if (!unit || unit === "mm" || unit === "mil" || unit === "°") return Math.round(m * 1e4) / 1e4 + (unit ? " " + unit : "");
    const [f, p] = prefixes.find(([f]) => Math.abs(m) >= f) ?? prefixes.at(-1);
    return Math.round(m / f * 1000) / 1000 + " " + p + unit;
  }

  // ------------------------------------------------------------------ proposal review
  // AI suggestions and macro replays share this sheet. It lists every guarded operation as
  // the object, the field and its before and after values, states where the change came
  // from and against which revision, and applies the reviewed operations as one Undo step.
  const short = value => value === undefined ? "—" : typeof value === "string" ? value || "“”" :
    typeof value === "number" ? String(Math.round(value * 1e4) / 1e4) :
    Array.isArray(value) ? (value.length && value.every(Array.isArray) ? value.length + " points" : JSON.stringify(value).slice(0, 48)) :
    value && typeof value === "object" ? (value.kind ? "New " + value.kind : "Record") : String(value);
  function changeRows(rows) {
    return rows.map(row => {
      const op = row.op, d = op.target === "item" && describe({documentId:op.document, id:op.op === "add" ? op.value?.id : op.id});
      const object = d && !d.missing ? (d.label.startsWith(d.kind) ? d.label : d.kind + " " + d.label) : String(row.label).split(" · ")[0];
      const field = op.path?.join(".") || op.target;
      const change = op.op === "add" ? K.badge("Added", "success") : op.op === "remove" ? K.badge("Removed", "danger") :
        K.diff(short(op.before), short(op.after));
      return K.row({title:object, detail:field, meta:change, role:"listitem"});
    });
  }
  /** @param {{title?:string, source:string, rows:()=>any[], total?:number, steps?:HTMLElement, note?:string,
   *   applyLabel?:string, apply:()=>Promise<number>}} options */
  async function review({title = "Review changes", source, rows, steps, note, applyLabel, apply}) {
    await kit();
    let checked = [], problem = null;
    try { checked = rows(); } catch (error) { problem = error; }
    const status = K.statusLine(source);
    status.classList.add("intel-review-source");
    const list = K.list(changeRows(checked.slice(0, 200)), {role:"list", label:"Changes"});
    list.classList.add("intel-review-list");
    const parts = [status];
    if (steps) parts.push(steps);
    if (checked.length) parts.push(list);
    if (checked.length > 200) parts.push(K.el("p", "ui-section-note", "Showing 200 of " + checked.length + " changes. All of them apply."));
    if (!checked.length && !problem) parts.push(K.empty({text:"This preview changes nothing in the design."}));
    if (note) parts.push(K.el("p", "ui-section-note", note));
    const message = K.el("div", "intel-review-message");
    message.setAttribute("role", "alert");
    if (problem) message.append(problem.code === "failed" ? K.notice({tone:"danger", title:"Stopped.", text:problem.message}) :
      K.notice({tone:"warning", title:"Out of date.", text:problem.message}));
    parts.push(message);
    let outcome = {status:"cancelled"};
    const label = applyLabel ?? (checked.length === 1 ? "Apply change" : "Apply " + checked.length + " changes");
    const body = K.el("div", "intel-review");
    body.append(...parts);
    const dialog = G.AtriumShell.dialog({title, body:[body], className:"intel-review-dialog", actions:[
      {label:"Cancel", focus:!!problem},
      {label, primary:true, default:!problem, run: async () => {
        if (problem || !checked.length) return false;
        try {
          const count = await apply();
          if (!count) throw Error("The design did not accept this change. Check edit locks and released revisions.");
          outcome = {status:"applied", count};
        } catch (error) {
          message.replaceChildren(K.notice({tone:error.code === "stale_source" ? "warning" : "danger",
            title:error.code === "stale_source" ? "Out of date." : "Not applied.", text:error.message}));
          return false;
        }
      }}]});
    const applyButton = dialog.querySelector(".is-primary");
    if (applyButton && (problem || !checked.length)) applyButton.disabled = true;
    await dialog.done;
    return outcome;
  }
  // A row's secondary actions behind one small menu button, so a narrow dock keeps its titles.
  function more(label, commands) {
    return G.AtriumNavCommon.actionMenu(K.iconButton("chevron", label, {size:"sm"}),
      commands.map(c => c === "-" ? c : {enabled:true, ...c}));
  }
  // After an apply: one quiet receipt in the surface with Undo, then "Undone".
  function receipt(slot, {count, what = "change", revision = host()?.revision?.()}, onUndo) {
    const h = host();
    const text = count + " " + what + (count === 1 ? "" : "s") + " applied as one step.";
    const undo = K.button("Undo", {variant:"quiet", size:"sm", run: async () => {
      if (h.revision() !== revision) { h.info("Other edits followed. Use Edit › Undo to step back."); return; }
      await h.act("undo");
      slot.replaceChildren(K.notice({text:"Undone."}));
      onUndo?.();
    }});
    slot.replaceChildren(K.notice({tone:"success", text, actions:[undo], live:true}));
  }
  // Apply the exact reviewed guarded operations to the live project as one editor step.
  function applyOps(project, proposal, label) {
    const h = host();
    if (h.project() !== project) throw Object.assign(Error("The open project changed. Preview again."), {code:"stale_source"});
    const prepared = G.AtriumProposal.prepare(project, proposal, G.Atrium.validate);
    return prepared.apply((change, touched, scope) => h.edit(change, label, touched, scope));
  }

  // ------------------------------------------------------------------ entry model
  // The "/" palette is the one entry point. Every surface is also a command, so the
  // classic palette, the menus' command search and shortcuts reach it too.
  const commands = new Map(), installed = new Set();
  const SURFACES = {
    ai:[{id:"assist.ask-ai", title:"Ask AI…", run:() => open("ai")}],
    query:[{id:"assist.design-query", title:"Design Query", run:() => open("query")}],
    macros:[{id:"assist.macros", title:"Macros", run:() => open("macros")}],
    links:[{id:"assist.open-link", title:"Open Waffle Link…", run:() => view("links").then(ui => ui.openPrompt())}]
  };
  const CATEGORY = {ai:"AI", query:"Query", macros:"Macros", links:"Links"};
  async function open(feature, options) {
    if (!enabled(feature)) return null;
    await kit();
    const ui = await view(feature);
    return ui.open(options);
  }
  function registerPalette() {
    const P = G.AtriumPalette;
    if (!P?.registerProvider || registerPalette.done === P) return;
    registerPalette.done = P;
    P.registerProvider("intel", {label:"Assist", entries:() => [], stream(request, emit) { emit(paletteRows(request.query)); }});
  }
  // Free text offers Ask AI (it only fills the composer); a pasted waffle:// address offers Open link.
  function paletteRows(query) {
    const text = String(query || "").trim();
    if (!text || /^[>@:]/.test(text)) return [];
    const rows = [];
    const url = /^waffle:\/\/\S+$/i.test(text) ? text : null;
    if (url && enabled("links")) rows.push({key:"intel:link", kind:"command", source:"Links", label:"Open link", detail:url,
      run:() => probe({url}, {focus:true})});
    if (!url && enabled("ai") && text.length > 2) rows.push({key:"intel:ask", kind:"command", source:"Ask AI",
      label:"Ask AI: " + text.slice(0, 120), detail:"Opens Ask AI with this question. Nothing is sent until you choose Ask.",
      run:() => open("ai", {prompt:text})});
    return rows;
  }
  // The palette's design-query results end with one row that opens the same query in the panel.
  function queryRows(source, result, scope) {
    if (!enabled("query")) return [];
    const more = result?.complete && result.count > (result.rows?.length ?? 0);
    return [{key:"query:panel", kind:"command", label:more ? "Show all " + result.count + " in Query" : "Open in Query",
      detail:source, run:() => open("query", {source,scope})}];
  }
  function sync(feature) {
    for (const handle of commands.get(feature) ?? []) handle.dispose();
    commands.delete(feature);
    const on = enabled(feature);
    if (on) installed.add(feature); else installed.delete(feature);
    if (on) commands.set(feature, SURFACES[feature].map(spec => G.AtriumKeymap.registerCommand({...spec, category:CATEGORY[feature],
      run() { Promise.resolve(spec.run()).catch(error => host()?.info(error.message)); }})));
    registerPalette();
    G.addEventListener?.("waffle-palette-ready", registerPalette);
    if (feature === "macros") recordingIndicator();
    if (feature === "links") inspectorWatch();
    const loaded = G[FEATURES[feature]];
    if (loaded?.sync) loaded.sync(on);
    else if (!on) panels.get(feature === "ai" ? "ask" : feature === "query" ? "design-query" : feature)?.dispose();
  }

  // ------------------------------------------------------------------ status bar: recording
  // Only while a macro records. Nothing is added to the status bar otherwise.
  let recorder = null, stopObserver = null;
  function recordingIndicator() {
    stopObserver?.(); stopObserver = null;
    if (!enabled("macros")) { recorder?.remove(); recorder = null; return; }
    stopObserver = G.AtriumButter.observe(event => {
      if (event.id !== "butter.macros.record-status" && (event.id.startsWith("butter.macros.") || recorder)) refreshRecording();
    });
    refreshRecording();
  }
  let pendingStatus = null;
  function refreshRecording() {
    pendingStatus ??= Promise.resolve().then(async () => {
      pendingStatus = null;
      if (!enabled("macros")) return;
      const {result} = await G.AtriumButter.run("butter.macros.record-status", {}, {mode:"read"});
      await kit();
      showRecording(result);
      G.AtriumMacrosUI?.recordingChanged?.(result);
    }).catch(() => { pendingStatus = null; });
  }
  function showRecording(state) {
    if (state.status !== "recording") { recorder?.remove(); recorder = null; return; }
    const bar = D.querySelector(".statusbar");
    if (!bar) return;
    if (!recorder) {
      recorder = K.el("span", "intel-recording");
      bar.insertBefore(recorder, bar.querySelector(".status-right"));
    }
    const text = state.full ? "Recording · " + state.count + " steps · full" : "Recording · " + state.count + (state.count === 1 ? " step" : " steps");
    const stop = K.button("Stop", {variant:"quiet", size:"sm", run:() => view("macros").then(ui => ui.stopRecording())});
    stop.title = "Stop recording and edit the macro";
    recorder.replaceChildren(K.recording(text), stop);
    recorder.dataset.full = String(!!state.full);
  }

  // ------------------------------------------------------------------ Properties: links
  // The Links section joins the Properties inspector after each rebuild while the flag is on.
  let inspectorObserver = null;
  function inspectorWatch() {
    inspectorObserver?.disconnect(); inspectorObserver = null;
    const inspector = D.getElementById("inspector");
    if (!enabled("links") || !inspector) { inspector?.querySelector(":scope > .intel-links")?.remove(); return; }
    const place = () => {
      if (!enabled("links") || inspector.querySelector(":scope > .intel-links")) return;
      view("links").then(ui => ui.inspect(inspector)).catch(error => G.console?.warn?.(error));
    };
    inspectorObserver = new MutationObserver(place);
    inspectorObserver.observe(inspector, {childList:true});
    place();
  }

  async function install(feature) { await kit(); sync(feature); }
  return Object.freeze({install, sync, open, view, dockPanel, probe, openMessage, review, receipt, applyOps, changeRows,
    queryRows, paletteRows, showRecording, kit, enabled, host, refreshRecording, short, describe, quantity, more});
})();
