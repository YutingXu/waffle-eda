"use strict";
// Query: a dock panel with three views. Search edits a native query with completions and
// located diagnostics and previews its matches as they are counted; Saved lists the
// project's saved smart groups; Rules previews what a rule applies to. Every row
// cross-probes through AtriumIntelUI.probe.
globalThis.AtriumQueryUI = (() => {
  const G = globalThis, L = G.AtriumLazy, U = G.AtriumIntelUI, K = G.AtriumUIKit;
  const host = () => G.AtriumNavHost;
  const enabled = () => G.AtriumButter.state("query").enabled;
  let PAGE = 50;
  const COLUMNS = ["designator", "name", "text", "value", "layer", "net.name"];
  const EXAMPLES = ["resistor where value < 1 kΩ", "track where width < 0.2 mm", "capacitor where value >= 100 nF"];
  const KEYWORDS = ["where", "and", "or", "not", "in net", "in class", "in component", "on layer", "near"];
  let panel, tabs, tab = "search", input, list, completion, scopeControl, editor, results, scope = "project";
  let state = {kind:"empty"}, rows = [], cursor = null, active = -1, staleTimer = 0, service, saved = null, request, scopedInstance, openTicket=0;
  const need = async () => service ??= G.AtriumQueryService ?? await L.need("AtriumQueryService");

  // ------------------------------------------------------------------ completion
  // Kinds first, then keywords after a kind, then field names after where/and/or/not.
  async function suggestions() {
    const text = input.value.slice(0, input.selectionStart ?? input.value.length);
    const word = /[\p{L}_.]*$/u.exec(text)[0], before = text.slice(0, text.length - word.length).trim();
    if (!word && !/(?:where|and|or|not)$/i.test(before)) return null;
    const lower = word.toLowerCase(), start = text.length - word.length;
    const previous = /(\S+)\s*$/.exec(before)?.[1]?.toLowerCase();
    let options;
    if (!before) options = [...(G.AtriumDesignQueryParser?.kinds ?? [])].map(k => ({label:k, insert:k + " "}));
    else if (["where", "and", "or", "not", "("].includes(previous)) {
      const F = G.AtriumQueryFields ?? await L.need("AtriumQueryFields").catch(() => null);
      const kind = /^\s*([a-z]+)/i.exec(input.value)?.[1];
      options = (F?.complete(host().project(), {kind, prefix:word}) ?? []).map(f => ({label:f.id, detail:[f.label !== f.id && f.label, f.unit].filter(Boolean).join(" · "), insert:f.id + " "}));
    } else options = KEYWORDS.map(k => ({label:k, insert:k + " "}));
    options = options.filter(o => o.label.toLowerCase().startsWith(lower) && o.label.toLowerCase() !== lower).slice(0, 8);
    return options.length ? {options, start, end:text.length} : null;
  }
  let offer = null, chosen = 0;
  async function complete() {
    const version = ++complete.version;
    const next = await suggestions();
    if (version !== complete.version) return;
    offer = next; chosen = 0; paintCompletion();
  }
  complete.version = 0;
  function paintCompletion() {
    completion.hidden = !offer;
    input.setAttribute("aria-expanded", String(!!offer));
    if (!offer) { completion.replaceChildren(); input.removeAttribute("aria-activedescendant"); return; }
    completion.replaceChildren(...offer.options.map((o, i) => {
      const option = K.el("div", "ui-select-option", o.label);
      option.id = "intel-query-option-" + i; option.setAttribute("role", "option"); option.setAttribute("aria-selected", String(i === chosen));
      if (o.detail) option.append(K.el("span", "ui-row-detail", " " + o.detail));
      option.addEventListener("pointerdown", event => { event.preventDefault(); accept(i); });
      return option;
    }));
    input.setAttribute("aria-activedescendant", "intel-query-option-" + chosen);
  }
  function accept(i = chosen) {
    const o = offer?.options[i];
    if (!o) return;
    input.setRangeText(o.insert, offer.start, offer.end, "end");
    offer = null; paintCompletion();
    input.dispatchEvent(new Event("input", {bubbles:true}));
  }

  // ------------------------------------------------------------------ search
  function documentName(id) { return host().project().documents.find(d => d.id === id)?.name ?? "Missing document"; }
  function stopSearch() { request?.abort(); request = undefined; }
  function setScope(value) {
    scope = value;
    for (const button of scopeControl.querySelectorAll("button")) button.setAttribute("aria-pressed",String(button.value === value));
  }
  async function run({more = false} = {}) {
    if (!panel?.open) return;
    clearTimeout(staleTimer);
    stopSearch();
    const source = input.value.trim();
    if (!source) { state = {kind:"empty"}; rows = []; cursor = null; render(); return; }
    const h = host(), project = h.project(), revision = h.revision(), documentId = scope === "document" ? h.currentId() : undefined;
    const {signal} = request = new AbortController();
    const current = () => !signal.aborted && panel?.open && source === input.value.trim() && h.project() === project &&
      h.revision() === revision && (!documentId || documentId === h.currentId()) && enabled();
    if (!more) { state = {kind:"compiling", source}; rows = []; cursor = null; active = -1; render(); }
    const S = await need();
    if (!current()) return;
    if (!documentId && h.folderProject?.() && !h.folderProject().completeFor("project")) {
      state = {...state, hydrating:true}; render();
      try { await h.requireProjectClosure({purpose:"project",signal}); } catch (error) { if (current()) { state = {kind:"failed", source, message:error.message}; render(); } return; }
    }
    if (!current()) return;
    if (saved && saved.source !== source) saved = null;
    const common = {project, revision, enabled, isCurrent:current, getRevision:h.revision, signal,
      documentId:saved ? undefined : documentId,
      ...(scopedInstance && scopedInstance.documentId === documentId && {instanceId:scopedInstance.instanceId})};
    // A saved group runs by its durable ID, so a deleted definition reads as missing, not as no matches.
    const query = saved?.source === source ? {savedQueryId:saved.id} : source;
    if (!more) {
      const planned = await S.plan(query, common);
      if (!current()) return;
      if (!planned.complete) {
        state = {kind:{missing:"missing", denied:"denied", cancelled:"cancelled"}[planned.status] ?? "diagnostic", source, result:planned};
        render(); return;
      }
      state = {kind:"counting", source, hints:planned.plans.flatMap(p => p.hints ?? []), lowerBound:0};
      render();
    }
    const result = await S.search(query, {...common, limit:PAGE, ...(saved ? {} : {fields:COLUMNS}), ...(more && cursor ? {cursor} : {}),
      onPage:page => { if (!current() || page.complete) return; state = {...state, kind:"counting", lowerBound:page.lowerBound};
        if (!more) { rows = page.rows; } render(); }});
    if (!current()) return;
    if (result.status === "complete") {
      rows = more ? [...rows, ...result.rows] : result.rows;
      cursor = result.cursor;
      state = {...state, kind:"complete", count:result.count, revision};
    } else if (["partial", "budget", "error"].includes(result.status) && result.lowerBound != null) {
      rows = more ? [...rows, ...(result.rows ?? [])] : result.rows ?? [];
      cursor = null;
      state = {...state, kind:"partial", lowerBound:result.lowerBound, message:result.diagnostic?.message};
    } else {
      rows = []; cursor = null;
      state = {...state, kind:result.status === "denied" ? "denied" : result.status === "cancelled" ? "cancelled" :
        result.status === "missing" ? "missing" : "diagnostic", result};
    }
    render();
  }
  function scheduleStale() {
    if (!panel?.open || tab !== "search" || !["compiling", "complete", "partial", "counting"].includes(state.kind)) return;
    state = {...state, stale:true}; render();
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => run(), 400);
  }

  function rowFor(row, index) {
    const f = row.fields ?? {}, d = U.describe(row);
    const label = row.pin != null ? (f.designator ?? d.label) + "." + row.pin : f.designator ?? f.name ?? f.text ?? d.label;
    const extra = [U.quantity(f.value), f.layer ?? d.layer, row.kind !== "part" && row.kind !== "net" ? f["net.name"] : null].filter(Boolean).join(" · ");
    const r = K.row({title:String(label), detail:[f.designator ? d.kind : null, d.document, row.instanceId && "occurrence " + row.instanceId].filter(Boolean).join(" · "),
      meta:extra || d.kind, selected:index === active});
    r.dataset.index = String(index);
    r.addEventListener("click", () => setActive(index, true));
    r.addEventListener("dblclick", () => U.probe(row, {focus:true}));
    return r;
  }
  function setActive(index, probe) {
    active = Math.max(0, Math.min(rows.length - 1, index));
    for (const r of list.querySelectorAll(".ui-row[data-index]")) r.setAttribute("aria-selected", String(Number(r.dataset.index) === active));
    list.querySelector('.ui-row[data-index="' + active + '"]')?.scrollIntoView({block:"nearest"});
    if (probe && rows[active]) U.probe(rows[active]);
  }
  async function selectAll() {
    const h = host(), source = input.value.trim(), project = h.project(), revision = h.revision(), documentId = h.currentId();
    const signal = request?.signal;
    const current = () => !signal?.aborted && panel?.open && enabled() && h.project() === project && h.revision() === revision &&
      h.currentId() === documentId && source === input.value.trim();
    const S = await need();
    if (!current()) return;
    const query = saved?.source === source ? {savedQueryId:saved.id} : source;
    const result = await S.selection(query, {project,revision,enabled,isCurrent:current,signal,getRevision:h.revision,documentId,
      ...(scopedInstance?.documentId === documentId && {instanceId:scopedInstance.instanceId})});
    if (!current()) return;
    if (!result.complete) { h.info(result.diagnostic?.message ?? "Narrow the query before selecting."); return; }
    const ids = new Set(), nets = [];
    for (const row of result.rows) {
      if (row.kind === "net") nets.push(row.id.slice(4));
      else ids.add(row.ownerId ?? row.id);
    }
    if (nets.length) {
      const crossProbe=G.AtriumCrossProbe ?? await L.need("AtriumCrossProbe");
      if(!current())return;
      for(const {ids:members} of crossProbe.netObjectsBatch(h.doc(),h.defs(),nets,{instanceId:result.rows[0]?.instanceId}).values())
        for(const id of members)ids.add(id);
    }
    h.select([...ids]);
    h.info(ids.size ? ids.size + " selected in " + h.doc().name : "Nothing in " + h.doc().name + " matches.");
  }

  function located(source, span, message) {
    const echo = K.el("pre", "ui-code intel-query-echo");
    const [a, b] = Array.isArray(span) ? span : [0, 0];
    const end = Math.max(b, a + 1);
    echo.append(source.slice(0, a));
    const mark = K.el("span", "ui-error-span", source.slice(a, end) || " ");
    echo.append(mark, source.slice(end));
    return [echo, K.notice({tone:"danger", text:message, live:true})];
  }
  function countLine() {
    const s = state;
    if (s.kind === "compiling") return K.statusLine(s.hydrating ? "Loading the rest of the project…" : "Checking…", {busy:true});
    if (s.kind === "counting") return K.statusLine(s.lowerBound ? "At least " + s.lowerBound + " · counting…" : "Counting matches…", {busy:true});
    if (s.kind === "complete") return K.statusLine(s.count === 0 ? "No matches" : s.count + (s.count === 1 ? " match" : " matches") +
      (s.stale ? " · updating…" : ""), {busy:!!s.stale});
    if (s.kind === "partial") return K.statusLine("At least " + s.lowerBound + " · count incomplete", {tone:"warning"});
    return null;
  }
  function renderSearch() {
    const out = [], s = state;
    if (s.kind === "diagnostic" && !(offer && s.source === input.value.trim())) {
      const d = s.result?.diagnostic;
      const title = {unit:"Unit mismatch", stale:"The design changed", missing:"Missing reference", scope:"Scope conflict"}[d?.code];
      out.push(...located(s.source, d?.span, (title ? title + ". " : "") + (d?.message || G.AtriumDesignQuery.unavailable())));
    }
    const units = (s.hints ?? []).filter(h => h.code === "inferred-unit" && h.unit)
      .map(h => (typeof h.field === "object" ? h.field.id : h.field) + " in " + h.unit);
    if (units.length) out.push(K.statusLine("Units inferred: " + [...new Set(units)].join(" · ")));
    const alternatives = (s.hints ?? []).filter(h => h.code === "case-alternative" && Array.isArray(h.span) && typeof h.replacement === "string");
    if (alternatives.length) out.push(K.toolbar(alternatives.slice(0, 4).map(h => K.button("Use " + h.replacement, {variant:"quiet", size:"sm",
      run:() => { input.setRangeText(h.replacement, h.span[0], h.span[1], "end"); run(); }})), {label:"Suggestions"}));
    const actions = K.el("div", "intel-query-actions");
    actions.append(scopeControl);
    if (s.kind === "complete" && s.count) actions.append(K.button("Select", {size:"sm", variant:"quiet", run:selectAll}));
    if (input.value.trim() && s.kind !== "diagnostic") actions.append(K.button("Save…", {size:"sm", variant:"quiet", run:() => saveDialog()}));
    out.push(actions);
    const count = countLine();
    if (count) { count.setAttribute("aria-live", "polite"); out.push(count); }
    if (s.kind === "empty") {
      out.push(K.empty({text:"Type a query, such as an object kind and a condition. Results update as you type.",
        actions:EXAMPLES.map(e => K.button(e, {variant:"quiet", size:"sm", run:() => { input.value = e; run(); input.focus(); }}))}));
      return out;
    }
    if (s.kind === "denied") out.push(K.notice({tone:"danger", title:"Not allowed.", text:"This query reads a scope you cannot open."}));
    if (s.kind === "missing") out.push(K.notice({tone:"warning", title:"Saved query missing.", text:"The saved definition is no longer in this project. This is not the same as no matches."}));
    if (s.kind === "failed") out.push(K.notice({tone:"danger", title:"Not run.", text:s.message}));
    if (s.kind === "partial") out.push(K.notice({tone:"warning", title:"Incomplete.", text:(s.message ?? "Part of the design could not be checked.") +
      " The rows shown matched; the count is a lower bound, not exact."}));
    if (s.kind === "complete" && s.count === 0) out.push(K.empty({text:"Nothing in " + (scope === "document" ? host().doc().name : "the project") +
      " matches. The query ran on every object."}));
    list.replaceChildren(...rows.map(rowFor));
    if (rows.length) out.push(list);
    if (cursor && state.kind === "complete") {
      const more = K.button("Show " + Math.min(PAGE, state.count - rows.length) + " more", {variant:"quiet", size:"sm", run:() => run({more:true})});
      out.push(K.statusLine("Showing " + rows.length + " of " + state.count), more);
    }
    return out;
  }

  // ------------------------------------------------------------------ saved smart groups
  async function savedRecords() {
    const S = await need(), h = host();
    return S.list({project:h.project(), revision:h.revision(), enabled});
  }
  async function renderSaved() {
    const h = host(), result = await savedRecords(), readOnly = !!h.project().atriumCompat?.readOnly;
    const out = [];
    if (readOnly) out.push(K.notice({tone:"info", title:"Read-only project.", text:"Saved groups can run but cannot change."}));
    if (!result.complete) return [...out, K.notice({tone:"danger", title:"Unavailable.", text:result.diagnostic?.message})];
    const records = result.records;
    if (!records.length) return [...out, K.empty({title:"No saved groups", text:"Save a query from Search to reuse it in views, tables and macros.",
      actions:[K.button("Search…", {size:"sm", run:() => setTab("search")})], centred:true})];
    const names = new Map();
    for (const r of records) names.set(r.name.toLowerCase(), (names.get(r.name.toLowerCase()) ?? 0) + 1);
    const S = await need();
    const rowsOut = [];
    for (const r of records) {
      const planned = await S.plan({savedQueryId:r.id}, {project:h.project(), revision:h.revision(), enabled});
      const code = planned.complete ? null : planned.diagnostic?.code;
      const meta = K.el("span", "intel-row-badges");
      if (names.get(r.name.toLowerCase()) > 1) meta.append(K.badge("Duplicate name", "warning"));
      if (code === "language" || code === "version") meta.append(K.badge("Newer language", "warning"));
      else if (code) meta.append(K.badge("Needs repair", "danger"));
      if (r.columns?.length) meta.append(K.badge(r.columns.length + " columns"));
      const where = r.scope.documentId ? documentName(r.scope.documentId) : "Project";
      const actions = [K.button("Run", {variant:"quiet", size:"sm", run:() => openSaved(r)})];
      if (!readOnly) actions.push(U.more("More actions for " + r.name, [{label:"Rename…", run:() => saveDialog(r)}, {label:"Delete…", run:() => deleteSaved(r)}]));
      const row = K.row({title:r.name, detail:where + " · " + r.query.source, meta, actions, state:code ? "broken" : undefined, role:"listitem"});
      if (code) row.title = planned.diagnostic.message;
      rowsOut.push(row);
    }
    out.push(K.section("Saved groups", {actions:[K.count(records.length, {label:records.length + " saved"})]}, K.list(rowsOut, {role:"list"})));
    return out;
  }
  function openSaved(record) {
    return open({source:record.query.source,scope:record.scope,savedRecord:record});
  }
  async function saveDialog(existing) {
    const h = host(), name = K.field({value:existing?.name ?? "", label:"Name", placeholder:"Low-value resistors"});
    const where = K.segmented([["project", "Project"], ["document", h.doc().name]], {value:existing ? (existing.scope.documentId ? "document" : "project") : scope, label:"Scope"});
    const message = K.el("p", "ui-prop-error");
    const body = [K.propRow("Name", name), ...(existing ? [] : [K.propRow("Scope", where), K.propRow("Query", K.el("code", "ui-code", input.value.trim()))]), message];
    const d = G.AtriumShell.dialog({title:existing ? "Rename saved group" : "Save query", body, actions:[{label:"Cancel"},
      {label:existing ? "Rename" : "Save", primary:true, run:async () => {
        const value = name.value.trim();
        if (!value) { message.textContent = "Enter a name."; name.setAttribute("aria-invalid", "true"); return false; }
        const chosenScope = where.querySelector("[aria-pressed=true]")?.value === "document" ? {documentId:h.currentId()} : {};
        try {
          const receipt = await G.AtriumButterEditor.apply("butter.query.save-query", existing ? {id:existing.id, name:value} :
            {name:value, source:input.value.trim(), scope:chosenScope});
          if (receipt.result.complete === false) throw Error(receipt.result.diagnostic?.message ?? "Not saved.");
        } catch (error) { message.textContent = error.message; return false; }
      }}]});
    name.focus();
    const done = await d.done;
    if (done === "Save" || done === "Rename") { h.info(existing ? "Renamed" : "Saved to this project · Undo reverts it"); if (tab === "saved") render(); }
  }
  async function deleteSaved(record) {
    const d = G.AtriumShell.dialog({title:"Delete " + record.name + "?", body:[K.el("p", null,
      "Views, tables and macros that use this group keep their reference and show it as missing. Undo restores it.")],
    actions:[{label:"Cancel", focus:true}, {label:"Delete", variant:"danger", default:false, run:async () => {
      await G.AtriumButterEditor.apply("butter.query.delete-saved", {id:record.id});
    }}]});
    if (await d.done === "Delete") render();
  }

  // ------------------------------------------------------------------ rule applicability
  let ruleId = null;
  const expanded = new Set();
  async function renderRules() {
    const h = host(), doc = h.doc(), project = h.project();
    await L.need("AtriumRules").catch(() => null);
    const R = G.AtriumRules, defs = new Map(project.library.map(d => [d.id, d]));
    const drc = doc.kind === "pcb" ? R?.compiled?.(doc, {project, defs})?.set.list ?? [] : [];
    const erc = doc.kind === "schematic" ? (project.rules?.list ?? []).filter(r => G.AtriumProjectRules?.isErc(r.type)) : [];
    const rules = [...drc, ...erc];
    if (!rules.length) return [K.empty({text:"This document has no rules to preview. Open a board or a schematic with rules."})];
    if (!rules.some(r => r.id === ruleId)) ruleId = rules[0].id;
    const pick = K.select(rules.map(r => [r.id, r.name + (r.enabled === false ? " (off)" : "")]), {value:ruleId, label:"Rule",
      onChange:value => { ruleId = value; render(); }});
    const out = [K.propRow("Rule", pick)];
    const S = await need();
    const result = await S.applicability(ruleId, {project, revision:h.revision(), enabled, documentId:doc.id, limit:100});
    if (result.status !== "complete" && result.status !== "partial") return [...out, K.notice({tone:"danger", title:"Unavailable.", text:result.diagnostic?.message})];
    const coverage = {"check-candidates":"Every check candidate", "scope-only":"Scope only", "reported-check-subjects":"Reported findings only", none:"No preview"}[result.coverage];
    const badges = K.el("span", "intel-row-badges");
    badges.append(K.badge(result.domain.toUpperCase()), K.badge(coverage, result.coverage === "check-candidates" ? "success" : "warning"));
    if (result.enabled === false) badges.append(K.badge("Off"));
    out.push(K.propRow("Coverage", badges));
    for (const d of result.diagnostics) out.push(K.el("p", "ui-section-note", d.message));
    // Most telling first: findings, where the rule wins, the pairs it checks, then its scope.
    // Each list shows eight rows until expanded, so a 50-member scope does not bury the rest.
    const SHOWN = 8;
    const collapsible = (title, rowsIn, count, note, empty) => {
      const key = ruleId + ":" + title, all = expanded.has(key);
      const list = K.list(rowsIn.slice(0, all ? rowsIn.length : SHOWN), {role:"list", label:title});
      const s = K.section(title, {quiet:true, level:4, actions:[K.count(count)], note}, rowsIn.length ? list : K.empty({text:empty}));
      if (rowsIn.length > SHOWN && !all) s.append(K.button("Show all " + count, {variant:"quiet", size:"sm", run:() => { expanded.add(key); render(); }}));
      return s;
    };
    const member = r => { const d = U.describe({...r, documentId:r.documentId ?? doc.id});
      return K.row({title:d.label, detail:d.layer ?? d.kind, run:() => U.probe({documentId:r.documentId ?? doc.id, id:r.ownerId ?? r.id, pin:r.pin})}); };
    out.push(collapsible("Findings", result.violations.map(v => K.row({title:v.message ?? v.rule ?? "Finding",
      detail:[v.actual, v.required].filter(x => x != null).join(" · "), run:v.id ? () => U.probe({documentId:doc.id, id:v.objectId ?? v.id}) : undefined})),
      result.violations.length, undefined, "No findings for this rule."));
    out.push(collapsible("Wins here", result.winners.rows.map(member), result.winners.count,
      "Objects where this rule has the highest priority. Other scope members are shadowed by a higher rule.", "This rule wins nowhere."));
    if (result.pairs.count) out.push(collapsible("Checked pairs", result.pairs.rows.map(([a, b]) => K.row({title:U.describe({...a, documentId:a.documentId ?? doc.id}).label + " ↔ " +
      U.describe({...b, documentId:b.documentId ?? doc.id}).label, run:() => U.probe({documentId:a.documentId ?? doc.id, id:a.ownerId ?? a.id})})), result.pairs.count));
    out.push(collapsible(result.scope2.count ? "First scope" : "Scope", result.scope.rows.map(member), result.scope.count, undefined, "Nothing is in scope."));
    if (result.scope2.count) out.push(collapsible("Second scope", result.scope2.rows.map(member), result.scope2.count));
    return out;
  }

  // ------------------------------------------------------------------ panel
  async function render() {
    if (!panel?.open) return;
    const version = ++render.version;
    const nodes = tab === "search" ? renderSearch() : tab === "saved" ? await renderSaved() : await renderRules();
    if (version !== render.version) return;
    // The editor stays in place while results change, so typing never loses focus.
    if (tab !== "search") { panel.body.replaceChildren(...nodes); return; }
    if (editor.parentNode !== panel.body || results.parentNode !== panel.body) panel.body.replaceChildren(editor, results);
    results.replaceChildren(...nodes);
  }
  render.version = 0;
  function setTab(id) {
    tab = id;
    for (const b of tabs.querySelectorAll(".ui-tab")) { const on = b.value === id; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
    render();
  }
  function build() {
    panel = U.dockPanel({id:"design-query", title:"Query"});
    const spec = {id:"design-query", title:"Query", element:panel.el, area:"right"};
    if (G.AtriumDock?.register) G.AtriumDock.register(spec); else (G.AtriumDockPending ||= []).push(spec);
    tabs = K.tabs([["search", "Search"], ["saved", "Saved"], ["rules", "Rules"]], {value:tab, strip:true, label:"Query views", onChange:setTab});
    panel.strip.append(tabs); panel.strip.hidden = false;
    input = /** @type {HTMLTextAreaElement} */ (K.el("textarea", "ui-field intel-query-source"));
    input.rows = 2; input.spellcheck = false; input.placeholder = "Type a query";
    input.setAttribute("aria-label", "Query"); input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list"); input.setAttribute("aria-controls", "intel-query-completions");
    completion = K.el("div", "ui-select-list intel-completion");
    completion.dataset.completion = ""; completion.id = "intel-query-completions";
    completion.setAttribute("role", "listbox"); completion.setAttribute("aria-label", "Suggestions"); completion.hidden = true;
    editor = K.el("div", "intel-query-editor");
    editor.append(input, completion);
    results = K.el("div", "intel-query-results");
    let typing = 0;
    input.addEventListener("input", () => { stopSearch(); complete(); clearTimeout(typing); typing = setTimeout(() => run(), 250); });
    input.addEventListener("keydown", event => {
      event.stopPropagation();
      if (offer && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
        event.preventDefault(); chosen = (chosen + (event.key === "ArrowDown" ? 1 : -1) + offer.options.length) % offer.options.length; paintCompletion(); return;
      }
      if (offer && (event.key === "Tab" || event.key === "Enter")) { event.preventDefault(); accept(); return; }
      if (offer && event.key === "Escape") { event.preventDefault(); offer = null; paintCompletion(); return; }
      if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); clearTimeout(typing); run(); return; }
      if (event.key === "ArrowDown" && rows.length && !input.value.slice(input.selectionStart).includes("\n")) { event.preventDefault(); list.focus(); setActive(Math.max(active, 0), true); }
      if (event.key === "Escape" && input.value) { event.preventDefault(); input.value = ""; run(); }
    });
    input.addEventListener("blur", () => { offer = null; paintCompletion(); });
    list = K.list([], {label:"Matches"});
    list.tabIndex = 0;
    list.addEventListener("keydown", event => {
      const step = {ArrowDown:1, ArrowUp:-1, PageDown:10, PageUp:-10}[event.key];
      if (step) { event.preventDefault(); if (active <= 0 && step < 0) { input.focus(); return; } setActive(active + step, true); }
      else if (event.key === "Enter") { event.preventDefault(); if (rows[active]) U.probe(rows[active], {focus:true}); }
      else if (event.key === "Home" || event.key === "End") { event.preventDefault(); setActive(event.key === "Home" ? 0 : rows.length - 1, true); }
    });
    scopeControl = K.segmented([["project", "Project"], ["document", "Document"]], {value:scope, size:"sm", label:"Scope",
      onChange:value => { scopedInstance=undefined; setScope(value); run(); }});
    const h = host();
    h.on?.("change", () => {stopSearch(); scheduleStale();});
    h.on?.("document", () => { if (scope === "document") {stopSearch(); scheduleStale();} if (tab === "rules") render(); });
    h.on?.("replace", () => { stopSearch(); clearTimeout(staleTimer); rows = []; state = {kind:"empty"}; input.value = ""; render(); });
  }
  async function open({source,scope:targetScope,savedRecord} = {}) {
    if (!panel) build();
    const livePanel=panel, h=host(), project=h.project(), ticket=++openTicket;
    need().catch(() => {});
    livePanel.show();
    if (source != null) {
      stopSearch();
      const targetDoc=targetScope?.documentId;
      if (targetDoc && h.currentId() !== targetDoc) await h.selectDocument(targetDoc);
      if(ticket!==openTicket || panel!==livePanel || !livePanel.open || h.project()!==project ||
        targetDoc && h.currentId()!==targetDoc)return null;
      saved = savedRecord ? {id:savedRecord.id,source:savedRecord.query.source,name:savedRecord.name} : null;
      scopedInstance = !saved && targetScope?.instanceId ? targetScope : undefined;
      if (targetScope) {
        setScope(targetDoc ? "document" : "project");
      }
      input.value = source; setTab("search"); run();
    }
    else render();
    if (tab === "search") input.focus();
    return livePanel;
  }
  function sync(on) { if (!on) { stopSearch(); clearTimeout(staleTimer); panel?.dispose(); panel = null; rows = []; state = {kind:"empty"}; } }
  return Object.freeze({open, sync, run, setTab, state:() => state, rows:() => rows, set pageSize(n) { PAGE = n; }});
})();
