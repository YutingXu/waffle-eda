"use strict";
// Ask AI: a dock panel with three views (Ask, Activity, Access). The provider engine,
// consent, credential broker and redacted log are in butter-ai.js and ai-provider-desktop.js;
// this view only reads and requests through the Butter commands.
globalThis.AtriumAskUI = (() => {
  const G = globalThis, B = G.AtriumButter, U = G.AtriumIntelUI, K = G.AtriumUIKit;
  const host = () => G.AtriumNavHost;
  const apply = (id, args) => G.AtriumButterEditor.apply(id, args);
  const read = async (id, args = {}) => (await B.run(id, args, {mode:"read"})).result;
  const TOOLS = [["query", "Design queries"], ["inspect_component", "Selected components"], ["run_erc", "ERC findings"],
    ["run_drc", "DRC findings"], ["evaluate_calculation", "Selected calculations"], ["compare_revisions", "Revision comparison"],
    ["list_library", "Library search"], ["project_history", "Project history"]];
  const toolName = id => TOOLS.find(([key]) => key === id)?.[1] ?? id;
  const MAX_SELECTION = 8, MAX_ANSWER = 4000, MAX_LOG = 40;
  const FAILURES = {
    permission_denied:["This project or tool is not allowed.", "Check Access."],
    stale_source:["The selection, project or permission changed while asking.", "Nothing from this request was kept."],
    cancelled:["Stopped.", "The provider's answer, if it arrives, is discarded."],
    credential_missing:["No key is saved for this provider.", "Add one in Access."],
    credential_unavailable:["The system keychain is unavailable.", "Add the key again or check the keychain."],
    invalid_provider_result:["The provider's reply could not be used.", ""],
    invalid_arguments:["The question could not be sent.", ""],
    unsupported_command:["This provider is unavailable here.", ""],
    provider_failed:["The provider did not answer.", ""]
  };
  let panel, tabs, tab = "ask", input, providerSelect, askButton, context, serial = 0, state = null;
  const turns = [];
  const projectKey = () => host()?.project()?.id;
  let turnsProject = null;

  // ------------------------------------------------------------------ readiness
  // One state, most severe first: no provider, approval required, opted out, key missing, ready.
  async function readiness() {
    const X = G.AtriumExtensions;
    const [{providers}, policy] = await Promise.all([read("butter.ai.providers"), read("butter.ai.policy")]);
    const pending = (X?.list?.() ?? []).filter(e => {
      const perms = X.permissions?.(e.id);
      return perms?.declared.includes("ai:provider") && (!perms.live["ai:provider"] || !e.enabled) &&
        !providers.some(p => p.id.startsWith(e.id + ":"));
    });
    const credentials = new Map();
    for (const p of providers) {
      if (!p.credential) { credentials.set(p.id, {state:"none"}); continue; }
      const known = state?.credentials.get(p.id);
      credentials.set(p.id, known ?? await credential(p.id, "status"));
    }
    return {providers, policy, pending, credentials};
  }
  async function credential(provider, operation) {
    try {
      const r = (await apply("butter.ai.credential", {provider, operation})).result;
      if (!r.available) return {state:"unavailable"};
      if (r.cancelled) return state?.credentials.get(provider) ?? {state:"missing"};
      return {state:r.configured ? "saved" : "missing", maxBytes:r.maxBytes};
    } catch { return {state:"unavailable"}; }
  }
  const chosen = () => state?.providers.find(p => p.id === providerSelect?.value) ?? state?.providers[0];
  function blocker() {
    if (!state) return {code:"loading"};
    if (!state.providers.length) return {code:state.pending.length ? "approval" : "none"};
    if (!state.policy.allowed) return {code:"opted-out"};
    const key = state.credentials.get(chosen().id);
    if (key?.state === "unavailable") return {code:"keychain"};
    if (key?.state === "missing") return {code:"key"};
    return null;
  }
  function stateNotice() {
    const b = blocker();
    if (!b || b.code === "loading" || b.code === "none") return null;
    const go = (label, run, variant = "quiet") => K.button(label, {variant, size:"sm", run});
    const manager = () => G.AtriumExtensions?.openManager?.();
    return {
      approval:() => K.notice({tone:"warning", title:"Approval required.", text:state.pending.map(e => e.name).join(", ") +
        " asks to act as an AI provider.", actions:[go("Review…", manager)]}),
      "opted-out":() => K.notice({tone:"info", title:"Not shared with AI.", text:"This project has not allowed AI requests.",
        actions:[go("Allow…", () => setTab("access"))]}),
      keychain:() => K.notice({tone:"warning", title:"Keychain unavailable.", text:"The system keychain did not answer for " +
        chosen().label + ".", actions:[go("Try again", () => refresh(true))]}),
      key:() => K.notice({tone:"info", title:"Key needed.", text:chosen().label + " needs an API key in the system keychain.",
        actions:[go("Add key…", () => configure(chosen().id))]})
    }[b.code]();
  }

  // ------------------------------------------------------------------ Ask view
  function contextLine() {
    const h = host(), doc = h.doc(), selection = h.selection();
    const parts = ["Shares " + doc.name];
    if (selection.length) parts.push(selection.length > MAX_SELECTION ? MAX_SELECTION + " of " + selection.length + " selected" :
      selection.length + " selected");
    const tools = state?.policy.tools.length ?? 0;
    parts.push(tools ? tools + (tools === 1 ? " read tool" : " read tools") : "no read tools");
    return parts.join(" · ");
  }
  function renderAsk() {
    const b = blocker();
    if (b?.code === "loading") return [K.statusLine("Checking providers…", {busy:true})];
    if (b?.code === "none") return [K.empty({title:"No AI provider", text:"Providers come from extensions. Install one, then allow it for this project.",
      actions:[K.button("Extensions…", {size:"sm", run:() => G.AtriumExtensions?.openManager?.()})], centred:true})];
    if (!turns.length) return [K.empty({text:"Ask about " + host().doc().name + ". Answers list the objects they used; select a source to find it on the canvas.",
      centred:true})];
    const transcript = K.el("div", "ui-transcript intel-transcript");
    transcript.setAttribute("aria-live", "polite");
    for (const turn of turns) transcript.append(...renderTurn(turn));
    return [transcript];
  }
  function renderTurn(turn) {
    const out = [];
    const question = K.turn("user", turn.prompt);
    question.append(K.el("span", "ui-turn-role intel-turn-context", "Shared: " + turn.context));
    out.push(question);
    for (const r of turn.reads ?? []) {
      const tool = K.turn("tool", "Read " + r.rows + (r.rows === 1 ? " row" : " rows") + " · " + toolName(r.tool) +
        (r.fields?.length ? " · " + r.fields.length + " fields" : ""), {label:"Tool"});
      if (r.fields?.length) tool.title = "Fields: " + r.fields.join(", ");
      out.push(tool);
    }
    if (turn.status === "working") {
      const stop = K.button("Stop", {variant:"quiet", size:"sm", run:() => stopTurn(turn)});
      const line = K.statusLine("Asking " + turn.providerLabel + "…", {busy:true});
      line.append(stop);
      out.push(line);
      return out;
    }
    if (turn.status !== "answered") {
      const [title, text] = FAILURES[turn.code] ?? FAILURES.provider_failed;
      const actions = turn.code === "stale_source" || turn.code === "provider_failed" || turn.code === "cancelled" ?
        [K.button("Ask again", {variant:"quiet", size:"sm", run:() => { input.value = turn.prompt; send(); }})] :
        turn.code === "permission_denied" ? [K.button("Access", {variant:"quiet", size:"sm", run:() => setTab("access")})] : [];
      out.push(K.notice({tone:turn.code === "cancelled" ? undefined : turn.code === "stale_source" ? "warning" : "danger",
        title, text, actions}));
      return out;
    }
    const r = turn.result, citations = r.citations ?? [];
    const cite = (c, n) => K.cite(n, {label:"Source " + n + ": " + (c.label ?? c.evidence?.tool), run:() => U.probe(target(c))});
    const body = K.el("p", "intel-answer");
    // Inline [t1.2] tickets become numbered markers; otherwise the markers follow the answer.
    const tickets = new Map(citations.map((c, i) => [c.ticket, i]));
    let placed = false;
    for (const piece of r.text.split(/(\[t\d+\.\d+\])/)) {
      const hit = /^\[(t\d+\.\d+)\]$/.exec(piece), at = hit && tickets.get(hit[1]);
      if (at != null) { body.append(cite(citations[at], at + 1)); placed = true; } else if (piece) body.append(piece.replace(/\[t\d+\.\d+\]/g, ""));
    }
    if (!placed) citations.forEach((c, i) => body.append(" ", cite(c, i + 1)));
    const answer = K.turn("assistant", body, {label:turn.providerLabel});
    out.push(answer);
    const notes = [];
    if (r.text.length >= MAX_ANSWER) notes.push("Answer shortened at 4,000 characters.");
    if (r.citationsOmitted) notes.push(r.citationsOmitted + " more " + (r.citationsOmitted === 1 ? "source" : "sources") + " not shown (16 at most).");
    if (turn.partial) notes.push(turn.partial);
    if (notes.length) answer.append(K.statusLine(notes.join(" "), {tone:"warning"}));
    if (citations.length) {
      const rows = citations.map((c, i) => {
        const t = target(c), doc = t?.documentId && host().project().documents.find(d => d.id === t.documentId);
        const item = doc?.items.find(row => row.id === (t.ownerId ?? t.id)), kind = item?.kind ?? c.evidence?.row?.kind;
        const row = K.row({title:item?.ref ?? item?.name ?? item?.text ?? c.evidence?.row?.ref ?? c.label ?? c.ticket,
          detail:[kind && kind[0].toUpperCase() + kind.slice(1), doc?.name ?? toolName(c.evidence?.tool)].filter(Boolean).join(" · "),
          meta:K.count(i + 1), run:t ? () => U.probe(t) : undefined});
        if (!t) { row.dataset.state = "broken"; row.title = "This source has no location in the design."; }
        return row;
      });
      const list = K.list(rows, {role:"list", label:"Sources"});
      answer.append(K.section("Sources", {quiet:true}, list));
    }
    if (r.proposal) answer.append(proposalBlock(turn));
    return out;
  }
  const target = c => {
    const row = c.evidence?.row ?? {}, documentId = c.documentId ?? row.documentId ?? row.document_id;
    const id = row.id ?? row.object_id;
    if (documentId && id) return {documentId, id, ownerId:row.ownerId, pin:row.pin, padIndex:row.padIndex};
    return c.url ? {url:c.url} : null;
  };
  function proposalBlock(turn) {
    const r = turn.result, proposal = r.proposal, slot = K.el("div", "intel-proposal-state");
    const first = proposal.ops[0];
    const label = first.path?.join(".") ?? "change";
    const item = host().project().documents.find(d => d.id === first.document)?.items.find(i => i.id === first.id);
    const row = K.row({title:(item?.ref ?? "Object") + " · " + label, detail:proposal.ops.length > 1 ?
      "With " + (proposal.ops.length - 1) + " connected " + (proposal.ops.length === 2 ? "wire" : "wires") : "Revision " + r.proposalRevision,
      meta:K.diff(U.short(first.before), U.short(first.after)), role:"listitem"});
    const actions = [];
    if (turn.proposal === "pending") actions.push(K.button("Review…", {size:"sm", run:() => reviewProposal(turn)}));
    if (turn.proposal === "pending") slot.append(K.statusLine("Not applied yet."));
    if (turn.proposal === "stale") slot.append(K.notice({tone:"warning", title:"Out of date.", text:turn.proposalError ??
      "The design or permission changed after this suggestion. Ask again for a fresh one."}));
    if (turn.proposal === "applied") U.receipt(slot, {count:turn.applied, revision:turn.appliedRevision}, () => { turn.proposal = "undone"; render(); });
    if (turn.proposal === "undone") slot.append(K.notice({text:"Undone."}));
    return K.section("Suggested change", {quiet:true, actions}, K.list([row], {role:"list"}), slot);
  }
  async function reviewProposal(turn) {
    const AI = G.AtriumAI ?? await G.AtriumLazy.need("AtriumAI"), h = host(), project = h.project();
    const context = {project, folderProject:h.folderProject?.(), currentProject:h.project, defs:h.defs(), edit:h.edit};
    const outcome = await U.review({title:"Review suggested change",
      source:"From " + turn.providerLabel + " · revision " + turn.result.proposalRevision + " · " + h.doc().name,
      rows:() => AI.inspect(turn.result.proposal, project),
      note:turn.result.proposal.ops.length > 1 ? "Connected wires move with the component, so the changes apply together." : undefined,
      apply:() => AI.apply(context, turn.result.proposal)});
    if (outcome.status === "applied") { turn.proposal = "applied"; turn.applied = outcome.count; turn.appliedRevision = h.revision(); }
    else if (outcome.status === "cancelled") {
      try { AI.inspect(turn.result.proposal, project); } catch (error) { turn.proposal = "stale"; turn.proposalError = error.message; }
    }
    render();
  }

  // ------------------------------------------------------------------ request
  async function send() {
    const prompt = input.value.trim(), provider = chosen();
    if (!prompt || blocker() || !provider) return;
    const h = host(), selection = h.selection();
    const turn = {prompt, provider:provider.id, providerLabel:provider.label, status:"working", token:++serial,
      context:contextLine().replace(/^Shares /, "")};
    if (selection.length > MAX_SELECTION) turn.partial = "Only " + MAX_SELECTION + " of " + selection.length + " selected objects were shared.";
    turns.push(turn);
    input.value = "";
    render();
    try {
      const receipt = await apply("butter.ai.ask", {provider:provider.id, prompt});
      if (turn.status !== "working") return;
      turn.result = receipt.result;
      turn.status = receipt.result.status === "answered" ? "answered" : "failed";
      turn.code = receipt.result.code;
      if (receipt.result.proposal) turn.proposal = "pending";
    } catch (error) {
      if (turn.status !== "working") return;
      turn.status = "failed"; turn.code = error.code ?? "provider_failed";
    }
    try { turn.reads = (await read("butter.ai.activity")).requests.at(-1)?.readTools ?? []; } catch { turn.reads = []; }
    render();
    panel.body.querySelector(".intel-transcript > :last-child")?.scrollIntoView({block:"nearest"});
  }
  // The broker cancels a request and stops its worker whenever the project's AI policy is
  // written. Stop writes the unchanged policy, so the provider is cut off, not just ignored.
  function stopTurn(turn) {
    turn.status = "failed"; turn.code = "cancelled";
    const p = state?.policy;
    if (p?.allowed) apply("butter.ai.set-policy", {allowed:true, tools:p.tools, proposeEdits:p.proposeEdits}).catch(() => {});
    render();
    input.focus();
  }

  // ------------------------------------------------------------------ Activity view
  async function renderActivity() {
    const requests = (await read("butter.ai.activity")).requests.slice().reverse();
    const names = new Map((state?.providers ?? []).map(p => [p.id, p.label]));
    const clear = K.button("Clear…", {variant:"quiet", size:"sm", disabled:!requests.length, run:confirmClear});
    const head = K.section("Recent requests", {actions:[K.count(requests.length, {label:requests.length + " of " + MAX_LOG + " kept"}), clear],
      note:requests.length >= MAX_LOG ? "Full: the oldest request is dropped as each new one is added." :
        "The last " + MAX_LOG + " requests for this project, kept on this computer. Prompts and answers are shortened and redacted; keys and raw tool data are never kept."});
    if (!requests.length) { head.append(K.empty({text:"No requests yet for this project."})); return [head]; }
    const time = at => new Date(at).toLocaleString(undefined, {month:"short", day:"numeric", hour:"2-digit", minute:"2-digit"});
    const tone = {answered:"success", stale_source:"warning", cancelled:undefined, permission_denied:"warning"};
    const label = {answered:"Answered", stale_source:"Out of date", permission_denied:"Not allowed", cancelled:"Stopped"};
    const rows = requests.map(r => {
      const fields = new Set((r.readTools ?? []).flatMap(t => t.fields ?? []));
      const rowsRead = (r.readTools ?? []).reduce((n, t) => n + t.rows, 0);
      const detail = [time(r.at), (r.readTools?.length ?? 0) + " tools", fields.size + " fields", rowsRead + " rows"].join(" · ");
      const row = K.row({title:r.promptExcerpt || "(empty)", detail, meta:K.badge(label[r.result] ?? "Failed", r.result in tone ? tone[r.result] : "danger"),
        role:"listitem"});
      row.title = [names.get(r.provider) ?? r.provider, r.answerExcerpt].filter(Boolean).join("\n");
      return row;
    });
    head.append(K.list(rows, {role:"list", label:"Recent requests"}));
    return [head];
  }
  async function confirmClear() {
    const d = G.AtriumShell.dialog({title:"Clear AI activity?", body:[K.el("p", null, "This removes the request log for this project on this computer.")],
      actions:[{label:"Cancel", focus:true}, {label:"Clear", variant:"danger", default:false, run:async () => { await apply("butter.ai.clear-activity", {}); }}]});
    if (await d.done === "Clear") render();
  }

  // ------------------------------------------------------------------ Access view
  async function renderAccess() {
    const out = [], p = state.policy;
    const providerRows = state.providers.map(provider => {
      const key = state.credentials.get(provider.id);
      const actions = [], badges = [];
      if (provider.credential) {
        if (key.state === "saved") {
          badges.push(K.badge("Key in keychain", "success"));
          actions.push(K.button("Replace…", {variant:"quiet", size:"sm", run:() => configure(provider.id)}),
            K.button("Forget", {variant:"quiet", size:"sm", run:() => forget(provider.id)}));
        } else if (key.state === "unavailable") badges.push(K.badge("Keychain unavailable", "warning"));
        else { badges.push(K.badge("No key")); actions.push(K.button("Add key…", {variant:"quiet", size:"sm", run:() => configure(provider.id)})); }
      } else badges.push(K.badge("No key needed"));
      const meta = K.el("span", "intel-row-badges");
      meta.append(...badges);
      return K.row({title:provider.label, detail:provider.hosts.length ? provider.hosts.join(", ") : "Runs on this computer",
        meta, actions, reveal:false, role:"listitem"});
    });
    for (const e of state.pending) providerRows.push(K.row({title:e.name, detail:"Waiting for approval in Extensions",
      meta:K.badge("Approval required", "warning"), actions:[K.button("Review…", {variant:"quiet", size:"sm",
        run:() => G.AtriumExtensions?.openManager?.()})], reveal:false, role:"listitem"}));
    out.push(K.section("Providers", {}, providerRows.length ? K.list(providerRows, {role:"list"}) :
      K.empty({text:"No provider is installed. Providers come from extensions."})));
    const policy = next => apply("butter.ai.set-policy", next).then(() => refresh(), error => host().info(error.message));
    const allow = K.switchRow("Allow AI requests for this project", {checked:p.allowed,
      onChange:on => policy({allowed:on, tools:on ? p.tools : [], proposeEdits:false})});
    const queryOff = !U.enabled("query");
    const tools = TOOLS.map(([id, label]) => K.checkbox(label, {checked:p.tools.includes(id), disabled:!p.allowed || id === "query" && queryOff,
      onChange:on => policy({allowed:true, tools:on ? [...p.tools, id] : p.tools.filter(t => t !== id), proposeEdits:p.proposeEdits})}));
    const canPropose = state.providers.some(provider => provider.proposals);
    const propose = K.switchRow("Allow suggested edits", {checked:p.proposeEdits, disabled:!p.allowed || !canPropose,
      onChange:on => policy({allowed:true, tools:p.tools, proposeEdits:on})});
    const toolGroup = K.el("div", "intel-checks");
    toolGroup.setAttribute("role", "group"); toolGroup.setAttribute("aria-label", "Read tools");
    toolGroup.append(...tools);
    out.push(K.section("This project", {note:"Applies to this project on this computer. A request shares only the active document, up to " +
      MAX_SELECTION + " selected objects and the tools allowed here. Nothing is sent until you choose Ask."},
      allow, K.section("Read tools", {quiet:true, level:4}, toolGroup,
        ...(queryOff ? [K.el("p", "ui-section-note", "Design queries need Query in Preferences › Experimental features.")] : [])), propose,
      ...(canPropose ? [] : [K.el("p", "ui-section-note", "Suggested edits need a provider with the propose edits permission.")])));
    return out;
  }
  async function configure(provider) {
    state.credentials.set(provider, await credential(provider, "configure"));
    render();
  }
  async function forget(provider) {
    const d = G.AtriumShell.dialog({title:"Forget this key?", body:[K.el("p", null, "The key is removed from the system keychain. Requests to this provider stop until you add a key again.")],
      actions:[{label:"Cancel", focus:true}, {label:"Forget", variant:"danger", default:false}]});
    if (await d.done !== "Forget") return;
    await credential(provider, "forget");
    state.credentials.set(provider, {state:"missing"});
    render();
  }

  // ------------------------------------------------------------------ panel
  async function render() {
    if (!panel?.open) return;
    if (projectKey() !== turnsProject) { turns.length = 0; turnsProject = projectKey(); }
    const version = ++render.version;
    panel.setNotice(tab === "ask" ? stateNotice() : null);
    const nodes = tab === "ask" ? renderAsk() : !state ? [K.statusLine("Checking providers…", {busy:true})] :
      tab === "activity" ? await renderActivity() : await renderAccess();
    if (version !== render.version) return;
    panel.body.replaceChildren(...nodes);
    panel.foot.hidden = tab !== "ask" || !state?.providers.length;
    const b = blocker();
    input.disabled = !!b;
    askButton.disabled = !!b || turns.some(t => t.status === "working");
    providerSelect.hidden = (state?.providers.length ?? 0) < 2;
    context.textContent = b ? "" : contextLine();
  }
  render.version = 0;
  async function refresh(recheck = false) {
    if (recheck && state) state.credentials.clear();
    try { state = await readiness(); } catch (error) { host().info(error.message); }
    if (state && providerSelect) {
      const keep = providerSelect.value;
      providerSelect.replaceChildren(...state.providers.map(p => new Option(p.label, p.id)));
      if (state.providers.some(p => p.id === keep)) providerSelect.value = keep;
    }
    render();
  }
  function setTab(id) {
    tab = id;
    for (const b of tabs.querySelectorAll(".ui-tab")) { const on = b.value === id; b.setAttribute("aria-selected", String(on)); b.tabIndex = on ? 0 : -1; }
    render();
  }
  function build() {
    panel = U.dockPanel({id:"ask", title:"Ask AI"});
    const spec = {id:"ask", title:"Ask AI", element:panel.el, area:"right"};
    if (G.AtriumDock?.register) G.AtriumDock.register(spec); else (G.AtriumDockPending ||= []).push(spec);
    tabs = K.tabs([["ask", "Ask"], ["activity", "Activity"], ["access", "Access"]], {value:tab, strip:true, label:"Ask AI views", onChange:setTab});
    panel.strip.append(tabs); panel.strip.hidden = false;
    input = /** @type {HTMLTextAreaElement} */ (K.el("textarea", "ui-field intel-composer-input"));
    input.rows = 2; input.placeholder = "Ask about the active document"; input.setAttribute("aria-label", "Question");
    input.maxLength = 2000;
    input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
      else if (event.key === "Escape") { const working = turns.find(t => t.status === "working"); if (working) { event.preventDefault(); stopTurn(working); } }
      event.stopPropagation();
    });
    providerSelect = K.select([], {label:"Provider", onChange:() => render()});
    askButton = K.button("Ask", {variant:"primary", size:"sm", run:send});
    context = K.el("span", "intel-composer-context");
    const row = K.el("div", "intel-composer-row");
    row.append(context, providerSelect, askButton);
    panel.foot.append(input, row);
    const h = host();
    for (const event of ["selection", "document", "replace"]) h.on?.(event, () => { if (event === "replace") state = null; if (panel.open) event === "replace" ? refresh() : render(); });
    G.AtriumPrefs?.on?.("butter.ai", () => refresh());
    for (const key of ["storage"]) G.addEventListener?.(key, event => { if (String(event.key).startsWith("atrium.ai.project.")) refresh(); });
  }
  async function open({prompt} = {}) {
    if (!panel) build();
    panel.show();
    if (tab !== "ask") setTab("ask");
    await refresh();
    if (prompt != null) input.value = prompt;
    input.focus();
    return panel;
  }
  function sync(on) { if (!on) { panel?.dispose(); panel = null; turns.length = 0; state = null; } }
  return Object.freeze({open, sync, refresh, setTab, turns});
})();
